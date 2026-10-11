import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCheckpoint } from "../src/checkpoint.js";
import { openDb, DB } from "../src/db.js";
import { formatHits } from "../src/search.js";

/**
 * Agent-facing text used to call stored history "verbatim" and an
 * "immutable record". It isn't: ingestion redacts secrets and truncates long
 * tool output, and the redaction sweep rewrites stored rows in place. An agent
 * that trusts "verbatim" reads a [REDACTED:…] marker as what was said.
 */
let db: DB;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-wd-")));
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const claimsVerbatim = /verbatim|immutable/i;

describe("stored history is described as redacted and truncated, not verbatim", () => {
  it("mem_search's HISTORY header", () => {
    const out = formatHits([{ source: "episode", id: 1, project: "p", ts: "2026-09-25T00:00:00Z", role: "user", kind: "text", importance: 1, sessionId: "s", score: 1, text: "x" }]);
    const header = out.split("\n").find((l) => l.startsWith("## HISTORY"))!;
    expect(header).toBeDefined();
    expect(header).not.toMatch(claimsVerbatim);
    expect(header).toMatch(/secrets redacted/);
    expect(header).toMatch(/truncated/);
  });

  it("the restoration brief's footer", async () => {
    const dir = path.join(root, "transcripts", "-tmp-proj");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "sess-w.jsonl");
    fs.writeFileSync(p, JSON.stringify({ type: "user", sessionId: "sess-w", uuid: "u1", timestamp: "2026-09-25T00:00:00Z", message: { role: "user", content: "an ask" } }) + "\n");
    const cp = await buildCheckpoint(db, { session_id: "sess-w", transcript_path: p, cwd: "/tmp/proj" });
    const brief = (db.prepare("SELECT brief FROM checkpoints WHERE id = ?").get(cp.id) as { brief: string }).brief;
    const footer = brief.split("\n").at(-1)!;
    expect(footer).toMatch(/mem_search/);
    expect(footer).not.toMatch(claimsVerbatim);
    expect(footer).toMatch(/secrets redacted/);
  });
});
