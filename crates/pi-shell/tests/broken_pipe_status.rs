//! A write to a pipe with no reader, made by a builtin or by the shell itself,
//! ends the writer the way SIGPIPE ends a Bash process: silently, with status
//! 141. Bash forks every pipeline stage, so a builtin's write kills its stage
//! and nothing after it in that stage runs; a command Bash runs in a child of
//! its own (an external program, or a builtin standing in for one) dies alone.
//!
//! Each case first runs `seq` into the pipe until the reader has exited: `seq`
//! blocks on the full pipe and dies of the broken pipe only once the reader is
//! gone, so the write under test always finds a pipe with no reader.
#![cfg(unix)]

use pi_shell::{
	Shell, ShellRunOptions,
	cancel::CancelToken,
	shell::{ShellExecuteOptions, execute_shell},
};

/// Output of `seq` that overfills a pipe buffer (64 KiB on Linux).
const FILL_PIPE: &str = "seq 1 100000";

async fn run(command: String) -> (Option<i32>, String) {
	let (tx, rx) = flume::unbounded::<String>();
	let result = execute_shell(
		ShellExecuteOptions { command, timeout_ms: Some(60_000), ..Default::default() },
		Some(tx),
		CancelToken::default(),
	)
	.await
	.expect("shell execution");
	(result.exit_code, rx.try_iter().collect())
}

/// The process Bash runs a writer in.
#[derive(Clone, Copy)]
enum Writer {
	/// The stage's own shell: a builtin, or the shell's own diagnostic.
	Shell,
	/// A child of its own: an external program, or a builtin standing in for
	/// one, or the diagnostic Bash prints in the child it forked to launch one.
	Child,
}

/// Measured against Bash 5.2.21 with the same stages run as a script file:
/// the writer, the stream it writes, the process Bash runs it in, and its
/// status when that stream is not the closed pipe.
const WRITERS: &[(&str, &str, Writer, u8)] = &[
	("echo out", "stdout", Writer::Shell, 0),
	("printf out", "stdout", Writer::Shell, 0),
	("type true", "stdout", Writer::Shell, 0),
	("declare -p x", "stdout", Writer::Shell, 0),
	("trap -p", "stdout", Writer::Shell, 0),
	("echo err >&2", "stderr", Writer::Shell, 0),
	("type nosuchcmd", "stderr", Writer::Shell, 1),
	("cd /definitely/not/a/dir", "stderr", Writer::Shell, 1),
	("type -Z", "stderr", Writer::Shell, 2),
	(": < /definitely/not/a/file", "stderr", Writer::Shell, 1),
	("< /definitely/not/a/file :", "stderr", Writer::Shell, 1),
	("set -x; : traced; set +x", "stderr", Writer::Shell, 0),
	("nosuchcmd", "stderr", Writer::Child, 127),
	("cat < /definitely/not/a/file", "stderr", Writer::Child, 1),
	("< /definitely/not/a/file cat", "stderr", Writer::Child, 1),
	("c=cat; < /definitely/not/a/file \"$c\"", "stderr", Writer::Child, 1),
	("sleep bogus", "stderr", Writer::Child, 1),
	("timeout -v 0.1 sleep 0.5", "stderr", Writer::Child, 124),
	("seq 3", "stdout", Writer::Child, 0),
];

