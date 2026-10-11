import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { relate, retractFact, saveFact, supersedeFact } from "../src/facts.js";
import { annotateContested, formatHits, search, SearchHit } from "../src/search.js";

let db: DB;

beforeEach(() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db");
  db = openDb(p);
});

const hit = (id: number, text = "a fact"): SearchHit => ({
  source: "fact",
  id,
  project: "memd",
  ts: "2026-07-26T00:00:00Z",
  kind: "decision",
  importance: 5,
  score: 1,
  text,
});

describe("read-path conflict marker", () => {
  it("marks a fact contested by an active contradicting fact", () => {
    const a = saveFact(db, { content: "deploy on fridays" }).id;
    const b = saveFact(db, { content: "never deploy on fridays" }).id;
    relate(db, b, "contradicts", a);

    const hits = [hit(a)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBe(1);
  });

  it("marks the contradiction in BOTH directions, not just the recorded one", () => {
    const a = saveFact(db, { content: "deploy on fridays" }).id;
    const b = saveFact(db, { content: "never deploy on fridays" }).id;
    relate(db, b, "contradicts", a);

    const hits = [hit(b)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBe(1);
  });

  it("counts ONE dispute when the same pair is related in both directions", () => {
    // The relations UNIQUE key is (from_kind, from_id, relation, to_kind, to_id),
    // so A->contradicts->B and B->contradicts->A are both insertable and both
    // join to the same contester. That is one disputing fact, not two.
    const a = saveFact(db, { content: "deploy on fridays" }).id;
    const b = saveFact(db, { content: "never deploy on fridays" }).id;
    relate(db, a, "contradicts", b);
    relate(db, b, "contradicts", a);

    const hits = [hit(a)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBe(1);
  });

  it("counts multiple active contesters", () => {
    const a = saveFact(db, { content: "the store lives in ~/.claude" }).id;
    const b = saveFact(db, { content: "the store lives elsewhere" }).id;
    const c = saveFact(db, { content: "the store is in-memory only" }).id;
    relate(db, b, "contradicts", a);
    relate(db, c, "contradicts", a);

    const hits = [hit(a)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBe(2);
  });

  it("ignores a RETRACTED contester — a withdrawn objection is not a live dispute", () => {
    const a = saveFact(db, { content: "deploy on fridays" }).id;
    const b = saveFact(db, { content: "never deploy on fridays" }).id;
    relate(db, b, "contradicts", a);
    retractFact(db, b);

    const hits = [hit(a)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBeUndefined();
  });

  it("ignores a SUPERSEDED contester", () => {
    const a = saveFact(db, { content: "deploy on fridays" }).id;
    const b = saveFact(db, { content: "never deploy on fridays" }).id;
    relate(db, b, "contradicts", a);
    supersedeFact(db, b, { content: "deploy whenever tests are green" });

    const hits = [hit(a)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBeUndefined();
  });

  it("leaves an uncontested fact unmarked rather than setting zero", () => {
    const a = saveFact(db, { content: "SSH only, never HTTPS" }).id;
    const hits = [hit(a)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBeUndefined();
  });

  it("ignores non-contradicts relations", () => {
    const a = saveFact(db, { content: "use vitest" }).id;
    const b = saveFact(db, { content: "vitest runs via npm test" }).id;
    relate(db, b, "supports", a);

    const hits = [hit(a)];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBeUndefined();
  });

  it("does not touch episode or doc hits", () => {
    const hits: SearchHit[] = [
      { ...hit(1), source: "episode" },
      { ...hit(1), source: "doc", path: "/x/CONTEXT.md" },
    ];
    annotateContested(db, hits);
    expect(hits[0].contestedBy).toBeUndefined();
    expect(hits[1].contestedBy).toBeUndefined();
  });
});

describe("end-to-end: the marker reaches a real search response", () => {
  // The unit tests above call annotateContested directly, so they would pass
  // even if it were never wired into search(). This is the wiring check.
  it("search() marks a contested fact and formatHits renders it", async () => {
    const a = saveFact(db, { content: "the zibbleflux valve stays open during maintenance" }).id;
    const b = saveFact(db, { content: "the zibbleflux valve must be closed during maintenance" }).id;
    relate(db, b, "contradicts", a);

    const hits = await search(db, "zibbleflux valve maintenance", { sources: ["facts"] });
    const marked = hits.find((h) => h.id === a);
    expect(marked).toBeDefined();
    expect(marked!.contestedBy).toBe(1);
    expect(formatHits(hits)).toContain("CONTESTED");
  });
});

describe("contested rendering", () => {
  it("renders a singular marker readers can act on", () => {
    const h = hit(7);
    h.contestedBy = 1;
    const out = formatHits([h]);
    expect(out).toContain("CONTESTED (1 active fact contradicts this");
  });

  it("pluralizes for multiple contesters", () => {
    const h = hit(7);
    h.contestedBy = 3;
    const out = formatHits([h]);
    expect(out).toContain("CONTESTED (3 active facts contradict this");
  });

  it("omits the marker entirely when uncontested", () => {
    const out = formatHits([hit(7)]);
    expect(out).not.toContain("CONTESTED");
  });

  it("coexists with the CHAIN HEAD marker", () => {
    const h = hit(7);
    h.chainDepth = 2;
    h.contestedBy = 1;
    const out = formatHits([h]);
    expect(out).toContain("CHAIN HEAD");
    expect(out).toContain("CONTESTED");
  });
});
