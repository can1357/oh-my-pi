//! SGR coalescing.
//!
//! The renderer's component tree emits a styled span as
//! `<set-color>text<reset>`, so adjacent spans produce runs of byte-adjacent
//! SGR sequences (e.g. a `CSI 39 m` fg-reset immediately followed by the next
//! span's `CSI 38;2;r;g;b m`). Two byte-adjacent SGR sequences are semantically
//! identical to one SGR carrying both parameter lists (SGR params apply
//! left-to-right), so merging the run into a single `CSI … m` is
//! behavior-preserving: it drops the redundant `ESC[`/`m` framing and lets the
//! terminal dispatch one SGR instead of several. On a real transcript ~40% of
//! all SGR sequences are collapsible this way, which meaningfully cuts the
//! per-frame byte volume and SGR-dispatch count a slow (xterm.js/WebGL)
//! terminal must process. On by default; `PI_NO_SGR_COALESCE=1` disables it
//! (the host resolves the flag into `Facts::sgr_coalesce`).

use std::borrow::Cow;

use memchr::memmem;

const ESC: u8 = 0x1b;

/// Max parameter tokens per emitted merged SGR. Kept well under xterm.js's
/// 32-param cap (and the tighter limits of some real terminals) so a long
/// adjacent run is split into several valid CSIs instead of overflowing one.
const MERGE_TOKEN_CAP: usize = 16;

const fn is_sgr_param_byte(byte: u8) -> bool {
	byte.is_ascii_digit() || byte == b';' || byte == b':'
}

/// Byte offset of the next `ESC [` at or after `from`.
fn find_csi(bytes: &[u8], from: usize) -> Option<usize> {
	memmem::find(bytes.get(from..)?, b"\x1b[").map(|at| from + at)
}

/// Scan the parameter bytes starting at `start`; returns the offset just past
/// them and the number of `;`/`:`-separated tokens.
const fn scan_params(bytes: &[u8], start: usize) -> (usize, usize) {
	let mut end = start;
	let mut tokens = 1;
	while end < bytes.len() && is_sgr_param_byte(bytes[end]) {
		if bytes[end] == b';' || bytes[end] == b':' {
			tokens += 1;
		}
		end += 1;
	}
	(end, tokens)
}

/// True when the parameter list `bytes[start..end]` ends mid extended-color
/// spec in the ambiguous semicolon form: `38/48/58;2` with fewer than three
/// channel values, or `38/48/58;5` with no palette index. Concatenating
/// another list after such a run would let the next code be absorbed as the
/// missing channel/index (e.g. `38;2;255;0` + `31` → `38;2;255;0;31`, where
/// `31` becomes blue instead of a standalone fg-red), changing the rendered
/// color. The self-delimiting colon form (`38:2::r:g:b`) is unambiguous — its
/// tokens never equal a bare `38`, so the scan treats it as a complete unit
/// and merging stays safe.
fn ends_with_incomplete_extended_color(bytes: &[u8], start: usize, end: usize) -> bool {
	let mut token_start = start;
	let mut needs_mode = false;
	let mut values_remaining = 0u8;
	for i in start..=end {
		if i != end && bytes[i] != b';' {
			continue;
		}
		let token = &bytes[token_start..i];
		if values_remaining > 0 {
			values_remaining -= 1;
		} else if needs_mode && (token == b"2" || token == b"5") {
			values_remaining = if token == b"2" { 3 } else { 1 };
			needs_mode = false;
		} else {
			// An unrecognized mode is also a standalone token: `38;48;5`
			// still ends in an incomplete background palette spec.
			needs_mode = matches!(token, [b'3'..=b'5', b'8']);
		}
		token_start = i + 1;
	}
	needs_mode || values_remaining > 0
}

