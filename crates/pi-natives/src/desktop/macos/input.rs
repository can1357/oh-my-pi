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
use objc2_app_kit::{NSPasteboard, NSPasteboardNameDrag};
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
	capture::{self, MacCapture},
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

	/// Delivers `event`; with `menu`, a click that opens a menu chooses that
	/// item path in it.
	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		menu: Option<&[String]>,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		if menu.is_some() && !matches!(event, PointerEvent::Click { .. }) {
			return Err(DesktopError::invalid_target(
				"menu chooses an item of the menu a click opens; it applies to clicks only",
			));
		}
		match target {
			Target::Desktop | Target::Display(_) if menu.is_some() => {
				Err(DesktopError::invalid_target(
					"menu needs a window target, whose application owns the menu the click opens",
				))
			},
			Target::Desktop | Target::Display(_) => global_pointer(&self.source, event),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						background_guard(&window, pid, &event)?;
						let to = input_owner(
							pid,
							wid,
							ax::focused_window_content(pid, wid),
							ax::focused_window_id,
						)?;
						let entry_front = skylight::front_pid();
						skylight::with_background_guard(pid, || {
							background_pointer(
								&self.source,
								pid,
								wid,
								&window,
								event,
								menu,
								entry_front,
								to,
							)
						})
					},
					DeliveryMode::Foreground => {
						foreground_pointer(&self.source, &window, pid, wid, event, menu)
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
			Target::Desktop | Target::Display(_) => global_type(&self.source, text),
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
						with_background_keyboard(&self.source, pid, wid, &window, |to| {
							background_type(&self.source, to, text)
						})
					},
					DeliveryMode::Foreground => {
						// Screen Sharing relays physical key transitions only; map
						// the whole text before activating so a gap
						// refuses cleanly.
						let physical = if process::is_screen_sharing(pid) {
							Some(physical_transitions(text)?)
						} else {
							None
						};
						skylight::with_foreground(pid, wid, |activated| {
							control::wait(first_key_settle(activated))?;
							match &physical {
								Some(transitions) => {
									skylight::require_front_window(pid, wid)?;
									post_bare_keys(transitions)
								},
								None => {
									type_text(&self.source, text, |event| post_takeover_key(pid, wid, event))
								},
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
			Target::Desktop | Target::Display(_) => global_chord(&self.source, keys),
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						if keys.iter().copied().any(KeyName::is_modifier)
							&& process::is_screen_sharing(pid)
						{
							return Err(screen_sharing_refusal(
								&window,
								"modifier flags on routed chords",
							));
						}
						with_background_keyboard(&self.source, pid, wid, &window, |to| {
							background_chord(&self.source, to, keys)
						})?;
						confirm_shortcut_answered(&window, keys, || {
							control::wait(SHORTCUT_REPLY_DELAY)?;
							Ok(ax::stopped_answering(pid, SHORTCUT_REPLY_TIMEOUT_SECONDS))
						})
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, |activated| {
						control::wait(first_key_settle(activated))?;
						key_chord(&self.source, keys, |event| post_takeover_key(pid, wid, event))
					}),
				}
			},
		}
	}
}

impl MacInput {
	pub(super) fn hold_keys(
		&self,
		target: &Target,
		keys: &[KeyName],
		duration: Duration,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<()> {
		for &key in keys {
			key_code(key)?;
		}
		match target {
			Target::Desktop | Target::Display(_) => {
				with_held_keys(&self.source, keys, post_global, || control::wait(duration))
			},
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				match mode {
					DeliveryMode::Background => {
						if process::is_screen_sharing(pid) {
							return Err(screen_sharing_refusal(&window, "held keys"));
						}
						with_background_keyboard(&self.source, pid, wid, &window, |to| {
							with_held_keys(
								&self.source,
								keys,
								|event| skylight::post_keyboard(to, event),
								|| control::wait(duration),
							)
						})
					},
					DeliveryMode::Foreground => skylight::with_foreground(pid, wid, |activated| {
						control::wait(first_key_settle(activated))?;
						with_held_keys(
							&self.source,
							keys,
							|event| post_takeover_key(pid, wid, event),
							|| control::wait(duration),
						)
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

fn screen_sharing_refusal(window: &DesktopWindow, dropped: &str) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {} ({}) forwards only physical key transitions to the remote host and drops \
		 background {dropped}; retry with takeover:true or use ax actions",
		window.id, window.app,
	))
}

/// Why process-scoped background keystrokes could reach a window other than
/// the target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KeyboardConflict {
	/// The target is not among the process's accessibility windows, is not
	/// its focused window, and is not attached to one of its windows, so no
	/// claim about its key status can be proven.
	Unmapped,
	/// Other windows of the process could be the key window.
	Siblings(usize),
}

/// Background keyboard delivery to window `wid`: inside the self-activation
/// guard, makes `wid` its application's key window, then runs `deliver` with
/// the process to post the keys to.
///
/// macOS posts key events to a *process*, which hands them to whichever window
/// it treats as key; unlike pointer events they carry no window id. Keys are
/// sent only once the application reports keyboard focus in `wid`, or, when
/// it reports no focused window, `wid` is the only window that could be key.
/// A sheet or panel the application reports as focused is a window of its
/// own even while attached to `wid`, so it never stands in for `wid`.
/// Candidates come from the process's accessibility windows, not
/// `WindowServer`'s list, which also holds the per-window compositor surfaces
/// of Chromium, Electron, and `WebKit` apps. `AXWindows` omits sheets and
/// panels such as Finder's Go to Folder; such a target counts as a window of
/// the process while it is the focused window or attached to a listed one.
/// Keys for a system Open or Save panel go to the process that draws its
/// content ([`key_process`]).
fn with_background_keyboard<T>(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	deliver: impl FnOnce(libc::pid_t) -> CoreResult<T>,
) -> CoreResult<T> {
	let conflict = ax::window_records(pid).map_or(Some(KeyboardConflict::Unmapped), |records| {
		keyboard_conflict(wid, &records, || {
			ax::focused_window_id(pid) == Some(wid)
				|| attached_under(wid, skylight::window_parent, |parent| {
					records.iter().any(|record| record.id == Some(parent))
				})
		})
	});
	if conflict == Some(KeyboardConflict::Unmapped) {
		return Err(unmapped_keyboard_refusal(wid));
	}
	let focus = ax::key_focus(pid);
	// The target cannot become key while a window attached to it has focus,
	// so waiting for that would only delay the same refusal.
	let destination = focus.destination(pid, wid, skylight::window_parent);
	if let ax::KeyDestination::Other(Some(other)) = destination
		&& attached_under(other, skylight::window_parent, |parent| parent == wid)
	{
		return Err(key_refusal(wid, destination, conflict, skylight::window_parent));
	}
	let in_overlay = focus.in_overlay_of(wid, skylight::window_parent);
	let entry_front = skylight::front_pid();
	skylight::with_background_guard(pid, || {
		let prepared = make_key_in_background(source, pid, wid, window, entry_front, in_overlay)?;
		let (to, focus) = await_key_destination(pid, wid, conflict)?;
		let to = key_process(
			to,
			wid,
			&focus,
			|| ax::focused_window_content(pid, wid),
			ax::focused_window_id,
		)?;
		if prepared {
			still_behind_user(pid, wid)?;
		}
		deliver(to)
	})
}

fn unmapped_keyboard_refusal(wid: u32) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {wid} is not among its application's accessibility windows, is not its focused \
		 window, and is not attached to one of its windows, so background keystrokes cannot be \
		 proven to reach it; retry with takeover:true or use ax actions",
	))
}

fn sibling_keyboard_refusal(wid: u32, siblings: usize) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {wid} shares its application with {siblings} other window(s) and did not become its \
		 key window, so background keystrokes could reach another window; retry with takeover:true \
		 or use ax actions",
	))
}

/// `outside_list` tells whether a target missing from `records` still is a
/// window of the process, such as a focused or attached sheet.
fn keyboard_conflict(
	wid: u32,
	records: &[ax::AxWindowRecord],
	outside_list: impl FnOnce() -> bool,
) -> Option<KeyboardConflict> {
	if !records.iter().any(|record| record.id == Some(wid)) && !outside_list() {
		return Some(KeyboardConflict::Unmapped);
	}
	// A minimized window cannot be key; an unreadable state could be. An entry
	// with no window id, such as Finder's desktop, could be key too.
	let siblings = records
		.iter()
		.filter(|record| record.id != Some(wid) && record.minimized != Some(true))
		.count();
	(siblings > 0).then_some(KeyboardConflict::Siblings(siblings))
}

/// What background keyboard delivery does with where keys would go now.
#[derive(Debug, PartialEq, Eq)]
enum KeyRoute {
	/// Post the keys to this process.
	Deliver(libc::pid_t),
	/// Not yet proven; read again until the deadline.
	Wait,
}

/// Keys go out once they would reach `wid`. When the application reports no
/// focused window at all, the target being its only possible key window is
/// the remaining proof; another reported focused window never is.
const fn key_route(
	pid: libc::pid_t,
	destination: ax::KeyDestination,
	conflict: Option<KeyboardConflict>,
) -> KeyRoute {
	match (destination, conflict) {
		(ax::KeyDestination::Target(to), _) => KeyRoute::Deliver(to),
		(ax::KeyDestination::Unreported, None) => KeyRoute::Deliver(pid),
		_ => KeyRoute::Wait,
	}
}

