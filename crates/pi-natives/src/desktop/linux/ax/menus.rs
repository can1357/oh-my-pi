use super::*;
use crate::desktop::{
	control,
	menus::{DesktopMenuItem, match_index, require_command, require_enabled},
};

const NODE_LIMIT: usize = 2048;
const DEPTH_LIMIT: usize = 32;

fn failure(message: impl std::fmt::Display) -> DesktopError {
	DesktopError::ax_failed(format!("AT-SPI menu: {message}"))
}

fn menu_role(role: Role) -> bool {
	matches!(role, Role::Menu | Role::MenuItem | Role::CheckMenuItem | Role::RadioMenuItem)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn command_requires_one_declared_activation() {
		assert!(command_index(std::iter::empty()).is_err());
		assert!(command_index(["show", "open", "focus"].into_iter()).is_err());
		assert!(command_index(["click", "activate"].into_iter()).is_err());
		assert!(command_index(["press", "PRESS"].into_iter()).is_err());
		assert_eq!(command_index(["show", "aCtIvAtE"].into_iter()).unwrap(), 1);
	}

	#[test]
	fn non_menu_controls_are_not_commands() {
		assert!(!menu_role(Role::PushButton));
		assert!(!menu_role(Role::Frame));
		assert!(!menu_role(Role::MenuBar));
		assert!(menu_role(Role::CheckMenuItem));
		assert!(menu_role(Role::RadioMenuItem));
	}
}

fn command_index<'a>(names: impl Iterator<Item = &'a str>) -> CoreResult<i32> {
	let mut candidates = names.enumerate().filter(|(_, name)| {
		["click", "press", "activate", "invoke", "toggle", "check", "uncheck"]
			.iter()
			.any(|command| name.eq_ignore_ascii_case(command))
	});
	match (candidates.next(), candidates.next()) {
		(Some((index, _)), None) => i32::try_from(index).map_err(failure),
		_ => Err(failure("command has no unique declared activation action")),
	}
}

impl AtSpiAx {
	// Check parent links as well as child links: a detached popup or a menu
	// belonging to another frame must never become a background command target.
	async fn menu_children(&self, object: &ObjectRefOwned) -> CoreResult<Vec<ObjectRefOwned>> {
		let proxy = object
			.as_accessible_proxy(self.connection.connection())
			.await
			.map_err(failure)?;
		let children = proxy.get_children().await.map_err(failure)?;
		if children.len() > NODE_LIMIT {
			return Err(failure("child limit exceeded"));
		}
		for child in &children {
			if child.is_null() || child == object || child.name() != object.name() {
				return Err(failure("invalid or cross-application child ownership"));
			}
			let proxy = child
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(failure)?;
			if proxy.parent().await.map_err(failure)? != *object {
				return Err(failure("menu child has inconsistent parent ownership"));
			}
		}
		Ok(children)
	}

	async fn menu_bars(&self, root: &ObjectRefOwned) -> CoreResult<Vec<ObjectRefOwned>> {
		let mut pending = vec![(root.clone(), 0)];
		let mut seen = Vec::new();
		let mut bars = Vec::new();
		while let Some((object, depth)) = pending.pop() {
			if depth > DEPTH_LIMIT || seen.len() >= NODE_LIMIT || seen.contains(&object) {
				return Err(failure("menu discovery exceeded its bounded tree or found a cycle"));
			}
			seen.push(object.clone());
			let proxy = object
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(failure)?;
			let role = proxy.get_role().await.map_err(failure)?;
			if role == Role::MenuBar {
				drop(proxy);
				bars.push(object);
				continue;
			}
			// Menus are chrome, not document content, and nested top-level windows
			// are separate destinations even when owned by the same application.
			if object != *root
				&& !matches!(role, Role::Panel | Role::Filler | Role::RootPane | Role::LayeredPane)
			{
				continue;
			}
			let children = self.menu_children(&object).await?;
			if pending.len() + seen.len() + children.len() > NODE_LIMIT {
				return Err(failure("menu discovery node limit exceeded"));
			}
			pending.extend(children.into_iter().map(|child| (child, depth + 1)));
		}
		if bars.is_empty() {
			return Err(failure(
				"target frame exposes no accessible menu bar; global or detached menus are not \
				 target-bound",
			));
		}
		Ok(bars)
	}

