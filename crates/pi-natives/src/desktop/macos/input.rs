use std::{
	ptr,
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use core_graphics::{
	display::CGDisplay,
	event::{
		CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
		ScrollEventUnit,
	},
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
	sys::{CGEventRef, CGEventSourceRef},
};
use foreign_types::ForeignType;
use xutf::graphemes_str;

use super::{
	super::{
		backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
		control,
		error::{CoreResult, DesktopError},
		keys::KeyName,
		types::{DesktopWindow, Target},
	},
	ax,
	capture::MacCapture,
	keymap::{Keymap, Keystroke},
	process::{self, RemoteScreen},
	skylight,
};

pub(super) struct MacInput {
	source: CGEventSource,
}
#[allow(
	clippy::non_send_fields_in_send_ty,
	reason = "CGEventSource is an immutable CF object; `&mut self` receivers serialize all posting"
)]
// SAFETY: Core Graphics event sources are immutable CF objects after setup,
// and all access through `MacInput` requires `&mut self`, so events are posted
// serially after ownership moves between threads.
unsafe impl Send for MacInput {}

impl MacInput {
	pub(super) fn new() -> CoreResult<Self> {
		Ok(Self { source: source()? })
	}

	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		match target {
			Target::Desktop | Target::Display(_) => global_pointer(&self.source, event),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, pid, &event)?;
						skylight::with_background_guard(pid, || {
							if process::remote_screen(pid) == Some(RemoteScreen::HidReports) {
								report_pointer(&self.source, pid, wid, &window, event)
							} else {
								background_pointer(&self.source, pid, wid, &window, event)
							}
						})
					},
					DeliveryMode::Foreground => {
						foreground_pointer(&self.source, &window, pid, wid, event)
					},
				}
			},
		}
	}

	/// Returns a notice when Screen Sharing may have received keys modified.
	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<Option<String>> {
		match target {
			Target::Desktop | Target::Display(_) => {
				let keys = typed_keys(text, local_strokes(), None)?;
				type_keys(&self.source, &keys, KEY_GAP, || Ok(()), post_global).map(|()| None)
			},
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				let remote = process::remote_screen(pid);
				if mode == DeliveryMode::Background
					&& remote.is_none()
					&& !process::is_terminal(pid)
					&& ax::insert_native_text(pid, wid, text)?
				{
					return Ok(None);
				}
				// The whole text is mapped before anything is posted, so a
				// character a remote screen cannot receive refuses cleanly.
				let keys = if remote.is_some() {
					let keymap = Keymap::current()?;
					typed_keys(text, |character| keymap.as_ref()?.stroke(character), remote)?
				} else {
					typed_keys(text, local_strokes(), None)?
				};
				let gap = key_gap(remote);
				match mode {
					DeliveryMode::Background => {
						let modified = modified_text(&keys);
						let mut watch =
							(remote == Some(RemoteScreen::KeyEvents)).then(ModifierWatch::physical);
						if watch.is_some() && !modified.is_empty() {
							return Err(keyboard_modifiers_refusal(
								&window,
								&format!("type {}", modified.join(" ")),
							));
						}
						let result = with_background_keyboard(&self.source, pid, wid, &window, || {
							type_keys(
								&self.source,
								&keys,
								gap,
								|| watch.as_mut().map_or(Ok(()), ModifierWatch::before_press),
								|event| skylight::post_keyboard(pid, event),
							)
						});
						watched(result, watch)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, |activated| {
						control::wait(first_key_settle(activated))?;
						if remote.is_some() {
							// A remote screen may read modifiers from the keyboard
							// state, which only bare key transitions at the HID tap
							// move. They post globally, so every press first
							// checks that the target still has focus.
							post_bare_keys(&bare_transitions(&keys), gap, || {
								skylight::require_front_window(pid, wid)
							})
						} else {
							// Stop rather than typing into a newly user-selected
							// app or window.
							type_keys(
								&self.source,
								&keys,
								gap,
								|| skylight::require_front_window(pid, wid),
								post_global,
							)
						}
					})
					.map(|()| None),
				}
			},
		}
	}

	/// Returns a notice when Screen Sharing may have received keys modified.
	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<Option<String>> {
		match target {
			Target::Desktop | Target::Display(_) => global_chord(&self.source, keys).map(|()| None),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				let remote = process::remote_screen(pid);
				let gap = key_gap(remote);
				match mode {
					DeliveryMode::Background => {
						let mut watch =
							(remote == Some(RemoteScreen::KeyEvents)).then(ModifierWatch::physical);
						if watch.is_some() && keys.iter().copied().any(KeyName::is_modifier) {
							return Err(keyboard_modifiers_refusal(&window, "press this shortcut"));
						}
						let result = with_background_keyboard(&self.source, pid, wid, &window, || {
							key_chord(&self.source, keys, gap, |event| {
								post_watched(watch.as_mut(), event, |event| {
									skylight::post_keyboard(pid, event)
								})
							})
						});
						watched(result, watch)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, |activated| {
						control::wait(first_key_settle(activated))?;
						key_chord(&self.source, keys, gap, |event| post_takeover_key(pid, wid, event))
					})
					.map(|()| None),
				}
			},
		}
	}
}

impl MacInput {
	/// Returns a notice when Screen Sharing may have received keys modified.
	pub(super) fn hold_keys(
		&self,
		target: &Target,
		keys: &[KeyName],
		duration: Duration,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<Option<String>> {
		for &key in keys {
			key_code(key)?;
		}
		match target {
			Target::Desktop | Target::Display(_) => {
				with_held_keys(&self.source, keys, KEY_GAP, post_global, || control::wait(duration))
					.map(|()| None)
			},
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				let remote = process::remote_screen(pid);
				let gap = key_gap(remote);
				match mode {
					DeliveryMode::Background => {
						let mut watch =
							(remote == Some(RemoteScreen::KeyEvents)).then(ModifierWatch::physical);
						if watch.is_some() && keys.iter().copied().any(KeyName::is_modifier) {
							return Err(keyboard_modifiers_refusal(&window, "hold these keys"));
						}
						let result = with_background_keyboard(&self.source, pid, wid, &window, || {
							with_held_keys(
								&self.source,
								keys,
								gap,
								|event| {
									post_watched(watch.as_mut(), event, |event| {
										skylight::post_keyboard(pid, event)
									})
								},
								|| control::wait(duration),
							)
						});
						watched(result, watch)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, |activated| {
						control::wait(first_key_settle(activated))?;
						with_held_keys(
							&self.source,
							keys,
							gap,
							|event| post_takeover_key(pid, wid, event),
							|| control::wait(duration),
						)
					})
					.map(|()| None),
				}
			},
		}
	}
}

/// Strokes for typing into a local application. Without a keyboard layout
/// the text goes out as event text, which local applications read.
fn local_strokes() -> impl Fn(char) -> Option<Keystroke> {
	let keymap = Keymap::current().ok().flatten();
	move |character| keymap.as_ref()?.stroke(character)
}

/// Posts `event` through `watch` when there is one.
fn post_watched<S: FnMut() -> ModifierSample>(
	watch: Option<&mut ModifierWatch<S>>,
	event: &CGEvent,
	post: impl FnOnce(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	match watch {
		Some(watch) => watch.post(event, post),
		None => post(event),
	}
}

fn window_identity(window: &DesktopWindow) -> CoreResult<(libc::pid_t, u32)> {
	let pid = window.pid.ok_or_else(|| {
		DesktopError::input_failed(format!("window {} has no owning process id", window.id))
	})?;
	let pid = i32::try_from(pid).map_err(|_| {
		DesktopError::input_failed(format!("window {} has an invalid process id", window.id))
	})?;
	let wid = window.id.parse::<u32>().map_err(|_| {
		DesktopError::invalid_target(format!("invalid macOS window id '{}'", window.id))
	})?;
	Ok((pid, wid))
}

/// Screen Sharing sends the remote computer the modifiers the physical
/// keyboard holds, which background input cannot set without shifting the
/// user's own typing.
fn keyboard_modifiers_refusal(window: &DesktopWindow, action: &str) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {} ({}) takes Shift, Option, Control and Command from the physical keyboard, so \
		 background input cannot hold them to {action}; nothing was sent; retry with takeover:true",
		window.id, window.app,
	))
}

/// The physical keyboard's modifier state, as Screen Sharing reads it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ModifierSample {
	/// Shift, Control, Option or Command is down, or Caps Lock is on.
	held:    bool,
	/// Modifier changes counted so far.
	changes: u32,
}

unsafe extern "C" {
	fn CGEventSourceFlagsState(state: i32) -> u64;
	fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
}

fn physical_modifiers() -> ModifierSample {
	let mask = (CGEventFlags::CGEventFlagAlphaShift
		| CGEventFlags::CGEventFlagShift
		| CGEventFlags::CGEventFlagControl
		| CGEventFlags::CGEventFlagAlternate
		| CGEventFlags::CGEventFlagCommand)
		.bits();
	let state = CGEventSourceStateID::HIDSystemState as i32;
	// SAFETY: Read-only queries of the HID system state (CGEventSource.h).
	let (flags, changes) = unsafe {
		(
			CGEventSourceFlagsState(state),
			CGEventSourceCounterForEventType(state, CGEventType::FlagsChanged as u32),
		)
	};
	ModifierSample { held: flags & mask != 0, changes }
}

/// Longest a background key into Screen Sharing waits for the user to let go
/// of a modifier.
const MODIFIER_WAIT: Duration = Duration::from_secs(1);
const MODIFIER_POLL: Duration = Duration::from_millis(2);

/// Screen Sharing gives each key it forwards the modifiers the physical
/// keyboard holds when it handles the key. Each background press there waits
/// until no modifier is down; a press is reported when a modifier was down or
/// changed between its check and the next press (or the end), the window in
/// which Screen Sharing reads it.
struct ModifierWatch<S> {
	sample:  S,
	wait:    Duration,
	presses: usize,
	open:    Option<(usize, u32)>,
	flagged: Vec<usize>,
}

impl ModifierWatch<fn() -> ModifierSample> {
	fn physical() -> Self {
		Self::new(physical_modifiers, MODIFIER_WAIT)
	}
}

impl<S: FnMut() -> ModifierSample> ModifierWatch<S> {
	const fn new(sample: S, wait: Duration) -> Self {
		Self { sample, wait, presses: 0, open: None, flagged: Vec::new() }
	}

	/// Posts `event`; a press first waits for the user's modifiers.
	fn post(
		&mut self,
		event: &CGEvent,
		post: impl FnOnce(&CGEvent) -> CoreResult<()>,
	) -> CoreResult<()> {
		post_guarded(event, || self.before_press(), post)
	}

	fn before_press(&mut self) -> CoreResult<()> {
		self.close();
		let deadline = Instant::now() + self.wait;
		let mut sample = (self.sample)();
		while sample.held {
			if Instant::now() >= deadline {
				return Err(DesktopError::background_unavailable(format!(
					"Screen Sharing adds the physical keyboard's modifiers to the keys it forwards, \
					 and Shift, Control, Option or Command stayed down (or Caps Lock is on) for {} ms; \
					 {} key press(es) were sent before this one; retry with takeover:true or when the \
					 keyboard is idle",
					self.wait.as_millis(),
					self.presses,
				)));
			}
			control::wait(MODIFIER_POLL)?;
			sample = (self.sample)();
		}
		self.presses += 1;
		self.open = Some((self.presses, sample.changes));
		Ok(())
	}

	fn close(&mut self) {
		if let Some((press, changes)) = self.open.take() {
			let sample = (self.sample)();
			if sample.held || sample.changes != changes {
				self.flagged.push(press);
			}
		}
	}

	/// The notice for keys that may have been received modified.
	fn finish(mut self) -> Option<String> {
		self.close();
		if self.flagged.is_empty() {
			return None;
		}
		let presses: Vec<String> = self.flagged.iter().map(ToString::to_string).collect();
		Some(format!(
			"warning: a physical modifier key was down or changed while key press(es) {} of {} were \
			 sent to Screen Sharing, which may have received them modified (capitals or shortcuts); \
			 check the remote screen",
			presses.join(", "),
			self.presses,
		))
	}
}

