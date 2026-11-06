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

/// Bash `wait_builtin` resolves each operand after the previous wait's
/// `wait_for` cleanup: a job spec cannot fall back to a deleted job's pid.
#[tokio::test(flavor = "multi_thread")]
async fn later_wait_operands_resolve_after_earlier_waits() {
	assert_bash_outputs(&[
		(
			r#"f(){ return 3; }; g(){ return 7; }; f & a=$!; g & b=$!; wait "$a"; wait "$b" %1 2>/dev/null; echo status=$?"#,
			"status=127\n",
		),
		(
			r#"f(){ return 3; }; g(){ return 7; }; f & a=$!; g & b=$!; wait "$a"; wait -p w "$b" %1 2>/dev/null; echo status=$?:w=${w-unset}"#,
			"status=127:w=unset\n",
		),
		(
			r#"f(){ return 3; }; g(){ return 7; }; f & a=$!; g & b=$!; wait "$a"; wait %1 %2 2>/dev/null; echo status=$?"#,
			"status=7\n",
		),
		(
			r#"f(){ return 3; }; g(){ return 7; }; f & a=$!; g & b=$!; wait "$a"; wait "$b" "$a" 2>/dev/null; echo status=$?"#,
			"status=3\n",
		),
		(
			r#"f(){ return 3; }; g(){ return 7; }; f & a=$!; g & b=$!; wait "$a"; wait "$b"; wait "$b" %% 2>/dev/null; echo status=$?"#,
			"status=127\n",
		),
	])
	.await;
}

/// Bash `wait_for_background_pids` prunes completed process substitutions
/// before clearing `bgpids`, even if no explicit wait collected them.
/// For the immediate, still-running substitution, Bash 5.2.21 retains 23;
/// Bash 5.3 forgets it, as it does the substitutions already completed.
/// Conversely, when `$!` names a newer job, 5.3 does not wait for an
/// older running substitution (23 later); 5.2 forgets it (127 later).
#[tokio::test(flavor = "multi_thread")]
async fn operandless_wait_forgets_uncollected_process_substitutions() {
	assert_bash_outputs(&[
		(
			r#": < <(exit 23); p=$!; /bin/sleep .05; wait; wait "$p" 2>/dev/null; echo proc=$?"#,
			"proc=127\n",
		),
		(
			r#": < <(exit 23); p=$!; f(){ return 7; }; f & /bin/sleep .05; wait; wait "$p" 2>/dev/null; echo proc=$?"#,
			"proc=127\n",
		),
		(
			r#": > >(exit 23); p=$!; /bin/sleep .05; wait; wait "$p" 2>/dev/null; echo proc=$?"#,
			"proc=127\n",
		),
		(
			r#": < <(/bin/sleep .05; exit 23); p=$!; wait; wait "$p" 2>/dev/null; echo proc=$?"#,
			"proc=127\n",
		),
		(
			r#": < <(/bin/sleep .4; exit 23); p=$!; f(){ return 7; }; f & wait; wait "$p" 2>/dev/null; echo proc=$?"#,
			"proc=23\n",
		),
		(
			r#"shopt -s lastpipe; (exit 17) | { /bin/sleep .05; wait; echo all=$?; }; echo pipe=${PIPESTATUS[*]}"#,
			"all=0\npipe=17 0\n",
		),
	])
	.await;
}

