//! Shell source nested past the parser's limit is refused with an error that
//! names the construct and the limit. Before the limit, each of these scripts
//! overflowed the stack and killed the whole process with no message. Execution
//! nests across parses (functions, `eval`, sourced files, arithmetic variables)
//! without such a limit, on stack that grows as it needs to, up to a bound past
//! which a runaway recursion is refused.
#![cfg(unix)]

use std::io::{Read, Seek};

use brush_core::{
	ProfileLoadBehavior, RcLoadBehavior, SourceInfo,
	openfiles::{OpenFile, OpenFiles},
};
use brush_parser::MAX_NESTING_DEPTH;
use pi_builtins::{BuiltinSet, default_builtins};
use pi_shell::{
	Shell, ShellRunOptions,
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

/// Deep enough that every construct below overflowed a 2 MiB thread without
/// the limit, in debug and optimized builds.
const DEEP: usize = 10_000;

/// The stack of the Tokio workers the addon runs `Shell.run` on. Neither napi's
/// runtime (`create_runtime` in `crates/vendor/napi/src/tokio_runtime.rs`) nor
/// the one `pi-natives` builds sets `thread_stack_size`, so they get Tokio's
/// default, 2 MiB.
const ADDON_WORKER_STACK: usize = 2 * 1024 * 1024;

/// Runs `work` on a worker of a runtime built like the addon's, so a script
/// gets the stack it gets in the bash tool rather than the test thread's.
async fn on_addon_worker<T: Send + 'static>(work: impl Future<Output = T> + Send + 'static) -> T {
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.thread_stack_size(ADDON_WORKER_STACK)
		.enable_all()
		.build()
		.expect("worker runtime");
	let result = runtime.spawn(work).await.expect("script run on a worker");
	runtime.shutdown_background();
	result
}

