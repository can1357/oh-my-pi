use std::{io, str};

use bytes::Bytes;
use omp_core::IntoStr;

use crate::{
	Frame, Icon,
	component::{Component, PaintCtx, Slot, next_slot},
	context::{Graphics, UiContext},
	frame::{Color, Rect, Style},
	imagefmt::{self, ImageDimensions},
	imagereg,
	kitty::PLACEHOLDER_LIMIT,
	markup::{Border, Dim},
	props::{Prop, PropValue, Props},
};

type Rgb = [u8; 3];
type CellColors = (Option<Rgb>, Option<Rgb>);

#[derive(Clone, Copy, Default)]
enum AutoBox {
	#[default]
	Unresolved,
	/// Interned box resolved for the given column budget.
	Resolved { budget: u16, cell_box: (u32, u16, u16) },
}

/// Row budget for a decoded image (`h` and `max-rows` props).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RowBound {
	/// Rows follow the source aspect ratio at the requested width.
	Aspect,
	/// Exactly this many rows, stretching the source.
	Fixed(u16),
	/// Aspect-derived rows capped here; columns shrink to keep the aspect.
	Max(u16),
}

impl RowBound {
	const fn from_props(props: &Props) -> Self {
		match (props.h(), props.max_rows()) {
			(Some(rows), _) => Self::Fixed(rows),
			(None, Some(cap)) => Self::Max(cap),
			(None, None) => Self::Aspect,
		}
	}

	/// Cell box for a `px`-sized source at `width_cells` columns.
	fn fit(self, px: ImageDimensions, width_cells: u16) -> (u16, u16) {
		let width_cells = width_cells.max(1);
		match self {
			Self::Fixed(rows) => (width_cells, rows.max(1)),
			Self::Aspect => {
				let scaled = u64::from(width_cells) * u64::from(px.height);
				let denominator = u64::from(px.width.max(1)) * 2;
				let rows = ((scaled + denominator / 2) / denominator)
					.max(1)
					.min(u64::from(u16::MAX)) as u16;
				(width_cells, rows)
			},
			Self::Max(cap) => image_cell_box(px, width_cells, cap),
		}
	}
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Load {
	#[default]
	Unloaded,
	Loading,
	Ready,
	Boxed,
}

#[derive(Default)]
pub struct ImgState {
	/// Half-block colors per cell; `None` halves are transparent and leave
	/// the underlying background visible.
	cells: Box<[CellColors]>,
	width: u16,
	rows:  u16,
	phase: Load,
}

impl ImgState {
	fn row(&self, index: u16) -> &[CellColors] {
		let stride = usize::from(self.width);
		let start = usize::from(index) * stride;
		&self.cells[start..start + stride]
	}
}

/// A terminal-rendered image backing the `<img>` markup tag.
///
/// On the Kitty-placeholder graphics tier an image `src` renders as real pixels
/// after PNG sources are interned directly and JPEG/WebP sources convert to a
/// process-cached PNG off-thread. The renderer uploads that PNG on first
/// reference and places it in the cell box derived from `w`/`h`
/// (aspect-derived when `h` is omitted). On every other tier, supported image
/// sources decode to colored half-block cells. The `trim` flag
/// crops fully transparent margins before half-block sampling (terminal
/// compositors always show the full source), so padded logo sources stay
/// visible even as tiny thumbnails.
pub struct Img {
	props:       Props,
	slot:        Slot,
	state:       ImgState,
	bytes:       Option<Bytes>,
	dims:        Option<ImageDimensions>,
	kitty:       Option<(u32, u16, u16)>,
	/// Cached `src`-interned placeholder box, resolved once per column budget.
	auto:        AutoBox,
	/// Column budget the current `state` was decoded for; a `max-rows` cap
	/// can leave the sampled width narrower than the budget.
	decoded_for: u16,
	top:         String,
	bottom:      String,
}

impl Img {
	/// Creates an image with no source.
	pub fn new() -> Self {
		Self {
			props:       Props::new(),
			slot:        next_slot(),
			state:       ImgState::default(),
			bytes:       None,
			dims:        None,
			kitty:       None,
			auto:        AutoBox::Unresolved,
			decoded_for: 0,
			top:         String::new(),
			bottom:      String::new(),
		}
	}

	/// Creates an image backed by immutable in-memory encoded bytes.
	///
	/// Dimensions are probed immediately with [`imagefmt`] while pixel
	/// decoding remains lazy until layout needs the image.
	pub fn from_bytes(bytes: Bytes) -> Self {
		let dims = imagefmt::dimensions(&bytes);
		Self { bytes: Some(bytes), dims, ..Self::new() }
	}

	/// Replaces the source with immutable in-memory encoded bytes.
	pub fn with_bytes(mut self, bytes: Bytes) -> Self {
		self.dims = imagefmt::dimensions(&bytes);
		self.bytes = Some(bytes);
		self.state = ImgState::default();
		self.kitty = None;
		self.auto = AutoBox::Unresolved;
		self
	}

	/// Returns dimensions detected from an in-memory source.
	pub const fn dimensions(&self) -> Option<ImageDimensions> {
		self.dims
	}

	/// Sets one image property.
	pub fn with(mut self, prop: Prop, value: impl Into<PropValue>) -> Self {
		if self.bytes.is_some() && matches!(prop, Prop::W | Prop::H | Prop::MaxRows | Prop::Trim) {
			self.state = ImgState::default();
		}
		self.props.set(prop, value);
		self
	}

	/// Sets one image property from a string.
	pub fn with_str(mut self, prop: Prop, value: &str) -> Self {
		self.props.set(prop, value);
		self
	}

