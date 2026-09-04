//! The winit shell: windows → tabs → split panes, each pane driving its own
//! [`Scene`] in a decoration-less GPU window.
//!
//! One mailbox of winit events plus host-spawned clipboard reads; animation
//! ticks ride `ControlFlow::WaitUntil`, so idle scenes cost no frames.
//! Mux chords: ⌘… on macOS plus a kitty-style Ctrl+Shift layer:
//!
//! | Chord | Action |
//! |---|---|
//! | ⌘N / Ctrl+Shift+N / Ctrl+Enter | new window |
//! | ⌘T / Ctrl+Shift+T | new tab |
//! | ⌘D / Ctrl+Shift+Enter | split side by side |
//! | ⌘⇧D / Ctrl+Shift+O | split stacked |
//! | ⌘W / Ctrl+Shift+W | close pane (last pane closes tab, then window) |
//! | Ctrl+Shift+Q | close tab |
//! | Ctrl+Tab / Ctrl+Shift+Tab, Ctrl+Shift+←/→, ⌘⇧] / ⌘⇧[ | next/previous tab |
//! | ⌘1–9, Ctrl+Shift+1–9 (0 = last) | go to tab |
//! | Ctrl+Shift+. / Ctrl+Shift+, | move tab right/left |
//! | ⌘] / ⌘[, Ctrl+Shift+] / Ctrl+Shift+[ | cycle pane focus |
//! | ⌘⌥Arrow / Ctrl+Shift+⌥Arrow | directional pane focus |
//! | ⌘⌃Arrow | resize the focused split |
//! | Ctrl+Shift+C | copy selection |
//! | ⌘=/-/0, Ctrl+Shift+=/-/Backspace | font size |
//! | Ctrl+Shift+↑/↓, PgUp/PgDn, Home/End | scroll the focused pane |
//! | ⌘Q | quit |

use std::{
	env,
	ops::Range,
	sync::Arc,
	thread,
	time::{Duration, Instant},
};

use omp_core::Str;
use omp_tui::{
	Appearance, CellContent, Charset, DecorKind, Frame, Graphics, Key, Keymap, Mouse, MouseButton,
	MouseReport, Size, Style, UiContext,
	paste::{self, ClipboardRead, ClipboardReadOutcome, ClipboardWriteOutcome},
};
use smallvec::SmallVec;
use winit::{
	application::ApplicationHandler,
	dpi::{LogicalSize, PhysicalPosition, PhysicalSize},
	event::{ElementState, Ime, KeyEvent, MouseScrollDelta, WindowEvent},
	event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy},
	keyboard::{KeyCode, ModifiersState, PhysicalKey},
	window::{self, CursorIcon, Window, WindowId},
};

#[cfg(target_os = "macos")]
use crate::macos::polish;
use crate::{
	cells::{CellMetrics, Compositor, Selection, View},
	fonts::Fonts,
	gpu::{Gpu, Painter, RectInst, WindowGpu},
	input,
	mux::{self, Axis, Dir, Divider, Node, PaneId, Path, RectPx, Removed},
	scene::{Effect, Scene, SceneFrame},
	theme::GuiTheme,
};

/// Resize-gesture settle window: intermediate sizes paint cheap previews,
/// the full relayout fires once the drag goes quiet for this long.
const RESIZE_SETTLE: Duration = Duration::from_millis(120);

/// Logical margin between the window edge and the cell grid.
const MARGIN: f32 = 10.0;

/// Height of the invisible window-drag strip at the top edge, logical px.
const DRAG_STRIP: f32 = 6.0;

/// Logical gutter between split panes; the divider hairline runs inside it.
const GUTTER: f32 = 8.0;

/// Logical gap between the tab strip and the pane area below it.
const STRIP_GAP: f32 = 6.0;

/// Maximum delay between presses in one multi-click gesture.
const MULTI_CLICK_DELAY: Duration = Duration::from_millis(420);

/// Maximum pointer drift between presses in one multi-click gesture.
const MULTI_CLICK_DISTANCE: f32 = 6.0;

const fn native_appearance(theme: window::Theme) -> Appearance {
	match theme {
		window::Theme::Light => Appearance::Light,
		window::Theme::Dark => Appearance::Dark,
	}
}

/// Window and text configuration for one host run.
#[derive(Clone, Debug)]
pub struct HostConfig {
	/// Window title.
	pub title:        String,
	/// Font size at scale factor 1 (physical px = size × scale).
	pub font_size:    f32,
	/// Backdrop alpha, 0–1. `OMP_GUI_OPACITY` overrides at startup.
	pub opacity:      f32,
	/// GPU-native decoration; false renders glyph borders/fills like a terminal.
	pub native_decor: bool,
	/// Initial logical window size.
	pub size:         (f64, f64),
	/// Permit tabs, splits, and additional windows that each require a fresh
	/// scene.
	pub multiplex:    bool,
	/// Chord bindings shared with terminal input and generated hotkey help.
	pub keymap:       Keymap,
}

impl Default for HostConfig {
	fn default() -> Self {
		let opacity = env::var("OMP_GUI_OPACITY")
			.ok()
			.and_then(|value| value.parse::<f32>().ok())
			.unwrap_or(0.84);
		Self {
			title:        "omp".to_string(),
			font_size:    14.0,
			opacity:      opacity.clamp(0.1, 1.0),
			native_decor: true,
			size:         (1120.0, 720.0),
			multiplex:    true,
			keymap:       Keymap::default(),
		}
	}
}

/// Runs scenes built by `build` — one per pane — in GPU windows until the
/// last window closes. `build` seeds the first pane and runs again for
/// every new split, tab, and window when [`HostConfig::multiplex`] is enabled.
pub fn run<S: Scene>(config: HostConfig, build: impl Fn(&UiContext) -> S) {
	let event_loop = EventLoop::<UserEvent>::with_user_event()
		.build()
		.expect("event loop");
	event_loop.set_control_flow(ControlFlow::Wait);
	let proxy = event_loop.create_proxy();
	let mut shell = Shell { config, proxy, build, gpu: None, windows: Vec::new() };
	event_loop.run_app(&mut shell).expect("event loop run");
}

/// Host-spawned events riding the winit mailbox.
enum UserEvent {
	/// A background clipboard read completed for one window's pane.
	Clipboard(WindowId, PaneId, ClipboardReadOutcome, ClipboardRead),
	/// A background clipboard write completed for one window's pane.
	ClipboardWrite(WindowId, PaneId, ClipboardWriteOutcome),
}

/// One overlay band of the last paint, in viewport cells: `(x, y, w, rows)`.
type Bands = SmallVec<(u16, u16, u16, u16), 8>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SelectionMode {
	Char,
	Word,
	Line,
}

