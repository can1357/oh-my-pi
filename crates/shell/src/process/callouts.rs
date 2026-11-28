//! The host callouts of a process shell: pi's extras that run command lines
//! (`awk`, `perl`, `xargs`, `find`, …), which its host resolves to
//! [`Resolved::Tool`](crate::bash::Resolved::Tool) when it offers extras
//! ahead of `PATH` ([`ExtrasOrder::BeforePath`](super::ExtrasOrder)).
//!
//! A drive loop owns one [`Callouts`]: it hands over every
//! [`Step::Call`](crate::bash::Step::Call) and every `Done` of a run that is
//! not its own (the commands' subshells), polls it on each turn, and stops
//! waiting when a callout's worker rings ([`super::wait_runnable`]).

use std::{
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	task::{Wake, Waker},
};

use super::NativeHost;
use crate::{
	bash::{CallId, CallOutcome, Cx, MemStore, RunId, Shell, ToolCall},
	sys::Parker,
	tools::ToolCalls,
};

/// The callouts in flight; started at the first call.
pub struct Callouts {
	/// `None` until the first call, so a script that makes none starts no
	/// runtime.
	tools: Option<ToolCalls>,
	bell:  Arc<Bell>,
}

/// What a callout's worker rings: the driver's parker, and a flag telling
/// the wait that the callouts have news.
struct Bell {
	rung:   AtomicBool,
	parker: Waker,
}

impl Wake for Bell {
	fn wake(self: Arc<Self>) {
		self.wake_by_ref();
	}

	fn wake_by_ref(self: &Arc<Self>) {
		self.rung.store(true, Ordering::Release);
		self.parker.wake_by_ref();
	}
}

impl Callouts {
	/// Callouts whose workers wake the drive loop parked in `parker`.
	pub fn new(parker: &Parker) -> Self {
		Self {
			tools: None,
			bell:  Arc::new(Bell { rung: AtomicBool::new(false), parker: parker.waker().clone() }),
		}
	}

	/// Start the callout `id` the engine returned. A host that offers no
	/// tools (extras after `PATH`, or their runtime failed to start) answers
	/// it with an error.
	pub fn on_call(
		&mut self,
		shell: &mut Shell,
		host: &mut NativeHost,
		store: &mut MemStore,
		id: CallId,
		call: ToolCall,
	) {
		if self.tools.is_none() {
			self.tools = host.tool_calls(Waker::from(Arc::clone(&self.bell)));
		}
		match &mut self.tools {
			Some(tools) => tools.on_call(shell, &mut Cx { host, store }, id, call),
			None => shell.complete(
				id,
				CallOutcome::Error("host callouts are not available in this shell".into()),
			),
		}
	}

	/// `run`, a script other than the drive loop's own, ended with `status`:
	/// a subshell of a callout.
	pub fn on_done(&mut self, shell: &Shell, run: RunId, status: i32) {
		if let Some(tools) = &mut self.tools {
			tools.on_done(run, status, shell.exec_signal(run), shell.run_usage(run));
		}
	}

	/// Let the callouts in flight make progress, answering those that
	/// finished.
	pub fn poll(&mut self, shell: &mut Shell, host: &mut NativeHost, store: &mut MemStore) {
		if let Some(tools) = &mut self.tools {
			tools.poll(shell, &mut Cx { host, store });
		}
	}

	/// Whether a worker rang since the last call: the wait ends so the loop
	/// polls the callouts.
	pub(super) fn rung(&self) -> bool {
		self.bell.rung.swap(false, Ordering::AcqRel)
	}
}
