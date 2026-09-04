use std::{
	sync::{
		LazyLock,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use omp_core::Str;
use parking_lot::Mutex;
use smol_bitmap::SmolBitmap;
use xutf::Text;

use crate::{markup::Border, rich::cell_width};

static NEXT_FRAME_ID: AtomicU64 = AtomicU64::new(1);

/// Terminal dimensions measured in character cells.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Size {
	/// Number of columns.
	pub width:  u16,
	/// Number of rows.
	pub height: u16,
}

impl Size {
	/// Creates terminal dimensions from a column and row count.
	pub const fn new(width: u16, height: u16) -> Self {
		Self { width, height }
	}

	fn area(self) -> usize {
		usize::from(self.width) * usize::from(self.height)
	}
}

/// A rectangular cell region clipped by drawing operations to the frame.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Rect {
	/// Leftmost column.
	pub x:      u16,
	/// Topmost row.
	pub y:      u16,
	/// Region width in cells.
	pub width:  u16,
	/// Region height in cells.
	pub height: u16,
}

impl Rect {
	/// Creates a cell rectangle.
	pub const fn new(x: u16, y: u16, width: u16, height: u16) -> Self {
		Self { x, y, width, height }
	}

	/// Whether `other` lies entirely within this rectangle.
	pub const fn contains_rect(self, other: Self) -> bool {
		other.x >= self.x
			&& other.y >= self.y
			&& other.right() <= self.right()
			&& other.bottom() <= self.bottom()
	}

	const fn right(self) -> u16 {
		self.x.saturating_add(self.width)
	}

	const fn bottom(self) -> u16 {
		self.y.saturating_add(self.height)
	}
}

/// A terminal foreground or background color.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Color {
	/// The terminal's configured default color.
	#[default]
	Default,
	/// An indexed color from the terminal's 256-color palette.
	Indexed(u8),
	/// A 24-bit RGB color.
	Rgb(u8, u8, u8),
}

impl Color {
	/// Linearly blends RGB channels from `self` toward `other`.
	///
	/// Non-RGB endpoints cannot be resolved without a palette and therefore
	/// remain unchanged. `amount` is clamped to `0.0..=1.0`.
	pub fn mix(self, other: Self, amount: f32) -> Self {
		let (Self::Rgb(ar, ag, ab), Self::Rgb(br, bg, bb)) = (self, other) else {
			return self;
		};
		let amount = amount.clamp(0.0, 1.0);
		let channel = |a: u8, b: u8| {
			f32::mul_add(f32::from(b) - f32::from(a), amount, f32::from(a)).round() as u8
		};
		Self::Rgb(channel(ar, br), channel(ag, bg), channel(ab, bb))
	}

	/// Returns BT.709 perceptual luminance in the range `0.0..=1.0`.
	///
	/// Terminal-default and indexed colors need palette context and therefore
	/// report zero; theme-derived control colors are always RGB at this seam.
	pub fn luminance(self) -> f32 {
		let Self::Rgb(red, green, blue) = self else {
			return 0.0;
		};
		(0.7152f32.mul_add(f32::from(green), 0.2126 * f32::from(red)) + 0.0722 * f32::from(blue))
			/ 255.0
	}

	/// Derives a readable label color from this fill.
	///
	/// RGB fills blend toward black or white. Xterm-indexed fills select the
	/// corresponding black or white palette endpoint; the terminal-default
	/// surface remains terminal-default because its actual color is unknown.
	pub fn contrast_label(self) -> Self {
		match self {
			Self::Default => Self::Default,
			Self::Indexed(index) => {
				if indexed_rgb(index).luminance() > 0.5 {
					Self::Indexed(16)
				} else {
					Self::Indexed(231)
				}
			},
			Self::Rgb(..) if self.luminance() > 0.5 => self.mix(Self::Rgb(0, 0, 0), 0.82),
			Self::Rgb(..) => self.mix(Self::Rgb(255, 255, 255), 0.92),
		}
	}

	/// Parses any CSS color and lowers it to a cell color without
	/// context: fully transparent values and `currentcolor` become
	/// [`Color::Default`] (the terminal's pass-through color),
	/// translucent values keep their color unblended, and system
	/// colors — which need a theme — return `None`. Parse a
	/// [`CssColor`](crate::CssColor) instead when alpha, `currentcolor`,
	/// or system colors must survive to a context-aware lowering.
	///
	/// # Example
	/// ```
	/// use omp_tui::Color;
	/// assert_eq!(Color::parse("rebeccapurple"), Some(Color::Rgb(0x66, 0x33, 0x99)));
	/// assert_eq!(Color::parse("hsl(120 100% 50%)"), Some(Color::Rgb(0, 255, 0)));
	/// assert_eq!(Color::parse("transparent"), Some(Color::Default));
	/// assert_eq!(Color::parse("rgb(255 0 0 / 0)"), Some(Color::Default));
	/// assert_eq!(Color::parse("Canvas"), None);
	/// ```
	pub fn parse(value: &str) -> Option<Self> {
		use crate::color::CssColor;
		match CssColor::parse(value)? {
			CssColor::Rgba(_, _, _, alpha) if alpha <= 0.0 => Some(Self::Default),
			CssColor::Rgba(red, green, blue, _) => Some(Self::Rgb(red, green, blue)),
			CssColor::Current => Some(Self::Default),
			CssColor::System(_) => None,
		}
	}

	/// Quantizes a 24-bit color to the nearest xterm 256-color cube or
	/// grayscale entry. Default and already-indexed colors pass through.
	pub const fn quantized_256(self) -> Self {
		let Self::Rgb(red, green, blue) = self else {
			return self;
		};
		let levels = [0_u8, 95, 135, 175, 215, 255];
		let ri = nearest_level(red);
		let gi = nearest_level(green);
		let bi = nearest_level(blue);
		let cube = 16 + 36 * ri + 6 * gi + bi;
		let cube_r = levels[ri as usize];
		let cube_g = levels[gi as usize];
		let cube_b = levels[bi as usize];
		let cube_error = distance_sq(red, green, blue, cube_r, cube_g, cube_b);

		let average = (red as u16 + green as u16 + blue as u16) / 3;
		let gray_index = if average <= 8 {
			0
		} else {
			let candidate = (average - 8 + 5) / 10;
			if candidate > 23 { 23 } else { candidate as u8 }
		};
		let gray = 8 + 10 * gray_index;
		let gray_error = distance_sq(red, green, blue, gray, gray, gray);
		if gray_error < cube_error {
			Self::Indexed(232 + gray_index)
		} else {
			Self::Indexed(cube)
		}
	}
}

const fn indexed_rgb(index: u8) -> Color {
	const ANSI: [(u8, u8, u8); 16] = [
		(0, 0, 0),
		(128, 0, 0),
		(0, 128, 0),
		(128, 128, 0),
		(0, 0, 128),
		(128, 0, 128),
		(0, 128, 128),
		(192, 192, 192),
		(128, 128, 128),
		(255, 0, 0),
		(0, 255, 0),
		(255, 255, 0),
		(0, 0, 255),
		(255, 0, 255),
		(0, 255, 255),
		(255, 255, 255),
	];
	if index < 16 {
		let (red, green, blue) = ANSI[index as usize];
		return Color::Rgb(red, green, blue);
	}
	if index < 232 {
		const LEVELS: [u8; 6] = [0, 95, 135, 175, 215, 255];
		let cube = index - 16;
		return Color::Rgb(
			LEVELS[(cube / 36) as usize],
			LEVELS[((cube % 36) / 6) as usize],
			LEVELS[(cube % 6) as usize],
		);
	}
	let gray = 8 + 10 * (index - 232);
	Color::Rgb(gray, gray, gray)
}

