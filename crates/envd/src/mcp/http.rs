//! MCP Streamable HTTP transport with resumable SSE.

use std::{
	future::Future,
	iter, mem,
	pin::Pin,
	str,
	sync::{Arc, atomic},
	time::Duration,
};

use bytes::{Bytes, BytesMut};
use flume::Receiver;
use futures::{Stream, StreamExt as _};
use http::{
	HeaderMap, HeaderName, HeaderValue, Method, StatusCode,
	header::{ACCEPT, CONTENT_TYPE},
};
use omp_core::Str;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;
use url::Url;

use super::{
	header_policy,
	header_policy::{RedirectPolicy, redirect_location},
	json_rpc::{RequestId, RequestIdAllocator, RequestIdFormat},
	transport::{
		DispatchState, IncomingMessage, McpTransport, ServerResponseError, TransportError,
		TransportFailure, TransportFuture, TransportResponse,
	},
};

const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;
const DEFAULT_SSE_RETRY: Duration = Duration::from_secs(3);

/// Buffered HTTP request at the Environment egress boundary.
#[derive(Clone)]
pub struct HttpRequest {
	/// HTTP method.
	pub method:  Method,
	/// Absolute endpoint URL.
	pub url:     Url,
	/// Final request headers.
	pub headers: HeaderMap,
	/// Request body.
	pub body:    Bytes,
}

impl std::fmt::Debug for HttpRequest {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let url = super::json_rpc::redact_url_for_log(self.url.as_str());
		let headers = RedactedHeaders(&self.headers);
		formatter
			.debug_struct("HttpRequest")
			.field("method", &self.method)
			.field("url", &url)
			.field("headers", &headers)
			.field("body_bytes", &self.body.len())
			.finish()
	}
}

struct RedactedHeaders<'a>(&'a HeaderMap);

impl std::fmt::Debug for RedactedHeaders<'_> {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let mut names = formatter.debug_set();
		for name in self.0.keys() {
			names.entry(&name);
		}
		names.finish()
	}
}

/// Incremental bounded HTTP response used by MCP transports.
pub struct HttpResponse {
	/// HTTP status.
	pub status:  StatusCode,
	/// Response headers.
	pub headers: HeaderMap,
	/// Incremental response body.
	pub body:    HttpBody,
}

impl std::fmt::Debug for HttpResponse {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("HttpResponse")
			.field("status", &self.status)
			.field("headers", &RedactedHeaders(&self.headers))
			.field("body", &"HttpBody(..)")
			.finish()
	}
}

/// Owned streaming HTTP body with bounded incremental framing.
pub struct HttpBody {
	stream: Pin<Box<dyn Stream<Item = Result<Bytes, HttpExchangeError>> + Send>>,
	buffer: BytesMut,
	eof:    bool,
}

impl HttpBody {
	/// Creates an incremental body for injected exchanges.
	pub(crate) fn from_stream(
		stream: impl Stream<Item = Result<Bytes, HttpExchangeError>> + Send + 'static,
	) -> Self {
		Self { stream: Box::pin(stream), buffer: BytesMut::new(), eof: false }
	}

	/// Creates a finite body for injected exchanges and tests.
	#[cfg(test)]
	pub(crate) fn from_bytes(bytes: impl Into<Bytes>) -> Self {
		let bytes = bytes.into();
		Self::from_stream(futures::stream::once(async move { Ok(bytes) }))
	}

	async fn read_chunk(
		&mut self,
		cancellation: &CancellationToken,
	) -> Result<bool, TransportFailure> {
		if self.eof {
			return Ok(false);
		}
		let next = tokio::select! {
			() = cancellation.cancelled() => return Err(TransportFailure::Cancelled),
			next = self.stream.next() => next,
		};
		match next {
			Some(Ok(chunk)) => {
				if self.buffer.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
					return Err(TransportFailure::FrameTooLarge);
				}
				self.buffer.extend_from_slice(&chunk);
				Ok(true)
			},
			Some(Err(HttpExchangeError::Http(source))) => Err(TransportFailure::from_http(source)),
			Some(Err(HttpExchangeError::ResponseTooLarge)) => Err(TransportFailure::FrameTooLarge),
			None => {
				self.eof = true;
				Ok(false)
			},
		}
	}

	/// Buffers one finite JSON response under the frame bound.
	pub(crate) async fn read_to_end(
		&mut self,
		cancellation: &CancellationToken,
	) -> Result<Bytes, TransportFailure> {
		while self.read_chunk(cancellation).await? {}
		Ok(self.buffer.split().freeze())
	}

	/// Reads exactly one complete SSE event while retaining later chunks.
	pub(crate) async fn next_sse_event(
		&mut self,
		cancellation: &CancellationToken,
	) -> Result<Option<SseEvent>, TransportFailure> {
		loop {
			if let Some(end) = sse_frame_end(&self.buffer) {
				let frame = self.buffer.split_to(end).freeze();
				if let Some(event) = parse_sse_events(&frame)?.into_iter().next() {
					return Ok(Some(event));
				}
				continue;
			}
			if self.eof {
				if self.buffer.is_empty() {
					return Ok(None);
				}
				let frame = self.buffer.split().freeze();
				return Ok(parse_sse_events(&frame)?.into_iter().next());
			}
			self.read_chunk(cancellation).await?;
		}
	}
}

/// Boxed future at the cold HTTP exchange boundary.
pub type HttpFuture<'a> =
	Pin<Box<dyn Future<Output = Result<HttpResponse, HttpExchangeError>> + Send + 'a>>;

/// Injectable Environment-owned HTTP exchange.
pub trait HttpExchange: Send + Sync {
	/// Executes one redirect-disabled HTTP request.
	fn execute(&self, request: HttpRequest) -> HttpFuture<'_>;
}

