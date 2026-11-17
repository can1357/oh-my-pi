//! Host tools must run their own operands, not the calling function's `$@`.
//! External-operand expectations were checked with Bash 5.2.21 and 5.3.0;
//! `timeout` and `nohup` of a shell function are pi extensions.
#![cfg(unix)]

use std::{collections::HashMap, fs};

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken};

/// Runs each `(script, status, marker)` row in a fresh shell and a fresh
/// directory, reporting every row whose exit status or `marker` file differs.
async fn assert_callouts(rows: &[(&str, i32, &str)]) {
	let session_env = HashMap::from([
		("PI_DISABLE_NOHUP_BUILTIN".into(), "0".into()),
		("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into()),
		("PI_SMART_GIT".into(), "1".into()),
		("PI_GIT_GUARD".into(), "0".into()),
	]);
	let mut mismatches = Vec::new();
	for &(command, status, marker) in rows {
		let dir = tempfile::tempdir().expect("tempdir");
		let shell = Shell::new(Some(ShellOptions {
			session_env: Some(session_env.clone()),
			..Default::default()
		}));
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(
				ShellRunOptions {
					command: command.into(),
					cwd: Some(dir.path().to_string_lossy().into_owned()),
					timeout_ms: Some(10_000),
					..Default::default()
				},
				Some(tx),
				CancelToken::new(None),
			)
			.await
			.expect("shell execution");
		let got = (result.exit_code, fs::read_to_string(dir.path().join("marker")).ok());
		if got != (Some(status), Some(marker.to_owned())) {
			let output: String = rx.drain().collect();
			mismatches.push(format!("`{command}`: {got:?}, output {output:?}"));
		}
	}
	assert!(mismatches.is_empty(), "{}", mismatches.join("\n"));
}

const RAN: &str = "/bin/sh -c 'printf ran > marker; exit 3'";

/// Every command-running tool inside a function runs its operand and reports
/// the operand's status (`xargs` maps it to 123, `find -exec` to 0).
#[tokio::test]
async fn tools_in_a_function_run_their_operands() {
	assert_callouts(&[
		(&format!("f(){{ timeout 5 {RAN}; }}; f"), 3, "ran"),
		(&format!("f(){{ nohup {RAN} >/dev/null 2>&1; }}; f"), 3, "ran"),
		(&format!("f(){{ env {RAN}; }}; f"), 3, "ran"),
		(&format!("f(){{ printf input | ifne {RAN}; }}; f"), 3, "ran"),
		(&format!("f(){{ printf input | xargs {RAN}; }}; f"), 123, "ran"),
		(&format!("f(){{ find . -maxdepth 0 -exec {RAN} ';'; }}; f"), 0, "ran"),
		("f(){ git -c 'alias.mark=!printf ran > marker; exit 3' mark; }; f", 3, "ran"),
		("f(){ timeout 0.2 sleep 5; s=$?; printf %s $s > marker; return $s; }; f", 124, "124"),
	])
	.await;
}

/// However the function is reached, and wherever the tool sits inside it.
#[tokio::test]
async fn function_callouts_run_in_every_context() {
	let def = format!("f(){{ timeout 5 {RAN}; }}");
	assert_callouts(&[
		(&format!("{def}; g(){{ f; }}; g"), 3, "ran"),
		(&format!("{def}; (f)"), 3, "ran"),
		(&format!("set -o pipefail; {def}; f | cat"), 3, "ran"),
		(&format!("{def}; eval f"), 3, "ran"),
		(&format!("{def}; f & wait $!"), 3, "ran"),
		(&format!("printf '%s\\n' \"{def}\" > fn.sh; source ./fn.sh; f"), 3, "ran"),
		(&format!("shopt -s expand_aliases\n{def}\nalias run_f=f\nrun_f"), 3, "ran"),
		(&format!("f(){{ (timeout 5 {RAN}); }}; f"), 3, "ran"),
		(&format!("f(){{ eval \"timeout 5 {RAN}\"; }}; f"), 3, "ran"),
		(&format!("f(){{ timeout 5 {RAN} & wait $!; }}; f"), 3, "ran"),
		(
			&format!(
				"f(){{ nohup {RAN} >/dev/null 2>&1 & p=$!; wait $p; s=$?; [ $p -gt 0 ] || return 99; \
				 return $s; }}; f"
			),
			3,
			"ran",
		),
	])
	.await;
}

/// The caller's positional parameters are never the operand, and a function
/// operand sees the caller's locals with its own arguments.
#[tokio::test]
async fn operands_use_their_own_arguments() {
	let wrong = "/bin/sh -c 'printf wrong > marker; exit 7'";
	let operand = "operand(){ printf '%s:%s\\n' \"$local_value\" \"$1\" > marker; return 3; }";
	assert_callouts(&[
		(&format!("f(){{ timeout 5 {RAN}; }}; f {wrong}"), 3, "ran"),
		(&format!("f(){{ nohup {RAN} >/dev/null 2>&1; }}; f {wrong}"), 3, "ran"),
		(
			&format!(
				"{operand}; f(){{ local local_value=local; timeout 5 operand argument; s=$?; printf \
				 '%s\\n' \"$1\" >> marker; return $s; }}; f caller"
			),
			3,
			"local:argument\ncaller\n",
		),
		(
			&format!(
				"{operand}; f(){{ local local_value=local; nohup operand argument >/dev/null 2>&1; \
				 s=$?; printf '%s\\n' \"$1\" >> marker; return $s; }}; f caller"
			),
			3,
			"local:argument\ncaller\n",
		),
	])
	.await;
}
