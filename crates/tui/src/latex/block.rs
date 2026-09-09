//! Two-dimensional layout for display LaTeX.
//!
//! The box model and stretchy-delimiter approach are modeled on txm — Terminal
//! TeX Math — by @thatmagicalcat (<https://github.com/thatmagicalcat/txm>,
//! MIT/Apache-2.0), reimplemented for styled terminal segments.

use std::borrow;

use omp_core::{IntoStr, Str, StrMut};
use smallvec::SmallVec;

use super::unicode::{
	MathFont, Row, apply_math_font, latex_row, latex_superscript_row, math_font,
	resolve_latex_color, terminal_text_style,
};
#[cfg(test)]
use crate::rich::RichText;
use crate::{
	frame::Style,
	rich::{RichSink, cell_width},
};

const BAR: &str = "─";

#[derive(Clone)]
struct MathBox {
	lines:    Vec<Row>,
	baseline: usize,
	width:    u16,
}

#[derive(Clone, Copy)]
enum CellAlign {
	Left,
	Center,
	Right,
}

#[derive(Clone, Copy)]
struct Context {
	style: Style,
	font:  Option<MathFont>,
}

#[derive(Clone, Copy)]
struct HBraceSpec {
	left:   &'static str,
	mid:    &'static str,
	center: &'static str,
	right:  &'static str,
	over:   bool,
}

#[derive(Clone, Copy)]
struct DelimPieces {
	only:   &'static str,
	top:    &'static str,
	mid:    &'static str,
	bottom: &'static str,
	axis:   Option<&'static str>,
}

fn owned_line(style: Style, text: impl IntoStr) -> Row {
	let text = text.into_str();
	if text.is_empty() {
		Row::new()
	} else {
		let mut line = Row::new();
		line.push((style, text));
		line
	}
}

fn spaces(style: Style, width: u16) -> Row {
	let mut text = StrMut::with_capacity(usize::from(width));
	for _ in 0..width {
		text.push(' ');
	}
	owned_line(style, text.freeze())
}

fn repeated(style: Style, glyph: &str, count: u16) -> Row {
	let capacity = usize::from(count).saturating_mul(glyph.len());
	let mut text = StrMut::with_capacity(capacity);
	for _ in 0..count {
		text.push_str(glyph);
	}
	owned_line(style, text.freeze())
}

fn append_line(target: &mut Row, source: &Row) {
	target.extend(source.iter().cloned());
}

fn row_width(row: &Row) -> u16 {
	row.iter()
		.fold(0_u16, |width, (_, text)| width.saturating_add(cell_width(text)))
}

fn padded_line(line: &Row, width: u16, align: CellAlign, style: Style) -> Row {
	let extra = width.saturating_sub(row_width(line));
	let left = match align {
		CellAlign::Left => 0,
		CellAlign::Center => extra / 2,
		CellAlign::Right => extra,
	};
	let right = extra - left;
	let mut result = Row::new();
	append_line(&mut result, &spaces(style, left));
	append_line(&mut result, line);
	append_line(&mut result, &spaces(style, right));
	result
}

fn text_box(line: Row) -> MathBox {
	let width = row_width(&line);
	MathBox { lines: vec![line], baseline: 0, width }
}

fn empty_box() -> MathBox {
	MathBox { lines: vec![Row::new()], baseline: 0, width: 0 }
}

fn flat_box(src: &str, ctx: Context) -> MathBox {
	let mut line = latex_row(src, ctx.style);
	if let Some(font) = ctx.font {
		for (_, text) in &mut line {
			*text = Str::from(apply_math_font(font, text.as_str()));
		}
	}
	text_box(line)
}

fn pad_box(mut item: MathBox, width: u16, align: CellAlign, style: Style) -> MathBox {
	if item.width >= width {
		return item;
	}
	item.lines = item
		.lines
		.iter()
		.map(|line| padded_line(line, width, align, style))
		.collect();
	item.width = width;
	item
}

fn hconcat(boxes: impl IntoIterator<Item = MathBox>, style: Style) -> MathBox {
	let boxes: SmallVec<MathBox, 8> = boxes.into_iter().collect();
	if boxes.is_empty() {
		return empty_box();
	}
	if boxes.len() == 1 {
		return boxes.into_iter().next().unwrap_or_else(empty_box);
	}
	let above = boxes.iter().map(|item| item.baseline).max().unwrap_or(0);
	let below = boxes
		.iter()
		.map(|item| item.lines.len().saturating_sub(item.baseline + 1))
		.max()
		.unwrap_or(0);
	let height = above + below + 1;
	let width = boxes
		.iter()
		.fold(0_u16, |sum, item| sum.saturating_add(item.width));
	let mut lines = Vec::with_capacity(height);
	for row in 0..height {
		let mut line = Row::new();
		for item in &boxes {
			let local = row as isize - (above as isize - item.baseline as isize);
			if local >= 0
				&& let Some(content) = item.lines.get(local as usize)
			{
				append_line(&mut line, content);
				let missing = item.width.saturating_sub(row_width(content));
				append_line(&mut line, &spaces(style, missing));
				continue;
			}
			append_line(&mut line, &spaces(style, item.width));
		}
		lines.push(line);
	}
	MathBox { lines, baseline: above, width }
}

fn vconcat(boxes: Vec<MathBox>, align: CellAlign, style: Style) -> MathBox {
	if boxes.is_empty() {
		return empty_box();
	}
	if boxes.len() == 1 {
		return boxes.into_iter().next().unwrap_or_else(empty_box);
	}
	let width = boxes.iter().map(|item| item.width).max().unwrap_or(0);
	let mut lines = Vec::new();
	for item in boxes {
		for line in item.lines {
			lines.push(padded_line(&line, width, align, style));
		}
	}
	let baseline = lines.len().saturating_sub(1) / 2;
	MathBox { lines, baseline, width }
}

fn frac_box(num: MathBox, den: MathBox, style: Style) -> MathBox {
	let width = num.width.max(den.width).saturating_add(2);
	let mut lines = Vec::with_capacity(num.lines.len() + den.lines.len() + 1);
	for line in num.lines {
		lines.push(padded_line(&line, width, CellAlign::Center, style));
	}
	let baseline = lines.len();
	lines.push(repeated(style, BAR, width));
	for line in den.lines {
		lines.push(padded_line(&line, width, CellAlign::Center, style));
	}
	MathBox { lines, baseline, width }
}

fn delim_pieces(key: &str) -> Option<DelimPieces> {
	Some(match key {
		"(" => DelimPieces { only: "(", top: "⎛", mid: "⎜", bottom: "⎝", axis: None },
		")" => DelimPieces { only: ")", top: "⎞", mid: "⎟", bottom: "⎠", axis: None },
		"[" => DelimPieces { only: "[", top: "⎡", mid: "⎢", bottom: "⎣", axis: None },
		"]" => DelimPieces { only: "]", top: "⎤", mid: "⎥", bottom: "⎦", axis: None },
		"{" => DelimPieces { only: "{", top: "⎧", mid: "⎪", bottom: "⎩", axis: Some("⎨") },
		"}" => DelimPieces { only: "}", top: "⎫", mid: "⎪", bottom: "⎭", axis: Some("⎬") },
		"|" => DelimPieces { only: "|", top: "│", mid: "│", bottom: "│", axis: None },
		"‖" => DelimPieces { only: "‖", top: "║", mid: "║", bottom: "║", axis: None },
		"⌈" => DelimPieces { only: "⌈", top: "⎡", mid: "⎢", bottom: "⎢", axis: None },
		"⌉" => DelimPieces { only: "⌉", top: "⎤", mid: "⎥", bottom: "⎥", axis: None },
		"⌊" => DelimPieces { only: "⌊", top: "⎢", mid: "⎢", bottom: "⎣", axis: None },
		"⌋" => DelimPieces { only: "⌋", top: "⎥", mid: "⎥", bottom: "⎦", axis: None },
		_ => return None,
	})
}

