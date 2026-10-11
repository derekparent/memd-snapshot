#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { openDb, hasVec } from "./db.js";
import { indexCorpus } from "./indexer.js";
import { indexCodexCorpus } from "./codex.js";
import { indexDocs } from "./docs.js";
import { spawnSync } from "node:child_process";
import { backfill, checkCachedModel, modelProblem, prefetchModels, shutdownModels } from "./embeddings.js";
import { modelDir, modelState, setModelProgress } from "./models.js";
import { search, formatHits, parseOrigin, timeline } from "./search.js";
import { listFacts, parseKind, saveFact } from "./facts.js";
import { buildCheckpoint, restoreBrief, spawnBackgroundIndex, HookInput } from "./checkpoint.js";
import { quarantine } from "./quarantine.js";
import { consumeFeedback, listFeedback, newFeedback, tilde } from "./feedback.js";
import { promoteMiss, readMisses } from "./misses.js";
import { weeklyBackup } from "./backup.js";
import { jevStatus } from "./jev.js";
import { jevUsageLines } from "./jevusage.js";
import { backfillProjects, rebuildFts, sweepRedaction, SWEEP_KNOWN_GAPS } from "./migrate-store.js";

/**
 * memd CLI — the same engine as the MCP server, invokable from hooks,
 * launchd, and the terminal.
 *
 *   memd index                  incremental sweep of ~/.claude/projects
 *   memd embed [--limit N]      backfill embeddings for unembedded rows
 *   memd search "query" [--project p] [--caller-project p] [--rerank] [--json]
 *   memd timeline [--project p] [--session s]
 *   memd save "content" [--project p] [--importance N] [--kind k]
 *   memd facts list [--project p] [--kind k] [--limit N]   (active facts, newest first)
 *   memd checkpoint --precompact     (PreCompact hook; reads hook JSON on stdin)
 *   memd restore --session-start     (SessionStart hook; reads hook JSON on stdin,
 *                                     emits additionalContext, kicks a bg index)
 *   memd feedback new --project p --arc "line" | list | consume <file>
 *   memd misses [--limit N] [--json]           (auto-captured likely retrieval misses)
 *   memd misses promote <id> [--note "..."]    (one miss -> a kind:'feedback' fact)
 *   memd feedback fact "content" [--project p (default memd)] [--importance N]
 *   memd backup [--weekly] [--keep N]           (VACUUM INTO snapshot; --weekly = only if due)
 *   memd sweep-redaction [--apply] [--limit N]   (E1: retroactive redaction, episodes + facts + docs)
 *   memd rebuild-fts                             (re-derive FTS from content; one-time repair after an old sweep)
 *   memd backfill-projects [--apply] [--limit N] (E2: canonical repo retag)
 *   memd stats
 */

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    if (process.stdin.isTTY) return resolve("");
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    setTimeout(() => resolve(data), 3000);
  });
}

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const VALUE_FLAGS = new Set([
  "--project", "--limit", "--importance", "--kind", "--session",
  "--after", "--before", "--transcript", "--origin", "--arc", "--note", "--keep", "--caller-project",
]);

/** Positional args with flags AND their values removed. */
/**
 * An integer flag, validated at the boundary: parseInt("abc") is NaN, and a
 * NaN limit reached SQLite as "datatype mismatch".
 */
