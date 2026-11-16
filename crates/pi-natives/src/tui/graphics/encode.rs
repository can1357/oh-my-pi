//! Inline-image escape sequences: Kitty graphics (chunked transmits, direct
//! and virtual placements, Unicode-placeholder grids), iTerm2 inline images,
//! and the cell-box fit every protocol shares.
//!
//! Ported from pi-tui's `terminal-capabilities.ts` image half and
//! `kitty-graphics.ts`; the byte layout of every sequence is unchanged.

use std::fmt::{self, Write as _};

/// Kitty Unicode placeholder base character (U+10EEEE, Plane 16 PUA).
pub const KITTY_PLACEHOLDER: char = '\u{10eeee}';

/// Row/column diacritics (Unicode combining class 230, no decomposition) that
/// name a placeholder cell's row and column. Index `i` → codepoint. Derived
/// from kitty `gen/rowcolumn-diacritics.txt` (Unicode 6.0.0 NSM set): 297
/// entries, so one image addresses up to 297 rows/columns without
/// id-high-byte tricks.
const ROWCOLUMN_DIACRITICS: [char; 297] = [
	'\u{305}',
	'\u{30d}',
	'\u{30e}',
	'\u{310}',
	'\u{312}',
	'\u{33d}',
	'\u{33e}',
	'\u{33f}',
	'\u{346}',
	'\u{34a}',
	'\u{34b}',
	'\u{34c}',
	'\u{350}',
	'\u{351}',
	'\u{352}',
	'\u{357}',
	'\u{35b}',
	'\u{363}',
	'\u{364}',
	'\u{365}',
	'\u{366}',
	'\u{367}',
	'\u{368}',
	'\u{369}',
	'\u{36a}',
	'\u{36b}',
	'\u{36c}',
	'\u{36d}',
	'\u{36e}',
	'\u{36f}',
	'\u{483}',
	'\u{484}',
	'\u{485}',
	'\u{486}',
	'\u{487}',
	'\u{592}',
	'\u{593}',
	'\u{594}',
	'\u{595}',
	'\u{597}',
	'\u{598}',
	'\u{599}',
	'\u{59c}',
	'\u{59d}',
	'\u{59e}',
	'\u{59f}',
	'\u{5a0}',
	'\u{5a1}',
	'\u{5a8}',
	'\u{5a9}',
	'\u{5ab}',
	'\u{5ac}',
	'\u{5af}',
	'\u{5c4}',
	'\u{610}',
	'\u{611}',
	'\u{612}',
	'\u{613}',
	'\u{614}',
	'\u{615}',
	'\u{616}',
	'\u{617}',
	'\u{657}',
	'\u{658}',
	'\u{659}',
	'\u{65a}',
	'\u{65b}',
	'\u{65d}',
	'\u{65e}',
	'\u{6d6}',
	'\u{6d7}',
	'\u{6d8}',
	'\u{6d9}',
	'\u{6da}',
	'\u{6db}',
	'\u{6dc}',
	'\u{6df}',
	'\u{6e0}',
	'\u{6e1}',
	'\u{6e2}',
	'\u{6e4}',
	'\u{6e7}',
	'\u{6e8}',
	'\u{6eb}',
	'\u{6ec}',
	'\u{730}',
	'\u{732}',
	'\u{733}',
	'\u{735}',
	'\u{736}',
	'\u{73a}',
	'\u{73d}',
	'\u{73f}',
	'\u{740}',
	'\u{741}',
	'\u{743}',
	'\u{745}',
	'\u{747}',
	'\u{749}',
	'\u{74a}',
	'\u{7eb}',
	'\u{7ec}',
	'\u{7ed}',
	'\u{7ee}',
	'\u{7ef}',
	'\u{7f0}',
	'\u{7f1}',
	'\u{7f3}',
	'\u{816}',
	'\u{817}',
	'\u{818}',
	'\u{819}',
	'\u{81b}',
	'\u{81c}',
	'\u{81d}',
	'\u{81e}',
	'\u{81f}',
	'\u{820}',
	'\u{821}',
	'\u{822}',
	'\u{823}',
	'\u{825}',
	'\u{826}',
	'\u{827}',
	'\u{829}',
	'\u{82a}',
	'\u{82b}',
	'\u{82c}',
	'\u{82d}',
	'\u{951}',
	'\u{953}',
	'\u{954}',
	'\u{f82}',
	'\u{f83}',
	'\u{f86}',
	'\u{f87}',
	'\u{135d}',
	'\u{135e}',
	'\u{135f}',
	'\u{17dd}',
	'\u{193a}',
	'\u{1a17}',
	'\u{1a75}',
	'\u{1a76}',
	'\u{1a77}',
	'\u{1a78}',
	'\u{1a79}',
	'\u{1a7a}',
	'\u{1a7b}',
	'\u{1a7c}',
	'\u{1b6b}',
	'\u{1b6d}',
	'\u{1b6e}',
	'\u{1b6f}',
	'\u{1b70}',
	'\u{1b71}',
	'\u{1b72}',
	'\u{1b73}',
	'\u{1cd0}',
	'\u{1cd1}',
	'\u{1cd2}',
	'\u{1cda}',
	'\u{1cdb}',
	'\u{1ce0}',
	'\u{1dc0}',
	'\u{1dc1}',
	'\u{1dc3}',
	'\u{1dc4}',
	'\u{1dc5}',
	'\u{1dc6}',
	'\u{1dc7}',
	'\u{1dc8}',
	'\u{1dc9}',
	'\u{1dcb}',
	'\u{1dcc}',
	'\u{1dd1}',
	'\u{1dd2}',
	'\u{1dd3}',
	'\u{1dd4}',
	'\u{1dd5}',
	'\u{1dd6}',
	'\u{1dd7}',
	'\u{1dd8}',
	'\u{1dd9}',
	'\u{1dda}',
	'\u{1ddb}',
	'\u{1ddc}',
	'\u{1ddd}',
	'\u{1dde}',
	'\u{1ddf}',
	'\u{1de0}',
	'\u{1de1}',
	'\u{1de2}',
	'\u{1de3}',
	'\u{1de4}',
	'\u{1de5}',
	'\u{1de6}',
	'\u{1dfe}',
	'\u{20d0}',
	'\u{20d1}',
	'\u{20d4}',
	'\u{20d5}',
	'\u{20d6}',
	'\u{20d7}',
	'\u{20db}',
	'\u{20dc}',
	'\u{20e1}',
	'\u{20e7}',
	'\u{20e9}',
	'\u{20f0}',
	'\u{2cef}',
	'\u{2cf0}',
	'\u{2cf1}',
	'\u{2de0}',
	'\u{2de1}',
	'\u{2de2}',
	'\u{2de3}',
	'\u{2de4}',
	'\u{2de5}',
	'\u{2de6}',
	'\u{2de7}',
	'\u{2de8}',
	'\u{2de9}',
	'\u{2dea}',
	'\u{2deb}',
	'\u{2dec}',
	'\u{2ded}',
	'\u{2dee}',
	'\u{2def}',
	'\u{2df0}',
	'\u{2df1}',
	'\u{2df2}',
	'\u{2df3}',
	'\u{2df4}',
	'\u{2df5}',
	'\u{2df6}',
	'\u{2df7}',
	'\u{2df8}',
	'\u{2df9}',
	'\u{2dfa}',
	'\u{2dfb}',
	'\u{2dfc}',
	'\u{2dfd}',
	'\u{2dfe}',
	'\u{2dff}',
	'\u{a66f}',
	'\u{a67c}',
	'\u{a67d}',
	'\u{a6f0}',
	'\u{a6f1}',
	'\u{a8e0}',
	'\u{a8e1}',
	'\u{a8e2}',
	'\u{a8e3}',
	'\u{a8e4}',
	'\u{a8e5}',
	'\u{a8e6}',
	'\u{a8e7}',
	'\u{a8e8}',
	'\u{a8e9}',
	'\u{a8ea}',
	'\u{a8eb}',
	'\u{a8ec}',
	'\u{a8ed}',
	'\u{a8ee}',
	'\u{a8ef}',
	'\u{a8f0}',
	'\u{a8f1}',
	'\u{aab0}',
	'\u{aab2}',
	'\u{aab3}',
	'\u{aab7}',
	'\u{aab8}',
	'\u{aabe}',
	'\u{aabf}',
	'\u{aac1}',
	'\u{fe20}',
	'\u{fe21}',
	'\u{fe22}',
	'\u{fe23}',
	'\u{fe24}',
	'\u{fe25}',
	'\u{fe26}',
	'\u{10a0f}',
	'\u{10a38}',
	'\u{1d185}',
	'\u{1d186}',
	'\u{1d187}',
	'\u{1d188}',
	'\u{1d189}',
	'\u{1d1aa}',
	'\u{1d1ab}',
	'\u{1d1ac}',
	'\u{1d1ad}',
	'\u{1d242}',
	'\u{1d243}',
	'\u{1d244}',
];