	/// Uses a renderer-registered image ID in a fixed cell box on every
	/// pixel-capable graphics tier, overriding the `src` placeholder path.
	///
	/// Pair with [`crate::Renderer::register_image`]. Rebuild the component
	/// with new dimensions after a resize. Dimensions beyond Kitty's
	/// 297-entry coordinate table leave the component on its cell fallback.
	pub const fn kitty(mut self, id: u32, rows: u16, cols: u16) -> Self {
		if rows > 0 && cols > 0 && rows <= PLACEHOLDER_LIMIT && cols <= PLACEHOLDER_LIMIT {
			self.kitty = Some((id, rows, cols));
		}
		self
	}

	/// The typed-cell box for this context: the explicit [`Img::kitty`] box
	/// on any pixel tier, else a `src`-interned placeholder box on the
	/// Kitty-placeholder tier, its columns clamped to `available` when the
	/// layout pass knows it. `None` selects the half-block/box fallback.
	fn cell_box(&mut self, ctx: &UiContext, available: Option<u16>) -> Option<(u32, u16, u16)> {
		if ctx.graphics == Graphics::Cells || self.bytes.is_some() {
			return None;
		}
		if self.kitty.is_some() {
			return self.kitty;
		}
		if ctx.graphics != Graphics::KittyPlaceholders {
			return None;
		}
		let budget = available.unwrap_or(u16::MAX).max(1);
		match self.auto {
			AutoBox::Resolved { budget: cached, cell_box } if cached == budget => Some(cell_box),
			_ => {
				let cell_box = resolve_placeholder_box(&self.props, budget)?;
				self.auto = AutoBox::Resolved { budget, cell_box };
				Some(cell_box)
			},
		}
	}

	fn requested_width(&self, available: u16) -> u16 {
		match self.props.w() {
			Some(Dim::Cells(cells)) => cells,
			Some(Dim::Pct(percent)) => (u32::from(available) * u32::from(percent) / 100).max(1) as u16,
			None => {
				if self.bytes.is_some() {
					available.max(1)
				} else {
					24
				}
			},
		}
		.min(available.max(1))
	}

	fn ensure_decoded(&mut self, ctx: &UiContext, available: u16) {
		let source = self
			.props
			.str_of(Prop::Src)
			.map_or("", |value| value.as_str());
		let width = self.requested_width(available);
		if self.state.phase != Load::Unloaded {
			if self.bytes.is_none() || self.decoded_for == width {
				return;
			}
			self.state = ImgState::default();
		}
		self.decoded_for = width;
		let trim = self.props.flag(Prop::Trim);
		let rows = RowBound::from_props(&self.props);
		if let Some(bytes) = &self.bytes {
			self.state = decode_bytes(bytes, width, rows, trim);
			return;
		}
		if let Some(loader) = &ctx.loader {
			loader.request(
				self.slot,
				source.to_str(),
				width,
				rows,
				trim,
				ctx.graphics == Graphics::KittyPlaceholders,
			);
			self.state.phase = Load::Loading;
			self.state.width = width;
			self.state.rows = 3;
		} else {
			if ctx.graphics == Graphics::KittyPlaceholders {
				let _ = imagereg::prepare_png(source);
			}
			self.state = decode_source(source, width, rows, trim);
		}
	}

	/// Installs an off-thread decode result; ignores stale deliveries after
	/// the state already settled.
	pub(crate) fn apply_decoded(&mut self, state: ImgState) {
		if self.state.phase == Load::Loading {
			self.state = state;
		}
	}
}

/// Resolves an interned placeholder box from `src`, `w`, `h`, and
/// `max-rows` props: PNG-backed, fixed-cell widths only (clamped to the
/// `budget` columns the layout offers), aspect-derived rows when `h` is
/// omitted, bounded by Kitty's diacritic table.
fn resolve_placeholder_box(props: &Props, budget: u16) -> Option<(u32, u16, u16)> {
	let source = props.str_of(Prop::Src)?;
	let interned = imagereg::intern(source.as_str())?;
	let cols = match props.w() {
		Some(Dim::Cells(cells)) => cells,
		Some(Dim::Pct(_)) => return None,
		None => 24,
	}
	.min(budget);
	let (cols, rows) = RowBound::from_props(props).fit(interned.dimensions, cols);
	let rows = rows.min(PLACEHOLDER_LIMIT);
	(rows > 0 && cols > 0 && cols <= PLACEHOLDER_LIMIT).then_some((interned.id, rows, cols))
}

impl Default for Img {
	fn default() -> Self {
		Self::new()
	}
}

impl Component for Img {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, ctx: &UiContext) -> (u16, u16) {
		if let Some((_, rows, cols)) = self.cell_box(ctx, None) {
			return (cols, rows);
		}
		let width = match self.props.w() {
			Some(Dim::Cells(width)) => width,
			_ => 24,
		};
		(width, width)
	}

	fn height(&mut self, ctx: &UiContext, width: u16) -> u16 {
		if let Some((_, rows, _)) = self.cell_box(ctx, Some(width)) {
			return rows;
		}
		self.ensure_decoded(ctx, width);
		self.state.rows
	}

