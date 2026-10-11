// SYNTHETIC FIXTURES: every token in this file is fabricated. None is a real credential.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import * as store from "../src/migrate-store.js";

/**
 * The FTS tables had insert and delete triggers but no UPDATE trigger, so the
 * redaction sweep rewrote content in place while the old terms stayed
 * matchable in FTS — a "redacted" secret was still findable by search. The
 * sweep also skipped facts and docs entirely.
 */
const TOKEN = "ghp_Xylophonequux9SYNTHETIC0000000000"; // current redact() catches it
const TERM = "Xylophonequux9*";

let db: DB;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-fts-")));
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const ftsHits = (table: "episodes" | "facts" | "docs") =>
  (db.prepare(`SELECT count(*) AS n FROM ${table}_fts WHERE ${table}_fts MATCH ?`).get(TERM) as { n: number }).n;
const backupDir = () => path.join(root, "backups");

function insertEpisode(content: string): number {
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, embedded)
     VALUES ('s1', 'p', '2026-09-25T00:00:00Z', 'user', 'text', ?, 'u1', 0, 0)`
  ).run(content);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}
// Written directly, bypassing saveFact's ingest redaction: the shape of a row
// stored before the current rules existed.
function insertFact(content: string, embedded = 0): number {
  db.prepare(
    `INSERT INTO facts (content, project, kind, importance, valid_from, created_at, embedded)
     VALUES (?, 'p', 'fact', 5, '2026-09-25T00:00:00Z', '2026-09-25T00:00:00Z', ?)`
  ).run(content, embedded);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}
function insertDoc(content: string): number {
  db.prepare(`INSERT INTO docs (path, mtime, chunk_no, project, content) VALUES ('/tmp/CONTEXT.md', 1, 0, 'p', ?)`).run(content);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

describe("an UPDATE of content keeps FTS in step", () => {
  it("episodes", () => {
    const id = insertEpisode(`zebra token ${TOKEN} end`);
    expect(ftsHits("episodes")).toBe(1);
    db.prepare("UPDATE episodes SET content = 'zebra token gone end' WHERE id = ?").run(id);
    expect(ftsHits("episodes")).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM episodes_fts WHERE episodes_fts MATCH 'gone'").get() as { n: number }).n).toBe(1);
  });
  it("facts", () => {
    const id = insertFact(`rule ${TOKEN}`);
    db.prepare("UPDATE facts SET content = 'rule gone' WHERE id = ?").run(id);
    expect(ftsHits("facts")).toBe(0);
  });
  it("docs", () => {
    const id = insertDoc(`doc ${TOKEN}`);
    db.prepare("UPDATE docs SET content = 'doc gone' WHERE id = ?").run(id);
    expect(ftsHits("docs")).toBe(0);
  });
  it("an update that does not touch content leaves FTS alone", () => {
    const id = insertFact(`rule ${TOKEN}`);
    db.prepare("UPDATE facts SET access_count = access_count + 1 WHERE id = ?").run(id);
    expect(ftsHits("facts")).toBe(1);
  });
});

describe("the redaction sweep leaves nothing searchable, in all three layers", () => {
  it("a swept episode's old term no longer matches FTS", () => {
    insertEpisode(`zebra token ${TOKEN} end`);
    const st = store.sweepRedaction(db, { apply: true, backupDir: backupDir() });
    expect(st.episodesChanged).toBe(1);
    expect((db.prepare("SELECT content FROM episodes").get() as { content: string }).content).not.toContain("Xylophonequux9");
    expect(ftsHits("episodes")).toBe(0);
  });

  it("sweeps facts: content, FTS, and a stale embedding", () => {
    const id = insertFact(`deploy key ${TOKEN}`, 1);
    const st = store.sweepRedaction(db, { apply: true, backupDir: backupDir() });
    expect(st.factsChanged).toBe(1);
    const row = db.prepare("SELECT content, embedded FROM facts WHERE id = ?").get(id) as { content: string; embedded: number };
    expect(row.content).not.toContain("Xylophonequux9");
    expect(row.embedded).toBe(0);
    expect(ftsHits("facts")).toBe(0);
  });

  it("sweeps docs: content and FTS", () => {
    insertDoc(`notes ${TOKEN}`);
    const st = store.sweepRedaction(db, { apply: true, backupDir: backupDir() });
    expect(st.docsChanged).toBe(1);
    expect((db.prepare("SELECT content FROM docs").get() as { content: string }).content).not.toContain("Xylophonequux9");
    expect(ftsHits("docs")).toBe(0);
  });

  it("a dry run reports facts and docs too, and writes nothing", () => {
    insertFact(`k ${TOKEN}`);
    insertDoc(`k ${TOKEN}`);
    const st = store.sweepRedaction(db);
    expect([st.dryRun, st.factsChanged, st.docsChanged]).toEqual([true, 1, 1]);
    expect(ftsHits("facts") + ftsHits("docs")).toBe(2);
  });
});

describe("a store whose FTS went stale before the UPDATE triggers existed", () => {
  it("rebuildFts re-derives every index from current content", () => {
    const id = insertEpisode(`zebra token ${TOKEN} end`);
    // Simulate the pre-fix store: rewrite content with no UPDATE trigger in place.
    db.exec("DROP TRIGGER IF EXISTS episodes_au");
    db.prepare("UPDATE episodes SET content = 'zebra token gone end' WHERE id = ?").run(id);
    expect(ftsHits("episodes")).toBe(1); // stale, as on a store the old sweep touched
    store.rebuildFts(db);
    expect(ftsHits("episodes")).toBe(0);
  });
});

describe("sweeping a store whose FTS is already stale", () => {
  it("leaves every index consistent with content, not corrupted by the trigger's delete", () => {
    const id = insertEpisode(`zebra token ${TOKEN} end`);
    // Pre-fix store: content rewritten with no UPDATE trigger, FTS still holds the old text.
    db.exec("DROP TRIGGER IF EXISTS episodes_au");
    db.prepare("UPDATE episodes SET content = ? WHERE id = ?").run(`zebra newer ${TOKEN.replace("Xylophone", "Marimba")} end`, id);
    // Re-create the trigger (as the fixed schema does on next open), then sweep.
    db.close();
    db = openDb(path.join(root, "t.db"));
    store.sweepRedaction(db, { apply: true, backupDir: backupDir() });
    expect(() => db.prepare("INSERT INTO episodes_fts(episodes_fts) VALUES ('integrity-check')").run()).not.toThrow();
    expect(ftsHits("episodes")).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM episodes_fts WHERE episodes_fts MATCH 'Marimbaquux9*'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT count(*) AS n FROM episodes_fts WHERE episodes_fts MATCH 'zebra'").get() as { n: number }).n).toBe(1);
  });
});

describe("CLI", () => {
  it("memd rebuild-fts repairs a stale store and exits 0", () => {
    const id = insertEpisode(`zebra token ${TOKEN} end`);
    db.exec("DROP TRIGGER IF EXISTS episodes_au");
    db.prepare("UPDATE episodes SET content = 'zebra token gone end' WHERE id = ?").run(id);
    db.close();
    const r = spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), "rebuild-fts"], {
      env: { ...process.env, MEMD_DB_PATH: path.join(root, "t.db") },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    db = openDb(path.join(root, "t.db"));
    expect(ftsHits("episodes")).toBe(0);
  });

  it("sweep-redaction reports facts and docs", () => {
    insertFact(`k ${TOKEN}`);
    db.close();
    const r = spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), "sweep-redaction"], {
      env: { ...process.env, MEMD_DB_PATH: path.join(root, "t.db") },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/facts scanned\/changed:\s+1\/1/);
    expect(r.stdout).toMatch(/re-run with --apply/);
    db = openDb(path.join(root, "t.db"));
  });
});
