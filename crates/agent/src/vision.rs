//! Image-input policy for attachments and `Read.question`: the journaled
//! `ai_vision` convar decides whether image parts reach the model. `auto`
//! follows the route's image capability; `off` always replaces images by a
//! text placeholder; `on` always sends them. Read from the session tree's
//! `<con>` component so replay and resume see the same request the live
//! turn built (ADR 0012 replay honesty).

use std::sync::Arc;

use omp_ai::{ContentPart, MediaInput, Message, ToolResultContent};
use omp_core::{Str, sf};
use omp_dom::{Dom, PropId, PropKey, Value};

use crate::{VisionMode, director::RouteFacts};

/// Text standing in for an image the policy withholds.
const OMITTED: &str =
	"[image omitted: the current vision policy does not send images to this model]";

/// The journaled `ai_vision` mode, `auto` when unset.
#[must_use]
pub fn mode(dom: &Dom) -> VisionMode {
	let Ok(vars) = dom.select("con var") else {
		return VisionMode::Auto;
	};
	vars
		.into_iter()
		.filter_map(|handle| dom.get(handle))
		.find(|node| {
			node
				.prop(&PropKey::from(PropId::Name))
				.or_else(|| node.prop(&PropKey::Custom(Str::new_static("name"))))
				.and_then(Value::as_str)
				== Some("ai_vision")
		})
		.and_then(|node| {
			node
				.prop(&PropKey::from(PropId::Value))
				.or_else(|| node.prop(&PropKey::Custom(Str::new_static("value"))))
		})
		.and_then(|value| value.as_str()?.parse().ok())
		.unwrap_or_default()
}

/// Whether images flow for `mode` on `route`.
#[must_use]
pub const fn sends_images(mode: VisionMode, route: &RouteFacts) -> bool {
	match mode {
		VisionMode::On => true,
		VisionMode::Off => false,
		VisionMode::Auto => route.image_input,
	}
}

/// Applies the policy to a projected request: image parts in user messages
/// and tool results become [`OMITTED`] text when images must not flow.
pub fn apply(dom: &Dom, route: &RouteFacts, messages: &mut [Message]) {
	if sends_images(mode(dom), route) {
		return;
	}
	for message in messages.iter_mut() {
		if !message.content.iter().any(carries_image) {
			continue;
		}
		let content = message.content.iter().map(strip_part).collect::<Vec<_>>();
		message.content = Arc::from(content);
	}
}

fn carries_image(part: &ContentPart) -> bool {
	match part {
		ContentPart::Image(_) => true,
		ContentPart::ToolResult { content, .. } => content
			.iter()
			.any(|item| matches!(item, ToolResultContent::Image(_))),
		_ => false,
	}
}

fn strip_part(part: &ContentPart) -> ContentPart {
	match part {
		ContentPart::Image(media) => ContentPart::Text { text: placeholder(media), proof: None },
		ContentPart::ToolResult { call, name, content, is_error } => ContentPart::ToolResult {
			call:     call.clone(),
			name:     name.clone(),
			content:  content
				.iter()
				.map(|item| match item {
					ToolResultContent::Image(media) => ToolResultContent::Text(placeholder(media)),
					other => other.clone(),
				})
				.collect::<Vec<_>>()
				.into(),
			is_error: *is_error,
		},
		other => other.clone(),
	}
}

fn placeholder(media: &MediaInput) -> Str {
	match media {
		MediaInput::Remote { name: Some(name), .. } | MediaInput::Body { name: Some(name), .. } => {
			sf!("{OMITTED} ({name})")
		},
		_ => Str::new_static(OMITTED),
	}
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_ai::Role;

	use super::*;

	fn image_message() -> Message {
		Message {
			role:    Role::User,
			content: Arc::from([
				ContentPart::Text { text: Str::new_static("look"), proof: None },
				ContentPart::Image(MediaInput::Bytes {
					media_type: Str::new_static("image/png"),
					data:       Bytes::from_static(b"png"),
				}),
			]),
			name:    None,
		}
	}

	#[test]
	fn auto_follows_the_route_and_off_strips_images() {
		let no_images = RouteFacts { image_input: false, ..RouteFacts::default() };
		let images = RouteFacts { image_input: true, ..RouteFacts::default() };
		assert!(!sends_images(VisionMode::Auto, &no_images));
		assert!(sends_images(VisionMode::Auto, &images));
		assert!(sends_images(VisionMode::On, &no_images));
		assert!(!sends_images(VisionMode::Off, &images));
		let dom = Dom::new();
		assert_eq!(mode(&dom), VisionMode::Auto);
		let mut messages = vec![image_message()];
		apply(&dom, &images, &mut messages);
		assert!(matches!(messages[0].content[1], ContentPart::Image(_)));
		apply(&dom, &no_images, &mut messages);
		assert!(
			matches!(&messages[0].content[1], ContentPart::Text { text, .. } if text.contains("image omitted"))
		);
	}
}
