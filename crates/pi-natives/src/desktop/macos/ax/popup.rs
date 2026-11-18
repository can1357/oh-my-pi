//! Choosing an option of an `AXPopUpButton`.
//!
//! A popup's options are the `AXMenuItem`s of its `AXMenu`, and its `AXValue`
//! is not settable. `AppKit` builds that menu's accessibility items only while
//! the menu is open, so a closed native popup publishes no options at all, and
//! a closed Chromium `<select>` publishes only its chosen one: choosing one
//! means opening the menu, pressing the item, ending the menu, and reading the
//! popup's `AXValue` back as the verdict.

use std::{
	cell::Cell,
	thread,
	time::{Duration, Instant},
};

use objc2_application_services::AXUIElement;
use objc2_core_foundation::CFRetained;

use super::{
	super::capture, CoreResult, DesktopError, ErrorCode, control, copy_bool, copy_elements_optional,
	copy_string, copy_strings_from_action_names, element_pid, open_menu, perform_action,
};

/// How long a popup has to publish its menu items after the open action.
const MENU_OPEN_WAIT: Duration = Duration::from_millis(1000);
/// How long a pressed option has to show up as the popup's value.
const CHOICE_SETTLE_WAIT: Duration = Duration::from_millis(1000);
/// How long a cancelled menu has to leave the popup's children: a pressed
/// option's menu that refuses `AXCancel` flashes the item and fades out for
/// about 340 ms.
const MENU_CLOSE_WAIT: Duration = Duration::from_millis(1000);
const POLL_INTERVAL: Duration = Duration::from_millis(25);

/// Chooses the option of `popup` titled exactly `value` and confirms it by
/// reading the popup's `AXValue` back. A menu this call opened is closed again
/// whenever no choice is made.
pub(super) fn choose(popup: &AXUIElement, value: &str) -> CoreResult<()> {
	// Already showing `value`: the read-back verdict holds without opening the
	// menu.
	if copy_string(popup, "AXValue").as_deref() == Some(value) {
		return Ok(());
	}
	if copy_bool(popup, "AXEnabled") == Some(false) {
		return Err(DesktopError::ax_failed("popup button is disabled; nothing was selected"));
	}
	let mut items = menu_items(popup);
	let mut titles = option_titles(&items);
	let opened = needs_menu(&titles, value, open_menu_element(popup).is_some());
	// The app's menu windows before the open, so the one it shows is told
	// apart; `None` when they cannot be read.
	let before = element_pid(popup)
		.ok()
		.and_then(|pid| Some((pid, capture::menu_windows(pid)?)));
	let windows = before
		.as_ref()
		.map(|(pid, before)| (*pid, before.as_slice()));
	if opened {
		items = match open_menu(popup, windows, items.len()) {
			Ok(items) => items,
			Err(error) => return Err(unopened(error, value, &titles)),
		};
		titles = option_titles(&items);
	}
	let pressed = Cell::new(false);
	let result = choose_option(&titles, value)
		.map_err(|refusal| DesktopError::ax_failed(refusal_message(&refusal, value, &titles)))
		.and_then(|index| {
			press_option(popup, &items[index], value, || {
				pressed.set(true);
				close_menu(popup, windows, true)
			})
		});
	match result {
		// A pressed option's close has run, and its failure is the error.
		Err(error) if opened && !pressed.get() && !close_menu(popup, windows, false) => {
			Err(menu_left_open(error))
		},
		result => result,
	}
}

/// A menu that would not open, refusing `requested`: the options the closed
/// popup published still answer the request, so they are listed.
fn unopened(mut error: DesktopError, requested: &str, published: &[String]) -> DesktopError {
	if !published.is_empty() && error.code == ErrorCode::AxFailed {
		error.message = format!(
			"{}; opening its menu for more options failed: {}",
			refusal_message(&Refusal::Missing, requested, published),
			error.message
		);
	}
	error
}

fn menu_left_open(mut error: DesktopError) -> DesktopError {
	error
		.message
		.push_str("; the menu this call opened is still open");
	error
}

/// Why a requested value chooses no option.
#[derive(Debug, PartialEq, Eq)]
enum Refusal {
	/// No option is titled exactly the value.
	Missing,
	/// Several options share the title, so the value cannot say which.
	Ambiguous,
}

/// Whether the options `popup` publishes now lack `requested` and its menu,
/// which lists them all, is still to be opened: a closed popup publishes no
/// options (`AppKit`) or only its chosen one (Chromium).
fn needs_menu(titles: &[String], requested: &str, menu_open: bool) -> bool {
	!menu_open && choose_option(titles, requested) == Err(Refusal::Missing)
}