/// Every builtin and shell write to a closed pipe reports SIGPIPE's status in
/// `PIPESTATUS` and ends its stage, while a child's ends only that command; no
/// `Broken pipe` diagnostic appears. Regression: the shell's diagnostics kept
/// their error status (1, 2, 127) and every stage ran on after the failed
/// write, as Bash's stages, killed by SIGPIPE, do not.
#[tokio::test(flavor = "multi_thread")]
async fn writes_to_a_closed_pipe_end_the_writer_as_sigpipe_does() {
	let mut command = String::from("x=value; trap ':' USR1\n");
	let mut expected = Vec::new();
	for (index, &(writer, written, process, status)) in WRITERS.iter().enumerate() {
		for stream in ["stdout", "stderr"] {
			let redirect = if stream == "stdout" {
				"2>/dev/null"
			} else {
				"2>&1 >/dev/null"
			};
			for (position, stage_index) in [("first", 0), ("middle", 1)] {
				for pipefail in ["+o", "-o"] {
					let label = format!("w{index}/{stream}/{position}/{pipefail}");
					let stage = format!(
						"{{ {FILL_PIPE}; {{ {writer}; }} {redirect}; echo \"{label}:C$?\" >&2; }}"
					);
					let pipeline = if position == "first" {
						format!("{stage} | true")
					} else {
						format!("true | {stage} | true")
					};
					command.push_str(&format!(
						"set {pipefail} pipefail; {pipeline}; echo \
						 \"{label}=${{PIPESTATUS[{stage_index}]}}\"\n"
					));
					expected.push(match (stream == written, process) {
						(true, Writer::Shell) => (label, 141, None),
						(true, Writer::Child) => (label, 0, Some(141)),
						(false, _) => (label, 0, Some(status)),
					});
				}
			}
		}
	}

	let (exit_code, output) = run(command).await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert!(!output.contains("Broken pipe"), "{output}");
	let lines: Vec<&str> = output.lines().collect();
	for (label, stage_status, writer_status) in expected {
		let case = WRITERS[label[1..label.find('/').unwrap()].parse::<usize>().unwrap()].0;
		assert!(
			lines.contains(&format!("{label}={stage_status}").as_str()),
			"`{case}` ({label}): stage status should be {stage_status}\n{output}"
		);
		let marker = lines
			.iter()
			.find(|line| line.starts_with(&format!("{label}:C")));
		assert_eq!(
			marker.copied(),
			writer_status
				.map(|status| format!("{label}:C{status}"))
				.as_deref(),
			"`{case}` ({label}): the stage should {}\n{output}",
			if writer_status.is_some() {
				"run on after the write"
			} else {
				"end at the write"
			}
		);
	}
}

/// A loop of builtin writes stops at the first write after its reader exits,
/// as Bash's stage dies there. Regression: each `echo` failed with status 141
/// and the loop ran all its iterations (forever, unbounded).
#[tokio::test(flavor = "multi_thread")]
async fn a_loop_of_builtin_writes_stops_when_its_reader_exits() {
	let (exit_code, output) = run(
		"i=0; while [ $i -lt 200000 ]; do echo y; i=$((i+1)); done | head -n 1 > /dev/null; echo \
		 \"loop=${PIPESTATUS[0]}\"; i=0; while [ $i -lt 200000 ]; do type nosuchcmd; i=$((i+1)); \
		 done 2>&1 | head -n 1 > /dev/null; echo \"diagnostics=${PIPESTATUS[0]}\""
			.to_string(),
	)
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "loop=141\ndiagnostics=141\n");
}

/// A stage that a broken pipe kills ends alone even as the last stage of a
/// pipeline: its parent goes on. The inner pipeline's last stage writes its
/// diagnostic through fd 3 to the outer pipe, whose reader has exited.
#[tokio::test(flavor = "multi_thread")]
async fn a_last_stage_killed_by_a_broken_pipe_ends_alone() {
	let (exit_code, output) = run(format!(
		"{{ true | {{ {FILL_PIPE} >&3; cd /definitely/not/a/dir 2>&3; echo after-cd >&2; }}; echo \
		 \"inner=${{PIPESTATUS[*]}}\" >&2; }} 3>&1 | true; echo \"outer=${{PIPESTATUS[*]}}\""
	))
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "inner=0 141\nouter=0 0\n");
}

/// A write of the shell's own to a pipe with no reader ends the whole run with
/// status 141, as it kills a Bash script.
#[tokio::test(flavor = "multi_thread")]
async fn the_main_shell_ends_the_run_at_its_broken_pipe() {
	let (exit_code, output) =
		run(format!("{{ {FILL_PIPE}; echo out; echo after-write >&2; }} > >(true); echo continued"))
			.await;
	assert_eq!((exit_code, output.as_str()), (Some(141), ""), "{output}");
}

/// A shell that a broken pipe killed stays dead: a callback or a trap that
/// would run after the failed write runs nothing, as no command runs in a
/// Bash process after SIGPIPE kills it.
#[tokio::test(flavor = "multi_thread")]
async fn nothing_revives_a_shell_a_broken_pipe_killed() {
	let (exit_code, output) = run(format!(
		"cb() {{ echo \"called$1\" >&2; echo \"cb$1\"; }}\n{{ {FILL_PIPE}; mapfile -t -C cb -c 1 \
		 arr <<< $'a\\nb\\nc'; echo after-mapfile >&2; }} | true; echo \
		 \"mapfile=${{PIPESTATUS[0]}}\"\n{{ trap 'echo err-trap >&2' ERR; {FILL_PIPE} || :; echo \
		 out; false; echo after-echo >&2; }} | true; echo \"trap=${{PIPESTATUS[0]}}\""
	))
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "called0\nmapfile=141\ntrap=141\n");
}

