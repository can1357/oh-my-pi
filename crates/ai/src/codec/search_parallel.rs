//! Parallel Search beta sans-I/O wire codec.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};

use crate::{
	answer::{AnswerBody, SearchResult, SearchResults},
	body::BodySource,
	call::{OperationCall, SearchRequest},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawEvent,
		RequestHeader, RequestMethod, SizeBounds,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

/// Stable catalog codec identifier for Parallel Search beta.
pub const CODEC_ID: &str = "search-parallel";
/// Parallel's legacy beta search resource.
pub const SEARCH_PATH: &str = "/v1beta/search";
/// Public beta selection required by this wire contract.
pub const BETA_HEADER_VALUE: &str = "search-extract-2025-10-10";

const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SNIPPET_BYTES: usize = 32 * 1024;

/// Secret-free codec for Parallel's synchronous beta Search API.
#[derive(Clone, Copy, Debug, Default)]
pub struct ParallelSearchCodec;

impl ParallelSearchCodec {
	/// Creates a Parallel Search beta codec.
	pub const fn new() -> Self {
		Self
	}
}

#[derive(Serialize)]
struct WireRequest<'a> {
	objective:      &'a str,
	search_queries: [&'a str; 1],
	max_results:    u32,
	#[serde(skip_serializing_if = "Option::is_none")]
	source_policy:  Option<SourcePolicy<'a>>,
}

#[derive(Serialize)]
struct SourcePolicy<'a> {
	#[serde(skip_serializing_if = "Option::is_none")]
	include_domains: Option<&'a [Str]>,
	#[serde(skip_serializing_if = "Option::is_none")]
	exclude_domains: Option<&'a [Str]>,
}

impl Codec for ParallelSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return Err(encoding_error(
				ErrorKind::CodecMismatch,
				"parallel_search_operation_mismatch",
			));
		};
		let body = encode_request(request)?;
		Ok(EncodedRequest::new(
			OperationKind::Search,
			RequestMethod::Post,
			join_uri(context.route.endpoint.base_url.as_str(), SEARCH_PATH),
			request_headers(),
			BodySource::Bytes(body),
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
			return Err(encoding_error(
				ErrorKind::CodecMismatch,
				"parallel_search_decode_context_mismatch",
			));
		}
		Ok(Box::new(ParallelSearchDecoder::default()))
	}
}

fn request_headers() -> Box<[RequestHeader]> {
	Box::new([
		RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
		RequestHeader { name: sf!("parallel-beta"), value: sf!(BETA_HEADER_VALUE) },
	])
}

fn encode_request(request: &SearchRequest) -> Result<Bytes, Error> {
	let source_policy = if request.include_domains.is_empty() && request.exclude_domains.is_empty() {
		None
	} else {
		Some(SourcePolicy {
			include_domains: (!request.include_domains.is_empty())
				.then_some(request.include_domains.as_ref()),
			exclude_domains: (!request.exclude_domains.is_empty())
				.then_some(request.exclude_domains.as_ref()),
		})
	};
	let wire = WireRequest {
		objective: request.query.as_str(),
		search_queries: [request.query.as_str()],
		max_results: request.max_results,
		source_policy,
	};
	let bytes = serde_json::to_vec(&wire)
		.map(Bytes::from)
		.map_err(|_| encoding_error(ErrorKind::Protocol, "parallel_search_request_serialization"))?;
	if bytes.len() as u64 > MAX_REQUEST_BYTES {
		return Err(encoding_error(ErrorKind::InvalidRequest, "parallel_search_request_too_large"));
	}
	Ok(bytes)
}