impl SelectionMode {
	const fn next(self) -> Self {
		match self {
			Self::Char => Self::Word,
			Self::Word => Self::Line,
			Self::Line => Self::Char,
		}
	}
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum CellClass {
	Word,
	Space,
	Punct,
}

fn cell_class(frame: &Frame, row: u16, col: u16) -> CellClass {
	let content = frame.cell(col, row).content();
	let character = match content {
		CellContent::Blank => return CellClass::Space,
		CellContent::Grapheme { text, .. } => text.chars().next(),
		CellContent::Image { .. } => return CellClass::Punct,
		CellContent::Continuation => {
			let mut head = col;
			loop {
				let Some(previous) = head.checked_sub(1) else {
					return CellClass::Punct;
				};
				head = previous;
				match frame.cell(head, row).content() {
					CellContent::Grapheme { text, .. } => break text.chars().next(),
					CellContent::Continuation => {},
					_ => return CellClass::Punct,
				}
			}
		},
	};
	match character {
		Some('_') => CellClass::Word,
		Some(character) if character.is_alphanumeric() => CellClass::Word,
		Some(character) if character.is_whitespace() => CellClass::Space,
		_ => CellClass::Punct,
	}
}

fn previous_cell(frame: &Frame, (row, col): (u16, u16)) -> Option<(u16, u16)> {
	if col > 0 {
		Some((row, col - 1))
	} else if row > 0 && frame.soft_wrap(row - 1) {
		Some((row - 1, frame.size().width - 1))
	} else {
		None
	}
}

fn next_cell(frame: &Frame, (row, col): (u16, u16)) -> Option<(u16, u16)> {
	if col + 1 < frame.size().width {
		Some((row, col + 1))
	} else if frame.soft_wrap(row) {
		Some((row + 1, 0))
	} else {
		None
	}
}

fn word_range(frame: &Frame, cell: (u16, u16)) -> ((u16, u16), (u16, u16)) {
	let class = cell_class(frame, cell.0, cell.1);
	let mut start = cell;
	while let Some(previous) = previous_cell(frame, start) {
		if cell_class(frame, previous.0, previous.1) != class {
			break;
		}
		start = previous;
	}
	let mut end = cell;
	while let Some(next) = next_cell(frame, end) {
		if cell_class(frame, next.0, next.1) != class {
			break;
		}
		end = next;
	}
	(start, end)
}

fn line_range(frame: &Frame, (row, _): (u16, u16)) -> ((u16, u16), (u16, u16)) {
	let mut start_row = row;
	while start_row > 0 && frame.soft_wrap(start_row - 1) {
		start_row -= 1;
	}
	let mut end_row = row;
	while frame.soft_wrap(end_row) {
		end_row += 1;
	}
	((start_row, 0), (end_row, frame.size().width - 1))
}

fn range_for_cell(
	frame: &Frame,
	mode: SelectionMode,
	cell: (u16, u16),
) -> Option<((u16, u16), (u16, u16))> {
	let size = frame.size();
	if size.width == 0 || cell.0 >= size.height || cell.1 >= size.width {
		return None;
	}
	Some(match mode {
		SelectionMode::Char => (cell, cell),
		SelectionMode::Word => word_range(frame, cell),
		SelectionMode::Line => line_range(frame, cell),
	})
}

fn selection_hull(
	anchor: ((u16, u16), (u16, u16)),
	focus: ((u16, u16), (u16, u16)),
	width: u16,
) -> Selection {
	let start = anchor.0.min(focus.0);
	let end = anchor.1.max(focus.1);
	Selection { start, end: (end.0, end.1.saturating_add(1).min(width)) }
}

fn selection_text(frame: &Frame, sel: Selection) -> String {
	let size = frame.size();
	if size.width == 0 || size.height == 0 || sel.start.0 >= size.height {
		return String::new();
	}
	let last_row = sel.end.0.min(size.height - 1);
	if sel.start.0 > last_row {
		return String::new();
	}

	let rows = usize::from(last_row) - usize::from(sel.start.0) + 1;
	let capacity = rows * usize::from(size.width);
	let mut text = String::with_capacity(capacity);
	for row in sel.start.0..=last_row {
		let start_col = if row == sel.start.0 {
			sel.start.1.min(size.width)
		} else {
			0
		};
		let end_col = if row == sel.end.0 {
			sel.end.1.min(size.width)
		} else {
			size.width
		};
		let row_start = text.len();
		// Cells inside `noselect` regions (HUD chrome) contribute nothing;
		// a row with no selectable cell vanishes entirely.
		let mut selectable_cells = false;
		for col in start_col..end_col {
			if !frame.selectable(col, row) {
				continue;
			}
			selectable_cells = true;
			match frame.cell(col, row).content() {
				CellContent::Blank => text.push(' '),
				CellContent::Grapheme { text: glyph, .. } => text.push_str(glyph),
				CellContent::Continuation | CellContent::Image { .. } => {},
			}
		}
		if !frame.soft_wrap(row) {
			while text.len() > row_start && text.as_bytes().last() == Some(&b' ') {
				text.pop();
			}
			if row != last_row && selectable_cells {
				text.push('\n');
			}
		}
	}
	text
}

/// Process-wide state: the shared GPU device plus every open window.
struct Shell<S, F> {
	config:  HostConfig,
	proxy:   EventLoopProxy<UserEvent>,
	build:   F,
	gpu:     Option<Gpu>,
	windows: Vec<WindowHost<S>>,
}

/// A pointer grab in progress, latched at press time.
#[derive(Clone)]
enum Grab {
	None,
	/// The press started on window chrome; its release is not a scene click.
	Chrome,
	/// Buttons report to this pane until release.
	Scene(PaneId),
	/// A press-started selection drag in this pane.
	Selecting(PaneId),
	/// A divider drag adjusting the split at `path`.
	Divider {
		path: Path,
	},
}

/// A tab-strip cell range's click target.
#[derive(Clone, Copy)]
enum StripHit {
	Tab(usize),
	Add,
}

/// A keyboard scroll request against the focused pane's transcript.
#[derive(Clone, Copy)]
enum ScrollTo {
	/// Cell rows; positive scrolls into history.
	Lines(f32),
	/// Viewport heights; positive scrolls into history.
	Pages(f32),
	/// Pin to the oldest row.
	Top,
	/// Snap back to the live tail.
	Tail,
}

/// One tab: a split tree over scene panes.
struct Tab<S> {
	layout:   Node,
	panes:    Vec<Pane<S>>,
	focused:  PaneId,
	dividers: SmallVec<Divider, 8>,
	/// Laid out against stale geometry; relayout on activation.
	stale:    bool,
}

/// One pane: a scene instance plus its viewport state.
struct Pane<S> {
	id:             PaneId,
	scene:          S,
	/// Assigned pane rect, physical px.
	rect:           RectPx,
	/// Top-left of the whole-cell grid centered in `rect`, physical px.
	origin:         [f32; 2],
	viewport:       Size,
	/// Transcript scroll offset from the tail, physical px.
	scroll:         f32,
	/// Last painted document height, for the scroll clamp.
	doc_rows:       u16,
	/// Z-ascending overlay bands of the last paint, for wheel routing.
	bands:          Bands,
	/// Document-tail rows owned by an editing widget in the last paint;
	/// plain drags there belong to the scene, not host selection.
	editor_rows:    u16,
	selection_mode: SelectionMode,
	/// Inclusive document-cell range established by the selection press.
	sel_anchor:     Option<((u16, u16), (u16, u16))>,
	selection:      Option<Selection>,
}

impl<S> Pane<S> {
	const fn new(id: PaneId, scene: S) -> Self {
		Self {
			id,
			scene,
			rect: RectPx { x: 0.0, y: 0.0, w: 0.0, h: 0.0 },
			origin: [0.0, 0.0],
			viewport: Size::new(0, 0),
			scroll: 0.0,
			doc_rows: 0,
			bands: SmallVec::new(),
			editor_rows: 0,
			selection_mode: SelectionMode::Char,
			sel_anchor: None,
			selection: None,
		}
	}
}

/// All state of one OS window: its GPU surface, chrome, and tabs of panes.
struct WindowHost<S> {
	id:                WindowId,
	window:            Arc<Window>,
	surface:           WindowGpu,
	painter:           Painter,
	fonts:             Fonts,
	compositor:        Compositor,
	ctx:               UiContext,
	theme:             GuiTheme,
	opacity:           f32,
	metrics:           CellMetrics,
	/// Physical font px including the scale factor.
	px:                f32,
	/// Logical font size; each window owns its ⌘=/⌘- state.
	font_size:         f32,
	tabs:              Vec<Tab<S>>,
	active:            usize,
	next_pane:         u32,
	/// The rendered tab strip; painted only with two or more tabs.
	strip:             Frame,
	/// Strip cell ranges → click targets.
	strip_hits:        SmallVec<(Range<u16>, StripHit), 8>,
	strip_origin:      [f32; 2],
	pointer:           [f32; 2],
	mods:              ModifiersState,
	keymap:            Keymap,
	grab:              Grab,
	/// Last cursor icon set, to skip redundant sets.
	cursor:            CursorIcon,
	last_select_press: Option<(Instant, [f32; 2])>,
	window_focused:    bool,
	ime_enabled:       bool,
	started:           Instant,
	blink_epoch:       Instant,
	next_tick:         Instant,
	/// Deadline of the next animation-driven repaint while `animating`.
	next_frame:        Instant,
	/// The last paint showed a time-continuous decor (shimmer); the host
	/// self-drives ~60 fps repaints instead of waiting for the scene tick.
	animating:         bool,
	settle:            Option<Instant>,
}

/// Pointer position → viewport cell of `pane`, clamped.
fn pane_cell<S>(pane: &Pane<S>, metrics: &CellMetrics, pointer: [f32; 2]) -> (u16, u16) {
	let [ox, oy] = pane.origin;
	let col = ((pointer[0] - ox) / metrics.advance).floor();
	let row = ((pointer[1] - oy) / metrics.line_height).floor();
	(
		col.clamp(0.0, f32::from(pane.viewport.width.saturating_sub(1))) as u16,
		row.clamp(0.0, f32::from(pane.viewport.height.saturating_sub(1))) as u16,
	)
}

/// Pointer position → document cell. Columns switch at the cell midpoint.
fn pane_doc_cell<S>(
	pane: &Pane<S>,
	metrics: &CellMetrics,
	pointer: [f32; 2],
) -> Option<(u16, u16)> {
	if pane.doc_rows == 0 || pane.viewport.width == 0 || pane.viewport.height == 0 {
		return None;
	}
	let [ox, _] = pane.origin;
	let (_, viewport_row) = pane_cell(pane, metrics, pointer);
	let col = ((pointer[0] - ox) / metrics.advance)
		.round()
		.clamp(0.0, f32::from(pane.viewport.width - 1)) as u16;
	let scroll_rows = pane.scroll / metrics.line_height;
	let end = (f32::from(pane.doc_rows) - scroll_rows).clamp(0.0, f32::from(pane.doc_rows));
	let start = (end - f32::from(pane.viewport.height)).max(0.0);
	let first = start.floor() as u16;
	Some((first.saturating_add(viewport_row).min(pane.doc_rows - 1), col))
}

/// Whether the pointer sits inside an overlay band of the pane's last
/// paint; wheel events there belong to the overlay, not the transcript.
fn pane_over_band<S>(pane: &Pane<S>, metrics: &CellMetrics, pointer: [f32; 2]) -> bool {
	let (col, row) = pane_cell(pane, metrics, pointer);
	pane
		.bands
		.iter()
		.rev()
		.any(|&(x, y, w, rows)| rows > 0 && col >= x && col < x + w && row >= y && row < y + rows)
}

/// Whether the pointer sits in the pane's editing-widget rows at the
/// document tail (only meaningful at `scroll == 0`).
fn pane_in_editor<S>(pane: &Pane<S>, metrics: &CellMetrics, pointer: [f32; 2]) -> bool {
	let (_, row) = pane_cell(pane, metrics, pointer);
	pane.editor_rows > 0 && row >= pane.viewport.height.saturating_sub(pane.editor_rows)
}

fn pane_max_scroll<S>(pane: &Pane<S>, metrics: &CellMetrics) -> f32 {
	f32::from(pane.doc_rows.saturating_sub(pane.viewport.height)) * metrics.line_height
}

/// Resolves the focused scene's retained caret to a physical input-method
/// candidate area. Active layers own the caret exactly as the compositor
/// does; otherwise the document cursor is translated through native
/// scrollback.
fn ime_cursor_area(
	scene: &SceneFrame<'_>,
	origin: [f32; 2],
	scroll: f32,
	metrics: &CellMetrics,
) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
	let layer_cursor = scene
		.layers
		.iter()
		.rev()
		.filter(|layer| layer.active)
		.find_map(|layer| {
			let (col, row) = layer.frame.cursor()?;
			let band = layer.band(scene.viewport);
			(row >= band.src_top && row < band.src_top.saturating_add(band.rows))
				.then_some((band.x.saturating_add(col), band.y.saturating_add(row - band.src_top)))
		});
	let (col, row) = match layer_cursor {
		Some(cursor) => cursor,
		None if scene.layers.iter().any(|layer| layer.active) => return None,
		None => {
			let (col, row) = scene.frame.cursor()?;
			let document_rows = scene.frame.size().height;
			let scroll_rows = scroll / metrics.line_height;
			let end = (f32::from(document_rows) - scroll_rows).clamp(0.0, f32::from(document_rows));
			let start = (end - f32::from(scene.viewport.height)).max(0.0);
			let viewport_row = f32::from(row) - start;
			if viewport_row < 0.0 || viewport_row >= f32::from(scene.viewport.height) {
				return None;
			}
			(col, viewport_row.floor() as u16)
		},
	};
	let position = PhysicalPosition::new(
		f32::mul_add(f32::from(col), metrics.advance, origin[0]).round() as i32,
		f32::mul_add(f32::from(row), metrics.line_height, origin[1]).round() as i32,
	);
	let size =
		PhysicalSize::new(metrics.advance.ceil().max(1.0) as u32, metrics.line_height.ceil() as u32);
	Some((position, size))
}