/// Waits until keystrokes posted now would reach `wid`, which the
/// application handles [`make_key_in_background`]'s events to establish, and
/// returns the process to post them to with the focus that proved it.
fn await_key_destination(
	pid: libc::pid_t,
	wid: u32,
	conflict: Option<KeyboardConflict>,
) -> CoreResult<(libc::pid_t, ax::KeyFocus)> {
	let deadline = Instant::now() + KEY_WINDOW_TIMEOUT;
	loop {
		let focus = ax::key_focus(pid);
		let destination = focus.destination(pid, wid, skylight::window_parent);
		if let KeyRoute::Deliver(to) = key_route(pid, destination, conflict) {
			return Ok((to, focus));
		}
		if Instant::now() >= deadline {
			return Err(key_refusal(wid, destination, conflict, skylight::window_parent));
		}
		control::wait(KEY_WINDOW_POLL)?;
	}
}

/// The process to post background keys for window `wid` of `pid` to, once
/// `focus` shows they would reach `wid`: [`input_owner`] of the window's
/// `content`. A focused element that maps to `wid` itself shows the window's
/// own process holds the focus, so the content is read only when it does not.
fn key_process(
	pid: libc::pid_t,
	wid: u32,
	focus: &ax::KeyFocus,
	content: impl FnOnce() -> ax::WindowContent,
	focused_window_of: impl FnOnce(libc::pid_t) -> Option<u32>,
) -> CoreResult<libc::pid_t> {
	if focus.window != ax::FocusedWindow::Id(wid) || focus.element_maps_to(wid) {
		return Ok(pid);
	}
	input_owner(pid, wid, content(), focused_window_of).map(|(to, _)| to)
}

/// The process and window that take background input for window `wid` of
/// `pid`, given who draws it (`content`).
///
/// A system Open or Save panel, and the Go to Folder sheet it opens, is a
/// window of the application that asked for it, but `openAndSavePanelService`
/// draws its content in a window of its own, at the same frame and off
/// `WindowServer`'s window list, and handles its input: keys and clicks posted
/// to the application are dropped without an error. Input for such a window
/// goes to the drawing process and its window once that process reports focus
/// there (`focused_window_of`), and refuses while it does not.
fn input_owner(
	pid: libc::pid_t,
	wid: u32,
	content: ax::WindowContent,
	focused_window_of: impl FnOnce(libc::pid_t) -> Option<u32>,
) -> CoreResult<(libc::pid_t, u32)> {
	match content {
		ax::WindowContent::Own => Ok((pid, wid)),
		ax::WindowContent::Remote { pid: owner, window }
			if focused_window_of(owner) == Some(window) =>
		{
			Ok((owner, window))
		},
		ax::WindowContent::Remote { pid: owner, window } => {
			Err(DesktopError::background_unavailable(format!(
				"window {wid} shows content drawn by process {owner}, such as a system Open or Save \
				 panel, and that process does not report focus in its window {window}, so background \
				 input would be dropped; nothing was sent; retry with takeover:true or use ax actions",
			)))
		},
	}
}

/// Most windows deep a chain of sheets attached to sheets is followed.
const MAX_ATTACHED_DEPTH: usize = 4;

/// Whether `window` is attached, directly or through other attached windows,
/// to a window `is_ancestor` accepts, as `parent_of` reports `WindowServer`'s
/// parents.
fn attached_under(
	window: u32,
	parent_of: impl Fn(u32) -> Option<u32>,
	is_ancestor: impl Fn(u32) -> bool,
) -> bool {
	let mut current = window;
	for _ in 0..MAX_ATTACHED_DEPTH {
		match parent_of(current) {
			Some(parent) if is_ancestor(parent) => return true,
			Some(parent) => current = parent,
			None => return false,
		}
	}
	false
}

/// The error for keys that never would have reached `wid`; nothing was sent.
///
/// A window with a sheet or panel attached cannot become key while that
/// window holds focus, in the background or in takeover, so that case names
/// the attached window instead of asking for a takeover that would fail.
fn key_refusal(
	wid: u32,
	destination: ax::KeyDestination,
	conflict: Option<KeyboardConflict>,
	parent_of: impl Fn(u32) -> Option<u32>,
) -> DesktopError {
	match destination {
		ax::KeyDestination::Other(Some(other))
			if attached_under(other, parent_of, |parent| parent == wid) =>
		{
			DesktopError::invalid_target(format!(
				"window {wid} has window {other} (a sheet, panel or popover) attached and focused, \
				 which takes every keystroke sent to its application, so window {wid} cannot receive \
				 keys in the background or in takeover; nothing was sent; send them to window \
				 {other}, or close it first",
			))
		},
		ax::KeyDestination::Other(other) => {
			let focused =
				other.map_or_else(|| "an unidentified window".to_owned(), |id| format!("window {id}"));
			DesktopError::background_unavailable(format!(
				"window {wid} did not become its application's key window, and {focused} still is, so \
				 background keystrokes would reach that window; nothing was sent; retry with \
				 takeover:true or use ax actions",
			))
		},
		ax::KeyDestination::Target(_) | ax::KeyDestination::Unreported => {
			let siblings = match conflict {
				Some(KeyboardConflict::Siblings(siblings)) => siblings,
				_ => 0,
			};
			DesktopError::background_unavailable(format!(
				"window {wid} shares its application with {siblings} other window(s) and did not \
				 become its key window, so background keystrokes could reach another window; nothing \
				 was sent; retry with takeover:true or use ax actions",
			))
		},
	}
}

/// After a background shortcut with a modifier, fails when `stopped_answering`
/// reports that the application no longer answers accessibility requests.
///
/// A shortcut can start work that never returns, as `TextEdit`'s first
/// background ⌘S on a document did before [`activate_then_await`] waited for
/// its activation. Posting succeeded, but only the application's reply shows
/// the command ran.
fn confirm_shortcut_answered(
	window: &DesktopWindow,
	keys: &[KeyName],
	stopped_answering: impl FnOnce() -> CoreResult<bool>,
) -> CoreResult<()> {
	if !keys.iter().copied().any(KeyName::is_modifier) || !stopped_answering()? {
		return Ok(());
	}
	Err(DesktopError::input_failed(format!(
		"the shortcut was posted to window {} ({}), but the application stopped answering \
		 accessibility requests right after, so whether the shortcut took effect is unknown; it may \
		 be busy or hung. Inspect it before retrying or reporting success",
		window.id, window.app,
	)))
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
	refuse_pointer(
		window,
		event,
		|| process::is_screen_sharing(pid),
		|| process::reads_hardware_pointer(pid),
	)
}

/// [`background_guard`]'s verdict. The target is probed by
/// `is_screen_sharing` only for an event that holds keys, and its Tk by
/// `reads_hardware_pointer` only for an event that presses a button.
fn refuse_pointer(
	window: &DesktopWindow,
	event: &PointerEvent,
	is_screen_sharing: impl FnOnce() -> bool,
	reads_hardware_pointer: impl FnOnce() -> bool,
) -> CoreResult<()> {
	let refuse = |reason: &str| {
		Err(DesktopError::background_unavailable(format!(
			"window {} ({}) {reason}; retry with takeover:true or use ax actions",
			window.id, window.app,
		)))
	};
	let kind = pointer_kind(event);
	let app = window.app.to_ascii_lowercase();
	let canvas_or_game = ["blender", "unity", "godot", "unreal"]
		.iter()
		.any(|name| app.contains(name));
	if canvas_or_game {
		return refuse(
			format!("drops background {kind} events in its canvas/game input stack").as_str(),
		);
	}
	if holds_keys(event) && is_screen_sharing() {
		return Err(screen_sharing_refusal(window, "modifier flags and held keys on pointer input"));
	}
	// An open context menu takes the keyboard from the user's app, and a hold
	// or a drag keeps it open until the button is released, however long the
	// hold or stroke runs.
	if matches!(event, PointerEvent::Hold { .. } | PointerEvent::Drag { .. })
		&& may_open_context_menu(event)
	{
		return refuse(
			"could open a context menu on this secondary-button hold or drag, which would take the \
			 keyboard from the user's app until the button is released",
		);
	}
	if presses_button(event) && reads_hardware_pointer() {
		return refuse(
			"uses the Tk toolkit, which places clicks at the hardware pointer rather than the event \
			 location, so a background click would land wherever the user's pointer is",
		);
	}
	Ok(())
}

/// Whether `event` presses a mouse button, which a toolkit that reads the
/// hardware pointer places at the user's pointer instead of the event.
const fn presses_button(event: &PointerEvent) -> bool {
	matches!(
		event,
		PointerEvent::Click { .. } | PointerEvent::Drag { .. } | PointerEvent::Hold { .. }
	)
}

