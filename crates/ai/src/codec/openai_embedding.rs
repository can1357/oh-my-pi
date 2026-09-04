//! Typed OpenAI-compatible embeddings request and unary response codec.

use bytes::Bytes;
use omp_catalog::{
	Availability, DimensionRange, EmbeddingCapabilities, EmbeddingFormatBits, EmbeddingInputBits,
	ModalityBits, ModelLimits, OperationKind, PolicyModel,
};
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize, ser, ser::SerializeSeq};

use crate::{
	answer::{AnswerBody, Embedding, EmbeddingBatch},
	body::BodySource,
	call::{EmbedRequest, EmbeddingInput, OperationCall, Setting, TruncationPolicy},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawEvent,
		RequestHeader, RequestMethod, SizeBounds,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

/// Response representation required from an OpenAI-compatible embeddings route.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OpenAiEmbeddingEncodingFormat {
	/// JSON arrays of IEEE-754 vector components.
	#[default]
	Float,
}

/// Route-protocol constants for an OpenAI-compatible embeddings endpoint.
///
/// Model-varying capabilities and limits are read from the immutable plan's
/// `PolicyModel` for every call, never inferred from provider or model names.
#[derive(Clone, Debug)]
pub struct OpenAiEmbeddingProfile {
	/// Path relative to the immutable wire target's route base.
	pub path:               Str,
	/// Response representation requested on this wire protocol.
	pub encoding_format:    OpenAiEmbeddingEncodingFormat,
	/// Maximum encoded request body size.
	pub max_request_bytes:  u64,
	/// Maximum individual response frame size.
	pub max_frame_bytes:    u64,
	/// Maximum aggregate response size.
	pub max_response_bytes: u64,
}

fn openai_protocol_profile() -> OpenAiEmbeddingProfile {
	OpenAiEmbeddingProfile {
		path:               sf!("/embeddings"),
		encoding_format:    OpenAiEmbeddingEncodingFormat::Float,
		max_request_bytes:  16 * 1024 * 1024,
		max_frame_bytes:    256 * 1024 * 1024,
		max_response_bytes: 256 * 1024 * 1024,
	}
}

#[cfg(test)]
impl Default for OpenAiEmbeddingProfile {
	fn default() -> Self {
		openai_protocol_profile()
	}
}

/// Sans-I/O codec for the OpenAI-compatible embeddings protocol.
#[derive(Clone, Debug)]
pub struct OpenAiEmbeddingCodec {
	profile: OpenAiEmbeddingProfile,
}

#[cfg(test)]
impl Default for OpenAiEmbeddingCodec {
	fn default() -> Self {
		Self::for_openai_protocol()
	}
}

impl OpenAiEmbeddingCodec {
	/// Constructs a codec from route-protocol constants; model evidence is
	/// supplied per call.
	pub const fn new(profile: OpenAiEmbeddingProfile) -> Self {
		Self { profile }
	}

	/// Constructs the fixed direct `OpenAI` `/embeddings` protocol profile.
	pub fn for_openai_protocol() -> Self {
		Self::new(openai_protocol_profile())
	}

	/// Encodes exact embeddings JSON bytes from immutable model evidence.
	pub fn encode_embeddings(
		&self,
		model: &str,
		policy_model: &PolicyModel,
		request: &EmbedRequest,
	) -> Result<Bytes, Error> {
		let capabilities = embedding_capabilities(policy_model)?;
		self.encode_embeddings_with_evidence(model, capabilities, &policy_model.limits, request)
	}

