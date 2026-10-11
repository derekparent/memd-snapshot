import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { FACT_KINDS, listFacts, parseKind, retractFact, saveFact, supersedeFact } from "../src/facts.js";

let db: DB;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-fl-")));
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const at = (id: number, iso: string) => db.prepare("UPDATE facts SET created_at = ? WHERE id = ?").run(iso, id);
const ids = (rows: { id: number }[]) => rows.map((r) => r.id);

describe("listFacts", () => {
  it("lists active facts newest first", () => {
    const a = saveFact(db, { content: "alpha" }).id;
    const b = saveFact(db, { content: "bravo" }).id;
    at(a, "2026-09-01T00:00:00Z");
    at(b, "2026-09-10T00:00:00Z");
    expect(ids(listFacts(db))).toEqual([b, a]);
  });

  it("shows chain heads only: superseded and retracted facts are gone", () => {
    const old = saveFact(db, { content: "suite is 44" }).id;
    const head = supersedeFact(db, old, { content: "suite is 222" });
    const gone = saveFact(db, { content: "saved in error" }).id;
    retractFact(db, gone);
    expect(ids(listFacts(db))).toEqual([head]);
  });

  it("filters by project (case-insensitive) and by kind", () => {
    const m = saveFact(db, { content: "memd thing", project: "memd", kind: "decision" }).id;
    const r = saveFact(db, { content: "fieldapp thing", project: "fieldapp-ios", kind: "ruling" }).id;
    saveFact(db, { content: "global thing" });
    expect(ids(listFacts(db, { project: "MEMD" }))).toEqual([m]);
    expect(ids(listFacts(db, { project: "FieldApp-ios" }))).toEqual([r]);
    expect(ids(listFacts(db, { kind: "ruling" }))).toEqual([r]);
  });

  it("hides feedback facts unless asked for by kind", () => {
    const f = saveFact(db, { content: "memd missed X", kind: "feedback", project: "memd" }).id;
    const n = saveFact(db, { content: "normal", project: "memd" }).id;
    expect(ids(listFacts(db, { project: "memd" }))).toEqual([n]);
    expect(ids(listFacts(db, { kind: "feedback" }))).toEqual([f]);
  });

  it("honours --limit", () => {
    for (let i = 0; i < 5; i++) saveFact(db, { content: `f${i}` });
    expect(listFacts(db, { limit: 2 })).toHaveLength(2);
  });
});

describe("--kind validation", () => {
  it("accepts every FactKind and rejects anything else, naming the valid set", () => {
    for (const k of FACT_KINDS) expect(parseKind(k)).toBe(k);
    expect(parseKind(undefined)).toBeUndefined();
    // Upper-case FEEDBACK used to cross the supersede boundary via the CLI.
    for (const bad of ["FEEDBACK", "feedbak", "Ruling", ""]) expect(() => parseKind(bad)).toThrow(/unknown kind .* one of: fact, decision/);
  });

  const cli = (...args: string[]) =>
    spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), [path.join(__dirname, "../src/cli.ts"), ...args], {
      env: { ...process.env, MEMD_DB_PATH: path.join(root, "cli.db") },
      encoding: "utf8",
    });

  it("memd save --kind FEEDBACK is refused and writes nothing", () => {
    const r = cli("save", "some fact", "--kind", "FEEDBACK");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/unknown kind "FEEDBACK"/);
    const c = openDb(path.join(root, "cli.db"));
    expect((c.prepare("SELECT COUNT(*) n FROM facts").get() as any).n).toBe(0);
    c.close();
  });

  it("memd facts list --kind is validated too, and lists what save wrote", () => {
    expect(cli("facts", "list", "--kind", "rulings").status).toBe(1);
    expect(cli("save", "the listed fact", "--kind", "ruling", "--project", "memd").status).toBe(0);
    const out = cli("facts", "list", "--project", "memd");
    expect(out.status).toBe(0);
    expect(out.stdout).toMatch(/^#1 {2}\d{4}-\d{2}-\d{2} {2}ruling {2}imp 5 {2}memd {2}the listed fact$/m);
  });
  // Wiring: asserted over MCP in mcp-smoke.test.ts.
});
