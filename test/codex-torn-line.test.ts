import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { indexCodexCorpus } from "../src/codex.js";
import { config } from "../src/config.js";
import { openDb, DB } from "../src/db.js";

/**
 * The Codex indexer recorded stat().size as indexed_bytes even when the
 * rollout ended mid-line (Codex still writing), so the torn message was
 * skipped forever: the next sweep starts after it. Port of the Claude-side
 * fix in indexer.ts.
 */
let db: DB;
let root: string;
let saved: string;
let file: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-cxt-")));
  db = openDb(path.join(root, "t.db"));
  saved = config.codexRoot;
  config.codexRoot = path.join(root, "codex");
  fs.mkdirSync(path.join(config.codexRoot, "2026", "09", "25"), { recursive: true });
  file = path.join(config.codexRoot, "2026", "09", "25", "rollout-tt1.jsonl");
});
afterEach(() => {
  config.codexRoot = saved;
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const msg = (text: string) =>
  JSON.stringify({ type: "response_item", timestamp: "2026-09-25T00:00:00Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const texts = () => (db.prepare("SELECT content FROM episodes ORDER BY id").all() as { content: string }[]).map((r) => r.content);
const indexed = () => (db.prepare("SELECT indexed_bytes AS b FROM sessions WHERE session_id = 'codex:tt1'").get() as { b: number }).b;

describe("codex rollout still being written", () => {
  it("does not advance past a torn final line, and picks it up once the write completes", async () => {
    const first = msg("first complete message alpha") + "\n";
    const second = msg("second message bravo, written in two parts");
    const cut = Math.floor(second.length / 2);
    fs.writeFileSync(file, first + second.slice(0, cut));
    await indexCodexCorpus(db);
    expect(texts()).toEqual(["first complete message alpha"]);
    expect(indexed()).toBe(Buffer.byteLength(first));

    fs.appendFileSync(file, second.slice(cut) + "\n");
    await indexCodexCorpus(db);
    expect(texts()).toEqual(["first complete message alpha", "second message bravo, written in two parts"]);
    expect(indexed()).toBe(fs.statSync(file).size);
  });

  it("still indexes a complete final line that lacks a trailing newline", async () => {
    fs.writeFileSync(file, msg("only line charlie"));
    await indexCodexCorpus(db);
    expect(texts()).toEqual(["only line charlie"]);
    expect(indexed()).toBe(fs.statSync(file).size);
  });

  it("counts multi-byte text by bytes, not characters", async () => {
    const first = msg("naïve café — first") + "\n";
    fs.writeFileSync(file, first + msg("torn ünïcode").slice(0, 20));
    await indexCodexCorpus(db);
    expect(indexed()).toBe(Buffer.byteLength(first));
  });

  // Codex can die mid-line, then `codex resume` appends to the same rollout.
  // The first resumed line is glued to the torn fragment.
  const realMsg = (text: string) =>
    JSON.stringify({ timestamp: "2026-09-25T00:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
  for (const [shape, mk] of [["type-first", msg], ["timestamp-first (real Codex key order)", realMsg]] as const) {
    it(`recovers the first resumed line glued to a torn fragment (${shape})`, async () => {
      const first = mk("before the crash delta") + "\n";
      const torn = mk("never finished echo");
      fs.writeFileSync(file, first + torn.slice(0, Math.floor(torn.length / 2)));
      await indexCodexCorpus(db);
      fs.appendFileSync(file, mk("first resumed line foxtrot") + "\n" + mk("second resumed line golf") + "\n");
      await indexCodexCorpus(db);
      expect(texts()).toEqual(["before the crash delta", "first resumed line foxtrot", "second resumed line golf"]);
      expect(indexed()).toBe(fs.statSync(file).size);
    });
  }

  // The torn fragment is the file's FIRST line here, so the glue sits at offset 0.
  it("a fragment glued to a line that cuts inside a nested object is still dropped, not half-parsed", async () => {
    // the fragment ends inside payload; a nested `{"type"` in it must not be taken as a line start
    const torn = msg("nested cut hotel");
    const cutAt = torn.indexOf('{"type":"input_text"') + 3;
    fs.writeFileSync(file, torn.slice(0, cutAt));
    await indexCodexCorpus(db);
    fs.appendFileSync(file, msg("after india") + "\n");
    await indexCodexCorpus(db);
    expect(texts()).toEqual(["after india"]);
  });

  it("does not rewrite a corrupt line in the middle of a read (glue only happens at the old offset)", async () => {
    // "junk" + a complete line would recover to that line if every bad line were retried
    fs.writeFileSync(file, msg("start juliet") + "\n" + "junk" + msg("mid-file kilo") + "\n" + msg("end lima") + "\n");
    await indexCodexCorpus(db);
    expect(texts()).toEqual(["start juliet", "end lima"]);
  });
});