	/// Creates fresh state for the exact canonical embeddings request.
	pub fn embedding_decoder(
		&self,
		policy_model: &PolicyModel,
		request: &EmbedRequest,
	) -> Result<OpenAiEmbeddingDecoder, Error> {
		let capabilities = embedding_capabilities(policy_model)?;
		if !capabilities.formats.contains(EmbeddingFormatBits::FLOAT) {
			return Err(capability_error("openai_embedding_float_encoding_unsupported"));
		}
		validate_input_kind(capabilities, request)?;
		let expected_inputs = u32::try_from(request.inputs.len())
			.map_err(|_| invalid_request("openai_embedding_batch_index_overflow"))?;
		if expected_inputs == 0 {
			return Err(invalid_request("openai_embedding_inputs_empty"));
		}
		if expected_inputs > maximum_inputs(capabilities, &policy_model.limits) {
			return Err(invalid_request("openai_embedding_batch_too_large"));
		}
		let expected_dimensions = requested_dimensions(capabilities, &request.dimensions)?;
		let allowed_dimensions = match &capabilities.dimensions {
			Availability::Native(range) => Some(*range),
			Availability::Unsupported | Availability::Unknown | Availability::Emulated { .. } => None,
		};
		Ok(OpenAiEmbeddingDecoder::new(
			self
				.profile
				.max_response_bytes
				.min(self.profile.max_frame_bytes),
			expected_inputs,
			expected_dimensions,
			allowed_dimensions,
		))
	}

	fn encode_embeddings_with_evidence(
		&self,
		model: &str,
		capabilities: &EmbeddingCapabilities,
		limits: &ModelLimits,
		request: &EmbedRequest,
	) -> Result<Bytes, Error> {
		let wire = self.lower_request(model, capabilities, limits, request)?;
		let body = serde_json::to_vec(&wire)
			.map(Bytes::from)
			.map_err(|_| encoding_error("openai_embedding_request_serialization"))?;
		if body.len() as u64 > self.profile.max_request_bytes {
			return Err(invalid_request("openai_embedding_request_body_too_large"));
		}
		Ok(body)
	}

	fn lower_request<'a>(
		&self,
		model: &'a str,
		capabilities: &EmbeddingCapabilities,
		limits: &ModelLimits,
		request: &'a EmbedRequest,
	) -> Result<WireEmbeddingRequest<'a>, Error> {
		if model.is_empty() {
			return Err(invalid_request("openai_embedding_model_empty"));
		}
		if request.inputs.is_empty() {
			return Err(invalid_request("openai_embedding_inputs_empty"));
		}
		let maximum_inputs = maximum_inputs(capabilities, limits);
		if request.inputs.len() > maximum_inputs as usize {
			return Err(invalid_request("openai_embedding_batch_too_large"));
		}
		if !capabilities.formats.contains(EmbeddingFormatBits::FLOAT) {
			return Err(capability_error("openai_embedding_float_encoding_unsupported"));
		}
		validate_input_kind(capabilities, request)?;
		if !matches!(request.normalize, Setting::Unset) {
			return Err(capability_error("openai_embedding_normalization_unsupported"));
		}
		if request.truncation != TruncationPolicy::Reject {
			return Err(capability_error("openai_embedding_truncation_unsupported"));
		}

		let kind = match &request.inputs[0] {
			EmbeddingInput::Text(_) => WireInputKind::Text,
			EmbeddingInput::Tokens(_) => WireInputKind::Tokens,
		};
		for input in request.inputs.iter() {
			match (kind, input) {
				(WireInputKind::Text, EmbeddingInput::Text(text)) if !text.is_empty() => {},
				(WireInputKind::Tokens, EmbeddingInput::Tokens(tokens)) if !tokens.is_empty() => {
					if limits
						.maximum_input_tokens
						.is_some_and(|limit| tokens.len() as u64 > limit)
					{
						return Err(invalid_request("openai_embedding_token_input_too_large"));
					}
				},
				(WireInputKind::Text, EmbeddingInput::Text(_)) => {
					return Err(invalid_request("openai_embedding_text_input_empty"));
				},
				(WireInputKind::Tokens, EmbeddingInput::Tokens(_)) => {
					return Err(invalid_request("openai_embedding_token_input_empty"));
				},
				_ => return Err(invalid_request("openai_embedding_mixed_input_kinds")),
			}
		}

		let dimensions = requested_dimensions(capabilities, &request.dimensions)?;
		Ok(WireEmbeddingRequest {
			model,
			input: WireEmbeddingInputs { inputs: &request.inputs, kind },
			dimensions,
			encoding_format: self.profile.encoding_format,
		})
	}
}

