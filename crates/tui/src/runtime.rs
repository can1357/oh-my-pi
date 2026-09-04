//! Tokio host for retained terminal UIs.
//!
//! [`App`] owns capability resolution, terminal entry, input routing, animation
//! wakes, resize coalescing, and presentation:
//!
//! ```no_run
//! use std::io;
//!
//! use omp_tui::{AppOptions, Ui};
//!
//! #[tokio::main]
//! async fn main() -> io::Result<()> {
//! 	let mut app = AppOptions::new()
//! 		.start(|env| Ui::from_markup("hello", env.viewport.width, env.ctx).unwrap())
//! 		.await?;
//! 	while let Some(event) = app.next().await? {
//! 		let _ = event;
//! 	}
//! 	Ok(())
//! }
//! ```
//!
//! [`UiHandle`] queues mutations from synchronous threads or asynchronous
//! tasks. Immediate-mode hosts instead drive [`Terminal::next`] with their
//! own `tokio::select!`; `examples/chat` is the reference.

use std::{
	collections::VecDeque,
	fmt, future, io,
	time::{Duration, Instant},
};

use flume::Receiver;
use omp_core::{IntoStr, Str};
use smallvec::SmallVec;
use tokio_util::sync::CancellationToken;

use crate::{
	AltScreenUse, Appearance, Chord, CursorStyle, Graphics, InputEvent, Key, OverlayId, PaintStats,
	ProbeResults, Renderer, Size, Terminal, TerminalCaps, TerminalOptions, TerminalResponse, TtyOut,
	Ui, UiContext, UiEvent,
	component::Slot,
	components,
	components::ImgState,
	debug, detect, imagereg, negotiate_async, paste,
	paste::{Clipboard, ClipboardRead, ClipboardReadOutcome, Pasted, PastedImage},
	pump::{DebugOp, DebugQuery, TerminalEvent},
	test_support,
};

const RESIZE_SETTLE: Duration = Duration::from_millis(120);
const RESIZE_RECHECK: Duration = Duration::from_millis(25);
#[cfg(windows)]
const WINDOWS_RESIZE_POLL: Duration = Duration::from_millis(100);
/// Ceiling for one background clipboard read. Backend subprocesses cap
/// themselves at 5–8 s; this covers a hung native handle so queued input
/// can never stall indefinitely.
const CLIPBOARD_READ_TIMEOUT: Duration = Duration::from_secs(10);

pub enum Msg {
	/// App-side mutation from a [`UiHandle`], applied between frames.
	Update(Box<dyn FnOnce(&mut Ui) + Send>),
	/// A finished off-thread decode for the `Img` at `slot`.
	ImageDecoded { slot: Slot, state: ImgState },
	/// A finished background system-clipboard read, tagged with its
	/// [`ClipboardGate`] generation; `raw` requests verbatim insertion.
	Pasted { generation: u64, raw: bool, outcome: ClipboardReadOutcome },
}

/// Ordering discipline for one in-flight background clipboard read.
///
/// Keystrokes typed behind an unsettled paste queue so a trailing Enter
/// cannot submit before the payload lands. Input admitted
/// while a read is in flight is buffered and replayed in order once the read
/// settles or expires; quit chords bypass the buffer so a hung backend
/// can never lock the user in, and results from an expired read are dropped
/// by generation.
#[derive(Default)]
struct ClipboardGate {
	in_flight:  Option<InFlightRead>,
	generation: u64,
	pending:    VecDeque<InputEvent>,
}

struct InFlightRead {
	generation: u64,
	deadline:   Instant,
}

impl ClipboardGate {
	/// Claims the gate for one read, returning its generation tag; `None`
	/// while another read is still in flight.
	fn begin(&mut self, now: Instant) -> Option<u64> {
		if self.in_flight.is_some() {
			return None;
		}
		self.generation += 1;
		self.in_flight = Some(InFlightRead {
			generation: self.generation,
			deadline:   now + CLIPBOARD_READ_TIMEOUT,
		});
		Some(self.generation)
	}

	/// Admits `event` for immediate dispatch (`Some`) or queues it behind
	/// the in-flight read (`None`). Quit chords always pass through.
	fn admit(&mut self, event: InputEvent, quit: &[Key]) -> Option<InputEvent> {
		if self.in_flight.is_none() {
			return Some(event);
		}
		if let InputEvent::Key(key) = &event
			&& quit.contains(key)
		{
			return Some(event);
		}
		self.pending.push_back(event);
		None
	}

	/// Accepts a finished read when its generation is still current.
	fn settle(&mut self, generation: u64) -> bool {
		if self
			.in_flight
			.as_ref()
			.is_some_and(|read| read.generation == generation)
		{
			self.in_flight = None;
			return true;
		}
		false
	}

	/// Abandons an overdue read; its eventual result no longer settles.
	const fn expire(&mut self) {
		self.in_flight = None;
	}

	/// The in-flight read's expiry instant, when one is running.
	fn deadline(&self) -> Option<Instant> {
		self.in_flight.as_ref().map(|read| read.deadline)
	}

	/// Releases the oldest queued event once no read is in flight.
	fn drain(&mut self) -> Option<InputEvent> {
		if self.in_flight.is_some() {
			return None;
		}
		self.pending.pop_front()
	}
}

/// Off-thread image decoder used by asynchronous UI hosts.
#[derive(Clone)]
pub struct ImageLoader {
	tx: flume::Sender<Msg>,
	rx: Receiver<Msg>,
}

impl ImageLoader {
	/// Creates a loader; decodes run on the rayon global pool.
	pub fn new() -> Self {
		let (tx, rx) = flume::unbounded();
		Self { tx, rx }
	}

	pub(crate) fn request(
		&self,
		slot: Slot,
		source: Str,
		width: u16,
		rows: components::RowBound,
		trim: bool,
		prepare_kitty: bool,
	) {
		let tx = self.tx.clone();
		rayon::spawn(move || {
			if prepare_kitty {
				let _ = imagereg::prepare_png(&source);
			}
			let state = components::decode_source(&source, width, rows, trim);
			let _ = tx.send(Msg::ImageDecoded { slot, state });
		});
	}
}

impl Default for ImageLoader {
	fn default() -> Self {
		Self::new()
	}
}

impl fmt::Debug for ImageLoader {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("ImageLoader")
	}
}

/// Cloneable remote for mutating the [`Ui`] from any thread or task.
///
/// Sends are non-blocking; after the [`App`] is gone they are no-ops.
#[derive(Clone)]
pub struct UiHandle {
	tx:     flume::Sender<Msg>,
	cancel: CancellationToken,
}

impl UiHandle {
	/// Queues a UI mutation to run between rendered frames.
	pub fn update(&self, update: impl FnOnce(&mut Ui) + Send + 'static) {
		let _ = self.tx.send(Msg::Update(Box::new(update)));
	}

	/// Queues replacement text for the component named by `id`.
	pub fn set_text(&self, id: impl IntoStr, text: impl IntoStr) {
		let id = id.into_str();
		let text = text.into_str();
		self.update(move |ui| {
			ui.set_text(&id, text);
		});
	}

