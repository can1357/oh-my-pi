use std::{
	collections::{BTreeMap, btree_map::Entry},
	env,
	fmt::Write as _,
	io::{self, Write},
	mem,
	path::Path,
	ptr,
};

use omp_core::{CowBytes, Str};
use smallvec::SmallVec;

use crate::{
	Graphics, TerminalCaps, debug,
	debug::ScreenSnapshot,
	escape::esc,
	frame::{
		Cell, CellContent, Color, Frame, LinkId, RowMark, Size, Style, Underline, with_link_url,
	},
	imagereg,
	iterm2::{Iterm2Image, Iterm2Viewport, iterm2_output},
	kitty::{
		DirectPlacement, append_delete_image, append_direct_placement, append_placement,
		append_tmux_passthrough, append_transmission, placeholder_cell,
	},
	overlay::Layer,
	sixel::SixelImage,
	slots::{Delivered, WritePlan},
	terminal::{alt_screen_active, terminal_write_all},
};

const RESET_STYLE: &str = esc!(style_reset);
const SYNC_OUTPUT_BEGIN: &str = esc!(sync_output);
const SYNC_OUTPUT_END: &str = esc!(!sync_output);
const HIDE_CURSOR: &str = esc!(!cursor_visible);
const SHOW_CURSOR: &str = esc!(cursor_visible);
// ED2 must precede ED3: tmux implements ED2 by pushing the visible screen into
// pane history, so ED3-first would immediately re-poison the history it wiped.
const RESET_HISTORY: &str = esc!(cursor_home, erase_display, erase_scrollback);
// CUD clamps at the bottom without changing the user's scrollback viewport.
const VIEWPORT_BOTTOM: &str = esc!(viewport_bottom);
const DEFAULT_CELL_PIXEL_WIDTH: u16 = 9;
const DEFAULT_CELL_PIXEL_HEIGHT: u16 = 18;
#[cfg(any(windows, target_os = "linux", test))]
const MAX_CONPTY_WRITE_CHUNK_BYTES: usize = 16 * 1024;
const MAX_OUTPUT_BACKLOG_BYTES: usize = 64 * 1024 * 1024;

/// Health of the renderer's bounded terminal output queue.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OutputState {
	/// Output is still being accepted.
	Connected,
	/// Pending terminal output exceeded the safety limit.
	Disconnected,
}

#[derive(Default)]
struct OutputBacklogGuard {
	bytes: usize,
}

impl OutputBacklogGuard {
	const fn queue(&mut self, bytes: usize) -> bool {
		self.bytes = self.bytes.saturating_add(bytes);
		self.bytes > MAX_OUTPUT_BACKLOG_BYTES
	}

	const fn flushed(&mut self) {
		self.bytes = 0;
	}
}

/// Measurements from one history-neutral viewport paint.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PaintStats {
	/// Whether this replaced the complete viewport.
	pub full_repaint:  bool,
	/// Number of changed cells emitted.
	pub changed_cells: usize,
	/// Number of changed runs or complete rows emitted.
	pub runs:          usize,
	/// Number of bytes written to the terminal.
	pub bytes:         usize,
}

/// A layer with its band already resolved, ready to composite.
#[derive(Clone, Copy)]
pub struct ResolvedLayer<'a> {
	/// Source frame containing the layer cells.
	pub(crate) frame:   &'a Frame,
	/// Viewport column of the band's left edge.
	pub(crate) x:       u16,
	/// Viewport row of the band's top edge.
	pub(crate) y:       u16,
	/// First source-frame row in the band.
	pub(crate) src_top: u16,
	/// Number of source rows in the band.
	pub(crate) rows:    u16,
	/// Whether this layer owns the keyboard and hardware cursor.
	pub(crate) active:  bool,
}

struct StoredLayer {
	frame:           Frame,
	x:               u16,
	document_y:      u16,
	src_top:         u16,
	rows:            u16,
	active:          bool,
	source_address:  usize,
	source_id:       u64,
	source_revision: u64,
}

impl StoredLayer {
	#[inline(always)]
	const fn contains(&self, y: u16, x: u16) -> bool {
		y >= self.document_y
			&& y < self.document_y.saturating_add(self.rows)
			&& x >= self.x
			&& x < self.x.saturating_add(self.frame.size().width)
			&& y - self.document_y + self.src_top < self.frame.size().height
	}

	#[inline(always)]
	const fn same_cells_and_placement(&self, other: &Self) -> bool {
		self.x == other.x
			&& self.document_y == other.document_y
			&& self.src_top == other.src_top
			&& self.rows == other.rows
			&& self.source_address == other.source_address
			&& self.source_id == other.source_id
			&& self.source_revision == other.source_revision
	}
}

struct ComposedFrame<'a> {
	base:   &'a Frame,
	layers: &'a [StoredLayer],
}

impl ComposedFrame<'_> {
	#[inline(always)]
	fn cell_or<'b>(&'b self, y: u16, x: u16, blank: &'b Cell) -> &'b Cell {
		if self.layers.is_empty() {
			return self.base.cell_or(y, x, blank);
		}
		let layer = self.layer_at(y, x);
		let cell = match layer {
			Some(index) => {
				let layer = &self.layers[index];
				layer
					.frame
					.cell_or(y - layer.document_y + layer.src_top, x - layer.x, blank)
			},
			None => self.base.cell_or(y, x, blank),
		};
		match &cell.content {
			CellContent::Grapheme { width, .. } if *width > 1 => {
				let right = x.saturating_add(*width);
				if right > self.base.size().width
					|| (x..right).any(|column| self.layer_at(y, column) != layer)
				{
					blank
				} else {
					cell
				}
			},
			CellContent::Continuation => {
				let Some((head_x, width)) = self.grapheme_head(layer, y, x) else {
					return blank;
				};
				let right = head_x.saturating_add(width);
				if right > self.base.size().width
					|| (head_x..right).any(|column| self.layer_at(y, column) != layer)
				{
					blank
				} else {
					cell
				}
			},
			_ => cell,
		}
	}

	#[inline(always)]
	fn layer_at(&self, y: u16, x: u16) -> Option<usize> {
		match self.layers {
			[] => None,
			[layer] => layer.contains(y, x).then_some(0),
			layers => layers.iter().rposition(|layer| layer.contains(y, x)),
		}
	}

	fn grapheme_head(&self, layer: Option<usize>, y: u16, x: u16) -> Option<(u16, u16)> {
		let (frame, row, left) = match layer {
			Some(index) => {
				let layer = &self.layers[index];
				(&layer.frame, y - layer.document_y + layer.src_top, layer.x)
			},
			None => (self.base, y, 0),
		};
		let mut column = x;
		while column > left {
			column -= 1;
			let source_x = column - left;
			match &frame.cell(source_x, row).content {
				CellContent::Continuation => {},
				CellContent::Blank => return None,
				CellContent::Grapheme { width, .. } => return Some((column, *width)),
				CellContent::Image { .. } => return None,
			}
		}
		None
	}
}

struct FrameSegments<'a> {
	frames: &'a [Frame],
	starts: Vec<usize>,
	rows:   usize,
}

impl<'a> FrameSegments<'a> {
	fn new(frames: &'a [Frame], rows: usize) -> Self {
		let mut starts = Vec::with_capacity(frames.len());
		let mut total = 0_usize;
		for frame in frames {
			starts.push(total);
			total = total.saturating_add(usize::from(frame.size().height));
		}
		debug_assert!(rows <= total);
		Self { frames, starts, rows }
	}

	fn locate(&self, index: usize) -> (&Frame, u16) {
		debug_assert!(index < self.rows);
		let segment = self
			.starts
			.partition_point(|start| *start <= index)
			.saturating_sub(1);
		let local = index - self.starts[segment];
		(&self.frames[segment], u16::try_from(local).expect("frame-local row fits u16"))
	}
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct Window {
	top:    u16,
	height: u16,
}

#[derive(Clone, Copy)]
struct Run {
	document_y: u16,
	screen_y:   u16,
	start:      u16,
	end:        u16,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ScreenCursor {
	row: u16,
	col: u16,
}

struct RegisteredImage {
	png:            CowBytes<'static>,
	uploaded:       bool,
	placed:         SmallVec<(u16, u16), 2>,
	sixel:          Option<SixelImage>,
	sixel_decoded:  bool,
	direct_visible: bool,
}

impl RegisteredImage {
	const fn new(png: CowBytes<'static>) -> Self {
		Self {
			png,
			uploaded: false,
			placed: SmallVec::new(),
			sixel: None,
			sixel_decoded: false,
			direct_visible: false,
		}
	}
}

/// A terminal delivery failed after a known prefix of history rows.
///
/// The current row is not acknowledged when its terminal write fails. The
/// renderer is fail-stop at that point because the terminal may contain a
/// byte prefix whose row boundary cannot be recovered.
#[derive(Debug, thiserror::Error)]
#[error("terminal delivery failed after {delivered} complete history rows")]
pub struct DeliveryError {
	delivered: usize,
	#[source]
	source:    io::Error,
}

impl DeliveryError {
	/// Prefix acknowledgement to pass to [`crate::slots::Slots::commit`].
	pub const fn delivered(&self) -> Delivered {
		Delivered::Partial(self.delivered)
	}

	/// Underlying terminal writer failure.
	pub const fn source_error(&self) -> &io::Error {
		&self.source
	}
}

/// Paints one fixed-height terminal viewport and commits finalized slot rows.
///
/// [`Renderer::present`] and [`Renderer::repaint`] are history-neutral: tall
/// frames are bottom-clipped and no presentation path scrolls.
/// [`Renderer::present_plan`] is the sole transcript delivery seam and reports
/// the exact completed-row prefix on failure.
pub struct Renderer<W: Write> {
	writer:            W,
	previous:          Option<Frame>,
	layers:            SmallVec<StoredLayer, 4>,
	paint_scratch:     String,
	output_scratch:    String,
	viewport_height:   u16,
	cursor:            Option<ScreenCursor>,
	poisoned:          bool,
	output_state:      OutputState,
	backlog:           OutputBacklogGuard,
	#[cfg(any(windows, target_os = "linux", test))]
	conpty_hosted:     bool,
	images:            BTreeMap<u32, RegisteredImage>,
	alt_screen:        bool,
	graphics:          Graphics,
	cell_pixel_width:  u16,
	cell_pixel_height: u16,
	tmux_passthrough:  bool,
	sync_output:       bool,
	hyperlinks:        bool,
}

impl<W: Write> Renderer<W> {
	/// Creates a renderer with an empty viewport cache.
	pub fn new(writer: W) -> Self {
		Self::with_conpty_hosted(writer, is_conpty_hosted())
	}

	/// Creates a renderer with an injectable ConPTY-hosted decision.
	///
	/// Tests use this seam so ambient WSL variables cannot change large-write
	/// chunking expectations.
	pub fn with_conpty_hosted(writer: W, conpty_hosted: bool) -> Self {
		#[cfg(not(any(windows, target_os = "linux", test)))]
		let _ = conpty_hosted;
		Self {
			writer,
			previous: None,
			layers: SmallVec::new(),
			paint_scratch: String::new(),
			output_scratch: String::new(),
			viewport_height: 0,
			cursor: None,
			poisoned: false,
			output_state: OutputState::Connected,
			backlog: OutputBacklogGuard::default(),
			#[cfg(any(windows, target_os = "linux", test))]
			conpty_hosted,
			images: BTreeMap::new(),
			alt_screen: alt_screen_active(),
			graphics: Graphics::KittyPlaceholders,
			cell_pixel_width: DEFAULT_CELL_PIXEL_WIDTH,
			cell_pixel_height: DEFAULT_CELL_PIXEL_HEIGHT,
			tmux_passthrough: false,
			sync_output: true,
			hyperlinks: false,
		}
	}

