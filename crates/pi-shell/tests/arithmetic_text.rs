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

/// The tokenizer leaves arithmetic where the `((` text ends, also inside a
/// command substitution, and an arithmetic expansion inside `(( ))` leaves
/// the rest of the command arithmetic: a later `<<` is a here-document after
/// the text and a shift inside it.
#[tokio::test]
async fn arithmetic_state_ends_with_its_text() {
	let out = run(concat!(
		"(( x = $((1)) << 2 ))\n",
		"echo \"x=$x\"\n",
		"echo \"$( ((y=1)); echo $((2 << 1)); cat <<EOF\n",
		"hello ) here\n",
		"EOF\n",
		")\"\n",
	))
	.await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "x=4\n4\nhello ) here\n");
}

/// The header of an arithmetic `for` loop has no comments and no extended
/// globs: Bash reads `#c` and `*(` as part of its expressions, so a bad header
/// fails at run time instead of being silently shortened.
#[tokio::test]
async fn arithmetic_for_header_has_no_comments_or_extended_globs() {
	let out = run(concat!(
		"for ((i=0; #c\n",
		";i++)); do echo never; done\n",
		"echo \"rc=$?\"\n",
		"for ((i=0*(;1);)); do echo never; done\n",
		"echo \"rc=$?\"\n",
	))
	.await;
	assert_eq!(out.stdout, "rc=1\nrc=1\n", "stderr: {}", out.stderr);
	assert!(out.stderr.contains("#c"), "the `#c` expression must be reported: {}", out.stderr);
	assert!(out.stderr.contains("i=0*("), "the `i=0*(` expression must be reported: {}", out.stderr);
}

/// A `for ((` header keeps those rules wherever it stands: after a here tag on
/// the same line, and inside the text of a bare `((` that turns out to open
/// nested subshells, which Bash reads again as shell text. Such a header
/// leaves the text around it as deep as it was, so a later `<<` there is
/// still a shift.
#[tokio::test]
async fn arithmetic_for_header_rules_hold_after_here_tags_and_in_spaced_subshells() {
	let out = run(concat!(
		"(( for ((i=0; #c\n",
		";i++)); do :; break; done ) )\n",
		"echo \"rc=$?\"\n",
		"cat <<EOF; for ((i=0; #c ;i++)); do echo never; done\n",
		"doc\n",
		"EOF\n",
		"echo \"rc=$?\"\n",
	))
	.await;
	assert_eq!(out.stdout, "rc=1\ndoc\nrc=1\n", "stderr: {}", out.stderr);
	assert!(out.stderr.contains("#c"), "the `#c` expression must be reported: {}", out.stderr);

	let out = run("cat <<EOF; for ((i=0;0;i+(;))); do :; done\ndoc\nEOF\necho ran\n").await;
	assert_eq!(out.stdout, "", "the four-part header ran; stderr: {}", out.stderr);
	assert_eq!(out.exit_code, Some(2), "stderr: {}", out.stderr);

	let out = run("(( for ((1)) << 2 ))\necho \"rc=$?\"\necho after\n").await;
	assert_eq!(out.stdout, "rc=1\nafter\n", "stderr: {}", out.stderr);
	assert!(out.stderr.contains("for"), "the expression must be reported: {}", out.stderr);
}

