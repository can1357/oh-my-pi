//! Cross-platform process tree management.

use std::{
	collections::{HashMap, HashSet},
	sync::atomic::{AtomicUsize, Ordering},
	time::Duration,
};

use anyhow::Result;
use parking_lot::Mutex;
/// Current state of a process reference.
///
/// Defined in `pi-builtins` alongside the process-table snapshots its process
/// builtins read, and re-exported here so this module — and `pi-natives`
/// through it — keeps one status type for both concerns.
pub use pi_builtins::ProcessStatus;

use crate::cancel::CancelToken;

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		collections::HashSet,
		fs,
		os::fd::{AsFd, AsRawFd, OwnedFd},
		sync::Arc,
	};

	use pi_builtins::proc_sys as sys;

	use super::ProcessStatus;

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = Arc::new(sys::open_pidfd(pid)?);
			let start_time = sys::start_time(pid)?;
			Some(Self { pid, pidfd, start_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if !self.live_identity() {
				return Vec::new();
			}

			// `/proc/{pid}/task/{tid}/children` is per-task: a child fork()ed from
			// a worker thread appears under that thread's `tid`, not the tgid.
			// Walk every task subdir and union the lists, then re-validate
			// parentage.
			let task_dir = format!("/proc/{}/task", self.pid);
			let Ok(entries) = fs::read_dir(&task_dir) else {
				return Vec::new();
			};

			let mut seen: HashSet<i32> = HashSet::new();
			let mut out = Vec::new();
			let mut children_file_available = false;
			for entry in entries.flatten() {
				let name = entry.file_name();
				let Some(tid_str) = name.to_str() else {
					continue;
				};
				if tid_str.parse::<i32>().is_err() {
					continue;
				}
				let children_path = format!("/proc/{}/task/{}/children", self.pid, tid_str);
				let Ok(content) = fs::read_to_string(&children_path) else {
					continue;
				};
				// The file is readable -> this kernel has CONFIG_PROC_CHILDREN.
				children_file_available = true;
				for part in content.split_whitespace() {
					let Ok(child_pid) = part.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}

			// Some Kata / microVM guest kernels are built without
			// CONFIG_PROC_CHILDREN, so no `.../children` file exists and the
			// walk above finds nothing — which would silently turn descendant
			// signaling (cancellation cleanup) into a no-op inside such
			// containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken
			// when no `children` file was readable, so kernels that support it
			// keep the cheap per-task fast path.
			if !children_file_available {
				for child_pid in sys::pids() {
					self.push_validated_child(child_pid, &mut seen, &mut out);
				}
			}
			out
		}

		/// Validate a candidate child pid — dedup, still running, and currently
		/// parented to `self` — then push it onto `out`. Shared by the
		/// `/proc/<pid>/task/<tid>/children` fast path and the `/proc`-scan
		/// fallback for kernels without `CONFIG_PROC_CHILDREN`.
		fn push_validated_child(&self, child_pid: i32, seen: &mut HashSet<i32>, out: &mut Vec<Self>) {
			if child_pid == self.pid || !seen.insert(child_pid) {
				return;
			}
			let Some(child) = Self::from_pid(child_pid) else {
				return;
			};
			if child.status() == ProcessStatus::Running && sys::parent_pid(child.pid) == Some(self.pid)
			{
				out.push(child);
			}
		}

		pub fn parent_pid(&self) -> Option<i32> {
			if self.status() == ProcessStatus::Running {
				sys::parent_pid(self.pid)
			} else {
				None
			}
		}

		pub fn args(&self) -> Vec<String> {
			if !self.live_identity() {
				return Vec::new();
			}

			let Some(args) = sys::cmdline(self.pid) else {
				return Vec::new();
			};
			// Re-validate after the read: PID reuse between identity check and
			// read would otherwise leak an impostor's command line to callers.
			if !self.live_identity() {
				return Vec::new();
			}
			args
		}

		pub fn kill(&self, signal: i32) -> bool {
			sys::pidfd_send_signal(self.pidfd.as_fd(), signal)
		}

		pub fn group_id(&self) -> Option<i32> {
			if self.status() != ProcessStatus::Running {
				return None;
			}

			// SAFETY: `self.pid` names the process currently referenced by
			// `self.pidfd` unless it exits concurrently. If it exits, `getpgid`
			// reports failure rather than dereferencing caller-owned memory.
			let pgid = unsafe { libc::getpgid(self.pid) };
			if pgid > 0 { Some(pgid) } else { None }
		}

		pub fn status(&self) -> ProcessStatus {
			loop {
				let mut pollfd =
					libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
				// SAFETY: `pollfd` points to one initialized `pollfd` element, and
				// the pidfd remains open for the duration of the call. Timeout
				// zero makes this a non-blocking readiness probe.
				let ready = unsafe { libc::poll(&raw mut pollfd, 1, 0) };
				if ready < 0 {
					// Retry on EINTR; for any other transient poll error treat the
					// pidfd as still running. The pidfd is still owned and the
					// kernel has not reported the process gone — a spurious
					// `Exited` here makes every downstream signal/kill fall
					// through silently.
					if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
						continue;
					}
					return ProcessStatus::Running;
				}
				if ready == 0 {
					return ProcessStatus::Running;
				}
				if (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL))
					!= 0
				{
					return ProcessStatus::Exited;
				}
				return ProcessStatus::Running;
			}
		}

		/// Resolves once the process exits: its pidfd becomes readable then.
		pub async fn exited(&self) -> std::io::Result<()> {
			let pidfd = tokio::io::unix::AsyncFd::with_interest(
				self.pidfd.try_clone()?,
				tokio::io::Interest::READABLE,
			)?;
			let _ready = pidfd.readable().await?;
			Ok(())
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			self.descendants_into(&mut out, &mut visited);
			out
		}

		fn descendants_into(&self, out: &mut Vec<Self>, visited: &mut HashSet<i32>) {
			for child in self.children() {
				if visited.insert(child.pid) {
					child.descendants_into(out, visited);
					out.push(child);
				}
			}
		}

		fn live_identity(&self) -> bool {
			self.status() == ProcessStatus::Running
				&& sys::start_time(self.pid) == Some(self.start_time)
		}
	}

	/// Find processes whose `/proc/{pid}/exe` symlink resolves to exactly
	/// `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		sys::pids()
			.filter(|pid| {
				fs::read_link(format!("/proc/{pid}/exe"))
					.is_ok_and(|resolved| resolved.as_os_str() == target)
			})
			.filter_map(Process::from_pid)
			.collect()
	}

	/// Pinned processes that currently belong to `pgid`. Each pid is checked
	/// with `getpgid` first, so only members are pinned (a scan that pinned
	/// every process on a busy host delayed the TERM wave past the grace);
	/// membership is checked again through the pin.
	pub fn group_members(pgid: i32) -> Vec<Process> {
		sys::pids()
			// SAFETY: `getpgid` takes a pid by value and reads only kernel
			// state; a pid that exited or was reused fails the pinned check.
			.filter(|&pid| unsafe { libc::getpgid(pid) } == pgid)
			.filter_map(Process::from_pid)
			.filter(|process| process.group_id() == Some(pgid))
			.collect()
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ptr,
	};

	use pi_builtins::proc_sys as sys;

	use super::ProcessStatus;

	/// macOS does not expose pidfds; identity is pinned via the kernel-reported
	/// process start time so a recycled PID does not silently impersonate the
	/// original target.
	#[derive(Clone)]
	pub struct Process {
		pid:          i32,
		start_tvsec:  u64,
		start_tvusec: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let info = sys::bsdinfo(pid)?;
			if i32::try_from(info.pbi_pid).ok()? != pid {
				return None;
			}
			Some(Self { pid, start_tvsec: info.pbi_start_tvsec, start_tvusec: info.pbi_start_tvusec })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			// `proc_listchildpids` (the obvious choice) is broken on recent macOS
			// kernels when queried for the *calling* process — it returns one byte
			// of padding regardless of how many children the process actually
			// has, so a process can never list its own descendants. Confirmed
			// on darwin 25.4 from C, Rust, and Bun callers via
			// `proc_listchildpids(getpid(), …)`, while `ps -P` and `pgrep -P`
			// still see the same children. Walk the whole pid table via
			// `proc_listallpids` and filter on `pbi_ppid` instead; this is the
			// same approach we already use for `find_by_path` and that the
			// Windows implementation uses via Toolhelp snapshots.
			let tree = build_process_tree();
			Self::children_from_tree(self.pid, &tree)
		}

		pub fn parent_pid(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_ppid).ok().filter(|ppid| *ppid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			if self.live_bsdinfo().is_none() {
				return Vec::new();
			}
			sys::args(self.pid)
		}

		pub fn kill(&self, signal: i32) -> bool {
			// Re-validate identity right before signaling. There is no atomic
			// "kill iff start_time matches" primitive on macOS, so a vanishingly
			// small window remains between this check and the syscall — but
			// matching against the recorded `(pid, start_tvsec, start_tvusec)`
			// triple eliminates the PID-reuse race in every practical case.
			if self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not
			// access caller-owned memory.
			unsafe { libc::kill(self.pid, signal) == 0 }
		}

		pub fn group_id(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0)
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		pub fn descendants(&self) -> Vec<Self> {
			// One process-table snapshot per walk — building it inside the
			// recursion would re-scan every pid for every visited node,
			// producing an `O(N · D)` kernel call pattern. Mirrors the Windows
			// implementation.
			let tree = build_process_tree();
			let mut out = Vec::new();
			let mut visited = HashSet::new();
			visited.insert(self.pid);
			Self::collect_descendants_from_tree(self.pid, &tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(parent: i32, tree: &HashMap<i32, Vec<i32>>) -> Vec<Self> {
			let Some(child_pids) = tree.get(&parent) else {
				return Vec::new();
			};
			child_pids
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.collect()
		}

		fn collect_descendants_from_tree(
			parent: i32,
			tree: &HashMap<i32, Vec<i32>>,
			visited: &mut HashSet<i32>,
			out: &mut Vec<Self>,
		) {
			let Some(child_pids) = tree.get(&parent) else {
				return;
			};
			for &child_pid in child_pids {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = Self::from_pid(child_pid) else {
					continue;
				};
				// Post-order: grandchildren first, so leaf processes get signalled
				// before their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, out);
				out.push(child);
			}
		}

		pub fn status(&self) -> ProcessStatus {
			if self.live_bsdinfo().is_some() {
				ProcessStatus::Running
			} else {
				ProcessStatus::Exited
			}
		}

		/// Resolves once the process exits, through a kqueue `NOTE_EXIT`
		/// filter.
		pub async fn exited(&self) -> std::io::Result<()> {
			use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};

			// SAFETY: `kqueue` takes no arguments; a negative result is an error.
			let kq = unsafe { libc::kqueue() };
			if kq < 0 {
				return Err(std::io::Error::last_os_error());
			}
			// SAFETY: `kq` is a fresh descriptor nothing else owns.
			let kq = unsafe { OwnedFd::from_raw_fd(kq) };
			// Scoped so the raw record (its `udata` is a `*mut c_void`) is gone
			// before the await below; holding it would make this future `!Send`.
			let registered = {
				let change = libc::kevent {
					ident:  self.pid as libc::uintptr_t,
					filter: libc::EVFILT_PROC,
					flags:  libc::EV_ADD | libc::EV_ONESHOT,
					fflags: libc::NOTE_EXIT,
					data:   0,
					udata:  ptr::null_mut(),
				};
				// SAFETY: `change` is one initialized change record; with no event
				// buffer the call only registers it and the null timeout is unused.
				unsafe {
					libc::kevent(kq.as_raw_fd(), &raw const change, 1, ptr::null_mut(), 0, ptr::null())
				}
			};
			if registered < 0 {
				let err = std::io::Error::last_os_error();
				// No such process: it is already gone.
				return (err.raw_os_error() == Some(libc::ESRCH)).ok_or(err);
			}
			// The pid may have been reused before the filter was registered, in
			// which case it watches another process; confirm identity after.
			if self.status() != ProcessStatus::Running {
				return Ok(());
			}
			let kq = tokio::io::unix::AsyncFd::with_interest(kq, tokio::io::Interest::READABLE)?;
			let _ready = kq.readable().await?;
			Ok(())
		}

		/// Returns the current `proc_bsdinfo` only if it still describes the same
		/// process this reference was opened on — i.e. the start time has not
		/// changed.
		fn live_bsdinfo(&self) -> Option<libc::proc_bsdinfo> {
			let info = sys::bsdinfo(self.pid)?;
			if info.pbi_start_tvsec == self.start_tvsec && info.pbi_start_tvusec == self.start_tvusec {
				Some(info)
			} else {
				None
			}
		}
	}

	/// Build a `ppid -> [pids]` map from a one-shot scan of `proc_listallpids`.
	///
	/// Used as the foundation of `Process::children` and `Process::descendants`
	/// on macOS where `proc_listchildpids` returns no children for self-queries.
	pub(super) fn build_process_tree() -> HashMap<i32, Vec<i32>> {
		let pids = sys::pids();
		let mut tree: HashMap<i32, Vec<i32>> = HashMap::with_capacity(pids.len() / 2);
		for pid in pids {
			let Some(info) = sys::bsdinfo(pid) else {
				continue;
			};
			let Ok(ppid) = i32::try_from(info.pbi_ppid) else {
				continue;
			};
			if ppid <= 0 {
				continue;
			}
			tree.entry(ppid).or_default().push(pid);
		}
		tree
	}

	/// Find processes whose libproc-reported executable path equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let mut path = [0u8; sys::PATH_CAPACITY];
		sys::pids()
			.into_iter()
			.filter(|pid| *pid > 0 && sys::executable_path(*pid, &mut path) == Some(target.as_bytes()))
			.filter_map(Process::from_pid)
			.collect()
	}

	/// Pinned processes that currently belong to `pgid`.
	pub fn group_members(pgid: i32) -> Vec<Process> {
		sys::pids()
			.into_iter()
			.filter_map(Process::from_pid)
			.filter(|process| process.group_id() == Some(pgid))
			.collect()
	}
}
#[cfg(target_os = "windows")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ffi::OsStr,
		os::windows::{ffi::OsStrExt, io::OwnedHandle},
		sync::Arc,
	};

	use pi_builtins::proc_sys as sys;
	use smallvec::SmallVec;

	use super::ProcessStatus;

	const PROCESS_REFERENCE_ACCESS: u32 =
		sys::PROCESS_TERMINATE | sys::PROCESS_QUERY_LIMITED_INFORMATION | sys::SYNCHRONIZE;

	#[derive(Clone)]
	/// Stable Windows process reference backed by an owned process handle plus
	/// the kernel-reported creation time, which pins identity even if the PID is
	/// recycled while we hold the handle.
	pub struct Process {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		creation_time: u64,
	}

	impl Process {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let handle =
				Arc::new(sys::open_process(u32::try_from(pid).ok()?, PROCESS_REFERENCE_ACCESS)?);
			let creation_time = sys::process_times(&handle)?.0;
			Some(Self { pid, handle, creation_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn parent_pid(&self) -> Option<i32> {
			sys::parent_pid(&self.handle)
		}

		/// Read through the pinned handle, so it is always this process's
		/// command line even after the pid is reused.
		pub fn args(&self) -> Vec<String> {
			sys::command_line(&self.handle)
				.map_or_default(|command_line| sys::split_command_line(&command_line))
		}

		pub fn children(&self) -> Vec<Self> {
			let tree = build_process_tree();
			self.children_from_tree(&tree)
		}

		/// Walk the entire descendant tree using a single Toolhelp snapshot.
		///
		/// `children()` recursing per-node would re-snapshot the whole process
		/// table for every visited descendant, making tree termination
		/// `O(N · D)` snapshots. One snapshot per termination wave is enough.
		pub fn descendants(&self) -> Vec<Self> {
			let tree = build_process_tree();
			let Ok(root) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			let mut visited: HashSet<u32> = HashSet::new();
			visited.insert(root);
			let mut out = Vec::new();
			self.collect_descendants_from_tree(&tree, &mut visited, &mut out);
			out
		}

		/// The running process `child_pid`, when it really is a child of
		/// `self`. Windows never rewrites the parent id recorded for a process
		/// whose parent exited, so such an orphan is listed as a child of
		/// whichever process reuses that pid. A real child cannot have been
		/// created before its parent; an orphan older than `self` can.
		fn child(&self, child_pid: u32) -> Option<Self> {
			let child = Self::from_pid(i32::try_from(child_pid).ok()?)?;
			(child.creation_time >= self.creation_time && child.status() == ProcessStatus::Running)
				.then_some(child)
		}

		pub(super) fn children_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
		) -> Vec<Self> {
			let Ok(pid_u32) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			tree
				.get(&pid_u32)
				.into_iter()
				.flatten()
				.filter_map(|&child_pid| self.child(child_pid))
				.collect()
		}

		fn collect_descendants_from_tree(
			&self,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			visited: &mut HashSet<u32>,
			out: &mut Vec<Self>,
		) {
			let Some(children) = u32::try_from(self.pid).ok().and_then(|pid| tree.get(&pid)) else {
				return;
			};
			for &child_pid in children {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = self.child(child_pid) else {
					continue;
				};
				// Post-order: collect grandchildren first so leaves are signalled
				// before their parents during tree termination.
				child.collect_descendants_from_tree(tree, visited, out);
				out.push(child);
			}
		}

		/// The handle pins the original kernel process object even after the
		/// pid is recycled, so this cannot hit a different process.
		pub fn kill(&self, _signal: i32) -> bool {
			sys::terminate(&self.handle)
		}

		pub const fn group_id() -> Option<i32> {
			None
		}

		pub fn status(&self) -> ProcessStatus {
			if sys::has_exited(&self.handle) {
				ProcessStatus::Exited
			} else {
				ProcessStatus::Running
			}
		}

		/// Resolves once the process exits, through a thread-pool wait on the
		/// process handle, so no thread is parked per waiter.
		pub async fn exited(&self) -> std::io::Result<()> {
			sys::exited(Arc::clone(&self.handle)).await
		}
	}

	/// Build a map of `parent_pid` -> [`child_pids`] for all processes.
	fn build_process_tree() -> HashMap<u32, SmallVec<[u32; 4]>> {
		let mut tree: HashMap<u32, SmallVec<[u32; 4]>> = HashMap::new();
		for entry in sys::processes() {
			tree.entry(entry.ppid).or_default().push(entry.pid);
		}
		tree
	}

	/// Find processes whose `QueryFullProcessImageNameW` result equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let target: Vec<u16> = OsStr::new(target).encode_wide().collect();
		let mut path = vec![0u16; 32_768];
		sys::processes()
			.filter(|entry| {
				sys::open_process(entry.pid, sys::PROCESS_QUERY_LIMITED_INFORMATION)
					.is_some_and(|handle| sys::image_path(&handle, &mut path) == Some(&target[..]))
			})
			.filter_map(|entry| Process::from_pid(i32::try_from(entry.pid).ok()?))
			.collect()
	}

	/// Windows has no Unix-style process groups.
	pub const fn group_members(_pgid: i32) -> Vec<Process> {
		Vec::new()
	}
}

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