/// Arrow keycap → pane direction, for ⌘⌥/⌘⌃ chords.
fn dir_of(code: Option<KeyCode>) -> Option<Dir> {
	Some(match code? {
		KeyCode::ArrowLeft => Dir::Left,
		KeyCode::ArrowRight => Dir::Right,
		KeyCode::ArrowUp => Dir::Up,
		KeyCode::ArrowDown => Dir::Down,
		_ => return None,
	})
}

impl<S: Scene> WindowHost<S> {
	fn px_scale(&self) -> f32 {
		self.px / self.font_size.max(1.0)
	}

	fn tab(&self) -> &Tab<S> {
		&self.tabs[self.active]
	}

	fn tab_mut(&mut self) -> &mut Tab<S> {
		&mut self.tabs[self.active]
	}

	fn focused(&self) -> PaneId {
		self.tab().focused
	}

	fn pane(&self, id: PaneId) -> Option<&Pane<S>> {
		self.tab().panes.iter().find(|pane| pane.id == id)
	}

	fn pane_mut(&mut self, id: PaneId) -> Option<&mut Pane<S>> {
		self.tab_mut().panes.iter_mut().find(|pane| pane.id == id)
	}

	/// Repartitions the active tab into the window: strip row, pane rects,
	/// grid origins (centered whole-cell grids snapped to whole pixels so
	/// glyph quads stay filter-crisp), and viewports. `settled` propagates
	/// to scene resizes (final geometry vs. mid-gesture preview). Every
	/// other tab is marked stale and relayouts on activation.
	fn relayout(&mut self, settled: bool) {
		let size = self.window.inner_size();
		if size.width == 0 || size.height == 0 {
			return;
		}
		let scale = self.px_scale();
		let margin = MARGIN * scale;
		let mut content = RectPx {
			x: margin,
			y: margin,
			w: margin.mul_add(-2.0, size.width as f32).max(0.0),
			h: margin.mul_add(-2.0, size.height as f32).max(0.0),
		};
		if self.tabs.len() > 1 {
			self.strip_origin = [content.x, content.y];
			let dy = STRIP_GAP.mul_add(scale, self.metrics.line_height);
			content.y += dy;
			content.h = (content.h - dy).max(0.0);
			self.rebuild_strip();
		}
		let metrics = self.metrics;
		let gutter = GUTTER * scale;
		let active = self.active;
		let mut rects = SmallVec::new();
		let mut dividers = SmallVec::new();
		let tab = &mut self.tabs[active];
		mux::layout(&tab.layout, content, gutter, &mut rects, &mut dividers);
		tab.dividers = dividers;
		for (id, rect) in rects {
			let Some(pane) = tab.panes.iter_mut().find(|pane| pane.id == id) else {
				continue;
			};
			pane.rect = rect;
			let cols = (rect.w / metrics.advance).floor().max(1.0);
			let rows = (rect.h / metrics.line_height).floor().max(1.0);
			let viewport = Size::new(cols as u16, rows as u16);
			pane.origin = [
				f32::mul_add(cols.mul_add(-metrics.advance, rect.w), 0.5, rect.x).floor(),
				f32::mul_add(rows.mul_add(-metrics.line_height, rect.h), 0.5, rect.y).floor(),
			];
			if viewport != pane.viewport || settled {
				pane.viewport = viewport;
				pane.scene.resize(viewport, settled);
			}
		}
		for (index, tab) in self.tabs.iter_mut().enumerate() {
			if index != active {
				tab.stale = true;
			}
		}
	}

	/// Rebuilds the one-row tab strip: numbered labels plus a trailing `+`,
	/// recording cell ranges for click routing.
	fn rebuild_strip(&mut self) {
		let size = self.window.inner_size();
		let margin = MARGIN * self.px_scale();
		let cols = (margin.mul_add(-2.0, size.width as f32) / self.metrics.advance)
			.floor()
			.max(1.0) as u16;
		self.strip = Frame::new(Size::new(cols, 1));
		self.strip.clear(Style::new());
		self.strip_hits.clear();
		let mut x = 0;
		for index in 0..self.tabs.len() {
			let label = format!(" {} ", index + 1);
			let style = if index == self.active {
				Style::new().fg(self.ctx.theme.accent).bold().underline()
			} else {
				Style::new().fg(self.ctx.theme.muted)
			};
			let next = self.strip.put(x, 0, &label, style);
			self.strip_hits.push((x..next, StripHit::Tab(index)));
			x = next;
		}
		let next = self
			.strip
			.put(x, 0, " + ", Style::new().fg(self.ctx.theme.muted));
		self.strip_hits.push((x..next, StripHit::Add));
	}

	/// Font size change (⌘= / ⌘- / ⌘0): rasters and metrics rebuild, and
	/// every pane relayouts at the new geometry.
	fn refont(&mut self, size: f32, gpu: &Gpu) {
		self.font_size = size.clamp(8.0, 32.0);
		let scale = self.window.scale_factor() as f32;
		self.px = self.font_size * scale;
		self.fonts.clear_caches();
		self.metrics = self.fonts.cell_metrics(self.px);
		self.painter = Painter::new(gpu, self.surface.format());
		self.theme.corner_radius = 12.0 * scale;
		self.relayout(true);
	}

	fn activate_tab(&mut self, index: usize) {
		if index >= self.tabs.len() || index == self.active {
			return;
		}
		let prior = self.focused();
		if self.window_focused
			&& let Some(pane) = self.pane_mut(prior)
		{
			let _ = pane.scene.focus(false);
		}
		self.active = index;
		if self.window_focused {
			let focused = self.focused();
			if let Some(pane) = self.pane_mut(focused) {
				let _ = pane.scene.focus(true);
			}
		}
		if self.tabs[index].stale {
			self.tabs[index].stale = false;
			self.relayout(true);
		} else {
			self.rebuild_strip();
		}
		self.window.request_redraw();
	}

	fn cycle_tab(&mut self, forward: bool) {
		let len = self.tabs.len();
		if len < 2 {
			return;
		}
		let next = if forward {
			(self.active + 1) % len
		} else {
			(self.active + len - 1) % len
		};
		self.activate_tab(next);
	}

	/// Reorders the active tab by `delta` positions, clamped to the ends.
	fn move_tab(&mut self, delta: isize) {
		let len = self.tabs.len() as isize;
		let target = (self.active as isize + delta).clamp(0, len - 1) as usize;
		if target == self.active {
			return;
		}
		self.tabs.swap(self.active, target);
		self.active = target;
		self.rebuild_strip();
		self.window.request_redraw();
	}

	/// Scrolls the focused pane's transcript by keyboard.
	fn scroll_focused(&mut self, to: ScrollTo) {
		let metrics = self.metrics;
		let focused = self.focused();
		let Some(pane) = self.pane_mut(focused) else {
			return;
		};
		let max = pane_max_scroll(pane, &metrics);
		pane.scroll = match to {
			ScrollTo::Lines(lines) => f32::mul_add(lines, metrics.line_height, pane.scroll),
			ScrollTo::Pages(pages) => {
				f32::mul_add(pages * f32::from(pane.viewport.height), metrics.line_height, pane.scroll)
			},
			ScrollTo::Top => max,
			ScrollTo::Tail => 0.0,
		}
		.clamp(0.0, max);
		self.window.request_redraw();
	}

	fn focus_pane(&mut self, id: PaneId) {
		let prior = self.tab().focused;
		if prior != id && self.pane(id).is_some() {
			if self.window_focused
				&& let Some(pane) = self.pane_mut(prior)
			{
				let _ = pane.scene.focus(false);
			}
			self.tab_mut().focused = id;
			if self.window_focused
				&& let Some(pane) = self.pane_mut(id)
			{
				let _ = pane.scene.focus(true);
			}
			self.blink_epoch = Instant::now();
			self.window.request_redraw();
		}
	}

	/// Moves focus to the next/previous pane in the split tree's DFS order.
	fn cycle_pane(&mut self, forward: bool) {
		let tab = self.tab();
		let mut order = SmallVec::<PaneId, 8>::new();
		tab.layout.leaves(&mut order);
		let Some(index) = order.iter().position(|&id| id == tab.focused) else {
			return;
		};
		let next = if forward {
			(index + 1) % order.len()
		} else {
			(index + order.len() - 1) % order.len()
		};
		self.focus_pane(order[next]);
	}

	fn focus_neighbor(&mut self, dir: Dir) {
		let tab = self.tab();
		let rects: SmallVec<(PaneId, RectPx), 8> =
			tab.panes.iter().map(|pane| (pane.id, pane.rect)).collect();
		if let Some(id) = mux::neighbor(&rects, tab.focused, dir) {
			self.focus_pane(id);
		}
	}

