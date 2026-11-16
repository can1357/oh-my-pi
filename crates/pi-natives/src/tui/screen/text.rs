//! Row-text helpers of the frame writer: visible width, escape-sequence
//! scanning, OSC 66 text-sizing rows, output normalization, and REP padding.

use std::{borrow::Cow, fmt::Write as _};

use memchr::{memchr, memmem};

use crate::text::{self, DEFAULT_TAB_WIDTH, Ellipsis};

const ESC: u8 = 0x1b;
/// Kitty OSC 66 text-sizing span introducer: `ESC ] 66 ; <meta> ; <payload>`
/// terminated by BEL or ST.
const OSC66_PREFIX: &str = "\x1b]66;";

/// Rows a scaled OSC 66 heading may reserve beneath itself (scale ≤ 7).
const OSC66_MAX_SPACER_ROWS: usize = 6;

/// Visible width of `text` in terminal columns, excluding ANSI/OSC/APC
/// escapes; tabs count as the fixed display tab width and OSC 66 payloads
/// scale by their `s=`/`w=` metadata.
pub(crate) fn visible_width(text: &str) -> u32 {
	crate::utils::clamp_u32(text::visible_width_str(text, DEFAULT_TAB_WIDTH) as u64)
}

/// `text` cut to at most `width` visible columns without an ellipsis,
/// preserving its escape sequences. Text that fits is returned borrowed.
pub(crate) fn truncate_to_width(text: &str, width: u32) -> Cow<'_, str> {
	text::truncate_to_width_str(text, width as usize, Ellipsis::Omit, false, DEFAULT_TAB_WIDTH)
}

/// Byte offset just past the escape sequence starting at `start` (an ESC), or
/// `None` when the sequence is unterminated: CSI ends at its final byte, OSC
/// at BEL or ST, and any other escape is ESC plus one character.
pub(crate) fn ansi_sequence_end(line: &str, start: usize) -> Option<usize> {
	let bytes = line.as_bytes();
	match bytes.get(start + 1)? {
		b'[' => bytes[start + 2..]
			.iter()
			.position(|byte| (0x40..=0x7e).contains(byte))
			.map(|at| start + 2 + at + 1),
		b']' => {
			let mut at = start + 2;
			while at < bytes.len() {
				if bytes[at] == 0x07 {
					return Some(at + 1);
				}
				if bytes[at] == ESC && bytes.get(at + 1) == Some(&b'\\') {
					return Some(at + 2);
				}
				at += 1;
			}
			None
		},
		_ => {
			let next = line[start + 1..].chars().next()?;
			Some(start + 1 + next.len_utf8())
		},
	}
}

/// Scaled spans must bypass wrapping/padding and, when scaled up, reserve the
/// terminal rows their multicell glyphs flow into.
pub(crate) fn is_osc66_line(line: &str) -> bool {
	line.contains(OSC66_PREFIX)
}

/// Leading decimal integer of `text` after optional whitespace and a `+`
/// sign, ignoring whatever follows the digits; `None` without a digit (or for
/// a negative number, which no caller accepts).
fn leading_integer(text: &str) -> Option<u32> {
	let text = text.trim_start();
	let digits = text.strip_prefix('+').unwrap_or(text);
	let length = digits.bytes().take_while(u8::is_ascii_digit).count();
	if length == 0 {
		return None;
	}
	Some(digits[..length].bytes().fold(0u32, |value, byte| {
		value
			.saturating_mul(10)
			.saturating_add(u32::from(byte - b'0'))
	}))
}

