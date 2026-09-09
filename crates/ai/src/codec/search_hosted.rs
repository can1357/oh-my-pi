//! Standalone hosted-search codecs for Kimi, Z.AI, and Synthetic.

use bytes::{Bytes, BytesMut};
use omp_catalog::OperationKind;
use omp_core::{Str, sf};
use serde::{Deserialize, Serialize};

use super::openai_chat;
use crate::{
	answer::{AnswerBody, SearchCitation, SearchMetadata, SearchResult, SearchResults},
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

const MAX_REQUEST_BYTES: u64 = 512 * 1024;
const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Copy, Debug)]
enum HostedProfile {
	Kimi,
	Zai,
	Synthetic,
}

impl HostedProfile {
	const fn tool(self) -> HostedTool<'static> {
		match self {
			Self::Kimi => HostedTool::Builtin {
				kind:     "builtin_function",
				function: BuiltinFunction { name: "$web_search" },
			},
			Self::Zai | Self::Synthetic => HostedTool::Named { kind: "web_search" },
		}
	}
}

macro_rules! hosted_codec {
	($name:ident, $id:literal, $profile:expr) => {
		#[doc = concat!("Standalone hosted-search codec for `", $id, "`.")]
		#[derive(Clone, Copy, Debug, Default)]
		pub struct $name;

		impl $name {
			/// Returns the stable catalog codec identifier.
			pub const fn id(self) -> &'static str {
				$id
			}
		}

		impl Codec for $name {
			fn encode(
				&self,
				context: &EncodeContext<'_>,
				operation: &OperationCall,
			) -> Result<EncodedRequest, Error> {
				encode_hosted($profile, context, operation)
			}

			fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
				decoder(context)
			}
		}
	};
}

hosted_codec!(KimiSearchCodec, "search-kimi", HostedProfile::Kimi);
hosted_codec!(ZaiSearchCodec, "search-zai", HostedProfile::Zai);
hosted_codec!(SyntheticSearchCodec, "search-synthetic", HostedProfile::Synthetic);

#[derive(Serialize)]
struct HostedRequest<'a> {
	model:    &'static str,
	messages: [HostedMessage<'a>; 1],
	tools:    [HostedTool<'static>; 1],
	stream:   bool,
}

#[derive(Serialize)]
struct HostedMessage<'a> {
	role:    &'static str,
	content: &'a str,
}

#[derive(Clone, Copy, Serialize)]
#[serde(untagged)]
enum HostedTool<'a> {
	Builtin {
		#[serde(rename = "type")]
		kind:     &'a str,
		function: BuiltinFunction<'a>,
	},
	Named {
		#[serde(rename = "type")]
		kind: &'a str,
	},
}

#[derive(Clone, Copy, Serialize)]
struct BuiltinFunction<'a> {
	name: &'a str,
}

