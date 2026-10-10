//! Snapcompact frame rendering.
//!
//! Rasterizes pre-normalized conversation text onto a `size`-wide bitmap
//! (height hugs the rows the text needs, with a 64px floor) using one of the
//! bundled public-domain pixel fonts, then encodes it as PNG:
//!
//! - `5x8`  — X.org BDF font (legacy shape).
//! - `8x8`  — unscii-8 hex font (Latin-1 subset), the square cell that won the
//!   snapcompact `SQuAD` evals.
//! - `6x12` / `8x13` — X.org misc BDF fonts (higher-density eval winners).
//! - `silver` — bundled TrueType font for CJK and other non-Latin text.
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

use std::{
	borrow::Cow, collections::HashMap, f32::consts::PI, iter::Peekable, str::Chars, sync::LazyLock,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use fontdue::{Font as TtfFace, FontSettings, Metrics};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;

use crate::{js, task};

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
/// Silver's design size and natural cell. Kept as constants so bitmap shapes
/// can size their fallback glyphs without forcing the multi-megabyte TTF parse
/// (`FONT_SILVER` is only touched when a code point misses the bitmap font).
const SILVER_PX: f32 = 16.0;
const SILVER_CELL: usize = 16;
static FONT_SILVER: LazyLock<TtfFont> = LazyLock::new(|| {
	let face =
		TtfFace::from_bytes(include_bytes!("fonts/Silver.ttf").as_slice(), FontSettings::default())
			.expect("bundled Silver.ttf must parse");
	let ascent = face
		.horizontal_line_metrics(SILVER_PX)
		.map_or(SILVER_PX * 0.8, |metrics| metrics.ascent);
	TtfFont { face, ascent }
});

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

struct TtfFont {
	face:   TtfFace,
	/// Ascent at `SILVER_PX`, the fallback when a size has no line metrics.
	ascent: f32,
}

struct RasterizedGlyph {
	metrics: Metrics,
	bitmap:  Vec<u8>,
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

enum RenderFont<'a> {
	Bitmap(&'a Font),
	Ttf(&'a TtfFont),
}

impl RenderFont<'_> {
	const fn cell_w(&self) -> usize {
		match self {
			Self::Bitmap(font) => font.cell_w,
			Self::Ttf(_) => SILVER_CELL,
		}
	}

	const fn cell_h(&self) -> usize {
		match self {
			Self::Bitmap(font) => font.cell_h,
			Self::Ttf(_) => SILVER_CELL,
		}
	}

	fn supports(&self, code: u32) -> bool {
		if matches!(code, DIM_ON | DIM_OFF | FULL_BLOCK | 0x0a) {
			return true;
		}
		match self {
			Self::Bitmap(font) => font.glyphs.contains_key(&code),
			Self::Ttf(font) => {
				char::from_u32(code).is_some_and(|ch| font.face.lookup_glyph_index(ch) != 0)
			},
		}
	}
}

fn resolve_font(name: &str) -> Option<RenderFont<'static>> {
	match name {
		"5x8" => Some(RenderFont::Bitmap(&FONT_5X8)),
		"8x8" => Some(RenderFont::Bitmap(&FONT_8X8)),
		"6x12" => Some(RenderFont::Bitmap(&FONT_6X12)),
		"8x13" => Some(RenderFont::Bitmap(&FONT_8X13)),
		"silver" => Some(RenderFont::Ttf(&FONT_SILVER)),
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

/// East Asian Wide / Fullwidth code points that occupy two grid cells when
/// drawn through the Silver fallback in a narrow bitmap shape. The same ranges
/// are mirrored in `packages/snapcompact/src/snapcompact.ts` so the TypeScript
/// capacity/pagination math and this layout never disagree on cell counts.
const fn is_wide(cp: u32) -> bool {
	matches!(cp,
		0x1100..=0x115F
		| 0x2E80..=0x2EFF
		| 0x2F00..=0x2FDF
		| 0x3000..=0x303E
		| 0x3041..=0x33FF
		| 0x3400..=0x4DBF
		| 0x4E00..=0x9FFF
		| 0xA000..=0xA4CF
		| 0xAC00..=0xD7A3
		| 0xF900..=0xFAFF
		| 0xFE30..=0xFE4F
		| 0xFF00..=0xFF60
		| 0xFFE0..=0xFFE6
		| 0x20000..=0x2FFFD
		| 0x30000..=0x3FFFD
	)
}

/// One inked cell yielded by [`Layout`]: the character, its resolved palette
/// ink, the pixel x origin of its (first) cell, the grid row band it prints
/// on, and how many cells it spans.
struct LaidCell {
	ch:    char,
	ink:   u8,
	x:     usize,
	row:   usize,
	units: usize,
}

/// The single layout/ink state machine behind every renderer and the canvas
/// height (`used_rows`), so cell accounting and drawing cannot drift apart.
///
/// Grid layout is row-major with no word wrap; characters beyond
/// `cols * rows` are dropped. Doc layout (`columns: 2`) splits on `'\n'`
/// (zero-width): line `li` lands at column `li / rows`, row `li % rows`; each
/// column is `(cols - GUTTER) / 2` cells wide, the second starts
/// `col_w + GUTTER` cells in; overlong lines clip and lines past the second
/// column are dropped (the TypeScript caller pre-wraps and paginates).
///
/// `U+000E`/`U+000F` toggle dim ink without occupying a cell. Ink is dim, else
/// black for `bw`, else one of six hues that advances after a terminator in
/// `.!?` followed by a space or full block (doc mode: also a newline). With
/// `wide_cells` (bitmap shapes) East Asian wide code points take two cells and
/// are padded to the next row/column edge rather than split across it.
///
/// The walk ends at the first `None` (capacity reached, past the second doc
/// column, or end of text); it is not fused.
struct Layout<'a> {
	chars:      Peekable<Chars<'a>>,
	grid:       &'a Grid,
	doc:        bool,
	/// Doc column width in cells.
	col_w:      usize,
	wide_cells: bool,
	black_ink:  bool,
	sentence:   usize,
	dim:        bool,
	/// Grid: next cell index. Doc: next cell within the current line.
	cursor:     usize,
	/// Doc: current `'\n'`-separated line.
	line:       usize,
}

impl<'a> Layout<'a> {
	fn new(text: &'a str, grid: &'a Grid, doc: bool, wide_cells: bool, black_ink: bool) -> Self {
		Self {
			chars: text.chars().peekable(),
			grid,
			doc,
			col_w: grid.cols.saturating_sub(GUTTER) / 2,
			wide_cells,
			black_ink,
			sentence: 0,
			dim: false,
			cursor: 0,
			line: 0,
		}
	}

	/// No cell can ever be placed, so renderers skip painting entirely.
	const fn is_empty(&self) -> bool {
		if self.doc {
			self.col_w == 0 || self.grid.rows == 0
		} else {
			self.grid.cols * self.grid.rows == 0
		}
	}

	/// Grid rows the text occupies, so the canvas height hugs the content
	/// instead of padding the frame to a full square. Runs the same walk the
	/// renderers draw from; when it stops early (capacity reached, or past the
	/// second doc column) the count already exceeds `grid.rows`, so the clamp
	/// gives the same answer as counting the whole text.
	fn used_rows(mut self) -> usize {
		self.by_ref().for_each(drop);
		let rows = if self.doc {
			self.line + 1
		} else {
			self.cursor.div_ceil(self.grid.cols)
		};
		rows.clamp(1, self.grid.rows)
	}
}

impl Iterator for Layout<'_> {
	type Item = LaidCell;

	fn next(&mut self) -> Option<LaidCell> {
		let grid = self.grid;
		loop {
			if !self.doc && self.cursor >= grid.cols * grid.rows {
				return None;
			}
			let ch = self.chars.next()?;
			let code = ch as u32;
			match code {
				DIM_ON => {
					self.dim = true;
					continue;
				},
				DIM_OFF => {
					self.dim = false;
					continue;
				},
				0x0a if self.doc => {
					self.line += 1;
					self.cursor = 0;
					if self.line >= grid.rows * 2 {
						return None;
					}
					continue;
				},
				_ => {},
			}
			let ink = if self.dim {
				INK_DIM
			} else if self.black_ink {
				INK_BLACK
			} else {
				(1 + self.sentence % INK_COLORS) as u8
			};
			if matches!(code, 0x2e | 0x21 | 0x3f)
				&& self.chars.peek().is_some_and(|&next| {
					matches!(next as u32, 0x20 | FULL_BLOCK) || (self.doc && next == '\n')
				}) {
				self.sentence += 1;
			}
			let units = if self.wide_cells && is_wide(code) {
				2
			} else {
				1
			};
			let mut cell = self.cursor;
			if self.doc {
				if units == 2 && self.col_w >= 2 && cell == self.col_w - 1 {
					cell += 1; // pad: never split a wide glyph across the column edge
				}
				self.cursor = cell + units;
				if self.cursor > self.col_w {
					continue; // clip past the column width
				}
				let column = self.line / grid.rows;
				let row = self.line - column * grid.rows;
				let x = (column * (self.col_w + GUTTER) + cell) * grid.cell_w;
				return Some(LaidCell { ch, ink, x, row, units });
			}
			if units == 2 && grid.cols >= 2 && cell % grid.cols == grid.cols - 1 {
				cell += 1; // pad: never split a wide glyph across two rows
			}
			self.cursor = cell + units;
			if cell >= grid.cols * grid.rows {
				return None;
			}
			let row = cell / grid.cols;
			let x = (cell - row * grid.cols) * grid.cell_w;
			return Some(LaidCell { ch, ink, x, row, units });
		}
	}
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

fn fill_repeat_bands_rgb(pixels: &mut [u8], width: usize, height: usize, grid: &Grid) {
	if grid.repeat <= 1 {
		return;
	}
	let band = PALETTE[BG_REPEAT as usize];
	for row in 0..grid.rows {
		for copy in 1..grid.repeat {
			let band_top = (row * grid.repeat + copy) * grid.cell_h;
			for y in band_top..(band_top + grid.cell_h).min(height) {
				for px in pixels[y * width * 3..(y + 1) * width * 3]
					.as_chunks_mut::<3>()
					.0
				{
					px.copy_from_slice(&band);
				}
			}
		}
	}
}

fn fill_cell_rgb(
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
	let color = PALETTE[ink as usize];
	for copy in 0..grid.repeat {
		let top = (row * grid.repeat + copy) * grid.cell_h;
		for y in top..(top + grid.cell_h).min(height) {
			let row = &mut pixels[y * width * 3..(y + 1) * width * 3];
			for x in x0..x1 {
				row[x * 3..x * 3 + 3].copy_from_slice(&color);
			}
		}
	}
}

/// Silver pixel size for a glyph spanning `units` grid cells: scaled to that
/// box so full-width fallback CJK fills its doubled width instead of a single
/// narrow ASCII cell.
fn ttf_pixel_size(grid: &Grid, units: usize) -> f32 {
	let sx = (units * grid.cell_w) as f32 / SILVER_CELL as f32;
	let sy = grid.cell_h as f32 / SILVER_CELL as f32;
	SILVER_PX * sx.min(sy)
}

fn ttf_ascent(font: &TtfFont, px: f32) -> f32 {
	font
		.face
		.horizontal_line_metrics(px)
		.map_or(font.ascent * px / SILVER_PX, |metrics| metrics.ascent)
}

fn cached_ttf_glyph<'a>(
	cache: &'a mut HashMap<char, RasterizedGlyph>,
	font: &TtfFont,
	ch: char,
	px: f32,
) -> Option<&'a RasterizedGlyph> {
	if font.face.lookup_glyph_index(ch) == 0 {
		return None;
	}
	Some(cache.entry(ch).or_insert_with(|| {
		let (metrics, bitmap) = font.face.rasterize(ch, px);
		RasterizedGlyph { metrics, bitmap }
	}))
}

