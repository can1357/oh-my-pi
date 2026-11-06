//! pi's commands that need more than argv and stdio: host callouts
//! ([`Resolved::Tool`](crate::bash::Resolved::Tool)) that run their operands in
//! subshells of the caller through the engine.
//!
//! - `timeout`: runs its command in a labeled subshell
//!   ([`ShellApi::run_subshell_in`]), signals that tree at the deadline
//!   ([`SigTarget::Label`](crate::bash::SigTarget::Label)), waits for it and
//!   the externals it started, and escalates to `KILL` after `-k`.
//! - `nohup`: runs its command in a detached tree ([`Lineage::detached`]): the
//!   shell's cancel spares it and the spawner leaves its externals running when
//!   the shell is torn down.
//! - `git` (with `PI_SMART_GIT` or `PI_GIT_GUARD`): the [`crate::git`] layers
//!   on a worker thread, then the git binary found on `PATH`, by absolute path
//!   so it never resolves back to the tool.
//! - pi's extras that run command lines (`env`, `ifne`, `xargs`, `find`): the
//!   utility runs on the session's runtime, and each command it runs is a
//!   subshell of the caller ([`crate::extras`] for the other extras).
//!
//! The engine reports a callout as [`Step::Call`](crate::bash::Step::Call);
//! the session driver owns a [`ToolCalls`] and hands it every call, every
//! [`Step::Done`](crate::bash::Step::Done) of a run that is not its own, and a
//! [`ToolCalls::poll`] on each turn, parking no longer than
//! [`ToolCalls::next_deadline`]. A tool's subshells are ordinary runs of the
//! engine: functions, builtins and externals run as anywhere else, and the
//! tool only watches their `Done`.
//!
//! The `kill` builtin is the engine's intrinsic (`%job` operands stay on the
//! virtual signal bus); the host's policy for OS pids is
//! [`crate::host::check_signal_target`].

mod extra;
mod git;
mod nohup;
mod timeout;

use std::{collections::VecDeque, sync::Arc, task::Waker, time::Duration};

use bstr::{BStr, BString, ByteSlice};
use parking_lot::Mutex;

use crate::{
	bash::{
		CallId, CallOutcome, ControlHandle, Cx, IoPoll, Lineage, NativeRef, RunId, Script, Shell,
		ShellApi, ToolCall, ToolRef,
	},
	extras::{ExtrasGate, ReportedError},
	git::{GitLayers, flag_on},
	vfs::VfsFs,
};

const TIMEOUT: ToolRef = ToolRef(1);
const NOHUP: ToolRef = ToolRef(2);
const GIT: ToolRef = ToolRef(3);
/// Every extra that runs command lines; `argv[0]` names it.
const EXTRA: ToolRef = ToolRef(4);

/// Which tools a session offers; fixed when the session starts, as pi
/// registers its builtins once per shell.
#[derive(Clone, Default)]
pub struct ToolConfig {
	/// `nohup` is the tool (off with `PI_DISABLE_NOHUP_BUILTIN`: the system
	/// binary runs).
	pub nohup:          bool,
	/// The `git` layers on at the start; `git` is the binary when none is.
	/// Each call reads the layers again from its own environment, so a
	/// command can turn one off (`PI_GIT_GUARD=0 git …`).
	pub git:            GitLayers,
	/// The session's filesystem slot ([`VfsFs::filesystem`], read per call):
	/// what pi's extras run on, and whose native paths in-process `git
	/// worktree add` may touch. `None` when every path is native (`StdFs`).
	pub vfs:            Option<VfsFs>,
	/// pi's extras the shell offers (`PI_DISABLE_UUTILS_*`).
	pub extras:         ExtrasGate,
	/// Where the extras that run command lines run; without one they fail.
	pub runtime:        Option<tokio::runtime::Handle>,
	/// The reported-error flag of the command in flight, for the extras.
	pub reported_error: ReportedError,
}

