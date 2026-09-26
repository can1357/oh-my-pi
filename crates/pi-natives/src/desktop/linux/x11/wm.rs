//! Window-manager and window-tree queries shared by the X11 input routes:
//! EWMH activation with a real server timestamp, background focus observation,
//! occlusion checks for real pointer input, and popup detection.

use std::{
	thread,
	time::{Duration, Instant},
};

use x11rb::{
	COPY_DEPTH_FROM_PARENT, NONE,
	connection::Connection,
	protocol::{
		Event,
		xproto::{
			Atom, AtomEnum, ClientMessageEvent, ConnectionExt as _, CreateWindowAux, EventMask,
			InputFocus, MapState, PropMode, Window, WindowClass,
		},
	},
	rust_connection::RustConnection,
};

use crate::desktop::error::{CoreResult, DesktopError};

/// Bound on ancestor/descendant walks.
const TREE_WALK_LIMIT: usize = 32;
/// How long a background action is watched for a late focus change (the WM
/// processes click-to-focus asynchronously).
const FOCUS_SETTLE_WATCH: Duration = Duration::from_millis(150);
const FOCUS_POLL: Duration = Duration::from_millis(25);

pub(super) struct Atoms {
	pub net_active_window:   Atom,
	pub net_wm_pid:          Atom,
	pub net_wm_name:         Atom,
	pub net_wm_window_type:  Atom,
	pub utf8_string:         Atom,
	pub wm_state:            Atom,
	pub time_probe:          Atom,
	/// `_NET_WM_WINDOW_TYPE`s of override-redirect windows that hold no grab.
	pub passive_popup_types: [Atom; 3],
}

impl Atoms {
	pub(super) fn intern(conn: &RustConnection) -> CoreResult<Self> {
		const NAMES: [&str; 10] = [
			"_NET_ACTIVE_WINDOW",
			"_NET_WM_PID",
			"_NET_WM_NAME",
			"_NET_WM_WINDOW_TYPE",
			"UTF8_STRING",
			"WM_STATE",
			"_OMP_TIME_PROBE",
			"_NET_WM_WINDOW_TYPE_TOOLTIP",
			"_NET_WM_WINDOW_TYPE_NOTIFICATION",
			"_NET_WM_WINDOW_TYPE_DND",
		];
		let cookies = NAMES
			.iter()
			.map(|name| conn.intern_atom(false, name.as_bytes()))
			.collect::<Result<Vec<_>, _>>()
			.map_err(wm_failed)?;
		let atoms = cookies
			.into_iter()
			.map(|cookie| cookie.reply().map(|reply| reply.atom))
			.collect::<Result<Vec<_>, _>>()
			.map_err(wm_failed)?;
		Ok(Self {
			net_active_window:   atoms[0],
			net_wm_pid:          atoms[1],
			net_wm_name:         atoms[2],
			net_wm_window_type:  atoms[3],
			utf8_string:         atoms[4],
			wm_state:            atoms[5],
			time_probe:          atoms[6],
			passive_popup_types: [atoms[7], atoms[8], atoms[9]],
		})
	}
}

fn wm_failed(error: impl std::fmt::Display) -> DesktopError {
	DesktopError::input_failed(format!("X11 window query failed: {error}"))
}

/// Window-manager view of the X session: one connection, its root, atoms.
#[derive(Clone, Copy)]
pub(super) struct Wm<'a> {
	pub conn:  &'a RustConnection,
	pub root:  Window,
	pub atoms: &'a Atoms,
}