fn join_uri(base: &str, path: &str) -> Str {
	let base = base.trim_end_matches('/');
	if base.ends_with(path) {
		Str::new(base)
	} else {
		sf!("{base}{path}")
	}
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireEnvelope {
	Error(WireErrorEnvelope),
	Result(WireResponse),
}

#[derive(Deserialize)]
struct WireResponse {
	#[serde(rename = "type", default)]
	_kind:      Option<ResultKind>,
	#[serde(rename = "search_id")]
	_search_id: Str,
	results:    Vec<WireSearchResult>,
	#[serde(default)]
	usage:      Option<Vec<WireUsageItem>>,
}

#[derive(Deserialize)]
enum ResultKind {
	#[serde(rename = "result")]
	Result,
}

#[derive(Deserialize)]
struct WireSearchResult {
	#[serde(rename = "type", default)]
	_kind:        Option<SearchResultKind>,
	url:          Str,
	#[serde(default)]
	title:        Option<Str>,
	#[serde(default)]
	excerpts:     Option<Vec<Str>>,
	#[serde(default, alias = "relevance_score")]
	score:        Option<f32>,
	#[serde(default, alias = "published_at", alias = "published_date")]
	publish_date: Option<Str>,
}

#[derive(Deserialize)]
enum SearchResultKind {
	#[serde(rename = "search_result")]
	SearchResult,
}

#[derive(Deserialize)]
struct WireUsageItem {
	name:  Str,
	count: u64,
}

#[derive(Deserialize)]
struct WireErrorEnvelope {
	#[serde(rename = "type")]
	_kind:  WireErrorKind,
	#[serde(rename = "error")]
	_error: WireError,
}

#[derive(Deserialize)]
enum WireErrorKind {
	#[serde(rename = "error")]
	Error,
}

#[derive(Deserialize)]
struct WireError {
	#[serde(rename = "ref_id")]
	_ref_id:  Str,
	#[serde(rename = "message")]
	_message: Str,
}

#[derive(Default)]
struct ParallelSearchDecoder {
	buffer:   BytesMut,
	finished: bool,
}

impl Decoder for ParallelSearchDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Err(protocol_error("parallel_search_frame_after_finish"));
		}
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("parallel_search_unexpected_frame"));
		};
		let next = self.buffer.len().saturating_add(bytes.len());
		if next as u64 > MAX_RESPONSE_BYTES {
			self.finished = true;
			self.buffer.clear();
			return Err(protocol_error("parallel_search_response_too_large"));
		}
		self.buffer.extend_from_slice(&bytes);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		if self.buffer.is_empty() {
			return Err(protocol_error("parallel_search_empty_response"));
		}
		let body = self.buffer.split().freeze();
		let envelope: WireEnvelope = serde_json::from_slice(&body)
			.map_err(|_| protocol_error("parallel_search_malformed_response"))?;
		match envelope {
			WireEnvelope::Error(error) => emit(RawEvent::Failure(provider_error(error))),
			WireEnvelope::Result(response) => {
				emit(RawEvent::Answer(AnswerBody::Search(project(response)?)));
			},
		}
		Ok(())
	}
}

fn project(response: WireResponse) -> Result<SearchResults, Error> {
	let WireResponse { _kind: _, _search_id: _, results: wire_results, usage } = response;
	let mut results = Vec::with_capacity(wire_results.len());
	for (index, result) in wire_results.into_iter().enumerate() {
		let WireSearchResult { _kind: _, url, title, excerpts, score, publish_date } = result;
		if url.is_empty() {
			return Err(protocol_error("parallel_search_result_url_empty"));
		}
		let rank =
			u32::try_from(index + 1).map_err(|_| protocol_error("parallel_search_rank_overflow"))?;
		results.push(SearchResult {
			rank,
			url,
			title: title.unwrap_or_else(Default::default),
			snippet: bounded_snippet(excerpts.unwrap_or_default()),
			score,
			published_at: publish_date.as_deref().and_then(parse_date),
			author: None,
		});
	}
	// Parallel reports billable SKU rows rather than token counts. Retain their
	// presence through provider provenance while the canonical dimension remains
	// exactly one synchronous search invocation.
	if let Some(items) = usage {
		for item in items {
			let _ = (item.name, item.count);
		}
	}
	Ok(SearchResults {
		results,
		answer: None,
		usage: Usage { search_calls: 1, source: UsageSource::Provider, ..Usage::default() },
		metadata: Default::default(),
	})
}

