//! Token counting and reversible tokenizer operation services.

use std::{
	future::{Future, Ready, ready},
	io::Cursor,
	num::NonZeroU32,
	sync::Arc,
	task::{Context, Poll},
};

use omp_core::{Str, sf};
use tower::Service;
use xutf::BufReadCharsExt as _;

use crate::{
	answer::{Answer, AnswerBody, DetokenizedText, TokenCount, TokenSequence, TokenizerProvenance},
	call::{
		Call, ContentPart, CountAccuracy, CountTokensRequest, DetokenizeRequest, MediaInput,
		OperationCall, TokenizeRequest, ToolResultContent,
	},
	catalog::OperationKind,
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	operation::{OperationRequest, OperationResponse, RouteIdentity},
	receipt::{ExecutionReceipt, ReasonId},
};

/// Validates that tokenizer identity and revision evidence is usable for
/// replay.
pub fn validate_provenance(provenance: &TokenizerProvenance) -> Result<(), Error> {
	if provenance.tokenizer.is_empty() || provenance.revision.is_empty() {
		return Err(protocol_error("tokenizer_identity_or_revision_missing"));
	}
	Ok(())
}

/// Concrete token-count operation service over a route-local typed backend.
#[derive(Clone, Debug)]
pub struct CountTokensService<S> {
	inner: S,
	exact: bool,
}

impl<S> CountTokensService<S> {
	/// Wraps a constructed token-count backend and declares its accuracy.
	pub const fn new(inner: S, exact: bool) -> Self {
		Self { inner, exact }
	}

	/// Returns the constructed backend.
	pub fn into_inner(self) -> S {
		self.inner
	}
}

impl<S> Service<Call> for CountTokensService<S>
where
	S: Service<
			OperationRequest<CountTokensRequest>,
			Response = OperationResponse<TokenCount>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let request = match &call.operation {
			OperationCall::CountTokens(request) => {
				Some(OperationRequest::from_call(&call, Arc::clone(request)))
			},
			_ => None,
		};
		let accuracy = request.as_ref().map(|request| request.payload.accuracy);
		let rejected = accuracy == Some(CountAccuracy::Exact) && !self.exact;
		let pending = (!rejected)
			.then(|| request.map(|request| self.inner.call(request)))
			.flatten();
		async move {
			if rejected {
				return Err(capability_error("exact_token_count_required"));
			}
			let Some(pending) = pending else {
				return Err(wrong_operation(&call, OperationKind::CountTokens));
			};
			let response = pending.await?;
			validate_provenance(&response.output.provenance)?;
			if accuracy == Some(CountAccuracy::Exact) && !response.output.provenance.exact {
				return Err(capability_error("exact_token_count_required"));
			}
			Ok(response.into_answer(AnswerBody::Tokens))
		}
	}
}

/// Concrete tokenize operation service over a route-local typed backend.
#[derive(Clone, Debug)]
pub struct TokenizeService<S> {
	inner:            S,
	supports_special: bool,
}

impl<S> TokenizeService<S> {
	/// Wraps a tokenizer backend and declares whether it recognizes special
	/// tokens.
	pub const fn new(inner: S, supports_special: bool) -> Self {
		Self { inner, supports_special }
	}
}

impl<S> Service<Call> for TokenizeService<S>
where
	S: Service<
			OperationRequest<TokenizeRequest>,
			Response = OperationResponse<TokenSequence>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let request = match &call.operation {
			OperationCall::Tokenize(request) => {
				Some(OperationRequest::from_call(&call, Arc::clone(request)))
			},
			_ => None,
		};
		let rejected = request
			.as_ref()
			.is_some_and(|request| request.payload.allow_special && !self.supports_special);
		let pending = (!rejected)
			.then(|| request.map(|request| self.inner.call(request)))
			.flatten();
		async move {
			if rejected {
				return Err(capability_error("special_token_recognition_unsupported"));
			}
			let Some(pending) = pending else {
				return Err(wrong_operation(&call, OperationKind::Tokenize));
			};
			let response = pending.await?;
			validate_provenance(&response.output.provenance)?;
			if !response.output.provenance.exact {
				return Err(protocol_error("token_sequence_requires_exact_tokenizer"));
			}
			Ok(response.into_answer(AnswerBody::TokenIds))
		}
	}
}

