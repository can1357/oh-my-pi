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
	("command-dash", "command - < /nonexistent", Writer::Shell),
	("command-v-cat", "command -v cat < /nonexistent", Writer::Shell),
	("command-pv-cat", "command -pv cat < /nonexistent", Writer::Shell),
	("command-z-cat", "command -z cat < /nonexistent", Writer::Shell),
	("command-pZ-cat", "command -pZ cat < /nonexistent", Writer::Shell),
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
/// performs any redirection (each redirection's target expanded as it is
/// performed), so a failed redirection still expands each word exactly once,
/// a command that names no command still makes its assignments, and an
/// expansion error comes before every redirection. Regression: a word was
/// expanded twice, or not at all, the expansion error was lost, and
/// redirections before an expansion error were performed.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_redirection_expands_each_word_once() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#": > n; ( $(printf X >> n) < /nonexistent ) 2>/dev/null; echo "suffix=$(wc -c < n)""#,
		r#": > n; ( < /nonexistent $(printf X >> n) ) 2>/dev/null; echo "prefix=$(wc -c < n)""#,
		r#": > n; ( < /nonexistent cat $(printf X >> n) ) 2>/dev/null; echo "argument=$(wc -c < n)""#,
		r#": > n; ( cat < /nonexistent $(printf X >> n) ) 2>/dev/null; echo "after=$(wc -c < n)""#,
		r#": > n; ( x=$(printf X >> n) < /nonexistent cat ) 2>/dev/null; echo "assign=$(wc -c < n)""#,
		r#"x=old; x=new 2>/dev/null < /nonexistent; echo "null-assignment=$x""#,
		r#"( < /nonexistent "${U:?required}"; echo after ) 2>/dev/null; echo "expansion-error=$?""#,
		r#"( > m1 < /nonexistent "${U:?required}" ) 2>/dev/null; echo "redirect-before-error=$? $(made m1)""#,
		r#"( < "$(> m2; echo /nonexistent)" "${U:?required}" ) 2>/dev/null; echo "target-after-words=$? $(made m2)""#,
		r#"( > m3 < "$(> m4; echo /nonexistent)" > "$(> m5; echo m6)" ) 2>/dev/null; echo "in-order=$(made m3) $(made m4) $(made m5) $(made m6)""#,
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
			"redirect-before-error=1 no\n",
			"target-after-words=1 no\n",
			"in-order=yes yes no no\n",
		)
	);
}

/// A trace line that kills the shell writing it ends every construct that
/// traces: nothing after the trace runs, and a stage reports 141. Regression:
/// assignments, `case` patterns, `[[ ]]` operands and an arithmetic `for`'s
/// later clauses after the trace still ran, and a `[[ ]]` or `(( ))` stage
/// reported its own status.
#[tokio::test(flavor = "multi_thread")]
async fn a_trace_line_that_kills_the_shell_ends_every_construct() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"( fill; { set -x; a=one b=$(> m1); } 2>&3 ) 3> >(true); echo "assignment=$? $(made m1)""#,
		r#"( fill; { set -x; case x in $(> m2; echo x)) : ;; esac; } 2>&3 ) 3> >(true); echo "case=$? $(made m2)""#,
		r#"( fill; { set -x; [[ -n x && -n $(> m3) ]]; } 2>&3 ) 3> >(true); echo "test=$? $(made m3)""#,
		r#"( fill; { set -x; for i in a b; do > m4; done; } 2>&3 ) 3> >(true); echo "for=$? $(made m4)""#,
		r#"( fill; { set -x; (( 1 )); > m5; } 2>&3 ) 3> >(true); echo "arithmetic=$? $(made m5)""#,
		r#"( fill; { set -x; for (( i=0; $(> m6; echo 0); )); do :; done; } 2>&3 ) 3> >(true); echo "arithmetic-for=$? $(made m6)""#,
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
			"arithmetic-for=141 no\n",
			"test-stage=0 141\n",
			"arithmetic-stage=0 141\n",
		)
	);
}

/// A trap handler that SIGPIPE kills the shell in ends it there: a DEBUG trap,
/// which Bash runs before it expands the command, leaves the command
/// unexpanded and unrun, and an ERR trap leaves no `time` report. Both traps
/// are set in the subshell itself, so they fire there. Regression: the
/// command after the DEBUG trap ran (or only its expansions and redirections
/// did), `time` reported, and a DEBUG or ERR trap a subshell set never fired
/// in it.
#[tokio::test(flavor = "multi_thread")]
async fn a_trap_that_kills_the_shell_ends_it() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"( fill; trap 'echo bad >&3' DEBUG; touch m1; echo AFTER ) 3> >(true); echo "debug=$? $(made m1)""#,
		r#"( fill; trap 'echo bad >&3' DEBUG; touch "$(> m2; echo m3)" ) 3> >(true); echo "debug-expansion=$? $(made m2) $(made m3)""#,
		r#"( fill; trap 'echo bad >&3' DEBUG; echo bad > m4 ) 3> >(true); echo "debug-redirection=$? $(made m4)""#,
		r#"( fill; trap 'echo bad >&3' ERR; time false; echo AFTER ) 3> >(true) 2>&1; echo "err=$?""#,
		r#"( trap 'echo "debug:$BASH_COMMAND"' DEBUG; x=1; echo "out:$x"; > /dev/null; trap - DEBUG )"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"debug=141 no\n",
			"debug-expansion=141 no no\n",
			"debug-redirection=141 no\n",
			"err=141\n",
			"debug:x=1\n",
			"debug:echo \"out:$x\"\n",
			"out:1\n",
			"debug:> /dev/null\n",
			"debug:trap - DEBUG\n",
		)
	);
}

/// A utility is dead once a write of its hits a pipe with no reader, as the
/// program it stands in for would be: an unbuffered diagnostic kills it on
/// the spot, so it goes on to no further operand, and it starts no command.
/// Regression: `mkdir`, `rm` and `cp` went on to their next operand after
/// their diagnostic hit the dead pipe.
#[tokio::test(flavor = "multi_thread")]
async fn a_utility_dies_at_a_diagnostic_that_hits_a_dead_pipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"> block; ( fill; mkdir block m1 2>&3; echo "  after=$?" ) 3> >(true); echo "mkdir=$? $(made m1)""#,
		r#"> m2; ( fill; rm missing m2 2>&3; echo "  after=$?" ) 3> >(true); echo "rm=$? $(made m2)""#,
		r#"mkdir d1; > s1; ( fill; cp missing s1 d1/ 2>&3; echo "  after=$?" ) 3> >(true); echo "cp=$? $(made d1/s1)""#,
		r#"mkdir d2; > s2; ( fill; cp missing s2 d2/ >&3 2>&3; echo "  after=$?" ) 3> >(true); echo "cp-merged=$? $(made d2/s2)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"  after=141\n",
			"mkdir=0 no\n",
			"  after=141\n",
			"rm=0 yes\n",
			"  after=141\n",
			"cp=0 no\n",
			"  after=141\n",
			"cp-merged=0 no\n",
		)
	);
}

/// A builtin that stands in for a program runs its command as a child of the
/// shell would run: with a caught SIGPIPE reset to its default action. A
/// `timeout -v` note that hits a dead pipe while SIGPIPE is ignored is a
/// failed write: GNU timeout still signals its command and exits 125.
/// Regression: `nohup` and `timeout` ran their command with the caller's
/// handler, and `timeout -v` died with 141 and left its command running.
#[tokio::test(flavor = "multi_thread")]
async fn a_program_builtin_runs_its_command_with_a_childs_disposition() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"( trap '> m1' PIPE; fill; nohup echo out >&3; echo "nohup=$?" ) 3> >(true) 2>/dev/null; echo "nohup-handler=$(made m1)""#,
		r#"( trap '> m2' PIPE; fill; timeout 5 echo out >&3; echo "timeout=$?" ) 3> >(true) 2>/dev/null; echo "timeout-handler=$(made m2)""#,
		r#"( trap '' PIPE; fill; timeout -v 0.1 sh -c 'sleep 1; > m3' 2>&3; echo "timeout-v=$?" ) 3> >(true) 2>/dev/null; echo "timeout-v-command=$(made m3)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"nohup=141\n",
			"nohup-handler=no\n",
			"timeout=141\n",
			"timeout-handler=no\n",
			"timeout-v=125\n",
			"timeout-v-command=no\n",
		)
	);
}

/// A failed redirection of a compound command or `[[ ]]` ends that command
/// with status 1, not the commands around it, and is reported per the SIGPIPE
/// disposition of the shell that reports it. Regression: it ended the
/// enclosing list, and a subshell that ignored or caught SIGPIPE died at its
/// diagnostic per its parent's disposition.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_compound_redirection_ends_only_that_command() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( { :; } < /nonexistent; echo "group=$?" ) 2>/dev/null"#,
		r#"( [[ x ]] < /nonexistent; echo "test=$?" ) 2>/dev/null"#,
		r#"( for i in 1; do :; done < /nonexistent; echo "for=$?" ) 2>/dev/null"#,
		r#"( fill; trap '' PIPE; { :; } < /nonexistent; echo "ignored=$?" ) 3> >(true) 2>&3; echo "ignored-subshell=$?""#,
		r#"( fill; trap 'echo caught' PIPE; { :; } < /nonexistent; echo "caught=$?" ) 3> >(true) 2>&3; echo "caught-subshell=$?""#,
		r#"( fill; { :; } < /nonexistent; echo "default=$?" ) 3> >(true) 2>&3; echo "default-subshell=$?""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"group=1\n",
			"test=1\n",
			"for=1\n",
			"ignored=1\n",
			"ignored-subshell=0\n",
			"caught\n",
			"caught=1\n",
			"caught-subshell=0\n",
			"default-subshell=141\n",
		)
	);
}

