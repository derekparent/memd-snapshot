import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";

/**
 * Text that callers read must not claim what the code does not do. A tool
 * description is shown to every agent that connects; a config knob that does
 * nothing misleads anyone who tunes it.
 */
const src = (f: string) => fs.readFileSync(path.join(__dirname, "../src", f), "utf8");

describe("no dead ranking knob", () => {
  it("config has no weightRelevance and nothing reads MEMD_W_RELEVANCE", () => {
    expect(Object.keys(config)).not.toContain("weightRelevance");
    for (const f of fs.readdirSync(path.join(__dirname, "../src"))) expect(src(f)).not.toMatch(/MEMD_W_RELEVANCE/);
  });
});

describe("relation tools describe a one-hop provenance layer, not a graph engine", () => {
  const server = src("server.ts");
  const describeOf = (tool: string) => {
    const at = server.indexOf(`"${tool}"`);
    return server.slice(at, server.indexOf("inputSchema", at));
  };
  for (const tool of ["mem_relate", "mem_graph"]) {
    it(`${tool} description makes no knowledge-graph or multi-hop claim`, () => {
      expect(describeOf(tool)).not.toMatch(/knowledge[- ]graph|multi-hop/i);
    });
  }
});

describe("misses.ts describes the judge that is actually wired", () => {
  it("does not say no judge is called while the server wires jevMissJudge", () => {
    expect(src("server.ts")).toMatch(/jevMissJudge\(\)/);
    expect(src("misses.ts")).not.toMatch(/nothing calls one today|No network judge/);
  });
});
