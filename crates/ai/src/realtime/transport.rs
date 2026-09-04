//! Authenticated Codex SDP signaling and realtime sideband coordination.

use std::{collections::VecDeque, error, future::Future, io, sync::Arc, time::Duration};

use futures::{SinkExt as _, StreamExt as _};
use http::{
	Request,
	header::{HeaderName, HeaderValue},
};
use omp_audio::coordinator::AudioCoordinator;
use omp_core::{FastHashSet, FastState, Str, base64};
use serde::Serialize;
use serde_json::{Value, json};
use thiserror::Error;
use tokio::{
	io::{AsyncReadExt as _, AsyncWriteExt as _},
	net::TcpStream,
	time,
};
use tokio_tungstenite::{
	MaybeTlsStream, WebSocketStream, client_async_tls_with_config, connect_async,
	tungstenite::{self, Message, client::IntoClientRequest as _},
};
use url::Url;
use zeroize::Zeroizing;

use super::{
	attestation::generate_codex_attestation,
	live::{DEFAULT_OPEN_TIMEOUT_MS, LiveCallbacks, LiveMediaError as VoiceError, LiveMediaSession},
};

/// Codex live-call signaling endpoint.
pub const SIGNALING_URL: &str =
	"https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const SIDEBAND_ATTEMPTS: usize = 5;
const SIDEBAND_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const PROXY_RESPONSE_LIMIT: usize = 8 * 1024;
const CONTEXT_CHUNK_BYTES: usize = 500;
const DEDUP_WINDOW: usize = 4_096;
const AGENT_FINAL_MESSAGE_HEADER: &str = "\"Agent Final Message\":\n\n";
const AGENT_CANCELLED_MESSAGE: &str =
	"\"Agent Delegation Cancelled\":\n\nThe delegated request was cancelled before completion.";
const AGENT_FAILED_MESSAGE_HEADER: &str = "\"Agent Delegation Failed\":\n\n";
const AGENT_FAILED_MESSAGE: &str =
	"\"Agent Delegation Failed\":\n\nThe delegated request failed before completion.";

/// Opaque OAuth headers leased by the application credential authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveOAuthAccess {
	/// Sensitive `Bearer …` header. The raw token never crosses this boundary.
	pub authorization: HeaderValue,
	/// Optional `ChatGPT` account identity.
	pub account_id:    Option<Str>,
}

/// A sanitized HTTP CONNECT proxy route shared by live signaling and sideband.
///
/// User information is removed from the URL at construction time. Proxy
/// credentials survive only as a sensitive HTTP header, so derived diagnostics
/// cannot expose the raw username or password.
#[derive(Clone, Eq, PartialEq)]
pub struct LiveProxy {
	endpoint:      Url,
	authorization: Option<HeaderValue>,
}

impl std::fmt::Debug for LiveProxy {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("LiveProxy")
			.field("scheme", &self.endpoint.scheme())
			.field("host", &self.endpoint.host_str())
			.field("port", &self.endpoint.port_or_known_default())
			.field("authenticated", &self.authorization.is_some())
			.finish()
	}
}

/// Proxy credential normalization failures.
#[derive(Debug, Error)]
pub enum LiveProxyError {
	/// Percent-encoded proxy credentials were malformed.
	#[error("the live proxy credentials are malformed")]
	InvalidCredentials,
	/// The generated proxy authorization header was invalid.
	#[error("the live proxy authorization header is invalid")]
	InvalidAuthorization {
		/// Typed header source.
		#[source]
		source: http::header::InvalidHeaderValue,
	},
	/// The sanitized URL could not accept an empty username.
	#[error("the live proxy URL cannot be sanitized")]
	UnsanitizableUrl,
}

impl LiveProxy {
	/// Retains user information as a sensitive Basic proxy-authorization header
	/// and reduces `url` to the proxy origin used by CONNECT.
	pub fn from_url(mut url: Url) -> Result<Self, LiveProxyError> {
		let authorization = proxy_authorization(&url)?;
		url.set_username("")
			.map_err(|()| LiveProxyError::UnsanitizableUrl)?;
		url.set_password(None)
			.map_err(|()| LiveProxyError::UnsanitizableUrl)?;
		url.set_path("");
		url.set_query(None);
		url.set_fragment(None);
		Ok(Self { endpoint: url, authorization })
	}

	/// Sanitized proxy origin without user information, path, query, or
	/// fragment.
	#[must_use]
	pub const fn endpoint(&self) -> &Url {
		&self.endpoint
	}

	/// Sensitive `Proxy-Authorization` value, when credentials were supplied.
	#[must_use]
	pub const fn authorization(&self) -> Option<&HeaderValue> {
		self.authorization.as_ref()
	}
}

/// Inputs required to establish one live transport.
#[derive(Clone, Debug)]
pub struct LiveTransportOptions {
	/// Durable OMP session identity.
	pub session_id:       Str,
	/// Per-connection realtime identity.
	pub realtime_session: Str,
	/// Voice-friendly system instructions.
	pub instructions:     Str,
	/// Stable live voice identifier.
	pub voice:            Str,
	/// Codex client version header.
	pub client_version:   Str,
	/// Optional sanitized proxy selected by the network authority.
	pub proxy:            Option<LiveProxy>,
	/// Data-channel open timeout.
	pub open_timeout:     Duration,
}

impl LiveTransportOptions {
	/// Creates options with the data-channel timeout.
	pub fn new(session_id: Str, instructions: Str, voice: Str, client_version: Str) -> Self {
		Self {
			session_id,
			realtime_session: Str::from(omp_core::Ulid::generate().to_string()),
			instructions,
			voice,
			client_version,
			proxy: None,
			open_timeout: Duration::from_millis(u64::from(DEFAULT_OPEN_TIMEOUT_MS)),
		}
	}
}

