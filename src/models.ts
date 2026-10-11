import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

/**
 * What is known about a model in the local cache WITHOUT loading it.
 *
 * The model library writes a download straight to its final path, so a
 * download that was cut off leaves a short `model.onnx` that looks like a
 * cached model. The only proof that the files are whole is that a load
 * succeeded, so after every successful load memd writes its own marker next to
 * them: the size of each file at that moment. Reading the state costs a few
 * stat calls: no model load, no network, nothing written.
 */
export type ModelState =
  /** the marker is there and every file it lists still has the size it had when the model last loaded (size, not content: nothing is hashed) */
  | "ready"
  /** files are there, but no load has vouched for them (or they changed since): possibly a cut-off download */
  | "unverified"
  /** nothing cached */
  | "absent";

const MARKER = ".memd-complete.json";

export function modelDir(modelId: string): string {
  return path.join(config.modelCacheDir, ...modelId.split("/"));
}

function listFiles(dir: string, rel = ""): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((e) => {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) return listFiles(dir, p);
    // the marker itself, and another process's marker mid-write: not model files
    return e.isFile() && !e.name.startsWith(MARKER) ? [p] : [];
  });
}

export function modelState(modelId: string): ModelState {
  const dir = modelDir(modelId);
  let sizes: Record<string, number> | undefined;
  try {
    sizes = JSON.parse(fs.readFileSync(path.join(dir, MARKER), "utf8")).files;
  } catch {
    // no marker, or not one of ours
  }
  if (sizes && typeof sizes === "object") {
    const names = Object.keys(sizes);
    const whole = names.some((n) => n.endsWith(".onnx")) && names.every((n) => {
      try {
        return fs.statSync(path.join(dir, n)).size === sizes![n];
      } catch {
        return false;
      }
    });
    if (whole) return "ready";
  }
  return listFiles(dir).length ? "unverified" : "absent";
}

