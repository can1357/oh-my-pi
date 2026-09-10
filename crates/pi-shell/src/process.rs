//! Cross-platform process tree management.

use std::{
	collections::{HashMap, HashSet},
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
		collections::HashMap,
		ffi::OsStr,
		fs,
		os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		ptr,
		sync::{Arc, OnceLock},
	};

	use super::{GroupScope, ProcessStatus};

	/// Stable Linux process reference backed by a pidfd.
	#[derive(Clone)]
	pub struct Process {
		pid:        i32,
		pidfd:      Arc<OwnedFd>,
		start_time: u64,
	}

	impl Process {
		/// Identities this walk will follow under any one pid.
		///
		/// Keying on identity is what keeps a live replacement out of a corpse's
		/// shadow, but on its own it bounds nothing: a numeric key admitted each
		/// pid once and so could not recurse forever, while identities under one
		/// number are unlimited. A walk that recursed into every one of them
		/// would have no termination guarantee at all — reuse can mint a fresh
		/// identity for a number already recorded, and that identity's children
		/// can do the same, indefinitely.
		///
		/// A cap restores a bound of the numeric key's own order while leaving
		/// the replacement case — two identities, the corpse and its successor —
		/// far inside it. Reaching this many needs the pid allocator to come
		/// back around to one number that many times inside a single walk, which
		/// no live tree does.
		pub(super) const IDENTITIES_PER_PID: usize = 8;

		pub fn from_pid(pid: i32) -> Option<Self> {
			if pid <= 0 {
				return None;
			}
			let pidfd = open_pidfd(pid)?;
			let start_time = read_start_time(pid)?;
			Some(Self { pid, pidfd, start_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub fn children(&self) -> Vec<Self> {
			self.children_checked().0
		}

		/// The children, and whether the enumeration behind them happened.
		///
		/// An unreadable `/proc` directory yields no children, which reads the
		/// same as a process that has none. Ordinary churn is not a gap: a
		/// process that has exited has no reachable children, and a thread that
		/// vanished between the directory listing and the read took its entry
		/// with it. A path still present but unreadable is a gap.
		///
		/// A subject that exits under this call is churn too, and deliberately
		/// so, even though its own children were reparented out of the subtree
		/// at that moment and this reports the whole walk as sound without
		/// them. Two reasons, and neither is that the loss does not matter.
		///
		/// For every node but the walk's root the two ways of noticing are the
		/// same state. [`Self::push_validated_child`] rejects a child that is
		/// not running, so a descendant was observed running one syscall before
		/// the recursion reached it: whether the exit surfaces at the status
		/// check below or at the `task` directory a few lines on is timing, not
		/// a distinction. Charging either one makes the hard wave's rescan —
		/// run immediately after `SIGTERM`, over a tree that is supposed to be
		/// dying — report partial on the ordinary successful termination, and
		/// `hard_kill_walked_tree` refuses on partial. That is the mirror of
		/// the defect the completeness signal exists for: unattributable
		/// everywhere is no more useful than whole everywhere.
		///
		/// At the root the two are genuinely different states, and the one that
		/// matters is not reachable from here. A caller that pinned a live root
		/// and lost it before this ran is exposed — its subtree was never
		/// enumerated and the empty answer looks childless — but that exit
		/// precedes this call's first syscall, so it arrives at the status
		/// check indistinguishable from a root that had been gone for an hour.
		/// Separating them needs to know when the pin was taken, which only the
		/// caller holds; the caller therefore owns that check.
		pub fn children_checked(&self) -> (Vec<Self>, bool) {
			// Split, because these are different answers: a root that has exited has
			// no reachable children and saying so is whole, while one still present
			// whose `/proc` will not read is a subtree this cannot look into at all.
			if self.status() != ProcessStatus::Running {
				return (Vec::new(), true);
			}
			if read_start_time(self.pid) != Some(self.start_time) {
				return (Vec::new(), !pid_is_visible(self.pid));
			}

			// `/proc/{pid}/task/{tid}/children` is per-task: a child fork()ed from a
			// worker thread appears under that thread's `tid`, not the tgid. Walk
			// every task subdir and union the lists, then re-validate parentage.
			let task_dir = format!("/proc/{}/task", self.pid);
			let Ok(entries) = fs::read_dir(&task_dir) else {
				// Gone under the walk is churn; still there and unreadable is a gap.
				return (Vec::new(), !path_is_visible(&task_dir));
			};

			let mut out = Vec::new();
			let mut complete = true;
			let mut children_file_available = false;
			for entry in entries {
				let Ok(entry) = entry else {
					complete = false;
					continue;
				};
				let name = entry.file_name();
				let Some(tid_str) = name.to_str() else {
					continue;
				};
				if tid_str.parse::<i32>().is_err() {
					continue;
				}
				let children_path = format!("/proc/{}/task/{}/children", self.pid, tid_str);
				let Ok(content) = fs::read_to_string(&children_path) else {
					// A thread that exited took its children with it, to whichever
					// thread of this group adopted them; one still listed and
					// unreadable is a subtree this walk cannot see.
					if path_is_visible(&children_path) {
						complete = false;
					}
					continue;
				};
				// The file is readable -> this kernel has CONFIG_PROC_CHILDREN.
				children_file_available = true;
				for part in content.split_whitespace() {
					let Ok(child_pid) = part.parse::<i32>() else {
						continue;
					};
					self.push_validated_child(child_pid, &mut out, &mut complete);
				}
			}

			// Some Kata / microVM guest kernels are built without CONFIG_PROC_CHILDREN,
			// so no `.../children` file exists and the walk above finds nothing — which
			// would silently turn descendant signaling (cancellation cleanup) into a
			// no-op inside such containers. Fall back to scanning `/proc` and grouping
			// by parent pid, the same primitive the macOS path uses. Only taken when no
			// `children` file was readable, so kernels that support it keep the cheap
			// per-task fast path.
			if !children_file_available {
				match fs::read_dir("/proc") {
					Ok(proc_entries) => {
						for entry in proc_entries {
							let Ok(entry) = entry else {
								complete = false;
								continue;
							};
							let name = entry.file_name();
							let Some(pid_str) = name.to_str() else {
								continue;
							};
							let Ok(child_pid) = pid_str.parse::<i32>() else {
								continue;
							};
							self.push_validated_child(child_pid, &mut out, &mut complete);
						}
					},
					// No per-task lists and no table to fall back on: this answers
					// "no children" having been unable to look for any.
					Err(_) => complete = false,
				}
			}
			(out, complete)
		}

		/// Validate a candidate child pid — pinned, still running, currently
		/// parented to `self`, and not already collected — then push it onto
		/// `out`. Shared by the `/proc/<pid>/task/<tid>/children` fast path and
		/// the `/proc`-scan fallback for kernels without `CONFIG_PROC_CHILDREN`.
		///
		/// Deduped after pinning and on identity, never before and on the
		/// number. This walk has no process-table snapshot behind it — every
		/// candidate list is read from `/proc` as it is needed — so a number
		/// seen once is not a number that means the same thing later, and a
		/// candidate that failed validation must not spend it.
		fn push_validated_child(&self, child_pid: i32, out: &mut Vec<Self>, complete: &mut bool) {
			if child_pid == self.pid {
				return;
			}
			let Some(child) = Self::from_pid(child_pid) else {
				// The kernel listed this child. Failing to pin it is churn only if it
				// has since gone; still present and unpinnable is a `pidfd_open` the
				// host refused or a `/proc` entry it will not show us, and the child
				// is then dropped from a walk that answers as whole regardless.
				if pid_is_visible(child_pid) {
					*complete = false;
				}
				return;
			};
			// A zombie or an exited child needs no signal and has already handed its
			// own children on, so leaving it out costs the walk nothing.
			if child.status() != ProcessStatus::Running {
				return;
			}
			match current_parent_pid(child.pid) {
				Some(parent) if parent == self.pid => {},
				// Reparented out from under us between the listing and this read, so
				// it is genuinely not ours any more.
				Some(_) => return,
				// Unreadable rather than absent: the same refusal as above, reached
				// through `/proc/{pid}/status` instead of through the pidfd.
				None => {
					if pid_is_visible(child.pid) {
						*complete = false;
					}
					return;
				},
			}
			if out
				.iter()
				.any(|collected| collected.is_same_process(&child))
			{
				return;
			}
			out.push(child);
		}

		pub fn parent_pid(&self) -> Option<i32> {
			if self.status() == ProcessStatus::Running {
				current_parent_pid(self.pid)
			} else {
				None
			}
		}

		pub fn args(&self) -> Vec<String> {
			if !self.live_identity() {
				return Vec::new();
			}

			let cmdline_path = format!("/proc/{}/cmdline", self.pid);
			let Ok(content) = fs::read(cmdline_path) else {
				return Vec::new();
			};
			// Re-validate after the read: PID reuse between identity check and read
			// would otherwise leak an impostor's command line to callers.
			if !self.live_identity() {
				return Vec::new();
			}
			split_nul_arguments(&content)
		}

		pub const fn is_same_process(&self, other: &Self) -> bool {
			self.pid == other.pid && self.start_time == other.start_time
		}

		/// This reference's descriptor presented under `pid`, carrying a start
		/// time no live process can have.
		///
		/// Stands in for a reference pinned before its number was recycled,
		/// which is the state every identity check here exists for and the one
		/// state a test cannot ask the kernel for: reuse of a chosen pid waits
		/// on the cyclic allocator to come back around to it.
		///
		/// `generation` separates successive stand-ins at one number, so a test
		/// can build the several distinct identities that only repeated reuse
		/// would otherwise produce.
		/// [`Self::push_validated_child`] over one candidate.
		///
		/// The arms that separate a child which has gone from one the host will
		/// not show us are otherwise reachable only through a whole `/proc` walk,
		/// whose own enumeration fails first under the very conditions that
		/// produce them.
		#[cfg(test)]
		pub fn validate_child(&self, child_pid: i32) -> (Vec<Self>, bool) {
			let mut out = Vec::new();
			let mut complete = true;
			self.push_validated_child(child_pid, &mut out, &mut complete);
			(out, complete)
		}

		#[cfg(test)]
		pub fn stale_at(&self, pid: i32, generation: u64) -> Self {
			Self { pid, pidfd: Arc::clone(&self.pidfd), start_time: u64::MAX - generation }
		}

		pub fn kill(&self, signal: i32) -> bool {
			// SAFETY: `self.pidfd` is an owned file descriptor returned by a successful
			// `pidfd_open` call and remains open for the duration of this syscall. A null
			// `siginfo_t` pointer is explicitly accepted by `pidfd_send_signal` and makes
			// the kernel synthesize the same signal metadata as `kill(2)`. Flags are zero,
			// which is the documented default behavior.
			let ret = unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					self.pidfd.as_raw_fd(),
					signal,
					ptr::null::<libc::siginfo_t>(),
					0,
				)
			};
			ret == 0
		}

		/// Send `signal` to every task whose process group is the one this
		/// pidfd's process leads, resolving the group through the retained
		/// `struct pid`.
		///
		/// The number is never looked up, so this cannot reach a group that
		/// inherited it: a recycled pgid is a different `struct pid`, and the
		/// retained one has no tasks left attached. That also makes `ESRCH` a
		/// *proof* of emptiness rather than an absence of evidence, and a
		/// delivery a proof that the number still belongs to this group — the
		/// kernel keeps it allocated while any task is attached to it.
		///
		/// Only the two decisive answers are reported as such. Every other
		/// errno establishes nothing: `EINVAL` is the kernel rejecting the
		/// *signal* on a scope it does support, `EPERM` may be a member the
		/// caller may not signal or a seccomp filter refusing the syscall
		/// outright, and the two are indistinguishable from here.
		pub fn signal_own_group(&self, signal: i32) -> GroupScope {
			if !pidfd_group_scope_supported() {
				return GroupScope::Unresolved;
			}
			match pidfd_signal(self.pidfd.as_raw_fd(), signal, PIDFD_SIGNAL_PROCESS_GROUP) {
				Ok(()) => GroupScope::Signalled,
				Err(errno) if errno == libc::ESRCH => GroupScope::Empty,
				Err(_) => GroupScope::Unresolved,
			}
		}

		pub fn group_id(&self) -> Option<i32> {
			if self.status() != ProcessStatus::Running {
				return None;
			}

			// SAFETY: `self.pid` names the process currently referenced by `self.pidfd`
			// unless it exits concurrently. If it exits, `getpgid` reports failure rather
			// than dereferencing caller-owned memory.
			let pgid = unsafe { libc::getpgid(self.pid) };
			if pgid > 0 { Some(pgid) } else { None }
		}

		pub fn status(&self) -> ProcessStatus {
			loop {
				let mut pollfd =
					libc::pollfd { fd: self.pidfd.as_raw_fd(), events: libc::POLLIN, revents: 0 };
				// SAFETY: `pollfd` points to one initialized `pollfd` element, and the pidfd
				// remains open for the duration of the call. Timeout zero makes this a
				// non-blocking readiness probe.
				let ready = unsafe { libc::poll(&raw mut pollfd, 1, 0) };
				if ready < 0 {
					// Retry on EINTR; for any other transient poll error treat the pidfd as
					// still running. The pidfd is still owned and the kernel has not reported
					// the process gone — a spurious `Exited` here makes every downstream
					// signal/kill fall through silently.
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

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by process identity, and bounded so that neither concurrent
		/// reparenting nor pid reuse can keep the recursion going.
		///
		/// By identity rather than by pid, because unlike the macOS and Windows
		/// walks this one holds no snapshot: it re-reads `/proc` at every level,
		/// so a child that exits and is reaped part-way through can leave its
		/// number to a descendant found later, and a numeric key would step over
		/// the live one on the strength of the corpse it already passed.
		/// Bucketed by pid so the identity check stays a comparison against the
		/// few references that ever shared a number, not against the whole walk,
		/// and so the bound the numeric key used to provide has somewhere to
		/// live — see [`Self::IDENTITIES_PER_PID`].
		/// The walk, and whether it followed everything it found.
		///
		/// The cap is reachable only by repeated reuse of one number, but a
		/// caller cannot act on how unlikely that is: a walk that stopped short
		/// returns a subtree that looks exactly like a complete one, and every
		/// consumer here is about to terminate what it was handed and report the
		/// tree gone. Same reason [`pi_builtins::ProcInfo::all_checked`] exists
		/// one layer down.
		pub fn descendants_checked(&self) -> (Vec<Self>, bool) {
			let mut out = Vec::new();
			let mut visited: HashMap<i32, Vec<Self>> = HashMap::new();
			visited.insert(self.pid, vec![self.clone()]);
			let mut complete = true;
			self.descendants_into(&mut out, &mut visited, &mut complete);
			(out, complete)
		}

		/// [`Self::descendants`] with the walk's `visited` set pre-seeded.
		///
		/// A reference the walk recorded at one level, whose number a live
		/// process holds by the time a later level offers it, is the state the
		/// identity key exists for — and it needs a pid the kernel recycled
		/// mid-walk, which no test can ask for. Seeding the set puts the walk in
		/// that state directly.
		#[cfg(test)]
		pub fn descendants_after_seeing(&self, recorded: Vec<Self>) -> (Vec<Self>, bool) {
			let mut out = Vec::new();
			let mut visited: HashMap<i32, Vec<Self>> = HashMap::new();
			visited.insert(self.pid, vec![self.clone()]);
			for reference in recorded {
				visited.entry(reference.pid).or_default().push(reference);
			}
			let mut complete = true;
			self.descendants_into(&mut out, &mut visited, &mut complete);
			(out, complete)
		}

		fn descendants_into(
			&self,
			out: &mut Vec<Self>,
			visited: &mut HashMap<i32, Vec<Self>>,
			complete: &mut bool,
		) {
			let (children, enumerated) = self.children_checked();
			if !enumerated {
				*complete = false;
			}
			for child in children {
				let bucket = visited.entry(child.pid).or_default();
				// Identity first, then the cap. A process already recorded is in
				// `out` with its children walked from it, so it costs the number
				// nothing and must not be charged for — reading a re-sighting as a
				// dropped subtree is the mirror of the bug the identity key fixed,
				// reporting partial over a walk that missed nothing.
				if bucket.iter().any(|seen| seen.is_same_process(&child)) {
					continue;
				}
				// Spending the cap does drop a subtree, so it is the one skip here
				// that makes the answer partial.
				if bucket.len() >= Self::IDENTITIES_PER_PID {
					*complete = false;
					continue;
				}
				bucket.push(child.clone());
				child.descendants_into(out, visited, complete);
				out.push(child);
			}
		}

		fn live_identity(&self) -> bool {
			self.status() == ProcessStatus::Running
				&& read_start_time(self.pid) == Some(self.start_time)
		}
	}

	/// Whether `path` is still there at all, which separates something that
	/// vanished under the walk from something present but unreadable. Mirrors
	/// `pi_builtins`'s `pid_is_visible` one layer down.
	fn path_is_visible(path: &str) -> bool {
		fs::metadata(path).is_ok()
	}

	/// Whether `/proc/{pid}` is still there at all, which separates a process
	/// that exited under the walk from one present but unreadable.
	fn pid_is_visible(pid: i32) -> bool {
		path_is_visible(&format!("/proc/{pid}"))
	}

	fn split_nul_arguments(content: &[u8]) -> Vec<String> {
		content
			.split(|byte| *byte == 0)
			.filter(|part| !part.is_empty())
			.map(|part| String::from_utf8_lossy(part).into_owned())
			.collect()
	}

	fn current_parent_pid(pid: i32) -> Option<i32> {
		let status_path = format!("/proc/{pid}/status");
		let content = fs::read_to_string(status_path).ok()?;
		content.lines().find_map(|line| {
			line
				.strip_prefix("PPid:")
				.and_then(|ppid| ppid.trim().parse::<i32>().ok())
		})
	}

	fn read_start_time(pid: i32) -> Option<u64> {
		// `/proc/[pid]/stat` field 22 is the process start time in clock ticks since
		// boot. The comm field (between parens) may itself contain spaces and parens,
		// so locate the *last* `)` and split the trailing whitespace-separated fields.
		let stat_path = format!("/proc/{pid}/stat");
		let content = fs::read_to_string(stat_path).ok()?;
		let last_paren = content.rfind(')')?;
		let rest = &content[last_paren + 1..];
		rest.split_whitespace().nth(19)?.parse().ok()
	}

	fn open_pidfd(pid: i32) -> Option<Arc<OwnedFd>> {
		// SAFETY: `pidfd_open` takes the PID by value and does not read caller-owned
		// memory. Flags are zero, which is valid. On success the returned descriptor is
		// newly owned by this process and is immediately wrapped in `OwnedFd` below.
		let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid, 0) };
		if fd < 0 {
			return None;
		}

		// SAFETY: `fd` is non-negative and was just returned by `pidfd_open`, so it is
		// an open descriptor owned by this process. `OwnedFd` takes sole ownership and
		// will close it exactly once.
		Some(Arc::new(unsafe { OwnedFd::from_raw_fd(fd as RawFd) }))
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	/// `PIDFD_SIGNAL_PROCESS_GROUP`, added in Linux 6.9. Not in libc yet.
	const PIDFD_SIGNAL_PROCESS_GROUP: u32 = 4;

	/// `pidfd_send_signal` as a raw errno result.
	fn pidfd_signal(pidfd: RawFd, signal: i32, flags: u32) -> Result<(), i32> {
		// SAFETY: `pidfd` is passed by value and never dereferenced by this crate; a
		// null `siginfo_t` makes the kernel synthesize the same metadata as `kill(2)`.
		// An invalid descriptor is a valid argument here — the kernel reports `EBADF`
		// rather than touching caller memory — which is what the capability probe
		// below relies on.
		let ret = unsafe {
			libc::syscall(
				libc::SYS_pidfd_send_signal,
				pidfd,
				signal,
				ptr::null::<libc::siginfo_t>(),
				flags,
			)
		};
		if ret == 0 {
			return Ok(());
		}
		Err(
			std::io::Error::last_os_error()
				.raw_os_error()
				.unwrap_or(libc::EINVAL),
		)
	}

	/// Whether this kernel accepts a process-group scope on `pidfd_send_signal`.
	///
	/// Asked of the syscall's argument validation rather than of any process:
	/// the flags are rejected before the descriptor is ever looked up, so a
	/// deliberately closed descriptor separates the two answers cleanly.
	/// `EINVAL` is the scope being refused, `EBADF` is the scope being accepted
	/// and the descriptor then failing. Nothing has to exist for that, which is
	/// what keeps the answer independent of the caller's own process group —
	/// whose leader a long-lived host has usually outlived, and which may be
	/// group 1, a number `kill(2)` cannot address as a group at all. Both of
	/// those made a probe through a real group answer "unsupported" on a
	/// capable kernel.
	///
	/// Paired with the same call at the default scope, so a filter answering
	/// uniformly cannot pass as a kernel that distinguishes the two.
	///
	/// What this cannot do is authenticate a *success*. A filter can match this
	/// syscall on its flags alone — answering only the group-scoped form while
	/// every other signal this module sends still works — so a forged resolve is
	/// narrowly reachable rather than something that would have to break
	/// everything. What it buys is bounded: a forged resolve makes a group look
	/// signalled and its members attributable, which is why emptiness is never
	/// taken from this path alone and is corroborated numerically wherever it is
	/// read.
	pub fn pidfd_group_scope_supported() -> bool {
		static SUPPORTED: OnceLock<bool> = OnceLock::new();
		*SUPPORTED.get_or_init(|| {
			const CLOSED: RawFd = -1;
			matches!(
				(pidfd_signal(CLOSED, 0, PIDFD_SIGNAL_PROCESS_GROUP), pidfd_signal(CLOSED, 0, 0)),
				(Err(libc::EBADF), Err(libc::EBADF))
			)
		})
	}

	/// Find processes whose `/proc/{pid}/exe` symlink resolves to exactly
	/// `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		let mut matches = Vec::new();
		let Ok(entries) = fs::read_dir("/proc") else {
			return matches;
		};
		let target_os = OsStr::new(target);
		for entry in entries.flatten() {
			let name = entry.file_name();
			let Some(name_str) = name.to_str() else {
				continue;
			};
			let Ok(pid) = name_str.parse::<i32>() else {
				continue;
			};
			let exe_path = format!("/proc/{pid}/exe");
			let Ok(resolved) = fs::read_link(&exe_path) else {
				continue;
			};
			if resolved.as_os_str() == target_os
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}
}

#[cfg(target_os = "macos")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ptr,
	};

	use super::{GroupScope, ProcessStatus};

	#[link(name = "proc", kind = "dylib")]
	unsafe extern "C" {
		fn proc_listallpids(buffer: *mut i32, buffersize: i32) -> i32;
		fn proc_pidpath(pid: i32, buffer: *mut std::ffi::c_void, buffersize: u32) -> i32;
	}

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
			let info = read_bsdinfo(pid)?;
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
			// kernels when queried for the *calling* process — it returns one byte of
			// padding regardless of how many children the process actually has, so a
			// process can never list its own descendants. Confirmed on darwin 25.4
			// from C, Rust, and Bun callers via `proc_listchildpids(getpid(), …)`,
			// while `ps -P` and `pgrep -P` still see the same children. Walk the
			// whole pid table via `proc_listallpids` and filter on `pbi_ppid`
			// instead; this is the same approach we already use for `find_by_path`
			// and that the Windows implementation uses via Toolhelp snapshots.
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
			process_args(self.pid)
		}

		pub const fn is_same_process(&self, other: &Self) -> bool {
			self.pid == other.pid
				&& self.start_tvsec == other.start_tvsec
				&& self.start_tvusec == other.start_tvusec
		}

		pub fn kill(&self, signal: i32) -> bool {
			// Re-validate identity right before signaling. There is no atomic
			// "kill iff start_time matches" primitive on macOS, so a vanishingly small
			// window remains between this check and the syscall — but matching against
			// the recorded `(pid, start_tvsec, start_tvusec)` triple eliminates the
			// PID-reuse race in every practical case.
			if self.live_bsdinfo().is_none() {
				return false;
			}
			// SAFETY: `kill` takes integer identifiers by value and does not access
			// caller-owned memory.
			unsafe { libc::kill(self.pid, signal) == 0 }
		}

		pub fn group_id(&self) -> Option<i32> {
			let info = self.live_bsdinfo()?;
			i32::try_from(info.pbi_pgid).ok().filter(|pgid| *pgid > 0)
		}

		/// Darwin has no pidfd, so a process group is only ever reachable by its
		/// number and the caller has to establish ownership itself.
		pub const fn signal_own_group(&self, _signal: i32) -> GroupScope {
			GroupScope::Unresolved
		}

		/// Walk the descendant tree in post-order (leaves first), de-duplicating
		/// by PID so concurrent reparenting cannot trap us in a cycle.
		/// The walk, and whether it saw everything it should have.
		///
		/// Always `true` here. This platform's enumeration is deferred to the
		/// follow-up that can run it: reporting a gap needs the snapshot and
		/// per-entry failures to be told apart from ordinary churn, and that
		/// distinction cannot be verified from Linux. Reporting no gap keeps the
		/// behaviour this platform already shipped rather than guessing at one.
		pub fn descendants_checked(&self) -> (Vec<Self>, bool) {
			(self.descendants(), true)
		}

		pub fn descendants(&self) -> Vec<Self> {
			// One process-table snapshot per walk — building it inside the recursion
			// would re-scan every pid for every visited node, producing an `O(N · D)`
			// kernel call pattern. Mirrors the Windows implementation.
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
			match self.live_bsdinfo() {
				Some(info) if info.pbi_status != libc::SZOMB => ProcessStatus::Running,
				_ => ProcessStatus::Exited,
			}
		}

		/// Returns the current `proc_bsdinfo` only if it still describes the same
		/// process this reference was opened on — i.e. the start time has not
		/// changed.
		fn live_bsdinfo(&self) -> Option<libc::proc_bsdinfo> {
			let info = read_bsdinfo(self.pid)?;
			if info.pbi_start_tvsec == self.start_tvsec && info.pbi_start_tvusec == self.start_tvusec {
				Some(info)
			} else {
				None
			}
		}
	}

	/// Send `signal` to the process group `pgid`.
	/// Returns true when the signal is delivered successfully.
	pub fn kill_process_group(pgid: i32, signal: i32) -> bool {
		// SAFETY: `kill` takes integer identifiers by value and does not access
		// caller-owned memory. A negative PID is the POSIX process-group form.
		unsafe { libc::kill(-pgid, signal) == 0 }
	}

	const KERN_PROCARGS2: libc::c_int = 49;

	const PROC_PIDPATHINFO_MAXSIZE: usize = 4096;

	/// Snapshot every pid currently visible to `proc_listallpids`. macOS
	/// silently truncates the second call to the supplied buffer size even
	/// when the sizing query reports more bytes available, so the buffer is
	/// padded well beyond the reported count.
	fn snapshot_all_pids() -> Vec<i32> {
		// SAFETY: Passing a null buffer with size 0 is the documented libproc query
		// form for obtaining the byte count needed for all PIDs; libproc does not
		// dereference the null pointer in this mode.
		let bytes = unsafe { proc_listallpids(ptr::null_mut(), 0) };
		if bytes <= 0 {
			return Vec::new();
		}
		let count = (bytes as usize) / size_of::<i32>();
		let cap = count.saturating_mul(4).max(2048);
		let mut buffer = vec![0i32; cap];
		// SAFETY: `buffer` is valid for `buffer.len() * size_of::<i32>()` bytes and
		// is properly aligned for `i32`; libproc writes at most the supplied size.
		let actual =
			unsafe { proc_listallpids(buffer.as_mut_ptr(), (buffer.len() * size_of::<i32>()) as i32) };
		if actual <= 0 {
			return Vec::new();
		}
		let pid_count = ((actual as usize) / size_of::<i32>()).min(buffer.len());
		buffer.truncate(pid_count);
		buffer
	}

	/// Build a `ppid -> [pids]` map from a one-shot scan of `proc_listallpids`.
	///
	/// Used as the foundation of `Process::children` and `Process::descendants`
	/// on macOS where `proc_listchildpids` returns no children for self-queries.
	pub(super) fn build_process_tree() -> HashMap<i32, Vec<i32>> {
		let pids = snapshot_all_pids();
		let mut tree: HashMap<i32, Vec<i32>> = HashMap::with_capacity(pids.len() / 2);
		for pid in pids {
			if pid <= 0 {
				continue;
			}
			let Some(info) = read_bsdinfo(pid) else {
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
		let pids = snapshot_all_pids();
		let mut path_buf = vec![0u8; PROC_PIDPATHINFO_MAXSIZE];
		let mut matches = Vec::new();
		for pid in pids {
			if pid <= 0 {
				continue;
			}
			// SAFETY: `path_buf` is valid for `path_buf.len()` bytes; libproc writes a
			// NUL-terminated path no longer than the supplied capacity and returns the
			// number of bytes written.
			let len = unsafe {
				proc_pidpath(
					pid,
					path_buf.as_mut_ptr().cast::<std::ffi::c_void>(),
					path_buf.len() as u32,
				)
			};
			if len <= 0 {
				continue;
			}
			let path_bytes = &path_buf[..len as usize];
			let path_bytes = match path_bytes.iter().position(|byte| *byte == 0) {
				Some(end) => &path_bytes[..end],
				None => path_bytes,
			};
			let Ok(path) = std::str::from_utf8(path_bytes) else {
				continue;
			};
			if path == target
				&& let Some(process) = Process::from_pid(pid)
			{
				matches.push(process);
			}
		}
		matches
	}

	fn read_bsdinfo(pid: i32) -> Option<libc::proc_bsdinfo> {
		// SAFETY: `proc_bsdinfo` is a plain C data struct. Zero initialization is
		// valid because every field is an integer or fixed-size integer array, and
		// libproc fully overwrites the fields it reports on a successful call.
		let mut info = unsafe { std::mem::zeroed::<libc::proc_bsdinfo>() };
		// SAFETY: `info` is a writable `proc_bsdinfo` buffer whose exact byte size is
		// supplied to libproc. The PID, flavor, and arg are scalar values passed by
		// value; libproc writes at most the supplied buffer size.
		let actual = unsafe {
			libc::proc_pidinfo(
				pid,
				libc::PROC_PIDTBSDINFO,
				0,
				(&raw mut info).cast::<std::ffi::c_void>(),
				size_of::<libc::proc_bsdinfo>() as i32,
			)
		};
		if actual < size_of::<libc::proc_bsdinfo>() as i32 {
			return None;
		}
		Some(info)
	}

	fn process_args(pid: i32) -> Vec<String> {
		let mut mib = [libc::CTL_KERN, KERN_PROCARGS2, pid];
		let mut size = 0usize;
		// SAFETY: `mib` points to three initialized integers and the old-value buffer
		// is null with a zero-length query, which is the documented `sysctl` sizing
		// pattern. `size` is a valid out-parameter for the required byte count.
		let sizing_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				ptr::null_mut(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !sizing_ok || size <= size_of::<libc::c_int>() {
			return Vec::new();
		}

		let mut buffer = vec![0u8; size];
		// SAFETY: `mib` still points to three initialized integers. `buffer` is
		// writable for `size` bytes, and `size` is provided as the in/out byte count.
		let read_ok = unsafe {
			libc::sysctl(
				mib.as_mut_ptr(),
				mib.len() as u32,
				buffer.as_mut_ptr().cast::<std::ffi::c_void>(),
				&raw mut size,
				ptr::null_mut(),
				0,
			)
		} == 0;
		if !read_ok {
			return Vec::new();
		}
		buffer.truncate(size);
		parse_macos_procargs(&buffer)
	}

	fn parse_macos_procargs(buffer: &[u8]) -> Vec<String> {
		// KERN_PROCARGS2 layout: `argc: i32 | exec_path: NUL-padded | argv[0..argc] |
		// env[..]`. argc covers only argv, so we must skip the exec_path NUL padding
		// and stop after exactly argc entries — otherwise environment variables leak
		// into the arg list (each NUL-terminated env=value is indistinguishable from
		// an arg).
		let argc_size = size_of::<libc::c_int>();
		if buffer.len() <= argc_size {
			return Vec::new();
		}

		let argc_bytes: [u8; 4] = match buffer[..argc_size].try_into() {
			Ok(bytes) => bytes,
			Err(_) => return Vec::new(),
		};
		let argc = libc::c_int::from_ne_bytes(argc_bytes);
		if argc <= 0 {
			return Vec::new();
		}

		let mut offset = argc_size;
		while offset < buffer.len() && buffer[offset] != 0 {
			offset += 1;
		}
		while offset < buffer.len() && buffer[offset] == 0 {
			offset += 1;
		}

		let mut args = Vec::with_capacity(argc as usize);
		while offset < buffer.len() && args.len() < argc as usize {
			let end = buffer[offset..]
				.iter()
				.position(|byte| *byte == 0)
				.map_or(buffer.len(), |position| offset + position);
			if end == offset {
				break;
			}
			args.push(String::from_utf8_lossy(&buffer[offset..end]).into_owned());
			offset = end + 1;
		}
		args
	}
}
#[cfg(target_os = "windows")]
mod platform {
	use std::{
		collections::{HashMap, HashSet},
		ffi::c_void,
		mem,
		sync::Arc,
	};

	use smallvec::SmallVec;

	use super::{GroupScope, ProcessStatus};

	#[repr(C)]
	#[allow(non_snake_case, reason = "Windows PROCESSENTRY32W field names must match Win32 ABI")]
	struct PROCESSENTRY32W {
		dwSize:              u32,
		cntUsage:            u32,
		th32ProcessID:       u32,
		th32DefaultHeapID:   usize,
		th32ModuleID:        u32,
		cntThreads:          u32,
		th32ParentProcessID: u32,
		pcPriClassBase:      i32,
		dwFlags:             u32,
		szExeFile:           [u16; 260],
	}

	#[repr(C)]
	struct ProcessBasicInformation {
		exit_status: i32,
		peb_base_address: usize,
		affinity_mask: usize,
		base_priority: i32,
		unique_process_id: usize,
		inherited_from_unique_process_id: usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct UnicodeString {
		length:         u16,
		maximum_length: u16,
		buffer:         usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct PebPartial {
		reserved1:          [u8; 2],
		being_debugged:     u8,
		reserved2:          [u8; 1],
		reserved3:          [usize; 2],
		loader:             usize,
		process_parameters: usize,
	}

	#[repr(C)]
	#[derive(Clone, Copy)]
	struct UserProcessParametersPartial {
		reserved1:       [u8; 16],
		reserved2:       [usize; 10],
		image_path_name: UnicodeString,
		command_line:    UnicodeString,
	}

	#[repr(C)]
	#[derive(Clone, Copy, Default)]
	struct Filetime {
		dw_low_date_time:  u32,
		dw_high_date_time: u32,
	}

	type Handle = *mut c_void;
	type NtStatus = i32;
	const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;
	const PROCESS_QUERY_INFORMATION: u32 = 0x0400;
	const PROCESS_VM_READ: u32 = 0x0010;
	const PROCESS_BASIC_INFORMATION_CLASS: u32 = 0;
	const STATUS_SUCCESS: NtStatus = 0;
	const TH32CS_SNAPPROCESS: u32 = 0x00000002;
	const PROCESS_TERMINATE: u32 = 0x0001;
	const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
	const SYNCHRONIZE: u32 = 0x00100000;
	const PROCESS_REFERENCE_ACCESS: u32 =
		PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE;
	const WAIT_OBJECT_0: u32 = 0;

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn CreateToolhelp32Snapshot(dwFlags: u32, th32ProcessID: u32) -> Handle;
		fn Process32FirstW(hSnapshot: Handle, lppe: *mut PROCESSENTRY32W) -> i32;
		fn Process32NextW(hSnapshot: Handle, lppe: *mut PROCESSENTRY32W) -> i32;
		fn CloseHandle(hObject: Handle) -> i32;
		fn OpenProcess(dwDesiredAccess: u32, bInheritHandle: i32, dwProcessId: u32) -> Handle;
		fn TerminateProcess(hProcess: Handle, uExitCode: u32) -> i32;
		fn QueryFullProcessImageNameW(
			hProcess: Handle,
			dwFlags: u32,
			lpExeName: *mut u16,
			lpdwSize: *mut u32,
		) -> i32;
		fn WaitForSingleObject(hHandle: Handle, dwMilliseconds: u32) -> u32;
		fn GetProcessTimes(
			hProcess: Handle,
			lpCreationTime: *mut Filetime,
			lpExitTime: *mut Filetime,
			lpKernelTime: *mut Filetime,
			lpUserTime: *mut Filetime,
		) -> i32;
		fn ReadProcessMemory(
			hProcess: Handle,
			lpBaseAddress: *const c_void,
			lpBuffer: *mut c_void,
			nSize: usize,
			lpNumberOfBytesRead: *mut usize,
		) -> i32;
		fn LocalFree(hMem: Handle) -> Handle;
	}

	#[link(name = "shell32")]
	unsafe extern "system" {
		fn CommandLineToArgvW(lpCmdLine: *const u16, pNumArgs: *mut i32) -> *mut *mut u16;
	}

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn NtQueryInformationProcess(
			ProcessHandle: Handle,
			ProcessInformationClass: u32,
			ProcessInformation: *mut c_void,
			ProcessInformationLength: u32,
			ReturnLength: *mut u32,
		) -> NtStatus;
	}

	struct OwnedHandle {
		raw: isize,
	}

	impl OwnedHandle {
		fn from_raw(raw: Handle) -> Option<Self> {
			if raw.is_null() || raw == INVALID_HANDLE_VALUE {
				None
			} else {
				Some(Self { raw: raw as isize })
			}
		}

		const fn as_raw(&self) -> Handle {
			self.raw as Handle
		}
	}

	impl Drop for OwnedHandle {
		fn drop(&mut self) {
			// SAFETY: `self.raw` was returned by a successful Win32 handle-producing
			// function and stored only in this `OwnedHandle`. `Drop` runs once, so this
			// closes the owned handle exactly once and no code uses it afterward.
			let _ = unsafe { CloseHandle(self.as_raw()) };
		}
	}

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
			let pid_u32 = u32::try_from(pid).ok()?;
			let handle = open_process(pid_u32, PROCESS_REFERENCE_ACCESS)?;
			let creation_time = process_creation_time(handle.as_raw())?;
			Some(Self { pid, handle, creation_time })
		}

		pub const fn pid(&self) -> i32 {
			self.pid
		}

		pub const fn is_same_process(&self, other: &Self) -> bool {
			self.pid == other.pid && self.creation_time == other.creation_time
		}

		pub fn parent_pid(&self) -> Option<i32> {
			process_basic_information(self.handle.as_raw())
				.and_then(|info| i32::try_from(info.inherited_from_unique_process_id).ok())
				.filter(|pid| *pid > 0)
		}

		pub fn args(&self) -> Vec<String> {
			process_command_line(self)
				.as_deref()
				.map(split_windows_command_line)
				.unwrap_or_default()
		}

		pub fn children(&self) -> Vec<Self> {
			let tree = build_process_tree();
			Self::children_from_tree(self.pid, &tree)
		}

		/// Walk the entire descendant tree using a single Toolhelp snapshot.
		///
		/// `children()` recursing per-node would re-snapshot the whole process
		/// table for every visited descendant, making tree termination
		/// `O(N · D)` snapshots. One snapshot per termination wave is enough.
		/// The walk, and whether it saw everything it should have.
		///
		/// Always `true` here. This platform's enumeration is deferred to the
		/// follow-up that can run it: reporting a gap needs the snapshot and
		/// per-entry failures to be told apart from ordinary churn, and that
		/// distinction cannot be verified from Linux. Reporting no gap keeps the
		/// behaviour this platform already shipped rather than guessing at one.
		pub fn descendants_checked(&self) -> (Vec<Self>, bool) {
			(self.descendants(), true)
		}

		pub fn descendants(&self) -> Vec<Self> {
			let tree = build_process_tree();
			let Ok(root) = u32::try_from(self.pid) else {
				return Vec::new();
			};
			let mut visited: HashSet<u32> = HashSet::new();
			visited.insert(root);
			let mut out = Vec::new();
			Self::collect_descendants_from_tree(root, &tree, &mut visited, &mut out);
			out
		}

		fn children_from_tree(pid: i32, tree: &HashMap<u32, SmallVec<[u32; 4]>>) -> Vec<Self> {
			let Ok(pid_u32) = u32::try_from(pid) else {
				return Vec::new();
			};
			tree
				.get(&pid_u32)
				.into_iter()
				.flatten()
				.filter_map(|&child_pid| {
					let child = Self::from_pid(i32::try_from(child_pid).ok()?)?;
					(child.status() == ProcessStatus::Running).then_some(child)
				})
				.collect()
		}

		fn collect_descendants_from_tree(
			parent: u32,
			tree: &HashMap<u32, SmallVec<[u32; 4]>>,
			visited: &mut HashSet<u32>,
			out: &mut Vec<Self>,
		) {
			let Some(children) = tree.get(&parent) else {
				return;
			};
			for &child_pid in children {
				if !visited.insert(child_pid) {
					continue;
				}
				let Ok(child_pid_i) = i32::try_from(child_pid) else {
					continue;
				};
				let Some(child) = Self::from_pid(child_pid_i) else {
					continue;
				};
				if child.status() != ProcessStatus::Running {
					continue;
				}
				// Post-order: collect grandchildren first so leaves are signalled before
				// their parents during tree termination.
				Self::collect_descendants_from_tree(child_pid, tree, visited, out);
				out.push(child);
			}
		}

		pub fn kill(&self, _signal: i32) -> bool {
			// The handle pins the original kernel process object even after the PID is
			// recycled, so `TerminateProcess` cannot accidentally hit a different
			// process. SAFETY: `self.handle` is an owned process handle opened with
			// `PROCESS_TERMINATE` access and remains valid for the duration of this
			// call. The exit code is passed by value.
			unsafe { TerminateProcess(self.handle.as_raw(), 1) != 0 }
		}

		pub const fn group_id() -> Option<i32> {
			None
		}

		/// Windows has no process groups, so there is nothing to resolve.
		pub const fn signal_own_group(&self, _signal: i32) -> GroupScope {
			GroupScope::Unresolved
		}

		pub fn status(&self) -> ProcessStatus {
			// `WaitForSingleObject` on a process handle opened with `SYNCHRONIZE` is
			// the definitive liveness probe: the handle becomes signalled iff the
			// process has exited. This avoids the `STILL_ACTIVE == 259` pitfall in
			// `GetExitCodeProcess`, where a process that legitimately exits with code
			// 259 is indistinguishable from a still-running one.
			//
			// SAFETY: `self.handle` is an owned process handle opened with
			// `SYNCHRONIZE` access. A zero timeout makes this a non-blocking probe.
			let result = unsafe { WaitForSingleObject(self.handle.as_raw(), 0) };
			if result == WAIT_OBJECT_0 {
				ProcessStatus::Exited
			} else {
				ProcessStatus::Running
			}
		}
	}

	fn process_basic_information(handle: Handle) -> Option<ProcessBasicInformation> {
		let mut info = ProcessBasicInformation {
			exit_status: 0,
			peb_base_address: 0,
			affinity_mask: 0,
			base_priority: 0,
			unique_process_id: 0,
			inherited_from_unique_process_id: 0,
		};
		let mut returned = 0u32;
		// SAFETY: `handle` is a valid process handle. `info` is writable for exactly
		// `size_of::<ProcessBasicInformation>()` bytes, and `returned` is a valid
		// optional out-parameter for the byte count.
		let status = unsafe {
			NtQueryInformationProcess(
				handle,
				PROCESS_BASIC_INFORMATION_CLASS,
				(&raw mut info).cast::<c_void>(),
				mem::size_of::<ProcessBasicInformation>() as u32,
				&raw mut returned,
			)
		};
		(status == STATUS_SUCCESS).then_some(info)
	}

	fn process_command_line(process: &Process) -> Option<String> {
		let pid_u32 = u32::try_from(process.pid).ok()?;
		let read_handle = open_process(pid_u32, PROCESS_QUERY_INFORMATION | PROCESS_VM_READ)?;
		// PID-reuse defense: `OpenProcess` resolves a PID to *whichever* process owns
		// it right now, which need not be the one our original handle pinned. Compare
		// the freshly opened handle's creation time against the recorded value to
		// reject reads from an unrelated process that happens to share the PID.
		if process_creation_time(read_handle.as_raw())? != process.creation_time {
			return None;
		}
		let info = process_basic_information(read_handle.as_raw())?;
		let peb: PebPartial = read_remote(read_handle.as_raw(), info.peb_base_address)?;
		if peb.process_parameters == 0 {
			return None;
		}
		let params: UserProcessParametersPartial =
			read_remote(read_handle.as_raw(), peb.process_parameters)?;
		read_remote_unicode_string(read_handle.as_raw(), params.command_line)
	}

	fn process_creation_time(handle: Handle) -> Option<u64> {
		let mut creation = Filetime::default();
		let mut exit = Filetime::default();
		let mut kernel = Filetime::default();
		let mut user = Filetime::default();
		// SAFETY: `handle` is a valid process handle opened with at least
		// `PROCESS_QUERY_LIMITED_INFORMATION`. All four out-parameters point to
		// initialized, writable `Filetime` values that live until the call returns.
		let ok = unsafe {
			GetProcessTimes(handle, &raw mut creation, &raw mut exit, &raw mut kernel, &raw mut user)
				!= 0
		};
		if !ok {
			return None;
		}
		Some((u64::from(creation.dw_high_date_time) << 32) | u64::from(creation.dw_low_date_time))
	}

	fn read_remote<T: Copy>(handle: Handle, address: usize) -> Option<T> {
		if address == 0 {
			return None;
		}
		let mut value = mem::MaybeUninit::<T>::uninit();
		let mut bytes_read = 0usize;
		// SAFETY: `handle` is opened with `PROCESS_VM_READ`. `address` comes from
		// kernel-reported process structures for that same process. `value` points to
		// uninitialized local storage large enough for `T`, and `bytes_read` is a valid
		// out-parameter. The value is only assumed initialized after the OS reports a
		// full-size successful read.
		let ok = unsafe {
			ReadProcessMemory(
				handle,
				address as *const c_void,
				value.as_mut_ptr().cast::<c_void>(),
				mem::size_of::<T>(),
				&raw mut bytes_read,
			) != 0
		};
		if ok && bytes_read == mem::size_of::<T>() {
			// SAFETY: The successful `ReadProcessMemory` call above initialized exactly
			// `size_of::<T>()` bytes in `value`.
			Some(unsafe { value.assume_init() })
		} else {
			None
		}
	}

	fn read_remote_unicode_string(handle: Handle, value: UnicodeString) -> Option<String> {
		if value.length == 0 || value.buffer == 0 || !value.length.is_multiple_of(2) {
			return None;
		}
		let code_units = usize::from(value.length) / size_of::<u16>();
		let mut buffer = vec![0u16; code_units];
		let mut bytes_read = 0usize;
		// SAFETY: `handle` is opened with `PROCESS_VM_READ`. `value.buffer` and
		// `value.length` come from the remote process' own `UNICODE_STRING`. `buffer`
		// is writable for exactly `value.length` bytes, and `bytes_read` is a valid
		// out-parameter. The string is decoded only after a full successful read.
		let ok = unsafe {
			ReadProcessMemory(
				handle,
				value.buffer as *const c_void,
				buffer.as_mut_ptr().cast::<c_void>(),
				usize::from(value.length),
				&raw mut bytes_read,
			) != 0
		};
		if ok && bytes_read == usize::from(value.length) {
			Some(String::from_utf16_lossy(&buffer))
		} else {
			None
		}
	}

	fn split_windows_command_line(command_line: &str) -> Vec<String> {
		use std::os::windows::ffi::OsStringExt;

		let mut wide: Vec<u16> = command_line.encode_utf16().chain([0]).collect();
		let mut argc = 0i32;
		// SAFETY: `wide` is a local, NUL-terminated UTF-16 buffer that remains alive
		// for the duration of the call. `argc` is a valid out-parameter. The returned
		// argv block is released with `LocalFree` below as required by
		// `CommandLineToArgvW`.
		let argv = unsafe { CommandLineToArgvW(wide.as_mut_ptr(), &raw mut argc) };
		if argv.is_null() || argc <= 0 {
			return Vec::new();
		}
		let argc = argc as usize;
		// SAFETY: `CommandLineToArgvW` returned a non-null pointer to `argc` argument
		// pointers, valid until freed with `LocalFree`.
		let pointers = unsafe { std::slice::from_raw_parts(argv, argc) };
		let args = pointers
			.iter()
			.filter_map(|&arg| {
				if arg.is_null() {
					return None;
				}
				let mut len = 0usize;
				// SAFETY: Each pointer in the argv block is a NUL-terminated UTF-16
				// string owned by the argv block and valid until `LocalFree` below.
				while unsafe { *arg.add(len) } != 0 {
					len += 1;
				}
				// SAFETY: The loop above found the terminating NUL, so the preceding
				// `len` code units form a valid readable slice.
				let slice = unsafe { std::slice::from_raw_parts(arg, len) };
				Some(
					std::ffi::OsString::from_wide(slice)
						.to_string_lossy()
						.into_owned(),
				)
			})
			.collect();
		// SAFETY: `argv` is the allocation returned by `CommandLineToArgvW` and has
		// not been freed yet. No pointers into it are used after this call.
		let _ = unsafe { LocalFree(argv.cast::<c_void>()) };
		args
	}

	fn open_process(pid: u32, access: u32) -> Option<Arc<OwnedHandle>> {
		// SAFETY: `OpenProcess` takes the PID and access mask by value and does not
		// dereference caller-owned memory. Handle inheritance is disabled. Identity
		// is established by the caller (typically `Process::from_pid`) capturing the
		// creation time immediately after a successful open and re-checking it on
		// every subsequent operation that re-resolves the PID.
		let handle = unsafe { OpenProcess(access, 0, pid) };
		OwnedHandle::from_raw(handle).map(Arc::new)
	}

	fn create_process_snapshot() -> Option<OwnedHandle> {
		// SAFETY: The process snapshot API takes flags and a process ID by value and
		// does not dereference caller-owned memory. PID zero requests all processes.
		let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
		OwnedHandle::from_raw(snapshot)
	}

	const fn process_entry() -> PROCESSENTRY32W {
		PROCESSENTRY32W {
			dwSize:              mem::size_of::<PROCESSENTRY32W>() as u32,
			cntUsage:            0,
			th32ProcessID:       0,
			th32DefaultHeapID:   0,
			th32ModuleID:        0,
			cntThreads:          0,
			th32ParentProcessID: 0,
			pcPriClassBase:      0,
			dwFlags:             0,
			szExeFile:           [0; 260],
		}
	}

	/// Build a map of `parent_pid` -> [`child_pids`] for all processes.
	fn build_process_tree() -> HashMap<u32, SmallVec<[u32; 4]>> {
		let mut tree: HashMap<u32, SmallVec<[u32; 4]>> = HashMap::new();
		let Some(snapshot) = create_process_snapshot() else {
			return tree;
		};

		let mut entry = process_entry();
		// SAFETY: `snapshot` is a valid Toolhelp snapshot handle. `entry` points to a
		// writable `PROCESSENTRY32W` whose `dwSize` field was initialized to the exact
		// ABI size before the call.
		if unsafe { Process32FirstW(snapshot.as_raw(), &raw mut entry) } == 0 {
			return tree;
		}

		loop {
			tree
				.entry(entry.th32ParentProcessID)
				.or_default()
				.push(entry.th32ProcessID);

			// SAFETY: `snapshot` remains a valid Toolhelp snapshot handle, and `entry`
			// remains a writable `PROCESSENTRY32W` with its ABI size preserved.
			if unsafe { Process32NextW(snapshot.as_raw(), &raw mut entry) } == 0 {
				break;
			}
		}

		tree
	}

	/// Process groups are not exposed on Windows.
	/// Always returns `false`.
	pub const fn kill_process_group(_pgid: i32, _signal: i32) -> bool {
		false
	}

	/// Find processes whose `QueryFullProcessImageNameW` result equals `target`.
	pub fn find_by_path(target: &str) -> Vec<Process> {
		use std::{ffi::OsString, os::windows::ffi::OsStringExt};

		let mut matches = Vec::new();
		let Some(snapshot) = create_process_snapshot() else {
			return matches;
		};

		let mut entry = process_entry();
		let mut buf = vec![0u16; 32_768];
		let target = OsString::from(target);

		// SAFETY: `snapshot` is a valid Toolhelp snapshot handle. `entry` points to a
		// writable `PROCESSENTRY32W` whose `dwSize` field was initialized to the exact
		// ABI size before the call.
		if unsafe { Process32FirstW(snapshot.as_raw(), &raw mut entry) } == 0 {
			return matches;
		}

		loop {
			let pid = entry.th32ProcessID;
			if let Some(handle) = open_process(pid, PROCESS_QUERY_LIMITED_INFORMATION) {
				let mut size = buf.len() as u32;
				// SAFETY: `handle` was opened with query access and remains valid for the
				// call. `buf` is writable for `size` UTF-16 code units, and `size` is a valid
				// in/out parameter initialized to that capacity.
				let ok = unsafe {
					QueryFullProcessImageNameW(handle.as_raw(), 0, buf.as_mut_ptr(), &raw mut size) != 0
				};
				if ok {
					let path = OsString::from_wide(&buf[..size as usize]);
					if path == target
						&& let Some(process) = Process::from_pid(i32::try_from(pid).unwrap_or_default())
					{
						matches.push(process);
					}
				}
			}

			// SAFETY: `snapshot` remains a valid Toolhelp snapshot handle, and `entry`
			// remains a writable `PROCESSENTRY32W` with its ABI size preserved.
			if unsafe { Process32NextW(snapshot.as_raw(), &raw mut entry) } == 0 {
				break;
			}
		}

		matches
	}
}

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: platform::Process,
}