/// System HTTP exchange used by production MCP transports.
#[derive(Clone)]
pub struct ReqwestExchange {
	client: omp_http::Client,
}
impl ReqwestExchange {
	/// Creates a redirect-disabled bounded exchange.
	pub fn new() -> Self {
		Self { client: omp_http::no_redirect_client() }
	}
}
impl Default for ReqwestExchange {
	fn default() -> Self {
		Self::new()
	}
}
impl HttpExchange for ReqwestExchange {
	fn execute(&self, request: HttpRequest) -> HttpFuture<'_> {
		Box::pin(async move {
			let response = self
				.client
				.request(request.method, request.url.as_str())
				.headers(request.headers)
				.body(request.body)
				.send()
				.await
				.map_err(HttpExchangeError::Http)?;
			if response
				.content_length()
				.is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
			{
				return Err(HttpExchangeError::ResponseTooLarge);
			}
			let status = response.status();
			let headers = response.headers().clone();
			let stream = response
				.bytes_stream()
				.map(|chunk| chunk.map_err(HttpExchangeError::Http));
			Ok(HttpResponse { status, headers, body: HttpBody::from_stream(stream) })
		})
	}
}

/// HTTP exchange failure.
#[derive(strum::IntoStaticStr, thiserror::Error)]
#[strum(serialize_all = "snake_case")]
pub enum HttpExchangeError {
	/// System HTTP client failed.
	#[error("MCP HTTP exchange failed")]
	Http(#[source] reqwest::Error),
	/// Response exceeded the bounded MCP frame limit.
	#[error("MCP HTTP response exceeded its size limit")]
	ResponseTooLarge,
}

impl std::fmt::Debug for HttpExchangeError {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let kind: &'static str = self.into();
		formatter
			.debug_tuple("HttpExchangeError")
			.field(&kind)
			.finish()
	}
}

/// Refreshable origin-scoped auth-header lease.
pub trait RefreshableHeaders: Send + Sync {
	/// Returns headers for the current lease generation.
	fn current(&self) -> HeaderMap;
	/// Refreshes once after a 401/403 challenge, observing the request's
	/// cancellation boundary.
	fn refresh<'a>(
		&'a self,
		cancel: &'a CancellationToken,
	) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>>;
	/// Whether the retained grant is definitively unusable and interactive
	/// authorization may replace it.
	fn should_reauthorize(&self) -> bool {
		false
	}
}

/// Streamable HTTP transport configuration.
#[derive(Clone)]
pub struct StreamableHttpConfig {
	/// MCP endpoint.
	pub url:               Url,
	/// Non-reserved configured headers.
	pub headers:           HeaderMap,
	/// Whether headers are pinned to the configured origin.
	pub origin_locked:     bool,
	/// Request timeout; `None` disables client deadlines.
	pub timeout:           Option<Duration>,
	/// Request-ID encoding.
	pub request_id_format: RequestIdFormat,
	/// Optional refreshable auth-header lease.
	pub auth:              Option<Arc<dyn RefreshableHeaders>>,
}

#[derive(Clone, Debug)]
struct ResumeState {
	last_event_id: Option<Str>,
	retry:         Duration,
}
impl Default for ResumeState {
	fn default() -> Self {
		Self { last_event_id: None, retry: DEFAULT_SSE_RETRY }
	}
}

/// Streamable HTTP POST/SSE transport.
pub struct StreamableHttpTransport {
	config:           StreamableHttpConfig,
	http:             Arc<dyn HttpExchange>,
	ids:              Mutex<RequestIdAllocator>,
	session_id:       Mutex<Option<Str>>,
	protocol_version: Mutex<Option<Str>>,
	resume:           Mutex<ResumeState>,
	sse_body:         tokio::sync::Mutex<Option<HttpBody>>,
	sse_resuming:     Mutex<bool>,
	incoming_tx:      flume::Sender<IncomingMessage>,
	incoming_rx:      Receiver<IncomingMessage>,
	lifecycle:        CancellationToken,
	closed:           atomic::AtomicBool,
}

impl Drop for StreamableHttpTransport {
	fn drop(&mut self) {
		self.closed.store(true, atomic::Ordering::Release);
		self.lifecycle.cancel();
	}
}

impl StreamableHttpTransport {
	/// Creates a transport over an injected Environment HTTP exchange.
	pub fn new(
		config: StreamableHttpConfig,
		http: Arc<dyn HttpExchange>,
	) -> Result<Self, TransportError> {
		header_policy::validate_configured_headers(&config.headers)
			.map_err(|source| TransportError::pre_dispatch(TransportFailure::HeaderPolicy(source)))?;
		let (incoming_tx, incoming_rx) = flume::bounded(256);
		Ok(Self {
			config,
			http,
			ids: Mutex::new(RequestIdAllocator::default()),
			session_id: Mutex::new(None),
			protocol_version: Mutex::new(None),
			resume: Mutex::new(ResumeState::default()),
			sse_body: tokio::sync::Mutex::new(None),
			sse_resuming: Mutex::new(false),
			incoming_tx,
			incoming_rx,
			lifecycle: CancellationToken::new(),
			closed: atomic::AtomicBool::new(false),
		})
	}

	/// Records the version negotiated by `initialize`; subsequent requests echo
	/// it.
	pub fn set_protocol_version(&self, revision: Str) {
		*self.protocol_version.lock() = Some(revision);
	}

