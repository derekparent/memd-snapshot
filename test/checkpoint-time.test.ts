import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { restoreBrief } from "../src/checkpoint.js";
import { openDb, DB } from "../src/db.js";

/**
 * Checkpoints store created_at as ISO ("2026-09-25T17:00:00.000Z")
 * but the orphan fallback compared it as a STRING against SQLite's
 * datetime('now', '-15 minutes') ("2026-09-25 17:00:00"). 'T' sorts after ' ',
 * so any same-day ISO row looked newer than the cutoff and a dead session's
 * brief was never restored.
 */
let db: DB;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-cp-")));
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const agoIso = (ms: number) => new Date(Date.now() - ms).toISOString();
const sqliteFmt = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, "");
function orphan(createdAt: string, brief = "SYNTHETIC BRIEF", session = "dead-sess") {
  db.prepare(`INSERT INTO checkpoints (session_id, project, created_at, trigger, brief) VALUES (?, 'proj', ?, 'precompact', ?)`).run(session, createdAt, brief);
}
const restore = () => restoreBrief(db, { session_id: "new-sess", cwd: "/tmp/proj" } as any);

describe("orphaned-checkpoint fallback compares time, not strings", () => {
  it("an ISO-format orphan 1 h old is restored", () => {
    orphan(agoIso(3600_000));
    expect(restore()).toContain("SYNTHETIC BRIEF");
  });

  it("an ISO-format orphan only 5 min old is NOT claimed by another session", () => {
    orphan(agoIso(5 * 60_000));
    expect(restore()).toBeNull();
  });

  it("a SQLite-format orphan 1 h old is still restored", () => {
    orphan(sqliteFmt(agoIso(3600_000)));
    expect(restore()).toContain("SYNTHETIC BRIEF");
  });

  it("with mixed formats, the NEWEST eligible orphan wins", () => {
    orphan(sqliteFmt(agoIso(3 * 3600_000)), "OLDER SQLITE BRIEF", "dead-a");
    orphan(agoIso(3600_000), "NEWER ISO BRIEF", "dead-b");
    expect(restore()).toContain("NEWER ISO BRIEF");
  });
});
