import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelLoadOptions } from "../src/models.js";

const MODEL = "Xenova/bge-small-en-v1.5";
let cache: string;
let dir: string;

/** config reads the env at import, so the module is loaded after it is set. */
async function load(env: Record<string, string> = {}) {
  Object.assign(process.env, env);
  vi.resetModules();
  try {
    return await import("../src/models.js");
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
  }
}

/** What the model library does on a download: write each file straight under cache_dir. */
function writeModel(cacheDir: string, bytes = 1000): void {
  const d = path.join(cacheDir, "Xenova", "bge-small-en-v1.5");
  fs.mkdirSync(path.join(d, "onnx"), { recursive: true });
  fs.writeFileSync(path.join(d, "config.json"), "{}");
  fs.writeFileSync(path.join(d, "onnx", "model.onnx"), Buffer.alloc(bytes, 1));
}
const staging = () => (fs.existsSync(cache) ? fs.readdirSync(cache).filter((n) => n.startsWith(".staging-")) : []);

beforeEach(() => {
  cache = fs.mkdtempSync(path.join(os.tmpdir(), "memd-load-"));
  dir = path.join(cache, "Xenova", "bge-small-en-v1.5");
  process.env.MEMD_MODEL_DIR = cache;
});
afterEach(() => {
  delete process.env.MEMD_MODEL_DIR;
  vi.resetModules();
  fs.rmSync(cache, { recursive: true, force: true });
});

