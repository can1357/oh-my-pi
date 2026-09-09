//! Verbatim raw-value capture — the tolerant analogue of
//! `serde_json::value::RawValue`.

use std::{
	fmt::{self, Display},
	ptr,
};

use serde::de::{Deserialize, Deserializer, Error, Visitor};

/// Magic newtype-struct name the in-crate
/// [`Deserializer`](crate::slopjson::Deserializer) recognizes as a raw-capture
/// request.
pub const TOKEN: &str = "$omp_core::slopjson::private::RawValue";

/// One complete value captured as its verbatim source span instead of parsed.
///
/// Deserialize a field as `&'a RawValue` (zero-copy borrow of the input) or
/// `Box<RawValue>` (owned) to defer interpreting a subtree — pass-through
/// payloads, dispatch-on-one-field envelopes, and the like.
///
/// The captured text is exactly what the source said: tolerated slop stays
/// slop (single quotes, comments, Python literals) and re-parses with
/// [`from_str`](crate::slopjson::from_str) / [`parse`](crate::slopjson::parse)
/// — with one exception: a bareword string value (`{"paths": packages/foo/*}`)
/// is only grammatical in object/array value position, so its captured span
/// does not stand alone as a document. Use
/// [`repair_json`](crate::slopjson::repair_json) or `Value`'s `Display` when
/// strict JSON text is required.
///
/// Capture only works with this module's deserializer; other formats fail
/// with an "expected raw value" style error. There is deliberately no
/// `Serialize` impl — foreign serializers would emit the span as a plain
/// string, silently double-encoding it.
///
/// # Example
///
/// ```
/// use omp_core::slopjson::{RawValue, from_str};
///
/// #[derive(serde::Deserialize)]
/// struct Envelope<'a> {
/// 	kind:    &'a str,
/// 	#[serde(borrow)]
/// 	payload: &'a RawValue,
/// }
///
/// let env: Envelope = from_str("{kind: 'edit', payload: {'path': 'a.ts',},}").unwrap();
/// assert_eq!(env.kind, "edit");
/// assert_eq!(env.payload.get(), "{'path': 'a.ts',}");
/// ```
#[repr(transparent)]
pub struct RawValue {
	json: str,
}

impl RawValue {
	const fn from_borrowed(json: &str) -> &Self {
		// SAFETY: `RawValue` is `#[repr(transparent)]` over `str`.
		unsafe { &*(ptr::from_ref::<str>(json) as *const Self) }
	}

	fn from_boxed(json: Box<str>) -> Box<Self> {
		// SAFETY: `RawValue` is `#[repr(transparent)]` over `str`.
		unsafe { Box::from_raw(Box::into_raw(json) as *mut Self) }
	}

	/// The captured source text.
	pub const fn get(&self) -> &str {
		&self.json
	}
}

impl fmt::Debug for RawValue {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("RawValue").field(&&self.json).finish()
	}
}

impl Display for RawValue {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(&self.json)
	}
}

impl PartialEq for RawValue {
	fn eq(&self, other: &Self) -> bool {
		self.json == other.json
	}
}

impl ToOwned for RawValue {
	type Owned = Box<Self>;

	fn to_owned(&self) -> Box<Self> {
		Self::from_boxed(self.json.into())
	}
}

impl Clone for Box<RawValue> {
	fn clone(&self) -> Self {
		(**self).to_owned()
	}
}

impl<'de: 'a, 'a> Deserialize<'de> for &'a RawValue {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		struct BorrowedVisitor;

		impl<'de> Visitor<'de> for BorrowedVisitor {
			type Value = &'de RawValue;

			fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				f.write_str("a borrowed raw JSON value")
			}

			fn visit_borrowed_str<E: Error>(self, json: &'de str) -> Result<Self::Value, E> {
				Ok(RawValue::from_borrowed(json))
			}
		}

		deserializer.deserialize_newtype_struct(TOKEN, BorrowedVisitor)
	}
}

impl<'de> Deserialize<'de> for Box<RawValue> {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		struct BoxedVisitor;

		impl Visitor<'_> for BoxedVisitor {
			type Value = Box<RawValue>;

			fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				f.write_str("a raw JSON value")
			}

			fn visit_str<E: Error>(self, json: &str) -> Result<Self::Value, E> {
				Ok(RawValue::from_boxed(json.into()))
			}
		}

		deserializer.deserialize_newtype_struct(TOKEN, BoxedVisitor)
	}
}