impl Process {
	/// Open a stable process reference from a PID.
	pub fn from_pid(pid: i32) -> Option<Self> {
		platform::Process::from_pid(pid).map(Self::from_inner)
	}

	/// Open stable process references whose executable path matches exactly.
	pub fn from_path(path: String) -> Vec<Self> {
		platform::find_by_path(&path)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Operating-system process identifier for this process reference.
	#[must_use]
	pub const fn pid(&self) -> i32 {
		self.inner.pid()
	}

	/// Parent process id for this process, when available.
	#[must_use]
	pub fn ppid(&self) -> Option<i32> {
		self.inner.parent_pid()
	}

	/// Launch arguments for this process.
	#[must_use]
	pub fn args(&self) -> Vec<String> {
		self.inner.args()
	}

	/// Send `signal` to this process only, through its pinned identity, so it
	/// never reaches a process that reused the pid after this one was reaped.
	/// On Windows the process is terminated whatever `signal` is.
	pub fn signal(&self, signal: i32) -> bool {
		self.inner.kill(signal)
	}

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	#[must_use]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.signal_tree(signal.unwrap_or(KILL_SIGNAL))
	}

	/// Process group id for this process, when supported by the platform.
	#[cfg(target_os = "windows")]
	#[must_use]
	pub const fn group_id(&self) -> Option<i32> {
		platform::Process::group_id()
	}