	/// Queues invalidation of the component named by `id`.
	pub fn invalidate(&self, id: impl IntoStr) {
		let id = id.into_str();
		self.update(move |ui| {
			ui.invalidate(&id);
		});
	}

	/// Requests shutdown of the application host.
	pub fn shutdown(&self) {
		self.cancel.cancel();
	}
}

type GraphicsOverride = Box<dyn FnOnce(&TerminalCaps) -> Option<Graphics> + Send>;

/// Configuration for [`AppOptions::start`].
///
/// Defaults to environment detection without probing, Ctrl-C to quit, and
/// base-tree [`UiEvent::Cancel`] to shut down. A cancel from inside a
/// visible modal overlay dismisses that layer instead of quitting.
pub struct AppOptions {
	probe:          Option<Duration>,
	graphics:       Option<GraphicsOverride>,
	cursor_style:   Option<CursorStyle>,
	quit:           SmallVec<Key, 4>,
	hotkeys:        SmallVec<Key, 4>,
	quit_on_cancel: bool,
	mouse:          bool,
	hold_alt:       bool,
}

impl AppOptions {
	/// Creates the default application configuration.
	pub fn new() -> Self {
		let mut quit = SmallVec::new();
		quit.push(Key::Ctrl('c'));
		Self {
			probe: None,
			graphics: None,
			cursor_style: None,
			quit,
			hotkeys: SmallVec::new(),
			quit_on_cancel: true,
			mouse: false,
			hold_alt: false,
		}
	}

	/// Runs the startup capability probe with this timeout.
	pub const fn probe(mut self, timeout: Duration) -> Self {
		self.probe = Some(timeout);
		self
	}

	/// Resolves an optional forced graphics tier after capability detection.
	pub fn graphics_with(
		mut self,
		forced: impl FnOnce(&TerminalCaps) -> Option<Graphics> + Send + 'static,
	) -> Self {
		self.graphics = Some(Box::new(forced));
		self
	}

	/// Uses `style` while the application owns the terminal.
	pub const fn cursor_style(mut self, style: CursorStyle) -> Self {
		self.cursor_style = Some(style);
		self
	}

	/// Enables inline mouse reporting (click, drag, motion, wheel) for the
	/// whole session.
	///
	/// Off by default: an inline app leaves the mouse to the terminal so
	/// native text selection and scrollback keep working, matching the
	/// coding agent. Opt in for pointer-driven screens.
	pub const fn mouse(mut self) -> Self {
		self.mouse = true;
		self
	}

	/// Replaces the quit chords checked before input routing.
	pub fn quit(mut self, chords: impl IntoIterator<Item = Key>) -> Self {
		self.quit = chords.into_iter().collect();
		self
	}

	/// Reserves chords for the host, checked after the quit chords and
	/// before widget routing, and surfaced as [`AppEvent::Key`].
	///
	/// Use this for scene-level shortcuts that must win over a focused
	/// widget's own binding — `Ctrl+K` opening a switcher while a text
	/// input would otherwise kill to end of line. Chords stay reserved
	/// until [`App::set_hotkeys`] replaces them, so scope them to the
	/// screen that needs them rather than reserving them globally.
	pub fn hotkeys(mut self, chords: impl IntoIterator<Item = Key>) -> Self {
		self.hotkeys = chords.into_iter().collect();
		self
	}

	/// Starts with the alternate screen held: the very first frame paints
	/// there, and [`App::hold_alt`] later releases it through an atomic
	/// main-screen repaint. Fullscreen opening scenes — a welcome
	/// screen, a picker-first flow — use this so the main buffer never
	/// flashes frame one. A Ui whose initial overlay stack is visible holds
	/// automatically without this option.
	pub const fn hold_alt(mut self) -> Self {
		self.hold_alt = true;
		self
	}

	/// Keeps running when the base tree yields [`UiEvent::Cancel`].
	///
	/// A cancel from inside a visible modal overlay is unaffected: it always
	/// dismisses that layer and surfaces [`AppEvent::OverlayClosed`].
	pub const fn keep_on_cancel(mut self) -> Self {
		self.quit_on_cancel = false;
		self
	}

	/// Negotiates, enters the terminal, builds the [`Ui`], paints the first
	/// frame, and returns the running host.
	///
	/// # Errors
	///
	/// Propagates terminal, input, capability, and renderer failures.
	pub async fn start(self, build: impl FnOnce(AppEnv) -> Ui + Send) -> io::Result<App> {
		let Self { probe, graphics, cursor_style, quit, hotkeys, quit_on_cancel, mouse, hold_alt } =
			self;
		let (base, probe) = match probe {
			Some(timeout) => negotiate_async(timeout).await,
			None => (detect(), ProbeResults::default()),
		};
		let forced = graphics.and_then(|forced| forced(&base));
		let caps = TerminalCaps::resolve(base, None, forced);
		let mut terminal_options = TerminalOptions::new(caps).mouse(mouse).probe_results(probe);
		if let Some(style) = cursor_style {
			terminal_options = terminal_options.cursor_style(style);
		}
		let mut terminal = Terminal::enter(terminal_options)?;
		let viewport = terminal.size()?;

		let loader = ImageLoader::new();
		let msgs = loader.rx.clone();
		let tx = loader.tx.clone();
		let mut ctx = UiContext::default().with_terminal_caps(&caps);
		ctx.loader = Some(loader);
		let mut ui = build(AppEnv { viewport, caps, ctx });

		let mut renderer = Renderer::new(TtyOut::new()?);
		renderer.apply_caps(&caps)?;

		// An initial hold — requested or from a visible overlay — paints
		// frame one on the alternate screen; the main buffer stays untouched
		// (and unseeded) until release.
		let initial_hold = hold_alt || ui.has_overlay();
		let paint_started = Instant::now();
		let last_stats = if initial_hold {
			let alt_enter = terminal.stage_alt_enter(AltScreenUse::Interactive);
			ui.repaint(&mut renderer, viewport.height, alt_enter.as_deref().unwrap_or(""))?
		} else {
			ui.present(&mut renderer, viewport.height)?
		};
		let last_frame_cost = paint_started.elapsed();
		let now = Instant::now();
		Ok(App {
			ui,
			renderer,
			msgs,
			tx,
			cancel: CancellationToken::new(),
			epoch: now,
			caps,
			viewport,
			quit,
			hotkeys,
			quit_on_cancel,
			#[cfg(unix)]
			resize_wait: None,
			#[cfg(windows)]
			resize_wait: Some(now + WINDOWS_RESIZE_POLL),
			resize_settle: None,
			alt_hold: initial_hold,
			hold_request: hold_alt,
			clipboard: ClipboardGate::default(),
			last_stats,
			last_frame_cost,
			animation_not_before: None,
			terminal,
		})
	}
}

impl Default for AppOptions {
	fn default() -> Self {
		Self::new()
	}
}

/// Inputs supplied to the [`AppOptions::start`] UI builder.
pub struct AppEnv {
	/// Initial terminal cell dimensions.
	pub viewport: Size,
	/// Resolved terminal capabilities.
	pub caps:     TerminalCaps,
	/// Capability-aware context with asynchronous image loading installed.
	pub ctx:      UiContext,
}

