//! Literal Bash 5.3.0 `--noprofile --norc -c` goldens. An arithmetic-for
//! YYERROR can discard an unfinished word while retaining the command before
//! it; reaching a newline during recovery instead abandons that command.
#![cfg(unix)]

use std::time::Duration;

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams},
};

async fn run(id: &str, script: &str, stdout: &str, status: i32) {
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
	.expect("arithmetic recovery exceeded its deadline")
	.expect("shell execution");
	let collect = |rx: flume::Receiver<bytes::Bytes>| {
		String::from_utf8(rx.drain().flat_map(|chunk| chunk.to_vec()).collect()).expect("utf-8")
	};
	assert!(!result.timed_out, "{id}: {script:?} timed out");
	assert_eq!(collect(stdout_rx), stdout, "{id}: {script:?}");
	assert!(!collect(stderr_rx).is_empty(), "{id}: missing diagnostic for {script:?}");
	assert_eq!(result.exit_code, Some(status), "{id}: {script:?}");
	assert!(!dir.path().join("marker").exists(), "{id}: the invalid loop executed");
}

#[tokio::test]
async fn eof_recovery_keeps_the_command_but_drops_its_unfinished_word_and_remaining_input() {
	run(
		"00ca30a711176eb6a286",
		"v=0\nprintf \"<%s>\\n\" \"$( for ((i=0;0;i+(;))); do echo body; break; done )\"\necho after\n",
		"<>\n",
		0,
	)
	.await;
}

#[tokio::test]
async fn dropping_the_only_assignment_leaves_the_arithmetic_for_error_status() {
	run(
		"semantic-refs:assignment",
		"x=\"$( for ((i=0;0;i+(;))); do echo body; break; done )\"\nprintf \"status=%s x=%s\\n\" \"$?\" \"$x\"\n",
		"",
		2,
	)
	.await;
}

#[tokio::test]
async fn recovery_drops_the_whole_parameter_word_even_when_its_default_is_unused() {
	run(
		"semantic-refs:unused",
		"v=1; echo \"${v:-$( for ((i=0;0;i+(;))); do echo body; break; done )}\"\necho after\n",
		"\n",
		0,
	)
	.await;
}

#[tokio::test]
async fn recovery_discards_commands_and_separators_after_the_bad_loop() {
	for (id, script) in [
		(
			"semantic-refs:extra-command",
			"printf \"<%s>\\n\" \"$( for ((i=0;0;i+(;))); do echo body; break; done; echo next )\"\necho after\n",
		),
		(
			"semantic-refs:semi-close",
			"printf \"<%s>\\n\" \"$( for ((i=0;0;i+(;))); do echo body; break; done; )\"\necho after\n",
		),
	] {
		run(id, script, "<>\n", 0).await;
	}
}

#[tokio::test]
async fn newline_recovery_abandons_the_containing_command_with_status_127() {
	run(
		"semantic-refs:newline-close",
		"printf \"<%s>\\n\" \"$( for ((i=0;0;i+(;))); do echo body; break; done\n )\"\necho after\n",
		"",
		127,
	)
	.await;
}

#[tokio::test]
async fn a_case_pattern_close_in_the_completed_body_does_not_end_recovery() {
	run(
		"semantic-refs:case-body",
		"printf \"<%s>\\n\" \"$( for ((i=0;0;i+(;))); do case x in x) echo body;; esac; done )\"\necho after\n",
		"<>\n",
		0,
	)
	.await;
}

#[tokio::test]
async fn arithmetic_fallback_inside_the_substitution_preserves_word_eof_recovery() {
	run(
		"bf3ab13a5723f589ad21",
		"v=0\necho \"$( (( for ((i=0;0;i+(;))); do echo body; break; done ) ) )\"\necho rc=$?\n",
		"\n",
		0,
	)
	.await;
}

#[tokio::test]
async fn unquoted_arithmetic_substitution_tails_recover_at_newline_not_word_eof() {
	for (id, script) in [
		(
			"53af3b72d3c06b50ad10",
			"unset v\n((x=$( for ((i=0;0;i+(;))); do echo body; break; done; echo 1 )))\necho rc=$?\n",
		),
		(
			"dbeabc0f037fd679426f",
			"unset v\necho $[ $( for ((i=0;0;i+(;))); do echo body; break; done; echo 1 ) ]\necho rc=$?\n",
		),
	] {
		run(id, script, "", 127).await;
	}
}

#[tokio::test]
async fn eof_before_any_complete_command_retains_status_2() {
	for (id, script) in [
		(
			"5a68bc3b10d5f28d80b5",
			"for ((i=0;0;i+(;))); do echo never; done\necho after\n",
		),
		(
			"968a999cdcca2b4dbe62",
			"v=0\n(( echo \"$( for ((i=0;0;i+(;))); do echo body; printf ran > marker; break; done )\" ) )\necho rc=$?\n",
		),
	] {
		run(id, script, "", 2).await;
	}
}

// Both reference Bash versions segfault on these five corpus rows. The
// approved contract is a syntax error, status 2, and no command execution.
#[tokio::test]
async fn pending_outer_here_documents_fail_safely_without_word_eof_recovery() {
	for (id, script) in [
		(
			"4307d039542d3251efad",
			"v=0\ncat <<EOF; echo \"$( for ((i=0;0;i+(;))); do echo body; printf ran > marker; break; done )\"\ndoc\nEOF\necho rc=$?\n",
		),
		(
			"e0246cd55cff6058cd18",
			"v=0\ncat <<'EOF'; echo \"$( for ((i=0;0;i+(;))); do echo body; printf ran > marker; break; done )\"\ndoc\nEOF\necho rc=$?\n",
		),
		(
			"845db30f405f2cabeb38",
			"v=0\ncat <<-EOF; echo \"$( for ((i=0;0;i+(;))); do echo body; printf ran > marker; break; done )\"\ndoc\nEOF\necho rc=$?\n",
		),
		(
			"8046418935e81e1359e0",
			"v=0\ncat <<for; echo \"$( for ((i=0;0;i+(;))); do echo body; printf ran > marker; break; done )\"\ndoc\nfor\necho rc=$?\n",
		),
		(
			"7457930d815c46f87d21",
			"v=0\ncat <<EOF <<SECOND; echo \"$( for ((i=0;0;i+(;))); do echo body; printf ran > marker; break; done )\"\ndoc\nEOF\ndoc2\nSECOND\necho rc=$?\n",
		),
	] {
		run(id, script, "", 2).await;
	}
}
