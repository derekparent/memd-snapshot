import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import setup from "./setup/temp-root.js";

const listeners = () => ["exit", "SIGINT", "SIGTERM", "SIGHUP"].map((e) => process.listenerCount(e));

describe("the run's temp root (test/setup/temp-root.ts)", () => {
  it("teardown removes the root, restores TMPDIR and takes its listeners away", () => {
    const tmpBefore = process.env.TMPDIR;
    const before = listeners();
    const teardown = setup();
    const root = os.tmpdir();
    expect(path.basename(root)).toMatch(/^memd-test-/);
    expect(listeners()).toEqual(before.map((n) => n + 1));
    fs.writeFileSync(path.join(fs.mkdtempSync(path.join(root, "x-")), "f"), "x");
    teardown();
    expect(fs.existsSync(root)).toBe(false);
    expect(process.env.TMPDIR).toBe(tmpBefore);
    expect(listeners()).toEqual(before);
  });

  // root can remove anything, and Windows has no directory write bit
  const canLock = process.platform !== "win32" && process.getuid?.() !== 0;
  it.skipIf(!canLock)("teardown fails when the root cannot be removed, instead of leaving it behind quietly", () => {
    const tmpBefore = process.env.TMPDIR;
    const before = listeners();
    const teardown = setup();
    const root = os.tmpdir();
    const locked = path.join(root, "locked");
    fs.mkdirSync(locked);
    fs.writeFileSync(path.join(locked, "f"), "x");
    fs.chmodSync(locked, 0o500);
    try {
      expect(() => teardown()).toThrow(/EACCES|EPERM|ENOTEMPTY/);
      expect(fs.existsSync(root)).toBe(true);
      expect(process.env.TMPDIR).toBe(tmpBefore);
      expect(listeners()).toEqual(before);
    } finally {
      fs.chmodSync(locked, 0o700);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
