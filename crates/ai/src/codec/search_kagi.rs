//! Sans-I/O codec for Kagi's standalone v1 Search API.

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, parse_rfc3339, sf};
use serde::{Deserialize, Serialize};
use url::Url;

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

/// Stable catalog identifier for the Kagi Search API codec.
pub const CODEC_ID: &str = "search-kagi";

const SEARCH_PATH_SEGMENT: &str = "search";
/// Maximum encoded Kagi request body size.
pub const MAX_REQUEST_BYTES: u64 = 64 * 1024;
/// Maximum Kagi response body size.
pub const MAX_RESPONSE_BYTES: u64 = 2 * 1024 * 1024;

/// Stateless codec for Kagi's authenticated-by-middleware v1 Search API.
#[derive(Clone, Copy, Debug, Default)]
pub struct KagiSearchCodec;

impl KagiSearchCodec {
	/// Creates a Kagi Search API codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns the stable catalog identifier for this codec.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}

impl Codec for KagiSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return Err(codec_mismatch("kagi_search_operation_required"));
		};
		encode_search(context, request)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if context.operation != OperationKind::Search {
			return Err(codec_mismatch("kagi_search_operation_required"));
		}
		if context.framing != FramingProtocol::Raw {
			return Err(codec_mismatch("kagi_search_raw_framing_required"));
		}
		Ok(Box::new(KagiSearchDecoder::new()))
	}
}

fn encode_search(
	context: &EncodeContext<'_>,
	request: &SearchRequest,
) -> Result<EncodedRequest, Error> {
	let body = encode_request_body(request)?;
	let request_bytes = body.len() as u64;
	if request_bytes > MAX_REQUEST_BYTES {
		return Err(encoding_error("kagi_search_request_too_large"));
	}
	Ok(EncodedRequest::new(
		OperationKind::Search,
		RequestMethod::Post,
		join_search_uri(context.route.endpoint.base_url.as_str())?,
		vec![
			RequestHeader { name: sf!("content-type"), value: sf!("application/json") },
			RequestHeader { name: sf!("accept"), value: sf!("application/json") },
		]
		.into_boxed_slice(),
		BodySource::Bytes(body),
		FramingProtocol::Raw,
		SizeBounds {
			request_body: MAX_REQUEST_BYTES,
			frame:        MAX_RESPONSE_BYTES,
			response:     MAX_RESPONSE_BYTES,
		},
	))
}

#[derive(Serialize)]
struct KagiSearchRequest<'a> {
	query:    &'a str,
	workflow: KagiWorkflow,
	limit:    u32,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum KagiWorkflow {
	Search,
}

fn encode_request_body(request: &SearchRequest) -> Result<Bytes, Error> {
	let wire = KagiSearchRequest {
		query:    request.query.as_str(),
		workflow: KagiWorkflow::Search,
		limit:    request.max_results,
	};
	serde_json::to_vec(&wire)
		.map(Bytes::from)
		.map_err(|_| encoding_error("kagi_search_request_serialization"))
}

fn join_search_uri(base: &str) -> Result<Str, Error> {
	let mut url = Url::parse(base).map_err(|_| encoding_error("kagi_search_base_url_invalid"))?;
	if !matches!(url.scheme(), "http" | "https")
		|| url.host_str().is_none()
		|| url.query().is_some()
		|| url.fragment().is_some()
	{
		return Err(encoding_error("kagi_search_base_url_invalid"));
	}
	url.path_segments_mut()
		.map_err(|()| encoding_error("kagi_search_base_url_invalid"))?
		.pop_if_empty()
		.push(SEARCH_PATH_SEGMENT);
	Ok(Str::new(&url))
}

/// Bounded unary decoder for Kagi v1 Search API responses.
#[derive(Debug, Default)]
pub struct KagiSearchDecoder {
	buffer:   BytesMut,
	finished: bool,
}

impl KagiSearchDecoder {
	/// Creates fresh state for one Kagi search response.
	pub fn new() -> Self {
		Self { buffer: BytesMut::new(), finished: false }
	}
}

impl Decoder for KagiSearchDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("kagi_search_unexpected_frame"));
		};
		let observed = self.buffer.len().saturating_add(bytes.len());
		if observed as u64 > MAX_RESPONSE_BYTES {
			self.buffer.clear();
			self.finished = true;
			return Err(protocol_error("kagi_search_response_too_large"));
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
			return Err(protocol_error("kagi_search_response_missing"));
		}
		let bytes = self.buffer.split().freeze();
		let response: KagiResponse = serde_json::from_slice(&bytes)
			.map_err(|_| protocol_error("kagi_search_response_malformed"))?;
		match response {
			KagiResponse::ApiError(response) => {
				let error = response
					.error
					.into_iter()
					.next()
					.ok_or_else(|| protocol_error("kagi_search_api_error_missing"))?;
				emit(RawEvent::Failure(api_error(error.code.as_str())));
			},
			KagiResponse::Search(response) => {
				emit(RawEvent::Answer(AnswerBody::Search(project_results(response.data))));
			},
		}
		Ok(())
	}
}

