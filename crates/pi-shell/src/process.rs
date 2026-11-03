//! Cross-platform process tree management.

use std::{collections::HashSet, time::Duration};

use anyhow::Result;
use parking_lot::Mutex;
/// Current state of a process reference.
///
/// Defined in `pi-builtins` alongside the process-table snapshots its process
/// builtins read, and re-exported here so this module — and `pi-natives`
/// through it — keeps one status type for both concerns.
pub use pi_builtins::ProcessStatus;
use pi_builtins::{
	GroupProof, PinnedProcess, SignalWave, SpawnLedger, host_protected_pids, kernel_group_runs,
	signalable_descendants,
};

use crate::cancel::CancelToken;

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner:  PinnedProcess,
	/// The leader of the process group this process was in when it was
	/// opened by pid, pinned then, when that was another process.
	leader: Option<PinnedProcess>,
}

impl Process {
	/// Open a stable process reference from a PID. The leader of the
	/// process group it is in is pinned too, so that a later
	/// [`terminate_tree`](Self::terminate_tree) can still reach that group
	/// through the kernel (Linux 6.9 and later) after the leader is reaped.
	pub fn from_pid(pid: i32) -> Option<Self> {
		let inner = PinnedProcess::from_pid(pid)?;
		let leader = pin_group_leader(&inner);
		Some(Self { inner, leader })
	}

	/// Open stable process references whose executable path matches exactly.
	pub fn from_path(path: String) -> Vec<Self> {
		PinnedProcess::find_by_path(&path)
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
		PinnedProcess::group_id()
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
	/// Sends `TERM_SIGNAL` to every live descendant and the root — and, with
	/// `group`, to the process group the root is in, through that group's
	/// pinned leader: its members are listed and signalled through their own
	/// pins while the leader still runs, and after that the group is reached
	/// only through the kernel's group signal (Linux 6.9 and later) — then
	/// optionally waits up to `graceful_ms` for every process it signalled,
	/// and every group it signalled through the kernel, to be gone before
	/// escalating to `KILL_SIGNAL`. Pass `graceful_ms < 0` to skip the wait
	/// entirely (the polite signal is still emitted). Returns `true` when all
	/// of them are gone by the end of the hard wave's wait window.
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
		wait_for_exit(self, &Reached::default(), timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: PinnedProcess) -> Self {
		Self { inner, leader: None }
	}

	fn signal_tree(&self, signal: i32) -> u32 {
		self.signal_tree_excluding(signal, &host_protected_pids())
	}

	/// Signal this process and its live descendants (children first), skipping
	/// any pid in `protected`, and return how many of them the signal reached.
	/// When this process leads its own group, the group is reached too, which
	/// catches grandchildren reparented to init when their immediate parent
	/// died inside the descendant walk.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		let leader = (self.group_id() == Some(self.pid())).then(|| self.inner.clone());
		let reached = self.signal_wave(signal, leader.as_ref(), &[], protected);
		u32::try_from(reached.pins.len()).unwrap_or(u32::MAX)
	}

	/// The leader to reach this process's current group through: itself when
	/// it leads; the leader pinned when it was opened, when that still leads
	/// its group; else the process holding the group's number now, kept only
	/// if this process still runs in the group after the open: a live member
	/// keeps the number from being reused, so that process is the leader.
	fn group_leader(&self) -> Option<PinnedProcess> {
		let group = self.group_id()?;
		if group == self.pid() {
			return Some(self.inner.clone());
		}
		if let Some(leader) = self.leader.as_ref().filter(|leader| leader.pid() == group) {
			return Some(leader.clone());
		}
		let leader = PinnedProcess::from_pid(group)?;
		(self.group_id() == Some(group)).then_some(leader)
	}

