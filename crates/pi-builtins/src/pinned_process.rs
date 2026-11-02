//! Identity-pinned process references, and the ledger of the processes a run,
//! or a `timeout` operand, spawned.
//!
//! A [`PinnedProcess`] names one process for its whole life: a pidfd on Linux,
//! an open handle on Windows, the kernel-reported start time on macOS. Signals
//! go through that identity, never through a bare pid or process-group number,
//! so they cannot reach a process that took either number after the original
//! exited. `pi-shell`'s process references wrap this type, and the `timeout`
//! builtin records its operand's children with it.

use std::collections::HashMap;

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
		sync::Arc,
	};

	use super::GroupTable;
	use crate::proc_snapshot::{ProcessStatus, sys};

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct PinnedProcess {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
	}

	impl PinnedProcess {
		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = Arc::new(sys::open_pidfd(pid)?);
			let start_time = sys::start_time(pid)?;
			Some(Self { pid, pidfd, start_time })
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

			// SAFETY: `getpgid` takes a scalar pid and reads no caller-owned
			// memory; for a pid nobody holds it reports failure.
			let pgid = unsafe { libc::getpgid(self.pid) };
			// Still running after the read, the process held its pid throughout,
			// so the group read is its own and not that of a process that took
			// the pid after it exited.
			(pgid > 0 && self.status() == ProcessStatus::Running).then_some(pgid)
		}

		/// Whether `other` pins the same Linux process, not merely its current
		/// numeric pid.
		pub fn same_identity(&self, other: &Self) -> bool {
			self.pid == other.pid && self.start_time == other.start_time
		}

		/// Whether this still-running process anchors `group`: while it stays
		/// in that group, it holds the group's number so no other group can
		/// take it.
		pub fn is_group_anchor(&self, group: i32) -> bool {
			self.group_id() == Some(group)
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

		/// Pins each of `candidates` that is a running member of `group`
		/// while this process proves it still owns that group. Each member's
		/// group is re-read after opening its pidfd, then the anchor is
		/// re-checked after the enumeration.
		pub fn group_members_among(&self, group: i32, candidates: &[i32]) -> Vec<Self> {
			if !self.is_group_anchor(group) {
				return Vec::new();
			}
			let members = candidates
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.filter(|member| member.group_id() == Some(group))
				.collect();
			self.is_group_anchor(group).then_some(members).unwrap_or_default()
		}

		/// Pins the live members of the group led by this child while the child
		/// has exited but is not yet reaped. Its unreaped pid still holds the
		/// group's number, so every member observed in that group is owned.
		pub fn group_members_before_reap(&self, group: i32) -> Vec<Self> {
			if group != self.pid || sys::process_group(self.pid) != Some(group) {
				return Vec::new();
			}
			sys::pids()
				.filter(|&pid| sys::process_group(pid) == Some(group))
				.filter_map(Self::from_pid)
				.filter(|member| member.group_id() == Some(group))
				.collect()
		}

		/// Sends `signal` to the process group this process leads through
		/// Linux 6.9's `PIDFD_SIGNAL_PROCESS_GROUP`. The kernel resolves the
		/// group from the pinned leader, not from the number. Older kernels have
		/// no such proof once the leader has exited, so they signal nothing here;
		/// callers that have a live anchor use [`SignalWave::group_with`].
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

		/// Whether `other` pins the same macOS process, identified by pid and
		/// start time rather than the pid alone.
		pub fn same_identity(&self, other: &Self) -> bool {
			self.pid == other.pid
				&& self.start_tvsec == other.start_tvsec
				&& self.start_tvusec == other.start_tvusec
		}

		/// Whether this still-running process holds the number of `group`.
		pub fn is_group_anchor(&self, group: i32) -> bool {
			self.group_id() == Some(group)
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

		/// Pins each of `candidates` that is a live member of `group` while
		/// this process remains an anchor. A member counts only if its pinned
		/// identity still reports the group; the anchor is re-checked after
		/// enumeration.
		pub fn group_members_among(&self, group: i32, candidates: &[i32]) -> Vec<Self> {
			if !self.is_group_anchor(group) {
				return Vec::new();
			}
			let members = candidates
				.iter()
				.copied()
				.filter_map(Self::from_pid)
				.filter(|member| member.group_id() == Some(group))
				.collect();
			self.is_group_anchor(group).then_some(members).unwrap_or_default()
		}

		/// macOS uses the same pre-reap anchor rule: while the leader is an
		/// unreaped zombie its pid holds the group number.
		pub fn group_members_before_reap(&self, group: i32) -> Vec<Self> {
			if group != self.pid {
				return Vec::new();
			}
			sys::pids()
				.into_iter()
				.filter_map(Self::from_pid)
				.filter(|member| member.group_id() == Some(group))
				.collect()
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

		/// Windows has no process groups to anchor.
		pub const fn is_group_anchor(&self, _group: i32) -> bool {
			false
		}

		/// Windows has no process groups.
		pub fn process_groups() -> super::GroupTable {
			super::GroupTable::new()
		}

		/// Windows has no process groups.
		pub const fn group_members_among(&self, _group: i32, _candidates: &[i32]) -> Vec<Self> {
			Vec::new()
		}

		/// Windows has no process groups.
		pub const fn group_members_before_reap(&self, _group: i32) -> Vec<Self> {
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

/// One delivery of a signal: each pinned process it targets takes it at most
/// once, identified by its pin rather than its current group.
///
/// A group is owned while a pinned process recorded in it still runs there:
/// that process holds the group's number, so every member found in the group
/// during the delivery belongs to the operand. The wave pins each such member
/// and signals it through that pin, reading the process table once for all the
/// groups it signals. Only when no recorded process runs in the group does it
/// use the kernel's pinned-leader group signal (Linux 6.9 and later).
pub struct SignalWave {
	signal:        i32,
	reached:       SmallVec<[PinnedProcess; 8]>,
	kernel_groups: SmallVec<[i32; 4]>,
	/// The process table by group, read on the first group with a live
	/// anchor and reused for the rest of the wave.
	table:         Option<GroupTable>,
	count:         u32,
}

impl SignalWave {
	/// A wave that delivers `signal`.
	#[must_use]
	pub const fn new(signal: i32) -> Self {
		Self {
			signal,
			reached: SmallVec::new_const(),
			kernel_groups: SmallVec::new_const(),
			table: None,
			count: 0,
		}
	}

	/// Signals the owned process group `group`. The first candidate still
	/// running in it anchors the group: every member found in it is pinned and
	/// signalled once through that pin. With no live anchor, a candidate that
	/// led the group can still signal it through the kernel's pinned-leader
	/// operation on Linux 6.9 and later; nothing else is signalled. The host's
	/// own group is never signalled.
	pub fn group_with<'a>(
		&mut self,
		group: i32,
		candidates: impl IntoIterator<Item = &'a PinnedProcess>,
	) -> bool {
		#[cfg(unix)]
		if leads_host_group(group) {
			return false;
		}
		let candidates: SmallVec<[&PinnedProcess; 8]> = candidates.into_iter().collect();
		if let Some(anchor) = candidates.iter().find(|candidate| candidate.is_group_anchor(group)) {
			let members = {
				let table = self.table.get_or_insert_with(PinnedProcess::process_groups);
				anchor.group_members_among(group, table.get(&group).map_or(&[], SmallVec::as_slice))
			};
			let mut sent = false;
			for member in &members {
				sent |= self.process(member);
			}
			return sent;
		}
		if self.kernel_groups.contains(&group) {
			return true;
		}
		let Some(leader) = candidates.iter().find(|candidate| candidate.pid() == group) else {
			return false;
		};
		let sent = leader.signal_group(self.signal);
		if sent {
			self.kernel_groups.push(group);
		}
		sent
	}

	/// Signals `process` unless this wave already delivered its signal to the
	/// same pinned identity.
	pub fn process(&mut self, process: &PinnedProcess) -> bool {
		if self.reached.iter().any(|reached| reached.same_identity(process)) {
			return true;
		}
		let sent = process.kill(self.signal);
		if sent {
			self.reached.push(process.clone());
			self.count += 1;
		}
		sent
	}

	/// How many processes this wave signalled through their own pins.
	#[must_use]
	pub const fn reached(&self) -> u32 {
		self.count
	}
}

/// One process a run, or a `timeout` operand, spawned.
#[derive(Clone)]
pub struct SpawnEntry {
	/// The process, pinned as it was spawned or as a group member before the
	/// group leader was reaped.
	pub process: PinnedProcess,
	/// The group this process was observed in. A live entry in this group is an
	/// anchor: it holds the group number and proves every member subsequently
	/// enumerated in it belongs to the operand.
	pub group:   Option<i32>,
}

impl SpawnEntry {
	/// Whether anything this entry can signal is left: its process, on Windows
	/// the process's descendants, or, for a group leader, the group it led
	/// through the kernel's pinned-leader probe (Linux 6.9 and later). A member
	/// pinned before its leader was reaped stays while it runs, as the group's
	/// anchor.
	fn is_live(&self) -> bool {
		if self.process.status() == ProcessStatus::Running {
			return true;
		}
		#[cfg(target_os = "windows")]
		if !self.process.descendants().is_empty() {
			return true;
		}
		self.group == Some(self.process.pid()) && self.process.signal_group(0)
	}
}

/// The processes a run, or a `timeout` operand, spawned, each pinned when it
/// was spawned so a later signal reaches it — and the group it leads — and
/// never a process that took its pid or group number after it exited (issue
/// #4605).
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

	/// Records a freshly spawned child in group `pgid`, as brush's spawn
	/// observer reports it. `process` must be pinned *immediately* after the
	/// child's pid becomes visible, before the child can be reaped and its pid
	/// reused; `None` (the child was already gone) records nothing, as there
	/// is nothing left to signal.
	///
	/// Entries with nothing left to signal are swept once the ledger crosses
	/// the next-sweep watermark.
	pub fn record(&mut self, pgid: Option<i32>, process: Option<PinnedProcess>) {
		let Some(process) = process else {
			return;
		};
		self.push(SpawnEntry { process, group: pgid });
	}

	/// Records the members of `group` that a recorded child led, while that
	/// child has exited but is still unreaped. The zombie's pid holds the group
	/// number, so every member pinned now belongs to the operand and remains a
	/// live anchor after the leader is reaped.
	pub fn record_exiting_group_members(&mut self, pid: i32) {
		let Some(leader) = self
			.entries
			.iter()
			.rev()
			.find(|entry| entry.process.pid() == pid && entry.group == Some(pid))
			.map(|entry| entry.process.clone())
		else {
			return;
		};
		for member in leader.group_members_before_reap(pid) {
			if self.entries.iter().any(|entry| entry.process.same_identity(&member)) {
				continue;
			}
			self.push(SpawnEntry { process: member, group: Some(pid) });
		}
	}

	fn push(&mut self, entry: SpawnEntry) {
		self.entries.push(entry);
		if self.entries.len() >= self.next_sweep_at.max(Self::PRUNE_THRESHOLD) {
			self.prune();
		}
	}

	/// Drops every entry with nothing left to signal, and schedules the next
	/// record-time sweep `PRUNE_THRESHOLD` records past the entries that
	/// remain: comparing against the post-sweep size, not the pre-sweep one,
	/// keeps a large surviving set from being swept on every record.
	pub fn prune(&mut self) {
		self.entries.retain(SpawnEntry::is_live);
		self.next_sweep_at = self.entries.len() + Self::PRUNE_THRESHOLD;
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

	/// Ends what a test started when the test ends, passed or failed: the
	/// group of a leader the test has not reaped (the unreaped leader holds the
	/// group's number), every pinned process it holds, then the leader. These
	/// tests start processes that trap TERM and loop forever, so a failed
	/// assertion must not leave them running.
	#[cfg(unix)]
	pub(crate) struct ProcessGuard {
		leader: std::process::Child,
		pins:   Vec<PinnedProcess>,
	}

	#[cfg(unix)]
	impl ProcessGuard {
		pub(crate) const fn new(leader: std::process::Child) -> Self {
			Self { leader, pins: Vec::new() }
		}

		/// Also ends `process`, which may have left the leader's group.
		pub(crate) fn pin(&mut self, process: &PinnedProcess) {
			self.pins.push(process.clone());
		}

		/// The leader, for a test that reaps it itself (Linux-only tests).
		#[cfg(target_os = "linux")]
		pub(crate) const fn leader(&mut self) -> &mut std::process::Child {
			&mut self.leader
		}
	}

	#[cfg(unix)]
	impl Drop for ProcessGuard {
		fn drop(&mut self) {
			if matches!(self.leader.try_wait(), Ok(None))
				&& let Ok(group) = i32::try_from(self.leader.id())
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

	/// A running pinned member proves its group after the leader exits and is
	/// reaped: it holds the group's number. The wave signals each member it
	/// enumerates through that member's own pin, on every Linux kernel with
	/// pidfds, without the kernel's pinned-leader group operation.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_running_member_anchors_its_group_after_the_leader_exits() {
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
		let dead_leader = PinnedProcess::from_pid(group).expect("pin the leader");
		let [anchor, peer] = [&members[0], &members[1]];
		assert!(guard.leader().wait().expect("reap the leader").success());
		assert_eq!(anchor.group_id(), Some(group), "the anchor stayed in the leader's group");

		let mut wave = SignalWave::new(libc::SIGKILL);
		assert!(wave.group_with(group, [&dead_leader, anchor]), "the anchor proves the group");
		assert_eq!(wave.reached(), 2, "each member is signalled through its own pin");
		let deadline = Instant::now() + Duration::from_secs(5);
		while anchor.status() == ProcessStatus::Running || peer.status() == ProcessStatus::Running {
			assert!(Instant::now() < deadline, "a group member outlived the wave");
			thread::sleep(Duration::from_millis(10));
		}
	}

	/// A wave delivers a group signal to the members it enumerated, through
	/// their own pins. A member that leaves the group after that must not get
	/// a second signal when it is also a direct target, and a member that
	/// joins after it must get the direct signal the wave still owes it.
	#[cfg(target_os = "linux")]
	#[test]
	fn signal_wave_uses_membership_at_group_delivery() {
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
            (root / "member-group").write_text(str(os.getpgrp()))
        (root / "count").write_text(str(count))
    def join(*_):
        os.setpgid(0, leader)
        (root / "joined").write_text(str(os.getpgrp()))
    signal.signal(signal.SIGTERM, term)
    signal.signal(signal.SIGUSR1, join)
    (root / "member").write_text(str(os.getpid()))
    (root / "count").write_text("0")
    while True:
        signal.pause()
(root / "leader").write_text(str(leader))
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
			while !dir.path().join("member").exists() {
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

			let mut wave = SignalWave::new(libc::SIGTERM);
			assert!(
				wave.group_with(leader_pin.pid(), [&leader_pin, &member_pin]),
				"{mode}: signal the group"
			);
			if mode == "join" {
				assert_eq!(unsafe { libc::kill(member_pid, libc::SIGUSR1) }, 0, "request group join");
			}
			if mode != "static" {
				let marker = if mode == "join" { "joined" } else { "member-group" };
				while !dir.path().join(marker).exists() {
					assert!(Instant::now() < deadline, "{mode}: membership change did not finish");
					thread::sleep(Duration::from_millis(5));
				}
			}
			assert!(wave.process(&member_pin), "{mode}: the wave must reach the member");
			thread::sleep(Duration::from_millis(100));
			assert_eq!(
				fs::read_to_string(dir.path().join("count")).expect("read TERM count"),
				"1",
				"{mode}: the member must take TERM once"
			);
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
		use std::{thread, time::Duration};

		let mut ledger = SpawnLedger::default();

		// Spawn a tiny child, pin it, wait for its exit, then record it, so
		// every entry is dead from the ledger's point of view.
		for _ in 0..(SpawnLedger::PRUNE_THRESHOLD * 2) {
			let mut child = std::process::Command::new("true")
				.spawn()
				.expect("spawn true");
			let pid = i32::try_from(child.id()).expect("child pid fits in i32");
			let pinned = PinnedProcess::from_pid(pid);
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
			ledger.record(None, pinned);
		}

		let retained = ledger.entries().len();
		assert!(
			retained < SpawnLedger::PRUNE_THRESHOLD,
			"pruning must bound retained entries below the sweep threshold once the pinned processes \
			 have exited; got {retained} retained (threshold {})",
			SpawnLedger::PRUNE_THRESHOLD
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
