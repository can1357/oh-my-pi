//! Streaming `Content-Encoding` decoding for provider response bodies.
//!
//! Codecs may advertise compressed encodings (the Claude Code profile sends
//! `accept-encoding: gzip, deflate, br, zstd`), and providers honour them on
//! streaming responses. The framers downstream expect plain bytes, so every
//! body chunk passes through one incremental decoder selected from the
//! response's `content-encoding` header before framing. Byte accounting
//! against the response bound happens on the decoded output.

use std::io::{self, Write as _};

use bytes::Bytes;
use flate2::write::{GzDecoder, ZlibDecoder};
use http::{HeaderMap, header};
use thiserror::Error;

/// Brotli scratch buffer size; the decoder allocates once per response.
const BROTLI_BUFFER_BYTES: usize = 8 * 1024;

/// A `content-encoding` value the transport cannot decode.
#[derive(Clone, Debug, Eq, PartialEq, Error)]
#[error("unsupported content-encoding {value:?}")]
pub struct UnsupportedEncoding {
	/// Sanitized header value.
	pub value: String,
}

/// Incremental body decoder selected from one response's `content-encoding`.
pub enum ContentDecoder {
	/// Plain bytes; chunks pass through untouched.
	Identity,
	/// RFC 1952 gzip.
	Gzip(GzDecoder<Vec<u8>>),
	/// RFC 1950 zlib-wrapped deflate, the encoding HTTP `deflate` denotes.
	Deflate(ZlibDecoder<Vec<u8>>),
	/// RFC 7932 brotli.
	Brotli(Box<brotli::DecompressorWriter<Vec<u8>>>),
	/// RFC 8878 zstd.
	Zstd(zstd::stream::write::Decoder<'static, Vec<u8>>),
}

impl ContentDecoder {
	/// Selects the decoder for a response; absent or `identity` encodings pass
	/// bytes through. Stacked encodings are rejected: no provider emits them
	/// and silently decoding one layer would corrupt the framer input.
	pub fn from_headers(headers: &HeaderMap) -> Result<Self, UnsupportedEncoding> {
		let Some(value) = headers.get(header::CONTENT_ENCODING) else {
			return Ok(Self::Identity);
		};
		let value = value.to_str().map_err(|_| UnsupportedEncoding {
			value: String::from_utf8_lossy(value.as_bytes()).into_owned(),
		})?;
		let mut tokens = value
			.split(',')
			.map(str::trim)
			.filter(|token| !token.is_empty() && !token.eq_ignore_ascii_case("identity"));
		let Some(token) = tokens.next() else {
			return Ok(Self::Identity);
		};
		if tokens.next().is_some() {
			return Err(UnsupportedEncoding { value: value.to_owned() });
		}
		match token.to_ascii_lowercase().as_str() {
			"gzip" | "x-gzip" => Ok(Self::Gzip(GzDecoder::new(Vec::new()))),
			"deflate" => Ok(Self::Deflate(ZlibDecoder::new(Vec::new()))),
			"br" => Ok(Self::Brotli(Box::new(brotli::DecompressorWriter::new(
				Vec::new(),
				BROTLI_BUFFER_BYTES,
			)))),
			"zstd" => zstd::stream::write::Decoder::new(Vec::new())
				.map(Self::Zstd)
				.map_err(|_| UnsupportedEncoding { value: value.to_owned() }),
			_ => Err(UnsupportedEncoding { value: value.to_owned() }),
		}
	}

	/// Reports whether chunks pass through unchanged.
	#[must_use]
	pub const fn is_identity(&self) -> bool {
		matches!(self, Self::Identity)
	}

	/// Feeds one wire chunk and returns every decoded byte available so far.
	pub fn push(&mut self, chunk: Bytes) -> io::Result<Bytes> {
		match self {
			Self::Identity => Ok(chunk),
			Self::Gzip(decoder) => {
				decoder.write_all(&chunk)?;
				decoder.flush()?;
				Ok(take(decoder.get_mut()))
			},
			Self::Deflate(decoder) => {
				decoder.write_all(&chunk)?;
				decoder.flush()?;
				Ok(take(decoder.get_mut()))
			},
			Self::Brotli(decoder) => {
				decoder.write_all(&chunk)?;
				decoder.flush()?;
				Ok(take(decoder.get_mut()))
			},
			Self::Zstd(decoder) => {
				decoder.write_all(&chunk)?;
				decoder.flush()?;
				Ok(take(decoder.get_mut()))
			},
		}
	}

