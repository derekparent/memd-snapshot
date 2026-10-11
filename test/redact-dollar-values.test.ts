// SYNTHETIC FIXTURES: every password in this file is fabricated. None is a real credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { saveFact, supersedeFact } from "../src/facts.js";
import { redact } from "../src/redact.js";

describe("a value starting with $ is skipped only when it is a pure variable reference", () => {
  for (const input of [`password: "$ecretP@ss9"`, `password: $ecretP@ss9`, `api_key = "$2b$10$synthetichashvalue"`]) {
    it(`redacts ${JSON.stringify(input)}`, () => {
      const out = redact(input);
      expect(out).toContain("[REDACTED:SECRET_VALUE]");
      expect(out).not.toMatch(/ecretP@ss9|synthetichashvalue/);
    });
  }
  for (const input of [`password: "\${DB_PASSWORD}"`, `password: "$DB_PASSWORD"`, `password: $DB_PASSWORD`, `password: \${db_pass}`]) {
    it(`leaves the interpolation ${JSON.stringify(input)} alone`, () => {
      expect(redact(input)).toBe(input);
    });
  }
  // A bare $name is shape-identical to a literal that starts with $, and a
  // ${NAME:-default} carries the default literally.
  for (const [input, secret] of [
    [`password: $hunter2`, "hunter2"],
    [`password: "$Secret123"`, "Secret123"],
    [`api_key = "$sk_live_abc123XYZ"`, "sk_live_abc123XYZ"],
    [`password: \${DB_PASS:-hunter2}`, "hunter2"],
    [`password="\${DB_PASS:-Tr0ub4dor&3}"`, "Tr0ub4dor"],
    [`password: \${DB_PASS:=hunter2}`, "hunter2"],
    [`password: \${DB_PASS-hunter2}`, "hunter2"],
  ]) {
    it(`redacts ${JSON.stringify(input)}: only UPPER_SNAKE $NAME or a strict \${NAME} is interpolation`, () => {
      const out = redact(input);
      expect(out).toContain("[REDACTED:SECRET_VALUE]");
      expect(out).not.toContain(secret);
    });
  }
  it("redacts a lower-case bare $db_pass too (accepted false positive: indistinguishable from $hunter2)", () => {
    expect(redact("password: $db_pass")).toContain("[REDACTED:SECRET_VALUE]");
  });
});

describe("identical supersede with a new importance", () => {
  let db: DB;
  let root: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-imp-")));
    db = openDb(path.join(root, "t.db"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("updates the importance in place instead of silently ignoring it", () => {
    const id = saveFact(db, { content: "staging deploys need a manual approval", importance: 5 }).id;
    expect(supersedeFact(db, id, { content: "staging deploys need a manual approval", importance: 9 })).toBe(id);
    const row = db.prepare("SELECT importance, valid_to FROM facts WHERE id = ?").get(id) as { importance: number; valid_to: string | null };
    expect(row).toEqual({ importance: 9, valid_to: null });
    expect((db.prepare("SELECT count(*) AS n FROM facts").get() as { n: number }).n).toBe(1);
  });

  it("control: identical text and no importance leaves the fact exactly as it was", () => {
    const id = saveFact(db, { content: "staging deploys need a manual approval", importance: 5 }).id;
    supersedeFact(db, id, { content: "staging deploys need a manual approval" });
    expect((db.prepare("SELECT importance FROM facts WHERE id = ?").get(id) as { importance: number }).importance).toBe(5);
  });
  // The mem_supersede reply text is asserted over real MCP in mcp-smoke.test.ts.
});
