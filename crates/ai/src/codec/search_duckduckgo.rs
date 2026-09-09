//! `DuckDuckGo` credential-free HTML search codec.
use super::search_scraper::{ScraperSearchCodec, ScraperStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable codec identifier.
pub const CODEC_ID: &str = "search-duckduckgo";
/// `DuckDuckGo` standalone search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct DuckduckgoSearchCodec;
impl Codec for DuckduckgoSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		ScraperSearchCodec { style: ScraperStyle::DuckDuckGo }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		ScraperSearchCodec { style: ScraperStyle::DuckDuckGo }.decoder(context)
	}
}