	/// Configures renderer options represented by resolved terminal
	/// capabilities.
	///
	/// # Errors
	///
	/// Rejects zero cell-pixel dimensions.
	pub fn apply_caps(&mut self, caps: &TerminalCaps) -> io::Result<()> {
		self.set_graphics(caps.graphics);
		self.set_sync_output(caps.sync_output);
		self.set_hyperlinks(caps.hyperlinks);
		self.set_tmux_passthrough(caps.inside_tmux);
		if let Some((width, height)) = caps.cell_px {
			self.set_cell_pixel_size(width, height)?;
		}
		Ok(())
	}

	/// Registers PNG bytes for a typed terminal image ID.
	///
	/// # Errors
	///
	/// Rejects ID zero and IDs wider than Kitty's 24-bit placeholder encoding.
	pub fn register_image(
		&mut self,
		id: u32,
		png_bytes: impl Into<CowBytes<'static>>,
	) -> io::Result<()> {
		if id == 0 || id > 0x00ff_ffff {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"terminal image ID must fit in 24 bits",
			));
		}
		self
			.images
			.insert(id, RegisteredImage::new(png_bytes.into()));
		Ok(())
	}

	/// Selects how typed image cells are materialized.
	pub const fn set_graphics(&mut self, graphics: Graphics) {
		self.graphics = graphics;
	}

	/// Enables or disables DEC synchronized-output wrapping.
	pub const fn set_sync_output(&mut self, enabled: bool) {
		self.sync_output = enabled;
	}

	/// Enables or disables OSC 8 hyperlink materialization.
	pub const fn set_hyperlinks(&mut self, enabled: bool) {
		self.hyperlinks = enabled;
	}