/// A persistent shell whose main shell a broken pipe ended runs the next
/// command normally.
#[tokio::test(flavor = "multi_thread")]
async fn the_next_command_runs_after_the_main_shell_broken_pipe() {
	let shell = Shell::new(None);
	let mut outcomes = Vec::new();
	for command in
		[format!("{{ {FILL_PIPE}; echo out; }} > >(true); echo continued"), "echo next".to_string()]
	{
		let (tx, rx) = flume::unbounded::<String>();
		let result = shell
			.run(ShellRunOptions { command, ..Default::default() }, Some(tx), CancelToken::default())
			.await
			.expect("run");
		outcomes.push((result.exit_code, rx.drain().collect::<String>()));
	}
	assert_eq!(outcomes, [(Some(141), String::new()), (Some(0), "next\n".to_string())]);
}

/// A pipeline's last stage is a subshell: its `exit` ends that stage alone,
/// as in Bash 5.2.21. Regression: it ended the whole run.
#[tokio::test(flavor = "multi_thread")]
async fn a_last_stage_exit_ends_only_its_stage() {
	let (exit_code, output) = run(
		"true | exit 3; echo \"exit=$?\"; true | { exit 4; }; echo \"group=$?\"; f() { exit 5; }; \
		 true | f; echo \"function=$?\""
			.to_string(),
	)
	.await;
	assert_eq!((exit_code, output.as_str()), (Some(0), "exit=3\ngroup=4\nfunction=5\n"));
}

/// Runs the script `lines` in a fresh directory, where `fill` fills fd 3.
async fn run_in_tempdir(lines: &[&str]) -> (Option<i32>, String) {
	let dir = tempfile::tempdir().expect("tempdir");
	let script = lines.join("\n");
	run(format!(
		"cd '{}' || exit 99\nfill() {{ {FILL_PIPE} >&3; }}\n{script}\n",
		dir.path().display()
	))
	.await
}

/// Measured against Bash 5.2.21: whether Bash performs a failed redirection
/// (whose diagnostic goes to a pipe with no reader) in the child it forks for
/// the command, which dies alone, or in the shell, which dies.
const REDIRECTIONS: &[(&str, &str, Writer)] = &[
	("command-cat", "command cat < /nonexistent", Writer::Child),
	("command-p-cat", "command -p cat < /nonexistent", Writer::Child),
	("command-dashdash-cat", "command -- cat < /nonexistent", Writer::Child),
	("command-v-cat", "command -v cat < /nonexistent", Writer::Shell),
	("command-echo", "command echo x < /nonexistent", Writer::Shell),
	("command-func", "f() { :; }; command f < /nonexistent", Writer::Child),
	("command-shadowed", "cat() { :; }; command cat < /nonexistent", Writer::Child),
	("command-command-cat", "command command cat < /nonexistent", Writer::Child),
	("func", "f() { :; }; f < /nonexistent", Writer::Shell),
	("builtin-echo", "builtin echo x < /nonexistent", Writer::Shell),
	("empty-then-cat", "unset e; < /nonexistent $e cat", Writer::Child),
	("empty-redirect-cat", "unset e; $e < /nonexistent cat", Writer::Child),
	("expanded-cat", "c=cat; < /nonexistent \"$c\"", Writer::Child),
	("missing-command", "nosuchcmd < /nonexistent", Writer::Child),
	("empty-expansion", "unset e; < /nonexistent $e", Writer::Child),
	("null-input", "< /nonexistent", Writer::Child),
	("null-assignment-input", "x=2 < /nonexistent", Writer::Child),
	("null-output", "> /nonexistent/x", Writer::Shell),
];

