// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import { describe, expect, it, beforeEach } from "vitest";
import { openDb, DB } from "../src/db.js";
import { saveFact, supersedeFact, retractFact, relate, neighbors } from "../src/facts.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let db: DB;

beforeEach(() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db");
  db = openDb(p);
});

describe("temporal facts ledger", () => {
  it("saves with defaults and clamps importance", () => {
    const id = saveFact(db, { content: "use TypeScript", importance: 99 }).id;
    const row = db.prepare("SELECT * FROM facts WHERE id = ?").get(id) as any;
    expect(row.importance).toBe(10);
    expect(row.valid_to).toBeNull();
    expect(row.kind).toBe("fact");
  });

  it("supersede closes the old window, links replacement, inherits fields", () => {
    const oldId = saveFact(db, { content: "backend in Python", kind: "decision", importance: 8, project: "atlas" }).id;
    const newId = supersedeFact(db, oldId, { content: "backend migrated to Go" });
    const oldRow = db.prepare("SELECT * FROM facts WHERE id = ?").get(oldId) as any;
    const newRow = db.prepare("SELECT * FROM facts WHERE id = ?").get(newId) as any;
    expect(oldRow.valid_to).not.toBeNull();
    expect(oldRow.superseded_by).toBe(newId);
    expect(newRow.valid_to).toBeNull();
    expect(newRow.importance).toBe(8);
    expect(newRow.kind).toBe("decision");
    expect(newRow.project).toBe("atlas");
    // active-only view sees exactly one
    const active = db.prepare("SELECT id FROM facts WHERE valid_to IS NULL").all() as any[];
    expect(active.map((r) => r.id)).toEqual([newId]);
  });

  it("supersede of a missing fact throws", () => {
    expect(() => supersedeFact(db, 999, { content: "x" })).toThrow(/not found/);
  });

  it("relations are typed, deduped, and traversable both directions", () => {
    const a = saveFact(db, { content: "epic: memory server" }).id;
    const b = saveFact(db, { content: "task: build indexer" }).id;
    relate(db, b, "part_of", a);
    relate(db, b, "part_of", a); // dupe ignored
    expect((db.prepare("SELECT COUNT(*) n FROM relations").get() as any).n).toBe(1);
    const fromB = neighbors(db, b);
    expect(fromB).toHaveLength(1);
    expect(fromB[0]).toMatchObject({ relation: "part_of", direction: "out", id: a });
    const fromA = neighbors(db, a);
    expect(fromA[0]).toMatchObject({ relation: "part_of", direction: "in", id: b });
  });

  it("relating a nonexistent node throws", () => {
    const a = saveFact(db, { content: "x" }).id;
    expect(() => relate(db, a, "blocks", 12345)).toThrow(/not found/);
  });

  it("superseding an already-closed fact is refused and points at the head", () => {
    const a = saveFact(db, { content: "protocol is HTTP" }).id;
    const b = supersedeFact(db, a, { content: "protocol is HTTPS" });
    expect(() => supersedeFact(db, a, { content: "protocol is GOPHER" })).toThrow(new RegExp(`#${b}`));
    const active = db.prepare("SELECT id FROM facts WHERE valid_to IS NULL").all() as any[];
    expect(active.map((r) => r.id)).toEqual([b]);
  });

  it("exact duplicate save returns the existing fact instead of inserting", () => {
    const first = saveFact(db, { content: "the sky is blue today" });
    const second = saveFact(db, { content: "the sky is blue today" });
    expect(second.existed).toBe(true);
    expect(second.id).toBe(first.id);
    expect((db.prepare("SELECT COUNT(*) n FROM facts").get() as any).n).toBe(1);
  });

  it("near-duplicate save surfaces similar active facts", () => {
    const first = saveFact(db, { content: "the release policy for atlas requires a signed build" });
    const second = saveFact(db, { content: "atlas release policy: signed build required, no exceptions" });
    expect(second.existed).toBe(false);
    expect(second.similar.map((s) => s.id)).toContain(first.id);
  });

  it("retract closes with no successor and refuses double-retract", () => {
    const a = saveFact(db, { content: "oops, wrong fact" }).id;
    retractFact(db, a, "test pollution");
    const row = db.prepare("SELECT valid_to, superseded_by, content FROM facts WHERE id = ?").get(a) as any;
    expect(row.valid_to).not.toBeNull();
    expect(row.superseded_by).toBeNull();
    expect(row.content).toContain("[retracted");
    expect(() => retractFact(db, a)).toThrow(/already closed/);
  });

  it("facts are redacted on save", () => {
    const id = saveFact(db, { content: "deploy key is AKIAIOSFODNN7EXAMPLE" }).id;
    const row = db.prepare("SELECT content FROM facts WHERE id = ?").get(id) as any;
    expect(row.content).toContain("[REDACTED:AWS_KEY]");
  });
});
