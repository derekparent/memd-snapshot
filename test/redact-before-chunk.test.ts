// SYNTHETIC FIXTURES: every key body in this file is fabricated. None is a real credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseLine } from "../src/chunker.js";
import { parseCodexLine } from "../src/codex.js";
import { openDb } from "../src/db.js";
import { redact } from "../src/redact.js";

/**
 * Redaction ran per CHUNK, after truncation and splitting, so a
 * private-key block that truncation cut short or a chunk boundary split in two
 * never matched the BEGIN...END rule and its body was stored. Every ingest path
 * must redact the whole text before it truncates or splits.
 */
const KEYBODY = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCSYNTHETICBODYSYNTHETICBODY";
const pem = (lines: number) => `-----BEGIN PRIVATE KEY-----\n${(KEYBODY + "\n").repeat(lines)}-----END PRIVATE KEY-----`;
const BIG = pem(80); // ~4.7k chars: longer than the 4000-char tool-output cap
const SMALL = pem(10); // ~600 chars: survives truncation, straddles a chunk boundary below
const STRADDLE = "x".repeat(1400) + "\n" + SMALL + "\ntail";
// The raw text really does cross the 1600-char chunk boundary inside the key.
const straddles = () => STRADDLE.indexOf(KEYBODY) < 1600 && STRADDLE.lastIndexOf(KEYBODY) > 1600;
// Tool output that is ONLY a key redacts to a stub the trivial-output filter drops;
// surround it so the redacted result is still stored and can be inspected.
const WRAPPED = "cat ./id_synthetic output follows\n" + BIG + "\nend of output";

const leaks = (chunks: { content: string }[]) => chunks.some((c) => c.content.includes(KEYBODY));
const marked = (chunks: { content: string }[]) => chunks.some((c) => c.content.includes("[REDACTED:PRIVATE_KEY]"));
const claudeLine = (content: unknown) =>
  JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-09-25T00:00:00Z", message: { role: "user", content } });
const codexLine = (payload: unknown) => JSON.stringify({ type: "response_item", timestamp: "2026-09-25T00:00:00Z", payload });

describe("claude transcript path", () => {
  it("an 80-line PEM in a tool_result (truncation drops END) is not stored", () => {
    expect(redact(BIG)).not.toContain(KEYBODY); // control: whole-text redact is clean
    const { chunks } = parseLine(claudeLine([{ type: "tool_result", tool_use_id: "t", content: WRAPPED }]));
    expect(leaks(chunks)).toBe(false);
    expect(marked(chunks)).toBe(true);
  });

  it("a PEM straddling a chunk boundary in a text block is not stored", () => {
    const { chunks } = parseLine(claudeLine([{ type: "text", text: STRADDLE }]));
    expect(straddles()).toBe(true);
    expect(leaks(chunks)).toBe(false);
    expect(marked(chunks)).toBe(true);
  });

  it("a PEM in a tool_use input longer than the input cap is not stored", () => {
    const { chunks } = parseLine(
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-09-25T00:00:00Z", message: { role: "assistant", content: [{ type: "tool_use", name: "Write", input: { content: BIG } }] } })
    );
    expect(leaks(chunks)).toBe(false);
  });
});

describe("codex rollout path", () => {
  it("an 80-line PEM in a function_call_output is not stored", () => {
    const { chunks } = parseCodexLine(codexLine({ type: "function_call_output", call_id: "c", output: WRAPPED }), "f");
    expect(leaks(chunks)).toBe(false);
    expect(marked(chunks)).toBe(true);
  });

  it("a PEM straddling a chunk boundary in a message is not stored", () => {
    const { chunks } = parseCodexLine(codexLine({ type: "message", role: "user", content: [{ type: "input_text", text: STRADDLE }] }), "f");
    expect(straddles()).toBe(true);
    expect(leaks(chunks)).toBe(false);
    expect(marked(chunks)).toBe(true);
  });
});

describe("docs path", () => {
  let root = "";
  afterEach(() => {
    delete process.env.MEMD_DOC_ROOTS;
    vi.resetModules();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("a PEM straddling a chunk boundary in a curated doc is not stored", async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-redact-docs-")));
    fs.writeFileSync(path.join(root, "CONTEXT.md"), STRADDLE);
    const db = openDb(path.join(root, "t.db"));
    process.env.MEMD_DOC_ROOTS = path.join(root, "CONTEXT.md");
    vi.resetModules();
    const { indexDocs } = await import("../src/docs.js");
    indexDocs(db);
    const rows = db.prepare("SELECT content FROM docs").all() as { content: string }[];
    expect(straddles()).toBe(true);
    expect(leaks(rows)).toBe(false);
    expect(marked(rows)).toBe(true);
  });
});

describe("a key block that arrives without its END line", () => {
  it("is redacted from BEGIN to the end of the text", () => {
    const cut = `before\n-----BEGIN RSA PRIVATE KEY-----\n${(KEYBODY + "\n").repeat(5)}`;
    const out = redact(cut);
    expect(out).not.toContain(KEYBODY);
    expect(out).toContain("before");
    expect(out).toContain("[REDACTED:PRIVATE_KEY]");
  });

  it("a complete block still redacts only itself", () => {
    const out = redact(`a ${SMALL} b`);
    expect(out).toBe("a [REDACTED:PRIVATE_KEY] b");
  });
});