/// A failed redirection whose diagnostic finds a pipe with no reader kills
/// the process Bash performs the redirection in: the child it forks for an
/// external command (or `command cmd`, or a command that names none but reads
/// into descriptor 0), or else the shell. Regression: the diagnostic's write
/// error was dropped, and a re-expansion of the command word classified it.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_redirection_kills_the_process_bash_performs_it_in() {
	let mut script = String::new();
	let mut expected = String::new();
	for &(name, case, writer) in REDIRECTIONS {
		script.push_str(&format!(
			"( fill; {{ {case}; }} 2>&3; echo \"  after=$?\" ) 3> >(true); echo \"{name}=$?\"\n"
		));
		expected.push_str(&match writer {
			Writer::Child => format!("  after=141\n{name}=0\n"),
			Writer::Shell => format!("{name}=141\n"),
		});
	}
	let (exit_code, output) = run_in_tempdir(&[&script]).await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, expected);
}

/// Bash expands every word of a command, assignments included, before it
/// performs any redirection, so a failed redirection still expands each word
/// exactly once, a command that names no command still makes its
/// assignments, and an expansion error comes first. Regression: a word was
/// expanded twice, or not at all, and the expansion error was lost.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_redirection_expands_each_word_once() {
	let (exit_code, output) = run_in_tempdir(&[
		r#": > n; ( $(printf X >> n) < /nonexistent ) 2>/dev/null; echo "suffix=$(wc -c < n)""#,
		r#": > n; ( < /nonexistent $(printf X >> n) ) 2>/dev/null; echo "prefix=$(wc -c < n)""#,
		r#": > n; ( < /nonexistent cat $(printf X >> n) ) 2>/dev/null; echo "argument=$(wc -c < n)""#,
		r#": > n; ( cat < /nonexistent $(printf X >> n) ) 2>/dev/null; echo "after=$(wc -c < n)""#,
		r#": > n; ( x=$(printf X >> n) < /nonexistent cat ) 2>/dev/null; echo "assign=$(wc -c < n)""#,
		r#"x=old; x=new 2>/dev/null < /nonexistent; echo "null-assignment=$x""#,
		r#"( < /nonexistent "${U:?required}"; echo after ) 2>/dev/null; echo "expansion-error=$?""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"suffix=1\n",
			"prefix=1\n",
			"argument=1\n",
			"after=1\n",
			"assign=1\n",
			"null-assignment=new\n",
			"expansion-error=1\n",
		)
	);
}

/// A trace line that kills the shell writing it ends every construct that
/// traces: nothing after the trace runs, and a stage reports 141. Regression:
/// assignments, `case` patterns and `[[ ]]` operands after the trace still
/// ran, and a `[[ ]]` or `(( ))` stage reported its own status.
#[tokio::test(flavor = "multi_thread")]
async fn a_trace_line_that_kills_the_shell_ends_every_construct() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"( fill; { set -x; a=one b=$(> m1); } 2>&3 ) 3> >(true); echo "assignment=$? $(made m1)""#,
		r#"( fill; { set -x; case x in $(> m2; echo x)) : ;; esac; } 2>&3 ) 3> >(true); echo "case=$? $(made m2)""#,
		r#"( fill; { set -x; [[ -n x && -n $(> m3) ]]; } 2>&3 ) 3> >(true); echo "test=$? $(made m3)""#,
		r#"( fill; { set -x; for i in a b; do > m4; done; } 2>&3 ) 3> >(true); echo "for=$? $(made m4)""#,
		r#"( fill; { set -x; (( 1 )); > m5; } 2>&3 ) 3> >(true); echo "arithmetic=$? $(made m5)""#,
		r#"( fill; set -x; true | [[ -n x ]] 2>&3; p="${PIPESTATUS[*]}"; set +x; echo "test-stage=$p" ) 3> >(true) 2>/dev/null"#,
		r#"( fill; set -x; true | (( 1 )) 2>&3; p="${PIPESTATUS[*]}"; set +x; echo "arithmetic-stage=$p" ) 3> >(true) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"assignment=141 no\n",
			"case=141 no\n",
			"test=141 no\n",
			"for=141 no\n",
			"arithmetic=141 no\n",
			"test-stage=0 141\n",
			"arithmetic-stage=0 141\n",
		)
	);
}