/// A refused disown-marker write must not leave a completed proc with no
/// owner that survives a successful snapshot and restore. The store double
/// refuses only that write; all scheduling and snapshot operations are real.
#[test]
fn refused_disown_markers_do_not_leak_proc_records_through_restore() {
	use pi_shell::{
		bash::{
			Budget, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Script, StateStore, Step,
			StoreError, Vpid,
			store::{BlobSlot, Change, Key, Record, Table},
		},
		testkit::{FakeHost, fault::skeleton_init},
	};

	#[derive(Default)]
	struct RefuseDisown {
		inner:     MemStore,
		remaining: usize,
		refused:   usize,
	}
	impl StateStore for RefuseDisown {
		fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
			self.inner.get(key)
		}

		fn scan(
			&mut self,
			table: Table,
			f: &mut dyn FnMut(Key<'_>, &Record),
		) -> Result<(), StoreError> {
			self.inner.scan(table, f)
		}

		fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
			if self.remaining > 0
				&& matches!(
					&change,
					Change::Put(Key::Proc(_), Record::Proc { parent: Some(Vpid(0)), status: None })
				) {
				self.remaining -= 1;
				self.refused += 1;
				return Err(StoreError::Backend("disown marker refused".into()));
			}
			self.inner.apply(change)
		}

		fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
			self.inner.put_blob(slot, bytes)
		}

		fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
			self.inner.get_blob(slot)
		}

		fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
			self.inner.del_blob(slot)
		}

		fn epoch(&self) -> u64 {
			self.inner.epoch()
		}
	}
	fn run(
		shell: &mut pi_shell::bash::Shell,
		host: &mut FakeHost,
		store: &mut RefuseDisown,
		script: &str,
	) {
		let id = shell.submit(Script::command(script.as_bytes()));
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host, store }, Budget::default()) {
				Step::Done { run, .. } if run == id => return,
				Step::Yield | Step::Done { .. } => {},
				Step::Blocked => {
					host.fire_next_timer();
				},
				other => panic!("unexpected {other:?}"),
			}
		}
		panic!("script did not finish");
	}
	fn count(store: &mut dyn StateStore) -> usize {
		let mut count = 0;
		store
			.scan(Table::Proc, &mut |_, _| count += 1)
			.expect("scan procs");
		count
	}

	let engine = Engine::new(EngineConfig::default());
	let mut host = FakeHost::new();
	let mut store = RefuseDisown::default();
	let mut shell = pi_shell::bash::Shell::create(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		skeleton_init(&[]),
	)
	.expect("create");
	run(&mut shell, &mut host, &mut store, "f(){ :; }");
	for _ in 0..8 {
		store.remaining = 1;
		run(&mut shell, &mut host, &mut store, "f & disown");
	}
	let mut settled = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
			Step::Idle => {
				settled = true;
				break;
			},
			Step::Yield | Step::Done { .. } => {},
			other => panic!("unexpected settling {other:?}"),
		}
	}
	assert!(settled, "disowned children did not settle");
	assert_eq!(store.refused, 8, "every round reached the real marker write");
	let before = count(&mut store);
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.expect("snapshot");
	let after = count(&mut store);
	let image = store.inner.to_bytes();
	drop(shell);
	store.inner = MemStore::from_bytes(&image).expect("decode snapshot");
	let engine = Engine::new(EngineConfig::default());
	let (mut shell, _) = pi_shell::bash::Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("restore");
	run(&mut shell, &mut host, &mut store, "jobs; :");
	assert_eq!(
		(before, after, count(&mut store)),
		(0, 0, 0),
		"proc records before snapshot, after snapshot, after restore"
	);
}

