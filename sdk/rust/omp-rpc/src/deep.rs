//! JSON nested deeper than `serde_json` reads.
//!
//! `serde_json` parses at most 128 levels, and decoding a [`Value`] into
//! another and dropping one both recurse once per level, which overflows the
//! stack long before the tree of a long session ends: `get_tree` nests each
//! entry two levels under its parent. [`parse`] builds a value on a stack of
//! its own, [`drop_deep`] drops one the same way, [`DeepJson`] holds a decoded
//! value that drops with that loop, and [`Detached`] moves a parsed value into
//! a result field instead of rebuilding it.

use std::{
	fmt,
	ops::{Deref, DerefMut},
};

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use serde_json::{Map, Value};

use crate::wire::{Command, GetTreeCommand, RpcResponse};

/// `serde_json::from_slice::<Value>(text)`, also for a `get_tree` answer that
/// nests deeper than it reads, but only in its `data.tree`: that answer's
/// result takes its `tree` into a [`DeepJson`] without recursion, while
/// decoding any other value copies it by recursion, so other text that nests
/// that deep fails as `serde_json` fails it, in a member that a later duplicate
/// replaces too. Scalars and member names are still read by `serde_json`.
pub(crate) fn parse(text: &[u8]) -> Result<Value, serde_json::Error> {
	let error = match serde_json::from_slice(text) {
		Ok(value) => return Ok(value),
		Err(error) => error,
	};
	// Text it refuses for another reason, or for depth outside `data.tree`,
	// fails the deep parse too.
	let Ok(value) = parse_deep(text) else {
		return Err(error);
	};
	if is_get_tree_answer(&value) {
		Ok(value)
	} else {
		drop_deep(value);
		Err(error)
	}
}

fn is_get_tree_answer(value: &Value) -> bool {
	value.get("type").and_then(Value::as_str) == Some("response")
		&& value.get("command").and_then(Value::as_str) == Some(GetTreeCommand::NAME)
}

/// Drops with [`drop_deep`] the `data` of `response` when it nests deeper than
/// `serde_json` reads, which only a `get_tree` answer's can ([`parse`]): for
/// every path on which that data would otherwise be decoded or dropped by
/// recursion, all but the successful answer to a `get_tree` call.
pub(crate) fn drop_deep_tree_data(response: &mut RpcResponse) {
	if response.command == GetTreeCommand::NAME
		&& let Some(data) = response
			.data
			.take_if(|data| nests_deeper_than(data, SERDE_JSON_MAX_DEPTH))
	{
		drop_deep(data);
	}
}

/// Drops `value` without recursing into it.
///
/// Dropping a [`Value`] the ordinary way recurses once per level of nesting,
/// so a value nested tens of thousands of levels deep overflows the thread's
/// stack and aborts the process. `get_tree` nests each session entry two
/// levels under its parent: give each root of a long session's tree here
/// (`drop_deep(Value::Object(root))`), or each node you take apart, instead of
/// letting the tree go out of scope.
pub fn drop_deep(value: Value) {
	let mut pending = vec![value];
	while let Some(value) = pending.pop() {
		match value {
			Value::Array(items) => pending.extend(items),
			Value::Object(members) => pending.extend(members.into_iter().map(|(_, member)| member)),
			_ => {},
		}
	}
}

/// How many levels of arrays and objects `serde_json` reads and decodes at
/// most.
pub(crate) const SERDE_JSON_MAX_DEPTH: usize = 128;

/// Whether `value` nests more than `levels` levels of arrays and objects.
pub(crate) fn nests_deeper_than(value: &Value, levels: usize) -> bool {
	let mut pending = vec![(value, 1)];
	while let Some((value, depth)) = pending.pop() {
		match value {
			Value::Array(_) | Value::Object(_) if depth > levels => return true,
			Value::Array(items) => pending.extend(items.iter().map(|item| (item, depth + 1))),
			Value::Object(members) => {
				pending.extend(members.values().map(|member| (member, depth + 1)));
			},
			_ => {},
		}
	}
	false
}

