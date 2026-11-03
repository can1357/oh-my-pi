//! Identity-pinned process references, and the ledger of the processes a run,
//! or a `timeout` operand, spawned.
//!
//! A [`PinnedProcess`] names one process for its whole life: a pidfd on Linux,
//! an open handle on Windows, the kernel-reported start time on macOS. Signals
//! go through that identity, never through a bare pid or process-group number,
//! so they cannot reach a process that took either number after the original
//! exited. `pi-shell`'s process references wrap this type, and the `timeout`
//! builtin records its operand's children with it.

use std::collections::{HashMap, HashSet};

use smallvec::SmallVec;

use crate::proc_snapshot::ProcessStatus;

/// Every process's pid, by the process group it was in when the table was
/// read. A signal wave reads it once, however many groups it signals.
type GroupTable = HashMap<i32, SmallVec<[i32; 4]>>;

#[cfg(target_os = "linux")]
mod platform {
	use std::{
		collections::HashSet,
		fs,
		os::fd::{AsFd, AsRawFd, BorrowedFd, OwnedFd},
		sync::{Arc, OnceLock},
	};

	use super::GroupTable;
	use crate::proc_snapshot::{ProcessStatus, sys};

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct PinnedProcess {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
		/// The pidfd's inode on kernels whose pidfds live on pidfs (Linux 6.9
		/// and later): one inode per process, never shared with another.
		inode:      Option<u64>,
	}

	/// `PIDFS_MAGIC`: the file system type of pidfds on Linux 6.9 and later.
	const PIDFS_MAGIC: u64 = 0x5049_4446;

	/// The pidfd's inode when pidfds are on pidfs, where it names one process.
	/// Older kernels give every pidfd the same anonymous inode, so `None`.
	fn pidfs_inode(pidfd: BorrowedFd<'_>) -> Option<u64> {
		static ON_PIDFS: OnceLock<bool> = OnceLock::new();
		let on_pidfs = *ON_PIDFS.get_or_init(|| {
			// SAFETY: an all-zero `statfs` is valid; the pidfd is open for the
			// call and the kernel writes only into `stats`.
			let mut stats: libc::statfs = unsafe { std::mem::zeroed() };
			// SAFETY: as above.
			let read = unsafe { libc::fstatfs(pidfd.as_raw_fd(), &raw mut stats) } == 0;
			read && stats.f_type as u64 == PIDFS_MAGIC
		});
		if !on_pidfs {
			return None;
		}
		// SAFETY: an all-zero `stat` is valid; the pidfd is open for the call
		// and the kernel writes only into `stat`.
		let mut stat: libc::stat = unsafe { std::mem::zeroed() };
		// SAFETY: as above.
		(unsafe { libc::fstat(pidfd.as_raw_fd(), &raw mut stat) } == 0).then_some(stat.st_ino)
	}

	impl PinnedProcess {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = Arc::new(sys::open_pidfd(pid)?);
			let start_time = sys::start_time(pid)?;
			let inode = pidfs_inode(pidfd.as_fd());
			Some(Self { pid, pidfd, start_time, inode })
		}

