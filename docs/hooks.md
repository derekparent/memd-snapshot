# Claude Code hooks

memd survives compaction because Claude Code's hooks run it, not because the model remembers to. Three hook entries
do the work. Add them to `~/.claude/settings.json` (user scope, so they fire in every project), replacing
`/path/to/memd` with the absolute path of your checkout.

```json
{
  "hooks": {
    "PreCompact": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/memd/dist/cli.js checkpoint --precompact",
            "timeout": 60
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "matcher": "compact|resume",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/memd/dist/cli.js restore",
            "timeout": 30
          }
        ]
      },
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "( node /path/to/memd/dist/cli.js index && node /path/to/memd/dist/cli.js embed --limit 500 ) >/dev/null 2>&1 &",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

If your `settings.json` already has a `hooks` object, merge these arrays into it rather than replacing it.

## What each one does

| Hook | Command | Effect |
|---|---|---|
| `PreCompact` | `checkpoint --precompact` | Reads the hook payload on stdin, indexes the session's transcript so far, and writes a restoration brief: recent requests, last state, git status, files touched. |
| `SessionStart` (`compact`, `resume`) | `restore` | Emits the latest unconsumed brief for that session as `additionalContext`, so the compacted or resumed session starts oriented. Also starts a background incremental index. Prints nothing when there is no brief. |
| `SessionStart` (`startup`) | `index && embed --limit 500`, backgrounded | Keeps the store fresh as new sessions start, off the critical path. Optional; a scheduled job does the same (see [scheduling.md](scheduling.md)). |

## Checking it works

```sh
echo '{}' | node /path/to/memd/dist/cli.js restore     # exits 0, prints nothing if there's no brief
node /path/to/memd/dist/cli.js stats                    # checkpoints count rises after a compaction
```

In a session, run `/compact`. After it finishes, the first context the model sees should include the brief.
