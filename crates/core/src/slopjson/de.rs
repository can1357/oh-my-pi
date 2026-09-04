//! One-pass `serde` deserialization over the tolerant grammar.
//!
//! [`from_str`] drives any `T: Deserialize` directly off the lexer — no
//! intermediate tree. [`Value`] is just one visitor: [`parse`] is
//! `from_str::<Value>`.

use std::mem;

use serde::{
	de::{
		self, DeserializeSeed, Unexpected, Visitor,
		value::{BorrowedStrDeserializer, StrDeserializer},
	},
	forward_to_deserialize_any,
};

use crate::{
	CowStr, Str,
	slopjson::{
		error::ParseError,
		parser::{Atom, MAX_DEPTH, Mode, Parser, Repair, RepairLog, RepairPathSegment},
		raw,
		value::Value,
	},
};

/// Deserialize `T` from tolerant JSON: strict JSON plus malformations commonly
/// produced by language models.
///
/// Truncated input, trailing garbage, and non-finite numbers still fail rather
/// than yielding a partially trusted value.
pub fn from_str<'de, T: serde::Deserialize<'de>>(json: &'de str) -> Result<T, ParseError> {
	let mut de = Deserializer::new(json);
	let value = T::deserialize(&mut de)?;
	de.end()?;
	Ok(value)
}

/// Final-parse a JSON value, accepting and normalizing the common LLM
/// malformations.
///
/// Equivalent to [`from_str`] with `Value` as the target. Strict JSON
/// parses unchanged; truncated input and trailing garbage fail.
pub fn parse(json: &str) -> Result<Value, ParseError> {
	from_str(json)
}

/// `serde` deserializer over the tolerant grammar; one pass, no intermediate
/// tree. Construct via [`from_str`] unless composing manually.
pub struct Deserializer<'de> {
	p:              Parser<'de>,
	depth:          u32,
	/// Whether an unrecognized token may recover as a bareword string —
	/// true only in object/array value position, mirroring the TS parser.
	allow_bareword: bool,
	pending_key:    Option<Str>,
}

impl<'de> Deserializer<'de> {
	/// Deserializer over `json` positioned at the start; does not verify
	/// trailing content — call [`end`](Self::end) after the value.
	pub const fn new(json: &'de str) -> Self {
		Self {
			p:              Parser::new(json, Mode::Strict),
			depth:          0,
			allow_bareword: false,
			pending_key:    None,
		}
	}

	/// Verify nothing but whitespace/comments remains.
	pub fn end(&mut self) -> Result<(), ParseError> {
		self.p.ws();
		if self.p.at_end() {
			Ok(())
		} else {
			Err(ParseError::TrailingCharacters(self.p.pos()))
		}
	}

	/// Borrow tolerance repairs observed during deserialization so far.
	pub fn repairs(&self) -> &[Repair] {
		self.p.repairs()
	}

	/// Consume this deserializer and return its compact repair record.
	pub fn into_repairs(mut self) -> RepairLog {
		self.p.take_repairs()
	}

	fn peek_some(&mut self) -> Result<u8, ParseError> {
		self.p.ws();
		match self.p.peek() {
			Some(byte) => Ok(byte),
			None => Err(ParseError::UnexpectedEnd),
		}
	}

	const fn descend(&mut self) -> Result<(), ParseError> {
		if self.depth >= MAX_DEPTH {
			return Err(ParseError::DepthExceeded);
		}
		self.depth += 1;
		Ok(())
	}

	/// Deserialize an object key (quoted or unquoted) into `seed`.
	fn map_key_seed<K: DeserializeSeed<'de>>(&mut self, seed: K) -> Result<K::Value, ParseError> {
		let start = self.p.pos();
		if let Some(quote @ (b'"' | b'\'')) = self.p.peek() {
			match self.p.string(quote)? {
				CowStr::Borrowed(key) => {
					let path_key = Str::new(key);
					self
						.p
						.retarget_repairs_from(start, RepairPathSegment::Key(path_key.clone()));
					self.pending_key = Some(path_key);
					seed.deserialize(BorrowedStrDeserializer::<ParseError>::new(key))
				},
				CowStr::Owned(key) => {
					let path_key = Str::new(key.as_str());
					self
						.p
						.retarget_repairs_from(start, RepairPathSegment::Key(path_key.clone()));
					self.pending_key = Some(path_key);
					seed.deserialize(StrDeserializer::<ParseError>::new(key.as_str()))
				},
			}
		} else {
			let key = self.p.unquoted_key();
			if key.is_empty() {
				return Err(ParseError::ExpectedKey(start));
			}
			let path_key = Str::new(key);
			self
				.p
				.retarget_repairs_from(start, RepairPathSegment::Key(path_key.clone()));
			self.pending_key = Some(path_key);
			seed.deserialize(BorrowedStrDeserializer::<ParseError>::new(key))
		}
	}

	/// Run `f` with bareword recovery enabled (value position).
	fn in_value_position<R>(&mut self, f: impl FnOnce(&mut Self) -> R) -> R {
		let prev = mem::replace(&mut self.allow_bareword, true);
		let result = f(self);
		self.allow_bareword = prev;
		result
	}
}

