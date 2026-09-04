//! Perplexity Sonar standalone-search wire codec.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};
use url::Url;

use crate::{
	answer::{AnswerBody, SearchResult, SearchResults},
	body::BodySource,
	call::{OperationCall, SearchRecency, SearchRequest, Setting},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawEvent,
		RequestHeader, RequestMethod, SizeBounds,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

/// Stable catalog identifier for the Perplexity Sonar search codec.
pub const CODEC_ID: &str = "search-perplexity";
/// Perplexity's legacy-compatible Sonar chat-completions path.
pub const CHAT_COMPLETIONS_PATH: &str = "/chat/completions";
/// Maximum encoded request body accepted by this codec.
pub const MAX_REQUEST_BYTES: u64 = 2 * 1024 * 1024;
/// Maximum unary response accepted from Perplexity.
pub const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

/// Stateless, secret-free codec for Perplexity Sonar standalone search.
#[derive(Clone, Copy, Debug, Default)]
pub struct PerplexitySearchCodec;

impl PerplexitySearchCodec {
	/// Constructs the Perplexity Sonar standalone-search codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns the stable catalog identifier for this codec.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}

impl Codec for PerplexitySearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return Err(codec_error("perplexity_search_operation_required"));
		};
		let model = if context.route.provider.as_str() == "perplexity-openrouter" {
			"perplexity/sonar"
		} else {
			"sonar"
		};
		let body = serde_json::to_vec(&PerplexityRequest::from_search(request, model)?)
			.map_err(|_| encoding_error("perplexity_search_request_serialization_failed"))?;
		if body.len() as u64 > MAX_REQUEST_BYTES {
			return Err(encoding_error("perplexity_search_request_too_large"));
		}
		Ok(EncodedRequest::new(
			OperationKind::Search,
			RequestMethod::Post,
			join_uri(context.route.endpoint.base_url.as_str(), CHAT_COMPLETIONS_PATH)?,
			vec![
				RequestHeader { name: sf!("accept"), value: sf!("application/json") },
				RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
			]
			.into_boxed_slice(),
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
		let OperationCall::Search(request) = context.operation_call else {
			return Err(codec_error("perplexity_search_decode_operation_required"));
		};
		if context.operation != OperationKind::Search
			|| context.operation != context.operation_call.kind()
			|| context.framing != FramingProtocol::Raw
		{
			return Err(codec_error("perplexity_search_decode_context_mismatch"));
		}
		Ok(Box::new(PerplexitySearchDecoder::new(request)))
	}
}

#[derive(Debug, Serialize)]
struct PerplexityRequest<'a> {
	model:                  &'a str,
	messages:               [PerplexityMessage<'a>; 1],
	#[serde(skip_serializing_if = "Option::is_none")]
	search_domain_filter:   Option<Vec<String>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	search_recency_filter:  Option<&'static str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	search_language_filter: Option<[String; 1]>,
}

#[derive(Debug, Serialize)]
struct PerplexityMessage<'a> {
	role:    &'static str,
	content: &'a str,
}

impl<'a> PerplexityRequest<'a> {
	fn from_search(request: &'a SearchRequest, model: &'a str) -> Result<Self, Error> {
		let mut domains = Vec::with_capacity(
			request
				.include_domains
				.len()
				.saturating_add(request.exclude_domains.len()),
		);
		domains.extend(request.include_domains.iter().map(ToString::to_string));
		domains.extend(
			request
				.exclude_domains
				.iter()
				.map(|domain| format!("-{domain}")),
		);
		if domains.len() > 20 {
			return Err(encoding_error("perplexity_search_domain_filter_too_large"));
		}
		let search_domain_filter = (!domains.is_empty()).then_some(domains);
		let search_recency_filter = request.recency.map(perplexity_recency).transpose()?;
		let search_language_filter = request
			.locale
			.as_deref()
			.map(perplexity_language)
			.transpose()?
			.map(|language| [language]);
		Ok(Self {
			model,
			messages: [PerplexityMessage { role: "user", content: request.query.as_str() }],
			search_domain_filter,
			search_recency_filter,
			search_language_filter,
		})
	}
}

