//! Durable custom-message presentation metadata shared by controllers and
//! actors.

use omp_core::Str;
use omp_dom::{KnownTag, NodeSpec, PropId, PropKey, Value};

/// Custom property retaining whether a transcript message is visible.
pub const DISPLAY_PROP: &str = "display";
/// Custom property naming the semantic frame treatment.
pub const PRESENTATION_PROP: &str = "presentation";
/// Custom property retaining the renderer-owning extension.
pub const RENDERER_EXTENSION_PROP: &str = "renderer-extension";
/// Custom property retaining the signed renderer declaration identity.
pub const RENDERER_DECLARATION_PROP: &str = "renderer-declaration";
/// Custom property retaining the exact live renderer generation.
pub const RENDERER_GENERATION_PROP: &str = "renderer-generation";
/// Custom property retaining extension-produced TML.
pub const RENDERED_TML_PROP: &str = "rendered-tml";

/// Stable producer role for a custom transcript message.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[strum(serialize_all = "kebab-case")]
pub enum CustomMessageKind {
	/// Extension-injected message.
	#[default]
	Custom,
	/// Legacy hook-injected message.
	Hook,
}

/// Semantic frame treatment retained independently from renderer output.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[strum(serialize_all = "kebab-case")]
pub enum CustomMessagePresentation {
	/// Ordinary framed extension message.
	#[default]
	Framed,
	/// Coding request delegated by the live voice model.
	LiveDelegation,
}

/// Exact authenticated renderer generation which produced replacement TML.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageRendererIdentity {
	/// Publisher-scoped extension identity.
	pub extension:   Str,
	/// Stable signed declaration identity.
	pub declaration: Str,
	/// Exact live child generation.
	pub generation:  u64,
}

/// Successful custom renderer result retained beside the semantic message.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RenderedMessage {
	/// Exact renderer which produced [`Self::tml`].
	pub renderer: MessageRendererIdentity,
	/// Extension-authored trusted markup, parsed only at the actor boundary.
	pub tml:      Str,
}

/// Custom message committed as a `<developer>` element in an explicit turn.
///
/// The semantic Markdown body remains authoritative. A renderer may replace
/// its presentation with TML, but replay and copy continue to use the original
/// body and a malformed renderer result therefore loses no content.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CustomMessage {
	/// Producer role.
	pub kind:         CustomMessageKind,
	/// Producer-chosen message type.
	pub custom_type:  Str,
	/// Semantic Markdown content projected into inference and copy.
	pub body:         Str,
	/// Whether transcript actors expose the message.
	pub display:      bool,
	/// Semantic frame treatment.
	pub presentation: CustomMessagePresentation,
	/// Successful renderer replacement, when one was available.
	pub rendered:     Option<RenderedMessage>,
}

impl CustomMessage {
	/// Creates one visible ordinary extension message.
	#[must_use]
	pub fn new(custom_type: impl Into<Str>, body: impl Into<Str>) -> Self {
		Self {
			kind:         CustomMessageKind::Custom,
			custom_type:  custom_type.into(),
			body:         body.into(),
			display:      true,
			presentation: CustomMessagePresentation::Framed,
			rendered:     None,
		}
	}

	/// Creates the visible no-header accent frame used for live delegation.
	#[must_use]
	pub fn live_delegation(body: impl Into<Str>) -> Self {
		Self {
			custom_type: Str::new_static("live-delegation"),
			presentation: CustomMessagePresentation::LiveDelegation,
			..Self::new(Str::new_static("live-delegation"), body)
		}
	}

	/// Attaches one authenticated replacement renderer result.
	#[must_use]
	pub fn with_rendered(mut self, renderer: MessageRendererIdentity, tml: impl Into<Str>) -> Self {
		self.rendered = Some(RenderedMessage { renderer, tml: tml.into() });
		self
	}

	/// Attaches an already-decoded extension runtime renderer result.
	#[must_use]
	pub fn with_renderer_result(mut self, rendered: RenderedMessage) -> Self {
		self.rendered = Some(rendered);
		self
	}

