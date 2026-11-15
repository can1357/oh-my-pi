use std::io;

use base64::{Engine, engine::general_purpose::STANDARD};
use prost_reflect::{
	DescriptorPool, DynamicMessage, Kind, MapKey, MessageDescriptor, ReflectMessage, Value,
	prost::Message, prost_types::FileDescriptorSet,
};
use serde::{
	Serialize, Serializer,
	ser::{Error as _, SerializeMap, SerializeSeq},
};

use crate::Result;

const DESCRIPTORS: &[u8] = include_bytes!("../../agy-transport/ccpa-descriptors.bin");
const REQUEST: &str = "google.internal.cloud.code.v1internal.GenerateContentRequest";

#[derive(Clone)]
pub struct CcpaSerializer {
	descriptor: MessageDescriptor,
}

impl CcpaSerializer {
	pub fn new() -> Result<Self> {
		let mut files = FileDescriptorSet::decode(DESCRIPTORS)?;
		// The captured legacy MessageSet closure explicitly writes syntax = "".
		// Go treats it as the omitted proto2 default; prost-reflect does not.
		for file in &mut files.file {
			if file.syntax.as_deref() == Some("") {
				file.syntax = None;
			}
		}
		let pool = DescriptorPool::from_file_descriptor_set(files)?;
		let descriptor = pool
			.get_message_by_name(REQUEST)
			.ok_or("request descriptor is not a message")?;
		Ok(Self { descriptor })
	}

	pub fn parse(&self, input: &[u8]) -> Result<DynamicMessage> {
		crate::protojson::parse_message(self.descriptor.clone(), input)
			.map_err(|error| format!("CCPA protobuf JSON: {error}").into())
	}

	pub fn marshal(&self, input: &[u8]) -> Result<Vec<u8>> {
		let message = self.parse(input)?;
		self.encode(&message)
	}

	pub fn encode(&self, message: &DynamicMessage) -> Result<Vec<u8>> {
		let numeric_enums = thinking_level(message).is_some_and(|level| level == 5 || level == 6);
		let mut output = Vec::new();
		let mut serializer = serde_json::Serializer::with_formatter(&mut output, GoFormatter);
		CanonicalMessage { message, numeric_enums }
			.serialize(&mut serializer)
			.map_err(|error| -> crate::Error { format!("CCPA protobuf JSON: {error}").into() })?;
		Ok(output)
	}
}

fn thinking_level(message: &DynamicMessage) -> Option<i32> {
	fn descend(message: &DynamicMessage, path: &[&str]) -> Option<i32> {
		let field = message.descriptor().get_field_by_name(path[0])?;
		if !message.has_field(&field) {
			return None;
		}
		let value = message.get_field(&field);
		if path.len() == 1 {
			return value.as_enum_number();
		}
		descend(value.as_message()?, &path[1..])
	}
	descend(message, &["request", "generation_config", "thinking_config", "thinking_level"])
}

struct CanonicalMessage<'a> {
	message:       &'a DynamicMessage,
	numeric_enums: bool,
}
struct CanonicalValue<'a> {
	value:         &'a Value,
	kind:          &'a Kind,
	numeric_enums: bool,
}
struct CanonicalKey<'a>(&'a MapKey);

impl Serialize for CanonicalMessage<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
		let descriptor = self.message.descriptor();
		match descriptor.full_name() {
			"google.protobuf.Struct" | "google.protobuf.ListValue" => {
				let name = if descriptor.full_name() == "google.protobuf.Struct" {
					"fields"
				} else {
					"values"
				};
				let field = descriptor
					.get_field_by_name(name)
					.ok_or_else(|| S::Error::custom("missing well-known field"))?;
				return CanonicalValue {
					value:         &self.message.get_field(&field),
					kind:          &field.kind(),
					numeric_enums: self.numeric_enums,
				}
				.serialize(serializer);
			},
			"google.protobuf.Value" => {
				let (field, value) = self
					.message
					.fields()
					.next()
					.ok_or_else(|| S::Error::custom("google.protobuf.Value has no value"))?;
				if matches!(value, Value::F64(number) if !number.is_finite()) {
					return Err(S::Error::custom(
						"google.protobuf.Value cannot encode a non-finite number",
					));
				}
				return CanonicalValue {
					value,
					kind: &field.kind(),
					numeric_enums: self.numeric_enums,
				}
				.serialize(serializer);
			},
			// These embedded well-known types have scalar JSON representations.
			"google.protobuf.Timestamp" | "google.protobuf.Duration" => {
				return self.message.serialize(serializer);
			},
			_ => {},
		}
		let mut map = serializer.serialize_map(None)?;
		// Go protojson uses IndexNameFieldOrder, NOT protobuf field numbers.
		// The raw descriptor preserves declaration order, including oneofs.
		for raw in &descriptor.descriptor_proto().field {
			let field = descriptor
				.get_field(raw.number() as u32)
				.ok_or_else(|| S::Error::custom("missing descriptor field"))?;
			let negative_zero = match field.kind() {
				Kind::Float => {
					matches!(&*self.message.get_field(&field), Value::F32(value) if *value == 0.0 && value.is_sign_negative())
				},
				Kind::Double => {
					matches!(&*self.message.get_field(&field), Value::F64(value) if *value == 0.0 && value.is_sign_negative())
				},
				_ => false,
			};
			if !self.message.has_field(&field) && !negative_zero {
				if field.is_required() {
					return Err(S::Error::custom(format!(
						"required field {} not set",
						field.full_name()
					)));
				}
				continue;
			}
			map.serialize_entry(field.json_name(), &CanonicalValue {
				value:         &self.message.get_field(&field),
				kind:          &field.kind(),
				numeric_enums: self.numeric_enums,
			})?;
		}
		let mut extensions: Vec<_> = self.message.extensions().collect();
		extensions.sort_unstable_by(|a, b| a.0.full_name().cmp(b.0.full_name()));
		for (extension, value) in extensions {
			map.serialize_entry(extension.json_name(), &CanonicalValue {
				value,
				kind: &extension.kind(),
				numeric_enums: self.numeric_enums,
			})?;
		}
		map.end()
	}
}