const fn nearest_level(channel: u8) -> u8 {
	let levels = [0_u8, 95, 135, 175, 215, 255];
	let mut best = 0_u8;
	let mut best_distance = u16::MAX;
	let mut index = 0_u8;
	while index < 6 {
		let level = levels[index as usize];
		let distance = channel.abs_diff(level) as u16;
		if distance < best_distance {
			best = index;
			best_distance = distance;
		}
		index += 1;
	}
	best
}

const fn distance_sq(r: u8, g: u8, b: u8, rr: u8, gg: u8, bb: u8) -> u32 {
	let dr = r.abs_diff(rr) as u32;
	let dg = g.abs_diff(gg) as u32;
	let db = b.abs_diff(bb) as u32;
	dr * dr + dg * dg + db * db
}
/// A two-stop terminal color ramp.
///
/// Zero degrees runs left-to-right; 90 degrees runs top-to-bottom.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Gradient {
	start: Color,
	end:   Color,
	angle: u16,
}

impl Gradient {
	/// Creates a ramp with an angle normalized by the markup parser.
	pub(crate) const fn new(start: Color, end: Color, angle: u16) -> Self {
		Self { start, end, angle }
	}

	/// Returns the color at the beginning of the ramp.
	pub const fn start(&self) -> Color {
		self.start
	}

	/// Returns the color at the end of the ramp.
	pub const fn end(&self) -> Color {
		self.end
	}

	/// Returns the angle: 0 is left-to-right and 90 is top-to-bottom.
	pub const fn angle(&self) -> u16 {
		self.angle
	}

	fn projection(self, bounds: Rect) -> GradientProjection {
		let (horizontal, vertical) = match self.angle % 360 {
			0 => (1.0, 0.0),
			90 => (0.0, 1.0),
			180 => (-1.0, 0.0),
			270 => (0.0, -1.0),
			angle => {
				let radians = f32::from(angle).to_radians();
				(radians.cos(), radians.sin())
			},
		};
		let width = f32::from(bounds.width.saturating_sub(1));
		let height = f32::from(bounds.height.saturating_sub(1));
		let horizontal_end = horizontal * width;
		let vertical_end = vertical * height;
		let min = 0.0_f32
			.min(horizontal_end)
			.min(vertical_end)
			.min(horizontal_end + vertical_end);
		let max = 0.0_f32
			.max(horizontal_end)
			.max(vertical_end)
			.max(horizontal_end + vertical_end);
		GradientProjection {
			start: self.start,
			end: self.end,
			horizontal,
			vertical,
			origin_x: bounds.x,
			origin_y: bounds.y,
			min,
			span: max - min,
		}
	}
}

/// One native-decoration primitive for pixel-capable presenters. Cell
/// coordinates; the glyph backend never reads these.
#[derive(Clone, Debug, PartialEq)]
pub struct Decor {
	/// Decorated cell region.
	pub rect: Rect,
	/// Visual primitive applied to the region.
	pub kind: DecorKind,
}

/// Visual treatment carried by a native-decoration primitive.
#[derive(Clone, Debug, PartialEq)]
pub enum DecorKind {
	/// Container underlay; `rounded` follows the box's border shape.
	Fill {
		/// Underlay paint.
		fill:    DecorFill,
		/// Whether the fill follows rounded border corners.
		rounded: bool,
	},
	/// Border ring; `glow` is the focus/hover halo (color, strength 0..1).
	Border {
		/// Border shape.
		border: Border,
		/// Border paint.
		ink:    DecorFill,
		/// Optional halo color and normalized strength.
		glow:   Option<(Color, f32)>,
	},
	/// Moving highlight crest over the rect's text (period of one sweep).
	Shimmer {
		/// Duration of one highlight sweep.
		period: Duration,
	},
	/// Soft fade-in edge of a streaming text reveal. The rect is the front
	/// row's line; glyphs within ~2 cells behind `front` ramp in.
	Reveal {
		/// Fractional absolute column of the reveal edge.
		front: f32,
	},
}

/// Paint used by a native fill or border decoration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DecorFill {
	/// A flat color.
	Solid(Color),
	/// A two-stop color ramp.
	Gradient(Gradient),
}

#[derive(Clone, Copy)]
struct GradientProjection {
	start:      Color,
	end:        Color,
	horizontal: f32,
	vertical:   f32,
	origin_x:   u16,
	origin_y:   u16,
	min:        f32,
	span:       f32,
}

impl GradientProjection {
	fn color_at(self, x: u16, y: u16) -> Color {
		let (Color::Rgb(red, green, blue), Color::Rgb(end_red, end_green, end_blue)) =
			(self.start, self.end)
		else {
			return self.start;
		};
		if self.span <= f32::EPSILON {
			return self.start;
		}
		let position = self.vertical.mul_add(
			f32::from(y) - f32::from(self.origin_y),
			self.horizontal * (f32::from(x) - f32::from(self.origin_x)),
		);
		let amount = ((position - self.min) / self.span).clamp(0.0, 1.0);
		let channel = |start: u8, end: u8| {
			f32::mul_add(f32::from(end) - f32::from(start), amount, f32::from(start))
				.round()
				.clamp(0.0, 255.0) as u8
		};
		Color::Rgb(channel(red, end_red), channel(green, end_green), channel(blue, end_blue))
	}
}
/// Stable process-local identity for one terminal hyperlink target.
///
/// IDs are interned from URLs so copied rich-text styles and frame cells carry
/// only a compact typed handle. The renderer resolves the handle immediately
/// before materializing OSC 8.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LinkId(u32);
impl LinkId {
	pub(crate) const fn get(self) -> u32 {
		self.0
	}
}

#[derive(Default)]
struct LinkRegistry {
	urls: Vec<Str>,
}

impl LinkRegistry {
	fn intern(&mut self, url: &str) -> LinkId {
		if let Some(index) = self.urls.iter().position(|known| known == url) {
			return LinkId(u32::try_from(index + 1).expect("hyperlink registry exceeds u32"));
		}
		self.urls.push(Str::new(url));
		LinkId(u32::try_from(self.urls.len()).expect("hyperlink registry exceeds u32"))
	}

	fn get(&self, id: LinkId) -> Option<&str> {
		let index = usize::try_from(id.0).ok()?.checked_sub(1)?;
		self.urls.get(index).map(Str::as_str)
	}
}

static LINKS: LazyLock<Mutex<LinkRegistry>> = LazyLock::new(|| Mutex::new(LinkRegistry::default()));

/// Resolves an interned hyperlink target, passing the URL to `use_url` when
/// the id is known.
pub fn with_link_url<T>(id: LinkId, use_url: impl FnOnce(&str) -> T) -> Option<T> {
	let links = LINKS.lock();
	links.get(id).map(use_url)
}

fn intern_link(url: &str) -> Option<LinkId> {
	if url.is_empty() || !url.bytes().any(|byte| !matches!(byte, b'\x1b' | b'\x07')) {
		return None;
	}
	let mut links = LINKS.lock();
	Some(links.intern(url))
}

/// Underline shape carried by a [`Style`] (SGR `4` / `4:x`).
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Underline {
	/// No underline.
	#[default]
	None,
	/// Single straight underline (SGR `4`).
	Straight,
	/// Curly underline (SGR `4:3`), used for typo squiggles.
	Curly,
}