async fn run(command: String) -> (Option<i32>, String) {
	on_addon_worker(async move {
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
	})
	.await
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
/// `echo alive` on the same shell, on an addon-sized worker. Returns the first
/// run's status and output, and the second run's output.
async fn run_then_probe(script: String) -> (Option<i32>, String, String) {
	on_addon_worker(async move {
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
	})
	.await
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
// for the body of a command substitution, for the expansions in a
// here-document, for a completion word list, and for a value expanded as a
// prompt. Each of these entry points refuses deep nesting, and the shell runs
// the next command. (A process substitution's body is parsed with the command
// around it, which `process_substitutions` covers.)
refused! {
	assert_shell_run_refuses;
	shell_run_program: deep_braces() => "{", 2;
	eval_argument: format!("eval '{}'", deep_braces()) => "{", 2;
	command_substitution_body: format!("x=$({})", deep_braces()) => "{", 2;
	here_document_command_substitution: format!("cat <<EOF\n$({})\nEOF", deep_braces()) => "{", 1;
	here_document_parameter_expansion: format!("cat <<EOF\n{}\nEOF", nest("${x:-", "bottom", "}", DEEP)) => "${", 1;
	here_document_arithmetic_expansion: format!("cat <<EOF\n{}\nEOF", nest("$(( ", "1", " ))", DEEP)) => "$((", 1;
	here_document_legacy_arithmetic_expansion: format!("cat <<EOF\n{}\nEOF", nest("$[ ", "1", " ]", DEEP)) => "$[", 1;
	completion_word_list: format!("compgen -W '{}'", nest("$(( ", "1", " ))", DEEP)) => "$((", 1;
	prompt_expansion: format!("x='{}'\necho \"${{x@P}}\"", nest("$(( ", "1", " ))", DEEP)) => "$((", 1;
}

#[tokio::test]
async fn sourced_file() {
	let dir = tempfile::tempdir().expect("temp dir");
	let script = dir.path().join("deep.sh");
	std::fs::write(&script, deep_braces()).expect("write script");
	assert_shell_run_refuses(format!("source '{}'", script.display()), "{", 2).await;
}

/// A `set -x` trace prefix (`PS4`) that is refused is reported, and the traced
/// command still runs with the prefix's text as it is, as in Bash.
#[tokio::test]
async fn trace_prefix() {
	let script = format!("PS4='{}'\nset -x\n:\nset +x", nest("$(( ", "1", " ))", DEEP));
	assert_shell_run_refuses(script, "$((", 0).await;
}

/// The limit is a depth, not a crash: the deepest nesting it allows still
/// parses and runs.
#[tokio::test]
async fn brace_groups_at_the_limit_run() {
	let script = |depth| nest("{ ", "echo bottom; ", "} ", depth);
	let (code, output) = run(script(MAX_NESTING_DEPTH)).await;
	assert_eq!((code, output.as_str()), (Some(0), "bottom\n"));
	assert_refused(script(MAX_NESTING_DEPTH + 1), "{", 2).await;
}

/// A here-document's command substitutions count against the limit as they do
/// anywhere else: the outermost one is a level too.
#[tokio::test]
async fn here_document_command_substitutions_count_like_a_command() {
	let script = |depth| format!("cat <<EOF\n{}\nEOF", nest("$(echo ", "x", ")", depth));
	let (code, output) = run(script(MAX_NESTING_DEPTH)).await;
	assert_eq!((code, output.as_str()), (Some(0), "x\n"));
	assert_refused(script(MAX_NESTING_DEPTH + 1), "$(", 1).await;
	assert_refused(format!("echo {}", nest("$(echo ", "x", ")", MAX_NESTING_DEPTH + 1)), "$(", 2)
		.await;
}

/// The lines of `output` that are not error messages.
fn non_error_lines(output: &str) -> Vec<&str> {
	output
		.lines()
		.filter(|line| !line.starts_with("error: "))
		.collect()
}

/// As in Bash, a `$(...)` body that does not parse never runs, nor does the
/// command around it: in a here-document the expansion fails (status 1), and
/// in a command's own words it is a syntax error (status 2). A backquoted body
/// is parsed by the subshell that runs it, so the substitution expands to
/// nothing and the command runs.
#[tokio::test]
async fn command_substitution_syntax_errors() {
	let (code, output) = run("cat <<EOF\n$(if then)\nEOF\necho \"rc=$?\"".to_owned()).await;
	assert!(output.contains("command substitution: syntax error"), "output: {output}");
	assert_eq!((code, non_error_lines(&output)), (Some(0), vec!["rc=1"]));
	let (code, output) = run("echo \"[$(if then)]\"\necho \"rc=$?\"".to_owned()).await;
	assert!(output.contains("command substitution: syntax error"), "output: {output}");
	assert_eq!((code, non_error_lines(&output)), (Some(0), vec!["rc=2"]));
	let (code, output) = run("echo \"[`if then`]\"\necho \"rc=$?\"".to_owned()).await;
	assert!(output.contains("syntax error"), "output: {output}");
	assert_eq!((code, non_error_lines(&output)), (Some(0), vec!["[]", "rc=0"]));
}

/// `layers` nested programs, each `per_layer` loops deep around an `eval` of
/// the next one; the innermost prints `bottom`. Every program parses within
/// the limit, and execution nests through all of them.
fn eval_layers(layers: usize, per_layer: usize) -> String {
	let mut script = "s0='echo bottom'\n".to_owned();
	for layer in 1..=layers {
		let body =
			nest("for _ in 1; do ", &format!("eval \"$s{}\"; ", layer - 1), "done; ", per_layer);
		script.push_str(&format!("s{layer}='{body}'\n"));
	}
	script.push_str(&format!("eval \"$s{layers}\""));
	script
}

/// Like [`eval_layers`], with functions that call the next one.
fn function_layers(layers: usize, per_layer: usize) -> String {
	let mut script = "f0() { echo bottom; }\n".to_owned();
	for layer in 1..=layers {
		let body = nest("for _ in 1; do ", &format!("f{}; ", layer - 1), "done; ", per_layer);
		script.push_str(&format!("f{layer}() {{ {body} }}\n"));
	}
	script.push_str(&format!("f{layers}"));
	script
}

/// Checks that `Shell::run` runs `script` to the end, printing `expected`, and
/// that the shell still runs the next command.
async fn assert_shell_run_completes(script: String, expected: &str) {
	let (code, output, probe) = run_then_probe(script).await;
	assert_eq!((code, output.as_str()), (Some(0), expected));
	assert_eq!(probe, "alive\n", "the shell did not run the next command");
}

// The parser's limit holds per parse; execution nests across parses. Four
// layers of 28 loops overflowed the stack before, though each parse was
// within the limit, and so did a chain of arithmetic variables each nested 30
// deep. Bash runs all of these.
#[tokio::test]
async fn execution_nests_across_eval() {
	assert_shell_run_completes(eval_layers(4, 28), "bottom\n").await;
	assert_shell_run_completes(eval_layers(8, 30), "bottom\n").await;
}

#[tokio::test]
async fn execution_nests_across_function_calls() {
	assert_shell_run_completes(function_layers(8, 30), "bottom\n").await;
}

#[tokio::test]
async fn execution_nests_across_sourced_files() {
	let dir = tempfile::tempdir().expect("temp dir");
	let layer = |n: usize| dir.path().join(format!("s{n}.sh"));
	std::fs::write(layer(0), "echo bottom\n").expect("write script");
	for n in 1..=8 {
		let body =
			nest("for _ in 1; do ", &format!("source '{}'; ", layer(n - 1).display()), "done; ", 30);
		std::fs::write(layer(n), body).expect("write script");
	}
	assert_shell_run_completes(format!("source '{}'", layer(8).display()), "bottom\n").await;
}

#[tokio::test]
async fn execution_nests_across_arithmetic_variables() {
	let mut script = "x0=1\n".to_owned();
	for n in 1..=1000 {
		script.push_str(&format!("x{n}='{}x{}'\n", "- ".repeat(30), n - 1));
	}
	script.push_str("echo $((x1000))");
	assert_shell_run_completes(script, "1\n").await;
}

/// Recursion that never ends is refused once nested commands hold all the
/// stack the shell allows them, instead of growing until memory runs out.
async fn assert_runaway_refused(script: &str) {
	let (code, output, probe) = run_then_probe(script.to_owned()).await;
	let shown: String = output.chars().take(400).collect();
	assert!(output.contains("maximum execution nesting exceeded"), "output: {shown}");
	assert_eq!(code, Some(1), "output: {shown}");
	assert_eq!(probe, "alive\n", "the shell did not run the next command");
}

#[tokio::test]
async fn runaway_function_recursion_is_refused() {
	assert_runaway_refused("f() { f; }\nf").await;
}

#[tokio::test]
async fn runaway_eval_recursion_is_refused() {
	assert_runaway_refused("x='eval \"$x\"'\neval \"$x\"").await;
}

/// Interactive completion reports a word list it refuses on standard error, as
/// `compgen` does, instead of offering nothing without a word.
#[tokio::test]
async fn completion_reports_a_refused_word_list() {
	let mut stderr = tempfile::tempfile().expect("captured stderr");
	let mut shell = brush_core::Shell::builder()
		.do_not_inherit_env(true)
		.profile(ProfileLoadBehavior::Skip)
		.rc(RcLoadBehavior::Skip)
		.builtins(default_builtins(BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell");
	shell.replace_open_files(
		[(OpenFiles::STDERR_FD, OpenFile::from(stderr.try_clone().expect("stderr descriptor")))]
			.into_iter(),
	);
	let params = shell.default_exec_params();
	let spec = format!("complete -W '{}' probe", nest("${x:-", "b", "}", DEEP));
	let result = shell
		.run_string(spec, &SourceInfo::from("test"), &params)
		.await
		.expect("complete");
	assert_eq!(u8::from(result.exit_code), 0);

	let completions = shell.complete("probe b", 7).await.expect("completions");
	assert_eq!(completions.candidates, Vec::<String>::new());
	stderr.rewind().expect("rewind stderr");
	let mut reported = String::new();
	stderr.read_to_string(&mut reported).expect("read stderr");
	let expected = format!("`${{': maximum nesting level exceeded ({MAX_NESTING_DEPTH})");
	assert!(reported.contains(&expected), "stderr: {reported}");
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
