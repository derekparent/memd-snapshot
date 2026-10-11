import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consumeFeedback, feedbackRoot, listFeedback, newFeedback, tilde } from "../src/feedback.js";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-fb-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const read = (p: string) => fs.readFileSync(p, "utf8");

describe("newFeedback", () => {
  it("writes a dated, project-slugged file with frontmatter", () => {
    const { path: p, name } = newFeedback({ project: "parts-mcp", arc: "field session", root, date: "2026-07-26" });
    expect(name).toBe("2026-07-26-parts-mcp.md");
    const body = read(p);
    expect(body).toContain("project: parts-mcp");
    expect(body).toContain("arc: field session");
    expect(body).toContain("date: 2026-07-26");
    expect(body).toMatch(/build: \w+/); // build stamp is mandatory payload
  });

  it("templates the four mandatory payload fields", () => {
    // Retrieval quality is worthless without the inputs — the template must
    // make the literal query unavoidable rather than optional.
    const body = read(newFeedback({ project: "memd", arc: "x", root }).path);
    expect(body).toContain("query");
    expect(body).toContain("literal, not a paraphrase");
    expect(body).toContain("observed");
    expect(body).toContain("expected");
    expect(body).toContain("resolved by");
  });

  it("keeps a What worked section — positives protect against regression", () => {
    const body = read(newFeedback({ project: "memd", arc: "x", root }).path);
    expect(body).toContain("What worked");
  });

  it("never overwrites a same-day file for the same project", () => {
    const a = newFeedback({ project: "memd", arc: "one", root, date: "2026-07-26" });
    const b = newFeedback({ project: "memd", arc: "two", root, date: "2026-07-26" });
    expect(b.name).toBe("2026-07-26-memd-2.md");
    expect(read(a.path)).toContain("arc: one");
    expect(read(b.path)).toContain("arc: two");
  });

  it("slugs an awkward project name and never escapes the directory", () => {
    const { name } = newFeedback({ project: "../../etc/Passwd Thing", arc: "x", root, date: "2026-07-26" });
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(fs.existsSync(path.join(feedbackRoot(root), name))).toBe(true);
  });

  it("keeps a multi-line arc on one frontmatter line", () => {
    const body = read(newFeedback({ project: "memd", arc: "line one\nline two", root }).path);
    expect(body).toContain("arc: line one line two");
    expect(body.split("---")[1]).not.toContain("\nline two");
  });
});

describe("listFeedback", () => {
  it("returns nothing when no one was surprised — silence is the default", () => {
    expect(listFeedback(root)).toEqual([]);
  });

  it("lists pending files newest first", () => {
    newFeedback({ project: "a", arc: "x", root, date: "2026-07-20" });
    newFeedback({ project: "b", arc: "x", root, date: "2026-07-26" });
    expect(listFeedback(root).map((f) => f.name)).toEqual(["2026-07-26-b.md", "2026-07-20-a.md"]);
  });

  it("does not list already-consumed files", () => {
    const { name } = newFeedback({ project: "a", arc: "x", root, date: "2026-07-20" });
    consumeFeedback(name, root);
    expect(listFeedback(root)).toEqual([]);
  });
});

describe("consumeFeedback", () => {
  it("moves a triaged file into reviewed/", () => {
    const { name } = newFeedback({ project: "a", arc: "x", root, date: "2026-07-20" });
    const dest = consumeFeedback(name, root);
    expect(dest).toBe(path.join(feedbackRoot(root), "reviewed", name));
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.existsSync(path.join(feedbackRoot(root), name))).toBe(false);
  });

  it("does not clobber an earlier file of the same name in reviewed/", () => {
    const first = newFeedback({ project: "a", arc: "first", root, date: "2026-07-20" });
    consumeFeedback(first.name, root);
    fs.writeFileSync(path.join(feedbackRoot(root), first.name), "second round\n");
    const dest = consumeFeedback(first.name, root);
    expect(path.basename(dest)).toBe("2026-07-20-a-2.md");
    expect(read(path.join(feedbackRoot(root), "reviewed", "2026-07-20-a.md"))).toContain("arc: first");
  });

  it("refuses a filename that is not pending", () => {
    expect(() => consumeFeedback("nope.md", root)).toThrow(/no pending feedback/);
  });

  it("ignores a path prefix rather than escaping the feedback dir", () => {
    expect(() => consumeFeedback("../../../etc/hosts", root)).toThrow(/no pending feedback/);
  });
});

describe("tilde", () => {
  it("shortens a home path for readable output", () => {
    expect(tilde(path.join(os.homedir(), ".claude", "memd"))).toBe("~/.claude/memd");
  });
  it("leaves a non-home path alone", () => {
    expect(tilde("/var/tmp/x")).toBe("/var/tmp/x");
  });
});