/** Record that `modelId` just loaded from the cache. Never throws: the marker is a convenience for `stats`. */
export function markModelLoaded(modelId: string): void {
  try {
    const dir = modelDir(modelId);
    const files: Record<string, number> = {};
    for (const f of listFiles(dir)) files[f] = fs.statSync(path.join(dir, f)).size;
    if (!Object.keys(files).some((n) => n.endsWith(".onnx"))) return; // loaded from somewhere else: nothing to vouch for
    const tmp = path.join(dir, `${MARKER}.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify({ model: modelId, files }, null, 1));
    fs.renameSync(tmp, path.join(dir, MARKER));
  } catch {
    // read-only cache, or a file vanished mid-walk
  }
}

export type ModelRole = "embedding" | "reranking";

/** Why a model could not be used. One error type for every caller, so the message is the same everywhere. */
export class ModelUnavailableError extends Error {
  constructor(
    readonly reason: "download-failed" | "offline" | "incomplete",
    readonly modelId: string,
    readonly cachePath: string,
    message: string
  ) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

/** The options memd passes to the model library for one load. */
export interface ModelLoadOptions {
  cache_dir: string;
  local_files_only: boolean;
  progress_callback?: (event: any) => void;
}

/** Download sizes worth telling the user about before a long wait (the default embedder; others are not stated). */
const KNOWN_MB: Record<string, number> = { "Xenova/bge-small-en-v1.5": 133 };

const tilde = (p: string) => (p.startsWith(os.homedir() + path.sep) ? "~" + p.slice(os.homedir().length) : p);
const causeOf = (err: unknown) => String((err as any)?.message ?? err).split("\n")[0].slice(0, 300).replace(/[.\s]+$/, "");
/** What the user is left with while the model is missing. */
const meanwhile = (role: ModelRole) => (role === "embedding" ? "search is lexical only" : "results are not reranked");

let progressSink: ((line: string) => void) | undefined;
/** Where download progress lines go (the CLI sends them to stderr; the MCP server leaves it unset). */
export function setModelProgress(sink: ((line: string) => void) | undefined): void {
  progressSink = sink;
}

function progressFor(modelId: string, role: ModelRole): ((event: any) => void) | undefined {
  if (!progressSink) return undefined;
  const sink = progressSink;
  const mb = KNOWN_MB[modelId];
  let announced = false;
  let lastStep = -1;
  return (event: any) => {
    if (!announced && (event?.status === "initiate" || event?.status === "download")) {
      announced = true;
      sink(`downloading the ${role} model ${modelId}${mb ? ` (about ${mb} MB)` : ""} to ${tilde(modelDir(modelId))} ...`);
    }
    if (event?.status === "progress" && String(event.file ?? "").endsWith(".onnx") && Number.isFinite(event.progress)) {
      const step = Math.floor(event.progress / 10);
      if (step > lastStep) {
        lastStep = step;
        sink(`  ${step * 10}%`);
      }
    }
  };
}

const STAGING = ".staging-";

/** Staging dirs of downloads whose process is gone (killed mid-download): nothing will ever finish them. */
export function removeDeadStaging(): void {
  let names: string[] = [];
  try {
    names = fs.readdirSync(config.modelCacheDir).filter((n) => n.startsWith(STAGING));
  } catch {
    return;
  }
  for (const name of names) {
    const pid = parseInt(name.slice(STAGING.length), 10);
    let alive = false;
    try {
      if (Number.isFinite(pid)) {
        process.kill(pid, 0);
        alive = true;
      }
    } catch (err: any) {
      alive = err?.code === "EPERM";
    }
    if (!alive) fs.rmSync(path.join(config.modelCacheDir, name), { recursive: true, force: true });
  }
}

/**
 * Download into a directory of this process's own and move the finished model
 * into the cache in one rename. The library writes each file straight to the
 * path it is given, so a download that dies midway must never be given the
 * real cache path: the next run would take the short file for a model.
 */
async function download<T>(modelId: string, role: ModelRole, load: (o: ModelLoadOptions) => Promise<T>, replace: boolean): Promise<T> {
  const dir = modelDir(modelId);
  fs.mkdirSync(config.modelCacheDir, { recursive: true });
  removeDeadStaging();
  const staging = path.join(config.modelCacheDir, `${STAGING}${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  let model: T;
  try {
    model = await load({ cache_dir: staging, local_files_only: false, progress_callback: progressFor(modelId, role) });
  } catch (err) {
    fs.rmSync(staging, { recursive: true, force: true });
    const mb = KNOWN_MB[modelId];
    throw new ModelUnavailableError(
      "download-failed",
      modelId,
      dir,
      `could not download the ${role} model ${modelId}${mb ? ` (about ${mb} MB)` : ""} to ${tilde(dir)}: ${causeOf(err)}. ` +
        `Nothing was kept from the attempt. Run the command again, or \`memd prefetch\`, when the network is back; until then ${meanwhile(role)}.`
    );
  }
  const hasModelFile = (d: string) => listFiles(d).some((n) => n.endsWith(".onnx"));
  let moveError: string | undefined;
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    // A dir with no model file in it (a stale marker, a leftover) is not a
    // model: clear it, or the rename below fails and the download is thrown
    // away on every run.
    if (replace || !hasModelFile(dir)) fs.rmSync(dir, { recursive: true, force: true });
    fs.renameSync(path.join(staging, ...modelId.split("/")), dir);
  } catch (err: any) {
    // ENOTEMPTY/EEXIST: another process finished the same download first.
    // Believed only if its copy is really there (checked below).
    moveError = causeOf(err);
  }
  fs.rmSync(staging, { recursive: true, force: true });
  markModelLoaded(modelId);
  if (modelState(modelId) !== "ready") {
    throw new ModelUnavailableError(
      "download-failed",
      modelId,
      dir,
      `the ${role} model ${modelId} was downloaded but could not be put in ${tilde(dir)}${moveError ? `: ${moveError}` : ""}. ` +
        `Remove that directory and run \`memd prefetch\`; until then ${meanwhile(role)}.`
    );
  }
  return model;
}

/**
 * Load `modelId` through the cache, and only through it:
 *  - files in the cache: load them with the network off. Success records the
 *    marker (an existing cache is adopted, never downloaded again); failure
 *    says the files are incomplete and leaves them alone.
 *  - nothing cached: download (see above), unless MEMD_OFFLINE / --offline.
 * `probe` (`memd prefetch`) is asked first whether the cached files load, and
 * when it says no they are replaced by a fresh download. It has to be a check
 * made OUTSIDE this process: in the model library the first failed load fails
 * every later load in the same process, so "try, then download" cannot work
 * in one.
 */
export async function loadCachedModel<T>(
  modelId: string,
  role: ModelRole,
  load: (o: ModelLoadOptions) => Promise<T>,
  opts: { probe?: () => boolean } = {}
): Promise<T> {
  const dir = modelDir(modelId);
  if (modelState(modelId) !== "absent") {
    if (opts.probe && !config.offline && !opts.probe()) return download(modelId, role, load, true);
    try {
      const model = await load({ cache_dir: config.modelCacheDir, local_files_only: true });
      markModelLoaded(modelId);
      return model;
    } catch (err) {
      throw new ModelUnavailableError(
        "incomplete",
        modelId,
        dir,
        `the ${role} model files in ${tilde(dir)} did not load: ${causeOf(err)}. ` +
          `They are probably a cut-off download. Run \`memd prefetch\` to download them again; until then ${meanwhile(role)}.`
      );
    }
  }
  if (config.offline) {
    throw new ModelUnavailableError(
      "offline",
      modelId,
      dir,
      `the ${role} model ${modelId} is not in ${tilde(dir)} and offline mode is on (MEMD_OFFLINE or --offline), so it was not downloaded. ` +
        `Run \`memd prefetch\` once with a network; until then ${meanwhile(role)}.`
    );
  }
  return download(modelId, role, load, false);
}