	#[cfg(not(target_os = "windows"))]
	#[must_use]
	pub fn group_id(&self) -> Option<i32> {
		self.inner.group_id()
	}

	/// Direct children of this process as stable process references.
	pub fn children(&self) -> Vec<Self> {
		self
			.inner
			.children()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Current status of this process reference.
	#[must_use]
	pub fn status(&self) -> ProcessStatus {
		self.inner.status()
	}

	/// Gracefully terminate this process and its descendants.
	///
	/// Sends `TERM_SIGNAL` to the optional process group, every live descendant,
	/// and the root, then optionally waits up to `graceful_ms` for the tree to
	/// exit before escalating to `KILL_SIGNAL`. Pass `graceful_ms < 0` to skip
	/// the wait entirely (the polite signal is still emitted). Returns `true`
	/// when the tree has exited by the end of the hard wave's wait window.
	pub async fn terminate_tree(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		self
			.terminate_tree_impl(group, graceful_ms, timeout_ms, ct)
			.await
	}

	/// Wait until this process exits, optionally bounded by `timeout`.
	pub async fn wait_for_exit(&self, timeout: Option<Duration>, ct: CancelToken) -> Result<bool> {
		wait_for_exit(self, &[], &[], timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: platform::Process) -> Self {
		Self { inner }
	}

	/// Pinned snapshot of processes in a Unix process group. On Windows this is
	/// empty because the platform has no process-group signal primitive.
	fn group_members(pgid: i32) -> Vec<Self> {
		platform::group_members(pgid)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Walk the live descendant tree from scratch. Cheap and idempotent — call
	/// it again before each signal wave so grandchildren spawned during a grace
	/// period are not missed.
	fn live_descendants(&self) -> Vec<Self> {
		self
			.inner
			.descendants()
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		self.signal_tree_excluding(signal, &host_protected_pids())
	}

	/// Signal this process and its live descendants (children first), skipping
	/// any pid in `protected`, and return how many of them the signal reached.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		let mut wave = SignalWave::new(signal);
		wave.tree(self, self.led_group(), protected);
		wave.deliver().reached
	}

	/// The process group this process leads, if any. Signalling it as well
	/// catches grandchildren reparented to init when their immediate parent
	/// died inside the descendant walk.
	fn led_group(&self) -> Option<i32> {
		self.group_id().filter(|&pgid| pgid == self.pid())
	}

	/// Live descendants with every protected subtree pruned, not just the exact
	/// protected pids.
	///
	/// The flattened descendant list can contain a protected node (the harness,
	/// on a Windows PID-reuse false-descendant) *together with* that node's real
	/// children, which were collected by recursing through it. Skipping only the
	/// exact protected pid would still terminate those unrelated worker/tool
	/// subprocesses, so drop every node whose recorded parent chain — within the
	/// enumerated set — passes through a protected pid (#7452 review).
	fn signalable_descendants(&self, protected: &HashSet<i32>) -> Vec<Self> {
		let descendants = self.live_descendants();
		let parents: HashMap<i32, i32> = descendants
			.iter()
			.filter_map(|descendant| descendant.ppid().map(|parent| (descendant.pid(), parent)))
			.collect();
		descendants
			.into_iter()
			.filter(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents))
			.collect()
	}

	async fn terminate_tree_impl(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		if self.status() != ProcessStatus::Running {
			return Ok(true);
		}

		let process_group = if group { self.group_id() } else { None };
		let protected = host_protected_pids();

		// Polite wave: SIGTERM the group, every live descendant, then the root.
		// It returns every process it knew (its snapshot and its groups'
		// members, pinned before and after the group signal). The waits below
		// cover those processes and every group the wave signalled, so a
		// member forked during the wave, or one that left its group on TERM,
		// keeps the tree "running" until it is gone and cannot be skipped by
		// an early return.
		let mut wave = SignalWave::new(TERM_SIGNAL);
		wave.tree(self, process_group, &protected);
		let (delivery, mut known) = wave.deliver_known();
		let mut groups = delivery.groups;

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before
		// KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&known,
				&groups,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too,
		// and carry every process the polite wave knew that is still alive:
		// one that left the tree and its group after TERM (`setsid()` in a
		// handler) is in neither re-walk.
		let mut wave = SignalWave::new(KILL_SIGNAL);
		wave.tree(self, process_group, &protected);
		wave.carry(&known, &protected);
		let delivery;
		(delivery, known) = wave.deliver_known();
		groups = delivery.groups;

		wait_for_exit(self, &known, &groups, Some(Duration::from_millis(u64::from(timeout_ms))), ct)
			.await
	}
}

/// One delivery of a signal. Each process the wave knows of gets it once,
/// unless it changes process group on its own during the wave (below).
///
/// A wave reaches processes through recorded process groups and recorded
/// process trees, and those overlap: a group's leader and its descendants are
/// usually members of the group. A shell runs its trap once for each TERM it
/// takes, so a TERM delivered twice runs a TERM trap twice, and a second group
/// signal also reaches the commands the first run of the trap started.
///
/// The wave first records its groups and snapshots its known processes
/// (descendants, then roots), each with the group it is in, before it sends
/// anything. Delivery then sends each recorded group one kernel group signal,
/// and only after that signals, through its pin, every snapshot process whose
/// snapshot group is not a recorded group. The kernel signals every member of
/// a group at one instant, including a child a member is forking at that
/// moment. Members are never also signalled directly, and nothing is sent
/// after the direct signals, so a move the wave's own signal causes cannot
/// bring a second one: a member the group signal makes leave its group
/// (`setsid()` in a TERM handler) gets nothing more, a non-member that joins a
/// group because of the group signal was not reached by it and gets its one
/// direct signal, and a non-member that joins a group because of its direct
/// signal gets nothing after it. Commands a TERM trap starts after the group
/// signal are not reached.
///
/// Boundaries:
/// - A process that changes group on its own, not because of this wave's
///   signal, between the snapshot and the group signal may miss this wave's
///   signal or get it twice; the next wave, or the KILL wave, reaches it.
/// - The kernel signals one group at a time, so a process that moves from one
///   recorded group to another between their two group signals, including a
///   move the first group's signal causes, gets the signal from both.
/// - A wave reaches a process only through a recorded group, a known process's
///   descendants, or a process an earlier wave knew. A process that leaves its
///   group (`setsid()`) and is no longer a descendant of any process the wave
///   knows, because its parent exited or it double-forked, before a wave sees
///   it, is not reached. Measured shapes: a member forked between the scans
///   around the group signal that leaves its group before the second scan reads
///   it; a member that leaves its group and then double-forks; a member that
///   leaves its group, forks a child and exits. Main leaks these the same way.
///   Closing them needs containment that outlives the process tree (a cgroup
///   per run, or a subreaper), which changes the shared host's process model.
///
/// The harness's own group is never recorded.
struct SignalWave {
	signal:  i32,
	groups:  Vec<i32>,
	pids:    HashSet<i32>,
	/// Snapshot processes with the group each was in when it was recorded.
	targets: Vec<(Process, Option<i32>)>,
}

/// What a delivered wave reached.
struct Delivery {
	/// Known processes the signal reached, directly or through their group.
	reached: u32,
	/// Recorded groups the kernel group signal reached.
	groups:  Vec<i32>,
}

impl SignalWave {
	fn new(signal: i32) -> Self {
		Self { signal, groups: Vec::new(), pids: HashSet::new(), targets: Vec::new() }
	}

	/// Record process group `pgid`. The harness's own group is refused:
	/// signalling it would terminate the host.
	fn group(&mut self, pgid: i32) {
		if pgid > 0 && !self.groups.contains(&pgid) && !is_self_process_group(pgid) {
			self.groups.push(pgid);
		}
	}

	/// Snapshot `process` with its current group, unless the wave holds it.
	fn add(&mut self, process: Process) {
		if self.pids.insert(process.pid()) {
			let group = process.group_id();
			self.targets.push((process, group));
		}
	}

	/// Record `group`, then snapshot `root`'s live descendants (children
	/// first) and `root`, sparing every `protected` subtree. Returns the
	/// descendants.
	fn tree(
		&mut self,
		root: &Process,
		group: Option<i32>,
		protected: &HashSet<i32>,
	) -> Vec<Process> {
		if let Some(pgid) = group {
			self.group(pgid);
		}
		let descendants = root.signalable_descendants(protected);
		for child in &descendants {
			self.add(child.clone());
		}
		if !protected.contains(&root.pid()) {
			self.add(root.clone());
		}
		descendants
	}

	/// Signal each recorded group once, then every snapshot process outside
	/// the recorded groups through its pin.
	fn deliver(&mut self) -> Delivery {
		let mut members: HashMap<i32, u32> = HashMap::new();
		let mut direct = Vec::new();
		for (target, group) in self.targets.drain(..) {
			match group.filter(|pgid| self.groups.contains(pgid)) {
				Some(pgid) => {
					if target.status() == ProcessStatus::Running {
						*members.entry(pgid).or_default() += 1;
					}
				},
				None => direct.push(target),
			}
		}
		let mut reached = 0;
		let mut groups = Vec::new();
		for &pgid in &self.groups {
			if kill_process_group(pgid, self.signal) {
				reached += members.get(&pgid).copied().unwrap_or(0);
				groups.push(pgid);
			}
		}
		for target in direct {
			reached += u32::from(target.inner.kill(self.signal));
		}
		Delivery { reached, groups }
	}

	/// Snapshot each of `carried` that is still running, with its live
	/// descendants (children first), sparing every `protected` subtree:
	/// processes an earlier wave knew that may have left the recorded trees
	/// and groups since (a `setsid()` in a TERM handler whose leader then
	/// exited), and the children such a process started after it. One that is
	/// still in a recorded group is reached through it; one that left is
	/// signalled through its pin.
	fn carry(&mut self, carried: &[Process], protected: &HashSet<i32>) {
		for process in carried {
			if process.status() != ProcessStatus::Running || protected.contains(&process.pid()) {
				continue;
			}
			for child in process.signalable_descendants(protected) {
				self.add(child);
			}
			self.add(process.clone());
		}
	}

