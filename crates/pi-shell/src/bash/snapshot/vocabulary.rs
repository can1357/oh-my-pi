//! The extensible part of a shell image, outside the frozen execution core.
//!
//! # Allocation and version rule
//!
//! Allocate each identifier in `ALLOCATIONS` once; never reuse it for another
//! meaning. Change its payload revision when its encoding or meaning changes.
//! The owner declares required or optional at allocation; unclear necessity is
//! required. That declaration applies even when this reader has no decoder for
//! the payload revision, and a writer cannot downgrade a required allocation.
//! A wrongly optional entry can silently lose execution state; a wrongly
//! required entry only refuses an image that could have been resumed.
//!
//! Adding an entry does not change `FRAMES_VERSION` or `Engine::build_id`.
//! Do not add fields or enum variants to the frozen core. A core change that
//! cannot be expressed by an entry needs a deliberate core-version change and
//! a stated migration or rejection policy for every supported earlier version.
//!
//! # Historical Misc allocations
//!
//! The frozen legacy table uses 0..=73. Existing job images also allocated
//! 74 (`BgPids`), 75 (`BangSeen`) and 76 (`JobFrames`). They stay legacy
//! records, including in stores without Frames. Readers that do not interpret
//! them preserve their numeric keys and values and report a record loss. Do not
//! allocate more state in that space: use this vocabulary.

use std::borrow::Cow;

use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::bash::{Incompatibility, Lost, RestoreError, Shell, Vpid};

mod codec;
pub(crate) use codec::{capture, find};

/// Start of the identifier range reserved exclusively for mechanism tests.
/// Production consumers must never allocate an identifier in this range.
pub const TEST_IDENTIFIER_START: u32 = 65536;
/// Inclusive end of the test-only range. Test codecs require both `test` and
/// `debug_assertions`; even release-mode test binaries cannot contain them.
pub const TEST_IDENTIFIER_END: u32 = 131071;

pub(crate) const fn codec_allowed(id: u32) -> bool {
	id < TEST_IDENTIFIER_START || id > TEST_IDENTIFIER_END || cfg!(all(test, debug_assertions))
}

/// A permanent allocation in the image vocabulary.
#[derive(Clone, Copy, Debug)]
pub struct Definition {
	/// Identifier allocated once in this module.
	pub id:        u32,
	/// Version of this entry's payload encoding and meaning.
	pub revision:  u32,
	/// Whether a reader must understand the payload to resume execution.
	pub required:  bool,
	/// Whether each record must identify its owning virtual process.
	pub per_vproc: bool,
}
/// A built-in owner of a vocabulary entry. The supported set is fixed by the
/// build, never registered or reduced through `EngineConfig`. Implementations
/// live beside their runtime state and use their reserved Definition here.
pub(crate) trait Codec: Sync {
	fn definition(&self) -> Definition;

	/// Capture current state, emitting only this definition's entries. A
	/// per-vproc definition emits one entry per owning process, with Some(vpid).
	fn capture(&self, shell: &Shell, entries: &mut Vec<Entry>) -> Result<(), postcard::Error>;

	/// Apply a preflighted entry after the core exists and before Frames is
	/// deleted. Decode the payload once here; do not alter the frozen core.
	fn restore(&self, shell: &mut Shell, entry: Entry) -> Result<(), RestoreError>;
}

impl Definition {
	/// Serialize a typed payload using this allocation's declaration and owner.
	pub fn encode<T: Serialize>(
		self,
		vpid: Option<Vpid>,
		payload: &T,
	) -> Result<Entry, postcard::Error> {
		if self.per_vproc != vpid.is_some() {
			return Err(postcard::Error::SerdeSerCustom);
		}
		Ok(Entry {
			id: self.id,
			revision: self.revision,
			required: self.required,
			vpid,
			payload: postcard::to_stdvec(payload)?,
		})
	}

	/// Decode exactly one payload value after matching its declaration.
	pub fn decode<T: DeserializeOwned>(self, entry: &Entry) -> Result<T, postcard::Error> {
		if !self.matches(entry) {
			return Err(postcard::Error::SerdeDeCustom);
		}
		let (payload, rest) = postcard::take_from_bytes(&entry.payload)?;
		if !rest.is_empty() {
			return Err(postcard::Error::DeserializeBadEncoding);
		}
		Ok(payload)
	}

	pub(crate) const fn matches(self, entry: &Entry) -> bool {
		self.id == entry.id
			&& self.revision == entry.revision
			&& self.required == entry.required
			&& self.per_vproc == entry.vpid.is_some()
	}
}

/// Per-vproc, per-signal pending-trap scan state. Required, payload revision 1.
///
/// The pending-trap consumer owns the payload codec. A reader without that
/// codec refuses this entry; allocation alone does not imply decoder support.
pub const PENDING_TRAP_SCAN: Definition =
	Definition { id: 1, revision: 1, required: true, per_vproc: true };

// Requiredness belongs to the allocated identifier, not a decoder revision.
// Add each allocation here independently of whether its codec is implemented.
const ALLOCATIONS: &[(u32, bool)] = &[
	(PENDING_TRAP_SCAN.id, PENDING_TRAP_SCAN.required),
	// Reserved mechanism witnesses: these identifiers carry no state and have
	// no codec in any build. They prove required and optional allocation policy
	// without allocating a production consumer in the test-only range.
	(TEST_IDENTIFIER_START, true),
	(TEST_IDENTIFIER_START + 2, false),
];

/// One length-delimited record in the shared image vocabulary.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
	/// Permanent vocabulary identifier.
	pub id:       u32,
	/// Payload revision, independent of the frozen core version.
	pub revision: u32,
	/// Whether understanding the payload is necessary to resume safely.
	pub required: bool,
	/// Owning virtual process, or `None` for shell-wide state.
	pub vpid:     Option<Vpid>,
	/// Opaque bytes; an unknown optional entry survives write-back unchanged.
	pub payload:  Vec<u8>,
}

impl Entry {
	pub(crate) fn preflight(&self) -> Result<(), RestoreError> {
		if let Some(codec) = find(self) {
			if !codec.definition().matches(self) {
				return Err(RestoreError::Corrupt(postcard::Error::SerdeDeCustom));
			}
			return Ok(());
		}
		// A writer cannot downgrade an allocation even when no decoder matches
		// this revision. Unallocated identifiers still use the writer's flag.
		if self.required
			|| ALLOCATIONS
				.iter()
				.any(|&(id, required)| id == self.id && required)
		{
			return Err(RestoreError::Incompatible {
				why: Incompatibility::Vocabulary {
					id:       self.id,
					revision: self.revision,
					vpid:     self.vpid,
				},
			});
		}
		Ok(())
	}

	pub(crate) const fn loss(&self) -> Lost {
		Lost::Vocabulary { id: self.id, revision: self.revision, vpid: self.vpid }
	}
}

/// OBF2's complete body: one delimited legacy core and its vocabulary records.
/// The core is borrowed while decoding and is not copied by the reader.
#[derive(Serialize, Deserialize)]
pub(crate) struct Envelope<'a> {
	#[serde(borrow)]
	pub core:    &'a [u8],
	pub entries: Cow<'a, [Entry]>,
}