	/// Keyboard split resize: nudges the nearest ancestor split on the
	/// arrow's axis by one cell.
	fn resize_split(&mut self, dir: Dir) {
		let axis = match dir {
			Dir::Left | Dir::Right => Axis::X,
			Dir::Up | Dir::Down => Axis::Y,
		};
		let gutter = GUTTER * self.px_scale();
		let metrics = self.metrics;
		let tab = self.tab();
		let Some(path) = tab.layout.resize_target(tab.focused, axis) else {
			return;
		};
		let Some(divider) = tab.dividers.iter().find(|d| d.path == path) else {
			return;
		};
		let region = divider.region;
		let step = match axis {
			Axis::X => metrics.advance / (region.w - gutter).max(1.0),
			Axis::Y => metrics.line_height / (region.h - gutter).max(1.0),
		};
		let delta = match dir {
			Dir::Left | Dir::Up => -step,
			Dir::Right | Dir::Down => step,
		};
		if let Some(ratio) = self.tab_mut().layout.ratio_mut(&path) {
			*ratio = mux::clamp_ratio(region, axis, gutter, *ratio + delta);
		}
		self.relayout(true);
		self.window.request_redraw();
	}

	/// Recomputes a dragged divider's ratio from the pointer position and
	/// relayouts a preview; the settle timer fires the full relayout.
	fn drag_divider(&mut self, path: &Path) {
		let gutter = GUTTER * self.px_scale();
		let pointer = self.pointer;
		let Some(divider) = self.tab().dividers.iter().find(|d| d.path == *path) else {
			return;
		};
		let (region, axis) = (divider.region, divider.axis);
		let ratio = match axis {
			Axis::X => (pointer[0] - region.x) / (region.w - gutter).max(1.0),
			Axis::Y => (pointer[1] - region.y) / (region.h - gutter).max(1.0),
		};
		let ratio = mux::clamp_ratio(region, axis, gutter, ratio.clamp(0.0, 1.0));
		if let Some(slot) = self.tab_mut().layout.ratio_mut(path) {
			*slot = ratio;
		}
		self.relayout(false);
		self.settle = Some(Instant::now() + RESIZE_SETTLE);
	}

	fn pane_at(&self, pointer: [f32; 2]) -> Option<PaneId> {
		self
			.tab()
			.panes
			.iter()
			.find(|pane| pane.rect.contains(pointer))
			.map(|pane| pane.id)
	}

	fn divider_at(&self, pointer: [f32; 2]) -> Option<&Divider> {
		self
			.tab()
			.dividers
			.iter()
			.find(|divider| divider.rect.contains(pointer))
	}

	fn strip_hit(&self, pointer: [f32; 2]) -> Option<StripHit> {
		if self.tabs.len() < 2 {
			return None;
		}
		let [ox, oy] = self.strip_origin;
		if pointer[1] < oy || pointer[1] >= oy + self.metrics.line_height || pointer[0] < ox {
			return None;
		}
		let col = ((pointer[0] - ox) / self.metrics.advance).floor() as u16;
		self
			.strip_hits
			.iter()
			.find(|(range, _)| range.contains(&col))
			.map(|&(_, hit)| hit)
	}

	fn begin_selection(&mut self, id: PaneId) -> bool {
		let metrics = self.metrics;
		let pointer = self.pointer;
		let Some(cell) = self
			.pane(id)
			.and_then(|pane| pane_doc_cell(pane, &metrics, pointer))
		else {
			return false;
		};
		let now = Instant::now();
		let consecutive = self.last_select_press.is_some_and(|(last, position)| {
			now.saturating_duration_since(last) <= MULTI_CLICK_DELAY
				&& (pointer[1] - position[1])
					.mul_add(pointer[1] - position[1], (pointer[0] - position[0]).powi(2))
					<= MULTI_CLICK_DISTANCE.powi(2)
		});
		self.last_select_press = Some((now, pointer));
		let Some(pane) = self.pane_mut(id) else {
			return false;
		};
		pane.selection_mode = if consecutive {
			pane.selection_mode.next()
		} else {
			SelectionMode::Char
		};
		let mode = pane.selection_mode;
		let Some((anchor, width)) = ({
			let frame = pane.scene.render().frame;
			range_for_cell(frame, mode, cell).map(|range| (range, frame.size().width))
		}) else {
			return false;
		};
		pane.sel_anchor = Some(anchor);
		// A char-mode press arms the anchor without painting a one-cell
		// highlight; the selection materializes once the drag spans cells.
		pane.selection = (mode != SelectionMode::Char).then(|| selection_hull(anchor, anchor, width));
		true
	}

	fn update_selection_focus(&mut self, id: PaneId) -> bool {
		let metrics = self.metrics;
		let pointer = self.pointer;
		let Some(pane) = self.pane_mut(id) else {
			return false;
		};
		let Some(anchor) = pane.sel_anchor else {
			return false;
		};
		let Some(cell) = pane_doc_cell(pane, &metrics, pointer) else {
			return false;
		};
		let mode = pane.selection_mode;
		let Some((focus, width)) = ({
			let frame = pane.scene.render().frame;
			range_for_cell(frame, mode, cell).map(|range| (range, frame.size().width))
		}) else {
			return false;
		};
		let selection = (mode != SelectionMode::Char || focus != anchor)
			.then(|| selection_hull(anchor, focus, width));
		if pane.selection == selection {
			false
		} else {
			pane.selection = selection;
			true
		}
	}

	fn drag_selection(&mut self, id: PaneId) -> bool {
		let metrics = self.metrics;
		let pointer = self.pointer;
		let scrolled = {
			let Some(pane) = self.pane_mut(id) else {
				return false;
			};
			let oy = pane.origin[1];
			let bottom = f32::mul_add(f32::from(pane.viewport.height), metrics.line_height, oy);
			let overshoot = if pointer[1] < oy {
				oy - pointer[1]
			} else if pointer[1] > bottom {
				bottom - pointer[1]
			} else {
				0.0
			};
			let previous = pane.scroll;
			let max = pane_max_scroll(pane, &metrics);
			pane.scroll = f32::mul_add(overshoot, 0.35, pane.scroll).clamp(0.0, max);
			pane.scroll != previous
		};
		self.update_selection_focus(id) || scrolled
	}

	fn copy_selection(&mut self, id: PaneId) {
		let Some(pane) = self.pane_mut(id) else {
			return;
		};
		let Some(selection) = pane.selection else {
			return;
		};
		let text = {
			let frame = pane.scene.render().frame;
			selection_text(frame, selection)
		};
		write_clipboard_detached(text.into());
	}

	fn select_all(&mut self, id: PaneId) {
		let Some(pane) = self.pane_mut(id) else {
			return;
		};
		let size = pane.scene.render().frame.size();
		pane.selection = (size.width > 0 && size.height > 0)
			.then_some(Selection { start: (0, 0), end: (size.height - 1, size.width) });
		pane.sel_anchor = None;
	}

	fn report(
		&self,
		id: PaneId,
		kind: Mouse,
		button: MouseButton,
		pressed: bool,
	) -> Option<MouseReport> {
		let pane = self.pane(id)?;
		let (col, row) = pane_cell(pane, &self.metrics, self.pointer);
		Some(MouseReport { kind, col, row, button, mods: input::modifiers(self.mods), pressed })
	}

