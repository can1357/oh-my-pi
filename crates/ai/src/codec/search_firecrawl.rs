//! Firecrawl v2 standalone search codec.

use super::search_json::{JsonSearchCodec, JsonSearchStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};

/// Stable Firecrawl codec identifier.
pub const CODEC_ID: &str = "search-firecrawl";
/// Firecrawl standalone search codec, including explicit keyless requests.
#[derive(Clone, Copy, Debug, Default)]
pub struct FirecrawlSearchCodec;
impl FirecrawlSearchCodec {
	/// Creates the codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns its stable identifier.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}
impl Codec for FirecrawlSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Firecrawl }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Firecrawl }.decoder(context)
	}
}
