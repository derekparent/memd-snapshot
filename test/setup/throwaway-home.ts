// vitest setupFile: every test file runs under a throwaway HOME and store.
//
// src/config reads os.homedir() at import: the store, its sidecars, the
// transcript roots and the model cache all default to paths under it. A test
// that forgets one override, or a CLI it spawns with {...process.env}, would
// read or write the developer's real ~/.claude. So before a test file imports
// anything, HOME points at an empty dir under the run's temp root (removed with
// it, see temp-root.ts) and every MEMD_* the caller's shell exports is dropped.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-home-"));
fs.mkdirSync(path.join(home, ".claude", "memd"), { recursive: true });
fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
process.env.HOME = home;
process.env.USERPROFILE = home;
for (const k of Object.keys(process.env)) {
  if (k.startsWith("MEMD_")) delete process.env[k];
}
// config also reads these two unprefixed names (the token budget)
delete process.env.MCP_MAX_TOKENS;
delete process.env.MCP_TOKEN_SAFETY_BUFFER;
process.env.MEMD_DB_PATH = path.join(home, ".claude", "memd", "memd.db");
// Fixed, fictional roots. They are only ever used to slug and pattern-match
// paths, so fixtures can spell transcript dirs literally on any machine, and
// no test depends on the defaults in src/config.ts.
process.env.MEMD_PROJECTS_ROOT = "/Users/alice/Projects";
process.env.MEMD_WORKTREE_ROOT = "/Users/alice/.worktrees";
process.env.MEMD_WORKTREE_SEATS = "advisor,executor";
process.env.MEMD_BACKFILL_LEDGER_DIRS = "skills/handoff,skills/journal,skills/logs";