/// Largest row/column count expressible with the diacritic table (one cell
/// each).
pub const KITTY_PLACEHOLDER_MAX_CELLS: u32 = ROWCOLUMN_DIACRITICS.len() as u32;

/// Base64 characters per Kitty graphics APC; longer payloads continue in
/// `m=1` chunks.
const KITTY_CHUNK: usize = 4096;

/// Cell size in pixels, as the terminal reported it (`CSI 6 ; h ; w t` /
/// iTerm2 `ReportCellSize`) or the 9×18 default.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CellSize {
	pub width_px:  f64,
	pub height_px: f64,
}

/// Cell box an image is displayed in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fit {
	pub columns: u32,
	pub rows:    u32,
}

/// Fit an image of `width_px`×`height_px` into whole cells.
///
/// Without bounds it takes its intrinsic size, rounded up to whole cells.
/// With either bound it scales (up or down) to the largest box inside them
/// that keeps its aspect ratio: columns round down so the image never
/// overflows the width it was given, rows round up so its height is fully
/// reserved; both are clamped to the bounds and to at least one cell.
pub fn fit(
	width_px: f64,
	height_px: f64,
	max_columns: Option<f64>,
	max_rows: Option<f64>,
	cell: CellSize,
) -> Fit {
	let max_columns = max_columns.map(|columns| columns.floor().max(1.0));
	let max_rows = max_rows.map(|rows| rows.floor().max(1.0));
	if max_columns.is_none() && max_rows.is_none() {
		return Fit {
			columns: cells((width_px / cell.width_px).ceil()),
			rows:    cells((height_px / cell.height_px).ceil()),
		};
	}
	let max_width_px = max_columns.map_or(f64::INFINITY, |columns| columns * cell.width_px);
	let max_height_px = max_rows.map_or(f64::INFINITY, |rows| rows * cell.height_px);
	let scale = (max_width_px / width_px).min(max_height_px / height_px);
	let columns = cells((width_px * scale / cell.width_px).floor());
	let rows = cells((height_px * scale / cell.height_px).ceil());
	Fit {
		columns: max_columns.map_or(columns, |max| columns.min(max as u32)),
		rows:    max_rows.map_or(rows, |max| rows.min(max as u32)),
	}
}

