//! JSON value tree: [`Value`], [`Number`], and the insertion-ordered
//! [`Object`].

use std::{
	fmt::{self, Display, Write as _},
	iter, mem, ops, slice, vec,
};

use serde::de::{
	Error as _,
	value::{self, BorrowedStrDeserializer},
};

use crate::Str;

/// A parsed JSON value. `Display` serializes back to compact JSON.
#[derive(Debug, Clone, PartialEq, Default)]
pub enum Value {
	/// JSON `null` (also recovered from Python `None`).
	#[default]
	Null,
	/// JSON `true` / `false` (also recovered from Python `True` / `False`).
	Bool(bool),
	/// A finite number; see [`Number`].
	Number(Number),
	/// A string; inline-allocated up to 23 bytes via [`Str`].
	String(Str),
	/// An ordered array of values.
	Array(Vec<Self>),
	/// An insertion-ordered object; see [`Object`].
	Object(Object),
}

/// Shared fallback for [`Value`] indexing misses.
static NULL: Value = Value::Null;

impl Value {
	/// Member lookup; `None` unless this is an object containing `key`.
	pub fn get(&self, key: &str) -> Option<&Self> {
		match self {
			Self::Object(object) => object.get(key),
			_ => None,
		}
	}

	/// Whether this is `Null`.
	pub const fn is_null(&self) -> bool {
		matches!(self, Self::Null)
	}

	/// Whether this is an array.
	pub const fn is_array(&self) -> bool {
		matches!(self, Self::Array(_))
	}

	/// Whether this is an object.
	pub const fn is_object(&self) -> bool {
		matches!(self, Self::Object(_))
	}

	/// Boolean value; `None` for non-booleans.
	pub const fn as_bool(&self) -> Option<bool> {
		match self {
			Self::Bool(b) => Some(*b),
			_ => None,
		}
	}

	/// String contents; `None` for non-strings.
	pub fn as_str(&self) -> Option<&str> {
		match self {
			Self::String(s) => Some(s),
			_ => None,
		}
	}

	/// Numeric value; `None` for non-numbers.
	pub const fn as_number(&self) -> Option<Number> {
		match self {
			Self::Number(n) => Some(*n),
			_ => None,
		}
	}

	/// Integer value when this is a number that fits in `i64`.
	pub fn as_i64(&self) -> Option<i64> {
		self.as_number().and_then(Number::as_i64)
	}

	/// Integer value when this is a non-negative integer number.
	pub fn as_u64(&self) -> Option<u64> {
		self.as_number().and_then(Number::as_u64)
	}

	/// Numeric value as `f64` (lossy for large integers).
	pub fn as_f64(&self) -> Option<f64> {
		self.as_number().map(Number::as_f64)
	}

	/// Array elements; `None` for non-arrays.
	pub fn as_array(&self) -> Option<&[Self]> {
		match self {
			Self::Array(items) => Some(items),
			_ => None,
		}
	}

	/// Object members; `None` for non-objects.
	pub const fn as_object(&self) -> Option<&Object> {
		match self {
			Self::Object(object) => Some(object),
			_ => None,
		}
	}

	/// Deserialize a typed view directly from this tree without serializing or
	/// reparsing it.
	pub fn deserialize_into<'de, T>(&'de self) -> Result<T, value::Error>
	where
		T: serde::Deserialize<'de>,
	{
		T::deserialize(self)
	}
}

/// Object member access; missing keys and non-objects yield `Null`.
impl ops::Index<&str> for Value {
	type Output = Self;

	fn index(&self, key: &str) -> &Self {
		self.get(key).unwrap_or(&NULL)
	}
}

/// Array element access; out-of-bounds and non-arrays yield `Null`.
impl ops::Index<usize> for Value {
	type Output = Self;

	fn index(&self, index: usize) -> &Self {
		match self {
			Self::Array(items) => items.get(index).unwrap_or(&NULL),
			_ => &NULL,
		}
	}
}

impl Display for Value {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Null => f.write_str("null"),
			Self::Bool(true) => f.write_str("true"),
			Self::Bool(false) => f.write_str("false"),
			Self::Number(n) => n.fmt(f),
			Self::String(s) => write_escaped(f, s),
			Self::Array(items) => {
				f.write_char('[')?;
				for (i, item) in items.iter().enumerate() {
					if i > 0 {
						f.write_char(',')?;
					}
					item.fmt(f)?;
				}
				f.write_char(']')
			},
			Self::Object(object) => object.fmt(f),
		}
	}
}

