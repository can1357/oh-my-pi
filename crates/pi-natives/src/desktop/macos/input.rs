use std::{
	thread,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use core_graphics::{
	event::{
		CGEvent, CGEventFlags, CGEventTapLocation, CGEventType, CGMouseButton, EventField,
		ScrollEventUnit,
	},
	event_source::{CGEventSource, CGEventSourceStateID},
	geometry::CGPoint,
	sys::CGEventSourceRef,
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
			Target::Desktop => global_pointer(&self.source, event),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, pointer_kind(&event), pointer_button(&event))?;
						if !window.focused {
							skylight::activate_without_raise(pid, wid)?;
						}
						background_pointer(&self.source, pid, wid, &window, event)
					},
					DeliveryMode::Foreground => {
						skylight::with_foreground(pid, wid, || global_pointer(&self.source, event))
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
						background_guard(&window, "keyboard", None)?;
						prepare_background_keys(&window, pid, wid, capture)?;
						background_type(&self.source, pid, text)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						let _ = ax::prepare_foreground_input(&window);
						global_type(&self.source, text)
					}),
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
						background_guard(&window, "keyboard", None)?;
						prepare_background_keys(&window, pid, wid, capture)?;
						background_chord(&self.source, pid, keys)
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, || {
						let _ = ax::prepare_foreground_input(&window);
						global_chord(&self.source, keys)
					}),
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

/// Prepares background keyboard delivery for `window`, or refuses it.
///
/// macOS posts key events to a *process*, which hands them to whichever window
/// it treats as key; unlike pointer events they carry no window id, and neither
/// the `SkyLight` focus records nor any accessibility attribute reliably
/// predicts or redirects that choice. Delivery is therefore refused whenever
/// the process owns more than one window, rather than typing into another of
/// the user's windows. `DesktopWindow::focused` cannot disambiguate: xcap
/// reports every window owned by the active application as focused on macOS.
///
/// The refusal decision itself reads no mutable state, so it cannot be fooled
/// by the activation below.
fn prepare_background_keys(
	window: &DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	capture: &MacCapture,
) -> CoreResult<()> {
	let siblings = capture
		.windows()?
		.into_iter()
		.filter(|candidate| candidate.pid == window.pid)
		.count();
	if siblings > 1 {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} is one of {siblings} windows in its application; macOS delivers background \
			 keystrokes to whichever window the application treats as key, so retry with \
			 delivery:\"foreground\" or use ax actions",
		)));
	}
	// Sole window of its process, so the target is unambiguous: make it key
	// without raising it or changing the frontmost application. A background app
	// otherwise has no key window and drops the keystrokes entirely.
	skylight::activate_without_raise(pid, wid)
}

const fn pointer_kind(event: &PointerEvent) -> &'static str {
	match event {
		PointerEvent::Click { .. } => "click",
		PointerEvent::Move { .. } => "pointer move",
		PointerEvent::Drag { .. } => "drag",
		PointerEvent::Scroll { .. } => "scroll",
	}
}

const fn pointer_button(event: &PointerEvent) -> Option<MouseButton> {
	match event {
		PointerEvent::Click { button, .. } | PointerEvent::Drag { button, .. } => Some(*button),
		PointerEvent::Move { .. } | PointerEvent::Scroll { .. } => None,
	}
}

fn background_guard(
	window: &DesktopWindow,
	kind: &str,
	button: Option<MouseButton>,
) -> CoreResult<()> {
	let app = window.app.to_ascii_lowercase();
	let chromium = ["chrome", "chromium", "electron", "brave", "edge", "arc"]
		.iter()
		.any(|name| app.contains(name));
	if chromium && button == Some(MouseButton::Right) {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) coerces synthetic background right-click events to left-clicks; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	let canvas_or_game = ["blender", "unity", "godot", "unreal", "ghost"]
		.iter()
		.any(|name| app.contains(name));
	if canvas_or_game {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) drops background {kind} events in its canvas/game input stack; retry \
			 with delivery:\"foreground\" or use ax actions",
			window.id, window.app,
		)));
	}
	Ok(())
}

const LOCAL_EVENT_FILTER: u32 = 0x01 | 0x02 | 0x04;
const SUPPRESSION_INTERVAL: u32 = 0;
const REMOTE_MOUSE_DRAG: u32 = 1;

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
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsSuppressionInterval"]
	fn get_local_events_suppression_interval(source: CGEventSourceRef) -> f64;
	#[cfg(test)]
	#[link_name = "CGEventSourceGetLocalEventsFilterDuringSuppressionState"]
	fn get_local_events_filter_during_suppression_state(source: CGEventSourceRef, state: u32)
	-> u32;
}

