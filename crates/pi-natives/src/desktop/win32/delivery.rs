//! Pure Win32 background-delivery decisions.
//!
//! This module deliberately has no Windows imports so its class-name,
//! hit-test, and text-shaping logic is exercised by the host test suite on
//! every platform.

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

/// Facts about a target window that decide whether posted input reaches the
/// toolkit that owns it.
#[derive(Clone, Copy, Debug)]
pub struct TargetTraits<'a> {
	/// Class name of the target's top-level window.
	pub class:               &'a str,
	/// A Chromium or CEF renderer lives in a descendant window (`WebView2`,
	/// Tauri, embedded CEF).
	pub chromium_descendant: bool,
	/// The target's top-level window currently owns the foreground.
	pub foreground:          bool,
	/// The target renders XAML/UWP/WinUI content, whose `CoreInput`
	/// dispatcher reads keyboard input only from the system input queue.
	pub xaml_host:           bool,
}

pub fn is_chromium_class(class: &str) -> bool {
	class
		.strip_prefix("Chrome_WidgetWin_")
		.is_some_and(|suffix| !suffix.is_empty())
		|| class.starts_with("CefBrowser")
		|| class == "Chrome_RenderWidgetHostHWND"
}

pub fn is_winui3_class(class: &str) -> bool {
	class == "WinUIDesktopWin32WindowClass"
}

/// UWP frames, whose app content is a `CoreWindow` fed by system pointer input.
pub fn is_uwp_frame_class(class: &str) -> bool {
	matches!(class, "ApplicationFrameWindow" | "Windows.UI.Core.CoreWindow")
}

/// Terminal hosts (Windows Terminal, console host, mintty, Vim, Neovim) read
/// text through their console or VT input channel rather than `WM_CHAR`.
pub fn is_terminal_class(class: &str) -> bool {
	["CASCADIA_HOSTING_WINDOW_CLASS", "ConsoleWindowClass", "mintty", "nvim", "Vim"]
		.into_iter()
		.any(|prefix| class.starts_with(prefix))
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

/// GTK 3 registers `gdkWindow*` classes and GTK 4 `gdkSurface*` classes, for
/// toplevels and for popups/menus alike.
pub fn is_gtk_class(class: &str) -> bool {
	["gdkWindow", "gdkSurface"].into_iter().any(|prefix| {
		class
			.strip_prefix(prefix)
			.is_some_and(|suffix| !suffix.is_empty())
	})
}

pub fn is_vcl_class(class: &str) -> bool {
	class
		.strip_prefix("SAL")
		.is_some_and(|suffix| !suffix.is_empty())
}

/// Returns the empirical reason that a posted event would be accepted by
/// Win32 but silently ignored by the target toolkit.
pub fn would_be_silently_dropped(
	target: TargetTraits<'_>,
	kind: EventKind,
) -> Option<&'static str> {
	use EventKind::{KeyCombo, Keystroke, MouseClick, MouseMove, MouseScroll, TextInput};

	let class = target.class;
	if is_chromium_class(class) {
		return Some("Chromium requires input originating from the system input queue");
	}
	if target.chromium_descendant && matches!(kind, MouseMove | MouseScroll | KeyCombo) {
		return Some(
			"its embedded Chromium renderer takes drags, wheel, and modifier chords only from the \
			 system input queue",
		);
	}
	if target.xaml_host && matches!(kind, Keystroke | KeyCombo | TextInput) {
		return Some("XAML hosts read keyboard input only from the system input queue");
	}
	if is_uwp_frame_class(class) && matches!(kind, MouseClick | MouseMove) {
		return Some("UWP content reads pointer input only from the system input queue");
	}
	if is_winui3_class(class) && matches!(kind, MouseClick | MouseMove | MouseScroll) {
		return Some("WinUI3 hosts pointer input in a content island rather than the frame HWND");
	}
	if is_wpf_class(class)
		&& (matches!(kind, MouseClick | MouseMove | TextInput)
			|| (!target.foreground && matches!(kind, Keystroke | KeyCombo)))
	{
		return Some(
			"WPF ignores posted pointer and text input, and posted keys unless it owns the foreground",
		);
	}
	if is_tk_class(class) && matches!(kind, MouseClick | Keystroke | KeyCombo | TextInput) {
		return Some("Tk reads button and key state from GetKeyState, which posted input never sets");
	}
	if is_gtk_class(class) && matches!(kind, MouseClick) {
		return Some("GTK buttons ignore posted mouse-button messages");
	}
	if is_vcl_class(class) && matches!(kind, Keystroke | KeyCombo) {
		return Some("VCL accelerators require real key state from the system input queue");
	}
	if is_terminal_class(class) && !target.foreground && matches!(kind, TextInput) {
		return Some("terminal hosts read text through their console input channel");
	}
	None
}