	fn place(&mut self, ctx: &UiContext, content: Rect) {
		if self.cell_box(ctx, Some(content.width)).is_none() {
			self.ensure_decoded(ctx, content.width);
		}
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if let Some((id, rows, cols)) = self.cell_box(pc.ctx, Some(rect.width)) {
			for row in 0..rows.min(rect.height) {
				let y = rect.y + row;
				if y >= pc.clip {
					break;
				}
				for col in 0..cols.min(rect.width) {
					pc.frame
						.put_image_cell(rect.x + col, y, id, row, col, rows, cols);
				}
			}
			return;
		}
		self.ensure_decoded(pc.ctx, rect.width);
		if self.state.phase != Load::Ready {
			let source = self
				.props
				.str_of(Prop::Src)
				.map_or("", |value| value.as_str());
			let name = source
				.rsplit('/')
				.next()
				.filter(|name| !name.is_empty())
				.unwrap_or("image");
			let width = self.state.width.min(rect.width);
			let rows = self.state.rows.min(rect.height);
			if width == 0 || rows == 0 {
				return;
			}
			let (tl, tr, bl, br, horizontal, _) = pc.ctx.charset.border(Border::Square);
			self.top.clear();
			self.bottom.clear();
			self.top.reserve(usize::from(width));
			self.bottom.reserve(usize::from(width));
			self.top.push(tl);
			self.bottom.push(bl);
			for _ in 0..width.saturating_sub(2) {
				self.top.push(horizontal);
				self.bottom.push(horizontal);
			}
			if width > 1 {
				self.top.push(tr);
				self.bottom.push(br);
			}
			let style = Style::new().fg(pc.ctx.theme.muted);
			for row in 0..rows {
				let y = rect.y + row;
				if y >= pc.clip {
					break;
				}
				if row == 0 {
					pc.frame.put(rect.x, y, &self.top, style);
				} else if row + 1 == rows {
					pc.frame.put(rect.x, y, &self.bottom, style);
				} else {
					let rail = pc.ctx.charset.icon(Icon::PlaceholderRail);
					pc.frame.put(rect.x, y, rail, style);
					if row == rows / 2 && width > 4 {
						let mut x = pc.frame.put(rect.x + 2, y, "[img: ", style);
						x = pc.frame.put(x, y, name, style);
						pc.frame.put(x, y, "]", style);
					}
					if width > 1 {
						pc.frame.put(rect.x + width - 1, y, rail, style);
					}
				}
			}
			return;
		}
		for row_index in 0..self.state.rows {
			let y = rect.y + row_index;
			if y >= pc.clip {
				break;
			}
			let mut x = rect.x;
			for &(upper, lower) in self.state.row(row_index) {
				x = match half_block_cell(upper, lower) {
					Some((icon, style)) => pc.frame.put(x, y, pc.ctx.charset.icon(icon), style),
					None => x.saturating_add(1),
				};
			}
		}
	}
}

/// Half-block glyph and colors for one sampled cell. Transparent halves
/// stay unpainted so the terminal or container background shows through.
const fn half_block_cell(upper: Option<Rgb>, lower: Option<Rgb>) -> Option<(Icon, Style)> {
	match (upper, lower) {
		(Some(upper), Some(lower)) => Some((
			Icon::UpperHalf,
			Style::new()
				.fg(Color::Rgb(upper[0], upper[1], upper[2]))
				.bg(Color::Rgb(lower[0], lower[1], lower[2])),
		)),
		(Some(upper), None) => {
			Some((Icon::UpperHalf, Style::new().fg(Color::Rgb(upper[0], upper[1], upper[2]))))
		},
		(None, Some(lower)) => {
			Some((Icon::LowerHalf, Style::new().fg(Color::Rgb(lower[0], lower[1], lower[2]))))
		},
		(None, None) => None,
	}
}

/// Aspect-preserving cell box for an image of `px` pixel dimensions within
/// column and row caps. Half-block cells and Kitty placements both cover
/// two pixel rows per terminal row.
pub fn image_cell_box(px: ImageDimensions, max_width: u16, max_rows: u16) -> (u16, u16) {
	let width = u64::from(px.width.max(1));
	let height = u64::from(px.height.max(1));
	let max_cols = u64::from(max_width.max(1));
	let max_rows = u64::from(max_rows.max(1));
	let rows = ((max_cols * height + width) / (width * 2)).max(1);
	if rows <= max_rows {
		return (max_cols as u16, rows as u16);
	}
	let cols = ((max_rows * 2 * width + height / 2) / height).clamp(1, max_cols);
	(cols as u16, max_rows as u16)
}

/// Draws an image source inline at `(x, y)`, bounded by `max_width` columns
/// and `max_rows` rows while preserving aspect ratio.
///
/// Applies the same tier selection as [`Img`]: typed Kitty placeholder
/// cells when the terminal trusts Unicode placeholders (real pixels that
/// survive native scrollback), colored half-block cells everywhere else.
/// Returns the number of rows drawn; `0` when the source cannot be decoded,
/// so callers keep their text fallback. Cells beyond the frame clip safely.
pub fn draw_image_inline(
	frame: &mut Frame,
	ctx: &UiContext,
	x: u16,
	y: u16,
	source: &str,
	max_width: u16,
	max_rows: u16,
) -> u16 {
	if max_width == 0 || max_rows == 0 {
		return 0;
	}
	if ctx.graphics == Graphics::KittyPlaceholders {
		let Some(interned) = imagereg::intern(source) else {
			return 0;
		};
		let (cols, rows) = image_cell_box(
			interned.dimensions,
			max_width.min(PLACEHOLDER_LIMIT),
			max_rows.min(PLACEHOLDER_LIMIT),
		);
		for row in 0..rows {
			for col in 0..cols {
				frame.put_image_cell(
					x.saturating_add(col),
					y.saturating_add(row),
					interned.id,
					row,
					col,
					rows,
					cols,
				);
			}
		}
		return rows;
	}
	let Some(DecodedImage::Pixels(pixels)) = decode_image(source) else {
		return 0;
	};
	if pixels.is_empty() || pixels.first().is_none_or(|row| row.is_empty()) {
		return 0;
	}
	let px = ImageDimensions { width: pixels[0].len() as u32, height: pixels.len() as u32 };
	let (cols, rows) = image_cell_box(px, max_width, max_rows);
	let state = sample_cells(&pixels, cols, RowBound::Fixed(rows), PAINT_GATE);
	for row_index in 0..state.rows {
		let row_y = y.saturating_add(row_index);
		let mut cell_x = x;
		for &(upper, lower) in state.row(row_index) {
			cell_x = match half_block_cell(upper, lower) {
				Some((icon, style)) => frame.put(cell_x, row_y, ctx.charset.icon(icon), style),
				None => cell_x.saturating_add(1),
			};
		}
	}
	state.rows
}

