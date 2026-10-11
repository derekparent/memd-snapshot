import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { indexCorpus } from "../src/indexer.js";
import { restoreBrief } from "../src/checkpoint.js";

let db: DB;
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-idx-")));
  db = openDb(path.join(root, "t.db"));
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const line = (uuid: string, text: string) =>
  JSON.stringify({ type: "user", uuid, timestamp: "2026-08-29T00:00:00Z", cwd: "/Users/alice/Projects/memd", message: { role: "user", content: text } }) + "\n";

const count = () => (db.prepare("SELECT COUNT(*) n FROM episodes").get() as any).n;
const indexedBytes = (sid: string) => (db.prepare("SELECT indexed_bytes FROM sessions WHERE session_id = ?").get(sid) as any).indexed_bytes;

describe("indexer — transcript still being written", () => {
  it("does not advance past a torn final line; picks the message up once the write completes", async () => {
    const dir = path.join(root, "-Users-alice-Projects-memd");
    fs.mkdirSync(dir);
    const file = path.join(dir, "sess1.jsonl");
    const l1 = line("u1", "first message");
    const l2 = line("u2", "second message that is mid-write");
    fs.writeFileSync(file, l1 + l2.slice(0, 40)); // second line torn mid-JSON
    await indexCorpus(db, { onlyTranscript: file });
    expect(count()).toBe(1);
    expect(indexedBytes("sess1")).toBe(Buffer.byteLength(l1));

    fs.appendFileSync(file, l2.slice(40));
    await indexCorpus(db, { onlyTranscript: file });
    expect(count()).toBe(2);
    expect(indexedBytes("sess1")).toBe(Buffer.byteLength(l1 + l2));
  });

  it("still indexes a complete final line that lacks a trailing newline", async () => {
    const dir = path.join(root, "-Users-alice-Projects-memd");
    fs.mkdirSync(dir);
    const file = path.join(dir, "sess2.jsonl");
    fs.writeFileSync(file, line("u1", "one") + line("u2", "two").trimEnd());
    await indexCorpus(db, { onlyTranscript: file });
    expect(count()).toBe(2);
  });
});

describe("restoreBrief — atomic claim", () => {
  it("a brief is handed to exactly one of two racing restores", () => {
    db.prepare(
      `INSERT INTO checkpoints (session_id, project, trigger, brief, created_at) VALUES ('dead', 'memd', 'auto', 'BRIEF', datetime('now', '-1 hour'))`
    ).run();
    const a = restoreBrief(db, { session_id: "s-a", cwd: "/x/memd" });
    const b = restoreBrief(db, { session_id: "s-b", cwd: "/x/memd" });
    expect([a, b].filter((x) => x && x.includes("BRIEF")).length).toBe(1);
  });
});
