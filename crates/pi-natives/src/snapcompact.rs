//! Snapcompact frame rendering.
//!
//! Rasterizes pre-normalized conversation text onto a `size`-wide bitmap
//! (height hugs the rows the text actually needs) using one of the bundled
//! public-domain pixel fonts, then encodes it as PNG:
//!
//! - `5x8`  — X.org BDF font (legacy shape).
//! - `8x8`  — unscii-8 hex font (Latin-1 subset), the square cell that won the
//!   snapcompact `SQuAD` evals.
//! - `6x12` / `8x13` — X.org misc BDF fonts (higher-density eval winners).
//!
//! Shape controls, all eval-validated in `packages/snapcompact`:
//!
//! - **variant** — `sent` cycles glyph ink through six hues at sentence
//!   boundaries; `bw` prints plain black ink (best for Anthropic readers).
//! - **lineRepeat** — prints every text line N times; copies after the first
//!   sit on a pale highlight band. Redundancy coding: two looks per glyph at
//!   half the density ("8x8r" shapes).
//! - **cellWidth/cellHeight** — target cell size. When it differs from the
//!   font's natural cell, glyphs are rasterized at native size and the canvas
//!   is Lanczos3-resampled to the target (anisotropic stretch, e.g. the
//!   OpenAI-optimal "6x6u" shape), producing an anti-aliased RGB frame.
//! - **stretch** — `false` disables resampling: glyphs print at natural size on
//!   the requested cell box while staying indexed (e.g. 8x13 glyphs on an 8x16
//!   pitch, the "8on16" shapes). `true`/unset keeps the auto rule above.
//! - **columns** — `2` flows pre-wrapped `\n`-separated lines down two
//!   newspaper columns (the "doc" shapes); word wrap and pagination happen in
//!   the TypeScript caller.
//! - **dim spans** — `U+000E`/`U+000F` in the text toggle dim gray ink on/off
//!   without occupying a cell; the TypeScript serializer wraps tool output in
//!   them so archived conversation reads louder than archived tool noise.
//! - **line breaks** — `U+2588` (FULL BLOCK) fills its entire cell with pitch
//!   black ink regardless of variant or dim state; the TypeScript normalizer
//!   folds newline runs to it so line structure survives whitespace collapse at
//!   a one-cell cost.
//!
//! Text normalization, frame chunking, provider shape selection, and archive
//! management live in `packages/snapcompact/src/snapcompact.ts`; this module
//! is only the hot `text -> PNG bytes` path.

use std::{borrow::Cow, collections::HashMap, f32::consts::PI, sync::LazyLock};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::task;

/// Upper bound on the frame edge: a hard stop against absurd allocations
/// (`size * size` pixel buffer), far above the 2576px production frame.
const MAX_FRAME_SIZE: u32 = 16384;

/// Indexed palette: 0 is the white background, 1-6 are the six dark sentence
/// hues from the eval renderer (HLS l=0.22 s=0.95, h ∈ {0, .08, .3, .5, .62,
/// .78}), 7 is plain black ink (`bw` variant), 8 is the pale highlight band
/// behind repeated line copies, 9 is the dim gray ink for tool-output spans.
const PALETTE: [[u8; 3]; 10] = [
	[255, 255, 255],
	[109, 2, 2],     // red
	[109, 53, 2],    // amber
	[24, 109, 2],    // green
	[2, 109, 109],   // teal
	[2, 32, 109],    // blue
	[75, 2, 109],    // violet
	[0, 0, 0],       // bw ink
	[255, 247, 194], // repeat highlight band
	[128, 128, 128], // dim ink (tool-output spans)
];
const INK_COLORS: usize = 6;
const INK_BLACK: u8 = 7;
const BG_REPEAT: u8 = 8;
const INK_DIM: u8 = 9;
/// Zero-width ink toggles embedded in the text stream (shift-out/shift-in).
const DIM_ON: u32 = 0x0e;
const DIM_OFF: u32 = 0x0f;
/// FULL BLOCK: fills its entire cell box with pitch-black ink (`INK_BLACK`,
/// ignoring sentence hue and dim state). The TypeScript normalizer folds
/// newline runs to it.
const FULL_BLOCK: u32 = 0x2588;

static FONT_5X8: LazyLock<Font> = LazyLock::new(|| parse_bdf(include_str!("fonts/5x8.bdf"), 5, 8));
static FONT_8X8: LazyLock<Font> = LazyLock::new(|| parse_hex(include_str!("fonts/unscii-8.hex")));
static FONT_6X12: LazyLock<Font> =
	LazyLock::new(|| parse_bdf(include_str!("fonts/6x12.bdf"), 6, 12));
static FONT_8X13: LazyLock<Font> =
	LazyLock::new(|| parse_bdf(include_str!("fonts/8x13.bdf"), 8, 13));

struct Glyph {
	/// Glyph width in pixels (≤ 8 for the bundled fonts).
	w:    u8,
	/// Glyph height in pixels.
	h:    i32,
	xoff: i32,
	yoff: i32,
	/// One bitmask per bitmap row, MSB-leftmost.
	rows: Vec<u8>,
}

struct Font {
	/// Glyphs keyed by Unicode code point (ASCII + Latin-1 coverage).
	glyphs: HashMap<u32, Glyph>,
	ascent: i32,
	/// Natural cell advance (x) in pixels.
	cell_w: usize,
	/// Natural cell pitch (y) in pixels.
	cell_h: usize,
}

fn parse_bdf(text: &str, cell_w: usize, cell_h: usize) -> Font {
	let mut glyphs = HashMap::new();
	let mut ascent = 0i32;
	let mut enc = -1i64;
	let mut bbx = [0i32; 4];
	let mut lines = text.lines();
	while let Some(line) = lines.next() {
		if let Some(rest) = line.strip_prefix("FONT_ASCENT") {
			ascent = rest.trim().parse().unwrap_or(0);
		} else if let Some(rest) = line.strip_prefix("ENCODING") {
			enc = rest.trim().parse().unwrap_or(-1);
		} else if let Some(rest) = line.strip_prefix("BBX") {
			let mut parts = rest.split_ascii_whitespace();
			for slot in &mut bbx {
				*slot = parts.next().and_then(|part| part.parse().ok()).unwrap_or(0);
			}
		} else if line.starts_with("BITMAP") {
			let mut rows = Vec::new();
			for row in lines.by_ref() {
				if row.starts_with("ENDCHAR") {
					break;
				}
				rows.push(u8::from_str_radix(row.trim(), 16).unwrap_or(0));
			}
			if enc >= 0 {
				glyphs.insert(enc as u32, Glyph {
					w: bbx[0].clamp(0, 8) as u8,
					h: bbx[1],
					xoff: bbx[2],
					yoff: bbx[3],
					rows,
				});
			}
		}
	}
	Font { glyphs, ascent, cell_w, cell_h }
}