fn bounded_snippet(excerpts: Vec<Str>) -> Option<Str> {
	if excerpts.is_empty() {
		return None;
	}
	let mut output = String::new();
	for excerpt in excerpts {
		if excerpt.is_empty() {
			continue;
		}
		if !output.is_empty() {
			push_bounded(&mut output, "\n\n", MAX_SNIPPET_BYTES);
		}
		push_bounded(&mut output, excerpt.as_str(), MAX_SNIPPET_BYTES);
		if output.len() == MAX_SNIPPET_BYTES {
			break;
		}
	}
	(!output.is_empty()).then(|| Str::new(output))
}

fn push_bounded(output: &mut String, value: &str, limit: usize) {
	if output.len() >= limit {
		return;
	}
	let mut end = value.len().min(limit - output.len());
	while !value.is_char_boundary(end) {
		end -= 1;
	}
	output.push_str(&value[..end]);
}

fn parse_date(value: &str) -> Option<SystemTime> {
	let mut parts = value.split('-');
	let (year, month, day) = (parts.next()?, parts.next()?, parts.next()?);
	if parts.next().is_some() {
		return None;
	}
	let (year, month, day) =
		(year.parse::<i32>().ok()?, month.parse::<u32>().ok()?, day.parse::<u32>().ok()?);
	if year < 1970 || !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
		return None;
	}
	let days = days_from_civil(year, month, day)?;
	UNIX_EPOCH.checked_add(Duration::from_days(days))
}

const fn days_in_month(year: i32, month: u32) -> u32 {
	match month {
		1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
		4 | 6 | 9 | 11 => 30,
		2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
		2 => 28,
		_ => 0,
	}
}

fn days_from_civil(year: i32, month: u32, day: u32) -> Option<u64> {
	let adjusted_year = year - i32::from(month <= 2);
	let era = adjusted_year.div_euclid(400);
	let year_of_era = adjusted_year - era * 400;
	let shifted_month = month as i32 + if month > 2 { -3 } else { 9 };
	let day_of_year = (153 * shifted_month + 2) / 5 + day as i32 - 1;
	let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
	let unix_days = era * 146_097 + day_of_era - 719_468;
	u64::try_from(unix_days).ok()
}

fn provider_error(_error: WireErrorEnvelope) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(sf!("parallel_search_error"))
	.detail(ErrorDetail::provider(sf!("Parallel Search request failed")))
}