	fn generated_headers(&self, accept: &'static str) -> HeaderMap {
		let mut headers = self
			.config
			.auth
			.as_ref()
			.map_or_else(HeaderMap::new, |auth| auth.current());
		headers.insert(ACCEPT, HeaderValue::from_static(accept));
		if let Some(session) = self.session_id.lock().as_ref() {
			if let Ok(value) = HeaderValue::from_str(session) {
				headers.insert(HeaderName::from_static("mcp-session-id"), value);
			}
		}
		if let Some(version) = self.protocol_version.lock().as_ref() {
			if let Ok(value) = HeaderValue::from_str(version) {
				headers.insert(HeaderName::from_static("mcp-protocol-version"), value);
			}
		}
		headers
	}

	async fn exchange(
		&self,
		method: Method,
		body: Bytes,
		mut generated: HeaderMap,
		cancellation: &CancellationToken,
		post_dispatched: bool,
	) -> Result<HttpResponse, TransportError> {
		if method == Method::POST {
			generated.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
		}
		let mut policy = RedirectPolicy::new(self.config.url.clone(), self.config.origin_locked)
			.map_err(|source| TransportError::pre_dispatch(TransportFailure::HeaderPolicy(source)))?;
		loop {
			let headers = policy
				.headers(&generated, &self.config.headers)
				.map_err(|source| {
					TransportError::pre_dispatch(TransportFailure::HeaderPolicy(source))
				})?;
			let future = self.http.execute(HttpRequest {
				method: method.clone(),
				url: policy.url().clone(),
				headers,
				body: body.clone(),
			});
			let response = if let Some(timeout) = self.config.timeout {
				tokio::select! { () = cancellation.cancelled() => return Err(dispatch_error(post_dispatched, TransportFailure::Cancelled)), result = tokio::time::timeout(timeout, future) => match result { Ok(result) => result, Err(_) => return Err(dispatch_error(post_dispatched, TransportFailure::TimedOut)) } }
			} else { tokio::select! { () = cancellation.cancelled() => return Err(dispatch_error(post_dispatched, TransportFailure::Cancelled)), result = future => result } }.map_err(|error| match error { HttpExchangeError::Http(source) => dispatch_error(post_dispatched, TransportFailure::from_http(source)), HttpExchangeError::ResponseTooLarge => dispatch_error(post_dispatched, TransportFailure::FrameTooLarge) })?;
			if policy
				.redirect(&method, response.status, redirect_location(&response.headers))
				.map_err(|source| {
					dispatch_error(post_dispatched, TransportFailure::HeaderPolicy(source))
				})? {
				continue;
			}
			return Ok(response);
		}
	}

	async fn exchange_with_refresh(
		&self,
		method: Method,
		body: Bytes,
		generated: HeaderMap,
		cancellation: &CancellationToken,
		post_dispatched: bool,
	) -> Result<HttpResponse, TransportError> {
		let mut response = self
			.exchange(method.clone(), body.clone(), generated.clone(), cancellation, post_dispatched)
			.await?;
		if matches!(response.status, StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN)
			&& let Some(auth) = &self.config.auth
		{
			let refresh = auth.refresh(cancellation);
			let refreshed = match self.config.timeout {
				Some(timeout) => tokio::select! {
					() = cancellation.cancelled() => {
						return Err(dispatch_error(post_dispatched, TransportFailure::Cancelled));
					},
					() = self.lifecycle.cancelled() => {
						return Err(dispatch_error(post_dispatched, TransportFailure::Cancelled));
					},
					result = tokio::time::timeout(timeout, refresh) => {
						result.map_err(|_| {
							dispatch_error(post_dispatched, TransportFailure::TimedOut)
						})?
					},
				},
				None => tokio::select! {
					() = cancellation.cancelled() => {
						return Err(dispatch_error(post_dispatched, TransportFailure::Cancelled));
					},
					() = self.lifecycle.cancelled() => {
						return Err(dispatch_error(post_dispatched, TransportFailure::Cancelled));
					},
					result = refresh => result,
				},
			};
			if refreshed {
				let mut refreshed_headers = generated;
				for (name, value) in &auth.current() {
					refreshed_headers.insert(name, value.clone());
				}
				response = self
					.exchange(method, body, refreshed_headers, cancellation, post_dispatched)
					.await?;
			}
		}
		Ok(response)
	}

	async fn request_inner(
		&self,
		method: &str,
		params: Value,
		cancellation: CancellationToken,
	) -> Result<TransportResponse, TransportError> {
		if self.closed.load(atomic::Ordering::Acquire) {
			return Err(TransportError::pre_dispatch(TransportFailure::Closed));
		}
		let id = self
			.ids
			.lock()
			.next(self.config.request_id_format)
			.map_err(|_| TransportError::pre_dispatch(TransportFailure::Correlation))?;
		let body =
			serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
				.map(Bytes::from)
				.map_err(|source| TransportError::pre_dispatch(TransportFailure::Json(source)))?;
		let mut response = self
			.exchange_with_refresh(
				Method::POST,
				body,
				self.generated_headers("application/json, text/event-stream"),
				&cancellation,
				true,
			)
			.await?;
		self.capture_session(&response.headers);
		if !response.status.is_success() {
			return Err(TransportError {
				dispatch: DispatchState::Responded,
				cause:    TransportFailure::HttpStatus { status: response.status.as_u16() },
			});
		}
		let result = if is_sse(&response.headers) {
			self
				.response_from_sse(response.body, &id, &cancellation)
				.await?
		} else {
			let body = response
				.body
				.read_to_end(&cancellation)
				.await
				.map_err(|cause| TransportError::effects_unknown(cause))?;
			correlated_json(&body, &id)?
		};
		Ok(TransportResponse { id, result, dispatch: DispatchState::Responded })
	}