/// Parse a unifont-style `.hex` font (`CODEPOINT:16-hex-digit bitmap`, one
/// byte per row of an 8x8 glyph). Baseline sits at row 7 (`ascent` 7 with a
/// one-pixel descender row), matching the eval renderer.
fn parse_hex(text: &str) -> Font {
	let mut glyphs = HashMap::new();
	for line in text.lines() {
		let Some((cp, bits)) = line.split_once(':') else {
			continue;
		};
		let Ok(enc) = u32::from_str_radix(cp.trim(), 16) else {
			continue;
		};
		let bits = bits.trim();
		if bits.len() != 16 {
			continue;
		}
		let rows: Vec<u8> = (0..8)
			.map(|i| u8::from_str_radix(&bits[i * 2..i * 2 + 2], 16).unwrap_or(0))
			.collect();
		glyphs.insert(enc, Glyph { w: 8, h: 8, xoff: 0, yoff: -1, rows });
	}
	Font { glyphs, ascent: 7, cell_w: 8, cell_h: 8 }
}

fn resolve_font(name: &str) -> Option<&'static Font> {
	match name {
		"5x8" => Some(&FONT_5X8),
		"8x8" => Some(&FONT_8X8),
		"6x12" => Some(&FONT_6X12),
		"8x13" => Some(&FONT_8X13),
		_ => None,
	}
}

/// Frame grid geometry shared with the TypeScript caller. The cell box
/// (`cell_w` x `cell_h`) is the advance/pitch glyphs are laid out on; it may
/// differ from the font's natural cell (e.g. 8x13 glyphs on an 8x16 pitch).
struct Grid {
	cols:   usize,
	rows:   usize,
	repeat: usize,
	/// Cell advance (x) in pixels.
	cell_w: usize,
	/// Cell pitch (y) in pixels.
	cell_h: usize,
}

/// Grid rows the text actually occupies, so the canvas height hugs the
/// content instead of padding the frame to a full square. Mirrors the
/// renderers' cell accounting: dim toggles are zero-width, every other code
/// point (including `U+2588` and glyphs missing from the font) consumes one
/// cell; doc layout fills one row per `\n`-separated line down the first
/// column before spilling into the second.
fn used_rows(text: &str, grid: &Grid, doc: bool) -> usize {
	let rows = if doc {
		text.split('\n').count()
	} else {
		let cells = text
			.chars()
			.filter(|&ch| !matches!(ch as u32, DIM_ON | DIM_OFF))
			.count();
		cells.div_ceil(grid.cols)
	};
	rows.clamp(1, grid.rows)
}

/// Paint the pale highlight bands behind line copies after the first.
fn fill_repeat_bands(pixels: &mut [u8], width: usize, height: usize, grid: &Grid) {
	if grid.repeat <= 1 {
		return;
	}
	for row in 0..grid.rows {
		for copy in 1..grid.repeat {
			let band_top = (row * grid.repeat + copy) * grid.cell_h;
			for y in band_top..(band_top + grid.cell_h).min(height) {
				pixels[y * width..y * width + width].fill(BG_REPEAT);
			}
		}
	}
}

/// Blit one glyph's bitmask rows at (`left`, `top`), clipped to the canvas.
fn blit_glyph(
	pixels: &mut [u8],
	width: usize,
	height: usize,
	glyph: &Glyph,
	left: i32,
	top: i32,
	ink: u8,
) {
	for (r, &bits) in glyph.rows.iter().enumerate() {
		if bits == 0 {
			continue;
		}
		let y = top + r as i32;
		if y < 0 || y >= height as i32 {
			continue;
		}
		let row_base = y as usize * width;
		for b in 0..glyph.w {
			if bits & (0x80u8 >> b) != 0 {
				let x = left + i32::from(b);
				if x >= 0 && (x as usize) < width {
					pixels[row_base + x as usize] = ink;
				}
			}
		}
	}
}

/// Fill one cell box (every repeat copy) with solid ink, clipped to canvas.
fn fill_cell(
	pixels: &mut [u8],
	width: usize,
	height: usize,
	grid: &Grid,
	x_origin: usize,
	row: usize,
	ink: u8,
) {
	let x0 = x_origin.min(width);
	let x1 = (x_origin + grid.cell_w).min(width);
	if x0 >= x1 {
		return;
	}
	for copy in 0..grid.repeat {
		let top = (row * grid.repeat + copy) * grid.cell_h;
		for y in top..(top + grid.cell_h).min(height) {
			pixels[y * width + x0..y * width + x1].fill(ink);
		}
	}
}