/// Concrete detokenize operation service over a route-local typed backend.
#[derive(Clone, Debug)]
pub struct DetokenizeService<S> {
	inner: S,
	supports_invalid_replacement: bool,
}

impl<S> DetokenizeService<S> {
	/// Wraps a tokenizer backend and declares support for non-strict
	/// replacement.
	pub const fn new(inner: S, supports_invalid_replacement: bool) -> Self {
		Self { inner, supports_invalid_replacement }
	}
}

impl<S> Service<Call> for DetokenizeService<S>
where
	S: Service<
			OperationRequest<DetokenizeRequest>,
			Response = OperationResponse<DetokenizedText>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let request = match &call.operation {
			OperationCall::Detokenize(request) => {
				Some(OperationRequest::from_call(&call, Arc::clone(request)))
			},
			_ => None,
		};
		let rejected = request
			.as_ref()
			.is_some_and(|request| !request.payload.strict && !self.supports_invalid_replacement);
		let pending = (!rejected)
			.then(|| request.map(|request| self.inner.call(request)))
			.flatten();
		async move {
			if rejected {
				return Err(capability_error("lossy_detokenization_unsupported"));
			}
			let Some(pending) = pending else {
				return Err(wrong_operation(&call, OperationKind::Detokenize));
			};
			let response = pending.await?;
			validate_provenance(&response.output.provenance)?;
			if !response.output.provenance.exact {
				return Err(protocol_error("detokenized_text_requires_exact_tokenizer"));
			}
			Ok(response.into_answer(AnswerBody::Text))
		}
	}
}

/// Pinned exact UTF-8 byte tokenizer for routes whose catalog explicitly
/// selects it.
///
/// Token identifiers are the original UTF-8 octets. This implementation is
/// exact and reversible for its own stable algorithm revision, but must never
/// be advertised for a model using a different tokenizer.
#[derive(Clone, Debug)]
pub struct Utf8ByteTokenizer {
	identity:   RouteIdentity,
	provenance: TokenizerProvenance,
}

impl Utf8ByteTokenizer {
	/// Constructs the pinned byte tokenizer with an immutable catalog revision.
	pub fn new(identity: RouteIdentity, revision: Str) -> Result<Self, Error> {
		let provenance =
			TokenizerProvenance { tokenizer: sf!("omp/utf8-bytes"), revision, exact: true };
		validate_provenance(&provenance)?;
		Ok(Self { identity, provenance })
	}

	/// Tokenizes exact UTF-8 bytes without recognizing any special vocabulary.
	pub fn tokenize(&self, request: &TokenizeRequest) -> Result<TokenSequence, Error> {
		if request.allow_special {
			return Err(capability_error("utf8_byte_tokenizer_has_no_special_tokens"));
		}
		Ok(TokenSequence {
			tokens:     request
				.text
				.as_bytes()
				.iter()
				.map(|byte| u32::from(*byte))
				.collect(),
			provenance: self.provenance.clone(),
		})
	}

	/// Reconstructs UTF-8 and rejects invalid identifiers or invalid byte
	/// sequences.
	pub fn detokenize(&self, request: &DetokenizeRequest) -> Result<DetokenizedText, Error> {
		let mut bytes = Vec::with_capacity(request.tokens.len());
		for token in request.tokens.iter().copied() {
			let byte = u8::try_from(token)
				.map_err(|_| request_error("tokenization.tokens", "token_id_out_of_range"))?;
			bytes.push(byte);
		}
		let mut input = Cursor::new(bytes.as_slice());
		if input.chars().any(|character| character.is_err()) {
			return Err(request_error("tokenization.tokens", "tokens_are_not_utf8"));
		}
		// SAFETY: xutf validated every code point in the complete byte slice above.
		let text = unsafe { Str::from_utf8_unchecked(&bytes) };
		Ok(DetokenizedText { text, provenance: self.provenance.clone() })
	}
}

