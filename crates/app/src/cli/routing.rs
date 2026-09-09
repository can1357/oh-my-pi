//! Reserved extension-management routing without prompt-sentence theft.

use std::ffi::OsString;

use omp_core::Str;

/// Classifies a documented-looking obsolete management invocation.
pub fn redirect(arguments: &[OsString]) -> Option<Str> {
	let first = arguments.get(1)?.to_str()?;
	if first.starts_with('-') || first.starts_with('@') {
		return None;
	}
	let second = arguments.get(2).and_then(|value| value.to_str());
	let bare = second.is_none();
	let marketplace_action = first == "marketplace"
		&& second.is_some_and(|value| matches!(value, "add" | "remove" | "rm" | "update" | "list"));
	let qualified = arguments
		.iter()
		.skip(2)
		.filter_map(|value| value.to_str())
		.any(|value| !value.starts_with('-') && value.contains('@'));
	let reserved = matches!(
		first,
		"extensions"
			| "list"
			| "remove"
			| "uninstall"
			| "marketplace"
			| "discover"
			| "upgrade"
			| "enable"
			| "disable"
	);
	if reserved && (bare || marketplace_action || qualified) {
		Some(Str::from(format!(
			"`omp {first}` is not a native command; use `omp ext` for extension management, or `omp \
			 print {first} …` to send it as a prompt"
		)))
	} else {
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn redirects_management_but_preserves_sentences() {
		assert!(redirect(&["omp", "marketplace", "add", "repo"].map(OsString::from)).is_some());
		assert!(redirect(&["omp", "list"].map(OsString::from)).is_some());
		assert!(redirect(&["omp", "discover", "name@marketplace"].map(OsString::from)).is_some());
		assert!(redirect(&["omp", "upgrade", "the", "dependencies"].map(OsString::from)).is_none());
		assert!(redirect(&["omp", "install", "name@marketplace"].map(OsString::from)).is_none());
		assert!(redirect(&["omp", "plugin", "list"].map(OsString::from)).is_none());
		assert!(redirect(&["omp", "--model", "list"].map(OsString::from)).is_none());
	}
}
