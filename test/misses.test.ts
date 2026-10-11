// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MissTracker, missLogPath, readMisses, recordSearch, redactQuery, SearchCall } from "../src/misses.js";

let root: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-miss-")));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const T0 = Date.parse("2026-09-21T12:00:00Z");
const call = (query: string, n: number, extra: Partial<SearchCall> = {}): SearchCall => ({
  query,
  hits: Array.from({ length: n }, (_, i) => `episode:${i + 1}`),
  at: T0,
  ...extra,
});
const tick = () => new Promise((r) => setImmediate(r));

describe("zero / thin tripwires", () => {
  it("logs a zero-result search", () => {
    const t = new MissTracker({ root });
    expect(t.observe(call("lab-printer toner reorder", 0))?.reasons).toEqual(["zero"]);
    expect(readMisses({ root })).toHaveLength(1);
  });

  it("logs a thin result, and not a full one", () => {
    const t = new MissTracker({ root });
    expect(t.observe(call("alpha", 2))?.reasons).toEqual(["thin"]);
    expect(t.observe(call("bravo", 3, { at: T0 + 10 * 60_000 }))).toBeUndefined();
  });

  it("judges thin against the caller's own limit", () => {
    // Asked for 2, got 2: that is a complete answer, not a thin one.
    const t = new MissTracker({ root });
    expect(t.observe(call("alpha", 2, { limit: 2 }))).toBeUndefined();
  });

  it("writes nothing for a healthy search", () => {
    new MissTracker({ root }).observe(call("healthy query", 8));
    expect(fs.existsSync(missLogPath(root))).toBe(false);
  });
});

describe("requery tripwire", () => {
  const later = (s: number) => T0 + s * 1000;

  it("flags a reworded retry inside the window and records the earlier query", () => {
    const t = new MissTracker({ root });
    t.observe(call("staging deploy manual ruling", 8));
    const rec = t.observe(call("does staging still need a manual approval before deploy", 8, { at: later(30) }));
    expect(rec?.reasons).toEqual(["requery"]);
    expect(rec?.prev_query).toBe("staging deploy manual ruling");
    expect(rec?.gap_s).toBe(30);
  });

  it("flags the unscoped retry: same words, filter changed", () => {
    const t = new MissTracker({ root });
    t.observe(call("jev evaluation", 8, { project: "memd" }));
    const rec = t.observe(call("jev evaluation", 8, { at: later(10) }));
    expect(rec?.reasons).toEqual(["requery"]);
    expect(rec?.filters_changed).toBe(true);
    expect(rec?.shared).toBeUndefined();
  });

  it("records the shared words that tied a reworded retry", () => {
    const t = new MissTracker({ root });
    t.observe(call("staging deploy manual ruling", 8));
    const rec = t.observe(call("staging deploy approval", 8, { at: later(5) }));
    expect(rec?.shared?.sort()).toEqual(["deploy", "staging"]);
    expect(rec?.filters_changed).toBeUndefined();
  });

  it("does not treat a shared repo name as a retry (single-repo session sweep)", () => {
    // Without the repo-name exclusion, this sweep logged spurious requery
    // records where every "shared" word was just the repo name.
    const t = new MissTracker({ root, projects: () => ["memd", "FieldApp-ios"] });
    t.observe(call("memd backup", 10));
    expect(t.observe(call("memd embed lock", 10, { at: later(30) }))).toBeUndefined();
    expect(t.observe(call("memd vacuum into", 10, { at: later(60) }))).toBeUndefined();
    // A hyphenated repo name is excluded by its segments too.
    t.observe(call("fieldapp testflight build", 10, { at: later(200) }));
    expect(t.observe(call("fieldapp notices feed dead", 10, { at: later(230) }))).toBeUndefined();
  });

  it("excludes the call's own project filter even when it is not a known project", () => {
    const t = new MissTracker({ root, projects: () => [] });
    t.observe(call("orchard plan wizard", 10, { project: "orchard" }));
    expect(t.observe(call("orchard expense edit", 10, { project: "orchard", at: later(5) }))).toBeUndefined();
  });

  it("still flags a retry that shares a real word besides the repo name", () => {
    const t = new MissTracker({ root, projects: () => ["memd"] });
    t.observe(call("memd backup retention", 10));
    const rec = t.observe(call("memd backup schedule weekly", 10, { at: later(20) }));
    expect(rec?.shared).toEqual(["backup"]);
  });

  it("does not flag an unrelated back-to-back search", () => {
    const t = new MissTracker({ root });
    t.observe(call("sqlite vacuum backup", 8));
    expect(t.observe(call("terminal multiplexer pane status", 8, { at: later(5) }))).toBeUndefined();
  });

  it("does not flag an identical repeat with the same filters", () => {
    const t = new MissTracker({ root });
    t.observe(call("jev evaluation", 8, { project: "memd" }));
    expect(t.observe(call("Jev evaluation", 8, { project: "MEMD", at: later(5) }))).toBeUndefined();
  });

  it("does not flag a reworded query outside the window", () => {
    const t = new MissTracker({ root, windowS: 120 });
    t.observe(call("staging deploy manual ruling", 8));
    expect(t.observe(call("staging deploy approval", 8, { at: later(121) }))).toBeUndefined();
  });

  it("combines with zero on the same call", () => {
    const t = new MissTracker({ root });
    t.observe(call("staging deploy manual", 1));
    expect(t.observe(call("staging deploy approval", 0, { at: later(5) }))?.reasons).toEqual(["zero", "requery"]);
  });
});

