//! What a caller can see, or take over, of the private script a host
//! callout runs.
//!
//! A callout (`timeout`, `nohup`, `xargs`, `env`, `find -exec`, `ifne`)
//! runs its operand as one command of a script the engine writes. Every
//! mechanism bash has for observing a command by its name or its source
//! text — alias expansion, the function table, `BASH_COMMAND` and the
//! DEBUG and ERR traps, `type`, `command -v` — must see the operand and
//! never a word of that private script.
//!
//! Each row was measured on Bash 5.2.21 and Bash 5.3.0, which agree, with
//! the callout's program as an external (`/usr/bin/timeout`, `xargs`,
//! `env`). The ERR and DEBUG rows are the exception and say so: bash runs
//! the operand in another process, where no trap of the caller can fire,
//! while a callout here is a subshell of the caller, so the caller's
//! inherited trap fires for the operand too. What that trap reports is the
//! operand's own command, never the engine's.
#![cfg(unix)]

use std::collections::HashMap;

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken};

/// Runs `script` in a fresh shell and a fresh directory holding `files`,
/// returning everything it wrote to the caller's fds.
async fn output(files: &[(&str, &str)], script: &str) -> String {
	let session_env = HashMap::from([
		("PI_DISABLE_NOHUP_BUILTIN".into(), "0".into()),
		("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into()),
	]);
	let dir = tempfile::tempdir().expect("tempdir");
	for (name, body) in files {
		std::fs::write(dir.path().join(name), body).expect("write fixture");
	}
	let shell =
		Shell::new(Some(ShellOptions { session_env: Some(session_env), ..Default::default() }));
	let (tx, rx) = flume::unbounded::<String>();
	shell
		.run(
			ShellRunOptions {
				command: script.into(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(20_000),
				..Default::default()
			},
			Some(tx),
			CancelToken::new(None),
		)
		.await
		.expect("shell execution");
	rx.drain().collect()
}

/// Reports every `(script, expected output)` row that does not match.
async fn assert_rows(rows: &[(&str, &str)]) {
	let mut mismatches = Vec::new();
	for &(script, want) in rows {
		let got = output(&[], script).await;
		if got != want {
			mismatches.push(format!("`{script}`: want {want:?}, got {got:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

/// An alias of any name cannot rewrite the script a callout runs: the
/// engine parses its own source without the shell's aliases. An alias on
/// the carrier word used to delete the operand (an empty alias) or run
/// something else instead of it.
#[tokio::test]
async fn an_alias_cannot_rewrite_the_script_a_callout_runs() {
	assert_rows(&[
		(
			"shopt -s expand_aliases\nalias __pi_callout=''\nset -- P Q\ntimeout 3 printf \
			 'OPERAND\\n'\necho \"rc=$? pos=<$*>\"",
			"OPERAND\nrc=0 pos=<P Q>\n",
		),
		(
			"shopt -s expand_aliases\nalias __pi_callout='echo HIJACK'\ntimeout 3 printf 'OPERAND\\n'",
			"OPERAND\n",
		),
		(
			"shopt -s expand_aliases\nalias __pi_callout=''\nprintf 'A\\n' | xargs printf \
			 'OPERAND:%s\\n'",
			"OPERAND:A\n",
		),
		(
			"shopt -s expand_aliases\nalias __pi_callout=''\nenv FOO=1 printf 'OPERAND\\n'",
			"OPERAND\n",
		),
		(
			"shopt -s expand_aliases\nalias __pi_callout=''\nnohup printf 'OPERAND\\n' 2>/dev/null",
			"OPERAND\n",
		),
		(
			"shopt -s expand_aliases\nalias __pi_callout=''\nprintf 'X\\n' | ifne printf 'IFNE\\n'",
			"IFNE\n",
		),
		// The alias is defined after the first call, so the second call's
		// parse is the one it could reach.
		(
			"timeout 3 printf 'FIRST\\n'\nshopt -s expand_aliases\nalias __pi_callout='echo \
			 HIJACK'\ntimeout 3 printf 'SECOND\\n'",
			"FIRST\nSECOND\n",
		),
		// A shell function as the operand still runs.
		("shopt -s expand_aliases\nf() { echo IN-F; }\nalias __pi_callout=''\ntimeout 3 f", "IN-F\n"),
	])
	.await;
}

/// `find -exec` runs its command through the same private script.
#[tokio::test]
async fn an_alias_cannot_rewrite_the_script_find_exec_runs() {
	let got = output(
		&[("one", "")],
		"shopt -s expand_aliases\nalias __pi_callout=''\nfind . -maxdepth 1 -name one -exec printf \
		 'OPERAND:%s\\n' {} ';'",
	)
	.await;
	assert_eq!(got, "OPERAND:./one\n");
}

/// How a callout's operand is dispatched is data the host states, not
/// `command` and `exec` words in the script. A caller's function or alias
/// of either name used to run in place of the operand.
#[tokio::test]
async fn a_name_like_the_dispatch_does_not_replace_the_operand() {
	assert_rows(&[
		("command() { echo HIJACK; }\nprintf 'A\\n' | xargs printf 'OPERAND:%s\\n'", "OPERAND:A\n"),
		(
			"shopt -s expand_aliases\nalias command='echo HIJACK'\nprintf 'A\\n' | xargs printf \
			 'OPERAND:%s\\n'",
			"OPERAND:A\n",
		),
		("exec() { echo HIJACK; }\nprintf 'A\\n' | xargs /bin/echo OPERAND", "OPERAND A\n"),
		(
			"shopt -s expand_aliases\nalias exec='echo HIJACK'\nprintf 'A\\n' | xargs /bin/echo \
			 OPERAND",
			"OPERAND A\n",
		),
	])
	.await;
}

/// The environment changes `env` asks for are commands the engine writes
/// into that script. They resolve to the shell's builtins, so a caller's
/// function or alias of the name `unset` or `export` neither runs nor
/// stops them doing their work.
#[tokio::test]
async fn a_name_like_the_environment_sweep_does_not_run() {
	assert_rows(&[
		(
			"unset() { echo HIJACK; }\nFOO=caller\nexport FOO\nenv -u FOO printf 'OPERAND\\n'",
			"OPERAND\n",
		),
		("export() { echo HIJACK; }\nenv FOO=v printf 'OPERAND\\n'", "OPERAND\n"),
		(
			"shopt -s expand_aliases\nalias unset='echo HIJACK'\nFOO=caller\nexport FOO\nenv -u FOO \
			 printf 'OPERAND\\n'",
			"OPERAND\n",
		),
		(
			"shopt -s expand_aliases\nalias export='echo HIJACK'\nenv FOO=v printf 'OPERAND\\n'",
			"OPERAND\n",
		),
		// Still a sweep: the operand's environment has no `FOO` after
		// `-u`, and has the one the assignment gave it.
		("FOO=caller\nexport FOO\nunset() { echo HIJACK; }\nenv -u FOO env | grep -c '^FOO='", "0\n"),
		("export() { echo HIJACK; }\nenv FOO=v env | grep -c '^FOO=v$'", "1\n"),
	])
	.await;
}

/// A trap reads the operand's own command, never the engine's carrier.
///
/// Bash cannot reach this: `timeout` is another process there, so only the
/// caller's own `timeout 3 false` fires its ERR trap. A callout is a
/// subshell of the caller, which inherits the trap with `set -E`, so the
/// operand fires it as well — and what it reports must be the operand.
#[tokio::test]
async fn a_trap_reads_the_operands_command_not_the_carrier() {
	assert_rows(&[
		(
			"set -E\ntrap 'echo \"ERR=<$BASH_COMMAND>\"' ERR\nset -- P Q\ntimeout 3 false\necho \
			 \"rc=$? pos=<$*>\"",
			"ERR=<false>\nERR=<timeout 3 false>\nrc=1 pos=<P Q>\n",
		),
		(
			"set -T\ntrap 'echo \"DBG=<$BASH_COMMAND>\"' DEBUG\ntimeout 3 true\ntrap - DEBUG\necho \
			 done",
			"DBG=<timeout 3 true>\nDBG=<true>\nDBG=<trap - DEBUG>\ndone\n",
		),
		// The words the operand was given, as the shell prints them.
		(
			"set -T\ntrap 'echo \"DBG=<$BASH_COMMAND>\"' DEBUG\ntimeout 3 printf 'a b\\n'\ntrap - \
			 DEBUG",
			"DBG=<timeout 3 printf 'a b\\n'>\nDBG=<printf 'a b\\n'>\na b\nDBG=<trap - DEBUG>\n",
		),
	])
	.await;
}

/// The carrier is not a name the shell knows: nothing looks it up, so
/// nothing can find it.
#[tokio::test]
async fn the_carrier_is_not_a_name_the_shell_resolves() {
	assert_rows(&[
		// The diagnostic carries the shell's own prefix (bash names its
		// script file where this shell names itself); what the row pins is
		// that neither `type` nor `command -v` finds the name.
		(
			"timeout 3 true\ntype __pi_callout 2>&1\ncommand -v __pi_callout\necho \"rc=$?\"",
			"bash: line 2: type: __pi_callout: not found\nrc=1\n",
		),
		// A function of that name is never reached, and never shadows the
		// operand.
		("__pi_callout() { echo HIJACK; }\ntimeout 3 printf 'OPERAND\\n'", "OPERAND\n"),
	])
	.await;
}

/// The operand, and anything it calls, is the caller's own command: it
/// finds the caller's functions as it would anywhere.
#[tokio::test]
async fn a_function_operand_still_calls_the_callers_functions() {
	assert_rows(&[
		("f() { g; }\ng() { echo G; }\ntimeout 3 f", "G\n"),
		("g() { echo G; }\nf() { g; }\nnohup f 2>/dev/null", "G\n"),
	])
	.await;
}
