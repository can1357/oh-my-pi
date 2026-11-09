//! Windows spawning: `CreateProcessW` into a Job Object per job.
//!
//! - **Start.** The child is created suspended, assigned to its job, then
//!   resumed, so nothing it starts escapes the job. Only its three stdio
//!   handles are inherited (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so concurrent
//!   spawns never leak pipe ends into each other. The command line uses MSVCRT
//!   quoting; `.bat`/`.cmd` run through `cmd.exe` with std's hardened batch
//!   quoting ([`crate::sys::cmdline`]).
//! - **Consoles.** Under [`Sessions::Detach`] no external shares the host's
//!   console, the counterpart of a session without a controlling terminal:
//!   console I/O that bypasses the redirected stdio (`CONOUT$` progress bars,
//!   `CONIN$` prompts, console modes, the title) never reaches it. The console
//!   follows the spawner's ownership of the external ([`JobConsole`]): an owned
//!   one gets a pseudoconsole the spawner holds ([`Pty`]), open while the job's
//!   processes run ([`Watcher`] closes it when the last exits); a released
//!   (`nohup`) one gets a hidden console of its own (`CREATE_NO_WINDOW`), which
//!   lives as long as its processes. Other layouts share the host's console: a
//!   stage that must not get the keyboard's Ctrl-C (it starts with `SIGINT`
//!   ignored, or is a background job under job control) leads a process group
//!   of its own, which turns Ctrl-C off in it; the others stay in the shell's
//!   group, where Ctrl-C reaches them as `SIGINT` reaches the foreground of a
//!   Unix terminal.
//! - **Jobs.** `PgroupSpec::New` creates a job; `Join(pid)` adds the stage to
//!   the job led by `pid` (and its console). Signals map to the job: KILL =
//!   `TerminateJobObject` (members exit 137, reported as `Signaled(KILL)`). On
//!   a pseudoconsole TERM and HUP hang it up (`CTRL_CLOSE`, which no process
//!   can ignore; the system ends holdouts after 5 s) and INT and QUIT send
//!   `CTRL_C` (ignored by a child that inherited an ignored Ctrl-C); on the
//!   shared console TERM, INT, HUP and QUIT send `CTRL_BREAK_EVENT` to each
//!   stage's process group, which a stage left in the shell's group does not
//!   have; nothing reaches a hidden console. After TERM a KILL follows once the
//!   grace expires (console programs often ignore the event); when the event
//!   cannot be delivered the job is killed at once. Pause = `NtSuspendProcess`
//!   per member, resume = `NtResumeProcess` on exactly those
//!   ([`crate::sys::job`]).
//! - **Fds.** No fd beyond the three standard ones is inherited. A `/dev/fd/N`
//!   the arguments name (a process substitution's) becomes a named pipe
//!   `\\.\pipe\obash-pump-…` the child opens by path, pumped from or to fd N's
//!   engine object ([`bridge_fds`]); other extra fds stay with the shell.

use std::{
	collections::HashMap,
	ffi::c_void,
	fs,
	io::{self, Write as _},
	mem,
	os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle, RawHandle},
	ptr,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering},
	},
	task::{Context, Poll},
	thread,
	time::{Duration, Instant},
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::{MappedMutexGuard, Mutex, MutexGuard};
use windows_sys::Win32::{
	Foundation::{
		ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE,
		NTSTATUS, SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
	},
	System::{
		Console::{
			COORD, CTRL_BREAK_EVENT, ClosePseudoConsole, CreatePseudoConsole,
			GenerateConsoleCtrlEvent, HPCON,
		},
		IO::{CreateIoCompletionPort, GetQueuedCompletionStatus, PostQueuedCompletionStatus},
		JobObjects::{
			AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
			JOBOBJECT_ASSOCIATE_COMPLETION_PORT, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
			JOBOBJECT_BASIC_PROCESS_ID_LIST, JobObjectAssociateCompletionPortInformation,
			JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
			QueryInformationJobObject, SetInformationJobObject, TerminateJobObject,
		},
		SystemInformation::GetSystemDirectoryW,
		Threading::{
			CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
			CreateEventW, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
			GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList, OpenProcess,
			PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
			PROCESS_INFORMATION, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
			PROCESS_SUSPEND_RESUME, QueryFullProcessImageNameW, ResumeThread, STARTF_USESTDHANDLES,
			STARTUPINFOEXW, STARTUPINFOW, SetEvent, TerminateProcess, UpdateProcThreadAttribute,
			WaitForMultipleObjects,
		},
	},
};

use super::{Dir, Leftover, Sessions, Shared, child_end};
use crate::{
	bash::{EnvView, ExitStatus, ExtProc, OsHandle, PgroupSpec, Signal, SpawnSpec, StdioSpec},
	sys::{
		cmdline,
		job::{self, JobOps, JobPause},
		lifecycle::{Abandon, Tracker},
		pump::{End, Feed, Pump, Pumps, os},
	},
};

#[link(name = "ntdll.dll", kind = "raw-dylib", modifiers = "+verbatim")]
unsafe extern "system" {
	/// Suspend every thread of a process (undocumented, stable since NT 5).
	fn NtSuspendProcess(process: HANDLE) -> NTSTATUS;
	/// Undo one [`NtSuspendProcess`].
	fn NtResumeProcess(process: HANDLE) -> NTSTATUS;
}

/// Waiter threads only wait.
const SMALL_STACK: usize = 64 << 10;

/// Registry sweep interval (amortized O(1) per spawn).
const SWEEP: usize = 64;

fn last_error() -> io::Error {
	io::Error::last_os_error()
}

fn check(ok: i32) -> io::Result<()> {
	if ok != 0 { Ok(()) } else { Err(last_error()) }
}

/// Own a handle returned by a Win32 call (null or invalid = error).
fn owned(h: HANDLE) -> io::Result<OwnedHandle> {
	if h.is_null() || h as isize == -1 {
		return Err(last_error());
	}
	// SAFETY: a fresh handle the call returned to us.
	Ok(unsafe { OwnedHandle::from_raw_handle(h as RawHandle) })
}