		/// Processes whose `/proc/{pid}/exe` symlink resolves to exactly
		/// `target`.
		pub fn find_by_path(target: &str) -> Vec<Self> {
			sys::pids()
				.filter(|pid| {
					fs::read_link(format!("/proc/{pid}/exe"))
						.is_ok_and(|resolved| resolved.as_os_str() == target)
				})
				.filter_map(Self::from_pid)
				.collect()
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
			// The children were read and checked by pid number. They are this
			// process's only if it still runs now: a running process held its
			// pid for the whole walk, so no other process could have taken it.
			if !self.live_identity() {
				return Vec::new();
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

		/// The group this process is in, read through [`sys::process_group`] so
		/// that a security module which refuses `getpgid` falls back to the
		/// `/proc` line instead of losing the group: a pin whose group cannot
		/// be read is pinned by nothing and its members are never reached.
		pub fn group_id(&self) -> Option<i32> {
			if self.status() != ProcessStatus::Running {
				return None;
			}

			let pgid = sys::process_group(self.pid)?;
			// Still running after the read, the process held its pid throughout,
			// so the group read is its own and not that of a process that took
			// the pid after it exited.
			(pgid > 0 && self.status() == ProcessStatus::Running).then_some(pgid)
		}

		/// Whether `other` pins the same process. On pidfs the pidfd inodes
		/// decide. Elsewhere the start time has only clock-tick resolution, so
		/// two pins with the same pid are the same process only while both
		/// still run: one pid names one running process. A pin whose process
		/// exited is never the same as another, and needs no signal.
		pub fn same_identity(&self, other: &Self) -> bool {
			if Arc::ptr_eq(&self.pidfd, &other.pidfd) {
				return true;
			}
			if self.pid != other.pid {
				return false;
			}
			match (self.inode, other.inode) {
				(Some(mine), Some(theirs)) => mine == theirs,
				_ => {
					self.start_time == other.start_time
						&& self.status() == ProcessStatus::Running
						&& other.status() == ProcessStatus::Running
				},
			}
		}

		/// Every process by its group, in one pass over `/proc`.
		pub fn process_groups() -> GroupTable {
			let mut groups = GroupTable::new();
			for pid in sys::pids() {
				if let Some(group) = sys::process_group(pid) {
					groups.entry(group).or_default().push(pid);
				}
			}
			groups
		}

		/// Pins each of `candidates` that is a running member of `group`; each
		/// member's group is re-read after its pidfd is open. This proves
		/// nothing about who owns the group number: the caller holds that
		/// proof (see [`super::GroupProof`]).
		pub fn members_among(group: i32, candidates: &[i32]) -> Vec<Self> {
			candidates
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.filter(|member| member.group_id() == Some(group) && member.status() == ProcessStatus::Running)
				.collect()
		}

		/// Pins the running members of the group this unreaped child leads.
		/// The caller guarantees the child is not reaped before this returns,
		/// so its pid holds the group's number and every member is the
		/// operand's.
		///
		/// This is the only moment a member that leaves the group later — a
		/// process that calls `setsid` to detach, for one — can be reached, so
		/// the scan runs on the reap of every external command. It reads each
		/// pid's group with one `getpgid` syscall, about a millisecond for a
		/// thousand processes.
		pub fn members_before_reap(&self) -> Vec<Self> {
			if sys::process_group(self.pid) != Some(self.pid) {
				return Vec::new();
			}
			let candidates: Vec<i32> =
				sys::pids().filter(|&pid| sys::process_group(pid) == Some(self.pid)).collect();
			Self::members_among(self.pid, &candidates)
		}

		/// Sends `signal` to the process group this process leads through
		/// Linux 6.9's `PIDFD_SIGNAL_PROCESS_GROUP`. The kernel resolves the
		/// group from the pinned leader, not from the number. Older kernels have
		/// no such proof once the leader has exited, so they signal nothing here;
		/// callers that can prove a group by its leader list its members.
		pub fn signal_group(&self, signal: i32) -> bool {
			if super::leads_host_group(self.pid) {
				return false;
			}
			sys::pidfd_send_group_signal(self.pidfd.as_fd(), signal).is_ok()
		}

		pub fn status(&self) -> ProcessStatus {
			pidfd_status(self.pidfd.as_fd())
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

	/// Whether the process `pidfd` pins still runs: its pidfd turns readable
	/// once it exits.
	fn pidfd_status(pidfd: BorrowedFd<'_>) -> ProcessStatus {
		loop {
			let mut pollfd = libc::pollfd { fd: pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
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
			if (pollfd.revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR | libc::POLLNVAL)) != 0 {
				return ProcessStatus::Exited;
			}
			return ProcessStatus::Running;
		}
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ptr,
	};

	use super::GroupTable;
	use crate::proc_snapshot::{ProcessStatus, sys};

	/// macOS does not expose pidfds; identity is pinned via the kernel-reported
	/// process start time so a recycled PID does not silently impersonate the
	/// original target.
	#[derive(Clone)]
	pub struct PinnedProcess {
		pid:          i32,
		start_tvsec:  u64,
		start_tvusec: u64,
	}

	impl PinnedProcess {
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

		/// Processes whose libproc-reported executable path equals `target`.
		pub fn find_by_path(target: &str) -> Vec<Self> {
			let mut path = [0u8; sys::PATH_CAPACITY];
			sys::pids()
				.into_iter()
				.filter(|pid| *pid > 0 && sys::executable_path(*pid, &mut path) == Some(target.as_bytes()))
				.filter_map(Self::from_pid)
				.collect()
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
			self.children_from_tree(&tree)
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

		/// Whether `other` pins the same macOS process, identified by pid and
		/// start time rather than the pid alone.
		pub fn same_identity(&self, other: &Self) -> bool {
			self.pid == other.pid
				&& self.start_tvsec == other.start_tvsec
				&& self.start_tvusec == other.start_tvusec
		}

		/// Every process by its group, from one libproc listing.
		pub fn process_groups() -> GroupTable {
			let mut groups = GroupTable::new();
			for pid in sys::pids() {
				if let Some(group) = sys::bsdinfo(pid).and_then(|info| i32::try_from(info.pbi_pgid).ok()) {
					groups.entry(group).or_default().push(pid);
				}
			}
			groups
		}

		/// Pins each of `candidates` that is a live member of `group`; a member
		/// counts only if its pinned identity still reports the group. This
		/// proves nothing about who owns the group number: the caller holds
		/// that proof (see [`super::GroupProof`]).
		pub fn members_among(group: i32, candidates: &[i32]) -> Vec<Self> {
			candidates
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.filter(|member| member.group_id() == Some(group) && member.status() == ProcessStatus::Running)
				.collect()
		}

		/// Pins the live members of the group this unreaped child leads; the
		/// caller guarantees the child is not reaped before this returns.
		pub fn members_before_reap(&self) -> Vec<Self> {
			let candidates = sys::pids();
			Self::members_among(self.pid, &candidates)
		}

		/// Sends `signal` to the group this process leads after re-checking
		/// its start time immediately before `kill(-pid, signal)`. A leader that
		/// exited is not signalled. The remaining window is one system call.
		pub fn signal_group(&self, signal: i32) -> bool {
			if super::leads_host_group(self.pid) || self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not
			// access caller-owned memory. A negative pid names a process group.
			unsafe { libc::kill(-self.pid, signal) == 0 }
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
			self.collect_descendants_from_tree(&tree, &mut visited, &mut out);
			out
		}

		/// The running process `child_pid`, when it is still a child of
		/// `self`. The snapshot names it by pid, so it is pinned first; its
		/// parent pid is then read through that pin, and `self` must still
		/// run afterwards, so neither pid can have passed to another process.
		fn child(&self, child_pid: i32) -> Option<Self> {
			let child = Self::from_pid(child_pid)?;
			(child.parent_pid() == Some(self.pid) && self.status() == ProcessStatus::Running)
				.then_some(child)
		}

		fn children_from_tree(&self, tree: &HashMap<i32, Vec<i32>>) -> Vec<Self> {
			let Some(child_pids) = tree.get(&self.pid) else {
				return Vec::new();
			};
			child_pids
				.iter()
				.filter_map(|&child_pid| self.child(child_pid))
				.collect()
		}

		fn collect_descendants_from_tree(
			&self,
			tree: &HashMap<i32, Vec<i32>>,
			visited: &mut HashSet<i32>,
			out: &mut Vec<Self>,
		) {
			let Some(child_pids) = tree.get(&self.pid) else {
				return;
			};
			for &child_pid in child_pids {
				if !visited.insert(child_pid) {
					continue;
				}
				let Some(child) = self.child(child_pid) else {
					continue;
				};
				// Post-order: grandchildren first, so leaf processes get signalled
				// before their parents during tree termination.
				child.collect_descendants_from_tree(tree, visited, out);
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
	/// Used as the foundation of `PinnedProcess::children` and
	/// `PinnedProcess::descendants` on macOS where `proc_listchildpids`
	/// returns no children for self-queries.
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
}

#[cfg(target_os = "windows")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ffi::OsStr,
		os::windows::{ffi::OsStrExt, io::OwnedHandle},
		sync::Arc,
	};

	use smallvec::SmallVec;

	use crate::proc_snapshot::{ProcessStatus, sys};

	const PROCESS_REFERENCE_ACCESS: u32 =
		sys::PROCESS_TERMINATE | sys::PROCESS_QUERY_LIMITED_INFORMATION | sys::SYNCHRONIZE;

	#[derive(Clone)]
	/// Stable Windows process reference backed by an owned process handle plus
	/// the kernel-reported creation time, which pins identity even if the PID is
	/// recycled while we hold the handle.
	pub struct PinnedProcess {
		pid:           i32,
		handle:        Arc<OwnedHandle>,
		creation_time: u64,
	}

	impl PinnedProcess {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let handle =
				Arc::new(sys::open_process(u32::try_from(pid).ok()?, PROCESS_REFERENCE_ACCESS)?);
			let creation_time = sys::process_times(&handle)?.0;
			Some(Self { pid, handle, creation_time })
		}

		/// Processes whose `QueryFullProcessImageNameW` result equals `target`.
		pub fn find_by_path(target: &str) -> Vec<Self> {
			let target: Vec<u16> = OsStr::new(target).encode_wide().collect();
			let mut path = vec![0u16; 32_768];
			sys::processes()
				.filter(|entry| {
					sys::open_process(entry.pid, sys::PROCESS_QUERY_LIMITED_INFORMATION)
						.is_some_and(|handle| sys::image_path(&handle, &mut path) == Some(&target[..]))
				})
				.filter_map(|entry| Self::from_pid(i32::try_from(entry.pid).ok()?))
				.collect()
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

		/// Whether `other` pins the same Windows process object.
		pub fn same_identity(&self, other: &Self) -> bool {
			self.pid == other.pid && self.creation_time == other.creation_time
		}

		/// Windows has no process groups.
		pub fn process_groups() -> super::GroupTable {
			super::GroupTable::new()
		}

		/// Windows has no process groups.
		pub const fn members_among(_group: i32, _candidates: &[i32]) -> Vec<Self> {
			Vec::new()
		}

		/// Windows has no process groups.
		pub const fn members_before_reap(&self) -> Vec<Self> {
			Vec::new()
		}

		/// Windows has no process groups.
		pub const fn signal_group(&self, _signal: i32) -> bool {
			false
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
}

pub use platform::PinnedProcess;

/// Whether `pgid` is the calling process's own process group. Signalling it
/// would take the host down with its targets, so
/// [`PinnedProcess::signal_group`] refuses it on every path. An unknown host
/// group (a pid namespace hides the group of its first process) refuses
/// nothing: no pinned process inside the namespace can lead a group outside
/// it.
#[cfg(unix)]
fn leads_host_group(pgid: i32) -> bool {
	// SAFETY: `getpgid(0)` reads the calling process's group and no
	// caller-owned memory.
	let host_group = unsafe { libc::getpgid(0) };
	host_group > 0 && host_group == pgid
}

/// Pids a cancellation sweep must never signal: the harness process itself.
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
#[must_use]
pub fn host_protected_pids() -> HashSet<i32> {
	i32::try_from(std::process::id()).into_iter().collect()
}

/// True when `pid` is itself protected or descends — within the enumerated
/// `parents` map (pid -> recorded parent pid) — from a protected pid. Used to
/// prune a whole protected subtree from a cancellation sweep so a false
/// descendant of the harness cannot drag the harness's real children into the
/// kill set (#7452).
#[must_use]
pub fn pid_in_protected_subtree(pid: i32, protected: &HashSet<i32>, parents: &HashMap<i32, i32>) -> bool {
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

/// The live descendants of `root` with every protected subtree pruned, not
/// just the exact protected pids.
///
/// The flattened descendant list can contain a protected node (the harness,
/// on a Windows PID-reuse false-descendant) *together with* that node's real
/// children, which were collected by recursing through it. Skipping only the
/// exact protected pid would still terminate those unrelated worker/tool
/// subprocesses, so drop every node whose recorded parent chain — within the
/// enumerated set — passes through a protected pid (#7452 review).
#[must_use]
pub fn signalable_descendants(root: &PinnedProcess, protected: &HashSet<i32>) -> Vec<PinnedProcess> {
	let descendants = root.descendants();
	let parents: HashMap<i32, i32> = descendants
		.iter()
		.filter_map(|descendant| descendant.parent_pid().map(|parent| (descendant.pid(), parent)))
		.collect();
	descendants
		.into_iter()
		.filter(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents))
		.collect()
}

/// SIGKILL, and the hard-termination sentinel on Windows.
const KILL_SIGNAL: i32 = 9;

/// What proves that a process-group number still names the group a pinned
/// leader led.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GroupProof {
	/// The leader is a child the caller has not reaped and cannot reap while
	/// the wave runs: an unreaped pid, exited or not, holds its group's
	/// number, so no other group can have it, and `kill(-P)` reaches exactly
	/// that group.
	Unreaped,
	/// Someone else reaps the leader: its number proves nothing, but while
	/// its pin reports it running it holds the number, so its members may be
	/// listed when the leader still runs after the listing.
	Running,
	/// The leader's number proves nothing; only the kernel's group signal
	/// through the leader's pin (Linux 6.9 and later) reaches its group.
	KernelOnly,
}

/// One delivery of a signal to process groups, each through its pinned
/// leader, and to pinned processes.
///
/// Each owned group is signalled at one instant, as the kernel signals a
/// group, so a process a member forks during the wave cannot slip past it:
/// with `kill(-P)` while the leader is provably unreaped
/// ([`GroupProof::Unreaped`]), else with the kernel's group signal through
/// the leader's pin (Linux 6.9 and later). Only where neither applies — a
/// running leader the caller does not reap, on Linux 5.3 to 6.8 — are the
/// members listed and signalled one by one, through their own pins, kept
/// only if the leader still runs after the listing. A group is never
/// signalled because some other process is in a group with that number.
///
/// Exactly once: the wave decides every delivery before it makes any, from a
/// snapshot of each target's process group. A direct target that is in a
/// group the wave signals as a whole is not signalled again, and a listed
/// member is signalled once through its pin. The group signals go first and
/// the direct ones after them, so a target whose handler for the direct
/// signal joins a signalled group does not take the group's signal too. A
/// process that changes its process group while the wave runs may still
/// receive the wave's signal twice, or not at all. The next wave, or the
/// SIGKILL, reaches it when it is pinned by then: listed in a group before a
/// delivery, recorded, or a descendant of a recorded process. A process
/// forked between a group's listing and its signal is not pinned: when it
/// leaves the group before the next wave and its parent is gone, nothing
/// reaches it again. Signals offer no atomic way to list a group and signal
/// it, and stopping the group first would make the shell see a stopped job.
/// SIGKILL is always also sent directly: a second SIGKILL changes nothing a
/// process can observe.
pub struct SignalWave {
	signal:  i32,
	groups:  Vec<(PinnedProcess, GroupProof)>,
	direct:  Vec<PinnedProcess>,
	/// Processes signalled through their own pins.
	reached: Vec<PinnedProcess>,
	/// Members of the groups signalled as a whole, listed under a proof
	/// before the delivery: the processes those group signals reached.
	members: Vec<PinnedProcess>,
	/// Leaders whose groups the kernel signalled through their pins.
	kernel:  Vec<PinnedProcess>,
}

impl SignalWave {
	/// A wave that delivers `signal`.
	#[must_use]
	pub const fn new(signal: i32) -> Self {
		Self {
			signal,
			groups: Vec::new(),
			direct: Vec::new(),
			reached: Vec::new(),
			members: Vec::new(),
			kernel: Vec::new(),
		}
	}

	/// Adds the group `leader` leads, under `proof`. The host's own group is
	/// never signalled.
	pub fn group(&mut self, leader: &PinnedProcess, proof: GroupProof) {
		if let Some(planned) = self.groups.iter_mut().find(|(seen, _)| seen.same_identity(leader)) {
			// A stronger proof wins: unreaped over running over the kernel alone.
			if proof == GroupProof::Unreaped || planned.1 == GroupProof::KernelOnly {
				planned.1 = proof;
			}
			return;
		}
		self.groups.push((leader.clone(), proof));
	}

	/// Adds `process` as a direct target.
	pub fn process(&mut self, process: &PinnedProcess) {
		if !self.direct.iter().any(|seen| seen.same_identity(process)) {
			self.direct.push(process.clone());
		}
	}

	/// Decides every delivery, then makes them. Returns whether any delivery
	/// succeeded.
	pub fn deliver(&mut self) -> bool {
		let mut table: Option<GroupTable> = None;
		// Groups the kernel signals at one instant: by number while the leader
		// is unreaped, or through the leader's pin.
		let mut by_number: Vec<i32> = Vec::new();
		let mut by_pin: Vec<PinnedProcess> = Vec::new();
		let mut targets: Vec<PinnedProcess> = Vec::new();
		for (leader, proof) in &self.groups {
			let group = leader.pid();
			#[cfg(unix)]
			if leads_host_group(group) {
				continue;
			}
			match proof {
				GroupProof::Unreaped => {
					self.members.extend(list_group(&mut table, group));
					by_number.push(group);
				},
				GroupProof::Running if leader.status() == ProcessStatus::Running => {
					let listed = list_group(&mut table, group);
					// Still running after the listing: it held the number all along.
					let proven = leader.status() == ProcessStatus::Running;
					if leader.signal_group(0) {
						by_pin.push(leader.clone());
						if proven {
							self.members.extend(listed);
						}
					} else if proven {
						targets.extend(listed);
					}
				},
				GroupProof::Running | GroupProof::KernelOnly => {
					// Signal 0 checks that the kernel can reach the group this way.
					if leader.signal_group(0) {
						by_pin.push(leader.clone());
					}
				},
			}
		}

		let catchable = self.signal != KILL_SIGNAL;
		for process in &self.direct {
			if catchable && in_signalled_group(process, &by_number, &by_pin) {
				continue;
			}
			targets.push(process.clone());
		}
		let mut unique: Vec<PinnedProcess> = Vec::with_capacity(targets.len());
		for process in targets {
			if !unique.iter().any(|seen| seen.same_identity(&process)) {
				unique.push(process);
			}
		}

		// Group signals first, then each other target through its own pin.
		let mut sent = false;
		for group in by_number {
			sent |= signal_unreaped_group(group, self.signal);
		}
		for leader in by_pin {
			if leader.signal_group(self.signal) {
				sent = true;
				self.kernel.push(leader);
			}
		}
		for process in unique {
			if process.kill(self.signal) {
				sent = true;
				self.reached.push(process);
			}
		}
		sent
	}

	/// The processes [`Self::deliver`] signalled through their own pins.
	#[must_use]
	pub fn reached(&self) -> &[PinnedProcess] {
		&self.reached
	}

	/// The members of the groups [`Self::deliver`] signalled as a whole,
	/// listed under a proof just before: every process those signals reached
	/// that was in the group then.
	#[must_use]
	pub fn members(&self) -> &[PinnedProcess] {
		&self.members
	}

	/// The leaders whose groups [`Self::deliver`] signalled through the
	/// kernel; [`PinnedProcess::signal_group`] with signal 0 tells whether
	/// such a group still has members.
	#[must_use]
	pub fn kernel_leaders(&self) -> &[PinnedProcess] {
		&self.kernel
	}
}

/// Whether the kernel still has the group `leader` led, as it answers on the
/// leader's pin (Linux 6.9 and later): the probe succeeds while anything is
/// in the group, a process that has exited but is not reaped among them. It
/// is the only answer a record is dropped on. A listing of the process table
/// cannot take its place: a member that exits after the table is read leaves
/// a listing that says "empty" about a group a replacement member still
/// holds, and a record dropped on that answer is never signalled again.
#[must_use]
pub fn kernel_group_exists(leader: &PinnedProcess) -> bool {
	leader.signal_group(0)
}

/// Whether the group `leader` led still has a running member: the kernel has
/// the group, and the process table read now lists a member of it that runs.
/// This answers what is left to signal, which a group of processes that have
/// exited is not; a record is never dropped on it (see
/// [`kernel_group_exists`]). `table` holds the process table across the
/// entries of one question, which would otherwise read it once per entry.
fn kernel_group_runs_in(leader: &PinnedProcess, table: &mut Option<GroupTable>) -> bool {
	kernel_group_exists(leader) && !list_group(table, leader.pid()).is_empty()
}

/// [`kernel_group_runs_in`] for a single leader, reading the table for it.
#[must_use]
pub fn kernel_group_runs(leader: &PinnedProcess) -> bool {
	kernel_group_runs_in(leader, &mut None)
}

/// Pins the running members of `group`, reading the process table once per
/// wave.
fn list_group(table: &mut Option<GroupTable>, group: i32) -> Vec<PinnedProcess> {
	let table = table.get_or_insert_with(PinnedProcess::process_groups);
	PinnedProcess::members_among(group, table.get(&group).map_or(&[], SmallVec::as_slice))
}

/// Signals process group `group` by its number. The caller guarantees that
/// the group's leader is a child it has not reaped and cannot reap until this
/// returns, so the number names that group and no other.
#[cfg(unix)]
fn signal_unreaped_group(group: i32, signal: i32) -> bool {
	// SAFETY: `kill` takes scalar arguments; a negative pid names a group.
	group > 1 && !leads_host_group(group) && unsafe { libc::kill(-group, signal) } == 0
}

/// Windows has no process groups.
#[cfg(windows)]
const fn signal_unreaped_group(_group: i32, _signal: i32) -> bool {
	false
}

/// Whether `process` is now in a group the wave signals as a whole.
#[cfg(unix)]
fn in_signalled_group(process: &PinnedProcess, by_number: &[i32], by_pin: &[PinnedProcess]) -> bool {
	(!by_number.is_empty() || !by_pin.is_empty())
		&& process.group_id().is_some_and(|group| {
			by_number.contains(&group) || by_pin.iter().any(|leader| leader.pid() == group)
		})
}

/// Windows has no process groups.
#[cfg(windows)]
const fn in_signalled_group(_process: &PinnedProcess, _by_number: &[i32], _by_pin: &[PinnedProcess]) -> bool {
	false
}

/// Whether the shell still holds a recorded child unreaped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Reap {
	/// A child the shell reports before reaping it and has not yet reported.
	Pending,
	/// The shell has reported it: it may be reaped from now on.
	Allowed,
	/// Not a child the shell reports: a process pinned some other way.
	Unwatched,
}

/// One process a run, or a `timeout` operand, spawned, or a member of a group
/// one of them led, pinned before that leader was reaped.
#[derive(Clone)]
pub struct SpawnEntry {
	/// The process, pinned while its pid still named it.
	pub process: PinnedProcess,
	/// The group the process was in when it was recorded.
	pub group:   Option<i32>,
	reap:        Reap,
}

impl SpawnEntry {
	/// Whether this entry leads the group it was recorded in.
	fn leads(&self) -> bool {
		self.group == Some(self.process.pid())
	}

	/// What proves the number of the group this entry leads.
	const fn proof(&self) -> GroupProof {
		match self.reap {
			Reap::Pending => GroupProof::Unreaped,
			Reap::Unwatched => GroupProof::Running,
			Reap::Allowed => GroupProof::KernelOnly,
		}
	}

	/// Whether a wave sent now could still reach a running process: this
	/// entry's own, on Windows the process's descendants, or a running member
	/// of the group it leads. `table` holds the process table across the
	/// entries of one question.
	fn reaches_anything(&self, table: &mut Option<GroupTable>) -> bool {
		if self.process.status() == ProcessStatus::Running {
			return true;
		}
		#[cfg(target_os = "windows")]
		if !self.process.descendants().is_empty() {
			return true;
		}
		self.leads() && kernel_group_runs_in(&self.process, table)
	}

	/// Whether the ledger must keep this entry. A child the shell has not yet
	/// reported stays, so that its report can pin its group's members. A
	/// leader whose group the kernel still has stays as well, whether or not
	/// a listing of the process table finds a member of it running: the
	/// listing is what a member that exits after it is read makes wrong, and
	/// an entry dropped is never signalled again (see
	/// [`kernel_group_exists`]).
	fn is_live(&self) -> bool {
		if self.reap == Reap::Pending || self.process.status() == ProcessStatus::Running {
			return true;
		}
		#[cfg(target_os = "windows")]
		if !self.process.descendants().is_empty() {
			return true;
		}
		self.leads() && kernel_group_exists(&self.process)
	}
}

/// The processes a run, or a `timeout` operand, spawned, each pinned when it
/// was spawned so a later signal reaches it — and the group it leads — and
/// never a process that took its pid or group number after it exited (issue
/// #4605).
///
/// The ledger also holds each spawned child's reap boundary: the shell
/// reports a child through [`Self::before_reap`] before it reaps it, and
/// until then the child's pid proves the number of the group it leads. A
/// wave planned with [`Self::plan_wave`] is delivered while the ledger stays
/// borrowed, so a caller that keeps the ledger behind a lock also keeps the
/// shell from passing the reap boundary in the middle of a wave.
///
/// Entries with nothing left to signal are dropped as records arrive, so a
/// loop of short external commands cannot exhaust the descriptor or handle
/// limit by keeping one pin per spawn.
#[derive(Default)]
pub struct SpawnLedger {
	entries:       Vec<SpawnEntry>,
	/// The next `entries.len()` at which `record` runs a sweep. Bounds sweep
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

/// A wave planned from a [`SpawnLedger`], delivered while the ledger stays
/// borrowed (see [`SpawnLedger::plan_wave`]).
pub struct LedgerWave<'a> {
	_ledger: &'a SpawnLedger,
	wave:    SignalWave,
}

impl LedgerWave<'_> {
	/// Delivers the wave, and returns it for its outcome.
	pub fn deliver(mut self) -> SignalWave {
		self.wave.deliver();
		self.wave
	}
}

impl SpawnLedger {
	/// Amortized-cost threshold for opportunistic pruning of exited entries.
	///
	/// Each sweep costs `O(N)` (one non-blocking status probe per entry, plus
	/// a group probe for an exited group leader, and a Toolhelp descendant
	/// walk on Windows). The next sweep is scheduled
	/// `PRUNE_THRESHOLD` further records away — via the `next_sweep_at`
	/// watermark — so a run that keeps many concurrent long-lived children
	/// (`for i in {1..1000}; do sleep 60 & done`) does not sweep on every
	/// spawn just because the vec is already above threshold. Amortized cost
	/// per spawn stays `O(1)` regardless of the live-set size.
	pub const PRUNE_THRESHOLD: usize = 64;

	/// Records a child the shell spawned into group `pgid`, as brush's spawn
	/// observer reports it; the shell reports it again through
	/// [`Self::before_reap`] before it reaps it. `process` must be pinned
	/// *immediately* after the child's pid becomes visible, before the child
	/// can be reaped and its pid reused; `None` (the child was already gone)
	/// records nothing, as there is nothing left to signal.
	pub fn record(&mut self, pgid: Option<i32>, process: Option<PinnedProcess>) {
		if let Some(process) = process {
			self.push(SpawnEntry { process, group: pgid, reap: Reap::Pending });
		}
	}

	/// Records a process this ledger never hears a reap report for, such as
	/// a job a previous run started. It proves its group only while it runs.
	pub fn record_unwatched(&mut self, pgid: Option<i32>, process: Option<PinnedProcess>) {
		if let Some(process) = process {
			self.push(SpawnEntry { process, group: pgid, reap: Reap::Unwatched });
		}
	}

	/// The shell is about to stop holding child `pid` unreaped: it exited,
	/// or the shell stopped waiting for it. With `unreaped`, the child is
	/// still unreaped now, so the members of the group it leads are pinned
	/// and recorded first: after the reap they are reached through their own
	/// pins (and, on Linux 6.9 and later, through the kernel's group signal).
	/// From now on the child proves its group number only through the kernel.
	pub fn before_reap(&mut self, pid: i32, unreaped: bool) {
		let Some(index) = self
			.entries
			.iter()
			.rposition(|entry| entry.reap == Reap::Pending && entry.process.pid() == pid)
		else {
			return;
		};
		self.entries[index].reap = Reap::Allowed;
		if !unreaped || !self.entries[index].leads() {
			return;
		}
		let leader = self.entries[index].process.clone();
		for member in leader.members_before_reap() {
			if member.pid() != pid && !self.entries.iter().any(|entry| entry.process.same_identity(&member)) {
				self.push(SpawnEntry { process: member, group: Some(pid), reap: Reap::Unwatched });
			}
		}
	}

	/// Plans a wave of `signal` to every recorded process and its live
	/// descendants (the harness's own subtree pruned, see
	/// [`signalable_descendants`]) and, with `groups`, to the group each
	/// recorded leader leads, under the proof its reap state gives. The
	/// descendants are walked on every wave, so a child a recorded process
	/// forked after its group leader was reaped is still reached when the
	/// group can no longer be signalled. The wave is delivered through the
	/// returned value, which borrows this ledger: keep the ledger behind the
	/// lock that [`Self::before_reap`] takes until it is delivered.
	#[must_use]
	pub fn plan_wave(&self, signal: i32, groups: bool) -> LedgerWave<'_> {
		let protected = host_protected_pids();
		let mut wave = SignalWave::new(signal);
		let mut walked: Vec<PinnedProcess> = Vec::new();
		for entry in &self.entries {
			if groups && entry.leads() {
				wave.group(&entry.process, entry.proof());
			}
			wave.process(&entry.process);
			// A recorded process found under an earlier one was walked with it.
			if walked.iter().any(|seen| seen.same_identity(&entry.process)) {
				continue;
			}
			for descendant in signalable_descendants(&entry.process, &protected) {
				wave.process(&descendant);
				walked.push(descendant);
			}
		}
		LedgerWave { _ledger: self, wave }
	}

	/// Records every process `wave` reached: those it signalled through their
	/// pins (descendants included) and the members of the groups it signalled
	/// as a whole, listed under a proof. Later waves wait for them and reach
	/// them through their own pins, even after they leave their group or
	/// their parent.
	pub fn record_reached(&mut self, wave: &SignalWave) {
		for process in wave.members().iter().chain(wave.reached()) {
			if !self.entries.iter().any(|entry| entry.process.same_identity(process)) {
				#[cfg(unix)]
				let group = process.group_id();
				// Windows has no process groups.
				#[cfg(windows)]
				let group = None;
				self.push(SpawnEntry { process: process.clone(), group, reap: Reap::Unwatched });
			}
		}
	}

	fn push(&mut self, entry: SpawnEntry) {
		self.entries.push(entry);
		if self.entries.len() >= self.next_sweep_at.max(Self::PRUNE_THRESHOLD) {
			self.prune();
		}
	}

	/// Drops every entry the ledger no longer needs, and schedules the next
	/// record-time sweep `PRUNE_THRESHOLD` records past the entries that
	/// remain: comparing against the post-sweep size, not the pre-sweep one,
	/// keeps a large surviving set from being swept on every record. An entry
	/// goes only on the kernel's own answer about its group, never on a
	/// listing of the process table (see [`kernel_group_exists`]).
	pub fn prune(&mut self) {
		self.entries.retain(SpawnEntry::is_live);
		self.next_sweep_at = self.entries.len() + Self::PRUNE_THRESHOLD;
	}

	/// Whether a wave could still reach a running process: a recorded process
	/// runs, a recorded leader's group has a running member, or an unreported
	/// leader's group has a member besides the leader itself. The members are
	/// read from the process table, which answers for the instant it was
	/// read: a caller sends another wave on it, and no entry is dropped for
	/// it.
	#[must_use]
	pub fn reaches_anything(&self) -> bool {
		let mut table: Option<GroupTable> = None;
		self.entries.iter().any(|entry| {
			entry.reaches_anything(&mut table)
				|| (entry.reap == Reap::Pending
					&& entry.leads()
					&& !list_group(&mut table, entry.process.pid()).is_empty())
		})
	}

	/// The recorded entries, in spawn order.
	#[must_use]
	pub fn entries(&self) -> &[SpawnEntry] {
		&self.entries
	}

	/// Pids of recorded processes that are still alive, in spawn order.
	///
	/// Liveness is probed through each entry's pin, so a recycled pid never
	/// reports as one of the recorded children.
	#[must_use]
	pub fn live_pids(&self) -> Vec<i32> {
		self
			.entries
			.iter()
			.map(|entry| &entry.process)
			.filter(|process| process.status() == ProcessStatus::Running)
			.map(PinnedProcess::pid)
			.collect()
	}
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

	/// Ends what a test started when the test ends, passed or failed: the
	/// group of a leader the test has not reaped (the unreaped leader holds the
	/// group's number), every pinned process it holds, then the leader. These
	/// tests start processes that trap TERM and loop forever, so a failed
	/// assertion must not leave them running. Only the Linux tests start such
	/// processes.
	#[cfg(target_os = "linux")]
	pub(crate) struct ProcessGuard {
		leader: std::process::Child,
		pins:   Vec<PinnedProcess>,
	}

	#[cfg(target_os = "linux")]
	impl ProcessGuard {
		pub(crate) const fn new(leader: std::process::Child) -> Self {
			Self { leader, pins: Vec::new() }
		}

		/// Also ends `process`, which may have left the leader's group.
		pub(crate) fn pin(&mut self, process: &PinnedProcess) {
			self.pins.push(process.clone());
		}

		/// The leader, for a test that reaps it itself.
		pub(crate) const fn leader(&mut self) -> &mut std::process::Child {
			&mut self.leader
		}
	}

	#[cfg(target_os = "linux")]
	impl Drop for ProcessGuard {
		fn drop(&mut self) {
			if let Ok(group) = i32::try_from(self.leader.id())
				&& unreaped_child(group)
			{
				// SAFETY: `kill` takes scalar arguments. The leader has not been
				// reaped, so the group's number is still its group's.
				unsafe { libc::kill(-group, libc::SIGKILL) };
			}
			for pin in &self.pins {
				let _ = pin.kill(libc::SIGKILL);
			}
			let _ = self.leader.kill();
			let _ = self.leader.wait();
		}
	}

	/// Whether `pid`, a child of this process, is not reaped yet (it runs or
	/// waits as a zombie), checked without reaping it: `try_wait` would reap a
	/// zombie leader and free its group's number before the group is killed.
	#[cfg(target_os = "linux")]
	pub(crate) fn unreaped_child(pid: i32) -> bool {
		// SAFETY: an all-zero `siginfo_t` is valid; `waitid` writes only into it.
		let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
		// SAFETY: as above; the remaining arguments are scalars.
		let result = unsafe {
			libc::waitid(
				libc::P_PID,
				pid as libc::id_t,
				&raw mut info,
				libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
			)
		};
		result == 0
	}

	/// The variable naming the test whose body runs in the process group of its
	/// own that [`in_own_process_group`] re-runs it in.
	#[cfg(unix)]
	const OWN_GROUP_TEST: &str = "PI_BUILTINS_OWN_GROUP_TEST";

	/// Whether the test `name` runs its body now. Otherwise this re-runs that
	/// test of this binary as the leader of a new process group, checks that
	/// the re-run passed, and returns false; in the re-run it returns true.
	#[cfg(unix)]
	fn in_own_process_group(name: &str) -> bool {
		use std::os::unix::process::CommandExt as _;

		if std::env::var(OWN_GROUP_TEST).as_deref() == Ok(name) {
			return true;
		}
		let (_, module) = module_path!().split_once("::").expect("module path below the crate");
		let output = std::process::Command::new(std::env::current_exe().expect("test binary path"))
			.args(["--exact", &format!("{module}::{name}"), "--nocapture"])
			.env(OWN_GROUP_TEST, name)
			.process_group(0)
			.output()
			.expect("re-run the test in a process group of its own");
		let stdout = String::from_utf8_lossy(&output.stdout);
		assert!(
			output.status.success() && stdout.contains("test result: ok. 1 passed"),
			"{name} in a process group of its own: {}\n{stdout}\n{}",
			output.status,
			String::from_utf8_lossy(&output.stderr),
		);
		false
	}

	/// The variable naming the test whose body runs with `getpgid` refused.
	#[cfg(target_os = "linux")]
	const NO_GETPGID_TEST: &str = "PI_BUILTINS_NO_GETPGID_TEST";

	/// Whether the test `name` runs its body now. Otherwise this re-runs that
	/// test of this binary under a seccomp filter that makes `getpgid` fail
	/// with `EPERM`, as a security module that refuses the call does, checks
	/// that the re-run passed, and returns false.
	#[cfg(target_os = "linux")]
	fn without_getpgid(name: &str) -> bool {
		if std::env::var(NO_GETPGID_TEST).as_deref() == Ok(name) {
			refuse_getpgid();
			return true;
		}
		let (_, module) = module_path!().split_once("::").expect("module path below the crate");
		let output = std::process::Command::new(std::env::current_exe().expect("test binary path"))
			.args(["--exact", &format!("{module}::{name}"), "--nocapture"])
			.env(NO_GETPGID_TEST, name)
			.output()
			.expect("re-run the test with getpgid refused");
		let stdout = String::from_utf8_lossy(&output.stdout);
		assert!(
			output.status.success() && stdout.contains("test result: ok. 1 passed"),
			"{name} with getpgid refused: {}\n{stdout}\n{}",
			output.status,
			String::from_utf8_lossy(&output.stderr),
		);
		false
	}

	/// Installs the seccomp filter for [`without_getpgid`].
	#[cfg(target_os = "linux")]
	fn refuse_getpgid() {
		let mut filter = [
			libc::sock_filter {
				code: (libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16,
				jt:   0,
				jf:   0,
				k:    0,
			},
			libc::sock_filter {
				code: (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
				jt:   0,
				jf:   1,
				k:    libc::SYS_getpgid as u32,
			},
			libc::sock_filter {
				code: (libc::BPF_RET | libc::BPF_K) as u16,
				jt:   0,
				jf:   0,
				k:    libc::SECCOMP_RET_ERRNO | libc::EPERM as u32,
			},
			libc::sock_filter {
				code: (libc::BPF_RET | libc::BPF_K) as u16,
				jt:   0,
				jf:   0,
				k:    libc::SECCOMP_RET_ALLOW,
			},
		];
		let program = libc::sock_fprog { len: filter.len() as u16, filter: filter.as_mut_ptr() };
		// SAFETY: prctl takes scalar arguments. seccomp(2) reads the filter
		// program, valid for the duration of the call; TSYNC applies it to
		// every thread of this process.
		unsafe {
			assert_eq!(libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0), 0, "no_new_privs");
			assert_eq!(
				libc::syscall(
					libc::SYS_seccomp,
					libc::SECCOMP_SET_MODE_FILTER,
					libc::SECCOMP_FILTER_FLAG_TSYNC,
					&raw const program,
				),
				0,
				"install seccomp filter: {}",
				std::io::Error::last_os_error(),
			);
		}
	}

	/// Signalling the host's own process group ends the host along with its
	/// targets. The group primitive refuses it on every path, even through a
	/// pin of the group's leader. Run in a group the test leads, so a missing
	/// guard kills the re-run.
	#[cfg(unix)]
	#[test]
	fn signal_group_refuses_the_hosts_own_group() {
		if !in_own_process_group("signal_group_refuses_the_hosts_own_group") {
			return;
		}
		let host = PinnedProcess::from_pid(i32::try_from(std::process::id()).expect("pid fits"))
			.expect("pin this process");
		// SAFETY: `getpgid(0)` reads the calling process's group.
		assert_eq!(unsafe { libc::getpgid(0) }, host.pid(), "the re-run must lead its group");
		assert!(!host.signal_group(0), "the host's own group must not probe as signallable");
		assert!(!host.signal_group(libc::SIGKILL), "the host's own group must never be signalled");
	}

	/// The shell reports a group leader before it reaps it. The members pinned
	/// then are reached through their own pins after the reap, when the
	/// leader's number proves nothing any more, even if the ledger was pruned
	/// between the leader's exit and the report.
	#[cfg(target_os = "linux")]
	#[test]
	fn members_pinned_before_the_reap_are_reached_after_it() {
		use std::{
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
			thread,
			time::{Duration, Instant},
		};

		let mut leader = Command::new("/bin/sh")
			.args(["-c", "/bin/sleep 600 & echo \"$!\"; /bin/sleep 600 & echo \"$!\""])
			.process_group(0)
			.stdout(Stdio::piped())
			.spawn()
			.expect("start the group leader");
		let mut output = BufReader::new(leader.stdout.take().expect("leader stdout"));
		let group = i32::try_from(leader.id()).expect("leader pid fits");
		let leader_pin = PinnedProcess::from_pid(group).expect("pin the leader");
		let mut guard = ProcessGuard::new(leader);
		let mut members = Vec::new();
		for _ in 0..2 {
			let mut line = String::new();
			output.read_line(&mut line).expect("read a member pid");
			let member = PinnedProcess::from_pid(line.trim().parse::<i32>().expect("member pid"))
				.expect("pin a member");
			guard.pin(&member);
			members.push(member);
		}
		let mut ledger = SpawnLedger::default();
		ledger.record(Some(group), Some(leader_pin.clone()));
		// The leader exits; it stays unreaped until the report below.
		let deadline = Instant::now() + Duration::from_secs(5);
		while leader_pin.status() == ProcessStatus::Running {
			assert!(Instant::now() < deadline, "the leader never exited");
			thread::sleep(Duration::from_millis(5));
		}
		// A record of another spawn may sweep the ledger here.
		ledger.prune();
		ledger.before_reap(group, true);
		assert!(guard.leader().wait().expect("reap the leader").success());
		for member in &members {
			assert!(
				ledger.entries().iter().any(|entry| entry.process.same_identity(member)),
				"member {} must be pinned when the leader is reported",
				member.pid()
			);
		}

		let wave = ledger.plan_wave(libc::SIGKILL, true).deliver();
		// Without the kernel's group signal (Linux 5.3 to 6.8) only the pins
		// reach the members.
		if wave.kernel_leaders().is_empty() {
			for member in &members {
				assert!(
					wave.reached().iter().any(|reached| reached.same_identity(member)),
					"member {} must be signalled through its own pin",
					member.pid()
				);
			}
		}
		while members.iter().any(|member| member.status() == ProcessStatus::Running) {
			assert!(Instant::now() < deadline, "a group member outlived the wave");
			thread::sleep(Duration::from_millis(10));
		}
	}

	/// A member that leaves its group in its TERM handler (`setsid()`) and then
	/// ignores TERM is reached by the KILL wave through its pin: the TERM
	/// wave listed it before the group signal, and the ledger recorded it.
	#[cfg(target_os = "linux")]
	#[test]
	fn the_kill_wave_reaches_a_member_that_left_the_group_in_its_term_handler() {
		use std::{
			fs,
			os::unix::process::CommandExt as _,
			process::Command,
			thread,
			time::{Duration, Instant},
		};

		const MEMBER: &str = r#"import os, signal, sys, time
from pathlib import Path
root = Path(sys.argv[1])
def term(*_):
    try:
        os.setsid()
    except OSError:
        pass
    (root / "left").write_text(str(os.getpgrp()))
signal.signal(signal.SIGTERM, term)
(root / "member").write_text(str(os.getpid()))
(root / "ready").write_text("")
while True:
    time.sleep(1)
"#;

		let dir = tempfile::tempdir().expect("scratch directory");
		fs::write(dir.path().join("member.py"), MEMBER).expect("write member script");
		let leader = Command::new("/bin/sh")
			.args(["-c", "python3 \"$0/member.py\" \"$0\" & exec /bin/sleep 600"])
			.arg(dir.path())
			.process_group(0)
			.spawn()
			.expect("start the group leader");
		let group = i32::try_from(leader.id()).expect("leader pid fits");
		let mut guard = ProcessGuard::new(leader);
		let deadline = Instant::now() + Duration::from_secs(10);
		while !dir.path().join("ready").exists() {
			assert!(Instant::now() < deadline, "the member never started");
			thread::sleep(Duration::from_millis(5));
		}
		let member_pid: i32 = fs::read_to_string(dir.path().join("member"))
			.expect("read the member pid")
			.parse()
			.expect("member pid");
		let member = PinnedProcess::from_pid(member_pid).expect("pin the member");
		guard.pin(&member);
		let leader_pin = PinnedProcess::from_pid(group).expect("pin the leader");

		// The test does not reap the leader during the waves, as the shell's
		// ledger lock keeps it from doing.
		let mut ledger = SpawnLedger::default();
		ledger.record(Some(group), Some(leader_pin));
		let term = ledger.plan_wave(libc::SIGTERM, true).deliver();
		ledger.record_reached(&term);
		while !dir.path().join("left").exists() {
			assert!(Instant::now() < deadline, "the member never left the group");
			thread::sleep(Duration::from_millis(5));
		}
		assert_ne!(member.group_id(), Some(group), "the member left the leader's group");

		ledger.plan_wave(libc::SIGKILL, true).deliver();
		let deadline = Instant::now() + Duration::from_secs(5);
		while member.status() == ProcessStatus::Running {
			assert!(Instant::now() < deadline, "the KILL wave must reach the member that left the group");
			thread::sleep(Duration::from_millis(10));
		}
	}

	/// The exactly-once contract: a member that stays in its group takes a
	/// wave's TERM once, though it is both listed in the group and a direct
	/// target. A member that changes its group during the wave may take it
	/// twice or not at all, and the following KILL wave reaches it.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_wave_signals_a_group_member_once_and_the_kill_wave_reaches_one_that_moved() {
		use std::{
			fs,
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
			thread,
			time::{Duration, Instant},
		};

		const TREE: &str = r#"import os, signal, sys
from pathlib import Path
mode, root = sys.argv[1:]
root = Path(root)
leader = os.getpid()
signal.signal(signal.SIGTERM, lambda *_: None)
member = os.fork()
if member == 0:
    if mode == "join":
        os.setpgid(0, 0)
    count = 0
    def term(*_):
        global count
        count += 1
        if mode == "leave":
            os.setpgid(0, 0)
        (root / "count").write_text(str(count))
    def join(*_):
        os.setpgid(0, leader)
    signal.signal(signal.SIGTERM, term)
    signal.signal(signal.SIGUSR1, join)
    (root / "member").write_text(str(os.getpid()))
    (root / "count").write_text("0")
    while True:
        signal.pause()
while True:
    signal.pause()
"#;

		for mode in ["static", "leave", "join"] {
			let dir = tempfile::tempdir().expect("group directory");
			let script = dir.path().join("tree.py");
			fs::write(&script, TREE).expect("write process tree");
			let leader = Command::new("python3")
				.args([script.to_str().expect("utf8 script"), mode, dir.path().to_str().expect("utf8 directory")])
				.process_group(0)
				.stdout(Stdio::null())
				.spawn()
				.expect("start group leader");
			let leader_pid = i32::try_from(leader.id()).expect("leader pid fits");
			let mut guard = ProcessGuard::new(leader);
			let deadline = Instant::now() + Duration::from_secs(5);
			// `count` is written after `member`, so `member` is complete then.
			while !dir.path().join("count").exists() {
				assert!(Instant::now() < deadline, "{mode}: member never started");
				thread::sleep(Duration::from_millis(5));
			}
			let member_pid = fs::read_to_string(dir.path().join("member"))
				.expect("read member pid")
				.parse::<i32>()
				.expect("member pid");
			let leader_pin = PinnedProcess::from_pid(leader_pid).expect("pin leader");
			let member_pin = PinnedProcess::from_pid(member_pid).expect("pin member");
			guard.pin(&member_pin);
			if mode == "join" {
				// SAFETY: `kill` takes scalar arguments.
				assert_eq!(unsafe { libc::kill(member_pid, libc::SIGUSR1) }, 0, "request group join");
			}

			let mut wave = SignalWave::new(libc::SIGTERM);
			wave.group(&leader_pin, GroupProof::Running);
			wave.process(&member_pin);
			assert!(wave.deliver(), "{mode}: the wave must reach something");
			thread::sleep(Duration::from_millis(200));
			let count = fs::read_to_string(dir.path().join("count")).expect("read TERM count");
			if mode == "static" {
				assert_eq!(count, "1", "a member that stays in its group takes TERM once");
			}

			let mut kill = SignalWave::new(libc::SIGKILL);
			kill.group(&leader_pin, GroupProof::Running);
			kill.process(&member_pin);
			kill.deliver();
			while member_pin.status() == ProcessStatus::Running {
				assert!(Instant::now() < deadline, "{mode}: the KILL wave must reach the member");
				thread::sleep(Duration::from_millis(10));
			}
		}
	}

	/// A group leader that keeps forking while the wave runs: every process in
	/// the group when the signal lands must take it. A signal delivered member
	/// by member misses the children forked between the listing and the
	/// delivery; a group signal reaches the group at one instant.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_group_signal_reaches_children_a_member_forks_during_the_wave() {
		use std::{
			os::unix::process::CommandExt as _,
			process::Command,
			thread,
			time::Duration,
		};

		/// Running processes whose process group is `group`, read from /proc.
		fn running_in_group(group: i32) -> usize {
			let group = group.to_string();
			std::fs::read_dir("/proc")
				.into_iter()
				.flatten()
				.flatten()
				.filter_map(|entry| entry.file_name().to_str()?.parse::<i32>().ok())
				.filter(|pid| {
					let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
						return false;
					};
					let Some(fields) = stat.rfind(')').map(|at| &stat[at + 1..]) else {
						return false;
					};
					let mut fields = fields.split_whitespace();
					let state = fields.next();
					let pgrp = fields.nth(1);
					state != Some("Z") && pgrp == Some(group.as_str())
				})
				.count()
		}

		for (case, proof) in [("unreaped leader", GroupProof::Unreaped), ("running leader", GroupProof::Running)]
		{
			let leader = Command::new("/bin/sh")
				.args(["-c", "i=0; while [ $i -lt 3000 ]; do /bin/sleep 600 & i=$((i+1)); done; wait"])
				.process_group(0)
				.spawn()
				.expect("start the forking leader");
			let group = i32::try_from(leader.id()).expect("leader pid fits");
			let _guard = ProcessGuard::new(leader);
			let leader_pin = PinnedProcess::from_pid(group).expect("pin the leader");
			if proof == GroupProof::Running && !leader_pin.signal_group(0) {
				eprintln!("skipped {case}: this kernel has no group signal through a pinned leader");
				continue;
			}
			// Let the leader fork for a while, so the wave lands mid-loop.
			thread::sleep(Duration::from_millis(200));
			let mut wave = SignalWave::new(libc::SIGTERM);
			wave.group(&leader_pin, proof);
			wave.process(&leader_pin);
			assert!(wave.deliver(), "{case}: the wave must reach the group");
			thread::sleep(Duration::from_millis(300));
			let survivors = running_in_group(group);
			assert_eq!(survivors, 0, "{case}: {survivors} processes in the group outlived its TERM");
		}
	}

	/// Regression test for the review on PR #4606: a long-running shell
	/// command that spawns many short-lived external processes must not
	/// retain one owned handle per historical spawn — that would exhaust
	/// per-process FD/handle limits (pidfd on Linux, `HANDLE` on Windows).
	/// The ledger MUST prune dead entries once it crosses the sweep threshold.
	#[cfg(unix)]
	#[test]
	fn ledger_prunes_exited_entries() {
		use std::{
			thread,
			time::{Duration, Instant},
		};

		let mut ledger = SpawnLedger::default();

		// Spawn a tiny child, record it as the shell does, wait for its exit,
		// then report it and reap it as the shell does, so every entry is dead
		// from the ledger's point of view.
		for _ in 0..(SpawnLedger::PRUNE_THRESHOLD * 2) {
			let mut child = std::process::Command::new("true")
				.spawn()
				.expect("spawn true");
			let pid = i32::try_from(child.id()).expect("child pid fits in i32");
			let pinned = PinnedProcess::from_pid(pid);
			// Wait until the pidfd reports the exit, so the pruner sees an
			// exited process; a loaded machine can take seconds to run `true`.
			let deadline = Instant::now() + Duration::from_secs(30);
			while pinned
				.as_ref()
				.is_some_and(|process| process.status() != ProcessStatus::Exited)
			{
				assert!(Instant::now() < deadline, "`true` {pid} did not exit within 30 s");
				thread::sleep(Duration::from_millis(5));
			}
			ledger.record(None, pinned);
			ledger.before_reap(pid, true);
			let _ = child.wait();
		}

		let retained = ledger.entries().len();
		assert!(
			retained < SpawnLedger::PRUNE_THRESHOLD,
			"pruning must bound retained entries below the sweep threshold once the pinned processes \
			 have exited; got {retained} retained (threshold {})",
			SpawnLedger::PRUNE_THRESHOLD
		);
	}

	/// A group whose listed member exits leaves a listing that says the group
	/// is empty while the kernel still has it — the member may have forked a
	/// replacement that the listing never saw. The ledger drops an entry only
	/// on the kernel's own answer, so the leader of such a group is kept and
	/// the next wave still reaches it. A member that exited without being
	/// reaped stands for the listed member here: the group holds it, no
	/// listing of running processes reports it.
	#[cfg(target_os = "linux")]
	#[test]
	fn prune_keeps_a_leader_whose_group_the_kernel_still_has() {
		use std::{
			os::unix::process::CommandExt as _,
			process::Command,
			thread,
			time::{Duration, Instant},
		};

		let leader = Command::new("/bin/sleep")
			.arg("600")
			.process_group(0)
			.spawn()
			.expect("start the group leader");
		let group = i32::try_from(leader.id()).expect("leader pid fits");
		let leader_pin = PinnedProcess::from_pid(group).expect("pin the leader");
		let mut guard = ProcessGuard::new(leader);
		let mut member = Command::new("/bin/true")
			.process_group(group)
			.spawn()
			.expect("start a member of the leader's group");
		let member_pid = i32::try_from(member.id()).expect("member pid fits");
		let deadline = Instant::now() + Duration::from_secs(5);
		while PinnedProcess::from_pid(member_pid)
			.is_some_and(|pin| pin.status() == ProcessStatus::Running)
		{
			assert!(Instant::now() < deadline, "the member never exited");
			thread::sleep(Duration::from_millis(5));
		}

		let mut ledger = SpawnLedger::default();
		ledger.record(Some(group), Some(leader_pin.clone()));
		ledger.before_reap(group, true);
		guard.leader().kill().expect("end the leader");
		assert!(guard.leader().wait().is_ok(), "reap the leader");
		// The exited member holds the group: the kernel answers for it, a
		// listing of running processes does not.
		assert!(
			leader_pin.signal_group(0),
			"the kernel must still have the group the exited member holds"
		);

		ledger.prune();

		assert!(
			ledger.entries().iter().any(|entry| entry.process.same_identity(&leader_pin)),
			"the leader of a group the kernel still has must survive the sweep"
		);
		let _ = member.wait();
	}

	/// A security module may refuse `getpgid`. The group of a pinned process
	/// is then read from its `/proc` line instead, so the members of a group
	/// a command led are still pinned before the command is reaped: without
	/// the fallback the group reads as unknown and every member escapes the
	/// waves that follow.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_refused_getpgid_falls_back_to_proc_for_a_pins_group() {
		use std::{
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
		};

		if !without_getpgid("a_refused_getpgid_falls_back_to_proc_for_a_pins_group") {
			return;
		}
		// SAFETY: `getpgid` takes a scalar pid; the filter is installed.
		assert_eq!(unsafe { libc::getpgid(0) }, -1, "the filter must refuse getpgid");

		let mut leader = Command::new("/bin/sh")
			.args(["-c", "/bin/sleep 600 & echo \"$!\"; /bin/sleep 600"])
			.process_group(0)
			.stdout(Stdio::piped())
			.spawn()
			.expect("start the group leader");
		let mut output = BufReader::new(leader.stdout.take().expect("leader stdout"));
		let group = i32::try_from(leader.id()).expect("leader pid fits");
		let leader_pin = PinnedProcess::from_pid(group).expect("pin the leader");
		let mut guard = ProcessGuard::new(leader);
		let mut line = String::new();
		output.read_line(&mut line).expect("read the member pid");
		let member_pid: i32 = line.trim().parse().expect("member pid");
		let member = PinnedProcess::from_pid(member_pid).expect("pin the member");
		guard.pin(&member);

		assert_eq!(
			leader_pin.group_id(),
			Some(group),
			"a pin's group must be read from /proc when getpgid is refused"
		);
		assert_eq!(member.group_id(), Some(group), "the member's group must read the same way");
		let members = leader_pin.members_before_reap();
		assert!(
			members.iter().any(|pinned| pinned.same_identity(&member)),
			"the group's members must be pinned before the reap with getpgid refused"
		);
	}

