// SYNTHETIC FIXTURES: every secret in this file is fabricated. None is a real credential.
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

const R = "[REDACTED:SECRET_VALUE]";

/**
 * The UNQUOTED value class stops at `}`, so in `password: ${SALT}hunter2`
 * the rule saw only `${SALT`, took it for a pure interpolation, and never
 * looked at the literal after the brace.
 */
describe("a literal after an interpolation is examined, not skipped", () => {
  for (const [input, secret] of [
    ["password: ${SALT}hunter2synth", "hunter2synth"],
    ["password: ${db_pass}Tr0ub4dorsynth", "Tr0ub4dorsynth"],
    ["  api_key: ${PREFIX}synthKey9", "synthKey9"],
    ["export DB_PASSWORD=${X}synthpw", "synthpw"],
  ]) {
    it(`redacts ${JSON.stringify(input)}`, () => {
      const out = redact(input);
      expect(out).toContain(R);
      expect(out).not.toContain(secret);
    });
  }
});

describe("pure interpolations and structure are still left alone", () => {
  for (const input of [
    "password: ${VAULT_PASSWORD}",
    "password: ${db_pass}",
    "password: $DB_PASSWORD",
    '{"password": ${PASS}}',
    "password: ${PASS} # from the vault",
  ]) {
    it(`leaves ${JSON.stringify(input)}`, () => {
      expect(redact(input)).toBe(input);
    });
  }

  it("redaction of the suffix case is idempotent over five passes", () => {
    let s = redact("password: ${SALT}hunter2synth");
    const once = s;
    for (let i = 0; i < 5; i++) s = redact(s);
    expect(s).toBe(once);
  });
});
