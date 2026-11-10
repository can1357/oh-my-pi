#![cfg(unix)]

use std::{sync::Arc, task::Waker, time::Duration};

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Lost, MemStore, RestoreOpts, RunId, Script, Shell,
		ShellInit, SigTarget, Signal, Step, Vpid, VprocSel,
	},
	host::{PiHost, TERM_GRACE},
	session::{RunStdio, Session, SessionConfig},
	sys::StdFs,
	tools::{ToolCalls, ToolConfig},
};
use tokio_util::sync::CancellationToken;

struct Program {
	pid:   u32,
	owner: Vpid,
	run:   RunId,
}

fn alive(pid: u32) -> bool {
	// SAFETY: signal zero only queries this test's native child.
	unsafe { libc::kill(pid as i32, 0) == 0 }
}

impl Drop for Program {
	fn drop(&mut self) {
		// SAFETY: cleanup targets only the exact child pid recorded by this test.
		unsafe { libc::kill(self.pid as i32, libc::SIGKILL) };
	}
}

fn command(pid_file: &std::path::Path) -> String {
	format!(
		"/usr/bin/python3 -c 'import os,signal,time; signal.signal(signal.SIGTERM,signal.SIG_IGN); \
		 open(\"{}\",\"w\").write(str(os.getpid())); time.sleep(3600)'; echo unreachable",
		pid_file.display()
	)
}

/// Writes a program that ignores `TERM`, so a targeted signal leaves it
/// retained, and appends one byte every 10 ms, so a test measures what the
/// program itself did instead of what the engine reports about itself.
fn write_ticker(dir: &std::path::Path) -> std::path::PathBuf {
	let script = dir.join("ticker.py");
	std::fs::write(
		&script,
		"import os,signal,sys,time\n\
		 signal.signal(signal.SIGTERM,signal.SIG_IGN)\n\
		 t=open(sys.argv[1]+'.ticks','ab',buffering=0)\n\
		 open(sys.argv[1],'w').write(str(os.getpid()))\n\
		 while True:\n\
		 \x20t.write(b'x')\n\
		 \x20time.sleep(0.01)\n",
	)
	.unwrap();
	script
}

/// How many bytes the ticking program has written so far.
fn ticks(pid_file: &std::path::Path) -> u64 {
	let mut path = pid_file.as_os_str().to_owned();
	path.push(".ticks");
	std::fs::metadata(std::path::Path::new(&path)).map_or(0, |m| m.len())
}

/// The kernel's state letter for `pid` (`T` once stopped), on a host with
/// `/proc`; `None` elsewhere. The comm field is parenthesised and may hold
/// spaces, so the state follows its last `)`.
fn proc_state(pid: u32) -> Option<char> {
	let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
	stat
		.rsplit_once(')')?
		.1
		.split_whitespace()
		.next()?
		.chars()
		.next()
}

struct NativeShell {
	engine: Arc<Engine>,
	shell:  Shell,
	host:   PiHost,
	store:  MemStore,
	/// `nohup` is a host callout, not a command: without a driver for it
	/// the calling vproc blocks for ever (`session::Session` runs the same
	/// three lines around its own `step`).
	tools:  ToolCalls,
}

