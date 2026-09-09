//! MCP tool invocation normalization, retry accounting, and durable receipts.

use std::{
	collections::BTreeSet,
	fs, io,
	path::{Component, Path, PathBuf},
	sync::Arc,
};

use bytes::Bytes;
use omp_core::Str;
use omp_proto::env::v1 as pb;
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;

use super::{
	McpServiceError,
	manager::{LiveConnection, ManagerError, McpManager},
	timeout::{McpDeadlineError, McpTimeout},
	transport::{DispatchState, TransportError, TransportFailure, TransportResponse},
};

/// Invokes a live or cached/deferred MCP leaf through its Environment manager.
pub(crate) async fn invoke(
	manager: Arc<McpManager>,
	request: pb::McpInvokeRequest,
	cancel: CancellationToken,
) -> Result<pb::McpInvokeResult, McpServiceError> {
	let server = request
		.server
		.as_ref()
		.ok_or(McpServiceError::InvalidRequest)?
		.name
		.clone();
	if server.is_empty() || request.tool.is_empty() {
		return Err(McpServiceError::InvalidRequest);
	}
	let definition = manager
		.tool_definition(&server, &request.tool)
		.ok_or(McpServiceError::InvalidRequest)?;
	let input_schema = definition.get("inputSchema").unwrap_or(&Value::Null);
	let args = serde_json::from_slice::<Value>(&request.arguments_json)
		.map_err(|_| McpServiceError::InvalidRequest)?;
	let mut args = normalize_args(args, input_schema);
	resolve_local_urls(&mut args, manager.local_root())
		.map_err(|_| McpServiceError::InvalidRequest)?;
	let timeout_ms = if request.timeout_ms == 0 {
		manager.mount_timeout(&server)
	} else {
		Some(request.timeout_ms)
	};
	let timeout = McpTimeout::resolve(None, timeout_ms);
	let idempotent = is_idempotent(&definition);
	let acquisition = async {
		match manager.connection(&server, &cancel).await {
			Ok(connection) => Ok(connection),
			Err(ManagerError::Cancelled) => Err(ManagerError::Cancelled),
			Err(_) => manager.reconnect_for_invoke(&server, &cancel).await,
		}
	};
	let mut connection = match timeout.run(&cancel, acquisition).await {
		Ok(Ok(connection)) => connection,
		Ok(Err(ManagerError::Cancelled)) | Err(McpDeadlineError::Cancelled) => {
			return Err(McpServiceError::Cancelled);
		},
		Ok(Err(error)) => return Err(manager_error(error)),
		Err(McpDeadlineError::TimedOut) => {
			return Ok(error_result(
				request,
				DispatchState::PreDispatch,
				"MCP connection timed out",
				0,
				false,
				false,
			));
		},
	};
	let mut retry_count = 0_u32;
	let mut auth_retried = false;
	let mut effects_unknown = false;

	let first = call(&connection, &request.tool, args.clone(), timeout, &cancel).await;
	let response = match first {
		CallResult::Response(response) => {
			if let Some(challenges) = auth_challenges(&response) {
				let refreshed = manager
					.refresh_auth(&server, &challenges, cancel.child_token())
					.await;
				if cancel.is_cancelled() {
					CallResult::Cancelled
				} else if refreshed {
					auth_retried = true;
					match manager.reconnect_for_invoke(&server, &cancel).await {
						Ok(reconnected) => {
							retry_count = 1;
							connection = reconnected;
							call(&connection, &request.tool, args, timeout, &cancel).await
						},
						Err(ManagerError::Cancelled) => CallResult::Cancelled,
						Err(_) => CallResult::Response(response),
					}
				} else {
					CallResult::Response(response)
				}
			} else {
				CallResult::Response(response)
			}
		},
		CallResult::Transport(error) => {
			let retry_safe = error.dispatch == DispatchState::PreDispatch || idempotent;
			effects_unknown =
				matches!(error.dispatch, DispatchState::Dispatched | DispatchState::EffectsUnknown);
			if retry_safe && retriable(&error) {
				match manager.reconnect_for_invoke(&server, &cancel).await {
					Ok(reconnected) => {
						retry_count = 1;
						connection = reconnected;
						call(&connection, &request.tool, args, timeout, &cancel).await
					},
					Err(ManagerError::Cancelled) => CallResult::Cancelled,
					Err(_) => CallResult::Transport(error),
				}
			} else {
				CallResult::Transport(error)
			}
		},
		CallResult::TimedOut => {
			effects_unknown = true;
			CallResult::TimedOut
		},
		CallResult::Cancelled => return Err(McpServiceError::Cancelled),
	};

	match response {
		CallResult::Response(response) => {
			Ok(lower_response(request, response, retry_count, auth_retried, effects_unknown))
		},
		CallResult::Transport(error) => Ok(error_result(
			request,
			error.dispatch,
			failure_message(&error.cause),
			retry_count,
			auth_retried,
			effects_unknown
				|| matches!(error.dispatch, DispatchState::Dispatched | DispatchState::EffectsUnknown),
		)),
		CallResult::TimedOut => Ok(error_result(
			request,
			DispatchState::EffectsUnknown,
			"MCP operation timed out",
			retry_count,
			auth_retried,
			true,
		)),
		CallResult::Cancelled => Err(McpServiceError::Cancelled),
	}
}