	async fn menu_level(
		&self,
		containers: &[ObjectRefOwned],
		path: &[String],
	) -> CoreResult<(Vec<DesktopMenuItem>, Vec<ObjectRefOwned>)> {
		let mut items = Vec::new();
		let mut objects = Vec::new();
		for container in containers {
			let owner = container
				.as_accessible_proxy(self.connection.connection())
				.await
				.map_err(failure)?;
			let owner_role = owner.get_role().await.map_err(failure)?;
			let owner_name = owner.name().await.map_err(failure)?;
			let mut children = self.menu_children(container).await?;
			// Some toolkits expose a submenu as an intermediate Menu object.
			if owner_role != Role::MenuBar && children.len() == 1 {
				let wrapped = {
					let child = children[0]
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(failure)?;
					let name = child.name().await.map_err(failure)?;
					child.get_role().await.map_err(failure)? == Role::Menu
						&& (name.is_empty() || name == owner_name)
				};
				if wrapped {
					children = self.menu_children(&children[0]).await?;
				}
			}
			for object in children {
				if objects.len() >= NODE_LIMIT {
					return Err(failure("menu item limit exceeded"));
				}
				let proxy = object
					.as_accessible_proxy(self.connection.connection())
					.await
					.map_err(failure)?;
				let role = proxy.get_role().await.map_err(failure)?;
				if role == Role::Separator {
					continue;
				}
				if !menu_role(role) {
					return Err(failure("menu contains an unsupported non-menu child"));
				}
				let title = proxy.name().await.map_err(failure)?;
				let state = proxy.get_state().await.map_err(failure)?;
				if state.contains(State::Defunct) {
					return Err(failure("menu item is defunct"));
				}
				let mut has_submenu = role == Role::Menu;
				for child in self.menu_children(&object).await? {
					let child_proxy = child
						.as_accessible_proxy(self.connection.connection())
						.await
						.map_err(failure)?;
					has_submenu |= menu_role(child_proxy.get_role().await.map_err(failure)?);
				}
				let shortcut = match Self::action(&self.connection, &object).await {
					Ok(action) => action
						.get_key_binding(0)
						.await
						.ok()
						.filter(|binding| !binding.is_empty()),
					Err(_) => None,
				};
				let mut item_path = path.to_vec();
				item_path.push(title.clone());
				items.push(DesktopMenuItem {
					title,
					path: item_path,
					enabled: state.contains(State::Enabled) && state.contains(State::Sensitive),
					checked: state.contains(State::Checked),
					has_submenu,
					shortcut,
				});
				drop(proxy);
				objects.push(object);
			}
		}
		if items.is_empty() {
			return Err(failure(
				"menu children are absent or inaccessible without opening a foreground popup",
			));
		}
		Ok((items, objects))
	}

	async fn resolve_menu(
		&self,
		root: &ObjectRefOwned,
		path: &[String],
	) -> CoreResult<(DesktopMenuItem, ObjectRefOwned)> {
		let mut containers = self.menu_bars(root).await?;
		let mut canonical = Vec::new();
		for (depth, label) in path.iter().enumerate() {
			let (mut items, mut objects) = self.menu_level(&containers, &canonical).await?;
			let index = match_index(&items, label)?;
			let item = items.remove(index);
			require_enabled(&item)?;
			let object = objects.remove(index);
			if depth + 1 == path.len() {
				return Ok((item, object));
			}
			if !item.has_submenu {
				return Err(failure("path traverses a command rather than a submenu"));
			}
			canonical = item.path;
			containers = vec![object];
		}
		Err(failure("a command path is required"))
	}

	pub(crate) fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<DesktopMenuItem>> {
		let root = self.window_root(window)?;
		let root = Self::object(&root);
		self.rt.block_on(async {
			let (containers, canonical) = if path.is_empty() {
				(self.menu_bars(root).await?, Vec::new())
			} else {
				let (item, object) = self.resolve_menu(root, path).await?;
				if !item.has_submenu {
					return Err(failure("requested item is not a submenu"));
				}
				(vec![object], item.path)
			};
			self
				.menu_level(&containers, &canonical)
				.await
				.map(|(items, _)| items)
		})
	}

	pub(crate) fn menu_select(&mut self, window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
		let root = self.window_root(window)?;
		let root = Self::object(&root).clone();
		let (item, object) = self.rt.block_on(self.resolve_menu(&root, path))?;
		require_command(&item)?;
		// Recheck the resolver and ancestor chain after discovery, before dispatch.
		if Self::object(&self.window_root(window)?) != &root {
			return Err(failure("target frame changed during menu discovery"));
		}
		let handle = AxHandle::AtSpi(object.clone());
		if self.window_id(&handle, std::slice::from_ref(window))? != window.id {
			return Err(failure("command no longer belongs to the target frame"));
		}
		self.rt.block_on(async {
			let (current, current_object) = self.resolve_menu(&root, path).await?;
			require_command(&current)?;
			if current_object != object {
				return Err(failure("menu command changed during discovery"));
			}
			let action = Self::action(&self.connection, &object)
				.await
				.map_err(failure)?;
			let actions = action.get_actions().await.map_err(failure)?;
			let index = command_index(actions.iter().map(|action| action.name.as_str()))?;
			control::check()?;
			if !action.do_action(index).await.map_err(failure)? {
				return Err(failure("application refused the menu command"));
			}
			Ok(())
		})
	}
}
