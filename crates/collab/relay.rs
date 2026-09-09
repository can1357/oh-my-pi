//! Ordered WebSocket relay transport, handshake state, and reconnect policy.

use std::{collections::VecDeque, time::Duration};

use bytes::Bytes;
use futures::{SinkExt as _, StreamExt as _};
use omp_proto::collab::v1::{CollabFrame, Hello, PeerJoined, PeerLeft, Welcome, collab_frame};
use rand::RngExt as _;
use serde::Deserialize;
use strum::IntoStaticStr;
use thiserror::Error;
use tokio::net::TcpStream;
use tokio_tungstenite::{
	MaybeTlsStream, WebSocketStream, connect_async_with_config,
	tungstenite::{
		self, Message,
		protocol::{CloseFrame, WebSocketConfig},
	},
};
use url::Url;

use crate::{
	PROTOCOL_REVISION,
	codec::{CodecError, RelayRoute, RoutedFrame, decode_envelope, encode_envelope},
	crypto::RoomKey,
};

/// Socket buffered-byte watermark that starts application queueing.
pub const BACKPRESSURE_HIGH_WATERMARK: usize = 64 * 1024;
/// Socket buffered-byte watermark below which queued frames may drain.
pub const BACKPRESSURE_LOW_WATERMARK: usize = 32 * 1024;
/// Maximum frames retained across reconnects or backpressure.
pub const MAX_PENDING_SENDS: usize = 256;
/// Initial reconnect backoff.
pub const RECONNECT_MIN: Duration = Duration::from_secs(1);
/// Maximum reconnect backoff.
pub const RECONNECT_MAX: Duration = Duration::from_secs(30);

/// Relay connection role included in the WebSocket handshake query.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum RelayRole {
	/// Single authoritative room host.
	Host,
	/// A read-only or writable room guest.
	Guest,
}

/// Handshake progress for one relay peer.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HandshakeState {
	/// Host is waiting for a guest hello.
	AwaitingHello,
	/// Guest is waiting for the host welcome.
	AwaitingWelcome,
	/// The protocol revision has been accepted.
	Established,
}

/// Revision-strict host/guest handshake state machine.
#[derive(Clone, Copy, Debug)]
pub struct Handshake {
	role:  RelayRole,
	state: HandshakeState,
}

impl Handshake {
	/// Starts a role-appropriate handshake.
	pub const fn new(role: RelayRole) -> Self {
		let state = match role {
			RelayRole::Host => HandshakeState::AwaitingHello,
			RelayRole::Guest => HandshakeState::AwaitingWelcome,
		};
		Self { role, state }
	}

	/// Returns current handshake progress.
	pub const fn state(&self) -> HandshakeState {
		self.state
	}

	/// Accepts the expected peer handshake frame and refuses all revisions but
	/// revision 3.
	pub fn accept(&mut self, frame: &CollabFrame) -> Result<(), RelayError> {
		if frame.protocol_revision != PROTOCOL_REVISION {
			return Err(RelayError::ProtocolRevision {
				actual:    frame.protocol_revision,
				supported: PROTOCOL_REVISION,
			});
		}
		let accepted_revision = match (&self.role, &frame.payload) {
			(RelayRole::Host, Some(collab_frame::Payload::Hello(hello))) => hello.protocol_revision,
			(RelayRole::Guest, Some(collab_frame::Payload::Welcome(welcome))) => {
				welcome.protocol_revision
			},
			_ => return Err(RelayError::UnexpectedHandshake),
		};
		if accepted_revision != PROTOCOL_REVISION {
			return Err(RelayError::ProtocolRevision {
				actual:    accepted_revision,
				supported: PROTOCOL_REVISION,
			});
		}
		self.state = HandshakeState::Established;
		tracing::info!(role = ?self.role, "collaboration session joined");
		Ok(())
	}

