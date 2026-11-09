use atspi::{
	CoordType, ObjectRefOwned, Role, State, proxy::accessible::ObjectRefExt, zbus::names::UniqueName,
};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_atspi, text_readback},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

mod menus;

pub struct AtSpiAx {
	rt:         Runtime,
	connection: atspi::AccessibilityConnection,
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
		Ok(Self { rt, connection })
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
					let Ok(component) = Self::component(&self.connection, &frame).await else {
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
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::component::ComponentProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::component::ComponentProxy::builder(connection.connection())
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
		let object = Self::object(h).clone();
		self.rt.block_on(async {
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
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
				let builder = atspi::proxy::text::TextProxy::builder(self.connection.connection())
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
			let bounds = if let Ok(component) = Self::component(&self.connection, &object).await {
				component
					.get_extents(CoordType::Screen)
					.await
					.ok()
					.and_then(|(x, y, width, height)| {
						(width >= 0 && height >= 0).then_some(AxBounds {
							x:      f64::from(x),
							y:      f64::from(y),
							width:  f64::from(width),
							height: f64::from(height),
						})
					})
			} else {
				None
			};
			let actions = match Self::action(self.connection.connection(), &object).await {
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
				enabled: state
					.as_ref()
					.is_some_and(|states| states.contains(State::Enabled)),
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
			let component = Self::component(&self.connection, &object)
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
		self.rt.block_on(async {
			let mut root = None;
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				for frame in Self::frames(&self.connection, &app)
					.await
					.map_err(DesktopError::ax_failed)?
				{
					let contains = {
						let component = Self::component(&self.connection, &frame)
							.await
							.map_err(DesktopError::ax_failed)?;
						component
							.contains(x, y, CoordType::Screen)
							.await
							.map_err(|err| {
								DesktopError::ax_failed(format!("AT-SPI frame hit test: {err}"))
							})?
					};
					if !contains {
						continue;
					}
					// AT-SPI enumeration is not stacking order. Never choose an
					// arbitrary frame when two top-levels contain the point.
					if let Some(previous) = &root {
						if previous != &frame {
							return Err(DesktopError::ax_failed(
								"multiple AT-SPI windows contain this point; topmost ownership is \
								 ambiguous",
							));
						}
					} else {
						root = Some(frame);
					}
				}
			}
			let Some(mut current) = root else {
				return Ok(None);
			};
			let mut ancestors = Vec::new();
			for _ in 0..64 {
				let has_component = {
					let accessible = current
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI hit-test element: {err}"))
						})?;
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
				let child = {
					let component = Self::component(&self.connection, &current)
						.await
						.map_err(DesktopError::ax_failed)?;
					component
						.get_accessible_at_point(x, y, CoordType::Screen)
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI element at point: {err}"))
						})?
				};
				if child.is_null() || child == current {
					return Ok(Some(AxHandle::AtSpi(current)));
				}
				if ancestors.contains(&child) {
					return Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy contains a cycle"));
				}
				ancestors.push(current);
				current = child;
			}
			Err(DesktopError::ax_failed("AT-SPI hit-test hierarchy exceeds the depth limit"))
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
}