impl Service<OperationRequest<TokenizeRequest>> for Utf8ByteTokenizer {
	type Error = Error;
	type Future = Ready<Result<Self::Response, Self::Error>>;
	type Response = OperationResponse<TokenSequence>;

	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, request: OperationRequest<TokenizeRequest>) -> Self::Future {
		ready(
			self
				.tokenize(&request.payload)
				.map(|output| OperationResponse {
					meta: self.identity.response_meta(request.id),
					receipt: ExecutionReceipt::default(),
					output,
				}),
		)
	}
}

impl Service<OperationRequest<DetokenizeRequest>> for Utf8ByteTokenizer {
	type Error = Error;
	type Future = Ready<Result<Self::Response, Self::Error>>;
	type Response = OperationResponse<DetokenizedText>;

	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, request: OperationRequest<DetokenizeRequest>) -> Self::Future {
		ready(
			self
				.detokenize(&request.payload)
				.map(|output| OperationResponse {
					meta: self.identity.response_meta(request.id),
					receipt: ExecutionReceipt::default(),
					output,
				}),
		)
	}
}

/// Deterministic, explicitly estimated token counter usable as an emulated
/// route service.
#[derive(Clone, Debug)]
pub struct EstimatedTokenCounter {
	identity:        RouteIdentity,
	provenance:      TokenizerProvenance,
	bytes_per_token: NonZeroU32,
}

impl EstimatedTokenCounter {
	/// Constructs an estimator with a stable algorithm identity and revision.
	pub fn new(
		identity: RouteIdentity,
		algorithm: Str,
		revision: Str,
		bytes_per_token: NonZeroU32,
	) -> Result<Self, Error> {
		let provenance = TokenizerProvenance { tokenizer: algorithm, revision, exact: false };
		validate_provenance(&provenance)?;
		Ok(Self { identity, provenance, bytes_per_token })
	}

	/// Estimates canonical prompt framing and payload bytes without claiming
	/// exactness.
	pub fn estimate(&self, request: &CountTokensRequest) -> Result<TokenCount, Error> {
		let mut bytes = 3_u64;
		for message in request.messages.iter() {
			bytes = bytes.saturating_add(3);
			bytes = bytes.saturating_add(message.name.as_ref().map_or(0, |name| name.len() as u64));
			for part in message.content.iter() {
				bytes = bytes.saturating_add(content_bytes(part)?);
			}
		}
		for tool in request.tools.iter() {
			bytes = bytes.saturating_add(12 + tool.name.len() as u64);
			bytes = bytes.saturating_add(
				tool
					.description
					.as_ref()
					.map_or(0, |description| description.len() as u64),
			);
			bytes = bytes.saturating_add(if let Some((parameters, _)) = tool.input.json_schema() {
				serialized_len(parameters.as_value())?
			} else {
				tool
					.input
					.grammar()
					.map_or(0, |grammar| grammar.definition.len() as u64)
			});
		}
		let divisor = u64::from(self.bytes_per_token.get());
		let tokens = bytes.saturating_add(divisor - 1) / divisor;
		Ok(TokenCount { tokens, provenance: self.provenance.clone() })
	}
}

impl Service<OperationRequest<CountTokensRequest>> for EstimatedTokenCounter {
	type Error = Error;
	type Future = Ready<Result<Self::Response, Self::Error>>;
	type Response = OperationResponse<TokenCount>;

	fn poll_ready(&mut self, _context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		Poll::Ready(Ok(()))
	}

	fn call(&mut self, request: OperationRequest<CountTokensRequest>) -> Self::Future {
		let result = if request.payload.accuracy == CountAccuracy::Exact {
			Err(capability_error("exact_token_count_required"))
		} else {
			self
				.estimate(&request.payload)
				.map(|output| OperationResponse {
					meta: self.identity.response_meta(request.id),
					receipt: ExecutionReceipt::default(),
					output,
				})
		};
		ready(result)
	}
}