	/// Constructs a guest hello frame.
	pub fn hello(sequence: u64, hello: Hello) -> CollabFrame {
		CollabFrame {
			protocol_revision: PROTOCOL_REVISION,
			sequence,
			payload: Some(collab_frame::Payload::Hello(hello)),
			..Default::default()
		}
	}

	/// Constructs a host welcome frame.
	pub fn welcome(sequence: u64, welcome: Welcome) -> CollabFrame {
		CollabFrame {
			protocol_revision: PROTOCOL_REVISION,
			sequence,
			payload: Some(collab_frame::Payload::Welcome(welcome)),
			..Default::default()
		}
	}
}

/// Outcome of accepting an outbound frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SendDisposition {
	/// Written to the open socket.
	Sent,
	/// Retained in sequence order for reconnect/drain.
	Queued,
	/// Refused because the bounded reconnect queue already had 256 frames.
	DroppedQueueFull,
}

/// Bounded FIFO used during disconnect and socket backpressure.
#[derive(Debug, Default)]
pub struct ReconnectQueue {
	frames: VecDeque<Bytes>,
	bytes:  usize,
}

impl ReconnectQueue {
	/// Enqueues one encoded envelope without evicting an older frame.
	pub fn push(&mut self, frame: impl Into<Bytes>) -> SendDisposition {
		if self.frames.len() >= MAX_PENDING_SENDS {
			return SendDisposition::DroppedQueueFull;
		}
		let frame = frame.into();

		self.bytes = self.bytes.saturating_add(frame.len());
		self.frames.push_back(frame);
		SendDisposition::Queued
	}

	/// Removes the oldest queued envelope.
	pub fn pop(&mut self) -> Option<Bytes> {
		let frame = self.frames.pop_front()?;
		self.bytes -= frame.len();
		Some(frame)
	}

	/// Returns queued frame count.
	pub fn len(&self) -> usize {
		self.frames.len()
	}

	/// Returns whether no frames are queued.
	pub fn is_empty(&self) -> bool {
		self.frames.is_empty()
	}

	/// Returns total encoded bytes retained.
	pub const fn bytes(&self) -> usize {
		self.bytes
	}
}

/// Exponential 1–30 second reconnect schedule with 0.75–1.25 jitter.
#[derive(Clone, Copy, Debug, Default)]
pub struct ReconnectBackoff {
	attempt: u32,
}

impl ReconnectBackoff {
	/// Resets the schedule after a successful connection.
	pub const fn reset(&mut self) {
		self.attempt = 0;
	}

	/// Returns the next jittered reconnect delay and advances the attempt.
	pub fn next_delay(&mut self) -> Duration {
		let exponent = self.attempt.min(5);
		self.attempt = self.attempt.saturating_add(1);
		let base_ms = 1000_u64.saturating_mul(1_u64 << exponent).min(30_000);
		let jitter = rand::rng().random_range(750_u64..=1250);
		Duration::from_millis(base_ms.saturating_mul(jitter) / 1000)
	}
}

/// Typed inbound relay item.
#[derive(Debug)]
pub enum RelayInbound {
	/// Authenticated peer frame with clear route metadata.
	Frame(RoutedFrame),
	/// Relay notification that one peer connected.
	PeerJoined(PeerJoined),
	/// Relay notification that one peer disconnected.
	PeerLeft(PeerLeft),
}

/// Ordered native OMP WebSocket client.
///
/// All mutating methods require `&mut self`; sealing/sending and
/// receiving/opening therefore form one ordered chain without per-frame task or
/// future allocation.
pub struct RelayClient {
	url:              Url,
	role:             RelayRole,
	key:              RoomKey,
	socket:           Option<WebSocketStream<MaybeTlsStream<TcpStream>>>,
	backoff:          ReconnectBackoff,
	terminal:         bool,
	inbound_revision: u64,
}

