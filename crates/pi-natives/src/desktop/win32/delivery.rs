//! Pure Win32 background-delivery compatibility matrix.
//!
//! This module deliberately has no Windows imports so its class-name logic is
//! exercised by the host test suite on every platform.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EventKind {
	MouseClick,
	MouseMove,
	MouseScroll,
	Keystroke,
	KeyCombo,
	TextInput,
}

impl EventKind {
	pub(crate) const fn name(self) -> &'static str {
		match self {
			Self::MouseClick => "mouse_click",
			Self::MouseMove => "mouse_move",
			Self::MouseScroll => "mouse_scroll",
			Self::Keystroke => "keystroke",
			Self::KeyCombo => "key_combo",
			Self::TextInput => "text_input",
		}
	}
}

pub fn is_chromium_class(class: &str) -> bool {
	class
		.strip_prefix("Chrome_WidgetWin_")
		.is_some_and(|suffix| !suffix.is_empty())
}

pub fn is_winui3_class(class: &str) -> bool {
	class == "WinUIDesktopWin32WindowClass"
}

pub fn is_wpf_class(class: &str) -> bool {
	class
		.strip_prefix("HwndWrapper[")
		.is_some_and(|body| !body.is_empty() && body.ends_with(']'))
}

pub fn is_tk_class(class: &str) -> bool {
	class == "TkTopLevel"
		|| class
			.strip_prefix("TkTopLevel.")
			.is_some_and(|suffix| !suffix.is_empty())
}

pub fn is_gtk_class(class: &str) -> bool {
	class == "gdkWindowToplevel" || class == "gdkSurfaceToplevel"
}

pub fn is_vcl_class(class: &str) -> bool {
	class
		.strip_prefix("SAL")
		.is_some_and(|suffix| !suffix.is_empty())
}

/// Returns the empirical reason that a posted event would be accepted by
/// Win32 but silently ignored by the target toolkit.
pub fn would_be_silently_dropped(class: &str, kind: EventKind) -> Option<&'static str> {
	use EventKind::{KeyCombo, Keystroke, MouseClick, MouseMove, MouseScroll, TextInput};

	if is_chromium_class(class) {
		return Some("Chromium requires input originating from the system input queue");
	}
	if is_winui3_class(class) && matches!(kind, MouseClick | MouseMove | MouseScroll) {
		return Some("WinUI3 hosts pointer input in a content island rather than the frame HWND");
	}
	if is_wpf_class(class)
		&& matches!(kind, MouseClick | MouseMove | Keystroke | KeyCombo | TextInput)
	{
		return Some("WPF ignores posted routed pointer and keyboard input");
	}
	if is_tk_class(class) && matches!(kind, Keystroke | KeyCombo | TextInput) {
		return Some("Tk widgets ignore posted keyboard input");
	}
	if is_gtk_class(class) && matches!(kind, MouseClick) {
		return Some("GTK buttons ignore posted mouse-button messages");
	}
	if is_vcl_class(class) && matches!(kind, Keystroke | KeyCombo) {
		return Some("VCL accelerators require real key state from the system input queue");
	}
	None
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn recognizes_real_classes_and_rejects_lookalikes() {
		assert!(is_chromium_class("Chrome_WidgetWin_1"));
		assert!(!is_chromium_class("Chrome_WidgetWin_"));
		assert!(!is_chromium_class("ChromeWidgetWin_1"));

		assert!(is_winui3_class("WinUIDesktopWin32WindowClass"));
		assert!(!is_winui3_class("WinUIDesktopWin32WindowClass2"));

		assert!(is_wpf_class("HwndWrapper[App;;abc]"));
		assert!(!is_wpf_class("HwndWrapper[App;;abc"));
		assert!(!is_wpf_class("HwndWrapperApp;;abc]"));

		assert!(is_tk_class("TkTopLevel.1"));
		assert!(is_tk_class("TkTopLevel"));
		assert!(!is_tk_class("TkTopLevelish"));
		assert!(!is_tk_class("TkTopLevel."));

		assert!(is_gtk_class("gdkSurfaceToplevel"));
		assert!(is_gtk_class("gdkWindowToplevel"));
		assert!(!is_gtk_class("gdkSurfaceToplevelExtra"));
		assert!(!is_gtk_class("gdkWindowChild"));

		assert!(is_vcl_class("SALFRAME"));
		assert!(!is_vcl_class("SAL"));
		assert!(!is_vcl_class("XSALFRAME"));
	}

	fn assert_matrix(class: &str, expected: [bool; 6]) {
		let kinds = [
			EventKind::MouseClick,
			EventKind::MouseMove,
			EventKind::MouseScroll,
			EventKind::Keystroke,
			EventKind::KeyCombo,
			EventKind::TextInput,
		];
		for (kind, expected) in kinds.into_iter().zip(expected) {
			assert_eq!(
				would_be_silently_dropped(class, kind).is_some(),
				expected,
				"unexpected {class}/{} delivery decision",
				kind.name(),
			);
		}
	}

	#[test]
	fn covers_the_full_known_silent_drop_matrix() {
		assert_matrix("Chrome_WidgetWin_1", [true, true, true, true, true, true]);
		assert_matrix("WinUIDesktopWin32WindowClass", [true, true, true, false, false, false]);
		assert_matrix("HwndWrapper[App;;abc]", [true, true, false, true, true, true]);
		assert_matrix("TkTopLevel.1", [false, false, false, true, true, true]);
		assert_matrix("gdkSurfaceToplevel", [true, false, false, false, false, false]);
		assert_matrix("gdkWindowToplevel", [true, false, false, false, false, false]);
		assert_matrix("SALFRAME", [false, false, false, true, true, false]);
		assert_matrix("Chrome_WidgetWin", [false, false, false, false, false, false]);
		assert_matrix("HwndWrapperApp;;abc]", [false, false, false, false, false, false]);
		assert_matrix("TkTopLevelish", [false, false, false, false, false, false]);
		assert_matrix("gdkSurfaceToplevelExtra", [false, false, false, false, false, false]);
		assert_matrix("XSALFRAME", [false, false, false, false, false, false]);
	}
}