/// Merge runs of byte-adjacent SGR sequences (`CSI [0-9;:]* m`) into one. Only
/// CSI-SGR sequences are touched; text, cursor moves, OSC, hyperlinks and image
/// payloads pass through verbatim. Isolated sequences cost no allocation;
/// output is built only at merged boundaries or empty resets that need
/// normalization within an adjacent run. With `enabled` false the line is
/// returned as is.
pub(crate) fn coalesce_adjacent_sgr(line: &str, enabled: bool) -> Cow<'_, str> {
	if !enabled {
		return Cow::Borrowed(line);
	}
	let bytes = line.as_bytes();
	let n = bytes.len();
	let mut out = String::new();
	let mut copied_upto = 0;
	let mut next = find_csi(bytes, 0);
	while let Some(i) = next {
		// Scan a candidate SGR sequence: ESC [ <params> m.
		let mut start = i + 2;
		let (mut j, mut group_tokens) = scan_params(bytes, start);
		if j >= n || bytes[j] != b'm' {
			// Not an SGR (e.g. cursor move); leave it in the pending region.
			next = find_csi(bytes, j);
			continue;
		}

		let mut adjacent = false;
		let mut k = j + 1;
		while k + 1 < n && bytes[k] == ESC && bytes[k + 1] == b'[' {
			let next_start = k + 2;
			let (p, tokens) = scan_params(bytes, next_start);
			if p >= n || bytes[p] != b'm' {
				break;
			}
			adjacent = true;

			// Keep the boundary if the preceding list could absorb a missing
			// channel/index, or if merging would overflow the parameter cap.
			// Otherwise replace only `m ESC [` with `;`, keeping the source
			// untouched until a boundary actually merges. Empty lists in an
			// adjacent run normalize to `0`, including at a guarded boundary.
			if group_tokens + tokens <= MERGE_TOKEN_CAP
				&& !ends_with_incomplete_extended_color(bytes, start, j)
			{
				// Every cut sits next to an ASCII byte, so the slices stay on
				// character boundaries.
				out.push_str(&line[copied_upto..j]);
				out.push_str(if start == j { "0;" } else { ";" });
				copied_upto = next_start;
				group_tokens += tokens;
			} else {
				if start == j {
					out.push_str(&line[copied_upto..j]);
					out.push('0');
					copied_upto = j;
				}
				group_tokens = tokens;
			}
			start = next_start;
			j = p;
			k = p + 1;
		}
		if adjacent && start == j {
			out.push_str(&line[copied_upto..j]);
			out.push('0');
			copied_upto = j;
		}
		next = find_csi(bytes, k);
	}
	if copied_upto == 0 {
		return Cow::Borrowed(line);
	}
	out.push_str(&line[copied_upto..]);
	Cow::Owned(out)
}

#[cfg(test)]
mod tests {
	use std::fmt::Write as _;

	use super::*;

