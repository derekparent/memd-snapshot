import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { jevUsagePath } from "../src/jevusage.js";
import { missLogPath } from "../src/misses.js";

/**
 * With MEMD_DB_PATH unset, a test (or a child it spawns) that
 * relied on the default path wrote into ~/.claude/memd. The setupFile
 * test/setup/no-live-store.ts points it at a throwaway dir instead.
 */
// userInfo() reads the account's home, not $HOME: the setup points $HOME at a
// throwaway dir, and the store that must stay untouched is the real one.
const live = path.join(os.userInfo().homedir, ".claude", "memd");
const outside = (p: string) => !path.resolve(p).startsWith(live + path.sep);

describe("no test defaults to the live store", () => {
  it("the store and its sidecars resolve outside ~/.claude/memd", () => {
    for (const p of [config.dbPath, jevUsagePath(), missLogPath()]) expect(outside(p)).toBe(true);
  });

  it("the home, transcript roots and model cache resolve outside the real home", () => {
    const realHome = os.userInfo().homedir;
    expect(os.homedir()).not.toBe(realHome);
    for (const p of [config.home, config.transcriptsRoot, config.codexRoot, config.modelCacheDir]) {
      expect(path.resolve(p) === realHome || path.resolve(p).startsWith(realHome + path.sep)).toBe(false);
    }
  });

  it("scratch dirs land under the run's temp root, which is removed when the run ends", () => {
    expect(path.basename(os.tmpdir())).toMatch(/^memd-test-/);
    expect(os.homedir().startsWith(os.tmpdir() + path.sep)).toBe(true);
  });

  it("a spawned child inherits the throwaway path", () => {
    const r = spawnSync(process.execPath, ["-e", "console.log(process.env.MEMD_DB_PATH ?? '')"], { env: { ...process.env }, encoding: "utf8" });
    expect(r.stdout.trim()).toBe(process.env.MEMD_DB_PATH);
    expect(outside(r.stdout.trim())).toBe(true);
  });
});
