mod applications;
mod ax;
mod backend;
mod control;
mod error;
mod frame;
mod keys;
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
mod menus;
#[cfg(target_os = "macos")]
mod native_helper;
mod text_range;
mod types;
#[cfg(any(target_os = "windows", test))]
mod win32;

use std::{
	collections::HashMap,
	panic::AssertUnwindSafe,
	sync::{
		Arc,
		atomic::{AtomicU32, AtomicUsize, Ordering},
	},
	thread::{self, JoinHandle},
	time::{Duration, Instant},
};

pub use applications::{Application, ApplicationOpenOptions, ApplicationQuery, OpenedApplication};
use ax::{AppFocus, AxRegistry, register_node};
use backend::{
	Backend, ClickOptions, DeliveryMode, DisplayAwakeHold, ElementDelivery, ElementInput,
	KeyboardFocus, MouseButton, PointerEvent, is_raise_action,
};
use control::{CancellationSource, InputLease, OperationToken};
use error::{CoreResult, DesktopError, ErrorCode};
use frame::{FrameGeometry, apply_capture_caps, encode_png};
use keys::{parse_keys, parse_modifiers};
pub use menus::DesktopMenuItem;
use napi::{Result, bindgen_prelude::Uint8Array};
use napi_derive::napi;
use parking_lot::Mutex;
pub use types::*;

use crate::task;

const OPERATION_TIMEOUT: Duration = Duration::from_mins(3);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
/// How long the display stays awake after the last desktop request, unless an
/// agent turn holds it (see [`DisplayAwake::hold_until_released`]). Releasing
/// the assertion restarts the OS display-sleep countdown, so the display can
/// sleep this long plus the user's display-sleep setting after the agent's
/// last action, and never sooner while the agent keeps acting.
const DISPLAY_AWAKE_GRACE: Duration = Duration::from_mins(5);

/// The display-awake assertion, shared by the worker that takes it for
/// activity and the session, which drops it when a caller gives up (timeout,
/// close) while the worker may still be blocked inside a request, or when the
/// agent's turn ends.
#[derive(Default)]
struct DisplayAwake(Mutex<AwakeState>);

#[derive(Default)]
struct AwakeState {
	hold:       Option<DisplayAwakeHold>,
	/// An agent turn is acting: activity from now on holds for the turn.
	armed:      bool,
	/// Activity came while `armed`: the grace period does not end the
	/// hold; only [`DisplayAwake::release_turn`] or closing the session does.
	turn_holds: bool,
}

impl DisplayAwake {
	/// Takes the assertion for a request unless its caller has given up. The
	/// token is checked under the lock, so a request cancelled by
	/// [`Self::cancel_and_release`] never takes the hold afterwards.
	fn hold(
		&self,
		token: &OperationToken,
		start: impl FnOnce() -> Option<DisplayAwakeHold>,
	) -> bool {
		let mut state = self.0.lock();
		if token.check().is_err() {
			return false;
		}
		if state.hold.is_none() {
			state.hold = start();
		}
		if state.armed {
			state.turn_holds = true;
		}
		true
	}

	/// Keeps the hold that activity takes from now on until
	/// [`Self::release_turn`], instead of for the grace period. A hold taken
	/// earlier keeps its grace until the turn's first request.
	fn hold_until_released(&self) {
		self.0.lock().armed = true;
	}

	/// Drops a turn's hold now and returns later activity to the grace period.
	/// A hold no turn request took (activity outside a turn, or a turn that
	/// made no request) keeps its grace.
	fn release_turn(&self) {
		let released = {
			let mut state = self.0.lock();
			state.armed = false;
			if std::mem::take(&mut state.turn_holds) {
				state.hold.take()
			} else {
				None
			}
		};
		drop(released);
	}

	/// The grace period after the last activity ran out: drops the hold unless
	/// a turn holds it.
	fn expire(&self) {
		let released = {
			let mut state = self.0.lock();
			if state.turn_holds {
				None
			} else {
				state.hold.take()
			}
		};
		drop(released);
	}

	fn release(&self) {
		let released = self.0.lock().hold.take();
		drop(released);
	}

	/// Cancels every outstanding request and drops the hold under one lock, so
	/// a request with a token from after the cancel takes a fresh hold rather
	/// than reusing the one dropped here.
	fn cancel_and_release(&self, cancellation: &CancellationSource) {
		let released = {
			let mut state = self.0.lock();
			cancellation.cancel();
			state.hold.take()
		};
		drop(released);
	}
}

enum Response {
	Capabilities(DesktopCapabilities),
	Displays(Vec<DesktopDisplay>),
	Windows(Vec<DesktopWindow>),
	Capture(DesktopCapture),
	Observation(DesktopObservation),
	Applications(Vec<Application>),
	OpenedApplication(OpenedApplication),
	MenuItems(Vec<DesktopMenuItem>),
	Unit,
	Snapshot(AxSnapshot),
	/// An input call's takeover focus report; see
	/// [`control::take_focus_return`].
	Input(Option<DesktopFocusReturn>),
	Nodes(Vec<AxNode>),
	Node(Option<AxNode>),
	Attributes(Vec<(String, String)>),
	TextSelection(AxTextSelection),
}

type Reply = flume::Sender<CoreResult<Response>>;

struct QueuedRequest {
	request: Request,
	token:   OperationToken,
}

enum Request {
	Capabilities {
		reply: Reply,
	},
	ListDisplays {
		reply: Reply,
	},
	ListWindows {
		reply: Reply,
	},
	Capture {
		target: Target,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	CaptureRegion {
		target: Target,
		region: CaptureRegion,
		caps:   CaptureCaps,
		reply:  Reply,
	},
	Observe {
		target:  Target,
		caps:    CaptureCaps,
		options: AxSnapshotOptions,
		reply:   Reply,
	},
	ListApplications {
		options: ApplicationQuery,
		reply:   Reply,
	},
	OpenApplication {
		id:      String,
		options: ApplicationOpenOptions,
		reply:   Reply,
	},
	MenuItems {
		target: Target,
		path:   Vec<String>,
		reply:  Reply,
	},
	MenuSelect {
		target: Target,
		path:   Vec<String>,
		reply:  Reply,
	},
	BringToCurrentSpace {
		id:    String,
		reply: Reply,
	},
	HoldKeys {
		target:   Target,
		keys:     Vec<keys::KeyName>,
		duration: Duration,
		takeover: Takeover,
		reply:    Reply,
	},
	HoldMouse {
		target:      Target,
		x:           f64,
		y:           f64,
		button:      MouseButton,
		keys:        Vec<keys::KeyName>,
		duration:    Duration,
		takeover:    Takeover,
		refuse_menu: bool,
		reply:       Reply,
	},
	Click {
		target:  Target,
		x:       f64,
		y:       f64,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	MoveMouse {
		target:   Target,
		x:        f64,
		y:        f64,
		takeover: Takeover,
		reply:    Reply,
	},
	Drag {
		target:  Target,
		path:    Vec<(f64, f64)>,
		options: ParsedPointerOptions,
		reply:   Reply,
	},
	Scroll {
		target:   Target,
		x:        f64,
		y:        f64,
		dx:       f64,
		dy:       f64,
		takeover: Takeover,
		reply:    Reply,
	},
	TypeText {
		target:   Target,
		text:     String,
		takeover: Takeover,
		reply:    Reply,
	},
	KeyChord {
		target:   Target,
		keys:     Vec<keys::KeyName>,
		takeover: Takeover,
		reply:    Reply,
	},
	RaiseWindow {
		id:    String,
		reply: Reply,
	},
	AxSnapshot {
		target:  Target,
		options: AxSnapshotOptions,
		reply:   Reply,
	},
	AxQuery {
		target: Target,
		query:  AxQuery,
		reply:  Reply,
	},
	AxElementAt {
		target: Target,
		x:      f64,
		y:      f64,
		reply:  Reply,
	},
	AxFocused {
		reply: Reply,
	},
	AxNode {
		reference: String,
		reply:     Reply,
	},
	AxAttributes {
		reference: String,
		reply:     Reply,
	},
	AxChildren {
		reference: String,
		reply:     Reply,
	},
	AxParent {
		reference: String,
		reply:     Reply,
	},
	AxPerform {
		reference: String,
		action:    String,
		menu:      Option<Vec<String>>,
		reply:     Reply,
	},
	AxSetValue {
		reference: String,
		value:     String,
		reply:     Reply,
	},
	AxSelectText {
		reference: String,
		request:   text_range::TextSelectRequest,
		reply:     Reply,
	},
	AxFocus {
		reference: String,
		reply:     Reply,
	},
	AxClick {
		reference: String,
		options:   ParsedPointerOptions,
		reply:     Reply,
	},
	AxInput {
		reference: String,
		input:     ElementInput,
		takeover:  Takeover,
		reply:     Reply,
	},
	Close {
		reply: Reply,
	},
}

impl Request {
	fn reply(self, result: CoreResult<Response>) -> bool {
		let reply = match self {
			Self::Capabilities { reply }
			| Self::ListDisplays { reply }
			| Self::ListWindows { reply }
			| Self::Capture { reply, .. }
			| Self::CaptureRegion { reply, .. }
			| Self::Observe { reply, .. }
			| Self::ListApplications { reply, .. }
			| Self::OpenApplication { reply, .. }
			| Self::MenuItems { reply, .. }
			| Self::MenuSelect { reply, .. }
			| Self::BringToCurrentSpace { reply, .. }
			| Self::HoldKeys { reply, .. }
			| Self::HoldMouse { reply, .. }
			| Self::Click { reply, .. }
			| Self::MoveMouse { reply, .. }
			| Self::Drag { reply, .. }
			| Self::Scroll { reply, .. }
			| Self::TypeText { reply, .. }
			| Self::KeyChord { reply, .. }
			| Self::RaiseWindow { reply, .. }
			| Self::AxSnapshot { reply, .. }
			| Self::AxQuery { reply, .. }
			| Self::AxElementAt { reply, .. }
			| Self::AxFocused { reply }
			| Self::AxNode { reply, .. }
			| Self::AxAttributes { reply, .. }
			| Self::AxChildren { reply, .. }
			| Self::AxParent { reply, .. }
			| Self::AxPerform { reply, .. }
			| Self::AxSetValue { reply, .. }
			| Self::AxSelectText { reply, .. }
			| Self::AxFocus { reply, .. }
			| Self::AxClick { reply, .. }
			| Self::AxInput { reply, .. }
			| Self::Close { reply } => reply,
		};
		reply.send(result).is_ok()
	}

	/// Requests that can send input or move focus, which hold the input lease.
	/// A menu read counts: on macOS it makes its window key first.
	const fn is_mutation(&self) -> bool {
		matches!(
			self,
			Self::Click { .. }
				| Self::MoveMouse { .. }
				| Self::Drag { .. }
				| Self::Scroll { .. }
				| Self::TypeText { .. }
				| Self::KeyChord { .. }
				| Self::RaiseWindow { .. }
				| Self::AxPerform { .. }
				| Self::AxSetValue { .. }
				| Self::AxSelectText { .. }
				| Self::AxFocus { .. }
				| Self::AxClick { .. }
				| Self::AxInput { .. }
				| Self::OpenApplication { .. }
				| Self::MenuItems { .. }
				| Self::MenuSelect { .. }
				| Self::BringToCurrentSpace { .. }
				| Self::HoldKeys { .. }
				| Self::HoldMouse { .. }
		)
	}

	/// Whether this mutation takes over the user's own input or foreground,
	/// which arms the physical-Escape stop: `takeover: true` delivery, input
	/// to a desktop or display target (it drives the user's real pointer and
	/// keyboard), an explicit raise, and an activating launch or a reveal in
	/// Finder, which always comes to the front. Held control
	/// armed the stop when it was granted, so every operation under it keeps
	/// the stop.
	fn takes_over(&self) -> bool {
		let (target, takeover) = match self {
			Self::HoldKeys { target, takeover, .. }
			| Self::HoldMouse { target, takeover, .. }
			| Self::MoveMouse { target, takeover, .. }
			| Self::Scroll { target, takeover, .. }
			| Self::TypeText { target, takeover, .. }
			| Self::KeyChord { target, takeover, .. } => (Some(target), *takeover),
			Self::Click { target, options, .. } | Self::Drag { target, options, .. } => {
				(Some(target), options.takeover)
			},
			Self::AxClick { options, .. } => (None, options.takeover),
			Self::AxInput { takeover, .. } => (None, *takeover),
			Self::RaiseWindow { .. } => return true,
			Self::OpenApplication { options, .. } => {
				return options.activate.unwrap_or(false) || options.reveal.unwrap_or(false);
			},
			Self::AxPerform { action, .. } => return is_raise_action(action),
			// Background-only mutations and reads: listed by name so a new
			// request variant must decide whether it arms the stop.
			Self::MenuItems { .. }
			| Self::MenuSelect { .. }
			| Self::BringToCurrentSpace { .. }
			| Self::AxSetValue { .. }
			| Self::AxSelectText { .. }
			| Self::AxFocus { .. }
			| Self::Capabilities { .. }
			| Self::ListDisplays { .. }
			| Self::ListWindows { .. }
			| Self::Capture { .. }
			| Self::CaptureRegion { .. }
			| Self::Observe { .. }
			| Self::ListApplications { .. }
			| Self::AxSnapshot { .. }
			| Self::AxQuery { .. }
			| Self::AxElementAt { .. }
			| Self::AxFocused { .. }
			| Self::AxNode { .. }
			| Self::AxAttributes { .. }
			| Self::AxChildren { .. }
			| Self::AxParent { .. }
			| Self::Close { .. } => return false,
		};
		target.is_some_and(|target| !matches!(target, Target::Window(_)))
			|| takeover.mode() != DeliveryMode::Background
	}

	const fn frame_target(&self) -> Option<&Target> {
		match self {
			Self::Capture { target, .. } | Self::Observe { target, .. } => Some(target),
			_ => None,
		}
	}

	/// The request's target, for requests that name one.
	const fn target(&self) -> Option<&Target> {
		match self {
			Self::Capture { target, .. }
			| Self::CaptureRegion { target, .. }
			| Self::Observe { target, .. }
			| Self::MenuItems { target, .. }
			| Self::MenuSelect { target, .. }
			| Self::HoldKeys { target, .. }
			| Self::HoldMouse { target, .. }
			| Self::Click { target, .. }
			| Self::MoveMouse { target, .. }
			| Self::Drag { target, .. }
			| Self::Scroll { target, .. }
			| Self::TypeText { target, .. }
			| Self::KeyChord { target, .. }
			| Self::AxSnapshot { target, .. }
			| Self::AxQuery { target, .. }
			| Self::AxElementAt { target, .. } => Some(target),
			_ => None,
		}
	}

	/// The element ref the request acts on or reads, for requests that name
	/// one.
	fn reference(&self) -> Option<&str> {
		match self {
			Self::AxNode { reference, .. }
			| Self::AxAttributes { reference, .. }
			| Self::AxChildren { reference, .. }
			| Self::AxParent { reference, .. }
			| Self::AxPerform { reference, .. }
			| Self::AxSetValue { reference, .. }
			| Self::AxSelectText { reference, .. }
			| Self::AxInput { reference, .. }
			| Self::AxFocus { reference, .. }
			| Self::AxClick { reference, .. } => Some(reference),
			_ => None,
		}
	}

	const fn is_close(&self) -> bool {
		matches!(self, Self::Close { .. })
	}

	/// Agent activity: everything except status reads and teardown keeps the
	/// display awake, so captures and input see a lit, unlocked screen.
	const fn is_activity(&self) -> bool {
		!matches!(self, Self::Capabilities { .. } | Self::Close { .. })
	}

	/// The window or element whose app this request reads or acts on, for the
	/// user-input watch. Desktop and display targets name no app, and a launch
	/// has no process yet.
	#[cfg(target_os = "macos")]
	fn app_access(&self) -> Option<AppAccess<'_>> {
		const fn window(target: &Target) -> Option<&str> {
			match target {
				Target::Window(id) => Some(id.as_str()),
				Target::Desktop | Target::Display(_) => None,
			}
		}
		match self {
			Self::Capture { target, .. }
			| Self::CaptureRegion { target, .. }
			| Self::Observe { target, .. }
			| Self::AxSnapshot { target, .. }
			| Self::AxQuery { target, .. } => window(target).map(AppAccess::Read),
			Self::AxElementAt { target, .. } => window(target).map(AppAccess::Look),
			// A menu read makes the window key in its app first, so it acts on
			// the app like input.
			Self::MenuItems { target, .. }
			| Self::MenuSelect { target, .. }
			| Self::HoldKeys { target, .. }
			| Self::HoldMouse { target, .. }
			| Self::Click { target, .. }
			| Self::MoveMouse { target, .. }
			| Self::Drag { target, .. }
			| Self::Scroll { target, .. }
			| Self::TypeText { target, .. }
			| Self::KeyChord { target, .. } => window(target).map(AppAccess::Input),
			Self::RaiseWindow { id, .. } | Self::BringToCurrentSpace { id, .. } => {
				Some(AppAccess::Input(id))
			},
			Self::AxPerform { reference, .. }
			| Self::AxSetValue { reference, .. }
			| Self::AxSelectText { reference, .. }
			| Self::AxFocus { reference, .. }
			| Self::AxClick { reference, .. }
			| Self::AxInput { reference, .. } => Some(AppAccess::Element(reference)),
			// Listed by name so a new request must decide whether the watch
			// covers it.
			Self::Capabilities { .. }
			| Self::ListDisplays { .. }
			| Self::ListWindows { .. }
			| Self::ListApplications { .. }
			| Self::OpenApplication { .. }
			| Self::AxFocused { .. }
			| Self::AxNode { .. }
			| Self::AxAttributes { .. }
			| Self::AxChildren { .. }
			| Self::AxParent { .. }
			| Self::Close { .. } => None,
		}
	}
}

/// How a request involves an app, for the user-input watch.
#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
enum AppAccess<'a> {
	/// A capture, observation, or AX snapshot or query of a window: it shows
	/// the window as it is now.
	Read(&'a str),
	/// Another read of a window.
	Look(&'a str),
	/// Input or another mutation aimed at a window.
	Input(&'a str),
	/// Input or another mutation aimed at an element ref.
	Element(&'a str),
}

/// A request's part in the user-input watch, held while it runs.
#[cfg(target_os = "macos")]
#[derive(Default)]
struct AppWatch {
	/// The app whose window a read shows, and when the read began.
	read:   Option<(libc::pid_t, Instant)>,
	/// An admitted input's key-press watch.
	_input: Option<control::intervention::InputWatch>,
}

#[derive(Clone)]
struct ParsedPointerOptions {
	button:      MouseButton,
	count:       u32,
	modifiers:   backend::Modifiers,
	keys:        Vec<keys::KeyName>,
	takeover:    Takeover,
	menu:        Option<Vec<String>>,
	refuse_menu: bool,
}
impl ParsedPointerOptions {
	fn parse(options: Option<PointerOptions>) -> CoreResult<Self> {
		let options = options.unwrap_or_default();
		if let Some(menu) = &options.menu {
			menus::validate_path(menu, false)?;
		}
		Ok(Self {
			button:      MouseButton::parse(options.button.as_deref())?,
			count:       options.count.unwrap_or(1).max(1),
			modifiers:   parse_modifiers(options.modifiers.as_deref().unwrap_or_default())?,
			keys:        parse_keys(options.keys.as_deref().unwrap_or_default())?,
			takeover:    Takeover::new(options.takeover, options.return_focus),
			menu:        options.menu,
			refuse_menu: options.refuse_menu == Some(true),
		})
	}

	const fn mode(&self) -> DeliveryMode {
		self.takeover.mode()
	}

	const fn click_options(&self) -> ClickOptions<'_> {
		ClickOptions {
			button:      self.button,
			count:       self.count,
			modifiers:   self.modifiers,
			menu:        match &self.menu {
				Some(path) => Some(path.as_slice()),
				None => None,
			},
			refuse_menu: self.refuse_menu,
			mode:        self.mode(),
		}
	}

	/// Sends the click `event` as these options ask ([`ClickOptions::send`]).
	fn click(
		&self,
		backend: &mut dyn Backend,
		target: &Target,
		event: PointerEvent,
		frame: &FrameGeometry,
		token: &OperationToken,
	) -> CoreResult<()> {
		self
			.click_options()
			.send(backend, target, event, frame, token)
	}
}

/// With `refuse`, refuses background `event` on `target` before anything is
/// sent when its left press would open a control's menu
/// ([`Backend::refuse_menu_press`]); the host asks for this when the user
/// refuses foreground takeover, since an open menu takes their keyboard.
fn refuse_menu_press(
	backend: &mut dyn Backend,
	refuse: bool,
	mode: DeliveryMode,
	target: &Target,
	event: &PointerEvent,
) -> CoreResult<()> {
	if backend::refuses_menu_press(refuse, mode) {
		backend.refuse_menu_press(target, event)?;
	}
	Ok(())
}

/// The `takeover` and `returnFocus` options of one input request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Takeover {
	requested:    Option<bool>,
	return_focus: bool,
}

impl Takeover {
	const fn new(requested: Option<bool>, return_focus: Option<bool>) -> Self {
		Self { requested, return_focus: matches!(return_focus, Some(true)) }
	}

	const fn mode(self) -> DeliveryMode {
		DeliveryMode::from_takeover(self.requested).returning_focus(self.return_focus)
	}
}

fn hold_duration(seconds: f64) -> CoreResult<Duration> {
	if !seconds.is_finite() || !(0.0..=100.0).contains(&seconds) {
		return Err(DesktopError::input_failed(
			"hold duration must be finite seconds from 0 through 100",
		));
	}
	Ok(Duration::from_secs_f64(seconds))
}

struct Worker {
	backend:       CoreResult<Box<dyn Backend>>,
	registry:      AxRegistry,
	frames:        HashMap<String, FrameGeometry>,
	/// Latest capabilities the worker computed, shared with the session so the
	/// getter can answer while an operation holds the worker.
	capabilities:  Arc<Mutex<Option<DesktopCapabilities>>>,
	display_awake: Arc<DisplayAwake>,
	/// The user's own input into the apps this session reads and acts on.
	#[cfg(target_os = "macos")]
	listener:      control::intervention::Listener,
	/// The app whose window the request being served read, and when the read
	/// began; it shows the user's input only once its reply is delivered.
	#[cfg(target_os = "macos")]
	read:          Option<(libc::pid_t, Instant)>,
	/// Windows whose drawing process the user-input watch already looked up;
	/// a window keeps the process that draws it, so each is probed once.
	#[cfg(target_os = "macos")]
	drawer_probed: std::collections::HashSet<String>,
}

impl Worker {
	fn new(
		selector: DisplaySelector,
		capabilities: Arc<Mutex<Option<DesktopCapabilities>>>,
		display_awake: Arc<DisplayAwake>,
	) -> Self {
		let backend = create_backend(selector);
		Self {
			backend,
			registry: AxRegistry::default(),
			frames: HashMap::new(),
			capabilities,
			display_awake,
			#[cfg(target_os = "macos")]
			listener: control::intervention::Listener::default(),
			#[cfg(target_os = "macos")]
			read: None,
			#[cfg(target_os = "macos")]
			drawer_probed: std::collections::HashSet::new(),
		}
	}

	fn backend(&mut self) -> CoreResult<&mut Box<dyn Backend>> {
		self.backend.as_mut().map_err(|error| error.clone())
	}

	fn window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
		let windows = self.backend()?.windows()?;
		match target {
			Target::Window(id) => windows
				.into_iter()
				.find(|window| window.id == *id)
				.ok_or_else(|| DesktopError::window_not_found(format!("window '{id}' was not found"))),
			Target::Desktop | Target::Display(_) => windows
				.into_iter()
				.find(|window| window.focused)
				.ok_or_else(|| DesktopError::window_not_found("no focused window was found")),
		}
	}

	fn frame(&self, target: &Target) -> CoreResult<FrameGeometry> {
		self.frames.get(target.key()).cloned().ok_or_else(|| {
			DesktopError::invalid_coordinate_frame(format!(
				"no capture of '{}' yet — take a screenshot of this target first; coordinate input is \
				 in pixels of that screenshot",
				target.key()
			))
		})
	}

	fn validated_frame(
		&mut self,
		target: &Target,
	) -> CoreResult<(FrameGeometry, Option<DesktopWindow>)> {
		let frame = self.frame(target)?;
		self.backend()?.validate_frame_layout(&frame)?;
		let current = if matches!(target, Target::Window(_)) {
			Some(self.window(target)?)
		} else {
			None
		};
		frame.validate_window(current.as_ref())?;
		Ok((frame, current))
	}

	fn map_point(
		&mut self,
		target: &Target,
		x: f64,
		y: f64,
	) -> CoreResult<(f64, f64, FrameGeometry)> {
		let (frame, current) = self.validated_frame(target)?;
		let (x, y) = frame.map_point(x, y, current.as_ref())?;
		Ok((x, y, frame))
	}

	fn explicit_window(&mut self, target: &Target) -> CoreResult<DesktopWindow> {
		if !matches!(target, Target::Window(_)) {
			return Err(DesktopError::invalid_target(
				"this operation requires an explicit window target",
			));
		}
		self.window(target)
	}

	fn validate_keyboard_target(&mut self, target: &Target) -> CoreResult<()> {
		if !matches!(target, Target::Display(_)) {
			return Ok(());
		}
		let (frame, _) = self.validated_frame(target)?;
		let window = self.backend()?.focused_keyboard_window()?;
		let displays = self.backend()?.displays()?;
		if !displays.iter().any(|display| {
			i64::from(window.x) < i64::from(display.x) + i64::from(display.width)
				&& i64::from(window.x) + i64::from(window.width) > i64::from(display.x)
				&& i64::from(window.y) < i64::from(display.y) + i64::from(display.height)
				&& i64::from(window.y) + i64::from(window.height) > i64::from(display.y)
		}) {
			return Err(DesktopError::invalid_target(
				"the focused window is outside the known display layout",
			));
		}
		let active = DisplaySelector::Active.select(displays, Some(&window))?;
		if !frame.contains_display(&active[0].id) {
			return Err(DesktopError::invalid_target(
				"the focused window is on another display; focus a window on this display before \
				 keyboard input",
			));
		}
		Ok(())
	}

	fn snapshot(&mut self, target: &Target, options: &AxSnapshotOptions) -> CoreResult<AxSnapshot> {
		let window = self.window(target)?;
		let (backend, registry) = (&mut self.backend, &mut self.registry);
		let ax = backend
			.as_mut()
			.map_err(|error| error.clone())?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)?;
		ax::snapshot(ax, registry, &window, options)
	}

