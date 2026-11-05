//! Literal Bash 5.3.0 `--noprofile --norc -c` goldens. Indexed-subscript
//! arithmetic errors end the command string through functions, eval and
//! source, but end only the child in subshells and pipeline stages.
#![cfg(unix)]

mod obash_support;

use std::time::Duration;

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams},
};

async fn run(id: &str, script: &str, stdout: &str, stderr: bool, status: i32) {
	let dir = tempfile::tempdir().expect("tempdir");
	let (stdout_tx, stdout_rx) = flume::unbounded();
	let (stderr_tx, stderr_rx) = flume::unbounded();
	let result = tokio::time::timeout(
		Duration::from_secs(10),
		execute_shell_streams(
			ShellExecuteOptions {
				command: script.to_string(),
				cwd: Some(dir.path().to_string_lossy().into_owned()),
				timeout_ms: Some(5_000),
				..Default::default()
			},
			StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) },
			CancelToken::new(None),
		),
	)
	.await
	.expect("arithmetic subscript error exceeded its deadline")
	.expect("shell execution");
	let collect = |rx: flume::Receiver<bytes::Bytes>| {
		String::from_utf8(rx.drain().flat_map(|chunk| chunk.to_vec()).collect()).expect("utf-8")
	};
	assert!(!result.timed_out, "{id}: {script:?} timed out");
	assert_eq!(collect(stdout_rx), stdout, "{id}: {script:?}");
	assert_eq!(!collect(stderr_rx).is_empty(), stderr, "{id}: {script:?}");
	assert_eq!(result.exit_code, Some(status), "{id}: {script:?}");
	assert!(!dir.path().join("marker").exists(), "{id}: execution continued after the error");
}

async fn run_context(context: &str, wrap: impl Fn(&str) -> String, stdout: &str, status: i32) {
	for (name, command) in [
		("for-init", "for ((a[1+]=0;0;)); do echo body; printf body > marker; done"),
		("assignment", "a[1+]=value"),
		("parameter", "printf \"<%s>\\n\" \"${a[1+]}\""),
		("arithmetic", "(( a[1+] ))"),
		("let", "let 'a[1+]'"),
		("declare", "declare 'a[1+]=value'"),
		("unset", "unset 'a[1+]'"),
	] {
		let body =
			format!("a=(zero one); {command}; printf after > marker; echo inside\necho inside-next\n");
		run(&format!("{name}-{context}"), &wrap(&body), stdout, true, status).await;
	}
}

#[tokio::test]
async fn indexed_subscript_errors_end_the_entire_command_string() {
	run_context("root", |body| format!("{body}echo outer\necho next\n"), "", 1).await;
}

#[tokio::test]
async fn functions_do_not_catch_indexed_subscript_errors() {
	run_context("function", |body| format!("f() {{ {body}}}; f; echo outer\necho next\n"), "", 1)
		.await;
}

#[tokio::test]
async fn eval_does_not_catch_indexed_subscript_errors() {
	run_context(
		"eval",
		|body| format!("eval '{}'; echo outer\necho next\n", body.replace('\'', "'\\''")),
		"",
		1,
	)
	.await;
}

#[tokio::test]
async fn source_does_not_catch_indexed_subscript_errors_in_a_command_string() {
	run_context(
		"source",
		|body| {
			format!(
				"printf '%s' '{}' > script; source ./script; echo outer\necho next\n",
				body.replace('\'', "'\\''")
			)
		},
		"",
		1,
	)
	.await;
}

#[tokio::test]
async fn indexed_subscript_errors_end_only_the_subshell() {
	run_context(
		"subshell",
		|body| format!("( {body}); echo outer\necho next\n"),
		"outer\nnext\n",
		0,
	)
	.await;
}

#[tokio::test]
async fn indexed_subscript_errors_end_only_the_pipeline_stage() {
	run_context(
		"pipeline",
		|body| format!("{{ {body} }} | cat; echo outer\necho next\n"),
		"outer\nnext\n",
		0,
	)
	.await;
}

#[tokio::test]
async fn indexed_subscript_errors_end_only_the_command_substitution() {
	run_context(
		"command-substitution",
		|body| {
			format!("x=$( {body}); printf \"rc=%s x=<%s>\\n\" \"$?\" \"$x\"; echo outer\necho next\n")
		},
		"rc=1 x=<>\nouter\nnext\n",
		0,
	)
	.await;
}