/// Whether `event` carries modifier flags or holds keys around its presses.
fn holds_keys(event: &PointerEvent) -> bool {
	match event {
		PointerEvent::Click { modifiers, .. } => *modifiers != Modifiers::default(),
		PointerEvent::Drag { modifiers, keys, .. } => {
			*modifiers != Modifiers::default() || !keys.is_empty()
		},
		PointerEvent::Hold { keys, .. } => !keys.is_empty(),
		PointerEvent::Move { .. } | PointerEvent::Scroll { .. } => false,
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
/// How long an application may take to report the activation
/// [`activate_then_await`] posted.
const ACTIVE_STATE_TIMEOUT: Duration = Duration::from_millis(500);

/// Posts the activation through `activate` and, when the application reported
/// itself inactive before (`was_active`), waits until `reports_active` shows
/// it active, polling through `wait`.
///
/// `AppKit` closes a pending undo group after each event it handles, so the
/// activation can be what makes `NSDocument` record an edit made through
/// accessibility. On a document's first edit, `NSDocument` then holds its save
/// lock until its main run loop next turns, and events queued behind the
/// activation are handled before the loop turns: `TextEdit` and Script Editor
/// blocked forever on a ⌘S posted that way. The application answers
/// accessibility only from a turn of that loop, so once it reports itself
/// active, the work the activation started has finished. An application that
/// already reports itself active, or reports nothing, gives no such signal. A
/// report that does not come within `timeout` is not an error; delivery then
/// goes ahead as it would without the wait.
fn activate_then_await(
	was_active: Option<bool>,
	timeout: Duration,
	activate: impl FnOnce() -> CoreResult<()>,
	mut reports_active: impl FnMut() -> Option<bool>,
	mut wait: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	activate()?;
	if was_active != Some(false) {
		return Ok(());
	}
	let deadline = Instant::now() + timeout;
	while reports_active() != Some(true) && Instant::now() < deadline {
		wait()?;
	}
	Ok(())
}

/// Where a background input's target window stands relative to the user's
/// keyboard focus.
#[derive(Debug, PartialEq, Eq)]
enum FrontTarget {
	/// Another application is frontmost.
	Background,
	/// The target already was the key window of the frontmost application
	/// when the input began.
	Key,
	/// The target's application came to the front after the input began, so
	/// the user may just have selected another of its windows.
	CameForward,
	/// The target is another window of the frontmost application, whose key
	/// window takes the user's typing.
	UserSibling,
	/// The front process could not be read, so the target may be a non-key
	/// window of the frontmost application.
	Unknown,
}

fn front_target(
	entry_front: Option<libc::pid_t>,
	front: Option<libc::pid_t>,
	pid: libc::pid_t,
	wid: u32,
	focused: impl FnOnce() -> Option<u32>,
) -> FrontTarget {
	match front {
		None => FrontTarget::Unknown,
		Some(front) if front != pid => FrontTarget::Background,
		Some(_) if entry_front != Some(pid) => FrontTarget::CameForward,
		Some(_) if focused() == Some(wid) => FrontTarget::Key,
		Some(_) => FrontTarget::UserSibling,
	}
}

/// Makes `wid` the key window of its background application, as that
/// application sees it, without activating it.
///
/// A background application drops pid-routed keystrokes and key equivalents,
/// and Chromium ignores its clicks, until it believes it is active. The
/// application-activated event `AppKit` builds for a real activation gives it
/// that belief, and [`activate_then_await`] waits until an inactive
/// application reports it; a press and release just outside the window's
/// frame then make exactly `wid` key among its windows without reaching any
/// of its controls.
/// `WindowServer`'s front process and key-focus application, which route the
/// user's keystrokes and key equivalents, stay with the user's app. In the
/// frontmost application itself, nothing is posted: the target already is
/// key, or making it key would move the user's typing, so the input refuses.
/// `entry_front` is the front process sampled before the caller's focus guard
/// began; a target that has come forward since then refuses, because the
/// user may have just picked the window that would receive the input.
///
/// `focus_in_overlay` says the caller has seen the application's keyboard
/// focus in an overlay window attached to `wid`, such as Finder's inline
/// rename field or a popover: the target then counts as the frontmost
/// application's key window, and in a background application the activation
/// goes out without the press, which would make `wid` key and so end that
/// overlay's editing.
///
/// Returns whether the activation step ran. The user can bring the target app
/// forward at any moment, which would turn the step into a key-window switch
/// in the app they type into, so the front process is re-read before the
/// press and, through [`still_behind_user`], by callers before they deliver.
pub(super) fn make_key_in_background(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	entry_front: Option<libc::pid_t>,
	focus_in_overlay: bool,
) -> CoreResult<bool> {
	let focused = || {
		if focus_in_overlay {
			Some(wid)
		} else {
			ax::focused_window_id(pid)
		}
	};
	match front_target(entry_front, skylight::front_pid(), pid, wid, focused) {
		FrontTarget::Background => {},
		FrontTarget::Key => return Ok(false),
		FrontTarget::CameForward => {
			return Err(DesktopError::background_unavailable(format!(
				"window {wid}'s application came to the front while background input was prepared; \
				 nothing was sent; inspect the window, then retry with takeover:true or use ax actions",
			)));
		},
		FrontTarget::UserSibling => {
			return Err(DesktopError::background_unavailable(format!(
				"window {wid} belongs to the frontmost application but is not its key window; making \
				 it key would move the user's typing there, so nothing was sent; retry with \
				 takeover:true or use ax actions",
			)));
		},
		FrontTarget::Unknown => {
			return Err(DesktopError::background_unavailable(format!(
				"window {wid}: the frontmost application could not be identified, so making the \
				 window key could move the user's typing there; nothing was sent; retry with \
				 takeover:true or use ax actions",
			)));
		},
	}
	let context = skylight::sender_connection()?;
	let activate = || -> CoreResult<()> {
		let activated = CGEvent::new(source.clone())
			.map_err(|()| DesktopError::input_failed("failed to create a Quartz activation event"))?;
		// SAFETY: `activated` is a live CGEvent and the type is a valid
		// CGEventType value the core-graphics enum lacks.
		unsafe { set_event_type(activated.as_ptr(), APPKIT_DEFINED_EVENT) };
		activated.set_flags(CGEventFlags::from_bits_retain(ACTIVATION_FLAGS));
		skylight::set_fields(&activated, &[
			(FIELD_WINDOW_NUMBER, i64::from(wid)),
			(FIELD_WINDOW_CONTEXT, context),
			(FIELD_APPKIT_SUBTYPE, APPLICATION_ACTIVATED),
		])?;
		skylight::post_routed(pid, &activated)
	};
	activate_then_await(
		ax::reports_active(pid),
		ACTIVE_STATE_TIMEOUT,
		activate,
		|| ax::reports_active(pid),
		|| control::wait(KEY_WINDOW_POLL),
	)?;
	still_behind_user(pid, wid)?;
	if focus_in_overlay {
		return Ok(true);
	}
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
	skylight::after_cleanup(Ok(true), release)
}

/// Refuses once the target's application is frontmost (or the front process
/// is unknown) after [`make_key_in_background`] judged it a background app.
pub(super) fn still_behind_user(pid: libc::pid_t, wid: u32) -> CoreResult<()> {
	if left_background(skylight::front_pid(), pid) {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid}'s application came to the front, or the front application could not be \
			 identified, while background input was prepared; no further input was sent; inspect the \
			 window, then retry with takeover:true or use ax actions",
		)));
	}
	Ok(())
}