	fn capture_session(&self, headers: &HeaderMap) {
		if let Some(value) = headers
			.get("mcp-session-id")
			.and_then(|value| value.to_str().ok())
		{
			*self.session_id.lock() = Some(Str::from(value));
		}
	}

	async fn response_from_sse(
		&self,
		mut body: HttpBody,
		expected: &RequestId,
		cancellation: &CancellationToken,
	) -> Result<Value, TransportError> {
		let mut resume = ResumeState::default();
		let mut resumed = false;
		loop {
			let mut progressed = false;
			while let Some(event) = body
				.next_sse_event(cancellation)
				.await
				.map_err(|cause| TransportError::effects_unknown(cause))?
			{
				progressed = true;
				if let Some(result) = self.consume_sse_event(event, Some(expected), &mut resume)? {
					return Ok(result);
				}
			}
			if resumed && !progressed {
				return Err(TransportError::effects_unknown(TransportFailure::Correlation));
			}
			let Some(last_event_id) = resume.last_event_id.clone() else {
				return Err(TransportError::effects_unknown(TransportFailure::Correlation));
			};
			tokio::select! { () = cancellation.cancelled() => return Err(TransportError::effects_unknown(TransportFailure::Cancelled)), () = tokio::time::sleep(resume.retry) => {} }
			let mut headers = self.generated_headers("text/event-stream");
			headers.insert(
				HeaderName::from_static("last-event-id"),
				HeaderValue::from_str(&last_event_id)
					.map_err(|_| TransportError::effects_unknown(TransportFailure::SseProtocol))?,
			);
			let response = self
				.exchange_with_refresh(Method::GET, Bytes::new(), headers, cancellation, false)
				.await
				.map_err(mark_effects_unknown)?;
			if !response.status.is_success() || !is_sse(&response.headers) {
				return Err(TransportError::effects_unknown(TransportFailure::HttpStatus {
					status: response.status.as_u16(),
				}));
			}
			body = response.body;
			resumed = true;
		}
	}

	fn consume_sse_event(
		&self,
		event: SseEvent,
		expected: Option<&RequestId>,
		resume: &mut ResumeState,
	) -> Result<Option<Value>, TransportError> {
		if let Some(id) = event.id {
			resume.last_event_id = if id.is_empty() { None } else { Some(id) };
		}
		if let Some(retry) = event.retry {
			resume.retry = retry;
		}
		if event.data.is_empty() {
			return Ok(None);
		}
		let value: Value = serde_json::from_str(&event.data)
			.map_err(|source| TransportError::effects_unknown(TransportFailure::Json(source)))?;
		let mut response = None;
		let messages = value
			.as_array()
			.map_or_else(|| std::slice::from_ref(&value), Vec::as_slice);
		for message in messages {
			let message_id = message
				.get("id")
				.and_then(|value| serde_json::from_value::<RequestId>(value.clone()).ok());
			if expected.is_some_and(|id| message_id.as_ref() == Some(id)) {
				if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
					return Err(TransportError::effects_unknown(TransportFailure::MalformedFrame));
				}
				match (message.get("result"), message.get("error")) {
					(Some(result), None) => response = Some(result.clone()),
					(None, Some(error)) => {
						let code = error.get("code").and_then(Value::as_i64).ok_or_else(|| {
							TransportError::effects_unknown(TransportFailure::MalformedFrame)
						})?;
						return Err(TransportError {
							dispatch: DispatchState::Responded,
							cause:    TransportFailure::JsonRpc { code },
						});
					},
					_ => {
						return Err(TransportError::effects_unknown(TransportFailure::MalformedFrame));
					},
				}
			} else {
				dispatch_incoming(&self.incoming_tx, &message);
			}
		}
		Ok(response)
	}

	async fn park_optional_listener(
		&self,
		cancellation: &CancellationToken,
	) -> Result<IncomingMessage, TransportError> {
		tokio::select! {
			() = cancellation.cancelled() => {
				Err(TransportError::pre_dispatch(TransportFailure::Cancelled))
			},
			() = self.lifecycle.cancelled() => {
				Err(TransportError::pre_dispatch(TransportFailure::Cancelled))
			},
		}
	}

	async fn next_inner(
		&self,
		cancellation: CancellationToken,
	) -> Result<IncomingMessage, TransportError> {
		loop {
			if let Ok(message) = self.incoming_rx.try_recv() {
				return Ok(message);
			}
			let mut body = self.sse_body.lock().await;
			if body.is_none() {
				let resume = self.resume.lock().clone();
				if resume.last_event_id.is_some() {
					tokio::select! {
						() = cancellation.cancelled() => {
							return Err(TransportError::pre_dispatch(TransportFailure::Cancelled));
						},
						() = tokio::time::sleep(resume.retry) => {},
					}
				}
				let mut headers = self.generated_headers("text/event-stream");
				let resuming = resume.last_event_id.is_some();
				if let Some(id) = resume.last_event_id.as_ref() {
					headers.insert(
						HeaderName::from_static("last-event-id"),
						HeaderValue::from_str(id)
							.map_err(|_| TransportError::pre_dispatch(TransportFailure::SseProtocol))?,
					);
				}
				let response = match self
					.exchange_with_refresh(Method::GET, Bytes::new(), headers, &cancellation, false)
					.await
				{
					Ok(response) => response,
					Err(_error) if !resuming => {
						return self.park_optional_listener(&cancellation).await;
					},
					Err(error) => return Err(error),
				};
				if !response.status.is_success() || !is_sse(&response.headers) {
					if !resuming {
						return self.park_optional_listener(&cancellation).await;
					}
					return Err(TransportError::pre_dispatch(TransportFailure::HttpStatus {
						status: response.status.as_u16(),
					}));
				}
				*body = Some(response.body);
				*self.sse_resuming.lock() = resuming;
			}
			let event = body
				.as_mut()
				.expect("SSE body installed")
				.next_sse_event(&cancellation)
				.await
				.map_err(|cause| TransportError::pre_dispatch(cause))?;
			match event {
				Some(event) => {
					*self.sse_resuming.lock() = false;
					self.consume_sse_event(event, None, &mut *self.resume.lock())?;
					drop(body);
					if let Ok(message) = self.incoming_rx.try_recv() {
						return Ok(message);
					}
				},
				None => {
					*body = None;
					let resumed_without_progress = mem::take(&mut *self.sse_resuming.lock());
					if resumed_without_progress || self.resume.lock().last_event_id.is_none() {
						return Err(TransportError::pre_dispatch(TransportFailure::Closed));
					}
				},
			}
		}
	}
}