/// A cell count of at least one; a degenerate (NaN) size takes one cell.
const fn cells(count: f64) -> u32 {
	count.max(1.0) as u32
}

/// Open one Kitty graphics APC (`ESC _ G`). Inside tmux it rides the DCS
/// passthrough envelope, which doubles every ESC of the payload: the params
/// and base64 carry none, so only the APC's own introducer and terminator
/// are doubled.
fn open_apc(out: &mut String, tmux: bool) {
	out.push_str(if tmux {
		"\x1bPtmux;\x1b\x1b_G"
	} else {
		"\x1b_G"
	});
}

/// Close an APC opened by [`open_apc`].
fn close_apc(out: &mut String, tmux: bool) {
	out.push_str(if tmux { "\x1b\x1b\\\x1b\\" } else { "\x1b\\" });
}

/// One Kitty graphics APC with `params` and an optional payload.
fn push_apc(out: &mut String, params: fmt::Arguments<'_>, payload: Option<&str>, tmux: bool) {
	open_apc(out, tmux);
	// Writing to a String cannot fail.
	let _ = out.write_fmt(params);
	if let Some(payload) = payload {
		out.push(';');
		out.push_str(payload);
	}
	close_apc(out, tmux);
}

/// Largest char boundary of `data` at or below `at`.
const fn chunk_end(data: &str, mut at: usize) -> usize {
	if at >= data.len() {
		return data.len();
	}
	while !data.is_char_boundary(at) {
		at -= 1;
	}
	at
}

