import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { config } from "../src/config.js";
import { openDb, DB } from "../src/db.js";
import { indexCorpus, projectFromDir } from "../src/indexer.js";

let db: DB;
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memd-root-")));
  db = openDb(path.join(root, "t.db"));
});
afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const transcript = (dirName: string) => {
  const dir = path.join(root, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "s1.jsonl");
  const line = { type: "user", cwd: "/", uuid: "u1", timestamp: "2026-07-18T10:30:32Z", message: { role: "user", content: "You are summarizing the nightly build logs." } };
  fs.writeFileSync(file, JSON.stringify(line) + "\n");
  return file;
};

describe("sessions run from / (the empty project tag)", () => {
  it("the root-cwd slug never becomes an empty project tag", () => {
    expect(projectFromDir("-")).toBe("root");
    expect(projectFromDir("-Users-alice-Projects-homebase")).toBe("homebase"); // unchanged
  });

  it("the root-cwd slug is excluded by default", () => {
    // Only when MEMD_EXCLUDE_PROJECTS is not overriding the default.
    if (!process.env.MEMD_EXCLUDE_PROJECTS) expect(config.excludeProjects).toContain("-");
  });

  it("the hook path (--transcript) honours exclusions: a headless root-cwd run is not indexed", async () => {
    const stats = await indexCorpus(db, { onlyTranscript: transcript("-") });
    expect(stats.episodesAdded).toBe(0);
    expect((db.prepare("SELECT COUNT(*) n FROM episodes").get() as any).n).toBe(0);
  });

  it("a normal transcript dir is still indexed through the hook path", async () => {
    const stats = await indexCorpus(db, { onlyTranscript: transcript("-Users-alice-Projects-memd") });
    expect(stats.episodesAdded).toBe(1);
    expect((db.prepare("SELECT project FROM episodes").get() as any).project).toBe("memd");
  });
});