impl McpTransport for StreamableHttpTransport {
	fn set_protocol_version(&self, revision: Str) {
		Self::set_protocol_version(self, revision);
	}

	fn request<'a>(
		&'a self,
		method: &'a str,
		params: Value,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<TransportResponse, TransportError>> {
		Box::pin(async move {
			let operation = async {
				let request = self.request_inner(method, params, cancellation);
				match self.config.timeout {
					Some(timeout) => tokio::time::timeout(timeout, request)
						.await
						.map_err(|_| TransportError::effects_unknown(TransportFailure::TimedOut))?,
					None => request.await,
				}
			};
			tokio::select! {
				() = self.lifecycle.cancelled() => {
					Err(TransportError::effects_unknown(TransportFailure::Cancelled))
				},
				result = operation => result,
			}
		})
	}

	fn notify<'a>(
		&'a self,
		method: &'a str,
		params: Value,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<DispatchState, TransportError>> {
		Box::pin(async move {
			let operation = async {
				let body =
					serde_json::to_vec(&json!({"jsonrpc":"2.0","method":method,"params":params}))
						.map(Bytes::from)
						.map_err(|source| TransportError::pre_dispatch(TransportFailure::Json(source)))?;
				let response = self
					.exchange_with_refresh(
						Method::POST,
						body,
						self.generated_headers("application/json, text/event-stream"),
						&cancellation,
						true,
					)
					.await?;
				self.capture_session(&response.headers);
				if response.status.is_success() || response.status == StatusCode::ACCEPTED {
					if is_sse(&response.headers) {
						drain_unsolicited_sse(
							response.body,
							self.incoming_tx.clone(),
							self.lifecycle.child_token(),
						);
					}
					Ok(DispatchState::Dispatched)
				} else {
					Err(TransportError {
						dispatch: DispatchState::Responded,
						cause:    TransportFailure::HttpStatus { status: response.status.as_u16() },
					})
				}
			};
			let deadline = async {
				match self.config.timeout {
					Some(timeout) => tokio::time::timeout(timeout, operation)
						.await
						.map_err(|_| TransportError::effects_unknown(TransportFailure::TimedOut))?,
					None => operation.await,
				}
			};
			tokio::select! {
				() = self.lifecycle.cancelled() => {
					Err(TransportError::effects_unknown(TransportFailure::Cancelled))
				},
				result = deadline => result,
			}
		})
	}

	fn next_message<'a>(
		&'a self,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<IncomingMessage, TransportError>> {
		Box::pin(async move {
			tokio::select! {
				() = self.lifecycle.cancelled() => {
					Err(TransportError::pre_dispatch(TransportFailure::Cancelled))
				},
				result = self.next_inner(cancellation) => result,
			}
		})
	}

	fn respond<'a>(
		&'a self,
		id: RequestId,
		result: Result<Value, ServerResponseError>,
		cancellation: CancellationToken,
	) -> TransportFuture<'a, Result<DispatchState, TransportError>> {
		Box::pin(async move {
			let operation = async {
				let value = match result {
					Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
					Err(error) => {
						json!({"jsonrpc":"2.0","id":id,"error":{"code":error.code,"message":error.message,"data":error.data}})
					},
				};
				let body = serde_json::to_vec(&value)
					.map(Bytes::from)
					.map_err(|source| TransportError::pre_dispatch(TransportFailure::Json(source)))?;
				let response = self
					.exchange_with_refresh(
						Method::POST,
						body,
						self.generated_headers("application/json, text/event-stream"),
						&cancellation,
						true,
					)
					.await?;
				self.capture_session(&response.headers);
				if response.status.is_success() {
					if is_sse(&response.headers) {
						drain_unsolicited_sse(
							response.body,
							self.incoming_tx.clone(),
							self.lifecycle.child_token(),
						);
					}
					Ok(DispatchState::Dispatched)
				} else {
					Err(TransportError {
						dispatch: DispatchState::Responded,
						cause:    TransportFailure::HttpStatus { status: response.status.as_u16() },
					})
				}
			};
			let deadline = async {
				match self.config.timeout {
					Some(timeout) => tokio::time::timeout(timeout, operation)
						.await
						.map_err(|_| TransportError::effects_unknown(TransportFailure::TimedOut))?,
					None => operation.await,
				}
			};
			tokio::select! {
				() = self.lifecycle.cancelled() => {
					Err(TransportError::effects_unknown(TransportFailure::Cancelled))
				},
				result = deadline => result,
			}
		})
	}

	fn close(&self) -> TransportFuture<'_, Result<(), TransportError>> {
		Box::pin(async move {
			if self.closed.swap(true, atomic::Ordering::AcqRel) {
				return Ok(());
			}
			self.lifecycle.cancel();
			*self.sse_body.lock().await = None;
			tokio::task::yield_now().await;
			if self.session_id.lock().is_some() {
				let cancellation = CancellationToken::new();
				let _ = self
					.exchange(
						Method::DELETE,
						Bytes::new(),
						self.generated_headers("application/json"),
						&cancellation,
						false,
					)
					.await;
				*self.session_id.lock() = None;
			}
			let _ = self.incoming_tx.try_send(IncomingMessage::Closed);
			Ok(())
		})
	}
}