	/// Drains the decoder at end of body, failing on a truncated compressed
	/// stream.
	pub fn finish(&mut self) -> io::Result<Bytes> {
		match self {
			Self::Identity => Ok(Bytes::new()),
			Self::Gzip(decoder) => {
				decoder.try_finish()?;
				Ok(take(decoder.get_mut()))
			},
			Self::Deflate(decoder) => {
				decoder.try_finish()?;
				Ok(take(decoder.get_mut()))
			},
			Self::Brotli(decoder) => {
				decoder.flush()?;
				Ok(take(decoder.get_mut()))
			},
			Self::Zstd(decoder) => {
				decoder.flush()?;
				Ok(take(decoder.get_mut()))
			},
		}
	}
}

fn take(output: &mut Vec<u8>) -> Bytes {
	Bytes::from(std::mem::take(output))
}

#[cfg(test)]
mod tests {
	use http::HeaderValue;

	use super::*;

	fn headers(encoding: &str) -> HeaderMap {
		let mut headers = HeaderMap::new();
		headers.insert(header::CONTENT_ENCODING, HeaderValue::from_str(encoding).unwrap());
		headers
	}

	fn gzip(payload: &[u8]) -> Vec<u8> {
		let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
		encoder.write_all(payload).unwrap();
		encoder.finish().unwrap()
	}

	fn decode_in_pieces(decoder: &mut ContentDecoder, wire: &[u8], piece: usize) -> Vec<u8> {
		let mut output = Vec::new();
		for chunk in wire.chunks(piece) {
			output.extend_from_slice(&decoder.push(Bytes::copy_from_slice(chunk)).unwrap());
		}
		output.extend_from_slice(&decoder.finish().unwrap());
		output
	}

	#[test]
	fn absent_and_identity_encodings_pass_through() {
		assert!(
			ContentDecoder::from_headers(&HeaderMap::new())
				.unwrap()
				.is_identity()
		);
		assert!(
			ContentDecoder::from_headers(&headers("identity"))
				.unwrap()
				.is_identity()
		);
		let mut decoder = ContentDecoder::Identity;
		assert_eq!(decoder.push(Bytes::from_static(b"abc")).unwrap(), Bytes::from_static(b"abc"));
		assert!(decoder.finish().unwrap().is_empty());
	}

	#[test]
	fn gzip_sse_body_decodes_incrementally_across_arbitrary_chunk_boundaries() {
		let payload = b"event: message_start\ndata: {\"type\":\"message_start\"}\n\nevent: ping\ndata: {\"type\":\"ping\"}\n\n";
		let wire = gzip(payload);
		for piece in [1, 3, 7, wire.len()] {
			let mut decoder = ContentDecoder::from_headers(&headers("gzip")).unwrap();
			assert_eq!(decode_in_pieces(&mut decoder, &wire, piece), payload, "piece={piece}");
		}
	}

	#[test]
	fn deflate_brotli_and_zstd_bodies_decode() {
		let payload = b"data: {\"hello\":\"world\"}\n\n".repeat(64);

		let mut zlib = flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
		zlib.write_all(&payload).unwrap();
		let mut decoder = ContentDecoder::from_headers(&headers("deflate")).unwrap();
		assert_eq!(decode_in_pieces(&mut decoder, &zlib.finish().unwrap(), 5), payload);

		let mut br = brotli::CompressorWriter::new(Vec::new(), 4096, 5, 22);
		br.write_all(&payload).unwrap();
		let br = br.into_inner();
		let mut decoder = ContentDecoder::from_headers(&headers("br")).unwrap();
		assert_eq!(decode_in_pieces(&mut decoder, &br, 5), payload);

		let zst = zstd::encode_all(payload.as_slice(), 3).unwrap();
		let mut decoder = ContentDecoder::from_headers(&headers("zstd")).unwrap();
		assert_eq!(decode_in_pieces(&mut decoder, &zst, 5), payload);
	}

	#[test]
	fn truncated_gzip_body_fails_at_finish() {
		let wire = gzip(b"data: {\"type\":\"ping\"}\n\n".repeat(32).as_slice());
		let mut decoder = ContentDecoder::from_headers(&headers("gzip")).unwrap();
		let _ = decoder
			.push(Bytes::copy_from_slice(&wire[..wire.len() / 2]))
			.unwrap();
		assert!(decoder.finish().is_err());
	}

	#[test]
	fn unknown_and_stacked_encodings_are_rejected() {
		assert!(ContentDecoder::from_headers(&headers("compress")).is_err());
		assert!(ContentDecoder::from_headers(&headers("gzip, br")).is_err());
		assert!(ContentDecoder::from_headers(&headers("identity, gzip")).is_ok());
	}
}