/// Kitty APCs carrying `data` (base64): one APC when it fits a chunk, else
/// the lead params on the first `m=1` chunk, quiet `q=2,m=1` continuations,
/// and a final `q=2,m=0`. Each chunk is wrapped separately inside tmux.
fn chunked_apc(lead: fmt::Arguments<'_>, data: &str, tmux: bool) -> String {
	let chunks = data.len().div_ceil(KITTY_CHUNK).max(1);
	let mut out = String::with_capacity(data.len() + chunks * 32 + 32);
	if data.len() <= KITTY_CHUNK {
		push_apc(&mut out, lead, Some(data), tmux);
		return out;
	}
	let mut offset = 0;
	while offset < data.len() {
		// Base64 is ASCII, so this is `offset + KITTY_CHUNK`; a stray multibyte
		// character only moves the cut to its boundary.
		let mut end = chunk_end(data, offset + KITTY_CHUNK);
		if end == offset {
			end += data[offset..].chars().next().map_or(1, char::len_utf8);
		}
		let chunk = &data[offset..end];
		let last = end == data.len();
		if offset == 0 {
			push_apc(&mut out, format_args!("{lead},m=1"), Some(chunk), tmux);
		} else if last {
			push_apc(&mut out, format_args!("q=2,m=0"), Some(chunk), tmux);
		} else {
			push_apc(&mut out, format_args!("q=2,m=1"), Some(chunk), tmux);
		}
		offset = end;
	}
	out
}

/// Transmit-and-display (`a=T`): the self-contained form for an image
/// without a stable id. `C=1` keeps the cursor at the placement origin.
pub fn kitty_transmit_and_display(data: &str, fit: Fit, tmux: bool) -> String {
	let Fit { columns, rows } = fit;
	chunked_apc(format_args!("a=T,f=100,q=2,C=1,c={columns},r={rows}"), data, tmux)
}

/// Transmit image data only (`a=t`), keyed by `image_id`, without displaying
/// it. Sent once per image: the data then persists in the terminal's store
/// (it survives scroll-off and text clears for images with a non-zero id), so
/// later frames display it with the tiny [`kitty_placement`] instead of
/// re-sending the base64.
pub fn kitty_transmit(data: &str, image_id: u32, tmux: bool) -> String {
	chunked_apc(format_args!("a=t,f=100,q=2,i={image_id}"), data, tmux)
}

/// Display a transmitted image (`a=p`) at the cursor. `C=1` keeps the cursor
/// anchored at the placement origin so the renderer's explicit cursor
/// movement stays the only row accounting. A stable `placement_id` (`p=`)
/// makes a repaint *replace* the placement (moving/resizing it without
/// flicker) instead of stacking a duplicate.
pub fn kitty_placement(image_id: u32, placement_id: u32, fit: Fit, tmux: bool) -> String {
	let Fit { columns, rows } = fit;
	let mut out = String::with_capacity(64);
	if placement_id == 0 {
		push_apc(&mut out, format_args!("a=p,q=2,C=1,i={image_id},c={columns},r={rows}"), None, tmux);
	} else {
		push_apc(
			&mut out,
			format_args!("a=p,q=2,C=1,i={image_id},p={placement_id},c={columns},r={rows}"),
			None,
			tmux,
		);
	}
	out
}

/// Virtual placement (`a=p,U=1`): placeholder cells carrying `image_id`
/// display the transmitted image, scaled to the `c`×`r` box. Re-emitting it
/// with a stable `placement_id` replaces it in place.
fn push_kitty_virtual_placement(
	out: &mut String,
	image_id: u32,
	placement_id: u32,
	fit: Fit,
	tmux: bool,
) {
	let Fit { columns, rows } = fit;
	if placement_id == 0 {
		push_apc(out, format_args!("a=p,U=1,q=2,i={image_id},c={columns},r={rows}"), None, tmux);
	} else {
		push_apc(
			out,
			format_args!("a=p,U=1,q=2,i={image_id},p={placement_id},c={columns},r={rows}"),
			None,
			tmux,
		);
	}
}

