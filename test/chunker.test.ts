// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import { describe, expect, it } from "vitest";
import { parseLine } from "../src/chunker.js";

const userLine = JSON.stringify({
  type: "user",
  uuid: "u-1",
  timestamp: "2026-07-26T12:00:00Z",
  cwd: "/Users/alice/Projects/homebase",
  gitBranch: "main",
  sessionId: "sess-1",
  message: { role: "user", content: "The VPN drops when tailscale sleeps" },
});

const assistantLine = JSON.stringify({
  type: "assistant",
  uuid: "a-1",
  timestamp: "2026-07-26T12:00:05Z",
  sessionId: "sess-1",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "secret reasoning", signature: "xxx" },
      { type: "text", text: "Try tailscale set --accept-routes" },
      { type: "tool_use", name: "Bash", input: { command: "tailscale status" } },
    ],
  },
});

const summaryLine = JSON.stringify({ type: "summary", summary: "Fixed VPN keepalive", leafUuid: "leaf-1" });

describe("parseLine", () => {
  it("extracts user text with metadata", () => {
    const { chunks, meta } = parseLine(userLine);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ role: "user", kind: "text", srcUuid: "u-1" });
    expect(chunks[0].content).toContain("tailscale sleeps");
    expect(meta).toMatchObject({ sessionId: "sess-1", cwd: "/Users/alice/Projects/homebase", gitBranch: "main" });
  });

  it("keeps assistant text + tool_use, drops thinking", () => {
    const { chunks } = parseLine(assistantLine);
    expect(chunks.map((c) => c.kind)).toEqual(["text", "tool_use"]);
    expect(chunks.some((c) => c.content.includes("secret reasoning"))).toBe(false);
    expect(chunks[1].content).toContain("[tool:Bash]");
  });

  it("captures summary lines", () => {
    const { chunks } = parseLine(summaryLine);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe("summary");
  });

  it("splits long text into overlapping chunks with sequential chunk numbers", () => {
    const long = JSON.stringify({
      type: "user",
      uuid: "u-2",
      timestamp: "2026-07-26T12:01:00Z",
      sessionId: "sess-1",
      message: { role: "user", content: "x".repeat(5000) },
    });
    const { chunks } = parseLine(long);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.chunkNo)).toEqual(chunks.map((_, i) => i));
  });

  it("ignores meta/attachment lines and garbage", () => {
    expect(parseLine('{"type":"mode","mode":"normal"}').chunks).toHaveLength(0);
    expect(parseLine("not json at all").chunks).toHaveLength(0);
  });

  it("redacts secrets inside transcript content", () => {
    const leaky = JSON.stringify({
      type: "user",
      uuid: "u-3",
      timestamp: "2026-07-26T12:02:00Z",
      sessionId: "sess-1",
      message: { role: "user", content: "my key is AKIAIOSFODNN7EXAMPLE" },
    });
    const { chunks } = parseLine(leaky);
    expect(chunks[0].content).toContain("[REDACTED:AWS_KEY]");
  });
});
