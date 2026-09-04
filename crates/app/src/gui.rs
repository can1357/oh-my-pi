//! Native-window adapter for the detached journal-first chat actor.
//!
//! `OMP_TUI_DEBUG=<socket>` selects the shared debug wire and runs this scene
//! off-screen. The named socket injects key/mouse/paste/resize through the same
//! [`omp_gui::Scene`] methods as a window and exposes text, tree, values, and
//! pixel snapshots from the last production-native frame. Native-only `ime`,
//! `drop`, `focus`, and `theme` requests prove the lifecycle paths that have no
//! terminal byte representation.

use std::{cell::RefCell, path::PathBuf, rc::Rc, time::Duration};
#[cfg(unix)]
use std::{
	fs,
	io::{BufRead as _, BufReader, Write as _},
	os::unix::net::{UnixListener, UnixStream},
	thread,
};

#[cfg(unix)]
use miette::IntoDiagnostic as _;
use omp_chat::{HostOptions, NativeEffect, NativeHost};
use omp_gui::{Effect, HostConfig, Scene, SceneFrame};
use omp_tui::{
	Appearance, Dim, Frame, InputEvent, Key, Layer, MouseReport, Notification, OverlayOptions, Size,
	TerminalEvent,
	debug::{self, DebugRequest},
	notify_desktop,
	paste::{ClipboardReadOutcome, ClipboardWriteOutcome},
};
use smallvec::SmallVec;

/// Runs the production chat projection in a native GPU window.
///
/// The scene receives only the detached `Snapshot + Event` actor contract;
/// kernel/session ownership stays in the application controller task.
pub(crate) fn run(options: HostOptions) -> miette::Result<()> {
	let debug = GuiDebug::start()?;
	if debug.active {
		let result = Rc::new(RefCell::new(None));
		let mut scene = GuiScene {
			host: NativeHost::new(options, Size::new(100, 32)),
			viewport: Size::new(100, 32),
			result: Rc::clone(&result),
			approval_options: OverlayOptions::default().width(Dim::Pct(80)).z(30),
			debug,
		};
		while Scene::poll(&mut scene) != Effect::Quit {
			std::thread::sleep(scene.tick());
		}
		drop(scene);
		let outcome = result.borrow_mut().take().unwrap_or(Ok(()));
		return outcome;
	}
	let options = Rc::new(RefCell::new(Some(options)));
	let debug = Rc::new(RefCell::new(Some(debug)));
	let result = Rc::new(RefCell::new(None));
	let build_options = Rc::clone(&options);
	let build_debug = Rc::clone(&debug);
	let build_result = Rc::clone(&result);
	omp_gui::run(HostConfig { multiplex: false, ..HostConfig::default() }, move |ui| {
		let mut options = build_options
			.borrow_mut()
			.take()
			.expect("single-window GUI builds one chat scene");
		options.ui.apply_appearance(ui.appearance);
		GuiScene {
			host:             NativeHost::new(options, Size::new(100, 32)),
			viewport:         Size::new(100, 32),
			result:           Rc::clone(&build_result),
			approval_options: OverlayOptions::default().width(Dim::Pct(80)).z(30),
			debug:            build_debug
				.borrow_mut()
				.take()
				.expect("single-window GUI owns one named debug endpoint"),
		}
	});
	result.borrow_mut().take().unwrap_or(Ok(()))
}

enum GuiDebugOp {
	Shared(DebugRequest),
	ImePreedit { text: String, selection: Option<std::ops::Range<usize>> },
	ImeCommit(String),
	Drop(Vec<PathBuf>),
	Focus(bool),
	Appearance(Appearance),
}

impl From<DebugRequest> for GuiDebugOp {
	fn from(request: DebugRequest) -> Self {
		Self::Shared(request)
	}
}

struct GuiDebugRequest {
	request: GuiDebugOp,
	resize:  Option<Size>,
	reply:   flume::Sender<serde_json::Value>,
}