/// Whether a `columns`×`rows` placeholder grid fits the diacritic table.
pub const fn kitty_placeholders_fit(fit: Fit) -> bool {
	fit.columns >= 1
		&& fit.rows >= 1
		&& fit.columns <= KITTY_PLACEHOLDER_MAX_CELLS
		&& fit.rows <= KITTY_PLACEHOLDER_MAX_CELLS
}

/// An image as Kitty Unicode-placeholder text: exactly `fit.rows` lines, the
/// first prefixed with the virtual-placement APC, no cursor moves.
///
/// Placeholders render the image as real text cells, so it survives
/// horizontal slicing, reflow and overlapping draws: the image id rides each
/// row's foreground color and the placement id (if any) its underline color,
/// and every cell names its own row+column diacritic (robust to slicing,
/// unlike left-inheritance). See kitty `docs/graphics-protocol.rst`, "Unicode
/// placeholders for relative placements". Callers check
/// [`kitty_placeholders_fit`] first.
pub fn kitty_placeholder_lines(
	image_id: u32,
	placement_id: u32,
	fit: Fit,
	tmux: bool,
) -> Vec<String> {
	let mut lead = String::with_capacity(48);
	let _ = write!(
		lead,
		"\x1b[38;2;{};{};{}m",
		(image_id >> 16) & 0xff,
		(image_id >> 8) & 0xff,
		image_id & 0xff
	);
	if placement_id != 0 {
		let _ = write!(
			lead,
			"\x1b[58:2::{}:{}:{}m",
			(placement_id >> 16) & 0xff,
			(placement_id >> 8) & 0xff,
			placement_id & 0xff
		);
	}
	const RESET: &str = "\x1b[39;59m";
	let columns = fit.columns as usize;
	(0..fit.rows as usize)
		.map(|row| {
			// Placeholder (4 bytes) + two diacritics (≤ 4 bytes each).
			let mut line = String::with_capacity(96 + lead.len() + columns * 12 + RESET.len());
			if row == 0 {
				push_kitty_virtual_placement(&mut line, image_id, placement_id, fit, tmux);
			}
			line.push_str(&lead);
			let row_diacritic = ROWCOLUMN_DIACRITICS.get(row).copied();
			for column in 0..columns {
				line.push(KITTY_PLACEHOLDER);
				line.extend(row_diacritic);
				line.extend(ROWCOLUMN_DIACRITICS.get(column).copied());
			}
			line.push_str(RESET);
			line
		})
		.collect()
}

/// iTerm2 inline image (`OSC 1337 ; File=`), sized in cells.
///
/// The height is the rows reserved for the image, not `auto`: iTerm2
/// resolves `auto` only for a session on screen, so an image written to a
/// background tab is dropped, and its rows stay blank in scrollback too.
/// iTerm2 images are not wrapped for tmux.
pub fn iterm2_inline(data: &str, fit: Fit) -> String {
	let Fit { columns, rows } = fit;
	let mut out = String::with_capacity(data.len() + 64);
	let _ = write!(out, "\x1b]1337;File=inline=1;width={columns};height={rows}:");
	out.push_str(data);
	out.push('\x07');
	out
}

/// SIXEL raster size for a cell box, and the rows it reserves.
///
/// The cell box itself is encoded, so a raster drawn at the cell size
/// (`SvgFigure`) is placed 1:1 instead of resampled. The encoder drops a
/// partial last 6px band rather than letting the terminal pad it into the
/// next row; only a box under one band (sub-6px cells) still takes the rows
/// of a whole one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SixelBox {
	pub width_px:  u32,
	pub height_px: u32,
	pub rows:      u32,
}

pub fn sixel_box(fit: Fit, cell: CellSize) -> SixelBox {
	let height_px = f64::from(fit.rows) * cell.height_px;
	let width_px = f64::from(fit.columns) * cell.width_px;
	let rows = if height_px < 6.0 {
		(6.0 / cell.height_px).ceil() as u32
	} else {
		fit.rows
	};
	SixelBox { width_px: width_px as u32, height_px: height_px as u32, rows }
}

