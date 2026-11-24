//! `$!` in subshells, as Bash 5.3 runs a script (Bash 5.2.21 agrees on
//! every row): every subshell copies it, while the child it names stays
//! its parent's, not the subshell's.
#![cfg(unix)]

use omp_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs each script in a fresh shell and asserts the expected output and
/// exit status 0, reporting every row that differs.
async fn assert_shell_outputs(rows: &[(&str, &str)]) {
	let mut mismatches = Vec::new();
	for &(script, expected) in rows {
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("run");
		let output: String = rx.drain().collect();
		if (result.exit_code, output.as_str()) != (Some(0), expected) {
			mismatches.push(format!(
				"`{script}`\n  expected: Some(0) {expected:?}\n  omp:      {:?} {output:?}",
				result.exit_code
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// An extra launched as a whole background job used to show an ID that
/// only the embedded shell could see. The operating system must see it
/// while it is running, and the usual job-control operations still work.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_extra_has_an_os_pid() {
	assert_shell_outputs(&[
		(
			r#"PATH=/usr/bin:/bin
yes >/dev/null & P=$!
seen=$(/bin/ps -o pid= -p "$P")
set -- $seen
listed=$(jobs -p)
nested=$(printf '%s' "$!")
pipeline=$(printf x | printf '%s' "$!")
kill "$P"; wait "$!" 2>/dev/null; stopped=$?
[ "${1-}" = "$P" ] && [ "$listed" = "$P" ] && [ "$nested" = "$P" ] &&
[ "$pipeline" = "$P" ] && ( [ "$!" = "$P" ] ) && [ "$stopped" = 143 ] &&
printf 'found and reaped\n'"#,
			"found and reaped\n",
		),
		(
			r#"PATH=/usr/bin:/bin
sleep 30 & P=$!
seen=$(/bin/ps -o pid= -p "$P")
set -- $seen
kill %1 && wait && [ "${1-}" = "$P" ] && printf 'job stopped\n'"#,
			"job stopped\n",
		),
	])
	.await;
}

/// Only process-lifetime extras switch to `PATH` under `&`: a text utility
/// keeps its own dialect (and the `scheme://` paths only builtins open), so
/// its `$!` stays shell-only.
#[tokio::test(flavor = "multi_thread")]
async fn a_background_text_utility_stays_in_process() {
	assert_shell_outputs(&[(
		r#"PATH=/usr/bin:/bin
cat </dev/null & p=$!
wait "$p" && [ "$p" -ge 1073741824 ] && printf 'in-process\n'"#,
		"in-process\n",
	)])
	.await;
}

/// Missing or non-executable PATH entries must not make an extra fail, and
/// an executable only overrides the extra when the command is backgrounded.
#[tokio::test(flavor = "multi_thread")]
async fn background_path_preference_falls_back_to_the_extra() {
	assert_shell_outputs(&[(
		r#"dir=$(/usr/bin/mktemp -d) || exit
trap 'rm -rf "$dir"' EXIT
PATH="$dir" yes --version >/dev/null & absent=$!
wait "$absent"; a=$?
: > "$dir/yes"
PATH="$dir" yes --version >/dev/null & nonexec=$!
wait "$nonexec"; n=$?
printf '#!/bin/sh\nexit 19\n' > "$dir/yes"
printf '#!/bin/sh\nexit 21\n' > "$dir/timeout"
/bin/chmod +x "$dir/yes" "$dir/timeout"
PATH="$dir" yes --version >/dev/null; fg=$?
PATH="$dir" yes --version >/dev/null & external=$!
wait "$external"; bg=$?
PATH="$dir" timeout 1 printf 'foreground timeout\n'
PATH="$dir" timeout 1 printf 'should not print\n' & wrapped=$!
wait "$wrapped"; timeout_status=$?
[ "$absent" -ge 1073741824 ] && [ "$nonexec" -ge 1073741824 ] &&
[ "$external" -lt 1073741824 ] && [ "$wrapped" -lt 1073741824 ] &&
printf 'statuses=%s,%s,%s,%s,%s\n' "$a" "$n" "$fg" "$bg" "$timeout_status""#,
		"foreground timeout\nstatuses=0,0,0,19,21\n",
	)])
	.await;
}

/// A command substitution, a `( )` subshell and a pipeline stage expand
/// `$!` to the parent's: a command substitution saw none.
#[tokio::test(flavor = "multi_thread")]
async fn every_subshell_sees_the_parents_bang() {
	assert_shell_outputs(&[
		(r#"/bin/sleep 0.1 & [ "$!" = "$(echo $!)" ] && echo same || echo differ; wait"#, "same\n"),
		(r#"f(){ :; }; f & [ "$!" = "$(echo $!)" ] && echo same || echo differ; wait"#, "same\n"),
		(r#"f(){ :; }; f & p=$!; ( [ "$!" = "$p" ] && echo same ); wait"#, "same\n"),
		(
			r#"f(){ :; }; f & p=$!; echo x | { read -r _; [ "$!" = "$p" ] && echo same; }; wait"#,
			"same\n",
		),
	])
	.await;
}

/// The child `$!` names is not the subshell's to wait for: `wait PID`,
/// `wait` and `wait -n PID` in the subshell leave it alone.
#[tokio::test(flavor = "multi_thread")]
async fn a_subshell_does_not_wait_for_its_parents_child() {
	assert_shell_outputs(&[
		(
			r#"f(){ sleep 0.2; }; f & p=$!; ( wait "$p" 2>/dev/null; echo "s=$?" ); wait "$!"; echo "t=$?""#,
			"s=127\nt=0\n",
		),
		(r"f(){ sleep 0.2; }; f & ( wait 2>&1 ); echo done; wait", "done\n"),
		(
			r#"f(){ sleep 0.2; }; f & p=$!; ( wait -n "$p" 2>/dev/null; echo "n=$?" ); wait"#,
			"n=127\n",
		),
	])
	.await;
}

/// `$!` of a background pipeline is its last process's pid, as the process
/// reports `$$` itself (it was the shell's virtual pid).
#[tokio::test(flavor = "multi_thread")]
async fn a_background_pipelines_bang_is_its_last_process() {
	assert_shell_outputs(&[(
		r#"T=$(mktemp); /bin/sleep 0.1 | /bin/sh -c 'echo $$ >"$1"; exec /bin/sleep 0.1' sh "$T" & p=$!; wait; [ "$p" = "$(cat "$T")" ] && echo last; rm -f "$T""#,
		"last\n",
	)])
	.await;
}
