//! ANSI-aware text measurement and slicing utilities.
//!
//! Optimized for JS string interop (UTF-16).
//! - Single-pass ANSI scanning (no O(n²) `next_ansi` rescans)
//! - ASCII fast-path (no grapheme segmentation, no UTF-8 conversion)
//! - Non-ASCII uses a reused scratch String for grapheme segmentation
//! - Width checks early-exit
//! - Ellipsis decoded lazily
//! - truncateToWidth returns the original `JsString` when possible

use std::{
	cell::RefCell,
	sync::atomic::{AtomicU8, Ordering},
};

use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use smallvec::{SmallVec, smallvec};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

const MIN_TAB_WIDTH: u32 = 1;
const MAX_TAB_WIDTH: u32 = 16;
pub const DEFAULT_TAB_WIDTH: usize = 3;
const ESC: u16 = 0x1b;

#[inline]
fn clamp_tab_width_for_ops(width: u32) -> usize {
	width.clamp(MIN_TAB_WIDTH, MAX_TAB_WIDTH) as usize
}

/// Ellipsis strategy for [`truncate_to_width`].
#[napi]
pub enum Ellipsis {
	/// Use a single Unicode ellipsis character ("…").
	Unicode = 0,
	/// Use three ASCII dots ("...").
	Ascii   = 1,
	/// Omit ellipsis entirely.
	Omit    = 2,
}

fn build_utf16_string(mut data: Vec<u16>) -> Utf16String {
	while data.last() == Some(&0) {
		data.pop();
	}
	// SAFETY: we know Utf16String == struct(Vec<u16>)
	unsafe { std::mem::transmute(data) }
}

// ============================================================================
// Results
// ============================================================================

/// Visible slice of a line after ANSI-aware column selection
/// (`sliceWithWidth`).
#[napi(object)]
pub struct SliceResult {
	/// UTF-16 slice containing the selected text.
	pub text:  Utf16String,
	/// Visible width of the slice in terminal cells.
	pub width: u32,
}

/// Before/after UTF-16 segments around an overlay region, with measured widths.
#[napi(object)]
pub struct ExtractSegmentsResult {
	/// UTF-16 content before the overlay region.
	pub before:       Utf16String,
	/// Visible width of the `before` segment.
	pub before_width: u32,
	/// UTF-16 content after the overlay region.
	pub after:        Utf16String,
	/// Visible width of the `after` segment.
	pub after_width:  u32,
}

// ============================================================================
// ANSI State Tracking - Zero Allocation
// ============================================================================

const ATTR_BOLD: u16 = 1 << 0;
const ATTR_DIM: u16 = 1 << 1;
const ATTR_ITALIC: u16 = 1 << 2;
const ATTR_UNDERLINE: u16 = 1 << 3;
const ATTR_BLINK: u16 = 1 << 4;
const ATTR_INVERSE: u16 = 1 << 6;
const ATTR_HIDDEN: u16 = 1 << 7;
const ATTR_STRIKE: u16 = 1 << 8;

type ColorVal = u32;
const COLOR_NONE: ColorVal = 0;

#[derive(Clone, Copy, Default)]
struct AnsiState {
	attrs: u16,
	fg:    ColorVal,
	bg:    ColorVal,
}

impl AnsiState {
	#[inline]
	const fn new() -> Self {
		Self { attrs: 0, fg: COLOR_NONE, bg: COLOR_NONE }
	}

	#[inline]
	const fn is_empty(&self) -> bool {
		self.attrs == 0 && self.fg == COLOR_NONE && self.bg == COLOR_NONE
	}

	#[inline]
	const fn reset(&mut self) {
		*self = Self::new();
	}

	fn apply_sgr_u16(&mut self, params: &[u16]) {
		if params.is_empty() {
			self.reset();
			return;
		}

		let mut i = 0;
		while i < params.len() {
			let (code, next_i) = parse_sgr_num_u16(params, i);
			i = next_i;

			match code {
				0 => self.reset(),
				1 => self.attrs |= ATTR_BOLD,
				2 => self.attrs |= ATTR_DIM,
				3 => self.attrs |= ATTR_ITALIC,
				4 => self.attrs |= ATTR_UNDERLINE,
				5 => self.attrs |= ATTR_BLINK,
				7 => self.attrs |= ATTR_INVERSE,
				8 => self.attrs |= ATTR_HIDDEN,
				9 => self.attrs |= ATTR_STRIKE,

				21 => self.attrs &= !ATTR_BOLD,
				22 => self.attrs &= !(ATTR_BOLD | ATTR_DIM),
				23 => self.attrs &= !ATTR_ITALIC,
				24 => self.attrs &= !ATTR_UNDERLINE,
				25 => self.attrs &= !ATTR_BLINK,
				27 => self.attrs &= !ATTR_INVERSE,
				28 => self.attrs &= !ATTR_HIDDEN,
				29 => self.attrs &= !ATTR_STRIKE,

				30..=37 => self.fg = (code - 29) as ColorVal,
				39 => self.fg = COLOR_NONE,
				40..=47 => self.bg = (code - 39) as ColorVal,
				49 => self.bg = COLOR_NONE,
				90..=97 => self.fg = (code - 81) as ColorVal,
				100..=107 => self.bg = (code - 91) as ColorVal,

				38 | 48 => {
					let (mode, ni) = parse_sgr_num_u16(params, i);
					i = ni;

					let color = match mode {
						5 => {
							let (idx, ni) = parse_sgr_num_u16(params, i);
							i = ni;
							0x100 | (idx as ColorVal & 0xff)
						},
						2 => {
							let (r, ni) = parse_sgr_num_u16(params, i);
							let (g, ni) = parse_sgr_num_u16(params, ni);
							let (b, ni) = parse_sgr_num_u16(params, ni);
							i = ni;
							0x1000000
								| ((r as ColorVal & 0xff) << 16)
								| ((g as ColorVal & 0xff) << 8)
								| (b as ColorVal & 0xff)
						},
						_ => continue,
					};

					if code == 38 {
						self.fg = color;
					} else {
						self.bg = color;
					}
				},

				_ => {},
			}
		}
	}

	fn write_restore_u16(&self, out: &mut Vec<u16>) {
		if self.is_empty() {
			return;
		}

		out.extend_from_slice(&[ESC, b'[' as u16]);
		let mut first = true;

		macro_rules! push_code {
			($code:expr) => {{
				if !first {
					out.push(b';' as u16);
				}
				first = false;
				write_u32_u16(out, $code);
			}};
		}

		if self.attrs & ATTR_BOLD != 0 {
			push_code!(1);
		}
		if self.attrs & ATTR_DIM != 0 {
			push_code!(2);
		}
		if self.attrs & ATTR_ITALIC != 0 {
			push_code!(3);
		}
		if self.attrs & ATTR_UNDERLINE != 0 {
			push_code!(4);
		}
		if self.attrs & ATTR_BLINK != 0 {
			push_code!(5);
		}
		if self.attrs & ATTR_INVERSE != 0 {
			push_code!(7);
		}
		if self.attrs & ATTR_HIDDEN != 0 {
			push_code!(8);
		}
		if self.attrs & ATTR_STRIKE != 0 {
			push_code!(9);
		}

		write_color_u16(out, self.fg, 38, &mut first);
		write_color_u16(out, self.bg, 48, &mut first);

		out.push(b'm' as u16);
	}
}

