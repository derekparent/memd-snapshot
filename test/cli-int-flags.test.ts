import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let root: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-int-")));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), ...args], {
    env: { ...process.env, MEMD_DB_PATH: path.join(root, "t.db") },
    encoding: "utf8",
  });

describe("integer flags are validated at the CLI boundary", () => {
  // '--limit abc' -> NaN -> SqliteError 'datatype mismatch'.
  for (const bad of ["abc", "0", "-3", "2.5", ""]) {
    it(`facts list --limit ${JSON.stringify(bad)} is refused with a usage error, not a SQLite error`, () => {
      const r = cli("facts", "list", "--limit", bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--limit must be a positive integer/);
      expect(r.stderr).not.toMatch(/datatype mismatch|SqliteError/);
    });
  }

  it("save --importance is validated too, and a good value still works", () => {
    const bad = cli("save", "x", "--importance", "high");
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/--importance must be a positive integer, got "high"/);
    expect(cli("save", "a fact", "--importance", "7").status).toBe(0);
    const r = cli("facts", "list", "--limit", "5");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/imp 7 {2}global {2}a fact/);
  });
});
