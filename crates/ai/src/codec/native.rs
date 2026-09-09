//! Allowlisted, size-bounded native `OpenAI`- and Anthropic-compatible facades.
//!
//! Native payloads are intentionally opaque and byte-preserving. This module
//! selects only closed method/path pairs and never acts as an arbitrary proxy.

use bytes::{BufMut as _, Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, sf};

use crate::{
	body::BodySource,
	call::{
		NativeMethod, NativePath, NativePayload, NativeRequest, NativeResponseFraming, OperationCall,
		RawJson,
	},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest,
		NativeResponseFormat, RawEvent, RequestHeader, RequestMethod, SizeBounds,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId},
	transport::{Frame, FramingProtocol, SseEvent},
};

/// Maximum body accepted by a native facade request.
pub const MAX_NATIVE_REQUEST_BYTES: u64 = 16 * 1024 * 1024;
/// Hard ceiling on an individual native stream frame.
pub const MAX_NATIVE_FRAME_BYTES: u64 = 4 * 1024 * 1024;
/// Hard ceiling on a caller-selected native response body limit.
pub const MAX_NATIVE_RESPONSE_BYTES: u64 = 64 * 1024 * 1024;

/// Stateless codec for closed native-wire facade routes.
#[derive(Clone, Copy, Debug, Default)]
pub struct NativeFacadeCodec;

/// Validated semantic route selected before any body parsing or I/O.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeFacadeRoute {
	/// Closed method.
	pub method: NativeMethod,
	/// Closed semantic path.
	pub path:   NativePath,
}

impl NativeFacadeRoute {
	/// Parses and validates an exact method/path pair before transport
	/// construction.
	pub fn parse(method: &str, path: &str) -> Result<Self, Error> {
		let method = match method {
			"GET" => NativeMethod::Get,
			"POST" => NativeMethod::Post,
			"DELETE" => NativeMethod::Delete,
			_ => return Err(rejected("native_method_not_allowlisted")),
		};
		let path = match path {
			"/v1/chat/completions" => NativePath::ChatCompletions,
			"/v1/responses" => NativePath::Responses,
			"/v1/messages" => NativePath::Messages,
			"/v1/messages/count_tokens" => NativePath::MessageTokenCounts,
			"/v1/embeddings" => NativePath::Embeddings,
			"/v1/images/generations" => NativePath::ImageGenerations,
			"/v1/audio/speech" => NativePath::AudioSpeech,
			"/v1/audio/transcriptions" => NativePath::AudioTranscriptions,
			"/v1/realtime/sessions" => NativePath::RealtimeSessions,
			"/v1/models" => NativePath::Models,
			"/v1/usage" => NativePath::Usage,
			_ => return Err(rejected("native_path_not_allowlisted")),
		};
		let route = Self { method, path };
		route.validate()?;
		Ok(route)
	}

	/// Validates a typed route's method/path combination.
	pub fn validate(self) -> Result<(), Error> {
		let valid = matches!(
			(self.method, self.path),
			(NativeMethod::Get, NativePath::Models | NativePath::Usage)
				| (
					NativeMethod::Post,
					NativePath::ChatCompletions
						| NativePath::Responses
						| NativePath::Messages
						| NativePath::MessageTokenCounts
						| NativePath::Embeddings
						| NativePath::ImageGenerations
						| NativePath::AudioSpeech
						| NativePath::AudioTranscriptions
						| NativePath::RealtimeSessions
				)
		);
		if valid {
			Ok(())
		} else {
			Err(rejected("native_method_path_combination_rejected"))
		}
	}

	/// Returns the exact wire path for this closed route.
	pub const fn as_path(self) -> &'static str {
		match self.path {
			NativePath::ChatCompletions => "/v1/chat/completions",
			NativePath::Responses => "/v1/responses",
			NativePath::Messages => "/v1/messages",
			NativePath::MessageTokenCounts => "/v1/messages/count_tokens",
			NativePath::Embeddings => "/v1/embeddings",
			NativePath::ImageGenerations => "/v1/images/generations",
			NativePath::AudioSpeech => "/v1/audio/speech",
			NativePath::AudioTranscriptions => "/v1/audio/transcriptions",
			NativePath::RealtimeSessions => "/v1/realtime/sessions",
			NativePath::Models => "/v1/models",
			NativePath::Usage => "/v1/usage",
		}
	}
}

