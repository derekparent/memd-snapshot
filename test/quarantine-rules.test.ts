import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCheckpoint } from "../src/checkpoint.js";
import { openDb } from "../src/db.js";

/**
 * `memd quarantine` used to be a one-shot UPDATE, so the next `memd index` of
 * a still-growing (or resumed) transcript brought the hidden session straight
 * back. It is now a persisted rule applied at insert.
 */
let root: string;
let dbPath: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-qr-")));
  dbPath = path.join(root, "t.db");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), ...args], {
    env: { ...process.env, MEMD_DB_PATH: dbPath },
    encoding: "utf8",
  });

const HIDDEN = "quarantinerulezz";
let n = 0;
/** Ingest one episode the way every indexer does: a plain INSERT. */
function ingest(session: string, content: string): void {
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no)
     VALUES (?, 'p', '2026-09-25T00:00:00Z', 'user', 'text', ?, ?, 0)`
  ).run(session, content, `u${n++}`);
  db.close();
}
function visible(): string[] {
  const db = openDb(dbPath);
  const rows = (db.prepare("SELECT content FROM episodes WHERE quarantined = 0 ORDER BY id").all() as { content: string }[]).map((r) => r.content);
  db.close();
  return rows;
}

describe("quarantine persists as a rule for rows ingested later", () => {
  it("--session hides that session's later rows, not other sessions'", () => {
    ingest("aaaa1111", "before");
    expect(cli("quarantine", "--session", "aaaa").status).toBe(0);
    ingest("aaaa1111", "after, same session");
    ingest("bbbb2222", "after, other session");
    expect(visible()).toEqual(["after, other session"]);
  });

  it("--match hides later rows containing the text, in any session", () => {
    expect(cli("quarantine", "--match", HIDDEN).status).toBe(0);
    ingest("cccc3333", `new session mentions ${HIDDEN}`);
    ingest("cccc3333", "a clean line");
    expect(visible()).toEqual(["a clean line"]);
  });

  it("--off removes the rule: later rows are visible again", () => {
    cli("quarantine", "--session", "aaaa");
    const r = cli("quarantine", "--session", "aaaa", "--off");
    expect(r.status).toBe(0);
    ingest("aaaa1111", "after the lift");
    expect(visible()).toEqual(["after the lift"]);
  });

  it("--off of one rule keeps rows another rule still covers hidden", () => {
    ingest("aaaa1111", `session row with ${HIDDEN}`);
    ingest("dddd4444", `other row with ${HIDDEN}`);
    cli("quarantine", "--session", "aaaa");
    cli("quarantine", "--match", HIDDEN);
    expect(visible()).toEqual([]);
    cli("quarantine", "--match", HIDDEN, "--off");
    expect(visible()).toEqual([`other row with ${HIDDEN}`]); // the aaaa row stays under the session rule
  });

  it("--list shows the active rules", () => {
    cli("quarantine", "--session", "aaaa");
    cli("quarantine", "--match", HIDDEN);
    const r = cli("quarantine", "--list");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/session\s+aaaa/);
    expect(r.stdout).toMatch(new RegExp(`match\\s+${HIDDEN}`));
  });

  it("a checkpoint that indexes the rest of a quarantined session keeps it out of the brief", async () => {
    cli("quarantine", "--session", "sess-q");
    const dir = path.join(root, "transcripts", "-tmp-proj");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "sess-q.jsonl");
    fs.writeFileSync(
      p,
      JSON.stringify({ type: "user", sessionId: "sess-q", uuid: "u1", timestamp: "2026-09-25T00:00:00Z", message: { role: "user", content: `please fix ${HIDDEN}` } }) + "\n"
    );
    const db = openDb(dbPath);
    const cp = await buildCheckpoint(db, { session_id: "sess-q", transcript_path: p, cwd: "/tmp/proj" });
    const brief = (db.prepare("SELECT brief FROM checkpoints WHERE id = ?").get(cp.id) as { brief: string }).brief;
    db.close();
    expect(brief).not.toContain(HIDDEN);
  });
});
