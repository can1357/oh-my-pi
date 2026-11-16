//! napi objects of the [`TerminalEngine`](super::engine::TerminalEngine)
//! surface and their conversions to and from the engine's own types.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

use super::{
	profile::{
		EngineHost, Env, Host, Platform, engine_facts,
		js::{JsEnv, env_of},
	},
	screen::overlay::Overlay,
	types::{
		Event, Facts, HistoryBatch, ImageProtocol, MouseTracking, Paint, PresentResult,
		ResizeScrollback,
	},
};

/// Inline image protocol (`TERMINAL.imageProtocol`).
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineImageProtocol {
	Kitty,
	Iterm2,
	Sixel,
}

impl From<EngineImageProtocol> for ImageProtocol {
	fn from(protocol: EngineImageProtocol) -> Self {
		match protocol {
			EngineImageProtocol::Kitty => Self::Kitty,
			EngineImageProtocol::Iterm2 => Self::Iterm2,
			EngineImageProtocol::Sixel => Self::Sixel,
		}
	}
}

/// How a settled resize refreshes native scrollback.
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineResizeScrollback {
	Append,
	Rebuild,
	Preserve,
}

impl From<EngineResizeScrollback> for ResizeScrollback {
	fn from(mode: EngineResizeScrollback) -> Self {
		match mode {
			EngineResizeScrollback::Append => Self::Append,
			EngineResizeScrollback::Rebuild => Self::Rebuild,
			EngineResizeScrollback::Preserve => Self::Preserve,
		}
	}
}

/// Mouse reporting wanted for the next frame.
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineMouse {
	Off,
	Inline,
	Full,
}

impl From<EngineMouse> for MouseTracking {
	fn from(mouse: EngineMouse) -> Self {
		match mouse {
			EngineMouse::Off => Self::Off,
			EngineMouse::Inline => Self::Inline,
			EngineMouse::Full => Self::Full,
		}
	}
}

/// The host's Tern Surface Protocol `hello` query (pi-tui owns TSP encoding).
#[napi(object)]
pub struct EngineTspHello {
	pub query:   String,
	pub version: u32,
}

/// Construction options: the output sink, geometry, the environment, and the
/// facts only the JS host knows. The engine resolves every terminal and
/// multiplexer fact from the environment itself (see `tui::profile`).
#[napi(object)]
pub struct EngineConfig {
	/// Own this process's stdio: stdout is written from a writer thread (no
	/// control output when it is not a terminal), and attaching input puts
	/// stdin in raw mode and reads it on a thread. False: output is captured
	/// for `takeOutput` and input arrives through `input`.
	pub stdio:                  bool,
	pub columns:                u32,
	pub rows:                   u32,
	/// The process environment (`Bun.env`), or a test's replacement.
	#[napi(ts_type = "Record<string, string | undefined>")]
	pub env:                    JsEnv,
	/// Bun is running a test entrypoint (`isBunTestRuntime()`).
	pub test_runtime:           bool,
	/// `isTerminalHeadless()`.
	pub headless:               bool,
	pub stdin_tty:              bool,
	pub stdout_tty:             bool,
	/// Force ConPTY-hosted behavior; defaults to win32 or WSL.
	pub conpty:                 Option<bool>,
	/// stdin is a native Windows console handle; defaults to win32.
	pub native_windows_console: Option<bool>,
	/// Force whether a TSP surface is expected (test harnesses).
	pub tsp_expected:           Option<bool>,
	pub tsp_hello:              EngineTspHello,
	/// Floor between ordinary frames (`minFrameIntervalMs()`).
	pub frame_interval_ms:      f64,
}

