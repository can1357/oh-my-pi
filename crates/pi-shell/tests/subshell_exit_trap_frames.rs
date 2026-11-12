//! A forked `( … )` subshell runs its EXIT trap above the function frames it
//! was forked inside: bash's trap sees the function's positional parameters
//! and its `FUNCNAME` level, exactly as the root shell's EXIT trap does after
//! an `exit` inside a function. Every row is the output and exit status of
//! Bash 5.3.0 for the same `-c` string, run here through `Shell::run`; Bash
//! 5.2.21 agrees on every row in this file.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Run `script` (its diagnostics discarded) in a fresh shell: its output and
/// exit status.
async fn run(script: &str) -> (String, Option<i32>) {
	let (tx, rx) = flume::unbounded::<String>();
	let command = format!("exec 2>/dev/null\n{script}");
	let result = Shell::new(None)
		.run(
			ShellRunOptions { command, ..Default::default() },
			Some(tx),
			CancelToken::new(Some(10_000)),
		)
		.await
		.expect("run");
	(rx.drain().collect(), result.exit_code)
}

async fn check(rows: &[(&str, &str, i32)]) {
	let mut wrong = Vec::new();
	for &(script, output, status) in rows {
		let got = run(script).await;
		if got != (output.to_owned(), Some(status)) {
			wrong.push(format!("`{script}`: got {got:?}, bash gives ({output:?}, {status})"));
		}
	}
	assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

/// The defect: the trap of a forked subshell started inside a function ran
/// after every frame had been popped, so it read the *caller's* positional
/// parameters and a `FUNCNAME` missing the function it was forked in
/// (`EXIT=[F1 F2] F=[f]` instead of `EXIT=[OWN ARG] F=[report f]`).
#[tokio::test(flavor = "multi_thread")]
async fn a_subshells_exit_trap_runs_above_the_function_frames() {
	check(&[
		// The reported row: a `( … )` subshell forked inside a function.
		(
			r##"set -- s1 s2
report() { trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT; exit 4; }
f() { ( report OWN ARG ); echo "rc=$?"; }
f F1 F2"##,
			"EXIT=[OWN ARG] F=[report f]\nrc=4\n",
			0,
		),
		// A nested function: the innermost frame is the one the trap sees.
		(
			r##"set -- s1 s2
inner() { trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT; exit 4; }
outer() { inner IN1 IN2; }
f() { ( outer OUT1 ); echo "rc=$?"; }
f F1 F2"##,
			"EXIT=[IN1 IN2] F=[inner outer f]\nrc=4\n",
			0,
		),
		// A command substitution's subshell.
		(
			r##"set -- s1 s2
report() { trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT; exit 4; }
f() { x=$( report OWN ARG ); echo "rc=$? x=[$x]"; }
f F1 F2"##,
			"rc=4 x=[EXIT=[OWN ARG] F=[report f]]\n",
			0,
		),
		// A pipeline stage's subshell.
		(
			r##"set -- s1 s2
report() { trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT; exit 4; }
f() { report OWN ARG | cat; echo "rc=${PIPESTATUS[0]}"; }
f F1 F2"##,
			"EXIT=[OWN ARG] F=[report f]\nrc=4\n",
			0,
		),
		// A background job's subshell.
		(
			r##"set -- s1 s2
report() { trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT; exit 4; }
f() { ( report OWN ARG & wait $! ); echo "rc=$?"; }
f F1 F2"##,
			"EXIT=[OWN ARG] F=[report f]\nrc=4\n",
			0,
		),
		// A subshell nested in a subshell: the inner trap reports the
		// function's arguments, the outer subshell survives with status 0.
		(
			r##"set -- s1 s2
report() { trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT; exit 4; }
f() { ( ( report OWN ARG ); echo "mid=$?" ); echo "rc=$?"; }
f F1 F2"##,
			"EXIT=[OWN ARG] F=[report f]\nmid=4\nrc=0\n",
			0,
		),
		// `exit` from a `.` file inside the subshell: the sourced level is on
		// `FUNCNAME` too.
		(
			r##"set -- s1 s2
d=$(mktemp -d)
cat > "$d/src.sh" <<'EOF'
trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT
exit 4
EOF
report() { . "$d/src.sh"; }
f() { ( report OWN ARG ); echo "rc=$?"; }
f F1 F2
rm -rf "$d""##,
			"EXIT=[OWN ARG] F=[source report f]\nrc=4\n",
			0,
		),
		// A subshell forked outside any function keeps the shell's own
		// parameters: the rule is about frames, not about subshells.
		(
			r##"set -- s1 s2
f() { ( trap 'echo "EXIT=[$*] F=[${FUNCNAME[*]}]"' EXIT; exit 4 ); echo "rc=$?"; }
f F1 F2"##,
			"EXIT=[F1 F2] F=[f]\nrc=4\n",
			0,
		),
	])
	.await;
}

/// Starting the trap above the frames must not let it start twice: an `exit`
/// inside the EXIT trap ends the subshell with the new status and runs no
/// second trap. This is what the `Run`-based path already guarded with
/// `exit_trap_started`; a forked subshell has no `Run`.
#[tokio::test(flavor = "multi_thread")]
async fn an_exit_inside_the_subshells_exit_trap_does_not_restart_it() {
	check(&[
		(
			r##"set -- s1 s2
report() { trap 'echo "T1=[$*] F=[${FUNCNAME[*]}]"; exit 9' EXIT; exit 4; }
f() { ( report OWN ARG ); echo "rc=$?"; }
f F1 F2"##,
			"T1=[OWN ARG] F=[report f]\nrc=9\n",
			0,
		),
		// A fatal expansion error inside that trap ends it with the status the
		// trap started with, the same rule the root shell's trap follows.
		(
			r##"set -- s1 s2
report() { trap ': ${nope?boom}' EXIT; exit 4; }
f() { ( report OWN ARG ); echo "rc=$?"; }
f F1 F2"##,
			"rc=4\n",
			0,
		),
		// `set -e; false` inside the trap decides the status, once.
		(
			r##"set -- s1 s2
report() { trap 'echo "T1=[$*]"; set -e; false; echo NOPE' EXIT; exit 4; }
f() { ( report OWN ARG ); echo "rc=$?"; }
f F1 F2"##,
			"T1=[OWN ARG]\nrc=1\n",
			0,
		),
	])
	.await;
}
