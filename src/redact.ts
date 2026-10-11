/**
 * Redaction runs at INGEST time — nothing matching these patterns ever lands in
 * the store. Patterns mirror a global sensitive-files policy (never log:
 * SSNs, credit cards, API keys, private keys) plus the common token formats a
 * terminal transcript actually contains.
 */

interface Rule {
  label: string;
  re: RegExp;
}

const RULES: Rule[] = [
  // A block whose END line never arrived (cut off upstream, e.g. by a tool's
  // own output limit) is redacted to the end of the text: over-redacting a
  // tail costs recall, a stored key body costs the key.
  { label: "PRIVATE_KEY", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$(?![\s\S]))/g },
  { label: "AWS_KEY", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { label: "GITHUB_TOKEN", re: /\bgh[pousr]_[A-Za-z0-9]{20,255}\b/g },
  { label: "GITHUB_PAT", re: /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/g },
  { label: "ANTHROPIC_KEY", re: /\bsk-ant-[A-Za-z0-9\-_]{20,}\b/g },
  // No hyphens in the generic sk- class: real OpenAI keys are alnum/underscore,
  // while hyphenated sk-* strings are overwhelmingly CSS classes (SpinKit) and
  // package names (sk-learn-*). Anthropic sk-ant- keys DO contain hyphens and
  // are handled by their own anchored rule above.
  { label: "OPENAI_KEY", re: /\bsk-(?:proj-)?[A-Za-z0-9_]{20,}\b/g },
  { label: "GOOGLE_KEY", re: /\bAIza[0-9A-Za-z\-_]{30,}\b/g },
  { label: "SLACK_TOKEN", re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g },
  { label: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { label: "BEARER", re: /\bBearer\s+[A-Za-z0-9\-._~+/]{20,}={0,2}/g },
  { label: "SSN", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  // 13–16 digit runs with optional spaces/dashes in card grouping; Luhn-checked below.
  { label: "CARD", re: /\b(?:\d[ -]?){13,16}\b/g },
];

/**
 * Key-shape redaction. Every rule above matches a high-entropy TOKEN
 * shape, so `password: Robot1234` — a short human password with no prefix and
 * no entropy — passed through untouched. That was the entire mechanism of the
 * field incident: a gitignored config.yaml walked into the corpus via a
 * tool_result and stayed searchable.
 *
 * The difficulty here is false positives, not coverage: prose and code discuss
 * these key names constantly. Two defenses:
 *
 *  1. STRUCTURAL POSITION. The key must sit where a config key sits — at the
 *     start of a line (optionally indented, optionally a YAML "- " item),
 *     straight after a JSON `{`/`,`/`[`, or after a shell `export`. Prose like
 *     "the password field was renamed" or "reset your password: see below" has
 *     the key mid-sentence, so it never matches.
 *  2. VALUE SHAPE. Values that cannot be secrets are skipped — empty strings,
 *     null/None/true/false, `${VAR}` interpolations, and anything containing
 *     `(` (a function call like `get_password()`, not a literal).
 */
export const SECRET_KEY =
  "(?:[A-Za-z0-9_.-]+[.-])?(?:passwords?|passwd|pwd|secrets?|api[_-]?keys?|apikey|access[_-]?tokens?|auth[_-]?tokens?|refresh[_-]?tokens?|client[_-]?secret|db[_-]?password)";
const KEY_POSITION = "(?:^[ \\t]*(?:-[ \\t]+)?|[{,[][ \\t]*|^[ \\t]*export[ \\t]+)";
// `=>` before `=`: a PHP/Ruby hash rocket must consume the whole arrow. Matching
// only the `=` redacted the `>` and left the secret sitting in plain sight —
// found by scanning the real corpus, not by imagining test cases.
// Two value branches, because they have different rules:
//  - QUOTED values may contain SPACES. `password: "my home wifi 2024"` is the
//    literal incident class, and a single value class that excluded whitespace
//    skipped it silently.
//  - UNQUOTED values must not swallow structural punctuation: capturing the `}`
//    in `{"password": EVAL_USER_PASSWORD}` hid the constant-name shape under it.
//    The one exception is a `${…}` at the start: its `}` belongs to the value,
//    or `password: ${SALT}hunter2` is seen as the pure interpolation `${SALT`
//    and the literal after the brace is never examined.
const KEYVALUE_RE = new RegExp(
  `(${KEY_POSITION}(["']?)${SECRET_KEY}\\2[ \\t]*(?::|=>|=)[ \\t]*)` +
    `(?:(["'])([^"'\\n]*)\\3|(\\$\\{[^}\\s]*\\}[^\\s"',;}\\])]*|[^\\s"',;}\\])]*))`,
  "gim"
);

/**
 * The same key and separator at ANY position, QUOTED values only. A quoted
 * value is a delimited literal, so the structural-position defense (which
 * exists to tell config from prose) is not needed for it: `the config had
 * api_key = "…" in it` is a secret in a sentence, not a sentence about a
 * key. The lookbehind keeps the key a whole word (`mypassword:` is not one).
 * Unquoted mid-sentence values keep the prose defense: they do not match here.
 */
const PROSE_QUOTED_RE = new RegExp(
  `((?<![A-Za-z0-9_.-])(["']?)${SECRET_KEY}\\2[ \\t]*(?::|=>|=)[ \\t]*)(["'])([^"'\\n]*)\\3`,
  "gi"
);

/**
 * A quoted value is a literal: it skips the line-end check below AND the
 * code-expression exemptions in isNonSecretValue. An UNQUOTED value must end its
 * line (bar a trailing comma/brace or a comment) to be treated as config — in
 * prose and code, more words follow:
 *   "- Secrets: nothing in the build context leaks."   -> prose, skip
 *   "func signIn(email: String, password: String) ..." -> a type, skip
 *   "password: Robot1234"                              -> config, redact
 */
function valueTerminatesLine(rest: string): boolean {
  return /^[\s,;}\])]*$/.test(rest) || /^\s*(#|\/\/)/.test(rest);
}

