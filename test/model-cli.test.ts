import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The CLI against a model host that fails, with the real model library and no
 * real network: MEMD_MODEL_HOST points it at a server in this process.
 */
const MODEL = "Xenova/bge-small-en-v1.5";
let cache: string;
let server: http.Server;
let requests: string[];
let mode: "refuse" | "cut";

beforeEach(async () => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "memd-cli-models-"));
  requests = [];
  mode = "refuse";
  server = http.createServer((req, res) => {
    requests.push(req.url ?? "");
    if (mode === "refuse") {
      res.writeHead(503).end("down");
      return;
    }
    // the start of a file, then the connection drops
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "5000" });
    res.write(Buffer.alloc(100, 1), () => res.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
});
afterEach(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(cache, { recursive: true, force: true });
});

/** Run the CLI without blocking this process (the stand-in host lives in it). */
function memd(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      path.join(__dirname, "../node_modules/.bin/tsx"),
      [path.join(__dirname, "../src/cli.ts"), ...args],
      {
        env: {
          ...process.env,
          MEMD_DB_PATH: path.join(cache, "store.db"),
          MEMD_MODEL_DIR: path.join(cache, "models"),
          MEMD_MODEL_HOST: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
          ...env,
        },
        encoding: "utf8",
      },
      (err, stdout, stderr) => resolve({ code: err ? ((err as any).code ?? 1) : 0, stdout, stderr })
    );
  });
}
const modelDir = () => path.join(cache, "models", "Xenova", "bge-small-en-v1.5");
const leftInCache = () => (fs.existsSync(path.join(cache, "models")) ? fs.readdirSync(path.join(cache, "models")) : []);
const noVec = (r: { stderr: string }) => r.stderr.includes("sqlite-vec extension did not load");

describe("a model host that cannot serve the model", () => {
  it("memd embed says the download failed and that a re-run fixes it, and keeps nothing", async () => {
    const r = await memd(["embed"]);
    expect(r.code).toBe(1);
    if (noVec(r)) return; // no vector extension on this machine: the model is never asked for
    expect(requests.length).toBeGreaterThan(0);
    expect(r.stderr).toContain(`memd: could not download the embedding model ${MODEL} (about 133 MB) to ${modelDir()}: `);
    expect(r.stderr).toContain("Nothing was kept from the attempt. Run the command again, or `memd prefetch`, when the network is back; until then search is lexical only.");
    expect(leftInCache()).toEqual([]);
  });

  it("a download cut off in the middle of a file is not kept as a model", async () => {
    mode = "cut";
    const r = await memd(["embed"]);
    expect(r.code).toBe(1);
    if (noVec(r)) return;
    expect(requests.length).toBeGreaterThan(0);
    expect(r.stderr).toContain(`memd: could not download the embedding model ${MODEL}`);
    expect(leftInCache()).toEqual([]);
    // the next command sees no model, not a short one
    expect((await memd(["stats"])).stdout).toContain("model not downloaded");
  });

  it("memd prefetch fails the same way", async () => {
    const r = await memd(["prefetch"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`memd: could not download the embedding model ${MODEL}`);
    expect(leftInCache()).toEqual([]);
  });

  it("a model dir holding only a marker counts as no model: stats says so, embed goes to the host, prefetch does not report success", async () => {
    fs.mkdirSync(modelDir(), { recursive: true });
    fs.writeFileSync(path.join(modelDir(), ".memd-complete.json"), JSON.stringify({ model: MODEL, files: { "onnx/model.onnx": 1000 } }));
    expect((await memd(["stats"])).stdout).toMatch(/vector search: (vec loaded, model not downloaded|unavailable)/);
    const e = await memd(["embed"]);
    expect(e.code).toBe(1);
    if (!noVec(e)) expect(requests.length).toBeGreaterThan(0);
    const p = await memd(["prefetch"]);
    expect(p.code).toBe(1);
    expect(p.stdout).not.toContain("ready");
  });

  it("prefetch removes the staging dir of a dead download even when it cannot download", async () => {
    const dead = path.join(cache, "models", ".staging-2147483646-dead");
    fs.mkdirSync(dead, { recursive: true });
    fs.writeFileSync(path.join(dead, "partial"), "x");
    await memd(["prefetch"]);
    expect(fs.existsSync(dead)).toBe(false);
  });

  it("--offline and MEMD_OFFLINE never contact the host", async () => {
    for (const r of [await memd(["embed", "--offline"]), await memd(["embed"], { MEMD_OFFLINE: "1" })]) {
      expect(r.code).toBe(1);
      if (noVec(r)) continue;
      expect(r.stderr).toContain(`memd: the embedding model ${MODEL} is not in ${modelDir()} and offline mode is on (MEMD_OFFLINE or --offline), so it was not downloaded.`);
    }
    const p = await memd(["prefetch", "--offline"]);
    expect(p.code).toBe(1);
    expect(p.stderr).toContain("memd: prefetch downloads the models, and offline mode is on");
    expect(requests).toEqual([]);
    expect(leftInCache()).toEqual([]);
  });

  it("search --rerank still answers, in fused order, and says why it was not reranked", async () => {
    await memd(["save", "the staging area is on the second floor"]);
    await memd(["save", "the staging area closes at six"]);
    const r = await memd(["search", "staging area", "--rerank"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("second floor");
    expect(r.stdout).toContain("closes at six");
    expect(requests.length).toBeGreaterThan(0);
    expect(r.stderr).toContain("memd: could not download the reranking model Xenova/ms-marco-MiniLM-L-6-v2 to ");
    expect(r.stderr).toContain("until then results are not reranked.");
    expect(leftInCache()).toEqual([]);
  });

  it("commands that do not need the model work and never ask for it", async () => {
    expect((await memd(["save", "the staging area is on the second floor"])).code).toBe(0);
    const search = await memd(["search", "staging area"]);
    expect(search.code).toBe(0);
    expect(search.stdout).toContain("second floor");
    expect((await memd(["stats"])).code).toBe(0);
    expect((await memd(["facts", "list"])).code).toBe(0);
    expect(requests).toEqual([]);
    expect(leftInCache()).toEqual([]);
  });
});
