//! Input adapter for Go protojson's strict dialect. prost-reflect supplies the
//! descriptors and well-known types, but its generic serde visitor accepts
//! duplicate fields and handles quoted integer exponents differently from Go.
//! Borrow raw values while constructing DynamicMessage directly: no JSON tree
//! or lossy floating-point intermediate for integer fields.
//!
//! Compatibility boundary: recursive descriptor walking is capped at 100
//! levels to keep untrusted inputs off an unbounded Rust call stack. The Go
//! protobuf default is 10,000; deeper inputs fail explicitly instead of
//! risking stack exhaustion.
use std::{
	borrow::Cow,
	collections::{HashMap, HashSet},
	fmt,
};

use prost_reflect::{DynamicMessage, Kind, MapKey, MessageDescriptor, Value};
use serde::de::{self, MapAccess, SeqAccess, Visitor};
use serde_json::value::RawValue;

use crate::{Result, serialize::decode_checkpoint};

pub fn parse_message(descriptor: MessageDescriptor, input: &[u8]) -> Result<DynamicMessage> {
	message(descriptor, input, 0)
}

fn message(descriptor: MessageDescriptor, input: &[u8], depth: usize) -> Result<DynamicMessage> {
	if depth > 100 {
		return Err("protobuf JSON recursion limit exceeded".into());
	}
	// Timestamp/Duration use the protobuf well-known JSON grammar; Struct/Value
	// are handled below so duplicate object members are not silently accepted.
	match descriptor.full_name() {
		"google.protobuf.Timestamp" | "google.protobuf.Duration" => {
			let mut decoder = serde_json::Deserializer::from_slice(input);
			let message = DynamicMessage::deserialize(descriptor, &mut decoder)?;
			decoder.end()?;
			return Ok(message);
		},
		"google.protobuf.Struct" => {
			let field = descriptor
				.get_field_by_name("fields")
				.ok_or("missing Struct descriptor")?;
			let value = map_value(&field.kind(), std::str::from_utf8(input)?, depth + 1)?;
			let mut output = DynamicMessage::new(descriptor);
			output.set_field(&field, value);
			return Ok(output);
		},
		"google.protobuf.ListValue" => {
			let field = descriptor
				.get_field_by_name("values")
				.ok_or("missing ListValue descriptor")?;
			let value = list_value(&field.kind(), std::str::from_utf8(input)?, depth + 1)?;
			let mut output = DynamicMessage::new(descriptor);
			output.set_field(&field, value);
			return Ok(output);
		},
		"google.protobuf.Value" => {
			let input = std::str::from_utf8(input)?.trim();
			let name = match input.as_bytes().first() {
				Some(b'n') => "null_value",
				Some(b't' | b'f') => "bool_value",
				Some(b'\"') => "string_value",
				Some(b'[') => "list_value",
				Some(b'{') => "struct_value",
				_ => "number_value",
			};
			let field = descriptor
				.get_field_by_name(name)
				.ok_or("missing Value descriptor")?;
			let value = singular(&field.kind(), input, depth + 1)?;
			let mut output = DynamicMessage::new(descriptor);
			output.set_field(&field, value);
			return Ok(output);
		},
		_ => {},
	}
	struct MessageVisitor {
		descriptor: MessageDescriptor,
		depth:      usize,
	}
	impl<'de> Visitor<'de> for MessageVisitor {
		type Value = DynamicMessage;

		fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
			f.write_str("protobuf message object")
		}

		fn visit_map<A: MapAccess<'de>>(
			self,
			mut map: A,
		) -> std::result::Result<Self::Value, A::Error> {
			let mut output = DynamicMessage::new(self.descriptor.clone());
			let mut seen = HashSet::new();
			let mut oneofs = HashSet::new();
			while let Some(name) = map.next_key::<Cow<'de, str>>()? {
				let raw = map.next_value::<&'de RawValue>()?.get();
				if let Some(field) = self
					.descriptor
					.get_field_by_json_name(&name)
					.or_else(|| self.descriptor.get_field_by_name(&name))
				{
					let kind = field.kind();
					if !seen.insert(field.number()) {
						return Err(de::Error::custom(format!("duplicate field {}", field.name())));
					}
					if raw == "null" && !null_is_value(&kind) {
						continue;
					}
					if let Some(oneof) = field.containing_oneof() {
						if !oneofs.insert(oneof.name().to_owned()) {
							return Err(de::Error::custom(format!(
								"multiple values for oneof {}",
								oneof.name()
							)));
						}
					}
					let value = if field.is_list() {
						list_value(&kind, raw, self.depth + 1)
					} else if field.is_map() {
						map_value(&kind, raw, self.depth + 1)
					} else {
						singular(&kind, raw, self.depth + 1)
					}
					.map_err(de::Error::custom)?;
					output.set_field(&field, value);
				} else if let Some(extension) = self
					.descriptor
					.extensions()
					.find(|extension| extension.json_name() == name)
				{
					let kind = extension.kind();
					if !seen.insert(extension.number()) {
						return Err(de::Error::custom("duplicate extension field"));
					}
					if raw == "null" && !null_is_value(&kind) {
						continue;
					}
					let value = if extension.is_list() {
						list_value(&kind, raw, self.depth + 1)
					} else {
						singular(&kind, raw, self.depth + 1)
					}
					.map_err(de::Error::custom)?;
					output.set_extension(&extension, value);
				} else {
					return Err(de::Error::custom(format!("unknown field {name:?}")));
				}
			}
			Ok(output)
		}
	}
	let mut decoder = serde_json::Deserializer::from_slice(input);
	let output =
		serde::Deserializer::deserialize_map(&mut decoder, MessageVisitor { descriptor, depth })?;
	decoder.end()?;
	Ok(output)
}

