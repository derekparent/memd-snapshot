// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";
import { isTrivialToolResult } from "../src/chunker.js";
import { episodePrior } from "../src/search.js";
import { projectFromDir } from "../src/indexer.js";

describe("redaction false-positive regressions", () => {
  it("leaves hyphenated sk- CSS classes and package names alone", () => {
    expect(redact('<div class="sk-circle-bounce-delay-child-two">')).toContain("sk-circle-bounce-delay-child-two");
    expect(redact("pip install sk-learn-extra-cluster-tools")).toContain("sk-learn-extra-cluster-tools");
  });
  it("still redacts real OpenAI and Anthropic keys", () => {
    expect(redact("sk-proj-Abc123Def456Ghi789Jkl012")).toContain("[REDACTED:OPENAI_KEY]");
    expect(redact("sk-ant-api03-aaaa-bbbb-cccc-dddd-eeee")).toContain("[REDACTED:ANTHROPIC_KEY]");
  });
});

describe("junk suppression", () => {
  it("flags trivial tool results", () => {
    expect(isTrivialToolResult("OK")).toBe(true);
    expect(isTrivialToolResult("Launching skill: claude-api")).toBe(true);
    expect(isTrivialToolResult("Tool ran without output or errors.")).toBe(true);
    expect(isTrivialToolResult("error TS2345: Argument of type 'string' is not assignable to parameter")).toBe(false);
  });
  it("orders kind priors summary > text > tool_use > tool_result and demotes stubs", () => {
    expect(episodePrior("summary", 500)).toBeGreaterThan(episodePrior("text", 500));
    expect(episodePrior("text", 500)).toBeGreaterThan(episodePrior("tool_use", 500));
    expect(episodePrior("tool_use", 500)).toBeGreaterThan(episodePrior("tool_result", 500));
    expect(episodePrior("text", 50)).toBeLessThan(episodePrior("text", 500));
  });
});

describe("worktree project normalization", () => {
  it("maps relay worktree slugs to their repo", () => {
    expect(projectFromDir("-Users-alice--worktrees-atlas-executor")).toBe("atlas");
    expect(projectFromDir("-Users-alice--worktrees-FieldApp-ios-advisor")).toBe("FieldApp-ios");
  });
  it("keeps normal project slugs working", () => {
    expect(projectFromDir("-Users-alice-Projects-homebase")).toBe("homebase");
    expect(projectFromDir("-Users-alice-Projects")).toBe("Projects");
  });
});