/// Largest `s=` scale among the OSC 66 spans in a line (1 when none is
/// scaled). A scale-`s` heading occupies `s` terminal rows, so the `s - 1`
/// blank rows beneath it are the glyph's lower half and must never be erased
/// or overdrawn.
pub(crate) fn osc66_max_scale(line: &str) -> u32 {
	let mut max = 1;
	let mut rest = line;
	while let Some(open) = rest.find(OSC66_PREFIX) {
		let span = &rest[open + OSC66_PREFIX.len()..];
		// A span is `<meta> ; <payload>` closed by BEL or ST; without both
		// delimiters neither this nor any later introducer forms one.
		let Some(meta_end) = span.find(';') else {
			break;
		};
		let payload = &span[meta_end + 1..];
		let bytes = payload.as_bytes();
		let Some(close) = (0..bytes.len())
			.find(|&at| bytes[at] == 0x07 || (bytes[at] == ESC && bytes.get(at + 1) == Some(&b'\\')))
		else {
			break;
		};
		for part in span[..meta_end].split(':') {
			if let Some(value) = part.strip_prefix("s=").and_then(leading_integer)
				&& value > max
				&& value <= 7
			{
				max = value;
			}
		}
		let terminator = if bytes[close] == 0x07 { 1 } else { 2 };
		rest = &payload[close + terminator..];
	}
	max
}

/// Columns to preserve when `lines[index]` is a blank row that a scaled
/// OSC 66 heading flows into, or `None` when it is not such a row. A
/// scale-`s` heading occupies `s` rows and its visible width in columns, so
/// the `s - 1` blank rows beneath it hold the multicell glyph's lower half;
/// those columns must never be erased or overdrawn or the glyph vanishes,
/// leaving reserved-but-invisible space (issue #8318). Scans upward across
/// the contiguous blank run so every reserved row of a scale ≥ 3 heading is
/// covered, not just the first.
pub(crate) fn osc66_spacer_glyph_width<S: AsRef<str>>(lines: &[S], index: usize) -> Option<u32> {
	if index == 0 || !lines.get(index)?.as_ref().is_empty() {
		return None;
	}
	let mut gap = 1;
	while gap < OSC66_MAX_SPACER_ROWS && index - gap > 0 && lines[index - gap].as_ref().is_empty() {
		gap += 1;
	}
	let above = lines[index - gap].as_ref();
	if !is_osc66_line(above) || gap as u32 > osc66_max_scale(above) - 1 {
		return None;
	}
	Some(visible_width(above))
}

/// Rows `[start, end)` of a previously painted window re-measured at `width`.
/// Every terminal rewraps content on a width change — including multiplexers:
/// tmux clips in place on height changes only, and reflows the pane
/// (scrollback included) when the width moves, so a row painted wider than
/// the current width spans ceil(cells/width) physical rows everywhere. For
/// height-only resizes the painted rows already fit the width and the count
/// is unchanged.
pub(crate) fn reflowed_rows<S: AsRef<str>>(
	window: &[S],
	start: usize,
	end: usize,
	width: u32,
) -> usize {
	let stop = end.min(window.len());
	let width = width.max(1);
	window
		.get(start..stop)
		.unwrap_or_default()
		.iter()
		.map(|line| visible_width(line.as_ref()).div_ceil(width).max(1) as usize)
		.sum()
}

/// Normalize text for terminal output without changing logical editor
/// content. Some terminals render precomposed Thai/Lao AM vowels
/// inconsistently during differential repaint. Their compatibility
/// decompositions have the same cell width but avoid stale-cell artifacts in
/// terminal renderers.
pub(crate) fn normalize_terminal_output(text: &str) -> Cow<'_, str> {
	const THAI_AM: char = '\u{0e33}';
	const LAO_AM: char = '\u{0eb3}';
	let Some(first) = text.find([THAI_AM, LAO_AM]) else {
		return Cow::Borrowed(text);
	};
	let mut out = String::with_capacity(text.len() + 3);
	out.push_str(&text[..first]);
	for ch in text[first..].chars() {
		match ch {
			THAI_AM => out.push_str("\u{0e4d}\u{0e32}"),
			LAO_AM => out.push_str("\u{0ecd}\u{0eb2}"),
			other => out.push(other),
		}
	}
	Cow::Owned(out)
}

