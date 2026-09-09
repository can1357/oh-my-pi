//! MCP initialization, tool operations, server traffic, and disconnect
//! lifecycle.

use std::{
	collections::BTreeSet,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
};

use omp_core::Str;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use super::transport::{IncomingMessage, McpTransport, ServerResponseError, TransportError};

/// Preferred MCP revision and the explicit downgrade set accepted by OMP.
pub const PREFERRED_PROTOCOL_VERSION: &str = "2025-11-25";
/// Known protocol revisions implemented by this client, newest first.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] =
	&["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const MAX_PAGES: usize = 1_024;

/// Validated initialize result.
#[derive(Clone, Debug)]
pub struct InitializedServer {
	/// Negotiated exact protocol revision.
	pub protocol_version: Str,
	/// Server implementation name.
	pub name:             Str,
	/// Optional server implementation version.
	pub version:          Option<Str>,
	/// Optional server display title.
	pub title:            Option<Str>,
	/// Optional server description.
	pub description:      Option<Str>,
	/// Advertised capabilities retained for feature gating.
	pub capabilities:     Value,
	/// Bounded device documentation supplied by the server.
	pub instructions:     Option<Str>,
}

/// Environment-scoped MCP protocol client.
pub struct McpClient {
	transport:    Arc<dyn McpTransport>,
	roots:        Arc<[Str]>,
	disconnected: AtomicBool,
}

impl McpClient {
	/// Creates a client with a stable snapshot of Environment workspace roots.
	pub fn new(transport: Arc<dyn McpTransport>, roots: Arc<[Str]>) -> Self {
		Self { transport, roots, disconnected: AtomicBool::new(false) }
	}

	/// Performs initialize, validates the selected revision, then emits
	/// `notifications/initialized` in protocol order. A failed negotiation
	/// always closes the transport before the error is returned.
	pub async fn initialize(
		&self,
		cancel: CancellationToken,
	) -> Result<InitializedServer, ClientError> {
		let result = self.initialize_inner(cancel).await;
		if result.is_err() {
			let _ = self.disconnect().await;
		}
		result
	}

	async fn initialize_inner(
		&self,
		cancel: CancellationToken,
	) -> Result<InitializedServer, ClientError> {
		let response = self
			.transport
			.request(
				"initialize",
				json!({
					"protocolVersion": PREFERRED_PROTOCOL_VERSION,
					"capabilities": {
						"roots": { "listChanged": false }
					},
					"clientInfo": {
						"name": "omp-coding-agent",
						"version": env!("CARGO_PKG_VERSION")
					}
				}),
				cancel.child_token(),
			)
			.await?;
		let raw: InitializeResult =
			serde_json::from_value(response.result).map_err(|_| ClientError::MalformedInitialize)?;
		if !SUPPORTED_PROTOCOL_VERSIONS.contains(&raw.protocol_version.as_str()) {
			return Err(ClientError::UnsupportedProtocol(Str::from(raw.protocol_version)));
		}
		if raw.server_info.name.trim().is_empty() || !raw.capabilities.is_object() {
			return Err(ClientError::MalformedInitialize);
		}
		let protocol_version = Str::from(raw.protocol_version);
		self
			.transport
			.set_protocol_version(protocol_version.clone());
		self
			.transport
			.notify("notifications/initialized", json!({}), cancel)
			.await?;
		Ok(InitializedServer {
			protocol_version,
			name: Str::from(raw.server_info.name),
			version: raw.server_info.version.map(Str::from),
			title: raw
				.server_info
				.title
				.filter(|value| !value.is_empty())
				.map(Str::from),
			description: raw
				.server_info
				.description
				.filter(|value| !value.is_empty())
				.map(Str::from),
			capabilities: raw.capabilities,
			instructions: raw
				.instructions
				.filter(|value| !value.is_empty())
				.map(Str::from),
		})
	}

	/// Lists every tool page with bounded cursor-cycle protection.
	pub async fn list_tools(&self, cancel: CancellationToken) -> Result<Vec<Value>, ClientError> {
		let mut output = Vec::new();
		let mut cursor: Option<Str> = None;
		let mut seen = BTreeSet::new();
		for _ in 0..MAX_PAGES {
			let params = cursor
				.as_ref()
				.map_or_else(|| json!({}), |cursor| json!({ "cursor": cursor }));
			let response = self
				.transport
				.request("tools/list", params, cancel.child_token())
				.await?;
			let mut object = response
				.result
				.as_object()
				.cloned()
				.ok_or(ClientError::MalformedTools)?;
			let tools = object.remove("tools").ok_or(ClientError::MalformedTools)?;
			output.extend(
				serde_json::from_value::<Vec<Value>>(tools).map_err(|_| ClientError::MalformedTools)?,
			);
			cursor = object.remove("nextCursor").and_then(|value| {
				value
					.as_str()
					.filter(|value| !value.is_empty())
					.map(Str::from)
			});
			let Some(next) = cursor.as_ref() else {
				output.sort_unstable_by(|left, right| {
					left
						.get("name")
						.and_then(Value::as_str)
						.cmp(&right.get("name").and_then(Value::as_str))
				});
				return Ok(output);
			};
			if !seen.insert(next.clone()) {
				return Err(ClientError::CursorCycle);
			}
		}
		Err(ClientError::TooManyPages)
	}

	/// Calls one advertised tool without changing its server-owned arguments.
	pub async fn call_tool(
		&self,
		name: &str,
		arguments: Value,
		cancel: CancellationToken,
	) -> Result<super::transport::TransportResponse, TransportError> {
		self
			.transport
			.request("tools/call", json!({ "name": name, "arguments": arguments }), cancel)
			.await
	}

	/// Handles server-initiated traffic until a notification or clean close is
	/// observed. Requests are answered in place and are never misreported as
	/// notifications.
	pub async fn next(
		&self,
		cancel: CancellationToken,
	) -> Result<Option<(Str, Value)>, ClientError> {
		loop {
			match self.transport.next_message(cancel.child_token()).await? {
				IncomingMessage::Notification { method, params } => return Ok(Some((method, params))),
				IncomingMessage::Closed => return Ok(None),
				IncomingMessage::Request { id, method, params: _ } => {
					let answer = match method.as_str() {
						"ping" => Ok(json!({})),
						"roots/list" => Ok(json!({
							"roots": self.roots.iter().map(|root| json!({
								"uri": root,
								"name": root_name(root)
							})).collect::<Vec<_>>()
						})),
						_ => Err(ServerResponseError {
							code:    -32601,
							message: Str::new_static("Method not found"),
							data:    None,
						}),
					};
					self
						.transport
						.respond(id, answer, cancel.child_token())
						.await?;
				},
			}
		}
	}

	/// Closes the logical connection and all transport-owned resources.
	/// Repeated disconnects after a successful close are no-ops; failed closes
	/// remain retryable.
	pub async fn disconnect(&self) -> Result<(), ClientError> {
		if self.disconnected.swap(true, Ordering::AcqRel) {
			return Ok(());
		}
		if let Err(error) = self.transport.close().await {
			self.disconnected.store(false, Ordering::Release);
			return Err(ClientError::Transport(error));
		}
		Ok(())
	}

	/// Borrows the shared transport for resource and prompt clients.
	pub fn transport(&self) -> &Arc<dyn McpTransport> {
		&self.transport
	}
}

fn root_name(root: &str) -> Str {
	url::Url::parse(root)
		.ok()
		.and_then(|url| url.to_file_path().ok())
		.and_then(|path| {
			path
				.file_name()
				.and_then(|name| name.to_str())
				.map(Str::from)
		})
		.unwrap_or_else(|| Str::from(root))
}

impl Drop for McpClient {
	fn drop(&mut self) {
		if self.disconnected.swap(true, Ordering::AcqRel) {
			return;
		}
		let transport = Arc::clone(&self.transport);
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			runtime.spawn(async move {
				let _ = transport.close().await;
			});
		}
	}
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InitializeResult {
	protocol_version: String,
	capabilities:     Value,
	server_info:      ServerInfo,
	instructions:     Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerInfo {
	name:        String,
	version:     Option<String>,
	title:       Option<String>,
	description: Option<String>,
}

/// MCP initialization or message-loop failure.
#[derive(Debug, thiserror::Error)]
pub enum ClientError {
	/// Transport failed.
	#[error(transparent)]
	Transport(#[from] TransportError),
	/// Initialize response was structurally invalid.
	#[error("MCP initialize response is malformed")]
	MalformedInitialize,
	/// Tool discovery response was structurally invalid.
	#[error("MCP tool discovery response is malformed")]
	MalformedTools,
	/// Tool pagination cursor repeated.
	#[error("MCP tool pagination cursor repeated")]
	CursorCycle,
	/// Peer exceeded the bounded tool page count.
	#[error("MCP tool pagination exceeded its page limit")]
	TooManyPages,
	/// Server selected a revision outside the explicit compatibility set.
	#[error("MCP server selected unsupported protocol revision {0}")]
	UnsupportedProtocol(Str),
}
#[cfg(test)]
mod tests {
	use std::{
		collections::{BTreeSet, VecDeque},
		sync::atomic::{AtomicUsize, Ordering},
	};

	use parking_lot::Mutex;
	use serde_json::Map;

	use super::*;
	use crate::mcp::{
		json_rpc::RequestId,
		prompts::{PromptContent, PromptsClient},
		resources::ResourcesClient,
		transport::{
			DispatchState, IncomingMessage, McpTransport, ServerResponseError, TransportFailure,
			TransportFuture, TransportResponse,
		},
	};

	struct ScriptedTransport {
		results:       Mutex<VecDeque<Value>>,
		requests:      Mutex<Vec<(Str, Value)>>,
		notifications: Mutex<Vec<Str>>,
		incoming:      Mutex<VecDeque<IncomingMessage>>,
		responses:     Mutex<Vec<(RequestId, Result<Value, ServerResponseError>)>>,
		protocol:      Mutex<Option<Str>>,
		not_found:     Mutex<BTreeSet<Str>>,
		closes:        AtomicUsize,
	}

	impl ScriptedTransport {
		fn new(results: impl IntoIterator<Item = Value>) -> Self {
			Self {
				results:       Mutex::new(results.into_iter().collect()),
				requests:      Mutex::new(Vec::new()),
				notifications: Mutex::new(Vec::new()),
				incoming:      Mutex::new(VecDeque::new()),
				responses:     Mutex::new(Vec::new()),
				protocol:      Mutex::new(None),
				not_found:     Mutex::new(BTreeSet::new()),
				closes:        AtomicUsize::new(0),
			}
		}
	}

	impl McpTransport for ScriptedTransport {
		fn set_protocol_version(&self, revision: Str) {
			*self.protocol.lock() = Some(revision);
		}

		fn request<'a>(
			&'a self,
			method: &'a str,
			params: Value,
			cancellation: CancellationToken,
		) -> TransportFuture<'a, Result<TransportResponse, TransportError>> {
			self.requests.lock().push((Str::from(method), params));
			Box::pin(async move {
				if cancellation.is_cancelled() {
					return Err(TransportError::pre_dispatch(TransportFailure::Cancelled));
				}
				if self.not_found.lock().contains(method) {
					return Err(TransportError {
						dispatch: DispatchState::Responded,
						cause:    TransportFailure::JsonRpc { code: -32601 },
					});
				}
				let result = self.results.lock().pop_front().expect("scripted response");
				Ok(TransportResponse {
					id: RequestId::Number(1),
					result,
					dispatch: DispatchState::Responded,
				})
			})
		}

		fn notify<'a>(
			&'a self,
			method: &'a str,
			_params: Value,
			cancellation: CancellationToken,
		) -> TransportFuture<'a, Result<DispatchState, TransportError>> {
			self.notifications.lock().push(Str::from(method));
			Box::pin(async move {
				if cancellation.is_cancelled() {
					Err(TransportError::pre_dispatch(TransportFailure::Cancelled))
				} else {
					Ok(DispatchState::Dispatched)
				}
			})
		}

		fn next_message<'a>(
			&'a self,
			cancellation: CancellationToken,
		) -> TransportFuture<'a, Result<IncomingMessage, TransportError>> {
			Box::pin(async move {
				if cancellation.is_cancelled() {
					return Err(TransportError::pre_dispatch(TransportFailure::Cancelled));
				}
				Ok(self
					.incoming
					.lock()
					.pop_front()
					.unwrap_or(IncomingMessage::Closed))
			})
		}

		fn respond<'a>(
			&'a self,
			id: RequestId,
			result: Result<Value, ServerResponseError>,
			cancellation: CancellationToken,
		) -> TransportFuture<'a, Result<DispatchState, TransportError>> {
			self.responses.lock().push((id, result));
			Box::pin(async move {
				if cancellation.is_cancelled() {
					Err(TransportError::pre_dispatch(TransportFailure::Cancelled))
				} else {
					Ok(DispatchState::Dispatched)
				}
			})
		}

		fn close(&self) -> TransportFuture<'_, Result<(), TransportError>> {
			self.closes.fetch_add(1, Ordering::AcqRel);
			Box::pin(async { Ok(()) })
		}
	}

	#[tokio::test]
	async fn operation_lifecycle_negotiates_pages_calls_reads_subscribes_and_disconnects() {
		let transport = Arc::new(ScriptedTransport::new([
			json!({
				"protocolVersion": PREFERRED_PROTOCOL_VERSION,
				"capabilities": { "tools": {}, "resources": { "subscribe": true }, "prompts": {} },
				"serverInfo": { "name": "fixture", "version": "1" }
			}),
			json!({ "tools": [{ "name": "z" }], "nextCursor": "tools-2" }),
			json!({ "tools": [{ "name": "a" }] }),
			json!({ "content": [{ "type": "text", "text": "called" }] }),
			json!({ "resources": [{ "uri": "test://one", "name": "one" }], "nextCursor": "resources-2" }),
			json!({ "resources": [{ "uri": "test://two", "name": "two" }] }),
			json!({ "resourceTemplates": [{ "uriTemplate": "test://{id}", "name": "template" }] }),
			json!({ "contents": [
				{ "uri": "test://one", "mimeType": "text/plain", "text": "hello" },
				{ "uri": "test://one", "mimeType": "application/octet-stream", "blob": "AQI=" }
			] }),
			json!({}),
			json!({}),
			json!({ "prompts": [{ "name": "first" }], "nextCursor": "prompts-2" }),
			json!({ "prompts": [{ "name": "second" }] }),
			json!({ "messages": [{ "role": "user", "content": { "type": "text", "text": "prompt" } }] }),
		]));
		let client =
			McpClient::new(transport.clone(), Arc::from([Str::new_static("file:///workspace")]));
		let initialized = client
			.initialize(CancellationToken::new())
			.await
			.expect("initialize");
		assert_eq!(initialized.protocol_version, PREFERRED_PROTOCOL_VERSION);
		assert_eq!(transport.protocol.lock().as_deref(), Some(PREFERRED_PROTOCOL_VERSION));
		assert_eq!(transport.notifications.lock().as_slice(), [Str::new_static(
			"notifications/initialized"
		)]);

		let tools = client
			.list_tools(CancellationToken::new())
			.await
			.expect("tools");
		assert_eq!(
			tools
				.iter()
				.filter_map(|tool| tool["name"].as_str())
				.collect::<Vec<_>>(),
			["a", "z"]
		);
		let called = client
			.call_tool("a", json!({ "value": 1 }), CancellationToken::new())
			.await
			.expect("call");
		assert_eq!(called.result["content"][0]["text"], "called");

		let resources = ResourcesClient::new(Arc::clone(client.transport()));
		assert_eq!(
			resources
				.list(CancellationToken::new())
				.await
				.expect("resources")
				.len(),
			2
		);
		assert_eq!(
			resources
				.templates(CancellationToken::new())
				.await
				.expect("templates")
				.len(),
			1
		);
		let content = resources
			.read("test://one", CancellationToken::new())
			.await
			.expect("read");
		assert_eq!(content[0].bytes, b"hello");
		assert_eq!(content[1].bytes, [1, 2]);
		resources
			.subscribe("test://one", CancellationToken::new())
			.await
			.expect("subscribe");
		resources
			.unsubscribe("test://one", CancellationToken::new())
			.await
			.expect("unsubscribe");

		let prompts = PromptsClient::new(Arc::clone(client.transport()));
		assert_eq!(
			prompts
				.list(CancellationToken::new())
				.await
				.expect("prompts")
				.len(),
			2
		);
		let messages = prompts
			.get("first", Map::new(), CancellationToken::new())
			.await
			.expect("prompt");
		assert!(matches!(&messages[0].content, PromptContent::Text(text) if text == "prompt"));

		let requests = transport.requests.lock();
		let methods = requests
			.iter()
			.map(|(method, _)| method.as_str())
			.collect::<Vec<_>>();
		assert_eq!(methods, [
			"initialize",
			"tools/list",
			"tools/list",
			"tools/call",
			"resources/list",
			"resources/list",
			"resources/templates/list",
			"resources/read",
			"resources/subscribe",
			"resources/unsubscribe",
			"prompts/list",
			"prompts/list",
			"prompts/get",
		]);
		assert_eq!(requests[0].1["clientInfo"]["name"], "omp-coding-agent");
		assert_eq!(requests[0].1["protocolVersion"], PREFERRED_PROTOCOL_VERSION);
		assert!(requests[0].1["capabilities"].get("roots").is_some());
		assert!(requests[0].1["capabilities"].get("sampling").is_none());
		assert!(requests[0].1["capabilities"].get("elicitation").is_none());
		assert!(
			requests
				.last()
				.expect("prompt get")
				.1
				.get("arguments")
				.is_none()
		);
		drop(requests);

		client.disconnect().await.expect("disconnect");
		client.disconnect().await.expect("repeat disconnect");
		assert_eq!(transport.closes.load(Ordering::Acquire), 1);
	}

	#[tokio::test]
	async fn pagination_cycles_are_rejected_and_optional_templates_may_be_absent() {
		let cycle = Arc::new(ScriptedTransport::new([
			json!({ "tools": [], "nextCursor": "repeat" }),
			json!({ "tools": [], "nextCursor": "repeat" }),
		]));
		let client = McpClient::new(cycle, Arc::from([]));
		assert!(matches!(
			client.list_tools(CancellationToken::new()).await,
			Err(ClientError::CursorCycle)
		));

		let absent = Arc::new(ScriptedTransport::new([]));
		absent
			.not_found
			.lock()
			.insert(Str::new_static("resources/templates/list"));
		let resources: Arc<dyn McpTransport> = absent;
		assert!(
			ResourcesClient::new(resources)
				.templates(CancellationToken::new())
				.await
				.expect("optional templates")
				.is_empty()
		);
	}

	#[tokio::test]
	async fn server_requests_are_answered_without_becoming_notifications() {
		let transport = Arc::new(ScriptedTransport::new([]));
		transport.incoming.lock().extend([
			IncomingMessage::Request {
				id:     RequestId::Number(7),
				method: Str::new_static("ping"),
				params: Value::Null,
			},
			IncomingMessage::Request {
				id:     RequestId::Number(8),
				method: Str::new_static("roots/list"),
				params: Value::Null,
			},
			IncomingMessage::Request {
				id:     RequestId::Number(9),
				method: Str::new_static("unsupported"),
				params: Value::Null,
			},
			IncomingMessage::Notification {
				method: Str::new_static("notifications/tools/list_changed"),
				params: json!({ "epoch": 2 }),
			},
		]);
		let client = McpClient::new(
			transport.clone(),
			Arc::from([Str::new_static("file:///workspace/project")]),
		);
		let notification = client
			.next(CancellationToken::new())
			.await
			.expect("message")
			.expect("notification");
		assert_eq!(notification.0, "notifications/tools/list_changed");
		let responses = transport.responses.lock();
		assert!(responses[0].1.is_ok());
		assert_eq!(
			responses[1].1.as_ref().expect("roots response")["roots"][0],
			json!({ "uri": "file:///workspace/project", "name": "project" })
		);
		assert!(matches!(&responses[2].1, Err(error) if error.code == -32601));
	}

	#[tokio::test]
	async fn failed_negotiation_and_cancelled_operation_close_or_settle_cleanly() {
		let transport = Arc::new(ScriptedTransport::new([json!({
			"protocolVersion": "1900-01-01",
			"capabilities": {},
			"serverInfo": { "name": "fixture" }
		})]));
		let client = McpClient::new(transport.clone(), Arc::from([]));
		assert!(matches!(
			client.initialize(CancellationToken::new()).await,
			Err(ClientError::UnsupportedProtocol(_))
		));
		assert_eq!(transport.closes.load(Ordering::Acquire), 1);

		let cancelled = CancellationToken::new();
		cancelled.cancel();
		assert!(matches!(
			client.list_tools(cancelled).await,
			Err(ClientError::Transport(TransportError { cause: TransportFailure::Cancelled, .. }))
		));
		client.disconnect().await.expect("idempotent disconnect");
		assert_eq!(transport.closes.load(Ordering::Acquire), 1);
	}
}