fn delim_column(key: &str, height: usize, baseline: usize, style: Style) -> Option<MathBox> {
	if key.is_empty() {
		return None;
	}
	let pieces = delim_pieces(key);
	if height <= 1 {
		return Some(text_box(owned_line(style, pieces.map_or(key, |piece| piece.only))));
	}
	let width = row_width(&owned_line(style, pieces.map_or(key, |piece| piece.only)));
	let mut lines = Vec::with_capacity(height);
	let Some(pieces) = pieces else {
		for row in 0..height {
			lines.push(if row == baseline {
				owned_line(style, key)
			} else {
				spaces(style, width)
			});
		}
		return Some(MathBox { lines, baseline, width });
	};
	let axis_row = baseline.max(1).min(height.saturating_sub(2));
	for row in 0..height {
		let glyph = if row == 0 {
			pieces.top
		} else if row + 1 == height {
			pieces.bottom
		} else if row == axis_row {
			pieces.axis.unwrap_or(pieces.mid)
		} else {
			pieces.mid
		};
		lines.push(owned_line(style, glyph));
	}
	Some(MathBox { lines, baseline, width })
}

fn delim_box(inner: MathBox, left: &str, right: &str, style: Style) -> MathBox {
	let height = inner.lines.len();
	let baseline = inner.baseline;
	let left = delim_column(left, height, baseline, style);
	let right = delim_column(right, height, baseline, style);
	if left.is_none() && right.is_none() {
		return inner;
	}
	let mut parts: SmallVec<MathBox, 5> = SmallVec::new();
	if let Some(left) = left {
		parts.push(left);
	}
	if height > 1 {
		parts.push(text_box(owned_line(style, " ")));
	}
	parts.push(inner);
	if height > 1 {
		parts.push(text_box(owned_line(style, " ")));
	}
	if let Some(right) = right {
		parts.push(right);
	}
	hconcat(parts, style)
}

fn binom_box(top: MathBox, bottom: MathBox, style: Style) -> MathBox {
	let width = top.width.max(bottom.width);
	let top_len = top.lines.len();
	let mut lines = Vec::new();
	for line in top.lines {
		lines.push(padded_line(&line, width, CellAlign::Center, style));
	}
	lines.push(spaces(style, width));
	for line in bottom.lines {
		lines.push(padded_line(&line, width, CellAlign::Center, style));
	}
	delim_box(MathBox { lines, baseline: top_len, width }, "(", ")", style)
}

fn radical_box(inner: MathBox, degree: Option<&str>, ctx: Context) -> MathBox {
	let width = inner.width.saturating_add(3);
	let mut roof = owned_line(ctx.style, " ┌");
	append_line(&mut roof, &repeated(ctx.style, BAR, inner.width.saturating_add(1)));
	let mut lines = vec![roof];
	let inner_len = inner.lines.len();
	for (row, line) in inner.lines.into_iter().enumerate() {
		let mut result = owned_line(
			ctx.style,
			if row + 1 == inner_len {
				"╲│ "
			} else {
				" │ "
			},
		);
		append_line(&mut result, &line);
		lines.push(result);
	}
	let radical = MathBox { lines, baseline: inner.baseline + 1, width };
	let Some(degree) = degree else { return radical };
	let mut degree_line = latex_superscript_row(degree, ctx.style);
	if let Some(font) = ctx.font {
		for (_, text) in &mut degree_line {
			*text = Str::from(apply_math_font(font, text.as_str()));
		}
	}
	let rendered = text_box(degree_line);
	let mut degree_lines = rendered.lines;
	degree_lines.push(spaces(ctx.style, rendered.width));
	hconcat(
		[MathBox { lines: degree_lines, baseline: 1, width: rendered.width }, radical],
		ctx.style,
	)
}

fn limits_box(glyph: MathBox, sub: Option<MathBox>, sup: Option<MathBox>, style: Style) -> MathBox {
	let width = glyph
		.width
		.max(sub.as_ref().map_or(0, |item| item.width))
		.max(sup.as_ref().map_or(0, |item| item.width));
	let mut lines = Vec::new();
	if let Some(sup) = sup {
		for line in sup.lines {
			lines.push(padded_line(&line, width, CellAlign::Center, style));
		}
	}
	let baseline = lines.len() + glyph.baseline;
	for line in glyph.lines {
		lines.push(padded_line(&line, width, CellAlign::Center, style));
	}
	if let Some(sub) = sub {
		for line in sub.lines {
			lines.push(padded_line(&line, width, CellAlign::Center, style));
		}
	}
	MathBox { lines, baseline, width }
}

fn hbrace_spec(name: &str) -> Option<HBraceSpec> {
	Some(match name {
		"overbrace" => {
			HBraceSpec { left: "╭", mid: "─", center: "┴", right: "╮", over: true }
		},
		"underbrace" => {
			HBraceSpec { left: "╰", mid: "─", center: "┬", right: "╯", over: false }
		},
		"overbracket" => {
			HBraceSpec { left: "┌", mid: "─", center: "─", right: "┐", over: true }
		},
		"underbracket" => {
			HBraceSpec { left: "└", mid: "─", center: "─", right: "┘", over: false }
		},
		"overparen" => {
			HBraceSpec { left: "╭", mid: "─", center: "─", right: "╮", over: true }
		},
		"underparen" => {
			HBraceSpec { left: "╰", mid: "─", center: "─", right: "╯", over: false }
		},
		_ => return None,
	})
}

fn hbrace_box(content: MathBox, spec: HBraceSpec, label: Option<MathBox>, style: Style) -> MathBox {
	let brace_width = content.width.max(3);
	let width = brace_width.max(label.as_ref().map_or(0, |item| item.width));
	let lead = (brace_width - 3) / 2;
	let mut brace = StrMut::new(spec.left);
	for _ in 0..lead {
		brace.push_str(spec.mid);
	}
	brace.push_str(spec.center);
	for _ in 0..brace_width - 3 - lead {
		brace.push_str(spec.mid);
	}
	brace.push_str(spec.right);
	let brace = padded_line(&owned_line(style, brace.freeze()), width, CellAlign::Center, style);
	let content_lines: Vec<_> = content
		.lines
		.into_iter()
		.map(|line| padded_line(&line, width, CellAlign::Center, style))
		.collect();
	let label_lines: Vec<_> = label
		.map(|item| {
			item
				.lines
				.into_iter()
				.map(|line| padded_line(&line, width, CellAlign::Center, style))
				.collect()
		})
		.unwrap_or_default();
	if spec.over {
		let mut lines = label_lines;
		let label_len = lines.len();
		lines.push(brace);
		lines.extend(content_lines);
		MathBox { lines, baseline: label_len + 1 + content.baseline, width }
	} else {
		let mut lines = content_lines;
		lines.push(brace);
		lines.extend(label_lines);
		MathBox { lines, baseline: content.baseline, width }
	}
}

fn attach_scripts(
	base: MathBox,
	sub: Option<MathBox>,
	sup: Option<MathBox>,
	style: Style,
) -> MathBox {
	if sub.is_none() && sup.is_none() {
		return base;
	}
	let single = base.lines.len() == 1;
	let width = sub
		.as_ref()
		.map_or(0, |item| item.width)
		.max(sup.as_ref().map_or(0, |item| item.width));
	let mut lines = Vec::new();
	let baseline = if let Some(sup) = sup {
		let lift = if single { 1 } else { base.baseline };
		for line in sup.lines {
			lines.push(padded_line(&line, width, CellAlign::Left, style));
		}
		for _ in 0..lift {
			lines.push(spaces(style, width));
		}
		lines.len().saturating_sub(1)
	} else {
		0
	};
	if let Some(sub) = sub {
		let below = base
			.lines
			.len()
			.saturating_sub(1 + base.baseline)
			.saturating_sub(sub.lines.len().saturating_sub(1));
		let mut drop = below.max(usize::from(single));
		if !lines.is_empty() && drop < 1 {
			drop = 1;
		}
		let gap = if lines.is_empty() {
			drop
		} else {
			drop.saturating_sub(1)
		};
		for _ in 0..gap {
			lines.push(spaces(style, width));
		}
		for line in sub.lines {
			lines.push(padded_line(&line, width, CellAlign::Left, style));
		}
	}
	hconcat([base, MathBox { lines, baseline, width }], style)
}

