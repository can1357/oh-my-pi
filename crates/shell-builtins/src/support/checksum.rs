//! First-party checksum primitives used by the checksum-family builtins.

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	io::{self, BufRead, BufReader, Read, Write},
	iter, str,
};

use digest::{
	Output,
	block_api::{Buffer, UpdateCore, VariableOutputCore},
};
use omp_core::encoding::{base64, hex};
use strum::{EnumProperty, EnumString, IntoStaticStr};
use thiserror::Error;

/// Checksum implementations and output types.
pub(crate) mod sum {
	use super::*;

	/// The result of a checksum computation.
	#[derive(Debug, Clone, PartialEq, Eq)]
	pub(crate) enum DigestOutput {
		/// A cryptographic digest of arbitrary length.
		Vec(Vec<u8>),
		/// A 32-bit legacy checksum.
		Crc(u32),
		/// A 16-bit legacy checksum.
		U16(u16),
	}

	impl DigestOutput {
		/// Writes the digest bytes without textual encoding.
		pub(crate) fn write_raw(&self, mut writer: impl Write) -> io::Result<()> {
			match self {
				Self::Vec(bytes) => writer.write_all(bytes),
				Self::Crc(value) => writer.write_all(&value.to_be_bytes()),
				Self::U16(value) => writer.write_all(&value.to_be_bytes()),
			}
		}

		/// Encodes a cryptographic digest as lowercase hexadecimal.
		pub(crate) fn to_hex(&self) -> Result<String, ChecksumError> {
			match self {
				Self::Vec(bytes) => Ok(hex::encode(bytes).into_string()),
				_ => Err(ChecksumError::LegacyEncoding),
			}
		}

		/// Encodes a cryptographic digest as padded RFC 4648 base64.
		pub(crate) fn to_base64(&self) -> Result<String, ChecksumError> {
			match self {
				Self::Vec(bytes) => Ok(base64::encode(bytes).into_string()),
				_ => Err(ChecksumError::LegacyEncoding),
			}
		}
	}

	/// Streaming checksum interface shared by all algorithms.
	pub(crate) trait Digest {
		/// Resets this digest to its initial state.
		fn reset(&mut self);
		/// Adds bytes to this digest.
		fn update(&mut self, input: &[u8]);
		/// Finishes the digest without preventing a later reset.
		fn result(&mut self) -> DigestOutput;
	}

	pub(super) struct Fixed<D>(D);

	impl<D: Default> Default for Fixed<D> {
		fn default() -> Self {
			Self(D::default())
		}
	}

	impl<D> Digest for Fixed<D>
	where
		D: digest::Digest + Default + Clone + 'static,
	{
		fn reset(&mut self) {
			self.0 = D::default();
		}

		fn update(&mut self, input: &[u8]) {
			digest::Digest::update(&mut self.0, input);
		}

		fn result(&mut self) -> DigestOutput {
			DigestOutput::Vec(self.0.clone().finalize().to_vec())
		}
	}

	pub(super) struct Blake2bDigest {
		state:  blake2::Blake2bVarCore,
		buffer: Buffer<blake2::Blake2bVarCore>,
		bytes:  usize,
	}

	impl Blake2bDigest {
		pub(super) fn new(bytes: usize) -> Self {
			Self {
				state: blake2::Blake2bVarCore::new(bytes).expect("validated BLAKE2b output length"),
				buffer: Buffer::<blake2::Blake2bVarCore>::default(),
				bytes,
			}
		}
	}

	impl Digest for Blake2bDigest {
		fn reset(&mut self) {
			*self = Self::new(self.bytes);
		}

		fn update(&mut self, input: &[u8]) {
			let Self { state, buffer, .. } = self;
			buffer.digest_blocks(input, |blocks| state.update_blocks(blocks));
		}

		fn result(&mut self) -> DigestOutput {
			// digest 0.11 dropped its runtime-output wrapper, so the removed
			// `RtVariableCoreWrapper` buffering logic is inlined here on the
			// `Blake2bVarCore` path; finalize on clones to stay reusable.
			let mut state = self.state.clone();
			let mut buffer = self.buffer.clone();
			let mut full = Output::<blake2::Blake2bVarCore>::default();
			state.finalize_variable_core(&mut buffer, &mut full);
			// BLAKE2b truncates from the left (`TruncSide::Left`).
			DigestOutput::Vec(full[..self.bytes].to_vec())
		}
	}

