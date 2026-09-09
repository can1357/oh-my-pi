#!/usr/bin/env bash
# Gate P6: live built-ins settle onto the journal-first DOM spine.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
bin="${OMP_BIN:-$root/target/debug/omp}"
work="${OMP_SMOKE_DIR:-/tmp/omp-smoke}"
data="${OMP_SMOKE_DATA_DIR:-$work/data}"
export OMP_DATA_DIR="$data"
model="${OMP_SMOKE_MODEL:-anthropic/claude-sonnet-4-5}"
mkdir -p "$work" "$data"
printf 'hello from fixture\n' > "$work/note.txt"
printf 'alpha needle\nbeta\n' > "$work/search.txt"

latest_session() {
	find "$data" -name '*.oms' -type f -newer "$1" -print0 |
		xargs -0 stat -f '%m %N' | sort -rn | sed -n '1s/^[0-9][0-9]* //p'
}

run_tool() {
	name="$1"
	prompt="$2"
	stamp="$(mktemp "$work/.p6-${name}.XXXXXX")"
	output="$(cd "$work" && "$bin" print --no-ext --project . \
		--model "$model" "$prompt")"
	session="$(latest_session "$stamp")"
	rm -f "$stamp"
	[ -n "$output" ] || { printf 'FAIL %s produced no assistant line\n' "$name" >&2; exit 1; }
	[ -n "$session" ] || { printf 'FAIL %s wrote no session journal\n' "$name" >&2; exit 1; }
	grep -q '^event: tool.result@1$' "$session" || {
		printf 'FAIL %s did not settle\n' "$name" >&2; exit 1;
	}
	grep -q "\"name\":\"$name\"" "$session" || {
		printf 'FAIL %s was not called\n' "$name" >&2; exit 1;
	}
	printf '%s: %s\n' "$name" "$(printf '%s\n' "$output" | sed -n '1p')"
	LAST_SESSION="$session"
}

run_tool read 'Use the read tool to read note.txt, then reply with one short assistant line confirming its contents.'
run_tool bash 'Use bash exactly once with command `printf allowed-bash; printf forbidden >/etc/omp-p6-denied`. Do not use any other tool. Then reply with one short assistant line describing the allowed output and denied write.'
grep -Eq '"severity":"error"|policy.denied|policy_denied|PolicyDenied|"fault":.*"command_failed"' "$LAST_SESSION" || {
	printf 'FAIL bash denial did not journal an error diagnostic or policy fault\n' >&2; exit 1;
}
printf 'before\n' > "$work/scratch-edit.txt"
run_tool edit 'Use the edit tool exactly once on scratch-edit.txt, replacing the complete line `before` with `after`. Do not use write. Then reply with one short assistant line.'
grep -q '^after$' "$work/scratch-edit.txt" || { printf 'FAIL edit scratch result\n' >&2; exit 1; }
run_tool grep 'Use the grep tool to find `needle` in search.txt, then reply with one short assistant line naming the match.'
run_tool glob 'Use the glob tool to find note.txt in this project, then reply with one short assistant line naming it.'
run_tool todo 'Use the todo tool to initialize exactly two items, then reply with one short assistant line confirming the list.'
run_tool task 'Use the task tool to run exactly one child. The child must read note.txt and return its contents. Then reply with one short assistant line containing the child result.'
grep -Eq '"tag":"subagent"|"Subagent"|subagent' "$LAST_SESSION" || {
	printf 'FAIL task journal has no patch inserting a subagent element\n' >&2; exit 1;
}

printf 'Gate P6 tool matrix passed\n'