fn raw(h: &impl AsRawHandle) -> HANDLE {
	h.as_raw_handle() as HANDLE
}

/// Platform state of a spawner: the jobs it created.
pub(super) struct State {
	jobs:    Mutex<Jobs>,
	/// Started with the first job on a pseudoconsole.
	watcher: Mutex<Option<Arc<Watcher>>>,
}

struct Jobs {
	list:       Vec<Arc<Job>>,
	next_sweep: usize,
}

impl State {
	pub(super) const fn new() -> Self {
		Self {
			jobs:    Mutex::new(Jobs { list: Vec::new(), next_sweep: SWEEP }),
			watcher: Mutex::new(None),
		}
	}

	/// The job for `pgroup`: the one led by the pid to join, else a new one on
	/// `console`.
	fn job_for(
		&self,
		pgroup: PgroupSpec,
		console: impl FnOnce() -> JobConsole,
	) -> io::Result<Arc<Job>> {
		if let PgroupSpec::Join(leader) | PgroupSpec::Job { join: Some(leader), .. } = pgroup
			&& let Some(job) = self.jobs.lock().list.iter().find(|j| j.leader() == leader)
		{
			return Ok(Arc::clone(job));
		}
		let job = Job::new(console())?;
		if matches!(job.con, JobConsole::Private(_)) {
			self.watcher()?.watch(&job)?;
		}
		Ok(job)
	}

	fn watcher(&self) -> io::Result<Arc<Watcher>> {
		let mut watcher = self.watcher.lock();
		if let Some(w) = &*watcher {
			return Ok(Arc::clone(w));
		}
		let w = Watcher::start()?;
		*watcher = Some(Arc::clone(&w));
		Ok(w)
	}

	fn record(&self, job: &Arc<Job>) {
		let mut jobs = self.jobs.lock();
		if !jobs.list.iter().any(|j| Arc::ptr_eq(j, job)) {
			jobs.list.push(Arc::clone(job));
		}
		if jobs.list.len() >= jobs.next_sweep {
			// Only the registry holds it and nothing runs in it: done.
			jobs
				.list
				.retain(|j| Arc::strong_count(j) > 1 || j.active().unwrap_or(1) > 0);
			jobs.next_sweep = jobs.list.len() + SWEEP;
		}
	}

	fn jobs(&self) -> Vec<Arc<Job>> {
		self.jobs.lock().list.clone()
	}
}

impl Drop for State {
	fn drop(&mut self) {
		if let Some(w) = self.watcher.get_mut() {
			w.stop();
		}
	}
}

/// `JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO` (`winnt.h`): the job's last process
/// exited.
const JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO: u32 = 4;

/// Closes a job's pseudoconsole when its last process exits, so no idle
/// console host outlives the processes it served: the jobs report that on
/// one completion port, read by one thread.
struct Watcher {
	port: OwnedHandle,
	/// Completion keys (from 1; 0 stops the thread) to the jobs.
	jobs: Mutex<HashMap<usize, Weak<Job>>>,
	next: AtomicUsize,
}

impl Watcher {
	fn start() -> io::Result<Arc<Self>> {
		// SAFETY: a new port, associated with no file.
		let port = unsafe { CreateIoCompletionPort(INVALID_HANDLE_VALUE, ptr::null_mut(), 0, 1) };
		let watcher = Arc::new(Self {
			port: owned(port)?,
			jobs: Mutex::new(HashMap::new()),
			next: AtomicUsize::new(1),
		});
		let run = Arc::clone(&watcher);
		thread::Builder::new()
			.name("obash-console".into())
			.stack_size(SMALL_STACK)
			.spawn(move || run.run())?;
		Ok(watcher)
	}

	/// Report `job`'s emptying to this watcher.
	fn watch(&self, job: &Arc<Job>) -> io::Result<()> {
		let key = self.next.fetch_add(1, Ordering::Relaxed);
		{
			let mut jobs = self.jobs.lock();
			jobs.retain(|_, j| j.strong_count() > 0);
			jobs.insert(key, Arc::downgrade(job));
		}
		let info = JOBOBJECT_ASSOCIATE_COMPLETION_PORT {
			CompletionKey:  ptr::without_provenance_mut(key),
			CompletionPort: raw(&self.port),
		};
		// SAFETY: our job and port handles; `info` is readable for its size.
		check(unsafe {
			SetInformationJobObject(
				raw(&job.handle),
				JobObjectAssociateCompletionPortInformation,
				(&raw const info).cast(),
				mem::size_of_val(&info) as u32,
			)
		})
	}

	fn run(&self) {
		loop {
			let (mut msg, mut key, mut overlapped) = (0u32, 0usize, ptr::null_mut());
			// SAFETY: our port; writable out-parameters.
			let ok = unsafe {
				GetQueuedCompletionStatus(
					raw(&self.port),
					&raw mut msg,
					&raw mut key,
					&raw mut overlapped,
					INFINITE,
				)
			};
			if ok == 0 || key == 0 {
				return;
			}
			if msg != JOB_OBJECT_MSG_ACTIVE_PROCESS_ZERO {
				continue;
			}
			let job = self.jobs.lock().get(&key).and_then(Weak::upgrade);
			if let Some(job) = job
				&& let JobConsole::Private(pty) = &job.con
			{
				pty.close_if_idle(&job);
			}
		}
	}

	fn stop(&self) {
		// SAFETY: our port; key 0 with no overlapped is the stop packet.
		unsafe { PostQueuedCompletionStatus(raw(&self.port), 0, 0, ptr::null()) };
	}
}