/// A refused older marker must not resurrect a child after its newer
/// deletion, including when the deletion is retried by externalize.
#[test]
fn proc_retry_fault_reproduction_stays_deleted_after_each_restore() {
	use pi_shell::{
		bash::{
			Budget, Cx, Engine, EngineConfig, ExtError, MemStore, RestoreOpts, Script, StateStore,
			Step, StoreError, Vpid,
			store::{BlobSlot, Change, Key, KeyBuf, Record, Table},
		},
		testkit::{FakeHost, fault::skeleton_init},
	};
	#[derive(Default)]
	struct Refuse {
		inner:          MemStore,
		armed:          bool,
		saw_delete:     bool,
		deletions_left: usize,
		log:            Vec<String>,
	}
	impl StateStore for Refuse {
		fn get(&mut self, key: Key<'_>) -> Result<Option<&Record>, StoreError> {
			self.inner.get(key)
		}

		fn scan(
			&mut self,
			table: Table,
			f: &mut dyn FnMut(Key<'_>, &Record),
		) -> Result<(), StoreError> {
			self.inner.scan(table, f)
		}

		fn apply(&mut self, change: Change<'_>) -> Result<(), StoreError> {
			if self.armed {
				let marker = matches!(
					&change,
					Change::Put(Key::Proc(_), Record::Proc { parent: Some(Vpid(0)), status: None })
				);
				let deletion = matches!(&change, Change::Del(Key::Proc(_)));
				if deletion {
					self.saw_delete = true;
				}
				if (marker && !self.saw_delete) || (deletion && self.deletions_left > 0) {
					if deletion {
						self.deletions_left -= 1;
					}
					self.log.push(format!("REFUSED {change:?}"));
					return Err(StoreError::Backend("proc change refused".into()));
				}
				if marker || deletion {
					self.log.push(format!("ACCEPTED {change:?}"));
				}
			}
			self.inner.apply(change)
		}

		fn put_blob(&mut self, slot: BlobSlot, bytes: &[u8]) -> Result<(), StoreError> {
			self.inner.put_blob(slot, bytes)
		}

		fn get_blob(&mut self, slot: BlobSlot) -> Result<Option<Vec<u8>>, StoreError> {
			self.inner.get_blob(slot)
		}

		fn del_blob(&mut self, slot: BlobSlot) -> Result<(), StoreError> {
			self.inner.del_blob(slot)
		}

		fn epoch(&self) -> u64 {
			self.inner.epoch()
		}
	}
	fn records(store: &mut dyn StateStore, table: Table) -> Vec<(KeyBuf, Record)> {
		let mut records = Vec::new();
		store
			.scan(table, &mut |k, r| records.push((k.to_buf(), r.clone())))
			.unwrap();
		records.sort_unstable_by(|a, b| a.0.cmp(&b.0));
		records
	}
	let mut failures = Vec::new();
	for (name, armed, deletions_left, external_refusal) in [
		("healthy backend", false, 0, false),
		("arm reproduction", true, 3, false),
		("repeated refusals through externalize", true, usize::MAX, true),
	] {
		let engine = Engine::new(EngineConfig::default());
		let mut host = FakeHost::new();
		let mut store = Refuse::default();
		let mut shell = pi_shell::bash::Shell::create(
			&engine,
			&mut Cx { host: &mut host, store: &mut store },
			skeleton_init(&[]),
		)
		.unwrap();
		store.armed = armed;
		store.deletions_left = deletions_left;
		shell.submit(Script::command(b"f(){ :; }; f & disown".as_slice()));
		let mut idle = false;
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()) {
				Step::Idle => {
					idle = true;
					break;
				},
				Step::Yield | Step::Done { .. } => {},
				Step::Blocked => {
					host.fire_next_timer();
				},
				other => panic!("{name}: unexpected {other:?}"),
			}
		}
		assert!(idle, "{name}: children must finish");
		if armed {
			assert!(store.saw_delete, "{name}: the child deletion must reach the backend");
		}
		if external_refusal {
			let before = store.log.len();
			let result = shell.externalize(&mut Cx { host: &mut host, store: &mut store });
			println!("{name}: refused externalize={result:?}");
			if result.is_ok() || store.log.len() == before {
				failures.push(format!("{name}: externalize lost the pending refused deletion"));
			}
		}
		println!("{name}: {}", store.log.join("\n"));
		store.armed = false;
		if armed && !external_refusal {
			// The final refused step's fault is reported once, even when
			// this call's retry succeeds on the now-healthy backend.
			let recovery = shell.externalize(&mut Cx { host: &mut host, store: &mut store });
			println!("{name}: retained refusal={recovery:?}");
			if !matches!(recovery, Err(ExtError::Store(_))) {
				failures.push(format!("{name}: the final refusal was not reported"));
			}
		}
		for snapshot in 1..=2 {
			let external = shell
				.externalize(&mut Cx { host: &mut host, store: &mut store })
				.unwrap();
			assert!(external.lost.is_empty());
			let second = shell
				.externalize(&mut Cx { host: &mut host, store: &mut store })
				.unwrap();
			assert!(second.lost.is_empty());
			println!("{name} snapshot {snapshot}: second_externalize={second:?}");
			let image = store.inner.to_bytes();
			drop(shell);
			store.inner = MemStore::from_bytes(&image).unwrap();
			let (restored, report) = pi_shell::bash::Shell::restore(
				&engine,
				&mut Cx { host: &mut host, store: &mut store },
				RestoreOpts::default(),
			)
			.unwrap();
			shell = restored;
			let procs = records(&mut store, Table::Proc);
			let jobs = records(&mut store, Table::Job);
			println!(
				"{name} snapshot {snapshot}: externalize={external:?} restore={report:?} \
				 procs={procs:?} jobs={jobs:?}"
			);
			assert_eq!((report.vprocs, report.runs), (1, 0));
			assert!(report.lost.is_empty() && report.abandoned.is_empty());
			if !procs.is_empty() || !jobs.is_empty() {
				failures.push(format!(
					"{name} snapshot {snapshot}: shell owns no children, procs={procs:?} jobs={jobs:?}"
				));
			}
		}
	}
	assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn wait_operand_order_survives_snapshot_restore() {
	use std::sync::Arc;

	use bstr::BString;
	use pi_shell::{
		bash::{Budget, CallOutcome, Cx, Script, ShellApi, Step},
		testkit::{
			FakeHost,
			fault::{Rig, skeleton_init},
		},
	};

	let mut host = FakeHost::new();
	host.tool("hold", Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
	let mut rig = Rig::new(host, skeleton_init(&[]));
	let (run, call) = {
		let (shell, host, store) = rig.parts();
		let run = shell.submit(Script::command(
			br#"f(){ return 3; }; g(){ hold; return 7; }; f & a=$!; g & b=$!; wait "$a"; wait "$b" %1; echo status=$?"#.as_slice(),
		));
		let mut call = None;
		let mut blocked = false;
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host, store }, Budget::default()) {
				Step::Call { id, .. } => {
					assert!(call.is_none());
					call = Some(id);
				},
				Step::Blocked => {
					blocked = true;
					break;
				},
				Step::Yield | Step::Done { .. } => {},
				other => panic!("unexpected {other:?}"),
			}
		}
		assert!(blocked, "the wait must be in flight at the snapshot");
		(run, call.expect("held call"))
	};
	rig.snapshot();
	let (shell, host, store) = rig.parts();
	shell.complete(call, CallOutcome::Exit(0));
	let mut done = false;
	for _ in 0..10_000 {
		match shell.step(&mut Cx { host, store }, Budget::default()) {
			Step::Done { run: r, status } if r == run => {
				assert_eq!(status, 0);
				done = true;
				break;
			},
			Step::Yield | Step::Done { .. } => {},
			other => panic!("unexpected resume {other:?}"),
		}
	}
	assert!(done, "restored wait must finish");
	assert_eq!(host.stdout.bytes(), b"status=127\n");
}