/// Canonical visual attributes for one or more cells.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Style {
	pub(super) foreground:      Color,
	pub(super) background:      Color,
	pub(super) bold:            bool,
	pub(super) dim:             bool,
	pub(super) italic:          bool,
	pub(super) underline:       Underline,
	/// Underline color (SGR 58); also carries the Kitty placeholder
	/// placement-ID reference on typed image cells.
	pub(super) underline_color: Color,
	pub(super) reverse:         bool,
	pub(super) strikethrough:   bool,
	pub(super) link:            Option<LinkId>,
}

impl Style {
	/// Creates an unstyled terminal style.
	pub const fn new() -> Self {
		Self {
			foreground:      Color::Default,
			background:      Color::Default,
			bold:            false,
			dim:             false,
			italic:          false,
			underline:       Underline::None,
			underline_color: Color::Default,
			reverse:         false,
			strikethrough:   false,
			link:            None,
		}
	}

	/// Sets the foreground color.
	pub const fn fg(mut self, color: Color) -> Self {
		self.foreground = color;
		self
	}

	/// Sets the background color.
	pub const fn bg(mut self, color: Color) -> Self {
		self.background = color;
		self
	}

	/// Enables bold intensity.
	pub const fn bold(mut self) -> Self {
		self.bold = true;
		self
	}

	/// Enables faint intensity.
	pub const fn dim(mut self) -> Self {
		self.dim = true;
		self
	}

	/// Enables italics.
	pub const fn italic(mut self) -> Self {
		self.italic = true;
		self
	}

	/// Enables underlining.
	pub const fn underline(mut self) -> Self {
		self.underline = Underline::Straight;
		self
	}

	/// Enables a curly underline (SGR `4:3`), the typo-squiggle shape.
	pub const fn undercurl(mut self) -> Self {
		self.underline = Underline::Curly;
		self
	}

	/// Sets the underline color (SGR 58); [`Color::Default`] leaves the
	/// terminal's underline color untouched.
	pub const fn underline_color(mut self, color: Color) -> Self {
		self.underline_color = color;
		self
	}

	/// Enables reverse video.
	pub const fn reverse(mut self) -> Self {
		self.reverse = true;
		self
	}

	/// Enables strikethrough.
	pub const fn strikethrough(mut self) -> Self {
		self.strikethrough = true;
		self
	}

	/// Attaches a terminal hyperlink target to this style.
	///
	/// The URL is interned once and only its typed identity rides on rich-text
	/// runs and frame cells. Empty targets are ignored.
	pub fn link(mut self, url: &str) -> Self {
		self.link = intern_link(url);
		self
	}

	pub(crate) const fn without_link(mut self) -> Self {
		self.link = None;
		self
	}

	/// CSS-like cascade: unset properties adopt the parent's. A
	/// `Color::Default` foreground counts as unset and attribute flags OR
	/// together. The background never inherits — ancestor fills reach
	/// descendants through the paint underlay instead.
	pub const fn inherit(mut self, parent: Self) -> Self {
		if matches!(self.foreground, Color::Default) {
			self.foreground = parent.foreground;
		}
		self.bold |= parent.bold;
		self.dim |= parent.dim;
		self.italic |= parent.italic;
		if matches!(self.underline, Underline::None) {
			self.underline = parent.underline;
		}
		if matches!(self.underline_color, Color::Default) {
			self.underline_color = parent.underline_color;
		}
		self.reverse |= parent.reverse;
		self.strikethrough |= parent.strikethrough;
		if self.link.is_none() {
			self.link = parent.link;
		}
		self
	}

	/// The foreground color, for callers deriving accents from a style.
	pub const fn foreground_color(&self) -> Color {
		self.foreground
	}

	/// The background color, for callers deciding whether to fill a region.
	pub const fn background_color(&self) -> Color {
		self.background
	}

	/// Reads every attribute at once, for presenters outside this crate.
	pub const fn spec(&self) -> StyleSpec {
		StyleSpec {
			foreground:      self.foreground,
			background:      self.background,
			bold:            self.bold,
			dim:             self.dim,
			italic:          self.italic,
			underline:       self.underline,
			underline_color: self.underline_color,
			reverse:         self.reverse,
			strikethrough:   self.strikethrough,
			link:            self.link,
		}
	}
}

/// A plain read-out of a [`Style`]'s attributes.
///
/// Non-terminal presenters (the GPU host) composite cells without emitting
/// escapes; `spec` exposes the full attribute set without opening the
/// fields themselves.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StyleSpec {
	/// Foreground color; [`Color::Default`] defers to the host.
	pub foreground:      Color,
	/// Background color; [`Color::Default`] shows the host backdrop.
	pub background:      Color,
	/// Bold intensity.
	pub bold:            bool,
	/// Faint intensity.
	pub dim:             bool,
	/// Italics.
	pub italic:          bool,
	/// Underlining.
	pub underline:       Underline,
	/// Underline color (SGR 58); [`Color::Default`] follows the foreground.
	pub underline_color: Color,
	/// Reverse video.
	pub reverse:         bool,
	/// Strikethrough.
	pub strikethrough:   bool,
	/// Hyperlink target, if any.
	pub link:            Option<LinkId>,
}

/// Stored glyph data for a declarative cell.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CellContent {
	/// A one-cell space without owned text.
	Blank,
	/// A shaped grapheme cluster spanning `width` cells.
	Grapheme {
		/// The cluster text (one grapheme, possibly multi-codepoint).
		text:  Str,
		/// Cell span; continuation cells follow wide clusters.
		width: u16,
	},
	/// A Kitty Unicode-placeholder cell, materialized only by the renderer.
	Image {
		/// Registered image identity.
		id:   u32,
		/// First image row this cell displays.
		row:  u16,
		/// First image column this cell displays.
		col:  u16,
		/// Image rows the placement spans.
		rows: u16,
		/// Image columns the placement spans.
		cols: u16,
	},
	/// Trailing cell of a wide cluster; the head carries the glyph.
	Continuation,
}

/// One styled cell in a frame's internal grid.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Cell {
	pub(super) content: CellContent,
	pub(super) style:   Style,
}

impl Cell {
	pub(super) const fn blank(style: Style) -> Self {
		Self { content: CellContent::Blank, style }
	}

	/// The stored glyph data, for presenters compositing the grid directly.
	#[inline]
	pub const fn content(&self) -> &CellContent {
		&self.content
	}

	/// The cell's visual attributes.
	#[inline]
	pub const fn style(&self) -> Style {
		self.style
	}

	#[cfg(test)]
	fn is_default_blank(&self) -> bool {
		matches!(&self.content, CellContent::Blank) && self.style == Style::default()
	}
}

/// A semantic mark on one frame row, materialized by the terminal renderer
/// as an OSC 133 shell-integration zone around the row's cells. Marks are row
/// metadata like soft-wrap flags: they
/// ride along with single-row blits and never touch cell content.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RowMark {
	/// First row of a prompt zone: `OSC 133;A` precedes the row.
	PromptStart,
	/// Last row of a prompt zone: `OSC 133;B`, `133;C`, and `133;D;0`
	/// follow the row, closing the zone within the same paint.
	PromptEnd,
}

/// A complete declarative terminal viewport.
///
/// Each frame owns a fixed cell grid. Wide graphemes reserve continuation
/// cells, so overwriting either half cannot leave a stale terminal cell behind.
#[derive(Clone, Debug)]
pub struct Frame {
	size:            Size,
	cells:           Vec<Cell>,
	decors:          Vec<Decor>,
	noselect:        Vec<Rect>,
	cursor:          Option<(u16, u16)>,
	may_have_images: bool,
	source_id:       u64,
	revision:        u64,
	/// Soft row boundaries: bit `y` set means row `y` wraps onto row
	/// `y + 1` mid-word, forming one logical line broken only by width.
	soft_wraps:      SmolBitmap,
	/// Rows carrying [`RowMark::PromptStart`].
	prompt_starts:   SmolBitmap,
	/// Rows carrying [`RowMark::PromptEnd`].
	prompt_ends:     SmolBitmap,
}

