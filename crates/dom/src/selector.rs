use core::str::FromStr;

use omp_core::Str;
use smallvec::SmallVec;
use thiserror::Error;

use crate::{Dom, Handle, PropKey, Tag, Value};

/// Selector parse failure.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum SelectorError {
	/// The selector is empty.
	#[error("selector is empty")]
	Empty,
	/// A token starts with an unexpected byte.
	#[error("unexpected selector syntax at byte {offset}")]
	Unexpected {
		/// Byte offset in the selector.
		offset: usize,
	},
	/// A property predicate is not terminated.
	#[error("unterminated selector predicate at byte {offset}")]
	UnterminatedPredicate {
		/// Byte offset of the opening bracket.
		offset: usize,
	},
	/// A predicate has no comparison value.
	#[error("selector predicate has no value at byte {offset}")]
	MissingValue {
		/// Byte offset at which a value was required.
		offset: usize,
	},
}

#[derive(Clone, Copy)]
enum PredOp {
	Eq,
	Ne,
}

struct Predicate {
	key:   PropKey,
	op:    PredOp,
	value: Value,
}

struct Compound {
	tag:        Option<Tag>,
	predicates: SmallVec<Predicate, 2>,
}

pub fn select(dom: &Dom, source: &str) -> Result<Vec<Handle>, SelectorError> {
	let compounds = parse(source)?;
	Ok(dom
		.handles()
		.filter(|&handle| matches_chain(dom, handle, &compounds))
		.collect())
}

fn matches_chain(dom: &Dom, handle: Handle, compounds: &[Compound]) -> bool {
	let Some(subject) = compounds.last() else {
		return false;
	};
	if !matches_compound(dom, handle, subject) {
		return false;
	}
	let mut cursor = handle;
	for compound in compounds[..compounds.len() - 1].iter().rev() {
		let mut ancestor = dom.parent(cursor);
		let found = loop {
			match ancestor {
				Some(candidate) if matches_compound(dom, candidate, compound) => break Some(candidate),
				Some(candidate) => ancestor = dom.parent(candidate),
				None => break None,
			}
		};
		let Some(found) = found else { return false };
		cursor = found;
	}
	true
}

fn matches_compound(dom: &Dom, handle: Handle, compound: &Compound) -> bool {
	let Some(node) = dom.get(handle) else {
		return false;
	};
	if compound.tag.as_ref().is_some_and(|tag| tag != &node.tag) {
		return false;
	}
	compound.predicates.iter().all(|predicate| {
		let current = node.prop(&predicate.key);
		match predicate.op {
			PredOp::Eq => current == Some(&predicate.value),
			PredOp::Ne => current != Some(&predicate.value),
		}
	})
}

fn parse(source: &str) -> Result<Vec<Compound>, SelectorError> {
	let bytes = source.as_bytes();
	let mut offset = 0;
	let mut compounds = Vec::new();
	while offset < bytes.len() {
		while bytes.get(offset).is_some_and(u8::is_ascii_whitespace) {
			offset += 1;
		}
		if offset == bytes.len() {
			break;
		}
		let start = offset;
		let tag = if bytes[offset] == b'[' {
			None
		} else {
			let name_start = offset;
			while bytes.get(offset).is_some_and(is_ident) {
				offset += 1;
			}
			if offset == name_start {
				return Err(SelectorError::Unexpected { offset });
			}
			Some(Tag::from_str(&source[name_start..offset]).expect("tag parsing is infallible"))
		};
		let mut predicates = SmallVec::new();
		while bytes.get(offset) == Some(&b'[') {
			let open = offset;
			offset += 1;
			let key_start = offset;
			while bytes.get(offset).is_some_and(is_ident) {
				offset += 1;
			}
			if offset == key_start {
				return Err(SelectorError::Unexpected { offset });
			}
			let key =
				PropKey::from_str(&source[key_start..offset]).expect("property parsing is infallible");
			let op = if bytes.get(offset..offset + 2) == Some(b"!=") {
				offset += 2;
				PredOp::Ne
			} else if bytes.get(offset) == Some(&b'=') {
				offset += 1;
				PredOp::Eq
			} else {
				return Err(SelectorError::Unexpected { offset });
			};
			let value_start = offset;
			let raw = if matches!(bytes.get(offset), Some(b'\'' | b'"')) {
				let quote = bytes[offset];
				offset += 1;
				let content_start = offset;
				while bytes.get(offset).is_some_and(|byte| *byte != quote) {
					offset += 1;
				}
				if bytes.get(offset) != Some(&quote) {
					return Err(SelectorError::UnterminatedPredicate { offset: open });
				}
				let raw = &source[content_start..offset];
				offset += 1;
				raw
			} else {
				while bytes.get(offset).is_some_and(|byte| *byte != b']') {
					offset += 1;
				}
				source[value_start..offset].trim()
			};
			if raw.is_empty() {
				return Err(SelectorError::MissingValue { offset: value_start });
			}
			if bytes.get(offset) != Some(&b']') {
				return Err(SelectorError::UnterminatedPredicate { offset: open });
			}
			offset += 1;
			predicates.push(Predicate { key, op, value: parse_value(raw) });
		}
		if offset == start {
			return Err(SelectorError::Unexpected { offset });
		}
		if bytes
			.get(offset)
			.is_some_and(|byte| !byte.is_ascii_whitespace())
		{
			return Err(SelectorError::Unexpected { offset });
		}
		compounds.push(Compound { tag, predicates });
	}
	if compounds.is_empty() {
		Err(SelectorError::Empty)
	} else {
		Ok(compounds)
	}
}

fn parse_value(raw: &str) -> Value {
	match raw {
		"null" => Value::Null,
		"true" => Value::Bool(true),
		"false" => Value::Bool(false),
		_ => raw
			.parse::<i64>()
			.map(Value::Int)
			.or_else(|_| raw.parse::<f64>().map(Value::Float))
			.unwrap_or_else(|_| Value::Str(Str::new(raw))),
	}
}

const fn is_ident(byte: &u8) -> bool {
	byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
}