	fn paint(&mut self, gpu: &Gpu) {
		let size = self.window.inner_size();
		if size.width == 0 || size.height == 0 {
			return;
		}
		let window = Arc::clone(&self.window);
		let track_ime = self.window_focused && self.ime_enabled;
		let metrics = self.metrics;
		let theme = self.theme;
		let px = self.px;
		let hairline = self.px_scale().max(1.0);
		let blink = (self.blink_epoch.elapsed().as_millis() / 530).is_multiple_of(2);
		let now = self.started.elapsed();
		let viewport = [size.width as f32, size.height as f32];
		let Self {
			compositor,
			fonts,
			painter,
			surface,
			tabs,
			active,
			strip,
			strip_origin,
			animating,
			..
		} = self;
		compositor.begin(viewport, &theme);

		let tab = &mut tabs[*active];
		let focused = tab.focused;
		let mut shimmer = false;
		let mut ime_area = None;
		for pane in &mut tab.panes {
			let scene_frame = pane.scene.render();
			if track_ime && pane.id == focused {
				ime_area = ime_cursor_area(&scene_frame, pane.origin, pane.scroll, &metrics);
			}
			let doc_rows = scene_frame.frame.size().height;
			let doc_width = scene_frame.frame.size().width;
			let mut selection = pane.selection;
			if let Some(mut sel) = selection {
				if doc_width == 0 || doc_rows == 0 || sel.start.0 >= doc_rows {
					selection = None;
				} else {
					sel.start.1 = sel.start.1.min(doc_width - 1);
					if sel.end.0 >= doc_rows {
						sel.end = (doc_rows - 1, doc_width);
					} else {
						sel.end.1 = sel.end.1.min(doc_width);
					}
					selection = (sel.start.0 < sel.end.0 || sel.start.1 < sel.end.1).then_some(sel);
				}
				if selection.is_none() {
					pane.sel_anchor = None;
				}
			}
			pane.selection = selection;
			let max_scroll =
				f32::from(doc_rows.saturating_sub(pane.viewport.height)) * metrics.line_height;
			pane.scroll = pane.scroll.clamp(0.0, max_scroll);
			let editor_rows = scene_frame.editor_rows;
			let bands: Bands = scene_frame
				.layers
				.iter()
				.map(|layer| {
					let band = layer.band(pane.viewport);
					(band.x, band.y, layer.frame.size().width, band.rows)
				})
				.collect();
			let shimmering = |frame: &Frame| {
				frame
					.decors()
					.iter()
					.any(|d| matches!(d.kind, DecorKind::Shimmer { .. }))
			};
			shimmer |= shimmering(scene_frame.frame)
				|| scene_frame
					.layers
					.iter()
					.any(|layer| shimmering(layer.frame));
			let view = View {
				window: viewport,
				origin: pane.origin,
				scroll: pane.scroll,
				selection: pane.selection,
				cursor_on: pane.id == focused && blink,
				now,
			};
			compositor.pane(&scene_frame, fonts, &theme, &view, px);
			drop(scene_frame);
			pane.doc_rows = doc_rows;
			pane.editor_rows = editor_rows;
			pane.bands = bands;
		}
		*animating = shimmer;

		let ink = [theme.muted[0], theme.muted[1], theme.muted[2], 0.35];
		let mut hairlines: SmallVec<RectInst, 8> = SmallVec::new();
		for divider in &tab.dividers {
			let rect = divider.rect;
			hairlines.push(match divider.axis {
				Axis::X => RectInst::fill(
					[(rect.w - hairline).mul_add(0.5, rect.x), rect.y],
					[hairline, rect.h],
					ink,
				),
				Axis::Y => RectInst::fill(
					[rect.x, (rect.h - hairline).mul_add(0.5, rect.y)],
					[rect.w, hairline],
					ink,
				),
			});
		}
		compositor.rects(&hairlines);

		if tabs.len() > 1 {
			let strip_frame = SceneFrame {
				frame:       strip,
				viewport:    strip.size(),
				editor_rows: 0,
				layers:      SmallVec::new(),
			};
			let view = View {
				window: viewport,
				origin: *strip_origin,
				scroll: 0.0,
				selection: None,
				cursor_on: false,
				now,
			};
			compositor.pane(&strip_frame, fonts, &theme, &view, px);
		}

		let instances = compositor.finish();
		let (mask, color) = fonts.take_uploads();
		painter.upload_atlas(gpu, &mask, &color);
		let Some(target) = surface.acquire(gpu) else {
			return;
		};
		let target_view = target
			.texture
			.create_view(&wgpu::TextureViewDescriptor::default());
		painter.draw(
			gpu,
			&target_view,
			size.width,
			size.height,
			&instances.batches,
			&instances.rects,
			&instances.glyphs,
		);
		gpu.queue.present(target);
		if let Some((position, size)) = ime_area {
			window.set_ime_cursor_area(position, size);
		}
	}
}

impl<S: Scene, F: Fn(&UiContext) -> S> Shell<S, F> {
	fn window_index(&self, id: WindowId) -> Option<usize> {
		self.windows.iter().position(|win| win.id == id)
	}