fn perplexity_recency(recency: SearchRecency) -> Result<&'static str, Error> {
	match recency {
		SearchRecency::Day | SearchRecency::Days(1) => Ok("day"),
		SearchRecency::Week | SearchRecency::Days(7) => Ok("week"),
		SearchRecency::Month | SearchRecency::Days(30) => Ok("month"),
		SearchRecency::Year | SearchRecency::Days(365) => Ok("year"),
		SearchRecency::Days(_) => Err(encoding_error("perplexity_search_recency_days_unsupported")),
	}
}

fn perplexity_language(locale: &str) -> Result<String, Error> {
	let language = locale.split(['-', '_']).next().unwrap_or_default();
	if language.len() == 2 && language.bytes().all(|byte| byte.is_ascii_alphabetic()) {
		Ok(language.to_ascii_lowercase())
	} else {
		Err(encoding_error("perplexity_search_locale_not_iso_639_1"))
	}
}

fn join_uri(base: &str, path: &str) -> Result<Str, Error> {
	let base = Url::parse(base).map_err(|_| encoding_error("perplexity_search_base_url_invalid"))?;
	let joined = base
		.join(path)
		.map_err(|_| encoding_error("perplexity_search_endpoint_join_failed"))?;
	Ok(Str::new(&joined))
}

/// Bounded unary decoder for one Perplexity Sonar response.
#[derive(Debug)]
pub struct PerplexitySearchDecoder {
	bytes:          BytesMut,
	finished:       bool,
	max_results:    usize,
	require_answer: bool,
	strip_answer:   bool,
}

impl PerplexitySearchDecoder {
	/// Constructs a fresh unary decoder for one canonical search request.
	pub fn new(request: &SearchRequest) -> Self {
		Self {
			bytes:          BytesMut::new(),
			finished:       false,
			max_results:    request.max_results as usize,
			require_answer: matches!(request.synthesize_answer, Setting::Require(true)),
			strip_answer:   matches!(
				request.synthesize_answer,
				Setting::Require(false) | Setting::Prefer(false)
			),
		}
	}
}
impl Decoder for PerplexitySearchDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Err(protocol_error("perplexity_search_frame_after_finish"));
		}
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("perplexity_search_unexpected_frame"));
		};
		let observed = self.bytes.len().saturating_add(bytes.len());
		if observed as u64 > MAX_RESPONSE_BYTES {
			self.bytes.clear();
			self.finished = true;
			return Err(protocol_error("perplexity_search_response_too_large"));
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
			return Err(protocol_error("perplexity_search_response_missing"));
		}
		let bytes = self.bytes.split().freeze();
		let response: PerplexityEnvelope = serde_json::from_slice(&bytes)
			.map_err(|_| protocol_error("perplexity_search_response_malformed"))?;
		match response {
			PerplexityEnvelope::Success(response) => {
				emit(RawEvent::Answer(AnswerBody::Search(response.canonical(
					self.max_results,
					self.require_answer,
					self.strip_answer,
				)?)));
			},
			PerplexityEnvelope::ApiError(error) => {
				emit(RawEvent::Failure(provider_error(error.error)));
			},
			PerplexityEnvelope::ValidationError(error) => {
				emit(RawEvent::Failure(validation_error(error)));
			},
		}
		Ok(())
	}
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PerplexityEnvelope {
	Success(PerplexityResponse),
	ApiError(PerplexityApiErrorEnvelope),
	ValidationError(PerplexityValidationErrorEnvelope),
}

#[derive(Debug, Deserialize)]
struct PerplexityResponse {
	choices:        Vec<PerplexityChoice>,
	#[serde(default)]
	search_results: Option<Vec<PerplexitySearchResult>>,
	#[serde(default, rename = "citations")]
	_citations:     Option<Vec<Str>>,
	#[serde(default)]
	usage:          Option<PerplexityUsage>,
}