/// Parses a bounded opaque JSON request after its route has been allowlisted.
pub fn parse_native_json(
	method: &str,
	path: &str,
	body: &[u8],
	response_framing: NativeResponseFraming,
	max_response_bytes: u64,
) -> Result<NativeRequest, Error> {
	let route = NativeFacadeRoute::parse(method, path)?;
	validate_limits(body.len() as u64, max_response_bytes)?;
	let json = RawJson::new(Bytes::copy_from_slice(body), MAX_NATIVE_REQUEST_BYTES)
		.map_err(|_| rejected("native_invalid_json"))?;
	Ok(NativeRequest {
		method: route.method,
		path: route.path,
		payload: Some(NativePayload::Json(json)),
		response_framing,
		max_response_bytes,
	})
}

impl Codec for NativeFacadeCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Native(request) = operation else {
			return Err(rejected("native_operation_required"));
		};
		encode_native(context, request)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		let format = context
			.native_response
			.ok_or_else(|| rejected("native_response_format_missing"))?;
		Ok(Box::new(NativeFacadeDecoder::new(format)))
	}
}

fn encode_native(
	context: &EncodeContext<'_>,
	request: &NativeRequest,
) -> Result<EncodedRequest, Error> {
	let route = NativeFacadeRoute { method: request.method, path: request.path };
	route.validate()?;
	if request.max_response_bytes == 0 || request.max_response_bytes > MAX_NATIVE_RESPONSE_BYTES {
		return Err(rejected("native_response_limit_invalid"));
	}
	let (body, content_type) = encode_payload(request.payload.as_ref())?;
	let headers = content_type.map_or_else(
		|| Box::new([]) as Box<[RequestHeader]>,
		|value| {
			vec![RequestHeader { name: sf!("content-type"), value: Str::new(value) }]
				.into_boxed_slice()
		},
	);
	Ok(EncodedRequest {
		operation: OperationKind::Native,
		method: match request.method {
			NativeMethod::Get => RequestMethod::Get,
			NativeMethod::Post => RequestMethod::Post,
			NativeMethod::Delete => RequestMethod::Delete,
		},
		uri: join_uri(context.route.endpoint.base_url.as_str(), route.as_path()),
		headers,
		body,
		framing: match request.response_framing {
			NativeResponseFraming::Json | NativeResponseFraming::Bytes => FramingProtocol::Raw,
			NativeResponseFraming::Sse => FramingProtocol::Sse,
		},
		bounds: SizeBounds {
			request_body: MAX_NATIVE_REQUEST_BYTES,
			frame:        MAX_NATIVE_FRAME_BYTES,
			response:     request.max_response_bytes,
		},
		sealed_body: None,
		adjustments: Vec::new(),
	})
}

fn encode_payload(
	payload: Option<&NativePayload>,
) -> Result<(BodySource, Option<&'static str>), Error> {
	match payload {
		None => Ok((BodySource::Bytes(Bytes::new()), None)),
		Some(NativePayload::Json(json)) => {
			let bytes = Bytes::copy_from_slice(json.as_bytes());
			validate_request_size(bytes.len() as u64)?;
			Ok((BodySource::Bytes(bytes), Some("application/json")))
		},
		Some(NativePayload::Bytes(bytes)) => {
			validate_request_size(bytes.len() as u64)?;
			Ok((BodySource::Bytes(bytes.clone()), Some("application/octet-stream")))
		},
		Some(NativePayload::Body(native)) => {
			Ok((native.source().clone(), Some("application/octet-stream")))
		},
	}
}

fn validate_limits(request_bytes: u64, response_bytes: u64) -> Result<(), Error> {
	validate_request_size(request_bytes)?;
	if response_bytes == 0 || response_bytes > MAX_NATIVE_RESPONSE_BYTES {
		return Err(rejected("native_response_limit_invalid"));
	}
	Ok(())
}

fn validate_request_size(bytes: u64) -> Result<(), Error> {
	if bytes > MAX_NATIVE_REQUEST_BYTES {
		Err(rejected("native_request_body_too_large"))
	} else {
		Ok(())
	}
}

fn join_uri(base: &str, path: &str) -> Str {
	sf!("{}{path}", base.trim_end_matches('/'))
}

/// Incremental lossless projector for native response frames.
#[derive(Debug)]
pub struct NativeFacadeDecoder {
	format:   NativeResponseFormat,
	finished: bool,
}

impl NativeFacadeDecoder {
	/// Creates a decoder with an explicit lossless response representation.
	pub const fn new(format: NativeResponseFormat) -> Self {
		Self { format, finished: false }
	}
}