#[derive(Deserialize)]
#[serde(untagged)]
enum KagiResponse {
	ApiError(KagiErrorResponse),
	Search(KagiSearchResponse),
}

#[derive(Deserialize)]
struct KagiSearchResponse {
	data: KagiData,
}

#[derive(Deserialize)]
struct KagiErrorResponse {
	error: Vec<KagiApiError>,
}

#[derive(Deserialize)]
struct KagiApiError {
	code: Str,
}

#[derive(Default, Deserialize)]
struct KagiData {
	#[serde(default)]
	search:  Option<Vec<KagiSearchRecord>>,
	#[serde(default)]
	news:    Option<Vec<KagiNewsRecord>>,
	#[serde(default)]
	video:   Option<Vec<KagiVideoRecord>>,
	#[serde(default)]
	infobox: Option<Vec<KagiInfoboxRecord>>,
}

#[derive(Deserialize)]
#[serde(transparent)]
struct KagiSearchRecord(KagiUrlRecord);

#[derive(Deserialize)]
#[serde(transparent)]
struct KagiNewsRecord(KagiUrlRecord);

#[derive(Deserialize)]
#[serde(transparent)]
struct KagiVideoRecord(KagiUrlRecord);

#[derive(Deserialize)]
#[serde(transparent)]
struct KagiInfoboxRecord(KagiUrlRecord);

#[derive(Deserialize)]
struct KagiUrlRecord {
	#[serde(default)]
	url:     Option<Str>,
	#[serde(default)]
	title:   Option<Str>,
	#[serde(default)]
	snippet: Option<Str>,
	#[serde(default)]
	time:    Option<Str>,
}

/// The wire discriminant is the official containing bucket. Keeping it typed
/// prevents unrelated Kagi record buckets from entering canonical results.
enum KagiRecord {
	Search(KagiSearchRecord),
	News(KagiNewsRecord),
	Video(KagiVideoRecord),
	Infobox(KagiInfoboxRecord),
}

impl KagiRecord {
	fn into_url_record(self) -> KagiUrlRecord {
		match self {
			Self::Search(KagiSearchRecord(record))
			| Self::News(KagiNewsRecord(record))
			| Self::Video(KagiVideoRecord(record))
			| Self::Infobox(KagiInfoboxRecord(record)) => record,
		}
	}
}

fn project_results(data: KagiData) -> SearchResults {
	// Kagi does not define ordering across categorized buckets. This fixed
	// documented bucket order preserves provider order within each bucket.
	let records = data
		.search
		.into_iter()
		.flatten()
		.map(KagiRecord::Search)
		.chain(data.video.into_iter().flatten().map(KagiRecord::Video))
		.chain(data.news.into_iter().flatten().map(KagiRecord::News))
		.chain(data.infobox.into_iter().flatten().map(KagiRecord::Infobox));
	let results = records
		.filter_map(|record| project_record(record.into_url_record()))
		.enumerate()
		.map(|(index, mut result)| {
			result.rank = u32::try_from(index + 1).unwrap_or(u32::MAX);
			result
		})
		.collect();
	SearchResults {
		results,
		answer: None,
		usage: Usage { search_calls: 1, source: UsageSource::Measured, ..Usage::default() },
		metadata: Default::default(),
	}
}

fn project_record(record: KagiUrlRecord) -> Option<SearchResult> {
	let url = validated_url(record.url?)?;
	let title = record
		.title
		.and_then(trimmed)
		.unwrap_or_else(|| url.clone());
	Some(SearchResult {
		rank: 0,
		url,
		title,
		snippet: record.snippet.and_then(trimmed),
		score: None,
		published_at: record.time.as_deref().and_then(parse_rfc3339),
		author: None,
	})
}

fn validated_url(value: Str) -> Option<Str> {
	let value = trimmed(value)?;
	let parsed = Url::parse(value.as_str()).ok()?;
	(matches!(parsed.scheme(), "http" | "https") && parsed.host_str().is_some()).then_some(value)
}

fn trimmed(value: Str) -> Option<Str> {
	let text = value.trim();
	if text.is_empty() {
		None
	} else if text.len() == value.len() {
		Some(value)
	} else {
		Some(text)
	}
}