struct GuiDebug {
	requests: flume::Receiver<GuiDebugRequest>,
	active:   bool,
	#[cfg(unix)]
	socket:   Option<PathBuf>,
}

impl GuiDebug {
	fn disabled() -> Self {
		let (_, requests) = flume::unbounded();
		Self {
			requests,
			active: false,
			#[cfg(unix)]
			socket: None,
		}
	}

	fn start() -> miette::Result<Self> {
		#[cfg(unix)]
		{
			let Some(path) = std::env::var_os(debug::DEBUG_ENV)
				.filter(|value| !value.is_empty())
				.map(PathBuf::from)
			else {
				return Ok(Self::disabled());
			};
			match fs::remove_file(&path) {
				Ok(()) => {},
				Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
				Err(error) => return Err(error).into_diagnostic(),
			}
			let listener = UnixListener::bind(&path).into_diagnostic()?;
			let (send, requests) = flume::unbounded();
			thread::Builder::new()
				.name("omp-gui-debug".into())
				.spawn(move || {
					for client in listener.incoming() {
						let Ok(client) = client else {
							return;
						};
						serve_debug_client(client, &send);
					}
				})
				.into_diagnostic()?;
			return Ok(Self { requests, active: true, socket: Some(path) });
		}
		#[cfg(not(unix))]
		{
			Ok(Self::disabled())
		}
	}
}

#[cfg(unix)]
impl Drop for GuiDebug {
	fn drop(&mut self) {
		if let Some(path) = self.socket.take() {
			let _ = fs::remove_file(path);
		}
	}
}

fn native_debug_op(value: &serde_json::Value) -> Option<Result<GuiDebugOp, &'static str>> {
	let op = value.get("op")?.as_str()?;
	Some(match op {
		"ime" => {
			let Some(phase) = value.get("phase").and_then(serde_json::Value::as_str) else {
				return Some(Err("native ime injection needs phase=preedit|commit"));
			};
			let Some(text) = value.get("text").and_then(serde_json::Value::as_str) else {
				return Some(Err("native ime injection needs string text"));
			};
			match phase {
				"commit" => Ok(GuiDebugOp::ImeCommit(text.to_owned())),
				"preedit" => {
					let selection = match value.get("selection") {
						None | Some(serde_json::Value::Null) => None,
						Some(serde_json::Value::Array(pair)) if pair.len() == 2 => {
							let Some(start) = pair[0]
								.as_u64()
								.and_then(|value| usize::try_from(value).ok())
							else {
								return Some(Err("native ime selection needs two byte offsets"));
							};
							let Some(end) = pair[1]
								.as_u64()
								.and_then(|value| usize::try_from(value).ok())
							else {
								return Some(Err("native ime selection needs two byte offsets"));
							};
							Some(start..end)
						},
						_ => return Some(Err("native ime selection needs two byte offsets")),
					};
					Ok(GuiDebugOp::ImePreedit { text: text.to_owned(), selection })
				},
				_ => Err("native ime injection needs phase=preedit|commit"),
			}
		},
		"drop" => {
			let Some(paths) = value.get("paths").and_then(serde_json::Value::as_array) else {
				return Some(Err("native drop injection needs a paths array"));
			};
			let paths = paths
				.iter()
				.map(|path| path.as_str().map(PathBuf::from))
				.collect::<Option<Vec<_>>>();
			paths
				.filter(|paths| !paths.is_empty())
				.map(GuiDebugOp::Drop)
				.ok_or("native drop injection needs at least one string path")
		},
		"focus" => value
			.get("focused")
			.and_then(serde_json::Value::as_bool)
			.map(GuiDebugOp::Focus)
			.ok_or("native focus injection needs boolean focused"),
		"theme" => {
			let Some(appearance) = value.get("appearance").and_then(serde_json::Value::as_str) else {
				return Some(Err("native theme injection needs appearance=dark|light"));
			};
			if appearance.eq_ignore_ascii_case("dark") {
				Ok(GuiDebugOp::Appearance(Appearance::Dark))
			} else if appearance.eq_ignore_ascii_case("light") {
				Ok(GuiDebugOp::Appearance(Appearance::Light))
			} else {
				Err("native theme injection needs appearance=dark|light")
			}
		},
		_ => return None,
	})
}