/// `result` of keys sent under `watch`, with its notice: returned on
/// success, appended to the error otherwise.
fn watched<S: FnMut() -> ModifierSample>(
	result: CoreResult<()>,
	watch: Option<ModifierWatch<S>>,
) -> CoreResult<Option<String>> {
	let notice = watch.and_then(ModifierWatch::finish);
	match result {
		Ok(()) => Ok(notice),
		Err(mut error) => {
			if let Some(notice) = notice {
				error.message.push_str("; ");
				error.message.push_str(&notice);
			}
			Err(error)
		},
	}
}

/// Why process-scoped background keystrokes could reach a window other than
/// the target.
#[derive(Debug, PartialEq, Eq)]
enum KeyboardConflict {
	/// The target is not among the process's accessibility windows, so no
	/// claim about its key status can be proven.
	Unmapped,
	/// Other windows of the process could be the key window.
	Siblings(usize),
}

/// Background keyboard delivery to window `wid`: inside the self-activation
/// guard, makes `wid` its application's key window, then runs `deliver`.
///
/// macOS posts key events to a *process*, which hands them to whichever window
/// it treats as key; unlike pointer events they carry no window id. When the
/// process has other windows that could be key, keys are sent only once the
/// application reports `wid` as its focused window. Candidates come from the
/// process's accessibility windows, not `WindowServer`'s list, which also holds
/// the per-window compositor surfaces of Chromium, Electron, and `WebKit` apps.
fn with_background_keyboard<T>(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	deliver: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	let conflict = ax::window_records(pid)
		.map_or(Some(KeyboardConflict::Unmapped), |records| keyboard_conflict(wid, &records));
	if conflict == Some(KeyboardConflict::Unmapped) {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} is not among its application's accessibility windows, so background \
			 keystrokes cannot be proven to reach it; retry with takeover:true or use ax actions",
		)));
	}
	skylight::with_background_guard(pid, || {
		make_key_in_background(source, pid, wid, window)?;
		if let Some(KeyboardConflict::Siblings(siblings)) = conflict
			&& !await_key_window(pid, wid)?
		{
			return Err(DesktopError::background_unavailable(format!(
				"window {wid} shares its application with {siblings} other window(s) and did not \
				 become its key window, so background keystrokes could reach another window; retry \
				 with takeover:true or use ax actions",
			)));
		}
		deliver()
	})
}

fn keyboard_conflict(wid: u32, records: &[ax::AxWindowRecord]) -> Option<KeyboardConflict> {
	if !records.iter().any(|record| record.id == wid) {
		return Some(KeyboardConflict::Unmapped);
	}
	// A minimized window cannot be key; an unreadable state could be.
	let siblings = records
		.iter()
		.filter(|record| record.id != wid && record.minimized != Some(true))
		.count();
	(siblings > 0).then_some(KeyboardConflict::Siblings(siblings))
}

const fn pointer_kind(event: &PointerEvent) -> &'static str {
	match event {
		PointerEvent::Click { .. } => "click",
		PointerEvent::Move { .. } => "pointer move",
		PointerEvent::Drag { .. } => "drag",
		PointerEvent::Hold { .. } => "mouse hold",
		PointerEvent::Scroll { .. } => "scroll",
	}
}

/// Refuses background pointer input the target is known to drop or misplace,
/// before anything is posted.
fn background_guard(
	window: &DesktopWindow,
	pid: libc::pid_t,
	event: &PointerEvent,
) -> CoreResult<()> {
	let refuse = |reason: &str| {
		Err(DesktopError::background_unavailable(format!(
			"window {} ({}) {reason}; retry with takeover:true or use ax actions",
			window.id, window.app,
		)))
	};
	let kind = pointer_kind(event);
	match event {
		PointerEvent::Hold { .. } => {
			return refuse("cannot establish reliable background held-button capture on macOS");
		},
		PointerEvent::Drag { .. } => {
			return refuse(
				"cannot receive a background drag: pid-routed events neither move the pointer nor \
				 establish the pointer capture a drag needs on macOS",
			);
		},
		PointerEvent::Click { modifiers, .. } if *modifiers != Modifiers::default() => {
			return refuse(
				"cannot receive a background modified click: pid-routed events cannot establish live \
				 modifier-key state on macOS",
			);
		},
		_ => {},
	}
	let app = window.app.to_ascii_lowercase();
	if process::is_chromium(pid)
		&& matches!(event, PointerEvent::Click { button: MouseButton::Right, .. })
	{
		return refuse("coerces synthetic background right-click events to left-clicks");
	}
	let canvas_or_game = ["blender", "unity", "godot", "unreal"]
		.iter()
		.any(|name| app.contains(name));
	if canvas_or_game {
		return refuse(
			format!("drops background {kind} events in its canvas/game input stack").as_str(),
		);
	}
	match event {
		PointerEvent::Click { .. } if process::reads_hardware_pointer(pid) => refuse(
			"uses the Tk toolkit, which places clicks at the hardware pointer rather than the event \
			 location, so a background click would land wherever the user's pointer is",
		),
		PointerEvent::Scroll { .. } if process::is_electron(pid) => {
			refuse("is an Electron app, whose renderer drops background wheel events")
		},
		_ => Ok(()),
	}
}

const LOCAL_EVENT_FILTER: u32 = 0x01 | 0x02 | 0x04;
const SUPPRESSION_INTERVAL: u32 = 0;
const REMOTE_MOUSE_DRAG: u32 = 1;

/// Background pointer event fields, in `SkyLight`'s raw field numbering.
const FIELD_MOUSE_EVENT_NUMBER: u32 = 0;
const FIELD_CLICK_STATE: u32 = 1;
/// Mouse pressure; a press `AppKit` builds carries it at full.
const FIELD_PRESSURE: u32 = 2;
const FIELD_BUTTON_NUMBER: u32 = 3;
const FIELD_SUBTYPE: u32 = 7;
/// Target pid, checked by Chromium's synthetic-event filter.
const FIELD_TARGET_PID: u32 = 40;
const FIELD_WINDOW_NUMBER: u32 = 51;
/// The sender's `WindowServer` connection, as on an `AppKit`-built event.
const FIELD_WINDOW_CONTEXT: u32 = 52;
/// Subtype of an `AppKit`-defined event.
const FIELD_APPKIT_SUBTYPE: u32 = 83;
/// Shared id that makes `WindowServer` coalesce one gesture's events.
const FIELD_CLICK_GROUP: u32 = 58;
const FIELD_WINDOW_UNDER_POINTER: u32 = 91;
const FIELD_WINDOW_UNDER_POINTER_THAT_CAN_HANDLE: u32 = 92;
/// `NSEventSubtypeTouch`.
const SUBTYPE_TOUCH: i64 = 3;
/// `NSEventTypeAppKitDefined`, which the `CGEventType` enum cannot express.
const APPKIT_DEFINED_EVENT: u32 = 13;
/// `NSEventSubtypeApplicationActivated`.
const APPLICATION_ACTIVATED: i64 = 1;
/// Flags `AppKit` stamps on a window's application-activated event; they are
/// not held modifiers.
const ACTIVATION_FLAGS: u64 = 0xc0000;
/// How long an application may take to report the key window that
/// [`make_key_in_background`] asked for.
const KEY_WINDOW_TIMEOUT: Duration = Duration::from_millis(250);
const KEY_WINDOW_POLL: Duration = Duration::from_millis(10);

/// Where a background input's target window stands relative to the user's
/// keyboard focus.
#[derive(Debug, PartialEq, Eq)]
enum FrontTarget {
	/// Another application is frontmost.
	Background,
	/// The target already is the key window of the frontmost application.
	Key,
	/// The target is another window of the frontmost application, whose key
	/// window takes the user's typing.
	UserSibling,
}

fn front_target(
	front: Option<libc::pid_t>,
	pid: libc::pid_t,
	wid: u32,
	focused: impl FnOnce() -> Option<u32>,
) -> FrontTarget {
	if front != Some(pid) {
		FrontTarget::Background
	} else if focused() == Some(wid) {
		FrontTarget::Key
	} else {
		FrontTarget::UserSibling
	}
}

/// Makes `wid` the key window of its background application, as that
/// application sees it, without activating it.
///
/// A background application drops pid-routed keystrokes and key equivalents,
/// and Chromium ignores its clicks, until it believes it is active. The
/// application-activated event `AppKit` builds for a real activation gives it
/// that belief; a press and release just outside the window's frame then make
/// exactly `wid` key among its windows without reaching any of its controls.
/// `WindowServer`'s front process and key-focus application, which route the
/// user's keystrokes and key equivalents, stay with the user's app. In the
/// frontmost application itself, nothing is posted: the target already is
/// key, or making it key would move the user's typing, so the input refuses.
pub(super) fn make_key_in_background(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
) -> CoreResult<()> {
	match front_target(skylight::front_pid(), pid, wid, || ax::focused_window_id(pid)) {
		FrontTarget::Background => {},
		FrontTarget::Key => return Ok(()),
		FrontTarget::UserSibling => {
			return Err(DesktopError::background_unavailable(format!(
				"window {wid} belongs to the frontmost application but is not its key window; making \
				 it key would move the user's typing there, so nothing was sent; retry with \
				 takeover:true or use ax actions",
			)));
		},
	}
	let context = skylight::sender_connection()?;
	let activated = CGEvent::new(source.clone())
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz activation event"))?;
	// SAFETY: `activated` is a live CGEvent and the type is a valid CGEventType
	// value the core-graphics enum lacks.
	unsafe { set_event_type(activated.as_ptr(), APPKIT_DEFINED_EVENT) };
	activated.set_flags(CGEventFlags::from_bits_retain(ACTIVATION_FLAGS));
	skylight::set_fields(&activated, &[
		(FIELD_WINDOW_NUMBER, i64::from(wid)),
		(FIELD_WINDOW_CONTEXT, context),
		(FIELD_APPKIT_SUBTYPE, APPLICATION_ACTIVATED),
	])?;
	skylight::post_routed(pid, &activated)?;
	let (location, local) = activating_press(window);
	let press = |event_type: CGEventType, number: i64| -> CoreResult<()> {
		let event = mouse_event(source, event_type, location, CGMouseButton::Left)?;
		skylight::set_fields(&event, &[
			(FIELD_MOUSE_EVENT_NUMBER, number),
			(FIELD_CLICK_STATE, 1),
			(FIELD_PRESSURE, 255),
			(FIELD_BUTTON_NUMBER, 0),
			(FIELD_SUBTYPE, SUBTYPE_TOUCH),
			(FIELD_WINDOW_NUMBER, i64::from(wid)),
			(FIELD_WINDOW_CONTEXT, context),
			(FIELD_WINDOW_UNDER_POINTER, i64::from(wid)),
			(FIELD_WINDOW_UNDER_POINTER_THAT_CAN_HANDLE, i64::from(wid)),
		])?;
		skylight::set_window_location(&event, local)?;
		skylight::post_routed(pid, &event)
	};
	press(CGEventType::LeftMouseDown, 1)?;
	let release = control::cleanup(|| press(CGEventType::LeftMouseUp, 2));
	skylight::after_cleanup(Ok(()), release)
}

/// Global and window-local points of the press that makes a window key: one
/// point beyond its top-left corner, outside its frame.
fn activating_press(window: &DesktopWindow) -> (CGPoint, CGPoint) {
	let local = CGPoint::new(-1.0, -1.0);
	(CGPoint::new(f64::from(window.x) + local.x, f64::from(window.y) + local.y), local)
}

/// Waits until `pid` reports `wid` as its focused window; the application
/// handles [`make_key_in_background`]'s events asynchronously.
pub(super) fn await_key_window(pid: libc::pid_t, wid: u32) -> CoreResult<bool> {
	let deadline = Instant::now() + KEY_WINDOW_TIMEOUT;
	loop {
		if ax::focused_window_id(pid) == Some(wid) {
			return Ok(true);
		}
		if Instant::now() >= deadline {
			return Ok(false);
		}
		control::wait(KEY_WINDOW_POLL)?;
	}
}