/// An error in a failed redirection acts on the process Bash performs the
/// redirection in: a fatal expansion error there ends the shell for a
/// compound command, `[[ ]]`, a function or a command that names none, and
/// only the command for an external one or a `( )` subshell, whose
/// redirections are the child's. A subshell's failed redirection whose
/// diagnostic hits a dead pipe kills only that subshell, per its own
/// disposition. Regression: the fatal error became an ordinary status 1 for
/// compound commands, and a subshell's diagnostic killed (or ran the caught
/// SIGPIPE handler of) its parent.
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_redirection_error_acts_on_the_process_that_performs_it() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( { :; } > "${U:?required}" || echo WRONG; echo AFTER ) 2>/dev/null; echo "compound=$?""#,
		r#"( cat > "${U:?required}" || echo EXTERNAL; echo AFTER ) 2>/dev/null; echo "external=$?""#,
		r#"( [[ x ]] > "${U:?required}" || echo WRONG; echo AFTER ) 2>/dev/null; echo "test=$?""#,
		r#"( for i in 1; do :; done > "${U:?required}" || echo WRONG; echo AFTER ) 2>/dev/null; echo "for=$?""#,
		r#"( ( : ) > "${U:?required}" || echo SUBSHELL; echo AFTER ) 2>/dev/null; echo "subshell=$?""#,
		r#"( f() { :; }; f > "${U:?required}" || echo WRONG; echo AFTER ) 2>/dev/null; echo "function=$?""#,
		r#"( > "${U:?required}" || echo WRONG; echo AFTER ) 2>/dev/null; echo "null=$?""#,
		r#"( fill; ( : ) 2>&3 < /nonexistent; echo "after=$?" ) 3> >(true); echo "outer=$?""#,
		r#"( fill; trap 'echo caught' PIPE; ( : ) 2>&3 < /nonexistent; echo "after=$?" ) 3> >(true); echo "outer-caught=$?""#,
		r#"( fill; trap '' PIPE; ( : ) 2>&3 < /nonexistent; echo "after=$?" ) 3> >(true); echo "outer-ignored=$?""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"compound=1\n",
			"EXTERNAL\n",
			"AFTER\n",
			"external=0\n",
			"test=1\n",
			"for=1\n",
			"SUBSHELL\n",
			"AFTER\n",
			"subshell=0\n",
			"function=1\n",
			"null=1\n",
			"after=141\n",
			"outer=0\n",
			"after=141\n",
			"outer-caught=0\n",
			"after=1\n",
			"outer-ignored=0\n",
		)
	);
}

/// An `exit` or `return` in a trap handler acts where the trap ran: in a
/// caught SIGPIPE's handler after the command whose write raised it (also a
/// `set -x` line or a `time` report, and also when that write was in a DEBUG
/// or ERR handler), and in a DEBUG or ERR handler itself. An ERR trap fires
/// for a command only when it was set as the command started, and a function
/// runs without the ERR and DEBUG traps set outside it. Regression: the
/// handler's `exit` and `return` were dropped, a pending handler was lost or
/// delivered after the next command, and a function's own `return` trap fired
/// again for its call.
#[tokio::test(flavor = "multi_thread")]
async fn a_trap_handler_can_exit_or_return() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"( fill; trap 'exit 7' PIPE; echo bad >&3; echo BAD ) 3> >(true) 2>/dev/null; echo "exit=$?""#,
		r#"( fill; f() { trap 'return 7' PIPE; echo bad >&3; echo BAD; }; f; echo "return=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( trap 'echo caught' PIPE; fill; { echo bad >&3; echo in-group; }; echo after-group ) 3> >(true) 2>/dev/null"#,
		r#"( trap 'exit 3' ERR; false; echo after-err ); echo "err-exit=$?""#,
		r#"( trap 'exit 4' DEBUG; echo after-debug ); echo "debug-exit=$?""#,
		r#"( f() { trap 'return 5' ERR; false; echo after-f; }; f; echo "err-return=$?" ) 2>&1"#,
		r#"( fill; trap 'exit 7' PIPE; trap 'echo dead >&3' DEBUG; touch m1 ) 3> >(true) 2>/dev/null; echo "nested-debug=$? $(made m1)""#,
		r#"( fill; trap 'exit 8' PIPE; trap 'echo dead >&3' ERR; false; touch m2 ) 3> >(true) 2>/dev/null; echo "nested-err=$? $(made m2)""#,
		r#"( fill; f() { trap 'return 9' PIPE; trap 'echo dead >&3' ERR; false; touch m3; }; f; echo "nested-return=$? $(made m3)" ) 3> >(true) 2>/dev/null"#,
		r#"( fill; trap 'set +x; echo CAUGHT; exit 29' PIPE; set -x; mkdir d1; > m4; set +x ) 3> >(true) 2>&3; echo "trace=$? $(made m4)""#,
		r#"( fill; trap 'echo CAUGHT; exit 17' PIPE; time :; > m5 ) 3> >(true) 2>&3; echo "time=$? $(made m5)""#,
		r#"( trap 'echo outer-err' ERR; f() { false; echo BODY; }; f; echo AFTER )"#,
		r#"( f() { trap 'echo inner-err' ERR; }; g() { false; echo in-g; }; f; g; false; echo top )"#,
		r#"( trap 'echo "debug:$BASH_COMMAND"' DEBUG; f() { echo BODY; }; f; trap - DEBUG )"#,
		r#"( f() { trap 'echo e1' ERR; return 3; }; f; echo "s1=$?" ) 2>&1"#,
		r#"( trap 'echo e2' ERR; exit 3 ); echo "s2=$?""#,
		r#"( trap 'echo e3' ERR; f() { return 4; }; f; echo "s3=$?" ) 2>&1"#,
		r#"( trap 'echo e4' ERR; f() { trap 'echo inner' ERR; return 5; }; f; echo "s4=$?" ) 2>&1"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"exit=7\n",
			"return=7\n",
			"caught\n",
			"in-group\n",
			"after-group\n",
			"err-exit=3\n",
			"debug-exit=4\n",
			"err-return=5\n",
			"nested-debug=7 no\n",
			"nested-err=8 no\n",
			"nested-return=9 no\n",
			"CAUGHT\n",
			"trace=29 no\n",
			"CAUGHT\n",
			"time=17 no\n",
			"BODY\n",
			"AFTER\n",
			"in-g\n",
			"inner-err\n",
			"top\n",
			"debug:f\n",
			"BODY\n",
			"debug:trap - DEBUG\n",
			"s1=3\n",
			"s2=3\n",
			"e3\n",
			"s3=4\n",
			"inner\n",
			"s4=5\n",
		)
	);
}

/// A DEBUG trap that exits the shell before a later pipeline command starts
/// ends the shell at once: Bash does not wait for the commands it already
/// started. Regression: the shell waited for the earlier command to end.
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_exit_does_not_wait_for_started_commands() {
	let started = std::time::Instant::now();
	let (exit_code, output) = run_in_tempdir(&[
		r#"( n=0; trap 'n=$((n+1)); if [ "$n" = 2 ]; then exit 31; fi' DEBUG; /bin/sleep 5 2>/dev/null | :; echo WRONG ); echo "status=$?""#,
	])
	.await;
	assert_eq!((exit_code, output.as_str()), (Some(0), "status=31\n"));
	assert!(started.elapsed() < std::time::Duration::from_secs(4), "{:?}", started.elapsed());
}

/// A utility dies at a write to standard output that hits a dead pipe, as a
/// process dies at the flush that raises SIGPIPE, so it goes on to no
/// further operand. Regression: the utility reported 141 at the end but kept
/// removing files or making directories after its output failed.
#[tokio::test(flavor = "multi_thread")]
async fn a_utility_dies_at_an_output_write_that_hits_a_dead_pipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"for i in $(seq 1 600); do > "f$i"; done; > victim"#,
		r#"( fill; rm -v f* victim >&3; echo "rm=$?" ) 3> >(true); echo "victim=$(made victim)""#,
		r#"( fill; mkdir -v $(seq -f 'd%g' 1 600) final >&3; echo "mkdir=$?" ) 3> >(true); echo "final=$(made final)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "rm=141\nvictim=yes\nmkdir=141\nfinal=no\n");
}

/// Bash runs the DEBUG trap of a pipeline's commands in the shell, before it
/// forks each one, with `BASH_COMMAND` naming the command. A trap that
/// SIGPIPE kills the shell in starts no command of the pipeline.
/// Regression: the trap ran in each stage's subshell, where it was taken for
/// an inherited one and skipped.
#[tokio::test(flavor = "multi_thread")]
async fn a_pipelines_debug_trap_runs_in_the_shell() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"( fill; trap 'echo dead >&3' DEBUG; touch m1 | cat ) 3> >(true); echo "first=$? $(made m1)""#,
		r#"( fill; trap 'echo dead >&3' DEBUG; cat < /dev/null | touch m2 ) 3> >(true); echo "second=$? $(made m2)""#,
		r#"( fill; f() { touch m3; }; trap 'echo dead >&3' DEBUG; f | cat ) 3> >(true); echo "function=$? $(made m3)""#,
		r#"( trap 'echo "debug:$BASH_COMMAND"' DEBUG; echo a | tr a b; trap - DEBUG ) 2>&1"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"first=141 no\n",
			"second=141 no\n",
			"function=141 no\n",
			"debug:echo a\n",
			"debug:tr a b\n",
			"b\n",
			"debug:trap - DEBUG\n",
		)
	);
}

/// An async utility (here `find`) dies at a diagnostic that hits a dead pipe,
/// as a process writes its standard error unbuffered: it goes on to no
/// further operand. Regression: the diagnostic stayed buffered, and `find`
/// deleted its next operand before it died.
#[tokio::test(flavor = "multi_thread")]
async fn an_async_utility_dies_at_a_diagnostic_that_hits_a_dead_pipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"> m1; ( fill; find missing m1 -delete 2>&3; echo "find=$?" ) 3> >(true); echo "kept=$(made m1)""#,
		r#"> m2; ( fill; find missing m2 -delete >&3 2>&3; echo "find-merged=$?" ) 3> >(true); echo "kept-merged=$(made m2)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "find=141\nkept=yes\nfind-merged=141\nkept-merged=yes\n");
}

