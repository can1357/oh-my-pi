//! Windows spawning: `CreateProcessW` into a Job Object per job.
//!
//! - **Start.** The child is created suspended in a new console process group
//!   (`CREATE_NEW_PROCESS_GROUP`), assigned to its job, then resumed, so
//!   nothing it starts escapes the job. Only its three stdio handles are
//!   inherited (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`), so concurrent spawns
//!   never leak pipe ends into each other. The command line uses MSVCRT
//!   quoting; `.bat`/`.cmd` run through `cmd.exe` with std's hardened batch
//!   quoting ([`crate::sys::cmdline`]).
//! - **Jobs.** `PgroupSpec::New` creates a job; `Join(pid)` adds the stage to
//!   the job led by `pid`. Signals map to the job: KILL = `TerminateJobObject`
//!   (members exit 137, reported as `Signaled(KILL)`); TERM, INT, HUP, QUIT =
//!   `CTRL_BREAK_EVENT` to each stage's console group, and after TERM a KILL
//!   once the grace expires (console programs often ignore the event); when the
//!   event cannot be delivered (no shared console) the job is killed at once.
//!   Pause = `NtSuspendProcess` per member, resume = `NtResumeProcess` on
//!   exactly those ([`crate::sys::job`]).
//! - **Fds.** Extra fds (> 2) fail with `Unsupported` ([`UnsupportedFd`]).

use std::{
	ffi::c_void,
	fs, io, mem,
	os::windows::io::{AsRawHandle, BorrowedHandle, FromRawHandle, OwnedHandle, RawHandle},
	ptr,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU32, Ordering},
	},
	task::{Context, Poll},
	thread,
	time::{Duration, Instant},
};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;
use windows_sys::Win32::{
	Foundation::{
		ERROR_INVALID_PARAMETER, ERROR_MORE_DATA, HANDLE, HANDLE_FLAG_INHERIT, NTSTATUS,
		SetHandleInformation, WAIT_OBJECT_0, WAIT_TIMEOUT,
	},
	System::{
		Console::{CTRL_BREAK_EVENT, GenerateConsoleCtrlEvent},
		JobObjects::{
			AssignProcessToJobObject, CreateJobObjectW, IsProcessInJob,
			JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, JOBOBJECT_BASIC_PROCESS_ID_LIST,
			JobObjectBasicAccountingInformation, JobObjectBasicProcessIdList,
			QueryInformationJobObject, TerminateJobObject,
		},
		SystemInformation::GetSystemDirectoryW,
		Threading::{
			CREATE_NEW_PROCESS_GROUP, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateEventW,
			CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
			GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList, OpenProcess,
			PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROCESS_INFORMATION, PROCESS_NAME_WIN32,
			PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SUSPEND_RESUME, QueryFullProcessImageNameW,
			ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW, STARTUPINFOW, SetEvent,
			TerminateProcess, UpdateProcThreadAttribute, WaitForMultipleObjects,
		},
	},
};

