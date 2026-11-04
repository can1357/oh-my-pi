//! Host tools must run their own operands, not the calling function's `$@`.
//! External-operand expectations were checked with Bash 5.2.21 and 5.3.0;
//! both agree. `timeout` and `nohup` of a shell function are pi extensions;
//! `ifne` is not installed with the reference shells.
#![cfg(unix)]

use std::{collections::HashMap, fs};

use pi_shell::{Shell, ShellOptions, ShellRunOptions, cancel::CancelToken};

async fn assert_callout(command: &str, status: i32, marker: &str) {
	let dir = tempfile::tempdir().expect("tempdir");
	let session_env = HashMap::from([
		("PI_DISABLE_NOHUP_BUILTIN".into(), "0".into()),
		("PI_DISABLE_UUTILS_BUILTINS".into(), "0".into()),
		("PI_SMART_GIT".into(), "1".into()),
		("PI_GIT_GUARD".into(), "0".into()),
	]);
	let shell =
		Shell::new(Some(ShellOptions { session_env: Some(session_env), ..Default::default() }));
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
	let output: String = rx.drain().collect();
	assert_eq!(
		(result.exit_code, fs::read_to_string(dir.path().join("marker")).ok()),
		(Some(status), Some(marker.into())),
		"`{command}`; output: {output:?}"
	);
}

#[tokio::test]
async fn timeout_in_function_runs_operand() {
	assert_callout("f(){ timeout 5 /bin/sh -c 'printf ran > marker'; }; f", 0, "ran").await;
}