impl Serialize for CanonicalValue<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
		match self.value {
			Value::Bool(value) => serializer.serialize_bool(*value),
			Value::I32(value) => serializer.serialize_i32(*value),
			Value::I64(value) => serializer.collect_str(value),
			Value::U32(value) => serializer.serialize_u32(*value),
			Value::U64(value) => serializer.collect_str(value),
			Value::F32(value) if value.is_finite() => serializer.serialize_f32(*value),
			Value::F64(value) if value.is_finite() => serializer.serialize_f64(*value),
			Value::F32(value) => serializer.serialize_str(if value.is_nan() {
				"NaN"
			} else if value.is_sign_negative() {
				"-Infinity"
			} else {
				"Infinity"
			}),
			Value::F64(value) => serializer.serialize_str(if value.is_nan() {
				"NaN"
			} else if value.is_sign_negative() {
				"-Infinity"
			} else {
				"Infinity"
			}),
			Value::String(value) => serializer.serialize_str(value),
			Value::Bytes(value) => {
				serializer.collect_str(&base64::display::Base64Display::new(value, &STANDARD))
			},
			Value::EnumNumber(number) => {
				let Kind::Enum(descriptor) = self.kind else {
					return Err(S::Error::custom("enum descriptor mismatch"));
				};
				if descriptor.full_name() == "google.protobuf.NullValue" {
					serializer.serialize_none()
				} else if !self.numeric_enums
					&& let Some(value) = descriptor.get_value(*number)
				{
					serializer.serialize_str(value.name())
				} else {
					serializer.serialize_i32(*number)
				}
			},
			Value::Message(message) => {
				CanonicalMessage { message, numeric_enums: self.numeric_enums }.serialize(serializer)
			},
			Value::List(values) => {
				let mut list = serializer.serialize_seq(Some(values.len()))?;
				for value in values {
					list.serialize_element(&CanonicalValue { value, ..*self })?;
				}
				list.end()
			},
			Value::Map(values) => {
				let Kind::Message(descriptor) = self.kind else {
					return Err(S::Error::custom("map descriptor mismatch"));
				};
				let kind = descriptor.map_entry_value_field().kind();
				let mut entries: Vec<_> = values.iter().collect();
				// MapKey's ordering agrees with Go GenericKeyOrder for each
				// protobuf map key type (numeric keys are not lexical strings).
				entries.sort_unstable_by(|a, b| a.0.cmp(b.0));
				let mut map = serializer.serialize_map(Some(entries.len()))?;
				for (key, value) in entries {
					map.serialize_entry(&CanonicalKey(key), &CanonicalValue {
						value,
						kind: &kind,
						numeric_enums: self.numeric_enums,
					})?;
				}
				map.end()
			},
		}
	}
}

impl Serialize for CanonicalKey<'_> {
	fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
		match self.0 {
			MapKey::Bool(v) => serializer.collect_str(v),
			MapKey::I32(v) => serializer.collect_str(v),
			MapKey::I64(v) => serializer.collect_str(v),
			MapKey::U32(v) => serializer.collect_str(v),
			MapKey::U64(v) => serializer.collect_str(v),
			MapKey::String(v) => serializer.serialize_str(v),
		}
	}
}

