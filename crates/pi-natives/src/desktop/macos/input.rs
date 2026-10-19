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
use objc2_application_services::AXUIElement;
use xutf::graphemes_str;

use super::{
	super::{
		backend::{
			DeliveryMode, ElementDelivery, ElementInput, KeyboardFocus, Modifiers, MouseButton,
			PointerEvent,
		},
		control,
		error::{CoreResult, DesktopError, ErrorCode},
		keys::KeyName,
		types::{DesktopWindow, Target},
	},
	ax,
	capture::{self, MacCapture},
	keymap::{Keymap, Keystroke},
	process::{self, RemoteScreen},
	release::Route,
	release_guard, route, skylight,
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
						let (entry_front, (window, wid, in_overlay)) =
							EntryFront::before(skylight::front_pid, || {
								let (window, wid) = attached_window(capture, window, pid, wid, &event)?;
								let in_overlay =
									takes_overlay_focus(wid, ax::key_focus(pid), skylight::window_parent);
								background_guard(&window, pid, &event)?;
								Ok((window, wid, in_overlay))
							})?;
						let owner = || -> CoreResult<(libc::pid_t, u32)> {
							let owner = input_owner(
								pid,
								wid,
								ax::window_content(pid, &window),
								ax::focused_window_id,
							)?;
							control::intervention::input_goes_to(owner.0);
							Ok(owner)
						};
						skylight::with_background_watch(pid, |visit| {
							if process::remote_screen(pid) == Some(RemoteScreen::HidReports) {
								if menu.is_some() {
									return Err(DesktopError::invalid_target(format!(
										"window {wid} of {} shows a paired device's screen, whose menus are \
										 no accessibility menus; click without menu, then capture",
										window.app,
									)));
								}
								report_pointer(
									&self.source,
									pid,
									wid,
									&window,
									event,
									entry_front,
									owner,
									in_overlay,
									visit,
								)
							} else {
								background_pointer(
									&self.source,
									pid,
									wid,
									&window,
									event,
									menu,
									entry_front,
									owner,
									in_overlay,
									visit,
								)
							}
						})
					},
					DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
						foreground_pointer(
							&self.source,
							&window,
							pid,
							wid,
							event,
							returns_focus(mode),
							menu,
						)
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
			Target::Desktop | Target::Display(_) => {
				type_keys(&self.source, &unicode_keys(text), KEY_GAP, || Ok(()), post_global)
			},
			Target::Window(id) => {
				self.window_type(&capture.window(id)?, text, mode, None)?;
				Ok(())
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
				self.window_chord(&capture.window(id)?, keys, mode, None)?;
				Ok(())
			},
		}
	}

	/// Types or presses `input` into `element`, an element of window `id`.
	#[allow(
		clippy::needless_pass_by_ref_mut,
		reason = "`&mut self` exclusivity backs the `Send` safety argument for the CF event source"
	)]
	pub(super) fn element_input(
		&mut self,
		id: &str,
		element: &AXUIElement,
		input: &ElementInput,
		mode: DeliveryMode,
		capture: &MacCapture,
	) -> CoreResult<ElementDelivery> {
		let window = capture.window(id)?;
		match input {
			ElementInput::Text(text) => self.window_type(&window, text, mode, Some(element)),
			ElementInput::Chord(keys) => self.window_chord(&window, keys, mode, Some(element)),
		}
	}

	/// Types `text` into `window`; with an `element`, into that element: AX
	/// insertion when it takes it ([`inserts_first`]), else keys once it holds
	/// keyboard focus ([`element_keys`]). A remote screen (Screen Sharing,
	/// iPhone Mirroring) shows another device, so it takes no insertion: its
	/// text goes out as keys of the user's keyboard layout ([`keys_for`]).
	fn window_type(
		&self,
		window: &DesktopWindow,
		text: &str,
		mode: DeliveryMode,
		element: Option<&AXUIElement>,
	) -> CoreResult<ElementDelivery> {
		let (pid, wid) = window_identity(window)?;
		// Read before anything about the target ([`EntryFront::before`]).
		let entry_front = EntryFront::now();
		let remote = process::remote_screen(pid);
		// A takeover write goes to the window brought to the front for it.
		let behind_user = || match mode {
			DeliveryMode::Background => entry_front.require_behind(skylight::front_pid(), pid, wid),
			DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => Ok(()),
		};
		let inserted = inserts_first(mode, element.is_some(), text, || {
			if remote.is_some() || process::is_terminal(pid) {
				return Ok(false);
			}
			match element {
				Some(element) => ax::insert_into_element(element, text, behind_user),
				None => ax::insert_native_text(pid, wid, text, behind_user),
			}
		})?;
		if inserted {
			return Ok(ElementDelivery::Delivered);
		}
		// The whole text is mapped before anything is posted, so a character a
		// remote screen cannot receive refuses cleanly.
		let keys = keys_for(window, text, remote, layout_strokes)?;
		let gap = key_gap(remote);
		match mode {
			DeliveryMode::Background => {
				if remote == Some(RemoteScreen::KeyEvents) {
					let modified = modified_text(&keys);
					if !modified.is_empty() {
						return Err(keyboard_modifiers_refusal(
							window,
							&format!("type {}", modified.join(" ")),
						));
					}
				}
				let mut physical = remote_modifier_check(remote, window);
				with_background_keyboard(&self.source, pid, wid, window, entry_front, |to, guard| {
					element_keys(pid, element, || {
						let guard = || {
							guard()?;
							physical.as_mut().map_or(Ok(()), |check| check())
						};
						type_keys(&self.source, &keys, gap, guard, |event| {
							skylight::post_keyboard(to, event)
						})
					})
				})
			},
			DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
				skylight::with_foreground(pid, wid, returns_focus(mode), |activated| {
					control::wait(first_key_settle(activated))?;
					element_keys(pid, element, || {
						if remote.is_some() {
							// A remote screen may read modifiers from the keyboard
							// state, which only bare key
							// transitions at the HID tap move. They
							// post globally, so every press first checks that the
							// target still has focus.
							post_bare_keys(&bare_transitions(&keys), gap, || {
								skylight::require_front_window(pid, wid)
							})
						} else {
							// Stop rather than typing into a newly user-selected app
							// or window.
							type_keys(
								&self.source,
								&keys,
								gap,
								|| skylight::require_front_window(pid, wid),
								post_global,
							)
						}
					})
				})
			},
		}
	}

	/// Presses `keys` in `window`; with an `element`, once that element holds
	/// keyboard focus ([`element_keys`]). On a remote screen the keys are the
	/// user's keyboard layout's ([`chord_keys`]).
	fn window_chord(
		&self,
		window: &DesktopWindow,
		keys: &[KeyName],
		mode: DeliveryMode,
		element: Option<&AXUIElement>,
	) -> CoreResult<ElementDelivery> {
		let (pid, wid) = window_identity(window)?;
		// Read before anything about the target ([`EntryFront::before`]): the
		// layout lookup below may run a helper process.
		let entry_front = EntryFront::now();
		let remote = process::remote_screen(pid);
		let gap = key_gap(remote);
		let chord = chord_keys(window, keys, remote, layout_strokes)?;
		match mode {
			DeliveryMode::Background => {
				if remote == Some(RemoteScreen::KeyEvents)
					&& chord.iter().any(|key| key.name.is_modifier())
				{
					return Err(keyboard_modifiers_refusal(window, "press this shortcut"));
				}
				let mut physical = remote_modifier_check(remote, window);
				let delivery = with_background_keyboard(
					&self.source,
					pid,
					wid,
					window,
					entry_front,
					|to, guard| {
						element_keys(pid, element, || {
							press_chord(&self.source, &chord, gap, |event| {
								let guard = || {
									guard()?;
									physical.as_mut().map_or(Ok(()), |check| check())
								};
								post_guarded(event, guard, |event| skylight::post_keyboard(to, event))
							})
						})
					},
				)?;
				if matches!(delivery, ElementDelivery::Delivered) {
					confirm_shortcut_answered(window, keys, || {
						// The shortcut is out: a cancel now must not report it
						// unsent.
						control::settle(SHORTCUT_REPLY_DELAY);
						Ok(ax::stopped_answering(pid, SHORTCUT_REPLY_TIMEOUT_SECONDS))
					})?;
				}
				Ok(delivery)
			},
			DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
				skylight::with_foreground(pid, wid, returns_focus(mode), |activated| {
					control::wait(first_key_settle(activated))?;
					element_keys(pid, element, || {
						if remote.is_some() {
							// As for typed text: a remote screen may read modifiers
							// from the keyboard state, which only
							// bare transitions move.
							press_bare_chord(&chord, gap, || skylight::require_front_window(pid, wid))
						} else {
							press_chord(&self.source, &chord, gap, |event| {
								post_takeover_key(pid, wid, event)
							})
						}
					})
				})
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
		match target {
			Target::Desktop | Target::Display(_) => {
				with_held_keys(&self.source, keys, KEY_GAP, post_global, || control::wait(duration))
			},
			Target::Window(id) => {
				let window = capture.window(id)?;
				let (pid, wid) = window_identity(&window)?;
				// Read before anything about the target ([`EntryFront::before`]).
				let entry_front = EntryFront::now();
				let remote = process::remote_screen(pid);
				let gap = key_gap(remote);
				let held = chord_keys(&window, keys, remote, layout_strokes)?;
				match mode {
					DeliveryMode::Background => {
						if remote == Some(RemoteScreen::KeyEvents)
							&& held.iter().any(|key| key.name.is_modifier())
						{
							return Err(keyboard_modifiers_refusal(&window, "hold these keys"));
						}
						let mut physical = remote_modifier_check(remote, &window);
						with_background_keyboard(
							&self.source,
							pid,
							wid,
							&window,
							entry_front,
							|to, guard| {
								hold_presses(
									&self.source,
									&held,
									gap,
									|event| {
										let guard = || {
											guard()?;
											physical.as_mut().map_or(Ok(()), |check| check())
										};
										post_guarded(event, guard, |event| skylight::post_keyboard(to, event))
									},
									|| control::wait(duration),
								)
							},
						)
					},
					DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
						skylight::with_foreground(pid, wid, returns_focus(mode), |activated| {
							control::wait(first_key_settle(activated))?;
							let body = || control::wait(duration);
							if remote.is_some() {
								hold_bare_keys(
									&held,
									gap,
									|| skylight::require_front_window(pid, wid),
									body,
								)
							} else {
								hold_presses(
									&self.source,
									&held,
									gap,
									|event| post_takeover_key(pid, wid, event),
									body,
								)
							}
						})
					},
				}
			},
		}
	}
}

/// The current keyboard layout's lookup from character to key; `None` when
/// the layout has no Unicode key layout data to look keys up in.
fn layout_strokes() -> CoreResult<Option<impl Fn(char) -> Option<Keystroke>>> {
	Ok(Keymap::current()?.map(|keymap| move |character| keymap.stroke(character)))
}

/// [`physical_modifier_check`] for `window` when `remote` forwards the
/// physical keyboard's modifiers with each key (Screen Sharing).
fn remote_modifier_check(
	remote: Option<RemoteScreen>,
	window: &DesktopWindow,
) -> Option<impl FnMut() -> CoreResult<()> + '_> {
	(remote == Some(RemoteScreen::KeyEvents))
		.then(|| physical_modifier_check(window, physical_flags))
}

/// Whether a takeover hands focus back even after user input (see
/// [`DeliveryMode::ForegroundReturnFocus`]).
const fn returns_focus(mode: DeliveryMode) -> bool {
	matches!(mode, DeliveryMode::ForegroundReturnFocus)
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
		 background input cannot hold them to {action}; nothing was sent",
		window.id, window.app,
	))
}

/// The physical keyboard's modifier flags, Caps Lock included.
fn physical_flags() -> u64 {
	// SAFETY: A read-only query of the HID system state (CGEventSource.h).
	unsafe { source_flags_state(CGEventSourceStateID::HIDSystemState as i32) }
}

/// Whether keyboard `flags` hold Shift, Control, Option or Command down or
/// Caps Lock on; Screen Sharing gives each key it forwards these.
const fn holds_modifier(flags: u64) -> bool {
	let mask = CGEventFlags::CGEventFlagAlphaShift.bits()
		| CGEventFlags::CGEventFlagShift.bits()
		| CGEventFlags::CGEventFlagControl.bits()
		| CGEventFlags::CGEventFlagAlternate.bits()
		| CGEventFlags::CGEventFlagCommand.bits();
	flags & mask != 0
}

/// The check before each background press into `window`, a Screen Sharing
/// window: Screen Sharing gives the key the modifiers the physical keyboard
/// holds as it forwards it, so a press stops while `flags` holds one or has
/// Caps Lock on. A user's Command would otherwise turn `q` into Cmd-Q on the
/// remote computer, and Caps Lock types capitals. Before any press it is
/// `BackgroundUnavailable`; once keys went out it is `InputFailed`, which
/// the host never reruns in takeover, since that would type them again.
fn physical_modifier_check<'a>(
	window: &'a DesktopWindow,
	flags: impl Fn() -> u64 + 'a,
) -> impl FnMut() -> CoreResult<()> + 'a {
	let mut sent = 0;
	move || {
		if holds_modifier(flags()) {
			let why = format!(
				"window {} ({}) gives the keys it forwards the physical keyboard's Shift, Control, \
				 Option, Command and Caps Lock, and one is held or Caps Lock is on",
				window.id, window.app,
			);
			let retry = "retry once no modifier key is held and Caps Lock is off";
			return Err(if sent == 0 {
				DesktopError::background_unavailable(format!("{why}; nothing was sent; {retry}"))
			} else {
				DesktopError::input_failed(format!(
					"{why}; {sent} key press(es) sent before this may already have landed, and no \
					 further input was sent; inspect the remote screen first, then {retry}"
				))
			});
		}
		sent += 1;
		Ok(())
	}
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
/// the process to post the keys to and a check to run before every press.
/// `entry_front` was read as the input began, before this reads the target's
/// windows and focus ([`EntryFront`]).
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
/// content ([`key_process`]). Before every press the focus that proved this
/// must still hold ([`keys_still_reach`], [`owner_still_focused`]).
fn with_background_keyboard<T>(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	entry_front: EntryFront,
	deliver: impl FnOnce(libc::pid_t, &dyn Fn() -> CoreResult<()>) -> CoreResult<T>,
) -> CoreResult<T> {
	let conflict = keyboard_conflict_now(pid, wid);
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
	skylight::with_background_watch(pid, |visit| {
		let prepared =
			make_key_in_background(source, pid, wid, window, entry_front, in_overlay, visit)?;
		let (to, focus) = await_key_destination(pid, wid, conflict)?;
		let owner =
			key_process(to, wid, &focus, || ax::window_content(pid, window), ax::focused_window_id)?;
		control::intervention::input_goes_to(owner.0);
		activate_owner(pid, owner, |(owner, window)| {
			activate_in_background(source, owner, window, skylight::sender_connection()?)
		})?;
		deliver(
			owner.0,
			&intervention_guard(|| {
				recheck_background(
					prepared,
					pid,
					wid,
					skylight::front_pid,
					|| visit.happened(),
					|| {
						keys_still_reach(
							pid,
							wid,
							|| keyboard_conflict_now(pid, wid),
							focus,
							|| ax::key_focus(pid),
							skylight::window_parent,
						)?;
						owner_still_focused(pid, wid, owner, ax::focused_window_id)
					},
				)
			}),
		)
	})
}

/// [`keyboard_conflict`] for window `wid` of `pid` as its accessibility
/// windows are now.
fn keyboard_conflict_now(pid: libc::pid_t, wid: u32) -> Option<KeyboardConflict> {
	ax::window_records(pid).map_or(Some(KeyboardConflict::Unmapped), |records| {
		keyboard_conflict(wid, &records, || {
			ax::focused_window_id(pid) == Some(wid)
				|| attached_under(wid, skylight::window_parent, |parent| {
					records.iter().any(|record| record.id == Some(parent))
				})
		})
	})
}

/// Whether text was delivered by AX insertion (`insert`) before any key: text
/// addressed to an element always tries it, so a native field takes it at its
/// own selection with no keys and no focus change; text for a window only in
/// the background, where takeover sends keys to whatever the window has
/// focused. Empty text is done without it: writing `""` to `AXSelectedText`
/// deletes the field's selection.
fn inserts_first(
	mode: DeliveryMode,
	addressed: bool,
	text: &str,
	insert: impl FnOnce() -> CoreResult<bool>,
) -> CoreResult<bool> {
	if text.is_empty() {
		return Ok(true);
	}
	if addressed || mode == DeliveryMode::Background {
		insert()
	} else {
		Ok(false)
	}
}

/// Before background keys go to `owner`, a process other than `pid` that
/// draws the target ([`key_process`]), such as `openAndSavePanelService`
/// for a system Save panel: `activate` tells it it is active, as
/// [`make_key_in_background`] told `pid`. A process that does not believe it
/// is active still takes typing into its focused field, but not the keys
/// that press a window's default or cancel button, so Return in a Save sheet
/// did nothing while the call reported success.
fn activate_owner(
	pid: libc::pid_t,
	owner: (libc::pid_t, u32),
	activate: impl FnOnce((libc::pid_t, u32)) -> CoreResult<()>,
) -> CoreResult<()> {
	if owner.0 == pid {
		return Ok(());
	}
	activate(owner)
}

fn unmapped_keyboard_refusal(wid: u32) -> DesktopError {
	DesktopError::background_unavailable(format!(
		"window {wid} is not among its application's accessibility windows, is not its focused \
		 window, and is not attached to one of its windows, so background keystrokes cannot be \
		 proven to reach it; nothing was sent",
	))
}