	/// Delivers the wave and returns, with what it reached, every process it
	/// knew of: its snapshot, the recorded groups' members pinned just before
	/// the group signals, and the signalled groups' members pinned just after
	/// them. A later wave carries them, so a member that leaves its group
	/// because of this signal is still reached. A member that leaves before
	/// the scan after the group signal reads it, and that no known process has
	/// as a descendant, is not known.
	fn deliver_known(&mut self) -> (Delivery, Vec<Process>) {
		fn pin_members(groups: &[i32], known: &mut Vec<Process>) {
			for &pgid in groups {
				for member in Process::group_members(pgid) {
					if !known.iter().any(|seen| seen.pid() == member.pid()) {
						known.push(member);
					}
				}
			}
		}
		let mut known: Vec<Process> = self
			.targets
			.iter()
			.map(|(process, _)| process.clone())
			.collect();
		pin_members(&self.groups, &mut known);
		let delivery = self.deliver();
		pin_members(&delivery.groups, &mut known);
		(delivery, known)
	}
}

/// The harness pid — the one process a run-cancellation sweep must never
/// signal.
///
/// On Unix the descendant walk is identity-pinned (pidfd / start-time), so the
/// host can never appear as a false descendant and this set is a harmless
/// no-op safety net. On Windows the descendant tree is derived from raw
/// `th32ParentProcessID` values that survive their recorded parent's death: a
/// freshly spawned child whose recycled pid matches the harness's stale parent
/// pid makes the harness enumerate as a false descendant, so cancelling a
/// timed-out bash run would `TerminateProcess` the host with no cleanup and no
/// `session_exit` record (#7452, related #4605).
///
/// Do not walk the host's numeric parent chain here. On Windows the host's
/// recorded parent pid can itself have been recycled onto the cancellation
/// target; treating that raw pid as protected would spare the hung command and
/// prune all of its descendants from cleanup.
fn host_protected_pids() -> HashSet<i32> {
	i32::try_from(std::process::id()).into_iter().collect()
}

/// True when `pid` is itself protected or descends — within the enumerated
/// `parents` map (pid -> recorded parent pid) — from a protected pid. Used to
/// prune a whole protected subtree from a cancellation sweep so a false
/// descendant of the harness cannot drag the harness's real children into the
/// kill set (#7452).
fn pid_in_protected_subtree(
	pid: i32,
	protected: &HashSet<i32>,
	parents: &HashMap<i32, i32>,
) -> bool {
	let mut current = pid;
	// Bound the walk against a corrupted or cyclic parent chain.
	for _ in 0..256 {
		if protected.contains(&current) {
			return true;
		}
		match parents.get(&current) {
			Some(&parent) if parent != current => current = parent,
			_ => return false,
		}
	}
	false
}

/// Waits until `root`, every one of `descendants` and every member of each of
/// `groups` has exited. A group signal reaches members the descendant
/// snapshot never saw (a child forked during the wave, an orphan reparented
/// away), so they count too.
async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	groups: &[i32],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	let all_exited = || {
		root.status() != ProcessStatus::Running
			&& descendants
				.iter()
				.all(|process| process.status() != ProcessStatus::Running)
			&& groups
				.iter()
				.all(|&pgid| Process::group_members(pgid).is_empty())
	};
	ct.heartbeat()?;
	if all_exited() {
		return Ok(true);
	}

	// A lone process is awaited through the OS exit notification. Polling woke
	// every waiter 20 times a second, and IPC workers wait on their parent for
	// their whole life. Trees and groups still poll: their membership changes.
	if descendants.is_empty()
		&& groups.is_empty()
		&& let Some(result) = wait_for_root_exit(root, timeout, &ct).await
	{
		return result;
	}

	let poll_interval = Duration::from_millis(50);
	let mut elapsed = Duration::ZERO;
	while timeout.is_none_or(|limit| elapsed < limit) {
		let sleep_for =
			timeout.map_or(poll_interval, |limit| limit.saturating_sub(elapsed).min(poll_interval));
		if sleep_for.is_zero() {
			break;
		}
		ct.heartbeat()?;
		tokio::time::sleep(sleep_for).await;
		elapsed += sleep_for;

		if all_exited() {
			return Ok(true);
		}
	}

	Ok(false)
}

/// Waits for `root` to exit through the platform's exit notification:
/// `Ok(true)` once it exited, `Ok(false)` when `timeout` elapsed first.
/// `None` when no notification could be set up, so the caller polls instead.
async fn wait_for_root_exit(
	root: &Process,
	timeout: Option<Duration>,
	ct: &CancelToken,
) -> Option<Result<bool>> {
	let exited = root.inner.exited();
	let bounded = async {
		match timeout {
			Some(limit) => tokio::time::timeout(limit, exited).await.ok(),
			None => Some(exited.await),
		}
	};
	tokio::select! {
		outcome = bounded => match outcome {
			None => Some(Ok(false)),
			Some(Ok(())) => Some(Ok(true)),
			Some(Err(_)) => None,
		},
		reason = ct.wait() => Some(Err(anyhow::Error::msg(format!("Aborted: {reason:?}")))),
	}
}

/// Send `signal` to the process group `pgid`.
/// Returns false when process groups are unsupported on the platform.
#[allow(clippy::missing_const_for_fn, reason = "Dispatches to platform-specific implementation")]
#[must_use]
pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
	// Defense in depth: refuse to deliver a signal to the harness's own
	// process group. Doing so terminates the harness along with the targets.
	// `SpawnRegistry` only ever records pgids brush created for this run (never
	// the harness pgid); this catches any future caller that bypasses it.
	if pgid <= 0 || is_self_process_group(pgid) {
		return false;
	}
	platform_kill_process_group(pgid, signal)
}

#[cfg(unix)]
fn platform_kill_process_group(pgid: i32, signal: i32) -> bool {
	// SAFETY: `kill` takes integer identifiers by value and does not access
	// caller-owned memory. A negative PID is the POSIX process-group form.
	unsafe { libc::kill(-pgid, signal) == 0 }
}

/// Process groups are not exposed on Windows.
#[cfg(not(unix))]
const fn platform_kill_process_group(_pgid: i32, _signal: i32) -> bool {
	false
}

#[cfg(unix)]
fn is_self_process_group(pgid: i32) -> bool {
	// SAFETY: `getpgid(0)` queries the calling process's pgid and does not
	// access caller-owned memory. A return value <= 0 is treated as "unknown",
	// which fails open so the actual signal call decides.
	let self_pgid = unsafe { libc::getpgid(0) };
	self_pgid > 0 && self_pgid == pgid
}

#[cfg(not(unix))]
const fn is_self_process_group(_pgid: i32) -> bool {
	false
}

/// POSIX `SIGTERM` / Windows polite termination sentinel.
pub const TERM_SIGNAL: i32 = 15;

/// POSIX `SIGKILL` / Windows hard-termination sentinel.
pub const KILL_SIGNAL: i32 = 9;

/// A collection of process groups and process trees scheduled for
/// termination together.
///
/// Built incrementally from job records or PTY metadata, then signalled
/// in escalating waves (typically `TERM_SIGNAL` followed by
/// `KILL_SIGNAL` after a grace period). Process-group calls are no-ops
/// on platforms that do not expose process groups.
#[derive(Default)]
pub struct TerminationTargets {
	pgids:     Vec<i32>,
	processes: Vec<Process>,
	seen_pids: HashSet<i32>,
}

impl TerminationTargets {
	/// Create an empty target set.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a process group id. Duplicates are ignored.
	pub fn add_pgid(&mut self, pgid: i32) {
		if pgid > 0 && !self.pgids.contains(&pgid) {
			self.pgids.push(pgid);
		}
	}

	/// Record a pid. Duplicates are ignored. If the pid is alive, opens
	/// a stable [`Process`] reference so the descendant tree can be
	/// killed even if the original pid is reused later.
	///
	/// Prefer [`add_process`](Self::add_process) when the caller already holds a
	/// [`Process`] captured at spawn time: opening by pid here loses the
	/// original identity if the pid was recycled between the child exiting
	/// and this call.
	pub fn add_pid(&mut self, pid: i32) {
		if self.seen_pids.insert(pid)
			&& let Some(process) = Process::from_pid(pid)
		{
			self.processes.push(process);
		}
	}

	/// Record a pre-pinned [`Process`] handle. Duplicates (by pid) are ignored.
	///
	/// This is the correct entry point when the caller captured the handle at
	/// spawn time — the handle already pins OS-level identity, so no `from_pid`
	/// re-open (and its PID-reuse race) is needed at cancellation time.
	pub fn add_process(&mut self, process: Process) {
		if self.seen_pids.insert(process.pid()) {
			self.processes.push(process);
		}
	}

	/// True when no targets have been recorded.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.pgids.is_empty() && self.processes.is_empty()
	}

	/// Send `signal` to every recorded target exactly once: collect every
	/// group member and tree process first, then signal each. Failures are
	/// swallowed: targets routinely exit between collection and signalling,
	/// and the caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		self.wave(signal).deliver();
	}

	/// Like [`signal`](Self::signal), and also signals each of `carried`
	/// that is still running (processes an earlier wave returned, which may
	/// have left the recorded trees and groups since). Returns every process
	/// this wave knew of, for the next wave to carry; see
	/// `SignalWave::deliver_known`.
	pub fn signal_carrying(&self, signal: i32, carried: &[Process]) -> Vec<Process> {
		let mut wave = self.wave(signal);
		wave.carry(carried, &host_protected_pids());
		wave.deliver_known().1
	}

	fn wave(&self, signal: i32) -> SignalWave {
		let mut wave = SignalWave::new(signal);
		for &pgid in &self.pgids {
			wave.group(pgid);
		}
		let protected = host_protected_pids();
		for process in &self.processes {
			wave.tree(process, process.led_group(), &protected);
		}
		wave
	}
}

/// A single external child reported by the shell's spawn-observer hook.
///
/// `process` is captured *at spawn time* so its OS-level identity is pinned
/// before the pid can be recycled. On Windows an open process handle keeps
/// the pid reserved for the lifetime of the reference; on Linux the pidfd
/// pins identity; on macOS the recorded `(pid, start_time)` triple detects
/// impersonation. Storing only the raw pid and re-opening at cancellation
/// time — as previous versions did — leaked kills onto unrelated processes
/// that happened to acquire the recycled pid between the child exiting and
/// the run being cancelled (issue #4605).
#[derive(Clone)]
struct SpawnedProcess {
	process: Option<Process>,
	pgid:    Option<i32>,
}

