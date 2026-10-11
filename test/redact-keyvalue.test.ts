// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import { describe, expect, it } from "vitest";
import { redact } from "../src/redact.js";

const R = "[REDACTED:SECRET_VALUE]";

/**
 * Key-shape redaction. The token-shape rules cannot catch a short human
 * password, and a gitignored config.yaml read into a tool_result is exactly
 * how one of these can leak. These tests weight NEGATIVES heavily on purpose:
 * over-redaction silently destroys transcript content, and unlike a miss, it is
 * invisible after the fact.
 */
describe("a home router config.yaml in a tool_result", () => {
  it("redacts a short human password in a YAML block", () => {
    const yaml = ["router:", "  ssid: HomeNet", "  password: Robot1234"].join("\n");
    const out = redact(yaml);
    expect(out).not.toContain("Robot1234");
    expect(out).toContain(`password: ${R}`);
  });

  it("keeps the surrounding structure and the non-secret siblings readable", () => {
    const yaml = ["router:", "  ssid: HomeNet", "  password: Robot1234"].join("\n");
    const out = redact(yaml);
    expect(out).toContain("ssid: HomeNet"); // an SSID is not a credential
    expect(out).toContain("router:");
    expect(out).toContain("password:"); // the KEY stays; only the value goes
  });

  it("handles a dotted key path", () => {
    expect(redact("router.password: Robot1234")).toContain(`router.password: ${R}`);
    expect(redact("router.password: Robot1234")).not.toContain("Robot1234");
  });
});

describe("quoted values containing SPACES", () => {
  it("redacts a multi-word password in double quotes", () => {
    const out = redact('password: "my garden shed 2024"');
    expect(out).not.toContain("my garden shed 2024");
    expect(out).toBe(`password: "${R}"`);
  });

  it("redacts a multi-word value in single quotes", () => {
    expect(redact("password: 'correct horse battery staple'")).toBe(`password: '${R}'`);
  });

  it("redacts a spaced value in JSON and in a hash rocket", () => {
    expect(redact('{"client_secret": "two words here"}')).toContain(`"client_secret": "${R}"`);
    expect(redact("'access_token' => 'a b c'")).toContain(`'access_token' => '${R}'`);
  });

  it("does not let a quoted value run past its closing quote", () => {
    const out = redact('password: "hunter two", user: "alice"');
    expect(out).toContain(`password: "${R}"`);
    expect(out).toContain('user: "alice"'); // the neighbouring field survives
  });
});

describe("YAML block scalars must not be marked-handled-but-exposed", () => {
  // Redacting the `>` marker would replace the MARKER and leave the secret on
  // the next line, reporting a leak as handled. Known gap, honestly skipped.
  it("leaves a folded block scalar marker alone", () => {
    const y = ["password: >", "  actualSecretOnNextLine"].join("\n");
    expect(redact(y)).toBe(y);
  });

  it("leaves literal and chomped block markers alone", () => {
    expect(redact("password: |")).toBe("password: |");
    expect(redact("secret: >-")).toBe("secret: >-");
    expect(redact("api_key: |-")).toBe("api_key: |-");
  });
});

describe("shapes", () => {
  it("JSON, quoted", () => {
    const out = redact('{"user":"alice","api_key":"abc123def456"}');
    expect(out).not.toContain("abc123def456");
    expect(out).toContain('"api_key":"[REDACTED:SECRET_VALUE]"');
    expect(out).toContain('"user":"alice"');
  });

  it("env assignment", () => {
    expect(redact("DB_PASSWORD=hunter2")).toBe(`DB_PASSWORD=${R}`);
  });

  it("exported env assignment", () => {
    expect(redact("export ACCESS_TOKEN=abc123")).toBe(`export ACCESS_TOKEN=${R}`);
  });

  it("TOML / spaced assignment", () => {
    expect(redact('client_secret = "s3cr3t-value"')).toContain(`client_secret = "${R}"`);
  });

  it("YAML list item", () => {
    expect(redact("- password: hunter2")).toContain(`- password: ${R}`);
  });

  it("is case-insensitive on the key", () => {
    expect(redact("PASSWORD: hunter2")).toContain(R);
    expect(redact("Api_Key: hunter2")).toContain(R);
  });

  it("redacts every occurrence, not just the first", () => {
    const out = redact("password: one\napi_key: two");
    expect(out).not.toContain("one");
    expect(out).not.toContain("two");
  });
});

