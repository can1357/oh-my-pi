//! The napi `TerminalEngine`: one object per owned terminal, routing stdin,
//! time, and frames between [`InputParser`], [`Session`], [`Screen`], and the
//! output [`Device`].
//!
//! Every call carries the host's clock. Afterwards the host drains
//! [`TerminalEngine::take_events`] (and, with a capture sink,
//! [`TerminalEngine::take_output`]) and re-arms one timer at
//! [`TerminalEngine::next_deadline`].
//!
//! An engine that owns the process's stdio writes stdout from the output
//! writer's thread and, while input is attached, reads stdin on its own
//! thread. Both call `onWake` — the writer when its backlog drains or the
//! terminal fails, the reader when reads are queued or stdin ends — and the
//! host answers with `tick`, which also feeds the queued reads.

use std::{mem, path::Path, sync::Arc};

use napi::{
	Result, Status,
	bindgen_prelude::{Buffer, Function, FunctionRef, Uint8Array},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;

use super::{
	budget::ImageBudget,
	input::InputParser,
	js::{
		EngineAltFrame, EngineConfig, EngineCursor, EngineDebugPaint, EngineEvent, EngineFrameKind,
		EngineFrameView, EnginePlanFrame, EnginePresentResult, EngineRenderRequest,
		EngineResizeFrame, EngineResizeScrollback, EngineViewport, buffers,
	},
	profile::{Env, forced_image_protocol, multiplexer::Multiplexer, tern_pane, tmux},
	screen::{FrameView, ProviderFacts, RenderRequest, Screen, overlay::Overlay},
	session::Session,
	surface::Handshake,
	types::{
		AltFrame, Event, FrameKind, ImageProtocol, Input, PlanFrame, Report, ResizeScrollback, Size,
	},
};
use crate::term::{Device, Stdin, StdinEnd, StdinReads};

/// Backlog at or below which stdout is healthy again; the pump wakes the host
/// when it drains to this level (`STDOUT_BACKLOG_CLEAR_BYTES` in pi-tui).
const DRAIN_THRESHOLD_BYTES: u32 = 256 * 1024;

/// How long `stop` lets the pump drain the restore before cancelling it.
const STOP_FLUSH_TIMEOUT_MS: u32 = 1000;

/// Weak, nonblocking wake-up: does not keep the event loop alive.
type WakeCallback = ThreadsafeFunction<(), (), (), Status, false, true>;

/// The stdin reader's wake-up: holds the event loop open while input is
/// attached, as a flowing `process.stdin` did. Released with the reader.
type InputWakeCallback = ThreadsafeFunction<(), (), (), Status, false, false>;

/// Output sink parameters, kept to rebuild the device after `stop`.
struct SinkConfig {
	/// The engine owns the process's stdio.
	stdio:     bool,
	write_log: Option<String>,
	wake:      Arc<WakeCallback>,
}

impl SinkConfig {
	/// The writer on this process's stdout when the engine owns stdio,
	/// otherwise a capture sink.
	fn device(&self) -> Device {
		let mut device = if self.stdio {
			let wake = Arc::clone(&self.wake);
			let on_drain = Box::new(move || {
				let _ = wake.call((), ThreadsafeFunctionCallMode::NonBlocking);
			});
			Device::stdout(DRAIN_THRESHOLD_BYTES, Some(on_drain))
		} else {
			Device::capture()
		};
		if let Some(path) = &self.write_log {
			// A debug aid: an unwritable log never blocks output.
			let _ = device.log_writes(Path::new(path));
		}
		device
	}
}

/// The terminal engine owned by a pi-tui `Terminal`.
#[napi]
pub struct TerminalEngine {
	sink:                  SinkConfig,
	device:                Device,
	capturing:             bool,
	parser:                InputParser,
	session:               Session,
	screen:                Screen,
	/// Events queued for the host.
	events:                Vec<Event>,
	/// Scratch for parsed input awaiting routing.
	inputs:                Vec<Input>,
	/// Win32-input-mode decoding was on after the last session call.
	win32_input:           bool,
	/// Capture sink: the Node stream's backlog as last reported by the host.
	stream_backlog:        f64,
	/// The latest clock reading any call carried.
	now:                   f64,
	stopped:               bool,
	/// The environment the facts were resolved from; tmux commands run in it.
	env:                   Env,
	/// `PI_FORCE_IMAGE_PROTOCOL` pins the image protocol.
	image_protocol_forced: bool,
	/// This tmux pane's APC titles are off for TSP and must be restored.
	tmux_apc_titles_off:   bool,
	/// The Tern Surface Protocol handshake.
	surface:               Handshake,
	/// `onWake`, for the stdin reader's loop-holding wake-up.
	on_wake:               FunctionRef<(), ()>,
	/// The process's stdin while input is attached (process stdio only).
	stdin:                 Option<Stdin>,
	/// Scratch for the reads taken from the stdin reader.
	reads:                 StdinReads,
}

#[napi]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
impl TerminalEngine {
	/// Create an engine for one terminal. `onWake` runs (on the JS thread,
	/// queued) when the output writer drains or fails, and when the stdin
	/// reader queued reads or stdin ended; answer with `tick`.
	#[napi(constructor)]
	pub fn new(
		config: EngineConfig,
		#[napi(ts_arg_type = "() => void")] on_wake: Function<'_, (), ()>,
	) -> Result<Self> {
		let size = Size { columns: config.columns, rows: config.rows };
		let stdio = config.stdio;
		let (env, facts, write_log) = config.resolve();
		let wake: WakeCallback = on_wake.build_threadsafe_function().weak::<true>().build()?;
		let sink = SinkConfig { stdio, write_log, wake: Arc::new(wake) };
		let device = sink.device();
		let capturing = device.is_capture();
		Ok(Self {
			sink,
			device,
			capturing,
			parser: InputParser::new(),
			session: Session::new(&facts, size),
			screen: Screen::new(&facts),
			events: Vec::new(),
			inputs: Vec::new(),
			win32_input: false,
			stream_backlog: 0.0,
			now: 0.0,
			stopped: false,
			surface: Handshake::new(tern_pane(&env), facts.tsp_expected),
			image_protocol_forced: forced_image_protocol(&env).is_some(),
			env,
			tmux_apc_titles_off: false,
			on_wake: on_wake.create_ref()?,
			stdin: None,
			reads: StdinReads::default(),
		})
	}

	/// Take ownership of the terminal's output: a restarted engine reopens its
	/// output pump.
	#[napi]
	pub fn start(&mut self, now: f64) {
		self.now = now;
		if self.stopped {
			self.device = self.sink.device();
			self.capturing = self.device.is_capture();
			self.parser.reset();
			self.stopped = false;
		}
		self.session.start(&mut self.device);
		self.screen.start(now, &mut self.device);
		self.surface.start();
		self.settle(now);
	}

	/// Take input: with process stdio, put stdin in raw mode and start its
	/// reader; then enable input modes and send the capability probes. Bytes
	/// a cooked tty line-buffered meanwhile are the first read (see the
	/// parser's cooked-typeahead Enter fix). A tty that refuses raw mode (a
	/// revoked pty that still claims to be a TTY) is a disconnect.
	#[napi]
	pub fn attach_input(&mut self, env: &napi::Env, now: f64) -> Result<()> {
		self.now = now;
		let mut cooked_typeahead = false;
		if self.sink.stdio {
			// Put a previous attach's mode back before saving the one to restore.
			self.stdin = None;
			let wake: InputWakeCallback = self
				.on_wake
				.borrow_back(env)?
				.build_threadsafe_function()
				.build()?;
			let on_read = Box::new(move || {
				let _ = wake.call((), ThreadsafeFunctionCallMode::NonBlocking);
			});
			match Stdin::attach(on_read) {
				Ok(stdin) => {
					cooked_typeahead = stdin.cooked_typeahead();
					self.stdin = Some(stdin);
				},
				Err(err) => {
					self.events.push(Event::Disconnected {
						reason: format!("stdin raw mode setup failed: {err}"),
					});
					return Ok(());
				},
			}
		}
		self.parser.note_attach(cooked_typeahead);
		let from = self.events.len();
		self
			.session
			.attach_input(now, &mut self.device, &mut self.events);
		self.route_session_events(now, from);
		self.surface.note_attach(
			now,
			self.session.tsp_probe_pending(),
			&mut self.screen,
			&mut self.device,
			&mut self.events,
		);
		self.settle(now);
		Ok(())
	}

	/// Stdin bytes from the host (capture sinks). `loopStalled`: the event
	/// loop is stalled or just recovered, so an unmarked multiline burst is
	/// batched keystrokes.
	#[napi]
	pub fn input(&mut self, now: f64, data: Uint8Array, loop_stalled: bool) {
		self.now = now;
		self.feed_input(now, &data, loop_stalled);
	}

	/// OS resize (SIGWINCH / `ConPTY`).
	#[napi]
	pub fn resize(&mut self, now: f64, columns: u32, rows: u32) {
		self.now = now;
		self.session.os_resize(columns, rows, &mut self.device);
		self
			.screen
			.os_resize(now, self.session.size(), &mut self.device);
		self.events.push(Event::Resize);
		self.settle(now);
	}

	/// Capture sink: bytes the Node stream still holds after the host wrote
	/// output.
	#[napi]
	pub fn note_stream_backlog(&mut self, now: f64, bytes: f64) {
		self.now = now;
		self.stream_backlog = bytes;
		self.session.sample_backlog(now, bytes, &mut self.events);
		self.settle(now);
	}

	/// Fire every deadline that has come due. With `loopStalled` (the host's
	/// event-loop stall verdict), then feed the reads the stdin reader queued
	/// since, as separate reads.
	#[napi]
	pub fn tick(&mut self, now: f64, loop_stalled: Option<bool>) {
		self.now = now;
		self.parser.tick(now, &mut self.inputs);
		self.route_inputs(now);
		let from = self.events.len();
		self.session.tick(now, &mut self.device, &mut self.events);
		self.route_session_events(now, from);
		self
			.surface
			.tick(now, &mut self.screen, &mut self.device, &mut self.events);
		let pending = self.pending_output();
		self.session.sample_backlog(now, pending, &mut self.events);
		self
			.screen
			.tick(now, self.session.size(), pending, &mut self.device, &mut self.events);
		self.settle(now);
		if let Some(loop_stalled) = loop_stalled {
			self.read_stdin(now, loop_stalled);
		}
	}

	/// The earliest clock reading at which `tick` has work, if any.
	#[napi]
	pub fn next_deadline(&self) -> Option<f64> {
		[
			self.parser.deadline(),
			self.session.deadline(),
			self.surface.deadline(),
			self.screen.deadline(),
		]
		.into_iter()
		.flatten()
		.reduce(f64::min)
	}

	/// Events queued since the last call, in order.
	#[napi]
	pub fn take_events(&mut self) -> Vec<EngineEvent> {
		self.events.drain(..).map(Into::into).collect()
	}

	/// Capture sink: encoded output to write to stdout, chunked between escape
	/// sequences. Always empty for the pump.
	#[napi]
	pub fn take_output(&mut self) -> Vec<Buffer> {
		buffers(self.device.take_output())
	}

	/// True when output is captured for the host to deliver (virtual
	/// terminals, test harnesses) instead of written to stdout.
	#[napi(getter)]
	pub fn capturing(&self) -> bool {
		self.capturing
	}

	/// Opaque output (images, TSP messages, out-of-band OSC sequences).
	#[napi]
	pub fn write(&mut self, text: String) {
		self.session.write(&text, &mut self.device);
	}

	#[napi]
	pub fn set_title(&mut self, title: String) {
		self.session.set_title(&title, &mut self.device);
	}

	/// OSC 9;4 progress (with the keepalive some terminals need).
	#[napi]
	pub fn set_progress(&mut self, now: f64, active: bool) {
		self.now = now;
		self.session.set_progress(now, active, &mut self.device);
	}

	/// DECSCUSR code; deduped against the last shape written.
	#[napi]
	pub fn set_cursor_shape(&mut self, code: u32) {
		self.session.set_cursor_shape(code, &mut self.device);
	}

	/// Hide the hardware cursor (`force` skips the dedupe).
	#[napi]
	pub fn hide_cursor(&mut self, force: bool) {
		self.screen.hide_cursor(force, &mut self.device);
	}

	/// Show the hardware cursor (`force` skips the dedupe).
	#[napi]
	pub fn show_cursor(&mut self, force: bool) {
		self.session.show_cursor(force, &mut self.device);
	}

	/// Start an explicit OSC 11 refresh; returns the accepted request token.
	#[napi]
	pub fn refresh_appearance(&mut self, now: f64, token: Option<u32>) -> Option<u32> {
		self.now = now;
		let accepted = self
			.session
			.refresh_appearance(now, token, &mut self.device);
		self.settle(now);
		accepted
	}

	#[napi]
	pub fn set_show_hardware_cursor(&mut self, enabled: bool) {
		self
			.screen
			.set_show_hardware_cursor(self.now, enabled, &mut self.device);
		self.settle(self.now);
	}

	/// Whether frames position a visible hardware cursor at the focused marker.
	#[napi(getter)]
	pub fn show_hardware_cursor(&self) -> bool {
		self.screen.show_hardware_cursor()
	}

	#[napi]
	pub fn set_resize_scrollback(
		&mut self,
		#[napi(ts_arg_type = "\"append\" | \"rebuild\" | \"preserve\"")] mode: EngineResizeScrollback,
	) {
		self.screen.set_resize_scrollback(mode.into());
	}

	/// How settled resizes refresh native scrollback.
	#[napi(getter, ts_return_type = "\"append\" | \"rebuild\" | \"preserve\"")]
	pub fn resize_scrollback(&self) -> EngineResizeScrollback {
		match self.screen.resize_scrollback() {
			ResizeScrollback::Append => EngineResizeScrollback::Append,
			ResizeScrollback::Rebuild => EngineResizeScrollback::Rebuild,
			ResizeScrollback::Preserve => EngineResizeScrollback::Preserve,
		}
	}

	/// Floor between ordinary frames (`tui.maxFps`).
	#[napi]
	pub fn set_frame_interval_ms(&mut self, ms: f64) {
		self.screen.set_frame_interval(ms);
	}

	/// Whether a frame provider is installed and whether it can replay history.
	#[napi]
	pub fn set_frame_provider(&mut self, now: f64, present: bool, history_replay: bool) {
		self.now = now;
		self
			.screen
			.set_frame_provider(now, present.then_some(ProviderFacts { history_replay }));
		self.settle(now);
	}

	/// Texts whose presence in an emitted row raises a `frameText` event.
	#[napi]
	pub fn set_frame_text_watches(&mut self, texts: Vec<String>) {
		self.screen.set_frame_text_watches(texts);
	}

	/// Share the host's inline-image budget: every paint drains its purges
	/// and transmits, alt-buffer entries reset its alternate surface, and
	/// the redraws it asks for are scheduled here (outside a frame, through
	/// `onWake`).
	#[napi]
	pub fn attach_image_budget(&mut self, budget: &ImageBudget) {
		let shared = budget.shared();
		let wake = Arc::clone(&self.sink.wake);
		shared.borrow_mut().set_wake(Box::new(move || {
			let _ = wake.call((), ThreadsafeFunctionCallMode::NonBlocking);
		}));
		self.screen.attach_image_budget(shared);
	}

	/// Delete every image the attached budget believes the terminal holds
	/// (dropping that tracking) and forget live placements.
	#[napi]
	pub fn clear_inline_images(&mut self) {
		self.screen.clear_inline_images(&mut self.device);
	}

	/// Debug: the row of the composed document the children fallback painted
	/// first.
	#[napi]
	pub fn set_debug_window_top(&mut self, top: u32) {
		self.screen.set_debug_window_top(top);
	}

	/// Ask for a frame; the `render` event announces when it is due.
	#[napi]
	pub fn request_render(&mut self, now: f64, options: Option<EngineRenderRequest>) {
		self.now = now;
		let options = options.unwrap_or_default();
		self.surface.note_render_request();
		self.screen.request_render(now, RenderRequest {
			force:            options.force.unwrap_or(false),
			clear_scrollback: options.clear_scrollback.unwrap_or(false),
			input:            options.input.unwrap_or(false),
			input_grace:      options.input_grace.unwrap_or(false),
			immediate:        options.immediate.unwrap_or(false),
		});
		self.settle(now);
	}

	/// Perform alt-screen/mouse transitions for the frame about to be
	/// composed and say what to compose. Drain events before composing.
	#[napi(ts_return_type = "\"none\" | \"plan\" | \"alt\" | \"resize\"")]
	pub fn begin_frame(&mut self, now: f64, view: EngineFrameView) -> EngineFrameKind {
		self.now = now;
		self.surface.note_render_request();
		let kind = self.screen.begin_frame(
			now,
			self.session.size(),
			FrameView { alt: view.alt, mouse: view.mouse.into() },
			&mut self.device,
		);
		self.settle(now);
		match kind {
			FrameKind::None => EngineFrameKind::None,
			FrameKind::Plan => EngineFrameKind::Plan,
			FrameKind::Alt => EngineFrameKind::Alt,
			FrameKind::Resize => EngineFrameKind::Resize,
		}
	}

	/// Paint a normal-buffer frame, with the visible overlays composited onto
	/// its viewport.
	#[napi]
	pub fn present_plan(&mut self, now: f64, frame: EnginePlanFrame) -> EnginePresentResult {
		self.now = now;
		let mut viewport = frame.viewport;
		if let Some(overlays) = frame.overlays {
			let overlays: Vec<Overlay> = overlays.into_iter().map(Into::into).collect();
			self
				.screen
				.composite_overlays(&mut viewport, &overlays, self.session.size());
		}
		let frame = PlanFrame {
			history: frame.history.map(Into::into),
			viewport,
			want_paint: frame.want_paint,
		};
		let result = self
			.screen
			.present_plan(now, self.session.size(), frame, &mut self.device);
		self.session.note_output(&mut self.device);
		self.settle(now);
		result.into()
	}

	/// Paint a fullscreen-overlay frame on the alternate buffer: the visible
	/// overlays composited onto a blank screen. The normal transcript is never
	/// composited into the alternate buffer.
	#[napi]
	pub fn present_alt(&mut self, now: f64, frame: EngineAltFrame) -> EnginePresentResult {
		self.now = now;
		let size = self.session.size();
		let mut rows = vec![String::new(); size.rows as usize];
		let overlays: Vec<Overlay> = frame.overlays.into_iter().map(Into::into).collect();
		self.screen.composite_overlays(&mut rows, &overlays, size);
		let frame = AltFrame { rows, cursor: frame.cursor, want_paint: frame.want_paint };
		let result = self
			.screen
			.present_alt(now, self.session.size(), frame, &mut self.device);
		self.session.note_output(&mut self.device);
		self.settle(now);
		result.into()
	}

	/// Paint the transient resize buffer.
	#[napi]
	pub fn present_resize(&mut self, now: f64, frame: EngineResizeFrame) {
		self.now = now;
		self
			.screen
			.present_resize(now, self.session.size(), frame.rows, &mut self.device);
		self.session.note_output(&mut self.device);
		self.settle(now);
	}

	/// Disable keyboard enhancements and wait for input to go idle; the
	/// `inputDrained` event ends it.
	#[napi]
	pub fn drain_input(&mut self, now: f64, max_ms: f64, idle_ms: f64) {
		self.now = now;
		let from = self.events.len();
		self
			.session
			.drain_input(now, max_ms, idle_ms, &mut self.device, &mut self.events);
		self.route_session_events(now, from);
		self.settle(now);
	}

	/// First half of stop: leave resize transactions, the alternate screen,
	/// and mouse reporting, and drop a latched destructive reset, so the
	/// host's final history flush paints plain frames.
	#[napi]
	pub fn prepare_stop(&mut self, now: f64) {
		self.now = now;
		// The host closes its surface backend itself; the screen drops the
		// surface and the first-paint hold.
		self.surface.stop(now, &mut self.screen, &mut self.device);
		self
			.screen
			.prepare_stop(now, self.session.size(), &mut self.device);
		self.settle(now);
	}

	/// Hand the terminal back: stop reading stdin, park the shell prompt below
	/// the content, restore every mode the session changed, retire the output
	/// writer, and put stdin's terminal mode back.
	///
	/// Throws when stdin's terminal mode cannot be restored, after everything
	/// else was handed back: a live terminal is left raw then, while a hung-up
	/// one has nothing left to restore (the host knows which).
	#[napi]
	pub fn stop(&mut self, now: f64) -> Result<()> {
		self.now = now;
		if self.stopped {
			return Ok(());
		}
		// Nothing is read from here on: bytes typed during teardown stay queued
		// for the shell or the program taking the terminal over.
		if let Some(stdin) = &mut self.stdin {
			stdin.stop_reading();
		}
		self.surface.stop(now, &mut self.screen, &mut self.device);
		self
			.screen
			.stop_handoff(self.session.size(), &mut self.device);
		let from = self.events.len();
		self.session.stop(&mut self.device, &mut self.events);
		self.route_session_events(now, from);
		// Hand APC titles back to tmux once this pane stops speaking TSP.
		if self.tmux_apc_titles_off {
			self.set_tmux_apc_titles(true);
		}
		self.parser.reset();
		self.inputs.clear();
		self.device.stop(STOP_FLUSH_TIMEOUT_MS);
		self.stopped = true;
		let Some(stdin) = self.stdin.take() else {
			return Ok(());
		};
		stdin.detach().map_err(|err| {
			napi::Error::from_reason(format!("restoring the stdin terminal mode failed: {err}"))
		})
	}

	/// Effective columns (in-band report when active, else OS).
	#[napi(getter)]
	pub fn columns(&self) -> u32 {
		self.session.size().columns
	}

	/// Effective rows (in-band report when active, else OS).
	#[napi(getter)]
	pub fn rows(&self) -> u32 {
		self.session.size().rows
	}

	/// Output accepted but not yet delivered to the terminal.
	#[napi(getter)]
	pub fn pending_output_bytes(&self) -> f64 {
		self.pending_output()
	}

	/// DEC 2026 wrappers are emitted around paints.
	#[napi(getter)]
	pub fn synchronized_output(&self) -> bool {
		self.screen.synchronized_output()
	}

	/// Cost of the most recent frame, compose included.
	#[napi(getter)]
	pub fn last_frame_cost_ms(&self) -> f64 {
		self.screen.last_frame_cost_ms()
	}

	#[napi(getter)]
	pub fn full_redraws(&self) -> u32 {
		self.screen.full_redraws()
	}

	#[napi(getter)]
	pub fn kitty_protocol_active(&self) -> bool {
		self.session.kitty_active()
	}

	/// The last detected appearance (`true` = dark), if known.
	#[napi(getter)]
	pub fn appearance_dark(&self) -> Option<bool> {
		self.session.appearance_dark()
	}

	/// The TSP hello awaits its reply or DA1 sentinel.
	#[napi(getter)]
	pub fn tsp_probe_pending(&self) -> bool {
		self.session.tsp_probe_pending()
	}

	/// Mutable normal-buffer viewport from the last provider frame (inline click
	/// targets).
	#[napi]
	pub fn mutable_viewport(&self) -> EngineViewport {
		let viewport = self.screen.mutable_viewport();
		EngineViewport { top: viewport.top, length: viewport.length }
	}

	/// History rows left on screen above a bottom-reaching viewport.
	#[napi]
	pub fn filled_history_rows(&self) -> Option<u32> {
		self.screen.filled_history_rows(self.session.size())
	}

	/// Native history holds rows the provider committed since the last reset.
	#[napi]
	pub fn has_provider_history(&self) -> bool {
		self.screen.has_provider_history()
	}

	/// The last painted viewport, for debug inspection.
	#[napi]
	pub fn debug_paint(&self) -> Option<EngineDebugPaint> {
		self.screen.debug_paint().map(|paint| EngineDebugPaint {
			lines:      paint.lines,
			window_top: paint.window_top,
			alt_screen: paint.alt_screen,
			cursor:     paint.cursor.map(|cursor| EngineCursor {
				x:       cursor.x,
				y:       cursor.y,
				visible: cursor.visible,
			}),
		})
	}
}

impl TerminalEngine {
	fn pending_output(&self) -> f64 {
		if self.capturing {
			self.stream_backlog
		} else {
			self.device.pending() as f64
		}
	}

	/// One stdin read.
	fn feed_input(&mut self, now: f64, data: &[u8], loop_stalled: bool) {
		self
			.session
			.note_input(now, self.parser.pasting(), &mut self.device);
		self.parser.feed(now, data, loop_stalled, &mut self.inputs);
		self.settle(now);
	}

	/// Feed the reads the stdin reader queued, each as its own read, then
	/// report the end of stdin as a disconnect.
	fn read_stdin(&mut self, now: f64, loop_stalled: bool) {
		let Some(stdin) = &self.stdin else {
			return;
		};
		let mut reads = mem::take(&mut self.reads);
		let end = stdin.take(&mut reads);
		for read in reads.iter() {
			self.feed_input(now, read, loop_stalled);
		}
		reads.clear();
		self.reads = reads;
		let reason = match end {
			None => return,
			Some(StdinEnd::Eof) => "stdin ended".to_owned(),
			Some(StdinEnd::Failed(err)) => format!("stdin failed: {err}"),
		};
		self.events.push(Event::Disconnected { reason });
	}

	/// Route parsed input: keys and pastes to the host (dropped while input
	/// drains), reports to the session, cursor position reports the session
	/// returns to the screen.
	#[allow(
		clippy::iter_with_drain,
		reason = "`drain(..)` keeps the inputs allocation, which is handed back to `self.inputs` \
		          for reuse"
	)]
	fn route_inputs(&mut self, now: f64) {
		let mut inputs = std::mem::take(&mut self.inputs);
		for input in inputs.drain(..) {
			match input {
				Input::Key(data) => {
					if !self.session.draining() {
						self.events.push(Event::Key(data));
					}
				},
				Input::Paste { text, enter } => {
					if !self.session.draining() {
						self.events.push(Event::Paste { text, enter });
					}
				},
				Input::Report(report) => self.route_report(now, report),
			}
		}
		// Hand the (empty) scratch back so its capacity is reused.
		self.inputs = inputs;
	}

	fn route_report(&mut self, now: f64, report: Report) {
		let from = self.events.len();
		let unclaimed = self
			.session
			.handle_report(now, report, &mut self.device, &mut self.events);
		self.route_session_events(now, from);
		if let Some(Report::CursorPosition { row, column }) = unclaimed {
			let size = self.session.size();
			if !self
				.screen
				.handle_cursor_position(now, size, row, column, &mut self.device)
				&& !self.session.draining()
			{
				// Not an anchor probe reply: `CSI 1;<mod>R` is a modified F3.
				self
					.events
					.push(Event::Key(format!("\x1b[{row};{column}R")));
			}
		}
	}

	/// Apply session events the screen or parser must see: in-band geometry
	/// changes, DECRPM results (synchronized output), cell size, the end of
	/// an input drain. tmux APC title changes are applied here and never reach
	/// the host; a DA1 SIXEL advertisement is qualified first.
	fn route_session_events(&mut self, now: f64, from: usize) {
		let mut index = from;
		while index < self.events.len() {
			match self.events[index] {
				Event::TspHello { .. } => {
					let Event::TspHello { json, reason } = self.events.remove(index) else {
						unreachable!()
					};
					let mut transitions = Vec::new();
					self.surface.resolve(
						now,
						json,
						reason,
						&mut self.screen,
						&mut self.device,
						&mut transitions,
					);
					let count = transitions.len();
					self.events.splice(index..index, transitions);
					index += count;
					continue;
				},
				Event::TmuxApcTitles { enabled } => {
					self.events.remove(index);
					self.set_tmux_apc_titles(enabled);
					continue;
				},
				Event::Sixel { supported, graphics } => {
					self.events.remove(index);
					if self.adopt_sixel(now, supported, graphics) {
						self
							.events
							.insert(index, Event::ImageProtocol { protocol: ImageProtocol::Sixel });
						index += 1;
					}
					continue;
				},
				Event::Resize => {
					self
						.screen
						.os_resize(now, self.session.size(), &mut self.device);
				},
				Event::PrivateMode { mode, supported, confirmed, status } => {
					self
						.screen
						.note_private_mode(mode, supported, confirmed, status);
				},
				Event::CellSize { width_px, height_px } => {
					self.screen.set_cell_size(width_px, height_px);
				},
				Event::InputDrained => self.parser.discard_report_head(),
				_ => {},
			}
			index += 1;
		}
		self.sync_input_context();
	}

	/// Inside tmux an APC body becomes the pane title unless the pane's APC
	/// titles are off; they are while this pane speaks TSP.
	fn set_tmux_apc_titles(&mut self, enabled: bool) {
		self.tmux_apc_titles_off = !enabled;
		tmux::set_pane_apc_titles(enabled, &self.env);
	}

	/// Whether a DA1 SIXEL attribute may select SIXEL: never over an explicit
	/// `PI_FORCE_IMAGE_PROTOCOL` choice, and inside tmux only when tmux draws
	/// SIXEL for the attached client — tmux answers DA1 for its own emulator,
	/// so only its record of the client says whether SIXEL reaches the outer
	/// terminal.
	fn da1_sixel_usable(&self) -> bool {
		!self.image_protocol_forced
			&& (!Multiplexer::Tmux.is_inside(&self.env) || tmux::client_renders_sixel(&self.env))
	}

	/// The SIXEL adoption policy for a SIXEL report (consumed here, so neither
	/// reply leaks into application input). XTSMGRAPHICS item 2 (`graphics`)
	/// reports the maximum SIXEL geometry, which settles support by itself; DA1
	/// attribute 4 only advertises it, which counts when usable (see
	/// [`da1_sixel_usable`](Self::da1_sixel_usable)) and no TSP surface owns
	/// or is expected to own the terminal (it sends images through TSP). A
	/// protocol already in effect is kept. Adopting asks the terminal for its
	/// cell size (image rows are sized by it) and forces a full repaint; returns
	/// whether SIXEL was adopted.
	fn adopt_sixel(&mut self, now: f64, supported: bool, graphics: bool) -> bool {
		let usable = graphics
			|| (self.da1_sixel_usable() && !self.surface.live() && !self.surface.tsp_expected());
		if !supported || !usable || self.screen.image_protocol().is_some() {
			return false;
		}
		self
			.session
			.set_image_protocol(Some(ImageProtocol::Sixel), &mut self.device);
		self.screen.set_image_protocol(Some(ImageProtocol::Sixel));
		self
			.screen
			.request_render(now, RenderRequest { force: true, ..RenderRequest::default() });
		true
	}

	/// Push the session's recognition context to the parser; when
	/// win32-input-mode switches off, release what its decoder held.
	fn sync_input_context(&mut self) {
		let context = self.session.input_context();
		// Release while the decoder is still on, so held input is delivered now
		// rather than parked behind the next feed or tick.
		if self.win32_input && !context.win32_input {
			self.parser.release_pending(&mut self.inputs);
		}
		self.win32_input = context.win32_input;
		self.parser.set_context(context);
	}

	/// Finish a call: bring the parser's recognition context up to date (any
	/// session call may have opened a probe whose reply it must claim), route
	/// input the parser produced, then queue the screen's host requests ahead
	/// of the first pending `render` and keep a single `render`.
	fn settle(&mut self, now: f64) {
		self.sync_input_context();
		while !self.inputs.is_empty() {
			self.route_inputs(now);
		}
		self.screen.apply_budget_render_request(now);
		let requests = self.screen.take_host_requests();
		let mut ahead = Vec::new();
		if requests.history_replay {
			ahead.push(Event::HistoryReplay);
		}
		ahead.extend(
			requests
				.frame_texts
				.into_iter()
				.map(|text| Event::FrameText { text }),
		);
		if !ahead.is_empty() {
			let at = self
				.events
				.iter()
				.position(|event| matches!(event, Event::Render))
				.unwrap_or(self.events.len());
			self.events.splice(at..at, ahead);
		}
		let mut rendered = false;
		self.events.retain(|event| {
			let duplicate = rendered && matches!(event, Event::Render);
			rendered |= matches!(event, Event::Render);
			!duplicate
		});
	}
}

impl Drop for TerminalEngine {
	fn drop(&mut self) {
		self.device.stop(0);
	}
}
