//! Final-gate matrix: raw termination status versus a function's outgoing
//! status, conditional-only versus unconditional remaining segments, minimizer
//! on/off; first arithmetic-for header (init/test present/omitted) versus a
//! completed body's loop-back, with/without a caller suffix.

use super::*;

async fn run_case(shell: &Shell, command: &str) -> (ShellRunResult, String) {
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

async fn run_case_env(
	shell: &Shell,
	command: &str,
	env: &[(&str, &str)],
) -> (ShellRunResult, String) {
	let (tx, rx) = flume::unbounded();
	let result = shell
		.run(
			ShellRunOptions {
				command: command.into(),
				env: Some(
					env.iter()
						.map(|(k, v)| (k.to_string(), v.to_string()))
						.collect(),
				),
				..Default::default()
			},
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	(result, rx.try_iter().collect())
}

#[tokio::test]
async fn exit_classification_later_loop_condition_does_not_replay_body() {
	let _guard = shell_test_lock().lock().await;
	for (body, printed, expected) in [
		("while exit 0; do printf body; done", "", true),
		("until exit 1; do printf body; done", "", true),
		("i=0; while ((i++ == 0)) || exit 0; do printf body; done", "body", false),
		("i=0; until ((i++ != 0)) && exit 1; do printf body; done", "body", false),
	] {
		for tail in ["", "; printf tail"] {
			let command = format!("{body}{tail}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(output, printed, "{command}");
			assert_eq!(result.ended_by_exit, expected || !tail.is_empty(), "{command}");
		}
	}
}

#[tokio::test]
async fn exit_classification_err_cleanup_cannot_mask_armed_errexit() {
	let _guard = shell_test_lock().lock().await;
	for (trap, armed, status) in [("export -Z", true, 2), ("export -Z", false, 2), (":", true, 1)] {
		for tail in ["", "; printf never"] {
			let setting = if armed { "-e" } else { "+e" };
			let command = format!("set -o posix; set {setting}; trap '{trap}' ERR; false{tail}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(result.exit_code, Some(status), "{command}");
			assert!(!output.contains("never"), "{command}: {output}");
			assert_eq!(result.ended_by_exit, armed && !tail.is_empty(), "{command}");
		}
	}
}

#[tokio::test]
async fn exit_classification_boundary_cleanup_is_not_ordinary_input() {
	let _guard = shell_test_lock().lock().await;
	for (trap, status) in [("exit 7", 7), ("set -e; false", 1)] {
		for (body, cut_short) in [("printf body", false), ("exit 3; printf unrun", true)] {
			let command = format!("trap 'printf cleanup; {trap}; printf unrun' EXIT; {body}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(result.exit_code, Some(status), "{command}");
			assert_eq!(output, if cut_short { "cleanup" } else { "bodycleanup" }, "{command}");
			assert_eq!(result.ended_by_exit, cut_short, "{command}");
		}
	}
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_segmented_continuation_uses_function_status() {
	let _guard = shell_test_lock().lock().await;
	for minimized in [false, true] {
		let root = tempfile::tempdir().expect("minimizer directory");
		for status in [0, 1] {
			for negated in [false, true] {
				let shell = Shell::new(minimized.then(|| ShellOptions {
					minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
					..Default::default()
				}));
				let prefix = if negated { "! " } else { "" };
				// Establish the outgoing status with a non-aborting subshell,
				// independently of the exit-attribution continuation walker.
				let succeeded = (status == 0) != negated;
				let (control, _) = run_case(&shell, &format!("{prefix}(exit {status})")).await;
				assert_eq!(control.exit_code, Some(i32::from(!succeeded)));
				run_case(&shell, &format!("f() {{ {prefix}exit {status}; }}")).await;
				for (suffix, expected) in [
					("", false),
					(" && printf never", succeeded),
					(" && printf never && printf later", succeeded),
					(" && printf never; printf tail", true),
					("; printf tail", true),
				] {
					let command = format!("f{suffix}");
					let (result, output) = run_case(&shell, &command).await;
					assert_eq!(result.exit_code, Some(status), "{prefix}{command}");
					assert!(output.is_empty(), "aborted suffix ran: {command}");
					assert_eq!(
						result.ended_by_exit, expected,
						"minimized={minimized}, negated={negated}, status={status}: {command}"
					);
				}
			}
		}
	}
}

/// The abort-freeze carries the frame's *own* alias table (not the root's)
/// and its grammar options — both can differ from root state, and the
/// suppression wrapper submitted for a conditional tail must be parsed as
/// `{ … } && :` before it can hide the tail.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_abort_freeze_carries_frame_parse_context() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("minimizer directory");
	for segmented in [false, true] {
		let shell = Shell::new(segmented.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		}));
		// The frame-local alias `zz='# empty'` hides `zz; printf never` in
		// both modes. The setup leaves the *root* alias absent: a probe
		// reading the root table would find the tail owed where the frame's
		// table hides it.
		let setup = "shopt -s expand_aliases; f() { alias zz='# empty'; }; f";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let result = run_case(&shell, "f; zz; printf never").await.0;
		assert_eq!(result.exit_code, Some(0), "abort status travels through the frame");
		assert!(
			!result.ended_by_exit,
			"segmented={segmented}: the frame's alias table hides the tail"
		);
		// The alias table is shell-global state: an alias installed inside a
		// function persists after it returns (bash semantics). What must not
		// happen is the *abort's frozen table* winning over the live one.
		let alias = run_case(&shell, "shopt -s expand_aliases; zz; printf still-here")
			.await
			.0;
		assert_eq!(alias.exit_code, Some(0), "the live alias table survives the abort");
		// Features: `set -o posix` inside the frame forbids the `function f
		// {}` syntax; if the frozen features did not carry that bit, the
		// same probe would parse the tail differently depending on the mode.
		let setup = "f() { set -o posix; }; f";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let result = run_case(&shell, "f; printf never").await.0;
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.ended_by_exit, "frozen features follow the aborted frame");
		// Suppressed conditional tail: `{ echo never; } && :`. Both paths
		// judge the submitted bytes and find no command: a raw `echo never`
		// probe would falsely report cut-short where the submitted wrapper
		// parses to nothing.
		let result = run_case(&shell, "exit 1 && printf never").await.0;
		assert_eq!(result.exit_code, Some(1));
		assert!(
			!result.ended_by_exit,
			"the probe judges the suppressed bytes the run would submit (segmented={segmented})"
		);
	}
}

/// A boundary `EXIT` trap that itself exits runs after the segment's input
/// ended; the engine still treats the exit as ending the logical call, so a
/// runnable `&&` successor is reported instead of silently dropped. The leg
/// decision is taken from the status the segment's input produced, not the
/// trap's status.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_boundary_trap_exit_reports_the_conditional_tail() {
	let _guard = shell_test_lock().lock().await;
	let root = tempfile::tempdir().expect("minimizer directory");
	for segmented in [false, true] {
		let shell = Shell::new(segmented.then(|| ShellOptions {
			minimizer: Some(printf_minimizer(&root.path().join("minimizer.toml"), None)),
			..Default::default()
		}));
		let setup = "f() { trap 'exit 0' EXIT; :; }; g() { trap ':' EXIT; :; }";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let (control, control_out) = run_case(&shell, "g && printf hello").await;
		assert_eq!(control_out, "hello", "segmented={segmented}: control reaches the tail");
		assert_eq!(control.exit_code, Some(0));
		assert!(!control.ended_by_exit, "segmented={segmented}: no abort in the control");
		// The single command runs the tail before the trap fires at its end;
		// the segmented chain stops at the cleanup exit and reports the tail
		// it did not run. Neither is silent.
		let (want_out, want_notice) = if segmented {
			("", true)
		} else {
			("hello", false)
		};
		let (result, output) = run_case(&shell, "f && printf hello").await;
		assert_eq!(output, want_out, "segmented={segmented}: tail execution");
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(
			result.ended_by_exit, want_notice,
			"segmented={segmented}: a skipped conditional tail is never silent"
		);
		// `||` over a succeeding segment: bash runs nothing and nothing was
		// skipped, so no notice.
		let (result, output) = run_case(&shell, "f || printf never").await;
		assert_eq!(output, "", "segmented={segmented}: a succeeding segment skips `||`");
		assert_eq!(result.exit_code, Some(0));
		assert!(!result.ended_by_exit, "segmented={segmented}: no work was skipped");
		// A non-zero cleanup exit still reports the tail its own input status
		// would have run (h succeeds), and keeps the trap's status.
		let setup = "h() { trap 'exit 7' EXIT; :; }";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let (want_out, want_notice) = if segmented {
			("", true)
		} else {
			("hello", false)
		};
		let (result, output) = run_case(&shell, "h && printf hello").await;
		assert_eq!(output, want_out);
		assert_eq!(result.exit_code, Some(7), "segmented={segmented}: the trap's status stands");
		assert_eq!(
			result.ended_by_exit, want_notice,
			"segmented={segmented}: the leg is judged by the input status"
		);
		// No successor at all: the cleanup status ends the run with nothing
		// owed.
		let (result, output) = run_case(&shell, "h").await;
		assert_eq!(output, "");
		assert_eq!(result.exit_code, Some(7));
		assert!(!result.ended_by_exit, "segmented={segmented}: completed input, no notice");
		// A trap that runs while the input still has commands is a real abort
		// and keeps its notice.
		let (result, output) = run_case(&shell, "trap 'exit 7' EXIT; exit 0; printf never").await;
		assert_eq!(output, "", "segmented={segmented}: the abort hides the rest");
		assert!(
			result.ended_by_exit,
			"segmented={segmented}: a mid-input exit is still reported as cutting work short"
		);
		// A trap that rewrites the alias table must not hide the tail from
		// the report: bash parses the successor under the table the input
		// ended with, before the trap ran. (Last: the alias stays installed.)
		let setup =
			"shopt -s expand_aliases; a() { trap 'alias printf=\"# hidden\"; exit 0' EXIT; :; }";
		assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
		let (want_out, want_notice) = if segmented {
			("", true)
		} else {
			("hello", false)
		};
		let (result, output) = run_case(&shell, "a && printf hello").await;
		assert_eq!(output, want_out);
		assert_eq!(result.exit_code, Some(0));
		assert_eq!(
			result.ended_by_exit, want_notice,
			"segmented={segmented}: judged under the input-end alias table"
		);
	}
}

/// The owed-segment probe judges the next physical run's text under the
/// environment that run would install, while the alias table is the live one
/// the next run actually reads. A frozen abort-time table must not override
/// either the locale overlay or the cleanup's alias rewrite.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_owed_segment_probe_uses_next_run_environment() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	// The alias `git` expands to `中` + a backslash-newline join + `x`: under
	// `C` the join makes the second alias hide the command, under Big5 the
	// backslash belongs to a multibyte character and the command survives.
	let setup = "unset LC_ALL LC_CTYPE LANG\nLANG=C\nshopt -s expand_aliases\nalias 中x='# \
	             empty'\nalias git=\"中\\\\\nx\"";
	assert_eq!(run_case(&shell, setup).await.0.exit_code, Some(0), "valid fixture");
	for (body, expected_ended) in [
		("f() { LANG=zh_TW.Big5; exit 0; }; f; git log -1", false),
		("f() { LANG=zh_TW.Big5; return 0; }; f; git log -1", false),
	] {
		let (result, output) = run_case(&shell, body).await;
		assert!(
			!result.ended_by_exit || expected_ended,
			"the next run installs LANG=C; its tail expands away: {body} / {output}"
		);
	}
}

