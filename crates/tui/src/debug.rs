//! `OMP_TUI_DEBUG` introspection socket for terminal hosts.
//!
//! Setting `OMP_TUI_DEBUG=<unix-socket-path>` makes [`crate::Terminal`]
//! entry start a server thread that binds the socket and answers one JSON
//! request per line. The wire speaks [`crate::TerminalEvent`] directly:
//!
//! - Input ops (`keys`, `paste`, `mouse`, `event`, `bytes`) become mailbox
//!   events — decoded ones are sent verbatim, raw `bytes` run through the live
//!   decoder — so the host observes debug input exactly like terminal input, in
//!   arrival order.
//! - Screen ops (`text`, `info`) answer from the snapshot the renderer
//!   publishes on every paint ([`publish_screen`]).
//! - `resize` emulates a SIGWINCH so every host's normal geometry recheck
//!   fires; `quit` injects `C-c`, the conventional quit chord.
//! - Retained-state ops (`frame`, `tree`, `values`, `slots`) ride the mailbox
//!   as [`crate::TerminalEvent::Debug`] queries; [`crate::App`] answers core
//!   tree ops while chat hosts answer `slots`. `effect` enters the same mailbox
//!   as a serialized [`crate::TerminalEvent::Effect`].
//!
//! Harnesses pair the socket with `OMP_TTY`: the pty master captures the
//! exact byte stream a terminal would see, while this socket provides
//! structured introspection and input injection.
//!
//! Requests are single-line JSON objects selected by `"op"`; every response
//! is one JSON line with `"ok"`:
//!
//! | op | fields | effect |
//! | --- | --- | --- |
//! | `info` | | viewport, document, overlay summary |
//! | `text` | | visible viewport as text (last painted screen) |
//! | `frame` | | full document frame as text rows (retained hosts) |
//! | `tree` | | component tree with kinds, ids, rects, focus (retained) |
//! | `slots` | | extension mount keys and resolved rectangles (retained host) |
//! | `effect` | `effect` | inject one serialized extension `UiEffect` |
//! | `keys` | `keys` | inject physical chords through the live keymap, e.g. `"tab C-a enter 'text'"` |
//! | `event` | `event` | inject one serialized [`crate::TerminalEvent`] |
//! | `bytes` | `data` | feed raw bytes through the input decoder |
//! | `paste` | `text` | inject a bracketed paste |
//! | `mouse` | `x`,`y`,`action`[,`button`] | inject an SGR-level gesture |
//! | `resize` | | re-read tty geometry (pair with `TIOCSWINSZ`) |
//! | `quit` | | inject the conventional `C-c` quit chord |

use std::{
	env, io,
	sync::{
		LazyLock,
		atomic::{AtomicBool, Ordering},
	},
};

use omp_core::Str;
use parking_lot::Mutex;

use crate::{
	frame::{CellContent, Frame, Style},
	input::{Chord, InputEvent, Key, Mods, Mouse, MouseButton, MouseReport},
	kitty, pump,
	pump::{DebugOp, DebugQuery, TerminalEvent},
	renderer, terminal, test_support,
};

/// Environment variable naming the debug socket path.
pub const DEBUG_ENV: &str = "OMP_TUI_DEBUG";

/// Latest painted viewport, published by the renderer whenever the socket
/// is enabled. `None` until the first paint.
static SCREEN: Mutex<Option<ScreenSnapshot>> = Mutex::new(None);

/// Host responses to in-flight [`DebugQuery`]s, keyed by query id.
static RESPONSES: Mutex<Option<flume::Sender<(u64, serde_json::Value)>>> = Mutex::new(None);

/// Whether `OMP_TUI_DEBUG` names a socket path (checked once).
pub fn enabled() -> bool {
	static ENABLED: LazyLock<bool> =
		LazyLock::new(|| env::var_os(DEBUG_ENV).is_some_and(|value| !value.is_empty()));
	*ENABLED
}

/// Whether the renderer should publish paint snapshots.
pub fn publishing() -> bool {
	enabled()
}

/// Answers one [`crate::TerminalEvent::Debug`] query; retained hosts call
/// this with the JSON payload for the query's id. Late or duplicate
/// responses are dropped.
pub fn respond_debug_query(id: u64, response: serde_json::Value) {
	let sender = RESPONSES.lock().clone();
	if let Some(sender) = sender {
		let _ = sender.send((id, response));
	}
}

/// Replaces the published screen snapshot after a paint.
pub fn publish_screen(snapshot: ScreenSnapshot) {
	*SCREEN.lock() = Some(snapshot);
}

/// Clones the latest published screen snapshot.
pub fn screen_snapshot() -> Option<ScreenSnapshot> {
	SCREEN.lock().clone()
}

