//! Serde representation of byte strings in engine records and events.
//!
//! Human-readable formats (JSON events) get UTF-8 text when the bytes are
//! valid UTF-8 and a byte array otherwise; binary formats (the postcard
//! frames blob) always get raw bytes. `BString`'s own `Deserialize` accepts
//! both shapes, so only serialization needs these helpers.

use bstr::BString;
use serde::{Serialize, Serializer};

/// Bytes as text-or-bytes.
pub struct Text<'a>(pub &'a [u8]);

impl Serialize for Text<'_> {
	fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
		if s.is_human_readable()
			&& let Ok(text) = std::str::from_utf8(self.0)
		{
			s.serialize_str(text)
		} else {
			s.serialize_bytes(self.0)
		}
	}
}

/// `serialize_with` for one byte string.
pub fn bytes<S: Serializer, B: AsRef<[u8]> + ?Sized>(b: &B, s: S) -> Result<S::Ok, S::Error> {
	Text(b.as_ref()).serialize(s)
}

/// `serialize_with` for a list of byte strings.
pub fn list<S: Serializer>(items: &[BString], s: S) -> Result<S::Ok, S::Error> {
	s.collect_seq(items.iter().map(|b| Text(b)))
}

/// `serialize_with` for `(name, value)` byte-string pairs, as two-element
/// arrays.
pub fn pairs<S: Serializer>(items: &[(BString, BString)], s: S) -> Result<S::Ok, S::Error> {
	s.collect_seq(items.iter().map(|(k, v)| (Text(k), Text(v))))
}
