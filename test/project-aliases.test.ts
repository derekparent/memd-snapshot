import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

/** config is built at import, so each case reloads it under a controlled env. */
async function load(aliases: string | undefined) {
  if (aliases === undefined) delete process.env.MEMD_PROJECT_ALIASES;
  else process.env.MEMD_PROJECT_ALIASES = aliases;
  vi.resetModules();
  return { ...(await import("../src/config.js")), ...(await import("../src/indexer.js")), ...(await import("../src/scope.js")) };
}
afterEach(() => {
  delete process.env.MEMD_PROJECT_ALIASES;
  vi.resetModules();
});

function repoWithOrigin(url: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memd-alias-"));
  execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "ignore" });
  execFileSync("git", ["-C", dir, "remote", "add", "origin", url], { stdio: "ignore" });
  return dir;
}

describe("MEMD_PROJECT_ALIASES: a renamed repo keeps one project name", () => {
  it("unset: names are what the origin or the path gives", async () => {
    const m = await load(undefined);
    expect(m.config.projectAliases.size).toBe(0);
    expect(m.projectForCwd(repoWithOrigin("git@example.invalid:someone/atlas-lab.git"))).toBe("atlas-lab");
    expect(m.projectFromDir("-Users-alice-Projects-atlas-lab")).toBe("atlas-lab");
  });

  it("the new origin name maps to the old project, for git checkouts, transcript dirs and the caller project", async () => {
    const m = await load("atlas-lab=atlas, relay2 = relay");
    const dir = repoWithOrigin("git@example.invalid:someone/atlas-lab.git");
    expect(m.projectForCwd(dir)).toBe("atlas");
    expect(m.callerProjectFor(dir, {})).toBe("atlas");
    expect(m.projectFromDir("-Users-alice-Projects-atlas-lab")).toBe("atlas");
    expect(m.projectFromDir("-Users-alice--worktrees-relay2-executor")).toBe("relay");
    expect(m.projectFromDir("-Users-alice-Projects-atlas")).toBe("atlas");
    expect(m.projectFromDir("-Users-alice-Projects-atlas-lab-tools")).toBe("atlas-lab-tools"); // whole names only
  });

  it("curated docs of the renamed repo follow the alias too: its files and its memory dir", async () => {
    await load("atlas-lab=atlas");
    const { projectForDoc } = await import("../src/docs.js");
    const { config } = await import("../src/config.js");
    expect(projectForDoc(`${config.projectsRoot}/atlas-lab/CONTEXT.md`)).toBe("atlas");
    expect(projectForDoc(`${os.homedir()}/.claude/projects/-Users-alice-Projects-atlas-lab/memory/notes.md`)).toBe("atlas");
    expect(projectForDoc(`${config.projectsRoot}/relay/CONTEXT.md`)).toBe("relay");
    expect(projectForDoc("/somewhere/else/notes.md")).toBe("docs"); // the fixed tag is not a derived name
  });

  it("is one hop, and malformed pairs are ignored", async () => {
    const m = await load("a=b,b=c,=x,y=,noequals,p=q=r");
    expect(m.canonicalProject("a")).toBe("b");
    expect(m.canonicalProject("b")).toBe("c");
    expect([...m.config.projectAliases.keys()]).toEqual(["a", "b"]);
  });
});