/// A frozen abort-time context keeps the shell's own switches and aliases,
/// but the next run reinstalls the call's environment, so the charset the
/// successor is read under is the one that run installs.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_frozen_probe_reads_next_run_charset() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	// The `git` alias is a Big5 lead byte, a backslash, a newline and `x`.
	// Under Big5 the backslash completes the character and the newline ends
	// a command; under `C` it escapes the newline, the word joins into the
	// `\xA4x` alias, and that expands to a comment: nothing to run.
	let setup = "unset LC_ALL LC_CTYPE\nLANG=C\nshopt -s expand_aliases\nalias $'\\xa4x'='# \
	             hidden'\nalias git=$'\\xa4\\\\\\nx'\nb() { LANG=C; trap ':' EXIT; :; }\na() { \
	             LANG=C; trap 'exit 0' EXIT; :; }\nc() { LANG=C; exit 0; }";
	let big5 = [("LANG", "zh_TW.Big5")];
	let (result, _) = run_case_env(&shell, setup, &big5).await;
	assert_eq!(result.exit_code, Some(0), "valid fixture");
	// Control: no exit, the next run reads its tail under Big5 and finds
	// a command there (one that does not exist).
	let (result, output) = run_case_env(&shell, "b && git log -1", &big5).await;
	assert_ne!(result.exit_code, Some(0), "control ran something: {output}");
	assert!(!result.ended_by_exit, "control: nothing was cut short");
	// A boundary cleanup exit ends the segment under `C`; the successor is
	// judged under the charset the next run installs, so it is reported.
	let (result, output) = run_case_env(&shell, "a && git log -1", &big5).await;
	assert_eq!(output, "");
	assert_eq!(result.exit_code, Some(0));
	assert!(
		result.ended_by_exit,
		"the next run would have read the tail under Big5 and run a command"
	);
	// The same shell state under a `C` call: the tail expands to a comment
	// there, so there is nothing to report.
	let (result, output) = run_case_env(&shell, "a && git log -1", &[]).await;
	assert_eq!(output, "");
	assert!(!result.ended_by_exit, "the next run would have read the tail under C and run nothing");
	// A real abort in the middle of the input reports through the same
	// probe: its unread tail holds a command under Big5 and none under `C`.
	let (result, output) = run_case_env(&shell, "c; git log -1", &big5).await;
	assert_eq!(output, "");
	assert!(result.ended_by_exit, "a mid-input exit is reported under the next run's charset");
	let (result, output) = run_case_env(&shell, "c; git log -1", &[]).await;
	assert_eq!(output, "");
	assert!(!result.ended_by_exit, "under C the unread tail expands away");
}