/// Rasterize `text` onto a `width` x `height` palette-indexed bitmap on the
/// grid's cell box, row-major with no word wrap. Glyphs keep their natural
/// size with the baseline at the font's ascent from the cell top, so a cell
/// taller than the font pads below the baseline (the "8on16" shapes). Each
/// text line is printed `grid.repeat` times; copies after the first sit on
/// the highlight band. Ink cycles through six hues at sentence boundaries
/// (terminator in `.!?` followed by a space or full block) unless `black_ink`
/// pins it to black; `U+000E`/`U+000F` toggle dim gray ink without occupying a
/// cell, and dim wins over both variants. `U+2588` fills its whole cell with
/// pitch-black ink, ignoring hue and dim state. Characters beyond
/// `cols * rows` are ignored; code points missing from the font leave their
/// cell blank.
fn render_bitmap(
	text: &str,
	width: usize,
	height: usize,
	font: &Font,
	grid: &Grid,
	black_ink: bool,
) -> Vec<u8> {
	let mut pixels = vec![0u8; width * height]; // 0 = white background
	let capacity = grid.cols * grid.rows;
	if capacity == 0 {
		return pixels;
	}
	fill_repeat_bands(&mut pixels, width, height, grid);
	let codes: Vec<u32> = text.chars().map(|ch| ch as u32).collect();
	let mut sentence = 0usize;
	let mut dim = false;
	let mut cell = 0usize;
	for i in 0..codes.len() {
		if cell >= capacity {
			break;
		}
		let code = codes[i];
		match code {
			DIM_ON => {
				dim = true;
				continue;
			},
			DIM_OFF => {
				dim = false;
				continue;
			},
			_ => {},
		}
		let ink = if dim {
			INK_DIM
		} else if black_ink {
			INK_BLACK
		} else {
			(1 + sentence % INK_COLORS) as u8
		};
		if matches!(code, 0x2e | 0x21 | 0x3f)
			&& matches!(codes.get(i + 1), Some(&(0x20 | FULL_BLOCK)))
		{
			sentence += 1;
		}
		let row = cell / grid.cols;
		let col = cell - row * grid.cols;
		cell += 1;
		if code == FULL_BLOCK {
			fill_cell(&mut pixels, width, height, grid, col * grid.cell_w, row, INK_BLACK);
			continue;
		}
		let Some(glyph) = font.glyphs.get(&code) else {
			continue;
		};
		if glyph.rows.is_empty() {
			continue;
		}
		let left = (col * grid.cell_w) as i32 + glyph.xoff;
		for copy in 0..grid.repeat {
			let cell_top = ((row * grid.repeat + copy) * grid.cell_h) as i32;
			let top = cell_top + font.ascent - glyph.h - glyph.yoff;
			blit_glyph(&mut pixels, width, height, glyph, left, top, ink);
		}
	}
	pixels
}

/// Character cells between the two doc columns (eval `exp14` layout).
const GUTTER: usize = 3;

/// Rasterize pre-wrapped text as a two-column "doc" page onto a `width` x
/// `height` palette-indexed bitmap. Input splits on `'\n'` (zero-width): line
/// `li` lands at column `li / rows`, row `li % rows`; each column is
/// `(cols - GUTTER) / 2` cells wide, the second starts `col_w + GUTTER` cells
/// in, and no rule is drawn between them. Lines longer than the column width
/// are clipped (the TypeScript caller pre-wraps; clipping is the overflow
/// guard) and lines past the second column are ignored. Sentence hues advance
/// on a terminator in `.!?` followed by a space, newline, *or* full block;
/// dim toggles, repeat bands, and the `U+2588` black cell fill behave exactly
/// as in the grid renderer.
fn render_doc_bitmap(
	text: &str,
	width: usize,
	height: usize,
	font: &Font,
	grid: &Grid,
	black_ink: bool,
) -> Vec<u8> {
	let mut pixels = vec![0u8; width * height]; // 0 = white background
	let col_w = grid.cols.saturating_sub(GUTTER) / 2;
	if col_w == 0 || grid.rows == 0 {
		return pixels;
	}
	fill_repeat_bands(&mut pixels, width, height, grid);
	let codes: Vec<u32> = text.chars().map(|ch| ch as u32).collect();
	let mut sentence = 0usize;
	let mut dim = false;
	let mut line = 0usize;
	let mut col = 0usize;
	for i in 0..codes.len() {
		let code = codes[i];
		match code {
			DIM_ON => {
				dim = true;
				continue;
			},
			DIM_OFF => {
				dim = false;
				continue;
			},
			0x0a => {
				line += 1;
				col = 0;
				if line >= grid.rows * 2 {
					break; // past the second column; the caller paginates
				}
				continue;
			},
			_ => {},
		}
		let ink = if dim {
			INK_DIM
		} else if black_ink {
			INK_BLACK
		} else {
			(1 + sentence % INK_COLORS) as u8
		};
		if matches!(code, 0x2e | 0x21 | 0x3f)
			&& matches!(codes.get(i + 1), Some(&(0x20 | 0x0a | FULL_BLOCK)))
		{
			sentence += 1;
		}
		let cell = col;
		col += 1;
		if cell >= col_w {
			continue; // clip past the column width
		}
		if code == FULL_BLOCK {
			let column = line / grid.rows;
			let row = line - column * grid.rows;
			let x_origin = (column * (col_w + GUTTER) + cell) * grid.cell_w;
			fill_cell(&mut pixels, width, height, grid, x_origin, row, INK_BLACK);
			continue;
		}
		let Some(glyph) = font.glyphs.get(&code) else {
			continue;
		};
		if glyph.rows.is_empty() {
			continue;
		}
		let column = line / grid.rows;
		let row = line - column * grid.rows;
		let x_origin = column * (col_w + GUTTER) * grid.cell_w;
		let left = (x_origin + cell * grid.cell_w) as i32 + glyph.xoff;
		for copy in 0..grid.repeat {
			let cell_top = ((row * grid.repeat + copy) * grid.cell_h) as i32;
			let top = cell_top + font.ascent - glyph.h - glyph.yoff;
			blit_glyph(&mut pixels, width, height, glyph, left, top, ink);
		}
	}
	pixels
}

// ============================================================================
// Lanczos3 resampling (stretch shapes)
// ============================================================================

fn lanczos3(x: f32) -> f32 {
	let x = x.abs();
	if x < 1e-6 {
		return 1.0;
	}
	if x >= 3.0 {
		return 0.0;
	}
	let pix = PI * x;
	(pix.sin() / pix) * ((pix / 3.0).sin() / (pix / 3.0))
}

/// Per-output-pixel kernel contributions for one axis, PIL-convention
/// (`center = (i + 0.5) * scale`, kernel stretched by `max(scale, 1)`,
/// weights normalized).
fn contributions(src_len: usize, dst_len: usize) -> Vec<(usize, Vec<f32>)> {
	let scale = src_len as f32 / dst_len as f32;
	let filt_scale = scale.max(1.0);
	let support = 3.0 * filt_scale;
	let mut out = Vec::with_capacity(dst_len);
	for i in 0..dst_len {
		let center = (i as f32 + 0.5) * scale;
		let begin = ((center - support) as isize).max(0) as usize;
		let end = ((center + support).ceil() as usize).min(src_len);
		let mut weights = Vec::with_capacity(end - begin);
		let mut total = 0.0f32;
		for x in begin..end {
			let w = lanczos3((x as f32 + 0.5 - center) / filt_scale);
			weights.push(w);
			total += w;
		}
		if total != 0.0 {
			for w in &mut weights {
				*w /= total;
			}
		}
		out.push((begin, weights));
	}
	out
}