/// With SIGPIPE ignored, a utility's `--help` or `--version` output that
/// hits a dead pipe is a failed write: the utility fails with its error
/// status, as GNU utilities check their output when they exit. Regression:
/// the failed write was dropped and the utility reported success.
#[tokio::test(flavor = "multi_thread")]
async fn an_ignored_sigpipe_fails_a_utilitys_help_output() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( trap '' PIPE; fill"#,
		r#"  nohup --help >&3; echo "nohup=$?""#,
		r#"  nohup --version >&3; echo "nohup-version=$?""#,
		r#"  mkdir --help >&3; echo "mkdir=$?""#,
		r#"  cat --version >&3; echo "cat-version=$?""#,
		r#"  timeout --help >&3; echo "timeout=$?""#,
		r#") 3> >(true) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "nohup=125\nnohup-version=125\nmkdir=1\ncat-version=1\ntimeout=125\n");
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

/// A file a provider backs, here over a real file: a builtin that sees one
/// runs on a blocking worker against a lease of the shell (the same process,
/// not a subshell).
#[derive(Debug)]
struct ProviderFile(pi_vfs::File);

#[async_trait::async_trait]
impl pi_vfs::FileHandle for ProviderFile {
	async fn read(&self, buf: &mut [u8]) -> std::io::Result<usize> {
		self.0.read_async(buf).await
	}

	async fn write(&self, buf: &[u8]) -> std::io::Result<usize> {
		self.0.write_async(buf).await
	}

	async fn seek(&self, pos: std::io::SeekFrom) -> std::io::Result<u64> {
		self.0.seek_async(pos).await
	}

	async fn metadata(&self) -> std::io::Result<pi_vfs::Metadata> {
		self.0.metadata_async().await
	}

	async fn flush(&self) -> std::io::Result<()> {
		self.0.flush_async().await
	}

	async fn set_len(&self, len: u64) -> std::io::Result<()> {
		self.0.set_len_async(len).await
	}
}

/// A builtin that runs against a lease of the shell leaves the shell's caught
/// SIGPIPE caught. Regression: the lease, taken as a subshell copy, reset the
/// caught signal to its default action, so the next broken pipe killed the
/// shell instead of running its handler.
#[tokio::test(flavor = "multi_thread")]
async fn a_builtin_on_a_provider_file_keeps_the_shells_caught_sigpipe() {
	use std::io::{Read, Seek};

	use brush_core::openfiles::{OpenFile, OpenFiles};

	let dir = tempfile::tempdir().expect("tempdir");
	let input = dir.path().join("input");
	std::fs::write(&input, b"x").expect("input");
	let mut output = tempfile::tempfile().expect("output");
	let mut shell = brush_core::Shell::builder()
		.profile(brush_core::ProfileLoadBehavior::Skip)
		.rc(brush_core::RcLoadBehavior::Skip)
		.builtins(pi_builtins::default_builtins(pi_builtins::BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell");
	let mut params = shell.default_exec_params();
	params.set_fd(OpenFiles::STDOUT_FD, OpenFile::from(output.try_clone().expect("stdout")));
	params.set_fd(OpenFiles::STDERR_FD, OpenFile::from(tempfile::tempfile().expect("stderr")));
	let source = brush_core::SourceInfo::from("broken-pipe-lease");
	shell
		.run_string("trap 'echo caught' PIPE", &source, &params)
		.await
		.expect("trap");

	let mut on_provider = params.clone();
	let provider_file = pi_vfs::Fs::native().open(&input).await.expect("open");
	on_provider.set_fd(
		OpenFiles::STDIN_FD,
		OpenFile::from(pi_vfs::File::from_handle(ProviderFile(provider_file))),
	);
	shell
		.run_string(":", &source, &on_provider)
		.await
		.expect("lease");

	let result = shell
		.run_string(
			&format!("{{ {FILL_PIPE} >&3; echo bad >&3; echo AFTER; }} 3> >(true)"),
			&source,
			&params,
		)
		.await
		.expect("write");
	output.rewind().expect("rewind");
	let mut written = String::new();
	output.read_to_string(&mut written).expect("read");
	assert_eq!((u8::from(result.exit_code), written.as_str()), (0, "caught\nAFTER\n"));
}

/// A provider-backed file over a pipe whose reader has gone.
fn dead_provider_pipe() -> pi_vfs::File {
	let (reader, writer) = std::io::pipe().expect("pipe");
	drop(reader);
	let pipe = pi_vfs::File::from(std::fs::File::from(std::os::fd::OwnedFd::from(writer)));
	pi_vfs::File::from_handle(ProviderFile(pipe))
}

/// Runs `script` in a fresh directory with standard error the
/// provider-backed `stderr`; returns the status and the directory.
async fn run_on_provider_stderr(script: &str, stderr: pi_vfs::File) -> (u8, tempfile::TempDir) {
	use brush_core::openfiles::OpenFile;

	let stdout = OpenFile::from(tempfile::tempfile().expect("stdout"));
	run_on_provider_streams(script, stdout, OpenFile::from(stderr)).await
}

/// Runs `script` in a fresh directory with standard output `stdout` and
/// standard error `stderr`; returns the status and the directory.
async fn run_on_provider_streams(
	script: &str,
	stdout: brush_core::openfiles::OpenFile,
	stderr: brush_core::openfiles::OpenFile,
) -> (u8, tempfile::TempDir) {
	use brush_core::openfiles::OpenFiles;

	run_on_provider_fds(script, vec![(OpenFiles::STDOUT_FD, stdout), (OpenFiles::STDERR_FD, stderr)])
		.await
}

/// Runs `script` in a fresh directory with the descriptors `fds` set;
/// returns the status and the directory.
async fn run_on_provider_fds(
	script: &str,
	fds: Vec<(brush_core::ShellFd, brush_core::openfiles::OpenFile)>,
) -> (u8, tempfile::TempDir) {
	let dir = tempfile::tempdir().expect("tempdir");
	let mut shell = brush_core::Shell::builder()
		.profile(brush_core::ProfileLoadBehavior::Skip)
		.rc(brush_core::RcLoadBehavior::Skip)
		.builtins(pi_builtins::default_builtins(pi_builtins::BuiltinSet::BashMode))
		.build()
		.await
		.expect("shell");
	for (name, builtin) in pi_builtins::utility_builtins() {
		shell.register_builtin(name, builtin);
	}
	let mut params = shell.default_exec_params();
	for (fd, file) in fds {
		params.set_fd(fd, file);
	}
	let source = brush_core::SourceInfo::from("broken-pipe-provider");
	let result = shell
		.run_string(format!("cd '{}' && {script}", dir.path().display()), &source, &params)
		.await
		.expect("script");
	(u8::from(result.exit_code), dir)
}

/// Runs `tee /dev/fd/3 copy` with descriptor 3 a provider-backed file over a
/// pipe with no reader; returns the status and the bytes `copy` got.
async fn tee_to_a_provider_pipe() -> (u8, usize) {
	use brush_core::openfiles::{OpenFile, OpenFiles};

	let (code, dir) =
		run_on_provider_fds("printf abc > input && tee /dev/fd/3 copy < input > /dev/null", vec![
			(OpenFiles::STDOUT_FD, OpenFile::from(tempfile::tempfile().expect("stdout"))),
			(OpenFiles::STDERR_FD, OpenFile::from(tempfile::tempfile().expect("stderr"))),
			(3, OpenFile::from(dead_provider_pipe())),
		])
		.await;
	let copy = std::fs::read(dir.path().join("copy")).map_or(0, |bytes| bytes.len());
	(code, copy)
}

/// A file operand that is a provider-backed descriptor over a pipe with no
/// reader raises SIGPIPE as a native one does: `tee` dies before it writes
/// its other files. Measured against Bash 5.2.21 on a plain pipe: status
/// 141, `copy` empty. Regression: the mounted descriptor's file took no
/// write hook, and `tee` wrote `copy` and ended with 0.
#[tokio::test(flavor = "multi_thread")]
async fn a_provider_file_operand_with_no_reader_raises_sigpipe() {
	assert_eq!(tee_to_a_provider_pipe().await, (141, 0));
}

/// The same on a current-thread runtime.
#[tokio::test(flavor = "current_thread")]
async fn a_provider_file_operand_with_no_reader_raises_sigpipe_on_a_current_thread_runtime() {
	assert_eq!(tee_to_a_provider_pipe().await, (141, 0));
}

/// An async utility that starts a command with a provider-backed standard
/// output that works, on a current-thread runtime, runs it and goes on:
/// `find victim -exec true \; -delete` deletes `victim`. Regression: the
/// command's launch flushed the provider synchronously, which panics on a
/// current-thread runtime, and `find` failed with an internal error.
#[tokio::test(flavor = "current_thread")]
async fn an_async_utility_starts_a_command_with_a_provider_stdout_on_a_current_thread_runtime() {
	use brush_core::openfiles::OpenFile;

	let log = tempfile::NamedTempFile::new().expect("log");
	let file = std::fs::OpenOptions::new()
		.write(true)
		.open(log.path())
		.expect("open log");
	let stdout = OpenFile::from(pi_vfs::File::from_handle(ProviderFile(pi_vfs::File::from(file))));
	let stderr = OpenFile::from(tempfile::tempfile().expect("stderr"));
	let (code, dir) =
		run_on_provider_streams(r": > victim && find victim -exec true \; -delete", stdout, stderr)
			.await;
	assert_eq!((code, dir.path().join("victim").exists()), (0, false));
}

/// Runs `find victim -printf 'x\c' -delete` with standard output a
/// provider-backed file over a pipe with no reader; returns the status and
/// whether `victim` survived.
async fn find_flush_on_a_provider_pipe() -> (u8, bool) {
	use brush_core::openfiles::OpenFile;

	let stderr = OpenFile::from(tempfile::tempfile().expect("stderr"));
	let (code, dir) = run_on_provider_streams(
		r": > victim && find victim -printf 'x\c' -delete",
		OpenFile::from(dead_provider_pipe()),
		stderr,
	)
	.await;
	(code, dir.path().join("victim").exists())
}

/// An async utility's explicit flush (`find -printf '\c'`) to a
/// provider-backed standard output over a pipe with no reader kills it
/// there, before its next action, as GNU `find`'s `fflush` does: `-delete`
/// never runs. Measured against Bash 5.2.21 on a plain pipe: status 141,
/// `victim` kept. Regression: the flush was ignored, and `find` deleted it.
#[tokio::test(flavor = "multi_thread")]
async fn an_async_utility_dies_at_a_flush_on_a_provider_pipe() {
	assert_eq!(find_flush_on_a_provider_pipe().await, (141, true));
}

/// The same on a current-thread runtime.
#[tokio::test(flavor = "current_thread")]
async fn an_async_utility_dies_at_a_provider_flush_on_a_current_thread_runtime() {
	assert_eq!(find_flush_on_a_provider_pipe().await, (141, true));
}

/// Runs `find missing victim -delete` with standard error a provider-backed
/// file over a pipe with no reader; returns the status and whether `victim`
/// survived.
async fn find_on_a_provider_pipe() -> (u8, bool) {
	let (code, dir) =
		run_on_provider_stderr(": > victim && find missing victim -delete", dead_provider_pipe())
			.await;
	(code, dir.path().join("victim").exists())
}

/// An async utility whose standard error is a provider-backed file over a
/// pipe with no reader dies at its diagnostic, as with a plain descriptor:
/// `find` goes on to no further operand. Regression: the diagnostic stayed
/// buffered for the provider, and `find` deleted its next operand first.
#[tokio::test(flavor = "multi_thread")]
async fn an_async_utility_dies_at_a_diagnostic_on_a_provider_pipe() {
	assert_eq!(find_on_a_provider_pipe().await, (141, true));
}

/// The same on a current-thread runtime, where the diagnostic cannot be
/// written through the provider's synchronous API: it is delivered before the
/// utility runs on. Regression: `find` deleted its next operand first.
#[tokio::test(flavor = "current_thread")]
async fn an_async_utility_dies_at_a_provider_diagnostic_on_a_current_thread_runtime() {
	assert_eq!(find_on_a_provider_pipe().await, (141, true));
}

/// Within one entry too: the diagnostic `find` writes for one action is
/// delivered before its next action runs (here `-fprint`, after a failed
/// `-delete`), on a current-thread runtime. Measured against Bash 5.2.21:
/// status 141, `printed` empty. Regression: `find` wrote the entry first.
#[tokio::test(flavor = "current_thread")]
async fn an_async_utility_dies_at_a_provider_diagnostic_within_one_entry() {
	let (code, dir) = run_on_provider_stderr(
		"mkdir block && : > block/x && find block -maxdepth 0 -delete -o -fprint printed",
		dead_provider_pipe(),
	)
	.await;
	let printed = std::fs::read(dir.path().join("printed")).expect("printed");
	assert_eq!((code, printed.as_slice()), (141, b"".as_slice()));
}

/// An async utility (here `grep`) delivers a diagnostic to a provider-backed
/// standard error before it waits for its input, on a current-thread runtime
/// too, as a process writes its standard error unbuffered: the diagnostic is
/// there while `grep` still waits. Regression: it stayed pending until the
/// input ended.
#[tokio::test(flavor = "current_thread")]
async fn an_async_utility_delivers_a_provider_diagnostic_before_it_waits() {
	let log = tempfile::NamedTempFile::new().expect("log");
	let file = std::fs::OpenOptions::new()
		.write(true)
		.open(log.path())
		.expect("open log");
	let stderr = pi_vfs::File::from_handle(ProviderFile(pi_vfs::File::from(file)));
	// `sleep` is a program, which needs a descriptor for its standard error.
	let shell =
		run_on_provider_stderr("/bin/sleep 3 2>/dev/null | grep x /definitely/missing -", stderr);
	let early = async {
		tokio::time::sleep(std::time::Duration::from_secs(1)).await;
		std::fs::read_to_string(log.path()).expect("read log")
	};
	let ((code, _dir), early) = tokio::join!(shell, early);
	assert_eq!(code, 2, "{early}");
	assert!(early.contains("grep: /definitely/missing: No such file or directory"), "{early:?}");
}

/// A pipeline command that started before a later command's DEBUG trap
/// exited the shell runs on: Bash neither waits for it nor stops it.
/// Regression: the shell killed it.
#[tokio::test(flavor = "multi_thread")]
async fn a_debug_trap_exit_leaves_started_commands_running() {
	let dir = tempfile::tempdir().expect("tempdir");
	let marker = dir.path().join("marker");
	let (exit_code, output) = run(format!(
		"( n=0; trap 'n=$((n+1)); if [ \"$n\" = 2 ]; then exit 31; fi' DEBUG; /bin/sh -c 'sleep \
		 0.3; echo done > \"$1\"' sh '{}' >/dev/null 2>&1 | : ); echo \"status=$?\"",
		marker.display()
	))
	.await;
	assert_eq!((exit_code, output.as_str()), (Some(0), "status=31\n"));
	tokio::time::sleep(std::time::Duration::from_secs(2)).await;
	assert!(marker.exists(), "the started command was stopped");
}

/// An ERR trap a subshell inherited but does not run (no `set -E`) is not in
/// force: a handler a function sets later does not fire for that function's
/// own call. Regression: it fired twice.
#[tokio::test(flavor = "multi_thread")]
async fn an_inherited_inactive_err_trap_does_not_count_as_set() {
	let (exit_code, output) = run(
		"trap 'echo OUTER' ERR; ( f() { trap 'echo INNER' ERR; false; }; f; echo SUBEND ); trap - \
		 ERR"
			.to_string(),
	)
	.await;
	assert_eq!((exit_code, output.as_str()), (Some(0), "INNER\nSUBEND\n"));
}

/// With SIGPIPE ignored, a utility whose output hits a pipe with no reader is
/// not killed: it reports the write error and fails with its error status (1,
/// or 2 for `grep`), as GNU utilities do. Regression: they reported 141.
#[tokio::test(flavor = "multi_thread")]
async fn an_ignored_sigpipe_fails_utilities_whose_output_hits_a_dead_pipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( trap '' PIPE; fill"#,
		r#"  printf 'abc\n' | cat >&3; echo "cat=$?""#,
		r#"  printf 'abc\n' | cut -c1 >&3; echo "cut=$?""#,
		r#"  printf 'abc\n' | head -n 1 >&3; echo "head=$?""#,
		r#"  printf 'abc\n' | fold >&3; echo "fold=$?""#,
		r#"  printf 'abc\n' | od -c >&3; echo "od=$?""#,
		r#"  yes >&3; echo "yes=$?""#,
		r#"  printf 'abc\n' | grep . >&3; echo "grep=$?""#,
		r#") 3> >(true) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "cat=1\ncut=1\nhead=1\nfold=1\nod=1\nyes=1\ngrep=2\n");
}

/// `ps` and `top` end as procps ends them when a write finds a pipe with no
/// reader, whatever the shell's SIGPIPE disposition and whichever stream it
/// is: `ps` catches SIGPIPE and exits 0 at once; `top` catches it and goes on
/// to its own status, 0, or 1 for an invalid option. Their help and version
/// go to standard output with status 0. Measured against Bash 5.2.21 and
/// procps-ng, per command: standard output, standard error, both.
/// Regression: they reported 141, or 1 or 2.
#[tokio::test(flavor = "multi_thread")]
async fn ps_and_top_end_as_procps_does_at_a_dead_pipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"for disp in default ignored; do"#,
		r#"  for cmd in "ps" "ps --help" "ps --version" "ps --bogus" "top -b -n 1" "top --help" "top -h" "top --version" "top --bogus"; do"#,
		r#"    for stream in out err both; do"#,
		r#"      ( [ "$disp" = ignored ] && trap '' PIPE; fill"#,
		r#"        case $stream in out) $cmd >&3 2>/dev/null ;; err) $cmd 2>&3 >/dev/null ;; both) $cmd >&3 2>&3 ;; esac"#,
		r#"        printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"    done"#,
		r#"  done; echo"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	let per_disposition = "0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 1 1 \n";
	assert_eq!(output, per_disposition.repeat(2));
}

/// A utility buffers its standard output to a pipe, as GNU's stdio does, so
/// a write that finds the reader gone kills it only once that buffer would
/// be written (a pipe block, when it starts a command, or at exit): it
/// finishes its other operands first. One that writes unbuffered (`tee`,
/// `dd`) dies at once, before it writes its files or a summary, and a
/// diagnostic, which a process writes unbuffered, kills it at once when it
/// shares the dead destination. Measured against Bash 5.2.21. Regression:
/// every utility died at its first failed write and skipped the rest.
#[tokio::test(flavor = "multi_thread")]
async fn a_buffered_utility_dies_once_its_output_buffer_would_be_written() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"mkdir src e1 e2; : > r1; : > r2; : > src/c1; : > src/c2; : > v1; : > v2"#,
		r#"( fill; rm -v r1 r2 >&3; cp -v src/c1 src/c2 . >&3; mkdir -v d1 d2 >&3; mv -v v1 v2 src/ >&3; rmdir -v e1 e2 >&3; echo "rmdir=$?" ) 3> >(true)"#,
		r#"echo "r2=$(made r2) c2=$(made c2) d2=$(made d2) v2=$(made src/v2) e2=$(made e2)""#,
		r#"mkdir fd1; : > fd1/a; : > fd1/b; ( fill; find fd1 -type f -print -delete >&3; echo "find=$?" ) 3> >(true); echo "left=$(ls fd1 | wc -l)""#,
		r#"( fill; printf 'abc\n' | tee out0 >&3; echo "tee=$? $([ -s out0 ] && echo full || echo empty)" ) 3> >(true)"#,
		r#"( fill; printf 'abc\n' | dd status=noxfer >&3; echo "dd=$?" ) 3> >(true)"#,
		r#": > m1; ( fill; rm -v nonexist m1 >&3 2>&3; echo "rm-merged=$?" ) 3> >(true); echo "kept=$(made m1)""#,
		r#": > blockf; ( fill; mkdir -v n1 blockf n2 >&3 2>&3; echo "mkdir-merged=$?" ) 3> >(true); echo "n2=$(made n2)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"rmdir=141\n",
			"r2=no c2=yes d2=yes v2=yes e2=no\n",
			"find=141\n",
			"left=0\n",
			"tee=141 empty\n",
			"dd=141\n",
			"rm-merged=141\n",
			"kept=yes\n",
			"mkdir-merged=141\n",
			"n2=no\n",
		)
	);
}