	/// Variable-output BLAKE2b implementation.
	pub(crate) struct Blake2b;

	impl Blake2b {
		/// Default BLAKE2b output size in bits.
		pub(crate) const DEFAULT_BIT_SIZE: usize = 512;
		/// Default BLAKE2b output size in bytes.
		pub(crate) const DEFAULT_BYTE_SIZE: usize = 64;
	}

	pub(super) struct Blake3Digest {
		state: blake3::Hasher,
		bytes: usize,
	}

	impl Blake3Digest {
		pub(super) fn new(bytes: usize) -> Self {
			Self { state: blake3::Hasher::new(), bytes }
		}
	}

	impl Digest for Blake3Digest {
		fn reset(&mut self) {
			*self = Self::new(self.bytes);
		}

		fn update(&mut self, input: &[u8]) {
			self.state.update(input);
		}

		fn result(&mut self) -> DigestOutput {
			let mut output = vec![0; self.bytes];
			self.state.finalize_xof().fill(&mut output);
			DigestOutput::Vec(output)
		}
	}

	/// Variable-output BLAKE3 implementation.
	pub(crate) struct Blake3;

	impl Blake3 {
		/// Default BLAKE3 output size in bytes.
		pub(crate) const DEFAULT_BYTE_SIZE: usize = 32;
	}

	#[derive(Default)]
	pub(super) struct Bsd(u16);

	impl Digest for Bsd {
		fn reset(&mut self) {
			self.0 = 0;
		}

		fn update(&mut self, input: &[u8]) {
			for &byte in input {
				self.0 = self.0.rotate_right(1).wrapping_add(u16::from(byte));
			}
		}

		fn result(&mut self) -> DigestOutput {
			DigestOutput::U16(self.0)
		}
	}

	#[derive(Default)]
	pub(super) struct Sysv(u32);

	impl Digest for Sysv {
		fn reset(&mut self) {
			self.0 = 0;
		}

		fn update(&mut self, input: &[u8]) {
			for &byte in input {
				self.0 = self.0.wrapping_add(u32::from(byte));
			}
		}

		fn result(&mut self) -> DigestOutput {
			let folded = (self.0 & 0xffff) + (self.0 >> 16);
			DigestOutput::U16(((folded & 0xffff) + (folded >> 16)) as u16)
		}
	}

	#[derive(Default)]
	pub(super) struct PosixCrc {
		crc:  u32,
		size: usize,
	}

	impl Digest for PosixCrc {
		fn reset(&mut self) {
			*self = Self::default();
		}

		fn update(&mut self, input: &[u8]) {
			for &byte in input {
				self.crc = crc_step(self.crc, byte);
			}
			self.size += input.len();
		}

		fn result(&mut self) -> DigestOutput {
			let mut crc = self.crc;
			let mut size = self.size;
			while size != 0 {
				crc = crc_step(crc, size as u8);
				size >>= 8;
			}
			DigestOutput::Crc(!crc)
		}
	}

	fn crc_step(mut crc: u32, byte: u8) -> u32 {
		crc ^= u32::from(byte) << 24;
		for _ in 0..8 {
			crc = if crc & 0x8000_0000 != 0 {
				(crc << 1) ^ 0x04c1_1db7
			} else {
				crc << 1
			};
		}
		crc
	}

	#[derive(Default)]
	pub(super) struct Crc32b(crc32fast::Hasher);

	impl Digest for Crc32b {
		fn reset(&mut self) {
			self.0.reset();
		}

		fn update(&mut self, input: &[u8]) {
			self.0.update(input);
		}

		fn result(&mut self) -> DigestOutput {
			DigestOutput::Crc(self.0.clone().finalize())
		}
	}
}

use std::num;

pub(crate) use sum::DigestOutput;