/// Without an environment overlay the next run inherits the locale the
/// shell carries, but an `exit` freezes its unread input under the locale
/// it ended with: an EXIT cleanup that switches the locale while the
/// caller still has input must not hide that tail.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_exit_cleanup_locale_change_keeps_frozen_charset() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	// The same aliases as above, under a persistent Big5.
	let setup = "unset LC_ALL LC_CTYPE\nLANG=zh_TW.Big5\nshopt -s expand_aliases\nalias \
	             $'\\xa4x'='# hidden'\nalias git=$'\\xa4\\\\\\nx'\nf() { local marker=yes; trap \
	             'if [[ ${marker-} == yes ]]; then LANG=C; fi' EXIT; \"$@\"; }";
	let (result, _) = run_case_env(&shell, setup, &[]).await;
	assert_eq!(result.exit_code, Some(0), "valid fixture");
	// Control: the function returns, the trap runs at the run's boundary
	// without its local, the locale stays Big5 and the next run reads a
	// command in the tail.
	let (result, output) = run_case_env(&shell, "f return 0; git log -1", &[]).await;
	assert_ne!(result.exit_code, Some(0), "control ran something: {output}");
	assert!(!result.ended_by_exit, "control: nothing was cut short");
	// An `exit` inside the function runs the trap while the local is in
	// scope, and the cleanup switches to `C`. The tail was frozen under
	// Big5, where it holds a command, and is reported.
	let (result, output) = run_case_env(&shell, "f exit 0; git log -1", &[]).await;
	assert_eq!(output, "");
	assert_eq!(result.exit_code, Some(0));
	assert!(result.ended_by_exit, "the tail was frozen under Big5 before the cleanup switched to C");
}