	/// Sets the terminal cell size used to scale sixel placements.
	///
	/// # Errors
	///
	/// Rejects a zero pixel dimension.
	pub fn set_cell_pixel_size(&mut self, width: u16, height: u16) -> io::Result<()> {
		if width == 0 || height == 0 {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"cell pixel dimensions must be non-zero",
			));
		}
		self.cell_pixel_width = width;
		self.cell_pixel_height = height;
		Ok(())
	}

	/// Enables tmux DCS passthrough for Kitty and sixel graphics sequences.
	pub const fn set_tmux_passthrough(&mut self, enabled: bool) {
		self.tmux_passthrough = enabled;
	}

	/// History-neutral paint of one viewport frame with overlay layers.
	///
	/// A frame taller than `viewport_height` is bottom-clipped as a pure paint
	/// offset. This operation never scrolls and never changes native history.
	///
	/// # Errors
	///
	/// Rejects zero geometry. Writer failure poisons the renderer.
	pub fn present(
		&mut self,
		next: Frame,
		viewport_height: u16,
		layers: &[Layer<'_>],
	) -> io::Result<PaintStats> {
		let viewport = Size::new(next.size().width, viewport_height);
		let resolved = resolve_layers(layers, viewport);
		let (stats, stored, cursor) =
			self.paint_borrowed("", &next, None, viewport_height, &resolved, false)?;
		self.previous = Some(next);
		self.layers = stored;
		self.viewport_height = viewport_height;
		self.cursor = cursor;
		self.publish_debug_screen();
		Ok(stats)
	}

	/// Presents one elastic-slots delivery transaction.
	///
	/// History rows are written one transaction at a time so a writer failure
	/// has an exact completed-row prefix. A failure during the current row is
	/// fail-stop; the returned [`DeliveryError`] acknowledges only earlier,
	/// complete rows.
	///
	/// # Errors
	///
	/// Returns the terminal writer or geometry error together with the exact
	/// completed history-row count.
	pub fn present_plan(
		&mut self,
		plan: &WritePlan,
		layers: &[Layer<'_>],
	) -> Result<Delivered, DeliveryError> {
		let viewport = plan.viewport();
		let height = plan.viewport_rows();
		if plan.rebuild() {
			self
				.reset_history()
				.map_err(|source| DeliveryError { delivered: 0, source })?;
		}
		if plan.rows().is_empty() {
			self
				.present(viewport.clone(), height, layers)
				.map_err(|source| DeliveryError { delivered: 0, source })?;
			return Ok(Delivered::All);
		}
		if self.history_geometry_changed(viewport.size().width, height) {
			self
				.present(viewport.clone(), height, layers)
				.map_err(|source| DeliveryError { delivered: 0, source })?;
		}
		for (delivered, row) in plan.rows().iter().enumerate() {
			self
				.append_history_rows(
					std::slice::from_ref(row.frame()),
					usize::from(row.frame().size().height),
					viewport,
					height,
					layers,
				)
				.map_err(|source| DeliveryError { delivered, source })?;
		}
		Ok(Delivered::All)
	}

	/// Damage-hinted history-neutral paint of one viewport frame with overlay
	/// layers.
	///
	/// The caller guarantees that every changed base-frame row appears in
	/// `damage`. A tall frame is bottom-clipped; this operation never scrolls
	/// or changes native history.
	///
	/// # Errors
	///
	/// Rejects zero geometry. Writer failure poisons the renderer.
	pub fn present_damaged(
		&mut self,
		next: &Frame,
		damage: &[(u16, u16)],
		viewport_height: u16,
		layers: &[Layer<'_>],
	) -> io::Result<PaintStats> {
		let viewport = Size::new(next.size().width, viewport_height);
		let resolved = resolve_layers(layers, viewport);
		self.present_resolved(next, damage, viewport_height, &resolved)
	}

	/// Unconditionally repaints the complete viewport in one synchronized
	/// update.
	///
	/// `prefix` is emitted verbatim before the paint for buffer-exit or
	/// mode-restoration staging. The repaint is history-neutral and never
	/// scrolls.
	///
	/// # Errors
	///
	/// Rejects zero geometry. Writer failure poisons the renderer.
	pub fn repaint(
		&mut self,
		prefix: &str,
		next: Frame,
		viewport_height: u16,
		layers: &[Layer<'_>],
	) -> io::Result<PaintStats> {
		let viewport = Size::new(next.size().width, viewport_height);
		let resolved = resolve_layers(layers, viewport);
		self.repaint_resolved(prefix, next, viewport_height, &resolved)
	}

	/// Damage-hinted paint with already-resolved viewport layers.
	pub(crate) fn present_resolved(
		&mut self,
		next: &Frame,
		damage: &[(u16, u16)],
		viewport_height: u16,
		layers: &[ResolvedLayer<'_>],
	) -> io::Result<PaintStats> {
		let (stats, stored, cursor) =
			self.paint_borrowed("", next, Some(damage), viewport_height, layers, false)?;
		if self
			.previous
			.as_ref()
			.is_some_and(|previous| previous.size() == next.size())
		{
			let previous = self
				.previous
				.as_mut()
				.expect("same-size check requires a prior frame");
			for &(start, end) in damage {
				for row in start..end.min(next.size().height) {
					previous.copy_row_from(next, row);
				}
			}
			previous.sync_soft_wraps(next);
		} else {
			match &mut self.previous {
				Some(previous) => previous.clone_from(next),
				None => self.previous = Some(next.clone()),
			}
		}
		self.layers = stored;
		self.viewport_height = viewport_height;
		self.cursor = cursor;
		self.publish_debug_screen();
		Ok(stats)
	}

	/// Full paint with already-resolved viewport layers.
	pub(crate) fn repaint_resolved(
		&mut self,
		prefix: &str,
		next: Frame,
		viewport_height: u16,
		layers: &[ResolvedLayer<'_>],
	) -> io::Result<PaintStats> {
		let (stats, stored, cursor) =
			self.paint_borrowed(prefix, &next, None, viewport_height, layers, true)?;
		self.previous = Some(next);
		self.layers = stored;
		self.viewport_height = viewport_height;
		self.cursor = cursor;
		self.publish_debug_screen();
		Ok(stats)
	}

	fn append_history_rows(
		&mut self,
		finalized: &[Frame],
		finalized_rows: usize,
		viewport: &Frame,
		viewport_height: u16,
		layers: &[Layer<'_>],
	) -> io::Result<()> {
		self.validate_frame(viewport, viewport_height)?;
		if alt_screen_active() {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"cannot retire rows while the alternate screen owns the terminal",
			));
		}
		if viewport.size().height != viewport_height {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"retirement viewport height does not match viewport_height",
			));
		}
		if finalized
			.iter()
			.any(|frame| frame.size().width != viewport.size().width)
		{
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"finalized and viewport frames must have equal widths",
			));
		}
		let available_rows = finalized
			.iter()
			.map(|frame| usize::from(frame.size().height))
			.sum::<usize>();
		if finalized_rows > available_rows {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"finalized row limit exceeds supplied frame segments",
			));
		}
		let finalized = FrameSegments::new(finalized, finalized_rows);
		if self.history_geometry_changed(viewport.size().width, viewport_height) {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"retirement geometry differs from the painted viewport",
			));
		}

		self.sync_screen_buffer();
		let window = Window { top: 0, height: viewport_height };
		let resolved = resolve_layers(layers, viewport.size());
		let stored = store_layers(&resolved, window, viewport.size().width);
		let viewport_view = ComposedFrame { base: viewport, layers: &stored };
		let cursor = compose_cursor(viewport, &stored, window, viewport.size().width);
		let images = self.image_prefix(viewport, &resolved, window);
		self.prepare_sixels(viewport, window);
		let sixels = self.sixel_output(viewport, window, None, None, true);
		let kitty_direct = kitty_direct_output(
			self.graphics,
			&mut self.images,
			viewport,
			window,
			None,
			None,
			true,
			self.cell_pixel_width,
			self.cell_pixel_height,
			self.tmux_passthrough,
		);
		let iterm2 = iterm2_output(
			self.graphics,
			self
				.images
				.iter()
				.map(|(&id, image)| Iterm2Image { id, png: &image.png }),
			viewport,
			Iterm2Viewport { top: 0, height: viewport_height },
			None,
			None,
			true,
			self.tmux_passthrough,
		);

		let mut output = mem::take(&mut self.output_scratch);
		output.clear();
		if self.sync_output {
			output.push_str(SYNC_OUTPUT_BEGIN);
		}
		output.push_str(HIDE_CURSOR);
		append_fixed_screen_modes(&mut output, viewport_height);
		output.push_str(&images);

		// Overwrite the first H rows of T without scrolling. Internal soft-wrap
		// boundaries use armed autowrap only above the bottom row, where wrapping
		// cannot scroll.
		for screen_row in 0..viewport_height {
			let index = usize::from(screen_row);
			let _ = write!(output, "\x1b[{};1H", screen_row + 1);
			output.push_str(esc!(erase_line));
			let joined =
				index > 0 && retirement_joinable(&finalized, &viewport_view, index - 1, index);
			if joined {
				let _ = write!(output, "\x1b[{screen_row};1H");
				output.push_str(esc!(autowrap));
				arm_retirement_boundary(
					&mut output,
					&finalized,
					&viewport_view,
					index - 1,
					self.graphics,
					self.hyperlinks,
				);
				emit_retirement_row(
					&mut output,
					&finalized,
					&viewport_view,
					index,
					self.graphics,
					self.hyperlinks,
				);
				output.push_str(esc!(!autowrap));
			} else {
				emit_retirement_row(
					&mut output,
					&finalized,
					&viewport_view,
					index,
					self.graphics,
					self.hyperlinks,
				);
			}
		}

		// T has F + H rows, so exactly F rows remain and each iteration scrolls once.
		for index in
			usize::from(viewport_height)..finalized_rows.saturating_add(usize::from(viewport_height))
		{
			let _ = write!(output, "\x1b[{viewport_height};1H");
			if retirement_joinable(&finalized, &viewport_view, index - 1, index) {
				output.push_str(esc!(autowrap));
				arm_retirement_boundary(
					&mut output,
					&finalized,
					&viewport_view,
					index - 1,
					self.graphics,
					self.hyperlinks,
				);
				emit_retirement_row(
					&mut output,
					&finalized,
					&viewport_view,
					index,
					self.graphics,
					self.hyperlinks,
				);
				output.push_str(esc!(!autowrap));
			} else {
				output.push_str("\r\n");
				output.push('\r');
				output.push_str(esc!(erase_line));
				emit_retirement_row(
					&mut output,
					&finalized,
					&viewport_view,
					index,
					self.graphics,
					self.hyperlinks,
				);
			}
		}
		output.push_str(RESET_STYLE);
		append_fixed_screen_modes(&mut output, viewport_height);
		output.push_str(VIEWPORT_BOTTOM);
		output.push_str(&sixels);
		output.push_str(&kitty_direct);
		output.push_str(&iterm2);
		place_cursor_screen(&mut output, cursor);
		if self.sync_output {
			output.push_str(SYNC_OUTPUT_END);
		}

		let result = self.write(&output);
		self.output_scratch = output;
		result?;
		match &mut self.previous {
			Some(previous) => previous.clone_from(viewport),
			None => self.previous = Some(viewport.clone()),
		}
		self.layers = stored;
		self.viewport_height = viewport_height;
		self.cursor = cursor;
		self.publish_debug_screen();
		Ok(())
	}

	fn history_geometry_changed(&self, width: u16, viewport_height: u16) -> bool {
		!self.alt_screen
			&& self.previous.as_ref().is_some_and(|previous| {
				previous.size().width != width || self.viewport_height != viewport_height
			})
	}

	/// Destructively clears native history, the visible screen, and registered
	/// terminal graphics.
	///
	/// The next paint is a full first paint onto the blank screen at row zero.
	///
	/// # Errors
	///
	/// Writer failure poisons the renderer.
	pub fn reset_history(&mut self) -> io::Result<()> {
		if self.poisoned {
			return Err(io::Error::other(
				"renderer state is unknown after a partial write; restart the terminal session",
			));
		}

		let mut output = mem::take(&mut self.output_scratch);
		output.clear();
		for &id in self.images.keys() {
			append_delete_image(&mut output, id, self.tmux_passthrough);
		}
		output.push_str(RESET_HISTORY);
		let result = self.write(&output);
		self.output_scratch = output;
		result?;

		self.previous = None;
		self.layers.clear();
		self.viewport_height = 0;
		self.cursor = None;
		self.images.clear();
		Ok(())
	}

	/// Repaints the raw viewport under stored layers and drops those layers.
	///
	/// # Errors
	///
	/// Writer failure poisons the renderer.
	pub fn clear_layers(&mut self) -> io::Result<()> {
		if self.poisoned || self.layers.is_empty() || alt_screen_active() {
			return Ok(());
		}
		let Some(previous) = self.previous.as_ref() else {
			self.layers.clear();
			return Ok(());
		};
		let frame = previous.clone();
		self.repaint_resolved("", frame, self.viewport_height, &[])?;
		Ok(())
	}

	/// Renders the retained viewport composition as right-trimmed text rows.
	pub fn screen_text(&self) -> Vec<String> {
		match &self.previous {
			Some(previous) => {
				let top = previous.size().height.saturating_sub(self.viewport_height);
				stored_text(previous, &self.layers, top, self.viewport_height)
			},
			None => Vec::new(),
		}
	}

	/// Screen coordinates of the hardware cursor placed by the last operation.
	pub const fn screen_cursor(&self) -> Option<(u16, u16)> {
		match self.cursor {
			Some(cursor) => Some((cursor.row, cursor.col)),
			None => None,
		}
	}

	/// Returns whether terminal output is connected.
	pub const fn output_state(&self) -> OutputState {
		self.output_state
	}

	/// Borrows the output writer for terminal session teardown.
	pub const fn writer_mut(&mut self) -> &mut W {
		&mut self.writer
	}

	/// Returns the output writer after the renderer is no longer needed.
	pub fn into_inner(self) -> W {
		self.writer
	}

	fn validate_frame(&self, next: &Frame, viewport_height: u16) -> io::Result<()> {
		if self.poisoned {
			return Err(io::Error::other(
				"renderer state is unknown after a partial write; restart the terminal session",
			));
		}
		if next.size().width == 0 || viewport_height == 0 {
			return Err(io::Error::new(
				io::ErrorKind::InvalidInput,
				"frame width and viewport height must be non-zero",
			));
		}
		Ok(())
	}

	#[allow(clippy::too_many_arguments, reason = "paint inputs are independent viewport state")]
	fn paint_borrowed(
		&mut self,
		prefix: &str,
		next: &Frame,
		damage: Option<&[(u16, u16)]>,
		viewport_height: u16,
		layers: &[ResolvedLayer<'_>],
		force: bool,
	) -> io::Result<(PaintStats, SmallVec<StoredLayer, 4>, Option<ScreenCursor>)> {
		self.validate_frame(next, viewport_height)?;
		self.sync_screen_buffer();
		let window = Window {
			top:    next.size().height.saturating_sub(viewport_height),
			height: viewport_height,
		};
		let stored = store_layers(layers, window, next.size().width);
		let cursor = compose_cursor(next, &stored, window, next.size().width);
		let can_diff = !force
			&& prefix.is_empty()
			&& self.viewport_height == viewport_height
			&& self
				.previous
				.as_ref()
				.is_some_and(|previous| previous.size().width == next.size().width);
		let images = self.image_prefix(next, layers, window);
		self.prepare_sixels(next, window);
		let previous_window = self.previous.as_ref().map(|previous| Window {
			top:    previous.size().height.saturating_sub(viewport_height),
			height: viewport_height,
		});
		let previous_image = if can_diff {
			self.previous.as_ref().zip(previous_window)
		} else {
			None
		};
		let sixels = self.sixel_output(next, window, previous_image, damage, !can_diff);
		let kitty_direct = kitty_direct_output(
			self.graphics,
			&mut self.images,
			next,
			window,
			previous_image,
			damage,
			!can_diff,
			self.cell_pixel_width,
			self.cell_pixel_height,
			self.tmux_passthrough,
		);
		let iterm2 = iterm2_output(
			self.graphics,
			self
				.images
				.iter()
				.map(|(&id, image)| Iterm2Image { id, png: &image.png }),
			next,
			Iterm2Viewport { top: window.top, height: window.height },
			previous_image.map(|(previous, previous_window)| {
				(previous, Iterm2Viewport {
					top:    previous_window.top,
					height: previous_window.height,
				})
			}),
			damage,
			!can_diff,
			self.tmux_passthrough,
		);

		let mut stats = PaintStats::default();
		let mut paint = mem::take(&mut self.paint_scratch);
		paint.clear();
		if can_diff {
			let previous = self
				.previous
				.as_ref()
				.expect("diff geometry requires a previous frame");
			let previous_window = previous_window.expect("diff geometry computed a previous window");
			let dirty = damage.and_then(|damage| {
				(previous_window == window)
					.then(|| changed_screen_rows(damage, &self.layers, &stored, window))
			});
			emit_window_diff_rows(
				&mut paint,
				&ComposedFrame { base: previous, layers: &self.layers },
				previous_window,
				&ComposedFrame { base: next, layers: &stored },
				window,
				0,
				viewport_height,
				dirty.as_deref(),
				self.graphics,
				self.hyperlinks,
				&mut stats,
			);
		}

		let auxiliary =
			!images.is_empty() || !sixels.is_empty() || !kitty_direct.is_empty() || !iterm2.is_empty();
		let full = !can_diff;
		let mut output = mem::take(&mut self.output_scratch);
		output.clear();
		if full || stats.runs > 0 || cursor != self.cursor || auxiliary {
			if self.sync_output {
				output.push_str(SYNC_OUTPUT_BEGIN);
			}
			output.push_str(HIDE_CURSOR);
			output.push_str(prefix);
			append_fixed_screen_modes(&mut output, viewport_height);
			output.push_str(&images);
			if full {
				emit_absolute_window(
					&mut output,
					&ComposedFrame { base: next, layers: &stored },
					window,
					self.graphics,
					self.hyperlinks,
				);
				stats.full_repaint = true;
				stats.changed_cells =
					usize::from(next.size().width).saturating_mul(usize::from(viewport_height));
				stats.runs = usize::from(viewport_height);
			} else {
				output.push_str(VIEWPORT_BOTTOM);
				output.push_str(&paint);
			}
			output.push_str(VIEWPORT_BOTTOM);
			output.push_str(&sixels);
			output.push_str(&kitty_direct);
			output.push_str(&iterm2);
			place_cursor_screen(&mut output, cursor);
			if self.sync_output {
				output.push_str(SYNC_OUTPUT_END);
			}
		}
		stats.bytes = output.len();
		let result = self.write(&output);
		self.paint_scratch = paint;
		self.output_scratch = output;
		result?;
		Ok((stats, stored, cursor))
	}

	fn publish_debug_screen(&self) {
		if !debug::publishing() {
			return;
		}
		let Some(previous) = &self.previous else {
			return;
		};
		let top = previous.size().height.saturating_sub(self.viewport_height);
		debug::publish_screen(ScreenSnapshot {
			lines:      self.screen_text(),
			cursor:     self.screen_cursor(),
			window_top: top,
			cols:       previous.size().width,
			rows:       self.viewport_height,
			doc_height: previous.size().height,
			overlay:    !self.layers.is_empty(),
		});
	}

	/// Reconciles graphics caches with the terminal's current screen buffer.
	fn sync_screen_buffer(&mut self) {
		self.set_screen_buffer(alt_screen_active());
	}

	/// Records which screen buffer subsequent paints target.
	///
	/// A change drops all terminal-side Kitty graphics state — transmissions,
	/// virtual placements, direct placements — because terminals with
	/// per-screen image storage (ghostty) do not share them between the main
	/// and alternate buffers; the next paint retransmits and re-places.
	fn set_screen_buffer(&mut self, alt_screen: bool) {
		if alt_screen == self.alt_screen {
			return;
		}
		self.previous = None;
		self.layers.clear();
		self.cursor = None;
		self.viewport_height = 0;
		self.alt_screen = alt_screen;
		for image in self.images.values_mut() {
			image.uploaded = false;
			image.placed.clear();
			image.direct_visible = false;
		}
	}

	/// Emits Kitty transmissions and virtual placements for every image
	/// referenced by the document or by a composited overlay layer band.
	///
	/// Each distinct cell box of an image gets its own placement, keyed by
	/// [`crate::kitty::placement_id`], so repeated sizes replace instead of
	/// accumulating and placeholder cells always resolve their exact grid.
	/// IDs unknown to [`Renderer::register_image`] are resolved from the
	/// process-wide `<img src>` registry.
	fn image_prefix(
		&mut self,
		frame: &Frame,
		layers: &[ResolvedLayer<'_>],
		window: Window,
	) -> String {
		if self.graphics != Graphics::KittyPlaceholders
			|| (!frame.may_have_images() && layers.iter().all(|layer| !layer.frame.may_have_images()))
		{
			return String::new();
		}
		let mut needed: SmallVec<(u32, u16, u16), 8> = SmallVec::new();
		let mut collect = |frame: &Frame, y0: u16, y1: u16| {
			for y in y0..y1.min(frame.size().height) {
				for x in 0..frame.size().width {
					if let CellContent::Image { id, rows, cols, .. } = frame.cell(x, y).content
						&& rows > 0 && cols > 0
						&& !needed.contains(&(id, rows, cols))
					{
						needed.push((id, rows, cols));
					}
				}
			}
		};
		collect(frame, window.top, window.top.saturating_add(window.height));
		for layer in layers {
			collect(layer.frame, layer.src_top, layer.src_top.saturating_add(layer.rows));
		}
		let mut output = String::new();
		for (id, rows, cols) in needed {
			let image = match self.images.entry(id) {
				Entry::Occupied(entry) => entry.into_mut(),
				Entry::Vacant(entry) => {
					let Some(png) = imagereg::bytes(id) else {
						continue;
					};
					entry.insert(RegisteredImage::new(png))
				},
			};
			if !image.uploaded {
				append_transmission(&mut output, id, &image.png, self.tmux_passthrough);
				image.uploaded = true;
			}
			if !image.placed.contains(&(rows, cols)) {
				append_placement(&mut output, id, rows, cols, self.tmux_passthrough);
				image.placed.push((rows, cols));
			}
		}
		output
	}

	fn prepare_sixels(&mut self, frame: &Frame, window: Window) {
		if self.graphics != Graphics::Sixel {
			return;
		}
		for y in window.top
			..window
				.top
				.saturating_add(window.height)
				.min(frame.size().height)
		{
			for x in 0..frame.size().width {
				let CellContent::Image { id, .. } = frame.cell(x, y).content else {
					continue;
				};
				let Some(image) = self.images.get_mut(&id) else {
					continue;
				};
				if !image.sixel_decoded {
					image.sixel = SixelImage::from_png(&image.png);
					image.sixel_decoded = true;
				}
			}
		}
	}

	fn sixel_output(
		&self,
		frame: &Frame,
		window: Window,
		previous: Option<(&Frame, Window)>,
		damaged: Option<&[(u16, u16)]>,
		force: bool,
	) -> String {
		if self.graphics != Graphics::Sixel {
			return String::new();
		}
		let mut output = String::new();
		let mut cursor_row = window.height - 1;
		for (&id, registered) in &self.images {
			let Some(image) = &registered.sixel else {
				continue;
			};
			let Some((top, left, rows, cols)) = image_placement(frame, id) else {
				continue;
			};
			let visible_top = top.max(window.top);
			let visible_bottom = top
				.saturating_add(rows)
				.min(window.top.saturating_add(window.height))
				.min(frame.size().height);
			if visible_top >= visible_bottom {
				continue;
			}
			let needs_emit = force
				|| match damaged {
					Some(ranges) => ranges
						.iter()
						.any(|&(start, end)| start < visible_bottom && end > visible_top),
					None => match previous {
						None => true,
						Some((previous, previous_window)) => {
							previous_window.top != window.top
								|| (visible_top..visible_bottom)
									.any(|row| !previous.row_equals(row, frame, row))
						},
					},
				};
			if !needs_emit {
				continue;
			}
			let target_width = usize::from(cols).saturating_mul(usize::from(self.cell_pixel_width));
			let target_height = usize::from(rows).saturating_mul(usize::from(self.cell_pixel_height));
			let y0 = usize::from(visible_top - top).saturating_mul(target_height) / usize::from(rows);
			let y1 =
				usize::from(visible_bottom - top).saturating_mul(target_height) / usize::from(rows);
			let sixel = image.encode_band(target_width, target_height, y0, y1);
			if sixel.is_empty() {
				continue;
			}
			move_cursor_row(&mut output, &mut cursor_row, visible_top - window.top);
			output.push('\r');
			if left > 0 {
				let _ = write!(output, esc!(cursor_forward), left);
			}
			if self.tmux_passthrough {
				append_tmux_passthrough(&mut output, &sixel);
			} else {
				output.push_str(&sixel);
			}
		}
		if !output.is_empty() {
			move_cursor_row(&mut output, &mut cursor_row, window.height - 1);
			output.push('\r');
		}
		output
	}

	fn write(&mut self, output: &str) -> io::Result<()> {
		if output.is_empty() {
			return Ok(());
		}
		if self.output_state == OutputState::Disconnected || self.backlog.queue(output.len()) {
			self.output_state = OutputState::Disconnected;
			self.poisoned = true;
			return Err(io::Error::new(
				io::ErrorKind::BrokenPipe,
				"terminal output backlog exceeded 64 MiB; terminal is disconnected",
			));
		}
		let result = self
			.write_output(output.as_bytes())
			.and_then(|()| self.writer.flush());
		if let Err(error) = result {
			self.poisoned = true;
			return Err(error);
		}
		self.backlog.flushed();
		Ok(())
	}

	fn write_output(&mut self, output: &[u8]) -> io::Result<()> {
		#[cfg(any(windows, target_os = "linux", test))]
		if self.conpty_hosted && output.len() > MAX_CONPTY_WRITE_CHUNK_BYTES {
			for chunk in ConptyChunks::new(output, MAX_CONPTY_WRITE_CHUNK_BYTES) {
				terminal_write_all(&mut self.writer, chunk)?;
			}
			return Ok(());
		}
		terminal_write_all(&mut self.writer, output)
	}
}

fn append_fixed_screen_modes(output: &mut String, viewport_height: u16) {
	output.push_str(esc!(!origin));
	if viewport_height > 1 {
		output.push_str(esc!(margins_reset));
	}
	output.push_str(esc!(!autowrap));
}

fn place_cursor_screen(output: &mut String, cursor: Option<ScreenCursor>) {
	match cursor {
		Some(cursor) => {
			let _ = write!(output, "\x1b[{};{}H", cursor.row + 1, cursor.col + 1);
			output.push_str(SHOW_CURSOR);
		},
		None => output.push_str(HIDE_CURSOR),
	}
}

fn emit_absolute_window(
	output: &mut String,
	frame: &ComposedFrame<'_>,
	window: Window,
	graphics: Graphics,
	hyperlinks: bool,
) {
	for screen_row in 0..window.height {
		let row = window.top.saturating_add(screen_row);
		let _ = write!(output, "\x1b[{};1H", screen_row + 1);
		output.push_str(esc!(erase_line));
		let joined = screen_row > 0
			&& row > 0
			&& row - 1 < frame.base.size().height
			&& wrap_joinable(frame, row - 1);
		if joined {
			let _ = write!(output, "\x1b[{screen_row};1H");
			output.push_str(esc!(autowrap));
			arm_wrap_boundary(output, frame, row - 1, graphics, hyperlinks);
			encode_frame_row(output, frame, row, graphics, hyperlinks);
			output.push_str(esc!(!autowrap));
		} else {
			encode_frame_row(output, frame, row, graphics, hyperlinks);
		}
	}
	output.push_str(RESET_STYLE);
	output.push_str(esc!(!autowrap));
}

fn retirement_joinable(
	finalized: &FrameSegments<'_>,
	viewport: &ComposedFrame<'_>,
	previous: usize,
	current: usize,
) -> bool {
	if current != previous.saturating_add(1) {
		return false;
	}
	if current < finalized.rows {
		let (previous_frame, previous_row) = finalized.locate(previous);
		let (current_frame, current_row) = finalized.locate(current);
		return ptr::eq(previous_frame, current_frame)
			&& current_row == previous_row.saturating_add(1)
			&& previous_frame.soft_wrap(previous_row);
	}
	previous >= finalized.rows
		&& viewport
			.base
			.soft_wrap(u16::try_from(previous - finalized.rows).expect("viewport row fits u16"))
}

fn emit_retirement_row(
	output: &mut String,
	finalized: &FrameSegments<'_>,
	viewport: &ComposedFrame<'_>,
	index: usize,
	graphics: Graphics,
	hyperlinks: bool,
) {
	if index < finalized.rows {
		let (frame, row) = finalized.locate(index);
		encode_frame_row(
			output,
			&ComposedFrame { base: frame, layers: &[] },
			row,
			graphics,
			hyperlinks,
		);
	} else {
		encode_frame_row(
			output,
			viewport,
			u16::try_from(index - finalized.rows).expect("viewport row fits u16"),
			graphics,
			hyperlinks,
		);
	}
}

fn arm_retirement_boundary(
	output: &mut String,
	finalized: &FrameSegments<'_>,
	viewport: &ComposedFrame<'_>,
	index: usize,
	graphics: Graphics,
	hyperlinks: bool,
) {
	if index < finalized.rows {
		let (frame, row) = finalized.locate(index);
		arm_wrap_boundary(
			output,
			&ComposedFrame { base: frame, layers: &[] },
			row,
			graphics,
			hyperlinks,
		);
	} else {
		arm_wrap_boundary(
			output,
			viewport,
			u16::try_from(index - finalized.rows).expect("viewport row fits u16"),
			graphics,
			hyperlinks,
		);
	}
}

#[cfg(any(windows, target_os = "linux", test))]
struct ConptyChunks<'a> {
	bytes: &'a [u8],
	pos:   usize,
	max:   usize,
}

