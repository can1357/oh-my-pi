//! Shared vocabulary of the terminal engine.
//!
//! The engine is sans-IO with respect to time and stdin: the JS host passes a
//! monotonic clock reading ([`Millis`]) and raw stdin bytes into every call,
//! and drains [`Event`]s afterwards. These types are what the submodules
//! exchange:
//!
//! - [`input`](super::input) turns stdin bytes into [`Input`]s.
//! - [`session`](super::session) consumes [`Report`]s, negotiates terminal
//!   capabilities, and emits capability [`Event`]s.
//! - [`screen`](super::screen) paints frames ([`PlanFrame`], [`AltFrame`]),
//!   runs resize transactions, and schedules renders ([`Event::Render`]).
//! - `engine` (the napi surface) routes between them and converts to JS.

/// Monotonic milliseconds from the JS host's clock; the engine never reads a
/// clock.
pub type Millis = f64;

/// Inline image protocol the terminal speaks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageProtocol {
	Kitty,
	Iterm2,
	Sixel,
}

/// How a settled resize refreshes native scrollback (see `ResizeScrollbackMode`
/// in pi-tui).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResizeScrollback {
	Append,
	Rebuild,
	Preserve,
}

/// Mouse reporting wanted by the host for the next frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseTracking {
	Off,
	/// Normal-buffer click capture (`tui.mouse`).
	Inline,
	/// Fullscreen overlay pointer interaction.
	Full,
}

/// Effective terminal geometry in cells.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Size {
	pub columns: u32,
	pub rows:    u32,
}

/// Facts about the classified multiplexer module (all false when none).
#[derive(Clone, Debug, Default)]
pub struct MultiplexerFacts {
	pub expands_rep_padding:                  bool,
	pub expires_synchronized_output:          bool,
	pub alt_restore_ends_synchronized_output: bool,
	pub grows_before_sigwinch:                bool,
}

/// A multiplexer that answers OSC 11 from a cache: the pre-wrapped passthrough
/// query refreshes it, and the direct query is sent `settle_ms` later.
#[derive(Clone, Debug)]
pub struct BackgroundCache {
	pub passthrough_query: String,
	pub settle_ms:         Millis,
}

/// Pre-encoded Glyph Protocol handshake payloads (JS owns the bundle).
#[derive(Clone, Debug)]
pub struct GlyphProbe {
	pub support_query:             String,
	/// Every bundled registration followed by the confirmation coverage query.
	pub registrations_and_confirm: String,
	pub confirm_codepoint:         u32,
}

/// How the Tern Surface Protocol `hello` probe runs.
#[derive(Clone, Debug)]
pub enum TspProbe {
	/// Not probed; the hello resolves to `None` at attach with `reason`.
	Skip { reason: Option<String> },
	/// Probe guarded by the DA1 sentinel.
	Direct { query: String, version: u32 },
	/// Inside tmux, which answers DA1 itself: wait for the reply up to
	/// `timeout_ms`.
	Tmux { query: String, version: u32, timeout_ms: Millis },
}