fn content_bytes(part: &ContentPart) -> Result<u64, Error> {
	match part {
		ContentPart::Text { text, .. } | ContentPart::Reasoning { text, .. } => Ok(text.len() as u64),
		ContentPart::Image(media) | ContentPart::Audio(media) | ContentPart::Document(media) => {
			Ok(media_bytes(media))
		},
		ContentPart::ToolCall { name, arguments, .. } => {
			Ok(name.len() as u64 + serialized_len(arguments.as_value())?)
		},
		ContentPart::ToolResult { name, content, .. } => {
			let mut bytes = name.as_ref().map_or(0, |name| name.len() as u64);
			for item in content.iter() {
				bytes = bytes.saturating_add(match item {
					ToolResultContent::Text(text) => text.len() as u64,
					ToolResultContent::Json(json) => serialized_len(json.as_value())?,
					ToolResultContent::Image(media) | ToolResultContent::Document(media) => {
						media_bytes(media)
					},
				});
			}
			Ok(bytes)
		},
		ContentPart::CachePoint(_) => Ok(1),
	}
}

fn media_bytes(media: &MediaInput) -> u64 {
	match media {
		MediaInput::Bytes { data, .. } => data.len() as u64,
		MediaInput::Stored(reference) => {
			(reference.store.len() + reference.id.len() + reference.revision.len()) as u64
		},
		MediaInput::Remote { uri, .. } => uri.len() as u64,
		MediaInput::Body { .. } => 85,
	}
}

fn serialized_len(value: &serde_json::Value) -> Result<u64, Error> {
	serde_json::to_vec(value)
		.map(|bytes| bytes.len() as u64)
		.map_err(|_| protocol_error("opaque_json_serialization_failed"))
}

fn wrong_operation(call: &Call, expected: OperationKind) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Internal,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(
		Str::new(expected.to_string()),
		ReasonId(sf!("operation_service_mismatch")),
	))
	.request_id(call.id.clone())
}

fn request_error(feature: &'static str, reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::InvalidRequest,
		ErrorDetail::capability(Str::new(feature), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn capability_error(reason: &'static str) -> Error {
	Error::planning(
		ErrorKind::CapabilityMismatch,
		ErrorDetail::capability(sf!("tokenization"), ReasonId(Str::new(reason))),
		ExecutionReceipt::default(),
	)
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Recovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::{num::NonZeroU32, sync::Arc};

	use super::{EstimatedTokenCounter, Utf8ByteTokenizer};
	use crate::{
		call::{CountAccuracy, CountTokensRequest, DetokenizeRequest, TokenizeRequest},
		catalog::{ModelKey, ProviderId, RouteId},
		operation::RouteIdentity,
	};

	#[test]
	fn estimator_is_constructible_and_never_claims_exact_provenance() {
		let estimator = EstimatedTokenCounter::new(
			RouteIdentity {
				provider: ProviderId::from("local"),
				route:    RouteId::from("estimate"),
				model:    ModelKey::from("estimate"),
			},
			"canonical-bytes".into(),
			"1".into(),
			NonZeroU32::new(4).expect("non-zero"),
		)
		.expect("valid estimator");
		let count = estimator
			.estimate(&CountTokensRequest {
				messages: Arc::new([]),
				tools:    Arc::new([]),
				accuracy: CountAccuracy::AllowEstimate,
			})
			.expect("estimate");
		assert_eq!(count.tokens, 1);
		assert!(!count.provenance.exact);
		assert_eq!(count.provenance.revision.as_str(), "1");
	}

	#[test]
	fn pinned_utf8_tokenizer_round_trips_revision_and_rejects_invalid_ids() {
		let tokenizer = Utf8ByteTokenizer::new(
			RouteIdentity {
				provider: ProviderId::from("local"),
				route:    RouteId::from("utf8"),
				model:    ModelKey::from("utf8"),
			},
			"sha256:fixture".into(),
		)
		.expect("pinned tokenizer");
		let tokens = tokenizer
			.tokenize(&TokenizeRequest { text: "Zürich".into(), allow_special: false })
			.expect("tokenize");
		let text = tokenizer
			.detokenize(&DetokenizeRequest { tokens: Arc::from(tokens.tokens), strict: true })
			.expect("detokenize");
		assert_eq!(text.text.as_str(), "Zürich");
		assert!(text.provenance.exact);
		assert_eq!(text.provenance.revision.as_str(), "sha256:fixture");
		assert!(
			tokenizer
				.detokenize(&DetokenizeRequest { tokens: Arc::new([256]), strict: true })
				.is_err()
		);
	}
}
