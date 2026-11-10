use std::collections::HashMap;

use atspi::{
	CoordType, Layer, ObjectRefOwned, Role, State, StateSet, proxy::accessible::ObjectRefExt, zbus,
	zbus::names::UniqueName,
};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, WalkBounds, normalize_role_atspi, text_readback},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

mod menus;

pub struct AtSpiAx {
	rt:         Runtime,
	connection: atspi::AccessibilityConnection,
	/// The display server's own list of windows, where it knows where each one
	/// is (X11).
	native:     Option<Box<dyn NativeWindows>>,
	frames:     FrameCache,
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
pub fn resolve_focus(
	windows: &mut [AtSpiWindow],
	compositor_pid: Option<u32>,
	mut holds_focus: impl FnMut(&DesktopWindow) -> bool,
) {
	let mut active: Vec<usize> = (0..windows.len())
		.filter(|&index| windows[index].window.focused)
		.collect();
	if active.len() < 2 {
		return;
	}
	let all_active = active.clone();
	if compositor_pid.is_some() {
		active.retain(|&index| windows[index].window.pid != compositor_pid);
	}
	if active.len() > 1 {
		let titled: Vec<usize> = active
			.iter()
			.copied()
			.filter(|&index| !windows[index].window.title.trim().is_empty())
			.collect();
		active = if titled.is_empty() {
			active
				.into_iter()
				.filter(|&index| holds_focus(&windows[index].window))
				.collect()
		} else {
			titled
		};
	}
	let focused = match active.as_slice() {
		[only] => Some(*only),
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
		let connection = rt
			.block_on(atspi::AccessibilityConnection::new())
			.map_err(|err| DesktopError::ax_failed(format!("AT-SPI connection: {err}")))?;
		Ok(Self { rt, connection, native: None, frames: FrameCache::default() })
	}

	/// Places elements of toolkits that cannot report screen positions by
	/// where `native` says their window is.
	pub(crate) fn with_native_windows(mut self, native: Box<dyn NativeWindows>) -> Self {
		self.native = Some(native);
		self
	}

	const fn object(h: &AxHandle) -> &ObjectRefOwned {
		match h {
			AxHandle::AtSpi(object) => object,
			#[cfg(test)]
			_ => panic!("AT-SPI backend received a non-AT-SPI handle"),
		}
	}

	pub(crate) fn windows(&self) -> CoreResult<Vec<AtSpiWindow>> {
		self.rt.block_on(async {
			let mut windows = Vec::new();
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				let app_proxy = app
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI application: {err}")))?;
				let app_name = app_proxy.name().await.unwrap_or_default();
				let pid = if let Some(bus_name) = app.name() {
					let dbus = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
						.await
						.ok();
					if let Some(dbus) = dbus {
						dbus
							.get_connection_unix_process_id(bus_name.clone().into())
							.await
							.ok()
					} else {
						None
					}
				} else {
					None
				};
				for frame in Self::frames(&self.connection, &app)
					.await
					.unwrap_or_default()
				{
					let frame_proxy = frame
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI frame: {err}")))?;
					let title = frame_proxy.name().await.unwrap_or_default();
					let state = frame_proxy.get_state().await.ok();
					let Ok(component) = Self::component(self.connection.connection(), &frame).await
					else {
						continue;
					};
					let Ok((x, y, width, height)) = component.get_extents(CoordType::Screen).await
					else {
						continue;
					};
					if width < 16 || height < 16 {
						continue;
					}
					let position_known = component
						.get_extents(CoordType::Window)
						.await
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
					if windows.len() == 48 {
						return Ok(windows);
					}
				}
			}
			Ok(windows)
		})
	}

	/// Whether the window's frame contains the keyboard-focused element. A
	/// lookup that fails counts as not holding focus.
	pub(crate) fn holds_focus(&self, window: &DesktopWindow) -> bool {
		self.rt.block_on(async {
			let Ok(app) = Self::app_for_window(&self.connection, window).await else {
				return false;
			};
			let Ok(frames) = Self::frames(&self.connection, &app).await else {
				return false;
			};
			for frame in frames {
				if atspi_window_id(&frame) == window.id {
					return Self::find_focused(self.connection.connection(), frame, 0)
						.await
						.is_ok_and(|found| found.is_some());
				}
			}
			false
		})
	}