/// Environment facts resolved by the JS host (terminal-capabilities,
/// multiplexer modules, env overrides, settings). Policy that depends on JS
/// modules used elsewhere stays there; the engine receives the answers.
#[derive(Clone, Debug)]
pub struct Facts {
	/// `TERMINAL.id` (`"ghostty"`, `"kitty"`, `"base"`, `"trueColor"`, …).
	pub terminal_id: String,
	pub image_protocol: Option<ImageProtocol>,
	/// stdout crosses a `ConPTY` (win32, or WSL).
	pub conpty: bool,
	/// stdin is a native Windows console handle (win32, not WSL).
	pub native_windows_console: bool,
	pub ssh: bool,
	/// `isInsideTerminalMultiplexer()`.
	pub inside_multiplexer: bool,
	/// Inside tmux (`tmuxMultiplexer.isInside()`): kitty graphics commands are
	/// wrapped in tmux passthrough.
	pub tmux_passthrough: bool,
	pub multiplexer: MultiplexerFacts,
	/// Any session (or the classified module) gates paste markers on the pane's
	/// own DEC 2004.
	pub gates_bracketed_paste: bool,
	/// Any session honors DEC 2026 even when DECRQM is unanswered.
	pub honors_synchronized_output: bool,
	pub background_cache: Option<BackgroundCache>,
	/// `TERM_PROGRAM=WarpTerminal`.
	pub warp: bool,
	/// `PI_TUI_RESIZE_IN_PLACE` override.
	pub resize_in_place: Option<bool>,
	pub resize_scrollback: ResizeScrollback,
	/// Static DEC 2026 default (`shouldEnableSynchronizedOutputByDefault`).
	pub synchronized_output: bool,
	/// A user override exists: DECRPM reports must not change synchronized
	/// output.
	pub synchronized_output_override: bool,
	pub show_hardware_cursor: bool,
	/// `PI_NO_SGR_COALESCE` unset.
	pub sgr_coalesce: bool,
	/// Ghostty/Monstar expire OSC 9;4 without a heartbeat.
	pub progress_keepalive: bool,
	/// Native Windows Terminal: poll OSC 11 when DEC 2031 is unsupported.
	pub poll_appearance: bool,
	pub probe_osc99: bool,
	pub probe_program_status: bool,
	pub probe_glyph: Option<GlyphProbe>,
	pub probe_tsp: TspProbe,
	/// The environment names a TSP terminal and the hello probe will run
	/// (`ProcessTerminal.tspExpected`): drain waits on a DA1 sentinel for
	/// in-flight acks while the probe is still pending.
	pub tsp_expected: bool,
	/// Send XTSMGRAPHICS at input attach (no static protocol, not forced, not
	/// TSP-expected, ttys).
	pub probe_sixel_graphics: bool,
	/// Floor between ordinary frames (`minFrameIntervalMs()`).
	pub frame_interval_ms: Millis,
}

/// Terminal → host report recognized by the input parser.
#[derive(Clone, Debug, PartialEq)]
pub enum Report {
	/// `CSI ? flags u`.
	KittyKeyboard { flags: u32 },
	/// `CSI ? 997 ; 1|2 n` (DEC 2031 appearance change).
	AppearanceChanged,
	/// OSC 11 reply, channels normalized to `0.0..=1.0`.
	BackgroundColor { r: f64, g: f64, b: f64 },
	/// DA1 (`CSI ? … c`); `sixel` when attribute 4 is advertised.
	DeviceAttributes { sixel: bool },
	/// DECRPM (`CSI ? mode ; status $ y`).
	PrivateMode { mode: u32, status: u32 },
	/// DEC 2048 in-band resize (`CSI 48 ; rows ; cols ; ypx ; xpx t`).
	InBandResize { rows: u32, columns: u32, height_px: u32, width_px: u32 },
	/// OSC 99 capability reply.
	NotificationCaps { meta: String, payload: String },
	/// OSC 7501 feature reply; `states` is `None` when no `states=` key was
	/// present.
	ProgramStatus { states: Option<Vec<String>> },
	/// Complete Glyph Protocol APC (`ESC _ 25a1 ; … ESC \`).
	Glyph { sequence: String },
	/// Complete TSP message in APC form (OSC 877 framing already converted).
	Tsp { sequence: String },
	/// CPR (`CSI row ; col R`), 1-based.
	CursorPosition { row: u32, column: u32 },
	/// `CSI 6 ; height ; width t` or iTerm2 `ReportCellSize` (scaled, rounded).
	CellSize { height_px: u32, width_px: u32 },
	/// XTSMGRAPHICS item 2 reply: success with non-zero geometry.
	SixelGraphics { supported: bool },
}

/// One parsed stdin event.
#[derive(Clone, Debug, PartialEq)]
pub enum Input {
	/// A key sequence or text run for the focused component.
	Key(String),
	/// Bracketed (or heuristically detected) paste; `enter` is an Enter that
	/// shared its read.
	Paste {
		text:  String,
		enter: Option<String>,
	},
	Report(Report),
}

