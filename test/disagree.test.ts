import { describe, expect, it } from "vitest";
import { bannerTriggered, staleRulingNote } from "../src/disagree.js";
import { FetchLike } from "../src/jev.js";
import type { SearchHit } from "../src/search.js";

// NO NETWORK: injected fetch only.
const ENV = { MEMD_JEV: "on", TYPESAFE_API_KEY: "k" };
const hit = (id: number, day: string, text: string, extra: Partial<SearchHit> = {}): SearchHit => ({
  source: "fact", kind: "fact", id, project: "relay", ts: `2026-${day}T00:00:00Z`, importance: 5, score: 1, text, ...extra,
});
const ep = (id: number, day: string, text: string) => hit(id, day, text, { source: "episode", kind: "text" });
type A = Record<string, { score?: number; choice?: string; confidence?: number }>;
function jev(answers: A, sink: any[] = []): FetchLike {
  return async (_u, init) => {
    sink.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ answers, model: "jev-1.13.0" }) };
  };
}
const Q = "does staging still need the operator's approval before merging?";
// Deliberately NOT in date order: p0 is the newest, p2 the oldest.
const HITS = [hit(3, "07-22", "no repo keeps an approval"), hit(2, "07-17", "billing keeps the approval"), hit(1, "07-06", "approval everywhere"), hit(9, "08-01", "unrelated noise")];
const onTopic = { rel_p0: { score: 2 }, rel_p1: { score: 1.9 }, rel_p2: { score: 1.8 }, rel_p3: { score: 0.2 } };
const note = (answers: A, hits = HITS, query = Q) => staleRulingNote(query, hits, { fetch: jev(answers), env: ENV });

describe("trigger", () => {
  it("fires on ruling-shaped queries, or a kind-'ruling' fact in the top passages — not on decisions or constraints", () => {
    expect(bannerTriggered("what is the current release posture", [])).toBe(true);
    expect(bannerTriggered("sqlite vacuum", [hit(1, "07-01", "x", { kind: "ruling" })])).toBe(true);
    // decision|constraint would fire on a majority of all searches — too broad.
    expect(bannerTriggered("sqlite vacuum", [hit(1, "07-01", "x", { kind: "constraint" })])).toBe(false);
    expect(bannerTriggered("sqlite vacuum", [hit(1, "07-01", "x", { kind: "decision" })])).toBe(false);
    expect(bannerTriggered("sqlite vacuum", [hit(1, "07-01", "x"), ep(2, "07-01", "y")])).toBe(false);
    // Only a ruling within the top passages counts.
    const deep = [...Array(6).fill(0).map((_, i) => hit(i, "07-01", `f${i}`)), hit(9, "07-01", "r", { kind: "ruling" })];
    expect(bannerTriggered("sqlite vacuum", deep)).toBe(false);
  });

  it("no trigger, no request", async () => {
    const sink: any[] = [];
    expect(await staleRulingNote("sqlite vacuum", HITS, { fetch: jev({}, sink), env: ENV })).toBeUndefined();
    expect(sink).toHaveLength(0);
  });
});

describe("one request, generic questions", () => {
  it("asks a relevance Score per passage and a pairwise Choice for every pair, in ONE request", async () => {
    const sink: any[] = [];
    await staleRulingNote(Q, HITS, { fetch: jev({}, sink), env: ENV });
    expect(sink).toHaveLength(1);
    const keys = Object.keys(sink[0].questions);
    expect(keys.filter((k) => k.startsWith("rel_"))).toHaveLength(4);
    expect(keys.filter((k) => k.startsWith("pair_"))).toHaveLength(6); // C(4,2)
    expect(Object.keys(sink[0].questions.pair_p0_p1.criteria)).toEqual(["same_position", "conflicting", "one_silent"]);
  });

  it("caps at the top 6 passages", async () => {
    const sink: any[] = [];
    const many = Array.from({ length: 9 }, (_, i) => hit(i, "07-0" + (i + 1), `t${i}`));
    await staleRulingNote(Q, many, { fetch: jev({}, sink), env: ENV });
    expect(Object.keys(sink[0].state.passages)).toHaveLength(6);
  });
});