/// Lets `WindowServer` apply a pointer warp before HID input at the new
/// location, and lets the target consume a click before focus or the pointer
/// moves on.
const POINTER_SETTLE: Duration = Duration::from_millis(40);
/// Press-to-release gap: an `NSButton` press enters a tracking loop that can
/// miss a release arriving before its first poll.
const PRESS_GAP: Duration = Duration::from_millis(28);
const MULTI_CLICK_GAP: Duration = Duration::from_millis(80);
const KEY_GAP: Duration = Duration::from_millis(8);
/// Key pacing for a device that samples HID report state, which loses a key
/// transition shorter than its report interval; a search field that reacts
/// to every key needs more than one interval.
const REPORT_KEY_GAP: Duration = Duration::from_millis(120);
/// Press length, and pointer settle, of a tap on such a device.
const TAP_HOLD: Duration = Duration::from_millis(60);
/// How long raising an occluded target may take to become visible to
/// hit-testing.
const UNCOVER_TIMEOUT: Duration = Duration::from_millis(300);
/// Largest pixel delta per axis in one wheel event of an ordinary scroll.
const MAX_WHEEL_STEP: u32 = 30;
/// Upper bound on the wheel events of one scroll, which keeps the wheel train
/// under about 0.6 s; beyond 1200 px the events grow instead.
const MAX_WHEEL_EVENTS: u32 = 40;
/// Pacing between the wheel events of one scroll, roughly one 60 Hz frame
/// like a physical wheel's detents.
const WHEEL_STEP_GAP: Duration = Duration::from_millis(16);
/// Distances from the scroll point of the `MouseMoved` primer's moves, in
/// order. They lie on the side of the point facing the target window's
/// centre, and the farthest is hit-tested before a takeover scroll.
const PRIMER_OFFSETS: [f64; 3] = [2.0, 1.0, 0.0];
/// Spacing of the primer's moves.
const PRIMER_GAP: Duration = Duration::from_millis(20);
/// Wait after the primer for the surface under the pointer to take the new
/// position before the first wheel.
const PRIMER_SETTLE: Duration = Duration::from_millis(50);

#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
	#[link_name = "CGEventSourceSetLocalEventsSuppressionInterval"]
	fn set_local_events_suppression_interval(source: CGEventSourceRef, seconds: f64);
	#[link_name = "CGEventSourceSetLocalEventsFilterDuringSuppressionState"]
	fn set_local_events_filter_during_suppression_state(
		source: CGEventSourceRef,
		filter: u32,
		state: u32,
	);
	#[link_name = "CGEventCreateKeyboardEvent"]
	fn create_keyboard_event(source: CGEventSourceRef, keycode: u16, down: bool) -> CGEventRef;
	#[link_name = "CGEventSetType"]
	fn set_event_type(event: CGEventRef, event_type: u32);
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsSuppressionInterval"]
	fn get_local_events_suppression_interval(source: CGEventSourceRef) -> f64;
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsFilterDuringSuppressionState"]
	fn get_local_events_filter_during_suppression_state(source: CGEventSourceRef, state: u32)
	-> u32;
	#[cfg(test)]
	#[link_name = "CGEventKeyboardGetUnicodeString"]
	fn keyboard_get_unicode_string(
		event: CGEventRef,
		capacity: usize,
		length: *mut usize,
		units: *mut u16,
	);
}

pub(super) fn source() -> CoreResult<CGEventSource> {
	event_source(CGEventSourceStateID::HIDSystemState)
}

fn event_source(state: CGEventSourceStateID) -> CoreResult<CGEventSource> {
	let source = CGEventSource::new(state)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz input event source"))?;
	// SAFETY: `source` is a live CGEventSource and both setters accept these
	// documented masks/states.
	unsafe {
		set_local_events_suppression_interval(source.as_ptr(), 0.0);
		set_local_events_filter_during_suppression_state(
			source.as_ptr(),
			LOCAL_EVENT_FILTER,
			SUPPRESSION_INTERVAL,
		);
		set_local_events_filter_during_suppression_state(
			source.as_ptr(),
			LOCAL_EVENT_FILTER,
			REMOTE_MOUSE_DRAG,
		);
	}
	Ok(source)
}

fn modifier_flags(modifiers: Modifiers) -> CGEventFlags {
	let mut flags = CGEventFlags::CGEventFlagNull;
	if modifiers.ctrl {
		flags |= CGEventFlags::CGEventFlagControl;
	}
	if modifiers.alt {
		flags |= CGEventFlags::CGEventFlagAlternate;
	}
	if modifiers.shift {
		flags |= CGEventFlags::CGEventFlagShift;
	}
	if modifiers.meta {
		flags |= CGEventFlags::CGEventFlagCommand;
	}
	flags
}

const fn button_types(
	button: MouseButton,
) -> (CGMouseButton, CGEventType, CGEventType, CGEventType, i64) {
	match button {
		MouseButton::Left => (
			CGMouseButton::Left,
			CGEventType::LeftMouseDown,
			CGEventType::LeftMouseUp,
			CGEventType::LeftMouseDragged,
			0,
		),
		MouseButton::Right => (
			CGMouseButton::Right,
			CGEventType::RightMouseDown,
			CGEventType::RightMouseUp,
			CGEventType::RightMouseDragged,
			1,
		),
		MouseButton::Middle => (
			CGMouseButton::Center,
			CGEventType::OtherMouseDown,
			CGEventType::OtherMouseUp,
			CGEventType::OtherMouseDragged,
			2,
		),
	}
}

fn background_pointer(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button: MouseButton::Left, count, .. } => {
			make_key_in_background(source, pid, wid, window)?;
			background_left_click(source, pid, wid, window, x, y, count)
		},
		PointerEvent::Click { x, y, button, count, .. } => {
			background_button_click(source, pid, wid, window, x, y, button, count)
		},
		PointerEvent::Move { x, y } => post_hover(source, pid, wid, window, x, y, click_group_id()),
		PointerEvent::Scroll { x, y, dx, dy } => {
			background_scroll(source, pid, wid, window, x, y, dx, dy)
		},
		PointerEvent::Drag { .. } | PointerEvent::Hold { .. } => {
			Err(DesktopError::background_unavailable(format!(
				"window {wid} cannot receive a background drag on macOS; retry with takeover:true or \
				 use ax actions",
			)))
		},
	}
}

/// Background left click on the Chromium-compatible route: a hover primer at
/// the target, a press/release off-screen that satisfies Chromium's
/// user-activation gate without hitting any element, then the real presses.
///
/// Quartz event locations are global; the separate window-location field is
/// relative to the window's top-left, including its title bar. Chromium uses
/// that field for hit-testing even on the `SkyLight`-only route.
fn background_left_click(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	count: u32,
) -> CoreResult<()> {
	let group = click_group_id();
	let target = CGPoint::new(x, y);
	let local = window_local(window, x, y);
	let offscreen = CGPoint::new(-1.0, -1.0);
	let post = |event_type: CGEventType,
	            location: CGPoint,
	            window_location: CGPoint,
	            phase: i64,
	            click_state: i64|
	 -> CoreResult<()> {
		let event = mouse_event(source, event_type, location, CGMouseButton::Left)?;
		skylight::set_fields(&event, &[
			(FIELD_MOUSE_EVENT_NUMBER, phase),
			(FIELD_CLICK_STATE, click_state),
			(FIELD_BUTTON_NUMBER, 0),
			(FIELD_SUBTYPE, SUBTYPE_TOUCH),
			(FIELD_TARGET_PID, i64::from(pid)),
			(FIELD_WINDOW_NUMBER, i64::from(wid)),
			(FIELD_CLICK_GROUP, group),
			(FIELD_WINDOW_UNDER_POINTER, i64::from(wid)),
			(FIELD_WINDOW_UNDER_POINTER_THAT_CAN_HANDLE, i64::from(wid)),
		])?;
		skylight::set_window_location(&event, window_location)?;
		skylight::post_routed(pid, &event)
	};
	post(CGEventType::MouseMoved, target, local, 2, 0)?;
	control::wait(Duration::from_millis(15))?;
	post(CGEventType::LeftMouseDown, offscreen, offscreen, 1, 1)?;
	let result = control::wait(Duration::from_millis(1));
	let release = control::cleanup(|| post(CGEventType::LeftMouseUp, offscreen, offscreen, 2, 1));
	skylight::after_cleanup(result, release)?;
	control::wait(Duration::from_millis(100))?;
	let count = count.max(1);
	for click_state in 1..=count {
		post(CGEventType::LeftMouseDown, target, local, 3, i64::from(click_state))?;
		let result = control::wait(Duration::from_millis(1));
		let release = control::cleanup(|| {
			post(CGEventType::LeftMouseUp, target, local, 3, i64::from(click_state))
		});
		skylight::after_cleanup(result, release)?;
		if click_state < count {
			control::wait(MULTI_CLICK_GAP)?;
		}
	}
	Ok(())
}

/// Background right or middle click: a hover primer, then presses stamped with
/// their button number (a right press stamped as button 0 is handled as a left
/// press) and the window-routing fields that reach a non-key window.
fn background_button_click(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	button: MouseButton,
	count: u32,
) -> CoreResult<()> {
	let group = click_group_id();
	let (cg_button, down, up, _, number) = button_types(button);
	post_hover(source, pid, wid, window, x, y, group)?;
	control::wait(Duration::from_millis(12))?;
	let count = count.max(1);
	for click_state in 1..=count {
		let press = mouse_event(source, down, CGPoint::new(x, y), cg_button)?;
		let release = mouse_event(source, up, CGPoint::new(x, y), cg_button)?;
		let result =
			post_window_pointer(pid, wid, window, &press, x, y, i64::from(click_state), number, group)
				.and_then(|()| control::wait(PRESS_GAP));
		let cleanup = control::cleanup(|| {
			post_window_pointer(
				pid,
				wid,
				window,
				&release,
				x,
				y,
				i64::from(click_state),
				number,
				group,
			)
		});
		skylight::after_cleanup(result, cleanup)?;
		if click_state < count {
			control::wait(MULTI_CLICK_GAP)?;
		}
	}
	Ok(())
}

/// Moves the target window's notion of the pointer to `(x, y)`, so hover
/// state and the next press hit-test at the right view.
fn post_hover(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	group: i64,
) -> CoreResult<()> {
	let event =
		mouse_event(source, CGEventType::MouseMoved, CGPoint::new(x, y), CGMouseButton::Left)?;
	post_window_pointer(pid, wid, window, &event, x, y, 0, 0, group)
}

/// Stamps the window-routing fields on a background pointer event and posts it
/// with `skylight::post_dual`. The window location is window-local, as the
/// public route expects.
fn post_window_pointer(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: &CGEvent,
	x: f64,
	y: f64,
	click_state: i64,
	button_number: i64,
	group: i64,
) -> CoreResult<()> {
	skylight::set_fields(event, &[
		(FIELD_CLICK_STATE, click_state),
		(FIELD_BUTTON_NUMBER, button_number),
		(FIELD_SUBTYPE, SUBTYPE_TOUCH),
		(FIELD_TARGET_PID, i64::from(pid)),
		(FIELD_WINDOW_NUMBER, i64::from(wid)),
		(FIELD_CLICK_GROUP, group),
		(FIELD_WINDOW_UNDER_POINTER, i64::from(wid)),
		(FIELD_WINDOW_UNDER_POINTER_THAT_CAN_HANDLE, i64::from(wid)),
	])?;
	skylight::set_window_location(event, window_local(window, x, y))?;
	skylight::post_dual(pid, event)
}

fn background_scroll(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	dx: f64,
	dy: f64,
) -> CoreResult<()> {
	let wheel_x = finite_i32(dx, "horizontal scroll delta")?;
	let wheel_y = finite_i32(dy, "vertical scroll delta")?;
	// A stale hover location makes a nested scroller miss the wheel even though
	// the event reaches the process.
	post_hover(source, pid, wid, window, x, y, click_group_id())?;
	control::wait(Duration::from_millis(12))?;
	let event =
		CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::PIXEL, 2, wheel_y, wheel_x, 0)
			.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
	event.set_flags(CGEventFlags::CGEventFlagNull);
	event.set_location(CGPoint::new(x, y));
	skylight::set_fields(&event, &[
		(FIELD_TARGET_PID, i64::from(pid)),
		(FIELD_WINDOW_NUMBER, i64::from(wid)),
		(FIELD_WINDOW_UNDER_POINTER, i64::from(wid)),
		(FIELD_WINDOW_UNDER_POINTER_THAT_CAN_HANDLE, i64::from(wid)),
	])?;
	skylight::set_window_location(&event, window_local(window, x, y))?;
	skylight::post_dual(pid, &event)
}

