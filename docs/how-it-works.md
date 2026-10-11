# How memd works

## Two layers

**Episodes** are chunks of every transcript: what was actually said and done. Messages are kept in full; tool inputs
are cut at 1,500 characters, tool outputs at 4,000, outputs under 40 characters are dropped, and thinking blocks and
images are skipped, so this is an excerpt index, not an archive. Episodes are only rewritten by the redaction
sweep. The
indexer reads each transcript from the byte offset where it last stopped (transcripts are append-only), so re-runs
are cheap. A torn last line, from a transcript still being written, is left for the next sweep.

**Facts** are a small, curated ledger that sessions write on purpose with `mem_save`. Each has a kind (`fact`,
`decision`, `preference`, `constraint`, `todo`, `ruling`, `feedback`), an importance from 1 to 10, a project, and a
validity window (`valid_from`, `valid_to`).

A third, smaller layer, **docs**, indexes a fixed set of curated files (per-project memory directories, `CONTEXT.md`,
`DECISIONS.md`, skills) as their current content. Each `memd index` pass (the startup hook, a scheduled job, or by
hand) re-reads every file whose modification time changed, so a doc hit is the file as of the last pass, not a live
read. The set is a curation choice, not a mirror of your repos; see `MEMD_DOC_ROOTS` in
[configuration.md](configuration.md).

## Supersession: corrections win

Decisions change. `mem_supersede(old_id, new content)` closes the old fact's validity window and links its
replacement. At search time, every fact hit is resolved to the head of its supersede chain, so a query phrased in the
old wording still lands on the current answer, and the response says the match came through an older version.
`mem_forget` retracts a fact saved in error without a successor. Nothing is deleted; the chain stays auditable.

Supersession applies to facts only. A transcript excerpt that quotes an old ruling is still returned in the history
section; current facts are packed ahead of it. Such an excerpt is marked `QUOTES SUPERSEDED fact #N` when all of
these hold: the current fact is in the same response, the excerpt is older than the supersede, it repeats at least
17 consecutive words of the replaced wording (words the current fact kept do not count), and it does not also quote
the new wording. The marker is only added; it never reorders or removes a hit. A shorter or reworded echo is not
marked. Each supersede also records a `supersedes` edge in
`relations`, but retrieval follows the `superseded_by` pointer, not that edge. `valid_from` is when the fact was
saved, not when the decision was made. The ledger is only as current as the sessions that call `mem_supersede`.

If Jev is enabled (see [configuration.md](configuration.md)), a ruling-shaped query whose results disagree gets a note
naming the newest current passage and the passages that conflict. Without Jev there is no such note.

`feedback` facts record friction with memd itself. They are hidden from ordinary searches unless the query is about
memd or a retrieval miss.

## Relations

`mem_relate` adds a labelled, directed edge between two facts or episodes (`depends_on`, `blocks`, `derived_from`,
`contradicts`, or any verb you choose), and `mem_graph` lists a fact's direct neighbours. One edge type is read by
search: a fact hit linked by `contradicts` to another still-active fact is marked as contested, with the count; this
is a label added after ranking, not a ranking signal. `mem_save` warns when a new fact looks similar to an active one,
so the writer can supersede it or relate it instead.

This is a light layer. Edges are added deliberately, nothing traverses them, and there is no entity resolution or
automatic edge extraction. It is a versioned statement ledger with provenance links, not a knowledge graph.

## Retrieval

`mem_search` runs:

1. **Keyword**: SQLite FTS5 with BM25 over episodes, facts and docs.
2. **Vector**: nearest neighbours over local embeddings (`bge-small-en-v1.5`, 384 dimensions, via `sqlite-vec`).
3. **Fusion**: reciprocal-rank fusion of the two lists.
4. **Scoring**: `s * d * fused * (1 + w_rec * 2^(-age / halflife) + w_imp * importance / 10)`, where `d` is 0.75
   for a fact reached through an older, superseded wording and 1 otherwise, and `s` is the caller-project boost
   described below. Relevance multiplies the other signals, so recency and importance only reorder within a
   relevance band. A fact or doc must share enough words with the query to claim a slot in the current section, so a
   purely semantic fact match can be dropped there.
