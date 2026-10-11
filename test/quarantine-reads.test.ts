import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCheckpoint } from "../src/checkpoint.js";
import { openDb, DB } from "../src/db.js";
import { neighbors, relate, saveFact } from "../src/facts.js";

/**
 * Quarantine hides a session's episodes from search and timeline, but
 * mem_graph's neighbour preview and the checkpoint brief read episodes
 * directly and showed quarantined text anyway.
 */
let db: DB;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-q-")));
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const HIDDEN = "quarantinedmarkerzz";
const quarantineAll = () => db.prepare("UPDATE episodes SET quarantined = 1").run();

function episode(content: string): number {
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no)
     VALUES ('s1', 'p', '2026-09-25T00:00:00Z', 'user', 'text', ?, 'u1', 0)`
  ).run(content);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
}

describe("mem_graph neighbour preview", () => {
  it("shows a quarantined episode's edge but not its text", () => {
    const f = saveFact(db, { content: "a fact with provenance" }).id;
    const e = episode(`evidence ${HIDDEN}`);
    relate(db, f, "derived_from", e, "fact", "episode");
    expect(neighbors(db, f)[0].content).toContain(HIDDEN); // control: visible before quarantine
    quarantineAll();
    const n = neighbors(db, f);
    expect(n).toHaveLength(1);
    expect(n[0].id).toBe(e);
    expect(n[0].content ?? "").not.toContain(HIDDEN);
    expect(n[0].content).toBe("[quarantined]");
  });
});

describe("checkpoint brief", () => {
  function transcript(): string {
    const lines = [
      { type: "user", sessionId: "sess-q", uuid: "u1", timestamp: "2026-09-25T00:00:00Z", message: { role: "user", content: `please fix ${HIDDEN} now` } },
      { type: "assistant", sessionId: "sess-q", uuid: "a1", timestamp: "2026-09-25T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: `working on ${HIDDEN} for you` }] } },
      { type: "assistant", sessionId: "sess-q", uuid: "a2", timestamp: "2026-09-25T00:00:02Z", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command: `echo ${HIDDEN}` } }] } },
    ];
    const dir = path.join(root, "transcripts", "-tmp-proj");
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, "sess-q.jsonl");
    fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  }
  const brief = (id: number) => (db.prepare("SELECT brief FROM checkpoints WHERE id = ?").get(id) as { brief: string }).brief;

  it("leaves out quarantined asks, replies and tool calls", async () => {
    const p = transcript();
    const first = await buildCheckpoint(db, { session_id: "sess-q", transcript_path: p, cwd: "/tmp/proj" });
    expect(brief(first.id)).toContain(HIDDEN); // control: all three reads see it
    quarantineAll();
    const second = await buildCheckpoint(db, { session_id: "sess-q", transcript_path: p, cwd: "/tmp/proj" });
    expect(brief(second.id)).not.toContain(HIDDEN);
  });
});