/// What the terminal currently shows, as published by the last paint.
#[derive(Clone)]
pub struct ScreenSnapshot {
	/// Right-trimmed visible text, one string per viewport row.
	pub lines:      Vec<String>,
	/// Visible hardware cursor as (row, column), when placed.
	pub cursor:     Option<(u16, u16)>,
	/// Document row shown at the viewport top.
	pub window_top: u16,
	/// Viewport width in cells.
	pub cols:       u16,
	/// Viewport height in rows.
	pub rows:       u16,
	/// Full document height in rows.
	pub doc_height: u16,
	/// Whether viewport layers were composited into this paint.
	pub overlay:    bool,
}
/// Native frame-to-PNG capture failure.
#[derive(Debug, thiserror::Error)]
pub enum FramePngError {
	/// The shared pixel rasterizer rejected the frame geometry or options.
	#[error(transparent)]
	Raster(#[from] omp_snapcompact::SnapcompactError),
}

/// Projects one painted frame to right-trimmed terminal text.
pub fn frame_text(frame: &Frame) -> String {
	let mut text = String::new();
	for row in 0..frame.size().height {
		if row != 0 {
			text.push('\n');
		}
		text.push_str(&test_support::frame_row_text(frame, row));
	}
	text
}
/// Projects one painted frame to ANSI-styled terminal text.
///
/// Rows use the renderer's SGR encoding, are right-trimmed past the last
/// visible or styled cell, and the output ends with a full style reset, so it
/// pastes cleanly into any terminal or capture file.
pub fn frame_ansi(frame: &Frame) -> String {
	let mut output = String::new();
	for row in 0..frame.size().height {
		if row != 0 {
			output.push('\n');
		}
		let mut end = 0;
		for x in 0..frame.size().width {
			let cell = frame.cell(x, row);
			if cell.style().without_link() != Style::default()
				|| !matches!(cell.content(), CellContent::Blank | CellContent::Continuation)
			{
				end = x + 1;
			}
		}
		let mut active = Style::default();
		renderer::emit_style(&mut output, active);
		let mut x = 0;
		while x < end {
			let cell = frame.cell(x, row);
			match cell.content() {
				CellContent::Blank => {
					set_ansi_style(&mut output, &mut active, cell.style());
					output.push(' ');
					x += 1;
				},
				CellContent::Grapheme { text, width } => {
					set_ansi_style(&mut output, &mut active, cell.style());
					output.push_str(text);
					x = x.saturating_add((*width).max(1));
				},
				CellContent::Image { id, row: img_row, col, rows, cols } => {
					let (placeholder, style) =
						kitty::placeholder_cell(*id, *img_row, *col, *rows, *cols);
					set_ansi_style(&mut output, &mut active, style);
					output.push_str(&placeholder);
					x += 1;
				},
				CellContent::Continuation => x += 1,
			}
		}
		renderer::close_active_link(&mut output, &mut active, true);
	}
	renderer::emit_style(&mut output, Style::default());
	output
}

/// Switches the active SGR state when the next cell's style differs.
fn set_ansi_style(output: &mut String, active: &mut Style, style: Style) {
	renderer::emit_cell_style(output, style, active, true);
}

/// Rasterizes one painted terminal frame to a native PNG.
///
/// This reuses the process-local snapcompact pixel backend rather than
/// launching a terminal recorder or browser.
pub fn frame_png(frame: &Frame) -> Result<Vec<u8>, FramePngError> {
	let options = omp_snapcompact::SnapcompactRenderOptions {
		size:        u32::from(frame.size().width).saturating_mul(8).max(8),
		font:        Some("8x13".to_owned()),
		cell_width:  Some(8),
		cell_height: Some(16),
		variant:     Some("bw".to_owned()),
		line_repeat: None,
		stretch:     Some(false),
		columns:     Some(1),
	};
	omp_snapcompact::render_snapcompact_png(&frame_text(frame), &options).map_err(Into::into)
}

/// Serves one request the server can acknowledge without host state —
/// injections, which become mailbox events so hosts observe them like
/// terminal input. Every query returns `Err` with its [`DebugOp`]: the
/// server sends it through the same mailbox and correlates the reply.
fn direct_response(request: DebugRequest) -> Result<serde_json::Value, DebugOp> {
	use serde_json::json;
	Ok(match request {
		DebugRequest::Info => return Err(DebugOp::Info),
		DebugRequest::Text => return Err(DebugOp::Text),
		DebugRequest::Frame => return Err(DebugOp::Frame),
		DebugRequest::Tree => return Err(DebugOp::Tree),
		DebugRequest::Values => return Err(DebugOp::Values),
		DebugRequest::Slots => return Err(DebugOp::Slots),
		DebugRequest::Effect(effect) => {
			if pump::send_event(TerminalEvent::Effect(effect)) {
				json!({ "ok": true, "injected": "effect" })
			} else {
				json!({ "ok": false, "error": "no live terminal to inject into" })
			}
		},
		DebugRequest::Resize => return Err(DebugOp::Resize),
		DebugRequest::Quit => return Err(DebugOp::Quit),
		DebugRequest::Inject(events) => {
			let injected = events.len();
			if events
				.into_iter()
				.all(|event| pump::send_event(TerminalEvent::Input(event)))
			{
				json!({ "ok": true, "injected": injected })
			} else {
				json!({ "ok": false, "error": "no live terminal to inject into" })
			}
		},
		DebugRequest::Events(events) => {
			let injected = events.len();
			if events.into_iter().all(pump::send_event) {
				json!({ "ok": true, "injected": injected })
			} else {
				json!({ "ok": false, "error": "no live terminal to inject into" })
			}
		},
		DebugRequest::Bytes(bytes) => {
			// Raw bytes are a debug action the event actor decodes, so they
			// run through the live decoder state before emitting input.
			let fed = bytes.len();
			if pump::inject_bytes(bytes) {
				json!({ "ok": true, "fed": fed })
			} else {
				json!({ "ok": false, "error": "no live terminal to inject into" })
			}
		},
		DebugRequest::Chords(chords) => {
			// Physical chords resolve through the live keymap, so a bound
			// `M-p` runs its bind exactly like the terminal's `ESC p`.
			let injected = chords.len();
			if pump::inject_chords(chords) {
				json!({ "ok": true, "injected": injected })
			} else {
				json!({ "ok": false, "error": "no live terminal to inject into" })
			}
		},
	})
}

/// Answers the debug queries the terminal itself owns; `None` passes the
/// query on to the host (retained-tree state).
///
/// Called by [`crate::Terminal::next`] when a [`DebugQuery`] is dequeued,
/// so answers observe every previously injected event. `Resize` emulates a
/// SIGWINCH as its side effect; `Quit`'s `C-c` emission stays with the
/// caller.
pub fn terminal_response(op: DebugOp) -> Option<serde_json::Value> {
	use serde_json::json;
	let snapshot = |build: fn(ScreenSnapshot) -> serde_json::Value| {
		screen_snapshot()
			.map_or_else(|| json!({ "ok": false, "error": "no frame painted yet" }), build)
	};
	match op {
		DebugOp::Info => Some(snapshot(|snapshot| {
			json!({
				"ok": true,
				"cols": snapshot.cols,
				"rows": snapshot.rows,
				"height": snapshot.doc_height,
				"cursor": snapshot.cursor.map(|(row, col)| vec![row, col]),
				"window_top": snapshot.window_top,
				"alt_screen": crate::terminal::alt_screen_active(),
				"overlay": snapshot.overlay,
			})
		})),
		DebugOp::Text => Some(snapshot(|snapshot| {
			json!({
				"ok": true,
				"lines": snapshot.lines,
				"cursor": snapshot.cursor.map(|(row, col)| vec![row, col]),
				"window_top": snapshot.window_top,
				"alt_screen": crate::terminal::alt_screen_active(),
			})
		})),
		DebugOp::Resize => {
			terminal::simulate_resize_signal();
			Some(json!({ "ok": true, "signalled": true }))
		},
		DebugOp::Quit => Some(json!({ "ok": true, "injected": "C-c" })),
		DebugOp::Frame | DebugOp::Tree | DebugOp::Values | DebugOp::Slots => None,
	}
}

/// One parsed debug request.
pub enum DebugRequest {
	Info,
	Text,
	Frame,
	Tree,
	Values,
	/// Lists retained extension slots through the host's scene registry.
	Slots,
	/// Serialized extension effect injected into the normal event mailbox.
	Effect(serde_json::Value),
	/// Events to inject into the mailbox, already decoded.
	Inject(Vec<InputEvent>),
	/// Physical chords for the live keymap (`keys` op): delivered as the
	/// chord edges or semantic keys the decoder would emit for them.
	Chords(Vec<Chord>),
	/// Serialized terminal events to inject verbatim.
	Events(Vec<TerminalEvent>),
	/// Raw bytes for the live input decoder.
	Bytes(Vec<u8>),
	Resize,
	Quit,
}
/// Parses one request line into a [`DebugRequest`].
pub fn parse_request(line: &[u8]) -> Result<DebugRequest, String> {
	let value: serde_json::Value =
		serde_json::from_slice(line).map_err(|error| format!("malformed request: {error}"))?;
	let op = value
		.get("op")
		.and_then(serde_json::Value::as_str)
		.ok_or_else(|| "missing \"op\"".to_owned())?;
	match op {
		"info" => Ok(DebugRequest::Info),
		"text" => Ok(DebugRequest::Text),
		"frame" => Ok(DebugRequest::Frame),
		"tree" => Ok(DebugRequest::Tree),
		"values" => Ok(DebugRequest::Values),
		"slots" => Ok(DebugRequest::Slots),
		"effect" => {
			let effect = value
				.get("effect")
				.cloned()
				.ok_or_else(|| "effect op needs an \"effect\" object".to_owned())?;
			Ok(DebugRequest::Effect(effect))
		},
		"keys" => {
			let spec = value
				.get("keys")
				.and_then(serde_json::Value::as_str)
				.ok_or_else(|| "keys op needs a \"keys\" string".to_owned())?;
			Ok(DebugRequest::Chords(parse_keys(spec)?))
		},
		"bytes" => {
			let data = value
				.get("data")
				.and_then(serde_json::Value::as_str)
				.ok_or_else(|| "bytes op needs a \"data\" string".to_owned())?;
			Ok(DebugRequest::Bytes(data.as_bytes().to_vec()))
		},
		"paste" => {
			let text = value
				.get("text")
				.and_then(serde_json::Value::as_str)
				.ok_or_else(|| "paste op needs a \"text\" string".to_owned())?;
			Ok(DebugRequest::Inject(vec![InputEvent::Paste(Str::new(text))]))
		},
		"mouse" => Ok(DebugRequest::Inject(vec![InputEvent::Mouse(parse_mouse(&value)?)])),
		"event" | "events" => {
			let payload = value
				.get("event")
				.or_else(|| value.get("events"))
				.ok_or_else(|| "event op needs an \"event\" (or \"events\") field".to_owned())?;
			let events = if payload.is_array() {
				serde_json::from_value::<Vec<TerminalEvent>>(payload.clone())
			} else {
				serde_json::from_value::<TerminalEvent>(payload.clone()).map(|event| vec![event])
			}
			.map_err(|error| format!("malformed terminal event: {error}"))?;
			Ok(DebugRequest::Events(events))
		},
		"resize" => Ok(DebugRequest::Resize),
		"quit" => Ok(DebugRequest::Quit),
		other => Err(format!("unknown op {other:?}")),
	}
}

/// Parses a whitespace-separated key spec into physical chords.
///
/// Named tokens (`tab`, `enter`, `esc`, `up`, `pgdn`, `f5`, ...) map to
/// their native keys; `C-x`, `M-x`/`A-x`, and `C-M-x` carry modifiers; the
/// semantic spellings (`word-left`, `copy-line`, `paste-raw`, ...) name the
/// default chord the keymap folds into that key; a single-quoted or
/// double-quoted token types its characters literally, as does any
/// single-character token.
pub fn parse_keys(spec: &str) -> Result<Vec<Chord>, String> {
	let mut keys = Vec::new();
	let mut rest = spec.trim_start();
	while !rest.is_empty() {
		if let Some(quote) = rest.chars().next().filter(|ch| matches!(ch, '\'' | '"')) {
			let body = &rest[quote.len_utf8()..];
			let end = body
				.find(quote)
				.ok_or_else(|| format!("unterminated quote in key spec: {rest:?}"))?;
			keys.extend(body[..end].chars().map(literal_key));
			rest = body[end + quote.len_utf8()..].trim_start();
			continue;
		}
		let token = rest
			.split_whitespace()
			.next()
			.expect("non-empty trimmed spec");
		keys.push(parse_token(token)?);
		rest = rest[token.len()..].trim_start();
	}
	Ok(keys)
}

/// The chord the terminal decoder would produce for typing `ch`.
const fn literal_key(ch: char) -> Chord {
	Chord::plain(match ch {
		' ' => Key::Space,
		_ => Key::Char(ch),
	})
}

const fn with_mods(key: Key, ctrl: bool, alt: bool, shift: bool) -> Chord {
	Chord::new(key, Mods { ctrl, alt, shift, super_key: false, hyper: false, meta: false })
}

fn parse_token(token: &str) -> Result<Chord, String> {
	// Chord prefixes; a bare single character falls through to literal.
	if token.chars().count() > 1 {
		let lower = token.to_ascii_lowercase();
		if let Some(ch) = strip_chord(&lower, &["c-m-", "m-c-", "ctrl-alt-"]) {
			return Ok(with_mods(Key::Char(ch), true, true, false));
		}
		if let Some(ch) = strip_chord(&lower, &["c-", "ctrl-", "ctrl+"]) {
			return Ok(with_mods(Key::Char(ch), true, false, false));
		}
		if let Some(ch) = strip_chord(&lower, &["m-", "a-", "alt-", "alt+"]) {
			return Ok(with_mods(Key::Char(ch), false, true, false));
		}
	}
	let named = match token.to_ascii_lowercase().as_str() {
		"up" => Chord::plain(Key::Up),
		"down" => Chord::plain(Key::Down),
		"left" => Chord::plain(Key::Left),
		"right" => Chord::plain(Key::Right),
		"tab" => Chord::plain(Key::Tab),
		"backtab" | "shift-tab" => with_mods(Key::Tab, false, false, true),
		"alt-enter" => with_mods(Key::Enter, false, true, false),
		"enter" | "return" | "cr" => Chord::plain(Key::Enter),
		"space" => Chord::plain(Key::Space),
		"esc" | "escape" => Chord::plain(Key::Esc),
		"backspace" | "bs" => Chord::plain(Key::Backspace),
		"delete" | "del" => Chord::plain(Key::Delete),
		"insert" => Chord::plain(Key::Insert),
		"home" => Chord::plain(Key::Home),
		"end" => Chord::plain(Key::End),
		"pgup" | "pageup" => Chord::plain(Key::PageUp),
		"pgdn" | "pagedown" => Chord::plain(Key::PageDown),
		"shift-enter" => with_mods(Key::Enter, false, false, true),
		"word-left" => with_mods(Key::Left, true, false, false),
		"word-right" => with_mods(Key::Right, true, false, false),
		"word-delete" => with_mods(Key::Char('d'), false, true, false),
		"alt-up" | "restore-queue" => with_mods(Key::Up, false, true, false),
		"copy-line" => with_mods(Key::Char('l'), false, true, true),
		"copy-prompt" => with_mods(Key::Char('c'), false, true, true),
		"paste" => with_mods(Key::Char('v'), true, false, false),
		"paste-raw" => with_mods(Key::Char('v'), true, false, true),
		"plan-toggle" => with_mods(Key::Char('p'), false, true, true),
		other => {
			if let Some(number) = other.strip_prefix('f')
				&& let Ok(number) = number.parse::<u8>()
				&& (1..=12).contains(&number)
			{
				return Ok(Chord::plain(Key::Function(number)));
			}
			let mut chars = token.chars();
			return match (chars.next(), chars.next()) {
				(Some(ch), None) => Ok(literal_key(ch)),
				_ => Err(format!("unknown key token {token:?}")),
			};
		},
	};
	Ok(named)
}

/// Strips one chord prefix and requires a single trailing character.
fn strip_chord(token: &str, prefixes: &[&str]) -> Option<char> {
	prefixes.iter().find_map(|prefix| {
		let rest = token.strip_prefix(prefix)?;
		let mut chars = rest.chars();
		match (chars.next(), chars.next()) {
			(Some(ch), None) => Some(ch),
			_ => None,
		}
	})
}

fn parse_mouse(value: &serde_json::Value) -> Result<MouseReport, String> {
	let coordinate = |name: &str| -> Result<u16, String> {
		value
			.get(name)
			.and_then(serde_json::Value::as_u64)
			.and_then(|number| u16::try_from(number).ok())
			.ok_or_else(|| format!("mouse op needs a numeric \"{name}\""))
	};
	let col = coordinate("x")?;
	let row = coordinate("y")?;
	let action = value
		.get("action")
		.and_then(serde_json::Value::as_str)
		.unwrap_or("click");
	let (kind, button, pressed) = match action {
		"click" | "press" => (Mouse::Click, MouseButton::Left, true),
		"right-click" => (Mouse::RightClick, MouseButton::Right, true),
		"middle-click" => (Mouse::MiddleClick, MouseButton::Middle, true),
		"move" => (Mouse::Move, MouseButton::None, false),
		"drag" => (Mouse::Drag, MouseButton::Left, true),
		"release" => (Mouse::Release, MouseButton::Left, false),
		"wheel-up" => (Mouse::WheelUp, MouseButton::WheelUp, true),
		"wheel-down" => (Mouse::WheelDown, MouseButton::WheelDown, true),
		"wheel-left" => (Mouse::WheelLeft, MouseButton::WheelLeft, true),
		"wheel-right" => (Mouse::WheelRight, MouseButton::WheelRight, true),
		other => return Err(format!("unknown mouse action {other:?}")),
	};
	Ok(MouseReport { kind, col, row, button, mods: Default::default(), pressed })
}

/// Whether the server thread was (attempted to be) started.
#[cfg(unix)]
static SERVER_STARTED: AtomicBool = AtomicBool::new(false);

/// Starts the debug server thread once when `OMP_TUI_DEBUG` is set.
///
/// The socket binds here so a bad path fails loudly in the caller; the
/// thread then owns the listener and answers requests on its own async
/// loop. Idempotent; called on terminal entry.
#[cfg(unix)]
pub fn ensure_server() -> io::Result<()> {
	if !enabled() || SERVER_STARTED.swap(true, Ordering::AcqRel) {
		return Ok(());
	}
	server::spawn_thread()
}

#[cfg(not(unix))]
pub(crate) fn ensure_server() -> io::Result<()> {
	Ok(())
}

#[cfg(unix)]
mod server {
	use std::{io, path::PathBuf, task::Poll, time::Duration};

