use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFArray, CFNumber, CFRetained, CFType};

use super::{
	super::input::{await_key_window, make_key_in_background, source, still_behind_user},
	MacAx, copy_attribute, copy_attribute_result, copy_bool, copy_element, copy_required_string,
	copy_string, copy_strings_from_action_names, create_application, element_pid, mac_handle,
	perform_action, set_timeout, skylight, window_id,
};
use crate::desktop::{
	backend::AxBackend,
	control,
	error::{CoreResult, DesktopError},
	menus::{DesktopMenuItem, match_index, require_command, require_enabled, validate_path},
	types::DesktopWindow,
};

const MAX_MENU_CHILDREN: usize = 4096;

pub(crate) fn items(window: &DesktopWindow, path: &[String]) -> CoreResult<Vec<DesktopMenuItem>> {
	validate_path(path, true)?;
	let (app, pid, _) = window_menu_context(window)?;
	let (menu, actual_path) = resolve_menu(&app, path, pid)?;
	let (_, items) = children(&menu, &actual_path, pid)?;
	Ok(items)
}

pub(crate) fn select(window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
	validate_path(path, false)?;
	with_window_menu(window, |app, pid, wid| {
		let (menu, actual_path) = resolve_menu(app, &path[..path.len() - 1], pid)?;
		let (elements, items) = children(&menu, &actual_path, pid)?;
		let index = match_index(&items, &path[path.len() - 1])?;
		require_command(&items[index])?;
		let element = &elements[index];
		let actions = copy_strings_from_action_names(element)?;
		if !actions.iter().any(|action| action == "AXPress") {
			return Err(DesktopError::ax_failed(
				"menu command does not advertise AXPress; nothing was dispatched",
			));
		}
		// Re-read the chosen command after all path/provider queries. A menu may
		// validate itself in response to a key-window change.
		require_command(&describe(element, &actual_path, pid)?)?;
		require_key_context(pid, wid)?;
		control::check()?;
		perform_action(element, "AXPress").map_err(|error| {
			DesktopError::ax_failed(format!(
				"{error}; the menu command may already have taken effect; inspect the target before \
				 retrying"
			))
		})
	})
}

fn window_menu_context(
	window: &DesktopWindow,
) -> CoreResult<(CFRetained<AXUIElement>, libc::pid_t, u32)> {
	control::check()?;
	let wid = window
		.id
		.parse::<u32>()
		.map_err(|_| DesktopError::invalid_target("invalid macOS menu window id"))?;
	let root = MacAx::new().window_root(window)?;
	let root = mac_handle(&root)?;
	if window_id(root) != Some(wid) {
		return Err(DesktopError::background_unavailable(
			"cannot prove the exact native window for this menu; macOS window-id accessibility \
			 support is required",
		));
	}
	let pid = element_pid(root)?;
	let app = create_application(pid)?;
	set_timeout(&app)?;
	Ok((app, pid, wid))
}

fn with_window_menu<T>(
	window: &DesktopWindow,
	action: impl FnOnce(&AXUIElement, libc::pid_t, u32) -> CoreResult<T>,
) -> CoreResult<T> {
	let (app, pid, wid) = window_menu_context(window)?;
	// Application menus dispatch through the key window, not their AX parent.
	let entry_front = skylight::front_pid();
	skylight::with_background_guard(pid, || {
		let prepared = make_key_in_background(&source()?, pid, wid, window, entry_front)?;
		require_key_context(pid, wid)?;
		// The user may have brought the app forward while its key window settled.
		if prepared {
			still_behind_user(pid, wid)?;
		}
		action(&app, pid, wid)
	})
}

fn require_key_context(pid: libc::pid_t, wid: u32) -> CoreResult<()> {
	control::check()?;
	if !await_key_window(pid, wid)? {
		return Err(DesktopError::background_unavailable(format!(
			"menu dispatch requires window {wid} to be the exact key window of process {pid}; macOS \
			 did not establish that context, so no command was dispatched"
		)));
	}
	Ok(())
}

fn resolve_menu(
	app: &AXUIElement,
	path: &[String],
	pid: libc::pid_t,
) -> CoreResult<(CFRetained<AXUIElement>, Vec<String>)> {
	let mut menu = copy_element(app, "AXMenuBar")
		.ok_or_else(|| DesktopError::ax_failed("application does not expose AXMenuBar"))?;
	let mut actual_path = Vec::with_capacity(path.len());
	for label in path {
		control::check()?;
		let (elements, items) = children(&menu, &actual_path, pid)?;
		let index = match_index(&items, label)?;
		require_enabled(&items[index])?;
		menu = submenu(&elements[index])?.ok_or_else(|| {
			DesktopError::ax_failed(format!(
				"menu item '{}' does not expose a submenu",
				items[index].title
			))
		})?;
		actual_path.push(items[index].title.clone());
	}
	Ok((menu, actual_path))
}