/// Why typed text can never be confirmed on `class`, in either delivery mode:
/// native console host on Windows ARM64 accepts every synthesized Unicode
/// packet while its prompt stays unchanged.
pub fn text_input_unsupported(class: &str, arm64: bool) -> Option<&'static str> {
	(arm64 && class.starts_with("ConsoleWindowClass")).then_some(
		"native console host on Windows ARM64 accepts synthesized text without delivering it; drive \
		 the console through a process or PTY instead",
	)
}

/// Names the non-client region of a `WM_NCHITTEST` result where a posted drag
/// can never work: caption and sizing-border presses enter the system
/// move/size modal loop, which follows only real pointer input.
pub const fn non_client_drag_region(hit: isize) -> Option<&'static str> {
	match hit {
		// HTCAPTION
		2 => Some("caption"),
		// HTGROWBOX
		4 => Some("size box"),
		// HTLEFT..=HTBOTTOMRIGHT
		10..=17 => Some("resize border"),
		_ => None,
	}
}

/// Whether posted press `index` (zero-based) must be `WM_*BUTTONDBLCLK`.
///
/// Win32 synthesizes double-click messages only for classes registered with
/// `CS_DBLCLKS`, on the second press of each pair; other classes see a second
/// plain press.
pub const fn posts_double_click(index: u32, class_wants_double: bool) -> bool {
	class_wants_double && index % 2 == 1
}

/// One unit of typed text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TextUnit {
	/// A character delivered as `WM_CHAR` or a Unicode key packet.
	Char(char),
	/// A line break delivered as a real Return keystroke.
	Enter,
}