/// Write `s` as a JSON string literal with the minimal required escapes.
fn write_escaped(f: &mut fmt::Formatter<'_>, s: &str) -> fmt::Result {
	f.write_char('"')?;
	let mut start = 0;
	for (i, b) in s.bytes().enumerate() {
		let short: Option<&str> = match b {
			b'"' => Some("\\\""),
			b'\\' => Some("\\\\"),
			0x08 => Some("\\b"),
			0x09 => Some("\\t"),
			0x0a => Some("\\n"),
			0x0c => Some("\\f"),
			0x0d => Some("\\r"),
			b if b < 0x20 => None, // \uXXXX below
			_ => continue,
		};
		f.write_str(&s[start..i])?;
		match short {
			Some(esc) => f.write_str(esc)?,
			None => write!(f, "\\u{b:04x}")?,
		}
		start = i + 1;
	}
	f.write_str(&s[start..])?;
	f.write_char('"')
}

// ── Number ───────────────────────────────────────────────────────────────────

/// A JSON number: an exact integer when it fits, `f64` otherwise. Never
/// non-finite — construction rejects NaN and infinities.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Number(N);

#[derive(Debug, Clone, Copy, PartialEq)]
enum N {
	/// Integer in `0..=u64::MAX`.
	PosInt(u64),
	/// Integer in `i64::MIN..0`.
	NegInt(i64),
	/// Always finite.
	Float(f64),
}

impl Number {
	/// A finite float; `None` for NaN and infinities.
	pub fn from_f64(value: f64) -> Option<Self> {
		value.is_finite().then_some(Self(N::Float(value)))
	}

	/// Exact integer value when it fits in `i64`; `None` for floats.
	pub fn as_i64(self) -> Option<i64> {
		match self.0 {
			N::PosInt(v) => i64::try_from(v).ok(),
			N::NegInt(v) => Some(v),
			N::Float(_) => None,
		}
	}

	/// Exact integer value when non-negative; `None` for floats.
	pub const fn as_u64(self) -> Option<u64> {
		match self.0 {
			N::PosInt(v) => Some(v),
			_ => None,
		}
	}

	/// Numeric value as `f64` (lossy above 2^53).
	pub const fn as_f64(self) -> f64 {
		match self.0 {
			N::PosInt(v) => v as f64,
			N::NegInt(v) => v as f64,
			N::Float(v) => v,
		}
	}

	/// Whether this number is stored as a float (has a fractional or
	/// exponent form, or overflowed the integer range).
	pub const fn is_f64(self) -> bool {
		matches!(self.0, N::Float(_))
	}
}

impl Display for Number {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self.0 {
			N::PosInt(v) => v.fmt(f),
			N::NegInt(v) => v.fmt(f),
			// Keep integral floats recognizably float ("1.0", not "1") so
			// serialization does not silently change the number's type.
			N::Float(v) if v.fract() == 0.0 && v.abs() < 1e16 => write!(f, "{v:.1}"),
			N::Float(v) => v.fmt(f),
		}
	}
}

impl From<u64> for Number {
	fn from(value: u64) -> Self {
		Self(N::PosInt(value))
	}
}

impl From<i64> for Number {
	fn from(value: i64) -> Self {
		if value < 0 {
			Self(N::NegInt(value))
		} else {
			Self(N::PosInt(value as u64))
		}
	}
}

// ── Object ───────────────────────────────────────────────────────────────────

/// Insertion-ordered JSON object. Duplicate inserts overwrite in place (last
/// value wins); equality is order-insensitive like JSON object semantics.
#[derive(Debug, Clone, Default)]
pub struct Object(Vec<(Str, Value)>);

/// Borrowed iterator over an [`Object`]'s members in insertion order.
pub type ObjectIter<'a> = impl DoubleEndedIterator<Item = (&'a Str, &'a Value)>
	+ ExactSizeIterator
	+ iter::FusedIterator
	+ Clone;

/// Mutable iterator over an [`Object`]'s members in insertion order.
pub type ObjectIterMut<'a> = impl DoubleEndedIterator<Item = (&'a Str, &'a mut Value)>
	+ ExactSizeIterator
	+ iter::FusedIterator;

impl Object {
	/// An empty object.
	pub const fn new() -> Self {
		Self(Vec::new())
	}

	/// An empty object with room for `capacity` members before reallocating.
	pub fn with_capacity(capacity: usize) -> Self {
		Self(Vec::with_capacity(capacity))
	}

	/// Number of members.
	pub const fn len(&self) -> usize {
		self.0.len()
	}

	/// Whether the object has no members.
	pub const fn is_empty(&self) -> bool {
		self.0.is_empty()
	}