impl Frame {
	/// Creates a blank frame using the terminal's default colors.
	pub fn new(size: Size) -> Self {
		Self {
			size,
			cells: vec![Cell::blank(Style::default()); size.area()],
			decors: Vec::new(),
			noselect: Vec::new(),
			cursor: None,
			may_have_images: false,
			source_id: NEXT_FRAME_ID.fetch_add(1, Ordering::Relaxed),
			revision: 0,
			soft_wraps: SmolBitmap::new(),
			prompt_starts: SmolBitmap::new(),
			prompt_ends: SmolBitmap::new(),
		}
	}

	/// Changes the document height, preserving retained rows and filling growth
	/// with styled blanks.
	pub fn resize_height(&mut self, height: u16, style: Style) {
		if height == self.size.height {
			return;
		}
		self.touch();
		let area = usize::from(self.size.width).saturating_mul(usize::from(height));
		self.cells.resize(area, Cell::blank(style));
		if height < self.size.height {
			self
				.decors
				.retain(|decor| decor.rect.y.saturating_add(decor.rect.height) <= height);
			self
				.noselect
				.retain(|rect| rect.y.saturating_add(rect.height) <= height);
		}
		// Boundary flags at and beyond the new final row are meaningless;
		// drop them so a later regrowth cannot resurrect stale joins.
		let first_invalid = usize::from(height.saturating_sub(1));
		self.soft_wraps.retain(|index| index < first_invalid);
		let rows = usize::from(height);
		self.prompt_starts.retain(|index| index < rows);
		self.prompt_ends.retain(|index| index < rows);
		self.size.height = height;
		if self.cursor.is_some_and(|(_, y)| y >= height) {
			self.cursor = None;
		}
	}

	/// Flags row `y` as soft-wrapping onto row `y + 1`: the pair is one
	/// logical line broken only by the frame width. The renderer joins the
	/// boundary with terminal autowrap so native selection copies it
	/// unbroken.
	///
	/// The flag is a certification the renderer cannot re-verify: the
	/// caller MUST guarantee the row's source content exactly fills every
	/// column — a written trailing space counts (it is stored as a blank
	/// cell, indistinguishable from padding), layout padding never does.
	/// Painters gate on their recorded row width before flagging.
	///
	/// Ignored unless both rows exist. Cleared by [`Frame::clear`],
	/// [`Frame::resize_height`] shrinkage, [`Frame::fill`], rewritten by
	/// [`Frame::blit`], and reset by every rebuild — the flag is layout
	/// metadata, not cell content.
	pub fn set_soft_wrap(&mut self, y: u16) {
		if y.saturating_add(1) >= self.size.height {
			return;
		}
		self.touch();
		self.soft_wraps.insert(usize::from(y));
	}

	/// Whether row `y` was flagged as soft-wrapping onto row `y + 1`.
	#[inline]
	pub fn soft_wrap(&self, y: u16) -> bool {
		y.saturating_add(1) < self.size.height && self.soft_wraps.get(usize::from(y))
	}

	/// Marks row `y` with a semantic zone boundary. Rows outside the frame
	/// are ignored. Marks are metadata: they do not change cell content.
	pub fn mark_row(&mut self, y: u16, mark: RowMark) {
		if y >= self.size.height {
			return;
		}
		self.touch();
		self.marks_mut(mark).insert(usize::from(y));
	}

	/// Whether row `y` carries `mark`.
	#[inline]
	pub fn row_mark(&self, y: u16, mark: RowMark) -> bool {
		y < self.size.height && self.marks(mark).get(usize::from(y))
	}

	const fn marks(&self, mark: RowMark) -> &SmolBitmap {
		match mark {
			RowMark::PromptStart => &self.prompt_starts,
			RowMark::PromptEnd => &self.prompt_ends,
		}
	}

	const fn marks_mut(&mut self, mark: RowMark) -> &mut SmolBitmap {
		match mark {
			RowMark::PromptStart => &mut self.prompt_starts,
			RowMark::PromptEnd => &mut self.prompt_ends,
		}
	}

	/// Drops every row mark on rows `[top, bottom)`.
	fn clear_row_marks(&mut self, top: u16, bottom: u16) {
		for index in usize::from(top)..usize::from(bottom.min(self.size.height)) {
			self.prompt_starts.set(index, false);
			self.prompt_ends.set(index, false);
		}
	}

	#[inline]
	const fn touch(&mut self) {
		self.revision = self.revision.wrapping_add(1);
	}

	#[inline]
	pub(crate) const fn source_stamp(&self) -> (u64, u64) {
		(self.source_id, self.revision)
	}

	#[inline]
	pub(crate) const fn may_have_images(&self) -> bool {
		self.may_have_images
	}

	/// Returns the frame dimensions.
	pub const fn size(&self) -> Size {
		self.size
	}

	/// Adds a native-decoration primitive for pixel presenters; the terminal
	/// renderer ignores it.
	pub fn push_decor(&mut self, decor: Decor) {
		self.touch();
		self.decors.push(decor);
	}

	/// Returns native-decoration primitives for pixel presenters; the terminal
	/// renderer ignores them.
	pub fn decors(&self) -> &[Decor] {
		&self.decors
	}

	/// Marks a region whose text is excluded from host-driven selection
	/// and copy (status bars, HUD chrome). The terminal renderer ignores
	/// it — a terminal emulator's native selection cannot honor it.
	pub fn push_noselect(&mut self, rect: Rect) {
		self.touch();
		self.noselect.push(rect);
	}

	/// Regions excluded from host-driven text selection.
	pub fn noselect(&self) -> &[Rect] {
		&self.noselect
	}

	/// Whether the cell at `(x, y)` participates in host text selection.
	pub fn selectable(&self, x: u16, y: u16) -> bool {
		!self
			.noselect
			.iter()
			.any(|rect| x >= rect.x && x < rect.right() && y >= rect.y && y < rect.bottom())
	}

	/// Places the terminal's hardware cursor at a document cell.
	///
	/// The renderer hides the cursor when this cell falls outside the live
	/// viewport.
	pub const fn set_cursor(&mut self, x: u16, y: u16) {
		self.touch();
		self.cursor = Some((x, y));
	}

	/// Removes the terminal/native hardware cursor from this frame.
	pub const fn clear_cursor(&mut self) {
		self.touch();
		self.cursor = None;
	}

	/// Replaces every cell with a styled blank.
	pub fn clear(&mut self, style: Style) {
		self.touch();
		self.cells.fill(Cell::blank(style));
		self.cursor = None;
		self.decors.clear();
		self.noselect.clear();
		self.soft_wraps.clear();
		self.prompt_starts.clear();
		self.prompt_ends.clear();
	}

	/// Fills a clipped rectangle with styled blanks.
	pub fn fill(&mut self, rect: Rect, style: Style) {
		let left = rect.x.min(self.size.width);
		let right = rect.right().min(self.size.width);
		let top = rect.y.min(self.size.height);
		let bottom = rect.bottom().min(self.size.height);
		if left >= right || top >= bottom {
			return;
		}
		self.touch();
		let fill_rect = Rect::new(left, top, right - left, bottom - top);
		self
			.decors
			.retain(|decor| !fill_rect.contains_rect(decor.rect));
		self.noselect.retain(|rect| !fill_rect.contains_rect(*rect));
		// Blanking any part of a row invalidates its exact joinability;
		// painters re-flag when they redraw.
		self.clear_soft_wraps_touching(top, bottom);
		// A full-width blank retires the row's zone marks the same way;
		// a partial blank keeps them, since the marked content survives.
		if left == 0 && right == self.size.width {
			self.clear_row_marks(top, bottom);
		}

		let blank = Cell::blank(style);
		for y in top..bottom {
			self.clear_glyph_at(left, y);
			if right - left > 1 {
				self.clear_glyph_at(right - 1, y);
			}
			let start = self.index(left, y);
			let end = self.index(right - 1, y) + 1;
			self.cells[start..end].fill(blank.clone());
		}
	}