/// One Job Object: a pipeline or a single command.
struct Job {
	handle:       OwnedHandle,
	/// Pid of the first process (the job's `pgid`).
	leader:       AtomicU32,
	/// Console process groups of the stages that lead one (each such
	/// stage's pid), on the shared console.
	roots:        Mutex<Vec<u32>>,
	/// A stage stays in the shell's console process group, where no event
	/// can be aimed at it alone.
	shared_group: AtomicBool,
	pause:        Mutex<JobPause<OwnedHandle>>,
	killed:       AtomicBool,
	/// The signal last mapped to a console control event, to name the exit
	/// it causes.
	console:      Mutex<Option<Signal>>,
	/// Where the job's processes attach.
	con:          JobConsole,
}

impl Job {
	fn new(con: JobConsole) -> io::Result<Arc<Self>> {
		// SAFETY: null attributes and name create an anonymous job.
		let handle = owned(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
		Ok(Arc::new(Self {
			handle,
			leader: AtomicU32::new(0),
			roots: Mutex::new(Vec::new()),
			shared_group: AtomicBool::new(false),
			pause: Mutex::new(JobPause::default()),
			killed: AtomicBool::new(false),
			console: Mutex::new(None),
			con,
		}))
	}

	fn leader(&self) -> u32 {
		self.leader.load(Ordering::Acquire)
	}

	fn terminate(&self) -> io::Result<()> {
		self.killed.store(true, Ordering::Release);
		// SAFETY: our job handle.
		check(unsafe { TerminateJobObject(raw(&self.handle), job::KILL_EXIT_CODE) })
	}

	/// A console control event to every stage. On a pseudoconsole TERM and HUP
	/// hang it up (`CTRL_CLOSE`), INT and QUIT send `CTRL_C`; on the shared
	/// console each stage's group gets `CTRL_BREAK_EVENT`; a hidden console,
	/// or a stage in the shell's own group (an event to its pid would not be
	/// its alone), is out of reach (`Unsupported`).
	fn interrupt(&self, sig: Signal) -> io::Result<()> {
		*self.console.lock() = Some(sig);
		match &self.con {
			JobConsole::Shared if self.shared_group.load(Ordering::Acquire) => {
				return Err(io::ErrorKind::Unsupported.into());
			},
			JobConsole::Shared => {},
			JobConsole::Private(pty) if matches!(sig, Signal::Term | Signal::Hup) => {
				pty.hang_up();
				return Ok(());
			},
			JobConsole::Private(pty) => return pty.interrupt(),
			JobConsole::Own => return Err(io::ErrorKind::Unsupported.into()),
		}
		let roots = self.roots.lock().clone();
		let mut result = Ok(());
		for root in roots {
			// SAFETY: plain call with scalar arguments.
			if unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, root) } == 0 && result.is_ok() {
				result = Err(last_error());
			}
		}
		result
	}

	fn active(&self) -> io::Result<u32> {
		let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
		// SAFETY: `info` is writable for its size.
		check(unsafe {
			QueryInformationJobObject(
				raw(&self.handle),
				JobObjectBasicAccountingInformation,
				(&raw mut info).cast(),
				mem::size_of_val(&info) as u32,
				ptr::null_mut(),
			)
		})?;
		Ok(info.ActiveProcesses)
	}

	/// Pids of the processes currently in the job.
	fn pids(&self) -> io::Result<Vec<u32>> {
		let header = mem::offset_of!(JOBOBJECT_BASIC_PROCESS_ID_LIST, ProcessIdList);
		let mut slots = 64usize;
		loop {
			// usize-aligned buffer: the header, then `slots` ids.
			let words = header.div_ceil(mem::size_of::<usize>()) + slots;
			let mut buf = vec![0usize; words];
			let bytes = (words * mem::size_of::<usize>()) as u32;
			// SAFETY: `buf` is writable for `bytes` bytes and aligned for the
			// list.
			let ok = unsafe {
				QueryInformationJobObject(
					raw(&self.handle),
					JobObjectBasicProcessIdList,
					buf.as_mut_ptr().cast(),
					bytes,
					ptr::null_mut(),
				)
			};
			if ok == 0 {
				let e = last_error();
				if e.raw_os_error() == Some(ERROR_MORE_DATA as i32) {
					slots *= 4;
					continue;
				}
				return Err(e);
			}
			let list = buf.as_ptr().cast::<JOBOBJECT_BASIC_PROCESS_ID_LIST>();
			// SAFETY: the call filled the header; ids follow at `header` within
			// `buf`, and the kernel never reports more than fit.
			let ids = unsafe {
				let n = ((*list).NumberOfProcessIdsInList as usize).min(slots);
				std::slice::from_raw_parts(buf.as_ptr().cast::<u8>().add(header).cast::<usize>(), n)
			};
			return Ok(ids.iter().map(|&id| id as u32).collect());
		}
	}
}

/// Where a job's processes attach, by the spawner's ownership of the job.
enum JobConsole {
	/// The host's console (`Sessions::Share`, `Sessions::Inherit`).
	Shared,
	/// A pseudoconsole the spawner holds while the job's processes run: owned
	/// externals under `Sessions::Detach`, which must not outlive the shell.
	Private(Pty),
	/// A hidden console of the job's own: released (`nohup`) externals under
	/// `Sessions::Detach`, which outlive the shell and its host process.
	Own,
}

impl JobConsole {
	const fn new(sessions: Sessions, released: bool) -> Self {
		match (sessions, released) {
			(Sessions::Detach, false) => Self::Private(Pty::new()),
			(Sessions::Detach, true) => Self::Own,
			_ => Self::Shared,
		}
	}
}

/// A job's private pseudoconsole, open while processes run on it: opened for
/// the first process attached, closed when the job empties ([`Watcher`]) or
/// on TERM/HUP; a stage attached later opens a new one.
struct Pty {
	open: Mutex<Option<Console>>,
}

impl Pty {
	const fn new() -> Self {
		Self { open: Mutex::new(None) }
	}

