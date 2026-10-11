// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { FACT_KINDS, saveFact, supersedeFact } from "../src/facts.js";
import { knownProjects, projectDiagnostic, search, wantsFeedback } from "../src/search.js";
import { restoreBrief } from "../src/checkpoint.js";
import { MissTracker, findMiss, missFactContent, promoteMiss } from "../src/misses.js";

let db: DB;
let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-fbf-")));
  db = openDb(path.join(root, "t.db"));
});

const FB = "memd retrieval miss: query lab-printer toner reorder returned 0 hits under project=labprinter";
const factIds = async (q: string, opts = {}) =>
  (await search(db, q, { sources: ["facts"], ...opts })).filter((h) => h.source === "fact").map((h) => h.id);

describe("kind:'feedback' facts — save", () => {
  it("persists with kind feedback", () => {
    const id = saveFact(db, { content: FB, kind: "feedback" }).id;
    expect((db.prepare("SELECT kind FROM facts WHERE id = ?").get(id) as any).kind).toBe("feedback");
  });
});

describe("kind:'feedback' facts — excluded from ordinary recall by default", () => {
  it("does not surface on the missed query's own topic, where it matches best", async () => {
    // The pollution case: a feedback fact quotes the missed query, so it is a
    // strong lexical match for that topic. The control fact proves the query
    // reaches the facts leg at all — without it an empty result proves nothing.
    const fb = saveFact(db, { content: FB, kind: "feedback" }).id;
    const control = saveFact(db, { content: "lab-printer toner reorder happens monthly" }).id;
    const ids = await factIds("lab-printer toner reorder");
    expect(ids).toContain(control);
    expect(ids).not.toContain(fb);
  });

  it("surfaces for a query about memd / retrieval", async () => {
    const fb = saveFact(db, { content: FB, kind: "feedback" }).id;
    expect(await factIds("memd retrieval miss lab-printer")).toContain(fb);
  });

  it("surfaces under project=memd", async () => {
    const fb = saveFact(db, { content: "search returned stale lab-printer ruling", kind: "feedback", project: "memd" }).id;
    expect(await factIds("lab-printer ruling stale", { project: "memd" })).toContain(fb);
  });

  it("honours an explicit caller override both ways", async () => {
    const fb = saveFact(db, { content: FB, kind: "feedback" }).id;
    expect(await factIds("lab-printer toner reorder", { includeFeedback: true })).toContain(fb);
    expect(await factIds("memd retrieval miss lab-printer", { includeFeedback: false })).not.toContain(fb);
  });

  it("wantsFeedback stays narrow on ordinary uses of 'recall', 'feedback' and 'retrieval'", () => {
    expect(wantsFeedback("do you recall the lab-printer password rotation")).toBe(false);
    expect(wantsFeedback("the operator feedback on the orchard design")).toBe(false);
    // Bare "retrieval" is atlas's core domain word, so it must stay excluded.
    expect(wantsFeedback("atlas retrieval eval threshold 45%")).toBe(false);
    expect(wantsFeedback("information retrieval chunking strategy for product manuals")).toBe(false);
    expect(wantsFeedback("retrieval misses on the fieldapp thread")).toBe(true);
    expect(wantsFeedback("mem_search returned nothing for fieldapp")).toBe(true);
    expect(wantsFeedback("recall misses this week")).toBe(true);
  });
});

describe("kind:'feedback' facts — the supersede boundary", () => {
  // Superseding a ruling INTO a feedback fact used to make the whole chain
  // vanish from recall — no stale hit, no CONTESTED marker.
  it("refuses to supersede a ruling into feedback, and the ruling still surfaces", async () => {
    const r = saveFact(db, { content: "staging deploys need a manual approval", kind: "ruling" }).id;
    expect(() => supersedeFact(db, r, { content: "staging deploy rule reworded", kind: "feedback" })).toThrow(/ruling.*feedback|feedback.*ruling/);
    expect(await factIds("staging deploy manual approval ruling")).toContain(r);
  });

  it("refuses feedback -> ordinary too", () => {
    const f = saveFact(db, { content: "memd missed the manual approval ruling", kind: "feedback" }).id;
    expect(() => supersedeFact(db, f, { content: "the manual approval ruling applies everywhere", kind: "fact" })).toThrow(/feedback/);
  });

  it("allows feedback -> feedback and inheriting the kind", () => {
    const f = saveFact(db, { content: "memd missed the manual approval ruling", kind: "feedback" }).id;
    const g = supersedeFact(db, f, { content: "memd missed the manual approval ruling twice" });
    const h = supersedeFact(db, g, { content: "memd missed the manual approval ruling three times", kind: "feedback" });
    expect((db.prepare("SELECT kind FROM facts WHERE id = ?").get(h) as any).kind).toBe("feedback");
  });
});

describe("kind:'feedback' facts — never mint a project name", () => {
  // A promoted miss tagged with the TYPO'd project used to make knownProjects
  // include it, silencing the no-such-project diagnostic for the next session
  // that repeats the typo.
  it("the no-such-project diagnostic still fires after a feedback fact carries the typo", () => {
    saveFact(db, { content: "real project fact", project: "lab-printer" });
    expect(projectDiagnostic(db, "labprinter")).toMatch(/no project named "labprinter"/);
    saveFact(db, { content: "memd retrieval miss for labprinter", kind: "feedback", project: "labprinter" });
    expect(knownProjects(db)).not.toContain("labprinter");
    expect(projectDiagnostic(db, "labprinter")).toMatch(/no project named "labprinter"/);
  });
});

describe("kind:'feedback' facts — session-start brief", () => {
  it("never lists feedback facts as project state", () => {
    saveFact(db, { content: "tooling friction: memd missed the billing thread", kind: "feedback", importance: 10, project: "memd" });
    saveFact(db, { content: "memd store is never committed", importance: 9, project: "memd" });
    db.prepare(
      `INSERT INTO checkpoints (session_id, project, trigger, brief, created_at) VALUES ('s1', 'memd', 'auto', 'BRIEF', datetime('now'))`
    ).run();
    const brief = restoreBrief(db, { session_id: "s1", cwd: "/x/memd" })!;
    expect(brief).toContain("never committed");
    expect(brief).not.toContain("missed the billing thread");
  });
});

describe("captured misses -> feedback facts (explicit promotion)", () => {
  it("builds a findable fact from a captured miss, and promoting twice is a no-op", async () => {
    const t = new MissTracker({ root });
    const rec = t.observe({ query: "lab-printer toner reorder", project: "labprinter", hits: [] })!;
    expect(findMiss(rec.id, root)?.id).toBe(rec.id);
    const content = missFactContent(rec, "project was misspelled");
    expect(content).toContain('"lab-printer toner reorder"');
    expect(content).toContain("project=labprinter");
    expect(content).toContain("Note: project was misspelled");
    const a = promoteMiss(db, rec.id, { root, note: "project was misspelled" });
    const b = promoteMiss(db, rec.id, { root, note: "project was misspelled" });
    expect(b.existed).toBe(true);
    expect(b.id).toBe(a.id);
    // Tagged memd, not the typo'd filter — and so reachable both ways.
    expect((db.prepare("SELECT project FROM facts WHERE id = ?").get(a.id) as any).project).toBe("memd");
    expect(await factIds("memd retrieval miss lab-printer")).toContain(a.id);
    expect(await factIds("lab-printer toner reorder", { project: "memd" })).toContain(a.id);
    // The diagnostic survives the promotion of the miss that recorded it.
    expect(projectDiagnostic(db, "labprinter")).toMatch(/no project named "labprinter"/);
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});
