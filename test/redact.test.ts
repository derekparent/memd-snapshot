// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

describe("redact", () => {
  it("redacts AWS keys", () => {
    expect(redact("key=AKIAIOSFODNN7EXAMPLE ok")).toBe("key=[REDACTED:AWS_KEY] ok");
  });
  it("redacts GitHub tokens", () => {
    expect(redact("ghp_abcdefghijklmnopqrstuvwxyz012345")).toContain("[REDACTED:GITHUB_TOKEN]");
    expect(redact("github_pat_11ABCDEFG0_abcdefghijklmnopqrst")).toContain("[REDACTED:GITHUB_PAT]");
  });
  it("redacts Anthropic/OpenAI keys", () => {
    expect(redact("sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa")).toContain("[REDACTED:ANTHROPIC_KEY]");
    expect(redact("sk-proj-aaaaaaaaaaaaaaaaaaaaaaaa")).toContain("[REDACTED:OPENAI_KEY]");
  });
  it("redacts SSN-shaped strings", () => {
    expect(redact("ssn 123-45-6789")).toBe("ssn [REDACTED:SSN]");
  });
  it("redacts Luhn-valid card numbers but leaves invalid digit runs", () => {
    expect(redact("4111 1111 1111 1111")).toContain("[REDACTED:CARD]");
    expect(redact("1234 5678 9012 3456")).toBe("1234 5678 9012 3456");
  });
  it("redacts private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIB\nxyz\n-----END RSA PRIVATE KEY-----";
    expect(redact(pem)).toBe("[REDACTED:PRIVATE_KEY]");
  });
  it("redacts JWTs", () => {
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U")).toContain("[REDACTED:JWT]");
  });
  it("leaves normal prose and code alone", () => {
    const s = "const x = fetchTailscaleStatus(); // returns 100.64.x.x peers";
    expect(redact(s)).toBe(s);
  });
});