#[cfg(unix)]
fn serve_debug_client(mut client: UnixStream, requests: &flume::Sender<GuiDebugRequest>) {
	let Ok(reader) = client.try_clone() else {
		return;
	};
	for line in BufReader::new(reader).lines() {
		let Ok(line) = line else {
			return;
		};
		let resize = serde_json::from_str::<serde_json::Value>(&line)
			.ok()
			.and_then(|value| {
				let cols = value
					.get("cols")?
					.as_u64()
					.and_then(|value| u16::try_from(value).ok())?;
				let rows = value
					.get("rows")?
					.as_u64()
					.and_then(|value| u16::try_from(value).ok())?;
				(cols > 0 && rows > 0).then(|| Size::new(cols, rows))
			});
		let request = match serde_json::from_str::<serde_json::Value>(&line)
			.ok()
			.as_ref()
			.and_then(native_debug_op)
		{
			Some(Ok(request)) => request,
			Some(Err(error)) => {
				let _ = writeln!(client, "{}", serde_json::json!({"ok":false,"error":error}));
				continue;
			},
			None => match debug::parse_request(line.as_bytes()) {
				Ok(request) => request.into(),
				Err(error) => {
					let _ = writeln!(client, "{}", serde_json::json!({"ok":false,"error":error}));
					continue;
				},
			},
		};
		let (reply, receive) = flume::bounded(1);
		if requests
			.send(GuiDebugRequest { request, resize, reply })
			.is_err()
		{
			return;
		}
		let Ok(response) = receive.recv() else {
			return;
		};
		if serde_json::to_writer(&mut client, &response).is_err()
			|| client.write_all(b"\n").is_err()
			|| client.flush().is_err()
		{
			return;
		}
	}
}

struct GuiScene {
	host:             NativeHost,
	viewport:         Size,
	result:           Rc<RefCell<Option<miette::Result<()>>>>,
	approval_options: OverlayOptions,
	debug:            GuiDebug,
}

impl GuiScene {
	fn effect(&mut self, result: Result<NativeEffect, omp_chat::HostError>) -> Effect {
		match result {
			Ok(NativeEffect::Ignored) => Effect::Ignored,
			Ok(NativeEffect::Consumed) => Effect::Consumed,
			Ok(NativeEffect::Quit) => Effect::Quit,
			Err(error) => {
				*self.result.borrow_mut() = Some(Err(miette::miette!(error)));
				Effect::Quit
			},
		}
	}

	fn debug_frame(&mut self) -> Frame {
		let viewport = self.viewport;
		let scene = Scene::render(self);
		let mut frame = Frame::new(viewport);
		let rows = scene.frame.size().height.min(viewport.height);
		let source_top = scene.frame.size().height.saturating_sub(rows);
		frame.blit(scene.frame, source_top, rows, 0, viewport.height.saturating_sub(rows));
		for layer in &scene.layers {
			let band = layer.band(viewport);
			if layer.active {
				frame.clear_cursor();
			}
			frame.blit(layer.frame, band.src_top, band.rows, band.x, band.y);
		}
		frame
	}

	fn poll_debug(&mut self) -> Effect {
		while let Ok(request) = self.debug.requests.try_recv() {
			let (response, effect) = self.debug_response(request.request, request.resize);
			let _ = request.reply.send(response);
			if effect == Effect::Quit {
				return effect;
			}
		}
		Effect::Ignored
	}