impl ToolConfig {
	/// The tools and extras a shell started with environment `env` offers,
	/// on the filesystem slot `vfs`, running extras on `runtime`.
	pub fn from_env(
		env: &[(BString, BString)],
		vfs: Option<VfsFs>,
		runtime: tokio::runtime::Handle,
	) -> Self {
		let var = |name: &str| {
			env.iter()
				.rev()
				.find(|(k, _)| k == name.as_bytes())
				.and_then(|(_, v)| v.to_str().ok())
		};
		Self {
			nohup: !flag_on(var("PI_DISABLE_NOHUP_BUILTIN")),
			git: GitLayers::from_env(var),
			vfs,
			extras: ExtrasGate::from_env(var),
			runtime: Some(runtime),
			reported_error: ReportedError::default(),
		}
	}

	/// The tool `name` resolves to, if it is one of these.
	pub fn lookup(&self, name: &BStr) -> Option<ToolRef> {
		match name.as_bytes() {
			b"timeout" => Some(TIMEOUT),
			b"nohup" if self.nohup => Some(NOHUP),
			b"git" if self.git.any() => Some(GIT),
			_ if self.extras.runs_commands(name) => Some(EXTRA),
			_ => None,
		}
	}

	/// The extra `name` resolves to when it is an offered extra that runs
	/// as a task ([`crate::extras::ExtraTask`]).
	pub fn native_extra(&self, name: &BStr) -> Option<NativeRef> {
		self.extras.native(name)
	}

	/// The filesystem extras started now run on.
	pub fn filesystem(&self) -> pi_vfs::Fs {
		self
			.vfs
			.as_ref()
			.map_or_else(pi_vfs::Fs::native, VfsFs::filesystem)
	}

	/// Whether `path` is a plain host filesystem object.
	fn native(&self, path: &std::path::Path) -> bool {
		self
			.vfs
			.as_ref()
			.is_none_or(|fs| fs.filesystem().is_native_local(path))
	}
}

/// The externals spawned in labeled subshell trees: `(label, pid)`.
///
/// The host records each spawn whose [`Lineage::label`] is set
/// ([`SpawnLog::record`]); `timeout` waits for and escalates on its own. Cheap
/// to clone; clones share the log.
#[derive(Clone, Default)]
pub struct SpawnLog(Arc<Mutex<Vec<(u32, u32)>>>);

impl SpawnLog {
	/// `pid` was spawned with `lineage`.
	pub fn record(&self, lineage: Lineage, pid: u32) {
		if lineage.label != 0 {
			self.0.lock().push((lineage.label, pid));
		}
	}

	/// The recorded externals of `labels` that are still running.
	fn live(&self, labels: &[u32]) -> Vec<u32> {
		self
			.0
			.lock()
			.iter()
			.filter(|&&(label, pid)| labels.contains(&label) && running(pid))
			.map(|&(_, pid)| pid)
			.collect()
	}

	fn forget(&self, labels: &[u32]) {
		self.0.lock().retain(|(label, _)| !labels.contains(label));
	}
}

/// Whether `pid` runs (exited but unreaped counts as gone).
#[cfg(unix)]
fn running(pid: u32) -> bool {
	i32::try_from(pid)
		.ok()
		.and_then(crate::sys::proc::info)
		.is_some_and(|p| p.state != crate::sys::proc::ProcState::Zombie)
}

/// Externals off Unix are not watched: their process tree is the Job
/// Object's, which the spawner ends with the subshell.
#[cfg(not(unix))]
const fn running(_pid: u32) -> bool {
	false
}

/// Send `signal` to `pid`'s process group (each external leads its own),
/// or to `pid` alone.
#[cfg(unix)]
fn signal_os(pid: u32, signal: crate::bash::Signal, group: bool) {
	let Ok(pid) = i32::try_from(pid) else {
		return;
	};
	let number = i32::from(signal.number(crate::bash::Platform::current()));
	let target = if group { -pid } else { pid };
	// SAFETY: plain syscall without pointer arguments.
	unsafe { libc::kill(target, number) };
}

#[cfg(not(unix))]
const fn signal_os(_pid: u32, _signal: crate::bash::Signal, _group: bool) {}

/// Lineage labels handed out to tool subshells, and which label each was
/// started under (a `timeout` inside another one's command).
#[derive(Default)]
struct Labels {
	last:    u32,
	parents: Vec<(u32, u32)>,
}