impl EngineConfig {
	/// The environment and the facts the engine resolves from it, plus the
	/// write log path.
	pub(crate) fn resolve(self) -> (Env, Facts, Option<String>) {
		let env = env_of(self.env);
		let host = EngineHost {
			host:                   Host {
				platform:     Platform::current(),
				test_runtime: self.test_runtime,
				stdout_tty:   self.stdout_tty,
			},
			headless:               self.headless,
			stdin_tty:              self.stdin_tty,
			conpty:                 self.conpty,
			native_windows_console: self.native_windows_console,
			tsp_expected:           self.tsp_expected,
			tsp_query:              self.tsp_hello.query,
			tsp_version:            self.tsp_hello.version,
			frame_interval_ms:      self.frame_interval_ms,
		};
		let facts = engine_facts(&env, &host);
		// Debug log of every byte the output device encodes; it keeps clipboard
		// contents out of the file by recording an OSC 52 payload's length only.
		let write_log = env
			.get("PI_TUI_WRITE_LOG")
			.filter(|path| !path.is_empty())
			.map(str::to_owned);
		(env, facts, write_log)
	}
}

/// Discriminant of an [`EngineEvent`].
#[napi(string_enum = "camelCase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineEventKind {
	Key,
	Paste,
	Render,
	HistoryReplay,
	FrameText,
	Resize,
	Appearance,
	PrivateMode,
	ImageProtocol,
	ProgramStatus,
	Glyph,
	Osc99,
	NativeSurface,
	TspFallback,
	KeyboardProtocol,
	CellSize,
	InputDrained,
	Disconnected,
}

/// Engine → host notification. Fields beyond `kind` are set per kind:
/// - `key`: `data`; `paste`: `data`, `enter`; `frameText`: `data` (the watched
///   text)
/// - `appearance`: `dark`, `rgb`, `token`, `changed`
/// - `privateMode`: `mode`, `supported`, `confirmed`, `status`
/// - `imageProtocol`: `data` (`"sixel"`): the engine adopted the protocol and
///   forced a full repaint
/// - `programStatus` / `glyph` / `osc99`: `supported`
/// - `nativeSurface`: `live`; `data` (the `hello` reply JSON) when live on real
///   capabilities rather than assumed ones; `reason` when an unconfirmed
///   surface was revoked
/// - `tspFallback`: `reason` (why a Tern pane keeps the classic renderer)
/// - `keyboardProtocol`: `kitty`
/// - `cellSize`: `widthPx`, `heightPx`; `disconnected`: `data` (reason)
#[napi(object)]
pub struct EngineEvent {
	#[napi(ts_type = "\"key\" | \"paste\" | \"render\" | \"historyReplay\" | \"frameText\" | \
	                  \"resize\" | \"appearance\" | \"privateMode\" | \"imageProtocol\" | \
	                  \"programStatus\" | \"glyph\" | \"osc99\" | \"nativeSurface\" | \
	                  \"tspFallback\" | \"keyboardProtocol\" | \"cellSize\" | \"inputDrained\" | \
	                  \"disconnected\"")]
	pub kind:      EngineEventKind,
	pub data:      Option<String>,
	pub enter:     Option<String>,
	pub reason:    Option<String>,
	pub live:      Option<bool>,
	pub dark:      Option<bool>,
	pub rgb:       Option<u32>,
	pub token:     Option<u32>,
	pub changed:   Option<bool>,
	pub mode:      Option<u32>,
	pub supported: Option<bool>,
	pub confirmed: Option<bool>,
	pub status:    Option<u32>,
	pub kitty:     Option<bool>,
	pub width_px:  Option<u32>,
	pub height_px: Option<u32>,
}

impl EngineEvent {
	const fn of(kind: EngineEventKind) -> Self {
		Self {
			kind,
			data: None,
			enter: None,
			reason: None,
			live: None,
			dark: None,
			rgb: None,
			token: None,
			changed: None,
			mode: None,
			supported: None,
			confirmed: None,
			status: None,
			kitty: None,
			width_px: None,
			height_px: None,
		}
	}
}