	fn debug_response(
		&mut self,
		request: impl Into<GuiDebugOp>,
		resize: Option<Size>,
	) -> (serde_json::Value, Effect) {
		let request = match request.into() {
			GuiDebugOp::Shared(request) => request,
			GuiDebugOp::ImePreedit { text, selection } => {
				let effect = Scene::ime_preedit(self, &text, selection);
				return (serde_json::json!({"ok":true,"injected":"ime-preedit"}), effect);
			},
			GuiDebugOp::ImeCommit(text) => {
				let effect = Scene::ime_commit(self, &text);
				return (serde_json::json!({"ok":true,"injected":"ime-commit"}), effect);
			},
			GuiDebugOp::Drop(paths) => {
				let paths = paths.iter().map(PathBuf::as_path).collect::<Vec<_>>();
				let effect = Scene::drop_files(self, &paths);
				return (serde_json::json!({"ok":true,"injected":"drop"}), effect);
			},
			GuiDebugOp::Focus(focused) => {
				let effect = Scene::focus(self, focused);
				return (serde_json::json!({"ok":true,"injected":"focus","focused":focused}), effect);
			},
			GuiDebugOp::Appearance(appearance) => {
				let effect = Scene::appearance(self, appearance);
				return (serde_json::json!({"ok":true,"injected":"theme"}), effect);
			},
		};
		match request {
			DebugRequest::Info => {
				let document_height = self.host.frame().size().height;
				let window_top = document_height.saturating_sub(self.viewport.height);
				let frame = self.debug_frame();
				let cursor = frame.cursor().map(|(column, row)| vec![row, column]);
				(
					serde_json::json!({
						"ok": true,
						"cols": self.viewport.width,
						"rows": self.viewport.height,
						"height": document_height,
						"cursor": cursor,
						"window_top": window_top,
						"overlay": self.host.overlay_open(),
						"surface": "native",
					}),
					Effect::Ignored,
				)
			},
			DebugRequest::Text => {
				let frame = self.debug_frame();
				let lines = debug::frame_text(&frame)
					.lines()
					.map(str::to_owned)
					.collect::<Vec<_>>();
				(serde_json::json!({"ok":true,"lines":lines,"surface":"native"}), Effect::Ignored)
			},
			DebugRequest::Frame => {
				let frame = self.debug_frame();
				match debug::frame_png(&frame) {
					Ok(png) => (
						serde_json::json!({
							"ok": true,
							"lines": debug::frame_text(&frame).lines().collect::<Vec<_>>(),
							"png": png,
							"surface": "native",
						}),
						Effect::Ignored,
					),
					Err(error) => {
						(serde_json::json!({"ok":false,"error":error.to_string()}), Effect::Ignored)
					},
				}
			},
			DebugRequest::Tree => {
				(serde_json::json!({"ok":true,"tree":self.debug_tree()}), Effect::Ignored)
			},
			DebugRequest::Values => (
				serde_json::json!({
					"ok": true,
					"values": {
						"composer": self.host.composer_text(),
						"turn_active": self.host.turn_active(),
						"overlay": self.host.overlay_id(),
					},
				}),
				Effect::Ignored,
			),
			DebugRequest::Slots => (
				serde_json::json!({
					"ok": true,
					"slots": self.host.blocks().into_iter().map(|block| {
						serde_json::json!({
							"id": block.key.to_string(),
							"kind": format!("{:?}", block.kind),
							"finalized": block.finalized,
						})
					}).collect::<Vec<_>>(),
				}),
				Effect::Ignored,
			),
			DebugRequest::Resize => {
				let Some(viewport) = resize else {
					return (
						serde_json::json!({
							"ok": false,
							"error": "native resize needs positive numeric cols and rows",
						}),
						Effect::Ignored,
					);
				};
				Scene::resize(self, viewport, true);
				(
					serde_json::json!({
						"ok": true,
						"cols": viewport.width,
						"rows": viewport.height,
					}),
					Effect::Consumed,
				)
			},
			DebugRequest::Quit => {
				// `quit` is the debug transport's lifecycle close, not one
				// physical Ctrl-C press (which intentionally only clears on
				// its first rung). Key/chord injection still exercises the
				// production Ctrl-C state machine.
				(serde_json::json!({"ok":true,"closed":true}), Effect::Quit)
			},
			DebugRequest::Inject(events) => self.inject_debug_events(events),
			DebugRequest::Chords(chords) => {
				// The native window has no terminal decoder; physical chords
				// resolve through the default keymap exactly as the PTY host's
				// `keys` op does.
				let keymap = omp_tui::Keymap::default();
				self.inject_debug_events(
					chords
						.into_iter()
						.map(|chord| {
							InputEvent::Chord(omp_tui::KeyEvent {
								chord,
								key: keymap.resolve(chord),
								pressed: true,
							})
						})
						.collect(),
				)
			},
			DebugRequest::Events(events) => {
				let mut input = Vec::new();
				for event in events {
					match event {
						TerminalEvent::Input(event) | TerminalEvent::InputWithMeta { event, .. } => {
							input.push(event)
						},
						TerminalEvent::Resize => {
							let viewport = resize.unwrap_or(self.viewport);
							Scene::resize(self, viewport, true);
						},
						TerminalEvent::Closed => {
							return (serde_json::json!({"ok":true,"injected":"closed"}), Effect::Quit);
						},
						TerminalEvent::Debug(_) | TerminalEvent::Effect(_) => {},
					}
				}
				self.inject_debug_events(input)
			},
			DebugRequest::Bytes(_) => (
				serde_json::json!({
					"ok": false,
					"error": "native input has no terminal byte decoder; inject keys, mouse, or paste",
				}),
				Effect::Ignored,
			),
			DebugRequest::Effect(_) => (
				serde_json::json!({"ok":false,"error":"native extension effects require a live slot"}),
				Effect::Ignored,
			),
		}
	}