fn grid_box<F, G>(
	rows: Vec<Vec<MathBox>>,
	align: F,
	gap: G,
	row_gap: usize,
	style: Style,
) -> MathBox
where
	F: Fn(usize) -> CellAlign,
	G: Fn(usize) -> u16,
{
	let ncols = rows.iter().map(Vec::len).max().unwrap_or(0);
	if ncols == 0 || rows.is_empty() {
		return empty_box();
	}
	let mut widths = vec![0_u16; ncols];
	for row in &rows {
		for (column, cell) in row.iter().enumerate() {
			widths[column] = widths[column].max(cell.width);
		}
	}
	let row_count = rows.len();
	let mut row_boxes = Vec::new();
	for row in rows {
		if row_gap > 0 && !row_boxes.is_empty() {
			for _ in 0..row_gap {
				row_boxes.push(empty_box());
			}
		}
		let mut cells = row.into_iter();
		let mut parts: SmallVec<MathBox, 8> = SmallVec::new();
		for (column, &col_width) in widths.iter().enumerate() {
			if column > 0 {
				let width = gap(column);
				if width > 0 {
					parts.push(text_box(spaces(style, width)));
				}
			}
			parts.push(pad_box(
				cells.next().unwrap_or_else(empty_box),
				col_width,
				align(column),
				style,
			));
		}
		row_boxes.push(hconcat(parts, style));
	}
	let mut grid = vconcat(row_boxes, CellAlign::Left, style);
	if row_gap > 0 && row_count > 1 && grid.lines.len().is_multiple_of(2) {
		grid.lines.push(spaces(style, grid.width));
		grid.baseline = grid.lines.len() / 2;
	}
	grid
}

#[derive(Clone, Copy)]
struct Span<'a> {
	text: &'a str,
	end:  usize,
}

fn skip_spaces(src: &str, mut at: usize) -> usize {
	while src.as_bytes().get(at).is_some_and(u8::is_ascii_whitespace) {
		at += 1;
	}
	at
}

fn read_group(src: &str, start: usize) -> Span<'_> {
	let mut depth = 0_usize;
	let mut at = start;
	let content_start = start.saturating_add(1);
	while at < src.len() {
		let byte = src.as_bytes()[at];
		if byte == b'\\' {
			at = (at + 2).min(src.len());
			continue;
		}
		if byte == b'{' {
			depth += 1;
		} else if byte == b'}' {
			depth = depth.saturating_sub(1);
			if depth == 0 {
				return Span { text: &src[content_start..at], end: at + 1 };
			}
		}
		at += 1;
	}
	Span { text: src.get(content_start..).unwrap_or(""), end: src.len() }
}

fn command_end(src: &str, start: usize) -> usize {
	let mut at = start + 1;
	if src.as_bytes().get(at).is_some_and(u8::is_ascii_alphabetic) {
		while src.as_bytes().get(at).is_some_and(u8::is_ascii_alphabetic) {
			at += 1;
		}
	} else if let Some(character) = src.get(at..).and_then(|tail| tail.chars().next()) {
		at += character.len_utf8();
	}
	at
}

/// Reads one command argument: a `{…}` group, a single char, or a `\command`
/// together with its arguments (or whole `\begin…\end` block). Commands whose
/// arity is known consume exactly that many arguments, including across
/// source whitespace, so `\frac\sqrt {a} {b}` reads `\sqrt {a}` as the
/// numerator and leaves `{b}` for the denominator.
fn read_arg(src: &str, start: usize) -> Span<'_> {
	let start = skip_spaces(src, start);
	if start >= src.len() {
		return Span { text: "", end: start };
	}
	if src.as_bytes()[start] == b'{' {
		return read_group(src, start);
	}
	if src.as_bytes()[start] != b'\\' {
		let end = start + src[start..].chars().next().map_or(0, char::len_utf8);
		return Span { text: &src[start..end], end };
	}
	if src[start..].starts_with("\\begin")
		&& let Some(env) = read_environment(src, start)
	{
		return Span { text: &src[start..env.end], end: env.end };
	}
	let after_name = command_end(src, start);
	if let Some(arity) = command_arity(&src[start + 1..after_name]) {
		let mut end = after_name;
		// optional command arguments (e.g. the degree in `\sqrt[3]{x}`) do
		// not consume a required-argument slot
		loop {
			end = skip_spaces(src, end);
			if src.as_bytes().get(end) != Some(&b'[') {
				break;
			}
			end = src[end..]
				.find(']')
				.map_or(src.len(), |close| end + close + 1);
		}
		for _ in 0..arity {
			end = read_arg(src, end).end;
		}
		return Span { text: &src[start..end], end };
	}
	let mut end = after_name;
	while matches!(src.as_bytes().get(end), Some(b'[' | b'{')) {
		if src.as_bytes()[end] == b'{' {
			end = read_group(src, end).end;
		} else if let Some(close) = src[end..].find(']') {
			end += close + 1;
		} else {
			end = src.len();
		}
	}
	Span { text: &src[start..end], end }
}

fn read_delim_token(src: &str, start: usize) -> Option<Span<'_>> {
	let start = skip_spaces(src, start);
	if start >= src.len() {
		return None;
	}
	let end = if src.as_bytes()[start] == b'\\' {
		command_end(src, start)
	} else {
		start + src[start..].chars().next()?.len_utf8()
	};
	Some(Span { text: &src[start..end], end })
}

fn delim_key(token: &str, ctx: Context) -> Str {
	match token {
		"<" => Str::new("⟨"),
		">" => Str::new("⟩"),
		"." => Str::new(""),
		"(" | ")" | "[" | "]" | "|" => Str::new(token),
		"\\{" | "\\lbrace" => Str::new("{"),
		"\\}" | "\\rbrace" => Str::new("}"),
		"\\vert" | "\\lvert" | "\\rvert" => Str::new("|"),
		"\\|" | "\\Vert" | "\\lVert" | "\\rVert" => Str::new("‖"),
		"\\langle" => Str::new("⟨"),
		"\\rangle" => Str::new("⟩"),
		"\\lceil" => Str::new("⌈"),
		"\\rceil" => Str::new("⌉"),
		"\\lfloor" => Str::new("⌊"),
		"\\rfloor" => Str::new("⌋"),
		"\\lbrack" => Str::new("["),
		"\\rbrack" => Str::new("]"),
		_ => {
			let line = flat_box(token, ctx).lines.pop().unwrap_or_default();
			let mut text = StrMut::default();
			for (_, segment) in line {
				text.push_str(segment.as_str());
			}
			text.freeze().trim()
		},
	}
}

struct LeftRight<'a> {
	left:     &'a str,
	segments: Vec<&'a str>,
	middles:  Vec<&'a str>,
	right:    &'a str,
	end:      usize,
}

