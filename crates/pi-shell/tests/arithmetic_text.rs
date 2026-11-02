//! Text between `((` and `))` is arithmetic, not shell syntax: semicolons in it
//! never end a command or a case item. Expected output is Bash 5.2.21's for the
//! same script run from a file.
#![cfg(unix)]

use pi_shell::{
	cancel::CancelToken,
	shell::{ShellExecuteOptions, StreamSinks, execute_shell_streams},
};

struct Run {
	exit_code: Option<i32>,
	stdout:    String,
	stderr:    String,
}

async fn run(script: &str) -> Run {
	let dir = tempfile::tempdir().expect("tempdir");
	let (stdout_tx, stdout_rx) = flume::unbounded();
	let (stderr_tx, stderr_rx) = flume::unbounded();
	let result = execute_shell_streams(
		ShellExecuteOptions {
			command: script.to_string(),
			cwd: Some(dir.path().to_string_lossy().into_owned()),
			timeout_ms: Some(30_000),
			..Default::default()
		},
		StreamSinks { stdout: Some(stdout_tx), stderr: Some(stderr_tx) },
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let collect = |rx: flume::Receiver<bytes::Bytes>| {
		String::from_utf8(rx.drain().flat_map(|chunk| chunk.to_vec()).collect()).expect("utf-8")
	};
	Run { exit_code: result.exit_code, stdout: collect(stdout_rx), stderr: collect(stderr_rx) }
}

/// `for ((i=0;;i++))` and `for ((;;))` were syntax errors: the tokenizer reads
/// the empty condition's `;;` as a case-item terminator.
#[tokio::test]
async fn arithmetic_for_header_with_adjacent_semicolons_runs() {
	let out = run(concat!(
		"for ((i=0;;i++)); do\n",
		"  case $i in 0) echo zero;; 1) echo one;; *) break;; esac\n",
		"done\n",
		"case x in x) for ((;;)); do echo arm; break; done;; esac\n",
		"echo \"sub=$(for ((j=0;;)); do echo $j; break; done)\"\n",
	))
	.await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "zero\none\narm\nsub=0\n");
	assert_eq!(out.exit_code, Some(0));
}

/// Bash splits the header at every `;`, also inside the `;;&` and `;&`
/// terminators and inside parentheses, and evaluates each part only when the
/// loop reaches it: an updater the loop never runs cannot fail, and a bad
/// initializer or condition fails at run time, not as a syntax error.
#[tokio::test]
async fn arithmetic_for_header_splits_at_every_semicolon() {
	let out = run(concat!(
		"for ((i=0;;&x)); do echo \"body $i\"; break; done\n",
		"echo \"rc=$?\"\n",
		"for ((i=0;&x;)); do echo never; done\n",
		"echo \"rc=$?\"\n",
		"for (((i=0;j=1);)); do echo never; done\n",
		"echo \"rc=$?\"\n",
	))
	.await;
	assert_eq!(out.stdout, "body 0\nrc=0\nrc=1\nrc=1\n", "stderr: {}", out.stderr);
	assert!(out.stderr.contains("&x"), "the condition `&x` must be reported: {}", out.stderr);
	assert!(out.stderr.contains("(i=0"), "the initializer `(i=0` must be reported: {}", out.stderr);
}

/// Bash evaluates `((echo a; echo b))` as one (invalid) arithmetic
/// expression, inside nested parentheses too; it never runs the words as
/// commands.
#[tokio::test]
async fn arithmetic_command_keeps_semicolons_as_arithmetic_text() {
	let out =
		run("((echo a; echo b))\necho \"rc=$?\"\n(( (echo c; echo d) ))\necho \"rc=$?\"\n").await;
	assert_eq!(out.stdout, "rc=1\nrc=1\n", "stderr: {}", out.stderr);
	assert!(
		out.stderr.contains("echo a; echo b"),
		"the expression must be reported: {}",
		out.stderr
	);
	assert!(
		out.stderr.contains("echo c; echo d"),
		"the expression must be reported: {}",
		out.stderr
	);
}

/// `((` and `))` bound arithmetic text only with no space inside the pair;
/// `( (` and `) )` open and close nested subshells, and a here-document after
/// them is read as one.
#[tokio::test]
async fn spaced_double_parentheses_are_nested_subshells() {
	let out = run(concat!(
		"( (exit 3))\n",
		"echo \"open=$?\"\n",
		"((exit 4) )\n",
		"echo \"close=$?\"\n",
		"((echo a;) )\n",
		"cat <<EOF\n",
		"doc\n",
		"EOF\n",
	))
	.await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "open=3\nclose=4\na\ndoc\n");
}

/// An arithmetic expansion inside `(( ))` leaves the rest of the command
/// arithmetic: a later `<<` is a shift, not a here-document.
#[tokio::test]
async fn arithmetic_expansion_inside_arithmetic_command_keeps_shift() {
	let out = run("(( x = $((1)) << 2 ))\necho \"x=$x\"\n").await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "x=4\n");
}

/// An arithmetic expression of only blanks and newlines is 0, as in Bash; a
/// header part holding just a newline is one.
#[tokio::test]
async fn blank_arithmetic_expression_is_zero() {
	let out = run(concat!(
		"echo \"[$((\n))]\"\n",
		"for ((i=0;\n;i++)); do echo never; done\n",
		"echo \"rc=$?\"\n",
	))
	.await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "[0]\nrc=0\n");
}
