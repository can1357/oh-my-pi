//! Attribution boundaries: builtin exit provenance (explicit/fatal, POSIX/
//! ordinary/`command`, root/child); script input (source/alias, commands/
//! comments/blanks/continuations); RETURN unwind (function/source, eval,
//! saved success/failure, unreachable suffix, caller &&/||/unconditional);
//! parked expansion (no-fork/value/fork, simple/compound/header operations).

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
async fn exit_classification_review_builtin_fatal_provenance() {
	let _guard = shell_test_lock().lock().await;
	for (prefix, builtin, status) in [
		("set -o posix; ", "export -Z", 2),
		("set -o posix; ", "readonly -Z", 2),
		("set -o posix; ", "return 1", 2),
		("set -o posix; ", "exit nope", 2),
		("", "break nope", 2),
		("", "continue nope", 2),
		("emulate zsh; setopt posixbuiltins; ", ". /no/such/exit-review", 1),
		("emulate zsh; TERM=omp-unknown; zmodload zsh/curses; ", "zcurses init", 1),
	] {
		let command = format!("set +e; {prefix}{builtin}; printf never");
		let (result, output) = run_case(&command).await;
		assert_eq!(result.exit_code, Some(status), "{command}");
		assert!(!output.contains("never"), "fatal builtin must stop: {command}");
		assert!(!result.ended_by_exit, "fatal builtin is not exit/errexit: {command}");

		// A child fatal cannot own the root's later explicit-exit report.
		let command = format!("set +e; ({prefix}{builtin}); exit 0; printf never");
		let (result, _) = run_case(&command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert!(result.ended_by_exit, "child attribution leaked: {command}");
	}
	for command in [
		"set +e; export -Z; exit 0; printf never",
		"set +e; readonly -Z; exit 0; printf never",
		"set +e; return 1; exit 0; printf never",
		"set +e; exit nope; exit 0; printf never",
		"set +e; set -o posix; command export -Z; exit 0; printf never",
		"set +e; set -o posix; exit 0; printf never",
	] {
		let (result, _) = run_case(command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert!(result.ended_by_exit, "explicit exit must remain attributed: {command}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_review_source_and_alias_tails() {
	let _guard = shell_test_lock().lock().await;
	for (tail, expected) in [
		("", false),
		(" \t\n# comment", false),
		("\\\n", false),
		("\\\n# comment\n \t", false),
		("printf never", true),
		("# comment\nprintf never", true),
		("\\\nprintf never", true),
		("'#literal'", true),
		("\\#literal", true),
		("\x0b", true),
		("\x0c", true),
		("\r", true),
	] {
		for alias in [false, true] {
			let command = if alias {
				// Double quotes preserve these alias bytes (including a quoted
				// '#').
				let value = format!("exit 0\n{tail}").replace('\\', "\\\\");
				format!("shopt -s expand_aliases\nalias x=\"{value}\"\nx")
			} else {
				format!("exit 0\n{tail}")
			};
			let (result, output) = run_case(&command).await;
			assert_eq!(result.exit_code, Some(0), "{command:?}");
			assert!(output.is_empty(), "unrun suffix produced output: {command:?}");
			assert_eq!(result.ended_by_exit, expected, "{command:?}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_review_return_trap_unwinds_abandoned_frames() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("source directory");
	let path = root.path().join("return.sh");
	for status in [0, 1] {
		for eval in [false, true] {
			for layout in ["; ", "\n"] {
				for unreachable in ["", "printf unreachable"] {
					let returning = format!("return {status}{layout}{unreachable}");
					let returning = if eval {
						format!("eval '{returning}'")
					} else {
						returning
					};
					for source in [false, true] {
						let body = format!("trap 'exit 0' RETURN{layout}{returning}\n");
						let prefix = if source {
							std::fs::write(&path, &body).expect("source script");
							format!(". '{}'", path.display())
						} else {
							format!("f() {{ {body}}}; f")
						};
						for (suffix, expected) in [
							("", false),
							(" && printf never", status == 0),
							(" || printf never", status != 0),
							("; printf never", true),
						] {
							let command = format!("{prefix}{suffix}");
							let (result, output) = run_case(&command).await;
							assert_eq!(result.exit_code, Some(0), "{command}");
							assert!(output.is_empty(), "unreachable input ran: {command}: {output}");
							assert_eq!(result.ended_by_exit, expected, "{command}");
						}
					}
				}
			}
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_review_parked_substitution_keeps_parent_work() {
	let _guard = shell_test_lock().lock().await;
	for substitution in ["${ exit 0; }", "${| exit 0; }"] {
		for command in [
			format!("printf '%s' \"{substitution}\""),
			format!("x=\"{substitution}\""),
			format!("printf never >\"{substitution}\""),
			format!("[[ -n \"{substitution}\" ]]"),
			format!("[[ x == x && -n \"{substitution}\" ]]"),
			format!("(( 1 + 0{substitution} ))"),
			format!("case \"{substitution}\" in esac"),
			format!("for x in \"{substitution}\"; do :; done"),
			format!("{{ :; }} >\"/dev/null{substitution}\""),
			format!("printf '%s %s' \"{substitution}\" \"${{ printf never >&2; }}\""),
			format!("f() {{ printf '%s' \"{substitution}\"; }}; f"),
			format!("printf '%s' \"${{ printf '%s' \"{substitution}\"; }}\""),
		] {
			let (result, output) = run_case(&command).await;
			assert_eq!(result.exit_code, Some(0), "{command}");
			assert!(output.is_empty(), "abandoned expansion produced output: {command}");
			assert!(result.ended_by_exit, "parent command has not executed: {command}");
		}
	}
	for (command, expected_status) in [
		("[[ -n \"SUB\" ]]", 1),
		("[[ x == x && -n \"SUB\" ]]", 1),
		("(( 1 + 0SUB ))", 0),
		("case \"SUB\" in esac", 0),
		("for x in \"SUB\"; do :; done", 0),
		("{ :; } >\"/dev/nullSUB\"", 0),
	] {
		// Returning normally yields an empty expansion, then the owning
		// operation actually completes: these outcomes do not use the walker.
		for substitution in ["${ return 0; }", "${| return 0; }"] {
			let command = command.replace("SUB", substitution);
			let (result, output) = run_case(&command).await;
			assert_eq!(result.exit_code, Some(expected_status), "{command}");
			assert!(output.is_empty(), "{command}");
			assert!(!result.ended_by_exit, "{command}");
		}
	}
	for (command, expected_output) in [
		("printf '%s' \"$(exit 0)\"", ""),
		("printf '%s' \"${ return 0; }\"", ""),
		("printf '%s' \"${| return 0; }\"", ""),
		("printf '%s' \"$(exit 0)\"; printf ran", "ran"),
	] {
		let (result, output) = run_case(command).await;
		assert_eq!(result.exit_code, Some(0), "{command}");
		assert_eq!(output, expected_output, "{command}");
		assert!(!result.ended_by_exit, "non-aborting substitution: {command}");
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_parked_header_does_not_replay_a_completed_body() {
	let _guard = shell_test_lock().lock().await;
	for value in [false, true] {
		let opener = if value { "${|" } else { "${" };
		for second_header in [false, true] {
			for suffix in ["", "; printf tail"] {
				let condition = if second_header { "i == 1" } else { "1" };
				let expansion = format!("{opener} if (({condition})); then exit 0; fi; }}");
				let command =
					format!("for ((i=0; i<2+0{expansion}; i++)); do printf body; done{suffix}");
				let (result, output) = run_case(&command).await;
				assert_eq!(result.exit_code, Some(0), "{command}");
				assert_eq!(output, if second_header { "body" } else { "" }, "{command}");
				assert_eq!(result.ended_by_exit, !second_header || !suffix.is_empty(), "{command}");
			}
		}
	}
}