#[derive(Debug)]
enum CallResult {
	Response(TransportResponse),
	Transport(TransportError),
	TimedOut,
	Cancelled,
}

async fn call(
	connection: &Arc<LiveConnection>,
	tool: &str,
	args: Value,
	timeout: McpTimeout,
	cancel: &CancellationToken,
) -> CallResult {
	let operation = connection
		.client
		.call_tool(tool, args, cancel.child_token());
	match timeout.run(cancel, operation).await {
		Ok(Ok(response)) => CallResult::Response(response),
		Ok(Err(error)) => CallResult::Transport(error),
		Err(McpDeadlineError::TimedOut) => CallResult::TimedOut,
		Err(McpDeadlineError::Cancelled) => CallResult::Cancelled,
	}
}

fn normalize_args(value: Value, input_schema: &Value) -> Value {
	let mut args = match value {
		Value::Object(args) => args,
		_ => Map::new(),
	};
	let properties = input_schema.get("properties").and_then(Value::as_object);
	if !properties.is_some_and(|properties| properties.contains_key("i")) {
		args.remove("i");
	}
	let required = input_schema
		.get("required")
		.and_then(Value::as_array)
		.map(|required| {
			required
				.iter()
				.filter_map(Value::as_str)
				.collect::<BTreeSet<_>>()
		})
		.unwrap_or_default();
	args.retain(|name, value| {
		required.contains(name.as_str())
			|| !properties.is_some_and(|properties| properties.contains_key(name))
			|| !unused_optional(value)
	});
	Value::Object(args)
}

fn unused_optional(value: &Value) -> bool {
	matches!(value, Value::Null)
		|| value.as_str().is_some_and(str::is_empty)
		|| value.as_object().is_some_and(Map::is_empty)
}

fn resolve_local_urls(value: &mut Value, root: &Path) -> Result<(), LocalPathError> {
	match value {
		Value::String(text) => {
			let Some(resource) = text.strip_prefix("local://") else {
				return Ok(());
			};
			*text = resolve_local_path(root, resource)?
				.to_str()
				.ok_or(LocalPathError::NonUtf8)?
				.to_owned();
			Ok(())
		},
		Value::Array(values) => {
			for value in values {
				resolve_local_urls(value, root)?;
			}
			Ok(())
		},
		Value::Object(values) => {
			for value in values.values_mut() {
				resolve_local_urls(value, root)?;
			}
			Ok(())
		},
		_ => Ok(()),
	}
}