function intOpt(args: string[], name: string): number | undefined {
  const raw = opt(args, name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new Error(`${name} must be a positive integer, got "${raw}"`);
  return n;
}

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      if (VALUE_FLAGS.has(args[i])) i++;
      continue;
    }
    out.push(args[i]);
  }
  return out;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (process.argv.includes("--offline")) config.offline = true;
  // a first-use download can take minutes: show it, on stderr so --json stays clean
  setModelProgress((line) => console.error(line));
  const db = openDb();

  switch (cmd) {
    case "index": {
      const only = opt(rest, "--transcript");
      const stats = await indexCorpus(db, { onlyTranscript: only });
      console.log(
        `claude: ${stats.episodesAdded} new episodes from ${stats.filesIndexed}/${stats.filesScanned} files (${(stats.bytesRead / 1e6).toFixed(1)}MB read)`
      );
      if (!only) {
        const cx = await indexCodexCorpus(db);
        console.log(
          `codex:  ${cx.episodesAdded} new episodes from ${cx.filesIndexed}/${cx.filesScanned} rollouts (${(cx.bytesRead / 1e6).toFixed(1)}MB read)`
        );
        const dc = indexDocs(db);
        console.log(
          `docs:   ${dc.chunksAdded} chunks from ${dc.filesIndexed}/${dc.filesScanned} curated files` +
            (dc.filesPruned ? `, ${dc.filesPruned} pruned` : "")
        );
      }
      break;
    }
    case "embed": {
      const counts = await backfill(db, { limit: intOpt(rest, "--limit") });
      console.log(
        counts.skipped
          ? `embedded: skipped (${counts.skipped})`
          : `embedded: ${counts.episodes} episodes, ${counts.facts} facts`
      );
      break;
    }
    case "search": {
      const query = positionals(rest)[0];
      if (!query) throw new Error("usage: memd search \"query\"");
      const hits = await search(db, query, {
        project: opt(rest, "--project"),
        rerank: flag(rest, "--rerank"),
        origin: parseOrigin(opt(rest, "--origin")),
        limit: intOpt(rest, "--limit"),
        callerProject: opt(rest, "--caller-project"),
      });
      console.log(flag(rest, "--json") ? JSON.stringify(hits, null, 2) : formatHits(hits));
      // the results above are lexical-only when a model could not be loaded: say why
      if (modelProblem()) console.error(`memd: ${modelProblem()}`);
      break;
    }
    case "model-check": {
      // internal, used by prefetch: exit 0 when the cached files of one model load
      await checkCachedModel(rest[0] === "reranking" ? "reranking" : "embedding");
      break;
    }
    case "prefetch": {
      if (config.offline) throw new Error("prefetch downloads the models, and offline mode is on (MEMD_OFFLINE or --offline)");
      // "do the cached files load?" is asked of a second copy of this CLI (see loadCachedModel)
      await prefetchModels((role) => spawnSync(process.execPath, [...process.execArgv, process.argv[1], "model-check", role], { stdio: "ignore" }).status === 0);
      for (const id of [config.embedModel, config.rerankModel]) console.log(`${id}: ${modelState(id)} in ${tilde(modelDir(id))}`);
      const missing = [config.embedModel, config.rerankModel].filter((id) => modelState(id) !== "ready");
      if (missing.length) throw new Error(`prefetch finished but ${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} not ready`);
      break;
    }
    case "timeline": {
      const hits = timeline(db, {
        project: opt(rest, "--project"),
        sessionId: opt(rest, "--session"),
        after: opt(rest, "--after"),
        before: opt(rest, "--before"),
      });
      console.log(formatHits(hits));
      break;
    }
    case "save": {
      const content = positionals(rest)[0];
      if (!content) throw new Error("usage: memd save \"content\"");
      const res = saveFact(db, {
        content,
        project: opt(rest, "--project"),
        importance: intOpt(rest, "--importance"),
        kind: parseKind(opt(rest, "--kind")),
      });
      console.log(res.existed ? `identical active fact already exists: #${res.id} (not re-saved)` : `saved fact #${res.id}`);
      for (const sim of res.similar) console.log(`  similar active fact #${sim.id}: ${sim.content.slice(0, 100)}`);
      break;
    }
    case "facts": {
      if (positionals(rest)[0] !== "list") throw new Error("usage: memd facts list [--project p] [--kind k] [--limit N]");
      const rows = listFacts(db, {
        project: opt(rest, "--project"),
        kind: parseKind(opt(rest, "--kind")),
        limit: intOpt(rest, "--limit"),
      });
      if (!rows.length) console.log("no active facts match");
      for (const f of rows) {
        console.log(`#${f.id}  ${f.created_at.slice(0, 10)}  ${f.kind}  imp ${f.importance}  ${f.project ?? "global"}  ${f.content.replace(/\s+/g, " ").slice(0, 200)}`);
      }
      break;
    }
    case "checkpoint": {
      const raw = await readStdin();
      let input: HookInput = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        /* tolerate malformed hook payloads */
      }
      if (!input.trigger) input.trigger = flag(rest, "--precompact") ? "auto" : "manual";
      const { id, project } = await buildCheckpoint(db, input);
      console.log(`memd: checkpoint #${id} written for ${project}`);
      break;
    }
    case "restore": {
      const raw = await readStdin();
      let input: HookInput = {};
      try {
        input = raw ? JSON.parse(raw) : {};
      } catch {
        /* tolerate malformed hook payloads */
      }
      // Keep the corpus fresh on every session start, off the critical path.
      spawnBackgroundIndex(fileURLToPath(import.meta.url));
      const brief = restoreBrief(db, input);
      if (brief) {
        console.log(
          JSON.stringify({
            hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: brief },
          })
        );
      }
      break;
    }
    case "feedback": {
      const sub = positionals(rest)[0];
      if (sub === "new") {
        const project = opt(rest, "--project");
        const arc = opt(rest, "--arc");
        if (!project || !arc) throw new Error('usage: memd feedback new --project <slug> --arc "<one line>"');
        const { path: p } = newFeedback({ project, arc });
        console.log(`feedback file: ${tilde(p)}`);
        console.log("fill it in — the LITERAL query string is mandatory; a report without it cannot be acted on.");
      } else if (sub === "fact") {
        const content = positionals(rest)[1];
        if (!content) throw new Error('usage: memd feedback fact "content" [--project p] [--importance N]');
        const res = saveFact(db, { content, project: opt(rest, "--project") ?? "memd", kind: "feedback", importance: intOpt(rest, "--importance") });
        console.log(res.existed ? `identical feedback fact already exists: #${res.id}` : `feedback fact #${res.id} (hidden from ordinary searches; queries naming memd or a retrieval miss see it)`);
      } else if (sub === "list") {
        const files = listFeedback();
        if (!files.length) {
          // Silence is the correct default: the gate is surprise, not usage.
          console.log("no pending feedback");
          break;
        }
        for (const f of files) console.log(tilde(f.path));
      } else if (sub === "consume") {
        const name = positionals(rest)[1];
        if (!name) throw new Error("usage: memd feedback consume <filename>");
        console.log(`triaged -> ${tilde(consumeFeedback(name))}`);
      } else {
        throw new Error('usage: memd feedback (new --project <slug> --arc "<line>" | fact "<content>" | list | consume <filename>)');
      }
      break;
    }
    case "misses": {
      if (positionals(rest)[0] === "promote") {
        const id = positionals(rest)[1];
        if (!id) throw new Error('usage: memd misses promote <id> [--note "..."]');
        const res = promoteMiss(db, id, { note: opt(rest, "--note") });
        console.log(res.existed ? `already promoted: feedback fact #${res.id}` : `feedback fact #${res.id}`);
        break;
      }
      const limit = intOpt(rest, "--limit") ?? 20;
      const recs = readMisses({ limit });
      if (flag(rest, "--json")) {
        console.log(JSON.stringify(recs, null, 2));
        break;
      }
      if (!recs.length) {
        console.log("no captured misses");
        break;
      }
      for (const r of recs) {
        const scope = [r.project && `project=${r.project}`, r.sources && `sources=${r.sources.join(",")}`, r.origin && `origin=${r.origin}`].filter(Boolean).join(" ");
        console.log(`${r.id} ${r.ts} [${r.reasons.join(",")}] ${r.result_count} hit(s) ${JSON.stringify(r.query)}${scope ? " " + scope : ""}`);
        if (r.prev_query !== undefined) console.log(`    retried ${r.gap_s}s after ${JSON.stringify(r.prev_query)}`);
      }
      break;
    }
    case "backup": {
      // Run nightly by launchd; its log has no timestamps of its own, and a
      // failure must be a line someone sees, not an absent one.
      const ts = new Date().toISOString();
      try {
        const r = await weeklyBackup({
          force: !flag(rest, "--weekly"),
          keep: intOpt(rest, "--keep"),
        });
        for (const w of r.warnings) console.error(`${ts} backup: ${w}`);
        if (!r.taken) console.log(`${ts} backup: ${r.reason}`);
        else {
          console.log(`${ts} backup: ${tilde(r.path)} (${(r.bytes / 1e6).toFixed(0)} MB, quick_check ok)`);
          for (const p of r.pruned) console.log(`${ts} backup: pruned ${p} (keeping newest ${opt(rest, "--keep") ?? 4})`);
        }
      } catch (err: any) {
        throw new Error(`${ts} BACKUP FAILED: ${err.message}`);
      }
      break;
    }
    case "sweep-redaction":
    case "backfill-projects": {
      // Both REWRITE stored rows, so --apply is required and the absence of it
      // is a dry run, never a no-op that silently did the dangerous thing.
      const apply = flag(rest, "--apply");
      const limit = intOpt(rest, "--limit");
      if (cmd === "sweep-redaction") {
        const s = sweepRedaction(db, { apply, limit });
        console.log(`${s.dryRun ? "DRY RUN — nothing written" : "APPLIED"}`);
        console.log(`episodes scanned:        ${s.episodesScanned}`);
        console.log(`episodes needing change: ${s.episodesChanged}`);
        console.log(`facts scanned/changed:   ${s.factsScanned}/${s.factsChanged}`);
        console.log(`docs scanned/changed:    ${s.docsScanned}/${s.docsChanged}`);
        console.log(`embeddings invalidated:  ${s.embeddingsInvalidated} (run 'memd embed' after)`);
        if (s.sidecarPath) console.log(`change record:           ${tilde(s.sidecarPath)}`);
        if (s.backupPath) console.log(`backup:                  ${tilde(s.backupPath)}`);
        // Printed EVERY run: a clean sweep must never read as a clean corpus.
        console.log("\nKNOWN GAPS — this sweep does NOT close these:");
        for (const g of SWEEP_KNOWN_GAPS) console.log(`  - ${g}`);
        if (s.dryRun && s.episodesChanged + s.factsChanged + s.docsChanged) console.log(`\nre-run with --apply to write these changes`);
      } else {
        const s = await backfillProjects(db, { apply, limit });
        console.log(`${s.dryRun ? "DRY RUN — nothing written" : "APPLIED"}`);
        console.log(`sessions scanned:  ${s.sessionsScanned}`);
        console.log(`sessions retagged: ${s.sessionsRetagged}`);
        console.log(`episodes retagged: ${s.episodesRetagged}`);
        for (const [pair, n] of Object.entries(s.mapping)) console.log(`  ${pair}  (${n} episodes)`);
        // Per-session evidence: the approver must see WHY each session moves,
        // and which ones were deliberately left (the v1 dry-run hid both).
        const ds = s.decisions ?? [];
        const show = (v: string, title: string) => {
          const rows = ds.filter((d) => d.verdict === v);
          if (!rows.length) return;
          console.log(`\n${title} (${rows.length}):`);
          for (const d of rows) {
            const dist = Object.entries(d.evidence.votes).sort((a, b) => b[1] - a[1]).slice(0, 3)
              .map(([r, n]) => `${r} ${Math.round((100 * n) / d.evidence.total)}%`).join(", ");
            console.log(`  ${d.sessionId.slice(0, 8)}  ${d.episodes} ep  ${d.from}${d.verdict === "retag" ? " -> " + d.to : ""}  [${d.evidence.source}, ${d.evidence.total} votes: ${dist}]`);
          }
        };
        show("retag", "RETAG");
        show("protected", "LEFT — current tag is a real repo; evidence not overwhelming");
        show("multi-repo", "LEFT — no clear majority (multi-repo)");
        show("unresolved", "LEFT — the work was in a directory that is not (or no longer) a git repo");
        show("thin-evidence", "LEFT — too few path-bearing actions for the session's size");
        console.log(`\nleft with too little evidence: ${ds.filter((d) => d.verdict === "no-evidence").length}; already correct: ${ds.filter((d) => d.verdict === "keep").length}`);
        if (s.sidecarPath) console.log(`change record:     ${tilde(s.sidecarPath)}`);
        if (s.backupPath) console.log(`backup:            ${tilde(s.backupPath)}`);
        if (s.dryRun && s.sessionsRetagged) console.log(`\nre-run with --apply to write these changes`);
      }
      break;
    }
    case "quarantine": {
      const sess = opt(rest, "--session");
      const like = opt(rest, "--match");
      const off = flag(rest, "--off");
      if (flag(rest, "--list")) {
        const rules = db.prepare("SELECT kind, pattern, created_at FROM quarantine_rules ORDER BY id").all() as { kind: string; pattern: string; created_at: string }[];
        console.log(rules.length ? rules.map((r) => `${r.kind.padEnd(8)}${r.pattern}  (since ${r.created_at})`).join("\n") : "no quarantine rules");
        break;
      }
      if (!sess && !like) throw new Error("usage: memd quarantine (--session <id-prefix> | --match <substring>) [--off] | --list");
      const q = quarantine(db, { session: sess, match: like, off });
      console.log(
        `${off ? "un" : ""}quarantined ${q.episodes} episodes` +
          (off
            ? "; rule removed"
            : `; consumed ${q.briefs} restoration brief${q.briefs === 1 ? "" : "s"}; rule kept, so rows indexed later are hidden too (lift with --off)`)
      );
      break;
    }
    case "rebuild-fts": {
      rebuildFts(db);
      console.log("rebuilt episodes_fts, facts_fts, docs_fts from current content");
      break;
    }
    case "stats": {
      const one = (sql: string) => (db.prepare(sql).get() as any)?.n ?? 0;
      console.log(`episodes: ${one("SELECT COUNT(*) n FROM episodes")}`);
      console.log(`  awaiting embedding: ${one("SELECT COUNT(*) n FROM episodes WHERE embedded = 0")}`);
      console.log(`active facts: ${one("SELECT COUNT(*) n FROM facts WHERE valid_to IS NULL")}`);
      console.log(`sessions: ${one("SELECT COUNT(*) n FROM sessions")}`);
      console.log(`checkpoints: ${one("SELECT COUNT(*) n FROM checkpoints")}`);
      const tot = one("SELECT COUNT(*) n FROM episodes");
      const emb = one("SELECT COUNT(*) n FROM episodes WHERE embedded = 1");
      const pct = tot ? Math.round((100 * emb) / tot) : 0;
      console.log(`docs chunks: ${one("SELECT COUNT(*) n FROM docs")} from ${one("SELECT COUNT(DISTINCT path) n FROM docs")} files`);
      // Read from the cache's marker, never by loading the model: a status
      // command must not start a 133 MB download.
      const model = {
        ready: `ready (${pct}% of episodes embedded — lexical-only beyond that)`,
        unverified: `vec loaded, model files in ${tilde(modelDir(config.embedModel))} not verified yet (\`memd prefetch\` checks them, and downloads them again if they are incomplete)`,
        absent: `vec loaded, model not downloaded (\`memd prefetch\` downloads ${config.embedModel} to ${tilde(modelDir(config.embedModel))}; \`memd embed\` does too on first use)`,
      }[modelState(config.embedModel)];
      console.log(`vector search: ${hasVec() ? model : "unavailable (FTS-only)"}`);
      console.log(`jev: ${jevStatus().reason}`);
      for (const line of jevUsageLines()) console.log(line);
      const byProject = db.prepare("SELECT project, COUNT(*) n FROM episodes GROUP BY project ORDER BY n DESC LIMIT 12").all() as any[];
      console.log("top projects: " + byProject.map((r) => `${r.project}(${r.n})`).join(", "));
      break;
    }
    default:
      console.error("usage: memd <index|embed|prefetch|search|timeline|save|quarantine|checkpoint|restore|feedback|misses|backup|facts|sweep-redaction|rebuild-fts|stats> [--offline]");
      process.exit(1);
  }
}

main()
  .then(() => shutdownModels())
  .catch(async (err) => {
    console.error(`memd: ${err.message}`);
    await shutdownModels();
    // Not process.exit(): after a model that failed to load, a forced exit
    // makes onnxruntime abort ("mutex lock failed", exit 134) over the message.
    // The process ends when the event loop drains; the timer only bounds a
    // failure that left a handle open (this CLI runs inside hooks).
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 5000).unref();
  });