	fn inject_debug_events(&mut self, events: Vec<InputEvent>) -> (serde_json::Value, Effect) {
		let count = events.len();
		let mut effect = Effect::Ignored;
		for event in events {
			let next = match event {
				InputEvent::Key(key) => Scene::key(self, key),
				InputEvent::Chord(event) if event.pressed => event
					.key
					.map_or(Effect::Ignored, |key| Scene::key(self, key)),
				InputEvent::Mouse(report) => Scene::mouse(self, report),
				InputEvent::Paste(text) => Scene::paste(self, text.as_str(), false),
				InputEvent::Focus(focused) => Scene::focus(self, focused),
				InputEvent::Chord(_) | InputEvent::Response(_) => Effect::Ignored,
			};
			if next == Effect::Quit {
				effect = next;
				break;
			}
			if next == Effect::Consumed {
				effect = next;
			}
		}
		(serde_json::json!({"ok":true,"injected":count}), effect)
	}

	fn debug_tree(&self) -> serde_json::Value {
		let frame_rows = self.host.frame().size().height;
		let editor_rows = self.host.editor_rows();
		let status_rows = self
			.host
			.status_frame()
			.map_or(0, |frame| frame.size().height);
		let transcript_rows = frame_rows
			.saturating_sub(editor_rows)
			.saturating_sub(status_rows);
		let status_top = transcript_rows;
		let editor_top = status_top.saturating_add(status_rows);
		let mut children = vec![
			serde_json::json!({
				"kind": "Transcript",
				"id": "transcript",
				"rect": [0, 0, self.viewport.width, transcript_rows],
				"visible": transcript_rows > 0,
				"focus": false,
			}),
			serde_json::json!({
				"kind": "Status",
				"id": "status",
				"rect": [0, status_top, self.viewport.width, status_rows],
				"visible": status_rows > 0,
				"focus": false,
			}),
			serde_json::json!({
				"kind": "Composer",
				"id": "composer",
				"rect": [0, editor_top, self.viewport.width, editor_rows],
				"visible": true,
				"focus": !self.host.overlay_open(),
			}),
		];
		if self.host.overlay_open() {
			children.push(serde_json::json!({
				"kind": "Overlay",
				"id": self.host.overlay_id(),
				"rect": [0, 0, self.viewport.width, self.viewport.height],
				"visible": true,
				"focus": true,
			}));
		}
		serde_json::json!({
			"kind": "NativeChat",
			"id": "chat",
			"rect": [0, 0, self.viewport.width, self.viewport.height],
			"visible": true,
			"focus": false,
			"children": children,
		})
	}
}