/// Stable references retained across a hard-kill wave.
pub struct ProcessExitWait {
	processes: Vec<Process>,
}

impl ProcessExitWait {
	/// Wait for every captured process, including processes reparented after the
	/// kill.
	pub async fn wait(self, timeout: Duration, ct: CancelToken) -> Result<bool> {
		wait_for_processes(&self.processes, Some(timeout), ct).await
	}
}

/// A termination target pinned before its waves run.
///
/// Built by [`Process::capture_termination`]; see that method for why the
/// capture cannot be deferred to the first wave.
pub struct TerminationPlan {
	root:                 Process,
	process_group:        Option<i32>,
	/// Pinned leader of `process_group`, revalidated before each group signal.
	group_leader:         Option<Process>,
	descendants:          Vec<Process>,
	/// Whether the walk that produced `descendants` followed everything it
	/// found. A partial one cannot report a completed termination any more than
	/// an unattributable group can.
	descendants_complete: bool,
	protected:            HashSet<i32>,
	live_at_capture:      bool,
}

impl TerminationPlan {
	/// Process group pinned at capture time, when one was requested and the root
	/// still had one.
	#[must_use]
	pub const fn process_group(&self) -> Option<i32> {
		self.process_group
	}

	/// Run the polite and hard waves over the captured tree.
	///
	/// Sends `TERM_SIGNAL` to the captured group, every captured descendant, and
	/// the root, then optionally waits up to `graceful_ms` for the tree to exit
	/// before escalating to `KILL_SIGNAL`. Pass `graceful_ms < 0` to skip the
	/// wait entirely (the polite signal is still emitted). Returns `true` when
	/// the tree has exited by the end of the hard wave's wait window.
	pub async fn terminate(
		mut self,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		if !self.live_at_capture {
			return Ok(true);
		}
		let root_signalable = !self.protected.contains(&self.root.pid());

		// Polite wave: SIGTERM the group, every captured descendant, then the root.
		self.signal_group(TERM_SIGNAL);
		for child in &self.descendants {
			let _ = child.inner.kill(TERM_SIGNAL);
		}
		if root_signalable {
			let _ = self.root.inner.kill(TERM_SIGNAL);
		}

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				&self.root,
				&self.descendants,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			// The pinned set going quiet does not prove the tree is gone: a member
			// reparented before capture carries the pgid but appears in neither the
			// root nor a walk rooted at it, so only the group can still see it. An
			// unattributable group is not an empty one — reading it as complete here
			// would report success over exactly the member this check exists for.
			//
			// The walk that produced the pinned set has to hold up for the same
			// reason, and this return is the one path that never reaches the hard
			// wave's own conjunction: a set that was short to begin with going quiet
			// says nothing about what it left out, and nothing rescans here.
			if exited
				&& self.descendants_complete
				&& matches!(self.group_survivors(), GroupSurvivors::Known(members) if members.is_empty())
			{
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too. The
		// rescan is unioned with the captured set rather than replacing it: a root
		// that dies to its own SIGTERM releases its surviving children to init,
		// where a walk rooted at the dead pid can no longer see them and would
		// report the tree gone while they run on.
		// Revalidated again: the grace wait above can be a full second, and a pgid
		// whose group empties in that time is free for anyone to inherit.
		self.signal_group(KILL_SIGNAL);
		// Group survivors join the captured set as targets in their own right, so
		// the closing wait covers them instead of only the root's own subtree.
		let (rescan, rescan_complete) = self.root.signalable_descendants_checked(&self.protected);
		let survivors = self.group_survivors();
		let group_accounted = survivors.is_known();
		extend_by_identity(
			&mut self.descendants,
			rescan.into_iter().chain(survivors.into_processes()),
		);
		for child in &self.descendants {
			let _ = child.inner.kill(KILL_SIGNAL);
		}
		if root_signalable {
			let _ = self.root.inner.kill(KILL_SIGNAL);
		}

		let exited = wait_for_exit(
			&self.root,
			&self.descendants,
			Some(Duration::from_millis(u64::from(timeout_ms))),
			ct,
		)
		.await?;
		// A group that could not be attributed contributes no targets, so a member
		// reparented out of the root's subtree is in neither the wait set nor the
		// signalled set. The pinned set going quiet says nothing about it. A walk
		// that stopped short is the same statement about the subtree: it left a
		// process out of both sets, and the ones that did get signalled going
		// quiet is not evidence about the one that never did.
		Ok(exited && group_accounted && self.descendants_complete && rescan_complete)
	}

	/// Signal the captured process group, preferring the pinned leader's
	/// identity over the pgid number.
	fn signal_group(&self, signal: i32) {
		let Some(pgid) = self.process_group else {
			return;
		};
		if let Some(leader) = &self.group_leader
			&& leader.signal_own_group(pgid, signal) != GroupScope::Unresolved
		{
			return;
		}
		if group_still_led_by(pgid, self.group_leader.as_ref()) {
			let _ = kill_process_group(pgid, signal);
		}
	}

	/// Live members of the captured process group, minus any protected pid.
	///
	/// A pgid outlives its leader, and a member reparented before capture never
	/// shows up in a walk rooted at the root, so the group is the only remaining
	/// handle on it. Filtered on `Running` rather than reusing
	/// `process_group_alive`, which is `kill(-pgid, 0)` and so counts an
	/// unreaped zombie as group liveness — and the root is normally exactly
	/// that at this point, which would make a complete termination burn its
	/// whole budget.
	///
	/// Only consulted once the pinned set has gone quiet, so the process-table
	/// scan stays off the grace wait's polling loop.
	fn group_survivors(&self) -> GroupSurvivors {
		let Some(pgid) = self.process_group else {
			return GroupSurvivors::Known(Vec::new());
		};
		let leader = self.group_leader.as_ref();
		// Scanned before the group is resolved, never after: only a resolve that
		// follows the scan vouches for it.
		let (members, complete) = Process::group_members_checked(pgid);
		// A group that resolves but scans empty is a contradiction rather than an
		// empty group — `/proc` enumeration can fail wholesale or skip entries, and
		// the leader of a numerically proven group is itself a member that has to
		// appear. Reading it as emptiness would report the very survivor this
		// exists to find as accounted for, which is the one thing it must not do.
		match leader.map_or(GroupScope::Unresolved, |leader| leader.probe_own_group(pgid)) {
			GroupScope::Signalled if complete && !members.is_empty() => {},
			// Nothing is attached to the retained pid object, and `kill(-pgid, 0)`
			// agrees, so nothing that answers to the number is this group's. Without
			// that second path the emptiness is not evidence: an errno can be
			// synthesized for a group that is in fact populated.
			GroupScope::Empty if complete && !process_group_alive(pgid) => {
				return GroupSurvivors::Known(Vec::new());
			},
			// Nothing but the number to go on, so the scan is only attributable while
			// the leader's pid still holds the leader.
			GroupScope::Unresolved
				if complete && group_still_led_by(pgid, leader) && !members.is_empty() => {},
			_ => return GroupSurvivors::Unattributable,
		}
		GroupSurvivors::Known(
			members
				.into_iter()
				.filter(|member| {
					member.status() == ProcessStatus::Running && !self.protected.contains(&member.pid())
				})
				.collect(),
		)
	}
}

/// The captured group's live members, or the fact that the group could not be
/// attributed to the capture at all.
///
/// Kept distinct because every consumer reads an empty survivor list as "the
/// group is accounted for": conflating the two turns a group that may still
/// hold a live member into a completed termination.
enum GroupSurvivors {
	Known(Vec<Process>),
	Unattributable,
}

impl GroupSurvivors {
	const fn is_known(&self) -> bool {
		matches!(self, Self::Known(_))
	}