/// Complete authenticated signaling request produced by the voice domain.
#[derive(Clone, Debug)]
pub struct LiveSignalingRequest {
	/// Fixed Codex endpoint.
	pub url:     &'static str,
	/// Secret-bearing headers for the credential-aware HTTP boundary.
	pub headers: Vec<(Str, HeaderValue)>,
	/// JSON request body containing SDP and the session payload.
	pub body:    Vec<u8>,
	/// Sanitized proxy selected for this provider, if any.
	pub proxy:   Option<LiveProxy>,
}

/// Accepted SDP answer and server-assigned `rtc_*` call identity.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveSignalingResponse {
	/// Remote SDP answer.
	pub answer:   Str,
	/// HTTP Location header.
	pub location: Str,
	/// Exact OAuth generation used for signaling and therefore sideband.
	pub access:   LiveOAuthAccess,
}

/// Unboxed signaling boundary implemented by the application's authenticated
/// HTTP transport (including its proxy and OAuth refresh policy).
pub trait LiveSignalingClient {
	/// Typed signaling error.
	type Error: error::Error + Send + Sync + 'static;

	/// Posts one SDP offer.
	fn signal(
		&mut self,
		request: LiveSignalingRequest,
	) -> impl Future<Output = Result<LiveSignalingResponse, Self::Error>> + Send;
}

/// Sideband connection abstraction. Applications select either the direct
/// connector or the HTTP CONNECT-capable connector while preserving one
/// request and retry policy.
pub trait SidebandConnector {
	/// Connected websocket type.
	type Socket;
	/// Typed connection failure.
	type Error: error::Error + Send + Sync + 'static;

	/// Connects the authenticated sideband request through `proxy` when present.
	fn connect(
		&mut self,
		request: Request<()>,
		proxy: Option<&LiveProxy>,
	) -> impl Future<Output = Result<Self::Socket, Self::Error>> + Send;
}

/// Direct rustls sideband connector.
#[derive(Clone, Copy, Debug, Default)]
pub struct DirectSidebandConnector;

/// Direct connector failures.
#[derive(Debug, Error)]
pub enum DirectSidebandError {
	/// A proxy requires the application's proxy-capable network connector.
	#[error("a direct sideband connector cannot satisfy a proxy route")]
	ProxyRequired,
	/// Websocket connection failed.
	#[error("live sideband websocket failed")]
	WebSocket {
		/// Typed tungstenite source.
		#[source]
		source: tungstenite::Error,
	},
}

impl SidebandConnector for DirectSidebandConnector {
	type Error = DirectSidebandError;
	type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

	fn connect(
		&mut self,
		request: Request<()>,
		proxy: Option<&LiveProxy>,
	) -> impl Future<Output = Result<Self::Socket, Self::Error>> + Send {
		async move {
			if proxy.is_some() {
				return Err(DirectSidebandError::ProxyRequired);
			}
			connect_async(request)
				.await
				.map(|(socket, _)| socket)
				.map_err(|source| DirectSidebandError::WebSocket { source })
		}
	}
}

/// HTTP CONNECT-capable rustls sideband connector.
///
/// The application resolves proxy policy once and passes the selected route to
/// both signaling and this connector, so the authenticated sideband cannot
/// accidentally bypass the signaling proxy.
#[derive(Clone, Copy, Debug, Default)]
pub struct ProxySidebandConnector;

/// Network layer at which a live sideband connection failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SidebandFailureLayer {
	/// TCP connection or I/O.
	Tcp,
	/// TLS negotiation.
	Tls,
	/// HTTP CONNECT proxy policy or transport.
	Proxy,
	/// WebSocket framing or connection lifecycle.
	WebSocket,
	/// Invalid local connector configuration.
	Configuration,
}

/// Proxy-capable sideband connection failures.
#[derive(Debug, Error)]
pub enum ProxySidebandError {
	/// The configured proxy URL has no authority.
	#[error("the live sideband proxy URL has no host")]
	MissingProxyHost,
	/// Only an HTTP CONNECT proxy can carry the WebSocket TLS stream.
	#[error("the live sideband proxy must use the http scheme")]
	UnsupportedProxyScheme,
	/// Opening the TCP stream to the proxy failed.
	#[error("the live sideband proxy connection failed")]
	ProxyConnect {
		/// Typed socket source.
		#[source]
		source: io::Error,
	},
	/// The bounded HTTP CONNECT exchange failed.
	#[error("the live sideband proxy CONNECT exchange failed")]
	ProxyIo {
		/// Typed socket source.
		#[source]
		source: io::Error,
	},
	/// The proxy response exceeded the bounded header buffer.
	#[error("the live sideband proxy CONNECT response exceeded its header limit")]
	ProxyResponseTooLarge,
	/// The proxy declined the CONNECT request.
	#[error("the live sideband proxy rejected CONNECT with status {status:?}")]
	ProxyRejected {
		/// Parsed HTTP status when the response supplied one.
		status: Option<u16>,
	},
	/// WebSocket or TLS negotiation failed.
	#[error("live sideband websocket failed")]
	WebSocket {
		/// Typed tungstenite source.
		#[source]
		source: tungstenite::Error,
	},
}