describe("redaction on disk", () => {
  it("never writes a secret-shaped query in clear", () => {
    const t = new MissTracker({ root });
    const secret = "sk-proj4f9Qz8LmN2pR7sT1vW3xY5zA6bC8dE0fG";
    // Query text gets exactly the ingest ruleset: a config-shaped line (key at
    // line start) and a token-shaped key. A key mid-sentence is prose to
    // redact() by design (its false-positive defense) and stays out of scope.
    t.observe(call(`password: hunter2hunter2\nwhy does ${secret} fail`, 0));
    t.observe(call(`password: hunter2hunter2\nretry ${secret} fail`, 0, { at: T0 + 5000 }));
    const disk = fs.readFileSync(missLogPath(root), "utf8");
    expect(disk).not.toContain("hunter2hunter2");
    expect(disk).not.toContain(secret);
    // shared words are lowercased, so a leak there would not match the
    // original casing — check case-folded.
    expect(disk.toLowerCase()).not.toContain(secret.toLowerCase());
    expect(disk).toContain("[REDACTED:");
    // The requery record's prev_query is the other path a secret could leak by.
    const recs = readMisses({ root });
    expect(recs[0].prev_query).toBeDefined();
    expect(recs[0].prev_query).not.toContain("hunter2hunter2");
  });
});

describe("strict query redaction", () => {
  // All three used to reach disk in clear, because the ingest key-value rule
  // is anchored to config position and skips prose.
  const PROSE = [
    ["why does password: hunter2secret fail on the router", "hunter2secret"],
    ["api_key=abcd1234efgh5678ijkl in env", "abcd1234efgh5678ijkl"],
    ["my password is hunter2secret what uses it", "hunter2secret"],
    ['the client_secret => "two words" leaked', "two words"],
    // Bare token/passphrase were not keys.
    ["the github token is tok_live_9f8e7d6c5b4a", "tok_live_9f8e7d6c5b4a"],
    ["token=tok_live_1a2b3c4d5e6f in the env", "tok_live_1a2b3c4d5e6f"],
    ["vault passphrase: correcthorsebattery", "correcthorsebattery"],
  ] as const;

  it("redacts prose-shaped secrets in query, prev_query and shared words on disk", () => {
    const t = new MissTracker({ root });
    // Each query then a reworded retry of it, so every secret also rides the
    // requery record's prev_query and shared-words paths.
    PROSE.forEach(([q], i) => {
      t.observe(call(q, 0, { at: T0 + i * 600_000 }));
      t.observe(call(`${q} retried`, 0, { at: T0 + i * 600_000 + 5000 }));
    });
    const disk = fs.readFileSync(missLogPath(root), "utf8");
    for (const [, secret] of PROSE) expect(disk.toLowerCase()).not.toContain(secret.toLowerCase());
    const retries = readMisses({ root }).filter((r) => r.reasons.includes("requery"));
    expect(retries).toHaveLength(PROSE.length);
    for (const r of retries) {
      expect(r.prev_query).toContain("[REDACTED:SECRET_VALUE]");
      expect(r.shared?.join(" ")).not.toMatch(/redacted|secret_value/);
    }
  });

  it("is idempotent on its own output (bracket-accretion tripwire)", () => {
    for (const [q] of PROSE) {
      const once = redactQuery(q);
      let many = once;
      for (let i = 0; i < 5; i++) many = redactQuery(many);
      expect(many).toBe(once);
    }
  });

  it("leaves ordinary queries alone", () => {
    for (const q of ["memd backup retention", "how does the password reset flow work", "api keys rotation policy", "token budget for search", "how many tokens does it use", "passphrase rotation policy"]) {
      expect(redactQuery(q)).toBe(q);
    }
  });
});

describe("bounded log", () => {
  it("rotates to one generation and reads back newest first across both", () => {
    const t = new MissTracker({ root, maxBytes: 400 });
    for (let i = 0; i < 12; i++) t.observe(call(`query number ${i} zzq${i}`, 0, { at: T0 + i * 600_000 }));
    expect(fs.existsSync(missLogPath(root) + ".1")).toBe(true);
    expect(fs.existsSync(missLogPath(root) + ".2")).toBe(false);
    const size = fs.statSync(missLogPath(root)).size + fs.statSync(missLogPath(root) + ".1").size;
    expect(size).toBeLessThan(2 * 400 + 600); // two generations plus at most one record's overshoot each
    const recs = readMisses({ root });
    expect(recs[0].query).toContain("zzq11");
    const times = recs.map((r) => r.ts);
    expect([...times].sort().reverse()).toEqual(times);
  });
});

describe("recordSearch — the only thing the search path calls", () => {
  it("is deferred: nothing is written until the response has gone", async () => {
    const t = new MissTracker({ root });
    recordSearch(t, call("deferred zero", 0));
    expect(fs.existsSync(missLogPath(root))).toBe(false);
    await tick();
    expect(readMisses({ root })).toHaveLength(1);
  });

  it("swallows a failing log instead of throwing into search", async () => {
    // A FILE where the log directory should be: every write must fail.
    const blocker = path.join(root, "blocked");
    fs.writeFileSync(blocker, "");
    const t = new MissTracker({ root: blocker });
    expect(() => t.observe(call("x zero", 0))).toThrow(); // the failure is real...
    expect(() => recordSearch(t, call("y zero", 0))).not.toThrow();
    await tick(); // ...and an uncaught throw here would fail the test run
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});
