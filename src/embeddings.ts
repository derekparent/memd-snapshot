import fs from "node:fs";
import { config } from "./config.js";
import { DB, embeddingToBlob, hasVec } from "./db.js";
import { loadCachedModel, ModelLoadOptions, ModelRole, removeDeadStaging } from "./models.js";

/**
 * Fully local embedding + reranking via transformers.js (ONNX). Models are
 * lazy-loaded on first use and cached under ~/.claude/memd/models — no
 * external API is ever called with memory content (data sovereignty).
 * If the runtime or model is unavailable, callers degrade to FTS-only.
 */

let extractorPromise: Promise<any> | null = null;
let rerankerPromise: Promise<{ tokenizer: any; model: any }> | null = null;
let problem: string | undefined;

/** Every model load goes through the cache module: it decides local or download, and says why when neither works. */
const loadExtractor = (probe?: () => boolean) =>
  loadCachedModel(
    config.embedModel,
    "embedding",
    async (o: ModelLoadOptions) => {
      const { pipeline, env } = await import("@huggingface/transformers");
      if (config.modelHost) (env as any).remoteHost = config.modelHost;
      return pipeline("feature-extraction", config.embedModel, { dtype: "fp32", ...o } as any);
    },
    { probe }
  );

const loadReranker = (probe?: () => boolean) =>
  loadCachedModel(
    config.rerankModel,
    "reranking",
    async (o: ModelLoadOptions) => {
      const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
      if (config.modelHost) (env as any).remoteHost = config.modelHost;
      const tokenizer = await AutoTokenizer.from_pretrained(config.rerankModel, o as any);
      const model = await AutoModelForSequenceClassification.from_pretrained(config.rerankModel, { dtype: "fp32", ...o } as any);
      return { tokenizer, model };
    },
    { probe }
  );

const remember = <T>(p: Promise<T>): Promise<T> => {
  p.catch((err) => (problem = String(err?.message ?? err)));
  return p;
};

async function getExtractor() {
  if (!extractorPromise) extractorPromise = remember(loadExtractor());
  return extractorPromise;
}

/**
 * Why vector search or reranking is not in use in this process, in words for
 * the user, or undefined when nothing has failed. sqlite-vec missing and a
 * model that could not be loaded are different problems with different fixes.
 */
export function embeddingsProblem(): string | undefined {
  if (!hasVec()) return "the sqlite-vec extension did not load, so there is no vector search; lexical search works";
  return problem;
}

/** The model half of the above: set once a model load has failed in this process. */
export function modelProblem(): string | undefined {
  return problem;
}

/**
 * `memd prefetch`: make both models usable from the cache, downloading what is
 * missing or does not load. `probe(role)` says whether the cached files of
 * that model load, checked in another process (see loadCachedModel).
 */
export async function prefetchModels(probe: (role: ModelRole) => boolean): Promise<void> {
  removeDeadStaging(); // also when nothing needs downloading: a killed download's partial file is 100 MB of nothing
  extractorPromise = loadExtractor(() => probe("embedding"));
  await extractorPromise;
  rerankerPromise = loadReranker(() => probe("reranking"));
  await rerankerPromise;
}

/** The check behind that probe: load one model from the cache only. Throws when it does not load. */
export async function checkCachedModel(role: ModelRole): Promise<void> {
  config.offline = true;
  if (role === "embedding") await getExtractor();
  else await (rerankerPromise = loadReranker());
}

export async function embedTexts(texts: string[], isQuery = false): Promise<Float32Array[]> {
  const extractor = await getExtractor();
  const inputs = isQuery ? texts.map((t) => config.embedQueryPrefix + t) : texts;
  const out = await extractor(inputs, { pooling: "mean", normalize: true });
  const dim = out.dims[out.dims.length - 1];
  const data: Float32Array = out.data;
  const vecs: Float32Array[] = [];
  for (let i = 0; i < inputs.length; i++) {
    vecs.push(data.slice(i * dim, (i + 1) * dim));
  }
  return vecs;
}

export async function embeddingsAvailable(): Promise<boolean> {
  if (!hasVec()) return false;
  try {
    await getExtractor();
    return true;
  } catch {
    return false;
  }
}

/**
 * One embedder at a time per store. Nightly launchd, every SessionStart hook,
 * and hand-run `memd embed` all pick the same newest embedded=0 rows; without
 * a lock they race, and the loser used to crash (vec0 rejects OR REPLACE with
 * a UNIQUE error, then onnxruntime aborted the process on teardown). Returns
 * a release function, or null if another live embedder holds the lock.
 */