impl Wm<'_> {
	fn property32(&self, window: Window, property: Atom, type_: impl Into<Atom>) -> Option<u32> {
		self
			.conn
			.get_property(false, window, property, type_, 0, 1)
			.ok()?
			.reply()
			.ok()?
			.value32()?
			.next()
	}

	/// `_NET_ACTIVE_WINDOW`, `None` when unset or zero.
	pub(super) fn active_window(&self) -> Option<Window> {
		self
			.property32(self.root, self.atoms.net_active_window, AtomEnum::WINDOW)
			.filter(|&window| window != NONE)
	}

	/// Whether an EWMH window manager publishes `_NET_ACTIVE_WINDOW` at all.
	pub(super) fn tracks_active_window(&self) -> bool {
		self
			.conn
			.get_property(false, self.root, self.atoms.net_active_window, AtomEnum::ANY, 0, 0)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.is_some_and(|reply| reply.type_ != NONE)
	}

	/// Core keyboard focus and its revert mode.
	pub(super) fn input_focus(&self) -> Option<(Window, InputFocus)> {
		let reply = self.conn.get_input_focus().ok()?.reply().ok()?;
		Some((reply.focus, reply.revert_to))
	}

	fn parent(&self, window: Window) -> Option<Window> {
		let reply = self.conn.query_tree(window).ok()?.reply().ok()?;
		(reply.parent != NONE && reply.parent != window).then_some(reply.parent)
	}

	fn children(&self, window: Window) -> Vec<Window> {
		self
			.conn
			.query_tree(window)
			.ok()
			.and_then(|cookie| cookie.reply().ok())
			.map(|reply| reply.children)
			.unwrap_or_default()
	}

	/// Whether `window` is `target` or one of its descendants.
	pub(super) fn is_within(&self, window: Window, target: Window) -> bool {
		let mut current = window;
		for _ in 0..TREE_WALK_LIMIT {
			if current == target {
				return true;
			}
			if current == NONE || current == self.root {
				return false;
			}
			match self.parent(current) {
				Some(parent) => current = parent,
				None => return false,
			}
		}
		false
	}

	/// The root child containing `window`: its WM frame, or the window itself
	/// when unmanaged.
	fn root_child_of(&self, window: Window) -> Option<Window> {
		let mut current = window;
		for _ in 0..TREE_WALK_LIMIT {
			let parent = self.parent(current)?;
			if parent == self.root {
				return Some(current);
			}
			current = parent;
		}
		None
	}

	/// The mapped root child under a screen point (input shapes honoured).
	fn root_child_at(&self, x: i16, y: i16) -> Option<Window> {
		let reply = self
			.conn
			.translate_coordinates(self.root, self.root, x, y)
			.ok()?
			.reply()
			.ok()?;
		(reply.child != NONE).then_some(reply.child)
	}

	/// The ICCCM client window inside a root child (a WM frame nests it one
	/// or two levels deep); the root child itself when it is a client.
	fn client_of(&self, frame: Window) -> Option<Window> {
		let mut level = vec![frame];
		for _ in 0..3 {
			if let Some(&client) = level.iter().find(|&&window| {
				self
					.property32(window, self.atoms.wm_state, AtomEnum::ANY)
					.is_some()
			}) {
				return Some(client);
			}
			level = level
				.iter()
				.flat_map(|&window| self.children(window))
				.collect();
			if level.is_empty() {
				break;
			}
		}
		None
	}

	pub(super) fn window_pid(&self, window: Window) -> Option<u32> {
		self
			.property32(window, self.atoms.net_wm_pid, AtomEnum::CARDINAL)
			.filter(|&pid| pid != 0)
	}

	/// `_NET_WM_PID` of `window` or its nearest ancestor carrying one.
	pub(super) fn owning_pid(&self, window: Window) -> Option<u32> {
		let mut current = window;
		for _ in 0..TREE_WALK_LIMIT {
			if current == NONE || current == self.root {
				return None;
			}
			if let Some(pid) = self.window_pid(current) {
				return Some(pid);
			}
			current = self.parent(current)?;
		}
		None
	}

	/// `_NET_WM_PID` of a root child or the client window inside it.
	fn root_child_pid(&self, child: Window) -> Option<u32> {
		self.window_pid(child).or_else(|| {
			self
				.client_of(child)
				.and_then(|client| self.window_pid(client))
		})
	}

	fn title(&self, window: Window) -> String {
		let read = |property: Atom, type_: Atom| {
			self
				.conn
				.get_property(false, window, property, type_, 0, 256)
				.ok()?
				.reply()
				.ok()
				.filter(|reply| !reply.value.is_empty())
				.map(|reply| String::from_utf8_lossy(&reply.value).into_owned())
		};
		read(self.atoms.net_wm_name, self.atoms.utf8_string)
			.or_else(|| read(AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()))
			.unwrap_or_default()
	}

	/// Current X server time via the `PropertyNotify` round trip. Activation
	/// requests stamped `CurrentTime` lose to focus-stealing prevention
	/// whenever newer user input exists. Falls back to `CurrentTime` (0).
	fn server_time(&self) -> u32 {
		let Ok(probe) = self.conn.generate_id() else {
			return x11rb::CURRENT_TIME;
		};
		let aux = CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE);
		let created = self.conn.create_window(
			COPY_DEPTH_FROM_PARENT,
			probe,
			self.root,
			-1,
			-1,
			1,
			1,
			0,
			WindowClass::INPUT_ONLY,
			0,
			&aux,
		);
		if created.is_err() {
			return x11rb::CURRENT_TIME;
		}
		let _ = self.conn.change_property(
			PropMode::REPLACE,
			probe,
			self.atoms.time_probe,
			AtomEnum::STRING,
			8,
			1,
			&[0],
		);
		let _ = self.conn.flush();
		let deadline = Instant::now() + Duration::from_millis(300);
		let mut time = x11rb::CURRENT_TIME;
		while Instant::now() < deadline {
			match self.conn.poll_for_event() {
				Ok(Some(Event::PropertyNotify(event))) if event.window == probe => {
					time = event.time;
					break;
				},
				Ok(Some(_)) => {},
				Ok(None) => thread::sleep(Duration::from_millis(2)),
				Err(_) => break,
			}
		}
		let _ = self.conn.destroy_window(probe);
		let _ = self.conn.flush();
		time
	}

	/// Ask the WM to activate `window` (EWMH, source = pager, real timestamp)
	/// and set the core focus as well: WMs with focus-stealing prevention may
	/// treat `_NET_ACTIVE_WINDOW` as raise-only.
	pub(super) fn request_activation(
		&self,
		window: Window,
		current: Option<Window>,
	) -> CoreResult<()> {
		let time = self.server_time();
		let event = ClientMessageEvent::new(32, window, self.atoms.net_active_window, [
			2,
			time,
			current.unwrap_or(NONE),
			0,
			0,
		]);
		self
			.conn
			.send_event(
				false,
				self.root,
				EventMask::SUBSTRUCTURE_REDIRECT | EventMask::SUBSTRUCTURE_NOTIFY,
				event,
			)
			.map_err(wm_failed)?
			.check()
			.map_err(wm_failed)?;
		// BadMatch on a not-yet-viewable window is expected; callers confirm.
		if let Ok(cookie) = self.conn.set_input_focus(InputFocus::PARENT, window, time) {
			let _ = cookie.check();
		}
		self.conn.flush().map_err(wm_failed)
	}

	/// Whether `window` is the active window (when an EWMH WM tracks one) and
	/// holds the core focus.
	pub(super) fn is_focused(&self, window: Window, ewmh: bool) -> bool {
		(!ewmh || self.active_window() == Some(window))
			&& self
				.input_focus()
				.is_some_and(|(focus, _)| self.is_within(focus, window))
	}

	/// Refuses a real (position-routed) pointer event at screen point `(x, y)`
	/// unless it would land on `window`. Another window of the same process
	/// and an unowned override-redirect popup are not the requested target.
	pub(super) fn check_pointer_target(&self, window: Window, x: i16, y: i16) -> CoreResult<()> {
		let attributes = self.conn.get_window_attributes(window)
			.map_err(wm_failed)?.reply().map_err(wm_failed)?;
		if attributes.map_state != MapState::VIEWABLE {
			return Err(DesktopError::background_unavailable(format!(
				"window {window} is not viewable; use ax actions or takeover:true"
			)));
		}
		let geometry = self
			.conn
			.get_geometry(window)
			.map_err(wm_failed)?
			.reply()
			.map_err(|_| DesktopError::window_not_found(format!("X11 window {window} is gone")))?;
		let origin = self
			.conn
			.translate_coordinates(window, self.root, 0, 0)
			.map_err(wm_failed)?
			.reply()
			.map_err(wm_failed)?;
		let (left, top) = (i32::from(origin.dst_x), i32::from(origin.dst_y));
		let (px, py) = (i32::from(x), i32::from(y));
		if px < left
			|| py < top
			|| px >= left + i32::from(geometry.width)
			|| py >= top + i32::from(geometry.height)
		{
			return Err(DesktopError::invalid_coordinate_frame(format!(
				"screen point ({x}, {y}) lies outside window {window} (x={left}, y={top}, {}x{}); no \
				 input was sent",
				geometry.width, geometry.height
			)));
		}
		let under = self.root_child_at(x, y).ok_or_else(|| {
			DesktopError::background_unavailable(format!(
				"no input window covers ({x}, {y}); use ax actions or takeover:true"
			))
		})?;
		let frame = self.root_child_of(window).ok_or_else(|| {
			DesktopError::background_unavailable(format!(
				"window {window} is not mapped on this screen; retry with takeover:true or use ax \
				 actions"
			))
		})?;
		if under == frame {
			return Ok(());
		}
		let covering_pid = self.root_child_pid(under);
		let client = self.client_of(under).unwrap_or(under);
		let title = self.title(client);
		Err(DesktopError::background_unavailable(format!(
			"window {window}: screen point ({x}, {y}) is covered by window {client}{}{}, so a real \
			 pointer event would land there; no input was sent; retry with takeover:true or use ax \
			 actions",
			if title.is_empty() {
				String::new()
			} else {
				format!(" \"{title}\"")
			},
			covering_pid.map_or_else(String::new, |pid| format!(" (pid {pid})")),
		)))
	}

	/// A mapped popup is evidence that input may be grabbed, not proof of
	/// who owns the grab. Never use this heuristic to authorize core input.
	pub(super) fn grab_popup_of(&self, pid: u32) -> Option<Window> {
		self.children(self.root).into_iter().rev().find(|&child| {
			let Some(attributes) = self
				.conn
				.get_window_attributes(child)
				.ok()
				.and_then(|cookie| cookie.reply().ok())
			else {
				return false;
			};
			attributes.override_redirect
				&& attributes.map_state == MapState::VIEWABLE
				&& self.root_child_pid(child) == Some(pid)
				&& !self.is_passive_popup(child)
		})
	}

	fn is_passive_popup(&self, window: Window) -> bool {
		let types = self
			.conn
			.get_property(false, window, self.atoms.net_wm_window_type, AtomEnum::ATOM, 0, 8)
			.ok()
			.and_then(|cookie| cookie.reply().ok());
		types
			.as_ref()
			.and_then(|reply| reply.value32())
			.is_some_and(|mut atoms| atoms.any(|atom| self.atoms.passive_popup_types.contains(&atom)))
	}
}