	/// Regression test for the third review on PR #4606: once the ledger
	/// crosses `PRUNE_THRESHOLD`, subsequent `record` calls must NOT sweep on
	/// every spawn. Without the `next_sweep_at` watermark, a large fan-out run
	/// whose live children exceed the threshold turned every spawn into an
	/// O(N) status probe of the whole retained set.
	///
	/// After N records past threshold with entries that CANNOT be pruned (all
	/// still live), the retained size grows by exactly N and the watermark
	/// stays put — no sweep ran in between.
	#[cfg(unix)]
	#[test]
	fn ledger_watermark_bounds_sweep_frequency() {
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let mut ledger = SpawnLedger::default();

		// Fill past threshold with entries that are permanently alive
		// (pinning ourselves) so the pruner has nothing to remove.
		let fill = SpawnLedger::PRUNE_THRESHOLD + 10;
		for _ in 0..fill {
			ledger.record(None, PinnedProcess::from_pid(self_pid));
		}
		assert_eq!(ledger.entries().len(), fill, "live-only entries must not be pruned during warm-up");
		let watermark_after_fill = ledger.next_sweep_at;

		// Every additional record with a live entry must land verbatim and —
		// critically — NOT re-enter `prune` until the ledger crosses the
		// freshly scheduled watermark.
		let extra = 20;
		for _ in 0..extra {
			ledger.record(None, PinnedProcess::from_pid(self_pid));
		}
		assert_eq!(
			ledger.entries().len(),
			fill + extra,
			"records with live entries must accumulate without triggering per-spawn sweeps"
		);
		assert_eq!(
			ledger.next_sweep_at, watermark_after_fill,
			"watermark must not advance while the ledger stays below it — otherwise a sweep ran"
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
		use std::{collections::HashMap, process::Command, thread, time::Duration};

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
		let pin = |pid: u32| PinnedProcess::from_pid(i32::try_from(pid).unwrap()).unwrap();

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
				.map(PinnedProcess::pid)
				.collect::<Vec<_>>(),
			[i32::try_from(newer_pid).unwrap()]
		);

		let _ = older.kill();
		let _ = newer.kill();
		let _ = older.wait();
		let _ = newer.wait();
	}
}