	/// Paints `color` behind a clipped rectangle: cells still on the
	/// terminal's default background adopt it, cells that named their own
	/// keep it. Runs after a subtree paints, so glyph styles — which
	/// replace the whole cell — never punch holes in a container's fill.
	pub fn underlay(&mut self, rect: Rect, color: Color) {
		self.touch();
		let right = rect.right().min(self.size.width);
		let bottom = rect.bottom().min(self.size.height);
		for y in rect.y.min(self.size.height)..bottom {
			for x in rect.x.min(self.size.width)..right {
				let index = self.index(x, y);
				if self.cells[index].style.background == Color::Default {
					self.cells[index].style.background = color;
				}
			}
		}
	}

	/// Recolors one cell's foreground in place — the chrome-glow primitive:
	/// composite passes shift color without re-shaping glyphs.
	pub(crate) fn recolor_fg(&mut self, x: u16, y: u16, recolor: impl FnOnce(Color) -> Color) {
		if x >= self.size.width || y >= self.size.height {
			return;
		}
		self.touch();
		let index = self.index(x, y);
		let style = &mut self.cells[index].style;
		style.foreground = recolor(style.foreground);
	}

	/// Paints a gradient behind cells that did not name their own background.
	pub(crate) fn underlay_gradient(&mut self, rect: Rect, gradient: Gradient, bounds: Rect) {
		self.touch();
		let projection = gradient.projection(bounds);
		let right = rect.right().min(self.size.width);
		let bottom = rect.bottom().min(self.size.height);
		for y in rect.y.min(self.size.height)..bottom {
			let mut x = rect.x.min(self.size.width);
			while x < right {
				let index = self.index(x, y);
				let width = match &self.cells[index].content {
					CellContent::Blank => 1,
					CellContent::Grapheme { width, .. } => *width,
					CellContent::Image { .. } => 1,
					CellContent::Continuation => {
						x += 1;
						continue;
					},
				};
				if self.cells[index].style.background == Color::Default {
					let color = projection.color_at(x, y);
					let end = x.saturating_add(width).min(right);
					for column in x..end {
						let index = self.index(column, y);
						if self.cells[index].style.background == Color::Default {
							self.cells[index].style.background = color;
						}
					}
				}
				x = x.saturating_add(width.max(1));
			}
		}
	}

	/// Tints visible glyphs that inherit their foreground from this node.
	pub(crate) fn gradient_foreground(&mut self, rect: Rect, gradient: Gradient, bounds: Rect) {
		self.touch();
		let projection = gradient.projection(bounds);
		let right = rect.right().min(self.size.width);
		let bottom = rect.bottom().min(self.size.height);
		for y in rect.y.min(self.size.height)..bottom {
			let mut x = rect.x.min(self.size.width);
			while x < right {
				let index = self.index(x, y);
				let (width, visible) = match &self.cells[index].content {
					CellContent::Blank => (1, false),
					CellContent::Grapheme { text, width } => (*width, text != " "),
					CellContent::Image { .. } => (1, true),
					CellContent::Continuation => {
						x += 1;
						continue;
					},
				};
				if visible && self.cells[index].style.foreground == Color::Default {
					let color = projection.color_at(x, y);
					let end = x.saturating_add(width).min(right);
					for column in x..end {
						let index = self.index(column, y);
						if self.cells[index].style.foreground == Color::Default {
							self.cells[index].style.foreground = color;
						}
					}
				}
				x = x.saturating_add(width.max(1));
			}
		}
	}

	/// Places one typed Kitty image cell.
	pub fn put_image_cell(
		&mut self,
		x: u16,
		y: u16,
		id: u32,
		row: u16,
		col: u16,
		rows: u16,
		cols: u16,
	) {
		if x >= self.size.width || y >= self.size.height {
			return;
		}
		self.touch();
		self.may_have_images = true;
		self.clear_glyph_at(x, y);
		let index = self.index(x, y);
		self.cells[index] = Cell {
			content: CellContent::Image { id, row, col, rows, cols },
			style:   Style::default(),
		};
	}

	/// Draws printable graphemes until a newline or the right frame edge.
	///
	/// Control characters are ignored. A wide grapheme that would be clipped is
	/// omitted rather than leaving a half-cell artifact.
	pub fn put(&mut self, x: u16, y: u16, text: &str, style: Style) -> u16 {
		let width = self.size.width.saturating_sub(x);
		self.put_clipped(x, y, width, text, style)
	}

	/// Draws printable graphemes within `width` cells.
	///
	/// The cell bound is also clipped to the frame edge. A wide grapheme that
	/// crosses either bound is omitted rather than leaving a half-cell artifact.
	pub fn put_clipped(&mut self, x: u16, y: u16, width: u16, text: &str, style: Style) -> u16 {
		if y >= self.size.height {
			return x;
		}
		self.touch();

		let right = x.saturating_add(width).min(self.size.width);
		let mut column = x;
		if text.is_ascii() {
			for &byte in text.as_bytes() {
				if matches!(byte, b'\n' | b'\r') {
					break;
				}
				if byte.is_ascii_control() {
					continue;
				}
				if column >= right {
					break;
				}
				self.set_ascii(column, y, byte, style);
				column += 1;
			}
			return column;
		}
		if let Some(character) = text
			.chars()
			.next()
			.filter(|character| character.len_utf8() == text.len())
		{
			if character.is_control() {
				return column;
			}
			let glyph_width = cell_width(text);
			if glyph_width == 0 || column >= right || glyph_width > right - column {
				return column;
			}
			self.set_grapheme(column, y, text, glyph_width, style);
			return column + glyph_width;
		}

		for grapheme in text.graphemes() {
			if grapheme == "\n" || grapheme == "\r" {
				break;
			}
			if grapheme.chars().any(char::is_control) {
				continue;
			}

			let width = cell_width(grapheme);
			if width == 0 {
				continue;
			}
			if column >= right || width > right - column {
				break;
			}

			self.set_grapheme(column, y, grapheme, width, style);
			column += width;
		}
		column
	}

	/// The hardware-cursor anchor cell, if the document placed one.
	pub const fn cursor(&self) -> Option<(u16, u16)> {
		self.cursor
	}

	/// The cell at (`x`, `y`); out-of-bounds coordinates panic.
	#[inline(always)]
	pub fn cell(&self, x: u16, y: u16) -> &Cell {
		&self.cells[self.index(x, y)]
	}

	#[inline(always)]
	pub(super) fn cell_or<'a>(&'a self, row: u16, column: u16, blank: &'a Cell) -> &'a Cell {
		if row >= self.size.height || column >= self.size.width {
			blank
		} else {
			self.cell(column, row)
		}
	}

	pub(crate) fn same_grid(&self, other: &Self) -> bool {
		self.size == other.size
			&& self.cursor == other.cursor
			&& self.soft_wraps == other.soft_wraps
			&& self.prompt_starts == other.prompt_starts
			&& self.prompt_ends == other.prompt_ends
			&& self.cells == other.cells
	}