impl From<Event> for EngineEvent {
	fn from(event: Event) -> Self {
		let of = Self::of;
		match event {
			Event::Key(data) => Self { data: Some(data), ..of(EngineEventKind::Key) },
			Event::Paste { text, enter } => {
				Self { data: Some(text), enter, ..of(EngineEventKind::Paste) }
			},
			Event::Render => of(EngineEventKind::Render),
			Event::HistoryReplay => of(EngineEventKind::HistoryReplay),
			Event::FrameText { text } => Self { data: Some(text), ..of(EngineEventKind::FrameText) },
			Event::Resize => of(EngineEventKind::Resize),
			Event::Appearance { dark, rgb, token, changed } => Self {
				dark: Some(dark),
				rgb: Some(rgb),
				token,
				changed: Some(changed),
				..of(EngineEventKind::Appearance)
			},
			Event::PrivateMode { mode, supported, confirmed, status } => Self {
				mode: Some(mode),
				supported: Some(supported),
				confirmed: Some(confirmed),
				status,
				..of(EngineEventKind::PrivateMode)
			},
			Event::Sixel { .. } => unreachable!("the engine applies the SIXEL adoption policy itself"),
			Event::ImageProtocol { protocol } => {
				let name = match protocol {
					ImageProtocol::Kitty => "kitty",
					ImageProtocol::Iterm2 => "iterm2",
					ImageProtocol::Sixel => "sixel",
				};
				Self { data: Some(name.to_owned()), ..of(EngineEventKind::ImageProtocol) }
			},
			Event::ProgramStatus { supported } => {
				Self { supported: Some(supported), ..of(EngineEventKind::ProgramStatus) }
			},
			Event::Glyph { supported } => {
				Self { supported: Some(supported), ..of(EngineEventKind::Glyph) }
			},
			Event::Osc99 { supported } => {
				Self { supported: Some(supported), ..of(EngineEventKind::Osc99) }
			},
			Event::TspHello { .. } => {
				unreachable!("the engine's surface handshake consumes TSP hello outcomes")
			},
			Event::NativeSurface { live, hello, reason } => {
				Self { live: Some(live), data: hello, reason, ..of(EngineEventKind::NativeSurface) }
			},
			Event::TspFallback { reason } => {
				Self { reason: Some(reason), ..of(EngineEventKind::TspFallback) }
			},
			Event::TmuxApcTitles { .. } => {
				unreachable!("the engine applies tmux APC title changes itself")
			},
			Event::KeyboardProtocol { kitty } => {
				Self { kitty: Some(kitty), ..of(EngineEventKind::KeyboardProtocol) }
			},
			Event::CellSize { width_px, height_px } => Self {
				width_px: Some(width_px),
				height_px: Some(height_px),
				..of(EngineEventKind::CellSize)
			},
			Event::InputDrained => of(EngineEventKind::InputDrained),
			Event::Disconnected { reason } => {
				Self { data: Some(reason), ..of(EngineEventKind::Disconnected) }
			},
		}
	}
}

/// History rows offered with a plan frame.
#[napi(object)]
pub struct EngineHistoryBatch {
	pub id:     u32,
	pub rows:   Vec<String>,
	pub replay: bool,
}

impl From<EngineHistoryBatch> for HistoryBatch {
	fn from(batch: EngineHistoryBatch) -> Self {
		Self { id: batch.id, rows: batch.rows, replay: batch.replay }
	}
}

/// One visible overlay, rendered by the host at its resolved width and
/// already cut to its maximum height; the engine composites it.
#[napi(object)]
pub struct EngineOverlay {
	/// Screen row of the first line (rows outside the screen are skipped).
	pub row:   i32,
	pub col:   u32,
	pub width: u32,
	pub lines: Vec<String>,
}

impl From<EngineOverlay> for Overlay {
	fn from(overlay: EngineOverlay) -> Self {
		Self { row: overlay.row, col: overlay.col, width: overlay.width, lines: overlay.lines }
	}
}