#[tokio::test]
async fn expanded_subscripts_in_arithmetic_for_headers_do_not_resume_at_the_next_line() {
	for (id, script) in [
		(
			"subscript-root",
			"v=0; a=(0 1); for ((a[${v+\"(\"}]=0;0;)); do :; done; echo same\necho next\n",
		),
		(
			"subscript-function",
			"f() { v=0; a=(0 1); for ((a[${v+\"(\"}]=0;0;)); do :; done; echo inside; }; f; echo \
			 outer\necho next\n",
		),
		(
			"subscript-eval",
			"eval 'v=0; a=(0 1); for ((a[${v+\"(\"}]=0;0;)); do :; done; echo inside'; echo \
			 outer\necho next\n",
		),
	] {
		run(id, script, "", true, 1).await;
	}
}

#[tokio::test]
async fn a_failing_last_pipeline_stage_reports_status_one_without_exiting_its_parent() {
	run(
		"right-pipeline-status",
		"a=(zero one); : | { (( a[1+] )); printf bad > marker; echo stage-next\necho \
		 stage-next-line; }; printf 'pipeline=%s\\n' \"$?\"; echo outer\necho next\n",
		"pipeline=1\nouter\nnext\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn ordinary_arithmetic_command_errors_do_not_become_fatal_subscript_errors() {
	run(
		"ordinary-arithmetic-errors",
		"(( 1+ )); printf 'arithmetic=%s\\n' \"$?\"; let '1+'; printf 'let=%s\\n' \"$?\"\necho \
		 next\n",
		"arithmetic=1\nlet=1\nnext\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn builtin_assignment_and_variable_tests_do_not_swallow_indexed_subscript_errors() {
	for (id, command) in [
		("double-bracket-v", "[[ -v a[1+] ]]"),
		("test-v", "test -v 'a[1+]'"),
		("printf-v", "printf -v 'a[1+]' x"),
		("printf-empty-v", "printf -v 'a[1+]' ''"),
		("read", "read 'a[1+]' <<<'value'"),
	] {
		let script = format!("a=(zero one); {command}; echo same\necho next\n");
		run(id, &script, "", true, 1).await;
	}
}

#[tokio::test]
async fn printf_count_errors_preserve_prior_output_but_never_format_the_suffix() {
	for (id, format, stdout) in [
		("printf-count-reference", "prefix%nnever", "prefix"),
		("printf-count-lines", "prefix\\n%nnever", "prefix\n"),
	] {
		let script =
			format!("a=(zero one); declare -n r='a[1+]'; printf '{format}' r; echo same\necho next\n");
		run(id, &script, stdout, true, 1).await;
	}
}

#[tokio::test]
async fn indexed_subscript_errors_cross_nested_source_function_and_eval_frames() {
	for (id, script) in [
		(
			"source-eval-function",
			"printf '%s\\n' 'f() { eval '\\''a=(zero one); (( a[1+] )); printf bad > marker; echo \
			 eval-next'\\''; echo function-next; }; f; echo source-next' 'echo source-next-line' > \
			 script; source ./script; printf 'source=%s\\n' \"$?\"; echo outer\necho next\n",
		),
		(
			"source-in-function",
			"printf '%s\\n' 'a=(zero one); (( a[1+] )); printf bad > marker; echo source-next' 'echo \
			 source-next-line' > script; f() { source ./script; printf 'source=%s\\n' \"$?\"; echo \
			 function-next; }; f; echo outer\necho next\n",
		),
	] {
		run(id, script, "", true, 1).await;
	}
}

// These goldens use Bash 5.3.0 with a script-file argument, not `-c`.
#[test]
fn file_origin_discards_to_the_outer_input_loop_instead_of_exiting_or_resuming_eval_and_source() {
	for (id, script, stdout) in [
		(
			"arithmetic-root",
			"a=(zero one); (( a[1+] )); printf after > marker; echo inside\necho inside-next\necho \
			 outer\necho next\n",
			"inside-next\nouter\nnext\n",
		),
		(
			"arithmetic-function",
			"f() { a=(zero one); (( a[1+] )); printf after > marker; echo inside\necho \
			 inside-next\n}; f; echo outer\necho next\n",
			"next\n",
		),
		(
			"arithmetic-eval",
			"eval 'a=(zero one); (( a[1+] )); printf after > marker; echo inside\necho \
			 inside-next\n'; echo outer\necho next\n",
			"next\n",
		),
		(
			"arithmetic-source",
			"printf '%s' 'a=(zero one); (( a[1+] )); printf after > marker; echo inside\necho \
			 inside-next\n' > script; source ./script; echo outer\necho next\n",
			"next\n",
		),
	] {
		let dir = tempfile::tempdir().expect("tempdir");
		let path = dir.path().join("main.bash");
		std::fs::write(&path, script).expect("script fixture");
		let out = obash_support::output(obash_support::obash().arg(&path).current_dir(dir.path()));
		assert_eq!(String::from_utf8_lossy(&out.stdout), stdout, "{id}: {script:?}");
		assert!(!out.stderr.is_empty(), "{id}: missing diagnostic for {script:?}");
		assert_eq!(out.status.code(), Some(0), "{id}: {script:?}");
		assert!(!dir.path().join("marker").exists(), "{id}: execution continued after the error");
	}
}

#[tokio::test]
async fn reference_setters_do_not_catch_indexed_subscript_arithmetic_errors() {
	for (id, command) in [
		("declare-plus-n", "declare -n r='a[1+]'; declare +n r=value"),
		("getopts-reference", "declare -n r='a[1+]'; getopts x r -x"),
	] {
		let script = format!("a=(zero one); {command}; echo same\necho next\n");
		run(id, &script, "", true, 1).await;
	}
}

#[tokio::test]
async fn getopts_special_variable_assignments_propagate_indexed_subscript_errors() {
	for (id, script) in [
		(
			"getopts-optarg-reference",
			"a=(zero one); declare -n OPTARG='a[1+]'; echo before; getopts x: r -x value; echo \
			 same\necho next\n",
		),
		(
			"getopts-optind-reference",
			"a=(zero one); declare -n OPTIND='a[1+]'; echo before; getopts x r -x; echo same\necho \
			 next\n",
		),
	] {
		run(id, script, "before\n", true, 1).await;
	}
}

/// Bash's `top_level_cleanup` runs before the shell exits, so the EXIT trap
/// of a `-c` string sees the global scope and the run's own descriptors,
/// not the frame the failing command was under.
#[tokio::test]
async fn the_exit_trap_runs_after_the_discarded_command_is_unwound() {
	run(
		"exit-trap-scope",
		"a=(zero one)\nx=global\ntrap 'echo \
		 EXIT:x=$x:func=${FUNCNAME[*]}:status=$?' EXIT\nf(){ local x=local; (( a[1+] )); echo \
		 BAD; }\nf\necho AFTER\n",
		"EXIT:x=global:func=:status=1\n",
		true,
		1,
	)
	.await;
}

/// The same unwinding closes the failing command's redirections: the EXIT
/// trap's output goes to the shell's stdout, not to the file the function
/// call was redirected into.
#[test]
fn the_exit_trap_does_not_inherit_the_discarded_command_s_redirection() {
	let dir = tempfile::tempdir().expect("tempdir");
	let out = obash_support::output(
		obash_support::obash()
			.args(["-c", "trap 'echo EXIT:$?' EXIT\nf(){ (( a[1+] )); }\nf >redirected\necho BAD\n"])
			.current_dir(dir.path()),
	);
	assert_eq!(String::from_utf8_lossy(&out.stdout), "EXIT:1\n");
	assert_eq!(out.status.code(), Some(1));
	assert_eq!(
		std::fs::read_to_string(dir.path().join("redirected")).unwrap_or_default(),
		"",
		"the EXIT trap wrote through the discarded command's redirection"
	);
}

/// A syntax error inside a command substitution exits a `-c` string with
/// the substitution's 127 (bash's `parse_and_execute`), and a script file
/// with the parser's own 2. The status is the run's, not the unit's.
#[test]
fn a_command_substitution_syntax_error_reports_the_status_of_its_origin() {
	let script = "echo \"$(for ((i=0;0;i+(;))); do :; done\n)\"\necho next\n";
	let dir = tempfile::tempdir().expect("tempdir");
	let path = dir.path().join("main.bash");
	std::fs::write(&path, script).expect("script fixture");
	let from_file =
		obash_support::output(obash_support::obash().arg(&path).current_dir(dir.path()));
	assert_eq!(String::from_utf8_lossy(&from_file.stdout), "");
	assert!(!from_file.stderr.is_empty());
	assert_eq!(from_file.status.code(), Some(2), "a script file reports the parser's status");

	let from_command = obash_support::output(
		obash_support::obash().args(["-c", script]).current_dir(dir.path()),
	);
	assert_eq!(String::from_utf8_lossy(&from_command.stdout), "");
	assert!(!from_command.stderr.is_empty());
	assert_eq!(
		from_command.status.code(),
		Some(127),
		"a -c string reports the command substitution's status"
	);
}
