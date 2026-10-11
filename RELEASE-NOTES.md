# memd release notes

## 0.1.0: first public snapshot (experimental)

memd indexes every Claude Code (and Codex) session on one machine into a local SQLite store, with FTS5,
local embeddings and a temporal facts ledger. It serves them back over MCP (`mem_search`, `mem_save`,
`mem_supersede`, `mem_timeline`, checkpoints and more). Nothing leaves the machine unless you opt in to the
optional Jev judge (`MEMD_JEV=on` plus `TYPESAFE_API_KEY`).

**Status: experimental.** This is a snapshot of a tool one person runs every day, exported from a private working
repo in October 2026. The MCP tool arguments, the CLI flags and the store schema can change without notice. There is
no support or upgrade promise.

Built and used daily on macOS (arm64) with Node 25. `package.json` requires Node 20.19 or later (22.12 or later on
the 22 line). The test suite also passed on Node 20 and 22, on macOS (arm64) and Linux (x64); on Linux nothing but
the test suite was run. Windows was not run for this snapshot.

### What this snapshot hardens
- **Redaction at ingest.** Secrets are redacted on the complete text *before* truncation and chunking, on
  every ingest path. That covers token shapes (cloud keys, GitHub, Slack, JWT, bearer, cards by Luhn, SSN,
  private-key blocks), plus key-value secrets: a quoted value after a secret key at any position, a
  hyphenated key (`X-Api-Key`, `--password`), and a literal hidden after an interpolation (`${SALT}hunter2`).
  Only a strict `${NAME}` or an UPPER_SNAKE `$NAME` counts as interpolation.
- **Redaction sweep.** `memd sweep-redaction` rewrites stored rows with the current rules and keeps the
  full-text index in step (update triggers, plus `memd rebuild-fts`).
- **Facts ledger.** Replacement is atomic, an identical supersede is a no-op (a new importance is applied
  in place and reported), and dedupe is scoped by project and kind.
- **Quarantine.** A persisted rule, applied to rows indexed later on every ingest path. Targets match as
  literal text, a backslash included. It also consumes restoration briefs that could carry the hidden text.
  `memd quarantine --list` shows the rules.
- **Checkpoints.** `mem_checkpoint` only indexes a transcript the sweep itself would index (symlinks
  resolved), and refuses a session id the transcript does not belong to. Restore compares timestamps as
  time, not as strings.
- **Indexing.** Subagent and workflow-agent transcripts are indexed. A torn final line is never skipped. For
  Codex, the first line appended by `codex resume` after a crash mid-line is recovered.
- **Vector search.** It covers facts with no embedded episodes, and sizes a filtered KNN by the share of the
  store that the project, the origin, or both together hold. Vector-leg failures show in `mem_stats`.