	/// Live descendants with every protected subtree pruned (see
	/// [`signalable_descendants`]).
	fn signalable_descendants(&self, protected: &HashSet<i32>) -> Vec<Self> {
		signalable_descendants(&self.inner, protected)
			.into_iter()
			.map(Self::from_inner)
			.collect()
	}

	/// Sends one wave of `signal` to this process, its live descendants,
	/// `earlier` (processes an earlier wave reached) and, with `leader`, the
	/// group it leads (see [`SignalWave`]). The leader is not reaped by this
	/// process, so it proves its group only while it runs. Returns what the
	/// wave reached.
	fn signal_wave(
		&self,
		signal: i32,
		leader: Option<&PinnedProcess>,
		earlier: &[PinnedProcess],
		protected: &HashSet<i32>,
	) -> Reached {
		let mut wave = SignalWave::new(signal);
		if let Some(leader) = leader {
			wave.group(leader, GroupProof::Running);
		}
		for descendant in self.signalable_descendants(protected) {
			wave.process(&descendant.inner);
		}
		for process in earlier {
			wave.process(process);
		}
		if !protected.contains(&self.pid()) {
			wave.process(&self.inner);
		}
		wave.deliver();
		Reached::from(&wave)
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
		let protected = host_protected_pids();
		// Pinned once, before the first wave, so both waves reach the same
		// group even after the root exits.
		let leader = if group { self.group_leader() } else { None };

		// Polite wave: SIGTERM the group, every live descendant, then the
		// root, each process at most once.
		let reached = self.signal_wave(TERM_SIGNAL, leader.as_ref(), &[], &protected);

		// Optional grace wait for everything the wave reached. A negative
		// `graceful_ms` skips the wait entirely (we still emit the polite
		// signal so cleanup handlers can run before KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&reached,
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
		// along with everything the polite wave reached, through its pins.
		let mut hard = self.signal_wave(KILL_SIGNAL, leader.as_ref(), &reached.pins, &protected);
		hard.pins.extend(reached.pins);
		hard.kernel.extend(reached.kernel);
		wait_for_exit(self, &hard, Some(Duration::from_millis(u64::from(timeout_ms))), ct).await
	}
}

/// The leader of the process group `process` is in, pinned when that is
/// another process: kept only if `process` still runs in the group after the
/// open, since a live member keeps the group's number from being reused.
#[cfg(unix)]
fn pin_group_leader(process: &PinnedProcess) -> Option<PinnedProcess> {
	let group = process.group_id().filter(|group| *group != process.pid())?;
	let leader = PinnedProcess::from_pid(group)?;
	(process.group_id() == Some(group)).then_some(leader)
}

/// Windows has no process groups.
#[cfg(windows)]
const fn pin_group_leader(_process: &PinnedProcess) -> Option<PinnedProcess> {
	None
}

/// What a signal wave reached: processes through their own pins, the
/// members of the groups it signalled as a whole (listed under a proof just
/// before), and the leaders of the groups it signalled through the kernel.
#[derive(Default)]
struct Reached {
	pins:   Vec<PinnedProcess>,
	kernel: Vec<PinnedProcess>,
}

impl From<&SignalWave> for Reached {
	fn from(wave: &SignalWave) -> Self {
		Self {
			pins:   wave
				.reached()
				.iter()
				.chain(wave.members())
				.cloned()
				.collect(),
			kernel: wave.kernel_leaders().to_vec(),
		}
	}
}

impl Reached {
	/// Whether every process reached is gone and no group signalled through
	/// the kernel has a running member left.
	fn all_gone(&self) -> bool {
		self
			.pins
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
			&& !self.kernel.iter().any(kernel_group_runs)
	}
}