impl ProxySidebandError {
	/// Returns the typed network layer that rejected the sideband connection.
	#[must_use]
	pub const fn layer(&self) -> SidebandFailureLayer {
		match self {
			Self::ProxyConnect { .. } | Self::ProxyIo { .. } | Self::ProxyRejected { .. } => {
				SidebandFailureLayer::Proxy
			},
			Self::WebSocket { source: tungstenite::Error::Io(_) } => SidebandFailureLayer::Tcp,
			Self::WebSocket { source: tungstenite::Error::Tls(_) } => SidebandFailureLayer::Tls,
			Self::WebSocket { .. } => SidebandFailureLayer::WebSocket,
			Self::MissingProxyHost | Self::UnsupportedProxyScheme | Self::ProxyResponseTooLarge => {
				SidebandFailureLayer::Configuration
			},
		}
	}
}

impl SidebandConnector for ProxySidebandConnector {
	type Error = ProxySidebandError;
	type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

	fn connect(
		&mut self,
		request: Request<()>,
		proxy: Option<&LiveProxy>,
	) -> impl Future<Output = Result<Self::Socket, Self::Error>> + Send {
		let proxy = proxy.cloned();
		async move {
			let Some(proxy) = proxy else {
				return connect_async(request)
					.await
					.map(|(socket, _)| socket)
					.map_err(|source| ProxySidebandError::WebSocket { source });
			};
			if proxy.endpoint().scheme() != "http" {
				return Err(ProxySidebandError::UnsupportedProxyScheme);
			}
			let proxy_host = proxy
				.endpoint()
				.host_str()
				.ok_or(ProxySidebandError::MissingProxyHost)?
				.to_owned();
			let proxy_port = proxy.endpoint().port().unwrap_or(80);
			let target_host = request
				.uri()
				.host()
				.ok_or(ProxySidebandError::MissingProxyHost)?
				.to_owned();
			let target_port = request.uri().port_u16().unwrap_or(443);
			let mut stream = TcpStream::connect((proxy_host.as_str(), proxy_port))
				.await
				.map_err(|source| ProxySidebandError::ProxyConnect { source })?;
			let authority = if target_host.contains(':') {
				format!("[{target_host}]:{target_port}")
			} else {
				format!("{target_host}:{target_port}")
			};
			let authorization =
				Zeroizing::new(proxy.authorization().map_or_else(String::new, |value| {
					let value = value
						.to_str()
						.expect("Basic proxy authorization is always visible ASCII");
					format!("Proxy-Authorization: {value}\r\n")
				}));
			let tunnel = Zeroizing::new(format!(
				"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n{}Proxy-Connection: \
				 Keep-Alive\r\n\r\n",
				authorization.as_str(),
			));
			stream
				.write_all(tunnel.as_bytes())
				.await
				.map_err(|source| ProxySidebandError::ProxyIo { source })?;
			let mut response = Vec::with_capacity(256);
			let mut byte = [0_u8; 1];
			while response.len() < PROXY_RESPONSE_LIMIT && !response.ends_with(b"\r\n\r\n") {
				stream
					.read_exact(&mut byte)
					.await
					.map_err(|source| ProxySidebandError::ProxyIo { source })?;
				response.push(byte[0]);
			}
			if !response.ends_with(b"\r\n\r\n") {
				return Err(ProxySidebandError::ProxyResponseTooLarge);
			}
			let status = response
				.split(|byte| *byte == b'\n')
				.next()
				.and_then(|line| std::str::from_utf8(line).ok())
				.and_then(|line| line.split_ascii_whitespace().nth(1))
				.and_then(|status| status.parse::<u16>().ok());
			if status != Some(200) {
				return Err(ProxySidebandError::ProxyRejected { status });
			}
			client_async_tls_with_config(request, stream, None, None)
				.await
				.map(|(socket, _)| socket)
				.map_err(|source| ProxySidebandError::WebSocket { source })
		}
	}
}

fn proxy_authorization(proxy: &Url) -> Result<Option<HeaderValue>, LiveProxyError> {
	if proxy.username().is_empty() && proxy.password().is_none() {
		return Ok(None);
	}
	let username =
		Zeroizing::new(percent_decode(proxy.username()).ok_or(LiveProxyError::InvalidCredentials)?);
	let password = Zeroizing::new(
		percent_decode(proxy.password().unwrap_or_default())
			.ok_or(LiveProxyError::InvalidCredentials)?,
	);
	let mut credentials = Zeroizing::new(Vec::with_capacity(username.len() + password.len() + 1));
	credentials.extend_from_slice(&username);
	credentials.push(b':');
	credentials.extend_from_slice(&password);
	let encoded = Zeroizing::new(base64::encode(&credentials).into_string());
	let authorization = Zeroizing::new(format!("Basic {}", encoded.as_str()));
	let mut value = HeaderValue::from_str(authorization.as_str())
		.map_err(|source| LiveProxyError::InvalidAuthorization { source })?;
	value.set_sensitive(true);
	Ok(Some(value))
}

fn percent_decode(value: &str) -> Option<Vec<u8>> {
	let bytes = value.as_bytes();
	let mut output = Vec::with_capacity(bytes.len());
	let mut index = 0;
	while index < bytes.len() {
		if bytes[index] != b'%' {
			output.push(bytes[index]);
			index += 1;
			continue;
		}
		let high = proxy_hex_digit(*bytes.get(index + 1)?)?;
		let low = proxy_hex_digit(*bytes.get(index + 2)?)?;
		output.push((high << 4) | low);
		index += 3;
	}
	Some(output)
}

const fn proxy_hex_digit(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'a'..=b'f' => Some(byte - b'a' + 10),
		b'A'..=b'F' => Some(byte - b'A' + 10),
		_ => None,
	}
}

