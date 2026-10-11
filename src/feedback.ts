import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { buildInfo } from "./search.js";

/**
 * Session-wrap feedback.
 *
 * Modelled on a similar wrap-up feedback flow from a paired builder/reviewer
 * setup, with the two deltas that make it memd's rather than a copy:
 *
 *  1. THE GATE IS SURPRISE, NOT USAGE. That flow fires on paired sessions — a
 *     handful of sessions a week. memd is used by every session in every repo
 *     on this machine, so a "did you use memd" gate would fire always and bury
 *     the signal in "worked fine" files nobody reads. Silence is the correct
 *     default here; the exception is the signal.
 *
 *  2. THE PAYLOAD IS RETRIEVAL QUALITY, NOT FEELINGS. That flow is about how
 *     tooling felt; this is about what came back, which is worthless without
 *     the inputs. The literal query string, observed vs expected, how it was
 *     resolved, and the build stamp are mandatory — the field findings doc was
 *     usable precisely because every finding carried its exact query.
 *
 * Files live next to the DB (~/.claude/memd/feedback), NOT in the repo:
 * feedback comes from sessions in every repo, most of which are not memd.
 */

export interface FeedbackOptions {
  project: string;
  arc: string;
  /** Override the destination root (tests). */
  root?: string;
  /** Override the date stamp (tests); ISO yyyy-mm-dd. */
  date?: string;
}

export function feedbackRoot(root?: string): string {
  return root ?? path.join(path.dirname(config.dbPath), "feedback");
}

function reviewedRoot(root?: string): string {
  return path.join(feedbackRoot(root), "reviewed");
}

/**
 * Filesystem-safe slug. Dots are dropped, not just separators: a project value
 * of "../../etc" survives slash-stripping as "..-..-etc", which cannot escape
 * path.join but has no business being a filename.
 */
function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

const TEMPLATE = `## What surprised me
<!-- Five entries max. Concrete over felt. Each entry MUST carry all four
     fields below — a report without the literal query cannot be acted on. -->

### 1. <one-line summary>
- **query** (literal, not a paraphrase): \`\`
- **observed**: what came back
- **expected**: what should have
- **resolved by**: unscoped retry / direct SQL / gave up / asked a human / n/a

## What worked
<!-- Keep this. A retrieval that measurably SAVED a re-explanation is the
     entry that tells the pair what NOT to regress. -->
-
`;

export interface FeedbackFile {
  path: string;
  name: string;
}

/** Create a feedback file and return its path. Never overwrites. */
export function newFeedback(opts: FeedbackOptions): FeedbackFile {
  const dir = feedbackRoot(opts.root);
  fs.mkdirSync(dir, { recursive: true });
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const base = `${date}-${slug(opts.project)}`;
  let name = `${base}.md`;
  let n = 2;
  while (fs.existsSync(path.join(dir, name))) name = `${base}-${n++}.md`;
  const file = path.join(dir, name);
  const front = [
    "---",
    `project: ${opts.project}`,
    `arc: ${opts.arc.replace(/\n/g, " ")}`,
    `date: ${date}`,
    `build: ${buildInfo()}`,
    "---",
    "",
  ].join("\n");
  fs.writeFileSync(file, front + TEMPLATE);
  return { path: file, name };
}

/** Pending (untriaged) feedback files, newest first. */
export function listFeedback(root?: string): FeedbackFile[] {
  const dir = feedbackRoot(root);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse()
    .map((name) => ({ name, path: path.join(dir, name) }));
}

/**
 * Move a triaged file into reviewed/. Mirrors a similar triage flow
 * elsewhere: a reviewer drains pending files into a findings area, then
 * marks them consumed so the same friction is not re-triaged next session.
 */
export function consumeFeedback(name: string, root?: string): string {
  const src = path.join(feedbackRoot(root), path.basename(name));
  if (!fs.existsSync(src)) throw new Error(`no pending feedback file named ${path.basename(name)}`);
  const dir = reviewedRoot(root);
  fs.mkdirSync(dir, { recursive: true });
  let dest = path.join(dir, path.basename(name));
  let n = 2;
  while (fs.existsSync(dest)) dest = path.join(dir, path.basename(name, ".md") + `-${n++}.md`);
  fs.renameSync(src, dest);
  return dest;
}

/** Home-relative display path, so output is readable and machine-agnostic. */
export function tilde(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}
