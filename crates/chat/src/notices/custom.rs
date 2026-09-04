//! Extension and hook messages: `<notice kind=custom|hook name=<type>>`
//! elements that the kernel journals into a `<turn>` (`EnvEvent::Notice`), so
//! they replay on resume, vanish on rewind, and reach every peer actor (ADR
//! 0005).

use omp_core::{Str, sf};
use omp_dom::{Node, PropId, PropKey, Value};
/// Which framed-message flavor a custom-message element selects.
pub use omp_session::custom_message::CustomMessageKind as CustomKind;
use omp_session::custom_message::{
	CustomMessageKind, CustomMessagePresentation, DISPLAY_PROP, MessageRendererIdentity,
	PRESENTATION_PROP, RENDERED_TML_PROP, RENDERER_DECLARATION_PROP, RENDERER_EXTENSION_PROP,
	RENDERER_GENERATION_PROP,
};
use omp_tui::{IntoComponent as _, MarkupOrigin, UiContext, dom, parse_component_with_origin};

use super::prop_text;
use crate::cards::Component;

/// Markdown body lines a hook message shows
/// before the `…` fold while the transcript is collapsed.
const HOOK_COLLAPSED_LINES: usize = 5;

/// Returns the custom-message role carried by `node`.
#[must_use]
pub fn message_kind(node: &Node) -> Option<CustomMessageKind> {
	prop_text(node, PropId::Kind)?.as_str().parse().ok()
}

/// Returns whether `node` participates in transcript and copy projections.
///
/// Old journals predate the property and remain visible.
#[must_use]
pub fn displayed(node: &Node) -> bool {
	!matches!(node.prop(&PropKey::Custom(Str::new_static(DISPLAY_PROP))), Some(Value::Bool(false)))
}

/// Returns the exact renderer identity only when every identity field is
/// present.
#[must_use]
pub fn renderer_identity(node: &Node) -> Option<MessageRendererIdentity> {
	let extension = node
		.prop(&PropKey::Custom(Str::new_static(RENDERER_EXTENSION_PROP)))?
		.as_str()?;
	let declaration = node
		.prop(&PropKey::Custom(Str::new_static(RENDERER_DECLARATION_PROP)))?
		.as_str()?;
	let generation = match node.prop(&PropKey::Custom(Str::new_static(RENDERER_GENERATION_PROP)))? {
		Value::Int(value) => u64::try_from(*value).ok()?,
		Value::Str(value) => value.parse().ok()?,
		_ => return None,
	};
	Some(MessageRendererIdentity {
		extension: Str::new(extension),
		declaration: Str::new(declaration),
		generation,
	})
}

/// Renders a journaled custom-message element: a rounded, muted-bordered box
/// with one cell of
/// padding, a bold `<icon> <name>` header row followed by a blank row when
/// the element names its type, and the Markdown body.
#[must_use]
pub fn custom_message_card(
	kind: CustomKind,
	node: &Node,
	expanded: bool,
	ui: &UiContext,
) -> Component {
	if let Some(component) = rendered_component(node, ui) {
		return component;
	}
	let name = prop_text(node, PropId::Name);
	let body = node.content.clone().unwrap_or_default();
	framed_message_with_presentation(kind, name, body, expanded, presentation(node))
}

/// [`custom_message_card`] over explicit fields.
#[must_use]
pub fn framed_message(kind: CustomKind, name: Option<Str>, body: Str, expanded: bool) -> Component {
	framed_message_with_presentation(kind, name, body, expanded, CustomMessagePresentation::Framed)
}

fn framed_message_with_presentation(
	kind: CustomKind,
	name: Option<Str>,
	body: Str,
	expanded: bool,
	presentation: CustomMessagePresentation,
) -> Component {
	let icon = match kind {
		CustomKind::Custom => "package",
		CustomKind::Hook => "hook",
	};
	let body = if kind == CustomKind::Hook && !expanded {
		fold_lines(body, HOOK_COLLAPSED_LINES)
	} else {
		body
	};
	if presentation == CustomMessagePresentation::LiveDelegation {
		return dom! {
			<box border=round bc=accent bg=surface pad="1 1">
				<md>{body}</md>
			</box>
		}
		.into_component();
	}
	if let Some(name) = name {
		dom! {
			<box border=round bc=border bg=surface pad="1 1">
				<row gap=1>
					<icon name={icon} fg=accent/>
					<text bold fg=accent>{name}</text>
				</row>
				<spacer/>
				<md>{body}</md>
			</box>
		}
		.into_component()
	} else {
		// An unnamed custom message is a compact three-row box: border,
		// body, border. Vertical padding belongs only to the named frame.
		dom! {
			<box border=round bc=border bg=surface pad-x=1>
				<md>{body}</md>
			</box>
		}
		.into_component()
	}
}