	pub(super) fn row_equals(&self, row: u16, other: &Self, other_row: u16) -> bool {
		if self.size.width != other.size.width
			|| row >= self.size.height
			|| other_row >= other.size.height
		{
			return false;
		}
		let width = usize::from(self.size.width);
		let start = usize::from(row) * width;
		let other_start = usize::from(other_row) * width;
		self.cells[start..start + width] == other.cells[other_start..other_start + width]
			&& self.soft_wrap(row) == other.soft_wrap(other_row)
			&& self.row_mark(row, RowMark::PromptStart)
				== other.row_mark(other_row, RowMark::PromptStart)
			&& self.row_mark(row, RowMark::PromptEnd) == other.row_mark(other_row, RowMark::PromptEnd)
	}

	/// Copies one row's cells from `src` (same width required). The
	/// damage-snapshot primitive: presenters copy only rows a caller
	/// reported dirty instead of cloning the whole grid.
	pub(crate) fn copy_row_from(&mut self, src: &Self, row: u16) {
		if row >= self.size.height || row >= src.size.height || self.size.width != src.size.width {
			return;
		}
		self.touch();
		let width = usize::from(self.size.width);
		let start = usize::from(row) * width;
		self.cells[start..start + width].clone_from_slice(&src.cells[start..start + width]);
		self.may_have_images |= src.may_have_images;
	}

	/// Mirrors `src`'s soft-wrap boundary flags wholesale — the snapshot
	/// primitive for damage-based presenters: flags are layout metadata
	/// that can change on rows no cell damage covers.
	pub(crate) fn sync_soft_wraps(&mut self, src: &Self) {
		if self.soft_wraps != src.soft_wraps {
			self.touch();
			self.soft_wraps.clone_from(&src.soft_wraps);
		}
		if self.prompt_starts != src.prompt_starts || self.prompt_ends != src.prompt_ends {
			self.touch();
			self.prompt_starts.clone_from(&src.prompt_starts);
			self.prompt_ends.clone_from(&src.prompt_ends);
		}
	}

	/// Copies a cell region from `src` into this frame — the scroll
	/// viewport blit, and the way an embedder composites a sub-document
	/// (e.g. a [`crate::Ui`]-rendered message) into a hand-painted frame.
	/// `src` rows `[src_top, src_top + rows)` land at `(dst_x, dst_y)`,
	/// clipped to both frames. Wide glyphs whose lead cell falls outside
	/// the copied span degrade to blanks rather than leaving orphan
	/// continuations.
	/// A cursor set on `src` inside the copied region is translated into
	/// this frame's coordinates; outside it, this frame's cursor is kept.
	pub fn blit(&mut self, src: &Self, src_top: u16, rows: u16, dst_x: u16, dst_y: u16) {
		self.touch();
		let width = src.size.width.min(self.size.width.saturating_sub(dst_x));
		if let Some((cx, cy)) = src.cursor
			&& cx < width
			&& cy >= src_top
			&& cy < src_top.saturating_add(rows)
		{
			let to_y = dst_y.saturating_add(cy - src_top);
			if to_y < self.size.height {
				self.cursor = Some((dst_x.saturating_add(cx), to_y));
			}
		}
		let mut copied = 0u16;
		for row in 0..rows {
			let from_y = src_top.saturating_add(row);
			let to_y = dst_y.saturating_add(row);
			if from_y >= src.size.height || to_y >= self.size.height {
				break;
			}
			copied = row + 1;
			let mut x = 0u16;
			while x < width {
				let cell = src.cell(x, from_y);
				match &cell.content {
					CellContent::Blank => {
						let style = cell.style;
						self.clear_glyph_at(dst_x + x, to_y);
						let index = self.index(dst_x + x, to_y);
						self.cells[index] = Cell::blank(style);
						x += 1;
					},
					CellContent::Grapheme { text, width: glyph_w } => {
						if x + glyph_w <= width {
							let text = text.clone();
							let style = cell.style;
							let w = *glyph_w;
							self.set_grapheme(dst_x + x, to_y, &text, w, style);
							x += w;
						} else {
							let style = cell.style;
							let index = self.index(dst_x + x, to_y);
							self.clear_glyph_at(dst_x + x, to_y);
							self.cells[index] = Cell::blank(style);
							x += 1;
						}
					},
					CellContent::Image { id, row, col, rows, cols } => {
						self.put_image_cell(dst_x + x, to_y, *id, *row, *col, *rows, *cols);
						x += 1;
					},
					CellContent::Continuation => {
						// lead cell was left of the copy origin: blank
						let style = cell.style;
						self.clear_glyph_at(dst_x + x, to_y);
						let index = self.index(dst_x + x, to_y);
						self.cells[index] = Cell::blank(style);
						x += 1;
					},
				}
			}
		}
		if width > 0 && copied > 0 {
			let destination = Rect::new(dst_x, dst_y, width, copied);
			self
				.decors
				.retain(|decor| !destination.contains_rect(decor.rect));
			self
				.noselect
				.retain(|rect| !destination.contains_rect(*rect));
			let source_band = Rect::new(0, src_top, src.size.width, rows);
			let translate = |rect: Rect| {
				Rect::new(
					rect.x.saturating_add(dst_x),
					dst_y.saturating_add(rect.y.saturating_sub(src_top)),
					rect.width,
					rect.height,
				)
			};
			self.decors.extend(
				src.decors
					.iter()
					.filter(|decor| source_band.contains_rect(decor.rect))
					.cloned()
					.map(|mut decor| {
						decor.rect = translate(decor.rect);
						decor
					}),
			);
			self.noselect.extend(
				src.noselect
					.iter()
					.filter(|rect| source_band.contains_rect(**rect))
					.map(|rect| translate(*rect)),
			);
		}
		// Wrap boundaries: a full-width copy carries its interior
		// boundaries; anything else conservatively hardens the touched
		// rows, since exact joinability cannot survive a partial rewrite.
		self.clear_soft_wraps_touching(dst_y, dst_y.saturating_add(copied));
		let full_width = dst_x == 0 && width == self.size.width && width == src.size.width;
		if full_width {
			for offset in 0..copied.saturating_sub(1) {
				if src.soft_wrap(src_top.saturating_add(offset)) {
					self.set_soft_wrap(dst_y.saturating_add(offset));
				}
			}
			// A full-width copy replaces the rows' zone marks outright.
			self.clear_row_marks(dst_y, dst_y.saturating_add(copied));
		}
		// Zone marks are row metadata, so every copied row carries them —
		// including the single-row blits that retire history.
		for offset in 0..copied {
			let from_y = src_top.saturating_add(offset);
			let to_y = dst_y.saturating_add(offset);
			for mark in [RowMark::PromptStart, RowMark::PromptEnd] {
				if src.row_mark(from_y, mark) {
					self.mark_row(to_y, mark);
				}
			}
		}
	}

	/// Drops every wrap boundary touching rows `[top, bottom)`: bit `y`
	/// spans rows `y` and `y + 1`, so the range widens one row upward.
	fn clear_soft_wraps_touching(&mut self, top: u16, bottom: u16) {
		for index in usize::from(top.saturating_sub(1))..usize::from(bottom.min(self.size.height)) {
			self.soft_wraps.set(index, false);
		}
	}

	#[inline(always)]
	fn index(&self, x: u16, y: u16) -> usize {
		usize::from(y) * usize::from(self.size.width) + usize::from(x)
	}