	/// The console, opened if closed, locked so that no hang-up or idle close
	/// takes it while a process is being attached and assigned to the job.
	fn attach(&self) -> io::Result<MappedMutexGuard<'_, Console>> {
		let mut open = self.open.lock();
		if open.is_none() {
			*open = Some(Console::new()?);
		}
		Ok(MutexGuard::map(open, |c| c.as_mut().expect("opened above")))
	}

	/// `CTRL_C_EVENT` to the attached processes; ignored by those that
	/// inherited an ignored Ctrl-C (a parent in a new process group). Fails
	/// when the console is closed: nothing runs on it.
	fn interrupt(&self) -> io::Result<()> {
		match &*self.open.lock() {
			Some(console) => (&console.input).write_all(&[0x03]),
			None => Err(io::ErrorKind::BrokenPipe.into()),
		}
	}

	/// Close the console: `CTRL_CLOSE_EVENT` to every attached process, which
	/// none can ignore, and termination 5 s later by the system for those
	/// still handling it.
	fn hang_up(&self) {
		self.open.lock().take();
	}

	/// Close the console if nothing runs in `job`. Under the lock: a process
	/// being attached is assigned to the job before `attach` lets go, so it
	/// either counts here or finds the console closed and opens a new one.
	fn close_if_idle(&self, job: &Job) {
		let mut open = self.open.lock();
		if job.active().is_ok_and(|n| n == 0) {
			open.take();
		}
	}
}

/// An open pseudoconsole. Its output goes to `NUL`, so the console host
/// never blocks on a full pipe and no reader thread is needed.
struct Console {
	hpc:   HPCON,
	/// The console's input: an ETX here raises `CTRL_C_EVENT` in every
	/// attached process that does not ignore it.
	input: io::PipeWriter,
}

impl Console {
	/// Size reported to programs that query the console (progress bars).
	const SIZE: COORD = COORD { X: 120, Y: 30 };

	fn new() -> io::Result<Self> {
		let (reader, input) = io::pipe()?;
		let sink = fs::File::options().write(true).open("NUL")?;
		let mut hpc: HPCON = 0;
		// No `PSEUDOCONSOLE_INHERIT_CURSOR`: only with it does the console
		// host query the cursor (`ESC[6n`) and wait for the reply before its
		// clients run (the hang `pi-natives`' `pty.rs` answers for
		// portable-pty, which sets it), so the discarded output needs none.
		// SAFETY: open handles (the console host duplicates them) and a
		// writable `hpc`.
		let hr =
			unsafe { CreatePseudoConsole(Self::SIZE, raw(&reader), raw(&sink), 0, &raw mut hpc) };
		if hr < 0 {
			return Err(io::Error::from_raw_os_error(hr));
		}
		Ok(Self { hpc, input })
	}
}

impl Drop for Console {
	fn drop(&mut self) {
		// SAFETY: created in `new`, closed once.
		unsafe { ClosePseudoConsole(self.hpc) };
	}
}

/// Members of a job, opened and checked to still be in it.
struct Ops<'a>(&'a Job);

impl JobOps for Ops<'_> {
	type Member = OwnedHandle;

	fn members(&self) -> io::Result<Vec<OwnedHandle>> {
		let mut out = Vec::new();
		for pid in self.0.pids()? {
			// SAFETY: plain call with scalar arguments.
			let h = unsafe {
				OpenProcess(PROCESS_SUSPEND_RESUME | PROCESS_QUERY_LIMITED_INFORMATION, 0, pid)
			};
			let h = match owned(h) {
				Ok(h) => h,
				// Exited since the listing.
				Err(e) if e.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) => continue,
				Err(e) => return Err(e),
			};
			// The pid may have been recycled: only real members count.
			let mut inside = 0;
			// SAFETY: both handles are open; `inside` is writable.
			check(unsafe { IsProcessInJob(raw(&h), raw(&self.0.handle), &raw mut inside) })?;
			if inside != 0 {
				out.push(h);
			}
		}
		Ok(out)
	}

	fn suspend(&self, m: &OwnedHandle) -> io::Result<()> {
		// SAFETY: an open process handle with PROCESS_SUSPEND_RESUME.
		nt(unsafe { NtSuspendProcess(raw(m)) })
	}

	fn resume(&self, m: &OwnedHandle) -> io::Result<()> {
		// SAFETY: as above.
		nt(unsafe { NtResumeProcess(raw(m)) })
	}
}

/// `STATUS_PROCESS_IS_TERMINATING`: the member is exiting.
const PROCESS_IS_TERMINATING: NTSTATUS = 0xc000_010a_u32 as NTSTATUS;

fn nt(status: NTSTATUS) -> io::Result<()> {
	match status {
		s if s >= 0 => Ok(()),
		PROCESS_IS_TERMINATING => Err(io::ErrorKind::NotFound.into()),
		s => Err(io::Error::other(NtError(s))),
	}
}

/// A failed native call.
#[derive(Debug, thiserror::Error)]
#[error("NTSTATUS {0:#010x}")]
struct NtError(NTSTATUS);

pub(super) fn dup(h: OsHandle) -> io::Result<fs::File> {
	let raw = ptr::with_exposed_provenance_mut::<c_void>(h.0 as usize);
	// SAFETY: the engine keeps the file object that owns this handle alive
	// for the whole spawn call.
	let borrowed = unsafe { BorrowedHandle::borrow_raw(raw) };
	Ok(fs::File::from(borrowed.try_clone_to_owned()?))
}

fn invalid(e: impl Into<Box<dyn std::error::Error + Send + Sync>>) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidInput, e)
}

/// NUL-terminated UTF-16 of engine bytes.
fn wide(b: &BStr) -> io::Result<Vec<u16>> {
	let s = b.to_str().map_err(invalid)?;
	if s.contains('\0') {
		return Err(invalid("path contains a NUL byte"));
	}
	Ok(s.encode_utf16().chain([0]).collect())
}

