//! Jina Search Foundation API codec.
use super::search_json::{JsonSearchCodec, JsonSearchStyle};
use crate::{
	call::OperationCall,
	codec::{Codec, DecodeContext, DecoderState, EncodeContext, EncodedRequest},
	error::Error,
};
/// Stable Jina codec identifier.
pub const CODEC_ID: &str = "search-jina";
/// Jina standalone web-search codec.
#[derive(Clone, Copy, Debug, Default)]
pub struct JinaSearchCodec;
impl JinaSearchCodec {
	/// Creates the codec.
	pub const fn new() -> Self {
		Self
	}

	/// Returns its stable identifier.
	pub const fn id(self) -> &'static str {
		CODEC_ID
	}
}
impl Codec for JinaSearchCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Jina }.encode(context, operation)
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		JsonSearchCodec { style: JsonSearchStyle::Jina }.decoder(context)
	}
}