/// Returns whether a chord is reserved by core terminal, clipboard, or input
/// handling and therefore unavailable to extension shortcut declarations.
pub const fn is_core_chord(chord: Chord) -> bool {
	matches!(
		chord.key,
		Key::Esc
			| Key::Backspace
			| Key::Delete
			| Key::Paste
			| Key::PasteRaw
			| Key::Copy
			| Key::Cut
			| Key::Ctrl('c' | 'v')
	)
}

/// Host-level event returned by [`App::next`].
///
/// Input has already been routed into the retained tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppEvent {
	/// Routed input changed the tree; the next [`App::next`] call presents it.
	Updated,
	/// A key no component claimed: it routed through the tree untouched —
	/// pending damage from animations or other components never masks it —
	/// and matched no quit or clipboard chord. Hosts use it for scene-level
	/// hotkeys without intercepting the widget path.
	Key(Key),
	/// The focused widget submitted.
	Submitted,
	/// An ID-carrying button fired.
	Pressed(Str),
	/// A resize settled after [`Ui::resize`] ran.
	Resized(Size),
	/// The terminal background flipped between dark and light. The retained
	/// context has already been restyled; hardcoded colors derived outside
	/// the theme are the app's to refresh.
	Appearance(Appearance),
	/// A cancel from inside a layer dismissed the topmost visible overlay.
	OverlayClosed(OverlayId),
	/// An ID-carrying select's cursor rested on a new option.
	Highlighted {
		/// The select's `id`.
		id:    Str,
		/// Value of the option under the cursor.
		value: Str,
	},
	/// An ID-carrying select committed an option.
	Changed {
		/// The select's `id`.
		id:    Str,
		/// Value of the committed option.
		value: Str,
	},
	/// A tree node was activated.
	TreeActivated {
		/// The tree's `id`, or the empty string when unnamed.
		id:  Str,
		/// Stable node key.
		key: Str,
	},
	/// A tree node was toggled.
	TreeToggled {
		/// The tree's `id`, or the empty string when unnamed.
		id:       Str,
		/// Stable node key.
		key:      Str,
		/// New branch expansion state, or `None` for an application leaf toggle.
		expanded: Option<bool>,
	},
	/// A tree node's trailing action chip was activated.
	TreeAction {
		/// The tree's `id`, or the empty string when unnamed.
		id:     Str,
		/// Stable node key.
		key:    Str,
		/// Action value authored on the node.
		action: Str,
	},
	/// An interactive diff pane requested a host-owned mutation.
	DiffAction {
		/// The pane's component `id`.
		id:     Str,
		/// Requested mutation.
		action: crate::DiffActionKind,
		/// Selection, hunk, or file scope.
		target: crate::DiffTarget,
	},
	/// An ID-carrying filterable select's query changed.
	Filtered {
		/// The select's `id`.
		id:    Str,
		/// The new filter query.
		query: Str,
		/// Value of the option under the cursor after re-filtering.
		value: Option<Str>,
	},
}

/// Running retained-UI terminal host.
pub struct App {
	ui:                   Ui,
	renderer:             Renderer<TtyOut>,
	msgs:                 Receiver<Msg>,
	tx:                   flume::Sender<Msg>,
	cancel:               CancellationToken,
	epoch:                Instant,
	caps:                 TerminalCaps,
	viewport:             Size,
	quit:                 SmallVec<Key, 4>,
	hotkeys:              SmallVec<Key, 4>,
	quit_on_cancel:       bool,
	resize_wait:          Option<Instant>,
	resize_settle:        Option<Instant>,
	alt_hold:             bool,
	hold_request:         bool,
	clipboard:            ClipboardGate,
	last_stats:           PaintStats,
	last_frame_cost:      Duration,
	animation_not_before: Option<Instant>,
	terminal:             Terminal,
}

impl App {
	/// Borrows the retained UI.
	pub const fn ui(&self) -> &Ui {
		&self.ui
	}

	/// Mutably borrows the retained UI between host events.
	pub const fn ui_mut(&mut self) -> &mut Ui {
		&mut self.ui
	}

	/// Replaces the reserved host chords, scoping [`AppOptions::hotkeys`]
	/// to the screen that is actually showing.
	pub fn set_hotkeys(&mut self, chords: impl IntoIterator<Item = Key>) {
		self.hotkeys = chords.into_iter().collect();
	}

	/// Creates a remote that can update or stop this host.
	pub fn handle(&self) -> UiHandle {
		UiHandle { tx: self.tx.clone(), cancel: self.cancel.clone() }
	}

	/// Mutably borrows the renderer for image registration and output policy.
	pub const fn renderer_mut(&mut self) -> &mut Renderer<TtyOut> {
		&mut self.renderer
	}

	/// Mutably borrows the terminal for titles, progress, and appearance hooks.
	pub const fn terminal_mut(&mut self) -> &mut Terminal {
		&mut self.terminal
	}

	/// Returns the resolved terminal capabilities.
	pub const fn caps(&self) -> TerminalCaps {
		self.caps
	}

	/// Returns the latest settled terminal geometry.
	pub const fn viewport(&self) -> Size {
		self.viewport
	}

	/// Returns statistics from the most recent viewport paint.
	pub const fn last_stats(&self) -> PaintStats {
		self.last_stats
	}

	/// Returns the compose-and-write cost of the most recent completed frame.
	pub const fn last_frame_cost(&self) -> Duration {
		self.last_frame_cost
	}

	/// Requests or releases a persistent alternate-screen hold.
	///
	/// Fullscreen scenes — a welcome screen, a pager — hold the alternate
	/// screen for their lifetime: frames paint there with mouse tracking
	/// active. Every visible modal overlay holds it automatically; this covers
	/// scenes without one. Non-modal layers
	/// ([`crate::OverlayOptions::non_modal`]) composite into the live viewport.
	/// Enter and leave each repaint that viewport atomically with the staged
	/// terminal sequence. Takes effect on the next [`App::next`] call.
	pub const fn hold_alt(&mut self, hold: bool) {
		self.hold_request = hold;
	}

