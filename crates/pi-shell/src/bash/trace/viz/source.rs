//! Exact canonical-byte to original UTF-16 source coordinates.
use super::runtime::{SourceUnit, VizSource};
use crate::bash::{ir::ansi_c, syntax::Span};

#[derive(Clone, Debug)]
pub struct SourceMap {
	offset:     u32,
	projection: u32,
	len:        usize,
	outer:      Option<std::sync::Arc<[u32]>>,
}
impl SourceMap {
	pub const fn unlocated(offset: u32, len: usize) -> Self {
		Self { offset, projection: 0, len, outer: None }
	}

	pub fn nested(
		&self,
		parent_span: Span,
		parent_source: &[u8],
		decoded: &[u8],
		offset: u32,
	) -> Option<Self> {
		let [lo, _] = self.bytes(parent_span)?;
		let literal = literal_map(self.raw(parent_source, parent_span), decoded)?;
		let outer = self.outer.as_ref()?;
		let mapped: Option<Vec<u32>> = literal
			.into_iter()
			.map(|at| outer.get(lo + at as usize).copied())
			.collect();
		Some(Self { offset, projection: 0, len: decoded.len(), outer: Some(mapped?.into()) })
	}

	pub fn bytes(&self, span: Span) -> Option<[usize; 2]> {
		let lo = span
			.lo
			.checked_sub(self.offset)?
			.checked_sub(self.projection)? as usize;
		let hi = span
			.hi
			.checked_sub(self.offset)?
			.checked_sub(self.projection)? as usize;
		(lo <= hi && hi <= self.len).then_some([lo, hi])
	}

	pub fn range(&self, span: Span) -> Option<[u32; 2]> {
		let [lo, hi] = self.bytes(span)?;
		let map = self.outer.as_ref()?;
		Some([*map.get(lo)?, *map.get(hi)?])
	}

