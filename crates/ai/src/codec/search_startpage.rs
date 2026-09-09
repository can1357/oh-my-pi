//! Startpage credential-free HTML search codec.
use super::search_scraper::{ScraperSearchCodec, ScraperStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable codec identifier.
pub const CODEC_ID: &str = "search-startpage";
/// Startpage standalone search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct StartpageSearchCodec;
impl Codec for StartpageSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		ScraperSearchCodec { style: ScraperStyle::Startpage }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		ScraperSearchCodec { style: ScraperStyle::Startpage }.decoder(context)
	}
}
