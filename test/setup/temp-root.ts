// vitest globalSetup: one throwaway temp root for the whole run, removed at the end.
//
// Test files make their scratch dirs with fs.mkdtempSync(os.tmpdir(), ...) and
// most never remove them; a failing test skips its afterEach cleanup too. So
// TMPDIR is pointed at a single run root before any worker starts (workers and
// the CLIs they spawn inherit it), and teardown removes the root, pass or fail.
//
// The root also has to be SHORT. tsx opens a unix socket under os.tmpdir(), and
// a socket path over ~100 bytes fails with `listen EINVAL`, so under a long
// TMPDIR every CLI test would fail. When the caller's temp dir is long the root
// goes under /tmp instead.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Leaves room for `/tsx-<uid>/<pid>.pipe` plus a nested scratch dir under the ~104-byte sun_path limit. */
const MAX_BASE = 48;

/**
 * Stop everything below this process: the pool's worker forks and the CLIs
 * they spawned (a worker killed mid-test leaves its tsx child running, and that
 * child goes on writing under the root). Each process is frozen before its
 * children are listed, so it cannot start another one behind the walk, and
 * nothing is killed until the whole tree is known: killing a parent first
 * would hand its children to pid 1, out of reach.
 */
function killDescendants(): void {
  if (process.platform === "win32") return;
  const childrenOf = (pid: number): number[] => {
    try {
      return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).split("\n").map(Number).filter(Boolean);
    } catch {
      return []; // pgrep exits 1 when there are none
    }
  };
  const signal = (pid: number, sig: NodeJS.Signals) => {
    try {
      process.kill(pid, sig);
    } catch {
      // already gone
    }
  };
  const all: number[] = [];
  for (let level = childrenOf(process.pid); level.length && all.length < 2000; level = level.flatMap(childrenOf)) {
    for (const pid of level) signal(pid, "SIGSTOP");
    all.push(...level);
  }
  for (const pid of all) signal(pid, "SIGKILL");
}

export default function setup(): () => void {
  const callerTmp = os.tmpdir();
  const base = callerTmp.length <= MAX_BASE || process.platform === "win32" ? callerTmp : "/tmp";
  const root = fs.mkdtempSync(path.join(base, "memd-test-"));
  const before = process.env.TMPDIR;
  process.env.TMPDIR = root;
  const remove = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  // An interrupted run never reaches teardown. vitest handles SIGINT and
  // SIGTERM itself by calling process.exit(), which leaves its worker forks
  // running (they keep writing under the root for minutes), so the "exit"
  // listener stops them first and then removes the root. It has to be
  // PREPENDED: vitest's own "exit" listener, registered before this file
  // runs, calls process.exit() again, and from inside an "exit" event that
  // ends the process on the spot, before any later listener.
  // SIGKILL cannot be caught: it leaves the root and the workers behind.
  const onExit = () => {
    killDescendants();
    try {
      remove();
    } catch {
      // a worker still writing as the run dies: nothing more to do from here
    }
  };
  // The three signals stay handled for as long as the root exists. vitest's
  // handlers are once(): after the first SIGINT the next one would kill the
  // process outright, in the middle of the cleanup above (a second Ctrl-C is
  // what people do when a run does not stop at once). While a listener is
  // installed a repeated signal only queues behind that cleanup. SIGHUP has no
  // vitest handler at all. Each exits with the conventional 128 + signal number
  // when vitest's own listener has not already done so.
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const onSignal = (_name: NodeJS.Signals, n: number) => process.exit(128 + n);
  process.prependOnceListener("exit", onExit);
  for (const sig of signals) process.on(sig, onSignal);
  return () => {
    process.removeListener("exit", onExit);
    for (const sig of signals) process.removeListener(sig, onSignal);
    if (before === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before;
    // last, and not caught: a root that cannot be removed fails the run
    remove();
  };
}