impl Labels {
	/// A fresh label for a subshell of a caller labeled `parent`.
	fn fresh(&mut self, parent: u32) -> u32 {
		self.last = self.last.wrapping_add(1).max(1);
		if parent != 0 {
			self.parents.push((self.last, parent));
		}
		self.last
	}

	/// `label` and every label started below it.
	fn group(&self, label: u32) -> Vec<u32> {
		let mut group = vec![label];
		let mut at = 0;
		while let Some(&parent) = group.get(at) {
			group.extend(
				self
					.parents
					.iter()
					.filter(|&&(_, p)| p == parent)
					.map(|&(child, _)| child),
			);
			at += 1;
		}
		group
	}

	fn release(&mut self, group: &[u32]) {
		self.parents.retain(|(child, _)| !group.contains(child));
	}
}

/// What a tool sees on each turn ([`Tool::advance`]).
struct Turn<'a> {
	/// [`crate::bash::Host::now_ns`].
	now:    u64,
	ctl:    &'a ControlHandle,
	log:    &'a SpawnLog,
	/// The tool's label and those below it ([`Labels::group`]).
	group:  &'a [u32],
	/// A vproc of `group` still exists.
	live:   bool,
	labels: &'a mut Labels,
	/// Wakes the driver (worker threads).
	waker:  &'a Waker,
	config: &'a ToolConfig,
}

/// One running tool call.
enum Tool {
	Timeout(timeout::Timeout),
	Nohup(nohup::Nohup),
	Git(git::Git),
	Extra(extra::Extra),
}

impl Tool {
	fn start(call: ToolCall) -> Option<Self> {
		Some(match call.tool {
			TIMEOUT => Self::Timeout(timeout::Timeout::new(call)),
			NOHUP => Self::Nohup(nohup::Nohup::new(call)),
			GIT => Self::Git(git::Git::new(call)),
			EXTRA => Self::Extra(extra::Extra::new(call)),
			_ => return None,
		})
	}

	/// Make progress; the outcome once the call is answered.
	fn advance(&mut self, api: &mut ShellApi<'_, '_>, turn: &mut Turn<'_>) -> Option<CallOutcome> {
		match self {
			Self::Timeout(t) => t.advance(api, turn),
			Self::Nohup(t) => t.advance(api, turn),
			Self::Git(t) => t.advance(api, turn),
			Self::Extra(t) => t.advance(api, turn),
		}
	}

	/// `run` (one of the tool's subshells) ended; `false` when it is not
	/// the tool's.
	fn on_done(&mut self, run: RunId, status: i32, signal: Option<i32>) -> bool {
		let child = match self {
			Self::Timeout(t) => &mut t.child,
			Self::Nohup(t) => &mut t.child,
			Self::Git(t) => &mut t.child,
			Self::Extra(t) => return t.on_done(run, status, signal),
		};
		child.on_done(run, status)
	}

	const fn child(&self) -> &Child {
		match self {
			Self::Timeout(t) => &t.child,
			Self::Nohup(t) => &t.child,
			Self::Git(t) => &t.child,
			Self::Extra(t) => &t.child,
		}
	}

	/// The tool's subshells whose `Done` is still to come.
	fn pending(&self) -> Vec<RunId> {
		match self {
			Self::Extra(t) => t.pending(),
			_ => self.child().pending().into_iter().collect(),
		}
	}

	/// When the tool must be advanced even if nothing wakes the driver.
	fn deadline(&self) -> Option<u64> {
		match self {
			Self::Timeout(t) => t.deadline(),
			Self::Nohup(_) | Self::Git(_) | Self::Extra(_) => None,
		}
	}
}

/// A tool's subshell: its run and label, and its status once it ended.
#[derive(Default)]
struct Child {
	run:    Option<RunId>,
	label:  u32,
	status: Option<i32>,
}

