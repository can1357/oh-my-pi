//! Universally Unique Lexicographically Sortable Identifiers.

use core::{
	fmt::{self, Display},
	str::FromStr,
};
use std::time::{SystemTime, UNIX_EPOCH};

use rand::RngExt as _;
use thiserror::Error;

const ENCODED_LEN: usize = 26;
const ENTROPY_LEN: usize = 10;
const TIMESTAMP_MASK: u64 = (1 << 48) - 1;
const ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/// A 128-bit ULID consisting of a 48-bit Unix-millisecond timestamp and 80 bits
/// of entropy.
#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Ulid(u128);

/// An error encountered while parsing a [`Ulid`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum UlidParseError {
	/// The encoded identifier is not exactly 26 ASCII bytes long.
	#[error("ULID must contain exactly 26 characters")]
	InvalidLength,
	/// The encoded identifier contains a character outside the Crockford Base32
	/// alphabet.
	#[error("ULID contains an invalid Crockford Base32 character")]
	InvalidCharacter,
	/// The encoded identifier represents a value wider than 128 bits.
	#[error("ULID exceeds 128 bits")]
	Overflow,
}

impl Ulid {
	/// Generates a ULID using the current Unix-millisecond timestamp.
	///
	/// Entropy comes from `rand`'s thread-local cryptographically secure
	/// generator, which is initially seeded and periodically reseeded from the
	/// operating system. Generation is not monotonic within one millisecond.
	pub fn generate() -> Self {
		let timestamp = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis();
		let timestamp = u64::try_from(timestamp).unwrap_or(u64::MAX) & TIMESTAMP_MASK;
		let entropy: [u8; ENTROPY_LEN] = rand::rng().random();
		let mut bytes = [0_u8; 16];
		bytes[..6].copy_from_slice(&timestamp.to_be_bytes()[2..]);
		bytes[6..].copy_from_slice(&entropy);
		Self::from_bytes(bytes)
	}

	/// Parses a 26-character Crockford Base32 ULID.
	///
	/// ASCII letter case is ignored. Ambiguous characters (`I`, `L`, `O`, and
	/// `U`) are rejected.
	pub fn from_string(encoded: &str) -> Result<Self, UlidParseError> {
		encoded.parse()
	}

	/// Returns the big-endian 16-byte representation of this ULID.
	pub const fn to_bytes(self) -> [u8; 16] {
		self.0.to_be_bytes()
	}

	/// Returns the Unix-millisecond timestamp encoded in the high 48 bits.
	pub const fn timestamp_ms(self) -> u64 {
		(self.0 >> 80) as u64
	}

	/// Creates a ULID from its big-endian 16-byte representation.
	pub const fn from_bytes(bytes: [u8; 16]) -> Self {
		Self(u128::from_be_bytes(bytes))
	}

	const fn encode(self) -> [u8; ENCODED_LEN] {
		let mut encoded = [0_u8; ENCODED_LEN];
		let mut index = 0;
		while index < ENCODED_LEN {
			let shift = 125 - index * 5;
			encoded[index] = ALPHABET[((self.0 >> shift) & 0x1f) as usize];
			index += 1;
		}
		encoded
	}
}

impl FromStr for Ulid {
	type Err = UlidParseError;

	fn from_str(encoded: &str) -> Result<Self, Self::Err> {
		let bytes = encoded.as_bytes();
		if bytes.len() != ENCODED_LEN {
			return Err(UlidParseError::InvalidLength);
		}

		let first = decode_digit(bytes[0]).ok_or(UlidParseError::InvalidCharacter)?;
		if first > 7 {
			return Err(UlidParseError::Overflow);
		}

		let mut value = u128::from(first);
		for &byte in &bytes[1..] {
			let digit = decode_digit(byte).ok_or(UlidParseError::InvalidCharacter)?;
			value = (value << 5) | u128::from(digit);
		}
		Ok(Self(value))
	}
}

impl Display for Ulid {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		let encoded = self.encode();
		// SAFETY: Every byte comes from the ASCII-only Crockford alphabet.
		formatter.write_str(unsafe { str::from_utf8_unchecked(&encoded) })
	}
}

const fn decode_digit(byte: u8) -> Option<u8> {
	match byte {
		b'0'..=b'9' => Some(byte - b'0'),
		b'A'..=b'H' => Some(byte - b'A' + 10),
		b'J'..=b'K' => Some(byte - b'J' + 18),
		b'M'..=b'N' => Some(byte - b'M' + 20),
		b'P'..=b'T' => Some(byte - b'P' + 22),
		b'V'..=b'Z' => Some(byte - b'V' + 27),
		b'a'..=b'h' => Some(byte - b'a' + 10),
		b'j'..=b'k' => Some(byte - b'j' + 18),
		b'm'..=b'n' => Some(byte - b'm' + 20),
		b'p'..=b't' => Some(byte - b'p' + 22),
		b'v'..=b'z' => Some(byte - b'v' + 27),
		_ => None,
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn generated_ulid_round_trips_through_text() {
		let generated = Ulid::generate();
		let encoded = generated.to_string();
		assert_eq!(encoded.len(), ENCODED_LEN);
		assert_eq!(encoded.parse(), Ok(generated));
	}

	#[test]
	fn matches_specification_vectors() {
		let vector = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
		let expected = [
			0x01, 0x56, 0x3e, 0x3a, 0xb5, 0xd3, 0xd6, 0x76, 0x4c, 0x61, 0xef, 0xb9, 0x93, 0x02, 0xbd,
			0x5b,
		];
		let parsed = Ulid::from_string(vector).expect("valid specification vector");
		assert_eq!(parsed.to_bytes(), expected);
		assert_eq!(parsed.to_string(), vector);
		assert_eq!(Ulid::from_string("00000000000000000000000000"), Ok(Ulid(0)));
		assert_eq!(Ulid::from_string("7ZZZZZZZZZZZZZZZZZZZZZZZZZ"), Ok(Ulid(u128::MAX)));
	}

	#[test]
	fn ordering_follows_timestamp() {
		let earlier = Ulid::from_bytes([
			0, 0, 0, 0, 0, 1, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
		]);
		let later = Ulid::from_bytes([0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
		assert!(earlier < later);
		assert!(earlier.to_string() < later.to_string());
	}

	#[test]
	fn rejects_malformed_text() {
		assert_eq!(Ulid::from_string(""), Err(UlidParseError::InvalidLength));
		assert_eq!(
			Ulid::from_string("0000000000000000000000000"),
			Err(UlidParseError::InvalidLength)
		);
		assert_eq!(
			Ulid::from_string("0000000000000000000000000I"),
			Err(UlidParseError::InvalidCharacter)
		);
		assert_eq!(Ulid::from_string("80000000000000000000000000"), Err(UlidParseError::Overflow));
	}

	#[test]
	fn parsing_is_ascii_case_insensitive() {
		let upper = Ulid::from_string("01ARZ3NDEKTSV4RRFFQ69G5FAV").expect("uppercase ULID");
		let lower = Ulid::from_string("01arz3ndektsv4rrffq69g5fav").expect("lowercase ULID");
		assert_eq!(upper, lower);
	}

	#[test]
	fn bytes_round_trip() {
		let generated = Ulid::generate();
		assert_eq!(Ulid::from_bytes(generated.to_bytes()), generated);
	}
}