fn null_is_value(kind: &Kind) -> bool {
	match kind {
		Kind::Message(message) => message.full_name() == "google.protobuf.Value",
		Kind::Enum(value) => value.full_name() == "google.protobuf.NullValue",
		_ => false,
	}
}

fn list_value(kind: &Kind, input: &str, depth: usize) -> Result<Value> {
	struct ListVisitor<'a>(&'a Kind, usize);
	impl<'de> Visitor<'de> for ListVisitor<'_> {
		type Value = Vec<Value>;

		fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
			f.write_str("protobuf repeated field array")
		}

		fn visit_seq<A: SeqAccess<'de>>(
			self,
			mut sequence: A,
		) -> std::result::Result<Self::Value, A::Error> {
			let mut values = Vec::with_capacity(sequence.size_hint().unwrap_or(0));
			while let Some(raw) = sequence.next_element::<&'de RawValue>()? {
				values.push(singular(self.0, raw.get(), self.1).map_err(de::Error::custom)?);
			}
			Ok(values)
		}
	}
	let mut decoder = serde_json::Deserializer::from_str(input);
	let output = serde::Deserializer::deserialize_seq(&mut decoder, ListVisitor(kind, depth))?;
	decoder.end()?;
	Ok(Value::List(output))
}

fn map_value(kind: &Kind, input: &str, depth: usize) -> Result<Value> {
	struct MapVisitor {
		key:   Kind,
		value: Kind,
		depth: usize,
	}
	impl<'de> Visitor<'de> for MapVisitor {
		type Value = HashMap<MapKey, Value>;

		fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
			f.write_str("protobuf map object")
		}

		fn visit_map<A: MapAccess<'de>>(
			self,
			mut map: A,
		) -> std::result::Result<Self::Value, A::Error> {
			let mut values = HashMap::with_capacity(map.size_hint().unwrap_or(0));
			while let Some(key) = map.next_key::<String>()? {
				let key = match self.key {
					Kind::Bool => MapKey::Bool(match key.as_str() {
						"true" => true,
						"false" => false,
						_ => return Err(de::Error::custom("invalid boolean map key")),
					}),
					Kind::Int32 | Kind::Sint32 | Kind::Sfixed32 => {
						MapKey::I32(key.parse().map_err(de::Error::custom)?)
					},
					Kind::Int64 | Kind::Sint64 | Kind::Sfixed64 => {
						MapKey::I64(key.parse().map_err(de::Error::custom)?)
					},
					Kind::Uint32 | Kind::Fixed32 => MapKey::U32(key.parse().map_err(de::Error::custom)?),
					Kind::Uint64 | Kind::Fixed64 => MapKey::U64(key.parse().map_err(de::Error::custom)?),
					Kind::String => MapKey::String(key),
					_ => return Err(de::Error::custom("invalid protobuf map key descriptor")),
				};
				if values.contains_key(&key) {
					return Err(de::Error::custom("duplicate protobuf map key"));
				}
				let raw = map.next_value::<&'de RawValue>()?;
				let value = singular(&self.value, raw.get(), self.depth).map_err(de::Error::custom)?;
				values.insert(key, value);
			}
			Ok(values)
		}
	}
	let descriptor = kind.as_message().ok_or("invalid protobuf map descriptor")?;
	let visitor = MapVisitor {
		key: descriptor.map_entry_key_field().kind(),
		value: descriptor.map_entry_value_field().kind(),
		depth,
	};
	let mut decoder = serde_json::Deserializer::from_str(input);
	let output = serde::Deserializer::deserialize_map(&mut decoder, visitor)?;
	decoder.end()?;
	Ok(Value::Map(output))
}

