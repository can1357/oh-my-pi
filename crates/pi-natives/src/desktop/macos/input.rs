use std::{
	ptr, thread,
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

use super::{
	super::{
		backend::{DeliveryMode, Modifiers, MouseButton, PointerEvent},
		error::{CoreResult, DesktopError},
		keys::KeyName,
		types::{DesktopWindow, Target},
	},
	ax,
	capture::MacCapture,
	process, skylight,
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
			Target::Desktop => global_pointer(&self.source, event),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, pid, &event)?;
						skylight::with_background_guard(pid, || {
							background_pointer(&self.source, pid, wid, &window, event)
						})
					},
					DeliveryMode::Foreground => {
						foreground_pointer(&self.source, &window, pid, wid, event)
					},
				}
			},
		}
	}

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
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_type(&self.source, text),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						if process::is_screen_sharing(pid) {
							return Err(screen_sharing_refusal(&window, "synthesized text"));
						}
						if !process::is_terminal(pid) && ax::insert_native_text(pid, wid, text)? {
							return Ok(());
						}
						ensure_sole_keyboard_destination(pid, wid)?;
						skylight::with_background_guard(pid, || {
							skylight::with_focus_without_raise(pid, wid, || {
								background_type(&self.source, pid, text)
							})
						})
					},
					DeliveryMode::Foreground => {
						// Screen Sharing relays physical key transitions only; map the
						// whole text before activating so a gap refuses cleanly.
						let physical = if process::is_screen_sharing(pid) {
							Some(physical_transitions(text)?)
						} else {
							None
						};
						skylight::with_foreground(pid, wid, |activated| {
							thread::sleep(first_key_settle(activated));
							match &physical {
								Some(transitions) => {
									skylight::require_front_window(pid, wid)?;
									post_bare_keys(transitions)
								},
								None => type_text(&self.source, text, |event| {
									post_takeover_key(pid, wid, event)
								}),
							}
						})
					},
				}
			},
		}
	}

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
	) -> CoreResult<()> {
		match target {
			Target::Desktop => global_chord(&self.source, keys),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						if keys.iter().copied().any(is_modifier) && process::is_screen_sharing(pid) {
							return Err(screen_sharing_refusal(
								&window,
								"modifier flags on routed chords",
							));
						}
						ensure_sole_keyboard_destination(pid, wid)?;
						skylight::with_background_guard(pid, || {
							skylight::with_focus_without_raise(pid, wid, || {
								background_chord(&self.source, pid, keys)
							})
						})
					},
					DeliveryMode::Foreground => {
						skylight::with_foreground(pid, wid, |activated| {
							thread::sleep(first_key_settle(activated));
							key_chord(&self.source, keys, |event| post_takeover_key(pid, wid, event))
						})
					},
				}
			},
		}
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

fn screen_sharing_refusal(window: &DesktopWindow, dropped: &str) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {} ({}) forwards only physical key transitions to the remote host and drops \
		 background {dropped}; retry with takeover:true or use ax actions",
		window.id, window.app,
	))
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