impl PerplexityResponse {
	fn canonical(
		self,
		max_results: usize,
		require_answer: bool,
		strip_answer: bool,
	) -> Result<SearchResults, Error> {
		let mut answer = self
			.choices
			.iter()
			.find(|choice| choice.index == 0)
			.or_else(|| self.choices.first())
			.and_then(|choice| choice.message.content.as_ref())
			.filter(|content| !content.trim().is_empty())
			.cloned();
		if require_answer && answer.is_none() {
			return Err(contract_error("required_search_answer_missing"));
		}
		if strip_answer {
			answer = None;
		}
		let search_results = self.search_results.unwrap_or_default();
		if search_results
			.iter()
			.any(|result| result.url.trim().is_empty() || result.title.trim().is_empty())
		{
			return Err(contract_error("search_result_missing_url_or_title"));
		}
		let mut results = Vec::with_capacity(search_results.len().min(max_results));
		for (index, result) in search_results.into_iter().take(max_results).enumerate() {
			results.push(SearchResult {
				rank:         u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1),
				url:          result.url,
				title:        result.title,
				snippet:      (!result.snippet.is_empty()).then_some(result.snippet),
				score:        None,
				published_at: result.date.as_deref().and_then(parse_date),
				author:       None,
			});
		}
		let usage = self.usage.map_or_else(
			|| Usage { search_calls: 1, source: UsageSource::Measured, ..Usage::default() },
			PerplexityUsage::canonical,
		);
		Ok(SearchResults { results, answer, usage, metadata: Default::default() })
	}
}
#[derive(Debug, Deserialize)]
struct PerplexityChoice {
	index:   u32,
	message: PerplexityOutputMessage,
}

#[derive(Debug, Deserialize)]
struct PerplexityOutputMessage {
	content: Option<Str>,
}

#[derive(Debug, Deserialize)]
struct PerplexitySearchResult {
	title:   Str,
	url:     Str,
	#[serde(default)]
	date:    Option<Str>,
	#[serde(default)]
	snippet: Str,
}

#[derive(Debug, Deserialize)]
struct PerplexityUsage {
	#[serde(default, rename = "prompt_tokens")]
	input:     Option<u64>,
	#[serde(default, rename = "completion_tokens")]
	output:    Option<u64>,
	#[serde(default, rename = "reasoning_tokens")]
	reasoning: Option<u64>,
}

impl PerplexityUsage {
	fn canonical(self) -> Usage {
		Usage {
			input_tokens: self.input.unwrap_or(0),
			output_tokens: self.output.unwrap_or(0),
			reasoning_tokens: self.reasoning.unwrap_or(0),
			search_calls: 1,
			source: UsageSource::Provider,
			..Usage::default()
		}
	}
}

#[derive(Debug, Deserialize)]
struct PerplexityApiErrorEnvelope {
	error: PerplexityWireError,
}

