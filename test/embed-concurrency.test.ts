import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB, embeddingToBlob, hasVec } from "../src/db.js";
import { config } from "../src/config.js";
import { acquireEmbedLock, writeVectors } from "../src/embeddings.js";

let db: DB;
let root: string;
let dbPath: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-embed-")));
  dbPath = path.join(root, "t.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function episode(content: string): number {
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, embedded)
     VALUES ('s1', 'memd', '2026-07-20T00:00:00Z', 'user', 'text', ?, ?, 0, 0)`
  ).run(content, `u-${content}`);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

describe("writeVectors — two embedders racing on the same rows", () => {
  it("writing a vector for a row that already has one does not throw (vec0 rejects OR REPLACE)", () => {
    expect(hasVec()).toBe(true);
    const id = episode("hello");
    const n = config.embedDim;
    const a = embeddingToBlob(new Float32Array(n).fill(0.1));
    const b = embeddingToBlob(new Float32Array(n).fill(0.2));
    writeVectors(db, "episodes", [{ id }], [a]);
    // second embedder selected the same embedded=0 row before the first committed
    expect(() => writeVectors(db, "episodes", [{ id }], [b])).not.toThrow();
    expect((db.prepare("SELECT COUNT(*) n FROM vec_episodes WHERE rowid = ?").get(BigInt(id)) as any).n).toBe(1);
    expect((db.prepare("SELECT embedded FROM episodes WHERE id = ?").get(id) as any).embedded).toBe(1);
  });
});

describe("acquireEmbedLock", () => {
  it("is exclusive while the holder is alive, and releases cleanly", () => {
    const release = acquireEmbedLock(dbPath);
    expect(release).not.toBeNull();
    expect(acquireEmbedLock(dbPath)).toBeNull();
    release!();
    expect(fs.existsSync(`${dbPath}.embed.lock`)).toBe(false);
    const again = acquireEmbedLock(dbPath);
    expect(again).not.toBeNull();
    again!();
  });

  it("steals a stale lock left by a dead pid (crashed embedder)", () => {
    fs.writeFileSync(`${dbPath}.embed.lock`, "999999999");
    const release = acquireEmbedLock(dbPath);
    expect(release).not.toBeNull();
    expect(fs.readFileSync(`${dbPath}.embed.lock`, "utf8")).toBe(String(process.pid));
    release!();
  });
});