/// Refuses background keystrokes unless `wid` is provably the only window of
/// its process that can be key.
///
/// macOS posts key events to a *process*, which hands them to whichever window
/// it treats as key; unlike pointer events they carry no window id, and no
/// focus record or accessibility attribute reliably redirects that choice.
/// Candidates come from the process's accessibility windows, not
/// `WindowServer`'s list, which also holds the per-window compositor surfaces
/// of Chromium, Electron, and `WebKit` apps. `DesktopWindow::focused` cannot
/// disambiguate: it marks every window of the active application.
fn ensure_sole_keyboard_destination(pid: libc::pid_t, wid: u32) -> CoreResult<()> {
	let conflict = ax::window_records(pid)
		.map_or(Some(KeyboardConflict::Unmapped), |records| keyboard_conflict(wid, &records));
	match conflict {
		None => Ok(()),
		Some(KeyboardConflict::Unmapped) => Err(DesktopError::background_unavailable(format!(
			"window {wid} is not among its application's accessibility windows, so background \
			 keystrokes cannot be proven to reach it; retry with takeover:true or use ax actions",
		))),
		Some(KeyboardConflict::Siblings(siblings)) => {
			Err(DesktopError::background_unavailable(format!(
				"window {wid} shares its application with {siblings} other window(s); macOS delivers \
				 background keystrokes to whichever window the application treats as key, so retry \
				 with takeover:true or use ax actions",
			)))
		},
	}
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
const FIELD_BUTTON_NUMBER: u32 = 3;
const FIELD_SUBTYPE: u32 = 7;
/// Target pid, checked by Chromium's synthetic-event filter.
const FIELD_TARGET_PID: u32 = 40;
const FIELD_WINDOW_NUMBER: u32 = 51;
/// Shared id that makes `WindowServer` coalesce one gesture's events.
const FIELD_CLICK_GROUP: u32 = 58;
const FIELD_WINDOW_UNDER_POINTER: u32 = 91;
const FIELD_WINDOW_UNDER_POINTER_THAT_CAN_HANDLE: u32 = 92;
/// `NSEventSubtypeTouch`.
const SUBTYPE_TOUCH: i64 = 3;

/// Lets `WindowServer` apply a pointer warp before HID input at the new
/// location, and lets the target consume a click before focus or the pointer
/// moves on.
const POINTER_SETTLE: Duration = Duration::from_millis(40);
/// Press-to-release gap: an `NSButton` press enters a tracking loop that can
/// miss a release arriving before its first poll.
const PRESS_GAP: Duration = Duration::from_millis(28);
const MULTI_CLICK_GAP: Duration = Duration::from_millis(80);
const KEY_GAP: Duration = Duration::from_millis(8);
/// How long raising an occluded target may take to become visible to
/// hit-testing.
const UNCOVER_TIMEOUT: Duration = Duration::from_millis(300);

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
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsSuppressionInterval"]
	fn get_local_events_suppression_interval(source: CGEventSourceRef) -> f64;
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsFilterDuringSuppressionState"]
	fn get_local_events_filter_during_suppression_state(source: CGEventSourceRef, state: u32)
	-> u32;
}