fn read_left_right(src: &str, start: usize) -> Option<LeftRight<'_>> {
	let left = read_delim_token(src, start + 5)?;
	let mut segments = Vec::new();
	let mut middles = Vec::new();
	let mut depth = 1_usize;
	let mut at = left.end;
	let mut segment_start = at;
	while at < src.len() {
		if src.as_bytes()[at] != b'\\' {
			at += src[at..].chars().next()?.len_utf8();
			continue;
		}
		if src[at..].starts_with("\\left") && command_boundary(src, at + 5) {
			depth += 1;
			at = read_delim_token(src, at + 5).map_or(at + 5, |span| span.end);
			continue;
		}
		if src[at..].starts_with("\\right") && command_boundary(src, at + 6) {
			depth = depth.saturating_sub(1);
			let token = read_delim_token(src, at + 6);
			if depth == 0 {
				segments.push(&src[segment_start..at]);
				return Some(LeftRight {
					left: left.text,
					segments,
					middles,
					right: token.map_or(".", |span| span.text),
					end: token.map_or(at + 6, |span| span.end),
				});
			}
			at = token.map_or(at + 6, |span| span.end);
			continue;
		}
		if depth == 1 && src[at..].starts_with("\\middle") && command_boundary(src, at + 7) {
			segments.push(&src[segment_start..at]);
			let token = read_delim_token(src, at + 7);
			middles.push(token.map_or("|", |span| span.text));
			at = token.map_or(at + 7, |span| span.end);
			segment_start = at;
			continue;
		}
		at = (at + 2).min(src.len());
	}
	None
}

fn command_boundary(src: &str, at: usize) -> bool {
	!src.as_bytes().get(at).is_some_and(u8::is_ascii_alphabetic)
}

fn match_delim(src: &str, start: usize, open: u8, close: u8) -> Option<usize> {
	let mut depth = 0_usize;
	let mut at = start;
	while at < src.len() {
		let byte = src.as_bytes()[at];
		if byte == b'\\' {
			at = (at + 2).min(src.len());
			continue;
		}
		if byte == b'{' {
			at = read_group(src, at).end;
			continue;
		}
		if byte == open {
			depth += 1;
		} else if byte == close {
			depth = depth.saturating_sub(1);
			if depth == 0 {
				return Some(at);
			}
		}
		at += 1;
	}
	None
}

struct Environment<'a> {
	name:       &'a str,
	body_start: usize,
	body_end:   usize,
	end:        usize,
}

fn read_environment(src: &str, start: usize) -> Option<Environment<'_>> {
	let name_start = skip_spaces(src, start + 6);
	if src.as_bytes().get(name_start) != Some(&b'{') {
		return None;
	}
	let name = read_group(src, name_start);
	let mut at = name.end;
	let mut depth = 1_usize;
	let mut body_end = src.len();
	while at < src.len() && depth > 0 {
		if src[at..].starts_with("\\begin") {
			depth += 1;
			at += 6;
			continue;
		}
		if src[at..].starts_with("\\end") {
			depth = depth.saturating_sub(1);
			if depth == 0 {
				body_end = at;
			}
			at = skip_spaces(src, at + 4);
			if src.as_bytes().get(at) == Some(&b'{') {
				at = read_group(src, at).end;
			}
			if depth == 0 {
				break;
			}
			continue;
		}
		at += src[at..].chars().next()?.len_utf8();
	}
	Some(Environment { name: name.text.trim(), body_start: name.end, body_end, end: at })
}

fn split_rows(body: &str) -> Vec<&str> {
	split_top_level(body, true)
}

fn split_cells(row: &str) -> Vec<&str> {
	split_top_level(row, false)
		.into_iter()
		.map(str::trim)
		.collect()
}

fn split_top_level(src: &str, rows: bool) -> Vec<&str> {
	let mut result = Vec::new();
	let mut braces = 0_isize;
	let mut environments = 0_isize;
	let mut last = 0;
	let mut at = 0;
	while at < src.len() {
		if src[at..].starts_with("\\begin") {
			environments += 1;
			at += 6;
			continue;
		}
		if src[at..].starts_with("\\end") {
			environments -= 1;
			at += 4;
			continue;
		}
		let byte = src.as_bytes()[at];
		if byte == b'\\' {
			if rows && src.as_bytes().get(at + 1) == Some(&b'\\') && braces == 0 && environments == 0 {
				result.push(&src[last..at]);
				at = skip_spaces(src, at + 2);
				if src.as_bytes().get(at) == Some(&b'[') {
					at = src[at..]
						.find(']')
						.map_or(src.len(), |close| at + close + 1);
				}
				last = at;
				continue;
			}
			at = (at + 2).min(src.len());
			continue;
		}
		if byte == b'{' {
			braces += 1;
		} else if byte == b'}' {
			braces -= 1;
		} else if !rows && byte == b'&' && braces == 0 && environments == 0 {
			result.push(&src[last..at]);
			last = at + 1;
		}
		at += 1;
	}
	result.push(&src[last..]);
	result
}

fn frac_command(name: &str) -> bool {
	matches!(name, "frac" | "dfrac" | "tfrac" | "cfrac")
}

fn binom_command(name: &str) -> bool {
	matches!(name, "binom" | "dbinom" | "tbinom")
}

/// Required-argument count for display commands whose arguments [`read_arg`]
/// and [`braces_owed`] track: nested command atoms consume exactly their own
/// arguments while preserving any outer command's pending arity.
fn command_arity(name: &str) -> Option<usize> {
	if frac_command(name) || binom_command(name) {
		return Some(2);
	}
	if hbrace_spec(name).is_some() {
		return Some(1);
	}
	match name {
		"overset" | "underset" | "stackrel" => Some(2),
		"sqrt" => Some(1),
		_ => None,
	}
}

fn limit_operator(name: &str) -> bool {
	matches!(
		name,
		"sum"
			| "prod"
			| "coprod"
			| "bigcup"
			| "bigcap"
			| "bigsqcup"
			| "bigvee"
			| "bigwedge"
			| "bigoplus"
			| "bigotimes"
			| "bigodot"
			| "biguplus"
			| "lim"
			| "limsup"
			| "liminf"
			| "projlim"
			| "injlim"
			| "varlimsup"
			| "varliminf"
			| "varprojlim"
			| "varinjlim"
			| "max"
			| "min"
			| "sup"
			| "inf"
			| "det"
			| "gcd"
			| "Pr" | "argmax"
			| "argmin"
	)
}

fn integral_operator(name: &str) -> bool {
	matches!(
		name,
		"int"
			| "iint"
			| "iiint"
			| "iiiint"
			| "oint"
			| "oiint"
			| "oiiint"
			| "idotsint"
			| "intop"
			| "smallint"
	)
}

fn display_environment(name: &str) -> bool {
	matches!(
		name,
		"equation"
			| "eqnarray"
			| "align"
			| "aligned"
			| "alignat"
			| "alignedat"
			| "flalign"
			| "split"
			| "gather"
			| "gathered"
			| "gatheredat"
			| "multline"
			| "displaymath"
			| "math"
	)
}

fn grid_delimiters(name: &str) -> Option<(&'static str, &'static str)> {
	Some(match name {
		"matrix" | "smallmatrix" | "array" => ("", ""),
		"pmatrix" => ("(", ")"),
		"bmatrix" => ("[", "]"),
		"Bmatrix" => ("{", "}"),
		"vmatrix" => ("|", "|"),
		"Vmatrix" => ("‖", "‖"),
		"cases" | "dcases" => ("{", ""),
		"rcases" | "drcases" => ("", "}"),
		_ => return None,
	})
}

