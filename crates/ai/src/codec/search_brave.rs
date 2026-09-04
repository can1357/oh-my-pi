//! Brave Search API codec.
use super::search_json::{JsonSearchCodec, JsonSearchStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable Brave codec identifier.
pub const CODEC_ID: &str = "search-brave";
/// Brave standalone web-search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct BraveSearchCodec;
impl BraveSearchCodec {
	/// Creates the codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns its stable identifier.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}
impl Codec for BraveSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Brave }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Brave }.decoder(context)
	}
}
