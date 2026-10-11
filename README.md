# memd

> **Experimental snapshot.** Frozen at this commit and not maintained: no fixes, no releases, no support. The
> [issues](https://github.com/derekparent/memd-snapshot/issues) are the honest record of what is known to be wrong.

Ranked search over every Claude Code (and Codex) session on your machine, plus a small ledger of decisions that
knows which version is current. Any session can ask "what did we already do about X?" across all projects and all
time, and get the current answer first.

## What it adds to Claude Code

Claude Code already has memory: `CLAUDE.md` and auto-maintained memory files, memory shared across a repo's
worktrees, compaction summaries, and a resume picker that spans projects. memd does not replace any of that. It adds:

- **One searchable index of what was said and done**, across every project and both Claude Code and Codex
  sessions, ranked by relevance rather than browsed by session.
- **A versioned statement ledger.** Decisions, rulings and constraints are saved on purpose. When one changes,
  `mem_supersede` replaces it: current facts are returned first, and a search phrased in an old wording resolves to
  the current version and says it did.
- **Local retrieval with no extraction model.** SQLite full-text search plus local embeddings; nothing decides for
  you what is true.
- **A restoration brief across compaction**, written by a `PreCompact` hook and injected by a `SessionStart` hook.
- **Ingest-time redaction** of keys, tokens and passwords, and a log of its own likely retrieval misses.

## How it works

```
~/.claude/projects/**/*.jsonl        Claude Code transcripts (and ~/.codex/sessions)
        |  incremental indexer, redacted before storage
        v
~/.claude/memd/memd.db               SQLite, WAL
   episodes     transcript excerpts, full-text (FTS5)
   vec_episodes local embeddings (bge-small via sqlite-vec)
   facts        the ledger: kind, importance, valid_from / valid_to, superseded_by
   relations    labelled edges between facts or episodes
   docs         curated files (memory dirs, CONTEXT.md, ...) indexed as their current content
   checkpoints  pre-compaction restoration briefs
        |
        +-- MCP server (stdio): mem_search, mem_save, mem_supersede, mem_forget, mem_relate,
        |                       mem_graph, mem_timeline, mem_checkpoint, mem_checkpoints, mem_stats
        +-- CLI (dist/cli.js):  index, embed, search, facts, checkpoint, restore, backup,
                                sweep-redaction, rebuild-fts, stats, ...
```

**It is an excerpt index, not a verbatim archive.** Messages are stored in full, but tool inputs are cut at 1,500
characters, tool outputs at 4,000, outputs under 40 characters are dropped, and thinking blocks and images are
skipped. The transcripts themselves stay where Claude Code wrote them.

**Retrieval** runs keyword search (BM25) and vector search, fuses them by reciprocal rank, and scores each
candidate:

```
score = s × d × fused × (1 + w_rec × 2^(−age / half-life) + w_imp × importance / 10)
```

`d` is 0.75 when a fact was reached through an older, superseded wording and 1 otherwise; `s` is 1.5 for a
transcript excerpt from the calling session's own project and 1 otherwise; `w_rec` and `w_imp` default to 0.2 and
the half-life to 30 days. Relevance gates the other signals, so an off-topic important fact can't outrank an
on-topic answer. An optional local cross-encoder reranks the top candidates. Results are packed under a token
budget: current facts and docs first, then the transcript history that supports them.

**Your own project ranks first.** The MCP server starts in the session's working directory, so `mem_search` knows
which project is asking. With no `project` filter, that project's transcript excerpts get a second keyword pass and
the 1.5 boost. Every other project is still searched, facts and docs are never boosted, and a query that names
another known project is ranked as if no one in particular had asked. The response says when the ranking leaned
this way. `MEMD_CALLER_PROJECT=none` turns it off.

**Corrections, and their limits.** Supersession applies to facts. A transcript excerpt that quotes an old ruling can
still appear in the history section. It is marked `QUOTES SUPERSEDED fact #N` when it repeats at least 17
consecutive words of a wording that a fact in the same response has since replaced; a shorter or reworded echo is
not marked. The facts section is where the current answer lives. The ledger is only as current as the sessions that
call `mem_supersede`.

**Relations are a light layer.** `mem_relate` records a labelled edge and `mem_graph` lists a fact's direct
neighbours. Search reads one kind of edge, `contradicts`, to mark a fact as contested. There is no traversal, entity
resolution or automatic edge extraction; this is not a knowledge graph.

**Redaction at ingest.** Cloud and API keys, JWTs, bearer tokens, private-key blocks, password-style key/value pairs,
SSN shapes and Luhn-valid card numbers are stripped from the whole text before it is cut or chunked. It is
pattern-based and best-effort; see [docs/how-it-works.md](docs/how-it-works.md#redaction) for what it misses.

## Install

Requires Node 20.19 or later (22.12 or later on the 22 line) and Claude Code. This snapshot was built and used daily
on macOS (arm64) with Node 25. Its test suite also passed on Node 20 and 22, on macOS (arm64) and Linux (x64), in the
workflow under `.github/`. On Linux only the test suite was run. Windows is untested.

```sh
git clone https://github.com/derekparent/memd-snapshot memd && cd memd
npm ci && npm run build      # npm ci installs exactly what package-lock.json pins
node dist/cli.js index          # first sweep of ~/.claude/projects
node dist/cli.js prefetch       # download the two local models now, with progress (about 133 MB + 91 MB)
node dist/cli.js embed          # local embeddings for what was indexed
node dist/cli.js stats          # what got indexed

# register the MCP server for every project (user scope); use the absolute path
claude mcp add --scope user memd -- node "$PWD/dist/server.js"
```

Use `npm ci`, not `npm install`: under npm 10, `npm install` rewrites `package-lock.json`.

Then add the hooks to `~/.claude/settings.json`: [docs/hooks.md](docs/hooks.md) has the exact JSON. Optionally,
schedule a nightly index and weekly backup: [docs/scheduling.md](docs/scheduling.md).

The store lives at `~/.claude/memd/memd.db` (override with `MEMD_DB_PATH`). Backups and the miss log live beside
it; the model cache is at `~/.claude/memd/models`. All settings: [docs/configuration.md](docs/configuration.md).

With nothing to index yet (a new machine, or no Claude Code sessions so far), `index` reports zero files and `embed`
has nothing to do. That is a working install; the store fills as sessions happen.

**The model download.** A model is downloaded into a staging directory and moved into the cache only when it is
whole, so a dropped connection never leaves half a model behind. When a download fails, the command says so, names
the model and the cache path, and exits 1; run it again, or `prefetch`, when the network is back. Search works on
keywords alone until the model is there, and `stats` tells you which state you are in without downloading anything.
`MEMD_OFFLINE=1` (or `--offline`) never downloads: with nothing cached, `embed` says so and search stays lexical.

## Using it

- Before asking the user to re-explain prior work: `mem_search "<what you need>"`.
- After a decision that other sessions should respect: `mem_save` with an importance of 7 or more.
- When a decision changes: `mem_supersede`, not a second save.
- `mem_stats` shows what's indexed. `mem_timeline` shows a project's history in order.

A line in your global `~/.claude/CLAUDE.md` telling sessions to do the above is what makes them actually use it.

## What leaves your machine

By default, nothing except the one-time model downloads from Hugging Face (both on `prefetch`; otherwise the
embedding model on first `embed` and the reranker on first rerank).

**Optional: Jev.** memd can ask TypeSafe's Jev model small yes/no questions to add notes to results. It is **off
unless you set both `MEMD_JEV=on` and `TYPESAFE_API_KEY`**. When on, it sends, after a second redaction pass:

| Use | Sent |
|---|---|
| Stale-ruling note on `mem_search` (ruling-shaped queries) | the query and up to 6 result excerpts, 500 characters each |
| Conflict warning on `mem_save` | the new fact and the similar active facts it matched |
| Miss judge on the miss log | the query and up to 5 result excerpts, 600 characters each |

Any request whose text touches the sensitive-topic list (tax, medical, credentials, banking, ...) is not sent. Jev
only adds a note; it never hides, reorders or blocks anything.

## Docs

- [docs/how-it-works.md](docs/how-it-works.md): the data model, retrieval, supersession, redaction
- [docs/hooks.md](docs/hooks.md): the Claude Code hook JSON
- [docs/configuration.md](docs/configuration.md): every environment variable
- [docs/scheduling.md](docs/scheduling.md): nightly index, weekly backup
- [RELEASE-NOTES.md](RELEASE-NOTES.md): what this snapshot contains, and its known limitations

## Tests

```sh
npm test
```

The suite runs under a throwaway home directory and one temporary directory that it removes, so it never reads or
writes your real `~/.claude`. It uses at most four worker processes. An interrupted run (Ctrl-C, `kill`) stops its
workers and removes its temporary directory; `kill -9` cannot be caught and leaves both behind. `test/interrupt/run.sh`
checks that, one signal at a time.

## Non-goals

- A hosted memory service. The store is one local SQLite file you can inspect.
- Deciding what matters for you. Facts are saved deliberately by the sessions that write them; the excerpt index
  keeps the rest.

## Status

**This is an experimental snapshot.** memd is a working tool that one person runs every day on one machine,
published as it stands. The MCP tool arguments, the CLI flags and the SQLite schema can change without notice, and
there is no support or upgrade promise. Redaction is best-effort and the store holds your transcripts, so read the
known limitations in [RELEASE-NOTES.md](RELEASE-NOTES.md) before you point it at anything sensitive.

The code was exported from a private working repo; the public history starts here.

## License

MIT, see [LICENSE](LICENSE).
