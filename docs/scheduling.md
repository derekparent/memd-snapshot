# Scheduling

The startup hook indexes as sessions begin. A nightly job catches everything else and takes a weekly backup.

The job is three commands. `backup --weekly` runs even if indexing fails, and it only snapshots when a week has passed:

```sh
node /path/to/memd/dist/cli.js index && node /path/to/memd/dist/cli.js embed --limit 20000; node /path/to/memd/dist/cli.js backup --weekly
```

## cron (Linux or macOS)

```
30 4 * * * /bin/sh -c 'node /path/to/memd/dist/cli.js index && node /path/to/memd/dist/cli.js embed --limit 20000; node /path/to/memd/dist/cli.js backup --weekly' >> "$HOME/.claude/memd/nightly-index.log" 2>&1
```

Use the absolute path to `node` if cron's `PATH` doesn't include it.

## launchd (macOS)

Save as `~/Library/LaunchAgents/memd-index.plist`, replace the paths, then
`launchctl load ~/Library/LaunchAgents/memd-index.plist`. In a plist, `&&` must be written `&amp;&amp;`.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>memd-index</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>/usr/local/bin/node /path/to/memd/dist/cli.js index &amp;&amp; /usr/local/bin/node /path/to/memd/dist/cli.js embed --limit 20000; /usr/local/bin/node /path/to/memd/dist/cli.js backup --weekly</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>4</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>/Users/YOU/.claude/memd/nightly-index.log</string>
  <key>StandardErrorPath</key><string>/Users/YOU/.claude/memd/nightly-index.log</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
```

## Backups

`memd backup` writes a `VACUUM INTO` snapshot to `<store dir>/backups/YYYY-MM-DD.db`, checks it with
`PRAGMA quick_check`, and keeps the newest 4 (`--keep N`). It never copies the live file directly: the store runs in
WAL mode, and a plain copy loses whatever is still in the `-wal` file. A failed backup prints `BACKUP FAILED:` and
exits 1, so it shows up in the log.