fn embedding_capabilities(policy_model: &PolicyModel) -> Result<&EmbeddingCapabilities, Error> {
	policy_model
		.capabilities
		.embeddings
		.as_ref()
		.ok_or_else(|| capability_error("openai_embedding_capability_missing"))
}

fn maximum_inputs(capabilities: &EmbeddingCapabilities, limits: &ModelLimits) -> u32 {
	match (capabilities.maximum_batch, limits.maximum_batch) {
		(Some(operation), Some(model)) => operation.min(model),
		(Some(value), None) | (None, Some(value)) => value,
		(None, None) => u32::MAX,
	}
}

fn validate_input_kind(
	capabilities: &EmbeddingCapabilities,
	request: &EmbedRequest,
) -> Result<(), Error> {
	if !capabilities.input_modalities.contains(ModalityBits::TEXT) {
		return Err(capability_error("openai_embedding_text_modality_unsupported"));
	}
	match request.inputs.first() {
		Some(EmbeddingInput::Text(_))
			if capabilities.input_kinds.contains(EmbeddingInputBits::TEXT) =>
		{
			Ok(())
		},
		Some(EmbeddingInput::Tokens(_))
			if capabilities
				.input_kinds
				.contains(EmbeddingInputBits::TOKEN_IDS) =>
		{
			Ok(())
		},
		Some(EmbeddingInput::Text(_)) => {
			Err(capability_error("openai_embedding_text_inputs_unsupported"))
		},
		Some(EmbeddingInput::Tokens(_)) => {
			Err(capability_error("openai_embedding_token_inputs_unsupported"))
		},
		None => Err(invalid_request("openai_embedding_inputs_empty")),
	}
}

fn requested_dimensions(
	capabilities: &EmbeddingCapabilities,
	setting: &Setting<u32>,
) -> Result<Option<u32>, Error> {
	let value = match setting {
		Setting::Unset => return Ok(None),
		Setting::Require(value) | Setting::Prefer(value) if *value > 0 => *value,
		Setting::Require(_) | Setting::Prefer(_) => {
			return Err(invalid_request("openai_embedding_dimensions_zero"));
		},
	};
	match &capabilities.dimensions {
		Availability::Native(range) if value >= range.minimum && value <= range.maximum => {
			Ok(Some(value))
		},
		Availability::Native(_)
		| Availability::Unsupported
		| Availability::Unknown
		| Availability::Emulated { .. } => {
			Err(capability_error("openai_embedding_dimensions_unsupported"))
		},
	}
}

impl Codec for OpenAiEmbeddingCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Embed(request) = operation else {
			return Err(capability_error("openai_embedding_operation_unsupported"));
		};
		let target = context
			.target
			.ok_or_else(|| invalid_request("openai_embedding_wire_target_missing"))?;
		let policy_model = context
			.policy_model
			.ok_or_else(|| invalid_request("openai_embedding_policy_model_missing"))?;
		let body = self.encode_embeddings(target.wire_model.as_str(), policy_model, request)?;
		Ok(EncodedRequest::new(
			OperationKind::Embed,
			RequestMethod::Post,
			Str::new(join_uri(target.endpoint.base_url.as_str(), self.profile.path.as_str())),
			vec![RequestHeader { name: sf!("content-type"), value: sf!("application/json") }]
				.into_boxed_slice(),
			BodySource::Bytes(body),
			FramingProtocol::Raw,
			SizeBounds {
				request_body: self.profile.max_request_bytes,
				frame:        self.profile.max_frame_bytes,
				response:     self.profile.max_response_bytes,
			},
		))
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if context.operation != OperationKind::Embed
			|| context.operation_call.kind() != context.operation
		{
			return Err(capability_error("openai_embedding_operation_unsupported"));
		}
		if context.target.is_none() {
			return Err(invalid_request("openai_embedding_wire_target_missing"));
		}
		let policy_model = context
			.policy_model
			.ok_or_else(|| invalid_request("openai_embedding_policy_model_missing"))?;
		let OperationCall::Embed(request) = context.operation_call else {
			return Err(capability_error("openai_embedding_operation_unsupported"));
		};
		Ok(Box::new(self.embedding_decoder(policy_model, request)?))
	}
}