/// Realtime transport establishment failures.
#[derive(Debug, Error)]
pub enum LiveTransportError<S, W>
where
	S: error::Error + Send + Sync + 'static,
	W: error::Error + Send + Sync + 'static,
{
	/// Native media initialization or SDP answer failed.
	#[error(transparent)]
	Media {
		/// Typed media error.
		#[from]
		source: VoiceError,
	},
	/// Signaling HTTP transport failed.
	#[error("Codex live signaling failed")]
	Signaling {
		/// Typed HTTP source.
		#[source]
		source: S,
	},
	/// Signaling response omitted a valid call ID.
	#[error("Codex live signaling returned no valid rtc call ID")]
	MissingCallId,
	/// Signaling request body could not be serialized.
	#[error("Codex live session payload could not be serialized")]
	Payload {
		/// Typed JSON source.
		#[source]
		source: serde_json::Error,
	},
	/// Sideband request headers were invalid.
	#[error("Codex live sideband request contains an invalid header")]
	Header,
	/// A sideband attempt did not settle within the connection deadline.
	#[error("Codex live sideband connection timed out")]
	SidebandTimeout,
	/// Every exponential-backoff sideband attempt failed.
	#[error("Codex live sideband connection failed after five attempts")]
	Sideband {
		/// Final typed websocket source.
		#[source]
		source: W,
	},
}

/// Established media and sideband channels. Dropping does not block; callers
/// must invoke [`Self::close`] for deterministic coordinator restoration.
pub struct EstablishedLiveTransport<W> {
	media:    Arc<LiveMediaSession>,
	sideband: W,
}

impl<W> EstablishedLiveTransport<W> {
	/// Borrows the coordinator-owned media session.
	pub const fn media(&self) -> &Arc<LiveMediaSession> {
		&self.media
	}

	/// Borrows the sideband socket/connector result.
	pub const fn sideband(&self) -> &W {
		&self.sideband
	}

	/// Mutably borrows the sideband socket.
	pub const fn sideband_mut(&mut self) -> &mut W {
		&mut self.sideband
	}

	/// Closes media and restores microphone/TTS ownership exactly once.
	pub async fn close(self) {
		self.media.close().await;
	}
}

/// Creates the WebRTC offer, signals it with OAuth/attestation headers, accepts
/// the answer, waits for the data channel, then opens the sideband with bounded
/// exponential backoff.
pub async fn establish_live_transport<S, C>(
	coordinator: &AudioCoordinator,
	callbacks: LiveCallbacks,
	options: &LiveTransportOptions,
	signaling: &mut S,
	connector: &mut C,
) -> Result<EstablishedLiveTransport<C::Socket>, LiveTransportError<S::Error, C::Error>>
where
	S: LiveSignalingClient,
	C: SidebandConnector,
{
	let (media, offer) = LiveMediaSession::start(coordinator, callbacks).await?;
	complete_live_transport(media, offer, options, signaling, connector).await
}

/// Completes authenticated signaling for an already-owned media session.
///
/// This split lets the application race network establishment against its
/// lifecycle mailbox and explicitly await media cleanup when cancellation wins.
pub async fn complete_live_transport<S, C>(
	media: Arc<LiveMediaSession>,
	offer: String,
	options: &LiveTransportOptions,
	signaling: &mut S,
	connector: &mut C,
) -> Result<EstablishedLiveTransport<C::Socket>, LiveTransportError<S::Error, C::Error>>
where
	S: LiveSignalingClient,
	C: SidebandConnector,
{
	let result = establish_after_media(&media, offer, options, signaling, connector).await;
	match result {
		Ok(sideband) => Ok(EstablishedLiveTransport { media, sideband }),
		Err(error) => {
			media.close().await;
			Err(error)
		},
	}
}

async fn establish_after_media<S, C>(
	media: &Arc<LiveMediaSession>,
	offer: String,
	options: &LiveTransportOptions,
	signaling: &mut S,
	connector: &mut C,
) -> Result<C::Socket, LiveTransportError<S::Error, C::Error>>
where
	S: LiveSignalingClient,
	C: SidebandConnector,
{
	let attestation = generate_codex_attestation().await;
	let request = signaling_request::<S::Error, C::Error>(options, &offer, attestation.as_deref())?;
	let response = signaling
		.signal(request)
		.await
		.map_err(|source| LiveTransportError::Signaling { source })?;
	let call_id =
		parse_live_call_id(response.location.as_str()).ok_or(LiveTransportError::MissingCallId)?;
	media
		.peer()
		.accept_answer(response.answer.to_string())
		.await?;
	let timeout_ms = options.open_timeout.as_millis().min(u128::from(u32::MAX)) as u32;
	media.peer().wait_for_open(timeout_ms).await?;
	let mut delay = Duration::from_millis(200);
	let mut last = None;
	let mut timed_out = false;
	for attempt in 0..SIDEBAND_ATTEMPTS {
		let request = sideband_request(options, &response.access, call_id, attestation.as_deref())?;
		match time::timeout(
			SIDEBAND_CONNECT_TIMEOUT,
			connector.connect(request, options.proxy.as_ref()),
		)
		.await
		{
			Ok(Ok(socket)) => return Ok(socket),
			Ok(Err(error)) => {
				last = Some(error);
				timed_out = false;
			},
			Err(_) => timed_out = true,
		}
		if attempt + 1 < SIDEBAND_ATTEMPTS {
			time::sleep(delay).await;
			delay = delay.saturating_mul(2);
		}
	}
	if timed_out {
		Err(LiveTransportError::SidebandTimeout)
	} else {
		Err(LiveTransportError::Sideband {
			source: last.expect("a non-timeout sideband attempt recorded its error"),
		})
	}
}