impl<'de> de::Deserializer<'de> for &mut Deserializer<'de> {
	type Error = ParseError;

	forward_to_deserialize_any! {
		bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string
		bytes byte_buf unit unit_struct seq tuple tuple_struct map struct
		identifier ignored_any
	}

	fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ParseError> {
		match self.peek_some()? {
			b'{' => {
				self.descend()?;
				self.p.bump();
				let out = visitor.visit_map(CommaSeparated {
					de:         self,
					first:      true,
					next_index: 0,
				});
				self.depth -= 1;
				out
			},
			b'[' => {
				self.descend()?;
				self.p.bump();
				let out = visitor.visit_seq(CommaSeparated {
					de:         self,
					first:      true,
					next_index: 0,
				});
				self.depth -= 1;
				out
			},
			quote @ (b'"' | b'\'') => match self.p.string(quote)? {
				CowStr::Borrowed(text) => visitor.visit_borrowed_str(text),
				CowStr::Owned(text) => visitor.visit_str(text.as_str()),
			},
			b'-' | b'+' | b'.' | b'0'..=b'9' => {
				// JS-only NaN / Infinity are deliberately not accepted because JSON
				// cannot represent non-finite numbers.
				let number = self
					.p
					.number()?
					.expect("strict mode yields a number or an error");
				if let Some(unsigned) = number.as_u64() {
					visitor.visit_u64(unsigned)
				} else if let Some(signed) = number.as_i64() {
					visitor.visit_i64(signed)
				} else {
					visitor.visit_f64(number.as_f64())
				}
			},
			_ => match self.p.match_keyword() {
				Some(Atom::Bool(b)) => visitor.visit_bool(b),
				Some(Atom::Null) => visitor.visit_unit(),
				None if self.allow_bareword => visitor.visit_borrowed_str(self.p.bareword()?),
				None => Err(ParseError::UnexpectedToken(self.p.pos())),
			},
		}
	}

	fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, ParseError> {
		self.peek_some()?;
		if self.p.eat_null() {
			visitor.visit_none()
		} else {
			visitor.visit_some(self)
		}
	}

	/// A newtype struct is transparent, except the
	/// [`RawValue`](crate::slopjson::RawValue) capture token: the next value is
	/// skipped and its verbatim source span handed to the visitor instead.
	fn deserialize_newtype_struct<V: Visitor<'de>>(
		self,
		name: &'static str,
		visitor: V,
	) -> Result<V::Value, ParseError> {
		if name == raw::TOKEN {
			self.p.ws();
			let start = self.p.pos();
			(&mut *self).deserialize_any(de::IgnoredAny)?;
			return visitor.visit_borrowed_str(self.p.src_from(start).trim_ascii_end());
		}
		visitor.visit_newtype_struct(self)
	}

	/// Enums as `serde_json` encodes them: a bare string is a unit variant,
	/// `{"Variant": value}` carries data.
	fn deserialize_enum<V: Visitor<'de>>(
		self,
		_name: &'static str,
		_variants: &'static [&'static str],
		visitor: V,
	) -> Result<V::Value, ParseError> {
		match self.peek_some()? {
			b'{' => {
				self.descend()?;
				self.p.bump();
				self.p.ws();
				let value = visitor.visit_enum(VariantAccess { de: self })?;
				self.depth -= 1;
				self.p.ws();
				if self.p.peek() == Some(b'}') {
					self.p.bump();
					Ok(value)
				} else {
					Err(ParseError::ExpectedCommaOrBrace(self.p.pos()))
				}
			},
			b'"' | b'\'' => visitor.visit_enum(UnitVariantAccess { de: self }),
			_ => Err(ParseError::UnexpectedToken(self.p.pos())),
		}
	}
}

/// Object/array walker with the tolerant comma rules: leading, doubled, and
/// trailing commas are skipped; a missing comma between entries still fails.
struct CommaSeparated<'a, 'de> {
	de:         &'a mut Deserializer<'de>,
	first:      bool,
	next_index: usize,
}

impl<'de> de::MapAccess<'de> for CommaSeparated<'_, 'de> {
	type Error = ParseError;

	fn next_key_seed<K: DeserializeSeed<'de>>(
		&mut self,
		seed: K,
	) -> Result<Option<K::Value>, ParseError> {
		self.de.p.ws();
		let mut saw_comma = false;
		loop {
			match self.de.p.peek() {
				None => {
					return Err(ParseError::UnterminatedObject);
				},
				Some(b'}') => {
					self.de.p.bump();
					return Ok(None);
				},
				Some(b',') => {
					let comma = self.de.p.pos();
					self.de.p.bump();
					self.de.p.ws();
					let trailing = self.de.p.peek() == Some(b'}');
					if trailing || self.first || saw_comma {
						self.de.p.record_comma(comma, trailing);
					}
					saw_comma = true;
				},
				Some(_) => break,
			}
		}
		if !self.first && !saw_comma {
			return Err(ParseError::ExpectedCommaOrBrace(self.de.p.pos()));
		}
		self.first = false;
		self.de.map_key_seed(seed).map(Some)
	}

	fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, ParseError> {
		self.de.p.ws();
		if self.de.p.peek() == Some(b':') {
			self.de.p.bump();
		} else {
			return Err(ParseError::ExpectedColon(self.de.p.pos()));
		}
		self.de.p.ws();
		if self.de.p.at_end() {
			return Err(ParseError::ExpectedValue(self.de.p.pos()));
		}
		let key = self
			.de
			.pending_key
			.take()
			.expect("map value follows a parsed key");
		self.de.p.push_repair_path(RepairPathSegment::Key(key));
		let result = self.de.in_value_position(|de| seed.deserialize(&mut *de));
		self.de.p.pop_repair_path();
		result
	}
}

