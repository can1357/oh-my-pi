//! Hierarchical cancellation for sessions, turns, and tool executions.
//!
//! Every tool scope carries two views of one stop (ADR 0011):
//!
//! - the *commit* token is what the tool's own atomic mutation observes. For a
//!   foreground mutation it is session-only: a turn interrupt never tears an
//!   in-flight commit in half, so a partially applied mutation is never
//!   reported as a clean interrupt;
//! - the *interrupt* token is the host's stop request. It fires on turn
//!   interruption or session cancellation for every scope, and the dispatcher
//!   answers it with cooperative settlement, a bounded grace, then forced
//!   termination journaled as uncertainty.

use tokio_util::sync::CancellationToken;

/// Root of a session cancellation hierarchy.
#[derive(Clone, Debug)]
pub struct CancelTree {
	session: CancellationToken,
}

impl CancelTree {
	/// Creates a live session cancellation tree.
	#[must_use]
	pub fn new() -> Self {
		Self { session: CancellationToken::new() }
	}

	/// Cancels the session and every current or future descendant.
	pub fn cancel_session(&self) {
		self.session.cancel();
	}

	/// Reports whether the session has been cancelled.
	#[must_use]
	pub fn is_session_cancelled(&self) -> bool {
		self.session.is_cancelled()
	}

	/// Returns a child token for host-owned work that must end at the session
	/// boundary but may outlast one ordinary turn.
	#[must_use]
	pub fn session_child(&self) -> CancellationToken {
		self.session.child_token()
	}

	/// Starts one cancellation scope beneath the session root.
	#[must_use]
	pub fn begin_turn(&self) -> TurnCancellation {
		TurnCancellation { session: self.session.clone(), turn: self.session.child_token() }
	}
}

impl Default for CancelTree {
	fn default() -> Self {
		Self::new()
	}
}

/// Cancellation scope for one turn.
#[derive(Clone, Debug)]
pub struct TurnCancellation {
	session: CancellationToken,
	turn:    CancellationToken,
}

impl TurnCancellation {
	/// Interrupts this turn: every tool scope's interrupt token fires, while
	/// an in-flight foreground mutation keeps its session-only commit token.
	pub fn cancel_turn(&self) {
		self.turn.cancel();
	}

	/// Reports whether this turn was interrupted, including session
	/// cancellation.
	#[must_use]
	pub fn is_turn_cancelled(&self) -> bool {
		self.turn.is_cancelled()
	}

	/// Issues the foreground-mutation scope: a session-only commit token plus
	/// this turn's interrupt token.
	#[must_use]
	pub fn foreground_mutation(&self) -> ForegroundMutationCancellation {
		ForegroundMutationCancellation {
			commit:    self.session.clone(),
			interrupt: self.turn.child_token(),
		}
	}

	/// Issues a turn-scoped child token for a read-only tool.
	#[must_use]
	pub fn read_only_tool(&self) -> ReadOnlyToolCancellation {
		ReadOnlyToolCancellation { token: self.turn.child_token() }
	}

	/// Issues a turn-scoped child token for background work.
	#[must_use]
	pub fn background_tool(&self) -> BackgroundToolCancellation {
		BackgroundToolCancellation { token: self.turn.child_token() }
	}
}

/// Cancellation issued to a foreground mutating tool.
#[derive(Clone, Debug)]
pub struct ForegroundMutationCancellation {
	commit:    CancellationToken,
	interrupt: CancellationToken,
}

impl ForegroundMutationCancellation {
	/// Returns the session-only commit token the mutation observes.
	#[must_use]
	pub fn token(&self) -> CancellationToken {
		self.commit.clone()
	}

	/// Returns the host stop request: turn interruption or session
	/// cancellation.
	#[must_use]
	pub fn interrupt_token(&self) -> CancellationToken {
		self.interrupt.clone()
	}

	/// Reports whether the owning session was cancelled.
	#[must_use]
	pub fn is_cancelled(&self) -> bool {
		self.commit.is_cancelled()
	}

	/// Reports whether the host requested a stop.
	#[must_use]
	pub fn is_interrupted(&self) -> bool {
		self.interrupt.is_cancelled()
	}
}

/// Turn/tool cancellation issued to a read-only tool.
#[derive(Clone, Debug)]
pub struct ReadOnlyToolCancellation {
	token: CancellationToken,
}

impl ReadOnlyToolCancellation {
	/// Returns the cancellation token.
	#[must_use]
	pub fn token(&self) -> CancellationToken {
		self.token.clone()
	}

	/// Cancels this tool without cancelling its turn or session.
	pub fn cancel_tool(&self) {
		self.token.cancel();
	}

	/// Reports whether this tool, its turn, or its session was cancelled.
	#[must_use]
	pub fn is_cancelled(&self) -> bool {
		self.token.is_cancelled()
	}
}

/// Turn/tool cancellation issued to background work.
#[derive(Clone, Debug)]
pub struct BackgroundToolCancellation {
	token: CancellationToken,
}

impl BackgroundToolCancellation {
	/// Adopts a host-supervised cancellation token for a session-owned job.
	#[must_use]
	pub const fn from_token_for_host(token: CancellationToken) -> Self {
		Self { token }
	}

	pub(crate) const fn from_token(token: CancellationToken) -> Self {
		Self { token }
	}

	/// Returns the cancellation token.
	#[must_use]
	pub fn token(&self) -> CancellationToken {
		self.token.clone()
	}

	/// Cancels this tool without cancelling its turn or session.
	pub fn cancel_tool(&self) {
		self.token.cancel();
	}

	/// Reports whether this tool, its turn, or its session was cancelled.
	#[must_use]
	pub fn is_cancelled(&self) -> bool {
		self.token.is_cancelled()
	}
}