#[cfg(any(windows, target_os = "linux", test))]
impl<'a> ConptyChunks<'a> {
	fn new(bytes: &'a [u8], max: usize) -> Self {
		debug_assert!(max > 0);
		Self { bytes, pos: 0, max }
	}
}

#[cfg(any(windows, target_os = "linux", test))]
impl<'a> Iterator for ConptyChunks<'a> {
	type Item = &'a [u8];

	fn next(&mut self) -> Option<Self::Item> {
		if self.pos == self.bytes.len() {
			return None;
		}
		let start = self.pos;
		if self.bytes.len() - start <= self.max {
			self.pos = self.bytes.len();
			return Some(&self.bytes[start..]);
		}

		let mut window_end = start + self.max;
		while self.bytes[window_end] & 0xc0 == 0x80 {
			window_end -= 1;
		}
		let mut search_end = window_end;
		let cut = loop {
			let newline = self.bytes[start..search_end]
				.iter()
				.rposition(|byte| *byte == b'\n')
				.map(|index| start + index + 1);
			let Some(newline) = newline else {
				break escape_end_crossing(self.bytes, start, window_end).unwrap_or(window_end);
			};
			if escape_end_crossing(self.bytes, start, newline).is_none() {
				break newline;
			}
			search_end = newline - 1;
		};
		self.pos = cut;
		Some(&self.bytes[start..cut])
	}
}

#[cfg(any(windows, target_os = "linux", test))]
fn escape_end_crossing(bytes: &[u8], start: usize, cut: usize) -> Option<usize> {
	let mut index = start;
	while index < cut {
		if bytes[index] != b'\x1b' {
			index += 1;
			continue;
		}
		let end = escape_sequence_end(bytes, index);
		if end > cut {
			return Some(end);
		}
		index = end.max(index + 1);
	}
	None
}