fn resolve_local_path(root: &Path, resource: &str) -> Result<PathBuf, LocalPathError> {
	let decoded = percent_decode(resource)?;
	let relative = Path::new(&decoded);
	if relative.is_absolute()
		|| decoded.contains('\\')
		|| relative
			.components()
			.any(|component| !matches!(component, Component::Normal(_) | Component::CurDir))
	{
		return Err(LocalPathError::Traversal);
	}
	let root = fs::canonicalize(root).map_err(LocalPathError::Io)?;
	let target = fs::canonicalize(root.join(relative)).map_err(LocalPathError::Io)?;
	if !target.starts_with(root) {
		return Err(LocalPathError::Traversal);
	}
	Ok(target)
}

fn percent_decode(value: &str) -> Result<String, LocalPathError> {
	let mut bytes = Vec::with_capacity(value.len());
	let source = value.as_bytes();
	let mut index = 0;
	while index < source.len() {
		if source[index] == b'%' {
			let encoded = source
				.get(index + 1..index + 3)
				.ok_or(LocalPathError::Encoding)?;
			let high = hex(encoded[0]).ok_or(LocalPathError::Encoding)?;
			let low = hex(encoded[1]).ok_or(LocalPathError::Encoding)?;
			bytes.push(high << 4 | low);
			index += 3;
		} else {
			bytes.push(source[index]);
			index += 1;
		}
	}
	String::from_utf8(bytes).map_err(|_| LocalPathError::Encoding)
}

fn hex(value: u8) -> Option<u8> {
	match value {
		b'0'..=b'9' => Some(value - b'0'),
		b'a'..=b'f' => Some(value - b'a' + 10),
		b'A'..=b'F' => Some(value - b'A' + 10),
		_ => None,
	}
}

fn is_idempotent(definition: &Value) -> bool {
	let annotations = definition.get("annotations").and_then(Value::as_object);
	annotations.is_some_and(|annotations| {
		annotations
			.get("readOnlyHint")
			.and_then(Value::as_bool)
			.unwrap_or(false)
			|| annotations
				.get("idempotentHint")
				.and_then(Value::as_bool)
				.unwrap_or(false)
	})
}

fn auth_challenges(response: &TransportResponse) -> Option<Vec<Str>> {
	let result = response.result.as_object()?;
	if !result
		.get("isError")
		.and_then(Value::as_bool)
		.unwrap_or(false)
	{
		return None;
	}
	let values = result
		.get("_meta")?
		.get("mcp/www_authenticate")?
		.as_array()?;
	let challenges = values
		.iter()
		.filter_map(Value::as_str)
		.map(str::trim)
		.filter(|value| !value.is_empty())
		.map(Str::from)
		.collect::<Vec<_>>();
	(!challenges.is_empty()).then_some(challenges)
}

fn retriable(error: &TransportError) -> bool {
	matches!(
		error.cause,
		TransportFailure::NotConnected
			| TransportFailure::Closed
			| TransportFailure::Io(_)
			| TransportFailure::HttpConnect(_)
			| TransportFailure::HttpReset(_)
			| TransportFailure::HttpEof(_)
			| TransportFailure::Http(_)
			| TransportFailure::HttpStatus { status: 404 | 502 | 503 }
	)
}

