import { describe, expect, it } from "vitest";
import { parseCodexLine } from "../src/codex.js";

const meta = JSON.stringify({
  timestamp: "2026-07-18T04:18:11.725Z",
  type: "session_meta",
  payload: { id: "abc", cwd: "/Users/alice/Projects/task-tracker", originator: "Codex Desktop" },
});

const userMsg = JSON.stringify({
  timestamp: "2026-07-18T04:19:00.000Z",
  type: "response_item",
  payload: { type: "message", role: "user", content: [{ type: "input_text", text: "fix the login bug" }] },
});

const devMsg = JSON.stringify({
  timestamp: "2026-07-18T04:19:00.000Z",
  type: "response_item",
  payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "You are Codex..." }] },
});

const scaffold = JSON.stringify({
  timestamp: "2026-07-18T04:19:00.000Z",
  type: "response_item",
  payload: {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<environment_context>\n<cwd>/Users/alice</cwd>\n</environment_context>" }],
  },
});

const fnCall = JSON.stringify({
  timestamp: "2026-07-18T04:20:00.000Z",
  type: "response_item",
  payload: { type: "function_call", name: "shell", arguments: '{"command":["ls"]}', call_id: "c1" },
});

const fnOut = JSON.stringify({
  timestamp: "2026-07-18T04:20:01.000Z",
  type: "response_item",
  payload: { type: "function_call_output", call_id: "c1", output: "drwxr-xr-x src\n-rw-r--r-- package.json\n-rw-r--r-- tsconfig.json (listing of the repo root)" },
});

const eventDup = JSON.stringify({
  timestamp: "2026-07-18T04:19:00.000Z",
  type: "event_msg",
  payload: { type: "user_message", message: "fix the login bug" },
});

describe("parseCodexLine", () => {
  it("extracts cwd from session_meta", () => {
    const { chunks, cwd } = parseCodexLine(meta, "f1");
    expect(chunks).toHaveLength(0);
    expect(cwd).toBe("/Users/alice/Projects/task-tracker");
  });

  it("keeps real user messages", () => {
    const { chunks } = parseCodexLine(userMsg, "f1");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ role: "user", kind: "text" });
    expect(chunks[0].srcUuid).toMatch(/^cx:f1:/);
  });

  it("skips developer-role scaffolding and XML context payloads", () => {
    expect(parseCodexLine(devMsg, "f1").chunks).toHaveLength(0);
    expect(parseCodexLine(scaffold, "f1").chunks).toHaveLength(0);
  });

  it("maps function_call and function_call_output to tool episodes", () => {
    expect(parseCodexLine(fnCall, "f1").chunks[0]).toMatchObject({ kind: "tool_use", role: "assistant" });
    expect(parseCodexLine(fnCall, "f1").chunks[0].content).toContain("[tool:shell]");
    expect(parseCodexLine(fnOut, "f1").chunks[0]).toMatchObject({ kind: "tool_result" });
  });

  it("skips event_msg duplicates", () => {
    expect(parseCodexLine(eventDup, "f1").chunks).toHaveLength(0);
  });

  it("produces stable ids for identical content (replay-safe)", () => {
    const a = parseCodexLine(userMsg, "f1").chunks[0].srcUuid;
    const b = parseCodexLine(userMsg, "f1").chunks[0].srcUuid;
    expect(a).toBe(b);
  });
});
