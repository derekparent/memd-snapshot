// vitest setupFile: no test may read or write the developer's live store.
//
// With MEMD_DB_PATH unset, config.dbPath defaults to ~/.claude/memd/memd.db,
// and every sidecar lives next to it (misses.jsonl, jev-usage.jsonl, backups).
// A test that forgets to pass its own path, or a CLI/server it spawns with
// {...process.env}, would then write there: fake counts into the Jev usage
// counters, fake misses into the miss log. So when it is unset, point it at a
// throwaway directory for this worker; spawned children inherit it.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.MEMD_DB_PATH) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-store-"));
  process.env.MEMD_DB_PATH = path.join(dir, "memd.db");
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
}
