// SYNTHETIC FIXTURES: every key, token, password and card number in this file is
// fabricated to exercise the redaction patterns. None is a real credential.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { saveFact, supersedeFact } from "../src/facts.js";

/**
 * Supersede was three separate writes around a dedupe that ignored
 * kind and project, so (a) superseding a fact with its own text closed it and
 * pointed it at itself, leaving no active fact at all; (b) the replacement could
 * be an unrelated existing row of another kind (a hidden feedback row became a
 * constraint's successor); (c) a failure midway left a half-written chain.
 */
let db: DB;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-sup-")));
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const row = (id: number) => db.prepare("SELECT id, kind, project, valid_to, superseded_by FROM facts WHERE id = ?").get(id) as any;
const activeCount = () => (db.prepare("SELECT count(*) AS n FROM facts WHERE valid_to IS NULL").get() as { n: number }).n;
const total = () => (db.prepare("SELECT count(*) AS n FROM facts").get() as { n: number }).n;

describe("superseding with identical content is a no-op", () => {
  it("a superseded fact stays active and never points at itself", () => {
    const id = saveFact(db, { content: "synthetic rule A", kind: "constraint" }).id;
    const nid = supersedeFact(db, id, { content: "synthetic rule A" });
    expect(nid).toBe(id);
    expect(row(id).valid_to).toBeNull();
    expect(row(id).superseded_by).toBeNull();
    expect(activeCount()).toBe(1);
    expect((db.prepare("SELECT count(*) AS n FROM relations WHERE from_id = to_id").get() as { n: number }).n).toBe(0);
  });

  it("identical after redaction is identical too", () => {
    const id = saveFact(db, { content: "token ghp_SYNTHETIC00000000000000000000 rotated" }).id;
    expect(supersedeFact(db, id, { content: "token ghp_SYNTHETIC00000000000000000000 rotated" })).toBe(id);
    expect(activeCount()).toBe(1);
  });
});

describe("dedupe is scoped to kind and project", () => {
  it("a feedback row is never reused as a constraint's replacement", () => {
    const fb = saveFact(db, { content: "synthetic text Q", kind: "feedback" }).id;
    const c = saveFact(db, { content: "synthetic constraint Z", kind: "constraint" }).id;
    const nid = supersedeFact(db, c, { content: "synthetic text Q", kind: "constraint" });
    expect(nid).not.toBe(fb);
    expect(row(nid).kind).toBe("constraint");
    expect(row(fb).valid_to).toBeNull(); // the feedback row is untouched
    expect(row(c).superseded_by).toBe(nid);
  });

  it("saveFact: same text, different kind -> a new row", () => {
    const a = saveFact(db, { content: "same words", kind: "fact" });
    const b = saveFact(db, { content: "same words", kind: "ruling" });
    expect(b.existed).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("saveFact: same text, different project -> a new row", () => {
    const a = saveFact(db, { content: "same words", project: "alpha" });
    const b = saveFact(db, { content: "same words", project: "beta" });
    expect(b.existed).toBe(false);
    expect(b.id).not.toBe(a.id);
  });

  it("saveFact: same text, kind and project -> the existing row (including null project)", () => {
    const a = saveFact(db, { content: "same words", kind: "ruling", project: "alpha" });
    expect(saveFact(db, { content: "same words", kind: "ruling", project: "alpha" })).toMatchObject({ id: a.id, existed: true });
    const n = saveFact(db, { content: "global words" });
    expect(saveFact(db, { content: "global words" })).toMatchObject({ id: n.id, existed: true });
  });
});

describe("supersede is atomic", () => {
  it("a failure after the replacement is written leaves the old fact active and no orphan row", () => {
    const id = saveFact(db, { content: "synthetic rule B" }).id;
    db.exec("CREATE TRIGGER boom BEFORE INSERT ON relations BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    expect(() => supersedeFact(db, id, { content: "synthetic rule B2" })).toThrow(/synthetic failure/);
    expect(row(id).valid_to).toBeNull();
    expect(total()).toBe(1);
  });
});