/// Per-run record of the OS processes a single shell command launched,
/// captured at spawn time via brush's `SpawnObserver` hook.
///
/// Replaces the old process-global "new descendants since a baseline" diff,
/// which could not distinguish the children of concurrent runs sharing one
/// host process: a run that cancelled would signal *any* descendant spawned
/// after its baseline, including another run's children. Ownership is now
/// explicit — only processes this run actually spawned are ever signalled.
#[derive(Default)]
struct RegistryState {
	spawned:       Vec<SpawnedProcess>,
	/// The next `spawned.len()` at which `record` runs a sweep. Bounds sweep
	/// frequency when the live set stabilizes above the initial threshold:
	/// without this watermark, every subsequent `record` would find
	/// `len >= PRUNE_THRESHOLD` true and sweep on every spawn (O(n²) in a
	/// large-fan-out run like `for i in {1..1000}; do sleep 60 & done`). With
	/// it, the next sweep only fires once the vec has grown by another
	/// `PRUNE_THRESHOLD` entries since the previous sweep — restoring true
	/// amortized O(1) per spawn regardless of how many entries survive each
	/// sweep.
	next_sweep_at: usize,
}

#[derive(Default)]
pub struct SpawnRegistry {
	state:    Mutex<RegistryState>,
	/// Spawns brush announced that are not settled yet. Their processes can
	/// already run although they are not recorded.
	spawning: AtomicUsize,
}

impl SpawnRegistry {
	/// Amortized-cost threshold for opportunistic pruning of exited entries.
	///
	/// A shell run that spawns many short-lived external commands (e.g. a bash
	/// loop invoking a binary per iteration) would otherwise retain one owned
	/// process handle per spawn — a pidfd on Linux, a `HANDLE` on Windows — for
	/// the lifetime of the run, exhausting per-process FD/handle limits.
	///
	/// Each sweep costs `O(N)` (one non-blocking status probe per entry, plus
	/// a Toolhelp descendant walk on Windows for exited roots). The next sweep
	/// is scheduled `PRUNE_THRESHOLD` further records away — via the
	/// `next_sweep_at` watermark — so a run that keeps many concurrent
	/// long-lived children (`for i in {1..1000}; do sleep 60 & done`) does not
	/// sweep on every spawn just because the vec is already above threshold.
	/// Amortized cost per spawn stays `O(1)` regardless of the live-set size.
	const PRUNE_THRESHOLD: usize = 64;

	/// Create an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Count a spawn that has started and is not recorded yet.
	pub fn begin_spawn(&self) {
		self.spawning.fetch_add(1, Ordering::SeqCst);
	}

	/// End a spawn that [`begin_spawn`](Self::begin_spawn) counted.
	pub fn end_spawn(&self) {
		self.spawning.fetch_sub(1, Ordering::SeqCst);
	}

	/// True while a counted spawn is not settled: its process can run before
	/// it is recorded.
	#[must_use]
	pub fn spawn_in_flight(&self) -> bool {
		self.spawning.load(Ordering::SeqCst) > 0
	}

	/// Record a freshly spawned child. Called from the spawn-observer hook.
	///
	/// The `Process` handle MUST be opened by the caller *immediately* after
	/// the child's pid becomes visible, so identity is pinned before any race
	/// with pid recycling can start. When the pin fails (child already exited
	/// before we could `Process::from_pid`) the entry becomes a no-op at
	/// termination time — there is nothing left to signal.
	///
	/// Exited entries are swept opportunistically once the recorded vec
	/// crosses the next-sweep watermark, so long-running loops of short
	/// external commands cannot exhaust the process' FD/handle limit by
	/// retaining one owned handle per historical spawn.
	pub fn record(&self, pgid: Option<i32>, process: Option<Process>) {
		let mut state = self.state.lock();
		state.spawned.push(SpawnedProcess { process, pgid });
		if state.spawned.len() >= state.next_sweep_at.max(Self::PRUNE_THRESHOLD) {
			prune_exited(&mut state.spawned);
			// Schedule the next sweep `PRUNE_THRESHOLD` further records away.
			// Comparing against the post-sweep live-set size (not the pre-sweep
			// length) bounds the sweep frequency when many entries survive:
			// each sweep costs O(N) but now runs at most once per
			// `PRUNE_THRESHOLD` records, so amortized per-record cost is O(1)
			// even if the live set stays large.
			state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
		}
	}

	/// Pids of recorded processes that are still alive, in spawn order.
	///
	/// Liveness is probed through each entry's pinned [`Process`] (pidfd on
	/// Linux, start-time identity on macOS, open handle on Windows), so a
	/// recycled pid never reports as one of this run's children. Entries whose
	/// pin failed at spawn time are skipped — they already exited. The
	/// recorded set is not mutated; pruning stays with `record`/`build_targets`.
	#[must_use]
	pub fn live_pids(&self) -> Vec<i32> {
		let state = self.state.lock();
		state
			.spawned
			.iter()
			.filter_map(|entry| entry.process.as_ref())
			.filter(|process| process.status() == ProcessStatus::Running)
			.map(Process::pid)
			.collect()
	}

	/// Build the kill set from the processes recorded so far. Re-read on every
	/// signal wave so a child spawned during a grace window — between the
	/// cancel firing and the next wave — is still reaped.
	///
	/// A recorded process contributes only while alive; a recorded pgid
	/// contributes only while the group still has members, so once the run's
	/// whole tree exits the targets are empty and the wave loop can stop early.
	///
	/// Pruning also runs here so a cancellation cycle sees a compact target
	/// set even when the record-time threshold hasn't fired yet.
	#[must_use]
	pub fn build_targets(&self) -> TerminationTargets {
		let mut targets = TerminationTargets::new();
		let spawned = {
			let mut state = self.state.lock();
			prune_exited(&mut state.spawned);
			// Reset the watermark to the current live-set size + threshold;
			// leaving a stale pre-sweep value would misgate the next
			// record-time sweep.
			state.next_sweep_at = state.spawned.len() + Self::PRUNE_THRESHOLD;
			state.spawned.clone()
		};
		for entry in spawned {
			if let Some(process) = entry.process {
				targets.add_process(process);
			}
			// If the observer failed to pin a handle at spawn time (the child
			// exited before `Process::from_pid` could open it), the child is
			// already gone — signalling anything for that pid would either
			// no-op or, worse, race a recycled pid onto an unrelated process.
			// Drop the entry entirely rather than reintroduce the pid-reuse
			// window this whole change exists to close (#4605).
			if let Some(pgid) = entry.pgid
				&& pgid > 0
				&& process_group_alive(pgid)
			{
				targets.add_pgid(pgid);
			}
		}
		targets
	}
}

/// Drop registry entries whose pinned process, process group, and — on
/// Windows — descendant tree are all gone. With nothing still-live the entry
/// contributes nothing to the next termination wave and only pins an owned OS
/// handle for no reason.
///
/// The platform split matters because Windows has no process groups. On Unix
/// a child reparented onto init keeps its pgid, so a live pgid still catches
/// grandchildren whose immediate parent exited. On Windows there is no
/// reparenting and no pgid, so we probe the descendant tree directly through
/// the still-open pinned handle — dropping that handle would release the pid
/// slot, letting a recycled pid make future Toolhelp walks unsafe (issue
/// #4605) and orphaning any leftover child from the next cancellation wave.
fn prune_exited(spawned: &mut Vec<SpawnedProcess>) {
	spawned.retain(|entry| {
		if let Some(process) = &entry.process {
			if process.status() == ProcessStatus::Running {
				return true;
			}
			// Windows-only: root exited but the pinned handle still keeps its
			// pid reserved, so `live_descendants` walks the *original* subtree
			// via Toolhelp. If any child is still running we must keep the
			// entry — closing the handle would both release the pid (racing
			// pid reuse) and strand the surviving child.
			#[cfg(target_os = "windows")]
			if !process.live_descendants().is_empty() {
				return true;
			}
		}
		entry
			.pgid
			.is_some_and(|pgid| pgid > 0 && process_group_alive(pgid))
	});
}

/// True when process group `pgid` still has at least one member. `kill(2)`
/// with signal 0 performs permission/existence checks without delivering a
/// signal; `EPERM` means the group exists but is not ours to signal, which
/// still counts as alive.
#[must_use]
#[allow(
	clippy::missing_const_for_fn,
	reason = "calls non-const platform_process_group_alive on unix"
)]
fn process_group_alive(pgid: i32) -> bool {
	if pgid <= 0 {
		return false;
	}
	platform_process_group_alive(pgid)
}

#[cfg(unix)]
fn platform_process_group_alive(pgid: i32) -> bool {
	// SAFETY: `kill` takes integer identifiers by value and does not access
	// caller-owned memory. A negative pid targets the process group; signal 0
	// only runs the existence/permission checks.
	let ret = unsafe { libc::kill(-pgid, 0) };
	ret == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(not(unix))]
const fn platform_process_group_alive(_pgid: i32) -> bool {
	false
}

#[cfg(test)]
pub(crate) mod tests {
	use super::*;

