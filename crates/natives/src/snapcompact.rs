//! Snapcompact frame rendering.
//!
//! Resolve one installed outline face for the entire transcript, then render
//! pre-normalized text on a fixed grid using only that face. Text
//! normalization, pagination, and provider-specific shapes live in
//! `packages/snapcompact`.

use std::{
	borrow::Cow,
	collections::{HashMap, hash_map::Entry},
	iter::Peekable,
	str::Chars,
	sync::{LazyLock, OnceLock},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use fontdue::{Font, FontSettings, Metrics};
use napi::{JsString, bindgen_prelude::*};
use napi_derive::napi;
use resvg::usvg::fontdb::{FaceInfo, ID, Stretch, Style, Weight};
use ttf_parser::{Face, Tag, cmap};

use crate::{js, svg::system_font_db, task};

/// Upper bound on the frame edge: a hard stop against absurd allocations
/// (`size * size` pixel buffer), far above the 2576px production frame.
const MAX_FRAME_SIZE: u32 = 16384;

/// Ink palette: 0 is the white background, 1-6 are the six dark sentence
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

struct SystemFace {
	id:       ID,
	/// Reject non-covering faces without loading all of their glyph outlines.
	cmap:     OnceLock<Option<Box<[u8]>>>,
	outlines: OnceLock<Option<Font>>,
}

impl SystemFace {
	fn covers(&self, chars: &[char]) -> bool {
		let Some(table) = self
			.cmap
			.get_or_init(|| {
				system_font_db().with_face_data(self.id, |data, index| {
					let face = Face::parse(data, index).ok()?;
					face
						.raw_face()
						.table(Tag::from_bytes(b"cmap"))
						.map(Box::from)
				})?
			})
			.as_deref()
			.and_then(cmap::Table::parse)
		else {
			return false;
		};
		if !chars.iter().all(|&ch| {
			table
				.subtables
				.into_iter()
				.any(|subtable| subtable.is_unicode() && subtable.glyph_index(ch as u32).is_some())
		}) {
			return false;
		}

		self
			.outlines
			.get_or_init(|| {
				system_font_db().with_face_data(self.id, |data, collection_index| {
					Font::from_bytes(data, FontSettings {
						collection_index,
						load_substitutions: false,
						..FontSettings::default()
					})
					.ok()
				})?
			})
			.as_ref()
			.is_some_and(|font| chars.iter().all(|&ch| glyph_metrics(font, ch).is_some()))
	}
}

struct SystemFonts {
	faces:       Vec<SystemFace>,
	latin_order: Vec<usize>,
}

static SYSTEM_FONTS: LazyLock<SystemFonts> = LazyLock::new(|| {
	let mut faces: Vec<_> = system_font_db()
		.faces()
		.filter(|face| !is_last_resort(face))
		.collect();
	faces.sort_by_key(|&face| face_rank(face, true));
	let mut latin_order: Vec<_> = (0..faces.len()).collect();
	latin_order.sort_by_key(|&index| face_rank(faces[index], false));
	SystemFonts {
		faces: faces
			.into_iter()
			.map(|face| SystemFace {
				id:       face.id,
				cmap:     OnceLock::new(),
				outlines: OnceLock::new(),
			})
			.collect(),
		latin_order,
	}
});

fn is_last_resort(face: &FaceInfo) -> bool {
	// LastResort maps entire Unicode blocks to generic placeholder outlines.
	let is_placeholder = |name: &str| {
		let name = name.trim_start_matches('.');
		["LastResort", "Last Resort"].iter().any(|prefix| {
			name
				.get(..prefix.len())
				.is_some_and(|start| start.eq_ignore_ascii_case(prefix))
		})
	};
	is_placeholder(&face.post_script_name)
		|| face.families.iter().any(|(name, _)| is_placeholder(name))
}

fn face_rank(face: &FaceInfo, cjk: bool) -> (usize, bool, u16, bool, &str, &str) {
	let cjk_families = [
		"Arial Unicode",
		"Noto Sans CJK",
		"Noto Sans JP",
		"Noto Sans SC",
		"PingFang",
		"Hiragino Sans",
		"Microsoft YaHei",
		"Yu Gothic",
		"WenQuanYi",
	];
	let latin_families = [
		"Menlo",
		"DejaVu Sans Mono",
		"Liberation Mono",
		"Consolas",
		"Noto Sans Mono",
		"DejaVu Sans",
		"Noto Sans",
		"Arial Unicode",
	];
	let preferred: &[&str] = if cjk { &cjk_families } else { &latin_families };
	let rank = preferred
		.iter()
		.position(|prefix| {
			face
				.families
				.iter()
				.any(|(family, _)| family.starts_with(prefix))
		})
		.unwrap_or(preferred.len() + usize::from(!cjk && !face.monospaced));
	(
		rank,
		face.style != Style::Normal,
		face.weight.0.abs_diff(Weight::NORMAL.0),
		face.stretch != Stretch::Normal,
		face.families.first().map_or("", |(name, _)| name.as_str()),
		&face.post_script_name,
	)
}

fn resolve_font(chars: &str) -> Option<u32> {
	let mut chars: Vec<_> = chars.chars().filter(|&ch| needs_glyph(ch)).collect();
	// Check non-ASCII glyphs first: they rule out most candidate faces faster.
	chars.sort_unstable_by_key(char::is_ascii);
	let cjk = chars.iter().any(|&ch| is_wide(ch as u32));
	let fonts = &*SYSTEM_FONTS;
	(0..fonts.faces.len())
		.map(|index| if cjk { index } else { fonts.latin_order[index] })
		.find(|&index| fonts.faces[index].covers(&chars))
		.and_then(|index| u32::try_from(index).ok())
}

fn needs_glyph(ch: char) -> bool {
	ch as u32 != FULL_BLOCK && !ch.is_whitespace() && !ch.is_control()
}

fn glyph_metrics(font: &Font, ch: char) -> Option<(u16, Metrics)> {
	let index = font.lookup_glyph_index(ch);
	if index == 0 {
		return None;
	}
	let metrics = font.metrics_indexed(index, 1.0);
	// Color- and bitmap-only glyphs may have cmap entries but no outline
	// that our grayscale rasterizer can paint.
	(metrics.bounds.width > 0.0 && metrics.bounds.height > 0.0).then_some((index, metrics))
}

/// Frame grid geometry shared with the TypeScript caller. The cell box
/// (`cell_w` x `cell_h`) is the advance/pitch glyphs are laid out on.
struct Grid {
	cols:   usize,
	rows:   usize,
	repeat: usize,
	/// Cell advance (x) in pixels.
	cell_w: usize,
	/// Cell pitch (y) in pixels.
	cell_h: usize,
}

/// East Asian Wide / Fullwidth code points take two cells by default. The same
/// ranges are mirrored in `packages/snapcompact/src/snapcompact.ts` so the
/// TypeScript capacity/pagination math and this layout never disagree on cell
/// counts.
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
/// `wide_cells` East Asian wide code points take two cells and
/// are padded to the next row/column edge rather than split across it.
///
/// The walk ends at the first `None` (capacity reached, past the second doc
/// column, or end of text); it is not fused.
#[derive(Clone)]
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

// Three nonzero coverage steps preserve antialiasing while fitting a plain
// black-on-white frame into a 2-bit palette. Repeated rows get a separate ramp
// blended onto the highlight instead of onto white.
const COVERAGE_STEPS: u8 = 3;
const RAMP_SIZE: u8 = PALETTE.len() as u8 * COVERAGE_STEPS;
const FRAME_COLORS: usize = 2 + 2 * RAMP_SIZE as usize;

const fn ramp_start(ink: u8, highlighted: bool) -> u8 {
	2 + ink * COVERAGE_STEPS + if highlighted { RAMP_SIZE } else { 0 }
}

const fn frame_palette() -> [[u8; 3]; FRAME_COLORS] {
	let mut colors = [[0; 3]; FRAME_COLORS];
	colors[0] = PALETTE[0];
	colors[1] = PALETTE[BG_REPEAT as usize];
	let mut index = 2;
	while index < colors.len() {
		let ramp = (index - 2) % RAMP_SIZE as usize;
		let ink = PALETTE[ramp / COVERAGE_STEPS as usize];
		let bg = colors[(index - 2) / RAMP_SIZE as usize];
		let alpha = (ramp % COVERAGE_STEPS as usize + 1) as u16;
		let steps = COVERAGE_STEPS as u16;
		let mut channel = 0;
		while channel < 3 {
			colors[index][channel] =
				((bg[channel] as u16 * (steps - alpha) + ink[channel] as u16 * alpha + steps / 2)
					/ steps) as u8;
			channel += 1;
		}
		index += 1;
	}
	colors
}

const FRAME_PALETTE: [[u8; 3]; FRAME_COLORS] = frame_palette();
const SOLID_BLACK: u8 = ramp_start(INK_BLACK, false) + COVERAGE_STEPS - 1;

fn fill_repeat_bands(pixels: &mut [u8], width: usize, grid: &Grid) {
	if grid.repeat <= 1 {
		return;
	}
	let pitch = width * grid.cell_h;
	for rows in pixels.chunks_exact_mut(pitch * grid.repeat) {
		rows[pitch..].fill(1);
	}
}

fn fill_block(pixels: &mut [u8], width: usize, grid: &Grid, col: usize, row: usize) {
	let pitch = width * grid.cell_h * grid.repeat;
	for scanline in pixels[row * pitch..(row + 1) * pitch].chunks_exact_mut(width) {
		scanline[col..col + grid.cell_w].fill(SOLID_BLACK);
	}
}

struct Glyph {
	index:      u16,
	unit:       Metrics,
	rasterized: Option<RasterizedGlyph>,
}

struct RasterizedGlyph {
	metrics:  Metrics,
	bitmap:   Vec<u8>,
	baseline: f32,
}

fn rasterize_glyph(
	font: &Font,
	glyph: &Glyph,
	cell_w: usize,
	cell_h: usize,
	width_per_em: f32,
	line_ascent: f32,
	line_height: f32,
) -> RasterizedGlyph {
	// Use the same scale for a cell class, shrinking only glyphs that would
	// overrun the box. Otherwise narrow letters would grow taller than wide
	// ones.
	let width = width_per_em
		.max(glyph.unit.advance_width)
		.max(glyph.unit.bounds.width);
	let height = line_height.max(glyph.unit.bounds.height);
	let px = (cell_w as f32 / width).min(cell_h as f32 / height);
	let baseline = (cell_h as f32 - line_height * px) * 0.5 + line_ascent * px;
	let (metrics, bitmap) = font.rasterize_indexed(glyph.index, px);
	RasterizedGlyph { metrics, bitmap, baseline }
}

fn missing_glyph(ch: char) -> Error {
	Error::from_reason(format!("Snapcompact font cannot render U+{:04X}", ch as u32))
}

fn blit_ttf_glyph(
	pixels: &mut [u8],
	width: usize,
	glyph: &RasterizedGlyph,
	(left, top): (usize, usize),
	(cell_w, cell_h): (usize, usize),
	ramp: u8,
) {
	let draw_w = glyph
		.metrics
		.width
		.min(cell_w)
		.min(width.saturating_sub(left));
	let draw_h = glyph
		.metrics
		.height
		.min(cell_h)
		.min((pixels.len() / width).saturating_sub(top));
	if draw_w == 0 {
		return;
	}
	for (y, row) in glyph
		.bitmap
		.chunks_exact(glyph.metrics.width)
		.take(draw_h)
		.enumerate()
	{
		let offset = (top + y) * width + left;
		for (&alpha, pixel) in row[..draw_w]
			.iter()
			.zip(&mut pixels[offset..offset + draw_w])
		{
			let step = (u16::from(alpha) + 42) / 85;
			if step != 0 {
				*pixel = ramp + step as u8 - 1;
			}
		}
	}
}

/// Draw quantized outline coverage from the resolved face into palette slots.
fn render_indexed(
	layout: Layout<'_>,
	width: usize,
	height: usize,
	content_height: usize,
	font: &Font,
	mut glyphs: HashMap<char, Glyph>,
) -> Vec<u8> {
	let grid = layout.grid;
	let mut pixels = vec![0; width * height];
	if layout.is_empty() {
		return pixels;
	}
	fill_repeat_bands(&mut pixels[..content_height * width], width, grid);
	let (ascent, line_height) = font
		.horizontal_line_metrics(1.0)
		.map_or((0.8, 1.0), |line| (line.ascent, (line.ascent - line.descent).max(1.0)));
	let narrow_width = font.metrics('M', 1.0).advance_width.max(0.6);
	for cell in layout {
		if cell.ch as u32 == FULL_BLOCK {
			fill_block(&mut pixels, width, grid, cell.x, cell.row);
			continue;
		}
		if !needs_glyph(cell.ch) {
			continue;
		}
		let cell_w = cell.units * grid.cell_w;
		let glyph = glyphs
			.get_mut(&cell.ch)
			.expect("frame glyphs are validated before drawing");
		if glyph.rasterized.is_none() {
			let width = if is_wide(cell.ch as u32) {
				1.0
			} else {
				narrow_width
			};
			glyph.rasterized =
				Some(rasterize_glyph(font, glyph, cell_w, grid.cell_h, width, ascent, line_height));
		}
		let glyph = glyph.rasterized.as_ref().expect("glyph was rasterized");
		let metrics = &glyph.metrics;
		let pad = (cell_w as f32 - metrics.advance_width).max(0.0) * 0.5;
		let x = (pad.floor() as i32 + metrics.xmin)
			.clamp(0, cell_w.saturating_sub(metrics.width) as i32) as usize;
		let top = (glyph.baseline - metrics.height as f32 - metrics.ymin as f32).round() as i32;
		let y = top.clamp(0, grid.cell_h.saturating_sub(metrics.height) as i32) as usize;
		for copy in 0..grid.repeat {
			let cell_top = (cell.row * grid.repeat + copy) * grid.cell_h;
			blit_ttf_glyph(
				&mut pixels,
				width,
				glyph,
				(cell.x + x, cell_top + y),
				(cell_w - x, grid.cell_h - y),
				ramp_start(cell.ink, copy > 0),
			);
		}
	}
	pixels
}

/// Character cells between the two doc columns (eval `exp14` layout).
const GUTTER: usize = 3;

/// Drop unused colors and pack palette indices into the smallest PNG depth.
fn encode_indexed_png(mut pixels: Vec<u8>, width: usize, height: usize) -> Result<Vec<u8>> {
	let mut used = [false; FRAME_COLORS];
	for &index in &pixels {
		used[index as usize] = true;
	}
	let mut remap = [0; FRAME_COLORS];
	let mut palette = Vec::<[u8; 3]>::new();
	for (index, rgb) in FRAME_PALETTE
		.into_iter()
		.enumerate()
		.filter(|(i, _)| used[*i])
	{
		let slot = palette
			.iter()
			.position(|color| color == &rgb)
			.unwrap_or_else(|| {
				palette.push(rgb);
				palette.len() - 1
			});
		remap[index] = slot as u8;
	}
	let (depth, bits) = match palette.len() {
		0..=2 => (png::BitDepth::One, 1),
		3..=4 => (png::BitDepth::Two, 2),
		5..=16 => (png::BitDepth::Four, 4),
		_ => (png::BitDepth::Eight, 8),
	};
	if bits == 8 {
		for px in &mut pixels {
			*px = remap[*px as usize];
		}
	} else {
		let group = 8 / bits;
		let row_bytes = width.div_ceil(group);
		for y in 0..height {
			let row = y * width;
			for (x, start) in (0..width).step_by(group).enumerate() {
				let mut packed = 0;
				for (i, &px) in pixels[row + start..row + (start + group).min(width)]
					.iter()
					.enumerate()
				{
					packed |= remap[px as usize] << (8 - (i + 1) * bits);
				}
				pixels[y * row_bytes + x] = packed;
			}
		}
		pixels.truncate(height * row_bytes);
	}
	let mut out = Vec::new();
	let mut encoder = png::Encoder::new(&mut out, width as u32, height as u32);
	encoder.set_color(png::ColorType::Indexed);
	encoder.set_depth(depth);
	encoder.set_palette(Cow::Borrowed(palette.as_flattened()));
	encoder.set_compression(png::Compression::High);
	encoder.set_filter(png::Filter::NoFilter);
	let mut writer = encoder
		.write_header()
		.map_err(|err| Error::from_reason(format!("Failed to write PNG header: {err}")))?;
	writer
		.write_image_data(&pixels)
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
pub struct SnapcompactRenderOptions {
	/// Frame width in pixels; also bounds grid rows before the 64px height
	/// floor.
	pub size:        u32,
	/// Process-local face returned by `resolveSnapcompactFont`.
	pub font_id:     u32,
	/// Fixed cell advance and pitch in pixels.
	pub cell_width:  u32,
	pub cell_height: u32,
	/// Use two cells for East Asian wide glyphs (default true).
	pub wide_cells:  Option<bool>,
	/// Ink variant: `"sent"` (default, six-hue sentence cycling) or `"bw"`
	/// (black).
	pub variant:     Option<String>,
	/// Copies of each line; copies after the first have a highlight band
	/// (default 1).
	pub line_repeat: Option<u32>,
	/// `1` (default) row-major grid, `2` two columns of pre-wrapped lines.
	pub columns:     Option<u32>,
}

/// Select one installed face covering every supplied printable character. The
/// caller supplies distinct scalars, without synthetic markers or controls.
#[napi(ts_return_type = "number | null")]
pub fn resolve_snapcompact_font(chars: JsString) -> Result<Option<u32>> {
	Ok(resolve_font(&js::utf8(chars)?))
}

/// Render pre-normalized text on a worker and return its indexed PNG as base64.
/// Height hugs used rows with a 64px floor. Overlong input clips to the grid.
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
	let black_ink = match options.variant.as_deref().unwrap_or("sent") {
		"sent" => false,
		"bw" => true,
		other => {
			return Err(Error::from_reason(format!(
				"Unknown snapcompact variant {other:?}: expected \"sent\" or \"bw\""
			)));
		},
	};
	let target_w = options.cell_width.max(1) as usize;
	let target_h = options.cell_height.max(1) as usize;
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
	let font = SYSTEM_FONTS
		.faces
		.get(options.font_id as usize)
		.and_then(|face| face.outlines.get()?.as_ref())
		.ok_or_else(|| {
			Error::from_reason(format!("Unknown snapcompact font ID {}", options.font_id))
		})?;
	let mut glyphs = HashMap::new();
	for ch in text.chars().filter(|&ch| needs_glyph(ch)) {
		if let Entry::Vacant(entry) = glyphs.entry(ch) {
			let (index, unit) = glyph_metrics(font, ch).ok_or_else(|| missing_glyph(ch))?;
			entry.insert(Glyph { index, unit, rasterized: None });
		}
	}

	// Preserve the short-frame floor for vision processors that reject them.
	let wide_cells = options.wide_cells.unwrap_or(true);
	let layout = Layout::new(&text, &grid, doc, wide_cells, black_ink);
	let content_height = layout.clone().used_rows() * grid.repeat * grid.cell_h;
	let height = content_height.max(64);
	let pixels = render_indexed(layout, size, height, content_height, font, glyphs);
	Ok(STANDARD
		.encode(encode_indexed_png(pixels, size, height)?)
		.into())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn options(size: u32, font_id: u32) -> SnapcompactRenderOptions {
		SnapcompactRenderOptions {
			size,
			font_id,
			cell_width: 8,
			cell_height: 16,
			wide_cells: None,
			variant: Some("bw".into()),
			line_repeat: None,
			columns: None,
		}
	}

	fn render(text: &str, options: SnapcompactRenderOptions) -> image::RgbImage {
		let encoded = render_snapcompact_png_sync(text.into(), options).expect("render frame");
		let png = STANDARD.decode(&*encoded).expect("base64 PNG");
		image::load_from_memory(&png)
			.expect("decode PNG")
			.into_rgb8()
	}

	#[test]
	fn wide_cells_wrap_and_single_cells_stay_on_the_row() {
		let grid = Grid { cols: 3, rows: 2, repeat: 1, cell_w: 8, cell_h: 16 };
		let positions = |wide_cells| {
			Layout::new("ab漢c", &grid, false, wide_cells, true)
				.map(|cell| (cell.ch, cell.x, cell.row, cell.units))
				.collect::<Vec<_>>()
		};
		assert_eq!(positions(true), [
			('a', 0, 0, 1),
			('b', 8, 0, 1),
			('漢', 0, 1, 2),
			('c', 16, 1, 1)
		]);
		assert_eq!(positions(false), [
			('a', 0, 0, 1),
			('b', 8, 0, 1),
			('漢', 16, 0, 1),
			('c', 0, 1, 1)
		]);
	}

	#[test]
	fn doc_layout_clips_columns_and_keeps_ink_markers_zero_width() {
		let grid = Grid { cols: 11, rows: 2, repeat: 1, cell_w: 8, cell_h: 16 };
		let layout = Layout::new("a.\n\u{e}b\u{f}█漢\nc", &grid, true, true, false);
		let cells: Vec<_> = layout
			.map(|cell| (cell.ch, cell.x, cell.row, cell.ink))
			.collect();
		assert_eq!(cells, [
			('a', 0, 0, 1),
			('.', 8, 0, 1),
			('b', 0, 1, INK_DIM),
			('█', 8, 1, 2),
			('漢', 16, 1, 2),
			('c', 56, 0, 2),
		]);
		let clipped: Vec<_> = Layout::new("abc漢\nz", &grid, true, true, true)
			.map(|cell| cell.ch)
			.collect();
		assert_eq!(clipped, ['a', 'b', 'c', 'z']);
	}

	#[test]
	fn no_face_for_a_noncharacter_and_unknown_handles_are_rejected() {
		assert!(resolve_font("A\u{10ffff}").is_none());
		let error = render_snapcompact_png_sync("A".into(), options(64, u32::MAX)).unwrap_err();
		assert!(error.reason.contains("Unknown snapcompact font ID"));
	}

	#[test]
	fn system_face_renders_ink_and_rejects_unsupported_input() {
		// Minimal installations may have no fonts at all.
		let Some(id) = resolve_font("Ab") else { return };
		// Reject unsupported characters even after the grid's clipping boundary.
		let too_long = "Ab".repeat(64) + "\u{10ffff}";
		let error = render_snapcompact_png_sync(too_long, options(64, id)).unwrap_err();
		assert!(error.reason.contains("U+10FFFF"));
		let png = render("█\u{e}A\u{f}b", SnapcompactRenderOptions {
			line_repeat: Some(2),
			..options(128, id)
		});
		assert_eq!(png.dimensions(), (128, 64));
		assert_eq!(png.get_pixel(7, 15).0, PALETTE[INK_BLACK as usize]);
		assert_eq!(png.get_pixel(7, 31).0, PALETTE[INK_BLACK as usize]);
		assert_eq!(png.get_pixel(24, 31).0, PALETTE[BG_REPEAT as usize]);
		assert_eq!(png.get_pixel(24, 32).0, PALETTE[0]);
		assert!((0..16).any(|y| (8..16).any(|x| png.get_pixel(x, y).0 != PALETTE[0])));
		assert!((0..16).any(|y| (16..24).any(|x| png.get_pixel(x, y).0 != PALETTE[0])));
	}

	#[test]
	fn frame_height_hugs_rows_and_columns_must_be_valid() {
		let Some(id) = resolve_font("A") else { return };
		let text = "A".repeat(16 * 5);
		let png = render(&text, options(128, id));
		assert_eq!(png.dimensions(), (128, 80));
		let err = render_snapcompact_png_sync("A".into(), SnapcompactRenderOptions {
			columns: Some(3),
			..options(128, id)
		})
		.unwrap_err();
		assert!(err.reason.contains("columns"));
	}
}
