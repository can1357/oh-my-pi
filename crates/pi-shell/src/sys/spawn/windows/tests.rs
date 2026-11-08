//! Consoles and console control events against real processes.

use std::{
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
	thread,
	time::{Duration, Instant},
};

use bstr::{BString, ByteSlice};
use windows_sys::Win32::{
	Foundation::{CloseHandle, WAIT_OBJECT_0},
	System::{
		Console::{AllocConsole, GetConsoleProcessList, SetConsoleCtrlHandler},
		Threading::{
			OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
			TerminateProcess, WaitForSingleObject,
		},
	},
};

use crate::{
	bash::{
		CmdTag, EnvView, ExitStatus, ExtProc, JobId, Lineage, PgroupSpec, RunId, SigSet, Signal,
		SpawnSpec, StdioSpec, Vpid,
	},
	sys::spawn::{NativeSpawner, Sessions, SpawnConfig},
};

const LONG: Duration = Duration::from_secs(30);

struct Unpark(thread::Thread);

impl Wake for Unpark {
	fn wake(self: Arc<Self>) {
		self.0.unpark();
	}
}

fn wait(p: &mut Box<dyn ExtProc>) -> ExitStatus {
	let waker = Waker::from(Arc::new(Unpark(thread::current())));
	let mut cx = Context::from_waker(&waker);
	let deadline = Instant::now() + LONG;
	loop {
		if let Poll::Ready(s) = p.poll_wait(&mut cx) {
			return s;
		}
		assert!(Instant::now() < deadline, "process did not finish");
		thread::park_timeout(Duration::from_millis(50));
	}
}

fn system_root() -> String {
	std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into())
}

fn system32(exe: &str) -> BString {
	BString::from(format!(r"{}\System32\{exe}", system_root()))
}

/// `cmd.exe /c <script>`.
fn cmd(script: &str) -> Vec<BString> {
	vec![system32("cmd.exe"), BString::from("/c"), BString::from(script)]
}

/// A single process running for 30 s.
fn ping() -> Vec<BString> {
	let mut argv = vec![system32("PING.EXE")];
	argv.extend(["-n", "30", "127.0.0.1"].map(BString::from));
	argv
}

/// `argv` as a fresh job's only stage.
fn spawn(s: &NativeSpawner, argv: &[BString], lineage: Lineage) -> Box<dyn ExtProc> {
	let root = system_root();
	let env = EnvView::new(vec![
		(BString::from("SystemRoot"), BString::from(root.as_str())),
		(BString::from("PATH"), BString::from(format!(r"{root}\System32"))),
	]);
	s.spawn(SpawnSpec {
		path: argv[0].as_bstr(),
		argv,
		env: &env,
		cwd: system_root().as_bytes().as_bstr(),
		stdio: [StdioSpec::Null, StdioSpec::Null, StdioSpec::Null],
		extra_fds: Vec::new(),
		pgroup: PgroupSpec::New(JobId(1)),
		tag: CmdTag { run: RunId(1), vpid: Vpid(Vpid::BASE), seq: 1 },
		vpid: Vpid(Vpid::BASE),
		umask: 0,
		sigmask_ign: SigSet::EMPTY,
		rlimits: &[],
		lineage,
		redirs: None,
		ctty: None,
	})
	.unwrap()
}

fn spawner(sessions: Sessions, grace: Duration) -> NativeSpawner {
	NativeSpawner::new(SpawnConfig { grace, sessions, ..SpawnConfig::default() })
}

/// Pids attached to this process's console (one is allocated when it has
/// none; nextest runs each test in a process of its own).
fn on_our_console() -> Vec<u32> {
	let mut pids = vec![0u32; 1024];
	// SAFETY: `pids` is writable for its length.
	let mut n = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) };
	if n == 0 {
		// SAFETY: plain call; fails harmlessly when a console exists.
		unsafe { AllocConsole() };
		// SAFETY: as above.
		n = unsafe { GetConsoleProcessList(pids.as_mut_ptr(), pids.len() as u32) };
	}
	assert!(n > 0 && n as usize <= pids.len(), "no console process list");
	pids.truncate(n as usize);
	pids
}