impl Scene for GuiScene {
	fn resize(&mut self, viewport: Size, _settled: bool) {
		self.viewport = viewport;
		self.host.resize(viewport);
	}

	fn render(&mut self) -> SceneFrame<'_> {
		let mut layers = SmallVec::new();
		if let Some(overlay) = self.host.picker_overlay() {
			layers.push(Layer {
				frame:   &overlay.frame,
				options: &overlay.options,
				active:  overlay.active,
			});
		}
		if let Some(frame) = self.host.approval_frame() {
			layers.push(Layer { frame, options: &self.approval_options, active: true });
		}
		SceneFrame {
			frame: self.host.frame(),
			viewport: self.viewport,
			editor_rows: self.host.editor_rows(),
			layers,
		}
	}

	fn key(&mut self, key: Key) -> Effect {
		let result = self.host.key(key);
		self.effect(result)
	}

	fn mouse(&mut self, report: MouseReport) -> Effect {
		let result = self.host.mouse(report);
		self.effect(result)
	}

	fn paste(&mut self, text: &str, _raw: bool) -> Effect {
		match self.host.paste(text) {
			NativeEffect::Ignored => Effect::Ignored,
			NativeEffect::Consumed => Effect::Consumed,
			NativeEffect::Quit => Effect::Quit,
		}
	}

	fn ime_preedit(&mut self, text: &str, selection: Option<std::ops::Range<usize>>) -> Effect {
		match self.host.ime_preedit(text, selection) {
			NativeEffect::Ignored => Effect::Ignored,
			NativeEffect::Consumed => Effect::Consumed,
			NativeEffect::Quit => Effect::Quit,
		}
	}

	fn ime_commit(&mut self, text: &str) -> Effect {
		let result = self.host.ime_commit(text);
		self.effect(result)
	}

	fn focus(&mut self, focused: bool) -> Effect {
		match self.host.focus(focused) {
			NativeEffect::Ignored => Effect::Ignored,
			NativeEffect::Consumed => Effect::Consumed,
			NativeEffect::Quit => Effect::Quit,
		}
	}

	fn appearance(&mut self, appearance: Appearance) -> Effect {
		match self.host.appearance(appearance) {
			NativeEffect::Ignored => Effect::Ignored,
			NativeEffect::Consumed => Effect::Consumed,
			NativeEffect::Quit => Effect::Quit,
		}
	}

	fn clipboard(&mut self, outcome: ClipboardReadOutcome, raw: bool) -> Effect {
		let effect = self.host.deliver_clipboard(outcome, raw);
		self.effect(Ok(effect))
	}

	fn clipboard_write(&mut self, outcome: ClipboardWriteOutcome) -> Effect {
		let effect = self.host.deliver_clipboard_write(outcome);
		self.effect(Ok(effect))
	}

	fn poll(&mut self) -> Effect {
		let debug = self.poll_debug();
		if debug == Effect::Quit {
			return debug;
		}
		let result = self.host.poll();
		deliver_notifications(self.host.take_notifications(), notify_desktop);
		self.effect(result)
	}

	fn tick(&self) -> Duration {
		Duration::from_millis(16)
	}
}

/// Drains every toast the detached chat actor decided during this poll.
/// Delivery is supplied so the adapter contract can be proved without
/// posting a real desktop notification in tests.
fn deliver_notifications(notifications: Vec<Notification>, mut deliver: impl FnMut(&Notification)) {
	for notification in &notifications {
		deliver(notification);
	}
}