const fn left_background(front: Option<libc::pid_t>, pid: libc::pid_t) -> bool {
	match front {
		Some(front) => front == pid,
		None => true,
	}
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
/// Pacing between the dragged events of a background drag, one 60 Hz frame.
const DRAG_STEP_GAP: Duration = Duration::from_millis(16);
/// Wait at the end point before a background drag's release, so the target
/// handles the last move as a move rather than coalescing it into the release.
const DRAG_RELEASE_GAP: Duration = Duration::from_millis(50);
/// Wait after a background shortcut before asking its application for a
/// reply. A save that blocks `TextEdit` already does so at this point.
const SHORTCUT_REPLY_DELAY: Duration = Duration::from_millis(100);
/// How long that application has to reply before it counts as not answering.
const SHORTCUT_REPLY_TIMEOUT_SECONDS: f32 = 1.5;
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
	#[link_name = "CGEventSetTimestamp"]
	fn set_event_timestamp(event: CGEventRef, timestamp: u64);
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
	#[link_name = "CGEventGetTimestamp"]
	fn get_event_timestamp(event: CGEventRef) -> u64;
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

/// Background pointer input for window `wid` of `pid`. The events go to `to`,
/// the process and window that take the window's input ([`input_owner`]),
/// which also shows any menu they open; making the window key still goes to
/// its own application.
fn background_pointer(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
	menu: Option<&[String]>,
	entry_front: Option<libc::pid_t>,
	to: (libc::pid_t, u32),
) -> CoreResult<()> {
	let menu_pid = to.0;
	// An open menu takes the keyboard from the user's app: a context menu, or
	// the menu of a menu button or popup button that a left click lands on.
	let timeout = if may_open_context_menu(&event) {
		Some(ax::open_menu::CONTEXT_MENU_TIMEOUT)
	} else if menu.is_some() || clicks_menu_control(&event, pid, menu_pid) {
		Some(ax::open_menu::CONTROL_MENU_TIMEOUT)
	} else {
		None
	};
	let before = match timeout {
		Some(_) => Some(capture::menu_windows(menu_pid).ok_or_else(|| {
			DesktopError::background_unavailable(format!(
				"cannot list the open menus of window {} ({}), so a menu this {} opens could not be \
				 closed; nothing was sent; retry with takeover:true or use ax actions",
				window.id,
				window.app,
				pointer_kind(&event),
			))
		})?),
		None => None,
	};
	ax::open_menu::guard(
		ax::open_menu::Press::Pointer { kind: pointer_kind(&event), window },
		before.as_deref(),
		menu,
		|| background_gesture(source, pid, wid, window, event, entry_front, to),
		|before, path| ax::open_menu::settle(menu_pid, before, path, timeout.unwrap_or_default()),
	)
}

/// Whether `event` is a left click that lands on a menu button or popup
/// button drawn by `owner` (the window's application, or the process drawing
/// its content) while another application than `pid` is frontmost; the control
/// opens its menu on the click. Other clicks pay no accessibility hit-test.
fn clicks_menu_control(event: &PointerEvent, pid: libc::pid_t, owner: libc::pid_t) -> bool {
	let PointerEvent::Click { x, y, button: MouseButton::Left, .. } = *event else {
		return false;
	};
	skylight::front_pid() != Some(pid) && ax::open_menu::opens_menu_at(owner, x, y)
}

fn background_gesture(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
	entry_front: Option<libc::pid_t>,
	(to, to_wid): (libc::pid_t, u32),
) -> CoreResult<()> {
	match event {
		PointerEvent::Click { x, y, button: MouseButton::Left, count, modifiers } => {
			if make_key_in_background(source, pid, wid, window, entry_front, false)? {
				still_behind_user(pid, wid)?;
			}
			background_left_click(source, to, to_wid, window, x, y, count, modifier_flags(modifiers))
		},
		PointerEvent::Click { x, y, button, count, modifiers } => background_button_click(
			source,
			to,
			to_wid,
			window,
			x,
			y,
			button,
			count,
			modifier_flags(modifiers),
		),
		PointerEvent::Move { x, y } => post_hover(source, to, to_wid, window, x, y, click_group_id()),
		PointerEvent::Scroll { x, y, dx, dy } => {
			background_scroll(source, to, to_wid, window, x, y, dx, dy)
		},
		PointerEvent::Drag { path, button, modifiers, mut keys } => {
			control::add_modifiers(&mut keys, modifiers);
			let path = path
				.iter()
				.map(|&(x, y)| point(x, y))
				.collect::<CoreResult<Vec<_>>>()?;
			if path.len() < 2 {
				return Err(DesktopError::input_failed("drag path must contain at least two points"));
			}
			prepare_press(source, pid, wid, window, button, &keys, entry_front)?;
			background_drag(source, pid, wid, window, &path, button, &keys)
		},
		PointerEvent::Hold { x, y, button, keys, duration } => {
			let at = point(x, y)?;
			prepare_press(source, pid, wid, window, button, &keys, entry_front)?;
			background_hold(source, pid, wid, window, at, button, &keys, duration)
		},
	}
}

/// Whether `event` is a secondary press, which opens a context menu in most
/// views: a right press, or a left press with Control held.
fn may_open_context_menu(event: &PointerEvent) -> bool {
	let (button, control) = match event {
		PointerEvent::Click { button, modifiers, .. } => (*button, modifiers.ctrl),
		PointerEvent::Drag { button, modifiers, keys, .. } => {
			(*button, modifiers.ctrl || keys.contains(&KeyName::Ctrl))
		},
		PointerEvent::Hold { button, keys, .. } => (*button, keys.contains(&KeyName::Ctrl)),
		PointerEvent::Move { .. } | PointerEvent::Scroll { .. } => return false,
	};
	matches!(button, MouseButton::Right) || (matches!(button, MouseButton::Left) && control)
}

/// Posts Escape to `pid`, which closes the menu it has open.
pub(super) fn post_escape(pid: libc::pid_t) -> CoreResult<()> {
	let source = source()?;
	let mut post = |event: &CGEvent| skylight::post_keyboard(pid, event);
	let flags = CGEventFlags::CGEventFlagNull;
	post_key(&source, KeyName::Escape, true, flags, &mut post)?;
	post_key(&source, KeyName::Escape, false, flags, &mut post)
}

/// Readies a background window for a held press and the keys held around it.
///
/// A view that refuses first mouse, as Chromium and Electron pages do, drops a
/// left press into a window its application does not yet consider key, which
/// a click survives but a press that stays down does not. Held keys go to the
/// process, which hands them to its key window, so they need the same proof
/// that `wid` is that window as background typing does.
fn prepare_press(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	button: MouseButton,
	keys: &[KeyName],
	entry_front: Option<libc::pid_t>,
) -> CoreResult<()> {
	ready_press(
		wid,
		button,
		!keys.is_empty(),
		|| {
			ax::window_records(pid).map_or(Some(KeyboardConflict::Unmapped), |records| {
				keyboard_conflict(wid, &records, || {
					ax::focused_window_id(pid) == Some(wid)
						|| attached_under(wid, skylight::window_parent, |parent| {
							records.iter().any(|record| record.id == Some(parent))
						})
				})
			})
		},
		|| make_key_in_background(source, pid, wid, window, entry_front, false),
		|| await_key_window(pid, wid),
		|| still_behind_user(pid, wid),
	)
}

/// [`prepare_press`] with its probes and the key-window step as closures.
/// When `make_key` ran the activation step, `still_behind` re-checks after the
/// wait for the key window that the user has not brought the target forward.
fn ready_press(
	wid: u32,
	button: MouseButton,
	holds_keys: bool,
	conflict: impl FnOnce() -> Option<KeyboardConflict>,
	make_key: impl FnOnce() -> CoreResult<bool>,
	is_key: impl FnOnce() -> CoreResult<bool>,
	still_behind: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	let siblings = if holds_keys {
		match conflict() {
			Some(KeyboardConflict::Unmapped) => return Err(unmapped_keyboard_refusal(wid)),
			Some(KeyboardConflict::Siblings(siblings)) => siblings,
			None => 0,
		}
	} else {
		0
	};
	if !holds_keys && !matches!(button, MouseButton::Left) {
		return Ok(());
	}
	let prepared = make_key()?;
	if !is_key()? && siblings > 0 {
		return Err(sibling_keyboard_refusal(wid, siblings));
	}
	if prepared {
		still_behind()?;
	}
	Ok(())
}

/// One event of a background drag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stroke {
	Down,
	Dragged,
	Up,
}

/// Posts a drag along `path` (at least two points): the press at its start,
/// one dragged event per later point, and the release. The release is posted
/// whatever happens before it, at the last point attempted, since a failed
/// post may still have been delivered.
fn stroke_path(
	path: &[CGPoint],
	mut post: impl FnMut(Stroke, CGPoint) -> CoreResult<()>,
) -> CoreResult<()> {
	let mut last = path[0];
	let result = (|| {
		post(Stroke::Down, last)?;
		for &at in &path[1..] {
			control::wait(DRAG_STEP_GAP)?;
			last = at;
			post(Stroke::Dragged, at)?;
		}
		control::wait(DRAG_RELEASE_GAP)
	})();
	let release = control::cleanup(|| post(Stroke::Up, last));
	skylight::after_cleanup(result, release)
}

/// A background drag along `path` (global points, at least two): a hover at
/// the start, then [`stroke_path`], all routed to `wid` so the user's pointer
/// stays where it is. `keys` are held around the gesture as key transitions
/// to the target process, and their modifiers ride on every pointer event.
/// A drag that starts a drag-and-drop session throws with its outcome
/// unconfirmed, as [`drag_session_outcome`] describes.
fn background_drag(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	path: &[CGPoint],
	button: MouseButton,
	keys: &[KeyName],
) -> CoreResult<()> {
	let (cg_button, down, up, dragged, number) = button_types(button);
	let flags = held_flags(keys);
	let group = click_group_id();
	let sessions = drag_pasteboard_count();
	with_held_keys(
		source,
		keys,
		|event| skylight::post_keyboard(pid, event),
		|| {
			let start = path[0];
			post_hover(source, pid, wid, window, start.x, start.y, group)?;
			control::wait(Duration::from_millis(12))?;
			stroke_path(path, |stroke, at| {
				let event_type = match stroke {
					Stroke::Down => down,
					Stroke::Dragged => dragged,
					Stroke::Up => up,
				};
				let event = mouse_event(source, event_type, at, cg_button)?;
				event.set_flags(flags);
				post_window_pointer(pid, wid, window, &event, at.x, at.y, 1, number, group)
			})
		},
	)?;
	// An accessibility round trip, which the target answers from its run loop
	// once it has handled the events posted before it.
	drag_session_outcome(window, sessions, drag_pasteboard_count, || {
		ax::reports_active(pid);
	})
}

/// Change count of the drag pasteboard, which a drag source clears and
/// writes as it begins a drag-and-drop session.
fn drag_pasteboard_count() -> isize {
	// SAFETY: `NSPasteboardNameDrag` is an immutable AppKit string constant.
	NSPasteboard::pasteboardWithName(unsafe { NSPasteboardNameDrag }).changeCount()
}

