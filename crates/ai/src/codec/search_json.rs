//! Shared bounded codec machinery for standalone JSON search APIs.

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, sf};
use serde_json::{Value, json};
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

pub const MAX_REQUEST_BYTES: u64 = 64 * 1024;
pub const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
pub enum JsonSearchStyle {
	Firecrawl,
	Brave,
	Jina,
	Tinyfish,
	Searxng,
}

#[derive(Clone, Copy, Debug)]
pub struct JsonSearchCodec {
	pub style: JsonSearchStyle,
}

impl Codec for JsonSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return Err(encoding_error("json_search_operation_required"));
		};
		encode(self.style, context.route.endpoint.base_url.as_str(), request)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if context.operation != OperationKind::Search
			|| !matches!(context.operation_call, OperationCall::Search(_))
			|| context.framing != FramingProtocol::Raw
		{
			return Err(encoding_error("json_search_decode_context_invalid"));
		}
		Ok(Box::new(JsonSearchDecoder {
			style:    self.style,
			buffer:   BytesMut::new(),
			finished: false,
		}))
	}
}

pub fn encode(
	style: JsonSearchStyle,
	base: &str,
	request: &SearchRequest,
) -> Result<EncodedRequest, Error> {
	if request.query.trim().is_empty() || !(1..=100).contains(&request.max_results) {
		return Err(encoding_error("json_search_request_invalid"));
	}
	let mut url = Url::parse(base).map_err(|_| encoding_error("json_search_base_url_invalid"))?;
	if url.cannot_be_a_base()
		|| url.fragment().is_some()
		|| url.username() != ""
		|| url.password().is_some()
	{
		return Err(encoding_error("json_search_base_url_invalid"));
	}
	let (method, body, suffix) = match style {
		JsonSearchStyle::Firecrawl => (
			RequestMethod::Post,
			Some(
				json!({"query": request.query.as_str(), "limit": request.max_results, "sources": [{"type":"web"}]}),
			),
			"/search",
		),
		JsonSearchStyle::Brave => (RequestMethod::Get, None, "/res/v1/web/search"),
		JsonSearchStyle::Jina => (RequestMethod::Get, None, ""),
		JsonSearchStyle::Tinyfish => (RequestMethod::Get, None, ""),
		JsonSearchStyle::Searxng => (RequestMethod::Get, None, "/search"),
	};
	let mut path = url.path().trim_end_matches('/').to_owned();
	path.push_str(suffix);
	url.set_path(&path);
	let count = request.max_results.to_string();
	match style {
		JsonSearchStyle::Brave | JsonSearchStyle::Searxng => {
			let mut pairs = url.query_pairs_mut();
			pairs.clear().append_pair("q", request.query.as_str());
			if matches!(style, JsonSearchStyle::Searxng) {
				pairs.append_pair("format", "json");
			} else {
				pairs.append_pair("count", &count);
			}
			if let Some(locale) = request.locale.as_deref() {
				pairs.append_pair("language", locale);
			}
		},
		JsonSearchStyle::Jina => {
			let mut path = url.path().trim_end_matches('/').to_owned();
			path.push('/');
			path.push_str(request.query.as_str());
			url.set_path(&path);
			url.query_pairs_mut().append_pair("count", &count);
		},
		JsonSearchStyle::Tinyfish => {
			let mut pairs = url.query_pairs_mut();
			pairs
				.clear()
				.append_pair("query", request.query.as_str())
				.append_pair("num_results", &count);
			if let Some(locale) = request.locale.as_deref() {
				pairs.append_pair("language", locale);
			}
			if !request.include_domains.is_empty() {
				pairs.append_pair(
					"include_domains",
					&request
						.include_domains
						.iter()
						.map(Str::as_str)
						.collect::<Vec<_>>()
						.join(","),
				);
			}
			if !request.exclude_domains.is_empty() {
				pairs.append_pair(
					"exclude_domains",
					&request
						.exclude_domains
						.iter()
						.map(Str::as_str)
						.collect::<Vec<_>>()
						.join(","),
				);
			}
		},
		JsonSearchStyle::Firecrawl => {},
	}
	let bytes = body.map_or_else(Vec::new, |value| serde_json::to_vec(&value).unwrap_or_default());
	if bytes.len() as u64 > MAX_REQUEST_BYTES {
		return Err(encoding_error("json_search_request_too_large"));
	}
	let headers =
		[RequestHeader { name: sf!("accept"), value: sf!("application/json") }, RequestHeader {
			name:  sf!("content-type"),
			value: sf!("application/json"),
		}];
	Ok(EncodedRequest::new(
		OperationKind::Search,
		method,
		Str::new(url.as_str()),
		Box::new(headers),
		BodySource::Bytes(Bytes::from(bytes)),
		FramingProtocol::Raw,
		SizeBounds {
			request_body: MAX_REQUEST_BYTES,
			frame:        MAX_RESPONSE_BYTES,
			response:     MAX_RESPONSE_BYTES,
		},
	))
}

