//! What a host callout can do while its [`Step::Call`](super::Step::Call) is
//! outstanding.

use std::task::{Context, Poll};

use bstr::{BStr, BString};

use super::{
	Cx, Script, Shell, VprocSel,
	control::{IoPoll, WakeToken},
	is_ident,
	proc::{Awaited, BangStage, Vproc},
	state::{self, Level, Var, lookup},
};
use crate::bash::{
	diag::Diag,
	event::{CustomEvent, EventData},
	host::Lineage,
	ids::{CallId, RunId},
	store::{Attrs, OptId, StateStore, VarValue},
};

/// Access to the calling virtual process during a host callout
/// ([`Shell::api`]).
///
/// fd I/O never blocks: `WouldBlock` carries a [`WakeToken`] the callout
/// awaits before retrying, so callouts in one pipeline interleave instead of
/// deadlocking on a full pipe.
pub struct ShellApi<'s, 'c> {
	shell: &'s mut Shell,
	cx:    &'s mut Cx<'c>,
	vp:    usize,
	call:  CallId,
}

impl Shell {
	/// Callout access for the outstanding call `call`; `None` when no
	/// virtual process awaits it (completed, or its script was cancelled).
	pub fn api<'s, 'c>(&'s mut self, cx: &'s mut Cx<'c>, call: CallId) -> Option<ShellApi<'s, 'c>> {
		self.see_epoch(cx);
		let vp = self.awaiting(call)?;
		Some(ShellApi { shell: self, cx, vp, call })
	}
}

impl ShellApi<'_, '_> {
	fn vproc(&self) -> &Vproc {
		&self.shell.procs[self.vp]
	}

	/// The call this access belongs to.
	pub const fn call(&self) -> CallId {
		self.call
	}