fn source() -> CoreResult<CGEventSource> {
	let source = CGEventSource::new(CGEventSourceStateID::HIDSystemState)
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
		PointerEvent::Click { x, y, button, count, modifiers } => {
			background_click(source, pid, wid, window, x, y, button, count, modifiers)
		},
		PointerEvent::Move { x, y } => {
			let group = click_group_id();
			post_mouse(
				pid,
				wid,
				window,
				source.clone(),
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				2,
				0,
				0,
				group,
				CGEventFlags::CGEventFlagNull,
			)
		},
		PointerEvent::Drag { path, button, modifiers } => {
			background_drag(source, pid, wid, window, &path, button, modifiers)
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			background_scroll(source, pid, wid, window, x, y, dx, dy)
		},
	}
}

fn background_click(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	x: f64,
	y: f64,
	button: MouseButton,
	count: u32,
	modifiers: Modifiers,
) -> CoreResult<()> {
	let group = click_group_id();
	let (cg_button, down, up, _, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, source, x, y, group, flags)?;
	for click_state in 1..=count.max(1) {
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			down,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		thread::sleep(Duration::from_millis(1));
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			up,
			cg_button,
			x,
			y,
			3,
			i64::from(click_state),
			number,
			group,
			flags,
		)?;
		if click_state < count.max(1) {
			thread::sleep(Duration::from_millis(80));
		}
	}
	Ok(())
}

fn pointer_prologue(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: &CGEventSource,
	x: f64,
	y: f64,
	group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(15));
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::LeftMouseDown,
		CGMouseButton::Left,
		-1.0,
		-1.0,
		1,
		1,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(1));
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::LeftMouseUp,
		CGMouseButton::Left,
		-1.0,
		-1.0,
		2,
		1,
		0,
		group,
		flags,
	)?;
	thread::sleep(Duration::from_millis(100));
	Ok(())
}

fn background_drag(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	path: &[(f64, f64)],
	button: MouseButton,
	modifiers: Modifiers,
) -> CoreResult<()> {
	let Some(&(start_x, start_y)) = path.first() else {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	};
	if path.len() < 2 {
		return Err(DesktopError::input_failed("drag path must contain at least two points"));
	}
	let group = click_group_id();
	let (cg_button, down, up, dragged, number) = button_types(button);
	let flags = modifier_flags(modifiers);
	pointer_prologue(pid, wid, window, source, start_x, start_y, group, flags)?;
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		down,
		cg_button,
		start_x,
		start_y,
		3,
		1,
		number,
		group,
		flags,
	)?;
	for &(x, y) in &path[1..] {
		thread::sleep(Duration::from_millis(16));
		post_mouse(
			pid,
			wid,
			window,
			source.clone(),
			dragged,
			cg_button,
			x,
			y,
			3,
			1,
			number,
			group,
			flags,
		)?;
	}
	thread::sleep(Duration::from_millis(50));
	let &(end_x, end_y) = path
		.last()
		.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?;
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		up,
		cg_button,
		end_x,
		end_y,
		3,
		1,
		number,
		group,
		flags,
	)?;
	Ok(())
}

#[allow(
	clippy::too_many_arguments,
	reason = "the parameters are the native CGEvent fields stamped together"
)]
fn post_mouse(
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	source: CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	x: f64,
	y: f64,
	phase: i64,
	click_state: i64,
	button_number: i64,
	click_group: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source, event_type, CGPoint::new(x, y), button)
		.map_err(|()| DesktopError::input_failed("failed to create a Quartz pointer event"))?;
	// Flags are exactly the caller-requested modifier set; no background bypass
	// modifier is injected.
	event.set_flags(flags);
	let local = if x == -1.0 && y == -1.0 {
		CGPoint::new(-1.0, -1.0)
	} else {
		CGPoint::new(x - f64::from(window.x), y - f64::from(window.y))
	};
	skylight::stamp_event(&event, pid, wid, local, phase, click_state, button_number, click_group)?;
	skylight::post_dual(pid, &event)
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
	let group = click_group_id();
	post_mouse(
		pid,
		wid,
		window,
		source.clone(),
		CGEventType::MouseMoved,
		CGMouseButton::Left,
		x,
		y,
		2,
		0,
		0,
		group,
		CGEventFlags::CGEventFlagNull,
	)?;
	thread::sleep(Duration::from_millis(15));
	let wheel_x = finite_i32(dx, "horizontal scroll delta")?;
	let wheel_y = finite_i32(dy, "vertical scroll delta")?;
	let event =
		CGEvent::new_scroll_event(source.clone(), ScrollEventUnit::PIXEL, 2, wheel_y, wheel_x, 0)
			.map_err(|()| DesktopError::input_failed("failed to create a Quartz scroll event"))?;
	event.set_location(CGPoint::new(x, y));
	skylight::stamp_event(
		&event,
		pid,
		wid,
		CGPoint::new(x - f64::from(window.x), y - f64::from(window.y)),
		3,
		0,
		0,
		group,
	)?;
	skylight::post_dual(pid, &event)
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