/// The environment the next run installs is resolved by the shell, not
/// pasted over frozen values: an `LC_ALL` that names `LANG` follows the
/// `LANG` the next run installs, as it does for the control that runs.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_frozen_probe_resolves_overlaid_locale_like_the_next_run() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	// The same aliases as above, under a persistent Big5, with `LC_ALL`
	// naming `LANG`.
	let setup = "unset LC_ALL LC_CTYPE\nLANG=zh_TW.Big5\nshopt -s expand_aliases\nalias \
	             $'\\xa4x'='# hidden'\nalias git=$'\\xa4\\\\\\nx'\ndeclare -n LC_ALL=LANG\na() { \
	             LANG=; LC_CTYPE=zh_TW.Big5; trap 'exit 0' EXIT; :; }\nb() { LANG=; \
	             LC_CTYPE=zh_TW.Big5; trap ':' EXIT; :; }";
	let (result, _) = run_case_env(&shell, setup, &[]).await;
	assert_eq!(result.exit_code, Some(0), "valid fixture");
	// The next run installs LANG and LC_CTYPE: its LC_ALL names LANG, so
	// the control's tail is read under Big5 and runs a command.
	let env = [("LANG", "zh_TW.Big5"), ("LC_CTYPE", "C")];
	let (result, output) = run_case_env(&shell, "b && git log -1", &env).await;
	assert_ne!(result.exit_code, Some(0), "control ran something: {output}");
	assert!(!result.ended_by_exit, "control: nothing was cut short");
	// The abort froze the tail under Big5, the locale the function set;
	// the next run resolves its LC_ALL through the installed LANG to Big5
	// too, so the tail is reported.
	let (result, output) = run_case_env(&shell, "a && git log -1", &env).await;
	assert_eq!(output, "");
	assert!(result.ended_by_exit, "the next run reads the tail under Big5");
}