/// A raw JSON shape a [`DeepJson`] holds: a [`Value`], a `Map<String, Value>`,
/// or a `Vec` or `Option` of one.
pub trait DeepJsonValue: Default {
	/// `self` as one JSON value, which [`drop_deep`] takes apart.
	fn into_value(self) -> Value;
}

impl DeepJsonValue for Value {
	fn into_value(self) -> Value {
		self
	}
}

impl DeepJsonValue for Map<String, Value> {
	fn into_value(self) -> Value {
		Value::Object(self)
	}
}

impl<T: DeepJsonValue> DeepJsonValue for Vec<T> {
	fn into_value(self) -> Value {
		Value::Array(self.into_iter().map(T::into_value).collect())
	}
}

impl<T: DeepJsonValue> DeepJsonValue for Option<T> {
	fn into_value(self) -> Value {
		self.map_or(Value::Null, T::into_value)
	}
}

/// JSON that may nest deeper than a thread's stack can drop by recursion, as
/// the `get_tree` answer of a long session does (`SessionTree::tree`). It
/// reads as the `T` it derefs to, serializes and deserializes as `T`, and
/// drops its value with [`drop_deep`]'s loop. [`into_inner`](Self::into_inner)
/// takes the value out; give that to [`drop_deep`] when done, or take it
/// apart. `Debug`, `Clone`, `PartialEq` and `Serialize` work on the value as
/// `T`'s do, and recurse as they do.
#[derive(Clone, PartialEq)]
pub struct DeepJson<T: DeepJsonValue>(T);

impl<T: DeepJsonValue> DeepJson<T> {
	/// Holds `value`.
	pub fn new(value: T) -> Self {
		Self(value)
	}

	/// The value, which drops by recursion unless given to [`drop_deep`].
	pub fn into_inner(mut self) -> T {
		std::mem::take(&mut self.0)
	}
}

impl<T: DeepJsonValue> Deref for DeepJson<T> {
	type Target = T;

	fn deref(&self) -> &T {
		&self.0
	}
}

impl<T: DeepJsonValue> DerefMut for DeepJson<T> {
	fn deref_mut(&mut self) -> &mut T {
		&mut self.0
	}
}

impl<T: DeepJsonValue> Drop for DeepJson<T> {
	fn drop(&mut self) {
		drop_deep(std::mem::take(&mut self.0).into_value());
	}
}

impl<T: DeepJsonValue + fmt::Debug> fmt::Debug for DeepJson<T> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		fmt::Debug::fmt(&self.0, formatter)
	}
}

impl<T: DeepJsonValue + Serialize> Serialize for DeepJson<T> {
	fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		self.0.serialize(serializer)
	}
}

impl<'de, T: DeepJsonValue + Deserialize<'de>> Deserialize<'de> for DeepJson<T> {
	fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		T::deserialize(deserializer).map(Self)
	}
}

/// A container being parsed, with the members read so far.
enum Open {
	Array(Vec<Value>),
	/// The members, and the name of the member being read.
	Object(Map<String, Value>, String),
}

impl Open {
	fn into_value(self) -> Value {
		match self {
			Self::Array(items) => Value::Array(items),
			Self::Object(members, _) => Value::Object(members),
		}
	}
}

/// Parses `text` as `serde_json` does, also where it nests deeper than
/// `serde_json` reads, but only inside the `data.tree` member of the top-level
/// object: a container that opens that deep anywhere else fails the parse, so
/// every value outside `data.tree`, which decoding copies and drops by
/// recursion, nests no deeper than one `serde_json` reads.
fn parse_deep(text: &[u8]) -> Result<Value, serde_json::Error> {
	let mut open = Vec::new();
	let parsed = parse_into(text, &mut open);
	// Left open by an error: their members may nest deep.
	while let Some(container) = open.pop() {
		drop_deep(container.into_value());
	}
	parsed
}