// serde_json's Ryu defaults choose different exponent thresholds from Go.
// Keep shortest-round-trip digits, but apply protojson's 1e-6 / 1e21 policy,
// strip the redundant .0, and retain '+' on positive exponents.
struct GoFormatter;
impl serde_json::ser::Formatter for GoFormatter {
	fn write_f32<W: io::Write + ?Sized>(&mut self, writer: &mut W, value: f32) -> io::Result<()> {
		let mut buffer = ryu::Buffer::new();
		write_float(
			writer,
			buffer.format_finite(value),
			value != 0.0 && (value.abs() < 1e-6_f32 || value.abs() >= 1e21_f32),
		)
	}

	fn write_f64<W: io::Write + ?Sized>(&mut self, writer: &mut W, value: f64) -> io::Result<()> {
		let mut buffer = ryu::Buffer::new();
		write_float(
			writer,
			buffer.format_finite(value),
			value != 0.0 && (value.abs() < 1e-6 || value.abs() >= 1e21),
		)
	}
}

fn write_float<W: io::Write + ?Sized>(
	writer: &mut W,
	text: &str,
	scientific: bool,
) -> io::Result<()> {
	let text = if let Some(text) = text.strip_prefix('-') {
		writer.write_all(b"-")?;
		text
	} else {
		text
	};
	let (mantissa, exponent) = text
		.split_once('e')
		.map_or((text, 0), |(m, e)| (m, e.parse::<i32>().expect("Ryu exponent")));
	let mut digits = [0_u8; 24];
	let mut count = 0;
	for byte in mantissa.bytes().filter(|byte| *byte != b'.') {
		digits[count] = byte;
		count += 1;
	}
	let point = mantissa.find('.').unwrap_or(mantissa.len()) as i32 + exponent;
	while count > 1 && digits[count - 1] == b'0' {
		count -= 1;
	}
	if scientific {
		writer.write_all(&digits[..1])?;
		if count > 1 {
			writer.write_all(b".")?;
			writer.write_all(&digits[1..count])?;
		}
		write!(writer, "e{:+}", point - 1)
	} else if point <= 0 {
		writer.write_all(b"0.")?;
		for _ in 0..-point {
			writer.write_all(b"0")?;
		}
		writer.write_all(&digits[..count])
	} else {
		let point = point as usize;
		let whole = point.min(count);
		writer.write_all(&digits[..whole])?;
		for _ in whole..point {
			writer.write_all(b"0")?;
		}
		if point < count {
			writer.write_all(b".")?;
			writer.write_all(&digits[point..count])?;
		}
		Ok(())
	}
}

pub fn decode_checkpoint(token: &str) -> Result<Vec<u8>> {
	use base64::{
		alphabet,
		engine::{DecodePaddingMode, GeneralPurpose, GeneralPurposeConfig},
	};
	const PAD: GeneralPurposeConfig =
		GeneralPurposeConfig::new().with_decode_allow_trailing_bits(true);
	const NO_PAD: GeneralPurposeConfig =
		PAD.with_decode_padding_mode(DecodePaddingMode::RequireNone);
	const ENGINES: [GeneralPurpose; 4] = [
		GeneralPurpose::new(&alphabet::STANDARD, PAD),
		GeneralPurpose::new(&alphabet::STANDARD, NO_PAD),
		GeneralPurpose::new(&alphabet::URL_SAFE, PAD),
		GeneralPurpose::new(&alphabet::URL_SAFE, NO_PAD),
	];
	// Go's encoding/base64 ignores CR/LF, but not other whitespace.
	let compact;
	let token = if token.contains(['\r', '\n']) {
		compact = token.replace(['\r', '\n'], "");
		compact.as_str()
	} else {
		token
	};
	for engine in &ENGINES {
		if let Ok(bytes) = engine.decode(token) {
			return Ok(bytes);
		}
	}
	Err("invalid protobuf continuation checkpoint encoding".into())
}

#[cfg(test)]
mod tests {
	use super::*;
	fn marshal(input: &str) -> String {
		String::from_utf8(
			CcpaSerializer::new()
				.unwrap()
				.marshal(input.as_bytes())
				.unwrap(),
		)
		.unwrap()
	}

	#[test]
	fn image_fields_survive_without_reclassification() {
		let body = marshal(
			r#"{"model":"image-model","user_prompt_id":"prompt-1","request":{"service_account":"image-worker@example.invalid","contents":[{"parts":[{"text":"draw a tree"}]}],"generation_config":{"response_modalities":["IMAGE"],"candidate_count":2}}}"#,
		);
		let value: serde_json::Value = serde_json::from_str(&body).unwrap();
		assert!(value.get("requestType").is_none());
		assert_eq!(value["userPromptId"], "prompt-1");
		assert_eq!(value["request"]["serviceAccount"], "image-worker@example.invalid");
		assert_eq!(value["request"]["generationConfig"]["responseModalities"][0], "IMAGE");
		assert_eq!(value["request"]["generationConfig"]["candidateCount"], 2);
	}