#[cfg(test)]
mod tests {
	use super::*;

	const CELL: CellSize = CellSize { width_px: 10.0, height_px: 10.0 };

	fn wrapped(payload: &str) -> String {
		format!("\x1bPtmux;{}\x1b\\", payload.replace('\x1b', "\x1b\x1b"))
	}

	#[test]
	fn fits_within_both_bounds_preserving_aspect_ratio() {
		assert_eq!(fit(100.0, 100.0, Some(10.0), Some(2.0), CELL), Fit { columns: 2, rows: 2 });
	}

	#[test]
	fn takes_the_intrinsic_size_without_bounds() {
		assert_eq!(fit(100.0, 100.0, None, None, CELL), Fit { columns: 10, rows: 10 });
		assert_eq!(fit(101.0, 1.0, None, None, CELL), Fit { columns: 11, rows: 1 });
	}

	#[test]
	fn scales_to_the_width_bound_and_follows_cell_size() {
		assert_eq!(fit(100.0, 100.0, Some(10.0), Some(10.0), CELL).columns, 10);
		let wide = CellSize { width_px: 20.0, height_px: 10.0 };
		assert_eq!(fit(100.0, 100.0, Some(10.0), Some(10.0), wide).columns, 5);
		assert_eq!(fit(100.0, 100.0, Some(10.0), None, CELL), Fit { columns: 10, rows: 10 });
		// Fractional bounds floor; zero bounds still leave one cell.
		assert_eq!(fit(100.0, 100.0, Some(3.9), Some(0.0), CELL), Fit { columns: 1, rows: 1 });
	}