	fn into_processes(self) -> Vec<Process> {
		match self {
			Self::Known(members) => members,
			Self::Unattributable => Vec::new(),
		}
	}
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

	/// Send `signal` to this process and its descendants, children first.
	///
	/// On Linux and macOS the signal is forwarded as-is. On Windows there is no
	/// signal abstraction, so the `signal` argument is ignored and the entire
	/// tree is hard-killed via `TerminateProcess`. Defaults to the POSIX
	/// hard-kill signal.
	///
	/// Carries no completeness verdict, and none can be derived from it. The
	/// return is how many processes were signalled, which is already a partial
	/// answer by construction — nothing is waited for, so it never means the
	/// tree is gone. Callers that need that answer take
	/// [`Self::hard_kill_tree`] or [`Self::capture_termination`], both of which
	/// refuse a walk that stopped short.
	#[must_use]
	pub fn kill_tree(&self, signal: Option<i32>) -> u32 {
		self.signal_tree(signal.unwrap_or(KILL_SIGNAL))
	}

	/// Live descendants of this process, with every protected subtree pruned.
	///
	/// A snapshot for callers that must terminate a tree *later*: once the root
	/// exits, its survivors are reparented and a walk rooted at its pid can no
	/// longer see them, so the references have to be pinned while it is alive.
	///
	/// Fails rather than returning a subtree it knows is partial. Every caller
	/// of this pins what it is given and later reports that tree terminated, so
	/// a short walk handed back as an ordinary one is a sweep that misses a
	/// process and says nothing about it.
	pub fn descendants(&self) -> Result<Vec<Self>> {
		let (descendants, complete) = self.signalable_descendants_checked(&host_protected_pids());
		anyhow::ensure!(complete, "descendant walk of {} could not be completed", self.pid());
		Ok(descendants)
	}

