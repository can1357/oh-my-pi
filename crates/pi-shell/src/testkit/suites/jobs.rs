//! Job control (`set -m`): job states, current/previous jobs, job specs,
//! `fg`/`bg`/`wait`/`kill` on jobs, `jobs -x`, command substitutions and
//! the `SIGCHLD` trap. Goldens from bash 5.3.20 (`bash -c`); where bash
//! learns of a stop asynchronously its run had a short `sleep` after the
//! `kill -STOP`, which the engine does not need.

use crate::testkit::{FakeHost, Fault, run_script};

fn run(src: &str) -> (String, String, i32) {
	let out = run_script(FakeHost::new(), src.as_bytes(), &[], Fault::None);
	(
		String::from_utf8_lossy(&out.stdout).into_owned(),
		String::from_utf8_lossy(&out.stderr).into_owned(),
		out.status,
	)
}

const LOOP: &str = "while :; do\n    :;\ndone";

#[test]
fn wait_returns_when_a_job_stops_and_fg_resumes_it() {
	let (out, err, _) = run(
		"set -m; { kill -STOP $BASHPID; exit 7; } & wait %1; kill -l $?; jobs; fg %1; echo $?; \
		 jobs; echo end",
	);
	assert_eq!(
		out,
		"STOP\n[1]+  Stopped                    { kill -STOP $BASHPID; exit 7; }\n{ kill -STOP \
		 $BASHPID; exit 7; }\n7\nend\n"
	);
	assert_eq!(err, "");
}

#[test]
fn stops_and_continues_move_the_current_and_previous_jobs() {
	let (out, ..) = run(
		"set -m; while :; do :; done & while :; do :; done & while :; do :; done & kill -STOP %2; \
		 jobs; echo r; jobs -r; echo s; jobs -s; kill -CONT %2; jobs; kill -STOP %3; bg %3; jobs %+ \
		 %-; jobs -n; echo n; exec 2>/dev/null; kill -9 %1 %2 %3; wait; echo $?; jobs; echo end",
	);
	let running = |n: u32, mark: char| format!("[{n}]{mark}  Running                    {LOOP} &\n");
	let want = [
		running(1, ' '),
		format!("[2]+  Stopped                    {LOOP}\n"),
		running(3, '-'),
		"r\n".into(),
		running(1, ' '),
		running(3, '-'),
		"s\n".into(),
		format!("[2]+  Stopped                    {LOOP}\n"),
		// `kill -CONT` of a stopped job keeps it current (bash `kill_pid`).
		running(1, ' '),
		running(2, '+'),
		running(3, '-'),
		format!("[3]+ {LOOP} &\n"),
		running(3, '+'),
		running(2, '-'),
		// `wait` collects the jobs just killed (bash's `wait` finds them still
		// being reaped: jobs.right, Linux).
		"n\n0\nend\n".into(),
	]
	.concat();
	assert_eq!(out, want);
}

#[test]
fn job_specs_by_name_and_their_errors() {
	let (out, err, _) = run(
		"set -m; while :; do :; done & until false; do :; done & jobs %wh; jobs %?until; jobs %?o; \
		 echo $?; jobs %% %-; disown -h @12; echo $?; fg -s; echo $?; bg %1; echo $?; jobs -q; echo \
		 $?; fg %3; echo $?; exec 2>/dev/null; kill -9 %1 %2; wait; echo end",
	);
	let until = "until false; do\n    :;\ndone";
	assert_eq!(
		out,
		format!(
			"[1]-  Running                    {LOOP} &\n[2]+  Running                    {until} \
			 &\n1\n[2]+  Running                    {until} &\n[1]-  Running                    \
			 {LOOP} &\n1\n2\n0\n2\n1\nend\n"
		)
	);
	assert_eq!(
		err,
		"bash: line 1: jobs: o: ambiguous job spec\nbash: line 1: jobs: %?o: no such job\nbash: \
		 line 1: disown: warning: @12: job specification requires leading `%'\nbash: line 1: \
		 disown: @12: no such job\nbash: line 1: fg: -s: invalid option\nfg: usage: fg \
		 [job_spec]\nbash: line 1: bg: job 1 already in background\nbash: line 1: jobs: -q: invalid \
		 option\njobs: usage: jobs [-lnprs] [jobspec ...] or jobs -x command [args]\nbash: line 1: \
		 fg: %3: no such job\n"
	);
}

