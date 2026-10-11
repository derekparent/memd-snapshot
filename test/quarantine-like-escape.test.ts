import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";

/**
 * `memd quarantine` passed its --session / --match text straight into
 * LIKE, so `_` and `%` were wildcards. Applying over-hid; lifting with --off
 * UN-hid rows the target never named (fail-open); and since quarantine became a persisted
 * `--match a_b` rule hid every future row containing aXb.
 */
let root: string;
let dbPath: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-qle-")));
  dbPath = path.join(root, "t.db");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), ...args], {
    env: { ...process.env, MEMD_DB_PATH: dbPath },
    encoding: "utf8",
  });

let n = 0;
function ingest(session: string, content: string, quarantined = 0): void {
  const db = openDb(dbPath);
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, quarantined)
     VALUES (?, 'p', '2026-09-25T00:00:00Z', 'user', 'text', ?, ?, 0, ?)`
  ).run(session, content, `u${n++}`, quarantined);
  db.close();
}
function visible(): string[] {
  const db = openDb(dbPath);
  const rows = (db.prepare("SELECT content FROM episodes WHERE quarantined = 0 ORDER BY id").all() as { content: string }[]).map((r) => r.content);
  db.close();
  return rows;
}

describe("quarantine targets are literal text, not LIKE patterns", () => {
  it("--match a_b hides a_b, not aXb", () => {
    ingest("s1", "has a_b in it");
    ingest("s2", "has aXb in it");
    cli("quarantine", "--match", "a_b");
    expect(visible()).toEqual(["has aXb in it"]);
  });

  it("a persisted --match a_b rule leaves a later aXb visible", () => {
    cli("quarantine", "--match", "a_b");
    ingest("s3", "later aXb");
    ingest("s3", "later a_b");
    expect(visible()).toEqual(["later aXb"]);
  });

  it("--match 100% hides only the literal '100%'", () => {
    ingest("s1", "at 100% now");
    ingest("s2", "at 1000 now");
    cli("quarantine", "--match", "100%");
    expect(visible()).toEqual(["at 1000 now"]);
  });

  it("--session ab_ is a literal prefix: abX… is not quarantined, and a later abX row stays visible", () => {
    ingest("ab_1", "underscore session");
    ingest("abX1", "other session");
    cli("quarantine", "--session", "ab_");
    ingest("abX2", "later other session");
    expect(visible()).toEqual(["other session", "later other session"]);
  });

  it("--off with a wildcard does not un-hide rows it never named (fail-open)", () => {
    ingest("legacy", "legacy aXb row", 1); // hidden by an earlier quarantine that left no rule
    ingest("s1", "has a_b in it");
    cli("quarantine", "--match", "a_b");
    cli("quarantine", "--match", "a_b", "--off");
    expect(visible()).toEqual(["has a_b in it"]);
  });

  it("literal matching is still case-insensitive, as before", () => {
    ingest("s1", "Has A_B In It");
    cli("quarantine", "--match", "a_b");
    expect(visible()).toEqual([]);
  });

  it("brief consumption uses the literal too: a brief mentioning only aXb survives --match a_b", () => {
    ingest("s9", "clean");
    const db = openDb(dbPath);
    db.prepare(`INSERT INTO checkpoints (session_id, project, created_at, trigger, brief) VALUES ('s9', 'p', ?, 'auto', '# brief aXb')`).run(new Date().toISOString());
    db.close();
    cli("quarantine", "--match", "a_b");
    const db2 = openDb(dbPath);
    const left = (db2.prepare("SELECT count(*) AS n FROM checkpoints WHERE consumed_at IS NULL").get() as { n: number }).n;
    db2.close();
    expect(left).toBe(1);
  });

  // The escape character itself: a backslash in the target is text, not an
  // escape. Unescaped, `C:\temp` would read as `C:` + escaped `t` + `emp`.
  it("--match C:\\temp hides the literal path, not C:temp", () => {
    ingest("s1", "cd C:\\temp now");
    ingest("s2", "cd C:temp now");
    const r = cli("quarantine", "--match", "C:\\temp");
    expect(r.status).toBe(0);
    expect(visible()).toEqual(["cd C:temp now"]);
  });

  it("--match a\\_b is backslash-then-underscore: a\\Xb, a_b and aXb stay visible", () => {
    ingest("s1", "has a\\_b in it");
    ingest("s2", "has a\\Xb in it"); // what a\\ + wildcard _ would also hide
    ingest("s3", "has a_b in it");
    ingest("s4", "has aXb in it");
    cli("quarantine", "--match", "a\\_b");
    expect(visible()).toEqual(["has a\\Xb in it", "has a_b in it", "has aXb in it"]);
  });

  it("a target ending in a backslash applies cleanly and hides only its literal", () => {
    ingest("s1", "under dir\\ here");
    ingest("s2", "under dir here");
    const r = cli("quarantine", "--match", "dir\\");
    expect(r.status).toBe(0);
    expect(visible()).toEqual(["under dir here"]);
  });

  it("a persisted --match C:\\temp rule hides a later C:\\temp row, not a later C:temp row", () => {
    cli("quarantine", "--match", "C:\\temp");
    ingest("s4", "later C:temp");
    ingest("s4", "later C:\\temp");
    expect(visible()).toEqual(["later C:temp"]);
  });

  it("--session a\\b is a literal prefix, applied and persisted", () => {
    ingest("a\\b1", "backslash session");
    ingest("ab1", "plain session");
    cli("quarantine", "--session", "a\\b");
    ingest("a\\b2", "later backslash session");
    ingest("ab2", "later plain session");
    expect(visible()).toEqual(["plain session", "later plain session"]);
  });

  it("a store that already has the v1 (unescaped) trigger gets it replaced on open", () => {
    const db = openDb(dbPath);
    db.exec(`DROP TRIGGER IF EXISTS episodes_quarantine_ai_v2;
      CREATE TRIGGER episodes_quarantine_ai AFTER INSERT ON episodes
      WHEN EXISTS (SELECT 1 FROM quarantine_rules r WHERE r.kind = 'match' AND new.content LIKE '%' || r.pattern || '%')
      BEGIN UPDATE episodes SET quarantined = 1 WHERE id = new.id; END;`);
    db.close();
    cli("quarantine", "--match", "a_b"); // reopens the store
    const db2 = openDb(dbPath);
    const triggers = (db2.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'episodes_quarantine%'").all() as { name: string }[]).map((r) => r.name);
    db2.close();
    expect(triggers).toEqual(["episodes_quarantine_ai_v2"]);
    ingest("s4", "later aXb after upgrade");
    expect(visible()).toEqual(["later aXb after upgrade"]);
  });
});
