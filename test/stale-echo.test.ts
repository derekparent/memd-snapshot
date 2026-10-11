import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, DB } from "../src/db.js";
import { retractFact, saveFact, supersedeFact } from "../src/facts.js";
import { formatHits, search } from "../src/search.js";
import { chainPredecessors, markStaleEchoes } from "../src/echo.js";

let db: DB;
let n = 0;

beforeEach(() => {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "memd-test-")), "t.db");
  db = openDb(p);
});

function episode(content: string, ts = "2026-01-01T00:00:00Z"): number {
  n++;
  db.prepare(
    `INSERT INTO episodes (session_id, project, ts, role, kind, content, src_uuid, chunk_no)
     VALUES (?, 'p', ?, 'assistant', 'text', ?, ?, 0)`
  ).run(`s${n}`, ts, content, `u${n}`);
  return (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id;
}

const OLD = "the nightly export job writes the ledger archive to bucket seven from the batch host every evening without fail";
const NEW = "exports moved to the streaming service last quarter and the batch host was retired after the final audit run";

/** One superseded ruling, its head, and the ids. */
function chain(): { old: number; head: number } {
  const old = saveFact(db, { content: OLD }).id;
  const head = supersedeFact(db, old, { content: NEW });
  return { old, head };
}

describe("stale-echo marker: a HISTORY hit quoting superseded wording says so", () => {
  it("marks an older episode that quotes the superseded fact, naming both facts", async () => {
    const { old, head } = chain();
    const e = episode(`status: ${OLD}. next step is the runbook update.`);
    const hits = await search(db, "nightly export ledger archive bucket", { limit: 20 });
    expect(hits.some((h) => h.source === "fact" && h.id === head)).toBe(true);
    const ep = hits.find((h) => h.id === e && h.source === "episode")!;
    expect(ep.quotesSuperseded).toEqual({ old, current: head });
    expect(formatHits(hits)).toContain(`QUOTES SUPERSEDED fact #${old} — current position is fact #${head} above`);
  });

  it("follows a whole chain: an echo of the FIRST wording names the current head", async () => {
    const a = saveFact(db, { content: OLD }).id;
    const b = supersedeFact(db, a, { content: "an interim wording about the export that nobody quoted in any session" });
    const c = supersedeFact(db, b, { content: NEW });
    expect(chainPredecessors(db, c).map((r) => r.id)).toEqual([b, a]);
    const e = episode(OLD);
    const hits = await search(db, "nightly export ledger archive bucket", { limit: 20 });
    expect(hits.find((h) => h.id === e && h.source === "episode")?.quotesSuperseded).toEqual({ old: a, current: c });
  });

  it("does not mark an episode that repeats only a short stretch (a path, an address, a stock phrase)", async () => {
    chain();
    // 16 consecutive words of OLD (11 overlapping runs) is one span: below ECHO_MIN_SPAN = 17.
    const e = episode("unrelated: the nightly export job writes the ledger archive to bucket seven from the batch host every. lunch");
    const hits = await search(db, "nightly export ledger", { limit: 20 });
    expect(hits.find((h) => h.id === e)?.quotesSuperseded).toBeUndefined();
  });

  it("does not add up separate short stretches: two 10-word spans are not one 20-word quote", async () => {
    chain();
    const e = episode("first: the nightly export job writes the ledger archive to bucket seven. unrelated middle text here. second: seven from the batch host every evening without fail");
    const hits = await search(db, "nightly export ledger", { limit: 20 });
    expect(hits.find((h) => h.id === e)?.quotesSuperseded).toBeUndefined();
  });

  it("marks at exactly ECHO_MIN_SPAN words", async () => {
    chain();
    const e = episode("note: the nightly export job writes the ledger archive to bucket seven from the batch host every evening. ok");
    const hits = await search(db, "nightly export ledger", { limit: 20 });
    expect(hits.find((h) => h.id === e && h.source === "episode")?.quotesSuperseded).toBeDefined();
  });

  it("does not mark an episode that also quotes the CURRENT wording (it is reporting the change)", async () => {
    chain();
    const e = episode(`was: ${OLD}. now: ${NEW}`);
    const hits = await search(db, "nightly export ledger archive bucket", { limit: 20 });
    expect(hits.find((h) => h.id === e)?.quotesSuperseded).toBeUndefined();
  });

  it("does not mark an episode quoting wording the head KEPT (it is still current)", async () => {
    const kept = "the queue worker restarts itself after every crash and keeps its place in the backlog without anyone having to step in at all";
    const old = saveFact(db, { content: `${kept}. it polls every thirty seconds.` }).id;
    supersedeFact(db, old, { content: `${kept}. it polls every five seconds since the upgrade.` });
    const e = episode(`note: ${kept}`);
    const hits = await search(db, "queue worker restarts crash backlog", { limit: 20 });
    expect(hits.some((h) => h.id === e && h.source === "episode")).toBe(true);
    expect(hits.find((h) => h.id === e && h.source === "episode")?.quotesSuperseded).toBeUndefined();
  });

  it("does not mark an episode written after the supersede", async () => {
    chain();
    const e = episode(OLD, "2999-01-01T00:00:00Z");
    const hits = await search(db, "nightly export ledger archive bucket", { limit: 20 });
    expect(hits.find((h) => h.id === e)?.quotesSuperseded).toBeUndefined();
  });

  it("marks nothing when the head is not in the response (episodes only, or a retracted chain)", async () => {
    const { head } = chain();
    const e = episode(OLD);
    const epOnly = await search(db, "nightly export ledger archive bucket", { limit: 20, sources: ["episodes"] });
    expect(epOnly.find((h) => h.id === e)?.quotesSuperseded).toBeUndefined();
    retractFact(db, head);
    const retracted = await search(db, "nightly export ledger archive bucket", { limit: 20 });
    expect(retracted.some((h) => h.source === "fact")).toBe(false);
    expect(retracted.find((h) => h.id === e)?.quotesSuperseded).toBeUndefined();
  });

  it("is ADD-only: same hits, same order, same scores", async () => {
    chain();
    episode(`status: ${OLD}`);
    episode("the archive bucket discussion, unrelated");
    const hits = await search(db, "nightly export ledger archive bucket", { limit: 20 });
    const before = hits.map((h) => [h.source, h.id, h.score]);
    for (const h of hits) delete h.quotesSuperseded;
    markStaleEchoes(db, hits);
    expect(hits.map((h) => [h.source, h.id, h.score])).toEqual(before);
    expect(hits.some((h) => h.quotesSuperseded)).toBe(true);
  });
  it("shingles the head from its stored content, so a clipped hit text does not turn kept wording stale", async () => {
    const kept = "the retention window stays at ninety days for every shard and the nightly compaction job keeps running as before";
    const old = saveFact(db, { content: `the ingest path writes to the legacy spool directory first and then the relay drains it. ${kept}` }).id;
    const head = supersedeFact(db, old, { content: `the ingest path now writes straight to the new stream broker with no relay. ${kept}` });
    const e = episode(`recap: ${kept}`);
    const hits = await search(db, "retention window ninety days compaction", { limit: 20 });
    const h = hits.find((x) => x.source === "fact" && x.id === head)!;
    expect(h).toBeDefined();
    h.text = h.text.slice(0, 60); // as if packing had clipped it
    const ep = hits.find((x) => x.source === "episode" && x.id === e)!;
    delete ep.quotesSuperseded;
    markStaleEchoes(db, hits);
    expect(ep.quotesSuperseded).toBeUndefined();
  });
});