	fn capture_full(
		&mut self,
		target: &Target,
		caps: &CaptureCaps,
		token: &OperationToken,
	) -> CoreResult<DesktopCapture> {
		let selector = target.display_selector();
		// Bracket the acquisition: a lock on either side marks the frame, so a
		// later unlock during encoding cannot pass lock-screen pixels as the app.
		let locked_before = self.backend()?.screen_state(None).locked;
		let (image, mut geometry) = self.backend()?.capture(target, caps, selector.as_ref())?;
		let screen_locked = locked_before || self.backend()?.screen_state(None).locked;
		let source_width = image.width();
		let source_height = image.height();
		let layout = self.backend()?.displays()?;
		geometry.record_layout(&layout)?;
		let image = apply_capture_caps(image, &mut geometry, caps)?;
		let width = image.width();
		let height = image.height();
		let displays =
			self.capture_metadata(target, &geometry, &layout, source_width, source_height)?;
		token.check()?;
		let png = encode_png(image)?;
		token.check()?;
		self.frames.insert(target.key().to_string(), geometry);
		// Refreshing here keeps the snapshot current for getter reads that
		// land while a later operation holds the worker.
		let capabilities = self.backend()?.capabilities();
		*self.capabilities.lock() = Some(capabilities.clone());
		Ok(DesktopCapture {
			data: Uint8Array::from(png),
			width,
			height,
			source_width,
			source_height,
			coordinate_width: width,
			coordinate_height: height,
			region: None,
			target: target.key().to_string(),
			displays,
			backend: capabilities.backend,
			display_server: capabilities.display_server,
			screen_locked,
		})
	}

	fn capture_metadata(
		&mut self,
		target: &Target,
		geometry: &FrameGeometry,
		layout: &[DesktopDisplay],
		source_width: u32,
		source_height: u32,
	) -> CoreResult<Vec<DesktopDisplay>> {
		let source = match target {
			Target::Desktop | Target::Display(_) => return Ok(geometry.display_metadata(layout)),
			Target::Window(_) => {
				let window = self.window(target)?;
				geometry.validate_window(Some(&window))?;
				DesktopDisplay {
					id:           window.id,
					name:         format!("{} — {}", window.app, window.title),
					x:            window.x,
					y:            window.y,
					width:        window.width,
					height:       window.height,
					scale:        f64::from(source_width) / f64::from(window.width.max(1)),
					pixel_x:      0,
					pixel_y:      0,
					pixel_width:  source_width,
					pixel_height: source_height,
					is_primary:   false,
				}
			},
		};
		Ok(geometry.display_metadata(std::slice::from_ref(&source)))
	}

	fn dispatch(&mut self, request: Request, token: &OperationToken) {
		let frame_key = request
			.frame_target()
			.map(|target| target.key().to_string());
		let previous = frame_key.as_ref().and_then(|key| self.frames.remove(key));
		let activity = request.is_activity();
		let result = std::panic::catch_unwind(AssertUnwindSafe(|| self.execute(&request, token)))
			.unwrap_or_else(|_| Err(DesktopError::internal("native desktop worker panicked")));
		let result = if activity {
			let display = request.target().and_then(Target::display_selector);
			self.explain_failure(result, display.as_ref())
		} else {
			result
		};
		let failed = result.is_err();
		let delivered = request.reply(result);
		if (failed || !delivered)
			&& let Some(key) = frame_key
		{
			if let Some(frame) = previous {
				self.frames.insert(key, frame);
			} else {
				self.frames.remove(&key);
			}
		}
		#[cfg(target_os = "macos")]
		if let Some((pid, started)) = self.read.take()
			&& !failed
			&& delivered
		{
			self.listener.read(pid, started);
		}
	}

	/// A failure while the screen is locked or the display asleep names that
	/// state, since it is the likeliest cause and the raw error does not say.
	/// A request aimed at one display reports that display's sleep.
	fn explain_failure<T>(
		&mut self,
		result: CoreResult<T>,
		display: Option<&DisplaySelector>,
	) -> CoreResult<T> {
		result.map_err(|mut error| {
			if let Ok(backend) = self.backend.as_mut()
				&& let Some(note) = backend.screen_state(display).failure_note()
			{
				error.message = format!("{} ({note})", error.message);
			}
			error
		})
	}

	/// Holds the display awake for an activity request whose caller is still
	/// waiting; returns whether it was, i.e. whether the request counts as
	/// activity for the grace period.
	fn hold_display_awake(&mut self, token: &OperationToken) -> bool {
		let backend = self.backend.as_mut().ok();
		self
			.display_awake
			.hold(token, || backend.and_then(|backend| backend.hold_display_awake()))
	}

	/// Serves requests until close or disconnect. Each activity request whose
	/// caller is still waiting holds the display awake until `grace` passes
	/// with no further activity, or until the turn holding it is released; the
	/// hold is released before the loop returns.
	fn serve(mut self, rx: &flume::Receiver<QueuedRequest>, grace: Duration) {
		let mut awake_until: Option<Instant> = None;
		loop {
			let next = match awake_until {
				Some(deadline) => rx.recv_deadline(deadline),
				None => rx.recv().map_err(|_| flume::RecvTimeoutError::Disconnected),
			};
			let QueuedRequest { request, token } = match next {
				Ok(queued) => queued,
				Err(flume::RecvTimeoutError::Timeout) => {
					self.display_awake.expire();
					awake_until = None;
					continue;
				},
				Err(flume::RecvTimeoutError::Disconnected) => break,
			};
			let close = request.is_close();
			let activity = request.is_activity() && self.hold_display_awake(&token);
			self.dispatch(request, &token);
			if close {
				break;
			}
			if activity {
				awake_until = Some(Instant::now() + grace);
			}
		}
		self.display_awake.release();
	}

	fn execute(&mut self, request: &Request, token: &OperationToken) -> CoreResult<Response> {
		if request.is_close() {
			return Ok(Response::Unit);
		}
		token.check()?;
		let _scope = token.enter();
		// Input the user's recent activity holds back fails here, before it
		// takes the input lease.
		#[cfg(target_os = "macos")]
		let watch = {
			self.read = None;
			match self.watch_app(request, token) {
				Ok(watch) => watch,
				// Naming an element's app can find it destroyed; that `StaleRef`
				// names its match like one from the request itself.
				Err(error) => {
					return Err(match request.reference() {
						Some(reference) => self.name_match(reference, error, token),
						None => error,
					});
				},
			}
		};
		let lease = request
			.is_mutation()
			.then(|| InputLease::acquire(token, request.takes_over()))
			.transpose()?;
		token.check()?;
		// A full capture replaces coordinates only if it completes in its
		// original generation. Keep the previous frame by move, not by
		// cloning an atlas.
		let previous_frame = request
			.frame_target()
			.and_then(|target| self.frames.remove(target.key()));
		control::take_focus_return();
		// A read cancelled while it ran is discarded, a menu read included.
		// Input's result stands, since it may have gone out: a cancel arriving
		// after it stops the next call instead.
		let result = self.process(request, token).and_then(|response| {
			if !request.is_mutation() || matches!(request, Request::MenuItems { .. }) {
				token.check()?;
			}
			Ok(response)
		});
		if result.is_err()
			&& let Some(target) = request.frame_target()
		{
			match previous_frame {
				Some(frame) => {
					self.frames.insert(target.key().to_string(), frame);
				},
				None => {
					self.frames.remove(target.key());
				},
			}
		}
		#[cfg(target_os = "macos")]
		if let Ok(response) = &result {
			self.read = watch.read;
			self.watch_found(request, response);
		}
		// A `StaleRef` search reads the whole window, which can take long
		// enough to keep other sessions from input: it runs once the call has
		// released it.
		drop(lease);
		match (result, request.reference()) {
			(Err(error), Some(reference)) => Err(self.name_match(reference, error, token)),
			(result, _) => result,
		}
	}

	/// Names, in a `StaleRef` from `reference`'s element, the one element of
	/// its window with the fields the ref was read with ([`ax::refind`]),
	/// registered as a new ref. Nothing is sent to that element: equal fields
	/// do not prove it is the same control, so the caller decides. Searches
	/// only for a ref read with such fields, and only once its element is
	/// provably destroyed.
	fn name_match(
		&mut self,
		reference: &str,
		error: DesktopError,
		token: &OperationToken,
	) -> DesktopError {
		if error.code != ErrorCode::StaleRef
			|| !self.registry.has_proof(reference)
			|| token.check().is_err()
		{
			return error;
		}
		let Ok(handle) = self.registry.resolve(reference) else {
			return error;
		};
		let Ok(target) = self.registry.target(reference) else {
			return error;
		};
		let Ok(window) = self.window(&Target::Window(target)) else {
			return error;
		};
		let (backend, registry) = (&mut self.backend, &mut self.registry);
		let Some(ax) = backend.as_mut().ok().and_then(|backend| backend.ax()) else {
			return error;
		};
		if !ax.destroyed(&handle) {
			return error;
		}
		match ax::refind(ax, registry, &window, reference) {
			Ok(Some(found)) => DesktopError::stale_ref(format!(
				"{reference} destroyed; {found} is the one element in the window with the role, \
				 labels and value {reference} was read with. Equal fields do not prove it is the same \
				 control: check {found} before acting on it, or re-run ax()/find()"
			)),
			_ => error,
		}
	}

	/// Watches the user's own input into the app `request` reads or acts on,
	/// starting with the first request to name it. Input to an app the user
	/// has used since the session last read it waits for them to pause, then
	/// fails ([`control::intervention::Listener::admit`]). Without the tap
	/// nothing is watched, so the owner is not even looked up.
	#[cfg(target_os = "macos")]
	fn watch_app(&mut self, request: &Request, token: &OperationToken) -> CoreResult<AppWatch> {
		let Some(access) = request.app_access() else {
			return Ok(AppWatch::default());
		};
		if !self.listener.listening() {
			return Ok(AppWatch::default());
		}
		let started = Instant::now();
		let (app, input) = match access {
			AppAccess::Read(id) | AppAccess::Look(id) | AppAccess::Input(id) => {
				let app = self.backend()?.window_app(id);
				// The user's input into a panel another process draws goes to
				// that process from the first read on, before any input of the
				// session's names it.
				let input = match app {
					Some(pid) if self.drawer_probed.insert(id.to_string()) => {
						Some(self.backend()?.window_input(id, pid))
					},
					_ => None,
				};
				(app, input)
			},
			AppAccess::Element(reference) => match self.element_app(reference)? {
				Some((app, input)) => (Some(app), Some(input)),
				None => (None, None),
			},
		};
		let Some(pid) = app else {
			// Input whose app cannot be named fails like the input itself
			// would; a ref that no longer resolves fails in `process`.
			return match access {
				AppAccess::Input(id) => Err(DesktopError::window_not_found(format!(
					"window '{id}' was not found; it may be closed"
				))),
				_ => Ok(AppWatch::default()),
			};
		};
		self.enrol(pid, input);
		Ok(match access {
			AppAccess::Read(_) => AppWatch { read: Some((pid, started)), _input: None },
			AppAccess::Look(_) => AppWatch::default(),
			AppAccess::Input(_) | AppAccess::Element(_) => {
				AppWatch { read: None, _input: Some(self.listener.admit(pid, token)?) }
			},
		})
	}

	/// Records the user's input into app `pid` from now on, with their input
	/// into process `input`, which draws its content, as input into it. The
	/// app's name is looked up only when the app is new to the watch.
	#[cfg(target_os = "macos")]
	fn enrol(&mut self, pid: libc::pid_t, input: Option<libc::pid_t>) {
		let backend = &mut self.backend;
		self
			.listener
			.touch(pid, macos::process_started(pid), || match backend {
				Ok(backend) => backend.app_name(pid),
				Err(_) => format!("process {pid}"),
			});
		if let Some(input) = input {
			self.listener.route(input, pid);
		}
	}

	/// Watches the app of the element a read found outside any window the
	/// request named, such as the focused element, so the user's input there
	/// before the session acts on its ref counts. The read shows only that
	/// element, not the window, so input the user left unread stays unread.
	#[cfg(target_os = "macos")]
	fn watch_found(&mut self, request: &Request, response: &Response) {
		let Response::Node(Some(node)) = response else {
			return;
		};
		if request.app_access().is_some() || !self.listener.listening() {
			return;
		}
		if let Ok(Some((pid, input))) = self.element_app(&node.ref_) {
			self.enrol(pid, Some(input));
		}
	}

	/// The app an element ref acts in, with the process that owns the element.
	/// The element belongs to the window it was read from, whose app may have
	/// another process draw a panel, such as `openAndSavePanelService` for an
	/// Open or Save panel; elements read from the desktop belong to their own
	/// process. `None` when the ref no longer resolves.
	#[cfg(target_os = "macos")]
	fn element_app(&mut self, reference: &str) -> CoreResult<Option<(libc::pid_t, libc::pid_t)>> {
		let Ok(handle) = self.registry.resolve(reference) else {
			return Ok(None);
		};
		let pid = macos::element_app(&handle)?;
		let window = match self
			.registry
			.target(reference)
			.map(|key| Target::parse(&key))
		{
			Ok(Target::Window(id)) => self.backend()?.window_app(&id),
			_ => None,
		};
		Ok(Some((window.unwrap_or(pid), pid)))
	}