	/// Controls transcript visibility without removing the message from model
	/// context.
	#[must_use]
	pub const fn with_display(mut self, display: bool) -> Self {
		self.display = display;
		self
	}

	/// Returns the normalized handoff document for a visible legacy `handoff`
	/// message.
	///
	/// Older sessions persisted handoffs as custom messages instead of
	/// compaction entries. Missing wrapper tags preserve the whole trimmed body
	/// when the opening tag is absent, or everything after it when the closing
	/// tag is absent.
	#[must_use]
	pub fn legacy_handoff_document(&self) -> Option<Str> {
		(self.display && self.custom_type.as_str() == "handoff").then(|| {
			let document = extract_handoff_document(self.body.as_str());
			self.body.slice_ref(document)
		})
	}

	/// Materializes the replay-stable DOM element for this message.
	#[must_use]
	pub fn into_node(self) -> NodeSpec {
		let kind: &'static str = self.kind.into();
		let presentation: &'static str = self.presentation.into();
		let mut node = NodeSpec::new(KnownTag::Developer)
			.with_prop(PropId::Kind, Value::Str(Str::new_static(kind)))
			.with_prop(PropId::Name, Value::Str(self.custom_type))
			.with_prop(PropKey::Custom(Str::new_static(DISPLAY_PROP)), Value::Bool(self.display))
			.with_prop(
				PropKey::Custom(Str::new_static(PRESENTATION_PROP)),
				Value::Str(Str::new_static(presentation)),
			)
			.with_content(self.body);
		if let Some(rendered) = self.rendered {
			node = node
				.with_prop(
					PropKey::Custom(Str::new_static(RENDERER_EXTENSION_PROP)),
					Value::Str(rendered.renderer.extension),
				)
				.with_prop(
					PropKey::Custom(Str::new_static(RENDERER_DECLARATION_PROP)),
					Value::Str(rendered.renderer.declaration),
				)
				.with_prop(
					PropKey::Custom(Str::new_static(RENDERER_GENERATION_PROP)),
					Value::Str(Str::new(rendered.renderer.generation.to_string())),
				)
				.with_prop(
					PropKey::Custom(Str::new_static(RENDERED_TML_PROP)),
					Value::Str(rendered.tml),
				);
		}
		node
	}
}

/// Extracts the semantic document from a legacy `<handoff-context>` wrapper.
///
/// The first opening tag wins, the first following closing tag terminates it,
/// and malformed input falls back without dropping recoverable text.
#[must_use]
pub fn extract_handoff_document(text: &str) -> &str {
	const OPEN: &str = "<handoff-context>";
	const CLOSE: &str = "</handoff-context>";

	let document = text.find(OPEN).map_or(text, |open| {
		let body = &text[open + OPEN.len()..];
		body.find(CLOSE).map_or(body, |close| &body[..close])
	});
	document.trim()
}

#[cfg(test)]
mod tests {
	use omp_core::Str;

	use super::{CustomMessage, extract_handoff_document};

	#[test]
	fn legacy_handoff_extracts_the_first_wrapped_document() {
		let body =
			Str::new_static("preamble<handoff-context>\n# Goal\nShip it.\n</handoff-context>trailer");
		assert_eq!(extract_handoff_document(body.as_str()), "# Goal\nShip it.");
		assert_eq!(
			CustomMessage::new("handoff", body)
				.legacy_handoff_document()
				.as_deref(),
			Some("# Goal\nShip it.")
		);
	}

	#[test]
	fn malformed_legacy_handoff_keeps_all_recoverable_text() {
		let unwrapped = Str::new_static("  Earlier work remains.  ");
		assert_eq!(extract_handoff_document(unwrapped.as_str()), "Earlier work remains.");

		let unclosed = Str::new_static("ignored<handoff-context>\nContinue here.  ");
		assert_eq!(extract_handoff_document(unclosed.as_str()), "Continue here.");

		assert!(
			CustomMessage::new("handoff", "hidden")
				.with_display(false)
				.legacy_handoff_document()
				.is_none()
		);
		assert!(
			CustomMessage::new("other", "<handoff-context>not a handoff</handoff-context>")
				.legacy_handoff_document()
				.is_none()
		);
	}
}