fn parse_environment(src: &str, start: usize, ctx: Context) -> Option<(MathBox, usize)> {
	let env = read_environment(src, start)?;
	let starred = env.name.ends_with('*');
	let base = env.name.strip_suffix('*').unwrap_or(env.name);
	if let Some((left, right)) = grid_delimiters(base) {
		let mut body_start = skip_spaces(src, env.body_start);
		if starred && src.as_bytes().get(body_start) == Some(&b'[') {
			body_start = src[body_start..]
				.find(']')
				.map_or(env.body_end, |close| skip_spaces(src, body_start + close + 1));
		}
		let mut alignments = Vec::new();
		if base == "array" && src.as_bytes().get(body_start) == Some(&b'{') {
			let spec = read_group(src, body_start);
			for byte in spec.text.bytes() {
				match byte {
					b'l' => alignments.push(CellAlign::Left),
					b'c' => alignments.push(CellAlign::Center),
					b'r' => alignments.push(CellAlign::Right),
					_ => {},
				}
			}
			body_start = spec.end;
		}
		let rows: Vec<Vec<MathBox>> = split_rows(&src[body_start..env.body_end])
			.into_iter()
			.map(str::trim)
			.filter(|row| !row.is_empty())
			.map(|row| {
				split_cells(row)
					.into_iter()
					.map(|cell| parse_expr(cell, ctx))
					.collect()
			})
			.collect();
		let cases = matches!(base, "cases" | "dcases" | "rcases" | "drcases");
		let grid = grid_box(
			rows,
			|column| {
				alignments.get(column).copied().unwrap_or(if cases {
					CellAlign::Left
				} else {
					CellAlign::Center
				})
			},
			|_| 2,
			1,
			ctx.style,
		);
		return Some((delim_box(grid, left, right, ctx.style), env.end));
	}
	if !display_environment(base) {
		return Some((flat_box(&src[start..env.end], ctx), env.end));
	}
	let mut body_start = env.body_start;
	if matches!(base, "alignat" | "alignedat" | "gatheredat") {
		let at = skip_spaces(src, body_start);
		if src.as_bytes().get(at) == Some(&b'{') {
			body_start = read_group(src, at).end;
		}
	}
	let rows: Vec<&str> = split_rows(&src[body_start..env.body_end])
		.into_iter()
		.map(str::trim)
		.filter(|row| !row.is_empty())
		.collect();
	if rows.is_empty() {
		return Some((empty_box(), env.end));
	}
	let cells: Vec<Vec<&str>> = rows.iter().map(|row| split_cells(row)).collect();
	let ncols = cells.iter().map(Vec::len).max().unwrap_or(0);
	if ncols <= 1 {
		let centered = matches!(base, "gather" | "gathered" | "multline");
		return Some((
			vconcat(
				rows.into_iter().map(|row| parse_expr(row, ctx)).collect(),
				if centered {
					CellAlign::Center
				} else {
					CellAlign::Left
				},
				ctx.style,
			),
			env.end,
		));
	}
	let rows = cells
		.into_iter()
		.map(|row| row.into_iter().map(|cell| parse_expr(cell, ctx)).collect())
		.collect();
	Some((
		grid_box(
			rows,
			|column| {
				if column % 2 == 0 {
					CellAlign::Right
				} else {
					CellAlign::Left
				}
			},
			|column| if column % 2 == 1 { 1 } else { 3 },
			0,
			ctx.style,
		),
		env.end,
	))
}

fn read_script(src: &str, start: usize) -> Span<'_> {
	let arg = read_arg(src, start + 1);
	Span { text: &src[start..arg.end], end: arg.end }
}

fn script_arg(text: &str) -> &str {
	let arg = text.get(1..).unwrap_or("").trim_start();
	arg.strip_prefix('{')
		.and_then(|value| value.strip_suffix('}'))
		.unwrap_or(arg)
}

fn script_is_ragged(raw: &str) -> bool {
	let mut count = 0;
	let arg = script_arg(raw);
	let mut at = 0;
	while at < arg.len() {
		if arg.as_bytes()[at] == b'\\' {
			at = command_end(arg, at);
			continue;
		}
		let ch = arg[at..].chars().next().unwrap_or_default();
		if ch.is_ascii_alphabetic() {
			count += 1;
		}
		at += ch.len_utf8();
	}
	count >= 2
}

fn script_flat(raw: &str, ctx: Context) -> Option<MathBox> {
	let rendered = flat_box(raw, ctx);
	let fallback = rendered
		.lines
		.first()
		.and_then(|line| line.first())
		.and_then(|(_, text)| text.chars().next())
		.is_some_and(|first| matches!(first, '^' | '_'));
	(!fallback).then_some(rendered)
}

fn command_name(src: &str, start: usize) -> (&str, usize) {
	let end = command_end(src, start);
	(&src[start + 1..end], end)
}

fn apply_color(ctx: Context, model: Option<&str>, spec: &str) -> Context {
	resolve_latex_color(model, spec)
		.map_or(ctx, |color| Context { style: ctx.style.fg(color), ..ctx })
}

fn apply_background(ctx: Context, model: Option<&str>, spec: &str) -> Context {
	resolve_latex_color(model, spec)
		.map_or(ctx, |color| Context { style: ctx.style.bg(color), ..ctx })
}