/// `%SystemRoot%\System32\cmd.exe`, NUL-terminated.
fn system_cmd() -> io::Result<Vec<u16>> {
	let mut buf = vec![0u16; 260];
	// SAFETY: `buf` is writable for its length.
	let n = unsafe { GetSystemDirectoryW(buf.as_mut_ptr(), buf.len() as u32) } as usize;
	if n == 0 || n >= buf.len() {
		return Err(last_error());
	}
	buf.truncate(n);
	buf.extend("\\cmd.exe".encode_utf16().chain([0]));
	Ok(buf)
}

/// Application name and mutable command line (both NUL-terminated).
fn command(path: &BStr, argv: &[BString]) -> io::Result<(Vec<u16>, Vec<u16>)> {
	let mut line = if cmdline::is_batch(path) {
		cmdline::batch_command_line(path, argv.get(1..).unwrap_or_default())
	} else if argv.is_empty() {
		cmdline::command_line(&[path])
	} else {
		cmdline::command_line(argv)
	}
	.map_err(invalid)?;
	line.push(0);
	let app = if cmdline::is_batch(path) {
		system_cmd()?
	} else {
		wide(path)?
	};
	Ok((app, line))
}

/// `CREATE_UNICODE_ENVIRONMENT` block: `K=V\0…\0`, sorted by name without
/// case as Windows requires (case-insensitive duplicates: the last wins).
fn env_block(env: &EnvView) -> io::Result<Vec<u16>> {
	let mut vars: Vec<(String, &str)> = Vec::with_capacity(env.len());
	for (k, v) in env.iter() {
		let k = k.to_str().map_err(invalid)?;
		let v = v.to_str().map_err(invalid)?;
		// Names may start with `=` (the per-drive `=C:` variables).
		if k.contains('\0') || v.contains('\0') || k.get(1..).is_some_and(|r| r.contains('=')) {
			return Err(invalid("environment entry contains NUL or `=` in its name"));
		}
		vars.push((k.to_uppercase(), v));
	}
	let names: Vec<&str> = env
		.iter()
		.map(|(k, _)| k.to_str().unwrap_or_default())
		.collect();
	let mut order: Vec<usize> = (0..vars.len()).collect();
	order.sort_by(|&a, &b| vars[a].0.cmp(&vars[b].0));
	order.dedup_by(|later, earlier| {
		let same = vars[*later].0 == vars[*earlier].0;
		if same {
			*earlier = *later;
		}
		same
	});
	let mut block = Vec::new();
	for i in order {
		block.extend(names[i].encode_utf16());
		block.push(u16::from(b'='));
		block.extend(vars[i].1.encode_utf16());
		block.push(0);
	}
	if block.is_empty() {
		block.push(0);
	}
	block.push(0);
	Ok(block)
}

/// The child's handle for one stream (`NUL` for `Null`), inheritable.
fn child_handle(
	shared: &Shared,
	spec: StdioSpec,
	dir: Dir,
	pumps: &mut Vec<Pump>,
	held: &mut Vec<Arc<Feed>>,
) -> io::Result<OwnedHandle> {
	let file = match child_end(shared, spec, dir, pumps, held)? {
		Some(f) => f,
		None => fs::File::options().read(true).write(true).open("NUL")?,
	};
	let h = OwnedHandle::from(file);
	// SAFETY: our own private duplicate; it is closed right after the spawn.
	check(unsafe { SetHandleInformation(raw(&h), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) })?;
	Ok(h)
}

/// A process attribute list: the handle list to inherit, and the
/// pseudoconsole to attach to.
struct Attributes {
	buf: Vec<usize>,
}

impl Attributes {
	fn new(handles: &[HANDLE], pty: Option<HPCON>) -> io::Result<Self> {
		let count = 1 + u32::from(pty.is_some());
		let mut size = 0usize;
		// SAFETY: a null list with a size pointer is the documented size query
		// (it "fails" with ERROR_INSUFFICIENT_BUFFER).
		unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), count, 0, &raw mut size) };
		let mut buf = vec![0usize; size.div_ceil(mem::size_of::<usize>())];
		// SAFETY: `buf` holds at least `size` bytes, aligned.
		check(unsafe {
			InitializeProcThreadAttributeList(buf.as_mut_ptr().cast(), count, 0, &raw mut size)
		})?;
		// Initialized: from here on, drop deletes it.
		let mut a = Self { buf };
		// SAFETY: the list is initialized; `handles` outlives CreateProcessW
		// (the caller keeps it alive across the call).
		let mut ok = unsafe {
			UpdateProcThreadAttribute(
				a.list(),
				0,
				PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
				handles.as_ptr().cast(),
				mem::size_of_val(handles),
				ptr::null_mut(),
				ptr::null(),
			)
		};
		if ok != 0
			&& let Some(hpc) = pty
		{
			// SAFETY: as above; the attribute's value is the `HPCON` itself, which
			// the job keeps open past CreateProcessW.
			ok = unsafe {
				UpdateProcThreadAttribute(
					a.list(),
					0,
					PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
					ptr::with_exposed_provenance(hpc as usize),
					mem::size_of::<HPCON>(),
					ptr::null_mut(),
					ptr::null(),
				)
			};
		}
		if ok == 0 {
			let e = last_error();
			// SAFETY: initialized above.
			unsafe { DeleteProcThreadAttributeList(a.list()) };
			a.buf.clear();
			return Err(e);
		}
		Ok(a)
	}

	const fn list(&mut self) -> *mut c_void {
		self.buf.as_mut_ptr().cast()
	}
}

impl Drop for Attributes {
	fn drop(&mut self) {
		if !self.buf.is_empty() {
			// SAFETY: initialized in `with_handles`.
			unsafe { DeleteProcThreadAttributeList(self.list()) };
		}
	}
}

/// Shared by a [`WinProc`] and its waiter thread.
struct Inner {
	process: OwnedHandle,
	/// Auto-reset event that makes the waiter recompute its deadline.
	wake:    OwnedHandle,
	job:     Arc<Job>,
}