#[test]
fn wait_operand_errors_and_the_p_variable() {
	let (out, err, _) = run(
		"wait %1; echo $?; wait 1-1; echo $?; wait -- -4; echo $?; wait 12345; echo $?; wait -p \
		 invalid-varname; echo $?; readonly WV; wait -p WV; echo $?; x=1; wait -p x; echo $?; \
		 declare -p x",
	);
	assert_eq!(out, "127\n1\n1\n127\n1\n1\n0\n");
	assert_eq!(
		err,
		"bash: line 1: wait: %1: no such job\nbash: line 1: wait: `1-1': not a pid or valid job \
		 spec\nbash: line 1: wait: `-4': not a pid or valid job spec\nbash: line 1: wait: pid 12345 \
		 is not a child of this shell\nbash: line 1: wait: `invalid-varname': not a valid \
		 identifier\nbash: line 1: wait: WV: cannot unset: readonly variable\nbash: line 1: \
		 declare: x: not found\n"
	);
}

#[test]
fn a_trapped_signal_ends_wait_with_128_plus_n() {
	let (out, ..) = run(
		"trap 'echo got USR1' USR1; while :; do :; done & p=$!; { kill -USR1 $$; } & wait $p; kill \
		 -l $?; kill -9 $p; wait $p; echo $?",
	);
	assert_eq!(out, "got USR1\nUSR1\n137\n");
}

#[test]
fn the_chld_trap_runs_once_per_finished_child() {
	let (out, ..) = run(
		"set -m; trap 'echo CHLD' CHLD; { :; } & wait; (exit 0) & (:) & wait; echo x; (:); echo y; \
		 trap - CHLD; (:) & wait; echo end",
	);
	assert_eq!(out, "CHLD\nCHLD\nCHLD\nx\nCHLD\ny\nend\n");
}

#[test]
fn command_substitutions_list_the_parents_jobs_but_cannot_move_them() {
	let (out, err, _) = run(
		"set -m; while :; do :; done & p=$!; [ \"$(jobs -x echo %1)\" = \"$p\" ] && echo same; jobs \
		 -l -x echo; echo $?; echo $(jobs); echo $(fg %% ; echo $?; jobs); jobs | while IFS= read \
		 -r l; do echo \"<$l>\"; done; ( jobs; fg; echo $? ); kill -9 %1; wait; echo end",
	);
	assert_eq!(
		out,
		"same\n1\n[1]+ Running while :; do :; done &\n1 [1]+ Running while :; do :; done &\n<[1]+  \
		 Running                    while :; do>\n<    :;>\n<done &>\n1\nend\n"
	);
	assert_eq!(
		err,
		"bash: line 1: jobs: no other options allowed with `-x'\nbash: line 1: fg: no current \
		 jobs\nbash: line 1: fg: no job control\n"
	);
}

#[test]
fn suspend_needs_job_control_outside_subshells() {
	let (out, err, _) = run("suspend -z; echo $?; suspend; echo $?; set -m; ( suspend; echo $? )");
	assert_eq!(out, "2\n1\n1\n");
	assert_eq!(
		err,
		"bash: line 1: suspend: -z: invalid option\nsuspend: usage: suspend [-f]\nbash: line 1: \
		 suspend: cannot suspend: no job control\nbash: line 1: suspend: cannot suspend: no job \
		 control\n"
	);
}

#[test]
fn reported_and_waited_jobs_leave_the_table() {
	// `jobs -n` reports a finished job once and forgets it; `wait` keeps
	// the `$!` job that finished before it.
	let (out, ..) = run(
		"set -m; { exit 5; } & (:); jobs -n; jobs -n; echo x; jobs; { :; } & (:); wait; jobs; echo b",
	);
	assert_eq!(
		out,
		"[1]+  Exit 5                     { exit 5; }\nx\n[1]+  Done                       { :; \
		 }\nb\n"
	);
}

#[test]
fn a_process_substitution_sets_the_last_background_pid() {
	let (out, ..) = run("read x < <(exit 123); wait $!; echo $?");
	assert_eq!(out, "123\n");
}
