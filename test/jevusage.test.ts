import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FetchLike } from "../src/jev.js";
import { jevMissJudge } from "../src/misses.js";
import { conflictWarnings } from "../src/facts.js";
import { staleRulingNote } from "../src/disagree.js";
import { JEV_USAGE_MAX_BYTES, jevUsageLines, jevUsagePath, readJevUsage, recordJevUsage } from "../src/jevusage.js";

// NO NETWORK: injected fetch only (and the global guard in test/setup).
const ENV = { MEMD_JEV: "on", TYPESAFE_API_KEY: "k" };
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "memd-jevusage-"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const answering = (answers: Record<string, unknown>): FetchLike => async () => ({ ok: true, status: 200, json: async () => ({ answers, model: "jev-1.13.0" }) });
const status = (code: number): FetchLike => async () => ({ ok: false, status: code, json: async () => ({}) });
const throwing: FetchLike = async () => {
  throw new Error("timeout");
};
const o = (fetch: FetchLike, env: Record<string, string | undefined> = ENV) => ({ fetch, env, usageRoot: root });
const counts = () => readJevUsage(root).counts;
const lines = () => fs.readFileSync(jevUsagePath(root), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const RULING_Q = "what is the current release policy";
const hit = (id: number, day: string, text: string) => ({ source: "fact" as const, kind: "ruling", id, project: "p", ts: `2026-${day}T00:00:00Z`, importance: 5, score: 1, text });
const HITS = [hit(2, "07-22", "ship on thursdays"), hit(1, "07-06", "ship on mondays")];
const CONFLICT = { rel_p0: { score: 2 }, rel_p1: { score: 2 }, pair_p0_p1: { choice: "conflicting", confidence: 0.9 } };

describe("each use counts call / fired / skipped_sensitive / error", () => {
  it("miss-judge: a low score is a call that fired; a high score is a call only", async () => {
    // Checked after each call: a pair's total alone cannot tell an inverted threshold apart.
    await jevMissJudge(o(answering({ answers: { noul: 0.9 } })))({ query: "where is the deploy key rotation doc", texts: ["x"] } as any);
    expect(counts()["miss-judge"]).toEqual({ call: 1, fired: 0, skipped_sensitive: 0, error: 0 });
    await jevMissJudge(o(answering({ answers: { noul: 0.1 } })))({ query: "where is the deploy key rotation doc", texts: ["x"] } as any);
    expect(counts()["miss-judge"]).toEqual({ call: 2, fired: 1, skipped_sensitive: 0, error: 0 });
  });

  it("save-conflict: a warning is a call that fired; no warning is a call only", async () => {
    const n = [{ id: 7, content: "deploys freeze fridays at noon" }];
    expect(await conflictWarnings("deploys freeze fridays at five", n, o(answering({ same_f7: { noul: 0.1 }, both_f7: { noul: 0.9 } }))).then((w) => w.length)).toBe(0);
    expect(counts()["save-conflict"]).toEqual({ call: 1, fired: 0, skipped_sensitive: 0, error: 0 });
    expect(await conflictWarnings("deploys freeze fridays at five", n, o(answering({ same_f7: { noul: 0.9 }, both_f7: { noul: 0.1 } }))).then((w) => w.length)).toBe(1);
    expect(counts()["save-conflict"]).toEqual({ call: 2, fired: 1, skipped_sensitive: 0, error: 0 });
  });

  it("disagree-note: a note is a call that fired; no conflict is a call only; an untriggered query is not a call", async () => {
    expect(await staleRulingNote(RULING_Q, HITS, o(answering({ rel_p0: { score: 2 }, rel_p1: { score: 2 } })))).toBeUndefined();
    expect(counts()["disagree-note"]).toEqual({ call: 1, fired: 0, skipped_sensitive: 0, error: 0 });
    expect(await staleRulingNote(RULING_Q, HITS, o(answering(CONFLICT)))).toMatch(/DISAGREE/);
    expect(await staleRulingNote("sqlite vacuum", [hit(1, "07-01", "x")].map((h) => ({ ...h, kind: "fact" })), o(answering(CONFLICT)))).toBeUndefined();
    expect(counts()["disagree-note"]).toEqual({ call: 2, fired: 1, skipped_sensitive: 0, error: 0 });
  });

  it("errors: non-2xx, a throw (timeout) and an unusable body each count as a call and an error", async () => {
    const q = { query: "where is the deploy key rotation doc", texts: ["x"] } as any;
    await jevMissJudge(o(status(429)))(q);
    await jevMissJudge(o(throwing))(q);
    await jevMissJudge(o(async () => ({ ok: true, status: 200, json: async () => ({ nope: 1 }) })))(q);
    expect(counts()["miss-judge"]).toEqual({ call: 3, fired: 0, skipped_sensitive: 0, error: 3 });
  });

  it("a sensitive-topic state is counted as skipped, never as a call", async () => {
    await jevMissJudge(o(answering({ answers: { noul: 0.1 } })))({ query: "what is my ssn on file", texts: [] } as any);
    expect(counts()["miss-judge"]).toEqual({ call: 0, fired: 0, skipped_sensitive: 1, error: 0 });
  });

  it("Jev off: nothing is recorded (no request, no count)", async () => {
    await jevMissJudge(o(answering({ answers: { noul: 0.1 } }), { TYPESAFE_API_KEY: "k" }))({ query: "q", texts: [] } as any);
    expect(fs.existsSync(jevUsagePath(root))).toBe(false);
  });
});

describe("the log holds no text and never changes a result", () => {
  it("a line is exactly {ts, use, event}: the query, the fact text and the answers never appear", async () => {
    await jevMissJudge(o(answering({ answers: { noul: 0.1 } })))({ query: "zzsecretquery about the vault", texts: ["zzsecrethit"] } as any);
    await conflictWarnings("zzsecretfact one", [{ id: 7, content: "zzsecretfact two" }], o(answering({ same_f7: { noul: 0.9 }, both_f7: { noul: 0.1 } })));
    for (const l of lines()) expect(Object.keys(l).sort()).toEqual(["event", "ts", "use"]);
    // the timestamp is left out of the match: "…:20.156Z" has a "0.1" of its own
    expect(lines().map(({ ts: _ts, ...rest }) => JSON.stringify(rest)).join("\n")).not.toMatch(/zzsecret|0\.1|0\.9/);
    expect(fs.readFileSync(jevUsagePath(root), "utf8")).not.toContain("zzsecret");
  });

  it("an unwritable log is swallowed: the note, the warning and the verdict are what they were", async () => {
    const bad = path.join(root, "not-a-dir");
    fs.writeFileSync(bad, "x"); // usageRoot is a FILE, so every append fails
    const ob = (f: FetchLike) => ({ fetch: f, env: ENV, usageRoot: bad });
    const good = (f: FetchLike) => ({ fetch: f, env: ENV, usageRoot: root });
    expect(await staleRulingNote(RULING_Q, HITS, ob(answering(CONFLICT)))).toBe(await staleRulingNote(RULING_Q, HITS, good(answering(CONFLICT))));
    const n = [{ id: 7, content: "a" }];
    const a = { same_f7: { noul: 0.9 }, both_f7: { noul: 0.1 } };
    expect(await conflictWarnings("b", n, ob(answering(a)))).toEqual(await conflictWarnings("b", n, good(answering(a))));
    const q = { query: "where is the doc", texts: ["x"] } as any;
    expect(await jevMissJudge(ob(answering({ answers: { noul: 0.1 } })))(q)).toEqual(await jevMissJudge(good(answering({ answers: { noul: 0.1 } })))(q));
  });
});

describe("the log file", () => {
  it("rotates to .1 past the size cap and the totals span both generations", () => {
    const file = jevUsagePath(root);
    fs.writeFileSync(file, `${JSON.stringify({ ts: "2026-09-01T00:00:00.000Z", use: "miss-judge", event: "call" })}\n`.padEnd(JEV_USAGE_MAX_BYTES, " "));
    recordJevUsage("miss-judge", "call", root);
    expect(fs.existsSync(file + ".1")).toBe(true);
    expect(fs.statSync(file).size).toBeLessThan(200);
    const r = readJevUsage(root);
    expect(r.counts["miss-judge"].call).toBe(2);
    expect(r.since).toBe("2026-09-01T00:00:00.000Z");
  });

  it("a torn line and unknown uses/events are skipped, not fatal", () => {
    fs.writeFileSync(
      jevUsagePath(root),
      [
        JSON.stringify({ ts: "2026-09-02T00:00:00.000Z", use: "save-conflict", event: "fired" }),
        JSON.stringify({ ts: "2026-09-02T00:00:00.000Z", use: "other", event: "call" }),
        JSON.stringify({ ts: "2026-09-02T00:00:00.000Z", use: "save-conflict", event: "boom" }),
        '{"ts":"2026-09-02',
      ].join("\n")
    );
    expect(readJevUsage(root).counts["save-conflict"]).toEqual({ call: 0, fired: 1, skipped_sensitive: 0, error: 0 });
  });

  it("jevUsageLines: none recorded, then one line per use", () => {
    expect(jevUsageLines(root)).toEqual(["jev usage: none recorded"]);
    recordJevUsage("disagree-note", "call", root);
    recordJevUsage("disagree-note", "fired", root);
    const out = jevUsageLines(root);
    expect(out[0]).toMatch(/^jev usage since \d{4}-\d{2}-\d{2} \(calls \/ fired \/ skipped-sensitive \/ errors\):$/);
    expect(out.slice(1)).toEqual(["  miss-judge: 0 / 0 / 0 / 0", "  save-conflict: 0 / 0 / 0 / 0", "  disagree-note: 1 / 1 / 0 / 0"]);
  });

  it("memd stats prints the counters from the log next to the DB", () => {
    const db = path.join(root, "t.db");
    recordJevUsage("save-conflict", "call", root);
    const r = spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), "stats"], {
      env: { ...process.env, MEMD_DB_PATH: db },
      encoding: "utf8",
    });
    expect(r.stdout).toContain("vector search: ");
    expect(r.stdout).toMatch(/jev usage since .*\n  miss-judge: 0 \/ 0 \/ 0 \/ 0\n  save-conflict: 1 \/ 0 \/ 0 \/ 0\n  disagree-note: 0 \/ 0 \/ 0 \/ 0/);
  });
});