/// A trap handler that SIGPIPE kills the shell in ends it there: a DEBUG trap
/// before a command runs no command, an ERR trap leaves no `time` report.
/// Both traps are set in the subshell itself, so they fire there. Regression:
/// the command after the DEBUG trap ran, `time` reported, and a DEBUG or ERR
/// trap a subshell set never fired in it.
#[tokio::test(flavor = "multi_thread")]
async fn a_trap_that_kills_the_shell_ends_it() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( fill; trap 'echo bad >&3' DEBUG; touch m; echo AFTER ) 3> >(true); echo "debug=$? $([ -e m ] && echo yes || echo no)""#,
		r#"( fill; trap 'echo bad >&3' ERR; time false; echo AFTER ) 3> >(true) 2>&1; echo "err=$?""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "debug=141 no\nerr=141\n");
}

/// A utility whose write hits a pipe with no reader is dead, as the program
/// it stands in for would be: it starts no command. Regression: `xargs -t`,
/// `find -exec` and `env -v` ran their command after the failed write.
#[tokio::test(flavor = "multi_thread")]
async fn a_utility_starts_no_command_after_its_write_hits_a_dead_pipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"( fill; xargs -t touch m1 <<< a 2>&3; echo "  after=$?" ) 3> >(true); echo "xargs=$? $(made m1)""#,
		r#"( fill; find . -maxdepth 0 -print -exec touch m2 \; >&3; echo "  after=$?" ) 3> >(true); echo "find=$? $(made m2)""#,
		r#"( fill; env -v touch m3 2>&3; echo "  after=$?" ) 3> >(true); echo "env=$? $(made m3)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"  after=141\n",
			"xargs=0 no\n",
			"  after=141\n",
			"find=0 no\n",
			"  after=141\n",
			"env=0 no\n",
		)
	);
}

/// A shell that ignores SIGPIPE (`trap '' PIPE`, here or inherited) is not
/// killed by a broken pipe, nor are the commands it runs: a write fails with
/// an error and status 1, a diagnostic or trace write fails silently.
/// Regression: every such write killed the shell (or child) with 141.
#[tokio::test(flavor = "multi_thread")]
async fn an_ignored_sigpipe_turns_a_broken_pipe_into_a_write_error() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( trap '' PIPE; fill"#,
		r#"  echo bad >&3; echo "after-echo=$?""#,
		r#"  cd /nonexistent 2>&3; echo "after-cd=$?""#,
		r#"  nosuchcmd 2>&3; echo "after-missing=$?""#,
		r#"  { set -x; : traced; } 2>&3; set +x; echo "after-trace=$?""#,
		r#"  seq 1 3 >&3; echo "after-utility=$?""#,
		r#"  /bin/echo x >&3; echo "after-external=$?""#,
		r#") 3> >(true) 2>/dev/null; echo "ignored=$?""#,
		r#"trap '' PIPE; ( fill; echo bad >&3; echo "after-echo=$?" ) 3> >(true) 2>/dev/null"#,
		r#"echo "inherited=$?"; trap - PIPE"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"after-echo=1\n",
			"after-cd=1\n",
			"after-missing=127\n",
			"after-trace=0\n",
			"after-utility=1\n",
			"after-external=1\n",
			"ignored=0\n",
			"after-echo=1\n",
			"inherited=0\n",
		)
	);

	let (_, output) = run_in_tempdir(&[
		r#"( trap '' PIPE; fill; echo bad >&3 ) 3> >(true) 2>&1 | grep 'echo:.*Broken pipe'"#,
	])
	.await;
	assert!(!output.is_empty(), "the failed write is reported");
}

/// A shell that catches SIGPIPE survives a broken pipe and runs its handler
/// once the command ends; a subshell resets the caught signal to its default
/// action and dies. Regression: the caught signal killed the shell.
#[tokio::test(flavor = "multi_thread")]
async fn a_caught_sigpipe_runs_its_handler_and_a_subshell_resets_it() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( trap 'echo caught' PIPE; fill"#,
		r#"  echo bad >&3; echo "after-echo=$?""#,
		r#"  cd /nonexistent 2>&3; echo "after-cd=$?""#,
		r#") 3> >(true) 2>/dev/null; echo "caught=$?""#,
		r#"trap 'echo caught' PIPE; ( fill; echo bad >&3; echo "after-echo=$?" ) 3> >(true)"#,
		r#"echo "inherited=$?"; trap - PIPE"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"caught\n",
			"after-echo=1\n",
			"caught\n",
			"after-cd=1\n",
			"caught=0\n",
			"inherited=141\n",
		)
	);
}