fn signaling_request<S, W>(
	options: &LiveTransportOptions,
	offer: &str,
	attestation: Option<&str>,
) -> Result<LiveSignalingRequest, LiveTransportError<S, W>>
where
	S: error::Error + Send + Sync + 'static,
	W: error::Error + Send + Sync + 'static,
{
	let body = serde_json::to_vec(&json!({
		"sdp": offer,
		"session": {
			"model": "gpt-live-1-codex",
			"instructions": options.instructions,
			"audio": { "output": { "voice": options.voice } },
			"delegation": { "type": "client" },
		},
	}))
	.map_err(|source| LiveTransportError::Payload { source })?;
	Ok(LiveSignalingRequest {
		url: SIGNALING_URL,
		headers: session_headers(options, None, attestation)
			.map_err(|()| LiveTransportError::Header)?,
		body,
		proxy: options.proxy.clone(),
	})
}

fn sideband_request<S, W>(
	options: &LiveTransportOptions,
	access: &LiveOAuthAccess,
	call_id: &str,
	attestation: Option<&str>,
) -> Result<Request<()>, LiveTransportError<S, W>>
where
	S: error::Error + Send + Sync + 'static,
	W: error::Error + Send + Sync + 'static,
{
	let url = format!("wss://api.openai.com/v1/live/{call_id}");
	let mut request = url
		.into_client_request()
		.map_err(|_| LiveTransportError::Header)?;
	for (name, value) in session_headers(options, Some(access), attestation)
		.map_err(|()| LiveTransportError::Header)?
	{
		let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| LiveTransportError::Header)?;
		request.headers_mut().insert(name, value);
	}
	Ok(request)
}

fn session_headers(
	options: &LiveTransportOptions,
	access: Option<&LiveOAuthAccess>,
	attestation: Option<&str>,
) -> Result<Vec<(Str, HeaderValue)>, ()> {
	let header = |value: &str| HeaderValue::from_str(value).map_err(|_| ());
	let mut headers = vec![
		(Str::new_static("accept"), HeaderValue::from_static("*/*")),
		(Str::new_static("content-type"), HeaderValue::from_static("application/json")),
		(Str::new_static("OpenAI-Alpha"), HeaderValue::from_static("quicksilver=v2")),
		(
			Str::new_static("user-agent"),
			header(&format!("Codex Desktop/{}", options.client_version))?,
		),
		(Str::new_static("x-session-id"), header(options.realtime_session.as_str())?),
		(Str::new_static("originator"), HeaderValue::from_static("Codex Desktop")),
		(Str::new_static("x-codex-version"), header(options.client_version.as_str())?),
		(Str::new_static("x-codex-session-id"), header(options.session_id.as_str())?),
		(Str::new_static("x-codex-thread-id"), header(options.session_id.as_str())?),
	];
	if let Some(access) = access {
		headers.push((Str::new_static("authorization"), access.authorization.clone()));
		if let Some(account) = access.account_id.as_ref() {
			headers.push((Str::new_static("ChatGPT-Account-Id"), header(account.as_str())?));
		}
	}
	if let Some(attestation) = attestation {
		headers.push((Str::new_static("x-oai-attestation"), header(attestation)?));
	}
	Ok(headers)
}

/// Extracts a validated server-assigned `rtc_*` call ID from Location.
pub fn parse_live_call_id(location: &str) -> Option<&str> {
	location
		.split_once('?')
		.map_or(location, |(path, _)| path)
		.split('/')
		.find(|segment| {
			segment.starts_with("rtc_")
				&& segment.len() > 4
				&& segment[4..]
					.bytes()
					.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
		})
}

/// Semantic stream selected for appended Codex live context.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LiveContextChannel {
	/// Text the realtime assistant may speak.
	Speakable,
	/// Silent implementation commentary.
	Commentary,
}

/// One text item in a Codex live context append.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LiveInputText {
	#[serde(rename = "type")]
	kind: &'static str,
	text: Str,
}

impl LiveInputText {
	const fn new(text: Str) -> Self {
		Self { kind: "input_text", text }
	}
}

/// Typed client-to-Codex sideband message.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "type")]
pub enum LiveClientMessage {
	/// Associate coding-agent context with a provider-created delegation.
	#[serde(rename = "delegation.context.append")]
	DelegationContextAppend {
		/// Provider delegation identity.
		delegation_item_id: Str,
		/// Semantic context stream.
		#[serde(skip_serializing_if = "Option::is_none")]
		channel:            Option<LiveContextChannel>,
		/// Ordered context content.
		content:            [LiveInputText; 1],
	},
	/// Append context outside an active delegation.
	#[serde(rename = "session.context.append")]
	SessionContextAppend {
		/// Semantic context stream.
		#[serde(skip_serializing_if = "Option::is_none")]
		channel: Option<LiveContextChannel>,
		/// Ordered context content.
		content: [LiveInputText; 1],
	},
	/// Gracefully close the live session.
	#[serde(rename = "session.close")]
	SessionClose,
}

impl LiveClientMessage {
	/// Builds one delegation-bound context append.
	pub const fn delegation_context(
		delegation_item_id: Str,
		text: Str,
		channel: Option<LiveContextChannel>,
	) -> Self {
		Self::DelegationContextAppend {
			delegation_item_id,
			channel,
			content: [LiveInputText::new(text)],
		}
	}

	/// Builds one session-level context append.
	pub const fn session_context(text: Str, channel: Option<LiveContextChannel>) -> Self {
		Self::SessionContextAppend { channel, content: [LiveInputText::new(text)] }
	}
}

/// Speaker on a completed Codex live turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveTurnRole {
	/// Caller audio.
	User,
	/// Realtime assistant output.
	Assistant,
}