/// Background pointer input for a device that samples HID report state
/// (iPhone Mirroring). A tap needs no activation, only a press that outlasts
/// a report, addressed to the window. The device moves its own pointer only
/// for a button event and scrolls whatever is under that pointer, so a scroll
/// first aims it with a lone release, which taps nothing. Other events take
/// the ordinary route.
fn report_pointer(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
) -> CoreResult<()> {
	let post = |event_type: CGEventType, x: f64, y: f64, click_state: i64| -> CoreResult<()> {
		let event = mouse_event(source, event_type, CGPoint::new(x, y), CGMouseButton::Left)?;
		skylight::set_fields(&event, &[
			(FIELD_CLICK_STATE, click_state),
			(FIELD_WINDOW_NUMBER, i64::from(wid)),
		])?;
		skylight::set_window_location(&event, window_local(window, x, y))?;
		skylight::post_routed(pid, &event)
	};
	match event {
		PointerEvent::Click { x, y, button: MouseButton::Left, count, .. } => {
			let count = i64::from(count.max(1));
			for click_state in 1..=count {
				let result = post(CGEventType::LeftMouseDown, x, y, click_state)
					.and_then(|()| control::wait(TAP_HOLD));
				let release = control::cleanup(|| post(CGEventType::LeftMouseUp, x, y, click_state));
				skylight::after_cleanup(result, release)?;
				if click_state < count {
					control::wait(MULTI_CLICK_GAP)?;
				}
			}
			Ok(())
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			post(CGEventType::LeftMouseUp, x, y, 1)?;
			control::wait(TAP_HOLD)?;
			background_scroll(source, pid, wid, window, x, y, dx, dy)
		},
		event => background_pointer(source, pid, wid, window, event),
	}
}

/// A pointer event whose flags carry no modifiers: a `HIDSystemState` source
/// would otherwise inherit whatever the user is physically holding.
fn mouse_event(
	source: &CGEventSource,
	event_type: CGEventType,
	location: CGPoint,
	button: CGMouseButton,
) -> CoreResult<CGEvent> {
	let event = CGEvent::new_mouse_event(source.clone(), event_type, location, button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
	event.set_flags(CGEventFlags::CGEventFlagNull);
	Ok(event)
}

fn window_local(window: &DesktopWindow, x: f64, y: f64) -> CGPoint {
	CGPoint::new(x - f64::from(window.x), y - f64::from(window.y))
}

fn click_group_id() -> i64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.subsec_nanos()
		.into()
}

fn post_takeover_key(pid: libc::pid_t, wid: u32, event: &CGEvent) -> CoreResult<()> {
	// Stop rather than typing into a newly user-selected app/window. Key
	// releases must still pass through so held keys do not leak.
	post_guarded(event, || skylight::require_front_window(pid, wid), post_global)
}

/// Posts `event`, first running `guard` when it presses a key or modifier.
fn post_guarded(
	event: &CGEvent,
	guard: impl FnOnce() -> CoreResult<()>,
	post: impl FnOnce(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	if is_key_press(event) {
		guard()?;
	}
	post(event)
}

/// Whether `event` presses a key: a key-down, or a modifier change that sets
/// the flag of the modifier key it names.
fn is_key_press(event: &CGEvent) -> bool {
	match event.get_type() {
		CGEventType::KeyDown => true,
		CGEventType::FlagsChanged => {
			let flag = match event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE) {
				56 | 60 => CGEventFlags::CGEventFlagShift,
				58 | 61 => CGEventFlags::CGEventFlagAlternate,
				59 | 62 => CGEventFlags::CGEventFlagControl,
				54 | 55 => CGEventFlags::CGEventFlagCommand,
				_ => return false,
			};
			event.get_flags().contains(flag)
		},
		_ => false,
	}
}

/// One key typed into the target, carrying the text it types as its Unicode
/// payload.
#[derive(Debug, PartialEq, Eq)]
enum TypedKey<'a> {
	/// A key of the current keyboard layout, with the modifiers it needs.
	Layout(Keystroke, &'a str),
	/// Text sent on virtual key 0: applications that read the Unicode payload
	/// type it, applications that read the key code see `a`.
	Unicode(&'a str),
}

/// UTF-16 units a Quartz keyboard event carries at most.
const MAX_EVENT_UNITS: usize = 20;

/// The keys that type `text`, from `stroke`'s keyboard layout lookup.
///
/// Outside a remote screen, a character that needs Option goes out as
/// Unicode, because Option can act as a shortcut or Meta key there. A remote
/// screen forwards key codes and drops the Unicode payload, so text no key
/// types fails before anything is posted.
fn typed_keys(
	text: &str,
	stroke: impl Fn(char) -> Option<Keystroke>,
	remote: Option<RemoteScreen>,
) -> CoreResult<Vec<TypedKey<'_>>> {
	let mut keys = Vec::with_capacity(text.len());
	let mut untypable = Vec::new();
	for grapheme in graphemes_str(text) {
		let mut characters = grapheme.chars();
		let character = match (characters.next(), characters.next(), characters.next()) {
			(Some(character), None, _) => Some(character),
			// CR LF is one grapheme and one Return.
			(Some('\r'), Some('\n'), None) => Some('\r'),
			_ => None,
		};
		match character
			.and_then(&stroke)
			.filter(|stroke| remote.is_some() || !stroke.option)
		{
			Some(stroke) => keys.push(TypedKey::Layout(stroke, grapheme)),
			None if remote.is_some() => {
				if !untypable.contains(&grapheme) {
					untypable.push(grapheme);
				}
			},
			None => keys.extend(unicode_runs(grapheme).map(TypedKey::Unicode)),
		}
	}
	if untypable.is_empty() {
		return Ok(keys);
	}
	Err(DesktopError::invalid_key(format!(
		"the target shows a remote screen, which receives key codes and ignores typed text, and no \
		 key on the current keyboard layout types {}; nothing was typed",
		untypable.join(" "),
	)))
}

/// Splits `text` into runs a Quartz keyboard event can carry, never splitting
/// a character.
fn unicode_runs(text: &str) -> impl Iterator<Item = &str> {
	let mut rest = text;
	std::iter::from_fn(move || {
		if rest.is_empty() {
			return None;
		}
		let mut units = 0;
		let end = rest
			.char_indices()
			.find(|(_, character)| {
				units += character.len_utf16();
				units > MAX_EVENT_UNITS
			})
			.map_or(rest.len(), |(index, _)| index);
		let (run, tail) = rest.split_at(end);
		rest = tail;
		Some(run)
	})
}

/// Pause after each key transition. A device that samples HID report state
/// loses a press or release that lasts less than its report interval.
const fn key_gap(remote: Option<RemoteScreen>) -> Duration {
	match remote {
		Some(RemoteScreen::HidReports) => REPORT_KEY_GAP,
		Some(RemoteScreen::KeyEvents) | None => KEY_GAP,
	}
}

/// Types `keys` with `gap` after every transition, pressing Shift and Option
/// as modifier keys only while a key needs them: a client that forwards input
/// to another machine sends modifier keys, not event flags. `guard` runs
/// before every press, modifier presses included; when it fails nothing more
/// is pressed. Modifiers still held when posting fails or the operation is
/// cancelled are released.
fn type_keys(
	source: &CGEventSource,
	keys: &[TypedKey<'_>],
	gap: Duration,
	mut guard: impl FnMut() -> CoreResult<()>,
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	const MODIFIERS: [KeyName; 2] = [KeyName::Shift, KeyName::Alt];
	let mut held = Modifiers::default();
	let result = (|| {
		for key in keys {
			control::check()?;
			let (code, wanted, text) = match *key {
				TypedKey::Layout(stroke, text) => {
					let wanted =
						Modifiers { shift: stroke.shift, alt: stroke.option, ..Modifiers::default() };
					(stroke.code, wanted, text)
				},
				TypedKey::Unicode(text) => (0, Modifiers::default(), text),
			};
			for modifier in MODIFIERS {
				let down = modifier_held(wanted, modifier);
				if modifier_held(held, modifier) != down {
					// An attempted press counts as held: it may have reached the
					// target. A release counts only once posted, so the final
					// cleanup retries a release that failed.
					let mut next = held;
					update_modifier(&mut next, modifier, down);
					if down {
						guard()?;
						held = next;
					}
					post_key(source, modifier, down, modifier_flags(next), &mut post)?;
					held = next;
					control::wait(gap)?;
				}
			}
			let mut units = [0u16; MAX_EVENT_UNITS];
			let mut length = 0;
			for character in text.chars() {
				length += character.encode_utf16(&mut units[length..]).len();
			}
			let press = CGEvent::new_keyboard_event(source.clone(), code, true)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			let release = CGEvent::new_keyboard_event(source.clone(), code, false)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			for event in [&press, &release] {
				event.set_string_from_utf16_unchecked(&units[..length]);
				event.set_flags(modifier_flags(held));
			}
			guard()?;
			let result = post(&press).and_then(|()| control::wait(gap));
			let cleanup = control::cleanup(|| post(&release));
			skylight::after_cleanup(result, cleanup)?;
			control::wait(gap)?;
		}
		Ok(())
	})();
	let release = control::cleanup(|| {
		let mut result = Ok(());
		for modifier in MODIFIERS.into_iter().rev() {
			if modifier_held(held, modifier) {
				update_modifier(&mut held, modifier, false);
				let release = post_key(source, modifier, false, modifier_flags(held), &mut post);
				result = skylight::after_cleanup(result, release);
			}
		}
		result
	});
	skylight::after_cleanup(result, release)
}

/// The typed characters that need Shift or Option, each once.
fn modified_text<'a>(keys: &[TypedKey<'a>]) -> Vec<&'a str> {
	let mut modified = Vec::new();
	for key in keys {
		if let TypedKey::Layout(stroke, text) = *key
			&& (stroke.shift || stroke.option)
			&& !modified.contains(&text)
		{
			modified.push(text);
		}
	}
	modified
}

/// Key transitions `(keycode, down)` that press `keys` like a hardware
/// keyboard, holding Shift and Option only while a key needs them.
/// `typed_keys` gives a remote screen only layout keys.
fn bare_transitions(keys: &[TypedKey<'_>]) -> Vec<(u16, bool)> {
	const SHIFT: u16 = 56;
	const OPTION: u16 = 58;
	let mut transitions = Vec::with_capacity(keys.len() * 2 + 2);
	let (mut shift, mut option) = (false, false);
	for key in keys {
		let TypedKey::Layout(stroke, _) = *key else {
			continue;
		};
		for (held, wanted, code) in
			[(&mut shift, stroke.shift, SHIFT), (&mut option, stroke.option, OPTION)]
		{
			if *held != wanted {
				*held = wanted;
				transitions.push((code, wanted));
			}
		}
		transitions.push((stroke.code, true));
		transitions.push((stroke.code, false));
	}
	if option {
		transitions.push((OPTION, false));
	}
	if shift {
		transitions.push((SHIFT, false));
	}
	transitions
}

/// Posts bare key transitions at the HID tap: a null source and no flag or
/// Unicode overrides, so `CoreGraphics` derives modifier state from the
/// transitions exactly as for a hardware keyboard.
fn post_bare_keys(
	transitions: &[(u16, bool)],
	gap: Duration,
	guard: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	post_transitions(transitions, gap, guard, |code, down| {
		control::check()?;
		// SAFETY: A null source is documented as valid for keyboard events.
		let raw = unsafe { create_keyboard_event(ptr::null_mut(), code, down) };
		if raw.is_null() {
			return Err(DesktopError::input_failed("failed to create a Quartz keyboard event"));
		}
		// SAFETY: `raw` is a non-null create-rule event whose ownership moves
		// here.
		let event = unsafe { CGEvent::from_ptr(raw) };
		post_global(&event)
	})
}

/// Posts `transitions` with `gap` after each, running `guard` before every
/// press. A key counts as held from its attempted press until its release
/// posts; keys still held when posting fails or is cancelled are released.
fn post_transitions(
	transitions: &[(u16, bool)],
	gap: Duration,
	mut guard: impl FnMut() -> CoreResult<()>,
	mut post: impl FnMut(u16, bool) -> CoreResult<()>,
) -> CoreResult<()> {
	let mut held = [false; 128];
	let mut result = Ok(());
	for &(code, down) in transitions {
		result = control::check().and_then(|()| {
			if down {
				guard()?;
				held[usize::from(code)] = true;
			}
			post(code, down)?;
			held[usize::from(code)] = down;
			control::wait(gap)
		});
		if result.is_err() {
			break;
		}
	}
	let cleanup = control::cleanup(|| {
		let mut result = Ok(());
		for (code, down) in held.into_iter().enumerate().rev() {
			if down {
				result = skylight::after_cleanup(result, post(code as u16, false));
			}
		}
		result
	});
	skylight::after_cleanup(result, cleanup)
}

/// Wait before the first foreground keystroke: a surface that was just
/// activated drops keys until it re-arms its input handling (remote-desktop
/// clients re-grab the keyboard over hundreds of milliseconds), and even an
/// already-front one eats a key sent the instant focus settles.
const fn first_key_settle(activated: bool) -> Duration {
	if activated {
		Duration::from_millis(200)
	} else {
		Duration::from_millis(20)
	}
}

fn global_chord(source: &CGEventSource, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, KEY_GAP, post_global)
}

