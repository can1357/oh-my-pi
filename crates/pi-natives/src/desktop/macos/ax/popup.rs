//! Choosing an option of an `AXPopUpButton`.
//!
//! A popup's options are the `AXMenuItem`s of its `AXMenu`, and its `AXValue`
//! is not settable. `AppKit` builds that menu's accessibility items only while
//! the menu is open, so a closed native popup publishes no options at all:
//! choosing one means opening the menu, pressing the item, and reading the
//! popup's `AXValue` back as the verdict.

use std::{
	thread,
	time::{Duration, Instant},
};

use objc2_application_services::AXUIElement;
use objc2_core_foundation::CFRetained;

use super::{
	CoreResult, DesktopError, copy_bool, copy_elements_optional, copy_string,
	copy_strings_from_action_names, perform_action,
};

/// How long a popup has to publish its menu items after the open action.
const MENU_OPEN_WAIT: Duration = Duration::from_millis(1000);
/// How long a pressed option has to show up as the popup's value.
const CHOICE_SETTLE_WAIT: Duration = Duration::from_millis(1000);
/// How long a cancelled menu has to leave the popup's children.
const MENU_CLOSE_WAIT: Duration = Duration::from_millis(300);
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
	let opened = items.is_empty();
	if opened {
		items = open_menu(popup)?;
	}
	let titles: Vec<String> = items
		.iter()
		.map(|item| copy_string(item, "AXTitle").unwrap_or_default())
		.collect();
	let result = choose_option(&titles, value)
		.map_err(|refusal| DesktopError::ax_failed(refusal_message(&refusal, value, &titles)))
		.and_then(|index| press_option(popup, &items[index], value));
	match result {
		Err(error) if opened && !close_menu(popup) => Err(menu_left_open(error)),
		result => result,
	}
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

/// Opens a closed popup's menu with the control's own action and returns its
/// items once `AppKit` has built them. `AXPress` is what a click does;
/// `AXShowMenu` is the fallback for popups the first leaves without options.
fn open_menu(popup: &AXUIElement) -> CoreResult<Vec<CFRetained<AXUIElement>>> {
	let actions = copy_strings_from_action_names(popup)?;
	let mut attempts = Vec::new();
	let mut left_open = false;
	for action in ["AXPress", "AXShowMenu"] {
		if !actions.iter().any(|name| name == action) {
			continue;
		}
		if let Err(error) = perform_action(popup, action) {
			attempts.push(error.message);
			continue;
		}
		let published = poll(MENU_OPEN_WAIT, || {
			let items = menu_items(popup);
			(!items.is_empty()).then_some(items)
		});
		if let Some(items) = published {
			return Ok(items);
		}
		attempts
			.push(format!("{action} published no options within {} ms", MENU_OPEN_WAIT.as_millis()));
		// Close an empty menu so the next action opens it instead of toggling it
		// shut; a menu that stays open ends the attempts.
		if !close_menu(popup) {
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

/// Presses the chosen item and waits for the popup to report it. The popup's
/// value, not the press's return code, says whether the app took the choice.
fn press_option(popup: &AXUIElement, item: &AXUIElement, title: &str) -> CoreResult<()> {
	if copy_bool(item, "AXEnabled") == Some(false) {
		return Err(DesktopError::ax_failed(format!(
			"popup option \"{title}\" is disabled; nothing was selected"
		)));
	}
	perform_action(item, "AXPress")?;
	let mut after = None;
	let taken = poll(CHOICE_SETTLE_WAIT, || {
		after = copy_string(popup, "AXValue");
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

/// Cancels the popup's open menu. `true` once no menu is open.
fn close_menu(popup: &AXUIElement) -> bool {
	let Some(menu) = open_menu_element(popup) else {
		return true;
	};
	if perform_action(&menu, "AXCancel").is_err() {
		return false;
	}
	poll(MENU_CLOSE_WAIT, || open_menu_element(popup).is_none().then_some(())).is_some()
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
	use super::{Refusal, choose_option, option_list};

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
}