const SLEEP: &str = "ping -n 30 127.0.0.1 >NUL";

const RELEASED: Lineage = Lineage { label: 0, detached: true };

/// Still running after a moment: a command that failed to start would make
/// every console and signal assertion vacuous.
fn assert_running(p: &mut Box<dyn ExtProc>) {
	thread::sleep(Duration::from_millis(500));
	let mut cx = Context::from_waker(Waker::noop());
	assert!(p.poll_wait(&mut cx).is_pending(), "the external exited early");
}

/// An agent host's external writing to `CONOUT$` (xperf's progress bar)
/// scrolled and corrupted the host's TUI: under `Detach` no external, owned
/// or released (`nohup`), is attached to the host's console, while a
/// standalone shell's (`Inherit`) still is.
#[test]
fn only_detach_externals_get_a_console_of_their_own() {
	let ours = on_our_console;
	for (sessions, lineage, shared) in [
		(Sessions::Detach, Lineage::default(), false),
		(Sessions::Detach, RELEASED, false),
		(Sessions::Inherit, Lineage::default(), true),
	] {
		let s = spawner(sessions, LONG);
		let mut p = spawn(&s, &cmd(SLEEP), lineage);
		assert_running(&mut p);
		let deadline = Instant::now() + Duration::from_secs(5);
		let mut seen = ours().contains(&p.pid());
		while !seen && shared && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(20));
			seen = ours().contains(&p.pid());
		}
		assert_eq!(seen, shared, "{sessions:?} detached={}", lineage.detached);
		p.signal(Signal::Kill).unwrap();
		assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
	}
}

/// A released external's console is its own, not the spawner's: it runs on
/// after its `ExtProc` and the spawner are gone, as a `nohup` process
/// outlives the shell.
#[test]
fn a_released_external_outlives_its_spawner() {
	let s = spawner(Sessions::Detach, LONG);
	let mut p = spawn(&s, &ping(), RELEASED);
	assert_running(&mut p);
	let pid = p.pid();
	drop(p);
	drop(s);
	// SAFETY: plain call with scalar arguments.
	let h = unsafe {
		OpenProcess(
			PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
			0,
			pid,
		)
	};
	assert!(!h.is_null(), "the released external is gone");
	// SAFETY: an open process handle.
	let exited = unsafe { WaitForSingleObject(h, 1000) } == WAIT_OBJECT_0;
	// SAFETY: as above; closed once.
	unsafe {
		TerminateProcess(h, 1);
		CloseHandle(h);
	}
	assert!(!exited, "the released external died with its spawner");
}

/// TERM hangs up an owned external's pseudoconsole: it ends by `CTRL_CLOSE`,
/// long before the grace's KILL, even when it inherited an ignored Ctrl-C
/// (a host started in a new process group), which `CTRL_C` would not reach.
#[test]
fn term_ends_an_owned_external_ignoring_ctrl_c_before_the_grace() {
	// SAFETY: plain call; children inherit the ignored Ctrl-C.
	assert_ne!(unsafe { SetConsoleCtrlHandler(None, 1) }, 0);
	let s = spawner(Sessions::Detach, LONG);
	let mut p = spawn(&s, &cmd(SLEEP), Lineage::default());
	assert_running(&mut p);
	let t0 = Instant::now();
	p.signal(Signal::Term).unwrap();
	let status = wait(&mut p);
	assert!(t0.elapsed() < LONG / 2, "TERM waited for the grace: {status:?}");
	assert_eq!(status, ExitStatus::Signaled(Signal::Term));
}

/// No console control event reaches a released external's hidden console:
/// TERM kills it at once instead of being lost until the grace.
#[test]
fn term_kills_a_released_external_at_once() {
	let s = spawner(Sessions::Detach, LONG);
	let mut p = spawn(&s, &ping(), RELEASED);
	assert_running(&mut p);
	let t0 = Instant::now();
	p.signal(Signal::Term).unwrap();
	assert_eq!(wait(&mut p), ExitStatus::Signaled(Signal::Kill));
	assert!(t0.elapsed() < LONG / 2, "TERM waited for the grace");
}