fn drain_unsolicited_sse(
	mut body: HttpBody,
	sender: flume::Sender<IncomingMessage>,
	cancellation: CancellationToken,
) {
	tokio::spawn(async move {
		loop {
			let event = match body.next_sse_event(&cancellation).await {
				Ok(Some(event)) => event,
				Ok(None) | Err(_) => break,
			};
			if event.data.is_empty() {
				continue;
			}
			let Ok(value) = serde_json::from_str::<Value>(&event.data) else {
				break;
			};
			if let Some(messages) = value.as_array() {
				for message in messages {
					dispatch_incoming(&sender, message);
				}
			} else {
				dispatch_incoming(&sender, &value);
			}
		}
	});
}

fn mark_effects_unknown(error: TransportError) -> TransportError {
	TransportError { dispatch: DispatchState::EffectsUnknown, ..error }
}

fn dispatch_error(dispatched: bool, cause: TransportFailure) -> TransportError {
	if dispatched {
		TransportError::effects_unknown(cause)
	} else {
		TransportError::pre_dispatch(cause)
	}
}

/// Returns whether a response declares the SSE media type.
pub(crate) fn is_sse(headers: &HeaderMap) -> bool {
	headers
		.get(CONTENT_TYPE)
		.and_then(|value| value.to_str().ok())
		.is_some_and(|value| value.to_ascii_lowercase().contains("text/event-stream"))
}
fn correlated_json(body: &[u8], expected: &RequestId) -> Result<Value, TransportError> {
	let value: Value = serde_json::from_slice(body)
		.map_err(|source| TransportError::effects_unknown(TransportFailure::Json(source)))?;
	if value.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
		return Err(TransportError::effects_unknown(TransportFailure::MalformedFrame));
	}
	let id = value
		.get("id")
		.and_then(|id| serde_json::from_value::<RequestId>(id.clone()).ok())
		.ok_or_else(|| TransportError::effects_unknown(TransportFailure::MalformedFrame))?;
	if &id != expected {
		return Err(TransportError::effects_unknown(TransportFailure::Correlation));
	}
	match (value.get("result"), value.get("error")) {
		(Some(result), None) => Ok(result.clone()),
		(None, Some(error)) => {
			let code = error
				.get("code")
				.and_then(Value::as_i64)
				.ok_or_else(|| TransportError::effects_unknown(TransportFailure::MalformedFrame))?;
			Err(TransportError {
				dispatch: DispatchState::Responded,
				cause:    TransportFailure::JsonRpc { code },
			})
		},
		_ => Err(TransportError::effects_unknown(TransportFailure::MalformedFrame)),
	}
}
fn dispatch_incoming(sender: &flume::Sender<IncomingMessage>, message: &Value) {
	let Some(method) = message.get("method").and_then(Value::as_str) else {
		return;
	};
	let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
	let incoming = if let Some(value) = message.get("id") {
		let Ok(id) = serde_json::from_value::<RequestId>(value.clone()) else {
			return;
		};
		IncomingMessage::Request { id, method: Str::from(method), params }
	} else {
		IncomingMessage::Notification { method: Str::from(method), params }
	};
	let _ = sender.try_send(incoming);
}

fn sse_frame_end(buffer: &[u8]) -> Option<usize> {
	fn line_ending(bytes: &[u8], offset: usize) -> Option<usize> {
		match bytes.get(offset) {
			Some(b'\n') => Some(1),
			Some(b'\r') if bytes.get(offset + 1) == Some(&b'\n') => Some(2),
			Some(b'\r') => Some(1),
			_ => None,
		}
	}

	for offset in 0..buffer.len() {
		let Some(first) = line_ending(buffer, offset) else {
			continue;
		};
		if let Some(second) = line_ending(buffer, offset + first) {
			return Some(offset + first + second);
		}
	}
	None
}

#[derive(Debug)]
pub(crate) struct SseEvent {
	pub event: Option<Str>,
	pub id:    Option<Str>,
	pub retry: Option<Duration>,
	pub data:  String,
}

struct SseLines<'a> {
	text:     &'a str,
	position: usize,
}

impl<'a> SseLines<'a> {
	const fn new(text: &'a str) -> Self {
		Self { text, position: 0 }
	}
}

impl<'a> Iterator for SseLines<'a> {
	type Item = &'a str;

	fn next(&mut self) -> Option<Self::Item> {
		if self.position >= self.text.len() {
			return None;
		}
		let rest = &self.text[self.position..];
		let ending = rest
			.as_bytes()
			.iter()
			.position(|byte| matches!(byte, b'\r' | b'\n'));
		let Some(ending) = ending else {
			self.position = self.text.len();
			return Some(rest);
		};
		let line = &rest[..ending];
		let width = if rest.as_bytes().get(ending) == Some(&b'\r')
			&& rest.as_bytes().get(ending + 1) == Some(&b'\n')
		{
			2
		} else {
			1
		};
		self.position += ending + width;
		Some(line)
	}
}

