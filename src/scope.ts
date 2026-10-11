import os from "node:os";
import path from "node:path";
import { config } from "./config.js";
import { projectForCwd, projectsRootName } from "./indexer.js";

/**
 * The project a session is working in, for ranking only (search's
 * `callerProject`). The MCP server is spawned per session in the session's
 * launch directory, so its cwd names the caller's project; the indexer's own
 * cwd-to-project rule (git-resolved) keeps the name identical to the one its
 * transcripts are tagged with.
 *
 * Undefined, which means "rank exactly as before", when:
 *  - MEMD_CALLER_PROJECT is none/off/0/false or empty (set to a name, it wins);
 *  - the cwd is not a project: "/", the home dir, or the projects root
 *    (MEMD_PROJECTS_ROOT, default ~/Projects: bare `claude` launched in the
 *    parent dir works across every repo).
 *
 * `home` is only the home-dir exclusion above (tests pass a throwaway one);
 * the projects root always comes from config.
 */
export function callerProjectFor(cwd: string, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | undefined {
  const forced = env.MEMD_CALLER_PROJECT;
  if (forced !== undefined) {
    const v = forced.trim();
    return !v || /^(none|off|0|false|no)$/i.test(v) ? undefined : v;
  }
  const dir = path.resolve(cwd);
  const notProjects = ["/", home, config.projectsRoot].map((d) => path.resolve(d));
  if (notProjects.includes(dir)) return undefined;
  const p = projectForCwd(dir).trim();
  // The indexer's names for "no project" (a cwd of /, or the projects root).
  return p && !["-", "root", projectsRootName()].includes(p) ? p : undefined;
}

/**
 * One line telling the reader the ranking leaned toward their project. Pass
 * search's effectiveScope(), not the raw caller project: an explicit project
 * filter, or a caller project with no rows, means nothing was scoped.
 */
export function scopeNote(applied: string | undefined): string | undefined {
  if (!applied) return undefined;
  return `NOTE: ranked toward "${applied}" (this session's working directory); every other project was searched too. Pass project to restrict, or project="${applied}" to see only it.`;
}