#[cfg(any(windows, target_os = "linux", test))]
fn escape_sequence_end(bytes: &[u8], start: usize) -> usize {
	let Some(&kind) = bytes.get(start + 1) else {
		return bytes.len();
	};
	match kind {
		b'[' => {
			for (offset, byte) in bytes[start + 2..].iter().enumerate() {
				if (0x40..=0x7e).contains(byte) {
					return start + 3 + offset;
				}
			}
			bytes.len()
		},
		b']' => string_escape_end(bytes, start + 2, true),
		b'P' | b'X' | b'^' | b'_' => string_escape_end(bytes, start + 2, false),
		0x20..=0x2f => {
			for (offset, byte) in bytes[start + 2..].iter().enumerate() {
				if (0x30..=0x7e).contains(byte) {
					return start + 3 + offset;
				}
			}
			bytes.len()
		},
		_ => (start + 2).min(bytes.len()),
	}
}

#[cfg(any(windows, target_os = "linux", test))]
fn string_escape_end(bytes: &[u8], start: usize, bell_terminated: bool) -> usize {
	let mut index = start;
	while index < bytes.len() {
		if bell_terminated && bytes[index] == b'\x07' {
			return index + 1;
		}
		if bytes[index] == b'\x1b' && bytes.get(index + 1) == Some(&b'\\') {
			return index + 2;
		}
		index += 1;
	}
	bytes.len()
}

#[cfg(windows)]
const fn is_conpty_hosted() -> bool {
	true
}

#[cfg(target_os = "linux")]
fn is_conpty_hosted() -> bool {
	env::var_os("WSL_DISTRO_NAME").is_some() || env::var_os("WSL_INTEROP").is_some()
}

#[cfg(not(any(windows, target_os = "linux")))]
const fn is_conpty_hosted() -> bool {
	false
}

#[allow(clippy::too_many_arguments, reason = "rendering inputs are independent frame state")]
fn kitty_direct_output(
	graphics: Graphics,
	images: &mut BTreeMap<u32, RegisteredImage>,
	frame: &Frame,
	window: Window,
	previous: Option<(&Frame, Window)>,
	damaged: Option<&[(u16, u16)]>,
	force: bool,
	cell_pixel_width: u16,
	cell_pixel_height: u16,
	tmux_passthrough: bool,
) -> String {
	if graphics != Graphics::KittyDirect {
		return String::new();
	}
	let mut output = String::new();
	let mut cursor_row = window.height - 1;
	for (&id, image) in images {
		let placement = image_placement(frame, id);
		let visible = placement.and_then(|(top, left, rows, cols)| {
			let visible_top = top.max(window.top);
			let visible_bottom = top
				.saturating_add(rows)
				.min(window.top.saturating_add(window.height))
				.min(frame.size().height);
			(visible_top < visible_bottom).then_some((
				top,
				left,
				rows,
				cols,
				visible_top,
				visible_bottom,
			))
		});
		let Some((top, left, rows, cols, visible_top, visible_bottom)) = visible else {
			if image.direct_visible {
				append_delete_image(&mut output, id, tmux_passthrough);
				image.uploaded = false;
				image.direct_visible = false;
			}
			continue;
		};

		let moved = previous.is_none_or(|(previous_frame, previous_window)| {
			image_placement(previous_frame, id) != placement || previous_window.top != window.top
		});
		let intersects_damage = damaged.is_some_and(|ranges| {
			ranges
				.iter()
				.any(|&(start, end)| start < visible_bottom && end > visible_top)
		});
		let changed = damaged.is_none()
			&& previous.is_some_and(|(previous_frame, _)| {
				(visible_top..visible_bottom).any(|row| !previous_frame.row_equals(row, frame, row))
			});
		let needs_emit =
			force || !image.uploaded || !image.direct_visible || moved || intersects_damage || changed;
		image.direct_visible = true;
		if !needs_emit {
			continue;
		}
		if !image.uploaded {
			append_transmission(&mut output, id, &image.png, tmux_passthrough);
			image.uploaded = true;
		}

		let fallback_width = u32::from(cols)
			.saturating_mul(u32::from(cell_pixel_width))
			.max(1);
		let fallback_height = u32::from(rows)
			.saturating_mul(u32::from(cell_pixel_height))
			.max(1);
		let (source_width, source_height) =
			png_dimensions(&image.png).unwrap_or((fallback_width, fallback_height));
		let row_offset = u64::from(visible_top - top);
		let row_end = u64::from(visible_bottom - top);
		let source_y = (row_offset.saturating_mul(u64::from(source_height)) / u64::from(rows)) as u32;
		let source_bottom =
			(row_end.saturating_mul(u64::from(source_height)) / u64::from(rows)) as u32;
		let source_height = source_bottom.saturating_sub(source_y).max(1);

		move_cursor_row(&mut output, &mut cursor_row, visible_top - window.top);
		output.push('\r');
		if left > 0 {
			let _ = write!(output, esc!(cursor_forward), left);
		}
		append_direct_placement(
			&mut output,
			id,
			DirectPlacement {
				source_x: 0,
				source_y,
				source_width,
				source_height,
				rows: visible_bottom - visible_top,
				cols,
			},
			tmux_passthrough,
		);
	}
	if !output.is_empty() {
		move_cursor_row(&mut output, &mut cursor_row, window.height - 1);
		output.push('\r');
	}
	output
}

fn png_dimensions(png: &[u8]) -> Option<(u32, u32)> {
	const SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
	if png.get(..8) != Some(SIGNATURE) || png.get(12..16) != Some(b"IHDR") {
		return None;
	}
	let width = u32::from_be_bytes(png.get(16..20)?.try_into().ok()?);
	let height = u32::from_be_bytes(png.get(20..24)?.try_into().ok()?);
	(width > 0 && height > 0).then_some((width, height))
}

/// Returns the top-left cell and declared cell-box size of an image placement.
pub fn image_placement(frame: &Frame, id: u32) -> Option<(u16, u16, u16, u16)> {
	for y in 0..frame.size().height {
		for x in 0..frame.size().width {
			if let CellContent::Image { id: cell_id, row, col, rows, cols } = frame.cell(x, y).content
				&& cell_id == id
				&& rows > 0
				&& cols > 0
			{
				return Some((y.saturating_sub(row), x.saturating_sub(col), rows, cols));
			}
		}
	}
	None
}

