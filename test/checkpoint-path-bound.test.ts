import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as cp from "../src/checkpoint.js";
import { openDb, DB } from "../src/db.js";

/**
 * mem_checkpoint indexed whatever transcript_path a caller passed, widening
 * ingestion past the configured corpus. The path must resolve (symlinks
 * followed) to a transcript the sweep itself would index, and the RESOLVED
 * path is what gets indexed.
 */
let root: string;
let claudeRoot: string;
let codexRoot: string;
let db: DB;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-cpb-")));
  claudeRoot = path.join(root, "projects");
  codexRoot = path.join(root, "codex");
  fs.mkdirSync(path.join(claudeRoot, "-tmp-proj"), { recursive: true });
  fs.mkdirSync(codexRoot, { recursive: true });
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const LINE = JSON.stringify({ type: "user", uuid: "u1", sessionId: "s1", timestamp: "2026-09-25T00:00:00Z", message: { role: "user", content: "checkpoint me please" } }) + "\n";
const touch = (p: string, body = LINE) => (fs.mkdirSync(path.dirname(p), { recursive: true }), fs.writeFileSync(p, body), p);
const roots = () => ({ claude: claudeRoot, codex: codexRoot });
const allowed = (p: string) => cp.resolveTranscriptPath(p, roots()) !== undefined;
const checkpoints = () => (db.prepare("SELECT count(*) AS n FROM checkpoints").get() as { n: number }).n;

describe("resolveTranscriptPath accepts exactly what the sweep indexes", () => {
  it("a session transcript, a subagent and a workflow agent in a project dir; a Codex rollout at any depth", () => {
    expect(allowed(touch(path.join(claudeRoot, "-tmp-proj", "s1.jsonl")))).toBe(true);
    expect(allowed(touch(path.join(claudeRoot, "-tmp-proj", "s1", "subagents", "agent-a1.jsonl")))).toBe(true);
    expect(allowed(touch(path.join(claudeRoot, "-tmp-proj", "s1", "subagents", "workflows", "wf_1", "agent-w1.jsonl")))).toBe(true);
    expect(allowed(touch(path.join(codexRoot, "2026", "09", "rollout-x.jsonl")))).toBe(true);
  });

  it("refuses a file outside every root, a .. traversal out, and a prefix-sharing sibling root", () => {
    expect(allowed(touch(path.join(root, "elsewhere", "s1.jsonl")))).toBe(false);
    touch(path.join(root, "outside.jsonl"));
    expect(allowed(path.join(claudeRoot, "-tmp-proj", "..", "..", "outside.jsonl"))).toBe(false);
    expect(allowed(touch(path.join(root, "projects-evil", "-tmp-proj", "s1.jsonl")))).toBe(false);
  });

  it("refuses a Claude-root file in a shape the sweep never reads", () => {
    expect(allowed(touch(path.join(claudeRoot, "stray.jsonl")))).toBe(false); // not in a project dir
    expect(allowed(touch(path.join(claudeRoot, "-tmp-proj", "deep", "er", "x.jsonl")))).toBe(false);
    expect(allowed(touch(path.join(claudeRoot, "-tmp-proj", "s1", "subagents", "journal.jsonl")))).toBe(false);
  });

  it("refuses an EXCLUDED project, including through a subagents/ path", () => {
    expect(allowed(touch(path.join(claudeRoot, "-private-tmp-x", "s1.jsonl")))).toBe(false);
    expect(allowed(touch(path.join(claudeRoot, "-private-tmp-x", "s1", "subagents", "agent-1.jsonl")))).toBe(false);
  });

  it("checks the RESOLVED path: an in-root symlink to outside, or to a non-.jsonl file, is refused", () => {
    const outside = touch(path.join(root, "secret-notes.jsonl"));
    fs.symlinkSync(outside, path.join(claudeRoot, "-tmp-proj", "link.jsonl"));
    expect(allowed(path.join(claudeRoot, "-tmp-proj", "link.jsonl"))).toBe(false);
    const txt = touch(path.join(claudeRoot, "-tmp-proj", "notes.txt"));
    fs.symlinkSync(txt, path.join(claudeRoot, "-tmp-proj", "txtlink.jsonl"));
    expect(allowed(path.join(claudeRoot, "-tmp-proj", "txtlink.jsonl"))).toBe(false);
  });

  it("refuses a directory named x.jsonl, a FIFO, a missing file and a non-.jsonl file", () => {
    fs.mkdirSync(path.join(claudeRoot, "-tmp-proj", "dir.jsonl"));
    expect(allowed(path.join(claudeRoot, "-tmp-proj", "dir.jsonl"))).toBe(false);
    execFileSync("mkfifo", [path.join(claudeRoot, "-tmp-proj", "fifo.jsonl")]);
    expect(allowed(path.join(claudeRoot, "-tmp-proj", "fifo.jsonl"))).toBe(false);
    expect(allowed(path.join(claudeRoot, "-tmp-proj", "nope.jsonl"))).toBe(false);
    expect(allowed(touch(path.join(claudeRoot, "-tmp-proj", "notes.md")))).toBe(false);
  });

  it("accepts transcripts under a root that is itself a symlink", () => {
    const linkedRoot = path.join(root, "linked-projects");
    fs.symlinkSync(claudeRoot, linkedRoot);
    const f = touch(path.join(claudeRoot, "-tmp-proj", "s2.jsonl"));
    expect(cp.resolveTranscriptPath(path.join(linkedRoot, "-tmp-proj", "s2.jsonl"), { claude: linkedRoot, codex: codexRoot })).toBe(f);
  });
});