struct JsonSearchDecoder {
	style:    JsonSearchStyle,
	buffer:   BytesMut,
	finished: bool,
}

impl Decoder for JsonSearchDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("json_search_unexpected_frame"));
		};
		if self.buffer.len().saturating_add(bytes.len()) > MAX_RESPONSE_BYTES as usize {
			self.finished = true;
			self.buffer.clear();
			return Err(protocol_error("json_search_response_too_large"));
		}
		self.buffer.extend_from_slice(&bytes);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		let value: Value = serde_json::from_slice(&self.buffer)
			.map_err(|_| protocol_error("json_search_response_malformed"))?;
		if value.get("error").is_some() || value.get("success") == Some(&Value::Bool(false)) {
			emit(RawEvent::Failure(provider_error()));
			return Ok(());
		}
		let items = result_items(self.style, &value)
			.ok_or_else(|| protocol_error("json_search_results_missing"))?;
		let results = items
			.iter()
			.filter_map(|item| {
				let url = string(item, &["url", "link", "href"])?;
				let title = string(item, &["title", "name"]).unwrap_or(url);
				let snippet = string(item, &["description", "snippet", "content", "markdown"]);
				Some(SearchResult {
					rank:         0,
					url:          Str::new(url),
					title:        Str::new(title),
					snippet:      snippet.map(Str::new),
					score:        number(item, &["score"]),
					published_at: None,
					author:       string(item, &["author"]).map(Str::new),
				})
			})
			.enumerate()
			.map(|(index, mut result)| {
				result.rank = u32::try_from(index + 1).unwrap_or(u32::MAX);
				result
			})
			.collect();
		emit(RawEvent::Answer(AnswerBody::Search(SearchResults {
			results,
			answer: string(&value, &["answer"]).map(Str::new),
			usage: Usage { search_calls: 1, source: UsageSource::Measured, ..Usage::default() },
			metadata: Default::default(),
		})));
		Ok(())
	}
}

fn result_items(style: JsonSearchStyle, value: &Value) -> Option<&[Value]> {
	let direct = |key| value.get(key).and_then(Value::as_array).map(Vec::as_slice);
	match style {
		JsonSearchStyle::Firecrawl => direct("results").or_else(|| direct("data")).or_else(|| {
			value
				.pointer("/data/web")
				.and_then(Value::as_array)
				.map(Vec::as_slice)
		}),
		JsonSearchStyle::Brave => value
			.pointer("/web/results")
			.and_then(Value::as_array)
			.map(Vec::as_slice),
		JsonSearchStyle::Jina => value
			.as_array()
			.map(Vec::as_slice)
			.or_else(|| direct("data"))
			.or_else(|| direct("results")),
		JsonSearchStyle::Tinyfish | JsonSearchStyle::Searxng => {
			direct("results").or_else(|| direct("data"))
		},
	}
}
fn string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
	keys
		.iter()
		.find_map(|key| value.get(*key).and_then(Value::as_str))
		.filter(|value| !value.trim().is_empty())
}
fn number(value: &Value, keys: &[&str]) -> Option<f32> {
	keys
		.iter()
		.find_map(|key| value.get(*key).and_then(Value::as_f64))
		.filter(|value| value.is_finite())
		.map(|value| value as f32)
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
		RetryAction::ReselectRoute,
		ExecutionReceipt::default(),
	)
	.code(sf!("search_provider_error"))
	.detail(ErrorDetail::provider(sf!("Search provider rejected the request")))
}
