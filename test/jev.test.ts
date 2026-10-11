// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askJev, FetchLike, JEV_MODEL, jevSkippedSensitive, jevStatus, SENSITIVE_TERMS } from "../src/jev.js";
import { jevMissJudge, MissJudge, MissTracker, missLogPath, readMisses, recordSearch, SearchCall } from "../src/misses.js";

// NO NETWORK: every call goes through an injected fetch.
const ENV = { MEMD_JEV: "on", TYPESAFE_API_KEY: "test-key" };
type Sent = { url: string; headers: Record<string, string>; body: any; raw: string };

function fakeFetch(reply: (sent: Sent) => any, sink: Sent[] = []): FetchLike {
  return async (url, init) => {
    const sent = { url, headers: init.headers, body: JSON.parse(init.body), raw: init.body };
    sink.push(sent);
    const r = reply(sent);
    return r;
  };
}
const ok = (answers: any, model = JEV_MODEL) => () => ({ ok: true, status: 200, json: async () => ({ answers, model }) });

describe("off switch", () => {
  it("MEMD_JEV=0 disables, no key disables, on + key enables — and says which", () => {
    expect(jevStatus({ MEMD_JEV: "0", TYPESAFE_API_KEY: "k" })).toEqual({ enabled: false, reason: "disabled (MEMD_JEV=0)" });
    expect(jevStatus({ MEMD_JEV: "on" }).reason).toMatch(/no TYPESAFE_API_KEY/);
    expect(jevStatus(ENV)).toEqual({ enabled: true, reason: `enabled (${JEV_MODEL})` });
  });

  // "false", "off", "no", "OFF" all used to leave Jev ENABLED.
  for (const v of ["0", "false", "off", "no", "disabled", "OFF", " Off ", "FALSE"]) {
    it(`MEMD_JEV=${JSON.stringify(v)} is OFF`, () => {
      const st = jevStatus({ MEMD_JEV: v, TYPESAFE_API_KEY: "k" });
      expect(st.enabled).toBe(false);
      expect(st.reason).toBe(`disabled (MEMD_JEV=${v})`); // recognised as OFF, not merely unrecognised
    });
  }
  for (const v of ["2", "nope", "enable", "y"]) {
    it(`an unrecognised MEMD_JEV=${JSON.stringify(v)} fails toward OFF and says so`, () => {
      const s = jevStatus({ MEMD_JEV: v, TYPESAFE_API_KEY: "k" });
      expect(s.enabled).toBe(false);
      expect(s.reason).toMatch(/unrecognised MEMD_JEV value/);
    });
  }
  // An inherited key alone must not open the egress path.
  for (const v of [undefined, "", "  "]) {
    it(`MEMD_JEV=${JSON.stringify(v)} with a key is OFF (opt-in) and says how to enable`, () => {
      const s = jevStatus({ MEMD_JEV: v, TYPESAFE_API_KEY: "synthetic" });
      expect(s.enabled).toBe(false);
      expect(s.reason).toBe("disabled (opt-in: set MEMD_JEV=on and TYPESAFE_API_KEY)");
    });
  }
  it("an inherited key alone never reaches fetch", async () => {
    let called = 0;
    const f: FetchLike = async () => {
      called++;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    expect(await askJev({ q: "x" }, {}, { fetch: f, env: { TYPESAFE_API_KEY: "synthetic" } })).toBeUndefined();
    expect(called).toBe(0);
  });
  for (const v of ["1", "true", "on", "yes", "YES"]) {
    it(`MEMD_JEV=${JSON.stringify(v)} with a key is ON`, () => {
      expect(jevStatus({ MEMD_JEV: v, TYPESAFE_API_KEY: "k" }).enabled).toBe(true);
    });
  }

  it("a disabled client never calls fetch", async () => {
    const sink: Sent[] = [];
    const f = fakeFetch(ok({}), sink);
    expect(await askJev({ q: "x" }, {}, { fetch: f, env: { MEMD_JEV: "0", TYPESAFE_API_KEY: "k" } })).toBeUndefined();
    expect(await askJev({ q: "x" }, {}, { fetch: f, env: {} })).toBeUndefined();
    expect(sink).toHaveLength(0);
  });
});

describe("outbound scrub — one choke point", () => {
  it("no secret-shaped string in ANY field reaches the request body", async () => {
    const sink: Sent[] = [];
    const secrets = ["hunter2hunter2", "sk-proj4f9Qz8LmN2pR7sT1vW3xY5zA6bC8dE0fG", "tok_live_9f8e7d6c5b4a", "AKIAABCDEFGHIJKLMNOP"];
    // State avoids the sensitive-topic words (those skip the request entirely,
    // tested below); secret VALUES here are keyed by non-sensitive key shapes.
    await askJev(
      {
        query: "why does api_key=hunter2hunter2 fail",
        results: ["config had sk-proj4f9Qz8LmN2pR7sT1vW3xY5zA6bC8dE0fG in it", { nested: ["the github token is tok_live_9f8e7d6c5b4a"] }],
      },
      {
        q1: { type: "noul", instructions: "Is AKIAABCDEFGHIJKLMNOP mentioned?", criteria: { true: "api_key=hunter2hunter2 seen", false: "no" } },
        q2: { type: "choice", instructions: "pick", criteria: { a: "token is tok_live_9f8e7d6c5b4a", b: "other" } },
        q3: { type: "score", instructions: "rate", criteria: ["low", "api_key=hunter2hunter2 high"] },
      },
      { fetch: fakeFetch(ok({}), sink), env: ENV }
    );
    expect(sink).toHaveLength(1);
    const raw = sink[0].raw.toLowerCase();
    for (const s of secrets) expect(raw).not.toContain(s.toLowerCase());
    expect(raw).toContain("[redacted:");
    expect(sink[0].body.model).toBe("jev-1.13.0"); // pinned, never the alias
    expect(sink[0].body.questions.q2.criteria).toHaveProperty("a"); // keys survive the scrub
    expect(sink[0].headers.Authorization).toBe("Bearer test-key");
  });
});

describe("sensitive-topic skip (the default list)", () => {
  it("a state touching any listed topic sends NO request, and is counted", async () => {
    const samples = ["my medical results", "the 2024 tax return", "W2 from work", "w-2", "form 1099", "SSN digits", "router passwords", "AWS credentials", "a secret plan", "the .env file", "bank statement", "routing number", "HIPAA form"];
    expect(samples.length).toBeGreaterThanOrEqual(SENSITIVE_TERMS.length);
    for (const text of samples) {
      const sink: Sent[] = [];
      const before = jevSkippedSensitive();
      const r = await askJev({ query: "q", results: [{ nested: [text] }] }, { a: { type: "noul", instructions: "x" } }, { fetch: fakeFetch(ok({}), sink), env: ENV });
      expect(r, text).toBeUndefined();
      expect(sink, text).toHaveLength(0);
      expect(jevSkippedSensitive(), text).toBe(before + 1);
    }
  });

  it("ordinary text still goes out; the words are matched at a word start, not inside words", async () => {
    const sink: Sent[] = [];
    await askJev({ query: "syntax of the embankment routine", results: ["unrelated"] }, {}, { fetch: fakeFetch(ok({}), sink), env: ENV });
    expect(sink).toHaveLength(1);
  });

  it("question wording (ours) is not checked, only state", async () => {
    const sink: Sent[] = [];
    await askJev({ query: "release posture" }, { a: { type: "noul", instructions: "Does it mention a secret?" } }, { fetch: fakeFetch(ok({}), sink), env: ENV });
    expect(sink).toHaveLength(1);
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});

describe("never throws; every failure is 'no signal'", () => {
  const cases: [string, FetchLike][] = [
    // Error statuses carry an answers-shaped body so the status check, not
    // the shape check, is what has to reject them.
    ["429", async () => ({ ok: false, status: 429, json: async () => ({ answers: { a: { noul: 0.9 } } }) })],
    ["500", async () => ({ ok: false, status: 500, json: async () => ({ answers: { a: { noul: 0.9 } } }) })],
    ["network error", async () => { throw new Error("ECONNRESET"); }],
    ["bad json", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("x"); } })],
    ["no answers", async () => ({ ok: true, status: 200, json: async () => ({ error: "nope" }) })],
  ];
  for (const [name, f] of cases) {
    it(`${name} -> undefined`, async () => {
      await expect(askJev({}, {}, { fetch: f, env: ENV })).resolves.toBeUndefined();
    });
  }

  it("times out: a hung request resolves undefined at the deadline", async () => {
    const hang: FetchLike = (_u, init) =>
      new Promise((_res, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    const t0 = Date.now();
    await expect(askJev({}, {}, { fetch: hang, env: ENV, timeoutMs: 80 })).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("the miss judge", () => {
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-jev-")));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const call = (query: string, n: number, extra: Partial<SearchCall> = {}): SearchCall => ({
    query,
    hits: Array.from({ length: n }, (_, i) => `episode:${i + 1}`),
    texts: Array.from({ length: n }, (_, i) => `HIT-TEXT-${i} `.repeat(200)),
    ...extra,
  });
  const judgeOf = (noul: number | undefined): MissJudge => async () => (noul === undefined ? undefined : { noul, model: "jev-1.13.0" });

  it("asks the measured question over the top 5 hits, each truncated", async () => {
    const sink: Sent[] = [];
    const v = await jevMissJudge({ fetch: fakeFetch(ok({ answers: { noul: 0.12 } }), sink), env: ENV })(call("q", 8));
    expect(v).toEqual({ noul: 0.12, model: JEV_MODEL });
    const b = sink[0].body;
    expect(b.questions.answers.type).toBe("noul");
    expect(b.questions.answers.instructions).toBe("Do `results` contain the information that `query` is asking for?");
    expect(b.questions.answers.criteria.false).toMatch(/or results is empty/);
    expect(b.state.results).toHaveLength(5);
    expect(b.state.results.every((r: string) => r.length <= 600)).toBe(true);
  });

  it("returns no signal when Jev gives none", async () => {
    const v = await jevMissJudge({ fetch: fakeFetch(ok({ other: {} })), env: ENV })(call("q", 3));
    expect(v).toBeUndefined();
  });

  it("creates a record the tripwires missed, tagged judged_miss with noul + model", async () => {
    const rec = await new MissTracker({ root }).observeJudged(call("healthy looking query", 8), judgeOf(0.1));
    expect(rec?.reasons).toEqual(["judged_miss"]);
    expect(rec?.jev).toEqual({ noul: 0.1, model: "jev-1.13.0" });
  });

  it("does not flag at or above the threshold", async () => {
    expect(await new MissTracker({ root }).observeJudged(call("q ok", 8), judgeOf(0.35))).toBeUndefined();
  });

  it("never removes or downgrades a tripwire: 'zero' stays even when the judge says answered", async () => {
    const rec = await new MissTracker({ root }).observeJudged(call("q", 0), judgeOf(0.99));
    expect(rec?.reasons).toEqual(["zero"]);
    expect(rec?.jev?.noul).toBe(0.99);
  });

  it("a failed or throwing judge leaves exactly the tripwire record", async () => {
    const a = await new MissTracker({ root }).observeJudged(call("q", 1), judgeOf(undefined));
    expect(a?.reasons).toEqual(["thin"]);
    expect(a?.jev).toBeUndefined();
    const b = await new MissTracker({ root }).observeJudged(call("q", 1), async () => { throw new Error("boom"); });
    expect(b?.reasons).toEqual(["thin"]);
    expect(await new MissTracker({ root }).observeJudged(call("q ok", 8), judgeOf(undefined))).toBeUndefined();
  });

  it("writes the tripwire record BEFORE the judge answers (a dying process keeps it)", async () => {
    const t = new MissTracker({ root });
    let release!: (v: any) => void;
    const pending = t.observeJudged(call("q", 0), () => new Promise((r) => (release = r)));
    const onDisk = readMisses({ root });
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0].reasons).toEqual(["zero"]);
    expect(onDisk[0].jev).toBeUndefined();
    release({ noul: 0.02, model: "jev-1.13.0" });
    await pending;
  });

  it("the judge APPENDS a line under the same id, and readMisses merges it", async () => {
    const t = new MissTracker({ root });
    const rec = await t.observeJudged(call("q", 1), judgeOf(0.1));
    const lines = fs.readFileSync(missLogPath(root), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ id: lines[0].id, judge: true, jev: { noul: 0.1 }, reasons: ["judged_miss"] });
    const merged = readMisses({ root });
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: rec!.id, reasons: ["thin", "judged_miss"], jev: { noul: 0.1, model: "jev-1.13.0" } });
  });

  it("an answered verdict annotates without adding judged_miss", async () => {
    await new MissTracker({ root }).observeJudged(call("q", 0), judgeOf(0.99));
    const [r] = readMisses({ root });
    expect(r.reasons).toEqual(["zero"]);
    expect(r.jev?.noul).toBe(0.99);
  });

  it("caps in-flight judges at 4: the 5th search skips the judge but keeps its tripwire record", async () => {
    const t = new MissTracker({ root });
    let calls = 0;
    const releases: (() => void)[] = [];
    const slow: MissJudge = () => { calls++; return new Promise((r) => releases.push(() => r(undefined))); };
    const runs = [0, 1, 2, 3, 4].map((i) => t.observeJudged(call(`q${i} zz${i}`, 0, { at: i * 600_000 }), slow));
    expect(calls).toBe(4);
    expect(readMisses({ root })).toHaveLength(5);
    releases.forEach((r) => r());
    await Promise.all(runs);
    // Slots free again once the judges settle.
    let freed = false;
    await t.observeJudged(call("again", 0, { at: 9e9 }), async () => { freed = true; return undefined; });
    expect(freed).toBe(true);
  });

  it("drops a judge line whose record rotated away", () => {
    fs.writeFileSync(missLogPath(root), JSON.stringify({ id: "gone", judge: true, jev: { noul: 0.1, model: "m" }, reasons: ["judged_miss"] }) + "\n");
    expect(readMisses({ root })).toEqual([]);
  });

  it("never writes hit text to the log", async () => {
    await new MissTracker({ root }).observeJudged(call("q", 1), judgeOf(0.1));
    expect(fs.readFileSync(missLogPath(root), "utf8")).not.toContain("HIT-TEXT");
  });

  it("advances requery state before awaiting the judge", async () => {
    const t = new MissTracker({ root });
    let release!: () => void;
    const slow: MissJudge = () => new Promise((r) => (release = () => r(undefined)));
    const first = t.observeJudged(call("staging deploy manual ruling", 8, { at: 1000 }), slow);
    const second = t.observe(call("staging deploy approval", 8, { at: 5000 }));
    expect(second?.reasons).toEqual(["requery"]);
    release();
    await first;
  });

  it("stays off the response path: recordSearch returns at once while the judge is still running", async () => {
    const t = new MissTracker({ root });
    let settled = false;
    const slow: MissJudge = () => new Promise((r) => setTimeout(() => { settled = true; r({ noul: 0.05, model: "m" }); }, 150));
    const t0 = performance.now();
    recordSearch(t, call("slow judge", 8), slow);
    expect(performance.now() - t0).toBeLessThan(5);
    // Event loop is free while the judge is in flight: a timer fires on schedule.
    const lag = await new Promise<number>((r) => { const s = performance.now(); setTimeout(() => r(performance.now() - s - 20), 20); });
    expect(lag).toBeLessThan(50);
    expect(settled).toBe(false);
    await new Promise((r) => setTimeout(r, 250));
    expect(readMisses({ root })[0].reasons).toEqual(["judged_miss"]);
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});