	#[test]
	fn native_schema_rejects_unrepresentable_input() {
		let codec = CcpaSerializer::new().unwrap();
		for body in [
			r#"{"request":{"generationConfig":{"maxOutputTokens":2147483648}}}"#,
			r#"{"request":{"contents":[{"parts":[{"text":"\ud800"}]}]}}"#,
			r#"{"request":{"unknownWireField":true}}"#,
			r#"{"requestId":"a","request_id":"b"}"#,
			r#"{"model":"","model":"x"}"#,
			r#"{"request":{"labels":{"x":"a","x":"b"}}}"#,
			"{} {}",
		] {
			assert!(
				codec
					.marshal(body.as_bytes())
					.unwrap_err()
					.to_string()
					.contains("CCPA protobuf JSON"),
				"{body}"
			);
		}
	}

	#[test]
	fn declaration_order_and_map_order_are_not_input_order() {
		assert_eq!(
			marshal(
				r#"{"request_type":"agent","model":"m","request_id":"id","project":"p","request":{"labels":{"z":"last","a":"first"}}}"#
			),
			r#"{"project":"p","requestId":"id","request":{"labels":{"a":"first","z":"last"}},"model":"m","requestType":"agent"}"#
		);
	}

	#[test]
	fn declaration_order_differs_from_wire_number_order() {
		assert_eq!(
			marshal(r#"{"request":{"generationConfig":{"logprobs":2,"responseLogprobs":true}}}"#),
			r#"{"request":{"generationConfig":{"responseLogprobs":true,"logprobs":2}}}"#
		);
	}

	#[test]
	fn quoted_integral_exponents_are_lossless() {
		assert_eq!(
			marshal(r#"{"request":{"generationConfig":{"maxOutputTokens":"21474836470e-1"}}}"#),
			r#"{"request":{"generationConfig":{"maxOutputTokens":2147483647}}}"#
		);
		let codec = CcpaSerializer::new().unwrap();
		assert!(
			codec
				.marshal(br#"{"request":{"generationConfig":{"maxOutputTokens":"2147483648"}}}"#)
				.is_err()
		);
		assert!(
			codec
				.marshal(br#"{"model":null,"model":"duplicate"}"#)
				.is_err()
		);
	}

	#[test]
	fn structured_values_sort_keys_without_html_escaping_or_float_suffixes() {
		assert_eq!(
			marshal(
				r#"{"request":{"generationConfig":{"responseJsonSchema":{"z":1.0,"a":["<>&",null,0.0000001]}}}}"#
			),
			r#"{"request":{"generationConfig":{"responseJsonSchema":{"a":["<>&",null,1e-7],"z":1}}}}"#
		);
		assert!(
			CcpaSerializer::new()
				.unwrap()
				.marshal(br#"{"request":{"generationConfig":{"responseJsonSchema":{"a":1,"a":2}}}}"#)
				.is_err()
		);
	}

	#[test]
	fn numeric_thinking_levels_change_all_enum_fields() {
		let numeric = marshal(
			r#"{"request":{"generationConfig":{"responseModalities":["TEXT"],"thinkingConfig":{"thinkingLevel":5}}}}"#,
		);
		let symbolic = marshal(
			r#"{"request":{"generationConfig":{"responseModalities":["TEXT"],"thinkingConfig":{"thinkingLevel":1}}}}"#,
		);
		let number: serde_json::Value = serde_json::from_str(&numeric).unwrap();
		let name: serde_json::Value = serde_json::from_str(&symbolic).unwrap();
		assert!(number["request"]["generationConfig"]["responseModalities"][0].is_number());
		assert_eq!(name["request"]["generationConfig"]["responseModalities"][0], "TEXT");
	}

	#[test]
	fn protobuf_float_format_matches_go_thresholds() {
		for (value, expected) in [
			(1.0, "1"),
			(-0.0, "-0"),
			(1e-6, "0.000001"),
			(1e-7, "1e-7"),
			(1e20, "100000000000000000000"),
			(1e21, "1e+21"),
			(123.25, "123.25"),
		] {
			let mut bytes = Vec::new();
			value
				.serialize(&mut serde_json::Serializer::with_formatter(&mut bytes, GoFormatter))
				.unwrap();
			assert_eq!(bytes, expected.as_bytes());
		}
	}

	#[test]
	fn checkpoint_alphabets_and_padding() {
		for text in ["+/8=", "+/8", "-_8=", "-_8", "+/\r\n8=", "+/9="] {
			assert_eq!(decode_checkpoint(text).unwrap(), [251, 255]);
		}
		for text in ["!", "a", "ab c", "===="] {
			assert!(decode_checkpoint(text).is_err());
		}
	}
}
