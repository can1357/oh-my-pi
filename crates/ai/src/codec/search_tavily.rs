//! Typed sans-I/O codec for Tavily's standalone Search API.

use std::time::{Duration, SystemTime};

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

/// Stable registry identifier for the Tavily search codec.
pub const CODEC_ID: &str = "search-tavily";
/// Maximum encoded Tavily request body size.
pub const MAX_REQUEST_BYTES: u64 = 64 * 1024;
/// Maximum Tavily response body size.
pub const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

const SEARCH_PATH: &str = "/search";

/// Stateless codec for Tavily's `POST /search` wire protocol.
#[derive(Clone, Copy, Debug, Default)]
pub struct TavilySearchCodec;

impl TavilySearchCodec {
	/// Creates a Tavily search codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns the stable registry identifier for this codec.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}

impl Codec for TavilySearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return Err(encoding_error("tavily_search_operation_required"));
		};
		encode_search(context.route.endpoint.base_url.as_str(), request)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		let OperationCall::Search(request) = context.operation_call else {
			return Err(encoding_error("tavily_search_decode_context_invalid"));
		};
		if context.operation != OperationKind::Search
			|| context.operation_call.kind() != context.operation
			|| context.framing != FramingProtocol::Raw
		{
			return Err(encoding_error("tavily_search_decode_context_invalid"));
		}
		let require_answer = matches!(request.synthesize_answer, Setting::Require(true));
		Ok(Box::new(TavilySearchDecoder::with_required_answer(require_answer)))
	}
}

#[derive(Serialize)]
struct TavilyRequest<'a> {
	query:           &'a str,
	max_results:     u32,
	search_depth:    SearchDepth,
	include_answer:  IncludeAnswer,
	include_domains: &'a [Str],
	exclude_domains: &'a [Str],
	#[serde(skip_serializing_if = "Option::is_none")]
	time_range:      Option<TimeRange>,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum SearchDepth {
	Basic,
}