#[derive(Debug, Deserialize)]
struct PerplexityWireError {
	#[serde(default)]
	code:     Option<PerplexityErrorCode>,
	#[serde(default, rename = "type")]
	kind:     Option<Str>,
	#[serde(default, rename = "message")]
	_message: Option<Str>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum PerplexityErrorCode {
	Text(Str),
	Number(i64),
}

#[derive(Debug, Deserialize)]
struct PerplexityValidationErrorEnvelope {
	detail: Vec<PerplexityValidationIssue>,
}

#[derive(Debug, Deserialize)]
struct PerplexityValidationIssue {
	#[serde(default, rename = "msg")]
	_message: Option<Str>,
	#[serde(default, rename = "type")]
	_kind:    Option<Str>,
}

fn provider_error(error: PerplexityWireError) -> Error {
	let code = match error.code.as_ref() {
		Some(PerplexityErrorCode::Text(code)) => Some(code.as_str()),
		Some(PerplexityErrorCode::Number(401)) => Some("401"),
		Some(PerplexityErrorCode::Number(402)) => Some("402"),
		Some(PerplexityErrorCode::Number(403)) => Some("403"),
		Some(PerplexityErrorCode::Number(429)) => Some("429"),
		_ => None,
	};
	let status = match error.code.as_ref() {
		Some(PerplexityErrorCode::Number(value)) => u16::try_from(*value).ok(),
		Some(PerplexityErrorCode::Text(value)) => value.parse().ok(),
		None => None,
	};
	let kind = error.kind.as_deref().unwrap_or_default();
	let classified = match (code, kind) {
		(Some("401" | "invalid_api_key"), _) | (_, "authentication_error") => {
			(ErrorKind::Authentication, "perplexity.authentication")
		},
		(Some("403" | "permission_denied"), _) | (_, "permission_error") => {
			(ErrorKind::Authorization, "perplexity.authorization")
		},
		(Some("402" | "payment_required"), _) => {
			(ErrorKind::PaymentRequired, "perplexity.payment_required")
		},
		(Some("429" | "rate_limit_exceeded"), _) | (_, "rate_limit_error") => {
			(ErrorKind::RateLimited, "perplexity.rate_limited")
		},
		(Some("invalid_request_error"), _) | (_, "invalid_request_error") => {
			(ErrorKind::InvalidRequest, "perplexity.invalid_request")
		},
		_ => (ErrorKind::ProviderContractMismatch, "perplexity.upstream_error"),
	};
	Error::new(classified.0, ErrorPhase::Handshake, RetryAction::Never, ExecutionReceipt::default())
		.status(status)
		.code(Str::new(classified.1))
		.detail(ErrorDetail::provider(sf!("Perplexity API request failed")))
}

fn validation_error(envelope: PerplexityValidationErrorEnvelope) -> Error {
	if envelope.detail.is_empty() {
		return protocol_error("perplexity_validation_error_empty");
	}
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Handshake,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(sf!("perplexity.validation_error"))
	.detail(ErrorDetail::provider(sf!("Perplexity rejected the request")))
}

fn codec_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::CodecMismatch,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn encoding_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::Protocol,
		ErrorPhase::Handshake,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn contract_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Recovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn parse_date(value: &str) -> Option<SystemTime> {
	let bytes = value.as_bytes();
	if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
		return None;
	}
	let year = parse_digits(&bytes[0..4])? as i64;
	let month = parse_digits(&bytes[5..7])?;
	let day = parse_digits(&bytes[8..10])?;
	if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
		return None;
	}
	let days = days_from_civil(year, month, day);
	let seconds = days.unsigned_abs().checked_mul(86_400)?;
	if days >= 0 {
		UNIX_EPOCH.checked_add(Duration::from_secs(seconds))
	} else {
		UNIX_EPOCH.checked_sub(Duration::from_secs(seconds))
	}
}

fn parse_digits(bytes: &[u8]) -> Option<u32> {
	bytes.iter().try_fold(0_u32, |value, byte| {
		byte.is_ascii_digit().then(|| {
			value
				.saturating_mul(10)
				.saturating_add(u32::from(*byte - b'0'))
		})
	})
}