	async fn apps(
		connection: &atspi::AccessibilityConnection,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let root = connection
			.root_accessible_on_registry()
			.await
			.map_err(|err| err.to_string())?;
		root.get_children().await.map_err(|err| err.to_string())
	}

	async fn app_for_window(
		connection: &atspi::AccessibilityConnection,
		win: &DesktopWindow,
	) -> Result<ObjectRefOwned, String> {
		let apps = Self::apps(connection).await?;
		let mut matches = Vec::new();
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
			let proxy = app
				.as_accessible_proxy(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			let name = proxy.name().await.unwrap_or_default();
			if win.pid.is_none() && name.eq_ignore_ascii_case(&win.app) {
				matches.push(app.clone());
			}
			if let Some(pid) = win.pid {
				let Some(bus_name) = app.name() else {
					continue;
				};
				let dbus = atspi::zbus::fdo::DBusProxy::new(connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				if dbus
					.get_connection_unix_process_id(bus_name.clone().into())
					.await
					.ok()
					== Some(pid)
				{
					matches.push(app);
				}
			}
		}
		if matches.len() == 1 {
			Ok(matches.remove(0))
		} else {
			Err(format!(
				"application '{}' (pid {:?}) has {} AT-SPI matches; refusing ambiguous ownership",
				win.app,
				win.pid,
				matches.len()
			))
		}
	}

	async fn frames(
		connection: &atspi::AccessibilityConnection,
		app: &ObjectRefOwned,
	) -> Result<Vec<ObjectRefOwned>, String> {
		Self::top_levels(connection.connection(), app).await
	}

	/// `app`'s children that are top-level windows.
	async fn top_levels(
		connection: &atspi::zbus::Connection,
		app: &ObjectRefOwned,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let proxy = app
			.as_accessible_proxy(connection)
			.await
			.map_err(|err| err.to_string())?;
		let children = proxy.get_children().await.map_err(|err| err.to_string())?;
		let mut frames = Vec::new();
		for child in children {
			let child_proxy = child
				.as_accessible_proxy(connection)
				.await
				.map_err(|err| err.to_string())?;
			if child_proxy
				.get_role()
				.await
				.is_ok_and(|role| top_level_role(role, true))
			{
				frames.push(child);
			}
		}
		Ok(frames)
	}

	async fn component<'a>(
		connection: &'a zbus::Connection,
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
	/// reads properties with `GetAll`, which Qt refuses, so `NActions` would
	/// fail on every Qt element.
	async fn action<'a>(
		connection: &'a atspi::zbus::Connection,
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
		connection: &atspi::zbus::Connection,
		mut object: ObjectRefOwned,
	) -> CoreResult<ObjectRefOwned> {
		for _ in 0..64 {
			let proxy = object
				.as_accessible_proxy(connection)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window owner: {err}")))?;
			let role = proxy
				.get_role()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window role: {err}")))?;
			if top_level_role(role, false) {
				return Ok(object);
			}
			let parent = proxy
				.parent()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window parent: {err}")))?;
			if top_level_role(role, true) && Self::is_application(connection, &parent).await {
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

	async fn is_application(connection: &atspi::zbus::Connection, object: &ObjectRefOwned) -> bool {
		if object.is_null() {
			return false;
		}
		let Ok(proxy) = object.as_accessible_proxy(connection).await else {
			return false;
		};
		proxy
			.get_role()
			.await
			.is_ok_and(|role| role == Role::Application)
	}

	async fn find_focused(
		connection: &atspi::zbus::Connection,
		root: ObjectRefOwned,
		depth: u8,
	) -> Result<Option<ObjectRefOwned>, String> {
		// Chromium/Electron frames report children that are the AT-SPI null
		// object.
		if depth > 40 || root.is_null() {
			return Ok(None);
		}
		let proxy = root
			.as_accessible_proxy(connection)
			.await
			.map_err(|err| err.to_string())?;
		if proxy
			.get_state()
			.await
			.is_ok_and(|state| state.contains(State::Focused))
		{
			return Ok(Some(root));
		}
		for child in proxy.get_children().await.unwrap_or_default() {
			if let Some(found) = Box::pin(Self::find_focused(connection, child, depth + 1)).await? {
				return Ok(Some(found));
			}
		}
		Ok(None)
	}

	/// An element's properties, with its bounds when `bounds` asks for them.
	fn read_props(&mut self, h: &AxHandle, bounds: WalkBounds) -> CoreResult<AxProps> {
		let object = Self::object(h).clone();
		let Self { rt, connection, native, frames } = self;
		rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(connection.connection())
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
			let value = if let Some(name) = object.name().cloned() {
				let builder = atspi::proxy::text::TextProxy::builder(connection.connection())
					.destination(name)
					.and_then(|builder| builder.path(object.path().clone()));
				if let Ok(builder) = builder
					&& let Ok(text) = builder.build().await
				{
					let count = text.character_count().await.unwrap_or(0).min(16_384);
					text.get_text(0, count).await.ok().filter(|s| !s.is_empty())
				} else {
					None
				}
			} else {
				None
			};
			let bounds = if bounds == WalkBounds::Read {
				frames
					.screen_bounds(connection.connection(), native.as_deref(), &object)
					.await
			} else {
				None
			};
			let actions = match Self::action(connection.connection(), &object).await {
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
				selected: false,
				role_name: None,
			})
		})
	}

