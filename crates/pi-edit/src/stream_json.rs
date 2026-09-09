//! Tolerant reader for streamed tool-call arguments.
//!
//! The agent loop feeds raw wire fragments (JSON text for function tools, a
//! verbatim payload for custom-format tools). [`ArgStream`] accumulates them
//! and [`ArgStream::snapshot`] projects the buffer onto the fields every
//! edit mode reads, closing unterminated strings/arrays/objects like
//! `parseStreamingJson` (`packages/utils/src/json-parse.ts`) and honoring the
//! `_input` alias for `input` (`modes/controllers/tool-args-reveal.ts`).

/// One element of a `patch` `edits[]` array or a `replace` batch entry.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct EditEntry {
	pub op:          Option<String>,
	pub rename:      Option<String>,
	pub diff:        Option<String>,
	pub old_string:  Option<String>,
	pub new_string:  Option<String>,
	pub replace_all: Option<bool>,
	/// False while the element's closing `}` has not arrived.
	pub closed:      bool,
}

/// Typed projection of the (possibly partial) arguments.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ArgSnapshot {
	pub path:        Option<String>,
	/// `input` (or `_input`) text payload; the whole buffer when `raw_input`.
	pub input:       Option<String>,
	pub old_string:  Option<String>,
	pub new_string:  Option<String>,
	pub replace_all: Option<bool>,
	pub edits:       Vec<EditEntry>,
	/// True when an `edits` key was present (even if still empty).
	pub has_edits:   bool,
	/// True once the buffer parses as complete JSON (every bracket and
	/// string closed) or the stream was finished.
	pub complete:    bool,
}

/// Accumulates raw argument deltas.
#[derive(Debug, Clone, Default)]
pub struct ArgStream {
	buf:       String,
	raw_input: bool,
	finished:  bool,
}

impl ArgStream {
	/// `raw_input` marks a custom-format tool whose payload is not JSON.
	pub const fn new(raw_input: bool) -> Self {
		Self { buf: String::new(), raw_input, finished: false }
	}

	pub fn push(&mut self, delta: &str) {
		self.buf.push_str(delta);
	}

	/// Replace the buffer wholesale (no-delta path: final args as JSON).
	pub fn replace(&mut self, text: &str) {
		self.buf.clear();
		self.buf.push_str(text);
	}

	/// Mark the arguments complete.
	pub const fn finish(&mut self) {
		self.finished = true;
	}

	pub const fn is_finished(&self) -> bool {
		self.finished
	}

	pub fn buffer(&self) -> &str {
		&self.buf
	}

	pub const fn is_raw_input(&self) -> bool {
		self.raw_input
	}

	/// Project the buffer. When `raw_input`, `input` is the verbatim buffer.
	pub fn snapshot(&self) -> ArgSnapshot {
		snapshot_from_text(&self.buf, self.raw_input, self.finished)
	}
}

/// Project a complete or partial argument text (see [`ArgStream::snapshot`]).
/// `finished` forces `complete = true`.
pub fn snapshot_from_text(text: &str, raw_input: bool, finished: bool) -> ArgSnapshot {
	if raw_input {
		return ArgSnapshot {
			input: Some(text.to_owned()),
			complete: finished,
			..ArgSnapshot::default()
		};
	}

	let complete = finished || serde_json::from_str::<serde_json::Value>(text).is_ok();
	let Some(value) = parse_streaming_json(text) else {
		return ArgSnapshot { complete, ..ArgSnapshot::default() };
	};
	let Some(object) = value.as_object() else {
		return ArgSnapshot { complete, ..ArgSnapshot::default() };
	};

	let (lexical_has_edits, edits_start) = find_edits_array(text);
	let closed = edits_start.map_or_else(Vec::new, |start| edit_object_closed_flags(text, start));
	let edits = object
		.get("edits")
		.and_then(serde_json::Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(serde_json::Value::as_object)
		.enumerate()
		.map(|(index, entry)| EditEntry {
			op:          string_field(entry, "op"),
			rename:      string_field(entry, "rename"),
			diff:        string_field(entry, "diff"),
			old_string:  string_field(entry, "old_string"),
			new_string:  string_field(entry, "new_string"),
			replace_all: entry
				.get("replace_all")
				.and_then(serde_json::Value::as_bool),
			closed:      closed.get(index).copied().unwrap_or(false),
		})
		.collect();

	ArgSnapshot {
		path: string_field(object, "path"),
		input: object
			.get("input")
			.or_else(|| object.get("_input"))
			.and_then(serde_json::Value::as_str)
			.map(ToOwned::to_owned),
		old_string: string_field(object, "old_string"),
		new_string: string_field(object, "new_string"),
		replace_all: object
			.get("replace_all")
			.and_then(serde_json::Value::as_bool),
		edits,
		has_edits: lexical_has_edits || object.contains_key("edits"),
		complete,
	}
}

/// Repair a partial JSON document by closing open strings, arrays, and
/// objects and dropping a dangling trailing key/comma, then parse it.
/// Returns `None` when even the repaired text is not valid JSON.
pub fn parse_streaming_json(text: &str) -> Option<serde_json::Value> {
	let text = text.trim_start();
	if text.is_empty() {
		return None;
	}
	if let Ok(value) = serde_json::from_str(text) {
		return Some(value);
	}

	let mut parser = RepairParser::new(text);
	let repaired = parser.value()?;
	serde_json::from_str(&repaired).ok()
}

fn string_field(object: &serde_json::Map<String, serde_json::Value>, key: &str) -> Option<String> {
	object
		.get(key)
		.and_then(serde_json::Value::as_str)
		.map(ToOwned::to_owned)
}

struct RepairParser<'a> {
	source: &'a str,
	bytes:  &'a [u8],
	pos:    usize,
}