/// With SIGPIPE ignored, a write that finds a pipe with no reader fails with
/// `EPIPE`; a GNU utility goes on with its work and, checking its streams at
/// exit, fails with its `exit_failure` status (1; 2 for `ls`, `grep`, `sort`,
/// `printenv`; 4 for `sed`; 125 for `env`). A command `env` ran in its place
/// keeps its own status, as after `execvp`, and `xargs` runs no command after
/// its trace failed. Measured against Bash 5.2.21. Regression: they reported
/// success or their usage-error status, `env` replaced its command's status
/// with 125, and `xargs` ran its command.
#[tokio::test(flavor = "multi_thread")]
async fn an_ignored_sigpipe_fails_a_utility_when_it_exits() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"mkdir src e1 e2; : > r1; : > r2; : > src/c1; : > src/c2; : > v1; : > v2"#,
		r#"( trap '' PIPE; fill"#,
		r#"  rm -v r1 r2 >&3; echo "rm=$?""#,
		r#"  cp -v src/c1 src/c2 . >&3; echo "cp=$?""#,
		r#"  mkdir -v d1 d2 >&3; echo "mkdir=$?""#,
		r#"  mv -v v1 v2 src/ >&3; echo "mv=$?""#,
		r#"  rmdir -v e1 e2 >&3; echo "rmdir=$?""#,
		r#"  ls >&3; echo "ls=$?""#,
		r#"  printf 'abc\n' | grep -c x >&3; echo "grep-c=$?""#,
		r#"  printf 'b\na\n' | sort >&3; echo "sort=$?""#,
		r#"  date >&3; echo "date=$?""#,
		r#"  printf 'a\n' | uniq >&3; echo "uniq=$?""#,
		r#"  md5sum /etc/hostname >&3; echo "md5sum=$?""#,
		r#"  sed p /etc/hostname >&3; echo "sed=$?""#,
		r#"  printenv HOME >&3; echo "printenv=$?""#,
		r#"  which sh >&3; echo "which=$?""#,
		r#"  : > m5; rm -v nonexist m5 >&3 2>&3; echo "rm-merged=$? $(made m5)""#,
		r#"  env -v nosuchcmd 2>&3; echo "env-missing=$?""#,
		r#"  env -v /bin/sh -c 'touch env-child; exit 141' 2>&3; echo "env=$? $(made env-child)""#,
		r#"  env -v /bin/sh -c 'exit 3' 2>&3; echo "env3=$?""#,
		r#"  nohup /bin/sh -c 'exit 141' >&3; echo "nohup=$?""#,
		r#"  timeout 5 /bin/sh -c 'exit 141' >&3; echo "timeout=$?""#,
		r#"  xargs -t touch xargs-child <<< arg 2>&3; echo "xargs=$? $(made xargs-child)""#,
		r#") 3> >(true) 2>/dev/null"#,
		r#"echo "r2=$(made r2) c2=$(made c2) d2=$(made d2) v2=$(made src/v2) e2=$(made e2)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"rm=1\n",
			"cp=1\n",
			"mkdir=1\n",
			"mv=1\n",
			"rmdir=1\n",
			"ls=2\n",
			"grep-c=2\n",
			"sort=2\n",
			"date=1\n",
			"uniq=1\n",
			"md5sum=1\n",
			"sed=4\n",
			"printenv=2\n",
			"which=1\n",
			"rm-merged=1 no\n",
			"env-missing=125\n",
			"env=141 yes\n",
			"env3=3\n",
			"nohup=141\n",
			"timeout=141\n",
			"xargs=1 no\n",
			"r2=no c2=yes d2=yes v2=yes e2=no\n",
		)
	);
}