	/// Flushes pending damage, waits for one host event, and routes it.
	///
	/// `None` means shutdown; subsequent calls continue returning `None`.
	///
	/// # Errors
	///
	/// Propagates terminal input, geometry, and renderer failures.
	#[expect(
		clippy::future_not_send,
		reason = "terminal UI components are intentionally confined to their owning thread"
	)]
	pub async fn next(&mut self) -> io::Result<Option<AppEvent>> {
		let mut animation_paint = false;
		loop {
			if self.cancel.is_cancelled() {
				return Ok(None);
			}

			// Alternate-screen transitions and ordinary paints all render the
			// same fixed viewport. Only the staged enter/leave prefix differs.
			let want_hold = self.hold_request || self.ui.has_overlay();
			let painted = if want_hold != self.alt_hold {
				let prefix = if want_hold {
					self
						.terminal
						.stage_alt_enter(AltScreenUse::Interactive)
						.unwrap_or_default()
				} else {
					Str::new(self.terminal.stage_alt_leave().unwrap_or(""))
				};
				self.paint(Some(&prefix))?;
				if !want_hold {
					self.terminal.commit_alt_leave();
				}
				self.alt_hold = want_hold;
				true
			} else if self.ui.has_damage() {
				self.paint(None)?;
				true
			} else {
				false
			};
			if animation_paint {
				if painted {
					self.animation_not_before = Some(
						Instant::now()
							+ components::Spinner::animation_backpressure(self.last_frame_cost),
					);
				}
				animation_paint = false;
			}

			// Replay input queued behind a clipboard read — oldest first, one
			// event per host turn, before polling for anything new.
			if let Some(event) = self.clipboard.drain() {
				match self.dispatch_input(event) {
					// `dispatch_input` already resolved `Unclaimed` fallbacks.
					Routed::Continue | Routed::Unclaimed => continue,
					Routed::Copy(text) => {
						let _ = self.terminal.copy_to_clipboard(&text)?;
						continue;
					},
					Routed::Event(event) => return Ok(Some(event)),
					Routed::Stop => return Ok(None),
				}
			}

			let wake = self.ui.next_wake().map(|at| {
				let scheduled = self.epoch + at;
				self
					.animation_not_before
					.map_or(scheduled, |not_before| scheduled.max(not_before))
			});
			let wakeup = tokio::select! {
				() = self.cancel.cancelled() => Wakeup::Cancelled,
				message = self.msgs.recv_async() => Wakeup::Message(message),
				event = self.terminal.next() => Wakeup::Event(event),
				() = deadline(wake) => Wakeup::Animation,
				() = deadline(self.clipboard.deadline()) => Wakeup::ClipboardExpired,
				() = deadline(self.resize_wait) => Wakeup::ResizeCheck,
				() = deadline(self.resize_settle) => Wakeup::ResizeSettle,
			};

			match wakeup {
				Wakeup::Cancelled => return Ok(None),
				Wakeup::Message(Ok(Msg::Update(update))) => update(&mut self.ui),
				Wakeup::Message(Ok(Msg::ImageDecoded { slot, state })) => {
					self.ui.deliver_image(slot, state);
				},
				Wakeup::Message(Ok(Msg::Pasted { generation, raw, outcome })) => {
					// A result from an expired or superseded read is dropped;
					// its queued input already replayed without it.
					if self.clipboard.settle(generation)
						&& let ClipboardReadOutcome::Payload(clipboard) = outcome
						&& let Some(event) = self.deliver_clipboard(clipboard, raw)
					{
						return Ok(Some(event));
					}
				},
				Wakeup::Message(Err(_)) => {},
				Wakeup::Event(event) => match event? {
					TerminalEvent::Resize => {
						self.resize_wait = Some(Instant::now());
					},
					TerminalEvent::Debug(query) => self.answer_debug(query),
					TerminalEvent::Effect(_) => {},
					// `Terminal::next` reports closure as an error.
					TerminalEvent::Closed => return Ok(None),
					TerminalEvent::Input(event) | TerminalEvent::InputWithMeta { event, .. } => {
						let in_band_resize =
							matches!(&event, InputEvent::Response(TerminalResponse::InBandResize { .. }));
						if self
							.terminal
							.handle_input_event(&event, &mut self.renderer)?
						{
							if in_band_resize {
								self.resize_wait = Some(Instant::now());
							}
							if let Some(event) = self.sync_appearance() {
								return Ok(Some(event));
							}
							if let Some(pasted) = self.terminal.take_paste()
								&& let Some(event) = self.deliver_pasted(pasted)
							{
								return Ok(Some(event));
							}
							continue;
						}
						if let Some(event) = self.clipboard.admit(event, &self.quit) {
							match self.dispatch_input(event) {
								// `dispatch_input` already resolved `Unclaimed` fallbacks.
								Routed::Continue | Routed::Unclaimed => {},
								Routed::Copy(text) => {
									let _ = self.terminal.copy_to_clipboard(&text)?;
								},
								Routed::Event(event) => return Ok(Some(event)),
								Routed::Stop => return Ok(None),
							}
						}
					},
				},
				Wakeup::Animation => {
					animation_paint = self.ui.tick(self.epoch.elapsed());
				},
				Wakeup::ClipboardExpired => self.clipboard.expire(),
				Wakeup::ResizeCheck => {
					self.resize_wait = None;
					let now = Instant::now();
					let consumed = match self.terminal.take_resize()? {
						// A same-size report outside a drag is an echo. During
						// an active resize burst it refreshes the settle deadline.
						Some(viewport) if viewport != self.viewport || self.resize_settle.is_some() => {
							self.begin_resize(viewport, now)?;
							true
						},
						// A consumed echo still ends the recheck loop below.
						Some(_) => true,
						None => false,
					};
					#[cfg(unix)]
					if !consumed {
						// A multiplexer burst is still inside its debounce
						// window; keep polling until geometry is released.
						self.resize_wait = Some(now + RESIZE_RECHECK);
					}
					#[cfg(windows)]
					{
						let _ = consumed;
						self.resize_wait = Some(now + WINDOWS_RESIZE_POLL);
					}
				},
				Wakeup::ResizeSettle => {
					self.resize_settle = None;
					return Ok(Some(AppEvent::Resized(self.viewport)));
				},
			}
		}
	}

	/// Applies a terminal-reported dark/light flip to the retained context.
	///
	/// A stock palette follows the flip; a custom theme is preserved so the
	/// app can restyle it in response to [`AppEvent::Appearance`].
	fn sync_appearance(&mut self) -> Option<AppEvent> {
		let appearance = self.terminal.appearance()?;
		let current = self.ui.context();
		if current.appearance == appearance {
			return None;
		}
		let mut ctx = current.clone();
		ctx.apply_appearance(appearance);
		self.ui.set_context(ctx);
		Some(AppEvent::Appearance(appearance))
	}

	/// Routes paste text into the focused component, mapping the outcome
	/// like terminal-delivered bracketed paste. `raw` requests verbatim
	/// insertion ([`Ui::handle_paste_raw`]).
	fn route_paste(&mut self, text: &str, raw: bool) -> Option<AppEvent> {
		let event = if raw {
			self.ui.handle_paste_raw(text)
		} else {
			self.ui.handle_paste(text)
		};
		match select_event(event) {
			Ok(event) => Some(event),
			Err(_) if self.ui.has_damage() => Some(AppEvent::Updated),
			Err(_) => None,
		}
	}

	/// Persists a pasted image to a temp file and routes its path like a
	/// file drop, which [`crate::components::EditInput`] stages as an
	/// attachment chip.
	fn route_image(&mut self, image: &PastedImage) -> Option<AppEvent> {
		let path = image.persist().ok()?;
		self.route_paste(path.to_str()?, false)
	}

	/// Dispatches a completed OSC 5522 enhanced-paste payload.
	fn deliver_pasted(&mut self, pasted: Pasted) -> Option<AppEvent> {
		match pasted {
			Pasted::Text(text) => self.route_paste(&text, false),
			Pasted::Image(image) => self.route_image(&image),
		}
	}

	/// Dispatches a finished background clipboard read. `raw` preserves the
	/// Ctrl+Shift+V contract end to end: text inserts verbatim instead of
	/// collapsing to chips or classifying as a drop.
	fn deliver_clipboard(&mut self, clipboard: Clipboard, raw: bool) -> Option<AppEvent> {
		match clipboard {
			Clipboard::Text(text) => self.route_paste(&text, raw),
			Clipboard::Image(image) => self.route_image(&image),
			Clipboard::Paths(paths) => {
				// Quoted so paths containing spaces survive the editor's
				// drop classification intact.
				let mut joined = String::new();
				for path in &paths {
					if !joined.is_empty() {
						joined.push(' ');
					}
					joined.push('"');
					joined.push_str(path);
					joined.push('"');
				}
				self.route_paste(&joined, false)
			},
		}
	}

	fn route_key(&mut self, key: Key) -> Routed {
		let routed =
			route_key_event(&mut self.ui, key, &self.quit, &self.hotkeys, self.quit_on_cancel);
		if matches!(routed, Routed::Stop) {
			self.cancel.cancel();
		}
		routed
	}

	/// Starts one background system-clipboard read; the result returns
	/// through the message bus as [`Msg::Pasted`] tagged with the gate
	/// generation. [`ClipboardRead::Text`] carries the Ctrl+Shift+V
	/// contract through as `raw`: verbatim insertion of a text-only read.
	///
	/// The read rides [`crate::paste::spawn_clipboard_read`]'s detached
	/// thread; a result arriving after the gate expired is dropped by
	/// generation. A channel closed without a value (the reader thread
	/// never spawned) becomes [`ClipboardReadOutcome::ReadFailure`] and
	/// settles the gate immediately so queued input is not held until the
	/// deadline.
	fn begin_clipboard_read(&mut self, scope: ClipboardRead) {
		let Some(generation) = self.clipboard.begin(Instant::now()) else {
			return;
		};
		let rx = paste::spawn_clipboard_read(scope);
		let raw = scope == ClipboardRead::Text;
		let tx = self.tx.clone();
		tokio::spawn(async move {
			let outcome = rx.await.unwrap_or(ClipboardReadOutcome::ReadFailure);
			let _ = tx.send(Msg::Pasted { generation, raw, outcome });
		});
	}

	/// Routes one decoded input event into the retained tree, mapping the
	/// outcome exactly like the inline dispatch it replaced.
	fn paint(&mut self, prefix: Option<&str>) -> io::Result<()> {
		let started = Instant::now();
		let result = match prefix {
			Some(prefix) => self
				.ui
				.repaint(&mut self.renderer, self.viewport.height, prefix),
			None => self.ui.present(&mut self.renderer, self.viewport.height),
		};
		self.last_frame_cost = started.elapsed();
		self.last_stats = result?;
		Ok(())
	}

	fn dispatch_input(&mut self, event: InputEvent) -> Routed {
		// Input lands on the real clock: transitions started by this event
		// must not begin on a stale animation tick.
		self.ui.tick(self.epoch.elapsed());
		match event {
			InputEvent::Key(key) => match self.route_key(key) {
				// A key nobody claimed falls back to the host: unclaimed
				// paste chords start a clipboard read, everything else
				// surfaces as [`AppEvent::Key`].
				Routed::Unclaimed => {
					if let Some(scope) = ClipboardRead::for_key(key) {
						self.begin_clipboard_read(scope);
						Routed::Continue
					} else {
						Routed::Event(AppEvent::Key(key))
					}
				},
				routed => routed,
			},
			InputEvent::Chord(event) => {
				if event.pressed
					&& let Some(key) = event.key
				{
					self.route_key(key)
				} else {
					Routed::Continue
				}
			},
			InputEvent::Mouse(report) => {
				let event =
					self
						.ui
						.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
				match select_event(event) {
					Ok(event) => Routed::Event(event),
					Err(UiEvent::Submit) => Routed::Event(AppEvent::Submitted),
					Err(UiEvent::Pressed(id)) => Routed::Event(AppEvent::Pressed(id)),
					Err(UiEvent::TreeActivated { id, key }) => {
						Routed::Event(AppEvent::TreeActivated { id, key })
					},
					Err(UiEvent::TreeToggled { id, key, expanded }) => {
						Routed::Event(AppEvent::TreeToggled { id, key, expanded })
					},
					Err(UiEvent::TreeAction { id, key, action }) => {
						Routed::Event(AppEvent::TreeAction { id, key, action })
					},
					Err(UiEvent::DiffAction { id, action, target }) => {
						Routed::Event(AppEvent::DiffAction { id, action, target })
					},
					Err(_) if self.ui.has_damage() => Routed::Event(AppEvent::Updated),
					Err(_) => Routed::Continue,
				}
			},
			InputEvent::Paste(text) => {
				// An empty bracketed paste is how some terminals announce an
				// image-only pasteboard (macOS Cmd+V); answer it with a
				// clipboard read instead.
				if text.is_empty() {
					self.begin_clipboard_read(ClipboardRead::Smart);
					Routed::Continue
				} else {
					self
						.route_paste(&text, false)
						.map_or(Routed::Continue, Routed::Event)
				}
			},
			InputEvent::Focus(_) | InputEvent::Response(_) => Routed::Continue,
		}
	}

	/// Applies new terminal geometry: relayout, full viewport paint, settle
	/// timer.
	///
	/// Shared by the SIGWINCH-driven recheck and the `OMP_TUI_DEBUG` `resize`
	/// op, which bypasses [`Terminal::take_resize`] because no resize signal
	/// reaches an `OMP_TTY` override device.
	fn begin_resize(&mut self, viewport: Size, now: Instant) -> io::Result<()> {
		self.viewport = viewport;
		self.ui.resize(viewport.width);
		self.ui.damage_all();
		self.paint(None)?;
		self.resize_settle = Some(now + RESIZE_SETTLE);
		Ok(())
	}

	/// Answers one retained-state debug query routed through the event
	/// loop, keyed by the query id.
	fn answer_debug(&self, query: DebugQuery) {
		use serde_json::json;
		let response = match query.op {
			DebugOp::Frame => {
				let frame = self.ui.frame();
				let lines: Vec<String> = (0..frame.size().height)
					.map(|row| test_support::frame_row_text(frame, row))
					.collect();
				json!({ "ok": true, "lines": lines })
			},
			DebugOp::Tree => json!({ "ok": true, "tree": self.ui.debug_tree() }),
			DebugOp::Values => json!({ "ok": true, "values": self.ui.values() }),
			DebugOp::Slots => json!({
				"ok": false,
				"error": "slots are owned by the chat scene; retained App has no slot registry",
			}),
			// Terminal-owned ops are answered inside `Terminal::next` and
			// never surface here.
			DebugOp::Info | DebugOp::Text | DebugOp::Resize | DebugOp::Quit => return,
		};
		debug::respond_debug_query(query.id, response);
	}
}

