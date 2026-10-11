import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { saveFact } from "../src/facts.js";
import { responseNotes, samplingNote } from "../src/search.js";

/**
 * the dangerous failure mode, not the annoying one. Asked "how many
 * separate times has a green test suite hidden a broken product", search
 * returned 3 real instances where an independent SQL sweep found 9 — and
 * nothing in the response said it was a sample. The fix is not to count
 * harder; it is to stop implying a count.
 */
describe("fires on aggregate-shaped questions", () => {
  const aggregate = [
    "How many separate times has a green test suite hidden a broken product?",
    "how often did we hit the keyboard bug",
    "how much time did we spend on the SSE work",
    "what is the total of all the PRs merged this week",
    "the number of times the suite went red",
    "every time we shipped a hotfix",
    "each time the watchdog fired",
    "all the times the reviewer overruled a verdict",
    "list all the facts about redaction",
    "list every project with a CONTEXT.md",
    "all instances of the LazyStack bug",
    "every occurrence of a stale read",
    "enumerate the rulings from this run",
    "tally the merges by repo",
    // Question-form anchors added in review: as precise as the originals, and
    // "have we ever" is the likeliest census phrasing.
    "have we ever shipped a migration without a dry run",
    "have you ever seen this failure before",
    "have i ever approved a direct push to main",
    "give me the full list of merged PRs",
    "everything we know about the redaction rules",
    "what are all the projects with a DECISIONS.md",
  ];

  it.each(aggregate)("fires: %s", (q) => {
    expect(samplingNote(q)).toBeDefined();
  });

  it("says plainly that it is a sample and names the exhaustive path", () => {
    const note = samplingNote("how many times did the suite lie")!;
    expect(note).toContain("SAMPLE");
    expect(note).toContain("not a census");
    expect(note).toContain("mem_timeline");
  });
});

describe("stays silent on ordinary recall — the adversarial floor", () => {
  const ordinary = [
    "what did we decide about X",
    "why did we redesign the atlas frontend",
    "what was the scroll issue with fieldapp-ios",
    "do you recall the tailscale troubleshooting",
    "how do I run the test suite",
    "how did we fix the hash rocket bug",
    "what is the release posture for billing-api",
    "the redaction rules for tool_result payloads",
    "who merges PRs in the relay team",
    // Bare quantifier words appear constantly in normal recall and must NOT
    // fire — a banner that cries wolf gets skimmed past when it matters.
    "what did we decide about all the auth flows",
    "every service should start the watchdog",
    "the total redesign of the frontend",
    "count on the manager to re-verify",
    // One trap per pattern added in review — each fires ONLY in question form.
    "that was the best decision ever made on this repo",
    "the fastest suite run ever recorded",
    "the full list is in CONTEXT.md",
    "everything we know is written down somewhere",
    "what are all-hands meetings for",
  ];

  it.each(ordinary)("silent: %s", (q) => {
    expect(samplingNote(q)).toBeUndefined();
  });
});

describe("responseNotes composition — the wiring the server actually calls", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db"));
    saveFact(db, { content: "a fact about redaction", project: "memd" });
  });

  it("returns nothing for an ordinary query against a known project", () => {
    expect(responseNotes(db, "what did we decide about redaction", { project: "memd" })).toEqual([]);
  });

  it("returns only the sampling banner for an aggregate query, no filter", () => {
    const notes = responseNotes(db, "how many times did redaction fire");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("not a census");
  });

  it("returns only the project diagnostic for an ordinary query on a bogus project", () => {
    const notes = responseNotes(db, "what did we decide", { project: "no-such-repo" });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("no project named");
  });

  it("returns BOTH, project diagnostic first, when both apply", () => {
    const notes = responseNotes(db, "how many times did it fire", { project: "no-such-repo" });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain("no project named");
    expect(notes[1]).toContain("not a census");
  });
});

describe("matching details", () => {
  it("is case-insensitive", () => {
    expect(samplingNote("HOW MANY times")).toBeDefined();
    expect(samplingNote("How Many Times")).toBeDefined();
  });

  it("does not fire on an empty query", () => {
    expect(samplingNote("")).toBeUndefined();
  });

  it("matches the field report's exact question", () => {
    expect(
      samplingNote("How many separate times has a green test suite hidden a broken product?")
    ).toBeDefined();
  });
});