fn key_chord(
	source: &CGEventSource,
	keys: &[KeyName],
	gap: Duration,
	post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::invalid_key("key chord must not be empty"));
	}
	with_held_keys(source, keys, gap, post, control::check)
}

fn with_held_keys(
	source: &CGEventSource,
	keys: &[KeyName],
	gap: Duration,
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
	body: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	for &key in keys {
		key_code(key)?;
	}
	let mut active = Modifiers::default();
	let mut pressed = 0;
	let mut result = Ok(());
	// The attempted key counts as pressed before it posts: a failed post may
	// still have reached the target, and its release clears its modifier flag
	// before the held keys' releases carry `active` (unlike `hold_keys`).
	for &key in keys {
		if let Err(error) = control::check() {
			result = Err(error);
			break;
		}
		update_modifier(&mut active, key, true);
		pressed += 1;
		if let Err(error) = control::check()
			.and_then(|()| post_key(source, key, true, modifier_flags(active), &mut post))
			.and_then(|()| control::wait(gap))
		{
			result = Err(error);
			break;
		}
	}
	if result.is_ok() {
		result = body();
	}
	let cleanup = control::cleanup(|| {
		let mut cleanup = Ok(());
		for &key in keys[..pressed].iter().rev() {
			update_modifier(&mut active, key, false);
			let release = post_key(source, key, false, modifier_flags(active), &mut post);
			cleanup = skylight::after_cleanup(cleanup, release);
		}
		cleanup
	});
	skylight::after_cleanup(result, cleanup)
}

fn post_key(
	source: &CGEventSource,
	key: KeyName,
	down: bool,
	flags: CGEventFlags,
	post: &mut impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	let code = key_code(key)?;
	let event = CGEvent::new_keyboard_event(source.clone(), code, down)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
	event.set_flags(flags);
	post(&event)
}

const fn update_modifier(modifiers: &mut Modifiers, key: KeyName, down: bool) {
	match key {
		KeyName::Ctrl => modifiers.ctrl = down,
		KeyName::Alt => modifiers.alt = down,
		KeyName::Shift => modifiers.shift = down,
		KeyName::Meta => modifiers.meta = down,
		_ => {},
	}
}

fn key_code(key: KeyName) -> CoreResult<u16> {
	let code = match key {
		KeyName::Ctrl => 59,
		KeyName::Alt => 58,
		KeyName::Shift => 56,
		KeyName::Meta => 55,
		KeyName::Enter => 36,
		KeyName::Escape => 53,
		KeyName::Tab => 48,
		KeyName::Space => 49,
		KeyName::Backspace => 51,
		KeyName::Delete => 117,
		KeyName::Insert => 114,
		KeyName::Home => 115,
		KeyName::End => 119,
		KeyName::PageUp => 116,
		KeyName::PageDown => 121,
		KeyName::Up => 126,
		KeyName::Down => 125,
		KeyName::Left => 123,
		KeyName::Right => 124,
		KeyName::CapsLock => 57,
		KeyName::NumLock => 71,
		KeyName::PrintScreen => 105,
		KeyName::F1 => 122,
		KeyName::F2 => 120,
		KeyName::F3 => 99,
		KeyName::F4 => 118,
		KeyName::F5 => 96,
		KeyName::F6 => 97,
		KeyName::F7 => 98,
		KeyName::F8 => 100,
		KeyName::F9 => 101,
		KeyName::F10 => 109,
		KeyName::F11 => 103,
		KeyName::F12 => 111,
		KeyName::F13 => 105,
		KeyName::F14 => 107,
		KeyName::F15 => 113,
		KeyName::F16 => 106,
		KeyName::F17 => 64,
		KeyName::F18 => 79,
		KeyName::F19 => 80,
		KeyName::F20 => 90,
		KeyName::F21 => 110,
		KeyName::F22 => 111,
		KeyName::F23 => 112,
		KeyName::F24 => 113,
		KeyName::Char(character) => char_key_code(character)?,
	};
	Ok(code)
}

fn char_key_code(character: char) -> CoreResult<u16> {
	let normalized = character.to_ascii_lowercase();
	let code = match normalized {
		'a' => 0,
		's' => 1,
		'd' => 2,
		'f' => 3,
		'h' => 4,
		'g' => 5,
		'z' => 6,
		'x' => 7,
		'c' => 8,
		'v' => 9,
		'b' => 11,
		'q' => 12,
		'w' => 13,
		'e' => 14,
		'r' => 15,
		'y' => 16,
		't' => 17,
		'1' => 18,
		'2' => 19,
		'3' => 20,
		'4' => 21,
		'6' => 22,
		'5' => 23,
		'=' => 24,
		'9' => 25,
		'7' => 26,
		'-' => 27,
		'8' => 28,
		'0' => 29,
		']' => 30,
		'o' => 31,
		'u' => 32,
		'[' => 33,
		'i' => 34,
		'p' => 35,
		'l' => 37,
		'j' => 38,
		'\'' => 39,
		'k' => 40,
		';' => 41,
		'\\' => 42,
		',' => 43,
		'/' => 44,
		'n' => 45,
		'm' => 46,
		'.' => 47,
		'`' => 50,
		_ => {
			return Err(DesktopError::invalid_key(format!(
				"key '{character}' has no macOS virtual keycode"
			)));
		},
	};
	Ok(code)
}

/// Delivers real HID pointer input to `window` while it is the frontmost key
/// window, then restores focus, any known covering window, and the user's
/// pointer. Raising a single covering window is not an exact z-order snapshot.
fn foreground_pointer(
	source: &CGEventSource,
	window: &DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	event: PointerEvent,
) -> CoreResult<()> {
	preserving_cursor(source, || {
		skylight::with_foreground(pid, wid, |_| {
			let activity = control::user_activity();
			let mut occluder = None;
			let result = uncover(window, pid, wid, &event, &mut occluder)
				.and_then(|()| skylight::require_front_window(pid, wid))
				.and_then(|()| match event {
					PointerEvent::Scroll { x, y, dx, dy } => {
						let side = primer_side(window, x);
						global_scroll(source, x, y, dx, dy, side, || {
							skylight::require_front_window(pid, wid)
						})
					},
					event => global_pointer(source, event),
				});
			// Capture before raising, so even a failed raise/re-hit-test retains
			// the restoration token. Never reorder over a user-selected app.
			let cleanup =
				if control::user_activity() == activity && skylight::is_front_window(pid, wid) {
					control::cleanup(|| {
						occluder.map_or(Ok(()), |occluder: Occluder| {
							ax::raise_window_id(occluder.pid, occluder.window)
						})
					})
				} else {
					Ok(())
				};
			skylight::after_cleanup(result, cleanup)
		})
	})
}

/// A window that covered part of a takeover target until the target was
/// raised over it.
struct Occluder {
	pid:    libc::pid_t,
	window: u32,
}

/// Makes sure every point `event` hits lands on the target window.
///
/// HID input goes to whatever surface is frontmost at the point, and making
/// the target key does not raise it, so a covered target would hand the input
/// to the window above it. The target is raised when anything covers one of
/// the points and the input refuses if it stays covered. Missing hit-test
/// ownership is not evidence that input can safely hit the target.
fn uncover(
	window: &DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	event: &PointerEvent,
	occluder: &mut Option<Occluder>,
) -> CoreResult<()> {
	let points = event_points(window, event);
	let covering = || -> CoreResult<Option<ax::PointOwner>> {
		let mut first = None;
		for (x, y) in points.into_iter().flatten() {
			control::check()?;
			let owner = ax::point_owner(x, y).ok_or_else(|| {
				DesktopError::input_failed(format!(
					"cannot determine which window owns takeover point ({x}, {y}); no input was sent"
				))
			})?;
			if owner.window.is_none() {
				return Err(DesktopError::input_failed(
					"takeover point has no identifiable native window; no input was sent",
				));
			}
			if covers(&owner, pid, wid) && first.is_none() {
				first = Some(owner);
			}
		}
		Ok(first)
	};
	let Some(first) = covering()? else {
		return Ok(());
	};
	*occluder = first
		.window
		.map(|window| Occluder { pid: first.pid, window });
	// Some windows do not support AXRaise (iPhone Mirroring answers
	// kAXErrorActionUnsupported) yet come forward on their own shortly after
	// activation, so a failed raise is not final: the re-hit-test decides.
	control::check()?;
	let raise_error = ax::MacAx::new().raise(window).err();
	let deadline = Instant::now() + UNCOVER_TIMEOUT;
	loop {
		match covering()? {
			None => return Ok(()),
			Some(owner) if Instant::now() >= deadline => {
				let raise = raise_error.map_or_else(String::new, |error| format!(" ({error})"));
				return Err(DesktopError::input_failed(format!(
					"window {wid} stays covered by process {} at the takeover input point{raise}, so \
					 the input would land on the covering window; no input was sent",
					owner.pid,
				)));
			},
			Some(_) => control::wait(Duration::from_millis(20))?,
		}
	}
}

/// Whether the surface at a point belongs to something other than the target
/// window. A same-process panel or unknown window id is not exact ownership.
fn covers(owner: &ax::PointOwner, pid: libc::pid_t, wid: u32) -> bool {
	owner.pid != pid || owner.window != Some(wid)
}

/// The global points a pointer event hits first and last. A scroll's primer
/// starts beside the scroll point.
fn event_points(window: &DesktopWindow, event: &PointerEvent) -> [Option<(f64, f64)>; 2] {
	match event {
		PointerEvent::Click { x, y, .. }
		| PointerEvent::Hold { x, y, .. }
		| PointerEvent::Move { x, y } => [Some((*x, *y)), None],
		PointerEvent::Scroll { x, y, .. } => {
			[Some((primer_side(window, *x).mul_add(PRIMER_OFFSETS[0], *x), *y)), Some((*x, *y))]
		},
		PointerEvent::Drag { path, .. } => [path.first().copied(), path.last().copied()],
	}
}

/// The horizontal direction from a scroll point toward the centre of
/// `window`, where the primer starts: `1.0` right, `-1.0` left.
fn primer_side(window: &DesktopWindow, x: f64) -> f64 {
	if x < f64::from(window.x) + f64::from(window.width) / 2.0 {
		1.0
	} else {
		-1.0
	}
}

/// Runs HID-tap pointer input for a window target, then warps the user's
/// cursor back to where it was.
///
/// Foreground delivery must post at the HID tap (canvas/game toolkits drop
/// pid-routed events), which moves the real cursor; without the warp back it
/// stays wherever the agent last clicked. `action` must include its own settle
/// delay (see [`skylight::with_foreground`]) so the target consumes the events
/// before the warp: warps generate no events, so the target keeps its hover and
/// click state. Desktop-root input is left alone because it is meant to drive
/// the user's pointer.
fn preserving_cursor(
	source: &CGEventSource,
	action: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	let prior = CGEvent::new(source.clone())
		.map_err(|()| DesktopError::input_failed("failed to read the Quartz cursor location"))?
		.location();
	let result = action();
	// Attempt both operations even if one fails, and distinguish restoration
	// failure from non-delivery so callers do not blindly repeat the action.
	let warp = CGDisplay::warp_mouse_cursor_position(prior);
	let associate = CGDisplay::associate_mouse_and_mouse_cursor_position(true);
	let cleanup = warp.and(associate).map_err(|error| {
		DesktopError::input_failed(format!("restoring the user's cursor failed ({error:?})"))
	});
	skylight::after_cleanup(result, cleanup)
}

/// Moves the real pointer to `point` before HID input there, since `AppKit`
/// hit-tests some clicks and pointer captures against the actual cursor
/// rather than the event location.
fn warp_pointer(point: CGPoint) -> CoreResult<()> {
	control::check()?;
	let _ = CGDisplay::warp_mouse_cursor_position(point);
	// Re-couples the mouse-delta stream so the next event hit-tests at the
	// warped point instead of freezing local input.
	let _ = CGDisplay::associate_mouse_and_mouse_cursor_position(true);
	control::wait(POINTER_SETTLE)
}