/// An environment the next run installs that names no locale variable
/// changes nothing for the tail: the exit's cleanup switched the locale
/// after the freeze, and the tail is still read under the locale the
/// input ended with.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_unrelated_env_keeps_the_frozen_locale() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	// The same aliases as above, under a persistent Big5.
	let setup = "unset LC_ALL LC_CTYPE\nLANG=zh_TW.Big5\nshopt -s expand_aliases\nalias \
	             $'\\xa4x'='# hidden'\nalias git=$'\\xa4\\\\\\nx'\nf() { local marker=yes; trap \
	             'if [[ ${marker-} == yes ]]; then LANG=C; fi' EXIT; \"$@\"; }";
	let (result, _) = run_case_env(&shell, setup, &[]).await;
	assert_eq!(result.exit_code, Some(0), "valid fixture");
	let env = [("OMP_PROBE_UNRELATED", "1")];
	// Control: the function returns, the locale stays Big5 and the next
	// run reads a command in the tail.
	let (result, output) = run_case_env(&shell, "f return 0; git log -1", &env).await;
	assert_ne!(result.exit_code, Some(0), "control ran something: {output}");
	assert!(!result.ended_by_exit, "control: nothing was cut short");
	// An `exit` inside the function runs the trap while the local is in
	// scope, and the cleanup switches to `C`. The environment the next
	// run installs names no locale variable, so the tail is still judged
	// under the Big5 it was frozen with, and reported.
	let (result, output) = run_case_env(&shell, "f exit 0; git log -1", &env).await;
	assert_eq!(output, "");
	assert_eq!(result.exit_code, Some(0));
	assert!(
		result.ended_by_exit,
		"an unrelated environment must not read the locale the cleanup switched to"
	);
}