#[tokio::test]
async fn nohup_in_function_runs_operand_and_returns_failure() {
	assert_callout(
		"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn timeout_in_nested_function_returns_operand_status() {
	assert_callout(
		"f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }; g(){ f; }; g",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn function_callout_runs_when_function_is_called_in_subshell() {
	assert_callout("f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }; (f)", 3, "ran")
		.await;
}

#[tokio::test]
async fn function_callout_runs_in_pipeline_stage() {
	assert_callout(
		"set -o pipefail; f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }; f | cat",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn function_callout_runs_when_function_is_called_from_eval() {
	assert_callout("f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }; eval f", 3, "ran")
		.await;
}

#[tokio::test]
async fn function_callout_runs_when_function_is_background_job() {
	assert_callout(
		"f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }; f & wait $!",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn callout_runs_inside_subshell_in_function() {
	assert_callout("f(){ (timeout 5 /bin/sh -c 'printf ran > marker; exit 3'); }; f", 3, "ran")
		.await;
}

#[tokio::test]
async fn callout_runs_inside_eval_in_function() {
	assert_callout(
		"f(){ eval \"timeout 5 /bin/sh -c 'printf ran > marker; exit 3'\"; }; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn callout_runs_inside_background_job_in_function() {
	assert_callout(
		"f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3' & wait $!; }; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_background_in_function_exposes_pid_and_wait_status() {
	assert_callout(
		"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1 & p=$!; wait \"$p\"; \
		 s=$?; [ \"$p\" -gt 0 ] || return 99; return \"$s\"; }; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn timeout_in_function_reaches_deadline() {
	assert_callout(
		"f(){ timeout 0.2 sleep 5; s=$?; printf '%s' \"$s\" > marker; return \"$s\"; }; f",
		124,
		"124",
	)
	.await;
}

#[tokio::test]
async fn timeout_function_operand_keeps_locals_and_uses_operand_arguments() {
	// External timeout cannot run an unexported shell function: pi extension.
	assert_callout(
		"operand(){ printf '%s:%s\n' \"$local_value\" \"$1\" > marker; return 3; }; f(){ local \
		 local_value=local; timeout 5 operand argument; s=$?; printf '%s\n' \"$1\" >> marker; \
		 return \"$s\"; }; f caller",
		3,
		"local:argument\ncaller\n",
	)
	.await;
}

#[tokio::test]
async fn callout_operand_does_not_execute_callers_positional_parameters() {
	assert_callout(
		"f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }; f /bin/sh -c 'printf wrong > \
		 marker; exit 7'",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn env_in_function_runs_operand() {
	assert_callout("f(){ env /bin/sh -c 'printf ran > marker; exit 3'; }; f", 3, "ran").await;
}

#[tokio::test]
async fn ifne_in_function_runs_operand() {
	assert_callout(
		"f(){ printf input | ifne /bin/sh -c 'printf ran > marker; exit 3'; }; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn xargs_in_function_runs_operand_and_maps_failure() {
	assert_callout(
		"f(){ printf input | xargs /bin/sh -c 'printf ran > marker; exit 3'; }; f",
		123,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn find_exec_in_function_runs_operand() {
	assert_callout(
		"f(){ find . -maxdepth 0 -exec /bin/sh -c 'printf ran > marker; exit 3' ';'; }; f",
		0,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn git_tool_in_function_runs_git_alias_and_returns_failure() {
	assert_callout("f(){ git -c 'alias.mark=!printf ran > marker; exit 3' mark; }; f", 3, "ran")
		.await;
}

#[tokio::test]
async fn top_level_callouts_keep_operand_status() {
	assert_callout(
		"timeout 5 /bin/sh -c 'printf timeout > marker; exit 3'; s=$?; nohup /bin/sh -c 'printf \
		 nohup >> marker; exit 3' >/dev/null 2>&1; n=$?; [ \"$s:$n\" = 3:3 ] || exit 99; exit \"$n\"",
		3,
		"timeoutnohup",
	)
	.await;
}

#[tokio::test]
async fn nohup_in_nested_function_returns_operand_status() {
	assert_callout(
		"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }; g(){ f; }; g",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_function_called_in_subshell_runs_operand() {
	assert_callout(
		"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }; (f)",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_function_called_in_pipeline_stage_runs_operand() {
	assert_callout(
		"set -o pipefail; f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }; f \
		 | cat",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_function_called_from_eval_runs_operand() {
	assert_callout(
		"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }; eval f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_function_called_as_background_job_runs_operand() {
	assert_callout(
		"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }; f & wait $!",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_in_subshell_inside_function_runs_operand() {
	assert_callout(
		"f(){ (nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1); }; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_in_eval_inside_function_runs_operand() {
	assert_callout(
		"f(){ eval \"nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1\"; }; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_operand_does_not_execute_callers_positional_parameters() {
	assert_callout(
		"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }; f /bin/sh -c \
		 'printf wrong > marker; exit 7'",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_function_operand_keeps_locals_and_uses_operand_arguments() {
	// External nohup cannot run an unexported shell function: pi extension.
	assert_callout(
		"operand(){ printf '%s:%s\n' \"$local_value\" \"$1\" > marker; return 3; }; f(){ local \
		 local_value=local; nohup operand argument >/dev/null 2>&1; s=$?; printf '%s\n' \"$1\" >> \
		 marker; return \"$s\"; }; f caller",
		3,
		"local:argument\ncaller\n",
	)
	.await;
}

#[tokio::test]
async fn timeout_in_sourced_function_runs_operand() {
	assert_callout(
		"printf '%s\n' \"f(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }\" > \
		 function.sh; source ./function.sh; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_in_sourced_function_runs_operand() {
	assert_callout(
		"printf '%s\n' \"f(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null 2>&1; }\" > \
		 function.sh; source ./function.sh; f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn timeout_in_function_called_through_alias_runs_operand() {
	assert_callout(
		"shopt -s expand_aliases\nf(){ timeout 5 /bin/sh -c 'printf ran > marker; exit 3'; }\nalias \
		 run_f=f\nrun_f",
		3,
		"ran",
	)
	.await;
}

#[tokio::test]
async fn nohup_in_function_called_through_alias_runs_operand() {
	assert_callout(
		"shopt -s expand_aliases\nf(){ nohup /bin/sh -c 'printf ran > marker; exit 3' >/dev/null \
		 2>&1; }\nalias run_f=f\nrun_f",
		3,
		"ran",
	)
	.await;
}