describe("the mem_checkpoint handler (checkpointFromMcp)", () => {
  it("refuses an outside path with isError AND writes no checkpoint", async () => {
    const outside = touch(path.join(root, "elsewhere", "s1.jsonl"));
    const r = await cp.checkpointFromMcp(db, { session_id: "s1", transcript_path: outside }, roots());
    expect(r.isError).toBe(true);
    expect(checkpoints()).toBe(0);
  });

  it("writes a checkpoint for an allowed path, from the RESOLVED file", async () => {
    const real = touch(path.join(claudeRoot, "-tmp-proj", "s1.jsonl"));
    const link = path.join(claudeRoot, "-tmp-proj", "alias.jsonl");
    fs.symlinkSync(real, link);
    const r = await cp.checkpointFromMcp(db, { session_id: "s1", transcript_path: link, cwd: "/tmp/proj" }, roots());
    expect(r.isError).toBeUndefined();
    expect(checkpoints()).toBe(1);
    expect((db.prepare("SELECT transcript_path FROM sessions WHERE session_id = 's1'").get() as { transcript_path: string }).transcript_path).toBe(real);
  });

  // the caller's session_id was asserted, not derived. A mismatch filed
  // the brief under a session the indexed transcript never wrote to (an empty
  // brief), or under ANOTHER live session whose restore would then claim it.
  it("refuses a Claude-root transcript whose session is not the session_id, and writes nothing", async () => {
    const other = touch(path.join(claudeRoot, "-tmp-proj", "s2.jsonl"));
    const r = await cp.checkpointFromMcp(db, { session_id: "s1", transcript_path: other, cwd: "/tmp/proj" }, roots());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/belongs to session s2/);
    expect(checkpoints()).toBe(0);
    expect(db.prepare("SELECT count(*) AS n FROM episodes").get()).toEqual({ n: 0 });
  });

  it("a subagent transcript's session is <parent>/agent-<id>: the parent's id alone is refused, the full key accepted", async () => {
    const agent = touch(path.join(claudeRoot, "-tmp-proj", "s1", "subagents", "agent-a1.jsonl"));
    const parentOnly = await cp.checkpointFromMcp(db, { session_id: "s1", transcript_path: agent, cwd: "/tmp/proj" }, roots());
    expect(parentOnly.isError).toBe(true);
    expect(parentOnly.text).toMatch(/belongs to session s1\/agent-a1/);
    const full = await cp.checkpointFromMcp(db, { session_id: "s1/agent-a1", transcript_path: agent, cwd: "/tmp/proj" }, roots());
    expect(full.isError).toBeUndefined();
    expect(checkpoints()).toBe(1);
  });

  it("the check reads the RESOLVED file: a link named for the caller's session to another session's transcript is refused", async () => {
    const real = touch(path.join(claudeRoot, "-tmp-proj", "s2.jsonl"));
    const link = path.join(claudeRoot, "-tmp-proj", "s1.jsonl");
    fs.symlinkSync(real, link);
    const r = await cp.checkpointFromMcp(db, { session_id: "s1", transcript_path: link, cwd: "/tmp/proj" }, roots());
    expect(r.isError).toBe(true);
    expect(checkpoints()).toBe(0);
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});