	pub fn raw<'a>(&self, unit_source: &'a [u8], span: Span) -> &'a [u8] {
		self
			.bytes(span)
			.and_then(|[lo, hi]| unit_source.get(lo..hi))
			.unwrap_or_default()
	}
}
/// Map for `len` script bytes from `at`, parsed on their own, followed by
/// `extra` bytes that are not in the script (the closers a streaming repair
/// appends): those all map to the end, so nothing drawn from them alone has
/// a source range of its own.
pub fn script_map(source: &impl VizSource, at: usize, len: usize, extra: usize) -> SourceMap {
	let utf16 = super::printer::script_utf16(source);
	SourceMap {
		offset:     0,
		projection: 0,
		len:        len + extra,
		outer:      utf16.get(at..=at + len).map(|map| {
			map.iter()
				.copied()
				.chain(std::iter::repeat_n(map[len], extra))
				.collect()
		}),
	}
}
pub fn unit_map(source: &impl VizSource, unit: &SourceUnit<'_>) -> SourceMap {
	build(source, unit, 0)
}
/// `unit`'s canonical byte coordinates without original-source positions:
/// enough to slice its own bytes, and built without the presentation cache.
pub fn unit_bytes(unit: &SourceUnit<'_>) -> SourceMap {
	SourceMap {
		offset:     unit.syntax.map_or(0, |s| s.offset),
		projection: unit.projection,
		len:        unit.source.len(),
		outer:      None,
	}
}
fn build(source: &impl VizSource, unit: &SourceUnit<'_>, depth: usize) -> SourceMap {
	let body: &[u8] = unit.source.as_ref();
	let mut result = unit_bytes(unit);
	if depth > source.unit_count() {
		return result;
	}
	if let Some(parent) = unit.syntax.and_then(|s| s.parent.as_ref()) {
		let Some(parent_unit) = source.unit(parent.unit as usize) else {
			return result;
		};
		let raw: &[u8] = parent_unit.source.as_ref();
		let Some(raw) = raw.get(parent.lo as usize..parent.hi as usize) else {
			return result;
		};
		let Some((decoded, literal)) = decode_literal(raw) else {
			return result;
		};
		let start = unit.syntax.map_or(0, |syntax| syntax.offset) as usize;
		let Some(end) = start.checked_add(body.len()) else {
			return result;
		};
		if decoded.get(start..end) != Some(body) {
			return result;
		}
		let Some(literal) = literal.get(start..=end) else {
			return result;
		};
		let parent_map = build(source, &parent_unit, depth + 1);
		let Some(outer) = parent_map.outer.as_ref() else {
			return result;
		};
		let start = parent.lo;
		result.outer = literal
			.iter()
			.map(|at| outer.get((start + *at) as usize).copied())
			.collect::<Option<Vec<_>>>()
			.map(Into::into);
	} else if let Some(at) = unit.at {
		let script: &[u8] = source.script().as_ref();
		let start = at as usize;
		if script.get(start..start.saturating_add(body.len())) == Some(body) {
			let map = super::printer::script_utf16(source);
			result.outer = map.get(start..=start + body.len()).map(Into::into);
		}
	}
	result
}
/// Every byte boundary is represented; interior UTF-8 bytes retain the scalar's
/// origin.
pub(super) fn utf16_map(bytes: &[u8]) -> Vec<u32> {
	let mut map = vec![0; bytes.len() + 1];
	let mut i = 0;
	let mut count = 0;
	while i < bytes.len() {
		let width = match bytes[i] {
			0..=0x7f => 1,
			0xc2..=0xdf => 2,
			0xe0..=0xef => 3,
			0xf0..=0xf4 => 4,
			_ => 1,
		};
		let width = if i + width <= bytes.len() && std::str::from_utf8(&bytes[i..i + width]).is_ok() {
			width
		} else {
			1
		};
		for slot in &mut map[i..i + width] {
			*slot = count;
		}
		count += if width == 4 { 2 } else { 1 };
		i += width;
		map[i] = count;
	}
	map
}
/// Decode a static shell word, recording origins rather than searching for its
/// text. Expansion-bearing or otherwise unprovable words are deliberately
/// unlocated.
pub fn literal_map(raw: &[u8], decoded: &[u8]) -> Option<Vec<u32>> {
	let (value, map) = decode_literal(raw)?;
	(value == decoded).then_some(map)
}
fn decode_literal(raw: &[u8]) -> Option<(Vec<u8>, Vec<u32>)> {
	let mut value = Vec::new();
	let mut origins = Vec::new();
	let mut i = 0;
	let mut end = 0;
	while i < raw.len() {
		let (quote, ansi) = if raw[i] == b'\'' {
			(b'\'', false)
		} else if raw[i] == b'"' {
			(b'"', false)
		} else if raw[i] == b'$' && raw.get(i + 1) == Some(&b'\'') {
			i += 1;
			(b'\'', true)
		} else {
			(0, false)
		};
		if quote != 0 {
			i += 1;
		}
		let mut ansi_ended = false;
		while i < raw.len() && (quote == 0 || raw[i] != quote) {
			if quote == 0 && matches!(raw[i], b'\'' | b'"') {
				break;
			}
			if quote == 0 && raw[i] == b'$' && raw.get(i + 1) == Some(&b'\'') {
				break;
			}
			let start = i;
			let mut chunk = Vec::new();
			if raw[i] == b'\\' && (quote != b'\'' || ansi) {
				i += 1;
				let next = *raw.get(i)?;
				if ansi {
					i += 1;
					let braced = next == b'x' && raw.get(i) == Some(&b'{');
					if braced {
						i += 1;
					}
					let max = match next {
						b'0'..=b'7' => 2,
						b'x' if braced => usize::MAX,
						b'x' => 2,
						b'u' => 4,
						b'U' => 8,
						b'c' => 1,
						_ => 0,
					};
					let mut n = 0;
					while n < max
						&& i < raw.len()
						&& match next {
							b'0'..=b'7' => matches!(raw[i], b'0'..=b'7'),
							b'x' | b'u' | b'U' => raw[i].is_ascii_hexdigit(),
							_ => true,
						} {
						i += 1;
						n += 1;
					}
					if next == b'c'
						&& raw.get(i.wrapping_sub(1)) == Some(&b'\\')
						&& raw.get(i) == Some(&b'\\')
					{
						i += 1;
					}
					if braced && raw.get(i) == Some(&b'}') {
						i += 1;
					}
					chunk = ansi_c(&raw[start..i]).to_vec();
					if chunk.is_empty() {
						ansi_ended = true;
					}
				} else if quote == b'"' && !matches!(next, b'$' | b'`' | b'"' | b'\\' | b'\n') {
					chunk.push(b'\\');
				} else {
					i += 1;
					if next != b'\n' {
						chunk.push(next);
					}
				}
			} else {
				if quote != b'\'' && matches!(raw[i], b'$' | b'`') {
					return None;
				}
				if quote == 0
					&& (raw[i].is_ascii_whitespace()
						|| matches!(
							raw[i],
							b';'
								| b'|'
								| b'&'
								| b'<'
								| b'>'
								| b'('
								| b')'
								| b'*'
								| b'?'
								| b'['
								| b'~'
								| b'{'
								| b'}'
						)) {
					return None;
				}
				chunk.push(raw[i]);
				i += 1;
			}
			if !ansi_ended {
				for (n, byte) in chunk.iter().enumerate() {
					value.push(*byte);
					origins.push(if i - start == chunk.len() {
						(start + n) as u32
					} else {
						start as u32
					});
				}
			}
			end = i;
		}
		if quote != 0 {
			if raw.get(i) != Some(&quote) {
				return None;
			}
			end = i;
			i += 1;
		}
	}
	origins.push(end as u32);
	Some((value, origins))
}
/// Locate here-document text from canonical headers and exact delimiter lines.
/// Results correspond to redirection indexes and exclude the closing delimiter.
pub fn heredoc_spans(
	map: &SourceMap,
	unit_source: &[u8],
	redirs: crate::bash::syntax::tree::Seq<'_, crate::bash::syntax::tree::Redir<'_>>,
) -> Vec<Option<Span>> {
	use crate::bash::syntax::{RedirOp, tree::RedirTarget};
	let line_after = |at: usize| -> usize {
		unit_source
			.get(at..)
			.and_then(|rest| rest.iter().position(|byte| *byte == b'\n'))
			.map_or(unit_source.len(), |distance| at + distance + 1)
	};
	let mut next_body = None;
	redirs
		.iter()
		.map(|redir| {
			let RedirTarget::HereDoc(document) = redir.target() else {
				return None;
			};
			let [_, header_end] = map.bytes(redir.span())?;
			let start = next_body.unwrap_or_else(|| line_after(header_end));
			let mut line = start;
			let mut body_end = unit_source.len();
			while line < unit_source.len() {
				let end = unit_source[line..]
					.iter()
					.position(|byte| *byte == b'\n')
					.map_or(unit_source.len(), |distance| line + distance);
				let mut delimiter_start = line;
				if matches!(redir.op(), RedirOp::HereDoc { strip_tabs: true }) {
					while delimiter_start < end && unit_source[delimiter_start] == b'\t' {
						delimiter_start += 1;
					}
				}
				if unit_source.get(delimiter_start..end) == Some(document.delim()) {
					body_end = line;
					next_body = Some(if end < unit_source.len() {
						end + 1
					} else {
						end
					});
					break;
				}
				line = if end < unit_source.len() {
					end + 1
				} else {
					end
				};
			}
			if line >= unit_source.len() {
				next_body = Some(unit_source.len());
			}
			let base = map.offset.checked_add(map.projection)?;
			let lo = base.checked_add(u32::try_from(start).ok()?)?;
			let hi = base.checked_add(u32::try_from(body_end).ok()?)?;
			Some(Span::new(lo, hi))
		})
		.collect()
}
#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn heredoc_boundaries_are_sequential_and_exact() {
		use crate::bash::syntax::{Features, NO_ALIASES, Parser};
		let bytes = b"cat <<A <<-B\nnot A\nA\n\tbody B\n\tB\n";
		let map =
			SourceMap { offset: 10, projection: 3, len: bytes.len(), outer: None };
		// The unit starts at absolute offset 13: parse it there.
		let mut script = b" ".repeat(13);
		script.extend_from_slice(bytes);
		let cc = Parser::new(&script, Features::NONE, NO_ALIASES)
			.next_command()
			.unwrap()
			.unwrap();
		let cmd = cc
			.list()
			.items()
			.one()
			.unwrap()
			.and_or()
			.first()
			.stages()
			.one()
			.unwrap();
		let spans = heredoc_spans(&map, bytes, cmd.redirs());
		assert_eq!(spans.len(), 2);
		assert_eq!(map.raw(bytes, spans[0].unwrap()), b"not A\n");
		assert_eq!(map.raw(bytes, spans[1].unwrap()), b"\tbody B\n");
	}
	#[test]
	fn unicode_boundaries() {
		assert_eq!(utf16_map("a😀é".as_bytes()), vec![0, 1, 1, 1, 1, 3, 3, 4]);
	}
	#[test]
	fn literal_origins() {
		assert_eq!(literal_map(b"'same same'", b"same same"), Some((1..=10).collect()));
		assert_eq!(literal_map(b"\"a\\\"b\"", b"a\"b"), Some(vec![1, 2, 4, 5]));
		assert_eq!(literal_map(b"$'a\\u263ab'", "a☺b".as_bytes()), Some(vec![2, 3, 3, 3, 9, 10]));
		assert!(literal_map(b"\"$dynamic\"", b"value").is_none());
		assert!(literal_map(b"'wrong'", b"right").is_none());
	}
	#[test]
	fn continuation_and_concatenation() {
		assert_eq!(literal_map(b"'a'\"b\"c\\\nd", b"abcd"), Some(vec![1, 4, 6, 9, 10]));
	}
	#[test]
	fn authoritative_ansi_escapes() {
		assert_eq!(literal_map(b"$'\\x{41}\\c?'${x}", b"A\x7fvalue"), None);
		assert_eq!(literal_map(b"$'\\x{41}\\c?'", b"A\x7f"), Some(vec![2, 8, 11]));
		assert_eq!(literal_map(b"$'a\\0ignored'b", b"ab"), Some(vec![2, 13, 14]));
	}
	#[test]
	fn nested_maps_compose_escaped_unicode() {
		let raw = "\"x=\\\"😀\\\"\"".as_bytes();
		let parent = SourceMap {
			offset:     0,
			projection: 0,
			len:        raw.len(),
			outer:      Some(utf16_map(raw).into()),
		};
		let child = parent
			.nested(Span::new(0, raw.len() as u32), raw, "x=\"😀\"".as_bytes(), 0)
			.unwrap();
		assert_eq!(child.range(Span::new(2, 3)), Some([3, 5]));
		assert_eq!(child.range(Span::new(3, 7)), Some([5, 7]));
		assert!(
			parent
				.nested(Span::new(0, raw.len() as u32), raw, b"wrong", 0)
				.is_none()
		);
	}
	#[test]
	fn offset_then_projection() {
		let map = SourceMap {
			offset:     20,
			projection: 3,
			len:        4,
			outer:      Some(vec![7, 8, 9, 10, 11].into()),
		};
		assert_eq!(map.bytes(Span::new(24, 26)), Some([1, 3]));
		assert_eq!(map.range(Span::new(24, 26)), Some([8, 10]));
		assert_eq!(map.raw(b"abcd", Span::new(24, 26)), b"bc");
		assert_eq!(map.range(Span::new(20, 24)), None);
	}
}