/// `tee` writes standard output first and unbuffered, as GNU `tee` does; at
/// a pipe with no reader an `--output-error` mode (`-p` is `warn-nopipe`),
/// or an ignored SIGPIPE, drops that output silently (status 0), warns
/// (status 1), or exits before it writes its files (`exit`, status 1).
/// Measured against Bash 5.2.21. Regression: a dropped pipe failed `tee`,
/// and `exit` mode wrote its files before it exited.
#[tokio::test(flavor = "multi_thread")]
async fn tee_follows_its_output_error_mode_at_a_dead_pipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( fill; printf 'abc\n' | tee -p >&3; echo "p=$?" ) 3> >(true) 2>/dev/null"#,
		r#"for mode in warn warn-nopipe exit exit-nopipe; do"#,
		r#"  ( fill; printf 'abc\n' | tee --output-error=$mode out1 >&3; echo "$mode=$? $([ -s out1 ] && echo full || echo empty)" ) 3> >(true) 2>/dev/null"#,
		r#"done"#,
		r#"( fill; printf 'abc\n' | tee --output-error >&3; echo "output-error=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( trap '' PIPE; fill; printf 'abc\n' | tee >&3; echo "ignored=$?" ) 3> >(true) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"p=0\n",
			"warn=1 full\n",
			"warn-nopipe=0 full\n",
			"exit=1 empty\n",
			"exit-nopipe=0 full\n",
			"output-error=0\n",
			"ignored=0\n",
		)
	);
}

/// A command `xargs` runs, its default `echo` too, dies alone when SIGPIPE
/// kills it, and `xargs` reports the signal with status 125, as for a
/// process a signal killed; a command that exits with status 141 is a failed
/// command (123). Measured against Bash 5.2.21. Regression: the default
/// `echo` killed `xargs` itself (141), it printed its options as text, and an
/// `echo` command counted as a failed one (123).
#[tokio::test(flavor = "multi_thread")]
async fn xargs_reports_a_command_sigpipe_killed() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( fill; printf 'a\nb\n' | xargs >&3; echo "default=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( fill; printf 'a\nb\n' | xargs -n1 >&3; echo "default-n1=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( fill; printf 'a\nb\n' | xargs -n1 echo >&3; echo "echo=$?" ) 3> >(true) 2>/dev/null"#,
		r#"printf 'a\n' | xargs /bin/sh -c 'exit 141' 2>/dev/null; echo "exit=$?""#,
		r#"printf 'a\n' | xargs env /bin/sh -c 'exit 141' 2>/dev/null; echo "env-exit=$?""#,
		r#"printf -- '-n\nx\n' | xargs; echo "<""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "default=125\ndefault-n1=125\necho=125\nexit=123\nenv-exit=123\nx<\n");
}

/// An async utility (here `grep`) delivers a diagnostic before it goes on to
/// wait for its input, as a process writes its standard error unbuffered, so
/// the diagnostic survives the `timeout` that ends the wait. Measured against
/// Bash 5.2.21. Regression: it stayed buffered until the input ended, and the
/// cancellation dropped it.
#[tokio::test(flavor = "multi_thread")]
async fn an_async_utility_delivers_a_diagnostic_before_it_waits() {
	let (exit_code, output) = run(
		"/bin/sleep 2 | timeout 0.5 grep x /definitely/missing - 2>&1; echo \"grep=$?\"".to_string(),
	)
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert!(
		output.starts_with("grep: /definitely/missing: No such file or directory"),
		"{output:?}"
	);
	assert!(output.ends_with("\ngrep=124\n"), "{output:?}");
}

/// `tail -f` whose reader goes away ends as GNU `tail -f` does, raising
/// SIGPIPE: status 141, or 1 with SIGPIPE ignored. Measured against Bash
/// 5.2.21. Regression: it reported success.
#[tokio::test(flavor = "multi_thread")]
async fn tail_follow_raises_sigpipe_when_its_reader_goes() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"printf 'line\n' > log"#,
		r#"tail -f log | head -n 1; echo "tail=${PIPESTATUS[0]}""#,
		r#"( trap '' PIPE; tail -f log | head -n 1; echo "tail-ignored=${PIPESTATUS[0]}" ) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "line\ntail=141\nline\ntail-ignored=1\n");
}

/// A buffered utility's output is written once its buffer fills (one pipe
/// block) or at an explicit flush (`find -printf '\c'`, `grep
/// --line-buffered`), and SIGPIPE kills it there, before its next action;
/// output that stays within the buffer leaves it to finish its work first.
/// Measured against Bash 5.2.21. Regression: `find` ran `-delete` after a
/// flush or a full buffer had found the pipe with no reader.
#[tokio::test(flavor = "multi_thread")]
async fn a_utility_dies_where_its_output_buffer_is_written() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#": > v1; ( fill; find v1 -printf 'x\c' -delete >&3; echo "find-c=$? $(made v1)" ) 3> >(true)"#,
		r#": > v2; ( fill; find v2 -printf '%5000s' -delete >&3; echo "find-5000=$? $(made v2)" ) 3> >(true)"#,
		r#": > v3; ( fill; find v3 -printf '%9000s' -delete >&3; echo "find-9000=$? $(made v3)" ) 3> >(true)"#,
		r#": > v4; ( fill; find v4 -printf '%100s' -delete >&3; echo "find-100=$? $(made v4)" ) 3> >(true)"#,
		r#"mkdir many; for i in $(seq 1 400); do : > "many/a-long-file-name-$i"; done"#,
		r#"( fill; find many -type f -print -delete >&3; echo "find-many=$? left=$(ls many | wc -l)" ) 3> >(true)"#,
		r#"printf 'x\n' > g1; ( fill; grep --line-buffered x g1 >&3; echo "grep-lb=$?" ) 3> >(true)"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"find-c=141 yes\n",
			"find-5000=141 yes\n",
			"find-9000=141 yes\n",
			"find-100=141 no\n",
			"find-many=141 left=241\n",
			"grep-lb=141\n",
		)
	);
}

/// A command `env` runs in its place, as `execvp` replaces it, that SIGPIPE
/// kills leaves `env` killed by SIGPIPE, so `xargs` reports the signal (125)
/// and runs nothing more; a command that exits with status 141 is a failed
/// command (123). Measured against Bash 5.2.21. Regression: `env` turned
/// the death into an exit with 141, and `xargs` ran the next command.
#[tokio::test(flavor = "multi_thread")]
async fn a_command_env_runs_in_its_place_dies_as_env() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"( fill; printf 'a\nb\n' | xargs -n1 env /bin/sh -c 'echo "$1" >> seen2; echo data' sh >&3; echo "xargs-env=$? seen=$(cat seen2 | tr '\n' ,)" ) 3> >(true) 2>/dev/null"#,
		r#"( fill; env /bin/sh -c 'echo data' >&3; echo "env=$?" ) 3> >(true)"#,
		r#"( fill; env env /bin/sh -c 'echo data' >&3; echo "env-env=$?" ) 3> >(true)"#,
		r#"( fill; timeout 5 env /bin/sh -c 'echo data' >&3; echo "timeout-env=$?" ) 3> >(true)"#,
		r#"( fill; nohup env /bin/sh -c 'echo data' >&3; echo "nohup-env=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( fill; printf 'a\nb\n' | xargs -n1 env /bin/sh -c 'echo "$1" >> seen3; exit 141' sh; echo "xargs-exit=$? seen=$(cat seen3 | tr '\n' ,)" ) 3> >(true) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"xargs-env=125 seen=a,\n",
			"env=141\n",
			"env-env=141\n",
			"timeout-env=141\n",
			"nohup-env=141\n",
			"xargs-exit=123 seen=a,b,\n",
		)
	);
}

/// A utility's write to a file operand that is a pipe with no reader
/// (`/dev/fd/N`) raises SIGPIPE as a write to its standard output does: it
/// dies at once, before it writes the files after it, or, with SIGPIPE
/// ignored, the write fails with `EPIPE` and the utility reports it with its
/// error status (4 for `sed`). Measured against Bash 5.2.21. Regression:
/// `tee` wrote its other files and ended with 0, and the others reported a
/// write error with status 1 or 2.
#[tokio::test(flavor = "multi_thread")]
async fn a_write_to_a_file_operand_with_no_reader_raises_sigpipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"printf abc > input"#,
		r#"( fill; tee /dev/fd/3 copy < input > /dev/null; echo "tee=$? copy=$(wc -c < copy)" ) 3> >(true)"#,
		r#"( fill; dd of=/dev/fd/3 status=none < input; echo "dd=$?" ) 3> >(true)"#,
		r#"( fill; cp input /dev/fd/3; echo "cp=$?" ) 3> >(true)"#,
		r#"( fill; sed -n 'w /dev/fd/3' input; echo "sed-w=$?" ) 3> >(true)"#,
		r#"( fill; find input -fprint /dev/fd/3; echo "find-fprint=$?" ) 3> >(true)"#,
		r#"( trap '' PIPE; fill; tee /dev/fd/3 copy2 < input > /dev/null; echo "tee-ignored=$? copy=$(wc -c < copy2)" ) 3> >(true) 2>/dev/null"#,
		r#"( trap '' PIPE; fill; dd of=/dev/fd/3 status=none < input; echo "dd-ignored=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( trap '' PIPE; fill; cp input /dev/fd/3; echo "cp-ignored=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( trap '' PIPE; fill; sed -n 'w /dev/fd/3' input; echo "sed-w-ignored=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( trap '' PIPE; fill; find input -fprint /dev/fd/3; echo "find-fprint-ignored=$?" ) 3> >(true) 2>/dev/null"#,
		r#"( fill; tee -p /dev/fd/3 copy3 < input > /dev/null; echo "tee-p=$? copy=$(wc -c < copy3)" ) 3> >(true) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"tee=141 copy=0\n",
			"dd=141\n",
			"cp=141\n",
			"sed-w=141\n",
			"find-fprint=141\n",
			"tee-ignored=0 copy=3\n",
			"dd-ignored=1\n",
			"cp-ignored=1\n",
			"sed-w-ignored=4\n",
			"find-fprint-ignored=1\n",
			"tee-p=0 copy=3\n",
		)
	);
}