/// Separable Lanczos3 resize of an interleaved RGB f32 buffer.
fn resize_rgb(src: &[f32], sw: usize, sh: usize, dw: usize, dh: usize) -> Vec<f32> {
	let horiz = contributions(sw, dw);
	let mut tmp = vec![0f32; dw * sh * 3];
	for y in 0..sh {
		let src_row = &src[y * sw * 3..(y + 1) * sw * 3];
		let dst_row = &mut tmp[y * dw * 3..(y + 1) * dw * 3];
		for (x, (begin, weights)) in horiz.iter().enumerate() {
			let mut acc = [0f32; 3];
			for (k, &w) in weights.iter().enumerate() {
				let s = (begin + k) * 3;
				acc[0] = src_row[s].mul_add(w, acc[0]);
				acc[1] = src_row[s + 1].mul_add(w, acc[1]);
				acc[2] = src_row[s + 2].mul_add(w, acc[2]);
			}
			dst_row[x * 3..x * 3 + 3].copy_from_slice(&acc);
		}
	}
	let vert = contributions(sh, dh);
	let mut out = vec![0f32; dw * dh * 3];
	for (y, (begin, weights)) in vert.iter().enumerate() {
		let dst_row = &mut out[y * dw * 3..(y + 1) * dw * 3];
		for (k, &w) in weights.iter().enumerate() {
			let src_row = &tmp[(begin + k) * dw * 3..(begin + k + 1) * dw * 3];
			for (d, &s) in dst_row.iter_mut().zip(src_row) {
				*d = s.mul_add(w, *d);
			}
		}
	}
	out
}

// ============================================================================
// PNG encoding
// ============================================================================

/// Pack one-byte-per-pixel palette indices into `bits`-per-pixel PNG
/// scanline data (big-endian within each byte), remapping each global
/// palette index through `remap` to its per-frame slot on the way.
fn pack_bits(
	pixels: &[u8],
	width: usize,
	height: usize,
	bits: usize,
	remap: &[u8; PALETTE.len()],
) -> Vec<u8> {
	let per = 8 / bits;
	let row_bytes = width.div_ceil(per);
	let mut packed = vec![0u8; row_bytes * height];
	for y in 0..height {
		let src = &pixels[y * width..(y + 1) * width];
		let dst = &mut packed[y * row_bytes..(y + 1) * row_bytes];
		for (x, &px) in src.iter().enumerate() {
			dst[x / per] |= remap[px as usize] << (bits * (per - 1 - x % per));
		}
	}
	packed
}

/// Encode a palette-indexed bitmap as an indexed PNG with `None` row
/// filtering (the glyph bitmap is already minimal-entropy; filtering costs
/// encode time without helping deflate).
///
/// The palette is narrowed to the colors the frame actually uses and the bit
/// depth follows: a plain `bw` frame (background + ink) packs 1-bit rows, a
/// dim/banded frame 2-bit, sentence-hue frames 4-bit — bw frames shed
/// another ~half of the pre-deflate stream vs the fixed 4-bit layout.
fn encode_indexed_png(
	pixels: &[u8],
	width: usize,
	height: usize,
	compression: png::Compression,
) -> Result<Vec<u8>> {
	let mut used = [false; PALETTE.len()];
	for &px in pixels {
		used[px as usize] = true;
	}
	let mut remap = [0u8; PALETTE.len()];
	let mut palette = Vec::with_capacity(PALETTE.len() * 3);
	let mut count = 0u8;
	for (global, &is_used) in used.iter().enumerate() {
		if is_used {
			remap[global] = count;
			count += 1;
			palette.extend_from_slice(&PALETTE[global]);
		}
	}
	let (depth, bits) = match count {
		0..=2 => (png::BitDepth::One, 1),
		3..=4 => (png::BitDepth::Two, 2),
		_ => (png::BitDepth::Four, 4),
	};
	let mut out = Vec::new();
	let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
	encoder.set_color(png::ColorType::Indexed);
	encoder.set_depth(depth);
	encoder.set_palette(Cow::Owned(palette));
	encoder.set_compression(compression);
	// MUST come after `set_compression`, which resets the filter to the
	// compression level's default (`Adaptive` for `Balanced`/`High`).
	encoder.set_filter(png::Filter::NoFilter);
	let mut writer = encoder
		.write_header()
		.map_err(|err| Error::from_reason(format!("Failed to write PNG header: {err}")))?;
	writer
		.write_image_data(&pack_bits(pixels, width, height, bits, &remap))
		.map_err(|err| Error::from_reason(format!("Failed to write PNG data: {err}")))?;
	writer
		.finish()
		.map_err(|err| Error::from_reason(format!("Failed to finish PNG stream: {err}")))?;
	Ok(out)
}

/// Encode an interleaved RGB8 buffer as PNG. Stretched frames are
/// continuous-tone, so adaptive filtering (the `Balanced` default) helps.
fn encode_rgb_png(
	pixels: &[u8],
	width: usize,
	height: usize,
	compression: png::Compression,
) -> Result<Vec<u8>> {
	let mut out = Vec::new();
	let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
	encoder.set_color(png::ColorType::Rgb);
	encoder.set_depth(png::BitDepth::Eight);
	encoder.set_compression(compression);
	let mut writer = encoder
		.write_header()
		.map_err(|err| Error::from_reason(format!("Failed to write PNG header: {err}")))?;
	writer
		.write_image_data(pixels)
		.map_err(|err| Error::from_reason(format!("Failed to write PNG data: {err}")))?;
	writer
		.finish()
		.map_err(|err| Error::from_reason(format!("Failed to finish PNG stream: {err}")))?;
	Ok(out)
}

// ============================================================================
// Entry point
// ============================================================================

