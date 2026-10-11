import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { askJev, JEV_URL } from "../src/jev.js";

/**
 * The global guard in test/setup/no-typesafe.ts. The falsifier is a
 * bare askJev with Jev enabled and NO opts.fetch: before the guard it went
 * to the real network with whatever key the env held.
 */
const blocked = () => (globalThis as any).__blockedTypesafe as string[];

describe("global typesafe.ai guard (test setupFile)", () => {
  it("a bare askJev without opts.fetch is intercepted before the network, and fails open", async () => {
    const before = blocked().length;
    const r = await askJev({ q: "x" }, { q: { type: "noul", question: "?" } } as any, {
      env: { MEMD_JEV: "on", TYPESAFE_API_KEY: "must-never-leave-this-machine" },
    });
    expect(r).toBeUndefined();
    expect(blocked().slice(before)).toEqual([JEV_URL]);
  });

  it("any typesafe.ai URL is blocked, other hosts are not touched", async () => {
    await expect(fetch("https://docs.typesafe.ai/llms.txt")).rejects.toThrow(/test guard: blocked/);
    await expect(fetch(new Request("https://API.typesafe.ai/v1/systemone", { method: "POST", body: "{}" }))).rejects.toThrow(/test guard/);
  });

  it("the worker env holds no Jev switch or key, so a spawned child cannot inherit one", () => {
    expect(process.env.MEMD_JEV).toBeUndefined();
    expect(process.env.TYPESAFE_API_KEY).toBeUndefined();
    const r = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify([process.env.MEMD_JEV ?? null, process.env.TYPESAFE_API_KEY ?? null]))"], {
      env: { ...process.env },
      encoding: "utf8",
    });
    expect(JSON.parse(r.stdout)).toEqual([null, null]);
  });
});
