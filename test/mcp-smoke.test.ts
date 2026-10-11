// SYNTHETIC FIXTURES: every secret in this file is fabricated. None is a real credential.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FACT_KINDS } from "../src/facts.js";

/**
 * The MCP surface is what every agent actually calls, and no test ever spoke
 * the protocol to it. This builds dist/ and drives the real server over
 * stdio, under a throwaway HOME so nothing touches a real store.
 */
const repo = path.join(__dirname, "..");
let home: string;
let client: Client;
/** A second server with Jev ON, its network answered by test/fixtures/fake-jev.mjs. */
let jevHome: string;
let jevClient: Client;
let jevLog: string;
// The Jev-off server also carries the fake and an inherited API key (without
// MEMD_JEV): any request that reaches the endpoint lands in offJevLog.
const offJevLog = () => path.join(home, "jev-requests.jsonl");
const env = () => ({
  PATH: process.env.PATH ?? "",
  HOME: home,
  MEMD_DB_PATH: path.join(home, ".claude", "memd", "memd.db"),
  TYPESAFE_API_KEY: "inherited-key-must-not-enable-jev",
  FAKE_JEV_LOG: offJevLog(),
});
const jevRequests = (): any[] =>
  fs.existsSync(jevLog) ? fs.readFileSync(jevLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
async function until<T>(f: () => T | undefined, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 25));
  }
}
const text = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

beforeAll(async () => {
  execFileSync("npx", ["tsc"], { cwd: repo, stdio: "ignore" });
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-mcp-")));
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  client = new Client({ name: "memd-smoke", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", path.join(__dirname, "fixtures", "fake-jev.mjs"), path.join(repo, "dist", "server.js")],
      env: env(),
      stderr: "ignore",
    })
  );

  jevHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-mcp-jev-")));
  fs.mkdirSync(path.join(jevHome, ".claude", "projects"), { recursive: true });
  jevLog = path.join(jevHome, "jev-requests.jsonl");
  jevClient = new Client({ name: "memd-smoke-jev", version: "1.0.0" });
  await jevClient.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ["--import", path.join(__dirname, "fixtures", "fake-jev.mjs"), path.join(repo, "dist", "server.js")],
      env: {
        PATH: process.env.PATH ?? "",
        HOME: jevHome,
        MEMD_DB_PATH: path.join(jevHome, ".claude", "memd", "memd.db"),
        MEMD_JEV: "on",
        TYPESAFE_API_KEY: "fake-key-for-tests",
        FAKE_JEV_LOG: jevLog,
      },
      stderr: "ignore",
    })
  );
}, 120_000);

afterAll(async () => {
  await client?.close();
  await jevClient?.close();
  if (home) fs.rmSync(home, { recursive: true, force: true });
  if (jevHome) fs.rmSync(jevHome, { recursive: true, force: true });
});

