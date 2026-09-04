//! Exa standalone Search API wire codec.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, format_rfc3339, parse_rfc3339, sf};
use serde::{Deserialize, Serialize};
use url::Url;

use super::{
	Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawEvent,
	RequestHeader, RequestMethod, SizeBounds,
};
use crate::{
	answer::{AnswerBody, SearchResult, SearchResults},
	body::BodySource,
	call::{OperationCall, SearchRecency, SearchRequest},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	id::RequestId,
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

/// Stable catalog identifier for the Exa Search codec.
pub const CODEC_ID: &str = "search-exa";

const SEARCH_PATH: &str = "/search";
/// Maximum encoded Exa request body size.
pub const MAX_REQUEST_BYTES: u64 = 256 * 1024;
/// Maximum Exa response body size.
pub const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

/// Sans-I/O codec for Exa's standalone `POST /search` protocol.
#[derive(Clone, Copy, Debug, Default)]
pub struct ExaSearchCodec;

impl ExaSearchCodec {
	/// Creates an Exa Search codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns the stable catalog identifier for this codec.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExaSearchRequest<'a> {
	query:                &'a str,
	num_results:          u32,
	contents:             ExaContents,
	#[serde(skip_serializing_if = "slice_is_empty")]
	include_domains:      &'a [Str],
	#[serde(skip_serializing_if = "slice_is_empty")]
	exclude_domains:      &'a [Str],
	#[serde(skip_serializing_if = "Option::is_none")]
	start_published_date: Option<String>,
}

#[derive(Serialize)]
struct ExaContents {
	text: bool,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ExaResponse {
	ApiError(ExaApiErrorResponse),
	Search(ExaSearchResponse),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExaSearchResponse {
	results: Vec<ExaResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExaResult {
	title:          Str,
	url:            Str,
	#[serde(default)]
	text:           Option<Str>,
	#[serde(default)]
	highlights:     Vec<Str>,
	#[serde(default)]
	score:          Option<f32>,
	#[serde(default)]
	published_date: Option<Str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExaApiErrorResponse {
	error:       ExaApiErrorBody,
	#[serde(default, alias = "status")]
	status_code: Option<u16>,
	#[serde(default)]
	code:        Option<Str>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ExaApiErrorBody {
	Message(Str),
	Detail(ExaApiErrorDetail),
}

#[derive(Deserialize)]
struct ExaApiErrorDetail {
	#[serde(default)]
	message:     Option<Str>,
	#[serde(default)]
	code:        Option<Str>,
	#[serde(default, rename = "statusCode", alias = "status")]
	status_code: Option<u16>,
}

impl Codec for ExaSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return Err(protocol_error(
				ErrorKind::CodecMismatch,
				ErrorPhase::Encoding,
				"exa.operation_not_search",
			));
		};
		let body = encode_request_at(request, SystemTime::now())?;
		if body.len() as u64 > MAX_REQUEST_BYTES {
			return Err(protocol_error(
				ErrorKind::InvalidRequest,
				ErrorPhase::Encoding,
				"exa.request_too_large",
			));
		}
		Ok(EncodedRequest::new(
			OperationKind::Search,
			RequestMethod::Post,
			search_uri(context.route.endpoint.base_url.as_str())?,
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
		if context.operation != OperationKind::Search || context.framing != FramingProtocol::Raw {
			return Err(protocol_error(
				ErrorKind::CodecMismatch,
				ErrorPhase::Streaming,
				"exa.decoder_contract_mismatch",
			));
		}
		Ok(Box::new(ExaDecoder {
			bytes:      BytesMut::new(),
			finished:   false,
			provider:   context.provider.to_owned(),
			route:      context.route.to_owned(),
			request_id: context.request_id.to_owned(),
		}))
	}
}

struct ExaDecoder {
	bytes:      BytesMut,
	finished:   bool,
	provider:   omp_catalog::ProviderId,
	route:      omp_catalog::RouteId,
	request_id: RequestId,
}

impl Decoder for ExaDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Err(self.error(
				ErrorKind::Protocol,
				RetryAction::Never,
				None,
				"exa.frame_after_finish",
			));
		}
		let Frame::Raw(bytes) = frame else {
			return Err(self.error(
				ErrorKind::Protocol,
				RetryAction::Never,
				None,
				"exa.unexpected_frame",
			));
		};
		let observed = self.bytes.len().saturating_add(bytes.len());
		if observed as u64 > MAX_RESPONSE_BYTES {
			self.bytes.clear();
			self.finished = true;
			return Err(self.error(
				ErrorKind::Protocol,
				RetryAction::Never,
				None,
				"exa.response_too_large",
			));
		}
		self.bytes.extend_from_slice(&bytes);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		if self.bytes.is_empty() {
			return Err(self.error(
				ErrorKind::Protocol,
				RetryAction::Never,
				None,
				"exa.empty_response",
			));
		}
		let bytes = self.bytes.split().freeze();
		let response: ExaResponse = serde_json::from_slice(&bytes).map_err(|_| {
			self.error(ErrorKind::Protocol, RetryAction::Never, None, "exa.malformed_response")
		})?;
		match response {
			ExaResponse::Search(response) => {
				let results = response
					.results
					.into_iter()
					.enumerate()
					.map(|(index, result)| SearchResult {
						rank:         u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1),
						url:          result.url,
						title:        result.title,
						snippet:      snippet(result.highlights, result.text),
						score:        result.score.filter(|score| score.is_finite()),
						published_at: result.published_date.as_deref().and_then(parse_rfc3339),
						author:       None,
					})
					.collect();
				emit(RawEvent::Answer(AnswerBody::Search(SearchResults {
					results,
					answer: None,
					usage: Usage { search_calls: 1, source: UsageSource::Provider, ..Usage::default() },
					metadata: Default::default(),
				})));
			},
			ExaResponse::ApiError(error) => emit(RawEvent::Failure(self.api_error(error))),
		}
		Ok(())
	}
}

impl ExaDecoder {
	fn api_error(&self, error: ExaApiErrorResponse) -> Error {
		let (nested_status, nested_code) = match error.error {
			ExaApiErrorBody::Message(message) => {
				let _ = message;
				(None, None)
			},
			ExaApiErrorBody::Detail(detail) => {
				let _ = detail.message;
				(detail.status_code, detail.code)
			},
		};
		let status = error.status_code.or(nested_status);
		let supplied_code = error.code.or(nested_code);
		let _ = supplied_code;
		let (kind, action, code) = match status {
			Some(401) => {
				(ErrorKind::Authentication, RetryAction::RefreshCredential, "authentication_rejected")
			},
			Some(403) => (ErrorKind::Authorization, RetryAction::Never, "permission_denied"),
			Some(402) => (ErrorKind::PaymentRequired, RetryAction::Never, "payment_required"),
			Some(429) => (
				ErrorKind::RateLimited,
				RetryAction::SameRoute { after: Duration::from_secs(1) },
				"rate_limited",
			),
			Some(400 | 404 | 409 | 422) => {
				(ErrorKind::InvalidRequest, RetryAction::Never, "invalid_request")
			},
			Some(500..=599) => (
				ErrorKind::Protocol,
				RetryAction::SameRoute { after: Duration::ZERO },
				"provider_error",
			),
			_ => (ErrorKind::Protocol, RetryAction::Never, "api_error"),
		};
		self
			.error(kind, action, status, "exa.api_error")
			.code(sf!(code))
			.detail(ErrorDetail::provider(sf!("Exa Search request failed")))
	}

	fn error(
		&self,
		kind: ErrorKind,
		action: RetryAction,
		status: Option<u16>,
		reason: &'static str,
	) -> Error {
		Error::new(kind, ErrorPhase::Streaming, action, ExecutionReceipt::default())
			.provider(self.provider.clone())
			.route(self.route.clone())
			.request_id(self.request_id.clone())
			.status(status)
			.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
	}
}

fn encode_request_at(request: &SearchRequest, now: SystemTime) -> Result<Vec<u8>, Error> {
	let start_published_date = request.recency.map(|recency| {
		let seconds = u64::from(recency_days(recency)).saturating_mul(86_400);
		format_rfc3339(
			now.checked_sub(Duration::from_secs(seconds))
				.unwrap_or(UNIX_EPOCH),
		)
	});
	serde_json::to_vec(&ExaSearchRequest {
		query: request.query.as_str(),
		num_results: request.max_results,
		contents: ExaContents { text: true },
		include_domains: &request.include_domains,
		exclude_domains: &request.exclude_domains,
		start_published_date,
	})
	.map_err(|_| {
		protocol_error(ErrorKind::InvalidRequest, ErrorPhase::Encoding, "exa.request_serialization")
	})
}

const fn recency_days(recency: SearchRecency) -> u32 {
	match recency {
		SearchRecency::Day => 1,
		SearchRecency::Week => 7,
		SearchRecency::Month => 30,
		SearchRecency::Year => 365,
		SearchRecency::Days(days) => days,
	}
}

const fn slice_is_empty(slice: &&[Str]) -> bool {
	slice.is_empty()
}

fn search_uri(base: &str) -> Result<Str, Error> {
	let mut url = Url::parse(base).map_err(|_| {
		protocol_error(ErrorKind::InvalidRequest, ErrorPhase::Encoding, "exa.base_url_invalid")
	})?;
	if url.cannot_be_a_base() || url.query().is_some() || url.fragment().is_some() {
		return Err(protocol_error(
			ErrorKind::InvalidRequest,
			ErrorPhase::Encoding,
			"exa.base_url_invalid",
		));
	}
	let mut path = url.path().trim_end_matches('/').to_owned();
	if !path.ends_with(SEARCH_PATH) {
		path.push_str(SEARCH_PATH);
	}
	url.set_path(&path);
	Ok(Str::new(&url))
}

fn snippet(highlights: Vec<Str>, text: Option<Str>) -> Option<Str> {
	highlights
		.into_iter()
		.find(|value| !value.trim().is_empty())
		.or_else(|| text.filter(|value| !value.trim().is_empty()))
}

fn protocol_error(kind: ErrorKind, phase: ErrorPhase, reason: &'static str) -> Error {
	Error::new(kind, phase, RetryAction::Never, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, time::Duration};

	use omp_catalog::{ProviderId, RouteId};

	use super::*;
	use crate::{
		call::{NegotiationPolicy, Setting},
		id::RequestId,
	};

	fn request() -> SearchRequest {
		SearchRequest {
			query: sf!("rust inference"),
			include_domains: Arc::from([sf!("docs.rs"), sf!("rust-lang.org/book")]),
			exclude_domains: Arc::from([sf!("spam.example")]),
			recency: Some(SearchRecency::Week),
			locale: None,
			max_results: 7,
			synthesize_answer: Setting::Unset,
			negotiation: NegotiationPolicy::default(),
			..SearchRequest::new(sf!("rust inference"), 7)
		}
	}

	fn decoder() -> ExaDecoder {
		ExaDecoder {
			bytes:      BytesMut::new(),
			finished:   false,
			provider:   ProviderId::from("exa"),
			route:      RouteId::from("exa-search"),
			request_id: RequestId::from("request-1"),
		}
	}

	#[test]
	fn exact_request_projects_domains_recency_and_limit_without_locale() {
		let now = UNIX_EPOCH + Duration::from_days(19_723); // 2024-01-01T00:00:00Z
		let body = encode_request_at(&request(), now).expect("encode");
		assert_eq!(
			std::str::from_utf8(&body).expect("utf8"),
			r#"{"query":"rust inference","numResults":7,"contents":{"text":true},"includeDomains":["docs.rs","rust-lang.org/book"],"excludeDomains":["spam.example"],"startPublishedDate":"2023-12-25T00:00:00Z"}"#
		);
		assert!(!body.windows(6).any(|window| window == b"locale"));
		assert_eq!(search_uri("https://api.exa.ai/").expect("uri"), sf!("https://api.exa.ai/search"));
		assert_eq!(
			search_uri("https://api.exa.ai/search/").expect("uri"),
			sf!("https://api.exa.ai/search")
		);
	}

	#[test]
	fn typed_response_preserves_order_score_date_and_conservative_snippet() {
		let fixture = br#"{"requestId":"req","results":[{"title":"First","url":"https://one.example","text":"full first text","highlights":["best first passage","second"],"score":0.91,"publishedDate":"2023-11-16T01:36:32.547Z"},{"title":"Second","url":"https://two.example","text":"fallback text","highlights":[],"score":0.4,"publishedDate":"not-a-date"}]}"#;
		let mut decoder = decoder();
		let split = fixture.len() / 2;
		decoder
			.push(Frame::Raw(Bytes::copy_from_slice(&fixture[..split])), &mut |_| {})
			.expect("first fragment");
		decoder
			.push(Frame::Raw(Bytes::copy_from_slice(&fixture[split..])), &mut |_| {})
			.expect("second fragment");
		let mut events = Vec::new();
		decoder
			.finish(&mut |event| events.push(event))
			.expect("finish");
		let RawEvent::Answer(AnswerBody::Search(answer)) = events.pop().expect("answer") else {
			panic!("wrong event")
		};
		assert_eq!(answer.results.len(), 2);
		assert_eq!(answer.results[0].rank, 1);
		assert_eq!(answer.results[0].title.as_str(), "First");
		assert_eq!(answer.results[0].snippet.as_deref(), Some("best first passage"));
		assert_eq!(answer.results[0].score, Some(0.91));
		assert_eq!(answer.results[0].published_at, parse_rfc3339("2023-11-16T01:36:32.547Z"));
		assert_eq!(answer.results[1].rank, 2);
		assert_eq!(answer.results[1].snippet.as_deref(), Some("fallback text"));
		assert_eq!(answer.results[1].published_at, None);
		assert_eq!(answer.usage.search_calls, 1);
		assert_eq!(answer.usage.source, UsageSource::Provider);
	}

	#[test]
	fn malformed_and_oversize_responses_are_typed() {
		let mut malformed = decoder();
		malformed
			.push(Frame::Raw(Bytes::from_static(b"{bad")), &mut |_| {})
			.expect("buffer");
		let error = malformed.finish(&mut |_| {}).expect_err("malformed");
		assert_eq!(error.kind, ErrorKind::Protocol);
		assert_eq!(error.provider.as_deref().map(ProviderId::as_str), Some("exa"));

		let mut oversize = decoder();
		let error = oversize
			.push(Frame::Raw(Bytes::from(vec![b'x'; MAX_RESPONSE_BYTES as usize + 1])), &mut |_| {})
			.expect_err("oversize");
		assert_eq!(error.kind, ErrorKind::Protocol);
	}

	#[test]
	fn provider_error_uses_typed_status_and_never_retains_provider_text() {
		let secret = "sk-exa-super-secret";
		let fixture = format!(
			r#"{{"error":{{"message":"credential {secret}","code":"{secret}","statusCode":429}}}}"#
		);
		let mut decoder = decoder();
		decoder
			.push(Frame::Raw(Bytes::from(fixture)), &mut |_| {})
			.expect("buffer");
		let mut events = Vec::new();
		decoder
			.finish(&mut |event| events.push(event))
			.expect("finish");
		let RawEvent::Failure(error) = events.pop().expect("failure") else {
			panic!("wrong event")
		};
		assert_eq!(error.kind, ErrorKind::RateLimited);
		assert_eq!(error.status, Some(429));
		assert_eq!(error.code.as_deref(), Some("rate_limited"));
		assert!(!format!("{error:?}").contains(secret));
	}
}