export function acquireEmbedLock(dbPath: string = config.dbPath): (() => void) | null {
  const lockPath = `${dbPath}.embed.lock`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs.unlinkSync(lockPath);
        } catch { /* already gone */ }
      };
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
      const pid = parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
      if (Number.isFinite(pid) && pidAlive(pid)) return null;
      try { fs.unlinkSync(lockPath); } catch { /* lost the race to another cleaner */ }
    }
  }
  return null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err?.code === "EPERM";
  }
}

/**
 * Write one batch of vectors and flip the embedded flag, idempotently.
 * vec0 virtual tables do not honour INSERT OR REPLACE (they raise UNIQUE),
 * so an existing row is deleted first inside the same transaction.
 */
export function writeVectors(
  db: DB,
  table: "episodes" | "facts",
  rows: { id: number }[],
  blobs: Buffer[]
): number {
  const vecDel = db.prepare(`DELETE FROM vec_${table} WHERE rowid = ?`);
  const vecIns = db.prepare(`INSERT INTO vec_${table} (rowid, embedding) VALUES (?, ?)`);
  const mark = db.prepare(`UPDATE ${table} SET embedded = 1 WHERE id = ?`);
  const write = db.transaction(() => {
    let n = 0;
    rows.forEach((row, i) => {
      vecDel.run(BigInt(row.id));
      vecIns.run(BigInt(row.id), blobs[i]);
      mark.run(row.id);
      n++;
    });
    return n;
  });
  return write();
}

/** Backfill embeddings for episodes/facts flagged embedded=0. Batched; safe to interrupt. */
export async function backfill(db: DB, opts: { limit?: number; batchSize?: number } = {}): Promise<{ episodes: number; facts: number; skipped?: string }> {
  if (!hasVec()) throw new Error(embeddingsProblem());
  await getExtractor(); // throws the reason when the model cannot be loaded
  const batchSize = opts.batchSize ?? 64;
  const limit = opts.limit ?? Infinity;
  const counts: { episodes: number; facts: number; skipped?: string } = { episodes: 0, facts: 0 };

  const release = acquireEmbedLock(db.name);
  if (!release) {
    counts.skipped = "another embedder is running";
    return counts;
  }
  try {
    const targets = [
      {
        key: "episodes" as const,
        // Newest first: recent work is what gets queried; the 2025 tail can wait.
        select: db.prepare("SELECT id, content FROM episodes WHERE embedded = 0 ORDER BY id DESC LIMIT ?"),
      },
      {
        key: "facts" as const,
        select: db.prepare("SELECT id, content FROM facts WHERE embedded = 0 ORDER BY id DESC LIMIT ?"),
      },
    ];

    for (const t of targets) {
      while (counts[t.key] < limit) {
        const rows = t.select.all(Math.min(batchSize, limit - counts[t.key])) as { id: number; content: string }[];
        if (rows.length === 0) break;
        const vecs = await embedTexts(rows.map((r) => r.content));
        counts[t.key] += writeVectors(db, t.key, rows, vecs.map(embeddingToBlob));
      }
    }
  } finally {
    release();
  }
  return counts;
}

/**
 * Release ONNX sessions before process exit — onnxruntime-node aborts
 * (mutex lock failed, exit 134) if the process tears down while its thread
 * pool is still alive. Call this at the end of any CLI path that may have
 * touched a model.
 */
export async function shutdownModels(): Promise<void> {
  try {
    if (extractorPromise) {
      const e = await extractorPromise;
      await e.dispose?.();
      extractorPromise = null;
    }
  } catch { /* teardown is best-effort */ }
  try {
    if (rerankerPromise) {
      const r = await rerankerPromise;
      await r.model?.dispose?.();
      rerankerPromise = null;
    }
  } catch { /* teardown is best-effort */ }
}

/** Cross-encoder rerank: scores (query, doc) pairs jointly. Returns scores aligned to docs. */
export async function rerankScores(query: string, docs: string[]): Promise<number[]> {
  if (!rerankerPromise) rerankerPromise = remember(loadReranker());
  const { tokenizer, model } = await rerankerPromise;
  const scores: number[] = [];
  const BATCH = 16;
  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);
    const inputs = tokenizer(new Array(batch.length).fill(query), {
      text_pair: batch,
      padding: true,
      truncation: true,
    });
    const { logits } = await model(inputs);
    for (let j = 0; j < batch.length; j++) scores.push(Number(logits.data[j]));
  }
  return scores;
}