impl Inner {
	fn nudge(&self) {
		// SAFETY: our event handle.
		unsafe { SetEvent(raw(&self.wake)) };
	}
}

/// `argv` with each `/dev/fd/N` of an extra fd (a process substitution's)
/// replaced by a named pipe the child opens by path, pumped from fd N's
/// engine object when the engine reads it (`<(…)`: the child reads), else
/// into it (`>(…)`). Extra fds the arguments do not name stay behind: no
/// Windows program takes an inherited fd by number.
fn bridge_fds(
	argv: &[BString],
	extra: Vec<(i32, StdioSpec)>,
	pumps: &mut Vec<Pump>,
) -> io::Result<Vec<BString>> {
	let mut argv = argv.to_vec();
	for (fd, spec) in extra {
		let word = format!("/dev/fd/{fd}");
		if !argv
			.iter()
			.any(|a| fd_path_at(a, word.as_bytes()).is_some())
		{
			continue;
		}
		let mut end = match spec {
			StdioSpec::Pipe(f) => End::Fd(f),
			StdioSpec::File(f) => End::File(f),
			StdioSpec::Inherit(_) | StdioSpec::Null | StdioSpec::Closed => continue,
		};
		let child_reads = end.direction().0;
		let (ours, name) = os::named_pipe(child_reads)?;
		pumps.push(if child_reads {
			Pump::In(end, ours)
		} else {
			Pump::Out(ours, end)
		});
		for a in &mut argv {
			while let Some(at) = fd_path_at(a, word.as_bytes()) {
				a.splice(at..at + word.len(), name.bytes());
			}
		}
	}
	Ok(argv)
}

/// Where `arg` names `word` (`/dev/fd/N`) whole, not as the start of a
/// longer number (`/dev/fd/63` for `/dev/fd/6`).
fn fd_path_at(arg: &[u8], word: &[u8]) -> Option<usize> {
	let mut from = 0;
	while let Some(i) = arg[from..].find(word) {
		let at = from + i;
		let end = at + word.len();
		if !arg.get(end).is_some_and(u8::is_ascii_digit) {
			return Some(at);
		}
		from = end;
	}
	None
}

pub(super) fn spawn(shared: &Arc<Shared>, spec: SpawnSpec<'_>) -> io::Result<Box<dyn ExtProc>> {
	if !spec.rlimits.is_empty() {
		// No per-process resource limits on Windows.
		return Err(io::ErrorKind::Unsupported.into());
	}
	if spec.redirs.is_some() {
		// No fork: a process cannot apply redirections itself (a host keeps
		// `Host::child_opens` false here).
		return Err(io::ErrorKind::Unsupported.into());
	}
	if spec.ctty.is_some() {
		// No controlling terminals on Windows.
		return Err(io::ErrorKind::Unsupported.into());
	}
	let SpawnSpec { path, argv, env, cwd, stdio, pgroup, lineage, sigmask_ign, extra_fds, .. } =
		spec;
	// On the shared console a stage that must not get the keyboard's Ctrl-C
	// leads a group of its own (Ctrl-C off in it): it ignores `SIGINT` (an
	// asynchronous command without job control) or is a background job of
	// job control. Others stay in the shell's group, as a Unix terminal's
	// foreground gets `SIGINT`.
	let own_group =
		sigmask_ign.contains(Signal::Int) || matches!(pgroup, PgroupSpec::Job { terminal: None, .. });
	let mut pumps = Vec::new();
	let argv = bridge_fds(argv, extra_fds, &mut pumps)?;
	let (app, mut line) = command(path, &argv)?;
	let env = env_block(env)?;
	let cwd = wide(cwd)?;
	let job = shared
		.state
		.job_for(pgroup, || JobConsole::new(shared.config.sessions, lineage.detached))?;
	let mut feeds = Vec::new();
	let [stdin, stdout, stderr] = stdio;
	let handles = [
		child_handle(shared, stdin, Dir::In, &mut pumps, &mut feeds)?,
		child_handle(shared, stdout, Dir::Out, &mut pumps, &mut feeds)?,
		child_handle(shared, stderr, Dir::Out, &mut pumps, &mut feeds)?,
	];
	let tracker = Tracker::new(pumps.iter().map(Pump::outputs).sum());
	// Polled by the `ExtProc`; dropped (stopping every pump) on any failure
	// below.
	let pumps = Pumps::new(pumps, feeds, &tracker);
	let created = create(&app, &mut line, &env, &cwd, &handles, &job, own_group);
	// Our copies of the child's ends: pumps see end of file when it closes
	// its own.
	drop(handles);
	let (process, pid) = created?;
	let _ = job
		.leader
		.compare_exchange(0, pid, Ordering::AcqRel, Ordering::Acquire);
	match job.con {
		JobConsole::Shared if own_group => {
			job.roots.lock().push(pid);
			GROUP_LEADERS.lock().push((job.leader(), pid));
		},
		JobConsole::Shared => job.shared_group.store(true, Ordering::Release),
		_ => job.roots.lock().push(pid),
	}
	// A detached external is meant to outlive the shell: not a leak.
	if !lineage.detached {
		shared.state.record(&job);
	}
	// SAFETY: auto-reset, initially unsignaled, anonymous event.
	let wake = match owned(unsafe { CreateEventW(ptr::null(), 0, 0, ptr::null()) }) {
		Ok(h) => h,
		Err(e) => return Err(undo(&process, e)),
	};
	let inner = Arc::new(Inner { process, wake, job });
	let (w_inner, w_tracker) = (Arc::clone(&inner), Arc::clone(&tracker));
	let started = thread::Builder::new()
		.name("obash-wait".into())
		.stack_size(SMALL_STACK)
		.spawn(move || wait_loop(&w_inner, &w_tracker));
	if let Err(e) = started {
		return Err(undo(&inner.process, e));
	}
	Ok(Box::new(WinProc {
		pid,
		inner,
		tracker,
		shared: Arc::clone(shared),
		detached: lineage.detached,
		pumps,
	}))
}