/// Runs `send` at once without an `element`. With one, focuses it and runs
/// `send` only once `pid` reports it as its focused element within
/// [`ELEMENT_FOCUS_TIMEOUT`], read every [`ELEMENT_FOCUS_POLL`]
/// ([`keys_after_focus`]); nothing is focused once the user has pressed a key
/// or clicked in the app since the call was admitted
/// ([`control::intervention::check_press`]).
fn element_keys(
	pid: libc::pid_t,
	element: Option<&AXUIElement>,
	send: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<ElementDelivery> {
	let Some(element) = element else {
		send()?;
		return Ok(ElementDelivery::Delivered);
	};
	control::intervention::check_press()?;
	let deadline = Instant::now() + ELEMENT_FOCUS_TIMEOUT;
	keys_after_focus(
		|| ax::set_focused(element),
		|| {
			deadline
				.checked_duration_since(Instant::now())
				.filter(|left| !left.is_zero())
		},
		|left| ax::holds_keyboard_focus(pid, element, left),
		|left| control::wait(ELEMENT_FOCUS_POLL.min(left)),
		|| ax::keyboard_focus(pid),
		send,
	)
}

/// Keys addressed to an element: `focus` gives it keyboard focus, and `send`
/// runs once `holds_focus` reports that it has it, read again after each
/// `wait` while `remaining` time is left; when it never does, nothing is sent
/// and `unfocused` reads where focus is instead.
///
/// A focus setter the element refuses does not end the call on its own: the
/// read decides, so the refusal names where focus is; only a destroyed
/// element stops at once. Each read is bounded by the time left, and a read
/// that returns after the deadline counts as unconfirmed. Focus is confirmed
/// once, before the first key: a field that moves focus to the next one as
/// each character lands, as split code inputs do, keeps receiving the rest,
/// while every background press is still checked against the window that
/// proved the keys reach it ([`keys_still_reach`]).
fn keys_after_focus(
	focus: impl FnOnce() -> CoreResult<()>,
	mut remaining: impl FnMut() -> Option<Duration>,
	mut holds_focus: impl FnMut(Duration) -> bool,
	mut wait: impl FnMut(Duration) -> CoreResult<()>,
	unfocused: impl FnOnce() -> KeyboardFocus,
	send: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<ElementDelivery> {
	if let Err(error) = focus()
		&& error.code == ErrorCode::StaleRef
	{
		return Err(error);
	}
	loop {
		let Some(left) = remaining() else {
			return Ok(ElementDelivery::Unfocused(unfocused()));
		};
		let held = holds_focus(left);
		let Some(left) = remaining() else {
			return Ok(ElementDelivery::Unfocused(unfocused()));
		};
		if held {
			send()?;
			return Ok(ElementDelivery::Delivered);
		}
		wait(left)?;
	}
}
/// Before a background press: keys posted to the process now still reach
/// `wid` as `proven`, the focus that admitted delivery, showed. The focus read
/// now must pass the same [`key_route`]; once the user or the application
/// makes another window key, including one opened since, the press would land
/// there. When the application reports no focused window, `wid` being its
/// only possible key window is the proof, so the windows are read again
/// (`conflict`): one it opened or unminimized since could be taking the keys.
/// When the focused element decided, because the application did not
/// report `wid` as its focused window (Finder's rename field, Reminders'
/// popover), the element must still be in the window it was in: once that
/// overlay closes or another takes focus, the press would land in the window
/// under it or in the new overlay.
fn keys_still_reach(
	pid: libc::pid_t,
	wid: u32,
	conflict: impl FnOnce() -> Option<KeyboardConflict>,
	proven: ax::KeyFocus,
	focus: impl FnOnce() -> ax::KeyFocus,
	parent_of: impl Fn(u32) -> Option<u32>,
) -> CoreResult<()> {
	let now = focus();
	let element_decided =
		proven.window != ax::FocusedWindow::Id(wid) && proven.element_window.is_some();
	let destination = now.destination(pid, wid, parent_of);
	// Only a destination the application does not report depends on the
	// window set.
	let conflict = if destination == ax::KeyDestination::Unreported {
		conflict()
	} else {
		None
	};
	let routed = matches!(key_route(pid, destination, conflict), KeyRoute::Deliver(_));
	if routed && (!element_decided || now.element_window == proven.element_window) {
		return Ok(());
	}
	Err(DesktopError::input_failed(format!(
		"keyboard focus left window {wid}, or the overlay it was in, during background input; keys \
		 sent before that may already have landed, and nothing more was sent; inspect the window \
		 before retrying",
	)))
}

/// `guard` behind the check that the user has not used the target's app since
/// the call began ([`control::intervention::check_press`]). The background
/// keyboard route hands this out as its per-press guard, so every way of
/// sending background keys that runs the guard before a key or modifier press
/// stops there, before pressing anything more.
fn intervention_guard(guard: impl Fn() -> CoreResult<()>) -> impl Fn() -> CoreResult<()> {
	move || {
		control::intervention::check_press()?;
		guard()
	}
}

/// Posts `event`, running `guard` before a key or modifier press; releases
/// always go out so nothing stays held.
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

/// The process to post background keys for window `wid` of `pid` to, and the
/// window of it they go into, once `focus` shows they would reach `wid`:
/// [`input_owner`] of the window's `content`. A focused element that maps to
/// `wid` itself shows the window's own process holds the focus, so the content
/// is read only when it does not.
fn key_process(
	pid: libc::pid_t,
	wid: u32,
	focus: &ax::KeyFocus,
	content: impl FnOnce() -> ax::WindowContent,
	focused_window_of: impl FnOnce(libc::pid_t) -> Option<u32>,
) -> CoreResult<(libc::pid_t, u32)> {
	if focus.window != ax::FocusedWindow::Id(wid) || focus.element_maps_to(wid) {
		return Ok((pid, wid));
	}
	input_owner(pid, wid, content(), focused_window_of)
}

/// Before a background press for window `wid` of `pid` that goes to another
/// process drawing it (`owner`, from [`key_process`]): that process must
/// still report focus in its window, as `focused_window_of` reads it now. It
/// routes the keys to its own key window, so once another of its windows
/// becomes key the press would land there.
fn owner_still_focused(
	pid: libc::pid_t,
	wid: u32,
	(owner, window): (libc::pid_t, u32),
	focused_window_of: impl FnOnce(libc::pid_t) -> Option<u32>,
) -> CoreResult<()> {
	// Keys the window's own process takes reach it through the focus checks.
	if owner == pid {
		return Ok(());
	}
	if focused_window_of(owner) == Some(window) {
		return Ok(());
	}
	Err(DesktopError::input_failed(format!(
		"process {owner}, which draws window {wid}, stopped reporting focus in its window {window} \
		 during background input; keys sent before that may already have landed, and nothing more \
		 was sent; inspect the window before retrying",
	)))
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
				 input would be dropped; nothing was sent",
			)))
		},
	}
}

/// Most windows deep a chain of sheets attached to sheets is followed.
const MAX_ATTACHED_DEPTH: usize = 4;

