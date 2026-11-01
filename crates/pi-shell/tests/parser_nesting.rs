//! Shell source nested past the parser's limit is refused with an error that
//! names the construct and the limit. Before the limit, each of these scripts
//! overflowed the stack and killed the whole process with no message.
#![cfg(unix)]

use brush_parser::MAX_NESTING_DEPTH;
use pi_shell::{
	Shell, ShellRunOptions,
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

/// Deep enough that every construct below overflowed a 2 MiB thread without
/// the limit, in debug and optimized builds.
const DEEP: usize = 10_000;

async fn run(command: String) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions { command, timeout_ms: Some(30_000), ..Default::default() },
		Some(tx),
		CancelToken::new(None),
	)
	.await
	.expect("shell execution");
	let output: String = rx.drain().collect();
	(result.exit_code, output)
}

fn nest(open: &str, inner: &str, close: &str, depth: usize) -> String {
	format!("{}{inner}{}", open.repeat(depth), close.repeat(depth))
}

/// Runs `script` and checks that it was refused with `status` and the message
/// naming `construct`.
async fn assert_refused(script: String, construct: &str, status: i32) {
	let (code, output) = run(script).await;
	check_refused(code, &output, construct, status);
}

fn check_refused(code: Option<i32>, output: &str, construct: &str, status: i32) {
	let shown: String = output.chars().take(400).collect();
	let expected = format!("`{construct}': maximum nesting level exceeded ({MAX_NESTING_DEPTH})");
	assert!(output.contains(&expected), "expected {expected:?} in: {shown}");
	assert_eq!(code, Some(status), "output: {shown}");
}

/// Defines one test per row: `check` runs the script and checks that it was
/// refused with the status and the message naming the construct.
macro_rules! refused {
	($check:ident; $($name:ident: $script:expr => $construct:literal, $status:literal;)*) => {
		$(
			#[tokio::test]
			async fn $name() {
				$check($script, $construct, $status).await;
			}
		)*
	};
}

// A program that does not parse is a syntax error: status 2, nothing runs.
refused! {
	assert_refused;
	brace_groups: nest("{ ", "echo bottom; ", "} ", DEEP) => "{", 2;
	subshells: nest("( : ; ", "echo bottom", " )", DEEP) => "(", 2;
	if_bodies: nest("if true; then ", "echo bottom; ", "fi; ", DEEP) => "if", 2;
	while_bodies: format!("{}echo bottom; break; {}done", "while true; do ".repeat(DEEP), "done; break; ".repeat(DEEP - 1)) => "while", 2;
	for_bodies: nest("for _ in 1; do ", "echo bottom; ", "done; ", DEEP) => "do", 2;
	case_items: format!("{}echo bottom;; {}esac", "case x in x) ".repeat(DEEP), "esac;; ".repeat(DEEP - 1)) => "case", 2;
	process_substitutions: format!("cat {}", nest("<(cat ", "/dev/null", ")", DEEP)) => "(", 2;
	command_substitutions: format!("echo {}", nest("$(echo ", "bottom", ")", DEEP)) => "$(", 2;
	parameter_defaults: format!("echo \"{}\"", nest("${x:-", "bottom", "}", DEEP)) => "${", 2;
	arithmetic_commands: format!("(( {} ))", nest("(", "1", ")", DEEP)) => "(", 2;
	conditional_parentheses: format!("[[ {} ]]", nest("( ", "x", " )", DEEP)) => "(", 2;
	conditional_negations: format!("[[ {}x ]]", "! ".repeat(DEEP)) => "!", 2;
	conditional_regex_groups: format!("[[ x =~ {} ]]", nest("(", "x", ")", DEEP)) => "(", 2;
}

// An expansion that does not parse fails its command with status 1, as Bash's
// expansion errors do.
refused! {
	assert_refused;
	arithmetic_parentheses: format!("echo $(( {} ))", nest("(", "1", ")", DEEP)) => "(", 1;
	arithmetic_negations: format!("echo $(( {}1 ))", "- ".repeat(DEEP)) => "-", 1;
	arithmetic_conditionals: format!("echo $(( {} ))", nest("1?", "1", ":0", DEEP)) => "?", 1;
	arithmetic_assignments: format!("echo $(( {}1 ))", "a=".repeat(DEEP)) => "=", 1;
	brace_expansions: format!("echo {}", nest("{a,", "b", "}", DEEP)) => "{", 1;
	extended_globs: format!("shopt -s extglob\ncase x in {}) echo bottom;; esac", nest("@(", "x", ")", DEEP)) => "(", 1;
}

