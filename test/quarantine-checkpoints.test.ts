import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

/**
 * A brief written BEFORE `memd quarantine` still carries the quarantined
 * text, and the next SessionStart restore would print it straight back into
 * a fresh context. Quarantine must consume those briefs too.
 */
let root: string;
let dbPath: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-qc-")));
  dbPath = path.join(root, "t.db");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), ...args], {
    env: { ...process.env, MEMD_DB_PATH: dbPath },
    encoding: "utf8",
  });

const HIDDEN = "quarantinedbriefzz";
const RECENT = new Date(Date.now() - 3600 * 1000).toISOString();

function seed(): void {
  const db = openDb(dbPath);
  const ep = db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no)
     VALUES (?, 'p', ?, 'user', 'text', ?, ?, 0)`
  );
  ep.run("aaaa1111", RECENT, `the ask ${HIDDEN} and more`, "u1");
  ep.run("bbbb2222", RECENT, "an unrelated session", "u2");
  // the brief keeps only the first 600 chars of an ask, so the match can sit past the cut
  ep.run("dddd4444", RECENT, "x".repeat(700) + HIDDEN, "u4");
  const cp = db.prepare(
    `INSERT INTO checkpoints (session_id, project, created_at, trigger, brief) VALUES (?, 'p', ?, 'auto', ?)`
  );
  cp.run("aaaa1111", RECENT, `# brief\n- the ask ${HIDDEN} and more`); // #1 own session
  cp.run("cccc3333", RECENT, `# brief\n- quoted it: ${HIDDEN}`); // #2 other session, text in brief
  cp.run("bbbb2222", RECENT, "# brief\n- nothing sensitive"); // #3 must survive
  cp.run("dddd4444", RECENT, "# brief\n- " + "x".repeat(600)); // #4 match is in the episode, not the brief
  db.close();
}

function unconsumed(): number[] {
  const db = openDb(dbPath);
  const ids = (db.prepare("SELECT id FROM checkpoints WHERE consumed_at IS NULL ORDER BY id").all() as { id: number }[]).map((r) => r.id);
  db.close();
  return ids;
}

describe("quarantine consumes briefs that carry the quarantined text", () => {
  it("--session consumes that session's unconsumed briefs, not other sessions'", () => {
    seed();
    const r = cli("quarantine", "--session", "aaaa");
    expect(r.status).toBe(0);
    expect(unconsumed()).toEqual([2, 3, 4]);
    expect(r.stdout).toMatch(/quarantined 1 episodes; consumed 1 restoration brief/);
  });

  it("--match consumes briefs containing the text AND briefs of sessions it quarantined", () => {
    seed();
    const r = cli("quarantine", "--match", HIDDEN);
    expect(r.status).toBe(0);
    expect(unconsumed()).toEqual([3]);
    expect(r.stdout).toMatch(/quarantined 2 episodes; consumed 3 restoration briefs/);
  });

  it("a consumed brief is never restored", () => {
    seed();
    cli("quarantine", "--session", "aaaa");
    const r = spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), "restore"], {
      // restore also spawns a background `memd index`; point it at an empty HOME
      env: { ...process.env, MEMD_DB_PATH: dbPath, HOME: root },
      input: JSON.stringify({ session_id: "aaaa1111", cwd: root, source: "compact" }),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain(HIDDEN);
  });

  it("--off does not resurrect a consumed brief", () => {
    seed();
    cli("quarantine", "--session", "aaaa");
    const r = cli("quarantine", "--session", "aaaa", "--off");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^unquarantined 1 episodes; rule removed$/m);
    expect(unconsumed()).toEqual([2, 3, 4]);
  });
});