fn lower_response(
	request: pb::McpInvokeRequest,
	response: TransportResponse,
	retry_count: u32,
	auth_retried: bool,
	effects_unknown: bool,
) -> pb::McpInvokeResult {
	let is_error = response
		.result
		.get("isError")
		.and_then(Value::as_bool)
		.unwrap_or(false);
	let content = response
		.result
		.get("content")
		.cloned()
		.unwrap_or_else(|| Value::Array(Vec::new()));
	let structured_content_json = response
		.result
		.get("structuredContent")
		.and_then(|value| serde_json::to_vec(value).ok())
		.unwrap_or_default();
	let meta_json = response
		.result
		.get("_meta")
		.and_then(|value| serde_json::to_vec(value).ok())
		.unwrap_or_default();
	let max = usize::try_from(request.max_bytes).unwrap_or(usize::MAX);
	let mut content_json = serde_json::to_vec(&content).unwrap_or_else(|_| b"[]".to_vec());
	let truncated = content_json.len() > max;
	if truncated {
		content_json =
			br#"[{"type":"text","text":"MCP result exceeded the configured size limit."}]"#.to_vec();
	}
	pb::McpInvokeResult {
		server: request.server,
		tool: request.tool,
		content_json: content_json.into(),
		is_error,
		truncated,
		dispatch_certainty: pb::McpDispatchCertainty::Responded.into(),
		retry_count,
		auth_retried,
		effects_unknown,
		structured_content_json: structured_content_json.into(),
		meta_json: meta_json.into(),
	}
}

fn error_result(
	request: pb::McpInvokeRequest,
	dispatch: DispatchState,
	message: &'static str,
	retry_count: u32,
	auth_retried: bool,
	effects_unknown: bool,
) -> pb::McpInvokeResult {
	let certainty = match dispatch {
		DispatchState::PreDispatch => pb::McpDispatchCertainty::PreDispatch,
		DispatchState::Responded => pb::McpDispatchCertainty::Responded,
		DispatchState::Dispatched | DispatchState::EffectsUnknown => {
			pb::McpDispatchCertainty::EffectsUnknown
		},
	};
	let content = json!([{ "type": "text", "text": format!("MCP error: {message}") }]);
	pb::McpInvokeResult {
		server: request.server,
		tool: request.tool,
		content_json: serde_json::to_vec(&content)
			.unwrap_or_else(|_| b"[]".to_vec())
			.into(),
		is_error: true,
		truncated: false,
		dispatch_certainty: certainty.into(),
		retry_count,
		auth_retried,
		effects_unknown,
		structured_content_json: Bytes::new(),
		meta_json: Bytes::new(),
	}
}

fn failure_message(failure: &TransportFailure) -> &'static str {
	match failure {
		TransportFailure::Cancelled => "MCP operation was cancelled",
		TransportFailure::TimedOut => "MCP operation timed out",
		TransportFailure::NotConnected | TransportFailure::Closed => "MCP connection is unavailable",
		TransportFailure::FrameTooLarge => "MCP response exceeded its size limit",
		TransportFailure::InvalidSpawnPlan => "MCP server process command is invalid",
		TransportFailure::Spawn(_) => "MCP server process could not be started",
		TransportFailure::Io(_) | TransportFailure::Http(_) => "MCP transport failed",
		TransportFailure::HttpConnect(_) => "MCP endpoint could not be reached",
		TransportFailure::HttpReset(_) => "MCP connection was reset",
		TransportFailure::HttpEof(_) => "MCP connection ended before the response completed",
		TransportFailure::HttpStatus { .. } => "MCP server returned an HTTP error",
		TransportFailure::HeaderPolicy(_) => "MCP header policy rejected the request",
		TransportFailure::Json(_)
		| TransportFailure::MalformedFrame
		| TransportFailure::Correlation
		| TransportFailure::SseProtocol => "MCP server returned an invalid response",
		TransportFailure::JsonRpc { .. } => "MCP server returned a protocol error",
	}
}

fn manager_error(error: ManagerError) -> McpServiceError {
	match error {
		ManagerError::Cancelled => McpServiceError::Cancelled,
		_ => McpServiceError::Backend,
	}
}

#[derive(Debug, thiserror::Error)]
enum LocalPathError {
	#[error("local MCP argument path contains invalid encoding")]
	Encoding,
	#[error("local MCP argument path escapes the Environment root")]
	Traversal,
	#[error("local MCP argument path is not UTF-8")]
	NonUtf8,
	#[error("local MCP argument path could not be resolved")]
	Io(#[source] io::Error),
}