	/// The deepest element under `root` at screen point (`x`, `y`). A placed
	/// frame is hit-tested in its window coordinates.
	async fn descend(
		connection: &zbus::Connection,
		root: ObjectRefOwned,
		placement: Option<Placement>,
		x: i32,
		y: i32,
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
				let accessible = current
					.as_accessible_proxy(connection)
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI hit-test element: {err}")))?;
				accessible
					.get_interfaces()
					.await
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
			let child = Self::component(connection, &current)
				.await
				.map_err(DesktopError::ax_failed)?
				.get_accessible_at_point(x, y, coords)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI element at point: {err}")))?;
			if child.is_null() || child == current {
				return Ok(Some(AxHandle::AtSpi(current)));
			}
			// GTK4 returns the deepest element from the frame, then offsets the
			// point twice below it and can name a child the point is not in.
			if placement.is_some() {
				let inside = Self::component(connection, &child)
					.await
					.map_err(DesktopError::ax_failed)?
					.get_extents(CoordType::Window)
					.await
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
		let emptied = |mut error: DesktopError| {
			error
				.message
				.push_str(". setValue emptied the field before this write, so it may now be empty");
			error
		};
		let rewritten = replace(value).await.map_err(emptied)?;
		if rewritten
			.as_deref()
			.is_some_and(|actual| masks(actual, value))
		{
			return Ok(());
		}
		return text_readback(value, value, None, true).map_err(emptied);
	}
	// A role that cannot be read counts as a password field's, so no password
	// enters an error.
	let secure = actual.as_deref().is_some_and(masked)
		|| accessible
			.get_role()
			.await
			.ok()
			.is_none_or(|role| role == Role::PasswordText);
	text_readback(value, value, actual.as_deref(), secure)
}

/// Whether `actual` is one repeated mask character: one of GTK's, or the `*`
/// toolkits fall back on.
fn masked(actual: &str) -> bool {
	let mut chars = actual.chars();
	chars.next().is_some_and(|first| {
		['●', '•', '✱', '✺', '*'].contains(&first) && chars.all(|char| char == first)
	})
}

/// Whether `actual` masks `value`: one mask character per character, or per
/// UTF-16 unit as Qt masks.
fn masks(actual: &str, value: &str) -> bool {
	let shown = actual.chars().count();
	masked(actual) && (shown == value.chars().count() || shown == value.encode_utf16().count())
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

/// Generic press means activation, not action zero (GTK4 text views put
/// `buffer.delete-line` there). Explicit advertised actions remain available.
fn action_index<'a>(
	mut actions: impl Iterator<Item = &'a str> + Clone,
	requested: &str,
) -> Option<usize> {
	actions
		.clone()
		.position(|name| name.eq_ignore_ascii_case(requested))
		.or_else(|| {
			requested
				.eq_ignore_ascii_case("press")
				.then(|| {
					actions.position(|name| {
						[
							"click",
							"clickAncestor",
							"activate",
							"invoke",
							"toggle",
							"open",
							"jump",
							"do default",
							"do-default",
						]
						.iter()
						.any(|safe| name.eq_ignore_ascii_case(safe))
					})
				})
				.flatten()
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
		let result = self.rt.block_on(async {
			let app = Self::app_for_window(&self.connection, win).await?;
			let frames = Self::frames(&self.connection, &app).await?;
			let mut matches = Vec::new();
			for frame in frames {
				let id = atspi_window_id(&frame);
				if win.id.starts_with("atspi:") {
					if id == win.id {
						return Ok(frame);
					}
					continue;
				}
				let proxy = frame
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| err.to_string())?;
				if proxy.name().await.map_err(|err| err.to_string())? == win.title {
					matches.push(frame);
				}
			}
			if matches.len() == 1 {
				Ok(matches.remove(0))
			} else {
				Err(format!("window '{}' has {} matching AT-SPI frames", win.title, matches.len()))
			}
		});
		result
			.map(AxHandle::AtSpi)
			.map_err(|err: String| DesktopError::ax_failed(format!("AT-SPI window root: {err}")))
	}

	fn window_id(&mut self, h: &AxHandle, windows: &[DesktopWindow]) -> CoreResult<String> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let connection = self.connection.connection();
			let object = Self::top_level(connection, object).await?;
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
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
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
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
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
		self.rt.block_on(async {
			let proxy = Self::action(self.connection.connection(), &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			let accessible = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
			let index = resolve_action(&proxy, &accessible, action).await?;
			proxy
				.do_action(index)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?
				.ok_or_else(|| DesktopError::ax_failed(format!("AT-SPI action '{action}' failed")))
		})
	}

	fn set_value(&mut self, h: &AxHandle, value: &str) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let name = object
				.name()
				.ok_or_else(|| DesktopError::ax_failed("AT-SPI object has no bus name"))?
				.clone();
			let accessible = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
			let interfaces = accessible
				.get_interfaces()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI interfaces: {err}")))?;
			if interfaces.contains(atspi::Interface::EditableText) {
				return write_text(self.connection.connection(), &accessible, &name, &object, value)
					.await;
			}
			if !interfaces.contains(atspi::Interface::Value) {
				return Err(DesktopError::ax_failed("AT-SPI element has no writable value interface"));
			}
			let numeric = value.parse::<f64>().map_err(|_| {
				DesktopError::ax_failed("AT-SPI value is not editable text or a number")
			})?;
			if !numeric.is_finite() {
				return Err(DesktopError::ax_failed("AT-SPI numeric value must be finite"));
			}
			let proxy = atspi::proxy::value::ValueProxy::builder(self.connection.connection())
				.destination(name)
				.and_then(|b| b.path(object.path().clone()))
				.map_err(|err| DesktopError::ax_failed(err.to_string()))?
				.build()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))?;
			proxy
				.set_current_value(numeric)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI value: {err}")))
		})
	}

	fn focus(&mut self, h: &AxHandle) -> CoreResult<()> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let component = Self::component(self.connection.connection(), &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			component
				.grab_focus()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI focus: {err}")))?
				.ok_or_else(|| DesktopError::ax_failed("AT-SPI focus request was rejected"))
		})
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let x = x.round() as i32;
		let y = y.round() as i32;
		let Self { rt, connection, native, frames: cache } = self;
		cache.refresh();
		rt.block_on(async {
			let bus = connection.connection();
			let mut root: Option<(ObjectRefOwned, Option<Placement>)> = None;
			for app in Self::apps(connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				for frame in Self::frames(connection, &app)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					let Some(placement) = cache.claim(bus, native.as_deref(), &frame, x, y).await?
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
			Self::descend(bus, root, placement, x, y).await
		})
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.rt.block_on(async {
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				if let Some(found) = Self::find_focused(self.connection.connection(), app, 0)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					return Ok(Some(AxHandle::AtSpi(found)));
				}
			}
			Ok(None)
		})
	}

	fn attributes(&mut self, h: &AxHandle) -> CoreResult<Vec<(String, String)>> {
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
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
		self.rt.block_on(async {
			let connection = self.connection.connection();
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
	fn generic_press_never_selects_an_unrelated_editing_action() {
		let actions = ["buffer.delete-line", "clipboard.cut", "activate"];
		assert_eq!(action_index(actions.into_iter(), "press"), Some(2));
		assert_eq!(action_index(actions[..2].iter().copied(), "press"), None);
		assert_eq!(action_index(actions.into_iter(), "buffer.delete-line"), Some(0));
		assert_eq!(action_index(std::iter::empty(), "press"), None);
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

		/// An error naming what the field reads, one that names no text, or one
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
				results.push(write_text(&client, &accessible, &name, &object, "new ä€😀").await);
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
					if err.message.contains("secure") && !err.message.contains("new") => {},
				(Verdict::Emptied, Err(err))
					if err.message.contains("emptied") && !err.message.contains("new") => {},
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
		resolve_focus(&mut gnome, Some(1), no_lookup);
		assert_eq!(focused(&gnome), ["notes.txt - gedit"]);

		// KDE: plasma-keyboard's untitled frame stays active.
		let mut kde = vec![frame("", 5, true), frame("notes.txt — Kate", 8, true)];
		resolve_focus(&mut kde, None, no_lookup);
		assert_eq!(focused(&kde), ["notes.txt — Kate"]);

		// The GNOME overview: only the shell is active, and it keeps focus.
		let mut overview = vec![frame("Main stage", 1, true), frame("notes.txt - gedit", 7, false)];
		resolve_focus(&mut overview, Some(1), no_lookup);
		assert_eq!(focused(&overview), ["Main stage"]);

		// Two active application windows: none is named.
		let mut two = vec![frame("Main stage", 1, true), frame("A", 7, true), frame("B", 9, true)];
		resolve_focus(&mut two, Some(1), no_lookup);
		assert!(focused(&two).is_empty());

		// An untitled application window still wins over gnome-shell's frame.
		let mut untitled = vec![frame("Main stage", 1, true), frame("", 7, true)];
		resolve_focus(&mut untitled, Some(1), no_lookup);
		assert_eq!(focused(&untitled), [""]);

		// KDE with an untitled app beside plasma-keyboard: the frame holding
		// keyboard focus wins.
		let mut kde_untitled = vec![frame("", 5, true), frame("", 8, true)];
		resolve_focus(&mut kde_untitled, None, |window| window.pid == Some(8));
		let ids: Vec<&str> = kde_untitled
			.iter()
			.filter(|w| w.window.focused)
			.map(|w| w.window.id.as_str())
			.collect();
		assert_eq!(ids, ["-8"]);
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
			let top_levels = AtSpiAx::top_levels(&client, &object("/app")).await;
			let mut owners = Vec::new();
			for element in ["/open", "/dialog", "/ok"] {
				owners.push(
					AtSpiAx::top_level(&client, object(element))
						.await
						.map(path)
						.ok(),
				);
			}
			drop(server);
			(top_levels.map(|items| items.into_iter().map(path).collect::<Vec<_>>()), owners)
		});
		assert_eq!(top_levels, Ok(vec!["/dialog".to_owned(), "/frame".to_owned()]));
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
			let found = AtSpiAx::find_focused(&client, root, 0).await;
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

		/// Answers like the apps, `GetAll` refused as Qt refuses it, so a proxy
		/// that caches properties cannot read `NActions`.
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
				let element = AtSpiAx::descend(&client, object(path), placement, x, y)
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
}