/// The OSC 8 params tagging omp's own extension-link markers. Each drawn link
/// gets its own `-<n>` suffix; a label wrapped across rows repeats its
/// marker, suffix included, on every row.
const LINK_MARKER_PARAMS: &str = "id=omp-extension-link";
const LINK_MARKER_OPEN: &[u8] = b"\x1b]8;id=omp-extension-link";

/// One OSC 8 sequence (`ESC ] 8 ; params ; uri` closed by BEL or ST) at the
/// start of `text`: its params, its URI (empty for a close) and its byte
/// length. Params hold no `;`, and neither part holds BEL or ESC.
fn osc8_at(text: &str) -> Option<(&str, &str, usize)> {
	let body = text.strip_prefix("\x1b]8;")?;
	let params_end = body.find([';', '\x07', '\x1b'])?;
	if body.as_bytes()[params_end] != b';' {
		return None;
	}
	let uri = &body[params_end + 1..];
	let uri_end = uri.find(['\x07', '\x1b'])?;
	let terminator = if uri.as_bytes()[uri_end] == 0x07 {
		1
	} else if uri.as_bytes().get(uri_end + 1) == Some(&b'\\') {
		2
	} else {
		return None;
	};
	Some((&body[..params_end], &uri[..uri_end], 4 + params_end + 1 + uri_end + terminator))
}

/// Whether OSC 8 `params` are an extension-link marker's:
/// `id=omp-extension-link` with an optional `-<digits>` suffix.
fn is_link_marker_params(params: &str) -> bool {
	params
		.strip_prefix(LINK_MARKER_PARAMS)
		.is_some_and(|suffix| {
			suffix.is_empty()
				|| suffix.strip_prefix('-').is_some_and(|digits| {
					!digits.is_empty() && digits.bytes().all(|byte| byte.is_ascii_digit())
				})
		})
}

/// `line` without omp's extension-link markers (the OSC 8 open and close
/// around each label), for terminal output. The markers exist only for
/// hit-testing in the component layer; the terminal must never receive the
/// link as a hyperlink it could open. Every other hyperlink is kept as is,
/// and markers are stripped even after their scheme is no longer registered.
pub(crate) fn strip_extension_link_markers(line: &str) -> Cow<'_, str> {
	let bytes = line.as_bytes();
	if memmem::find(bytes, LINK_MARKER_OPEN).is_none() {
		return Cow::Borrowed(line);
	}
	let mut out = String::with_capacity(line.len());
	let mut copied = 0;
	let mut inside = false;
	let mut at = 0;
	while let Some(found) = memchr(ESC, &bytes[at..]) {
		let start = at + found;
		let Some((params, uri, length)) = osc8_at(&line[start..]) else {
			at = start + 1;
			continue;
		};
		let strip = if uri.is_empty() {
			// A close ends the marker it follows, and is kept after any other
			// hyperlink.
			std::mem::take(&mut inside)
		} else {
			inside = is_link_marker_params(params);
			inside
		};
		if strip {
			out.push_str(&line[copied..start]);
			copied = start + length;
		}
		at = start + length;
	}
	if copied == 0 {
		// Only look-alike params: nothing was a marker.
		return Cow::Borrowed(line);
	}
	out.push_str(&line[copied..]);
	Cow::Owned(out)
}