struct RepairedString {
	json:     String,
	complete: bool,
}

impl<'a> RepairParser<'a> {
	const fn new(source: &'a str) -> Self {
		Self { source, bytes: source.as_bytes(), pos: 0 }
	}

	fn value(&mut self) -> Option<String> {
		self.whitespace();
		let first = *self.bytes.get(self.pos)?;
		match first {
			b'{' => self.object(),
			b'[' => self.array(),
			b'"' => self.string().map(|string| string.json),
			b'-' | b'0'..=b'9' => self.atom(),
			b't' | b'f' | b'n' => self.atom(),
			_ => None,
		}
	}

	fn object(&mut self) -> Option<String> {
		self.pos += 1;
		let mut output = String::from("{");
		let mut first = true;

		loop {
			self.whitespace();
			match self.bytes.get(self.pos).copied() {
				None => {
					output.push('}');
					return Some(output);
				},
				Some(b'}') => {
					self.pos += 1;
					output.push('}');
					return Some(output);
				},
				Some(b',') => {
					self.pos += 1;
					continue;
				},
				Some(b'"') => {},
				Some(_) => return None,
			}

			let key = self.string()?;
			if !key.complete {
				output.push('}');
				return Some(output);
			}
			self.whitespace();
			if self.bytes.get(self.pos) != Some(&b':') {
				output.push('}');
				return Some(output);
			}
			self.pos += 1;
			self.whitespace();
			let Some(value) = self.value() else {
				output.push('}');
				return Some(output);
			};

			if !first {
				output.push(',');
			}
			first = false;
			output.push_str(&key.json);
			output.push(':');
			output.push_str(&value);

			self.whitespace();
			match self.bytes.get(self.pos).copied() {
				None => {
					output.push('}');
					return Some(output);
				},
				Some(b',') => self.pos += 1,
				Some(b'}') => {
					self.pos += 1;
					output.push('}');
					return Some(output);
				},
				Some(_) => {
					output.push('}');
					return Some(output);
				},
			}
		}
	}

	fn array(&mut self) -> Option<String> {
		self.pos += 1;
		let mut output = String::from("[");
		let mut first = true;

		loop {
			self.whitespace();
			match self.bytes.get(self.pos).copied() {
				None => {
					output.push(']');
					return Some(output);
				},
				Some(b']') => {
					self.pos += 1;
					output.push(']');
					return Some(output);
				},
				Some(b',') => {
					self.pos += 1;
					continue;
				},
				Some(_) => {},
			}

			let Some(value) = self.value() else {
				output.push(']');
				return Some(output);
			};
			if !first {
				output.push(',');
			}
			first = false;
			output.push_str(&value);

			self.whitespace();
			match self.bytes.get(self.pos).copied() {
				None => {
					output.push(']');
					return Some(output);
				},
				Some(b',') => self.pos += 1,
				Some(b']') => {
					self.pos += 1;
					output.push(']');
					return Some(output);
				},
				Some(_) => {
					output.push(']');
					return Some(output);
				},
			}
		}
	}