/// Algorithms accepted by `cksum --algorithm`.
pub(crate) const SUPPORTED_ALGORITHMS: [&str; 14] = [
	"sysv", "bsd", "crc", "crc32b", "md5", "sha1", "sha2", "sha3", "blake2b", "sha224", "sha256",
	"sha384", "sha512", "blake3",
];

/// An algorithm name before its output length has been resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumProperty, EnumString, IntoStaticStr)]
pub(crate) enum AlgoKind {
	#[strum(serialize = "sysv", props(Upper = "SYSV"))]
	Sysv,
	#[strum(serialize = "bsd", props(Upper = "BSD"))]
	Bsd,
	#[strum(serialize = "crc", props(Upper = "CRC"))]
	Crc,
	#[strum(serialize = "crc32b", props(Upper = "CRC32B"))]
	Crc32b,
	#[strum(to_string = "md5", serialize = "md5sum", props(Upper = "MD5"))]
	Md5,
	#[strum(to_string = "sha1", serialize = "sha1sum", props(Upper = "SHA1"))]
	Sha1,
	#[strum(serialize = "sha2", props(Upper = "SHA2"))]
	Sha2,
	#[strum(to_string = "sha3", serialize = "sha3sum", props(Upper = "SHA3"))]
	Sha3,
	#[strum(to_string = "blake2b", serialize = "b2sum", props(Upper = "BLAKE2b"))]
	Blake2b,
	#[strum(to_string = "sha224", serialize = "sha224sum", props(Upper = "SHA224"))]
	Sha224,
	#[strum(to_string = "sha256", serialize = "sha256sum", props(Upper = "SHA256"))]
	Sha256,
	#[strum(to_string = "sha384", serialize = "sha384sum", props(Upper = "SHA384"))]
	Sha384,
	#[strum(to_string = "sha512", serialize = "sha512sum", props(Upper = "SHA512"))]
	Sha512,
	#[strum(serialize = "blake3", props(Upper = "BLAKE3"))]
	Blake3,
}

impl AlgoKind {
	/// Parses a `cksum --algorithm` value; utility-name aliases are rejected.
	pub(crate) fn from_cksum(value: impl AsRef<str>) -> Result<Self, ChecksumError> {
		let value = value.as_ref();
		if !SUPPORTED_ALGORITHMS.contains(&value) {
			return Err(ChecksumError::UnknownAlgorithm(value.to_owned()));
		}
		value
			.parse()
			.map_err(|_| ChecksumError::UnknownAlgorithm(value.to_owned()))
	}

	/// Parses a standalone checksum utility name (`md5sum`, `b2sum`, ...) via
	/// the derived strum aliases.
	pub(crate) fn from_bin_name(value: impl AsRef<str>) -> Result<Self, ChecksumError> {
		value
			.as_ref()
			.parse()
			.map_err(|_| ChecksumError::UnknownAlgorithm(value.as_ref().to_owned()))
	}

	/// Returns the conventional uppercase display name.
	pub(crate) fn to_uppercase(self) -> &'static str {
		self
			.get_str("Upper")
			.expect("every algorithm defines an uppercase name")
	}

	/// Returns the lowercase command-line name.
	pub(crate) fn to_lowercase(self) -> &'static str {
		self.into()
	}

	/// Reports whether this is a legacy arithmetic checksum.
	pub(crate) const fn is_legacy(self) -> bool {
		matches!(self, Self::Sysv | Self::Bsd | Self::Crc | Self::Crc32b)
	}

	/// Returns the required digest size for fixed-size untagged checksums.
	pub(crate) const fn expected_digest_bit_len(self) -> Option<usize> {
		match self {
			Self::Md5 => Some(128),
			Self::Sha1 => Some(160),
			Self::Sha224 => Some(224),
			Self::Sha256 => Some(256),
			Self::Sha384 => Some(384),
			Self::Sha512 => Some(512),
			_ => None,
		}
	}
}

/// A supported SHA-2 or SHA-3 digest length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShaLength {
	Len224,
	Len256,
	Len384,
	Len512,
}

impl ShaLength {
	/// Returns this length in bits.
	pub(crate) const fn as_usize(self) -> usize {
		match self {
			Self::Len224 => 224,
			Self::Len256 => 256,
			Self::Len384 => 384,
			Self::Len512 => 512,
		}
	}
}

