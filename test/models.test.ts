import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const MODEL = "Xenova/bge-small-en-v1.5";
let cache: string;

/** config reads MEMD_MODEL_DIR at import, so the module is loaded after it is set. */
async function load() {
  vi.resetModules();
  return import("../src/models.js");
}

/** The files a finished download leaves, with a model body of `bytes` bytes. */
function fakeDownload(bytes: number): string {
  const dir = path.join(cache, "Xenova", "bge-small-en-v1.5");
  fs.mkdirSync(path.join(dir, "onnx"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), "{}");
  fs.writeFileSync(path.join(dir, "tokenizer.json"), "{}");
  fs.writeFileSync(path.join(dir, "onnx", "model.onnx"), Buffer.alloc(bytes, 1));
  return dir;
}

beforeEach(() => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "memd-models-"));
  process.env.MEMD_MODEL_DIR = cache;
});
afterEach(() => {
  delete process.env.MEMD_MODEL_DIR;
  vi.resetModules();
  fs.rmSync(cache, { recursive: true, force: true });
});

describe("modelState: what the cache holds, without loading anything", () => {
  it("absent when nothing is cached, and looking creates nothing", async () => {
    const { modelState } = await load();
    fs.rmSync(cache, { recursive: true });
    expect(modelState(MODEL)).toBe("absent");
    expect(fs.existsSync(cache)).toBe(false);
  });

  it("files that no load has vouched for are unverified, not ready", async () => {
    const { modelState } = await load();
    fakeDownload(1000);
    expect(modelState(MODEL)).toBe("unverified");
  });

  it("ready once a load has been recorded", async () => {
    const { modelState, markModelLoaded } = await load();
    fakeDownload(1000);
    markModelLoaded(MODEL);
    expect(modelState(MODEL)).toBe("ready");
  });

  it("a model file that is shorter than when it loaded is not ready", async () => {
    const { modelState, markModelLoaded } = await load();
    const dir = fakeDownload(1000);
    markModelLoaded(MODEL);
    fs.truncateSync(path.join(dir, "onnx", "model.onnx"), 400);
    expect(modelState(MODEL)).toBe("unverified");
  });

  it("a marker beside a deleted model file is not ready", async () => {
    const { modelState, markModelLoaded } = await load();
    const dir = fakeDownload(1000);
    markModelLoaded(MODEL);
    fs.rmSync(path.join(dir, "onnx", "model.onnx"));
    expect(modelState(MODEL)).toBe("unverified");
  });

  it("another process's marker mid-write is not recorded as a model file", async () => {
    const { modelState, markModelLoaded } = await load();
    const dir = fakeDownload(1000);
    const stray = path.join(dir, ".memd-complete.json.123.tmp");
    fs.writeFileSync(stray, "{");
    markModelLoaded(MODEL);
    expect(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, ".memd-complete.json"), "utf8")).files).sort()).toEqual(["config.json", "onnx/model.onnx", "tokenizer.json"]);
    fs.rmSync(stray);
    expect(modelState(MODEL)).toBe("ready");
  });

  it("a marker that is not valid JSON, or lists no model file, is not ready", async () => {
    const { modelState } = await load();
    const dir = fakeDownload(1000);
    fs.writeFileSync(path.join(dir, ".memd-complete.json"), "{");
    expect(modelState(MODEL)).toBe("unverified");
    fs.writeFileSync(path.join(dir, ".memd-complete.json"), JSON.stringify({ files: { "config.json": 2 } }));
    expect(modelState(MODEL)).toBe("unverified");
  });

  it("recording a load with no model file in the cache writes no marker", async () => {
    const { modelState, markModelLoaded } = await load();
    markModelLoaded(MODEL);
    expect(modelState(MODEL)).toBe("absent");
    expect(fs.readdirSync(cache)).toEqual([]);
  });
});

describe("memd stats reports the model without loading it", () => {
  // Preloaded into the CLI: any network request at all is written down and refused.
  const stats = (netLog: string) => {
    const guard = path.join(cache, "..", `no-network-${path.basename(cache)}.mjs`);
    fs.writeFileSync(
      guard,
      `import fs from "node:fs";
globalThis.fetch = async (input) => {
  fs.appendFileSync(${JSON.stringify(netLog)}, String(input instanceof Request ? input.url : input) + "\\n");
  throw new Error("test guard: stats made a network request");
};`
    );
    try {
      return spawnSync(path.join(__dirname, "../node_modules/.bin/tsx"), ["--import", pathToFileURL(guard).href, path.join(__dirname, "../src/cli.ts"), "stats"], {
        env: { ...process.env, MEMD_DB_PATH: path.join(cache, "..", `stats-${path.basename(cache)}.db`) },
        encoding: "utf8",
      });
    } finally {
      fs.rmSync(guard);
    }
  };
  const line = (out: string) => out.split("\n").find((l) => l.startsWith("vector search: ")) ?? "";

  it("empty cache: says the model is not downloaded, makes no request, creates no file", () => {
    const netLog = path.join(cache, "..", `net-${path.basename(cache)}.log`);
    const r = stats(netLog);
    expect(r.status).toBe(0);
    expect(line(r.stdout)).toMatch(/^vector search: (vec loaded, model not downloaded \(|unavailable \(FTS-only\))/);
    expect(fs.existsSync(netLog)).toBe(false);
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  it("verified cache: ready; a cut-off model file: not ready; neither loads the model", async () => {
    const { markModelLoaded } = await load();
    const netLog = path.join(cache, "..", `net-${path.basename(cache)}.log`);
    const dir = fakeDownload(1000); // 1000 bytes of 0x01 is not a model: a load would fail
    markModelLoaded(MODEL);
    const ready = stats(netLog);
    if (line(ready.stdout).includes("FTS-only")) return; // no sqlite-vec on this machine: the model is never reported
    expect(line(ready.stdout)).toMatch(/^vector search: ready \(/);
    fs.truncateSync(path.join(dir, "onnx", "model.onnx"), 400);
    expect(line(stats(netLog).stdout)).toMatch(/^vector search: vec loaded, model files in .* not verified yet/);
    expect(fs.existsSync(netLog)).toBe(false);
  });
});