	/// Opens a window seeded with one tab holding one fresh pane. `size` is
	/// the spawning window's logical size, or the config default.
	#[tracing::instrument(
		name = "window_initialize",
		level = "debug",
		skip_all,
		fields(existing_windows = self.windows.len())
	)]
	fn spawn_window(&mut self, el: &ActiveEventLoop, size: Option<LogicalSize<f64>>) {
		if !self.config.multiplex && !self.windows.is_empty() {
			return;
		}
		let size = size.unwrap_or_else(|| LogicalSize::new(self.config.size.0, self.config.size.1));
		let attrs = Window::default_attributes()
			.with_title(&self.config.title)
			.with_inner_size(size)
			.with_min_inner_size(LogicalSize::new(320.0, 200.0))
			.with_transparent(true)
			.with_decorations(false)
			.with_resizable(true);
		let window = Arc::new(el.create_window(attrs).expect("window"));
		window.set_ime_allowed(true);
		#[cfg(target_os = "macos")]
		if env::var_os("OMP_GUI_NO_CHROME").is_none() {
			polish(&window);
		}

		if self.gpu.is_none() {
			self.gpu = Some(Gpu::new(None).expect("gpu"));
		}
		let gpu = self.gpu.as_ref().expect("gpu");
		let surface = WindowGpu::new(gpu, Arc::clone(&window)).expect("surface");
		let painter = Painter::new(gpu, surface.format());
		let mut fonts = Fonts::new().expect("fonts");
		let scale = window.scale_factor() as f32;
		let font_size = self.config.font_size;
		let px = font_size * scale;
		let metrics = fonts.cell_metrics(px);

		let charset = if fonts.has_nerd_font() {
			Charset::NerdFont
		} else {
			Charset::Unicode
		};
		let mut ctx = UiContext::default();
		ctx.charset = charset;
		ctx.graphics = Graphics::KittyPlaceholders;
		ctx.native_decor = self.config.native_decor;
		if let Some(theme) = window.theme() {
			ctx.apply_appearance(native_appearance(theme));
		}
		let mut theme = GuiTheme::from_ctx(&ctx, self.config.opacity);
		theme.corner_radius = 12.0 * scale;

		let scene = (self.build)(&ctx);
		let seed = PaneId(0);
		let now = Instant::now();
		let window_focused = window.has_focus();
		let mut host = WindowHost {
			id: window.id(),
			window,
			surface,
			painter,
			fonts,
			compositor: Compositor::default(),
			ctx,
			theme,
			opacity: self.config.opacity,
			metrics,
			px,
			font_size,
			tabs: vec![Tab {
				layout:   Node::Leaf(seed),
				panes:    vec![Pane::new(seed, scene)],
				focused:  seed,
				dividers: SmallVec::new(),
				stale:    false,
			}],
			active: 0,
			next_pane: 1,
			strip: Frame::new(Size::new(0, 0)),
			strip_hits: SmallVec::new(),
			strip_origin: [0.0, 0.0],
			pointer: [0.0, 0.0],
			mods: ModifiersState::default(),
			keymap: self.config.keymap.clone(),
			grab: Grab::None,
			cursor: CursorIcon::Default,
			last_select_press: None,
			window_focused,
			ime_enabled: false,
			started: now,
			blink_epoch: now,
			next_tick: now,
			next_frame: now,
			animating: false,
			settle: None,
		};
		host.relayout(true);
		host.window.request_redraw();
		self.windows.push(host);
	}

	/// Appends and activates a tab holding one fresh pane.
	fn new_tab(&mut self, widx: usize) {
		if !self.config.multiplex {
			return;
		}
		let scene = (self.build)(&self.windows[widx].ctx);
		let win = &mut self.windows[widx];
		let id = PaneId(win.next_pane);
		win.next_pane += 1;
		win.tabs.push(Tab {
			layout:   Node::Leaf(id),
			panes:    vec![Pane::new(id, scene)],
			focused:  id,
			dividers: SmallVec::new(),
			stale:    false,
		});
		win.active = win.tabs.len() - 1;
		win.relayout(true);
		win.window.request_redraw();
	}

	/// Splits the focused pane, focusing the fresh half; a no-op when the
	/// pane cannot fit two minimum-size children plus the gutter.
	fn split(&mut self, widx: usize, axis: Axis) {
		if !self.config.multiplex {
			return;
		}
		let win = &self.windows[widx];
		let gutter = GUTTER * win.px_scale();
		let focused = win.focused();
		let Some(pane) = win.pane(focused) else {
			return;
		};
		let extent = match axis {
			Axis::X => pane.rect.w,
			Axis::Y => pane.rect.h,
		};
		if extent < mux::MIN_PANE.mul_add(2.0, gutter) {
			return;
		}
		let scene = (self.build)(&win.ctx);
		let win = &mut self.windows[widx];
		let id = PaneId(win.next_pane);
		win.next_pane += 1;
		let tab = win.tab_mut();
		if !tab.layout.split(focused, axis, id) {
			return;
		}
		tab.panes.push(Pane::new(id, scene));
		tab.focused = id;
		win.blink_epoch = Instant::now();
		win.relayout(true);
		win.window.request_redraw();
	}

	/// Closes one pane; a collapsing tab is removed, an emptied window is
	/// dropped, and the last window exits the app.
	fn close_pane(&mut self, el: &ActiveEventLoop, window: WindowId, pane: PaneId) {
		let Some(widx) = self.window_index(window) else {
			return;
		};
		let win = &mut self.windows[widx];
		let Some(tidx) = win
			.tabs
			.iter()
			.position(|tab| tab.panes.iter().any(|p| p.id == pane))
		else {
			return;
		};
		match win.tabs[tidx].layout.remove(pane) {
			Removed::Missing => {},
			Removed::Collapsed(next) => {
				let tab = &mut win.tabs[tidx];
				tab.panes.retain(|p| p.id != pane);
				if tab.focused == pane {
					tab.focused = next;
				}
				if tidx == win.active {
					win.relayout(true);
				} else {
					tab.stale = true;
				}
				win.window.request_redraw();
			},
			Removed::Root => self.remove_tab(el, widx, tidx),
		}
	}

	/// Removes one tab outright; an emptied window is dropped and the last
	/// window exits the app.
	fn remove_tab(&mut self, el: &ActiveEventLoop, widx: usize, tidx: usize) {
		let win = &mut self.windows[widx];
		if tidx >= win.tabs.len() {
			return;
		}
		win.tabs.remove(tidx);
		if win.tabs.is_empty() {
			self.windows.remove(widx);
			if self.windows.is_empty() {
				el.exit();
			}
			return;
		}
		if win.active >= win.tabs.len() {
			win.active = win.tabs.len() - 1;
		} else if tidx < win.active {
			win.active -= 1;
		}
		win.tabs[win.active].stale = false;
		win.relayout(true);
		win.window.request_redraw();
	}

	fn request_clipboard(&self, window: WindowId, pane: PaneId, scope: ClipboardRead) {
		let proxy = self.proxy.clone();
		thread::spawn(move || {
			let receiver = paste::spawn_clipboard_read(scope);
			let outcome = receiver
				.blocking_recv()
				.unwrap_or(ClipboardReadOutcome::ReadFailure);
			let _ = proxy.send_event(UserEvent::Clipboard(window, pane, outcome, scope));
		});
	}

	fn handle_effect(
		&mut self,
		el: &ActiveEventLoop,
		window: WindowId,
		pane: PaneId,
		effect: Effect,
	) {
		match effect {
			Effect::Ignored | Effect::Consumed => {},
			Effect::Quit => self.close_pane(el, window, pane),
			Effect::Clipboard(scope) => self.request_clipboard(window, pane, scope),
			Effect::SetClipboard(text) => self.request_clipboard_write(window, pane, text),
		}
	}

	fn request_clipboard_write(&self, window: WindowId, pane: PaneId, text: Str) {
		let proxy = self.proxy.clone();
		let worker_proxy = proxy.clone();
		if thread::Builder::new()
			.name("clipboard-write".into())
			.spawn(move || {
				let outcome = paste::write_clipboard_text(&text);
				let _ = worker_proxy.send_event(UserEvent::ClipboardWrite(window, pane, outcome));
			})
			.is_err()
		{
			let _ = proxy.send_event(UserEvent::ClipboardWrite(
				window,
				pane,
				ClipboardWriteOutcome::WriteFailure,
			));
		}
	}

	/// Intercepts mux chords ahead of [`input::map_key`]. ⌘ chords are
	/// always swallowed (matching the old host); Ctrl+Shift chords fall
	/// through to the scene unless they match the mux set, preserving
	/// Ctrl+Shift+V and friends.
	fn mux_key(&mut self, el: &ActiveEventLoop, widx: usize, event: &KeyEvent) -> bool {
		let win = &self.windows[widx];
		let wid = win.id;
		let mods = win.mods;
		let focused = win.focused();
		let letter = input::letter_of(event.physical_key);
		let code = match event.physical_key {
			PhysicalKey::Code(code) => Some(code),
			_ => None,
		};
		if mods.super_key() {
			if let Some(dir) = dir_of(code) {
				let win = &mut self.windows[widx];
				if mods.alt_key() {
					win.focus_neighbor(dir);
				} else if mods.control_key() {
					win.resize_split(dir);
				}
				return true;
			}
			match (letter, mods.shift_key()) {
				(Some('q'), _) => el.exit(),
				(Some('n'), _) => {
					let win = &self.windows[widx];
					let size = win
						.window
						.inner_size()
						.to_logical::<f64>(win.window.scale_factor());
					self.spawn_window(el, Some(size));
				},
				(Some('t'), _) => self.new_tab(widx),
				(Some('d'), false) => self.split(widx, Axis::X),
				(Some('d'), true) => self.split(widx, Axis::Y),
				(Some('w'), _) => self.close_pane(el, wid, focused),
				(Some(']'), true) => self.windows[widx].cycle_tab(true),
				(Some('['), true) => self.windows[widx].cycle_tab(false),
				(Some(']'), false) => self.windows[widx].cycle_pane(true),
				(Some('['), false) => self.windows[widx].cycle_pane(false),
				(Some('0'), _) => {
					let gpu = self.gpu.as_ref().expect("gpu");
					self.windows[widx].refont(14.0, gpu);
				},
				(Some(digit @ '1'..='9'), _) => {
					let index = digit as usize - '1' as usize;
					self.windows[widx].activate_tab(index);
				},
				(Some('='), _) => {
					let gpu = self.gpu.as_ref().expect("gpu");
					let win = &mut self.windows[widx];
					win.refont(win.font_size + 1.0, gpu);
				},
				(Some('-'), _) => {
					let gpu = self.gpu.as_ref().expect("gpu");
					let win = &mut self.windows[widx];
					win.refont(win.font_size - 1.0, gpu);
				},
				(Some('c'), _) => {
					let win = &mut self.windows[widx];
					if win.pane(focused).is_some_and(|p| p.selection.is_some()) {
						win.copy_selection(focused);
					} else {
						let effect = win.pane_mut(focused).map(|p| p.scene.key(Key::Copy));
						if let Some(effect) = effect {
							self.handle_effect(el, wid, focused, effect);
						}
					}
				},
				(Some('x'), _) => {
					let effect = self.windows[widx]
						.pane_mut(focused)
						.map(|p| p.scene.key(Key::Cut));
					if let Some(effect) = effect {
						self.handle_effect(el, wid, focused, effect);
					}
				},
				(Some('a'), _) => {
					let effect = self.windows[widx]
						.pane_mut(focused)
						.map(|p| p.scene.key(Key::SelectAll));
					match effect {
						Some(Effect::Ignored) => self.windows[widx].select_all(focused),
						Some(effect) => self.handle_effect(el, wid, focused, effect),
						None => {},
					}
				},
				(Some('v'), _) => self.request_clipboard(wid, focused, ClipboardRead::Smart),
				_ => {},
			}
			if let Some(win) = self.windows.iter().find(|w| w.id == wid) {
				win.window.request_redraw();
			}
			return true;
		}
		if mods.control_key() {
			if code == Some(KeyCode::Tab) {
				self.windows[widx].cycle_tab(!mods.shift_key());
				return true;
			}
			if !mods.shift_key() {
				// Ctrl+Enter opens a window (ghostty binding); everything
				// else plain-Ctrl belongs to the scene.
				if code == Some(KeyCode::Enter) && !mods.alt_key() {
					let win = &self.windows[widx];
					let size = win
						.window
						.inner_size()
						.to_logical::<f64>(win.window.scale_factor());
					self.spawn_window(el, Some(size));
					return true;
				}
				return false;
			}
			if mods.alt_key() {
				// Ctrl+Shift+Alt+Arrow: directional split focus.
				let Some(dir) = dir_of(code) else {
					return false;
				};
				self.windows[widx].focus_neighbor(dir);
				return true;
			}
			match code {
				Some(KeyCode::Enter) => self.split(widx, Axis::X),
				Some(KeyCode::ArrowRight) => self.windows[widx].cycle_tab(true),
				Some(KeyCode::ArrowLeft) => self.windows[widx].cycle_tab(false),
				Some(KeyCode::ArrowUp) => self.windows[widx].scroll_focused(ScrollTo::Lines(1.0)),
				Some(KeyCode::ArrowDown) => {
					self.windows[widx].scroll_focused(ScrollTo::Lines(-1.0));
				},
				Some(KeyCode::PageUp) => self.windows[widx].scroll_focused(ScrollTo::Pages(1.0)),
				Some(KeyCode::PageDown) => {
					self.windows[widx].scroll_focused(ScrollTo::Pages(-1.0));
				},
				Some(KeyCode::Home) => self.windows[widx].scroll_focused(ScrollTo::Top),
				Some(KeyCode::End) => self.windows[widx].scroll_focused(ScrollTo::Tail),
				Some(KeyCode::Backspace) => {
					let size = self.config.font_size;
					let gpu = self.gpu.as_ref().expect("gpu");
					self.windows[widx].refont(size, gpu);
				},
				_ => match letter {
					Some('n') => {
						let win = &self.windows[widx];
						let size = win
							.window
							.inner_size()
							.to_logical::<f64>(win.window.scale_factor());
						self.spawn_window(el, Some(size));
					},
					Some('t') => self.new_tab(widx),
					Some('o') => self.split(widx, Axis::Y),
					Some('w') => self.close_pane(el, wid, focused),
					Some('q') => {
						let active = self.windows[widx].active;
						self.remove_tab(el, widx, active);
					},
					Some(']') => self.windows[widx].cycle_pane(true),
					Some('[') => self.windows[widx].cycle_pane(false),
					Some('.') => self.windows[widx].move_tab(1),
					Some(',') => self.windows[widx].move_tab(-1),
					Some('c') => {
						let win = &mut self.windows[widx];
						if win.pane(focused).is_some_and(|p| p.selection.is_some()) {
							win.copy_selection(focused);
						} else {
							let effect = win.pane_mut(focused).map(|p| p.scene.key(Key::Copy));
							if let Some(effect) = effect {
								self.handle_effect(el, wid, focused, effect);
							}
						}
					},
					Some('=') => {
						let gpu = self.gpu.as_ref().expect("gpu");
						let win = &mut self.windows[widx];
						win.refont(win.font_size + 1.0, gpu);
					},
					Some('-') => {
						let gpu = self.gpu.as_ref().expect("gpu");
						let win = &mut self.windows[widx];
						win.refont(win.font_size - 1.0, gpu);
					},
					Some('0') => {
						let last = self.windows[widx].tabs.len() - 1;
						self.windows[widx].activate_tab(last);
					},
					Some(digit @ '1'..='9') => {
						let index = digit as usize - '1' as usize;
						self.windows[widx].activate_tab(index);
					},
					_ => return false,
				},
			}
			if let Some(win) = self.windows.iter().find(|w| w.id == wid) {
				win.window.request_redraw();
			}
			return true;
		}
		false
	}

	fn mouse_pressed(&mut self, el: &ActiveEventLoop, widx: usize, mapped: MouseButton) {
		let id = self.windows[widx].id;
		let pointer = self.windows[widx].pointer;
		if mapped == MouseButton::Left {
			if let Some(hit) = self.windows[widx].strip_hit(pointer) {
				match hit {
					StripHit::Tab(index) => self.windows[widx].activate_tab(index),
					StripHit::Add => self.new_tab(widx),
				}
				return;
			}
			let win = &mut self.windows[widx];
			if let Some(divider) = win.divider_at(pointer) {
				let path = divider.path.clone();
				win.grab = Grab::Divider { path };
				return;
			}
			if pointer[1] < DRAG_STRIP * win.px_scale() {
				win.grab = Grab::Chrome;
				let _ = win.window.drag_window();
				return;
			}
		}
		let win = &mut self.windows[widx];
		let Some(pane_id) = win.pane_at(pointer) else {
			win.grab = Grab::None;
			return;
		};
		if mapped == MouseButton::Left {
			win.focus_pane(pane_id);
			if win.mods.shift_key() {
				// Shift forces host text selection everywhere, bands and
				// composer included.
				if win.begin_selection(pane_id) {
					win.grab = Grab::Selecting(pane_id);
					win.window.request_redraw();
				}
				return;
			}
			let had_selection = win.pane_mut(pane_id).is_some_and(|pane| {
				let had = pane.selection.take().is_some();
				pane.sel_anchor = None;
				had
			});
			if had_selection {
				win.window.request_redraw();
			}
		}
		let kind = match mapped {
			MouseButton::Left => Mouse::Click,
			MouseButton::Right => Mouse::RightClick,
			MouseButton::Middle => Mouse::MiddleClick,
			_ => return,
		};
		let metrics = win.metrics;
		// Interactive surfaces own the gesture: overlay bands anywhere,
		// the composer at the tail. A plain left press on transcript text
		// starts host selection instead — like a terminal, history is
		// selectable, not clickable.
		let (scene_owned, gated) = {
			let Some(pane) = win.pane(pane_id) else {
				return;
			};
			let over_band = pane_over_band(pane, &metrics, pointer);
			let owned = over_band
				|| (pane.scroll == 0.0 && pane_in_editor(pane, &metrics, pointer))
				|| mapped != MouseButton::Left;
			(owned, pane.scroll > 0.0 && !over_band)
		};
		if scene_owned {
			win.last_select_press = None;
			if gated {
				win.window.request_redraw();
				return;
			}
			if mapped == MouseButton::Left {
				win.grab = Grab::Scene(pane_id);
			}
			let Some(report) = win.report(pane_id, kind, mapped, true) else {
				return;
			};
			let effect = win.pane_mut(pane_id).map(|pane| pane.scene.mouse(report));
			if let Some(effect) = effect {
				self.handle_effect(el, id, pane_id, effect);
			}
		} else if win.begin_selection(pane_id) {
			win.grab = Grab::Selecting(pane_id);
		}
		if let Some(win) = self.windows.iter().find(|w| w.id == id) {
			win.window.request_redraw();
		}
	}

	fn mouse_released(&mut self, el: &ActiveEventLoop, widx: usize, mapped: MouseButton) {
		let id = self.windows[widx].id;
		let win = &mut self.windows[widx];
		let pane_id = match win.grab.clone() {
			Grab::Selecting(_) if mapped == MouseButton::Left => {
				win.grab = Grab::None;
				win.window.request_redraw();
				return;
			},
			Grab::Chrome | Grab::Divider { .. } if mapped == MouseButton::Left => {
				win.grab = Grab::None;
				return;
			},
			Grab::Scene(pane_id) => {
				if mapped == MouseButton::Left {
					win.grab = Grab::None;
				}
				pane_id
			},
			_ => return,
		};
		// Always close out a forwarded press, regardless of where the
		// pointer ended up.
		let Some(report) = win.report(pane_id, Mouse::Release, mapped, false) else {
			return;
		};
		let effect = win.pane_mut(pane_id).map(|pane| pane.scene.mouse(report));
		if let Some(effect) = effect {
			self.handle_effect(el, id, pane_id, effect);
		}
		if let Some(win) = self.windows.iter().find(|w| w.id == id) {
			win.window.request_redraw();
		}
	}
}