fn encoding_error(kind: ErrorKind, reason: &'static str) -> Error {
	Error::new(kind, ErrorPhase::Encoding, RetryAction::Never, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::Protocol,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}

#[cfg(test)]
mod tests {
	use std::sync::Arc;

	use super::*;
	use crate::call::{NegotiationPolicy, SearchRequest, Setting};

	fn request() -> SearchRequest {
		SearchRequest {
			query: sf!("parallel web systems"),
			include_domains: Arc::from([sf!("parallel.ai")]),
			exclude_domains: Arc::from([sf!("example.invalid")]),
			recency: None,
			locale: None,
			max_results: 4,
			synthesize_answer: Setting::Unset,
			negotiation: NegotiationPolicy::default(),
			..SearchRequest::new(sf!("parallel web systems"), 4)
		}
	}

	#[test]
	fn exact_beta_header_and_body_contract() {
		let headers = request_headers();
		assert_eq!(headers.as_ref(), [
			RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
			RequestHeader { name: sf!("parallel-beta"), value: sf!("search-extract-2025-10-10") },
		]);
		assert!(
			headers
				.iter()
				.all(|header| header.name != "x-api-key" && header.name != "authorization")
		);
		assert_eq!(BETA_HEADER_VALUE, "search-extract-2025-10-10");
		assert_eq!(
			encode_request(&request()).expect("request").as_ref(),
			br#"{"objective":"parallel web systems","search_queries":["parallel web systems"],"max_results":4,"source_policy":{"include_domains":["parallel.ai"],"exclude_domains":["example.invalid"]}}"#,
		);
		assert_eq!(
			join_uri("https://api.parallel.ai/", SEARCH_PATH),
			"https://api.parallel.ai/v1beta/search"
		);
		assert_eq!(
			join_uri("https://api.parallel.ai/v1beta/search/", SEARCH_PATH),
			"https://api.parallel.ai/v1beta/search"
		);
	}

	fn decode_fragments(fragments: &[&[u8]]) -> Result<Vec<RawEvent>, Error> {
		let mut decoder = ParallelSearchDecoder::default();
		let mut events = Vec::new();
		for fragment in fragments {
			decoder
				.push(Frame::Raw(Bytes::copy_from_slice(fragment)), &mut |event| events.push(event))?;
		}
		decoder.finish(&mut |event| events.push(event))?;
		Ok(events)
	}

	#[test]
	fn typed_fragmented_result_projects_rank_excerpt_score_date_and_usage() {
		let body = br#"{"type":"result","search_id":"search_123","results":[{"type":"search_result","url":"https://parallel.ai/blog","title":"Parallel","publish_date":"2024-02-29","score":0.875,"excerpts":["first","second"]}],"usage":[{"name":"sku_search","count":1}]}"#;
		let events = decode_fragments(&[&body[..37], &body[37..]]).expect("response");
		let RawEvent::Answer(AnswerBody::Search(answer)) = &events[0] else {
			panic!("search answer")
		};
		assert_eq!(
			(answer.results[0].rank, answer.results[0].snippet.as_deref()),
			(1, Some("first\n\nsecond"))
		);
		assert_eq!(answer.results[0].score, Some(0.875));
		assert_eq!(answer.results[0].published_at, Some(UNIX_EPOCH + Duration::from_weeks(2826)));
		assert_eq!(answer.usage.search_calls, 1);
		assert_eq!(answer.usage.source, UsageSource::Provider);
	}

	#[test]
	fn official_untyped_result_and_typed_error_are_supported_and_sanitized() {
		let success = br#"{"search_id":"search_123","results":[{"url":"https://example.com","title":null,"publish_date":null,"excerpts":["excerpt"]}]}"#;
		assert!(matches!(
			decode_fragments(&[success]).expect("official response")[0],
			RawEvent::Answer(_)
		));
		let failure = decode_fragments(&[br#"{"type":"error","error":{"ref_id":"search_123","message":"bad\nAuthorization: secret"}}"#]).expect("typed error");
		let RawEvent::Failure(error) = &failure[0] else {
			panic!("failure")
		};
		let Some(ErrorDetail::Provider { sanitized_message }) = error.detail_ref() else {
			panic!("provider detail")
		};
		assert_eq!(sanitized_message.as_str(), "Parallel Search request failed");
		let debug = format!("{error:?}");
		assert!(!debug.contains("bad"));
		assert!(!debug.contains("secret"));
	}

	#[test]
	fn malformed_and_oversized_responses_are_bounded() {
		assert!(decode_fragments(&[b"{not json"]).is_err());
		let mut decoder = ParallelSearchDecoder::default();
		let oversized = Bytes::from(vec![b'x'; MAX_RESPONSE_BYTES as usize + 1]);
		assert!(decoder.push(Frame::Raw(oversized), &mut |_| {}).is_err());
		let snippet =
			bounded_snippet(vec![Str::new("é".repeat(MAX_SNIPPET_BYTES))]).expect("snippet");
		assert!(snippet.len() <= MAX_SNIPPET_BYTES);
		assert!(std::str::from_utf8(snippet.as_bytes()).is_ok());
	}
}
