import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { openDb, DB } from "../src/db.js";
import { indexCorpus, transcriptLayout } from "../src/indexer.js";

/**
 * Claude Code writes each subagent's transcript to
 * <project-dir>/<session-id>/subagents/agent-<id>.jsonl, and the parent
 * transcript carries none of it (no sidechain lines). The sweep read only the
 * top level of each project dir, so every subagent's work was unsearchable.
 */
let db: DB;
let root: string;
let saved: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-sub-")));
  db = openDb(path.join(root, "t.db"));
  saved = config.transcriptsRoot;
  config.transcriptsRoot = path.join(root, "projects");
});
afterEach(() => {
  config.transcriptsRoot = saved;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const SESSION = "11111111-2222-3333-4444-555555555555";
const line = (uuid: string, text: string, extra: object = {}) =>
  JSON.stringify({ type: "user", uuid, sessionId: SESSION, timestamp: "2026-09-25T00:00:00Z", message: { role: "user", content: text }, ...extra }) + "\n";

function layout() {
  const proj = path.join(config.transcriptsRoot, "-tmp-sample-proj");
  fs.mkdirSync(path.join(proj, SESSION, "subagents"), { recursive: true });
  fs.writeFileSync(path.join(proj, `${SESSION}.jsonl`), line("p1", "parent asks for a survey of the parser"));
  fs.writeFileSync(
    path.join(proj, SESSION, "subagents", "agent-a1b2c3.jsonl"),
    line("s1", "subagent found the tokenizer bug in lexer quuxword", { isSidechain: true, agentId: "a1b2c3" })
  );
  return proj;
}
const rows = () => db.prepare("SELECT session_id, project, content FROM episodes ORDER BY id").all() as { session_id: string; project: string; content: string }[];

describe("subagent transcripts", () => {
  it("are indexed, under the parent's project", async () => {
    layout();
    await indexCorpus(db);
    const sub = rows().find((r) => r.content.includes("quuxword"));
    expect(sub).toBeDefined();
    const parent = rows().find((r) => r.content.includes("parent asks"))!;
    expect(sub!.project).toBe(parent.project);
    // Keyed under the parent session: timeline --session <parent> finds it, and
    // agent ids from different sessions cannot collide in the offset ledger.
    expect(sub!.session_id).toBe(`${SESSION}/agent-a1b2c3`);
  });

  it("are incremental: a second sweep adds nothing, an append is picked up", async () => {
    const proj = layout();
    await indexCorpus(db);
    const n = rows().length;
    await indexCorpus(db);
    expect(rows().length).toBe(n);
    fs.appendFileSync(path.join(proj, SESSION, "subagents", "agent-a1b2c3.jsonl"), line("s2", "subagent follow-up zorblatt", { isSidechain: true }));
    await indexCorpus(db);
    expect(rows().some((r) => r.content.includes("zorblatt"))).toBe(true);
  });

  it("an excluded project dir excludes its subagents too", async () => {
    const proj = layout();
    const excluded = path.join(config.transcriptsRoot, "-private-tmp-scratch");
    fs.renameSync(proj, excluded);
    await indexCorpus(db);
    expect(rows()).toEqual([]);
  });
});

describe("transcript layout rules (shared by the sweep, the hook path and the mem_checkpoint guard)", () => {
  it("indexes workflow agents, and skips their journal and every .meta.json", async () => {
    const proj = layout();
    const wf = path.join(proj, SESSION, "subagents", "workflows", "wf_abc123");
    fs.mkdirSync(wf, { recursive: true });
    fs.writeFileSync(path.join(wf, "agent-w1.jsonl"), line("w1", "workflow agent says flibbertigibbet", { isSidechain: true }));
    fs.writeFileSync(path.join(wf, "journal.jsonl"), line("j1", "journal line snorkelwhale"));
    fs.writeFileSync(path.join(wf, "agent-w1.meta.json"), "{}");
    fs.writeFileSync(path.join(proj, SESSION, "subagents", "agent-a1b2c3.meta.json"), "{}");
    await indexCorpus(db);
    const all = rows();
    const w = all.find((r) => r.content.includes("flibbertigibbet"));
    expect(w?.session_id).toBe(`${SESSION}/wf_abc123/agent-w1`);
    expect(all.some((r) => r.content.includes("snorkelwhale"))).toBe(false);
  });

  it("survives a session dir without subagents/, a stray file, and a subagents FILE", async () => {
    const proj = layout();
    fs.mkdirSync(path.join(proj, "22222222-0000-0000-0000-000000000000"), { recursive: true }); // no subagents/
    fs.writeFileSync(path.join(proj, "notes.txt"), "stray");
    const odd = path.join(proj, "33333333-0000-0000-0000-000000000000");
    fs.mkdirSync(odd);
    fs.writeFileSync(path.join(odd, "subagents"), "a file, not a dir");
    await indexCorpus(db);
    expect(rows().some((r) => r.content.includes("quuxword"))).toBe(true); // the sweep did not abort
  });

  it("the single-transcript path takes exclusion and project from the PROJECT dir, not subagents/", async () => {
    const proj = layout();
    const excluded = path.join(config.transcriptsRoot, "-private-tmp-scratch");
    fs.renameSync(proj, excluded);
    const agent = path.join(excluded, SESSION, "subagents", "agent-a1b2c3.jsonl");
    await indexCorpus(db, { onlyTranscript: agent });
    expect(rows()).toEqual([]);

    fs.renameSync(excluded, proj);
    await indexCorpus(db, { onlyTranscript: path.join(proj, SESSION, "subagents", "agent-a1b2c3.jsonl") });
    const r = rows();
    expect(r).toHaveLength(1);
    expect(r[0].project).not.toBe("subagents");
    expect(r[0].session_id).toBe(`${SESSION}/agent-a1b2c3`);
  });

  it("transcriptLayout refuses what is not a transcript", () => {
    expect(transcriptLayout("/r/p/s/subagents/agent-x.meta.json")).toBeUndefined();
    expect(transcriptLayout("/r/p/s/subagents/journal.jsonl")).toBeUndefined();
    expect(transcriptLayout("/r/p/s/subagents/workflows/wf_1/journal.jsonl")).toBeUndefined();
    expect(transcriptLayout("/r/p/s.jsonl")).toEqual({ projectDir: "/r/p", sessionKey: "s" });
  });
});