/// Parsed Codex live server event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveServerEvent {
	/// The authenticated live session started.
	SessionStarted {
		/// Provider session identity.
		id:           Str,
		/// Effective provider instructions when returned.
		instructions: Option<Str>,
	},
	/// The authenticated live session changed.
	SessionUpdated {
		/// Provider session identity.
		id:           Str,
		/// Effective provider instructions when returned.
		instructions: Option<Str>,
	},
	/// Encoded output-audio delta mirrored on the event channel.
	OutputAudioDelta(Str),
	/// Incremental caller transcript.
	InputTranscriptAdded(Str),
	/// Incremental assistant transcript.
	OutputTranscriptAdded(Str),
	/// Final transcript for one conversational turn.
	TurnDone {
		/// Turn speaker.
		role:       LiveTurnRole,
		/// Complete turn transcript.
		transcript: Str,
	},
	/// Coding work delegated to the client agent.
	DelegationCreated {
		/// Provider delegation identity.
		id:      Str,
		/// Concatenated provider-authored request text.
		request: Str,
	},
	/// Classified provider error text.
	Error(Str),
	/// Well-formed event not yet consumed by OMP.
	Unknown(Str),
}

/// Parses one Frameless Bidi JSON event. Malformed or shape-invalid frames are
/// rejected rather than projected as successful activity.
pub fn parse_live_server_event(payload: &str) -> Option<LiveServerEvent> {
	let value: Value = serde_json::from_str(payload).ok()?;
	let object = value.as_object()?;
	let kind = object.get("type")?.as_str()?;
	match kind {
		"session.started" | "session.updated" => {
			let session = object.get("session")?.as_object()?;
			let id = Str::from(session.get("id")?.as_str()?);
			let instructions = session
				.get("instructions")
				.and_then(Value::as_str)
				.map(Str::from);
			if kind == "session.started" {
				Some(LiveServerEvent::SessionStarted { id, instructions })
			} else {
				Some(LiveServerEvent::SessionUpdated { id, instructions })
			}
		},
		"output_audio.delta" => object
			.get("audio")
			.and_then(Value::as_str)
			.map(Str::from)
			.map(LiveServerEvent::OutputAudioDelta),
		"input_transcript.added" | "output_transcript.added" => {
			let text = object
				.get("item")
				.and_then(Value::as_object)?
				.get("text")
				.and_then(Value::as_str)
				.map(Str::from)?;
			if kind == "input_transcript.added" {
				Some(LiveServerEvent::InputTranscriptAdded(text))
			} else {
				Some(LiveServerEvent::OutputTranscriptAdded(text))
			}
		},
		"turn.done" => {
			let turn = object.get("turn")?.as_object()?;
			let role = match turn.get("role")?.as_str()? {
				"user" => LiveTurnRole::User,
				"assistant" => LiveTurnRole::Assistant,
				_ => return None,
			};
			let transcript = Str::from(turn.get("transcript")?.as_str()?);
			Some(LiveServerEvent::TurnDone { role, transcript })
		},
		"delegation.created" => {
			let item = object.get("item")?.as_object()?;
			if item.get("type")?.as_str()? != "delegation" || item.get("target")?.as_str()? != "client"
			{
				return None;
			}
			let id = Str::from(item.get("id")?.as_str()?);
			let mut request = String::new();
			for content in item.get("content")?.as_array()? {
				let Some(content) = content.as_object() else {
					continue;
				};
				if content.get("type").and_then(Value::as_str) == Some("input_text")
					&& let Some(text) = content.get("text").and_then(Value::as_str)
				{
					if !request.is_empty() {
						request.push('\n');
					}
					request.push_str(text);
				}
			}
			Some(LiveServerEvent::DelegationCreated { id, request: Str::from(request) })
		},
		"error" => {
			let message = object.get("message").and_then(Value::as_str).or_else(|| {
				object
					.get("error")
					.and_then(Value::as_object)
					.and_then(|error| error.get("message"))
					.and_then(Value::as_str)
			})?;
			Some(LiveServerEvent::Error(Str::from(message)))
		},
		_ => Some(LiveServerEvent::Unknown(Str::from(kind))),
	}
}

/// One admitted request from the realtime peer to the normal agent kernel.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveDelegationRequest {
	/// Stable provider-issued delegation identity.
	pub id:      Str,
	/// Trimmed request handed to the controller as an ordinary agent turn.
	pub request: Str,
}

/// Controller action required after admitting a provider delegation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveDelegationAdmission {
	/// The event was empty or repeated and must not create another journal turn.
	Ignored,
	/// No delegated turn is running, so this request may start immediately.
	Start(LiveDelegationRequest),
	/// Another delegated turn is running. Interrupt it; the bridge retains this
	/// request until the controller reports the old turn settled.
	Interrupt {
		/// Delegation whose kernel turn must be cancelled.
		active_id: Str,
	},
	/// The current turn is already stopping and this request is retained in
	/// provider order behind it.
	Queued,
}

/// Terminal result of the active delegated kernel turn.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveDelegationTerminal {
	/// The kernel produced its final assistant answer.
	Completed,
	/// Turn interruption settled through the kernel cancellation tree.
	Cancelled,
	/// The kernel stopped on a journaled failure.
	Failed,
}

/// Ordered transport output and optional next turn after settlement.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveDelegationSettlement {
	/// Context frames that must be sent in order before starting `next`.
	pub outbound: Vec<LiveClientMessage>,
	/// Next provider request retained during interruption, if any.
	pub next:     Option<LiveDelegationRequest>,
}

/// Exactly-once turn-taking state between Frameless Bidi and the normal agent
/// controller.
///
/// This state owns no session authority. It admits each provider delegation
/// identity once, associates kernel events with only the active identity, and
/// promotes queued speech turns only after the previous kernel turn settles.
#[derive(Debug)]
pub struct LiveDelegationBridge {
	active:  Option<LiveDelegationRequest>,
	pending: VecDeque<LiveDelegationRequest>,
	seen:    FastHashSet<Str>,
}