const fn days_in_month(year: i64, month: u32) -> u32 {
	match month {
		2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
		2 => 28,
		4 | 6 | 9 | 11 => 30,
		_ => 31,
	}
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
	let adjusted_year = year - i64::from(month <= 2);
	let era = if adjusted_year >= 0 {
		adjusted_year
	} else {
		adjusted_year - 399
	} / 400;
	let year_of_era = adjusted_year - era * 400;
	let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
	let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use omp_catalog::{
		AuthSpecId, CodecId, CodecProfile, CodexTransportPreference, DiscoverySpecId, EndpointSpec,
		HeaderProfileId, ProviderId, RedirectTrust, RouteDef, RouteId, RouteRestrictions,
		TransportKind, TrustDomain,
	};

	use super::*;
	use crate::{
		call::{NegotiationPolicy, Setting},
		id::RequestId,
	};

	fn search_request() -> SearchRequest {
		SearchRequest {
			query: sf!("latest Rust release"),
			include_domains: Arc::from([sf!("rust-lang.org")]),
			exclude_domains: Arc::from([sf!("spam.example")]),
			recency: Some(SearchRecency::Week),
			locale: Some(sf!("en-US")),
			max_results: 5,
			synthesize_answer: Setting::Require(true),
			negotiation: NegotiationPolicy::default(),
			..SearchRequest::new(sf!("latest Rust release"), 5)
		}
	}

	fn decoder() -> PerplexitySearchDecoder {
		PerplexitySearchDecoder::new(&search_request())
	}

	fn route() -> RouteDef {
		RouteDef {
			id:                 RouteId::new("perplexity/search"),
			provider:           ProviderId::new("perplexity"),
			codec_profile:      CodecProfile::Standard,
			codec:              CodecId::new(CODEC_ID),
			transport:          TransportKind::Http,
			endpoint:           EndpointSpec {
				base_url:    sf!("https://api.perplexity.ai/"),
				region:      None,
				api_version: None,
			},
			auth:               AuthSpecId::new("perplexity-bearer"),
			headers:            HeaderProfileId::new("json"),
			discovery:          Option::<DiscoverySpecId>::None,
			capability_limits:  RouteRestrictions::default(),
			trust_domain:       TrustDomain {
				origin:          sf!("https://api.perplexity.ai"),
				redirects:       RedirectTrust::Deny,
				allow_plaintext: false,
			},
			codex_transport:    CodexTransportPreference::HttpOnly,
			use_responses_lite: None,
			priority:           None,
		}
	}

	#[test]
	fn exact_official_sonar_request_is_secret_free() {
		let route = route();
		let request_id = RequestId::new("perplexity-search-fixture");
		let context =
			EncodeContext { request_id: &request_id, route: &route, ..EncodeContext::default() };
		let encoded = PerplexitySearchCodec::new()
			.encode(&context, &OperationCall::Search(Arc::new(search_request())))
			.expect("request encodes");
		assert_eq!(encoded.uri.as_str(), "https://api.perplexity.ai/chat/completions");
		assert_eq!(encoded.method, RequestMethod::Post);
		assert_eq!(encoded.framing, FramingProtocol::Raw);
		assert_eq!(encoded.bounds.response, MAX_RESPONSE_BYTES);
		let BodySource::Bytes(body) = encoded.body else {
			panic!("inline JSON body")
		};
		assert_eq!(
			body.as_ref(),
			br#"{"model":"sonar","messages":[{"role":"user","content":"latest Rust release"}],"search_domain_filter":["rust-lang.org","-spam.example"],"search_recency_filter":"week","search_language_filter":["en"]}"#,
		);
		assert!(
			!body
				.windows(6)
				.any(|window| window.eq_ignore_ascii_case(b"bearer"))
		);
	}

	#[test]
	fn structured_results_citations_answer_and_usage_decode() {
		let fixture = br#"{
			"id":"answer-1",
			"choices":[{"index":0,"message":{"role":"assistant","content":"Rust 1.90 is current.[1]"},"finish_reason":"stop"}],
			"citations":["https://blog.rust-lang.org/release","https://citation-only.example/"],
			"search_results":[{
				"title":"Announcing Rust 1.90.0",
				"url":"https://blog.rust-lang.org/release",
				"date":"2025-09-18",
				"last_updated":null,
				"snippet":"The Rust team published a new stable release.",
				"source":"web"
			}],
			"usage":{"prompt_tokens":11,"completion_tokens":7,"total_tokens":18,"reasoning_tokens":2}
		}"#;
		let mut decoder = decoder();
		let mut events = Vec::new();
		let midpoint = fixture.len() / 2;
		decoder
			.push(Frame::Raw(Bytes::copy_from_slice(&fixture[..midpoint])), &mut |_| {})
			.expect("first fragmented frame");
		decoder
			.push(Frame::Raw(Bytes::copy_from_slice(&fixture[midpoint..])), &mut |_| {})
			.expect("second fragmented frame");
		decoder
			.finish(&mut |event| events.push(event))
			.expect("response complete");
		let RawEvent::Answer(AnswerBody::Search(output)) = events.pop().expect("answer") else {
			panic!("search answer")
		};
		assert_eq!(output.answer.as_deref(), Some("Rust 1.90 is current.[1]"));
		assert_eq!(output.results.len(), 1, "citation-only URLs must not fabricate titles");
		assert_eq!(output.results[0].rank, 1);
		assert_eq!(output.results[0].title.as_str(), "Announcing Rust 1.90.0");
		assert_eq!(output.results[0].published_at, parse_date("2025-09-18"));
		assert_eq!(output.usage.input_tokens, 11);
		assert_eq!(output.usage.output_tokens, 7);
		assert_eq!(output.usage.reasoning_tokens, 2);
		assert_eq!(output.usage.search_calls, 1);
		assert_eq!(output.usage.source, UsageSource::Provider);
	}

	#[test]
	fn missing_required_answer_is_a_provider_contract_error() {
		let fixture = br#"{"choices":[],"search_results":[]}"#;
		let mut decoder = decoder();
		decoder
			.push(Frame::Raw(Bytes::from_static(fixture)), &mut |_| {})
			.expect("response buffered");
		let error = decoder.finish(&mut |_| {}).expect_err("answer is required");
		assert_eq!(error.kind, ErrorKind::ProviderContractMismatch);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Protocol { reason }) if reason.0 == "required_search_answer_missing"
		));
	}

	#[test]
	fn disabled_synthesis_strips_the_sonar_answer() {
		let mut request = search_request();
		request.synthesize_answer = Setting::Require(false);
		let mut decoder = PerplexitySearchDecoder::new(&request);
		decoder
			.push(
				Frame::Raw(Bytes::from_static(
					br#"{"choices":[{"index":0,"message":{"content":"provider answer"}}],"search_results":null,"citations":null}"#,
				)),
				&mut |_| {},
			)
			.expect("response buffered");
		let mut events = Vec::new();
		decoder
			.finish(&mut |event| events.push(event))
			.expect("response decoded");
		let RawEvent::Answer(AnswerBody::Search(output)) = events.pop().expect("answer") else {
			panic!("search answer")
		};
		assert_eq!(output.answer, None);
	}

	#[test]
	fn typed_api_error_is_classified_and_redacted() {
		let fixture = br#"{"error":{"message":"secret-token sk-live-123","type":"rate_limit_error","code":429}}"#;
		let mut decoder = decoder();
		decoder
			.push(Frame::Raw(Bytes::from_static(fixture)), &mut |_| {})
			.expect("API response buffered");
		let mut events = Vec::new();
		decoder
			.finish(&mut |event| events.push(event))
			.expect("API failure decoded");
		let RawEvent::Failure(error) = events.pop().expect("failure") else {
			panic!("failure event")
		};
		assert_eq!(error.kind, ErrorKind::RateLimited);
		assert_eq!(error.code.as_deref(), Some("perplexity.rate_limited"));
		let rendered = format!("{error:?}");
		assert!(!rendered.contains("sk-live-123"));
		assert!(!rendered.contains("secret-token"));
	}

	#[test]
	fn malformed_and_oversize_responses_are_bounded() {
		let mut malformed = decoder();
		malformed
			.push(Frame::Raw(Bytes::from_static(b"{not-json")), &mut |_| {})
			.expect("malformed response buffered");
		let error = malformed.finish(&mut |_| {}).expect_err("malformed JSON");
		assert_eq!(error.kind, ErrorKind::Protocol);

		let mut oversize = decoder();
		let bytes = Bytes::from(vec![b' '; MAX_RESPONSE_BYTES as usize + 1]);
		let error = oversize
			.push(Frame::Raw(bytes), &mut |_| {})
			.expect_err("bounded response");
		assert_eq!(error.kind, ErrorKind::Protocol);
	}
}