	#[test]
	fn encodes_kitty_commands_bare_and_inside_tmux() {
		let one = Fit { columns: 1, rows: 1 };
		let box3x2 = Fit { columns: 3, rows: 2 };
		let cases = [
			(
				kitty_transmit_and_display("AA==", one, false),
				"\x1b_Ga=T,f=100,q=2,C=1,c=1,r=1;AA==\x1b\\",
			),
			(kitty_transmit("AA==", 9, false), "\x1b_Ga=t,f=100,q=2,i=9;AA==\x1b\\"),
			(kitty_placement(9, 9, box3x2, false), "\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\"),
			(kitty_placement(9, 0, box3x2, false), "\x1b_Ga=p,q=2,C=1,i=9,c=3,r=2\x1b\\"),
		];
		for (bare, expected) in &cases {
			assert_eq!(bare, expected);
		}
		assert_eq!(kitty_transmit("AA==", 9, true), wrapped("\x1b_Ga=t,f=100,q=2,i=9;AA==\x1b\\"));
		assert_eq!(
			kitty_transmit_and_display("AA==", one, true),
			wrapped("\x1b_Ga=T,f=100,q=2,C=1,c=1,r=1;AA==\x1b\\")
		);
		assert_eq!(
			kitty_placement(9, 9, box3x2, true),
			wrapped("\x1b_Ga=p,q=2,C=1,i=9,p=9,c=3,r=2\x1b\\")
		);
		let mut virtual_placement = String::new();
		push_kitty_virtual_placement(&mut virtual_placement, 9, 9, box3x2, true);
		assert_eq!(virtual_placement, wrapped("\x1b_Ga=p,U=1,q=2,i=9,p=9,c=3,r=2\x1b\\"));
	}

	#[test]
	fn chunks_long_transmits_and_wraps_each_chunk_inside_tmux() {
		let data = "A".repeat(KITTY_CHUNK * 2 + 1);
		let bare = kitty_transmit(&data, 9, false);
		let chunk = "A".repeat(KITTY_CHUNK);
		let expected = [
			format!("\x1b_Ga=t,f=100,q=2,i=9,m=1;{chunk}\x1b\\"),
			format!("\x1b_Gq=2,m=1;{chunk}\x1b\\"),
			"\x1b_Gq=2,m=0;A\x1b\\".to_owned(),
		]
		.concat();
		assert_eq!(bare, expected);
		let wrapped_transmit = kitty_transmit(&"A".repeat(KITTY_CHUNK + 1), 9, true);
		assert_eq!(wrapped_transmit.matches("\x1bPtmux;").count(), 2);
		assert_eq!(wrapped_transmit.matches("\x1b\x1b_G").count(), 2);
		assert_eq!(wrapped_transmit.matches("\x1b\x1b\\\x1b\\").count(), 2);
		assert!(wrapped_transmit.contains("\x1b\x1b_Gq=2,m=0;"));
		// Exactly one chunk's worth stays a single APC.
		assert_eq!(kitty_transmit(&chunk, 1, false).matches("\x1b_G").count(), 1);
	}

	#[test]
	fn placeholder_lines_carry_ids_and_explicit_row_column_cells() {
		let lines = kitty_placeholder_lines(1, 1, Fit { columns: 3, rows: 2 }, false);
		assert_eq!(lines.len(), 2);
		assert!(lines[0].starts_with("\x1b_Ga=p,U=1,q=2,i=1,p=1,c=3,r=2\x1b\\\x1b[38;2;0;0;1m"));
		for line in &lines {
			assert!(line.contains("\x1b[38;2;0;0;1m"));
			assert!(line.contains("\x1b[58:2::0:0:1m"));
			assert!(line.ends_with("\x1b[39;59m"));
			assert_eq!(line.matches(KITTY_PLACEHOLDER).count(), 3);
		}
		assert_eq!(
			lines[1],
			concat!(
				"\x1b[38;2;0;0;1m\x1b[58:2::0:0:1m",
				"\u{10eeee}\u{30d}\u{305}\u{10eeee}\u{30d}\u{30d}\u{10eeee}\u{30d}\u{30e}",
				"\x1b[39;59m",
			)
		);
		// The id splits into its truecolor channels; no placement id drops the
		// underline.
		let lines = kitty_placeholder_lines(0x01_02_03, 0, Fit { columns: 1, rows: 1 }, false);
		assert_eq!(
			lines[0],
			"\x1b_Ga=p,U=1,q=2,i=66051,c=1,r=1\x1b\\\x1b[38;2;1;2;3m\u{10eeee}\u{305}\u{305}\x1b[39;\
			 59m"
		);
	}

	#[test]
	fn a_placeholder_row_measures_exactly_its_columns() {
		// Each placeholder cell (U+10EEEE + diacritics) is one terminal column
		// and the SGR runs are zero-width: renderer and terminal accounting
		// agree.
		let lines = kitty_placeholder_lines(5, 5, Fit { columns: 6, rows: 2 }, false);
		for line in &lines {
			assert_eq!(crate::text::visible_width_str(line, 3), 6);
		}
	}

	#[test]
	fn placeholder_grids_fit_the_diacritic_table() {
		let fits = |columns, rows| kitty_placeholders_fit(Fit { columns, rows });
		let max = KITTY_PLACEHOLDER_MAX_CELLS;
		assert_eq!(max, 297);
		assert!(fits(1, 1));
		assert!(fits(max, max));
		assert!(!fits(0, 5));
		assert!(!fits(5, 0));
		assert!(!fits(max + 1, 1));
		assert!(!fits(1, max + 1));
	}

	#[test]
	fn sizes_iterm2_images_in_reserved_rows() {
		assert_eq!(
			iterm2_inline("AA==", Fit { columns: 2, rows: 2 }),
			"\x1b]1337;File=inline=1;width=2;height=2:AA==\x07"
		);
	}

	#[test]
	fn sixel_encodes_the_cell_box_and_reserves_a_whole_band() {
		let tall = CellSize { width_px: 10.0, height_px: 20.0 };
		assert_eq!(sixel_box(Fit { columns: 90, rows: 11 }, tall), SixelBox {
			width_px:  900,
			height_px: 220,
			rows:      11,
		});
		let tiny = CellSize { width_px: 2.0, height_px: 4.0 };
		assert_eq!(sixel_box(Fit { columns: 3, rows: 1 }, tiny), SixelBox {
			width_px:  6,
			height_px: 4,
			rows:      2,
		});
	}
}