/// A nameref's target is frozen where the next run reads it. By the time
/// a boundary freeze is taken, the EXIT trap's own scope is pushed, with
/// its `BASH_TRAPSIG` local to it: an `LC_ALL` naming `BASH_TRAPSIG` is
/// frozen with the global binding, not the trap's.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_frozen_locale_skips_the_trap_scope() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	let setup = "unset LC_ALL LC_CTYPE LANG\nBASH_TRAPSIG=zh_TW.Big5\ndeclare -n \\
	             LC_ALL=BASH_TRAPSIG\nshopt -s expand_aliases\nalias $'\\xa4x'='# hidden'\nalias \\
	             git=$'\\xa4\\\\\\nx'\nb() { trap ':' EXIT; :; }\na() { trap 'exit 0' EXIT; :; }";
	let (result, _) = run_case_env(&shell, setup, &[]).await;
	assert_eq!(result.exit_code, Some(0), "valid fixture");
	let env = [("OMP_PROBE_UNRELATED", "1")];
	// Control: the trap unwinds its scope before the successor, which the
	// next run reads under Big5 through the global binding.
	let (result, output) = run_case_env(&shell, "b && git log -1", &env).await;
	assert_ne!(result.exit_code, Some(0), "control ran something: {output}");
	assert!(!result.ended_by_exit, "control: nothing was cut short");
	let (result, output) = run_case_env(&shell, "a && git log -1", &env).await;
	assert_eq!(output, "");
	assert_eq!(result.exit_code, Some(0));
	assert!(
		result.ended_by_exit,
		"the trap's own BASH_TRAPSIG must not stand in for the global one"
	);
	// Without an overlay the frozen charset itself is the global binding's.
	let (result, output) = run_case_env(&shell, "a && git log -1", &[]).await;
	assert_eq!(output, "");
	assert!(result.ended_by_exit, "no overlay: the frozen charset skips the trap scope too");
}

/// The frozen locale follows a nameref chain as far as the shell's own
/// resolver does: a target six names from `LC_ALL` is still the next
/// run's `LC_ALL`.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_frozen_locale_follows_a_long_nameref_chain() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	let setup = "unset LC_ALL LC_CTYPE LANG\ndeclare -n LC_ALL=N1\ndeclare -n N1=N2\ndeclare -n \\
	             N2=N3\ndeclare -n N3=N4\ndeclare -n N4=N5\ndeclare -n \
	             N5=N6\nN6=zh_TW.Big5\nLANG=C\nshopt \\
	             -s expand_aliases\nalias $'\\xa4x'='# hidden'\nalias git=$'\\xa4\\\\\\nx'\nf() { \\
	             local marker=yes; trap 'if [[ ${marker-} == yes ]]; then N6=C; fi' EXIT; \"$@\"; }";
	let (result, _) = run_case_env(&shell, setup, &[]).await;
	assert_eq!(result.exit_code, Some(0), "valid fixture");
	let env = [("OMP_PROBE_UNRELATED", "1")];
	let (result, output) = run_case_env(&shell, "f return 0; git log -1", &env).await;
	assert_ne!(result.exit_code, Some(0), "control ran something: {output}");
	assert!(!result.ended_by_exit, "control: nothing was cut short");
	let (result, output) = run_case_env(&shell, "f exit 0; git log -1", &env).await;
	assert_eq!(output, "");
	assert_eq!(result.exit_code, Some(0));
	assert!(result.ended_by_exit, "the chain's last name is the next run's LC_ALL");
}