/// Shape options for one snapcompact frame.
#[napi(object)]
#[derive(Default)]
pub struct SnapcompactRenderOptions {
	/// Frame width in pixels; also bounds the grid rows
	/// (`floor(size/cellHeight/lineRepeat)`). Output height hugs the rows the
	/// text actually uses instead of padding to a square.
	pub size:        u32,
	/// Bundled font: `"5x8"`, `"6x12"`, `"8x13"` (X.org BDF) or `"8x8"`
	/// (unscii-8). Default `"5x8"`.
	pub font:        Option<String>,
	/// Target cell advance in pixels. Differing from the font's natural cell
	/// triggers the Lanczos stretch path. Default: font natural width.
	pub cell_width:  Option<u32>,
	/// Target cell pitch in pixels. Default: font natural height.
	pub cell_height: Option<u32>,
	/// Ink variant: `"sent"` (six-hue sentence cycling) or `"bw"` (black).
	/// Default `"sent"`.
	pub variant:     Option<String>,
	/// Print each text line this many times; copies after the first sit on a
	/// pale highlight band. Default 1.
	pub line_repeat: Option<u32>,
	/// Stretch behavior. Unset: auto — Lanczos-stretch whenever the target
	/// cell differs from the font's natural cell. `false`: never stretch —
	/// render indexed with glyphs at natural size on the requested cell box
	/// (e.g. 8x13 glyphs on an 8x16 pitch, the "8on16" shapes). `true`: force
	/// the stretch path (identical to auto; natural cells render indexed).
	pub stretch:     Option<bool>,
	/// Layout columns: `1` (default) row-major grid; `2` two newspaper "doc"
	/// columns of pre-wrapped newline-separated lines.
	pub columns:     Option<u32>,
}

/// Render one snapcompact frame on a libuv worker: print pre-normalized text
/// onto a `size`-wide bitmap and encode it as PNG.
///
/// The bitmap height hugs the rows the text actually occupies
/// (`usedRows * lineRepeat * cellHeight`), so a partially filled frame never
/// pays for blank padding rows. The glyph grid holds `floor(size/cellWidth) *
/// floor(size/cellHeight/lineRepeat)` characters; input beyond that is ignored
/// (the caller chunks text to capacity). Native-cell shapes encode as 4-bit
/// indexed PNG; stretched shapes (target cell != font cell) encode as RGB.
/// `stretch: false` pins the indexed path, printing natural-size glyphs on the
/// requested cell box; `columns: 2` flows pre-wrapped newline-separated lines
/// down two newspaper columns. `U+000E`/`U+000F` in `text` toggle dim-gray ink
/// spans without occupying a cell.
/// Returns a promise for the PNG encoded as base64, created as a one-byte
/// (Latin-1) JS string straight from native code — no `Uint8Array` hop or
/// JS-side re-encode.
#[napi]
pub fn render_snapcompact_png(
	text: String,
	options: SnapcompactRenderOptions,
) -> task::Promise<Latin1String> {
	task::blocking("render_snapcompact_png", (), move |_| render_snapcompact_png_sync(text, options))
}