#[inline]
fn write_color_u16(out: &mut Vec<u16>, color: ColorVal, base: u32, first: &mut bool) {
	if color == COLOR_NONE {
		return;
	}

	if !*first {
		out.push(b';' as u16);
	}
	*first = false;

	if color < 0x100 {
		let code = if color <= 8 { color + 29 } else { color + 81 };
		let code = if base == 48 { code + 10 } else { code };
		write_u32_u16(out, code);
	} else if color < 0x1000000 {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'5' as u16, b';' as u16]);
		write_u32_u16(out, color & 0xff);
	} else {
		write_u32_u16(out, base);
		out.extend_from_slice(&[b';' as u16, b'2' as u16, b';' as u16]);
		write_u32_u16(out, (color >> 16) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, (color >> 8) & 0xff);
		out.push(b';' as u16);
		write_u32_u16(out, color & 0xff);
	}
}

#[inline]
fn parse_sgr_num_u16(params: &[u16], mut i: usize) -> (u32, usize) {
	while i < params.len() && params[i] == b';' as u16 {
		i += 1;
	}

	let mut val: u32 = 0;
	while i < params.len() {
		let b = params[i];
		if b == b';' as u16 {
			i += 1;
			break;
		}
		if (b'0' as u16..=b'9' as u16).contains(&b) {
			val = val
				.saturating_mul(10)
				.saturating_add((b - b'0' as u16) as u32);
		}
		i += 1;
	}
	(val, i)
}

#[inline]
fn write_u32_u16(out: &mut Vec<u16>, mut val: u32) {
	if val == 0 {
		out.push(b'0' as u16);
		return;
	}
	let start = out.len();
	while val > 0 {
		out.push(b'0' as u16 + (val % 10) as u16);
		val /= 10;
	}
	out[start..].reverse();
}

// ============================================================================
// ANSI Sequence Detection - UTF-16
// ============================================================================

#[inline]
fn ansi_seq_len_u16(data: &[u16], pos: usize) -> Option<usize> {
	if pos >= data.len() || data[pos] != ESC {
		return None;
	}
	if pos + 1 >= data.len() {
		return None;
	}

	match data[pos + 1] {
		0x5b => {
			// '[' CSI
			for (i, b) in data[pos + 2..].iter().enumerate() {
				if (0x40..=0x7e).contains(b) {
					return Some(i + 3);
				}
			}
			None
		},
		0x5d => {
			// ']' OSC
			for (i, &b) in data[pos + 2..].iter().enumerate() {
				if b == 0x07 {
					return Some(i + 3);
				}
				if b == ESC && data.get(pos + 2 + i + 1) == Some(&0x5c) {
					return Some(i + 4);
				}
			}
			None
		},
		0x50 | 0x58 | 0x5e | 0x5f => {
			// 'P' DCS, 'X' SOS, '^' PM, '_' APC — string sequences terminated by ST
			// (`ESC \`) or, as most terminals also accept (like OSC), BEL. The TUI's
			// cursor marker is a BEL-terminated APC, so BEL must close these too.
			for (i, &b) in data[pos + 2..].iter().enumerate() {
				if b == 0x07 {
					return Some(i + 3);
				}
				if b == ESC && data.get(pos + 2 + i + 1) == Some(&0x5c) {
					return Some(i + 4);
				}
			}
			None
		},
		0x20..=0x2f => {
			// ESC + intermediates + final byte
			for (i, b) in data[pos + 2..].iter().enumerate() {
				if (0x30..=0x7e).contains(b) {
					return Some(i + 3);
				}
			}
			None
		},
		0x40..=0x7e => Some(2),
		_ => None,
	}
}

#[inline]
fn is_sgr_u16(seq: &[u16]) -> bool {
	seq.len() >= 3 && seq[1] == b'[' as u16 && *seq.last().unwrap() == b'm' as u16
}

struct Osc66Info<'a> {
	payload: &'a [u16],
	scale:   usize,
	width:   usize,
}

#[inline]
fn parse_ascii_usize_u16(data: &[u16]) -> Option<usize> {
	if data.is_empty() {
		return None;
	}

	let mut value = 0usize;
	for &u in data {
		if !(b'0' as u16..=b'9' as u16).contains(&u) {
			return None;
		}
		value = value
			.saturating_mul(10)
			.saturating_add((u - b'0' as u16) as usize);
	}
	Some(value)
}

#[inline]
fn osc66_meta_payload_u16(seq: &[u16]) -> Option<(&[u16], &[u16])> {
	if seq.len() < 7
		|| seq[0] != ESC
		|| seq[1] != b']' as u16
		|| seq[2] != b'6' as u16
		|| seq[3] != b'6' as u16
		|| seq[4] != b';' as u16
	{
		return None;
	}

	let payload_end = if *seq.last()? == 0x07 {
		seq.len() - 1
	} else if seq.len() >= 8 && seq[seq.len() - 2] == ESC && seq[seq.len() - 1] == b'\\' as u16 {
		seq.len() - 2
	} else {
		return None;
	};

	let mut sep = 5usize;
	while sep < payload_end {
		if seq[sep] == b';' as u16 {
			return Some((&seq[5..sep], &seq[sep + 1..payload_end]));
		}
		sep += 1;
	}

	None
}

#[inline]
fn parse_osc66_meta_u16(meta: &[u16]) -> (usize, Option<usize>) {
	let mut scale = 1usize;
	let mut explicit_width = None;
	let mut part_start = 0usize;
	let mut i = 0usize;

	while i <= meta.len() {
		if i == meta.len() || meta[i] == b':' as u16 {
			let part = &meta[part_start..i];
			if let Some(eq) = part.iter().position(|&u| u == b'=' as u16) {
				let key = &part[..eq];
				let value = &part[eq + 1..];
				if key.len() == 1 {
					match key[0] {
						0x73 => {
							if let Some(parsed) = parse_ascii_usize_u16(value)
								&& (1..=7).contains(&parsed)
							{
								scale = parsed;
							}
						},
						0x77 => {
							if let Some(parsed) = parse_ascii_usize_u16(value) {
								explicit_width = Some(parsed);
							}
						},
						_ => {},
					}
				}
			}
			part_start = i + 1;
		}
		i += 1;
	}

	(scale, explicit_width.filter(|&width| width > 0))
}

#[inline]
fn osc66_info_u16(seq: &[u16], tab_width: usize) -> Option<Osc66Info<'_>> {
	let (meta, payload) = osc66_meta_payload_u16(seq)?;
	let (scale, explicit_width) = parse_osc66_meta_u16(meta);
	let base_width = explicit_width.unwrap_or_else(|| visible_width_u16(payload, tab_width));
	Some(Osc66Info { payload, scale, width: scale.saturating_mul(base_width) })
}

#[inline]
fn osc66_visible_width_u16(seq: &[u16], tab_width: usize) -> Option<usize> {
	Some(osc66_info_u16(seq, tab_width)?.width)
}

#[inline]
const fn div_ceil_usize(n: usize, d: usize) -> usize {
	if n == 0 { 0 } else { 1 + (n - 1) / d }
}