fn parse_into(text: &[u8], open: &mut Vec<Open>) -> Result<Value, serde_json::Error> {
	let mut at = skip_space(text, 0);
	loop {
		// A value starts at `at`: open a container, or read a scalar whole.
		let mut value = match text.get(at) {
			Some(b'[') => {
				check_depth(at, open)?;
				at = skip_space(text, at + 1);
				if text.get(at) != Some(&b']') {
					open.push(Open::Array(Vec::new()));
					continue;
				}
				at += 1;
				Value::Array(Vec::new())
			},
			Some(b'{') => {
				check_depth(at, open)?;
				at = skip_space(text, at + 1);
				if text.get(at) != Some(&b'}') {
					let (key, next) = read_key(text, at)?;
					open.push(Open::Object(Map::new(), key));
					at = next;
					continue;
				}
				at += 1;
				Value::Object(Map::new())
			},
			_ => {
				let end = scalar_end(text, at)?;
				let scalar = serde_json::from_slice(&text[at..end])?;
				at = end;
				scalar
			},
		};
		// `value` is whole: add it to the innermost container, closing each
		// container it completes.
		loop {
			let Some(container) = open.last_mut() else {
				at = skip_space(text, at);
				if at != text.len() {
					drop_deep(value);
					return Err(syntax_error(text, at));
				}
				return Ok(value);
			};
			let closing = match container {
				Open::Array(items) => {
					items.push(value);
					b']'
				},
				Open::Object(members, key) => {
					// A member that a later duplicate replaces may nest deep, in
					// `data.tree`.
					if let Some(replaced) = members.insert(std::mem::take(key), value) {
						drop_deep(replaced);
					}
					b'}'
				},
			};
			at = skip_space(text, at);
			match text.get(at) {
				Some(b',') => {
					at = skip_space(text, at + 1);
					if let Open::Object(_, key) = container {
						let (name, next) = read_key(text, at)?;
						*key = name;
						at = next;
					}
					break;
				},
				Some(&byte) if byte == closing => {
					at += 1;
					let Some(closed) = open.pop() else {
						unreachable!("the innermost container is open")
					};
					value = closed.into_value();
				},
				_ => return Err(syntax_error(text, at)),
			}
		}
	}
}

/// Fails the container that opens at `at`, inside the containers `open`, when
/// it is more than [`SERDE_JSON_MAX_DEPTH`] levels deep anywhere but in the
/// `data.tree` member of the top-level object ([`parse_deep`]).
fn check_depth(at: usize, open: &[Open]) -> Result<(), serde_json::Error> {
	let reading = |container: Option<&Open>, member: &str| matches!(container, Some(Open::Object(_, key)) if key == member);
	if open.len() < SERDE_JSON_MAX_DEPTH
		|| (reading(open.first(), "data") && reading(open.get(1), "tree"))
	{
		return Ok(());
	}
	Err(serde_json::Error::custom(format_args!(
		"nested deeper than {SERDE_JSON_MAX_DEPTH} levels outside `data.tree` at byte {at} of the \
		 JSON text"
	)))
}

fn skip_space(text: &[u8], mut at: usize) -> usize {
	while matches!(text.get(at), Some(b' ' | b'\t' | b'\n' | b'\r')) {
		at += 1;
	}
	at
}

