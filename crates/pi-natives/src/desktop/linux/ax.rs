use std::{collections::HashMap, time::Duration};

use atspi::{
	CoordType, Layer, ObjectRefOwned, Role, State, StateSet,
	proxy::{
		accessible::{AccessibleProxy, ObjectRefExt},
		bus::BusProxy,
	},
	zbus::{self, Connection, names::UniqueName, proxy::CacheProperties},
};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, WalkBounds, masks, normalize_role_atspi, text_readback},
	backend::AxBackend,
	control::cancellable,
	error::{CoreResult, DesktopError, ErrorCode},
	types::DesktopWindow,
};

mod menus;

/// How long an application gets to answer before it counts as not answering:
/// one request reads one element (about a dozen calls) or walks a short chain
/// of its parents or children, and a read of a whole application or menu
/// bounds each call instead. libatspi gives each call 800 ms; a text edit in
/// an office suite can take 2 s.
///
/// at-spi2-core's ATK bridge (GTK 3 apps) replies to `DoAction` before it runs
/// the action inside its D-Bus dispatch, so an action that opens a modal
/// dialog leaves the app answering no request until that dialog closes.
const REPLY_TIMEOUT: Duration = Duration::from_secs(5);
/// Most windows [`AtSpiAx::windows`] lists.
const MAX_WINDOWS: usize = 48;

pub struct AtSpiAx {
	rt:            Runtime,
	connection:    Connection,
	/// [`REPLY_TIMEOUT`] outside tests.
	reply_timeout: Duration,
	/// The display server's own list of windows, where it knows where each one
	/// is (X11).
	native:        Option<Box<dyn NativeWindows>>,
	frames:        FrameCache,
}

/// A native top-level window's geometry as the display server reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativeGeometry {
	pub x:      i32,
	pub y:      i32,
	pub width:  u32,
	pub height: u32,
	/// The shadow a client-side-decorated window draws inside its own surface
	/// (`_GTK_FRAME_EXTENTS`): left, right, top, bottom.
	pub shadow: [u32; 4],
}

/// Where the display server put each top-level window.
///
/// GTK4 answers `CoordType::Screen` with `0,0` for every element, on X11 as
/// on Wayland, while its `CoordType::Window` extents are right. Where the
/// display server knows the window's position, an element's screen position
/// is its window position plus that.
pub(crate) trait NativeWindows: Send + Sync {
	fn windows(&self) -> CoreResult<Vec<DesktopWindow>>;
	/// The current geometry of native window `id`; `None` once it is gone or
	/// off screen (unmapped, minimized).
	fn geometry(&self, id: &str) -> Option<NativeGeometry>;
}

/// What a tree walk learns about frames, kept from one `window_root` to the
/// next so the walk looks each up once.
#[derive(Default)]
struct FrameCache {
	/// Each element's top-level frame; `None` inside a popup, whose window
	/// extents GTK4 before 4.18 measures from the widget it hangs off rather
	/// than from where it is drawn.
	frame_of:  HashMap<ObjectRefOwned, Option<ObjectRefOwned>>,
	/// Whether each frame's toolkit answers screen coordinates with window
	/// ones (GTK4).
	unplaced:  HashMap<ObjectRefOwned, bool>,
	/// Each frame's native window id, once one matched.
	native_of: HashMap<ObjectRefOwned, String>,
	/// Each frame's window geometry as one operation read it; `None` when no
	/// window shows the frame. Cleared by [`Self::refresh`].
	geometry:  HashMap<ObjectRefOwned, Option<NativeGeometry>>,
}

/// Where a frame whose screen position its toolkit cannot report sits on
/// screen: the origin of its window coordinates and its size.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Placement {
	x:      i32,
	y:      i32,
	width:  i32,
	height: i32,
}

impl Placement {
	fn contains(self, x: i32, y: i32) -> bool {
		x >= self.x
			&& y >= self.y
			&& i64::from(x) < i64::from(self.x) + i64::from(self.width)
			&& i64::from(y) < i64::from(self.y) + i64::from(self.height)
	}
}

/// Where a frame of `frame_width` x `frame_height` in native window `native`
/// starts on screen: at the window's origin when the frame fills it, inside
/// the client-side shadow when the frame fills what the shadow leaves. `None`
/// when the size fits neither, so the frame's place in the window is unknown.
fn placement(frame_width: i32, frame_height: i32, native: &NativeGeometry) -> Option<Placement> {
	let [left, right, top, bottom] = native.shadow.map(i64::from);
	let (width, height) = (i64::from(native.width), i64::from(native.height));
	let (frame_width_64, frame_height_64) = (i64::from(frame_width), i64::from(frame_height));
	let (x, y) = if (frame_width_64, frame_height_64) == (width, height) {
		(0, 0)
	} else if (frame_width_64, frame_height_64) == (width - left - right, height - top - bottom) {
		(left, top)
	} else {
		return None;
	};
	Some(Placement {
		x:      i32::try_from(i64::from(native.x) + x).ok()?,
		y:      i32::try_from(i64::from(native.y) + y).ok()?,
		width:  frame_width,
		height: frame_height,
	})
}

/// Whether the user can operate an element. GTK4 marks an enabled control
/// only `Sensitive`, which AT-SPI allows for a control the user can operate;
/// toolkits drop both states from a greyed-out one.
fn state_enabled(states: StateSet) -> bool {
	states.contains(State::Enabled) || states.contains(State::Sensitive)
}

fn unanswered(who: &str, within: Duration) -> DesktopError {
	DesktopError::timeout(format!(
		"AT-SPI: {who} did not answer within {} s. An app answers no accessibility request while it \
		 is busy, and a GTK 3 app none while a modal dialog that an accessibility action (press, \
		 menu select) opened is up; use screenshots and pointer or key input until it answers again",
		within.as_secs_f64()
	))
}

/// The error for a lookup that missed what an application that did not answer
/// [`AtSpiAx::windows`] holds.
pub(crate) fn not_answering() -> DesktopError {
	unanswered("the application", REPLY_TIMEOUT)
}

/// `error`, saying that an action or value the application did not confirm
/// may still take effect.
fn unconfirmed(mut error: DesktopError) -> DesktopError {
	if error.code == ErrorCode::Timeout {
		error
			.message
			.push_str(". What was sent to it may still take effect when it answers");
	}
	error
}

/// `future`, or [`unanswered`] once it has waited `within`.
async fn answered<T>(
	who: &str,
	within: Duration,
	future: impl Future<Output = T>,
) -> CoreResult<T> {
	tokio::time::timeout(within, future)
		.await
		.map_err(|_| unanswered(who, within))
}

/// The windows of the applications that answered, and the bus names of those
/// that did not.
pub struct AtSpiWindows {
	pub windows:    Vec<AtSpiWindow>,
	pub unanswered: Vec<String>,
}

/// An AT-SPI top-level frame and whether its reported screen position is real.
///
/// Native Wayland clients cannot learn where the compositor placed them, so
/// their toolkits answer `CoordType::Screen` with window-relative coordinates
/// (usually `0,0`). Consumers that map `window` bounds onto a desktop capture
/// (the Wayland window crop) must refuse when `position_known` is false.
pub struct AtSpiWindow {
	pub window:         DesktopWindow,
	/// Screen and window-relative origins differ, so `window.x`/`window.y` are
	/// global compositor coordinates. False also covers a window genuinely at
	/// the global origin, which is indistinguishable over AT-SPI.
	pub position_known: bool,
}

/// Leaves `focused` set on at most one window. Shell surfaces report the
/// Active state at all times: the compositor's own frames (gnome-shell's "Main
/// stage") and untitled frames (plasma-keyboard's). When several windows are
/// active, the compositor's frames drop out first, then untitled ones, until
/// one is left; a shell frame alone keeps focus, as in the GNOME overview. When
/// only untitled frames are left (an untitled app beside plasma-keyboard), the
/// one that `holds_focus` (contains the keyboard-focused element) wins. Two
/// active titled application windows leave none focused, rather than naming
/// one at random.
/// If an application did not answer, a shell or untitled candidate needs
/// positive keyboard focus: Active alone may merely outlive the skipped app.
pub fn resolve_focus(
	windows: &mut [AtSpiWindow],
	compositor_pid: Option<u32>,
	unanswered: bool,
	mut holds_focus: impl FnMut(&DesktopWindow) -> bool,
) {
	let mut active: Vec<usize> = (0..windows.len())
		.filter(|&index| windows[index].window.focused)
		.collect();
	if active.len() < 2 && !unanswered {
		return;
	}
	let all_active = active.clone();
	if active.len() > 1 && compositor_pid.is_some() {
		active.retain(|&index| windows[index].window.pid != compositor_pid);
	}
	let mut focus_checked = false;
	if active.len() > 1 {
		let titled: Vec<usize> = active
			.iter()
			.copied()
			.filter(|&index| !windows[index].window.title.trim().is_empty())
			.collect();
		active = if titled.is_empty() {
			focus_checked = true;
			active
				.into_iter()
				.filter(|&index| holds_focus(&windows[index].window))
				.collect()
		} else {
			titled
		};
	}
	let focused = match active.as_slice() {
		[only] => {
			let window = &windows[*only].window;
			let shell_candidate = window.title.trim().is_empty()
				|| compositor_pid.is_some_and(|pid| window.pid == Some(pid));
			(!unanswered || !shell_candidate || focus_checked || holds_focus(window)).then_some(*only)
		},
		_ => None,
	};
	for index in all_active {
		windows[index].window.focused = Some(index) == focused;
	}
}

impl AtSpiAx {
	pub(crate) fn new() -> CoreResult<Self> {
		let rt = Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI runtime: {err}")))?;
		// Not `AccessibilityConnection::new`: it also asks every application for
		// a peer-to-peer address, so one application that does not answer
		// would hang every new session and menu command.
		let connection = rt
			.block_on(async {
				let session = Connection::session().await?;
				let address = BusProxy::new(&session).await?.get_address().await?;
				atspi::zbus::connection::Builder::address(address.as_str())?
					.build()
					.await
			})
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI connection: {err}")))?;
		Ok(Self {
			rt,
			connection,
			reply_timeout: REPLY_TIMEOUT,
			native: None,
			frames: FrameCache::default(),
		})
	}

	/// Places elements of toolkits that cannot report screen positions by
	/// where `native` says their window is.
	pub(crate) fn with_native_windows(mut self, native: Box<dyn NativeWindows>) -> Self {
		self.native = Some(native);
		self
	}

	/// Runs `future` until it finishes or the current operation is cancelled,
	/// so a call no application answers never holds the desktop worker past
	/// the run that made it.
	fn run<T>(&self, future: impl Future<Output = T>) -> CoreResult<T> {
		self.rt.block_on(cancellable(future))
	}

	/// Single-element reads and mutations retain an operation budget.
	/// Application, focus, ownership and hit-test scans use per-call replies.
	fn request<T>(&self, future: impl Future<Output = CoreResult<T>>) -> CoreResult<T> {
		self.run(answered("the application", self.reply_timeout, future))??
	}

	/// One call to an application, bounded on its own: for reads of a whole
	/// application or menu, which can take longer than one reply may.
	async fn reply<T>(&self, call: impl Future<Output = T>) -> CoreResult<T> {
		answered("the application", self.reply_timeout, call).await
	}

	const fn object(h: &AxHandle) -> &ObjectRefOwned {
		match h {
			AxHandle::AtSpi(object) => object,
			#[cfg(test)]
			_ => panic!("AT-SPI backend received a non-AT-SPI handle"),
		}
	}

	pub(crate) fn windows(&self) -> CoreResult<AtSpiWindows> {
		self.run(async {
			let apps = Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?;
			// Every application is asked at once, so ones that do not answer
			// cost the listing one reply limit together, not one each, and are
			// left out rather than holding back every other application's.
			let answers =
				futures::future::join_all(apps.iter().map(|app| self.app_windows(app, MAX_WINDOWS)))
					.await;
			let mut listed = AtSpiWindows { windows: Vec::new(), unanswered: Vec::new() };
			for (app, answer) in apps.iter().zip(answers) {
				match answer {
					Ok(windows) => listed.windows.extend(windows),
					Err(error) if error.code == ErrorCode::Timeout => {
						listed
							.unanswered
							.extend(app.name().map(ToString::to_string));
					},
					Err(error) => return Err(error),
				}
			}
			listed.windows.truncate(MAX_WINDOWS);
			Ok(listed)
		})?
	}

	/// Whether the window's frame contains the keyboard-focused element. A
	/// lookup that fails counts as not holding focus.
	pub(crate) fn holds_focus(&self, window: &DesktopWindow) -> bool {
		self
			.run(async {
				let Ok(app) = self.app_for_window(window).await else {
					return false;
				};
				let Ok(frames) = Self::frames(&self.connection, &app, self.reply_timeout).await else {
					return false;
				};
				for frame in frames {
					if atspi_window_id(&frame) == window.id {
						return Self::find_focused(&self.connection, frame, 0, self.reply_timeout)
							.await
							.is_ok_and(|found| found.is_some());
					}
				}
				false
			})
			.unwrap_or(false)
	}

	async fn app_windows(&self, app: &ObjectRefOwned, limit: usize) -> CoreResult<Vec<AtSpiWindow>> {
		let mut windows = Vec::new();
		let app_proxy = self
			.reply(app.as_accessible_proxy(&self.connection))
			.await?
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI application: {err}")))?;
		let app_name = self.reply(app_proxy.name()).await?.unwrap_or_default();
		let pid = if let Some(bus_name) = app.name() {
			let dbus = self
				.reply(atspi::zbus::fdo::DBusProxy::new(&self.connection))
				.await?
				.ok();
			if let Some(dbus) = dbus {
				self
					.reply(dbus.get_connection_unix_process_id(bus_name.clone().into()))
					.await?
					.ok()
			} else {
				None
			}
		} else {
			None
		};
		let children = self
			.reply(app_proxy.get_children())
			.await?
			.unwrap_or_default();
		for frame in children {
			let frame_proxy = self
				.reply(frame.as_accessible_proxy(&self.connection))
				.await?
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame: {err}")))?;
			if !self
				.reply(frame_proxy.get_role())
				.await?
				.is_ok_and(|role| top_level_role(role, true))
			{
				continue;
			}
			let title = self.reply(frame_proxy.name()).await?.unwrap_or_default();
			let state = self.reply(frame_proxy.get_state()).await?.ok();
			let Ok(component) = self
				.reply(Self::component(&self.connection, &frame))
				.await?
			else {
				continue;
			};
			let Ok((x, y, width, height)) =
				self.reply(component.get_extents(CoordType::Screen)).await?
			else {
				continue;
			};
			if width < 16 || height < 16 {
				continue;
			}
			let position_known = self
				.reply(component.get_extents(CoordType::Window))
				.await?
				.is_ok_and(|(window_x, window_y, ..)| (window_x, window_y) != (x, y));
			let id = atspi_window_id(&frame);
			windows.push(AtSpiWindow {
				window: DesktopWindow {
					id,
					title,
					app: app_name.clone(),
					pid,
					x,
					y,
					width: width as u32,
					height: height as u32,
					focused: state.as_ref().is_some_and(|states| {
						states.contains(State::Focused) || states.contains(State::Active)
					}),
				},
				position_known,
			});
			if windows.len() == limit {
				break;
			}
		}
		Ok(windows)
	}

