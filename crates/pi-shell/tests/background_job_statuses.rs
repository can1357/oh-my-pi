//! Job control after a background job ends, as Bash 5.3 runs a script
//! (Bash 5.2.21 agrees on every row unless a test says otherwise): a job
//! `wait` reported stays in the table until the shell next forks or runs
//! `jobs`, and the status of a job that left the table is kept for
//! `wait PID` (bash's `bgpids`) until `wait` without operands or
//! `disown -a` forgets it. `$!` is the same in every subshell.
#![cfg(unix)]

use pi_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// Runs each script in a fresh shell and asserts Bash's output and exit
/// status 0, reporting every row that differs.
async fn assert_bash_outputs(rows: &[(&str, &str)]) {
	let mut mismatches = Vec::new();
	for &(script, bash_output) in rows {
		let (tx, rx) = flume::unbounded::<String>();
		let result = Shell::new(None)
			.run(
				ShellRunOptions { command: script.to_owned(), ..Default::default() },
				Some(tx),
				CancelToken::new(Some(20_000)),
			)
			.await
			.expect("run");
		let output: String = rx.drain().collect();
		if (result.exit_code, output.as_str()) != (Some(0), bash_output) {
			mismatches.push(format!(
				"`{script}`\n  bash: Some(0) {bash_output:?}\n  omp:  {:?} {output:?}",
				result.exit_code
			));
		}
	}
	assert!(
		mismatches.is_empty(),
		"{} of {} rows differ from bash:\n{}",
		mismatches.len(),
		rows.len(),
		mismatches.join("\n")
	);
}

/// A second `wait PID` gave 127 (`not a child`): the status went with the
/// first wait.
#[tokio::test(flavor = "multi_thread")]
async fn a_waited_pid_keeps_its_status() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 6; }; f & p=$!; wait "$p"; echo "first=$?"; wait "$p" 2>/dev/null; echo "second=$?""#,
			"first=6\nsecond=6\n",
		),
		(
			r#"f(){ return 6; }; f & p=$!; sleep 0.3; wait "$p"; echo "first=$?"; wait "$p" 2>/dev/null; echo "second=$?""#,
			"first=6\nsecond=6\n",
		),
		(
			r#"/bin/sh -c 'exit 6' & p=$!; wait "$p"; echo "first=$?"; wait "$p" 2>/dev/null; echo "second=$?""#,
			"first=6\nsecond=6\n",
		),
		(
			r#"/bin/sh -c 'exit 6' & p=$!; sleep 0.3; wait "$p"; echo "first=$?"; wait "$p" 2>/dev/null; echo "second=$?""#,
			"first=6\nsecond=6\n",
		),
		// Still kept after `jobs` deleted the job, and in a command
		// substitution, which copies the kept statuses.
		(
			r#"f(){ return 6; }; f & p=$!; wait "$p"; jobs; wait "$p"; echo "b=$?"; x=$(wait "$p"; echo $?); echo "x=$x""#,
			"b=6\nx=6\n",
		),
		// The last operand decides the status.
		(r#"f(){ return 6; }; f & p=$!; wait "$p"; wait 99999 "$p" 2>/dev/null; echo "b=$?""#, "b=6\n"),
		(r#"f(){ return 6; }; f & p=$!; wait "$p" 99999 2>/dev/null; echo "b=$?""#, "b=127\n"),
	])
	.await;
}