#[derive(Clone, Copy)]
enum WireInputKind {
	Text,
	Tokens,
}

struct WireEmbeddingInputs<'a> {
	inputs: &'a [EmbeddingInput],
	kind:   WireInputKind,
}

impl Serialize for WireEmbeddingInputs<'_> {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		let mut sequence = serializer.serialize_seq(Some(self.inputs.len()))?;
		for input in self.inputs {
			match (self.kind, input) {
				(WireInputKind::Text, EmbeddingInput::Text(text)) => {
					sequence.serialize_element(text.as_str())?;
				},
				(WireInputKind::Tokens, EmbeddingInput::Tokens(tokens)) => {
					sequence.serialize_element(tokens.as_ref())?;
				},
				_ => return Err(ser::Error::custom("validated embedding input kind changed")),
			}
		}
		sequence.end()
	}
}

#[derive(Serialize)]
struct WireEmbeddingRequest<'a> {
	model:           &'a str,
	input:           WireEmbeddingInputs<'a>,
	#[serde(skip_serializing_if = "Option::is_none")]
	dimensions:      Option<u32>,
	encoding_format: OpenAiEmbeddingEncodingFormat,
}

#[derive(Deserialize)]
struct WireEmbeddingEnvelope {
	#[serde(default)]
	data:  Option<Vec<WireEmbedding>>,
	#[serde(default)]
	usage: Option<WireEmbeddingUsage>,
	#[serde(default)]
	error: Option<WireError>,
}

#[derive(Deserialize)]
struct WireEmbedding {
	index:     u32,
	embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct WireEmbeddingUsage {
	prompt_tokens: u64,
	total_tokens:  u64,
}

#[derive(Deserialize)]
struct WireError {
	#[serde(default)]
	message: Option<Str>,
	#[serde(default, rename = "type")]
	kind:    Option<Str>,
	#[serde(default)]
	code:    Option<WireErrorCode>,
	#[serde(default)]
	param:   Option<Str>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireErrorCode {
	Text(Str),
	Number(i64),
}

/// Fresh unary decoder for one OpenAI-compatible embeddings response.
#[derive(Debug)]
pub struct OpenAiEmbeddingDecoder {
	maximum_bytes:       u64,
	expected_inputs:     u32,
	expected_dimensions: Option<u32>,
	allowed_dimensions:  Option<DimensionRange>,
	completed:           bool,
}

impl OpenAiEmbeddingDecoder {
	const fn new(
		maximum_bytes: u64,
		expected_inputs: u32,
		expected_dimensions: Option<u32>,
		allowed_dimensions: Option<DimensionRange>,
	) -> Self {
		Self {
			maximum_bytes,
			expected_inputs,
			expected_dimensions,
			allowed_dimensions,
			completed: false,
		}
	}

