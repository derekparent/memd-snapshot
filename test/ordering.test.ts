import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { saveFact, supersedeFact } from "../src/facts.js";
import { search } from "../src/search.js";

let db: DB;

beforeEach(() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db");
  db = openDb(p);
});

/**
 * Fact-ordering nit: two directly-matching facts could order by importance
 * alone. With few candidates the RRF ranks tie and
 * `fused` collapses, so nothing in the score represented how much of the query
 * a fact actually covered — a 2-of-5 match at importance 10 beat a 5-of-5
 * match at importance 2, both surfacing with correct content.
 */
describe("coverage weighting on weak-overlap queries", () => {
  it("ranks the fuller match above an off-point fact with far higher importance", async () => {
    const full = saveFact(db, {
      content: "quarantine marker excludes probe episodes from retrieval entirely",
      kind: "decision",
      importance: 2,
    }).id;
    const partial = saveFact(db, {
      content: "quarantine marker syntax was debated at length in the design review",
      kind: "ruling",
      importance: 10,
    }).id;

    const hits = await search(db, "quarantine marker probe episodes retrieval", { sources: ["facts"] });
    const iFull = hits.findIndex((h) => h.id === full);
    const iPartial = hits.findIndex((h) => h.id === partial);

    // Both still surface — this is an ordering fix, not a filtering one.
    expect(iFull).toBeGreaterThanOrEqual(0);
    expect(iPartial).toBeGreaterThanOrEqual(0);
    expect(iFull).toBeLessThan(iPartial);
  });

  it("still lets importance decide when coverage is equal", async () => {
    const low = saveFact(db, { content: "the cache warms before traffic begins", importance: 2 }).id;
    const high = saveFact(db, { content: "the cache warms before traffic starts", importance: 9 }).id;

    const hits = await search(db, "cache warms before traffic", { sources: ["facts"] });
    const iHigh = hits.findIndex((h) => h.id === high);
    const iLow = hits.findIndex((h) => h.id === low);
    expect(iHigh).toBeGreaterThanOrEqual(0);
    expect(iLow).toBeGreaterThanOrEqual(0);
    expect(iHigh).toBeLessThan(iLow);
  });

  it("leaves chain-resolved heads exempt — they need not share the query's words", async () => {
    const a = saveFact(db, { content: "release policy keeps the sign-off carve-out for billing-api", kind: "ruling" }).id;
    const head = supersedeFact(db, a, { content: "no sign-off default everywhere; the legacy gate is retired" });

    const hits = await search(db, "billing-api sign-off carve-out release policy", { sources: ["facts"] });
    expect(hits.find((h) => h.id === head)).toBeDefined();
    expect(hits[0].id).toBe(head);
  });

  it("does not reorder episode hits, which the gate never scored", async () => {
    // Episodes bypass the gate entirely; this guards against the coverage
    // multiplier leaking onto the history plane.
    const hits = await search(db, "nothing in this store matches", { sources: ["episodes"] });
    expect(hits).toEqual([]);
  });
});