/// With SIGPIPE ignored, a utility whose standard output fails ends with
/// GNU's `exit_failure` status for it, which is not always its usage-error
/// status: 4 for `sed` (also `-u`), 1 for the checksum utilities, 2 for
/// `printenv`. Measured against Bash 5.2.21. Regression: they ended with
/// their usage-error status.
#[tokio::test(flavor = "multi_thread")]
async fn an_ignored_sigpipe_fails_a_utility_with_its_output_error_status() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"printf 'host\n' > h"#,
		r#"for cmd in "sed p h" "sed -u p h" "b2sum h" "md5sum h" "sha1sum h" "sha224sum h" "sha256sum h" "sha384sum h" "sha512sum h" "printenv HOME"; do"#,
		r#"  ( trap '' PIPE; fill; eval "$cmd" >&3 2>/dev/null; printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"done; echo"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "4 4 1 1 1 1 1 1 1 2 \n");
}

/// `rsync` ignores SIGPIPE and the errors of its standard output: a dead
/// output pipe leaves the transfer and its status alone (0, or 23 for a
/// missing source). A diagnostic it cannot write ends the run at once with
/// status 13 (RERR_MESSAGEIO), before any transfer. Measured against rsync
/// 3.5.1 under Bash 5.2.21. Regression: SIGPIPE killed it at its output
/// (141), and a failed diagnostic let the transfer finish.
#[tokio::test(flavor = "multi_thread")]
async fn rsync_ends_at_a_dead_pipe_as_rsync_does() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"mkdir src; for i in $(seq 1 300); do printf 'x\n' > "src/file$i"; done"#,
		r#"for disp in default ignored; do"#,
		r#"  for stream in out err both quiet; do"#,
		r#"    rm -rf dst; mkdir dst"#,
		r#"    ( [ "$disp" = ignored ] && trap '' PIPE; fill"#,
		r#"      case $stream in"#,
		r#"      out) rsync -av src/ nosuchsrc dst/ >&3 2>/dev/null ;;"#,
		r#"      err) rsync -av src/ nosuchsrc dst/ 2>&3 >/dev/null ;;"#,
		r#"      both) rsync -av src/ nosuchsrc dst/ >&3 2>&3 ;;"#,
		r#"      quiet) rsync -av src/ dst/ >&3 2>/dev/null ;;"#,
		r#"      esac"#,
		r#"      echo "$disp $stream rsync=$? copied=$(ls dst | wc -l)" ) 3> >(true) 2>/dev/null"#,
		r#"  done"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"default out rsync=23 copied=300\n",
			"default err rsync=13 copied=0\n",
			"default both rsync=13 copied=0\n",
			"default quiet rsync=0 copied=300\n",
			"ignored out rsync=23 copied=300\n",
			"ignored err rsync=13 copied=0\n",
			"ignored both rsync=13 copied=0\n",
			"ignored quiet rsync=0 copied=300\n",
		)
	);
}

/// `sed`'s `w` files are buffered as GNU sed's stdio buffers them: each
/// block is written as it fills, and the rest at exit, also the exit after a
/// failed write with SIGPIPE ignored (status 4), while SIGPIPE's death loses
/// it. Measured against Bash 5.2.21. Regression: an error exit wrote nothing
/// to the `w` files, and their buffers were written late, at the next `sed`.
#[tokio::test(flavor = "multi_thread")]
async fn sed_w_files_end_as_its_stdio_buffers_do() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"seq 1 3000 > big; seq 1 10 > small"#,
		r#"for disp in default ignored; do"#,
		r#"  for input in big small; do"#,
		r#"    rm -f copy"#,
		r#"    ( [ "$disp" = ignored ] && trap '' PIPE; fill; sed -n "p;w copy" $input >&3; echo "$disp $input sed=$? bytes=$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"  done"#,
		r#"  rm -f copy"#,
		r#"  ( [ "$disp" = ignored ] && trap '' PIPE; fill; sed "h;s/.*/&&&&/;w copy"$'\n'"g" big >&3; echo "$disp double sed=$? bytes=$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"default big sed=141 bytes=0\n",
			"default small sed=141 bytes=21\n",
			"default double sed=141 bytes=12288\n",
			"ignored big sed=4 bytes=4093\n",
			"ignored small sed=4 bytes=21\n",
			"ignored double sed=4 bytes=13269\n",
		)
	);
}

/// `rg` and `fd` end at a pipe with no reader as ripgrep and fd, Rust
/// programs that ignore SIGPIPE, do, whatever the shell's disposition:
/// ripgrep stops searching and ends with its usual status, counting what it
/// already wrote (1 when the only file's output failed), and exits 0 at an
/// error message it cannot write; fd ends with 1 once its output fails, and
/// 101 (its `eprintln!` panics) at an error message it cannot write.
/// Measured against ripgrep 15.2.0 and fd 10.5.0 under Bash 5.2.21.
/// Regression: they died of SIGPIPE (141), or reported a write error (2).
#[tokio::test(flavor = "multi_thread")]
async fn rg_and_fd_end_at_a_dead_pipe_as_ripgrep_and_fd_do() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"printf 'match\n' > one"#,
		r#"seq 1 200000 | sed 's/^/match /' > bigfile"#,
		r#"mkdir dir; for i in $(seq 1 300); do printf 'match\n' > "dir/f$i"; done"#,
		r#"mkdir sub; for i in $(seq 1 300); do : > "sub/entry-$i"; done"#,
		r#"for disp in default ignored; do"#,
		r#"  for cmd in "rg match one" "rg match bigfile" "rg match dir" "rg -j1 match dir" "rg match one bigfile" "rg -c match dir" "rg -l match dir" "rg -q match dir" "rg match - < bigfile" "rg --files dir" "rg match dir nosuch" "rg match nosuch dir" "fd . sub" "fd -j1 . sub" "fd entry-1 sub"; do"#,
		r#"    for stream in out err; do"#,
		r#"      ( [ "$disp" = ignored ] && trap '' PIPE; fill"#,
		r#"        case $stream in out) eval "$cmd" >&3 2>/dev/null ;; err) eval "$cmd" 2>&3 >/dev/null ;; esac"#,
		r#"        printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"    done"#,
		r#"  done"#,
		r#"  ( [ "$disp" = ignored ] && trap '' PIPE; fill; fd . nosuchdir 2>&3 >/dev/null; echo "fd-message=$?" ) 3> >(true) 2>/dev/null"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	let per_disposition =
		"0 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 2 0 2 0 1 0 1 0 1 0 fd-message=101\n";
	assert_eq!(output, per_disposition.repeat(2));
}

/// A buffered utility writes its output buffer to the descriptor when a
/// write overflows it, as glibc does (one that only fills it writes nothing),
/// and its flush empties it: SIGPIPE kills it at that write, before its next
/// action. Measured against Bash 5.2.21. Regression: `find` died once its
/// output reached a block boundary, also counting bytes an earlier flush had
/// already written, and skipped `-delete`.
#[tokio::test(flavor = "multi_thread")]
async fn a_utility_writes_its_buffer_when_a_write_overflows_it() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#": > v1; ( fill; find v1 -printf '%4096s' -delete >&3; echo "find-4096=$? $(made v1)" ) 3> >(true)"#,
		r#": > v2; ( fill; find v2 -printf '%4097s' -delete >&3; echo "find-4097=$? $(made v2)" ) 3> >(true)"#,
		r#": > v3; ( fill; find v3 -printf '%4095s' -delete >&3; echo "find-4095=$? $(made v3)" ) 3> >(true)"#,
		r#": > v4; ( fill; find v4 -printf '%8192s' -delete >&3; echo "find-8192=$? $(made v4)" ) 3> >(true)"#,
		r#"mkdir fl; : > fl/a; : > fl/b"#,
		r#"( find fl/a fl/b -name a -printf 'abc\c' -exec sh -c 'trap "" PIPE; while printf x 2>/dev/null; do sleep 0.05; done' \; -o -name b -printf '%4093s' -delete >&3; echo "find-flush-then=$? $(made fl/b)" ) 3> >(head -c 3 > /dev/null)"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"find-4096=141 no\n",
			"find-4097=141 yes\n",
			"find-4095=141 no\n",
			"find-8192=141 yes\n",
			"find-flush-then=141 no\n",
		)
	);
}

/// `find`'s output files are buffered as GNU find's stdio buffers them, so
/// one that is a pipe with no reader kills `find` when it writes its buffer
/// (here at exit), after its other actions. Measured against Bash 5.2.21.
/// Regression: `find` wrote each entry at once and died before `-delete`.
#[tokio::test(flavor = "multi_thread")]
async fn find_output_files_are_buffered() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"for act in "-fprint /dev/fd/3" "-fprint0 /dev/fd/3" "-fprintf /dev/fd/3 %p" "-fls /dev/fd/3" "-fprintf /dev/fd/3 x\\c"; do"#,
		r#"	: > victim; ( fill; eval "find victim $act -delete"; echo "find $act = $? $(made victim)" ) 3> >(true) 2>/dev/null"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"find -fprint /dev/fd/3 = 141 no\n",
			"find -fprint0 /dev/fd/3 = 141 no\n",
			"find -fprintf /dev/fd/3 %p = 141 no\n",
			"find -fls /dev/fd/3 = 141 no\n",
			"find -fprintf /dev/fd/3 x\\c = 141 no\n",
		)
	);
}