	async fn apps(connection: &Connection) -> Result<Vec<ObjectRefOwned>, String> {
		// The registry implements too little of the D-Bus properties interface
		// to cache its properties.
		let root = AccessibleProxy::builder(connection)
			.destination("org.a11y.atspi.Registry")
			.map_err(|err| err.to_string())?
			.cache_properties(CacheProperties::No)
			.build()
			.await
			.map_err(|err| err.to_string())?;
		root.get_children().await.map_err(|err| err.to_string())
	}

	async fn app_for_window(&self, win: &DesktopWindow) -> CoreResult<ObjectRefOwned> {
		let failed = |err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}"));
		let apps = Self::apps(&self.connection).await.map_err(failed)?;
		let mut matches = Vec::new();
		let mut unanswered_apps = false;
		for app in apps {
			if win.id.starts_with("atspi:") {
				if app
					.name()
					.is_some_and(|name| win.id.starts_with(&format!("atspi:{name}:")))
				{
					matches.push(app);
				}
				continue;
			}
			// The bus names an application's process without asking it.
			if let Some(pid) = win.pid {
				let Some(bus_name) = app.name() else {
					continue;
				};
				let dbus = self
					.reply(atspi::zbus::fdo::DBusProxy::new(&self.connection))
					.await?
					.map_err(|err| failed(err.to_string()))?;
				if self
					.reply(dbus.get_connection_unix_process_id(bus_name.clone().into()))
					.await?
					.ok()
					== Some(pid)
				{
					matches.push(app);
				}
				continue;
			}
			let proxy = self
				.reply(app.as_accessible_proxy(&self.connection))
				.await?
				.map_err(|err| failed(err.to_string()))?;
			match answered("the application", self.reply_timeout, proxy.name()).await {
				Ok(name)
					if name
						.as_deref()
						.unwrap_or_default()
						.eq_ignore_ascii_case(&win.app) =>
				{
					matches.push(app.clone());
				},
				Ok(_) => {},
				Err(_) => unanswered_apps = true,
			}
		}
		// Without a process, an application that did not answer may be the
		// named one, or another of that name.
		if unanswered_apps {
			return Err(unanswered("an application", self.reply_timeout));
		}
		if matches.len() == 1 {
			Ok(matches.remove(0))
		} else {
			Err(failed(format!(
				"application '{}' (pid {:?}) has {} AT-SPI matches; refusing ambiguous ownership",
				win.app,
				win.pid,
				matches.len()
			)))
		}
	}

	/// `app`'s children that are top-level windows. Each reply, not the
	/// traversal, gets a deadline.
	async fn frames(
		connection: &Connection,
		app: &ObjectRefOwned,
		reply_timeout: Duration,
	) -> CoreResult<Vec<ObjectRefOwned>> {
		let proxy = answered("the application", reply_timeout, app.as_accessible_proxy(connection))
			.await?
			.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
		let children = answered("the application", reply_timeout, proxy.get_children())
			.await?
			.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
		let mut frames = Vec::new();
		for child in children {
			let child_proxy =
				answered("the application", reply_timeout, child.as_accessible_proxy(connection))
					.await?
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
			if answered("the application", reply_timeout, child_proxy.get_role())
				.await?
				.is_ok_and(|role| top_level_role(role, true))
			{
				frames.push(child);
			}
		}
		Ok(frames)
	}

	async fn component<'a>(
		connection: &'a Connection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::component::ComponentProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::component::ComponentProxy::builder(connection)
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	/// `object`'s `Action` proxy, without zbus's property cache: the cache
	/// fills itself with `GetAll`, which Qt 5 crashes on and newer Qt refuses,
	/// so `NActions` is read with `Get`.
	async fn action<'a>(
		connection: &'a Connection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::action::ActionProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::action::ActionProxy::builder(connection)
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.cache_properties(atspi::zbus::proxy::CacheProperties::No)
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	/// The top-level window holding `object`. Follows ownership, never screen
	/// containment: overlapping windows and same-process dialogs are distinct
	/// input destinations.
	async fn top_level(
		connection: &Connection,
		mut object: ObjectRefOwned,
		reply_timeout: Duration,
	) -> CoreResult<ObjectRefOwned> {
		for _ in 0..64 {
			let proxy =
				answered("the application", reply_timeout, object.as_accessible_proxy(connection))
					.await?
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window owner: {err}")))?;
			let role = answered("the application", reply_timeout, proxy.get_role())
				.await?
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window role: {err}")))?;
			if top_level_role(role, false) {
				return Ok(object);
			}
			let parent = answered("the application", reply_timeout, proxy.parent())
				.await?
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window parent: {err}")))?;
			if top_level_role(role, true)
				&& Self::is_application(connection, &parent, reply_timeout).await?
			{
				return Ok(object);
			}
			if parent.is_null() || parent == object {
				break;
			}
			drop(proxy);
			object = parent;
		}
		Err(DesktopError::ax_failed("AT-SPI element has no identifiable top-level window"))
	}

	async fn is_application(
		connection: &Connection,
		object: &ObjectRefOwned,
		reply_timeout: Duration,
	) -> CoreResult<bool> {
		if object.is_null() {
			return Ok(false);
		}
		let Ok(proxy) =
			answered("the application", reply_timeout, object.as_accessible_proxy(connection)).await?
		else {
			return Ok(false);
		};
		Ok(answered("the application", reply_timeout, proxy.get_role())
			.await?
			.is_ok_and(|role| role == Role::Application))
	}

	/// Each call has its own reply timeout: reading a whole application can
	/// take longer than one reply may.
	async fn find_focused(
		connection: &Connection,
		root: ObjectRefOwned,
		depth: u8,
		reply_timeout: Duration,
	) -> CoreResult<Option<ObjectRefOwned>> {
		// Chromium/Electron frames report children that are the AT-SPI null
		// object.
		if depth > 40 || root.is_null() {
			return Ok(None);
		}
		let proxy = answered("the application", reply_timeout, root.as_accessible_proxy(connection))
			.await?
			.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
		if answered("the application", reply_timeout, proxy.get_state())
			.await?
			.is_ok_and(|state| state.contains(State::Focused))
		{
			return Ok(Some(root));
		}
		for child in answered("the application", reply_timeout, proxy.get_children())
			.await?
			.unwrap_or_default()
		{
			if let Some(found) =
				Box::pin(Self::find_focused(connection, child, depth + 1, reply_timeout)).await?
			{
				return Ok(Some(found));
			}
		}
		Ok(None)
	}

	/// An element's properties, with its bounds when `bounds` asks for them.
	fn read_props(&mut self, h: &AxHandle, bounds: WalkBounds) -> CoreResult<AxProps> {
		let object = Self::object(h).clone();
		let Self { rt, connection, native, frames, reply_timeout } = self;
		rt.block_on(cancellable(answered("the application", *reply_timeout, async {
			let proxy = object
				.as_accessible_proxy(connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI accessible: {err}")))?;
			let title = proxy.name().await.ok().filter(|s| !s.is_empty());
			let description = proxy.description().await.ok().filter(|s| !s.is_empty());
			let native_role = match proxy.get_role_name().await {
				Ok(role) => role,
				Err(_) => proxy
					.get_localized_role_name()
					.await
					.unwrap_or_else(|_| "unknown".to_string()),
			};
			let state = proxy.get_state().await.ok();
			let multiline = state
				.as_ref()
				.is_some_and(|states| states.contains(State::MultiLine));
			let value = text_value(&*connection, &object).await;
			let bounds = if bounds == WalkBounds::Read {
				frames
					.screen_bounds(connection, native.as_deref(), &object)
					.await
			} else {
				None
			};
			let actions = match Self::action(connection, &object).await {
				Ok(action) => action_names(&action).await.unwrap_or_default(),
				Err(_) => Vec::new(),
			};
			let child_count = proxy.child_count().await.unwrap_or(0).max(0) as u32;
			Ok(AxProps {
				role: normalize_role_atspi(&native_role, multiline),
				native_role,
				title,
				value,
				description,
				enabled: state.is_some_and(state_enabled),
				focused: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Focused)),
				bounds,
				actions,
				child_count,
				identity: None,
				partial: false,
				label_complete: false,
				selected: false,
				role_name: None,
			})
		})))??
	}

	/// The deepest element under `root` at screen point (`x`, `y`). A placed
	/// frame is hit-tested in its window coordinates.
	async fn descend(
		connection: &Connection,
		root: ObjectRefOwned,
		placement: Option<Placement>,
		x: i32,
		y: i32,
		reply_timeout: Duration,
	) -> CoreResult<Option<AxHandle>> {
		let (coords, x, y) = match placement {
			Some(placement) => {
				(CoordType::Window, x.saturating_sub(placement.x), y.saturating_sub(placement.y))
			},
			None => (CoordType::Screen, x, y),
		};
		let mut current = root;
		let mut ancestors = Vec::new();
		for _ in 0..64 {
			let has_component = {
				let accessible =
					answered("the application", reply_timeout, current.as_accessible_proxy(connection))
						.await?
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI hit-test element: {err}"))
						})?;
				answered("the application", reply_timeout, accessible.get_interfaces())
					.await?
					.map_err(|err| {
						DesktopError::ax_failed(format!("AT-SPI hit-test interfaces: {err}"))
					})?
					.contains(atspi::Interface::Component)
			};
			if !has_component {
				return Ok(Some(AxHandle::AtSpi(current)));
			}
			// GetAccessibleAtPoint returns an immediate child, not
			// necessarily the leaf that owns the requested pixel.
			let component =
				answered("the application", reply_timeout, Self::component(connection, &current))
					.await?
					.map_err(DesktopError::ax_failed)?;
			let child = answered(
				"the application",
				reply_timeout,
				component.get_accessible_at_point(x, y, coords),
			)
			.await?
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI element at point: {err}")))?;
			if child.is_null() || child == current {
				return Ok(Some(AxHandle::AtSpi(current)));
			}
			// GTK4 returns the deepest element from the frame, then offsets the
			// point twice below it and can name a child the point is not in.
			if placement.is_some() {
				let component =
					answered("the application", reply_timeout, Self::component(connection, &child))
						.await?
						.map_err(DesktopError::ax_failed)?;
				let inside =
					answered("the application", reply_timeout, component.get_extents(CoordType::Window))
						.await?
						.is_ok_and(|(left, top, width, height)| {
							Placement { x: left, y: top, width, height }.contains(x, y)
						});
				if !inside {
					return Ok(Some(AxHandle::AtSpi(current)));
				}
			}
			if ancestors.contains(&child) {
				return Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy contains a cycle"));
			}
			ancestors.push(current);
			current = child;
		}
		Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy exceeds the depth limit"))
	}
}

impl FrameCache {
	/// `object`'s bounds in screen coordinates. A toolkit that cannot place its
	/// windows (GTK4) reports every element at screen `0,0`; such an element is
	/// placed by its window extents and where `native` says its frame is, and
	/// is left as reported where `native` cannot say.
	async fn screen_bounds(
		&mut self,
		connection: &zbus::Connection,
		native: Option<&dyn NativeWindows>,
		object: &ObjectRefOwned,
	) -> Option<AxBounds> {
		let component = AtSpiAx::component(connection, object).await.ok()?;
		let (mut x, mut y, width, height) = component.get_extents(CoordType::Screen).await.ok()?;
		if width < 0 || height < 0 {
			return None;
		}
		if (x, y) == (0, 0)
			&& let Some(native) = native
			&& let Some(frame) = self.frame(connection, object).await
			&& let Some(placement) = self.placement(connection, native, &frame).await
			&& let Ok((window_x, window_y, ..)) = component.get_extents(CoordType::Window).await
		{
			x = placement.x.saturating_add(window_x);
			y = placement.y.saturating_add(window_y);
		}
		Some(AxBounds {
			x:      f64::from(x),
			y:      f64::from(y),
			width:  f64::from(width),
			height: f64::from(height),
		})
	}

	/// Whether `frame` holds screen point (`x`, `y`): `Some` with where it sits
	/// when its toolkit cannot place it, `Some(None)` when it reports screen
	/// positions itself. Such a frame `native` cannot place either (minimized,
	/// another workspace) holds no point.
	async fn claim(
		&mut self,
		connection: &zbus::Connection,
		native: Option<&dyn NativeWindows>,
		frame: &ObjectRefOwned,
		x: i32,
		y: i32,
	) -> CoreResult<Option<Option<Placement>>> {
		if let Some(native) = native
			&& self.unplaced(connection, frame).await
		{
			let placement = self.placement(connection, native, frame).await;
			return Ok(placement
				.filter(|placement| placement.contains(x, y))
				.map(Some));
		}
		let contains = AtSpiAx::component(connection, frame)
			.await
			.map_err(DesktopError::ax_failed)?
			.contains(x, y, CoordType::Screen)
			.await
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame hit test: {err}")))?;
		Ok(contains.then_some(None))
	}

	/// Where `frame` sits on screen, from its native window, when its toolkit
	/// cannot say; `None` when it can.
	async fn placement(
		&mut self,
		connection: &zbus::Connection,
		native: &dyn NativeWindows,
		frame: &ObjectRefOwned,
	) -> Option<Placement> {
		if !self.unplaced(connection, frame).await {
			return None;
		}
		let (.., width, height) = AtSpiAx::component(connection, frame)
			.await
			.ok()?
			.get_extents(CoordType::Window)
			.await
			.ok()?;
		let geometry = self.native_geometry(connection, native, frame).await?;
		placement(width, height, &geometry)
	}

	/// Whether `frame`'s toolkit answers screen coordinates with window ones.
	/// GTK4 puts its frames at screen `0,0` and answers `Contains` true even
	/// for a point above and left of them.
	async fn unplaced(&mut self, connection: &zbus::Connection, frame: &ObjectRefOwned) -> bool {
		if let Some(&unplaced) = self.unplaced.get(frame) {
			return unplaced;
		}
		let Ok(component) = AtSpiAx::component(connection, frame).await else {
			return false;
		};
		let unplaced = component
			.get_extents(CoordType::Screen)
			.await
			.is_ok_and(|(x, y, ..)| (x, y) == (0, 0))
			&& component
				.contains(-1, -1, CoordType::Screen)
				.await
				.unwrap_or(false);
		self.unplaced.insert(frame.clone(), unplaced);
		unplaced
	}

