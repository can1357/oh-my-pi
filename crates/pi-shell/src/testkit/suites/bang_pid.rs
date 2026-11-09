//! A background job that is just one external program is known by that
//! program's OS pid, as in bash (whose subshell `exec`s it): `$!`, `jobs
//! -l`/`-p`/`-x` show it, and `kill`, `wait`, `wait -n -p` and `disown`
//! take it. Compound jobs keep their virtual pids. A signal to such a job
//! (or to a pipeline job's stages) reaches the program, which may trap it,
//! and the job ends with the program's real status once it exited. A lone
//! external's redirection whose open would wait (a FIFO) is left to the
//! process when the host allows it (`Host::child_opens`), so `$!` never
//! waits on that rendezvous. References: bash 5.3.20 (`bash -c`).

use std::{
	io,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
	task::{Context, Poll, Waker},
};

use bstr::BString;
use parking_lot::Mutex;

use crate::{
	bash::{
		Budget, CallId, CallOutcome, ChildRedir, ChildRedirs, Cx, ExitStatus, ExtProc, Lineage,
		OpenFlags, RunId, Script, ShellApi, Signal, SpawnSpec, Step, Vpid,
	},
	testkit::{FakeHost, Fault, MemFs, Rig, fault::skeleton_init, run::wait_runnable, run_script},
};

/// First OS pid the fake spawner hands out.
const FIRST: u32 = 5001;

/// Every redirection list a spawn was handed, by argv[0].
type RedirLog = Arc<Mutex<Vec<(BString, Option<ChildRedirs>)>>>;

/// What the fake externals saw: every signal delivered, by pid, and the
/// redirections each spawn left to its process.
#[derive(Clone, Default)]
struct World {
	next:    Arc<AtomicU32>,
	signals: Arc<Mutex<Vec<(u32, Signal)>>>,
	redirs:  RedirLog,
}

impl World {
	fn new() -> Self {
		let w = Self::default();
		w.next.store(FIRST, Ordering::SeqCst);
		w
	}

	/// A host whose externals are fakes by name: `/x/true` exits 0 at once,
	/// `/x/trap42` and `/x/trap43` exit 42 or 43 on `TERM` (a trap), any
	/// other runs until a terminating signal kills it.
	fn host(&self) -> FakeHost {
		let world = self.clone();
		FakeHost::new().with_spawner(Box::new(move |spec: SpawnSpec<'_>| {
			let pid = world.next.fetch_add(1, Ordering::SeqCst);
			world
				.redirs
				.lock()
				.push((spec.argv[0].clone(), spec.redirs.clone()));
			let (status, trap) = match spec.argv[0].as_slice() {
				b"/x/true" => (Some(ExitStatus::Exited(0)), None),
				b"/x/trap42" => (None, Some(42)),
				b"/x/trap43" => (None, Some(43)),
				_ => (None, None),
			};
			let signals = Arc::clone(&world.signals);
			Ok(Box::new(Fake { pid, status, trap, signals, waker: None }) as Box<dyn ExtProc>)
		}))
	}

	/// The signals pid `pid` got.
	fn got(&self, pid: u32) -> Vec<Signal> {
		self
			.signals
			.lock()
			.iter()
			.filter(|(p, _)| *p == pid)
			.map(|(_, sig)| *sig)
			.collect()
	}
}

/// A fake external process.
struct Fake {
	pid:     u32,
	status:  Option<ExitStatus>,
	/// Exit status a `TERM` trap exits with.
	trap:    Option<i32>,
	signals: Arc<Mutex<Vec<(u32, Signal)>>>,
	waker:   Option<Waker>,
}

impl ExtProc for Fake {
	fn pid(&self) -> u32 {
		self.pid
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		if let Some(status) = self.status {
			Poll::Ready(status)
		} else {
			self.waker = Some(cx.waker().clone());
			Poll::Pending
		}
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		self.signals.lock().push((self.pid, sig));
		if matches!(sig, Signal::Term | Signal::Kill) && self.status.is_none() {
			self.status = Some(match self.trap {
				Some(code) if sig == Signal::Term => ExitStatus::Exited(code),
				_ => ExitStatus::Signaled(sig),
			});
			if let Some(waker) = self.waker.take() {
				waker.wake();
			}
		}
		Ok(())
	}

	fn stop(&mut self) -> io::Result<()> {
		Ok(())
	}