	/// The harness pid must be the only protected pid. Including its recorded
	/// parent would be unsafe on Windows: that stale numeric pid can have been
	/// recycled onto the timed-out command, causing cancellation to spare the
	/// hung target and its whole subtree.
	#[test]
	fn host_protected_pids_includes_self() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		assert_eq!(
			host_protected_pids(),
			HashSet::from([self_pid]),
			"only the harness pid may be protected from cancellation sweeps",
		);
	}

	/// Regression test for #7452: a cancellation sweep must never signal the
	/// protected host pid, even when it is enumerated as the sweep root. On
	/// Windows a recycled pid can make the harness surface as
	/// a false descendant of a just-spawned child; `TerminateProcess`-ing it
	/// killed the whole session with no `session_exit` record. The observable
	/// defense — provable cross-platform — is that `signal_tree_excluding`
	/// leaves a protected pid untouched.
	#[cfg(unix)]
	#[test]
	fn signal_tree_spares_protected_pids() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");
		let root = Process::from_pid(child_pid).expect("pin child");

		// Treat the child's pid as protected (standing in for the harness/an
		// ancestor). The sweep must refuse to signal it.
		let protected: HashSet<i32> = HashSet::from([child_pid]);
		let signaled = root.signal_tree_excluding(KILL_SIGNAL, &protected);
		assert_eq!(signaled, 0, "a protected root must never be signalled");

		// The protected process is still alive after the sweep.
		thread::sleep(Duration::from_millis(50));
		assert_eq!(
			root.status(),
			ProcessStatus::Running,
			"a protected pid must survive a cancellation sweep",
		);

		// With no protection the same sweep reaps it — proves the skip is what
		// spared it, not a dead target.
		let reaped = root.signal_tree_excluding(KILL_SIGNAL, &HashSet::new());
		assert!(reaped >= 1, "an unprotected root must be signalled");
		let _ = child.wait();
	}

	/// Regression test for the #7453 review: pruning a protected node must drop
	/// its whole subtree, not just the exact protected pid. A Windows PID-reuse
	/// false-descendant collects the harness together with the harness's real
	/// children (LSP servers, worker/tool subprocesses); skipping only the host
	/// pid would still terminate those. `pid_in_protected_subtree` walks the
	/// enumerated parent map so any node under a protected pid is excluded.
	#[test]
	fn protected_subtree_is_pruned_not_just_the_pid() {
		// root(1) -> host(2, protected) -> worker(3); root(1) -> real_child(4).
		let parents: HashMap<i32, i32> = HashMap::from([(2, 1), (3, 2), (4, 1)]);
		let protected: HashSet<i32> = HashSet::from([2]);

		assert!(
			pid_in_protected_subtree(2, &protected, &parents),
			"the protected node itself must be excluded",
		);
		assert!(
			pid_in_protected_subtree(3, &protected, &parents),
			"a child collected through the protected node must be excluded too",
		);
		assert!(
			!pid_in_protected_subtree(4, &protected, &parents),
			"a real child of the sweep root must still be signalled",
		);
		assert!(
			!pid_in_protected_subtree(1, &protected, &parents),
			"the sweep root must not be pruned",
		);
	}

	/// Windows keeps the parent pid an orphan recorded, so after its parent
	/// exits the orphan is listed under whichever later process reuses that
	/// pid. The walk must not adopt it: an older process cannot be the child of
	/// a newer one, and a cancellation sweep would otherwise terminate an
	/// unrelated program.
	#[cfg(windows)]
	#[test]
	fn descendant_walk_skips_processes_older_than_their_listed_parent() {
		use std::{process::Command, thread, time::Duration};

		let spawn = || {
			Command::new("ping")
				.args(["-n", "30", "127.0.0.1"])
				.stdout(std::process::Stdio::null())
				.spawn()
				.expect("spawn sleeper")
		};
		let mut older = spawn();
		// Creation times have coarse granularity; keep the two apart.
		thread::sleep(Duration::from_millis(50));
		let mut newer = spawn();
		let (older_pid, newer_pid) = (older.id(), newer.id());
		let pin = |pid: u32| platform::Process::from_pid(i32::try_from(pid).unwrap()).unwrap();

		// A snapshot in which the older process names the newer one as its
		// parent, as it would after its own parent exited and the pid was reused.
		let tree = HashMap::from([(newer_pid, smallvec::SmallVec::from_slice(&[older_pid]))]);
		assert!(
			pin(newer_pid).children_from_tree(&tree).is_empty(),
			"an older process is not a child"
		);

		// The same entry is accepted when the listed child is newer.
		let tree = HashMap::from([(older_pid, smallvec::SmallVec::from_slice(&[newer_pid]))]);
		let children = pin(older_pid).children_from_tree(&tree);
		assert_eq!(
			children
				.iter()
				.map(platform::Process::pid)
				.collect::<Vec<_>>(),
			[i32::try_from(newer_pid).unwrap()]
		);

		let _ = older.kill();
		let _ = newer.kill();
		let _ = older.wait();
		let _ = newer.wait();
	}

	/// `kill_process_group` is the last line of defense: even if a future
	/// caller manages to feed the harness's own pgid into the signal path,
	/// this wrapper must refuse to deliver the signal.
	#[cfg(unix)]
	#[test]
	fn kill_process_group_refuses_self_pgroup() {
		// SAFETY: `getpgid(0)` queries the calling process and does not touch
		// caller-owned memory.
		let self_pgid = unsafe { libc::getpgid(0) };
		assert!(self_pgid > 0, "getpgid(0) failed");
		assert!(
			!kill_process_group(self_pgid, TERM_SIGNAL),
			"kill_process_group must refuse the harness pgid; otherwise the test process would have \
			 been SIGTERMed",
		);
		assert!(
			!kill_process_group(0, TERM_SIGNAL),
			"kill_process_group must reject non-positive pgids",
		);
	}

	/// A public target set can name the harness's process group. The group
	/// path must reject it before enumerating its members: direct pidfd
	/// delivery would otherwise terminate the embedding host.
	#[cfg(unix)]
	#[test]
	fn termination_targets_spare_the_harness_group() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn shared-group child");
		let child_pid = i32::try_from(child.id()).expect("child pid fits");
		// SAFETY: `getpgid` reads the kernel's process-group table only.
		let self_pgid = unsafe { libc::getpgid(0) };
		assert!(self_pgid > 0, "getpgid(0) failed");
		// SAFETY: `getpgid` reads the kernel's process-group table only.
		assert_eq!(unsafe { libc::getpgid(child_pid) }, self_pgid, "child shares harness group");

		let mut targets = TerminationTargets::new();
		targets.add_pgid(self_pgid);
		targets.signal(TERM_SIGNAL);
		thread::sleep(Duration::from_millis(50));
		assert_eq!(child.try_wait().expect("poll child"), None, "self group must not be signalled");

		let _ = child.kill();
		let _ = child.wait();
	}

	/// `terminate_tree(true, ...)` must still terminate an ordinary child in
	/// the harness's group without signalling the harness in its TERM or KILL
	/// waves. A child that ignores TERM forces the hard wave.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_spares_the_harness_group() {
		use std::process::Command;

		// The loop ends when the harness is gone, so a regression that kills
		// the harness leaves no orphan behind.
		let mut child = Command::new("sh")
			.args(["-c", "trap '' TERM; while kill -0 $PPID 2>/dev/null; do :; done"])
			.spawn()
			.expect("spawn shared-group child");
		let child_pid = i32::try_from(child.id()).expect("child pid fits");
		let process = Process::from_pid(child_pid).expect("pin child");
		// SAFETY: `getpgid` reads the kernel's process-group table only.
		let child_pgid = unsafe { libc::getpgid(child_pid) };
		// SAFETY: `getpgid` reads the kernel's process-group table only.
		let self_pgid = unsafe { libc::getpgid(0) };
		assert_eq!(child_pgid, self_pgid, "child shares harness group");
		assert!(
			process
				.terminate_tree(true, 10, 1_000, CancelToken::default())
				.await
				.expect("terminate child"),
			"hard wave must reap TERM-ignoring child"
		);
		let _ = child.wait();
	}
	/// Starts `sh` leading its own process group, with a TERM trap that
	/// appends one `x` to `runs` each time it runs, and waits for its loop.
	#[cfg(unix)]
	fn spawn_term_trap_group_leader(dir: &std::path::Path) -> (std::process::Child, Process) {
		use std::{
			os::unix::process::CommandExt,
			process::Command,
			thread,
			time::{Duration, Instant},
		};

		let child = Command::new("sh")
			.args([
				"-c",
				"trap 'printf x >> runs; sleep 0.3; exit 0' TERM; : > ready; while :; do :; done",
			])
			.current_dir(dir)
			.process_group(0)
			.spawn()
			.expect("spawn trap shell");
		let pid = i32::try_from(child.id()).expect("child pid fits in i32");
		let process = Process::from_pid(pid).expect("pin trap shell");
		let deadline = Instant::now() + Duration::from_secs(5);
		while !dir.join("ready").exists() {
			assert!(Instant::now() < deadline, "trap shell never became ready");
			thread::sleep(Duration::from_millis(10));
		}
		(child, process)
	}

	/// Reaps `child` within 5 s and returns what its TERM trap wrote.
	#[cfg(unix)]
	fn trap_runs_after_exit(mut child: std::process::Child, dir: &std::path::Path) -> String {
		use std::{
			thread,
			time::{Duration, Instant},
		};

		let deadline = Instant::now() + Duration::from_secs(5);
		while child.try_wait().expect("poll trap shell").is_none() {
			if Instant::now() >= deadline {
				let _ = child.kill();
				let _ = child.wait();
				panic!("trap shell did not exit after TERM");
			}
			thread::sleep(Duration::from_millis(10));
		}
		std::fs::read_to_string(dir.join("runs")).expect("TERM trap ran")
	}

	/// A shell runs its TERM trap once for each TERM it takes, so a wave that
	/// reaches a process through its process group must not signal it again
	/// directly.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_signals_a_group_leader_once() {
		let dir = tempfile::tempdir().expect("trap directory");
		let (child, process) = spawn_term_trap_group_leader(dir.path());
		let exited = process
			.terminate_tree(true, 5_000, 1_000, CancelToken::default())
			.await
			.expect("terminate trap shell");
		assert!(exited, "the trap shell must exit inside the TERM grace");
		assert_eq!(trap_runs_after_exit(child, dir.path()), "x");
	}

	/// Compiles `tests/fixtures/group-move.c` into `dir` and returns its path.
	#[cfg(target_os = "linux")]
	pub(crate) fn compile_group_move_helper(dir: &std::path::Path) -> std::path::PathBuf {
		let fixture =
			std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/group-move.c");
		let helper = dir.join("group-move");
		let compiled = std::process::Command::new("cc")
			.args(["-O2", "-Wall", "-o"])
			.arg(&helper)
			.arg(&fixture)
			.status()
			.expect("run C compiler");
		assert!(compiled.success(), "compile group-move helper");
		helper
	}

	/// A member's TERM handler creates a new session and keeps running, and
	/// the leader exits on TERM. The KILL wave re-walks from the dead leader
	/// and the signalled group, and finds the member in neither; it must still
	/// kill it before `terminate_tree` reports the tree gone. In `orphan` mode
	/// the member was never the leader's descendant (a double fork left it in
	/// the group), so only the TERM wave's pinned group members know it.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_kills_a_member_that_left_its_group_on_term() {
		use std::{
			os::unix::process::CommandExt,
			process::Command,
			time::{Duration, Instant},
		};

		let helper_root = tempfile::tempdir().expect("helper directory");
		let helper = compile_group_move_helper(helper_root.path());
		for mode in ["exit", "orphan", "spawn"] {
			let root = tempfile::tempdir().expect("group-move directory");
			let mut parent = Command::new(&helper)
				.arg(mode)
				.current_dir(root.path())
				.process_group(0)
				.spawn()
				.expect("spawn group-move helper");
			let deadline = Instant::now() + Duration::from_secs(5);
			while !root.path().join("ready").exists() {
				assert!(Instant::now() < deadline, "{mode}: group-move child never became ready");
				tokio::time::sleep(Duration::from_millis(5)).await;
			}
			let child_pid = wait_for_pid_file(&root.path().join("childpid"));
			let child = Process::from_pid(child_pid).expect("pin group-move child");
			let leader = Process::from_pid(i32::try_from(parent.id()).expect("pid fits"))
				.expect("pin group-move parent");
			let exited = leader
				.terminate_tree(true, 300, 2_000, CancelToken::default())
				.await
				.expect("terminate group-move parent");
			let child_alive = child.status() == ProcessStatus::Running;
			let _ = child.signal(KILL_SIGNAL);
			let _ = parent.wait();
			assert!(exited, "{mode}: terminate_tree must finish the tree");
			assert!(!child_alive, "{mode}: the member that left its group outlived terminate_tree");
			if mode == "spawn" {
				assert_spawned_child_gone(root.path());
			}
		}
	}

	/// The `spawn` member's TERM handler forked a child after it left its
	/// group. That child must be gone (within 2 s, for callers that do not
	/// wait after their last KILL wave); it is killed here otherwise.
	#[cfg(target_os = "linux")]
	pub(crate) fn assert_spawned_child_gone(dir: &std::path::Path) {
		use std::{
			thread,
			time::{Duration, Instant},
		};

		let pid = wait_for_pid_file(&dir.join("grandpid"));
		let Some(spawned) = Process::from_pid(pid) else {
			return;
		};
		let deadline = Instant::now() + Duration::from_secs(2);
		while spawned.status() == ProcessStatus::Running && Instant::now() < deadline {
			thread::sleep(Duration::from_millis(10));
		}
		let alive = spawned.status() == ProcessStatus::Running;
		let _ = spawned.signal(KILL_SIGNAL);
		assert!(
			!alive,
			"spawn: the child the member forked after leaving its group outlived the kill"
		);
	}

	/// A group member can join after the parent gets TERM, or create a new
	/// session in its TERM handler. Each pinned member of one wave gets TERM
	/// exactly once in both shapes. The old group broadcast plus live-pgid
	/// check missed joiners and sent leavers a second TERM.
	#[cfg(target_os = "linux")]
	#[test]
	fn group_members_that_move_during_term_are_signalled_once() {
		use std::{
			os::unix::process::CommandExt,
			process::Command,
			thread,
			time::{Duration, Instant},
		};

		let helper_root = tempfile::tempdir().expect("helper directory");
		let helper = compile_group_move_helper(helper_root.path());
		for mode in ["in", "out"] {
			for _ in 0..20 {
				let root = tempfile::tempdir().expect("group-move directory");
				let mut parent = Command::new(&helper)
					.arg(mode)
					.current_dir(root.path())
					.process_group(0)
					.spawn()
					.expect("spawn group-move helper");
				let deadline = Instant::now() + Duration::from_secs(3);
				let child_pid = loop {
					let pid = std::fs::read_to_string(root.path().join("childpid"))
						.ok()
						.and_then(|text| text.parse::<i32>().ok());
					if let Some(pid) = pid
						&& root.path().join("ready").exists()
					{
						break pid;
					}
					assert!(Instant::now() < deadline, "group-move child never became ready");
					thread::sleep(Duration::from_millis(1));
				};
				let child = Process::from_pid(child_pid).expect("pin group-move child");
				let mut targets = TerminationTargets::new();
				let parent_pid = i32::try_from(parent.id()).expect("parent pid fits");
				targets.add_pgid(parent_pid);
				targets.add_process(Process::from_pid(parent_pid).expect("pin group-move parent"));
				targets.signal(TERM_SIGNAL);
				let terms = root.path().join("terms");
				let wait_for_terms = |count: usize| {
					let deadline = Instant::now() + Duration::from_secs(5);
					loop {
						let seen = std::fs::read_to_string(&terms).unwrap_or_default();
						if seen.len() >= count || Instant::now() >= deadline {
							return seen;
						}
						thread::sleep(Duration::from_millis(5));
					}
				};
				wait_for_terms(1);
				// A duplicate is delivered within microseconds of the first TERM;
				// leave it time to land before counting.
				thread::sleep(Duration::from_millis(200));
				assert_eq!(
					std::fs::read_to_string(&terms).unwrap_or_default(),
					"x",
					"{mode}: group member did not receive exactly one TERM"
				);
				assert!(child.signal(TERM_SIGNAL), "{mode}: direct TERM control");
				assert_eq!(wait_for_terms(2), "xx", "{mode}: child handler did not remain alive");
				let _ = child.signal(KILL_SIGNAL);
				let _ = parent.kill();
				let _ = parent.wait();
			}
		}
	}

	/// Writes `scripts` (name, text) into `dir`, starts `sh leader.sh` leading
	/// its own process group, and waits for it to create `ready`.
	#[cfg(unix)]
	fn spawn_group_leader_script(
		dir: &std::path::Path,
		scripts: &[(&str, &str)],
	) -> (std::process::Child, Process) {
		use std::{
			os::unix::process::CommandExt,
			process::Command,
			thread,
			time::{Duration, Instant},
		};

		for (name, text) in scripts {
			std::fs::write(dir.join(name), text).expect("write script");
		}
		let child = Command::new("sh")
			.arg("leader.sh")
			.current_dir(dir)
			.process_group(0)
			.spawn()
			.expect("spawn leader shell");
		let pid = i32::try_from(child.id()).expect("leader pid fits");
		let process = Process::from_pid(pid).expect("pin leader shell");
		let deadline = Instant::now() + Duration::from_secs(5);
		while !dir.join("ready").exists() {
			assert!(Instant::now() < deadline, "leader shell never became ready");
			thread::sleep(Duration::from_millis(5));
		}
		(child, process)
	}

	/// Polls `path` for up to 5 s until it holds a pid.
	#[cfg(unix)]
	pub(crate) fn wait_for_pid_file(path: &std::path::Path) -> i32 {
		use std::{
			thread,
			time::{Duration, Instant},
		};

		let deadline = Instant::now() + Duration::from_secs(5);
		loop {
			if let Some(pid) = std::fs::read_to_string(path)
				.ok()
				.and_then(|text| text.trim().parse::<i32>().ok())
			{
				return pid;
			}
			assert!(Instant::now() < deadline, "{} never held a pid", path.display());
			thread::sleep(Duration::from_millis(5));
		}
	}

	/// A group member forks a child after the wave took its snapshot and
	/// before it signals. The child is in the group when the group is
	/// signalled, so it must get the signal. A wave that signalled only its
	/// pinned snapshot never reached it.
	#[cfg(unix)]
	#[test]
	fn child_forked_inside_a_wave_gets_the_group_signal() {
		use std::{
			thread,
			time::{Duration, Instant},
		};

		let dir = tempfile::tempdir().expect("script directory");
		let (mut leader, process) = spawn_group_leader_script(dir.path(), &[
			("leader.sh", "trap 'sh child.sh &' USR1\n: > ready\nwhile :; do :; done\n"),
			(
				"child.sh",
				"trap 'printf x >> terms; exit 0' TERM\necho $$ > forked\nwhile :; do :; done\n",
			),
		]);
		let mut wave = SignalWave::new(TERM_SIGNAL);
		wave.tree(&process, process.led_group(), &host_protected_pids());
		assert!(process.signal(libc::SIGUSR1), "ask the leader to fork");
		let child_pid = wait_for_pid_file(&dir.path().join("forked"));
		wave.deliver();

		let terms_path = dir.path().join("terms");
		let deadline = Instant::now() + Duration::from_secs(5);
		while std::fs::read_to_string(&terms_path)
			.unwrap_or_default()
			.is_empty()
			&& Instant::now() < deadline
		{
			thread::sleep(Duration::from_millis(5));
		}
		// Leave a duplicate time to land before counting.
		thread::sleep(Duration::from_millis(200));
		let terms = std::fs::read_to_string(&terms_path).unwrap_or_default();
		if let Some(child) = Process::from_pid(child_pid) {
			let _ = child.signal(KILL_SIGNAL);
		}
		let _ = leader.kill();
		let _ = leader.wait();
		assert_eq!(terms, "x", "the child forked inside the wave must get TERM once");
	}

	/// `terminate_tree(true, …)` reports the tree gone only once every
	/// member of the group it signalled is gone. Here the leader's TERM trap
	/// starts a TERM-ignoring child in the group and exits: the early return
	/// used to see only the exited leader and skip the KILL wave, leaving
	/// the child running.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_waits_for_the_signalled_group() {
		let dir = tempfile::tempdir().expect("script directory");
		let (mut leader, process) = spawn_group_leader_script(dir.path(), &[
			("leader.sh", "trap 'sh child.sh & exit 0' TERM\n: > ready\nwhile :; do :; done\n"),
			("child.sh", "trap '' TERM\necho $$ > forked\nexec sleep 10\n"),
		]);
		let exited = process
			.terminate_tree(true, 500, 2_000, CancelToken::default())
			.await
			.expect("terminate leader");
		let _ = leader.wait();
		let child_pid = wait_for_pid_file(&dir.path().join("forked"));
		let child = Process::from_pid(child_pid);
		let child_alive = child
			.as_ref()
			.is_some_and(|child| child.status() == ProcessStatus::Running);
		if let Some(child) = &child {
			let _ = child.signal(KILL_SIGNAL);
		}
		assert!(exited, "terminate_tree must kill the TERM-ignoring group member");
		assert!(!child_alive, "a group member outlived terminate_tree");
	}

	/// Regression test for the macOS `proc_listchildpids` brokenness: on
	/// darwin 25.4+ the kernel returns no entries when a process queries its
	/// own children via that API, so `Process::descendants` produced an empty
	/// list and termination cleanup silently became a no-op. The replacement
	/// path scans `proc_listallpids` and groups by `pbi_ppid`, which actually
	/// works. Linux has always worked via `/proc`.
	#[cfg(unix)]
	#[test]
	fn descendants_includes_freshly_spawned_child() {
		use std::{process::Command, thread, time::Duration};

		let mut child = Command::new("sleep")
			.arg("10")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");

		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("harness Process ref");

		// Allow a few polling iterations so the kernel's process-table query
		// settles on a loaded host. proc_listallpids reflects newly forked pids
		// within milliseconds in practice; 1s is a comfortable upper bound.
		let mut found = false;
		for _ in 0..40 {
			if harness
				.live_descendants()
				.iter()
				.any(|descendant| descendant.pid() == child_pid)
			{
				found = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}

		let _ = child.kill();
		let _ = child.wait();

		assert!(
			found,
			"freshly spawned child pid {child_pid} must appear in `live_descendants` so the \
			 cancellation cleanup can reach it; this regressed on macOS when the walk relied on the \
			 broken `proc_listchildpids`",
		);
	}

	/// Regression test for issue #4605: `SpawnRegistry` MUST pin a stable
	/// [`Process`] reference at spawn time rather than defer re-opening the
	/// pid until termination.
	///
	/// Before the fix, `SpawnRegistry` stored only the raw pid; `build_targets`
	/// called `Process::from_pid` at cancellation time. On Windows pids recycle
	/// aggressively, so a bash-spawned `pwsh.exe` that had already exited could
	/// see its pid reassigned to an unrelated PowerShell session (e.g. the
	/// user's other Cursor terminal). `Process::from_pid` at cancel time would
	/// happily open that unrelated process, and `signal_tree` would then
	/// enumerate — and `TerminateProcess` — the entire foreign subtree.
	///
	/// This test cannot literally trigger Windows pid recycling from a
	/// cross-platform Rust test, but it can prove the observable defense: a
	/// recorded process reference survives the original pid's death (so no
	/// "look it up again" step exists to be raced), and the registry never
	/// consults `Process::from_pid` when a handle was pinned at record time.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_pins_identity_at_record_time() {
		use std::{process::Command, thread, time::Duration};

		// Phase 1: while the child is alive, the pinned handle carries identity
		// forward into `build_targets` without any `Process::from_pid` re-open
		// step existing to be raced against pid reuse.
		let mut long = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let long_pid = i32::try_from(long.id()).expect("child pid fits in i32");

		let registry = SpawnRegistry::new();
		let pinned = Process::from_pid(long_pid).expect("pin child at record time");
		registry.record(None, Some(pinned));

		let live_targets = registry.build_targets();
		assert!(
			!live_targets.is_empty(),
			"a still-live pinned child must appear in the target set — otherwise the cancellation \
			 cleanup would silently miss it"
		);
		let live_pids: Vec<i32> = live_targets.processes.iter().map(Process::pid).collect();
		assert_eq!(
			live_pids,
			vec![long_pid],
			"target set must come from the pinned handle recorded at spawn time, not a re-lookup by \
			 pid (which would race pid reuse — issue #4605)"
		);

		let _ = long.kill();
		let _ = long.wait();

		// Phase 2: once the child exits, the registry MUST drop the entry
		// rather than reintroduce a `Process::from_pid` re-open at kill time.
		// Poll until pruning sees the pidfd as Exited (kernel-visible within
		// milliseconds in practice).
		let mut empty_after_exit = false;
		for _ in 0..40 {
			if registry.build_targets().is_empty() {
				empty_after_exit = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}
		assert!(
			empty_after_exit,
			"once the pinned child exits the registry must drop it — re-opening by pid at \
			 termination time is exactly the pid-reuse race #4605 closes"
		);
	}

	/// `TerminationTargets::add_process` must accept a pre-pinned handle
	/// without going through `Process::from_pid`. This is the API contract
	/// `SpawnRegistry` relies on to avoid the PID-reuse race.
	#[cfg(unix)]
	#[test]
	fn add_process_bypasses_from_pid_lookup() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let pinned = Process::from_pid(self_pid).expect("pin self");

		let mut targets = TerminationTargets::new();
		targets.add_process(pinned.clone());
		assert!(!targets.is_empty(), "add_process must record the pinned handle");

		// Adding the same pid again through either entry point must dedupe:
		// otherwise every wave in `terminate_run` would re-signal the same
		// tree N times.
		targets.add_process(pinned);
		targets.add_pid(self_pid);
		assert_eq!(targets.processes.len(), 1, "duplicate pids must be deduped");
	}

	/// Regression test for the review on PR #4606: a long-running shell
	/// command that spawns many short-lived external processes must not
	/// retain one owned handle per historical spawn — that would exhaust
	/// per-process FD/handle limits (pidfd on Linux, `HANDLE` on Windows).
	/// The registry MUST prune dead entries once the recorded vec crosses
	/// the sweep threshold.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_prunes_exited_entries() {
		use std::{thread, time::Duration};

		let registry = SpawnRegistry::new();

		// Fabricate many recorded-then-exited children by pinning ourselves,
		// pushing the entry, then immediately treating it as "dead" from the
		// registry's perspective. To simulate the exit without actually
		// killing the harness, use `Process::from_pid(1)` for a pid that
		// (on Linux) is init and never exits — but wrap the recording in a
		// pattern that guarantees `status()` returns Exited for the pruner:
		// spawn a tiny child, pin it, wait for exit, then record.
		for _ in 0..(SpawnRegistry::PRUNE_THRESHOLD * 2) {
			let mut child = std::process::Command::new("true")
				.spawn()
				.expect("spawn true");
			let pid = i32::try_from(child.id()).expect("child pid fits in i32");
			let pinned = Process::from_pid(pid);
			let _ = child.wait();
			// Give the kernel a moment to mark the pidfd readable so `status()`
			// reports Exited when the pruner probes.
			for _ in 0..20 {
				if pinned
					.as_ref()
					.is_some_and(|process| process.status() == ProcessStatus::Exited)
				{
					break;
				}
				thread::sleep(Duration::from_millis(5));
			}
			registry.record(None, pinned);
		}

		let retained = registry.state.lock().spawned.len();
		assert!(
			retained < SpawnRegistry::PRUNE_THRESHOLD,
			"pruning must bound retained entries below the sweep threshold once the pinned processes \
			 have exited; got {retained} retained (threshold {})",
			SpawnRegistry::PRUNE_THRESHOLD
		);

		// build_targets sees no live handles → empty target set, matching the
		// contract that fully-exited registries stop the wave loop early.
		let targets = registry.build_targets();
		assert!(targets.is_empty(), "registry of only-dead entries must produce an empty target set");
	}

	/// Regression test for the third review on PR #4606: once the recorded
	/// vec crosses `PRUNE_THRESHOLD`, subsequent `record` calls must NOT
	/// sweep on every spawn. Without the `next_sweep_at` watermark, a large
	/// fan-out run whose live children exceed the threshold turned every
	/// spawn into an O(N) status probe of the whole retained set.
	///
	/// The check reasons about the observable side effect: after N records
	/// past threshold with entries that CANNOT be pruned (all still live),
	/// the retained size grows monotonically by exactly N — no sweep runs
	/// have modified the vec in between. The direct signal of "did a sweep
	/// happen" is a stable pinned handle count across records.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_watermark_bounds_sweep_frequency() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let registry = SpawnRegistry::new();

		// Fill past threshold with entries that are permanently alive
		// (pinning ourselves) so the pruner has nothing to remove.
		let fill = SpawnRegistry::PRUNE_THRESHOLD + 10;
		for _ in 0..fill {
			registry.record(None, Process::from_pid(self_pid));
		}
		let after_fill = registry.state.lock().spawned.len();
		assert_eq!(after_fill, fill, "live-only entries must not be pruned during warm-up");
		let watermark_after_fill = registry.state.lock().next_sweep_at;

		// Every additional record with a live entry must land in the vec
		// verbatim and — critically — NOT re-enter `prune_exited` until the
		// vec crosses the freshly scheduled watermark. If the guard were
		// still `len >= PRUNE_THRESHOLD` (pre-fix), a sweep would fire on
		// every one of these records.
		let extra = 20;
		for _ in 0..extra {
			registry.record(None, Process::from_pid(self_pid));
		}
		let after_extra = registry.state.lock().spawned.len();
		assert_eq!(
			after_extra,
			after_fill + extra,
			"records with live entries must accumulate without triggering per-spawn sweeps"
		);
		assert_eq!(
			registry.state.lock().next_sweep_at,
			watermark_after_fill,
			"watermark must not advance while the vec stays below it — otherwise a sweep ran"
		);
	}

	/// `wait_for_exit` on a lone process resolves when it exits, reports a
	/// timeout as `false`, and surfaces cancellation as an abort error.
	#[tokio::test(flavor = "multi_thread")]
	async fn wait_for_exit_resolves_times_out_and_aborts() {
		use std::process::Command;

		#[cfg(unix)]
		let mut child = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		#[cfg(windows)]
		let mut child = Command::new("ping")
			.args(["-n", "30", "127.0.0.1"])
			.stdout(std::process::Stdio::null())
			.spawn()
			.expect("spawn sleeper");
		let process = Process::from_pid(i32::try_from(child.id()).unwrap()).expect("pin child");

		let waited = process
			.wait_for_exit(Some(Duration::from_millis(100)), CancelToken::default())
			.await
			.expect("bounded wait");
		assert!(!waited, "a running process times out");

		let aborted = process
			.wait_for_exit(None, CancelToken::new(Some(100)))
			.await
			.expect_err("an expired token aborts the wait");
		assert_eq!(aborted.to_string(), "Aborted: Timeout");

		let waiter = {
			let process = process.clone();
			tokio::spawn(async move {
				process
					.wait_for_exit(Some(Duration::from_secs(20)), CancelToken::default())
					.await
			})
		};
		tokio::time::sleep(Duration::from_millis(50)).await;
		child.kill().expect("kill child");
		let exited = tokio::time::timeout(Duration::from_secs(5), waiter)
			.await
			.expect("the wait ends promptly after exit")
			.expect("waiter task")
			.expect("wait result");
		assert!(exited, "exit resolves the wait");
		let _ = child.wait();
	}
}
