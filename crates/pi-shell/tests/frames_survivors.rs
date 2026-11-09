//! A host-owned external can ignore TERM and outlive its virtual owner.
//! Losing its owner must not hide it from either snapshot report.
#![cfg(unix)]

use std::{
	io::{self, Read, Write},
	process::{Child, Command, Stdio},
	sync::{Arc, Mutex},
	task::{Context, Poll},
};

use pi_shell::{
	bash::{
		Budget, Cx, Engine, EngineConfig, ExitStatus, ExtProc, Lost, MemStore, RestoreOpts, Script,
		Shell, SigTarget, Signal, SpawnSpec, Step, Vpid, VprocSel,
	},
	testkit::{FakeHost, Rig, fault::skeleton_init},
};

// The host, not the engine's handle, owns this real process. This is a valid
// ExtProc lifetime: dropping a handle need not terminate the host's program.
struct Program(Mutex<Child>);

impl Program {
	fn start() -> Arc<Self> {
		let mut child = Command::new("/bin/sh")
			.args(["-c", "trap '' TERM; printf R; read line"])
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::null())
			.spawn()
			.unwrap();
		let mut ready = [0];
		child.stdout.take().unwrap().read_exact(&mut ready).unwrap();
		assert_eq!(ready, *b"R", "the TERM disposition is installed before signalling");
		Arc::new(Self(Mutex::new(child)))
	}

	fn pid(&self) -> u32 {
		self.0.lock().unwrap().id()
	}

	fn running(&self) -> bool {
		self.0.lock().unwrap().try_wait().unwrap().is_none()
	}

	fn finish(&self) {
		let mut child = self.0.lock().unwrap();
		child.stdin.take().unwrap().write_all(b"done\n").unwrap();
		assert!(child.wait().unwrap().success());
	}
}

impl Drop for Program {
	fn drop(&mut self) {
		let child = self.0.get_mut().unwrap();
		let _ = child.kill();
		let _ = child.wait();
	}
}

struct Handle(Arc<Program>);

impl ExtProc for Handle {
	fn pid(&self) -> u32 {
		self.0.pid()
	}

	fn poll_wait(&mut self, _: &mut Context<'_>) -> Poll<ExitStatus> {
		match self.0.0.lock().unwrap().try_wait().unwrap() {
			Some(status) => Poll::Ready(ExitStatus::Exited(status.code().unwrap_or(137))),
			None => Poll::Pending,
		}
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		assert_eq!(sig, Signal::Term, "this producer sends TERM, not a shell-only KILL");
		// SAFETY: this test owns this unreaped child and signals only its pid.
		let result = unsafe { libc::kill(self.pid() as i32, libc::SIGTERM) };
		if result == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	fn stop(&mut self) -> io::Result<()> {
		Ok(())
	}

	fn cont(&mut self) -> io::Result<()> {
		Ok(())
	}
}

fn survivor() -> (Rig, Arc<Program>, Vpid) {
	let program = Program::start();
	let spawned = Arc::clone(&program);
	let owner = Arc::new(Mutex::new(None));
	let seen = Arc::clone(&owner);
	let host = FakeHost::new().with_spawner(Box::new(move |spec: SpawnSpec<'_>| {
		*seen.lock().unwrap() = Some(spec.vpid);
		Ok(Box::new(Handle(Arc::clone(&spawned))) as Box<dyn ExtProc>)
	}));
	let mut rig = Rig::new(host, skeleton_init(&[]));
	let run = rig.shell().submit(Script {
		vproc: VprocSel::NewSubshell,
		..Script::command(&b"/x/survivor; echo unreachable"[..])
	});
	let budget = Budget { max_ops: 1, max_ns: u64::MAX };
	for _ in 0..200 {
		let (shell, host, store) = rig.parts();
		shell.step(&mut Cx { host, store }, budget);
		if rig.host.live_externals() == 1 {
			break;
		}
	}
	assert_eq!(rig.host.live_externals(), 1);
	let owner = owner.lock().unwrap().unwrap();
	rig.shell()
		.control()
		.signal(SigTarget::Vpid(owner), Signal::Term);
	let (shell, host, store) = rig.parts();
	let step = shell.step(&mut Cx { host, store }, Budget::default());
	assert!(matches!(step, Step::Done { run: id, status: 143 } if id == run), "{step:?}");
	assert!(program.running(), "TERM did not end the host-owned program");
	assert!(rig.host.stdout.bytes().is_empty(), "the dead owner must not resume");
	(rig, program, owner)
}