	use tokio::net::{UnixListener, UnixStream};

	use super::{
		DEBUG_ENV, DebugQuery, DebugRequest, RESPONSES, TerminalEvent, direct_response, parse_request,
	};

	/// How long a retained-state query may wait for a host answer; hosts
	/// without a retained tree never answer, so expiry is the normal path
	/// for them.
	const QUERY_TIMEOUT: Duration = Duration::from_secs(2);

	/// Binds the socket and starts the `omp-tui-debug` thread running the
	/// async serve loop on a dedicated current-thread runtime.
	///
	/// Binding happens on the caller so a set-but-unbindable path is a loud
	/// error rather than a silently missing socket.
	pub(super) fn spawn_thread() -> io::Result<()> {
		let path = PathBuf::from(
			std::env::var_os(DEBUG_ENV).expect("enabled() checked the variable before spawning"),
		);
		match std::fs::remove_file(&path) {
			Ok(()) => {},
			Err(error) if error.kind() == io::ErrorKind::NotFound => {},
			Err(error) => return Err(error),
		}
		let listener = std::os::unix::net::UnixListener::bind(&path)?;
		listener.set_nonblocking(true)?;
		let (responses_tx, responses_rx) = flume::unbounded();
		*RESPONSES.lock() = Some(responses_tx);
		std::thread::Builder::new()
			.name("omp-tui-debug".into())
			.spawn(move || {
				let runtime = tokio::runtime::Builder::new_current_thread()
					.enable_io()
					.enable_time()
					.build()
					.expect("debug server runtime builds");
				runtime.block_on(async move {
					let Ok(listener) = UnixListener::from_std(listener) else {
						return;
					};
					let mut server = DebugServer::new(listener);
					serve_loop(&mut server, responses_rx).await;
				});
			})?;
		Ok(())
	}

