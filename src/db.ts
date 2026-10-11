import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { config } from "./config.js";

export type DB = Database.Database;

let vecAvailable = false;

export function hasVec(): boolean {
  return vecAvailable;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  cwd TEXT,
  git_branch TEXT,
  first_ts TEXT,
  last_ts TEXT,
  transcript_path TEXT,
  indexed_bytes INTEGER NOT NULL DEFAULT 0,
  summary TEXT
);

CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  src_uuid TEXT NOT NULL,
  chunk_no INTEGER NOT NULL DEFAULT 0,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_episodes_src ON episodes(src_uuid, chunk_no);
CREATE INDEX IF NOT EXISTS idx_episodes_session ON episodes(session_id);
CREATE INDEX IF NOT EXISTS idx_episodes_project_ts ON episodes(project, ts);
CREATE INDEX IF NOT EXISTS idx_episodes_embedded ON episodes(embedded) WHERE embedded = 0;

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  content,
  content='episodes',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
-- Without this, rewriting content in place (the redaction sweep) left the OLD
-- terms matchable in FTS: a "redacted" secret stayed findable by search.
CREATE TRIGGER IF NOT EXISTS episodes_au AFTER UPDATE OF content ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO episodes_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY,
  content TEXT NOT NULL,
  project TEXT,
  kind TEXT NOT NULL DEFAULT 'fact',
  importance INTEGER NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  superseded_by INTEGER REFERENCES facts(id),
  source_session TEXT,
  created_at TEXT NOT NULL,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed TEXT,
  embedded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_facts_active ON facts(valid_to) WHERE valid_to IS NULL;
CREATE INDEX IF NOT EXISTS idx_facts_project ON facts(project);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  content,
  content='facts',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
-- Without this, rewriting content in place (the redaction sweep) left the OLD
-- terms matchable in FTS: a "redacted" secret stayed findable by search.
CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE OF content ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO facts_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY,
  from_kind TEXT NOT NULL DEFAULT 'fact',
  from_id INTEGER NOT NULL,
  relation TEXT NOT NULL,
  to_kind TEXT NOT NULL DEFAULT 'fact',
  to_id INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(from_kind, from_id, relation, to_kind, to_id)
);

CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY,
  path TEXT NOT NULL,
  mtime INTEGER NOT NULL,
  chunk_no INTEGER NOT NULL,
  project TEXT,
  content TEXT NOT NULL,
  UNIQUE(path, chunk_no)
);
CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  content,
  content='docs',
  content_rowid='id',
  tokenize='porter unicode61'
);
CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;
-- Without this, rewriting content in place (the redaction sweep) left the OLD
-- terms matchable in FTS: a "redacted" secret stayed findable by search.
CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE OF content ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, content) VALUES ('delete', old.id, old.content);
  INSERT INTO docs_fts(rowid, content) VALUES (new.id, new.content);
END;

CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  created_at TEXT NOT NULL,
  trigger TEXT NOT NULL,
  brief TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON checkpoints(session_id, created_at);
`;

const VEC_SCHEMA = (dim: number) => `
CREATE VIRTUAL TABLE IF NOT EXISTS vec_episodes USING vec0(embedding float[${dim}]);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_facts USING vec0(embedding float[${dim}]);
`;

/** Additive migrations for DBs created before a column existed. */
function migrate(db: Database.Database): void {
  for (const table of ["sessions", "episodes"]) {
    const cols = (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
    if (!cols.includes("source")) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN source TEXT NOT NULL DEFAULT 'claude'`);
    }
  }
  {
    const cols = (db.pragma("table_info(episodes)") as { name: string }[]).map((c) => c.name);
    if (!cols.includes("quarantined")) {
      db.exec("ALTER TABLE episodes ADD COLUMN quarantined INTEGER NOT NULL DEFAULT 0");
    }
  }
  // Quarantine is a persisted rule, not a one-shot UPDATE: a still-growing or
  // resumed transcript would otherwise re-ingest the hidden session on the
  // next `memd index`. The trigger covers every ingestion path (Claude,
  // Codex, checkpoint) because they all INSERT. Created here, after the
  // quarantined column is guaranteed to exist.
  db.exec(`
CREATE TABLE IF NOT EXISTS quarantine_rules (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'match')),
  pattern TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (kind, pattern)
);`);
  // The trigger name carries a version because CREATE TRIGGER IF NOT EXISTS
  // never replaces an existing body: v1 (unescaped LIKE) is dropped and v2
  // created in one transaction, so no insert can land between the two.
  db.transaction(() => {
    db.exec(`
DROP TRIGGER IF EXISTS episodes_quarantine_ai;
CREATE TRIGGER IF NOT EXISTS episodes_quarantine_ai_v2 AFTER INSERT ON episodes
WHEN EXISTS (SELECT 1 FROM quarantine_rules r WHERE ${QUARANTINE_RULE_MATCH("new")})
BEGIN
  UPDATE episodes SET quarantined = 1 WHERE id = new.id;
END;`);
  })();
}

/** Escape LIKE's wildcards so a quarantine target matches as literal text
 *  (still ASCII case-insensitive, as LIKE is). Pair with `ESCAPE '\\'`. */
export const likeLiteral = (s: string) => s.replace(/[\\%_]/g, "\\$&");
const SQL_LIKE_LITERAL = (x: string) => `replace(replace(replace(${x}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;

/** SQL predicate: some quarantine rule covers episode row alias `e`. Same
 *  literal, case-insensitive semantics as the `memd quarantine` UPDATE, so a
 *  rule hides exactly what the command hid. */
export const QUARANTINE_RULE_MATCH = (e: string) =>
  `(r.kind = 'session' AND ${e}.session_id LIKE ${SQL_LIKE_LITERAL("r.pattern")} || '%' ESCAPE '\\') OR ` +
  `(r.kind = 'match' AND ${e}.content LIKE '%' || ${SQL_LIKE_LITERAL("r.pattern")} || '%' ESCAPE '\\')`;

export function openDb(dbPath: string = config.dbPath): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  migrate(db);
  try {
    // Dynamic require keeps startup working even if the native ext is broken;
    // everything degrades to FTS-only and hasVec() reports the truth.
    const req = createRequire(import.meta.url);
    const sqliteVec = req("sqlite-vec");
    sqliteVec.load(db);
    db.exec(VEC_SCHEMA(config.embedDim));
    vecAvailable = true;
  } catch {
    vecAvailable = false;
  }
  return db;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function embeddingToBlob(vec: number[] | Float32Array): Buffer {
  const f32 = vec instanceof Float32Array ? vec : new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