	/// Collect the group again after signalling it, folding the arrivals into
	/// `members`.
	///
	/// Every group signal is a broadcast to whatever is attached at the instant
	/// it fires, which is not what the scan before it named: a task that joined
	/// in between is signalled and then never waited for, and one that could not
	/// be signalled at all is dropped entirely. So the second collection has to
	/// end in an outcome rather than a conditional union — a group signal can
	/// succeed while some member of it was unsignalable, and losing that member
	/// for want of a second answer is the same false success by a longer route.
	#[cfg(not(target_os = "windows"))]
	fn recollect_after_signal(&self, pgid: i32, members: &mut Vec<Self>) -> Result<()> {
		let (arrivals, complete) = Self::group_members_checked(pgid);
		let vouched = match self.probe_own_group(pgid) {
			GroupScope::Signalled => true,
			// Nothing is attached and the number agrees, so there is nothing left to
			// have arrived and the members already collected are the whole of it.
			GroupScope::Empty if !process_group_alive(pgid) => return Ok(()),
			// Without the scope the number is all there is, and only the leader still
			// occupying its pid can vouch for a scan of it.
			GroupScope::Unresolved => self.leads_group(pgid),
			GroupScope::Empty => false,
		};
		anyhow::ensure!(vouched, "cannot account for process group {pgid} after signalling it");
		anyhow::ensure!(
			complete && !arrivals.is_empty(),
			"cannot observe members of process group {pgid}"
		);
		extend_by_identity(members, arrivals);
		Ok(())
	}

	/// Snapshot and hard-kill the tree before returning its exit waiter.
	///
	/// Fails rather than returning a waiter it knows to be incomplete: a process
	/// group that cannot be enumerated, or that answers empty through its leader
	/// while its number says otherwise, would otherwise leave a member out of
	/// the wait and let the tree report itself gone.
	pub fn hard_kill_tree(&self) -> Result<ProcessExitWait> {
		let protected = host_protected_pids();
		let (descendants, complete) = self.signalable_descendants_checked(&protected);
		self.hard_kill_walked_tree(descendants, complete, &protected)
	}

	/// [`Self::hard_kill_tree`] over a walk already taken.
	///
	/// Split out so the refusal below can be reached with a walk chosen by the
	/// caller: the walk stops short only under repeated reuse of one number,
	/// which cannot be arranged, and this refusal is the whole of what stands
	/// between a short walk and a waiter that reports the tree gone.
	fn hard_kill_walked_tree(
		&self,
		descendants: Vec<Self>,
		walk_complete: bool,
		protected: &HashSet<i32>,
	) -> Result<ProcessExitWait> {
		anyhow::ensure!(walk_complete, "descendant walk of {} could not be completed", self.pid());
		let mut processes = descendants;
		if let Some(pgid) = self.group_id()
			&& pgid == self.pid()
		{
			// `group_id` only answers for a reference whose identity still matches, but
			// that reference can be reaped between the answer and this scan, which
			// releases the pgid for an unrelated session leader to claim. So the scan
			// still needs vouching for, and only a resolve that follows it can do that.
			let (members, complete) = Self::group_members_checked(pgid);
			match self.signal_own_group(pgid, KILL_SIGNAL) {
				GroupScope::Signalled => {
					// This reference is a live leader, so it is a member of its own group
					// and has to appear in the scan. An empty or admittedly partial one
					// is the scan failing, which must not read as a group with nothing
					// left in it.
					anyhow::ensure!(
						complete && !members.is_empty(),
						"cannot observe members of process group {pgid}"
					);
					let mut members = members;
					self.recollect_after_signal(pgid, &mut members)?;
					processes.extend(members);
				},
				// Nothing is attached to the retained pid object and the number agrees,
				// so whatever answers to it now belongs to someone else.
				GroupScope::Empty if !process_group_alive(pgid) => {},
				GroupScope::Empty => anyhow::bail!(
					"process group {pgid} resolves empty through its leader and alive through its \
					 number"
				),
				GroupScope::Unresolved => {
					self.extend_with_unattributable_group(pgid, members, complete, &mut processes)?;
				},
			}
		}
		if !protected.contains(&self.pid()) {
			processes.push(self.clone());
		}
		Ok(Self::hard_kill_processes(processes, protected))
	}

	/// Whether both references describe the same process instance rather than
	/// merely the same numeric pid.
	#[must_use]
	pub const fn is_same_process(&self, other: &Self) -> bool {
		self.inner.is_same_process(&other.inner)
	}

	/// This reference under `pid`, standing in for the `generation`-th pinned
	/// before that number was recycled. See [`platform::Process::stale_at`].
	#[cfg(all(test, target_os = "linux"))]
	fn stale_at(&self, pid: i32, generation: u64) -> Self {
		Self::from_inner(self.inner.stale_at(pid, generation))
	}

	/// One candidate through the child validation. See
	/// [`platform::Process::validate_child`].
	#[cfg(all(test, target_os = "linux"))]
	fn validate_child(&self, child_pid: i32) -> (Vec<Self>, bool) {
		let (out, complete) = self.inner.validate_child(child_pid);
		(out.into_iter().map(Self::from_inner).collect(), complete)
	}

	/// Descendants of this process with the walk's visited set pre-seeded. See
	/// [`platform::Process::descendants_after_seeing`].
	#[cfg(all(test, target_os = "linux"))]
	fn descendants_after_seeing(&self, recorded: Vec<Self>) -> (Vec<Self>, bool) {
		let (descendants, complete) = self
			.inner
			.descendants_after_seeing(recorded.into_iter().map(|process| process.inner).collect());
		(descendants.into_iter().map(Self::from_inner).collect(), complete)
	}

	/// Signal the process group `pgid` through this reference's retained
	/// identity, bypassing the pgid number entirely.
	///
	/// `pgid` is required to match this pid because a pgid always numbers its
	/// own leader, and the syscall reads the group list off the *retained* pid
	/// object rather than redirecting to whatever group the process is in now:
	/// a member's pidfd answers `ESRCH` even while its group is populated. So a
	/// mismatch cannot deliver anything and is reported as unresolved instead of
	/// being attempted. `is_self_process_group` is rechecked here because this
	/// path skips `kill_process_group`'s own guard; note that guard fails open
	/// if its query fails, and neither check is atomic with the signal.
	#[must_use]
	pub fn signal_own_group(&self, pgid: i32, signal: i32) -> GroupScope {
		// Group 1 is excluded along with the nonsensical ones: `kill(-1, sig)`
		// addresses every process the caller may signal rather than that group, so
		// none of the numeric corroboration this module leans on means anything
		// there, and a group led by init is never ours to sweep.
		if pgid <= 1 || pgid != self.pid() || is_self_process_group(pgid) {
			return GroupScope::Unresolved;
		}
		self.inner.signal_own_group(signal)
	}

	/// Resolve the process group `pgid` through this reference's retained
	/// identity without signalling it.
	///
	/// Reported after a scan of the number, never before one: an answer speaks
	/// only for the instant it ran, so a scan that follows it can still capture
	/// a group that took the number in between, while a scan it follows is
	/// vouched for — the kernel keeps the number allocated for exactly as long
	/// as the retained pid object has tasks attached.
	#[must_use]
	pub fn probe_own_group(&self, pgid: i32) -> GroupScope {
		self.signal_own_group(pgid, 0)
	}

	/// Snapshot and hard-kill the process group this reference leads.
	///
	/// A detached child leads a group whose pgid is its own pid, so once the
	/// leader exits that number is the only *numeric* handle on the group — and
	/// the kernel releases it as soon as the group empties and the leader is
	/// reaped, after which it can name an unrelated session. Where the kernel
	/// can scope a signal to a pidfd's process group, the retained identity
	/// reaches the group without the number and the question does not arise;
	/// the answer also settles whether the number is still ours, so the scanned
	/// members can be killed and waited on individually.
	///
	/// Without that scope the number is all there is, so ownership has to be
	/// proved from the leader's pid, which is possible only while the leader is
	/// still a task. Killing scanned members individually is as destructive as
	/// the numeric broadcast, so both wait on the same proof.
	pub fn hard_kill_own_group(&self) -> Result<ProcessExitWait> {
		let pgid = self.pid();
		anyhow::ensure!(
			pgid > 1 && !is_self_process_group(pgid),
			"refusing to kill process group {pgid}"
		);
		#[cfg(target_os = "windows")]
		anyhow::bail!("process groups are unsupported on Windows");
		#[cfg(not(target_os = "windows"))]
		{
			// Scanned before the group is resolved, never after: the resolve below
			// vouches for this scan, because the kernel keeps the number allocated
			// for exactly as long as the retained pid object has tasks attached to
			// it. Resolving first would prove nothing about a later scan, which
			// could still capture a group that took the number in between.
			let (members, complete) = Self::group_members_checked(pgid);
			let protected = host_protected_pids();
			match self.signal_own_group(pgid, KILL_SIGNAL) {
				GroupScope::Signalled => {
					// A resolved group with an empty scan is a contradiction rather than
					// an empty group: `/proc` enumeration can fail wholesale or skip
					// entries, and reading that as emptiness would report the very member
					// this path exists to reach as already gone.
					anyhow::ensure!(
						complete && !members.is_empty(),
						"cannot observe members of process group {pgid}"
					);
					let mut members = members;
					self.recollect_after_signal(pgid, &mut members)?;
					Ok(Self::hard_kill_processes(members, &protected))
				},
				// Nothing is attached to the retained pid object, and the number agrees,
				// so this group is gone. The scan contributes no targets: a member that
				// left the group between the scan and this answer is indistinguishable
				// from one that never was ours.
				GroupScope::Empty if !process_group_alive(pgid) => {
					Ok(Self::hard_kill_processes(Vec::new(), &protected))
				},
				// The two paths disagree, and `kill(-pgid, 0)` is not the one under
				// suspicion: either the number has been reused, or an errno was
				// synthesized for a group that is in fact populated.
				GroupScope::Empty => anyhow::bail!(
					"process group {pgid} resolves empty through its leader and alive through its \
					 number"
				),
				GroupScope::Unresolved => {
					anyhow::ensure!(
						complete && (!members.is_empty() || !process_group_alive(pgid)),
						"cannot observe members of process group {pgid}"
					);
					// Zombies carry the pgid but need no signal, so a group with nothing
					// left running is swept by the identity-pinned per-process kills and
					// never by the numeric broadcast — a no-op on it, and a wrong-kill on
					// whoever claims the number next.
					if members
						.iter()
						.any(|member| member.status() == ProcessStatus::Running)
					{
						// Proved after the scan, not before it: the scan walks the whole
						// process table, and a group that empties during it releases the
						// pgid for an unrelated session leader to claim.
						anyhow::ensure!(
							self.leads_group(pgid),
							"process group {pgid} cannot be proven to still be ours"
						);
						let _ = kill_process_group(pgid, KILL_SIGNAL);
						let mut members = members;
						self.recollect_after_signal(pgid, &mut members)?;
						return Ok(Self::hard_kill_processes(members, &protected));
					}
					Ok(Self::hard_kill_processes(members, &protected))
				},
			}
		}
	}

	/// Collect the members of a group whose ownership the kernel would not
	/// settle, or refuse when they cannot be accounted for.
	///
	/// Split out because the scope this arm depends on is mostly a kernel
	/// capability rather than a runtime choice: where `pidfd_send_signal`
	/// carries a process-group scope the signal ordinarily resolves and this
	/// arm does not run, so on such a host the refusal below is not reachable
	/// by arranging processes. It is not strictly unreachable — a rejection
	/// from seccomp or an LSM lands here too — but nothing a test can arrange
	/// produces one. Same reason [`Self::hard_kill_walked_tree`] is split from
	/// [`Self::hard_kill_tree`].
	///
	/// The distinction it exists for is the one the `Empty` arms make too:
	/// unresolved means ownership could not be established, not that the group
	/// is gone, and only the second of those may drop what the scan found.
	fn extend_with_unattributable_group(
		&self,
		pgid: i32,
		members: Vec<Self>,
		complete: bool,
		processes: &mut Vec<Self>,
	) -> Result<()> {
		anyhow::ensure!(
			complete && (!members.is_empty() || !process_group_alive(pgid)),
			"cannot observe members of process group {pgid}"
		);
		// Zombies carry the pgid but need no signal, so a scan in which none of
		// the members found is still running is swept by the identity-pinned
		// per-process kills and never by the numeric broadcast — a no-op on
		// those, and a wrong-kill on whoever claims the number next. The scan is
		// the whole of what this knows: "none of the scanned members" is not
		// "nothing in the group".
		//
		// What that gives up: a process that joined this group after the scan is
		// neither signalled nor waited on. Broadcasting anyway to cover it does
		// not work here — `recollect_after_signal` requires the post-signal scan
		// to find something, and a group that really had nothing left legitimately
		// answers empty, so the broadcast turns an ordinary sweep into "cannot
		// observe members". Closing it needs that function to tell an emptied
		// group apart from an unreadable one, which is a change to a rule three
		// other callers share.
		if !members
			.iter()
			.any(|member| member.status() == ProcessStatus::Running)
		{
			processes.extend(members);
			return Ok(());
		}
		// Proved after the scan, not before it: the scan walks the whole process
		// table, and a group that empties during it releases the pgid for an
		// unrelated session leader to claim. Skipping the members instead would
		// drop a live one out of both the signal and the wait, and the group is
		// not reachable from the descendant walk, so nothing downstream would
		// pick it up — the tree would report itself gone over a running process.
		anyhow::ensure!(
			self.leads_group(pgid),
			"process group {pgid} cannot be proven to still be ours"
		);
		let _ = kill_process_group(pgid, KILL_SIGNAL);
		let mut members = members;
		self.recollect_after_signal(pgid, &mut members)?;
		processes.extend(members);
		Ok(())
	}

