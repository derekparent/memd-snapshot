import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // export/overlay holds the snapshot's own copies of a few files, tests
    // included; they belong to the snapshot that is cut from it, not to this tree.
    exclude: [...configDefaults.exclude, "export/**"],
    // Child processes, not worker threads: in a thread process.env is a copy,
    // so os.homedir() and os.tmpdir() still read the caller's real HOME and
    // TMPDIR and the two setup files below would isolate nothing.
    pool: "forks",
    // At most four workers. The default is one per core, and each worker runs
    // CLIs of its own: a run that loses its parent then leaves that many
    // processes behind (see test/setup/temp-root.ts for what stops them).
    poolOptions: { forks: { maxForks: 4 } },
    // Many tests spawn the CLI through tsx, about a second each and several
    // seconds when every worker does it at once; the 5 s default made a
    // two-spawn test fail under load.
    testTimeout: 30_000,
    // One short temp root per run, removed at the end (see the file).
    globalSetup: ["test/setup/temp-root.ts"],
    // throwaway-home.ts gives every test file its own HOME and store. The other
    // two are belt and braces: no test may reach api.typesafe.ai, or default to
    // the live store (see the files).
    setupFiles: ["test/setup/throwaway-home.ts", "test/setup/no-typesafe.ts", "test/setup/no-live-store.ts"],
  },
});