impl<'de> de::SeqAccess<'de> for CommaSeparated<'_, 'de> {
	type Error = ParseError;

	fn next_element_seed<T: DeserializeSeed<'de>>(
		&mut self,
		seed: T,
	) -> Result<Option<T::Value>, ParseError> {
		self.de.p.ws();
		let mut saw_comma = false;
		loop {
			match self.de.p.peek() {
				None => {
					return Err(ParseError::UnterminatedArray);
				},
				Some(b']') => {
					self.de.p.bump();
					return Ok(None);
				},
				Some(b',') => {
					let comma = self.de.p.pos();
					self.de.p.bump();
					self.de.p.ws();
					let trailing = self.de.p.peek() == Some(b']');
					if trailing || self.first || saw_comma {
						self.de.p.record_comma(comma, trailing);
					}
					saw_comma = true;
				},
				Some(_) => break,
			}
		}
		if !self.first && !saw_comma {
			return Err(ParseError::ExpectedCommaOrBracket(self.de.p.pos()));
		}
		self.first = false;
		let index = self.next_index;
		self.next_index += 1;
		self.de.p.push_repair_path(RepairPathSegment::Index(index));
		let result = self
			.de
			.in_value_position(|de| seed.deserialize(&mut *de))
			.map(Some);
		self.de.p.pop_repair_path();
		result
	}
}

/// `{"Variant": value}` enum form.
struct VariantAccess<'a, 'de> {
	de: &'a mut Deserializer<'de>,
}

impl<'de> de::EnumAccess<'de> for VariantAccess<'_, 'de> {
	type Error = ParseError;
	type Variant = Self;

	fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Self), ParseError> {
		let variant = self.de.map_key_seed(seed)?;
		self.de.p.ws();
		if self.de.p.peek() == Some(b':') {
			self.de.p.bump();
			Ok((variant, self))
		} else {
			Err(ParseError::ExpectedColon(self.de.p.pos()))
		}
	}
}

impl<'de> de::VariantAccess<'de> for VariantAccess<'_, 'de> {
	type Error = ParseError;

	fn unit_variant(self) -> Result<(), ParseError> {
		serde::Deserialize::deserialize(&mut *self.de)
	}

	fn newtype_variant_seed<T: DeserializeSeed<'de>>(self, seed: T) -> Result<T::Value, ParseError> {
		self.de.in_value_position(|de| seed.deserialize(&mut *de))
	}

	fn tuple_variant<V: Visitor<'de>>(
		self,
		_len: usize,
		visitor: V,
	) -> Result<V::Value, ParseError> {
		de::Deserializer::deserialize_seq(&mut *self.de, visitor)
	}

	fn struct_variant<V: Visitor<'de>>(
		self,
		_fields: &'static [&'static str],
		visitor: V,
	) -> Result<V::Value, ParseError> {
		de::Deserializer::deserialize_map(&mut *self.de, visitor)
	}
}

/// Bare-string enum form (`"Variant"`).
struct UnitVariantAccess<'a, 'de> {
	de: &'a mut Deserializer<'de>,
}

impl<'de> de::EnumAccess<'de> for UnitVariantAccess<'_, 'de> {
	type Error = ParseError;
	type Variant = Self;

	fn variant_seed<V: DeserializeSeed<'de>>(self, seed: V) -> Result<(V::Value, Self), ParseError> {
		let variant = seed.deserialize(&mut *self.de)?;
		Ok((variant, self))
	}
}

impl<'de> de::VariantAccess<'de> for UnitVariantAccess<'_, 'de> {
	type Error = ParseError;

	fn unit_variant(self) -> Result<(), ParseError> {
		Ok(())
	}

	fn newtype_variant_seed<T: DeserializeSeed<'de>>(
		self,
		_seed: T,
	) -> Result<T::Value, ParseError> {
		Err(de::Error::invalid_type(Unexpected::UnitVariant, &"newtype variant"))
	}

	fn tuple_variant<V: Visitor<'de>>(
		self,
		_len: usize,
		_visitor: V,
	) -> Result<V::Value, ParseError> {
		Err(de::Error::invalid_type(Unexpected::UnitVariant, &"tuple variant"))
	}

	fn struct_variant<V: Visitor<'de>>(
		self,
		_fields: &'static [&'static str],
		_visitor: V,
	) -> Result<V::Value, ParseError> {
		Err(de::Error::invalid_type(Unexpected::UnitVariant, &"struct variant"))
	}
}
