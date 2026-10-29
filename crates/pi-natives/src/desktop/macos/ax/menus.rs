use std::time::{Duration, Instant};

use objc2_application_services::{AXError, AXUIElement};
use objc2_core_foundation::{CFArray, CFNumber, CFRetained, CFString, CFType};

use super::{
	super::input::{
		EntryFront, attached_under, await_key_window, make_key_in_background, recheck_background,
		source,
	},
	FocusedWindow, KeyFocus, MacAx, copy_attribute, copy_attribute_result, copy_bool, copy_element,
	copy_required_string, copy_string, copy_strings_from_action_names, create_application,
	element_pid, key_focus, mac_handle, perform_action, reports_active, set_timeout, skylight,
	window_id,
};
use crate::desktop::{
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
		if !may_be_stale(activated, &first) {
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

/// Whether a menu listing read right after this call activated the
/// application (`activated`) may still show the inactive state: an inactive
/// application's menus show commands disabled that it enables once it
/// revalidates, so a listing without a disabled item has nothing to catch up.
fn may_be_stale(activated: bool, items: &[DesktopMenuItem]) -> bool {
	activated && items.iter().any(|item| !item.enabled)
}

pub(crate) fn select(window: &DesktopWindow, path: &[String]) -> CoreResult<()> {
	validate_path(path, false)?;
	with_window_menu(window, MenuAccess::Dispatch, |app, pid, context_holds, _| {
		let (menu, actual_path) = resolve_menu(app, &path[..path.len() - 1], pid)?;
		let (elements, items) = children(&menu, &actual_path, pid)?;
		let index = match_index(&items, &path[path.len() - 1])?;
		let element = &elements[index];
		let reread = || {
			describe(element, &actual_path, pid)?.ok_or_else(|| {
				DesktopError::ax_failed("menu command lost its title; nothing was dispatched")
			})
		};
		// A disabled command may be stale rather than unavailable, as TextEdit's
		// File > Save right after background typing was.
		let item = if items[index].enabled {
			items[index].clone()
		} else {
			settle(
				items[index].clone(),
				MENU_SETTLE_TIMEOUT,
				reread,
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
		let item = reread()?;
		require_command(&item)?;
		ready_to_dispatch(context_holds)?;
		perform_action(element, "AXPress").map_err(|error| {
			DesktopError::ax_failed(format!(
				"{error}; the menu command may already have taken effect; inspect the target before \
				 retrying"
			))
		})
	})
}

/// Before a menu command is pressed: its context still holds, the call is not
/// cancelled, and the user has not pressed a key or clicked in the app since
/// the call was admitted ([`control::intervention::check_press`]), since the
/// command can wait seconds for its menu to revalidate.
fn ready_to_dispatch(context_holds: &dyn Fn() -> CoreResult<()>) -> CoreResult<()> {
	context_holds()?;
	control::check()?;
	control::intervention::check_press()
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
	let root = MacAx::window_element(window)?;
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
/// still goes ahead, with `prepare`'s default answer, when it is refused as
/// unavailable in the background.
fn enter_menu_context<T: Default>(
	access: MenuAccess,
	prepare: impl FnOnce() -> CoreResult<T>,
) -> CoreResult<T> {
	match prepare() {
		Err(error)
			if access == MenuAccess::Read && error.code == ErrorCode::BackgroundUnavailable =>
		{
			Ok(T::default())
		},
		result => result,
	}
}

/// Runs `action` in the window's menu context. Its third argument checks that
/// the context still holds: the window is still key and, when it was made key
/// behind the user's app, the application is still behind it, since a command
/// can wait seconds for its menu to revalidate while the user brings the app
/// forward. Its last argument says whether the application reported itself
/// inactive before this call activated it, so its menus may still show the
/// inactive state.
fn with_window_menu<T>(
	window: &DesktopWindow,
	access: MenuAccess,
	action: impl FnOnce(&AXUIElement, libc::pid_t, &dyn Fn() -> CoreResult<()>, bool) -> CoreResult<T>,
) -> CoreResult<T> {
	let (entry_front, (app, pid, wid, activated)) = EntryFront::before(skylight::front_pid, || {
		let (app, pid, wid) = window_menu_context(window)?;
		Ok((app, pid, wid, reports_active(pid) == Some(false)))
	})?;
	// Application menus validate and dispatch through the key window, not their
	// AX parent.
	skylight::with_background_watch(pid, |visit| {
		let overlay = access == MenuAccess::Read
			&& read_leaves_focus(key_focus(pid), wid, skylight::window_parent);
		let prepared = enter_menu_context(access, || {
			let prepared =
				make_key_in_background(&source()?, pid, wid, window, entry_front, overlay, visit)?;
			// The user may have brought the app forward while its key window
			// settled.
			recheck_background(
				prepared,
				pid,
				wid,
				skylight::front_pid,
				|| visit.happened(),
				|| key_context(pid, wid, overlay),
			)?;
			Ok(prepared)
		})?;
		let context_holds = || {
			recheck_background(
				prepared,
				pid,
				wid,
				skylight::front_pid,
				|| visit.happened(),
				|| key_context(pid, wid, overlay),
			)
		};
		action(&app, pid, &context_holds, activated)
	})
}

/// Whether a menu read of window `wid` leaves the keyboard focus where it is
/// (`focus`): in an overlay attached to `wid`, such as a popover, an inline
/// editor, or a sheet like Finder's Go to Folder that is itself the focused
/// window. The press that makes `wid` key would close a popover or end the
/// editing; the menus then validate against the overlay, as the user's own
/// menu bar would show them.
fn read_leaves_focus(focus: KeyFocus, wid: u32, parent_of: impl Fn(u32) -> Option<u32>) -> bool {
	focus.in_overlay_of(wid, &parent_of)
		|| matches!(focus.window, FocusedWindow::Id(id)
			if id != wid && attached_under(id, &parent_of, |parent| parent == wid))
}

/// The key-window context a menu call needs: `wid` key, or, for a read that
/// left focus in an overlay attached to it ([`read_leaves_focus`]), nothing
/// more.
fn key_context(pid: libc::pid_t, wid: u32, overlay: bool) -> CoreResult<()> {
	if overlay {
		return control::check();
	}
	require_key_context(pid, wid)
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
			&& let Some(item) = describe(&child, path, pid)?
		{
			elements.push(child);
			items.push(item);
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

/// Describes a menu item, or `None` when it has no title to match: a separator
/// (empty title) or a custom-view item such as the Tags row in Finder's File
/// menu, which exposes no `AXTitle` at all.
fn describe(
	element: &AXUIElement,
	parent: &[String],
	pid: libc::pid_t,
) -> CoreResult<Option<DesktopMenuItem>> {
	if element_pid(element)? != pid {
		return Err(DesktopError::ax_failed("menu item belongs to a different application"));
	}
	let title = title(copy_attribute_result(element, "AXTitle"))?;
	if title.is_empty() {
		return Ok(None);
	}
	let mut path = parent.to_vec();
	path.push(title.clone());
	Ok(Some(DesktopMenuItem {
		title,
		path,
		enabled: copy_bool(element, "AXEnabled").unwrap_or(false),
		checked: copy_string(element, "AXMenuItemMarkChar").is_some_and(|mark| !mark.is_empty()),
		has_submenu: submenu(element)?.is_some(),
		shortcut: shortcut(element),
	}))
}

/// A menu item's `AXTitle`, empty when the item has none: AX reports a missing
/// title as no value or an unsupported attribute rather than an empty string,
/// and a few items fail the read outright (a row of Preview's Tools menu
/// answers kAXErrorFailure). Such an item cannot be matched by title, so it is
/// skipped rather than failing the whole menu.
fn title(value: Result<Option<CFRetained<CFType>>, AXError>) -> CoreResult<String> {
	match value {
		Ok(Some(value)) => value
			.downcast::<CFString>()
			.map(|value| value.to_string())
			.map_err(|_| DesktopError::ax_failed("AXTitle was not a string")),
		Ok(None) | Err(AXError::NoValue | AXError::AttributeUnsupported | AXError::Failure) => {
			Ok(String::new())
		},
		Err(error) => Err(super::ax_error(error, "copying AXTitle failed")),
	}
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
	fn a_menu_read_leaves_a_focused_attached_sheet_alone() {
		// Finder's Go to Folder sheet 41740 on window 41732 is the focused
		// window: the press that makes 41732 key would end its editing.
		let attached = |id| (id == 41740).then_some(41732);
		let sheet = KeyFocus {
			window:         FocusedWindow::Id(41740),
			element_window: Some(41740),
			element_mapped: true,
		};
		assert!(read_leaves_focus(sheet, 41732, attached));
		// The window itself or an unrelated window focused: the read makes 41732
		// key as before.
		let own = KeyFocus { window: FocusedWindow::Id(41732), element_window: Some(41732), ..sheet };
		assert!(!read_leaves_focus(own, 41732, attached));
		let other = KeyFocus { window: FocusedWindow::Id(5), element_window: Some(5), ..sheet };
		assert!(!read_leaves_focus(other, 41732, attached));
	}

	#[test]
	fn a_menu_read_waits_for_revalidation_only_while_an_item_shows_disabled() {
		let item = |enabled| DesktopMenuItem {
			title: "New Collection".into(),
			path: vec!["File".into(), "New Collection".into()],
			enabled,
			checked: false,
			has_submenu: false,
			shortcut: None,
		};
		// Every command already enabled: nothing to wait for.
		assert!(!may_be_stale(true, &[item(true), item(true)]));
		// Font Book's New Collection read disabled right after the activation.
		assert!(may_be_stale(true, &[item(true), item(false)]));
		// An application that was already active shows its real state.
		assert!(!may_be_stale(false, &[item(false)]));
	}

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
		let refused = || -> CoreResult<()> {
			Err(DesktopError::background_unavailable("the target came forward"))
		};
		assert!(enter_menu_context(MenuAccess::Read, refused).is_ok());
		assert_eq!(
			enter_menu_context(MenuAccess::Dispatch, refused)
				.unwrap_err()
				.code,
			ErrorCode::BackgroundUnavailable
		);
		let cancelled = || -> CoreResult<()> { Err(DesktopError::cancelled("cancelled")) };
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
			reads.update(|v| v + 1);
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

	#[test]
	fn a_menu_command_is_not_pressed_once_the_user_used_the_app_during_the_call() {
		// A disabled command waits up to 1.5 s for its menu to revalidate; the
		// user types into the same window meanwhile.
		let listener = control::intervention::Listener::simulated();
		listener.touch(7, None, || "TextEdit".to_string());
		let token = control::CancellationSource::default().token();
		let _watch = listener.admit(7, &token).unwrap();
		let holds = || Ok(());
		assert!(ready_to_dispatch(&holds).is_ok());
		listener.record_for_test(7, Instant::now());
		assert_eq!(ready_to_dispatch(&holds).unwrap_err().code, ErrorCode::UserIntervened);
	}

	#[test]
	fn items_without_a_title_read_as_untitled_instead_of_failing_the_menu() {
		// Finder's File > Tags row answers AXTitle with kAXErrorNoValue (-25212).
		assert_eq!(title(Err(AXError::NoValue)).unwrap(), "");
		assert_eq!(title(Err(AXError::AttributeUnsupported)).unwrap(), "");
		// One row of Preview's Tools menu answers kAXErrorFailure (-25200).
		assert_eq!(title(Err(AXError::Failure)).unwrap(), "");
		assert_eq!(title(Ok(None)).unwrap(), "");
	}

	#[test]
	fn titled_items_keep_their_title_and_other_failures_still_fail() {
		let open = CFRetained::<CFType>::from(CFString::from_str("Open"));
		assert_eq!(title(Ok(Some(open))).unwrap(), "Open");
		let number = CFRetained::<CFType>::from(CFNumber::new_i32(1));
		assert_eq!(title(Ok(Some(number))).unwrap_err().code, ErrorCode::AxFailed);
		assert_eq!(title(Err(AXError::CannotComplete)).unwrap_err().code, ErrorCode::AxFailed);
		assert_eq!(title(Err(AXError::InvalidUIElement)).unwrap_err().code, ErrorCode::StaleRef);
	}
}