enum DecodedImage {
	Pixels(Vec<Vec<[u8; 4]>>),
	Placeholder(ImageDimensions),
}
/// Reads, decodes, and cell-samples `source` at `width_cells`. Never
/// panics; a settled no-pixel outcome (failure or probe-only format)
/// returns a [`Load::Boxed`] state.
pub fn decode_source(source: &str, width_cells: u16, rows: RowBound, trim: bool) -> ImgState {
	let Some(bytes) = imagereg::source_bytes(source) else {
		return ImgState {
			cells: Box::default(),
			width: width_cells.max(1),
			rows:  3,
			phase: Load::Boxed,
		};
	};
	decode_bytes(&bytes, width_cells, rows, trim)
}

/// Decodes and cell-samples immutable in-memory image bytes.
///
/// Invalid or dimension-only formats settle to a boxed placeholder rather
/// than panicking.
pub fn decode_bytes(bytes: &[u8], width_cells: u16, rows: RowBound, trim: bool) -> ImgState {
	match decode_image_bytes(bytes) {
		Some(DecodedImage::Pixels(mut pixels))
			if !pixels.is_empty() && pixels.first().is_some_and(|row| !row.is_empty()) =>
		{
			if trim {
				pixels = trim_transparent(pixels);
			}
			let gate = if trim { TRIMMED_PAINT_GATE } else { PAINT_GATE };
			sample_cells(&pixels, width_cells, rows, gate)
		},
		Some(DecodedImage::Placeholder(dimensions)) => {
			placeholder_state(dimensions, width_cells, rows)
		},
		_ => {
			ImgState { cells: Box::default(), width: width_cells.max(1), rows: 3, phase: Load::Boxed }
		},
	}
}

/// Crops rows and columns whose pixels are all (nearly) transparent, so a
/// padded logo fills its cell box instead of averaging away. A fully
/// transparent image is returned unchanged.
fn trim_transparent(pixels: Vec<Vec<[u8; 4]>>) -> Vec<Vec<[u8; 4]>> {
	const VISIBLE: u8 = 8;
	let mut top = None;
	let mut bottom = 0_usize;
	let mut left = usize::MAX;
	let mut right = 0_usize;
	for (y, row) in pixels.iter().enumerate() {
		for (x, pixel) in row.iter().enumerate() {
			if pixel[3] >= VISIBLE {
				top.get_or_insert(y);
				bottom = y;
				left = left.min(x);
				right = right.max(x);
			}
		}
	}
	let Some(top) = top else {
		return pixels;
	};
	pixels[top..=bottom]
		.iter()
		.map(|row| row[left.min(row.len() - 1)..=right.min(row.len() - 1)].to_vec())
		.collect()
}

fn decode_image(source: &str) -> Option<DecodedImage> {
	let bytes = imagereg::source_bytes(source)?;
	decode_image_bytes(&bytes)
}

fn decode_image_bytes(bytes: &[u8]) -> Option<DecodedImage> {
	if bytes.starts_with(b"P6") {
		return decode_ppm(bytes).map(DecodedImage::Pixels);
	}
	let dimensions = imagefmt::dimensions(bytes)?;
	if !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
		if let Ok(image) = image::load_from_memory(bytes) {
			let pixels = image.into_rgba8();
			let width = usize::try_from(pixels.width()).ok()?;
			let rows = pixels
				.into_raw()
				.chunks_exact(width.saturating_mul(4))
				.map(|row| {
					row.as_chunks::<4>()
						.0
						.iter()
						.map(|pixel| [pixel[0], pixel[1], pixel[2], pixel[3]])
						.collect()
				})
				.collect();
			return Some(DecodedImage::Pixels(rows));
		}
		return Some(DecodedImage::Placeholder(dimensions));
	}
	decode_png(bytes)
		.map(DecodedImage::Pixels)
		.or(Some(DecodedImage::Placeholder(dimensions)))
}

fn decode_png(bytes: &[u8]) -> Option<Vec<Vec<[u8; 4]>>> {
	let mut decoder = png::Decoder::new(io::Cursor::new(bytes));
	// Official logos frequently ship indexed palettes (with tRNS alpha) or
	// 16-bit channels; normalize so `samples()` below always describes
	// plain 8-bit gray/RGB(A) output instead of palette indices.
	decoder.set_transformations(png::Transformations::EXPAND | png::Transformations::STRIP_16);
	let mut reader = decoder.read_info().ok()?;
	let mut buffer = vec![0_u8; reader.output_buffer_size()?];
	let info = reader.next_frame(&mut buffer).ok()?;
	let (width, height) = (info.width as usize, info.height as usize);
	let stride = info.color_type.samples();
	let mut rows = Vec::with_capacity(height);
	for y in 0..height {
		let mut row = Vec::with_capacity(width);
		for x in 0..width {
			let at = y * width * stride + x * stride;
			row.push(match stride {
				1 => [buffer[at], buffer[at], buffer[at], 255],
				2 => [buffer[at], buffer[at], buffer[at], buffer[at + 1]],
				3 => [buffer[at], buffer[at + 1], buffer[at + 2], 255],
				_ => [buffer[at], buffer[at + 1], buffer[at + 2], buffer[at + 3]],
			});
		}
		rows.push(row);
	}
	Some(rows)
}

