import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JEV_URL } from "../src/jev.js";
import { JEV_URL as FAKE_JEV_URL } from "./fixtures/fake-jev.mjs";

/**
 * The fake Jev fixture must stand between EVERY test and the real TypeSafe
 * service. Before this, it intercepted only the exact JEV_URL string, so a
 * drifted endpoint, a Request object or a differently-cased host went
 * straight to realFetch (the network). The child process swaps in a
 * recording fetch BEFORE loading the fixture, so "realFetch" is the recorder:
 * anything it sees would have hit the wire.
 */
let root: string;
let logFile: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memd-fakejev-"));
  logFile = path.join(root, "jev.jsonl");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const fixture = path.join(__dirname, "fixtures", "fake-jev.mjs");
function probe(calls: string): { passedThrough: string[]; results: { status: number }[] } {
  const script = `
    const passedThrough = [];
    globalThis.fetch = async (input) => {
      passedThrough.push(input instanceof Request ? input.url : String(input));
      return new Response("real", { status: 200 });
    };
    await import(${JSON.stringify("file://" + fixture)});
    const body = JSON.stringify({ questions: { q1: {} } });
    const results = [];
    for (const [input, init] of ${calls}) {
      const r = await fetch(input, init);
      results.push({ status: r.status });
    }
    console.log(JSON.stringify({ passedThrough, results }));
  `;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, FAKE_JEV_LOG: logFile },
    encoding: "utf8",
  });
  expect(r.stderr).toBe("");
  return JSON.parse(r.stdout);
}
const logged = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("fake-jev fixture never lets a typesafe.ai request reach the network", () => {
  it("the fixture's endpoint is the product's endpoint", () => {
    expect(FAKE_JEV_URL).toBe(JEV_URL);
  });

  it("answers the real endpoint locally and logs the body", () => {
    const out = probe(`[[${JSON.stringify(JEV_URL)}, { method: "POST", body }]]`);
    expect(out.passedThrough).toEqual([]);
    expect(out.results).toEqual([{ status: 200 }]);
    expect(logged()).toEqual([{ questions: { q1: {} } }]);
  });

  it("intercepts other typesafe.ai URLs (drifted path, other subdomain, bare host, upper case, trailing dot) with a 599", () => {
    const urls = [
      "https://api.typesafe.ai/v2/systemone",
      "https://api.typesafe.ai/v1/systemone?x=1",
      "https://docs.typesafe.ai/llms.txt",
      "https://typesafe.ai/",
      "https://API.TYPESAFE.AI/v1/systemone",
      "https://api.typesafe.ai./v1/systemone",
    ];
    const out = probe(JSON.stringify(urls.map((u) => [u, { method: "POST", body: "{}" }])));
    expect(out.passedThrough).toEqual([]);
    expect(out.results.every((r) => r.status === 599)).toBe(true);
    expect(logged().map((l) => l.unexpected)).toHaveLength(urls.length);
  });

  it("intercepts a Request object and a URL object, not just strings", () => {
    const out = probe(`[[new Request(${JSON.stringify(JEV_URL)}, { method: "POST", body }), undefined], [new URL(${JSON.stringify(JEV_URL)}), { method: "POST", body }]]`);
    expect(out.passedThrough).toEqual([]);
    expect(out.results).toEqual([{ status: 200 }, { status: 200 }]);
  });

  it("lookalike hosts are not typesafe.ai and pass through untouched", () => {
    const out = probe(JSON.stringify([["https://nottypesafe.ai/x", undefined], ["https://typesafe.ai.example.com/x", undefined]]));
    expect(out.passedThrough).toEqual(["https://nottypesafe.ai/x", "https://typesafe.ai.example.com/x"]);
    expect(logged()).toEqual([]);
  });
});
