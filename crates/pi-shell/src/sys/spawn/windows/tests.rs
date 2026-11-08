//! Consoles and console control events against real processes.

use std::{
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
	thread,
	time::{Duration, Instant},
};

use bstr::{BString, ByteSlice};
use windows_sys::Win32::{
	Foundation::{CloseHandle, HWND, WAIT_OBJECT_0},
	System::{
		Console::{AllocConsole, GetConsoleProcessList, GetConsoleWindow, SetConsoleCtrlHandler},
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
	spawn_with(s, argv, lineage, &[])
}

/// [`spawn`] with variables added to its environment.
fn spawn_with(
	s: &NativeSpawner,
	argv: &[BString],
	lineage: Lineage,
	vars: &[(&str, &str)],
) -> Box<dyn ExtProc> {
	let root = system_root();
	let mut pairs = vec![
		(BString::from("SystemRoot"), BString::from(root.as_str())),
		(BString::from("PATH"), BString::from(format!(r"{root}\System32"))),
	];
	pairs.extend(
		vars
			.iter()
			.map(|&(k, v)| (BString::from(k), BString::from(v))),
	);
	let env = EnvView::new(pairs);
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

#[link(name = "user32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
unsafe extern "system" {
	fn IsWindowVisible(hwnd: HWND) -> i32;
}

const PROBE: &str = "sys::spawn::windows::tests::console_probe";
/// Where the probe writes what it saw; its console child writes to the same
/// path with `.child` appended.
const PROBE_OUT: &str = "PI_CONSOLE_PROBE_OUT";
const PROBE_CHILD: &str = "PI_CONSOLE_PROBE_CHILD";

/// This test binary running only [`console_probe`].
fn probe_argv() -> Vec<BString> {
	let exe = std::env::current_exe().unwrap();
	let mut argv = vec![BString::from(exe.to_str().unwrap())];
	argv.extend(["--exact", PROBE, "--ignored", "--nocapture"].map(BString::from));
	argv
}

/// What a probe saw of its console.
#[derive(Debug)]
struct Seen {
	pid:     u32,
	/// `CONOUT$` opened: the process has a console to write to.
	conout:  bool,
	/// The console has a visible window.
	visible: bool,
	/// Processes attached to the console.
	members: Vec<u32>,
}

impl Seen {
	fn now() -> Self {
		let conout = std::fs::OpenOptions::new()
			.write(true)
			.open("CONOUT$")
			.is_ok();
		// SAFETY: plain calls; a null window is never visible.
		let visible = unsafe {
			let hwnd = GetConsoleWindow();
			!hwnd.is_null() && IsWindowVisible(hwnd) != 0
		};
		let mut members = vec![0u32; 64];
		// SAFETY: `members` is writable for its length.
		let n = unsafe { GetConsoleProcessList(members.as_mut_ptr(), members.len() as u32) };
		members.truncate((n as usize).min(64));
		Self { pid: std::process::id(), conout, visible, members }
	}

	fn write(&self, path: &str) {
		let members: Vec<String> = self.members.iter().map(u32::to_string).collect();
		let line = format!(
			"{} {} {} {}",
			self.pid,
			u8::from(self.conout),
			u8::from(self.visible),
			members.join(",")
		);
		std::fs::write(path, line).unwrap();
	}

	fn read(path: &str) -> Self {
		let text = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("{path}: {e}"));
		let f: Vec<&str> = text.split(' ').collect();
		Self {
			pid:     f[0].parse().unwrap(),
			conout:  f[1] == "1",
			visible: f[2] == "1",
			members: f[3]
				.split(',')
				.filter(|s| !s.is_empty())
				.map(|s| s.parse().unwrap())
				.collect(),
		}
	}
}

/// Not a test: the probe the console tests spawn. It runs itself again as an
/// ordinary console child first, as a `cmd.exe` or PowerShell wrapper runs
/// the real program, and both record what they see of their console.
#[test]
#[ignore = "entry point of the probes the console tests spawn"]
fn console_probe() {
	let out = std::env::var(PROBE_OUT).expect("spawned by a console test");
	if std::env::var_os(PROBE_CHILD).is_none() {
		let mut argv = probe_argv().into_iter().map(|a| a.to_string());
		let status = std::process::Command::new(argv.next().unwrap())
			.args(argv)
			.env(PROBE_CHILD, "1")
			.env(PROBE_OUT, format!("{out}.child"))
			.status()
			.unwrap();
		assert!(status.success());
	}
	Seen::now().write(&out);
}

/// A command the agent host runs, owned or released (`nohup`), has a console
/// of its own that works (`CONOUT$` opens) and never shows a window, and the
/// console programs it starts share that console instead of allocating a
/// visible one each.
#[test]
fn detach_externals_and_their_children_share_a_usable_windowless_console() {
	let dir = tempfile::tempdir().unwrap();
	for (n, lineage) in [Lineage::default(), RELEASED].into_iter().enumerate() {
		let out = dir.path().join(n.to_string()).to_str().unwrap().to_owned();
		let s = spawner(Sessions::Detach, LONG);
		let mut p = spawn_with(&s, &probe_argv(), lineage, &[(PROBE_OUT, &out)]);
		assert_eq!(wait(&mut p), ExitStatus::Exited(0), "detached={}", lineage.detached);
		let (probe, child) = (Seen::read(&out), Seen::read(&format!("{out}.child")));
		for seen in [&probe, &child] {
			assert!(seen.conout, "no usable console: {seen:?}");
			assert!(!seen.visible, "a console window shows: {seen:?}");
			assert!(!on_our_console().contains(&seen.pid), "on the host's console: {seen:?}");
		}
		assert!(child.members.contains(&probe.pid), "the child got another console: {child:?}");
	}
}

/// INT on an owned external is Ctrl-C through its pseudoconsole: it reaches
/// a command that takes Ctrl-C, and, as an ignored SIGINT survives `exec` on
/// Unix, not one that inherited an ignored Ctrl-C (a host started in a new
/// process group); nothing escalates INT.
#[test]
fn int_reaches_an_owned_external_unless_it_inherited_an_ignored_ctrl_c() {
	for ignored in [false, true] {
		// SAFETY: plain call; children inherit the disposition.
		assert_ne!(unsafe { SetConsoleCtrlHandler(None, i32::from(ignored)) }, 0);
		let s = spawner(Sessions::Detach, LONG);
		let mut p = spawn(&s, &ping(), Lineage::default());
		assert_running(&mut p);
		p.signal(Signal::Int).unwrap();
		thread::sleep(Duration::from_secs(2));
		let mut cx = Context::from_waker(Waker::noop());
		assert_eq!(p.poll_wait(&mut cx).is_pending(), ignored, "ignored={ignored}");
		if ignored {
			p.signal(Signal::Kill).unwrap();
			wait(&mut p);
		}
	}
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