impl RelayClient {
	/// Creates a disconnected client for a query-free ws/wss room URL.
	pub fn new(url: Url, role: RelayRole, key: RoomKey) -> Result<Self, RelayError> {
		if !matches!(url.scheme(), "ws" | "wss") || url.query().is_some() || url.fragment().is_some()
		{
			return Err(RelayError::InvalidEndpoint);
		}
		Ok(Self {
			url,
			role,
			key,
			socket: None,
			backoff: ReconnectBackoff::default(),
			terminal: false,
			inbound_revision: 0,
		})
	}

	/// Connects with explicit role and protocol revision query metadata.
	#[tracing::instrument(
		level = "debug",
		name = "collaboration_join",
		skip_all,
		fields(role = ?self.role)
	)]
	pub async fn connect(&mut self) -> Result<(), RelayError> {
		if self.terminal {
			return Err(RelayError::Terminal);
		}
		let mut request_url = self.url.clone();
		let role: &'static str = self.role.into();
		request_url
			.query_pairs_mut()
			.append_pair("role", role)
			.append_pair("revision", "3");
		let mut socket_config = WebSocketConfig::default();
		socket_config.write_buffer_size = BACKPRESSURE_LOW_WATERMARK;
		socket_config.max_write_buffer_size = BACKPRESSURE_HIGH_WATERMARK;

		let (socket, _) = connect_async_with_config(request_url.as_str(), Some(socket_config), false)
			.await
			.map_err(RelayError::Socket)?;
		self.socket = Some(socket);
		self.backoff.reset();
		tracing::info!(role = ?self.role, "collaboration relay connected");
		Ok(())
	}

	/// Seals and sends in caller order.
	///
	/// A disconnected or ambiguous send is never retained. This prevents a
	/// mutation from executing after its caller has observed a retryable
	/// refusal.
	pub async fn send(
		&mut self,
		route: RelayRoute,
		frame: &CollabFrame,
	) -> Result<SendDisposition, RelayError> {
		if self.terminal {
			return Err(RelayError::Terminal);
		}
		let encoded: Bytes = encode_envelope(&self.key, route, frame)?.into();
		let Some(socket) = self.socket.as_mut() else {
			return Ok(SendDisposition::Queued);
		};
		match socket.send(Message::Binary(encoded)).await {
			Ok(()) => Ok(SendDisposition::Sent),
			Err(error) => {
				tracing::warn!(%error, "collaboration relay send failed; reconnect required");
				self.socket = None;
				Ok(SendDisposition::Queued)
			},
		}
	}

	/// Receives the next authenticated peer frame or typed peer-left control.
	pub async fn receive(&mut self) -> Result<Option<RelayInbound>, RelayError> {
		loop {
			let Some(socket) = self.socket.as_mut() else {
				return Ok(None);
			};
			let Some(message) = socket.next().await else {
				self.socket = None;
				return Ok(None);
			};
			let message = match message {
				Ok(message) => message,
				Err(error) => {
					tracing::warn!(%error, "collaboration relay receive failed; reconnect required");
					self.socket = None;
					return Ok(None);
				},
			};
			match message {
				Message::Binary(bytes) => match decode_envelope(&self.key, &bytes) {
					Ok(mut frame) => {
						self.normalize_inbound_revisions(&mut frame);
						return Ok(Some(RelayInbound::Frame(frame)));
					},
					Err(error @ CodecError::Crypto(_)) => {
						tracing::warn!(
							%error,
							"collaboration relay authentication failed; connection closed"
						);
						self.fail_terminal();
						return Err(RelayError::Authentication(error));
					},
					Err(error) => return Err(RelayError::Codec(error)),
				},
				Message::Text(text) => {
					let control: TextControl =
						serde_json::from_str(text.as_ref()).map_err(RelayError::Control)?;
					return Ok(Some(match control {
						TextControl::PeerJoined { peer_id } => {
							RelayInbound::PeerJoined(PeerJoined { peer_id })
						},
						TextControl::PeerLeft { peer_id } => RelayInbound::PeerLeft(PeerLeft { peer_id }),
						TextControl::RoomClosed => {
							tracing::warn!(
								close_code = 4001_u16,
								reason = "room closed",
								"collaboration relay closed terminally"
							);
							self.fail_terminal();
							return Err(RelayError::FatalClose { code: 4001, reason: "room closed" });
						},
					}));
				},
				Message::Close(frame) => {
					self.socket = None;
					if let Some(frame) = frame
						&& let Some(reason) = fatal_close(&frame)
					{
						tracing::warn!(
							close_code = u16::from(frame.code),
							reason,
							"collaboration relay closed terminally"
						);
						self.fail_terminal();
						return Err(RelayError::FatalClose { code: u16::from(frame.code), reason });
					}
					return Ok(None);
				},
				Message::Ping(payload) => {
					if let Err(error) = socket.send(Message::Pong(payload)).await {
						tracing::warn!(
							%error,
							"collaboration relay heartbeat failed; reconnect required"
						);
						self.socket = None;
						return Ok(None);
					}
				},
				Message::Pong(_) | Message::Frame(_) => {},
			}
		}
	}

	/// Returns the next reconnect delay after a transient disconnect.
	pub fn reconnect_delay(&mut self) -> Result<Duration, RelayError> {
		if self.terminal {
			Err(RelayError::Terminal)
		} else {
			let delay = self.backoff.next_delay();
			tracing::warn!(
				delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
				"collaboration relay reconnect scheduled"
			);
			Ok(delay)
		}
	}

	/// Intentionally closes the socket and permanently suppresses reconnect.
	pub async fn close(&mut self) -> Result<(), RelayError> {
		self.terminal = true;
		if let Some(mut socket) = self.socket.take() {
			socket.close(None).await.map_err(RelayError::Socket)?;
		}
		tracing::info!(role = ?self.role, "collaboration relay closed");
		Ok(())
	}

	fn fail_terminal(&mut self) {
		self.terminal = true;
		self.socket = None;
	}

	fn normalize_inbound_revisions(&mut self, routed: &mut RoutedFrame) {
		match routed.frame.payload.as_mut() {
			Some(collab_frame::Payload::Welcome(_)) => self.inbound_revision = 0,
			Some(collab_frame::Payload::SnapshotChunk(chunk)) => {
				for record in &mut chunk.entries {
					self.inbound_revision = self.inbound_revision.saturating_add(1);
					record.revision = self.inbound_revision;
				}
				if chunk.r#final {
					chunk.host_revision_watermark = self.inbound_revision;
				}
			},
			Some(collab_frame::Payload::JournalRecord(record)) => {
				self.inbound_revision = self.inbound_revision.saturating_add(1);
				record.revision = self.inbound_revision;
			},
			_ => {},
		}
	}
}