/// The header the copy selector and block descriptors carry for a framed
/// message: `[<name>]` on its own line above the body, when named.
#[must_use]
pub fn framed_text(node: &Node) -> Str {
	let body = node.content.clone().unwrap_or_default();
	if presentation(node) == CustomMessagePresentation::LiveDelegation {
		return body;
	}
	match prop_text(node, PropId::Name) {
		Some(name) => sf!("[{name}]\n{body}"),
		None => body,
	}
}

fn presentation(node: &Node) -> CustomMessagePresentation {
	node
		.prop(&PropKey::Custom(Str::new_static(PRESENTATION_PROP)))
		.and_then(Value::as_str)
		.and_then(|value| value.parse().ok())
		.unwrap_or_default()
}

fn rendered_component(node: &Node, ui: &UiContext) -> Option<Component> {
	renderer_identity(node)?;
	let source = node
		.prop(&PropKey::Custom(Str::new_static(RENDERED_TML_PROP)))?
		.as_str()?;
	parse_component_with_origin(&Str::new(source), ui, MarkupOrigin::Extension).ok()
}

/// Keeps the first `keep` lines, then adds `…`.
fn fold_lines(body: Str, keep: usize) -> Str {
	let mut lines = body.as_str().split('\n');
	let mut folded = String::with_capacity(body.len());
	for (index, line) in lines.by_ref().take(keep).enumerate() {
		if index != 0 {
			folded.push('\n');
		}
		folded.push_str(line);
	}
	if lines.next().is_none() {
		return body;
	}
	folded.push_str("\n…");
	Str::new(folded)
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use omp_dom::{KnownTag, PropId, Tag, Value};
	use omp_tui::{Ui, UiContext, frame_text, test_support::frame_cell_style};

	use super::*;

	fn rows(component: Component, width: u16) -> Vec<String> {
		let ui = Ui::from_root(component, width, UiContext::default());
		frame_text(ui.frame())
			.lines()
			.map(|row| row.trim_end().to_owned())
			.collect()
	}

	fn notice(kind: &'static str, name: Option<&'static str>, body: &'static str) -> Node {
		let mut node = Node {
			tag:     Tag::Known(KnownTag::Notice),
			props:   Default::default(),
			kids:    Vec::new(),
			content: Some(Str::new_static(body)),
		};
		node
			.props
			.push((PropId::Kind.into(), Value::Str(Str::new_static(kind))));
		if let Some(name) = name {
			node
				.props
				.push((PropId::Name.into(), Value::Str(Str::new_static(name))));
		}
		node
	}

	#[test]
	fn hook_box_renders_name_header_and_markdown() {
		let node = notice("hook", Some("pre-commit"), "Ran **3** checks\n\n- lint ok");
		let rows =
			rows(custom_message_card(CustomKind::Hook, &node, false, &UiContext::default()), 40);
		assert!(rows[0].starts_with('╭') && rows[0].ends_with('╮'), "{rows:?}");
		assert!(rows.last().is_some_and(|row| row.starts_with('╰')), "{rows:?}");
		let header = rows
			.iter()
			.position(|row| row.contains("pre-commit"))
			.expect("name row");
		assert!(rows[header].contains(omp_tui::Charset::default().icon(omp_tui::Icon::Hook)));
		assert!(
			rows[header + 1]
				.trim_matches(|c| c == '│' || c == ' ')
				.is_empty(),
			"blank row after the header"
		);
		let body = rows
			.iter()
			.position(|row| row.contains("Ran 3 checks"))
			.expect("markdown body");
		assert!(body > header, "{rows:?}");
		assert!(rows.iter().any(|row| row.contains("lint ok")), "{rows:?}");
		assert_eq!(CustomKind::Hook.to_string(), "hook");
		assert_eq!("custom".parse::<CustomKind>(), Ok(CustomKind::Custom));
		assert_eq!(framed_text(&node), "[pre-commit]\nRan **3** checks\n\n- lint ok");
	}

	#[test]
	fn hook_body_folds_after_five_lines_unless_expanded() {
		let node = notice("hook", Some("audit"), "l1\nl2\nl3\nl4\nl5\nl6\nl7");
		let collapsed =
			rows(custom_message_card(CustomKind::Hook, &node, false, &UiContext::default()), 30);
		assert!(collapsed.iter().any(|row| row.contains("l5")), "{collapsed:?}");
		assert!(!collapsed.iter().any(|row| row.contains("l6")), "{collapsed:?}");
		assert!(collapsed.iter().any(|row| row.contains('…')), "{collapsed:?}");
		let expanded =
			rows(custom_message_card(CustomKind::Hook, &node, true, &UiContext::default()), 30);
		assert!(expanded.iter().any(|row| row.contains("l7")), "{expanded:?}");
		assert!(!expanded.iter().any(|row| row.contains('…')), "{expanded:?}");
		// Extension messages never fold.
		let custom =
			rows(custom_message_card(CustomKind::Custom, &node, false, &UiContext::default()), 30);
		assert!(custom.iter().any(|row| row.contains("l7")), "{custom:?}");
		assert!(
			custom
				.iter()
				.any(|row| { row.contains(omp_tui::Charset::default().icon(omp_tui::Icon::Package)) })
		);
	}

	#[test]
	fn unnamed_message_has_no_header_row() {
		let node = notice("custom", None, "plain body");
		let rows =
			rows(custom_message_card(CustomKind::Custom, &node, false, &UiContext::default()), 30);
		assert_eq!(rows.len(), 3, "{rows:?}");
		assert!(rows[1].contains("plain body"), "{rows:?}");
		assert_eq!(framed_text(&node), "plain body");
	}

	#[test]
	fn authenticated_renderer_replaces_the_frame_and_failure_falls_back_to_markdown() {
		let mut node = notice("custom", Some("build"), "fallback **body**");
		node.props.push((
			PropKey::Custom(Str::new_static(RENDERER_EXTENSION_PROP)),
			Value::Str(Str::new_static("dev.example")),
		));
		node.props.push((
			PropKey::Custom(Str::new_static(RENDERER_DECLARATION_PROP)),
			Value::Str(Str::new_static("dev.example/render-build")),
		));
		node
			.props
			.push((PropKey::Custom(Str::new_static(RENDERER_GENERATION_PROP)), Value::Int(7)));
		node.props.push((
			PropKey::Custom(Str::new_static(RENDERED_TML_PROP)),
			Value::Str(Str::new_static("<callout kind=success>replacement</callout>")),
		));
		let replaced =
			rows(custom_message_card(CustomKind::Custom, &node, false, &UiContext::default()), 40);
		assert!(replaced.iter().any(|row| row.contains("replacement")), "{replaced:?}");
		assert!(!replaced.iter().any(|row| row.contains("fallback body")), "{replaced:?}");
		assert_eq!(
			renderer_identity(&node),
			Some(MessageRendererIdentity {
				extension:   Str::new_static("dev.example"),
				declaration: Str::new_static("dev.example/render-build"),
				generation:  7,
			})
		);

		// Known TML containers recover unclosed children at end-of-input, just
		// like HTML. Use an actual composition error to prove renderer failure
		// selects the semantic Markdown fallback.
		node
			.props
			.iter_mut()
			.find(|(key, _)| key.as_str() == RENDERED_TML_PROP)
			.expect("rendered TML")
			.1 = Value::Str(Str::new_static("<table><text>invalid</text></table>"));
		let fallback =
			rows(custom_message_card(CustomKind::Custom, &node, false, &UiContext::default()), 40);
		assert!(fallback.iter().any(|row| row.contains("build")), "{fallback:?}");
		assert!(fallback.iter().any(|row| row.contains("fallback body")), "{fallback:?}");
	}

	#[test]
	fn live_delegation_hides_the_header_and_uses_the_accent_frame() {
		let mut node = notice("custom", Some("live-delegation"), "Please inspect **auth**.");
		node.props.push((
			PropKey::Custom(Str::new_static(PRESENTATION_PROP)),
			Value::Str(Str::new_static("live-delegation")),
		));
		let ctx = UiContext::default();
		let accent = ctx.theme.accent;
		let ui = Ui::from_root(custom_message_card(CustomKind::Custom, &node, false, &ctx), 40, ctx);
		let text = frame_text(ui.frame());
		assert!(!text.contains("live-delegation"), "{text}");
		assert!(text.contains("Please inspect auth."), "{text}");
		assert_eq!(frame_cell_style(ui.frame(), 0, 0).foreground_color(), accent);
		assert_eq!(framed_text(&node), "Please inspect **auth**.");
	}

	#[test]
	fn absent_display_defaults_visible_and_false_is_hidden() {
		let mut node = notice("custom", Some("audit"), "body");
		assert!(displayed(&node));
		node
			.props
			.push((PropKey::Custom(Str::new_static(DISPLAY_PROP)), Value::Bool(false)));
		assert!(!displayed(&node));
	}
}
