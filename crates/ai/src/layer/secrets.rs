//! Provider-bound secret projection and inbound restoration.

use std::sync::Arc;

use omp_core::Str;
use omp_secrets::{
	json::{deobfuscate_json, obfuscate_json},
	message::{MessageTextKind, obfuscate_message_text, restore_message_text},
	obfuscator::SecretObfuscator,
	stream::PlaceholderStream,
};

use crate::call::{ContentPart, Message, OpaqueJson, Role, ToolResultContent};

/// Applies the provider-bound transform after semantic projection and before
/// codec encoding.
///
/// The authoritative journal messages are not accepted mutably by this API;
/// callers pass the disposable D1 projection. Tool schemas, system
/// instructions, reasoning, and media are skipped.
pub fn obfuscate_provider_messages(messages: &mut [Message], obfuscator: &mut SecretObfuscator) {
	for message in messages {
		if message.role == Role::System {
			continue;
		}
		let parts = Arc::make_mut(&mut message.content);
		for part in parts {
			match part {
				ContentPart::Text { text, proof } => {
					let kind = match message.role {
						Role::System => MessageTextKind::System,
						Role::Developer => MessageTextKind::Developer,
						Role::User => MessageTextKind::User,
						Role::Assistant => MessageTextKind::AssistantReplay,
						Role::Tool => MessageTextKind::ToolResult,
					};
					let mapped = obfuscate_message_text(obfuscator, kind, text);
					if mapped != text.as_str() {
						*text = Str::new(mapped);
						if message.role == Role::Assistant {
							*proof = None;
						}
					}
				},
				ContentPart::Reasoning { .. }
				| ContentPart::Image(_)
				| ContentPart::Audio(_)
				| ContentPart::Document(_)
				| ContentPart::CachePoint(_) => {},
				ContentPart::ToolCall { arguments, proof, .. } if message.role == Role::Assistant => {
					let mut mapped = arguments.as_value().clone();
					obfuscate_json(&mut mapped, obfuscator);
					if &mapped != arguments.as_value() {
						*arguments = OpaqueJson::new(mapped);
						*proof = None;
					}
				},
				ContentPart::ToolCall { .. } => {},
				ContentPart::ToolResult { content, .. } => {
					for result in Arc::make_mut(content) {
						match result {
							ToolResultContent::Text(text) => {
								let mapped = obfuscator.obfuscate(text);
								if mapped != text.as_str() {
									*text = Str::new(mapped);
								}
							},
							ToolResultContent::Json(json) => {
								let mut mapped = json.as_value().clone();
								obfuscate_json(&mut mapped, obfuscator);
								if &mapped != json.as_value() {
									*json = OpaqueJson::new(mapped);
								}
							},
							ToolResultContent::Image(_) | ToolResultContent::Document(_) => {},
						}
					}
				},
			}
		}
	}
}

/// Restores a model-authored structured argument immediately before local
/// admission/execution.
pub fn restore_model_arguments(arguments: &mut OpaqueJson, obfuscator: &SecretObfuscator) {
	let mut restored = arguments.as_value().clone();
	deobfuscate_json(&mut restored, obfuscator);
	if &restored != arguments.as_value() {
		*arguments = OpaqueJson::new(restored);
	}
}

/// Placeholder-boundary buffer for streamed model-authored text, intents, and
/// summaries.
#[derive(Debug, Default)]
pub struct SecretStreamRestorer {
	buffer: PlaceholderStream,
}

impl SecretStreamRestorer {
	/// Creates an empty restorer.
	pub const fn new() -> Self {
		Self { buffer: PlaceholderStream::new() }
	}

	/// Pushes one provider delta and returns only complete, locally restored
	/// text.
	pub fn push(&mut self, delta: &str, obfuscator: &SecretObfuscator) -> String {
		let safe = self.buffer.push(delta);
		restore_message_text(obfuscator, MessageTextKind::AssistantOutput, &safe)
	}

	/// Flushes a terminal incomplete literal suffix.
	pub fn finish(&mut self, obfuscator: &SecretObfuscator) -> String {
		let suffix = self.buffer.finish();
		restore_message_text(obfuscator, MessageTextKind::AssistantOutput, &suffix)
	}
}
