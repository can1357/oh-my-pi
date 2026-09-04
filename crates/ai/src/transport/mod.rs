//! Protocol-neutral bounded transport framing.

pub mod browser;
pub mod capture;
pub mod cassette;
pub mod connect;
pub mod custom;
pub mod encoding;
pub mod eventstream;
pub mod frame;
pub mod http;
pub mod ndjson;
pub mod proxy;
pub mod sse;
pub mod websocket;
pub mod websocket_transport;

#[cfg(test)]
mod tests;

pub use capture::{
	CaptureSnapshot, CaptureSummary, CapturedFrame, DEFAULT_CAPTURE_FRAME_BYTES,
	DEFAULT_CAPTURE_FRAMES, DEFAULT_SUBSCRIBER_FRAMES, RawProviderCapture, global_provider_capture,
};
pub use connect::{ConnectDecoder, ConnectEnvelope, ConnectEnvelopeKind};
pub use custom::{CustomEndpoint, CustomEndpointError, CustomEndpointMode};
pub use eventstream::{
	EventStreamDecoder, EventStreamHeader, EventStreamHeaderValue, EventStreamMessage,
};
pub use frame::{
	CrcScope, DEFAULT_MAX_FRAME_BYTES, Frame, FramingError, FramingProtocol, IncrementalFramer,
	RawChunkFramer, Utf8Field,
};
pub use ndjson::NdjsonDecoder;
pub use sse::{SseDecoder, SseEvent};
pub use websocket::{
	WebSocketDecoder, WebSocketFragment, WebSocketMasking, WebSocketMessage, WebSocketOpcode,
};
pub use websocket_transport::WebSocketTransport;