impl TryFrom<usize> for ShaLength {
	type Error = ChecksumError;

	fn try_from(value: usize) -> Result<Self, Self::Error> {
		match value {
			224 => Ok(Self::Len224),
			256 => Ok(Self::Len256),
			384 => Ok(Self::Len384),
			512 => Ok(Self::Len512),
			_ => Err(ChecksumError::InvalidLengthForSha(value.to_string())),
		}
	}
}

/// An algorithm with its output length fully resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SizedAlgoKind {
	Sysv,
	Bsd,
	Crc,
	Crc32b,
	Md5,
	Sha1,
	Sha2(ShaLength),
	Sha3(ShaLength),
	Blake2b(usize),
	Blake3(usize),
}

impl SizedAlgoKind {
	/// Resolves an algorithm and optional length into a concrete implementation.
	pub(crate) fn from_unsized(
		kind: AlgoKind,
		length: Option<usize>,
	) -> Result<Self, ChecksumError> {
		use AlgoKind as A;
		if length.is_some()
			&& matches!(
				kind,
				A::Sysv
					| A::Bsd | A::Crc
					| A::Crc32b
					| A::Md5 | A::Sha1
					| A::Sha224
					| A::Sha256
					| A::Sha384
					| A::Sha512
			) {
			return Err(ChecksumError::LengthOnlyForBlake2bSha2Sha3);
		}
		Ok(match (kind, length) {
			(A::Sysv, _) => Self::Sysv,
			(A::Bsd, _) => Self::Bsd,
			(A::Crc, _) => Self::Crc,
			(A::Crc32b, _) => Self::Crc32b,
			(A::Md5, _) => Self::Md5,
			(A::Sha1, _) => Self::Sha1,
			(A::Blake2b, value) => Self::Blake2b(value.unwrap_or(sum::Blake2b::DEFAULT_BYTE_SIZE)),
			(A::Blake3, value) => Self::Blake3(value.unwrap_or(sum::Blake3::DEFAULT_BYTE_SIZE)),
			(A::Sha2, Some(value)) => Self::Sha2(value.try_into()?),
			(A::Sha3, Some(value)) => Self::Sha3(value.try_into()?),
			(algo @ (A::Sha2 | A::Sha3), None) => {
				return Err(ChecksumError::LengthRequiredForSha(algo.to_lowercase().into()));
			},
			(A::Sha224, None) => Self::Sha2(ShaLength::Len224),
			(A::Sha256, None) => Self::Sha2(ShaLength::Len256),
			(A::Sha384, None) => Self::Sha2(ShaLength::Len384),
			(A::Sha512, None) => Self::Sha2(ShaLength::Len512),
			_ => unreachable!("fixed algorithms with a length were rejected"),
		})
	}

	/// Constructs a resettable streaming digest.
	pub(crate) fn create_digest(self) -> Box<dyn sum::Digest> {
		use ShaLength as L;
		match self {
			Self::Sysv => Box::new(sum::Sysv::default()),
			Self::Bsd => Box::new(sum::Bsd::default()),
			Self::Crc => Box::new(sum::PosixCrc::default()),
			Self::Crc32b => Box::new(sum::Crc32b::default()),
			Self::Md5 => Box::new(sum::Fixed::<md5::Md5>::default()),
			Self::Sha1 => Box::new(sum::Fixed::<sha1::Sha1>::default()),
			Self::Sha2(L::Len224) => Box::new(sum::Fixed::<sha2::Sha224>::default()),
			Self::Sha2(L::Len256) => Box::new(sum::Fixed::<sha2::Sha256>::default()),
			Self::Sha2(L::Len384) => Box::new(sum::Fixed::<sha2::Sha384>::default()),
			Self::Sha2(L::Len512) => Box::new(sum::Fixed::<sha2::Sha512>::default()),
			Self::Sha3(L::Len224) => Box::new(sum::Fixed::<sha3::Sha3_224>::default()),
			Self::Sha3(L::Len256) => Box::new(sum::Fixed::<sha3::Sha3_256>::default()),
			Self::Sha3(L::Len384) => Box::new(sum::Fixed::<sha3::Sha3_384>::default()),
			Self::Sha3(L::Len512) => Box::new(sum::Fixed::<sha3::Sha3_512>::default()),
			Self::Blake2b(bytes) => Box::new(sum::Blake2bDigest::new(bytes)),
			Self::Blake3(bytes) => Box::new(sum::Blake3Digest::new(bytes)),
		}
	}

