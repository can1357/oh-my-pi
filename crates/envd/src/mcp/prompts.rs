//! MCP prompt discovery, argument forwarding, and content decoding.

use std::{collections::BTreeSet, sync::Arc};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{
	resources::ResourceContent,
	transport::{McpTransport, TransportError},
};

const MAX_PAGES: usize = 1_024;

/// Advertised prompt definition.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PromptDefinition {
	/// Prompt name.
	pub name:        Str,
	/// Optional description.
	#[serde(default)]
	pub description: Option<Str>,
	/// Declared arguments.
	#[serde(default)]
	pub arguments:   Vec<PromptArgument>,
}

/// One declared prompt argument.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct PromptArgument {
	/// Argument name.
	pub name:        Str,
	/// Optional description.
	#[serde(default)]
	pub description: Option<Str>,
	/// Whether callers must provide the argument.
	#[serde(default)]
	pub required:    bool,
}

/// Decoded prompt message.
#[derive(Clone, Debug)]
pub struct PromptMessage {
	/// MCP role (`user` or `assistant`).
	pub role:    Str,
	/// Typed message content.
	pub content: PromptContent,
}

/// Typed MCP prompt content.
#[derive(Clone, Debug)]
pub enum PromptContent {
	/// UTF-8 text.
	Text(Str),
	/// Base64-decoded image and media type.
	Image { mime_type: Str, bytes: Vec<u8> },
	/// Base64-decoded audio and media type.
	Audio { mime_type: Str, bytes: Vec<u8> },
	/// Embedded text or binary resource.
	Resource(ResourceContent),
}

/// Prompt protocol facade.
pub struct PromptsClient {
	transport: Arc<dyn McpTransport>,
}

impl PromptsClient {
	/// Creates a prompt facade.
	pub fn new(transport: Arc<dyn McpTransport>) -> Self {
		Self { transport }
	}

	/// Lists all prompt pages with bounded cursor-cycle protection.
	pub async fn list(
		&self,
		cancel: CancellationToken,
	) -> Result<Vec<PromptDefinition>, PromptError> {
		let mut output = Vec::new();
		let mut cursor: Option<Str> = None;
		let mut seen = BTreeSet::new();
		for _ in 0..MAX_PAGES {
			let params = cursor
				.as_ref()
				.map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor }));
			let response = self
				.transport
				.request("prompts/list", params, cancel.child_token())
				.await?;
			let mut object = response
				.result
				.as_object()
				.cloned()
				.ok_or(PromptError::Malformed)?;
			let prompts = object.remove("prompts").ok_or(PromptError::Malformed)?;
			output.extend(
				serde_json::from_value::<Vec<PromptDefinition>>(prompts)
					.map_err(|_| PromptError::Malformed)?,
			);
			cursor = object.remove("nextCursor").and_then(|value| {
				value
					.as_str()
					.filter(|value| !value.is_empty())
					.map(Str::from)
			});
			let Some(next) = cursor.as_ref() else {
				return Ok(output);
			};
			if !seen.insert(next.clone()) {
				return Err(PromptError::CursorCycle);
			}
		}
		Err(PromptError::TooManyPages)
	}

	/// Gets a prompt while forwarding caller arguments without coercion or
	/// local interpolation that could change server semantics.
	pub async fn get(
		&self,
		name: &str,
		arguments: Map<String, Value>,
		cancel: CancellationToken,
	) -> Result<Vec<PromptMessage>, PromptError> {
		let mut params = Map::from_iter([("name".to_owned(), Value::String(name.to_owned()))]);
		if !arguments.is_empty() {
			params.insert("arguments".to_owned(), Value::Object(arguments));
		}
		let response = self
			.transport
			.request("prompts/get", Value::Object(params), cancel)
			.await?;
		let wire: PromptResponse =
			serde_json::from_value(response.result).map_err(|_| PromptError::Malformed)?;
		wire.messages.into_iter().map(decode_message).collect()
	}
}

#[derive(Deserialize)]
struct PromptResponse {
	messages: Vec<WireMessage>,
}

#[derive(Deserialize)]
struct WireMessage {
	role:    Str,
	content: Value,
}

fn decode_message(message: WireMessage) -> Result<PromptMessage, PromptError> {
	let object = message.content.as_object().ok_or(PromptError::Malformed)?;
	let kind = object
		.get("type")
		.and_then(Value::as_str)
		.ok_or(PromptError::Malformed)?;
	let content = match kind {
		"text" => PromptContent::Text(Str::from(
			object
				.get("text")
				.and_then(Value::as_str)
				.ok_or(PromptError::Malformed)?,
		)),
		"image" | "audio" => {
			let mime_type = Str::from(
				object
					.get("mimeType")
					.and_then(Value::as_str)
					.ok_or(PromptError::Malformed)?,
			);
			let data = object
				.get("data")
				.and_then(Value::as_str)
				.ok_or(PromptError::Malformed)?;
			let bytes = omp_core::base64::decode(data.as_bytes())
				.into_vec()
				.map_err(|_| PromptError::InvalidBase64)?;
			if kind == "image" {
				PromptContent::Image { mime_type, bytes }
			} else {
				PromptContent::Audio { mime_type, bytes }
			}
		},
		"resource" => PromptContent::Resource(decode_embedded_resource(
			object.get("resource").ok_or(PromptError::Malformed)?,
		)?),
		_ => return Err(PromptError::UnsupportedContent),
	};
	Ok(PromptMessage { role: message.role, content })
}

fn decode_embedded_resource(value: &Value) -> Result<ResourceContent, PromptError> {
	let object = value.as_object().ok_or(PromptError::Malformed)?;
	let uri = Str::from(
		object
			.get("uri")
			.and_then(Value::as_str)
			.ok_or(PromptError::Malformed)?,
	);
	let mime_type = object
		.get("mimeType")
		.and_then(Value::as_str)
		.map(Str::from);
	match (object.get("text").and_then(Value::as_str), object.get("blob").and_then(Value::as_str)) {
		(Some(text), None) => {
			Ok(ResourceContent { uri, mime_type, bytes: text.as_bytes().to_vec(), text: true })
		},
		(None, Some(blob)) => Ok(ResourceContent {
			uri,
			mime_type,
			bytes: omp_core::base64::decode(blob.as_bytes())
				.into_vec()
				.map_err(|_| PromptError::InvalidBase64)?,
			text: false,
		}),
		_ => Err(PromptError::Malformed),
	}
}

/// Prompt operation failure.
#[derive(Debug, thiserror::Error)]
pub enum PromptError {
	/// Transport failed.
	#[error(transparent)]
	Transport(#[from] TransportError),
	/// Response shape was invalid.
	#[error("MCP prompt response is malformed")]
	Malformed,
	/// Binary content was not valid base64.
	#[error("MCP prompt content is not valid base64")]
	InvalidBase64,
	/// Server returned an unknown prompt content type.
	#[error("MCP prompt content type is unsupported")]
	UnsupportedContent,
	/// Pagination cursor repeated.
	#[error("MCP prompt pagination cursor repeated")]
	CursorCycle,
	/// Peer exceeded the bounded page count.
	#[error("MCP prompt pagination exceeded its page limit")]
	TooManyPages,
}
