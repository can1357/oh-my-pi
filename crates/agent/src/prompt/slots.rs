//! Deterministic named-slot assembly with semantic cache-stability bands.

use std::{array, sync::Arc};

use omp_core::{Hash32, Str};
use omp_dom::Dom;
use omp_proto::thread::v1::{self as thread, Item, item, part};
use omp_scribe::Props;
use strum::{Display, EnumString};

use super::PromptError;

/// Digest of one semantic prompt stability band.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
#[repr(transparent)]
pub struct BandHash([u8; 32]);

impl BandHash {
	/// Returns the digest bytes.
	#[must_use]
	pub const fn as_bytes(&self) -> &[u8; 32] {
		&self.0
	}
}

/// Semantic stability of a prompt contribution.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
#[strum(serialize_all = "lowercase")]
pub enum SlotClass {
	/// Immutable for the process lifetime.
	Frozen   = 0,
	/// Changes only after an explicit, journaled configuration event.
	Stable   = 1,
	/// Changes at a compaction or reset boundary.
	Dynamic  = 2,
	/// May change on every turn.
	Volatile = 3,
}

/// Fixed prompt-slot catalog.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
#[strum(serialize_all = "lowercase")]
pub enum SlotId {
	/// RFC and harness conventions.
	Conventions = 0,
	/// Agent identity.
	Role        = 1,
	/// Runtime capability announcements.
	Runtime     = 2,
	/// Tool and device inventory.
	Tools       = 3,
	/// Tool-use policy.
	Policy      = 4,
	/// Engineering workflow.
	Workflow    = 5,
	/// Installed skills.
	Skills      = 6,
	/// Standing rules.
	Rules       = 7,
	/// General guidance.
	Guidance    = 8,
	/// Workspace identity and files.
	Workspace   = 9,
	/// Compaction-epoch memory.
	Memory      = 10,
	/// Compaction-epoch standing instructions.
	Standing    = 11,
	/// Per-turn recall.
	Recall      = 12,
	/// Per-turn runtime status.
	Status      = 13,
	/// Delivery contract.
	Delivery    = 14,
}

/// Metadata for one prompt contribution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SlotDecl {
	/// Destination slot.
	pub slot:     SlotId,
	/// Declared stability band.
	pub class:    SlotClass,
	/// Stable owner identity used as a deterministic tie-break.
	pub owner:    Str,
	/// Descending order within one slot.
	pub priority: i16,
}

/// Streaming text sink supplied to a synchronous slot source.
pub trait PromptOut {
	/// Appends UTF-8 text to this contribution.
	fn write_str(&mut self, text: &str);
}

impl PromptOut for String {
	fn write_str(&mut self, text: &str) {
		self.push_str(text);
	}
}

/// Pure source for one registered contribution.
pub trait SlotSource: Send + Sync + 'static {
	/// Projects bytes from the authoritative DOM and derived template values.
	fn render(&self, dom: &Dom, props: &Props, out: &mut dyn PromptOut) -> Result<(), PromptError>;
}

/// One declaration paired with its pure source.
#[derive(Clone)]
pub struct SlotRegistration {
	/// Registration metadata.
	pub decl:   SlotDecl,
	/// Source providing the contribution bytes.
	pub source: Arc<dyn SlotSource>,
}

/// Deterministic mutation of one typed prompt slot.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SlotPatch {
	/// Appends content after registered contributions.
	Append {
		/// Destination slot.
		slot:     SlotId,
		/// Appended content.
		content:  Str,
		/// Descending order among appends.
		priority: i16,
	},
	/// Prepends content before registered contributions.
	Prepend {
		/// Destination slot.
		slot:     SlotId,
		/// Prepended content.
		content:  Str,
		/// Descending order among prepends.
		priority: i16,
	},
	/// Replaces all registered contributions in a slot.
	Override {
		/// Destination slot.
		slot:    SlotId,
		/// Complete replacement content.
		content: Str,
	},
	/// Removes every contribution in a slot.
	Elide {
		/// Destination slot.
		slot: SlotId,
	},
}

impl SlotPatch {
	const fn slot(&self) -> SlotId {
		match self {
			Self::Append { slot, .. }
			| Self::Prepend { slot, .. }
			| Self::Override { slot, .. }
			| Self::Elide { slot } => *slot,
		}
	}