impl Drop for GuiScene {
	fn drop(&mut self) {
		if self.result.borrow().is_none() {
			*self.result.borrow_mut() = Some(Ok(()));
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{cell::RefCell, rc::Rc, sync::Arc};

	use omp_chat::{
		HostOptions, ModelBadge, NativeHost, overlays::NoServices, welcome::WelcomeFacts,
	};
	use omp_core::Str;
	use omp_tui::{Dim, Notification, OverlayOptions, Size, UiContext, debug, slots::ResizePolicy};
	use tempfile::tempdir;

	use super::{Effect, GuiDebug, GuiScene, NativeEffect, deliver_notifications, native_debug_op};

	fn scene() -> GuiScene {
		let directory = tempdir().expect("scratch");
		let scratch = directory.path().to_path_buf();
		let mut session = omp_session::Session::create(
			scratch.join("gui-debug.oms"),
			omp_session::ComponentRegistry::standard(),
		)
		.expect("session");
		let (snapshot, dom_events) = session.subscribe();
		let (_, kernel_events) = flume::unbounded();
		let (commands, _) = flume::unbounded();
		let (up, _) = flume::unbounded();
		let viewport = Size::new(80, 24);
		GuiScene {
			host: NativeHost::new(
				HostOptions {
					snapshot,
					dom_events,
					kernel_events,
					commands,
					up,
					con: Arc::new(omp_con::Ctx::new()),
					models: vec![omp_chat::ModelRow {
						key:         "test/model".into(),
						name:        "Test Model".into(),
						provider_id: "test".into(),
						provider:    "Test".into(),
						context:     Some(200_000),
						input_mtok:  None,
						output_mtok: None,
						efforts:     Vec::new(),
					}],
					cycle: Vec::new(),
					resize_policy: ResizePolicy::Rebuild,
					model: ModelBadge::from_identifier("test/model"),
					project: scratch,
					welcome: WelcomeFacts::default(),
					ui: UiContext::default(),
					services: Arc::new(NoServices),
					speech: None,
					resuming: false,
					initial_panel: None,
				},
				viewport,
			),
			viewport,
			result: Rc::new(RefCell::new(None)),
			approval_options: OverlayOptions::default().width(Dim::Pct(80)).z(30),
			debug: GuiDebug::disabled(),
		}
	}

	#[test]
	fn native_debug_protocol_uses_live_scene_input_and_paint_paths() {
		let mut scene = scene();
		let paste = debug::parse_request(br#"{"op":"paste","text":"hello"}"#).expect("paste");
		let (response, _) = scene.debug_response(paste, None);
		assert_eq!(response["ok"], true);
		assert_eq!(scene.host.composer_text(), "hello");

		let keys = debug::parse_request(br#"{"op":"keys","keys":" space 'world'"}"#).expect("keys");
		let (response, _) = scene.debug_response(keys, None);
		assert_eq!(response["injected"], 6);
		assert_eq!(scene.host.composer_text(), "hello world");

		let preedit = native_debug_op(&serde_json::json!({
			"op": "ime",
			"phase": "preedit",
			"text": "界",
			"selection": [0, 0],
		}))
		.expect("native op")
		.expect("valid preedit");
		let (response, _) = scene.debug_response(preedit, None);
		assert_eq!(response["injected"], "ime-preedit");
		assert_eq!(scene.host.composer_text(), "hello world界");

		let commit = native_debug_op(&serde_json::json!({
			"op": "ime",
			"phase": "commit",
			"text": "界",
		}))
		.expect("native op")
		.expect("valid commit");
		let (response, _) = scene.debug_response(commit, None);
		assert_eq!(response["injected"], "ime-commit");
		assert_eq!(scene.host.composer_text(), "hello world界");

		let resize = debug::parse_request(br#"{"op":"resize","cols":64,"rows":20}"#).expect("resize");
		let (response, _) = scene.debug_response(resize, Some(Size::new(64, 20)));
		assert_eq!(response["cols"], 64);
		assert_eq!(scene.viewport, Size::new(64, 20));

		let theme = native_debug_op(&serde_json::json!({
			"op": "theme",
			"appearance": "light",
		}))
		.expect("native op")
		.expect("valid theme");
		let (response, _) = scene.debug_response(theme, None);
		assert_eq!(response["injected"], "theme");

		let dropped = tempdir().expect("drop fixture");
		let image = dropped.path().join("drop.png");
		std::fs::write(&image, b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x04\0\0\0\x03")
			.expect("image fixture");
		let drop = native_debug_op(&serde_json::json!({
			"op": "drop",
			"paths": [image],
		}))
		.expect("native op")
		.expect("valid drop");
		let (response, _) = scene.debug_response(drop, None);
		assert_eq!(response["injected"], "drop");
		assert!(scene.host.composer_text().contains("[Image #1, 4x3]"));

		let mouse =
			debug::parse_request(br#"{"op":"mouse","x":1,"y":1,"action":"click"}"#).expect("mouse");
		let (response, _) = scene.debug_response(mouse, None);
		assert_eq!(response["injected"], 1);

		assert_eq!(
			scene
				.host
				.act(omp_chat::HostAction::ModelSelect { session_only: false })
				.expect("open native model layer"),
			NativeEffect::Consumed,
		);
		{
			let projection = Scene::render(&mut scene);
			assert!(
				projection.layers.iter().any(|layer| layer.active),
				"native paint includes the same focused overlay as terminal projection",
			);
		}
		assert_eq!(Scene::key(&mut scene, Key::Esc), Effect::Consumed);

		let info = debug::parse_request(br#"{"op":"info"}"#).expect("info");
		let (response, _) = scene.debug_response(info, None);
		assert!(
			response["cursor"]
				.as_array()
				.is_some_and(|cursor| cursor.len() == 2),
			"native debug info must expose the retained caret",
		);

		let frame = debug::parse_request(br#"{"op":"frame"}"#).expect("frame");
		let (response, _) = scene.debug_response(frame, None);
		assert_eq!(response["surface"], "native");
		assert!(
			response["lines"]
				.as_array()
				.is_some_and(|lines| !lines.is_empty())
		);
		assert!(
			response["png"]
				.as_array()
				.is_some_and(|bytes| bytes.len() > 8),
			"native pixel screenshot missing",
		);

		let tree = debug::parse_request(br#"{"op":"tree"}"#).expect("tree");
		let (response, _) = scene.debug_response(tree, None);
		assert_eq!(response["tree"]["kind"], "NativeChat");
		assert_eq!(response["tree"]["rect"], serde_json::json!([0, 0, 64, 20]));
		assert_eq!(response["tree"]["children"][2]["kind"], "Composer");

		let preedit = native_debug_op(&serde_json::json!({
			"op": "ime",
			"phase": "preedit",
			"text": "uncommitted",
			"selection": null,
		}))
		.expect("native op")
		.expect("valid preedit");
		scene.debug_response(preedit, None);
		assert!(scene.host.composer_text().ends_with("uncommitted"));
		let focus = native_debug_op(&serde_json::json!({"op":"focus","focused":false}))
			.expect("native op")
			.expect("valid focus");
		scene.debug_response(focus, None);
		assert!(
			!scene.host.composer_text().ends_with("uncommitted"),
			"focus loss cancels uncommitted marked text",
		);

		let quit = debug::parse_request(br#"{"op":"quit"}"#).expect("quit");
		let (response, effect) = scene.debug_response(quit, None);
		assert_eq!(response["closed"], true);
		assert_eq!(effect, Effect::Quit);
	}

	#[test]
	fn gui_poll_adapter_delivers_every_queued_chat_notification() {
		let queued = vec![
			Notification::builder()
				.title(Str::new_static("session"))
				.body(Str::new_static("Complete"))
				.build(),
			Notification::builder()
				.title(Str::new_static("session"))
				.body(Str::new_static("Waiting for input"))
				.build(),
		];
		let mut delivered = Vec::new();
		deliver_notifications(queued, |notification| {
			delivered.push((
				notification.title.clone().unwrap_or_default(),
				notification.body.clone().unwrap_or_default(),
			));
		});
		assert_eq!(delivered, [
			(Str::new_static("session"), Str::new_static("Complete")),
			(Str::new_static("session"), Str::new_static("Waiting for input")),
		]);
	}
}