describe("loadCachedModel", () => {
  it("nothing cached: downloads into a staging dir, then moves the whole model into place", async () => {
    const { loadCachedModel, modelState } = await load();
    const calls: ModelLoadOptions[] = [];
    const model = await loadCachedModel(MODEL, "embedding", async (o) => {
      calls.push(o);
      writeModel(o.cache_dir);
      expect(fs.existsSync(dir)).toBe(false); // not in the real place while the download runs
      return "the model";
    });
    expect(model).toBe("the model");
    expect(calls).toHaveLength(1);
    expect(calls[0].local_files_only).toBe(false);
    expect(path.dirname(calls[0].cache_dir)).toBe(cache);
    expect(path.basename(calls[0].cache_dir)).toMatch(/^\.staging-\d+-/);
    expect(fs.statSync(path.join(dir, "onnx", "model.onnx")).size).toBe(1000);
    expect(modelState(MODEL)).toBe("ready");
    expect(staging()).toEqual([]);
  });

  it("a download that dies midway leaves nothing behind and says a re-run fixes it", async () => {
    const { loadCachedModel, modelState, ModelUnavailableError } = await load();
    const failing = loadCachedModel(MODEL, "embedding", async (o) => {
      writeModel(o.cache_dir, 400); // a short model file, as a cut-off download leaves
      throw new Error("fetch failed\n    at node:internal/deps/undici");
    });
    await expect(failing).rejects.toBeInstanceOf(ModelUnavailableError);
    const err: any = await failing.catch((e) => e);
    expect(err.reason).toBe("download-failed");
    expect(err.message).toBe(
      `could not download the embedding model ${MODEL} (about 133 MB) to ${dir}: fetch failed. ` +
        "Nothing was kept from the attempt. Run the command again, or `memd prefetch`, when the network is back; until then search is lexical only."
    );
    expect(fs.existsSync(dir)).toBe(false);
    expect(staging()).toEqual([]);
    expect(modelState(MODEL)).toBe("absent");

    // and the re-run does fix it
    await loadCachedModel(MODEL, "embedding", async (o) => writeModel(o.cache_dir));
    expect(modelState(MODEL)).toBe("ready");
  });

  it("files already in the cache are loaded with the network off and adopted, never downloaded again", async () => {
    const { loadCachedModel, modelState } = await load();
    writeModel(cache);
    const before = fs.statSync(path.join(dir, "onnx", "model.onnx")).mtimeMs;
    const calls: ModelLoadOptions[] = [];
    await loadCachedModel(MODEL, "embedding", async (o) => void calls.push(o));
    expect(calls).toEqual([{ cache_dir: cache, local_files_only: true }]);
    expect(modelState(MODEL)).toBe("ready");
    expect(fs.statSync(path.join(dir, "onnx", "model.onnx")).mtimeMs).toBe(before);
  });

  it("cached files that do not load are reported as incomplete and left alone", async () => {
    const { loadCachedModel, modelState } = await load();
    writeModel(cache, 400);
    const calls: ModelLoadOptions[] = [];
    const err: any = await loadCachedModel(MODEL, "embedding", async (o) => {
      calls.push(o);
      throw new Error("Protobuf parsing failed");
    }).catch((e) => e);
    expect(err.reason).toBe("incomplete");
    expect(err.message).toBe(
      `the embedding model files in ${dir} did not load: Protobuf parsing failed. ` +
        "They are probably a cut-off download. Run `memd prefetch` to download them again; until then search is lexical only."
    );
    expect(calls.map((c) => c.local_files_only)).toEqual([true]); // no download was attempted
    expect(fs.statSync(path.join(dir, "onnx", "model.onnx")).size).toBe(400);
    expect(modelState(MODEL)).toBe("unverified");
  });

  it("prefetch: files the probe says do not load are replaced by a fresh download, without trying them here", async () => {
    const { loadCachedModel, modelState } = await load();
    writeModel(cache, 400);
    const calls: boolean[] = [];
    await loadCachedModel(
      MODEL,
      "embedding",
      async (o) => {
        calls.push(o.local_files_only);
        writeModel(o.cache_dir, 1000);
      },
      { probe: () => false }
    );
    expect(calls).toEqual([false]); // one load in this process, and it is the download
    expect(fs.statSync(path.join(dir, "onnx", "model.onnx")).size).toBe(1000);
    expect(modelState(MODEL)).toBe("ready");
    expect(staging()).toEqual([]);
  });

  it("prefetch: files the probe says load are used as they are", async () => {
    const { loadCachedModel, modelState } = await load();
    writeModel(cache);
    const calls: boolean[] = [];
    await loadCachedModel(MODEL, "embedding", async (o) => void calls.push(o.local_files_only), { probe: () => true });
    expect(calls).toEqual([true]);
    expect(modelState(MODEL)).toBe("ready");
  });

  it("a failed replacement keeps the old files (nothing is deleted before the new copy is whole)", async () => {
    const { loadCachedModel } = await load();
    writeModel(cache, 400);
    const err: any = await loadCachedModel(
      MODEL,
      "embedding",
      async () => {
        throw new Error("no route to host");
      },
      { probe: () => false }
    ).catch((e) => e);
    expect(err.reason).toBe("download-failed");
    expect(fs.statSync(path.join(dir, "onnx", "model.onnx")).size).toBe(400);
    expect(staging()).toEqual([]);
  });

  it("a model dir that holds only a stale marker is filled by one download, not downloaded on every run", async () => {
    const { loadCachedModel, modelState, markModelLoaded } = await load();
    writeModel(cache);
    markModelLoaded(MODEL);
    fs.rmSync(path.join(dir, "config.json"));
    fs.rmSync(path.join(dir, "onnx"), { recursive: true }); // what `rm -rf dir/*` leaves: the dotfile
    expect(fs.readdirSync(dir)).toEqual([".memd-complete.json"]);
    expect(modelState(MODEL)).toBe("absent");
    const calls: boolean[] = [];
    const loader = async (o: ModelLoadOptions) => {
      calls.push(o.local_files_only);
      if (!o.local_files_only) writeModel(o.cache_dir);
    };
    await loadCachedModel(MODEL, "embedding", loader);
    expect(fs.existsSync(path.join(dir, "onnx", "model.onnx"))).toBe(true);
    expect(modelState(MODEL)).toBe("ready");
    await loadCachedModel(MODEL, "embedding", loader);
    expect(calls).toEqual([false, true]); // downloaded once, then loaded from the cache
    expect(staging()).toEqual([]);
  });

  it("a download that leaves no model in the cache is an error, never a silent success", async () => {
    const { loadCachedModel, modelState } = await load();
    const err: any = await loadCachedModel(MODEL, "embedding", async () => "loaded from somewhere else").catch((e) => e);
    expect(err.reason).toBe("download-failed");
    expect(err.message).toContain(`the embedding model ${MODEL} was downloaded but could not be put in ${dir}`);
    expect(modelState(MODEL)).toBe("absent");
    expect(staging()).toEqual([]);
  });

  it("offline: nothing cached is an error that names the fix, and nothing is requested", async () => {
    const { loadCachedModel, modelState } = await load({ MEMD_OFFLINE: "1" });
    let called = false;
    const err: any = await loadCachedModel(MODEL, "reranking", async () => void (called = true)).catch((e) => e);
    expect(called).toBe(false);
    expect(err.reason).toBe("offline");
    expect(err.message).toBe(
      `the reranking model ${MODEL} is not in ${dir} and offline mode is on (MEMD_OFFLINE or --offline), so it was not downloaded. ` +
        "Run `memd prefetch` once with a network; until then results are not reranked."
    );
    expect(modelState(MODEL)).toBe("absent");
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  it("offline: a cached model still loads", async () => {
    const { loadCachedModel } = await load({ MEMD_OFFLINE: "1" });
    writeModel(cache);
    expect(await loadCachedModel(MODEL, "embedding", async (o) => o.local_files_only)).toBe(true);
  });

  it("two downloads of the same model at once both succeed and leave one whole copy", async () => {
    const { loadCachedModel, modelState } = await load();
    const slow = (ms: number) => async (o: ModelLoadOptions) => {
      await new Promise((r) => setTimeout(r, ms));
      writeModel(o.cache_dir);
      return ms;
    };
    expect(await Promise.all([loadCachedModel(MODEL, "embedding", slow(30)), loadCachedModel(MODEL, "embedding", slow(60))])).toEqual([30, 60]);
    expect(modelState(MODEL)).toBe("ready");
    expect(staging()).toEqual([]);
  });

  it("removeDeadStaging clears a dead download's dir without any download happening", async () => {
    const { removeDeadStaging } = await load();
    const dead = path.join(cache, ".staging-2147483646-dead");
    writeModel(dead, 400);
    removeDeadStaging();
    expect(fs.existsSync(dead)).toBe(false);
  });

  it("the staging dir of a download whose process is gone is removed by the next download", async () => {
    const { loadCachedModel } = await load();
    const dead = path.join(cache, ".staging-2147483646-dead");
    const live = path.join(cache, `.staging-${process.ppid}-live`);
    writeModel(dead, 400);
    writeModel(live, 400);
    await loadCachedModel(MODEL, "embedding", async (o) => writeModel(o.cache_dir));
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(live)).toBe(true); // another live process's download is not touched
  });
});