fn blit_ttf_glyph(
	pixels: &mut [u8],
	width: usize,
	height: usize,
	glyph: &RasterizedGlyph,
	left: i32,
	top: i32,
	ink: u8,
) {
	if glyph.metrics.width == 0 || glyph.metrics.height == 0 {
		return;
	}
	let color = PALETTE[ink as usize];
	for y in 0..glyph.metrics.height {
		let dst_y = top + y as i32;
		if dst_y < 0 || dst_y >= height as i32 {
			continue;
		}
		for x in 0..glyph.metrics.width {
			let alpha = u16::from(glyph.bitmap[y * glyph.metrics.width + x]);
			if alpha == 0 {
				continue;
			}
			let dst_x = left + x as i32;
			if dst_x < 0 || dst_x >= width as i32 {
				continue;
			}
			let offset = (dst_y as usize * width + dst_x as usize) * 3;
			let inv = 255 - alpha;
			for c in 0..3 {
				let bg = u16::from(pixels[offset + c]);
				let fg = u16::from(color[c]);
				pixels[offset + c] = ((bg * inv + fg * alpha + 127) / 255) as u8;
			}
		}
	}
}

fn blit_ttf_glyph_indexed(
	pixels: &mut [u8],
	width: usize,
	height: usize,
	glyph: &RasterizedGlyph,
	left: i32,
	top: i32,
	ink: u8,
) {
	if glyph.metrics.width == 0 || glyph.metrics.height == 0 {
		return;
	}
	for y in 0..glyph.metrics.height {
		let dst_y = top + y as i32;
		if dst_y < 0 || dst_y >= height as i32 {
			continue;
		}
		let row_base = dst_y as usize * width;
		for x in 0..glyph.metrics.width {
			// Two-level anti-alias for the on/off indexed palette: a solid core
			// only where coverage is high, and a single dim-gray fringe on the
			// partially covered edges, so scaled CJK reads lighter than a
			// flat-thresholded (and visibly bold) glyph. Dim spans stay dim.
			let coverage = glyph.bitmap[y * glyph.metrics.width + x];
			let cell = if coverage >= 170 {
				ink
			} else if ink == INK_BLACK && coverage >= 56 {
				INK_DIM // soft gray fringe only on black ink (one neutral palette slot)
			} else if coverage >= 110 {
				ink
			} else {
				continue;
			};
			let dst_x = left + x as i32;
			if dst_x >= 0 && dst_x < width as i32 {
				pixels[row_base + dst_x as usize] = cell;
			}
		}
	}
}

