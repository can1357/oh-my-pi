//! Shared stream codecs and magic probes for compressed-tar variants and
//! single-stream pseudo-archives. gzip decoding stays in `archive` (flate2);
//! zstd uses the workspace `zstd` crate; each remaining decoder lives in its
//! own submodule as a pure-Rust implementation of the archive codecs.

mod bzip2;
mod lzma;
mod lzw;
mod xz;

use std::io::Read;

pub use bzip2::bzip2_decompress;
pub use lzma::{lzma_alone_decompress, lzma_decompress, lzma2_decompress};
pub use lzw::lzw_decompress;
pub use xz::{x86_decode, xz_decompress};
use zstd::stream::read;

use crate::{Error, Limits, Result};

/// gzip magic: `1f 8b`.
pub fn is_gzip(bytes: &[u8]) -> bool {
	bytes.starts_with(&[0x1f, 0x8b])
}

/// bzip2 magic: `BZh` plus a `1`-`9` level digit.
pub fn is_bzip2(bytes: &[u8]) -> bool {
	bytes.starts_with(b"BZh")
		&& bytes
			.get(3)
			.is_some_and(|level| level.is_ascii_digit() && *level != b'0')
}

/// xz magic: `fd 37 7a 58 5a 00`.
pub fn is_xz(bytes: &[u8]) -> bool {
	bytes.starts_with(&[0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])
}

/// zstd frame magic: `28 b5 2f fd`.
pub fn is_zstd(bytes: &[u8]) -> bool {
	bytes.starts_with(&[0x28, 0xb5, 0x2f, 0xfd])
}

/// ncompress `.Z` magic: `1f 9d`.
pub fn is_compress_z(bytes: &[u8]) -> bool {
	bytes.starts_with(&[0x1f, 0x9d])
}

/// Decompresses one zstd frame sequence bounded by `limits.archive_size`.
pub fn zstd_decompress(bytes: &[u8], limits: Limits) -> Result<Vec<u8>> {
	let decoder = read::Decoder::new(bytes)?;
	let mut output = Vec::new();
	decoder
		.take(limits.archive_size.saturating_add(1))
		.read_to_end(&mut output)?;
	let actual = output.len() as u64;
	if actual > limits.archive_size {
		return Err(Error::ArchiveTooLarge { actual, limit: limits.archive_size });
	}
	Ok(output)
}