impl<S: Scene, F: Fn(&UiContext) -> S> ApplicationHandler<UserEvent> for Shell<S, F> {
	fn resumed(&mut self, el: &ActiveEventLoop) {
		if self.windows.is_empty() {
			self.spawn_window(el, None);
		}
	}

	fn window_event(&mut self, el: &ActiveEventLoop, id: WindowId, event: WindowEvent) {
		let Some(widx) = self.window_index(id) else {
			return;
		};
		match event {
			WindowEvent::CloseRequested | WindowEvent::Destroyed => {
				for tab in &mut self.windows[widx].tabs {
					for pane in &mut tab.panes {
						let _ = pane.scene.focus(false);
					}
				}
				self.windows.remove(widx);
				if self.windows.is_empty() {
					el.exit();
				}
			},
			WindowEvent::Resized(size) => {
				let gpu = self.gpu.as_ref().expect("gpu");
				let win = &mut self.windows[widx];
				win.surface.resize(gpu, size.width, size.height);
				win.relayout(false);
				win.settle = Some(Instant::now() + RESIZE_SETTLE);
				win.window.request_redraw();
			},
			WindowEvent::ScaleFactorChanged { .. } => {
				let gpu = self.gpu.as_ref().expect("gpu");
				let win = &mut self.windows[widx];
				let size = win.window.inner_size();
				win.surface.resize(gpu, size.width, size.height);
				win.refont(win.font_size, gpu);
				win.window.request_redraw();
			},
			WindowEvent::Focused(focused) => {
				let win = &mut self.windows[widx];
				win.window_focused = focused;
				win.window.set_ime_allowed(focused);
				let pane_id = win.focused();
				let effect = win
					.pane_mut(pane_id)
					.map_or(Effect::Ignored, |pane| pane.scene.focus(focused));
				self.handle_effect(el, id, pane_id, effect);
				if let Some(win) = self.windows.iter_mut().find(|win| win.id == id) {
					if !focused {
						win.ime_enabled = false;
					}
					win.blink_epoch = Instant::now();
					win.window.request_redraw();
				}
			},
			WindowEvent::ThemeChanged(theme) => {
				let appearance = native_appearance(theme);
				let win = &mut self.windows[widx];
				if win.ctx.apply_appearance(appearance) {
					win.theme = GuiTheme::from_ctx(&win.ctx, win.opacity);
					win.theme.corner_radius = 12.0 * win.window.scale_factor() as f32;
					for tab in &mut win.tabs {
						for pane in &mut tab.panes {
							let _ = pane.scene.appearance(appearance);
						}
					}
					win.rebuild_strip();
					win.window.request_redraw();
				}
			},
			WindowEvent::DroppedFile(path) => {
				let win = &mut self.windows[widx];
				let pane_id = win.focused();
				let effect = win
					.pane_mut(pane_id)
					.map_or(Effect::Ignored, |pane| pane.scene.drop_files(&[path.as_path()]));
				self.handle_effect(el, id, pane_id, effect);
				if let Some(win) = self.windows.iter().find(|win| win.id == id) {
					win.window.request_redraw();
				}
			},
			WindowEvent::ModifiersChanged(modifiers) => {
				self.windows[widx].mods = modifiers.state();
			},
			WindowEvent::KeyboardInput { event, .. } => {
				if event.state != ElementState::Pressed {
					return;
				}
				if self.mux_key(el, widx, &event) {
					return;
				}
				let win = &mut self.windows[widx];
				let Some(key) = input::map_key(&event, win.mods, &win.keymap) else {
					return;
				};
				let focused = win.focused();
				if key == Key::Esc && win.pane(focused).is_some_and(|p| p.selection.is_some()) {
					if let Some(pane) = win.pane_mut(focused) {
						pane.selection = None;
						pane.sel_anchor = None;
					}
					win.window.request_redraw();
					return;
				}
				win.blink_epoch = Instant::now();
				let effect = {
					let Some(pane) = win.pane_mut(focused) else {
						return;
					};
					pane.scroll = 0.0;
					pane.scene.key(key)
				};
				self.handle_effect(el, id, focused, effect);
				if let Some(win) = self.windows.iter().find(|w| w.id == id) {
					win.window.request_redraw();
				}
			},
			WindowEvent::Ime(Ime::Enabled) => {
				let win = &mut self.windows[widx];
				win.ime_enabled = true;
				win.window.request_redraw();
			},
			WindowEvent::Ime(Ime::Preedit(text, selection)) => {
				let win = &mut self.windows[widx];
				win.blink_epoch = Instant::now();
				let focused = win.focused();
				let effect = win.pane_mut(focused).map_or(Effect::Ignored, |pane| {
					pane
						.scene
						.ime_preedit(&text, selection.map(|(start, end)| start..end))
				});
				self.handle_effect(el, id, focused, effect);
				if let Some(win) = self.windows.iter().find(|w| w.id == id) {
					win.window.request_redraw();
				}
			},
			WindowEvent::Ime(Ime::Commit(text)) => {
				let win = &mut self.windows[widx];
				win.blink_epoch = Instant::now();
				let focused = win.focused();
				let effect = win
					.pane_mut(focused)
					.map_or(Effect::Ignored, |pane| pane.scene.ime_commit(&text));
				self.handle_effect(el, id, focused, effect);
				if let Some(win) = self.windows.iter().find(|w| w.id == id) {
					win.window.request_redraw();
				}
			},
			WindowEvent::Ime(Ime::Disabled) => {
				let win = &mut self.windows[widx];
				win.ime_enabled = false;
				let focused = win.focused();
				let effect = win
					.pane_mut(focused)
					.map_or(Effect::Ignored, |pane| pane.scene.ime_preedit("", None));
				self.handle_effect(el, id, focused, effect);
				if let Some(win) = self.windows.iter().find(|w| w.id == id) {
					win.window.request_redraw();
				}
			},
			WindowEvent::CursorMoved { position, .. } => {
				let win = &mut self.windows[widx];
				win.pointer = [position.x as f32, position.y as f32];
				match win.grab.clone() {
					Grab::Selecting(pane_id) => {
						if win.drag_selection(pane_id) {
							win.window.request_redraw();
						}
					},
					Grab::Divider { path } => {
						win.drag_divider(&path);
						win.window.request_redraw();
					},
					Grab::Chrome => {},
					Grab::Scene(pane_id) => {
						// A scene-owned drag keeps reporting wherever the
						// pointer goes: the retained tree must always see
						// the matching release.
						let Some(report) = win.report(pane_id, Mouse::Drag, MouseButton::None, true)
						else {
							return;
						};
						let effect = win.pane_mut(pane_id).map(|pane| pane.scene.mouse(report));
						if let Some(effect) = effect {
							self.handle_effect(el, id, pane_id, effect);
						}
						if let Some(win) = self.windows.iter().find(|w| w.id == id) {
							win.window.request_redraw();
						}
					},
					Grab::None => {
						let pointer = win.pointer;
						let icon = match win.divider_at(pointer).map(|d| d.axis) {
							Some(Axis::X) => CursorIcon::ColResize,
							Some(Axis::Y) => CursorIcon::RowResize,
							None => CursorIcon::Default,
						};
						if icon != win.cursor {
							win.cursor = icon;
							win.window.set_cursor(window::Cursor::Icon(icon));
						}
						if icon != CursorIcon::Default {
							return;
						}
						let Some(pane_id) = win.pane_at(pointer) else {
							return;
						};
						let gated = win.pane(pane_id).is_none_or(|pane| {
							pane.scroll > 0.0 && !pane_over_band(pane, &win.metrics, pointer)
						});
						if gated {
							return;
						}
						let Some(report) = win.report(pane_id, Mouse::Move, MouseButton::None, false)
						else {
							return;
						};
						let effect = win.pane_mut(pane_id).map(|pane| pane.scene.mouse(report));
						if let Some(effect) = effect {
							self.handle_effect(el, id, pane_id, effect);
						}
						if let Some(win) = self.windows.iter().find(|w| w.id == id) {
							win.window.request_redraw();
						}
					},
				}
			},
			WindowEvent::MouseInput { state, button, .. } => {
				let Some(mapped) = input::map_button(button) else {
					return;
				};
				match state {
					ElementState::Pressed => self.mouse_pressed(el, widx, mapped),
					ElementState::Released => self.mouse_released(el, widx, mapped),
				}
			},
			WindowEvent::MouseWheel { delta, .. } => {
				let win = &mut self.windows[widx];
				let metrics = win.metrics;
				let dy = match delta {
					MouseScrollDelta::LineDelta(_, y) => y * metrics.line_height * 3.0,
					MouseScrollDelta::PixelDelta(PhysicalPosition { y, .. }) => y as f32,
				};
				if dy.abs() < f32::EPSILON {
					return;
				}
				let pointer = win.pointer;
				let Some(pane_id) = win.pane_at(pointer) else {
					return;
				};
				let over_band = win
					.pane(pane_id)
					.is_some_and(|pane| pane_over_band(pane, &metrics, pointer));
				if over_band {
					let kind = if dy > 0.0 {
						Mouse::WheelUp
					} else {
						Mouse::WheelDown
					};
					let Some(report) = win.report(pane_id, kind, MouseButton::None, false) else {
						return;
					};
					let effect = win.pane_mut(pane_id).map(|pane| pane.scene.mouse(report));
					if let Some(effect) = effect {
						self.handle_effect(el, id, pane_id, effect);
					}
				} else if let Some(pane) = win.pane_mut(pane_id) {
					let max = pane_max_scroll(pane, &metrics);
					pane.scroll = (pane.scroll + dy).clamp(0.0, max);
				}
				if let Some(win) = self.windows.iter().find(|w| w.id == id) {
					win.window.request_redraw();
				}
			},
			WindowEvent::RedrawRequested => {
				let gpu = self.gpu.as_ref().expect("gpu");
				self.windows[widx].paint(gpu);
			},
			_ => {},
		}
	}