	fn atom(&mut self) -> Option<String> {
		let start = self.pos;
		while let Some(byte) = self.bytes.get(self.pos).copied() {
			if matches!(byte, b',' | b'}' | b']') || byte.is_ascii_whitespace() {
				break;
			}
			self.pos += 1;
		}
		let token = &self.source[start..self.pos];
		if serde_json::from_str::<serde_json::Value>(token).is_ok() {
			return Some(token.to_owned());
		}

		let integer = token.strip_suffix('.')?;
		if serde_json::from_str::<serde_json::Value>(integer).is_ok() {
			Some(integer.to_owned())
		} else {
			None
		}
	}

	fn string(&mut self) -> Option<RepairedString> {
		debug_assert_eq!(self.bytes.get(self.pos), Some(&b'"'));
		self.pos += 1;
		let mut output = String::from("\"");

		while let Some(byte) = self.bytes.get(self.pos).copied() {
			match byte {
				b'"' => {
					self.pos += 1;
					output.push('"');
					return Some(RepairedString { json: output, complete: true });
				},
				b'\\' => {
					let escape_start = self.pos;
					let Some(escape) = self.bytes.get(self.pos + 1).copied() else {
						self.pos = self.bytes.len();
						output.push('"');
						return Some(RepairedString { json: output, complete: false });
					};
					if escape == b'u' {
						let Some(unit) = self.unicode_unit(self.pos) else {
							self.pos = self.bytes.len();
							output.push('"');
							return Some(RepairedString { json: output, complete: false });
						};
						if (0xd800..=0xdbff).contains(&unit) {
							let low_start = self.pos + 6;
							if low_start >= self.bytes.len()
								|| self.bytes.get(low_start) == Some(&b'\\')
									&& low_start + 2 > self.bytes.len()
								|| self.bytes.get(low_start..low_start + 2) == Some(b"\\u")
									&& low_start + 6 > self.bytes.len()
							{
								self.pos = self.bytes.len();
								output.push('"');
								return Some(RepairedString { json: output, complete: false });
							}
							if self.bytes.get(low_start..low_start + 2) != Some(b"\\u") {
								return None;
							}
							let low = self.unicode_unit(low_start)?;
							if !(0xdc00..=0xdfff).contains(&low) {
								return None;
							}
							output.push_str(&self.source[escape_start..low_start + 6]);
							self.pos = low_start + 6;
							continue;
						}
						if (0xdc00..=0xdfff).contains(&unit) {
							return None;
						}
						output.push_str(&self.source[escape_start..escape_start + 6]);
						self.pos += 6;
						continue;
					}
					if !matches!(escape, b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't') {
						return None;
					}
					output.push('\\');
					output.push(char::from(escape));
					self.pos += 2;
				},
				0x00..=0x1f => {
					push_control_escape(&mut output, byte);
					self.pos += 1;
				},
				_ => {
					let rest = &self.source[self.pos..];
					let ch = rest.chars().next()?;
					output.push(ch);
					self.pos += ch.len_utf8();
				},
			}
		}

		output.push('"');
		Some(RepairedString { json: output, complete: false })
	}

	fn unicode_unit(&self, start: usize) -> Option<u16> {
		let digits = self.bytes.get(start + 2..start + 6)?;
		if !digits.iter().all(u8::is_ascii_hexdigit) {
			return None;
		}
		let digits = std::str::from_utf8(digits).ok()?;
		u16::from_str_radix(digits, 16).ok()
	}

	fn whitespace(&mut self) {
		while self
			.bytes
			.get(self.pos)
			.is_some_and(u8::is_ascii_whitespace)
		{
			self.pos += 1;
		}
	}
}

fn push_control_escape(output: &mut String, byte: u8) {
	match byte {
		b'\x08' => output.push_str("\\b"),
		b'\t' => output.push_str("\\t"),
		b'\n' => output.push_str("\\n"),
		b'\x0c' => output.push_str("\\f"),
		b'\r' => output.push_str("\\r"),
		_ => {
			const HEX: &[u8; 16] = b"0123456789abcdef";
			output.push_str("\\u00");
			output.push(char::from(HEX[usize::from(byte >> 4)]));
			output.push(char::from(HEX[usize::from(byte & 0x0f)]));
		},
	}
}