	/// The top-level frame holding `object`: its ancestor that is a child of the
	/// application, whatever its role. `None` inside a popup.
	async fn frame(
		&mut self,
		connection: &zbus::Connection,
		object: &ObjectRefOwned,
	) -> Option<ObjectRefOwned> {
		let mut chain: Vec<ObjectRefOwned> = Vec::new();
		// Index in `chain` of the outermost popup met so far.
		let mut popup = None;
		let mut current = object.clone();
		let frame = loop {
			if let Some(frame) = self.frame_of.get(&current) {
				break frame.clone();
			}
			if chain.len() == 64 {
				return None;
			}
			let proxy = current.as_accessible_proxy(connection).await.ok()?;
			if proxy.get_role().await.ok()? == Role::Application {
				break chain.last().cloned();
			}
			if let Ok(component) = AtSpiAx::component(connection, &current).await
				&& component
					.get_layer()
					.await
					.is_ok_and(|layer| layer == Layer::Popup)
			{
				popup = Some(chain.len());
			}
			let parent = proxy.parent().await.ok()?;
			if parent.is_null() || parent == current {
				return None;
			}
			drop(proxy);
			chain.push(std::mem::replace(&mut current, parent));
		};
		let outside_popup = |index: usize| popup.is_none_or(|popup| index > popup);
		let own = frame
			.clone()
			.filter(|_| chain.is_empty() || outside_popup(0));
		for (index, object) in chain.into_iter().enumerate() {
			self
				.frame_of
				.insert(object, frame.clone().filter(|_| outside_popup(index)));
		}
		own
	}

	/// Starts a new operation: windows are read again, so a moved window is
	/// seen and a frame whose window was hidden is matched again once shown.
	fn refresh(&mut self) {
		self.geometry.clear();
	}

	/// The geometry of the native window showing `frame`, read once per
	/// operation; its window is matched by process and title until it is gone.
	async fn native_geometry(
		&mut self,
		connection: &zbus::Connection,
		native: &dyn NativeWindows,
		frame: &ObjectRefOwned,
	) -> Option<NativeGeometry> {
		if let Some(&geometry) = self.geometry.get(frame) {
			return geometry;
		}
		let mut geometry = self.native_of.get(frame).and_then(|id| native.geometry(id));
		if geometry.is_none() {
			let id = native_window(connection, native, frame).await;
			geometry = id.as_deref().and_then(|id| native.geometry(id));
			match id.filter(|_| geometry.is_some()) {
				Some(id) => self.native_of.insert(frame.clone(), id),
				None => self.native_of.remove(frame),
			};
		}
		self.geometry.insert(frame.clone(), geometry);
		geometry
	}
}

/// The native window showing `frame`, the one window of its process with its
/// title.
async fn native_window(
	connection: &zbus::Connection,
	native: &dyn NativeWindows,
	frame: &ObjectRefOwned,
) -> Option<String> {
	let title = frame
		.as_accessible_proxy(connection)
		.await
		.ok()?
		.name()
		.await
		.ok()?;
	let pid = zbus::fdo::DBusProxy::new(connection)
		.await
		.ok()?
		.get_connection_unix_process_id(frame.name()?.clone().into())
		.await
		.ok()?;
	native_window_for_frame(&native.windows().ok()?, pid, &title).ok()
}

fn atspi_window_id(frame: &ObjectRefOwned) -> String {
	let name = frame.name().map_or_default(ToString::to_string);
	format!("atspi:{name}:{}", frame.path())
}

/// How long a numeric write's read-back waits for the value to arrive, for
/// a toolkit that applies the write a moment after answering it.
const VALUE_SETTLE: Duration = Duration::from_millis(500);

/// Sets an element's numeric value and reads it back: a toolkit clamps the
/// value to its range, rounds it to its steps or ignores it while answering
/// the write (Qt answers every `CurrentValue` write), so the call reports
/// what the element holds. The proxy keeps no property cache, whose
/// `GetAll` crashes Qt 6 before 6.9.2 (QTBUG-137344).
async fn write_value(
	connection: &atspi::zbus::Connection,
	name: &UniqueName<'static>,
	object: &ObjectRefOwned,
	value: f64,
) -> CoreResult<()> {
	let failed = |err: atspi::zbus::Error| DesktopError::ax_failed(format!("AT-SPI value: {err}"));
	let proxy = atspi::proxy::value::ValueProxy::builder(connection)
		.destination(name.clone())
		.and_then(|b| b.path(object.path().clone()))
		.map_err(failed)?
		.cache_properties(atspi::zbus::proxy::CacheProperties::No)
		.build()
		.await
		.map_err(failed)?;
	proxy.set_current_value(value).await.map_err(failed)?;
	let deadline = tokio::time::Instant::now() + VALUE_SETTLE;
	loop {
		let Ok(actual) = proxy.current_value().await else {
			return Err(DesktopError::ax_failed(format!(
				"wrote {value}, but the control's value could not be read back; inspect the target \
				 before writing again"
			)));
		};
		// Within float precision: a toolkit that stores the value as `float`
		// reads back 0.3 as 0.30000001192092896.
		if (actual - value).abs() <= value.abs().max(1.0) * f64::from(f32::EPSILON) {
			return Ok(());
		}
		if tokio::time::Instant::now() >= deadline {
			// The range only where it explains the value: an unbounded control
			// reports ±f64::MAX, hundreds of digits each.
			let range = match futures::join!(proxy.minimum_value(), proxy.maximum_value()) {
				(Ok(min), _) if value < min && min != -f64::MAX => {
					format!(" (its minimum is {min})")
				},
				(_, Ok(max)) if value > max && max != f64::MAX => {
					format!(" (its maximum is {max})")
				},
				_ => String::new(),
			};
			return Err(DesktopError::ax_failed(format!(
				"wrote {value}; the control now reads {actual}{range}. The app may have clamped, \
				 rounded or not taken it: inspect the target before writing again"
			)));
		}
		tokio::time::sleep(Duration::from_millis(25)).await;
	}
}

/// Replaces an element's text and reads it back: Gecko (Firefox, Thunderbird)
/// accepts the write and keeps the old text. A field that hides its text reads
/// back one mask character per character, whatever its role (a GTK4 entry
/// with visibility off is a plain `Text`), so there the length is the check.
/// Where the old text already showed that mask, a write the field ignored
/// reads back the same, so the field must first read back empty after a
/// clear. A hidden field's text never enters an error.
async fn write_text(
	connection: &atspi::zbus::Connection,
	accessible: &atspi::proxy::accessible::AccessibleProxy<'_>,
	name: &UniqueName<'static>,
	object: &ObjectRefOwned,
	value: &str,
	emptied: &mut bool,
) -> CoreResult<()> {
	let editable = atspi::proxy::editable_text::EditableTextProxy::builder(connection)
		.destination(name.clone())
		.and_then(|b| b.path(object.path().clone()))
		.map_err(|err| DesktopError::ax_failed(err.to_string()))?
		.build()
		.await
		.map_err(|err| DesktopError::ax_failed(format!("AT-SPI editable text: {err}")))?;
	let read = async || text_contents(connection, name, object).await.ok();
	let replace = async |text: &str| {
		if !editable
			.set_text_contents(text)
			.await
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text value: {err}")))?
		{
			return Err(DesktopError::ax_failed("AT-SPI text value was rejected"));
		}
		CoreResult::Ok(read().await)
	};
	let old = read().await;
	let actual = replace(value).await?;
	if actual.as_deref() == Some(value) {
		return Ok(());
	}
	if actual.as_deref().is_some_and(|actual| masks(actual, value)) {
		if !old.as_deref().is_none_or(|old| masks(old, value)) {
			return Ok(());
		}
		if replace("").await?.as_deref() != Some("") {
			return text_readback(value, value, None, true);
		}
		// Keep the confirmed clear outside the request future so dropping the
		// rewrite on timeout or cancellation does not lose the warning.
		*emptied = true;
		let rewritten = replace(value).await?;
		if rewritten
			.as_deref()
			.is_some_and(|actual| masks(actual, value))
		{
			return Ok(());
		}
		return text_readback(value, value, None, true);
	}
	// A role that cannot be read counts as a password field's, so what such a
	// field reads never enters an error.
	let secure = accessible
		.get_role()
		.await
		.ok()
		.is_none_or(|role| role == Role::PasswordText);
	text_readback(value, value, actual.as_deref(), secure)
}

fn text_write_error(mut error: DesktopError, emptied: bool) -> DesktopError {
	if emptied {
		error
			.message
			.push_str(". setValue emptied the field before this write, so it may now be empty");
	}
	error
}
/// The whole text of an element with the `Text` interface.
async fn text_contents(
	connection: &atspi::zbus::Connection,
	name: &UniqueName<'static>,
	object: &ObjectRefOwned,
) -> atspi::zbus::Result<String> {
	let text = atspi::proxy::text::TextProxy::builder(connection)
		.destination(name.clone())?
		.path(object.path().clone())?
		.cache_properties(atspi::zbus::proxy::CacheProperties::No)
		.build()
		.await?;
	let count = text.character_count().await?;
	text.get_text(0, count).await
}

/// The text of an element with the `Text` interface, up to 16,384 characters.
/// The proxy keeps no property cache: zbus fills one with `GetAll`, which
/// crashes Qt 5 and Qt 6 before 6.9.2, and GTK 3 and Firefox apps on
/// at-spi2-core before 2.45; newer Qt refuses it.
async fn text_value(
	connection: &atspi::zbus::Connection,
	object: &ObjectRefOwned,
) -> Option<String> {
	let text = atspi::proxy::text::TextProxy::builder(connection)
		.destination(object.name()?.clone())
		.ok()?
		.path(object.path().clone())
		.ok()?
		.cache_properties(atspi::zbus::proxy::CacheProperties::No)
		.build()
		.await
		.ok()?;
	let count = text.character_count().await.unwrap_or(0).min(16_384);
	text.get_text(0, count).await.ok().filter(|s| !s.is_empty())
}

fn native_window_for_frame(windows: &[DesktopWindow], pid: u32, title: &str) -> CoreResult<String> {
	let mut matches = windows.iter().filter(|window| {
		!window.id.starts_with("atspi:") && window.pid == Some(pid) && window.title == title
	});
	let first = matches.next().ok_or_else(|| {
		DesktopError::window_not_found("AT-SPI frame has no matching native window")
	})?;
	if matches.next().is_some() {
		return Err(DesktopError::ax_failed(
			"AT-SPI frame matches multiple native windows; refusing ambiguous input ownership",
		));
	}
	Ok(first.id.clone())
}

/// Whether `role` marks a top-level window: `Frame`, `Dialog` and `Window`
/// anywhere, and `FileChooser` as a child of the application. GTK3 gives its
/// Open and Save dialogs that role and gives it to the file chooser widget
/// inside them too.
const fn top_level_role(role: Role, child_of_application: bool) -> bool {
	match role {
		Role::Frame | Role::Dialog | Role::Window => true,
		Role::FileChooser => child_of_application,
		_ => false,
	}
}

/// Machine names that activate an element, compared by [`folds_to`]: GTK
/// (`click`, `activate`), Qt (`Toggle`), Chromium and Electron (`click`,
/// `open`, `jump`, `clickAncestor`, and `doDefault` on elements without a
/// verb), and `do default` / `do-default` from other ATK bridges. `press`
/// itself matches before these are tried.
const ACTIVATIONS: [&str; 8] =
	["click", "clickancestor", "activate", "invoke", "toggle", "open", "jump", "dodefault"];

/// Chromium's, Firefox's and `LibreOffice`'s activation of menu items,
/// options and tabs, taken only when an element has none of [`ACTIVATIONS`]:
/// a GTK colour swatch lists `select` (set the selected flag) before
/// `activate`.
const SELECT: &str = "select";

/// Whether `name` is `safe`, ignoring case and the spaces, hyphens and
/// underscores toolkits spell action names with.
fn folds_to(name: &str, safe: &str) -> bool {
	name
		.bytes()
		.filter(|byte| !matches!(byte, b' ' | b'-' | b'_'))
		.map(|byte| byte.to_ascii_lowercase())
		.eq(safe.bytes())
}

/// Generic press means activation, not action zero (GTK4 text views put
/// `buffer.delete-line` there). Explicit advertised actions remain available.
fn action_index<'a>(
	actions: impl Iterator<Item = &'a str> + Clone,
	requested: &str,
) -> Option<usize> {
	let position = |matches: &dyn Fn(&str) -> bool| actions.clone().position(matches);
	position(&|name| name.eq_ignore_ascii_case(requested)).or_else(|| {
		requested.eq_ignore_ascii_case("press").then(|| {
			position(&|name| ACTIVATIONS.iter().any(|safe| folds_to(name, safe)))
				.or_else(|| position(&|name| folds_to(name, SELECT)))
		})?
	})
}

/// The most actions read of one element: the count comes from the app.
const MAX_ACTIONS: i32 = 256;

/// The machine names of an element's actions, by index (`press`, `click`,
/// `activate`): what libatspi's `atspi_action_get_action_name` reads.
/// `GetActions` returns localized names instead: Firefox reports each as `;;`,
/// Chromium, Electron and the GTK3 build of `LibreOffice` as empty strings, and
/// every toolkit translates them under a non-English locale.
async fn action_names(
	proxy: &atspi::proxy::action::ActionProxy<'_>,
) -> atspi::zbus::Result<Vec<String>> {
	let count = proxy.n_actions().await?.clamp(0, MAX_ACTIONS);
	futures::future::try_join_all((0..count).map(|index| proxy.get_name(index))).await
}

/// The index of `action` among `proxy`'s actions, matched by machine name. A
/// generic press of a checkbox, radio button or toggle button falls back on
/// `check` or `uncheck`, the only activation Chromium and Electron give them.
async fn resolve_action(
	proxy: &atspi::proxy::action::ActionProxy<'_>,
	accessible: &atspi::proxy::accessible::AccessibleProxy<'_>,
	action: &str,
) -> CoreResult<i32> {
	let names = action_names(proxy)
		.await
		.map_err(|err| DesktopError::ax_failed(format!("AT-SPI actions: {err}")))?;
	let names = || names.iter().map(String::as_str);
	let mut index = action_index(names(), action);
	if index.is_none()
		&& action.eq_ignore_ascii_case("press")
		&& matches!(
			accessible.get_role().await,
			Ok(Role::CheckBox
				| Role::CheckMenuItem
				| Role::RadioButton
				| Role::RadioMenuItem
				| Role::ToggleButton)
		) {
		index = names().position(|name| {
			name.eq_ignore_ascii_case("check") || name.eq_ignore_ascii_case("uncheck")
		});
	}
	let index = index
		.ok_or_else(|| DesktopError::ax_failed(format!("AT-SPI action '{action}' is unavailable")))?;
	i32::try_from(index).map_err(|err| DesktopError::ax_failed(err.to_string()))
}