impl Default for LiveDelegationBridge {
	fn default() -> Self {
		Self {
			active:  None,
			pending: VecDeque::new(),
			seen:    FastHashSet::with_capacity_and_hasher(16, FastState::default()),
		}
	}
}

impl LiveDelegationBridge {
	/// Admits one non-empty provider delegation exactly once.
	///
	/// A request arriving during delegated work is retained in provider order.
	/// Only the first such request asks the controller to interrupt; later
	/// requests wait behind it and cannot be merged into the active journal
	/// turn.
	#[must_use]
	pub fn admit(&mut self, id: Str, request: Str) -> LiveDelegationAdmission {
		let id = id.trim();
		let request = request.trim();
		if id.is_empty() || request.is_empty() || self.seen.contains(&id) {
			return LiveDelegationAdmission::Ignored;
		}
		let request = LiveDelegationRequest { id, request };
		self.seen.insert(request.id.clone());
		let Some(active) = self.active.as_ref() else {
			self.active = Some(request.clone());
			return LiveDelegationAdmission::Start(request);
		};
		let active_id = active.id.clone();
		let interrupt = self.pending.is_empty();
		self.pending.push_back(request);
		if interrupt {
			LiveDelegationAdmission::Interrupt { active_id }
		} else {
			LiveDelegationAdmission::Queued
		}
	}

	/// Builds ordered silent progress frames for the active delegation.
	///
	/// Late deltas from an interrupted or already-settled turn are ignored, so
	/// they cannot be attributed to the next realtime speech turn.
	#[must_use]
	pub fn progress(&self, id: &str, text: &str) -> Vec<LiveClientMessage> {
		let Some(active) = self.active.as_ref().filter(|active| active.id == id) else {
			return Vec::new();
		};
		if text.is_empty() {
			return Vec::new();
		}
		chunk_live_context(text)
			.map(|chunk| {
				LiveClientMessage::delegation_context(
					active.id.clone(),
					Str::from(chunk),
					Some(LiveContextChannel::Commentary),
				)
			})
			.collect()
	}

	/// Settles the active delegated turn exactly once and promotes the next
	/// retained request.
	///
	/// A completed answer and terminal cancellation/failure status are returned
	/// as speakable context before turn ownership is released. Failure text
	/// must already be classified by the application boundary.
	pub fn settle(
		&mut self,
		id: &str,
		terminal: LiveDelegationTerminal,
		final_text: &str,
	) -> Option<LiveDelegationSettlement> {
		let active = self.active.as_ref().filter(|active| active.id == id)?;
		let text = final_text.trim();
		let (wrapped, channel) = match terminal {
			LiveDelegationTerminal::Completed if text.is_empty() => (None, None),
			LiveDelegationTerminal::Completed => {
				let mut wrapped = String::with_capacity(AGENT_FINAL_MESSAGE_HEADER.len() + text.len());
				wrapped.push_str(AGENT_FINAL_MESSAGE_HEADER);
				wrapped.push_str(text);
				(Some(Str::new(wrapped)), None)
			},
			LiveDelegationTerminal::Cancelled => {
				(Some(Str::new_static(AGENT_CANCELLED_MESSAGE)), Some(LiveContextChannel::Speakable))
			},
			LiveDelegationTerminal::Failed if text.is_empty() => {
				(Some(Str::new_static(AGENT_FAILED_MESSAGE)), Some(LiveContextChannel::Speakable))
			},
			LiveDelegationTerminal::Failed => {
				let mut wrapped = String::with_capacity(AGENT_FAILED_MESSAGE_HEADER.len() + text.len());
				wrapped.push_str(AGENT_FAILED_MESSAGE_HEADER);
				wrapped.push_str(text);
				(Some(Str::new(wrapped)), Some(LiveContextChannel::Speakable))
			},
		};
		let outbound = wrapped.map_or_else(Vec::new, |wrapped| {
			chunk_live_context(wrapped.as_str())
				.map(|chunk| {
					LiveClientMessage::delegation_context(active.id.clone(), Str::from(chunk), channel)
				})
				.collect()
		});
		self.active = self.pending.pop_front();
		Some(LiveDelegationSettlement { outbound, next: self.active.clone() })
	}

	/// Cancels and forgets every active or queued delegation during live
	/// transport teardown.
	///
	/// The returned active identity is the only one that may own a running
	/// kernel turn; pending requests have never entered the journal.
	pub fn cancel_all(&mut self) -> Option<Str> {
		self.pending.clear();
		self.active.take().map(|active| active.id)
	}

	/// Returns the delegation currently associated with kernel events.
	#[must_use]
	pub fn active_id(&self) -> Option<&str> {
		self.active.as_ref().map(|active| active.id.as_str())
	}
}

/// Splits context into UTF-8-safe chunks no larger than 500 bytes.
pub fn chunk_live_context(text: &str) -> impl Iterator<Item = &str> {
	ContextChunks { remaining: text }
}

struct ContextChunks<'a> {
	remaining: &'a str,
}

impl<'a> Iterator for ContextChunks<'a> {
	type Item = &'a str;

	fn next(&mut self) -> Option<Self::Item> {
		if self.remaining.is_empty() {
			return None;
		}
		let mut end = self.remaining.len().min(CONTEXT_CHUNK_BYTES);
		while !self.remaining.is_char_boundary(end) {
			end -= 1;
		}
		let (chunk, remaining) = self.remaining.split_at(end);
		self.remaining = remaining;
		Some(chunk)
	}
}