fn find_edits_array(text: &str) -> (bool, Option<usize>) {
	let bytes = text.as_bytes();
	let mut pos = 0;
	let mut object_depth = 0_u32;
	let mut array_depth = 0_u32;

	while pos < bytes.len() {
		match bytes[pos] {
			b'"' => {
				let start = pos;
				let Some(end) = scan_json_string_end(bytes, pos) else {
					break;
				};
				pos = end;
				if object_depth != 1 || array_depth != 0 {
					continue;
				}
				let Ok(key) = serde_json::from_str::<String>(&text[start..end]) else {
					continue;
				};
				let mut after = skip_ascii_whitespace(bytes, end);
				if key != "edits" || bytes.get(after) != Some(&b':') {
					continue;
				}
				after = skip_ascii_whitespace(bytes, after + 1);
				return (true, (bytes.get(after) == Some(&b'[')).then_some(after));
			},
			b'{' => {
				object_depth += 1;
				pos += 1;
			},
			b'}' => {
				object_depth = object_depth.saturating_sub(1);
				pos += 1;
			},
			b'[' => {
				array_depth += 1;
				pos += 1;
			},
			b']' => {
				array_depth = array_depth.saturating_sub(1);
				pos += 1;
			},
			_ => pos += 1,
		}
	}

	(false, None)
}

fn edit_object_closed_flags(text: &str, list_start: usize) -> Vec<bool> {
	let bytes = text.as_bytes();
	let mut flags = Vec::new();
	let mut pos = list_start + 1;

	while pos < bytes.len() {
		pos = skip_ascii_whitespace(bytes, pos);
		if matches!(bytes.get(pos), Some(b',')) {
			pos += 1;
			continue;
		}
		if matches!(bytes.get(pos), Some(b']')) {
			break;
		}
		if bytes.get(pos) != Some(&b'{') {
			pos += 1;
			continue;
		}

		let mut object_depth = 1_u32;
		let mut array_depth = 0_u32;
		pos += 1;
		let mut is_closed = false;
		while pos < bytes.len() {
			match bytes[pos] {
				b'"' => {
					let Some(end) = scan_json_string_end(bytes, pos) else {
						pos = bytes.len();
						break;
					};
					pos = end;
				},
				b'{' => {
					object_depth += 1;
					pos += 1;
				},
				b'}' => {
					object_depth -= 1;
					pos += 1;
					if object_depth == 0 {
						is_closed = true;
						break;
					}
				},
				b'[' => {
					array_depth += 1;
					pos += 1;
				},
				b']' => {
					array_depth = array_depth.saturating_sub(1);
					pos += 1;
				},
				_ => pos += 1,
			}
		}
		let _ = array_depth;
		flags.push(is_closed);
		if !is_closed {
			break;
		}
	}

	flags
}

fn scan_json_string_end(bytes: &[u8], start: usize) -> Option<usize> {
	let mut pos = start + 1;
	let mut escaped = false;
	while let Some(byte) = bytes.get(pos).copied() {
		if escaped {
			escaped = false;
		} else if byte == b'\\' {
			escaped = true;
		} else if byte == b'"' {
			return Some(pos + 1);
		}
		pos += 1;
	}
	None
}

fn skip_ascii_whitespace(bytes: &[u8], mut pos: usize) -> usize {
	while bytes.get(pos).is_some_and(u8::is_ascii_whitespace) {
		pos += 1;
	}
	pos
}

#[cfg(test)]
mod tests {
	use serde_json::json;

	use super::{ArgStream, parse_streaming_json, snapshot_from_text};