#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
enum IncludeAnswer {
	Bool(bool),
	Depth(AnswerDepth),
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum AnswerDepth {
	Advanced,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum TimeRange {
	Day,
	Week,
	Month,
	Year,
}

fn encode_search(base_url: &str, request: &SearchRequest) -> Result<EncodedRequest, Error> {
	if request.query.trim().is_empty() {
		return Err(encoding_error("tavily_search_query_empty"));
	}
	if !(1..=20).contains(&request.max_results) {
		return Err(encoding_error("tavily_search_max_results_invalid"));
	}
	if request.locale.is_some() {
		return Err(encoding_error("tavily_search_locale_not_supported"));
	}
	let time_range = match request.recency {
		None => None,
		Some(SearchRecency::Day) => Some(TimeRange::Day),
		Some(SearchRecency::Week) => Some(TimeRange::Week),
		Some(SearchRecency::Month) => Some(TimeRange::Month),
		Some(SearchRecency::Year) => Some(TimeRange::Year),
		Some(SearchRecency::Days(_)) => {
			return Err(encoding_error("tavily_search_numeric_recency_not_supported"));
		},
	};
	let include_answer = match &request.synthesize_answer {
		Setting::Unset | Setting::Require(false) | Setting::Prefer(false) => {
			IncludeAnswer::Bool(false)
		},
		Setting::Require(true) | Setting::Prefer(true) => IncludeAnswer::Depth(AnswerDepth::Advanced),
	};
	let wire = TavilyRequest {
		query: request.query.as_str(),
		max_results: request.max_results,
		search_depth: SearchDepth::Basic,
		include_answer,
		include_domains: &request.include_domains,
		exclude_domains: &request.exclude_domains,
		time_range,
	};
	let body = serde_json::to_vec(&wire)
		.map_err(|_| encoding_error("tavily_search_request_encode_failed"))?;
	if body.len() as u64 > MAX_REQUEST_BYTES {
		return Err(encoding_error("tavily_search_request_too_large"));
	}
	Ok(EncodedRequest::new(
		OperationKind::Search,
		RequestMethod::Post,
		join_uri(base_url, SEARCH_PATH)?,
		vec![RequestHeader { name: sf!("accept"), value: sf!("application/json") }, RequestHeader {
			name:  sf!("content-type"),
			value: sf!("application/json"),
		}]
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

fn join_uri(base: &str, suffix: &str) -> Result<Str, Error> {
	let mut url = Url::parse(base).map_err(|_| encoding_error("tavily_search_base_url_invalid"))?;
	if url.cannot_be_a_base() || url.query().is_some() || url.fragment().is_some() {
		return Err(encoding_error("tavily_search_base_url_invalid"));
	}
	let mut path = url.path().trim_end_matches('/').to_owned();
	path.push_str(suffix);
	url.set_path(&path);
	Ok(Str::new(url.as_str()))
}

/// Bounded unary decoder for Tavily search responses.
#[derive(Debug, Default)]
pub struct TavilySearchDecoder {
	buffer:         BytesMut,
	finished:       bool,
	require_answer: bool,
}

impl TavilySearchDecoder {
	/// Creates an empty Tavily response decoder.
	pub fn new() -> Self {
		Self { buffer: BytesMut::new(), finished: false, require_answer: false }
	}

	fn with_required_answer(require_answer: bool) -> Self {
		Self { buffer: BytesMut::new(), finished: false, require_answer }
	}
}

impl Decoder for TavilySearchDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("tavily_search_unexpected_response_frame"));
		};
		let observed = self.buffer.len().saturating_add(bytes.len());
		if observed > MAX_RESPONSE_BYTES as usize {
			self.buffer.clear();
			self.finished = true;
			return Err(protocol_error("tavily_search_response_too_large"));
		}
		self.buffer.extend_from_slice(&bytes);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		let bytes = self.buffer.split().freeze();
		if serde_json::from_slice::<TavilyErrorResponse>(&bytes).is_ok() {
			emit(RawEvent::Failure(provider_error()));
			return Ok(());
		}
		let response: TavilyResponse = serde_json::from_slice(&bytes)
			.map_err(|_| protocol_error("tavily_search_response_malformed"))?;
		if self.require_answer && response.answer.0.is_none() {
			return Err(protocol_error("required_search_answer_missing"));
		}
		let results = response
			.results
			.into_iter()
			.enumerate()
			.map(|(index, result)| {
				if result.url.is_empty() || result.title.is_empty() {
					return Err(protocol_error("tavily_search_result_missing_url_or_title"));
				}
				if !result.score.is_finite() {
					return Err(protocol_error("tavily_search_result_score_non_finite"));
				}
				let published_at = result
					.published_date
					.as_deref()
					.map(parse_timestamp)
					.transpose()?;
				Ok(SearchResult {
					rank: u32::try_from(index).unwrap_or(u32::MAX).saturating_add(1),
					url: result.url,
					title: result.title,
					snippet: Some(result.content),
					score: Some(result.score),
					published_at,
					author: None,
				})
			})
			.collect::<Result<Vec<_>, Error>>()?;
		let usage = Usage {
			search_calls: 1,
			source: if response.usage.is_some() {
				UsageSource::Provider
			} else {
				UsageSource::Measured
			},
			..Usage::default()
		};
		emit(RawEvent::Answer(AnswerBody::Search(SearchResults {
			results,
			answer: response.answer.0,
			usage,
			metadata: Default::default(),
		})));
		Ok(())
	}
}

#[derive(Deserialize)]
struct TavilyResponse {
	answer:  NullableAnswer,
	results: Vec<TavilyResult>,
	#[serde(default)]
	usage:   Option<TavilyUsage>,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct NullableAnswer(Option<Str>);

#[derive(Deserialize)]
struct TavilyResult {
	title:          Str,
	url:            Str,
	content:        Str,
	score:          f32,
	#[serde(default)]
	published_date: Option<String>,
}

#[derive(Deserialize)]
struct TavilyUsage {
	#[serde(rename = "credits")]
	_credits: u32,
}

#[derive(Deserialize)]
struct TavilyErrorResponse {
	#[serde(rename = "detail")]
	_detail: TavilyErrorDetail,
}

#[derive(Deserialize)]
struct TavilyErrorDetail {
	#[serde(rename = "error")]
	_error: String,
}

fn parse_timestamp(value: &str) -> Result<SystemTime, Error> {
	let bytes = value.as_bytes();
	if bytes.len() < 10 || bytes.get(4) != Some(&b'-') || bytes.get(7) != Some(&b'-') {
		return Err(protocol_error("tavily_search_published_date_invalid"));
	}
	let year = decimal(bytes, 0, 4)? as i64;
	let month = decimal(bytes, 5, 2)?;
	let day = decimal(bytes, 8, 2)?;
	if !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
		return Err(protocol_error("tavily_search_published_date_invalid"));
	}
	let (hour, minute, second, offset) = if bytes.len() == 10 {
		(0, 0, 0, 0_i64)
	} else {
		if bytes.len() < 20
			|| bytes.get(10) != Some(&b'T')
			|| bytes.get(13) != Some(&b':')
			|| bytes.get(16) != Some(&b':')
		{
			return Err(protocol_error("tavily_search_published_date_invalid"));
		}
		let hour = decimal(bytes, 11, 2)?;
		let minute = decimal(bytes, 14, 2)?;
		let second = decimal(bytes, 17, 2)?;
		if hour > 23 || minute > 59 || second > 59 {
			return Err(protocol_error("tavily_search_published_date_invalid"));
		}
		let mut zone = 19;
		if bytes.get(zone) == Some(&b'.') {
			zone += 1;
			let start = zone;
			while bytes.get(zone).is_some_and(u8::is_ascii_digit) {
				zone += 1;
			}
			if zone == start {
				return Err(protocol_error("tavily_search_published_date_invalid"));
			}
		}
		let offset = match bytes.get(zone) {
			Some(b'Z') if zone + 1 == bytes.len() => 0,
			Some(sign @ (b'+' | b'-'))
				if zone + 6 == bytes.len() && bytes.get(zone + 3) == Some(&b':') =>
			{
				let hours = decimal(bytes, zone + 1, 2)?;
				let minutes = decimal(bytes, zone + 4, 2)?;
				if hours > 23 || minutes > 59 {
					return Err(protocol_error("tavily_search_published_date_invalid"));
				}
				let seconds = i64::from(hours * 3600 + minutes * 60);
				if *sign == b'+' { seconds } else { -seconds }
			},
			_ => return Err(protocol_error("tavily_search_published_date_invalid")),
		};
		(hour, minute, second, offset)
	};
	let days = days_from_civil(year, month, day);
	let seconds = days
		.checked_mul(86_400)
		.and_then(|seconds| seconds.checked_add(i64::from(hour * 3600 + minute * 60 + second)))
		.and_then(|seconds| seconds.checked_sub(offset))
		.ok_or_else(|| protocol_error("tavily_search_published_date_invalid"))?;
	if seconds >= 0 {
		SystemTime::UNIX_EPOCH
			.checked_add(Duration::from_secs(seconds as u64))
			.ok_or_else(|| protocol_error("tavily_search_published_date_invalid"))
	} else {
		SystemTime::UNIX_EPOCH
			.checked_sub(Duration::from_secs(seconds.unsigned_abs()))
			.ok_or_else(|| protocol_error("tavily_search_published_date_invalid"))
	}
}

fn decimal(bytes: &[u8], start: usize, len: usize) -> Result<u32, Error> {
	let mut value = 0_u32;
	for byte in bytes
		.get(start..start + len)
		.ok_or_else(|| protocol_error("tavily_search_published_date_invalid"))?
	{
		if !byte.is_ascii_digit() {
			return Err(protocol_error("tavily_search_published_date_invalid"));
		}
		value = value * 10 + u32::from(byte - b'0');
	}
	Ok(value)
}

const fn days_in_month(year: i64, month: u32) -> u32 {
	match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
		2 => 28,
		_ => 0,
	}
}

const fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
	let year = year - if month <= 2 { 1 } else { 0 };
	let era = if year >= 0 { year } else { year - 399 } / 400;
	let year_of_era = year - era * 400;
	let month = month as i64;
	let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day as i64 - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	era * 146_097 + day_of_era - 719_468
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
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

fn provider_error() -> Error {
	Error::new(
		ErrorKind::Protocol,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(sf!("tavily_provider_error"))
	.detail(ErrorDetail::provider(sf!("Tavily rejected the search request")))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::call::NegotiationPolicy;

	fn request(synthesize_answer: Setting<bool>) -> SearchRequest {
		SearchRequest {
			query: sf!("latest Rust release"),
			include_domains: Arc::from([sf!("rust-lang.org")]),
			exclude_domains: Arc::from([sf!("example.com")]),
			recency: Some(SearchRecency::Week),
			locale: None,
			max_results: 3,
			synthesize_answer,
			negotiation: NegotiationPolicy::default(),
			..SearchRequest::new(sf!("latest Rust release"), 3)
		}
	}

	#[test]
	fn exact_request_fixture_uses_official_fields_and_legacy_synthesis_depth() {
		let encoded = encode_search("https://api.tavily.com/", &request(Setting::Require(true)))
			.expect("encode Tavily request");
		assert_eq!(encoded.uri.as_str(), "https://api.tavily.com/search");
		assert_eq!(encoded.method, RequestMethod::Post);
		assert_eq!(encoded.framing, FramingProtocol::Raw);
		assert_eq!(encoded.bounds.response, MAX_RESPONSE_BYTES);
		let BodySource::Bytes(body) = encoded.body else {
			panic!("request body is not replayable bytes")
		};
		assert_eq!(
			body.as_ref(),
			br#"{"query":"latest Rust release","max_results":3,"search_depth":"basic","include_answer":"advanced","include_domains":["rust-lang.org"],"exclude_domains":["example.com"],"time_range":"week"}"#,
		);
		assert!(!body.windows(7).any(|window| window == b"api_key"));
	}

	#[test]
	fn residual_unsupported_options_are_typed_encoding_failures() {
		let mut locale = request(Setting::Unset);
		locale.locale = Some(sf!("en-US"));
		assert_eq!(
			encode_search("https://api.tavily.com", &locale)
				.err()
				.expect("locale")
				.kind,
			ErrorKind::InvalidRequest
		);
		let mut days = request(Setting::Unset);
		days.recency = Some(SearchRecency::Days(3));
		assert_eq!(
			encode_search("https://api.tavily.com", &days)
				.err()
				.expect("days")
				.kind,
			ErrorKind::InvalidRequest
		);
	}

	#[test]
	fn typed_success_fixture_decodes_fragmented_raw_body() {
		let fixture = br#"{"query":"latest Rust release","answer":"Rust 1.89 is current.","results":[{"title":"Rust","url":"https://www.rust-lang.org/","content":"A systems language.","score":0.91,"published_date":"2025-08-07T12:30:00Z"},{"title":"Blog","url":"https://blog.rust-lang.org/","content":"Release notes.","score":0.75,"published_date":"2025-08-06"}],"response_time":0.21,"usage":{"credits":2}}"#;
		let mut decoder = TavilySearchDecoder::new();
		let mut events = Vec::new();
		for chunk in fixture.chunks(17) {
			decoder
				.push(Frame::Raw(Bytes::copy_from_slice(chunk)), &mut |event| events.push(event))
				.expect("fragment");
		}
		assert!(events.is_empty());
		decoder
			.finish(&mut |event| events.push(event))
			.expect("finish");
		let [RawEvent::Answer(AnswerBody::Search(answer))] = events.as_slice() else {
			panic!("typed search answer")
		};
		assert_eq!(answer.answer.as_deref(), Some("Rust 1.89 is current."));
		assert_eq!(answer.results.len(), 2);
		assert_eq!(answer.results[0].rank, 1);
		assert_eq!(answer.results[1].rank, 2);
		assert_eq!(answer.results[0].score, Some(0.91));
		assert!(
			answer
				.results
				.iter()
				.all(|result| result.published_at.is_some())
		);
		assert_eq!(answer.usage.search_calls, 1);
		assert_eq!(answer.usage.source, UsageSource::Provider);
	}

	#[test]
	fn required_synthesis_without_answer_is_a_typed_contract_failure() {
		let mut decoder = TavilySearchDecoder::with_required_answer(true);
		decoder
			.push(
				Frame::Raw(Bytes::from_static(br#"{"query":"q","answer":null,"results":[]}"#)),
				&mut |_| {},
			)
			.expect("body");
		let error = decoder
			.finish(&mut |_| {})
			.expect_err("missing required answer");
		assert_eq!(error.kind, ErrorKind::ProviderContractMismatch);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Protocol { reason }) if reason.0.as_str() == "required_search_answer_missing"
		));
	}

	#[test]
	fn provider_error_fixture_is_sanitized() {
		let secret = "sk-tavily-secret-sentinel";
		let body = format!(r#"{{"detail":{{"error":"Unauthorized: {secret}"}}}}"#);
		let mut decoder = TavilySearchDecoder::new();
		let mut events = Vec::new();
		decoder
			.push(Frame::Raw(Bytes::from(body)), &mut |event| events.push(event))
			.expect("body");
		decoder
			.finish(&mut |event| events.push(event))
			.expect("provider error");
		let [RawEvent::Failure(error)] = events.as_slice() else {
			panic!("typed provider failure")
		};
		assert_eq!(error.code.as_deref(), Some("tavily_provider_error"));
		assert!(!format!("{error:?}").contains(secret));
	}

	#[test]
	fn malformed_oversize_and_wrong_frame_fail_without_body_evidence() {
		let mut malformed = TavilySearchDecoder::new();
		malformed
			.push(Frame::Raw(Bytes::from_static(b"{secret")), &mut |_| {})
			.expect("body");
		let error = malformed.finish(&mut |_| {}).expect_err("malformed");
		assert!(!format!("{error:?}").contains("secret"));

		let oversize_secret = b"secret-oversize-sentinel";
		let mut body = Vec::with_capacity(MAX_RESPONSE_BYTES as usize + oversize_secret.len());
		while body.len() <= MAX_RESPONSE_BYTES as usize {
			body.extend_from_slice(oversize_secret);
		}
		let mut oversize = TavilySearchDecoder::new();
		let error = oversize
			.push(Frame::Raw(Bytes::from(body)), &mut |_| {})
			.expect_err("oversize");
		assert!(!format!("{error:?}").contains("secret-oversize-sentinel"));

		let mut wrong = TavilySearchDecoder::new();
		assert!(
			wrong
				.push(Frame::Ndjson(Bytes::from_static(b"{}")), &mut |_| {})
				.is_err()
		);
	}
}