/// Each nameref chain is followed on the shell resolver's own budget,
/// per variable: a chain that outruns that depth from `LC_ALL` is still
/// reached through `LC_CTYPE`, and its end freezes too.
#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_frozen_locale_follows_each_chain_on_its_own() {
	let _guard = shell_test_lock().lock().await;
	let shell = Shell::new(Some(ShellOptions {
		minimizer: Some(printf_minimizer(
			&tempfile::tempdir()
				.expect("minimizer directory")
				.path()
				.join("minimizer.toml"),
			None,
		)),
		..Default::default()
	}));
	// `LC_ALL` names 63 namerefs to `TARGET`, one hop past the resolver's
	// depth; `LC_CTYPE` names the chain's last link, through which the
	// resolver reaches `TARGET`.
	use std::fmt::Write as _;
	let mut setup = String::from("unset LC_ALL LC_CTYPE LANG\ndeclare -n LC_ALL=N1\n");
	for i in 1..63 {
		let _ = writeln!(setup, "declare -n N{i}=N{}", i + 1);
	}
	setup.push_str(
		"declare -n N63=TARGET\ndeclare -n LC_CTYPE=N63\nTARGET=zh_TW.Big5\nLANG=C\nshopt -s \\
		 expand_aliases\nalias $'\\xa4x'='# hidden'\nalias git=$'\\xa4\\\\\\nx'\nf() { local \\
		 marker=yes; trap 'if [[ ${marker-} == yes ]]; then TARGET=C; fi' EXIT; \"$@\"; }",
	);
	let (result, _) = run_case_env(&shell, &setup, &[]).await;
	assert_eq!(result.exit_code, Some(0), "valid fixture");
	let env = [("OMP_PROBE_UNRELATED", "1")];
	let (result, output) = run_case_env(&shell, "f return 0; git log -1", &env).await;
	assert_ne!(result.exit_code, Some(0), "control ran something: {output}");
	assert!(!result.ended_by_exit, "control: nothing was cut short");
	let (result, output) = run_case_env(&shell, "f exit 0; git log -1", &env).await;
	assert_eq!(output, "");
	assert_eq!(result.exit_code, Some(0));
	assert!(result.ended_by_exit, "the chain's end is reached through LC_CTYPE and must freeze");
}

#[tokio::test(flavor = "multi_thread")]
async fn exit_classification_initial_arithmetic_header_keeps_unentered_body() {
	let _guard = shell_test_lock().lock().await;
	for header in ["i=0;i<1;i++", ";i<1;i++", "i=0;;i++", ";;"] {
		for suffix in ["", "; printf tail"] {
			let shell = Shell::new(None);
			// Without an exit, this first header reaches the body. A break
			// keeps omitted conditions finite without predicting termination.
			let (_, output) = run_case(
				&shell,
				&format!("i=0; trap ':' DEBUG; for (({header})); do printf body; break; done"),
			)
			.await;
			assert_eq!(output, "body", "header={header}");
			let command = format!(
				"i=0; trap 'exit 0' DEBUG; for (({header})); do printf body; break; done{suffix}"
			);
			let (result, output) = run_case(&shell, &command).await;
			assert_eq!(result.exit_code, Some(0), "{command}");
			assert!(output.is_empty(), "body ran after DEBUG exit: {command}");
			assert!(result.ended_by_exit, "first body was left unrun: {command}");

			// Once the body has reached its final exit, the iteration edge
			// must not count that same body again as new input.
			let command = format!("trap - DEBUG; i=0; for (({header})); do exit 0; done{suffix}");
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert!(output.is_empty(), "{command}");
			assert_eq!(result.ended_by_exit, !suffix.is_empty(), "{command}");
		}
	}
	// A DEBUG exit during a later header must not replay the body that
	// already ran; only a submitted suffix outside that loop is new input.
	for header in ["i=0;i<2;i++", ";i<2;i++"] {
		for suffix in ["", "; printf tail"] {
			let command = format!(
				"i=0; trap 'if ((i==1)); then exit 0; fi' DEBUG; for (({header})); do printf body; \
				 done{suffix}"
			);
			let (result, output) = run_case(&Shell::new(None), &command).await;
			assert_eq!(output, "body", "{command}");
			assert_eq!(result.ended_by_exit, !suffix.is_empty(), "{command}");
		}
	}
}
