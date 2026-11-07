#![cfg(unix)]

use std::{sync::Arc, time::Duration};

use bstr::BString;
use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, Lost, MemStore, RestoreOpts, RunId, Script, Shell,
		ShellInit, SigTarget, Signal, Step, Vpid, VprocSel,
	},
	host::{PiHost, TERM_GRACE},
	session::{RunStdio, Session, SessionConfig},
	sys::StdFs,
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

struct NativeShell {
	engine: Arc<Engine>,
	shell:  Shell,
	host:   PiHost,
	store:  MemStore,
}

impl NativeShell {
	fn new() -> Self {
		let engine = Engine::new(EngineConfig::default());
		let mut host = PiHost::new(Box::new(StdFs::default()), tokio::runtime::Handle::current());
		let mut store = MemStore::new();
		let shell =
			Shell::create(&engine, &mut Cx { host: &mut host, store: &mut store }, ShellInit {
				env: vec![(BString::from("PATH"), BString::from("/usr/bin:/bin"))],
				..ShellInit::default()
			})
			.unwrap();
		Self { engine, shell, host, store }
	}

	fn step(&mut self) -> Step {
		self
			.shell
			.step(&mut Cx { host: &mut self.host, store: &mut self.store }, Budget::default())
	}

	async fn drive_for(&mut self, duration: Duration) {
		let until = tokio::time::Instant::now() + duration;
		while tokio::time::Instant::now() < until {
			self.step();
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	}

	async fn start(&mut self, pid_file: &std::path::Path) -> Program {
		let run = self.shell.submit(Script {
			vproc: VprocSel::NewSubshell,
			..Script::command(command(pid_file).into_bytes())
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
			RestoreOpts { drop_frames },
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