	/// Value for `key`; `None` when absent.
	pub fn get(&self, key: &str) -> Option<&Value> {
		self.0.iter().find_map(|(k, v)| (&**k == key).then_some(v))
	}

	/// Insert or overwrite `key`, returning the previous value if any.
	pub fn insert(&mut self, key: Str, value: Value) -> Option<Value> {
		if let Some(slot) = self.0.iter_mut().find(|(k, _)| *k == key) {
			Some(mem::replace(&mut slot.1, value))
		} else {
			self.0.push((key, value));
			None
		}
	}

	/// Members in insertion order.
	#[define_opaque(ObjectIter)]
	pub fn iter(&self) -> ObjectIter<'_> {
		self.0.iter().map(|(key, value)| (key, value))
	}

	/// Members in insertion order, with mutable values.
	#[define_opaque(ObjectIterMut)]
	pub fn iter_mut(&mut self) -> ObjectIterMut<'_> {
		self.0.iter_mut().map(|(key, value)| (&*key, value))
	}
}

impl PartialEq for Object {
	fn eq(&self, other: &Self) -> bool {
		self.0.len() == other.0.len()
			&& self
				.0
				.iter()
				.all(|(key, value)| other.get(key) == Some(value))
	}
}

impl Display for Object {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_char('{')?;
		for (i, (key, value)) in self.0.iter().enumerate() {
			if i > 0 {
				f.write_char(',')?;
			}
			write_escaped(f, key)?;
			f.write_char(':')?;
			value.fmt(f)?;
		}
		f.write_char('}')
	}
}

impl<'a> IntoIterator for &'a Object {
	type IntoIter = ObjectIter<'a>;
	type Item = (&'a Str, &'a Value);

	fn into_iter(self) -> Self::IntoIter {
		self.iter()
	}
}

impl<'a> IntoIterator for &'a mut Object {
	type IntoIter = ObjectIterMut<'a>;
	type Item = (&'a Str, &'a mut Value);

	fn into_iter(self) -> Self::IntoIter {
		self.iter_mut()
	}
}

impl IntoIterator for Object {
	type IntoIter = vec::IntoIter<(Str, Value)>;
	type Item = (Str, Value);

	fn into_iter(self) -> Self::IntoIter {
		self.0.into_iter()
	}
}

impl FromIterator<(Str, Value)> for Object {
	fn from_iter<I: IntoIterator<Item = (Str, Value)>>(iter: I) -> Self {
		let mut object = Self::new();
		for (key, value) in iter {
			object.insert(key, value);
		}
		object
	}
}

// ── Conversions into Value ───────────────────────────────────────────────────

impl From<bool> for Value {
	fn from(value: bool) -> Self {
		Self::Bool(value)
	}
}

impl From<&str> for Value {
	fn from(value: &str) -> Self {
		Self::String(Str::new(value))
	}
}

impl From<String> for Value {
	fn from(value: String) -> Self {
		Self::String(Str::from(value))
	}
}

impl From<Str> for Value {
	fn from(value: Str) -> Self {
		Self::String(value)
	}
}

impl From<Number> for Value {
	fn from(value: Number) -> Self {
		Self::Number(value)
	}
}

impl From<Object> for Value {
	fn from(value: Object) -> Self {
		Self::Object(value)
	}
}

/// Non-finite floats become `Null`, mirroring JSON's lack of NaN/Infinity.
impl From<f64> for Value {
	fn from(value: f64) -> Self {
		Number::from_f64(value).map_or(Self::Null, Self::Number)
	}
}

impl From<f32> for Value {
	fn from(value: f32) -> Self {
		Self::from(f64::from(value))
	}
}

macro_rules! impl_from_unsigned {
	($($ty:ty),*) => {$(
		impl From<$ty> for Value {
			fn from(value: $ty) -> Self {
				Self::Number(Number::from(value as u64))
			}
		}
	)*};
}

macro_rules! impl_from_signed {
	($($ty:ty),*) => {$(
		impl From<$ty> for Value {
			fn from(value: $ty) -> Self {
				Self::Number(Number::from(value as i64))
			}
		}
	)*};
}

impl_from_unsigned!(u8, u16, u32, u64, usize);
impl_from_signed!(i8, i16, i32, i64, isize);

impl<T: Into<Self>> From<Vec<T>> for Value {
	fn from(values: Vec<T>) -> Self {
		Self::Array(values.into_iter().map(Into::into).collect())
	}
}

impl<T: Into<Self> + Clone> From<&[T]> for Value {
	fn from(values: &[T]) -> Self {
		Self::Array(values.iter().cloned().map(Into::into).collect())
	}
}