/// Bash counts the parentheses of the `${...}` words of an arithmetic `for`
/// header toward the header, so the header parses when they cancel out across
/// its words and is a syntax error when they do not, in either direction. A
/// `${...}` word is text everywhere: a `((` in it keeps the rest of the
/// line's comments, and a `<<` in it is not a here-document.
#[tokio::test]
async fn parameter_word_parentheses_follow_bash() {
	let out = run(concat!(
		"unset v\n",
		"echo \"<${v:-((x}>\"\n",
		"echo \"<${v:-((1<<2))}>\"\n",
		"echo after # comment\n",
	))
	.await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "<((x>\n<((1<<2))>\nafter\n");

	let out = run(concat!(
		"v=\n",
		"((x=${v:-(1)}))\n",
		"echo \"x=$x\"\n",
		"for ((i=${v:-(0)};i<1;i++)); do echo \"i=$i\"; done\n",
		"v=1\n",
		"((y=${v:-${w:-(1})}))\n",
		"echo \"y=$y $(( ${v:-${w:-(2})} ))\"\n",
	))
	.await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "x=1\ni=0\ny=1 1\n");

	// Parentheses that cancel out across the header leave it where the parser
	// ends it, as in Bash, wherever they stand: in one word, across two words,
	// in an arithmetic expansion, in a `$[ ]`, or against a literal one. The
	// expressions they make are then evaluated, and these fail at run time in
	// Bash too.
	let out = run(concat!(
		"v=\n",
		"w=0\n",
		"for ((j=${v:-(}${w:-)};j<1;j++)); do echo \"j=$j\"; done\n",
		"echo \"rc=$?\"\n",
		"for ((k=${v:-(};${w:-)};)); do echo never; done\n",
		"echo \"rc=$?\"\n",
	))
	.await;
	assert_eq!(out.stdout, "rc=1\nrc=1\n", "stderr: {}", out.stderr);
	assert!(out.stderr.contains("j=(0"), "the expression must be reported: {}", out.stderr);

	let out = run(concat!(
		"unset v\n",
		"w=0\n",
		"for ((i=${v-$(( (0) ))};0;)); do :; done\n",
		"echo \"a=$?\"\n",
		"for ((i=(0${v:-)};0;)); do :; done\n",
		"echo \"b=$?\"\n",
		"for ((i=${w:-(}$[ ${w:-)} ];0;)); do :; done\n",
		"echo \"c=$?\"\n",
	))
	.await;
	assert_eq!(out.stdout, "a=0\nb=0\nc=0\n", "stderr: {}", out.stderr);
	assert_eq!(out.stderr, "");

	// A parenthesis is text where Bash reads text: quoted, escaped, inside
	// `$'...'` whose quote is escaped, and inside a command substitution,
	// whose own parentheses belong to the command it runs. A `#` in a word
	// starts no comment, so it hides none of them.
	let out = run(concat!(
		"v=0\n",
		"for ((i=(0+${v:-(0)});i<1;i++)); do printf a; done\n",
		"for ((i=${v:-$'\\'('};i<1;i++)); do printf b; done\n",
		"for ((i=${v:-$(echo ${v:-(})};i<1;i++)); do printf c; done\n",
		"for ((i=${v:-`echo \"(\"`};i<1;i++)); do printf d; done\n",
		"for ((i=${v:-(}${v:- # )};i<1;i++)); do printf e; done\n",
		"for ((i=${v:-\\(};i<1;i++)); do printf f; done\n",
		"echo\n",
	))
	.await;
	assert_eq!(out.stdout, "abcdef\n", "stderr: {}", out.stderr);
	assert_eq!(out.stderr, "");
	for script in [
		"v=1\nfor ((x=${v:?(};0;)); do :; done\necho after\n",
		"v=1\nfor ((x=${v:-(};0;)); do :; done\necho after\n",
		"v=0\nfor ((i=${v:-)};0;)); do :; done\necho after\n",
		"v=0\nfor ((i=${v:-${w:-)}};0;)); do :; done\necho after\n",
		"v=0\n(((( for ((i=${v:-)};0;)) << 2 )) ))\necho after\n",
		"v=0; w=0\n(( for ((i=${v-$(( ${w:-)} ))};0;)) << 2 ))\necho after\n",
		"unset v\nfor ((i=${v:-(}${v:-(};0;)))); do :; done\necho after\n",
	] {
		let out = run(script).await;
		assert_eq!(out.stdout, "", "{script:?} ran; stderr: {}", out.stderr);
		assert_eq!(out.exit_code, Some(2), "{script:?}; stderr: {}", out.stderr);
	}
}

/// Only the header of an arithmetic `for` loop is read with the rules of
/// arithmetic text. Any other `((` may group conditions inside `[[ ... ]]`, so
/// its words keep extended globs and are not balanced against it, wherever the
/// conditional stands (a function body, after a regular expression, inside a
/// command substitution or a here-document), and no `[[` changes how a later
/// line is read.
#[tokio::test]
async fn conditional_groups_are_not_arithmetic_text() {
	let out = run(concat!(
		"v=1\n",
		"[[ (( ${v:-(} )) ]]\n",
		"echo \"rc=$?\"\n",
		"[[ (( a == @(a) )) &&\n",
		"(( b == b )) ]]\n",
		"echo \"rc=$?\"\n",
		"[[ \"a|b\" =~ (a|b) && (( b == @(b) )) ]]\n",
		"echo \"rc=$?\"\n",
		"function f { [[ (( a == @(a) )) ]]; }\n",
		"f\n",
		"echo \"rc=$?\"\n",
		"echo \"$( [[ (( ${v:-(} )) ]] && echo sub )\"\n",
		"cat <<EOF\n",
		"$( [[ (( ${v:-(} )) ]] && printf doc )\n",
		"EOF\n",
		"echo [[ ; for ((;;)); do echo in; break; done\n",
		"echo time [[\n",
		"case x in x|[[)\n",
		"(( x=2 << 1 ))\n",
		";;\n",
		"esac\n",
		"echo \"x=$x\"\n",
	))
	.await;
	assert_eq!(out.stderr, "");
	assert_eq!(out.stdout, "rc=0\nrc=0\nrc=0\nrc=0\nsub\ndoc\n[[\nin\ntime [[\nx=4\n");
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
