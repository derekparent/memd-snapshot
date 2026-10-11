import { afterEach, describe, expect, it, vi } from "vitest";

/** The list is built at import, so each case reloads the module under a controlled env. */
async function load(value: string | undefined) {
  if (value === undefined) delete process.env.MEMD_JEV_SENSITIVE_TERMS;
  else process.env.MEMD_JEV_SENSITIVE_TERMS = value;
  vi.resetModules();
  return import("../src/jev.js");
}
afterEach(() => {
  delete process.env.MEMD_JEV_SENSITIVE_TERMS;
  vi.resetModules();
});

describe("MEMD_JEV_SENSITIVE_TERMS", () => {
  it("unset: the built-in list", async () => {
    const { SENSITIVE_TERMS, DEFAULT_SENSITIVE_TERMS } = await load(undefined);
    expect(SENSITIVE_TERMS).toEqual(DEFAULT_SENSITIVE_TERMS);
    expect(DEFAULT_SENSITIVE_TERMS).toEqual(["tax", "w-?2", "1099", "ssn", "password", "credential", "secret", "\\.env", "bank", "routing", "medical", "hipaa"]);
  });

  it("set: replaces the list, trimmed, and is what the outbound check uses", async () => {
    const { SENSITIVE_TERMS, jevSkippedSensitive, askJev } = await load(" payroll , salar ");
    expect(SENSITIVE_TERMS).toEqual(["payroll", "salar"]);
    let sent = 0;
    const fetch = (async () => {
      sent++;
      throw new Error("no network in tests");
    }) as any;
    const env = { MEMD_JEV: "on", TYPESAFE_API_KEY: "synthetic" };
    const ask = { a: { type: "noul", instructions: "x" } } as any;
    const before = jevSkippedSensitive();
    await askJev({ query: "what is the salary band" }, ask, { fetch, env });
    expect(sent).toBe(0);
    expect(jevSkippedSensitive()).toBe(before + 1);
    // a word from the built-in list is no longer special
    await askJev({ query: "the bank holiday schedule" }, ask, { fetch, env });
    expect(sent).toBe(1);
  });

  it("empty or only separators: ignored, the built-in list stays (it cannot be switched off)", async () => {
    for (const v of ["", " ", ",,", " , "]) {
      const { SENSITIVE_TERMS, DEFAULT_SENSITIVE_TERMS } = await load(v);
      expect(SENSITIVE_TERMS).toEqual(DEFAULT_SENSITIVE_TERMS);
    }
  });
});