	/// Whether `pgid` still names the group this reference leads.
	fn leads_group(&self, pgid: i32) -> bool {
		pgid == self.pid() && group_still_led_by(pgid, Some(self))
	}

	/// Members of `pgid`, and whether the walk that found them saw everything.
	///
	/// The completeness matters more than the membership: a caller deciding that
	/// a group holds nothing, or holds only what it can see, is reasoning about
	/// an absence, and an enumeration that quietly lost entries produces exactly
	/// the same answer as a group that really is empty.
	fn group_members_checked(pgid: i32) -> (Vec<Self>, bool) {
		let (all, scanned) = pi_builtins::ProcInfo::all_checked();
		let mut complete = scanned;
		let mut members = Vec::new();
		for process in all {
			if process.group_id() != Some(pgid) {
				continue;
			}
			// A member the scan listed and this cannot pin is a member left out of
			// the wait, which is the one thing an "empty group" answer must not be
			// able to mean. Exiting between the scan and here is ordinary churn.
			let Some(pinned) = Self::from_pid(process.pid()) else {
				if process.status() == ProcessStatus::Running {
					complete = false;
				}
				continue;
			};
			// Left the group in between, so it is not this group's to signal.
			if pinned.status() != ProcessStatus::Exited && pinned.group_id() != Some(pgid) {
				continue;
			}
			members.push(pinned);
		}
		(members, complete)
	}

	fn hard_kill_processes(processes: Vec<Self>, protected: &HashSet<i32>) -> ProcessExitWait {
		let captured: HashSet<i32> = processes.iter().map(Self::pid).collect();
		let parents = processes
			.iter()
			.filter_map(|process| {
				process
					.ppid()
					.filter(|parent| captured.contains(parent))
					.map(|parent| (process.pid(), parent))
			})
			.collect();
		// Deduped by identity, never by number. A member that exits and is reaped
		// during a wave frees its pid for a replacement that can join the group
		// after the broadcast, and the recollection that finds it deliberately
		// keeps both references. Keyed on the pid, the pinned corpse arrives first
		// and wins, the live replacement is dropped from the signal and from the
		// wait, and the waiter reports the tree gone on the strength of the one
		// process it already knew had exited.
		let mut deduped: Vec<Self> = Vec::new();
		extend_by_identity(&mut deduped, processes);
		let processes: Vec<Self> = deduped
			.into_iter()
			.filter(|process| !pid_in_protected_subtree(process.pid(), protected, &parents))
			.collect();
		for process in &processes {
			let _ = process.inner.kill(KILL_SIGNAL);
		}
		ProcessExitWait { processes }
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
	/// Captures the tree and runs both waves in one call; see
	/// [`Process::capture_termination`] and [`TerminationPlan::terminate`].
	/// Split the two when the waves are scheduled onto an executor.
	pub async fn terminate_tree(
		&self,
		group: bool,
		graceful_ms: i32,
		timeout_ms: u32,
		ct: CancelToken,
	) -> Result<bool> {
		self
			.capture_termination(group)
			.terminate(graceful_ms, timeout_ms, ct)
			.await
	}

	/// Wait until this process exits, optionally bounded by `timeout`.
	pub async fn wait_for_exit(&self, timeout: Option<Duration>, ct: CancelToken) -> Result<bool> {
		wait_for_exit(self, &[], timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: platform::Process) -> Self {
		Self { inner }
	}

	/// Walk the live descendant tree from scratch. Cheap and idempotent — call
	/// it again before each signal wave so grandchildren spawned during a grace
	/// period are not missed.
	/// The walk, and whether it followed everything it found.
	fn live_descendants_checked(&self) -> (Vec<Self>, bool) {
		let (descendants, complete) = self.inner.descendants_checked();
		(descendants.into_iter().map(Self::from_inner).collect(), complete)
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		self.signal_tree_excluding(signal, &host_protected_pids())
	}

	/// Signal this process and its live descendants (children first), skipping
	/// any pid in `protected`.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		let descendants = self.signalable_descendants(protected);
		let mut signaled = 0u32;
		// If self leads its own process group, also signal the group — this catches
		// grandchildren reparented to init when their immediate parent died inside
		// the descendant walk.
		if let Some(pgid) = self.group_id()
			&& pgid == self.inner.pid()
		{
			let _ = kill_process_group(pgid, signal);
		}
		for child in &descendants {
			if child.inner.kill(signal) {
				signaled += 1;
			}
		}
		if !protected.contains(&self.pid()) && self.inner.kill(signal) {
			signaled += 1;
		}
		signaled
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
		self.signalable_descendants_checked(protected).0
	}

	/// [`Self::signalable_descendants`], and whether the walk behind it
	/// followed everything it found.
	///
	/// Pruning a protected subtree is a deliberate exclusion and leaves the
	/// answer complete; only the walk stopping short makes it partial.
	fn signalable_descendants_checked(&self, protected: &HashSet<i32>) -> (Vec<Self>, bool) {
		let (descendants, complete) = self.live_descendants_checked();
		let parents: HashMap<i32, i32> = descendants
			.iter()
			.filter_map(|descendant| descendant.ppid().map(|parent| (descendant.pid(), parent)))
			.collect();
		let signalable = descendants
			.into_iter()
			.filter(|descendant| !pid_in_protected_subtree(descendant.pid(), protected, &parents))
			.collect();
		(signalable, complete)
	}

	/// Pin everything a termination will need to signal, before any of it can
	/// disappear.
	///
	/// The group id and the descendant walk are only observable while the root
	/// is alive: once it exits, `getpgid` fails and a walk rooted at its pid
	/// returns nothing, because the survivors have been reparented. Callers that
	/// schedule the waves onto an executor must capture here, synchronously,
	/// rather than letting the first wave re-derive the tree after the root has
	/// had a scheduling hop to die.
	///
	/// A root that is already gone captures nothing and skips the walk entirely:
	/// hunting its group afterwards would risk a recycled pgid, so that decision
	/// belongs to the caller that still holds proof the group is its own.
	pub fn capture_termination(&self, group: bool) -> TerminationPlan {
		let protected = host_protected_pids();
		if self.status() != ProcessStatus::Running {
			return TerminationPlan {
				root: self.clone(),
				process_group: None,
				group_leader: None,
				descendants: Vec::new(),
				descendants_complete: true,
				protected,
				live_at_capture: false,
			};
		}
		let process_group = if group { self.group_id() } else { None };
		let (descendants, descendants_complete) = self.signalable_descendants_checked(&protected);
		TerminationPlan {
			// Pinned while the group is certainly still ours, so each later signal
			// can prove the number has not changed hands.
			group_leader: process_group.and_then(Self::from_pid),
			process_group,
			descendants,
			descendants_complete,
			root: self.clone(),
			protected,
			live_at_capture: true,
		}
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

/// Append every candidate that is not already present *as the same process*.
///
/// Keyed on identity rather than pid. A target that exits and is reaped during
/// a grace period frees its number for a replacement, so a numeric key would
/// drop the live candidate and leave the wave signalling the corpse that still
/// holds that number. Entries already in `retained` win ties, which is what
/// lets a pinned handle survive a rescan that can no longer see it.
fn extend_by_identity(retained: &mut Vec<Process>, candidates: impl IntoIterator<Item = Process>) {
	let mut index: HashMap<i32, Vec<Process>> = HashMap::new();
	for process in retained.iter() {
		index
			.entry(process.pid())
			.or_default()
			.push(process.clone());
	}
	for candidate in candidates {
		let bucket = index.entry(candidate.pid()).or_default();
		if bucket
			.iter()
			.any(|process| process.is_same_process(&candidate))
		{
			continue;
		}
		bucket.push(candidate.clone());
		retained.push(candidate);
	}
}

/// Whether `pgid` still names the group that `anchor` led when it was pinned.
///
/// A pgid outlives its leader but the kernel releases the number once the group
/// empties, so it can be handed to an unrelated session leader. `kill(2)` has
/// no "signal iff leader identity" form, so this cannot be atomic with the
/// signal; call it immediately before each numeric group signal so the gap is
/// two syscalls wide instead of a process-table scan or a whole grace period.
fn group_still_led_by(pgid: i32, anchor: Option<&Process>) -> bool {
	match Process::from_pid(pgid) {
		// The leader is still a task — running, or an unreaped zombie — so it
		// carries the pgid and the kernel cannot have released the number. Its
		// identity therefore settles ownership.
		Some(current) => anchor.is_some_and(|anchor| anchor.is_same_process(&current)),
		// Nothing holds the number, which is not evidence that it is still ours:
		// "our leader was reaped while our own survivors carry the pgid" and "our
		// group emptied, the number was reused, and that group then lost its own
		// leader" are the same observation from here, so the group is unattributable.
		None => false,
	}
}

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	let mut processes = Vec::with_capacity(descendants.len() + 1);
	processes.push(root.clone());
	processes.extend_from_slice(descendants);
	wait_for_processes(&processes, timeout, ct).await
}

async fn wait_for_processes(
	processes: &[Process],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if processes
		.iter()
		.all(|process| process.status() != ProcessStatus::Running)
	{
		return Ok(true);
	}

	let poll_interval = Duration::from_millis(50);
	// Measured against the clock, never summed from the naps this loop asked
	// for. A task delayed by runtime saturation or a long scheduler pause
	// resumes having spent that time whether or not it slept through it, and a
	// waiter crediting itself only what it requested buys another near-complete
	// budget past the deadline it advertised. `tokio`'s clock rather than the
	// standard one because it is the clock the naps below are scheduled
	// against, so the two cannot disagree.
	//
	// Not suspend-inclusive: this clock is monotonic, which on Linux excludes
	// time the host spent suspended, so a resume still under-counts. Covering
	// that needs `CLOCK_BOOTTIME`, which the timer these naps run on does not
	// use. Started here rather than at entry, so the budget bounds the polling
	// and not the initial status scan above it.
	let started = tokio::time::Instant::now();
	loop {
		let sleep_for = match timeout {
			Some(limit) => {
				let remaining = limit.saturating_sub(started.elapsed());
				if remaining.is_zero() {
					break;
				}
				remaining.min(poll_interval)
			},
			None => poll_interval,
		};
		ct.heartbeat()?;
		tokio::time::sleep(sleep_for).await;

		if processes
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
		{
			return Ok(true);
		}
	}

	Ok(false)
}

/// Outcome of resolving a process group through a pinned leader's identity
/// rather than through its pgid number.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum GroupScope {
	/// The kernel found tasks attached to the pinned group and signalled them.
	/// Because the number stays allocated while any task carries it, this also
	/// proves the number still names this group and nothing else.
	Signalled,
	/// No task carries the pinned group any more. This is a proof of emptiness:
	/// whatever answers to the number now belongs to a different group.
	Empty,
	/// The group cannot be resolved from the pinned identity here — the kernel
	/// has no process-group scope for pidfds, the platform has no pidfds, or the
	/// reference does not lead the group. The caller has to fall back to the
	/// numeric broadcast and establish ownership itself.
	Unresolved,
}

/// Whether a process group on this host stays reachable once its leader has
/// been reaped.
///
/// A pgid outlives its leader, but the kernel releases the number once the
/// group empties and the leader is reaped, after which it can name an unrelated
/// session — so a caller that only learns of the leader's exit after the fact
/// has no way to prove the number is still its own. Linux 6.9's
/// `PIDFD_SIGNAL_PROCESS_GROUP` reads the group off the leader's *retained* pid
/// object instead, which needs no such proof.
///
/// This answers only whether the scope exists. It does not promise that any
/// later signal resolves — a group can still empty, and every consumer keeps
/// its own attribution checks.
#[must_use]
pub fn group_outlives_its_leader() -> bool {
	#[cfg(target_os = "linux")]
	{
		platform::pidfd_group_scope_supported()
	}
	#[cfg(not(target_os = "linux"))]
	{
		false
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
	if pgid <= 1 || is_self_process_group(pgid) {
		return false;
	}
	platform::kill_process_group(pgid, signal)
}

#[cfg(unix)]
fn is_self_process_group(pgid: i32) -> bool {
	// SAFETY: `getpgid(0)` queries the calling process's pgid and does not access
	// caller-owned memory. A return value <= 0 is treated as "unknown", which
	// fails open so the actual signal call decides.
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
	pgids:           Vec<i32>,
	processes:       Vec<Process>,
	seen_pids:       HashSet<i32>,
	/// Spawns this set cannot account for, because no handle could be opened
	/// when their pid was still unambiguous. Not targets — there is nothing
	/// safe to signal for them — but a caller reading an empty or exhausted
	/// set as "the run is gone" needs to know they were never in it.
	unpinned_spawns: usize,
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
	/// Prefer [`add_process`](Self::add_process) whenever the caller can hold a
	/// [`Process`] captured at spawn time. This entry point cannot close the
	/// reuse window it names: it is called at termination, and a number whose
	/// original owner has exited and been replaced resolves to the replacement,
	/// which then joins the wave. Reaching it means no handle was pinned when
	/// the pid was still unambiguous, and the fix belongs at that spawn rather
	/// than here — nothing available at this point can tell the two apart.
	///
	/// One caller is left: background-job cleanup, whose pids come from the
	/// shell's job records rather than from a spawn this crate observed. The
	/// per-run cancellation path does not use this — its targets come from the
	/// spawn registry, which pins each one in `on_spawn`.
	pub fn add_pid(&mut self, pid: i32) {
		if self.seen_pids.insert(pid)
			&& let Some(process) = Process::from_pid(pid)
		{
			self.processes.push(process);
		}
	}

	/// Record a pre-pinned [`Process`] handle. Duplicates are ignored, by
	/// identity rather than by pid.
	///
	/// This is the correct entry point when the caller captured the handle at
	/// spawn time — the handle already pins OS-level identity, so no `from_pid`
	/// re-open (and its PID-reuse race) is needed at cancellation time.
	///
	/// The distinction is the same one that made pinning worthwhile: a run whose
	/// earlier child has exited and been reaped can spawn a later one onto that
	/// number, and both handles are recorded. Keyed on the pid the live child is
	/// the one dropped, because the corpse was recorded first.
	pub fn add_process(&mut self, process: Process) {
		if self.seen_pids.insert(process.pid()) {
			self.processes.push(process);
			return;
		}
		if self
			.processes
			.iter()
			.any(|existing| existing.is_same_process(&process))
		{
			return;
		}
		self.processes.push(process);
	}

	/// True when no targets have been recorded.
	///
	/// Says nothing about [`Self::unpinned_spawns`]: those are not targets and
	/// never become any, so a set can be empty and still not account for the
	/// run. Callers deciding a run is gone have to ask both.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.pgids.is_empty() && self.processes.is_empty()
	}

	/// How many spawns this set cannot account for.
	#[must_use]
	pub const fn unpinned_spawns(&self) -> usize {
		self.unpinned_spawns
	}

	/// Send `signal` to every recorded target. Failures are swallowed:
	/// targets routinely exit between collection and signalling, and
	/// the caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		for &pgid in &self.pgids {
			let _ = kill_process_group(pgid, signal);
		}
		for process in &self.processes {
			let _ = process.signal_tree(signal);
		}
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
	/// Spawns whose handle could not be opened at all. `pidfd_open` and
	/// `OpenProcess` can both be refused for a live child, and a child that
	/// was never pinned can never be safely signalled later — re-opening its
	/// number at cancellation is the reuse hazard this registry exists to
	/// close. Counted rather than dropped, because a target set that cannot
	/// account for a child must not read as one that has nothing to do.
	unpinned:      usize,
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
	state: Mutex<RegistryState>,
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
		if process.is_none() {
			state.unpinned += 1;
		}
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
			targets.unpinned_spawns = state.unpinned;
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
			// pid reserved, so the descendant walk covers the *original* subtree
			// via Toolhelp. If any child is still running we must keep the
			// entry — closing the handle would both release the pid (racing
			// pid reuse) and strand the surviving child.
			// Retaining on an incomplete walk belongs here too — dropping the entry
			// releases the pinned handle, frees the pid for reuse, and strands
			// whatever the walk failed to see. It is not written yet because this
			// platform's walk cannot yet report incompleteness; both halves land
			// together in the platform-enumeration follow-up.
			#[cfg(target_os = "windows")]
			if !process.live_descendants_checked().0.is_empty() {
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
	// Group 1 is refused here and not only at the public entry points, because
	// this predicate is what several of them consult before deciding a group is
	// theirs: `kill(-1, …)` is the broadcast form, not group one, so it answers
	// yes for essentially any caller and would license a sweep of every process
	// the caller may signal.
	if pgid <= 1 {
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
mod tests {
	use super::*;

	#[cfg(unix)]
	#[tokio::test]
	async fn exit_waiter_times_out_for_live_targets_and_accepts_unreaped_exit() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let root =
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child");
		let pending = ProcessExitWait { processes: vec![root.clone()] }
			.wait(Duration::ZERO, CancelToken::default())
			.await;
		let finished = root
			.hard_kill_tree()
			.expect("hard-kill the tree")
			.wait(Duration::from_secs(5), CancelToken::default())
			.await;
		let status = root.status();
		let _ = child.kill();
		let _ = child.wait();
		assert!(!pending.expect("wait for live child"), "a live process must exhaust the deadline");
		assert!(finished.expect("wait after hard kill"), "an unreaped child has already exited");
		assert_eq!(status, ProcessStatus::Exited);
	}

	/// The poll loop's budget is elapsed time, not the sum of the naps it asked
	/// for. A task delayed by runtime saturation or a long scheduler pause
	/// resumes having spent far more than it requested, and a waiter that
	/// credits itself only the requested amount then replays nearly its whole
	/// budget past the deadline it advertised.
	///
	/// Held to a virtual clock rather than a wall-clock stopwatch: the stall is
	/// injected, so the assertion is about the waiter's arithmetic and not about
	/// how loaded the machine running it happens to be. What it models is a
	/// delayed task, not a suspended host — the monotonic clock does not advance
	/// across suspension, so no test on it could establish that case.
	#[cfg(unix)]
	#[tokio::test(start_paused = true)]
	async fn exit_waiter_measures_its_budget_against_the_clock_not_its_own_naps() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let root =
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child");
		let budget = Duration::from_millis(5_000);
		let stall = Duration::from_secs(60);

		let started = tokio::time::Instant::now();
		let waiter = tokio::spawn(async move {
			wait_for_processes(&[root], Some(budget), CancelToken::default()).await
		});
		// Let the waiter reach its first poll nap before the clock moves, so the
		// stall lands inside a sleep the way a starved runtime would.
		tokio::task::yield_now().await;
		tokio::time::advance(stall).await;
		let pending = waiter.await.expect("waiter task");
		let total = started.elapsed();

		let _ = child.kill();
		let _ = child.wait();
		assert!(!pending.expect("wait for live child"), "a live process must exhaust the deadline");
		// Five poll intervals of slack. A waiter that reads the clock wakes past
		// its deadline and returns without napping again; one that credits itself
		// only the nap it asked for restarts on nearly the whole budget, which no
		// amount of slack this side of `budget` can absorb.
		let slack = Duration::from_millis(250);
		assert!(
			total < stall + slack,
			"a budget already spent must not buy another round of polling: {total:?} of virtual time \
			 against a {budget:?} deadline that a {stall:?} stall had already exhausted"
		);
	}

	/// A root that dies to its own polite signal reparents the descendants that
	/// outlived it, so the hard wave's fresh walk cannot see them. The pinned
	/// set has to survive into the hard wave and its wait.
	#[cfg(unix)]
	#[tokio::test]
	async fn hard_wave_kills_descendants_orphaned_by_the_polite_signal() {
		use std::io::{BufRead, BufReader};

		// The descendant reports its pid only after ignoring TERM, and SIG_IGN
		// survives the exec, so reading that line means the polite wave cannot
		// race the descendant's startup.
		let mut child = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg(r#"/bin/sh -c 'trap "" TERM; echo $$; exec sleep 30' & wait"#)
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("spawn root");
		let mut line = String::new();
		BufReader::new(child.stdout.take().expect("root stdout"))
			.read_line(&mut line)
			.expect("read descendant pid");
		let orphan =
			Process::from_pid(line.trim().parse().expect("descendant pid")).expect("pin descendant");
		let root = Process::from_pid(i32::try_from(child.id()).expect("root pid")).expect("pin root");

		let terminated = root
			.terminate_tree(false, 100, 5000, CancelToken::default())
			.await;

		let orphan_status = orphan.status();
		let _ = orphan.inner.kill(KILL_SIGNAL);
		let _ = child.kill();
		let _ = child.wait();
		assert!(terminated.expect("terminate tree"), "the tree must be reported gone");
		assert_eq!(
			orphan_status,
			ProcessStatus::Exited,
			"a descendant orphaned by the polite wave must still be hard-killed"
		);
	}

	/// Two references under one number, for the paths that have to tell a pinned
	/// corpse from the process that took its pid. The kernel cannot be asked to
	/// recycle a chosen pid, so the corpse is a real reaped reference presented
	/// under the live child's number.
	#[cfg(target_os = "linux")]
	fn recycled_pid_pair() -> (Process, Process, std::process::Child) {
		let mut first = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn the number's first holder");
		let pinned =
			Process::from_pid(i32::try_from(first.id()).expect("child pid")).expect("pin first");
		first.kill().expect("kill the first holder");
		first.wait().expect("reap the first holder");

		let live = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn the number's new holder");
		let live_pin = Process::from_pid(i32::try_from(live.id()).expect("child pid"))
			.expect("pin the new holder");
		(pinned.stale_at(live_pin.pid(), 0), live_pin, live)
	}

	/// `count` distinct stand-ins at `live`'s number, as repeated reuse of it
	/// would leave behind in a walk that had recorded each in turn.
	#[cfg(target_os = "linux")]
	fn stale_generations(corpse: &Process, live: &Process, count: usize) -> Vec<Process> {
		(0..count)
			.map(|generation| corpse.stale_at(live.pid(), generation as u64))
			.collect()
	}

	/// The hard wave's own dedup has to separate identity from number, because
	/// the recollection feeding it deliberately keeps both the pinned corpse and
	/// the live process that took its pid, corpse first. Dropping the live one
	/// leaves it unsignalled *and* out of the wait, so the wave reports the tree
	/// gone on the strength of the process it already knew had exited.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn hard_kill_wave_keeps_the_live_holder_of_a_reused_pid() {
		let (corpse, live_pin, mut live) = recycled_pid_pair();

		let swept = Process::hard_kill_processes(vec![corpse, live_pin.clone()], &HashSet::new())
			.wait(Duration::from_secs(5), CancelToken::default())
			.await;
		let status = live_pin.status();
		let _ = live.kill();
		let _ = live.wait();

		assert!(swept.expect("wait after the hard wave"), "the wave must report its targets gone");
		assert_eq!(
			status,
			ProcessStatus::Exited,
			"the live holder of a reused pid must be signalled, not dropped for the corpse recorded \
			 first"
		);
	}

	/// Unlike the macOS and Windows walks, the Linux one holds no process-table
	/// snapshot: every level re-reads `/proc`. So a number it recorded at one
	/// level can be held by a different, live process by the time a later level
	/// offers it, and keyed on the number the walk steps over the live one on
	/// the strength of a reference it already passed.
	#[cfg(target_os = "linux")]
	#[test]
	fn descendant_walk_keeps_a_child_that_reused_a_recorded_pid() {
		let (corpse, live_pin, mut live) = recycled_pid_pair();
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("pin the harness");

		// Stands in for the corpse being already in `visited` when the walk
		// reaches the live child, which is what a mid-walk recycle produces.
		let (found, complete) = harness.descendants_after_seeing(vec![corpse]);
		let covered = found
			.iter()
			.any(|descendant| descendant.is_same_process(&live_pin));
		let _ = live.kill();
		let _ = live.wait();

		assert!(
			covered,
			"a live child must survive a reference the walk already recorded under its number"
		);
		assert!(complete, "stepping past a stale reference leaves nothing out of the walk");
	}

	/// Identity keying admits what a numeric key rejected, so on its own it
	/// bounds nothing: reuse can mint a fresh identity for a number the walk
	/// already recorded, that identity's children can do the same, and the
	/// recursion never has to stop. The cap is what puts the numeric key's
	/// bound back.
	///
	/// Pins the cap rather than the unbounded walk itself: the walk only fails
	/// to terminate under repeated real pid reuse, which cannot be asked for.
	#[cfg(target_os = "linux")]
	#[test]
	fn descendant_walk_bounds_the_identities_it_follows_per_pid() {
		let (corpse, live_pin, mut live) = recycled_pid_pair();
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("pin the harness");
		let filled = stale_generations(&corpse, &live_pin, platform::Process::IDENTITIES_PER_PID);
		let under = stale_generations(&corpse, &live_pin, platform::Process::IDENTITIES_PER_PID - 1);

		let (at_cap, complete_at_cap) = harness.descendants_after_seeing(filled);
		let (below_cap, complete_below_cap) = harness.descendants_after_seeing(under);
		let followed_at_cap = at_cap
			.iter()
			.any(|descendant| descendant.is_same_process(&live_pin));
		let followed_below_cap = below_cap
			.iter()
			.any(|descendant| descendant.is_same_process(&live_pin));
		let _ = live.kill();
		let _ = live.wait();

		// The subtree the cap drops is the whole point of reporting it: a caller
		// that pins this set is about to terminate it and call the tree gone.
		assert!(!complete_at_cap, "a walk that spent the cap must not answer as a whole tree");
		assert!(complete_below_cap, "a walk that stayed inside the cap left nothing out");

		assert!(
			!followed_at_cap,
			"a number that has already spent its identities must stop the walk rather than extend it"
		);
		assert!(
			followed_below_cap,
			"the cap must not cost the live replacement the identity key exists to keep"
		);
	}

	/// The graceful wave's own early return is a third reader of the walk's
	/// report, and the only one that never reaches the hard wave's conjunction
	/// or its rescan: a set that was short to begin with going quiet says
	/// nothing about what it left out.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn a_partial_walk_is_not_a_completed_graceful_termination() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let root =
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child");
		let plan = |descendants_complete: bool| TerminationPlan {
			root: root.clone(),
			process_group: None,
			group_leader: None,
			descendants: Vec::new(),
			descendants_complete,
			protected: host_protected_pids(),
			live_at_capture: true,
		};

		// A graceful budget, so the wave can return before the hard one runs.
		let truncated = plan(false)
			.terminate(200, 5_000, CancelToken::default())
			.await;
		let whole = plan(true)
			.terminate(200, 5_000, CancelToken::default())
			.await;
		let _ = child.kill();
		let _ = child.wait();

		assert!(
			!truncated.expect("graceful terminate on a truncated walk"),
			"a graceful wave over a partial walk must not report the tree gone"
		);
		assert!(
			whole.expect("graceful terminate on a whole walk"),
			"a complete walk over an exited tree is a completed termination"
		);
	}