/// Holds `modifiers` as physical key transitions on the HID queue around
/// `gesture`, releasing them in reverse order even when it fails. Flag bits
/// on the pointer events alone do not establish modifier state for every
/// `AppKit` view.
fn with_global_modifiers<T>(
	source: &CGEventSource,
	modifiers: Modifiers,
	gesture: impl FnOnce(CGEventFlags) -> CoreResult<T>,
) -> CoreResult<T> {
	const ORDER: [KeyName; 4] = [KeyName::Ctrl, KeyName::Alt, KeyName::Shift, KeyName::Meta];
	let mut held = Modifiers::default();
	let result = (|| {
		for key in ORDER {
			if !modifier_held(modifiers, key) {
				continue;
			}
			control::check()?;
			update_modifier(&mut held, key, true);
			post_key(source, key, true, modifier_flags(held), &mut post_global)?;
			control::wait(KEY_GAP)?;
		}
		gesture(modifier_flags(held))
	})();
	let release = control::cleanup(|| {
		let mut result = Ok(());
		for key in ORDER.into_iter().rev() {
			if modifier_held(held, key) {
				update_modifier(&mut held, key, false);
				result = skylight::after_cleanup(
					result,
					post_key(source, key, false, modifier_flags(held), &mut post_global),
				);
			}
		}
		result
	});
	skylight::after_cleanup(result, release)
}

const fn modifier_held(modifiers: Modifiers, key: KeyName) -> bool {
	match key {
		KeyName::Ctrl => modifiers.ctrl,
		KeyName::Alt => modifiers.alt,
		KeyName::Shift => modifiers.shift,
		KeyName::Meta => modifiers.meta,
		_ => false,
	}
}

fn global_pointer(source: &CGEventSource, event: PointerEvent) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			let point = point(x, y)?;
			let (cg_button, down, up, _, number) = button_types(button);
			warp_pointer(point)?;
			let result = with_global_modifiers(source, modifiers, |flags| {
				if flags != CGEventFlags::CGEventFlagNull {
					// Primes cursor tracking with the modifiers down so a modified
					// press extends the existing selection.
					post_global_mouse(
						source,
						CGEventType::MouseMoved,
						CGMouseButton::Left,
						point,
						0,
						0,
						flags,
					)?;
					control::wait(Duration::from_millis(12))?;
				}
				let count = count.max(1);
				for click_state in 1..=count {
					post_global_mouse(
						source,
						down,
						cg_button,
						point,
						i64::from(click_state),
						number,
						flags,
					)?;
					let result = control::wait(PRESS_GAP);
					let release = control::cleanup(|| {
						post_global_mouse(
							source,
							up,
							cg_button,
							point,
							i64::from(click_state),
							number,
							flags,
						)
					});
					skylight::after_cleanup(result, release)?;
					if click_state < count {
						control::wait(MULTI_CLICK_GAP)?;
					}
				}
				Ok(())
			});
			result.and_then(|()| control::wait(POINTER_SETTLE))
		},
		PointerEvent::Move { x, y } => post_global_mouse(
			source,
			CGEventType::MouseMoved,
			CGMouseButton::Left,
			point(x, y)?,
			0,
			0,
			CGEventFlags::CGEventFlagNull,
		),
		PointerEvent::Drag { path, button, modifiers, mut keys } => {
			control::add_modifiers(&mut keys, modifiers);
			global_drag(&path, button, &keys, source)
		},
		PointerEvent::Hold { x, y, button, keys, duration } => {
			let point = point(x, y)?;
			let (cg_button, down, up, _, number) = button_types(button);
			for &key in &keys {
				key_code(key)?;
			}
			warp_pointer(point)?;
			let flags = held_flags(&keys);
			with_held_keys(source, &keys, KEY_GAP, post_global, || {
				control::bounded_hold(duration, |pressed| {
					post_global_mouse(
						source,
						if pressed { down } else { up },
						cg_button,
						point,
						1,
						number,
						flags,
					)
				})
			})
		},
		// The desktop root has no window to stay inside; approach from the left.
		PointerEvent::Scroll { x, y, dx, dy } => global_scroll(source, x, y, dx, dy, -1.0, || Ok(())),
	}
}

/// HID wheel scroll at `(x, y)` with the real pointer primed there from the
/// `approach` side (`1.0` right, `-1.0` left).
///
/// The delta goes out as `wheel_steps` paced `WHEEL_STEP_GAP` apart, and
/// `before_wheel` runs before each wheel event so a takeover can stop once the
/// target loses focus instead of scrolling whatever window is under the
/// pointer by then.
fn global_scroll(
	source: &CGEventSource,
	x: f64,
	y: f64,
	dx: f64,
	dy: f64,
	approach: f64,
	mut before_wheel: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	let point = point(x, y)?;
	let steps = wheel_steps(
		finite_i32(dx, "horizontal scroll delta")?,
		finite_i32(dy, "vertical scroll delta")?,
	);
	if steps.is_empty() {
		return Ok(());
	}
	// Wheel events go to the window under the real pointer.
	warp_pointer(point)?;
	prime_pointer(source, point, approach)?;
	for (index, &(wheel_x, wheel_y)) in steps.iter().enumerate() {
		if index > 0 {
			control::wait(WHEEL_STEP_GAP)?;
		}
		before_wheel()?;
		let event =
			CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::PIXEL, 2, wheel_y, wheel_x, 0)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
		event.set_location(point);
		post_global(&event)?;
	}
	Ok(())
}

/// Posts real `MouseMoved` events `PRIMER_OFFSETS` away from `point` on
/// `side`, ending at `point`.
///
/// A warp moves the cursor without generating any pointer event, and
/// pixel-forwarding surfaces such as iPhone Mirroring only route wheel input
/// to the view under a pointer position they have been sent since their last
/// activation. Without this, a just-activated surface drops the wheel.
fn prime_pointer(source: &CGEventSource, point: CGPoint, side: f64) -> CoreResult<()> {
	for (index, offset) in PRIMER_OFFSETS.into_iter().enumerate() {
		if index > 0 {
			control::wait(PRIMER_GAP)?;
		}
		post_global_mouse(
			source,
			CGEventType::MouseMoved,
			CGMouseButton::Left,
			CGPoint::new(side.mul_add(offset, point.x), point.y),
			0,
			0,
			CGEventFlags::CGEventFlagNull,
		)?;
	}
	control::wait(PRIMER_SETTLE)?;
	Ok(())
}

/// Splits a pixel scroll into at most `MAX_WHEEL_EVENTS` wheel events whose
/// deltas sum exactly to `(dx, dy)`, each at most `MAX_WHEEL_STEP` pixels per
/// axis unless the distance needs more than `MAX_WHEEL_EVENTS` such events.
///
/// Surfaces that forward wheels to another device cap the distance of one
/// event (iPhone Mirroring moves about 99 points however large it is); in the
/// `AppKit` scroll views measured, per-event pixel deltas add up.
fn wheel_steps(dx: i32, dy: i32) -> Vec<(i32, i32)> {
	let count = dx
		.unsigned_abs()
		.max(dy.unsigned_abs())
		.div_ceil(MAX_WHEEL_STEP)
		.min(MAX_WHEEL_EVENTS);
	// `index <= count` keeps each share between 0 and `total`, so it fits i32.
	let share =
		|total: i32, index: u32| (i64::from(total) * i64::from(index) / i64::from(count)) as i32;
	(0..count)
		.map(|index| {
			(share(dx, index + 1) - share(dx, index), share(dy, index + 1) - share(dy, index))
		})
		.collect()
}

fn held_flags(keys: &[KeyName]) -> CGEventFlags {
	modifier_flags(control::key_modifiers(keys))
}

/// HID drag along `path` with the real pointer following it.
///
/// Events come from a `CombinedSessionState` source, so `WindowServer` carries
/// the pressed button from the press through every drag event instead of
/// reading each one against the idle hardware state, and they carry the
/// click state and pressure a hardware drag has.
fn global_drag(
	path: &[(f64, f64)],
	button: MouseButton,
	keys: &[KeyName],
	hid_source: &CGEventSource,
) -> CoreResult<()> {
	if path.len() < 2 {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	}
	let points = path
		.iter()
		.map(|&(x, y)| point(x, y))
		.collect::<CoreResult<Vec<_>>>()?;
	let start = points[0];
	let source = event_source(CGEventSourceStateID::CombinedSessionState)?;
	let (cg_button, down, up, dragged, number) = button_types(button);
	let post = |event_type: CGEventType,
	            location: CGPoint,
	            pressed: bool,
	            flags: CGEventFlags|
	 -> CoreResult<()> {
		let event = CGEvent::new_mouse_event(source.clone(), event_type, location, cg_button)
			.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
		event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, i64::from(pressed));
		event.set_double_value_field(EventField::MOUSE_EVENT_PRESSURE, f64::from(u8::from(pressed)));
		if number != 0 {
			event.set_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER, number);
		}
		event.set_flags(flags);
		post_global(&event)
	};
	for &key in keys {
		key_code(key)?;
	}
	warp_pointer(start)?;
	let flags = held_flags(keys);
	let result = with_held_keys(hid_source, keys, KEY_GAP, post_global, || {
		post(CGEventType::MouseMoved, start, false, flags)?;
		control::wait(Duration::from_millis(30))?;
		post(down, start, true, flags)?;
		let mut last = start;
		let result = (|| {
			for &location in &points[1..] {
				control::wait(Duration::from_millis(16))?;
				post(dragged, location, true, flags)?;
				last = location;
			}
			control::wait(Duration::from_millis(50))
		})();
		let release = control::cleanup(|| post(up, last, false, flags));
		skylight::after_cleanup(result, release)
	});
	// Lets the target release its pointer capture before focus is restored.
	result.and_then(|()| control::wait(Duration::from_millis(100)))
}

fn post_global_mouse(
	source: &CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	location: CGPoint,
	click_state: i64,
	button_number: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source.clone(), event_type, location, button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
	event.set_integer_value_field(EventField::MOUSE_EVENT_CLICK_STATE, click_state);
	if button_number != 0 {
		event.set_integer_value_field(EventField::MOUSE_EVENT_BUTTON_NUMBER, button_number);
	}
	event.set_flags(flags);
	post_global(&event)
}

fn post_global(event: &CGEvent) -> CoreResult<()> {
	control::check()?;
	event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, control::SYNTHETIC_EVENT_TAG);
	event.post(CGEventTapLocation::HID);
	Ok(())
}

fn point(x: f64, y: f64) -> CoreResult<CGPoint> {
	Ok(CGPoint::new(
		f64::from(finite_i32(x, "x coordinate")?),
		f64::from(finite_i32(y, "y coordinate")?),
	))
}

