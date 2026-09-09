//! Cold, span-carrying template errors with underlined source snippets.

use core::error;

use omp_core::{IntoStr, Str, StrMut};
use thiserror::Error;

/// Byte span of a token or expression inside a template source.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Span {
	/// Byte offset of the span start.
	pub start: u32,
	/// Byte length of the span (clamped to its line when underlined).
	pub len:   u16,
}

impl Span {
	pub(crate) fn new(start: usize, len: usize) -> Self {
		Self { start: start as u32, len: len.min(usize::from(u16::MAX)) as u16 }
	}
}

/// Any failure compiling or rendering a template.
///
/// Span-carrying variants embed an `upon`-style source snippet with a
/// `^~~~` underline, built once at error construction — errors are cold.
#[derive(Debug, Error)]
pub enum Error {
	/// The template source failed to parse.
	#[error("{kind} in `{template}` at {line}:{col}\n{snippet}")]
	Syntax {
		/// Template name supplied at compile time.
		template: Str,
		/// What went wrong.
		kind:     SyntaxErrorKind,
		/// 1-based line of the offending token.
		line:     u32,
		/// 1-based column of the offending token.
		col:      u32,
		/// Underlined source line.
		snippet:  Str,
	},
	/// A missing prop reached a strict sink (emission, iteration, ordering,
	/// or a filter other than `default`).
	#[error("undefined value `{path}` in `{template}` at {line}:{col}\n{snippet}")]
	UndefinedKey {
		/// Template name supplied at compile time.
		template: Str,
		/// Dotted access path that failed to resolve.
		path:     Str,
		/// 1-based line of the failing access.
		line:     u32,
		/// 1-based column of the failing access.
		col:      u32,
		/// Underlined source line.
		snippet:  Str,
	},
	/// An operation was applied to a value of the wrong shape.
	#[error("{kind} in `{template}` at {line}:{col}\n{snippet}")]
	Type {
		/// Template name supplied at compile time.
		template: Str,
		/// What went wrong.
		kind:     TypeErrorKind,
		/// 1-based line of the offending expression.
		line:     u32,
		/// 1-based column of the offending expression.
		col:      u32,
		/// Underlined source line.
		snippet:  Str,
	},
	/// A registered filter, function, or block helper failed.
	#[error("helper `{name}` failed")]
	Helper {
		/// Registered helper name.
		name:   Str,
		/// Typed failure raised by the helper.
		#[source]
		source: Box<dyn error::Error + Send + Sync>,
	},
}

impl Error {
	pub(crate) fn syntax(template: &Str, source: &str, span: Span, kind: SyntaxErrorKind) -> Self {
		let (line, col) = locate(source, span.start as usize);
		Self::Syntax { template: template.clone(), kind, line, col, snippet: snippet(source, span) }
	}

	pub(crate) fn undefined(template: &Str, source: &str, span: Span, path: Str) -> Self {
		let (line, col) = locate(source, span.start as usize);
		Self::UndefinedKey {
			template: template.clone(),
			path,
			line,
			col,
			snippet: snippet(source, span),
		}
	}

	pub(crate) fn type_error(template: &Str, source: &str, span: Span, kind: TypeErrorKind) -> Self {
		let (line, col) = locate(source, span.start as usize);
		Self::Type { template: template.clone(), kind, line, col, snippet: snippet(source, span) }
	}

	/// Wraps a typed failure raised by a registered filter, function, or
	/// block helper.
	pub fn helper(name: impl IntoStr, source: impl error::Error + Send + Sync + 'static) -> Self {
		Self::Helper { name: name.into_str(), source: Box::new(source) }
	}
}

/// Parse-time failure classification for [`Error::Syntax`].
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum SyntaxErrorKind {
	/// A `{{`, `{%`, or `{#` tag never closes.
	#[error("unclosed tag")]
	UnclosedTag,
	/// A `{% raw %}` block has no matching `{% endraw %}`.
	#[error("missing {{% endraw %}}")]
	UnclosedRaw,
	/// A string literal never closes.
	#[error("unterminated string literal")]
	UnterminatedString,
	/// A numeric literal does not fit the value model.
	#[error("invalid number literal")]
	InvalidNumber,
	/// A token that cannot appear here.
	#[error("unexpected token")]
	UnexpectedToken,
	/// The tag ended where more input was required.
	#[error("unexpected end of tag")]
	UnexpectedEnd,
	/// An identifier was required.
	#[error("expected identifier")]
	ExpectedIdent,
	/// A block terminator does not match the innermost open block.
	#[error("mismatched block terminator")]
	MismatchedEnd,
	/// A block terminator appeared with no open block.
	#[error("unexpected block terminator")]
	StrayEnd,
	/// A block statement never closes.
	#[error("unclosed block")]
	UnclosedBlock,
}

