//! Canonical system prompts projected from the authoritative session DOM.

pub mod assets;
mod projection;
mod slots;

use omp_dom::Dom;
use omp_proto::thread::v1::Item;
use omp_scribe::{Props, Value};
pub use projection::{project_thread_with_attachments, template_props};
pub use slots::{
	BandHash, PromptBands, PromptOut, PromptPatchSet, RenderedPrompt, SlotAssembler, SlotClass,
	SlotDecl, SlotId, SlotPatch, SlotRegistration, SlotSource,
};
use thiserror::Error;

use self::slots::{hash_framed, system_text};

/// One immutable runtime-owned memory slot.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptMemorySlotInput {
	/// Slot-local revision.
	pub generation: u64,
	/// Fully framed, bounded contribution.
	pub content:    Option<omp_core::Str>,
}

/// Immutable Memory, Standing, and Recall slot snapshot.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptMemoryInput {
	/// Compaction-epoch memory background.
	pub memory:   PromptMemorySlotInput,
	/// Compaction-epoch non-directive guidance.
	pub standing: PromptMemorySlotInput,
	/// Per-turn volatile recall.
	pub recall:   PromptMemorySlotInput,
}

/// Canonical provider-facing prompt source.
#[derive(Clone, Copy, Debug, Default)]
pub struct CanonicalPromptSource;

impl crate::PromptSource for CanonicalPromptSource {
	fn system_items(&self, dom: &Dom) -> Result<Vec<Item>, PromptError> {
		Self::system_items(self, dom)
	}
}

impl CanonicalPromptSource {
	/// Projects system items and their Frozen, Stable, Dynamic, and Volatile
	/// hashes directly from `dom`.
	pub fn banded_render(&self, dom: &Dom) -> Result<(Vec<Item>, [BandHash; 4]), PromptError> {
		let props = template_props(dom);
		let bands = Self::candidate(dom, &props)?;
		let hashes = bands.hashes;
		Ok((bands.into_items(), hashes))
	}

	/// Projects canonical system items directly from `dom`.
	pub fn system_items(&self, dom: &Dom) -> Result<Vec<Item>, PromptError> {
		self.banded_render(dom).map(|(items, _)| items)
	}

	fn candidate(dom: &Dom, props: &Props) -> Result<PromptBands, PromptError> {
		if props.get("null_prompt").is_some_and(Value::is_truthy) {
			return Ok(PromptBands {
				items:  std::array::from_fn(|_| Vec::new()),
				hashes: [hash_framed(std::iter::empty()); 4],
			});
		}

		let engine = assets::engine();
		let scoped = props.with_dom(dom);
		let custom = props.get("custom_prompt").and_then(Value::as_str);
		let mut frozen = String::new();
		assets::conventions().render_scoped(engine, &scoped, &mut frozen)?;
		if custom.is_none() {
			assets::role().render_scoped(engine, &scoped, &mut frozen)?;
		}
		assets::runtime().render_scoped(engine, &scoped, &mut frozen)?;
		assets::workflow().render_scoped(engine, &scoped, &mut frozen)?;
		assets::delivery().render_scoped(engine, &scoped, &mut frozen)?;

		let mut stable = String::new();
		if let Some(custom) = custom {
			stable.push_str(custom);
			stable.push_str("\n\n");
		}
		assets::tool_policy().render_scoped(engine, &scoped, &mut stable)?;
		if let Some(append) = props.get("append_prompt").and_then(Value::as_str) {
			stable.push_str("\n§ Guidance\n");
			stable.push_str(append);
			stable.push('\n');
		}
		if props.get("computer").is_some_and(Value::is_truthy) {
			assets::computer_safety().render_scoped(engine, &scoped, &mut stable)?;
		}
		assets::project().render_scoped(engine, &scoped, &mut stable)?;
		if props.get("active_repository").is_some() {
			assets::active_repo().render_scoped(engine, &scoped, &mut stable)?;
		}

		let memory = memory_entries(props);
		let mut text = [vec![frozen], vec![stable], Vec::with_capacity(2), Vec::with_capacity(2)];
		for content in memory[..2].iter().flatten() {
			text[SlotClass::Dynamic as usize].push((*content).to_owned());
		}
		if let Some(content) = memory[2] {
			text[SlotClass::Volatile as usize].push(content.to_owned());
		}
		let status = assets::status().render_scoped_str(engine, &scoped)?;
		if !status.is_empty() {
			text[SlotClass::Volatile as usize].push(status.into());
		}
		let hashes = text.each_ref().map(|parts| {
			hash_framed(
				parts
					.iter()
					.enumerate()
					.map(|(index, part)| (index as u64, part.as_bytes())),
			)
		});
		let items = text.map(|parts| {
			parts
				.into_iter()
				.filter(|part| !part.is_empty())
				.map(system_text)
				.collect()
		});
		Ok(PromptBands { items, hashes })
	}
}

fn memory_entries(props: &Props) -> [Option<&str>; 3] {
	let Some(Value::Map(memory)) = props.get("memory") else {
		return [None; 3];
	};
	["memory", "standing", "recall"].map(|name| {
		memory
			.get(name)
			.and_then(Value::as_str)
			.filter(|content| !content.is_empty())
	})
}

/// Prompt projection failure.
#[derive(Debug, Error)]
pub enum PromptError {
	/// An embedded template failed to render from the projected DOM values.
	#[error(transparent)]
	Template(#[from] omp_scribe::Error),
	/// A source emitted different bytes for the same immutable DOM.
	#[error("prompt source emitted volatile output for an identical session tree")]
	VolatileSource,
	/// Two patches conflict at one typed slot.
	#[error("prompt patches conflict at slot {slot}")]
	PatchConflict {
		/// Conflicting slot.
		slot: SlotId,
	},
	/// Callback-provided prompt content exceeds its configured bound.
	#[error("prompt patch expansion {expansion} bytes exceeds budget {budget} bytes")]
	BudgetExceeded {
		/// Maximum accepted callback bytes.
		budget:    usize,
		/// Observed total callback bytes.
		expansion: usize,
	},
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn every_embedded_template_compiles() {
		assert_eq!(assets::system_templates().len(), 11);
	}

	#[test]
	fn canonical_source_is_deterministic_for_one_dom() {
		let dom = Dom::new();
		let first = CanonicalPromptSource.banded_render(&dom).unwrap();
		let second = CanonicalPromptSource.banded_render(&dom).unwrap();
		assert_eq!(first, second);
	}
}