/// Each option's title as it reads ([`option_title`]).
fn option_titles(items: &[CFRetained<AXUIElement>]) -> Vec<String> {
	items
		.iter()
		.map(|item| option_title(copy_string(item, "AXTitle"), || copy_string(item, "AXValue")))
		.collect()
}

/// An option's title: its `AXTitle`, or for an untitled one its `AXValue`,
/// where Chromium puts an `<option>`'s text. An item with neither is a
/// separator. The value is read only for an untitled item.
fn option_title(title: Option<String>, value: impl FnOnce() -> Option<String>) -> String {
	title
		.filter(|title| !title.is_empty())
		.or_else(value)
		.unwrap_or_default()
}

/// The index of the option titled exactly `requested`. Matching is exact:
/// options are the app's own strings, the refusal lists them, and two titles
/// differing only in case or spacing are distinct options. Untitled items are
/// menu separators, not options.
fn choose_option(titles: &[String], requested: &str) -> Result<usize, Refusal> {
	let mut matches = titles
		.iter()
		.enumerate()
		.filter(|(_, title)| !title.is_empty() && *title == requested)
		.map(|(index, _)| index);
	match (matches.next(), matches.next()) {
		(Some(index), None) => Ok(index),
		(Some(_), Some(_)) => Err(Refusal::Ambiguous),
		(None, _) => Err(Refusal::Missing),
	}
}

fn refusal_message(refusal: &Refusal, requested: &str, titles: &[String]) -> String {
	let options = option_list(titles);
	match refusal {
		Refusal::Missing => format!(
			"no popup option is titled exactly \"{requested}\"; nothing was selected. Options: \
			 {options}"
		),
		Refusal::Ambiguous => format!(
			"several popup options are titled \"{requested}\", so the value cannot say which; \
			 nothing was selected. Options: {options}"
		),
	}
}

/// The titled options, quoted, in menu order.
fn option_list(titles: &[String]) -> String {
	titles
		.iter()
		.filter(|title| !title.is_empty())
		.map(|title| format!("\"{title}\""))
		.collect::<Vec<_>>()
		.join(", ")
}

/// The popup's options: the items of its open `AXMenu`, plus any options it
/// publishes as direct children.
fn menu_items(popup: &AXUIElement) -> Vec<CFRetained<AXUIElement>> {
	let mut items = Vec::new();
	for child in copy_elements_optional(popup, "AXChildren").unwrap_or_default() {
		match copy_string(&child, "AXRole").as_deref() {
			Some("AXMenu") => {
				items.extend(copy_elements_optional(&child, "AXChildren").unwrap_or_default());
			},
			Some("AXMenuItem") => items.push(child),
			_ => {},
		}
	}
	items
}

fn open_menu_element(popup: &AXUIElement) -> Option<CFRetained<AXUIElement>> {
	copy_elements_optional(popup, "AXChildren")?
		.into_iter()
		.find(|child| copy_string(child, "AXRole").as_deref() == Some("AXMenu"))
}

/// Waits for an open menu's options, ignoring the closed popup's chosen item.
fn await_menu<T>(
	wait: Duration,
	closed: usize,
	mut probe: impl FnMut() -> (bool, Vec<T>),
) -> Option<Vec<T>> {
	poll(wait, || {
		let (open, items) = probe();
		(!items.is_empty() && (open || items.len() > closed)).then_some(items)
	})
}

/// Opens a closed popup's menu with the control's own action and returns its
/// items once the app has built them. `AXPress` is what a click does;
/// `AXShowMenu` is the fallback for popups the first leaves without options.
fn open_menu(
	popup: &AXUIElement,
	windows: Option<(libc::pid_t, &[u32])>,
	closed: usize,
) -> CoreResult<Vec<CFRetained<AXUIElement>>> {
	let actions = copy_strings_from_action_names(popup)?;
	let mut attempts = Vec::new();
	let mut left_open = false;
	for action in ["AXPress", "AXShowMenu"] {
		if !actions.iter().any(|name| name == action) {
			continue;
		}
		// The probes before can block; an app the user used meanwhile is left
		// to them ([`control::intervention::check_press`]).
		control::intervention::check_press()?;
		if let Err(error) = perform_action(popup, action) {
			attempts.push(error.message);
			continue;
		}
		let published = await_menu(MENU_OPEN_WAIT, closed, || {
			if let Some(menu) = open_menu_element(popup) {
				let items = copy_elements_optional(&menu, "AXChildren").unwrap_or_default();
				if !items.is_empty() {
					return (true, items);
				}
			}
			(false, menu_items(popup))
		});
		if let Some(items) = published {
			return Ok(items);
		}
		attempts
			.push(format!("{action} published no options within {} ms", MENU_OPEN_WAIT.as_millis()));
		// Close an empty menu so the next action opens it instead of toggling it
		// shut; a menu that stays open ends the attempts.
		if !close_menu(popup, windows, false) {
			left_open = true;
			break;
		}
	}
	if attempts.is_empty() {
		return Err(DesktopError::ax_failed(format!(
			"popup button advertises neither AXPress nor AXShowMenu (actions: {}); nothing was \
			 selected",
			actions.join(", ")
		)));
	}
	let error = DesktopError::ax_failed(format!(
		"popup menu published no options ({}); nothing was selected",
		attempts.join("; ")
	));
	Err(if left_open {
		menu_left_open(error)
	} else {
		error
	})
}