	fn cont(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// Run `src` on a fresh rig over `host`: its stdout and status.
fn run(host: FakeHost, src: &str) -> (String, i32) {
	let out = run_script(host, src.as_bytes(), &[], Fault::None);
	(String::from_utf8_lossy(&out.stdout).into_owned(), out.status)
}

/// Enough work for the shell's slices to let a pipeline job start its
/// stages' programs (a pipeline's `$!` does not wait for them).
const BUSY: &str = "n=0; while (( n < 3000 )); do n=$((n + 1)); done";

/// Whether `word` is a virtual pid.
fn is_virtual(word: &str) -> bool {
	word.parse::<u32>().is_ok_and(|pid| pid >= Vpid::BASE)
}

// Failure mode: `$!` of `cmd &` is the job's virtual pid, so the pid the
// program reports (`/bin/sh -c 'echo $$'`) is not the one the shell shows,
// and `kill`/`wait` of the program's pid miss the job.
#[test]
fn a_lone_external_job_is_known_by_its_os_pid() {
	let world = World::new();
	let (out, status) = run(
		world.host(),
		"/x/sleeper & echo \"$!\"; jobs -p; jobs -l; kill \"$!\"; wait \"$!\"; echo \"st=$? \
		 last=$!\"",
	);
	assert_eq!(status, 0, "{out}");
	let lines: Vec<&str> = out.lines().collect();
	assert_eq!(lines[0], "5001", "{out}");
	assert_eq!(lines[1], "5001", "{out}");
	assert!(lines[2].starts_with("[1]+  5001 Running"), "{out}");
	assert_eq!(lines[3], "st=143 last=5001", "{out}");
	assert_eq!(world.got(FIRST), [Signal::Term]);
}

// Failure mode: prefix assignments, redirections, `command`, `exec` in a
// group or a function hide the program behind the job's virtual pid.
#[test]
fn assignments_redirections_and_exec_keep_the_os_pid() {
	let world = World::new();
	let (out, _) = run(
		world.host(),
		"FOO=1 /x/true >out & a=$!; { exec /x/true; } & b=$!; f() { exec /x/true; }; f & c=$!; \
		 command /x/true & d=$!; wait; echo $a $b $c $d",
	);
	assert_eq!(out, "5001 5002 5003 5004\n");
}

// Failure mode: a compound job, a builtin, a function running its external
// as one command of its own, or a subshell group reports the pid of one of
// the programs it runs.
#[test]
fn compound_and_builtin_jobs_keep_virtual_pids() {
	let world = World::new();
	let (out, _) = run(
		world.host(),
		"{ :; /x/true; } & a=$!; : & b=$!; f() { /x/true; }; f & c=$!; ( /x/true ) & e=$!; { \
		 /x/true; } & g=$!; wait; echo $a $b $c $e $g",
	);
	let pids: Vec<&str> = out.split_whitespace().collect();
	assert_eq!(pids.len(), 5, "{out}");
	assert!(pids.iter().all(|p| is_virtual(p)), "{out}");
}

// Failure mode: a background pipeline's `$!` is the shell's virtual pid,
// which `kill` cannot reach as a program, instead of its last program's
// (bash: `kill $!` signals that program), also under `!` and `time`.
#[test]
fn a_background_pipeline_is_known_by_its_last_program() {
	for prefix in ["", "! ", "time "] {
		let world = World::new();
		let (out, _) =
			run(world.host(), &format!("{prefix}/x/true | /x/trap42 & p=$!; kill $p; wait; echo $p"));
		let last = world
			.redirs
			.lock()
			.iter()
			.position(|(argv0, _)| argv0.as_slice() == b"/x/trap42")
			.expect("the last stage ran");
		let pid = FIRST + last as u32;
		assert_eq!(out, format!("{pid}\n"), "{prefix:?}");
		assert_eq!(world.got(pid), [Signal::Term], "{prefix:?}");
	}
}

// Failure mode: once a pipeline's last program ended, `kill` of its pid
// (`$!`) still reaches the job its other stages keep running (bash: no
// such process, status 1).
#[test]
fn an_ended_last_stage_is_no_longer_signalled() {
	let world = World::new();
	let (out, _) = run(
		world.host(),
		&format!("/x/sleeper | /x/true & p=$!; {BUSY}; kill -0 $p; echo $?; kill %1; wait"),
	);
	assert_eq!(out, "1\n");
	assert_eq!(world.got(FIRST), [Signal::Term], "only `kill %1` reached the first stage");
}

// Failure mode: `wait -n -p` names the virtual pid while `$!` showed the OS
// pid, `disown` of the OS pid finds no job, or `kill`/`wait` of a disowned
// job's OS pid no longer reach it.
#[test]
fn wait_p_and_disown_take_the_os_pid() {
	let world = World::new();
	let (out, _) = run(
		world.host(),
		"/x/true & p=$!; wait -n -p v; echo \"$v $p\"; /x/sleeper & q=$!; disown \"$q\"; echo \
		 \"disown=$? jobs=$(jobs -p)\"; kill \"$q\"; wait \"$q\"; echo $?",
	);
	assert_eq!(out, "5001 5001\ndisown=0 jobs=\n143\n");
}

// Failure mode: a job whose program traps `TERM` is marked done (143) when
// the shell signals it, though the program goes on and exits 43 later
// (bash: `st=43`).
#[test]
fn a_signalled_lone_external_ends_with_its_own_status() {
	let world = World::new();
	let (out, _) = run(
		world.host(),
		// `: $!` waits until the job runs its program (as bash's job has by
		// the time it traps).
		"/x/trap43 & : $!; kill %1; wait %1; echo \"job=$?\"; /x/trap43 & kill $!; wait $!; echo \
		 \"pid=$?\"",
	);
	assert_eq!(out, "job=43\npid=43\n");
	assert_eq!(world.got(FIRST), [Signal::Term], "one TERM, not one per path");
	assert_eq!(world.got(FIRST + 1), [Signal::Term]);
}

// Failure mode: `kill %1` of a pipeline job ends the job at once with 143
// while its stages run on (bash: the stages' own statuses, `42 43`).
#[test]
fn a_signalled_pipeline_job_ends_with_its_stages_statuses() {
	let world = World::new();
	let (out, _) = run(
		world.host(),
		&format!(
			"/x/trap42 | /x/trap43 & {BUSY}; kill -STOP %1; kill -CONT %1; kill %1; wait %1; echo $?"
		),
	);
	assert_eq!(out, "43\n");
	for pid in [FIRST, FIRST + 1] {
		let terms = world
			.got(pid)
			.iter()
			.filter(|&&s| s == Signal::Term)
			.count();
		assert_eq!(terms, 1, "stage {pid}: {:?}", world.got(pid));
	}
}

// Failure mode: a restored shell forgets the OS pid its job is known by
// (`$!`, `jobs -p`), or a snapshot taken while a job decides loses that
// decision.
#[test]
fn the_os_pid_survives_snapshots() {
	let world = World::new();
	let mut r = Rig::new(world.host(), skeleton_init(&[]));
	assert_eq!(r.run(Script::command(&b"/x/sleeper &"[..]), Fault::None), 0);
	// Let the job reach its external.
	let (shell, host, store) = r.parts();
	while let Step::Yield | Step::Done { .. } =
		shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default())
	{}
	r.snapshot();
	assert_eq!(r.run(Script::command(&b"echo $!; jobs -p"[..]), Fault::None), 0);
	assert_eq!(r.host.stdout.bytes(), b"5001\n5001\n");

	let base =
		run_script(World::new().host(), b"/x/true & echo $!; wait $!; echo $?", &[], Fault::None);
	let hit = run_script(
		World::new().host(),
		b"/x/true & echo $!; wait $!; echo $?",
		&[],
		Fault::Snapshot { every: 1 },
	);
	assert!(hit.snapshots > 0, "no snapshot landed");
	assert_eq!((hit.stdout.as_slice(), hit.status), (&b"5001\n0\n"[..], 0));
	assert_eq!(hit.stdout, base.stdout);
}

/// Runs `src`, answering each call of `tool` by running its operands in a
/// subshell: with [`ShellApi::exec_subshell_in`] (a `nohup` that `exec`s)
/// when `exec`, else [`ShellApi::run_subshell_in`].
fn drive(world: &World, tool: &str, exec: bool, src: &str) -> String {
	let mut host = world.host();
	host.tool(
		tool,
		Arc::new(|_: &mut ShellApi<'_, '_>, _: &[BString]| -> CallOutcome {
			unreachable!("the test driver answers the tool")
		}),
	);
	let mut r = Rig::new(host, skeleton_init(&[]));
	let (shell, host, store) = r.parts();
	let main = shell.submit(Script::command(src.as_bytes().to_vec()));
	let mut pending: Vec<(CallId, RunId)> = Vec::new();
	loop {
		match shell.step(&mut Cx { host: &mut *host, store: &mut *store }, Budget::default()) {
			Step::Done { run, status } if run == main => {
				assert_eq!(status, 0);
				break;
			},
			Step::Done { run, status } => {
				if let Some(at) = pending.iter().position(|&(_, r)| r == run) {
					let (id, _) = pending.remove(at);
					shell.complete(id, CallOutcome::Exit(status));
				}
			},
			Step::Call { id, call } => {
				let mut cx = Cx { host: &mut *host, store: &mut *store };
				let mut api = shell.api(&mut cx, id).expect("call is outstanding");
				let mut script = Script::command(&b"\"$@\""[..]);
				script.args = Some(call.argv[1..].to_vec());
				let lineage = Lineage { label: 0, detached: exec };
				let run = if exec {
					api.exec_subshell_in(script, lineage)
				} else {
					api.run_subshell_in(script, lineage)
				};
				pending.push((id, run));
			},
			Step::Yield => {},
			Step::Blocked => {
				if !host.fire_next_timer() {
					wait_runnable(&shell.control());
				}
			},
			other => panic!("{other:?} while `{src}` runs"),
		}
	}
	String::from_utf8_lossy(&r.host.stdout.bytes()).into_owned()
}

// Failure mode: `nohup cmd &` (a host callout that runs its operand in a
// subshell, as `nohup` `exec`s it) shows the callout's virtual pid instead of
// the program's, or any other callout's job claims its subshell's program.
#[test]
fn an_exec_like_callout_hands_its_job_to_the_program() {
	let world = World::new();
	assert_eq!(drive(&world, "nohup", true, "nohup /x/true & echo $!; wait"), "5001\n");
	let other = World::new();
	let out = drive(&other, "wrap", false, "wrap /x/true & echo $!; wait");
	assert!(is_virtual(out.trim()), "{out}");
}

// Failure mode: `cmd > fifo & bg=$!` never returns: the job opened the FIFO
// before spawning its program, and `$!` waited for that open, whose other
// end is the shell's next command. The open is left to the process (bash's
// forked child opens it); without the host's consent the job keeps its
// virtual pid rather than wait.
#[test]
fn a_redirection_that_would_wait_is_left_to_the_process() {
	let world = World::new();
	let fs = MemFs::with_latency(7, 1.0, 1);
	let host = world.host().with_fs(fs).with_child_opens();
	let (out, _) = run(host, "/x/sleeper > /f 2>&1 & echo $!; kill $!; wait $!; echo $?");
	assert_eq!(out, "5001\n143\n");
	let seen = world.redirs.lock().clone();
	let Some((name, Some(redirs))) = seen.first() else {
		panic!("the spawn got no redirections: {seen:?}");
	};
	assert_eq!(name, "/x/sleeper");
	let [ChildRedir::Open { fds, path, flags, mode, diag }, ChildRedir::Dup { fd: 2, src: 1, .. }] =
		redirs.list.as_slice()
	else {
		panic!("{redirs:?}");
	};
	assert_eq!((fds.as_slice(), path.as_slice(), *mode), (&[1][..], &b"/f"[..], 0o644));
	assert_eq!(
		*flags,
		OpenFlags::WRITE
			.with(OpenFlags::CREATE)
			.with(OpenFlags::TRUNC)
	);
	assert!(diag.ends_with(b"/f: ") && diag.starts_with(b"bash: "), "{diag}");
	assert!(redirs.exec_diag.ends_with(b"/x/sleeper: "), "{}", redirs.exec_diag);

	// A builtin opens it here: the job keeps its virtual pid at once.
	let fs = MemFs::with_latency(7, 1.0, 1);
	fs.add_file("/g", b"line\n", 0o644);
	let host = World::new().host().with_fs(fs).with_child_opens();
	let (out, _) = run(host, "read x < /g & echo $!; wait");
	assert!(is_virtual(out.trim()), "{out}");

	// Without the host's consent the engine opens it: virtual pid, no wait.
	let world = World::new();
	let host = world.host().with_fs(MemFs::with_latency(7, 1.0, 1));
	let (out, _) = run(host, "/x/true > /f & echo $!; wait");
	assert!(is_virtual(out.trim()), "{out}");
	assert!(world.redirs.lock().iter().all(|(_, r)| r.is_none()));
}