impl<T: Into<Self>> From<Option<T>> for Value {
	fn from(value: Option<T>) -> Self {
		value.map_or(Self::Null, Into::into)
	}
}

impl From<()> for Value {
	fn from((): ()) -> Self {
		Self::Null
	}
}

impl<T: Into<Self>> FromIterator<T> for Value {
	fn from_iter<I: IntoIterator<Item = T>>(iter: I) -> Self {
		Self::Array(iter.into_iter().map(Into::into).collect())
	}
}

// ── serde integration ────────────────────────────────────────────────────────

impl serde::Serialize for Number {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		if let Some(unsigned) = self.as_u64() {
			serializer.serialize_u64(unsigned)
		} else if let Some(signed) = self.as_i64() {
			serializer.serialize_i64(signed)
		} else {
			serializer.serialize_f64(self.as_f64())
		}
	}
}

impl serde::Serialize for Value {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		match self {
			Self::Null => serializer.serialize_unit(),
			Self::Bool(b) => serializer.serialize_bool(*b),
			Self::Number(n) => n.serialize(serializer),
			Self::String(s) => serializer.serialize_str(s),
			Self::Array(items) => serializer.collect_seq(items),
			Self::Object(object) => serializer.collect_map(object.iter()),
		}
	}
}

/// `Value` is an ordinary visitor over any self-describing deserializer;
/// [`parse`](crate::slopjson::parse) is exactly `from_str::<Value>`.
impl<'de> serde::Deserialize<'de> for Value {
	fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		struct ValueVisitor;

		impl<'de> serde::de::Visitor<'de> for ValueVisitor {
			type Value = Value;

			fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
				f.write_str("any JSON value")
			}

			fn visit_bool<E>(self, v: bool) -> Result<Value, E> {
				Ok(Value::Bool(v))
			}

			fn visit_i64<E>(self, v: i64) -> Result<Value, E> {
				Ok(Value::Number(Number::from(v)))
			}

			fn visit_u64<E>(self, v: u64) -> Result<Value, E> {
				Ok(Value::Number(Number::from(v)))
			}

			fn visit_f64<E>(self, v: f64) -> Result<Value, E> {
				Ok(Value::from(v))
			}

			fn visit_str<E>(self, v: &str) -> Result<Value, E> {
				Ok(Value::String(Str::new(v)))
			}

			fn visit_string<E>(self, v: String) -> Result<Value, E> {
				Ok(Value::String(Str::from(v)))
			}

			fn visit_none<E>(self) -> Result<Value, E> {
				Ok(Value::Null)
			}

			fn visit_unit<E>(self) -> Result<Value, E> {
				Ok(Value::Null)
			}

			fn visit_some<D: serde::Deserializer<'de>>(
				self,
				deserializer: D,
			) -> Result<Value, D::Error> {
				serde::Deserialize::deserialize(deserializer)
			}

			fn visit_seq<A: serde::de::SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
				let mut items = Vec::with_capacity(seq.size_hint().unwrap_or(0).min(64));
				while let Some(item) = seq.next_element()? {
					items.push(item);
				}
				Ok(Value::Array(items))
			}

			fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
				let mut object = Object::with_capacity(map.size_hint().unwrap_or(0).min(64));
				while let Some((key, value)) = map.next_entry::<Str, Value>()? {
					object.insert(key, value);
				}
				Ok(Value::Object(object))
			}
		}

		deserializer.deserialize_any(ValueVisitor)
	}
}

struct ValueSeqAccess<'de> {
	iter: slice::Iter<'de, Value>,
}

impl<'de> serde::de::SeqAccess<'de> for ValueSeqAccess<'de> {
	type Error = value::Error;

	fn next_element_seed<T>(&mut self, seed: T) -> Result<Option<T::Value>, Self::Error>
	where
		T: serde::de::DeserializeSeed<'de>,
	{
		self
			.iter
			.next()
			.map(|value| seed.deserialize(value))
			.transpose()
	}

	fn size_hint(&self) -> Option<usize> {
		Some(self.iter.len())
	}
}

struct ValueMapAccess<'de> {
	iter:  ObjectIter<'de>,
	value: Option<&'de Value>,
}

impl<'de> serde::de::MapAccess<'de> for ValueMapAccess<'de> {
	type Error = value::Error;

	fn next_key_seed<K>(&mut self, seed: K) -> Result<Option<K::Value>, Self::Error>
	where
		K: serde::de::DeserializeSeed<'de>,
	{
		let Some((key, value)) = self.iter.next() else {
			return Ok(None);
		};
		self.value = Some(value);
		seed
			.deserialize(BorrowedStrDeserializer::new(key.as_str()))
			.map(Some)
	}

	fn next_value_seed<V>(&mut self, seed: V) -> Result<V::Value, Self::Error>
	where
		V: serde::de::DeserializeSeed<'de>,
	{
		let value = self
			.value
			.take()
			.ok_or_else(|| value::Error::custom("value requested before map key"))?;
		seed.deserialize(value)
	}

	fn size_hint(&self) -> Option<usize> {
		Some(self.iter.len())
	}
}

