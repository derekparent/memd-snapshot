// The interrupt check's own suite: two files that each hold a worker and a
// child process alive for a minute, so a signal lands while they are running.
// Not part of `npm test` (the default include only takes *.test.ts); run it
// through test/interrupt/run.sh, one signal at a time.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: fileURLToPath(new URL("../..", import.meta.url)),
    include: ["test/interrupt/*.fixture.ts"],
    pool: "forks",
    poolOptions: { forks: { maxForks: 2 } },
    testTimeout: 90_000,
    globalSetup: ["test/setup/temp-root.ts"],
  },
});