/// Without a waiter nobody would observe the exit: kill the child.
fn undo(process: &OwnedHandle, e: io::Error) -> io::Error {
	// SAFETY: an open process handle.
	unsafe { TerminateProcess(raw(process), job::KILL_EXIT_CODE) };
	e
}

/// `CreateProcessW` suspended, into `job` (and its console), then resumed.
fn create(
	app: &[u16],
	line: &mut [u16],
	env: &[u16],
	cwd: &[u16],
	handles: &[OwnedHandle; 3],
	job: &Job,
	own_group: bool,
) -> io::Result<(OwnedHandle, u32)> {
	let mut list: Vec<HANDLE> = Vec::with_capacity(3);
	for h in handles {
		if !list.contains(&raw(h)) {
			list.push(raw(h));
		}
	}
	// Held until the process is in the job: no hang-up or idle close takes
	// the console from under it.
	let attached = match &job.con {
		JobConsole::Private(pty) => Some(pty.attach()?),
		JobConsole::Shared | JobConsole::Own => None,
	};
	let mut attrs = Attributes::new(&list, attached.as_ref().map(|c| c.hpc))?;
	let mut si = STARTUPINFOEXW::default();
	si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
	si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	si.StartupInfo.hStdInput = raw(&handles[0]);
	si.StartupInfo.hStdOutput = raw(&handles[1]);
	si.StartupInfo.hStdError = raw(&handles[2]);
	si.lpAttributeList = attrs.list();
	let mut pi = PROCESS_INFORMATION::default();
	let console = match job.con {
		// A group of its own keeps the keyboard's Ctrl-C away and
		// CTRL_BREAK targetable.
		JobConsole::Shared if own_group => CREATE_NEW_PROCESS_GROUP,
		JobConsole::Shared => 0,
		// Ctrl-C reaches every process of the pseudoconsole.
		JobConsole::Private(_) => 0,
		JobConsole::Own => CREATE_NO_WINDOW,
	};
	let flags =
		CREATE_SUSPENDED | console | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT;
	// SAFETY: every pointer is valid for the call: NUL-terminated wide
	// strings, a writable command line, the environment block, the startup
	// info with its attribute list and handle list kept alive until return.
	check(unsafe {
		CreateProcessW(
			app.as_ptr(),
			line.as_mut_ptr(),
			ptr::null(),
			ptr::null(),
			1,
			flags,
			env.as_ptr().cast(),
			cwd.as_ptr(),
			(&raw const si).cast::<STARTUPINFOW>(),
			&raw mut pi,
		)
	})?;
	drop(attrs);
	let process = owned(pi.hProcess)?;
	let thread = owned(pi.hThread)?;
	// SAFETY: open job and process handles.
	if let Err(e) = check(unsafe { AssignProcessToJobObject(raw(&job.handle), raw(&process)) }) {
		// SAFETY: the suspended child never ran.
		unsafe { TerminateProcess(raw(&process), 1) };
		return Err(e);
	}
	// SAFETY: the child's primary thread, created suspended.
	if unsafe { ResumeThread(raw(&thread)) } == u32::MAX {
		let e = last_error();
		// SAFETY: as above.
		unsafe { TerminateProcess(raw(&process), 1) };
		return Err(e);
	}
	Ok((process, pi.dwProcessId))
}

/// The shared-console stages that lead a console process group of their
/// own, as (job leader, stage pid), while their `ExtProc` lives (so a pid
/// here is never reused).
static GROUP_LEADERS: Mutex<Vec<(u32, u32)>> = Mutex::new(Vec::new());

/// Whether the job led by `pgid` has stages leading console process groups
/// of their own: a job `fg` brought to the foreground, which the keyboard's
/// Ctrl-C does not reach ([`break_console_groups`] forwards it).
pub(crate) fn has_console_groups(pgid: u32) -> bool {
	GROUP_LEADERS.lock().iter().any(|&(job, _)| job == pgid)
}

/// Send `CTRL_BREAK_EVENT` to every console group the stages of the job
/// led by `pgid` lead (each pipeline stage leads its own); false when none
/// is left. An event to a group reaches it and nothing else.
pub(crate) fn break_console_groups(pgid: u32) -> bool {
	let leaders = GROUP_LEADERS.lock();
	let mut sent = false;
	for &(_, pid) in leaders.iter().filter(|&&(job, _)| job == pgid) {
		// SAFETY: plain call with scalar arguments.
		sent |= unsafe { GenerateConsoleCtrlEvent(CTRL_BREAK_EVENT, pid) } != 0;
	}
	sent
}

/// Wait for the exit; meanwhile fire a due KILL. After the exit, a pending
/// KILL (TERM or abandon) still sweeps stragglers left in the job.
fn wait_loop(inner: &Inner, tracker: &Tracker) {
	let handles = [raw(&inner.process), raw(&inner.wake)];
	loop {
		let due = tracker.lock().kill_due();
		let timeout = due.map_or(INFINITE, |d| {
			d.saturating_duration_since(Instant::now())
				.as_millis()
				.min(u128::from(INFINITE - 1)) as u32
		});
		// SAFETY: two open handles.
		let r = unsafe { WaitForMultipleObjects(2, handles.as_ptr(), 0, timeout) };
		if r == WAIT_OBJECT_0 {
			let mut code = 0u32;
			// SAFETY: an exited process handle; `code` is writable.
			let ok = unsafe { GetExitCodeProcess(raw(&inner.process), &raw mut code) };
			let status = if ok == 0 {
				ExitStatus::Exited(127)
			} else {
				let console = *inner.job.console.lock();
				job::exit_status(code, inner.job.killed.load(Ordering::Acquire), console)
			};
			tracker.exited(status);
			if let Some(due) = due {
				thread::sleep(due.saturating_duration_since(Instant::now()));
				if inner.job.active().unwrap_or(0) > 0 {
					let _ = inner.job.terminate();
				}
			}
			return;
		}
		if r == WAIT_OBJECT_0 + 1 {
			continue;
		}
		if r == WAIT_TIMEOUT {
			if tracker.lock().take_kill(Instant::now()) {
				let _ = inner.job.terminate();
			}
			continue;
		}
		// WAIT_FAILED: nothing sensible to wait on; report a failure.
		tracker.exited(ExitStatus::Exited(127));
		return;
	}
}

