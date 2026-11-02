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
use pi_builtins::{PinnedProcess, SignalWave, SpawnLedger};

use crate::cancel::CancelToken;

/// Stable process reference.
#[derive(Clone)]
pub struct Process {
	inner: PinnedProcess,
}

impl Process {
	/// Open a stable process reference from a PID.
	pub fn from_pid(pid: i32) -> Option<Self> {
		PinnedProcess::from_pid(pid).map(Self::from_inner)
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
	/// `group`, to every member of the process group the root was in when
	/// termination began, proven by the root or a descendant still running in
	/// that group — then optionally waits up to `graceful_ms` for the tree to
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
		wait_for_exit(self, &[], timeout, ct).await
	}
}

impl Process {
	const fn from_inner(inner: PinnedProcess) -> Self {
		Self { inner }
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
	/// When this process leads its own group, the group's members are reached
	/// too, which catches grandchildren reparented to init when their
	/// immediate parent died inside the descendant walk.
	///
	/// `protected` shields the harness itself: a run-cancellation sweep must
	/// never hard-kill the host. On Windows the
	/// descendant tree is derived from raw `th32ParentProcessID` values that
	/// outlive their recorded parent, so a freshly spawned child whose recycled
	/// pid matches the harness's stale parent pid makes the harness enumerate
	/// as a false descendant; `TerminateProcess`-ing it drops the whole session
	/// with no cleanup and no `session_exit` record (#7452, related #4605).
	fn signal_tree_excluding(&self, signal: i32, protected: &HashSet<i32>) -> u32 {
		let groups = self.led_group().into_iter().collect::<Vec<_>>();
		let (wave, _) = deliver_wave(signal, &groups, &[self], protected);
		wave.reached()
	}

	/// This process's group, with this process as its proof, when this process
	/// leads it.
	fn led_group(&self) -> Option<GroupTarget> {
		(self.group_id() == Some(self.pid())).then(|| GroupTarget::new(self.pid(), self.clone()))
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

	/// The group this process is in now, with every direct descendant already
	/// in that group saved as an additional proof for later waves. Each proof
	/// was observed in the group before this termination begins; a coincidental
	/// reuse of the number by another process does not become an anchor.
	fn group_target_with_descendants(&self, protected: &HashSet<i32>) -> Option<GroupTarget> {
		let group = self.group_id()?;
		let mut target = GroupTarget::new(group, self.clone());
		for descendant in self.signalable_descendants(protected) {
			if descendant.group_id() == Some(group) {
				target.add_anchor(descendant);
			}
		}
		Some(target)
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

		// The group the root is in now. This process and descendants already in
		// it prove it; no leader is reopened by number here.
		let protected = host_protected_pids();
		let groups: Vec<GroupTarget> = if group {
			self
				.group_target_with_descendants(&protected)
				.into_iter()
				.collect()
		} else {
			Vec::new()
		};
		let protected = host_protected_pids();

		// Polite wave: SIGTERM the group's members, every live descendant, then
		// the root, each process at most once.
		let (_, mut descendants) = deliver_wave(TERM_SIGNAL, &groups, &[self], &protected);

		// Optional grace wait. A negative `graceful_ms` skips the wait entirely
		// (we still emit the polite signal so cleanup handlers can run before
		// KILL).
		if graceful_ms >= 0 {
			let exited = wait_for_exit(
				self,
				&descendants,
				Some(Duration::from_millis(graceful_ms as u64)),
				ct.clone(),
			)
			.await?;
			if exited {
				return Ok(true);
			}
		}

		// Hard wave. Re-walk the tree so any grandchild spawned during the grace
		// period — or any process re-parented to the root — is signalled too.
		(_, descendants) = deliver_wave(KILL_SIGNAL, &groups, &[self], &protected);

		wait_for_exit(self, &descendants, Some(Duration::from_millis(u64::from(timeout_ms))), ct)
			.await
	}
}

/// Sends one signal wave to `groups` and to the trees rooted at `roots`, each
/// process at most once, and returns the wave and every root's descendants.
///
/// Each [`GroupTarget`] carries only pinned processes recorded in that exact
/// group. A stale group number never gains an anchor merely because an
/// unrelated direct target happens to use the number later.
fn deliver_wave(
	signal: i32,
	groups: &[GroupTarget],
	roots: &[&Process],
	protected: &HashSet<i32>,
) -> (SignalWave, Vec<Process>) {
	let trees: Vec<Vec<Process>> = roots
		.iter()
		.map(|root| root.signalable_descendants(protected))
		.collect();
	let mut wave = SignalWave::new(signal);
	for target in groups {
		wave.group_with(target.group, target.anchors.iter().map(|anchor| &anchor.inner));
	}
	for (root, descendants) in roots.iter().zip(&trees) {
		for descendant in descendants {
			wave.process(&descendant.inner);
		}
		if !protected.contains(&root.pid()) {
			wave.process(&root.inner);
		}
	}
	(wave, trees.into_iter().flatten().collect())
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

async fn wait_for_exit(
	root: &Process,
	descendants: &[Process],
	timeout: Option<Duration>,
	ct: CancelToken,
) -> Result<bool> {
	ct.heartbeat()?;
	if root.status() != ProcessStatus::Running
		&& descendants
			.iter()
			.all(|process| process.status() != ProcessStatus::Running)
	{
		return Ok(true);
	}

	// A lone process is awaited through the OS exit notification. Polling woke
	// every waiter 20 times a second, and IPC workers wait on their parent for
	// their whole life. Trees still poll: their membership changes.
	if descendants.is_empty()
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

		if root.status() != ProcessStatus::Running
			&& descendants
				.iter()
				.all(|process| process.status() != ProcessStatus::Running)
		{
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

/// A process group and the pinned processes observed in it. Every anchor was
/// recorded in `group`; only one that still runs there can prove the group at
/// signal time.
#[derive(Clone)]
struct GroupTarget {
	group:   i32,
	anchors: Vec<Process>,
}

impl GroupTarget {
	fn new(group: i32, anchor: Process) -> Self {
		Self { group, anchors: vec![anchor] }
	}

	fn add_anchor(&mut self, anchor: Process) {
		if !self
			.anchors
			.iter()
			.any(|seen| seen.inner.same_identity(&anchor.inner))
		{
			self.anchors.push(anchor);
		}
	}
}

/// A collection of process groups and process trees scheduled for
/// termination together.
///
/// Built incrementally from job records or PTY metadata, then signalled
/// in escalating waves (typically `TERM_SIGNAL` followed by
/// `KILL_SIGNAL` after a grace period). Each group is recorded with pinned
/// processes observed in it. Group signals are no-ops on platforms that do not
/// expose process groups.
#[derive(Default)]
pub struct TerminationTargets {
	groups:    Vec<GroupTarget>,
	processes: Vec<Process>,
}

impl TerminationTargets {
	/// Create an empty target set.
	#[must_use]
	pub fn new() -> Self {
		Self::default()
	}

	/// Record process group `group`, with `anchor`, a pinned process observed
	/// in it. A group can have several anchors from the same run; they are all
	/// retained so a member that survives its leader still proves the group.
	pub fn add_group(&mut self, group: i32, anchor: Process) {
		if let Some(target) = self.groups.iter_mut().find(|target| target.group == group) {
			target.add_anchor(anchor);
		} else {
			self.groups.push(GroupTarget::new(group, anchor));
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
		self.groups.is_empty() && self.processes.is_empty()
	}

	/// Send `signal` to every recorded target in one wave, so each process
	/// takes it at most once however many targets reach it. Failures are
	/// swallowed: targets routinely exit between collection and signalling,
	/// and the caller's policy is "best effort".
	pub fn signal(&self, signal: i32) {
		let protected = host_protected_pids();
		let mut groups = self.groups.clone();
		for process in &self.processes {
			if let Some(target) = process.led_group() {
				if let Some(existing) = groups
					.iter_mut()
					.find(|existing| existing.group == target.group)
				{
					for anchor in target.anchors {
						existing.add_anchor(anchor);
					}
				} else {
					groups.push(target);
				}
			}
		}
		let roots: Vec<&Process> = self.processes.iter().collect();
		let _ = deliver_wave(signal, &groups, &roots, &protected);
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
/// were spawned into, are ever signalled, each through the identity pinned
/// when it was spawned (see [`SpawnLedger`]).
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

	/// Record a freshly spawned child in group `pgid`. Called from the
	/// spawn-observer hook.
	///
	/// The `Process` handle MUST be opened by the caller *immediately* after
	/// the child's pid becomes visible, so identity is pinned before any race
	/// with pid recycling can start. When the pin fails (child already exited
	/// before we could `Process::from_pid`) nothing is recorded: there is
	/// nothing left to signal.
	pub fn record(&self, pgid: Option<i32>, process: Option<Process>) {
		self
			.ledger
			.lock()
			.record(pgid, process.map(|process| process.inner));
	}

	/// Pins the live members of the group the exited child `pid` led, before
	/// the shell reaps the child. Called from the spawn-observer exit hook,
	/// while the unreaped child still holds the group's number; the members
	/// then prove the group after the reap, on kernels without the pinned
	/// leader group signal too.
	pub fn record_exit(&self, pid: i32) {
		self.ledger.lock().record_exiting_group_members(pid);
	}

	/// Pids of recorded processes that are still alive, in spawn order.
	///
	/// Liveness is probed through each entry's pinned [`Process`] (pidfd on
	/// Linux, start-time identity on macOS, open handle on Windows), so a
	/// recycled pid never reports as one of this run's children. The recorded
	/// set is not mutated; pruning stays with `record`/`build_targets`.
	#[must_use]
	pub fn live_pids(&self) -> Vec<i32> {
		self.ledger.lock().live_pids()
	}

	/// Build the kill set from the processes recorded so far. Re-read on every
	/// signal wave so a child spawned during a grace window — between the
	/// cancel firing and the next wave — is still reaped.
	///
	/// An entry contributes while its process runs or, for a group leader,
	/// while the kernel still reaches the group it led through its pin (Linux
	/// 6.9 and later). Members pinned before their leader was reaped keep the
	/// group reachable as its proof while they run. Once the run's whole tree
	/// exits the targets are empty and the wave loop can stop early. A group
	/// whose number another process took after the recorded group emptied is
	/// never a target.
	///
	/// Pruning also runs here so a cancellation cycle sees a compact target
	/// set even when the record-time threshold hasn't fired yet.
	#[must_use]
	pub fn build_targets(&self) -> TerminationTargets {
		let entries = {
			let mut ledger = self.ledger.lock();
			ledger.prune();
			ledger.entries().to_vec()
		};
		let mut targets = TerminationTargets::new();
		for entry in entries {
			let process = Process::from_inner(entry.process);
			if let Some(group) = entry.group {
				targets.add_group(group, process.clone());
			}
			targets.add_process(process);
		}
		targets
	}
}

#[cfg(test)]
mod tests {
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
			if matches!(self.leader.try_wait(), Ok(None))
				&& let Ok(group) = i32::try_from(self.leader.id())
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
	/// must still stop the member's siblings: the member, running in the group,
	/// holds its number and proves it, on every kernel with pidfds.
	#[cfg(target_os = "linux")]
	#[tokio::test(flavor = "multi_thread")]
	async fn terminate_tree_keeps_the_members_group_anchor_after_leader_exits() {
		use std::{
			io::{BufRead as _, BufReader},
			os::unix::process::CommandExt as _,
			process::{Command, Stdio},
		};

		let mut leader = Command::new("sh")
			.args(["-c", "sleep 600 & echo \"$!\"; sleep 600 & echo \"$!\"; read -r _"])
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
		let peer = PinnedProcess::from_pid(second.trim().parse::<i32>().expect("second member pid"))
			.expect("pin second member");
		guard.pin(&member.inner);
		guard.pin(&peer);
		drop(stdin);
		let _ = guard.leader.wait().expect("reap group leader");

		assert_eq!(member.group_id(), Some(leader_pid), "the member retains the leader's group");
		let exited = member
			.terminate_tree(true, 1_000, 500, CancelToken::default())
			.await
			.expect("terminate group through member");
		assert!(exited, "the selected member must exit");
		tokio::time::sleep(Duration::from_millis(250)).await;
		assert!(
			peer.status() != ProcessStatus::Running,
			"the group peer must exit with the selected member"
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
