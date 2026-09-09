//! Parse and deserialization errors.

use std::fmt::Display;

use serde::de;

use crate::{Str, sf, slopjson::parser::MAX_DEPTH};

/// Failure modes of the final parse ([`parse`](crate::slopjson::parse) /
/// [`from_str`](crate::slopjson::from_str)). Positions are byte offsets into
/// the input.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ParseError {
	/// Input ended (or was empty) before a value started.
	#[error("unexpected end of JSON input")]
	UnexpectedEnd,
	/// Non-whitespace content after a complete top-level value.
	#[error("unexpected trailing characters at position {0}")]
	TrailingCharacters(usize),
	/// Input ended inside an object.
	#[error("unterminated object")]
	UnterminatedObject,
	/// Input ended inside an array.
	#[error("unterminated array")]
	UnterminatedArray,
	/// Input ended inside a string literal.
	#[error("unterminated string")]
	UnterminatedString,
	/// An object member started with something that cannot be a key.
	#[error("expected object key at position {0}")]
	ExpectedKey(usize),
	/// Missing `:` between an object key and its value.
	#[error("expected ':' in object at position {0}")]
	ExpectedColon(usize),
	/// Input ended where an object member's value was required.
	#[error("expected value after ':' at position {0}")]
	ExpectedValue(usize),
	/// Missing separator after an object member.
	#[error("expected ',' or '}}' in object at position {0}")]
	ExpectedCommaOrBrace(usize),
	/// Missing separator after an array element.
	#[error("expected ',' or ']' in array at position {0}")]
	ExpectedCommaOrBracket(usize),
	/// Malformed or non-finite numeric token (`1..2`, `1e999`, bare `-`).
	#[error("invalid number at position {0}")]
	InvalidNumber(usize),
	/// A token no recovery applies to (e.g. `NaN`, `undefined`, a bareword
	/// where none is allowed, or one that would swallow structure).
	#[error("unexpected token at position {0}")]
	UnexpectedToken(usize),
	/// Container nesting exceeded the recursion limit.
	#[error("nesting deeper than {} levels", MAX_DEPTH)]
	DepthExceeded,
	/// Typed-deserialization mismatch surfaced through [`serde::de::Error`]
	/// (e.g. a string where a `u32` field was expected).
	#[error("{0}")]
	Custom(Str),
}

impl de::Error for ParseError {
	fn custom<T: Display>(msg: T) -> Self {
		Self::Custom(sf!("{msg}"))
	}
}