	/// One in-flight retained-state query.
	struct PendingQuery {
		id:      u64,
		client:  u64,
		expires: tokio::time::Instant,
	}

	/// Answers requests forever.
	///
	/// Input, screen, resize, and quit ops resolve immediately
	/// ([`direct_response`]); retained-state ops ride the terminal mailbox
	/// as [`TerminalEvent::Debug`] queries and resolve when the host calls
	/// [`super::respond_debug_query`] — or expire for hosts that never answer.
	async fn serve_loop(
		server: &mut DebugServer,
		responses: flume::Receiver<(u64, serde_json::Value)>,
	) {
		let mut pending: Vec<PendingQuery> = Vec::new();
		let mut next_id = 1_u64;
		loop {
			let expiry = pending.iter().map(|query| query.expires).min();
			tokio::select! {
				received = server.recv() => {
					let (client, request) = received;
					let request = match request {
						Err(error) => {
							server
								.respond(client, &serde_json::json!({ "ok": false, "error": error }));
							continue;
						},
						Ok(request) => request,
					};
					match direct_response(request) {
						Ok(response) => server.respond(client, &response),
						Err(op) => {
							let id = next_id;
							next_id += 1;
							if crate::pump::send_event(TerminalEvent::Debug(DebugQuery { id, op })) {
								pending.push(PendingQuery {
									id,
									client,
									expires: tokio::time::Instant::now() + QUERY_TIMEOUT,
								});
							} else {
								server.respond(client, &serde_json::json!({
									"ok": false,
									"error": "no live terminal to query",
								}));
							}
						},
					}
				},
				response = responses.recv_async() => {
					let Ok((id, response)) = response else {
						return;
					};
					if let Some(index) = pending.iter().position(|query| query.id == id) {
						let query = pending.swap_remove(index);
						server.respond(query.client, &response);
					}
				},
				() = expire(expiry) => {
					let now = tokio::time::Instant::now();
					let mut index = 0;
					while index < pending.len() {
						if pending[index].expires <= now {
							let query = pending.swap_remove(index);
							server.respond(query.client, &serde_json::json!({
								"ok": false,
								"error": "no retained host answered; use `text` (omp_tui::App answers frame/tree/values)",
							}));
						} else {
							index += 1;
						}
					}
				},
			}
		}
	}

