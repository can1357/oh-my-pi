//! `TinyFish` Search API codec.
use super::search_json::{JsonSearchCodec, JsonSearchStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable `TinyFish` codec identifier.
pub const CODEC_ID: &str = "search-tinyfish";
/// `TinyFish` standalone web-search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct TinyfishSearchCodec;
impl TinyfishSearchCodec {
	/// Creates the codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns its stable identifier.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}
impl Codec for TinyfishSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Tinyfish }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Tinyfish }.decoder(context)
	}
}