	#[inline(always)]
	fn set_ascii(&mut self, x: u16, y: u16, byte: u8, style: Style) {
		let lead = self.index(x, y);
		let existing = &self.cells[lead];
		if existing.style == style {
			match &existing.content {
				CellContent::Blank if byte == b' ' => return,
				CellContent::Grapheme { text, width: 1 }
					if text.len() == 1 && text.as_bytes()[0] == byte =>
				{
					return;
				},
				_ => {},
			}
		}
		if !matches!(
			&self.cells[lead].content,
			CellContent::Blank | CellContent::Grapheme { width: 1, .. } | CellContent::Image { .. }
		) {
			self.clear_glyph_at(x, y);
		}
		let content = if byte == b' ' {
			CellContent::Blank
		} else {
			let bytes = [byte];
			// SAFETY: `byte` came from a string already known to be ASCII.
			let text = unsafe { str::from_utf8_unchecked(&bytes) };
			CellContent::Grapheme { text: Str::new_inline(text), width: 1 }
		};
		self.cells[lead] = Cell { content, style };
	}

	fn set_grapheme(&mut self, x: u16, y: u16, grapheme: &str, width: u16, style: Style) {
		if width == 1 {
			let lead = self.index(x, y);
			let existing = &self.cells[lead];
			if existing.style == style {
				match &existing.content {
					CellContent::Blank if grapheme == " " => return,
					CellContent::Grapheme { text, width: 1 } if text == grapheme => return,
					_ => {},
				}
			}
			if !matches!(
				&self.cells[lead].content,
				CellContent::Blank | CellContent::Grapheme { width: 1, .. } | CellContent::Image { .. }
			) {
				self.clear_glyph_at(x, y);
			}
			let content = if grapheme == " " {
				CellContent::Blank
			} else {
				CellContent::Grapheme { text: Str::new(grapheme), width }
			};
			self.cells[lead] = Cell { content, style };
			return;
		}

		for column in x..x + width {
			self.clear_glyph_at(column, y);
		}

		let lead = self.index(x, y);
		self.cells[lead] =
			Cell { content: CellContent::Grapheme { text: Str::new(grapheme), width }, style };
		for column in x + 1..x + width {
			let index = self.index(column, y);
			self.cells[index] = Cell { content: CellContent::Continuation, style };
		}
	}

