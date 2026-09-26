use atspi::{CoordType, ObjectRefOwned, Role, State, proxy::accessible::ObjectRefExt};
use tokio::runtime::{Builder, Runtime};

use crate::desktop::{
	ax::{AxBounds, AxHandle, AxProps, normalize_role_atspi},
	backend::AxBackend,
	error::{CoreResult, DesktopError},
	types::DesktopWindow,
};

pub struct AtSpiAx {
	rt:         Runtime,
	connection: atspi::AccessibilityConnection,
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

	pub(crate) fn windows(&self) -> CoreResult<Vec<DesktopWindow>> {
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
					let id = atspi_window_id(&frame);
					windows.push(DesktopWindow {
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
					});
					if windows.len() == 48 {
						return Ok(windows);
					}
				}
			}
			Ok(windows)
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
				if app.name().is_some_and(|name| win.id.starts_with(&format!("atspi:{name}:"))) {
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
					.ok() == Some(pid)
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
				win.app, win.pid, matches.len()
			))
		}
	}

	async fn frames(
		connection: &atspi::AccessibilityConnection,
		app: &ObjectRefOwned,
	) -> Result<Vec<ObjectRefOwned>, String> {
		let proxy = app
			.as_accessible_proxy(connection.connection())
			.await
			.map_err(|err| err.to_string())?;
		let children = proxy.get_children().await.map_err(|err| err.to_string())?;
		let mut frames = Vec::new();
		for child in children {
			let child_proxy = child
				.as_accessible_proxy(connection.connection())
				.await
				.map_err(|err| err.to_string())?;
			if matches!(child_proxy.get_role().await, Ok(Role::Frame | Role::Dialog | Role::Window)) {
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

	async fn action<'a>(
		connection: &'a atspi::AccessibilityConnection,
		object: &'a ObjectRefOwned,
	) -> Result<atspi::proxy::action::ActionProxy<'a>, String> {
		let name = object
			.name()
			.ok_or_else(|| "AT-SPI object has no bus name".to_string())?
			.clone();
		atspi::proxy::action::ActionProxy::builder(connection.connection())
			.destination(name)
			.map_err(|err| err.to_string())?
			.path(object.path().clone())
			.map_err(|err| err.to_string())?
			.build()
			.await
			.map_err(|err| err.to_string())
	}

	async fn find_focused(
		connection: &atspi::AccessibilityConnection,
		root: ObjectRefOwned,
		depth: u8,
	) -> Result<Option<ObjectRefOwned>, String> {
		if depth > 40 {
			return Ok(None);
		}
		let proxy = root
			.as_accessible_proxy(connection.connection())
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
	let name = frame.name().map(ToString::to_string).unwrap_or_default();
	format!("atspi:{name}:{}", frame.path())
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

/// Generic press means activation, not action zero (GTK4 text views put
/// `buffer.delete-line` there). Explicit advertised actions remain available.
fn action_index<'a>(
	mut actions: impl Iterator<Item = &'a str> + Clone,
	requested: &str,
) -> Option<usize> {
	actions.clone().position(|name| name.eq_ignore_ascii_case(requested)).or_else(|| {
		requested.eq_ignore_ascii_case("press").then(|| {
			actions.position(|name| {
				["click", "clickAncestor", "activate", "invoke", "toggle", "open", "jump",
				 "do default", "do-default"].iter().any(|safe| name.eq_ignore_ascii_case(safe))
			})
		}).flatten()
	})
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
		let mut object = Self::object(h).clone();
		self.rt.block_on(async {
			// Follow ownership, never screen containment: overlapping windows and
			// same-process dialogs are distinct input destinations.
			for _ in 0..64 {
				let proxy = object
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window owner: {err}")))?;
				let role = proxy.get_role().await.map_err(|err| {
					DesktopError::ax_failed(format!("AT-SPI window role: {err}"))
				})?;
				if matches!(role, Role::Frame | Role::Dialog | Role::Window) {
					let id = atspi_window_id(&object);
					if windows.iter().any(|window| window.id == id) {
						return Ok(id);
					}
					let name = object.name().ok_or_else(|| {
						DesktopError::ax_failed("AT-SPI window has no bus owner")
					})?;
					let dbus = atspi::zbus::fdo::DBusProxy::new(self.connection.connection())
						.await
						.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
					let pid = dbus
						.get_connection_unix_process_id(name.clone().into())
						.await
						.map_err(|err| DesktopError::ax_failed(format!("AT-SPI window pid: {err}")))?;
					let title = proxy.name().await.map_err(|err| {
						DesktopError::ax_failed(format!("AT-SPI window title: {err}"))
					})?;
					return native_window_for_frame(windows, pid, &title);
				}
				let parent = proxy.parent().await.map_err(|err| {
					DesktopError::ax_failed(format!("AT-SPI window parent: {err}"))
				})?;
				if parent.is_null() || parent == object {
					break;
				}
				drop(proxy);
				object = parent;
			}
			Err(DesktopError::ax_failed("AT-SPI element has no identifiable top-level window"))
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
				if let Ok(builder) = builder {
					if let Ok(text) = builder.build().await {
						let count = text.character_count().await.unwrap_or(0).min(16_384);
						text.get_text(0, count).await.ok().filter(|s| !s.is_empty())
					} else {
						None
					}
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
			let actions = match Self::action(&self.connection, &object).await {
				Ok(action) => action
					.get_actions()
					.await
					.unwrap_or_default()
					.into_iter()
					.map(|a| a.name)
					.collect(),
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
			let proxy = Self::action(&self.connection, &object)
				.await
				.map_err(DesktopError::ax_failed)?;
			let actions = proxy
				.get_actions()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI actions: {err}")))?;
			let mut names = actions.iter().map(|item| item.name.as_str());
			let mut index = action_index(names.clone(), action);
			if index.is_none() && action.eq_ignore_ascii_case("press") {
				let accessible = object.as_accessible_proxy(self.connection.connection()).await
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?;
				if matches!(accessible.get_role().await, Ok(Role::CheckBox | Role::CheckMenuItem)) {
					index = names.position(|name| {
						name.eq_ignore_ascii_case("check") || name.eq_ignore_ascii_case("uncheck")
					});
				}
			}
			let index = index.ok_or_else(|| {
				DesktopError::ax_failed(format!("AT-SPI action '{action}' is unavailable"))
			})? as i32;
			if proxy
				.do_action(index)
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI action: {err}")))?
			{
				Ok(())
			} else {
				Err(DesktopError::ax_failed(format!("AT-SPI action '{action}' failed")))
			}
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
			let interfaces = accessible.get_interfaces().await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI interfaces: {err}")))?;
			if interfaces.contains(atspi::Interface::EditableText) {
				let editable =
				atspi::proxy::editable_text::EditableTextProxy::builder(self.connection.connection())
					.destination(name.clone())
					.and_then(|b| b.path(object.path().clone()))
					.map_err(|err| DesktopError::ax_failed(err.to_string()))?
					.build()
					.await;
				let editable = editable
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI editable text: {err}")))?;
				return if editable.set_text_contents(value).await
					.map_err(|err| DesktopError::ax_failed(format!("AT-SPI text value: {err}")))?
				{
					Ok(())
				} else {
					Err(DesktopError::ax_failed("AT-SPI text value was rejected"))
				};
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
			if component
				.grab_focus()
				.await
				.map_err(|err| DesktopError::ax_failed(format!("AT-SPI focus: {err}")))?
			{
				Ok(())
			} else {
				Err(DesktopError::ax_failed("AT-SPI focus request was rejected"))
			}
		})
	}

	fn element_at(&mut self, x: f64, y: f64) -> CoreResult<Option<AxHandle>> {
		let x = x.round() as i32;
		let y = y.round() as i32;
		self.rt.block_on(async {
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				for frame in Self::frames(&self.connection, &app)
					.await
					.unwrap_or_default()
				{
					let Ok(component) = Self::component(&self.connection, &frame).await else {
						continue;
					};
					if !component
						.contains(x, y, CoordType::Screen)
						.await
						.unwrap_or(false)
					{
						continue;
					}
					let found = component
						.get_accessible_at_point(x, y, CoordType::Screen)
						.await
						.map_err(|err| {
							DesktopError::ax_failed(format!("AT-SPI element at point: {err}"))
						})?;
					return Ok((!found.is_null()).then_some(AxHandle::AtSpi(found)));
				}
			}
			Ok(None)
		})
	}

	fn focused_element(&mut self) -> CoreResult<Option<AxHandle>> {
		self.rt.block_on(async {
			for app in Self::apps(&self.connection)
				.await
				.map_err(DesktopError::ax_failed)?
			{
				if let Some(found) = Self::find_focused(&self.connection, app, 0)
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
	fn frame_ownership_requires_unique_process_and_title() {
		let window = |id: &str, pid: u32| DesktopWindow {
			id: id.to_owned(), pid: Some(pid), title: "Document".into(),
			app: "Editor".into(), x: 0, y: 0, width: 100, height: 100, focused: false,
		};
		let mut windows = vec![window("1", 10), window("2", 20)];
		assert_eq!(native_window_for_frame(&windows, 20, "Document").unwrap(), "2");
		assert!(native_window_for_frame(&windows, 30, "Document").is_err());
		windows.push(window("3", 20));
		assert!(native_window_for_frame(&windows, 20, "Document").is_err());
	}
}