5. **Rerank** (optional): a local cross-encoder over the top candidates.
6. **Packing**: current facts first, then supporting history, greedily packed under a token budget. Each item carries
   its provenance: source, project, date, id.

Filters: `project`, `sources` (episodes, facts, docs), `origin` (`claude` or `codex`; any other value is refused).

### Caller-project ranking

The MCP server is started in the session's working directory, and memd names that project the same way the indexer
tags its transcripts. When `mem_search` is called with no `project` filter and that project has rows:

- the keyword leg runs a second time over that project's episodes only, so a small project is not crowded out of
  the candidate list by a big one;
- its episodes score `s = 1 + MEMD_SCOPE_BOOST` (1.5 by default); everything else scores `s = 1`.

Facts and docs are never scoped or boosted, no other project's hit is removed, and there is no project-scoped
vector pass. If the query names another known project, the search ranks as if there were no caller project. A
scoped response ends with a `NOTE: ranked toward "<project>"` line. A session started in `/`, the home directory or
`MEMD_PROJECTS_ROOT` has no caller project. `MEMD_CALLER_PROJECT` overrides the name, or turns this off.

## Compaction survival

Before Claude Code compacts a session, the `PreCompact` hook runs `memd checkpoint --precompact`: it indexes the
transcript so far and writes a brief of recent requests, last state, git status and files touched. When the session
resumes or finishes compacting, the `SessionStart` hook runs `memd restore`, which returns that brief as
`additionalContext`. Hooks fire whether or not the model thinks to save anything. See [hooks.md](hooks.md).

## Redaction

Everything is redacted at ingest, on the whole text before any truncation or chunking: cloud and API keys (AWS,
GitHub, Anthropic, OpenAI, Google, Slack), JWTs, bearer tokens, private-key blocks (including one whose END line never
arrived), password-style key/value pairs, SSN shapes and Luhn-valid card numbers. Search queries get a stricter pass
before they are logged.

`memd sweep-redaction` re-applies the current rules to episodes, facts and docs already stored (dry run unless
`--apply`). It takes a backup first, drops stale embeddings, and ends with a full rebuild of the full-text indexes so no
redacted term stays searchable. The backup it takes still holds the unredacted text; delete it once you have checked
the result. `memd rebuild-fts` re-derives the full-text indexes from current content on its own, which is the repair
for a store rewritten by an older version.

Redaction is pattern-based and best-effort. Known gaps: a secret with no recognisable shape (a password in prose), a
multi-line YAML block scalar (`password: >`), connection strings, and personal data beyond SSNs and card numbers.

An unquoted `key=value` pair is redacted only where a config file would put it: the key starts its line (after
optional indentation, a `- ` list marker or `export`) or follows `{`, `,` or `[`, and the value ends the line (a
trailing comma, full stop or comment is fine). Anywhere else the value is stored as written, unless it has the shape of
a known key: inside a sentence (`Set api_key=abc123… in the env and restart`, `the old config used password=abc123…`)
or in front of a command (`API_KEY=abc123… npm start`). A value in quotes is redacted wherever it sits.

Treat the store as sensitive: it holds your transcripts.

## Storage and safety

One SQLite file in WAL mode. Embedding runs hold a lock file so a backup never snapshots mid-write. `memd backup`
uses `VACUUM INTO` plus `quick_check`, never a file copy. `memd quarantine` hides a session's episodes from
retrieval, reversibly (`--off`).

## What stays local

The store, the models and every search stay on your machine. The models are downloaded once from Hugging Face. The
only outbound path is the optional Jev judgment, off unless `MEMD_JEV=on` and `TYPESAFE_API_KEY` are both set; the
README lists exactly what it sends. It re-redacts everything first and never sends a request that touches the
sensitive-topic list.