impl Drop for App {
	fn drop(&mut self) {
		// Renderer layer state is surface-local and must not survive teardown:
		// release any alternate-screen hold, then clear composited bands.
		// Best effort — teardown cannot fail.
		let _ = self.terminal.leave_alt();
		let _ = self.renderer.clear_layers();
	}
}

/// Applies the host key policy after `key` routes into the retained tree.
///
/// Any [`UiEvent::Cancel`] surfacing from a visible modal overlay — Escape
/// or a `<button cancel>` — dismisses that layer before the quit policy runs,
/// following the layered-dismissal contract on [`Key::Esc`].
fn route_key_event(
	ui: &mut Ui,
	key: Key,
	quit: &[Key],
	hotkeys: &[Key],
	quit_on_cancel: bool,
) -> Routed {
	if quit.contains(&key) {
		return Routed::Stop;
	}
	// Reserved before routing: a focused widget must not shadow a scene
	// shortcut the host claimed.
	if hotkeys.contains(&key) {
		return Routed::Event(AppEvent::Key(key));
	}
	let (event, claimed) = ui.handle_key_claimed(key);
	match event {
		UiEvent::Cancel if ui.has_overlay() => {
			let id = ui
				.close_active_overlay()
				.expect("a visible modal overlay routed this key");
			Routed::Event(AppEvent::OverlayClosed(id))
		},
		UiEvent::Cancel if quit_on_cancel => Routed::Stop,
		UiEvent::Submit => Routed::Event(AppEvent::Submitted),
		UiEvent::Pressed(id) => Routed::Event(AppEvent::Pressed(id)),
		UiEvent::TreeActivated { id, key } => Routed::Event(AppEvent::TreeActivated { id, key }),
		UiEvent::TreeToggled { id, key, expanded } => {
			Routed::Event(AppEvent::TreeToggled { id, key, expanded })
		},
		UiEvent::TreeAction { id, key, action } => {
			Routed::Event(AppEvent::TreeAction { id, key, action })
		},
		event
		@ (UiEvent::Highlighted { .. } | UiEvent::Changed { .. } | UiEvent::Filtered { .. }) => {
			Routed::Event(select_event(event).expect("select events map to app events"))
		},
		UiEvent::DiffAction { id, action, target } => {
			Routed::Event(AppEvent::DiffAction { id, action, target })
		},
		UiEvent::Copied(text) => Routed::Copy(text),
		// The claim bit, not global damage, decides whether the key falls
		// through: animation ticks leave damage pending on every frame and
		// must not swallow the host's scene keys.
		UiEvent::None | UiEvent::Cancel if !claimed => Routed::Unclaimed,
		UiEvent::None | UiEvent::Cancel if ui.has_damage() => Routed::Event(AppEvent::Updated),
		UiEvent::None | UiEvent::Cancel => Routed::Continue,
	}
}

