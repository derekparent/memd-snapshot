import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { DB, nowIso } from "./db.js";
import { splitChunks, isTrivialToolResult } from "./chunker.js";
import { projectForCwd } from "./indexer.js";
import { redact } from "./redact.js";
import type { IndexStats } from "./indexer.js";

/**
 * Codex CLI / Codex Desktop ingestion adapter. Rollout files live at
 * ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl as envelope lines
 * {timestamp, type, payload}:
 *   - session_meta   -> payload.cwd (project), payload.id
 *   - response_item  -> payload.type message|function_call|function_call_output|reasoning|...
 *   - event_msg      -> UI duplicates of response_items — skipped to avoid double-indexing
 *
 * Format has proven stable across Codex versions.
 * Skipped on purpose: developer-role messages (injected scaffolding, not
 * episodic), reasoning items, and XML-wrapped context payloads
 * (<environment_context>, <permissions instructions>, …).
 *
 * Codex lines carry no per-item uuid, so src_uuid is a content hash —
 * identical (ts, role, text) replays dedupe exactly like Claude uuids do.
 */

interface CodexChunk {
  srcUuid: string;
  chunkNo: number;
  ts: string;
  role: "user" | "assistant";
  kind: "text" | "tool_use" | "tool_result";
  content: string;
}

const MAX_TOOL_CHARS = 4000;
const SCAFFOLD_RE = /^\s*<(environment_context|permissions instructions|app-context|collaboration_mode|apps_instructions|user_instructions|turn_context)\b/i;

function hashId(fileId: string, ts: string, role: string, text: string): string {
  const h = crypto.createHash("sha1").update(`${ts}|${role}|${text}`).digest("hex").slice(0, 20);
  return `cx:${fileId}:${h}`;
}

export function parseCodexLine(rawLine: string, fileId: string): { chunks: CodexChunk[]; cwd?: string } {
  let obj: any;
  try {
    obj = JSON.parse(rawLine);
  } catch {
    return { chunks: [] };
  }
  const ts: string = typeof obj.timestamp === "string" ? obj.timestamp : "";
  const p = obj.payload;
  if (!p || typeof p !== "object") return { chunks: [] };

  if (obj.type === "session_meta") {
    return { chunks: [], cwd: typeof p.cwd === "string" ? p.cwd : undefined };
  }
  if (obj.type !== "response_item") return { chunks: [] };

  const pieces: { role: "user" | "assistant"; kind: CodexChunk["kind"]; text: string }[] = [];

  switch (p.type) {
    case "message": {
      if (p.role !== "user" && p.role !== "assistant") break; // developer/system scaffolding
      for (const c of Array.isArray(p.content) ? p.content : []) {
        if (!c || typeof c.text !== "string") continue;
        if (c.type !== "input_text" && c.type !== "output_text") continue;
        const text = c.text.trim();
        if (!text || SCAFFOLD_RE.test(text)) continue;
        pieces.push({ role: p.role, kind: "text", text: redact(text) });
      }
      break;
    }
    case "function_call": {
      const name = String(p.name ?? "tool");
      let args = typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments ?? {});
      args = redact(args); // before truncation, which can cut a secret's closing delimiter
      if (args.length > 1500) args = args.slice(0, 1500) + "…";
      pieces.push({ role: "assistant", kind: "tool_use", text: `[tool:${name}] ${args}` });
      break;
    }
    case "function_call_output": {
      let out = "";
      const o = p.output;
      if (typeof o === "string") out = o;
      else if (o && typeof o === "object" && typeof o.content === "string") out = o.content;
      out = redact(out.trim()); // before truncation, which can cut a secret's closing delimiter
      if (out && !isTrivialToolResult(out)) {
        if (out.length > MAX_TOOL_CHARS) out = out.slice(0, MAX_TOOL_CHARS) + "…[tool output truncated]";
        pieces.push({ role: "user", kind: "tool_result", text: `[tool result] ${out}` });
      }
      break;
    }
    default:
      break; // reasoning, web_search_call, etc.
  }

  const chunks: CodexChunk[] = [];
  for (const piece of pieces) {
    const srcUuid = hashId(fileId, ts, piece.role + ":" + piece.kind, piece.text);
    let chunkNo = 0;
    // piece.text is already redacted whole; per-chunk redaction would miss a
    // secret split across a chunk boundary.
    for (const part of splitChunks(piece.text)) {
      chunks.push({ srcUuid, chunkNo: chunkNo++, ts, role: piece.role, kind: piece.kind, content: part });
    }
  }
  return { chunks };
}

function listRollouts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return out;
}