impl Child {
	/// Run `argv` (`"$@"`, so functions, builtins and externals run as
	/// anywhere) in a subshell of the caller under a fresh label;
	/// `redirect` is appended to the command (`>&2`).
	fn start(
		&mut self,
		api: &mut ShellApi<'_, '_>,
		turn: &mut Turn<'_>,
		call: &ToolCall,
		argv: Vec<BString>,
		detached: bool,
		redirect: &str,
	) {
		self.label = turn.labels.fresh(api.lineage().label);
		let mut script = Script::command(format!("\"$@\"{redirect}").into_bytes());
		script.args = Some(argv);
		// The command's environment, per-command assignments included.
		script.env = call
			.env
			.iter()
			.map(|(name, value)| (BString::from(name), BString::from(value)))
			.collect();
		self.status = None;
		let lineage = Lineage { label: self.label, detached };
		// `nohup` (the detached tool) execs its operand: its subshell stands
		// for the command, so `$!` of `nohup cmd &` is the program's pid.
		self.run = Some(if detached {
			api.exec_subshell_in(script, lineage)
		} else {
			api.run_subshell_in(script, lineage)
		});
	}

	fn on_done(&mut self, run: RunId, status: i32) -> bool {
		if self.run != Some(run) || self.status.is_some() {
			return false;
		}
		self.status = Some(status);
		true
	}

	/// The run, while its `Done` is still to come.
	fn pending(&self) -> Option<RunId> {
		self.run.filter(|_| self.status.is_none())
	}
}

/// Output a tool writes to the caller's fds, in order, without blocking.
#[derive(Default)]
struct Out(VecDeque<(i32, Vec<u8>)>);

impl Out {
	fn push(&mut self, fd: i32, bytes: impl Into<Vec<u8>>) {
		let bytes = bytes.into();
		if !bytes.is_empty() {
			self.0.push_back((fd, bytes));
		}
	}

	/// Write what fits; `true` once everything is written (or failed: a
	/// closed stderr loses the message, as it would for any command).
	fn flush(&mut self, api: &mut ShellApi<'_, '_>) -> bool {
		while let Some((fd, bytes)) = self.0.front_mut() {
			match api.write(*fd, bytes) {
				IoPoll::Ready(Ok(n)) if n > 0 && n < bytes.len() => {
					bytes.drain(..n);
				},
				IoPoll::Ready(_) => {
					self.0.pop_front();
				},
				IoPoll::WouldBlock(_) => return false,
			}
		}
		true
	}
}

/// The host callouts in flight; owned by the session driver.
pub struct ToolCalls {
	active:  Vec<(CallId, Tool)>,
	/// Runs of tools that ended before them (an abandoned call): their
	/// `Done` is swallowed.
	orphans: Vec<RunId>,
	labels:  Labels,
	log:     SpawnLog,
	waker:   Waker,
	config:  ToolConfig,
}

impl ToolCalls {
	/// Tools of a shell with `config`, whose host records labeled spawns in
	/// `log`; worker threads wake the driver with `waker`.
	pub fn new(config: ToolConfig, log: SpawnLog, waker: Waker) -> Self {
		Self {
			active: Vec::new(),
			orphans: Vec::new(),
			labels: Labels::default(),
			log,
			waker,
			config,
		}
	}

	/// Start the callout `id` the engine returned.
	pub fn on_call(&mut self, shell: &mut Shell, cx: &mut Cx<'_>, id: CallId, call: ToolCall) {
		let name = call.argv.first().cloned().unwrap_or_default();
		if let Some(tool) = Tool::start(call) {
			self.active.push((id, tool));
			self.poll(shell, cx);
		} else {
			let mut msg = BString::from("not a pi tool: ");
			msg.extend_from_slice(&name);
			shell.complete(id, CallOutcome::Error(msg));
		}
	}

	/// A run that is not the session's own ended; `true` when it belonged
	/// to a tool (the driver ignores it then). `signal` is the actual
	/// signal death of a command replacing the run, not an exit code.
	pub fn on_done(&mut self, run: RunId, status: i32, signal: Option<i32>) -> bool {
		if self
			.active
			.iter_mut()
			.any(|(_, tool)| tool.on_done(run, status, signal))
		{
			return true;
		}
		match self.orphans.iter().position(|&r| r == run) {
			Some(at) => {
				self.orphans.swap_remove(at);
				true
			},
			None => false,
		}
	}

