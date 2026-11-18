//! Final-gate continuation matrix:
//! - deferred transfer: return, break/continue (one/multiple levels), error;
//! - carrier: function/eval, running/nested always, semicolon/newline input;
//! - suffix: abandoned inside transfer scope, live caller &&/||/unconditional;
//! - options: Bash local -, zsh localoptions/local options/sticky emulation,
//!   on/off, nested function/eval and temporary environments, restored/leaked;
//! - provenance: explicit exit/errexit versus shell-ending return/`ERR_RETURN`,
//!   root/eval carriers, saved success/failure, normal/exiting ERR traps.
//!
//! Non-aborting controls execute the runtime transfer/option restoration,
//! independently of the attribution walker.

use super::*;

async fn run_case(command: &str) -> (ShellRunResult, String) {
	let shell = Shell::new(None);
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions { command: command.into(), ..Default::default() },
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	(result, rx.try_iter().collect())
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_word_loop_header_distinguishes_first_and_later_body() {
	let _guard = shell_test_lock().lock().await;
	for wrapped in [false, true] {
		for iteration in [0, 1] {
			for suffix in ["", "; printf live"] {
				let body = format!(
					"i=0; trap 'if ((i=={iteration})); then exit 0; fi' DEBUG; for x in a b; do printf \
					 body; i=1; done{suffix}"
				);
				let command = if wrapped {
					format!("f() {{ {body}; }}; f")
				} else {
					body
				};
				let (result, output) = run_case(&command).await;
				assert_eq!(result.exit_code, Some(0), "{command}");
				assert_eq!(output, if iteration == 0 { "" } else { "body" }, "{command}");
				assert_eq!(result.ended_by_exit, iteration == 0 || !suffix.is_empty(), "{command}");
			}
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_shell_ending_returns_are_not_explicit_exit() {
	let _guard = shell_test_lock().lock().await;
	for armed in [false, true] {
		let setting = if armed { "-e" } else { "+e" };
		for status in [0, 1] {
			for eval in [false, true] {
				let body = format!("return {status}; printf abandoned");
				let body = if eval { format!("eval '{body}'") } else { body };
				let command = format!("emulate zsh\nset {setting}; {body}; printf live");
				let (result, output) = run_case(&command).await;
				assert_eq!(result.exit_code, Some(status), "{command}");
				assert!(output.is_empty(), "{command}: {output}");
				assert_eq!(result.ended_by_exit, armed && status != 0, "{command}");
			}
		}
		for trap in ["", "trap ':' ZERR;", "trap 'exit 0' ZERR;"] {
			let command =
				format!("emulate zsh\nset {setting}; setopt errreturn; {trap} false; printf live");
			let (result, output) = run_case(&command).await;
			assert!(output.is_empty(), "{command}: {output}");
			assert_eq!(result.ended_by_exit, armed, "{command}");
		}
		let command = format!("emulate zsh\nset {setting}; setopt errreturn; exit 0; printf live");
		let (result, output) = run_case(&command).await;
		assert!(output.is_empty(), "{command}: {output}");
		assert!(result.ended_by_exit, "{command}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_pending_cleanup_transfers_skip_abandoned_input() {
	let _guard = shell_test_lock().lock().await;
	for (body, succeeded) in [
		("{ return 0; } always { INTERRUPT; }; printf abandoned", true),
		("{ return 1; } always { INTERRUPT; }; printf abandoned", false),
		("eval '{ return 0; } always { INTERRUPT; }; printf abandoned'; printf abandoned", true),
		(
			"{ { return 1; } always { INTERRUPT; }; printf abandoned; } always { :; }; printf \
			 abandoned",
			false,
		),
		("for x in a; do { break; } always { INTERRUPT; }; printf abandoned; done", true),
		("for x in a; do { continue; } always { INTERRUPT; }; printf abandoned; done", true),
		(
			"g() { { break; } always { INTERRUPT; }; printf abandoned; }; for x in a; do g; printf \
			 abandoned; done",
			true,
		),
		(
			"g() { { continue; } always { INTERRUPT; }; printf abandoned; }; for x in a; do g; \
			 printf abandoned; done",
			true,
		),
		(
			"for x in a; do for y in b; do { break 2; } always { INTERRUPT; }; printf abandoned; \
			 done; printf abandoned; done",
			true,
		),
		(
			"for x in a; do for y in b; do { continue 2; } always { INTERRUPT; }; printf abandoned; \
			 done; printf abandoned; done",
			true,
		),
		(
			"eval '{ printf %s /no/such/exit-final-gate/*; } always { INTERRUPT; }; printf abandoned'",
			false,
		),
	] {
		for separator in ["; ", "\n"] {
			let body = body.replace("; ", separator);
			for (suffix, expected) in [
				("", false),
				(" && printf live", succeeded),
				(" || printf live", !succeeded),
				("; printf live", true),
			] {
				let control = format!(
					"emulate zsh\nf() {{ {}; }}; f 2>/dev/null{suffix}",
					body.replace("INTERRUPT", ":")
				);
				let (_, output) = run_case(&control).await;
				assert_eq!(output, if expected { "live" } else { "" }, "{control}");
				let command = format!(
					"emulate zsh\nf() {{ {}; }}; f 2>/dev/null{suffix}",
					body.replace("INTERRUPT", "exit 0")
				);
				let (result, output) = run_case(&command).await;
				assert_eq!(result.exit_code, Some(0), "{command}");
				assert!(output.is_empty(), "{command}: {output}");
				assert_eq!(result.ended_by_exit, expected, "{command}");
			}
		}
	}
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_pipeline_uses_restored_caller_options() {
	let _guard = shell_test_lock().lock().await;
	for (dialect, scope, restored, sticky) in [
		("bash", "local -;", true, false),
		("bash", "", false, false),
		("zsh", "setopt localoptions;", true, false),
		// A hidden module parameter is not LOCAL_OPTIONS: localizing it
		// must not make unrelated option changes appear scoped.
		("zsh", "zmodload zsh/parameter; local options;", false, false),
		("zsh", "emulate -L zsh;", true, false),
		("zsh", "", true, true),
		("zsh", "", false, false),
	] {
		for outer in [false, true] {
			for nested in [false, true] {
				let setting = if outer { "-o" } else { "+o" };
				let changed = if outer { "+o" } else { "-o" };
				let body = format!("{scope} set {changed} pipefail; sleep 0.05; INTERRUPT");
				let definitions = if nested {
					format!("g() {{ {body}; }}; f() {{ eval 'PI_GATE=1 g'; }}")
				} else {
					format!("f() {{ {body}; }}")
				};
				let definitions = if sticky {
					format!("emulate zsh -c {}", quote_arg(&definitions))
				} else {
					definitions
				};
				for op in ["&&", "||"] {
					let expected = (if restored { outer } else { !outer }) == (op == "||");
					let lastpipe = if dialect == "bash" {
						"shopt -s lastpipe;"
					} else {
						""
					};
					let template = format!(
						"emulate {dialect}\nset {setting} pipefail; {lastpipe} {definitions}; false | f \
						 {op} printf live"
					);
					let control = template.replace("INTERRUPT", "return 0");
					let (_, output) = run_case(&control).await;
					assert_eq!(output, if expected { "live" } else { "" }, "{control}");
					let command = template.replace("INTERRUPT", "exit 0");
					let (result, output) = run_case(&command).await;
					assert_eq!(result.exit_code, Some(0), "{command}");
					assert!(output.is_empty(), "{command}: {output}");
					assert_eq!(result.ended_by_exit, expected, "{command}");
				}
			}
		}
	}
}