	fn content_len(&self) -> usize {
		match self {
			Self::Append { content, .. }
			| Self::Prepend { content, .. }
			| Self::Override { content, .. } => content.len(),
			Self::Elide { .. } => 0,
		}
	}

	const fn priority(&self) -> i16 {
		match self {
			Self::Append { priority, .. } | Self::Prepend { priority, .. } => *priority,
			Self::Override { .. } | Self::Elide { .. } => 0,
		}
	}

	const fn kind_order(&self) -> u8 {
		match self {
			Self::Override { .. } | Self::Elide { .. } => 0,
			Self::Prepend { .. } => 1,
			Self::Append { .. } => 2,
		}
	}
}

/// Validated prompt patch collection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptPatchSet {
	patches:            Box<[SlotPatch]>,
	max_byte_expansion: usize,
}

impl PromptPatchSet {
	/// Default maximum callback-provided prompt bytes per render.
	pub const DEFAULT_MAX_BYTE_EXPANSION: usize = 64 * 1024;

	/// Validates and deterministically orders prompt patches.
	pub fn new(mut patches: Vec<SlotPatch>, max_byte_expansion: usize) -> Result<Self, PromptError> {
		let expansion = patches
			.iter()
			.fold(0usize, |total, patch| total.saturating_add(patch.content_len()));
		if expansion > max_byte_expansion {
			return Err(PromptError::BudgetExceeded { budget: max_byte_expansion, expansion });
		}
		const SLOT_COUNT: usize = SlotId::Delivery as usize + 1;
		let mut terminals = [false; SLOT_COUNT];
		let mut counts = [0u16; SLOT_COUNT];
		for patch in &patches {
			let slot = patch.slot() as usize;
			counts[slot] = counts[slot].saturating_add(1);
			if matches!(patch, SlotPatch::Override { .. } | SlotPatch::Elide { .. }) {
				if terminals[slot] || (matches!(patch, SlotPatch::Elide { .. }) && counts[slot] > 1) {
					return Err(PromptError::PatchConflict { slot: patch.slot() });
				}
				terminals[slot] = true;
			}
		}
		for patch in &patches {
			let slot = patch.slot() as usize;
			if matches!(patch, SlotPatch::Elide { .. }) && counts[slot] > 1 {
				return Err(PromptError::PatchConflict { slot: patch.slot() });
			}
		}
		patches.sort_by(|left, right| {
			left
				.slot()
				.cmp(&right.slot())
				.then(left.kind_order().cmp(&right.kind_order()))
				.then(right.priority().cmp(&left.priority()))
		});
		Ok(Self { patches: patches.into_boxed_slice(), max_byte_expansion })
	}

	/// Returns the ordered patches.
	#[must_use]
	pub fn patches(&self) -> &[SlotPatch] {
		&self.patches
	}

	/// Returns the accepted expansion ceiling.
	#[must_use]
	pub const fn max_byte_expansion(&self) -> usize {
		self.max_byte_expansion
	}
}

impl Default for PromptPatchSet {
	fn default() -> Self {
		Self {
			patches:            Box::new([]),
			max_byte_expansion: Self::DEFAULT_MAX_BYTE_EXPANSION,
		}
	}
}

/// Canonical system items separated into stability bands.
#[derive(Clone, Debug, PartialEq)]
pub struct PromptBands {
	/// Provider-facing items in Frozen, Stable, Dynamic, Volatile order.
	pub items:  [Vec<Item>; 4],
	/// Semantic digest for each corresponding band.
	pub hashes: [BandHash; 4],
}

impl PromptBands {
	/// Flattens the ordered bands into provider-facing items.
	#[must_use]
	pub fn into_items(self) -> Vec<Item> {
		self.items.into_iter().flatten().collect()
	}
}

/// A rendered canonical prompt and its band hashes.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderedPrompt {
	/// Ordered canonical system items.
	pub items: Arc<[Item]>,
	/// Semantic digest for each stability band.
	pub bands: [BandHash; 4],
}

/// Composes registered slots into a deterministic canonical source.
pub struct SlotAssembler {
	registrations: Vec<SlotRegistration>,
	patches:       PromptPatchSet,
}

impl SlotAssembler {
	/// Creates an assembler and establishes deterministic registration order.
	#[must_use]
	pub fn new(mut registrations: Vec<SlotRegistration>) -> Self {
		registrations.sort_by(|left, right| {
			left
				.decl
				.class
				.cmp(&right.decl.class)
				.then(left.decl.slot.cmp(&right.decl.slot))
				.then(right.decl.priority.cmp(&left.decl.priority))
				.then(left.decl.owner.cmp(&right.decl.owner))
		});
		Self { registrations, patches: PromptPatchSet::default() }
	}

