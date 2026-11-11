use napi_derive::napi;

use super::error::{CoreResult, DesktopError};

/// One immediate child of a native application menu. Paths contain the actual
/// native labels, including ellipses; selection accepts normalized labels.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct DesktopMenuItem {
	pub title:       String,
	pub path:        Vec<String>,
	pub enabled:     bool,
	pub checked:     bool,
	pub has_submenu: bool,
	pub shortcut:    Option<String>,
}

pub(crate) fn validate_path(path: &[String], allow_empty: bool) -> CoreResult<()> {
	if (!allow_empty && path.is_empty()) || path.len() > 32 {
		return Err(DesktopError::invalid_target("menu path must contain 1..32 labels"));
	}
	if path
		.iter()
		.any(|label| label.trim().is_empty() || label.contains('\0'))
	{
		return Err(DesktopError::invalid_target("menu path contains an empty or NUL label"));
	}
	Ok(())
}

fn normalized(label: &str) -> &str {
	let label = label.trim();
	label
		.strip_suffix("...")
		.or_else(|| label.strip_suffix('…'))
		.unwrap_or(label)
		.trim_end()
}

/// Exact case-insensitive labels win over ellipsis-normalized matches. Every
/// tier must have exactly one match: order and enabled state never break ties.
pub(crate) fn match_index(items: &[DesktopMenuItem], label: &str) -> CoreResult<usize> {
	let folded = label.trim().to_lowercase();
	let mut exact = items
		.iter()
		.enumerate()
		.filter(|(_, item)| item.title.trim().to_lowercase() == folded);
	if let Some((index, _)) = exact.next() {
		return if exact.next().is_some() {
			Err(DesktopError::ax_failed(format!("menu label '{label}' is ambiguous")))
		} else {
			Ok(index)
		};
	}
	let folded = normalized(label).to_lowercase();
	let mut matches = items
		.iter()
		.enumerate()
		.filter(|(_, item)| normalized(&item.title).to_lowercase() == folded);
	match (matches.next(), matches.next()) {
		(Some((index, _)), None) => Ok(index),
		(None, _) => Err(DesktopError::ax_failed(format!("menu item '{label}' was not found"))),
		_ => Err(DesktopError::ax_failed(format!(
			"menu label '{label}' is ambiguous after ellipsis normalization"
		))),
	}
}

/// The most labels a miss in a menu bar path names, and the most characters
/// of each.
const MAX_OFFERED_LABELS: usize = 40;
const MAX_OFFERED_CHARS: usize = 80;

/// [`match_index`] for one level of a menu bar path. A label no item has is
/// refused naming the labels the level offers, so the next call can choose
/// one without reading the menu first; an open menu's refusal lists them
/// apart.
pub(crate) fn match_offered(items: &[DesktopMenuItem], label: &str) -> CoreResult<usize> {
	match_index(items, label).map_err(|mut error| {
		let wanted = normalized(label).to_lowercase();
		if items
			.iter()
			.any(|item| normalized(&item.title).to_lowercase() == wanted)
		{
			// Ambiguous, not missing.
			return error;
		}
		let named: Vec<_> = items
			.iter()
			.map(|item| item.title.trim())
			.filter(|title| !title.is_empty())
			.collect();
		if named.is_empty() {
			return error;
		}
		let shown = named
			.iter()
			.take(MAX_OFFERED_LABELS)
			.map(|title| {
				if title.chars().count() > MAX_OFFERED_CHARS {
					let cut: String = title.chars().take(MAX_OFFERED_CHARS - 1).collect();
					format!("'{cut}…'")
				} else {
					format!("'{title}'")
				}
			})
			.collect::<Vec<_>>()
			.join(", ");
		let more = match named.len().saturating_sub(MAX_OFFERED_LABELS) {
			0 => String::new(),
			more => format!(" and {more} more"),
		};
		error.message = format!("{}; this menu has {shown}{more}", error.message);
		error
	})
}

pub(crate) fn require_enabled(item: &DesktopMenuItem) -> CoreResult<()> {
	item.enabled.ok_or_else(|| {
		DesktopError::ax_failed(format!(
			"menu item '{}' is disabled; no command was dispatched",
			item.path.join(" > ")
		))
	})
}

pub(crate) fn require_command(item: &DesktopMenuItem) -> CoreResult<()> {
	require_enabled(item)?;
	if item.has_submenu || item.title.trim().is_empty() {
		return Err(DesktopError::ax_failed(
			"select a named leaf menu command, not a submenu or separator",
		));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn item(title: &str) -> DesktopMenuItem {
		DesktopMenuItem {
			title:       title.into(),
			path:        vec![title.into()],
			enabled:     true,
			checked:     false,
			has_submenu: false,
			shortcut:    None,
		}
	}

	#[test]
	fn exact_label_wins_before_ellipsis_normalization() {
		assert_eq!(match_index(&[item("Open…"), item("Open")], "OPEN").unwrap(), 1);
		assert_eq!(match_index(&[item("Open…")], "open...").unwrap(), 0);
	}

	#[test]
	fn duplicate_and_normalized_ambiguities_refuse() {
		assert!(match_index(&[item("Save"), item("SAVE")], "save").is_err());
		assert!(match_index(&[item("Save…"), item("Save...")], "save").is_err());
		assert!(match_index(&[item("Save")], "Save As").is_err());
	}

	#[test]
	fn a_menu_bar_miss_names_the_labels_on_offer() {
		let items = [item("New"), item("Open…"), item(""), item("Save")];
		let error = match_offered(&items, "Nope").unwrap_err();
		assert_eq!(
			error.message,
			"menu item 'Nope' was not found; this menu has 'New', 'Open…', 'Save'"
		);
		assert_eq!(match_offered(&items, "open...").unwrap(), 1);
		// An ambiguous label is no miss: the labels it matched are its answer.
		let error = match_offered(&[item("Save"), item("SAVE")], "save").unwrap_err();
		assert_eq!(error.message, "menu label 'save' is ambiguous");
		let many: Vec<_> = (0..MAX_OFFERED_LABELS + 2)
			.map(|n| item(&format!("Item {n}")))
			.collect();
		let error = match_offered(&many, "Nope").unwrap_err();
		assert!(error.message.ends_with("'Item 39' and 2 more"), "{}", error.message);
		// A History menu's page titles are cut, each to its own budget.
		let long = "x".repeat(MAX_OFFERED_CHARS + 20);
		let error = match_offered(&[item(&long), item("Show All History")], "Nope").unwrap_err();
		let cut = format!("'{}…'", "x".repeat(MAX_OFFERED_CHARS - 1));
		assert!(error.message.contains(&cut), "{}", error.message);
		assert!(error.message.ends_with(", 'Show All History'"), "{}", error.message);
	}

	#[test]
	fn disabled_or_submenu_never_qualifies_as_a_command() {
		let mut disabled = item("Save");
		disabled.enabled = false;
		let items = [disabled, item("Save…")];
		let index = match_index(&items, "Save").unwrap();
		assert!(require_command(&items[index]).is_err());
		let mut submenu = item("File");
		submenu.has_submenu = true;
		assert!(require_command(&submenu).is_err());
	}

	#[test]
	fn invalid_paths_fail_before_native_access() {
		assert!(validate_path(&[], false).is_err());
		assert!(validate_path(&["\0".into()], true).is_err());
		assert!(validate_path(&[" ".into()], true).is_err());
		assert!(validate_path(&vec!["File".into(); 33], true).is_err());
	}
}