fn finite_i32(value: f64, name: &str) -> CoreResult<i32> {
	if !value.is_finite() || value < f64::from(i32::MIN) || value > f64::from(i32::MAX) {
		return Err(DesktopError::input_failed(format!(
			"{name} {value} is outside the macOS input range"
		)));
	}
	Ok(value.round() as i32)
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::desktop::error::ErrorCode;

	fn shift_transition(event: &CGEvent) -> (i64, u32, bool) {
		(
			event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE),
			event.get_type() as u32,
			event.get_flags().contains(CGEventFlags::CGEventFlagShift),
		)
	}

	const SHIFT_SPACE_TRANSITIONS: [(i64, u32, bool); 4] = [
		(56, CGEventType::FlagsChanged as u32, true),
		(49, CGEventType::KeyDown as u32, true),
		(49, CGEventType::KeyUp as u32, true),
		(56, CGEventType::FlagsChanged as u32, false),
	];

	#[test]
	fn cancelled_bounded_hold_releases_space_and_modifiers() {
		let source = source().expect("event source");
		let cancellation = control::CancellationSource::default();
		let token = cancellation.token();
		let mut events = Vec::new();
		let result = control::with_token_for_test(&token, || {
			with_held_keys(
				&source,
				&[KeyName::Shift, KeyName::Space],
				KEY_GAP,
				|event| {
					events.push(shift_transition(event));
					Ok(())
				},
				|| {
					cancellation.cancel();
					control::wait(Duration::from_secs(100))
				},
			)
		});
		assert!(result.is_err());
		assert_eq!(events, SHIFT_SPACE_TRANSITIONS);
		assert!(token.check().is_err());
	}

	#[test]
	fn partial_held_key_delivery_still_releases_every_attempted_key() {
		let source = source().expect("event source");
		let mut events = Vec::new();
		let result = with_held_keys(
			&source,
			&[KeyName::Shift, KeyName::Space],
			KEY_GAP,
			|event| {
				let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
				events.push(shift_transition(event));
				if code == 49 && matches!(event.get_type(), CGEventType::KeyDown) {
					Err(DesktopError::input_failed("delivery may be partial"))
				} else {
					Ok(())
				}
			},
			|| panic!("failed press must not run the hold"),
		);
		assert!(result.is_err());
		assert_eq!(events, SHIFT_SPACE_TRANSITIONS);
	}

	#[test]
	fn cancelling_text_releases_current_grapheme_and_stops() {
		let source = source().expect("event source");
		let cancellation = control::CancellationSource::default();
		let token = cancellation.token();
		let mut events = Vec::new();
		let result = control::with_token_for_test(&token, || {
			let keys = typed_keys("e\u{301}later", us_stroke, None).unwrap();
			type_keys(
				&source,
				&keys,
				KEY_GAP,
				|| Ok(()),
				|event| {
					events.push(event.get_type());
					if matches!(event.get_type(), CGEventType::KeyDown) {
						cancellation.cancel();
					}
					Ok(())
				},
			)
		});
		assert!(result.is_err());
		assert!(matches!(events.as_slice(), [CGEventType::KeyDown, CGEventType::KeyUp]));
		assert!(cancellation.token().check().is_ok());
		assert!(token.check().is_err());
	}

	/// The US layout's keys for the characters these tests type; `€` needs
	/// Shift-Option, `é` and `😀` have no key.
	fn us_stroke(character: char) -> Option<Keystroke> {
		let key = |code, shift, option| Some(Keystroke { code, shift, option });
		match character {
			'a' => key(0, false, false),
			'b' => key(11, false, false),
			'B' => key(11, true, false),
			'C' => key(8, true, false),
			' ' => key(49, false, false),
			'\r' => key(36, false, false),
			'€' => key(19, true, true),
			'å' => key(0, false, true),
			_ => None,
		}
	}

	/// (event type, key code, Shift flag, Option flag, Unicode payload).
	fn typed_event(event: &CGEvent) -> (u32, i64, bool, bool, String) {
		let mut units = [0u16; MAX_EVENT_UNITS];
		let mut length = 0;
		// SAFETY: `event` is live and `units` holds the capacity passed.
		unsafe {
			keyboard_get_unicode_string(
				event.as_ptr(),
				units.len(),
				&raw mut length,
				units.as_mut_ptr(),
			);
		}
		let flags = event.get_flags();
		(
			event.get_type() as u32,
			event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE),
			flags.contains(CGEventFlags::CGEventFlagShift),
			flags.contains(CGEventFlags::CGEventFlagAlternate),
			String::from_utf16_lossy(&units[..length]),
		)
	}

	#[test]
	fn typed_text_posts_layout_keys_and_holds_shift_only_across_shifted_keys() {
		let source = source().expect("event source");
		let keys = typed_keys("aBC b\r\n😀", us_stroke, None).unwrap();
		let mut events = Vec::new();
		type_keys(
			&source,
			&keys,
			Duration::ZERO,
			|| Ok(()),
			|event| {
				events.push(typed_event(event));
				Ok(())
			},
		)
		.unwrap();
		let (down, up, flags) =
			(CGEventType::KeyDown as u32, CGEventType::KeyUp as u32, CGEventType::FlagsChanged as u32);
		let key = |kind, code, shift, text: &str| (kind, code, shift, false, text.to_string());
		assert_eq!(events, [
			key(down, 0, false, "a"),
			key(up, 0, false, "a"),
			key(flags, 56, true, ""),
			key(down, 11, true, "B"),
			key(up, 11, true, "B"),
			key(down, 8, true, "C"),
			key(up, 8, true, "C"),
			key(flags, 56, false, ""),
			key(down, 49, false, " "),
			key(up, 49, false, " "),
			key(down, 11, false, "b"),
			key(up, 11, false, "b"),
			key(down, 36, false, "\r\n"),
			key(up, 36, false, "\r\n"),
			// No key types it: virtual key 0 carries the text.
			key(down, 0, false, "😀"),
			key(up, 0, false, "😀"),
		]);
	}

	#[test]
	fn failed_shifted_key_still_releases_shift() {
		let source = source().expect("event source");
		let keys = typed_keys("Ba", us_stroke, None).unwrap();
		let mut events = Vec::new();
		let result = type_keys(
			&source,
			&keys,
			Duration::ZERO,
			|| Ok(()),
			|event| {
				let typed = typed_event(event);
				let failed = typed.0 == CGEventType::KeyDown as u32 && typed.1 == 11;
				events.push(typed);
				if failed {
					Err(DesktopError::input_failed("focus changed"))
				} else {
					Ok(())
				}
			},
		);
		assert!(result.is_err());
		let kinds: Vec<_> = events
			.iter()
			.map(|event| (event.0, event.1, event.2))
			.collect();
		assert_eq!(kinds, [
			(CGEventType::FlagsChanged as u32, 56, true),
			(CGEventType::KeyDown as u32, 11, true),
			(CGEventType::KeyUp as u32, 11, true),
			(CGEventType::FlagsChanged as u32, 56, false),
		]);
	}

	#[test]
	fn failed_modifier_release_is_retried_by_cleanup() {
		let source = source().expect("event source");
		let keys = typed_keys("Ba", us_stroke, None).unwrap();
		let mut events = Vec::new();
		let mut releases = 0;
		let result = type_keys(
			&source,
			&keys,
			Duration::ZERO,
			|| Ok(()),
			|event| {
				let typed = typed_event(event);
				let shift_up = typed.0 == CGEventType::FlagsChanged as u32 && typed.1 == 56 && !typed.2;
				events.push((typed.0, typed.1, typed.2));
				if shift_up {
					releases += 1;
					if releases == 1 {
						return Err(DesktopError::input_failed("cancelled"));
					}
				}
				Ok(())
			},
		);
		assert!(result.is_err());
		// The failed Shift release is attempted again, and a is never pressed.
		assert_eq!(events, [
			(CGEventType::FlagsChanged as u32, 56, true),
			(CGEventType::KeyDown as u32, 11, true),
			(CGEventType::KeyUp as u32, 11, true),
			(CGEventType::FlagsChanged as u32, 56, false),
			(CGEventType::FlagsChanged as u32, 56, false),
		]);
	}

	/// (event type, key code, Shift flag) of the events takeover typing posts
	/// when focus moves right after the event `lose_after` matches.
	fn takeover_typing(
		text: &str,
		lose_after: (CGEventType, i64),
	) -> (CoreResult<()>, Vec<(u32, i64, bool)>) {
		let source = source().expect("event source");
		let keys = typed_keys(text, us_stroke, None).unwrap();
		let lost = std::cell::Cell::new(false);
		let mut posted = Vec::new();
		let result = type_keys(
			&source,
			&keys,
			Duration::ZERO,
			|| {
				if lost.get() {
					Err(DesktopError::input_failed("focus moved"))
				} else {
					Ok(())
				}
			},
			|event| {
				let typed = typed_event(event);
				lost.set(lost.get() || (typed.0, typed.1) == (lose_after.0 as u32, lose_after.1));
				posted.push((typed.0, typed.1, typed.2));
				Ok(())
			},
		);
		(result, posted)
	}

	#[test]
	fn takeover_typing_checks_focus_before_pressing_a_modifier() {
		let (down, up, flags) =
			(CGEventType::KeyDown as u32, CGEventType::KeyUp as u32, CGEventType::FlagsChanged as u32);
		// Focus moves after a: neither Shift nor B is pressed.
		let (result, posted) = takeover_typing("aB", (CGEventType::KeyUp, 0));
		assert!(result.is_err());
		assert_eq!(posted, [(down, 0, false), (up, 0, false)]);
		// Focus moves after Shift goes down: B is refused, Shift still released.
		let (result, posted) = takeover_typing("Ba", (CGEventType::FlagsChanged, 56));
		assert!(result.is_err());
		assert_eq!(posted, [(flags, 56, true), (flags, 56, false)]);
	}

	#[test]
	fn key_and_modifier_presses_are_guarded_but_releases_are_not() {
		let source = source().expect("event source");
		let presses: Vec<bool> =
			[(KeyName::Shift, true), (KeyName::Shift, false), (KeyName::Meta, true)]
				.into_iter()
				.map(|(key, down)| {
					let mut modifiers = Modifiers::default();
					update_modifier(&mut modifiers, key, down);
					let mut press = false;
					post_key(&source, key, down, modifier_flags(modifiers), &mut |event| {
						press = is_key_press(event);
						Ok(())
					})
					.unwrap();
					press
				})
				.collect();
		assert_eq!(presses, [true, false, true]);
		let key = |down| CGEvent::new_keyboard_event(source.clone(), 0, down).unwrap();
		assert!(is_key_press(&key(true)));
		assert!(!is_key_press(&key(false)));
		let refused = post_guarded(
			&key(true),
			|| Err(DesktopError::input_failed("focus moved")),
			|_| panic!("a refused press must not post"),
		);
		assert!(refused.is_err());
		assert!(post_guarded(&key(false), || panic!("a release is not guarded"), |_| Ok(())).is_ok());
	}

	/// The transitions `post_transitions` posts for "aB" on a remote screen,
	/// with focus lost after `lose_after` and the first post of `fail` failing.
	fn remote_takeover(
		lose_after: Option<(u16, bool)>,
		fail: Option<(u16, bool)>,
	) -> (CoreResult<()>, Vec<(u16, bool)>) {
		let keys = typed_keys("aB", us_stroke, Some(RemoteScreen::HidReports)).unwrap();
		let lost = std::cell::Cell::new(false);
		let mut failed = false;
		let mut posted = Vec::new();
		let result = post_transitions(
			&bare_transitions(&keys),
			Duration::ZERO,
			|| {
				if lost.get() {
					Err(DesktopError::input_failed("focus moved"))
				} else {
					Ok(())
				}
			},
			|code, down| {
				posted.push((code, down));
				if !failed && fail == Some((code, down)) {
					failed = true;
					return Err(DesktopError::input_failed("post failed"));
				}
				lost.set(lost.get() || lose_after == Some((code, down)));
				Ok(())
			},
		);
		(result, posted)
	}

	#[test]
	fn remote_takeover_stops_pressing_when_focus_moves_and_releases_held_keys() {
		let (result, posted) = remote_takeover(None, None);
		assert!(result.is_ok());
		assert_eq!(posted, [(0, true), (0, false), (56, true), (11, true), (11, false), (56, false)]);
		let (result, posted) = remote_takeover(Some((0, false)), None);
		assert!(result.is_err());
		assert_eq!(posted, [(0, true), (0, false)]);
		let (result, posted) = remote_takeover(Some((56, true)), None);
		assert!(result.is_err());
		assert_eq!(posted, [(0, true), (0, false), (56, true), (56, false)]);
		// A release that fails is attempted again, with Shift's.
		let (result, posted) = remote_takeover(None, Some((11, false)));
		assert!(result.is_err());
		assert_eq!(posted, [
			(0, true),
			(0, false),
			(56, true),
			(11, true),
			(11, false),
			(56, false),
			(11, false)
		]);
	}

	/// Runs `presses` key presses (and releases) under a watch that reads
	/// `samples` in turn, repeating the last.
	fn watch_presses(
		samples: &[(bool, u32)],
		presses: usize,
	) -> (CoreResult<Option<String>>, usize) {
		let source = source().expect("event source");
		let mut samples = samples.iter().copied();
		let mut last = (false, 0);
		let sample = move || {
			last = samples.next().unwrap_or(last);
			ModifierSample { held: last.0, changes: last.1 }
		};
		let mut watch = Some(ModifierWatch::new(sample, Duration::from_millis(20)));
		let mut posted = 0;
		let result = (|| {
			for _ in 0..presses {
				for down in [true, false] {
					let event = CGEvent::new_keyboard_event(source.clone(), 0, down).unwrap();
					post_watched(watch.as_mut(), &event, |_| {
						posted += 1;
						Ok(())
					})?;
				}
			}
			Ok(())
		})();
		(watched(result, watch), posted)
	}

	#[test]
	fn screen_sharing_keys_wait_for_the_users_modifiers_and_report_overlaps() {
		// Shift is down for two reads, then released: the key waits, then goes.
		let (result, posted) = watch_presses(&[(true, 1), (true, 1), (false, 2)], 2);
		assert_eq!(result.unwrap(), None);
		assert_eq!(posted, 4);
		// A modifier changes after the second press: it is reported.
		let (result, posted) = watch_presses(&[(false, 0), (false, 0), (false, 0), (false, 1)], 2);
		assert_eq!(posted, 4);
		let notice = result.unwrap().expect("notice");
		assert!(notice.contains("key press(es) 2 of 2"), "{notice}");
		// A modifier stays down: the second key is refused before posting, and
		// the first, sent while it went down, is reported in the error.
		let (result, posted) = watch_presses(&[(false, 0), (true, 1)], 2);
		assert_eq!(posted, 2);
		let error = result.unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		assert!(error.message.contains("1 key press(es) were sent"), "{}", error.message);
		assert!(error.message.contains("key press(es) 1 of 1"), "{}", error.message);
	}

	#[test]
	fn option_and_keyless_text_stay_unicode_except_on_a_remote_screen() {
		// Option can be a shortcut or Meta in a local app, so its characters
		// keep the Unicode payload there; a remote screen gets the key.
		assert_eq!(typed_keys("€😀", us_stroke, None).unwrap(), [
			TypedKey::Unicode("€"),
			TypedKey::Unicode("😀"),
		]);
		assert_eq!(typed_keys("€", us_stroke, Some(RemoteScreen::KeyEvents)).unwrap(), [
			TypedKey::Layout(Keystroke { code: 19, shift: true, option: true }, "€"),
		]);
		// A remote screen ignores the Unicode payload, so text no key types
		// refuses before anything is posted, naming each character once.
		let error = typed_keys("a😀bé😀", us_stroke, Some(RemoteScreen::HidReports)).unwrap_err();
		assert_eq!(error.code, ErrorCode::InvalidKey);
		assert!(error.message.contains("types 😀 é;"), "{}", error.message);
	}

	#[test]
	fn unicode_runs_fit_one_keyboard_event_without_splitting_characters() {
		let lengths = |text: &str| -> Vec<usize> {
			unicode_runs(text)
				.map(|run| run.encode_utf16().count())
				.collect()
		};
		assert_eq!(lengths(&format!("e{}", "\u{301}".repeat(24))), [20, 5]);
		assert_eq!(lengths(&format!("a{}", "😀".repeat(10))), [19, 2]);
		assert_eq!(lengths(""), Vec::<usize>::new());
	}

	#[test]
	fn remote_takeover_presses_modifier_keys_and_background_names_what_needs_them() {
		let keys = typed_keys("BC€a", us_stroke, Some(RemoteScreen::KeyEvents)).unwrap();
		// Shift is held across B and C, Option joins it for €, and both are
		// released before the plain a.
		assert_eq!(bare_transitions(&keys), [
			(56, true),
			(11, true),
			(11, false),
			(8, true),
			(8, false),
			(58, true),
			(19, true),
			(19, false),
			(56, false),
			(58, false),
			(0, true),
			(0, false),
		]);
		assert_eq!(modified_text(&keys), ["B", "C", "€"]);
		assert!(
			modified_text(&typed_keys("ab", us_stroke, Some(RemoteScreen::KeyEvents)).unwrap())
				.is_empty()
		);
		// Option alone also needs a modifier the remote reads from the keyboard.
		assert_eq!(
			modified_text(&typed_keys("aå", us_stroke, Some(RemoteScreen::KeyEvents)).unwrap()),
			["å"]
		);
	}

	#[test]
	fn only_hid_report_devices_get_slow_key_pacing() {
		assert_eq!(key_gap(Some(RemoteScreen::HidReports)), REPORT_KEY_GAP);
		assert_eq!(key_gap(Some(RemoteScreen::KeyEvents)), KEY_GAP);
		assert_eq!(key_gap(None), KEY_GAP);
	}

	#[test]
	fn cancelling_chord_releases_modifier_without_pressing_next_key() {
		let source = source().expect("event source");
		let cancellation = control::CancellationSource::default();
		let token = cancellation.token();
		let mut events = Vec::new();
		let result = control::with_token_for_test(&token, || {
			key_chord(&source, &[KeyName::Ctrl, KeyName::Char('a')], KEY_GAP, |event| {
				events.push((
					event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE),
					event.get_flags().contains(CGEventFlags::CGEventFlagControl),
				));
				if events.len() == 1 {
					cancellation.cancel();
				}
				Ok(())
			})
		});
		assert!(result.is_err());
		assert_eq!(events, [(59, true), (59, false)]);
	}

	#[test]
	fn event_source_never_suppresses_local_input() {
		let source = source().expect("Quartz event source");
		// SAFETY: `source` remains live for both CoreGraphics getter calls.
		unsafe {
			assert_eq!(get_local_events_suppression_interval(source.as_ptr()), 0.0);
			assert_eq!(
				get_local_events_filter_during_suppression_state(source.as_ptr(), SUPPRESSION_INTERVAL,),
				LOCAL_EVENT_FILTER,
			);
			assert_eq!(
				get_local_events_filter_during_suppression_state(source.as_ptr(), REMOTE_MOUSE_DRAG,),
				LOCAL_EVENT_FILTER,
			);
		}
	}

	fn record(id: u32, minimized: Option<bool>) -> ax::AxWindowRecord {
		ax::AxWindowRecord { id, minimized }
	}

	#[test]
	fn keyboard_destination_counts_only_windows_that_can_be_key() {
		assert_eq!(keyboard_conflict(10, &[record(10, Some(false))]), None);
		assert_eq!(keyboard_conflict(10, &[record(10, Some(false)), record(11, Some(true))]), None);
		assert_eq!(
			keyboard_conflict(10, &[
				record(10, Some(false)),
				record(11, None),
				record(12, Some(false))
			]),
			Some(KeyboardConflict::Siblings(2)),
		);
		assert_eq!(
			keyboard_conflict(10, &[record(11, Some(false))]),
			Some(KeyboardConflict::Unmapped),
		);
	}

	#[test]
	fn interrupted_chord_releases_every_attempted_key() {
		let source = source().expect("Quartz event source");
		let mut events = Vec::new();
		let result = key_chord(&source, &[KeyName::Ctrl, KeyName::Enter], KEY_GAP, |event| {
			let kind = event.get_type();
			let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
			events.push((
				kind as u32,
				code,
				event.get_flags().contains(CGEventFlags::CGEventFlagControl),
			));
			if matches!(kind, CGEventType::KeyDown) && code == 36 {
				Err(DesktopError::input_failed("focus changed"))
			} else {
				Ok(())
			}
		});
		assert!(result.is_err());
		// Quartz expresses modifier transitions as FlagsChanged; the final
		// cleared flag proves Ctrl is released even when Enter's press fails.
		assert_eq!(events, vec![
			(CGEventType::FlagsChanged as u32, 59, true),
			(CGEventType::KeyDown as u32, 36, true),
			(CGEventType::KeyUp as u32, 36, true),
			(CGEventType::FlagsChanged as u32, 59, false),
		]);
	}

	#[test]
	fn failed_modifier_press_leaves_no_flag_on_cleanup_releases() {
		let source = source().expect("Quartz event source");
		let mut events = Vec::new();
		let result =
			key_chord(&source, &[KeyName::Ctrl, KeyName::Shift, KeyName::Enter], KEY_GAP, |event| {
				let kind = event.get_type();
				let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
				let flags = event.get_flags();
				let shift = flags.contains(CGEventFlags::CGEventFlagShift);
				events.push((
					kind as u32,
					code,
					flags.contains(CGEventFlags::CGEventFlagControl),
					shift,
				));
				if code == 56 && shift {
					Err(DesktopError::input_failed("focus changed"))
				} else {
					Ok(())
				}
			});
		assert!(result.is_err());
		// Shift's failed press is released first, so no later release still
		// carries its flag.
		assert_eq!(events, vec![
			(CGEventType::FlagsChanged as u32, 59, true, false),
			(CGEventType::FlagsChanged as u32, 56, true, true),
			(CGEventType::FlagsChanged as u32, 56, true, false),
			(CGEventType::FlagsChanged as u32, 59, false, false),
		]);
	}

	#[test]
	fn takeover_requires_exact_hit_test_ownership() {
		let owner = |pid, window| ax::PointOwner { pid, window };
		assert!(!covers(&owner(7, Some(42)), 7, 42));
		assert!(covers(&owner(7, Some(43)), 7, 42));
		assert!(covers(&owner(7, None), 7, 42));
		assert!(covers(&owner(8, Some(42)), 7, 42));
		assert!(covers(&owner(8, None), 7, 42));
	}

	#[test]
	fn scroll_primer_starts_inside_the_target_window() {
		let window = DesktopWindow {
			id:      "42".to_string(),
			title:   String::new(),
			app:     String::new(),
			pid:     Some(7),
			x:       100,
			y:       50,
			width:   300,
			height:  200,
			focused: false,
		};
		let scroll = |x| PointerEvent::Scroll { x, y: 80.0, dx: 0.0, dy: -30.0 };
		for x in [100.0, 101.0, 249.0, 250.0, 398.0, 399.0] {
			let [Some((start, _)), Some((end, _))] = event_points(&window, &scroll(x)) else {
				panic!("a scroll at {x} must hit-test its primer start and its point");
			};
			assert_eq!(end, x);
			assert!((100.0..400.0).contains(&start), "primer for {x} starts outside at {start}");
			assert_eq!((start - x).abs(), PRIMER_OFFSETS[0]);
		}
	}

	#[test]
	fn key_window_step_never_moves_the_frontmost_applications_key_window() {
		// A non-key window of the frontmost app shares the user's key window:
		// preparing it would send the user's next keystrokes and pastes there.
		let unread =
			|| -> Option<u32> { panic!("a background process's focused window is not read") };
		assert_eq!(front_target(Some(9), 7, 42, unread), FrontTarget::Background);
		assert_eq!(front_target(None, 7, 42, unread), FrontTarget::Background);
		assert_eq!(front_target(Some(7), 7, 42, || Some(42)), FrontTarget::Key);
		assert_eq!(front_target(Some(7), 7, 42, || Some(43)), FrontTarget::UserSibling);
		assert_eq!(front_target(Some(7), 7, 42, || None), FrontTarget::UserSibling);
	}

	#[test]
	fn activating_press_lands_outside_the_target_window() {
		// A press inside the frame would reach the window's own controls: a
		// Chrome tab, Safari's address field, a Finder toolbar button.
		let window = DesktopWindow {
			id:      "42".to_string(),
			title:   String::new(),
			app:     String::new(),
			pid:     Some(7),
			x:       100,
			y:       50,
			width:   300,
			height:  200,
			focused: false,
		};
		let (location, local) = activating_press(&window);
		assert!(local.x < 0.0 && local.y < 0.0, "window-local {local:?} is inside the frame");
		assert!(location.x < 100.0 && location.y < 50.0, "press at {location:?} is inside the frame");
		assert_eq!((location.x - local.x, location.y - local.y), (100.0, 50.0));
	}

	#[test]
	fn wheel_steps_split_into_bounded_events_that_sum_to_the_request() {
		assert_eq!(wheel_steps(0, -300), vec![(0, -30); 10]);
		assert_eq!(wheel_steps(0, 30), vec![(0, 30)]);
		assert_eq!(wheel_steps(0, 0), Vec::<(i32, i32)>::new());
		// (dx, dy, event count, largest per-axis step allowed)
		for (dx, dy, count, largest) in [
			(0, -31, 2, 30),
			(7, 95, 4, 30),
			(-301, 44, 11, 30),
			(1, -1, 1, 30),
			(0, 1200, 40, 30),
			(0, -1201, 40, 31),
			(-100_003, 2, 40, 2501),
			(i32::MIN, i32::MAX, 40, 53_687_092),
		] {
			let steps = wheel_steps(dx, dy);
			assert_eq!(steps.len(), count, "({dx}, {dy})");
			assert!(
				steps
					.iter()
					.all(|&(x, y)| x.unsigned_abs() <= largest && y.unsigned_abs() <= largest),
				"({dx}, {dy}) exceeded {largest} px per event: {steps:?}"
			);
			assert_eq!(steps.iter().map(|step| step.0).sum::<i32>(), dx);
			assert_eq!(steps.iter().map(|step| step.1).sum::<i32>(), dy);
		}
	}
}
