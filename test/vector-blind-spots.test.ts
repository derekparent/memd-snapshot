import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Two vector-leg blind spots:
 *  1. The facts KNN only ran if some EPISODE was embedded, so a store with
 *     embedded facts and no embedded episodes never searched facts by vector.
 *  2. The project filter ran AFTER a global k=K*4 KNN, so on a busy store a
 *     project's nearest vectors fell outside the global top-k and vanished.
 * The embedder is mocked: vectors are placed by hand, no model is loaded.
 */
const DIM = 384;
const unit = (i: number, j?: number, w = 0.9) => {
  const v = new Float32Array(DIM);
  if (j === undefined) v[i] = 1;
  else {
    v[i] = w;
    v[j] = Math.sqrt(1 - w * w);
  }
  return v;
};
const embedCalls: string[][] = [];
let failNextEmbed = false;
vi.mock("../src/embeddings.js", () => ({
  embeddingsAvailable: async () => true,
  embedTexts: async (texts: string[]) => {
    embedCalls.push(texts);
    if (failNextEmbed) {
      failNextEmbed = false;
      throw new Error("synthetic embedder failure");
    }
    return texts.map(() => unit(0));
  },
  rerankScores: async (_q: string, docs: string[]) => docs.map(() => 0),
}));

const { openDb, embeddingToBlob, hasVec } = await import("../src/db.js");
const { search, VEC_MAX_K, vectorLegErrors, filteredKnnK } = await import("../src/search.js");
// hasVec() reports true only once a store has loaded sqlite-vec.
const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), "memd-vecprobe-"));
openDb(path.join(probeDir, "p.db")).close();
fs.rmSync(probeDir, { recursive: true, force: true });

