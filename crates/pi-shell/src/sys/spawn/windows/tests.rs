//! Consoles and console control events against real processes.

use std::{
	sync::Arc,
	task::{Context, Poll, Wake, Waker},
	thread,
	time::{Duration, Instant},
};

use bstr::{BString, ByteSlice};
use windows_sys::Win32::{
	Foundation::{CloseHandle, HANDLE, HWND, WAIT_OBJECT_0},
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

const NEW: PgroupSpec = PgroupSpec::New(JobId(1));

/// `argv` as a fresh job's only stage.
fn spawn(s: &NativeSpawner, argv: &[BString], lineage: Lineage) -> Box<dyn ExtProc> {
	spawn_with(s, argv, lineage, NEW, &[])
}

/// [`spawn`] into `pgroup`, with variables added to its environment.
fn spawn_with(
	s: &NativeSpawner,
	argv: &[BString],
	lineage: Lineage,
	pgroup: PgroupSpec,
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
		pgroup,
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

/// `PROCESSENTRY32W`.
#[repr(C)]
struct ProcessEntry {
	size:    u32,
	usage:   u32,
	pid:     u32,
	heap:    usize,
	module:  u32,
	threads: u32,
	parent:  u32,
	base:    i32,
	flags:   u32,
	exe:     [u16; 260],
}

#[link(name = "kernel32.dll", kind = "raw-dylib", modifiers = "+verbatim")]
unsafe extern "system" {
	fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> HANDLE;
	fn Process32FirstW(snapshot: HANDLE, entry: *mut ProcessEntry) -> i32;
	fn Process32NextW(snapshot: HANDLE, entry: *mut ProcessEntry) -> i32;
}

/// Console hosts this process started: one per open pseudoconsole.
fn our_console_hosts() -> usize {
	const TH32CS_SNAPPROCESS: u32 = 2;
	// SAFETY: a process snapshot, walked with a sized entry, closed once.
	unsafe {
		let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
		assert!(!snapshot.is_null() && snapshot as isize != -1, "no process snapshot");
		let mut entry: ProcessEntry = std::mem::zeroed();
		entry.size = std::mem::size_of::<ProcessEntry>() as u32;
		let mut hosts = 0;
		let mut more = Process32FirstW(snapshot, &raw mut entry) != 0;
		while more {
			let len = entry
				.exe
				.iter()
				.position(|&c| c == 0)
				.unwrap_or(entry.exe.len());
			let exe = String::from_utf16_lossy(&entry.exe[..len]);
			if entry.parent == std::process::id() && exe.eq_ignore_ascii_case("conhost.exe") {
				hosts += 1;
			}
			more = Process32NextW(snapshot, &raw mut entry) != 0;
		}
		CloseHandle(snapshot);
		hosts
	}
}

/// Poll `cond` until it holds or `LONG` passes; whether it held.
fn eventually(mut cond: impl FnMut() -> bool) -> bool {
	let deadline = Instant::now() + LONG;
	while !cond() {
		if Instant::now() > deadline {
			return false;
		}
		thread::sleep(Duration::from_millis(50));
	}
	true
}

/// A finished owned job's pseudoconsole host lingered until the spawner was
/// dropped (up to one per job between registry sweeps): the console now
/// closes once the job's last process exits, while the spawner lives on.
#[test]
fn an_owned_job_closes_its_console_when_its_last_process_exits() {
	let s = spawner(Sessions::Detach, LONG);
	let mut running = spawn(&s, &ping(), Lineage::default());
	assert_running(&mut running);
	assert_eq!(our_console_hosts(), 1, "a running owned job has one console host");
	running.signal(Signal::Kill).unwrap();
	wait(&mut running);
	for _ in 0..3 {
		let mut p = spawn(&s, &cmd("exit 0"), Lineage::default());
		assert_eq!(wait(&mut p), ExitStatus::Exited(0));
	}
	assert!(
		eventually(|| our_console_hosts() == 0),
		"{} console hosts outlive their jobs",
		our_console_hosts()
	);
	drop(s);
}

/// A pipeline stage joining a job whose earlier stages already exited (and
/// whose console therefore closed) gets a console again instead of failing.
#[test]
fn a_stage_joining_an_emptied_owned_job_gets_a_console() {
	let s = spawner(Sessions::Detach, LONG);
	let mut first = spawn(&s, &cmd("exit 0"), Lineage::default());
	assert_eq!(wait(&mut first), ExitStatus::Exited(0));
	assert!(eventually(|| our_console_hosts() == 0), "the emptied job's console stays open");
	let mut next = spawn_with(
		&s,
		&cmd("(echo x> CON) && exit 7"),
		Lineage::default(),
		PgroupSpec::Join(first.pid()),
		&[],
	);
	assert_eq!(wait(&mut next), ExitStatus::Exited(7), "the joining stage has no usable console");
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
		let mut p = spawn_with(&s, &probe_argv(), lineage, NEW, &[(PROBE_OUT, &out)]);
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