fn parse_expr(src: &str, initial: Context) -> MathBox {
	let mut boxes: SmallVec<MathBox, 8> = SmallVec::new();
	let mut inline = StrMut::default();
	let mut ctx = initial;
	let mut at = 0;
	let flush = |inline: &mut StrMut, boxes: &mut SmallVec<MathBox, 8>, ctx: Context| {
		if !inline.is_empty() {
			boxes.push(flat_box(inline.as_str(), ctx));
			*inline = StrMut::default();
		}
	};
	while at < src.len() {
		let byte = src.as_bytes()[at];
		if byte == b'\\' {
			let (name, end_name) = command_name(src, at);
			if frac_command(name) {
				flush(&mut inline, &mut boxes, ctx);
				let num = read_arg(src, end_name);
				let den = read_arg(src, num.end);
				boxes.push(frac_box(parse_expr(num.text, ctx), parse_expr(den.text, ctx), ctx.style));
				at = den.end;
				continue;
			}
			if binom_command(name) {
				flush(&mut inline, &mut boxes, ctx);
				let top = read_arg(src, end_name);
				let bottom = read_arg(src, top.end);
				boxes.push(binom_box(
					parse_expr(top.text, ctx),
					parse_expr(bottom.text, ctx),
					ctx.style,
				));
				at = bottom.end;
				continue;
			}
			if let Some(spec) = hbrace_spec(name) {
				flush(&mut inline, &mut boxes, ctx);
				let arg = read_arg(src, end_name);
				let mut sub = None;
				let mut sup = None;
				let mut next = arg.end;
				loop {
					let marker = skip_spaces(src, next);
					match src.as_bytes().get(marker) {
						Some(b'_') if sub.is_none() => {
							let value = read_arg(src, marker + 1);
							sub = Some(value.text);
							next = value.end;
						},
						Some(b'^') if sup.is_none() => {
							let value = read_arg(src, marker + 1);
							sup = Some(value.text);
							next = value.end;
						},
						_ => break,
					}
				}
				let label = if spec.over { sup } else { sub }.map(|text| parse_expr(text, ctx));
				let other = if spec.over { sub } else { sup }.map(|text| parse_expr(text, ctx));
				let mut item = hbrace_box(parse_expr(arg.text, ctx), spec, label, ctx.style);
				if let Some(other) = other {
					item = attach_scripts(
						item,
						if spec.over { Some(other.clone()) } else { None },
						if spec.over { None } else { Some(other) },
						ctx.style,
					);
				}
				boxes.push(item);
				at = next;
				continue;
			}
			if matches!(name, "overset" | "underset" | "stackrel") {
				flush(&mut inline, &mut boxes, ctx);
				let annotation = read_arg(src, end_name);
				let base = read_arg(src, annotation.end);
				boxes.push(limits_box(
					parse_expr(base.text, ctx),
					(name == "underset").then(|| parse_expr(annotation.text, ctx)),
					(name != "underset").then(|| parse_expr(annotation.text, ctx)),
					ctx.style,
				));
				at = base.end;
				continue;
			}
			if name == "sqrt" {
				let mut next = skip_spaces(src, end_name);
				let mut degree = None;
				if src.as_bytes().get(next) == Some(&b'[') {
					if let Some(close) = src[next..].find(']') {
						degree = Some(&src[next + 1..next + close]);
						next += close + 1;
					} else {
						next = src.len();
					}
				}
				let arg = read_arg(src, next);
				flush(&mut inline, &mut boxes, ctx);
				boxes.push(radical_box(parse_expr(arg.text, ctx), degree, ctx));
				at = arg.end;
				continue;
			}
			if name == "left"
				&& let Some(pair) = read_left_right(src, at)
			{
				let segments: Vec<_> = pair
					.segments
					.iter()
					.map(|segment| parse_expr(segment, ctx))
					.collect();
				let above = segments.iter().map(|item| item.baseline).max().unwrap_or(0);
				let below = segments
					.iter()
					.map(|item| item.lines.len().saturating_sub(item.baseline + 1))
					.max()
					.unwrap_or(0);
				let height = above + below + 1;
				if height == 1 {
					inline.push_str(&src[at..pair.end]);
					at = pair.end;
					continue;
				}
				flush(&mut inline, &mut boxes, ctx);
				let mut parts: SmallVec<MathBox, 8> = SmallVec::new();
				if let Some(column) = delim_column(&delim_key(pair.left, ctx), height, above, ctx.style)
				{
					parts.push(column);
				}
				for (index, segment) in segments.into_iter().enumerate() {
					parts.push(segment);
					if let Some(token) = pair.middles.get(index)
						&& let Some(column) =
							delim_column(&delim_key(token, ctx), height, above, ctx.style)
					{
						parts.push(column);
					}
				}
				if let Some(column) =
					delim_column(&delim_key(pair.right, ctx), height, above, ctx.style)
				{
					parts.push(column);
				}
				boxes.push(hconcat(parts, ctx.style));
				at = pair.end;
				continue;
			}
			if matches!(
				name,
				"big"
					| "Big" | "bigg"
					| "Bigg" | "bigl"
					| "bigr" | "bigm"
					| "Bigl" | "Bigr"
					| "Bigm" | "biggl"
					| "biggr" | "biggm"
					| "Biggl" | "Biggr"
					| "Biggm"
			) && let Some(token) = read_delim_token(src, end_name)
			{
				flush(&mut inline, &mut boxes, ctx);
				let height = if name.starts_with("Bigg") {
					5
				} else if name.starts_with("bigg") {
					4
				} else if name.starts_with("Big") {
					3
				} else {
					2
				};
				if let Some(column) =
					delim_column(&delim_key(token.text, ctx), height, height / 2, ctx.style)
				{
					boxes.push(column);
				}
				at = token.end;
				continue;
			}
			if limit_operator(name) || integral_operator(name) {
				let mut next = skip_spaces(src, end_name);
				let mut stack = limit_operator(name);
				let mut resume = end_name;
				if src[next..].starts_with("\\limits") && command_boundary(src, next + 7) {
					stack = true;
					next += 7;
					resume = next;
				} else if src[next..].starts_with("\\nolimits") && command_boundary(src, next + 9) {
					stack = false;
					resume = next + 9;
				}
				if stack {
					let mut sub = None;
					let mut sup = None;
					let mut cursor = next;
					loop {
						let marker = skip_spaces(src, cursor);
						match src.as_bytes().get(marker) {
							Some(b'_') if sub.is_none() => {
								let value = read_arg(src, marker + 1);
								sub = Some(value.text);
								cursor = value.end;
							},
							Some(b'^') if sup.is_none() => {
								let value = read_arg(src, marker + 1);
								sup = Some(value.text);
								cursor = value.end;
							},
							_ => break,
						}
					}
					if sub.is_some() || sup.is_some() {
						flush(&mut inline, &mut boxes, ctx);
						boxes.push(limits_box(
							flat_box(&src[at..end_name], ctx),
							sub.map(|text| parse_expr(text, ctx)),
							sup.map(|text| parse_expr(text, ctx)),
							ctx.style,
						));
						at = cursor;
						continue;
					}
				}
				inline.push_str(&src[at..end_name]);
				at = resume;
				continue;
			}
			if name == "color" || name == "normalcolor" {
				flush(&mut inline, &mut boxes, ctx);
				if name == "normalcolor" {
					ctx = Context { style: initial.style, ..ctx };
					at = end_name;
					continue;
				}
				let mut next = skip_spaces(src, end_name);
				let mut model = None;
				if src.as_bytes().get(next) == Some(&b'[')
					&& let Some(close) = src[next..].find(']')
				{
					model = Some(&src[next + 1..next + close]);
					next = skip_spaces(src, next + close + 1);
				}
				if src.as_bytes().get(next) == Some(&b'{') {
					let spec = read_group(src, next);
					ctx = apply_color(ctx, model, spec.text);
					at = spec.end;
				} else {
					at = next;
				}
				continue;
			}
			if name == "begin"
				&& let Some((item, end)) = parse_environment(src, at, ctx)
			{
				flush(&mut inline, &mut boxes, ctx);
				boxes.push(item);
				at = end;
				continue;
			}
			if matches!(name, "textcolor" | "colorbox" | "fcolorbox" | "underline" | "cancel" | "sout")
				|| math_font(name).is_some()
				|| terminal_text_style(ctx.style, name).is_some()
			{
				let mut next = skip_spaces(src, end_name);
				let mut child = ctx;
				let mut framed = false;
				if matches!(name, "textcolor" | "colorbox") {
					let mut model = None;
					if src.as_bytes().get(next) == Some(&b'[')
						&& let Some(close) = src[next..].find(']')
					{
						model = Some(&src[next + 1..next + close]);
						next = skip_spaces(src, next + close + 1);
					}
					if src.as_bytes().get(next) != Some(&b'{') {
						inline.push_str(&src[at..end_name]);
						at = end_name;
						continue;
					}
					let spec = read_group(src, next);
					child = if name == "textcolor" {
						apply_color(child, model, spec.text)
					} else {
						apply_background(child, model, spec.text)
					};
					next = skip_spaces(src, spec.end);
				} else if name == "fcolorbox" {
					let mut frame_model = None;
					if src.as_bytes().get(next) == Some(&b'[')
						&& let Some(close) = src[next..].find(']')
					{
						frame_model = Some(&src[next + 1..next + close]);
						next = skip_spaces(src, next + close + 1);
					}
					if src.as_bytes().get(next) != Some(&b'{') {
						inline.push_str(&src[at..end_name]);
						at = end_name;
						continue;
					}
					next = skip_spaces(src, read_group(src, next).end);
					let mut background_model = frame_model;
					if src.as_bytes().get(next) == Some(&b'[')
						&& let Some(close) = src[next..].find(']')
					{
						background_model = Some(&src[next + 1..next + close]);
						next = skip_spaces(src, next + close + 1);
					}
					if src.as_bytes().get(next) != Some(&b'{') {
						inline.push_str(&src[at..end_name]);
						at = end_name;
						continue;
					}
					let background = read_group(src, next);
					child = apply_background(child, background_model, background.text);
					next = skip_spaces(src, background.end);
					framed = true;
				} else if name == "underline" {
					child.style = child.style.underline();
				} else if matches!(name, "cancel" | "sout") {
					child.style = child.style.strikethrough();
				} else if let Some(style) = terminal_text_style(child.style, name) {
					child.style = style;
				} else {
					child.font = math_font(name);
				}
				if src.as_bytes().get(next) == Some(&b'{') {
					let content = read_group(src, next);
					flush(&mut inline, &mut boxes, ctx);
					let item = parse_expr(content.text, child);
					boxes.push(if framed {
						delim_box(item, "[", "]", ctx.style)
					} else {
						item
					});
					at = content.end;
					continue;
				}
			}
			if name.is_empty() {
				let end = (at + 2).min(src.len());
				inline.push_str(&src[at..end]);
				at = end;
				continue;
			}
			inline.push_str(&src[at..end_name]);
			at = end_name;
			while matches!(src.as_bytes().get(at), Some(b'[' | b'{')) {
				let end = if src.as_bytes()[at] == b'{' {
					read_group(src, at).end
				} else {
					src[at..]
						.find(']')
						.map_or(src.len(), |close| at + close + 1)
				};
				inline.push_str(&src[at..end]);
				at = end;
			}
			continue;
		}
		if matches!(byte, b'^' | b'_') {
			let first = read_script(src, at);
			let marker = skip_spaces(src, first.end);
			let second = src
				.as_bytes()
				.get(marker)
				.filter(|&&other| other == if byte == b'^' { b'_' } else { b'^' })
				.map(|_| read_script(src, marker));
			let end = second.map_or(first.end, |span| span.end);
			let sup_raw = if byte == b'^' {
				Some(first.text)
			} else {
				second.map(|span| span.text)
			};
			let sub_raw = if byte == b'_' {
				Some(first.text)
			} else {
				second.map(|span| span.text)
			};
			let sup_box = sup_raw.map(|raw| parse_expr(script_arg(raw), ctx));
			let sub_box = sub_raw.map(|raw| parse_expr(script_arg(raw), ctx));
			let tall = sup_box.as_ref().is_some_and(|item| item.lines.len() > 1)
				|| sub_box.as_ref().is_some_and(|item| item.lines.len() > 1);
			let convertible = sup_raw.is_none_or(|raw| script_flat(raw, ctx).is_some())
				&& sub_raw.is_none_or(|raw| script_flat(raw, ctx).is_some());
			let ragged =
				sup_raw.is_some_and(script_is_ragged) || sub_raw.is_some_and(script_is_ragged);
			if tall || !convertible || ragged {
				flush(&mut inline, &mut boxes, ctx);
				let base = boxes.pop().unwrap_or_else(empty_box);
				boxes.push(attach_scripts(base, sub_box, sup_box, ctx.style));
				at = end;
				continue;
			}
			if inline.is_empty() && boxes.last().is_some_and(|item| item.lines.len() > 1) {
				let base = boxes.pop().unwrap_or_else(empty_box);
				boxes.push(attach_scripts(
					base,
					sub_raw.and_then(|raw| script_flat(raw, ctx)),
					sup_raw.and_then(|raw| script_flat(raw, ctx)),
					ctx.style,
				));
				at = end;
				continue;
			}
			inline.push_str(&src[at..end]);
			at = end;
			continue;
		}
		if byte == b'{' {
			let group = read_group(src, at);
			flush(&mut inline, &mut boxes, ctx);
			boxes.push(parse_expr(group.text, ctx));
			at = group.end;
			continue;
		}
		if matches!(byte, b'(' | b'[') {
			let close = if byte == b'(' { b')' } else { b']' };
			if let Some(end) = match_delim(src, at, byte, close) {
				let inner = parse_expr(&src[at + 1..end], ctx);
				if inner.lines.len() > 1 {
					flush(&mut inline, &mut boxes, ctx);
					boxes.push(delim_box(
						inner,
						if byte == b'(' { "(" } else { "[" },
						if close == b')' { ")" } else { "]" },
						ctx.style,
					));
					at = end + 1;
					continue;
				}
			}
		}
		let ch = src[at..].chars().next().unwrap_or_default();
		inline.push(ch);
		at += ch.len_utf8();
	}
	flush(&mut inline, &mut boxes, ctx);
	if boxes.is_empty() {
		empty_box()
	} else {
		hconcat(boxes, ctx.style)
	}
}