/// End of the string, number or literal at `at`, which `serde_json` then
/// reads (and validates) whole.
fn scalar_end(text: &[u8], at: usize) -> Result<usize, serde_json::Error> {
	if text.get(at) == Some(&b'"') {
		return string_end(text, at);
	}
	let mut end = at;
	while matches!(text.get(end), Some(b'-' | b'+' | b'.' | b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z'))
	{
		end += 1;
	}
	if end == at {
		Err(syntax_error(text, at))
	} else {
		Ok(end)
	}
}

/// End of the string at `at`, past its closing quote.
fn string_end(text: &[u8], at: usize) -> Result<usize, serde_json::Error> {
	let mut end = at + 1;
	loop {
		match text.get(end) {
			Some(b'"') => return Ok(end + 1),
			Some(b'\\') => end += 2,
			Some(_) => end += 1,
			None => return Err(syntax_error(text, end)),
		}
	}
}

/// The member name at `at`, and where the member's value starts, past its
/// colon.
fn read_key(text: &[u8], at: usize) -> Result<(String, usize), serde_json::Error> {
	if text.get(at) != Some(&b'"') {
		return Err(syntax_error(text, at));
	}
	let end = string_end(text, at)?;
	let key = serde_json::from_slice::<String>(&text[at..end])?;
	let colon = skip_space(text, end);
	if text.get(colon) != Some(&b':') {
		return Err(syntax_error(text, colon));
	}
	Ok((key, skip_space(text, colon + 1)))
}

fn syntax_error(text: &[u8], at: usize) -> serde_json::Error {
	match text.get(at) {
		Some(&byte) => serde_json::Error::custom(format_args!(
			"unexpected {:?} at byte {at} of the JSON text",
			char::from(byte)
		)),
		None => serde_json::Error::custom("unexpected end of the JSON text"),
	}
}

/// A result field that keeps JSON as received: a value of its shape is moved
/// into it, never rebuilt.
pub(crate) trait RawJson: Sized {
	/// What the field reads, for a decode error.
	const EXPECTED: &'static str;

	/// Whether `value` has the field's shape, checked as deep as the type goes.
	fn fits(value: &Value) -> bool;

	/// `value`, which [`fits`](Self::fits), as the field's type.
	fn take(value: Value) -> Self;
}

impl RawJson for Value {
	const EXPECTED: &'static str = "a JSON value";

	fn fits(_: &Value) -> bool {
		true
	}

	fn take(value: Value) -> Self {
		value
	}
}

impl RawJson for Map<String, Value> {
	const EXPECTED: &'static str = "an object";

	fn fits(value: &Value) -> bool {
		value.is_object()
	}

	fn take(value: Value) -> Self {
		match value {
			Value::Object(members) => members,
			_ => Map::new(),
		}
	}
}

impl<T: RawJson> RawJson for Vec<T> {
	const EXPECTED: &'static str = "an array";

	fn fits(value: &Value) -> bool {
		value
			.as_array()
			.is_some_and(|items| items.iter().all(T::fits))
	}

	fn take(value: Value) -> Self {
		match value {
			Value::Array(items) => items.into_iter().map(T::take).collect(),
			_ => Vec::new(),
		}
	}
}

impl<T: RawJson> RawJson for Option<T> {
	const EXPECTED: &'static str = T::EXPECTED;

	fn fits(value: &Value) -> bool {
		value.is_null() || T::fits(value)
	}

	fn take(value: Value) -> Self {
		if value.is_null() {
			None
		} else {
			Some(T::take(value))
		}
	}
}

impl<T: DeepJsonValue + RawJson> RawJson for DeepJson<T> {
	const EXPECTED: &'static str = T::EXPECTED;

	fn fits(value: &Value) -> bool {
		T::fits(value)
	}

	fn take(value: Value) -> Self {
		Self(T::take(value))
	}
}

/// Members of a result object that keep JSON as received, swapped out for
/// shallow placeholders while serde decodes the rest and then moved into their
/// fields ([`place`](Self::place)). A member not moved is disposed of on drop.
pub(crate) struct Detached(Vec<Option<Value>>);

impl Detached {
	/// Swaps each present member `(key, placeholder)` of `members` out of
	/// `object`.
	pub(crate) fn new<const N: usize>(object: &mut Value, members: [(&str, Value); N]) -> Self {
		Self(
			members
				.into_iter()
				.map(|(key, placeholder)| {
					let slot = object.as_object_mut()?.get_mut(key)?;
					Some(std::mem::replace(slot, placeholder))
				})
				.collect(),
		)
	}

	/// Moves member `index` (named `key`) into `field`; leaves `field` as
	/// decoded when the member was absent.
	pub(crate) fn place<T: RawJson>(
		&mut self,
		index: usize,
		key: &str,
		field: &mut T,
	) -> Result<(), serde_json::Error> {
		let Some(value) = self.0[index].take() else {
			return Ok(());
		};
		if !T::fits(&value) {
			drop_deep(value);
			return Err(serde_json::Error::custom(format_args!(
				"invalid type for `{key}`: expected {}",
				T::EXPECTED
			)));
		}
		*field = T::take(value);
		Ok(())
	}
}

impl Drop for Detached {
	fn drop(&mut self) {
		self.0.drain(..).flatten().for_each(drop_deep);
	}
}

#[cfg(test)]
mod tests {
	use std::thread;

	use super::*;

	const DEPTH: usize = 200_000;

	fn deep() -> String {
		format!("{}{}", "[".repeat(DEPTH), "]".repeat(DEPTH))
	}

	fn get_tree_answer(data: &str) -> String {
		format!(r#"{{"type":"response","command":"get_tree","success":true,"data":{data}}}"#)
	}

	/// Runs `test` on a thread with the stack the client's reader thread gets
	/// (`thread::spawn`'s default without `RUST_MIN_STACK`, 2 MiB): dropping a
	/// value [`DEPTH`] levels deep by recursion there overflows the stack and
	/// aborts the test process.
	fn on_a_reader_stack(test: impl FnOnce() + Send + 'static) {
		thread::Builder::new()
			.stack_size(2 << 20)
			.spawn(test)
			.unwrap()
			.join()
			.unwrap();
	}

	#[test]
	fn parses_as_serde_json_does() {
		for text in [
			"{}",
			"[]",
			r#"{"a":1,"b":[1,2.5,-3e2,true,false,null],"c":{"d":"x\u00e9\n\"\\"}}"#,
			r#" [ 1 , { "k" : [ ] } ] "#,
			r#""s""#,
			"-0.5E+3",
			r#"{"a":1,"a":2}"#,
			"[[[[]]],{}]",
		] {
			let expected: Value = serde_json::from_str(text).unwrap();
			assert_eq!(parse_deep(text.as_bytes()).unwrap(), expected, "{text}");
		}
		for text in [
			"[1,]",
			r#"{"a"}"#,
			r#"{"a":1,}"#,
			"[1 2]",
			"{a:1}",
			"[",
			"",
			"1 2",
			"[01]",
			"tru",
			r#"{"a":1}x"#,
			"\"\u{1}\"",
		] {
			assert!(parse_deep(text.as_bytes()).is_err(), "{text}");
		}
	}

	#[test]
	fn parses_and_disposes_of_a_tree_of_any_depth() {
		let deep = deep();
		let text = format!(r#"{{"data":{{"tree":{deep}}}}}"#);
		assert!(serde_json::from_str::<Value>(&text).is_err());
		let mut parsed = parse_deep(text.as_bytes()).unwrap();
		let mut value = parsed["data"]["tree"].take();
		let mut levels = 0;
		while let Value::Array(mut items) = value {
			levels += 1;
			value = items.pop().unwrap_or(Value::Null);
		}
		assert_eq!(levels, DEPTH);
		drop_deep(parse_deep(text.as_bytes()).unwrap());
		// An error after a deep member disposes of what it built.
		let broken = format!(r#"{{"data":{{"tree":[{deep},x]}}}}"#);
		assert!(parse_deep(broken.as_bytes()).is_err());
	}

	#[test]
	fn parses_deeper_than_serde_json_only_in_the_tree_of_a_get_tree_answer() {
		let deep = deep();
		drop_deep(parse(get_tree_answer(&format!(r#"{{"tree":{deep}}}"#)).as_bytes()).unwrap());
		for text in [
			deep.clone(),
			format!(r#"{{"type":"big","pad":{deep}}}"#),
			format!(r#"{{"type":"response","command":"get_tree","success":false,"error":{deep}}}"#),
			format!(
				r#"{{"type":"response","command":"get_messages","success":true,"data":{{"tree":{deep}}}}}"#
			),
		] {
			assert!(parse(text.as_bytes()).is_err());
		}
	}

	// If this regresses, a frame with a deep member that a later duplicate
	// replaces drops that member by recursion, which overflows the reader
	// thread's stack and aborts the process.
	#[test]
	fn drops_a_deep_member_a_later_duplicate_replaces_without_recursion() {
		on_a_reader_stack(|| {
			let deep = deep();
			let text = get_tree_answer(&format!(r#"{{"tree":[{{"a":{deep},"a":1}}]}}"#));
			let value = parse(text.as_bytes()).unwrap();
			assert_eq!(value["data"]["tree"][0]["a"], 1);
			drop_deep(value);
		});
	}
}