/**
 * Values that are structurally incapable of being a leaked secret. A QUOTED
 * value is a literal, so only the checks above the `quoted` cut-off apply to
 * it: `password: "hunter(2)x"` and `password: "SYN_THETIC_PW"` are literals that
 * merely look like code, and the code-expression rules below would wave them
 * through.
 */
function isNonSecretValue(v: string, quoted = false): boolean {
  if (!v) return true;
  if (/^(null|nil|none|true|false|undefined)$/i.test(v)) return true;
  // Interpolation is only ${NAME} with a strict name (braces are explicit
  // intent, so any case) or a bare UPPER_SNAKE $NAME. A bare $name in lower or
  // mixed case is shape-identical to a literal that starts with $ ("$hunter2"),
  // and ${NAME:-default} / ${NAME-default} carries its default literally, so
  // both redact; `$db_pass` redacting is the accepted false positive.
  // (An unquoted `${VAR}` normally arrives whole; `${VAR` is a line cut short.)
  if (/^\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}?|[A-Z_][A-Z0-9_]*)$/.test(v)) return true;
  if (/^<.*>$/.test(v)) return true; // <your-password-here> placeholder
  if (/^[*x.•]+$/i.test(v)) return true; // already masked
  // Our OWN marker. The unquoted value class excludes `]`, so re-running over
  // `password: [REDACTED:SECRET_VALUE]` would capture the value minus its
  // closing bracket and re-wrap it, appending a `]` on every pass. redact()
  // must be idempotent: the E1 sweep re-reads its own output across 108k rows,
  // and a non-idempotent rule corrupts the corpus a bracket at a time.
  if (/^\[?REDACTED/i.test(v)) return true;
  if (quoted) return false;
  // Code-expression shapes: meaningful only for an UNQUOTED value.
  if (v.includes("(") || v.includes(")")) return true; // get_password(), signIn(…, password: password)
  // ALL_CAPS_WITH_UNDERSCORES is a constant/env-var reference, not a literal:
  // `{"password": EVAL_USER_PASSWORD}`. The underscore requirement keeps a real
  // shouted password ("HUNTER2") in scope for redaction.
  if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/.test(v)) return true;
  // `signIn(email: email, password: password)` — the value IS the key name, so
  // this is a named-argument pass-through, not a literal.
  if (new RegExp(`^${SECRET_KEY}$`, "i").test(v)) return true;
  // A bare type annotation at line end: `func signIn(…, password: String)`.
  // Narrow allow-list rather than a shape rule, so a real password is not
  // skipped for merely looking like an identifier.
  if (/^(String|Int|Bool|Double|Float|Any|AnyObject|Data|Date|URL|UUID|Character|Optional|str|int|bool|float|dict|list|any|unknown|never|object|number|boolean|string)\??$/.test(v)) return true;
  // YAML BLOCK SCALARS. `password: >` puts the secret on the FOLLOWING line, so
  // redacting the marker would report the secret as handled while leaving it
  // exposed — the same marked-handled-but-exposed class as the `=>` defect.
  // Skipping is honest; multi-line block scalars are a KNOWN GAP, recorded for
  // the E1 retroactive-sweep spec rather than half-solved here.
  if (/^[>|][-+]?\d*$/.test(v)) return true;
  return false;
}