/// Render-time shape failure classification for [`Error::Type`].
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum TypeErrorKind {
	/// `{% for %}` over a non-list, non-map value.
	#[error("value is not iterable")]
	NotIterable,
	/// `< <= > >=` between values without a defined order.
	#[error("values are not comparable")]
	NotComparable,
	/// `+`, `-`, or unary minus on a non-number.
	#[error("arithmetic requires numbers")]
	NotNumeric,
	/// A filter name that is not registered on the engine.
	#[error("unknown filter")]
	UnknownFilter,
	/// A function name that is not registered on the engine.
	#[error("unknown function")]
	UnknownFunction,
	/// A block name that is not registered on the engine.
	#[error("unknown block")]
	UnknownBlock,
}

/// Typed failures raised by the builtin filters, functions, and blocks;
/// carried as the source of [`Error::Helper`].
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum HelperError {
	/// A DOM-only helper was called without a render-scoped session tree.
	#[error("function requires a session DOM")]
	MissingDom,
	/// Too few or too many helper arguments.
	#[error("expected {expected} argument(s), got {got}")]
	Arity {
		/// Number of arguments the helper requires (excluding filter input).
		expected: usize,
		/// Number of arguments supplied.
		got:      usize,
	},
	/// An argument had to be a selector string or selected-node list.
	#[error("argument must be a selector string or selected-node list")]
	SelectorOrList,
	/// An argument had to be a string.
	#[error("argument must be a string")]
	ExpectedString,
	/// An argument had to be an integer.
	#[error("argument must be an integer")]
	ExpectedInt,
	/// An argument had to be a boolean.
	#[error("argument must be a boolean")]
	ExpectedBool,
	/// The input value had to be a list.
	#[error("value must be a list")]
	ExpectedList,
	/// The input value had to be a count or a list.
	#[error("value must be an integer count or a list")]
	ExpectedCount,
	/// The input value has no length.
	#[error("value has no length")]
	NoLength,
	/// The `xml` block tag name failed validation.
	#[error("xml tag names must match [A-Za-z0-9_-]+")]
	InvalidTagName,
}

/// 1-based line and column (in characters) of a byte offset.
fn locate(source: &str, offset: usize) -> (u32, u32) {
	let offset = offset.min(source.len());
	let before = &source[..offset];
	let line = before.matches('\n').count() as u32 + 1;
	let line_start = before.rfind('\n').map_or(0, |index| index + 1);
	let col = source[line_start..offset].chars().count() as u32 + 1;
	(line, col)
}

/// The offending source line plus a `^~~~` underline aligned to the span.
fn snippet(source: &str, span: Span) -> Str {
	let start = (span.start as usize).min(source.len());
	let line_start = source[..start].rfind('\n').map_or(0, |index| index + 1);
	let line_end = source[start..]
		.find('\n')
		.map_or(source.len(), |index| start + index);
	let line = &source[line_start..line_end];
	let mut out = StrMut::with_capacity(line.len() * 2 + 2);
	out.push_str(line);
	out.push('\n');
	for character in source[line_start..start].chars() {
		out.push(if character == '\t' { '\t' } else { ' ' });
	}
	out.push('^');
	let span_end = (start + usize::from(span.len)).min(line_end);
	let underline = source[start..span_end].chars().count().saturating_sub(1);
	for _ in 0..underline {
		out.push('~');
	}
	out.freeze()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn snippet_underlines_the_span_on_its_own_line() {
		let source = "first\n\thello {{ name }}\nlast";
		let offset = source.find("name").unwrap();
		let error = Error::undefined(
			&Str::new_static("test"),
			source,
			Span::new(offset, 4),
			Str::new_static("name"),
		);
		let text = error.to_string();
		assert!(text.contains("undefined value `name` in `test` at 2:11"));
		assert!(text.contains("\thello {{ name }}\n\t         ^~~~"));
	}

	#[test]
	fn locate_is_one_based_and_char_counted() {
		assert_eq!(locate("ab\ncd", 0), (1, 1));
		assert_eq!(locate("ab\ncd", 4), (2, 2));
		assert_eq!(locate("é{{", 2), (1, 2));
	}
}