/// Whether `window` is attached, directly or through other attached windows,
/// to a window `is_ancestor` accepts, as `parent_of` reports `WindowServer`'s
/// parents.
pub(super) fn attached_under(
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

/// The window attached to `wid` (a sheet or popover, at any depth) that is
/// topmost at the global `point`, from the application's `windows` in front
/// to back order; `None` when `wid` itself, or anything not attached to it,
/// is topmost there.
fn attached_at(
	wid: u32,
	(x, y): (f64, f64),
	windows: &[DesktopWindow],
	parent_of: impl Fn(u32) -> Option<u32>,
) -> Option<&DesktopWindow> {
	let topmost = windows.iter().find(|window| {
		let (left, upper) = (f64::from(window.x), f64::from(window.y));
		(left..left + f64::from(window.width)).contains(&x)
			&& (upper..upper + f64::from(window.height)).contains(&y)
	})?;
	let id = topmost.id.parse::<u32>().ok()?;
	(id != wid && attached_under(id, parent_of, |parent| parent == wid)).then_some(topmost)
}

/// Where `event` presses, hovers or scrolls; a drag's first point.
fn pressed_point(event: &PointerEvent) -> Option<(f64, f64)> {
	match event {
		PointerEvent::Click { x, y, .. }
		| PointerEvent::Hold { x, y, .. }
		| PointerEvent::Move { x, y }
		| PointerEvent::Scroll { x, y, .. } => Some((*x, *y)),
		PointerEvent::Drag { path, .. } => path.first().copied(),
	}
}

/// Whether `wid` is a sheet or popover on the application's focused window,
/// or is that window itself while attached to another, as `focus` shows.
/// Making such a window key with a press outside its frame would close a
/// popover, or land in the window a sheet is attached to. While the
/// application reports no focused window, as Finder does while its rename
/// field, an overlay window of its own, has focus, the focused element's
/// window stands for it.
pub(super) fn takes_overlay_focus(
	wid: u32,
	focus: ax::KeyFocus,
	parent_of: impl Fn(u32) -> Option<u32>,
) -> bool {
	let focused = match focus.window {
		ax::FocusedWindow::Id(id) => Some(id),
		ax::FocusedWindow::Unreported => focus.element_window,
		ax::FocusedWindow::Unmapped | ax::FocusedWindow::Unreadable => None,
	};
	parent_of(wid).is_some()
		&& (focused == Some(wid) || attached_under(wid, parent_of, |parent| Some(parent) == focused))
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
			let focused = other.map_or_else(
				|| "a window it does not identify, or did not answer about,".to_owned(),
				|id| format!("window {id}"),
			);
			DesktopError::background_unavailable(format!(
				"window {wid} did not become its application's key window, and {focused} still is, so \
				 background keystrokes would reach that window; nothing was sent",
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
				 was sent",
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
/// or that holds a key with no key code, before anything is posted.
fn background_guard(
	window: &DesktopWindow,
	pid: libc::pid_t,
	event: &PointerEvent,
) -> CoreResult<()> {
	refuse_pointer(
		window,
		event,
		|| process::remote_screen(pid) == Some(RemoteScreen::KeyEvents),
		|| process::reads_hardware_pointer(pid),
	)
}

/// [`background_guard`]'s verdict. The target is probed by
/// `takes_physical_modifiers` (Screen Sharing) only for an event that holds
/// keys, and its Tk by `reads_hardware_pointer` only for an event that presses
/// a button.
fn refuse_pointer(
	window: &DesktopWindow,
	event: &PointerEvent,
	takes_physical_modifiers: impl FnOnce() -> bool,
	reads_hardware_pointer: impl FnOnce() -> bool,
) -> CoreResult<()> {
	let refuse = |reason: &str| {
		Err(DesktopError::background_unavailable(format!(
			"window {} ({}) {reason}; nothing was sent",
			window.id, window.app,
		)))
	};
	// Preparing a held press can make the target's window key, so a key that
	// cannot be pressed refuses first.
	if let PointerEvent::Drag { keys, .. } | PointerEvent::Hold { keys, .. } = event {
		for &key in keys {
			key_code(key)?;
		}
	}
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
	if holds_keys(event) && takes_physical_modifiers() {
		return Err(keyboard_modifiers_refusal(window, "hold keys around pointer input"));
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
	// Each later click of a multi-click waits its gap before the menu the first
	// one opened can be closed.
	if let PointerEvent::Click { count, .. } = event
		&& *count > 1
		&& may_open_context_menu(event)
	{
		return refuse(
			format!(
				"could open a context menu on the first of these {count} secondary-button clicks, \
				 which would take the keyboard from the user's app while the later clicks are sent"
			)
			.as_str(),
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
const FIELD_TARGET_PID: u32 = route::TARGET_PID_FIELD;
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
/// How long an element given `AXFocused` may take to report itself as its
/// application's focused element before keys addressed to it are refused.
const ELEMENT_FOCUS_TIMEOUT: Duration = Duration::from_millis(250);
const ELEMENT_FOCUS_POLL: Duration = Duration::from_millis(10);
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

/// The front process as background input began, read before anything about
/// its target.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct EntryFront(Option<libc::pid_t>);

impl EntryFront {
	pub(super) fn now() -> Self {
		Self(skylight::front_pid())
	}

	/// Whether `pid` was behind another application as the input began.
	pub(super) fn behind(self, pid: libc::pid_t) -> bool {
		self.0 != Some(pid)
	}

	/// Reads the front process with `front`, then runs `probe`, the target's
	/// reads and checks that come before its focus guard. An accessibility
	/// probe blocks while the application is busy, and the user may pick the
	/// target meanwhile; read after it, the front process would show the
	/// target as the user's own front app, and the input would go into the
	/// window they just picked instead of refusing ([`front_target`]).
	pub(super) fn before<T>(
		front: impl FnOnce() -> Option<libc::pid_t>,
		probe: impl FnOnce() -> CoreResult<T>,
	) -> CoreResult<(Self, T)> {
		let entry = Self(front());
		probe().map(|value| (entry, value))
	}

	/// Whether `pid`, which was not the front process as the input began, is
	/// now (`front`): the user may have just picked one of its windows.
	fn came_forward(self, front: Option<libc::pid_t>, pid: libc::pid_t) -> bool {
		front == Some(pid) && self.0 != Some(pid)
	}

	/// Refuses once [`Self::came_forward`] holds for window `wid`'s `pid`.
	pub(super) fn require_behind(
		self,
		front: Option<libc::pid_t>,
		pid: libc::pid_t,
		wid: u32,
	) -> CoreResult<()> {
		if self.came_forward(front, pid) {
			return Err(came_forward_refusal(wid));
		}
		Ok(())
	}
}

/// The user has come to the target: it is never rerun in takeover, which
/// would take over the app they are using.
fn came_forward_refusal(wid: u32) -> DesktopError {
	DesktopError::user_intervened(format!(
		"window {wid}'s application came to the front while background input was prepared, so \
		 nothing was sent",
	))
}

/// The refusal for a target whose front state ([`front_target`]) forbids
/// making its window key behind the user's app; only an unknown front app
/// may be retried in takeover.
fn front_refusal(front: FrontTarget, wid: u32) -> DesktopError {
	match front {
		FrontTarget::UserSibling => DesktopError::user_intervened(format!(
			"window {wid} belongs to the frontmost application but is not its key window; making it \
			 key would move the user's typing there, so nothing was sent",
		)),
		FrontTarget::Unknown => DesktopError::background_unavailable(format!(
			"window {wid}: the frontmost application could not be identified, so making the window \
			 key could move the user's typing there; nothing was sent",
		)),
		FrontTarget::CameForward | FrontTarget::Background | FrontTarget::Key => {
			came_forward_refusal(wid)
		},
	}
}

fn front_target(
	entry_front: EntryFront,
	front: Option<libc::pid_t>,
	pid: libc::pid_t,
	wid: u32,
	focused: impl FnOnce() -> Option<u32>,
) -> FrontTarget {
	match front {
		None => FrontTarget::Unknown,
		Some(front) if front != pid => FrontTarget::Background,
		Some(_) if entry_front.came_forward(front, pid) => FrontTarget::CameForward,
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
/// `entry_front` is the front process read as the input began
/// ([`EntryFront`]); a target that has come forward since then refuses,
/// because the user may have just picked the window that would receive the
/// input.
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
/// in the app they type into, so before the press the front process is read
/// again and `visit`, the guard's record of the user coming to the target, is
/// checked ([`still_behind_user`]); callers check again through
/// [`recheck_background`] before each later step.
pub(super) fn make_key_in_background(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	entry_front: EntryFront,
	focus_in_overlay: bool,
	visit: skylight::TargetVisit<'_>,
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
		refused => return Err(front_refusal(refused, wid)),
	}
	let context = skylight::sender_connection()?;
	activate_in_background(source, pid, wid, context)?;
	still_behind_user(pid, wid, visit)?;
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
		skylight::post_activation(pid, &event)
	};
	press(CGEventType::LeftMouseDown, 1)?;
	let release = control::cleanup(|| press(CGEventType::LeftMouseUp, 2));
	skylight::after_cleanup(Ok(true), release)
}

/// Tells background process `pid` it is active with window `wid` key, as
/// `AppKit` does for a real activation, through the connection `context`,
/// and gives it until [`ACTIVE_STATE_TIMEOUT`] to report it
/// ([`activate_then_await`]). `WindowServer`'s front process stays the user's.
fn activate_in_background(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	context: i64,
) -> CoreResult<()> {
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
		skylight::post_activation(pid, &activated)
	};
	activate_then_await(
		ax::reports_active(pid),
		ACTIVE_STATE_TIMEOUT,
		activate,
		|| ax::reports_active(pid),
		|| control::wait(KEY_WINDOW_POLL),
	)
}

/// Refuses once the target's application is frontmost (or the front process
/// is unknown), or the user came to it (`visit`), after
/// [`make_key_in_background`] judged it a background app.
fn still_behind_user(
	pid: libc::pid_t,
	wid: u32,
	visit: skylight::TargetVisit<'_>,
) -> CoreResult<()> {
	recheck_background(true, pid, wid, skylight::front_pid, || visit.happened(), || Ok(()))
}

/// The check before each later press or command of background input for
/// window `wid` of `pid`: `target_holds` must pass, and then, when
/// [`make_key_in_background`] found the application behind the user's
/// (`prepared`), the user must not have come to it since: `visited` reads the
/// focus guard's record of that, which stays set once the user has left the
/// target again, and `front` reads the front process now, which the guard
/// polls only every few milliseconds. The guard itself only stands down when
/// the user brings the target forward, so this is what keeps the input from
/// following them into the window they picked. Both are read last, as close
/// to the input as they can be.
pub(super) fn recheck_background(
	prepared: bool,
	pid: libc::pid_t,
	wid: u32,
	front: impl FnOnce() -> Option<libc::pid_t>,
	visited: impl FnOnce() -> bool,
	target_holds: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	target_holds()?;
	if !prepared {
		return Ok(());
	}
	let front = front();
	if visited() || front == Some(pid) {
		return Err(DesktopError::user_intervened(format!(
			"window {wid}'s application came to the front during background input; no further input \
			 was sent; inspect the window",
		)));
	}
	if !left_background(front, pid) {
		return Ok(());
	}
	Err(DesktopError::background_unavailable(format!(
		"the front application could not be identified during background input, so window {wid}'s \
		 application may be in front; nothing was sent",
	)))
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
pub(super) const POINTER_SETTLE: Duration = Duration::from_millis(40);
/// Press-to-release gap: an `NSButton` press enters a tracking loop that can
/// miss a release arriving before its first poll.
const PRESS_GAP: Duration = Duration::from_millis(28);
const MULTI_CLICK_GAP: Duration = Duration::from_millis(80);
const KEY_GAP: Duration = Duration::from_millis(8);
/// Wait after a background shortcut before asking its application for a
/// reply. A save that blocks `TextEdit` already does so at this point.
const SHORTCUT_REPLY_DELAY: Duration = Duration::from_millis(100);
/// How long that application has to reply before it counts as not answering.
const SHORTCUT_REPLY_TIMEOUT_SECONDS: f32 = 1.5;
/// Pacing between the dragged events of a background drag, one 60 Hz frame.
const DRAG_STEP_GAP: Duration = Duration::from_millis(16);
/// Wait at the end point before a background drag's release, so the target
/// handles the last move as a move rather than coalescing it into the release.
const DRAG_RELEASE_GAP: Duration = Duration::from_millis(50);
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
	#[link_name = "CGEventSetTimestamp"]
	fn set_event_timestamp(event: CGEventRef, timestamp: u64);
	#[link_name = "CGEventSourceFlagsState"]
	fn source_flags_state(state: i32) -> u64;
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

/// Background pointer input for window `wid` of `pid`. The events go to the
/// process and window that take the window's input, which `owner` reads
/// ([`input_owner`], through [`pointer_owner`]) and which also shows any menu
/// they open; making the window key still goes to its own application.
/// `in_overlay` says `wid` is a sheet or popover on the application's focused
/// window ([`takes_overlay_focus`]), so a left click sends only the
/// activation, without the press outside its frame that would close a popover
/// or reach the window the sheet is attached to. Each press of a left click
/// that made the window key first passes [`recheck_background`], with `visit`
/// from the focus guard.
fn background_pointer(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
	menu: Option<&[String]>,
	entry_front: EntryFront,
	owner: impl FnOnce() -> CoreResult<(libc::pid_t, u32)>,
	in_overlay: bool,
	visit: skylight::TargetVisit<'_>,
) -> CoreResult<()> {
	let prepare =
		|| make_key_in_background(source, pid, wid, window, entry_front, in_overlay, visit);
	let (prepared, (to, to_wid)) = pointer_owner(&event, prepare, owner)?;
	let menu_pid = to;
	let background = skylight::front_pid() != Some(pid);
	let timeout = menu_watch(window, &event, background, menu.is_some(), || {
		presses_menu_control(&event, pid, menu_pid)
	})?;
	refuse_drag_source(window, &event, |x, y| ax::open_menu::role_at(to, x, y))?;
	let before = match timeout {
		Some(_) => Some(capture::menu_windows(menu_pid).ok_or_else(|| {
			DesktopError::background_unavailable(format!(
				"cannot list the open menus of window {} ({}), so a menu this {} opens could not be \
				 closed; nothing was sent",
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
		|| {
			background_gesture(
				source,
				pid,
				wid,
				window,
				event,
				entry_front,
				(to, to_wid),
				prepared,
				in_overlay,
				visit,
				&skylight_post,
			)
		},
		|before, path| {
			// The user may have brought the target forward while its menu
			// appeared.
			let holds = || {
				recheck_background(
					entry_front.behind(pid),
					pid,
					wid,
					skylight::front_pid,
					|| visit.happened(),
					|| Ok(()),
				)
			};
			ax::open_menu::settle(menu_pid, pid, before, path, timeout.unwrap_or_default(), holds)
		},
	)
}

/// How long background `event` waits for a menu it may open, or `None` when
/// it opens none: in an application behind the user's (`background`), a
/// secondary press may open a context menu, and a left press on a menu button
/// or popup button (`on_menu_control`) opens its menu; any click with a `menu`
/// path to choose waits for its menu wherever it opens. A frontmost
/// application's menu stays open for the next call, as the user's would. A
/// mouse hold, drag or multi-click on such a control refuses before its gesture
/// is posted: the menu opens on the first press and keeps the keyboard from the
/// user's app until the hold, the stroke or the later clicks end, and only then
/// could it be closed.
fn menu_watch(
	window: &DesktopWindow,
	event: &PointerEvent,
	background: bool,
	menu: bool,
	on_menu_control: impl FnOnce() -> bool,
) -> CoreResult<Option<Duration>> {
	if may_open_context_menu(event) {
		return Ok((background || menu).then_some(ax::open_menu::CONTEXT_MENU_TIMEOUT));
	}
	let on_control = on_menu_control();
	let gesture = match event {
		PointerEvent::Click { count, .. } if *count > 1 => {
			Some((format!("these {count} clicks"), "end", "were"))
		},
		PointerEvent::Hold { .. } => Some(("this mouse hold".to_string(), "ends", "was")),
		PointerEvent::Drag { .. } => Some(("this drag".to_string(), "ends", "was")),
		_ => None,
	};
	if on_control && let Some((gesture, ends, was)) = gesture {
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) has a menu button or popup button where {gesture} presses, and its menu \
			 would open on the first press and keep the keyboard from the user's app until {gesture} \
			 {ends}, so {gesture} {was} not sent; to choose an item in the background, click the \
			 control once with the item's path as the menu option, e.g. menu: [\"<item>\"]",
			window.id, window.app,
		)));
	}
	Ok((menu || on_control).then_some(ax::open_menu::CONTROL_MENU_TIMEOUT))
}

/// Roles of controls that track a left-button drag themselves and never begin
/// a drag-and-drop session.
const DRAG_TRACKING_ROLES: [&str; 5] =
	["AXSlider", "AXScrollBar", "AXSplitter", "AXValueIndicator", "AXIncrementor"];

/// Refuses a background left-button drag or mouse hold on `window` before
/// anything is posted, unless the element at its start point (`role_at`)
/// tracks the drag itself ([`DRAG_TRACKING_ROLES`]). A press elsewhere can
/// pick up an item (a file, a row, an image, selected text) and begin a
/// drag-and-drop session, which macOS completes from the user's real pointer
/// as well as from the routed events: on macOS 26.5 a Finder file followed a
/// user's moving pointer into their own Finder window and onto the Desktop,
/// and going back to the start once the session began did not keep it out
/// (1 in 2 on an 11-point path). Which elements begin such a session is up to
/// each application, so only the known trackers are let through.
fn refuse_drag_source(
	window: &DesktopWindow,
	event: &PointerEvent,
	role_at: impl FnOnce(f64, f64) -> Option<String>,
) -> CoreResult<()> {
	let (x, y) = match event {
		PointerEvent::Hold { x, y, button: MouseButton::Left, .. } => (*x, *y),
		PointerEvent::Drag { path, button: MouseButton::Left, .. } => match path.first() {
			Some(&start) => start,
			None => return Ok(()),
		},
		_ => return Ok(()),
	};
	let role = role_at(x, y);
	if role
		.as_deref()
		.is_some_and(|role| DRAG_TRACKING_ROLES.contains(&role))
	{
		return Ok(());
	}
	let element = role.map_or_else(
		|| "an element accessibility does not identify".to_string(),
		|role| format!("an {role}"),
	);
	Err(DesktopError::background_unavailable(format!(
		"the {} on window {} ({}) starts on {element}, where a press can pick up an item for drag \
		 and drop, which macOS completes from the user's real pointer and could drop into the \
		 user's own window; background drags and holds run only on sliders, scroll bars, splitters \
		 and steppers; nothing was sent",
		pointer_kind(event),
		window.id,
		window.app,
	)))
}

/// Whether `event` presses the left button on a menu button or popup button
/// drawn by `owner` (the window's application, or the process drawing its
/// content) while another application than `pid` is frontmost; the control
/// opens its menu on the press. Other gestures pay no accessibility hit-test.
fn presses_menu_control(event: &PointerEvent, pid: libc::pid_t, owner: libc::pid_t) -> bool {
	let Some((x, y)) = left_press(event) else {
		return false;
	};
	skylight::front_pid() != Some(pid) && ax::open_menu::opens_menu_at(owner, x, y)
}

/// Where `event` presses the left button: a click's point, or the point a
/// mouse hold or drag starts at.
fn left_press(event: &PointerEvent) -> Option<(f64, f64)> {
	match event {
		PointerEvent::Click { x, y, button: MouseButton::Left, .. }
		| PointerEvent::Hold { x, y, button: MouseButton::Left, .. } => Some((*x, *y)),
		PointerEvent::Drag { path, button: MouseButton::Left, .. } => path.first().copied(),
		_ => None,
	}
}

/// The window and window number that background `event` on `window` (number
/// `wid` of `pid`) reaches. A sheet or popover is a window of its own, but its
/// elements report the window it is attached to as theirs, so input for a
/// point inside it goes to the attached window on top there.
fn attached_window(
	capture: &MacCapture,
	window: DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	event: &PointerEvent,
) -> CoreResult<(DesktopWindow, u32)> {
	let Some(point) = pressed_point(event) else {
		return Ok((window, wid));
	};
	let windows = capture.windows_of(pid)?;
	match attached_at(wid, point, &windows, skylight::window_parent) {
		Some(overlay) => Ok((overlay.clone(), window_identity(overlay)?.1)),
		None => Ok((window, wid)),
	}
}

/// Refuses background `event` on window `target` when it presses the left
/// button on a menu button or popup button ([`presses_menu_control`]): a click
/// lands there, a mouse hold or a drag starts there, and the control would
/// open its menu, which takes the user's keyboard while it is open. A window
/// whose input goes nowhere is left for the input itself to refuse.
pub(super) fn refuse_menu_press(
	target: &Target,
	event: &PointerEvent,
	capture: &MacCapture,
) -> CoreResult<()> {
	let Target::Window(id) = target else {
		return Ok(());
	};
	if left_press(event).is_none() {
		return Ok(());
	}
	let window = capture.window(id)?;
	let (pid, wid) = window_identity(&window)?;
	let (window, wid) = attached_window(capture, window, pid, wid, event)?;
	menu_press_verdict(skylight::front_pid, pid, wid, || {
		let (owner, _) =
			input_owner(pid, wid, ax::window_content(pid, &window), ax::focused_window_id).ok()?;
		if !presses_menu_control(event, pid, owner) {
			return None;
		}
		let verb = if matches!(event, PointerEvent::Click { .. }) {
			"lands"
		} else {
			"starts"
		};
		Some(DesktopError::background_unavailable(format!(
			"the {} on window {} ({}), which {verb} on a menu button or popup button, would open its \
			 menu; nothing was sent",
			pointer_kind(event),
			window.id,
			window.app,
		)))
	})
}

/// [`refuse_menu_press`]'s verdict: `probe`'s refusal, if any. Its
/// accessibility probes block while the application is busy, and the user may
/// pick the target meanwhile, which the input that follows would not see once
/// the target is in front; so the front process is read before them
/// ([`EntryFront::before`]) and again after.
fn menu_press_verdict(
	front: impl Fn() -> Option<libc::pid_t>,
	pid: libc::pid_t,
	wid: u32,
	probe: impl FnOnce() -> Option<DesktopError>,
) -> CoreResult<()> {
	let (entry, refusal) = EntryFront::before(&front, || Ok(probe()))?;
	if let Some(refusal) = refusal {
		return Err(refusal);
	}
	entry.require_behind(front(), pid, wid)
}

/// Posts background pointer `event` for window `wid` of `pid` to `to_wid` of
/// `to`, the process and window that take its input. Held presses ready
/// `wid` in its own application first ([`prepare_press`]), without the press
/// outside its frame when it is a sheet or popover holding the focus
/// (`in_overlay`); their events go out through `post`, which is
/// [`skylight_post`] outside tests, and each key they hold first passes the
/// checks typing makes before every key ([`guarded_keys`]).
fn background_gesture(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
	entry_front: EntryFront,
	(to, to_wid): (libc::pid_t, u32),
	prepared: bool,
	in_overlay: bool,
	visit: skylight::TargetVisit<'_>,
	post: Post<'_>,
) -> CoreResult<()> {
	// Every pointer kind goes through the same check right before it posts. A
	// left click has posted its hover primer by then; the others nothing.
	let sent = matches!(event, PointerEvent::Click { button: MouseButton::Left, .. });
	let before_post = || {
		pointer_recheck(
			(prepared, sent),
			entry_front,
			(pid, wid, &window.app),
			skylight::front_pid,
			|| visit.happened(),
		)
	};
	match event {
		PointerEvent::Click { x, y, button: MouseButton::Left, count, modifiers } => {
			background_left_click(
				source,
				to,
				to_wid,
				window,
				(x, y, count),
				modifier_flags(modifiers),
				before_post,
				skylight::post_routed,
			)
		},
		PointerEvent::Click { x, y, button, count, modifiers } => {
			before_post()?;
			background_button_click(
				source,
				to,
				to_wid,
				window,
				x,
				y,
				button,
				count,
				modifier_flags(modifiers),
			)
		},
		PointerEvent::Move { x, y } => {
			before_post()?;
			post_hover(source, to, to_wid, window, x, y, click_group_id())
		},
		PointerEvent::Scroll { x, y, dx, dy } => {
			before_post()?;
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
			let proof =
				prepare_press(source, pid, wid, window, button, &keys, entry_front, in_overlay, visit)?;
			before_post()?;
			let key_guard = || held_key_check(pid, wid, proof, &before_post);
			let post = guarded_keys(post, &key_guard);
			background_drag(source, to, to_wid, window, &path, button, &keys, &post)
		},
		PointerEvent::Hold { x, y, button, keys, duration } => {
			let at = point(x, y)?;
			let proof =
				prepare_press(source, pid, wid, window, button, &keys, entry_front, in_overlay, visit)?;
			before_post()?;
			let key_guard = || held_key_check(pid, wid, proof, &before_post);
			let post = guarded_keys(post, &key_guard);
			background_hold(source, to, to_wid, window, at, button, &keys, duration, &post)
		},
	}
}

/// The check right before background pointer input for window `wid` of `pid`
/// (application `app`) posts. The user's own key or click in the target's app
/// since the call was admitted refuses it
/// ([`control::intervention::check_press`]). The probes that chose where it
/// goes can block, and the user may bring the target forward meanwhile, or
/// come to it and leave again (`visited`): the input then refuses, whether or
/// not it first made the window key (`prepared`), as it does when the front
/// process cannot be read. A target that was already the user's own front app
/// as the input began (`entry_front`) still takes it. `sent` says whether this
/// input already posted events, which the refusal then reports.
fn pointer_recheck(
	(prepared, sent): (bool, bool),
	entry_front: EntryFront,
	(pid, wid, app): (libc::pid_t, u32, &str),
	front: impl FnOnce() -> Option<libc::pid_t>,
	visited: impl FnOnce() -> bool,
) -> CoreResult<()> {
	control::intervention::check_press()?;
	let now = front();
	let sent = if sent {
		"input sent before this may already have landed, and no further input was sent"
	} else {
		"nothing was sent"
	};
	if now.is_none() {
		return Err(DesktopError::background_unavailable(format!(
			"window {wid} of {app}: the front application could not be identified during background \
			 input, so the input could reach a window the user just picked; {sent}",
		)));
	}
	if entry_front.came_forward(now, pid) || visited() || (prepared && now == Some(pid)) {
		// The user is at the target: never rerun in takeover, which would
		// take over the app they are using.
		return Err(DesktopError::user_intervened(format!(
			"window {wid} of {app}: it came to the front during background input, so the input could \
			 reach a window the user just picked; {sent}; inspect the window",
		)));
	}
	Ok(())
}

/// How a held gesture's events are posted: a window-routed pointer event, or
/// a key held around it, each to the process given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Posted {
	Pointer,
	Key,
}

type Post<'a> = &'a dyn Fn(Posted, libc::pid_t, &CGEvent) -> CoreResult<()>;

/// `post` with `guard` run before each key press it posts ([`post_guarded`]);
/// pointer events and key releases go out as they are. A guard that refuses
/// once an earlier held key went out reports partial input (`InputFailed`),
/// never `BackgroundUnavailable`, which says nothing was sent.
fn guarded_keys<'a>(
	post: Post<'a>,
	guard: &'a dyn Fn() -> CoreResult<()>,
) -> impl Fn(Posted, libc::pid_t, &CGEvent) -> CoreResult<()> + 'a {
	let pressed = std::cell::Cell::new(false);
	move |posted, to, event| match posted {
		Posted::Pointer => post(posted, to, event),
		Posted::Key => {
			let checked = || {
				guard().map_err(|error| match error.code {
					ErrorCode::BackgroundUnavailable if pressed.get() => {
						DesktopError::input_failed(format!(
							"{}; keys held before this may already have landed and were released, and \
							 nothing more was sent; inspect the window before retrying",
							error.message
						))
					},
					_ => error,
				})
			};
			post_guarded(event, checked, |event| post(posted, to, event))?;
			pressed.set(pressed.get() || is_key_press(event));
			Ok(())
		},
	}
}

/// The check before each key a background drag or hold presses: the target
/// still passes `recheck`, and when the gesture holds keys, the focus that
/// proved they reach window `wid` of `pid` (`proof`, from [`prepare_press`])
/// still holds ([`keys_still_reach`]).
fn held_key_check(
	pid: libc::pid_t,
	wid: u32,
	proof: Option<ax::KeyFocus>,
	recheck: &dyn Fn() -> CoreResult<()>,
) -> CoreResult<()> {
	recheck()?;
	let Some(proven) = proof else {
		return Ok(());
	};
	keys_still_reach(
		pid,
		wid,
		|| keyboard_conflict_now(pid, wid),
		proven,
		|| ax::key_focus(pid),
		skylight::window_parent,
	)
}

/// [`Post`] through `SkyLight`: `post_dual` for pointer events,
/// `post_keyboard` for keys.
fn skylight_post(posted: Posted, pid: libc::pid_t, event: &CGEvent) -> CoreResult<()> {
	match posted {
		Posted::Pointer => skylight::post_dual(pid, event),
		Posted::Key => skylight::post_keyboard(pid, event),
	}
}

/// Where background pointer `event` goes: `owner`'s answer, with whether
/// `prepare` made its window key behind the user's app. A left click first
/// makes its window key through `prepare`, and a system Open or Save panel's
/// drawing process reports focus in its window only once the panel is key, so
/// the owner is read after that; other events never make the window key.
fn pointer_owner(
	event: &PointerEvent,
	prepare: impl FnOnce() -> CoreResult<bool>,
	owner: impl FnOnce() -> CoreResult<(libc::pid_t, u32)>,
) -> CoreResult<(bool, (libc::pid_t, u32))> {
	let prepared = if matches!(event, PointerEvent::Click { button: MouseButton::Left, .. }) {
		prepare()?
	} else {
		false
	};
	Ok((prepared, owner()?))
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

/// Readies a background window for a held press and the keys held around it;
/// with keys, returns the focus that proved they reach `wid`.
///
/// A view that refuses first mouse, as Chromium and Electron pages do, drops a
/// left press into a window its application does not yet consider key, which
/// a click survives but a press that stays down does not. A sheet or popover
/// holding the focus (`in_overlay`) gets only the activation, as a left click
/// into it does: the press that makes a window key would close a popover or
/// reach the window a sheet is attached to. Held keys go to the process,
/// which hands them to its key window, so they need the same proof that `wid`
/// is that window as background typing does ([`await_key_destination`]),
/// which refuses keys a focused sheet attached to `wid` would take.
fn prepare_press(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	button: MouseButton,
	keys: &[KeyName],
	entry_front: EntryFront,
	in_overlay: bool,
	visit: skylight::TargetVisit<'_>,
) -> CoreResult<Option<ax::KeyFocus>> {
	ready_press(
		wid,
		button,
		!keys.is_empty(),
		in_overlay,
		|| keyboard_conflict_now(pid, wid),
		|in_overlay| make_key_in_background(source, pid, wid, window, entry_front, in_overlay, visit),
		|| await_key_window(pid, wid).map(drop),
		|conflict| await_key_destination(pid, wid, conflict).map(|(_, focus)| focus),
		|| still_behind_user(pid, wid, visit),
	)
}

/// [`prepare_press`] with its probes and steps as closures. `make_key` gets
/// `in_overlay`. Without keys, a left press waits for the window to become
/// key (`await_key`), which a sheet or popover holding the focus never does;
/// with keys, `prove_keys` must show they reach the window, given the
/// `conflict` read before. When `make_key` ran the activation step,
/// `still_behind` re-checks afterwards that the user has not brought the
/// target forward.
fn ready_press<P>(
	wid: u32,
	button: MouseButton,
	holds_keys: bool,
	in_overlay: bool,
	conflict: impl FnOnce() -> Option<KeyboardConflict>,
	make_key: impl FnOnce(bool) -> CoreResult<bool>,
	await_key: impl FnOnce() -> CoreResult<()>,
	prove_keys: impl FnOnce(Option<KeyboardConflict>) -> CoreResult<P>,
	still_behind: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<Option<P>> {
	let conflict = if holds_keys { conflict() } else { None };
	if conflict == Some(KeyboardConflict::Unmapped) {
		return Err(unmapped_keyboard_refusal(wid));
	}
	if !holds_keys && !matches!(button, MouseButton::Left) {
		return Ok(None);
	}
	let prepared = make_key(in_overlay)?;
	let proof = if holds_keys {
		Some(prove_keys(conflict)?)
	} else {
		if !in_overlay {
			await_key()?;
		}
		None
	};
	if prepared {
		still_behind()?;
	}
	Ok(proof)
}

/// One event of a background drag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Stroke {
	Down,
	Dragged,
	Up,
}

/// Posts a drag along `path` (at least two points): the press at its start,
/// one dragged event per later point, and the release; returns whether the
/// drag picked up an item. The release is posted whatever happens before it,
/// at the last point attempted, since a failed post may still have been
/// delivered. Before each later point, `picked_up` says whether the source
/// has begun a drag-and-drop session; the stroke then goes no further, but
/// back to its start, and is released there ([`drag_session_outcome`]).
fn stroke_path(
	path: &[CGPoint],
	mut picked_up: impl FnMut() -> bool,
	mut post: impl FnMut(Stroke, CGPoint) -> CoreResult<()>,
) -> CoreResult<bool> {
	let mut last = path[0];
	let mut session = false;
	let result = (|| {
		post(Stroke::Down, last)?;
		for &at in &path[1..] {
			control::wait(DRAG_STEP_GAP)?;
			if picked_up() {
				session = true;
				return Ok(());
			}
			last = at;
			post(Stroke::Dragged, at)?;
		}
		// Every point is out and the release always goes.
		control::settle(DRAG_RELEASE_GAP);
		Ok(())
	})();
	let release = control::cleanup(|| {
		if session && (last.x, last.y) != (path[0].x, path[0].y) {
			last = path[0];
			post(Stroke::Dragged, last)?;
		}
		post(Stroke::Up, last)
	});
	skylight::after_cleanup(result, release).map(|()| session)
}

/// A background drag along `path` (global points, at least two) for window
/// `wid` of `pid`: a hover at the start, then [`stroke_path`], all routed to
/// `wid` so the user's pointer stays where it is. `keys` are held around the
/// gesture as key transitions to `pid`, and their modifiers ride on every
/// pointer event; everything goes out through `post`. A drag that starts a
/// drag-and-drop session throws with its outcome unconfirmed, as
/// [`drag_session_outcome`] describes.
fn background_drag(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	path: &[CGPoint],
	button: MouseButton,
	keys: &[KeyName],
	post: Post<'_>,
) -> CoreResult<()> {
	let (cg_button, down, up, dragged, number) = button_types(button);
	let flags = held_flags(keys);
	let group = click_group_id();
	let sessions = drag_pasteboard_count();
	let mut picked_up = false;
	let pointer = |event: &CGEvent, at: CGPoint, click_state, button_number| {
		route_window_pointer(pid, wid, window, event, at.x, at.y, click_state, button_number, group)?;
		post(Posted::Pointer, pid, event)
	};
	with_held_keys(
		source,
		keys,
		KEY_GAP,
		|event| post(Posted::Key, pid, event),
		|| {
			let start = path[0];
			pointer(
				&mouse_event(source, CGEventType::MouseMoved, start, CGMouseButton::Left)?,
				start,
				0,
				0,
			)?;
			control::wait(Duration::from_millis(12))?;
			stroke_path(
				path,
				|| drag_pasteboard_count() != sessions,
				|stroke, at| {
					let event_type = match stroke {
						Stroke::Down => down,
						Stroke::Dragged => dragged,
						Stroke::Up => up,
					};
					let event = mouse_event(source, event_type, at, cg_button)?;
					event.set_flags(flags);
					pointer(&event, at, 1, number)
				},
			)
			.map(|session| picked_up = session)
		},
	)?;
	if picked_up {
		return Err(picked_up_refusal(window));
	}
	// An accessibility round trip, which the target answers from its run loop
	// once it has handled the events posted before it.
	drag_session_outcome(window, sessions, drag_pasteboard_count, || {
		ax::reports_active(pid);
	})
}

/// [`background_drag`]'s error for a drag whose source began a drag-and-drop
/// session during the stroke: macOS completes such a session from the user's
/// real pointer as well as from the routed events, and on macOS 26.5 a Finder
/// file followed a user's moving pointer into their own Finder window or onto
/// the Desktop (3/3 each). The stroke stops as soon as the session begins and
/// is released where it started, over the item's own place, so the item
/// drops back on its source rather than wherever the user's pointer is.
fn picked_up_refusal(window: &DesktopWindow) -> DesktopError {
	DesktopError::input_failed(format!(
		"the drag reached window {} ({}) and picked up an item for drag and drop, which macOS \
		 completes from the user's real pointer, so it was taken back to where it started and \
		 released there instead of being carried along the path. Read the target before retrying: \
		 the press and the start of the drag were delivered. Move the item with the app's menu \
		 command or ax actions",
		window.id, window.app,
	))
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
/// did land. Escape posted to the source did not cancel the drop. A session
/// noticed during the stroke ends it early ([`picked_up_refusal`]); this
/// covers one the source begins only as it handles the last events. A drag
/// inside a
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
		 the target before retrying, and prefer the app's menu command or ax actions",
		window.id, window.app,
	)))
}

/// A background press held for `duration` at `at` for window `wid` of `pid`,
/// routed to `wid`; the release is posted even when the hold is cancelled.
/// `keys` are held around it, and everything posted, as in
/// [`background_drag`].
fn background_hold(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	at: CGPoint,
	button: MouseButton,
	keys: &[KeyName],
	duration: Duration,
	post: Post<'_>,
) -> CoreResult<()> {
	let (cg_button, down, up, _, number) = button_types(button);
	let flags = held_flags(keys);
	let group = click_group_id();
	let pointer = |event: &CGEvent, click_state, button_number| {
		route_window_pointer(pid, wid, window, event, at.x, at.y, click_state, button_number, group)?;
		post(Posted::Pointer, pid, event)
	};
	with_held_keys(
		source,
		keys,
		KEY_GAP,
		|event| post(Posted::Key, pid, event),
		|| {
			pointer(&mouse_event(source, CGEventType::MouseMoved, at, CGMouseButton::Left)?, 0, 0)?;
			control::wait(Duration::from_millis(12))?;
			control::bounded_hold(duration, |pressed| {
				let event = mouse_event(source, if pressed { down } else { up }, at, cg_button)?;
				event.set_flags(flags);
				pointer(&event, 1, number)
			})
		},
	)
}

/// Background left click on the Chromium-compatible route: a hover primer at
/// the target, a press/release off-screen that satisfies Chromium's
/// user-activation gate without hitting any element, then the real presses,
/// each posted through `post` once `before_press` passes; a release always
/// follows a posted press.
///
/// Quartz event locations are global; the separate window-location field is
/// relative to the window's top-left, including its title bar. Chromium uses
/// that field for hit-testing even on the `SkyLight`-only route.
fn background_left_click(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	(x, y, count): (f64, f64, u32),
	flags: CGEventFlags,
	before_press: impl Fn() -> CoreResult<()>,
	post_event: impl Fn(libc::pid_t, &CGEvent) -> CoreResult<()>,
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
		post_event(pid, &event)
	};
	let unmodified = CGEventFlags::CGEventFlagNull;
	post(CGEventType::MouseMoved, target, local, 2, 0, flags)?;
	control::wait(Duration::from_millis(15))?;
	before_press()?;
	post(CGEventType::LeftMouseDown, offscreen, offscreen, 1, 1, unmodified)?;
	let result = control::wait(Duration::from_millis(1));
	let release =
		control::cleanup(|| post(CGEventType::LeftMouseUp, offscreen, offscreen, 2, 1, unmodified));
	skylight::after_cleanup(result, release)?;
	control::wait(Duration::from_millis(100))?;
	let count = count.max(1);
	for click_state in 1..=count {
		before_press()?;
		post(CGEventType::LeftMouseDown, target, local, 3, i64::from(click_state), flags)?;
		let result = control::sent_gap_wait(Duration::from_millis(1), click_state == count);
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
				.and_then(|()| control::sent_gap_wait(PRESS_GAP, click_state == count));
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
	// SAFETY: `event` is a live CGEvent. Quartz event timestamps count
	// nanoseconds of system uptime.
	unsafe { set_event_timestamp(event.as_ptr(), control::uptime_ns()) };
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
/// the ordinary route. Like every background pointer event, each post first
/// passes [`pointer_recheck`]; nothing here makes the window key.
fn report_pointer(
	source: &CGEventSource,
	pid: libc::pid_t,
	wid: u32,
	window: &DesktopWindow,
	event: PointerEvent,
	entry_front: EntryFront,
	owner: impl FnOnce() -> CoreResult<(libc::pid_t, u32)>,
	in_overlay: bool,
	visit: skylight::TargetVisit<'_>,
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
	// Each check after the first follows something already posted.
	let checks = std::cell::Cell::new(0_u32);
	let before_post = || {
		let sent = checks.replace(checks.get() + 1) > 0;
		pointer_recheck(
			(false, sent),
			entry_front,
			(pid, wid, &window.app),
			skylight::front_pid,
			|| visit.happened(),
		)
	};
	match event {
		PointerEvent::Click { x, y, button: MouseButton::Left, count, .. } => {
			report_taps(count, before_post, |event_type, click_state| {
				post(event_type, x, y, click_state)
			})
		},
		PointerEvent::Scroll { x, y, dx, dy } => report_scroll(
			before_post,
			|| post(CGEventType::LeftMouseUp, x, y, 1),
			|| background_scroll(source, pid, wid, window, x, y, dx, dy),
		),
		event => background_pointer(
			source,
			pid,
			wid,
			window,
			event,
			None,
			entry_front,
			owner,
			in_overlay,
			visit,
		),
	}
}

/// `count` taps for [`report_pointer`]: each press, posted through `post`
/// with its click state once `before_press` passes, is held for a report and
/// always released.
fn report_taps(
	count: u32,
	before_press: impl Fn() -> CoreResult<()>,
	post: impl Fn(CGEventType, i64) -> CoreResult<()>,
) -> CoreResult<()> {
	let count = i64::from(count.max(1));
	for click_state in 1..=count {
		before_press()?;
		let result = post(CGEventType::LeftMouseDown, click_state)
			.and_then(|()| control::sent_gap_wait(TAP_HOLD, click_state == count));
		let release = control::cleanup(|| post(CGEventType::LeftMouseUp, click_state));
		skylight::after_cleanup(result, release)?;
		if click_state < count {
			control::wait(MULTI_CLICK_GAP)?;
		}
	}
	Ok(())
}

/// A [`report_pointer`] scroll: `aim` moves the device's pointer, then
/// `scroll` posts; each first passes `before_post`.
fn report_scroll(
	before_post: impl Fn() -> CoreResult<()>,
	aim: impl FnOnce() -> CoreResult<()>,
	scroll: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	before_post()?;
	aim()?;
	control::wait(TAP_HOLD)?;
	before_post()?;
	scroll()
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

/// The keys that type `text` into `window`. A remote screen forwards key
/// codes and drops the Unicode payload, so it gets the keys of the layout
/// `layout` looks up; a local application reads the payload on virtual key 0.
fn keys_for<'t, S: Fn(char) -> Option<Keystroke>>(
	window: &DesktopWindow,
	text: &'t str,
	remote: Option<RemoteScreen>,
	layout: impl FnOnce() -> CoreResult<Option<S>>,
) -> CoreResult<Vec<TypedKey<'t>>> {
	match remote {
		Some(_) => typed_keys(window, text, remote_layout(window, layout)?),
		None => Ok(unicode_keys(text)),
	}
}

/// The lookup `layout` gives for keys into `window`, a remote screen. A
/// layout without Unicode key layout data has none, which refuses rather than
/// report every character as one no key types.
fn remote_layout<S>(
	window: &DesktopWindow,
	layout: impl FnOnce() -> CoreResult<Option<S>>,
) -> CoreResult<S> {
	layout()?.ok_or_else(|| {
		DesktopError::input_failed(format!(
			"window {} ({}) shows a remote screen, which receives key codes, and the current \
			 keyboard layout publishes no Unicode key layout data to find them in; nothing was sent; \
			 switch to another keyboard layout",
			window.id, window.app,
		))
	})
}

/// `text` as Unicode payloads on virtual key 0, grapheme by grapheme.
fn unicode_keys(text: &str) -> Vec<TypedKey<'_>> {
	graphemes_str(text)
		.flat_map(unicode_runs)
		.map(TypedKey::Unicode)
		.collect()
}

/// The layout keys that type `text` into `window`, from `stroke`'s lookup.
/// Text no key types fails before anything is posted.
fn typed_keys<'t>(
	window: &DesktopWindow,
	text: &'t str,
	stroke: impl Fn(char) -> Option<Keystroke>,
) -> CoreResult<Vec<TypedKey<'t>>> {
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
		if let Some(stroke) = character.and_then(&stroke) {
			keys.push(TypedKey::Layout(stroke, grapheme));
		} else if !untypable.contains(&grapheme) {
			untypable.push(grapheme);
		}
	}
	if untypable.is_empty() {
		return Ok(keys);
	}
	Err(DesktopError::invalid_key(format!(
		"window {} ({}) shows a remote screen, which receives key codes and ignores typed text, and \
		 no key on the current keyboard layout types {}; nothing was typed",
		window.id,
		window.app,
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
		for (index, key) in keys.iter().enumerate() {
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
			// Once the last key is pressed the text is out: a cancel then must
			// not report it unsent.
			let last = index + 1 == keys.len();
			let result = post(&press).and_then(|()| control::sent_gap_wait(gap, last));
			let cleanup = control::cleanup(|| post(&release));
			skylight::after_cleanup(result, cleanup)?;
			control::sent_gap_wait(gap, last)?;
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

/// Posts bare key transitions at the HID tap ([`post_bare`]).
fn post_bare_keys(
	transitions: &[(u16, bool)],
	gap: Duration,
	guard: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	post_transitions(transitions, gap, guard, post_bare)
}

/// Posts one bare key transition at the HID tap: a null source and no flag
/// or Unicode overrides, so `CoreGraphics` derives modifier state from the
/// transitions exactly as for a hardware keyboard. Only a press can be
/// cancelled; a release always goes out.
fn post_bare(code: u16, down: bool) -> CoreResult<()> {
	if down {
		control::check()?;
	}
	// SAFETY: A null source is documented as valid for keyboard events.
	let raw = unsafe { create_keyboard_event(ptr::null_mut(), code, down) };
	if raw.is_null() {
		return Err(DesktopError::input_failed("failed to create a Quartz keyboard event"));
	}
	// SAFETY: `raw` is a non-null create-rule event whose ownership moves
	// here.
	let event = unsafe { CGEvent::from_ptr(raw) };
	post_global(&event)
}

/// Presses the chord `keys` as bare transitions ([`post_bare`]), running
/// `guard` before every press.
fn press_bare_chord(
	keys: &[KeyPress],
	gap: Duration,
	guard: impl FnMut() -> CoreResult<()>,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(empty_chord());
	}
	hold_transitions(keys, gap, guard, || Ok(()), post_bare)
}

/// Holds `keys` as bare transitions ([`post_bare`]) while `body` runs,
/// running `guard` before every press.
fn hold_bare_keys(
	keys: &[KeyPress],
	gap: Duration,
	guard: impl FnMut() -> CoreResult<()>,
	body: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	hold_transitions(keys, gap, guard, body, post_bare)
}

/// Presses `keys` in order through `post`, each once `guard` passes, runs
/// `body` while they are held, then releases them in reverse, with `gap`
/// after every transition. A key counts as held from its attempted press
/// until its release posts; keys still held when posting, `body` or the
/// operation fails are released.
fn hold_transitions(
	keys: &[KeyPress],
	gap: Duration,
	mut guard: impl FnMut() -> CoreResult<()>,
	body: impl FnOnce() -> CoreResult<()>,
	mut post: impl FnMut(u16, bool) -> CoreResult<()>,
) -> CoreResult<()> {
	let mut held = 0;
	let result = (|| {
		for key in keys {
			control::check()?;
			guard()?;
			held += 1;
			post(key.code, true)?;
			control::sent_gap_wait(gap, held == keys.len())?;
		}
		body()?;
		while let Some(key) = keys[..held].last() {
			post(key.code, false)?;
			held -= 1;
			control::sent_gap_wait(gap, true)?;
		}
		Ok(())
	})();
	let cleanup = control::cleanup(|| {
		let mut result = Ok(());
		for key in keys[..held].iter().rev() {
			result = skylight::after_cleanup(result, post(key.code, false));
		}
		result
	});
	skylight::after_cleanup(result, cleanup)
}

/// Posts `transitions` with `gap` after each, running `guard` before every
/// press. A key counts as held from its attempted press until its release
/// posts; keys still held when posting fails or is cancelled are released.
/// After the last press nothing can be cancelled.
fn post_transitions(
	transitions: &[(u16, bool)],
	gap: Duration,
	mut guard: impl FnMut() -> CoreResult<()>,
	mut post: impl FnMut(u16, bool) -> CoreResult<()>,
) -> CoreResult<()> {
	let last_press = transitions.iter().rposition(|&(_, down)| down);
	let mut held = [false; 128];
	let mut result = Ok(());
	for (index, &(code, down)) in transitions.iter().enumerate() {
		let sent = last_press.is_none_or(|last| index >= last);
		result = (if sent && !down {
			Ok(())
		} else {
			control::check()
		})
		.and_then(|()| {
			if down {
				guard()?;
				held[usize::from(code)] = true;
			}
			post(code, down)?;
			held[usize::from(code)] = down;
			control::sent_gap_wait(gap, sent)
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
	press_chord(source, &ansi_keys(keys)?, gap, post)
}

fn press_chord(
	source: &CGEventSource,
	keys: &[KeyPress],
	gap: Duration,
	post: impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
	if keys.is_empty() {
		return Err(empty_chord());
	}
	hold_presses(source, keys, gap, post, || Ok(()))
}

fn with_held_keys(
	source: &CGEventSource,
	keys: &[KeyName],
	gap: Duration,
	post: impl FnMut(&CGEvent) -> CoreResult<()>,
	body: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	hold_presses(source, &ansi_keys(keys)?, gap, post, body)
}

/// A key and the virtual key code that presses it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct KeyPress {
	name: KeyName,
	code: u16,
}

/// `keys` at the ANSI key positions that macOS virtual key codes name.
fn ansi_keys(keys: &[KeyName]) -> CoreResult<Vec<KeyPress>> {
	keys
		.iter()
		.map(|&name| Ok(KeyPress { name, code: key_code(name)? }))
		.collect()
}

fn empty_chord() -> DesktopError {
	DesktopError::invalid_key("key chord must not be empty")
}

/// The presses for the chord `keys` into `window`. A remote screen hands key
/// codes to the remote computer, which reads them through its own layout, so
/// a character there is the key of the layout `layout` looks up.
fn chord_keys<S: Fn(char) -> Option<Keystroke>>(
	window: &DesktopWindow,
	keys: &[KeyName],
	remote: Option<RemoteScreen>,
	layout: impl FnOnce() -> CoreResult<Option<S>>,
) -> CoreResult<Vec<KeyPress>> {
	match remote {
		Some(_) => layout_chord(window, keys, remote_layout(window, layout)?),
		None => ansi_keys(keys),
	}
}

/// `keys` with each character on `stroke`'s key for it, preceded by the Shift
/// or Option that key needs unless the chord already names it. Letters are
/// matched case-insensitively, as on the ANSI path.
fn layout_chord(
	window: &DesktopWindow,
	keys: &[KeyName],
	stroke: impl Fn(char) -> Option<Keystroke>,
) -> CoreResult<Vec<KeyPress>> {
	let mut chord = Vec::with_capacity(keys.len() + 2);
	for &name in keys {
		let KeyName::Char(character) = name else {
			chord.push(KeyPress { name, code: key_code(name)? });
			continue;
		};
		let key = stroke(character.to_ascii_lowercase()).ok_or_else(|| {
			DesktopError::invalid_key(format!(
				"window {} ({}) shows a remote screen, which receives key codes, and no key on the \
				 current keyboard layout types '{character}'; nothing was sent",
				window.id, window.app,
			))
		})?;
		for (needed, modifier) in [(key.shift, KeyName::Shift), (key.option, KeyName::Alt)] {
			// Once per chord: a second Shift would be released, in reverse,
			// while the first character's key is still down.
			if needed && !keys.contains(&modifier) && !chord.iter().any(|press| press.name == modifier)
			{
				chord.push(KeyPress { name: modifier, code: key_code(modifier)? });
			}
		}
		chord.push(KeyPress { name, code: key.code });
	}
	Ok(chord)
}

fn hold_presses(
	source: &CGEventSource,
	keys: &[KeyPress],
	gap: Duration,
	mut post: impl FnMut(&CGEvent) -> CoreResult<()>,
	body: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
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
		update_modifier(&mut active, key.name, true);
		pressed += 1;
		if let Err(error) = control::check()
			.and_then(|()| post_code(source, key.code, true, modifier_flags(active), &mut post))
			.and_then(|()| control::sent_gap_wait(gap, pressed == keys.len()))
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
			update_modifier(&mut active, key.name, false);
			// A device that samples HID report state drops transitions closer
			// than its report interval, so every release, the last included,
			// is followed by `gap` before the next transition can go out.
			let release = post_code(source, key.code, false, modifier_flags(active), &mut post)
				.and_then(|()| control::wait(gap));
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
	post_code(source, key_code(key)?, down, flags, post)
}

fn post_code(
	source: &CGEventSource,
	code: u16,
	down: bool,
	flags: CGEventFlags,
	post: &mut impl FnMut(&CGEvent) -> CoreResult<()>,
) -> CoreResult<()> {
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
/// With `return_focus`, user input during the action does not cancel the
/// restoration.
/// With `menu`, the item path is chosen in the menu the click opens before
/// focus goes back, which would close the menu.
fn foreground_pointer(
	source: &CGEventSource,
	window: &DesktopWindow,
	pid: libc::pid_t,
	wid: u32,
	event: PointerEvent,
	return_focus: bool,
	menu: Option<&[String]>,
) -> CoreResult<()> {
	let kind = pointer_kind(&event);
	let timeout = if may_open_context_menu(&event) {
		ax::open_menu::CONTEXT_MENU_TIMEOUT
	} else {
		ax::open_menu::CONTROL_MENU_TIMEOUT
	};
	preserving_cursor(source, || {
		skylight::with_foreground(pid, wid, return_focus, |_| {
			let choices = control::user_choices();
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
							|before, path| {
								ax::open_menu::settle(pid, pid, before, path, timeout, || Ok(()))
							},
						)
					},
				});
			// Capture before raising, so even a failed raise/re-hit-test retains
			// the restoration token. Never reorder over a user-selected app.
			let cleanup = if (return_focus || control::user_choices() == choices)
				&& skylight::is_front_window(pid, wid)
			{
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
					let result = control::sent_gap_wait(PRESS_GAP, click_state == count);
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
			result.inspect(|()| control::settle(POINTER_SETTLE))
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
			// Every point is out and the release always goes.
			control::settle(Duration::from_millis(50));
			Ok(())
		})();
		let release = control::cleanup(|| post(up, last, false, flags));
		skylight::after_cleanup(result, release)
	});
	// Lets the target release its pointer capture before focus is restored.
	result.inspect(|()| control::settle(Duration::from_millis(100)))
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
	post_hid(event, |event| {
		skylight::note_hid_post(event.get_type());
		event.post(CGEventTapLocation::HID);
	})
}

/// Tags and posts `event` at the HID tap through `post`. A key, modifier or
/// pointer press first checks that the user has not used the target's app
/// since the call began ([`control::intervention::check_press`]); releases
/// always go out.
fn post_hid(event: &CGEvent, post: impl FnOnce(&CGEvent)) -> CoreResult<()> {
	control::check()?;
	if is_key_press(event) || control::is_pointer_press(event.get_type() as u32) {
		control::intervention::check_press()?;
	}
	event.set_integer_value_field(EventField::EVENT_SOURCE_USER_DATA, control::SYNTHETIC_EVENT_TAG);
	release_guard::post(Route::Hid, event, || {
		post(event);
		Ok(())
	})
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
			let keys = unicode_keys("e\u{301}later");
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
			'!' => key(18, true, false),
			' ' => key(49, false, false),
			'\r' | '\n' => key(36, false, false),
			'€' => key(19, true, true),
			'å' => key(0, false, true),
			_ => None,
		}
	}

	fn screen_sharing() -> DesktopWindow {
		DesktopWindow { app: "Screen Sharing".to_string(), ..frame(42, 0, 0, 800, 600) }
	}

	/// The keys typing `text` into a Screen Sharing window on the US layout.
	fn us_keys(text: &str) -> CoreResult<Vec<TypedKey<'_>>> {
		typed_keys(&screen_sharing(), text, us_stroke)
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
		let keys = us_keys("aBC b\r\n").unwrap();
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
		]);
	}

	#[test]
	fn failed_shifted_key_still_releases_shift() {
		let source = source().expect("event source");
		let keys = us_keys("Ba").unwrap();
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
		let keys = us_keys("Ba").unwrap();
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
		let keys = us_keys(text).unwrap();
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
	fn screen_sharing_keys_stop_while_the_user_holds_a_modifier_or_caps_lock_is_on() {
		use crate::desktop::error::ErrorCode;
		let window = screen_sharing();
		let source = source().expect("event source");
		let keys = us_keys("ab").unwrap();
		// Caps Lock on: every letter would arrive capitalised, so nothing is
		// pressed.
		let mut check =
			physical_modifier_check(&window, || CGEventFlags::CGEventFlagAlphaShift.bits());
		let mut posted = 0;
		let error = type_keys(&source, &keys, Duration::ZERO, &mut check, |_| {
			posted += 1;
			Ok(())
		})
		.unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		assert!(error.message.contains("window 42 (Screen Sharing)"), "{}", error.message);
		assert_eq!(posted, 0);
		// The user presses Command after a is typed: b would reach the remote
		// computer as Cmd-B, so it is not pressed. a already went out, so the
		// stop is not one takeover may retry: that would type a again.
		let flags = std::cell::Cell::new(0);
		let mut check = physical_modifier_check(&window, || flags.get());
		let mut typed = Vec::new();
		let error = type_keys(&source, &keys, Duration::ZERO, &mut check, |event| {
			let event = typed_event(event);
			if event.0 == CGEventType::KeyUp as u32 {
				flags.set(CGEventFlags::CGEventFlagCommand.bits());
			}
			typed.push((event.0, event.1));
			Ok(())
		})
		.unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(
			error
				.message
				.contains("1 key press(es) sent before this may already have landed"),
			"{}",
			error.message
		);
		assert_eq!(typed, [(CGEventType::KeyDown as u32, 0), (CGEventType::KeyUp as u32, 0)]);
		// Flags that change no key, such as the keypad's, do not stop it.
		let mut check =
			physical_modifier_check(&window, || CGEventFlags::CGEventFlagNumericPad.bits());
		type_keys(&source, &keys, Duration::ZERO, &mut check, |_| Ok(())).unwrap();
	}

	/// The bare transitions takeover posts for `keys` into a remote screen,
	/// with focus lost after `lose_after`, and how many were posted when the
	/// hold's body ran.
	fn remote_hold(
		keys: &[KeyPress],
		lose_after: Option<(u16, bool)>,
	) -> (CoreResult<()>, Vec<(u16, bool)>, Option<usize>) {
		let lost = std::cell::Cell::new(false);
		let posted = std::cell::RefCell::new(Vec::new());
		let mut body_at = None;
		let result = hold_transitions(
			keys,
			Duration::ZERO,
			|| {
				if lost.get() {
					Err(DesktopError::input_failed("focus moved"))
				} else {
					Ok(())
				}
			},
			|| {
				body_at = Some(posted.borrow().len());
				Ok(())
			},
			|code, down| {
				posted.borrow_mut().push((code, down));
				lost.set(lost.get() || lose_after == Some((code, down)));
				Ok(())
			},
		);
		(result, posted.into_inner(), body_at)
	}

	#[test]
	fn remote_takeover_chords_press_their_modifiers_as_keys() {
		let window = screen_sharing();
		let chord = |keys: &[KeyName]| {
			chord_keys(&window, keys, Some(RemoteScreen::KeyEvents), || Ok(Some(us_stroke))).unwrap()
		};
		// Screen Sharing reads modifiers from the keyboard state, which only
		// key transitions move: Command is down while a is pressed.
		let (result, posted, body_at) =
			remote_hold(&chord(&[KeyName::Meta, KeyName::Char('a')]), None);
		result.unwrap();
		assert_eq!(posted, [(55, true), (0, true), (0, false), (55, false)]);
		assert_eq!(body_at, Some(2), "a hold's body runs with every key down");
		// The Shift that ! needs is pressed as a key too.
		let (result, posted, _) = remote_hold(&chord(&[KeyName::Char('!')]), None);
		result.unwrap();
		assert_eq!(posted, [(56, true), (18, true), (18, false), (56, false)]);
		// Focus moves once Command is down: a is not pressed, Command is
		// released, and nothing is held through the body.
		let (result, posted, body_at) =
			remote_hold(&chord(&[KeyName::Meta, KeyName::Char('a')]), Some((55, true)));
		assert!(result.is_err());
		assert_eq!(posted, [(55, true), (55, false)]);
		assert_eq!(body_at, None);
	}

	#[test]
	fn a_click_whose_last_press_is_out_is_not_reported_cancelled() {
		use crate::desktop::error::ErrorCode;
		let (down, up) = (CGEventType::LeftMouseDown as u32, CGEventType::LeftMouseUp as u32);
		// A double tap cancelled as its `cancel_at`th press goes out.
		let run = |cancel_at: i64| {
			let source = control::CancellationSource::default();
			let token = source.token();
			let posted = std::cell::RefCell::new(Vec::new());
			let result = control::with_token_for_test(&token, || {
				report_taps(
					2,
					|| Ok(()),
					|event, click_state| {
						posted.borrow_mut().push((event as u32, click_state));
						if event as u32 == down && click_state == cancel_at {
							source.cancel();
						}
						Ok(())
					},
				)
			});
			(result.map_err(|error| error.code), posted.into_inner())
		};
		// Cancelled at the last press: the click went out whole and stands.
		assert_eq!(run(2), (Ok(()), vec![(down, 1), (up, 1), (down, 2), (up, 2)]));
		// Cancelled at an earlier press: released, and the rest is not sent.
		assert_eq!(run(1), (Err(ErrorCode::Cancelled), vec![(down, 1), (up, 1)]));
	}

	#[test]
	fn input_whose_last_key_is_out_is_not_reported_cancelled() {
		let source = source().expect("event source");
		let gap = Duration::from_millis(20);
		let cancelled = |post: &mut dyn FnMut(&control::CancellationSource) -> CoreResult<()>| {
			let cancellation = control::CancellationSource::default();
			let token = cancellation.token();
			control::with_token_for_test(&token, || post(&cancellation))
		};
		let (down, up) = (CGEventType::KeyDown as u32, CGEventType::KeyUp as u32);
		// Typed text: the user cancels as the last key goes down.
		let mut typed = Vec::new();
		cancelled(&mut |cancellation| {
			type_keys(
				&source,
				&us_keys("ab").unwrap(),
				gap,
				|| Ok(()),
				|event| {
					let event = typed_event(event);
					if (event.0, event.1) == (down, 11) {
						cancellation.cancel();
					}
					typed.push((event.0, event.1));
					Ok(())
				},
			)
		})
		.unwrap();
		assert_eq!(typed, [(down, 0), (up, 0), (down, 11), (up, 11)]);
		// A shortcut fires on its last key-down: cmd+a.
		let chord = [KeyPress { name: KeyName::Meta, code: 55 }, KeyPress {
			name: KeyName::Char('a'),
			code: 0,
		}];
		let mut posted = Vec::new();
		cancelled(&mut |cancellation| {
			press_chord(&source, &chord, gap, |event| {
				let event = typed_event(event);
				if (event.0, event.1) == (down, 0) {
					cancellation.cancel();
				}
				posted.push(event.1);
				Ok(())
			})
		})
		.unwrap();
		assert_eq!(posted, [55, 0, 0, 55]);
		// Remote takeover: bare transitions, as a chord and as typed text.
		let mut bare = Vec::new();
		cancelled(&mut |cancellation| {
			hold_transitions(
				&chord,
				gap,
				|| Ok(()),
				|| Ok(()),
				|code, pressed| {
					if (code, pressed) == (0, true) {
						cancellation.cancel();
					}
					bare.push((code, pressed));
					Ok(())
				},
			)
		})
		.unwrap();
		assert_eq!(bare, [(55, true), (0, true), (0, false), (55, false)]);
		let mut bare = Vec::new();
		cancelled(&mut |cancellation| {
			let transitions = bare_transitions(&us_keys("aB").unwrap());
			post_transitions(
				&transitions,
				gap,
				|| Ok(()),
				|code, pressed| {
					if (code, pressed) == (11, true) {
						cancellation.cancel();
					}
					bare.push((code, pressed));
					Ok(())
				},
			)
		})
		.unwrap();
		assert_eq!(bare, [(0, true), (0, false), (56, true), (11, true), (11, false), (56, false)]);
		// A cancel before the last press still stops the rest.
		let mut bare = Vec::new();
		let result = cancelled(&mut |cancellation| {
			let transitions = bare_transitions(&us_keys("aB").unwrap());
			post_transitions(
				&transitions,
				gap,
				|| Ok(()),
				|code, pressed| {
					if (code, pressed) == (0, false) {
						cancellation.cancel();
					}
					bare.push((code, pressed));
					Ok(())
				},
			)
		});
		assert!(result.is_err());
		assert_eq!(bare, [(0, true), (0, false)]);
	}

	/// The transitions `post_transitions` posts for "aB" on a remote screen,
	/// with focus lost after `lose_after` and the first post of `fail` failing.
	fn remote_takeover(
		lose_after: Option<(u16, bool)>,
		fail: Option<(u16, bool)>,
	) -> (CoreResult<()>, Vec<(u16, bool)>) {
		let keys = us_keys("aB").unwrap();
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

	/// What a test's keyboard-layout read returns.
	type LayoutRead = CoreResult<Option<fn(char) -> Option<Keystroke>>>;

	#[test]
	fn local_text_stays_unicode_on_key_zero_and_only_a_remote_screen_gets_layout_keys() {
		let no_layout = || -> LayoutRead { panic!("local text reads no keyboard layout") };
		let window = screen_sharing();
		let local = keys_for(&window, "aB\n", None, no_layout).unwrap();
		let source = source().expect("event source");
		let mut events = Vec::new();
		type_keys(
			&source,
			&local,
			Duration::ZERO,
			|| Ok(()),
			|event| {
				let typed = typed_event(event);
				events.push((typed.0, typed.1, event.get_flags(), typed.4));
				Ok(())
			},
		)
		.unwrap();
		// No Shift for B, and a newline is text rather than a Return press.
		let (down, up) = (CGEventType::KeyDown as u32, CGEventType::KeyUp as u32);
		let key = |kind, text: &str| (kind, 0, CGEventFlags::CGEventFlagNull, text.to_string());
		assert_eq!(events, [
			key(down, "a"),
			key(up, "a"),
			key(down, "B"),
			key(up, "B"),
			key(down, "\n"),
			key(up, "\n"),
		]);
		let stroke = |code, shift| Keystroke { code, shift, option: false };
		let remote = keys_for(&window, "aB\n", Some(RemoteScreen::KeyEvents), || Ok(Some(us_stroke)));
		assert_eq!(remote.unwrap(), [
			TypedKey::Layout(stroke(0, false), "a"),
			TypedKey::Layout(stroke(11, true), "B"),
			TypedKey::Layout(stroke(36, false), "\n"),
		]);
	}

	#[test]
	fn a_layout_without_unicode_key_data_refuses_remote_keys_naming_the_window_and_why() {
		let window = screen_sharing();
		let none = || -> LayoutRead { Ok(None) };
		for error in [
			keys_for(&window, "a", Some(RemoteScreen::KeyEvents), none).unwrap_err(),
			chord_keys(&window, &[KeyName::Char('a')], Some(RemoteScreen::HidReports), none)
				.unwrap_err(),
		] {
			assert_eq!(error.code, ErrorCode::InputFailed);
			assert!(error.message.contains("window 42 (Screen Sharing)"), "{}", error.message);
			assert!(error.message.contains("no Unicode key layout data"), "{}", error.message);
		}
		// Local text reads no layout, so it types without one.
		assert!(keys_for(&window, "a", None, none).is_ok());
	}

	#[test]
	fn remote_chords_press_the_layouts_key_for_each_character() {
		// AZERTY: q sits on the ANSI a key, a on the ANSI q key, and 1 needs
		// Shift on the ANSI 1 key.
		let azerty = |character| {
			let key = |code, shift| Some(Keystroke { code, shift, option: false });
			match character {
				'q' => key(0, false),
				'a' => key(12, false),
				'1' => key(18, true),
				_ => None,
			}
		};
		let press = |name, code| KeyPress { name, code };
		let remote = Some(RemoteScreen::KeyEvents);
		let window = screen_sharing();
		let layout = || Ok(Some(azerty));
		assert_eq!(chord_keys(&window, &[KeyName::Char('Q')], remote, layout).unwrap(), [press(
			KeyName::Char('Q'),
			0
		)]);
		let local = || -> LayoutRead { panic!("a local chord reads no keyboard layout") };
		assert_eq!(chord_keys(&window, &[KeyName::Char('q')], None, local).unwrap(), [press(
			KeyName::Char('q'),
			12
		)]);
		// The Shift a character needs joins the chord, so Screen Sharing's
		// background modifier check refuses it before anything is sent.
		let shifted = [press(KeyName::Shift, 56), press(KeyName::Char('1'), 18)];
		assert_eq!(chord_keys(&window, &[KeyName::Char('1')], remote, layout).unwrap(), shifted);
		assert_eq!(
			chord_keys(&window, &[KeyName::Shift, KeyName::Char('1')], remote, layout).unwrap(),
			shifted
		);
		let error = chord_keys(&window, &[KeyName::Char('z')], remote, layout).unwrap_err();
		assert_eq!(error.code, ErrorCode::InvalidKey);
		assert!(error.message.contains("window 42 (Screen Sharing)"), "{}", error.message);
	}

	#[test]
	fn a_remote_chord_presses_a_modifier_two_characters_need_only_once() {
		// US: ! is Shift-1 and € Shift-Option-2. A second Shift would be
		// released, in reverse, while 1 is still down.
		let press = |name, code| KeyPress { name, code };
		let keys = [KeyName::Char('!'), KeyName::Char('€')];
		let layout = || Ok(Some(us_stroke));
		assert_eq!(
			chord_keys(&screen_sharing(), &keys, Some(RemoteScreen::HidReports), layout).unwrap(),
			[
				press(KeyName::Shift, 56),
				press(KeyName::Char('!'), 18),
				press(KeyName::Alt, 58),
				press(KeyName::Char('€'), 19),
			]
		);
	}

	#[test]
	fn remote_text_takes_option_keys_and_refuses_text_no_key_types() {
		assert_eq!(us_keys("€").unwrap(), [TypedKey::Layout(
			Keystroke { code: 19, shift: true, option: true },
			"€"
		),]);
		// A remote screen ignores the Unicode payload, so text no key types
		// refuses before anything is posted, naming each character once.
		let error = us_keys("a😀bé😀").unwrap_err();
		assert_eq!(error.code, ErrorCode::InvalidKey);
		assert!(error.message.contains("types 😀 é;"), "{}", error.message);
		assert!(error.message.contains("window 42 (Screen Sharing)"), "{}", error.message);
	}

	#[test]
	fn typed_text_reaches_the_target_whole_as_unicode_payloads() {
		// Control characters, a ZWJ emoji, and a grapheme longer than one
		// event's 20 UTF-16 units all ride as payloads; none has a key.
		let text = format!("a\tb\n\u{1b}👨‍👩‍👧‍👦e{}é", "\u{301}".repeat(24));
		let no_layout = || -> LayoutRead { panic!("local text reads no keyboard layout") };
		let keys = keys_for(&screen_sharing(), &text, None, no_layout).unwrap();
		let source = source().expect("event source");
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
		let (down, up) = (CGEventType::KeyDown as u32, CGEventType::KeyUp as u32);
		let mut typed = String::new();
		for pair in events.chunks(2) {
			let [(press_kind, 0, false, false, press), (release_kind, 0, false, false, release)] =
				pair
			else {
				panic!("expected an unmodified key-0 press and release, got {pair:?}");
			};
			assert_eq!((*press_kind, *release_kind), (down, up), "{pair:?}");
			assert_eq!(press, release);
			assert!(press.encode_utf16().count() <= MAX_EVENT_UNITS, "{press:?}");
			typed.push_str(press);
		}
		assert_eq!(typed, text);
	}

	#[test]
	fn remote_text_with_a_keyless_character_types_nothing() {
		for character in ["é", "😀", "e\u{301}", "\u{1b}", "\u{7f}"] {
			let text = format!("ab{character}Ba");
			let error = us_keys(&text).unwrap_err();
			assert_eq!(error.code, ErrorCode::InvalidKey, "{text:?}");
			assert!(error.message.contains(&format!("types {character};")), "{}", error.message);
			assert!(error.message.contains("nothing was typed"), "{}", error.message);
		}
		// Tab, newline and shifted characters have keys: Shift goes down
		// around the shifted key only.
		let with_tab = |character| match character {
			'\t' => Some(Keystroke { code: 48, shift: false, option: false }),
			character => us_stroke(character),
		};
		let keys = typed_keys(&screen_sharing(), "a\tB\n", with_tab).unwrap();
		assert_eq!(bare_transitions(&keys), [
			(0, true),
			(0, false),
			(48, true),
			(48, false),
			(56, true),
			(11, true),
			(11, false),
			(56, false),
			(36, true),
			(36, false),
		]);
	}

	#[test]
	fn a_chord_with_a_keyless_character_presses_nothing() {
		let source = source().expect("event source");
		let mut events = Vec::new();
		let result = with_held_keys(
			&source,
			&[KeyName::Meta, KeyName::Char('é')],
			KEY_GAP,
			|event| {
				events.push(shift_transition(event));
				Ok(())
			},
			|| panic!("a refused chord must not run the hold"),
		);
		let error = result.unwrap_err();
		assert_eq!(error.code, ErrorCode::InvalidKey);
		assert!(error.message.contains("'é'"), "{}", error.message);
		assert!(events.is_empty(), "{events:?}");
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
		let keys = us_keys("BC€a").unwrap();
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
		assert!(modified_text(&us_keys("ab").unwrap()).is_empty());
		// Option alone also needs a modifier the remote reads from the keyboard.
		assert_eq!(modified_text(&us_keys("aå").unwrap()), ["å"]);
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

	/// Where an application sends keys: its focused window and the window of
	/// its focused element.
	fn focus_in(window: ax::FocusedWindow, element: Option<u32>) -> ax::KeyFocus {
		ax::KeyFocus { window, element_window: element, element_mapped: element.is_some() }
	}

	#[test]
	fn background_keys_stop_once_another_window_becomes_key() {
		let source = source().expect("event source");
		let window = |id| focus_in(ax::FocusedWindow::Id(id), Some(id));
		let focused = std::cell::Cell::new(window(7));
		let siblings = Some(KeyboardConflict::Siblings(1));
		let guard = || keys_still_reach(1, 7, || siblings, window(7), || focused.get(), |_| None);
		let mut posted = Vec::new();
		let result = type_keys(&source, &unicode_keys("ab"), Duration::ZERO, guard, |event| {
			let typed = typed_event(event);
			// The user picks a sibling window right after a is typed.
			if typed.0 == CGEventType::KeyUp as u32 {
				focused.set(window(9));
			}
			posted.push((typed.0, typed.4));
			Ok(())
		});
		let error = result.unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(error.message.contains("may already have landed"), "{}", error.message);
		assert_eq!(posted, [
			(CGEventType::KeyDown as u32, "a".to_string()),
			(CGEventType::KeyUp as u32, "a".to_string()),
		]);
		// Space is never pressed once a sibling is key; the releases still go
		// out, so nothing stays held.
		focused.set(window(7));
		let mut held = Vec::new();
		let result = with_held_keys(
			&source,
			&[KeyName::Shift, KeyName::Space],
			KEY_GAP,
			|event| {
				post_guarded(event, guard, |event| {
					focused.set(window(9));
					held.push(shift_transition(event));
					Ok(())
				})
			},
			|| panic!("a refused press must not run the hold"),
		);
		assert_eq!(result.unwrap_err().code, ErrorCode::InputFailed);
		assert_eq!(held, [
			SHIFT_SPACE_TRANSITIONS[0],
			SHIFT_SPACE_TRANSITIONS[2],
			SHIFT_SPACE_TRANSITIONS[3]
		]);
	}

	#[test]
	fn keys_stop_at_the_users_first_key_or_click_in_the_target_app() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, Some(1), || "TextEdit".to_string());
		let token = control::CancellationSource::default().token();
		let mut events = Vec::new();
		let result = {
			let _watch = listener
				.admit(7, &token)
				.expect("the user has not used TextEdit");
			key_chord(&source, &[KeyName::Ctrl, KeyName::Enter], KEY_GAP, |event| {
				post_guarded(event, intervention_guard(|| Ok(())), |event| {
					// The user types in TextEdit right after Ctrl goes down.
					listener.record_for_test(7, Instant::now());
					events.push((
						event.get_type() as u32,
						event.get_integer_value_field(EventField::KEYBOARD_EVENT_KEYCODE),
					));
					Ok(())
				})
			})
		};
		let error = result.unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.contains("in TextEdit during this input"), "{}", error.message);
		assert!(error.message.contains("nothing more was sent"), "{}", error.message);
		// Enter is never pressed; its release and Ctrl's still go out.
		assert_eq!(events, [
			(CGEventType::FlagsChanged as u32, 59),
			(CGEventType::KeyUp as u32, 36),
			(CGEventType::FlagsChanged as u32, 59),
		]);
	}

	#[test]
	fn any_background_key_path_that_runs_the_route_guard_stops_at_the_users_input() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, Some(1), || "TextEdit".to_string());
		let token = control::CancellationSource::default().token();
		let guard = intervention_guard(|| Ok(()));
		let mut events = Vec::new();
		// Typing runs the route's guard before each press itself, without
		// `post_guarded`.
		let result = {
			let _watch = listener
				.admit(7, &token)
				.expect("the user has not used TextEdit");
			type_keys(&source, &unicode_keys("abc"), Duration::ZERO, &guard, |event| {
				// The user types in TextEdit right after the first key goes out.
				listener.record_for_test(7, Instant::now());
				events.push(event.get_type() as u32);
				Ok(())
			})
		};
		let error = result.unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(error.message.contains("in TextEdit during this input"), "{}", error.message);
		// Only a is typed; b and c are never pressed.
		assert_eq!(&events[..2], [CGEventType::KeyDown as u32, CGEventType::KeyUp as u32]);
		assert!(!events[2..].contains(&(CGEventType::KeyDown as u32)), "{events:?}");
	}

	#[test]
	fn takeover_keys_held_around_a_pointer_gesture_stop_at_the_users_input() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, Some(1), || "TextEdit".to_string());
		let token = control::CancellationSource::default().token();
		let mut events = Vec::new();
		// A takeover drag or held mouse holds its keys through the HID tap.
		let result = {
			let _watch = listener
				.admit(7, &token)
				.expect("the user has not used TextEdit");
			with_held_keys(
				&source,
				&[KeyName::Shift, KeyName::Space],
				KEY_GAP,
				|event| {
					post_hid(event, |event| {
						// The user types in TextEdit right after Shift goes down.
						listener.record_for_test(7, Instant::now());
						events.push(shift_transition(event));
					})
				},
				|| panic!("a refused press must not run the gesture"),
			)
		};
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		// Space is never pressed; its release and Shift's still go out.
		assert_eq!(events, [
			SHIFT_SPACE_TRANSITIONS[0],
			SHIFT_SPACE_TRANSITIONS[2],
			SHIFT_SPACE_TRANSITIONS[3]
		]);
	}

	#[test]
	fn a_background_click_stops_at_the_users_input_during_its_preparation() {
		use crate::desktop::error::ErrorCode;
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, Some(1), || "TextEdit".to_string());
		let token = control::CancellationSource::default().token();
		let _watch = listener
			.admit(7, &token)
			.expect("the user has not used TextEdit");
		let recheck = || {
			pointer_recheck(
				(true, false),
				EntryFront(Some(9)),
				(7, 42, "TextEdit"),
				|| Some(9),
				|| false,
			)
		};
		recheck().unwrap();
		// The user types in TextEdit while the click makes its window key.
		listener.record_for_test(7, Instant::now());
		assert_eq!(recheck().unwrap_err().code, ErrorCode::UserIntervened);
	}

	#[test]
	fn a_takeover_click_stops_at_the_users_input_before_its_press() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, Some(1), || "TextEdit".to_string());
		let token = control::CancellationSource::default().token();
		let _watch = listener
			.admit(7, &token)
			.expect("the user has not used TextEdit");
		let event = |kind| {
			CGEvent::new_mouse_event(source.clone(), kind, CGPoint::new(1.0, 1.0), CGMouseButton::Left)
				.expect("mouse event")
		};
		let mut posted = Vec::new();
		let mut post = |kind| post_hid(&event(kind), |event| posted.push(event.get_type() as u32));
		// The user clicks in TextEdit while takeover brings the target forward.
		listener.record_for_test(7, Instant::now());
		let press = post(CGEventType::LeftMouseDown);
		assert_eq!(press.unwrap_err().code, ErrorCode::UserIntervened);
		// Moves and releases still go out.
		post(CGEventType::MouseMoved).unwrap();
		post(CGEventType::LeftMouseUp).unwrap();
		assert_eq!(posted, [CGEventType::MouseMoved as u32, CGEventType::LeftMouseUp as u32]);
	}

	#[test]
	fn background_keys_stop_once_the_overlay_holding_focus_closes() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		let (id, unreported) = (ax::FocusedWindow::Id, ax::FocusedWindow::Unreported);
		let siblings = Some(KeyboardConflict::Siblings(1));
		// Finder reports no focused window while its rename field, overlay 12
		// on window 7, has focus. Once the rename ends after a, Finder reports
		// window 7 focused and b would land in its file list.
		let rename = |id| (id == 12).then_some(7);
		let renaming = focus_in(unreported, Some(12));
		let focused = std::cell::Cell::new(renaming);
		let guard = || keys_still_reach(1, 7, || siblings, renaming, || focused.get(), rename);
		let mut typed = Vec::new();
		let keys = unicode_keys("ab");
		let result = type_keys(&source, &keys, Duration::ZERO, guard, |event| {
			if matches!(event.get_type(), CGEventType::KeyUp) {
				focused.set(focus_in(id(7), Some(7)));
			}
			typed.push(event.get_type() as u32);
			Ok(())
		});
		assert_eq!(result.unwrap_err().code, ErrorCode::InputFailed);
		let (down, up) = (CGEventType::KeyDown as u32, CGEventType::KeyUp as u32);
		assert_eq!(typed, [down, up]);
		// The rename ending with no focused window reported stops it too.
		let ended = focus_in(unreported, None);
		assert!(keys_still_reach(1, 7, || siblings, renaming, || ended, rename).is_err());
		// Reminders reports window 79 focused under its details popover 90:
		// once the popover closes, or another one on 79 takes focus, keys for
		// the popover would reach window 79 or that other popover.
		let popovers = |id| [90, 91].contains(&id).then_some(79);
		let in_popover = focus_in(id(79), Some(90));
		let closed = focus_in(id(79), Some(79));
		assert!(keys_still_reach(1, 90, || siblings, in_popover, || closed, popovers).is_err());
		let other = focus_in(id(79), Some(91));
		assert!(keys_still_reach(1, 90, || siblings, in_popover, || other, popovers).is_err());
	}

	#[test]
	fn background_keys_stop_once_the_user_brings_the_target_forward() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		// The user's app 9 is in front when typing into app 7 begins; after a,
		// the user clicks the target window, bringing app 7 forward.
		let front = std::cell::Cell::new(Some(9));
		let guard = || recheck_background(true, 7, 41, || front.get(), || false, || Ok(()));
		let mut typed = Vec::new();
		let keys = unicode_keys("ab");
		let result = type_keys(&source, &keys, Duration::ZERO, guard, |event| {
			if matches!(event.get_type(), CGEventType::KeyUp) {
				front.set(Some(7));
			}
			typed.push(event.get_type() as u32);
			Ok(())
		});
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		let (down, up) = (CGEventType::KeyDown as u32, CGEventType::KeyUp as u32);
		assert_eq!(typed, [down, up]);
		// Input into the app the user already had in front is not stopped.
		assert!(recheck_background(false, 7, 41, || Some(7), || false, || Ok(())).is_ok());
	}

	#[test]
	fn a_menu_command_stops_once_the_user_visited_the_target_and_left() {
		// The user clicked the target during the menu's settle wait and went
		// back to their app 9: the front process alone shows nothing, the focus
		// guard's record does.
		let error = recheck_background(true, 7, 41, || Some(9), || true, || Ok(())).unwrap_err();
		assert_eq!(error.code, crate::desktop::error::ErrorCode::UserIntervened);
		assert!(recheck_background(true, 7, 41, || Some(9), || false, || Ok(())).is_ok());
	}

	#[test]
	fn a_menu_press_check_refuses_once_the_user_picked_the_target_during_its_probes() {
		use crate::desktop::error::ErrorCode;
		// App 9 is in front as the check begins; the user picks target 7 while
		// its accessibility probes block.
		let front = std::cell::Cell::new(Some(9));
		let error = menu_press_verdict(
			|| front.get(),
			7,
			41,
			|| {
				front.set(Some(7));
				None
			},
		)
		.expect_err("the target came forward during the probes");
		assert_eq!(error.code, ErrorCode::UserIntervened);
		// Still behind the user: no menu control, nothing to refuse.
		front.set(Some(9));
		assert!(menu_press_verdict(|| front.get(), 7, 41, || None).is_ok());
		// The target was already the user's own front app at entry.
		front.set(Some(7));
		assert!(menu_press_verdict(|| front.get(), 7, 41, || None).is_ok());
	}

	#[test]
	fn a_user_who_came_to_the_target_is_never_handed_a_takeover_rerun() {
		use crate::desktop::error::ErrorCode;
		// The tool reruns only `BackgroundUnavailable` in takeover; the user
		// coming to the target must stop the call with another code.
		let code = |front: Option<i32>, visited: bool| {
			recheck_background(true, 7, 41, || front, || visited, || Ok(()))
				.unwrap_err()
				.code
		};
		assert_eq!(code(Some(7), false), ErrorCode::UserIntervened);
		assert_eq!(code(Some(9), true), ErrorCode::UserIntervened);
		assert_eq!(code(None, true), ErrorCode::UserIntervened);
		// An unknown front app may not be the user's doing.
		assert_eq!(code(None, false), ErrorCode::BackgroundUnavailable);
		assert_eq!(front_refusal(FrontTarget::CameForward, 41).code, ErrorCode::UserIntervened);
		assert_eq!(front_refusal(FrontTarget::UserSibling, 41).code, ErrorCode::UserIntervened);
		assert_eq!(front_refusal(FrontTarget::Unknown, 41).code, ErrorCode::BackgroundUnavailable);
	}

	#[test]
	fn a_background_hold_or_drag_goes_to_the_process_that_takes_the_windows_input() {
		let source = source().expect("event source");
		// TextEdit (pid 7581) shows its Open panel 554, whose input
		// openAndSavePanelService (pid 7592) takes in its window 556.
		let window = DesktopWindow {
			id:      "554".into(),
			title:   String::new(),
			app:     "TextEdit".into(),
			pid:     Some(7581),
			x:       100,
			y:       100,
			width:   600,
			height:  400,
			focused: false,
		};
		let posted = std::cell::RefCell::new(Vec::new());
		let post = |_: Posted, pid, event: &CGEvent| {
			posted.borrow_mut().push((
				pid,
				event.get_integer_value_field(FIELD_TARGET_PID),
				event.get_integer_value_field(FIELD_WINDOW_NUMBER),
			));
			Ok(())
		};
		let hold = PointerEvent::Hold {
			x:        300.0,
			y:        200.0,
			button:   MouseButton::Middle,
			keys:     Vec::new(),
			duration: Duration::from_millis(1),
		};
		let drag = PointerEvent::Drag {
			path:      vec![(300.0, 200.0), (320.0, 220.0)],
			button:    MouseButton::Middle,
			modifiers: Modifiers::default(),
			keys:      Vec::new(),
		};
		for event in [hold, drag] {
			posted.borrow_mut().clear();
			let result = background_gesture(
				&source,
				7581,
				554,
				&window,
				event.clone(),
				EntryFront(Some(9)),
				(7592, 556),
				false,
				false,
				skylight::TargetVisit::none(),
				&post,
			);
			assert!(result.is_ok(), "{event:?}: {result:?}");
			let posted = posted.borrow();
			// The hover, the press and the release at least.
			assert!(posted.len() >= 3, "{event:?}: {posted:?}");
			assert!(posted.iter().all(|&sent| sent == (7592, 7592, 556)), "{event:?}: {posted:?}");
		}
	}

	#[test]
	fn a_background_left_click_stops_before_its_real_press_once_the_user_comes_forward() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		let window = DesktopWindow {
			id:      "554".into(),
			title:   String::new(),
			app:     "TextEdit".into(),
			pid:     Some(7581),
			x:       100,
			y:       100,
			width:   600,
			height:  400,
			focused: false,
		};
		// The user brings the panel's app forward while the primer runs.
		let front = std::cell::Cell::new(Some(9));
		let posted = std::cell::RefCell::new(Vec::new());
		let before_press =
			|| recheck_background(true, 7581, 554, || front.get(), || false, || Ok(()));
		let post = |_, event: &CGEvent| {
			let kind = event.get_type();
			if matches!(kind, CGEventType::LeftMouseUp) {
				front.set(Some(7581));
			}
			posted.borrow_mut().push(kind as u32);
			Ok(())
		};
		let result = background_left_click(
			&source,
			7592,
			556,
			&window,
			(300.0, 200.0, 1),
			CGEventFlags::CGEventFlagNull,
			before_press,
			post,
		);
		assert_eq!(result.unwrap_err().code, ErrorCode::UserIntervened);
		// The hover and the off-screen press and release went out; the real
		// press did not.
		let (moved, down, up) = (
			CGEventType::MouseMoved as u32,
			CGEventType::LeftMouseDown as u32,
			CGEventType::LeftMouseUp as u32,
		);
		assert_eq!(*posted.borrow(), [moved, down, up]);
	}

	#[test]
	fn background_keys_continue_while_the_focus_that_proved_them_holds() {
		let (id, unreported) = (ax::FocusedWindow::Id, ax::FocusedWindow::Unreported);
		let siblings = Some(KeyboardConflict::Siblings(1));
		let still = |wid, conflict, proven, now, parent_of: fn(u32) -> Option<u32>| {
			keys_still_reach(1, wid, || conflict, proven, || now, parent_of).is_ok()
		};
		// Reminders reports the window under its details popover 25579 as
		// focused while the popover takes the keys.
		let popover = |id| (id == 25579).then_some(25567);
		let in_popover = focus_in(id(25567), Some(25579));
		assert!(still(25579, siblings, in_popover, in_popover, popover));
		assert!(still(25579, siblings, in_popover, focus_in(id(25579), Some(25579)), popover));
		assert!(!still(25579, siblings, in_popover, focus_in(id(25600), Some(25600)), popover));
		// Finder reports no focused window while its rename field has focus.
		let rename = |id| (id == 12).then_some(7);
		let renaming = focus_in(unreported, Some(12));
		assert!(still(7, siblings, renaming, renaming, rename));
		assert!(!still(7, siblings, renaming, focus_in(id(9), Some(9)), rename));
		// Focus moving within the window, or into an overlay on it, still
		// reaches it while the application reports it focused.
		let window = focus_in(id(7), Some(7));
		assert!(still(7, siblings, window, focus_in(id(7), Some(12)), rename));
		assert!(!still(7, siblings, window, focus_in(unreported, None), rename));
		assert!(!still(7, siblings, window, focus_in(ax::FocusedWindow::Unmapped, None), rename));
		// A lone window: one opened during the input stops it once key.
		assert!(!still(7, None, window, focus_in(id(9), Some(9)), rename));
		assert!(still(7, None, window, focus_in(unreported, None), rename));
	}

	#[test]
	fn a_window_the_app_opens_while_it_reports_no_focus_stops_the_keys() {
		// Window 7 was the app's only window and it reported no focused window
		// when the keys began; during a long type() it opens window 9 and still
		// reports none, so 9 may be taking the keys.
		let unreported = focus_in(ax::FocusedWindow::Unreported, None);
		let read = std::cell::Cell::new(false);
		let now = || {
			read.set(true);
			Some(KeyboardConflict::Siblings(1))
		};
		assert!(keys_still_reach(1, 7, now, unreported, || unreported, |_| None).is_err());
		assert!(read.get(), "the window set is read again");
		// While the app reports window 7 itself, the window set proves nothing.
		let window = focus_in(ax::FocusedWindow::Id(7), Some(7));
		let unread = || -> Option<KeyboardConflict> { panic!("the window set is not read") };
		assert!(keys_still_reach(1, 7, unread, window, || window, |_| None).is_ok());
	}

	#[test]
	fn a_background_left_click_reads_its_owner_once_the_window_is_key() {
		use crate::desktop::error::ErrorCode;
		// A system Open panel, window 554 of TextEdit (pid 7581), is drawn by
		// openAndSavePanelService (pid 7592) in its window 556, which that
		// process reports focused only once the click made the panel key.
		let key = std::cell::Cell::new(false);
		let owner = || {
			let content = ax::WindowContent::Remote { pid: 7592, window: 556 };
			input_owner(7581, 554, content, |_| key.get().then_some(556))
		};
		let prepare = || {
			key.set(true);
			Ok(true)
		};
		let click = PointerEvent::Click {
			x:         10.0,
			y:         10.0,
			button:    MouseButton::Left,
			count:     1,
			modifiers: Modifiers::default(),
		};
		assert_eq!(pointer_owner(&click, prepare, owner).unwrap(), (true, (7592, 556)));
		// A scroll never makes the window key, so it is not prepared: on a panel
		// that is not key it refuses instead of going to TextEdit, which would
		// drop it.
		key.set(false);
		let scroll = PointerEvent::Scroll { x: 10.0, y: 10.0, dx: 0.0, dy: 3.0 };
		let owned = pointer_owner(&scroll, || panic!("a scroll must not make its window key"), owner);
		assert_eq!(owned.unwrap_err().code, ErrorCode::BackgroundUnavailable);
	}

	#[test]
	fn empty_text_is_done_without_an_insertion_or_keys() {
		// An element addressed in takeover tries the insertion too, so every
		// mode and addressing must skip it for empty text.
		for mode in [DeliveryMode::Background, DeliveryMode::Foreground] {
			for addressed in [true, false] {
				let done = inserts_first(mode, addressed, "", || {
					panic!("an empty AXSelectedText write deletes the field's selection")
				});
				assert!(
					done.unwrap(),
					"{mode:?} addressed={addressed}: empty text must be done without keys"
				);
			}
		}
		// Other text tries the insertion, and keys follow only when it was not
		// attempted.
		assert!(inserts_first(DeliveryMode::Background, false, "x", || Ok(true)).unwrap());
		assert!(!inserts_first(DeliveryMode::Background, false, "x", || Ok(false)).unwrap());
	}

	#[test]
	fn keys_for_a_system_panel_activate_the_process_that_draws_it() {
		// TextEdit (7581) shows a Save sheet that openAndSavePanelService (7592)
		// draws in its window 556: Return presses the sheet's Save button only
		// once that process believes it is active.
		let mut activated = Vec::new();
		activate_owner(7581, (7592, 556), |owner| {
			activated.push(owner);
			Ok(())
		})
		.unwrap();
		assert_eq!(activated, [(7592, 556)]);
		activate_owner(7581, (7581, 554), |_| panic!("the target was activated already")).unwrap();
	}

	/// Time since element keys started, advanced by the test's waits and
	/// reads.
	struct FocusClock(std::cell::Cell<Duration>);

	impl FocusClock {
		fn new() -> Self {
			Self(std::cell::Cell::new(Duration::ZERO))
		}

		fn advance(&self, by: Duration) {
			self.0.set(self.0.get() + by);
		}

		fn remaining(&self) -> Option<Duration> {
			ELEMENT_FOCUS_TIMEOUT
				.checked_sub(self.0.get())
				.filter(|left| !left.is_zero())
		}
	}

	#[test]
	fn element_keys_wait_until_the_element_reports_focus() {
		let source = source().expect("event source");
		let clock = FocusClock::new();
		let mut bounds = Vec::new();
		let mut pressed = 0;
		let delivery = keys_after_focus(
			|| Ok(()),
			|| clock.remaining(),
			|left| {
				bounds.push(left);
				bounds.len() == 3
			},
			|left| {
				clock.advance(ELEMENT_FOCUS_POLL.min(left));
				Ok(())
			},
			|| panic!("a focused element needs no fresh read"),
			|| {
				type_keys(
					&source,
					&unicode_keys("ab"),
					Duration::ZERO,
					|| Ok(()),
					|event| {
						pressed += usize::from(matches!(event.get_type(), CGEventType::KeyDown));
						Ok(())
					},
				)
			},
		);
		assert!(matches!(delivery, Ok(ElementDelivery::Delivered)));
		// Each read may take only the time left.
		let ms = Duration::from_millis;
		assert_eq!(bounds, [ms(250), ms(240), ms(230)]);
		assert_eq!(pressed, 2);
	}

	#[test]
	fn focus_is_confirmed_once_so_an_auto_advancing_code_input_fills() {
		let source = source().expect("event source");
		let clock = FocusClock::new();
		let focused_box = std::cell::Cell::new(0);
		let reads = std::cell::Cell::new(0);
		let mut boxes = Vec::new();
		let delivery = keys_after_focus(
			|| Ok(()),
			|| clock.remaining(),
			|_| {
				reads.set(reads.get() + 1);
				focused_box.get() == 0
			},
			|_| panic!("the first box has focus at once"),
			|| panic!("the first box took focus"),
			|| {
				type_keys(
					&source,
					&unicode_keys("123456"),
					Duration::ZERO,
					|| Ok(()),
					|event| {
						match event.get_type() {
							CGEventType::KeyDown => boxes.push(focused_box.get()),
							// Each box hands focus to the next once its digit lands.
							CGEventType::KeyUp => focused_box.set(focused_box.get() + 1),
							_ => {},
						}
						Ok(())
					},
				)
			},
		);
		assert!(matches!(delivery, Ok(ElementDelivery::Delivered)));
		assert_eq!(boxes, [0, 1, 2, 3, 4, 5]);
		assert_eq!(reads.get(), 1);
	}

	#[test]
	fn element_keys_are_never_sent_while_the_element_lacks_focus() {
		let clock = FocusClock::new();
		let polls = std::cell::Cell::new(0);
		let delivery = keys_after_focus(
			|| Ok(()),
			|| clock.remaining(),
			|_| false,
			|left| {
				polls.set(polls.get() + 1);
				clock.advance(ELEMENT_FOCUS_POLL.min(left));
				Ok(())
			},
			|| KeyboardFocus { window: Some("9".to_owned()), element: None },
			|| panic!("nothing is sent to an element without focus"),
		);
		let Ok(ElementDelivery::Unfocused(focus)) = delivery else {
			panic!("an element that never took focus is refused");
		};
		assert_eq!(focus.window.as_deref(), Some("9"));
		assert_eq!(polls.get(), 25);
		// Cancelling the wait stops it with nothing sent either.
		let cancelled = keys_after_focus(
			|| Ok(()),
			|| Some(ELEMENT_FOCUS_TIMEOUT),
			|_| false,
			|_| Err(DesktopError::cancelled("cancelled")),
			|| panic!("a cancelled wait reads nothing"),
			|| panic!("nothing is sent once the wait is cancelled"),
		);
		assert!(matches!(cancelled, Err(error) if error.code == ErrorCode::Cancelled));
	}

	#[test]
	fn focus_reported_only_after_the_deadline_sends_nothing() {
		let refused = |elapsed_before_read: u64, read_takes: u64| {
			let clock = FocusClock::new();
			clock.advance(Duration::from_millis(elapsed_before_read));
			let fresh_reads = std::cell::Cell::new(0);
			let sent = std::cell::Cell::new(false);
			let delivery = keys_after_focus(
				|| Ok(()),
				|| clock.remaining(),
				|_| {
					clock.advance(Duration::from_millis(read_takes));
					true
				},
				|_| panic!("the first read answers"),
				|| {
					fresh_reads.set(fresh_reads.get() + 1);
					KeyboardFocus::default()
				},
				|| {
					sent.set(true);
					Ok(())
				},
			);
			let unfocused = matches!(delivery, Ok(ElementDelivery::Unfocused(_)));
			assert_eq!(fresh_reads.get(), usize::from(unfocused));
			assert_eq!(sent.get(), !unfocused);
			unfocused
		};
		// A read that answers yes after the deadline is no confirmation.
		assert!(refused(200, 60));
		assert!(refused(0, 250));
		// One that answers in time is, however close to the deadline.
		assert!(!refused(249, 0));
		assert!(!refused(200, 49));
		// So does a deadline that passed before the first read.
		assert!(refused(250, 0));
	}

	#[test]
	fn a_refused_focus_setter_still_ends_in_the_focus_read() {
		let reads = std::cell::Cell::new(0);
		let delivery = keys_after_focus(
			|| Err(DesktopError::ax_failed("setting AXFocused=true failed")),
			|| (reads.get() < 3).then_some(ELEMENT_FOCUS_TIMEOUT),
			|_| {
				reads.set(reads.get() + 1);
				false
			},
			|_| Ok(()),
			|| KeyboardFocus { window: Some("9".to_owned()), element: None },
			|| panic!("nothing is sent to an element without focus"),
		);
		let Ok(ElementDelivery::Unfocused(focus)) = delivery else {
			panic!("a refused setter ends in the refusal naming where focus is");
		};
		assert_eq!(focus.window.as_deref(), Some("9"));
		assert_eq!(reads.get(), 3);
		// A destroyed element is a stale ref at once.
		let gone = keys_after_focus(
			|| Err(DesktopError::stale_ref("the element no longer exists")),
			|| panic!("a destroyed element is not waited for"),
			|_| panic!("a destroyed element is not read"),
			|_| panic!("a destroyed element is not waited for"),
			|| panic!("a destroyed element needs no focus read"),
			|| panic!("nothing is sent to a destroyed element"),
		);
		assert!(matches!(gone, Err(error) if error.code == ErrorCode::StaleRef));
	}

	#[test]
	fn element_text_tries_insertion_in_every_mode_and_window_text_only_in_background() {
		let tried = |mode, addressed| {
			let called = std::cell::Cell::new(false);
			let inserted = inserts_first(mode, addressed, "x", || {
				called.set(true);
				Ok(true)
			})
			.unwrap();
			assert_eq!(inserted, called.get());
			called.get()
		};
		assert!(tried(DeliveryMode::Background, true));
		assert!(tried(DeliveryMode::Foreground, true));
		assert!(tried(DeliveryMode::Background, false));
		// Takeover `win.type` keys whatever the window has focused.
		assert!(!tried(DeliveryMode::Foreground, false));
		// A write that was attempted never falls through to keys.
		let failed = inserts_first(DeliveryMode::Foreground, true, "x", || {
			Err(DesktopError::ax_failed("delivery may be partial"))
		});
		assert!(failed.is_err());
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

	fn frame(id: u32, x: i32, y: i32, width: u32, height: u32) -> DesktopWindow {
		DesktopWindow {
			id: id.to_string(),
			title: String::new(),
			app: "Calendar".to_string(),
			pid: Some(7),
			x,
			y,
			width,
			height,
			focused: false,
		}
	}

	#[test]
	fn pointer_input_inside_a_popover_or_sheet_goes_to_that_window() {
		// Calendar's event popover 25579 is attached to window 25567, and a
		// second popover 25590 to it; panel 25600 is attached to nothing.
		let parents = |id| match id {
			25579 => Some(25567),
			25590 => Some(25579),
			_ => None,
		};
		let windows = [
			frame(25590, 1350, 500, 50, 50),
			frame(25579, 1200, 200, 326, 400),
			frame(25600, 0, 0, 100, 100),
			frame(25567, 0, 0, 1400, 900),
		];
		let at = |wid, point| attached_at(wid, point, &windows, parents).map(|w| w.id.as_str());
		// The Repeat popup's centre inside the popover, which reports window
		// 25567 as its AXWindow, and a point in the nested popover.
		assert_eq!(at(25567, (1300.0, 330.0)), Some("25579"));
		assert_eq!(at(25567, (1370.0, 520.0)), Some("25590"));
		assert_eq!(at(25579, (1370.0, 520.0)), Some("25590"));
		// The window itself, a window on top that is not attached to it, and a
		// point outside every window keep the target.
		assert_eq!(at(25567, (700.0, 600.0)), None);
		assert_eq!(at(25579, (1300.0, 330.0)), None);
		assert_eq!(at(25567, (50.0, 50.0)), None);
		assert_eq!(at(25567, (3000.0, 50.0)), None);
	}

	#[test]
	fn a_click_into_an_overlay_on_the_focused_window_skips_the_activating_press() {
		// Calendar reports window 25567 as focused while its popover 25579 is
		// open; Automator reports its Save sheet 25670 itself as focused.
		let parents = |id| match id {
			25579 => Some(25567),
			25670 => Some(25656),
			_ => None,
		};
		let window = |id| focus_in(ax::FocusedWindow::Id(id), Some(id));
		assert!(takes_overlay_focus(25579, window(25567), parents));
		assert!(takes_overlay_focus(25670, window(25670), parents));
		// A top-level window, and an overlay on a window that is not focused,
		// are made key with the press as before.
		assert!(!takes_overlay_focus(25567, window(25567), parents));
		assert!(!takes_overlay_focus(25579, window(25656), parents));
		let nothing = focus_in(ax::FocusedWindow::Unreported, None);
		assert!(!takes_overlay_focus(25579, nothing, parents));
	}

	#[test]
	fn a_click_into_finders_rename_field_skips_the_activating_press() {
		// Finder reports no focused window while its rename field, overlay 12
		// on window 7, has focus: the press would commit the rename before the
		// click reaches the field.
		let rename = |id| (id == 12).then_some(7);
		let renaming = focus_in(ax::FocusedWindow::Unreported, Some(12));
		assert!(takes_overlay_focus(12, renaming, rename));
		// A click into the window under it still makes that window key.
		assert!(!takes_overlay_focus(7, renaming, rename));
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
		assert_eq!(key_process(7581, 554, &open, drawn(556), |_| Some(556)).unwrap(), (7592, 556));
		// Its Go to Folder sheet 561: the path field maps to no window, so the
		// ascent ends at the sheet, and the service draws it in window 559.
		let go_to = focus(561, 561, false);
		assert_eq!(key_process(7581, 561, &go_to, drawn(559), |_| Some(559)).unwrap(), (7592, 559));
		// While the service reports focus in another window, nothing is sent.
		let error = key_process(7581, 554, &open, drawn(556), |_| Some(559))
			.expect_err("keys the service would not take must refuse");
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable);
		assert!(error.message.contains("process 7592"));
		// A window drawn by its own process keeps the keys.
		let own = key_process(7581, 554, &open, || ax::WindowContent::Own, unasked);
		assert_eq!(own.unwrap(), (7581, 554));
		// A focused element in the window itself, or Finder's rename overlay
		// while Finder reports no focused window, never reads the content.
		let element = key_process(7581, 543, &focus(543, 543, true), unread, unasked);
		assert_eq!(element.unwrap(), (7581, 543));
		let rename = ax::KeyFocus {
			window:         ax::FocusedWindow::Unreported,
			element_window: Some(41743),
			element_mapped: true,
		};
		assert_eq!(key_process(7, 41732, &rename, unread, unasked).unwrap(), (7, 41732));
	}

	#[test]
	fn background_keys_for_a_system_panel_stop_once_its_service_focuses_another_window() {
		use crate::desktop::error::ErrorCode;
		let source = source().expect("event source");
		// Keys for TextEdit's Open panel 554 go to openAndSavePanelService
		// (pid 7592), focused in its window 556; after a, another service
		// window becomes key.
		let focused = std::cell::Cell::new(Some(556));
		let guard = || owner_still_focused(7581, 554, (7592, 556), |_| focused.get());
		let mut typed = Vec::new();
		let keys = unicode_keys("ab");
		let result = type_keys(&source, &keys, Duration::ZERO, guard, |event| {
			if matches!(event.get_type(), CGEventType::KeyUp) {
				focused.set(Some(570));
			}
			typed.push(event.get_type() as u32);
			Ok(())
		});
		assert_eq!(result.unwrap_err().code, ErrorCode::InputFailed);
		let (down, up) = (CGEventType::KeyDown as u32, CGEventType::KeyUp as u32);
		assert_eq!(typed, [down, up]);
		// Keys the window's own process takes need no such check.
		let unasked = |_| -> Option<u32> { panic!("no other process is involved") };
		assert!(owner_still_focused(7581, 543, (7581, 543), unasked).is_ok());
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
	fn a_chord_waits_its_gap_after_every_release() {
		// iPhone Mirroring samples HID report state: a release and the next
		// transition inside one interval merge, so a press of a right after
		// this chord's a goes up would be lost.
		let source = source().expect("Quartz event source");
		let gap = Duration::from_millis(30);
		let mut posted = Vec::new();
		let chord = [KeyPress { name: KeyName::Shift, code: 56 }, KeyPress {
			name: KeyName::Char('a'),
			code: 0,
		}];
		press_chord(&source, &chord, gap, |_| {
			posted.push(Instant::now());
			Ok(())
		})
		.unwrap();
		let returned = Instant::now();
		assert_eq!(posted.len(), 4);
		for pair in posted.windows(2) {
			assert!(pair[1].duration_since(pair[0]) >= gap);
		}
		assert!(returned.duration_since(posted[3]) >= gap);
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
	fn repeated_clicks_that_can_open_a_context_menu_are_refused_before_anything_is_sent() {
		// The menu the first click opens would hold the user's keyboard while
		// the later clicks wait their gaps.
		let window = background_window("Google Chrome");
		let click = |button, count, ctrl| PointerEvent::Click {
			x: 10.0,
			y: 10.0,
			button,
			count,
			modifiers: Modifiers { ctrl, ..Modifiers::default() },
		};
		let verdict = |event: &PointerEvent| {
			refuse_pointer(&window, event, || false, || false).map_err(|error| error.code.as_str())
		};
		assert_eq!(verdict(&click(MouseButton::Right, 2, false)), Err("BackgroundUnavailable"));
		assert_eq!(verdict(&click(MouseButton::Left, 50, true)), Err("BackgroundUnavailable"));
		assert_eq!(verdict(&click(MouseButton::Right, 1, false)), Ok(()));
		assert_eq!(verdict(&click(MouseButton::Left, 1, true)), Ok(()));
		assert_eq!(verdict(&click(MouseButton::Left, 3, false)), Ok(()));
		assert_eq!(verdict(&click(MouseButton::Middle, 2, true)), Ok(()));
	}

	#[test]
	fn held_keys_without_a_key_code_refuse_before_the_target_is_prepared() {
		// `parse_keys` accepts "é", which has no macOS key code; the press
		// preparation would already have made the target's window key.
		let window = background_window("Google Chrome");
		let verdict = |event: &PointerEvent| {
			refuse_pointer(&window, event, || false, || false).map_err(|error| error.code.as_str())
		};
		let drag = |keys| PointerEvent::Drag {
			path: vec![(10.0, 10.0), (90.0, 40.0)],
			button: MouseButton::Left,
			modifiers: Modifiers::default(),
			keys,
		};
		let hold = |keys| PointerEvent::Hold {
			x: 10.0,
			y: 10.0,
			button: MouseButton::Left,
			keys,
			duration: Duration::from_secs(1),
		};
		assert_eq!(verdict(&drag(vec![KeyName::Char('é')])), Err("InvalidKey"));
		assert_eq!(verdict(&hold(vec![KeyName::Shift, KeyName::Char('é')])), Err("InvalidKey"));
		assert_eq!(verdict(&drag(vec![KeyName::Shift])), Ok(()));
		assert_eq!(verdict(&hold(vec![KeyName::Char('a')])), Ok(()));
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
		let before = control::uptime_ns();
		route_window_pointer(7, 42, &window, &event, 10.0, 10.0, 1, 0, 1).expect("route");
		// SAFETY: `event` is a live CGEvent.
		let stamped = unsafe { get_event_timestamp(event.as_ptr()) };
		let after = control::uptime_ns();
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
	fn left_clicks_holds_and_drags_press_where_a_control_could_open_its_menu() {
		let drag = |button| PointerEvent::Drag {
			path: vec![(3.0, 4.0), (9.0, 9.0)],
			button,
			modifiers: Modifiers::default(),
			keys: Vec::new(),
		};
		let hold = |button| PointerEvent::Hold {
			x: 5.0,
			y: 6.0,
			button,
			keys: Vec::new(),
			duration: Duration::from_secs(1),
		};
		let click = |button| PointerEvent::Click {
			x: 1.0,
			y: 2.0,
			button,
			count: 1,
			modifiers: Modifiers::default(),
		};
		assert_eq!(left_press(&click(MouseButton::Left)), Some((1.0, 2.0)));
		// A hold or drag that starts on a popup opens its menu as a click does.
		assert_eq!(left_press(&hold(MouseButton::Left)), Some((5.0, 6.0)));
		assert_eq!(left_press(&drag(MouseButton::Left)), Some((3.0, 4.0)));
		for event in [
			click(MouseButton::Right),
			hold(MouseButton::Middle),
			drag(MouseButton::Right),
			PointerEvent::Scroll { x: 1.0, y: 1.0, dx: 0.0, dy: 5.0 },
			PointerEvent::Move { x: 1.0, y: 1.0 },
		] {
			assert_eq!(left_press(&event), None, "{event:?}");
		}
	}

	#[test]
	fn a_hold_drag_or_multi_click_on_a_menu_control_refuses_before_it_is_posted() {
		let window = background_window("TextEdit");
		let left = |count| PointerEvent::Click {
			x: 1.0,
			y: 2.0,
			button: MouseButton::Left,
			count,
			modifiers: Modifiers::default(),
		};
		let hold = PointerEvent::Hold {
			x:        5.0,
			y:        6.0,
			button:   MouseButton::Left,
			keys:     Vec::new(),
			duration: Duration::from_secs(100),
		};
		let drag = PointerEvent::Drag {
			path:      vec![(3.0, 4.0), (9.0, 9.0)],
			button:    MouseButton::Left,
			modifiers: Modifiers::default(),
			keys:      Vec::new(),
		};
		// The popup's menu would take the user's keyboard from the first press
		// until the whole gesture ends.
		for event in [hold.clone(), drag.clone(), left(2)] {
			let error = menu_watch(&window, &event, true, false, || true).expect_err("refused");
			assert_eq!(error.code.as_str(), "BackgroundUnavailable", "{event:?}");
			assert!(
				error
					.message
					.contains("with the item's path as the menu option"),
				"{}",
				error.message
			);
		}
		// One click opens the menu and waits for it, as does one with a path.
		assert_eq!(
			menu_watch(&window, &left(1), true, false, || true).expect("click"),
			Some(ax::open_menu::CONTROL_MENU_TIMEOUT)
		);
		assert_eq!(
			menu_watch(&window, &left(1), true, true, || false).expect("click"),
			Some(ax::open_menu::CONTROL_MENU_TIMEOUT)
		);
		// Elsewhere the gestures run, watching for no menu.
		for event in [hold, drag, left(2)] {
			assert_eq!(
				menu_watch(&window, &event, true, false, || false).expect("off a control"),
				None
			);
		}
		let right = PointerEvent::Click {
			x:         1.0,
			y:         2.0,
			button:    MouseButton::Right,
			count:     1,
			modifiers: Modifiers::default(),
		};
		assert_eq!(
			menu_watch(&window, &right, true, false, || panic!("a secondary press is not hit-tested"))
				.expect("right-click"),
			Some(ax::open_menu::CONTEXT_MENU_TIMEOUT)
		);
		// A frontmost app's context menu stays open for the next call, as the
		// user's would, unless the click names an item to choose.
		let unasked = || panic!("a secondary press is not hit-tested");
		assert_eq!(menu_watch(&window, &right, false, false, unasked).expect("front"), None);
		assert_eq!(
			menu_watch(&window, &right, false, true, unasked).expect("front with menu"),
			Some(ax::open_menu::CONTEXT_MENU_TIMEOUT)
		);
	}

	#[test]
	fn held_keys_need_the_proof_typing_needs_whatever_the_button() {
		let ready = |button, holds_keys, in_overlay, conflict: Option<KeyboardConflict>, proven| {
			let steps = std::cell::RefCell::new(Vec::new());
			let result = ready_press(
				42,
				button,
				holds_keys,
				in_overlay,
				|| conflict,
				|in_overlay| {
					steps
						.borrow_mut()
						.push(format!("make key, overlay {in_overlay}"));
					Ok(true)
				},
				|| {
					steps.borrow_mut().push("await key".to_string());
					Ok(())
				},
				|seen| {
					steps.borrow_mut().push(format!("prove keys {seen:?}"));
					if proven {
						Ok(())
					} else {
						Err(DesktopError::invalid_target("a sheet attached to window 42 has focus"))
					}
				},
				|| Ok(()),
			);
			(
				result
					.map(|proof| proof.is_some())
					.map_err(|error| error.code.as_str()),
				steps.into_inner(),
			)
		};
		let made = "make key, overlay false".to_string();
		// A right or middle press without keys needs no key window.
		assert_eq!(ready(MouseButton::Right, false, false, None, false), (Ok(false), Vec::new()));
		// A left press waits for the window to become key.
		assert_eq!(
			ready(MouseButton::Left, false, false, None, false),
			(Ok(false), vec![made.clone(), "await key".to_string()])
		);
		// In a sheet or popover holding the focus, only the activation goes out,
		// and a popover never becomes the focused window to wait for.
		assert_eq!(
			ready(MouseButton::Left, false, true, None, false),
			(Ok(false), vec!["make key, overlay true".to_string()])
		);
		for button in [MouseButton::Left, MouseButton::Right, MouseButton::Middle] {
			// Held keys go only with the proof typing needs, even into an app
			// whose window list shows no other window: a focused sheet is left
			// out of that list and would take them.
			assert_eq!(
				ready(button, true, false, None, false),
				(Err("InvalidTarget"), vec![made.clone(), "prove keys None".to_string()])
			);
			let siblings = Some(KeyboardConflict::Siblings(1));
			assert_eq!(
				ready(button, true, false, siblings, true),
				(Ok(true), vec![made.clone(), "prove keys Some(Siblings(1))".to_string()])
			);
			assert_eq!(
				ready(button, true, false, Some(KeyboardConflict::Unmapped), true),
				(Err("BackgroundUnavailable"), Vec::new())
			);
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
				false,
				|| None,
				|_| Ok(prepared),
				|| {
					steps.borrow_mut().push("await key");
					Ok(())
				},
				|_| -> CoreResult<()> { panic!("no keys are held") },
				|| {
					steps.borrow_mut().push("still behind");
					Err(DesktopError::background_unavailable("came to the front"))
				},
			);
			(result.map(|_| ()).map_err(|error| error.code.as_str()), steps.into_inner())
		};
		// The user can bring the target forward while it becomes key; the press
		// would then switch the key window of the app they type into.
		assert_eq!(ready(true), (Err("BackgroundUnavailable"), vec!["await key", "still behind"]));
		// The target already was the frontmost key window: nothing to re-check.
		assert_eq!(ready(false), (Ok(()), vec!["await key"]));
	}

	#[test]
	fn a_held_key_refused_after_an_earlier_one_went_out_reports_partial_input() {
		let source = source().expect("event source");
		let downs = std::cell::Cell::new(0);
		let post = |_: Posted, _, event: &CGEvent| {
			if event.get_type() as u32 == CGEventType::KeyDown as u32 {
				downs.set(downs.get() + 1);
			}
			Ok(())
		};
		// The user brings the target forward after Space went down.
		let refused = || {
			if downs.get() == 0 {
				Ok(())
			} else {
				Err(DesktopError::background_unavailable(
					"window 42 of TextEdit: it came to the front during background input; nothing was \
					 sent",
				))
			}
		};
		let guarded = guarded_keys(&post, &refused);
		let window = background_window("TextEdit");
		let result = background_hold(
			&source,
			7,
			42,
			&window,
			CGPoint::new(10.0, 10.0),
			MouseButton::Left,
			&[KeyName::Space, KeyName::Tab],
			Duration::from_millis(1),
			&guarded,
		);
		assert_eq!(downs.get(), 1);
		let error = result.expect_err("refused");
		assert_eq!(error.code, ErrorCode::InputFailed);
		assert!(error.message.contains("may already have landed"), "{}", error.message);
	}

	#[test]
	fn a_held_key_is_pressed_only_while_its_check_passes() {
		let source = source().expect("event source");
		let posted = std::cell::RefCell::new(Vec::new());
		let post = |posted_as: Posted, _, event: &CGEvent| {
			posted
				.borrow_mut()
				.push((posted_as, event.get_type() as u32));
			Ok(())
		};
		// The user moved focus to a sheet after the gesture was readied.
		let refused = || Err(DesktopError::background_unavailable("focus moved to window 43"));
		let guarded = guarded_keys(&post, &refused);
		let window = background_window("TextEdit");
		let result = background_hold(
			&source,
			7,
			42,
			&window,
			CGPoint::new(10.0, 10.0),
			MouseButton::Left,
			&[KeyName::Space],
			Duration::from_millis(1),
			&guarded,
		);
		assert_eq!(result.expect_err("refused").code.as_str(), "BackgroundUnavailable");
		// Neither the key nor the press went out.
		assert!(
			posted
				.borrow()
				.iter()
				.all(|&(as_, kind)| as_ == Posted::Key && kind != CGEventType::KeyDown as u32),
			"{:?}",
			posted.borrow()
		);
	}

	#[test]
	fn a_drag_is_released_at_the_last_point_attempted_after_a_failed_post() {
		let path = [CGPoint::new(1.0, 1.0), CGPoint::new(5.0, 5.0), CGPoint::new(9.0, 9.0)];
		let run = |fail_on: Option<(Stroke, f64)>| {
			let mut posted = Vec::new();
			let result = stroke_path(
				&path,
				|| false,
				|stroke, at| {
					posted.push((stroke, at.x));
					if fail_on == Some((stroke, at.x)) {
						Err(DesktopError::input_failed("delivery may be partial"))
					} else {
						Ok(())
					}
				},
			);
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
	fn a_drag_cancelled_after_its_last_point_reports_the_delivered_stroke() {
		let cancellation = control::CancellationSource::default();
		let token = cancellation.token();
		let path = [CGPoint::new(1.0, 1.0), CGPoint::new(9.0, 9.0)];
		let mut posted = Vec::new();
		// The user stops the agent once every point is out: the release still
		// goes, so the drag landed and must not report `Cancelled`.
		let result = control::with_token_for_test(&token, || {
			stroke_path(
				&path,
				|| false,
				|stroke, at| {
					posted.push((stroke, at.x));
					if stroke == Stroke::Dragged {
						cancellation.cancel();
					}
					Ok(())
				},
			)
		});
		use Stroke::{Down, Dragged, Up};
		assert_eq!(posted, [(Down, 1.0), (Dragged, 9.0), (Up, 9.0)]);
		assert!(!result.expect("the stroke was delivered"));
	}

	#[test]
	fn background_drags_and_holds_run_only_on_controls_that_track_them() {
		let window = background_window("Finder");
		let drag = |button| PointerEvent::Drag {
			path: vec![(3.0, 4.0), (90.0, 40.0)],
			button,
			modifiers: Modifiers::default(),
			keys: Vec::new(),
		};
		let hold = |button| PointerEvent::Hold {
			x: 5.0,
			y: 6.0,
			button,
			keys: Vec::new(),
			duration: Duration::from_secs(1),
		};
		for event in [drag(MouseButton::Left), hold(MouseButton::Left)] {
			// Finder's icons and rows, a table cell, and anything unread can
			// begin a drag-and-drop session.
			for role in [Some("AXImage"), Some("AXRow"), Some("AXCell"), Some("AXWebArea"), None] {
				let error = refuse_drag_source(&window, &event, |_, _| role.map(str::to_string))
					.expect_err("refused before posting");
				assert_eq!(error.code.as_str(), "BackgroundUnavailable", "{role:?}");
				assert!(error.message.contains("nothing was sent"), "{}", error.message);
				assert!(!error.message.contains("takeover"), "{}", error.message);
			}
			for role in DRAG_TRACKING_ROLES {
				refuse_drag_source(&window, &event, |_, _| Some(role.to_string())).expect(role);
			}
		}
		// The point read is where the press goes down.
		let mut at = None;
		let _ = refuse_drag_source(&window, &drag(MouseButton::Left), |x, y| {
			at = Some((x, y));
			None
		});
		assert_eq!(at, Some((3.0, 4.0)));
		// Other gestures pay no hit-test.
		let unread = |_, _| -> Option<String> { panic!("not hit-tested") };
		refuse_drag_source(&window, &drag(MouseButton::Middle), unread).expect("middle drag");
		refuse_drag_source(&window, &hold(MouseButton::Middle), unread).expect("middle hold");
		let click = PointerEvent::Click {
			x:         1.0,
			y:         1.0,
			button:    MouseButton::Left,
			count:     1,
			modifiers: Modifiers::default(),
		};
		refuse_drag_source(&window, &click, unread).expect("click");
	}

	#[test]
	fn a_drag_that_picks_up_an_item_goes_back_to_its_start_and_is_released_there() {
		use Stroke::{Down, Dragged, Up};
		let path = [
			CGPoint::new(1.0, 1.0),
			CGPoint::new(5.0, 5.0),
			CGPoint::new(9.0, 9.0),
			CGPoint::new(13.0, 13.0),
		];
		// The source begins a drag-and-drop session while it handles the move
		// to 5: carried on, the item would drop wherever the user's pointer is.
		let checks = std::cell::Cell::new(0);
		let picked_up = || {
			checks.set(checks.get() + 1);
			checks.get() > 1
		};
		let mut posted = Vec::new();
		let session = stroke_path(&path, picked_up, |stroke, at| {
			posted.push((stroke, at.x));
			Ok(())
		});
		assert!(session.expect("stroked"));
		assert_eq!(posted, [(Down, 1.0), (Dragged, 5.0), (Dragged, 1.0), (Up, 1.0)]);
		let error = picked_up_refusal(&background_window("Finder"));
		assert_eq!(error.code.as_str(), "InputFailed");
		assert!(error.message.contains("released there"), "{}", error.message);
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
		let (user, target) = (EntryFront(Some(9)), EntryFront(Some(7)));
		assert_eq!(front_target(user, Some(9), 7, 42, unread), FrontTarget::Background);
		assert_eq!(front_target(user, None, 7, 42, unread), FrontTarget::Unknown);
		assert_eq!(front_target(target, Some(7), 7, 42, || Some(42)), FrontTarget::Key);
		assert_eq!(front_target(target, Some(7), 7, 42, || Some(43)), FrontTarget::UserSibling);
		assert_eq!(front_target(target, Some(7), 7, 42, || None), FrontTarget::UserSibling);
	}

	#[test]
	fn a_target_brought_forward_before_its_key_window_step_refuses_even_as_key() {
		// The user brought the background target forward and picked its window:
		// delivering now would type into the window they just selected.
		assert_eq!(
			front_target(EntryFront(Some(9)), Some(7), 7, 42, || Some(42)),
			FrontTarget::CameForward
		);
		assert_eq!(
			front_target(EntryFront(None), Some(7), 7, 42, || Some(42)),
			FrontTarget::CameForward
		);
	}

	#[test]
	fn a_target_picked_while_its_probes_block_refuses_as_come_forward() {
		// The user brings the target (7) forward while an accessibility probe
		// of it blocks: the input began with their app (9) in front.
		let front = std::cell::Cell::new(9);
		let (entry, ()) = EntryFront::before(
			|| Some(front.get()),
			|| {
				front.set(7);
				Ok(())
			},
		)
		.unwrap();
		assert_eq!(entry, EntryFront(Some(9)));
		assert_eq!(front_target(entry, Some(7), 7, 42, || Some(42)), FrontTarget::CameForward);
	}

	#[test]
	fn a_pointer_event_that_never_made_its_window_key_refuses_once_the_user_came_to_it() {
		use crate::desktop::error::ErrorCode;
		let user = EntryFront(Some(9));
		let target = (7, 42, "TextEdit");
		// A right click, move or scroll (never prepared) while the user (9)
		// brought the target (7) forward during its owner lookup.
		let error = pointer_recheck((false, false), user, target, || Some(7), || false).unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(
			error
				.message
				.contains("window 42 of TextEdit: it came to the front")
		);
		assert!(error.message.contains("; nothing was sent;"), "{}", error.message);
		// The user came to the target and left again.
		assert!(pointer_recheck((false, false), user, target, || Some(9), || true).is_err());
		// Still behind the user, or the user's own front app from the start.
		pointer_recheck((false, false), user, target, || Some(9), || false).unwrap();
		pointer_recheck((false, false), EntryFront(Some(7)), target, || Some(7), || false).unwrap();
		// A left click that made the window key refuses once the front process
		// cannot be read; its primer and key-making press were already posted.
		let error = pointer_recheck((true, true), user, target, || None, || false).unwrap_err();
		assert!(error.message.contains("could not be identified"));
		assert!(error.message.contains("no further input was sent"), "{}", error.message);
	}

	#[test]
	fn a_pointer_event_refuses_when_the_front_process_cannot_be_read() {
		// A right click, move or scroll was never prepared, but an unknown front
		// process may be the target the user just picked, as on the left-click
		// path.
		let error = pointer_recheck(
			(false, false),
			EntryFront(Some(9)),
			(7, 42, "TextEdit"),
			|| None,
			|| false,
		);
		assert_eq!(error.unwrap_err().code, crate::desktop::error::ErrorCode::BackgroundUnavailable);
	}

	#[test]
	fn iphone_mirroring_taps_and_scrolls_stop_as_user_intervened_once_brought_forward() {
		use crate::desktop::error::ErrorCode;
		let (down, up) = (CGEventType::LeftMouseDown as u32, CGEventType::LeftMouseUp as u32);
		// The user (9) brings iPhone Mirroring (7) forward after the first tap
		// of a double tap: the second press would land in the window they took.
		// The user stepped into the target, so the stop is `UserIntervened`,
		// which computer.backgroundFallback never reruns in takeover.
		let front = std::cell::Cell::new(9);
		let before_post = || {
			pointer_recheck(
				(false, false),
				EntryFront(Some(9)),
				(7, 42, "iPhone Mirroring"),
				|| Some(front.get()),
				|| false,
			)
		};
		let posted = std::cell::RefCell::new(Vec::new());
		let error = report_taps(2, before_post, |event_type, click_state| {
			posted.borrow_mut().push((event_type as u32, click_state));
			if event_type as u32 == up {
				front.set(7);
			}
			Ok(())
		})
		.unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert_eq!(*posted.borrow(), [(down, 1), (up, 1)]);
		// A scroll checks before its aiming release and again before it scrolls.
		front.set(9);
		let scrolled = std::cell::Cell::new(false);
		let aim = || {
			front.set(7);
			Ok(())
		};
		let scroll = || {
			scrolled.set(true);
			Ok(())
		};
		let error = report_scroll(before_post, aim, scroll).unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(!scrolled.get(), "nothing scrolls once the user has the target");
		let aimed = std::cell::Cell::new(false);
		let aim = || {
			aimed.set(true);
			Ok(())
		};
		let error = report_scroll(before_post, aim, || Ok(())).unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		assert!(!aimed.get(), "no aiming release once the user has the target");
	}

	#[test]
	fn a_native_text_write_refuses_once_its_app_came_forward() {
		use crate::desktop::error::ErrorCode;
		// The user (app 9) brought the target (7) forward while the write's
		// probes blocked: the text would land in the field they took over.
		let error = EntryFront(Some(9))
			.require_behind(Some(7), 7, 42)
			.unwrap_err();
		assert_eq!(error.code, ErrorCode::UserIntervened);
		// Still behind the user, or already the user's own app: the write goes.
		EntryFront(Some(9)).require_behind(Some(9), 7, 42).unwrap();
		EntryFront(Some(7)).require_behind(Some(7), 7, 42).unwrap();
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
		// An application already active: the activation changes nothing
		// observable, so delivery follows at once.
		activate_then_await(Some(true), ACTIVE_STATE_TIMEOUT, || Ok(()), unread, no_wait)
			.expect("activation");
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
