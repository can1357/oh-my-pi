use std::time::{Duration, Instant};

use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFArray, CFNumber, CFRetained, CFType};

use super::{
	super::input::{await_key_window, make_key_in_background, source, still_behind_user},
	MacAx, copy_attribute, copy_attribute_result, copy_bool, copy_element, copy_required_string,
	copy_string, copy_strings_from_action_names, create_application, element_pid, key_focus,
	mac_handle, perform_action, reports_active, set_timeout, skylight, window_id,
};
use crate::desktop::{
	backend::AxBackend,
	control,
	error::{CoreResult, DesktopError, ErrorCode},
	menus::{DesktopMenuItem, match_index, require_command, require_enabled, validate_path},
	types::DesktopWindow,
};

const MAX_MENU_CHILDREN: usize = 4096;
/// How long a menu read or command waits for its application to revalidate
/// its menus. `AppKit` does that on its own schedule after an activation or an
/// edit: Font Book's File > New Collection read enabled 0.4 to 1.2 s after the
/// activation on a loaded test machine, whatever input followed it.
const MENU_SETTLE_TIMEOUT: Duration = Duration::from_millis(1500);
const MENU_SETTLE_POLL: Duration = Duration::from_millis(100);

pub(crate) fn items(window: &DesktopWindow, path: &[String]) -> CoreResult<Vec<DesktopMenuItem>> {
	validate_path(path, true)?;
	with_window_menu(window, MenuAccess::Read, |app, pid, _, activated| {
		let (menu, actual_path) = resolve_menu(app, path, pid)?;
		let read = || children(&menu, &actual_path, pid).map(|(_, items)| items);
		let first = read()?;
		if !activated {
			return Ok(first);
		}
		// The listing still shows the inactive state until the app revalidates.
		let enabled =
			|items: &[DesktopMenuItem]| items.iter().map(|item| item.enabled).collect::<Vec<_>>();
		settle(
			first,
			MENU_SETTLE_TIMEOUT,
			read,
			|first, now| enabled(first) != enabled(now),
			|| control::wait(MENU_SETTLE_POLL),
		)
	})
}