fn ttf_glyph_origin(x_origin: usize, cell_w: usize, metrics: &Metrics) -> i32 {
	let advance = metrics.advance_width.ceil() as i32;
	let pad = (cell_w as i32 - advance).max(0) / 2;
	x_origin as i32 + pad + metrics.xmin
}

fn ttf_glyph_top(cell_top: usize, ascent: f32, metrics: &Metrics) -> i32 {
	(cell_top as f32 + ascent - metrics.height as f32 - metrics.ymin as f32).round() as i32
}

/// Rasterize `text` onto a `width` x `height` palette-indexed bitmap on the
/// grid's cell box, laid out by [`Layout`] (grid, or two doc columns when
/// `doc`). Glyphs keep their natural size with the baseline at the font's
/// ascent from the cell top, so a cell taller than the font pads below the
/// baseline (the "8on16" shapes). Each text line is printed `grid.repeat`
/// times; copies after the first sit on the highlight band. `U+2588` fills
/// its whole cell with pitch-black ink, ignoring hue and dim state. Code
/// points missing from the bitmap font draw through the embedded Silver
/// TrueType fallback when it has a glyph.
fn render_bitmap(
	text: &str,
	width: usize,
	height: usize,
	font: &Font,
	grid: &Grid,
	doc: bool,
	black_ink: bool,
) -> Vec<u8> {
	let mut pixels = vec![0u8; width * height]; // 0 = white background
	let layout = Layout::new(text, grid, doc, true, black_ink);
	if layout.is_empty() {
		return pixels;
	}
	fill_repeat_bands(&mut pixels, width, height, grid);
	let mut fallback_cache = HashMap::new();
	for cell in layout {
		if cell.ch as u32 == FULL_BLOCK {
			fill_cell(&mut pixels, width, height, grid, cell.x, cell.row, INK_BLACK);
			continue;
		}
		if let Some(glyph) = font.glyphs.get(&(cell.ch as u32)) {
			if glyph.rows.is_empty() {
				continue;
			}
			let left = cell.x as i32 + glyph.xoff;
			for copy in 0..grid.repeat {
				let cell_top = ((cell.row * grid.repeat + copy) * grid.cell_h) as i32;
				let top = cell_top + font.ascent - glyph.h - glyph.yoff;
				blit_glyph(&mut pixels, width, height, glyph, left, top, cell.ink);
			}
		} else {
			let px = ttf_pixel_size(grid, cell.units);
			let Some(glyph) = cached_ttf_glyph(&mut fallback_cache, &FONT_SILVER, cell.ch, px) else {
				continue;
			};
			let left = ttf_glyph_origin(cell.x, cell.units * grid.cell_w, &glyph.metrics);
			for copy in 0..grid.repeat {
				let cell_top = (cell.row * grid.repeat + copy) * grid.cell_h;
				let top = ttf_glyph_top(cell_top, font.ascent as f32, &glyph.metrics);
				blit_ttf_glyph_indexed(&mut pixels, width, height, glyph, left, top, cell.ink);
			}
		}
	}
	pixels
}