fn source() -> CoreResult<CGEventSource> {
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
			skylight::with_focus_without_raise(pid, wid, || {
				background_left_click(source, pid, wid, window, x, y, count)
			})
		},
		PointerEvent::Click { x, y, button, count, .. } => {
			background_button_click(source, pid, wid, window, x, y, button, count)
		},
		PointerEvent::Move { x, y } => post_hover(source, pid, wid, window, x, y, click_group_id()),
		PointerEvent::Scroll { x, y, dx, dy } => {
			background_scroll(source, pid, wid, window, x, y, dx, dy)
		},
		PointerEvent::Drag { .. } => Err(DesktopError::background_unavailable(format!(
			"window {wid} cannot receive a background drag on macOS; retry with takeover:true or use \
			 ax actions",
		))),
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
	thread::sleep(Duration::from_millis(15));
	post(CGEventType::LeftMouseDown, offscreen, offscreen, 1, 1)?;
	thread::sleep(Duration::from_millis(1));
	post(CGEventType::LeftMouseUp, offscreen, offscreen, 2, 1)?;
	thread::sleep(Duration::from_millis(100));
	let count = count.max(1);
	for click_state in 1..=count {
		post(CGEventType::LeftMouseDown, target, local, 3, i64::from(click_state))?;
		thread::sleep(Duration::from_millis(1));
		post(CGEventType::LeftMouseUp, target, local, 3, i64::from(click_state))?;
		if click_state < count {
			thread::sleep(MULTI_CLICK_GAP);
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
	thread::sleep(Duration::from_millis(12));
	let count = count.max(1);
	for click_state in 1..=count {
		let press = mouse_event(source, down, CGPoint::new(x, y), cg_button)?;
		post_window_pointer(pid, wid, window, &press, x, y, i64::from(click_state), number, group)?;
		thread::sleep(PRESS_GAP);
		let release = mouse_event(source, up, CGPoint::new(x, y), cg_button)?;
		post_window_pointer(pid, wid, window, &release, x, y, i64::from(click_state), number, group)?;
		if click_state < count {
			thread::sleep(MULTI_CLICK_GAP);
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
/// through both `SkyLight` and the public per-pid queue, which drops or accepts
/// events differently across `AppKit`, `WebKit`, and Catalyst targets. The
/// window location is window-local, as the public route expects.
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
	thread::sleep(Duration::from_millis(12));
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

fn background_type(source: &CGEventSource, pid: libc::pid_t, text: &str) -> CoreResult<()> {
	type_text(source, text, |event| skylight::post_keyboard(pid, event))
}

fn global_type(source: &CGEventSource, text: &str) -> CoreResult<()> {
	type_text(source, text, post_global)
}

fn post_takeover_key(pid: libc::pid_t, wid: u32, event: &CGEvent) -> CoreResult<()> {
	if matches!(event.get_type(), CGEventType::KeyDown) {
		// Stop rather than typing into a newly user-selected app/window. Key
		// releases must still pass through so held modifiers do not leak.
		skylight::require_front_window(pid, wid)?;
	}
	post_global(event)
}

fn type_text(
	source: &CGEventSource,
	text: &str,
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	for character in text.chars() {
		let mut buffer = [0; 4];
		let value = character.encode_utf8(&mut buffer);
		for down in [true, false] {
			let event = CGEvent::new_keyboard_event(source.clone(), 0, down)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			event.set_string(value);
			event.set_flags(CGEventFlags::CGEventFlagNull);
			post(&event)?;
			thread::sleep(KEY_GAP);
		}
	}
	Ok(())
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

/// Physical key transitions `(keycode, down)` that type `text` on a US layout,
/// with Shift pressed around shifted characters. Fails for the whole text
/// before anything is posted when a character has no physical key.
fn physical_transitions(text: &str) -> CoreResult<Vec<(u16, bool)>> {
	let shift = key_code(KeyName::Shift)?;
	let mut transitions = Vec::with_capacity(text.len() * 2);
	for character in text.chars() {
		let (code, shifted) = physical_key(character).ok_or_else(|| {
			DesktopError::invalid_key(format!(
				"Screen Sharing needs physical key transitions and '{character}' has no key on the US \
				 layout; no text was typed"
			))
		})?;
		if shifted {
			transitions.push((shift, true));
		}
		transitions.push((code, true));
		transitions.push((code, false));
		if shifted {
			transitions.push((shift, false));
		}
	}
	Ok(transitions)
}

fn physical_key(character: char) -> Option<(u16, bool)> {
	let named = match character {
		'\n' | '\r' => Some(KeyName::Enter),
		'\t' => Some(KeyName::Tab),
		' ' => Some(KeyName::Space),
		_ => None,
	};
	if let Some(key) = named {
		return key_code(key).ok().map(|code| (code, false));
	}
	let (base, shifted) = match character {
		'A'..='Z' => (character.to_ascii_lowercase(), true),
		'_' => ('-', true),
		'+' => ('=', true),
		'{' => ('[', true),
		'}' => (']', true),
		'|' => ('\\', true),
		':' => (';', true),
		'"' => ('\'', true),
		'<' => (',', true),
		'>' => ('.', true),
		'?' => ('/', true),
		'~' => ('`', true),
		'!' => ('1', true),
		'@' => ('2', true),
		'#' => ('3', true),
		'$' => ('4', true),
		'%' => ('5', true),
		'^' => ('6', true),
		'&' => ('7', true),
		'*' => ('8', true),
		'(' => ('9', true),
		')' => ('0', true),
		_ => (character, false),
	};
	char_key_code(base).ok().map(|code| (code, shifted))
}

/// Posts bare key transitions at the HID tap: a null source and no flag or
/// Unicode overrides, so `CoreGraphics` derives modifier state from the
/// transitions exactly as for a hardware keyboard.
fn post_bare_keys(transitions: &[(u16, bool)]) -> CoreResult<()> {
	for &(code, down) in transitions {
		// SAFETY: A null source is documented as valid for keyboard events.
		let raw = unsafe { create_keyboard_event(ptr::null_mut(), code, down) };
		if raw.is_null() {
			return Err(DesktopError::input_failed("failed to create a Quartz keyboard event"));
		}
		// SAFETY: `raw` is a non-null create-rule event whose ownership moves here.
		let event = unsafe { CGEvent::from_ptr(raw) };
		event.post(CGEventTapLocation::HID);
		thread::sleep(KEY_GAP);
	}
	Ok(())
}

fn background_chord(source: &CGEventSource, pid: libc::pid_t, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, |event| skylight::post_keyboard(pid, event))
}

fn global_chord(source: &CGEventSource, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, post_global)
}

fn key_chord(
	source: &CGEventSource,
	keys: &[KeyName],
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::invalid_key("key chord must not be empty"));
	}
	let mut active = Modifiers::default();
	let mut pressed = 0;
	let mut result = Ok(());
	for &key in keys {
		update_modifier(&mut active, key, true);
		pressed += 1;
		if let Err(error) = post_key(source, key, true, modifier_flags(active), &mut post) {
			result = Err(error);
			break;
		}
		thread::sleep(KEY_GAP);
	}
	let mut cleanup = Ok(());
	for &key in keys[..pressed].iter().rev() {
		update_modifier(&mut active, key, false);
		let release = post_key(source, key, false, modifier_flags(active), &mut post);
		cleanup = skylight::after_cleanup(cleanup, release);
		thread::sleep(KEY_GAP);
	}
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

const fn is_modifier(key: KeyName) -> bool {
	matches!(key, KeyName::Ctrl | KeyName::Alt | KeyName::Shift | KeyName::Meta)
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
			let mut occluder = None;
			let result = uncover(window, pid, wid, &event, &mut occluder)
				.and_then(|()| skylight::require_front_window(pid, wid))
				.and_then(|()| global_pointer(source, event));
			// Capture before raising, so even a failed raise/re-hit-test retains
			// the restoration token. Never reorder over a user-selected app.
			let cleanup = if skylight::is_front_window(pid, wid) {
				occluder.map_or(Ok(()), |occluder: Occluder| {
					ax::raise_window_id(occluder.pid, occluder.window)
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
	let points = event_points(event);
	let covering = || -> CoreResult<Option<ax::PointOwner>> {
		let mut first = None;
		for (x, y) in points.into_iter().flatten() {
			let owner = ax::point_owner(x, y).ok_or_else(|| DesktopError::input_failed(format!(
				"cannot determine which window owns takeover point ({x}, {y}); no input was sent"
			)))?;
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
	*occluder = first.window.map(|window| Occluder { pid: first.pid, window });
	ax::MacAx::new().raise(window)?;
	let deadline = Instant::now() + UNCOVER_TIMEOUT;
	loop {
		match covering()? {
			None => return Ok(()),
			Some(owner) if Instant::now() >= deadline => {
				return Err(DesktopError::input_failed(format!(
					"window {wid} stays covered by process {} at the takeover input point, so the \
					 input would land on the covering window; no input was sent",
					owner.pid,
				)));
			},
			Some(_) => thread::sleep(Duration::from_millis(20)),
		}
	}
}

/// Whether the surface at a point belongs to something other than the target
/// window. A same-process panel or unknown window id is not exact ownership.
fn covers(owner: &ax::PointOwner, pid: libc::pid_t, wid: u32) -> bool {
	owner.pid != pid || owner.window != Some(wid)
}

/// The global points a pointer event hits first and last.
fn event_points(event: &PointerEvent) -> [Option<(f64, f64)>; 2] {
	match event {
		PointerEvent::Click { x, y, .. }
		| PointerEvent::Move { x, y }
		| PointerEvent::Scroll { x, y, .. } => [Some((*x, *y)), None],
		PointerEvent::Drag { path, .. } => [path.first().copied(), path.last().copied()],
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
fn warp_pointer(point: CGPoint) {
	let _ = CGDisplay::warp_mouse_cursor_position(point);
	// Re-couples the mouse-delta stream so the next event hit-tests at the
	// warped point instead of freezing local input.
	let _ = CGDisplay::associate_mouse_and_mouse_cursor_position(true);
	thread::sleep(POINTER_SETTLE);
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
	let release = |held: &mut Modifiers| {
		for key in ORDER.into_iter().rev() {
			if modifier_held(*held, key) {
				update_modifier(held, key, false);
				let _ = post_key(source, key, false, modifier_flags(*held), &mut post_global);
				thread::sleep(KEY_GAP);
			}
		}
	};
	for key in ORDER {
		if !modifier_held(modifiers, key) {
			continue;
		}
		update_modifier(&mut held, key, true);
		if let Err(error) = post_key(source, key, true, modifier_flags(held), &mut post_global) {
			release(&mut held);
			return Err(error);
		}
		thread::sleep(KEY_GAP);
	}
	let result = gesture(modifier_flags(held));
	release(&mut held);
	result
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
			warp_pointer(point);
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
					thread::sleep(Duration::from_millis(12));
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
					thread::sleep(PRESS_GAP);
					post_global_mouse(
						source,
						up,
						cg_button,
						point,
						i64::from(click_state),
						number,
						flags,
					)?;
					if click_state < count {
						thread::sleep(MULTI_CLICK_GAP);
					}
				}
				Ok(())
			});
			thread::sleep(POINTER_SETTLE);
			result
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
		PointerEvent::Drag { path, button, modifiers } => {
			global_drag(&path, button, modifiers, source)
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			let point = point(x, y)?;
			let wheel_x = finite_i32(dx, "horizontal scroll delta")?;
			let wheel_y = finite_i32(dy, "vertical scroll delta")?;
			let event = CGEvent::new_scroll_event(
				source.clone(),
				ScrollEventUnit::PIXEL,
				2,
				wheel_y,
				wheel_x,
				0,
			)
			.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
			event.set_location(point);
			// Wheel events go to the window under the real pointer.
			warp_pointer(point);
			post_global(&event)
		},
	}
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
	modifiers: Modifiers,
	hid_source: &CGEventSource,
) -> CoreResult<()> {
	if path.len() < 2 {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	}
	let points = path
		.iter()
		.map(|&(x, y)| point(x, y))
		.collect::<CoreResult<Vec<_>>>()?;
	let (start, end) = (points[0], points[points.len() - 1]);
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
	warp_pointer(start);
	let result = with_global_modifiers(hid_source, modifiers, |flags| {
		post(CGEventType::MouseMoved, start, false, flags)?;
		thread::sleep(Duration::from_millis(30));
		post(down, start, true, flags)?;
		for &location in &points[1..] {
			thread::sleep(Duration::from_millis(16));
			post(dragged, location, true, flags)?;
		}
		thread::sleep(Duration::from_millis(50));
		post(up, end, false, flags)
	});
	// Lets the target release its pointer capture before focus is restored.
	thread::sleep(Duration::from_millis(100));
	result
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

#[allow(
	clippy::unnecessary_wraps,
	reason = "matches the fallible `FnMut(&CGEvent) -> CoreResult<()>` post callback used by \
	          background posting"
)]
fn post_global(event: &CGEvent) -> CoreResult<()> {
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
		let result = key_chord(&source, &[KeyName::Ctrl, KeyName::Enter], |event| {
			let kind = event.get_type();
			let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
			events.push((kind as u32, code));
			if matches!(kind, CGEventType::KeyDown) && code == 36 {
				Err(DesktopError::input_failed("focus changed"))
			} else {
				Ok(())
			}
		});
		assert!(result.is_err());
		assert_eq!(events, vec![
			(CGEventType::KeyDown as u32, 59),
			(CGEventType::KeyDown as u32, 36),
			(CGEventType::KeyUp as u32, 36),
			(CGEventType::KeyUp as u32, 59),
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
}