- **Your own project ranks first.** `mem_search` knows which project the calling session is in (the MCP
  server's working directory). With no `project` filter, that project's transcript excerpts get a second
  keyword pass and score 1.5 times higher. No other project's hit is removed, facts and docs are never
  boosted, and a query that names another known project is ranked unscoped. A scoped response says so.
- **Stale echoes are marked.** A history excerpt that repeats at least 17 consecutive words of a wording a
  fact has since replaced is marked `QUOTES SUPERSEDED fact #N`, when the current fact is in the same
  response. The marker is only added; nothing is reordered or removed.
- **Origin filter.** `--origin` and the `origin` argument accept only `claude` or `codex`. An unknown value
  used to match nothing without saying why; it is now refused, and the value is a bound SQL parameter.
- **Stale-ruling note (Jev).** Two facts saved in the same millisecond are ordered by id, so the note names
  the later one as newest.
- **Jev usage counters.** While Jev is on, memd counts calls, added notes, sensitive-topic skips and errors
  per use in `jev-usage.jsonl` beside the store. A line holds a timestamp, the use and the event, and no
  text. `memd stats` prints the totals.
- **Tests.** The suite drives the built MCP server over stdio. With Jev off, even an inherited API key sends
  nothing. Every test file runs under a throwaway HOME and store, and a global guard refuses any request to
  the Jev service, so a test cannot reach it or a real store by accident.

### Known limitations

**Retrieval**
- Project-filtered vector search: for very small projects (below about 0.1% of embedded rows), even the
  maximum KNN k cannot fetch a full page of the project's own nearest rows (about 30 of 50 at k = 4096). A fix
  needs a per-project vector partition or a pre-filtered scan. An origin filter (for example Codex-only) hits
  the same ceiling when that origin is a very small share of the store.
- Caller-project ranking has no vector pass of its own (it roughly doubled search time for a small gain), so
  it helps a small project through keyword matches only.
- The stale-echo marker needs a 17-word contiguous quote and the current fact in the same response. A
  shorter or reworded echo of an old ruling is returned unmarked.
- Relations (`mem_relate`) are stored and shown by `mem_graph`, but they do not affect ranking.
- The embedding and rerank models are the small local defaults (384-dim). Newer models may retrieve better.
  A model swap needs a re-embed of the store.
- In the model library, the first model that fails to load in a process makes every later load in that process
  fail. A long-running MCP server that meets a broken model file stays on keyword search until it is restarted;
  `memd prefetch` checks and repairs the cache from the command line.
- Two processes that both find the model cache empty both download the model.

**Redaction (ingest)**
- Unquoted mid-sentence values keep the prose defense on purpose. `password hunter2`, `password was X` and
  `password: ${SALT} hunter2` (a space after the interpolation) are not caught.
- An unquoted `key=value` pair is caught only when the key starts its line (or follows `{`, `,`, `[`) and the
  value ends it: `api_key=abc123… in the env`, `the old config used password=abc123…` and
  `API_KEY=abc123… npm start` are stored as written unless the value has the shape of a known key.
- Not caught either: a value containing both quote kinds (`password: "it's"`), a nested default
  (`${A:-${B}}x`), a header whose whole `key: value` is one quoted string (`curl -H 'x-api-key: abc'`), and a
  bare `token:` key.
- Accepted false positives: bare lower-case `$name` values; line-start config keys ending in a secret word
  (`forgot-password: enabled`); code between two string literals after a secret key.
- Multi-line YAML block scalars (`password: >`) are not redacted.
- Rule changes apply at ingest. Existing rows change only when you run `memd sweep-redaction --apply` (then
  `memd embed`). Backups taken before a sweep keep the old text.

**Quarantine**
- Quarantine hides rows from every read surface. It does not scrub them, and consumed restoration briefs
  still hold their text in the store. To remove text, use the redaction sweep or `mem_forget`.
- Quarantines applied with an earlier version were not stored as rules. Re-run them to cover rows indexed
  later.
- `--match` rules are permanent until lifted with `--off`.
- A later rewrite of existing rows (the redaction sweep) does not re-evaluate match rules.

**Indexing**
- A transcript truncated or rotated below its indexed offset is not re-indexed.
- A Claude Code transcript whose last line tore mid-write and was then appended to is not recovered (Codex
  rollouts are).
- The Codex root accepts any `.jsonl` at any depth, not only `rollout-*` files.
- `mem_checkpoint` checks the session id against the transcript for Claude Code transcripts only, not Codex
  rollouts.
- memd writes ISO timestamps. A row carrying SQLite's own format (`YYYY-MM-DD HH:MM:SS`, no zone), for
  example from a hand-edited store, is read as local time by the recency score and the restore window.

**Development**
- The MCP smoke test builds into the repo's own `dist/`. Running the suite inside a checkout that also
  serves your live MCP server rebuilds that server's `dist/` from the working tree.
- Tests that start the CLI go through `tsx`, which opens a socket under `TMPDIR`. With a very long `TMPDIR`
  path they fail with `listen EINVAL`; the system default is fine.
- The suite leaves its throwaway directories (`memd-test-*`) in the temp directory.