	/// Sleeps until the earliest pending expiry; pending forever without one.
	async fn expire(at: Option<tokio::time::Instant>) {
		match at {
			Some(at) => tokio::time::sleep_until(at).await,
			None => std::future::pending().await,
		}
	}

	/// Line-framed JSON server owned by the debug thread.
	struct DebugServer {
		listener:  UnixListener,
		conns:     Vec<Conn>,
		next_conn: u64,
	}

	struct Conn {
		/// Stable client id; survives [`DebugServer::recv`]'s compaction of
		/// dead connections, so pending queries can hold it across calls.
		id:     u64,
		stream: UnixStream,
		buf:    Vec<u8>,
		out:    Vec<u8>,
		dead:   bool,
	}

	impl Conn {
		/// Pops one complete request line, excluding its newline.
		fn take_line(&mut self) -> Option<Vec<u8>> {
			let end = self.buf.iter().position(|byte| *byte == b'\n')?;
			let line = self.buf[..end].to_vec();
			self.buf.drain(..=end);
			Some(line)
		}

		/// Drains readable bytes; EOF or a hard error retires the connection.
		fn fill(&mut self) {
			let mut bytes = [0_u8; 4096];
			loop {
				match self.stream.try_read(&mut bytes) {
					Ok(0) => {
						self.dead = true;
						return;
					},
					Ok(read) => self.buf.extend_from_slice(&bytes[..read]),
					Err(error) if error.kind() == io::ErrorKind::WouldBlock => return,
					Err(_) => {
						self.dead = true;
						return;
					},
				}
			}
		}