	fn clear_glyph_at(&mut self, x: u16, y: u16) {
		let mut start = x;
		while start > 0 && matches!(self.cell(start, y).content, CellContent::Continuation) {
			start -= 1;
		}

		let span = match self.cell(start, y).content {
			CellContent::Blank => 1,
			CellContent::Grapheme { width, .. } => width,
			CellContent::Image { .. } => 1,
			CellContent::Continuation => 1,
		};
		let end = start.saturating_add(span).min(self.size.width);
		for column in start..end {
			let index = self.index(column, y);
			let style = self.cells[index].style;
			self.cells[index] = Cell::blank(style);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::{
		CellContent, Color, Decor, DecorFill, DecorKind, Frame, Rect, RowMark, Size, Style,
	};
	use crate::{
		context::JamoWidth,
		rich::{jamo_width, set_jamo_width},
	};

	fn decor(rect: Rect) -> Decor {
		Decor {
			rect,
			kind: DecorKind::Fill { fill: DecorFill::Solid(Color::Default), rounded: false },
		}
	}
	#[test]
	fn luminance_and_contrast_label_follow_git_control_math() {
		assert!((Color::Rgb(255, 255, 255).luminance() - 1.0).abs() < f32::EPSILON);
		assert!((Color::Rgb(255, 0, 0).luminance() - 0.2126).abs() < 0.000_001);
		assert_eq!(
			Color::Rgb(200, 220, 240).contrast_label(),
			Color::Rgb(36, 40, 43),
			"light fills blend 82% toward black"
		);
		assert_eq!(
			Color::Rgb(20, 40, 60).contrast_label(),
			Color::Rgb(236, 238, 239),
			"dark fills blend 92% toward white"
		);
		assert_eq!(Color::Default.contrast_label(), Color::Default);
		assert_eq!(Color::Indexed(255).contrast_label(), Color::Indexed(16));
		assert_eq!(Color::Indexed(233).contrast_label(), Color::Indexed(231));
	}

	#[test]
	fn overwriting_wide_grapheme_clears_its_continuation() {
		let mut frame = Frame::new(Size::new(4, 1));
		frame.put(0, 0, "界", Style::default());
		frame.put(0, 0, "a", Style::default());

		assert!(matches!(frame.cell(1, 0).content, CellContent::Blank));
	}

	#[test]
	fn frame_reserves_jamo_with_the_active_terminal_policy() {
		let original = jamo_width();
		set_jamo_width(JamoWidth::Wide);
		let mut wide = Frame::new(Size::new(4, 1));
		let wide_end = wide.put(0, 0, "\u{3131}x", Style::default());
		let wide_continuation = matches!(wide.cell(1, 0).content, CellContent::Continuation);

		set_jamo_width(JamoWidth::Narrow);
		let mut narrow = Frame::new(Size::new(4, 1));
		let narrow_end = narrow.put(0, 0, "\u{3131}x", Style::default());
		let narrow_x = matches!(
			narrow.cell(1, 0).content,
			CellContent::Grapheme { ref text, width: 1 } if text == "x"
		);
		set_jamo_width(original);

		assert_eq!(wide_end, 3);
		assert!(wide_continuation);
		assert_eq!(narrow_end, 2);
		assert!(narrow_x);
	}

	#[test]
	fn clipped_wide_grapheme_is_not_drawn() {
		let mut frame = Frame::new(Size::new(2, 1));
		let end = frame.put(1, 0, "界", Style::default());

		assert_eq!(end, 1);
		assert!(frame.cell(1, 0).is_default_blank());
	}

	#[test]
	fn clipped_text_preserves_cells_beyond_its_bound() {
		let mut frame = Frame::new(Size::new(4, 1));
		frame.put(0, 0, "xxxx", Style::default());
		let end = frame.put_clipped(1, 0, 2, "ab界", Style::default());

		assert_eq!(end, 3);
		assert!(matches!(
			frame.cell(3, 0).content,
			CellContent::Grapheme { ref text, width: 1 } if text == "x"
		));
	}

	#[test]
	fn ascii_text_skips_controls_and_clips_without_unicode_segmentation() {
		let mut frame = Frame::new(Size::new(4, 1));
		let end = frame.put_clipped(0, 0, 3, "a\tbcd", Style::default());

		assert_eq!(end, 3);
		assert!(matches!(
			frame.cell(2, 0).content,
			CellContent::Grapheme { ref text, width: 1 } if text == "c"
		));
		assert!(frame.cell(3, 0).is_default_blank());
	}
	#[test]
	fn resizing_height_preserves_rows_and_initializes_growth() {
		let mut frame = Frame::new(Size::new(3, 1));
		frame.put(0, 0, "a", Style::default());
		let fill = Style::new().bold();

		frame.resize_height(3, fill);

		assert!(matches!(
			frame.cell(0, 0).content,
			CellContent::Grapheme { ref text, width: 1 } if text == "a"
		));
		assert_eq!(frame.cell(0, 2).style, fill);
		frame.set_cursor(0, 2);
		frame.resize_height(1, Style::default());
		assert_eq!(frame.cursor(), None);
	}

	#[test]
	fn push_decor_bumps_revision() {
		let mut frame = Frame::new(Size::new(4, 4));
		let (_, before) = frame.source_stamp();

		frame.push_decor(decor(Rect::new(1, 1, 2, 2)));

		let (_, after) = frame.source_stamp();
		assert_eq!(after, before.wrapping_add(1));
	}

	#[test]
	fn soft_wrap_flags_are_layout_metadata() {
		let mut frame = Frame::new(Size::new(4, 3));
		frame.set_soft_wrap(0);
		frame.set_soft_wrap(2);
		assert!(frame.soft_wrap(0));
		assert!(!frame.soft_wrap(2), "a flag without a following row is ignored");

		let mut other = frame.clone();
		assert!(frame.row_equals(0, &other, 0));
		other.clear(Style::default());
		assert!(!other.soft_wrap(0), "clear drops boundary flags");
		assert!(!frame.row_equals(0, &other, 0), "row equality includes the boundary bit");

		frame.resize_height(1, Style::default());
		assert!(!frame.soft_wrap(0), "shrinking drops stale flags");
		frame.resize_height(3, Style::default());
		assert!(!frame.soft_wrap(0), "regrowth does not resurrect them");
	}

	#[test]
	fn fill_clears_wrap_boundaries_it_touches() {
		let mut frame = Frame::new(Size::new(4, 4));
		frame.set_soft_wrap(0);
		frame.set_soft_wrap(2);
		// Filling row 3 also drops the boundary reaching it from row 2,
		// while the untouched pair above keeps its flag.
		frame.fill(Rect::new(0, 3, 4, 1), Style::default());
		assert!(frame.soft_wrap(0));
		assert!(!frame.soft_wrap(2));
	}

	#[test]
	fn fill_drops_contained_decor_and_keeps_enclosing_decor() {
		let mut frame = Frame::new(Size::new(8, 8));
		let contained = decor(Rect::new(3, 3, 2, 2));
		let enclosing = decor(Rect::new(1, 1, 6, 6));
		frame.push_decor(contained);
		frame.push_decor(enclosing.clone());

		frame.fill(Rect::new(2, 2, 4, 4), Style::default());

		assert_eq!(frame.decors(), &[enclosing]);
	}

	#[test]
	fn blit_carries_full_width_wrap_boundaries_and_hardens_partial_copies() {
		let mut source = Frame::new(Size::new(4, 3));
		source.put(0, 0, "abcd", Style::default());
		source.put(0, 1, "ef", Style::default());
		source.set_soft_wrap(0);

		let mut full = Frame::new(Size::new(4, 4));
		full.set_soft_wrap(2);
		full.blit(&source, 0, 3, 0, 1);
		assert!(full.soft_wrap(1), "a full-width blit carries interior boundaries");
		assert!(!full.soft_wrap(2), "boundaries under the copy are replaced, not kept");

		let mut partial = Frame::new(Size::new(6, 4));
		partial.set_soft_wrap(1);
		partial.blit(&source, 0, 3, 1, 1);
		assert!(!partial.soft_wrap(1), "an offset copy hardens the rows it rewrites");
	}

	#[test]
	fn prompt_zone_marks_first_and_last_rows() {
		let mut frame = Frame::new(Size::new(4, 5));
		frame.mark_row(1, RowMark::PromptStart);
		frame.mark_row(3, RowMark::PromptEnd);
		frame.mark_row(9, RowMark::PromptEnd);
		assert!(frame.row_mark(1, RowMark::PromptStart));
		assert!(!frame.row_mark(1, RowMark::PromptEnd));
		assert!(frame.row_mark(3, RowMark::PromptEnd));
		assert!(!frame.row_mark(9, RowMark::PromptEnd), "marks outside the frame are ignored");

		// Single-row blits (history retirement) carry the marks with the row.
		let mut start = Frame::new(Size::new(4, 1));
		start.blit(&frame, 1, 1, 0, 0);
		assert!(start.row_mark(0, RowMark::PromptStart));
		assert!(!start.row_mark(0, RowMark::PromptEnd));
		let mut end = Frame::new(Size::new(4, 1));
		end.blit(&frame, 3, 1, 0, 0);
		assert!(end.row_mark(0, RowMark::PromptEnd));
		let mut middle = Frame::new(Size::new(4, 1));
		middle.mark_row(0, RowMark::PromptStart);
		middle.blit(&frame, 2, 1, 0, 0);
		assert!(!middle.row_mark(0, RowMark::PromptStart), "a full-width copy replaces marks");

		// Row equality sees marks so damage diffing re-emits a marked row.
		let plain = Frame::new(Size::new(4, 5));
		assert!(!frame.row_equals(1, &plain, 1));
		assert!(frame.row_equals(2, &plain, 2));

		// A full-width fill retires the marks; clear drops them all.
		frame.fill(Rect::new(0, 1, 4, 1), Style::default());
		assert!(!frame.row_mark(1, RowMark::PromptStart));
		frame.fill(Rect::new(1, 3, 2, 1), Style::default());
		assert!(frame.row_mark(3, RowMark::PromptEnd), "a partial fill keeps the row's mark");
		frame.resize_height(3, Style::default());
		assert!(!frame.row_mark(3, RowMark::PromptEnd), "shrinking drops stale marks");
		frame.mark_row(0, RowMark::PromptStart);
		frame.clear(Style::default());
		assert!(!frame.row_mark(0, RowMark::PromptStart));
	}

	#[test]
	fn blit_translates_source_decor_and_drops_destination_decor() {
		let mut source = Frame::new(Size::new(8, 6));
		source.push_decor(decor(Rect::new(1, 2, 2, 1)));
		let mut destination = Frame::new(Size::new(12, 8));
		destination.push_decor(decor(Rect::new(5, 2, 1, 1)));

		destination.blit(&source, 2, 3, 4, 1);

		assert_eq!(destination.decors(), &[decor(Rect::new(5, 1, 2, 1))]);
	}

	#[test]
	fn noselect_regions_follow_fill_and_blit_lifecycle() {
		let mut frame = Frame::new(Size::new(8, 8));
		frame.push_noselect(Rect::new(3, 3, 2, 2));
		frame.push_noselect(Rect::new(1, 1, 6, 6));
		assert!(!frame.selectable(3, 3));
		assert!(frame.selectable(0, 0));

		frame.fill(Rect::new(2, 2, 4, 4), Style::default());
		assert_eq!(frame.noselect(), &[Rect::new(1, 1, 6, 6)], "contained mark drops");

		let mut source = Frame::new(Size::new(8, 6));
		source.push_noselect(Rect::new(1, 2, 2, 1));
		let mut destination = Frame::new(Size::new(12, 8));
		destination.push_noselect(Rect::new(5, 2, 1, 1));
		destination.blit(&source, 2, 3, 4, 1);
		assert_eq!(destination.noselect(), &[Rect::new(5, 1, 2, 1)], "marks translate like decors");
	}
	#[test]
	fn blit_translates_cursor_from_copied_region() {
		let mut source = Frame::new(Size::new(8, 6));
		source.set_cursor(3, 4);
		let mut destination = Frame::new(Size::new(12, 8));

		destination.blit(&source, 2, 3, 5, 1);

		assert_eq!(destination.cursor(), Some((8, 3)));
	}

	#[test]
	fn blit_keeps_cursor_when_source_cursor_cannot_be_copied() {
		let mut source = Frame::new(Size::new(8, 6));
		let mut destination = Frame::new(Size::new(6, 4));
		destination.set_cursor(1, 1);

		source.set_cursor(6, 3);
		destination.blit(&source, 2, 3, 2, 0);
		assert_eq!(destination.cursor(), Some((1, 1)), "cursor past copied width");

		source.set_cursor(2, 5);
		destination.blit(&source, 2, 3, 0, 0);
		assert_eq!(destination.cursor(), Some((1, 1)), "cursor past copied rows");

		source.set_cursor(2, 3);
		destination.blit(&source, 2, 2, 0, 3);
		assert_eq!(destination.cursor(), Some((1, 1)), "translated cursor past destination height");
	}
}