/// Maps a select-originated [`UiEvent`] to its [`AppEvent`]; other events
/// come back unchanged for the caller's own routing.
fn select_event(event: UiEvent) -> Result<AppEvent, UiEvent> {
	match event {
		UiEvent::Highlighted { id, value } => Ok(AppEvent::Highlighted { id, value }),
		UiEvent::Changed { id, value } => Ok(AppEvent::Changed { id, value }),
		UiEvent::Filtered { id, query, value } => Ok(AppEvent::Filtered { id, query, value }),
		other => Err(other),
	}
}

#[derive(Debug, Eq, PartialEq)]
enum Routed {
	/// The tree consumed the input; nothing to surface.
	Continue,
	/// No component claimed the key; [`App::dispatch_input`] resolves the
	/// host fallback (clipboard chord or [`AppEvent::Key`]).
	Unclaimed,
	/// Surface this event to the host.
	Event(AppEvent),
	/// An editing widget copied text; the app writes it through
	/// [`Terminal::copy_to_clipboard`] (OSC 52 + detached native fallback).
	Copy(Str),
	/// A quit chord (or quit-policy cancel) ends the app.
	Stop,
}

enum Wakeup {
	Cancelled,
	Message(Result<Msg, flume::RecvError>),
	Event(io::Result<TerminalEvent>),
	Animation,
	ClipboardExpired,
	ResizeCheck,
	ResizeSettle,
}

/// Sleeps until `at`; `None` is a disabled select branch.
async fn deadline(at: Option<Instant>) {
	match at {
		Some(at) => tokio::time::sleep_until(at.into()).await,
		None => future::pending().await,
	}
}

#[cfg(test)]
mod tests {
	use std::{
		env, fs, io, process, thread,
		time::{Duration, Instant},
	};

	#[cfg(unix)]
	use crate::tty::TTY_OVERRIDE;

	/// Flag routing the re-executed test binary into the PTY helper below.
	#[cfg(unix)]
	const HOLD_HELPER_FLAG: &str = "OMP_TUI_TEST_HOLD_HELPER";

	/// Ctrl+V followed immediately by Enter must not submit before the
	/// clipboard payload lands: input admitted behind the in-flight read
	/// queues and replays in order only after the read settles.
	#[test]
	fn clipboard_gate_orders_input_behind_the_read() {
		use super::{CLIPBOARD_READ_TIMEOUT, ClipboardGate};
		use crate::{InputEvent, Key};

		let mut gate = ClipboardGate::default();
		let now = Instant::now();
		let generation = gate.begin(now).expect("gate idle");
		assert_eq!(gate.begin(now), None, "one read at a time");
		let quit = [Key::Ctrl('c')];
		assert_eq!(gate.admit(InputEvent::Key(Key::Enter), &quit), None, "Enter queues");
		assert_eq!(gate.admit(InputEvent::Key(Key::Char('x')), &quit), None);
		// Quit chords bypass the queue so a hung read cannot trap the user.
		assert_eq!(
			gate.admit(InputEvent::Key(Key::Ctrl('c')), &quit),
			Some(InputEvent::Key(Key::Ctrl('c')))
		);
		assert_eq!(gate.drain(), None, "queue holds while the read runs");
		assert_eq!(gate.deadline(), Some(now + CLIPBOARD_READ_TIMEOUT));
		assert!(gate.settle(generation));
		assert_eq!(gate.drain(), Some(InputEvent::Key(Key::Enter)));
		assert_eq!(gate.drain(), Some(InputEvent::Key(Key::Char('x'))));
		assert_eq!(gate.drain(), None);
		assert_eq!(gate.deadline(), None);
	}

	/// An overdue read releases its queue, and its late result is dropped
	/// by generation — even after a newer read begins.
	#[test]
	fn clipboard_gate_drops_expired_and_superseded_results() {
		use super::ClipboardGate;
		use crate::{InputEvent, Key};

		let mut gate = ClipboardGate::default();
		let now = Instant::now();
		let first = gate.begin(now).expect("gate idle");
		assert_eq!(gate.admit(InputEvent::Key(Key::Enter), &[]), None);
		gate.expire();
		assert_eq!(gate.drain(), Some(InputEvent::Key(Key::Enter)), "expiry releases queued input");
		let second = gate.begin(now).expect("gate idle again");
		assert!(!gate.settle(first), "stale result is dropped");
		assert!(gate.settle(second));
	}