struct ValueEnumAccess<'de> {
	key:   &'de str,
	value: Option<&'de Value>,
}

impl<'de> serde::de::EnumAccess<'de> for ValueEnumAccess<'de> {
	type Error = value::Error;
	type Variant = ValueVariantAccess<'de>;

	fn variant_seed<V>(self, seed: V) -> Result<(V::Value, Self::Variant), Self::Error>
	where
		V: serde::de::DeserializeSeed<'de>,
	{
		let variant = seed.deserialize(BorrowedStrDeserializer::new(self.key))?;
		Ok((variant, ValueVariantAccess { value: self.value }))
	}
}

struct ValueVariantAccess<'de> {
	value: Option<&'de Value>,
}

impl<'de> serde::de::VariantAccess<'de> for ValueVariantAccess<'de> {
	type Error = value::Error;

	fn unit_variant(self) -> Result<(), Self::Error> {
		match self.value {
			None | Some(Value::Null) => Ok(()),
			Some(value) => serde::Deserialize::deserialize(value),
		}
	}

	fn newtype_variant_seed<T>(self, seed: T) -> Result<T::Value, Self::Error>
	where
		T: serde::de::DeserializeSeed<'de>,
	{
		seed.deserialize(
			self
				.value
				.ok_or_else(|| value::Error::custom("missing enum newtype value"))?,
		)
	}

	fn tuple_variant<V>(self, _len: usize, visitor: V) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		serde::Deserializer::deserialize_seq(
			self
				.value
				.ok_or_else(|| value::Error::custom("missing enum tuple value"))?,
			visitor,
		)
	}

	fn struct_variant<V>(
		self,
		_fields: &'static [&'static str],
		visitor: V,
	) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		serde::Deserializer::deserialize_map(
			self
				.value
				.ok_or_else(|| value::Error::custom("missing enum struct value"))?,
			visitor,
		)
	}
}

impl<'de> serde::Deserializer<'de> for &'de Value {
	type Error = value::Error;

	serde::forward_to_deserialize_any! {
		bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes
		byte_buf unit unit_struct seq tuple tuple_struct map struct
	}

	fn deserialize_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		match self {
			Value::Null => visitor.visit_unit(),
			Value::Bool(value) => visitor.visit_bool(*value),
			Value::Number(number) => {
				if let Some(value) = number.as_u64() {
					visitor.visit_u64(value)
				} else if let Some(value) = number.as_i64() {
					visitor.visit_i64(value)
				} else {
					visitor.visit_f64(number.as_f64())
				}
			},
			Value::String(value) => visitor.visit_borrowed_str(value),
			Value::Array(values) => visitor.visit_seq(ValueSeqAccess { iter: values.iter() }),
			Value::Object(object) => {
				visitor.visit_map(ValueMapAccess { iter: object.iter(), value: None })
			},
		}
	}

	fn deserialize_option<V>(self, visitor: V) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		if matches!(self, Value::Null) {
			visitor.visit_none()
		} else {
			visitor.visit_some(self)
		}
	}

	fn deserialize_newtype_struct<V>(
		self,
		_name: &'static str,
		visitor: V,
	) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		visitor.visit_newtype_struct(self)
	}

	fn deserialize_enum<V>(
		self,
		_name: &'static str,
		_variants: &'static [&'static str],
		visitor: V,
	) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		match self {
			Value::String(key) => {
				visitor.visit_enum(ValueEnumAccess { key: key.as_str(), value: None })
			},
			Value::Object(object) if object.len() == 1 => {
				let (key, value) = object.iter().next().expect("length checked");
				visitor.visit_enum(ValueEnumAccess { key: key.as_str(), value: Some(value) })
			},
			_ => Err(value::Error::custom("expected enum string or single-key object")),
		}
	}

	fn deserialize_identifier<V>(self, visitor: V) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		match self {
			Value::String(value) => visitor.visit_borrowed_str(value),
			_ => self.deserialize_any(visitor),
		}
	}

	fn deserialize_ignored_any<V>(self, visitor: V) -> Result<V::Value, Self::Error>
	where
		V: serde::de::Visitor<'de>,
	{
		visitor.visit_unit()
	}
}
