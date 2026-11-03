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