	/// Child half of `hold_alt_start_holds_without_overlay_and_releases`:
	/// a no-op unless re-executed with [`HOLD_HELPER_FLAG`], so terminal
	/// globals and the `OMP_TTY` override live in a dedicated process.
	#[cfg(unix)]
	#[test]
	fn hold_alt_pty_helper() {
		use super::AppOptions;
		use crate::Ui;

		if env::var_os(HOLD_HELPER_FLAG).is_none() {
			return;
		}
		tokio::runtime::Builder::new_multi_thread()
			.enable_all()
			.build()
			.expect("helper runtime builds")
			.block_on(async {
				let mut app = AppOptions::new()
					.hold_alt()
					.start(|env| {
						Ui::from_markup("<text>inline</text>", env.viewport.width, env.ctx).unwrap()
					})
					.await
					.expect("helper app starts on the override device");
				tokio::time::sleep(Duration::from_millis(250)).await;
				app.hold_alt(false);
				let _ = tokio::time::timeout(Duration::from_millis(200), app.next()).await;
				drop(app);
			});
	}

	/// An `AppOptions::hold_alt()` start with no overlay paints frame one on
	/// the alternate screen and `App::hold_alt(false)` releases it cleanly.
	/// Runs the scenario in a re-executed child process: `OMP_TTY` and the
	/// terminal's process-wide state never leak into this parallel harness.
	#[cfg(unix)]
	#[test]
	fn hold_alt_start_holds_without_overlay_and_releases() {
		use std::io::Read as _;

		use nix::fcntl::{FcntlArg, OFlag};

		let winsize = nix::pty::Winsize { ws_row: 12, ws_col: 40, ws_xpixel: 0, ws_ypixel: 0 };
		let pty = nix::pty::openpty(Some(&winsize), None).expect("openpty succeeds");
		let device = nix::unistd::ttyname(&pty.slave).expect("the pty slave has a device path");
		let mut master = fs::File::from(pty.master);
		nix::fcntl::fcntl(&master, FcntlArg::F_SETFL(OFlag::O_NONBLOCK))
			.expect("master goes nonblocking");

		let exe = env::current_exe().expect("test binary path");
		let mut child = process::Command::new(exe)
			.args(["runtime::tests::hold_alt_pty_helper", "--exact", "--test-threads=1"])
			.env(HOLD_HELPER_FLAG, "1")
			.env(TTY_OVERRIDE, &device)
			.stdout(process::Stdio::null())
			.stderr(process::Stdio::null())
			.spawn()
			.expect("helper process spawns");

		let mut stream = Vec::new();
		let mut buffer = [0_u8; 4096];
		let deadline = Instant::now() + Duration::from_secs(20);
		loop {
			match master.read(&mut buffer) {
				Ok(0) => break,
				Ok(read) => stream.extend_from_slice(&buffer[..read]),
				Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
					if let Some(status) = child.try_wait().expect("helper status readable") {
						assert!(status.success(), "helper scenario passes");
						// One final drain after exit.
						while let Ok(read) = master.read(&mut buffer) {
							if read == 0 {
								break;
							}
							stream.extend_from_slice(&buffer[..read]);
						}
						break;
					}
					assert!(Instant::now() < deadline, "helper finishes in time");
					thread::sleep(Duration::from_millis(20));
				},
				Err(_) => break,
			}
		}
		drop(child.kill());

