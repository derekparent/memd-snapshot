import { describe, expect, it } from "vitest";
import { conflictWarnings } from "../src/facts.js";
import { FetchLike } from "../src/jev.js";

// NO NETWORK: injected fetch only.
const ENV = { MEMD_JEV: "on", TYPESAFE_API_KEY: "k" };
function fetchReturning(answers: Record<string, { noul: number }>, sink: any[] = []): FetchLike {
  return async (_u, init) => {
    sink.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ answers, model: "jev-1.13.0" }) };
  };
}
const N = [
  { id: 12, content: "Backups are copied to the NAS nightly." },
  { id: 30, content: "Nightly index tick runs at 04:30 via launchd." },
];
const NEW = "Backups are NEVER copied off the machine.";

describe("mem_save conflict check", () => {
  it("asks same_subject + both_true for every neighbour in ONE request, with the measured wording", async () => {
    const sink: any[] = [];
    await conflictWarnings(NEW, N, { fetch: fetchReturning({}, sink), env: ENV });
    expect(sink).toHaveLength(1);
    const q = sink[0].questions;
    expect(Object.keys(q).sort()).toEqual(["both_f12", "both_f30", "same_f12", "same_f30"]);
    expect(q.same_f12.instructions).toBe("Are `new_fact` and `existing.f12` about the same subject?");
    expect(q.both_f12.instructions).toBe("Can `existing.f12` and `new_fact` both be true at the same moment in time?");
    expect(sink[0].state).toEqual({ new_fact: NEW, existing: { f12: N[0].content, f30: N[1].content } });
  });

  it("warns only on same subject AND cannot both be true", async () => {
    const w = await conflictWarnings(NEW, N, {
      fetch: fetchReturning({ same_f12: { noul: 0.9 }, both_f12: { noul: 0.1 }, same_f30: { noul: 0.03 }, both_f30: { noul: 0.1 } }),
      env: ENV,
    });
    expect(w).toHaveLength(1);
    expect(w[0]).toBe("fact #12 appears to conflict — if this replaces it use mem_supersede.");
  });

  it("no warning when compatible, or when the subjects differ", async () => {
    const compat = await conflictWarnings(NEW, N, {
      fetch: fetchReturning({ same_f12: { noul: 0.9 }, both_f12: { noul: 0.85 }, same_f30: { noul: 0.02 }, both_f30: { noul: 0.02 } }),
      env: ENV,
    });
    expect(compat).toEqual([]);
  });

  it("thresholds are inclusive at 0.5 for same_subject and exclusive at 0.5 for both_true", async () => {
    const edge = (same: number, both: number) =>
      conflictWarnings(NEW, [N[0]], { fetch: fetchReturning({ same_f12: { noul: same }, both_f12: { noul: both } }), env: ENV });
    expect(await edge(0.5, 0.49)).toHaveLength(1);
    expect(await edge(0.49, 0.1)).toHaveLength(0);
    expect(await edge(0.9, 0.5)).toHaveLength(0);
  });

  it("no neighbours, Jev disabled, or no signal -> no warnings and no request", async () => {
    const sink: any[] = [];
    expect(await conflictWarnings(NEW, [], { fetch: fetchReturning({}, sink), env: ENV })).toEqual([]);
    expect(await conflictWarnings(NEW, N, { fetch: fetchReturning({}, sink), env: { MEMD_JEV: "0", TYPESAFE_API_KEY: "k" } })).toEqual([]);
    expect(sink).toHaveLength(0);
    const fail: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    expect(await conflictWarnings(NEW, N, { fetch: fail, env: ENV })).toEqual([]);
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});