/// RGB counterpart of [`render_bitmap`] for the TrueType font: same layout,
/// glyphs alpha-blended from grayscale coverage, one cell per code point.
fn render_ttf_rgb(
	text: &str,
	width: usize,
	height: usize,
	font: &TtfFont,
	grid: &Grid,
	doc: bool,
	black_ink: bool,
) -> Vec<u8> {
	let mut pixels = vec![255u8; width * height * 3];
	let layout = Layout::new(text, grid, doc, false, black_ink);
	if layout.is_empty() {
		return pixels;
	}
	fill_repeat_bands_rgb(&mut pixels, width, height, grid);
	let px = ttf_pixel_size(grid, 1);
	let ascent = ttf_ascent(font, px);
	let mut cache = HashMap::new();
	for cell in layout {
		if cell.ch as u32 == FULL_BLOCK {
			fill_cell_rgb(&mut pixels, width, height, grid, cell.x, cell.row, INK_BLACK);
			continue;
		}
		let Some(glyph) = cached_ttf_glyph(&mut cache, font, cell.ch, px) else {
			continue;
		};
		let left = ttf_glyph_origin(cell.x, grid.cell_w, &glyph.metrics);
		for copy in 0..grid.repeat {
			let cell_top = (cell.row * grid.repeat + copy) * grid.cell_h;
			let top = ttf_glyph_top(cell_top, ascent, &glyph.metrics);
			blit_ttf_glyph(&mut pixels, width, height, glyph, left, top, cell.ink);
		}
	}
	pixels
}

