import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, DB } from "../src/db.js";

let db: DB;
let root: string;

/** Point config.docRoots at a temp tree, then import indexDocs fresh. */
async function indexWith(roots: string[]) {
  process.env.MEMD_DOC_ROOTS = roots.join(",");
  vi.resetModules();
  const { indexDocs } = await import("../src/docs.js");
  return indexDocs(db);
}

beforeEach(() => {
  // realpath the temp root: macOS symlinks /var -> /private/var, and the
  // indexer now stores canonical paths, so raw mkdtemp paths would never match.
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-docs-")));
  db = openDb(path.join(root, "t.db"));
});

afterEach(() => {
  delete process.env.MEMD_DOC_ROOTS;
  vi.resetModules();
  fs.rmSync(root, { recursive: true, force: true });
});

const docPaths = () =>
  (db.prepare("SELECT DISTINCT path FROM docs ORDER BY path").all() as { path: string }[]).map((r) => r.path);

function write(rel: string, body: string): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
}

describe("prune: rows must not outlive the corpus", () => {
  it("evicts a file that left collectFiles but still exists on disk", async () => {
    write("live/a.md", "alpha content here");
    write("live/retired/b.md", "beta content here");
    await indexWith([path.join(root, "live")]);
    expect(docPaths()).toHaveLength(2);

    // Retire the subtree the intended way — the file still exists.
    fs.writeFileSync(path.join(root, "live/retired/.memd-ignore"), "");
    const stats = await indexWith([path.join(root, "live")]);

    expect(fs.existsSync(path.join(root, "live/retired/b.md"))).toBe(true);
    expect(docPaths()).toHaveLength(1);
    expect(stats.filesPruned).toBe(1);
  });

  it("still evicts a file deleted from disk (the pre-existing behaviour)", async () => {
    const a = write("live/a.md", "alpha content here");
    write("live/b.md", "beta content here");
    await indexWith([path.join(root, "live")]);
    fs.rmSync(a);
    await indexWith([path.join(root, "live")]);
    expect(docPaths()).toEqual([path.join(root, "live/b.md")]);
  });

  it("is idempotent — a second pass over an already-clean store prunes nothing", async () => {
    write("live/a.md", "alpha content here");
    await indexWith([path.join(root, "live")]);
    const second = await indexWith([path.join(root, "live")]);
    // Zero-to-prune is the EXPECTED steady state, not a broken prune: the attic
    // rows were already removed by hand before this shipped.
    expect(second.filesPruned).toBe(0);
    expect(docPaths()).toHaveLength(1);
  });
});

describe("prune safety: a transiently unreadable root must not mass-delete", () => {
  it("keeps rows when a root collects zero files this pass", async () => {
    write("live/a.md", "alpha content here");
    write("live/b.md", "beta content here");
    await indexWith([path.join(root, "live")]);
    expect(docPaths()).toHaveLength(2);

    // Simulate the transient case: the root resolves but yields nothing.
    fs.renameSync(path.join(root, "live/a.md"), path.join(root, "a.md.bak"));
    fs.renameSync(path.join(root, "live/b.md"), path.join(root, "b.md.bak"));
    const stats = await indexWith([path.join(root, "live")]);

    // Files are genuinely gone from disk here, so the disk check still evicts —
    // what must NOT happen is an unreadable root taking rows with it.
    expect(stats.filesPruned).toBe(2);

    // Now the real hazard: a root that exists but is empty, with rows elsewhere.
    fs.mkdirSync(path.join(root, "empty"), { recursive: true });
    const keep = write("other/c.md", "gamma content here");
    await indexWith([path.join(root, "other")]);
    expect(docPaths()).toContain(keep);
    const after = await indexWith([path.join(root, "empty"), path.join(root, "other")]);
    expect(docPaths()).toContain(keep);
    expect(after.filesPruned).toBe(0);
  });
});