function redactKeyValues(text: string): string {
  // Line-scoped so "the rest of the line" is well defined for the prose check.
  return text
    .split("\n")
    .map((line) =>
      line.replace(
        KEYVALUE_RE,
        (m, head: string, _kq: string, vq: string | undefined, quoted: string | undefined, bare: string | undefined, ...rest: unknown[]) => {
          const value = vq === undefined ? bare ?? "" : quoted ?? "";
          if (isNonSecretValue(value, vq !== undefined)) return m;
          // A quoted value is already delimited, so it needs no line-end check —
          // that check exists only to tell an unquoted config value from prose.
          if (vq === undefined) {
            const offset = rest[rest.length - 2] as number;
            if (!valueTerminatesLine(line.slice(offset + m.length))) return m;
          }
          const q = vq ?? "";
          return `${head}${q}[REDACTED:SECRET_VALUE]${q}`;
        }
      )
      .replace(PROSE_QUOTED_RE, (m, head: string, _kq: string, q: string, value: string) =>
        isNonSecretValue(value, true) ? m : `${head}${q}[REDACTED:SECRET_VALUE]${q}`
      )
    )
    .join("\n");
}

function luhnValid(s: string): boolean {
  const digits = s.replace(/[^\d]/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export function redact(text: string): string {
  let out = redactKeyValues(text);
  for (const rule of RULES) {
    out = out.replace(rule.re, (m) => {
      if (rule.label === "CARD" && !luhnValid(m)) return m;
      return `[REDACTED:${rule.label}]`;
    });
  }
  return out;
}

/**
 * Strict redaction for QUERY text, applied after redact(). Ingest redaction
 * anchors a secret key to a config position and skips an unquoted value that
 * more words follow — its defense against prose false positives. A query is
 * one line of prose by construction, so that defense switches the key-value
 * rule off for exactly this input: "why does password: hunter2 fail" passed
 * straight through. Here a secret-ish key followed by ':', '=', '=>' or ' is '
 * loses the next token (or quoted run) anywhere in the string. A false
 * positive costs one word of a triage log; a false negative writes a secret.
 * Kept out of redact() so ingest behaviour is untouched, and so are the extra
 * query-only keys: bare "token(s)" and "passphrase(s)" are far too common in
 * ingested prose and code to key on there.
 *
 * KNOWN RESIDUAL — no key rule can catch these, by construction: a secret with
 * no separator ("password X"), another verb ("password was X"), an unquoted
 * multi-word passphrase (only its first word goes), and a bare secret word
 * with no key at all.
 */
const QUERY_KEY = `(?:${SECRET_KEY}|tokens?|passphrases?)`;
const QUERY_SECRET_RE = new RegExp(
  `\\b(${QUERY_KEY})(\\s*(?::|=>|=)\\s*|\\s+is\\s+)(?:(["'])([^"'\\n]*)\\3|([^\\s"',;]+))`,
  "gi"
);

export function redactQuery(text: string): string {
  return redact(text).replace(QUERY_SECRET_RE, (m, key: string, sep: string, q: string | undefined, quoted: string | undefined, bare: string | undefined) => {
    const value = q === undefined ? bare ?? "" : quoted ?? "";
    // No marker guard needed: an earlier marker is captured as one whole token
    // and replaced by the same marker, so the output is a fixed point (the
    // five-pass test pins that as a property).
    if (!value) return m;
    const qq = q ?? "";
    return `${key}${sep}${qq}[REDACTED:SECRET_VALUE]${qq}`;
  });
}