		/// Writes as much pending response output as the socket accepts;
		/// the rest flushes when [`DebugServer::recv`] sees it writable.
		fn flush(&mut self) {
			while !self.out.is_empty() {
				match self.stream.try_write(&self.out) {
					Ok(0) => {
						self.dead = true;
						return;
					},
					Ok(written) => {
						self.out.drain(..written);
					},
					Err(error) if error.kind() == io::ErrorKind::WouldBlock => return,
					Err(_) => {
						self.dead = true;
						return;
					},
				}
			}
		}
	}

	impl DebugServer {
		const fn new(listener: UnixListener) -> Self {
			Self { listener, conns: Vec::new(), next_conn: 1 }
		}

		/// Waits for the next complete request from any client, flushing
		/// buffered responses as their sockets drain.
		///
		/// Cancel-safe: partial lines stay buffered per connection. The
		/// returned client id addresses the sender for
		/// [`DebugServer::respond`] and stays stable for the connection's
		/// lifetime, so pending queries may hold it across `recv` calls.
		async fn recv(&mut self) -> (u64, Result<DebugRequest, String>) {
			loop {
				self.conns.retain(|conn| !conn.dead);
				for conn in &mut self.conns {
					if let Some(line) = conn.take_line() {
						return (conn.id, parse_request(&line));
					}
				}

				let Self { listener, conns, next_conn } = self;
				tokio::select! {
					accepted = listener.accept() => {
						if let Ok((stream, _)) = accepted {
							let id = *next_conn;
							*next_conn += 1;
							tracing::info!(client_id = id, "tui debug client connected");
							conns.push(Conn {
								id,
								stream,
								buf: Vec::new(),
								out: Vec::new(),
								dead: false,
							});
						}
					},
					index = ready(conns) => {
						conns[index].fill();
						conns[index].flush();
					},
				}
			}
		}

