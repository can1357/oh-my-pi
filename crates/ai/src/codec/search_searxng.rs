//! Self-hosted `SearXNG` JSON API codec.
use super::search_json::{JsonSearchCodec, JsonSearchStyle, encode};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable `SearXNG` codec identifier.
pub const CODEC_ID: &str = "search-searxng";
/// `SearXNG` standalone web-search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct SearxngSearchCodec;
impl SearxngSearchCodec {
	/// Creates the codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns its stable identifier.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}
impl Codec for SearxngSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Search(request) = operation else {
			return JsonSearchCodec { style: JsonSearchStyle::Searxng }.encode(context, operation);
		};
		encode(
			JsonSearchStyle::Searxng,
			request
				.endpoint_override
				.as_deref()
				.unwrap_or(context.route.endpoint.base_url.as_str()),
			request,
		)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Searxng }.decoder(context)
	}
}