impl Decoder for NativeFacadeDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		let bytes = match (self.format, frame) {
			(NativeResponseFormat::Json, Frame::Raw(bytes)) => {
				serde_json::from_slice::<serde_json::Value>(&bytes)
					.map_err(|_| protocol_error("native_invalid_json_response"))?;
				self.finished = true;
				bytes
			},
			(NativeResponseFormat::Bytes, Frame::Raw(bytes)) => {
				self.finished = true;
				bytes
			},
			(NativeResponseFormat::Sse, Frame::Sse(event)) => encode_sse_event(event),
			_ => return Err(protocol_error("native_unexpected_response_frame")),
		};
		emit(RawEvent::NativeChunk(bytes));
		Ok(())
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		self.finished = true;
		Ok(())
	}
}

fn encode_sse_event(event: SseEvent) -> Bytes {
	let capacity = event.data.len() + event.name.as_ref().map_or(0, |name| name.len() + 8) + 8;
	let mut output = BytesMut::with_capacity(capacity);
	if let Some(name) = event.name {
		output.extend_from_slice(b"event: ");
		output.extend_from_slice(name.as_bytes());
		output.put_u8(b'\n');
	}
	for line in event.data.split(|byte| *byte == b'\n') {
		output.extend_from_slice(b"data: ");
		output.extend_from_slice(line);
		output.put_u8(b'\n');
	}
	output.put_u8(b'\n');
	output.freeze()
}

fn rejected(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::NativeRequestRejected,
		ErrorPhase::Planning,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::Protocol,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::sync;

	use futures::{future, stream};

	use super::*;
	use crate::body::{ByteStream, NativeBodySource, NativeStreamDeclaration, OneShotBody};

	#[test]
	fn fixture_routes_are_closed_and_method_specific() {
		assert_eq!(
			NativeFacadeRoute::parse("POST", "/v1/chat/completions")
				.expect("chat")
				.path,
			NativePath::ChatCompletions
		);
		assert_eq!(
			NativeFacadeRoute::parse("POST", "/v1/messages/count_tokens")
				.expect("count")
				.path,
			NativePath::MessageTokenCounts
		);
		assert_eq!(
			NativeFacadeRoute::parse("GET", "/v1/models")
				.expect("models")
				.path,
			NativePath::Models
		);
		assert!(NativeFacadeRoute::parse("POST", "/v1/models").is_err());
		assert!(NativeFacadeRoute::parse("POST", "/v1/unknown").is_err());
		assert!(NativeFacadeRoute::parse("GET", "/v1/chat/completions").is_err());
	}

	#[test]
	fn arbitrary_path_rejects_before_json_is_examined() {
		let error = parse_native_json("POST", "/v1/unknown", b"{", NativeResponseFraming::Json, 1024)
			.expect_err("path");
		assert!(
			matches!(error.detail_ref(), Some(ErrorDetail::Protocol { reason: ReasonId(reason) }) if reason.as_str() == "native_path_not_allowlisted")
		);
	}

	#[test]
	fn invalid_json_and_size_limits_are_explicit() {
		let error =
			parse_native_json("POST", "/v1/responses", b"{", NativeResponseFraming::Json, 1024)
				.expect_err("json");
		assert_eq!(error.kind, ErrorKind::NativeRequestRejected);
		assert!(
			parse_native_json("POST", "/v1/responses", b"{}", NativeResponseFraming::Json, 0).is_err()
		);
		assert!(
			parse_native_json(
				"POST",
				"/v1/responses",
				b"{}",
				NativeResponseFraming::Json,
				MAX_NATIVE_RESPONSE_BYTES + 1
			)
			.is_err()
		);
	}

	#[test]
	fn native_sse_frames_preserve_sdk_terminal_bytes() {
		let bytes = encode_sse_event(SseEvent { name: None, data: Bytes::from_static(b"[DONE]") });
		assert_eq!(bytes.as_ref(), b"data: [DONE]\n\n");
	}

	#[test]
	fn one_shot_native_bodies_retain_physical_replay_evidence() {
		let stream: ByteStream =
			Box::pin(stream::once(future::ready(Ok(Bytes::from_static(b"body")))));
		let source = BodySource::OneShot(sync::Arc::new(OneShotBody::new(stream)));
		let native = NativeBodySource::new(source, NativeStreamDeclaration::OneShot)
			.expect("one-shot declaration");
		assert_eq!(native.replay_evidence().replayability, crate::body::Replayability::OneShot);
	}
}