/// Counts the `{…}` arguments still owed at the end of `seg` — non-zero when
/// the row ends mid-construct (`\frac{a}` awaiting its denominator, or
/// `\frac`/`x^` awaiting any argument). Pending arities form a stack: an
/// unbraced nested command consumes one outer argument, then retains its own
/// pending arguments without discarding the outer command's remaining arity.
fn braces_owed(seg: &str) -> usize {
	let mut pending: SmallVec<usize, 4> = SmallVec::new();
	fn consume_arg(pending: &mut SmallVec<usize, 4>) {
		if let Some(top) = pending.last_mut() {
			if *top == 1 {
				pending.pop();
			} else {
				*top -= 1;
			}
		}
	}
	let mut at = 0;
	while at < seg.len() {
		let byte = seg.as_bytes()[at];
		if byte == b'\\' {
			let after_name = command_end(seg, at);
			let name = &seg[at + 1..after_name];
			// a command plus its immediately attached `[…]`/`{…}` groups is
			// one atom for an enclosing argument, matching read_arg: consume
			// that outer argument first, then retain only the command's own
			// missing arguments in a nested frame
			consume_arg(&mut pending);
			let named = name.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
			let arity = if named {
				command_arity(name).unwrap_or(0)
			} else {
				0
			};
			let mut end = if named {
				after_name
			} else {
				(at + 2).min(seg.len())
			};
			let mut attached = 0;
			if named {
				while matches!(seg.as_bytes().get(end), Some(b'[' | b'{')) {
					if seg.as_bytes()[end] == b'{' {
						end = read_group(seg, end).end;
						if attached < arity {
							attached += 1;
						}
					} else {
						end = seg[end..]
							.find(']')
							.map_or(seg.len(), |close| end + close + 1);
					}
				}
			}
			if arity > attached {
				pending.push(arity - attached);
			}
			at = end;
			continue;
		}
		if byte == b'{' {
			at = read_group(seg, at).end;
			consume_arg(&mut pending);
			continue;
		}
		if byte == b'^' || byte == b'_' {
			pending.push(1);
			at += 1;
			continue;
		}
		if matches!(byte, b' ' | b'\t' | b'\n') {
			at += 1;
			continue;
		}
		// a bare atom satisfies one pending argument
		consume_arg(&mut pending);
		at += seg[at..].chars().next().map_or(1, char::len_utf8);
	}
	pending.iter().sum()
}

/// Splits on top-level `\n` and `\\` row separators (outside braces and
/// environments).
fn split_lines(src: &str) -> Vec<&str> {
	let mut lines = Vec::new();
	let mut braces = 0_isize;
	let mut environments = 0_isize;
	let mut last = 0;
	let mut at = 0;
	while at < src.len() {
		if src[at..].starts_with("\\begin") {
			environments += 1;
			at += 6;
			continue;
		}
		if src[at..].starts_with("\\end") {
			environments -= 1;
			at += 4;
			continue;
		}
		let byte = src.as_bytes()[at];
		if byte == b'\\' {
			if src.as_bytes().get(at + 1) == Some(&b'\\') && braces == 0 && environments == 0 {
				lines.push(&src[last..at]);
				at = skip_spaces(src, at + 2);
				if src.as_bytes().get(at) == Some(&b'[') {
					at = src[at..]
						.find(']')
						.map_or(src.len(), |close| at + close + 1);
				}
				last = at;
				continue;
			}
			at = (at + 2).min(src.len());
			continue;
		}
		if byte == b'{' {
			braces += 1;
		} else if byte == b'}' {
			braces -= 1;
		} else if byte == b'\n' && braces == 0 && environments == 0 {
			// a top-level newline is a row break UNLESS the current row ends
			// with a command still awaiting a brace argument that the next
			// row opens (`\frac{num}\n{den}`, `x^\n{2}`): splitting there
			// would sever the command from its argument. A row that merely
			// opens with a braced group (`a\n{b+c}`) stays a break.
			let next = skip_spaces(src, at + 1);
			if src.as_bytes().get(next) != Some(&b'{') || braces_owed(&src[last..at]) == 0 {
				lines.push(&src[last..at]);
				last = at + 1;
			}
		}
		at += 1;
	}
	lines.push(&src[last..]);
	lines
}

