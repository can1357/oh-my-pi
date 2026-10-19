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

pub(crate) fn require_enabled(item: &DesktopMenuItem) -> CoreResult<()> {
	if item.enabled {
		Ok(())
	} else {
		Err(DesktopError::ax_failed(format!(
			"menu item '{}' is disabled; no command was dispatched",
			item.path.join(" > ")
		)))
	}
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