fn type_text(
	source: &CGEventSource,
	text: &str,
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	for character in text.chars() {
		let value = character.to_string();
		for down in [true, false] {
			let event = CGEvent::new_keyboard_event(source.clone(), 0, down)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			event.set_string(&value);
			event.set_flags(CGEventFlags::CGEventFlagNull);
			post(&event)?;
			thread::sleep(Duration::from_millis(8));
		}
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
	for &key in keys {
		update_modifier(&mut active, key, true);
		post_key(source, key, true, modifier_flags(active), &mut post)?;
		thread::sleep(Duration::from_millis(8));
	}
	let mut first_error = None;
	for &key in keys.iter().rev() {
		update_modifier(&mut active, key, false);
		if let Err(error) = post_key(source, key, false, modifier_flags(active), &mut post)
			&& first_error.is_none()
		{
			first_error = Some(error);
		}
		thread::sleep(Duration::from_millis(8));
	}
	first_error.map_or(Ok(()), Err)
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

fn global_pointer(source: &CGEventSource, event: PointerEvent) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button, count, modifiers } => {
			post_global_mouse(
				source,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				0,
				0,
				CGEventFlags::CGEventFlagNull,
			)?;
			let (cg_button, down, up, _, number) = button_types(button);
			let flags = modifier_flags(modifiers);
			for click_state in 1..=count.max(1) {
				post_global_mouse(
					source,
					down,
					cg_button,
					x,
					y,
					i64::from(click_state),
					number,
					flags,
				)?;
				thread::sleep(Duration::from_millis(1));
				post_global_mouse(source, up, cg_button, x, y, i64::from(click_state), number, flags)?;
				if click_state < count.max(1) {
					thread::sleep(Duration::from_millis(80));
				}
			}
			Ok(())
		},
		PointerEvent::Move { x, y } => post_global_mouse(
			source,
			CGEventType::MouseMoved,
			CGMouseButton::Left,
			x,
			y,
			0,
			0,
			CGEventFlags::CGEventFlagNull,
		),
		PointerEvent::Drag { path, button, modifiers } => {
			let Some(&(start_x, start_y)) = path.first() else {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			};
			if path.len() < 2 {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			}
			let (cg_button, down, up, dragged, number) = button_types(button);
			let flags = modifier_flags(modifiers);
			post_global_mouse(
				source,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				start_x,
				start_y,
				0,
				0,
				CGEventFlags::CGEventFlagNull,
			)?;
			post_global_mouse(source, down, cg_button, start_x, start_y, 1, number, flags)?;
			for &(x, y) in &path[1..] {
				thread::sleep(Duration::from_millis(16));
				post_global_mouse(source, dragged, cg_button, x, y, 1, number, flags)?;
			}
			thread::sleep(Duration::from_millis(50));
			let &(end_x, end_y) = path
				.last()
				.ok_or_else(|| DesktopError::input_failed("drag path is empty"))?;
			post_global_mouse(source, up, cg_button, end_x, end_y, 1, number, flags)
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			post_global_mouse(
				source,
				CGEventType::MouseMoved,
				CGMouseButton::Left,
				x,
				y,
				0,
				0,
				CGEventFlags::CGEventFlagNull,
			)?;
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
			event.set_location(point(x, y)?);
			post_global(&event)
		},
	}
}

#[allow(
	clippy::too_many_arguments,
	reason = "the parameters are the native CGEvent fields stamped together"
)]
fn post_global_mouse(
	source: &CGEventSource,
	event_type: CGEventType,
	button: CGMouseButton,
	x: f64,
	y: f64,
	click_state: i64,
	button_number: i64,
	flags: CGEventFlags,
) -> CoreResult<()> {
	let event = CGEvent::new_mouse_event(source.clone(), event_type, point(x, y)?, button)
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
}
