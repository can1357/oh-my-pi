use omp_core::Str;
use omp_journal::EntryId;
use serde::{Deserialize, Serialize};

use crate::{Handle, Op, PropKey, Sid, StreamOp};

/// One committed ADR `patch@1` payload published to subscribed actors.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct Patch {
	/// Journal entry that caused the patch.
	pub cause: EntryId,
	/// Previous live-chain entry when the patch changes branches.
	pub prior: Option<EntryId>,
	/// Optional semantic operation label.
	pub label: Option<Str>,
	/// Closed ADR operations: insert, remove, set, and move.
	pub ops:   Vec<Op>,
}

/// One ordered DOM subscription event.
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
	/// An atomic `patch@1` transaction.
	Patch(Patch),
	/// Replace the replica state after branch navigation.
	Reset {
		/// Complete target materialization.
		snapshot: crate::Snapshot,
	},
	/// A journal `stream@1` delta outside the closed patch operation vocabulary.
	Stream {
		/// Journal entry that caused the stream mutation.
		cause: EntryId,
		/// Stream identity.
		sid:   Sid,
		/// Stream operation.
		op:    StreamOp,
		/// Target node, present only for open.
		node:  Option<Handle>,
		/// Target property, present only for open.
		prop:  Option<PropKey>,
		/// Incoming delta, present only for append.
		text:  Option<Str>,
	},
}