/// Splits text into typed units, turning each `\n`, `\r`, or `\r\n` into one
/// Return keystroke: rich editors and terminals drop raw carriage-return and
/// line-feed characters but honor the key.
pub fn text_units(text: &str) -> impl Iterator<Item = TextUnit> + '_ {
	let mut after_carriage_return = false;
	text.chars().filter_map(move |character| {
		let unit = match character {
			'\n' if after_carriage_return => None,
			'\n' | '\r' => Some(TextUnit::Enter),
			other => Some(TextUnit::Char(other)),
		};
		after_carriage_return = character == '\r';
		unit
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn recognizes_real_classes_and_rejects_lookalikes() {
		assert!(is_chromium_class("Chrome_WidgetWin_1"));
		assert!(is_chromium_class("CefBrowserWindow"));
		assert!(is_chromium_class("Chrome_RenderWidgetHostHWND"));
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
		assert!(is_gtk_class("gdkWindowTemp"));
		assert!(!is_gtk_class("gdkWindow"));
		assert!(!is_gtk_class("GdkWindowToplevel"));

		assert!(is_vcl_class("SALFRAME"));
		assert!(!is_vcl_class("SAL"));
		assert!(!is_vcl_class("XSALFRAME"));
	}

	fn assert_matrix(target: TargetTraits<'_>, expected: [bool; 6]) {
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
				would_be_silently_dropped(target, kind).is_some(),
				expected,
				"unexpected {target:?}/{} delivery decision",
				kind.name(),
			);
		}
	}

	const fn background(class: &str) -> TargetTraits<'_> {
		TargetTraits { class, chromium_descendant: false, foreground: false, xaml_host: false }
	}

	#[test]
	fn covers_the_full_known_silent_drop_matrix() {
		assert_matrix(background("Chrome_WidgetWin_1"), [true; 6]);
		assert_matrix(background("CefBrowserWindow"), [true; 6]);
		assert_matrix(background("Chrome_RenderWidgetHostHWND"), [true; 6]);
		assert_matrix(background("WinUIDesktopWin32WindowClass"), [
			true, true, true, false, false, false,
		]);
		assert_matrix(background("HwndWrapper[App;;abc]"), [true, true, false, true, true, true]);
		assert_matrix(background("TkTopLevel.1"), [true, false, false, true, true, true]);
		assert_matrix(background("gdkSurfaceToplevel"), [true, false, false, false, false, false]);
		assert_matrix(background("gdkWindowToplevel"), [true, false, false, false, false, false]);
		assert_matrix(background("SALFRAME"), [false, false, false, true, true, false]);
		assert_matrix(background("Chrome_WidgetWin"), [false; 6]);
		assert_matrix(background("HwndWrapperApp;;abc]"), [false; 6]);
		assert_matrix(background("TkTopLevelish"), [false; 6]);
		assert_matrix(background("XSALFRAME"), [false; 6]);
	}

	#[test]
	fn wpf_accepts_posted_keys_only_while_it_owns_the_foreground() {
		let foreground = TargetTraits { foreground: true, ..background("HwndWrapper[App;;abc]") };
		assert_matrix(foreground, [true, true, false, false, false, true]);
		let native = TargetTraits { foreground: true, ..background("Notepad") };
		assert_matrix(native, [false; 6]);
	}

	#[test]
	fn xaml_hosts_refuse_posted_keyboard_and_uwp_frames_refuse_posted_pointer() {
		let notepad = TargetTraits { xaml_host: true, ..background("Notepad") };
		assert_matrix(notepad, [false, false, false, true, true, true]);
		let uwp = TargetTraits { xaml_host: true, ..background("ApplicationFrameWindow") };
		assert_matrix(uwp, [true, true, false, true, true, true]);
		let foreground_uwp = TargetTraits { foreground: true, ..uwp };
		assert_matrix(foreground_uwp, [true, true, false, true, true, true]);
	}

	#[test]
	fn terminals_accept_posted_text_only_while_foreground() {
		assert_matrix(background("CASCADIA_HOSTING_WINDOW_CLASS"), [
			false, false, false, false, false, true,
		]);
		assert_matrix(background("mintty"), [false, false, false, false, false, true]);
		let foreground = TargetTraits { foreground: true, ..background("ConsoleWindowClass") };
		assert_matrix(foreground, [false; 6]);
	}

	#[test]
	fn only_arm64_console_host_rejects_text_in_every_mode() {
		assert!(text_input_unsupported("ConsoleWindowClass", true).is_some());
		assert!(text_input_unsupported("ConsoleWindowClass", false).is_none());
		assert!(text_input_unsupported("CASCADIA_HOSTING_WINDOW_CLASS", true).is_none());
	}

	#[test]
	fn embedded_chromium_refuses_drags_wheel_and_chords_on_top_of_host_toolkit_drops() {
		let tauri = TargetTraits { chromium_descendant: true, ..background("Tauri Window") };
		assert_matrix(tauri, [false, true, true, false, true, false]);
		let wpf_host =
			TargetTraits { chromium_descendant: true, ..background("HwndWrapper[App;;x]") };
		assert_matrix(wpf_host, [true; 6]);
	}

	#[test]
	fn only_caption_and_sizing_hits_refuse_posted_drags() {
		assert_eq!(non_client_drag_region(2), Some("caption"));
		assert_eq!(non_client_drag_region(4), Some("size box"));
		for border in 10..=17 {
			assert_eq!(non_client_drag_region(border), Some("resize border"));
		}
		// HTERROR, HTNOWHERE, HTCLIENT, HTSYSMENU, HTMINBUTTON, HTBORDER, HTCLOSE
		for hit in [-2, 0, 1, 3, 8, 18, 20] {
			assert_eq!(non_client_drag_region(hit), None, "hit {hit}");
		}
	}

	#[test]
	fn double_click_messages_follow_class_style_and_press_parity() {
		let presses = |wants_double| (0..4).map(move |index| posts_double_click(index, wants_double));
		assert!(presses(true).eq([false, true, false, true]));
		assert!(presses(false).eq([false; 4]));
	}

	#[test]
	fn every_line_break_style_becomes_exactly_one_return() {
		use TextUnit::{Char, Enter};
		let units = |text| text_units(text).collect::<Vec<_>>();
		assert_eq!(units("a\r\nb\nc\rd"), [
			Char('a'),
			Enter,
			Char('b'),
			Enter,
			Char('c'),
			Enter,
			Char('d')
		]);
		assert_eq!(units("\r\r\n\n"), [Enter, Enter, Enter]);
		assert_eq!(units("\n\r"), [Enter, Enter]);
		assert_eq!(units("é\t"), [Char('é'), Char('\t')]);
	}
}