/// Character cells between the two doc columns (eval `exp14` layout).
const GUTTER: usize = 3;

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

/// `a * b + c`, fused only when the build targets FMA: without it (`x86-64-v2`
/// baseline) `mul_add` lowers to a scalar libm `fmaf` call per element.
#[inline(always)]
#[allow(clippy::suboptimal_flops, reason = "`mul_add` is a slow libm call on x86-64 without FMA")]
fn madd(a: f32, b: f32, c: f32) -> f32 {
	if cfg!(target_feature = "fma") {
		a.mul_add(b, c)
	} else {
		a * b + c
	}
}

/// Separable Lanczos3 resize of a palette-indexed `sw` x `sh` canvas into the
/// top-left `dw` x `dh` corner of the RGB8 `frame` (row stride `frame_w`
/// pixels). The horizontal pass reads palette colours straight from the
/// indices and the vertical pass accumulates one output row at a time, so the
/// only full-size f32 buffer is the `dw * sh` horizontal intermediate (no f32
/// copy of the source, no f32 copy of the output).
fn stretch_indexed(
	src: &[u8],
	sw: usize,
	sh: usize,
	dw: usize,
	dh: usize,
	frame: &mut [u8],
	frame_w: usize,
) {
	let horiz = contributions(sw, dw);
	let mut tmp = vec![0f32; dw * sh * 3];
	for y in 0..sh {
		let src_row = &src[y * sw..(y + 1) * sw];
		let dst_row = &mut tmp[y * dw * 3..(y + 1) * dw * 3];
		for (x, (begin, weights)) in horiz.iter().enumerate() {
			let mut acc = [0f32; 3];
			for (&idx, &w) in src_row[*begin..].iter().zip(weights) {
				let [r, g, b] = PALETTE[idx as usize];
				acc[0] = madd(f32::from(r), w, acc[0]);
				acc[1] = madd(f32::from(g), w, acc[1]);
				acc[2] = madd(f32::from(b), w, acc[2]);
			}
			dst_row[x * 3..x * 3 + 3].copy_from_slice(&acc);
		}
	}
	let vert = contributions(sh, dh);
	let mut acc_row = vec![0f32; dw * 3];
	let copy_len = dw.min(frame_w) * 3;
	for (y, (begin, weights)) in vert.iter().enumerate() {
		acc_row.fill(0.0);
		for (k, &w) in weights.iter().enumerate() {
			let src_row = &tmp[(begin + k) * dw * 3..(begin + k + 1) * dw * 3];
			for (d, &s) in acc_row.iter_mut().zip(src_row) {
				*d = madd(s, w, *d);
			}
		}
		let dst_row = &mut frame[y * frame_w * 3..][..copy_len];
		for (d, &s) in dst_row.iter_mut().zip(&acc_row) {
			*d = s.round().clamp(0.0, 255.0) as u8;
		}
	}
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
	/// (`floor(size/cellHeight/lineRepeat)`). Output height hugs the used rows
	/// with a 64px floor, rather than padding every frame to a square.
	pub size:        u32,
	/// Bundled font: `"5x8"`, `"6x12"`, `"8x13"` (X.org BDF), `"8x8"`
	/// (unscii-8), or `"silver"` (embedded TrueType). Default `"5x8"`.
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

/// Return the subset of `chars` that the named snapcompact font can render.
///
/// The TypeScript normalizer uses this to keep Unicode text intact only when
/// the selected native font has a glyph for it; renderer control codes are
/// considered renderable because they are interpreted outside font lookup.
#[napi]
pub fn snapcompact_supported_chars(font: JsString, chars: JsString) -> Result<String> {
	let font_name = js::utf8(font)?;
	let font = resolve_font(&font_name).ok_or_else(|| {
		Error::from_reason(format!(
			"Unknown snapcompact font {:?}: expected \"5x8\", \"8x8\", \"6x12\", \"8x13\", or \
			 \"silver\"",
			&*font_name
		))
	})?;
	let chars = js::utf8(chars)?;
	let mut supported = String::with_capacity(chars.len());
	for ch in chars.chars() {
		if matches!(ch as u32, DIM_ON | DIM_OFF | FULL_BLOCK | 0x0a) || font.supports(ch as u32) {
			supported.push(ch);
		}
	}
	Ok(supported)
}

/// Render one snapcompact frame on a libuv worker: print pre-normalized text
/// onto a `size`-wide bitmap and encode it as PNG.
///
/// The bitmap height hugs the rows the text occupies
/// (`usedRows * lineRepeat * cellHeight`), with a 64px floor for vision
/// processors that reject smaller dimensions. The glyph grid holds
/// `floor(size/cellWidth) * floor(size/cellHeight/lineRepeat)` characters;
/// input beyond that is ignored.
/// Native-cell bitmap-font shapes encode as indexed PNG; stretched bitmap-font
/// shapes (target cell != font cell) encode as RGB. TrueType shapes encode RGB
/// directly from grayscale coverage.
/// `stretch: false` pins bitmap fonts to the indexed path, printing
/// natural-size glyphs on the requested cell box; `columns: 2` flows
/// pre-wrapped newline-separated lines down two newspaper columns.
/// `U+000E`/`U+000F` in `text` toggle dim-gray ink spans without occupying a
/// cell.
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
			"Unknown snapcompact font {font_name:?}: expected \"5x8\", \"8x8\", \"6x12\", \"8x13\", \
			 or \"silver\""
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
	let natural_w = font.cell_w();
	let natural_h = font.cell_h();
	let target_w = options.cell_width.unwrap_or(natural_w as u32).max(1) as usize;
	let target_h = options.cell_height.unwrap_or(natural_h as u32).max(1) as usize;
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
	// Keep the tight layout for normal pages, but give short pages enough
	// canvas for vision processors that reject dimensions at or below 32px.
	let wide_cells = matches!(font, RenderFont::Bitmap(_));
	let used = Layout::new(&text, &grid, doc, wide_cells, black_ink).used_rows();
	let content_height = used * grid.repeat * grid.cell_h;
	let height = content_height.max(64);

	match font {
		RenderFont::Ttf(font) => {
			let mut pixels = render_ttf_rgb(&text, size, height, font, &grid, doc, black_ink);
			pixels[content_height * size * 3..].fill(255);
			Ok(STANDARD
				.encode(encode_rgb_png(&pixels, size, height, png::Compression::High)?)
				.into())
		},
		RenderFont::Bitmap(font) => {
			let stretch =
				options.stretch != Some(false) && (target_w, target_h) != (natural_w, natural_h);
			if !stretch {
				// Indexed path: rasterize straight onto the frame at the requested
				// cell box (the natural cell, or natural glyphs on a padded pitch
				// when `stretch: false`).
				let mut pixels = render_bitmap(&text, size, height, font, &grid, doc, black_ink);
				pixels[content_height * size..].fill(0);
				return Ok(STANDARD
					.encode(encode_indexed_png(&pixels, size, height, png::Compression::High)?)
					.into());
			}

			// Stretch shape: rasterize at the font's natural cell on a tight
			// canvas (layout stays in character cells from the target grid),
			// Lanczos3- resample to the target cell, paste onto the white
			// frame.
			let native = Grid { cell_w: natural_w, cell_h: natural_h, ..grid };
			let src_w = grid.cols * natural_w;
			let src_h = used * grid.repeat * natural_h;
			let dst_w = grid.cols * target_w;
			let dst_h = used * grid.repeat * target_h;
			let indexed = render_bitmap(&text, src_w, src_h, font, &native, doc, black_ink);
			let mut frame = vec![255u8; size * height * 3];
			stretch_indexed(&indexed, src_w, src_h, dst_w, dst_h, &mut frame, size);
			Ok(STANDARD
				.encode(encode_rgb_png(&frame, size, height, png::Compression::High)?)
				.into())
		},
	}
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
	fn silver_font_covers_cjk_scripts() {
		for ch in ['こ', '你', '안'] {
			assert_ne!(FONT_SILVER.face.lookup_glyph_index(ch), 0, "Silver must cover {ch:?}");
		}
	}

	#[test]
	fn digit_zero_is_disambiguated_from_letter_o() {
		// Regression for #8713: the default snapcompact bitmap fonts drew digit
		// `0` and letter `O` as bare ovals that OCR back ambiguously, corrupting
		// compacted identifiers. Each `0` now carries an interior slash/bar the
		// `O` lacks, so it inks strictly more of the glyph's vertical middle even
		// though it is the narrower oval (its wider top/bottom arcs sit outside
		// the sampled band). unscii-8 already shipped a slashed zero.
		for font in [&*FONT_5X8, &*FONT_6X12, &*FONT_8X13] {
			let (cw, ch) = (font.cell_w, font.cell_h);
			let width = cw * 2;
			let grid = Grid { cols: 2, rows: 1, repeat: 1, cell_w: cw, cell_h: ch };
			let px = render_bitmap("0O", width, ch, font, &grid, false, true);
			let band = ch / 4..ch - ch / 4;
			let mid_ink = |col0: usize| -> usize {
				band
					.clone()
					.flat_map(|y| (col0..col0 + cw).map(move |x| (x, y)))
					.filter(|&(x, y)| px[y * width + x] != 0)
					.count()
			};
			let (zero, oh) = (mid_ink(0), mid_ink(cw));
			assert!(
				zero > oh,
				"cell {cw}x{ch}: zero must ink its middle more than O (zero={zero}, O={oh})"
			);
		}
	}

	#[test]
	fn bitmap_inks_sentences_and_caps_capacity() {
		// 40px -> 8 cols x 5 rows = 40 cells (5x8 font).
		let grid = Grid { cols: 8, rows: 5, repeat: 1, cell_w: 5, cell_h: 8 };
		let pixels = render_bitmap("Hi. Ok.", 40, 40, &FONT_5X8, &grid, false, false);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1), "first sentence should use ink 1");
		assert!(inks.contains(&2), "second sentence should use ink 2");
		assert!(!inks.contains(&3), "no third sentence ink expected");

		// Overflow input renders without panicking and stays in-bounds.
		let overflow = render_bitmap(&"x".repeat(100), 40, 40, &FONT_5X8, &grid, false, false);
		assert_eq!(overflow.len(), 40 * 40);
	}

	#[test]
	fn bw_variant_prints_black_only() {
		let grid = Grid { cols: 8, rows: 8, repeat: 1, cell_w: 8, cell_h: 8 };
		let pixels = render_bitmap("Hi. Ok.", 64, 64, &FONT_8X8, &grid, false, true);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(!inks.is_empty());
		assert!(inks.iter().all(|&p| p == INK_BLACK), "bw must ink only black");
	}

	#[test]
	fn dim_markers_toggle_gray_without_consuming_cells() {
		let grid = Grid { cols: 8, rows: 8, repeat: 1, cell_w: 8, cell_h: 8 };
		let pixels = render_bitmap("\u{e}AB\u{f}CD", 64, 64, &FONT_8X8, &grid, false, true);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&INK_DIM), "dim span must ink gray");
		assert!(inks.contains(&INK_BLACK), "post-span text must return to black");
		// Markers are zero-width: glyphs land in the same cells as without them.
		let plain = render_bitmap("ABCD", 64, 64, &FONT_8X8, &grid, false, true);
		for (i, (a, b)) in pixels.iter().zip(&plain).enumerate() {
			assert_eq!(*a != 0, *b != 0, "cell layout must ignore markers (pixel {i})");
		}
	}

	#[test]
	fn line_repeat_duplicates_rows_on_highlight_bands() {
		// 64px, 8x8 font, repeat 2 -> 8 cols x 4 unique rows.
		let grid = Grid { cols: 8, rows: 4, repeat: 2, cell_w: 8, cell_h: 8 };
		let pixels = render_bitmap("ABCDEFGH", 64, 64, &FONT_8X8, &grid, false, true);
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
		let pixels = render_bitmap("\u{e}a\u{2588}b\u{f}", 64, 64, &FONT_8X8, &grid, false, false);
		for copy in 0..2 {
			for y in copy * 8..(copy + 1) * 8 {
				for x in 8..16 {
					assert_eq!(pixels[y * 64 + x], INK_BLACK, "block pixel ({x},{y}) must be black");
				}
			}
		}
		assert!(pixels.contains(&INK_DIM), "neighbours keep their dim ink");
		let hued = render_bitmap("Hi.\u{2588}Ok.", 64, 64, &FONT_8X8, &grid, false, false);
		assert!(hued.contains(&2), "block must advance the sentence hue like a space");
	}

	#[test]
	fn doc_full_block_fills_cell() {
		// col_w = (13 - GUTTER) / 2 = 5; block at line 0, cell 1 -> x 8..16.
		let grid = Grid { cols: 13, rows: 2, repeat: 1, cell_w: 8, cell_h: 8 };
		let pixels = render_bitmap("a\u{2588}b\nc", 104, 16, &FONT_8X8, &grid, true, true);
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

		let silver = png_bytes(
			render_snapcompact_png_sync(
				"こんにちは 你好 안녕".into(),
				SnapcompactRenderOptions {
					size: 128,
					font: Some("silver".into()),
					cell_width: Some(16),
					cell_height: Some(16),
					variant: Some("bw".into()),
					..Default::default()
				},
			)
			.unwrap(),
		);
		assert_eq!(silver[25], 2, "TrueType frames render as RGB");
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
		let pixels = render_bitmap("Hello", 60, 60, &FONT_6X12, &grid, false, true);
		assert!(pixels.contains(&INK_BLACK), "6x12 must ink pixels");
		let grid = Grid { cols: 8, rows: 8, repeat: 1, cell_w: 8, cell_h: 13 };
		let pixels = render_bitmap("Hello", 64, 104, &FONT_8X13, &grid, false, true);
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
		// of the 16px pitch. 32px is under the 64px floor, so the frame is 64px
		// tall rather than padded to the 128px square.
		assert_eq!((dim(16), dim(20)), (128, 64), "declared geometry must match");

		// Glyph ink must sit in the top 13px of every 16px pitch row.
		let grid = Grid { cols: 16, rows: 8, repeat: 1, cell_w: 8, cell_h: 16 };
		let pixels =
			render_bitmap("Hgjpqy. Mixed descenders!", 128, 128, &FONT_8X13, &grid, false, true);
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
		let pixels = render_bitmap("A\nB\nC\nD\nE", 64, 64, &FONT_8X13, &grid, true, true);
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
		let pixels = render_bitmap("Hi.\nOk", 152, 64, &FONT_8X13, &grid, true, false);
		let inks: Vec<u8> = pixels.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1), "first sentence must use ink 1");
		assert!(inks.contains(&2), "hue must advance across the newline boundary");
		assert!(!inks.contains(&3), "no third sentence ink expected");

		// Grid mode keeps the space-only rule: no advance across '\n'.
		let gridmode = render_bitmap("Hi.\nOk", 152, 64, &FONT_8X13, &grid, false, false);
		let inks: Vec<u8> = gridmode.iter().copied().filter(|&p| p != 0).collect();
		assert!(inks.contains(&1));
		assert!(!inks.contains(&2), "grid mode must not advance hue across newline");
	}

	#[test]
	fn frame_height_hugs_used_rows_above_a_64px_floor() {
		let dims = |png: &[u8]| {
			let dim = |off: usize| u32::from_be_bytes(png[off..off + 4].try_into().unwrap());
			(dim(16), dim(20))
		};
		let render = |text: &str, opts: SnapcompactRenderOptions| {
			png_bytes(render_snapcompact_png_sync(text.into(), opts).unwrap())
		};
		let opts_8x8 =
			|| SnapcompactRenderOptions { size: 256, font: Some("8x8".into()), ..Default::default() };
		// 32 cols of 8x8 cells: 288 chars span 9 rows -> 72px tall.
		let nine_rows = "x".repeat(32 * 9);
		assert_eq!(dims(&render(&nine_rows, opts_8x8())), (256, 72));
		// Dim toggles are zero-width and must not add a row.
		assert_eq!(dims(&render(&format!("\u{e}{nine_rows}\u{f}"), opts_8x8())), (256, 72));
		// Capacity-filling text keeps the full grid height.
		assert_eq!(dims(&render(&"x".repeat(32 * 32), opts_8x8())), (256, 256));
		// One 8px row is padded to the 64px floor vision backends accept.
		assert_eq!(dims(&render("0123456789", opts_8x8())), (256, 64));
		// Repeat shapes hug `usedRows * repeat` copy bands.
		let repeated =
			render(&nine_rows, SnapcompactRenderOptions { line_repeat: Some(2), ..opts_8x8() });
		assert_eq!(dims(&repeated), (256, 144));
		// Doc layout counts `\n` lines down the first column: 5 rows of 16px.
		let doc = render("A\nB\nC\nD\nE", SnapcompactRenderOptions {
			size: 256,
			font: Some("8x13".into()),
			cell_width: Some(8),
			cell_height: Some(16),
			stretch: Some(false),
			columns: Some(2),
			..Default::default()
		});
		assert_eq!(dims(&doc), (256, 80));
		// The stretch path (RGB output, 6x6 target cells) hugs and floors too.
		let stretched = |text: &str| {
			render(text, SnapcompactRenderOptions {
				size: 120,
				font: Some("8x8".into()),
				cell_width: Some(6),
				cell_height: Some(6),
				..Default::default()
			})
		};
		assert_eq!(dims(&stretched(&"x".repeat(20 * 12))), (120, 72));
		assert_eq!(dims(&stretched("0123456789ab")), (120, 64));
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