/// `sed -u` writes its `w` files unbuffered too, as GNU sed flushes each
/// output then, so a `w` file keeps the lines written before a later write
/// killed `sed`, and a `w` file with no reader fails `sed` at once when
/// SIGPIPE is ignored. Measured against Bash 5.2.21. Regression: `-u` left
/// the `w` files block-buffered.
#[tokio::test(flavor = "multi_thread")]
async fn sed_u_writes_w_files_unbuffered() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"printf 'a\nb\nc\n' > input"#,
		r#"rm -f copy; ( fill; sed -un $'w copy\np' input >&3; echo "sed-u=$? bytes=$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"rm -f copy; ( fill; sed -n $'w copy\np' input >&3; echo "sed=$? bytes=$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"rm -f copy; ( trap '' PIPE; fill; sed -un $'w /dev/fd/3\nw copy' input; echo "sed-u-ignored-w=$? bytes=$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "sed-u=141 bytes=2\nsed=141 bytes=6\nsed-u-ignored-w=4 bytes=0\n");
}

/// `rg` and `fd` ignore SIGPIPE from their start, also for their help,
/// version and usage messages: help and version end with 0 at a dead
/// standard output; a usage error at a dead standard error ends `rg` with 0
/// (its message macro) and `fd` with 2 (its argument parser ignores the
/// failed write). Measured against ripgrep 15.2.0 and fd 10.5.0 under Bash
/// 5.2.21. Regression: they died of SIGPIPE (141) or reported a write error.
#[tokio::test(flavor = "multi_thread")]
async fn rg_and_fd_usage_messages_ignore_sigpipe() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"for disp in default ignored; do"#,
		r#"	for cmd in "rg --version" "rg --help" "fd --version" "fd --help"; do"#,
		r#"		( [ "$disp" = ignored ] && trap '' PIPE; fill; eval "$cmd" >&3 2>/dev/null; printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"	done"#,
		r#"	for cmd in "rg --badoption x" "fd --badoption"; do"#,
		r#"		( [ "$disp" = ignored ] && trap '' PIPE; fill; eval "$cmd" 2>&3 >/dev/null; printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"	done; echo"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "0 0 0 0 0 2 \n0 0 0 0 0 2 \n");
}

/// A process writes its standard error unbuffered, also to a regular file,
/// so a diagnostic written before standard output's death reaches the file.
/// Measured against Bash 5.2.21: `err` holds the 40-byte diagnostic.
/// Regression: the diagnostic stayed in a block buffer the death discarded.
#[tokio::test(flavor = "multi_thread")]
async fn a_diagnostic_to_a_file_survives_a_later_death() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"printf 'in\n' > in1"#,
		r#"( fill; cat missing in1 >&3 2>err; echo "cat=$? errbytes=$(wc -c < err)" ) 3> >(true)"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "cat=141 errbytes=40\n");
}

/// `rsync` ignores SIGPIPE only once it parsed its options, as rsync does:
/// its help, version and option errors before that die of SIGPIPE (141); a
/// diagnostic it cannot write with SIGPIPE ignored ends it with 13
/// (RERR_MESSAGEIO), also an option error and a failing `--write-batch`.
/// Measured against rsync 3.5.1 under Bash 5.2.21. Regression: it ignored
/// SIGPIPE from the start (0, 1) and kept a failing step's own status (3).
#[tokio::test(flavor = "multi_thread")]
async fn rsync_ignores_sigpipe_once_its_options_parse() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"for disp in default ignored; do"#,
		r#"	for cmd in "rsync --version" "rsync --help"; do"#,
		r#"		( [ "$disp" = ignored ] && trap '' PIPE; fill; eval "$cmd" >&3 2>/dev/null; printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"	done"#,
		r#"	( [ "$disp" = ignored ] && trap '' PIPE; fill; rsync --badoption 2>&3 >/dev/null; printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"done; echo"#,
		r#"mkdir -p src; for i in $(seq 1 40); do printf 'x\n' > "src/f$i"; done"#,
		r#"for disp in default ignored; do"#,
		r#"	( [ "$disp" = ignored ] && trap '' PIPE; fill; rsync -a --write-batch=/dev/fd/3 src/ bdst/ >&3 2>&3; printf '%s ' "$?" ) 3> >(true) 2>/dev/null"#,
		r#"	rm -rf bdst bdst.sh"#,
		r#"done; echo"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(output, "141 141 141 0 0 13 \n13 13 \n");
}

/// An `rsync` pull through a remote shell whose diagnostics find standard
/// error's reader gone ends with 13 before any transfer, as rsync does: the
/// remote-shell child writes to the command's own standard error and fails
/// there. A dead standard output leaves the transfer alone. Measured
/// against rsync 3.5.1 under Bash 5.2.21; the server side is the `rsync` on
/// `PATH`, so the test needs one. Regression: the child's standard error was
/// a pipe the builtin drained, its failure was dropped, and the pull
/// finished with 23.
#[tokio::test(flavor = "multi_thread")]
async fn rsync_pulls_end_at_a_dead_stderr_as_rsync_does() {
	if !std::env::var_os("PATH")
		.is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join("rsync").is_file()))
	{
		eprintln!("skipped: the server side of the pull needs an rsync on PATH");
		return;
	}
	let (exit_code, output) = run_in_tempdir(&[
		r#"d=$PWD; mkdir -p src; for i in $(seq 1 40); do printf 'x\n' > "src/f$i"; done"#,
		r#"printf '#!/bin/sh\nshift\nexec "$@"\n' > rsh.sh; chmod +x rsh.sh"#,
		r#"for disp in default ignored; do"#,
		r#"	for stream in err both out; do"#,
		r#"		rm -rf dst; mkdir dst"#,
		r#"		( [ "$disp" = ignored ] && trap '' PIPE; fill"#,
		r#"		  case $stream in"#,
		r#"		  err) rsync -a -e "$d/rsh.sh" "localhost:$d/src/" "localhost:$d/nosuch" dst/ 2>&3 >/dev/null ;;"#,
		r#"		  both) rsync -a -e "$d/rsh.sh" "localhost:$d/src/" "localhost:$d/nosuch" dst/ >&3 2>&3 ;;"#,
		r#"		  out) rsync -av -e "$d/rsh.sh" "localhost:$d/src/" dst/ >&3 2>/dev/null ;;"#,
		r#"		  esac"#,
		r#"		  echo "$disp $stream rsync-pull=$? copied=$(ls dst | wc -l)" ) 3> >(true) 2>/dev/null"#,
		r#"	done"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"default err rsync-pull=13 copied=0\n",
			"default both rsync-pull=13 copied=0\n",
			"default out rsync-pull=0 copied=40\n",
			"ignored err rsync-pull=13 copied=0\n",
			"ignored both rsync-pull=13 copied=0\n",
			"ignored out rsync-pull=0 copied=40\n",
		)
	);
}

/// `find` writes its output as GNU find's stdio calls, so a pipe with no
/// reader kills it at the call glibc writes at: a `-printf` literal is one
/// `fwrite`, which writes a whole first block at once, while a directive is
/// one `printf` of the literal before it and its value, which only fills the
/// buffer; an escape or `%%` ends a literal's `fwrite`; `\c` writes, flushes
/// and ends the format. The same for `-fprintf` to a file. Measured against
/// findutils 4.9.0 under Bash 5.2.21 (`yes` is the victim kept, the death
/// before `-delete`). Regression: every shape died only past a whole block,
/// and `\c` went on with the rest of the format.
#[tokio::test(flavor = "multi_thread")]
async fn find_writes_its_output_as_gnu_finds_stdio_calls() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"made() { [ -e "$1" ] && echo yes || echo no; }"#,
		r#"xs() { /usr/bin/head -c "$1" /dev/zero | /usr/bin/tr '\0' x; }"#,
		r#"for n in 4095 4096 4097 8192; do"#,
		r#"  literal=$(xs "$n")"#,
		r#"  for kind in stdout file; do"#,
		r#"    : > victim"#,
		r#"    ( fill"#,
		r#"      if [ "$kind" = stdout ]; then find victim -printf "$literal" -delete >&3; else find victim -fprintf /dev/fd/3 "$literal" -delete; fi"#,
		r#"      printf '%s ' "$(made victim)" ) 3> >(true) 2>/dev/null"#,
		r#"    : > victim"#,
		r#"    ( fill"#,
		r#"      if [ "$kind" = stdout ]; then find victim -printf "%${n}s" -delete >&3; else find victim -fprintf /dev/fd/3 "%${n}s" -delete; fi"#,
		r#"      printf '%s ' "$(made victim)" ) 3> >(true) 2>/dev/null"#,
		r#"  done"#,
		r#"done; echo"#,
		r#"literal=$(xs 4095)"#,
		r#": > victim; ( fill; find victim -printf "$literal\n" -delete >&3; printf '%s ' "$(made victim)" ) 3> >(true) 2>/dev/null"#,
		r#": > victim; ( fill; find victim -printf "$literal%%" -delete >&3; printf '%s ' "$(made victim)" ) 3> >(true) 2>/dev/null"#,
		r#": > victim; ( fill; find victim -printf "$literal%p" -delete >&3; printf '%s ' "$(made victim)" ) 3> >(true) 2>/dev/null"#,
		r#": > victim; ( fill; find victim -printf "%p$(xs 4096)" -delete >&3; printf '%s ' "$(made victim)" ) 3> >(true) 2>/dev/null"#,
		r#"echo; find . -maxdepth 0 -printf 'a\cb%p\n'; echo "<stop=$?""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"no no no no yes no yes no yes yes yes yes yes yes yes yes \n",
			"yes yes yes yes \n",
			"a<stop=0\n",
		)
	);
}

/// `sed`'s `w` files follow glibc's `fwrite` (a line and its newline are two
/// calls; one that only fills the buffer writes nothing; a first call of a
/// whole block writes it at once), and at exit `sed` closes them newest
/// first. Measured against sed 4.9 under Bash 5.2.21 (`status:bytes` of the
/// live file). Regression: a full block was written at once, killing `sed`
/// before its next `w`, and the files closed oldest first.
#[tokio::test(flavor = "multi_thread")]
async fn sed_w_files_follow_glibcs_fwrite() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"xs() { /usr/bin/head -c "$1" /dev/zero | /usr/bin/tr '\0' x; }"#,
		r#"for n in 4094 4095 4096 8192; do"#,
		r#"  xs "$n" > input; printf '\n' >> input"#,
		r#"  for disp in default ignored; do"#,
		r#"    rm -f copy"#,
		r#"    ( [ "$disp" = ignored ] && trap '' PIPE; fill; sed -n $'w /dev/fd/3\nw copy' input; printf '%s:%s ' "$?" "$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"  done"#,
		r#"done; echo"#,
		r#"for k in 2047 2048 2049; do"#,
		r#"  /usr/bin/yes x | /usr/bin/head -n "$k" > input"#,
		r#"  rm -f copy; ( fill; sed -n $'w /dev/fd/3\nw copy' input; printf '%s:%s ' "$?" "$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"done; echo"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"141:4095 4:4095 141:4096 4:4096 141:0 4:0 141:0 4:0 \n",
			"141:4094 141:4096 141:0 \n"
		)
	);
}