/**
 * A torn final line is left unconsumed for the next sweep. If Codex died
 * there and `codex resume` appended to the same rollout, the next sweep reads
 * the fragment glued to the first resumed line, and the whole thing fails to
 * parse. Recover the resumed line: the only suffix starting at `{"` that
 * parses is the complete appended line, because any earlier start carries the
 * fragment's unclosed braces. The fragment itself is lost; it never finished.
 */
function recoverGluedLine(line: string): string {
  try {
    JSON.parse(line);
    return line;
  } catch {
    /* fall through */
  }
  for (let i = line.indexOf('{"', 1); i > 0; i = line.indexOf('{"', i + 1)) {
    try {
      const obj = JSON.parse(line.slice(i));
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return line.slice(i);
    } catch {
      /* not a line start */
    }
  }
  return line;
}

async function indexRollout(db: DB, filePath: string, stats: IndexStats): Promise<void> {
  const fileId = path.basename(filePath, ".jsonl").replace(/^rollout-/, "");
  const sessionId = `codex:${fileId}`;
  const size = fs.statSync(filePath).size;
  const row = db.prepare("SELECT indexed_bytes, project FROM sessions WHERE session_id = ?").get(sessionId) as
    | { indexed_bytes: number; project: string }
    | undefined;
  const offset = row?.indexed_bytes ?? 0;
  if (size <= offset) return;

  // Read exactly [offset, size) and consume only through the last complete
  // line: Codex may still be appending, and stat() can land mid-line. Recording
  // `size` past a torn fragment would skip that message forever (the next sweep
  // starts after it). Same rule as the Claude indexer.
  const buf = Buffer.alloc(size - offset);
  const fd = fs.openSync(filePath, "r");
  let read = 0;
  try {
    read = fs.readSync(fd, buf, 0, buf.length, offset);
  } finally {
    fs.closeSync(fd);
  }
  let consumed = buf.lastIndexOf(0x0a, read - 1) + 1;
  const tail = buf.subarray(consumed, read).toString("utf8");
  if (tail.trim()) {
    try {
      JSON.parse(tail);
      consumed = read; // a complete final line that lacks its newline
    } catch {
      /* torn: leave it for the next sweep */
    }
  }
  if (consumed === 0) return;
  const bytes = offset + consumed;

  let cwd: string | undefined;
  let project = row?.project ?? "codex";
  let lastTs: string | undefined;
  const pending: [string, string, string, string, string, string, number][] = [];

  const lines = buf.subarray(0, consumed).toString("utf8").split("\n");
  // Glue can only sit at the old indexed_bytes, where a torn tail was left:
  // the first line of this read. Nowhere else is rewritten. That includes
  // offset 0: if Codex died writing the file's first line, the earlier sweep
  // consumed nothing and the glue is at the start.
  if (lines.length) lines[0] = recoverGluedLine(lines[0]);
  for (const line of lines) {
    if (!line.trim()) continue;
    const { chunks, cwd: metaCwd } = parseCodexLine(line, fileId);
    if (metaCwd) cwd = metaCwd;
    for (const c of chunks) {
      if (c.ts) lastTs = c.ts;
      pending.push([c.ts || lastTs || nowIso(), c.role, c.kind, c.content, c.srcUuid, "", c.chunkNo]);
    }
  }
  if (cwd) project = projectForCwd(cwd) || "codex";

  const insertEpisode = db.prepare(
    `INSERT OR IGNORE INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'codex')`
  );
  const upsertSession = db.prepare(
    `INSERT INTO sessions (session_id, project, cwd, first_ts, last_ts, transcript_path, indexed_bytes, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'codex')
     ON CONFLICT(session_id) DO UPDATE SET
       last_ts = COALESCE(excluded.last_ts, sessions.last_ts),
       project = excluded.project,
       cwd = COALESCE(excluded.cwd, sessions.cwd),
       indexed_bytes = excluded.indexed_bytes`
  );

  let added = 0;
  const commit = db.transaction(() => {
    for (const [ts, role, kind, content, srcUuid, , chunkNo] of pending) {
      const res = insertEpisode.run(sessionId, project, ts, role, kind, content, srcUuid, chunkNo);
      if (res.changes > 0) added++;
    }
    upsertSession.run(sessionId, project, cwd ?? null, lastTs ?? null, lastTs ?? null, filePath, bytes);
  });
  commit();

  stats.bytesRead += consumed;
  stats.episodesAdded += added;
  if (added > 0) stats.filesIndexed++;
}

export async function indexCodexCorpus(db: DB): Promise<IndexStats> {
  const stats: IndexStats = { filesScanned: 0, filesIndexed: 0, episodesAdded: 0, bytesRead: 0 };
  for (const file of listRollouts(config.codexRoot)) {
    stats.filesScanned++;
    try {
      await indexRollout(db, file, stats);
    } catch (err) {
      console.error(`memd codex index: failed on ${path.basename(file)}: ${(err as Error).message}`);
    }
  }
  return stats;
}
