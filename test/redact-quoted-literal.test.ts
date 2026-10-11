// SYNTHETIC FIXTURES: every password in this file is fabricated. None is a real credential.
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

/**
 * The code-expression exemptions (a `(`, an ALL_CAPS_CONSTANT, the
 * key's own name, a type name) ran before the value was known to be QUOTED, so
 * a quoted literal that merely looked like code survived. A quoted value is a
 * literal: only emptiness, interpolation, a placeholder or a mask can make it
 * not-a-secret.
 */
describe("quoted literals that look like code are still redacted", () => {
  const cases: [string, string][] = [
    [`password: "hunter(2)x"`, "hunter(2)x"],
    [`password: "SYN_THETIC_PW"`, "SYN_THETIC_PW"],
    [`{"password": "SYN_THETIC_PW"}`, "SYN_THETIC_PW"],
    [`api_key = 'k(e)y-synthetic'`, "k(e)y-synthetic"],
    [`secret: "secret"`, `"secret"`],
    [`  password: "String"`, `"String"`],
  ];
  for (const [input, value] of cases) {
    it(JSON.stringify(input), () => {
      const out = redact(input);
      expect(out).not.toContain(value);
      expect(out).toContain("[REDACTED:SECRET_VALUE]");
    });
  }

  it("control: a plain quoted password redacts", () => {
    expect(redact(`password: "hunter2x"`)).not.toContain("hunter2x");
  });
});

describe("quoted values that cannot be secrets are still left alone", () => {
  for (const input of [`password: ""`, `password: "\${DB_PASSWORD}"`, `password: "$DB_PASSWORD"`, `password: "<your-password>"`, `password: "****"`, `password: "null"`, `password: "[REDACTED:SECRET_VALUE]"`]) {
    it(JSON.stringify(input), () => {
      expect(redact(input)).toBe(input);
    });
  }
});

describe("UNQUOTED code expressions keep their exemptions", () => {
  for (const input of [`password: get_password()`, `{"password": EVAL_USER_PASSWORD}`, `  password: String`, `password: password`]) {
    it(JSON.stringify(input), () => {
      expect(redact(input)).toBe(input);
    });
  }
});
