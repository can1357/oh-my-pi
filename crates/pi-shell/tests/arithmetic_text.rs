//! Literal stdout, stderr-presence and status goldens recorded with Bash 5.3.0
//! via `bash --noprofile --norc -c`, not a script file. Bash 5.2.21 agrees.
#![cfg(unix)]

use std::time::Duration;

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams},
};

async fn run(script: &str, stdout: &str, stderr: bool, status: i32) {
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
	.expect("arithmetic script exceeded its deadline")
	.expect("shell execution");
	let collect = |rx: flume::Receiver<bytes::Bytes>| {
		String::from_utf8(rx.drain().flat_map(|chunk| chunk.to_vec()).collect()).expect("utf-8")
	};
	assert!(!result.timed_out, "{script:?} timed out");
	assert_eq!(collect(stdout_rx), stdout, "{script:?}");
	assert_eq!(!collect(stderr_rx).is_empty(), stderr, "{script:?}");
	assert_eq!(result.exit_code, Some(status), "{script:?}");
}

#[tokio::test]
async fn newline_condition_is_zero_not_an_omitted_condition() {
	// `break` bounds a regression independently of the execution deadline.
	run(
		concat!(
			"echo \"[$((\n))]\"\n",
			"for ((i=0;\n;i++)); do echo unexpected; break; done\n",
			"echo \"newline=$?\"\n",
			"for ((i=0; \t\n \t;i++)); do echo unexpected; break; done\n",
			"echo \"mixed=$?\"\n",
			"for ((;;)); do echo empty; break; done\n",
			"for ((; \t;)); do echo blanks; break; done\n",
			"for ((;\\\n;)); do echo continued; break; done\n",
		),
		"[0]\nnewline=0\nmixed=0\nempty\nblanks\ncontinued\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn non_bash_whitespace_in_for_clauses_reports_an_arithmetic_error() {
	for ch in ['\r', '\u{000b}', '\u{000c}'] {
		let script = format!(
			"for (({ch};0;)); do echo unexpected; break; done\necho init=$?\nfor ((;{ch};)); do echo \
			 unexpected; break; done\necho cond=$?\nfor ((i=0;i++<1;{ch})); do echo body; done\necho \
			 step=$?\n"
		);
		run(&script, "init=1\ncond=1\nbody\nstep=1\n", true, 0).await;
	}
}

#[tokio::test]
async fn non_bash_whitespace_is_not_ignored_by_arithmetic_evaluation() {
	for ch in ['\r', '\u{000b}', '\u{000c}'] {
		let script = format!(
			"(({ch})); echo empty=$?\n((1{ch})); echo number=$?\n((1{ch}+1)); echo \
			 operator=$?\nv='{ch}'; ((v)); echo variable=$?\n"
		);
		run(&script, "empty=1\nnumber=1\noperator=1\nvariable=1\n", true, 0).await;
	}
}

#[tokio::test]
async fn continued_opening_parentheses_still_start_arithmetic() {
	run(
		"for (\\\n(i=0;;i++)); do echo for=$i; break; done\n(\\\n(x=2))\necho x=$x\n",
		"for=0\nx=2\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn parameter_word_semicolons_do_not_split_arithmetic_for_clauses() {
	run(
		concat!(
			"v=0\nfor ((i=${v:-;};0;)); do :; done\necho unused=$?\nunset v\n",
			"for ((i=${v:-0;0};0;)); do echo never; break; done\necho init=$?\n",
			"for ((i=0;${v:-0;1};)); do echo never; break; done\necho cond=$?\n",
			"for ((i=0;0;${v:-;})); do :; done\necho unused_step=$?\n",
		),
		"unused=0\ninit=1\ncond=1\nunused_step=0\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn invalid_arithmetic_lookahead_prevents_unfinished_assignments() {
	run(
		concat!(
			"unset x\n((x=1 #c\n)); echo \"hash=${x-unset}:$?\"\n",
			"((x=1;2)); echo \"semi=${x-unset}:$?\"\n",
			"((x=1 @)); echo \"at=${x-unset}:$?\"\n",
			"x=0; ((x++ #c)); echo \"post=$x:$?\"\n",
			"x=0; ((++x #c)); echo \"pre=$x:$?\"\n",
			"x=0; ((x++ + 1 #c)); echo \"prior=$x:$?\"\n",
			"x=0; ((x=1, x=2 #c)); echo \"comma=$x:$?\"\n",
		),
		"hash=unset:1\nsemi=unset:1\nat=unset:1\npost=1:1\npre=0:1\nprior=1:1\ncomma=1:1\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn arithmetic_for_errors_end_the_loop_not_the_command_list() {
	run(
		concat!(
			"echo \"$(for ((i=0; #c\n;i++)); do echo never; done; echo rc=$?)\"\n",
			"echo before; for (((i=0;j=1);)); do break; done; echo \"after=$?\"\n",
		),
		"rc=1\nbefore\nafter=1\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn malformed_arithmetic_fallback_reports_its_substitution_error() {
	run(
		concat!(
			"v=1; printf \"[%s]\\n\" \"$(( ${v-'('1)} ))\"; echo after\n",
			"echo \"${v-$(( ${v-'('1)} ))}\"; echo lazy\n",
		),
		"[)]\nafter\n1\nlazy\n",
		true,
		0,
	)
	.await;
}

#[tokio::test]
async fn bracket_arithmetic_expands_ansi_c_quotes() {
	run(
		"v=1; echo \"$[ ${v+$'('1)} ]\"\necho \"$[ $'1' ]\"\necho after\n",
		"1\n1\nafter\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn arithmetic_parse_errors_in_command_substitutions_use_bash_c_status() {
	run(
		concat!(
			"echo \"$( for ((x=${v:-$(( ${w:?(} ))};0;)); do :; done; echo x=$x )\"\n",
			"echo after\n",
		),
		"",
		true,
		127,
	)
	.await;
}

// Both Bash 5.2.21 and 5.3.0 segfault on this input. The explicit expectation
// is a parse error instead, with no command execution, as approved for this
// reference-shell defect.
#[tokio::test]
async fn malformed_for_inside_a_pending_here_document_fails_without_execution() {
	let dir = tempfile::tempdir().expect("marker directory");
	let marker = dir.path().join("marker");
	let script = format!(
		"v=0\ncat <<EOF; echo \"$( for ((i=0;0;i+(;))); do echo body; printf ran > '{}'; break; done )\"\ndoc\nEOF\necho rc=$?\n",
		marker.display(),
	);
	run(&script, "", true, 2).await;
	assert!(!marker.exists(), "the invalid loop wrote its marker");
}

#[tokio::test]
async fn grouped_conditional_function_definitions_inside_here_documents_do_not_abort() {
	run(
		concat!(
			"cat <<DOC\n$(\nv=1\nf() [[ (( a == @(a) )) ]]\n",
			"printf \"rc=%s\\n\" \"$?\"\n)\nDOC\n",
		),
		"rc=0\n",
		false,
		0,
	)
	.await;
}

#[tokio::test]
async fn regexp_groups_count_parentheses_inside_parameter_words() {
	run("v=1\n[[ a =~ (a|(( ${v:-(} ))) ]]\necho rc=$?\n", "", true, 2).await;
}