/// Presses the chosen item, ends its menu at once, and waits for the popup to
/// report the choice. The popup's value, not the press's return code, says
/// whether the app took the choice.
fn press_option(
	popup: &AXUIElement,
	item: &AXUIElement,
	title: &str,
	close: impl FnOnce() -> bool,
) -> CoreResult<()> {
	if copy_bool(item, "AXEnabled") == Some(false) {
		return Err(DesktopError::ax_failed(format!(
			"popup option \"{title}\" is disabled; nothing was selected"
		)));
	}
	settle_choice(
		title,
		CHOICE_SETTLE_WAIT,
		|| {
			control::intervention::check_press()?;
			perform_action(item, "AXPress")
		},
		close,
		|| copy_string(popup, "AXValue"),
	)
}

/// Runs `press` on the option titled `title`, then `close`s its menu
/// ([`close_menu`]), then waits up to `taking` for the popup's `value` to read
/// `title`. A pressed item flashes and its menu fades out for about 340 ms,
/// and until the menu is gone `WindowServer` sends the user's keys to the
/// target, which types them into its own key window once it closes;
/// `AXCancel` right behind the press ends the menu within a few milliseconds,
/// and `AppKit` still sends the item's action. The choice is not reported
/// until the menu is gone: one still open fails.
fn settle_choice(
	title: &str,
	taking: Duration,
	press: impl FnOnce() -> CoreResult<()>,
	close: impl FnOnce() -> bool,
	mut value: impl FnMut() -> Option<String>,
) -> CoreResult<()> {
	press()?;
	if !close() {
		return Err(DesktopError::ax_failed(format!(
			"pressed popup option \"{title}\" but its menu did not close, and an open menu keeps the \
			 keyboard from the user's app; inspect the popup before retrying"
		)));
	}
	let mut after = None;
	let taken = poll(taking, || {
		after = value();
		(after.as_deref() == Some(title)).then_some(())
	});
	if taken.is_some() {
		return Ok(());
	}
	Err(DesktopError::ax_failed(match after {
		Some(after) => format!(
			"pressed popup option \"{title}\" but the popup still reads \"{after}\"; the app did not \
			 take the choice"
		),
		None => format!(
			"pressed popup option \"{title}\" but the popup publishes no readable value, so the \
			 choice could not be confirmed"
		),
	}))
}

/// Closes the menu this call opened, after an option was `pressed` or not, as
/// other menus are closed ([`open_menu::close_opened`]), watching the app's
/// menu windows (`windows`: its pid and its menu windows before the open) and
/// the popup's menu element; when the windows cannot be read, with `AXCancel`
/// alone, ignoring a pressed menu's refusal, since it closes after its fade.
/// `true` once no menu is open.
fn close_menu(popup: &AXUIElement, windows: Option<(libc::pid_t, &[u32])>, pressed: bool) -> bool {
	let menu = open_menu_element(popup);
	if let Some((pid, before)) = windows {
		let shows = || open_menu_element(popup).is_some();
		match open_menu::close_opened(pid, before, menu.as_ref(), pressed, shows) {
			Ok(Some(closed)) => return closed,
			Ok(None) => {},
			Err(_) => return false,
		}
	}
	let Some(menu) = menu else {
		return true;
	};
	(perform_action(&menu, "AXCancel").is_ok() || pressed)
		&& poll(MENU_CLOSE_WAIT, || open_menu_element(popup).is_none().then_some(())).is_some()
}

/// Runs `probe` every `POLL_INTERVAL` until it yields a value or `wait` has
/// elapsed; the last probe runs at or after the deadline.
pub(super) fn poll<T>(wait: Duration, mut probe: impl FnMut() -> Option<T>) -> Option<T> {
	let deadline = Instant::now() + wait;
	loop {
		if let Some(value) = probe() {
			return Some(value);
		}
		if Instant::now() >= deadline {
			return None;
		}
		thread::sleep(POLL_INTERVAL);
	}
}

#[cfg(test)]
mod tests {
	use std::{cell::RefCell, time::Duration};

	use super::{
		Refusal, await_menu, choose_option, option_list, option_title, settle_choice, unopened,
	};

	fn titles(names: &[&str]) -> Vec<String> {
		names.iter().map(ToString::to_string).collect()
	}

