//! `-z`/`-Z`: looking inside compressed data (`compress.c`'s method table,
//! file 5.41), decoded in process with the codecs `tar` and `rsync` already
//! carry. The LZW (`compress`), freeze, pack, lzip and lrzip formats have no
//! decoder here and are described as the compressed data they are.

use std::io::{self, Read};

/// What decompression produced.
pub(super) enum Unpacked {
	/// The start of the decompressed data.
	Data(Vec<u8>),
	/// The stream was damaged: the method's name and the decoder's message.
	Error(&'static str, String),
}

/// `lzmacmp`: a raw LZMA stream has no magic, only plausible header bytes.
fn is_lzma(buf: &[u8]) -> bool {
	buf.len() >= 13 && buf[0] == 0x5d && buf[1] == 0 && buf[2] == 0 && matches!(buf[12], 0 | 0xff)
}

/// `zlibcmp`: the deflate method with a valid header checksum.
fn is_zlib(buf: &[u8]) -> bool {
	buf.len() >= 2 && buf[0] & 0x0f == 8 && buf[0] & 0x80 == 0 && u16::from_be_bytes([buf[0], buf[1]]) % 31 == 0
}

/// The first member of a zip archive, as `gzip -d` reads one: the method's
/// decoder over the data that follows the local header.
fn zip_member(buf: &[u8]) -> io::Result<Box<dyn Read + '_>> {
	let unsupported = || io::Error::new(io::ErrorKind::InvalidData, "Unknown compression format");
	let header = buf.get(..30).ok_or_else(unsupported)?;
	let name = usize::from(u16::from_le_bytes([header[26], header[27]]));
	let extra = usize::from(u16::from_le_bytes([header[28], header[29]]));
	let data = buf.get(30 + name + extra..).ok_or_else(unsupported)?;
	match u16::from_le_bytes([header[8], header[9]]) {
		0 => {
			let stored = u32::from_le_bytes([header[18], header[19], header[20], header[21]]) as usize;
			Ok(Box::new(&data[..stored.min(data.len())]))
		},
		8 => Ok(Box::new(flate2::read::DeflateDecoder::new(data))),
		_ => Err(unsupported()),
	}
}

/// Decompresses the start of `buf` when it is compressed data, producing at
/// most `max` bytes. `None` when `buf` is not compressed or its format has no
/// decoder.
pub(super) fn unpack(buf: &[u8], max: usize) -> Option<Unpacked> {
	let (method, reader): (&'static str, io::Result<Box<dyn Read + '_>>) = if buf.starts_with(&[0x1f, 0x8b]) {
		("gzip", Ok(Box::new(flate2::read::MultiGzDecoder::new(buf))))
	} else if buf.starts_with(b"PK\x03\x04") {
		("gzip", zip_member(buf))
	} else if buf.starts_with(b"BZh") {
		("bzip2", Ok(Box::new(bzip2::read::MultiBzDecoder::new(buf))))
	} else if buf.starts_with(&[0xfd, b'7', b'z', b'X', b'Z', 0]) {
		("xz", Ok(Box::new(lzma_rust2::XzReader::new(buf, true))))
	} else if buf.starts_with(&[0x04, 0x22, 0x4d, 0x18]) {
		("lz4", Ok(Box::new(lz4_flex::frame::FrameDecoder::new(buf))))
	} else if buf.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
		("zstd", zstd::stream::read::Decoder::new(buf).map(|decoder| Box::new(decoder) as Box<dyn Read + '_>))
	} else if is_lzma(buf) {
		(
			"xz",
			lzma_rust2::LzmaReader::new_mem_limit(buf, u32::MAX, None)
				.map(|decoder| Box::new(decoder) as Box<dyn Read + '_>)
				.map_err(io::Error::other),
		)
	} else if is_zlib(buf) {
		("zlib", Ok(Box::new(flate2::read::ZlibDecoder::new(buf))))
	} else {
		return None;
	};
	let mut out = Vec::new();
	let failure = match reader {
		Ok(reader) => reader.take(max as u64).read_to_end(&mut out).err(),
		Err(err) => Some(err),
	};
	// The buffer may end mid-stream; whatever decoded before that is what
	// gets identified.
	Some(match failure {
		Some(err) if out.is_empty() => Unpacked::Error(method, err.to_string()),
		_ => Unpacked::Data(out),
	})
}