fn render_snapcompact_png_sync(
	text: String,
	options: SnapcompactRenderOptions,
) -> Result<Latin1String> {
	let size = options.size;
	if size == 0 || size > MAX_FRAME_SIZE {
		return Err(Error::from_reason(format!(
			"Invalid frame size {size}: expected 1..={MAX_FRAME_SIZE}"
		)));
	}
	let font_name = options.font.as_deref().unwrap_or("5x8");
	let font = resolve_font(font_name).ok_or_else(|| {
		Error::from_reason(format!(
			"Unknown snapcompact font {font_name:?}: expected \"5x8\", \"8x8\", \"6x12\", or \"8x13\""
		))
	})?;
	let black_ink = match options.variant.as_deref().unwrap_or("sent") {
		"sent" => false,
		"bw" => true,
		other => {
			return Err(Error::from_reason(format!(
				"Unknown snapcompact variant {other:?}: expected \"sent\" or \"bw\""
			)));
		},
	};
	let target_w = options.cell_width.unwrap_or(font.cell_w as u32).max(1) as usize;
	let target_h = options.cell_height.unwrap_or(font.cell_h as u32).max(1) as usize;
	let repeat = options.line_repeat.unwrap_or(1).max(1) as usize;
	let columns = options.columns.unwrap_or(1);
	if !matches!(columns, 1 | 2) {
		return Err(Error::from_reason(format!(
			"Invalid snapcompact columns {columns}: expected 1 or 2"
		)));
	}
	let doc = columns == 2;
	let size = size as usize;
	let grid = Grid {
		cols: size / target_w,
		rows: size / target_h / repeat,
		repeat,
		cell_w: target_w,
		cell_h: target_h,
	};
	if grid.cols == 0 || grid.rows == 0 {
		return Err(Error::from_reason(format!(
			"Frame size {size} cannot fit a {target_w}x{target_h} cell grid (repeat {repeat})"
		)));
	}
	// Tight canvas: width stays the frame edge (the reading geometry the
	// caller derives cols from), height hugs the rows the text needs.
	let used = used_rows(&text, &grid, doc);
	let height = used * grid.repeat * grid.cell_h;

	let stretch =
		options.stretch != Some(false) && (target_w, target_h) != (font.cell_w, font.cell_h);
	if !stretch {
		// Indexed path: rasterize straight onto the frame at the requested
		// cell box (the natural cell, or natural glyphs on a padded pitch
		// when `stretch: false`).
		let pixels = if doc {
			render_doc_bitmap(&text, size, height, font, &grid, black_ink)
		} else {
			render_bitmap(&text, size, height, font, &grid, black_ink)
		};
		return Ok(STANDARD
			.encode(encode_indexed_png(&pixels, size, height, png::Compression::High)?)
			.into());
	}

	// Stretch shape: rasterize at the font's natural cell on a tight canvas
	// (layout stays in character cells from the target grid), Lanczos3-
	// resample to the target cell, paste onto the white frame.
	let native = Grid { cell_w: font.cell_w, cell_h: font.cell_h, ..grid };
	let src_w = grid.cols * font.cell_w;
	let src_h = used * grid.repeat * font.cell_h;
	let dst_w = grid.cols * target_w;
	let dst_h = used * grid.repeat * target_h;
	let indexed = if doc {
		render_doc_bitmap(&text, src_w, src_h, font, &native, black_ink)
	} else {
		render_bitmap(&text, src_w, src_h, font, &native, black_ink)
	};
	let mut rgb = vec![0f32; src_w * src_h * 3];
	for (dst, &idx) in rgb.chunks_exact_mut(3).zip(&indexed) {
		let [r, g, b] = PALETTE[idx as usize];
		dst[0] = f32::from(r);
		dst[1] = f32::from(g);
		dst[2] = f32::from(b);
	}
	let resized = resize_rgb(&rgb, src_w, src_h, dst_w, dst_h);
	let mut frame = vec![255u8; size * dst_h * 3];
	for y in 0..dst_h {
		let src_row = &resized[y * dst_w * 3..(y + 1) * dst_w * 3];
		let dst_row = &mut frame[y * size * 3..];
		for (d, &s) in dst_row[..dst_w.min(size) * 3].iter_mut().zip(src_row) {
			*d = s.round().clamp(0.0, 255.0) as u8;
		}
	}
	Ok(STANDARD
		.encode(encode_rgb_png(&frame, size, dst_h, png::Compression::High)?)
		.into())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn opts(size: u32) -> SnapcompactRenderOptions {
		SnapcompactRenderOptions { size, ..Default::default() }
	}

	#[test]
	fn fonts_parse_ascii_coverage() {
		for (font, ascent) in [(&*FONT_5X8, 7), (&*FONT_8X8, 7)] {
			assert_eq!(font.ascent, ascent);
			// Every printable ASCII char must have a glyph.
			for cp in 0x20u32..0x7f {
				assert!(font.glyphs.contains_key(&cp), "missing glyph for U+{cp:04X}");
			}
		}
	}

	#[test]
	fn bitmap_inks_sentences_and_caps_capacity() {
		// 40px -> 8 cols x 5 rows = 40 cells (5x8 font).
		let grid = Grid { cols: 8, rows: 5, repeat: 1, cell_w: 5, cell_h: 8 };
		let pixels = render_bitmap("Hi. Ok.", 40, 40, &FONT_5X8, &grid, false);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1), "first sentence should use ink 1");
		assert!(inks.contains(&2), "second sentence should use ink 2");
		assert!(!inks.contains(&3), "no third sentence ink expected");

		// Overflow input renders without panicking and stays in-bounds.
		let overflow = render_bitmap(&"x".repeat(100), 40, 40, &FONT_5X8, &grid, false);
		assert_eq!(overflow.len(), 40 * 40);
	}

	#[test]
	fn bw_variant_prints_black_only() {
		let grid = Grid { cols: 8, rows: 8, repeat: 1, cell_w: 8, cell_h: 8 };
		let pixels = render_bitmap("Hi. Ok.", 64, 64, &FONT_8X8, &grid, true);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(!inks.is_empty());
		assert!(inks.iter().all(|&p| p == INK_BLACK), "bw must ink only black");
	}

	#[test]
	fn dim_markers_toggle_gray_without_consuming_cells() {
		let grid = Grid { cols: 8, rows: 8, repeat: 1, cell_w: 8, cell_h: 8 };
		let pixels = render_bitmap("\u{e}AB\u{f}CD", 64, 64, &FONT_8X8, &grid, true);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&INK_DIM), "dim span must ink gray");
		assert!(inks.contains(&INK_BLACK), "post-span text must return to black");
		// Markers are zero-width: glyphs land in the same cells as without them.
		let plain = render_bitmap("ABCD", 64, 64, &FONT_8X8, &grid, true);
		for (i, (a, b)) in pixels.iter().zip(&plain).enumerate() {
			assert_eq!(*a != 0, *b != 0, "cell layout must ignore markers (pixel {i})");
		}
	}

	#[test]
	fn line_repeat_duplicates_rows_on_highlight_bands() {
		// 64px, 8x8 font, repeat 2 -> 8 cols x 4 unique rows.
		let grid = Grid { cols: 8, rows: 4, repeat: 2, cell_w: 8, cell_h: 8 };
		let pixels = render_bitmap("ABCDEFGH", 64, 64, &FONT_8X8, &grid, true);
		// Copy band (rows 8..16) carries the highlight background.
		assert!(pixels[9 * 64..10 * 64].contains(&BG_REPEAT), "duplicate band must be highlighted");
		// Identical glyph ink in both copies: compare full 8-row bands modulo
		// background.
		for y in 0..8 {
			for x in 0..64 {
				let a = pixels[y * 64 + x];
				let b = pixels[(y + 8) * 64 + x];
				assert_eq!(a == INK_BLACK, b == INK_BLACK, "copy ink mismatch at ({x},{y})");
			}
		}
	}

	#[test]
	fn full_block_fills_cell_pitch_black() {
		let grid = Grid { cols: 8, rows: 4, repeat: 2, cell_w: 8, cell_h: 8 };
		// The block's black fill beats both the dim span and the sent hues.
		let pixels = render_bitmap("\u{e}a\u{2588}b\u{f}", 64, 64, &FONT_8X8, &grid, false);
		for copy in 0..2 {
			for y in copy * 8..(copy + 1) * 8 {
				for x in 8..16 {
					assert_eq!(pixels[y * 64 + x], INK_BLACK, "block pixel ({x},{y}) must be black");
				}
			}
		}
		assert!(pixels.contains(&INK_DIM), "neighbours keep their dim ink");
		let hued = render_bitmap("Hi.\u{2588}Ok.", 64, 64, &FONT_8X8, &grid, false);
		assert!(hued.contains(&2), "block must advance the sentence hue like a space");
	}

	#[test]
	fn doc_full_block_fills_cell() {
		// col_w = (13 - GUTTER) / 2 = 5; block at line 0, cell 1 -> x 8..16.
		let grid = Grid { cols: 13, rows: 2, repeat: 1, cell_w: 8, cell_h: 8 };
		let pixels = render_doc_bitmap("a\u{2588}b\nc", 104, 16, &FONT_8X8, &grid, true);
		for y in 0..8 {
			for x in 8..16 {
				assert_eq!(pixels[y * 104 + x], INK_BLACK, "block pixel ({x},{y}) must be black");
			}
		}
	}

	/// Decode the base64 JS-string payload back to PNG bytes for inspection.
	fn png_bytes(encoded: Latin1String) -> Vec<u8> {
		STANDARD
			.decode(&*encoded)
			.expect("output must be valid base64")
	}

	#[test]
	fn render_native_is_indexed_and_stretch_is_rgb() {
		let native = png_bytes(
			render_snapcompact_png_sync("Hello world. Again.".into(), SnapcompactRenderOptions {
				size: 128,
				font: Some("8x8".into()),
				variant: Some("bw".into()),
				line_repeat: Some(2),
				..Default::default()
			})
			.unwrap(),
		);
		// PNG color type lives at byte 25 of the IHDR: 3 = indexed.
		assert_eq!(native[25], 3);

		let stretched = png_bytes(
			render_snapcompact_png_sync("Hello world. Again.".into(), SnapcompactRenderOptions {
				size: 128,
				font: Some("8x8".into()),
				cell_width: Some(6),
				cell_height: Some(6),
				..Default::default()
			})
			.unwrap(),
		);
		// 2 = truecolor RGB.
		assert_eq!(stretched[25], 2);
		let legacy = png_bytes(render_snapcompact_png_sync("Hi. Ok.".into(), opts(40)).unwrap());
		assert_eq!(legacy[25], 3, "default shape stays the legacy 5x8 indexed path");
	}

	#[test]
	fn indexed_png_narrows_palette_and_bit_depth() {
		// IHDR bit depth lives at byte 24; PLTE length is the chunk length
		// word 8 bytes after the "PLTE" tag position.
		fn depth_and_palette(png: &[u8]) -> (u8, usize) {
			let tag = png
				.windows(4)
				.position(|w| w == b"PLTE")
				.expect("PLTE chunk");
			let len = u32::from_be_bytes(png[tag - 4..tag].try_into().unwrap()) as usize;
			(png[24], len / 3)
		}

		// Plain bw, no dim/band/repeat: background + black ink = 1-bit.
		let bw = png_bytes(
			render_snapcompact_png_sync("Hello world. Again.".into(), SnapcompactRenderOptions {
				size: 128,
				font: Some("8x8".into()),
				variant: Some("bw".into()),
				..Default::default()
			})
			.unwrap(),
		);
		assert_eq!(depth_and_palette(&bw), (1, 2));

		// bw with a dim span and repeat bands: 4 colors = 2-bit.
		let dim = png_bytes(
			render_snapcompact_png_sync(
				"Read \u{e}the dim part\u{f} now.".into(),
				SnapcompactRenderOptions {
					size: 128,
					font: Some("8x8".into()),
					variant: Some("bw".into()),
					line_repeat: Some(2),
					..Default::default()
				},
			)
			.unwrap(),
		);
		assert_eq!(depth_and_palette(&dim), (2, 4));

		// Sentence hues exceed 4 colors: stays 4-bit, palette still narrowed
		// to the inks actually printed (bg + 2 hues here).
		let sent = png_bytes(
			render_snapcompact_png_sync("Hi. Ok.".into(), SnapcompactRenderOptions {
				size: 128,
				font: Some("8x8".into()),
				variant: Some("sent".into()),
				..Default::default()
			})
			.unwrap(),
		);
		let (sent_depth, sent_colors) = depth_and_palette(&sent);
		assert_eq!(sent_depth, 2, "two hues + bg fit 2-bit");
		assert_eq!(sent_colors, 3);
	}

	#[test]
	fn rejects_bad_shapes() {
		assert!(render_snapcompact_png_sync("x".into(), opts(0)).is_err());
		assert!(
			render_snapcompact_png_sync("x".into(), SnapcompactRenderOptions {
				size: 64,
				font: Some("9x9".into()),
				..Default::default()
			})
			.is_err()
		);
		assert!(
			render_snapcompact_png_sync("x".into(), SnapcompactRenderOptions {
				size: 64,
				variant: Some("zebra".into()),
				..Default::default()
			})
			.is_err()
		);
	}

	#[test]
	fn xorg_fonts_parse_and_render() {
		for (font, ascent, name) in [(&*FONT_6X12, 10, "6x12"), (&*FONT_8X13, 11, "8x13")] {
			assert_eq!(font.ascent, ascent, "{name} ascent");
			for cp in 0x20u32..0x7f {
				assert!(font.glyphs.contains_key(&cp), "{name} missing glyph U+{cp:04X}");
			}
		}
		for (name, size) in [("6x12", 60u32), ("8x13", 104u32)] {
			let png = png_bytes(
				render_snapcompact_png_sync("Hello world. Again!".into(), SnapcompactRenderOptions {
					size,
					font: Some(name.into()),
					..Default::default()
				})
				.unwrap(),
			);
			assert_eq!(png[25], 3, "{name} natural cell must encode indexed");
		}
		// Non-blank: the raster must carry glyph ink.
		let grid = Grid { cols: 10, rows: 5, repeat: 1, cell_w: 6, cell_h: 12 };
		let pixels = render_bitmap("Hello", 60, 60, &FONT_6X12, &grid, true);
		assert!(pixels.contains(&INK_BLACK), "6x12 must ink pixels");
		let grid = Grid { cols: 8, rows: 8, repeat: 1, cell_w: 8, cell_h: 13 };
		let pixels = render_bitmap("Hello", 64, 104, &FONT_8X13, &grid, true);
		assert!(pixels.contains(&INK_BLACK), "8x13 must ink pixels");
	}

	#[test]
	fn stretch_false_renders_natural_glyphs_on_padded_pitch() {
		let png = png_bytes(
			render_snapcompact_png_sync(
				"Hello there. General Kenobi!".into(),
				SnapcompactRenderOptions {
					size: 128,
					font: Some("8x13".into()),
					cell_width: Some(8),
					cell_height: Some(16),
					stretch: Some(false),
					variant: Some("bw".into()),
					..Default::default()
				},
			)
			.unwrap(),
		);
		assert_eq!(png[25], 3, "8on16 must stay indexed");
		// IHDR width/height live at bytes 16..24, big-endian.
		let dim = |off: usize| u32::from_be_bytes(png[off..off + 4].try_into().unwrap());
		// "Hello there. General Kenobi!" is 28 chars on a 16-col grid: 2 rows
		// of the 16px pitch — the height hugs them instead of padding to 128.
		assert_eq!((dim(16), dim(20)), (128, 32), "declared geometry must match");

		// Glyph ink must sit in the top 13px of every 16px pitch row.
		let grid = Grid { cols: 16, rows: 8, repeat: 1, cell_w: 8, cell_h: 16 };
		let pixels = render_bitmap("Hgjpqy. Mixed descenders!", 128, 128, &FONT_8X13, &grid, true);
		assert!(pixels.contains(&INK_BLACK));
		for (i, &p) in pixels.iter().enumerate() {
			if p == INK_BLACK {
				assert!((i / 128) % 16 < 13, "ink leaked into pitch padding at y={}", i / 128);
			}
		}
	}

	#[test]
	fn doc_layout_flows_lines_into_second_column() {
		// 64px, 8x16 cells -> cols 8, rows 4, col_w = (8 - 3) / 2 = 2.
		let grid = Grid { cols: 8, rows: 4, repeat: 1, cell_w: 8, cell_h: 16 };
		let pixels = render_doc_bitmap("A\nB\nC\nD\nE", 64, 64, &FONT_8X13, &grid, true);
		// Line 4 (the rows+1-th) lands at the second column's x origin:
		// 1 * (col_w + GUTTER) * cell_w = 40, row band 0.
		let col2 = (0..13).any(|y| (40..48).any(|x| pixels[y * 64 + x] == INK_BLACK));
		assert!(col2, "fifth line must start at the second column's x origin");
		// '\n' consumes no cell: line 1 starts back at x 0 in row band 1.
		let row1 = (16..29).any(|y| (0..8).any(|x| pixels[y * 64 + x] == INK_BLACK));
		assert!(row1, "second line must start at column 0 of the next row band");
		// One-char lines leave the rest of column 0 and the gutter blank.
		for y in 0..64 {
			for x in 8..40 {
				assert_eq!(pixels[y * 64 + x], 0, "gutter must stay blank at ({x},{y})");
			}
		}
	}

	#[test]
	fn doc_sentence_hue_advances_across_newline_boundary() {
		// 152px wide: cols 19, col_w = (19 - 3) / 2 = 8.
		let grid = Grid { cols: 19, rows: 4, repeat: 1, cell_w: 8, cell_h: 16 };
		let pixels = render_doc_bitmap("Hi.\nOk", 152, 64, &FONT_8X13, &grid, false);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1), "first sentence must use ink 1");
		assert!(inks.contains(&2), "hue must advance across the newline boundary");
		assert!(!inks.contains(&3), "no third sentence ink expected");

		// Grid mode keeps the space-only rule: no advance across '\n'.
		let gridmode = render_bitmap("Hi.\nOk", 152, 64, &FONT_8X13, &grid, false);
		let inks: Vec<u8> = gridmode.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1));
		assert!(!inks.contains(&2), "grid mode must not advance hue across newline");
	}

	#[test]
	fn frame_height_hugs_used_rows() {
		let dims = |png: &[u8]| {
			let dim = |off: usize| u32::from_be_bytes(png[off..off + 4].try_into().unwrap());
			(dim(16), dim(20))
		};
		let render = |text: &str, opts: SnapcompactRenderOptions| {
			png_bytes(render_snapcompact_png_sync(text.into(), opts).unwrap())
		};
		let opts_8x8 =
			|| SnapcompactRenderOptions { size: 64, font: Some("8x8".into()), ..Default::default() };
		// 8 cols of 8x8 cells: 10 chars span 2 rows -> 16px tall.
		assert_eq!(dims(&render("0123456789", opts_8x8())), (64, 16));
		// Dim toggles are zero-width and must not add a row.
		assert_eq!(dims(&render("\u{e}01234567\u{f}", opts_8x8())), (64, 8));
		// Capacity-filling text keeps the full grid height.
		assert_eq!(dims(&render(&"x".repeat(64), opts_8x8())), (64, 64));
		// Repeat shapes hug `usedRows * repeat` copy bands.
		let repeated =
			render("0123456789", SnapcompactRenderOptions { line_repeat: Some(2), ..opts_8x8() });
		assert_eq!(dims(&repeated), (64, 32));
		// Doc layout counts `\n` lines down the first column.
		let doc = render("Hello there.\nSecond line", SnapcompactRenderOptions {
			size: 256,
			font: Some("8x13".into()),
			cell_width: Some(8),
			cell_height: Some(16),
			stretch: Some(false),
			columns: Some(2),
			..Default::default()
		});
		assert_eq!(dims(&doc), (256, 32));
		// The stretch path hugs too (RGB output, 6x6 target cells).
		let stretched = render("0123456789ab", SnapcompactRenderOptions {
			size: 60,
			font: Some("8x8".into()),
			cell_width: Some(6),
			cell_height: Some(6),
			..Default::default()
		});
		assert_eq!(dims(&stretched), (60, 12));
	}

	#[test]
	fn columns_validates_and_renders_doc_frames() {
		assert!(
			render_snapcompact_png_sync("x".into(), SnapcompactRenderOptions {
				size: 64,
				columns: Some(3),
				..Default::default()
			})
			.is_err()
		);
		// Indexed doc frame (stretch: false on a padded pitch).
		let doc = png_bytes(
			render_snapcompact_png_sync(
				"Hello there.\nSecond line".into(),
				SnapcompactRenderOptions {
					size: 256,
					font: Some("8x13".into()),
					cell_width: Some(8),
					cell_height: Some(16),
					stretch: Some(false),
					columns: Some(2),
					..Default::default()
				},
			)
			.unwrap(),
		);
		assert_eq!(doc[25], 3, "8on16 doc frame must encode indexed");
		// Doc layout also applies on the stretch path (RGB output).
		let stretched = png_bytes(
			render_snapcompact_png_sync(
				"Hello there.\nSecond line".into(),
				SnapcompactRenderOptions {
					size: 256,
					font: Some("8x13".into()),
					cell_width: Some(6),
					cell_height: Some(12),
					columns: Some(2),
					..Default::default()
				},
			)
			.unwrap(),
		);
		assert_eq!(stretched[25], 2, "stretched doc frame must encode RGB");
	}
}
