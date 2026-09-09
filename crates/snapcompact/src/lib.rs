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
//! Text framing and provider shape selection are exposed by [`archive`]; this
//! module also contains the hot `text -> PNG bytes` path.

/// Provider-aware shapes, framing, and savings accounting.
pub mod archive;

use std::{
	borrow::Cow,
	collections::{HashMap, HashSet},
	f32::consts::PI,
	result,
	sync::LazyLock,
};

use fontdue::{Font as TtfFace, FontSettings, Metrics};

/// Failure to validate or encode a snapcompact frame.
#[derive(Debug, thiserror::Error)]
pub enum SnapcompactError {
	/// Frame dimensions are outside the renderer's allocation bound.
	#[error("invalid frame size {size}: expected 1..={max}")]
	InvalidFrameSize {
		/// Requested edge in pixels.
		size: u32,
		/// Maximum permitted edge in pixels.
		max:  u32,
	},
	/// A bundled font name was not recognized.
	#[error("unknown snapcompact font {font:?}")]
	UnknownFont {
		/// Requested font name.
		font: String,
	},
	/// An ink variant was not recognized.
	#[error("unknown snapcompact variant {variant:?}: expected \"sent\" or \"bw\"")]
	UnknownVariant {
		/// Requested variant.
		variant: String,
	},
	/// The requested newspaper-column count is unsupported.
	#[error("invalid snapcompact columns {columns}: expected 1 or 2")]
	InvalidColumns {
		/// Requested column count.
		columns: u32,
	},
	/// The frame cannot hold even one requested cell.
	#[error("frame size {size} cannot fit a {cell_width}x{cell_height} cell grid (repeat {repeat})")]
	EmptyGrid {
		/// Requested frame edge.
		size:        usize,
		/// Requested cell width.
		cell_width:  usize,
		/// Requested cell height.
		cell_height: usize,
		/// Requested line repetition.
		repeat:      usize,
	},
	/// PNG encoding failed.
	#[error(transparent)]
	Png(#[from] png::EncodingError),
}

/// Result returned by the pure Rust renderer.
pub type Result<T, E = SnapcompactError> = result::Result<T, E>;

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
static FONT_SILVER: LazyLock<TtfFont> =
	LazyLock::new(|| parse_ttf(include_bytes!("fonts/Silver.ttf"), 16.0, 16, 16));

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
	face:      TtfFace,
	supported: HashSet<char>,
	px:        f32,
	ascent:    f32,
	cell_w:    usize,
	cell_h:    usize,
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

fn parse_ttf(data: &'static [u8], px: f32, cell_w: usize, cell_h: usize) -> TtfFont {
	let face =
		TtfFace::from_bytes(data, FontSettings::default()).expect("bundled Silver.ttf must parse");
	let supported = face.chars().keys().copied().collect();
	let ascent = face
		.horizontal_line_metrics(px)
		.map_or(px * 0.8, |metrics| metrics.ascent);
	TtfFont { face, supported, px, ascent, cell_w, cell_h }
}

enum RenderFont<'a> {
	Bitmap(&'a Font),
	Ttf(&'a TtfFont),
}

impl RenderFont<'_> {
	const fn cell_w(&self) -> usize {
		match self {
			Self::Bitmap(font) => font.cell_w,
			Self::Ttf(font) => font.cell_w,
		}
	}

	const fn cell_h(&self) -> usize {
		match self {
			Self::Bitmap(font) => font.cell_h,
			Self::Ttf(font) => font.cell_h,
		}
	}

	fn supports(&self, code: u32) -> bool {
		if matches!(code, DIM_ON | DIM_OFF | FULL_BLOCK | 0x0a) {
			return true;
		}
		match self {
			Self::Bitmap(font) => font.glyphs.contains_key(&code),
			Self::Ttf(font) => char::from_u32(code).is_some_and(|ch| font.supported.contains(&ch)),
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

/// Cells one code point consumes in a grid of `wide_cells`-capable shape: zero
/// for the zero-width dim toggles, two for wide code points when the shape uses
/// a narrow bitmap cell (so CJK draws full-width through Silver), one
/// otherwise.
pub(crate) const fn cell_units(code: u32, wide_cells: bool) -> usize {
	match code {
		DIM_ON | DIM_OFF => 0,
		_ if wide_cells && is_wide(code) => 2,
		_ => 1,
	}
}

/// Advance the running cell cursor for one code point, inserting a one-cell pad
/// when a wide glyph would straddle the right edge so it starts the next row.
/// Returns `(cell_at_which_to_draw, units, next_cursor)`, or `None` for a
/// zero-width toggle.
const fn place_cell(
	cursor: usize,
	cols: usize,
	code: u32,
	wide_cells: bool,
) -> Option<(usize, usize, usize)> {
	let units = cell_units(code, wide_cells);
	if units == 0 {
		return None;
	}
	let mut cell = cursor;
	if units == 2 && cols >= 2 && cell % cols == cols - 1 {
		cell += 1; // pad: never split a wide glyph across two rows
	}
	Some((cell, units, cell + units))
}

/// Grid rows the text actually occupies, so the canvas height hugs the
/// content instead of padding the frame to a full square. Mirrors the
/// renderers' cell accounting: dim toggles are zero-width, wide code points
/// take two cells in bitmap shapes (with a straddle pad), every other code
/// point one; doc layout fills one row per `\n`-separated line.
fn used_rows(text: &str, grid: &Grid, doc: bool, wide_cells: bool) -> usize {
	let rows = if doc {
		text.split('\n').count()
	} else {
		let mut cursor = 0usize;
		for ch in text.chars() {
			if let Some((_, _, next)) = place_cell(cursor, grid.cols, ch as u32, wide_cells) {
				cursor = next;
			}
		}
		cursor.div_ceil(grid.cols)
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

fn ttf_pixel_size(font: &TtfFont, grid: &Grid) -> f32 {
	let sx = grid.cell_w as f32 / font.cell_w as f32;
	let sy = grid.cell_h as f32 / font.cell_h as f32;
	font.px * sx.min(sy)
}

/// Pixel size for a full-width fallback glyph spanning two grid cells: scaled
/// to the two-cell box so CJK fills the doubled width instead of a single
/// narrow ASCII cell.
fn ttf_wide_pixel_size(font: &TtfFont, grid: &Grid) -> f32 {
	let sx = (2 * grid.cell_w) as f32 / font.cell_w as f32;
	let sy = grid.cell_h as f32 / font.cell_h as f32;
	font.px * sx.min(sy)
}

fn ttf_ascent(font: &TtfFont, px: f32) -> f32 {
	font
		.face
		.horizontal_line_metrics(px)
		.map_or(font.ascent * px / font.px, |metrics| metrics.ascent)
}

fn cached_ttf_glyph<'a>(
	cache: &'a mut HashMap<char, RasterizedGlyph>,
	font: &TtfFont,
	ch: char,
	px: f32,
) -> Option<&'a RasterizedGlyph> {
	if !font.supported.contains(&ch) {
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
/// grid's cell box, row-major with no word wrap. Glyphs keep their natural
/// size with the baseline at the font's ascent from the cell top, so a cell
/// taller than the font pads below the baseline (the "8on16" shapes). Each
/// text line is printed `grid.repeat` times; copies after the first sit on
/// the highlight band. Ink cycles through six hues at sentence boundaries
/// (terminator in `.!?` followed by a space or full block) unless `black_ink`
/// pins it to black; `U+000E`/`U+000F` toggle dim gray ink without occupying a
/// cell, and dim wins over both variants. `U+2588` fills its whole cell with
/// pitch-black ink, ignoring hue and dim state. Characters beyond
/// `cols * rows` are ignored; code points missing from the bitmap font draw
/// through the embedded Silver TrueType fallback when it has a glyph.
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
	let narrow_px = ttf_pixel_size(&FONT_SILVER, grid);
	let wide_px = ttf_wide_pixel_size(&FONT_SILVER, grid);
	let mut fallback_cache = HashMap::new();
	let mut sentence = 0usize;
	let mut dim = false;
	let mut cursor = 0usize;
	for i in 0..codes.len() {
		if cursor >= capacity {
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
		let Some((at, units, next)) = place_cell(cursor, grid.cols, code, true) else {
			continue;
		};
		cursor = next;
		if at >= capacity {
			break;
		}
		let row = at / grid.cols;
		let col = at - row * grid.cols;
		if code == FULL_BLOCK {
			fill_cell(&mut pixels, width, height, grid, col * grid.cell_w, row, INK_BLACK);
			continue;
		}
		if let Some(glyph) = font.glyphs.get(&code) {
			if glyph.rows.is_empty() {
				continue;
			}
			let left = (col * grid.cell_w) as i32 + glyph.xoff;
			for copy in 0..grid.repeat {
				let cell_top = ((row * grid.repeat + copy) * grid.cell_h) as i32;
				let top = cell_top + font.ascent - glyph.h - glyph.yoff;
				blit_glyph(&mut pixels, width, height, glyph, left, top, ink);
			}
		} else if let Some(ch) = char::from_u32(code) {
			let px = if units == 2 { wide_px } else { narrow_px };
			let Some(glyph) = cached_ttf_glyph(&mut fallback_cache, &FONT_SILVER, ch, px) else {
				continue;
			};
			let span = units * grid.cell_w;
			let left = ttf_glyph_origin(col * grid.cell_w, span, &glyph.metrics);
			for copy in 0..grid.repeat {
				let cell_top = (row * grid.repeat + copy) * grid.cell_h;
				let top = ttf_glyph_top(cell_top, font.ascent as f32, &glyph.metrics);
				blit_ttf_glyph_indexed(&mut pixels, width, height, glyph, left, top, ink);
			}
		}
	}
	pixels
}

fn render_ttf_rgb(
	text: &str,
	width: usize,
	height: usize,
	font: &TtfFont,
	grid: &Grid,
	black_ink: bool,
) -> Vec<u8> {
	let mut pixels = vec![255u8; width * height * 3];
	let capacity = grid.cols * grid.rows;
	if capacity == 0 {
		return pixels;
	}
	fill_repeat_bands_rgb(&mut pixels, width, height, grid);
	let px = ttf_pixel_size(font, grid);
	let ascent = ttf_ascent(font, px);
	let codes: Vec<char> = text.chars().collect();
	let mut cache = HashMap::new();
	let mut sentence = 0usize;
	let mut dim = false;
	let mut cell = 0usize;
	for i in 0..codes.len() {
		if cell >= capacity {
			break;
		}
		let ch = codes[i];
		let code = ch as u32;
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
			&& matches!(codes.get(i + 1).map(|next| *next as u32), Some(0x20 | FULL_BLOCK))
		{
			sentence += 1;
		}
		let row = cell / grid.cols;
		let col = cell - row * grid.cols;
		cell += 1;
		if code == FULL_BLOCK {
			fill_cell_rgb(&mut pixels, width, height, grid, col * grid.cell_w, row, INK_BLACK);
			continue;
		}
		let Some(glyph) = cached_ttf_glyph(&mut cache, font, ch, px) else {
			continue;
		};
		let left = ttf_glyph_origin(col * grid.cell_w, grid.cell_w, &glyph.metrics);
		for copy in 0..grid.repeat {
			let cell_top = (row * grid.repeat + copy) * grid.cell_h;
			let top = ttf_glyph_top(cell_top, ascent, &glyph.metrics);
			blit_ttf_glyph(&mut pixels, width, height, glyph, left, top, ink);
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
	let narrow_px = ttf_pixel_size(&FONT_SILVER, grid);
	let wide_px = ttf_wide_pixel_size(&FONT_SILVER, grid);
	let mut fallback_cache = HashMap::new();
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
		let units = cell_units(code, true);
		let mut cell = col;
		if units == 2 && col_w >= 2 && cell == col_w - 1 {
			cell += 1; // pad: never split a wide glyph across the column edge
		}
		col = cell + units;
		if cell + units > col_w {
			continue; // clip past the column width
		}
		let column = line / grid.rows;
		let row = line - column * grid.rows;
		let x_origin = column * (col_w + GUTTER) * grid.cell_w;
		if code == FULL_BLOCK {
			fill_cell(&mut pixels, width, height, grid, x_origin + cell * grid.cell_w, row, INK_BLACK);
			continue;
		}
		if let Some(glyph) = font.glyphs.get(&code) {
			if glyph.rows.is_empty() {
				continue;
			}
			let left = (x_origin + cell * grid.cell_w) as i32 + glyph.xoff;
			for copy in 0..grid.repeat {
				let cell_top = ((row * grid.repeat + copy) * grid.cell_h) as i32;
				let top = cell_top + font.ascent - glyph.h - glyph.yoff;
				blit_glyph(&mut pixels, width, height, glyph, left, top, ink);
			}
		} else if let Some(ch) = char::from_u32(code) {
			let px = if units == 2 { wide_px } else { narrow_px };
			let Some(glyph) = cached_ttf_glyph(&mut fallback_cache, &FONT_SILVER, ch, px) else {
				continue;
			};
			let span = units * grid.cell_w;
			let left = ttf_glyph_origin(x_origin + cell * grid.cell_w, span, &glyph.metrics);
			for copy in 0..grid.repeat {
				let cell_top = (row * grid.repeat + copy) * grid.cell_h;
				let top = ttf_glyph_top(cell_top, font.ascent as f32, &glyph.metrics);
				blit_ttf_glyph_indexed(&mut pixels, width, height, glyph, left, top, ink);
			}
		}
	}
	pixels
}

fn render_ttf_doc_rgb(
	text: &str,
	width: usize,
	height: usize,
	font: &TtfFont,
	grid: &Grid,
	black_ink: bool,
) -> Vec<u8> {
	let mut pixels = vec![255u8; width * height * 3];
	let col_w = grid.cols.saturating_sub(GUTTER) / 2;
	if col_w == 0 || grid.rows == 0 {
		return pixels;
	}
	fill_repeat_bands_rgb(&mut pixels, width, height, grid);
	let px = ttf_pixel_size(font, grid);
	let ascent = ttf_ascent(font, px);
	let codes: Vec<char> = text.chars().collect();
	let mut cache = HashMap::new();
	let mut sentence = 0usize;
	let mut dim = false;
	let mut line = 0usize;
	let mut col = 0usize;
	for i in 0..codes.len() {
		let ch = codes[i];
		let code = ch as u32;
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
					break;
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
			&& matches!(codes.get(i + 1).map(|next| *next as u32), Some(0x20 | 0x0a | FULL_BLOCK))
		{
			sentence += 1;
		}
		let cell = col;
		col += 1;
		if cell >= col_w {
			continue;
		}
		let column = line / grid.rows;
		let row = line - column * grid.rows;
		let x_origin = (column * (col_w + GUTTER) + cell) * grid.cell_w;
		if code == FULL_BLOCK {
			fill_cell_rgb(&mut pixels, width, height, grid, x_origin, row, INK_BLACK);
			continue;
		}
		let Some(glyph) = cached_ttf_glyph(&mut cache, font, ch, px) else {
			continue;
		};
		let left = ttf_glyph_origin(x_origin, grid.cell_w, &glyph.metrics);
		for copy in 0..grid.repeat {
			let cell_top = (row * grid.repeat + copy) * grid.cell_h;
			let top = ttf_glyph_top(cell_top, ascent, &glyph.metrics);
			blit_ttf_glyph(&mut pixels, width, height, glyph, left, top, ink);
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
	let mut writer = encoder.write_header()?;
	writer.write_image_data(&pack_bits(pixels, width, height, bits, &remap))?;
	writer.finish()?;
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
	let mut writer = encoder.write_header()?;
	writer.write_image_data(pixels)?;
	writer.finish()?;
	Ok(out)
}

// ============================================================================
// Entry point
// ============================================================================

/// Shape options for one snapcompact frame.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct SnapcompactRenderOptions {
	/// Frame width in pixels; also bounds the grid rows
	/// (`floor(size/cellHeight/lineRepeat)`). Output height hugs the rows the
	/// text actually uses instead of padding to a square.
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
pub fn snapcompact_supported_chars(font_name: &str, chars: &str) -> Result<String> {
	let font = resolve_font(font_name)
		.ok_or_else(|| SnapcompactError::UnknownFont { font: font_name.to_owned() })?;
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
/// The bitmap height hugs the rows the text actually occupies
/// (`usedRows * lineRepeat * cellHeight`), so a partially filled frame never
/// pays for blank padding rows. The glyph grid holds `floor(size/cellWidth) *
/// floor(size/cellHeight/lineRepeat)` characters; input beyond that is ignored.
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
pub fn render_snapcompact_png(text: &str, options: &SnapcompactRenderOptions) -> Result<Vec<u8>> {
	let size = options.size;
	if size == 0 || size > MAX_FRAME_SIZE {
		return Err(SnapcompactError::InvalidFrameSize { size, max: MAX_FRAME_SIZE });
	}
	let font_name = options.font.as_deref().unwrap_or("5x8");
	let font = resolve_font(font_name)
		.ok_or_else(|| SnapcompactError::UnknownFont { font: font_name.to_owned() })?;
	let black_ink = match options.variant.as_deref().unwrap_or("sent") {
		"sent" => false,
		"bw" => true,
		other => {
			return Err(SnapcompactError::UnknownVariant { variant: other.to_owned() });
		},
	};
	let natural_w = font.cell_w();
	let natural_h = font.cell_h();
	let target_w = options.cell_width.unwrap_or(natural_w as u32).max(1) as usize;
	let target_h = options.cell_height.unwrap_or(natural_h as u32).max(1) as usize;
	let repeat = options.line_repeat.unwrap_or(1).max(1) as usize;
	let columns = options.columns.unwrap_or(1);
	if !matches!(columns, 1 | 2) {
		return Err(SnapcompactError::InvalidColumns { columns });
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
		return Err(SnapcompactError::EmptyGrid {
			size,
			cell_width: target_w,
			cell_height: target_h,
			repeat,
		});
	}
	// Tight canvas: width stays the frame edge (the reading geometry the
	// caller derives cols from), height hugs the rows the text needs. Bitmap
	// shapes draw wide code points through Silver across two cells, so they
	// count double here; the square-celled Silver shape keeps one cell each.
	let wide_cells = matches!(font, RenderFont::Bitmap(_));
	let used = used_rows(text, &grid, doc, wide_cells);
	let height = used * grid.repeat * grid.cell_h;

	match font {
		RenderFont::Ttf(font) => {
			let pixels = if doc {
				render_ttf_doc_rgb(text, size, height, font, &grid, black_ink)
			} else {
				render_ttf_rgb(text, size, height, font, &grid, black_ink)
			};
			encode_rgb_png(&pixels, size, height, png::Compression::High)
		},
		RenderFont::Bitmap(font) => {
			let stretch =
				options.stretch != Some(false) && (target_w, target_h) != (natural_w, natural_h);
			if !stretch {
				// Indexed path: rasterize straight onto the frame at the requested
				// cell box (the natural cell, or natural glyphs on a padded pitch
				// when `stretch: false`).
				let pixels = if doc {
					render_doc_bitmap(text, size, height, font, &grid, black_ink)
				} else {
					render_bitmap(text, size, height, font, &grid, black_ink)
				};
				return encode_indexed_png(&pixels, size, height, png::Compression::High);
			}

			// Stretch shape: rasterize at the font's natural cell on a tight canvas
			// (layout stays in character cells from the target grid), Lanczos3-
			// resample to the target cell, paste onto the white frame.
			let native = Grid { cell_w: natural_w, cell_h: natural_h, ..grid };
			let src_w = grid.cols * natural_w;
			let src_h = used * grid.repeat * natural_h;
			let dst_w = grid.cols * target_w;
			let dst_h = used * grid.repeat * target_h;
			let indexed = if doc {
				render_doc_bitmap(text, src_w, src_h, font, &native, black_ink)
			} else {
				render_bitmap(text, src_w, src_h, font, &native, black_ink)
			};
			let mut rgb = vec![0f32; src_w * src_h * 3];
			for (dst, &idx) in rgb.as_chunks_mut::<3>().0.iter_mut().zip(&indexed) {
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
			encode_rgb_png(&frame, size, dst_h, png::Compression::High)
		},
	}
}