/// A job `wait` reported stays in the table, reported, until the shell
/// forks or runs `jobs`: `wait %1` again gave 127 and `%%` moved on.
/// Bash 5.2.21 under `-c` drops it at once (127 and `f=3`); in a script,
/// as here, both versions keep it.
#[tokio::test(flavor = "multi_thread")]
async fn a_waited_job_stays_until_the_next_fork() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 6; }; f & wait %1; echo "first=$?"; wait %1 2>/dev/null; echo "second=$?""#,
			"first=6\nsecond=6\n",
		),
		(
			r#"f(){ sleep 0.2; return 3; }; g(){ return 4; }; f & g & wait "$!"; echo "g=$?"; wait %%; echo "f=$?""#,
			"g=4\nf=4\n",
		),
		(r#"f(){ return 6; }; f & wait %1; true; wait %1; echo "b=$?""#, "b=6\n"),
		(r#"f(){ return 6; }; f & wait %1; x=$(:); wait %1 2>/dev/null; echo "b=$?""#, "b=127\n"),
		(r#"f(){ return 6; }; f & wait %1; ( : ); wait %1 2>/dev/null; echo "b=$?""#, "b=127\n"),
		(r#"f(){ return 6; }; f & wait %1; /bin/true; wait %1 2>/dev/null; echo "b=$?""#, "b=127\n"),
		// A new job after the cleanup takes the first free number.
		(
			r#"f(){ return 6; }; f & wait %1; g(){ sleep 0.2; }; g & jobs; wait %2 2>/dev/null; echo "s=$?""#,
			"[1]+  Running                    g &\ns=127\n",
		),
		// `wait -n` deletes the job it reports, keeping its status.
		(
			r#"f(){ return 6; }; f & p=$!; wait -n; wait %1 2>/dev/null; echo "j=$?"; wait "$p"; echo "p=$?""#,
			"j=127\np=6\n",
		),
		// A job already waited for is no candidate for `wait -n`.
		(r#"f(){ return 6; }; f & p=$!; wait "$p"; wait -n; echo "b=$?""#, "b=127\n"),
		// Bash 5.3 answers `wait -n PID` from a kept status (5.2.21 says
		// `no such job`, 127).
		(
			r#"f(){ return 6; }; f & p=$!; wait "$p"; jobs; wait -n -p v "$p"; echo "b=$? v=$([ "$v" = "$p" ] && echo same)""#,
			"b=6 v=same\n",
		),
	])
	.await;
}

/// `wait` without operands forgets every kept status but `$!`'s when that
/// child had finished before the `wait`: an in-process job's status was
/// kept however it ended (6, where Bash gives 127).
#[tokio::test(flavor = "multi_thread")]
async fn wait_without_operands_forgets_kept_statuses() {
	assert_bash_outputs(&[
		(r#"f(){ return 6; }; f & p=$!; wait; wait "$p" 2>/dev/null; echo "status=$?""#, "status=127\n"),
		(r#"f(){ return 6; }; f & p=$!; sleep 0.1; wait; wait "$p"; echo "status=$?""#, "status=6\n"),
		(
			r#"f(){ return 6; }; g(){ return 7; }; f & p=$!; g & sleep 0.1; wait; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=127\n",
		),
	])
	.await;
}

/// `disown` of a running job keeps status 0 for `wait PID` (it waited for
/// the job and gave its 3); `disown -a` and `disown -r` keep none (they
/// waited too); `-r` leaves finished jobs' kept statuses (it lost them).
#[tokio::test(flavor = "multi_thread")]
async fn disown_keeps_bash_statuses() {
	assert_bash_outputs(&[
		(
			r#"f(){ sleep 0.2; return 3; }; f & p=$!; disown; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=0\n",
		),
		(
			r#"f(){ sleep 0.2; return 3; }; f & p=$!; disown "$p"; sleep 0.4; wait "$p"; echo "status=$?""#,
			"status=0\n",
		),
		(
			r#"f(){ return 3; }; f & p=$!; sleep 0.1; disown %1; wait "$p"; echo "status=$?""#,
			"status=3\n",
		),
		(
			r#"f(){ sleep 0.3; return 3; }; f & p=$!; disown -a; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=127\n",
		),
		(
			r#"f(){ sleep 0.3; return 3; }; f & p=$!; disown -r; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=127\n",
		),
		(
			r#"f(){ return 6; }; f & p=$!; wait "$p"; disown -r; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=6\n",
		),
		(
			r#"f(){ return 6; }; f & p=$!; wait "$p"; disown -a; wait "$p" 2>/dev/null; echo "status=$?""#,
			"status=127\n",
		),
	])
	.await;
}

/// `wait` without operands keeps the status of the job `$!` names only
/// when it had finished and nothing reported it: a status above 128 is an
/// ordinary exit status there (bash 5.3 also keeps a job this shell killed
/// earlier; 5.2.21 gives 127), and one `wait "$p"` or `jobs` already
/// reported is forgotten.
#[tokio::test(flavor = "multi_thread")]
async fn wait_without_operands_keeps_only_an_unreported_bang() {
	assert_bash_outputs(&[
		(r#"f(){ return 200; }; f & p=$!; /bin/sleep .15; wait; wait "$p" 2>/dev/null; echo status=$?"#, "status=200\n"),
		(r#"f(){ sleep 5; }; f & p=$!; /bin/sleep .1; kill "$p"; /bin/sleep .1; wait; wait "$p" 2>/dev/null; echo status=$?"#, "status=143\n"),
		(r#"f(){ return 6; }; f & p=$!; /bin/sleep .1; wait "$p"; jobs; wait; wait "$p" 2>/dev/null; echo status=$?"#, "status=127\n"),
	])
	.await;
}

/// After `wait` blocked, `wait -n` takes the first finished operand in
/// job order, reported or not; a failed external or an unknown command
/// forks in bash, so it deletes reported jobs; `wait` of a job cleans up
/// the jobs reported before it, so `%-` and `%%` no longer name them.
#[tokio::test(flavor = "multi_thread")]
async fn waits_and_forks_clean_up_as_bash_does() {
	assert_bash_outputs(&[
		(r#"f(){ return 3; }; g(){ sleep .3; return 7; }; f & a=$!; g & b=$!; /bin/sleep .1; wait "$a"; wait -n -p w "$a" "$b"; echo "status=$? w=$([ "$w" = "$a" ] && echo a || echo b)""#, "status=3 w=a\n"),
		(r"f(){ return 6; }; f & wait %1; /not/existing 2>/dev/null; wait %1 2>/dev/null; echo status=$?", "status=127\n"),
		(r"f(){ return 6; }; f & wait %1; nosuchcommand17678 2>/dev/null; wait %1 2>/dev/null; echo status=$?", "status=127\n"),
		(r#"f(){ sleep .1; return 3; }; g(){ sleep .3; return 7; }; f & a=$!; g & wait "$a"; wait %%; echo current=$?; wait %- 2>/dev/null; echo previous=$?; wait %% 2>/dev/null; echo current2=$?"#, "current=7\nprevious=127\ncurrent2=127\n"),
	])
	.await;
}

/// A process substitution stays waitable after `$!` names a later job; a
/// command substitution lists the running jobs and `$!`'s only; a job
/// disowned before `$!` was read still gets its program's OS pid.
#[tokio::test(flavor = "multi_thread")]
async fn children_keep_their_pids_and_statuses() {
	assert_bash_outputs(&[
		(r#"exec 3< <( /bin/sleep .05; exit 8 ); p=$!; f(){ return 6; }; f & q=$!; /bin/sleep .2; wait "$p" 2>/dev/null; echo procsub=$?; wait "$q"; echo job=$?; exec 3<&-"#, "procsub=8\njob=6\n"),
		(r"f(){ :; }; for ((i=0;i<50;i++)); do f & done; /bin/sleep .1; set -- $(jobs -p); echo jobs=$#; wait", "jobs=1\n"),
		(r#"/bin/sleep 0.3 & disown %1; p=$!; /bin/kill -0 "$p" 2>/dev/null && echo os-alive || echo gone"#, "os-alive\n"),
	])
	.await;
}

/// zsh keeps no status for a disowned job: `wait` of its pid is 127 (zsh
/// 5.9: `pid … is not a child of this shell`), not bash's 0.
#[tokio::test(flavor = "multi_thread")]
async fn zsh_disown_keeps_no_status() {
	assert_bash_outputs(&[(
		r"emulate zsh -c 'f(){ sleep .1; return 6; }; f & p=$!; disown; wait $p 2>/dev/null; echo status=$?'",
		"status=127\n",
	)])
	.await;
}

/// Failure modes the first review round found: one `wait` cleaned up a
/// later operand's job and then blocked on a child the shell no longer
/// had (it never returned), and `wait -n` of a process substitution
/// reported its status without keeping it for a later `wait PID`.
#[tokio::test(flavor = "multi_thread")]
async fn a_wait_operand_reads_the_status_its_own_cleanup_kept() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 3; }; g(){ return 7; }; f & a=$!; g & b=$!; wait "$a"; wait "$b" "$a"; echo status=$?"#,
			"status=3\n",
		),
		(
			r#"f(){ return 3; }; g(){ return 7; }; f & a=$!; g & b=$!; wait "$a"; wait "$a" "$b"; echo status=$?"#,
			"status=7\n",
		),
		(
			r#"exec 3< <(/bin/sleep .03; exit 23); a=$!; /bin/sleep .1; wait -n -p value "$a"; echo first=$?; wait "$a" 2>/dev/null; echo again=$?; exec 3<&-"#,
			"first=23\nagain=23\n",
		),
	])
	.await;
}

/// Failure modes the second review round found: an ordinary `wait` of a
/// process substitution dropped the status it had just collected (and a
/// second operand naming it then blocked for ever), and an invalid
/// trailing operand left `wait -p` naming the child of an earlier one.
#[tokio::test(flavor = "multi_thread")]
async fn a_non_job_child_keeps_its_status_and_a_failed_operand_names_none() {
	assert_bash_outputs(&[
		(
			r#"exec 3< <(/bin/sleep .03; exit 23); p=$!; /bin/sleep .1; wait "$p" 2>/dev/null; echo first=$?; wait "$p" 2>/dev/null; echo again=$?; exec 3<&-"#,
			"first=23\nagain=23\n",
		),
		(
			r#"exec 3< <(/bin/sleep .02; exit 23); p=$!; f(){ return 7; }; f & q=$!; wait "$p" "$q" "$p" 2>/dev/null; echo status=$?; exec 3<&-"#,
			"status=23\n",
		),
		(
			r#"f(){ return 23; }; f & p=$!; wait -p w "$p" 99999999 2>/dev/null; s=$?; [ "${w-unset}" = "$p" ] && w=same; echo "status=$s:w=${w-unset}""#,
			"status=127:w=unset\n",
		),
	])
	.await;
}

/// A malformed numeric operand stops the operand loop, not the waits
/// already requested; later operands are not waited for, and `-p` names
/// no child even when an earlier operand completed.
#[tokio::test(flavor = "multi_thread")]
async fn a_malformed_pid_waits_for_earlier_operands_only() {
	assert_bash_outputs(&[
		(
			r#"d=$(mktemp -d); cd "$d"; f(){ /bin/sleep .15; echo child > child; return 23; }; f & p=$!; wait -p w "$p" 1x 2>/dev/null; s=$?; echo status=$s:w=${w-unset}; if [ -f child ]; then echo file=yes; else echo file=no; fi; wait "$p"; echo again=$?; cd /; /bin/rm -r "$d""#,
			"status=1:w=unset\nfile=yes\nagain=23\n",
		),
		(
			r#"d=$(mktemp -d); cd "$d"; f(){ /bin/sleep .1; echo child > before; return 23; }; g(){ /bin/sleep .6; echo child > after; return 29; }; f & p=$!; g & q=$!; wait -p w "$p" 1x "$q" 2>/dev/null; s=$?; echo status=$s:w=${w-unset}; if [ -f before ]; then echo before=yes; else echo before=no; fi; if [ -f after ]; then echo after=yes; else echo after=no; fi; wait "$p"; echo p=$?; wait "$q"; echo q=$?; cd /; /bin/rm -r "$d""#,
			"status=1:w=unset\nbefore=yes\nafter=no\np=23\nq=29\n",
		),
		(
			r#"d=$(mktemp -d); cd "$d"; f(){ /bin/sleep .15; echo child > child; return 23; }; f & p=$!; wait -p w 1x "$p" 2>/dev/null; s=$?; echo status=$s:w=${w-unset}; if [ -f child ]; then echo file=yes; else echo file=no; fi; wait "$p"; echo again=$?; cd /; /bin/rm -r "$d""#,
			"status=1:w=unset\nfile=no\nagain=23\n",
		),
	])
	.await;
}

/// `$!` already names an input process substitution before its first
/// scheduler turn: ordinary, duplicate and `-n` operands must find it.
/// Bash 5.2.21 gives 127 for these `-n` operands; Bash 5.3 keeps their
/// statuses and supplies the child's pid through `-p`.
#[tokio::test(flavor = "multi_thread")]
async fn an_immediate_wait_finds_a_process_substitution() {
	assert_bash_outputs(&[
		(
			r#": < <(/bin/sleep .05; exit 23); p=$!; wait "$p" 2>/dev/null; echo first=$?; wait "$p" 2>/dev/null; echo second=$?"#,
			"first=23\nsecond=23\n",
		),
		(
			r#": < <(/bin/sleep .05; exit 23); p=$!; wait -n -p w "$p" 2>/dev/null; s=$?; [ "${w-unset}" = "$p" ] && w=same; echo status=$s:w=${w-unset}; wait "$p" 2>/dev/null; echo again=$?"#,
			"status=23:w=same\nagain=23\n",
		),
		(
			r#"exec 3< <(/bin/sleep .02; exit 23); p=$!; wait "$p" "$p" 2>/dev/null; echo status=$?; wait -n -p w "$p" 2>/dev/null; s=$?; [ "${w-unset}" = "$p" ] && w=same; echo status=$s:w=${w-unset}; exec 3<&-"#,
			"status=23\nstatus=23:w=same\n",
		),
	])
	.await;
}
