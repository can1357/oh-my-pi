//! Google credential-free HTML search codec.
use super::search_scraper::{ScraperSearchCodec, ScraperStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable codec identifier.
pub const CODEC_ID: &str = "search-google";
/// Google standalone search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct GoogleSearchCodec;
impl Codec for GoogleSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		ScraperSearchCodec { style: ScraperStyle::Google }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		ScraperSearchCodec { style: ScraperStyle::Google }.decoder(context)
	}
}