	/// A live child dropped by a failing validation must be a gap, and one that
	/// merely exited must not. The second half is the one with a reachable
	/// trigger, and it is the half that decides whether the signal is usable:
	/// an ordinary tree churns constantly, so reading churn as a gap would make
	/// every termination refuse.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_child_that_exited_under_the_walk_is_not_a_gap() {
		use std::io::{BufRead, BufReader};

		// A child that reports a grandchild and then exits, leaving the walk to
		// meet a listed pid that has since gone.
		let mut child = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg(r"sleep 30 & echo $!; exit 0")
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("spawn root");
		let mut line = String::new();
		BufReader::new(child.stdout.take().expect("root stdout"))
			.read_line(&mut line)
			.expect("read grandchild pid");
		let grandchild =
			Process::from_pid(line.trim().parse().expect("grandchild pid")).expect("pin grandchild");
		child.wait().expect("reap the root");

		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("pin the harness");
		let (_, complete) = harness.signalable_descendants_checked(&host_protected_pids());
		let _ = grandchild.inner.kill(KILL_SIGNAL);

		assert!(complete, "a walk over a tree whose members are exiting must still answer as whole");
	}

	/// A child the host will not let us pin is a subtree the walk drops, and
	/// dropping it silently is what makes a short walk look whole.
	///
	/// Starves the descriptor table so `pidfd_open` fails while `/proc/{pid}`
	/// stays visible — `stat(2)` needs no descriptor — which is the same shape
	/// as the seccomp and LSM refusals this arm exists for and the only one a
	/// test can ask for. What is pinned is the classification, not the errno:
	/// `open_pidfd` discards it, so `EMFILE` is only the means of producing a
	/// refusal. Runs the candidate through the validation directly, because a
	/// whole walk reads `/proc/<pid>/stat` before it gets here and would report
	/// its own arm first under the same starvation.
	///
	/// Process-wide state: safe under `cargo nextest`, which gives every test
	/// its own process. Do not move this to a thread-per-test runner.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_child_the_host_will_not_let_us_pin_is_a_gap() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let child_pid = i32::try_from(child.id()).expect("child pid fits in i32");
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("pin the harness");

		let (collected, whole) = harness.validate_child(child_pid);