	#[test]
	fn repairs_partial_containers_and_dangling_members() {
		assert_eq!(parse_streaming_json("  "), None);
		assert_eq!(parse_streaming_json(r#"{"a":1,"#), Some(json!({ "a": 1 })));
		assert_eq!(parse_streaming_json(r#"{"a":1,"dangling"#), Some(json!({ "a": 1 })));
		assert_eq!(parse_streaming_json(r#"{"a":"#), Some(json!({})));
		assert_eq!(
			parse_streaming_json(r#"{"items":[{"a":1},"#),
			Some(json!({ "items": [{ "a": 1 }] }))
		);
		assert_eq!(parse_streaming_json(r#"{"number":1."#), Some(json!({ "number": 1 })));
		assert_eq!(parse_streaming_json(r#"{"number":1e"#), Some(json!({})));
	}

	#[test]
	fn decodes_growing_input_prefixes() {
		assert_eq!(
			snapshot_from_text(r#"{"input":"one"#, false, false)
				.input
				.as_deref(),
			Some("one")
		);
		assert_eq!(
			snapshot_from_text(r#"{"input":"one\n two\t\"quote\"\\"#, false, false)
				.input
				.as_deref(),
			Some("one\n two\t\"quote\"\\")
		);
		assert_eq!(
			snapshot_from_text("{\"input\":\"one\\", false, false)
				.input
				.as_deref(),
			Some("one")
		);
		assert_eq!(
			snapshot_from_text(r#"{"input":"one\u263"#, false, false)
				.input
				.as_deref(),
			Some("one")
		);
		assert_eq!(
			snapshot_from_text(r#"{"input":"face \uD83D\uDE00"#, false, false)
				.input
				.as_deref(),
			Some("face 😀")
		);
		assert_eq!(
			snapshot_from_text(r#"{"input":"face \uD83D"#, false, false)
				.input
				.as_deref(),
			Some("face ")
		);
	}

	#[test]
	fn input_alias_and_precedence_match_wire_contract() {
		assert_eq!(
			snapshot_from_text(r#"{"_input":"alias"}"#, false, false)
				.input
				.as_deref(),
			Some("alias")
		);
		assert_eq!(
			snapshot_from_text(r#"{"_input":"alias","input":"primary"}"#, false, false)
				.input
				.as_deref(),
			Some("primary")
		);
	}

	#[test]
	fn raw_input_is_verbatim() {
		let snapshot = snapshot_from_text("  <SM:EDIT>\n", true, false);
		assert_eq!(snapshot.input.as_deref(), Some("  <SM:EDIT>\n"));
		assert!(!snapshot.complete);
		assert!(snapshot_from_text("", true, true).complete);
	}

	#[test]
	fn complete_tracks_strict_json_or_finished() {
		assert!(!snapshot_from_text(r#"{"path":"a""#, false, false).complete);
		assert!(snapshot_from_text(r#"{"path":"a"}"#, false, false).complete);
		assert!(snapshot_from_text(r#"{"path":"a""#, false, true).complete);
	}

	#[test]
	fn marks_closed_edit_objects_from_original_text() {
		let closed = snapshot_from_text(r#"{"edits":[{"path":"a"},{"path":"b"}]}"#, false, false);
		assert_eq!(closed.edits.len(), 2);
		assert!(closed.edits.iter().all(|entry| entry.closed));

		let partial = snapshot_from_text(
			r#"{"edits":[{"op":"update","diff":"a"},{"op":"create","diff":"b""#,
			false,
			false,
		);
		assert_eq!(partial.edits.len(), 2);
		assert!(partial.edits[0].closed);
		assert!(!partial.edits[1].closed);

		let partial_key = snapshot_from_text(r#"{"edits":[{"op":"update"},{"op""#, false, false);
		assert_eq!(partial_key.edits.len(), 2);
		assert!(partial_key.edits[0].closed);
		assert!(!partial_key.edits[1].closed);

		let empty = snapshot_from_text(r#"{"edits":["#, false, false);
		assert!(empty.has_edits);
		assert!(empty.edits.is_empty());
	}

	#[test]
	fn nested_objects_do_not_close_an_edit_early() {
		let partial = snapshot_from_text(
			r#"{"edits":[{"op":"update","extra":{"nested":{"brace":"}"}},"diff":"x""#,
			false,
			false,
		);
		assert_eq!(partial.edits.len(), 1);
		assert!(!partial.edits[0].closed);

		let closed = snapshot_from_text(
			r#"{"edits":[{"op":"update","extra":{"nested":{"brace":"}"}},"diff":"x"}]}"#,
			false,
			false,
		);
		assert_eq!(closed.edits.len(), 1);
		assert!(closed.edits[0].closed);
	}

	#[test]
	fn arg_stream_accumulates_and_finishes() {
		let mut stream = ArgStream::new(false);
		stream.push(r#"{"input":"a"#);
		assert_eq!(stream.snapshot().input.as_deref(), Some("a"));
		assert!(!stream.snapshot().complete);
		stream.push(r#"\nb"}"#);
		assert_eq!(stream.snapshot().input.as_deref(), Some("a\nb"));
		assert!(stream.snapshot().complete);
		stream.finish();
		assert!(stream.is_finished());
	}
}
