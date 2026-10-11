#!/bin/bash
# The interrupt check: start the two-file suite in test/interrupt, wait until
# both workers and both of their children are alive, send ONE signal to the
# vitest parent, and report whether those exact processes and the run's temp
# root are gone within 10 seconds.
#
#   test/interrupt/run.sh INT|TERM|HUP|KILL [gap-ms]
#
# With a gap, the same signal is sent a second time that many milliseconds
# after the first (a double Ctrl-C).
#
# One signal per call, never in a loop: a run that loses its parent used to
# leave its workers spinning, and a loop of those took a machine down. Whatever
# the result, everything the run started is killed before the script returns.
# Exit 0: nothing left. Exit 1: something survived (listed). Exit 2: not run.
set -u
sig="${1:-}"
gap="${2:-}"
case "$sig" in INT|TERM|HUP|KILL) ;; *) echo "usage: $0 INT|TERM|HUP|KILL [gap-ms]" >&2; exit 2 ;; esac
case "$gap" in ""|*[!0-9]*) [ -z "$gap" ] || { echo "gap-ms must be a number" >&2; exit 2; } ;; esac
repo="$(cd "$(dirname "$0")/../.." && pwd -P)"
cd "$repo" || exit 2

# vitest workers whose working directory is this checkout
mine() {
  for p in $(pgrep -f 'node \(vitest' 2>/dev/null); do
    lsof -a -d cwd -p "$p" -Fn 2>/dev/null | grep -qx "n$repo" && echo "$p"
  done
}
alive() { for p in "$@"; do kill -0 "$p" 2>/dev/null && echo "$p"; done; }

echo "before: $(uptime | sed 's/.*load/load/')"
if [ -n "$(mine)" ]; then echo "not run: vitest workers already running here: $(mine | tr '\n' ' ')" >&2; exit 2; fi

work="$(mktemp -d /tmp/mi.XXXXXX)"
mkdir "$work/home" "$work/tmp" "$work/report"
set -m # the run gets its own process group, so the cleanup below can take all of it
HOME="$work/home" TMPDIR="$work/tmp" MEMD_INTERRUPT_REPORT="$work/report" \
  node node_modules/vitest/vitest.mjs run --config test/interrupt/vitest.config.ts >"$work/log" 2>&1 &
parent=$!
set +m

cleanup() {
  trap - INT TERM HUP
  kill -9 -- "-$parent" 2>/dev/null
  for p in ${watched:-} $(mine); do kill -9 "$p" 2>/dev/null; done
  sleep 1
  left="$(mine)"
  echo "after cleanup: workers here ${left:-none}; $(uptime | sed 's/.*load/load/')"
  rm -rf "$work"
}
# the run is in its own group, so a signal to this script would not reach it
trap 'echo "interrupted" >&2; cleanup; exit 2' INT TERM HUP

for _ in $(seq 60); do
  [ -f "$work/report/a.pids" ] && [ -f "$work/report/b.pids" ] && break
  kill -0 "$parent" 2>/dev/null || break
  sleep 0.5
done
if ! [ -f "$work/report/a.pids" ] || ! [ -f "$work/report/b.pids" ]; then
  echo "not run: the fixtures never reported in" >&2; tail -20 "$work/log" >&2; cleanup; exit 2
fi
workers="$(awk '$1=="worker"{print $2}' "$work"/report/*.pids | tr '\n' ' ')"
children="$(awk '$1=="child"{print $2}' "$work"/report/*.pids | tr '\n' ' ')"
watched="$workers $children"
echo "alive at the signal: parent $parent; workers $(alive $workers | tr '\n' ' '); children $(alive $children | tr '\n' ' ')"
echo "roots at the signal: $(find "$work/tmp" -maxdepth 1 -name 'memd-test-*' | wc -l | tr -d ' ')"
if [ "$(alive $watched | wc -l | tr -d ' ')" != 4 ]; then
  echo "not run: expected 2 workers and 2 children alive" >&2; cleanup; exit 2
fi

kill "-$sig" "$parent"
echo "sent SIG$sig to $parent"
if [ -n "$gap" ]; then
  sleep "$(awk "BEGIN{print $gap/1000}")"
  if kill "-$sig" "$parent" 2>/dev/null; then echo "sent SIG$sig again after $gap ms"; else echo "second SIG$sig after $gap ms found no process"; fi
fi
status=1
for i in $(seq 20); do
  sleep 0.5
  if [ -z "$(alive $parent $watched)" ] && [ -z "$(find "$work/tmp" -maxdepth 1 -name 'memd-test-*')" ]; then
    echo "clean after ${i} half-seconds: parent, workers and children gone, 0 roots"; status=0; break
  fi
done
if [ -z "$(alive $parent)" ]; then wait "$parent" 2>/dev/null; echo "parent exit code: $?"; fi
if [ "$status" != 0 ]; then
  echo "LEFT after 10 s: processes $(alive $parent $watched | tr '\n' ' '); roots $(find "$work/tmp" -maxdepth 1 -name 'memd-test-*' | wc -l | tr -d ' ')"
fi
cleanup
exit "$status"