fn scalar_text(input: &str) -> Result<Cow<'_, str>> {
	if input.starts_with('"') {
		Ok(serde_json::from_str::<String>(input)?.into())
	} else {
		Ok(input.into())
	}
}

fn singular(kind: &Kind, input: &str, depth: usize) -> Result<Value> {
	if depth > 100 {
		return Err("protobuf JSON recursion limit exceeded".into());
	}
	Ok(match kind {
		Kind::Message(descriptor) => {
			Value::Message(message(descriptor.clone(), input.as_bytes(), depth)?)
		},
		Kind::String => Value::String(serde_json::from_str(input)?),
		Kind::Bytes => {
			Value::Bytes(decode_checkpoint(&serde_json::from_str::<String>(input)?)?.into())
		},
		Kind::Bool => Value::Bool(serde_json::from_str(input)?),
		Kind::Int32 | Kind::Sint32 | Kind::Sfixed32 => {
			Value::I32(i32::try_from(signed_integer(&scalar_text(input)?)?)?)
		},
		Kind::Int64 | Kind::Sint64 | Kind::Sfixed64 => {
			Value::I64(signed_integer(&scalar_text(input)?)?)
		},
		Kind::Uint32 | Kind::Fixed32 => {
			Value::U32(u32::try_from(unsigned_integer(&scalar_text(input)?)?)?)
		},
		Kind::Uint64 | Kind::Fixed64 => Value::U64(unsigned_integer(&scalar_text(input)?)?),
		Kind::Float => {
			let text = scalar_text(input)?;
			let number = match text.as_ref() {
				"NaN" if input.starts_with('"') => f32::NAN,
				"Infinity" if input.starts_with('"') => f32::INFINITY,
				"-Infinity" if input.starts_with('"') => f32::NEG_INFINITY,
				_ => {
					validate_number(&text)?;
					let value: f32 = text.parse()?;
					if !value.is_finite() {
						return Err("float value out of range".into());
					}
					value
				},
			};
			Value::F32(number)
		},
		Kind::Double => {
			let text = scalar_text(input)?;
			let number = match text.as_ref() {
				"NaN" if input.starts_with('"') => f64::NAN,
				"Infinity" if input.starts_with('"') => f64::INFINITY,
				"-Infinity" if input.starts_with('"') => f64::NEG_INFINITY,
				_ => {
					validate_number(&text)?;
					let value: f64 = text.parse()?;
					if !value.is_finite() {
						return Err("double value out of range".into());
					}
					value
				},
			};
			Value::F64(number)
		},
		Kind::Enum(descriptor) => {
			if input == "null" && descriptor.full_name() == "google.protobuf.NullValue" {
				Value::EnumNumber(0)
			} else if input.starts_with('"') {
				let name: String = serde_json::from_str(input)?;
				Value::EnumNumber(
					descriptor
						.get_value_by_name(&name)
						.ok_or_else(|| format!("invalid enum value {name:?}"))?
						.number(),
				)
			} else {
				Value::EnumNumber(i32::try_from(signed_integer(input)?)?)
			}
		},
	})
}