use super::{Dir, Leftover, Shared, UnsupportedFd, child_end};
use crate::{
	bash::{EnvView, ExitStatus, ExtProc, OsHandle, PgroupSpec, Signal, SpawnSpec, StdioSpec},
	sys::{
		cmdline,
		job::{self, JobOps, JobPause},
		lifecycle::{Abandon, Tracker},
		pump::{Feed, Pump, Pumps},
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
	jobs: Mutex<Jobs>,
}

struct Jobs {
	list:       Vec<Arc<Job>>,
	next_sweep: usize,
}

impl State {
	pub(super) const fn new() -> Self {
		Self { jobs: Mutex::new(Jobs { list: Vec::new(), next_sweep: SWEEP }) }
	}

	/// The job for `pgroup`: the one led by the pid to join, else a new one.
	fn job_for(&self, pgroup: PgroupSpec) -> io::Result<Arc<Job>> {
		if let PgroupSpec::Join(leader) = pgroup
			&& let Some(job) = self.jobs.lock().list.iter().find(|j| j.leader() == leader)
		{
			return Ok(Arc::clone(job));
		}
		Job::new()
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

/// One Job Object: a pipeline or a single command.
struct Job {
	handle:  OwnedHandle,
	/// Pid of the first process (the job's `pgid`).
	leader:  AtomicU32,
	/// Console process groups of the stages (each stage's pid).
	roots:   Mutex<Vec<u32>>,
	pause:   Mutex<JobPause<OwnedHandle>>,
	killed:  AtomicBool,
	/// The signal last mapped to `CTRL_BREAK`, to name the exit it causes.
	console: Mutex<Option<Signal>>,
}

impl Job {
	fn new() -> io::Result<Arc<Self>> {
		// SAFETY: null attributes and name create an anonymous job.
		let handle = owned(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) })?;
		Ok(Arc::new(Self {
			handle,
			leader: AtomicU32::new(0),
			roots: Mutex::new(Vec::new()),
			pause: Mutex::new(JobPause::default()),
			killed: AtomicBool::new(false),
			console: Mutex::new(None),
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

	/// `CTRL_BREAK_EVENT` to every stage's console group.
	fn ctrl_break(&self, sig: Signal) -> io::Result<()> {
		*self.console.lock() = Some(sig);
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

/// A process attribute list holding the handle list to inherit.
struct Attributes {
	buf: Vec<usize>,
}

impl Attributes {
	fn with_handles(handles: &[HANDLE]) -> io::Result<Self> {
		let mut size = 0usize;
		// SAFETY: a null list with a size pointer is the documented size query
		// (it "fails" with ERROR_INSUFFICIENT_BUFFER).
		unsafe { InitializeProcThreadAttributeList(ptr::null_mut(), 1, 0, &raw mut size) };
		let mut buf = vec![0usize; size.div_ceil(mem::size_of::<usize>())];
		// SAFETY: `buf` holds at least `size` bytes, aligned.
		check(unsafe {
			InitializeProcThreadAttributeList(buf.as_mut_ptr().cast(), 1, 0, &raw mut size)
		})?;
		// Initialized: from here on, drop deletes it.
		let mut a = Self { buf };
		// SAFETY: the list is initialized; `handles` outlives CreateProcessW
		// (the caller keeps it alive across the call).
		let ok = unsafe {
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

pub(super) fn spawn(shared: &Arc<Shared>, spec: SpawnSpec<'_>) -> io::Result<Box<dyn ExtProc>> {
	if let Some(&(fd, _)) = spec.extra_fds.first() {
		return Err(io::Error::new(io::ErrorKind::Unsupported, UnsupportedFd { fd }));
	}
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
	let SpawnSpec { path, argv, env, cwd, stdio, pgroup, lineage, .. } = spec;
	let (app, mut line) = command(path, argv)?;
	let env = env_block(env)?;
	let cwd = wide(cwd)?;
	let job = shared.state.job_for(pgroup)?;
	let mut pumps = Vec::new();
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
	let created = create(&app, &mut line, &env, &cwd, &handles, &job);
	// Our copies of the child's ends: pumps see end of file when it closes
	// its own.
	drop(handles);
	let (process, pid) = created?;
	let _ = job
		.leader
		.compare_exchange(0, pid, Ordering::AcqRel, Ordering::Acquire);
	job.roots.lock().push(pid);
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

/// `CreateProcessW` suspended, into `job`, then resumed.
fn create(
	app: &[u16],
	line: &mut [u16],
	env: &[u16],
	cwd: &[u16],
	handles: &[OwnedHandle; 3],
	job: &Job,
) -> io::Result<(OwnedHandle, u32)> {
	let mut list: Vec<HANDLE> = Vec::with_capacity(3);
	for h in handles {
		if !list.contains(&raw(h)) {
			list.push(raw(h));
		}
	}
	let mut attrs = Attributes::with_handles(&list)?;
	let mut si = STARTUPINFOEXW::default();
	si.StartupInfo.cb = mem::size_of::<STARTUPINFOEXW>() as u32;
	si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
	si.StartupInfo.hStdInput = raw(&handles[0]);
	si.StartupInfo.hStdOutput = raw(&handles[1]);
	si.StartupInfo.hStdError = raw(&handles[2]);
	si.lpAttributeList = attrs.list();
	let mut pi = PROCESS_INFORMATION::default();
	let flags = CREATE_SUSPENDED
		| CREATE_NEW_PROCESS_GROUP
		| CREATE_UNICODE_ENVIRONMENT
		| EXTENDED_STARTUPINFO_PRESENT;
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

	/// TERM-like signals: `CTRL_BREAK`, or KILL when it cannot be delivered.
	fn ctrl_break(&self, sig: Signal, escalate: bool) -> io::Result<()> {
		let mut life = self.tracker.lock();
		life.signalled(sig);
		if self.inner.job.ctrl_break(sig).is_err() {
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
			Signal::Term => self.ctrl_break(sig, true),
			Signal::Int | Signal::Hup | Signal::Quit => self.ctrl_break(sig, false),
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
			// A suspended job cannot handle CTRL_BREAK.
			let _ = job.pause.lock().resume(&Ops(job));
			if term && job.ctrl_break(Signal::Term).is_err() {
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
