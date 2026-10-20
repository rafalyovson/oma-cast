#!/bin/bash
# Live Phase 0 acceptance check against the running omarchy-shell.
# Needs the plugin installed (bin/oma-cast install). It shows and hides the
# launcher but never types, so nothing lands in other windows.
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
cli=bin/oma-cast
fail=0
pass() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; fail=1; }

echo "doctor"
$cli doctor | sed 's/^/  /' || fail=1

echo "ipc"
[[ $($cli call system.healthPing '{}') == '{"ok":true,"data":null}' ]] && pass "system.healthPing round trip" || bad "system.healthPing round trip"
[[ $($cli call foo.bar) == '{"ok":false,"error":"Unknown method foo.bar"}' ]] && pass "unknown methods are errors" || bad "unknown methods are errors"
$cli call settings.getGeneralSettings | grep -q '"popToRootTimeout"' && pass "settings document loaded" || bad "settings document loaded"

echo "root search (Phase 1)"
search() { $cli call rootSearch.search "{\"query\":\"$1\"}"; }
first() { search "$1" | python3 -I -c 'import json,sys; d=json.load(sys.stdin); print(d["data"][0]["rows"][0]["title"] if d["ok"] and d["data"] else "")'; }
[[ $(first nightlight) == "Nightlight" ]] && pass "Omarchy menu items are searchable (nightlight)" || bad "Omarchy menu items are searchable (nightlight)"
[[ $(first "") != "" ]] && pass "empty root has sections" || bad "empty root has sections"
search zzzz-no-match | grep -q '"id":"fallback-commands"' && pass "fallback section for unmatched queries" || bad "fallback section for unmatched queries"
count=$($cli call system.info | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["data"]["candidates"])')
(( count > 300 )) && pass "$count candidates (apps + Omarchy menu)" || bad "only $count candidates"

