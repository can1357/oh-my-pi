//! Shared credential-free HTML search codec.

use std::str;

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, sf};
use url::Url;

use crate::{
	answer::{AnswerBody, SearchResult, SearchResults},
	body::BodySource,
	call::OperationCall,
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest, RawEvent,
		RequestHeader, RequestMethod, SizeBounds,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	receipt::{ExecutionReceipt, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

const MAX_BODY: u64 = 4 * 1024 * 1024;
#[derive(Clone, Copy, Debug)]
pub enum ScraperStyle {
	DuckDuckGo,
	Google,
	Startpage,
	Ecosia,
	Mojeek,
}
#[derive(Clone, Copy, Debug)]
pub struct ScraperSearchCodec {
	pub style: ScraperStyle,
}
impl Codec for ScraperSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return Err(error(ErrorKind::CodecMismatch, "scraper_search_operation_required"));
		};
		let mut url = Url::parse(context.route.endpoint.base_url.as_str())
			.map_err(|_| error(ErrorKind::InvalidRequest, "scraper_search_url_invalid"))?;
		let path = match self.style {
			ScraperStyle::DuckDuckGo => "/html/",
			ScraperStyle::Google => "/search",
			ScraperStyle::Startpage => "/sp/search",
			ScraperStyle::Ecosia | ScraperStyle::Mojeek => "/search",
		};
		url.set_path(path);
		url.query_pairs_mut()
			.clear()
			.append_pair(
				if matches!(self.style, ScraperStyle::Startpage) {
					"query"
				} else {
					"q"
				},
				request.query.as_str(),
			)
			.append_pair("num", &request.max_results.to_string());
		let headers = navigation_headers(self.style);
		Ok(EncodedRequest::new(
			OperationKind::Search,
			RequestMethod::Get,
			Str::new(url.as_str()),
			headers,
			BodySource::Bytes(Bytes::new()),
			FramingProtocol::Raw,
			SizeBounds { request_body: 0, frame: MAX_BODY, response: MAX_BODY },
		))
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if context.operation != OperationKind::Search || context.framing != FramingProtocol::Raw {
			return Err(error(ErrorKind::CodecMismatch, "scraper_search_decode_context_invalid"));
		}
		Ok(Box::new(ScraperDecoder {
			buffer:        BytesMut::new(),
			finished:      false,
			browser_retry: false,
		}))
	}
}
fn navigation_headers(style: ScraperStyle) -> Box<[RequestHeader]> {
	let user_agent = match style {
		ScraperStyle::DuckDuckGo | ScraperStyle::Ecosia => {
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 \
			 Safari/605.1.15"
		},
		ScraperStyle::Google | ScraperStyle::Mojeek => {
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36"
		},
		ScraperStyle::Startpage => {
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"
		},
	};
	Box::new([
		RequestHeader { name: sf!("accept"), value: sf!("text/html,application/xhtml+xml") },
		RequestHeader { name: sf!("accept-language"), value: sf!("en-US,en;q=0.8") },
		RequestHeader { name: sf!("user-agent"), value: Str::new_static(user_agent) },
	])
}
struct ScraperDecoder {
	buffer:        BytesMut,
	finished:      bool,
	browser_retry: bool,
}
impl Decoder for ScraperDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let Frame::Raw(bytes) = frame else {
			return Err(error(ErrorKind::ProviderContractMismatch, "scraper_search_unexpected_frame"));
		};
		if self.buffer.len().saturating_add(bytes.len()) > MAX_BODY as usize {
			return Err(error(
				ErrorKind::ProviderContractMismatch,
				"scraper_search_response_too_large",
			));
		}
		self.buffer.extend_from_slice(&bytes);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		let html = str::from_utf8(&self.buffer).map_err(|_| {
			error(ErrorKind::ProviderContractMismatch, "scraper_search_response_not_utf8")
		})?;
		if challenged(html) {
			self.browser_retry = true;
			return Err(error(
				ErrorKind::RouteUnavailable,
				"scraper_search_browser_escalation_required",
			));
		}
		let results = parse_links(html);
		if results.is_empty() {
			return Err(error(ErrorKind::ProviderContractMismatch, "scraper_search_no_results"));
		}
		emit(RawEvent::Answer(AnswerBody::Search(SearchResults {
			results,
			answer: None,
			usage: Usage { search_calls: 1, source: UsageSource::Measured, ..Usage::default() },
			metadata: Default::default(),
		})));
		Ok(())
	}

	fn prepare_browser_retry(&mut self) -> bool {
		if !self.browser_retry {
			return false;
		}
		self.buffer.clear();
		self.finished = false;
		self.browser_retry = false;
		true
	}
}
fn challenged(html: &str) -> bool {
	let lower = html.to_ascii_lowercase();
	["captcha", "unusual traffic", "verify you are human", "cf-chl-", "challenge-platform"]
		.iter()
		.any(|marker| lower.contains(marker))
}
fn parse_links(html: &str) -> Vec<SearchResult> {
	let mut results = Vec::new();
	let mut rest = html;
	while results.len() < 20 {
		let Some(anchor) = rest.find("<a") else { break };
		rest = &rest[anchor + 2..];
		let Some(href_at) = rest.find("href=") else {
			continue;
		};
		let tail = &rest[href_at + 5..];
		let Some(quote) = tail
			.as_bytes()
			.first()
			.copied()
			.filter(|byte| matches!(byte, b'\'' | b'\"'))
		else {
			continue;
		};
		let tail = &tail[1..];
		let Some(end) = tail.as_bytes().iter().position(|byte| *byte == quote) else {
			continue;
		};
		let raw_url = &tail[..end];
		rest = &tail[end + 1..];
		let Some(close) = rest.find('>') else {
			continue;
		};
		let title_tail = &rest[close + 1..];
		let Some(end_anchor) = title_tail.find("</a>") else {
			continue;
		};
		let title = strip_tags(&title_tail[..end_anchor]);
		let url = decode_redirect(raw_url);
		if title.len() < 2 || !url.starts_with("http") {
			continue;
		}
		results.push(SearchResult {
			rank:         u32::try_from(results.len() + 1).unwrap_or(u32::MAX),
			url:          Str::new(url),
			title:        Str::new(title),
			snippet:      None,
			score:        None,
			published_at: None,
			author:       None,
		});
	}
	results
}
fn decode_redirect(raw: &str) -> String {
	if let Some(query) = raw
		.strip_prefix("/url?")
		.or_else(|| raw.strip_prefix("//duckduckgo.com/l/?"))
	{
		for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
			if matches!(key.as_ref(), "q" | "uddg") {
				return value.into_owned();
			}
		}
	}
	raw.to_owned()
}
fn strip_tags(input: &str) -> String {
	let mut output = String::new();
	let mut tag = false;
	for ch in input.chars() {
		match ch {
			'<' => tag = true,
			'>' => tag = false,
			_ if !tag => output.push(ch),
			_ => {},
		}
	}
	output
		.replace("&amp;", "&")
		.replace("&quot;", "\"")
		.replace("&#39;", "'")
		.trim()
		.to_owned()
}
fn error(kind: ErrorKind, reason: &'static str) -> Error {
	Error::new(kind, ErrorPhase::Streaming, RetryAction::ReselectRoute, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(sf!(reason))))
}