fn reports() -> (Vec<Lost>, Vec<Lost>, Vec<Lost>) {
	let (mut rig, program, owner) = survivor();
	let (shell, host, store) = rig.parts();
	let mut cx = Cx { host, store };
	shell.control().request_suspend();
	assert!(matches!(shell.step(&mut cx, Budget::default()), Step::SuspendReady));
	let externalized = shell.externalize(&mut cx).unwrap();
	let snapshot = rig.store.to_bytes();
	let mut store = MemStore::from_bytes(&snapshot).unwrap();
	let engine = Engine::new(EngineConfig::default());
	let (_, host, _) = rig.parts();
	let (mut restored, report) =
		Shell::restore(&engine, &mut Cx { host, store: &mut store }, RestoreOpts::default()).unwrap();
	assert_eq!(report.vprocs, 1, "the ended owner is not recreated");
	assert_eq!(report.runs, 0, "the ended script is not resumed");
	let mut recovery_store = MemStore::from_bytes(&snapshot).unwrap();
	let (mut recovered, recovery) =
		Shell::restore(&engine, &mut Cx { host, store: &mut recovery_store }, RestoreOpts {
			drop_frames: true,
			..Default::default()
		})
		.unwrap();
	assert_eq!(recovery.vprocs, 0, "explicit recovery does not rebuild frames");
	assert_eq!(recovery.runs, 0, "explicit recovery does not resume scripts");
	assert!(recovery.abandoned.is_empty(), "the owner's script already ended");
	assert!(program.running(), "neither snapshot operation terminates the original program");
	let expected = Lost::Ext { vpid: owner, pid: program.pid() };
	println!(
		"expected={expected:?} externalize={:?} restore={report:?} recovery={recovery:?}",
		externalized.lost
	);
	// A second image must not invent a new live handle for an already lost
	// program.
	let again = restored
		.externalize(&mut Cx { host, store: &mut store })
		.unwrap();
	assert!(again.lost.is_empty(), "a restored loss is not a live external");
	let again = recovered
		.externalize(&mut Cx { host, store: &mut recovery_store })
		.unwrap();
	assert!(again.lost.is_empty(), "a recovered loss is not a live external");
	assert_eq!(
		externalized
			.lost
			.iter()
			.filter(|lost| **lost == expected)
			.count(),
		externalized.lost.len()
	);
	assert_eq!(report.lost.iter().filter(|lost| **lost == expected).count(), report.lost.len());
	assert_eq!(
		recovery
			.lost
			.iter()
			.filter(|lost| **lost == expected)
			.count(),
		recovery.lost.len()
	);
	(externalized.lost, report.lost, recovery.lost)
}

#[test]
fn externalize_reports_a_program_that_ignored_its_owners_term() {
	let (externalized, ..) = reports();
	assert_eq!(
		externalized.len(),
		1,
		"externalize must report the surviving program's owner and native pid"
	);
}

#[test]
fn restore_reports_a_program_that_ignored_its_owners_term() {
	let (_, restored, _) = reports();
	assert_eq!(
		restored.len(),
		1,
		"restore must report the same surviving program's owner and native pid"
	);
}

#[test]
fn dropping_frames_reports_a_program_that_ignored_its_owners_term() {
	let (_, _, recovered) = reports();
	assert_eq!(
		recovered.len(),
		1,
		"explicit recovery must report the surviving program's owner and native pid"
	);
}

#[test]
fn restore_modes_report_the_same_survivors_from_one_image() {
	let (_, restored, recovered) = reports();
	assert_eq!(restored.len(), 1, "the image records one surviving program");
	assert_eq!(recovered, restored, "dropping frames must not discard survivor metadata");
}

#[test]
fn snapshots_do_not_report_a_survivor_that_has_exited() {
	let (mut rig, program, _) = survivor();
	program.finish();
	let (shell, host, store) = rig.parts();
	assert!(
		shell
			.externalize(&mut Cx { host, store })
			.unwrap()
			.lost
			.is_empty()
	);
	assert_eq!(rig.host.live_externals(), 0, "finished survivor handles must be released");
}