/// Encode padding with REP, which tmux expands into identical styled cells:
/// every run of eight or more spaces outside escape sequences becomes one
/// space plus `CSI n b`.
pub(crate) fn compact_replay_spaces(line: &str) -> Cow<'_, str> {
	const RUN: &[u8] = b"        ";
	let bytes = line.as_bytes();
	let mut copied = 0;
	let mut output = String::new();
	let mut offset = 0;
	while offset < bytes.len() {
		let Some(spaces) = memmem::find(&bytes[offset..], RUN).map(|at| offset + at) else {
			break;
		};
		if let Some(escape) = memchr(ESC, &bytes[offset..spaces]).map(|at| offset + at) {
			// Only inspect text outside CSI/OSC. Unknown control strings (for
			// example DCS payloads) must remain byte-for-byte unchanged.
			if !matches!(bytes.get(escape + 1), Some(b'[' | b']')) {
				return Cow::Borrowed(line);
			}
			let Some(end) = ansi_sequence_end(line, escape) else {
				break;
			};
			offset = end;
			continue;
		}
		let mut end = spaces + RUN.len();
		while bytes.get(end) == Some(&b' ') {
			end += 1;
		}
		output.push_str(&line[copied..spaces]);
		// Writing to a String cannot fail.
		let _ = write!(output, " \x1b[{}b", end - spaces - 1);
		copied = end;
		offset = end;
	}
	if copied == 0 {
		return Cow::Borrowed(line);
	}
	output.push_str(&line[copied..]);
	Cow::Owned(output)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn visible_width_skips_escapes_and_scales_text_sizing_spans() {
		assert_eq!(visible_width(""), 0);
		assert_eq!(visible_width("\x1b[1mbold\x1b[0m"), 4);
		assert_eq!(visible_width("a\tb"), 2 + DEFAULT_TAB_WIDTH as u32);
		assert_eq!(visible_width("ab\x1b_pi:c\x07cd"), 4);
		assert_eq!(visible_width("\x1b]66;s=2;Title\x1b\\"), 10);
		assert_eq!(visible_width("│ 中文 │"), 8);
	}

	#[test]
	fn truncation_keeps_escapes_and_omits_the_ellipsis() {
		assert!(matches!(truncate_to_width("fits", 4), Cow::Borrowed("fits")));
		assert_eq!(truncate_to_width("\x1b[31mtoo wide\x1b[0m", 3), "\x1b[31mtoo\x1b[0m");
	}

	#[test]
	fn ansi_sequence_end_finds_csi_osc_and_two_byte_escapes() {
		assert_eq!(ansi_sequence_end("\x1b[38;5;1mx", 0), Some(9));
		assert_eq!(ansi_sequence_end("ab\x1b[Kx", 2), Some(5));
		assert_eq!(ansi_sequence_end("\x1b]8;;u\x07x", 0), Some(7));
		assert_eq!(ansi_sequence_end("\x1b]8;;u\x1b\\x", 0), Some(8));
		assert_eq!(ansi_sequence_end("\x1b7x", 0), Some(2));
		assert_eq!(ansi_sequence_end("\x1b中x", 0), Some(4));
		// Unterminated sequences.
		assert_eq!(ansi_sequence_end("\x1b[38;5", 0), None);
		assert_eq!(ansi_sequence_end("\x1b]8;;u", 0), None);
		assert_eq!(ansi_sequence_end("\x1b", 0), None);
	}

	#[test]
	fn osc66_scale_is_the_largest_valid_span_scale() {
		assert!(!is_osc66_line("plain \x1b[1mtext\x1b[0m"));
		assert_eq!(osc66_max_scale("plain"), 1);
		let heading = "\x1b]66;s=2;Title\x1b\\";
		assert!(is_osc66_line(heading));
		assert_eq!(osc66_max_scale(heading), 2);
		assert_eq!(osc66_max_scale("\x1b]66;w=4:s=3:h=1;a\x07 \x1b]66;s=2;b\x1b\\"), 3);
		assert_eq!(osc66_max_scale("\x1b]66;s=2;a\x07\x1b]66;s=5;b\x07"), 5);
		// Out-of-range, malformed and unscaled spans leave the scale at 1.
		assert_eq!(osc66_max_scale("\x1b]66;s=8;a\x07"), 1);
		assert_eq!(osc66_max_scale("\x1b]66;s=x;a\x07"), 1);
		assert_eq!(osc66_max_scale("\x1b]66;xs=3;a\x07"), 1);
		assert_eq!(osc66_max_scale("\x1b]66;;a\x07"), 1);
		// A span that never closes is not a span.
		assert_eq!(osc66_max_scale("\x1b]66;s=3;a"), 1);
		assert_eq!(osc66_max_scale("\x1b]66;s=3"), 1);
	}

	#[test]
	fn spacer_rows_beneath_a_scaled_heading_report_its_width() {
		let double = "\x1b]66;s=2;Title\x1b\\";
		let triple = "\x1b]66;s=3;Hi\x1b\\";
		let lines = ["intro", double, "", "body", triple, "", "", "", "tail"];
		// The heading itself, ordinary rows, and the first row are not spacers.
		assert_eq!(osc66_spacer_glyph_width(&lines, 0), None);
		assert_eq!(osc66_spacer_glyph_width(&lines, 1), None);
		assert_eq!(osc66_spacer_glyph_width(&lines, 3), None);
		assert_eq!(osc66_spacer_glyph_width(&lines, 2), Some(10));
		// A scale-3 heading reserves exactly two rows.
		assert_eq!(osc66_spacer_glyph_width(&lines, 5), Some(6));
		assert_eq!(osc66_spacer_glyph_width(&lines, 6), Some(6));
		assert_eq!(osc66_spacer_glyph_width(&lines, 7), None);
		assert_eq!(osc66_spacer_glyph_width(&lines, 9), None);
		// Blank rows under unscaled text or at the top of the frame.
		assert_eq!(osc66_spacer_glyph_width(&["text", ""], 1), None);
		assert_eq!(osc66_spacer_glyph_width(&["", ""], 1), None);
		assert_eq!(osc66_spacer_glyph_width(&["\x1b]66;s=1;x\x07", ""], 1), None);
	}

	#[test]
	fn spacer_scan_stops_after_six_blank_rows() {
		let heading = "\x1b]66;s=7;X\x1b\\";
		let mut lines = vec![heading];
		lines.extend([""; 8]);
		for index in 1..=6 {
			assert_eq!(osc66_spacer_glyph_width(&lines, index), Some(7), "{index}");
		}
		assert_eq!(osc66_spacer_glyph_width(&lines, 7), None);
		assert_eq!(osc66_spacer_glyph_width(&lines, 8), None);
	}

	#[test]
	fn reflowed_rows_count_wrapped_physical_rows() {
		let window = ["", "abcd", "abcdefgh", "abcdefghi", "\x1b[1mabcdefgh\x1b[0m"];
		// Rows that fit count once each, blank rows included.
		assert_eq!(reflowed_rows(&window, 0, 5, 80), 5);
		assert_eq!(reflowed_rows(&window, 0, 5, 4), 1 + 1 + 2 + 3 + 2);
		assert_eq!(reflowed_rows(&window, 2, 4, 4), 5);
		// Out-of-range bounds clamp; a zero width counts as one column.
		assert_eq!(reflowed_rows(&window, 3, 99, 4), 5);
		assert_eq!(reflowed_rows(&window, 9, 12, 4), 0);
		assert_eq!(reflowed_rows(&window, 4, 2, 4), 0);
		assert_eq!(reflowed_rows(&window, 1, 2, 0), 4);
	}

	#[test]
	fn normalization_decomposes_thai_and_lao_am() {
		assert!(matches!(normalize_terminal_output("plain ก"), Cow::Borrowed(_)));
		assert_eq!(normalize_terminal_output("น\u{0e33}"), "น\u{0e4d}\u{0e32}");
		assert_eq!(
			normalize_terminal_output("a\u{0eb3}b\u{0e33}c"),
			"a\u{0ecd}\u{0eb2}b\u{0e4d}\u{0e32}c"
		);
		// The decomposition keeps the cell width.
		assert_eq!(
			visible_width(&normalize_terminal_output("น\u{0e33}")),
			visible_width("น\u{0e33}")
		);
	}

	#[test]
	fn strips_only_extension_link_markers() {
		// Every marker form omp draws is stripped: numbered or not, BEL or ST
		// terminated.
		for params in ["id=omp-extension-link", "id=omp-extension-link-12"] {
			for end in ["\x07", "\x1b\\"] {
				let line = format!("a\x1b]8;{params};demo:x{end}b\x1b]8;;{end}c");
				assert_eq!(strip_extension_link_markers(&line), "abc");
			}
		}
		// A hyperlink omp did not mark is kept, whatever its scheme.
		let foreign = "See \x1b]8;;demo:open/7\x07the details\x1b]8;;\x07.";
		assert!(matches!(strip_extension_link_markers(foreign), Cow::Borrowed(_)));
		// Look-alike params are another program's hyperlink.
		for params in ["id=omp-extension-link-", "id=omp-extension-link-1a", "id=omp-extension-linkx"]
		{
			let line = format!("a\x1b]8;{params};demo:x\x07b\x1b]8;;\x07c");
			assert_eq!(strip_extension_link_markers(&line), line);
		}
	}

	#[test]
	fn marker_stripping_keeps_styles_and_neighbouring_hyperlinks() {
		// The label's styling stays; only the OSC 8 open and close go.
		let drawn = concat!(
			"\x1b]8;id=omp-extension-link-7;demo:x\x07",
			"\x1b[4:4m\x1b[38;2;0;136;250mb\x1b[0m",
			"\x1b[4:4mc\x1b[39m\x1b[4:0m\x1b]8;;\x07",
		);
		assert_eq!(
			strip_extension_link_markers(drawn),
			"\x1b[4:4m\x1b[38;2;0;136;250mb\x1b[0m\x1b[4:4mc\x1b[39m\x1b[4:0m"
		);
		// A foreign hyperlink after a marker keeps both its open and its close;
		// a marker's wrapped continuation row has no close of its own.
		let row = concat!(
			"\x1b]8;id=omp-extension-link-1;demo:a\x07label\x1b]8;;\x07 then ",
			"\x1b]8;;https://example.com\x07docs\x1b]8;;\x07 ",
			"\x1b]8;id=omp-extension-link-2;demo:b\x07wrapped",
		);
		assert_eq!(
			strip_extension_link_markers(row),
			"label then \x1b]8;;https://example.com\x07docs\x1b]8;;\x07 wrapped"
		);
		// A close with nothing open is not omp's.
		let stray = "x\x1b]8;;\x07y \x1b]8;id=omp-extension-link;demo:a\x07z";
		assert_eq!(strip_extension_link_markers(stray), "x\x1b]8;;\x07y z");
	}

	#[test]
	fn replay_padding_becomes_rep() {
		assert!(matches!(compact_replay_spaces("short    gap"), Cow::Borrowed(_)));
		assert_eq!(compact_replay_spaces("a        b"), "a \x1b[7bb");
		assert_eq!(compact_replay_spaces(&format!("a{}", " ".repeat(40))), "a \x1b[39b");
		assert_eq!(compact_replay_spaces(&format!("{0}x{0}", " ".repeat(10))), " \x1b[9bx \x1b[9b");
		// Styled padding keeps its escapes; the run after them is still encoded.
		assert_eq!(
			compact_replay_spaces(&format!("\x1b[48;5;236m{}\x1b[0m│", " ".repeat(12))),
			"\x1b[48;5;236m \x1b[11b\x1b[0m│"
		);
		// Spaces inside an OSC payload are not padding.
		let link = format!("\x1b]8;;file:///a{}b\x07x\x1b]8;;\x07", " ".repeat(9));
		assert!(matches!(compact_replay_spaces(&link), Cow::Borrowed(_)));
	}

	#[test]
	fn replay_compaction_leaves_rows_with_unknown_control_strings_untouched() {
		// A DCS payload must stay byte-for-byte, even after earlier padding.
		let row = format!("{0}\x1bPq~~{0}\x1b\\", " ".repeat(9));
		assert!(matches!(compact_replay_spaces(&row), Cow::Borrowed(_)));
		// An unterminated escape ends the scan but keeps what was encoded.
		let row = format!("a{0}\x1b[38;5{0}", " ".repeat(9));
		assert_eq!(compact_replay_spaces(&row), format!("a \x1b[8b\x1b[38;5{}", " ".repeat(9)));
	}
}