# Nearest rank. 21 samples: median is the 11th, p95 is the 20th.
percentile_stats() {
  local -a sorted
  mapfile -t sorted < <(printf '%s\n' "$@" | sort -n)
  local n=${#sorted[@]}
  (( n > 0 )) || return 1
  local mid=$(( (n - 1) / 2 ))
  local p95=$(( (95 * n + 99) / 100 - 1 ))
  (( p95 < 0 )) && p95=0
  (( p95 >= n )) && p95=$(( n - 1 ))
  printf '%s %s\n' "${sorted[$mid]}" "${sorted[$p95]}"
}

# First event of this kind at or after `since`. Line order is not a run number:
# an earlier closelayer must not be read as a later show.
match_event() {
  local kind=$1 since=$2 ts name
  while read -r ts name _; do
    [[ $name == "$kind" ]] || continue
    if (( ts >= since )); then
      printf '%s\n' "$ts"
      return 0
    fi
  done < "$events"
  return 1
}

latency_self_check() {
  local got events
  got=$(percentile_stats 10 30 20 40 50)
  [[ $got == "30 50" ]] && pass "latency median and p95" || bad "latency median and p95 ($got)"
  got=$(percentile_stats 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21)
  [[ $got == "11 20" ]] && pass "latency n=21 median and p95" || bad "latency n=21 median and p95 ($got)"
  events=$(mktemp)
  printf '%s\n' "100 openlayer" "200 closelayer" "300 openlayer" >"$events"
  [[ $(match_event openlayer 150) == 300 ]] && pass "latency matches the next event, not the line number" || bad "latency matches the next event, not the line number"
  rm -f "$events"
}

echo "latency helpers"
latency_self_check

echo "toggle latency (21 toggles; median and p95; budget 100 ms after the CLI baseline)"
sock="${XDG_RUNTIME_DIR:-}/hypr/${HYPRLAND_INSTANCE_SIGNATURE:-}/.socket2.sock"
if [[ -z ${HYPRLAND_INSTANCE_SIGNATURE:-} || ! -S $sock ]]; then
  echo "  skip  no Hyprland socket; median and p95 were not collected"
else
  # The clock starts as the CLI is spawned, so a healthPing pass measures that
  # startup and is subtracted. The layer event is the first one at or after
  # that stamp. Each toggle hides as soon as the layer maps, which is before
  # the 500 ms refresh deferral, so the timer itself does not fire during a
  # sample. That hide runs the pending refresh, and the next toggle can
  # overlap those scripts. The recorded time still ends at the layer event.
  events=$(mktemp)
  fifo=$(mktemp -u)
  mkfifo "$fifo"
  socat_pid=""
  reader_pid=""
  cleanup_latency() {
    trap - EXIT INT TERM
    if [[ -n ${reader_pid:-} ]]; then kill "$reader_pid" 2>/dev/null || true; fi
    if [[ -n ${socat_pid:-} ]]; then kill "$socat_pid" 2>/dev/null || true; fi
    if [[ -n ${reader_pid:-} ]]; then wait "$reader_pid" 2>/dev/null || true; fi
    if [[ -n ${socat_pid:-} ]]; then wait "$socat_pid" 2>/dev/null || true; fi
    rm -f "${events:-}" "${fifo:-}"
    $cli hide >/dev/null 2>&1 || true
  }
  on_interrupt() {
    cleanup_latency
    exit 130
  }
  trap cleanup_latency EXIT
  trap on_interrupt INT TERM
  : >"$events"
  socat -u "UNIX-CONNECT:$sock" - >"$fifo" 2>/dev/null &
  socat_pid=$!
  while IFS= read -r line; do
    case $line in *layer\>\>oma-cast*) printf '%s %s\n' "$(date +%s%N)" "${line%%>>*}" >>"$events" ;; esac
  done <"$fifo" &
  reader_pid=$!
  sleep 0.2
  $cli hide >/dev/null 2>&1 || true

  pings=()
  for _ in $(seq 1 21); do
    t0=$(date +%s%N)
    $cli call system.healthPing '{}' >/dev/null
    pings+=($(( ($(date +%s%N) - t0) / 1000000 )))
  done

  shows=()
  hides=()
  missed=0
  for i in $(seq 1 21); do
    t0=$(date +%s%N)
    $cli show >/dev/null
    open=""
    for _ in $(seq 1 100); do
      open=$(match_event openlayer "$t0" || true)
      [[ -n $open ]] && break
      sleep 0.01
    done
    t1=$(date +%s%N)
    $cli hide >/dev/null
    close=""
    for _ in $(seq 1 100); do
      close=$(match_event closelayer "$t1" || true)
      [[ -n $close ]] && break
      sleep 0.01
    done
    if [[ -z $open || -z $close ]]; then
      bad "run $i: no layer event seen"
      missed=1
      continue
    fi
    shows+=($(( (open - t0) / 1000000 )))
    hides+=($(( (close - t1) / 1000000 )))
  done

  # One show that stays up until the deferred refresh has started, then a
  # following show. Reported on its own, not folded into the 21 toggles.
  t_hold=$(date +%s%N)
  $cli show >/dev/null
  held=""
  for _ in $(seq 1 100); do
    held=$(match_event openlayer "$t_hold" || true)
    [[ -n $held ]] && break
    sleep 0.01
  done
  sleep 0.7
  $cli hide >/dev/null
  t_follow=$(date +%s%N)
  $cli show >/dev/null
  followed=""
  for _ in $(seq 1 100); do
    followed=$(match_event openlayer "$t_follow" || true)
    [[ -n $followed ]] && break
    sleep 0.01
  done
  $cli hide >/dev/null
  if [[ -n $followed ]]; then
    refresh_show=$(( (followed - t_follow) / 1000000 ))
  else
    refresh_show=""
  fi

  if (( missed == 0 )); then
    read -r ping_med ping_p95 < <(percentile_stats "${pings[@]}")
    read -r show_med show_p95 < <(percentile_stats "${shows[@]}")
    read -r hide_med hide_p95 < <(percentile_stats "${hides[@]}")
    printf '        healthPing baseline  median %4d ms  p95 %4d ms\n' "$ping_med" "$ping_p95"
    printf '        show (raw)           median %4d ms  p95 %4d ms\n' "$show_med" "$show_p95"
    printf '        hide (raw)           median %4d ms  p95 %4d ms\n' "$hide_med" "$hide_p95"
    printf '        show minus baseline  median %4d ms  p95 %4d ms\n' "$(( show_med - ping_med ))" "$(( show_p95 - ping_med ))"
    printf '        hide minus baseline  median %4d ms  p95 %4d ms\n' "$(( hide_med - ping_med ))" "$(( hide_p95 - ping_med ))"
    echo "        note: the 21 toggles hide when the layer maps, before the 500 ms deferral."
    echo "        that hide runs the pending refresh, so a later toggle can overlap the scripts."
    echo "        those times stop at the layer event and do not wait for the scripts to finish."
    if [[ -n $refresh_show ]]; then
      printf '        show after the refresh had started: %4d ms\n' "$refresh_show"
    else
      echo "        show after the refresh had started: no layer event"
    fi
    # Two passes, with oma-cast reload between them, compare main and this
    # branch. Alternating every toggle would reload QML and time the reload.
    show_adj=$(( show_p95 - ping_med ))
    hide_adj=$(( hide_p95 - ping_med ))
    if (( show_adj < 100 && hide_adj < 100 )); then
      pass "toggle p95 under 100 ms after the CLI baseline"
    else
      bad "toggle p95 under 100 ms after the CLI baseline"
    fi
  fi
  cleanup_latency
fi

exit $fail
