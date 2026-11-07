//! Literal Bash 5.3.0 `--noprofile --norc -c` goldens from the arithmetic
//! corpus. Replay must preserve arithmetic recognition and read here-document
//! bodies from physical input, not from the text pushed by `parse_dparen`.
#![cfg(unix)]

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
	.expect("arithmetic replay exceeded its deadline")
	.expect("shell execution");
	let collect = |rx: flume::Receiver<bytes::Bytes>| {
		String::from_utf8(rx.drain().flat_map(|chunk| chunk.to_vec()).collect()).expect("utf-8")
	};
	assert!(!result.timed_out, "{id}: {script:?} timed out");
	assert_eq!(collect(stdout_rx), stdout, "{id}: {script:?}");
	assert_eq!(!collect(stderr_rx).is_empty(), stderr, "{id}: {script:?}");
	assert_eq!(result.exit_code, Some(status), "{id}: {script:?}");
}

#[tokio::test]
async fn continued_openings_do_not_execute_shell_words_when_arithmetic_closes() {
	for (id, script) in [
		("97e4a4e77ee089813635", "(\\\n( (echo ran) ))\necho after\n"),
		("f7cdc6737388c7456f97", "(\\\n(echo ran))\necho after\n"),
	] {
		run(id, script, "after\n", true, 0).await;
	}
}

#[tokio::test]
async fn fallback_replay_distinguishes_inner_and_closing_continuations() {
	for (id, script, stdout, stderr) in [
		("970bbf3a552091568e0c", "(((echo ran)\\\n) )\necho after\n", "after\n", true),
		("a706f8f288ece9ee1c54", "(\\\n( (echo ran) )\\\n)\necho after\n", "ran\nafter\n", false),
		("b9716d7632aeb3956532", "(\\\n(echo ran)\\\n)\necho after\n", "ran\nafter\n", false),
		("dd522adab68c19ad1801", "(\\\n(echo ran)\\\n )\necho after\n", "ran\nafter\n", false),
		("fa71c2049614fa394a81", "(\\\n(echo ran) \\\n)\necho after\n", "ran\nafter\n", false),
		("8ac9271d396daf585d17", "(\\\n(echo ran)\n)\necho after\n", "ran\nafter\n", false),
		("9919880b21fffa8865ad", "(\\\n(echo ran)\t\\\n)\necho after\n", "ran\nafter\n", false),
	] {
		run(id, script, stdout, stderr, 0).await;
	}
}

#[tokio::test]
async fn fallback_here_document_reads_past_the_physical_line_not_from_replay() {
	for (id, script, stdout) in [
		("905e3e16cf37d3fc06ca", "((cat <<EOF\nhello\nEOF\n) )\n", ""),
		("5d6327dcf942cdb0aa01", "((cat <<EOF\nhello\nEOF\n) )\necho after\n", "echo after\n"),
		(
			"829549b493219f5e823c",
			"(( for ((i=0;0;i++)); do :; done; cat <<EOF\ndoc\nEOF\n) )\ncat <<AFTER\nafter\nAFTER\n",
			"cat <<AFTER\nafter\nAFTER\n",
		),
	] {
		run(id, script, stdout, true, 127).await;
	}
}

#[tokio::test]
async fn arithmetic_recognition_counts_parentheses_in_physical_here_document_text() {
	run("2942018c2cc9403047da", "((cat <<EOF\n(\nEOF\n) )\necho rc=$?\n", "", true, 2).await;
}
