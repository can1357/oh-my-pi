//! Host-owned registry seam for routing between live session kernels.

use std::sync::{
	Arc,
	atomic::{AtomicUsize, Ordering},
};

use omp_core::Str;
use omp_dom::Snapshot;
use parking_lot::RwLock;

use crate::Up;

/// Recipient-side obligations that must settle before an ordinary turn can
/// release its controller.
///
/// The count is runtime coordination, not durable state. Each accepted
/// side-channel request owns one guard; dropping the guard wakes the turn
/// boundary even on inference failure or cancellation.
#[derive(Clone, Default)]
pub struct ReplyObligations {
	inner: Arc<ReplyObligationsInner>,
}

#[derive(Default)]
struct ReplyObligationsInner {
	pending: AtomicUsize,
	notify:  tokio::sync::Notify,
}

impl ReplyObligations {
	/// Registers one accepted side-channel reply.
	#[must_use]
	pub fn begin(&self) -> ReplyObligation {
		self.inner.pending.fetch_add(1, Ordering::AcqRel);
		ReplyObligation { obligations: self.clone() }
	}

	/// Whether any recipient-owned reply has not settled.
	#[must_use]
	pub fn is_pending(&self) -> bool {
		self.inner.pending.load(Ordering::Acquire) != 0
	}

	/// Resolves after every currently registered obligation settles.
	pub async fn wait(&self) {
		loop {
			let notified = self.inner.notify.notified();
			if !self.is_pending() {
				return;
			}
			notified.await;
		}
	}
}

/// Drop guard for one automatic peer reply obligation.
pub struct ReplyObligation {
	obligations: ReplyObligations,
}

impl Drop for ReplyObligation {
	fn drop(&mut self) {
		if self
			.obligations
			.inner
			.pending
			.fetch_sub(1, Ordering::AcqRel)
			== 1
		{
			self.obligations.inner.notify.notify_one();
		}
	}
}

/// Authenticated request for a recipient-owned automatic peer reply.
///
/// The routing host resolves both endpoint identities before constructing this
/// envelope. A responder still revalidates them at completion so a session
/// switch cannot deliver a stale side-channel result.
#[derive(Clone, Debug)]
pub struct AutoreplyRequest {
	/// Stable identity assigned to the incoming message.
	pub message_id: Str,
	/// Stable sender session identity.
	pub from_id:    Str,
	/// Authenticated sender routing name.
	pub from:       Str,
	/// Stable recipient session identity.
	pub to_id:      Str,
	/// Authenticated recipient routing name.
	pub to:         Str,
	/// Incoming peer text.
	pub body:       Str,
	/// Prior message identity supplied by the sender, when threaded.
	pub reply_to:   Option<Str>,
}

/// Recipient-owned side-channel response producer.
///
/// Implementations start at most one ephemeral model request for an accepted
/// envelope and return whether this recipient currently owes that automatic
/// reply. Durable observations and ordinary peer delivery remain controller
/// mailbox operations performed after the model result exists.
pub trait PeerAutoreply: Send + Sync {
	/// Runtime generation used to reject completion after a session switch.
	fn generation(&self) -> Str;

	/// Starts an automatic reply when the recipient's ordinary turn is busy.
	fn start(&self, request: AutoreplyRequest) -> bool;

	/// Rebinds the producer to a newly selected journal on the same kernel.
	fn rebind(&self, blobs: omp_journal::blob::BlobStore);

	/// Cancels every in-flight reply at the owning session boundary.
	fn cancel(&self);
}

/// Host-authenticated role of one live session in the relay topology.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SessionRole {
	/// Root controller whose transcript receives third-party relay observations.
	Main,
	/// Descendant controller whose peer traffic may be observed by its root.
	Child,
}

/// Host-owned ancestry for one live session.
///
/// Routing names are presentation aliases and never participate in ancestry.
/// The stable ids here are authenticated against the live authority before a
/// relay is produced.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionTopology {
	/// Controller role.
	pub role:      SessionRole,
	/// Direct parent session for a child.
	pub parent_id: Option<Str>,
	/// Root session whose transcript owns relay observations.
	pub main_id:   Str,
}

impl SessionTopology {
	/// Creates a root topology bound to `id`.
	#[must_use]
	pub const fn main(id: Str) -> Self {
		Self { role: SessionRole::Main, parent_id: None, main_id: id }
	}

	/// Creates a child topology under an authenticated parent and root.
	#[must_use]
	pub const fn child(parent_id: Str, main_id: Str) -> Self {
		Self { role: SessionRole::Child, parent_id: Some(parent_id), main_id }
	}

	/// Rebinds the topology after the same controller selects another session.
	#[must_use]
	pub fn rebind(&self, id: Str) -> Self {
		match self.role {
			SessionRole::Main => Self::main(id),
			SessionRole::Child => self.clone(),
		}
	}
}

/// Cloneable control and projection endpoint for one live session.
///
/// The host may cache this disposable endpoint, but durable identity and state
/// remain in the session journal and DOM.
#[derive(Clone)]
pub struct SessionEndpoint {
	/// Stable session identity.
	pub id:        Str,
	/// Human-readable session name.
	pub name:      Str,
	/// The kernel's sole upward control mailbox.
	pub up:        flume::Sender<Up>,
	/// Latest detached DOM snapshot published by the controller.
	pub snapshot:  Arc<RwLock<Snapshot>>,
	/// Authenticated host-owned ancestry and root role.
	pub topology:  SessionTopology,
	/// Recipient-owned automatic reply producer, when composed.
	pub autoreply: Option<Arc<dyn PeerAutoreply>>,
}

/// Read-only routing authority injected by the host composition.
///
/// Implementations are runtime indexes only. They must be rebuilt from live
/// sessions and must not become a second durable source of truth.
pub trait SessionAuthority: Send + Sync {
	/// Looks up a live session by stable id or name.
	fn lookup(&self, id_or_name: &str) -> Option<SessionEndpoint>;

	/// Lists all currently addressable live sessions.
	fn list(&self) -> Vec<SessionEndpoint>;

	/// Resolves the live main endpoint for authenticated third-party traffic.
	///
	/// Implementations must reject stale endpoint generations, traffic with a
	/// main endpoint on either side, unrelated roots, disconnected roots, and
	/// roots whose current relay policy is disabled.
	fn relay_target(&self, from: &SessionEndpoint, to: &SessionEndpoint) -> Option<SessionEndpoint>;
}
