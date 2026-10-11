import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, DB } from "../src/db.js";
import { saveFact, supersedeFact, retractFact } from "../src/facts.js";
import { search } from "../src/search.js";

let db: DB;

beforeEach(() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db");
  db = openDb(p);
});

describe("chain-head resolution at search time", () => {
  it("a query in the OLD wording surfaces the CURRENT chain head, marked", async () => {
    const a = saveFact(db, { content: "release policy: billing-api keeps the sign-off carve-out", kind: "ruling" }).id;
    const b = supersedeFact(db, a, { content: "release policy: no sign-off default everywhere, legacy gate retired" });
    const hits = await search(db, "billing-api sign-off carve-out", { sources: ["facts"] });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(b);
    expect(hits[0].text).toContain("no sign-off default");
    expect(hits[0].chainDepth).toBe(1);
  });

  it("retracted chains stay hidden even when the query matches them", async () => {
    const a = saveFact(db, { content: "the zorbfleem coupling is misaligned" }).id;
    retractFact(db, a, "was a misdiagnosis");
    const hits = await search(db, "zorbfleem coupling misaligned", { sources: ["facts"] });
    expect(hits).toHaveLength(0);
  });

  it("matching head and tail of the same chain dedupes to one head hit", async () => {
    const a = saveFact(db, { content: "widget cadence is every three hours polling" }).id;
    const b = supersedeFact(db, a, { content: "widget cadence is event-driven, polling retired" });
    const hits = await search(db, "widget cadence polling event-driven", { sources: ["facts"] });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(b);
  });

  it("includeSuperseded returns raw history without resolution (audit path)", async () => {
    const a = saveFact(db, { content: "audit trail alpha wording unique-marker-xq1" }).id;
    supersedeFact(db, a, { content: "audit trail beta wording unique-marker-xq2" });
    const hits = await search(db, "unique-marker-xq1", { sources: ["facts"], includeSuperseded: true });
    expect(hits.some((h) => h.id === a)).toBe(true);
  });
});