	/// Advance every tool; answer the calls that finished and drop those
	/// the engine abandoned (their caller was cancelled or killed).
	pub fn poll(&mut self, shell: &mut Shell, cx: &mut Cx<'_>) {
		if self.active.is_empty() {
			return;
		}
		let now = cx.host.now_ns();
		let ctl = shell.control();
		let mut at = 0;
		while at < self.active.len() {
			let (id, tool) = &mut self.active[at];
			let id = *id;
			let group = self.labels.group(tool.child().label);
			let live = tool.child().label != 0 && group.iter().any(|&l| shell.label_live(l));
			let outcome = match shell.api(cx, id) {
				Some(mut api) => {
					let mut turn = Turn {
						now,
						ctl: &ctl,
						log: &self.log,
						group: &group,
						live,
						labels: &mut self.labels,
						waker: &self.waker,
						config: &self.config,
					};
					tool.advance(&mut api, &mut turn).map(Some)
				},
				// Abandoned: nothing awaits the answer any more.
				None => Some(None),
			};
			let Some(answer) = outcome else {
				at += 1;
				continue;
			};
			let (_, tool) = self.active.swap_remove(at);
			self.orphans.extend(tool.pending());
			self.log.forget(&group);
			self.labels.release(&group);
			if let Some(outcome) = answer {
				shell.complete(id, outcome);
			}
		}
	}

	/// The earliest host time ([`crate::bash::Host::now_ns`]) a tool must be
	/// polled at even if nothing wakes the driver.
	pub fn next_deadline(&self) -> Option<u64> {
		self
			.active
			.iter()
			.filter_map(|(_, tool)| tool.deadline())
			.min()
	}
}

/// `d` in host nanoseconds (saturating: "never").
fn nanos(d: Duration) -> u64 {
	u64::try_from(d.as_nanos()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn labels_group_their_nested_trees() {
		let mut labels = Labels::default();
		let outer = labels.fresh(0);
		let inner = labels.fresh(outer);
		let innermost = labels.fresh(inner);
		let other = labels.fresh(0);
		assert_eq!(labels.group(outer), [outer, inner, innermost]);
		assert_eq!(labels.group(other), [other]);
		labels.release(&labels.group(inner));
		assert_eq!(labels.group(outer), [outer]);
	}

	#[test]
	fn tools_follow_the_session_environment() {
		let env = |pairs: &[(&str, &str)]| -> Vec<(BString, BString)> {
			pairs.iter().map(|&(k, v)| (k.into(), v.into())).collect()
		};
		let runtime = tokio::runtime::Builder::new_current_thread()
			.build()
			.expect("runtime");
		let config =
			|pairs: &[(&str, &str)]| ToolConfig::from_env(&env(pairs), None, runtime.handle().clone());
		let plain = config(&[]);
		assert_eq!(plain.lookup("timeout".into()), Some(TIMEOUT));
		assert_eq!(plain.lookup("nohup".into()), Some(NOHUP));
		assert_eq!(plain.lookup("git".into()), None);
		assert_eq!(plain.lookup("xargs".into()), Some(EXTRA));
		assert_eq!(plain.lookup("sort".into()), None);
		assert!(plain.native_extra("sort".into()).is_some());
		let layered = config(&[("PI_GIT_GUARD", "1"), ("PI_DISABLE_NOHUP_BUILTIN", "true")]);
		assert_eq!(layered.lookup("git".into()), Some(GIT));
		assert_eq!(layered.lookup("nohup".into()), None);
		let off = config(&[("PI_SMART_GIT", "false"), ("PI_GIT_GUARD", "0")]);
		assert_eq!(off.lookup("git".into()), None);
		let no_utils = config(&[("PI_DISABLE_UUTILS_BUILTINS", "1")]);
		assert_eq!(no_utils.lookup("xargs".into()), None);
		assert!(no_utils.native_extra("sort".into()).is_none());
		assert_eq!(no_utils.lookup("timeout".into()), Some(TIMEOUT));
	}
}
