import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { openDb, DB } from "../src/db.js";
import { saveFact } from "../src/facts.js";
import { effectiveScope, projectsNamed, search, type SearchHit } from "../src/search.js";
import { projectForCwd } from "../src/indexer.js";
import { callerProjectFor, scopeNote } from "../src/scope.js";

let db: DB;
let n = 0;

beforeEach(() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db");
  db = openDb(p);
});

function episode(project: string, content: string): number {
  n++;
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no)
     VALUES (?, ?, ?, 'user', 'text', ?, ?, 0)`
  ).run(`s${n}`, project, "2026-09-20T00:00:00Z", content, `u${n}`);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

/**
 * The defect: a big project's rows fill the global top K of every leg, so a
 * small project's answer never reaches fusion. 60 strong "big" matches crowd
 * out the one weaker "small" match (lexical K is 50).
 */
function crowdedStore(): { small: number; bigTop: number } {
  let bigTop = 0;
  for (let i = 0; i < 60; i++) {
    const id = episode("big", `sprite listing sprite listing sprite listing frame ${i} of the parser sprite listing output`);
    if (i === 0) bigTop = id;
  }
  const small = episode("small", `the sprite listing decision for this repo was to keep one atlas, after a long discussion about memory budgets and loading order across the whole app`);
  return { small, bigTop };
}

/** Same hits, same order, same scores (recency reads the clock, so not bit-equal). */
function sameRanking(a: SearchHit[], b: SearchHit[]) {
  expect(b.map((h) => `${h.source}${h.id}`)).toEqual(a.map((h) => `${h.source}${h.id}`));
  b.forEach((h, i) => expect(h.score).toBeCloseTo(a[i].score, 6));
}

describe("caller scope: candidate generation reaches the caller's project", () => {
  it("without a caller project the small project's answer is crowded out (the defect)", async () => {
    const { small } = crowdedStore();
    const hits = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000 });
    expect(hits.some((h) => h.id === small)).toBe(false);
  });

  it("with the caller in that project, its answer is found and ranked first", async () => {
    const { small } = crowdedStore();
    const hits = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000, callerProject: "small" });
    expect(hits[0].id).toBe(small);
  });

  it("matches the caller project case-insensitively", async () => {
    const { small } = crowdedStore();
    const hits = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000, callerProject: "SMALL" });
    expect(hits[0].id).toBe(small);
  });

  it("never removes another project's hits: it is a ranking, not a filter", async () => {
    const { bigTop } = crowdedStore();
    const hits = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000, callerProject: "small" });
    expect(hits.some((h) => h.id === bigTop)).toBe(true);
    expect(hits.filter((h) => h.project === "big").length).toBeGreaterThan(10);
  });

  it("an explicit project filter wins over the caller project", async () => {
    crowdedStore();
    const hits = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000, project: "big", callerProject: "small" });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.project === "big")).toBe(true);
  });

  it("a blank caller project ranks exactly as no caller project", async () => {
    crowdedStore();
    const a = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000 });
    const b = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000, callerProject: "  " });
    sameRanking(a, b);
  });

  it("a caller project with no rows leaves the ranking unchanged", async () => {
    crowdedStore();
    const a = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000 });
    const b = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000, callerProject: "nowhere" });
    sameRanking(a, b);
  });

  it("ranks the caller's project above an equally matching row from another project", async () => {
    const other = episode("other", "the atlas packing ruling: one shared atlas per scene");
    const mine = episode("mine", "the atlas packing ruling: one shared atlas per scene.");
    const none = await search(db, "atlas packing ruling", { limit: 10 });
    expect(none.map((h) => h.id)).toEqual(expect.arrayContaining([other, mine]));
    const scoped = await search(db, "atlas packing ruling", { limit: 10, callerProject: "mine" });
    expect(scoped[0].id).toBe(mine);
    expect(scoped.some((h) => h.id === other)).toBe(true);
  });

  it("leaves facts unboosted: the ledger is curated, and cross-project facts are deliberate", async () => {
    saveFact(db, { content: "atlas packing ruling applies to every repo" });
    saveFact(db, { content: "atlas packing ruling for the other repo", project: "other" });
    saveFact(db, { content: "atlas packing ruling for this repo", project: "mine" });
    episode("mine", "unrelated chatter so the project has rows");
    const facts = (hs: SearchHit[]) => hs.filter((h) => h.source === "fact");
    const a = facts(await search(db, "atlas packing ruling", { limit: 10 }));
    const b = facts(await search(db, "atlas packing ruling", { limit: 10, callerProject: "mine" }));
    expect(a.length).toBe(3);
    sameRanking(a, b);
  });
});

describe("callerProjectFor: which cwd names a project", () => {
  const home = "/Users/someone";
  it("is undefined for /, the home dir and the projects root", () => {
    expect(callerProjectFor("/", {}, home)).toBeUndefined();
    expect(callerProjectFor(home, {}, home)).toBeUndefined();
    expect(callerProjectFor(home + "/", {}, home)).toBeUndefined();
    expect(callerProjectFor(config.projectsRoot, {}, home)).toBeUndefined();
  });

  it("resolves a git checkout to the name its origin gives it, wherever the checkout sits and whatever it is called", () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-origin-")), "some-other-dir-name");
    fs.mkdirSync(dir);
    const git = (...args: string[]) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    git("init", "-q");
    git("remote", "add", "origin", "git@example.invalid:someone/atlas.git");
    expect(callerProjectFor(dir, {}, home)).toBe("atlas");
    expect(projectForCwd(dir)).toBe("atlas");
  });

  it("a git checkout with no origin falls back to the directory slug", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memd-no-origin-"));
    execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
    expect(callerProjectFor(dir, {}, home)).toBe(dir.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, ""));
  });

  it("a seat worktree belongs to its repo (MEMD_WORKTREE_ROOT + MEMD_WORKTREE_SEATS, set in test/setup/throwaway-home.ts)", () => {
    // These paths do not exist, so the slug rule answers.
    expect(callerProjectFor("/Users/alice/.worktrees/memd-executor", {}, home)).toBe("memd");
    expect(callerProjectFor("/Users/alice/.worktrees/atlas-advisor", {}, "/nonexistent-home")).toBe("atlas");
  });

  it("an unknown cwd names a project with no rows, and search then ranks exactly as unscoped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memd-unknown-"));
    const cp = callerProjectFor(dir, {}, home);
    expect(cp).toBeTruthy();
    crowdedStore();
    const a = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000 });
    const b = await search(db, "sprite listing", { limit: 40, maxTokens: 100_000, callerProject: cp });
    sameRanking(a, b);
    expect(effectiveScope(db, { callerProject: cp })).toBeUndefined();
  });

  it("falls back to the transcript-dir slug outside git", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memd-scope-"));
    const p = callerProjectFor(dir, {}, home);
    expect(p).toBe(dir.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-/, ""));
  });

  it("MEMD_CALLER_PROJECT overrides the cwd, and none/off/empty switch scoping off", () => {
    expect(callerProjectFor("/", { MEMD_CALLER_PROJECT: "home-lab" }, home)).toBe("home-lab");
    for (const v of ["none", "OFF", "0", "false", "", "  "]) {
      expect(callerProjectFor(process.cwd(), { MEMD_CALLER_PROJECT: v }, home)).toBeUndefined();
    }
  });
});

describe("effectiveScope + scopeNote: the note appears only on scoped responses", () => {
  it("scope applies only with no explicit project and a caller project that has rows", () => {
    episode("home-lab", "anything at all");
    expect(effectiveScope(db, { callerProject: "home-lab" })).toBe("home-lab");
    expect(effectiveScope(db, { callerProject: "HOME-LAB" })).toBe("HOME-LAB");
    expect(effectiveScope(db, { callerProject: "home-lab", project: "memd" })).toBeUndefined();
    expect(effectiveScope(db, { callerProject: "nowhere" })).toBeUndefined();
    expect(effectiveScope(db, {})).toBeUndefined();
  });

  it("the note names the project that was applied, and is silent otherwise", () => {
    expect(scopeNote("home-lab")).toContain('ranked toward "home-lab"');
    expect(scopeNote(undefined)).toBeUndefined();
  });
});

describe("a query that names another project is not scoped (the cross-project case)", () => {
  beforeEach(() => {
    for (const p of ["home-lab", "FieldApp-ios", "relay", "memd", "qa", "orchard--claude-worktrees-agent-a1", "harness-ab-work-t1-g"]) episode(p, "rows");
  });

  it("names a project by its full name, its unpunctuated name, or a 5+ character first segment", () => {
    expect(projectsNamed(db, "fieldapp build 12")).toEqual(["fieldapp-ios"]);
    expect(projectsNamed(db, "FieldApp-ios keyboard")).toEqual(["fieldapp-ios"]);
    expect(projectsNamed(db, "homelab weekly report")).toEqual(["home-lab"]);
    expect(projectsNamed(db, "relay badge scan unlock")).toEqual(["relay"]);
  });

  it("tags that are not real names never match: short tags, worktree slugs, 4+ segment slugs, short first segments", () => {
    expect(projectsNamed(db, "what did QA rule")).toEqual([]);
    expect(projectsNamed(db, "orchard notes harness work")).toEqual([]);
    expect(projectsNamed(db, "home office move")).toEqual([]);
  });

  it("a session asking about another project ranks unscoped; asking about itself, or about nothing named, stays scoped", () => {
    expect(effectiveScope(db, { callerProject: "home-lab" }, "fieldapp build 12")).toBeUndefined();
    expect(effectiveScope(db, { callerProject: "home-lab" }, "memd release checklist")).toBeUndefined();
    expect(effectiveScope(db, { callerProject: "home-lab" }, "home-lab weekly report")).toBe("home-lab");
    expect(effectiveScope(db, { callerProject: "home-lab" }, "status update")).toBe("home-lab");
  });

  it("search follows it: history from the named project is not pushed down by the caller boost", async () => {
    const theirs = episode("relay", "badge scan unlock consent flow for the kiosk");
    const mine = episode("home-lab", "badge scan unlock consent flow for the kiosk.");
    const scoped = await search(db, "badge scan unlock consent", { limit: 10, callerProject: "home-lab" });
    expect(scoped[0].id).toBe(mine);
    const named = await search(db, "relay badge scan unlock consent", { limit: 10, callerProject: "home-lab" });
    const plain = await search(db, "relay badge scan unlock consent", { limit: 10 });
    sameRanking(plain, named);
    expect(named.map((h) => h.id)).toEqual(expect.arrayContaining([theirs, mine]));
  });
});