	fn user_event(&mut self, el: &ActiveEventLoop, event: UserEvent) {
		match event {
			UserEvent::Clipboard(window, pane, outcome, scope) => {
				let Some(widx) = self.window_index(window) else {
					return;
				};
				let raw = matches!(scope, ClipboardRead::Text);
				let effect = {
					let win = &mut self.windows[widx];
					let Some(target) = win
						.tabs
						.iter_mut()
						.flat_map(|tab| tab.panes.iter_mut())
						.find(|p| p.id == pane)
					else {
						return;
					};
					target.scene.clipboard(outcome, raw)
				};
				self.handle_effect(el, window, pane, effect);
				if let Some(win) = self.windows.iter().find(|w| w.id == window) {
					win.window.request_redraw();
				}
			},
			UserEvent::ClipboardWrite(window, pane, outcome) => {
				let Some(widx) = self.window_index(window) else {
					return;
				};
				let effect = {
					let win = &mut self.windows[widx];
					let Some(target) = win
						.tabs
						.iter_mut()
						.flat_map(|tab| tab.panes.iter_mut())
						.find(|p| p.id == pane)
					else {
						return;
					};
					target.scene.clipboard_write(outcome)
				};
				self.handle_effect(el, window, pane, effect);
				if let Some(win) = self.windows.iter().find(|w| w.id == window) {
					win.window.request_redraw();
				}
			},
		}
	}

	fn about_to_wait(&mut self, el: &ActiveEventLoop) {
		let mut effects = SmallVec::<(WindowId, PaneId, Effect), 4>::new();
		for win in &mut self.windows {
			for tab in &mut win.tabs {
				for pane in &mut tab.panes {
					match pane.scene.poll() {
						Effect::Ignored => {},
						effect => effects.push((win.id, pane.id, effect)),
					}
				}
			}
		}
		for (window, pane, effect) in effects {
			self.handle_effect(el, window, pane, effect);
			if let Some(win) = self.windows.iter().find(|win| win.id == window) {
				win.window.request_redraw();
			}
		}
		let now = Instant::now();
		let mut wake: Option<Instant> = None;
		for win in &mut self.windows {
			if let Some(at) = win.settle
				&& now >= at
			{
				win.settle = None;
				win.relayout(true);
				win.window.request_redraw();
			}
			if now >= win.next_tick {
				let tick = win.tabs[win.active]
					.panes
					.iter()
					.map(|pane| pane.scene.tick())
					.min()
					.unwrap_or(Duration::from_secs(3600));
				win.next_tick = now + tick;
				win.window.request_redraw();
			}
			let mut win_wake = win.settle.map_or(win.next_tick, |at| at.min(win.next_tick));
			if win.animating {
				// A shimmer decor animates at paint rate, not scene-tick
				// rate; the persistent deadline keeps redraw requests at
				// ~60 fps instead of re-queueing one per event-loop pass.
				if now >= win.next_frame {
					win.next_frame = now + Duration::from_millis(16);
					win.window.request_redraw();
				}
				if win.next_frame < win_wake {
					win_wake = win.next_frame;
				}
			}
			wake = Some(wake.map_or(win_wake, |current| current.min(win_wake)));
		}
		if let Some(wake) = wake {
			el.set_control_flow(ControlFlow::WaitUntil(wake));
		}
	}
}

fn write_clipboard_detached(text: Str) {
	let _ = thread::Builder::new()
		.name("clipboard-write".into())
		.spawn(move || {
			let _ = paste::write_clipboard_text(&text);
		});
}

#[cfg(test)]
mod tests {
	use omp_tui::{Frame, Size, Style};
	use smallvec::SmallVec;

	use super::{CellMetrics, SceneFrame, Selection, ime_cursor_area, selection_text};

	#[test]
	fn ime_candidate_area_tracks_the_visible_document_caret() {
		let mut frame = Frame::new(Size::new(20, 10));
		frame.set_cursor(3, 8);
		let scene = SceneFrame {
			frame:       &frame,
			viewport:    Size::new(20, 4),
			editor_rows: 2,
			layers:      SmallVec::new(),
		};
		let metrics =
			CellMetrics { advance: 8.0, ascent: 11.0, descent: 3.0, line_height: 16.0 };
		let (position, size) =
			ime_cursor_area(&scene, [10.0, 20.0], 0.0, &metrics).expect("visible caret");
		assert_eq!((position.x, position.y), (34, 52));
		assert_eq!((size.width, size.height), (8, 16));
		assert!(
			ime_cursor_area(&scene, [10.0, 20.0], 64.0, &metrics).is_none(),
			"scrolling the retained caret out of the viewport hides the candidate area",
		);
	}

	#[test]
	fn selection_text_trims_hard_rows_and_inserts_newlines() {
		let mut frame = Frame::new(Size::new(6, 2));
		frame.put(0, 0, "hi  ", Style::default());
		frame.put(0, 1, "there", Style::default());

		let text =
			selection_text(&frame, Selection { start: (0, 0), end: (1, frame.size().width) });
		assert_eq!(text, "hi\nthere");
	}

	#[test]
	fn selection_text_joins_soft_wrapped_rows_without_trimming() {
		let mut frame = Frame::new(Size::new(4, 2));
		frame.put(0, 0, "ab  ", Style::default());
		frame.put(0, 1, "cd", Style::default());
		frame.set_soft_wrap(0);

		let text =
			selection_text(&frame, Selection { start: (0, 0), end: (1, frame.size().width) });
		assert_eq!(text, "ab  cd");
	}

	#[test]
	fn selection_text_skips_noselect_regions() {
		let mut frame = Frame::new(Size::new(6, 3));
		frame.put(0, 0, "text", Style::default());
		frame.put(0, 1, "hud", Style::default());
		frame.put(0, 2, "more", Style::default());
		frame.push_noselect(omp_tui::Rect::new(0, 1, 6, 1));

		let text =
			selection_text(&frame, Selection { start: (0, 0), end: (2, frame.size().width) });
		assert_eq!(text, "text\nmore", "the HUD row vanishes from the copy");
	}

	#[test]
	fn selection_text_treats_last_row_end_as_exclusive() {
		let mut frame = Frame::new(Size::new(5, 1));
		frame.put(0, 0, "abcde", Style::default());

		let text = selection_text(&frame, Selection { start: (0, 0), end: (0, 3) });
		assert_eq!(text, "abc");
	}
}