#[derive(Deserialize)]
#[serde(tag = "t")]
enum TextControl {
	#[serde(rename = "peer-joined")]
	PeerJoined {
		#[serde(rename = "peer")]
		peer_id: u32,
	},
	#[serde(rename = "peer-left")]
	PeerLeft {
		#[serde(rename = "peer")]
		peer_id: u32,
	},
	#[serde(rename = "room-closed")]
	RoomClosed,
}
fn fatal_close(frame: &CloseFrame) -> Option<&'static str> {
	match u16::from(frame.code) {
		4001 => Some("room closed"),
		4004 => Some("no such room"),
		4009 => Some("host conflict"),
		4029 => Some("room is full"),
		_ => None,
	}
}

/// Relay transport, handshake, or terminal authentication failure.
#[derive(Debug, Error)]
pub enum RelayError {
	/// Endpoint is not a query-free ws/wss room URL.
	#[error("collaboration relay endpoint must be a query-free ws or wss URL")]
	InvalidEndpoint,
	/// WebSocket operation failed.
	#[error("collaboration relay WebSocket operation failed")]
	Socket(#[source] tungstenite::Error),
	/// JSON framing, bounds validation, or encryption failed.
	#[error("collaboration relay codec failed")]
	Codec(#[from] CodecError),
	/// AEAD authentication failure permanently closed the relay client.
	#[error("collaboration relay authentication failed terminally")]
	Authentication(#[source] CodecError),
	/// Relay plaintext control frame was malformed.
	#[error("collaboration relay control frame was malformed")]
	Control(#[source] serde_json::Error),
	/// A fatal relay close code permanently closed the client.
	#[error("collaboration relay closed terminally with code {code}: {reason}")]
	FatalClose {
		/// WebSocket close code.
		code:   u16,
		/// Stable close classification.
		reason: &'static str,
	},
	/// A terminal client cannot reconnect or send.
	#[error("collaboration relay client is terminally closed")]
	Terminal,
	/// Handshake frame did not match this endpoint's role.
	#[error("unexpected collaboration handshake frame")]
	UnexpectedHandshake,
	/// Handshake protocol revision was unsupported.
	#[error("collaboration protocol revision {actual} is unsupported; expected {supported}")]
	ProtocolRevision {
		/// Received revision.
		actual:    u32,
		/// Sole supported revision.
		supported: u32,
	},
}

#[cfg(test)]
mod tests {
	use omp_proto::collab::v1::{RelayControl, relay_control};
	use prost::Message as _;

	use super::*;

	#[test]
	fn reconnect_queue_preserves_first_256_frames() {
		let mut queue = ReconnectQueue::default();
		for value in 0..MAX_PENDING_SENDS {
			assert_eq!(queue.push(vec![value as u8]), SendDisposition::Queued);
		}
		assert_eq!(queue.push(vec![255, 0]), SendDisposition::DroppedQueueFull);
		assert_eq!(queue.len(), MAX_PENDING_SENDS);
		for value in 0..MAX_PENDING_SENDS {
			assert_eq!(queue.pop(), Some(Bytes::from(vec![value as u8])));
		}
		assert!(queue.is_empty());
	}
	#[tokio::test]
	async fn disconnected_application_frame_is_never_replayed() {
		let (key, _) = RoomKey::generate().expect("key");
		let mut client =
			RelayClient::new(Url::parse("ws://localhost/r/test").expect("url"), RelayRole::Guest, key)
				.expect("client");
		let frame =
			Handshake::hello(1, Hello { protocol_revision: PROTOCOL_REVISION, ..Default::default() });
		assert_eq!(
			client
				.send(RelayRoute { peer_id: 0 }, &frame)
				.await
				.expect("send"),
			SendDisposition::Queued,
		);
	}

	#[test]
	fn close_code_table_matches_terminal_contract() {
		for code in [4001, 4004, 4009, 4029] {
			let frame = CloseFrame { code: code.into(), reason: "".into() };
			assert!(fatal_close(&frame).is_some());
		}
		let transient = CloseFrame { code: 1006.into(), reason: "".into() };
		assert!(fatal_close(&transient).is_none());
	}

	#[test]
	fn host_guest_handshake_refuses_wrong_revision() {
		let mut host = Handshake::new(RelayRole::Host);
		let hello = Hello { protocol_revision: PROTOCOL_REVISION, ..Default::default() };
		assert!(host.accept(&Handshake::hello(1, hello)).is_ok());
		assert_eq!(host.state(), HandshakeState::Established);
		let mut guest = Handshake::new(RelayRole::Guest);
		let welcome = Welcome { protocol_revision: 2, ..Default::default() };
		assert!(matches!(
			guest.accept(&Handshake::welcome(1, welcome)),
			Err(RelayError::ProtocolRevision { actual: 2, .. })
		));
	}

	#[test]
	fn relay_control_schema_contains_peer_left() {
		let control =
			RelayControl { kind: Some(relay_control::Kind::PeerLeft(PeerLeft { peer_id: 9 })) };
		assert!(!control.encode_to_vec().is_empty());
	}
}