describe("the verdict, decided in code", () => {
  it("names the NEWEST on-topic passage by date (not rank) and the older conflicting ones", async () => {
    const n = await note({
      ...onTopic,
      pair_p0_p1: { choice: "conflicting", confidence: 0.9 },
      pair_p0_p2: { choice: "conflicting", confidence: 0.95 },
    });
    expect(n).toMatch(/newest on-topic CURRENT passage \(2026-07-22, relay, fact #3\) begins: "no repo keeps an approval"/);
    expect(n).toMatch(/2 other passages state a conflicting position \(2026-07-17, relay, fact #2; 2026-07-06, relay, fact #1\)/);
  });

  it("picks the reference by DATE even when the top-ranked passage is the oldest", async () => {
    // Search ranks by similarity: the stale 07-06 ruling can come first.
    const ranked = [hit(1, "07-06", "approval everywhere"), hit(3, "07-22", "no repo keeps an approval")];
    const n = await note({ rel_p0: { score: 2 }, rel_p1: { score: 2 }, pair_p0_p1: { choice: "conflicting", confidence: 0.9 } }, ranked);
    expect(n).toMatch(/newest on-topic CURRENT passage \(2026-07-22, relay, fact #3\)/);
    expect(n).toMatch(/1 other passage states a conflicting position \(2026-07-06, relay, fact #1\)/);
  });

  it("ignores off-topic passages even when they are newest", async () => {
    // p3 (08-01) is newest overall but scored off-topic; the reference stays p0 (07-22).
    const n = await note({ ...onTopic, pair_p0_p2: { choice: "conflicting", confidence: 0.9 }, pair_p2_p3: { choice: "conflicting", confidence: 0.99 } });
    expect(n).toMatch(/\(2026-07-22, relay, fact #3\)/);
    expect(n).not.toMatch(/fact #9/);
  });

  it("no note when the on-topic passages agree or one is silent", async () => {
    expect(await note({ ...onTopic, pair_p0_p1: { choice: "same_position", confidence: 0.9 }, pair_p0_p2: { choice: "one_silent", confidence: 0.9 } })).toBeUndefined();
  });

  it("no note on a low-confidence conflict", async () => {
    expect(await note({ ...onTopic, pair_p0_p1: { choice: "conflicting", confidence: 0.59 } })).toBeUndefined();
  });

  it("a conflict among OLDER passages only is not a stale-ruling signal", async () => {
    expect(await note({ ...onTopic, pair_p1_p2: { choice: "conflicting", confidence: 0.99 } })).toBeUndefined();
  });

  it("no note with fewer than two on-topic passages", async () => {
    expect(await note({ rel_p0: { score: 2 }, rel_p1: { score: 1.2 }, pair_p0_p1: { choice: "conflicting", confidence: 0.99 } })).toBeUndefined();
  });

  it("an equally-dated doc passage is never called stale (chunks of one file share its mtime)", async () => {
    // Two equally-dated FACTS break the tie by id (see "same-millisecond
    // saves"); docs keep the never-stale rule.
    const d = (id: number, text: string, path = "/x/CONTEXT.md") => hit(id, "07-22", text, { source: "doc", kind: undefined, path });
    const answers = { rel_p0: { score: 2 }, rel_p1: { score: 2 }, pair_p0_p1: { choice: "conflicting", confidence: 0.99 } };
    expect(await note(answers, [d(1, "a"), d(2, "b")])).toBeUndefined();
    expect(await note(answers, [d(2, "b"), d(1, "a")])).toBeUndefined();
    expect(await note(answers, [d(1, "a"), d(2, "b", "/y/DECISIONS.md")])).toBeUndefined();
  });
});

describe("episodes: said, not decided", () => {
  // A 2026-07-26 tool_result can quote a stale 07-17 MEMORY line: dated
  // newest, content stale.
  const Q2 = "does staging still need the operator's approval before merging?";
  const mixed = [ep(26, "07-26", "billing-api KEEPS the manual approval"), hit(22, "07-22", "no repo keeps an approval")];

  it("a newer EPISODE is never the reference; the CURRENT fact is, and the episode is flagged", async () => {
    const n = await note({ rel_p0: { score: 2 }, rel_p1: { score: 2 }, pair_p0_p1: { choice: "conflicting", confidence: 0.95 } }, mixed, Q2);
    expect(n).toMatch(/newest on-topic CURRENT passage \(2026-07-22, relay, fact #22\) begins: "no repo keeps an approval"/);
    expect(n).toMatch(/1 other passage states a conflicting position \(2026-07-26, relay, episode #26\)/);
  });

  it("episodes only: a NEUTRAL note — no winner, no 'superseded', no 'begins'", async () => {
    const eps = [ep(1, "07-26", "billing keeps the approval"), ep(2, "07-06", "approval everywhere"), ep(3, "07-10", "unrelated")];
    const n = await note({ rel_p0: { score: 2 }, rel_p1: { score: 2 }, rel_p2: { score: 0.1 }, pair_p0_p1: { choice: "conflicting", confidence: 0.9 } }, eps, Q2);
    expect(n).toMatch(/every disagreeing passage is a transcript excerpt \(2026-07-26, relay, episode #1; 2026-07-06, relay, episode #2\)/);
    expect(n).toMatch(/Transcript dates are when something was said, not when it was decided/);
    expect(n).not.toMatch(/superseded|begins:|newest/);
  });

  it("episodes only and agreeing: no note", async () => {
    const eps = [ep(1, "07-26", "a"), ep(2, "07-06", "b")];
    expect(await note({ rel_p0: { score: 2 }, rel_p1: { score: 2 }, pair_p0_p1: { choice: "same_position", confidence: 0.9 } }, eps, Q2)).toBeUndefined();
  });

  it("a NEWER current passage than the reference cannot exist; an OLDER-dated conflicting episode is still flagged", async () => {
    const hits = [hit(22, "07-22", "no repo keeps an approval"), ep(5, "07-05", "approval everywhere")];
    const n = await note({ rel_p0: { score: 2 }, rel_p1: { score: 2 }, pair_p0_p1: { choice: "conflicting", confidence: 0.9 } }, hits, Q2);
    expect(n).toMatch(/\(2026-07-05, relay, episode #5\)/);
  });
});

describe("fails silent, bounded", () => {
  it("no signal -> no note (disabled, error status, missing answers)", async () => {
    expect(await staleRulingNote(Q, HITS, { fetch: jev({}), env: { MEMD_JEV: "0", TYPESAFE_API_KEY: "k" } })).toBeUndefined();
    expect(await staleRulingNote(Q, HITS, { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }), env: ENV })).toBeUndefined();
    expect(await note({})).toBeUndefined();
  });

  it("gives up at its own 2 s cap, not the client's 3 s default", async () => {
    const hang: FetchLike = (_u, init) => new Promise((_r, rej) => init.signal.addEventListener("abort", () => rej(new Error("abort"))));
    const t0 = Date.now();
    expect(await staleRulingNote(Q, HITS, { fetch: hang, env: ENV })).toBeUndefined();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(2600);
  }, 5000);
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});

describe("same-millisecond saves", () => {
  // Two saves can land in the same ms and tie on created_at. Before, the
  // first-ranked one became the reference and the other, not strictly older,
  // was never stale: the note stayed silent and named no newest.
  const T = "2026-07-22T10:00:00.123Z";
  const f = (id: number, text: string, extra: Partial<SearchHit> = {}): SearchHit => ({ ...hit(id, "07-22", text), ts: T, ...extra });
  const tied = { rel_p0: { score: 2 }, rel_p1: { score: 2 }, pair_p0_p1: { choice: "conflicting", confidence: 0.9 } };

  it("within one table the higher id is the newer, whichever ranks first", async () => {
    for (const hits of [[f(4, "older wording"), f(7, "newer wording")], [f(7, "newer wording"), f(4, "older wording")]]) {
      const n = await note(tied, hits);
      expect(n).toMatch(/newest on-topic CURRENT passage \(2026-07-22, relay, fact #7\) begins: "newer wording"/);
      expect(n).toMatch(/1 other passage states a conflicting position \(2026-07-22, relay, fact #4\)/);
    }
  });

  it("ids order within a table numerically, not as strings (#10 is newer than #9)", async () => {
    const n = await note(tied, [f(10, "newer wording"), f(9, "older wording")]);
    expect(n).toMatch(/fact #10\) begins: "newer wording"/);
    expect(n).toMatch(/conflicting position \(2026-07-22, relay, fact #9\)/);
  });

  it("a fact and a doc tied to the ms: ids are not comparable across tables, so neither is called superseded", async () => {
    // Doc id both above and below the fact id, in both rank orders.
    for (const docId of [99, 2]) {
      const doc = f(docId, "doc wording", { source: "doc", kind: undefined, path: "/x/CONTEXT.md" });
      for (const hits of [[f(4, "fact wording"), doc], [doc, f(4, "fact wording")]]) {
        expect(await note(tied, hits)).toBeUndefined();
      }
    }
  });

  it("the tie-break picks the same reference in either rank order, so an episode is flagged against the same passage", async () => {
    const answers = {
      rel_p0: { score: 2 }, rel_p1: { score: 2 }, rel_p2: { score: 2 },
      pair_p0_p2: { choice: "conflicting", confidence: 0.9 }, pair_p1_p2: { choice: "conflicting", confidence: 0.9 },
    };
    const a = await note(answers, [f(4, "older wording"), f(7, "newer wording"), ep(50, "07-01", "said once")]);
    const b = await note(answers, [f(7, "newer wording"), f(4, "older wording"), ep(50, "07-01", "said once")]);
    expect(a).toMatch(/fact #7\) begins/);
    expect(b).toMatch(/fact #7\) begins/);
  });
});