/// At exit `sed` closes its `w` files newest first, then standard output;
/// `find` closes its output files in its table's hash order (`(st_dev ^
/// st_ino) % 13`, computed here from `stat`), then standard output. A pipe
/// with no reader kills them at its close, the files after it unwritten;
/// with SIGPIPE ignored all are written. Measured against sed 4.9 and
/// findutils 4.9.0 under Bash 5.2.21 (`status:bytes`, `hashed` when `copy`
/// got its byte as the hash order says). Regression: both closed oldest
/// first.
#[tokio::test(flavor = "multi_thread")]
async fn utilities_close_their_output_files_in_gnu_order() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"for disp in default ignored; do"#,
		r#"  for order in first last; do"#,
		r#"    rm -f copy; printf 'x\n' > input"#,
		r#"    ( [ "$disp" = ignored ] && trap '' PIPE; fill"#,
		r#"      if [ "$order" = first ]; then sed -n $'w /dev/fd/3\nw copy' input; else sed -n $'w copy\nw /dev/fd/3' input; fi"#,
		r#"      printf 'sed:%s:%s ' "$?" "$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"    : > copy; : > victim"#,
		r#"    ( [ "$disp" = ignored ] && trap '' PIPE; fill"#,
		r#"      set -- $(stat -L -c '%d %i' /dev/fd/3) $(stat -c '%d %i' copy)"#,
		r#"      p=$(( ($1 ^ $2) % 13 )); c=$(( ($3 ^ $4) % 13 ))"#,
		r#"      if [ "$order" = first ]; then"#,
		r#"        find victim -fprintf /dev/fd/3 x -fprintf copy y -delete"#,
		r#"        s=$?; [ "$c" -lt "$p" ] && e=1 || e=0"#,
		r#"      else"#,
		r#"        find victim -fprintf copy y -fprintf /dev/fd/3 x -delete"#,
		r#"        s=$?; [ "$c" -le "$p" ] && e=1 || e=0"#,
		r#"      fi"#,
		r#"      [ "$disp" = ignored ] && e=1"#,
		r#"      [ "$(wc -c < copy)" = "$e" ] && v=hashed || v="unhashed:$p:$c""#,
		r#"      printf 'find:%s:%s ' "$s" "$v" ) 3> >(true) 2>/dev/null"#,
		r#"  done"#,
		r#"  rm -f copy; : > victim"#,
		r#"  ( [ "$disp" = ignored ] && trap '' PIPE; fill; find victim -printf x -fprintf copy y -delete >&3; printf 'find-out:%s:%s ' "$?" "$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"  rm -f copy; printf 'x\n' > input"#,
		r#"  ( [ "$disp" = ignored ] && trap '' PIPE; fill; sed -n $'w copy\np' input >&3; printf 'sed-out:%s:%s ' "$?" "$(wc -c < copy)" ) 3> >(true) 2>/dev/null"#,
		r#"  echo"#,
		r#"done"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"sed:141:2 find:141:hashed sed:141:0 find:141:hashed find-out:141:1 sed-out:141:2 \n",
			"sed:4:2 find:1:hashed sed:4:2 find:1:hashed find-out:1:1 sed-out:4:2 \n",
		)
	);
}

/// `sort --compress-program` ends as GNU sort does: its own write to a
/// compressor that died raises SIGPIPE in it (141; with SIGPIPE ignored a
/// write error, 2), a compressor a signal killed is "terminated abnormally"
/// (2), and its diagnostic to a dead standard error kills it (141).
/// Measured against coreutils 9.4 under Bash 5.2.21 (`status:marker:rows`).
/// Regression: a compressor a signal killed counted as success, and sort
/// reported empty output with status 0.
#[tokio::test(flavor = "multi_thread")]
async fn sort_ends_at_its_compressors_death_as_gnu_sort_does() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"printf '#!/bin/sh\nset -e\nIFS= read -r first || exit 0\nprintf "compress diagnostic\\n" >&2\nprintf x >> compress-survived\nprintf "%%s\\n" "$first"\nexec /bin/cat\n' > compressor"#,
		r#"printf '#!/bin/sh\ncat > /dev/null\nkill -TERM $$\n' > killed"#,
		r#"printf '#!/bin/sh\ncat > /dev/null\nprintf "diagnostic\\n" >&2\nsleep 1\nprintf x > reads-all-survived\n' > reads-all"#,
		r#"chmod +x compressor killed reads-all"#,
		r#"seq 3000 -1 1 > numbers"#,
		r#"for disp in default ignored; do"#,
		r#"  rm -f compress-survived"#,
		r#"  ( [ "$disp" = ignored ] && trap '' PIPE; fill; sort -S 1K --parallel=1 --compress-program="$PWD/compressor" numbers 2>&3 > sorted; s=$?"#,
		r#"    m=no; [ -s compress-survived ] && m=yes; printf 'dead:%s:%s:%s ' "$s" "$m" "$(wc -l < sorted)" ) 3> >(true) 2>/dev/null"#,
		r#"  ( [ "$disp" = ignored ] && trap '' PIPE; sort -S 1K --parallel=1 --compress-program="$PWD/killed" numbers > sorted 2>/dev/null"#,
		r#"    printf 'killed:%s:%s ' "$?" "$(wc -l < sorted)" ) 2>/dev/null"#,
		r#"  echo"#,
		r#"done"#,
		r#"rm -f reads-all-survived"#,
		r#"( fill; sort -S 1K --parallel=1 --compress-program="$PWD/reads-all" numbers 2>&3 > sorted; s=$?"#,
		r#"  m=no; [ -e reads-all-survived ] && m=yes; echo "reads-all:$s:$m" ) 3> >(true) 2>/dev/null"#,
		r#"sort -S 1K --parallel=1 --compress-program="$PWD/compressor" numbers 2>/dev/null > sorted; echo "live:$?:$(wc -l < sorted)""#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	assert_eq!(
		output,
		concat!(
			"dead:141:no:0 killed:2:0 \n",
			"dead:2:no:0 killed:2:0 \n",
			"reads-all:141:no\n",
			"live:0:3000\n"
		)
	);
}

/// A child a utility starts itself starts with the utility's SIGPIPE
/// disposition, as a forked child inherits its parent's: `sort`'s compressor
/// the shell's, rsync's remote shell ignored (rsync ignores SIGPIPE). Each
/// child records its own from `/proc`. Measured against coreutils 9.4 and
/// rsync 3.5.1 under Bash 5.2.21. Regression: every child started with the
/// default action. The rsync half needs an `rsync` on `PATH` for the server
/// side.
#[tokio::test(flavor = "multi_thread")]
async fn children_start_with_the_utilitys_sigpipe_disposition() {
	let (exit_code, output) = run_in_tempdir(&[
		r#"d=$PWD"#,
		r#"printf '#!/bin/sh\nset -- $(grep SigIgn /proc/$$/status)\ncase $((0x$2 & 0x1000)) in 0) echo dfl ;; *) echo ign ;; esac > "$0.disp"\nexec /bin/cat\n' > compressor"#,
		r#"printf '#!/bin/sh\nset -- $(grep SigIgn /proc/$$/status) "$@"\ncase $((0x$2 & 0x1000)) in 0) echo dfl ;; *) echo ign ;; esac > "%s/rsh.disp"\nshift 3\nexec "$@"\n' "$d" > rsh.sh"#,
		r#"chmod +x compressor rsh.sh"#,
		r#"seq 3000 -1 1 > numbers"#,
		r#"mkdir src; printf 'x\n' > src/f"#,
		r#"for disp in default ignored; do"#,
		r#"  rm -f compressor.disp rsh.disp; rm -rf dst"#,
		r#"  ( [ "$disp" = ignored ] && trap '' PIPE"#,
		r#"    sort -S 1K --parallel=1 --compress-program="$PWD/compressor" numbers > sorted 2>/dev/null"#,
		r#"    rsync -a -e "$d/rsh.sh" "localhost:$d/src/" dst/ > /dev/null 2>&1"#,
		r#"    printf '%s:%s ' "$(cat compressor.disp 2>/dev/null)" "$(cat rsh.disp 2>/dev/null)" )"#,
		r#"done; echo"#,
	])
	.await;
	assert_eq!(exit_code, Some(0), "{output}");
	let rsync_on_path = std::env::var_os("PATH")
		.is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join("rsync").is_file()));
	let expected = if rsync_on_path {
		"dfl:ign ign:ign \n"
	} else {
		"dfl: ign: \n"
	};
	assert_eq!(output, expected);
}

/// A child whose standard error is the command's provider-backed file over
/// a pipe with no reader cannot fail its own write there: its diagnostic
/// goes to a pipe the shell drains, and the child is sent SIGPIPE once that
/// delivery fails, before it goes on (here a compressor that writes a
/// diagnostic, sleeps, then leaves a marker); `sort` then dies at its own
/// message, as with a dead descriptor (measured against coreutils 9.4 under
/// Bash 5.2.21: 141, no marker). Regression: the child's write succeeded and
/// it left its marker.
#[tokio::test(flavor = "multi_thread")]
async fn a_child_is_killed_when_its_provider_stderr_has_no_reader() {
	use brush_core::openfiles::{OpenFile, OpenFiles};

	let (code, dir) = run_on_provider_fds(
		concat!(
			r#"printf '#!/bin/sh\ncat > /dev/null\nprintf "diagnostic\\n" >&2\nsleep 1\nprintf x > reads-all-survived\n' > reads-all; "#,
			r#"chmod +x reads-all; seq 3000 -1 1 > numbers; "#,
			r#"sort -S 1K --parallel=1 --compress-program="$PWD/reads-all" numbers > sorted; echo "$?" > status"#,
		),
		vec![
			(OpenFiles::STDOUT_FD, OpenFile::from(tempfile::tempfile().expect("stdout"))),
			(OpenFiles::STDERR_FD, OpenFile::from(dead_provider_pipe())),
		],
	)
	.await;
	assert_eq!(code, 0);
	let status = std::fs::read_to_string(dir.path().join("status")).expect("status");
	assert_eq!(status, "141\n");
	assert!(!dir.path().join("reads-all-survived").exists(), "the compressor went on");
}