// Check the JSON number grammar without converting to a float (u64::MAX is
// representable as protobuf JSON even though it is not exactly an f64).
fn validate_number(input: &str) -> Result<()> {
	let bytes = input.as_bytes();
	let mut index = usize::from(bytes.first() == Some(&b'-'));
	match bytes.get(index) {
		Some(b'0') => index += 1,
		Some(b'1'..=b'9') => {
			index += 1;
			while bytes.get(index).is_some_and(u8::is_ascii_digit) {
				index += 1;
			}
		},
		_ => return Err("invalid protobuf JSON number".into()),
	}
	if bytes.get(index) == Some(&b'.') {
		index += 1;
		let start = index;
		while bytes.get(index).is_some_and(u8::is_ascii_digit) {
			index += 1;
		}
		if index == start {
			return Err("invalid protobuf JSON fraction".into());
		}
	}
	if matches!(bytes.get(index), Some(b'e' | b'E')) {
		index += 1;
		if matches!(bytes.get(index), Some(b'+' | b'-')) {
			index += 1;
		}
		let start = index;
		while bytes.get(index).is_some_and(u8::is_ascii_digit) {
			index += 1;
		}
		if index == start {
			return Err("invalid protobuf JSON exponent".into());
		}
	}
	if index != bytes.len() {
		return Err("invalid protobuf JSON number".into());
	}
	Ok(())
}

fn integer_parts(input: &str) -> Result<(bool, u64)> {
	validate_number(input)?;
	let negative = input.starts_with('-');
	let text = input.strip_prefix('-').unwrap_or(input);
	let (mantissa, exponent) = text.split_once(['e', 'E']).unwrap_or((text, "0"));
	let exponent_negative = exponent.starts_with('-');
	let exponent_digits = exponent.trim_start_matches(['+', '-']);
	let exponent = exponent_digits
		.bytes()
		.fold(0_i64, |total, digit| {
			total
				.saturating_mul(10)
				.saturating_add(i64::from(digit - b'0'))
		})
		.min(1_000_000);
	let exponent = if exponent_negative {
		-exponent
	} else {
		exponent
	};
	let fractional = mantissa
		.split_once('.')
		.map_or(0, |(_, fraction)| fraction.len() as i64);
	let mut digits = mantissa
		.bytes()
		.filter(|byte| *byte != b'.')
		.skip_while(|byte| *byte == b'0')
		.peekable();
	if digits.peek().is_none() {
		return Ok((negative, 0));
	}
	let digit_count = digits.clone().count() as i64;
	let shift = exponent - fractional;
	let significant = digit_count + shift;
	if !(1..=20).contains(&significant) {
		return Err("integer value out of range or non-integral".into());
	}
	let keep = digit_count.min(significant);
	let mut number = 0_u64;
	for (index, digit) in digits.enumerate() {
		if (index as i64) < keep {
			number = number
				.checked_mul(10)
				.and_then(|value| value.checked_add(u64::from(digit - b'0')))
				.ok_or("integer value out of range")?;
		} else if digit != b'0' {
			return Err("non-integral protobuf integer".into());
		}
	}
	for _ in 0..shift.max(0) {
		number = number.checked_mul(10).ok_or("integer value out of range")?;
	}
	Ok((negative, number))
}
fn signed_integer(input: &str) -> Result<i64> {
	let (negative, number) = integer_parts(input)?;
	if negative && number == 1_u64 << 63 {
		Ok(i64::MIN)
	} else {
		let number = i64::try_from(number)?;
		Ok(if negative { -number } else { number })
	}
}
fn unsigned_integer(input: &str) -> Result<u64> {
	let (negative, number) = integer_parts(input)?;
	if negative {
		Err("negative unsigned protobuf integer".into())
	} else {
		Ok(number)
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn integral_exponents_never_pass_through_float() {
		for (text, number) in [
			("1e3", 1000),
			("1200e-2", 12),
			("1.20e2", 120),
			("-9223372036854775808", i64::MIN),
			("9223372036854775807", i64::MAX),
		] {
			assert_eq!(signed_integer(text).unwrap(), number);
		}
		assert_eq!(unsigned_integer("18446744073709551615").unwrap(), u64::MAX);
		for text in ["1.1", "12e-1", "1e99999999", "9223372036854775808", "01", "+1", " 1", "1."] {
			assert!(signed_integer(text).is_err(), "{text}");
		}
	}
}