/// A version-29 wait image restores and re-snapshots within one engine build.
#[test]
fn version_29_wait_image_restores_within_one_build_identity() {
	use pi_shell::{
		bash::{
			Budget, Cx, Engine, EngineConfig, MemStore, RestoreOpts, Shell, StateStore, Step,
			store::{BlobSlot, KeyBuf, Record, Table},
		},
		testkit::FakeHost,
	};
	const IMAGE: &[u8] = include_bytes!("fixtures/frames/upstream-v29-parent-wait.image");
	fn records(store: &mut MemStore) -> Vec<(KeyBuf, Record)> {
		let mut records = Vec::new();
		for table in [
			Table::Var,
			Table::Func,
			Table::Alias,
			Table::Opt,
			Table::Trap,
			Table::Job,
			Table::Proc,
			Table::DirStack,
			Table::CmdHash,
			Table::Misc,
			Table::Scope,
			Table::Local,
			Table::ZshOpt,
			Table::ZshAlias,
		] {
			store
				.scan(table, &mut |key, value| records.push((key.to_buf(), value.clone())))
				.expect("records");
		}
		records.sort_unstable_by(|a, b| a.0.cmp(&b.0));
		records
	}
	let mut store = MemStore::from_bytes(IMAGE).expect("same-build store image");
	// Written by upstream main b0b02d1120976535f466b282739c25775f991830.
	// Keep its engine identity and the complete store unchanged.
	let blob = store.get_blob(BlobSlot::Frames).unwrap().unwrap();
	let ((_, _, _, build), _) =
		postcard::take_from_bytes::<([u8; 4], u32, u32, [u8; 32])>(&blob).unwrap();
	assert_eq!(build, Engine::build_id(), "fixture must use this engine build");
	let before = records(&mut store);
	let mut host = FakeHost::new();
	let engine = Engine::new(EngineConfig::default());
	let (mut shell, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("same-build image must restore without dropping frames");
	assert_eq!((report.vprocs, report.runs), (2, 1));
	assert!(report.lost.is_empty(), "restore lost {:?}", report.lost);
	assert!(report.abandoned.is_empty(), "restore abandoned {:?}", report.abandoned);
	assert_eq!(records(&mut store), before, "restore must preserve all session records");
	shell.control().request_suspend();
	assert!(matches!(
		shell.step(&mut Cx { host: &mut host, store: &mut store }, Budget::default()),
		Step::SuspendReady
	));
	shell
		.externalize(&mut Cx { host: &mut host, store: &mut store })
		.expect("resnapshot restored wait");
	let image = store.to_bytes();
	drop(shell);
	let engine = Engine::new(EngineConfig::default());
	let mut store = MemStore::from_bytes(&image).expect("new image");
	let (_, report) = Shell::restore(
		&engine,
		&mut Cx { host: &mut host, store: &mut store },
		RestoreOpts::default(),
	)
	.expect("restore resnapshot");
	assert_eq!((report.vprocs, report.runs), (2, 1));
	assert!(report.lost.is_empty());
	assert!(report.abandoned.is_empty());
}

/// A snapshot keeps statuses already retained by the root or a subshell,
/// including the wait bookkeeping that decides when those statuses go away.
#[test]
fn retained_statuses_and_wait_cleanup_survive_snapshot_restore() {
	use pi_shell::{
		bash::Script,
		testkit::{
			FakeHost,
			fault::{Fault, Rig, skeleton_init},
		},
	};
	for (name, script, expected) in [
		(
			"root retained status",
			r#"f(){ return 23; }; f & p=$!; wait "$p"; jobs; wait "$p"; echo kept=$?; wait; wait "$p" 2>/dev/null; echo forgotten=$?"#,
			"kept=23\nforgotten=127\n",
		),
		(
			"subshell retained status",
			r#"( f(){ return 23; }; f & p=$!; wait "$p"; jobs; wait "$p"; echo kept=$?; wait; wait "$p" 2>/dev/null; echo forgotten=$? )"#,
			"kept=23\nforgotten=127\n",
		),
	] {
		let mut rig = Rig::new(FakeHost::new(), skeleton_init(&[]));
		assert_eq!(
			rig.run(Script::command(script.as_bytes()), Fault::Snapshot { every: 1 }),
			0,
			"{name}"
		);
		assert_eq!(rig.host.stdout.bytes(), expected.as_bytes(), "{name}");
	}
}

#[test]
fn pending_wait_kinds_keep_their_cleanup_rules_across_restore() {
	use std::sync::Arc;

	use bstr::BString;
	use pi_shell::{
		bash::{Budget, CallId, CallOutcome, Cx, Script, ShellApi, Step},
		testkit::{
			FakeHost,
			fault::{Rig, skeleton_init},
		},
	};

	fn blocked(rig: &mut Rig) -> Vec<(BString, CallId)> {
		let mut calls = Vec::new();
		let (shell, host, store) = rig.parts();
		for _ in 0..10_000 {
			match shell.step(&mut Cx { host, store }, Budget::default()) {
				Step::Call { id, call } => calls.push((call.argv[0].clone(), id)),
				Step::Blocked => return calls,
				Step::Yield => {},
				other => panic!("unexpected before wait snapshot: {other:?}"),
			}
		}
		panic!("host calls must leave the shell blocked");
	}

	for (name, script, expected) in [
		(
			"operandless wait keeps its already-observed bang child",
			r#"f(){ child; return 23; }; f & p=$!; parent; wait; wait "$p"; echo kept=$?"#,
			"kept=23\n",
		),
		(
			"wait -n includes a reported job after it wakes",
			r#"f(){ return 3; }; g(){ child; return 7; }; f & a=$!; g & b=$!; wait "$a"; wait -n "$a" "$b"; echo first=$?; wait "$a"; echo kept=$?; wait "$b"; :"#,
			"first=3\nkept=3\n",
		),
		(
			"fg does not retain its child's status",
			r#"set -m; f(){ child; return 23; }; f & p=$!; fg %1; echo first=$?; wait "$p" 2>/dev/null; echo forgotten=$?"#,
			"f\nfirst=23\nforgotten=127\n",
		),
	] {
		let mut host = FakeHost::new();
		for tool in ["child", "parent"] {
			host.tool(tool, Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| CallOutcome::Exit(0)));
		}
		let mut rig = Rig::new(host, skeleton_init(&[]));
		let run = rig.shell().submit(Script::command(script.as_bytes()));
		let calls = blocked(&mut rig);
		let child = calls
			.iter()
			.find(|(name, _)| name.as_slice() == b"child")
			.unwrap()
			.1;
		if let Some((_, parent)) = calls.iter().find(|(name, _)| name.as_slice() == b"parent") {
			// The child ends while its parent is blocked on a different
			// call, so the shell has observed its `$!` child finish.
			rig.shell().complete(child, CallOutcome::Exit(0));
			assert!(blocked(&mut rig).is_empty());
			rig.snapshot();
			rig.shell().complete(*parent, CallOutcome::Exit(0));
		} else {
			rig.snapshot();
			rig.shell().complete(child, CallOutcome::Exit(0));
		}
		let mut done = false;
		for _ in 0..10_000 {
			let (shell, host, store) = rig.parts();
			match shell.step(&mut Cx { host, store }, Budget { max_ops: 1, max_ns: u64::MAX }) {
				Step::Done { run: r, status } if r == run => {
					assert_eq!(status, 0, "{name}");
					done = true;
					break;
				},
				Step::Yield => rig.snapshot(),
				other => panic!("{name}: unexpected restored wait: {other:?}"),
			}
		}
		assert!(done, "{name}: restored wait must finish");
		assert_eq!(rig.host.stdout.bytes(), expected.as_bytes(), "{name}");
	}
}
