// SYNTHETIC FIXTURES: every secret in this file is fabricated. None is a real credential.
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

const R = "[REDACTED:SECRET_VALUE]";

/**
 * The key-value rule fired only in KEY_POSITION (line start, after `{ , [`,
 * after `export`), so a QUOTED secret mid-sentence was stored as written:
 * `the config had api_key = "…" in it` went through mem_save untouched. A
 * quoted value is a delimited literal, so it now redacts after a secret key
 * at any position; an UNQUOTED mid-sentence value keeps the prose defense.
 */
describe("a quoted secret after a secret key redacts at any position", () => {
  for (const [input, secret] of [
    [`the config had api_key = "synthAK9921zz" in it`, "synthAK9921zz"],
    [`note: password: "Tr0ub4dor-synth"`, "Tr0ub4dor-synth"],
    [`we set client_secret => 'cs-synth-4412' last week`, "cs-synth-4412"],
    [`he pasted "api_key": "synth key with spaces" into chat`, "synth key with spaces"],
    [`see db.password='hunter2synth' above`, "hunter2synth"],
    [`two: password: "firstsynth" and token api_key="secondsynth"`, "secondsynth"],
  ]) {
    it(JSON.stringify(input), () => {
      const out = redact(input);
      expect(out).toContain(R);
      expect(out).not.toContain(secret);
    });
  }

  it("keeps the words around it", () => {
    expect(redact(`the config had api_key = "synthAK9921zz" in it`)).toBe(`the config had api_key = "${R}" in it`);
  });
});

describe("prose-position defenses still hold", () => {
  for (const prose of [
    "to reset your password: follow the emailed link",
    "the password field was renamed in the migration",
    "Rotate the api_key quarterly; the api_key field lives in config.",
    `set the input type="password" and label it "Password"`,
    `the mypassword: "synthval42" key is not a secret key`,
    `password: "\${DB_PASSWORD}" is interpolation`,
  ]) {
    it(`leaves ${JSON.stringify(prose)}`, () => {
      expect(redact(prose)).toBe(prose);
    });
  }

  it("an unquoted mid-sentence value keeps the prose defense", () => {
    const prose = "note: password: see the vault entry for this";
    expect(redact(prose)).toBe(prose);
  });

  it("leaves hyphenated sk- CSS classes alone", () => {
    expect(redact('<div class="sk-circle-bounce-delay-child-two">')).toContain("sk-circle-bounce-delay-child-two");
  });
});

describe("idempotence over five passes, prose position included", () => {
  it("is byte-stable after the first pass", () => {
    for (const input of [`the config had api_key = "synthAK9921zz" in it`, `note: password: "Tr0ub4dor-synth"`]) {
      let s = redact(input);
      const once = s;
      for (let i = 0; i < 5; i++) s = redact(s);
      expect(s).toBe(once);
      expect(s).not.toContain("]]");
    }
  });
});

describe("hyphenated keys: a header or a CLI flag", () => {
  for (const [input, secret] of [
    [`{"X-Api-Key": "synthHdr123"}`, "synthHdr123"],
    [`send header x-api-key: "synthHdr789" now`, "synthHdr789"],
    [`run it with --password="synthFlag1" please`, "synthFlag1"],
    [`mysql --password='synthFlag2'`, "synthFlag2"],
  ]) {
    it(JSON.stringify(input), () => {
      const out = redact(input);
      expect(out).toContain(R);
      expect(out).not.toContain(secret);
    });
  }

  it("idempotent over five passes", () => {
    let s = redact(`{"X-Api-Key": "synthHdr123"}`);
    const once = s;
    for (let i = 0; i < 5; i++) s = redact(s);
    expect(s).toBe(once);
  });
});