describe("dual root: a symlinked root must not double-index", () => {
  it("indexes one canonical path when two roots resolve to the same tree", async () => {
    write("real/a.md", "alpha content here");
    const link = path.join(root, "linked");
    fs.symlinkSync(path.join(root, "real"), link);

    const stats = await indexWith([path.join(root, "real"), link]);

    // A skills directory reached through a symlink is exactly this shape, and
    // indexing it via both paths can put many duplicate chunks in the store.
    expect(docPaths()).toEqual([path.join(fs.realpathSync(path.join(root, "real")), "a.md")]);
    expect(stats.filesScanned).toBe(1);
  });

  it("migrates pre-existing non-canonical rows onto the canonical path", async () => {
    // Rows written BEFORE canonicalization sit under the symlink path, and
    // existsSync() reports them alive because the symlink resolves — so the
    // duplicates would survive forever unless the prune recognises them.
    const real = write("real/a.md", "alpha content here");
    const link = path.join(root, "linked");
    fs.symlinkSync(path.join(root, "real"), link);
    db.prepare("INSERT INTO docs (path, mtime, chunk_no, project, content) VALUES (?, 1, 0, 'x', 'alpha content here')").run(
      path.join(link, "a.md")
    );
    expect(docPaths()).toHaveLength(1);

    const stats = await indexWith([path.join(root, "real"), link]);

    expect(docPaths()).toEqual([real]);
    expect(stats.filesPruned).toBe(1);
  });

  it("does not prune the canonical row when reached via the symlink root", async () => {
    write("real/a.md", "alpha content here");
    const link = path.join(root, "linked");
    fs.symlinkSync(path.join(root, "real"), link);
    await indexWith([path.join(root, "real"), link]);
    const before = docPaths();
    const stats = await indexWith([path.join(root, "real"), link]);
    expect(docPaths()).toEqual(before);
    expect(stats.filesPruned).toBe(0);
  });
});

describe("prune: a root removed from config", () => {
  it("evicts every row under a root that is no longer configured, though its files still exist", async () => {
    write("keep/a.md", "alpha content here");
    write("dropped/b.md", "beta content here");
    await indexWith([path.join(root, "keep"), path.join(root, "dropped")]);
    expect(docPaths()).toHaveLength(2);

    const stats = await indexWith([path.join(root, "keep")]);
    expect(fs.existsSync(path.join(root, "dropped/b.md"))).toBe(true);
    expect(docPaths()).toEqual([path.join(root, "keep/a.md")]);
    expect(stats.filesPruned).toBe(1);
  });

  it("keeps rows of a root that is still configured but unreadable this pass", async () => {
    write("keep/a.md", "alpha content here");
    const flaky = write("flaky/b.md", "beta content here");
    await indexWith([path.join(root, "keep"), path.join(root, "flaky")]);
    fs.chmodSync(path.dirname(flaky), 0o000);
    try {
      await indexWith([path.join(root, "keep"), path.join(root, "flaky")]);
    } finally {
      fs.chmodSync(path.dirname(flaky), 0o755);
    }
    expect(docPaths()).toHaveLength(2);
  });

  it("keeps rows under a configured root that is a symlink (rows are stored by real path)", async () => {
    write("real/a.md", "alpha content here");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "link"));
    await indexWith([path.join(root, "link")]);
    const second = await indexWith([path.join(root, "link")]);
    expect(docPaths()).toEqual([path.join(root, "real/a.md")]);
    expect(second.filesPruned).toBe(0);
  });

  it("matches a glob root: a row under a still-configured * pattern stays", async () => {
    write("p1/CONTEXT.md", "one");
    write("p2/CONTEXT.md", "two");
    await indexWith([path.join(root, "*", "CONTEXT.md")]);
    const second = await indexWith([path.join(root, "*", "CONTEXT.md")]);
    expect(docPaths()).toHaveLength(2);
    expect(second.filesPruned).toBe(0);
  });
});