		/// Queues one JSON response line for the client with id `client` and
		/// flushes it immediately when the socket has room; leftovers flush
		/// when [`DebugServer::recv`] sees the socket writable. Responses to
		/// disconnected clients are dropped.
		fn respond(&mut self, client: u64, response: &serde_json::Value) {
			let Some(conn) = self.conns.iter_mut().find(|conn| conn.id == client) else {
				return;
			};
			serde_json::to_writer(&mut conn.out, response).expect("JSON responses serialize");
			conn.out.push(b'\n');
			conn.flush();
		}
	}

	/// Resolves with the index of the first connection that is readable — or
	/// writable while holding buffered response output; pending while none
	/// are (including the empty set, leaving `accept` to wake).
	async fn ready(conns: &[Conn]) -> usize {
		std::future::poll_fn(|cx| {
			for (index, conn) in conns.iter().enumerate() {
				if conn.stream.poll_read_ready(cx).is_ready()
					|| (!conn.out.is_empty() && conn.stream.poll_write_ready(cx).is_ready())
				{
					return Poll::Ready(index);
				}
			}
			Poll::Pending
		})
		.await
	}

	#[cfg(test)]
	mod tests {
		use std::time::Duration;

		use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

		use super::{DebugServer, serve_loop};

		/// A disconnect must not reroute a pending query's reply: client A
		/// parks a retained query and dies, client B occupies A's compacted
		/// slot, and the late host reply for A has to be dropped rather
		/// than delivered to B.
		#[tokio::test]
		async fn pending_query_replies_follow_stable_client_ids() {
			let ingress = crate::pump::publish_ingress_for_test();
			let (responses_tx, responses_rx) = flume::unbounded();

			let path =
				std::env::temp_dir().join(format!("omp-tui-debug-idtest-{}.sock", std::process::id()));
			let _ = std::fs::remove_file(&path);
			let listener = std::os::unix::net::UnixListener::bind(&path).expect("test socket binds");
			listener
				.set_nonblocking(true)
				.expect("nonblocking listener");
			let listener = tokio::net::UnixListener::from_std(listener).expect("listener registers");
			let mut server = DebugServer::new(listener);
			let serve = tokio::spawn(async move { serve_loop(&mut server, responses_rx).await });

			// Client A parks a retained query (id 1), then disconnects.
			let mut first = tokio::net::UnixStream::connect(&path)
				.await
				.expect("first client connects");
			first
				.write_all(b"{\"op\":\"tree\"}\n")
				.await
				.expect("query sends");
			tokio::time::timeout(Duration::from_secs(1), ingress.recv_async())
				.await
				.expect("query reaches the ingress")
				.expect("ingress lives");
			drop(first);

			// Client B lands on the compacted slot an index token would
			// still name and gets its own answer.
			let second = tokio::net::UnixStream::connect(&path)
				.await
				.expect("second client connects");
			let mut second = BufReader::new(second);
			second
				.get_mut()
				.write_all(b"{\"op\":\"keys\",\"keys\":\"x\"}\n")
				.await
				.expect("injection sends");
			let mut line = String::new();
			tokio::time::timeout(Duration::from_secs(1), second.read_line(&mut line))
				.await
				.expect("injection is acknowledged")
				.expect("ack line reads");
			assert!(line.contains("\"injected\""), "unexpected ack: {line:?}");

			// The host reply for the dead client is dropped, not rerouted.
			responses_tx
				.send((1, serde_json::json!({ "leak": "wrong-client", "ok": true })))
				.expect("reply channel lives");
			line.clear();
			let stray =
				tokio::time::timeout(Duration::from_millis(200), second.read_line(&mut line)).await;
			assert!(
				stray.is_err() || line.is_empty(),
				"reply for a disconnected client reached the survivor: {line:?}"
			);

			serve.abort();
			let _ = std::fs::remove_file(&path);
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn key_spec_tokens_chords_and_literals() {
		let keys = parse_keys("tab C-c M-y 'hi there' x pgdn f5 alt-enter").expect("valid spec");
		assert_eq!(keys, vec![
			Chord::plain(Key::Tab),
			with_mods(Key::Char('c'), true, false, false),
			with_mods(Key::Char('y'), false, true, false),
			Chord::plain(Key::Char('h')),
			Chord::plain(Key::Char('i')),
			Chord::plain(Key::Space),
			Chord::plain(Key::Char('t')),
			Chord::plain(Key::Char('h')),
			Chord::plain(Key::Char('e')),
			Chord::plain(Key::Char('r')),
			Chord::plain(Key::Char('e')),
			Chord::plain(Key::Char('x')),
			Chord::plain(Key::PageDown),
			Chord::plain(Key::Function(5)),
			with_mods(Key::Enter, false, true, false),
		]);
	}

	/// Injected chords ride the decoder's emission rule: with chord events
	/// on they arrive as the same `alt+p` edge the terminal's `ESC p`
	/// produces (so a `bind alt+p` runs), and otherwise as the keymap's
	/// semantic key — identical to feeding the raw bytes.
	#[test]
	fn injected_chords_match_decoded_bytes_under_both_keymap_modes() {
		let chord = parse_keys("M-p").expect("spec")[0];
		let mut decoder = crate::InputDecoder::new();
		for chords in [false, true] {
			decoder.keymap_mut().set_chord_events(chords);
			let mut injected = Vec::new();
			decoder.inject(chord, &mut injected);
			let mut decoded = Vec::new();
			let now = std::time::Instant::now();
			decoder.feed(b"\x1bp", now, &mut decoded);
			decoder.tick(now + std::time::Duration::from_secs(1), &mut decoded);
			assert_eq!(injected, decoded, "chord events {chords}");
			match &injected[..] {
				[InputEvent::Chord(event)] if chords => {
					assert_eq!(event.chord.label(), "alt+p");
					assert_eq!(event.key, Some(Key::Alt('p')));
					assert!(event.pressed);
				},
				[InputEvent::Key(Key::Alt('p'))] if !chords => {},
				other => panic!("unexpected emission {other:?}"),
			}
		}
	}

	#[test]
	fn key_spec_rejects_unknown_and_unterminated() {
		assert!(parse_keys("bogus-token").is_err());
		assert!(parse_keys("'open").is_err());
	}

	#[test]
	fn request_lines_parse_by_op() {
		assert!(matches!(parse_request(br#"{"op":"text"}"#), Ok(DebugRequest::Text)));
		assert!(matches!(
			parse_request(br#"{"op":"keys","keys":"enter"}"#),
			Ok(DebugRequest::Chords(chords)) if chords == vec![Chord::plain(Key::Enter)]
		));
		assert!(matches!(parse_request(br#"{"op":"slots"}"#), Ok(DebugRequest::Slots)));
		assert!(matches!(
			parse_request(br#"{"op":"effect","effect":{"kind":"mount_slot"}}"#),
			Ok(DebugRequest::Effect(_))
		));
		assert!(parse_request(br#"{"op":"warp"}"#).is_err());
		let mouse = parse_request(br#"{"op":"mouse","x":3,"y":7,"action":"wheel-down"}"#);
		assert!(matches!(
			mouse,
			Ok(DebugRequest::Inject(events))
				if matches!(&events[..], [InputEvent::Mouse(report)]
					if report.kind == Mouse::WheelDown && report.col == 3 && report.row == 7)
		));
	}
}