/// Resolves declarative layers into z-ordered viewport bands.
fn resolve_layers<'a>(layers: &'a [Layer<'_>], viewport: Size) -> SmallVec<ResolvedLayer<'a>, 4> {
	let mut ordered: SmallVec<(i16, ResolvedLayer<'a>), 4> = layers
		.iter()
		.filter_map(|layer| {
			let band = layer.band(viewport);
			(band.rows > 0).then_some((layer.options.z, ResolvedLayer {
				frame:   layer.frame,
				x:       band.x,
				y:       band.y,
				src_top: band.src_top,
				rows:    band.rows,
				active:  layer.active,
			}))
		})
		.collect();
	ordered.sort_by_key(|(z, _)| *z);
	ordered.into_iter().map(|(_, layer)| layer).collect()
}

fn store_layers(
	layers: &[ResolvedLayer<'_>],
	window: Window,
	document_width: u16,
) -> SmallVec<StoredLayer, 4> {
	let mut stored = SmallVec::new();
	store_layers_into(layers, window, document_width, &mut stored);
	stored
}

fn store_layers_into(
	layers: &[ResolvedLayer<'_>],
	window: Window,
	document_width: u16,
	stored: &mut SmallVec<StoredLayer, 4>,
) {
	let mut len = 0;
	for layer in layers {
		if layer.y >= window.height
			|| layer.x >= document_width
			|| layer.src_top >= layer.frame.size().height
			|| layer.frame.size().width == 0
		{
			continue;
		}
		let rows = layer
			.rows
			.min(window.height - layer.y)
			.min(layer.frame.size().height - layer.src_top);
		if rows == 0 {
			continue;
		}
		let source_address = ptr::from_ref(layer.frame).addr();
		let (source_id, source_revision) = layer.frame.source_stamp();
		if let Some(slot) = stored.get_mut(len) {
			let source_unchanged = slot.source_address == source_address
				&& slot.source_id == source_id
				&& slot.source_revision == source_revision;
			if !source_unchanged && !slot.frame.same_grid(layer.frame) {
				slot.frame.clone_from(layer.frame);
			}
			slot.x = layer.x;
			slot.document_y = window.top.saturating_add(layer.y);
			slot.src_top = layer.src_top;
			slot.rows = rows;
			slot.active = layer.active;
			slot.source_address = source_address;
			slot.source_id = source_id;
			slot.source_revision = source_revision;
		} else {
			stored.push(StoredLayer {
				frame: layer.frame.clone(),
				x: layer.x,
				document_y: window.top.saturating_add(layer.y),
				src_top: layer.src_top,
				rows,
				active: layer.active,
				source_address,
				source_id,
				source_revision,
			});
		}
		len += 1;
	}
	stored.truncate(len);
}

fn changed_screen_rows(
	damaged: &[(u16, u16)],
	previous_layers: &[StoredLayer],
	next_layers: &[StoredLayer],
	window: Window,
) -> SmallVec<(u16, u16), 12> {
	let mut rows = SmallVec::new();
	let window_end = window.top.saturating_add(window.height);
	let mut push_document_rows = |start: u16, end: u16| {
		let start = start.max(window.top);
		let end = end.min(window_end);
		if start < end {
			rows.push((start - window.top, end - window.top));
		}
	};
	for &(start, end) in damaged {
		push_document_rows(start, end);
	}
	for index in 0..previous_layers.len().max(next_layers.len()) {
		let previous = previous_layers.get(index);
		let next = next_layers.get(index);
		if previous
			.zip(next)
			.is_some_and(|(previous, next)| previous.same_cells_and_placement(next))
		{
			continue;
		}
		if let Some(layer) = previous {
			push_document_rows(layer.document_y, layer.document_y.saturating_add(layer.rows));
		}
		if let Some(layer) = next {
			push_document_rows(layer.document_y, layer.document_y.saturating_add(layer.rows));
		}
	}
	rows
}

/// One right-trimmed text row per viewport line of `base` under `layers`.
fn stored_text(base: &Frame, layers: &[StoredLayer], top: u16, height: u16) -> Vec<String> {
	let composed = ComposedFrame { base, layers };
	let blank = Cell::blank(Style::default());
	let width = base.size().width;
	let mut rows = Vec::with_capacity(usize::from(height));
	for offset in 0..height {
		let y = top.saturating_add(offset);
		let mut text = String::new();
		for x in 0..width {
			match &composed.cell_or(y, x, &blank).content {
				CellContent::Blank => text.push(' '),
				CellContent::Grapheme { text: glyph, .. } => text.push_str(glyph),
				CellContent::Image { .. } => text.push(' '),
				CellContent::Continuation => {},
			}
		}
		text.truncate(text.trim_end().len());
		rows.push(text);
	}
	rows
}

/// Hardware-cursor choice for a composited screen: the layer owning the
/// keyboard places — or, without a frame cursor, suppresses — the caret;
/// with no active layer the base document's caret shows through passive
/// layers.
fn compose_cursor(
	base: &Frame,
	layers: &[StoredLayer],
	window: Window,
	document_width: u16,
) -> Option<ScreenCursor> {
	match layers.iter().rev().find(|layer| layer.active) {
		Some(layer) => layer_cursor(layer, window, document_width),
		None => frame_cursor(base, window),
	}
}

/// Translates a layer frame's cursor into screen coordinates.
fn layer_cursor(layer: &StoredLayer, window: Window, document_width: u16) -> Option<ScreenCursor> {
	let (col, row) = layer.frame.cursor()?;
	if col >= layer.frame.size().width
		|| row < layer.src_top
		|| row >= layer.src_top.saturating_add(layer.rows)
	{
		return None;
	}
	let screen_row = layer
		.document_y
		.saturating_sub(window.top)
		.saturating_add(row - layer.src_top);
	let screen_col = layer.x.saturating_add(col);
	(screen_row < window.height && screen_col < document_width)
		.then_some(ScreenCursor { row: screen_row, col: screen_col })
}

fn frame_cursor(frame: &Frame, window: Window) -> Option<ScreenCursor> {
	let (col, document_row) = frame.cursor()?;
	if col >= frame.size().width
		|| document_row < window.top
		|| document_row >= window.top.saturating_add(window.height)
	{
		return None;
	}
	Some(ScreenCursor { row: document_row - window.top, col })
}

#[inline(always)]
fn cells_equal(previous: &Cell, next: &Cell, hyperlinks: bool) -> bool {
	previous.content == next.content
		&& (previous.style == next.style
			|| (!hyperlinks && previous.style.without_link() == next.style.without_link()))
}

#[allow(clippy::too_many_arguments, reason = "diff inputs describe two composed viewport slices")]
fn emit_window_diff_rows(
	output: &mut String,
	previous: &ComposedFrame<'_>,
	previous_window: Window,
	next: &ComposedFrame<'_>,
	next_window: Window,
	screen_top: u16,
	screen_height: u16,
	dirty_rows: Option<&[(u16, u16)]>,
	graphics: Graphics,
	hyperlinks: bool,
	stats: &mut PaintStats,
) {
	let blank = Cell::blank(Style::default());
	let width = next.base.size().width;
	let mut active_style = Style::default();
	let mut cursor_row = screen_height - 1;

	for screen_y in 0..next_window.height {
		if let Some(rows) = dirty_rows
			&& !rows
				.iter()
				.any(|&(start, end)| start <= screen_y && screen_y < end)
		{
			continue;
		}
		let previous_y = previous_window.top.saturating_add(screen_y);
		let next_y = next_window.top.saturating_add(screen_y);
		// A zone-marked row is re-emitted whole so its OSC 133 markers
		// bracket the full row: when its cells changed, or when the mark
		// itself arrived on cells that did not.
		if row_zone_marked(next, next_y) {
			let marks_changed = !previous.base.row_mark(previous_y, RowMark::PromptStart)
				&& next.base.row_mark(next_y, RowMark::PromptStart)
				|| !previous.base.row_mark(previous_y, RowMark::PromptEnd)
					&& next.base.row_mark(next_y, RowMark::PromptEnd);
			let cells_changed = (0..width).any(|x| {
				!cells_equal(
					previous.cell_or(previous_y, x, &blank),
					next.cell_or(next_y, x, &blank),
					hyperlinks,
				)
			});
			if marks_changed || cells_changed {
				move_cursor_row(output, &mut cursor_row, screen_top.saturating_add(screen_y));
				output.push('\r');
				encode_row(output, next, next_y, graphics, hyperlinks);
				output.push_str(RESET_STYLE);
				active_style = Style::default();
				stats.runs += 1;
				stats.changed_cells += usize::from(width);
			}
			continue;
		}
		let mut x = 0;
		while x < width {
			if cells_equal(
				previous.cell_or(previous_y, x, &blank),
				next.cell_or(next_y, x, &blank),
				hyperlinks,
			) {
				x += 1;
				continue;
			}

			let mut start = x;
			while start > 0
				&& matches!(next.cell_or(next_y, start, &blank).content, CellContent::Continuation)
			{
				start -= 1;
			}

			let mut end = x + 1;
			stats.changed_cells += 1;
			while end < width {
				let previous_cell = previous.cell_or(previous_y, end, &blank);
				let next_cell = next.cell_or(next_y, end, &blank);
				if cells_equal(previous_cell, next_cell, hyperlinks) {
					break;
				}
				end += 1;
				stats.changed_cells += 1;
			}
			while end < width
				&& matches!(next.cell_or(next_y, end, &blank).content, CellContent::Continuation)
			{
				end += 1;
			}

			emit_run(
				output,
				next,
				Run { document_y: next_y, screen_y: screen_top.saturating_add(screen_y), start, end },
				&blank,
				&mut active_style,
				&mut cursor_row,
				graphics,
				hyperlinks,
			);
			stats.runs += 1;
			x = end;
		}
	}

	if stats.runs > 0 {
		output.push_str(RESET_STYLE);
		move_cursor_row(output, &mut cursor_row, screen_height - 1);
		output.push('\r');
	}
}

/// Appends relative vertical cursor motion and updates the tracked screen row.
pub fn move_cursor_row(output: &mut String, current: &mut u16, target: u16) {
	if target < *current {
		let _ = write!(output, esc!(cursor_up), *current - target);
	} else if target > *current {
		let _ = write!(output, esc!(cursor_down), target - *current);
	}
	*current = target;
}

fn emit_run(
	output: &mut String,
	frame: &ComposedFrame<'_>,
	run: Run,
	blank: &Cell,
	active_style: &mut Style,
	cursor_row: &mut u16,
	graphics: Graphics,
	hyperlinks: bool,
) {
	move_cursor_row(output, cursor_row, run.screen_y);
	output.push('\r');
	if run.start > 0 {
		let _ = write!(output, esc!(cursor_forward), run.start);
	}
	let mut x = run.start;

	while x < run.end {
		let cell = frame.cell_or(run.document_y, x, blank);
		match &cell.content {
			CellContent::Blank => {
				emit_cell_style(output, cell.style, active_style, hyperlinks);
				output.push(' ');
				x += 1;
			},
			CellContent::Grapheme { text, width } => {
				emit_cell_style(output, cell.style, active_style, hyperlinks);
				output.push_str(text);
				x = x.saturating_add(*width);
			},
			CellContent::Image { id, row, col, rows, cols } => {
				emit_image_cell(
					output,
					*id,
					*row,
					*col,
					*rows,
					*cols,
					active_style,
					graphics,
					hyperlinks,
				);
				x += 1;
			},
			CellContent::Continuation => x += 1,
		}
	}
	close_active_link(output, active_style, hyperlinks);
}
/// Whether the boundary between document rows `row` and `row + 1` may be
/// joined by terminal autowrap. The flag is the certification: painters
/// only set it for rows whose source content exactly fills the width (see
/// [`Frame::set_soft_wrap`]), which the renderer cannot re-verify — a real
/// trailing space and a padding cell are both stored as blanks.
///
/// Deliberately a pure document property: overlay layers composite on top
/// without changing it, so band movement never flips boundaries (which
/// would force viewport repaints), and the line attribute stays correct
/// for the raw rows an overlay only transiently covers.
#[inline]
fn wrap_joinable(frame: &ComposedFrame<'_>, row: u16) -> bool {
	frame.base.soft_wrap(row)
}

/// Re-prints the composed cell covering the final column of document row
/// `row` on the cursor's current line, arming the terminal's pending-wrap
/// state so the next printed glyph soft-wraps onto the following line.
/// Emitting the composed view keeps overlay layers intact. Requires DECAWM
/// to be enabled.
fn arm_wrap_boundary(
	output: &mut String,
	frame: &ComposedFrame<'_>,
	row: u16,
	graphics: Graphics,
	hyperlinks: bool,
) {
	let width = frame.base.size().width;
	let Some(last) = width.checked_sub(1) else {
		return;
	};
	let blank = Cell::blank(Style::default());
	// Walk left over continuation cells so a wide glyph is re-printed
	// whole from its head instead of being clobbered mid-cell.
	let mut x = last;
	let cell = loop {
		let cell = frame.cell_or(row, x, &blank);
		match &cell.content {
			CellContent::Continuation if x > 0 => x -= 1,
			_ => break cell,
		}
	};
	output.push('\r');
	if x > 0 {
		let _ = write!(output, esc!(cursor_forward), x);
	}
	output.push_str(RESET_STYLE);
	let mut active = Style::default();
	match &cell.content {
		CellContent::Grapheme { text, width: glyph }
			if x.saturating_add(*glyph) == width && *glyph > 0 =>
		{
			emit_cell_style(output, cell.style, &mut active, hyperlinks);
			output.push_str(text);
		},
		CellContent::Image { id, row: img_row, col, rows, cols } if x == last => {
			emit_image_cell(
				output,
				*id,
				*img_row,
				*col,
				*rows,
				*cols,
				&mut active,
				graphics,
				hyperlinks,
			);
		},
		_ => {
			// Blanks (or anything unprintable) still fill through the
			// final column, which is all the pending wrap needs.
			emit_cell_style(output, cell.style, &mut active, hyperlinks);
			for _ in x..width {
				output.push(' ');
			}
		},
	}
	close_active_link(output, &mut active, hyperlinks);
}
fn encode_frame_row(
	output: &mut String,
	frame: &ComposedFrame<'_>,
	row: u16,
	graphics: Graphics,
	hyperlinks: bool,
) {
	if row < frame.base.size().height {
		encode_row(output, frame, row, graphics, hyperlinks);
	} else {
		encode_blank_row(output, frame.base.size().width);
	}
}

/// OSC 133 shell integration around a prompt zone.
///
/// The zone is closed within the same paint: `133;B` latches a sticky
/// `.input` cursor semantic in Ghostty (and cmux) that only a command
/// marker clears, and a latched zone turns every left-click into
/// synthesized arrow keys under `cursor-click-to-move`. `133;C` followed
/// by `133;D;0` right after `133;B` clears it without grouping later
/// output under the prompt.
const OSC133_ZONE_START: &str = esc!(osc, "133;A", bel);
const OSC133_ZONE_CLOSE: &str = esc!(osc, "133;B", bel, osc, "133;C", bel, osc, "133;D;0", bel);

/// Whether document row `row` carries a zone mark. Like wrap joinability,
/// a pure document property: overlay layers never move a zone.
#[inline]
fn row_zone_marked(frame: &ComposedFrame<'_>, row: u16) -> bool {
	frame.base.row_mark(row, RowMark::PromptStart) || frame.base.row_mark(row, RowMark::PromptEnd)
}

fn encode_row(
	output: &mut String,
	frame: &ComposedFrame<'_>,
	row: u16,
	graphics: Graphics,
	hyperlinks: bool,
) {
	output.push_str(RESET_STYLE);
	if frame.base.row_mark(row, RowMark::PromptStart) {
		output.push_str(OSC133_ZONE_START);
	}
	let blank = Cell::blank(Style::default());
	let mut active_style = Style::default();
	let mut x = 0;
	while x < frame.base.size().width {
		let cell = frame.cell_or(row, x, &blank);
		match &cell.content {
			CellContent::Blank => {
				emit_cell_style(output, cell.style, &mut active_style, hyperlinks);
				output.push(' ');
				x += 1;
			},
			CellContent::Grapheme { text, width } => {
				emit_cell_style(output, cell.style, &mut active_style, hyperlinks);
				output.push_str(text);
				x = x.saturating_add(*width);
			},
			CellContent::Image { id, row, col, rows, cols } => {
				emit_image_cell(
					output,
					*id,
					*row,
					*col,
					*rows,
					*cols,
					&mut active_style,
					graphics,
					hyperlinks,
				);
				x += 1;
			},
			CellContent::Continuation => x += 1,
		}
	}
	close_active_link(output, &mut active_style, hyperlinks);
	if frame.base.row_mark(row, RowMark::PromptEnd) {
		output.push_str(OSC133_ZONE_CLOSE);
	}
}

#[allow(clippy::too_many_arguments, reason = "flat cell emission hot path")]
fn emit_image_cell(
	output: &mut String,
	id: u32,
	row: u16,
	col: u16,
	rows: u16,
	cols: u16,
	active_style: &mut Style,
	graphics: Graphics,
	hyperlinks: bool,
) {
	if graphics != Graphics::KittyPlaceholders {
		emit_cell_style(output, Style::default(), active_style, hyperlinks);
		output.push(' ');
		return;
	}
	let (placeholder, style) = placeholder_cell(id, row, col, rows, cols);
	emit_cell_style(output, style, active_style, hyperlinks);
	output.push_str(&placeholder);
}

fn encode_blank_row(output: &mut String, width: u16) {
	output.push_str(RESET_STYLE);
	for _ in 0..width {
		output.push(' ');
	}
}

pub fn emit_cell_style(
	output: &mut String,
	style: Style,
	active_style: &mut Style,
	hyperlinks: bool,
) {
	let link_changed = hyperlinks && active_style.link != style.link;
	if link_changed && active_style.link.is_some() {
		output.push_str(esc!(osc, "8;;", st));
	}
	let visual = style.without_link();
	if active_style.without_link() != visual {
		emit_style(output, visual);
	}
	if link_changed && let Some(id) = style.link {
		emit_link_open(output, id);
	}
	*active_style = style;
}

pub fn close_active_link(output: &mut String, active_style: &mut Style, hyperlinks: bool) {
	if hyperlinks && active_style.link.is_some() {
		output.push_str(esc!(osc, "8;;", st));
	}
	active_style.link = None;
}

fn emit_link_open(output: &mut String, id: LinkId) {
	let _ = with_link_url(id, |url| {
		let Some(url) = sanitize_link_target(url) else {
			return;
		};
		let _ = write!(output, esc!(osc, "8;id={};"), id.get());
		output.push_str(url);
		output.push_str(esc!(st));
	});
}

/// Rejects URI targets containing terminal control bytes.
///
/// OSC payloads are not an escaping context: dropping individual bytes can
/// turn an attacker-controlled target into a different valid URI, so an
/// unsafe target is rejected as a whole.
pub fn sanitize_link_target(target: &str) -> Option<&str> {
	(!target.is_empty() && !target.bytes().any(|byte| byte <= 0x1f || byte == 0x7f))
		.then_some(target)
}

/// Builds a percent-encoded `file://` OSC 8 target with optional `line` and `col` parameters.
///
/// Returns `None` when the current directory is unavailable for a relative path
/// or the target contains terminal control bytes.
pub fn file_link_target(path: &Path, line: Option<u32>, column: Option<u32>) -> Option<Str> {
	let absolute = if path.is_absolute() {
		path.to_path_buf()
	} else {
		env::current_dir().ok()?.join(path)
	};
	let raw = absolute.to_string_lossy();
	sanitize_link_target(&raw)?;
	let mut target = String::with_capacity(raw.len() + 32);
	target.push_str("file://");
	for byte in raw.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'.' | b'_' | b'~') {
			target.push(char::from(byte));
		} else {
			let _ = write!(target, "%{byte:02X}");
		}
	}
	if let Some(line) = line {
		let _ = write!(target, "?line={line}");
	}
	if let Some(column) = column {
		let separator = if line.is_some() { '&' } else { '?' };
		let _ = write!(target, "{separator}col={column}");
	}
	Some(Str::from(target))
}

pub fn emit_style(output: &mut String, style: Style) {
	let style = style.without_link();
	output.push_str(RESET_STYLE);
	if style == Style::default() {
		return;
	}

	output.push_str(esc!(csi));
	let mut first = true;
	push_style_parameters(output, style, &mut first);
	output.push('m');
}

/// Appends the renderer's canonical non-reset SGR parameters.
pub fn push_style_parameters(output: &mut String, style: Style, first: &mut bool) {
	if style.bold {
		push_parameter(output, first, "1");
	}
	if style.dim {
		push_parameter(output, first, "2");
	}
	if style.italic {
		push_parameter(output, first, "3");
	}
	match style.underline {
		Underline::None => {},
		Underline::Straight => push_parameter(output, first, "4"),
		Underline::Curly => push_parameter(output, first, "4:3"),
	}
	match style.underline_color {
		Color::Default => {},
		color => {
			if !*first {
				output.push(';');
			}
			*first = false;
			// Colon sub-parameter form per kitty; ghostty accepts both forms.
			match color {
				Color::Indexed(index) => {
					let _ = write!(output, "58:5:{index}");
				},
				Color::Rgb(red, green, blue) => {
					let _ = write!(output, "58:2::{red}:{green}:{blue}");
				},
				Color::Default => unreachable!("matched above"),
			}
		},
	}
	if style.reverse {
		push_parameter(output, first, "7");
	}
	if style.strikethrough {
		push_parameter(output, first, "9");
	}
	push_color_code(output, first, style.foreground, false);
	push_color_code(output, first, style.background, true);
}

fn push_parameter(output: &mut String, first: &mut bool, parameter: &str) {
	if !*first {
		output.push(';');
	}
	output.push_str(parameter);
	*first = false;
}

fn push_color_code(output: &mut String, first: &mut bool, color: Color, background: bool) {
	if color == Color::Default {
		return;
	}
	if !*first {
		output.push(';');
	}
	*first = false;

	let prefix = if background { 48 } else { 38 };
	match color {
		Color::Default => unreachable!("default colors returned before emission"),
		Color::Indexed(index) => {
			let _ = write!(output, "{prefix};5;{index}");
		},
		Color::Rgb(red, green, blue) => {
			let _ = write!(output, "{prefix};2;{red};{green};{blue}");
		},
	}
}

#[cfg(test)]
mod tests {
	use std::{
		io::{self, Write},
		mem,
	};

	use super::{
		ConptyChunks, MAX_CONPTY_WRITE_CHUNK_BYTES, MAX_OUTPUT_BACKLOG_BYTES, OutputBacklogGuard,
		RESET_HISTORY, Renderer, ResolvedLayer, SYNC_OUTPUT_BEGIN, SYNC_OUTPUT_END,
	};
	use crate::{
		Color, Frame, Graphics, Prop, RowMark, Size, Style,
		components::TextLeaf,
		slots::{Mode, ResizePolicy, Slots},
		test_support::TerminalModel,
	};

	fn frame(width: u16, lines: &[&str]) -> Frame {
		let mut frame =
			Frame::new(Size::new(width, u16::try_from(lines.len()).expect("small fixture")));
		for (row, line) in lines.iter().enumerate() {
			frame.put(0, u16::try_from(row).expect("small fixture"), line, Style::default());
		}
		frame
	}

	fn apply(renderer: &mut Renderer<Vec<u8>>, terminal: &mut TerminalModel) -> String {
		let output =
			String::from_utf8(mem::take(renderer.writer_mut())).expect("renderer emits UTF-8");
		terminal.apply(&output);
		output
	}

	#[derive(Default)]
	struct CountingWriter {
		writes:    usize,
		requested: Vec<usize>,
		bytes:     Vec<u8>,
	}

	impl Write for CountingWriter {
		fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
			self.writes += 1;
			self.requested.push(bytes.len());
			self.bytes.extend_from_slice(bytes);
			Ok(bytes.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	#[test]
	fn destructive_reset_emits_display_erase_before_scrollback_erase() {
		let mut renderer = Renderer::new(Vec::new());
		renderer.reset_history().unwrap();

		let output = String::from_utf8(mem::take(renderer.writer_mut())).unwrap();
		assert!(output.ends_with("\x1b[H\x1b[2J\x1b[3J"), "{output:?}");
		assert!(!output.contains("\x1b[3J\x1b[2J"), "{output:?}");
	}

	#[test]
	fn renderer_emits_osc133_around_marked_rows() {
		const START: &str = "\x1b]133;A\x07";
		const CLOSE: &str = "\x1b]133;B\x07\x1b]133;C\x07\x1b]133;D;0\x07";
		fn zone_order(output: &str) -> Option<(usize, usize)> {
			Some((output.find(START)?, output.find(CLOSE)?))
		}

		// Viewport paint: the zone opens before the first bubble row and
		// closes right after the last one, within the same paint.
		let mut renderer = Renderer::new(Vec::new());
		let mut bubble = frame(8, &["before", "hello", "world", "after"]);
		bubble.mark_row(1, RowMark::PromptStart);
		bubble.mark_row(2, RowMark::PromptEnd);
		renderer.present(bubble.clone(), 4, &[]).unwrap();
		let output = String::from_utf8(mem::take(renderer.writer_mut())).unwrap();
		let (start, close) = zone_order(&output).expect("zone markers present");
		let hello = output.find("hello").expect("first bubble row painted");
		let world = output.find("world").expect("last bubble row painted");
		assert!(start < hello && hello < world && world < close, "{output:?}");
		assert_eq!(output.matches(START).count(), 1, "{output:?}");
		assert_eq!(output.matches(CLOSE).count(), 1, "{output:?}");
		assert!(!output.contains("\x1b]133;B\x07\x1b]133;B"), "{output:?}");
		let mut terminal = TerminalModel::new(8, 4);
		terminal.apply(&output);
		assert_eq!(terminal.visible_rows(), ["before", "hello", "world", "after"]);

		// Damage diff: a mark arriving on unchanged cells still re-emits the
		// row with its markers.
		let mut marked_more = bubble.clone();
		marked_more.mark_row(3, RowMark::PromptEnd);
		renderer
			.present_damaged(&marked_more, &[(3, 4)], 4, &[])
			.unwrap();
		let output = String::from_utf8(mem::take(renderer.writer_mut())).unwrap();
		assert!(output.contains(CLOSE), "{output:?}");
		assert!(output.find("after").unwrap() < output.find(CLOSE).unwrap(), "{output:?}");
		assert!(!output.contains(START), "unmarked rows are not re-emitted: {output:?}");

		// History retirement: single-row frames carry their marks into
		// scrollback with the same ordering.
		let mut renderer = Renderer::new(Vec::new());
		let viewport = frame(8, &["view"]);
		let mut first = frame(8, &["hello"]);
		first.mark_row(0, RowMark::PromptStart);
		let mut last = frame(8, &["world"]);
		last.mark_row(0, RowMark::PromptEnd);
		renderer
			.append_history_rows(&[first, last], 2, &viewport, 1, &[])
			.unwrap();
		let output = String::from_utf8(mem::take(renderer.writer_mut())).unwrap();
		let (start, close) = zone_order(&output).expect("zone markers in history append");
		let hello = output.find("hello").unwrap();
		let world = output.find("world").unwrap();
		assert!(start < hello && hello < world && world < close, "{output:?}");
	}

	#[test]
	fn committed_history_materializes_cached_style_and_link_once() {
		let foreground = Color::Rgb(18, 52, 86);
		let target = "https://example.test/history";
		let mut slots = Slots::new(16, 2, ResizePolicy::Rebuild);
		let id = slots.open(Mode::Mutable);
		slots.set(
			id,
			TextLeaf::new()
				.text("colored")
				.with(Prop::Fg, foreground)
				.with(Prop::Bold, true)
				.with(Prop::Href, target),
		);
		slots.finalize(id);

		let mut renderer = Renderer::new(Vec::new());
		renderer.set_hyperlinks(true);
		let plan = slots.plan();
		let delivered = renderer.present_plan(&plan, &[]).expect("history delivery");
		slots.commit(plan, delivered);
		let output = String::from_utf8(mem::take(renderer.writer_mut())).expect("terminal UTF-8");
		assert_eq!(
			output.matches("38;2;18;52;86").count(),
			1,
			"foreground SGR is emitted only at final materialization: {output:?}",
		);
		assert_eq!(
			output.matches(target).count(),
			1,
			"the cached semantic link is materialized once: {output:?}",
		);
		assert!(output.contains("\x1b[0m"), "history delivery restores the terminal style");
		assert!(
			output.ends_with(SYNC_OUTPUT_END),
			"the reset is sealed inside the delivery transaction before control returns",
		);

		let paint_only = slots.plan();
		assert!(paint_only.rows().is_empty());
		renderer
			.present_plan(&paint_only, &[])
			.expect("history-neutral repaint");
		let repeated = String::from_utf8(mem::take(renderer.writer_mut())).expect("terminal UTF-8");
		assert!(!repeated.contains("38;2;18;52;86"));
		assert!(!repeated.contains(target));
	}

	#[test]
	fn repeated_present_preserves_history_byte_for_byte() {
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(8, 3);
		terminal.history.push("shell-before".to_owned());
		for lines in [
			&["one", "two", "three"][..],
			&["one!", "two", "three"][..],
			&["zero", "one!", "two", "three"][..],
			&["short"][..],
		] {
			renderer.present(frame(8, lines), 3, &[]).unwrap();
			apply(&mut renderer, &mut terminal);
			assert_eq!(terminal.history, ["shell-before"]);
		}
	}

	#[test]
	fn tall_present_is_bottom_clipped_without_scrolling() {
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(8, 2);
		renderer
			.present(frame(8, &["old", "top", "bottom"]), 2, &[])
			.unwrap();
		apply(&mut renderer, &mut terminal);
		assert!(terminal.history.is_empty());
		assert_eq!(terminal.visible_rows(), ["top", "bottom"]);
		assert_eq!(renderer.screen_text(), ["top", "bottom"]);
	}

	#[test]
	fn reset_history_clears_graphics_and_forces_a_full_repaint() {
		let painted = frame(8, &["same", "frame"]);
		let mut renderer = Renderer::new(Vec::new());
		renderer.present(painted.clone(), 2, &[]).unwrap();
		renderer.writer_mut().clear();
		renderer.register_image(7, [1_u8, 2, 3]).unwrap();

		renderer.reset_history().unwrap();
		let reset = String::from_utf8(mem::take(renderer.writer_mut())).unwrap();
		assert!(reset.contains("a=d,d=I,i=7,q=2"));
		assert!(reset.ends_with(RESET_HISTORY));
		assert!(renderer.screen_text().is_empty());
		assert_eq!(renderer.screen_cursor(), None);

		let stats = renderer.present(painted, 2, &[]).unwrap();
		assert!(stats.full_repaint);
		assert!(stats.bytes > 0);
	}

	#[test]
	fn resolved_layer_diffs_and_clear_restores_base_cells() {
		let base = frame(8, &["base000", "base111"]);
		let mut overlay = Frame::new(Size::new(2, 1));
		overlay.put(0, 0, "OV", Style::default());
		let layer = ResolvedLayer {
			frame:   &overlay,
			x:       2,
			y:       1,
			src_top: 0,
			rows:    1,
			active:  false,
		};
		let mut renderer = Renderer::new(Vec::new());
		let mut terminal = TerminalModel::new(8, 2);
		renderer.present_resolved(&base, &[], 2, &[layer]).unwrap();
		apply(&mut renderer, &mut terminal);
		assert_eq!(terminal.visible_rows(), ["base000", "baOV111"]);
		renderer.clear_layers().unwrap();
		apply(&mut renderer, &mut terminal);
		assert_eq!(terminal.visible_rows(), ["base000", "base111"]);
		assert!(terminal.history.is_empty());
	}

	#[test]
	fn active_layer_owns_cursor_and_passive_layer_releases_it() {
		let mut base = frame(8, &["base", "next"]);
		base.set_cursor(0, 0);
		let mut overlay = Frame::new(Size::new(2, 1));
		overlay.put(0, 0, "ov", Style::default());
		overlay.set_cursor(1, 0);
		let layer =
			|active| ResolvedLayer { frame: &overlay, x: 3, y: 1, src_top: 0, rows: 1, active };
		let mut renderer = Renderer::new(Vec::new());
		renderer
			.present_resolved(&base, &[], 2, &[layer(true)])
			.unwrap();
		assert_eq!(renderer.screen_cursor(), Some((1, 4)));
		renderer
			.present_resolved(&base, &[], 2, &[layer(false)])
			.unwrap();
		assert_eq!(renderer.screen_cursor(), Some((0, 0)));
	}

	#[test]
	fn damaged_present_updates_only_declared_rows() {
		let mut renderer = Renderer::new(Vec::new());
		renderer.present(frame(8, &["one", "two"]), 2, &[]).unwrap();
		renderer.writer_mut().clear();
		let next = frame(8, &["ignored", "changed"]);
		renderer.present_resolved(&next, &[(1, 2)], 2, &[]).unwrap();
		assert_eq!(renderer.screen_text(), ["one", "changed"]);
	}

	#[test]
	fn identical_viewport_writes_nothing() {
		let mut renderer = Renderer::new(Vec::new());
		renderer.present(frame(8, &["one", "two"]), 2, &[]).unwrap();
		renderer.writer_mut().clear();
		let stats = renderer.present(frame(8, &["one", "two"]), 2, &[]).unwrap();
		assert_eq!(stats, super::PaintStats::default());
		assert!(renderer.writer_mut().is_empty());
	}
	#[test]
	fn hardware_cursor_moves_without_repainting_cells() {
		let mut first = frame(8, &["one", "two"]);
		first.set_cursor(1, 1);
		let mut renderer = Renderer::new(Vec::new());
		renderer.present(first, 2, &[]).unwrap();
		renderer.writer_mut().clear();
		let mut second = frame(8, &["one", "two"]);
		second.set_cursor(4, 0);
		let stats = renderer.present(second, 2, &[]).unwrap();
		assert_eq!(stats.changed_cells, 0);
		assert_eq!(stats.runs, 0);
		assert!(stats.bytes > 0);
		assert_eq!(renderer.screen_cursor(), Some((0, 4)));
	}

	#[test]
	fn kitty_images_upload_place_and_materialize_cells() {
		let mut image = Frame::new(Size::new(3, 2));
		image.put_image_cell(0, 0, 0x12_34_56, 0, 0, 2, 3);
		image.put_image_cell(2, 1, 0x12_34_56, 1, 2, 2, 3);
		let mut renderer = Renderer::new(Vec::new());
		renderer
			.register_image(0x12_34_56, vec![0x5a; 3073])
			.unwrap();
		renderer.present(image, 2, &[]).unwrap();
		let output = String::from_utf8(renderer.into_inner()).unwrap();
		assert!(output.contains("a=t,i=1193046"));
		assert!(output.contains("a=p,U=1,i=1193046,p=1027,r=2,c=3"));
		assert!(output.contains("\u{10eeee}"));
	}

	#[test]
	fn iterm2_graphics_dispatches_registered_png() {
		let mut image = Frame::new(Size::new(2, 1));
		for col in 0..2 {
			image.put_image_cell(col, 0, 7, 0, col, 1, 2);
		}
		let mut renderer = Renderer::new(Vec::new());
		renderer.set_graphics(Graphics::Iterm2);
		renderer
			.register_image(7, b"\x89PNG\r\n\x1a\nsmall".to_vec())
			.unwrap();
		renderer.present(image, 1, &[]).unwrap();
		let output = String::from_utf8(renderer.into_inner()).unwrap();
		assert!(output.contains("\x1b]1337;File=inline=1;"));
	}

	#[test]
	fn synchronized_output_can_be_disabled_without_changing_payload() {
		let viewport = frame(8, &["one", "two"]);
		let mut synced = Renderer::new(Vec::new());
		let mut plain = Renderer::new(Vec::new());
		plain.set_sync_output(false);
		synced.present(viewport.clone(), 2, &[]).unwrap();
		plain.present(viewport, 2, &[]).unwrap();
		let synced = String::from_utf8(synced.into_inner()).unwrap();
		let plain = String::from_utf8(plain.into_inner()).unwrap();
		assert_eq!(
			synced
				.replace(SYNC_OUTPUT_BEGIN, "")
				.replace(SYNC_OUTPUT_END, ""),
			plain
		);
	}

	#[test]
	fn conpty_chunker_keeps_escape_sequences_whole() {
		let mut payload = vec![b'x'; MAX_CONPTY_WRITE_CHUNK_BYTES - 2];
		payload.extend_from_slice(b"\x1b[38;2;255;0;0mred");
		let chunks = ConptyChunks::new(&payload, MAX_CONPTY_WRITE_CHUNK_BYTES).collect::<Vec<_>>();
		assert_eq!(chunks.concat(), payload);
		assert!(chunks.iter().all(|chunk| !chunk.ends_with(b"\x1b")));
	}

	#[test]
	fn conpty_write_decision_is_injectable_on_every_test_platform() {
		let mut payload = vec![b'x'; MAX_CONPTY_WRITE_CHUNK_BYTES + 1];
		payload[MAX_CONPTY_WRITE_CHUNK_BYTES / 2] = b'\n';

		let mut direct = Renderer::with_conpty_hosted(CountingWriter::default(), false);
		direct.write_output(&payload).unwrap();
		let direct = direct.into_inner();

		let mut conpty = Renderer::with_conpty_hosted(CountingWriter::default(), true);
		conpty.write_output(&payload).unwrap();
		let conpty = conpty.into_inner();

		assert_ne!(direct.requested, conpty.requested);
		assert_eq!(direct.bytes, payload);
		assert_eq!(conpty.bytes, payload);
	}

	#[test]
	fn backlog_disconnects_only_after_sixty_four_mibibytes() {
		let mut guard = OutputBacklogGuard::default();
		assert!(!guard.queue(MAX_OUTPUT_BACKLOG_BYTES));
		assert!(guard.queue(1));
		guard.flushed();
		assert!(!guard.queue(1));
	}

	struct FailingWriter;

	impl io::Write for FailingWriter {
		fn write(&mut self, _buffer: &[u8]) -> io::Result<usize> {
			Err(io::Error::new(io::ErrorKind::BrokenPipe, "fixture failure"))
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	#[test]
	fn writer_failure_poisons_future_renderer_operations() {
		let mut renderer = Renderer::new(FailingWriter);
		let first = renderer.present(frame(4, &["one"]), 1, &[]).unwrap_err();
		assert_eq!(first.kind(), io::ErrorKind::BrokenPipe);
		let second = renderer.present(frame(4, &["two"]), 1, &[]).unwrap_err();
		assert_eq!(second.kind(), io::ErrorKind::Other);
	}
}