/// A normal-buffer frame.
#[napi(object)]
pub struct EnginePlanFrame {
	pub history:    Option<EngineHistoryBatch>,
	pub viewport:   Vec<String>,
	/// Visible overlays in stack order (later = on top), composited onto the
	/// viewport padded to the screen height. Absent or empty: the viewport is
	/// painted as is.
	pub overlays:   Option<Vec<EngineOverlay>>,
	pub want_paint: bool,
}

/// A fullscreen-overlay frame on the alternate buffer: the visible overlays
/// composited onto a blank screen.
#[napi(object)]
pub struct EngineAltFrame {
	/// Visible overlays in stack order (later = on top).
	pub overlays:   Vec<EngineOverlay>,
	/// The focused component of the top overlay may position the hardware
	/// cursor.
	pub cursor:     bool,
	pub want_paint: bool,
}

/// The transient resize-buffer frame.
#[napi(object)]
pub struct EngineResizeFrame {
	pub rows: Vec<String>,
}

/// What `beginFrame` asks the host to compose.
#[napi(string_enum = "lowercase")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EngineFrameKind {
	None,
	Plan,
	Alt,
	Resize,
}

/// Host view of the next frame, for `beginFrame`.
#[napi(object)]
pub struct EngineFrameView {
	/// The topmost visible overlay is fullscreen.
	pub alt:   bool,
	#[napi(ts_type = "\"off\" | \"inline\" | \"full\"")]
	pub mouse: EngineMouse,
}

/// Rows a paint committed, for paint listeners.
#[napi(object)]
pub struct EnginePaint {
	pub history:  Vec<String>,
	pub viewport: Vec<String>,
	pub reset:    bool,
	pub alt:      bool,
	pub columns:  u32,
	pub rows:     u32,
}

impl From<Paint> for EnginePaint {
	fn from(paint: Paint) -> Self {
		Self {
			history:  paint.history,
			viewport: paint.viewport,
			reset:    paint.reset,
			alt:      paint.alt,
			columns:  paint.size.columns,
			rows:     paint.size.rows,
		}
	}
}

/// Outcome of presenting a frame.
#[napi(object)]
pub struct EnginePresentResult {
	/// History batch ids to acknowledge to the frame provider, in order.
	pub acknowledged: Vec<u32>,
	pub paint:        Option<EnginePaint>,
}

impl From<PresentResult> for EnginePresentResult {
	fn from(result: PresentResult) -> Self {
		Self { acknowledged: result.acknowledged, paint: result.paint.map(Into::into) }
	}
}

/// Options for `requestRender`.
#[napi(object)]
#[derive(Default)]
pub struct EngineRenderRequest {
	/// Repaint the viewport even when the diff sees no change.
	pub force:            Option<bool>,
	/// Erase native scrollback and replay history (destructive reset).
	pub clear_scrollback: Option<bool>,
	/// Requested by terminal input: paced at the input cadence.
	pub input:            Option<bool>,
	/// Ctrl+C/Escape: give the app's double-press window one frame first.
	pub input_grace:      Option<bool>,
	/// Paint now instead of on the next tick.
	pub immediate:        Option<bool>,
}

/// Mutable normal-buffer viewport from the last provider frame.
#[napi(object)]
pub struct EngineViewport {
	/// Composer row of the viewport's first row; negative while prepended blanks
	/// outweigh replaced rows.
	pub top:    i32,
	pub length: u32,
}

/// Hardware cursor of the last paint.
#[napi(object)]
pub struct EngineCursor {
	pub x:       u32,
	pub y:       u32,
	pub visible: bool,
}

/// Last viewport written, for debug inspection.
#[napi(object)]
pub struct EngineDebugPaint {
	pub lines:      Vec<String>,
	pub window_top: u32,
	pub alt_screen: bool,
	pub cursor:     Option<EngineCursor>,
}

/// Capture-sink chunks as Node buffers.
pub(crate) fn buffers(chunks: Vec<Vec<u8>>) -> Vec<Buffer> {
	chunks.into_iter().map(Buffer::from).collect()
}