	fn decode_success(
		&mut self,
		mut data: Vec<WireEmbedding>,
		usage: WireEmbeddingUsage,
		emit: &mut dyn FnMut(RawEvent),
	) -> Result<(), Error> {
		if data.is_empty() {
			return Err(protocol_error("openai_embedding_data_empty"));
		}
		if data.len() > u32::MAX as usize {
			return Err(protocol_error("openai_embedding_index_overflow"));
		}
		if usage.total_tokens != usage.prompt_tokens {
			return Err(protocol_error("openai_embedding_usage_total_mismatch"));
		}
		if data.len() != self.expected_inputs as usize {
			return Err(protocol_error("openai_embedding_response_count_mismatch"));
		}
		data.sort_unstable_by_key(|item| item.index);
		let dimensions = u32::try_from(data[0].embedding.len())
			.map_err(|_| protocol_error("openai_embedding_dimensions_overflow"))?;
		if dimensions == 0 {
			return Err(protocol_error("openai_embedding_vector_empty"));
		}
		if self
			.expected_dimensions
			.is_some_and(|expected| dimensions != expected)
		{
			return Err(protocol_error("openai_embedding_requested_dimensions_mismatch"));
		}
		if self
			.allowed_dimensions
			.is_some_and(|range| dimensions < range.minimum || dimensions > range.maximum)
		{
			return Err(protocol_error("openai_embedding_catalog_dimensions_mismatch"));
		}
		let mut embeddings = Vec::with_capacity(data.len());
		for (expected, item) in data.into_iter().enumerate() {
			let expected = expected as u32;
			if item.index != expected {
				let reason = if item.index < expected {
					"openai_embedding_duplicate_index"
				} else {
					"openai_embedding_missing_index"
				};
				return Err(protocol_error(reason));
			}
			if item.embedding.len() != dimensions as usize {
				return Err(protocol_error("openai_embedding_dimension_mismatch"));
			}
			if item.embedding.iter().any(|value| !value.is_finite()) {
				return Err(protocol_error("openai_embedding_non_finite_value"));
			}
			embeddings.push(Embedding { index: item.index, values: item.embedding });
		}
		self.completed = true;
		emit(RawEvent::Answer(AnswerBody::Embeddings(EmbeddingBatch {
			dimensions,
			embeddings,
			usage: Usage {
				input_tokens: usage.prompt_tokens,
				source: UsageSource::Provider,
				..Usage::default()
			},
		})));
		Ok(())
	}
}

impl Decoder for OpenAiEmbeddingDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.completed {
			return Err(protocol_error("openai_embedding_response_repeated"));
		}
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("openai_embedding_response_framing"));
		};
		if bytes.len() as u64 > self.maximum_bytes {
			return Err(protocol_error("openai_embedding_response_too_large"));
		}
		let envelope: WireEmbeddingEnvelope = serde_json::from_slice(&bytes)
			.map_err(|_| protocol_error("openai_embedding_response_malformed"))?;
		match (envelope.data, envelope.usage, envelope.error) {
			(None, None, Some(error)) => {
				self.completed = true;
				emit(RawEvent::Failure(provider_error(error)));
				Ok(())
			},
			(Some(data), Some(usage), None) => self.decode_success(data, usage, emit),
			_ => Err(protocol_error("openai_embedding_response_envelope_invalid")),
		}
	}

	fn finish(&mut self, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.completed {
			Ok(())
		} else {
			Err(protocol_error("openai_embedding_response_missing"))
		}
	}
}

fn provider_error(error: WireError) -> Error {
	let status = match error.code.as_ref() {
		Some(WireErrorCode::Number(value)) => u16::try_from(*value).ok(),
		Some(WireErrorCode::Text(value)) => value.as_str().parse::<u16>().ok(),
		None => None,
	};
	let code = match error.code.as_ref() {
		Some(WireErrorCode::Text(value)) => Some(value.as_str()),
		_ => None,
	};
	let kind = error.kind.as_deref();
	let (error_kind, stable_code) = match (status, code, kind) {
		(Some(401), ..) | (_, Some("invalid_api_key"), _) | (_, _, Some("authentication_error")) => {
			(ErrorKind::Authentication, "openai_embedding_authentication")
		},
		(Some(403), ..) | (_, Some("permission_denied"), _) | (_, _, Some("permission_error")) => {
			(ErrorKind::Authorization, "openai_embedding_authorization")
		},
		(Some(429), ..) | (_, Some("rate_limit_exceeded"), _) | (_, _, Some("rate_limit_error")) => {
			(ErrorKind::RateLimited, "openai_embedding_rate_limited")
		},
		(_, Some("insufficient_quota"), _) => {
			(ErrorKind::QuotaExhausted, "openai_embedding_quota_exhausted")
		},
		(Some(400), ..)
		| (_, Some("invalid_request_error"), _)
		| (_, _, Some("invalid_request_error")) => {
			(ErrorKind::InvalidRequest, "openai_embedding_invalid_request")
		},
		(_, Some("context_length_exceeded"), _) => {
			(ErrorKind::ContextOverflow, "openai_embedding_context_overflow")
		},
		_ => (ErrorKind::ProviderContractMismatch, "openai_embedding_provider_error"),
	};
	let _ = (error.message, error.param);
	Error::new(error_kind, ErrorPhase::Handshake, RetryAction::Never, ExecutionReceipt::default())
		.status(status)
		.code(Str::new(stable_code))
		.detail(ErrorDetail::provider(sf!("OpenAI embeddings request failed")))
}

