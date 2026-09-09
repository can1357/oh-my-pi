//! Immutable committed conversation revisions and zero-copy history deltas.
//!
//! Revisions are assigned only by atomic commit; private drafts deliberately
//! expose no provisional revision identity.

use std::sync::Arc;

use crate::id::{ConversationId, Revision, TurnId};

/// One immutable node in the committed conversation history DAG.
#[derive(Clone, Debug)]
pub struct CommittedRevision<I> {
	conversation: ConversationId,
	revision:     Revision,
	parent:       Option<Revision>,
	turn:         Option<TurnId>,
	items:        Arc<[I]>,
}

impl<I> CommittedRevision<I> {
	pub(crate) const fn new(
		conversation: ConversationId,
		revision: Revision,
		parent: Option<Revision>,
		turn: Option<TurnId>,
		items: Arc<[I]>,
	) -> Self {
		Self { conversation, revision, parent, turn, items }
	}

	/// Returns the conversation on whose branch this node was committed.
	pub fn conversation(&self) -> &ConversationId<str> {
		&self.conversation
	}

	/// Returns the immutable revision identity.
	pub fn revision(&self) -> &Revision<str> {
		&self.revision
	}

	/// Returns the preceding committed revision, if this is not a root.
	pub fn parent(&self) -> Option<&Revision<str>> {
		self.parent.as_deref()
	}

	/// Returns the idempotency identity of the committed turn.
	pub fn turn(&self) -> Option<&TurnId<str>> {
		self.turn.as_deref()
	}

	/// Returns the items appended by this revision.
	pub fn items(&self) -> &[I] {
		&self.items
	}

	/// Returns a clone-cheap handle to the appended items.
	pub fn shared_items(&self) -> Arc<[I]> {
		Arc::clone(&self.items)
	}
}

/// A delta represented as immutable revision segments without copying their
/// items.
#[derive(Clone, Debug)]
pub struct HistoryDelta<I> {
	base:     Option<Revision>,
	head:     Revision,
	segments: Arc<[Arc<[I]>]>,
}

impl<I> HistoryDelta<I> {
	pub(crate) fn new(base: Option<Revision>, head: Revision, segments: Vec<Arc<[I]>>) -> Self {
		Self { base, head, segments: segments.into() }
	}

	/// Returns the excluded base revision, or `None` for a complete replay.
	pub fn base(&self) -> Option<&Revision<str>> {
		self.base.as_deref()
	}

	/// Returns the included head revision.
	pub fn head(&self) -> &Revision<str> {
		&self.head
	}

	/// Returns the immutable per-revision item segments in canonical order.
	pub fn segments(&self) -> &[Arc<[I]>] {
		&self.segments
	}

	/// Iterates all items in canonical order without an intermediate collection.
	pub fn items(&self) -> impl DoubleEndedIterator<Item = &I> + Clone + '_ {
		self.segments.iter().flat_map(|segment| segment.iter())
	}

	/// Returns whether no items occur after the base.
	pub fn is_empty(&self) -> bool {
		self.segments.iter().all(|segment| segment.is_empty())
	}

	/// Returns the exact number of items in the delta.
	pub fn len(&self) -> usize {
		self.segments.iter().map(|segment| segment.len()).sum()
	}
}
