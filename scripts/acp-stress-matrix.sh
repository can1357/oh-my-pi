#!/usr/bin/env bash
# Stress-tests the current omp branch's ACP mapper across the
# tool x capability-channel x byte-size matrix that oh-my-pi/oh-my-pi#7078's
# 6-round review exists to prevent regressing again. See
# docs/acp-development.md rules 7-9.
#
# Runs acp-probe's `stress-output` (byte-exactness on the meta-terminal path,
# expected truncation on the fenced-text fallback) and `kill-mid-tool`
# (dangling-replay status) against a real `omp acp` subprocess — this is the
# dev launcher (`scripts/omp`), not the installed binary, so it always
# exercises this checkout's actual source per docs/acp-development.md's
# "Don't run build-binary.ts" rule.
#
set -o pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
omp_root="$(cd "$script_dir/.." && pwd)"
probe_dir="${1:-$omp_root/../acp-probe}"
omp_cmd="${2:-$omp_root/packages/coding-agent/scripts/omp}"

if [ ! -f "$probe_dir/src/acp-probe.ts" ]; then
	echo "acp-stress-matrix: no acp-probe checkout at $probe_dir (pass its path as \$1)" >&2
	exit 2
fi
if [ ! -x "$omp_cmd" ]; then
	echo "acp-stress-matrix: no omp launcher at $omp_cmd (pass its path as \$2)" >&2
	exit 2
fi

export ACP_PROBE_CMD="$omp_cmd"
log_dir="$(mktemp -d)"
pass=0
fail=0
rows=()
total=24
n=0

run_probe() {
	# run_probe <label> <assertion> <probe-args...>
	# assertion: "exit=<N>" compares the subcommand's own exit code (kill-mid-tool);
	#            "min=<N>" requires the probe's own exit code to be 0 *and* the
	#            parsed delivered= to clear a computed floor. `stress-output`'s
	#            exit code is already the authoritative verdict for both the
	#            byte-shortfall axis (it tells an admitted producer-side cap —
	#            bash's 50 KB / eval's 100 KB tail buffer — apart from silent
	#            suppression, exiting 0 with a warn log for the former) and the
	#            append-only axis (any duplicate terminal delivery fails the run
	#            unconditionally, `acp-probe.ts`'s post-switch check). Reading
	#            only `delivered=` and ignoring `$code` (fixed after
	#            oh-my-pi/oh-my-pi#7078 review r3693558608) let a duplicate-resend
	#            regression report PASS here, since a re-sent body inflates
	#            `delivered` rather than shrinking it — the floor is now a
	#            belt-and-suspenders sanity check on top of the exit code, never
	#            a substitute for it.
	local label="$1" assertion="$2"
	shift 2
	n=$((n + 1))
	printf '[%2d/%d] %-28s ' "$n" "$total" "$label"
	local start=$SECONDS
	local log="$log_dir/$label.log" out="$log_dir/$label.out"
	(cd "$probe_dir" && bun run src/acp-probe.ts "$@" --timeout-ms 90000 --log "$log") >"$out" 2>&1
	local code=$?
	local elapsed=$((SECONDS - start))
	local delivered
	delivered=$(grep -o 'delivered=[0-9]*' "$out" | tail -1 | cut -d= -f2)
	local status="OK" detail=""
	case "$assertion" in
	exit=*)
		local want="${assertion#exit=}"
		detail="exit=$code want=$want"
		if [ "$code" != "$want" ]; then status="REGRESSION"; fi
		;;
	min=*)
		local floor="${assertion#min=}"
		detail="exit=$code delivered=${delivered:-0} floor=$floor"
		if [ "$code" != 0 ]; then
			status="REGRESSION"
		elif [ -z "$delivered" ] || [ "$delivered" -lt "$floor" ]; then
			status="REGRESSION"
		fi
		;;
	esac
	if [ "$status" = OK ]; then pass=$((pass + 1)); else fail=$((fail + 1)); fi
	printf '%2ds  %-30s %s\n' "$elapsed" "$detail" "$status"
	rows+=("$(printf '%-28s %-30s %s' "$label" "$detail" "$status")")
}

# Producer-side caps below the ACP wire, not this PR's territory to fix:
# bash's TailBuffer(DEFAULT_MAX_BYTES) and eval's TailBuffer(DEFAULT_MAX_BYTES * 2)
# (streaming-output.ts: DEFAULT_MAX_BYTES = 50 * 1024) truncate before the mapper
# ever sees the rest, with their own "(output truncated)" notice. Asking for more
# than that and expecting full delivery is a test bug, not a wire regression — the
# real assertion past the cap is "did the wire deliver ~the full retained window",
# not "did it deliver the full request".
fenced_cap=4000 # ACP_TEXT_LIMIT (acp-event-mapper.ts) — intentional, not a bug.

echo "stress-output: tool x channel x size"
for tool in bash eval; do
	if [ "$tool" = eval ]; then producer_cap=102400; else producer_cap=51200; fi
	for channel in meta fenced; do
		if [ "$channel" = meta ]; then
			caps=(--meta '{"terminal_output":true}')
			cap=$producer_cap
		else
			caps=()
			cap=$fenced_cap
		fi
		for size in 3000 4096 10000 60000 120000; do
			expected=$size
			[ "$expected" -gt "$cap" ] && expected=$cap
			floor=$((expected - 300)) # slack for notices/fence markup/headers
			[ "$floor" -lt 0 ] && floor=0
			run_probe "$tool-$channel-$size" "min=$floor" stress-output "$size" "$tool" "${caps[@]}"
		done
	done
done

echo
echo "kill-mid-tool: dangling replay status across capability combos"
for combo in none terminal meta both; do
	case "$combo" in
	none) caps=() ;;
	terminal) caps=(--terminal) ;;
	meta) caps=(--meta '{"terminal_output":true}') ;;
	both) caps=(--terminal --meta '{"terminal_output":true}') ;;
	esac
	run_probe "kill-mid-tool-$combo" "exit=0" kill-mid-tool "Use the bash tool to run: sleep 20" "${caps[@]}"
done

echo
printf '%s\n' "${rows[@]}"
echo
echo "logs: $log_dir"
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