		let position = |needle: &[u8]| {
			stream
				.windows(needle.len())
				.position(|window| window == needle)
		};
		let entry = position(b"\x1b[?1049h").expect("frame one stages the alternate screen");
		let content = position(b"inline").expect("frame one paints the tree");
		assert!(entry < content, "the buffer switch precedes the first paint");
		let exit = position(b"\x1b[?1049l").expect("hold_alt(false) restores the main screen");
		assert!(content < exit, "release follows the held frames");
		assert!(
			position(b"\x1b[3J").is_none(),
			"an alt-first start and clean release never touch main history"
		);
	}

	#[test]
	fn overlay_submit_input_surfaces_submitted_app_event_without_editing() {
		use super::{AppEvent, Routed, route_key_event};
		use crate::{Key, OverlayOptions, Prop, components::Input};

		let mut ui = Ui::from_markup("<text>base</text>", 40, UiContext::default()).unwrap();
		let overlay = ui.show_overlay(
			Input::new()
				.with(Prop::Id, "token")
				.with(Prop::Value, "sk-live")
				.with(Prop::Submit, true),
			OverlayOptions::default(),
		);

		assert_eq!(
			route_key_event(&mut ui, Key::Enter, &[], &[], true),
			Routed::Event(AppEvent::Submitted),
		);
		assert_eq!(
			ui.overlay(overlay).expect("input overlay").values()["token"],
			"sk-live",
			"submitting preserves the value and inserts no newline"
		);
	}

	#[test]
	fn overlay_cancel_dismisses_the_visible_layer_before_quit_policy() {
		use super::{AppEvent, Routed, route_key_event};
		use crate::{Key, OverlayOptions, dom};

		let mut ui = Ui::from_markup("<input id=base/>", 40, UiContext::default()).unwrap();
		let lower = ui.show_overlay(dom! { <text>{"lower"}</text> }, OverlayOptions::default());
		let upper = ui.show_overlay(dom! { <text>{"upper"}</text> }, OverlayOptions::default());
		assert!(ui.set_overlay_hidden(upper, true));

		// A quit chord outranks any open layer.
		let quit = [Key::Ctrl('c')];
		assert_eq!(route_key_event(&mut ui, Key::Ctrl('c'), &quit, &[], true), Routed::Stop);

		// Escape targets the visible layer, not the hidden stack top.
		assert_eq!(
			route_key_event(&mut ui, Key::Esc, &quit, &[], true),
			Routed::Event(AppEvent::OverlayClosed(lower)),
		);
		assert!(ui.overlay(lower).is_none(), "the dismissed layer is gone");
		assert!(ui.overlay(upper).is_some(), "the hidden layer is untouched");

		// Every remaining layer is hidden, so Escape falls back to the policy.
		assert_eq!(route_key_event(&mut ui, Key::Esc, &quit, &[], true), Routed::Stop);
		assert_eq!(
			route_key_event(&mut ui, Key::Esc, &quit, &[], false),
			Routed::Unclaimed,
			"a swallowed cancel falls back to the host as an unclaimed key",
		);

		// A `<button cancel>` inside a dialog dismisses the dialog, never the
		// application, regardless of the quit policy.
		let dialog =
			ui.show_overlay(dom! { <button cancel>{"Cancel"}</button> }, OverlayOptions::default());
		assert_eq!(
			route_key_event(&mut ui, Key::Enter, &quit, &[], true),
			Routed::Event(AppEvent::OverlayClosed(dialog)),
		);
		assert!(ui.overlay(dialog).is_none());
	}

	/// `Ctrl+K` is an input's kill-to-end-of-line; a host that reserves it
	/// for a scene shortcut must win, or the chord dies at the focused
	/// widget.
	#[test]
	fn a_reserved_hotkey_outranks_the_focused_widgets_own_binding() {
		use super::{AppEvent, Routed, route_key_event};
		use crate::Key;

		let mut ui =
			Ui::from_markup("<input id=composer value=hello/>", 40, UiContext::default()).unwrap();
		ui.handle_key(Key::Home);
		let quit = [Key::Ctrl('c')];

		assert_eq!(
			route_key_event(&mut ui, Key::Ctrl('k'), &quit, &[Key::Ctrl('k')], true),
			Routed::Event(AppEvent::Key(Key::Ctrl('k'))),
		);
		assert_eq!(ui.values()["composer"], "hello", "the input never saw the reserved chord");

		// Unreserved, the same chord stays the input's kill-line.
		assert_eq!(
			route_key_event(&mut ui, Key::Ctrl('k'), &quit, &[], true),
			Routed::Event(AppEvent::Changed { id: "composer".into(), value: "".into() })
		);
		assert_eq!(ui.values()["composer"], "");
	}

	/// Animation ticks leave damage pending on every frame; a scene key no
	/// widget claimed must still reach the host instead of dissolving into
	/// [`AppEvent::Updated`].
	#[test]
	fn an_unclaimed_key_surfaces_despite_pending_damage() {
		use super::{Routed, route_key_event};
		use crate::Key;

		let mut ui =
			Ui::from_markup("<text id=status>idle</text>", 40, UiContext::default()).unwrap();
		ui.set_text("status", "running");
		assert!(ui.has_damage(), "the text write left damage pending");

		let quit = [Key::Ctrl('c')];
		assert_eq!(route_key_event(&mut ui, Key::Char('m'), &quit, &[], true), Routed::Unclaimed);
	}

	#[test]
	fn cancel_with_only_a_non_modal_layer_follows_the_quit_policy() {
		use super::{Routed, route_key_event};
		use crate::{Key, OverlayOptions, dom};

		let mut ui = Ui::from_markup("<input id=base/>", 40, UiContext::default()).unwrap();
		let rail =
			ui.show_overlay(dom! { <text>{"rail"}</text> }, OverlayOptions::default().non_modal());
		let quit = [Key::Ctrl('c')];
		assert_eq!(
			route_key_event(&mut ui, Key::Esc, &quit, &[], true),
			Routed::Stop,
			"a non-modal layer never soaks up the cancel",
		);
		assert!(ui.overlay(rail).is_some(), "the rail is not dismissed");
	}

	#[test]
	fn cancel_dismisses_the_modal_beneath_a_higher_z_non_modal_layer() {
		use super::{AppEvent, Routed, route_key_event};
		use crate::{Key, OverlayOptions, dom};

		let mut ui = Ui::from_markup("<input id=base/>", 40, UiContext::default()).unwrap();
		let rail = ui
			.show_overlay(dom! { <text>{"rail"}</text> }, OverlayOptions::default().non_modal().z(10));
		let dialog = ui.show_overlay(dom! { <text>{"confirm"}</text> }, OverlayOptions::default());
		let quit = [Key::Ctrl('c')];
		assert_eq!(
			route_key_event(&mut ui, Key::Esc, &quit, &[], true),
			Routed::Event(AppEvent::OverlayClosed(dialog)),
			"the cancel dismisses the modal that routed it, not the stack top",
		);
		assert!(ui.overlay(rail).is_some(), "the higher-z pane survives");
		assert!(ui.overlay(dialog).is_none());
	}

	use super::{ImageLoader, Msg, UiHandle};
	use crate::{
		Cached, Component, Elements, Prop, Props, Ui, UiContext, components::Img,
		test_support::frame_row_text,
	};

	#[expect(
		clippy::future_not_send,
		reason = "this helper runs only in current-thread Tokio tests with thread-confined UI \
		          components"
	)]
	async fn receive_image<'a>(loader: &'a ImageLoader, ui: &'a mut Ui) {
		let message = tokio::time::timeout(Duration::from_secs(5), loader.rx.recv_async())
			.await
			.expect("image decode completes")
			.expect("image bus remains connected");
		let Msg::ImageDecoded { slot, state } = message else {
			panic!("image loader only emits decode messages");
		};
		assert!(ui.deliver_image(slot, state));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn image_decode_delivers_without_blocking_initial_layout() {
		let dir = env::temp_dir().join(format!("omp-tui-runtime-image-{}", process::id()));
		fs::create_dir_all(&dir).unwrap();
		let path = dir.join("async.ppm");
		let mut ppm = b"P6\n4 4\n255\n".to_vec();
		for y in 0..4 {
			for _ in 0..4 {
				ppm.extend(if y < 2 { [255, 0, 0] } else { [0, 0, 255] });
			}
		}
		fs::write(&path, ppm).unwrap();

		let loader = ImageLoader::new();
		let ctx = UiContext { loader: Some(loader.clone()), ..UiContext::default() };
		let mut ui = Ui::from_markup(format!("<img src={} w=4/>", path.display()), 10, ctx).unwrap();
		let initial_rows = (0..ui.height())
			.map(|row| frame_row_text(ui.frame(), row))
			.collect::<Vec<_>>();
		assert_eq!(ui.height(), 3, "loading uses the fixed box placeholder");
		assert!(initial_rows[0].contains('┌'));
		assert!(!initial_rows.iter().any(|row| row.contains('▀')));

		receive_image(&loader, &mut ui).await;
		assert_eq!(ui.height(), 2, "4px source relayouts to two half-block rows");
		assert!((0..ui.height()).any(|row| frame_row_text(ui.frame(), row).contains('▀')));

		let elements = Elements::builder()
			.with("logo", |_: &str, props: Props, _: Vec<Cached>| {
				let source = props.str_of(Prop::Src).map_or("", |value| value.as_str());
				Box::new(Img::new().with_str(Prop::Src, source).with(Prop::W, 4_u16))
					as Box<dyn Component>
			})
			.build();
		let custom_loader = ImageLoader::new();
		let mut custom_ctx = UiContext { elements, ..UiContext::default() };
		custom_ctx.loader = Some(custom_loader.clone());
		let mut custom_ui =
			Ui::from_markup(format!("<logo src={}/>", path.display()), 10, custom_ctx).unwrap();
		receive_image(&custom_loader, &mut custom_ui).await;
		assert!(
			(0..custom_ui.height()).any(|row| frame_row_text(custom_ui.frame(), row).contains('▀'))
		);

		fs::remove_file(path).unwrap();
		fs::remove_dir(dir).unwrap();
	}

	#[test]
	fn ui_handle_applies_sync_thread_update_between_frames() {
		use super::CancellationToken;

		let (tx, rx) = flume::unbounded();
		let handle = UiHandle { tx, cancel: CancellationToken::new() };
		let mut ui =
			Ui::from_markup(r#"<text id="message">before</text>"#, 20, UiContext::default()).unwrap();
		let before = frame_row_text(ui.frame(), 0);

		thread::spawn(move || handle.set_text("message", "after"))
			.join()
			.expect("update thread finishes");
		let Msg::Update(update) = rx.recv().expect("thread queues one mutation") else {
			panic!("UiHandle only emits update messages");
		};
		update(&mut ui);

		let after = frame_row_text(ui.frame(), 0);
		assert_ne!(after, before);
		assert_eq!(after, "after");
	}
}