	fn ax(&mut self) -> CoreResult<&mut dyn backend::AxBackend> {
		self
			.backend()?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)
	}

	fn process(&mut self, request: &Request, token: &OperationToken) -> CoreResult<Response> {
		match request {
			Request::Capabilities { .. } => {
				let caps = match self.backend.as_mut() {
					Ok(backend) => backend.capabilities(),
					Err(_) => DesktopCapabilities::unavailable(),
				};
				*self.capabilities.lock() = Some(caps.clone());
				Ok(Response::Capabilities(caps))
			},
			Request::ListDisplays { .. } => Ok(Response::Displays(self.backend()?.displays()?)),
			Request::ListWindows { .. } => Ok(Response::Windows(self.backend()?.windows()?)),
			Request::Capture { target, caps, .. } => {
				Ok(Response::Capture(self.capture_full(target, caps, token)?))
			},
			Request::Observe { target, caps, options, .. } => {
				let capture = self.capture_full(target, caps, token)?;
				token.check()?;
				let accessibility = self.snapshot(target, options)?;
				Ok(Response::Observation(DesktopObservation { capture, accessibility }))
			},
			Request::ListApplications { options, .. } => {
				Ok(Response::Applications(applications::list(options.clone())?))
			},
			Request::OpenApplication { id, options, .. } => {
				Ok(Response::OpenedApplication(applications::open(id, options.clone())?))
			},
			Request::MenuItems { target, path, .. } => {
				let window = self.explicit_window(target)?;
				Ok(Response::MenuItems(self.backend()?.menu_items(&window, path)?))
			},
			Request::MenuSelect { target, path, .. } => {
				let window = self.explicit_window(target)?;
				self.backend()?.menu_select(&window, path, token)?;
				Ok(Response::Unit)
			},
			Request::BringToCurrentSpace { id, .. } => {
				let target = Target::Window(id.clone());
				// The window may be off-Space and absent from capturable windows.
				// Resolve its owner through the Space backend, not capture lookup.
				// A refused or partially completed native move may still change
				// geometry, so never retain its old coordinate frame.
				self.frames.remove(target.key());
				self.backend()?.bring_to_current_space(id, token)?;
				Ok(Response::Unit)
			},
			Request::HoldKeys { target, keys, duration, takeover, .. } => {
				self.validate_keyboard_target(target)?;
				self
					.backend()?
					.hold_keys(target, keys, *duration, takeover.mode(), token)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::HoldMouse {
				target, x, y, button, keys, duration, takeover, refuse_menu, ..
			} => {
				if !keys.is_empty() {
					self.validate_keyboard_target(target)?;
				}
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				let event = PointerEvent::Hold {
					x,
					y,
					button: *button,
					keys: keys.clone(),
					duration: *duration,
				};
				let mode = takeover.mode();
				let backend = self.backend()?;
				refuse_menu_press(backend.as_mut(), *refuse_menu, mode, target, &event)?;
				backend.pointer(target, event, &frame, mode, token)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::CaptureRegion { target, region, caps, .. } => {
				let (base, _) = self.validated_frame(target)?;
				base.validate_region(region)?;
				let selector = base.capture_selector();
				token.check()?;
				let locked_before = self.backend()?.screen_state(None).locked;
				let (image, fresh) =
					self
						.backend()?
						.capture(target, &CaptureCaps::default(), selector.as_ref())?;
				let screen_locked = locked_before || self.backend()?.screen_state(None).locked;
				let layout = self.backend()?.displays().map_err(|error| {
					DesktopError::invalid_coordinate_frame(format!(
						"could not validate captured display layout: {error}"
					))
				})?;
				base.validate_layout(&layout)?;
				let displays =
					self.capture_metadata(target, &base, &layout, image.width(), image.height())?;
				let (image, source_width, source_height) =
					base.crop_region(image, &fresh, region, caps)?;
				let width = image.width();
				let height = image.height();
				let (coordinate_width, coordinate_height) = base.dimensions();
				token.check()?;
				let png = encode_png(image)?;
				let capabilities = self.backend()?.capabilities();
				*self.capabilities.lock() = Some(capabilities.clone());
				Ok(Response::Capture(DesktopCapture {
					data: Uint8Array::from(png),
					width,
					height,
					source_width,
					source_height,
					coordinate_width,
					coordinate_height,
					region: Some(*region),
					target: target.key().to_string(),
					displays,
					backend: capabilities.backend,
					display_server: capabilities.display_server,
					screen_locked,
				}))
			},
			Request::Click { target, x, y, options, .. } => {
				if options.modifiers != backend::Modifiers::default() {
					self.validate_keyboard_target(target)?;
				}
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				options.click(
					self.backend()?.as_mut(),
					target,
					PointerEvent::Click {
						x,
						y,
						button: options.button,
						count: options.count,
						modifiers: options.modifiers,
					},
					&frame,
					token,
				)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::MoveMouse { target, x, y, takeover, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Move { x, y },
					&frame,
					takeover.mode(),
					token,
				)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::Drag { target, path, options, .. } => {
				if !options.keys.is_empty() || options.modifiers != backend::Modifiers::default() {
					self.validate_keyboard_target(target)?;
				}
				let (frame, current) = self.validated_frame(target)?;
				let mapped = path
					.iter()
					.map(|(x, y)| frame.map_point(*x, *y, current.as_ref()))
					.collect::<CoreResult<Vec<_>>>()?;
				let event = PointerEvent::Drag {
					path:      mapped,
					button:    options.button,
					modifiers: options.modifiers,
					keys:      options.keys.clone(),
				};
				let mode = options.mode();
				let backend = self.backend()?;
				refuse_menu_press(backend.as_mut(), options.refuse_menu, mode, target, &event)?;
				backend.pointer(target, event, &frame, mode, token)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::Scroll { target, x, y, dx, dy, takeover, .. } => {
				let (x, y, frame) = self.map_point(target, *x, *y)?;
				self.backend()?.pointer(
					target,
					PointerEvent::Scroll { x, y, dx: *dx, dy: *dy },
					&frame,
					takeover.mode(),
					token,
				)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::TypeText { target, text, takeover, .. } => {
				self.validate_keyboard_target(target)?;
				self
					.backend()?
					.type_text(target, text, takeover.mode(), token)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::KeyChord { target, keys, takeover, .. } => {
				self.validate_keyboard_target(target)?;
				self
					.backend()?
					.key_chord(target, keys, takeover.mode(), token)?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::RaiseWindow { id, .. } => {
				self.backend()?.raise_window(id, token)?;
				Ok(Response::Unit)
			},
			Request::AxSnapshot { target, options, .. } => {
				Ok(Response::Snapshot(self.snapshot(target, options)?))
			},
			Request::AxQuery { target, query, .. } => {
				let window = self.window(target)?;
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let ax = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Nodes(ax::query(ax, registry, &window, query)?))
			},
			Request::AxElementAt { target, x, y, .. } => {
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				let backend = backend
					.as_mut()
					.map_err(|error| error.clone())?
					.ax()
					.ok_or_else(DesktopError::ax_unsupported)?;
				Ok(Response::Node(ax::element_at_node(backend, registry, target.key(), *x, *y)?))
			},
			Request::AxFocused { .. } => {
				let handle = self.ax()?.focused_element()?;
				let node = match handle {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, "desktop", h, &mut AppFocus::default())?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxNode { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let props = ax::node_props(self.ax()?, &h, &mut AppFocus::default())?;
				Ok(Response::Node(Some(ax::node_to_napi(reference.clone(), props))))
			},
			Request::AxAttributes { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let mut attributes = self.ax()?.attributes(&h)?;
				for (_, value) in &mut attributes {
					if value.chars().count() > 200 {
						*value = value
							.chars()
							.take(199)
							.chain(std::iter::once('…'))
							.collect();
					}
				}
				Ok(Response::Attributes(attributes))
			},
			Request::AxChildren { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let handles = self.ax()?.children(&h)?;
				let mut nodes = Vec::with_capacity(handles.len());
				let mut focus = AppFocus::default();
				for h in handles {
					let (backend, registry) = (&mut self.backend, &mut self.registry);
					let ax = backend
						.as_mut()
						.map_err(|error| error.clone())?
						.ax()
						.ok_or_else(DesktopError::ax_unsupported)?;
					nodes.push(register_node(ax, registry, &target, h, &mut focus)?);
				}
				Ok(Response::Nodes(nodes))
			},
			Request::AxParent { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				let target = self.registry.target(reference)?;
				let parent = self.ax()?.parent(&h)?;
				let node = match parent {
					Some(h) => {
						let (backend, registry) = (&mut self.backend, &mut self.registry);
						let ax = backend
							.as_mut()
							.map_err(|error| error.clone())?
							.ax()
							.ok_or_else(DesktopError::ax_unsupported)?;
						Some(register_node(ax, registry, &target, h, &mut AppFocus::default())?)
					},
					None => None,
				};
				Ok(Response::Node(node))
			},
			Request::AxPerform { reference, action, menu, .. } => {
				let h = self.registry.resolve(reference)?;
				let performed = match menu {
					Some(path) => self.ax()?.perform_menu(&h, action, path),
					None if action.eq_ignore_ascii_case("press") => ax::ax_press(self.ax()?, &h),
					None => self.ax()?.perform(&h, action),
				};
				match performed {
					Err(error) if error.code == ErrorCode::AxUnconfirmed => {
						Err(self.name_unconfirmed_target(reference, &h, error))
					},
					performed => performed.map(|()| Response::Unit),
				}
			},
			Request::AxSetValue { reference, value, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.set_value(&h, value)?;
				Ok(Response::Unit)
			},
			Request::AxSelectText { reference, request, .. } => {
				let h = self.registry.resolve(reference)?;
				Ok(Response::TextSelection(self.ax()?.select_text(&h, request)?))
			},
			Request::AxFocus { reference, .. } => {
				let h = self.registry.resolve(reference)?;
				self.ax()?.focus(&h)?;
				Ok(Response::Unit)
			},
			Request::AxClick { reference, options, .. } => {
				let h = self.registry.resolve(reference)?;
				let click = options.click_options();
				// The backend reads the bounds, after the front app on macOS; the
				// error names the ref here, where it is known.
				self
					.backend()?
					.element_click(&h, &click, token)
					.map_err(|error| {
						if error.message == backend::NO_CLICKABLE_BOUNDS {
							DesktopError::ax_failed(format!("{reference} has no clickable bounds"))
						} else {
							error
						}
					})?;
				Ok(Response::Input(control::take_focus_return()))
			},
			Request::AxInput { reference, input, takeover, .. } => {
				let h = self.registry.resolve(reference)?;
				let mode = takeover.mode();
				match self.backend()?.element_input(&h, input, mode, token)? {
					ElementDelivery::Delivered => Ok(Response::Input(control::take_focus_return())),
					ElementDelivery::Unfocused(focus) => {
						Err(self.element_focus_refusal(reference, focus, mode))
					},
				}
			},
			Request::Close { .. } => Ok(Response::Unit),
		}
	}
}

impl Worker {
	/// `error`, an action on `reference` whose outcome is unconfirmed, naming
	/// the window and app the element is in now, so the caller knows which one
	/// to inspect. Only reads: nothing is sent again.
	fn name_unconfirmed_target(
		&mut self,
		reference: &str,
		handle: &ax::AxHandle,
		error: DesktopError,
	) -> DesktopError {
		let windows = self
			.backend()
			.and_then(|backend| backend.windows())
			.unwrap_or_default();
		let window = self
			.ax()
			.and_then(|ax| ax.window_id(handle, &windows))
			.ok()
			.and_then(|id| windows.into_iter().find(|window| window.id == id));
		let target = match window {
			Some(window) => {
				format!("{reference} is in window {} of {} ({:?})", window.id, window.app, window.title)
			},
			None => format!("{reference}'s window could not be identified"),
		};
		DesktopError::new(error.code, format!("{} ({target})", error.message))
	}

	/// The error for keys addressed to `reference` that were never sent
	/// because the element did not take keyboard focus: where focus is now,
	/// with the focused element's `ax()` line and a ref for it.
	fn element_focus_refusal(
		&mut self,
		reference: &str,
		focus: KeyboardFocus,
		mode: DeliveryMode,
	) -> DesktopError {
		let window = match focus.window.as_deref() {
			None => "an unidentified window".to_owned(),
			Some(id) => {
				let title = self
					.backend()
					.and_then(|backend| backend.windows())
					.ok()
					.and_then(|windows| windows.into_iter().find(|window| window.id == id))
					.map(|window| window.title);
				match title {
					Some(title) => format!("window {id} ({title:?})"),
					None => format!("window {id}"),
				}
			},
		};
		let target = focus
			.window
			.or_else(|| self.registry.target(reference).ok())
			.unwrap_or_else(|| "desktop".to_owned());
		let element = match focus.element {
			None => "no element".to_owned(),
			Some(handle) => {
				let (backend, registry) = (&mut self.backend, &mut self.registry);
				backend
					.as_mut()
					.ok()
					.and_then(|backend| backend.ax())
					.and_then(|ax| ax::element_line(ax, registry, &target, handle).ok())
					.unwrap_or_else(|| "an element that could not be read".to_owned())
			},
		};
		let message = format!(
			"{reference} did not take keyboard focus when asked to, so no keys were sent; its \
			 application's keyboard focus is in {window}, on {element}. Re-read with win.ax() or \
			 win.observe() before retrying"
		);
		match mode {
			DeliveryMode::Background => DesktopError::background_unavailable(message),
			DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
				DesktopError::input_failed(message)
			},
		}
	}
}

#[cfg(target_os = "macos")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(macos::MacosBackend::new(selector)?))
}
#[cfg(target_os = "windows")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Ok(Box::new(win32::Win32Backend::new(selector)?))
}
#[cfg(target_os = "linux")]
fn create_backend(selector: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	linux::new_backend(selector)
}
#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
fn create_backend(_: DisplaySelector) -> CoreResult<Box<dyn Backend>> {
	Err(DesktopError::capture_failed("desktop backend unavailable on this platform"))
}

/// Lock and display-sleep state of `selector`'s displays, read on the calling
/// thread rather than through the session worker.
#[cfg(target_os = "macos")]
use macos::screen_state as read_screen_state;
#[cfg(not(target_os = "macos"))]
const fn read_screen_state(_: &DisplaySelector) -> ScreenState {
	ScreenState { locked: false, display_asleep: false }
}

struct Lifecycle {
	tx:     Option<flume::Sender<QueuedRequest>>,
	done:   Option<flume::Receiver<()>>,
	join:   Option<JoinHandle<()>>,
	closed: bool,
}
struct SessionCore {
	selector:          DisplaySelector,
	lifecycle:         Mutex<Lifecycle>,
	capabilities:      Arc<Mutex<Option<DesktopCapabilities>>>,
	display_awake:     Arc<DisplayAwake>,
	/// `call`s sent to the worker that have not returned yet.
	in_flight:         AtomicUsize,
	cancellation:      CancellationSource,
	/// How long `call` waits for the worker's reply before giving up.
	operation_timeout: Duration,
}
impl SessionCore {
	fn new(selector: DisplaySelector, escape_stops: Arc<AtomicU32>) -> Arc<Self> {
		Self::with_operation_timeout(selector, escape_stops, OPERATION_TIMEOUT)
	}

	fn with_operation_timeout(
		selector: DisplaySelector,
		escape_stops: Arc<AtomicU32>,
		operation_timeout: Duration,
	) -> Arc<Self> {
		Arc::new(Self {
			selector,
			lifecycle: Mutex::new(Lifecycle {
				tx:     None,
				done:   None,
				join:   None,
				closed: false,
			}),
			capabilities: Arc::default(),
			display_awake: Arc::default(),
			in_flight: AtomicUsize::new(0),
			cancellation: CancellationSource::counting_escapes(escape_stops),
			operation_timeout,
		})
	}

	fn ensure_started(&self) -> CoreResult<flume::Sender<QueuedRequest>> {
		let mut lifecycle = self.lifecycle.lock();
		if lifecycle.closed {
			return Err(DesktopError::closed());
		}
		if let Some(tx) = &lifecycle.tx {
			return Ok(tx.clone());
		}
		let (tx, rx) = flume::unbounded::<QueuedRequest>();
		let (done_tx, done_rx) = flume::bounded(1);
		let selector = self.selector.clone();
		let caps = Arc::clone(&self.capabilities);
		let display_awake = Arc::clone(&self.display_awake);
		let join = thread::Builder::new()
			.name("omp-desktop-session".into())
			.spawn(move || {
				Worker::new(selector, caps, display_awake).serve(&rx, DISPLAY_AWAKE_GRACE);
				let _ = done_tx.send(());
			})
			.map_err(|e| {
				DesktopError::internal(format!("failed to start native desktop worker: {e}"))
			})?;
		lifecycle.tx = Some(tx.clone());
		lifecycle.done = Some(done_rx);
		lifecycle.join = Some(join);
		Ok(tx)
	}

	fn call(
		&self,
		token: OperationToken,
		make: impl FnOnce(Reply) -> Request,
	) -> CoreResult<Response> {
		token.check()?;
		// Rendezvous delivery: a timed-out/dropped caller must never commit a
		// capture frame that it did not receive.
		let (txr, rxr) = flume::bounded(0);
		let tx = self.ensure_started()?;
		self.in_flight.fetch_add(1, Ordering::AcqRel);
		let reply_by = Instant::now() + self.operation_timeout;
		// Input waiting for the user to pause gives up before this caller does.
		#[cfg(target_os = "macos")]
		let token = token.replying_by(reply_by);
		let response = tx
			.send(QueuedRequest { request: make(txr), token })
			.map_err(|_| DesktopError::internal("native desktop worker stopped unexpectedly"))
			.and_then(|()| {
				rxr.recv_deadline(reply_by).map_err(|e| {
					self.display_awake.cancel_and_release(&self.cancellation);
					DesktopError::timeout(format!("native desktop operation did not complete: {e}"))
				})
			});
		self.in_flight.fetch_sub(1, Ordering::AcqRel);
		response?
	}

	fn close(&self) -> CoreResult<()> {
		// Closed before cancelling, so no request gets a token from after the
		// cancel and starts behind it, holding the display past this release.
		let mut lifecycle = self.lifecycle.lock();
		lifecycle.closed = true;
		self.display_awake.cancel_and_release(&self.cancellation);
		let Some(tx) = lifecycle.tx.take() else {
			return Ok(());
		};
		let (rtx, rrx) = flume::bounded(1);
		tx.send(QueuedRequest {
			request: Request::Close { reply: rtx },
			token:   self.cancellation.token(),
		})
		.map_err(|_| DesktopError::closed())?;
		let _ = rrx.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
			DesktopError::timeout(format!("timed out closing native desktop worker: {e}"))
		})?;
		if let Some(done) = lifecycle.done.take() {
			done.recv_timeout(CLOSE_TIMEOUT).map_err(|e| {
				DesktopError::timeout(format!("native desktop worker did not exit: {e}"))
			})?;
		}
		if let Some(join) = lifecycle.join.take() {
			join
				.join()
				.map_err(|_| DesktopError::internal("native desktop worker panicked during close"))?;
		}
		Ok(())
	}
}
impl Drop for SessionCore {
	fn drop(&mut self) {
		self.display_awake.cancel_and_release(&self.cancellation);
		let lifecycle = self.lifecycle.get_mut();
		if let Some(tx) = lifecycle.tx.take() {
			let (reply, _) = flume::bounded(1);
			let _ = tx.send(QueuedRequest {
				request: Request::Close { reply },
				token:   self.cancellation.token(),
			});
		}
		let _ = lifecycle.join.take();
	}
}

fn response_unit(response: Response) -> CoreResult<()> {
	matches!(response, Response::Unit)
		.ok_or_else(|| DesktopError::internal("unexpected desktop worker response"))
}

/// Physical-Escape stops counted under `key` by every desktop session created
/// with it, including closed ones, until the key is forgotten.
#[napi]
pub fn desktop_escape_stops(key: String) -> u32 {
	control::escape_stops(&key)
}

/// Drops the stop count kept under `key` once no session will use it again.
#[napi]
pub fn forget_desktop_escape_stops(key: String) {
	control::forget_escape_stops(&key);
}

/// Invalidates this process's event taps before it exits.
///
/// No desktop session here sees the user's input again afterwards. A macOS tap
/// that dies with its process while the user types makes `WindowServer`
/// deliver their key again; Bun's `process.exit` runs no native exit hook, so
/// the host calls this from its exit handler.
#[napi]
pub fn close_desktop_event_taps() {
	control::close_event_taps();
}

/// Persistent, serialized native desktop capture/input/accessibility session.
#[napi]
pub struct DesktopSession {
	core: Arc<SessionCore>,
}

impl Drop for DesktopSession {
	fn drop(&mut self) {
		// A running async task can retain SessionCore after its JS wrapper dies.
		// Cancel that work now rather than waiting for the last Arc to disappear.
		self.core.cancellation.cancel();
	}
}
#[napi]
impl DesktopSession {
	#[napi(constructor)]
	pub fn new(options: Option<DesktopSessionOptions>) -> Result<Self> {
		let options = options.unwrap_or_default();
		let escape_stops = control::escape_stop_counter(options.escape_stop_key.as_deref());
		Ok(Self { core: SessionCore::new(DisplaySelector::parse(options.display), escape_stops) })
	}

	/// Asks the worker when it is idle, so permissions are read live. While
	/// another operation holds the worker, answers from the snapshot of the
	/// latest capabilities read or capture instead of blocking the JS thread
	/// behind it.
	#[napi(getter)]
	pub fn capabilities(&self) -> DesktopCapabilities {
		if self.core.in_flight.load(Ordering::Acquire) > 0
			&& let Some(snapshot) = self.core.capabilities.lock().clone()
		{
			return snapshot;
		}
		match self
			.core
			.call(self.core.cancellation.token(), |reply| Request::Capabilities { reply })
		{
			Ok(Response::Capabilities(c)) => c,
			_ => self
				.core
				.capabilities
				.lock()
				.clone()
				.unwrap_or_else(DesktopCapabilities::unavailable),
		}
	}

	/// Lock and display-sleep state read on the calling thread, never queued
	/// behind the worker, so it answers at once even while a request is stuck.
	#[napi(getter)]
	pub fn screen_state(&self) -> ScreenState {
		read_screen_state(&self.core.selector)
	}

	/// Keeps the display awake from the next activity request until
	/// `releaseDisplayAwake()`, however long the session sits idle in between,
	/// instead of for the grace period after the last request. An agent calls
	/// this when it acts inside a turn.
	#[napi]
	pub fn hold_display_until_released(&self) {
		self.core.display_awake.hold_until_released();
	}

	/// Lets the display sleep now if a turn holds it, without waiting behind
	/// queued requests, and returns later activity to the grace period. Activity
	/// outside a turn keeps its grace. An agent calls this when its turn ends.
	#[napi]
	pub fn release_display_awake(&self) {
		self.core.display_awake.release_turn();
	}

	/// How many times the user's physical Escape has stopped takeover input in
	/// this session, or under its `escapeStopKey`. Host cancels, retirement and
	/// release never count, so a rise tells the host the user stopped the work.
	#[napi(getter)]
	pub fn escape_stops(&self) -> u32 {
		self.core.cancellation.escape_stops()
	}

	#[napi]
	pub fn list_displays(&self) -> Result<task::Promise<Vec<DesktopDisplay>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listDisplays", (), move |_| {
			match c.call(token, |reply| Request::ListDisplays { reply })? {
				Response::Displays(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_windows(&self) -> Result<task::Promise<Vec<DesktopWindow>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listWindows", (), move |_| {
			match c.call(token, |reply| Request::ListWindows { reply })? {
				Response::Windows(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn list_applications(
		&self,
		options: Option<ApplicationQuery>,
	) -> Result<task::Promise<Vec<Application>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.listApplications", (), move |_| {
			match c.call(token, |reply| Request::ListApplications {
				options: options.unwrap_or_default(),
				reply,
			})? {
				Response::Applications(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn open_application(
		&self,
		id: String,
		options: Option<ApplicationOpenOptions>,
	) -> Result<task::Promise<OpenedApplication>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.openApplication", (), move |_| {
			match c.call(token, |reply| Request::OpenApplication {
				id,
				options: options.unwrap_or_default(),
				reply,
			})? {
				Response::OpenedApplication(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	/// Capture and accessibility share one serialized request. Neither a failed
	/// snapshot nor an abandoned reply replaces the last delivered input frame.
	#[napi]
	pub fn observe(
		&self,
		target: String,
		caps: Option<CaptureCaps>,
		ax_options: Option<AxSnapshotOptions>,
	) -> Result<task::Promise<DesktopObservation>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.observe", (), move |_| {
			match c.call(token, |reply| Request::Observe {
				target: Target::parse(&target),
				caps: caps.unwrap_or_default(),
				options: ax_options.unwrap_or_default(),
				reply,
			})? {
				Response::Observation(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn menu_items(
		&self,
		target: String,
		path: Option<Vec<String>>,
	) -> Result<task::Promise<Vec<DesktopMenuItem>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.menuItems", (), move |_| {
			match c.call(token, |reply| Request::MenuItems {
				target: Target::parse(&target),
				path: path.unwrap_or_default(),
				reply,
			})? {
				Response::MenuItems(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn menu_select(&self, target: String, path: Vec<String>) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.menuSelect", move |reply| Request::MenuSelect {
			target: Target::parse(&target),
			path,
			reply,
		}))
	}

	#[napi]
	pub fn bring_to_current_space(&self, window_id: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.bringToCurrentSpace", move |reply| Request::BringToCurrentSpace {
			id: window_id,
			reply,
		}))
	}

	#[napi]
	pub fn hold_keys(
		&self,
		target: String,
		keys: Vec<String>,
		options: HoldOptions,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		if keys.is_empty() {
			return Err(DesktopError::invalid_key("holdKeys requires at least one key").into());
		}
		let duration = hold_duration(options.duration).map_err(napi::Error::from)?;
		Ok(self.input("desktop.holdKeys", move |reply| Request::HoldKeys {
			target: Target::parse(&target),
			keys,
			duration,
			takeover: Takeover::new(options.takeover, options.return_focus),
			reply,
		}))
	}

	#[napi]
	pub fn hold_mouse(
		&self,
		target: String,
		x: f64,
		y: f64,
		options: HoldOptions,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let duration = hold_duration(options.duration).map_err(napi::Error::from)?;
		let button = MouseButton::parse(options.button.as_deref()).map_err(napi::Error::from)?;
		let keys =
			parse_keys(options.keys.as_deref().unwrap_or_default()).map_err(napi::Error::from)?;
		Ok(self.input("desktop.holdMouse", move |reply| Request::HoldMouse {
			target: Target::parse(&target),
			x,
			y,
			button,
			keys,
			duration,
			takeover: Takeover::new(options.takeover, options.return_focus),
			refuse_menu: options.refuse_menu == Some(true),
			reply,
		}))
	}

	/// Native ownership only. Human approval is required by the host before
	/// calling this method.
	#[napi]
	pub fn acquire_control(&self) -> Result<task::Promise<DesktopControlState>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.acquireControl", (), move |_| {
			token.check()?;
			if c.lifecycle.lock().closed {
				return Err(DesktopError::closed().into());
			}
			c.cancellation.acquire_control(&token)?;
			if let Err(error) = token.check() {
				c.cancellation.release_control();
				return Err(error.into());
			}
			Ok(DesktopControlState { active: c.cancellation.control_active() })
		}))
	}

	#[napi]
	pub fn release_control(&self) {
		self.core.cancellation.release_control();
	}

	#[napi]
	pub fn control_state(&self) -> DesktopControlState {
		DesktopControlState { active: self.core.cancellation.control_active() }
	}

	/// Retire queued work from a completed helper without revoking task control.
	#[napi]
	pub fn retire(&self) {
		self.core.cancellation.retire();
	}

	/// Sets when the current run ends, `remaining_ms` from now; each run sets
	/// it before its first call. On macOS, input waiting for the user to pause
	/// in its app gives up shortly before it.
	#[napi]
	pub fn set_run_deadline(&self, remaining_ms: f64) {
		let deadline = Duration::try_from_secs_f64(remaining_ms.max(0.0) / 1000.0)
			.ok()
			.and_then(|remaining| Instant::now().checked_add(remaining));
		#[cfg(target_os = "macos")]
		self.core.cancellation.set_deadline(deadline);
		#[cfg(not(target_os = "macos"))]
		let _ = deadline;
	}

	#[napi]
	pub fn capture(
		&self,
		target: String,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.capture", (), move |_| {
			match c.call(token, |reply| Request::Capture {
				target,
				caps: caps.unwrap_or_default(),
				reply,
			})? {
				Response::Capture(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	/// Capture a fresh native-detail region without replacing the full input
	/// coordinate frame.
	#[napi]
	pub fn capture_region(
		&self,
		target: String,
		region: CaptureRegion,
		caps: Option<CaptureCaps>,
	) -> Result<task::Promise<DesktopCapture>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		let target = Target::parse(&target);
		Ok(task::blocking("desktop.captureRegion", (), move |_| {
			match c.call(token, |reply| Request::CaptureRegion {
				target,
				region,
				caps: caps.unwrap_or_default(),
				reply,
			})? {
				Response::Capture(value) => Ok(value),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn click(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.input("desktop.click", move |reply| Request::Click {
			target: Target::parse(&target),
			x,
			y,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn move_mouse(
		&self,
		target: String,
		x: f64,
		y: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.input("desktop.moveMouse", move |reply| Request::MoveMouse {
			target: Target::parse(&target),
			x,
			y,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn drag(
		&self,
		target: String,
		path: Vec<DesktopPoint>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		if o.menu.is_some() {
			return Err(
				DesktopError::invalid_target(
					"menu chooses an item of the menu a click opens; drags take no menu",
				)
				.into(),
			);
		}
		let path = path.into_iter().map(|p| (p.x, p.y)).collect();
		Ok(self.input("desktop.drag", move |reply| Request::Drag {
			target: Target::parse(&target),
			path,
			options: o,
			reply,
		}))
	}

	#[napi]
	pub fn scroll(
		&self,
		target: String,
		x: f64,
		y: f64,
		dx: f64,
		dy: f64,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.input("desktop.scroll", move |reply| Request::Scroll {
			target: Target::parse(&target),
			x,
			y,
			dx,
			dy,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn type_text(
		&self,
		target: String,
		text: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.input("desktop.typeText", move |reply| Request::TypeText {
			target: Target::parse(&target),
			text,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn key_chord(
		&self,
		target: String,
		keys: Vec<String>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.input("desktop.keyChord", move |reply| Request::KeyChord {
			target: Target::parse(&target),
			keys,
			takeover,
			reply,
		}))
	}

	#[napi]
	pub fn raise_window(&self, window_id: String) -> Result<task::Promise<()>> {
		Ok(self
			.unit("desktop.raiseWindow", move |reply| Request::RaiseWindow { id: window_id, reply }))
	}

	#[napi]
	pub fn ax_snapshot(
		&self,
		target: String,
		opts: Option<AxSnapshotOptions>,
	) -> Result<task::Promise<AxSnapshot>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axSnapshot", (), move |_| {
			match c.call(token, |reply| Request::AxSnapshot {
				target: Target::parse(&target),
				options: opts.unwrap_or_default(),
				reply,
			})? {
				Response::Snapshot(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_query(&self, target: String, query: AxQuery) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axQuery", move |reply| Request::AxQuery {
			target: Target::parse(&target),
			query,
			reply,
		}))
	}

	/// Accessibility hit-test at global logical desktop coordinates; needs no
	/// prior capture.
	#[napi]
	pub fn ax_element_at(
		&self,
		target: String,
		x: f64,
		y: f64,
	) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axElementAt", move |reply| Request::AxElementAt {
			target: Target::parse(&target),
			x,
			y,
			reply,
		}))
	}

	#[napi]
	pub fn ax_focused(&self) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axFocused", move |reply| Request::AxFocused { reply }))
	}

	#[napi]
	pub fn ax_node(&self, reference: String) -> Result<task::Promise<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axNode", (), move |_| {
			match c.call(token, |reply| Request::AxNode { reference, reply })? {
				Response::Node(Some(v)) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_attributes(&self, reference: String) -> Result<task::Promise<Vec<(String, String)>>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axAttributes", (), move |_| {
			match c.call(token, |reply| Request::AxAttributes { reference, reply })? {
				Response::Attributes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_children(&self, reference: String) -> Result<task::Promise<Vec<AxNode>>> {
		Ok(self.nodes("desktop.axChildren", move |reply| Request::AxChildren { reference, reply }))
	}

	#[napi]
	pub fn ax_parent(&self, reference: String) -> Result<task::Promise<Option<AxNode>>> {
		Ok(self.node("desktop.axParent", move |reply| Request::AxParent { reference, reply }))
	}

	/// Performs `action` on the element; with `menu`, chooses that item path
	/// in the menu the action opens, which closes it.
	#[napi]
	pub fn ax_perform(
		&self,
		reference: String,
		action: String,
		menu: Option<Vec<String>>,
	) -> Result<task::Promise<()>> {
		if let Some(path) = &menu {
			menus::validate_path(path, false).map_err(napi::Error::from)?;
		}
		Ok(self.unit("desktop.axPerform", move |reply| Request::AxPerform {
			reference,
			action,
			menu,
			reply,
		}))
	}

	#[napi]
	pub fn ax_set_value(&self, reference: String, value: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axSetValue", move |reply| Request::AxSetValue {
			reference,
			value,
			reply,
		}))
	}

	/// Selects `text` in the element's value by accessibility, or places a
	/// caret at its start or end, without focus change or keystrokes.
	#[napi]
	pub fn ax_select_text(
		&self,
		reference: String,
		text: String,
		opts: Option<AxSelectTextOptions>,
	) -> Result<task::Promise<AxTextSelection>> {
		let opts = opts.unwrap_or_default();
		let request = text_range::TextSelectRequest {
			text,
			prefix: opts.prefix.unwrap_or_default(),
			suffix: opts.suffix.unwrap_or_default(),
			part: text_range::SelectPart::parse(opts.select.as_deref()).map_err(napi::Error::from)?,
		};
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		Ok(task::blocking("desktop.axSelectText", (), move |_| {
			match c.call(token, |reply| Request::AxSelectText { reference, request, reply })? {
				Response::TextSelection(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		}))
	}

	#[napi]
	pub fn ax_focus(&self, reference: String) -> Result<task::Promise<()>> {
		Ok(self.unit("desktop.axFocus", move |reply| Request::AxFocus { reference, reply }))
	}

	#[napi]
	pub fn ax_click(
		&self,
		reference: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let o = ParsedPointerOptions::parse(opts).map_err(napi::Error::from)?;
		Ok(self.input("desktop.axClick", move |reply| Request::AxClick {
			reference,
			options: o,
			reply,
		}))
	}

	/// Types `text` into the element: native text fields take it by AX
	/// insertion, other elements as keystrokes once they hold keyboard focus.
	#[napi]
	pub fn ax_type(
		&self,
		reference: String,
		text: String,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.input("desktop.axType", move |reply| Request::AxInput {
			reference,
			input: ElementInput::Text(text),
			takeover,
			reply,
		}))
	}

	/// Presses a key chord in the element once it holds keyboard focus.
	#[napi]
	pub fn ax_key_chord(
		&self,
		reference: String,
		keys: Vec<String>,
		opts: Option<PointerOptions>,
	) -> Result<task::Promise<Option<DesktopFocusReturn>>> {
		let keys = parse_keys(&keys).map_err(napi::Error::from)?;
		let takeover = ParsedPointerOptions::parse(opts)
			.map_err(napi::Error::from)?
			.takeover;
		Ok(self.input("desktop.axKeyChord", move |reply| Request::AxInput {
			reference,
			input: ElementInput::Chord(keys),
			takeover,
			reply,
		}))
	}

	/// Immediately cancel operations submitted before this call. Later
	/// operations may proceed.
	#[napi]
	pub fn cancel(&self) {
		self.core.cancellation.cancel();
	}

	#[napi]
	pub fn close(&self) -> task::Promise<()> {
		self.cancel();
		let c = Arc::clone(&self.core);
		task::blocking("desktop.close", (), move |_| c.close().map_err(Into::into))
	}
}
impl DesktopSession {
	fn unit(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<()> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			c.call(token, make)
				.and_then(response_unit)
				.map_err(Into::into)
		})
	}

	/// An input call, resolving to where its takeover left focus, if it took
	/// over.
	fn input(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Option<DesktopFocusReturn>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			match c.call(token, make)? {
				Response::Input(report) => Ok(report),
				_ => Err(DesktopError::internal("unexpected desktop worker response")),
			}
			.map_err(Into::into)
		})
	}

	fn nodes(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Vec<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			match c.call(token, make)? {
				Response::Nodes(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}

	fn node(
		&self,
		label: &'static str,
		make: impl FnOnce(Reply) -> Request + Send + 'static,
	) -> task::Promise<Option<AxNode>> {
		let c = Arc::clone(&self.core);
		let token = c.cancellation.token();
		task::blocking(label, (), move |_| {
			match c.call(token, make)? {
				Response::Node(v) => Ok(v),
				_ => Err(DesktopError::internal("unexpected response")),
			}
			.map_err(Into::into)
		})
	}
}

#[cfg(test)]
mod capture_tests {
	use std::{collections::HashSet, sync::atomic::AtomicBool};

	use image::RgbaImage;

	use super::*;
	use crate::desktop::{
		ax::{AxBounds, AxHandle, AxProps},
		backend::{AxBackend, Backend},
		error::ErrorCode,
		keys::KeyName,
	};

	const WAYLAND_ID: &str = "atspi::1.31:/org/a11y/atspi/accessible/1";
	/// A window of the fake's app that its window list leaves out, as macOS
	/// leaves out windows on another Space.
	#[cfg(target_os = "macos")]
	const OFF_SPACE_ID: &str = "4242";

	/// Elements by test id under the window root, id 1. A destroyed element
	/// answers every request as gone.
	#[derive(Default)]
	struct FakeTree {
		titles:            HashMap<u64, &'static str>,
		children:          Vec<u64>,
		destroyed:         HashSet<u64>,
		pressed:           Vec<u64>,
		/// A press is delivered, then the app replaces the pressed element with
		/// an identical one under this id and the press answers as stale.
		press_rebuilds_as: Option<u64>,
		/// A press answers as stale while its element stays, as one that met
		/// another element the app destroyed would.
		stale_presses:     bool,
		/// Calls that asked whether an element was destroyed.
		probes:            u32,
		/// Calls that read an element's fields.
		reads:             u32,
		/// Runs as each press is delivered and as each probe asks.
		on_call:           Option<Box<dyn Fn(Call) + Send>>,
		/// A press is delivered and the app answers with an unrelated error.
		unconfirmed:       bool,
	}

	#[derive(Clone, Copy, PartialEq, Eq)]
	enum Call {
		Press,
		Probe,
	}

	impl FakeTree {
		fn element(&self, h: &AxHandle) -> CoreResult<u64> {
			let AxHandle::Test(id) = h else {
				unreachable!("test handles only")
			};
			if self.destroyed.contains(id) {
				Err(DesktopError::stale_ref("the element no longer exists"))
			} else {
				Ok(*id)
			}
		}
	}

	/// Backend that mints a composite AT-SPI window id, mirroring the Wayland
	/// `AtSpiAx` path. Exists to exercise `Worker::process` without a display.
	struct FakeWaylandBackend {
		window:                 DesktopWindow,
		overlap:                Option<DesktopWindow>,
		window_present:         bool,
		/// An AX tree the app can rebuild; `None` answers every element as one
		/// button.
		tree:                   Option<Arc<Mutex<FakeTree>>>,
		clicks:                 Arc<Mutex<Vec<String>>>,
		modes:                  Arc<Mutex<Vec<DeliveryMode>>>,
		layout:                 Arc<Mutex<Vec<DesktopDisplay>>>,
		active_display:         Arc<Mutex<String>>,
		captures:               Arc<Mutex<u8>>,
		window_queries:         Arc<Mutex<u32>>,
		/// `window_queries` as each `element_input` began.
		queries_at_input:       Arc<Mutex<Vec<u32>>>,
		/// Elements report no bounds.
		no_bounds:              bool,
		cancel_on_capabilities: Arc<Mutex<Option<CancellationSource>>>,
		snapshot_error:         Arc<Mutex<bool>>,
		cancel_on_snapshot:     Arc<Mutex<Option<CancellationSource>>>,
		/// Cancelled once a key chord has gone out, as a cancel landing in the
		/// shortcut's reply wait is.
		cancel_after_chord:     Arc<Mutex<Option<CancellationSource>>>,
		screen:                 Arc<Mutex<ScreenState>>,
		/// Display selector each `screen_state` read was narrowed to.
		screen_displays:        Arc<Mutex<Vec<Option<String>>>>,
		/// Display-awake hold transitions, in order.
		awake:                  Arc<Mutex<Vec<bool>>>,
		/// Unlock the session on the next layout read, i.e. after the frame.
		unlock_on_layout:       Arc<Mutex<bool>>,
		/// Each window listing signals the sender, then blocks until the
		/// receiver's sender drops.
		hang_windows:           Option<(flume::Sender<()>, flume::Receiver<()>)>,
		/// Runs as each menu read is served.
		on_menu_read:           Option<Box<dyn Fn() + Send>>,
		/// Another process drawing the window, such as an Open panel's.
		#[cfg(target_os = "macos")]
		drawn_by:               Option<libc::pid_t>,
		/// How many times the app's name was looked up.
		#[cfg(target_os = "macos")]
		name_lookups:           Arc<Mutex<u32>>,
		/// How many times the process drawing a window was looked up.
		#[cfg(target_os = "macos")]
		input_lookups:          Arc<Mutex<u32>>,
		/// Every click lands on a control whose menu would take the keyboard.
		menu_control:           bool,
	}

	impl FakeWaylandBackend {
		fn new() -> Self {
			Self {
				window: DesktopWindow {
					id:      WAYLAND_ID.to_string(),
					title:   "Obsidian".to_string(),
					app:     "obsidian".to_string(),
					pid:     Some(1234),
					x:       0,
					y:       0,
					width:   64,
					height:  48,
					focused: true,
				},
				overlap: None,
				window_present: true,
				tree: None,
				menu_control: false,
				clicks: Arc::new(Mutex::new(Vec::new())),
				modes: Arc::new(Mutex::new(Vec::new())),
				layout: Arc::new(Mutex::new(vec![DesktopDisplay {
					id:           "screen-1".to_string(),
					name:         "Test screen".to_string(),
					x:            0,
					y:            0,
					width:        64,
					height:       48,
					scale:        1.0,
					pixel_x:      0,
					pixel_y:      0,
					pixel_width:  64,
					pixel_height: 48,
					is_primary:   true,
				}])),
				active_display: Arc::new(Mutex::new("screen-1".to_string())),
				captures: Arc::new(Mutex::new(0)),
				window_queries: Arc::new(Mutex::new(0)),
				queries_at_input: Arc::new(Mutex::new(Vec::new())),
				no_bounds: false,
				cancel_on_capabilities: Arc::new(Mutex::new(None)),
				snapshot_error: Arc::new(Mutex::new(false)),
				cancel_on_snapshot: Arc::new(Mutex::new(None)),
				cancel_after_chord: Arc::new(Mutex::new(None)),
				screen: Arc::new(Mutex::new(ScreenState::default())),
				screen_displays: Arc::new(Mutex::new(Vec::new())),
				awake: Arc::new(Mutex::new(Vec::new())),
				unlock_on_layout: Arc::new(Mutex::new(false)),
				hang_windows: None,
				on_menu_read: None,
				#[cfg(target_os = "macos")]
				drawn_by: None,
				#[cfg(target_os = "macos")]
				name_lookups: Arc::new(Mutex::new(0)),
				#[cfg(target_os = "macos")]
				input_lookups: Arc::new(Mutex::new(0)),
			}
		}
	}

	impl AxBackend for FakeWaylandBackend {
		fn window_root(&mut self, _: &DesktopWindow) -> CoreResult<AxHandle> {
			let source = self.cancel_on_snapshot.lock().take();
			if let Some(source) = source {
				source.cancel();
			}
			if *self.snapshot_error.lock() {
				return Err(DesktopError::ax_failed("snapshot root unavailable"));
			}
			Ok(AxHandle::Test(1))
		}

		fn window_id(&mut self, _: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
			windows
				.iter()
				.find(|window| window.id == self.window.id)
				.map(|window| window.id.clone())
				.ok_or_else(|| DesktopError::window_not_found("the element's window closed"))
		}

		fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
			let (role, title) = match &self.tree {
				Some(tree) => {
					let mut tree = tree.lock();
					tree.reads += 1;
					let id = tree.element(h)?;
					if id == 1 {
						("window", None)
					} else {
						("button", tree.titles.get(&id).map(|title| (*title).to_string()))
					}
				},
				None => ("button", None),
			};
			Ok(AxProps {
				role: role.to_string(),
				native_role: role.to_string(),
				identity: Some(ax::test_identity((role, &title))),
				partial: false,
				title,
				value: None,
				description: None,
				enabled: true,
				focused: false,
				bounds: (!self.no_bounds).then_some(AxBounds {
					x:      10.0,
					y:      10.0,
					width:  20.0,
					height: 20.0,
				}),
				actions: Vec::new(),
				child_count: 0,
				selected: false,
				role_name: None,
			})
		}

		fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
			let Some(tree) = &self.tree else {
				return Ok(Vec::new());
			};
			let tree = tree.lock();
			Ok(if tree.element(h)? == 1 {
				tree.children.iter().map(|id| AxHandle::Test(*id)).collect()
			} else {
				Vec::new()
			})
		}

		fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
			if let Some(tree) = &self.tree {
				tree.lock().element(h)?;
			}
			unreachable!("tree traversal not exercised")
		}

		fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
			let Some(tree) = &self.tree else {
				self.clicks.lock().push(format!("perform {action}"));
				return Ok(());
			};
			let mut tree = tree.lock();
			let id = tree.element(h)?;
			if action != "press" {
				return Err(DesktopError::ax_failed(format!("no action {action}")));
			}
			if let Some(on_call) = &tree.on_call {
				on_call(Call::Press);
			}
			tree.pressed.push(id);
			if tree.stale_presses {
				return Err(DesktopError::stale_ref("the element no longer exists"));
			}
			if tree.unconfirmed {
				return Err(DesktopError::new(
					ErrorCode::AxUnconfirmed,
					"AX action 'AXPress' was requested, but its outcome could not be confirmed. It may \
					 already have taken effect: observe the window before retrying",
				));
			}
			let Some(copy) = tree.press_rebuilds_as else {
				return Ok(());
			};
			tree.destroyed.insert(id);
			let title = tree.titles[&id];
			tree.titles.insert(copy, title);
			for child in &mut tree.children {
				if *child == id {
					*child = copy;
				}
			}
			Err(DesktopError::stale_ref("the element no longer exists"))
		}

		fn select_text(
			&mut self,
			h: &AxHandle,
			_: &text_range::TextSelectRequest,
		) -> CoreResult<AxTextSelection> {
			if let Some(tree) = &self.tree {
				tree.lock().element(h)?;
			}
			unreachable!("text selection not exercised")
		}

		fn perform_menu(&mut self, _: &AxHandle, action: &str, path: &[String]) -> CoreResult<()> {
			self
				.clicks
				.lock()
				.push(format!("perform {action} menu {}", path.join(" > ")));
			Ok(())
		}

		fn set_value(&mut self, h: &AxHandle, _: &str) -> CoreResult<()> {
			if let Some(tree) = &self.tree {
				tree.lock().element(h)?;
			}
			unreachable!("text input not exercised")
		}

		fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
			if let Some(tree) = &self.tree {
				tree.lock().element(h)?;
			}
			unreachable!("focus not exercised")
		}

		fn element_at(&mut self, _: f64, _: f64) -> CoreResult<Option<AxHandle>> {
			unreachable!("hit testing not exercised")
		}

		fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
			// This test process's own application element, which names a real
			// process.
			#[cfg(target_os = "macos")]
			return macos::application_handle(i32::try_from(std::process::id()).unwrap()).map(Some);
			#[cfg(not(target_os = "macos"))]
			unreachable!("focus not exercised")
		}

		fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
			let tree = self.tree.as_ref().expect("attributes need a tree").lock();
			let id = tree.element(h)?;
			let title = tree.titles.get(&id).copied().unwrap_or_default();
			Ok(vec![("AXTitle".to_string(), title.to_string())])
		}

		fn destroyed(&mut self, h: &AxHandle) -> bool {
			let AxHandle::Test(id) = h else { return false };
			self.tree.as_ref().is_some_and(|tree| {
				let mut tree = tree.lock();
				tree.probes += 1;
				if let Some(on_call) = &tree.on_call {
					on_call(Call::Probe);
				}
				tree.destroyed.contains(id)
			})
		}
	}

	impl Backend for FakeWaylandBackend {
		fn capabilities(&mut self) -> DesktopCapabilities {
			let source = self.cancel_on_capabilities.lock().take();
			if let Some(source) = source {
				source.cancel();
			}
			let screen = *self.screen.lock();
			DesktopCapabilities {
				backend: "wayland".to_string(),
				display_server: Some("wayland".to_string()),
				capture: true,
				screen_locked: screen.locked,
				display_asleep: screen.display_asleep,
				..DesktopCapabilities::unavailable()
			}
		}

		fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
			if std::mem::take(&mut *self.unlock_on_layout.lock()) {
				*self.screen.lock() = ScreenState::default();
			}
			Ok(self.layout.lock().clone())
		}

		fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
			if let Some((entered, hang)) = &self.hang_windows {
				let _ = entered.send(());
				let _ = hang.recv();
			}
			*self.window_queries.lock() += 1;
			Ok(self
				.overlap
				.iter()
				.chain(self.window_present.then_some(&self.window))
				.cloned()
				.collect())
		}

		#[cfg(target_os = "macos")]
		fn window_app(&mut self, id: &str) -> Option<libc::pid_t> {
			(id == self.window.id || id == OFF_SPACE_ID).then_some(1234)
		}

		#[cfg(target_os = "macos")]
		fn app_name(&mut self, _: libc::pid_t) -> String {
			*self.name_lookups.lock() += 1;
			self.window.app.clone()
		}

		#[cfg(target_os = "macos")]
		fn window_input(&mut self, _: &str, pid: libc::pid_t) -> libc::pid_t {
			*self.input_lookups.lock() += 1;
			self.drawn_by.unwrap_or(pid)
		}

		fn screen_state(&mut self, display: Option<&DisplaySelector>) -> ScreenState {
			self
				.screen_displays
				.lock()
				.push(display.map(|display| format!("{display:?}")));
			*self.screen.lock()
		}

		fn hold_display_awake(&mut self) -> Option<DisplayAwakeHold> {
			self.awake.lock().push(true);
			Some(Box::new(FakeAwakeHold(Arc::clone(&self.awake))))
		}

		fn capture(
			&mut self,
			target: &Target,
			_caps: &CaptureCaps,
			selector: Option<&DisplaySelector>,
		) -> CoreResult<(RgbaImage, FrameGeometry)> {
			*self.captures.lock() += 1;
			let generation = *self.captures.lock();
			match target {
				Target::Window(id) if id == &self.window.id => {
					let image = RgbaImage::from_fn(self.window.width, self.window.height, |x, y| {
						image::Rgba([x as u8, y as u8, generation, 255])
					});
					let geometry =
						FrameGeometry::for_window(&self.window, image.width(), image.height());
					Ok((image, geometry))
				},
				Target::Window(id) => {
					Err(DesktopError::window_not_found(format!("Wayland window {id} not found")))
				},
				Target::Desktop | Target::Display(_) => {
					let active = DisplaySelector::Id(self.active_display.lock().clone());
					let mut displays = selector.unwrap_or(&active).select(self.displays()?, None)?;
					let min_x = displays.iter().map(|display| display.x).min().unwrap();
					let min_y = displays.iter().map(|display| display.y).min().unwrap();
					for display in &mut displays {
						display.pixel_x = (display.x - min_x) as u32;
						display.pixel_y = (display.y - min_y) as u32;
					}
					let geometry = FrameGeometry::for_displays(&displays);
					let (width, height) = geometry.dimensions();
					let image = RgbaImage::from_fn(width, height, |x, y| {
						image::Rgba([x as u8, y as u8, generation, 255])
					});
					Ok((image, geometry))
				},
			}
		}

		fn pointer(
			&mut self,
			target: &Target,
			_: PointerEvent,
			_: &FrameGeometry,
			mode: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			self.clicks.lock().push(target.key().to_string());
			self.modes.lock().push(mode);
			Ok(())
		}

		fn pointer_menu(
			&mut self,
			target: &Target,
			_: PointerEvent,
			path: &[String],
			_: &FrameGeometry,
			_: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			self
				.clicks
				.lock()
				.push(format!("{} menu {}", target.key(), path.join(" > ")));
			Ok(())
		}

		fn refuse_menu_press(&mut self, target: &Target, _: &PointerEvent) -> CoreResult<()> {
			if self.menu_control {
				return Err(DesktopError::background_unavailable(format!(
					"the press on window {} lands on a popup button; nothing was sent",
					target.key()
				)));
			}
			Ok(())
		}

		fn type_text(
			&mut self,
			_: &Target,
			_: &str,
			mode: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			self.modes.lock().push(mode);
			Ok(())
		}

		fn key_chord(
			&mut self,
			_: &Target,
			_: &[KeyName],
			mode: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			self.modes.lock().push(mode);
			let cancel = self.cancel_after_chord.lock().take();
			if let Some(source) = cancel {
				source.cancel();
			}
			Ok(())
		}

		fn hold_keys(
			&mut self,
			_: &Target,
			_: &[KeyName],
			_: Duration,
			_: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<()> {
			unreachable!("hold_keys not exercised")
		}

		/// The element never takes focus, which stays on element 7 of the
		/// window.
		fn element_input(
			&mut self,
			h: &AxHandle,
			_: &ElementInput,
			_: DeliveryMode,
			_: &OperationToken,
		) -> CoreResult<ElementDelivery> {
			self
				.queries_at_input
				.lock()
				.push(*self.window_queries.lock());
			if let Some(tree) = &self.tree {
				tree.lock().element(h)?;
			}
			Ok(ElementDelivery::Unfocused(KeyboardFocus {
				window:  Some(self.window.id.clone()),
				element: Some(AxHandle::Test(7)),
			}))
		}

		fn element_click(
			&mut self,
			element: &AxHandle,
			click: &ClickOptions,
			token: &OperationToken,
		) -> CoreResult<()> {
			self
				.queries_at_input
				.lock()
				.push(*self.window_queries.lock());
			let (target, event) = backend::locate_element_click(self, element, click)?;
			click.send(self, &target, event, &FrameGeometry::identity_global(), token)
		}

		fn menu_items(
			&mut self,
			_: &DesktopWindow,
			_: &[String],
		) -> CoreResult<Vec<DesktopMenuItem>> {
			if let Some(on_menu_read) = &self.on_menu_read {
				on_menu_read();
			}
			Ok(Vec::new())
		}

		fn menu_select(
			&mut self,
			_: &DesktopWindow,
			_: &[String],
			_: &OperationToken,
		) -> CoreResult<()> {
			unreachable!("menu_select not exercised")
		}

		fn raise_window(&mut self, _: &str, _: &OperationToken) -> CoreResult<()> {
			unreachable!("raise_window not exercised")
		}

		fn ax(&mut self) -> Option<&mut dyn AxBackend> {
			Some(self)
		}
	}

	/// A worker that holds the ownership test lock for its test: input it is
	/// sent takes the process's one input lease, which the ownership tests in
	/// `control` assert on.
	struct TestWorker {
		worker:     Worker,
		_ownership: parking_lot::MutexGuard<'static, ()>,
	}

	impl std::ops::Deref for TestWorker {
		type Target = Worker;

		fn deref(&self) -> &Worker {
			&self.worker
		}
	}

	impl std::ops::DerefMut for TestWorker {
		fn deref_mut(&mut self) -> &mut Worker {
			&mut self.worker
		}
	}

	fn worker_with(backend: impl Backend + 'static) -> TestWorker {
		TestWorker {
			_ownership: crate::desktop::control::OWNERSHIP_TEST.lock(),
			worker:     unlocked_worker(backend),
		}
	}

	/// A worker for tests that send it no input. Served ones time their calls,
	/// so they must not wait for the ownership tests.
	fn unlocked_worker(backend: impl Backend + 'static) -> Worker {
		Worker {
			backend: Ok(Box::new(backend)),
			registry: AxRegistry::default(),
			frames: HashMap::new(),
			capabilities: Arc::default(),
			display_awake: Arc::default(),
			#[cfg(target_os = "macos")]
			listener: control::intervention::Listener::simulated(),
			#[cfg(target_os = "macos")]
			read: None,
			#[cfg(target_os = "macos")]
			drawer_probed: std::collections::HashSet::new(),
		}
	}

	fn overlapping_backend() -> FakeWaylandBackend {
		let mut backend = FakeWaylandBackend::new();
		backend.overlap =
			Some(DesktopWindow { id: "unrelated-overlay".to_string(), ..backend.window.clone() });
		backend
	}

	fn click_reference(worker: &mut Worker, origin: &str) -> CoreResult<Response> {
		let (backend, registry) = (&mut worker.backend, &mut worker.registry);
		let ax = backend
			.as_mut()
			.map_err(|error| error.clone())?
			.ax()
			.ok_or_else(DesktopError::ax_unsupported)?;
		let reference =
			register_node(ax, registry, origin, AxHandle::Test(1), &mut AppFocus::default())?.ref_;
		let (reply, _rx) = flume::bounded(1);
		worker.process(
			&Request::AxClick { reference, options: ParsedPointerOptions::parse(None)?, reply },
			&CancellationSource::default().token(),
		)
	}

	fn send_and_wait(tx: &flume::Sender<QueuedRequest>, make: impl FnOnce(Reply) -> Request) {
		let (reply, rx) = flume::bounded(1);
		tx.send(QueuedRequest {
			request: make(reply),
			token:   CancellationSource::default().token(),
		})
		.unwrap();
		let _ = rx
			.recv_timeout(Duration::from_secs(5))
			.expect("worker reply");
	}

	/// Waits for the hold transitions to reach `expected`, failing after a
	/// deadline far beyond any grace the tests use.
	fn wait_for_awake(awake: &Mutex<Vec<bool>>, expected: &[bool]) {
		let deadline = Instant::now() + Duration::from_secs(30);
		while awake.lock().as_slice() != expected {
			assert!(
				Instant::now() < deadline,
				"hold transitions {:?}, expected {expected:?}",
				awake.lock()
			);
			thread::sleep(Duration::from_millis(5));
		}
	}

	#[test]
	fn display_stays_awake_only_until_the_grace_after_the_last_activity() {
		let backend = FakeWaylandBackend::new();
		let awake = Arc::clone(&backend.awake);
		let (tx, rx) = flume::unbounded();
		let grace = Duration::from_millis(500);
		let serving = thread::spawn(move || unlocked_worker(backend).serve(&rx, grace));

		send_and_wait(&tx, |reply| Request::Capabilities { reply });
		assert!(awake.lock().is_empty(), "a status read must not hold the display awake");

		// Prefix checks: a stalled test thread may legitimately see the release.
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		assert!(awake.lock().starts_with(&[true]), "activity holds the display awake");
		wait_for_awake(&awake, &[true, false]);

		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		assert!(awake.lock().starts_with(&[true, false, true]), "new activity holds it again");

		send_and_wait(&tx, |reply| Request::Close { reply });
		serving.join().unwrap();
		assert_eq!(*awake.lock(), [true, false, true, false], "close releases the hold");
	}

	#[test]
	fn disconnecting_releases_a_held_display() {
		let backend = FakeWaylandBackend::new();
		let awake = Arc::clone(&backend.awake);
		let (tx, rx) = flume::unbounded();
		let serving =
			thread::spawn(move || unlocked_worker(backend).serve(&rx, Duration::from_secs(3600)));
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		drop(tx);
		serving.join().unwrap();
		assert_eq!(*awake.lock(), [true, false]);
	}

	/// A worker serving with `grace`, sharing the returned hold as a session's
	/// does, so the test can hold and release it for a turn.
	fn serving_with_turns(
		backend: FakeWaylandBackend,
		grace: Duration,
	) -> (Arc<DisplayAwake>, flume::Sender<QueuedRequest>, thread::JoinHandle<()>) {
		let display_awake = Arc::new(DisplayAwake::default());
		let (tx, rx) = flume::unbounded();
		let serving = thread::spawn({
			let display_awake = Arc::clone(&display_awake);
			move || Worker { display_awake, ..unlocked_worker(backend) }.serve(&rx, grace)
		});
		(display_awake, tx, serving)
	}

	#[test]
	fn a_turn_keeps_the_display_awake_past_the_grace_until_it_ends() {
		let backend = FakeWaylandBackend::new();
		let awake = Arc::clone(&backend.awake);
		let grace = Duration::from_millis(100);
		let (turn, tx, serving) = serving_with_turns(backend, grace);

		turn.hold_until_released();
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		// The turn goes on without desktop work for many grace periods.
		thread::sleep(grace * 10);
		assert_eq!(*awake.lock(), [true], "the grace ended the turn's hold");

		turn.release_turn();
		assert_eq!(*awake.lock(), [true, false], "the turn's end released nothing");

		send_and_wait(&tx, |reply| Request::Close { reply });
		serving.join().unwrap();
		assert_eq!(*awake.lock(), [true, false]);
	}

	#[test]
	fn the_next_turn_holds_the_display_again_from_its_first_request() {
		let backend = FakeWaylandBackend::new();
		let awake = Arc::clone(&backend.awake);
		let grace = Duration::from_millis(100);
		let (turn, tx, serving) = serving_with_turns(backend, grace);

		turn.hold_until_released();
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		turn.release_turn();
		assert_eq!(*awake.lock(), [true, false]);

		// A turn that has not acted yet holds nothing.
		turn.hold_until_released();
		thread::sleep(grace * 3);
		assert_eq!(*awake.lock(), [true, false]);
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		thread::sleep(grace * 10);
		assert_eq!(*awake.lock(), [true, false, true], "the next turn's hold ended before the turn");
		turn.release_turn();
		assert_eq!(*awake.lock(), [true, false, true, false]);

		send_and_wait(&tx, |reply| Request::Close { reply });
		serving.join().unwrap();
	}

	#[test]
	fn activity_after_a_turn_ends_is_held_only_for_the_grace() {
		let backend = FakeWaylandBackend::new();
		let awake = Arc::clone(&backend.awake);
		let (turn, tx, serving) = serving_with_turns(backend, Duration::from_millis(100));

		turn.hold_until_released();
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		turn.release_turn();
		// Work that outlives its turn, such as a background job.
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		wait_for_awake(&awake, &[true, false, true, false]);

		send_and_wait(&tx, |reply| Request::Close { reply });
		serving.join().unwrap();
	}

	#[test]
	fn a_turn_end_leaves_the_grace_of_activity_outside_a_turn() {
		let backend = FakeWaylandBackend::new();
		let awake = Arc::clone(&backend.awake);
		let (turn, tx, serving) = serving_with_turns(backend, Duration::from_millis(300));

		// A background job acts between turns; a later turn's run makes no
		// request, and the turn ends.
		send_and_wait(&tx, |reply| Request::ListWindows { reply });
		turn.hold_until_released();
		turn.release_turn();
		assert_eq!(*awake.lock(), [true], "the turn's end cut the grace short");
		wait_for_awake(&awake, &[true, false]);

		send_and_wait(&tx, |reply| Request::Close { reply });
		serving.join().unwrap();
	}

	/// Logs the release of the fake display-awake assertion.
	struct FakeAwakeHold(Arc<Mutex<Vec<bool>>>);

	impl Drop for FakeAwakeHold {
		fn drop(&mut self) {
			self.0.lock().push(false);
		}
	}

	/// A backend whose window listings report entry on the returned receiver,
	/// then block until the returned sender drops.
	fn hanging_backend() -> (FakeWaylandBackend, flume::Receiver<()>, flume::Sender<()>) {
		let (entered_tx, entered) = flume::unbounded();
		let (unblock, hang) = flume::bounded(0);
		let mut backend = FakeWaylandBackend::new();
		backend.hang_windows = Some((entered_tx, hang));
		(backend, entered, unblock)
	}

	/// How long a test session waits for a hung request before its call gives
	/// up.
	const HUNG_CALL_TIMEOUT: Duration = Duration::from_secs(1);

	/// A session serving `backend` with an hour's grace, so while a request
	/// hangs only the session giving up can release the display.
	fn session_serving(backend: FakeWaylandBackend) -> Arc<SessionCore> {
		let core = SessionCore::with_operation_timeout(
			DisplaySelector::Active,
			Arc::default(),
			HUNG_CALL_TIMEOUT,
		);
		let display_awake = Arc::clone(&core.display_awake);
		let (tx, rx) = flume::unbounded();
		let (done_tx, done) = flume::bounded(1);
		let join = thread::spawn(move || {
			let mut worker = unlocked_worker(backend);
			worker.display_awake = display_awake;
			worker.serve(&rx, Duration::from_secs(3600));
			let _ = done_tx.send(());
		});
		let mut lifecycle = core.lifecycle.lock();
		lifecycle.tx = Some(tx);
		lifecycle.done = Some(done);
		lifecycle.join = Some(join);
		drop(lifecycle);
		core
	}

	/// Queues a window listing without waiting for its reply; returns the
	/// queue and the reply's receiver, which keeps its caller waiting.
	fn queue_listing(
		core: &SessionCore,
	) -> (flume::Sender<QueuedRequest>, flume::Receiver<CoreResult<Response>>) {
		let tx = core.lifecycle.lock().tx.clone().unwrap();
		let (reply, pending) = flume::bounded(1);
		tx.send(QueuedRequest {
			request: Request::ListWindows { reply },
			token:   core.cancellation.token(),
		})
		.unwrap();
		(tx, pending)
	}

	#[test]
	fn a_timed_out_call_releases_the_display_while_its_request_hangs() {
		let (backend, _entered, unblock) = hanging_backend();
		let awake = Arc::clone(&backend.awake);
		let core = session_serving(backend);
		let error = core
			.call(core.cancellation.token(), |reply| Request::ListWindows { reply })
			.err()
			.unwrap();
		assert_eq!(error.code, ErrorCode::Timeout);
		assert_eq!(*awake.lock(), [true, false], "the caller's timeout releases the hold");
		drop(unblock);
		core.close().unwrap();
		assert_eq!(*awake.lock(), [true, false], "the late return neither holds nor releases again");
	}

	#[test]
	fn a_timeout_cancels_and_releases_the_display_in_one_step() {
		let (backend, entered, unblock) = hanging_backend();
		let awake = Arc::clone(&backend.awake);
		let core = session_serving(backend);
		let before = core.cancellation.token();
		let caller = thread::spawn({
			let core = Arc::clone(&core);
			move || core.call(core.cancellation.token(), |reply| Request::ListWindows { reply })
		});
		entered.recv_timeout(Duration::from_secs(5)).unwrap();
		// The hung request already holds the display; holding the hold's lock
		// parks the caller's timeout at it.
		let held = core.display_awake.0.lock();
		thread::sleep(HUNG_CALL_TIMEOUT + Duration::from_millis(500));
		assert!(before.check().is_ok(), "the timeout cancelled outside the hold's lock");
		drop(held);
		assert_eq!(caller.join().unwrap().err().unwrap().code, ErrorCode::Timeout);
		assert!(before.check().is_err());
		assert_eq!(*awake.lock(), [true, false]);
		drop(unblock);
		core.close().unwrap();
	}

	#[test]
	fn close_releases_the_display_while_a_request_hangs() {
		let (backend, entered, unblock) = hanging_backend();
		let awake = Arc::clone(&backend.awake);
		let core = session_serving(backend);
		let (_tx, _pending) = queue_listing(&core);
		entered.recv_timeout(Duration::from_secs(5)).unwrap();
		assert_eq!(core.close().err().unwrap().code, ErrorCode::Timeout);
		assert_eq!(*awake.lock(), [true, false], "close releases the hold");
		drop(unblock);
		let join = core.lifecycle.lock().join.take().unwrap();
		join.join().unwrap();
		assert_eq!(*awake.lock(), [true, false], "the late return neither holds nor releases again");
	}

	#[test]
	fn no_request_starts_once_close_has_begun() {
		let backend = FakeWaylandBackend::new();
		let awake = Arc::clone(&backend.awake);
		let core = session_serving(backend);
		// Holding the display lock parks close() at its cancel; it must
		// already hold the lifecycle with the session marked closed.
		let held = core.display_awake.0.lock();
		let closing = thread::spawn({
			let core = Arc::clone(&core);
			move || core.close()
		});
		let deadline = Instant::now() + Duration::from_secs(5);
		while core
			.lifecycle
			.try_lock()
			.is_some_and(|lifecycle| !lifecycle.closed)
		{
			assert!(Instant::now() < deadline, "close reached its cancel before closing the session");
			thread::yield_now();
		}
		let caller = thread::spawn({
			let core = Arc::clone(&core);
			move || core.call(core.cancellation.token(), |reply| Request::ListWindows { reply })
		});
		thread::sleep(Duration::from_millis(200));
		drop(held);
		closing.join().unwrap().unwrap();
		let error = caller
			.join()
			.unwrap()
			.err()
			.expect("a request started after close began");
		assert_eq!(error.code, ErrorCode::Closed);
		assert!(awake.lock().is_empty(), "nothing held the display after close began");
	}

	#[test]
	fn a_request_queued_behind_a_hung_one_never_holds_the_display_once_its_caller_gave_up() {
		let (backend, entered, unblock) = hanging_backend();
		let awake = Arc::clone(&backend.awake);
		let core = session_serving(backend);
		let (tx, _pending) = queue_listing(&core);
		entered.recv_timeout(Duration::from_secs(5)).unwrap();
		let error = core
			.call(core.cancellation.token(), |reply| Request::ListWindows { reply })
			.err()
			.unwrap();
		assert_eq!(error.code, ErrorCode::Timeout);
		assert_eq!(*awake.lock(), [true, false]);
		drop(unblock);
		// Served after the abandoned request, so its reply means that one ran.
		send_and_wait(&tx, |reply| Request::Capabilities { reply });
		assert_eq!(*awake.lock(), [true, false], "the abandoned request does not hold the display");
		core
			.call(core.cancellation.token(), |reply| Request::ListWindows { reply })
			.unwrap();
		assert_eq!(*awake.lock(), [true, false, true], "a fresh request holds it again");
		core.close().unwrap();
		assert_eq!(*awake.lock(), [true, false, true, false]);
	}

	fn locked_capture_and_failure(screen: ScreenState) -> (bool, DesktopError) {
		let backend = FakeWaylandBackend::new();
		*backend.screen.lock() = screen;
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let Ok(Response::Capture(capture)) =
			worker.process(&capture_request(Target::Window(WAYLAND_ID.to_string())), &token)
		else {
			panic!("window capture");
		};
		// No frame for the desktop target yet, so the zoom fails. A zoom needs
		// no input lease, so the frame error is not preempted by the host
		// refusing input (e.g. no X11 Escape monitor on a headless Linux host).
		let (reply, rx) = flume::bounded(1);
		worker.dispatch(
			Request::CaptureRegion {
				target: Target::Desktop,
				region: CaptureRegion { x: 0.0, y: 0.0, width: 1.0, height: 1.0 },
				caps: CaptureCaps::default(),
				reply,
			},
			&token,
		);
		let Err(error) = rx.recv().unwrap() else {
			panic!("zoom without a frame must fail")
		};
		(capture.screen_locked, error)
	}

	#[test]
	fn a_failure_on_one_display_reads_that_displays_sleep_state() {
		let backend = FakeWaylandBackend::new();
		*backend.screen.lock() = ScreenState { locked: false, display_asleep: true };
		let displays = Arc::clone(&backend.screen_displays);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let (reply, rx) = flume::bounded(1);
		worker.dispatch(
			Request::Click {
				target: Target::Display("display:2".to_string()),
				x: 1.0,
				y: 1.0,
				options: ParsedPointerOptions::parse(None).unwrap(),
				reply,
			},
			&token,
		);
		let Err(error) = rx.recv().unwrap() else {
			panic!("click without a frame must fail")
		};
		assert!(error.message.ends_with(" (the display is asleep)"), "{}", error.message);
		assert_eq!(
			displays.lock().last(),
			Some(&Some(format!("{:?}", DisplaySelector::Id("2".into()))))
		);
	}

	#[test]
	fn captures_and_failures_report_a_locked_screen() {
		let (locked, error) =
			locked_capture_and_failure(ScreenState { locked: true, display_asleep: false });
		assert!(locked, "the capture must carry the lock");
		assert_eq!(error.code, ErrorCode::InvalidCoordinateFrame, "the error code is unchanged");
		assert!(error.message.ends_with(" (the screen is locked)"), "{}", error.message);

		let (_, asleep) =
			locked_capture_and_failure(ScreenState { locked: true, display_asleep: true });
		assert!(
			asleep
				.message
				.ends_with(" (the screen is locked and the display is asleep)"),
			"{}",
			asleep.message
		);
	}

	#[test]
	fn a_frame_taken_while_locked_stays_marked_after_an_unlock_during_processing() {
		let backend = FakeWaylandBackend::new();
		*backend.screen.lock() = ScreenState { locked: true, display_asleep: false };
		let unlock = Arc::clone(&backend.unlock_on_layout);
		let screen = Arc::clone(&backend.screen);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		*unlock.lock() = true;
		let Ok(Response::Capture(full)) = worker.process(&capture_request(Target::Desktop), &token)
		else {
			panic!("desktop capture");
		};
		assert!(!screen.lock().locked, "the session unlocked after the frame");
		assert!(full.screen_locked, "the frame was taken behind the lock screen");
	}

	#[test]
	fn unlocked_captures_and_failures_carry_no_lock_note() {
		let (locked, error) = locked_capture_and_failure(ScreenState::default());
		assert!(!locked);
		assert!(!error.message.contains("locked"), "{}", error.message);
	}

	#[test]
	fn ax_click_targets_element_owner_despite_overlapping_or_snapshot_windows() {
		let backend = overlapping_backend();
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		// A desktop ref has no snapshot owner; a traversed ref can retain a
		// snapshot origin different from its live native window.
		click_reference(&mut worker, "desktop").expect("desktop element click");
		click_reference(&mut worker, "unrelated-overlay").expect("traversed element click");
		assert_eq!(*clicks.lock(), [WAYLAND_ID, WAYLAND_ID]);
	}

	#[test]
	fn ax_click_never_retargets_a_closed_owner_to_an_overlapping_window() {
		let mut backend = overlapping_backend();
		backend.window_present = false;
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let Err(error) = click_reference(&mut worker, WAYLAND_ID) else {
			panic!("closed element window must refuse input");
		};
		assert_eq!(error.code, ErrorCode::WindowNotFound);
		assert!(clicks.lock().is_empty(), "no input may reach the overlapping window");
	}

	/// A worker whose window holds one button per `(id, title)`, read once by
	/// `ax()`: the window is `e1` and the buttons `e2`, `e3`, … in order.
	fn read_buttons(buttons: &[(u64, &'static str)]) -> (TestWorker, Arc<Mutex<FakeTree>>) {
		let tree = Arc::new(Mutex::new(FakeTree {
			titles: buttons.iter().copied().collect(),
			children: buttons.iter().map(|(id, _)| *id).collect(),
			..FakeTree::default()
		}));
		let mut backend = FakeWaylandBackend::new();
		backend.tree = Some(Arc::clone(&tree));
		let mut worker = worker_with(backend);
		// The user-input watch names a real macOS element's app; these fake
		// elements have none, so the watch stays off.
		#[cfg(target_os = "macos")]
		{
			worker.listener = control::intervention::Listener::off();
		}
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.snapshot(&target, &AxSnapshotOptions::default())
			.unwrap();
		(worker, tree)
	}

	/// The app destroys `old` and puts `buttons` in the window instead.
	fn rebuild(tree: &Mutex<FakeTree>, old: u64, buttons: &[(u64, &'static str)]) {
		let mut tree = tree.lock();
		tree.destroyed.insert(old);
		tree.titles.extend(buttons.iter().copied());
		tree.children = buttons.iter().map(|(id, _)| *id).collect();
	}

	/// A source holding this process's input ownership as `acquireControl()`
	/// grants it, without the Escape monitor a test host may refuse.
	fn granted() -> CancellationSource {
		let source = CancellationSource::default();
		control::grant_for_test(&source);
		source
	}

	/// Runs the request `make` builds under a fresh token of `source`, as the
	/// worker serves it.
	fn call(
		worker: &mut Worker,
		make: impl FnOnce(Reply) -> Request,
		source: &CancellationSource,
	) -> CoreResult<Response> {
		let (reply, _rx) = flume::bounded(1);
		worker.execute(&make(reply), &source.token())
	}

	fn press_request(reference: &str) -> impl FnOnce(Reply) -> Request {
		let reference = reference.to_string();
		move |reply| Request::AxPerform { reference, action: "press".to_string(), menu: None, reply }
	}

	fn press(worker: &mut Worker, reference: &str) -> CoreResult<()> {
		call(worker, press_request(reference), &granted()).map(drop)
	}

	/// The ref a `StaleRef` from `reference` names as the one element left
	/// with the fields `reference` was read with, if any.
	fn named(error: &DesktopError, reference: &str) -> Option<String> {
		assert_eq!(error.code, ErrorCode::StaleRef, "{}", error.message);
		let rest = error
			.message
			.strip_prefix(&format!("{reference} destroyed; "))?;
		rest.split_whitespace().next().map(str::to_string)
	}

	#[test]
	fn a_press_on_a_rebuilt_element_names_its_one_copy_and_presses_nothing() {
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		rebuild(&tree, 2, &[(4, "Go"), (3, "Stop")]);
		let error = press(&mut worker, "e2").unwrap_err();
		assert_eq!(named(&error, "e2").as_deref(), Some("e4"));
		assert!(tree.lock().pressed.is_empty());
		// The named ref works, and `e2` still names the destroyed element.
		press(&mut worker, "e4").unwrap();
		let error = press(&mut worker, "e2").unwrap_err();
		assert_eq!(named(&error, "e2").as_deref(), Some("e4"));
		assert_eq!(tree.lock().pressed, [4]);
	}

	#[test]
	fn an_unconfirmed_action_names_the_window_and_app_to_inspect_and_is_sent_once() {
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		tree.lock().unconfirmed = true;
		let error = press(&mut worker, "e2").unwrap_err();
		assert_eq!(error.code, ErrorCode::AxUnconfirmed);
		assert!(error.message.contains("before retrying"), "{}", error.message);
		assert!(
			error
				.message
				.contains(&format!("e2 is in window {WAYLAND_ID} of obsidian (\"Obsidian\")")),
			"{}",
			error.message
		);
		assert_eq!(tree.lock().pressed, [2]);
	}

	#[test]
	fn every_call_on_a_rebuilt_element_names_its_copy() {
		fn e2() -> String {
			"e2".to_string()
		}
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		rebuild(&tree, 2, &[(4, "Go"), (3, "Stop")]);
		let requests: [fn(Reply) -> Request; 10] = [
			|reply| Request::AxNode { reference: e2(), reply },
			|reply| Request::AxAttributes { reference: e2(), reply },
			|reply| Request::AxChildren { reference: e2(), reply },
			|reply| Request::AxParent { reference: e2(), reply },
			|reply| Request::AxPerform {
				reference: e2(),
				action: "press".to_string(),
				menu: None,
				reply,
			},
			|reply| Request::AxSetValue { reference: e2(), value: "Stop".to_string(), reply },
			|reply| Request::AxSelectText {
				reference: e2(),
				request: text_range::TextSelectRequest { text: "Go".to_string(), ..Default::default() },
				reply,
			},
			|reply| Request::AxInput {
				reference: e2(),
				input: ElementInput::Text("Stop".to_owned()),
				takeover: Takeover::new(None, None),
				reply,
			},
			|reply| Request::AxFocus { reference: e2(), reply },
			|reply| Request::AxClick {
				reference: e2(),
				options: ParsedPointerOptions::parse(None).unwrap(),
				reply,
			},
		];
		for make in requests {
			let error = call(&mut worker, make, &granted())
				.err()
				.expect("the element is gone");
			assert_eq!(named(&error, "e2").as_deref(), Some("e4"));
		}
		assert!(tree.lock().pressed.is_empty());
	}

	#[test]
	fn a_rebuilt_element_with_two_identical_copies_names_neither() {
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		rebuild(&tree, 2, &[(4, "Go"), (5, "Go"), (3, "Stop")]);
		assert_eq!(named(&press(&mut worker, "e2").unwrap_err(), "e2"), None);
		assert!(tree.lock().pressed.is_empty());
	}

	#[test]
	fn an_element_that_had_a_twin_when_read_names_nothing() {
		// The other "Go" may be the one left, not a copy of the destroyed one.
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Go")]);
		rebuild(&tree, 2, &[(3, "Go")]);
		assert_eq!(named(&press(&mut worker, "e2").unwrap_err(), "e2"), None);
		assert!(tree.lock().pressed.is_empty());
		// Its ref has no fields that tell it apart, so nothing probed it.
		assert_eq!(tree.lock().probes, 0);
	}

	#[test]
	fn a_changed_or_removed_element_names_nothing() {
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		rebuild(&tree, 2, &[(4, "Going"), (3, "Stop")]);
		assert_eq!(named(&press(&mut worker, "e2").unwrap_err(), "e2"), None);
		rebuild(&tree, 4, &[(3, "Stop")]);
		assert_eq!(named(&press(&mut worker, "e2").unwrap_err(), "e2"), None);
		assert!(tree.lock().pressed.is_empty());
	}

	#[test]
	fn a_press_that_destroys_its_element_is_sent_once() {
		// The press may have acted before the app rebuilt the button.
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		tree.lock().press_rebuilds_as = Some(4);
		let error = press(&mut worker, "e2").unwrap_err();
		assert_eq!(named(&error, "e2").as_deref(), Some("e4"));
		assert_eq!(tree.lock().pressed, [2]);
	}

	#[test]
	fn only_a_stale_ref_read_with_telling_fields_probes_its_element() {
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		// A call that succeeds never probes.
		press(&mut worker, "e2").unwrap();
		assert_eq!(tree.lock().probes, 0);
		// A stale answer for an element still there names nothing.
		tree.lock().stale_presses = true;
		assert_eq!(named(&press(&mut worker, "e2").unwrap_err(), "e2"), None);
		assert_eq!(tree.lock().probes, 1);
		tree.lock().stale_presses = false;
		// A call cancelled while it ran neither probes nor searches.
		let source = granted();
		let canceller = source.clone();
		{
			let mut tree = tree.lock();
			tree.press_rebuilds_as = Some(4);
			tree.on_call = Some(Box::new(move |_| canceller.cancel()));
		}
		let error = call(&mut worker, press_request("e2"), &source)
			.err()
			.expect("the element is gone");
		assert_eq!(named(&error, "e2"), None);
		assert_eq!(tree.lock().pressed, [2, 2, 2]);
		assert_eq!(tree.lock().probes, 1);
	}

	#[test]
	fn a_menu_read_holds_the_input_lease() {
		let source = CancellationSource::default();
		// Whether another call of the session could take input during the read.
		let free = Arc::new(AtomicBool::new(true));
		let (other, seen) = (source.clone(), Arc::clone(&free));
		let mut backend = FakeWaylandBackend::new();
		backend.on_menu_read = Some(Box::new(move || {
			seen.store(InputLease::acquire(&other.token(), false).is_ok(), Ordering::SeqCst);
		}));
		// The worker holds the ownership tests' lock, which the grant needs.
		let mut worker = worker_with(backend);
		control::grant_for_test(&source);
		let target = Target::Window(WAYLAND_ID.to_string());
		call(&mut worker, |reply| Request::MenuItems { target, path: Vec::new(), reply }, &source)
			.unwrap();
		assert!(!free.load(Ordering::SeqCst), "the menu read ran without the input lease");
	}

	#[test]
	fn a_menu_read_cancelled_while_it_reads_is_discarded() {
		let source = CancellationSource::default();
		let canceller = source.clone();
		let mut backend = FakeWaylandBackend::new();
		backend.on_menu_read = Some(Box::new(move || canceller.cancel()));
		let mut worker = worker_with(backend);
		control::grant_for_test(&source);
		let target = Target::Window(WAYLAND_ID.to_string());
		let read = |reply| Request::MenuItems { target, path: Vec::new(), reply };
		let error = call(&mut worker, read, &source)
			.err()
			.map(|error| error.code);
		assert_eq!(error, Some(ErrorCode::Cancelled));
	}

	#[test]
	fn a_stale_ref_search_runs_with_input_released() {
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop")]);
		rebuild(&tree, 2, &[(4, "Go"), (3, "Stop")]);
		let source = granted();
		// Whether another call of the session could take input during the search.
		let free = Arc::new(AtomicBool::new(false));
		let (other, seen) = (source.clone(), Arc::clone(&free));
		tree.lock().on_call = Some(Box::new(move |_| {
			seen.store(InputLease::acquire(&other.token(), false).is_ok(), Ordering::SeqCst);
		}));
		let error = call(&mut worker, press_request("e2"), &source)
			.err()
			.expect("the element is gone");
		assert_eq!(named(&error, "e2").as_deref(), Some("e4"));
		assert!(free.load(Ordering::SeqCst), "the search held the call's input lease");
	}

	#[test]
	fn a_cancel_during_a_stale_ref_search_stops_its_walk() {
		let (mut worker, tree) = read_buttons(&[(2, "Go"), (3, "Stop"), (5, "Next")]);
		rebuild(&tree, 2, &[(4, "Go"), (3, "Stop"), (5, "Next")]);
		let source = granted();
		let canceller = source.clone();
		tree.lock().on_call = Some(Box::new(move |_| canceller.cancel()));
		let reads = tree.lock().reads;
		let error = call(&mut worker, press_request("e2"), &source)
			.err()
			.expect("the element is gone");
		assert_eq!(named(&error, "e2"), None);
		assert_eq!(tree.lock().probes, 1);
		assert_eq!(tree.lock().reads, reads, "the walk read on after the cancel");
	}

	#[test]
	fn element_calls_leave_the_elements_window_to_the_backend() {
		// macOS reads the user's front app before it asks the element's
		// application for its bounds or window, which blocks while that app is
		// busy; a window listing or lookup here would come before that read.
		let requests: [fn(String, Reply) -> Request; 2] = [
			|reference, reply| Request::AxInput {
				reference,
				input: ElementInput::Text("4".to_owned()),
				takeover: Takeover::new(None, None),
				reply,
			},
			|reference, reply| Request::AxClick {
				reference,
				options: ParsedPointerOptions::parse(None).unwrap(),
				reply,
			},
		];
		for make in requests {
			let backend = FakeWaylandBackend::new();
			let queries = Arc::clone(&backend.window_queries);
			let seen = Arc::clone(&backend.queries_at_input);
			let mut worker = worker_with(backend);
			let inner: &mut Worker = &mut worker;
			let (backend, registry) = (&mut inner.backend, &mut inner.registry);
			let ax = backend
				.as_mut()
				.ok()
				.and_then(|backend| backend.ax())
				.unwrap();
			let reference =
				register_node(ax, registry, WAYLAND_ID, AxHandle::Test(1), &mut AppFocus::default())
					.unwrap()
					.ref_;
			let (reply, _rx) = flume::bounded(1);
			let request = make(reference, reply);
			let before = *queries.lock();
			let _ = worker.process(&request, &CancellationSource::default().token());
			assert_eq!(*seen.lock(), [before], "the worker listed windows before the backend ran");
		}
	}

	#[test]
	fn element_click_without_bounds_names_its_ref() {
		let mut backend = FakeWaylandBackend::new();
		backend.no_bounds = true;
		let mut worker = worker_with(backend);
		let inner: &mut Worker = &mut worker;
		let (backend, registry) = (&mut inner.backend, &mut inner.registry);
		let ax = backend
			.as_mut()
			.ok()
			.and_then(|backend| backend.ax())
			.unwrap();
		let reference =
			register_node(ax, registry, WAYLAND_ID, AxHandle::Test(1), &mut AppFocus::default())
				.unwrap()
				.ref_;
		let (reply, _rx) = flume::bounded(1);
		let request = Request::AxClick {
			reference: reference.clone(),
			options: ParsedPointerOptions::parse(None).unwrap(),
			reply,
		};
		let Err(error) = worker.process(&request, &CancellationSource::default().token()) else {
			panic!("a click on an element without bounds went out");
		};
		assert_eq!(error.code, ErrorCode::AxFailed);
		assert_eq!(error.message, format!("{reference} has no clickable bounds"));
	}

	#[test]
	fn element_keys_refused_for_focus_name_where_focus_is_with_a_usable_ref() {
		for (takeover, code) in
			[(None, ErrorCode::BackgroundUnavailable), (Some(true), ErrorCode::InputFailed)]
		{
			let mut worker = worker_with(FakeWaylandBackend::new());
			let inner: &mut Worker = &mut worker;
			let (backend, registry) = (&mut inner.backend, &mut inner.registry);
			let ax = backend
				.as_mut()
				.ok()
				.and_then(|backend| backend.ax())
				.unwrap();
			let reference =
				register_node(ax, registry, WAYLAND_ID, AxHandle::Test(1), &mut AppFocus::default())
					.unwrap()
					.ref_;
			let (reply, _rx) = flume::bounded(1);
			let request = Request::AxInput {
				reference: reference.clone(),
				input: ElementInput::Text("4".to_owned()),
				takeover: Takeover::new(takeover, None),
				reply,
			};
			let Err(error) = worker.process(&request, &CancellationSource::default().token()) else {
				panic!("keys for an element without focus must be refused");
			};
			assert_eq!(error.code, code);
			let message = &error.message;
			assert!(
				message.starts_with(&format!("{reference} did not take keyboard focus")),
				"{message}"
			);
			// The focus request itself went to the app, so only keys are unsent.
			assert!(message.contains("so no keys were sent"), "{message}");
			assert!(message.contains(&format!("window {WAYLAND_ID} (\"Obsidian\")")), "{message}");
			assert!(message.contains("on - button [ref=e2]."), "{message}");
			assert!(message.contains("win.ax()"), "{message}");
			assert!(worker.registry.resolve("e2").unwrap() == AxHandle::Test(7));
		}
	}

	#[test]
	fn refuse_menu_checks_a_background_click_before_anything_is_sent() {
		let mut backend = FakeWaylandBackend::new();
		backend.menu_control = true;
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		let event = PointerEvent::Click {
			x:         1.0,
			y:         1.0,
			button:    MouseButton::Left,
			count:     1,
			modifiers: backend::Modifiers::default(),
		};
		let mut click =
			|refuse_menu: Option<bool>, takeover: Option<bool>, menu: Option<Vec<String>>| {
				ParsedPointerOptions::parse(Some(PointerOptions {
					refuse_menu,
					takeover,
					menu,
					..PointerOptions::default()
				}))
				.unwrap()
				.click(
					worker.backend().unwrap().as_mut(),
					&target,
					event.clone(),
					&FrameGeometry::identity_global(),
					&token,
				)
			};
		let refused = click(Some(true), None, None).expect_err("a click on a menu control refuses");
		assert_eq!(refused.code, ErrorCode::BackgroundUnavailable);
		assert!(clicks.lock().is_empty(), "nothing may be sent before the refusal");
		// Without the option, in takeover, or with a menu path the click is sent
		// unchecked.
		click(None, None, None).expect("plain click");
		click(Some(true), Some(true), None).expect("takeover click");
		click(Some(true), None, Some(vec!["Large".to_string()])).expect("menu click");
		assert_eq!(*clicks.lock(), [
			WAYLAND_ID.to_string(),
			WAYLAND_ID.to_string(),
			format!("{WAYLAND_ID} menu Large"),
		]);
	}

	#[test]
	fn refuse_menu_checks_a_background_hold_and_drag_before_anything_is_sent() {
		let mut backend = FakeWaylandBackend::new();
		backend.menu_control = true;
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let hold = |refuse_menu: bool, takeover: Option<bool>| {
			let (reply, _rx) = flume::bounded(1);
			Request::HoldMouse {
				target: target.clone(),
				x: 1.0,
				y: 1.0,
				button: MouseButton::Left,
				keys: Vec::new(),
				duration: Duration::ZERO,
				takeover: Takeover::new(takeover, None),
				refuse_menu,
				reply,
			}
		};
		let drag = |refuse_menu: Option<bool>, takeover: Option<bool>| {
			let (reply, _rx) = flume::bounded(1);
			Request::Drag {
				target: target.clone(),
				path: vec![(1.0, 1.0), (2.0, 2.0)],
				options: ParsedPointerOptions::parse(Some(PointerOptions {
					refuse_menu,
					takeover,
					..PointerOptions::default()
				}))
				.unwrap(),
				reply,
			}
		};
		for request in [hold(true, None), drag(Some(true), None)] {
			let Err(refused) = worker.process(&request, &token) else {
				panic!("a press on a menu control refuses");
			};
			assert_eq!(refused.code, ErrorCode::BackgroundUnavailable);
		}
		assert!(clicks.lock().is_empty(), "nothing may be sent before the refusal");
		// Without the option or in takeover the hold and drag are sent unchecked.
		for request in
			[hold(false, None), hold(true, Some(true)), drag(None, None), drag(Some(true), Some(true))]
		{
			worker.process(&request, &token).expect("unchecked press");
		}
		assert_eq!(clicks.lock().len(), 4);
	}

	fn capture_request(target: Target) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::Capture { target, caps: CaptureCaps::default(), reply }
	}

	fn zoom_request(target: Target, region: CaptureRegion, caps: CaptureCaps) -> Request {
		let (reply, _rx) = flume::bounded(1);
		Request::CaptureRegion { target, region, caps, reply }
	}

	#[test]
	fn capture_refreshes_the_nonblocking_capabilities_snapshot() {
		let core = SessionCore::new(DisplaySelector::Active, Arc::default());
		let mut worker = worker_with(FakeWaylandBackend::new());
		worker.capabilities = Arc::clone(&core.capabilities);
		worker
			.process(&capture_request(Target::Desktop), &core.cancellation.token())
			.unwrap();
		core.in_flight.store(1, Ordering::Release);
		let session = DesktopSession { core };
		let capabilities = session.capabilities();
		assert_eq!(capabilities.backend, "wayland");
		assert!(capabilities.capture);
		assert!(
			session.core.lifecycle.lock().tx.is_none(),
			"a busy getter must return the snapshot without starting or querying a worker"
		);
	}

	#[test]
	fn screen_state_never_queues_behind_a_stuck_request() {
		let core = SessionCore::new(DisplaySelector::Active, Arc::default());
		// A worker that never serves its queue, with a request outstanding and
		// no capabilities snapshot: a queued read would wait out its timeout.
		let (tx, stuck) = flume::unbounded();
		core.lifecycle.lock().tx = Some(tx);
		core.in_flight.store(1, Ordering::Release);
		let session = DesktopSession { core };
		let _ = session.screen_state();
		assert!(stuck.is_empty(), "the screen-state read must not enter the worker queue");
	}

	#[test]
	fn cancelled_calls_never_start_the_worker_or_count_as_in_flight() {
		let core = SessionCore::new(DisplaySelector::Active, Arc::default());
		let token = core.cancellation.token();
		core.cancellation.cancel();
		assert_eq!(
			core
				.call(token, |reply| Request::ListWindows { reply })
				.err()
				.unwrap()
				.code,
			ErrorCode::Cancelled
		);
		assert_eq!(core.in_flight.load(Ordering::Acquire), 0);
		assert!(core.lifecycle.lock().tx.is_none());
	}

	#[test]
	fn failed_queue_delivery_releases_the_in_flight_count() {
		let core = SessionCore::new(DisplaySelector::Active, Arc::default());
		let (tx, rx) = flume::unbounded();
		core.lifecycle.lock().tx = Some(tx);
		drop(rx);
		assert!(
			core
				.call(core.cancellation.token(), |reply| Request::ListWindows { reply })
				.is_err()
		);
		assert_eq!(core.in_flight.load(Ordering::Acquire), 0);
	}

	#[test]
	fn zoom_uses_fresh_native_pixels_and_preserves_the_full_click_frame() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		let (reply, _rx) = flume::bounded(1);
		worker
			.process(
				&Request::Capture {
					target: target.clone(),
					caps: CaptureCaps { max_width: Some(32), max_height: None },
					reply,
				},
				&token,
			)
			.unwrap();
		let base = worker.frame(&target).unwrap();
		let region = CaptureRegion { x: 8.0, y: 6.0, width: 8.0, height: 6.0 };
		let Response::Capture(zoom) = worker
			.process(
				&zoom_request(target.clone(), region, CaptureCaps {
					max_width:  Some(8),
					max_height: None,
				}),
				&token,
			)
			.unwrap()
		else {
			panic!("expected zoom capture")
		};
		assert_eq!(*captures.lock(), 2, "zoom must capture again, not enlarge the old PNG");
		assert_eq!((zoom.source_width, zoom.source_height), (16, 12));
		assert_eq!((zoom.width, zoom.height), (8, 6));
		assert_eq!((zoom.coordinate_width, zoom.coordinate_height), (32, 24));
		assert_eq!(zoom.region, Some(region));
		assert_eq!(worker.frame(&target).unwrap(), base);
		assert_eq!(worker.map_point(&target, 16.0, 12.0).unwrap().0, 32.0);
	}

	#[test]
	fn zoom_rejects_missing_invalid_and_stale_frames_before_capture() {
		let backend = FakeWaylandBackend::new();
		let captures = Arc::clone(&backend.captures);
		let layout = Arc::clone(&backend.layout);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		let region = CaptureRegion { x: 0.0, y: 0.0, width: 8.0, height: 6.0 };
		let request = zoom_request(target.clone(), region, CaptureCaps::default());
		assert_eq!(
			worker.process(&request, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert_eq!(*captures.lock(), 0);
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		let invalid =
			zoom_request(target, CaptureRegion { x: f64::NAN, ..region }, CaptureCaps::default());
		assert_eq!(
			worker.process(&invalid, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		layout.lock()[0].scale = 2.0;
		assert_eq!(
			worker.process(&request, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert_eq!(*captures.lock(), 1, "invalid zoom must not reach the capture backend");
	}

	#[test]
	fn desktop_zoom_pins_captured_display_after_active_focus_changes() {
		let backend = FakeWaylandBackend::new();
		let mut other = backend.layout.lock()[0].clone();
		other.id = "screen-2".to_string();
		other.x = 64;
		other.is_primary = false;
		backend.layout.lock().push(other);
		let active = Arc::clone(&backend.active_display);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		worker
			.process(&capture_request(Target::Desktop), &token)
			.unwrap();
		*active.lock() = "screen-2".to_string();
		assert_eq!(worker.map_point(&Target::Desktop, 10.0, 10.0).unwrap().0, 10.0);
		let Response::Capture(zoom) = worker
			.process(
				&zoom_request(
					Target::Desktop,
					CaptureRegion { x: 0.0, y: 0.0, width: 8.0, height: 6.0 },
					CaptureCaps::default(),
				),
				&token,
			)
			.unwrap()
		else {
			panic!("expected desktop zoom")
		};
		assert_eq!(zoom.displays.len(), 1);
		assert_eq!(zoom.displays[0].id, "screen-1");
		assert_eq!(worker.map_point(&Target::Desktop, 10.0, 10.0).unwrap().0, 10.0);
	}

	#[test]
	fn changed_layout_rejects_pointer_and_drag_before_dispatch() {
		let backend = FakeWaylandBackend::new();
		let clicks = Arc::clone(&backend.clicks);
		let layout = Arc::clone(&backend.layout);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		worker
			.process(&capture_request(Target::Desktop), &token)
			.unwrap();
		layout.lock()[0].x += 10;
		let (reply, _rx) = flume::bounded(1);
		let click = Request::Click {
			target: Target::Desktop,
			x: 10.0,
			y: 10.0,
			options: ParsedPointerOptions::parse(None).unwrap(),
			reply,
		};
		assert_eq!(
			worker.process(&click, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		let (reply, _rx) = flume::bounded(1);
		let drag = Request::Drag {
			target: Target::Desktop,
			path: vec![(10.0, 10.0), (20.0, 20.0)],
			options: ParsedPointerOptions::parse(None).unwrap(),
			reply,
		};
		assert_eq!(
			worker.process(&drag, &token).err().unwrap().code,
			ErrorCode::InvalidCoordinateFrame
		);
		assert!(clicks.lock().is_empty());
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn input_into_an_app_the_user_used_since_the_last_read_fails_before_the_backend() {
		let backend = FakeWaylandBackend::new();
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		let click = || Request::Click {
			target:  target.clone(),
			x:       1.0,
			y:       1.0,
			options: ParsedPointerOptions::parse(None).unwrap(),
			reply:   flume::unbounded().0,
		};
		// The capture starts watching the window's app, process 1234.
		worker.dispatch(capture_request(target.clone()), &source.token());
		worker.listener.record_for_test(1234, Instant::now());
		// The run ends too soon to wait for the user to pause.
		source.set_deadline(Some(Instant::now()));
		let error = worker.execute(&click(), &source.token()).err().unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.contains("still using obsidian"), "{}", error.message);
		assert!(clicks.lock().is_empty());
		// A read before the user has paused for 5 s does not show their input.
		let (reply, read) = flume::bounded(1);
		worker.dispatch(
			Request::Capture { target: target.clone(), caps: CaptureCaps::default(), reply },
			&source.token(),
		);
		assert!(read.recv().unwrap().is_ok());
		assert_eq!(
			worker
				.execute(&click(), &source.token())
				.err()
				.unwrap()
				.code,
			ErrorCode::UserIntervened
		);
		// One after the pause does, and input is admitted again.
		worker.listener.record_for_test(
			1234,
			Instant::now()
				.checked_sub(Duration::from_secs(6))
				.expect("uptime past 6 s"),
		);
		let (reply, read) = flume::bounded(1);
		worker.dispatch(
			Request::Capture { target: target.clone(), caps: CaptureCaps::default(), reply },
			&source.token(),
		);
		assert!(read.recv().unwrap().is_ok());
		assert!(worker.watch_app(&click(), &source.token()).is_ok());
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn input_to_an_off_space_window_is_watched_without_listing_windows() {
		let backend = FakeWaylandBackend::new();
		let queries = Arc::clone(&backend.window_queries);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		worker.dispatch(capture_request(Target::Window(WAYLAND_ID.to_string())), &token);
		worker.listener.record_for_test(1234, Instant::now());
		let raise =
			|id: &str| Request::RaiseWindow { id: id.to_string(), reply: flume::unbounded().0 };
		// The off-Space window belongs to the app the user is typing in.
		let listed = *queries.lock();
		let error = worker
			.execute(&raise(OFF_SPACE_ID), &token.clone().replying_by(Instant::now()))
			.err()
			.unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(*queries.lock(), listed);
		// Input whose owner cannot be found is refused, not sent unwatched.
		assert_eq!(
			worker.execute(&raise("gone"), &token).err().unwrap().code,
			ErrorCode::WindowNotFound
		);
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn an_apps_name_and_a_windows_drawing_process_are_looked_up_once_however_often_it_is_used() {
		let backend = FakeWaylandBackend::new();
		let (names, drawers) =
			(Arc::clone(&backend.name_lookups), Arc::clone(&backend.input_lookups));
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		for _ in 0..3 {
			worker.dispatch(capture_request(target.clone()), &token);
		}
		assert_eq!(*names.lock(), 1);
		assert_eq!(*drawers.lock(), 1);
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn the_users_input_into_a_panel_another_process_draws_counts_from_the_first_read() {
		let mut backend = FakeWaylandBackend::new();
		// An Open panel, which process 4321 draws and takes input for.
		backend.drawn_by = Some(4321);
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker.dispatch(capture_request(target.clone()), &source.token());
		// The user clicks in the panel before the session's first input names
		// its drawing process.
		worker.listener.record_for_test(4321, Instant::now());
		source.set_deadline(Some(Instant::now()));
		let click = Request::Click {
			target,
			x: 1.0,
			y: 1.0,
			options: ParsedPointerOptions::parse(None).unwrap(),
			reply: flume::unbounded().0,
		};
		let error = worker.execute(&click, &source.token()).err().unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(clicks.lock().is_empty());
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn the_focused_elements_app_is_watched_from_the_read_that_found_it() {
		let backend = FakeWaylandBackend::new();
		let clicks = Arc::clone(&backend.clicks);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		// The fake's focused element is this test process's application.
		let (reply, read) = flume::bounded(1);
		worker.dispatch(Request::AxFocused { reply }, &source.token());
		let Ok(Response::Node(Some(node))) = read.recv().unwrap() else {
			panic!("expected the focused element");
		};
		// The user types into that app before the session acts on the ref.
		worker
			.listener
			.record_for_test(i32::try_from(std::process::id()).unwrap(), Instant::now());
		source.set_deadline(Some(Instant::now()));
		let click = Request::AxClick {
			reference: node.ref_.clone(),
			options:   ParsedPointerOptions::parse(None).unwrap(),
			reply:     flume::unbounded().0,
		};
		let error = worker.execute(&click, &source.token()).err().unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(clicks.lock().is_empty());
		// Nor are keys typed into the element.
		let typed = Request::AxInput {
			reference: node.ref_,
			input:     ElementInput::Text("hi".to_string()),
			takeover:  Takeover::new(None, None),
			reply:     flume::unbounded().0,
		};
		let error = worker.execute(&typed, &source.token()).err().unwrap();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.contains("still using"), "{}", error.message);
	}

	#[test]
	fn cancelled_full_capture_restores_previously_delivered_coordinates() {
		let backend = FakeWaylandBackend::new();
		let cancel_on_capabilities = Arc::clone(&backend.cancel_on_capabilities);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &source.token())
			.unwrap();
		let original = worker.frame(&target).unwrap();
		*cancel_on_capabilities.lock() = Some(source.clone());
		let (reply, _rx) = flume::bounded(1);
		let rejected = worker.execute(
			&Request::Capture {
				target: target.clone(),
				caps: CaptureCaps { max_width: Some(16), max_height: None },
				reply,
			},
			&source.token(),
		);
		assert_eq!(rejected.err().unwrap().code, ErrorCode::Cancelled);
		assert_eq!(worker.frame(&target).unwrap(), original);
		assert_eq!(worker.map_point(&target, 32.0, 24.0).unwrap().0, 32.0);
	}

	#[test]
	fn failed_observation_rolls_back_the_full_capture_frame() {
		let backend = FakeWaylandBackend::new();
		let fail = Arc::clone(&backend.snapshot_error);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &source.token())
			.unwrap();
		let original = worker.frame(&target).unwrap();
		*fail.lock() = true;
		let (reply, _rx) = flume::bounded(1);
		let request = Request::Observe {
			target: target.clone(),
			caps: CaptureCaps { max_width: Some(16), max_height: None },
			options: AxSnapshotOptions::default(),
			reply,
		};
		assert_eq!(
			worker
				.execute(&request, &source.token())
				.err()
				.unwrap()
				.code,
			ErrorCode::AxFailed
		);
		assert_eq!(worker.frame(&target).unwrap(), original);
		*fail.lock() = false;
		let Response::Observation(observation) = worker.execute(&request, &source.token()).unwrap()
		else {
			panic!("expected observation");
		};
		assert_eq!(observation.capture.coordinate_width, 16);
		assert_eq!(observation.accessibility.node_count, 1);
		assert_eq!(worker.frame(&target).unwrap().dimensions(), (16, 12));
	}

	#[test]
	fn cancellation_during_observation_accessibility_restores_delivered_frame() {
		let backend = FakeWaylandBackend::new();
		let cancel = Arc::clone(&backend.cancel_on_snapshot);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &source.token())
			.unwrap();
		let original = worker.frame(&target).unwrap();
		*cancel.lock() = Some(source.clone());
		let (reply, _) = flume::bounded(1);
		let request = Request::Observe {
			target: target.clone(),
			caps: CaptureCaps { max_width: Some(16), max_height: None },
			options: AxSnapshotOptions::default(),
			reply,
		};
		assert_eq!(
			worker
				.execute(&request, &source.token())
				.err()
				.unwrap()
				.code,
			ErrorCode::Cancelled
		);
		assert_eq!(worker.frame(&target).unwrap(), original);
		assert!(worker.execute(&request, &source.token()).is_ok());
	}

	#[test]
	fn a_shortcut_sent_before_a_cancel_reports_sent() {
		let backend = FakeWaylandBackend::new();
		let cancel = Arc::clone(&backend.cancel_after_chord);
		let modes = Arc::clone(&backend.modes);
		let mut worker = worker_with(backend);
		let source = granted();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &source.token())
			.unwrap();
		// The keys are out when the cancel lands, as in the reply wait.
		*cancel.lock() = Some(source.clone());
		let token = source.token();
		let (reply, _rx) = flume::bounded(1);
		let keys = parse_keys(&["cmd".to_string(), "s".to_string()]).unwrap();
		let takeover = Takeover::default();
		let chord = Request::KeyChord { target: target.clone(), keys, takeover, reply };
		assert!(matches!(worker.execute(&chord, &token), Ok(Response::Input(_))));
		assert_eq!(*modes.lock(), [DeliveryMode::Background]);
		// The cancel stops what was queued behind it.
		let error = worker.execute(&capture_request(target), &token).err();
		assert_eq!(error.map(|error| error.code), Some(ErrorCode::Cancelled));
	}

	#[test]
	fn abandoned_capture_and_observation_replies_never_commit_frames() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		// capture_request drops its receiver before dispatch.
		worker.dispatch(capture_request(target.clone()), &token);
		assert!(worker.frame(&target).is_err());
		worker
			.execute(&capture_request(target.clone()), &token)
			.unwrap();
		let original = worker.frame(&target).unwrap();
		let (reply, rx) = flume::bounded(0);
		drop(rx);
		worker.dispatch(
			Request::Observe {
				target: target.clone(),
				caps: CaptureCaps { max_width: Some(16), max_height: None },
				options: AxSnapshotOptions::default(),
				reply,
			},
			&token,
		);
		assert_eq!(worker.frame(&target).unwrap(), original);
		// Nor does an abandoned read show the user's input to later input.
		#[cfg(target_os = "macos")]
		{
			let click = Request::Click {
				target:  target.clone(),
				x:       1.0,
				y:       1.0,
				options: ParsedPointerOptions::parse(None).unwrap(),
				reply:   flume::unbounded().0,
			};
			worker.listener.record_for_test(
				1234,
				Instant::now()
					.checked_sub(Duration::from_secs(6))
					.expect("uptime past 6 s"),
			);
			worker.dispatch(capture_request(target.clone()), &token);
			assert_eq!(worker.execute(&click, &token).err().unwrap().code, ErrorCode::UserIntervened);
			let (reply, read) = flume::bounded(1);
			worker.dispatch(Request::Capture { target, caps: CaptureCaps::default(), reply }, &token);
			assert!(read.recv().unwrap().is_ok());
			assert!(worker.watch_app(&click, &token).is_ok());
		}
	}

	#[test]
	fn display_handles_isolate_frames_and_reject_off_display_keyboard_input() {
		let backend = FakeWaylandBackend::new();
		let mut other = backend.layout.lock()[0].clone();
		other.id = "screen-2".to_string();
		other.x = 64;
		other.is_primary = false;
		backend.layout.lock().push(other);
		let mut worker = worker_with(backend);
		let token = CancellationSource::default().token();
		let left = Target::parse("display:screen-1");
		let right = Target::parse("display:screen-2");
		worker
			.execute(&capture_request(left.clone()), &token)
			.unwrap();
		let original = worker.frame(&left).unwrap();
		worker
			.execute(&capture_request(right.clone()), &token)
			.unwrap();
		assert_eq!(worker.frame(&left).unwrap(), original);
		assert!(worker.frame(&Target::Desktop).is_err());
		assert_eq!(worker.map_point(&left, 10.0, 10.0).unwrap().0, 10.0);
		assert_eq!(worker.map_point(&right, 10.0, 10.0).unwrap().0, 74.0);
		assert!(worker.validate_keyboard_target(&left).is_ok());
		assert_eq!(
			worker.validate_keyboard_target(&right).unwrap_err().code,
			ErrorCode::InvalidTarget
		);
	}

	#[test]
	fn hold_duration_and_takeover_options_are_validated_without_losing_tristate() {
		for seconds in [f64::NAN, f64::INFINITY, -0.1, 100.1] {
			assert!(hold_duration(seconds).is_err());
		}
		assert_eq!(hold_duration(0.0).unwrap(), Duration::ZERO);
		assert_eq!(hold_duration(100.0).unwrap(), Duration::from_secs(100));
		let default = ParsedPointerOptions::parse(None).unwrap();
		assert_eq!(default.takeover.requested, None);
		assert_eq!(default.mode(), DeliveryMode::Background);
		for (takeover, return_focus, expected) in [
			(false, None, DeliveryMode::Background),
			(true, None, DeliveryMode::Foreground),
			(true, Some(false), DeliveryMode::Foreground),
			(true, Some(true), DeliveryMode::ForegroundReturnFocus),
			// Returning focus never turns background input into a takeover.
			(false, Some(true), DeliveryMode::Background),
		] {
			let options = ParsedPointerOptions::parse(Some(PointerOptions {
				takeover: Some(takeover),
				return_focus,
				..PointerOptions::default()
			}))
			.unwrap();
			assert_eq!(options.takeover.requested, Some(takeover));
			assert_eq!(options.mode(), expected);
		}
	}

	#[test]
	fn held_control_leaves_omitted_takeover_in_the_background() {
		// Holding control takes this process's one input ownership, which the
		// other worker tests here take to send input, so the test runs alone in
		// a child test process.
		const ALONE: &str = "PI_DESKTOP_TEST_ALONE";
		if std::env::var_os(ALONE).is_none() {
			let output = std::process::Command::new(std::env::current_exe().expect("test binary"))
				.args([
					"--exact",
					"desktop::capture_tests::held_control_leaves_omitted_takeover_in_the_background",
				])
				.env(ALONE, "1")
				.output()
				.expect("child test");
			let stdout = String::from_utf8_lossy(&output.stdout);
			assert!(output.status.success() && stdout.contains(" 1 passed;"), "{stdout}");
			return;
		}
		let backend = FakeWaylandBackend::new();
		let modes = Arc::clone(&backend.modes);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		control::grant_for_test(&source);
		assert!(source.control_active());
		let token = source.token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.process(&capture_request(target.clone()), &token)
			.unwrap();
		for takeover in [None, Some(true)] {
			let options = ParsedPointerOptions::parse(Some(PointerOptions {
				takeover,
				..PointerOptions::default()
			}))
			.unwrap();
			let takeover = options.takeover;
			let (reply, _rx) = flume::bounded(1);
			let click = Request::Click { target: target.clone(), x: 10.0, y: 10.0, options, reply };
			worker.process(&click, &token).unwrap();
			let (reply, _rx) = flume::bounded(1);
			let text = "a".to_string();
			let typed = Request::TypeText { target: target.clone(), text, takeover, reply };
			worker.process(&typed, &token).unwrap();
			let (reply, _rx) = flume::bounded(1);
			let keys = parse_keys(&["a".to_string()]).unwrap();
			let chord = Request::KeyChord { target: target.clone(), keys, takeover, reply };
			worker.process(&chord, &token).unwrap();
			let (reply, _rx) = flume::bounded(1);
			let hover =
				Request::MoveMouse { target: target.clone(), x: 10.0, y: 10.0, takeover, reply };
			worker.process(&hover, &token).unwrap();
		}
		source.release_control();
		let (background, foreground) = (DeliveryMode::Background, DeliveryMode::Foreground);
		assert_eq!(*modes.lock(), [
			background, background, background, background, foreground, foreground, foreground,
			foreground
		]);
	}

	/// A raise takes the user's foreground, so the worker serves it under the
	/// physical-Escape stop; a press stays background input the user's Escape
	/// leaves alone. Tests start no event tap, so a takeover lease is refused
	/// after arming, as it is without the permission.
	#[cfg(target_os = "macos")]
	#[test]
	fn a_raise_runs_under_the_escape_stop_and_a_press_does_not() {
		let (mut worker, tree) = read_buttons(&[(2, "Go")]);
		control::press_escape_for_test();
		let perform = |action: &'static str| {
			move |reply| Request::AxPerform {
				reference: "e2".to_string(),
				action: action.to_string(),
				menu: None,
				reply,
			}
		};
		for action in ["press", "AXPress"] {
			let source = CancellationSource::default();
			let result = call(&mut worker, perform(action), &source);
			assert!(
				result
					.as_ref()
					.err()
					.is_none_or(|error| error.code != ErrorCode::PermissionDenied),
				"{action} needs no Escape stop"
			);
			let token = source.token();
			assert_eq!(control::press_escape_for_test(), 0, "{action} arms no Escape stop");
			assert!(token.check().is_ok(), "the user's Escape leaves {action} running");
		}
		assert_eq!(tree.lock().pressed, [2], "the fake tree runs only `press`");
		// macOS runs any spelling of AXRaise, `axraise` included.
		for action in ["raise", " Raise ", "AXRaise", "axraise", "AxRaise"] {
			let source = CancellationSource::default();
			let error = call(&mut worker, perform(action), &source)
				.err()
				.expect("no Escape stop starts in tests");
			assert_eq!(error.code, ErrorCode::PermissionDenied, "{action}");
			let token = source.token();
			assert_eq!(control::press_escape_for_test(), 1, "{action} arms the Escape stop");
			assert!(token.check().is_err(), "physical Escape stops {action}");
		}
	}

	/// Background input runs without the physical-Escape stop; takeover input,
	/// desktop and display input, raises and activating launches run under it,
	/// so a physical Escape cancels them. Served through the worker against
	/// the test Escape monitor, which refuses a lease after arming it.
	#[cfg(target_os = "macos")]
	#[test]
	fn only_takeover_requests_run_under_the_physical_escape_stop() {
		let (mut worker, _tree) = read_buttons(&[(2, "Go")]);
		control::press_escape_for_test();
		let window = Target::Window("42".to_string());
		let reply = || flume::unbounded().0;
		let typing = |target: &Target, takeover| Request::TypeText {
			target:   target.clone(),
			text:     "abc".to_string(),
			takeover: Takeover::new(takeover, None),
			reply:    reply(),
		};
		let holding = |target: &Target, takeover| Request::HoldKeys {
			target:   target.clone(),
			keys:     parse_keys(&["shift".to_string()]).unwrap(),
			duration: Duration::ZERO,
			takeover: Takeover::new(takeover, None),
			reply:    reply(),
		};
		let clicking = |target: &Target, takeover| Request::Click {
			target:  target.clone(),
			x:       0.0,
			y:       0.0,
			options: ParsedPointerOptions::parse(Some(PointerOptions {
				takeover,
				..PointerOptions::default()
			}))
			.unwrap(),
			reply:   reply(),
		};
		let perform = |action: &str| Request::AxPerform {
			reference: "e1".to_string(),
			action:    action.to_string(),
			menu:      None,
			reply:     reply(),
		};
		let open = |activate| Request::OpenApplication {
			id:      "com.apple.TextEdit".to_string(),
			options: ApplicationOpenOptions { activate, ..Default::default() },
			reply:   reply(),
		};
		// Held keys reach the fake backend only as takeover, which the test
		// Escape monitor refuses before they are sent.
		let background = [
			typing(&window, None),
			typing(&window, Some(false)),
			clicking(&window, Some(false)),
			perform("AXPress"),
			perform("showMenu"),
			open(None),
			open(Some(false)),
		];
		for request in background {
			let source = CancellationSource::default();
			let result = worker.execute(&request, &source.token());
			assert!(
				result
					.err()
					.is_none_or(|error| error.code != ErrorCode::PermissionDenied),
				"background input needs no Escape stop"
			);
			let token = source.token();
			assert_eq!(control::press_escape_for_test(), 0, "background input arms no Escape stop");
			assert!(token.check().is_ok(), "the user's Escape leaves background input running");
		}
		let display = Target::parse("display:screen-1");
		let takeover = [
			typing(&window, Some(true)),
			holding(&window, Some(true)),
			clicking(&window, Some(true)),
			typing(&Target::Desktop, None),
			holding(&Target::Desktop, Some(false)),
			clicking(&display, None),
			Request::RaiseWindow { id: "42".to_string(), reply: reply() },
			perform("raise"),
			perform("AXRaise"),
			open(Some(true)),
			Request::OpenApplication {
				id:      "/tmp".to_string(),
				options: ApplicationOpenOptions { reveal: Some(true), ..Default::default() },
				reply:   reply(),
			},
		];
		for request in takeover {
			let source = CancellationSource::default();
			let error = worker
				.execute(&request, &source.token())
				.err()
				.expect("no Escape stop starts in tests");
			assert_eq!(
				error.code,
				ErrorCode::PermissionDenied,
				"takeover input needs the Escape stop"
			);
			let token = source.token();
			assert_eq!(control::press_escape_for_test(), 1, "takeover input arms the Escape stop");
			assert!(token.check().is_err(), "physical Escape stops takeover input");
		}
	}

	#[test]
	fn space_move_attempt_invalidates_the_window_coordinate_frame() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let token = CancellationSource::default().token();
		let target = Target::Window(WAYLAND_ID.to_string());
		worker
			.execute(&capture_request(target.clone()), &token)
			.unwrap();
		let (reply, _) = flume::bounded(1);
		assert_eq!(
			worker
				.process(&Request::BringToCurrentSpace { id: WAYLAND_ID.into(), reply }, &token)
				.err()
				.unwrap()
				.code,
			ErrorCode::SpaceUnsupported,
		);
		assert!(worker.frame(&target).is_err());
	}

	#[test]
	fn cancelled_queue_generation_never_runs_and_later_requests_recover() {
		let backend = FakeWaylandBackend::new();
		let queries = Arc::clone(&backend.window_queries);
		let mut worker = worker_with(backend);
		let source = CancellationSource::default();
		let (queue_tx, queue_rx) = flume::unbounded();
		let (reply, result) = flume::bounded(1);
		queue_tx
			.send(QueuedRequest { request: Request::ListWindows { reply }, token: source.token() })
			.unwrap_or_else(|_| panic!("queue unexpectedly disconnected"));
		source.cancel();
		let queued = queue_rx.recv().unwrap();
		let response = worker.execute(&queued.request, &queued.token);
		queued.request.reply(response);
		assert_eq!(result.recv().unwrap().err().unwrap().code, ErrorCode::Cancelled);
		assert_eq!(*queries.lock(), 0);
		let (reply, _rx) = flume::bounded(1);
		assert!(matches!(
			worker.execute(&Request::ListWindows { reply }, &source.token()),
			Ok(Response::Windows(_))
		));
		assert_eq!(*queries.lock(), 1);
	}

	/// Regression for #7701: a composite AT-SPI window id minted by the Wayland
	/// backend's own `windows()` must reach the backend, not be rejected by a
	/// `u64` pre-parse in the shared request path.
	#[test]
	fn capture_accepts_non_numeric_wayland_window_id() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let response = worker
			.process(
				&capture_request(Target::Window(WAYLAND_ID.to_string())),
				&CancellationSource::default().token(),
			)
			.expect("wayland window id should be accepted by capture");
		let Response::Capture(capture) = response else {
			panic!("expected a capture response");
		};
		assert_eq!(capture.target, WAYLAND_ID);
		assert_eq!(capture.width, 64);
		assert_eq!(capture.height, 48);
		assert_eq!(capture.backend, "wayland");
	}

	/// Unknown ids still fail — but as `WindowNotFound` from the backend lookup,
	/// never as an `InvalidTarget` pre-parse rejection of a non-`u64` id.
	#[test]
	fn capture_rejects_unknown_window_id_via_backend_lookup() {
		let mut worker = worker_with(FakeWaylandBackend::new());
		let Err(err) = worker.process(
			&capture_request(Target::Window("does-not-exist".to_string())),
			&CancellationSource::default().token(),
		) else {
			panic!("unknown window id should fail");
		};
		assert_eq!(err.code, ErrorCode::WindowNotFound);
	}
}