		let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
		// SAFETY: `getrlimit` writes one `rlimit` through the pointer given and
		// reads nothing else.
		let queried = unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit) };
		let restore = limit;
		limit.rlim_cur = 64;
		// SAFETY: `setrlimit` reads one `rlimit` through the pointer given. Lowering
		// the soft limit below the hard limit is always permitted.
		let lowered = unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const limit) };
		let mut held = Vec::new();
		loop {
			// SAFETY: `open` reads the NUL-terminated literal and returns a new
			// descriptor this loop owns and closes below.
			let fd = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
			if fd < 0 {
				break;
			}
			held.push(fd);
		}
		let starved = harness.validate_child(child_pid);
		for fd in held {
			// SAFETY: every descriptor here came from the `open` above and is closed
			// exactly once.
			unsafe { libc::close(fd) };
		}
		// SAFETY: restores the soft limit read at entry, which the hard limit admits.
		unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const restore) };

		let _ = child.kill();
		let _ = child.wait();
		// The same arm from the other side: unpinnable because it is gone, which
		// is churn and must leave the walk whole.
		let reaped = harness.validate_child(child_pid);

		assert_eq!(queried, 0, "the descriptor limit must be readable");
		assert_eq!(lowered, 0, "the descriptor limit must be lowerable");
		assert!(whole, "a child that can be pinned leaves nothing out");
		assert_eq!(collected.len(), 1, "and is collected");
		assert!(
			!starved.1,
			"a live child the host refuses to pin is a subtree the walk cannot see, not an absence"
		);
		assert!(starved.0.is_empty(), "and it is not collected either");
		assert!(
			reaped.1,
			"a child unpinnable because it has gone is churn, and leaves the walk whole"
		);
		assert!(reaped.0.is_empty(), "and is not a target");
	}

	/// A walk that could not read `/proc` at all has to say so, and every
	/// consumer above it has to act on that.
	///
	/// The same descriptor starvation as above, but aimed one level up: a whole
	/// walk reads `/proc/<pid>/stat` for its own root before it enumerates
	/// anything, so a starved table stops it there, with `/proc/<pid>` still
	/// visible. That reaches the producer's live-root arm, its propagation into
	/// the recursion, and the public refusal built on both.
	///
	/// Process-wide state: safe under `cargo nextest`, which gives every test
	/// its own process. Do not move this to a thread-per-test runner.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_walk_that_cannot_read_proc_refuses_rather_than_answering_short() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("pin the harness");

		let (_, whole) = harness.signalable_descendants_checked(&host_protected_pids());
		let allowed = harness.descendants().is_ok();

		let mut limit = libc::rlimit { rlim_cur: 0, rlim_max: 0 };
		// SAFETY: `getrlimit` writes one `rlimit` through the pointer given.
		unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &raw mut limit) };
		let restore = limit;
		limit.rlim_cur = 64;
		// SAFETY: `setrlimit` reads one `rlimit` through the pointer given; lowering
		// the soft limit below the hard limit is always permitted.
		unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const limit) };
		let mut held = Vec::new();
		loop {
			// SAFETY: `open` reads the NUL-terminated literal and returns a new
			// descriptor this loop owns and closes below.
			let fd = unsafe { libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY) };
			if fd < 0 {
				break;
			}
			held.push(fd);
		}
		let enumerated = harness.inner.children_checked().1;
		let starved = harness.signalable_descendants_checked(&host_protected_pids());
		let refused = harness.descendants().is_err();
		for fd in held {
			// SAFETY: every descriptor here came from the `open` above and is closed
			// exactly once.
			unsafe { libc::close(fd) };
		}
		// SAFETY: restores the soft limit read at entry, which the hard limit admits.
		unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &raw const restore) };

		let _ = child.kill();
		let _ = child.wait();

		assert!(whole, "an unstarved walk of a live tree is whole");
		assert!(allowed, "and is handed to the caller");
		assert!(!enumerated, "a root whose own `/proc` will not read is a gap at the producer");
		assert!(!starved.1, "which the walk above it carries rather than dropping");
		assert!(refused, "and the public walk refuses rather than answering short");
	}

	/// The same boundary at the arm that fires constantly: an unreaped child is
	/// listed, pinnable, and not running. It needs no signal and has already
	/// handed its own children on, so leaving it out costs nothing — but
	/// counting it as a gap would make a walk partial every time an ordinary
	/// tree loses a member, which is always.
	#[cfg(target_os = "linux")]
	#[test]
	fn an_unreaped_child_is_not_a_gap() {
		let mut child = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg("exit 0")
			.spawn()
			.expect("spawn a child that exits at once");
		let pinned =
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child");
		// Deliberately not reaped: the zombie is still listed as our child.
		let mut zombie = false;
		for _ in 0..500 {
			if pinned.status() == ProcessStatus::Exited {
				zombie = true;
				break;
			}
			std::thread::sleep(Duration::from_millis(10));
		}

		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("pin the harness");
		let (descendants, complete) = harness.signalable_descendants_checked(&host_protected_pids());
		let listed = descendants
			.iter()
			.any(|descendant| descendant.pid() == pinned.pid());
		child.wait().expect("reap the child");

		assert!(zombie, "the child must have exited before the walk runs");
		assert!(complete, "an unreaped child is churn, not a subtree the walk could not see");
		assert!(!listed, "and it is not a signal target either");
	}

	/// The other half of the completeness signal, and the half with a reachable
	/// trigger: a process that has exited has no reachable children, and saying
	/// so is a whole answer rather than a gap. Reading ordinary churn as a gap
	/// would make every termination of an already-exited root refuse, which
	/// costs the signal all of its meaning.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_reaped_process_reports_no_children_and_no_gap() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let pinned =
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child");
		child.kill().expect("kill the child");
		child.wait().expect("reap the child");

		let (children, enumerated) = pinned.inner.children_checked();
		let (descendants, complete) = pinned.signalable_descendants_checked(&host_protected_pids());

		assert!(children.is_empty(), "a reaped process has no reachable children");
		assert!(enumerated, "and having none is an answer, not a failure to look");
		assert!(descendants.is_empty(), "nor any reachable descendants");
		assert!(complete, "so a walk rooted at it is whole rather than partial");
	}

	/// The mirror of the defect the identity key fixed: charging the cap for a
	/// process already recorded reports a walk partial that missed nothing.
	/// A re-sighting costs the number nothing — that process is in `out` and
	/// its children were walked from it.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_resighted_identity_does_not_spend_the_per_pid_budget() {
		let (corpse, live_pin, mut live) = recycled_pid_pair();
		let self_pid = i32::try_from(std::process::id()).expect("self pid fits in i32");
		let harness = Process::from_pid(self_pid).expect("pin the harness");
		// The number's budget is full, and the live child's own identity is one of
		// the entries holding it — exactly what a walk that already recorded the
		// child and meets it again looks like.
		let mut recorded =
			stale_generations(&corpse, &live_pin, platform::Process::IDENTITIES_PER_PID - 1);
		recorded.push(live_pin.clone());

		let (found, complete) = harness.descendants_after_seeing(recorded);
		let followed = found
			.iter()
			.any(|descendant| descendant.is_same_process(&live_pin));
		let _ = live.kill();
		let _ = live.wait();

		assert!(complete, "meeting a process the walk already recorded leaves nothing out");
		assert!(!followed, "and it is not collected twice");
	}

	/// The refusal that stands between a short walk and a waiter reporting the
	/// tree gone. Its two siblings — the walk saying so, and a plan conjoining
	/// it — are covered separately, and this PR is a record of one reader of a
	/// signal being fixed while its siblings were not.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_partial_walk_cannot_build_a_hard_kill_wave() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let root =
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child");
		let protected = host_protected_pids();

		// Refused first: it bails before signalling anything, so the root is still
		// there for the accepting call to prove the walk's own report is the only
		// difference between the two.
		let refused = root.hard_kill_walked_tree(Vec::new(), false, &protected);
		let accepted = root.hard_kill_walked_tree(Vec::new(), true, &protected);
		let _ = child.kill();
		let _ = child.wait();

		let refusal = match refused {
			Ok(_) => panic!("a partial walk must not build a wave"),
			Err(error) => error.to_string(),
		};
		assert!(
			refusal.contains("could not be completed"),
			"the refusal must name the incomplete walk, got: {refusal}"
		);
		assert!(accepted.is_ok(), "a walk that finished still builds its wave");
	}

	/// The tree sweep's own copy of the ownership proof. `hard_kill_own_group`
	/// refuses an unattributable group with a live member in it; this path
	/// scanned the same members and used to drop them on the floor, so a
	/// same-group survivor outside the descendant walk was neither signalled
	/// nor waited on and the tree reported itself gone over it.
	///
	/// Reached through the split rather than through `hard_kill_walked_tree`,
	/// because the arm only runs where `pidfd_send_signal` carries no
	/// process-group scope, which is a kernel capability cached process-wide
	/// and not something a test on a scoped host can turn off. So this covers
	/// the decision and not the one line that delegates to it; that line is
	/// unexecutable here for the same reason the arm is.
	#[cfg(target_os = "linux")]
	#[test]
	fn an_unattributable_group_cannot_drop_its_live_members() {
		let (mut leader, leader_pin, survivor) = spawn_own_group_with_survivor();
		let pgid = leader_pin.pid();
		// Reaped, so the number is all that is left of the group: `leads_group`
		// can no longer match an identity against it and ownership is unprovable.
		leader.wait().expect("reap the leader");
		assert!(
			Process::from_pid(pgid).is_none(),
			"the leader's pid must be unoccupied for ownership to be unprovable"
		);
		assert_eq!(
			survivor.status(),
			ProcessStatus::Running,
			"the survivor must outlive its leader for this to test anything"
		);

		let mut processes = Vec::new();
		let refused = leader_pin.extend_with_unattributable_group(
			pgid,
			vec![survivor.clone()],
			true,
			&mut processes,
		);
		// Checked after the call, not only before it: a refusal that killed the
		// member on its way out would still satisfy an assertion made earlier.
		let survivor_after = survivor.status();

		let _ = survivor.inner.kill(KILL_SIGNAL);
		let cleaned = wait_until_exited(&survivor, Duration::from_secs(5));

		let refusal = match refused {
			Ok(()) => panic!("an unprovable group with a live member must not be swept silently"),
			Err(error) => error.to_string(),
		};
		assert!(
			refusal.contains("cannot be proven to still be ours"),
			"the refusal must name the missing ownership proof, got: {refusal}"
		);
		assert!(
			processes.is_empty(),
			"a refusal contributes no targets, so nothing can read it as a partial sweep"
		);
		assert_eq!(
			survivor_after,
			ProcessStatus::Running,
			"a refusal reports that nothing was swept, so it must not have swept anything"
		);
		assert!(cleaned, "the survivor must not outlive the test");
	}

	/// A plan whose descendant walk stopped short cannot report a completed
	/// termination, for the same reason an unattributable group cannot: the
	/// process the walk left out is in neither the signalled set nor the wait,
	/// so the ones that did go quiet say nothing at all about it.
	#[cfg(target_os = "linux")]
	#[tokio::test]
	async fn a_partial_descendant_walk_is_not_a_completed_termination() {
		let mut child = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let root =
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child");
		let plan = |descendants_complete: bool| TerminationPlan {
			root: root.clone(),
			process_group: None,
			group_leader: None,
			descendants: Vec::new(),
			descendants_complete,
			protected: host_protected_pids(),
			live_at_capture: true,
		};

		let truncated = plan(false)
			.terminate(-1, 5_000, CancelToken::default())
			.await;
		// The same plan over the same, now-dead root: whatever the walk reported is
		// the only thing separating these two answers.
		let whole = plan(true)
			.terminate(-1, 5_000, CancelToken::default())
			.await;
		let _ = child.kill();
		let _ = child.wait();

		assert!(
			!truncated.expect("terminate on a truncated walk"),
			"a termination built on a partial walk must not report the tree gone"
		);
		assert!(
			whole.expect("terminate on a whole walk"),
			"a complete walk over an exited tree is a completed termination"
		);
	}

	/// The spawn registry records one pinned handle per spawn, so a run that
	/// outlives its own short-lived children records the corpse and, later, the
	/// live process that took its number. Keyed on the pid the live one never
	/// enters the target set, and no cancellation wave reaches it.
	#[cfg(target_os = "linux")]
	#[test]
	fn termination_targets_keep_the_live_holder_of_a_reused_pid() {
		let (corpse, live_pin, mut live) = recycled_pid_pair();

		let mut targets = TerminationTargets::new();
		targets.add_process(corpse.clone());
		targets.add_process(live_pin.clone());
		// The same reference twice is still one target: identity, not arrival.
		targets.add_process(corpse);
		let covered = targets
			.processes
			.iter()
			.any(|target| target.is_same_process(&live_pin));
		let recorded = targets.processes.len();
		let _ = live.kill();
		let _ = live.wait();

		assert!(covered, "the live holder of a reused pid must be a termination target");
		assert_eq!(recorded, 2, "one target per identity, and the corpse is not recorded twice");
	}

	/// The numeric group signals are guarded by this predicate, so it has to
	/// tell a pid's current occupant apart from the reference pinned when the
	/// group was still ours, and must not read an unallocated pid as a proof of
	/// ownership: a reaped leader and a recycled-then-leaderless group are the
	/// same observation from there.
	#[cfg(unix)]
	#[test]
	fn group_ownership_predicate_tracks_the_pids_current_occupant() {
		let mut first = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn first");
		let mut second = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn second");
		let pin = |child: &std::process::Child| {
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child")
		};
		let first_pin = pin(&first);
		let second_pin = pin(&second);
		let owned = group_still_led_by(first_pin.pid(), Some(&first_pin));
		let foreign = group_still_led_by(first_pin.pid(), Some(&second_pin));
		let anchorless = group_still_led_by(first_pin.pid(), None);
		// No task can hold `i32::MAX`, and an unoccupied pid is exactly the state a
		// reaped leader leaves behind, which is what must not pass.
		let unallocated = group_still_led_by(i32::MAX, Some(&first_pin));
		let _ = first.kill();
		let _ = first.wait();
		let _ = second.kill();
		let _ = second.wait();

		assert!(owned, "the pinned leader still occupies its own pid");
		assert!(!foreign, "a pid held by a different process is not ours");
		assert!(!anchorless, "an occupied pid with no pinned anchor cannot be proved ours");
		assert!(!unallocated, "an unoccupied pid proves nothing about who holds the group");
	}

	/// Poll until `target` is no longer running, so a test's own cleanup is
	/// something it verified rather than something it asked for.
	#[cfg(unix)]
	fn wait_until_exited(target: &Process, within: Duration) -> bool {
		let deadline = std::time::Instant::now() + within;
		while target.status() == ProcessStatus::Running {
			if std::time::Instant::now() > deadline {
				return false;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
		true
	}

	/// A leader whose group must outlive it, with one survivor that keeps the
	/// pgid populated. The leader is deliberately left unreaped so the caller
	/// decides which of the two observable states it tests.
	#[cfg(unix)]
	fn spawn_own_group_with_survivor() -> (std::process::Child, Process, Process) {
		use std::{io::Read, os::unix::process::CommandExt};

		// `process_group(0)` makes the child its own group leader, so its pgid is
		// its pid — the shape `hard_kill_own_group` is written for. The survivor
		// drops the inherited stdout so reading to EOF means the leader has exited.
		let mut leader = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg("sleep 30 >/dev/null 2>&1 & echo $!")
			.process_group(0)
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("spawn group leader");
		let leader_pin =
			Process::from_pid(i32::try_from(leader.id()).expect("leader pid")).expect("pin leader");
		let mut reported = String::new();
		leader
			.stdout
			.take()
			.expect("leader stdout")
			.read_to_string(&mut reported)
			.expect("read survivor pid");
		let survivor =
			Process::from_pid(reported.trim().parse().expect("survivor pid")).expect("pin survivor");
		(leader, leader_pin, survivor)
	}

	/// The group fallback exists for a leader that is already gone, and the one
	/// state in which its pgid is still attributable is the unreaped one: the
	/// leader is still a task, so the kernel cannot have released the number and
	/// its identity settles ownership.
	#[cfg(unix)]
	#[tokio::test]
	async fn own_group_is_swept_while_its_unreaped_leader_still_holds_the_pgid() {
		let (mut leader, leader_pin, survivor) = spawn_own_group_with_survivor();
		assert_eq!(
			leader_pin.status(),
			ProcessStatus::Exited,
			"the leader must be gone before the fallback is exercised"
		);

		let swept = leader_pin
			.hard_kill_own_group()
			.expect("an unreaped leader still proves the group is ours")
			.wait(Duration::from_secs(5), CancelToken::default())
			.await;

		let survivor_status = survivor.status();
		let _ = survivor.inner.kill(KILL_SIGNAL);
		let _ = leader.wait();
		assert!(swept.expect("wait for the swept group"), "the group must be reported gone");
		assert_eq!(survivor_status, ProcessStatus::Exited, "the survivor must be swept");
	}

	/// The accessor callers gate on has to answer for the kernel, not restate
	/// its own premise, and it has to answer for the case it is read in: a
	/// group whose leader has already been reaped. A live leader proves nothing
	/// here — its pid still holds the group, so the number alone would do.
	#[cfg(target_os = "linux")]
	#[test]
	fn group_outlives_its_leader_agrees_with_the_kernel_after_a_reap() {
		assert_eq!(
			group_outlives_its_leader(),
			kernel_reaches_a_reaped_leaders_group(),
			"the gate callers read must match what the kernel does with a group whose leader is gone"
		);
	}

	/// No pidfd, so no scope, and the accessor has to say so rather than
	/// inherit an answer from the Linux branch.
	#[cfg(all(unix, not(target_os = "linux")))]
	#[test]
	fn group_never_outlives_its_leader_without_pidfds() {
		assert!(
			!group_outlives_its_leader(),
			"a platform with no pidfd cannot reach a reaped leader's group"
		);
	}

	/// Whether this kernel reaches a process group through a pidfd retained
	/// from before its leader was reaped.
	///
	/// Deliberately built the *other* way round from the production probe,
	/// which asks the syscall's argument validation on a deliberately closed
	/// descriptor and needs no process at all. Re-deriving it that way would
	/// not be independence — both copies would carry the same premise.
	///
	/// Everything that is setup rather than measurement asserts instead of
	/// answering `false`: a group that could not be built agrees with a gate
	/// that is wrong in the opposite direction, which is the one way this
	/// corroboration could pass while establishing nothing.
	#[cfg(target_os = "linux")]
	fn kernel_reaches_a_reaped_leaders_group() -> bool {
		const SYS_PIDFD_OPEN: libc::c_long = 434;
		const PROCESS_GROUP: libc::c_uint = 4;

		let (mut leader, leader_pin, survivor) = spawn_own_group_with_survivor();
		let pgid = leader_pin.pid();
		// SAFETY: `pidfd_open` takes the pid by value and reads no caller-owned
		// memory. Flags are zero, which is valid. Taken while the leader is still a
		// task, because that is the descriptor the production path retains.
		let opened = unsafe { libc::syscall(SYS_PIDFD_OPEN, pgid, 0 as libc::c_uint) };
		let open_error = std::io::Error::last_os_error();

		let reaped = leader.wait().is_ok();
		let leader_gone = Process::from_pid(pgid).is_none();
		let survivor_group = survivor.group_id();
		// SAFETY: integer identifiers by value; the null signal delivers nothing.
		let group_alive = unsafe { libc::kill(-pgid, 0) == 0 };

		let scoped = (opened >= 0).then(|| {
			let pidfd = opened as libc::c_int;
			// SAFETY: `pidfd` came from `pidfd_open` above and is closed here exactly
			// once. A null `siginfo_t` makes the kernel synthesize the same metadata
			// as `kill(2)`, and signal 0 delivers nothing.
			unsafe {
				let ret = libc::syscall(
					libc::SYS_pidfd_send_signal,
					pidfd,
					0,
					std::ptr::null::<libc::siginfo_t>(),
					PROCESS_GROUP,
				);
				let errno = std::io::Error::last_os_error().raw_os_error().unwrap_or(0);
				libc::close(pidfd);
				(ret, errno)
			}
		});

		let _ = survivor.inner.kill(KILL_SIGNAL);

		assert!(opened >= 0, "pidfd_open on a live group leader failed: {open_error}");
		assert!(reaped, "the leader has to be reaped for this to measure the post-reap case");
		assert!(
			leader_gone,
			"the reaped leader's pid must be unoccupied, or this measures a live leader instead"
		);
		assert_eq!(
			survivor_group,
			Some(pgid),
			"the survivor has to still carry the group for there to be anything to reach"
		);
		assert!(group_alive, "the group must outlive its leader for this to measure anything");
		match scoped.expect("the scoped call runs whenever the descriptor opened") {
			(0, _) => true,
			// The flags are validated before the descriptor is looked up, so this is
			// the scope being refused rather than anything about this group.
			(_, libc::EINVAL) => false,
			(_, errno) => panic!(
				"pidfd_send_signal on a retained group pidfd answered neither success nor a refused \
				 scope: errno {errno}"
			),
		}
	}

	/// Whether this kernel scopes a pidfd signal to the process group, measured
	/// rather than inferred from a version, because it decides which contract
	/// the group fallback is held to.
	///
	/// Deliberately built the *other* way round from the production probe, which
	/// asks the syscall's argument validation and needs no process at all. This
	/// one creates a real group for the purpose, establishes that it is live
	/// through `kill(-pgid, 0)`, and requires the scoped call to resolve it
	/// through its own leader's pidfd. Re-implementing the same rule would not
	/// be independence — both copies would carry the same premise, and a
	/// premise that is wrong would make them agree incorrectly.
	///
	/// Known and deliberate: a setup that fails answers `false` here rather than
	/// failing, which its callers read as an uncapable kernel and hold the group
	/// fallback to the weaker contract. That is the safe direction for them, but
	/// it is not safe for a caller corroborating the capability itself — see
	/// `kernel_reaches_a_reaped_leaders_group`, which asserts instead.
	#[cfg(target_os = "linux")]
	fn kernel_scopes_pidfd_signals_to_groups() -> bool {
		use std::os::unix::process::CommandExt;

		const SYS_PIDFD_OPEN: libc::c_long = 434;
		const PROCESS_GROUP: libc::c_uint = 4;

		let Ok(mut leader) = std::process::Command::new("sleep")
			.arg("30")
			.process_group(0)
			.spawn()
		else {
			return false;
		};
		let Ok(pgid) = i32::try_from(leader.id()) else {
			let _ = leader.kill();
			let _ = leader.wait();
			return false;
		};
		// SAFETY: every call takes scalars by value; the null signal delivers
		// nothing, and the descriptor is closed before returning.
		let resolved = unsafe {
			libc::kill(-pgid, 0) == 0 && {
				let pidfd = libc::syscall(SYS_PIDFD_OPEN, pgid, 0 as libc::c_uint);
				pidfd >= 0 && {
					let ret = libc::syscall(
						libc::SYS_pidfd_send_signal,
						pidfd as libc::c_int,
						0,
						std::ptr::null::<libc::siginfo_t>(),
						PROCESS_GROUP,
					);
					libc::close(pidfd as libc::c_int);
					ret == 0
				}
			}
		};
		let _ = leader.kill();
		let _ = leader.wait();
		resolved
	}

	/// Non-Linux Unix has no pidfd at all, so the scope can never be available.
	#[cfg(all(unix, not(target_os = "linux")))]
	const fn kernel_scopes_pidfd_signals_to_groups() -> bool {
		false
	}

	/// Carries the verdict path into the re-entrant child of the test below.
	#[cfg(target_os = "linux")]
	const SCOPE_CHILD_ENV: &str = "OMP_TEST_GROUP_SCOPE_VERDICT";

	/// Detection must not be a question about the caller's own process group.
	/// A hosted process usually does not lead its group, and a long-lived one
	/// has usually outlived the leader entirely — and a reaped leader's pid
	/// answers `ESRCH` to `pidfd_open` however capable the kernel is. Probing
	/// through that leader therefore reported "unsupported" and silently gave
	/// up the capability. Exercised in a grandchild whose group leader has been
	/// reaped, with a cache that has never been written.
	#[cfg(target_os = "linux")]
	#[test]
	fn group_scope_detection_survives_a_caller_whose_group_leader_is_gone() {
		use std::os::unix::process::CommandExt;

		if let Some(verdict_path) = std::env::var_os(SCOPE_CHILD_ENV) {
			// SAFETY: both calls read the caller's own identifiers.
			let (pid, pgid) = unsafe { (libc::getpid(), libc::getpgid(0)) };
			let detected = platform::pidfd_group_scope_supported();
			let expected = kernel_scopes_pidfd_signals_to_groups();
			let verdict = if pid == pgid {
				format!("the child leads its own group ({pid}), so nothing is under test")
			} else if Process::from_pid(pgid).is_some() {
				format!("the group leader {pgid} is still openable, so nothing is under test")
			} else if detected != expected {
				format!("detection said {detected} where the kernel says {expected}")
			} else {
				"ok".to_owned()
			};
			let _ = std::fs::write(verdict_path, verdict);
			return;
		}

		let verdict_path = std::env::temp_dir().join(format!(
			"omp-scope-verdict-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |since| since.as_nanos())
		));
		let _ = std::fs::remove_file(&verdict_path);
		let binary = std::env::current_exe().expect("path to the test binary");
		// The shell leads a group of its own and exits at once, so the test binary
		// it leaves behind runs in a group whose leader is reaped by the `status()`
		// below. Filtered by substring rather than `--exact`, which would want the
		// fully qualified path this name does not carry; the name is unique.
		let script = format!(
			"{} group_scope_detection_survives_a_caller_whose_group_leader_is_gone --nocapture \
			 >/dev/null 2>&1 &",
			binary.display()
		);
		let status = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg(&script)
			.process_group(0)
			.env(SCOPE_CHILD_ENV, &verdict_path)
			.status()
			.expect("run the group leader");
		assert!(status.success(), "the intermediate group leader must exit cleanly");

		let deadline = std::time::Instant::now() + Duration::from_secs(30);
		let verdict = loop {
			if let Ok(verdict) = std::fs::read_to_string(&verdict_path)
				&& !verdict.is_empty()
			{
				break verdict;
			}
			assert!(
				std::time::Instant::now() < deadline,
				"the orphaned child never reported a verdict"
			);
			std::thread::sleep(Duration::from_millis(20));
		};
		let _ = std::fs::remove_file(&verdict_path);
		assert_eq!(verdict, "ok", "detection must hold where the caller's group has no leader");
	}

	/// `EINVAL` is an answer about one call, not about the kernel: an invalid
	/// signal produces it on a pidfd whose group resolves perfectly well. It has
	/// to establish nothing for that call, and it must not cost the scope
	/// afterwards — the detection cache is fed only by its own fixed probe.
	#[cfg(target_os = "linux")]
	#[test]
	fn a_rejected_signal_establishes_nothing_and_leaves_the_scope_usable() {
		use std::os::unix::process::CommandExt;

		let mut leader = std::process::Command::new("sleep")
			.arg("30")
			.process_group(0)
			.spawn()
			.expect("spawn group leader");
		let pgid = i32::try_from(leader.id()).expect("leader pid");
		let pinned = Process::from_pid(pgid).expect("pin leader");
		let refused = pinned.signal_own_group(pgid, i32::MAX);
		let after = pinned.probe_own_group(pgid);
		let _ = leader.kill();
		let _ = leader.wait();

		assert_eq!(
			refused,
			GroupScope::Unresolved,
			"a signal the kernel rejects settles nothing about the group"
		);
		let expected = if kernel_scopes_pidfd_signals_to_groups() {
			GroupScope::Signalled
		} else {
			GroupScope::Unresolved
		};
		assert_eq!(after, expected, "one rejected signal must not disable the scope");
	}

	/// A reaped leader leaves its pgid number unattributable, but not the group
	/// itself: a retained pidfd still names the `struct pid` the survivors
	/// carry, and the kernel releases that number only once nothing holds it.
	/// So where the pidfd carries a process-group scope the group is reachable
	/// with no ownership proof at all — and where it does not, the number is
	/// all there is and the sweep has to refuse instead of guessing.
	#[cfg(unix)]
	#[tokio::test]
	async fn own_group_is_swept_through_the_pinned_identity_after_its_leader_is_reaped() {
		let scoped = kernel_scopes_pidfd_signals_to_groups();
		let (mut leader, leader_pin, survivor) = spawn_own_group_with_survivor();
		leader.wait().expect("reap the leader");
		assert!(
			Process::from_pid(leader_pin.pid()).is_none(),
			"the reaped leader's pid must be unoccupied for this to test anything"
		);

		let swept = leader_pin.hard_kill_own_group();

		let outcome = match swept {
			Ok(waiter) => Some(
				waiter
					.wait(Duration::from_secs(5), CancelToken::default())
					.await,
			),
			Err(error) => {
				assert!(
					error
						.to_string()
						.contains("cannot be proven to still be ours"),
					"a refusal must name the missing ownership proof, got {error}"
				);
				None
			},
		};
		let survivor_status = survivor.status();
		let _ = survivor.inner.kill(KILL_SIGNAL);
		if scoped {
			assert!(
				outcome
					.expect("a pidfd-scoped kernel needs no ownership proof")
					.expect("wait for the swept group"),
				"the group must be reported gone"
			);
			assert_eq!(
				survivor_status,
				ProcessStatus::Exited,
				"the survivor must be swept through the retained identity"
			);
		} else {
			assert!(outcome.is_none(), "without the scope the number cannot be attributed");
			assert_eq!(
				survivor_status,
				ProcessStatus::Running,
				"an unattributable group must be left running, not killed member by member"
			);
		}
	}

	/// Read a value a shell published by renaming it into place.
	///
	/// A redirection creates its file before anything is written to it, so mere
	/// existence proves nothing and an immediate read can see an empty one. The
	/// scripts here write to a sibling and `mv` it, which is a rename within one
	/// directory and therefore atomic; this waits for content rather than for
	/// the name to appear.
	#[cfg(unix)]
	fn read_published(path: &std::path::Path, within: Duration) -> Option<String> {
		let deadline = std::time::Instant::now() + within;
		loop {
			if let Ok(text) = std::fs::read_to_string(path)
				&& !text.trim().is_empty()
			{
				return Some(text);
			}
			if std::time::Instant::now() >= deadline {
				return None;
			}
			std::thread::sleep(Duration::from_millis(5));
		}
	}

	/// A process group does not only shrink while it is being terminated: a
	/// surviving member can fork into it after the plan was captured, and such a
	/// member is in no walk rooted at the root either. Whatever reaches it — the
	/// hard wave's group signal, or the survivor scan that follows it — has to
	/// leave it dead and has to have accounted for it.
	#[cfg(unix)]
	#[tokio::test]
	async fn hard_wave_reaches_a_member_that_joined_the_group_after_capture() {
		use std::{
			io::{BufRead, BufReader, Write},
			os::unix::process::CommandExt,
		};

		// Digits only: the path is re-parsed by the shells that write it.
		let arrival = std::env::temp_dir().join(format!(
			"omp-group-arrival-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |since| since.as_nanos())
		));
		let _ = std::fs::remove_file(&arrival);
		// The member parks on the inherited stdin rather than a timer, so its fork
		// into the group is released by this test after the capture instead of being
		// timed to land inside a window. The root waits for the intermediate subshell
		// to retire and ignores TERM — SIG_IGN survives the exec — before announcing,
		// so readiness means the member is orphaned and the grace wait will run its
		// full length once the waves start.
		let member_file = arrival.with_extension("member");
		let ack = arrival.with_extension("ack");
		let _ = std::fs::remove_file(&member_file);
		let _ = std::fs::remove_file(&ack);
		let script = format!(
			r#"exec 3<&0; ( /bin/sh -c 'trap "" TERM; echo $$ >{member}.tmp; mv {member}.tmp {member}; read release <&3 || exit 9; echo ok >{ack}.tmp; mv {ack}.tmp {ack}; /bin/sh -c "echo \$\$ >{arrival}.tmp; mv {arrival}.tmp {arrival}; exec sleep 30" >/dev/null 2>&1 & exec sleep 30' & ) ; wait; while [ ! -f {member} ]; do sleep 0.01; done; trap "" TERM; echo rooted; exec sleep 30"#,
			arrival = arrival.display(),
			ack = ack.display(),
			member = member_file.display()
		);
		let mut root = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg(&script)
			.process_group(0)
			.stdin(std::process::Stdio::piped())
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("spawn root");
		let mut rooted = String::new();
		BufReader::new(root.stdout.take().expect("root stdout"))
			.read_line(&mut rooted)
			.expect("read root readiness");
		// One line, from the root, emitted only after the intermediate subshell is
		// reaped, after the member has recorded itself, and after the root's own
		// TERM-ignore, so there is nothing left to race.
		assert_eq!(rooted.trim(), "rooted", "the root announces only once everything is in place");
		let member = Process::from_pid(
			read_published(&member_file, Duration::from_secs(5))
				.expect("member pid file")
				.trim()
				.parse()
				.expect("member pid"),
		)
		.expect("pin member");
		let plan = Process::from_pid(i32::try_from(root.id()).expect("root pid"))
			.expect("pin root")
			.capture_termination(true);
		assert!(
			!plan
				.descendants
				.iter()
				.any(|captured| captured.is_same_process(&member)),
			"the member has to be outside the capture for the group to be the only route"
		);

		assert!(
			!std::fs::exists(&ack).unwrap_or(false),
			"the member must still be waiting on the release at capture time"
		);
		// Released only now, so the arrival provably post-dates the capture. The
		// member reads through an inherited descriptor rather than stdin, which a
		// backgrounded command has redirected from `/dev/null`, and acknowledges
		// before forking so a read that failed cannot pass for one that succeeded.
		root
			.stdin
			.take()
			.expect("root stdin")
			.write_all(b"go\n")
			.expect("release the member");
		read_published(&ack, Duration::from_secs(5)).expect("the member never acknowledged release");
		let arrived = Process::from_pid(
			read_published(&arrival, Duration::from_secs(5))
				.expect("the member never forked into the group")
				.trim()
				.parse()
				.expect("arrival pid"),
		)
		.expect("pin the arrival");
		assert_eq!(arrived.group_id(), Some(plan.root.pid()), "the arrival has to be in the group");

		let terminated = plan.terminate(500, 5_000, CancelToken::default()).await;

		let arrival_status = arrived.status();
		let _ = arrived.inner.kill(KILL_SIGNAL);
		let _ = member.inner.kill(KILL_SIGNAL);
		let _ = root.kill();
		let _ = root.wait();
		let _ = std::fs::remove_file(&arrival);
		let _ = std::fs::remove_file(&member_file);
		let _ = std::fs::remove_file(&ack);
		assert_eq!(
			arrival_status,
			ProcessStatus::Exited,
			"a member that joined the group after capture must not outlive the waves"
		);
		assert!(terminated.expect("terminate the captured tree"), "the tree must be reported gone");
	}

	/// The polite wave's group signal is the only thing that can reach a member
	/// the capture could not name, so it is not interchangeable with the
	/// per-process signals: the hard wave only ever sends `KILL`, which no
	/// handler can record. The marker is therefore the only evidence that the
	/// group itself was signalled politely, and it does not depend on timing.
	#[cfg(unix)]
	#[tokio::test]
	async fn polite_group_wave_reaches_a_member_the_capture_cannot_see() {
		use std::{
			io::{BufRead, BufReader},
			os::unix::process::CommandExt,
		};

		// Digits only: the trap body is re-parsed by the shell when it fires, so a
		// name carrying shell metacharacters would make the handler a syntax error.
		let marker = std::env::temp_dir().join(format!(
			"omp-group-term-{}-{}",
			std::process::id(),
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |since| since.as_nanos())
		));
		let _ = std::fs::remove_file(&marker);
		// The member is parked in a sleep loop rather than `exec`ing one, so its
		// shell can still run a TERM handler. The root waits for the intermediate
		// subshell to retire and installs its own TERM-ignore before announcing, so
		// readiness means both that the member is orphaned and that the grace wait
		// will not end the instant the root dies — which would otherwise let the
		// hard wave's KILL beat the handler.
		let member_file = marker.with_extension("member");
		let _ = std::fs::remove_file(&member_file);
		let script = format!(
			r#"( /bin/sh -c 'trap "echo reached >{marker}.tmp; mv {marker}.tmp {marker}; exit 0" TERM; echo $$ >{member}.tmp; mv {member}.tmp {member}; while :; do sleep 0.05; done' & ) ; wait; while [ ! -f {member} ]; do sleep 0.01; done; trap "" TERM; echo rooted; exec sleep 30"#,
			marker = marker.display(),
			member = member_file.display()
		);
		let mut root = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg(&script)
			.process_group(0)
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("spawn root");
		let mut rooted = String::new();
		BufReader::new(root.stdout.take().expect("root stdout"))
			.read_line(&mut rooted)
			.expect("read root readiness");
		// One line, from the root, emitted only after the intermediate subshell is
		// reaped, after the member has recorded itself, and after the root's own
		// TERM-ignore, so there is nothing left to race.
		assert_eq!(rooted.trim(), "rooted", "the root announces only once everything is in place");
		let member = Process::from_pid(
			read_published(&member_file, Duration::from_secs(5))
				.expect("member pid file")
				.trim()
				.parse()
				.expect("member pid"),
		)
		.expect("pin member");
		let plan = Process::from_pid(i32::try_from(root.id()).expect("root pid"))
			.expect("pin root")
			.capture_termination(true);
		assert!(
			!plan
				.descendants
				.iter()
				.any(|captured| captured.is_same_process(&member)),
			"the member has to be outside the capture for the group to be the only route"
		);

		let terminated = plan.terminate(500, 5_000, CancelToken::default()).await;

		let reached = std::fs::read_to_string(&marker).unwrap_or_default();
		let _ = member.inner.kill(KILL_SIGNAL);
		let _ = root.kill();
		let _ = root.wait();
		let _ = std::fs::remove_file(&marker);
		let _ = std::fs::remove_file(&member_file);
		assert_eq!(
			reached.trim(),
			"reached",
			"the polite wave has to signal the group, not only the captured processes"
		);
		assert!(terminated.expect("terminate the captured tree"), "the tree must be reported gone");
	}

	/// Every consumer of the survivor list reads "empty" as "the group is
	/// accounted for", so a group that cannot be attributed must not answer with
	/// an empty list. Modelled with the leader handle absent, which is what
	/// capture produces when the group's leader is already gone — the same state
	/// a pre-6.9 kernel is left in once the leader is reaped.
	#[cfg(unix)]
	#[tokio::test]
	async fn unattributable_group_is_not_reported_as_a_completed_termination() {
		use std::{
			io::{BufRead, BufReader},
			os::unix::process::CommandExt,
		};

		// The survivor is orphaned before capture, so it appears in no walk rooted
		// at the root and only the group can still see it, and it ignores TERM so
		// the polite wave cannot retire it by accident.
		let mut root = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg(r#"( /bin/sh -c 'trap "" TERM; echo $$; exec sleep 30' & ) ; exec sleep 30"#)
			.process_group(0)
			.stdout(std::process::Stdio::piped())
			.spawn()
			.expect("spawn root");
		let mut line = String::new();
		BufReader::new(root.stdout.take().expect("root stdout"))
			.read_line(&mut line)
			.expect("read survivor pid");
		let survivor =
			Process::from_pid(line.trim().parse().expect("survivor pid")).expect("pin survivor");
		let root_pin =
			Process::from_pid(i32::try_from(root.id()).expect("root pid")).expect("pin root");
		let mut plan = root_pin.capture_termination(true);
		assert_eq!(plan.process_group(), Some(root_pin.pid()), "the root must lead its group");
		plan.group_leader = None;

		let terminated = plan.terminate(100, 5_000, CancelToken::default()).await;

		let survivor_status = survivor.status();
		let _ = survivor.inner.kill(KILL_SIGNAL);
		let _ = root.kill();
		let _ = root.wait();
		assert_eq!(
			survivor_status,
			ProcessStatus::Running,
			"the survivor has to outlive the waves for the report to be under test"
		);
		assert!(
			!terminated.expect("terminate the captured tree"),
			"a group that cannot be attributed leaves the tree unaccounted for"
		);
	}

	/// `hard_kill_own_group` signals whatever carries the leader's old pid, so
	/// the pinned identity is the only thing that can tell our own group apart
	/// from one that inherited the number. Re-opening a pid must recognise the
	/// same process, and must never confuse two different ones.
	#[cfg(unix)]
	#[test]
	fn pinned_identity_separates_processes_sharing_nothing_but_a_pid_space() {
		let mut first = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn first");
		let mut second = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn second");
		let pin = |child: &std::process::Child| {
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child")
		};
		let first_pin = pin(&first);
		let second_pin = pin(&second);
		let first_reopened = pin(&first);
		let _ = first.kill();
		let _ = first.wait();
		let _ = second.kill();
		let _ = second.wait();

		assert!(
			first_pin.is_same_process(&first_reopened),
			"re-opening a live pid must recognise the same process"
		);
		assert!(
			!first_pin.is_same_process(&second_pin),
			"two distinct processes must never compare equal"
		);
	}

	/// The union exists so pinned handles survive a rescan that cannot see them,
	/// so an identity-keyed merge must resolve a tie in the pinned handle's
	/// favour rather than swap in the equal-but-rescanned one.
	#[cfg(unix)]
	#[test]
	fn identity_merge_keeps_the_pinned_handle_and_admits_a_distinct_process() {
		let mut first = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn first");
		let mut second = std::process::Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn second");
		let pin = |child: &std::process::Child| {
			Process::from_pid(i32::try_from(child.id()).expect("child pid")).expect("pin child")
		};
		let pinned = pin(&first);
		let rescanned = pin(&first);
		let distinct = pin(&second);
		let mut retained = vec![pinned.clone()];
		extend_by_identity(&mut retained, [rescanned, distinct.clone()]);
		let kept_pinned = retained[0].is_same_process(&pinned);
		let length = retained.len();
		let admitted = retained
			.iter()
			.any(|process| process.is_same_process(&distinct));
		let _ = first.kill();
		let _ = first.wait();
		let _ = second.kill();
		let _ = second.wait();

		assert!(kept_pinned, "the pinned handle must stay in place");
		assert_eq!(length, 2, "an equal identity is dropped and a distinct one admitted");
		assert!(admitted, "a different process must be added even so");
	}

	/// A group member reparented before capture is in neither the root nor the
	/// descendant walk, so the graceful wave must consult the group before it
	/// can report the tree gone.
	#[cfg(unix)]
	#[tokio::test]
	async fn graceful_wave_does_not_report_success_over_a_live_group_member() {
		use std::{
			io::{BufRead, BufReader},
			os::unix::process::CommandExt,
			process::Stdio,
		};

		// The intermediate shell forks the survivor with TERM ignored, reports its
		// pid and exits, orphaning it while it keeps the leader's pgid. The leader
		// then execs a plain sleep, so it dies to the polite signal.
		let mut child = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg(r#"/bin/sh -c 'trap "" TERM; sleep 60 & echo $!' ; exec sleep 60"#)
			.process_group(0)
			.stdout(Stdio::piped())
			.spawn()
			.expect("spawn leader");
		let mut line = String::new();
		BufReader::new(child.stdout.take().expect("leader stdout"))
			.read_line(&mut line)
			.expect("read survivor pid");
		let survivor =
			Process::from_pid(line.trim().parse().expect("survivor pid")).expect("pin survivor");
		let root =
			Process::from_pid(i32::try_from(child.id()).expect("leader pid")).expect("pin leader");
		// The intermediate has to be gone before the capture, or the survivor is
		// still a captured descendant and the group plays no part in the outcome.
		// Waited for rather than assumed: it exits on its own schedule.
		let mut reparented = false;
		for _ in 0..200 {
			let walked = root.descendants().expect("walk the leader's descendants");
			if !walked.iter().any(|d| d.pid() == survivor.pid()) {
				reparented = true;
				break;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		let plan = root.capture_termination(true);
		let captured_survivor = plan.descendants.iter().any(|d| d.pid() == survivor.pid());

		let terminated = plan.terminate(200, 5000, CancelToken::default()).await;

		let survivor_status = survivor.status();
		let _ = survivor.inner.kill(KILL_SIGNAL);
		let _ = child.kill();
		let _ = child.wait();
		assert!(reparented, "the intermediate never left the root's descendant walk");
		assert!(!captured_survivor, "the survivor must be outside the captured descendant set");
		assert!(terminated.expect("terminate plan"), "the tree must be reported gone");
		assert_eq!(
			survivor_status,
			ProcessStatus::Exited,
			"a live group member must keep the graceful wave from reporting success"
		);
	}

	/// The napi binding captures on the calling thread and runs the waves on an
	/// executor. A leader that dies in that hop must not take its group and its
	/// descendants out of reach.
	#[cfg(unix)]
	#[tokio::test]
	async fn captured_plan_terminates_a_tree_whose_leader_dies_before_the_waves_run() {
		use std::{
			io::{BufRead, BufReader},
			os::unix::process::CommandExt,
			process::Stdio,
		};

		// `process_group(0)` reproduces a detached Bun child: the leader leads its
		// own group, and `read` holds it alive until the capture is taken.
		let mut child = std::process::Command::new("/bin/sh")
			.arg("-c")
			.arg("sleep 30 & echo $!; read line")
			.process_group(0)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()
			.expect("spawn leader");
		let mut line = String::new();
		BufReader::new(child.stdout.take().expect("leader stdout"))
			.read_line(&mut line)
			.expect("read descendant pid");
		let descendant =
			Process::from_pid(line.trim().parse().expect("descendant pid")).expect("pin descendant");
		let root =
			Process::from_pid(i32::try_from(child.id()).expect("leader pid")).expect("pin leader");

		let plan = root.capture_termination(true);
		assert_eq!(plan.process_group(), Some(root.pid()), "the leader must lead its own group");

		// The leader exits and is reaped before a single wave has run.
		drop(child.stdin.take());
		let _ = child.wait();
		assert_eq!(root.status(), ProcessStatus::Exited, "the leader must be gone before the waves");

		let terminated = plan.terminate(-1, 5000, CancelToken::default()).await;

		let descendant_status = descendant.status();
		let _ = descendant.inner.kill(KILL_SIGNAL);
		assert!(
			terminated.expect("terminate captured plan"),
			"the captured tree must be reported gone"
		);
		assert_eq!(
			descendant_status,
			ProcessStatus::Exited,
			"a tree captured before the leader died must still be signalled and awaited"
		);
	}

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
		assert!(
			!kill_process_group(1, TERM_SIGNAL),
			"kill_process_group must reject group 1, which `kill(2)` reads as every process the \
			 caller may signal rather than as that group",
		);
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
				.live_descendants_checked()
				.0
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
			"freshly spawned child pid {child_pid} must appear in the descendant walk so the \
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
}