/// Engine → host notification, drained by the host after every call.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Event {
	Key(String),
	Paste {
		text:  String,
		enter: Option<String>,
	},
	/// A frame is due: the host calls `begin_frame` and presents the requested
	/// kind.
	Render,
	/// The host must call its frame provider's `beginHistoryReplay()` before
	/// composing the next plan frame (destructive reset latched, or an append
	/// resize replay). Queued ahead of the `Render` it affects; when latched
	/// inside `begin_frame`, the host applies it before composing that frame.
	HistoryReplay,
	/// A frame write emitted a row containing this watched text (see
	/// `Screen::set_frame_text_watches`); queued once per watched text per
	/// frame write, covering plan, alt, and resize paints.
	FrameText {
		text: String,
	},
	/// Effective geometry changed (OS resize or in-band report).
	Resize,
	Appearance {
		dark:    bool,
		rgb:     u32,
		token:   Option<u32>,
		changed: bool,
	},
	PrivateMode {
		mode:      u32,
		supported: bool,
		confirmed: bool,
		status:    Option<u32>,
	},
	/// SIXEL support: from the DA1 attribute (`graphics: false`; the host still
	/// checks a tmux client), or a positive XTSMGRAPHICS reply (`graphics:
	/// true`; adopted as-is).
	Sixel {
		supported: bool,
		graphics:  bool,
	},
	/// The engine adopted an inline image protocol at runtime (SIXEL from the
	/// terminal's DA1 advertisement or XTSMGRAPHICS reply).
	ImageProtocol {
		protocol: ImageProtocol,
	},
	ProgramStatus {
		supported: bool,
	},
	Glyph {
		supported: bool,
	},
	Osc99 {
		supported: bool,
	},
	/// TSP hello outcome: the reply's JSON body, or `None` (no TSP; `reason`
	/// says why). Engine-internal: the surface handshake turns it into the
	/// events below.
	TspHello {
		json:   Option<String>,
		reason: Option<String>,
	},
	/// The TSP surface opened (`live`: on assumed capabilities without
	/// `hello`, else the reply's JSON body), an open surface was confirmed by
	/// `hello`, or an unconfirmed one was revoked (`!live`, `reason`).
	NativeSurface {
		live:   bool,
		hello:  Option<String>,
		reason: Option<String>,
	},
	/// A Tern pane keeps the classic renderer: why (reported once per engine).
	TspFallback {
		reason: String,
	},
	/// Inside tmux: turn the pane's APC titles off (probe start) or back on.
	TmuxApcTitles {
		enabled: bool,
	},
	KeyboardProtocol {
		kitty: bool,
	},
	CellSize {
		width_px:  u32,
		height_px: u32,
	},
	/// `drain_input` finished.
	InputDrained,
	/// Output stalled or failed: the host tears down.
	Disconnected {
		reason: String,
	},
}

/// Ordered history rows offered with a plan frame (see `HistoryBatch` in
/// pi-tui).
#[derive(Clone, Debug)]
pub struct HistoryBatch {
	pub id:     u32,
	pub rows:   Vec<String>,
	/// A complete ledger replay rather than an append.
	pub replay: bool,
}

/// A normal-buffer frame: optional history plus the complete mutable viewport.
#[derive(Clone, Debug)]
pub struct PlanFrame {
	pub history:    Option<HistoryBatch>,
	pub viewport:   Vec<String>,
	/// Return the prepared rows for paint listeners.
	pub want_paint: bool,
}

/// A fullscreen-overlay frame on the alternate buffer.
#[derive(Clone, Debug)]
pub struct AltFrame {
	pub rows:       Vec<String>,
	/// The focused component of the top overlay may position the hardware
	/// cursor.
	pub cursor:     bool,
	pub want_paint: bool,
}

/// What the host must compose after `begin_frame`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FrameKind {
	/// Nothing to paint (resize settling, probe in flight, native surface,
	/// deferred).
	None,
	Plan,
	Alt,
	/// The transient resize buffer: the provider's full semantic tail.
	Resize,
}

/// Rows a paint committed, for paint listeners (`TuiPaint` in pi-tui).
#[derive(Clone, Debug)]
pub struct Paint {
	pub history:  Vec<String>,
	pub viewport: Vec<String>,
	pub reset:    bool,
	pub alt:      bool,
	pub size:     Size,
}

/// Outcome of presenting a frame.
#[derive(Clone, Debug, Default)]
pub struct PresentResult {
	/// History batch ids the host must acknowledge to its provider, in order.
	pub acknowledged: Vec<u32>,
	pub paint:        Option<Paint>,
}