fn encode_hosted(
	profile: HostedProfile,
	context: &EncodeContext<'_>,
	operation: &OperationCall,
) -> Result<EncodedRequest, Error> {
	let OperationCall::Search(request) = operation else {
		return Err(codec_error("hosted_search_operation_required"));
	};
	if request.query.trim().is_empty() {
		return Err(encoding_error("hosted_search_query_empty"));
	}
	let body = serde_json::to_vec(&HostedRequest {
		model:    omp_catalog::provider_default_wire_model(context.route.provider.as_str())
			.expect("hosted search provider declares a default wire model"),
		messages: [HostedMessage { role: "user", content: request.query.as_str() }],
		tools:    [profile.tool()],
		stream:   false,
	})
	.map_err(|_| encoding_error("hosted_search_request_serialization_failed"))?;
	if body.len() as u64 > MAX_REQUEST_BYTES {
		return Err(encoding_error("hosted_search_request_too_large"));
	}
	Ok(EncodedRequest::new(
		OperationKind::Search,
		RequestMethod::Post,
		openai_chat::join_uri(context.route.endpoint.base_url.as_str(), "/chat/completions"),
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

fn decoder(context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
	if context.operation != OperationKind::Search
		|| !matches!(context.operation_call, OperationCall::Search(_))
		|| context.framing != FramingProtocol::Raw
	{
		return Err(codec_error("hosted_search_decode_context_mismatch"));
	}
	let OperationCall::Search(request) = context.operation_call else {
		unreachable!();
	};
	Ok(Box::new(HostedDecoder {
		bytes:       BytesMut::new(),
		finished:    false,
		max_results: request.max_results as usize,
	}))
}

struct HostedDecoder {
	bytes:       BytesMut,
	finished:    bool,
	max_results: usize,
}

impl Decoder for HostedDecoder {
	fn push(&mut self, frame: Frame, _emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		let Frame::Raw(bytes) = frame else {
			return Err(protocol_error("hosted_search_unexpected_frame"));
		};
		if self.finished || self.bytes.len().saturating_add(bytes.len()) > MAX_RESPONSE_BYTES as usize
		{
			return Err(protocol_error("hosted_search_response_too_large_or_finished"));
		}
		self.bytes.extend_from_slice(&bytes);
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.finished {
			return Ok(());
		}
		self.finished = true;
		let response: HostedResponse = serde_json::from_slice(&self.bytes)
			.map_err(|_| protocol_error("hosted_search_response_malformed"))?;
		let HostedResponse { mut choices, mut search_results, citations, annotations, usage } =
			response;
		choices.sort_by_key(|choice| choice.index);
		let answer = choices
			.into_iter()
			.next()
			.and_then(|choice| choice.message.content)
			.filter(|content| !content.trim().is_empty());
		let mut citations = citations
			.into_iter()
			.map(WireCitation::into_parts)
			.collect::<Vec<_>>();
		citations.extend(
			annotations
				.into_iter()
				.map(|annotation| (annotation.url, annotation.title, annotation.text)),
		);
		citations.retain(|(url, ..)| !url.trim().is_empty());
		if search_results.is_empty() {
			search_results.extend(citations.iter().map(|(url, title, snippet)| WireResult {
				url:     url.clone(),
				title:   title.clone().unwrap_or_else(|| url.clone()),
				snippet: snippet.clone(),
			}));
		}
		search_results.truncate(self.max_results);
		let results = search_results
			.into_iter()
			.enumerate()
			.filter(|(_, result)| !result.url.trim().is_empty())
			.map(|(index, result)| SearchResult {
				rank:         u32::try_from(index + 1).unwrap_or(u32::MAX),
				url:          result.url,
				title:        result.title,
				snippet:      result.snippet,
				score:        None,
				published_at: None,
				author:       None,
			})
			.collect();
		let citations = citations
			.into_iter()
			.map(|(url, title, cited_text)| SearchCitation {
				url,
				title,
				cited_text,
				start: None,
				end: None,
			})
			.collect();
		let usage = usage.unwrap_or_default();
		emit(RawEvent::Answer(AnswerBody::Search(SearchResults {
			results,
			answer,
			usage: Usage {
				input_tokens: usage.prompt_tokens,
				output_tokens: usage.completion_tokens,
				search_calls: 1,
				source: UsageSource::Measured,
				..Usage::default()
			},
			metadata: SearchMetadata { citations, ..SearchMetadata::default() },
		})));
		Ok(())
	}
}

#[derive(Default, Deserialize)]
struct HostedResponse {
	#[serde(default)]
	choices:        Vec<HostedChoice>,
	#[serde(default)]
	search_results: Vec<WireResult>,
	#[serde(default)]
	citations:      Vec<WireCitation>,
	#[serde(default)]
	annotations:    Vec<WireAnnotation>,
	#[serde(default)]
	usage:          Option<WireUsage>,
}

#[derive(Deserialize)]
struct HostedChoice {
	#[serde(default)]
	index:   u32,
	message: HostedResponseMessage,
}

#[derive(Deserialize)]
struct HostedResponseMessage {
	#[serde(default)]
	content: Option<Str>,
}

#[derive(Clone, Deserialize)]
struct WireResult {
	url:     Str,
	#[serde(default)]
	title:   Str,
	#[serde(default, alias = "content")]
	snippet: Option<Str>,
}

#[derive(Clone, Deserialize)]
#[serde(untagged)]
enum WireCitation {
	Url(Str),
	Object {
		url:     Str,
		#[serde(default)]
		title:   Option<Str>,
		#[serde(default, alias = "text", alias = "content")]
		snippet: Option<Str>,
	},
}

impl WireCitation {
	fn into_parts(self) -> (Str, Option<Str>, Option<Str>) {
		match self {
			Self::Url(url) => (url, None, None),
			Self::Object { url, title, snippet } => (url, title, snippet),
		}
	}
}

#[derive(Deserialize)]
struct WireAnnotation {
	#[serde(alias = "uri")]
	url:   Str,
	#[serde(default)]
	title: Option<Str>,
	#[serde(default, alias = "content")]
	text:  Option<Str>,
}

#[derive(Default, Deserialize)]
struct WireUsage {
	#[serde(default, alias = "input_tokens")]
	prompt_tokens:     u64,
	#[serde(default, alias = "output_tokens")]
	completion_tokens: u64,
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