fn decode_ppm(bytes: &[u8]) -> Option<Vec<Vec<[u8; 4]>>> {
	let mut fields = Vec::new();
	let mut at = 2_usize;
	while fields.len() < 3 && at < bytes.len() {
		while at < bytes.len() && bytes[at].is_ascii_whitespace() {
			at += 1;
		}
		if bytes.get(at) == Some(&b'#') {
			while at < bytes.len() && bytes[at] != b'\n' {
				at += 1;
			}
			continue;
		}
		let start = at;
		while at < bytes.len() && bytes[at].is_ascii_digit() {
			at += 1;
		}
		fields.push(
			str::from_utf8(&bytes[start..at])
				.ok()?
				.parse::<usize>()
				.ok()?,
		);
	}
	at += 1;
	let (&width, &height) = (fields.first()?, fields.get(1)?);
	let data = bytes.get(at..at + width * height * 3)?;
	Some(
		data
			.chunks_exact(width * 3)
			.map(|row| {
				row.as_chunks::<3>()
					.0
					.iter()
					.map(|pixel| [pixel[0], pixel[1], pixel[2], 255])
					.collect()
			})
			.collect(),
	)
}

fn placeholder_state(dimensions: ImageDimensions, width_cells: u16, bound: RowBound) -> ImgState {
	let (width, rows) = bound.fit(dimensions, width_cells);
	ImgState { cells: Box::default(), width, rows, phase: Load::Boxed }
}

/// Paint gate for untrimmed sources: a half-cell must be at least half
/// covered, so transparent logo padding never paints.
const PAINT_GATE: u64 = 128;
/// Paint gate for trimmed thumbnails: the crop already removed padding, so
/// any half-cell with meaningful coverage (≥ 12.5%) keeps its glyph color.
const TRIMMED_PAINT_GATE: u64 = 32;

fn sample_cells(pixels: &[Vec<[u8; 4]>], width_cells: u16, bound: RowBound, gate: u64) -> ImgState {
	let source_height = pixels.len();
	let source_width = pixels[0].len();
	let px = ImageDimensions {
		width:  u32::try_from(source_width).unwrap_or(u32::MAX),
		height: u32::try_from(source_height).unwrap_or(u32::MAX),
	};
	let (cols, rows) = bound.fit(px, width_cells);
	let width = usize::from(cols);
	let height = usize::from(rows);
	let mut cells = Vec::with_capacity(width * height);
	for cell_y in 0..height {
		let upper_y0 = cell_y * 2 * source_height / (height * 2);
		let upper_y1 = ((cell_y * 2 + 1) * source_height / (height * 2)).max(upper_y0 + 1);
		let lower_y0 = (cell_y * 2 + 1) * source_height / (height * 2);
		let lower_y1 = ((cell_y * 2 + 2) * source_height / (height * 2)).max(lower_y0 + 1);
		for cell_x in 0..width {
			let x0 = cell_x * source_width / width;
			let x1 = ((cell_x + 1) * source_width / width).max(x0 + 1);
			cells.push((
				average_pixels(pixels, x0, x1, upper_y0, upper_y1, gate),
				average_pixels(pixels, x0, x1, lower_y0, lower_y1, gate),
			));
		}
	}
	ImgState {
		cells: cells.into_boxed_slice(),
		width: width as u16,
		rows:  height as u16,
		phase: Load::Ready,
	}
}

/// Alpha-weighted mean of one half-cell's source block; `None` when the
/// block is mostly transparent, so logo padding never paints.
fn average_pixels(
	pixels: &[Vec<[u8; 4]>],
	x0: usize,
	x1: usize,
	y0: usize,
	y1: usize,
	gate: u64,
) -> Option<[u8; 3]> {
	let mut color = [0_u64; 3];
	let mut alpha = 0_u64;
	let mut count = 0_u64;
	for row in &pixels[y0.min(pixels.len() - 1)..y1.min(pixels.len())] {
		for pixel in &row[x0.min(row.len() - 1)..x1.min(row.len())] {
			let weight = u64::from(pixel[3]);
			color[0] += u64::from(pixel[0]) * weight;
			color[1] += u64::from(pixel[1]) * weight;
			color[2] += u64::from(pixel[2]) * weight;
			alpha += weight;
			count += 1;
		}
	}
	if count == 0 || alpha < count * gate {
		return None;
	}
	Some([(color[0] / alpha) as u8, (color[1] / alpha) as u8, (color[2] / alpha) as u8])
}

#[cfg(test)]
mod tests {

	use std::{env, fs};

	use super::*;
	use crate::{
		assets::provider_logo,
		component::PaintCtx,
		frame::{CellContent, Frame, Size},
		imagereg::{bytes as registry_bytes, intern},
		test_support::frame_row_text,
	};