	fn io<T>(&self, poll: impl FnOnce(&mut Context<'_>) -> Poll<std::io::Result<T>>) -> IoPoll<T> {
		let ctl = &self.shell.k.ctl;
		let at = ctl.wakes();
		let mut cx = Context::from_waker(&self.shell.k.waker);
		match poll(&mut cx) {
			Poll::Ready(r) => IoPoll::Ready(r),
			Poll::Pending => IoPoll::WouldBlock(WakeToken { ctl: std::sync::Arc::clone(ctl), at }),
		}
	}

	/// Read from fd `fd` of the calling vproc; `Ok(0)` at end of file.
	pub fn read(&mut self, fd: i32, buf: &mut [u8]) -> IoPoll<usize> {
		let h = self.vproc().fds.handle(fd);
		self.io(|cx| h.poll_read(cx, buf))
	}

	/// Write to fd `fd` of the calling vproc (possibly partially).
	pub fn write(&mut self, fd: i32, bytes: &[u8]) -> IoPoll<usize> {
		let h = self.vproc().fds.handle(fd);
		self.io(|cx| h.poll_write(cx, bytes))
	}

	/// A variable as the calling vproc sees it. A store failure reads as
	/// unset and abandons the running scripts at the next step.
	pub fn get_var(&mut self, name: &BStr) -> Option<VarValue> {
		let k = &mut self.shell.k;
		match lookup(&k.root, self.cx.store, &self.shell.procs[self.vp], name) {
			Ok(v) => v.map(|v| v.value.clone()),
			Err(err) => {
				k.fail(err);
				None
			},
		}
	}

	/// Set a variable in the calling vproc's scope.
	///
	/// # Errors
	///
	/// [`Diag::InvalidIdent`] for a bad name, [`Diag::Readonly`] for a
	/// readonly variable, [`Diag::StoreFailed`] when the store fails.
	pub fn set_var(&mut self, name: &BStr, value: VarValue, attrs: Attrs) -> Result<(), Diag> {
		if !is_ident(name) {
			return Err(Diag::InvalidIdent { name: name.into() });
		}
		let k = &mut self.shell.k;
		let vp = &mut self.shell.procs[self.vp];
		match lookup(&k.root, self.cx.store, vp, name) {
			Ok(Some(v)) if v.attrs.contains(Attrs::READONLY) => {
				return Err(Diag::Readonly { name: name.into() });
			},
			Ok(_) => {},
			Err(err) => {
				k.fail(err);
				return Err(Diag::StoreFailed);
			},
		}
		let var = Some(Var { attrs, value });
		state::store_var(&mut k.root, self.cx.store, vp, name, var, Level::Dynamic);
		Ok(())
	}

	/// Positional parameters of the calling vproc.
	pub fn positional(&mut self) -> Vec<BString> {
		let k = &mut self.shell.k;
		let vp = &self.shell.procs[self.vp];
		match state::positional(&k.root, self.cx.store, vp) {
			Ok(p) => p,
			Err(err) => {
				k.fail(err);
				Vec::new()
			},
		}
	}

	/// Working directory of the calling vproc.
	pub fn cwd(&self) -> &BStr {
		BStr::new(&self.vproc().cwd)
	}

	/// State of option `name` (`set -o` or `shopt` spelling); `None` for an
	/// unknown name.
	pub fn option(&mut self, name: &BStr) -> Option<bool> {
		let opt = OptId::from_name(name)?;
		let k = &mut self.shell.k;
		match state::option(&mut k.root, self.cx.store, &self.shell.procs[self.vp], opt) {
			Ok(on) => Some(on),
			Err(err) => {
				k.fail(err);
				None
			},
		}
	}

	/// Run `script` in a new subshell of the calling vproc (for callouts
	/// such as `xargs` or `find -exec`); `script.vproc` only selects the
	/// stdio. The run reports `Done` like any other.
	pub fn run_subshell(&mut self, mut script: Script) -> RunId {
		if matches!(script.vproc, VprocSel::Root) {
			script.vproc = VprocSel::NewSubshell;
		}
		let store: &mut dyn StateStore = &mut *self.cx.store;
		self.shell.submit_from(self.vp, script, Some(store), None)
	}

	/// [`Self::run_subshell`] with its own [`Lineage`], as `timeout` or
	/// `nohup` place their child: everything the subshell starts carries
	/// `lineage`. A nonzero label also makes the subshell tree part of the
	/// calling vproc for virtual signals: one that reaches the caller (`kill`
	/// of its pid or job, a [`SigTarget::Label`](crate::bash::SigTarget::Label)
	/// of a tree it runs in) reaches the tree too, as a signal to a process
	/// reaches what it `exec`s or forwards to. A detached lineage stays
	/// detached in every descendant, whatever `lineage` says.
	pub fn run_subshell_in(&mut self, mut script: Script, mut lineage: Lineage) -> RunId {
		if matches!(script.vproc, VprocSel::Root) {
			script.vproc = VprocSel::NewSubshell;
		}
		let caller = self.vproc();
		lineage.detached |= caller.lineage.detached;
		if lineage.label != 0 {
			let link = (lineage.label, caller.vpid);
			if !self.shell.k.callout_labels.contains(&link) {
				self.shell.k.callout_labels.push(link);
			}
		}
		let store: &mut dyn StateStore = &mut *self.cx.store;
		self
			.shell
			.submit_from(self.vp, script, Some(store), Some(lineage))
	}

	/// [`Self::run_subshell_in`] for a callout that stands for the command
	/// it runs, as `nohup` `exec`s its operand. When the call is the lone
	/// command of a background job whose pid is still to be settled (`$!`),
	/// the subshell takes the job over: the external it spawns as its first
	/// command becomes the job's program, so `$!` and `jobs -l` show that
	/// program's OS pid, as for `cmd &`. Called while the host handles the
	/// [`Step::Call`](super::Step::Call), before it steps the shell again
	/// (later, the job already settled on its virtual pid).
	pub fn exec_subshell_in(&mut self, script: Script, lineage: Lineage) -> RunId {
		let run = self.run_subshell_in(script, lineage);
		let caller = self.vproc().vpid;
		let child = self.shell.k.spawned.last().map(|p| p.vpid);
		if let (Some(child), Some(bang)) = (
			child,
			self
				.shell
				.k
				.bangs
				.iter_mut()
				.find(|b| b.vproc == caller && b.stage == BangStage::Callout),
		) {
			bang.vproc = child;
			bang.stage = BangStage::Lone;
		}
		run
	}

	/// Lineage of the calling vproc.
	pub fn lineage(&self) -> Lineage {
		self.vproc().lineage
	}

	/// Print `name: line N: tool: msg` on the calling vproc's stderr (before
	/// its next command) and emit a `Diag` event.
	pub fn diag(&mut self, msg: &BStr) {
		let vp = &mut self.shell.procs[self.vp];
		let call = self.call;
		let tool = vp
			.frames
			.iter()
			.rev()
			.find_map(|f| {
				f.scratch
					.as_ref()
					.and_then(|s| s.exec.as_ref())
					.filter(|e| e.waiting == Some(Awaited::Call(call)))
			})
			.and_then(|e| e.argv.first().cloned())
			.unwrap_or_default();
		let node = vp
			.frames
			.last()
			.and_then(|f| f.unit.as_ref()?.ops.get(f.pc as usize))
			.map_or(0, |op| op.node);
		let line = super::exec::line_of(vp, node);
		self
			.shell
			.k
			.diag(self.cx, vp, line, Diag::Tool { tool, msg: msg.into() });
	}

	/// Emit a host-defined event in the shell's event stream.
	pub fn emit(&mut self, ev: CustomEvent) {
		let vp = &self.shell.procs[self.vp];
		self
			.shell
			.k
			.emit(self.cx, (vp.vpid, vp.mode), vp.runs.front(), EventData::Custom(&ev));
	}
}