describe("idempotence — redact() re-reads its own output during the E1 sweep", () => {
  it("leaves an already-redacted line byte-identical", () => {
    const once = redact("password: Robot1234");
    expect(redact(once)).toBe(once);
  });

  it("does not accumulate brackets over repeated passes", () => {
    let s = "password: Robot1234";
    for (let i = 0; i < 5; i++) s = redact(s);
    expect(s).toBe(`password: ${R}`);
    expect(s).not.toContain("]]");
  });

  it("is idempotent for quoted and hash-rocket shapes too", () => {
    for (const input of ['password: "my garden shed 2024"', "'access_token' => 'abc123'", "DB_PASSWORD=hunter2"]) {
      const once = redact(input);
      expect(redact(once)).toBe(once);
    }
  });
});

describe("NEGATIVES — prose and code must survive intact", () => {
  it("leaves prose that merely mentions the key name", () => {
    const prose = "the password field was renamed in the migration";
    expect(redact(prose)).toBe(prose);
  });

  it("leaves mid-sentence prose that happens to use a colon", () => {
    const prose = "to reset your password: follow the emailed link";
    expect(redact(prose)).toBe(prose);
  });

  it("leaves a bare type annotation at line end", () => {
    // The measured corpus case had trailing code, so the line-end rule caught
    // it; the bare line-final form needs the type allow-list.
    const sig = "    func signIn(email: String, password: String)";
    expect(redact(sig)).toBe(sig);
    expect(redact("  password: String")).toBe("  password: String");
  });

  it("leaves a function call rather than redacting the call site", () => {
    const code = "password = get_password()";
    expect(redact(code)).toBe(code);
  });

  it("leaves environment interpolation", () => {
    const code = "password: ${VAULT_PASSWORD}";
    expect(redact(code)).toBe(code);
  });

  it("leaves null / empty / boolean values", () => {
    expect(redact("password: null")).toBe("password: null");
    expect(redact("secret: false")).toBe("secret: false");
    expect(redact('password: ""')).toBe('password: ""');
  });

  it("leaves an obvious placeholder", () => {
    const line = "password: <your-password-here>";
    expect(redact(line)).toBe(line);
  });

  it("leaves an already-masked value", () => {
    expect(redact("password: ********")).toBe("password: ********");
  });

  it("leaves a sentence discussing api keys in documentation", () => {
    const prose = "Rotate the api_key quarterly; the api_key field lives in config.";
    expect(redact(prose)).toBe(prose);
  });
});

describe("pre-existing token-shape rules are untouched (CONTEXT don't-re-debate)", () => {
  it("still leaves hyphenated sk- CSS classes and package names alone", () => {
    expect(redact('<div class="sk-circle-bounce-delay-child-two">')).toContain("sk-circle-bounce-delay-child-two");
    expect(redact("pip install sk-learn-extra-cluster-tools")).toContain("sk-learn-extra-cluster-tools");
  });

  it("still redacts real provider keys", () => {
    expect(redact("sk-proj-Abc123Def456Ghi789Jkl012")).toContain("[REDACTED:OPENAI_KEY]");
    expect(redact("sk-ant-api03-aaaa-bbbb-cccc-dddd-eeee")).toContain("[REDACTED:ANTHROPIC_KEY]");
  });

  it("composes both rule families in one payload", () => {
    const out = redact(["password: Robot1234", "token: ghp_" + "a".repeat(36)].join("\n"));
    expect(out).toContain(`password: ${R}`);
    expect(out).toContain("[REDACTED:GITHUB_TOKEN]");
  });
});
