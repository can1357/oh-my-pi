#!/usr/bin/env bash
# Gate P0: one live headless turn per provider using bare vendor env vars.
#
# Requires ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY in the environment
# (no OMP_* overrides) and a built binary at target/debug/omp.
set -u

root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="${OMP_BIN:-$root/target/debug/omp}"
scratch_root="${OMP_SMOKE_DIR:-${TMPDIR:-/tmp}}"
mkdir -p "$scratch_root"
work="$(mktemp -d "$scratch_root/omp-smoke-print.XXXXXX")"
trap 'rm -rf "$work"' EXIT

# Every owner-controlled directory is scratch-backed. In particular, neither
# ~/.o2/config.cfg nor an archived ai_model may retarget an explicit row.
export HOME="$work/home"
export OMP_CONFIG_DIR="$work/config"
export OMP_DATA_DIR="$work/data"
export OMP_STATE_DIR="$work/state"
export OMP_CACHE_DIR="$work/cache"
mkdir -p "$HOME" "$OMP_CONFIG_DIR" "$OMP_DATA_DIR" "$OMP_STATE_DIR" "$OMP_CACHE_DIR"
unset OMP_ANTHROPIC_API_KEY OMP_OPENAI_API_KEY OMP_OPENROUTER_API_KEY

models=(
	"anthropic/claude-sonnet-4-5 anthropic"
	"openai/gpt-5 openai"
	"openrouter/anthropic/claude-sonnet-4.5 openrouter"
)

status=0
row=0
for case in "${models[@]}"; do
	model="${case% *}"
	provider="${case##* }"
	row=$((row + 1))
	session="$work/provider-$row.oms"
	out="$(cd "$work" && "$bin" print --no-ext --no-tools --project . \
		--session "$session" --model "$model" "Reply with exactly the word pong" 2>&1)"
	code=$?
	# print emits a progress line ("Working...") on the same stream; judge the final line.
	word="$(printf '%s\n' "$out" | sed '/^[[:space:]]*$/d' | tail -n 1 | tr -d '[:space:][:punct:]' | tr '[:upper:]' '[:lower:]')"
	route_record="$(sed -n '/^event: msg\.assistant\.start@1$/,/^$/s/^data: //p' "$session" 2>/dev/null | tail -n 1)"
	routed=0
	if printf '%s' "$route_record" | grep -q "\"provider\":\"$provider\"" && printf '%s' "$route_record" | grep -q "\"route\":\"$provider/"; then
		routed=1
	fi
	if [ "$code" -eq 0 ] && [ "$word" = "pong" ] && [ "$routed" -eq 1 ]; then
		printf 'ok   %s via %s\n' "$model" "$provider"
	else
		printf 'FAIL %s via %s (exit %s, route %s)\n%s\n' \
			"$model" "$provider" "$code" "${route_record:-missing}" "$out"
		status=1
	fi
done
exit $status