fn children(
	menu: &AXUIElement,
	path: &[String],
	pid: libc::pid_t,
) -> CoreResult<(Vec<CFRetained<AXUIElement>>, Vec<DesktopMenuItem>)> {
	control::check()?;
	if element_pid(menu)? != pid {
		return Err(DesktopError::ax_failed("menu belongs to a different application"));
	}
	let children = bounded_children(menu, false)?;
	let mut elements = Vec::with_capacity(children.len());
	let mut items = Vec::with_capacity(children.len());
	for child in children {
		control::check()?;
		if matches!(copy_required_string(&child, "AXRole")?.as_str(), "AXMenuItem" | "AXMenuBarItem")
		{
			let item = describe(&child, path, pid)?;
			if !item.title.is_empty() {
				elements.push(child);
				items.push(item);
			}
		}
	}
	Ok((elements, items))
}

pub(super) fn bounded_children(
	element: &AXUIElement,
	optional: bool,
) -> CoreResult<Vec<CFRetained<AXUIElement>>> {
	let value = match copy_attribute_result(element, "AXChildren") {
		Ok(Some(value)) => value,
		Ok(None) | Err(AXError::NoValue | AXError::AttributeUnsupported) if optional => {
			return Ok(Vec::new());
		},
		other => {
			return Err(DesktopError::ax_failed(format!(
				"reading native menu children failed: {other:?}"
			)));
		},
	};
	let array = value
		.downcast::<CFArray>()
		.map_err(|_| DesktopError::ax_failed("native menu children were not an array"))?;
	// SAFETY: AXChildren is an immutable Copy-rule array of CF objects. Each
	// element is independently checked to be an AXUIElement below.
	let array = unsafe { CFRetained::cast_unchecked::<CFArray<CFType>>(array) };
	if array.len() > MAX_MENU_CHILDREN {
		return Err(DesktopError::ax_failed(
			"native menu exceeds the 4096-child safety limit; refusing incomplete matching",
		));
	}
	array
		.iter()
		.map(|child| {
			child.downcast::<AXUIElement>().map_err(|_| {
				DesktopError::ax_failed("native menu children contained a non-accessibility object")
			})
		})
		.collect()
}

fn submenu(element: &AXUIElement) -> CoreResult<Option<CFRetained<AXUIElement>>> {
	let mut menu = None;
	for child in bounded_children(element, true)? {
		if copy_required_string(&child, "AXRole")? == "AXMenu" {
			if menu.is_some() {
				return Err(DesktopError::ax_failed(
					"menu item exposes multiple submenus; refusing ambiguous traversal",
				));
			}
			menu = Some(child);
		}
	}
	Ok(menu)
}

fn describe(
	element: &AXUIElement,
	parent: &[String],
	pid: libc::pid_t,
) -> CoreResult<DesktopMenuItem> {
	if element_pid(element)? != pid {
		return Err(DesktopError::ax_failed("menu item belongs to a different application"));
	}
	let title = copy_required_string(element, "AXTitle")?;
	let mut path = parent.to_vec();
	path.push(title.clone());
	Ok(DesktopMenuItem {
		title,
		path,
		enabled: copy_bool(element, "AXEnabled").unwrap_or(false),
		checked: copy_string(element, "AXMenuItemMarkChar").is_some_and(|mark| !mark.is_empty()),
		has_submenu: submenu(element)?.is_some(),
		shortcut: shortcut(element),
	})
}

fn shortcut(element: &AXUIElement) -> Option<String> {
	let key = copy_string(element, "AXMenuItemCmdChar").filter(|key| !key.is_empty())?;
	let modifiers = copy_attribute(element, "AXMenuItemCmdModifiers")?
		.downcast::<CFNumber>()
		.ok()?
		.as_i64()?;
	let mut shortcut = String::new();
	// AXMenuItemModifiers: Shift=1, Option=2, Control=4, NoCommand=8.
	for (enabled, name) in [
		(modifiers & 4 != 0, "Ctrl+"),
		(modifiers & 2 != 0, "Alt+"),
		(modifiers & 1 != 0, "Shift+"),
		(modifiers & 8 == 0, "Cmd+"),
	] {
		if enabled {
			shortcut.push_str(name);
		}
	}
	shortcut.push_str(&key);
	Some(shortcut)
}