/// [`background_drag`]'s verdict after its release, from the drag
/// pasteboard's change count as `count` reads it and as it was `before` the
/// press.
///
/// A drag that picks up an item (a file, a font, a table row, selected text)
/// makes its application begin a drag-and-drop session, which macOS completes
/// from the user's real pointer and button as well as from the routed events,
/// so where the item lands is not up to the drag. On macOS 26, Font Book
/// dropped a font on the collection at the path's end in some drags and
/// nowhere in others, depending on where the user's pointer and windows were,
/// and `TextEdit` moved dragged text to the end of its document. Such a drag's
/// outcome is unknown rather than failed: it throws `InputFailed` saying the
/// drop could not be confirmed, so the caller reads the target before
/// retrying, and it is not rerun in takeover, which would repeat a drop that
/// did land. Escape posted to the source did not cancel the drop, and releasing
/// early would only drop the item short of the path's end. A drag inside a
/// view (a slider, a text selection, a web page's mouse-driven drag) leaves
/// the count alone.
///
/// The source writes the pasteboard while it handles the routed events; when
/// the count has not moved yet, `caught_up` waits until the target has handled
/// them, and the count is read once more.
fn drag_session_outcome(
	window: &DesktopWindow,
	before: isize,
	mut count: impl FnMut() -> isize,
	caught_up: impl FnOnce(),
) -> CoreResult<()> {
	if count() == before {
		caught_up();
		if count() == before {
			return Ok(());
		}
	}
	Err(DesktopError::input_failed(format!(
		"the drag reached window {} ({}), but its outcome could not be confirmed: it started a \
		 drag-and-drop session, which macOS completes from the user's real pointer and button, so \
		 the item may already have been dropped at the path's end, elsewhere, or not at all. Read \
		 the target before retrying; prefer the app's menu command or ax actions, and drag with \
		 takeover:true only if nothing was dropped",
		window.id, window.app,
	)))
}