fn codec_mismatch(reason: &'static str) -> Error {
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
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn api_error(_provider_code: &str) -> Error {
	Error::new(
		ErrorKind::InvalidRequest,
		ErrorPhase::Streaming,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.code(sf!("kagi_api_error"))
	.detail(ErrorDetail::provider(sf!("Kagi Search request failed")))
}

#[cfg(test)]
mod tests {
	use std::{
		sync::Arc,
		time::{Duration, UNIX_EPOCH},
	};

	use super::*;
	use crate::call::{NegotiationPolicy, Setting};

	fn request() -> SearchRequest {
		SearchRequest {
			query: sf!("rust sans-I/O"),
			include_domains: Arc::from([]),
			exclude_domains: Arc::from([]),
			recency: None,
			locale: None,
			max_results: 7,
			synthesize_answer: Setting::Unset,
			negotiation: NegotiationPolicy::default(),
			..SearchRequest::new(sf!("rust sans-I/O"), 7)
		}
	}

	#[test]
	fn request_matches_official_v1_wire_shape_exactly() {
		assert_eq!(
			encode_request_body(&request()).expect("request").as_ref(),
			br#"{"query":"rust sans-I/O","workflow":"search","limit":7}"#,
		);
		assert_eq!(
			join_search_uri("https://kagi.com/api/v1/")
				.expect("endpoint")
				.as_str(),
			"https://kagi.com/api/v1/search",
		);
	}

	#[test]
	fn mixed_typed_buckets_preserve_fixed_and_source_order() {
		let fixture = br#"{
			"meta":{"trace":"trace-id"},
			"data":{
				"search":[
					{"url":"https://example.com/first","title":"First","snippet":" first snippet ","time":"1970-01-01T00:00:01Z"},
					{"url":"https://example.com/second","title":"Second"}
				],
				"news":[{"url":"https://news.example/item","title":"News","time":"2025-01-02T03:04:05+01:30"}],
				"video":[{"url":"https://video.example/watch","title":"Video","time":"2h ago"}],
				"infobox":[
					{"title":"No canonical URL","snippet":"must not be fabricated"},
					{"url":"https://info.example/person","title":"Info"}
				],
				"direct_answer":[{"url":"https://ignored.example/answer","title":"Unrelated"}],
				"weather":[{"url":"https://ignored.example/weather","title":"Unrelated"}]
			}
		}"#;
		let mut decoder = KagiSearchDecoder::new();
		let mut events = Vec::new();
		for chunk in fixture.chunks(11) {
			decoder
				.push(Frame::Raw(Bytes::copy_from_slice(chunk)), &mut |event| events.push(event))
				.expect("response fragment");
		}
		assert!(events.is_empty());
		decoder
			.finish(&mut |event| events.push(event))
			.expect("response");
		let [RawEvent::Answer(AnswerBody::Search(answer))] = events.as_slice() else {
			panic!("one typed search answer expected");
		};
		assert_eq!(answer.results.len(), 5);
		assert_eq!(
			answer
				.results
				.iter()
				.map(|result| result.rank)
				.collect::<Vec<_>>(),
			vec![1, 2, 3, 4, 5]
		);
		assert_eq!(
			answer
				.results
				.iter()
				.map(|result| result.title.as_str())
				.collect::<Vec<_>>(),
			vec!["First", "Second", "Video", "News", "Info"],
		);
		assert_eq!(answer.results[0].snippet.as_deref(), Some("first snippet"));
		assert_eq!(answer.results[0].published_at, Some(UNIX_EPOCH + Duration::from_secs(1)));
		assert_eq!(answer.results[2].published_at, None);
		assert!(answer.results[3].published_at.is_some());
		assert_eq!(answer.usage.search_calls, 1);
		assert_eq!(answer.usage.source, UsageSource::Measured);
	}

	#[test]
	fn api_error_is_typed_and_does_not_retain_provider_message() {
		let fixture = br#"{
			"meta":{"trace":"trace-id"},
			"data":[],
			"error":[{
				"code":"request.invalid",
				"url":"https://help.kagi.com/api/errors#request.invalid",
				"message":"Bearer secret-must-not-survive",
				"location":"query"
			}]
		}"#;
		let mut decoder = KagiSearchDecoder::new();
		let mut events = Vec::new();
		decoder
			.push(Frame::Raw(Bytes::from_static(fixture)), &mut |event| events.push(event))
			.expect("typed API error");
		decoder
			.finish(&mut |event| events.push(event))
			.expect("typed API error");
		let [RawEvent::Failure(error)] = events.as_slice() else {
			panic!("failure expected")
		};
		assert_eq!(error.kind, ErrorKind::InvalidRequest);
		assert_eq!(error.code.as_deref(), Some("kagi_api_error"));
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Provider { sanitized_message }) if sanitized_message.as_str() == "Kagi Search request failed"
		));
		assert!(!format!("{error:?}").contains("secret-must-not-survive"));
	}

	#[test]
	fn malformed_wrong_frame_and_oversize_responses_fail_bounded() {
		let mut malformed = KagiSearchDecoder::new();
		malformed
			.push(Frame::Raw(Bytes::from_static(b"{not-json")), &mut |_| {})
			.expect("bounded fragment");
		let error = malformed.finish(&mut |_| {}).expect_err("malformed JSON");
		assert_eq!(error.kind, ErrorKind::Protocol);

		let mut wrong_frame = KagiSearchDecoder::new();
		assert!(
			wrong_frame
				.push(Frame::Ndjson(Bytes::from_static(b"{}")), &mut |_| {})
				.is_err()
		);

		let mut oversize = KagiSearchDecoder::new();
		let bytes = Bytes::from(vec![b' '; MAX_RESPONSE_BYTES as usize + 1]);
		let error = oversize
			.push(Frame::Raw(bytes), &mut |_| {})
			.expect_err("oversize");
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Protocol { reason }) if reason.0.as_str() == "kagi_search_response_too_large"
		));
	}
}