	/// Returns the algorithm's output/block unit used by legacy output
	/// formatting.
	pub(crate) fn bitlen(self) -> usize {
		match self {
			Self::Sysv => 512,
			Self::Bsd => 1024,
			Self::Crc => 256,
			Self::Crc32b => 32,
			Self::Md5 => 128,
			Self::Sha1 => 160,
			Self::Sha2(length) | Self::Sha3(length) => length.as_usize(),
			Self::Blake2b(bytes) | Self::Blake3(bytes) => bytes * 8,
		}
	}

	/// Reports whether this is a legacy arithmetic checksum.
	pub(crate) const fn is_legacy(self) -> bool {
		matches!(self, Self::Sysv | Self::Bsd | Self::Crc | Self::Crc32b)
	}

	/// Returns the tagged checksum algorithm name.
	pub(crate) fn to_tag(self) -> String {
		match self {
			Self::Md5 => "MD5".into(),
			Self::Sha1 => "SHA1".into(),
			Self::Sha2(length) => format!("SHA{}", length.as_usize()),
			Self::Sha3(length) => format!("SHA3-{}", length.as_usize()),
			Self::Blake2b(64) => "BLAKE2b".into(),
			Self::Blake2b(bytes) => format!("BLAKE2b-{}", bytes * 8),
			Self::Blake3(bytes) => format!("BLAKE3-{}", bytes * 8),
			_ => panic!("legacy algorithms do not have tagged names"),
		}
	}
}

/// Errors produced by checksum option validation and encoding.
#[derive(Debug, Error)]
pub(crate) enum ChecksumError {
	#[error("the --raw option is not supported with multiple files")]
	RawMultipleFiles,
	#[error("the --{0} option is meaningful only when verifying checksums")]
	CheckOnlyFlag(String),
	#[error("invalid length: '{0}'")]
	InvalidLength(String),
	#[error("maximum digest length for '{0}' is 512 bits")]
	LengthTooBigForBlake(String),
	#[error("length is not a multiple of 8")]
	LengthNotMultipleOf8,
	#[error("digest length for '{0}' must be 224, 256, 384, or 512")]
	InvalidLengthForSha(String),
	#[error("--algorithm={0} requires specifying --length 224, 256, 384, or 512")]
	LengthRequiredForSha(String),
	#[error("--length is only supported with --algorithm blake2b, sha2, or sha3")]
	LengthOnlyForBlake2bSha2Sha3,
	#[error("the --binary and --text options are meaningless when verifying checksums")]
	BinaryTextConflict,
	#[error("--text mode is only supported with --untagged")]
	TextWithoutUntagged,
	#[error("the --tag option is meaningless when verifying checksums")]
	TagCheck,
	#[error("--tag does not support --text mode")]
	TextAfterTag,
	#[error("--check is not supported with --algorithm={{bsd,sysv,crc,crc32b}}")]
	AlgorithmNotSupportedWithCheck,
	#[error("unknown algorithm: {0}: clap should have prevented this case")]
	UnknownAlgorithm(String),
	#[error("legacy output cannot be encoded")]
	LegacyEncoding,
	#[error(transparent)]
	Io(#[from] io::Error),
}

/// Whether a checksum line denotes binary or text input.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ReadingMode {
	Binary,
	Text,
}

/// Digests all bytes from `reader` through a reusable 32 KiB buffer.
pub(crate) fn digest_reader<T: Read>(
	digest: &mut Box<dyn sum::Digest>,
	reader: &mut T,
	_mode: ReadingMode,
) -> io::Result<(DigestOutput, usize)> {
	digest.reset();
	let mut buffer = [0_u8; 32 * 1024];
	let mut size = 0usize;
	loop {
		let count = reader.read(&mut buffer)?;
		if count == 0 {
			break;
		}
		digest.update(&buffer[..count]);
		size = size.saturating_add(count);
	}
	Ok((digest.result(), size))
}