pub(crate) fn parse_sse_events(body: &[u8]) -> Result<Vec<SseEvent>, TransportFailure> {
	let text = str::from_utf8(body).map_err(|_| TransportFailure::SseProtocol)?;
	let mut events = Vec::new();
	let mut event = None;
	let mut id = None;
	let mut retry = None;
	let mut data = String::new();
	for line in SseLines::new(text).chain(iter::once("")) {
		if line.is_empty() {
			if event.is_some() || id.is_some() || retry.is_some() || !data.is_empty() {
				if data.ends_with('\n') {
					data.pop();
				}
				events.push(SseEvent {
					event: event.take(),
					id:    id.take(),
					retry: retry.take(),
					data:  mem::take(&mut data),
				});
			}
			continue;
		}
		if line.starts_with(':') {
			continue;
		}
		let (field, value) = line
			.split_once(':')
			.map_or((line, ""), |(field, value)| (field, value.strip_prefix(' ').unwrap_or(value)));
		match field {
			"event" => event = Some(Str::from(value)),
			"id" if !value.contains('\0') => id = Some(Str::from(value)),
			"retry" => retry = value.parse::<u64>().ok().map(Duration::from_millis),
			"data" => {
				data.push_str(value);
				data.push('\n');
			},
			_ => {},
		}
	}
	Ok(events)
}

#[cfg(test)]
mod tests {
	use std::{
		collections::VecDeque,
		sync::atomic::{AtomicUsize, Ordering},
	};

	use super::*;