fn join_uri(base: &str, path: &str) -> String {
	let mut uri = String::with_capacity(base.len() + path.len() + 1);
	uri.push_str(base.trim_end_matches('/'));
	if !path.starts_with('/') {
		uri.push('/');
	}
	uri.push_str(path);
	uri
}

fn invalid_request(reason: &'static str) -> Error {
	structured_error(ErrorKind::InvalidRequest, ErrorPhase::Encoding, reason)
}

fn capability_error(reason: &'static str) -> Error {
	structured_error(ErrorKind::CapabilityMismatch, ErrorPhase::Encoding, reason)
}

fn encoding_error(reason: &'static str) -> Error {
	structured_error(ErrorKind::InternalInvariant, ErrorPhase::Encoding, reason)
}

fn protocol_error(reason: &'static str) -> Error {
	structured_error(ErrorKind::Protocol, ErrorPhase::Handshake, reason)
}

fn structured_error(kind: ErrorKind, phase: ErrorPhase, reason: &'static str) -> Error {
	Error::new(kind, phase, RetryAction::Never, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::call::{NegotiationPolicy, TruncationPolicy};

	fn request(inputs: Arc<[EmbeddingInput]>, dimensions: Setting<u32>) -> EmbedRequest {
		EmbedRequest {
			inputs,
			dimensions,
			normalize: Setting::Unset,
			truncation: TruncationPolicy::Reject,
			negotiation: NegotiationPolicy::default(),
		}
	}

	fn capabilities(input_kinds: EmbeddingInputBits) -> EmbeddingCapabilities {
		EmbeddingCapabilities {
			input_modalities: ModalityBits::TEXT,
			input_kinds,
			formats: EmbeddingFormatBits::FLOAT,
			maximum_batch: Some(2_048),
			dimensions: Availability::Native(DimensionRange { minimum: 1, maximum: 3_072 }),
		}
	}

	fn text_and_token_capabilities() -> EmbeddingCapabilities {
		capabilities(EmbeddingInputBits::TEXT.union(EmbeddingInputBits::TOKEN_IDS))
	}

	fn encode(
		codec: &OpenAiEmbeddingCodec,
		model: &str,
		capabilities: &EmbeddingCapabilities,
		limits: &ModelLimits,
		request: &EmbedRequest,
	) -> Result<Bytes, Error> {
		codec.encode_embeddings_with_evidence(model, capabilities, limits, request)
	}

	fn decode(
		bytes: &'static [u8],
		expected_inputs: u32,
		expected_dimensions: Option<u32>,
	) -> Result<Vec<RawEvent>, Error> {
		let mut decoder = OpenAiEmbeddingDecoder::new(
			OpenAiEmbeddingProfile::default().max_response_bytes,
			expected_inputs,
			expected_dimensions,
			None,
		);
		let mut events = Vec::new();
		decoder.push(Frame::Raw(Bytes::from_static(bytes)), &mut |event| events.push(event))?;
		decoder.finish(&mut |event| events.push(event))?;
		Ok(events)
	}

	fn embedding_batch(events: Vec<RawEvent>) -> EmbeddingBatch {
		match events.into_iter().next().expect("one event") {
			RawEvent::Answer(AnswerBody::Embeddings(batch)) => batch,
			_ => panic!("embedding answer expected"),
		}
	}

	#[test]
	fn exact_text_token_and_dimension_requests() {
		let codec = OpenAiEmbeddingCodec::default();
		let limits = ModelLimits::default();
		let text_capabilities = capabilities(EmbeddingInputBits::TEXT);
		let token_capabilities = text_and_token_capabilities();
		let text = request(
			Arc::from([EmbeddingInput::Text(sf!("alpha")), EmbeddingInput::Text(sf!("beta"))]),
			Setting::Unset,
		);
		assert_eq!(
			encode(&codec, "text-embedding-3-small", &text_capabilities, &limits, &text).expect("text request"),
			Bytes::from_static(br#"{"model":"text-embedding-3-small","input":["alpha","beta"],"encoding_format":"float"}"#),
		);

		let tokens = request(
			Arc::from([
				EmbeddingInput::Tokens(Arc::from([10, 20, 30])),
				EmbeddingInput::Tokens(Arc::from([40, 50])),
			]),
			Setting::Unset,
		);
		assert_eq!(
			encode(&codec, "exact-model", &token_capabilities, &limits, &tokens)
				.expect("token request"),
			Bytes::from_static(
				br#"{"model":"exact-model","input":[[10,20,30],[40,50]],"encoding_format":"float"}"#
			),
		);

		let dimensioned =
			request(Arc::from([EmbeddingInput::Text(sf!("alpha"))]), Setting::Require(256));
		assert_eq!(
			encode(&codec, "exact-model", &text_capabilities, &limits, &dimensioned).expect("dimension request"),
			Bytes::from_static(br#"{"model":"exact-model","input":["alpha"],"dimensions":256,"encoding_format":"float"}"#),
		);
	}

	#[test]
	fn route_path_is_relative_to_the_exact_target_base() {
		assert_eq!(
			join_uri("https://api.openai.com/v1/", "/embeddings"),
			"https://api.openai.com/v1/embeddings"
		);
	}

	#[test]
	fn request_validation_rejects_empty_bounds_and_unsupported_options() {
		let codec = OpenAiEmbeddingCodec::default();
		let supported = text_and_token_capabilities();
		let limits = ModelLimits::default();
		for invalid in [
			request(Arc::from([]), Setting::Unset),
			request(Arc::from([EmbeddingInput::Text(Default::default())]), Setting::Unset),
			request(Arc::from([EmbeddingInput::Tokens(Arc::from([]))]), Setting::Unset),
			request(Arc::from([EmbeddingInput::Text(sf!("x"))]), Setting::Require(0)),
		] {
			assert!(encode(&codec, "model", &supported, &limits, &invalid).is_err());
		}

		let mut normalized = request(Arc::from([EmbeddingInput::Text(sf!("x"))]), Setting::Unset);
		normalized.normalize = Setting::Require(true);
		assert!(encode(&codec, "model", &supported, &limits, &normalized).is_err());
		let mut truncated = request(Arc::from([EmbeddingInput::Text(sf!("x"))]), Setting::Unset);
		truncated.truncation = TruncationPolicy::End;
		assert!(encode(&codec, "model", &supported, &limits, &truncated).is_err());

		let mut no_dimensions = supported.clone();
		no_dimensions.dimensions = Availability::Unsupported;
		let dimensioned = request(Arc::from([EmbeddingInput::Text(sf!("x"))]), Setting::Prefer(64));
		assert!(encode(&codec, "model", &no_dimensions, &limits, &dimensioned).is_err());
		let mut no_float = supported.clone();
		no_float.formats = EmbeddingFormatBits::BASE64;
		let plain = request(Arc::from([EmbeddingInput::Text(sf!("x"))]), Setting::Unset);
		assert!(encode(&codec, "model", &no_float, &limits, &plain).is_err());

		let tokens = request(Arc::from([EmbeddingInput::Tokens(Arc::from([1, 2]))]), Setting::Unset);
		let text_only = capabilities(EmbeddingInputBits::TEXT);
		assert!(encode(&codec, "model", &text_only, &limits, &tokens).is_err());

		let mut bounded_capabilities = supported;
		bounded_capabilities.maximum_batch = Some(1);
		let bounded_limits = ModelLimits { maximum_input_tokens: Some(2), ..ModelLimits::default() };
		let oversized_batch = request(
			Arc::from([EmbeddingInput::Text(sf!("x")), EmbeddingInput::Text(sf!("y"))]),
			Setting::Unset,
		);
		assert!(
			encode(&codec, "model", &bounded_capabilities, &bounded_limits, &oversized_batch).is_err()
		);
		let oversized_tokens =
			request(Arc::from([EmbeddingInput::Tokens(Arc::from([1, 2, 3]))]), Setting::Unset);
		assert!(
			encode(&codec, "model", &bounded_capabilities, &bounded_limits, &oversized_tokens)
				.is_err()
		);
	}

	#[test]
	fn out_of_order_response_is_canonicalized_and_usage_is_typed() {
		let batch = embedding_batch(decode(
			br#"{"data":[{"index":1,"embedding":[3.0,4.0]},{"index":0,"embedding":[1.0,2.0]}],"usage":{"prompt_tokens":7,"total_tokens":7}}"#,
			2,
			Some(2),
		).expect("response"));
		assert_eq!(batch.dimensions, 2);
		assert_eq!(
			batch
				.embeddings
				.iter()
				.map(|item| item.index)
				.collect::<Vec<_>>(),
			vec![0, 1]
		);
		assert_eq!(batch.embeddings[0].values, vec![1.0, 2.0]);
		assert_eq!(batch.usage.input_tokens, 7);
		assert_eq!(batch.usage.source, UsageSource::Provider);
	}

	#[test]
	fn duplicate_missing_dimensions_nonfinite_and_malformed_fail_typed() {
		for (fixture, reason) in [
			(br#"{"data":[{"index":0,"embedding":[1.0]},{"index":0,"embedding":[2.0]}],"usage":{"prompt_tokens":1,"total_tokens":1}}"#.as_slice(), "openai_embedding_duplicate_index"),
			(br#"{"data":[{"index":0,"embedding":[1.0]},{"index":2,"embedding":[2.0]}],"usage":{"prompt_tokens":1,"total_tokens":1}}"#.as_slice(), "openai_embedding_missing_index"),
			(br#"{"data":[{"index":0,"embedding":[1.0,2.0]},{"index":1,"embedding":[3.0]}],"usage":{"prompt_tokens":1,"total_tokens":1}}"#.as_slice(), "openai_embedding_dimension_mismatch"),
		] {
			let Err(error) = decode(fixture, 2, None) else {
				panic!("invalid response accepted");
			};
			assert!(matches!(error.detail_ref(), Some(ErrorDetail::Protocol { reason: actual }) if actual.0 == reason));
		}
		for fixture in [
			br#"{"data":[{"index":0,"embedding":[1e400]}],"usage":{"prompt_tokens":1,"total_tokens":1}}"#.as_slice(),
			br#"{"data":not-json}"#.as_slice(),
		] {
			let Err(error) = decode(fixture, 1, None) else {
				panic!("invalid response accepted");
			};
			assert_eq!(error.kind, ErrorKind::Protocol);
		}
		let Err(error) = decode(
			br#"{"data":[{"index":0,"embedding":[1.0,2.0]}],"usage":{"prompt_tokens":1,"total_tokens":1}}"#,
			1,
			Some(3),
		) else {
			panic!("wrong requested dimensions accepted");
		};
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Protocol { reason }) if reason.0 == "openai_embedding_requested_dimensions_mismatch"
		));
	}

	#[test]
	fn typed_status_error_is_classified_without_retaining_credentials() {
		let events = decode(
			br#"{"error":{"message":"rejected key sk-secret-material","type":"rate_limit_error","code":429,"param":"Authorization: Bearer secret"}}"#,
			1,
			None,
		).expect("typed error");
		let RawEvent::Failure(error) = events.into_iter().next().expect("failure event") else {
			panic!("failure expected");
		};
		assert_eq!(error.kind, ErrorKind::RateLimited);
		assert_eq!(error.status, Some(429));
		assert_eq!(error.code.as_deref(), Some("openai_embedding_rate_limited"));
		let debug = format!("{error:?}");
		assert!(!debug.contains("sk-secret-material"));
		assert!(!debug.contains("Bearer secret"));
	}
}