	#[test]
	fn the_exactly_titled_option_is_chosen_at_its_menu_position() {
		let menu = titles(&["Rich Text Document", "", "Web Page (.html)", "OpenDocument Text"]);
		assert_eq!(choose_option(&menu, "Web Page (.html)"), Ok(2));
	}

	#[test]
	fn a_case_or_spacing_near_miss_chooses_nothing() {
		let menu = titles(&["JPEG", "jpeg ", "PNG"]);
		assert_eq!(choose_option(&menu, "jpeg"), Err(Refusal::Missing));
		assert_eq!(choose_option(&menu, " PNG"), Err(Refusal::Missing));
	}

	#[test]
	fn a_shared_title_is_ambiguous() {
		let menu = titles(&["Custom…", "None", "Custom…"]);
		assert_eq!(choose_option(&menu, "Custom…"), Err(Refusal::Ambiguous));
	}

	#[test]
	fn separators_are_neither_chosen_nor_listed() {
		let menu = titles(&["Small", "", "Large"]);
		assert_eq!(choose_option(&menu, ""), Err(Refusal::Missing));
		assert_eq!(option_list(&menu), "\"Small\", \"Large\"");
	}

	#[test]
	fn a_pressed_option_ends_its_menu_before_the_choice_is_read() {
		let log = RefCell::new(Vec::new());
		let chosen = settle_choice(
			"Large",
			Duration::ZERO,
			|| {
				log.borrow_mut().push("press");
				Ok(())
			},
			|| {
				log.borrow_mut().push("close");
				true
			},
			|| {
				log.borrow_mut().push("value");
				Some("Large".to_string())
			},
		);
		assert!(chosen.is_ok(), "{chosen:?}");
		// Read before the close, the menu would still be fading with the
		// keyboard.
		assert_eq!(*log.borrow(), ["press", "close", "value"]);
	}

	#[test]
	fn a_choice_whose_menu_stays_open_fails() {
		// The app took the choice, but the menu still holds the keyboard.
		let error =
			settle_choice("Large", Duration::ZERO, || Ok(()), || false, || Some("Large".to_string()))
				.expect_err("the menu is still open");
		assert!(error.message.contains("its menu did not close"), "{}", error.message);
	}

	#[test]
	fn a_choice_the_app_did_not_take_is_reported_after_the_close() {
		let error =
			settle_choice("Large", Duration::ZERO, || Ok(()), || true, || Some("Small".to_string()))
				.expect_err("the popup still reads Small");
		assert!(error.message.contains("still reads \"Small\""), "{}", error.message);
	}

	#[test]
	fn an_untitled_option_is_matched_by_its_value() {
		// Chromium's `<option>` items carry their text as `AXValue` with an
		// empty title.
		let menu: Vec<String> = [("", "Low"), ("", "Mediocre"), ("", "Medium")]
			.iter()
			.map(|(title, value)| {
				option_title(Some((*title).to_string()), || Some((*value).to_string()))
			})
			.collect();
		assert_eq!(choose_option(&menu, "Medium"), Ok(2));
		assert_eq!(option_list(&menu), "\"Low\", \"Mediocre\", \"Medium\"");
		// A title wins over the value; an item with neither is a separator.
		assert_eq!(
			option_title(Some("Large".to_string()), || panic!("a titled option's value is not read")),
			"Large"
		);
		assert_eq!(option_title(Some(String::new()), || None), "");
		assert_eq!(option_title(None, || None), "");
	}

	#[test]
	fn a_popup_with_direct_menu_items_chooses_its_newly_published_option() {
		let closed = titles(&["Low"]);
		assert!(await_menu(Duration::ZERO, closed.len(), || (false, closed.clone())).is_none());
		assert_eq!(
			await_menu(Duration::ZERO, closed.len(), || (true, closed.clone())),
			Some(closed.clone())
		);
		let items =
			await_menu(Duration::ZERO, closed.len(), || (false, titles(&["Low", "Medium", "High"])));
		assert_eq!(choose_option(&items.expect("the open menu has options"), "Medium"), Ok(1));
	}

	#[test]
	fn a_menu_that_would_not_open_still_lists_the_published_options() {
		let failed =
			|| crate::desktop::error::DesktopError::ax_failed("popup menu published no options");
		let error = unopened(failed(), "Medium", &titles(&["Low", "High"]));
		assert!(
			error
				.message
				.starts_with("no popup option is titled exactly \"Medium\"")
				&& error.message.contains("Options: \"Low\", \"High\"")
				&& error
					.message
					.ends_with("failed: popup menu published no options"),
			"{}",
			error.message
		);
		// A popup that published nothing has only the open's failure to report.
		assert_eq!(unopened(failed(), "Medium", &[]).message, "popup menu published no options");
	}
}