/// Bounded cross-channel event-ID deduplicator for data-channel and sideband
/// deliveries. Events without IDs remain deliverable.
#[derive(Debug)]
pub struct EventDeduplicator {
	seen:  FastHashSet<Str>,
	order: VecDeque<Str>,
}

impl Default for EventDeduplicator {
	fn default() -> Self {
		Self {
			seen:  FastHashSet::with_capacity_and_hasher(DEDUP_WINDOW, FastState::default()),
			order: VecDeque::new(),
		}
	}
}

impl EventDeduplicator {
	/// Returns `true` exactly once for each event ID in the bounded window.
	pub fn admit(&mut self, payload: &str) -> bool {
		let Some(id) = event_id(payload) else {
			return true;
		};
		if !self.seen.insert(id.clone()) {
			return false;
		}
		self.order.push_back(id);
		if self.order.len() > DEDUP_WINDOW
			&& let Some(expired) = self.order.pop_front()
		{
			self.seen.remove(&expired);
		}
		true
	}
}

fn event_id(payload: &str) -> Option<Str> {
	let value: Value = serde_json::from_str(payload).ok()?;
	value
		.get("event_id")
		.or_else(|| value.get("id"))
		.and_then(Value::as_str)
		.filter(|id| !id.is_empty())
		.map(Str::from)
}

/// Sends one JSON event over a connected sideband socket.
pub async fn send_sideband(
	socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
	value: &impl Serialize,
) -> Result<(), tungstenite::Error> {
	let payload = serde_json::to_string(value)
		.map_err(|error| tungstenite::Error::Io(io::Error::new(io::ErrorKind::InvalidData, error)))?;
	socket.send(Message::Text(payload.into())).await
}

/// Receives the next text sideband event and services WebSocket control frames.
pub async fn receive_sideband(
	socket: &mut WebSocketStream<MaybeTlsStream<TcpStream>>,
) -> Result<Option<Str>, tungstenite::Error> {
	while let Some(message) = socket.next().await {
		match message? {
			Message::Text(text) => return Ok(Some(Str::from(text.as_str()))),
			Message::Ping(payload) => socket.send(Message::Pong(payload)).await?,
			Message::Pong(_) | Message::Frame(_) => {},
			Message::Close(_) => return Ok(None),
			Message::Binary(_) => {
				return Err(tungstenite::Error::Io(io::Error::new(
					io::ErrorKind::InvalidData,
					"Codex live sideband returned an unexpected binary frame",
				)));
			},
		}
	}
	Ok(None)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn live_proxy_sanitizes_and_redacts_url_credentials() {
		let proxy = LiveProxy::from_url(
			Url::parse("http://user%40example:p%3Ass@proxy.example:8080/tunnel?token=also-secret")
				.expect("proxy URL"),
		)
		.expect("sanitized live proxy");
		assert_eq!(proxy.endpoint().as_str(), "http://proxy.example:8080/");
		assert_eq!(
			proxy
				.authorization()
				.expect("proxy authorization")
				.to_str()
				.expect("ASCII authorization"),
			"Basic dXNlckBleGFtcGxlOnA6c3M="
		);
		let debug = format!("{proxy:?}");
		assert!(!debug.contains("user"));
		assert!(!debug.contains("p%3Ass"));
		assert!(!debug.contains("also-secret"));
		assert!(debug.contains("authenticated: true"));
		let authorization_debug = format!("{:?}", proxy.authorization());
		assert!(!authorization_debug.contains("dXNlckBleGFtcGxlOnA6c3M="));
	}

	#[test]
	fn sideband_errors_retain_the_failed_network_layer() {
		let tcp = ProxySidebandError::WebSocket {
			source: tungstenite::Error::Io(io::Error::new(
				io::ErrorKind::ConnectionRefused,
				"closed test endpoint",
			)),
		};
		assert_eq!(tcp.layer(), SidebandFailureLayer::Tcp);
		assert_eq!(
			ProxySidebandError::ProxyRejected { status: Some(407) }.layer(),
			SidebandFailureLayer::Proxy
		);
		assert_eq!(ProxySidebandError::MissingProxyHost.layer(), SidebandFailureLayer::Configuration);
	}

	#[test]
	fn signaling_request_keeps_the_sanitized_proxy_route() {
		let mut options = LiveTransportOptions::new(
			Str::new_static("session"),
			Str::new_static("instructions"),
			Str::new_static("voice"),
			Str::new_static("version"),
		);
		options.proxy = Some(
			LiveProxy::from_url(
				Url::parse("http://employee:secret@proxy.example:8080").expect("proxy URL"),
			)
			.expect("sanitized proxy"),
		);
		let request = signaling_request::<io::Error, io::Error>(&options, "offer", None)
			.expect("signaling request");
		assert_eq!(request.proxy, options.proxy);
		let debug = format!("{request:?}");
		assert!(!debug.contains("employee"));
		assert!(!debug.contains("secret"));
	}

	#[test]
	fn delegation_identity_is_never_admitted_twice() {
		let mut bridge = LiveDelegationBridge::default();
		assert!(matches!(
			bridge.admit(Str::new_static("call-1"), Str::new_static("inspect the repository")),
			LiveDelegationAdmission::Start(_)
		));
		assert_eq!(
			bridge.admit(Str::new_static("call-1"), Str::new_static("inspect the repository")),
			LiveDelegationAdmission::Ignored
		);
	}

	#[test]
	fn malformed_proxy_credentials_are_rejected() {
		let proxy = Url::parse("http://bad%ZZ:secret@proxy.example:8080").expect("proxy URL");
		assert!(matches!(LiveProxy::from_url(proxy), Err(LiveProxyError::InvalidCredentials)));
	}
}