/// Lays out display LaTeX as baseline-aligned terminal rows.
pub fn latex_block(expr: &str, base: Style, sink: &mut dyn RichSink) -> bool {
	let expr = expr.trim();
	if expr.is_empty() {
		return false;
	}
	let rows: Vec<_> = split_lines(expr)
		.into_iter()
		.map(collapse_interior_whitespace)
		.filter(|row| !row.is_empty())
		.map(|row| parse_expr(row.as_ref(), Context { style: base, font: None }))
		.collect();
	if rows.is_empty() {
		return false;
	}
	let mut lines = vconcat(rows, CellAlign::Left, base).lines;
	while lines.len() > 1
		&& lines
			.last()
			.is_some_and(|line| line.iter().all(|(_, text)| text.trim().is_empty()))
	{
		lines.pop();
	}
	while lines.len() > 1
		&& lines
			.first()
			.is_some_and(|line| line.iter().all(|(_, text)| text.trim().is_empty()))
	{
		lines.remove(0);
	}
	for (row, line) in lines.iter().enumerate() {
		if row > 0 {
			sink.newline();
		}
		for (style, text) in line {
			let mut parts = text.split("\n");
			if let Some(first) = parts.next()
				&& !first.is_empty()
			{
				sink.run(*style, &first);
			}
			for part in parts {
				sink.newline();
				if !part.is_empty() {
					sink.run(*style, &part);
				}
			}
		}
	}
	true
}

/// Trims a row and collapses whitespace using the global
/// `[ \t]*\n[ \t]*` → `" "` replacement: each newline (with its surrounding
/// spaces/tabs) becomes one space, so `a\n\nb` keeps two spaces.
fn collapse_interior_whitespace(row: &str) -> borrow::Cow<'_, str> {
	let row = row.trim();
	if !row.contains('\n') {
		return borrow::Cow::Borrowed(row);
	}
	let mut collapsed = String::with_capacity(row.len());
	let mut run_start: Option<usize> = None;
	for (offset, ch) in row.char_indices() {
		if matches!(ch, ' ' | '\t' | '\n') {
			run_start.get_or_insert(offset);
			continue;
		}
		if let Some(start) = run_start.take() {
			let run = &row[start..offset];
			match run.bytes().filter(|byte| *byte == b'\n').count() {
				0 => collapsed.push_str(run),
				newlines => {
					for _ in 0..newlines {
						collapsed.push(' ');
					}
				},
			}
		}
		collapsed.push(ch);
	}
	borrow::Cow::Owned(collapsed)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn plain(expr: &str) -> Vec<String> {
		let mut rich = RichText::default();
		if !latex_block(expr, Style::new(), &mut rich) {
			return Vec::new();
		}
		(0..rich.rows())
			.map(|row| rich.row_text(row).to_owned())
			.collect()
	}
	#[test]
	fn interior_newline_runs_collapse_one_space_per_newline() {
		// `[ \t]*\n[ \t]*` → " " replaces each newline match
		// independently, so a blank line inside a group keeps two spaces
		assert_eq!(plain("\\text{a\n\nb}"), ["a  b"]);
		assert_eq!(plain("\\text{a \n b}"), ["a b"]);
	}

	fn trimmed(expr: &str) -> Vec<String> {
		plain(expr)
			.into_iter()
			.map(|line| line.trim_end().to_owned())
			.collect()
	}

	#[test]
	fn nested_fractions() {
		assert_eq!(plain("\\frac{\\frac{a}{b}}{c}"), ["  a  ", " ─── ", "  b  ", "─────", "  c  "]);
	}

	#[test]
	fn text_mode_style_spans_stacked_fraction_rows() {
		let mut rich = RichText::default();
		assert!(latex_block(r"\textbf{\frac{a}{b}}", Style::new(), &mut rich));
		assert_eq!(
			(0..rich.rows())
				.map(|row| rich.row_text(row))
				.collect::<Vec<_>>(),
			[" a ", "───", " b "],
		);
		for row in [0, 2] {
			assert!(
				rich
					.row_runs(row)
					.filter(|(_, text)| !text.trim().is_empty())
					.all(|(style, _)| style.spec().bold),
			);
		}
	}

	#[test]
	fn nested_command_arguments_share_arity_across_whitespace() {
		// A nested command consumes exactly its own arity —
		// adjacent, spaced, and source-line-split forms all parse alike
		let sqrt_fraction = ["  ┌── ", " ╲│ a ", "──────", "  b   "];
		assert_eq!(plain(r"\frac\sqrt{a}{b}"), sqrt_fraction);
		assert_eq!(plain(r"\frac\sqrt {a} {b}"), sqrt_fraction);
		assert_eq!(plain("\\frac\\sqrt\n{a}\n{b}"), sqrt_fraction);
		let stacked = ["  a  ", " ─── ", "  b  ", "─────", "  c  "];
		assert_eq!(plain("\\frac\\frac{a}{b}\n{c}"), stacked);
		assert_eq!(plain("\\frac\\frac\n{a}\n{b}\n{c}"), stacked);
		assert_eq!(plain("\\frac\\hat{a}\n{b}"), [" a\u{302} ", "───", " b "]);
		// a row that merely opens with a braced group stays a real row break
		assert_eq!(plain("a\n{b+c}").len(), 2);
	}

	#[test]
	fn matrices_and_array_alignment() {
		assert_eq!(plain("\\begin{bmatrix} a & b \\\\ c & d \\end{bmatrix}"), [
			"⎡ a  b ⎤",
			"⎢      ⎥",
			"⎣ c  d ⎦"
		]);
		assert_eq!(trimmed("\\begin{array}{lcr} 1 & 22 & 333 \\\\ aaa & b & c \\end{array}"), [
			"1    22  333",
			"",
			"aaa  b     c"
		]);
	}

	#[test]
	fn cases_and_aligned_rows() {
		assert_eq!(
			trimmed("f(x) = \\begin{cases} x & x > 0 \\\\ 0 & \\text{otherwise} \\end{cases}"),
			["       ⎧ x  x > 0", "f(x) = ⎨", "       ⎩ 0  otherwise"]
		);
		assert_eq!(
			trimmed("\\begin{align} f(x) &= x^2 + 1 \\\\ g(x) &= \\frac{x}{2} \\end{align}"),
			["f(x) = x² + 1", "        x", "g(x) = ───", "        2"]
		);
	}

	#[test]
	fn radicals_match_roof_shape() {
		assert_eq!(trimmed("\\sqrt{\\frac{a+1}{b}}"), [" ┌──────", " │  a+1", " │ ─────", "╲│   b"]);
		assert_eq!(trimmed("\\sqrt{x}"), [" ┌──", "╲│ x"]);
	}

	#[test]
	fn limits_and_integrals() {
		assert_eq!(plain("\\sum_{i=0}^{n} i^2"), [" n    ", " ∑  i²", "i=0   "]);
		let lim = plain("\\lim_{x \\to 0} \\frac{\\sin x}{x}");
		assert!(lim[1].contains("lim"));
		assert!(lim[1].contains("───"));
		assert!(lim[2].contains("x → 0"));
		assert_eq!(plain("\\int_a^b f(x) dx"), ["∫ₐᵇ f(x) dx"]);
		assert_eq!(trimmed("\\int\\limits_a^b f(x) dx"), ["b", "∫ f(x) dx", "a"]);
	}

	#[test]
	fn stretchy_delimiters_and_corner_scripts() {
		assert_eq!(trimmed("\\left( \\frac{a+b}{c} \\right)^2"), [
			"⎛  a+b  ⎞²",
			"⎜ ───── ⎟",
			"⎝   c   ⎠"
		]);
	}

	#[test]
	fn labeled_underbrace() {
		assert_eq!(trimmed("x + \\underbrace{a+b}_{\\text{sum}}"), ["x + a+b", "    ╰┬╯", "    sum"]);
	}
}