describe("memd MCP server over stdio (built dist/)", () => {
  it("lists all ten tools", async () => {
    const names = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(
      ["mem_checkpoint", "mem_checkpoints", "mem_forget", "mem_graph", "mem_relate", "mem_save", "mem_search", "mem_stats", "mem_supersede", "mem_timeline"].sort()
    );
  });

  it("no tool description calls stored history verbatim (ingestion redacts and truncates)", async () => {
    for (const t of (await client.listTools()).tools) expect(`${t.name}: ${t.description}`).not.toMatch(/verbatim|immutable/i);
  });

  it("mem_save redacts a quoted secret mid-sentence, and mem_search never returns it", async () => {
    // SYNTHETIC secret
    const saved = text(await client.callTool({ name: "mem_save", arguments: { content: 'the smoke config had api_key = "synthSmokeKey77" in it' } }));
    expect(saved).not.toContain("synthSmokeKey77");
    const found = text(await client.callTool({ name: "mem_search", arguments: { query: "smoke config api_key" } }));
    expect(found).toContain("smoke config had api_key");
    expect(found).not.toContain("synthSmokeKey77");
    expect(text(await client.callTool({ name: "mem_search", arguments: { query: "synthSmokeKey77" } }))).not.toContain("synthSmokeKey77");
  });

  it("save -> search -> supersede -> search returns the current version", async () => {
    const saved = text(await client.callTool({ name: "mem_save", arguments: { content: "staging deploys need one manual approval", kind: "ruling", importance: 8 } }));
    const id = Number(saved.match(/#(\d+)/)![1]);
    expect(text(await client.callTool({ name: "mem_search", arguments: { query: "staging deploys approval" } }))).toContain("one manual approval");

    const sup = text(await client.callTool({ name: "mem_supersede", arguments: { fact_id: id, content: "staging deploys need two manual approvals" } }));
    expect(sup).toMatch(new RegExp(`Fact #${id} superseded by #\\d+`));
    const after = text(await client.callTool({ name: "mem_search", arguments: { query: "staging deploys approval" } }));
    expect(after).toContain("two manual approvals");
    expect(after).not.toContain("one manual approval");
  });

  it("identical mem_supersede with a new importance says it updated the importance", async () => {
    const saved = text(await client.callTool({ name: "mem_save", arguments: { content: "the release branch freezes on thursdays", importance: 4 } }));
    const id = Number(saved.match(/#(\d+)/)![1]);
    const sup = text(await client.callTool({ name: "mem_supersede", arguments: { fact_id: id, content: "the release branch freezes on thursdays", importance: 9 } }));
    expect(sup).toContain(`Fact #${id} unchanged`);
    expect(sup).toContain("Its importance was updated from 4 to 9.");
    const same = text(await client.callTool({ name: "mem_supersede", arguments: { fact_id: id, content: "the release branch freezes on thursdays" } }));
    expect(same).toContain(`Fact #${id} unchanged`);
    expect(same).not.toContain("importance was updated");
  });

  it("checkpoint over MCP, then the SessionStart restore hook returns the brief", async () => {
    const dir = path.join(home, ".claude", "projects", "-tmp-smoke-proj");
    fs.mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, "smoke-sess.jsonl");
    fs.writeFileSync(
      transcript,
      JSON.stringify({ type: "user", uuid: "u1", sessionId: "smoke-sess", timestamp: new Date().toISOString(), message: { role: "user", content: "please wire the smoke gauge" } }) + "\n"
    );
    const cp = await client.callTool({ name: "mem_checkpoint", arguments: { session_id: "smoke-sess", transcript_path: transcript, cwd: "/tmp/smoke-proj" } });
    expect(cp.isError).toBeFalsy();
    expect(text(cp)).toMatch(/Checkpoint #\d+ written/);

    const r = spawnSync(process.execPath, [path.join(repo, "dist", "cli.js"), "restore"], {
      input: JSON.stringify({ session_id: "smoke-sess", cwd: "/tmp/smoke-proj", source: "compact" }),
      env: env(),
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("smoke gauge");
  });

  it("mem_stats answers and names the throwaway store", async () => {
    expect(text(await client.callTool({ name: "mem_stats", arguments: {} }))).toContain(home);
  });
});

/**
 * tests that used to grep server.ts for a call site or a format string now
 * assert what an agent actually receives over MCP. A source grep passes when
 * the line exists but is unreachable, and fails on a harmless rewording.
 */
describe("server wiring, asserted over MCP (Jev off)", () => {
  it("mem_save's kind enum is FACT_KINDS", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "mem_save")!;
    expect((tool.inputSchema.properties as any).kind.enum).toEqual([...FACT_KINDS]);
  });

  it("feedback facts save, stay out of ordinary searches, and come back with include_feedback", async () => {
    expect(text(await client.callTool({ name: "mem_save", arguments: { content: "smokefb the widget search missed twice", kind: "feedback" } }))).toMatch(/^Saved fact #\d+/);
    expect(text(await client.callTool({ name: "mem_search", arguments: { query: "smokefb widget", sources: ["facts"] } }))).not.toContain("smokefb the widget");
    expect(
      text(await client.callTool({ name: "mem_search", arguments: { query: "smokefb widget", sources: ["facts"], include_feedback: true } }))
    ).toContain("smokefb the widget");
  });

  it("a zero-hit mem_search is recorded as a miss", async () => {
    const q = "zzsmokemiss qqnothing matches this";
    await client.callTool({ name: "mem_search", arguments: { query: q } });
    const file = path.join(home, ".claude", "memd", "misses.jsonl");
    const rec = await until(() =>
      fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((r) => r.query === q) : undefined
    );
    expect(rec.reasons).toContain("zero");
  });

  it("mem_stats reports the vector-leg error count and the Jev state", async () => {
    const stats = text(await client.callTool({ name: "mem_stats", arguments: {} }));
    expect(stats).toMatch(/vector leg errors \(this process\): 0/);
    expect(stats).toMatch(/jev: disabled \(opt-in: set MEMD_JEV=on and TYPESAFE_API_KEY\); 0 request\(s\) skipped as sensitive-topic/);
  });

  it("with Jev off (a key in the env is not enough), nothing ever reaches the Jev endpoint", async () => {
    // Every Jev call site has run by now on this server: searches (miss judge,
    // stale-ruling note for "policy"), and a save next to a similar fact.
    await client.callTool({ name: "mem_save", arguments: { content: "smokeoff the release policy is weekly", kind: "ruling" } });
    await client.callTool({ name: "mem_save", arguments: { content: "smokeoff the release policy is daily", kind: "ruling" } });
    await client.callTool({ name: "mem_search", arguments: { query: "what is the smokeoff release policy" } });
    await new Promise((r) => setTimeout(r, 100)); // the miss judge runs on setImmediate
    expect(fs.existsSync(offJevLog())).toBe(false);
  });

  it("mem_checkpoint refuses a transcript outside the roots (it goes through checkpointFromMcp)", async () => {
    const outside = path.join(home, "elsewhere.jsonl");
    fs.writeFileSync(outside, "{}\n");
    const r = await client.callTool({ name: "mem_checkpoint", arguments: { session_id: "elsewhere", transcript_path: outside } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^Refused: transcript_path must resolve/);
  });
});

describe("server wiring, asserted over MCP (Jev on, network faked)", () => {
  it("mem_save warns when Jev judges the new fact to conflict with a similar one", async () => {
    await jevClient.callTool({ name: "mem_save", arguments: { content: "smoke deploys to staging freeze every friday at noon" } });
    const r = text(await jevClient.callTool({ name: "mem_save", arguments: { content: "smoke deploys to staging freeze every friday at five" } }));
    expect(r).toMatch(/fact #\d+ appears to conflict — if this replaces it use mem_supersede\./);
  });

  it("mem_search appends the stale-ruling note when rulings disagree, hits untouched", async () => {
    await jevClient.callTool({ name: "mem_save", arguments: { content: "the smokeship release policy is to ship on mondays", kind: "ruling" } });
    await jevClient.callTool({ name: "mem_save", arguments: { content: "the smokeship release policy is to ship on thursdays", kind: "ruling" } });
    const r = text(await jevClient.callTool({ name: "mem_search", arguments: { query: "what is the smokeship release policy", sources: ["facts"] } }));
    expect(r).toContain("ship on mondays");
    expect(r).toContain("ship on thursdays");
    expect(r).toMatch(/NOTE: these results DISAGREE on this\. The newest on-topic CURRENT passage \([^)]*\) begins: "the smokeship release policy is to ship on thursdays"/);
    expect(r).toContain("[judged by fake-jev; hits are not reordered]");
  });

  it("the miss judge receives the query and the hit texts", async () => {
    const q = "smokejudge which day does the smokeship release ship";
    await jevClient.callTool({ name: "mem_search", arguments: { query: q, sources: ["facts"] } });
    const req = await until(() => jevRequests().find((b) => b.state?.query === q && Array.isArray(b.state?.results)));
    expect(Object.keys(req.questions)).toEqual(["answers"]);
    expect(req.state.results.join(" ")).toContain("smokeship release policy");
  });

  it("mem_stats reports Jev enabled and counts a request skipped as sensitive-topic", async () => {
    const skipped = async () => Number(text(await jevClient.callTool({ name: "mem_stats", arguments: {} })).match(/(\d+) request\(s\) skipped as sensitive-topic/)![1]);
    expect(text(await jevClient.callTool({ name: "mem_stats", arguments: {} }))).toMatch(/jev: enabled \(/);
    const before = await skipped();
    const sent = jevRequests().length;
    await jevClient.callTool({ name: "mem_save", arguments: { content: "smoke vault password rotation happens every month" } });
    await jevClient.callTool({ name: "mem_save", arguments: { content: "smoke vault password rotation happens every week" } }); // similar -> Jev asked -> sensitive
    expect(await skipped()).toBeGreaterThan(before);
    expect(jevRequests().length).toBe(sent); // nothing about it left the process
  });
});
