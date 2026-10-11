import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb } from "../src/db.js";
import { ORIGINS, parseOrigin, search } from "../src/search.js";

let root: string;
beforeAll(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-origin-")));
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const cli = (...args: string[]) =>
  spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), ...args], {
    env: { ...process.env, MEMD_DB_PATH: path.join(root, "t.db") },
    encoding: "utf8",
  });

describe("--origin is checked against the origin enum", () => {
  for (const bad of ["claud", "CODEX", "", "x' OR 1=1 --"]) {
    it(`search --origin ${JSON.stringify(bad)} fails fast, naming the valid values`, () => {
      const r = cli("search", "anything", "--origin", bad);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`--origin must be one of claude, codex, got "${bad}"`);
      expect(r.stdout).toBe("");
    });
  }

  it("a valid origin still searches", () => {
    for (const good of ORIGINS) {
      const r = cli("search", "anything", "--origin", good);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("No matches in memory.");
    }
  });

  it("parseOrigin passes undefined through (no filter)", () => {
    expect(parseOrigin(undefined)).toBeUndefined();
    expect(parseOrigin("codex")).toBe("codex");
    expect(() => parseOrigin("claude ")).toThrow(/--origin must be one of/);
  });

  it("search() itself refuses an unknown origin, since the value reaches SQL text", async () => {
    const db = openDb(path.join(root, "direct.db"));
    await expect(search(db, "anything", { origin: "x' OR 1=1 --" as any })).rejects.toThrow(/unknown origin/);
    await expect(search(db, "anything", { origin: "codex" })).resolves.toEqual([]);
  });
});