/// A BLAKE output length expressed in bits as an integer or string.
pub(crate) enum BlakeLength<'a> {
	Int(usize),
	String(&'a str),
}

/// Validates a BLAKE bit length and returns its byte length.
pub(crate) fn parse_blake_length(
	kind: AlgoKind,
	length: BlakeLength<'_>,
) -> Result<usize, ChecksumError> {
	let bits = match length {
		BlakeLength::Int(value) => value,
		BlakeLength::String(value) => value.parse::<usize>().map_err(|error| {
			if *error.kind() == num::IntErrorKind::PosOverflow {
				ChecksumError::LengthTooBigForBlake(kind.to_uppercase().into())
			} else {
				ChecksumError::InvalidLength(value.into())
			}
		})?,
	};
	if bits == 0 {
		return Ok(if kind == AlgoKind::Blake2b {
			sum::Blake2b::DEFAULT_BYTE_SIZE
		} else {
			sum::Blake3::DEFAULT_BYTE_SIZE
		});
	}
	if kind == AlgoKind::Blake2b && bits > sum::Blake2b::DEFAULT_BIT_SIZE {
		return Err(ChecksumError::LengthTooBigForBlake(kind.to_uppercase().into()));
	}
	if !bits.is_multiple_of(8) {
		return Err(ChecksumError::LengthNotMultipleOf8);
	}
	Ok(bits / 8)
}

/// Escapes backslash and line-ending bytes in a checksum filename.
pub(crate) fn escape_filename(filename: &OsStr) -> (String, &'static str) {
	let original = filename.to_string_lossy();
	let escaped = original
		.replace('\\', "\\\\")
		.replace('\n', "\\n")
		.replace('\r', "\\r");
	let prefix = if escaped == original { "" } else { "\\" };
	(escaped, prefix)
}

/// Reverses checksum filename escaping and returns the checksum-line prefix.
pub(crate) fn unescape_filename(filename: &[u8]) -> (Vec<u8>, &'static str) {
	let mut output = Vec::with_capacity(filename.len());
	let mut bytes = filename.iter().copied();
	while let Some(byte) = bytes.next() {
		if byte == b'\\' {
			match bytes.next() {
				Some(b'\\') => output.push(b'\\'),
				Some(b'n') => output.push(b'\n'),
				Some(b'r') => output.push(b'\r'),
				Some(other) => {
					output.push(b'\\');
					output.push(other);
				},
				None => {},
			}
		} else {
			output.push(byte);
		}
	}
	let prefix = if output == filename { "" } else { "\\" };
	(output, prefix)
}

/// Converts platform bytes into an OS string without loss on Unix.
pub(crate) fn os_str_from_bytes(bytes: &[u8]) -> Result<Cow<'_, OsStr>, ChecksumError> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt;
		Ok(Cow::Borrowed(OsStr::from_bytes(bytes)))
	}
	#[cfg(not(unix))]
	{
		let text = str::from_utf8(bytes)
			.map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
		Ok(Cow::Owned(OsString::from(text)))
	}
}