/// The user's focus state before a background action.
pub(super) struct FocusSnapshot {
	active: Option<Window>,
	focus:  Window,
}

impl FocusSnapshot {
	pub(super) fn capture(wm: Wm<'_>) -> Self {
		let focus = wm.input_focus().map_or(NONE, |(focus, _)| focus);
		Self { active: wm.active_window(), focus }
	}

	fn changed(&self, wm: Wm<'_>) -> bool {
		wm.active_window() != self.active
			|| wm.input_focus().map(|(focus, _)| focus) != Some(self.focus)
	}

	/// Observe only. Re-activation can raise windows, and the old "focus
	/// bounce" deliberately sent the user's keystrokes to the target for
	/// 60ms. Neither belongs in a background operation. An unrelated focus
	/// change is the user's, not permission to undo it.
	pub(super) fn check(&self, wm: Wm<'_>, target: Window) -> CoreResult<()> {
		let watch_until = Instant::now() + FOCUS_SETTLE_WATCH;
		loop {
			if self.changed(wm) {
				let moved_to_target = (self.active != Some(target) && wm.active_window() == Some(target))
					|| (!wm.is_within(self.focus, target)
						&& wm.input_focus().is_some_and(|(focus, _)| wm.is_within(focus, target)));
				return if moved_to_target {
					Err(DesktopError::input_failed(format!(
						"window {target} changed the desktop focus during background input; the action \
						 may already have landed, so do not retry blindly; use ax actions or \
						 takeover:true for subsequent input"
					)))
				} else {
					Ok(())
				};
			}
			if Instant::now() >= watch_until {
				return Ok(());
			}
			thread::sleep(FOCUS_POLL);
		}
	}
}
