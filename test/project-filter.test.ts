import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { saveFact } from "../src/facts.js";
import { knownProjects, projectDiagnostic, sameProject, search, timeline } from "../src/search.js";

let db: DB;

beforeEach(() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db");
  db = openDb(p);
});

/** Insert an episode directly — mirrors what the indexer writes. */
function episode(project: string, content: string, id = Math.floor(Math.random() * 1e6)): number {
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no)
     VALUES (?, ?, ?, 'user', 'text', ?, ?, 0)`
  ).run(`s${id}`, project, "2026-07-20T00:00:00Z", content, `u${id}`);
  return db.prepare("SELECT last_insert_rowid() AS id").get() as any;
}

/**
 * the facts ledger tagged `fieldapp-ios` while the episode store tagged
 * `FieldApp-ios`, so no single caller value could address both. The filter
 * silently narrowed a rich answer to one misleading fact — the precise failure
 * memd exists to prevent.
 */
describe("the field failure: two stores, two casings, one caller value", () => {
  beforeEach(() => {
    saveFact(db, { content: "the scroll jank came from nested LazyStack containers", project: "fieldapp-ios" });
    episode("FieldApp-ios", "the scroll jank came from nested LazyStack containers in the feed view");
  });

  it("reaches BOTH stores when the caller uses the facts casing", async () => {
    const hits = await search(db, "scroll jank LazyStack", { project: "fieldapp-ios" });
    expect(hits.some((h) => h.source === "fact")).toBe(true);
    expect(hits.some((h) => h.source === "episode")).toBe(true);
  });

  it("reaches BOTH stores when the caller uses the episode casing", async () => {
    const hits = await search(db, "scroll jank LazyStack", { project: "FieldApp-ios" });
    expect(hits.some((h) => h.source === "fact")).toBe(true);
    expect(hits.some((h) => h.source === "episode")).toBe(true);
  });

  it("reaches both stores on an arbitrary casing the caller guessed", async () => {
    const hits = await search(db, "scroll jank LazyStack", { project: "FIELDAPP-IOS" });
    expect(hits.some((h) => h.source === "fact")).toBe(true);
    expect(hits.some((h) => h.source === "episode")).toBe(true);
  });

  it("still EXCLUDES a genuinely different project", async () => {
    saveFact(db, { content: "the scroll jank discussion happened here too", project: "atlas" });
    const hits = await search(db, "scroll jank LazyStack", { project: "fieldapp-ios" });
    expect(hits.every((h) => h.project.toLowerCase() !== "atlas")).toBe(true);
  });
});

describe("timeline honours the same normalization", () => {
  it("matches regardless of caller casing", () => {
    episode("FieldApp-ios", "a verbatim line about the scroll");
    expect(timeline(db, { project: "fieldapp-ios" }).length).toBe(1);
    expect(timeline(db, { project: "FieldApp-ios" }).length).toBe(1);
  });
});

describe("sameProject", () => {
  it("passes everything through when no filter is set", () => {
    expect(sameProject("anything", undefined)).toBe(true);
    expect(sameProject(null, undefined)).toBe(true);
  });
  it("is case-insensitive", () => {
    expect(sameProject("FieldApp-ios", "fieldapp-ios")).toBe(true);
  });
  it("rejects a null row project when a filter IS set", () => {
    expect(sameProject(null, "memd")).toBe(false);
  });
  it("does not fuzzy-match different projects", () => {
    // a prefix is not a match
    expect(sameProject("atlas2", "atlas")).toBe(false);
    expect(sameProject("atlas", "atlas2")).toBe(false);
  });
});

describe("knownProjects", () => {
  it("merges values across all three stores, one entry per casing-fold", () => {
    saveFact(db, { content: "x", project: "fieldapp-ios" });
    episode("FieldApp-ios", "y");
    episode("atlas", "z");
    const known = knownProjects(db);
    const lowered = known.map((k) => k.toLowerCase());
    expect(new Set(lowered).size).toBe(lowered.length); // no casing duplicates
    expect(lowered).toContain("fieldapp-ios");
    expect(lowered).toContain("atlas");
  });
});

describe("projectDiagnostic — an empty filter result must not read as 'nothing exists'", () => {
  beforeEach(() => {
    saveFact(db, { content: "x", project: "fieldapp-ios" });
    episode("atlas", "y");
  });

  it("stays silent when no filter was given", () => {
    expect(projectDiagnostic(db, undefined)).toBeUndefined();
  });

  it("stays silent for a project that exists, in any casing", () => {
    expect(projectDiagnostic(db, "FieldApp-ios")).toBeUndefined();
    expect(projectDiagnostic(db, "atlas")).toBeUndefined();
  });

  it("warns for a project that does not exist, and names known values", () => {
    const note = projectDiagnostic(db, "fieldapp");
    expect(note).toBeDefined();
    expect(note).toContain("no project named");
    expect(note).toContain("Known projects");
  });

  it("ignores empty-string project values that exist in the real store", () => {
    episode("", "an episode written with no project tag");
    expect(knownProjects(db).every((k) => k.trim().length > 0)).toBe(true);
    const note = projectDiagnostic(db, "fieldapp")!;
    // An empty entry rendered as a stray leading comma AND matched every
    // near-miss test, because "".includes(anything) is true.
    expect(note).not.toContain("mean: ,");
    expect(note).not.toContain("projects: ,");
  });

  it("suggests the near-miss the caller probably meant", () => {
    const note = projectDiagnostic(db, "fieldapp");
    expect(note).toContain("Did you mean");
    expect(note).toContain("fieldapp-ios");
  });

  it("says plainly that empty does not mean absent", () => {
    const note = projectDiagnostic(db, "nonexistent-repo")!;
    expect(note).toContain("does NOT mean");
  });
});