	#[test]
	fn invalid_inline_base64_source_paints_placeholder_without_panicking() {
		let mut image = Img::new()
			.with(Prop::Src, "data:image/png;base64,AAAA")
			.with(Prop::W, 12_u16);
		let ctx = UiContext::default();
		assert_eq!(image.height(&ctx, 12), 3);
		let mut frame = Frame::new(Size::new(20, 3));
		let mut hits = Vec::new();
		image.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut hits, &mut Vec::new()),
			Rect::new(0, 0, 12, 3),
		);
		assert!(frame_row_text(&frame, 1).contains("[img:"));
	}

	#[test]
	fn indexed_palette_with_trns_expands_to_rgba() {
		let mut bytes = Vec::new();
		{
			let mut encoder = png::Encoder::new(&mut bytes, 2, 2);
			encoder.set_color(png::ColorType::Indexed);
			encoder.set_depth(png::BitDepth::Eight);
			encoder.set_palette(vec![255, 0, 0, 0, 0, 255]);
			encoder.set_trns(vec![255, 0]);
			let mut writer = encoder.write_header().unwrap();
			writer.write_image_data(&[0, 0, 1, 1]).unwrap();
		}
		let pixels = decode_png(&bytes).unwrap();
		assert_eq!(pixels[0][0], [255, 0, 0, 255], "palette index 0 is opaque red");
		assert_eq!(pixels[1][1], [0, 0, 255, 0], "palette index 1 is transparent blue");
	}

	#[test]
	fn in_memory_bytes_probe_dimensions_and_decode_lazily() {
		let mut encoded = Vec::new();
		{
			let mut encoder = png::Encoder::new(&mut encoded, 2, 3);
			encoder.set_color(png::ColorType::Rgba);
			encoder.set_depth(png::BitDepth::Eight);
			let mut writer = encoder.write_header().unwrap();
			writer.write_image_data(&[255; 2 * 3 * 4]).unwrap();
		}
		let mut image = Img::from_bytes(Bytes::from(encoded)).with(Prop::W, 2_u16);
		assert_eq!(image.dimensions(), Some(ImageDimensions { width: 2, height: 3 }));
		assert_eq!(image.state.phase, Load::Unloaded);
		assert_eq!(image.height(&UiContext::default(), 2), 2);
		assert_eq!(image.state.phase, Load::Ready);
	}

	#[test]
	fn transparent_pixels_sample_to_unpainted_halves() {
		// 4x2 source at two cells: one pixel block per half-cell.
		let red = [255_u8, 0, 0, 255];
		let clear = [0_u8, 0, 0, 0];
		let pixels = vec![vec![red, red, clear, clear], vec![clear, clear, clear, clear]];
		let state = sample_cells(&pixels, 2, RowBound::Aspect, PAINT_GATE);
		assert_eq!(state.rows, 1);
		assert_eq!(&*state.cells, &[(Some([255, 0, 0]), None), (None, None)]);
	}

	#[test]
	fn trim_recovers_padded_logos_at_thumbnail_sizes() {
		// A 2x2 opaque glyph centered in an 8x8 transparent canvas: at one
		// cell, every half-block averages under the alpha threshold.
		let blue = [0_u8, 0, 255, 255];
		let clear = [0_u8, 0, 0, 0];
		let mut pixels = vec![vec![clear; 8]; 8];
		for row in pixels.iter_mut().skip(3).take(2) {
			for pixel in row.iter_mut().skip(3).take(2) {
				*pixel = blue;
			}
		}
		let padded = sample_cells(&pixels, 1, RowBound::Aspect, PAINT_GATE);
		assert_eq!(&*padded.cells, &[(None, None)], "padding averages the glyph away");

		let trimmed =
			sample_cells(&trim_transparent(pixels), 1, RowBound::Aspect, TRIMMED_PAINT_GATE);
		assert_eq!(
			&*trimmed.cells,
			&[(Some([0, 0, 255]), Some([0, 0, 255]))],
			"trimming crops to the glyph before sampling"
		);

		let empty = vec![vec![clear; 4]; 4];
		assert_eq!(trim_transparent(empty).len(), 4, "fully transparent stays unchanged");
	}

	#[test]
	fn alpha_background_stays_unpainted_in_cells_mode() {
		let mut bytes = Vec::new();
		{
			let mut encoder = png::Encoder::new(&mut bytes, 4, 2);
			encoder.set_color(png::ColorType::Rgba);
			encoder.set_depth(png::BitDepth::Eight);
			let mut writer = encoder.write_header().unwrap();
			let mut data = vec![0_u8; 4 * 2 * 4];
			// Opaque red in the top-left pixel block; everything else clear.
			for x in 0..2 {
				data[x * 4] = 255;
				data[x * 4 + 3] = 255;
			}
			writer.write_image_data(&data).unwrap();
		}
		let path = env::temp_dir().join(format!("omp-tui-img-alpha-{}.png", std::process::id()));
		fs::write(&path, bytes).unwrap();
		let mut image = Img::new()
			.with(Prop::Src, path.to_string_lossy().as_ref())
			.with(Prop::W, 2_u16);
		let ctx = UiContext::default();
		assert_eq!(image.height(&ctx, 2), 1);
		fs::remove_file(path).unwrap();

		let mut frame = Frame::new(Size::new(3, 1));
		image.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut Vec::new(), &mut Vec::new()),
			Rect::new(0, 0, 2, 1),
		);
		// Opaque top half paints a foreground-only half block …
		let painted = frame.cell(0, 0);
		assert_eq!(painted.style.foreground_color(), Color::Rgb(255, 0, 0));
		assert_eq!(painted.style.background_color(), Color::Default);
		// … and the fully transparent cell is never touched.
		assert_eq!(frame_row_text(&frame, 0), "▀");
	}

	#[test]
	fn jpeg_header_reserves_aspect_correct_placeholder() {
		let path = env::temp_dir().join(format!("omp-tui-img-jpeg-{}.jpg", std::process::id()));
		let jpeg = [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x08, 8, 0x00, 80, 0x00, 160, 1];
		fs::write(&path, jpeg).unwrap();
		let mut image = Img::new()
			.with(Prop::Src, path.to_string_lossy().as_ref())
			.with(Prop::W, 20_u16);
		let ctx = UiContext::default();
		assert_eq!(image.height(&ctx, 20), 5);
		fs::remove_file(path).unwrap();

		let mut frame = Frame::new(Size::new(20, 5));
		image.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut Vec::new(), &mut Vec::new()),
			Rect::new(0, 0, 20, 5),
		);
		assert!(frame_row_text(&frame, 2).contains("[img:"));
		assert_ne!(frame_row_text(&frame, 4).trim(), "");
	}

	#[test]
	fn kitty_mode_paints_typed_image_cells() {
		let mut image = Img::new().kitty(0x12_34_56, 2, 3);
		let ctx = UiContext { graphics: Graphics::KittyPlaceholders, ..UiContext::default() };
		assert_eq!(image.height(&ctx, 20), 2);
		let mut frame = Frame::new(Size::new(3, 2));
		image.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut Vec::new(), &mut Vec::new()),
			Rect::new(0, 0, 3, 2),
		);
		assert!(matches!(frame.cell(2, 1).content, CellContent::Image {
			id:   0x12_34_56,
			row:  1,
			col:  2,
			rows: 2,
			cols: 3,
		}));
	}

	#[test]
	fn packaged_png_asset_interns_and_decodes_without_filesystem_access() {
		let logo = "asset://login/anthropic";
		let mut image = Img::new()
			.with(Prop::Src, logo)
			.with(Prop::W, 2_u16)
			.with(Prop::H, 1_u16);
		let ctx = UiContext { graphics: Graphics::KittyPlaceholders, ..UiContext::default() };
		assert_eq!(image.measure(&ctx), (2, 1));
		let mut frame = Frame::new(Size::new(3, 1));
		image.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut Vec::new(), &mut Vec::new()),
			Rect::new(0, 0, 2, 1),
		);
		let CellContent::Image { id, row: 0, col: 1, rows: 1, cols: 2 } = frame.cell(1, 0).content
		else {
			panic!("src image paints typed placeholder cells: {:?}", frame.cell(1, 0).content);
		};
		assert!(id > 0x00f0_0000, "registry IDs allocate from the top of the 24-bit range");
		let embedded = provider_logo("anthropic").expect("packaged test logo");
		let registered = registry_bytes(id).expect("interned image bytes");
		assert_eq!(
			registered.as_ptr(),
			embedded.as_ptr(),
			"interning must not copy embedded logo bytes",
		);

		// The same source in a second component shares the interned ID.
		let mut sibling = Img::new()
			.with(Prop::Src, logo)
			.with(Prop::W, 2_u16)
			.with(Prop::H, 1_u16);
		let mut second = Frame::new(Size::new(3, 1));
		sibling.paint(
			&mut PaintCtx::new(&mut second, &ctx, &mut Vec::new(), &mut Vec::new()),
			Rect::new(0, 0, 2, 1),
		);
		assert!(
			matches!(second.cell(0, 0).content, CellContent::Image { id: other, .. } if other == id)
		);

		// Cells tier ignores the interned box and decodes the same embedded
		// bytes into visible half-block cells.
		let cells_ctx = UiContext::default();
		let mut fallback = Img::new()
			.with(Prop::Src, logo)
			.with(Prop::W, 2_u16)
			.with(Prop::H, 1_u16)
			.with(Prop::Trim, true);
		assert_eq!(fallback.height(&cells_ctx, 2), 1);
		assert_eq!(fallback.state.phase, Load::Ready);
		let mut cells = Frame::new(Size::new(2, 1));
		fallback.paint(
			&mut PaintCtx::new(&mut cells, &cells_ctx, &mut Vec::new(), &mut Vec::new()),
			Rect::new(0, 0, 2, 1),
		);
		assert_ne!(frame_row_text(&cells, 0), "", "embedded logo paints half-block cells");
	}

	#[test]
	fn jpeg_attachment_converts_once_to_cached_png_for_kitty() {
		let path = env::temp_dir().join(format!("omp-tui-img-kitty-jpeg-{}.jpg", std::process::id()));
		let pixels = image::RgbImage::from_pixel(2, 2, image::Rgb([20, 40, 60]));
		let mut jpeg = io::Cursor::new(Vec::new());
		image::DynamicImage::ImageRgb8(pixels)
			.write_to(&mut jpeg, image::ImageFormat::Jpeg)
			.unwrap();
		fs::write(&path, jpeg.into_inner()).unwrap();
		let source = path.to_string_lossy().into_owned();
		let ctx = UiContext { graphics: Graphics::KittyPlaceholders, ..UiContext::default() };

		let mut attachment = Img::new()
			.with(Prop::Src, source.as_str())
			.with(Prop::W, 2_u16)
			.with(Prop::H, 1_u16);
		assert_eq!(attachment.height(&ctx, 2), 1);
		let mut frame = Frame::new(Size::new(2, 1));
		attachment.paint(
			&mut PaintCtx::new(&mut frame, &ctx, &mut Vec::new(), &mut Vec::new()),
			Rect::new(0, 0, 2, 1),
		);
		let CellContent::Image { id, .. } = frame.cell(0, 0).content else {
			panic!("converted JPEG paints Kitty image cells");
		};
		let cached = registry_bytes(id).expect("converted image is registry-cached");
		assert!(cached.starts_with(b"\x89PNG\r\n\x1a\n"), "Kitty f=100 receives PNG bytes");

		let sibling = intern(&source).expect("same source reuses cached PNG");
		assert_eq!(sibling.id, id);
		assert_eq!(sibling.png.as_ptr(), cached.as_ptr(), "cache avoids a second conversion");
		fs::remove_file(path).unwrap();
	}

	#[test]
	fn max_rows_caps_height_and_narrows_columns_on_every_tier() {
		let path = env::temp_dir().join(format!("omp-tui-img-max-rows-{}.png", std::process::id()));
		let pixels = image::RgbaImage::from_pixel(10, 40, image::Rgba([200, 30, 30, 255]));
		image::DynamicImage::ImageRgba8(pixels)
			.save_with_format(&path, image::ImageFormat::Png)
			.unwrap();
		let source = path.to_string_lossy().into_owned();

		// Cells tier: aspect alone would want 40 rows at 20 columns; the cap
		// shrinks columns to keep the aspect at the row budget.
		let ctx = UiContext::default();
		let mut capped = Img::new()
			.with(Prop::Src, source.as_str())
			.with(Prop::W, 20_u16)
			.with(Prop::MaxRows, 4_u16);
		assert_eq!(capped.height(&ctx, 20), 4);
		assert_eq!(capped.state.width, 2);
		assert_eq!(capped.state.phase, Load::Ready);
		let mut uncapped = Img::new()
			.with(Prop::Src, source.as_str())
			.with(Prop::W, 20_u16);
		assert_eq!(uncapped.height(&ctx, 20), 40);
		// A narrower layout re-decodes once; the same budget is a no-op.
		assert_eq!(capped.height(&ctx, 10), 4);
		assert_eq!(capped.state.width, 2);

		// Kitty placeholder tier: the interned box honors the cap and the
		// column budget the layout offers.
		let kitty = UiContext { graphics: Graphics::KittyPlaceholders, ..UiContext::default() };
		let mut typed = Img::new()
			.with(Prop::Src, source.as_str())
			.with(Prop::W, 100_u16)
			.with(Prop::MaxRows, 4_u16);
		assert_eq!(typed.height(&kitty, 60), 4);
		let (_, rows, cols) = typed.cell_box(&kitty, Some(60)).expect("interned box");
		assert_eq!((rows, cols), (4, 2));
		let mut wide = Img::new()
			.with(Prop::Src, source.as_str())
			.with(Prop::W, 100_u16);
		let (_, rows, cols) = wide.cell_box(&kitty, Some(30)).expect("interned box");
		assert_eq!(cols, 30, "the placeholder box clamps to the offered columns");
		assert_eq!(rows, 60);
		let _ = fs::remove_file(path);
	}

	#[test]
	fn image_cell_box_preserves_aspect_within_caps() {
		let px = |width, height| ImageDimensions { width, height };
		// Wide caps: full width, aspect-derived rows.
		assert_eq!(image_cell_box(px(100, 50), 40, 20), (40, 10));
		// Row cap binds: columns shrink to preserve aspect.
		assert_eq!(image_cell_box(px(100, 400), 40, 10), (5, 10));
		// Degenerate caps and dimensions never return zero.
		assert_eq!(image_cell_box(px(1, 1), 0, 0), (1, 1));
	}

	#[test]
	fn draw_image_inline_paints_half_blocks_and_typed_cells() {
		// A 4x4 opaque red PNG on disk, as a persisted tool result image.
		let mut bytes = Vec::new();
		{
			let mut encoder = png::Encoder::new(&mut bytes, 4, 4);
			encoder.set_color(png::ColorType::Rgba);
			encoder.set_depth(png::BitDepth::Eight);
			let mut writer = encoder.write_header().unwrap();
			let mut data = vec![0_u8; 4 * 4 * 4];
			for pixel in data.as_chunks_mut::<4>().0 {
				pixel[0] = 255;
				pixel[3] = 255;
			}
			writer.write_image_data(&data).unwrap();
		}
		let path = env::temp_dir().join(format!("omp-tui-img-inline-{}.png", std::process::id()));
		fs::write(&path, bytes).unwrap();
		let source = path.to_string_lossy().into_owned();

		// Every non-placeholder tier samples to colored half blocks.
		let ctx = UiContext::default();
		let mut frame = Frame::new(Size::new(8, 4));
		let rows = draw_image_inline(&mut frame, &ctx, 1, 0, &source, 4, 8);
		assert_eq!(rows, 2, "4x4 pixels at 4 columns cover two half-block rows");
		assert_eq!(frame_row_text(&frame, 0).trim(), "▀▀▀▀");
		assert_eq!(frame.cell(1, 0).style.foreground_color(), Color::Rgb(255, 0, 0));

		// The Kitty placeholder tier places typed image cells instead.
		let kitty_ctx = UiContext { graphics: Graphics::KittyPlaceholders, ..UiContext::default() };
		let mut typed = Frame::new(Size::new(8, 4));
		let rows = draw_image_inline(&mut typed, &kitty_ctx, 0, 0, &source, 4, 8);
		assert_eq!(rows, 2);
		assert!(matches!(typed.cell(3, 1).content, CellContent::Image {
			row: 1,
			col: 3,
			rows: 2,
			cols: 4,
			..
		}));
		fs::remove_file(path).unwrap();

		// Undecodable sources report zero rows so callers keep their text
		// fallback.
		assert_eq!(draw_image_inline(&mut frame, &ctx, 0, 0, "/nonexistent.png", 4, 8), 0);
	}
}
