//! Self-contained JSON for imperfect and incrementally produced documents.
//!
//! LLMs leak a characteristic family of malformations into JSON arguments:
//! single-quoted strings, unquoted keys, Python literals, trailing commas,
//! comments, raw control characters, invalid escapes, unquoted bareword
//! values, and truncated streaming buffers. This module is a complete JSON
//! implementation — [`Value`] / [`Number`] / [`Object`], the [`json!`]
//! macro, `Display` serialization, and a one-pass [`serde::Deserializer`]
//! over the tolerant grammar:
//!
//! - [`from_str`] — deserialize any `T: Deserialize` straight off the lexer;
//!   [`parse`] is `from_str::<Value>`. Strict JSON parses unchanged; truncated
//!   values, trailing garbage, and non-finite numbers still fail, so incomplete
//!   documents are not silently accepted.
//! - [`parse_streaming`] — mid-stream parse: never fails, auto-closes truncated
//!   structure, and rolls incomplete atoms back to the last valid prefix.
//! - [`IncomingDoc`] — an exclusive pull cursor over a growing document:
//!   strings, arrays, and keyed object values become available incrementally;
//!   unpulled object members are never validated or materialized.
//! - [`classify_json_prefix`] — strict RFC 8259 prefix classification for
//!   disambiguating streaming deltas; deliberately unforgiving because repair
//!   would mask exactly the corruption signals the caller needs.
//! - [`repair_json`] — string-level escape/control-char repair for callers that
//!   need strict-JSON text rather than a parsed value.
//!
//! # Example
//!
//! ```
//! use omp_core::slopjson::{from_str, json, parse};
//!
//! #[derive(Debug, PartialEq, serde::Deserialize)]
//! struct Args {
//! 	path: String,
//! 	strict: bool,
//! }
//!
//! // Typed, one-pass, over slop: single quotes, Python literal, trailing comma.
//! let args: Args = from_str("{path: 'a.ts', strict: True,}").unwrap();
//! assert_eq!(args, Args { path: "a.ts".into(), strict: true });
//!
//! // Or as a tree.
//! let value = parse("{'ok': True, // python + comments\n}").unwrap();
//! assert_eq!(value, json!({ "ok": true }));
//! assert_eq!(value.to_string(), r#"{"ok":true}"#);
//! ```

mod classify;
mod de;
mod error;
mod incoming;
mod macros;
mod parser;
mod raw;
mod repair;
mod streaming;
mod value;

pub use classify::{JsonPrefixState, classify_json_prefix};
pub use de::{Deserializer, from_str, parse};
pub use error::ParseError;
pub use incoming::{
	FeedClosed, IncomingArray, IncomingCursor, IncomingDoc, IncomingError, IncomingFeed,
	IncomingJson, IncomingObject, IncomingString, PullIssue, PullIssueKind, PullMode,
	PullPathSegment, Pulled, PulledKind, PulledValueKind, RepairGuard,
};
pub use parser::{Repair, RepairKind, RepairLog, RepairPathSegment};
pub use raw::RawValue;
pub use repair::repair_json;
pub use streaming::parse_streaming;
pub use value::{Number, Object, ObjectIter, ObjectIterMut, Value};

pub use crate::{Str, json};
#[doc(hidden)]
pub use crate::{json_expect_expr_comma, json_internal, json_unexpected};

/// JSON insignificant whitespace (RFC 8259 §2).
pub(crate) const fn is_whitespace(b: u8) -> bool {
	matches!(b, b' ' | b'\t' | b'\n' | b'\r')
}

/// Chars that may follow `\` in a strict-JSON string escape.
pub(crate) const fn is_valid_escape(b: u8) -> bool {
	matches!(b, b'"' | b'\\' | b'/' | b'b' | b'f' | b'n' | b'r' | b't' | b'u')
}
pub(crate) fn hex4(s: &[u8], pos: usize) -> Option<u32> {
	if pos + 4 > s.len() {
		return None;
	}
	let mut value = 0u32;
	for &b in &s[pos..pos + 4] {
		let digit = (b as char).to_digit(16)?;
		value = value << 4 | digit;
	}
	Some(value)
}