/// Waits until `root` and everything `reached` covers are gone, optionally
/// bounded by `timeout`.
async fn wait_for_exit(
	root: &Process,
	reached: &Reached,
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	let gone = || root.status() != ProcessStatus::Running && reached.all_gone();
	if gone() {
		return Ok(true);
	}

	// A lone process is awaited through the OS exit notification. Polling woke
	// every waiter 20 times a second, and IPC workers wait on their parent for
	// their whole life. Trees still poll: their membership changes.
	let lone = reached.kernel.is_empty()
		&& reached
			.pins
			.iter()
			.all(|process| process.same_identity(&root.inner));
	if lone && let Some(result) = wait_for_root_exit(root, timeout, &ct).await {
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
		if gone() {
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

/// POSIX `SIGTERM` / Windows polite termination sentinel.
pub const TERM_SIGNAL: i32 = 15;

/// POSIX `SIGKILL` / Windows hard-termination sentinel.
pub const KILL_SIGNAL: i32 = 9;

/// A collection of process groups and process trees scheduled for
/// termination together.
///
/// Built incrementally from job records or PTY metadata, then signalled
/// in escalating waves (typically `TERM_SIGNAL` followed by
/// `KILL_SIGNAL` after a grace period). Each group is recorded by its pinned
/// leader and reached only through it (see [`SignalWave`]). Group signals are
/// no-ops on platforms that do not expose process groups.
#[derive(Default)]
pub struct TerminationTargets {
	leaders:   Vec<PinnedProcess>,
	processes: Vec<Process>,
}

impl TerminationTargets {
	/// Create an empty target set.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record the process group `leader` leads. Its members are listed and
	/// signalled through their own pins only while `leader` still runs after
	/// the listing; after that the group is reached only through the kernel's
	/// group signal (Linux 6.9 and later). Duplicates are ignored.
	pub fn add_group(&mut self, leader: Process) {
		if !self
			.leaders
			.iter()
			.any(|seen| seen.same_identity(&leader.inner))
		{
			self.leaders.push(leader.inner);
		}
	}

	/// Record a pid. If the pid is alive, opens a stable [`Process`]
	/// reference so the descendant tree can be killed even if the original
	/// pid is reused later.
	///
	/// Prefer [`add_process`](Self::add_process) when the caller already holds a
	/// [`Process`] captured at spawn time: opening by pid here loses the
	/// original identity if the pid was recycled between the child exiting
	/// and this call.
	pub fn add_pid(&mut self, pid: i32) {
		if let Some(process) = Process::from_pid(pid) {
			self.add_process(process);
		}
	}

	/// Record a pre-pinned [`Process`] handle. Duplicates (by pinned identity)
	/// are ignored.
	///
	/// This is the correct entry point when the caller captured the handle at
	/// spawn time — the handle already pins OS-level identity, so no `from_pid`
	/// re-open (and its PID-reuse race) is needed at cancellation time.
	pub fn add_process(&mut self, process: Process) {
		if !self
			.processes
			.iter()
			.any(|seen| seen.inner.same_identity(&process.inner))
		{
			self.processes.push(process);
		}
	}

	/// True when no targets have been recorded.
	#[must_use]
	pub const fn is_empty(&self) -> bool {
		self.leaders.is_empty() && self.processes.is_empty()
	}

	/// Send `signal` to every recorded target in one wave (see
	/// [`SignalWave`] for which deliveries it makes). Failures are swallowed:
	/// targets routinely exit between collection and signalling, and the
	/// caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		let protected = host_protected_pids();
		let mut wave = SignalWave::new(signal);
		for leader in &self.leaders {
			wave.group(leader, GroupProof::Running);
		}
		for process in &self.processes {
			if process.group_id() == Some(process.pid()) {
				wave.group(&process.inner, GroupProof::Running);
			}
			for descendant in process.signalable_descendants(&protected) {
				wave.process(&descendant.inner);
			}
			if !protected.contains(&process.pid()) {
				wave.process(&process.inner);
			}
		}
		wave.deliver();
	}
}

/// Per-run record of the OS processes a single shell command launched,
/// captured at spawn time via brush's `SpawnObserver` hook.
///
/// Replaces the old process-global "new descendants since a baseline" diff,
/// which could not distinguish the children of concurrent runs sharing one
/// host process: a run that cancelled would signal *any* descendant spawned
/// after its baseline, including another run's children. Ownership is now
/// explicit — only processes this run actually spawned, and the groups they
/// lead, are ever signalled, each through the identity pinned when it was
/// spawned (see [`SpawnLedger`]).
#[derive(Default)]
pub struct SpawnRegistry {
	ledger: Mutex<SpawnLedger>,
}

impl SpawnRegistry {
	/// Create an empty registry.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record a child the shell just spawned into group `pgid`, from the
	/// spawn-observer hook: the shell has not reaped it yet, so `pid` still
	/// names it, and it reports the child again through
	/// [`Self::before_reap`] before it reaps it. A child that cannot be
	/// pinned (already gone) records nothing.
	pub fn record_spawn(&self, pid: i32, pgid: Option<i32>) {
		self
			.ledger
			.lock()
			.record(pgid, PinnedProcess::from_pid(pid));
	}

	/// Record a process this run's shell does not report before reaping,
	/// such as a job a previous run started: it proves the group it leads
	/// only while it runs.
	pub fn record_job(&self, pid: i32, pgid: Option<i32>) {
		self
			.ledger
			.lock()
			.record_unwatched(pgid, PinnedProcess::from_pid(pid));
	}

	/// The shell is about to stop holding child `pid` unreaped (see
	/// [`SpawnLedger::before_reap`]). Takes the same lock as [`Self::signal`],
	/// so the shell cannot reap a leader while a wave lists its group.
	pub fn before_reap(&self, pid: i32, unreaped: bool) {
		self.ledger.lock().before_reap(pid, unreaped);
	}

	/// Pids of recorded processes that are still alive, in spawn order.
	///
	/// Liveness is probed through each entry's pinned [`Process`] (pidfd on
	/// Linux, start-time identity on macOS, open handle on Windows), so a
	/// recycled pid never reports as one of this run's children. The recorded
	/// set is not mutated.
	#[must_use]
	pub fn live_pids(&self) -> Vec<i32> {
		self.ledger.lock().live_pids()
	}

	/// Whether a wave could still reach any of this run's processes. Prunes
	/// the ledger first.
	#[must_use]
	pub fn reaches_anything(&self) -> bool {
		let mut ledger = self.ledger.lock();
		ledger.prune();
		ledger.reaches_anything()
	}

	/// Sends one wave of `signal` to every recorded process, its live
	/// descendants, and the group each recorded leader leads (see
	/// [`SpawnLedger::plan_wave`]), then records every process the wave
	/// reached, so later waves wait for them and reach them. The ledger stays
	/// locked until then, so the shell cannot reap a leader while the wave
	/// signals its group by number. Re-read on every wave, so a child spawned
	/// during a grace window is still reached.
	pub fn signal(&self, signal: i32) {
		let mut ledger = self.ledger.lock();
		ledger.prune();
		let delivered = ledger.plan_wave(signal, true).deliver();
		ledger.record_reached(&delivered);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

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

	/// Ends what a test started when the test ends, passed or failed: the
	/// group of a leader the test has not reaped (the unreaped leader holds the
	/// group's number), every pinned process it holds, then the leader. These
	/// tests start processes that trap TERM and loop forever, so a failed
	/// assertion must not leave them running.
	#[cfg(unix)]
	struct ProcessGuard {
		leader: std::process::Child,
		pins:   Vec<PinnedProcess>,
	}

	#[cfg(unix)]
	impl ProcessGuard {
		const fn new(leader: std::process::Child) -> Self {
			Self { leader, pins: Vec::new() }
		}

		/// Also ends `process` (used by the Linux-only tests).
		#[cfg(target_os = "linux")]
		fn pin(&mut self, process: &PinnedProcess) {
			self.pins.push(process.clone());
		}
	}

	#[cfg(unix)]
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
				let _ = pin.kill(KILL_SIGNAL);
			}
			let _ = self.leader.kill();
			let _ = self.leader.wait();
		}
	}

	/// Whether `pid`, a child of this process, is not reaped yet (it runs or
	/// waits as a zombie), checked without reaping it: `try_wait` would reap a
	/// zombie leader and free its group's number before the group is killed.
	#[cfg(unix)]
	fn unreaped_child(pid: i32) -> bool {
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

	/// Starts `sh` leading its own process group, with a TERM trap that
	/// appends one `x` to `runs` for each signal it receives.
	#[cfg(unix)]
	fn spawn_term_trap_group_leader(dir: &std::path::Path) -> (ProcessGuard, Process) {
		use std::{
			os::unix::process::CommandExt as _,
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
		let pid = i32::try_from(child.id()).expect("child pid fits");
		let guard = ProcessGuard::new(child);
		let process = Process::from_pid(pid).expect("pin trap shell");
		let deadline = Instant::now() + Duration::from_secs(5);
		while !dir.join("ready").exists() {
			assert!(Instant::now() < deadline, "trap shell never became ready");
			thread::sleep(Duration::from_millis(10));
		}
		(guard, process)
	}

	/// Reaps the guarded shell within 5 seconds and returns what its TERM
	/// trap wrote.
	#[cfg(unix)]
	fn trap_runs_after_exit(guard: &mut ProcessGuard, dir: &std::path::Path) -> String {
		use std::{
			thread,
			time::{Duration, Instant},
		};

		let deadline = Instant::now() + Duration::from_secs(5);
		while guard.leader.try_wait().expect("poll trap shell").is_none() {
			assert!(Instant::now() < deadline, "trap shell did not exit after TERM");
			thread::sleep(Duration::from_millis(10));
		}
		std::fs::read_to_string(dir.join("runs")).expect("TERM trap ran")
	}

	/// A group signal already reaches its leader. The first termination wave
	/// must not send the leader a second TERM through the direct-root path.
	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_signals_a_group_leader_once() {
		for attempt in 0..40 {
			let dir = tempfile::tempdir().expect("trap directory");
			let (mut guard, process) = spawn_term_trap_group_leader(dir.path());
			let exited = process
				.terminate_tree(true, 5_000, 1_000, CancelToken::default())
				.await
				.expect("terminate trap shell");
			assert!(exited, "attempt {attempt}: trap shell must exit in the TERM grace");
			assert_eq!(
				trap_runs_after_exit(&mut guard, dir.path()),
				"x",
				"attempt {attempt}: group leader must take TERM once"
			);
		}
	}

	/// `terminate_tree(group)` on a member whose leader exited and was reaped
	/// must still stop the member's TERM-ignoring sibling, and must not report
	/// success while it runs. The member was opened while the leader ran, so
	/// the leader is pinned and the kernel reaches its group through that pin
	/// (Linux 6.9 and later; older kernels cannot, and skip this test).
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_through_a_member_stops_a_term_ignoring_sibling_after_the_leader_exits() {
		use std::{
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
		};

		let mut leader = Command::new("sh")
			.args([
				"-c",
				"sleep 600 & echo \"$!\"; sh -c 'trap \"\" TERM; exec sleep 600' & echo \"$!\"; read \
				 -r _",
			])
			.process_group(0)
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.spawn()
			.expect("start group leader");
		let mut output = BufReader::new(leader.stdout.take().expect("leader stdout"));
		let stdin = leader.stdin.take();
		let leader_pid = i32::try_from(leader.id()).expect("leader pid fits");
		let mut guard = ProcessGuard::new(leader);
		let mut first = String::new();
		let mut second = String::new();
		output.read_line(&mut first).expect("read first member");
		output.read_line(&mut second).expect("read second member");
		let member = Process::from_pid(first.trim().parse::<i32>().expect("first member pid"))
			.expect("pin first member while leader runs");
		let sibling =
			PinnedProcess::from_pid(second.trim().parse::<i32>().expect("second member pid"))
				.expect("pin second member");
		let leader_pin = PinnedProcess::from_pid(leader_pid).expect("pin the leader");
		guard.pin(&member.inner);
		guard.pin(&sibling);
		// Give the sibling time to install its TERM trap before the wave.
		tokio::time::sleep(Duration::from_millis(200)).await;
		drop(stdin);
		let _ = guard.leader.wait().expect("reap group leader");
		if !leader_pin.signal_group(0) {
			eprintln!("skipped: this kernel cannot signal a group through its reaped leader");
			return;
		}

		assert_eq!(member.group_id(), Some(leader_pid), "the member retains the leader's group");
		let exited = member
			.terminate_tree(true, 300, 2_000, CancelToken::default())
			.await
			.expect("terminate group through member");
		assert!(exited, "terminate_tree must report the group gone");
		assert!(
			sibling.status() != ProcessStatus::Running,
			"terminate_tree reported success while the TERM-ignoring sibling still ran"
		);
	}

	/// `terminate_tree(group)` on a group leader whose member is not its
	/// descendant (its parent exited) and leaves the group in its TERM handler
	/// (`setsid()`), then ignores TERM: the SIGKILL wave must reach the member
	/// through the pin the TERM wave listed it with, and `terminate_tree` must
	/// not report success while it runs.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_kills_a_member_that_left_the_group_in_its_term_handler() {
		use std::{fs, os::unix::process::CommandExt as _, process::Command, thread, time::Instant};

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
		// The inner shell starts the member and exits, so the member is
		// reparented away from the leader but stays in its group.
		let leader = Command::new("/bin/sh")
			.args(["-c", "/bin/sh -c 'python3 \"$0/member.py\" \"$0\" &' \"$0\"; exec /bin/sleep 600"])
			.arg(dir.path())
			.process_group(0)
			.spawn()
			.expect("start the group leader");
		let leader_pid = i32::try_from(leader.id()).expect("leader pid fits");
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
		assert_eq!(member.group_id(), Some(leader_pid), "the member is in the leader's group");
		assert_ne!(member.parent_pid(), Some(leader_pid), "the member is not the leader's child");

		let root = Process::from_pid(leader_pid).expect("pin the leader");
		let exited = root
			.terminate_tree(true, 300, 2_000, CancelToken::default())
			.await
			.expect("terminate the group");
		assert!(dir.path().join("left").exists(), "the member's TERM handler ran");
		assert!(exited, "terminate_tree must report the tree gone");
		assert!(
			member.status() != ProcessStatus::Running,
			"terminate_tree reported success while the member that left the group still ran"
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
				.inner
				.descendants()
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
			"freshly spawned child pid {child_pid} must appear in `descendants` so the cancellation \
			 cleanup can reach it; this regressed on macOS when the walk relied on the broken \
			 `proc_listchildpids`",
		);
	}

	/// Regression test for issue #4605: `SpawnRegistry` MUST pin a stable
	/// [`Process`] reference at spawn time rather than defer re-opening the
	/// pid until termination.
	///
	/// Before the fix, `SpawnRegistry` stored only the raw pid and called
	/// `Process::from_pid` at cancellation time. On Windows pids recycle
	/// aggressively, so a bash-spawned `pwsh.exe` that had already exited could
	/// see its pid reassigned to an unrelated PowerShell session (e.g. the
	/// user's other Cursor terminal). `Process::from_pid` at cancel time would
	/// happily open that unrelated process, and `signal_tree` would then
	/// enumerate — and `TerminateProcess` — the entire foreign subtree.
	///
	/// This test cannot literally trigger Windows pid recycling from a
	/// cross-platform Rust test, but it can prove the observable defense: a
	/// recorded process reference survives the original pid's death (so no
	/// "look it up again" step exists to be raced), and the registry stops
	/// reaching anything once that process is gone.
	#[cfg(unix)]
	#[test]
	fn spawn_registry_pins_identity_at_record_time() {
		use std::{process::Command, thread, time::Duration};

		let mut long = Command::new("sleep")
			.arg("30")
			.spawn()
			.expect("spawn sleep");
		let long_pid = i32::try_from(long.id()).expect("child pid fits in i32");

		let registry = SpawnRegistry::new();
		registry.record_spawn(long_pid, None);
		assert_eq!(
			registry.live_pids(),
			vec![long_pid],
			"a still-live pinned child must be what the registry reaches"
		);

		let _ = long.kill();
		let _ = long.wait();

		// Once the child exits, the registry reaches nothing, rather than
		// re-opening the pid at kill time.
		let mut nothing_after_exit = false;
		for _ in 0..40 {
			if !registry.reaches_anything() {
				nothing_after_exit = true;
				break;
			}
			thread::sleep(Duration::from_millis(25));
		}
		assert!(
			nothing_after_exit,
			"once the pinned child exits the registry must reach nothing — re-opening by pid at \
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

	/// A group termination's hard wave comes a grace period after its polite
	/// one. When the group empties in between and an unrelated process takes
	/// its number, leading a group of its own, the hard wave must not reach
	/// it: termination read the group's number once and signalled the number
	/// in both waves.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_hard_wave_spares_the_process_that_took_the_groups_number() {
		use std::{
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
		};

		if !crate::test_support::in_private_pid_namespace(
			module_path!(),
			"terminate_tree_hard_wave_spares_the_process_that_took_the_groups_number",
		) {
			return;
		}
		// The root leads its group, ignores TERM and ends by itself half a second
		// in, emptying the group. Its child, in a session of its own, ignores
		// TERM too and keeps termination waiting out the grace period, so the
		// hard wave comes after the root's pid was freed and taken.
		let mut root = Command::new("/bin/sh")
			.args(["-c", "trap '' TERM; setsid /bin/sleep 600 & echo \"$!\"; /bin/sleep 0.5"])
			.process_group(0)
			.stdout(Stdio::piped())
			.spawn()
			.expect("start the group leader");
		let mut line = String::new();
		BufReader::new(root.stdout.take().expect("root stdout"))
			.read_line(&mut line)
			.expect("read the child pid");
		let stubborn =
			Process::from_pid(line.trim().parse().expect("child pid")).expect("pin the child");
		let root_pid = i32::try_from(root.id()).expect("pid fits in i32");
		let pinned_root = Process::from_pid(root_pid).expect("pin the root");

		// Once the root ends, reap it and hand its pid — the group's number — to
		// an unrelated process.
		let recycler = std::thread::spawn(move || {
			let _ = root.wait();
			crate::test_support::recycle_pid(root_pid)
		});
		pinned_root
			.terminate_tree(true, 2000, 500, CancelToken::default())
			.await
			.expect("terminate the tree");
		let unrelated = recycler.join().expect("recycler thread");
		let _ = stubborn.signal(KILL_SIGNAL);
		let mut unrelated = unrelated.expect("another process took the root's pid first");
		let ended = crate::test_support::how_it_ended(&mut unrelated).await;
		assert!(ended.is_none(), "the hard wave reached a process the tree never had: {ended:?}");
	}

	/// A run's group leader exits and is reaped. Its member, pinned before the
	/// reap, leaves the group, which frees the number; an unrelated process
	/// takes it, leading a group of its own; the member then joins that group.
	/// A member proves nothing about a group number, so the run's waves reach
	/// the member through its pin and never the unrelated group.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn a_run_spares_the_group_that_took_its_reaped_leaders_number_when_its_member_joins_it() {
		use std::{
			fs,
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
			thread,
			time::Instant,
		};

		const MEMBER: &str = r#"import os, signal, sys, time
from pathlib import Path
root = Path(sys.argv[1])
def leave(*_):
    os.setpgid(0, 0)
    (root / "left").write_text(str(os.getpgrp()))
def join(*_):
    os.setpgid(0, int((root / "target").read_text()))
    (root / "joined").write_text(str(os.getpgrp()))
signal.signal(signal.SIGUSR2, leave)
signal.signal(signal.SIGUSR1, join)
(root / "ready").write_text("")
while True:
    time.sleep(1)
"#;

		if !crate::test_support::in_private_pid_namespace(
			module_path!(),
			"a_run_spares_the_group_that_took_its_reaped_leaders_number_when_its_member_joins_it",
		) {
			return;
		}
		let dir = tempfile::tempdir().expect("scratch directory");
		fs::write(dir.path().join("member.py"), MEMBER).expect("write member script");
		let leader = Command::new("/bin/sh")
			.args(["-c", "python3 \"$0/member.py\" \"$0\" & echo \"$!\""])
			.arg(dir.path())
			.process_group(0)
			.stdout(Stdio::piped())
			.spawn()
			.expect("start the group leader");
		let leader_pid = i32::try_from(leader.id()).expect("leader pid fits");
		let mut guard = ProcessGuard::new(leader);
		let mut line = String::new();
		BufReader::new(guard.leader.stdout.take().expect("leader stdout"))
			.read_line(&mut line)
			.expect("read the member pid");
		let member_pid: i32 = line.trim().parse().expect("member pid");
		let member = PinnedProcess::from_pid(member_pid).expect("pin the member");
		guard.pin(&member);
		let deadline = Instant::now() + Duration::from_secs(10);
		while !dir.path().join("ready").exists() {
			assert!(Instant::now() < deadline, "the member never started");
			thread::sleep(Duration::from_millis(5));
		}

		let registry = SpawnRegistry::new();
		registry.record_spawn(leader_pid, Some(leader_pid));
		// The leader has exited; the shell reports it before reaping it.
		let leader_pin = PinnedProcess::from_pid(leader_pid).expect("pin the leader");
		while leader_pin.status() == ProcessStatus::Running {
			assert!(Instant::now() < deadline, "the leader never exited");
			thread::sleep(Duration::from_millis(5));
		}
		registry.before_reap(leader_pid, true);
		let _ = guard.leader.wait();
		// SAFETY: `kill` takes scalar arguments; the member is this test's
		// process.
		assert_eq!(unsafe { libc::kill(member_pid, libc::SIGUSR2) }, 0, "ask the member to leave");
		while !dir.path().join("left").exists() {
			assert!(Instant::now() < deadline, "the member never left the group");
			thread::sleep(Duration::from_millis(5));
		}

		// The group is empty now, so its number is free.
		let mut unrelated = crate::test_support::recycle_pid(leader_pid)
			.expect("another process took the leader's pid first");
		fs::write(dir.path().join("target"), leader_pid.to_string()).expect("write the target group");
		// SAFETY: `kill` takes scalar arguments; the member is this test's
		// process.
		assert_eq!(unsafe { libc::kill(member_pid, libc::SIGUSR1) }, 0, "ask the member to join");
		while !dir.path().join("joined").exists() {
			assert!(Instant::now() < deadline, "the member never joined the reused group");
			thread::sleep(Duration::from_millis(5));
		}

		registry.signal(TERM_SIGNAL);
		registry.signal(KILL_SIGNAL);
		let ended = crate::test_support::how_it_ended(&mut unrelated).await;
		assert!(ended.is_none(), "the run signalled a group it never had: {ended:?}");
		let deadline = Instant::now() + Duration::from_secs(5);
		while member.status() == ProcessStatus::Running {
			assert!(Instant::now() < deadline, "the run's waves must reach its own member");
			thread::sleep(Duration::from_millis(10));
		}
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