let db: ReturnType<typeof openDb>;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-vec-")));
  db = openDb(path.join(root, "t.db"));
  embedCalls.length = 0;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function episode(project: string, content: string, vec: Float32Array, uuid: string, source = "claude"): number {
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, embedded, source)
     VALUES ('s-' || ?, ?, '2026-09-25T00:00:00Z', 'user', 'text', ?, ?, 0, 1, ?)`
  ).run(project, project, content, uuid, source);
  const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare("INSERT INTO vec_episodes (rowid, embedding) VALUES (?, ?)").run(BigInt(id), embeddingToBlob(vec));
  return id;
}

describe.skipIf(!hasVec())("vector leg", () => {
  it("searches embedded facts even when no episode is embedded yet", async () => {
    db.prepare(
      `INSERT INTO facts (content, project, kind, importance, valid_from, created_at, embedded)
       VALUES ('deploys use the blue pipeline', 'p', 'fact', 5, 'x', 'x', 1)`
    ).run();
    const fid = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
    db.prepare("INSERT INTO vec_facts (rowid, embedding) VALUES (?, ?)").run(BigInt(fid), embeddingToBlob(unit(0)));
    await search(db, "which pipeline do deploys use", {});
    expect(embedCalls.length).toBe(1); // the query was embedded: the vector leg ran
  });

  it("a project filter still finds that project's nearest episode on a busy store", async () => {
    // 300 other-project episodes sit exactly on the query vector; ours is near but not nearest.
    for (let i = 0; i < 300; i++) episode("other", `noise row number ${i}`, unit(0), `n${i}`);
    const mine = episode("mine", "the lighthouse keeper logbook", unit(0, 1, 0.8), "m1");
    const hits = await search(db, "zzqqxx", { project: "mine", sources: ["episodes"] });
    expect(hits.map((h) => h.id)).toContain(mine);
  });

  it("an origin filter still finds the minority origin's nearest episode on a busy store", async () => {
    // Same blind spot as the project filter: origin is applied after the KNN.
    for (let i = 0; i < 300; i++) episode("p", `noise row number ${i}`, unit(0), `n${i}`);
    const mine = episode("p", "the lighthouse keeper logbook", unit(0, 1, 0.8), "c1", "codex");
    const hits = await search(db, "zzqqxx", { origin: "codex", sources: ["episodes"] });
    expect(hits.map((h) => h.id)).toContain(mine);
  });

  it("control: without a project filter the global nearest win", async () => {
    for (let i = 0; i < 5; i++) episode("other", `noise row number ${i}`, unit(0), `n${i}`);
    const hits = await search(db, "zzqqxx", { sources: ["episodes"] });
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!hasVec())("vector leg limits and failures", () => {
  it("VEC_MAX_K is accepted by the pinned sqlite-vec, and one more is not", () => {
    episode("p", "one row", unit(0), "k1");
    const q = (k: number) => db.prepare("SELECT rowid FROM vec_episodes WHERE embedding MATCH ? AND k = ?").all(embeddingToBlob(unit(0)), k);
    expect(() => q(VEC_MAX_K)).not.toThrow();
    expect(() => q(VEC_MAX_K + 1)).toThrow();
  });

  it("a failing vector leg is recorded, not swallowed, and the search still answers", async () => {
    episode("p", "lighthouse keeper logbook", unit(0), "f1");
    const before = vectorLegErrors.count;
    failNextEmbed = true;
    const hits = await search(db, "lighthouse", {});
    expect(vectorLegErrors.count).toBe(before + 1);
    expect(vectorLegErrors.last).toMatch(/synthetic embedder failure/);
    expect(hits.length).toBeGreaterThan(0); // the lexical leg still answered
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});

describe("filteredKnnK sizes k by the project's share of embedded rows", () => {
  it("a big project stays near K*4, a small or unknown one gets VEC_MAX_K", () => {
    const ins = db.prepare(
      `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, embedded) VALUES ('s', ?, 'x', 'user', 'text', 'c', ?, 0, 1)`
    );
    for (let i = 0; i < 900; i++) ins.run("Big", `b${i}`);
    for (let i = 0; i < 100; i++) ins.run("small", `s${i}`);
    expect(filteredKnnK(db, "big", 50)).toBe(Math.ceil((200 * 1000) / 900)); // case-insensitive, ~223
    expect(filteredKnnK(db, "small", 50)).toBe(2000);
    expect(filteredKnnK(db, "nope", 50)).toBe(VEC_MAX_K);
  });

  it("quarantined rows don't count toward a share: the KNN excludes them, so a mostly-quarantined project needs a larger k", () => {
    const ins = db.prepare(
      `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, embedded, quarantined) VALUES ('s', ?, 'x', 'user', 'text', 'c', ?, 0, 1, ?)`
    );
    for (let i = 0; i < 400; i++) ins.run("other", `o${i}`, 0);
    for (let i = 0; i < 100; i++) ins.run("mostly", `m${i}`, i < 50 ? 1 : 0);
    // visible: 450 rows, 50 of them "mostly" -> 200 * 450 / 50 (counting quarantined rows would give 200 * 500 / 100 = 1000)
    expect(filteredKnnK(db, "mostly", 50)).toBe(1800);
  });

  it("an origin filter is sized by the origin's share, and project+origin by their intersection", () => {
    const ins = db.prepare(
      `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no, embedded, source) VALUES ('s', ?, 'x', 'user', 'text', 'c', ?, 0, 1, ?)`
    );
    for (let i = 0; i < 890; i++) ins.run("big", `bc${i}`, "claude");
    for (let i = 0; i < 10; i++) ins.run("big", `bx${i}`, "codex");
    for (let i = 0; i < 60; i++) ins.run("Small", `sc${i}`, "claude");
    for (let i = 0; i < 40; i++) ins.run("small", `sx${i}`, "codex");
    // total 1000; K = 5 so K*4 = 20 and the clamp never masks the arithmetic
    expect(filteredKnnK(db, {}, 5)).toBe(20); // no filter: unchanged K*4
    expect(filteredKnnK(db, { origin: "codex" }, 5)).toBe(400); // 50 codex rows: 20 * 1000 / 50
    expect(filteredKnnK(db, { origin: "claude" }, 5)).toBe(Math.ceil((20 * 1000) / 950)); // dominant origin stays near K*4
    expect(filteredKnnK(db, { project: "small" }, 5)).toBe(200); // 100 rows, case-folded, both origins
    expect(filteredKnnK(db, "small", 5)).toBe(200); // bare string = project, as before
    expect(filteredKnnK(db, { project: "small", origin: "codex" }, 5)).toBe(500); // 40 rows
    expect(filteredKnnK(db, { project: "big", origin: "codex" }, 5)).toBe(2000); // 10 rows
    expect(filteredKnnK(db, { project: "big", origin: "nope" }, 5)).toBe(VEC_MAX_K); // no rows
  });
});

