import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * config.docRoots is evaluated once at module import, so each case reloads the
 * module under a controlled env rather than mutating an already-built object.
 */
async function loadDocRoots(env: Record<string, string | undefined>): Promise<string[]> {
  const saved = process.env.MEMD_DOC_ROOTS;
  if (env.MEMD_DOC_ROOTS === undefined) delete process.env.MEMD_DOC_ROOTS;
  else process.env.MEMD_DOC_ROOTS = env.MEMD_DOC_ROOTS;
  vi.resetModules();
  try {
    const { config } = await import("../src/config.js");
    return config.docRoots;
  } finally {
    if (saved === undefined) delete process.env.MEMD_DOC_ROOTS;
    else process.env.MEMD_DOC_ROOTS = saved;
  }
}

afterEach(() => {
  vi.resetModules();
});

describe("docRoots defaults", () => {
  it("is exactly the generic curated set", async () => {
    const roots = await loadDocRoots({ MEMD_DOC_ROOTS: undefined });
    expect(roots).toEqual([
      "~/.claude/projects/*/memory",
      "~/Projects/*/CONTEXT.md",
      "~/Projects/*/DECISIONS.md",
      "~/.claude/skills",
      "~/Projects/*/.claude/skills",
    ]);
  });
});

describe("worktree mapping defaults", () => {
  it("is off until a root and seats are configured", async () => {
    const saved = { root: process.env.MEMD_WORKTREE_ROOT, seats: process.env.MEMD_WORKTREE_SEATS };
    delete process.env.MEMD_WORKTREE_ROOT;
    delete process.env.MEMD_WORKTREE_SEATS;
    vi.resetModules();
    try {
      const { config } = await import("../src/config.js");
      expect(config.worktreeRoot).toBeUndefined();
      expect(config.worktreeSeats).toEqual([]);
    } finally {
      if (saved.root !== undefined) process.env.MEMD_WORKTREE_ROOT = saved.root;
      if (saved.seats !== undefined) process.env.MEMD_WORKTREE_SEATS = saved.seats;
    }
  });
});

describe("backfill-projects defaults", () => {
  it("treats no directory and no dir suffix specially until configured", async () => {
    const saved = { seats: process.env.MEMD_BACKFILL_SEATS, dirs: process.env.MEMD_BACKFILL_LEDGER_DIRS };
    delete process.env.MEMD_BACKFILL_SEATS;
    delete process.env.MEMD_BACKFILL_LEDGER_DIRS;
    vi.resetModules();
    try {
      const { config } = await import("../src/config.js");
      expect(config.backfillSeats).toEqual([]);
      expect(config.backfillLedgerDirs).toEqual([]);
    } finally {
      if (saved.seats !== undefined) process.env.MEMD_BACKFILL_SEATS = saved.seats;
      if (saved.dirs !== undefined) process.env.MEMD_BACKFILL_LEDGER_DIRS = saved.dirs;
    }
  });
});

describe("MEMD_DOC_ROOTS override", () => {
  it("fully replaces the defaults rather than merging with them", async () => {
    const roots = await loadDocRoots({ MEMD_DOC_ROOTS: "~/only/this" });
    expect(roots).toEqual(["~/only/this"]);
    expect(roots).not.toContain("~/.claude/skills");
  });

  it("trims whitespace and drops empty entries", async () => {
    const roots = await loadDocRoots({ MEMD_DOC_ROOTS: " ~/a , , ~/b ," });
    expect(roots).toEqual(["~/a", "~/b"]);
  });
});