impl AxBackend for AtSpiAx {
	fn window_root(&mut self, win: &DesktopWindow) -> CoreResult<AxHandle> {
		self.frames = FrameCache::default();
		let failed = |err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}"));
		self
			.run(async {
				let app = self.app_for_window(win).await?;
				let frames = Self::frames(&self.connection, &app, self.reply_timeout).await?;
				let mut matches = Vec::new();
				for frame in frames {
					let id = atspi_window_id(&frame);
					if win.id.starts_with("atspi:") {
						if id == win.id {
							return Ok(frame);
						}
						continue;
					}
					let proxy = self
						.reply(frame.as_accessible_proxy(&self.connection))
						.await?
						.map_err(|err| failed(err.to_string()))?;
					if self
						.reply(proxy.name())
						.await?
						.map_err(|err| failed(err.to_string()))?
						== win.title
					{
						matches.push(frame);
					}
				}
				if matches.len() == 1 {
					Ok(matches.remove(0))
				} else {
					Err(failed(format!(
						"window '{}' has {} matching AT-SPI frames",
						win.title,
						matches.len()
					)))
				}
			})?
			.map(AxHandle::AtSpi)
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let object = Self::object(h).clone();
		self.run(async {
			let connection = &self.connection;
			let object = Self::top_level(connection, object, self.reply_timeout).await?;
			// The ancestry scan is per-reply; the following single-window
			// identification keeps its operation budget.
			answered("the application", self.reply_timeout, async {
				let id = atspi_window_id(&object);
				if windows.iter().any(|window| window.id == id) {
					return Ok(id);
				}
				let name = object
					.name()
					.ok_or_else(|| DesktopError::ax_failed("AT-SPI window has no bus owner"))?;
				let dbus = atspi::zbus::fdo::DBusProxy::new(connection)
					.await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				let pid = dbus
					.get_connection_unix_process_id(name.clone().into())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window pid: {err}")))?;
				let title = object
					.as_accessible_proxy(connection)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window owner: {err}")))?
					.name()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window title: {err}")))?;
				native_window_for_frame(windows, pid, &title)
			})
			.await?
		})?
	}

	fn props(&mut self, h: &AxHandle) -> CoreResult<AxProps> {
		self.frames.refresh();
		self.read_props(h, WalkBounds::Read)
	}

	fn walk_node(
		&mut self,
		h: &AxHandle,
		bounds: WalkBounds,
	) -> CoreResult<(AxProps, Vec<AxHandle>)> {
		Ok((self.read_props(h, bounds)?, self.children(h)?))
	}

	fn children(&mut self, h: &AxHandle) -> CoreResult<Vec<AxHandle>> {
		let object = Self::object(h).clone();
		self.request(async {
			let proxy = object
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))?;
			proxy
				.get_children()
				.await
				.map(|items| {
					items
						.into_iter()
						.filter(|item| !item.is_null())
						.map(AxHandle::AtSpi)
						.collect()
				})
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI children: {err}")))
		})
	}

	fn parent(&mut self, h: &AxHandle) -> CoreResult<Option<AxHandle>> {
		let object = Self::object(h).clone();
		self.request(async {
			let proxy = object
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			let parent = proxy
				.parent()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI parent: {err}")))?;
			Ok((!parent.is_null()).then_some(AxHandle::AtSpi(parent)))
		})
	}

	fn perform(&mut self, h: &AxHandle, action: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self
			.request(async {
				let proxy = Self::action(&self.connection, &object)
					.await
					.map_err(DesktopError::ax_failed)?;
				let accessible = object
					.as_accessible_proxy(&self.connection)
					.await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				let index = resolve_action(&proxy, &accessible, action).await?;
				proxy
					.do_action(index)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?
					.ok_or_else(|| DesktopError::ax_failed(format!("AT-SPI action '{action}' failed")))
			})
			.map_err(unconfirmed)
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		let mut emptied = false;
		self
			.request(async {
				let name = object
					.name()
					.ok_or_else(|| DesktopError::ax_failed("AT-SPI object has no bus name"))?
					.clone();
				let accessible = object
					.as_accessible_proxy(&self.connection)
					.await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				let interfaces = accessible
					.get_interfaces()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI interfaces: {err}")))?;
				if interfaces.contains(atspi::Interface::EditableText) {
					return write_text(
						&self.connection,
						&accessible,
						&name,
						&object,
						value,
						&mut emptied,
					)
					.await;
				}
				if !interfaces.contains(atspi::Interface::Value) {
					return Err(DesktopError::ax_failed(
						"AT-SPI element has no writable value interface",
					));
				}
				let numeric = value.parse::<f64>().map_err(|_| {
					DesktopError::ax_failed("AT-SPI value is not editable text or a number")
				})?;
				if !numeric.is_finite() {
					return Err(DesktopError::ax_failed("AT-SPI numeric value must be finite"));
				}
				write_value(&self.connection, &name, &object, numeric).await
			})
			.map_err(|error| text_write_error(unconfirmed(error), emptied))
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self
			.request(async {
				let component = Self::component(&self.connection, &object)
					.await
					.map_err(DesktopError::ax_failed)?;
				component
					.grab_focus()
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI focus: {err}")))?
					.ok_or_else(|| DesktopError::ax_failed("AT-SPI focus request was rejected"))
			})
			.map_err(unconfirmed)
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let x = x.round() as i32;
		let y = y.round() as i32;
		let Self { rt, connection, native, frames: cache, reply_timeout } = self;
		cache.refresh();
		rt.block_on(cancellable(async {
			let bus = &*connection;
			let mut root: Option<(ObjectRefOwned, Option<Placement>)> = None;
			for app in Self::apps(connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				let frames = Self::frames(connection, &app, *reply_timeout).await?;
				for frame in frames {
					// This probes one frame, not the traversal: retain its
					// single-element operation budget.
					let Some(placement) = answered(
						"the application",
						*reply_timeout,
						cache.claim(bus, native.as_deref(), &frame, x, y),
					)
					.await??
					else {
						continue;
					};
					// AT-SPI enumeration is not stacking order. Never choose an
					// arbitrary frame when two top-levels contain the point.
					if let Some((previous, _)) = &root {
						if previous != &frame {
							return Err(DesktopError::ax_failed(
								"multiple AT-SPI windows contain this point; topmost ownership is \
								 ambiguous",
							));
						}
					} else {
						root = Some((frame, placement));
					}
				}
			}
			let Some((root, placement)) = root else {
				return Ok(None);
			};
			Self::descend(bus, root, placement, x, y, *reply_timeout).await
		}))?
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.run(async {
			let mut unanswered_app = false;
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				match Self::find_focused(&self.connection, app, 0, self.reply_timeout).await {
					Ok(Some(found)) => return Ok(Some(AxHandle::AtSpi(found))),
					Ok(None) => {},
					// The focus may be in an application that does not answer,
					// which no other application's lack of focus rules out.
					Err(error) if error.code == ErrorCode::Timeout => unanswered_app = true,
					Err(error) => return Err(error),
				}
			}
			if unanswered_app {
				Err(unanswered("an application", self.reply_timeout))
			} else {
				Ok(None)
			}
		})?
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let object = Self::object(h).clone();
		self.request(async {
			let proxy = object
				.as_accessible_proxy(&self.connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?;
			let mut attrs: Vec<_> = proxy
				.get_attributes()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI attributes: {err}")))?
				.into_iter()
				.map(|(key, mut value)| {
					value.truncate(200);
					(key, value)
				})
				.collect();
			attrs.sort_by(|a, b| a.0.cmp(&b.0));
			Ok(attrs)
		})
	}
}

/// An element's own focus state and the toolkit reporting it, which decides
/// what that state means.
pub struct ElementFocus {
	pub focused: bool,
	/// The application's `toolkit_name`, such as `gtk`, `GTK` or `Chromium`;
	/// empty when the application does not report it.
	pub toolkit: String,
	/// The application's (deprecated) `Version`; empty when not reported.
	pub version: String,
}