	fn coalesce(line: &str) -> Cow<'_, str> {
		coalesce_adjacent_sgr(line, true)
	}

	/// Parameter lists of every `CSI [0-9;:]* m` in `text`.
	fn sgr_sequences(text: &str) -> Vec<&str> {
		let bytes = text.as_bytes();
		let mut found = Vec::new();
		let mut next = find_csi(bytes, 0);
		while let Some(i) = next {
			let (end, _) = scan_params(bytes, i + 2);
			if end < bytes.len() && bytes[end] == b'm' {
				found.push(&text[i + 2..end]);
			}
			next = find_csi(bytes, end);
		}
		found
	}

	fn max_param_tokens(text: &str) -> usize {
		sgr_sequences(text)
			.iter()
			.map(|body| {
				if body.is_empty() {
					1
				} else {
					body.split([';', ':']).count()
				}
			})
			.max()
			.unwrap_or(0)
	}

	/// Rendition a terminal holds after applying SGR parameter lists in order.
	#[derive(Clone, Debug, Default, PartialEq)]
	struct Rendition {
		fg:     Option<Vec<u32>>,
		bg:     Option<Vec<u32>>,
		bold:   bool,
		italic: bool,
	}

	impl Rendition {
		fn apply(&mut self, params: &str) {
			let codes: Vec<u32> = params
				.split(';')
				.map(|code| code.parse().unwrap_or(0))
				.collect();
			let mut index = 0;
			while index < codes.len() {
				let code = codes[index];
				index += 1;
				match code {
					0 => *self = Self::default(),
					1 => self.bold = true,
					3 => self.italic = true,
					30..=37 => self.fg = Some(vec![code]),
					39 => self.fg = None,
					40..=47 => self.bg = Some(vec![code]),
					49 => self.bg = None,
					38 | 48 => {
						// An extended color consumes whatever channels follow, as a
						// terminal's parser does.
						let take = match codes.get(index) {
							Some(2) => 4,
							Some(5) => 2,
							_ => 0,
						};
						let end = codes.len().min(index + take);
						let color = Some(codes[index..end].to_vec());
						index = end;
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
	}

	/// Every visible character with the rendition it is painted in.
	fn painted(text: &str) -> Vec<(char, Rendition)> {
		let mut cells = Vec::new();
		let mut rendition = Rendition::default();
		let mut rest = text;
		while let Some(ch) = rest.chars().next() {
			if let Some(sequence) = rest.strip_prefix("\x1b[") {
				let end = sequence
					.find('m')
					.expect("fixture holds only SGR sequences");
				rendition.apply(&sequence[..end]);
				rest = &sequence[end + 1..];
				continue;
			}
			cells.push((ch, rendition.clone()));
			rest = &rest[ch.len_utf8()..];
		}
		cells
	}

	#[test]
	fn merges_byte_adjacent_sgr_sequences_into_one_csi() {
		// A fg-reset immediately followed by a fg-set: the framing between them
		// is pure overhead — both fold into a single SGR carrying both
		// parameters.
		let out = coalesce("a\x1b[39m\x1b[38;2;1;2;3mb");
		assert_eq!(out, "a\x1b[39;38;2;1;2;3mb");
		assert_eq!(sgr_sequences(&out).len(), 1);
	}

	#[test]
	fn normalizes_an_empty_parameter_reset_to_zero_when_merging() {
		assert_eq!(coalesce("\x1b[m\x1b[1mx"), "\x1b[0;1mx");
	}

	#[test]
	fn does_not_merge_sgr_separated_by_visible_content() {
		// A glyph renders with the intermediate state, so the sequences must stay
		// distinct.
		let input = "\x1b[31mA\x1b[32mB";
		assert!(matches!(coalesce(input), Cow::Borrowed(line) if line == input));
	}

	#[test]
	fn leaves_non_sgr_control_sequences_untouched() {
		// Cursor moves, EL and OSC share the CSI/OSC introducer but are not SGR.
		let input = "\x1b[5;1H\x1b[K\x1b]8;;https://x\x07link\x1b]8;;\x07";
		assert_eq!(coalesce(input), input);
	}

	#[test]
	fn caps_each_emitted_csi_so_a_long_adjacent_run_never_overflows() {
		// 10 adjacent truecolor sets = 50 parameter tokens; a single unbounded
		// merge would exceed xterm.js's 32-param cap and corrupt the colors.
		let mut run = String::from("x");
		for i in 0..10 {
			let _ = write!(run, "\x1b[38;2;{i};{i};{i}m");
		}
		run.push('y');
		let out = coalesce(&run);
		assert!(max_param_tokens(&out) <= 16);
		// Still strictly fewer sequences than the input (merging happened).
		assert!(sgr_sequences(&out).len() < 10);
		assert_eq!(painted(&out), painted(&run));
	}

	#[test]
	fn paints_identically_to_the_original() {
		// The contract that matters: a coalesced line must paint the exact same
		// glyphs, foreground and background colors as the original.
		let styled = concat!(
			"\x1b[38;2;137;180;250mfn\x1b[39m \x1b[38;2;166;227;161mmain\x1b[39m",
			"\x1b[48;2;24;24;37m()\x1b[49m \x1b[1m\x1b[3m{}\x1b[0m end",
		);
		let coalesced = coalesce(styled);
		// The line did contain merge-able runs.
		assert_ne!(coalesced, styled);
		assert_eq!(painted(&coalesced), painted(styled));
	}

	#[test]
	fn does_not_merge_across_an_incomplete_truecolor_introducer() {
		// `38;2;255;0` is missing its blue channel. Concatenating the next list
		// would let `31` be consumed as that channel (`38;2;255;0;31`) instead of
		// staying a standalone fg-red, changing the rendered color.
		let input = "\x1b[38;2;255;0m\x1b[31mX";
		assert_eq!(coalesce(input), input);
		assert_eq!(painted(&coalesce(input)), painted(input));
	}

	#[test]
	fn does_not_merge_across_an_incomplete_indexed_color_introducer() {
		// `38;5` (256-color) is missing its palette index; `31` must not be
		// absorbed.
		let input = "\x1b[38;5m\x1b[31mX";
		assert_eq!(coalesce(input), input);
	}

	#[test]
	fn preserves_incomplete_color_boundaries_including_nested_introducers() {
		for introducer in ["38", "48", "58"] {
			for params in [
				introducer.to_owned(),
				format!("{introducer};2"),
				format!("{introducer};2;255"),
				format!("{introducer};2;255;0"),
				format!("{introducer};5"),
				format!("{introducer};48;5"),
			] {
				let input = format!("\x1b[{params}m\x1b[31mX");
				assert_eq!(coalesce(&input), input);
			}
		}
	}

	#[test]
	fn does_not_read_color_values_or_colon_subparameters_as_introducers() {
		for params in ["38;2;48;58;38", "48;5;38", "58:2::38:48:58", "38;2;;;"] {
			assert_eq!(coalesce(&format!("\x1b[{params}m\x1b[31mX")), format!("\x1b[{params};31mX"));
		}
	}

	#[test]
	fn counts_colon_subparameters_toward_the_merge_cap_without_splitting_a_color() {
		let out = coalesce("\x1b[38:2::1:2:3m\x1b[1;3;4;5;6;7;8;9;10;11m\x1b[31mX");
		assert_eq!(out, "\x1b[38:2::1:2:3;1;3;4;5;6;7;8;9;10;11m\x1b[31mX");
		assert!(max_param_tokens(&out) <= 16);
	}

	#[test]
	fn still_merges_a_complete_extended_color_followed_by_another_code() {
		// `38;2;255;0;0` consumes exactly r,g,b; a trailing `31` then starts
		// fresh, so concatenation stays behavior-preserving and the merge win is
		// kept.
		assert_eq!(coalesce("\x1b[38;2;255;0;0m\x1b[31mX"), "\x1b[38;2;255;0;0;31mX");
	}

	#[test]
	fn normalizes_an_empty_reset_at_a_guarded_boundary_and_at_the_run_end() {
		// The incomplete color keeps its boundary; the empty list after it still
		// becomes an explicit `0`.
		assert_eq!(coalesce("\x1b[38;5m\x1b[mX"), "\x1b[38;5m\x1b[0mX");
		assert_eq!(coalesce("\x1b[1m\x1b[mX"), "\x1b[1;0mX");
	}

	#[test]
	fn disabled_coalescing_returns_the_line_untouched() {
		let input = "a\x1b[39m\x1b[38;2;1;2;3mb";
		assert!(matches!(coalesce_adjacent_sgr(input, false), Cow::Borrowed(line) if line == input));
	}

	#[test]
	fn keeps_multibyte_text_around_merged_runs() {
		assert_eq!(coalesce("│\x1b[1m\x1b[31m中\x1b[0m\x1b[2m文"), "│\x1b[1;31m中\x1b[0;2m文");
	}
}