#[inline]
const fn osc66_payload_range(
	visual_start: usize,
	visual_len: usize,
	scale: usize,
	strict: bool,
) -> (usize, usize) {
	let visual_end = visual_start.saturating_add(visual_len);
	let payload_start = if strict {
		div_ceil_usize(visual_start, scale)
	} else {
		visual_start / scale
	};
	let payload_end = if strict {
		visual_end / scale
	} else {
		div_ceil_usize(visual_end, scale)
	};
	(payload_start, payload_end.saturating_sub(payload_start))
}

#[inline]
const fn is_ascii_grapheme_extender_u16(u: u16) -> bool {
	matches!(
		u,
		0x0300..=0x036f
			| 0x1ab0..=0x1aff
			| 0x1dc0..=0x1dff
			| 0x200d
			| 0x20d0..=0x20ff
			| 0xfe00..=0xfe0f
	)
}

// ============================================================================
// Grapheme / Width
// ============================================================================

#[inline]
const fn ascii_cell_width_u16(u: u16, tab_width: usize) -> usize {
	let b = u as u8;
	match b {
		b'\t' => tab_width,
		0x20..=0x7e => 1,
		_ => 0,
	}
}

const HANGUL_COMPAT_JAMO_NARROW_WIDTH: usize = 1;

/// Runtime override for Hangul Compatibility Jamo (U+3131..=U+318E) cell width.
///   0 = unset → platform default (macOS: narrow 1 cell; otherwise UAX#11)
///   1 = force narrow (1 cell)
///   2 = force wide (2 cells)
///   3 = force Unicode width (no correction)
/// The actual width is decided by the *client* terminal, not the host OS, so it
/// is resolved at runtime from the terminal identity (see packages/tui
/// terminal.ts) and pushed here through
/// `set_hangul_compat_jamo_width_override`.
static HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE: AtomicU8 = AtomicU8::new(0);

#[napi]
pub fn set_hangul_compat_jamo_width_override(value: u8) {
	HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE.store(value, Ordering::Relaxed);
}

#[inline]
const fn is_hangul_compat_jamo(c: char) -> bool {
	let cp = c as u32;
	cp >= 0x3131 && cp <= 0x318e
}

/// Effective target cell width for Compatibility Jamo, or `None` to follow the
/// Unicode width (no correction). Reads the runtime override, falling back to
/// the compile-time platform default when unset.
#[inline]
fn hangul_compat_jamo_target_width() -> Option<usize> {
	match HANGUL_COMPAT_JAMO_WIDTH_OVERRIDE.load(Ordering::Relaxed) {
		1 => Some(1),
		2 => Some(2),
		3 => None,
		_ => {
			if cfg!(target_os = "macos") {
				Some(HANGUL_COMPAT_JAMO_NARROW_WIDTH)
			} else {
				None
			}
		},
	}
}

#[inline]
fn apply_hangul_compat_jamo_delta(width: usize, c: char) -> usize {
	if !is_hangul_compat_jamo(c) {
		return width;
	}
	let Some(target) = hangul_compat_jamo_target_width() else {
		return width;
	};
	let unicode_width = UnicodeWidthChar::width(c).unwrap_or(0);
	// The zero-width filler (U+3164 HANGUL FILLER) is an invisible placeholder.
	// The target is set for *visible* jamo, so only the narrow correction
	// (target 1) applies to the filler; a wide terminal renders it at its
	// Unicode width (0), not the wide target. Never widen a
	// zero-width jamo past the narrow correction.
	if unicode_width == 0 && target > 1 {
		return width;
	}
	if unicode_width > target {
		width.saturating_sub(unicode_width - target)
	} else {
		width.saturating_add(target - unicode_width)
	}
}

#[inline]
fn char_width_corrected(c: char) -> Option<usize> {
	// Hangul Compatibility Jamo U+3131..=U+318E render as 1 cell on some
	// terminals (Terminal.app, iTerm2) but follow UAX#11 at 2 cells on others
	// (Ghostty, most Linux terminals). The width is resolved at runtime from the
	// terminal identity and applied through the override; absent an override we
	// fall back to the compile-time platform default.
	if is_hangul_compat_jamo(c)
		&& let Some(target) = hangul_compat_jamo_target_width()
	{
		// Zero-width filler (U+3164): only the narrow correction applies — a
		// wide terminal renders it at its Unicode width (0), not the effective
		// wide target set for visible jamo. See apply_hangul_compat_jamo_delta.
		let unicode_width = UnicodeWidthChar::width(c).unwrap_or(0);
		if unicode_width == 0 && target > 1 {
			return Some(unicode_width);
		}
		return Some(target);
	}
	UnicodeWidthChar::width(c)
}

#[inline]
fn grapheme_width_str(g: &str, tab_width: usize) -> usize {
	if g == "\t" {
		return tab_width;
	}
	let mut it = g.chars();
	let Some(c0) = it.next() else {
		return 0;
	};
	if it.next().is_none() {
		return char_width_corrected(c0).unwrap_or(0);
	}
	// Multi-char grapheme: keep UnicodeWidthStr as the source of truth for
	// sequence-level width rules (VS16 emoji presentation, keycaps, ZWJ emoji,
	// CRLF, script ligatures). A per-char sum is not equivalent. Apply only the
	// same local Compatibility Jamo delta that char_width_corrected applies to
	// standalone code points; the delta is a no-op when no correction is active.
	let mut width = UnicodeWidthStr::width(g);
	for c in g.chars() {
		width = apply_hangul_compat_jamo_delta(width, c);
	}
	width
}