impl AtSpiAx {
	/// The element's focus state, and its application's toolkit as far as the
	/// application reports it: missing toolkit metadata leaves the toolkit
	/// unknown rather than failing the read.
	pub(crate) fn element_focus(&self, h: &AxHandle) -> CoreResult<ElementFocus> {
		fn failed(error: impl std::fmt::Display) -> DesktopError {
			DesktopError::ax_failed(format!("AT-SPI focus state: {error}"))
		}
		let object = Self::object(h).clone();
		self.request(async {
			let connection = &self.connection;
			let proxy = object
				.as_accessible_proxy(connection)
				.await
				.map_err(failed)?;
			let focused = proxy
				.get_state()
				.await
				.map_err(failed)?
				.contains(State::Focused);
			let app = proxy.get_application().await.map_err(failed)?;
			let toolkit = async {
				let app = atspi::proxy::application::ApplicationProxy::builder(connection)
					.destination(app.name()?.clone())
					.ok()?
					.path(app.path().clone())
					.ok()?
					// atk-bridge answers `Get` for these properties, not `GetAll`.
					.cache_properties(zbus::proxy::CacheProperties::No)
					.build()
					.await
					.ok()?;
				let toolkit = app.toolkit_name().await.ok()?;
				let version = app.version().await.unwrap_or_default();
				Some((toolkit, version))
			}
			.await;
			let (toolkit, version) = toolkit.unwrap_or_default();
			Ok(ElementFocus { focused, toolkit, version })
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn text_value_reads_text_without_get_all() {
		use atspi::zbus::{
			MessageStream, connection::Builder as ConnectionBuilder, message::Type, zvariant::Value,
		};
		use futures::StreamExt;

		const TEXT: &str = "org.a11y.atspi.Text";
		const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
		const PEER: &str = ":1.7";

		// Reject GetAll on any interface rather than crashing as affected apps
		// do.
		async fn app(server: atspi::zbus::Connection, calls: &mut Vec<(String, String)>) {
			let mut stream = MessageStream::from(&server);
			while let Some(message) = stream.next().await {
				let message = message.unwrap();
				if message.message_type() != Type::MethodCall {
					continue;
				}
				let header = message.header();
				let interface = header.interface().unwrap().as_str();
				let member = header.member().unwrap().as_str();
				match (interface, member) {
					(PROPERTIES, "GetAll") => {
						let requested: String = message.body().deserialize().unwrap();
						calls.push((member.to_owned(), requested));
						server
							.reply_error(
								&header,
								"org.freedesktop.DBus.Error.NotSupported",
								&"GetAll is unsafe",
							)
							.await
							.unwrap();
					},
					(PROPERTIES, "Get") => {
						let (requested, property): (String, String) =
							message.body().deserialize().unwrap();
						assert_eq!((requested.as_str(), property.as_str()), (TEXT, "CharacterCount"));
						calls.push((member.to_owned(), format!("{requested}.{property}")));
						server.reply(&header, &Value::from(12_i32)).await.unwrap();
					},
					(TEXT, "GetText") => {
						let (start, end): (i32, i32) = message.body().deserialize().unwrap();
						let result: String = "initial text"
							.chars()
							.skip(usize::try_from(start).unwrap())
							.take(usize::try_from(end - start).unwrap())
							.collect();
						server.reply(&header, &result).await.unwrap();
					},
					_ => panic!("unexpected AT-SPI call: {interface}.{member}"),
				}
			}
		}

		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (text, calls) = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let server = ConnectionBuilder::unix_stream(server)
				.server(atspi::zbus::Guid::generate())
				.unwrap()
				.p2p()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let object = ObjectRefOwned::from_static_str_unchecked(PEER, "/text");
			let mut calls = Vec::new();
			let text = tokio::select! {
				text = text_value(&client, &object) => text,
				() = app(server, &mut calls) => unreachable!("the app stopped answering"),
			};
			(text, calls)
		});

		assert!(
			calls.iter().all(|(member, _)| member != "GetAll"),
			"unsafe property calls: {calls:?}"
		);
		assert_eq!(text.as_deref(), Some("initial text"));
		assert!(
			calls.iter().any(|(member, property)| member == "Get"
				&& property == "org.a11y.atspi.Text.CharacterCount")
		);
	}

	#[test]
	fn generic_press_never_selects_an_unrelated_editing_action() {
		let actions = ["buffer.delete-line", "clipboard.cut", "activate"];
		assert_eq!(action_index(actions.into_iter(), "press"), Some(2));
		assert_eq!(action_index(actions[..2].iter().copied(), "press"), None);
		assert_eq!(action_index(actions.into_iter(), "buffer.delete-line"), Some(0));
		assert_eq!(action_index(std::iter::empty(), "press"), None);
	}

	/// Machine names in order, as the GTK 3, GTK 4, Qt 5, Qt 6 and Chromium
	/// 156 matrix fixtures on Ubuntu 22.04 list them (the colour swatch as GTK
	/// declares it), with the action `action_index` resolves a generic press to.
	#[test]
	fn generic_press_takes_each_toolkits_activation() {
		let cases: [(&str, &[&str], Option<usize>); 10] = [
			("GTK 4 label", &["clipboard.copy", "link.open", "menu.popup"], None),
			("Qt slider", &["SetFocus", "Increase", "Decrease"], None),
			("Qt menu bar item", &["ShowMenu"], None),
			("Chromium ARIA menu item", &["select", "showContextMenu"], Some(0)),
			("Chromium tab", &["doDefault", "showContextMenu"], Some(0)),
			("Chromium section", &["clickAncestor", "showContextMenu"], Some(0)),
			("GTK colour swatch", &["select", "activate", "customize"], Some(1)),
			("spaced spelling", &["Do Default"], Some(0)),
			("hyphenated spelling", &["do-default"], Some(0)),
			("context menu only", &["showContextMenu"], None),
		];
		for (widget, actions, expected) in cases {
			assert_eq!(action_index(actions.iter().copied(), "press"), expected, "{widget}");
		}
	}

	#[test]
	fn a_text_write_the_app_ignores_fails() {
		use std::sync::{Arc, Mutex};

		use atspi::zbus::{connection::Builder as ConnectionBuilder, interface};

		/// Which writes a field applies: all (GTK, Qt, `LibreOffice`), none while
		/// answering true (Gecko), or the first two and then it refuses.
		#[derive(Clone, Copy)]
		enum Writes {
			All,
			Ignored,
			TwoThenRefused,
		}

		/// `org.a11y.atspi.EditableText`, counting the writes it gets.
		struct Editable {
			text:   Arc<Mutex<String>>,
			writes: Writes,
			count:  Arc<Mutex<usize>>,
		}

		#[interface(name = "org.a11y.atspi.EditableText")]
		impl Editable {
			fn set_text_contents(&self, new_contents: String) -> bool {
				let mut count = self.count.lock().unwrap();
				*count += 1;
				let applies = match self.writes {
					Writes::All => true,
					Writes::Ignored => false,
					Writes::TwoThenRefused if *count > 2 => return false,
					Writes::TwoThenRefused => true,
				};
				if applies {
					*self.text.lock().unwrap() = new_contents;
				}
				true
			}
		}

		/// How a field shows its text: as is, or one `●` per character (GTK,
		/// Gecko) or per UTF-16 unit (Qt).
		#[derive(Clone, Copy)]
		enum Shown {
			Plain,
			PerChar,
			PerUtf16,
		}

		fn shown(text: &str, shown: Shown) -> String {
			match shown {
				Shown::Plain => text.to_owned(),
				Shown::PerChar => "●".repeat(text.chars().count()),
				Shown::PerUtf16 => "●".repeat(text.encode_utf16().count()),
			}
		}

		/// `org.a11y.atspi.Text`, reading what the field shows.
		struct Text {
			text:  Arc<Mutex<String>>,
			shown: Shown,
		}

		#[interface(name = "org.a11y.atspi.Text")]
		impl Text {
			#[zbus(property)]
			fn character_count(&self) -> i32 {
				shown(&self.text.lock().unwrap(), self.shown)
					.chars()
					.count() as i32
			}

			fn get_text(&self, start_offset: i32, end_offset: i32) -> String {
				shown(&self.text.lock().unwrap(), self.shown)
					.chars()
					.skip(start_offset as usize)
					.take((end_offset - start_offset) as usize)
					.collect()
			}
		}

		struct Accessible(Role);

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Accessible {
			fn get_role(&self) -> u32 {
				self.0 as u32
			}
		}

		/// An error naming what the field reads, one that quotes no text, or one
		/// saying the field was emptied.
		enum Verdict {
			Ok,
			Reads(&'static str),
			Hidden,
			Emptied,
		}

		const PEER: &str = ":1.7";
		// Path, which writes the field applies, role (`None`: unreadable), how it
		// shows its text (`None`: no `Text`), its old text, the verdict, and how
		// many writes it gets.
		type Case = (&'static str, Writes, Option<Role>, Option<Shown>, &'static str, Verdict, usize);
		let password = Some(Role::PasswordText);
		let masked = Some(Shown::PerChar);
		// As many characters as "new ä€😀", so it shows the same mask.
		let same_length = "abcdefg";
		let cases: [Case; 12] = [
			("/gtk", Writes::All, Some(Role::Entry), Some(Shown::Plain), "old", Verdict::Ok, 1),
			(
				"/gecko",
				Writes::Ignored,
				Some(Role::Entry),
				Some(Shown::Plain),
				"old",
				Verdict::Reads(r#"the field now reads "old""#),
				1,
			),
			// The mask changed length, so one write is proof.
			("/gtk_password", Writes::All, password, masked, "old", Verdict::Ok, 1),
			("/gecko_password", Writes::Ignored, password, masked, "old", Verdict::Hidden, 1),
			// The old text shows the same mask: the field must clear first.
			("/gtk_password_same_length", Writes::All, password, masked, same_length, Verdict::Ok, 3),
			(
				"/gecko_password_same_length",
				Writes::Ignored,
				password,
				masked,
				same_length,
				Verdict::Hidden,
				2,
			),
			(
				"/refused_after_clear",
				Writes::TwoThenRefused,
				password,
				masked,
				same_length,
				Verdict::Emptied,
				3,
			),
			("/qt_password", Writes::All, password, Some(Shown::PerUtf16), "old", Verdict::Ok, 1),
			// A GTK4 entry with visibility off and no password purpose.
			("/gtk4_hidden", Writes::All, Some(Role::Text), masked, "old", Verdict::Ok, 1),
			(
				"/gtk4_hidden_ignored",
				Writes::Ignored,
				Some(Role::Text),
				masked,
				"old",
				Verdict::Hidden,
				1,
			),
			("/no_role", Writes::Ignored, None, Some(Shown::Plain), "old", Verdict::Hidden, 1),
			("/no_text", Writes::All, password, None, "old", Verdict::Hidden, 1),
		];
		let counts: Vec<_> = cases.iter().map(|_| Arc::new(Mutex::new(0))).collect();
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let results = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let mut builder = ConnectionBuilder::unix_stream(server)
				.server(atspi::zbus::Guid::generate())
				.unwrap()
				.p2p();
			for (&(path, writes, role, shown, old, ..), count) in cases.iter().zip(&counts) {
				let text = Arc::new(Mutex::new(old.to_owned()));
				let count = count.clone();
				builder = builder
					.serve_at(path, Editable { text: text.clone(), writes, count })
					.unwrap();
				if let Some(shown) = shown {
					builder = builder.serve_at(path, Text { text, shown }).unwrap();
				}
				if let Some(role) = role {
					builder = builder.serve_at(path, Accessible(role)).unwrap();
				}
			}
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(builder.build(), client).unwrap();
			let mut results = Vec::new();
			for &(path, ..) in &cases {
				let object = ObjectRefOwned::from_static_str_unchecked(PEER, path);
				let name = object.name().unwrap().clone();
				let accessible = object.as_accessible_proxy(&client).await.unwrap();
				let mut emptied = false;
				results.push(
					write_text(&client, &accessible, &name, &object, "new ä€😀", &mut emptied)
						.await
						.map_err(|error| text_write_error(error, emptied)),
				);
			}
			drop(server);
			results
		});
		for (((path, .., verdict, writes), result), count) in cases.iter().zip(results).zip(&counts) {
			assert_eq!(*count.lock().unwrap(), *writes, "{path}: writes");
			match (verdict, result) {
				(Verdict::Ok, Ok(())) => {},
				(Verdict::Reads(text), Err(err)) if err.message.contains(text) => {},
				(Verdict::Hidden, Err(err))
					if !err.message.contains("new")
						&& !err.message.contains(r#""old""#)
						&& !err.message.contains("emptied") => {},
				(Verdict::Emptied, Err(err))
					if err.message.contains("emptied") && !err.message.contains("new") => {},
				(_, result) => panic!("{path}: {result:?}"),
			}
		}
	}

	#[test]
	fn a_numeric_write_the_app_clamps_or_ignores_fails() {
		use std::sync::{Arc, Mutex};

		use atspi::zbus::{connection::Builder as ConnectionBuilder, interface};

		/// What a control does with a write: takes it, clamps it to its range
		/// (GTK, Qt), keeps its old value while answering (Qt), takes it after
		/// the first read back, or stores it as `float`.
		#[derive(Clone, Copy)]
		enum Takes {
			Exact,
			Clamped,
			Ignored,
			Later,
			Single,
		}

		/// `org.a11y.atspi.Value` with optional bounds.
		struct Value {
			current: Arc<Mutex<f64>>,
			pending: Mutex<Option<f64>>,
			takes:   Takes,
			bounds:  Option<(f64, f64)>,
		}

		#[interface(name = "org.a11y.atspi.Value")]
		impl Value {
			#[zbus(property)]
			fn current_value(&self) -> f64 {
				let current = *self.current.lock().unwrap();
				// A write the toolkit applies late shows from the second read on.
				let pending = self.pending.lock().unwrap().take();
				if let Some(value) = pending {
					*self.current.lock().unwrap() = value;
				}
				current
			}

			#[zbus(property)]
			fn set_current_value(&mut self, value: f64) {
				let mut current = self.current.lock().unwrap();
				match self.takes {
					Takes::Exact => *current = value,
					Takes::Clamped => {
						let (min, max) = self.bounds.unwrap_or((0.0, 100.0));
						*current = value.clamp(min, max);
					},
					Takes::Ignored => {},
					Takes::Later => *self.pending.get_mut().unwrap() = Some(value),
					#[expect(clippy::cast_possible_truncation, reason = "a float-storing toolkit")]
					Takes::Single => *current = f64::from(value as f32),
				}
			}

			#[zbus(property)]
			fn minimum_value(&self) -> atspi::zbus::fdo::Result<f64> {
				self.range(|(min, _)| min)
			}

			#[zbus(property)]
			fn maximum_value(&self) -> atspi::zbus::fdo::Result<f64> {
				self.range(|(_, max)| max)
			}
		}

		impl Value {
			fn range(&self, bound: impl FnOnce((f64, f64)) -> f64) -> atspi::zbus::fdo::Result<f64> {
				self
					.bounds
					.map(bound)
					.ok_or_else(|| atspi::zbus::fdo::Error::Failed("no range".to_owned()))
			}
		}

		const PEER: &str = ":1.7";
		// Path, what the control does, its bounds, the value written,
		// and the error's text (`None`: the write succeeds).
		type Case = (&'static str, Takes, Option<(f64, f64)>, f64, Option<&'static str>);
		let bounded = Some((0.0, 100.0));
		let cases: [Case; 8] = [
			("/exact", Takes::Exact, bounded, 37.25, None),
			("/later", Takes::Later, bounded, 37.0, None),
			("/single", Takes::Single, bounded, 0.3, None),
			(
				"/minimum_only",
				Takes::Clamped,
				Some((0.0, f64::MAX)),
				-1.0,
				Some("wrote -1; the control now reads 0 (its minimum is 0)."),
			),
			(
				"/maximum_only",
				Takes::Clamped,
				Some((-f64::MAX, 100.0)),
				150.0,
				Some("wrote 150; the control now reads 100 (its maximum is 100)."),
			),
			(
				"/clamped",
				Takes::Clamped,
				bounded,
				150.0,
				Some("wrote 150; the control now reads 100 (its maximum is 100)"),
			),
			("/ignored", Takes::Ignored, bounded, 37.0, Some("wrote 37; the control now reads 20.")),
			("/unranged", Takes::Clamped, None, 150.0, Some("wrote 150; the control now reads 100.")),
		];
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let results = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let mut builder = ConnectionBuilder::unix_stream(server)
				.server(atspi::zbus::Guid::generate())
				.unwrap()
				.p2p();
			for &(path, takes, bounds, ..) in &cases {
				let current = Arc::new(Mutex::new(20.0));
				let control = Value { current, pending: Mutex::new(None), takes, bounds };
				builder = builder.serve_at(path, control).unwrap();
			}
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(builder.build(), client).unwrap();
			let mut results = Vec::new();
			for &(path, _, _, value, _) in &cases {
				let object = ObjectRefOwned::from_static_str_unchecked(PEER, path);
				let name = object.name().unwrap().clone();
				results.push(write_value(&client, &name, &object, value).await);
			}
			drop(server);
			results
		});
		for ((path, .., error), result) in cases.iter().zip(results) {
			match (error, result) {
				(None, Ok(())) => {},
				(Some(text), Err(err)) if err.message.contains(text) => {},
				(_, result) => panic!("{path}: {result:?}"),
			}
		}
	}

	#[test]
	fn frame_ownership_requires_unique_process_and_title() {
		let window = |id: &str, pid: u32| DesktopWindow {
			id:      id.to_owned(),
			pid:     Some(pid),
			title:   "Document".into(),
			app:     "Editor".into(),
			x:       0,
			y:       0,
			width:   100,
			height:  100,
			focused: false,
		};
		let mut windows = vec![window("1", 10), window("2", 20)];
		assert_eq!(native_window_for_frame(&windows, 20, "Document").unwrap(), "2");
		assert!(native_window_for_frame(&windows, 30, "Document").is_err());
		windows.push(window("3", 20));
		assert!(native_window_for_frame(&windows, 20, "Document").is_err());
	}

	#[test]
	fn shell_frames_yield_focus_to_the_active_application_window() {
		let frame = |title: &str, pid: u32, focused: bool| AtSpiWindow {
			window:         DesktopWindow {
				id: format!("{title}-{pid}"),
				pid: Some(pid),
				title: title.into(),
				app: "app".into(),
				x: 0,
				y: 0,
				width: 100,
				height: 100,
				focused,
			},
			position_known: false,
		};
		let focused = |windows: &[AtSpiWindow]| -> Vec<String> {
			windows
				.iter()
				.filter(|w| w.window.focused)
				.map(|w| w.window.title.clone())
				.collect()
		};

		// Only an all-untitled tie asks which frame holds keyboard focus.
		let no_lookup = |_: &DesktopWindow| -> bool { panic!("focus lookup was not needed") };

		// GNOME: gnome-shell (the compositor, pid 1) keeps its "Main stage"
		// active.
		let mut gnome = vec![frame("Main stage", 1, true), frame("notes.txt - gedit", 7, true)];
		resolve_focus(&mut gnome, Some(1), false, no_lookup);
		assert_eq!(focused(&gnome), ["notes.txt - gedit"]);

		// KDE: plasma-keyboard's untitled frame stays active.
		let mut kde = vec![frame("", 5, true), frame("notes.txt — Kate", 8, true)];
		resolve_focus(&mut kde, None, false, no_lookup);
		assert_eq!(focused(&kde), ["notes.txt — Kate"]);

		// The GNOME overview: only the shell is active, and it keeps focus.
		let mut overview = vec![frame("Main stage", 1, true), frame("notes.txt - gedit", 7, false)];
		resolve_focus(&mut overview, Some(1), false, no_lookup);
		assert_eq!(focused(&overview), ["Main stage"]);

		// Two active application windows: none is named.
		let mut two = vec![frame("Main stage", 1, true), frame("A", 7, true), frame("B", 9, true)];
		resolve_focus(&mut two, Some(1), false, no_lookup);
		assert!(focused(&two).is_empty());

		// An untitled application window still wins over gnome-shell's frame.
		let mut untitled = vec![frame("Main stage", 1, true), frame("", 7, true)];
		resolve_focus(&mut untitled, Some(1), false, no_lookup);
		assert_eq!(focused(&untitled), [""]);

		// KDE with an untitled app beside plasma-keyboard: the frame holding
		// keyboard focus wins.
		let mut kde_untitled = vec![frame("", 5, true), frame("", 8, true)];
		resolve_focus(&mut kde_untitled, None, false, |window| window.pid == Some(8));
		let ids: Vec<&str> = kde_untitled
			.iter()
			.filter(|w| w.window.focused)
			.map(|w| w.window.id.as_str())
			.collect();
		assert_eq!(ids, ["-8"]);

		// A shell's permanent Active state cannot stand in for a skipped app.
		let mut skipped_gnome = vec![frame("Main stage", 1, true)];
		resolve_focus(&mut skipped_gnome, Some(1), true, |_| false);
		assert!(focused(&skipped_gnome).is_empty());
		let mut skipped_kde = vec![frame("", 5, true)];
		resolve_focus(&mut skipped_kde, None, true, |_| false);
		assert!(focused(&skipped_kde).is_empty());

		// Positive keyboard focus still permits the overview or an untitled app.
		let mut focused_overview = vec![frame("Main stage", 1, true)];
		resolve_focus(&mut focused_overview, Some(1), true, |_| true);
		assert_eq!(focused(&focused_overview), ["Main stage"]);
		let mut focused_untitled = vec![frame("", 8, true)];
		resolve_focus(&mut focused_untitled, None, true, |_| true);
		assert_eq!(focused(&focused_untitled), [""]);

		// A named application's Active state does not require a shell probe.
		let mut answered_app = vec![frame("notes.txt", 7, true)];
		resolve_focus(&mut answered_app, Some(1), true, no_lookup);
		assert_eq!(focused(&answered_app), ["notes.txt"]);

		// An all-untitled tie already proves keyboard focus, so do not scan
		// twice.
		let mut checked_kde = vec![frame("", 5, true), frame("", 8, true)];
		let mut probes = 0;
		resolve_focus(&mut checked_kde, None, true, |window| {
			probes += 1;
			window.pid == Some(8)
		});
		assert!(!checked_kde[0].window.focused);
		assert!(checked_kde[1].window.focused);
		assert_eq!(probes, 2);
	}