impl NativeShell {
	fn new() -> Self {
		let engine = Engine::new(EngineConfig::default());
		let env = vec![(BString::from("PATH"), BString::from("/usr/bin:/bin"))];
		let mut host = PiHost::new(Box::new(StdFs::default()), tokio::runtime::Handle::current());
		let config = ToolConfig::from_env(&env, None, tokio::runtime::Handle::current());
		host.set_tools(config.clone());
		let tools = ToolCalls::new(config, host.spawn_log(), Waker::noop().clone());
		let mut store = MemStore::new();
		let shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, ShellInit {
				env,
				..ShellInit::default()
			})
			.unwrap();
		Self { engine, shell, host, store, tools }
	}

	fn step(&mut self) -> Step {
		let mut cx = Cx { host: &mut self.host, store: &mut self.store };
		self.tools.poll(&mut self.shell, &mut cx);
		let step = self.shell.step(&mut cx, Budget::default());
		match &step {
			Step::Call { id, call } => {
				let (id, call) = (*id, call.clone());
				self.tools.on_call(&mut self.shell, &mut cx, id, call);
			},
			Step::Done { run, status } => {
				let signal = self.shell.exec_signal(*run);
				self.tools.on_done(*run, *status, signal);
			},
			_ => {},
		}
		step
	}

	async fn drive_for(&mut self, duration: Duration) {
		let until = tokio::time::Instant::now() + duration;
		while tokio::time::Instant::now() < until {
			self.step();
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	}

	async fn start(&mut self, pid_file: &std::path::Path) -> Program {
		self.start_cmd(pid_file, command(pid_file)).await
	}

	/// Run `cmd` in a subshell of its own, wait until it has written its pid
	/// into `pid_file`, and name the virtual process that owns it.
	async fn start_cmd(&mut self, pid_file: &std::path::Path, cmd: String) -> Program {
		let run = self.shell.submit(Script {
			vproc: VprocSel::NewSubshell,
			..Script::command(cmd.into_bytes())
		});
		let until = tokio::time::Instant::now() + Duration::from_secs(15);
		while !pid_file.exists() {
			assert!(tokio::time::Instant::now() < until, "native child did not become ready");
			self.step();
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		let pid = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
		let report = self
			.shell
			.externalize(&mut Cx { host: &mut self.host, store: &mut self.store })
			.unwrap();
		let owner = report
			.lost
			.iter()
			.find_map(|lost| match lost {
				Lost::Ext { vpid, pid: native } if *native == pid => Some(*vpid),
				_ => None,
			})
			.expect("snapshot names the active native child's owner");
		Program { pid, owner, run }
	}
}

async fn retained_program_is_cancelled(signal: Signal) {
	let dir = tempfile::tempdir().unwrap();
	let mut native = NativeShell::new();
	let retained = native.start(&dir.path().join("retained")).await;
	native
		.shell
		.control()
		.signal(SigTarget::Vpid(retained.owner), Signal::Term);
	assert!(matches!(native.step(), Step::Done { run, status: 143 } if run == retained.run));

	// Ending a different owner must not signal the first owner's retained
	// program. Waiting past the production grace also catches premature drop.
	let other = native.start(&dir.path().join("other")).await;
	native
		.shell
		.control()
		.signal(SigTarget::Vpid(other.owner), Signal::Kill);
	assert!(matches!(native.step(), Step::Done { run, status: 137 } if run == other.run));
	native.drive_for(TERM_GRACE * 2).await;
	println!(
		"before shell cancel {signal:?}: retained_pid={} alive={} live={}",
		retained.pid,
		alive(retained.pid),
		native.shell.live_external_jobs()
	);
	assert!(alive(retained.pid), "a targeted vproc signal must retain another owner's program");
	assert!(!alive(other.pid), "KILL reached the other owner's native program");
	assert_eq!(native.shell.live_external_jobs(), 1);

	native.shell.control().cancel(signal);
	native.step();
	let until = tokio::time::Instant::now() + TERM_GRACE * 5;
	while (alive(retained.pid) || native.shell.live_external_jobs() != 0)
		&& tokio::time::Instant::now() < until
	{
		native.drive_for(Duration::from_millis(10)).await;
	}
	println!(
		"after shell cancel {signal:?}: retained_pid={} alive={} live={} leftovers={:?}",
		retained.pid,
		alive(retained.pid),
		native.shell.live_external_jobs(),
		native.host.spawner().leftovers()
	);
	assert!(!alive(retained.pid), "whole-shell cancellation must end the retained native program");
	assert_eq!(native.shell.live_external_jobs(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_term_escalates_a_retained_native_without_ending_it_on_a_vproc_signal() {
	retained_program_is_cancelled(Signal::Term).await;

	// Also exercise the production driver: completing the cancelled run must
	// not prevent the spawner's grace/KILL from ending its native child.
	let dir = tempfile::tempdir().unwrap();
	let pid_file = dir.path().join("session");
	let mut session = Session::new(SessionConfig {
		env:             vec![(BString::from("PATH"), BString::from("/usr/bin:/bin"))],
		cwd:             BString::from("/"),
		fs:              Box::new(StdFs::default()),
		vfs:             None,
		runtime:         tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap();
	let token = CancellationToken::new();
	let cancel = async {
		let until = tokio::time::Instant::now() + Duration::from_secs(15);
		while !pid_file.exists() {
			assert!(tokio::time::Instant::now() < until, "session child did not become ready");
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		token.cancel();
	};
	let script = format!("({}) & wait", command(&pid_file));
	let (outcome, ()) =
		tokio::join!(session.run(&script, RunStdio::default(), token.clone()), cancel);
	let outcome = outcome.unwrap();
	let pid = std::fs::read_to_string(pid_file).unwrap().parse().unwrap();
	let _cleanup = Program { pid, owner: Vpid(0), run: RunId(0) };
	assert!(outcome.cancelled);
	assert_eq!(outcome.status, 143);
	let until = tokio::time::Instant::now() + TERM_GRACE * 5;
	while alive(pid) && tokio::time::Instant::now() < until {
		tokio::time::sleep(Duration::from_millis(10)).await;
	}
	let live = session.live_external_jobs().await.unwrap();
	println!(
		"production Session::run: outcome={outcome:?} pid={pid} alive={} live={live}",
		alive(pid)
	);
	assert!(!alive(pid), "a cancelled production session must not leave its native child running");
	assert_eq!(live, 0);
}

/// A `nohup` program must outlive whole-shell cancellation even after the
/// virtual process that started it has already ended. Retaining the handle
/// past its owner must not lose the owner's detached lineage: an active
/// detached vproc's work is already left alone by cancellation, and a
/// retained one is the same program a moment later.
///
/// `nohup` is given a shell FUNCTION, so the detached owner is a subshell of
/// its own and the native program underneath it is not the job's program.
/// That is what makes `kill -TERM %1` end the owner while the program runs
/// on, leaving a retained handle with no vproc and no frame behind it. Giving
/// `nohup` the program directly instead makes the job's program the native
/// itself, which ends it along with its owner and never reaches this path.
///
/// The program counts the signals it receives, so the assertion is that
/// cancellation sent none, not merely that something survived a grace period.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_cancellation_leaves_a_retained_detached_native_running() {
	let dir = tempfile::tempdir().unwrap();
	let script_file = dir.path().join("native.py");
	let pid_file = dir.path().join("pid");
	let terms_file = dir.path().join("pid.terms");
	std::fs::write(
		&script_file,
		"import os,signal,time,sys\n\
		 seen=0\n\
		 def term(s,f):\n\
		 \x20global seen\n\
		 \x20seen+=1\n\
		 \x20open(sys.argv[1]+'.terms','w').write(str(seen))\n\
		 signal.signal(signal.SIGTERM,term)\n\
		 open(sys.argv[1],'w').write(str(os.getpid()))\n\
		 time.sleep(120)\n",
	)
	.unwrap();
	let mut session = Session::new(SessionConfig {
		env:             vec![(BString::from("PATH"), BString::from("/usr/bin:/bin"))],
		cwd:             BString::from("/"),
		fs:              Box::new(StdFs::default()),
		vfs:             None,
		runtime:         tokio::runtime::Handle::current(),
		output_decoding: None,
	})
	.unwrap();
	let token = CancellationToken::new();
	let watch = async {
		// The owner takes its TERM and ends; the program records that one
		// signal and runs on, so the engine keeps its handle with no vproc
		// behind it. Only then is the shell cancelled.
		let until = tokio::time::Instant::now() + Duration::from_secs(25);
		while !terms_file.exists() {
			assert!(tokio::time::Instant::now() < until, "the owner's TERM never reached it");
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		tokio::time::sleep(TERM_GRACE * 2).await;
		let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
		let before = std::fs::read_to_string(&terms_file).unwrap();
		assert!(alive(pid), "the program died before the shell was cancelled");
		token.cancel();
		(pid, before)
	};
	let script = format!(
		"worker(){{ /usr/bin/python3 '{script}' '{pid}' >/dev/null 2>&1; echo UNREACHABLE; }}; \
		 nohup worker >/dev/null 2>&1 & while [ ! -s '{pid}' ]; do sleep 0.01; done; \
		 kill -TERM %1; wait %1; while :; do sleep 0.1; done",
		script = script_file.display(),
		pid = pid_file.display()
	);
	let (outcome, (pid, before)) =
		tokio::join!(session.run(&script, RunStdio::default(), token.clone()), watch);
	let _cleanup = Program { pid, owner: Vpid(0), run: RunId(0) };
	assert!(outcome.unwrap().cancelled);
	tokio::time::sleep(TERM_GRACE * 3).await;
	let after = std::fs::read_to_string(&terms_file).unwrap();
	println!(
		"retained detached across cancel: pid={pid} before={before} after={after} alive={}",
		alive(pid)
	);
	assert_eq!(after, before, "whole-shell cancellation signalled a retained detached program");
	assert!(alive(pid), "whole-shell cancellation ended a retained detached native program");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_kill_reaches_a_retained_native_without_ending_it_on_a_vproc_signal() {
	retained_program_is_cancelled(Signal::Kill).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn both_restore_modes_report_an_active_native_once_from_identical_snapshot_bytes() {
	let dir = tempfile::tempdir().unwrap();
	let mut native = NativeShell::new();
	let program = native.start(&dir.path().join("active")).await;
	native.shell.control().request_suspend();
	assert!(matches!(native.step(), Step::SuspendReady));
	native
		.shell
		.externalize(&mut Cx { host: &mut native.host, store: &mut native.store })
		.unwrap();
	let bytes = native.store.to_bytes();
	let expected = Lost::Ext { vpid: program.owner, pid: program.pid };
	for drop_frames in [false, true] {
		let mut store = MemStore::from_bytes(&bytes).unwrap();
		let mut host = PiHost::new(Box::new(StdFs::default()), tokio::runtime::Handle::current());
		let (mut restored, report) = Shell::restore(
			&native.engine,
			&mut Cx { host: &mut host, store: &mut store },
			RestoreOpts { drop_frames, ..Default::default() },
		)
		.unwrap();
		println!("drop_frames={drop_frames} expected={expected:?} report={report:?}");
		let externals: Vec<_> = report
			.lost
			.iter()
			.filter(|lost| matches!(lost, Lost::Ext { .. }))
			.copied()
			.collect();
		assert_eq!(
			externals,
			vec![expected],
			"both restore modes must report the native pid exactly once"
		);
		assert_eq!(report.runs, u32::from(!drop_frames));
		assert_eq!(
			report.abandoned,
			if drop_frames {
				vec![program.run]
			} else {
				vec![]
			}
		);
		assert_eq!(restored.live_external_jobs(), 0, "a reported loss is not a restored handle");
		let again = restored
			.externalize(&mut Cx { host: &mut host, store: &mut store })
			.unwrap();
		assert!(
			!again
				.lost
				.iter()
				.any(|lost| matches!(lost, Lost::Ext { .. }))
		);
		assert!(alive(program.pid), "restore must not terminate the original native program");
	}
}

/// A retained program must stop while the whole shell is paused and run
/// again once it resumes, measured in the bytes the program itself wrote.
async fn pause_stops_retained(
	native: &mut NativeShell,
	pid_file: &std::path::Path,
	pid: u32,
	what: &str,
) {
	let before = ticks(pid_file);
	native.drive_for(Duration::from_millis(200)).await;
	let running = ticks(pid_file);
	println!("{what}: before pause ticks {before} -> {running}");
	assert!(running > before, "{what}: the retained program wrote nothing before the pause");

	native.shell.control().pause();
	assert!(matches!(native.step(), Step::Paused));
	// Let a write already in flight land, then measure a quiet window.
	tokio::time::sleep(Duration::from_millis(150)).await;
	let paused_at = ticks(pid_file);
	let state = proc_state(pid);
	tokio::time::sleep(Duration::from_millis(400)).await;
	let still = ticks(pid_file);
	println!("{what}: paused state={state:?} ticks {paused_at} -> {still}");
	assert_eq!(still, paused_at, "{what}: a paused shell left its retained program running");
	if cfg!(target_os = "linux") {
		assert_eq!(state, Some('T'), "{what}: the retained program was not stopped");
	}

	native.shell.control().resume();
	native.step();
	let until = tokio::time::Instant::now() + Duration::from_secs(5);
	while ticks(pid_file) == still && tokio::time::Instant::now() < until {
		native.drive_for(Duration::from_millis(10)).await;
	}
	let after = ticks(pid_file);
	println!("{what}: resumed state={:?} ticks {still} -> {after}", proc_state(pid));
	assert!(after > still, "{what}: resume did not continue the retained program");
	assert!(alive(pid), "{what}: the retained program did not survive pause and resume");
}

/// A targeted signal that ends a virtual process whose native child ignored
/// it leaves the only handle to that child in the engine's retained set,
/// with no vproc and no frame behind it. A whole-shell pause must reach it:
/// the host asked the shell to stop, and a program that keeps running and
/// producing output while `step` reports `Paused` is the very thing the
/// pause exists to prevent. Resume must reach it again.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_pause_stops_a_retained_native_and_resume_continues_it() {
	let dir = tempfile::tempdir().unwrap();
	let script = write_ticker(dir.path());
	let pid_file = dir.path().join("retained");
	let mut native = NativeShell::new();
	let cmd = format!(
		"/usr/bin/python3 '{}' '{}'; echo unreachable",
		script.display(),
		pid_file.display()
	);
	let retained = native.start_cmd(&pid_file, cmd).await;
	native
		.shell
		.control()
		.signal(SigTarget::Vpid(retained.owner), Signal::Term);
	assert!(matches!(native.step(), Step::Done { run, status: 143 } if run == retained.run));
	assert_eq!(native.shell.live_external_jobs(), 1, "the program outlived its owner");
	pause_stops_retained(&mut native, &pid_file, retained.pid, "retained").await;
}

/// The same for a retained program whose owner was DETACHED. Whole-shell
/// cancellation spares it, because `nohup` means "keep running when the
/// shell goes away"; a pause is not the shell going away but the host
/// suspending it, and `set_paused` already stops an ACTIVE detached vproc's
/// native child without filtering on lineage. A retained program is that
/// same program a moment later, so pause and resume reach it too.
///
/// `nohup` is given a shell FUNCTION, so the detached owner is a subshell of
/// its own and the native program underneath it is not the job's program:
/// `kill -TERM %1` then ends the owner while the program runs on.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shell_pause_stops_a_retained_detached_native_and_resume_continues_it() {
	let dir = tempfile::tempdir().unwrap();
	let script = write_ticker(dir.path());
	let pid_file = dir.path().join("detached");
	let mut native = NativeShell::new();
	let run = native.shell.submit(Script::command(
		format!(
			"worker(){{ /usr/bin/python3 '{script}' '{pid}' >/dev/null 2>&1; echo UNREACHABLE; }}; \
			 nohup worker >/dev/null 2>&1 & while [ ! -s '{pid}' ]; do sleep 0.01; done; \
			 kill -TERM %1; wait %1",
			script = script.display(),
			pid = pid_file.display()
		)
		.into_bytes(),
	));
	let until = tokio::time::Instant::now() + Duration::from_secs(30);
	loop {
		// `nohup`'s own subshell reports a `Done` of its own: wait for this
		// script's.
		if matches!(native.step(), Step::Done { run: done, .. } if done == run) {
			break;
		}
		assert!(
			tokio::time::Instant::now() < until,
			"the detached owner never ended (the program had written its pid: {})",
			pid_file.exists()
		);
		tokio::time::sleep(Duration::from_millis(10)).await;
	}
	let pid: u32 = std::fs::read_to_string(&pid_file).unwrap().parse().unwrap();
	let _cleanup = Program { pid, owner: Vpid(0), run: RunId(0) };
	assert_eq!(native.shell.live_external_jobs(), 1, "the detached program stayed retained");
	pause_stops_retained(&mut native, &pid_file, pid, "retained detached").await;
}
