//! Ecosia credential-free HTML search codec.
use super::search_scraper::{ScraperSearchCodec, ScraperStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable codec identifier.
pub const CODEC_ID: &str = "search-ecosia";
/// Ecosia standalone search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct EcosiaSearchCodec;
impl Codec for EcosiaSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		ScraperSearchCodec { style: ScraperStyle::Ecosia }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		ScraperSearchCodec { style: ScraperStyle::Ecosia }.decoder(context)
	}
}