// `test` reports a malformed expression with status 2.
refused! {
	assert_refused;
	test_parentheses: format!("[ {} ]", nest("\\( ", "x", " \\)", DEEP)) => "(", 2;
	test_negations: format!("[ {}x ]", "! ".repeat(DEEP)) => "!", 2;
}

/// Runs `script` through [`Shell::run`], the bash tool's entry point, and then
/// `echo alive` on the same shell. Returns the first run's status and output,
/// and the second run's output.
async fn run_then_probe(script: String) -> (Option<i32>, String, String) {
	let shell = Shell::new(None);
	let mut runs = Vec::new();
	for command in [script, "echo alive".to_owned()] {
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(
				ShellRunOptions { command, ..Default::default() },
				Some(tx),
				CancelToken::new(Some(30_000)),
			)
			.await
			.expect("shell run");
		runs.push((result.exit_code, rx.drain().collect::<String>()));
	}
	let (_, probe) = runs.pop().expect("probe run");
	let (code, output) = runs.pop().expect("first run");
	(code, output, probe)
}

fn deep_braces() -> String {
	nest("{ ", "echo bottom; ", "} ", DEEP)
}

/// Checks that `Shell::run` refused `script` with `status` and the message
/// naming `construct`, and that the shell still runs the next command.
async fn assert_shell_run_refuses(script: String, construct: &str, status: i32) {
	let (code, output, probe) = run_then_probe(script).await;
	check_refused(code, &output, construct, status);
	assert_eq!(probe, "alive\n", "the shell did not run the next command");
}

// Shell source is parsed again while a run executes: by `eval`, by `source`,
// for the body of a command substitution, and for the expansions in a
// here-document. Each of these entry points refuses deep nesting, and the shell
// runs the next command. (A process substitution's body is parsed with the
// command around it, which `process_substitutions` covers.)
refused! {
	assert_shell_run_refuses;
	shell_run_program: deep_braces() => "{", 2;
	eval_argument: format!("eval '{}'", deep_braces()) => "{", 2;
	command_substitution_body: format!("x=$({})", deep_braces()) => "{", 2;
	here_document_command_substitution: format!("cat <<EOF\n$({})\nEOF", deep_braces()) => "{", 0;
	here_document_parameter_expansion: format!("cat <<EOF\n{}\nEOF", nest("${x:-", "bottom", "}", DEEP)) => "${", 1;
}

#[tokio::test]
async fn sourced_file() {
	let dir = tempfile::tempdir().expect("temp dir");
	let script = dir.path().join("deep.sh");
	std::fs::write(&script, deep_braces()).expect("write script");
	assert_shell_run_refuses(format!("source '{}'", script.display()), "{", 2).await;
}

/// The limit is a depth, not a crash: the deepest nesting it allows still
/// parses. (`false &&` keeps the groups from running: running deep nesting is a
/// separate stack cost, which this limit does not bound in unoptimized builds.)
#[tokio::test]
async fn brace_groups_at_the_limit_parse() {
	let script = |depth| format!("false && {}\necho parsed", nest("{ ", ": ; ", "} ", depth));
	let (code, output) = run(script(MAX_NESTING_DEPTH)).await;
	assert_eq!((code, output.as_str()), (Some(0), "parsed\n"));
	assert_refused(script(MAX_NESTING_DEPTH + 1), "{", 2).await;
}

/// Nested arithmetic subscripts parsed in time exponential in their depth: 9
/// levels took two minutes. Bash evaluates this at once.
///
/// The parse is synchronous and cannot be cancelled, so the script runs on its
/// own thread and the test fails when that thread misses the deadline.
#[test]
fn nested_arithmetic_subscripts_parse_in_linear_time() {
	let script = format!("a=(0); echo $(( {} ))", nest("a[", "0", "]", MAX_NESTING_DEPTH));
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.expect("runtime");
		let _ = tx.send(runtime.block_on(run(script)));
	});
	let (code, output) = rx
		.recv_timeout(std::time::Duration::from_secs(20))
		.expect("nested subscripts finish in time");
	assert_eq!((code, output.as_str()), (Some(0), "0\n"));
}