	/// Installs one already-validated patch set.
	#[must_use]
	pub fn with_patches(mut self, patches: PromptPatchSet) -> Self {
		self.patches = patches;
		self
	}

	/// Renders the slots twice and rejects non-deterministic sources.
	pub fn render_banded(&self, dom: &Dom, props: &Props) -> Result<RenderedPrompt, PromptError> {
		let first = self.assemble(dom, props)?;
		let second = self.assemble(dom, props)?;
		if first != second {
			return Err(PromptError::VolatileSource);
		}
		let bands = first.hashes;
		Ok(RenderedPrompt { items: first.into_items().into(), bands })
	}

	fn assemble(&self, dom: &Dom, props: &Props) -> Result<PromptBands, PromptError> {
		const SLOT_COUNT: usize = SlotId::Delivery as usize + 1;
		let mut slot_bytes: [[String; SLOT_COUNT]; 4] =
			array::from_fn(|_| array::from_fn(|_| String::new()));
		let mut prepended = [[0usize; SLOT_COUNT]; 4];
		for registration in &self.registrations {
			registration.source.render(
				dom,
				props,
				&mut slot_bytes[registration.decl.class as usize][registration.decl.slot as usize],
			)?;
		}
		for patch in self.patches.patches() {
			let slot = patch.slot() as usize;
			let class = default_slot_class(patch.slot()) as usize;
			match patch {
				SlotPatch::Append { content, .. } => slot_bytes[class][slot].push_str(content),
				SlotPatch::Prepend { content, .. } => {
					slot_bytes[class][slot].insert_str(prepended[class][slot], content);
					prepended[class][slot] += content.len();
				},
				SlotPatch::Override { content, .. } => {
					for (index, band) in slot_bytes.iter_mut().enumerate() {
						band[slot].clear();
						prepended[index][slot] = 0;
					}
					slot_bytes[class][slot].push_str(content);
				},
				SlotPatch::Elide { .. } => {
					for (index, band) in slot_bytes.iter_mut().enumerate() {
						band[slot].clear();
						prepended[index][slot] = 0;
					}
				},
			}
		}
		let hashes = slot_bytes.each_ref().map(|slots| {
			hash_framed(
				slots
					.iter()
					.enumerate()
					.filter(|(_, content)| !content.is_empty())
					.map(|(slot, content)| (slot as u64, content.as_bytes())),
			)
		});
		let items = slot_bytes.map(|slots| {
			let text = slots.concat();
			if text.is_empty() {
				Vec::new()
			} else {
				vec![system_text(text)]
			}
		});
		Ok(PromptBands { items, hashes })
	}
}

pub fn hash_framed<'a>(contributions: impl IntoIterator<Item = (u64, &'a [u8])>) -> BandHash {
	let mut hasher = Hash32::hasher();
	for (tag, bytes) in contributions {
		hasher.update(tag.to_le_bytes());
		hasher.update((bytes.len() as u64).to_le_bytes());
		hasher.update(bytes);
	}
	BandHash(hasher.finalize().into_bytes())
}

const fn default_slot_class(slot: SlotId) -> SlotClass {
	match slot {
		SlotId::Conventions
		| SlotId::Role
		| SlotId::Runtime
		| SlotId::Workflow
		| SlotId::Delivery => SlotClass::Frozen,
		SlotId::Tools
		| SlotId::Policy
		| SlotId::Skills
		| SlotId::Rules
		| SlotId::Guidance
		| SlotId::Workspace => SlotClass::Stable,
		SlotId::Memory | SlotId::Standing => SlotClass::Dynamic,
		SlotId::Recall | SlotId::Status => SlotClass::Volatile,
	}
}

pub fn system_text(text: String) -> Item {
	Item {
		seq:           0,
		created_at_ms: 0,
		kind:          Some(item::Kind::Message(thread::Message {
			role:            thread::Role::System as i32,
			parts:           vec![thread::Part { kind: Some(part::Kind::Text(text)) }],
			synthetic:       None,
			user_initiated:  None,
			completed_at_ms: None,
			usage:           None,
		})),
		props:         None,
	}
}