	struct Fixture {
		responses: Mutex<VecDeque<HttpResponse>>,
		requests:  Mutex<Vec<HttpRequest>>,
		refreshes: AtomicUsize,
	}
	impl HttpExchange for Fixture {
		fn execute(&self, request: HttpRequest) -> HttpFuture<'_> {
			self.requests.lock().push(request);
			let response = self.responses.lock().pop_front().expect("fixture response");
			Box::pin(async move { Ok(response) })
		}
	}
	impl RefreshableHeaders for Fixture {
		fn current(&self) -> HeaderMap {
			HeaderMap::from_iter([(
				HeaderName::from_static("authorization"),
				HeaderValue::from_static("Bearer refreshed"),
			)])
		}

		fn refresh<'a>(
			&'a self,
			_cancel: &'a CancellationToken,
		) -> Pin<Box<dyn Future<Output = bool> + Send + 'a>> {
			self.refreshes.fetch_add(1, Ordering::SeqCst);
			Box::pin(async { true })
		}
	}
	fn response(
		status: StatusCode,
		content_type: &'static str,
		body: impl Into<Bytes>,
		session: Option<&'static str>,
	) -> HttpResponse {
		let mut headers =
			HeaderMap::from_iter([(CONTENT_TYPE, HeaderValue::from_static(content_type))]);
		if let Some(session) = session {
			headers
				.insert(HeaderName::from_static("mcp-session-id"), HeaderValue::from_static(session));
		}
		HttpResponse { status, headers, body: HttpBody::from_bytes(body) }
	}

	#[tokio::test]
	async fn long_lived_get_dispatches_first_sse_notification_before_eof() {
		struct OpenGet;
		impl HttpExchange for OpenGet {
			fn execute(&self, _: HttpRequest) -> HttpFuture<'_> {
				Box::pin(async {
					let stream = futures::stream::once(async {
						Ok(Bytes::from_static(
							b"data: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/tools/list_changed\",\"params\":{}}\n\n",
						))
					})
					.chain(futures::stream::pending::<Result<Bytes, HttpExchangeError>>());
					Ok(HttpResponse {
						status:  StatusCode::OK,
						headers: HeaderMap::from_iter([(
							CONTENT_TYPE,
							HeaderValue::from_static("text/event-stream"),
						)]),
						body:    HttpBody::from_stream(stream),
					})
				})
			}
		}
		let transport = StreamableHttpTransport::new(
			StreamableHttpConfig {
				url:               Url::parse("https://example.test/mcp").expect("url"),
				headers:           HeaderMap::new(),
				origin_locked:     true,
				timeout:           Some(Duration::from_secs(1)),
				request_id_format: RequestIdFormat::Number,
				auth:              None,
			},
			Arc::new(OpenGet),
		)
		.expect("transport");

		let message = tokio::time::timeout(
			Duration::from_millis(100),
			transport.next_message(CancellationToken::new()),
		)
		.await
		.expect("notification before EOF")
		.expect("message");
		assert!(matches!(
			message,
			IncomingMessage::Notification { method, .. }
				if method == "notifications/tools/list_changed"
		));
	}

	#[tokio::test]
	async fn unsupported_optional_get_listener_stays_dormant() {
		struct Unsupported;
		impl HttpExchange for Unsupported {
			fn execute(&self, _: HttpRequest) -> HttpFuture<'_> {
				Box::pin(async {
					Ok(HttpResponse {
						status:  StatusCode::METHOD_NOT_ALLOWED,
						headers: HeaderMap::new(),
						body:    HttpBody::from_bytes(Bytes::new()),
					})
				})
			}
		}
		let transport = StreamableHttpTransport::new(
			StreamableHttpConfig {
				url:               Url::parse("https://example.test/mcp").expect("url"),
				headers:           HeaderMap::new(),
				origin_locked:     true,
				timeout:           Some(Duration::from_secs(1)),
				request_id_format: RequestIdFormat::Number,
				auth:              None,
			},
			Arc::new(Unsupported),
		)
		.expect("transport");
		let cancellation = CancellationToken::new();
		let listener = transport.next_message(cancellation.clone());
		tokio::pin!(listener);
		assert!(
			tokio::time::timeout(Duration::from_millis(10), &mut listener)
				.await
				.is_err()
		);
		cancellation.cancel();
		let error = listener.await.expect_err("cancelled dormant listener");
		assert!(matches!(error.cause, TransportFailure::Cancelled));
	}

	#[tokio::test]
	async fn request_deadline_covers_streaming_json_body() {
		struct HangingBody;
		impl HttpExchange for HangingBody {
			fn execute(&self, _: HttpRequest) -> HttpFuture<'_> {
				Box::pin(async {
					Ok(HttpResponse {
						status:  StatusCode::OK,
						headers: HeaderMap::from_iter([(
							CONTENT_TYPE,
							HeaderValue::from_static("application/json"),
						)]),
						body:    HttpBody::from_stream(futures::stream::pending::<
							Result<Bytes, HttpExchangeError>,
						>()),
					})
				})
			}
		}
		let transport = StreamableHttpTransport::new(
			StreamableHttpConfig {
				url:               Url::parse("https://example.test/mcp").expect("url"),
				headers:           HeaderMap::new(),
				origin_locked:     true,
				timeout:           Some(Duration::from_millis(10)),
				request_id_format: RequestIdFormat::Number,
				auth:              None,
			},
			Arc::new(HangingBody),
		)
		.expect("transport");
		let error = transport
			.request("tools/list", json!({}), CancellationToken::new())
			.await
			.expect_err("body deadline");
		assert!(matches!(error.cause, TransportFailure::TimedOut));
	}

	#[tokio::test]
	async fn close_cancels_an_in_flight_http_exchange() {
		struct HangingExchange;
		impl HttpExchange for HangingExchange {
			fn execute(&self, _: HttpRequest) -> HttpFuture<'_> {
				Box::pin(std::future::pending())
			}
		}
		let transport = Arc::new(
			StreamableHttpTransport::new(
				StreamableHttpConfig {
					url:               Url::parse("https://example.test/mcp").expect("url"),
					headers:           HeaderMap::new(),
					origin_locked:     true,
					timeout:           None,
					request_id_format: RequestIdFormat::Number,
					auth:              None,
				},
				Arc::new(HangingExchange),
			)
			.expect("transport"),
		);
		let request_transport = transport.clone();
		let request = tokio::spawn(async move {
			request_transport
				.request("tools/list", json!({}), CancellationToken::new())
				.await
		});
		tokio::task::yield_now().await;
		transport.close().await.expect("close");
		let error = request
			.await
			.expect("join")
			.expect_err("request must be cancelled");
		assert!(matches!(error.cause, TransportFailure::Cancelled));
	}

	#[test]
	fn debug_output_redacts_request_credentials_and_rpc_query_secrets() {
		let request = HttpRequest {
			method:  Method::POST,
			url:     Url::parse("https://example.test/mcp?api_key=top-secret&view=all").expect("url"),
			headers: HeaderMap::from_iter([
				(
					HeaderName::from_static("authorization"),
					HeaderValue::from_static("Bearer top-secret"),
				),
				(HeaderName::from_static("x-request-id"), HeaderValue::from_static("trace-safe")),
			]),
			body:    Bytes::from_static(b"{\"secret\":\"body-secret\"}"),
		};
		let debug = format!("{request:?}");
		assert!(!debug.contains("top-secret"));
		assert!(!debug.contains("body-secret"));
		assert!(!debug.contains("trace-safe"));
		assert!(debug.contains("x-request-id"));
		assert!(debug.contains("view=all"));
	}

	#[test]
	fn retry_only_sse_event_updates_resume_metadata() {
		let events = parse_sse_events(b"retry: 17\n\n").expect("SSE");
		assert_eq!(events.len(), 1);
		assert_eq!(events[0].retry, Some(Duration::from_millis(17)));
		assert_eq!(sse_frame_end(b"data: one\n\r\ndata: two"), Some(12));
		assert_eq!(sse_frame_end(b"data: one\r\rdata: two"), Some(11));
		let events = parse_sse_events(b"data: one\r\r").expect("bare CR SSE");
		assert_eq!(events[0].data, "one");
	}

	#[tokio::test]
	async fn fixture_proves_headers_post_sse_resume_redirect_and_refresh() {
		let fixture = Arc::new(Fixture { responses: Mutex::new(VecDeque::from([
			response(StatusCode::UNAUTHORIZED, "application/json", Bytes::new(), None),
			response(StatusCode::OK, "text/event-stream", Bytes::from_static(b"id: stream-1\nretry: 1\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"progress\",\"params\":{}}\n\n"), Some("session-1")),
			response(StatusCode::OK, "text/event-stream", Bytes::from_static(b"id: stream-2\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\"result\":{\"ok\":true}}\n\n"), None),
		])) , requests: Mutex::new(Vec::new()), refreshes: AtomicUsize::new(0) });
		let auth: Arc<dyn RefreshableHeaders> = fixture.clone();
		let http: Arc<dyn HttpExchange> = fixture.clone();
		let transport = StreamableHttpTransport::new(
			StreamableHttpConfig {
				url:               Url::parse("https://example.test/mcp").expect("url"),
				headers:           HeaderMap::new(),
				origin_locked:     true,
				timeout:           Some(Duration::from_secs(1)),
				request_id_format: RequestIdFormat::Number,
				auth:              Some(auth),
			},
			http,
		)
		.expect("transport");
		transport.set_protocol_version(Str::from("2025-11-25"));
		let result = transport
			.request("tools/list", json!({}), CancellationToken::new())
			.await
			.expect("request");
		assert_eq!(result.result["ok"], true);
		assert_eq!(fixture.refreshes.load(Ordering::SeqCst), 1);
		let requests = fixture.requests.lock();
		assert_eq!(requests.len(), 3);
		assert_eq!(requests[2].method, Method::GET);
		assert_eq!(requests[2].headers["last-event-id"], "stream-1");
		assert_eq!(requests[2].headers["mcp-session-id"], "session-1");
		assert_eq!(requests[2].headers["mcp-protocol-version"], "2025-11-25");
	}
}
