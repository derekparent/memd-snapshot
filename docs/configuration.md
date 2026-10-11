# Configuration

Everything is set by environment variable. Set them where memd runs: the MCP server entry (`claude mcp add ... -e
KEY=value`), the hook commands, and any scheduled job. Unset means the default.

## Paths

| Variable | Default | Meaning |
|---|---|---|
| `MEMD_DB_PATH` | `~/.claude/memd/memd.db` | The store. Backups, feedback files, the miss log and the Jev usage counters live beside it. The model cache does not move with it (see `MEMD_MODEL_DIR`). |
| `MEMD_TRANSCRIPTS_ROOT` | `~/.claude/projects` | Claude Code transcripts to index. |
| `MEMD_CODEX_ROOT` | `~/.codex/sessions` | Codex rollouts to index; skipped if missing. |
| `MEMD_MODEL_DIR` | `~/.claude/memd/models` | Local cache for the embedding and rerank models. A download is staged and moved in whole. |
| `MEMD_OFFLINE` | unset (off) | `1`, `true`, `yes` or `on`: never download a model (same as `--offline`). With nothing cached, search is lexical only and `embed` says so. |
| `MEMD_MODEL_HOST` | Hugging Face Hub | Download the models from a mirror instead. |
| `MEMD_PROJECTS_ROOT` | `~/Projects` | Where your repos live. Transcript dirs under it are tagged with the repo's directory name when git can't name the repo. |
| `MEMD_WORKTREE_ROOT` | unset (off) | Root of per-seat worktrees named `<repo>-<seat>`; sessions there are tagged `<repo>`. |
| `MEMD_WORKTREE_SEATS` | unset (off) | Seat suffixes stripped under `MEMD_WORKTREE_ROOT`, e.g. `advisor,executor`. |
| `MEMD_BACKFILL_SEATS` | unset | More seat suffixes, used by `memd backfill-projects` only: seats you used in the past and no longer list in `MEMD_WORKTREE_SEATS`. |
| `MEMD_BACKFILL_LEDGER_DIRS` | unset | `<repo>/<dir>` pairs under the projects root, e.g. `notes/journal`, that `memd backfill-projects` does not count as work in `<repo>`: directories every session writes to at wrap-up, whatever it worked on. |
| `MEMD_PROJECT_ALIASES` | unset | `<name as derived>=<name to use>,…`. A repo renamed from `atlas` to `atlas-lab` keeps one history with `atlas-lab=atlas`; sessions and curated docs both follow it. One hop; stored rows are not rewritten. |
| `MEMD_EXCLUDE_PROJECTS` | `-private-tmp-*,-` | Transcript dir names to skip (comma-separated globs). `-` is sessions started from `/`. |
| `MEMD_DOC_ROOTS` | see below | Curated files indexed as current state. Replaces the default list; one `*` path segment per entry. |

Default doc roots: `~/.claude/projects/*/memory`, `~/Projects/*/CONTEXT.md`, `~/Projects/*/DECISIONS.md`,
`~/.claude/skills`, `~/Projects/*/.claude/skills`.

A session's project tag comes from git first (the `origin` remote of the session's working directory, so every
worktree or odd checkout of a repo gets one name), then from the transcript directory name.

## Retrieval

| Variable | Default | Meaning |
|---|---|---|
| `MEMD_MAX_TOKENS` (or `MCP_MAX_TOKENS`) | `25000` | Hard cap on tokens in one search response. |
| `MEMD_TOKEN_SAFETY_BUFFER` (or `MCP_TOKEN_SAFETY_BUFFER`) | `0.8` | Fraction of the cap actually filled. |
| `MEMD_MIN_ITEMS` / `MEMD_MAX_ITEMS` | `3` / `40` | Result count bounds. |
| `MEMD_W_RECENCY` / `MEMD_W_IMPORTANCE` | `0.2` / `0.2` | Weights of recency and importance in the score (see [how-it-works.md](how-it-works.md#retrieval)). |
| `MEMD_SCOPE_BOOST` | `0.5` | Caller-project boost: episodes from the calling session's own project score ×(1 + this). `0` keeps the second keyword pass without the boost. |
| `MEMD_CALLER_PROJECT` | unset | The project `mem_search` ranks toward. Unset, it is derived from the MCP server's working directory. `none`, `off`, `0`, `false` or an empty value turns caller-project ranking off. |
| `MEMD_DECAY_HALFLIFE_DAYS` | `30` | Recency half-life. |
| `MEMD_RRF_K` | `60` | Reciprocal-rank-fusion constant. |
| `MEMD_EMBED_MODEL` / `MEMD_EMBED_DIM` | `Xenova/bge-small-en-v1.5` / `384` | Local embedder. Changing it needs a fresh store. |
| `MEMD_RERANK_MODEL` | `Xenova/ms-marco-MiniLM-L-6-v2` | Local cross-encoder for `rerank`. |
| `MEMD_CHUNK_CHARS` / `MEMD_CHUNK_OVERLAP` | `1600` / `160` | Episode chunking. |

## Miss log

`mem_search` records likely misses (zero hits, thin results, a quick re-query) to `misses.jsonl` beside the store;
`memd misses` lists them.

| Variable | Default | Meaning |
|---|---|---|
| `MEMD_MISS_THIN_BELOW` | `3` | Fewer hits than this counts as thin. |
| `MEMD_MISS_REQUERY_WINDOW_S` | `120` | A similar query within this window counts as a re-query. |
| `MEMD_MISS_LOG_MAX_BYTES` | `1048576` | Log size cap. |

## Jev (optional, off by default)

| Variable | Default | Meaning |
|---|---|---|
| `MEMD_JEV` | unset (off) | `on`, `1`, `true` or `yes` enables it. Anything else, including a typo, is off. |
| `TYPESAFE_API_KEY` | unset | Required as well as `MEMD_JEV=on`. |
| `MEMD_JEV_SENSITIVE_TERMS` | tax, w-2, 1099, ssn, password, credential, secret, .env, bank, routing, medical, hipaa | Comma-separated regex fragments; a request touching any of them is not sent. An empty value keeps the default. |

While Jev is on, memd counts how often each use calls it, adds its note, is skipped as sensitive, or fails. The
counts go to `jev-usage.jsonl` beside the store, and `memd stats` prints the totals. A line holds a timestamp, the
use and the event; never a query, a fact or an answer.

## Backups

| Variable | Default | Meaning |
|---|---|---|
| `MEMD_BACKUP_LOCK_WAIT_S` | `900` (15 min) | How long `backup` waits for a running `embed` to release the store. |