	#[test]
	fn file_dialogs_are_top_levels_only_under_the_application() {
		use atspi::zbus::{
			connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		/// An `org.a11y.atspi.Accessible` node with its role, parent and
		/// children.
		struct Node {
			role:     Role,
			parent:   &'static str,
			children: Vec<&'static str>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Node {
			fn get_role(&self) -> u32 {
				self.role as u32
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				let object = |path: &&str| (PEER.to_owned(), OwnedObjectPath::try_from(*path).unwrap());
				self.children.iter().map(object).collect()
			}

			#[zbus(property)]
			fn parent(&self) -> (String, OwnedObjectPath) {
				(PEER.to_owned(), OwnedObjectPath::try_from(self.parent).unwrap())
			}
		}

		const PEER: &str = ":1.7";
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (top_levels, owners) = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			// A file dialog holding its own chooser widget, and a frame that
			// embeds one.
			let tree = [
				("/app", Role::Application, "/org/a11y/atspi/null", vec!["/dialog", "/frame"]),
				("/dialog", Role::FileChooser, "/app", vec!["/filler"]),
				("/filler", Role::Filler, "/dialog", vec!["/widget"]),
				("/widget", Role::FileChooser, "/filler", vec!["/open"]),
				("/open", Role::Button, "/widget", vec![]),
				("/frame", Role::Frame, "/app", vec!["/embedded"]),
				("/embedded", Role::FileChooser, "/frame", vec!["/ok"]),
				("/ok", Role::Button, "/embedded", vec![]),
			];
			let mut server = ConnectionBuilder::unix_stream(server)
				.server(atspi::zbus::Guid::generate())
				.unwrap()
				.p2p();
			for (path, role, parent, children) in tree {
				server = server
					.serve_at(path, Node { role, parent, children })
					.unwrap();
			}
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server.build(), client).unwrap();
			let object = |path| ObjectRefOwned::from_static_str_unchecked(PEER, path);
			let path = |object: ObjectRefOwned| object.path_as_str().to_owned();
			let top_levels = AtSpiAx::frames(&client, &object("/app"), REPLY_TIMEOUT).await;
			let mut owners = Vec::new();
			for element in ["/open", "/dialog", "/ok"] {
				owners.push(
					AtSpiAx::top_level(&client, object(element), REPLY_TIMEOUT)
						.await
						.map(path)
						.ok(),
				);
			}
			drop(server);
			(top_levels.map(|items| items.into_iter().map(path).collect::<Vec<_>>()), owners)
		});
		assert_eq!(top_levels.unwrap(), vec!["/dialog".to_owned(), "/frame".to_owned()]);
		assert_eq!(owners, [Some("/dialog".into()), Some("/dialog".into()), Some("/frame".into())]);
	}

	#[test]
	fn focused_search_skips_null_child_refs() {
		use atspi::zbus::{
			connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		/// Minimal `org.a11y.atspi.Accessible` node: a state set plus `(name,
		/// path)` children.
		struct Node {
			state:    Vec<u32>,
			children: Vec<(String, OwnedObjectPath)>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Node {
			fn get_state(&self) -> Vec<u32> {
				self.state.clone()
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self.children.clone()
			}
		}

		const PEER: &str = ":1.7";
		let path = |p: &str| OwnedObjectPath::try_from(p).unwrap();
		let focused = State::Focused as u64;
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let found = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let root = Node {
				state:    vec![0, 0],
				// Chromium frames report children that are all the AT-SPI null
				// object.
				children: vec![
					(PEER.to_owned(), path("/org/a11y/atspi/null")),
					(PEER.to_owned(), path("/focus")),
				],
			};
			let leaf =
				Node { state: vec![focused as u32, (focused >> 32) as u32], children: Vec::new() };
			let guid = atspi::zbus::Guid::generate();
			let server = ConnectionBuilder::unix_stream(server)
				.server(guid)
				.unwrap()
				.p2p()
				.serve_at("/root", root)
				.unwrap()
				.serve_at("/focus", leaf)
				.unwrap()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let root = ObjectRefOwned::from_static_str_unchecked(PEER, "/root");
			let found = AtSpiAx::find_focused(&client, root, 0, REPLY_TIMEOUT).await;
			drop(server);
			found
		});
		let found = found.expect("null child refs must not fail the focused search");
		assert_eq!(
			found
				.map(|object| object.path_as_str().to_owned())
				.as_deref(),
			Some("/focus")
		);
	}

	#[test]
	fn actions_match_by_machine_name_not_localized_name() {
		use atspi::zbus::{
			MessageStream, connection::Builder as ConnectionBuilder, message::Type, zvariant::Value,
		};
		use futures::StreamExt;

		/// Path, localized names (`GetActions`), machine names (`GetName`),
		/// `NActions`, role, requested action and the index it must resolve to.
		type Case = (
			&'static str,
			&'static [&'static str],
			&'static [&'static str],
			i32,
			Role,
			&'static str,
			Option<i32>,
		);
		const CASES: [Case; 7] = [
			// Firefox.
			("/firefox", &[";;"], &["press"], 1, Role::Button, "press", Some(0)),
			// A GTK app under a German locale.
			("/german", &["Klicken"], &["click"], 1, Role::Button, "press", Some(0)),
			// Chromium's checkbox and radio button, and VS Code's Toggle Panel: a
			// toggle button.
			(
				"/checkbox",
				&["", ""],
				&["uncheck", "showContextMenu"],
				2,
				Role::CheckBox,
				"press",
				Some(0),
			),
			(
				"/radio",
				&["", ""],
				&["check", "showContextMenu"],
				2,
				Role::RadioButton,
				"press",
				Some(0),
			),
			(
				"/toggle",
				&["", ""],
				&["check", "showContextMenu"],
				2,
				Role::ToggleButton,
				"press",
				Some(0),
			),
			// No activation at all is still refused.
			("/menu_only", &["Show menu"], &["showMenu"], 1, Role::Button, "press", None),
			// An app reporting a nonsense count is read only up to the cap.
			("/huge", &[], &["press"], i32::MAX, Role::Button, "press", Some(0)),
		];
		const PEER: &str = ":1.7";

		/// Rejects `GetAll` rather than emulating Qt 5's crash. A proxy that
		/// caches properties therefore cannot read `NActions`.
		async fn app(server: atspi::zbus::Connection) {
			let mut stream = MessageStream::from(&server);
			while let Some(Ok(message)) = stream.next().await {
				if message.message_type() != Type::MethodCall {
					continue;
				}
				let header = message.header();
				let path = header.path().unwrap().to_string();
				let member = header.member().unwrap().to_string();
				let Some(case) = CASES.iter().find(|case| case.0 == path) else {
					server
						.reply_error(&header, "org.freedesktop.DBus.Error.UnknownObject", &"")
						.await
						.unwrap();
					continue;
				};
				match member.as_str() {
					"Get" => {
						let (_, property): (String, String) = message.body().deserialize().unwrap();
						assert_eq!(property, "NActions");
						server.reply(&header, &Value::from(case.3)).await.unwrap();
					},
					"GetName" => {
						let index: i32 = message.body().deserialize().unwrap();
						let name = usize::try_from(index)
							.ok()
							.and_then(|index| case.2.get(index))
							.copied()
							.unwrap_or("");
						server.reply(&header, &name).await.unwrap();
					},
					"GetActions" => {
						let actions: Vec<_> = case.1.iter().map(|name| (*name, "", "")).collect();
						server.reply(&header, &actions).await.unwrap();
					},
					"GetRole" => server.reply(&header, &(case.4 as u32)).await.unwrap(),
					_ => server
						.reply_error(&header, "org.freedesktop.DBus.Error.UnknownInterface", &"")
						.await
						.unwrap(),
				}
			}
		}

		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (results, huge) = rt.block_on(async {
			let (client, server) = tokio::net::UnixStream::pair().unwrap();
			let server = ConnectionBuilder::unix_stream(server)
				.server(atspi::zbus::Guid::generate())
				.unwrap()
				.p2p()
				.build();
			let client = ConnectionBuilder::unix_stream(client).p2p().build();
			let (server, client) = tokio::try_join!(server, client).unwrap();
			let reads = async {
				let mut results = Vec::new();
				for (path, .., requested, _) in CASES {
					let object = ObjectRefOwned::from_static_str_unchecked(PEER, path);
					let accessible = object.as_accessible_proxy(&client).await.unwrap();
					let action = AtSpiAx::action(&client, &object).await.unwrap();
					results.push(resolve_action(&action, &accessible, requested).await.ok());
				}
				let object = ObjectRefOwned::from_static_str_unchecked(PEER, "/huge");
				let action = AtSpiAx::action(&client, &object).await.unwrap();
				(results, action_names(&action).await.unwrap().len())
			};
			tokio::select! {
				reads = reads => reads,
				() = app(server) => unreachable!("the app stopped answering"),
			}
		});
		let expected: Vec<_> = CASES.iter().map(|case| case.6).collect();
		assert_eq!(results, expected);
		assert_eq!(huge, MAX_ACTIONS as usize);
	}

	#[test]
	fn sensitive_controls_are_enabled() {
		// GTK4 marks an enabled control only `Sensitive`.
		assert!(state_enabled(StateSet::new(State::Sensitive | State::Focusable)));
		assert!(state_enabled(StateSet::new(State::Enabled | State::Sensitive)));
		// GTK4's Back button with no history, GTK3's Save on a read-only file.
		assert!(!state_enabled(StateSet::new(State::Focusable | State::Showing)));
	}

	#[test]
	fn placement_fits_the_frame_to_its_native_window() {
		let window =
			NativeGeometry { x: 300, y: 200, width: 890, height: 550, shadow: [0; 4] };
		assert_eq!(
			placement(890, 550, &window),
			Some(Placement { x: 300, y: 200, width: 890, height: 550 })
		);
		// GTK4's window coordinates start inside the shadow it draws.
		let shadowed = NativeGeometry { width: 942, height: 604, shadow: [26, 26, 23, 31], ..window };
		assert_eq!(
			placement(890, 550, &shadowed),
			Some(Placement { x: 326, y: 223, width: 890, height: 550 })
		);
		assert_eq!(placement(400, 300, &shadowed), None);
		assert!(Placement { x: 300, y: 200, width: 890, height: 550 }.contains(300, 749));
		assert!(!Placement { x: 300, y: 200, width: 890, height: 550 }.contains(1190, 400));
	}

	const PEER: &str = ":1.7";

	type Rect = (i32, i32, i32, i32);

	const fn inside((left, top, width, height): Rect, x: i32, y: i32) -> bool {
		x >= left && y >= top && x < left + width && y < top + height
	}

	fn object_path(path: &str) -> atspi::zbus::zvariant::OwnedObjectPath {
		atspi::zbus::zvariant::OwnedObjectPath::try_from(path).unwrap()
	}

	/// A fake `org.a11y.atspi.Accessible` with its role, name and parent.
	struct Node {
		role:   Role,
		name:   &'static str,
		parent: &'static str,
	}

	#[atspi::zbus::interface(name = "org.a11y.atspi.Accessible")]
	impl Node {
		fn get_role(&self) -> u32 {
			self.role as u32
		}

		#[allow(clippy::unused_self, reason = "every fake node has a Component")]
		fn get_interfaces(&self) -> Vec<&'static str> {
			vec!["org.a11y.atspi.Accessible", "org.a11y.atspi.Component"]
		}

		#[zbus(property)]
		fn name(&self) -> String {
			self.name.to_owned()
		}

		#[zbus(property)]
		fn parent(&self) -> (String, atspi::zbus::zvariant::OwnedObjectPath) {
			(PEER.to_owned(), object_path(self.parent))
		}
	}

	/// A fake `org.a11y.atspi.Component`. `lies` answers `Contains` true for
	/// any point, as GTK4 does; `at_point` lists, per coordinate type, where
	/// `GetAccessibleAtPoint` names which child.
	struct Extents {
		screen:   Rect,
		window:   Rect,
		lies:     bool,
		popup:    bool,
		at_point: Vec<(CoordType, Rect, &'static str)>,
	}

	impl Extents {
		/// What GTK4 reports for an element at `window`: screen `0,0`.
		fn gtk4(window: Rect) -> Self {
			let (.., width, height) = window;
			Self { screen: (0, 0, width, height), window, lies: true, popup: false, at_point: vec![] }
		}

		/// What a toolkit that reports screen positions does.
		fn placed(screen: Rect, window: Rect) -> Self {
			Self { screen, window, lies: false, popup: false, at_point: vec![] }
		}

		fn at(mut self, coords: CoordType, rect: Rect, child: &'static str) -> Self {
			self.at_point.push((coords, rect, child));
			self
		}
	}

	#[atspi::zbus::interface(name = "org.a11y.atspi.Component")]
	impl Extents {
		fn get_extents(&self, coords: u32) -> Rect {
			if coords == CoordType::Window as u32 {
				self.window
			} else {
				self.screen
			}
		}

		fn contains(&self, x: i32, y: i32, coords: u32) -> bool {
			self.lies || inside(self.get_extents(coords), x, y)
		}

		fn get_accessible_at_point(
			&self,
			x: i32,
			y: i32,
			coords: u32,
		) -> (String, atspi::zbus::zvariant::OwnedObjectPath) {
			let child = self
				.at_point
				.iter()
				.find(|(at, rect, _)| *at as u32 == coords && inside(*rect, x, y))
				.map_or("/org/a11y/atspi/null", |(.., child)| child);
			(PEER.to_owned(), object_path(child))
		}

		fn get_layer(&self) -> u32 {
			if self.popup {
				Layer::Popup as u32
			} else {
				Layer::Widget as u32
			}
		}
	}

	/// The bus daemon's process lookup, for the frames' process.
	struct Bus {
		pid: u32,
	}

	#[atspi::zbus::interface(name = "org.freedesktop.DBus")]
	impl Bus {
		#[zbus(name = "GetConnectionUnixProcessID")]
		fn pid(&self, name: String) -> u32 {
			assert_eq!(name, PEER);
			self.pid
		}
	}

	/// The display server's windows, all 890x550 and of process 7, and how
	/// many geometry reads it answered.
	struct Native(std::sync::Mutex<Vec<DesktopWindow>>, std::sync::atomic::AtomicU32);

	impl Native {
		fn new(windows: &[(&str, &str, i32, i32)]) -> Self {
			let windows = windows
				.iter()
				.map(|&(id, title, x, y)| window(id, title, x, y));
			Self(std::sync::Mutex::new(windows.collect()), std::sync::atomic::AtomicU32::new(0))
		}

		fn reads(&self) -> u32 {
			self.1.load(std::sync::atomic::Ordering::Relaxed)
		}
	}

	fn window(id: &str, title: &str, x: i32, y: i32) -> DesktopWindow {
		DesktopWindow {
			id: id.into(),
			pid: Some(7),
			title: title.into(),
			app: "app".into(),
			x,
			y,
			width: 890,
			height: 550,
			focused: false,
		}
	}

	impl NativeWindows for Native {
		fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
			Ok(self.0.lock().unwrap().clone())
		}

		fn geometry(&self, id: &str) -> Option<NativeGeometry> {
			self.1.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
			let windows = self.0.lock().unwrap();
			let window = windows.iter().find(|window| window.id == id)?;
			Some(NativeGeometry {
				x:      window.x,
				y:      window.y,
				width:  window.width,
				height: window.height,
				shadow: [0; 4],
			})
		}
	}

	/// Serves `tree` as process 7 and returns the server and a client
	/// connection to it.
	async fn serve(
		tree: Vec<(&'static str, Node, Option<Extents>)>,
	) -> (atspi::zbus::Connection, atspi::zbus::Connection) {
		use atspi::zbus::connection::Builder as ConnectionBuilder;

		let (client, server) = tokio::net::UnixStream::pair().unwrap();
		let mut server = ConnectionBuilder::unix_stream(server)
			.server(atspi::zbus::Guid::generate())
			.unwrap()
			.p2p()
			.serve_at("/org/freedesktop/DBus", Bus { pid: 7 })
			.unwrap();
		for (path, node, extents) in tree {
			server = server.serve_at(path, node).unwrap();
			if let Some(extents) = extents {
				server = server.serve_at(path, extents).unwrap();
			}
		}
		let client = ConnectionBuilder::unix_stream(client).p2p().build();
		tokio::try_join!(server.build(), client).unwrap()
	}

	fn node(role: Role, name: &'static str, parent: &'static str) -> Node {
		Node { role, name, parent }
	}

	fn object(path: &'static str) -> ObjectRefOwned {
		ObjectRefOwned::from_static_str_unchecked(PEER, path)
	}

	async fn read_bounds(
		cache: &mut FrameCache,
		client: &atspi::zbus::Connection,
		native: Option<&dyn NativeWindows>,
		path: &'static str,
	) -> Option<(f64, f64, f64, f64)> {
		let bounds = cache.screen_bounds(client, native, &object(path)).await?;
		Some((bounds.x, bounds.y, bounds.width, bounds.height))
	}

	#[test]
	fn elements_reported_at_the_screen_origin_are_placed_by_their_window() {
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (bounds, walk_reads) = rt.block_on(async {
			// What Files (GTK 4.14) reports, with an open popover, and a control
			// of a toolkit that reports real screen positions.
			let (server, client) = serve(vec![
				("/app", node(Role::Application, "org.gnome.Nautilus", "/null"), None),
				("/frame", node(Role::Frame, "Desktop", "/app"), Some(Extents::gtk4((0, 0, 890, 550)))),
				("/list", node(Role::List, "", "/frame"), None),
				(
					"/downloads",
					node(Role::ListItem, "Downloads", "/list"),
					Some(Extents::gtk4((6, 242, 168, 36))),
				),
				(
					"/placed",
					node(Role::Button, "Open", "/frame"),
					Some(Extents::placed((280, 75, 67, 46), (15, 3, 67, 46))),
				),
				(
					"/popover",
					node(Role::Menu, "", "/frame"),
					Some(Extents { popup: true, ..Extents::gtk4((614, 6, 250, 322)) }),
				),
				(
					"/item",
					node(Role::MenuItem, "", "/popover"),
					Some(Extents::gtk4((662, 52, 190, 32))),
				),
			])
			.await;
			let native = Native::new(&[("42", "Desktop", 300, 200)]);
			let mut cache = FrameCache::default();
			let mut bounds = Vec::new();
			for path in ["/downloads", "/frame", "/placed", "/item"] {
				bounds.push(read_bounds(&mut cache, &client, Some(&native), path).await);
			}
			// One walk reads the frame's window once, whatever it places.
			let walk_reads = native.reads();
			// The window was replaced by one elsewhere before the next operation.
			*native.0.lock().unwrap() = vec![window("43", "Desktop", 500, 100)];
			cache.refresh();
			bounds.push(read_bounds(&mut cache, &client, Some(&native), "/downloads").await);
			// Without a display server that knows (Wayland), as reported.
			bounds.push(read_bounds(&mut cache, &client, None, "/downloads").await);
			drop(server);
			(bounds, walk_reads)
		});
		assert_eq!(walk_reads, 1);
		assert_eq!(bounds, [
			Some((306.0, 442.0, 168.0, 36.0)),
			Some((300.0, 200.0, 890.0, 550.0)),
			Some((280.0, 75.0, 67.0, 46.0)),
			// GTK 4.14 measures a popover from the widget it hangs off.
			Some((0.0, 0.0, 190.0, 32.0)),
			Some((506.0, 342.0, 168.0, 36.0)),
			Some((0.0, 0.0, 168.0, 36.0)),
		]);
	}

	#[test]
	fn gtk4_frames_are_hit_tested_where_their_window_is() {
		let rt = Builder::new_current_thread().enable_all().build().unwrap();
		let (claims, found) = rt.block_on(async {
			let (server, client) = serve(vec![
				("/app", node(Role::Application, "app", "/null"), None),
				(
					"/frame",
					node(Role::Frame, "Desktop", "/app"),
					Some(Extents::gtk4((0, 0, 890, 550)).at(
						CoordType::Window,
						(6, 242, 168, 36),
						"/downloads",
					)),
				),
				(
					"/downloads",
					node(Role::ListItem, "Downloads", "/frame"),
					// GTK4 offsets the point again below the frame and names a
					// child the point is not in.
					Some(Extents::gtk4((6, 242, 168, 36)).at(
						CoordType::Window,
						(0, 0, 890, 550),
						"/stray",
					)),
				),
				(
					"/stray",
					node(Role::Label, "", "/downloads"),
					Some(Extents::gtk4((700, 500, 10, 10))),
				),
				// A GTK4 window the display server does not show (minimized).
				("/hidden", node(Role::Frame, "Hidden", "/app"), Some(Extents::gtk4((0, 0, 890, 550)))),
				// A toolkit that reports screen positions, its window at 0,0.
				(
					"/editor",
					node(Role::Frame, "Editor", "/app"),
					Some(Extents::placed((0, 0, 400, 300), (0, 0, 400, 300)).at(
						CoordType::Screen,
						(10, 10, 50, 20),
						"/open",
					)),
				),
				(
					"/open",
					node(Role::Button, "Open", "/editor"),
					Some(Extents::placed((10, 10, 50, 20), (10, 10, 50, 20))),
				),
			])
			.await;
			let windows = Native::new(&[("42", "Desktop", 300, 200)]);
			let native: Option<&dyn NativeWindows> = Some(&windows);
			let mut cache = FrameCache::default();
			let mut claims = Vec::new();
			for (path, x, y, native) in [
				("/frame", 390, 460, native),
				("/frame", 1250, 100, native),
				("/hidden", 390, 460, native),
				("/editor", 20, 15, native),
				("/editor", 500, 500, native),
				// Without a display server that knows (Wayland), as on `main`.
				("/frame", 1250, 100, None),
			] {
				claims.push(
					cache
						.claim(&client, native, &object(path), x, y)
						.await
						.unwrap(),
				);
			}
			// The hidden window is shown again: the next operation finds it.
			windows
				.0
				.lock()
				.unwrap()
				.push(window("44", "Hidden", 100, 50));
			cache.refresh();
			claims.push(
				cache
					.claim(&client, native, &object("/hidden"), 390, 460)
					.await
					.unwrap(),
			);
			let mut found = Vec::new();
			for (path, placement, x, y) in
				[("/frame", claims[0].flatten(), 390, 460), ("/editor", None, 20, 15)]
			{
				let element = AtSpiAx::descend(&client, object(path), placement, x, y, REPLY_TIMEOUT)
					.await
					.unwrap();
				found.push(element.map(|element| AtSpiAx::object(&element).path_as_str().to_owned()));
			}
			drop(server);
			(claims, found)
		});
		let placed = Placement { x: 300, y: 200, width: 890, height: 550 };
		let shown = Placement { x: 100, y: 50, width: 890, height: 550 };
		assert_eq!(claims, [
			Some(Some(placed)),
			None,
			None,
			Some(None),
			None,
			Some(None),
			Some(Some(shown)),
		]);
		assert_eq!(found, [Some("/downloads".to_owned()), Some("/open".to_owned())]);
	}

	mod unanswered {
		use atspi::zbus::{
			Guid, connection::Builder as ConnectionBuilder, interface, zvariant::OwnedObjectPath,
		};

		use super::*;
		use crate::desktop::control;

		const PEER: &str = ":1.7";
		/// Long enough for every call this process answers itself.
		const HUNG_CALL_TIMEOUT: Duration = Duration::from_secs(1);

		fn path(p: &str) -> OwnedObjectPath {
			OwnedObjectPath::try_from(p).unwrap()
		}

		/// The backend over a peer-to-peer connection to what `serve` serves.
		fn backend(
			reply_timeout: Duration,
			serve: impl FnOnce(ConnectionBuilder<'static>) -> ConnectionBuilder<'static>,
		) -> (AtSpiAx, Connection) {
			let rt = Builder::new_current_thread().enable_all().build().unwrap();
			let (server, connection) = rt.block_on(async {
				let (client, server) = tokio::net::UnixStream::pair().unwrap();
				let server = ConnectionBuilder::unix_stream(server)
					.server(Guid::generate())
					.unwrap()
					.p2p();
				let client = ConnectionBuilder::unix_stream(client).p2p().build();
				tokio::try_join!(serve(server).build(), client).unwrap()
			});
			(
				AtSpiAx { rt, connection, reply_timeout, native: None, frames: FrameCache::default() },
				server,
			)
		}

		/// An element of an application that answers no method call, as a GTK 3
		/// app does while a dialog an accessibility action opened is up. (It
		/// has no properties: the server answers those inline, so a property
		/// that never answers would silence every other element too.)
		struct Silent {
			/// Cancelled when the first call arrives, as the host cancels a run
			/// that times out.
			cancel: Option<control::CancellationSource>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Silent {
			async fn get_role_name(&self) -> String {
				if let Some(cancel) = &self.cancel {
					cancel.cancel();
				}
				std::future::pending().await
			}

			async fn get_state(&self) -> Vec<u32> {
				std::future::pending().await
			}

			async fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				std::future::pending().await
			}
		}

		struct Element {
			delay:    Duration,
			name:     &'static str,
			role:     Role,
			focused:  bool,
			children: Vec<(String, OwnedObjectPath)>,
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl Element {
			#[zbus(property)]
			fn name(&self) -> String {
				self.name.to_owned()
			}

			async fn get_role(&self) -> u32 {
				tokio::time::sleep(self.delay).await;
				self.role as u32
			}

			async fn get_state(&self) -> Vec<u32> {
				tokio::time::sleep(self.delay).await;
				let state = if self.focused {
					State::Focused as u64
				} else {
					0
				};
				vec![state as u32, (state >> 32) as u32]
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self.children.clone()
			}
		}

		/// A frame at `(x, y)` on screen, and at the origin in window
		/// coordinates.
		struct Extents {
			x:     i32,
			y:     i32,
			delay: Duration,
		}

		#[interface(name = "org.a11y.atspi.Component")]
		impl Extents {
			async fn get_extents(&self, coord_type: u32) -> (i32, i32, i32, i32) {
				tokio::time::sleep(self.delay).await;
				if coord_type == CoordType::Window as u32 {
					(0, 0, 300, 200)
				} else {
					(self.x, self.y, 300, 200)
				}
			}
		}

		fn silent_element(
			reply_timeout: Duration,
			cancel: Option<control::CancellationSource>,
		) -> (AtSpiAx, Connection) {
			backend(reply_timeout, |server| server.serve_at("/silent", Silent { cancel }).unwrap())
		}

		#[test]
		fn a_request_the_application_never_answers_times_out() {
			let (mut ax, _server) = silent_element(HUNG_CALL_TIMEOUT, None);
			let element = AxHandle::AtSpi(ObjectRefOwned::from_static_str_unchecked(PEER, "/silent"));
			assert_eq!(ax.props(&element).unwrap_err().code, ErrorCode::Timeout);
		}

		#[test]
		fn a_cancel_frees_a_request_the_application_never_answers() {
			let source = control::CancellationSource::default();
			let (mut ax, _server) = silent_element(REPLY_TIMEOUT, Some(source.clone()));
			let element = AxHandle::AtSpi(ObjectRefOwned::from_static_str_unchecked(PEER, "/silent"));
			let error =
				control::with_token_for_test(&source.token(), || ax.props(&element)).unwrap_err();
			assert_eq!(error.code, ErrorCode::Cancelled);
		}

		#[test]
		fn interrupted_masked_text_write_warns_if_the_field_may_be_empty() {
			use std::sync::{Arc, Mutex};

			struct Accessible([&'static str; 2]);
			#[interface(name = "org.a11y.atspi.Accessible")]
			impl Accessible {
				fn get_interfaces(&self) -> &[&str] {
					&self.0
				}
			}

			struct Text(Arc<Mutex<String>>);
			#[interface(name = "org.a11y.atspi.Text")]
			impl Text {
				#[zbus(property)]
				fn character_count(&self) -> i32 {
					self.0.lock().unwrap().chars().count() as i32
				}

				fn get_text(&self, start_offset: i32, end_offset: i32) -> String {
					std::iter::repeat_n('●', self.0.lock().unwrap().chars().count())
						.skip(start_offset as usize)
						.take((end_offset - start_offset) as usize)
						.collect()
				}
			}

			struct Editable {
				text:    Arc<Mutex<String>>,
				count:   Mutex<usize>,
				stop_at: usize,
				cancel:  Option<control::CancellationSource>,
			}
			#[interface(name = "org.a11y.atspi.EditableText")]
			impl Editable {
				async fn set_text_contents(&self, text: String) -> bool {
					let count = {
						let mut count = self.count.lock().unwrap();
						*count += 1;
						*count
					};
					if count == self.stop_at {
						if let Some(cancel) = &self.cancel {
							cancel.cancel();
						}
						return std::future::pending().await;
					}
					*self.text.lock().unwrap() = text;
					true
				}
			}

			// Before any clear, during the clear, and during the rewrite.
			for stop_at in 1..=3 {
				for cancelled in [false, true] {
					let source = control::CancellationSource::default();
					let text = Arc::new(Mutex::new("old secret".to_owned()));
					let (mut ax, _server) = backend(HUNG_CALL_TIMEOUT, |server| {
						server
							.serve_at(
								"/password",
								Accessible(["org.a11y.atspi.EditableText", "org.a11y.atspi.Text"]),
							)
							.unwrap()
							.serve_at("/password", Text(text.clone()))
							.unwrap()
							.serve_at("/password", Editable {
								text: text.clone(),
								count: Mutex::new(0),
								stop_at,
								cancel: cancelled.then(|| source.clone()),
							})
							.unwrap()
					});
					let element =
						AxHandle::AtSpi(ObjectRefOwned::from_static_str_unchecked(PEER, "/password"));
					let error = control::with_token_for_test(&source.token(), || {
						ax.set_value(&element, "new secret")
					})
					.unwrap_err();
					assert_eq!(
						error.code,
						if cancelled {
							ErrorCode::Cancelled
						} else {
							ErrorCode::Timeout
						}
					);
					assert_eq!(
						error.message.contains("may now be empty"),
						stop_at == 3,
						"stop_at={stop_at}, cancelled={cancelled}: {error:?}"
					);
					assert!(!error.message.contains("old secret"));
					assert!(!error.message.contains("new secret"));
					if stop_at == 3 {
						assert!(text.lock().unwrap().is_empty());
					}
				}
			}
		}

		/// A desktop of two applications: one that answers nothing on bus
		/// `:1.8`, listed first, and an editor whose document frame, at
		/// `(10, 20)` on screen, has the focus when `focused`. (A peer-to-peer
		/// connection ignores the destination, so this process serves both.)
		fn desktop(focused: bool) -> (AtSpiAx, Connection) {
			desktop_with_delay(focused, Duration::ZERO)
		}

		fn desktop_with_delay(focused: bool, delay: Duration) -> (AtSpiAx, Connection) {
			backend(HUNG_CALL_TIMEOUT, |server| {
				server
					.serve_at("/org/a11y/atspi/accessible/root", Element {
						delay:    Duration::ZERO,
						name:     "main",
						role:     Role::DesktopFrame,
						focused:  false,
						children: vec![
							(":1.8".to_owned(), path("/silent")),
							(PEER.to_owned(), path("/editor")),
						],
					})
					.unwrap()
					.serve_at("/silent", Silent { cancel: None })
					.unwrap()
					.serve_at("/editor", Element {
						delay:    Duration::ZERO,
						name:     "Editor",
						role:     Role::Application,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor/frame"))],
					})
					.unwrap()
					.serve_at("/editor/frame", Element {
						delay: Duration::ZERO,
						name: "Document",
						role: Role::Frame,
						focused,
						children: Vec::new(),
					})
					.unwrap()
					.serve_at("/editor/frame", Extents { x: 10, y: 20, delay })
					.unwrap()
			})
		}

		fn slow_tree() -> (AtSpiAx, Connection, DesktopWindow) {
			let (ax, server) = backend(HUNG_CALL_TIMEOUT, |server| {
				server
					.serve_at("/org/a11y/atspi/accessible/root", Element {
						delay:    Duration::ZERO,
						name:     "main",
						role:     Role::DesktopFrame,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor"))],
					})
					.unwrap()
					.serve_at("/editor", Element {
						delay:    Duration::ZERO,
						name:     "Editor",
						role:     Role::Application,
						focused:  false,
						children: vec![
							(PEER.to_owned(), path("/editor/frame")),
							(PEER.to_owned(), path("/editor/other")),
						],
					})
					.unwrap()
					.serve_at("/editor/frame", Element {
						delay:    Duration::from_millis(600),
						name:     "",
						role:     Role::Frame,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor/frame/entry"))],
					})
					.unwrap()
					.serve_at("/editor/other", Element {
						delay:    Duration::from_millis(600),
						name:     "",
						role:     Role::Frame,
						focused:  false,
						children: Vec::new(),
					})
					.unwrap()
					.serve_at("/editor/frame/entry", Element {
						delay:    Duration::from_millis(600),
						name:     "",
						role:     Role::Entry,
						focused:  true,
						children: Vec::new(),
					})
					.unwrap()
			});
			let window = DesktopWindow {
				id:      format!("atspi:{PEER}:/editor/frame"),
				title:   String::new(),
				app:     "Editor".to_owned(),
				pid:     None,
				x:       0,
				y:       0,
				width:   300,
				height:  200,
				focused: true,
			};
			(ax, server, window)
		}

		#[test]
		fn focus_scan_keeps_a_responsive_tree_past_one_reply_limit() {
			let (ax, _server, window) = slow_tree();
			assert!(ax.holds_focus(&window));
		}

		#[test]
		fn window_root_keeps_a_responsive_frame_scan_past_one_reply_limit() {
			let (mut ax, _server, window) = slow_tree();
			let root = ax.window_root(&window).unwrap();
			assert_eq!(AtSpiAx::object(&root).path_as_str(), "/editor/frame");
		}

		#[test]
		fn windows_keep_an_application_whose_replies_together_exceed_the_limit() {
			let (ax, _server) = desktop_with_delay(true, Duration::from_millis(600));
			let listed = ax.windows().unwrap();
			assert_eq!(listed.windows.len(), 1);
			assert_eq!(listed.windows[0].window.title, "Document");
			assert_eq!(listed.unanswered, [":1.8"]);
		}

		#[test]
		fn windows_and_focus_leave_out_an_application_that_never_answers() {
			let (mut ax, _server) = desktop(true);
			let listed = ax.windows().unwrap();
			assert_eq!(
				listed
					.windows
					.iter()
					.map(|listed| (listed.window.app.as_str(), listed.window.title.as_str()))
					.collect::<Vec<_>>(),
				[("Editor", "Document")]
			);
			assert_eq!(listed.unanswered, [":1.8"]);
			let Some(AxHandle::AtSpi(focused)) = ax.focused_element().unwrap() else {
				panic!("the answering application's focus must be found");
			};
			assert_eq!(focused.path_as_str(), "/editor/frame");
		}

		#[test]
		fn applications_that_never_answer_cost_the_listing_one_reply_limit_together() {
			let (ax, _server) = backend(HUNG_CALL_TIMEOUT, |server| {
				server
					.serve_at("/org/a11y/atspi/accessible/root", Element {
						delay:    Duration::ZERO,
						name:     "main",
						role:     Role::DesktopFrame,
						focused:  false,
						children: (0..3)
							.map(|index| (format!(":1.{}", 8 + index), path(&format!("/silent{index}"))))
							.collect(),
					})
					.unwrap()
					.serve_at("/silent0", Silent { cancel: None })
					.unwrap()
					.serve_at("/silent1", Silent { cancel: None })
					.unwrap()
					.serve_at("/silent2", Silent { cancel: None })
					.unwrap()
			});
			let started = std::time::Instant::now();
			let listed = ax.windows().unwrap();
			assert_eq!(listed.unanswered, [":1.8", ":1.9", ":1.10"]);
			assert!(started.elapsed() < HUNG_CALL_TIMEOUT * 2, "{:?}", started.elapsed());
		}

		#[test]
		fn focus_found_nowhere_else_may_be_in_an_application_that_never_answers() {
			let (mut ax, _server) = desktop(false);
			assert_eq!(ax.focused_element().err().map(|error| error.code), Some(ErrorCode::Timeout));
		}

		#[test]
		fn a_point_an_application_that_never_answers_may_own_is_not_resolved() {
			let (mut ax, _server) = desktop(true);
			assert_eq!(
				ax.element_at(50.0, 50.0).err().map(|error| error.code),
				Some(ErrorCode::Timeout)
			);
		}

		/// A menu bar that names its parent frame and then answers no method
		/// call.
		struct SilentMenuBar {
			parent: (String, OwnedObjectPath),
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl SilentMenuBar {
			#[zbus(property)]
			fn parent(&self) -> (String, OwnedObjectPath) {
				self.parent.clone()
			}

			async fn get_role(&self) -> u32 {
				std::future::pending().await
			}
		}

		#[test]
		fn a_menu_read_fails_when_the_application_stops_answering_part_way() {
			let (mut ax, _server) = backend(HUNG_CALL_TIMEOUT, |server| {
				server
					.serve_at("/org/a11y/atspi/accessible/root", Element {
						delay:    Duration::ZERO,
						name:     "main",
						role:     Role::DesktopFrame,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor"))],
					})
					.unwrap()
					.serve_at("/editor", Element {
						delay:    Duration::ZERO,
						name:     "Editor",
						role:     Role::Application,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/editor/frame"))],
					})
					.unwrap()
					.serve_at("/editor/frame", Element {
						delay:    Duration::ZERO,
						name:     "Document",
						role:     Role::Frame,
						focused:  true,
						children: vec![(PEER.to_owned(), path("/editor/frame/menubar"))],
					})
					.unwrap()
					.serve_at("/editor/frame/menubar", SilentMenuBar {
						parent: (PEER.to_owned(), path("/editor/frame")),
					})
					.unwrap()
			});
			let window = DesktopWindow {
				id:      format!("atspi:{PEER}:/editor/frame"),
				title:   "Document".into(),
				app:     "Editor".into(),
				pid:     None,
				x:       0,
				y:       0,
				width:   300,
				height:  200,
				focused: true,
			};
			assert_eq!(
				ax.menu_items(&window, &[]).err().map(|error| error.code),
				Some(ErrorCode::Timeout)
			);
		}

		/// A menu element that names its parent, as `menu_children` checks.
		struct MenuNode {
			name:     &'static str,
			role:     Role,
			parent:   &'static str,
			children: &'static [&'static str],
		}

		#[interface(name = "org.a11y.atspi.Accessible")]
		impl MenuNode {
			#[zbus(property)]
			fn name(&self) -> String {
				self.name.to_owned()
			}

			#[zbus(property)]
			fn parent(&self) -> (String, OwnedObjectPath) {
				(PEER.to_owned(), path(self.parent))
			}

			fn get_role(&self) -> u32 {
				self.role as u32
			}

			#[allow(clippy::unused_self, reason = "every fake menu element is enabled")]
			fn get_state(&self) -> Vec<u32> {
				let state = State::Enabled as u64 | State::Sensitive as u64;
				vec![state as u32, (state >> 32) as u32]
			}

			fn get_children(&self) -> Vec<(String, OwnedObjectPath)> {
				self
					.children
					.iter()
					.map(|child| (PEER.to_owned(), path(child)))
					.collect()
			}
		}

		/// Qt 5 and 6 publish a menu bar item's menu as a `PopupMenu` child of
		/// that item, where GTK publishes a `Menu`.
		#[test]
		fn a_qt_menu_bar_item_opens_its_popup_menu() {
			let (mut ax, _server) = backend(HUNG_CALL_TIMEOUT, |server| {
				let menu = |name, role, parent, children: &'static [&'static str]| MenuNode {
					name,
					role,
					parent,
					children,
				};
				server
					.serve_at("/org/a11y/atspi/accessible/root", Element {
						delay:    Duration::ZERO,
						name:     "main",
						role:     Role::DesktopFrame,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/qt"))],
					})
					.unwrap()
					.serve_at("/qt", Element {
						delay:    Duration::ZERO,
						name:     "qtapp",
						role:     Role::Application,
						focused:  false,
						children: vec![(PEER.to_owned(), path("/qt/frame"))],
					})
					.unwrap()
					.serve_at("/qt/frame", Element {
						delay:    Duration::ZERO,
						name:     "Notes",
						role:     Role::Frame,
						focused:  true,
						children: vec![(PEER.to_owned(), path("/qt/bar"))],
					})
					.unwrap()
					.serve_at("/qt/bar", menu("", Role::MenuBar, "/qt/frame", &["/qt/file"]))
					.unwrap()
					.serve_at("/qt/file", menu("File", Role::MenuItem, "/qt/bar", &["/qt/popup"]))
					.unwrap()
					.serve_at(
						"/qt/popup",
						menu("", Role::PopupMenu, "/qt/file", &["/qt/mark", "/qt/other"]),
					)
					.unwrap()
					.serve_at("/qt/mark", menu("Mark", Role::MenuItem, "/qt/popup", &[]))
					.unwrap()
					.serve_at("/qt/other", menu("Other", Role::MenuItem, "/qt/popup", &[]))
					.unwrap()
			});
			let window = DesktopWindow {
				id:      format!("atspi:{PEER}:/qt/frame"),
				title:   "Notes".into(),
				app:     "qtapp".into(),
				pid:     None,
				x:       0,
				y:       0,
				width:   300,
				height:  200,
				focused: true,
			};
			let bar = ax.menu_items(&window, &[]).unwrap();
			assert_eq!(
				bar.iter()
					.map(|item| (item.title.as_str(), item.has_submenu))
					.collect::<Vec<_>>(),
				[("File", true)]
			);
			let file = ax.menu_items(&window, &["File".to_owned()]).unwrap();
			assert_eq!(
				file
					.iter()
					.map(|item| (item.path.join(" > "), item.has_submenu))
					.collect::<Vec<_>>(),
				[("File > Mark".to_owned(), false), ("File > Other".to_owned(), false)]
			);
		}
	}
}