pub(crate) fn select(window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
	validate_path(path, false)?;
	with_window_menu(window, MenuAccess::Dispatch, |app, pid, wid, _| {
		let (menu, actual_path) = resolve_menu(app, &path[..path.len() - 1], pid)?;
		let (elements, items) = children(&menu, &actual_path, pid)?;
		let index = match_index(&items, &path[path.len() - 1])?;
		let element = &elements[index];
		// A disabled command may be stale rather than unavailable, as TextEdit's
		// File > Save right after background typing was.
		let item = if items[index].enabled {
			items[index].clone()
		} else {
			settle(
				items[index].clone(),
				MENU_SETTLE_TIMEOUT,
				|| describe(element, &actual_path, pid),
				|_, now| now.enabled,
				|| control::wait(MENU_SETTLE_POLL),
			)?
		};
		require_command(&item)?;
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

/// Reads again through `read`, waiting through `wait` before each read, until
/// `settled` accepts a value against `first` or `timeout` passes; returns the
/// accepted or the last value read.
fn settle<T>(
	first: T,
	timeout: Duration,
	mut read: impl FnMut() -> CoreResult<T>,
	settled: impl Fn(&T, &T) -> bool,
	mut wait: impl FnMut() -> CoreResult<()>,
) -> CoreResult<T> {
	let deadline = Instant::now() + timeout;
	let mut last = None;
	while Instant::now() < deadline {
		wait()?;
		let now = read()?;
		if settled(&first, &now) {
			return Ok(now);
		}
		last = Some(now);
	}
	Ok(last.unwrap_or(first))
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

/// What a menu call needs from the window's menu context.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MenuAccess {
	/// Lists items. An application that does not consider itself active
	/// validates its menus without a key window, so commands acting on the
	/// window's content read as disabled; the read prepares the same context
	/// a command gets, and reads anyway when that context is refused.
	Read,
	/// Presses a command, which dispatches through the key window.
	Dispatch,
}

/// Runs `prepare`, which makes the window key within its application; a read
/// still goes ahead when it is refused as unavailable in the background.
fn enter_menu_context(
	access: MenuAccess,
	prepare: impl FnOnce() -> CoreResult<()>,
) -> CoreResult<()> {
	match prepare() {
		Err(error)
			if access == MenuAccess::Read && error.code == ErrorCode::BackgroundUnavailable =>
		{
			Ok(())
		},
		result => result,
	}
}

/// Runs `action` in the window's menu context. Its last argument says whether
/// the application reported itself inactive before this call activated it,
/// so its menus may still show the inactive state.
fn with_window_menu<T>(
	window: &DesktopWindow,
	access: MenuAccess,
	action: impl FnOnce(&AXUIElement, libc::pid_t, u32, bool) -> CoreResult<T>,
) -> CoreResult<T> {
	let (app, pid, wid) = window_menu_context(window)?;
	// Application menus validate and dispatch through the key window, not their
	// AX parent.
	let entry_front = skylight::front_pid();
	let activated = reports_active(pid) == Some(false);
	skylight::with_background_guard(pid, || {
		enter_menu_context(access, || {
			// A read must not end an overlay's editing, such as a popover's: the
			// press that makes `wid` key would close it.
			let in_overlay = access == MenuAccess::Read
				&& key_focus(pid).in_overlay_of(wid, skylight::window_parent);
			let prepared =
				make_key_in_background(&source()?, pid, wid, window, entry_front, in_overlay)?;
			require_key_context(pid, wid)?;
			// The user may have brought the app forward while its key window
			// settled.
			if prepared {
				still_behind_user(pid, wid)?;
			}
			Ok(())
		})?;
		action(&app, pid, wid, activated)
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

fn bounded_children(
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

#[cfg(test)]
mod tests {
	use std::cell::Cell;

	use super::*;

	#[test]
	fn a_menu_read_prepares_the_key_window_and_reads_even_when_that_is_refused() {
		// Font Book's File > New Collection read as disabled while the app was
		// in the background, so the model activated it.
		let prepared = Cell::new(false);
		let ready = enter_menu_context(MenuAccess::Read, || {
			prepared.set(true);
			Ok(())
		});
		assert!(ready.is_ok());
		assert!(prepared.get());
		let refused = || Err(DesktopError::background_unavailable("the target came forward"));
		assert!(enter_menu_context(MenuAccess::Read, refused).is_ok());
		assert_eq!(
			enter_menu_context(MenuAccess::Dispatch, refused)
				.unwrap_err()
				.code,
			ErrorCode::BackgroundUnavailable
		);
		let cancelled = || Err(DesktopError::cancelled("cancelled"));
		assert_eq!(
			enter_menu_context(MenuAccess::Read, cancelled)
				.unwrap_err()
				.code,
			ErrorCode::Cancelled
		);
	}

	#[test]
	fn a_menu_read_waits_until_the_app_revalidates_its_menus() {
		// Right after the activation, New Collection still read disabled for up
		// to 1.2 s; the read waits for the change instead of returning that.
		let reads = Cell::new(0);
		let read = || {
			reads.set(reads.get() + 1);
			Ok(reads.get() >= 3)
		};
		let changed = |first: &bool, now: &bool| first != now;
		let settled = settle(false, Duration::from_secs(5), read, changed, || Ok(()));
		assert!(settled.unwrap());
		assert_eq!(reads.get(), 3);
		// A listing that never changes is returned once the bound passes.
		let pause = || {
			std::thread::sleep(Duration::from_millis(5));
			Ok(())
		};
		assert!(!settle(false, Duration::from_millis(30), || Ok(false), changed, pause).unwrap());
		let cancelled = || Err(DesktopError::cancelled("cancelled"));
		assert_eq!(
			settle(false, Duration::from_secs(5), || Ok(false), changed, cancelled)
				.unwrap_err()
				.code,
			ErrorCode::Cancelled
		);
	}
}