thread_local! {
  static SCRATCH: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Iterate graphemes in a non-ASCII UTF-16 segment.
///
/// Callback returns `true` to continue, `false` to stop early.
#[inline]
fn for_each_grapheme_u16_slow<F>(segment: &[u16], tab_width: usize, mut f: F) -> bool
where
	F: FnMut(&[u16], usize) -> bool,
{
	if segment.is_empty() {
		return true;
	}

	SCRATCH.with_borrow_mut(|scratch| {
		scratch.clear();
		scratch.reserve(segment.len());

		for r in std::char::decode_utf16(segment.iter().copied()) {
			scratch.push(r.unwrap_or('\u{FFFD}'));
		}

		let mut utf16_pos = 0usize;
		for g in scratch.graphemes(true) {
			let w = grapheme_width_str(g, tab_width);

			let g_u16_len: usize = g.chars().map(|c| c.len_utf16()).sum();
			let u16_slice = &segment[utf16_pos..utf16_pos + g_u16_len];
			utf16_pos += g_u16_len;

			if !f(u16_slice, w) {
				return false;
			}
		}

		true
	})
}

/// Visible width, with early-exit if width exceeds `limit`.
fn visible_width_u16_up_to(data: &[u16], limit: usize, tab_width: usize) -> (usize, bool) {
	let mut width = 0usize;
	let mut i = 0usize;
	let len = data.len();

	while i < len {
		if data[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(data, i) {
				let seq = &data[i..i + seq_len];
				if let Some(seq_width) = osc66_visible_width_u16(seq, tab_width) {
					width = width.saturating_add(seq_width);
					if width > limit {
						return (width, true);
					}
				}
				i += seq_len;
				continue;
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < len && data[i] != ESC {
			if data[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &data[start..i];

		if is_ascii {
			for &u in seg {
				width += ascii_cell_width_u16(u, tab_width);
				if width > limit {
					return (width, true);
				}
			}
		} else {
			let ok = for_each_grapheme_u16_slow(seg, tab_width, |_, w| {
				width += w;
				width <= limit
			});
			if !ok {
				return (width, true);
			}
		}
	}

	(width, width > limit)
}

fn visible_width_u16(data: &[u16], tab_width: usize) -> usize {
	visible_width_u16_up_to(data, usize::MAX, tab_width).0
}

fn append_visible_range_plain_u16<F>(
	out: &mut Vec<u16>,
	data: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: usize,
	mut before_first_write: F,
) -> (usize, bool)
where
	F: FnMut(&mut Vec<u16>),
{
	if length == 0 {
		return (0, false);
	}

	let end_col = start_col.saturating_add(length);
	let mut out_w = 0usize;
	let mut wrote = false;
	let mut current_col = 0usize;
	let mut i = 0usize;

	while i < data.len() && current_col < end_col {
		let start = i;
		let mut is_ascii = data[i] <= 0x7f;
		i += 1;
		if is_ascii {
			while i < data.len() && data[i] <= 0x7f {
				i += 1;
			}
			if i < data.len() && is_ascii_grapheme_extender_u16(data[i]) {
				let safe_end = i.saturating_sub(1);
				if safe_end > start {
					i = safe_end;
				} else {
					is_ascii = false;
					i += 1;
				}
			}
		}
		if !is_ascii {
			while i < data.len() && data[i] > 0x7f {
				i += 1;
			}
		}
		let seg = &data[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= end_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;
				if in_range && fits {
					if !wrote {
						before_first_write(out);
						wrote = true;
					}
					out.push(u);
					out_w += gw;
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= end_col {
					return false;
				}
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;
				if in_range && fits {
					if !wrote {
						before_first_write(out);
						wrote = true;
					}
					out.extend_from_slice(gu16);
					out_w += gw;
				}
				current_col += gw;
				current_col < end_col
			});
		}
	}

	(out_w, wrote)
}

fn flush_pending_ansi(
	out: &mut Vec<u16>,
	source: &[u16],
	pending: &mut SmallVec<[(usize, usize); 4]>,
) {
	if pending.is_empty() {
		return;
	}
	for &(p, l) in pending.iter() {
		out.extend_from_slice(&source[p..p + l]);
	}
	pending.clear();
}

// ============================================================================
// wrapTextWithAnsi
// ============================================================================

#[inline]
fn write_active_codes(state: &AnsiState, out: &mut Vec<u16>) {
	if !state.is_empty() {
		state.write_restore_u16(out);
	}
}

#[inline]
fn write_line_end_reset(state: &AnsiState, out: &mut Vec<u16>) {
	let has_underline = state.attrs & ATTR_UNDERLINE != 0;
	let has_strike = state.attrs & ATTR_STRIKE != 0;
	if !has_underline && !has_strike {
		return;
	}

	out.extend_from_slice(&[ESC, b'[' as u16]);
	if has_underline {
		out.extend_from_slice(&[b'2' as u16, b'4' as u16]);
		if has_strike {
			out.push(b';' as u16);
		}
	}
	if has_strike {
		out.extend_from_slice(&[b'2' as u16, b'9' as u16]);
	}
	out.push(b'm' as u16);
}

fn update_state_from_text(data: &[u16], state: &mut AnsiState) {
	let mut i = 0usize;
	while i < data.len() {
		if data[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(data, i)
		{
			let seq = &data[i..i + seq_len];
			if is_sgr_u16(seq) {
				state.apply_sgr_u16(&seq[2..seq_len - 1]);
			}
			i += seq_len;
			continue;
		}
		i += 1;
	}
}

fn token_is_whitespace(token: &[u16]) -> bool {
	let mut i = 0usize;
	while i < token.len() {
		if token[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(token, i)
		{
			let seq = &token[i..i + seq_len];
			if let Some((_, payload)) = osc66_meta_payload_u16(seq)
				&& payload.iter().any(|&u| u != b' ' as u16)
			{
				return false;
			}
			i += seq_len;
			continue;
		}
		if token[i] != b' ' as u16 {
			return false;
		}
		i += 1;
	}
	true
}

fn trim_end_spaces_in_place(line: &mut Vec<u16>) {
	while let Some(&last) = line.last() {
		if last == b' ' as u16 {
			line.pop();
		} else {
			break;
		}
	}
}

fn split_into_tokens_with_ansi(line: &[u16]) -> SmallVec<[Vec<u16>; 4]> {
	let mut tokens = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current = Vec::<u16>::new();
	let mut pending_ansi = SmallVec::<[u16; 32]>::new();
	let mut in_whitespace = false;
	let mut i = 0usize;

	while i < line.len() {
		if line[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(line, i)
		{
			pending_ansi.extend_from_slice(&line[i..i + seq_len]);
			i += seq_len;
			continue;
		}

		let ch = line[i];
		let char_is_space = ch == b' ' as u16;
		if char_is_space != in_whitespace && !current.is_empty() {
			tokens.push(current);
			current = Vec::new();
		}

		if !pending_ansi.is_empty() {
			current.extend_from_slice(&pending_ansi);
			pending_ansi.clear();
		}

		in_whitespace = char_is_space;
		current.push(ch);
		i += 1;
	}

	if !pending_ansi.is_empty() {
		current.extend_from_slice(&pending_ansi);
	}

	if !current.is_empty() {
		tokens.push(current);
	}

	tokens
}

fn break_long_word(
	word: &[u16],
	width: usize,
	tab_width: usize,
	state: &mut AnsiState,
) -> SmallVec<[Vec<u16>; 4]> {
	let mut lines = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	write_active_codes(state, &mut current_line);
	let mut current_width = 0usize;
	let mut i = 0usize;

	while i < word.len() {
		if word[i] == ESC
			&& let Some(seq_len) = ansi_seq_len_u16(word, i)
		{
			let seq = &word[i..i + seq_len];
			if let Some(seq_width) = osc66_visible_width_u16(seq, tab_width) {
				if current_width.saturating_add(seq_width) > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(current_line);
					current_line = Vec::new();
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.extend_from_slice(seq);
				current_width = current_width.saturating_add(seq_width);
				i += seq_len;
				continue;
			}
			current_line.extend_from_slice(seq);
			if is_sgr_u16(seq) {
				state.apply_sgr_u16(&seq[2..seq_len - 1]);
			}
			i += seq_len;
			continue;
		}

		if word[i] == ESC {
			// An ESC that ansi_seq_len_u16 could not classify (truncated or unknown
			// sequence). Emit it as a zero-width byte and advance — otherwise the
			// non-ESC scan below cannot move past it and the loop spins forever.
			current_line.push(word[i]);
			i += 1;
			continue;
		}
		let start = i;
		let mut is_ascii = true;
		while i < word.len() && word[i] != ESC {
			if word[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &word[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(current_line);
					current_line = Vec::new();
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.push(u);
				current_width += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_width + gw > width {
					write_line_end_reset(state, &mut current_line);
					lines.push(std::mem::take(&mut current_line));
					write_active_codes(state, &mut current_line);
					current_width = 0;
				}
				current_line.extend_from_slice(gu16);
				current_width += gw;
				true
			});
		}
	}

	if !current_line.is_empty() {
		lines.push(current_line);
	}

	lines
}

fn wrap_single_line(line: &[u16], width: usize, tab_width: usize) -> SmallVec<[Vec<u16>; 4]> {
	if line.is_empty() {
		return smallvec![Vec::new()];
	}

	if visible_width_u16(line, tab_width) <= width {
		return smallvec![line.to_vec()];
	}

	let tokens = split_into_tokens_with_ansi(line);
	let mut wrapped = SmallVec::<[Vec<u16>; 4]>::new();
	let mut current_line = Vec::<u16>::new();
	let mut current_width = 0usize;
	let mut state = AnsiState::new();

	for token in tokens {
		let token_width = visible_width_u16(&token, tab_width);
		let is_whitespace = token_is_whitespace(&token);

		if token_width > width && !is_whitespace {
			if !current_line.is_empty() {
				write_line_end_reset(&state, &mut current_line);
				wrapped.push(current_line);
				current_line = Vec::new();
				current_width = 0;
			}

			let mut broken = break_long_word(&token, width, tab_width, &mut state);
			if let Some(last) = broken.pop() {
				wrapped.extend(broken);
				current_line = last;
				current_width = visible_width_u16(&current_line, tab_width);
			}
			continue;
		}

		let total_needed = current_width + token_width;
		if total_needed > width && current_width > 0 {
			let mut line_to_wrap = current_line;
			trim_end_spaces_in_place(&mut line_to_wrap);
			write_line_end_reset(&state, &mut line_to_wrap);
			wrapped.push(line_to_wrap);

			current_line = Vec::new();
			write_active_codes(&state, &mut current_line);
			if is_whitespace {
				current_width = 0;
			} else {
				current_line.extend_from_slice(&token);
				current_width = token_width;
			}
		} else {
			current_line.extend_from_slice(&token);
			current_width += token_width;
		}

		update_state_from_text(&token, &mut state);
	}

	if !current_line.is_empty() {
		wrapped.push(current_line);
	}

	for line in &mut wrapped {
		trim_end_spaces_in_place(line);
	}

	if wrapped.is_empty() {
		wrapped.push(Vec::new());
	}

	wrapped
}

fn wrap_text_with_ansi_impl(
	text: &[u16],
	width: usize,
	tab_width: usize,
) -> SmallVec<[Vec<u16>; 4]> {
	if text.is_empty() {
		return smallvec![Vec::new()];
	}

	let mut result = SmallVec::<[Vec<u16>; 4]>::new();
	let mut state = AnsiState::new();
	let mut line_start = 0usize;

	for i in 0..=text.len() {
		if i == text.len() || text[i] == b'\n' as u16 {
			let line = &text[line_start..i];
			let mut line_with_prefix: Vec<u16> = Vec::new();
			if !result.is_empty() {
				write_active_codes(&state, &mut line_with_prefix);
			}
			line_with_prefix.extend_from_slice(line);

			let wrapped = wrap_single_line(&line_with_prefix, width, tab_width);
			result.extend(wrapped);
			update_state_from_text(line, &mut state);
			line_start = i + 1;
		}
	}

	if result.is_empty() {
		result.push(Vec::new());
	}

	result
}

/// Wrap text to a visible width, preserving ANSI escape codes across line
/// breaks.
///
/// Returns UTF-16 lines with active SGR codes carried across line boundaries.
#[napi]
pub fn wrap_text_with_ansi(text: JsString, width: u32, tab_width: u32) -> Result<Vec<Utf16String>> {
	let text_u16 = text.into_utf16()?;
	let tab_width = clamp_tab_width_for_ops(tab_width);
	let lines = wrap_text_with_ansi_impl(text_u16.as_slice(), width as usize, tab_width);
	Ok(lines.into_iter().map(build_utf16_string).collect())
}

// ============================================================================
// truncateToWidth
// ============================================================================

/// Truncate text to a visible width, preserving ANSI codes.
///
/// Pads with spaces when requested.
#[napi]
pub fn truncate_to_width(
	text: JsString<'_>,
	max_width: u32,
	ellipsis_kind: Option<Ellipsis>,
	pad: Option<bool>,
	tab_width: u32,
) -> Result<Either<JsString<'_>, Utf16String>> {
	let max_width = max_width as usize;
	let ellipsis_kind = ellipsis_kind.unwrap_or(Ellipsis::Unicode);
	let pad = pad.unwrap_or(false);
	let tab_width = clamp_tab_width_for_ops(tab_width);

	// Keep original handle so we can return it without allocating.
	let original = text;

	let text_u16 = text.into_utf16()?;
	let text = text_u16.as_slice();

	// Fast path: early-exit width check
	let (text_w, exceeded) = visible_width_u16_up_to(text, max_width, tab_width);
	if !exceeded {
		if !pad {
			// Return original JsString handle: zero output allocation.
			return Ok(Either::A(original));
		}

		if text_w < max_width {
			let mut out = Vec::with_capacity(text.len() + (max_width - text_w));
			out.extend_from_slice(text);
			out.resize(out.len() + (max_width - text_w), b' ' as u16);
			return Ok(Either::B(build_utf16_string(out)));
		}

		// Exactly fits and padding requested: return original is still fine.
		return Ok(Either::A(original));
	}

	// Map ellipsis kind to UTF-16 data and width
	const ELLIPSIS_UNICODE: &[u16] = &[0x2026]; // "…"
	const ELLIPSIS_ASCII: &[u16] = &[0x2e, 0x2e, 0x2e]; // "..."
	const ELLIPSIS_OMIT: &[u16] = &[];

	let (ellipsis, ellipsis_w): (&[u16], usize) = match ellipsis_kind {
		Ellipsis::Unicode => (ELLIPSIS_UNICODE, 1),
		Ellipsis::Ascii => (ELLIPSIS_ASCII, 3),
		Ellipsis::Omit => (ELLIPSIS_OMIT, 0),
	};

	let target_w = max_width.saturating_sub(ellipsis_w);

	// If ellipsis alone doesn't fit, return ellipsis cut to max_width
	if target_w == 0 {
		let mut out = Vec::with_capacity(ellipsis.len().min(max_width * 2));
		let mut w = 0usize;
		let _ = for_each_grapheme_u16_slow(ellipsis, tab_width, |gu16, gw| {
			if w + gw > max_width {
				return false;
			}
			out.extend_from_slice(gu16);
			w += gw;
			true
		});

		if pad && w < max_width {
			out.resize(out.len() + (max_width - w), b' ' as u16);
		}
		return Ok(Either::B(build_utf16_string(out)));
	}

	// Main truncation
	let mut out = Vec::with_capacity(text.len().min(max_width * 2) + ellipsis.len() + 8);
	let mut w = 0usize;
	let mut i = 0usize;
	let text_len = text.len();

	let mut saw_sgr = false;

	while i < text_len {
		if text[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(text, i) {
				let seq = &text[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_end = w.saturating_add(osc66.width);
					if span_end <= target_w {
						out.extend_from_slice(seq);
						w = span_end;
						i += seq_len;
						if w >= target_w {
							break;
						}
						continue;
					}

					if w < target_w {
						let remaining = target_w - w;
						let (payload_w, _) = append_visible_range_plain_u16(
							&mut out,
							osc66.payload,
							0,
							remaining,
							true,
							tab_width,
							|_| {},
						);
						w = w.saturating_add(payload_w);
					}
					break;
				}
				out.extend_from_slice(seq);
				if is_sgr_u16(seq) {
					saw_sgr = true;
				}
				i += seq_len;
				continue;
			}
			out.push(ESC);
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < text_len && text[i] != ESC {
			if text[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &text[start..i];

		if is_ascii {
			for &u in seg {
				let gw = ascii_cell_width_u16(u, tab_width);
				if w + gw > target_w {
					break;
				}
				out.push(u);
				w += gw;
			}
			if w >= target_w {
				break;
			}
		} else {
			let keep_going = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if w + gw > target_w {
					return false;
				}
				out.extend_from_slice(gu16);
				w += gw;
				true
			});
			if !keep_going {
				break;
			}
		}
	}

	// Only reset if we actually copied SGR codes into the output.
	if saw_sgr {
		out.extend_from_slice(&[ESC, b'[' as u16, b'0' as u16, b'm' as u16]);
	}
	out.extend_from_slice(ellipsis);

	if pad {
		let out_w = w + ellipsis_w;
		if out_w < max_width {
			out.resize(out.len() + (max_width - out_w), b' ' as u16);
		}
	}

	Ok(Either::B(build_utf16_string(out)))
}

// ============================================================================
// sliceWithWidth
// ============================================================================

fn slice_with_width_impl(
	line: &[u16],
	start_col: usize,
	length: usize,
	strict: bool,
	tab_width: usize,
) -> (Vec<u16>, usize) {
	let end_col = start_col.saturating_add(length);

	let mut out = Vec::with_capacity(length * 2);
	let mut out_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	// Store pending ANSI ranges (pos, len) to avoid copying until needed
	let mut pending_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	while i < line_len && current_col < end_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				let seq = &line[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_start = current_col;
					let span_end = current_col.saturating_add(osc66.width);
					if span_start >= start_col && span_end <= end_col {
						flush_pending_ansi(&mut out, line, &mut pending_ansi);
						out.extend_from_slice(seq);
						out_w = out_w.saturating_add(osc66.width);
					} else if span_start < end_col && span_end > start_col {
						let overlap_start = start_col.saturating_sub(span_start);
						let overlap_end = span_end.min(end_col) - span_start;
						let overlap_len = overlap_end.saturating_sub(overlap_start);
						let (payload_start, payload_len) =
							osc66_payload_range(overlap_start, overlap_len, osc66.scale, strict);
						let (payload_w, _) = append_visible_range_plain_u16(
							&mut out,
							osc66.payload,
							payload_start,
							payload_len,
							strict,
							tab_width,
							|out| flush_pending_ansi(out, line, &mut pending_ansi),
						);
						out_w = out_w.saturating_add(payload_w);
					}
					current_col = span_end;
					i += seq_len;
					continue;
				}

				if current_col >= start_col {
					out.extend_from_slice(&line[i..i + seq_len]);
				} else {
					pending_ansi.push((i, seq_len));
				}
				i += seq_len;
				continue;
			}
			if current_col >= start_col {
				out.push(ESC);
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= end_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);
				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					flush_pending_ansi(&mut out, line, &mut pending_ansi);
					out.push(u);
					out_w += gw;
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= end_col {
					return false;
				}

				let in_range = current_col >= start_col;
				let fits = !strict || current_col + gw <= end_col;

				if in_range && fits {
					flush_pending_ansi(&mut out, line, &mut pending_ansi);
					out.extend_from_slice(gu16);
					out_w += gw;
				}

				current_col += gw;
				current_col < end_col
			});
		}
	}

	// Include trailing ANSI sequences (e.g., reset codes) that immediately follow
	while i < line.len() {
		if line[i] == ESC
			&& let Some(len) = ansi_seq_len_u16(line, i)
		{
			let seq = &line[i..i + len];
			if osc66_visible_width_u16(seq, tab_width).is_none() {
				out.extend_from_slice(seq);
			}
			i += len;
			continue;
		}
		break;
	}

	(out, out_w)
}

/// Slice a range of visible columns from a line.
///
/// Counts terminal cells, skipping ANSI escapes, and optionally enforces strict
/// width.
#[napi]
pub fn slice_with_width(
	line: JsString,
	start_col: u32,
	length: u32,
	strict: Option<bool>,
	tab_width: u32,
) -> Result<SliceResult> {
	let line_u16 = line.into_utf16()?;
	let line = line_u16.as_slice();
	let strict = strict.unwrap_or(false);

	if length == 0 {
		return Ok(SliceResult { text: build_utf16_string(vec![]), width: 0 });
	}

	let tab_width = clamp_tab_width_for_ops(tab_width);
	let (out, w) =
		slice_with_width_impl(line, start_col as usize, length as usize, strict, tab_width);

	Ok(SliceResult { text: build_utf16_string(out), width: crate::utils::clamp_u32(w as u64) })
}

// ============================================================================
// extractSegments
// ============================================================================

fn extract_segments_impl(
	line: &[u16],
	before_end: usize,
	after_start: usize,
	after_len: usize,
	strict_after: bool,
	tab_width: usize,
) -> (Vec<u16>, usize, Vec<u16>, usize) {
	let after_end = after_start.saturating_add(after_len);

	let mut before = Vec::with_capacity(before_end * 2);
	let mut before_w = 0usize;

	let mut after = Vec::with_capacity(after_len * 2);
	let mut after_w = 0usize;

	let mut current_col = 0usize;
	let mut i = 0usize;
	let line_len = line.len();

	// Store pending ANSI ranges for "before"
	let mut pending_before_ansi: SmallVec<[(usize, usize); 4]> = SmallVec::new();

	let mut after_started = false;
	let mut state = AnsiState::new();

	let done_col = if after_len == 0 {
		before_end
	} else {
		after_end
	};

	while i < line_len && current_col < done_col {
		if line[i] == ESC {
			if let Some(seq_len) = ansi_seq_len_u16(line, i) {
				let seq = &line[i..i + seq_len];
				if let Some(osc66) = osc66_info_u16(seq, tab_width) {
					let span_start = current_col;
					let span_end = current_col.saturating_add(osc66.width);

					if span_start < before_end {
						if span_end <= before_end {
							flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
							before.extend_from_slice(seq);
							before_w = before_w.saturating_add(osc66.width);
						} else {
							let overlap_len = before_end - span_start;
							let (payload_start, payload_len) =
								osc66_payload_range(0, overlap_len, osc66.scale, true);
							let (payload_w, _) = append_visible_range_plain_u16(
								&mut before,
								osc66.payload,
								payload_start,
								payload_len,
								true,
								tab_width,
								|out| flush_pending_ansi(out, line, &mut pending_before_ansi),
							);
							before_w = before_w.saturating_add(payload_w);
						}
					}

					if after_len != 0 && span_start < after_end && span_end > after_start {
						let overlap_start = after_start.saturating_sub(span_start);
						let overlap_end = span_end.min(after_end) - span_start;
						let overlap_len = overlap_end.saturating_sub(overlap_start);

						if span_start >= after_start && span_end <= after_end {
							if !after_started {
								state.write_restore_u16(&mut after);
								after_started = true;
							}
							after.extend_from_slice(seq);
							after_w = after_w.saturating_add(osc66.width);
						} else {
							let (payload_start, payload_len) =
								osc66_payload_range(overlap_start, overlap_len, osc66.scale, strict_after);
							let (payload_w, wrote_payload) = append_visible_range_plain_u16(
								&mut after,
								osc66.payload,
								payload_start,
								payload_len,
								strict_after,
								tab_width,
								|out| {
									if !after_started {
										state.write_restore_u16(out);
										after_started = true;
									}
								},
							);
							if wrote_payload {
								after_w = after_w.saturating_add(payload_w);
							}
						}
					}

					current_col = span_end;
					i += seq_len;
					continue;
				}

				if is_sgr_u16(seq) {
					state.apply_sgr_u16(&seq[2..seq_len - 1]);
				}

				if current_col < before_end {
					pending_before_ansi.push((i, seq_len));
				} else if current_col >= after_start && current_col < after_end && after_started {
					after.extend_from_slice(seq);
				}

				i += seq_len;
				continue;
			}

			if current_col < before_end {
				before.push(ESC);
			} else if current_col >= after_start && current_col < after_end && after_started {
				after.push(ESC);
			}
			i += 1;
			continue;
		}

		let start = i;
		let mut is_ascii = true;
		while i < line_len && line[i] != ESC {
			if line[i] > 0x7f {
				is_ascii = false;
			}
			i += 1;
		}
		let seg = &line[start..i];

		if is_ascii {
			for &u in seg {
				if current_col >= done_col {
					break;
				}
				let gw = ascii_cell_width_u16(u, tab_width);

				if current_col < before_end {
					flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
					before.push(u);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.push(u);
						after_w += gw;
					}
				}
				current_col += gw;
			}
		} else {
			let _ = for_each_grapheme_u16_slow(seg, tab_width, |gu16, gw| {
				if current_col >= done_col {
					return false;
				}

				if current_col < before_end {
					flush_pending_ansi(&mut before, line, &mut pending_before_ansi);
					before.extend_from_slice(gu16);
					before_w += gw;
				} else if current_col >= after_start && current_col < after_end {
					let fits = !strict_after || current_col + gw <= after_end;
					if fits {
						if !after_started {
							state.write_restore_u16(&mut after);
							after_started = true;
						}
						after.extend_from_slice(gu16);
						after_w += gw;
					}
				}

				current_col += gw;
				true
			});
		}
	}

	(before, before_w, after, after_w)
}

/// Extract the before/after slices around an overlay region.
///
/// Preserves ANSI state so the `after` segment renders correctly after
/// truncation.
#[napi]
pub fn extract_segments(
	line: JsString,
	before_end: u32,
	after_start: u32,
	after_len: u32,
	strict_after: bool,
	tab_width: u32,
) -> Result<ExtractSegmentsResult> {
	let line_u16 = line.into_utf16()?;
	let line = line_u16.as_slice();

	let tab_width = clamp_tab_width_for_ops(tab_width);
	let (before, bw, after, aw) = extract_segments_impl(
		line,
		before_end as usize,
		after_start as usize,
		after_len as usize,
		strict_after,
		tab_width,
	);

	Ok(ExtractSegmentsResult {
		before:       build_utf16_string(before),
		before_width: crate::utils::clamp_u32(bw as u64),
		after:        build_utf16_string(after),
		after_width:  crate::utils::clamp_u32(aw as u64),
	})
}

// ============================================================================
// visibleWidth
// ============================================================================

/// Calculate visible width of text, excluding ANSI escape sequences.
///
/// Tabs count as a fixed-width cell.
#[napi]
pub fn visible_width(text: JsString, tab_width: u32) -> Result<u32> {
	let text_u16 = text.into_utf16()?;
	let tab_width = clamp_tab_width_for_ops(tab_width);
	Ok(crate::utils::clamp_u32(visible_width_u16(text_u16.as_slice(), tab_width) as u64))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn to_u16(s: &str) -> Vec<u16> {
		s.encode_utf16().collect()
	}

	#[test]
	fn test_visible_width() {
		assert_eq!(visible_width_u16(&to_u16("hello"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b[31mhello\x1b[0m"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b[38;5;196mred\x1b[0m"), DEFAULT_TAB_WIDTH), 3);
		assert_eq!(visible_width_u16(&to_u16("a\tb"), DEFAULT_TAB_WIDTH), 1 + DEFAULT_TAB_WIDTH + 1);
	}

	#[test]
	fn test_visible_width_vs16_emoji_presentation() {
		// Variation-selector-16 (U+FE0F) promotes a default-text-presentation
		// symbol to emoji presentation, which renders as 2 cells. A naive
		// per-char sum would count U+26A0 (1) + U+FE0F (0) = 1 and shift table
		// borders one column. Guards the regression where ⚠️ measured as 1.
		assert_eq!(visible_width_u16(&to_u16("\u{26A0}\u{FE0F}"), DEFAULT_TAB_WIDTH), 2); // ⚠️
		assert_eq!(visible_width_u16(&to_u16("\u{2139}\u{FE0F}"), DEFAULT_TAB_WIDTH), 2); // ℹ️
		assert_eq!(visible_width_u16(&to_u16("\u{2764}\u{FE0F}"), DEFAULT_TAB_WIDTH), 2); // ❤️
		assert_eq!(visible_width_u16(&to_u16("0\u{FE0F}\u{20E3}"), DEFAULT_TAB_WIDTH), 2); // 0️⃣ keycap
		// Bare symbol without VS16 keeps text-presentation width (1 cell).
		assert_eq!(visible_width_u16(&to_u16("\u{26A0}"), DEFAULT_TAB_WIDTH), 1);
		// Intrinsically wide emoji are unaffected.
		assert_eq!(visible_width_u16(&to_u16("\u{2705}"), DEFAULT_TAB_WIDTH), 2); // ✅
		assert_eq!(visible_width_u16(&to_u16("\u{274C}"), DEFAULT_TAB_WIDTH), 2); // ❌
	}

	#[test]
	fn test_visible_width_jamo_correction_inside_combining_cluster() {
		let jamo_cells = if cfg!(target_os = "macos") { 1 } else { 2 };
		let filler_cells = usize::from(cfg!(target_os = "macos"));
		assert_eq!(visible_width_u16(&to_u16("\u{3141}\u{0301}"), DEFAULT_TAB_WIDTH), jamo_cells);
		assert_eq!(visible_width_u16(&to_u16("\u{3164}\u{0301}"), DEFAULT_TAB_WIDTH), filler_cells);
	}

	#[test]
	fn test_osc66_visible_width_helper() {
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;s=2;Hi\x1b\\"), DEFAULT_TAB_WIDTH),
			Some(4)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;w=5;Hi\x07"), DEFAULT_TAB_WIDTH),
			Some(5)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;s=3:w=4;X\x1b\\"), DEFAULT_TAB_WIDTH),
			Some(12)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]66;;a\t界\x1b\\"), DEFAULT_TAB_WIDTH),
			Some(1 + DEFAULT_TAB_WIDTH + 2)
		);
		assert_eq!(
			osc66_visible_width_u16(&to_u16("\x1b]8;;https://example.com\x07"), DEFAULT_TAB_WIDTH),
			None
		);
	}

	#[test]
	fn test_visible_width_counts_osc66_lines() {
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;s=2;Hi\x1b\\"), DEFAULT_TAB_WIDTH), 4);
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;w=5;Hi\x1b\\"), DEFAULT_TAB_WIDTH), 5);
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;s=3:w=4;X\x1b\\"), DEFAULT_TAB_WIDTH), 12);
		assert_eq!(visible_width_u16(&to_u16("\x1b]66;;abc\x1b\\"), DEFAULT_TAB_WIDTH), 3);
		assert_eq!(
			visible_width_u16(&to_u16("A\x1b]66;s=2;Hi\x1b\\Z"), DEFAULT_TAB_WIDTH),
			1 + 4 + 1
		);
		assert_eq!(
			visible_width_u16(&to_u16("\x1b[31m\x1b]66;s=2;Hi\x1b\\\x1b[0m"), DEFAULT_TAB_WIDTH),
			4
		);
	}

	#[test]
	fn test_osc66_scaled_partial_slices_map_to_payload_cells() {
		let data = to_u16("\x1b]66;s=2;Hi\x1b\\");

		let (head, head_w) = slice_with_width_impl(&data, 0, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&head), "H");
		assert_eq!(head_w, 1);

		let (tail, tail_w) = slice_with_width_impl(&data, 2, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&tail), "i");
		assert_eq!(tail_w, 1);

		let (before, before_w, after, after_w) =
			extract_segments_impl(&to_u16("A\x1b]66;s=2;Hi\x1b\\Z"), 1, 3, 2, true, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&before), "A");
		assert_eq!(before_w, 1);
		assert_eq!(String::from_utf16_lossy(&after), "i");
		assert_eq!(after_w, 1);
	}

	#[test]
	fn test_plain_range_keeps_ascii_base_with_combining_mark() {
		let mut out = Vec::new();
		let data = to_u16("ab\u{0301}c界");
		let (width, wrote) =
			append_visible_range_plain_u16(&mut out, &data, 1, 1, true, DEFAULT_TAB_WIDTH, |_| {});
		assert!(wrote);
		assert_eq!(width, 1);
		assert_eq!(String::from_utf16_lossy(&out), "b\u{0301}");
	}

	#[test]
	fn test_ansi_detection() {
		let data = to_u16("\x1b[31mred\x1b[0m");
		assert_eq!(ansi_seq_len_u16(&data, 0), Some(5)); // \x1b[31m
		assert_eq!(ansi_seq_len_u16(&data, 8), Some(4)); // \x1b[0m
	}

	#[test]
	fn test_slice_basic() {
		let data = to_u16("hello world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "hello");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_slice_with_ansi() {
		let data = to_u16("\x1b[31mhello\x1b[0m world");
		let (out, width) = slice_with_width_impl(&data, 0, 5, false, DEFAULT_TAB_WIDTH);
		assert_eq!(String::from_utf16_lossy(&out), "\x1b[31mhello\x1b[0m");
		assert_eq!(width, 5);
	}

	#[test]
	fn test_ascii_fast_path() {
		fn is_ascii(seg: &[u16]) -> bool {
			seg.iter().all(|&u| u <= 0x7f)
		}

		let ascii = to_u16("hello world 12345");
		assert!(is_ascii(&ascii));

		let non_ascii = to_u16("hello 世界");
		assert!(!is_ascii(&non_ascii));
	}

	#[test]
	fn test_early_exit() {
		let data = to_u16(&"a]b".repeat(1000));
		let (w, exceeded) = visible_width_u16_up_to(&data, 10, DEFAULT_TAB_WIDTH);
		assert!(exceeded);
		assert!(w > 10);
	}

	#[test]
	fn test_wrap_text_with_ansi_preserves_color() {
		let data = to_u16("\x1b[38;2;156;163;176mhello world\x1b[0m");
		let lines = wrap_text_with_ansi_impl(&data, 5, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 2);
		let first = String::from_utf16_lossy(&lines[0]);
		let second = String::from_utf16_lossy(&lines[1]);
		assert!(first.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.starts_with("\x1b[38;2;156;163;176m"));
		assert!(second.contains("world"));
	}

	#[test]
	fn test_wrap_text_with_ansi_resets_strike_without_resetting_colors() {
		let data =
			to_u16("\x1b[38;5;196m\x1b[48;5;236m\x1b[9mstrikethrough content wraps\x1b[29m\x1b[0m");
		let lines = wrap_text_with_ansi_impl(&data, 12, DEFAULT_TAB_WIDTH);
		assert!(lines.len() > 1);

		for line in &lines[..lines.len() - 1] {
			let line_text = String::from_utf16_lossy(line);
			if line_text.contains("\x1b[9m") {
				assert!(line_text.ends_with("\x1b[29m"));
				assert!(!line_text.ends_with("\x1b[0m"));
			}
		}

		for line in &lines[1..] {
			let line_text = String::from_utf16_lossy(line);
			assert!(line_text.contains("38;5;196"));
			assert!(line_text.contains("48;5;236"));
		}
	}

	#[test]
	fn test_wrap_text_with_ansi_bel_terminated_apc_is_zero_width() {
		// The TUI cursor marker is a BEL-terminated APC. A prior bug left it
		// unrecognized, so it was counted as visible width and `break_long_word`
		// spun forever on the ESC. The APC must measure zero width: a line whose
		// visible content fits the target stays on a single row.
		let data = to_u16("\x1b_pi:c\x07root-overflowx1界🙂한");
		let lines = wrap_text_with_ansi_impl(&data, 24, DEFAULT_TAB_WIDTH);
		assert_eq!(lines.len(), 1);
		let only = String::from_utf16_lossy(&lines[0]);
		assert!(only.contains("\x1b_pi:c\x07"));
		assert!(only.contains("root-overflowx1界🙂한"));
	}

	#[test]
	fn test_wrap_text_with_ansi_apc_in_overflowing_word_terminates() {
		// Same BEL-APC embedded in content that overflows, forcing break_long_word:
		// it must terminate (keeping the zero-width marker) and every wrapped row
		// must stay within the target width.
		let data = to_u16("\x1b_pi:c\x07abcdefghijklmnopqrstuvwxyz0123456789");
		let lines = wrap_text_with_ansi_impl(&data, 10, DEFAULT_TAB_WIDTH);
		assert!(lines.len() > 1);
		let joined: String = lines.iter().map(|l| String::from_utf16_lossy(l)).collect();
		assert!(joined.contains("\x1b_pi:c\x07"));
		for line in &lines {
			assert!(visible_width_u16(line, DEFAULT_TAB_WIDTH) <= 10);
		}
	}

	#[test]
	fn test_wrap_text_with_ansi_unclassified_escape_in_long_word_terminates() {
		// Defensive: an ESC `ansi_seq_len_u16` cannot classify (here `ESC 0x01`)
		// inside an overflowing word must not spin the break loop.
		let data = to_u16("aaaaaaaaaa\x1b\u{1}bbbbbbbbbb");
		let lines = wrap_text_with_ansi_impl(&data, 4, DEFAULT_TAB_WIDTH);
		assert!(!lines.is_empty());
	}
}
