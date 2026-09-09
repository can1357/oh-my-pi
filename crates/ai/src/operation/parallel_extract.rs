//! Parallel `/v1beta/extract` request and response projection.

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
	answer::AnswerBody,
	body::BodySource,
	call::OperationCall,
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawEvent,
		RequestHeader, RequestMethod, SizeBounds, openai_chat,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId},
	transport::{Frame, FramingProtocol},
};

/// Maximum URLs accepted by one extraction request.
pub const MAX_URLS: usize = 20;
/// Parallel extract beta resource.
pub const EXTRACT_PATH: &str = "/v1beta/extract";
/// Stable catalog codec identifier for Parallel extraction.
pub const CODEC_ID: &str = "parallel-extract";
/// Maximum encoded extraction request.
pub const MAX_REQUEST_BYTES: u64 = 256 * 1024;
/// Maximum extraction response.
pub const MAX_RESPONSE_BYTES: u64 = 8 * 1024 * 1024;

/// Bounded extraction request.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ParallelExtractRequest {
	/// Absolute URLs to extract.
	pub urls:           Box<[Str]>,
	/// Optional extraction objective.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub objective:      Option<Str>,
	/// Queries used to focus excerpts.
	#[serde(skip_serializing_if = "<[omp_core::Str]>::is_empty")]
	pub search_queries: Box<[Str]>,
	/// Request relevant excerpts.
	pub excerpts:       bool,
	/// Request complete page content.
	pub full_content:   bool,
}

impl ParallelExtractRequest {
	/// Validates API hard bounds and URL syntax.
	pub fn validate(&self) -> Result<(), ParallelExtractError> {
		if self.urls.is_empty() || self.urls.len() > MAX_URLS {
			return Err(ParallelExtractError::InvalidUrlCount);
		}
		if self
			.urls
			.iter()
			.any(|url| Url::parse(url.as_str()).is_err())
		{
			return Err(ParallelExtractError::InvalidUrl);
		}
		Ok(())
	}
}

/// One successfully extracted document.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub struct ParallelExtractDocument {
	/// Canonical document URL.
	pub url:            Str,
	/// Provider title.
	#[serde(default)]
	pub title:          Option<Str>,
	/// Provider publication date.
	#[serde(default, rename = "publish_date")]
	pub published_date: Option<Str>,
	/// Focused excerpts.
	#[serde(default)]
	pub excerpts:       Box<[Str]>,
	/// Complete extracted content when requested.
	#[serde(default)]
	pub full_content:   Option<Str>,
}

impl ParallelExtractDocument {
	/// Returns excerpts joined with blank lines, then full content as fallback.
	pub fn content(&self) -> Str {
		let nonempty = self
			.excerpts
			.iter()
			.filter(|excerpt| !excerpt.trim().is_empty())
			.map(Str::as_str)
			.collect::<Vec<_>>();
		if nonempty.is_empty() {
			self.full_content.clone().unwrap_or_default()
		} else {
			Str::new(nonempty.join("\n\n"))
		}
	}
}

/// Per-URL extraction failure retained beside successful documents.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub struct ParallelExtractFailure {
	/// Failed URL.
	pub url:              Str,
	/// Provider error classification.
	#[serde(default)]
	pub error_type:       Option<Str>,
	/// Origin HTTP status, when known.
	#[serde(default)]
	pub http_status_code: Option<u16>,
	/// Bounded provider detail.
	#[serde(default)]
	pub content:          Option<Str>,
}

/// One provider usage counter.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub struct ParallelExtractUsage {
	/// Counter name.
	pub name:  Str,
	/// Counter value.
	pub count: u64,
}

/// Lossless Parallel extract result.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize)]
pub struct ParallelExtractResult {
	/// Provider request identity.
	#[serde(default, rename = "extract_id")]
	pub request_id: Str,
	/// Successful documents.
	#[serde(default)]
	pub results:    Box<[ParallelExtractDocument]>,
	/// URL-specific errors.
	#[serde(default)]
	pub errors:     Box<[ParallelExtractFailure]>,
	/// Provider warnings.
	#[serde(default)]
	pub warnings:   Box<[Str]>,
	/// Provider usage counters.
	#[serde(default)]
	pub usage:      Box<[ParallelExtractUsage]>,
}

/// Invalid extraction request or response.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ParallelExtractError {
	/// URL count is outside the API contract.
	#[error("Parallel extract requires between one and twenty URLs")]
	InvalidUrlCount,
	/// A request URL is not absolute and valid.
	#[error("Parallel extract URL is invalid")]
	InvalidUrl,
	/// Provider response is not valid extract JSON.
	#[error("Parallel extract response is malformed")]
	MalformedResponse,
}

/// Parses the bounded JSON response while retaining partial failures.
pub fn decode_parallel_extract(
	bytes: &[u8],
) -> Result<ParallelExtractResult, ParallelExtractError> {
	serde_json::from_slice(bytes).map_err(|_| ParallelExtractError::MalformedResponse)
}
/// Parallel `/v1beta/extract` request/response codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct ParallelExtractCodec;

impl ParallelExtractCodec {
	/// Returns the stable catalog codec identifier.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}

impl Codec for ParallelExtractCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::ParallelExtract(request) = operation else {
			return Err(codec_error("parallel_extract_operation_required"));
		};
		request
			.validate()
			.map_err(|_| encoding_error("parallel_extract_request_invalid"))?;
		let body = serde_json::to_vec(request.as_ref())
			.map_err(|_| encoding_error("parallel_extract_request_serialization_failed"))?;
		if body.len() as u64 > MAX_REQUEST_BYTES {
			return Err(encoding_error("parallel_extract_request_too_large"));
		}
		Ok(EncodedRequest::new(
			OperationKind::Extract,
			RequestMethod::Post,
			openai_chat::join_uri(context.route.endpoint.base_url.as_str(), EXTRACT_PATH),
			Box::new([
				RequestHeader { name: sf!("accept"), value: sf!("application/json") },
				RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
			]),
			BodySource::Bytes(Bytes::from(body)),
			FramingProtocol::Raw,
			SizeBounds {
				request_body: MAX_REQUEST_BYTES,
				frame:        MAX_RESPONSE_BYTES,
				response:     MAX_RESPONSE_BYTES,
			},
		))
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if context.operation != OperationKind::Extract
			|| !matches!(context.operation_call, OperationCall::ParallelExtract(_))
			|| context.framing != FramingProtocol::Raw
		{
			return Err(codec_error("parallel_extract_decode_context_mismatch"));
		}
		Ok(Box::new(ParallelExtractDecoder { bytes: BytesMut::new(), finished: false }))
	}
}

struct ParallelExtractDecoder {
	bytes:    BytesMut,
	finished: bool,
}

impl Decoder for ParallelExtractDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("parallel_extract_unexpected_frame"));
		};
		if self.finished || self.bytes.len().saturating_add(bytes.len()) > MAX_RESPONSE_BYTES as usize
		{
			return Err(protocol_error("parallel_extract_response_too_large_or_finished"));
		}
		self.bytes.extend_from_slice(&bytes);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		let result = decode_parallel_extract(&self.bytes)
			.map_err(|_| protocol_error("parallel_extract_response_malformed"))?;
		emit(RawEvent::Answer(AnswerBody::ParallelExtract(result)));
		Ok(())
	}
}

fn codec_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::CodecMismatch,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

fn encoding_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Streaming,
		RetryAction::ReselectRoute,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}