/// Reads CRLF- or LF-delimited OS strings without requiring UTF-8 on Unix.
pub(crate) fn read_os_string_lines<R: Read>(
	mut reader: BufReader<R>,
) -> impl Iterator<Item = io::Result<OsString>> {
	iter::from_fn(move || {
		let mut bytes = Vec::with_capacity(256);
		match reader.read_until(b'\n', &mut bytes) {
			Ok(0) => None,
			Err(error) => Some(Err(error)),
			Ok(_) => {
				if bytes.last() == Some(&b'\n') {
					bytes.pop();
					if bytes.last() == Some(&b'\r') {
						bytes.pop();
					}
				}
				#[cfg(unix)]
				{
					use std::os::unix::ffi::OsStringExt;
					Some(Ok(OsString::from_vec(bytes)))
				}
				#[cfg(not(unix))]
				{
					Some(
						String::from_utf8(bytes)
							.map(OsString::from)
							.map_err(io::Error::other),
					)
				}
			},
		}
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn digest(kind: SizedAlgoKind, input: &[u8]) -> DigestOutput {
		let mut digest = kind.create_digest();
		let mut input = input;
		digest_reader(&mut digest, &mut input, ReadingMode::Binary)
			.unwrap()
			.0
	}

	fn hex(kind: SizedAlgoKind, input: &[u8]) -> String {
		digest(kind, input).to_hex().unwrap()
	}

	fn assert_hex_vectors(kind: SizedAlgoKind, expected: [&str; 3]) {
		for (input, expected) in [b"".as_slice(), b"abc", b"123456789"]
			.into_iter()
			.zip(expected)
		{
			assert_eq!(hex(kind, input), expected, "{kind:?} on {input:?}");
		}
	}

	#[test]
	fn every_fixed_digest_has_known_vectors() {
		let vectors = [
(SizedAlgoKind::Md5, ["d41d8cd98f00b204e9800998ecf8427e", "900150983cd24fb0d6963f7d28e17f72", "25f9e794323b453885f5181f1b624d0b"]),
(SizedAlgoKind::Sha1, ["da39a3ee5e6b4b0d3255bfef95601890afd80709", "a9993e364706816aba3e25717850c26c9cd0d89d", "f7c3bc1d808e04732adf679965ccc34ca7ae3441"]),
(SizedAlgoKind::Sha2(ShaLength::Len224), ["d14a028c2a3a2bc9476102bb288234c415a2b01f828ea62ac5b3e42f", "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7", "9b3e61bf29f17c75572fae2e86e17809a4513d07c8a18152acf34521"]),
(SizedAlgoKind::Sha2(ShaLength::Len256), ["e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225"]),
(SizedAlgoKind::Sha2(ShaLength::Len384), ["38b060a751ac96384cd9327eb1b1e36a21fdb71114be07434c0cc7bf63f6e1da274edebfe76f65fbd51ad2f14898b95b", "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7", "eb455d56d2c1a69de64e832011f3393d45f3fa31d6842f21af92d2fe469c499da5e3179847334a18479c8d1dedea1be3"]),
(SizedAlgoKind::Sha2(ShaLength::Len512), ["cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e", "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f", "d9e6762dd1c8eaf6d61b3c6192fc408d4d6d5f1176d0c29169bc24e71c3f274ad27fcd5811b313d681f7e55ec02d73d499c95455b6b5bb503acf574fba8ffe85"]),
(SizedAlgoKind::Sha3(ShaLength::Len224), ["6b4e03423667dbb73b6e15454f0eb1abd4597f9a1b078e3f5b5a6bc7", "e642824c3f8cf24ad09234ee7d3c766fc9a3a5168d0c94ad73b46fdf", "5795c3d628fd638c9835a4c79a55809f265068c88729a1a3fcdf8522"]),
(SizedAlgoKind::Sha3(ShaLength::Len256), ["a7ffc6f8bf1ed76651c14756a061d662f580ff4de43b49fa82d80a4b80f8434a", "3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532", "87cd084d190e436f147322b90e7384f6a8e0676c99d21ef519ea718e51d45f9c"]),
(SizedAlgoKind::Sha3(ShaLength::Len384), ["0c63a75b845e4f7d01107d852e4c2485c51a50aaaa94fc61995e71bbee983a2ac3713831264adb47fb6bd1e058d5f004", "ec01498288516fc926459f58e2c6ad8df9b473cb0fc08c2596da7cf0e49be4b298d88cea927ac7f539f1edf228376d25", "8b90ede4d095409f1a12492c2520599683a9478dc70b7566d23b3e41ece8538c6cde92382a5e38786490375c54672abf"]),
(SizedAlgoKind::Sha3(ShaLength::Len512), ["a69f73cca23a9ac5c8b567dc185a756e97c982164fe25859e0d1dcc1475c80a615b2123af1f5f94c11e3e9402c3ac558f500199d95b6d3e301758586281dcd26", "b751850b1a57168a5693cd924b6b096e08f621827444f70d884f5d0240d2712e10e116e9192af3c91a7ec57647e3934057340b4cf408d5a56592f8274eec53f0", "e1e44d20556e97a180b6dd3ed7ae5c465cafd553fa8747dca038fb95635b77a37318f7ddf7aec1f6c3c14bb160ba2497007decf38dd361cab199e3b8c8fe1f5c"]),
];
		for (kind, expected) in vectors {
			assert_hex_vectors(kind, expected);
		}
	}

	#[test]
	fn cryptographic_known_vectors() {
		assert_eq!(hex(SizedAlgoKind::Md5, b""), "d41d8cd98f00b204e9800998ecf8427e");
		assert_eq!(hex(SizedAlgoKind::Md5, b"abc"), "900150983cd24fb0d6963f7d28e17f72");
		assert_eq!(hex(SizedAlgoKind::Sha1, b"abc"), "a9993e364706816aba3e25717850c26c9cd0d89d");
		assert_eq!(
			hex(SizedAlgoKind::Sha2(ShaLength::Len224), b"abc"),
			"23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7"
		);
		assert_eq!(
			hex(SizedAlgoKind::Sha2(ShaLength::Len256), b"123456789"),
			"15e2b0d3c33891ebb0f1ef609ec419420c20e320ce94c65fbc8c3312448eb225"
		);
		assert_eq!(hex(SizedAlgoKind::Sha2(ShaLength::Len384), b"abc"), "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7");
		assert_eq!(hex(SizedAlgoKind::Sha2(ShaLength::Len512), b"abc"), "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f");
		assert_eq!(
			hex(SizedAlgoKind::Sha3(ShaLength::Len256), b"abc"),
			"3a985da74fe225b2045c172d6bd390bd855f086e3e9d525b46bfe24511431532"
		);
	}

	#[test]
	fn legacy_known_vectors() {
		let inputs = [b"".as_slice(), b"abc", b"123456789"];
		for (input, expected) in inputs
			.into_iter()
			.zip([u32::MAX, 1_219_131_554, 930_766_865])
		{
			assert_eq!(digest(SizedAlgoKind::Crc, input), DigestOutput::Crc(expected));
		}
		for (input, expected) in inputs.into_iter().zip([0, 891_568_578, 0xcbf4_3926]) {
			assert_eq!(digest(SizedAlgoKind::Crc32b, input), DigestOutput::Crc(expected));
		}
		for (input, expected) in inputs.into_iter().zip([0, 294, 477]) {
			assert_eq!(digest(SizedAlgoKind::Sysv, input), DigestOutput::U16(expected));
		}
		for (input, expected) in inputs.into_iter().zip([0, 16_556, 53_615]) {
			assert_eq!(digest(SizedAlgoKind::Bsd, input), DigestOutput::U16(expected));
		}
	}

	#[test]
	fn variable_digest_known_vectors() {
		assert_hex_vectors(SizedAlgoKind::Blake2b(64), ["786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce", "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923", "f5ab8bafa6f2f72b431188ac38ae2de7bb618fb3d38b6cbf639defcdd5e10a86b22fccff571da37e42b23b80b657ee4d936478f582280a87d6dbb1da73f5c47d"]);
		assert_hex_vectors(SizedAlgoKind::Blake3(32), [
			"af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262",
			"6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85",
			"b7d65b48420d1033cb2595293263b6f72eabee20d55e699d0df1973b3c9deed1",
		]);
		assert_eq!(hex(SizedAlgoKind::Blake2b(64), b"abc"), "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923");
		assert_eq!(
			hex(SizedAlgoKind::Blake2b(32), b"abc"),
			"bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319"
		);
		assert_eq!(parse_blake_length(AlgoKind::Blake2b, BlakeLength::String("256")).unwrap(), 32);
	}

	#[test]
	fn filename_escape_round_trip() {
		let original = OsStr::new("a\\b\nc\r");
		let (escaped, prefix) = escape_filename(original);
		assert_eq!(prefix, "\\");
		let (unescaped, unescape_prefix) = unescape_filename(escaped.as_bytes());
		assert_eq!(unescape_prefix, "\\");
		assert_eq!(os_str_from_bytes(&unescaped).unwrap(), original);
	}
}