/// A background press held for `duration` at `at`, routed to `wid`; the
/// release is posted even when the hold is cancelled. `keys` are held around
/// it as in [`background_drag`].
fn background_hold(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	at: CGPoint,
	button: MouseButton,
	keys: &[KeyName],
	duration: Duration,
) -> CoreResult<()> {
	let (cg_button, down, up, _, number) = button_types(button);
	let flags = held_flags(keys);
	let group = click_group_id();
	with_held_keys(
		source,
		keys,
		|event| skylight::post_keyboard(pid, event),
		|| {
			post_hover(source, pid, wid, window, at.x, at.y, group)?;
			control::wait(Duration::from_millis(12))?;
			control::bounded_hold(duration, |pressed| {
				let event = mouse_event(source, if pressed { down } else { up }, at, cg_button)?;
				event.set_flags(flags);
				post_window_pointer(pid, wid, window, &event, at.x, at.y, 1, number, group)
			})
		},
	)
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
	flags: CGEventFlags,
) -> CoreResult<()> {
	let group = click_group_id();
	let target = CGPoint::new(x, y);
	let local = window_local(window, x, y);
	let offscreen = CGPoint::new(-1.0, -1.0);
	let post = |event_type: CGEventType,
	            location: CGPoint,
	            window_location: CGPoint,
	            phase: i64,
	            click_state: i64,
	            flags: CGEventFlags|
	 -> CoreResult<()> {
		let event = mouse_event(source, event_type, location, CGMouseButton::Left)?;
		event.set_flags(flags);
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
	let unmodified = CGEventFlags::CGEventFlagNull;
	post(CGEventType::MouseMoved, target, local, 2, 0, flags)?;
	control::wait(Duration::from_millis(15))?;
	post(CGEventType::LeftMouseDown, offscreen, offscreen, 1, 1, unmodified)?;
	let result = control::wait(Duration::from_millis(1));
	let release =
		control::cleanup(|| post(CGEventType::LeftMouseUp, offscreen, offscreen, 2, 1, unmodified));
	skylight::after_cleanup(result, release)?;
	control::wait(Duration::from_millis(100))?;
	let count = count.max(1);
	for click_state in 1..=count {
		post(CGEventType::LeftMouseDown, target, local, 3, i64::from(click_state), flags)?;
		let result = control::wait(Duration::from_millis(1));
		let release = control::cleanup(|| {
			post(CGEventType::LeftMouseUp, target, local, 3, i64::from(click_state), flags)
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
	flags: CGEventFlags,
) -> CoreResult<()> {
	let group = click_group_id();
	let (cg_button, down, up, _, number) = button_types(button);
	post_hover(source, pid, wid, window, x, y, group)?;
	control::wait(Duration::from_millis(12))?;
	let count = count.max(1);
	for click_state in 1..=count {
		let press = mouse_event(source, down, CGPoint::new(x, y), cg_button)?;
		let release = mouse_event(source, up, CGPoint::new(x, y), cg_button)?;
		press.set_flags(flags);
		release.set_flags(flags);
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
/// with `skylight::post_dual`.
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
	route_window_pointer(pid, wid, window, event, x, y, click_state, button_number, group)?;
	skylight::post_dual(pid, event)
}

/// The window-routing fields and timestamp of a background pointer event. The
/// window location is window-local, as the public route expects.
fn route_window_pointer(
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
	// Only window-routed events carry a time; the activation press, the
	// left-click route and wheel events keep 0, which their targets accept.
	stamp_now(event);
	Ok(())
}

/// Stamps `event` with the current time. A Quartz-created event carries
/// timestamp 0, and a background target that times a gesture from its events'
/// timestamps, as a web page's `event.timeStamp` does, would see a held press
/// released the instant it went down.
fn stamp_now(event: &CGEvent) {
	// SAFETY: `clock_gettime_nsec_np` only reads the clock; `event` is a live
	// CGEvent. Quartz event timestamps count nanoseconds of system uptime.
	unsafe { set_event_timestamp(event.as_ptr(), clock_gettime_nsec_np(libc::CLOCK_UPTIME_RAW)) };
}

unsafe extern "C" {
	/// `<time.h>`: the time on `clock` in nanoseconds.
	fn clock_gettime_nsec_np(clock: libc::clockid_t) -> u64;
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
	for value in graphemes_str(text) {
		let mut characters = value.chars().peekable();
		while characters.peek().is_some() {
			control::check()?;
			// Quartz keyboard events carry at most 20 UTF-16 units. Keep
			// ordinary graphemes intact and never split a surrogate pair.
			let mut units = [0u16; 20];
			let mut length = 0;
			while let Some(&character) = characters.peek() {
				if length + character.len_utf16() > units.len() {
					break;
				}
				length += character.encode_utf16(&mut units[length..]).len();
				characters.next();
			}
			let press = CGEvent::new_keyboard_event(source.clone(), 0, true)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			let release = CGEvent::new_keyboard_event(source.clone(), 0, false)
				.map_err(|()| DesktopError::input_failed("failed to create a Quartz keyboard event"))?;
			for event in [&press, &release] {
				event.set_string_from_utf16_unchecked(&units[..length]);
				event.set_flags(CGEventFlags::CGEventFlagNull);
			}
			let result = post(&press).and_then(|()| control::wait(KEY_GAP));
			let cleanup = control::cleanup(|| post(&release));
			skylight::after_cleanup(result, cleanup)?;
			control::wait(KEY_GAP)?;
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
		control::check()?;
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
	let post = |code, down| {
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
	};
	let mut held = [false; 128];
	let result = (|| {
		for &(code, down) in transitions {
			control::check()?;
			post(code, down)?;
			held[usize::from(code)] = down;
			control::wait(KEY_GAP)?;
		}
		Ok(())
	})();
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

fn background_chord(source: &CGEventSource, pid: libc::pid_t, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, |event| skylight::post_keyboard(pid, event))
}

fn global_chord(source: &CGEventSource, keys: &[KeyName]) -> CoreResult<()> {
	key_chord(source, keys, post_global)
}

fn key_chord(
	source: &CGEventSource,
	keys: &[KeyName],
	post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(DesktopError::invalid_key("key chord must not be empty"));
	}
	with_held_keys(source, keys, post, control::check)
}

fn with_held_keys(
	source: &CGEventSource,
	keys: &[KeyName],
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
			.and_then(|()| control::wait(KEY_GAP))
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
/// With `menu`, the item path is chosen in the menu the click opens before
/// focus goes back, which would close the menu.
fn foreground_pointer(
	source: &CGEventSource,
	window: &DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	event: PointerEvent,
	menu: Option<&[String]>,
) -> CoreResult<()> {
	let kind = pointer_kind(&event);
	let timeout = if may_open_context_menu(&event) {
		ax::open_menu::CONTEXT_MENU_TIMEOUT
	} else {
		ax::open_menu::CONTROL_MENU_TIMEOUT
	};
	preserving_cursor(source, || {
		skylight::with_foreground(pid, wid, |_| {
			let activity = control::user_activity();
			let mut occluder = None;
			let result = uncover(window, pid, wid, &event, &mut occluder)
				.and_then(|()| skylight::require_front_window(pid, wid))
				.and_then(|()| match (event, menu) {
					(PointerEvent::Scroll { x, y, dx, dy }, _) => {
						let side = primer_side(window, x);
						global_scroll(source, x, y, dx, dy, side, || {
							skylight::require_front_window(pid, wid)
						})
					},
					(event, None) => global_pointer(source, event),
					(event, Some(path)) => {
						let before = capture::menu_windows(pid).ok_or_else(|| {
							DesktopError::input_failed(format!(
								"cannot list the open menus of window {} ({}), so no menu item could be \
								 chosen; nothing was sent",
								window.id, window.app,
							))
						})?;
						ax::open_menu::guard(
							ax::open_menu::Press::Pointer { kind, window },
							Some(&before),
							Some(path),
							|| global_pointer(source, event),
							|before, path| ax::open_menu::settle(pid, before, path, timeout),
						)
					},
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
			with_held_keys(source, &keys, post_global, || {
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
	let result = with_held_keys(hid_source, keys, post_global, || {
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
			type_text(&source, "e\u{301}later", |event| {
				events.push(event.get_type());
				if matches!(event.get_type(), CGEventType::KeyDown) {
					cancellation.cancel();
				}
				Ok(())
			})
		});
		assert!(result.is_err());
		assert!(matches!(events.as_slice(), [CGEventType::KeyDown, CGEventType::KeyUp]));
		assert!(cancellation.token().check().is_ok());
		assert!(token.check().is_err());
	}

	#[test]
	fn cancelling_chord_releases_modifier_without_pressing_next_key() {
		let source = source().expect("event source");
		let cancellation = control::CancellationSource::default();
		let token = cancellation.token();
		let mut events = Vec::new();
		let result = control::with_token_for_test(&token, || {
			key_chord(&source, &[KeyName::Ctrl, KeyName::Char('a')], |event| {
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
		ax::AxWindowRecord { id: Some(id), minimized }
	}

	#[test]
	fn keyboard_destination_counts_only_windows_that_can_be_key() {
		let listed_only = || false;
		assert_eq!(keyboard_conflict(10, &[record(10, Some(false))], listed_only), None);
		assert_eq!(
			keyboard_conflict(10, &[record(10, Some(false)), record(11, Some(true))], listed_only),
			None
		);
		assert_eq!(
			keyboard_conflict(
				10,
				&[record(10, Some(false)), record(11, None), record(12, Some(false))],
				listed_only
			),
			Some(KeyboardConflict::Siblings(2)),
		);
		assert_eq!(
			keyboard_conflict(10, &[record(11, Some(false))], listed_only),
			Some(KeyboardConflict::Unmapped),
		);
	}

	#[test]
	fn ax_window_without_an_id_is_a_sibling_not_a_failure() {
		// Finder lists its desktop in AXWindows with no window id.
		let desktop = ax::AxWindowRecord { id: None, minimized: None };
		assert_eq!(
			keyboard_conflict(10, &[record(10, Some(false)), desktop], || false),
			Some(KeyboardConflict::Siblings(1)),
		);
	}

	#[test]
	fn a_sheet_outside_ax_windows_is_a_window_of_its_application() {
		// Finder's Go to Folder sheet 41740 is attached to window 41732 and
		// missing from AXWindows, which lists the window, another one and the
		// desktop: keys for the sheet wait until it is the focused window.
		let desktop = ax::AxWindowRecord { id: None, minimized: None };
		let records = [record(41732, Some(false)), record(35240, Some(false)), desktop];
		assert_eq!(keyboard_conflict(41740, &records, || true), Some(KeyboardConflict::Siblings(3)),);
		assert_eq!(keyboard_conflict(41740, &records, || false), Some(KeyboardConflict::Unmapped));
		// A sheet opened on a sheet: 191 on 186 on listed window 177.
		let parents = |id| match id {
			191 => Some(186),
			186 => Some(177),
			_ => None,
		};
		assert!(attached_under(191, parents, |parent| parent == 177));
		assert!(!attached_under(177, parents, |parent| parent == 177));
	}

	#[test]
	fn keys_wait_while_the_application_reports_another_focused_window() {
		// Finder's Go to Folder sheet 41740 is attached to window 41732 and is
		// Finder's focused window; keys posted to Finder land in the sheet.
		let sheet = ax::KeyDestination::Other(Some(41740));
		assert_eq!(key_route(7, sheet, None), KeyRoute::Wait);
		assert_eq!(key_route(7, sheet, Some(KeyboardConflict::Siblings(3))), KeyRoute::Wait);
		assert_eq!(key_route(7, ax::KeyDestination::Other(None), None), KeyRoute::Wait);
		assert_eq!(key_route(7, ax::KeyDestination::Target(7), None), KeyRoute::Deliver(7));
		// No focused window reported: only a lone window proves the destination.
		assert_eq!(key_route(7, ax::KeyDestination::Unreported, None), KeyRoute::Deliver(7));
		assert_eq!(
			key_route(7, ax::KeyDestination::Unreported, Some(KeyboardConflict::Siblings(1))),
			KeyRoute::Wait,
		);
	}

	#[test]
	fn keys_for_a_window_behind_its_own_sheet_name_the_sheet() {
		use crate::desktop::error::ErrorCode;
		let parents = |id| match id {
			41740 => Some(41732),
			191 => Some(186),
			186 => Some(177),
			_ => None,
		};
		let sheet = key_refusal(41732, ax::KeyDestination::Other(Some(41740)), None, parents);
		assert_eq!(sheet.code, ErrorCode::InvalidTarget);
		assert!(sheet.message.contains("send them to window 41740"));
		// A sheet opened on another sheet still blocks the window under both.
		let nested = key_refusal(177, ax::KeyDestination::Other(Some(191)), None, parents);
		assert_eq!(nested.code, ErrorCode::InvalidTarget);
		// A focused window that is not attached can still be replaced in
		// takeover.
		let sibling = key_refusal(41732, ax::KeyDestination::Other(Some(35240)), None, parents);
		assert_eq!(sibling.code, ErrorCode::BackgroundUnavailable);
		assert!(sibling.message.contains("window 35240 still is"));
	}

	#[test]
	fn keys_for_a_system_panel_go_to_the_process_that_draws_it() {
		use crate::desktop::error::ErrorCode;
		let focus = |window, element, mapped| ax::KeyFocus {
			window:         ax::FocusedWindow::Id(window),
			element_window: Some(element),
			element_mapped: mapped,
		};
		let unread = || -> ax::WindowContent { panic!("focus in the window itself proves the host") };
		let unasked = |_| -> Option<u32> { panic!("no other process is involved") };
		// TextEdit (pid 7581) reports its Open panel 554 as focused; the focused
		// list is in window 556 of openAndSavePanelService (pid 7592), which
		// reports that window focused.
		let open = focus(554, 556, true);
		let drawn = |window| move || ax::WindowContent::Remote { pid: 7592, window };
		assert_eq!(key_process(7581, 554, &open, drawn(556), |_| Some(556)).unwrap(), 7592);
		// Its Go to Folder sheet 561: the path field maps to no window, so the
		// ascent ends at the sheet, and the service draws it in window 559.
		let go_to = focus(561, 561, false);
		assert_eq!(key_process(7581, 561, &go_to, drawn(559), |_| Some(559)).unwrap(), 7592);
		// While the service reports focus in another window, nothing is sent.
		let error = key_process(7581, 554, &open, drawn(556), |_| Some(559))
			.expect_err("keys the service would not take must refuse");
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		assert!(error.message.contains("process 7592"));
		// A window drawn by its own process keeps the keys.
		assert_eq!(key_process(7581, 554, &open, || ax::WindowContent::Own, unasked).unwrap(), 7581);
		// A focused element in the window itself, or Finder's rename overlay
		// while Finder reports no focused window, never reads the content.
		assert_eq!(key_process(7581, 543, &focus(543, 543, true), unread, unasked).unwrap(), 7581);
		let rename = ax::KeyFocus {
			window:         ax::FocusedWindow::Unreported,
			element_window: Some(41743),
			element_mapped: true,
		};
		assert_eq!(key_process(7, 41732, &rename, unread, unasked).unwrap(), 7);
	}

	#[test]
	fn pointer_input_for_a_system_panel_goes_to_the_window_that_draws_it() {
		use crate::desktop::error::ErrorCode;
		// Clicks for TextEdit's Save sheet 1362 go to openAndSavePanelService
		// (pid 16472) stamped with its window 1363, which it reports focused.
		let drawn = ax::WindowContent::Remote { pid: 16472, window: 1363 };
		assert_eq!(input_owner(16467, 1362, drawn, |_| Some(1363)).unwrap(), (16472, 1363));
		let error = input_owner(16467, 1362, drawn, |_| None)
			.expect_err("a click the service would not take must refuse before anything is sent");
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		let unasked = |_| -> Option<u32> { panic!("no other process is involved") };
		assert_eq!(input_owner(16467, 1337, ax::WindowContent::Own, unasked).unwrap(), (16467, 1337));
	}

	#[test]
	fn shortcut_into_an_application_that_stops_answering_fails() {
		let window = DesktopWindow {
			id:      "42".to_string(),
			title:   "visitor-form.txt".to_string(),
			app:     "TextEdit".to_string(),
			pid:     Some(7),
			x:       0,
			y:       0,
			width:   300,
			height:  200,
			focused: false,
		};
		let save = [KeyName::Meta, KeyName::Char('s')];
		let error = confirm_shortcut_answered(&window, &save, || Ok(true))
			.expect_err("a hung application must not report the shortcut as done");
		assert_eq!(error.code, crate::desktop::error::ErrorCode::InputFailed);
		assert!(
			error
				.message
				.contains("whether the shortcut took effect is unknown")
		);
		assert!(confirm_shortcut_answered(&window, &save, || Ok(false)).is_ok());
		let unchecked =
			|| -> CoreResult<bool> { panic!("a chord without a modifier is not checked") };
		assert!(confirm_shortcut_answered(&window, &[KeyName::Enter], unchecked).is_ok());
	}

	#[test]
	fn interrupted_chord_releases_every_attempted_key() {
		let source = source().expect("Quartz event source");
		let mut events = Vec::new();
		let result = key_chord(&source, &[KeyName::Ctrl, KeyName::Enter], |event| {
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
		let result = key_chord(&source, &[KeyName::Ctrl, KeyName::Shift, KeyName::Enter], |event| {
			let kind = event.get_type();
			let code = event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE);
			let flags = event.get_flags();
			let shift = flags.contains(CGEventFlags::CGEventFlagShift);
			events.push((kind as u32, code, flags.contains(CGEventFlags::CGEventFlagControl), shift));
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

	fn background_window(app: &str) -> DesktopWindow {
		DesktopWindow {
			id:      "42".to_string(),
			title:   String::new(),
			app:     app.to_string(),
			pid:     Some(7),
			x:       0,
			y:       0,
			width:   300,
			height:  200,
			focused: false,
		}
	}

	/// The pointer gestures a background target used to be refused: drags,
	/// holds, modified clicks and right-clicks press a button; scrolls and moves
	/// do not.
	fn gestures() -> (Vec<PointerEvent>, Vec<PointerEvent>) {
		let meta = Modifiers { meta: true, ..Modifiers::default() };
		let shift = Modifiers { shift: true, ..Modifiers::default() };
		let click =
			|button, modifiers| PointerEvent::Click { x: 10.0, y: 10.0, button, count: 1, modifiers };
		let presses = vec![
			PointerEvent::Drag {
				path:      vec![(10.0, 10.0), (90.0, 40.0)],
				button:    MouseButton::Left,
				modifiers: meta,
				keys:      vec![KeyName::Space],
			},
			PointerEvent::Hold {
				x:        10.0,
				y:        10.0,
				button:   MouseButton::Left,
				keys:     Vec::new(),
				duration: Duration::from_secs(1),
			},
			click(MouseButton::Left, meta),
			click(MouseButton::Left, shift),
			click(MouseButton::Right, Modifiers::default()),
			click(MouseButton::Left, Modifiers::default()),
		];
		let others = vec![
			PointerEvent::Scroll { x: 10.0, y: 10.0, dx: 0.0, dy: -40.0 },
			PointerEvent::Scroll { x: 10.0, y: 10.0, dx: -40.0, dy: 0.0 },
			PointerEvent::Move { x: 10.0, y: 10.0 },
		];
		(presses, others)
	}

	#[test]
	fn background_guard_refuses_only_presses_into_a_tk_that_reads_the_hardware_pointer() {
		let window = background_window("Python");
		let (presses, others) = gestures();
		let refused: Vec<_> = presses
			.iter()
			.chain(&others)
			.filter(|event| refuse_pointer(&window, event, || false, || false).is_err())
			.collect();
		assert!(refused.is_empty(), "refused outside Tk: {refused:#?}");
		// Tk 9 places every press at the user's pointer, wherever the event says.
		for event in &presses {
			let refused =
				refuse_pointer(&window, event, || false, || true).expect_err("press into Tk 9");
			assert_eq!(refused.code.as_str(), "BackgroundUnavailable");
		}
		for event in &others {
			assert!(
				refuse_pointer(&window, event, || false, || true).is_ok(),
				"{event:?} was refused"
			);
		}
	}

	#[test]
	fn screen_sharing_refuses_pointer_gestures_that_hold_keys() {
		// Screen Sharing relays only physical key transitions, so the keys and
		// modifier flags of a background gesture would not reach the remote host.
		let window = background_window("Screen Sharing");
		let meta = Modifiers { meta: true, ..Modifiers::default() };
		let drag = |modifiers, keys| PointerEvent::Drag {
			path: vec![(10.0, 10.0), (90.0, 40.0)],
			button: MouseButton::Left,
			modifiers,
			keys,
		};
		let hold = |keys| PointerEvent::Hold {
			x: 10.0,
			y: 10.0,
			button: MouseButton::Left,
			keys,
			duration: Duration::from_secs(1),
		};
		let click = |modifiers| PointerEvent::Click {
			x: 10.0,
			y: 10.0,
			button: MouseButton::Left,
			count: 1,
			modifiers,
		};
		for event in [
			drag(Modifiers::default(), vec![KeyName::Space]),
			drag(meta, Vec::new()),
			hold(vec![KeyName::Shift]),
			click(meta),
		] {
			let refused = refuse_pointer(&window, &event, || true, || false)
				.expect_err("keys into Screen Sharing");
			assert_eq!(refused.code.as_str(), "BackgroundUnavailable", "{event:?}");
			assert!(refuse_pointer(&window, &event, || false, || false).is_ok(), "{event:?}");
		}
		for event in [
			drag(Modifiers::default(), Vec::new()),
			hold(Vec::new()),
			click(Modifiers::default()),
			PointerEvent::Scroll { x: 10.0, y: 10.0, dx: 0.0, dy: -40.0 },
		] {
			assert!(refuse_pointer(&window, &event, || true, || false).is_ok(), "{event:?}");
		}
	}

	#[test]
	fn a_hold_that_can_open_a_context_menu_is_refused_before_anything_is_sent() {
		// The menu would hold the user's keyboard until the button is released.
		let window = background_window("Google Chrome");
		let hold = |button, keys| PointerEvent::Hold {
			x: 10.0,
			y: 10.0,
			button,
			keys,
			duration: Duration::from_secs(100),
		};
		let verdict = |event: &PointerEvent| {
			refuse_pointer(&window, event, || false, || false).map_err(|error| error.code.as_str())
		};
		assert_eq!(verdict(&hold(MouseButton::Right, Vec::new())), Err("BackgroundUnavailable"));
		assert_eq!(
			verdict(&hold(MouseButton::Left, vec![KeyName::Ctrl])),
			Err("BackgroundUnavailable")
		);
		assert_eq!(verdict(&hold(MouseButton::Left, Vec::new())), Ok(()));
		assert_eq!(verdict(&hold(MouseButton::Left, vec![KeyName::Shift])), Ok(()));
		assert_eq!(verdict(&hold(MouseButton::Middle, vec![KeyName::Ctrl])), Ok(()));
		let drag = |button, modifiers| PointerEvent::Drag {
			path: vec![(10.0, 10.0); 500],
			button,
			modifiers,
			keys: Vec::new(),
		};
		assert_eq!(
			verdict(&drag(MouseButton::Right, Modifiers::default())),
			Err("BackgroundUnavailable")
		);
		assert_eq!(
			verdict(&drag(MouseButton::Left, Modifiers { ctrl: true, ..Modifiers::default() })),
			Err("BackgroundUnavailable")
		);
		assert_eq!(verdict(&drag(MouseButton::Left, Modifiers::default())), Ok(()));
		// A right-click ends at once, so its menu is closed instead.
		let right_click = PointerEvent::Click {
			x:         10.0,
			y:         10.0,
			button:    MouseButton::Right,
			count:     1,
			modifiers: Modifiers::default(),
		};
		assert_eq!(verdict(&right_click), Ok(()));
	}

	#[test]
	fn background_pointer_events_carry_the_time_they_are_routed() {
		// A page times a held press from its events' timestamps; Quartz leaves
		// them at 0, which made a 1 s background hold measure 0 ms.
		let source = source().expect("event source");
		let window = background_window("Electron");
		let event = mouse_event(
			&source,
			CGEventType::LeftMouseDown,
			CGPoint::new(10.0, 10.0),
			CGMouseButton::Left,
		)
		.expect("press");
		// SAFETY: `clock_gettime_nsec_np` only reads the clock.
		let before = unsafe { clock_gettime_nsec_np(libc::CLOCK_UPTIME_RAW) };
		route_window_pointer(7, 42, &window, &event, 10.0, 10.0, 1, 0, 1).expect("route");
		// SAFETY: `event` is a live CGEvent.
		let stamped = unsafe { get_event_timestamp(event.as_ptr()) };
		// SAFETY: as above.
		let after = unsafe { clock_gettime_nsec_np(libc::CLOCK_UPTIME_RAW) };
		assert!((before..=after).contains(&stamped), "{before} <= {stamped} <= {after}");
	}

	#[test]
	fn secondary_presses_are_the_gestures_that_can_open_a_context_menu() {
		let ctrl = Modifiers { ctrl: true, ..Modifiers::default() };
		let click =
			|button, modifiers| PointerEvent::Click { x: 1.0, y: 1.0, button, count: 1, modifiers };
		let drag = |button, modifiers, keys| PointerEvent::Drag {
			path: vec![(1.0, 1.0), (9.0, 9.0)],
			button,
			modifiers,
			keys,
		};
		let hold = |button, keys| PointerEvent::Hold {
			x: 1.0,
			y: 1.0,
			button,
			keys,
			duration: Duration::from_secs(1),
		};
		for event in [
			click(MouseButton::Right, Modifiers::default()),
			click(MouseButton::Left, ctrl),
			drag(MouseButton::Right, Modifiers::default(), Vec::new()),
			drag(MouseButton::Left, ctrl, Vec::new()),
			drag(MouseButton::Left, Modifiers::default(), vec![KeyName::Ctrl]),
			hold(MouseButton::Right, Vec::new()),
			hold(MouseButton::Left, vec![KeyName::Ctrl]),
		] {
			assert!(may_open_context_menu(&event), "{event:?}");
		}
		for event in [
			click(MouseButton::Left, Modifiers { meta: true, ..Modifiers::default() }),
			click(MouseButton::Middle, ctrl),
			drag(MouseButton::Left, Modifiers::default(), vec![KeyName::Space]),
			hold(MouseButton::Left, Vec::new()),
			PointerEvent::Scroll { x: 1.0, y: 1.0, dx: 0.0, dy: 5.0 },
			PointerEvent::Move { x: 1.0, y: 1.0 },
		] {
			assert!(!may_open_context_menu(&event), "{event:?}");
		}
	}

	#[test]
	fn held_keys_need_the_target_as_key_window_whatever_the_button() {
		let ready = |button, holds_keys, conflict: Option<KeyboardConflict>, keyed| {
			let steps = std::cell::RefCell::new(Vec::new());
			let result = ready_press(
				42,
				button,
				holds_keys,
				|| conflict,
				|| {
					steps.borrow_mut().push("make key");
					Ok(true)
				},
				|| {
					steps.borrow_mut().push("await key");
					Ok(keyed)
				},
				|| Ok(()),
			);
			(result.map_err(|error| error.code.as_str()), steps.into_inner())
		};
		let both = vec!["make key", "await key"];
		// A right or middle press without keys needs no key window.
		assert_eq!(ready(MouseButton::Right, false, None, false), (Ok(()), Vec::new()));
		// A left press is readied, and goes ahead even when the app never
		// reports its key window: it has no other window to reach.
		assert_eq!(ready(MouseButton::Left, false, None, false), (Ok(()), both.clone()));
		// Held keys into an app with other windows go only once the target is
		// key, for any button.
		for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
			let siblings = Some(KeyboardConflict::Siblings(1));
			assert_eq!(
				ready(button, true, siblings, false),
				(Err("BackgroundUnavailable"), both.clone())
			);
			let siblings = Some(KeyboardConflict::Siblings(1));
			assert_eq!(ready(button, true, siblings, true), (Ok(()), both.clone()));
			assert_eq!(
				ready(button, true, Some(KeyboardConflict::Unmapped), true),
				(Err("BackgroundUnavailable"), Vec::new())
			);
			assert_eq!(ready(button, true, None, false), (Ok(()), both.clone()));
		}
	}

	#[test]
	fn a_held_press_stops_when_its_app_comes_to_the_front_during_preparation() {
		let ready = |prepared: bool| {
			let steps = std::cell::RefCell::new(Vec::new());
			let result = ready_press(
				42,
				MouseButton::Left,
				false,
				|| None,
				|| Ok(prepared),
				|| {
					steps.borrow_mut().push("await key");
					Ok(true)
				},
				|| {
					steps.borrow_mut().push("still behind");
					Err(DesktopError::background_unavailable("came to the front"))
				},
			);
			(result.map_err(|error| error.code.as_str()), steps.into_inner())
		};
		// The user can bring the target forward while it becomes key; the press
		// would then switch the key window of the app they type into.
		assert_eq!(ready(true), (Err("BackgroundUnavailable"), vec!["await key", "still behind"]));
		// The target already was the frontmost key window: nothing to re-check.
		assert_eq!(ready(false), (Ok(()), vec!["await key"]));
	}

	#[test]
	fn a_drag_is_released_at_the_last_point_attempted_after_a_failed_post() {
		let path = [CGPoint::new(1.0, 1.0), CGPoint::new(5.0, 5.0), CGPoint::new(9.0, 9.0)];
		let run = |fail_on: Option<(Stroke, f64)>| {
			let mut posted = Vec::new();
			let result = stroke_path(&path, |stroke, at| {
				posted.push((stroke, at.x));
				if fail_on == Some((stroke, at.x)) {
					Err(DesktopError::input_failed("delivery may be partial"))
				} else {
					Ok(())
				}
			});
			(result.is_ok(), posted)
		};
		use Stroke::{Down, Dragged, Up};
		assert_eq!(run(None), (true, vec![(Down, 1.0), (Dragged, 5.0), (Dragged, 9.0), (Up, 9.0)]));
		// A press that may have been delivered is still released.
		assert_eq!(run(Some((Down, 1.0))), (false, vec![(Down, 1.0), (Up, 1.0)]));
		// The release goes where the failed move may have taken the target.
		assert_eq!(run(Some((Dragged, 5.0))), (false, vec![(Down, 1.0), (Dragged, 5.0), (Up, 5.0)]));
	}

	#[test]
	fn a_drag_that_starts_a_drag_and_drop_session_reports_its_drop_as_unconfirmed() {
		use std::cell::{Cell, RefCell};
		let window = background_window("Font Book");
		// `reads` are the drag pasteboard's change counts after the release, in
		// order; the count before the press was 7.
		let run = |reads: &[isize]| {
			let next = Cell::new(0);
			let log = RefCell::new(Vec::new());
			let outcome = drag_session_outcome(
				&window,
				7,
				|| {
					let count = reads[next.get()];
					next.set(next.get() + 1);
					log.borrow_mut().push(format!("read {count}"));
					count
				},
				|| log.borrow_mut().push("caught up".to_owned()),
			);
			(outcome.map_err(|error| (error.code.as_str(), error.message)), log.into_inner())
		};
		// Font Book wrote the drag pasteboard while it handled the routed
		// drag: its session may drop the font at the path's end, elsewhere or
		// nowhere, so the call throws with the drop unconfirmed instead of
		// returning as if it had moved, and says to read the target first.
		let (outcome, log) = run(&[8]);
		assert_eq!(log, vec!["read 8".to_owned()]);
		let (code, message) = outcome.unwrap_err();
		assert_eq!(code, "InputFailed");
		assert!(message.contains("could not be confirmed"), "{message}");
		assert!(message.contains("may already have been dropped"), "{message}");
		assert!(message.contains("before retrying"), "{message}");
		// A source that begins its session only once it catches up with the
		// events is found by the read after the round trip.
		let (outcome, log) = run(&[7, 9]);
		assert_eq!(log, vec!["read 7".to_owned(), "caught up".to_owned(), "read 9".to_owned()]);
		assert_eq!(outcome.unwrap_err().0, "InputFailed");
		// A drag inside a view (a slider, a selection) leaves the pasteboard
		// alone.
		assert_eq!(
			run(&[7, 7]),
			(Ok(()), vec!["read 7".to_owned(), "caught up".to_owned(), "read 7".to_owned()])
		);
	}

	#[test]
	fn key_window_step_never_moves_the_frontmost_applications_key_window() {
		// A non-key window of the frontmost app shares the user's key window:
		// preparing it would send the user's next keystrokes and pastes there.
		let unread =
			|| -> Option<u32> { panic!("a background process's focused window is not read") };
		assert_eq!(front_target(Some(9), Some(9), 7, 42, unread), FrontTarget::Background);
		assert_eq!(front_target(Some(9), None, 7, 42, unread), FrontTarget::Unknown);
		assert_eq!(front_target(Some(7), Some(7), 7, 42, || Some(42)), FrontTarget::Key);
		assert_eq!(front_target(Some(7), Some(7), 7, 42, || Some(43)), FrontTarget::UserSibling);
		assert_eq!(front_target(Some(7), Some(7), 7, 42, || None), FrontTarget::UserSibling);
	}

	#[test]
	fn a_target_brought_forward_before_its_key_window_step_refuses_even_as_key() {
		// The user brought the background target forward and picked its window:
		// delivering now would type into the window they just selected.
		assert_eq!(front_target(Some(9), Some(7), 7, 42, || Some(42)), FrontTarget::CameForward);
		assert_eq!(front_target(None, Some(7), 7, 42, || Some(42)), FrontTarget::CameForward);
	}

	#[test]
	fn a_target_that_comes_to_the_front_during_preparation_stops_the_input() {
		// Once the user brings the target forward, the activation step would
		// move the key window of the app they now type into.
		assert!(!left_background(Some(9), 7));
		assert!(left_background(Some(7), 7));
		assert!(left_background(None, 7));
	}

	#[test]
	fn input_into_an_inactive_application_waits_until_it_reports_the_activation() {
		use std::cell::RefCell;
		// The activation flushes an accessibility edit into NSDocument, whose
		// first edit holds the save lock until the run loop turns; a ⌘S queued
		// right behind it blocked TextEdit forever. The app's report of the
		// activation comes from such a turn. Here it reports three polls late.
		let app = RefCell::new((false, 0usize));
		let log = RefCell::new(Vec::new());
		activate_then_await(
			Some(false),
			ACTIVE_STATE_TIMEOUT,
			|| {
				log.borrow_mut().push("activate".to_owned());
				app.borrow_mut().1 = 3;
				Ok(())
			},
			|| {
				let mut app = app.borrow_mut();
				app.1 = app.1.saturating_sub(1);
				app.0 |= app.1 == 0;
				log.borrow_mut().push(format!("reports {}", app.0));
				Some(app.0)
			},
			|| Ok(()),
		)
		.expect("activation");
		assert_eq!(log.into_inner(), ["activate", "reports false", "reports false", "reports true"]);
	}

	#[test]
	fn activation_waits_only_for_a_report_it_can_observe_in_time() {
		let unread = || -> Option<bool> { panic!("no report is awaited") };
		let no_wait = || -> CoreResult<()> { panic!("no poll interval is slept") };
		// Already active, or no readable state: the activation changes nothing
		// observable, so delivery follows at once.
		for was_active in [Some(true), None] {
			activate_then_await(was_active, ACTIVE_STATE_TIMEOUT, || Ok(()), unread, no_wait)
				.expect("activation");
		}
		// An application that never reports the activation does not stop the
		// input once the bound has passed.
		activate_then_await(Some(false), Duration::ZERO, || Ok(()), || Some(false), no_wait)
			.expect("an unreported activation is not an error");
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