/// A spawned external in its job.
struct WinProc {
	pid:      u32,
	inner:    Arc<Inner>,
	tracker:  Arc<Tracker>,
	shared:   Arc<Shared>,
	/// [`crate::bash::Lineage::detached`]: dropping it while it runs leaves
	/// the job alone.
	detached: bool,
	/// The child's pumps and the shared input feeds it holds (kept open
	/// while this lives), driven by `poll_wait`.
	pumps:    Pumps,
}

impl WinProc {
	fn grace(&self) -> Duration {
		self.shared.config.grace
	}

	/// TERM-like signals: a console control event, or KILL when it cannot be
	/// delivered.
	fn interrupt(&self, sig: Signal, escalate: bool) -> io::Result<()> {
		let mut life = self.tracker.lock();
		life.signalled(sig);
		if self.inner.job.interrupt(sig).is_err() {
			life.signalled(Signal::Kill);
			return self.inner.job.terminate();
		}
		if escalate {
			life.schedule_kill(Instant::now() + self.grace());
			drop(life);
			self.inner.nudge();
		}
		Ok(())
	}
}

impl ExtProc for WinProc {
	fn pid(&self) -> u32 {
		self.pid
	}

	/// The job's first process: what later stages join
	/// ([`PgroupSpec::Join`], [`PgroupSpec::Job`]) and what job control
	/// hands the terminal to ([`has_console_groups`] when its stages lead
	/// console groups of their own).
	fn pgid(&self) -> Option<u32> {
		Some(self.inner.job.leader())
	}

	fn poll_wait(&mut self, cx: &mut Context<'_>) -> Poll<ExitStatus> {
		self.pumps.poll(cx, &self.tracker);
		self.tracker.poll(cx)
	}

	fn signal(&mut self, sig: Signal) -> io::Result<()> {
		match sig {
			Signal::Kill => {
				self.tracker.lock().signalled(Signal::Kill);
				self.inner.job.terminate()
			},
			Signal::Term => self.interrupt(sig, true),
			Signal::Int | Signal::Hup | Signal::Quit => self.interrupt(sig, false),
			Signal::Stop | Signal::Tstp | Signal::Ttin | Signal::Ttou => self.stop(),
			Signal::Cont => self.cont(),
			_ => Err(io::ErrorKind::Unsupported.into()),
		}
	}

	fn stop(&mut self) -> io::Result<()> {
		let job = &self.inner.job;
		job.pause.lock().pause(&Ops(job))
	}

	fn cont(&mut self) -> io::Result<()> {
		let job = &self.inner.job;
		job.pause.lock().resume(&Ops(job))
	}
}

impl Drop for WinProc {
	fn drop(&mut self) {
		GROUP_LEADERS.lock().retain(|&(_, p)| p != self.pid);
		// The pumps (and the feeds) stop when the fields drop, after this.
		let mut life = self.tracker.lock();
		if self.detached {
			// Runs on: its waiter observes the exit and releases it.
			life.release();
			return;
		}
		if let Abandon::Escalate { term, .. } = life.abandon(Instant::now(), self.grace()) {
			drop(life);
			let job = &self.inner.job;
			// A suspended job cannot handle a console control event.
			let _ = job.pause.lock().resume(&Ops(job));
			if term && job.interrupt(Signal::Term).is_err() {
				self.tracker.lock().signalled(Signal::Kill);
				let _ = job.terminate();
			}
			self.inner.nudge();
		}
	}
}

fn image_name(pid: u32) -> BString {
	// SAFETY: plain call with scalar arguments.
	let Ok(h) = owned(unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) }) else {
		return BString::default();
	};
	let mut buf = vec![0u16; 1024];
	let mut len = buf.len() as u32;
	// SAFETY: `buf` is writable for `len` units.
	let ok = unsafe {
		QueryFullProcessImageNameW(raw(&h), PROCESS_NAME_WIN32, buf.as_mut_ptr(), &raw mut len)
	};
	if ok == 0 {
		return BString::default();
	}
	BString::from(String::from_utf16_lossy(&buf[..len as usize]))
}

fn leftover_jobs(shared: &Shared) -> io::Result<Vec<(Arc<Job>, Vec<u32>)>> {
	let me = std::process::id();
	let mut out = Vec::new();
	for job in shared.state.jobs() {
		let pids: Vec<u32> = job.pids()?.into_iter().filter(|&p| p != me).collect();
		if !pids.is_empty() {
			out.push((job, pids));
		}
	}
	Ok(out)
}

pub(super) fn leftovers(shared: &Shared) -> io::Result<Vec<Leftover>> {
	Ok(leftover_jobs(shared)?
		.iter()
		.flat_map(|(job, pids)| {
			pids
				.iter()
				.map(|&pid| Leftover { pid, group: job.leader(), name: image_name(pid) })
		})
		.collect())
}

pub(super) fn kill_leftovers(shared: &Shared) -> io::Result<Vec<Leftover>> {
	let mut killed = Vec::new();
	for (job, pids) in leftover_jobs(shared)? {
		let names: Vec<Leftover> = pids
			.iter()
			.map(|&pid| Leftover { pid, group: job.leader(), name: image_name(pid) })
			.collect();
		job.terminate()?;
		killed.extend(names);
	}
	Ok(killed)
}

#[cfg(test)]
mod tests;
