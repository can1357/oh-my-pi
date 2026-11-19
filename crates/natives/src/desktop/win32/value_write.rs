use super::super::{ax::text_readback, error::CoreResult};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ValueRoute {
	Pattern,
	Combo,
	RefuseCombo,
	Edit,
}

/// Whether `class` is `base` or a `WinForms` subclass of it
/// (`WindowsForms10.<BASE>.app.<suffix>`).
fn is_class(class: &str, base: &str) -> bool {
	const WINFORMS: &str = "WindowsForms10.";
	class.eq_ignore_ascii_case(base)
		|| class.split_once(".app.").is_some_and(|(name, suffix)| {
			name
				.get(..WINFORMS.len())
				.is_some_and(|prefix| prefix.eq_ignore_ascii_case(WINFORMS))
				&& name
					.get(WINFORMS.len()..)
					.is_some_and(|name| name.eq_ignore_ascii_case(base))
				&& !suffix.is_empty()
		})
}

pub(super) fn route(class: &str, parent_class: &str) -> ValueRoute {
	if is_class(class, "ComboBox") {
		ValueRoute::Combo
	} else if class.eq_ignore_ascii_case("ComboBoxEx32") {
		ValueRoute::RefuseCombo
	} else if is_class(class, "Edit") && !parent_class.eq_ignore_ascii_case("SysIPAddress32") {
		ValueRoute::Edit
	} else {
		ValueRoute::Pattern
	}
}

pub(super) fn verdict(
	expected: &str,
	pattern: Option<&str>,
	legacy: Option<&str>,
	password: Option<bool>,
) -> CoreResult<()> {
	let read = pattern.or(legacy);
	if read.is_none() || password == Some(true) {
		// A hidden or unavailable value supplies no evidence that the write
		// failed. Preserve main's success without claiming confirmation.
		return Ok(());
	}
	text_readback(expected, expected, read, password.unwrap_or(true))
}

/// Whether a rich edit that reads `actual` holds `expected`: it reports every
/// line break as one `\r` and adds its final paragraph mark, so a stored `abc`
/// reads back as `abc\r`.
pub(super) fn rich_edit_holds(class: &str, expected: &str, actual: &str) -> bool {
	class
		.as_bytes()
		.windows(8)
		.any(|name| name.eq_ignore_ascii_case(b"richedit"))
		&& actual.strip_suffix('\r').is_some_and(|lines| {
			lines.split('\r').eq(
				expected
					.split('\n')
					.map(|line| line.strip_suffix('\r').unwrap_or(line)),
			)
		})
}

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ComboPlan {
	Refuse,
	NoItem,
	Select(usize),
	Edit,
}

// Win32 SDK combo-box style values, also used by platform-independent tests.
const CBS_OWNERDRAWFIXED: u32 = 0x10;
const CBS_OWNERDRAWVARIABLE: u32 = 0x20;
const CBS_HASSTRINGS: u32 = 0x200;
const CBS_TYPE_MASK: u32 = 3;
const CBS_DROPDOWNLIST: u32 = 3;
#[cfg(test)]
const CBS_DROPDOWN: u32 = 2;

pub(super) const fn plan(enabled: bool, style: u32, candidate_index: Option<usize>) -> ComboPlan {
	if !enabled
		|| (style & (CBS_OWNERDRAWFIXED | CBS_OWNERDRAWVARIABLE) != 0 && style & CBS_HASSTRINGS == 0)
	{
		ComboPlan::Refuse
	} else if let Some(index) = candidate_index {
		ComboPlan::Select(index)
	} else if style & CBS_TYPE_MASK == CBS_DROPDOWNLIST {
		ComboPlan::NoItem
	} else {
		ComboPlan::Edit
	}
}

fn combo_verdict(expected: &str, actual: &str, secure: bool) -> CoreResult<()> {
	text_readback(expected, expected, Some(actual), secure).map_err(|error| {
		super::super::error::DesktopError::ax_failed(format!(
			"the combo box value is unverified and may already have changed; {}",
			error.message
		))
	})
}

#[cfg(target_os = "windows")]
fn combo_failure(writing: bool) -> super::super::error::DesktopError {
	super::super::error::DesktopError::ax_failed(if writing {
		"the combo box may already have changed, but no value or selection was confirmed; select the \
		 item via press/click and inspect the target before writing again"
	} else {
		"the combo box could not be prepared for writing; no value or selection was confirmed; \
		 select the item via press/click instead; nothing was written"
	})
}
#[cfg(target_os = "windows")]
pub(super) fn combo_target(
	hwnd: windows_sys::Win32::Foundation::HWND,
) -> windows_sys::Win32::Foundation::HWND {
	use windows_sys::Win32::UI::{
		Controls::{COMBOBOXINFO, GetComboBoxInfo},
		WindowsAndMessaging::GetParent,
	};
	// ComboBoxEx32 owns an ordinary combo (and edit) internally, but those
	// descendants still need the extended control's unsupported notifications.
	let mut ancestor = hwnd;
	while !ancestor.is_null() {
		if route(&super::window::class_name(ancestor), "") == ValueRoute::RefuseCombo {
			return ancestor;
		}
		// SAFETY: GetParent only queries the native ancestry.
		ancestor = unsafe { GetParent(ancestor) };
	}
	// A raw UIA ref can name the edit child rather than the combo itself.
	// Only normalize the edit handle the native combo API identifies.
	// SAFETY: GetParent only queries the supplied handle.
	let parent = unsafe { GetParent(hwnd) };
	if !parent.is_null() && route(&super::window::class_name(parent), "") == ValueRoute::Combo {
		let mut info =
			COMBOBOXINFO { cbSize: std::mem::size_of::<COMBOBOXINFO>() as u32, ..Default::default() };
		// SAFETY: info is writable with the correct size; parent is queried only.
		if unsafe { GetComboBoxInfo(parent, &mut info) } != 0 && info.hwndItem == hwnd {
			return parent;
		}
	}
	hwnd
}

/// Why a control's message went unanswered.
#[cfg(target_os = "windows")]
pub(super) enum Unanswered {
	/// A pointer-bearing message for another thread of this process, refused
	/// before sending: after a timeout its buffer could outlive the call.
	OtherThread,
	/// Never delivered: the operation had no time left to send it, or Windows
	/// refused the send (UIPI denied it, or the window is gone).
	Undelivered,
	/// Not answered in time, or failed for a reason Windows did not name: the
	/// target may have acted on it.
	NoAnswer,
}

/// Sends `message` and waits up to 3 s for its result.
#[cfg(target_os = "windows")]
fn send_message(
	target: windows_sys::Win32::Foundation::HWND,
	message: u32,
	wparam: usize,
	lparam: isize,
	pointer: bool,
) -> Result<isize, Unanswered> {
	send_message_within(target, message, wparam, lparam, pointer, 3000)
}

/// How long a message of the current operation may wait for its answer: 3 s,
/// or what is left of the operation's deadline if that is sooner.
#[cfg(target_os = "windows")]
pub(super) fn operation_wait_ms() -> u32 {
	super::super::control::time_left().map_or(3000, |left| left.as_millis().min(3000) as u32)
}

/// Sends `message` and waits up to `wait_ms` for its result (Windows ignores
/// the wait for a window of the calling thread, which answers at once).
#[cfg(target_os = "windows")]
pub(super) fn send_message_within(
	target: windows_sys::Win32::Foundation::HWND,
	message: u32,
	wparam: usize,
	lparam: isize,
	pointer: bool,
	wait_ms: u32,
) -> Result<isize, Unanswered> {
	use windows_sys::Win32::{
		Foundation::{ERROR_ACCESS_DENIED, ERROR_INVALID_WINDOW_HANDLE, GetLastError, SetLastError},
		System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
		UI::WindowsAndMessaging::{GetWindowThreadProcessId, SMTO_ABORTIFHUNG, SendMessageTimeoutW},
	};
	if pointer {
		let mut process = 0;
		// SAFETY: these APIs only query window/process/thread identifiers.
		let local_other_thread = unsafe {
			let thread = GetWindowThreadProcessId(target, &mut process);
			process == GetCurrentProcessId() && thread != GetCurrentThreadId()
		};
		if local_other_thread {
			return Err(Unanswered::OtherThread);
		}
	}
	if wait_ms == 0 {
		return Err(Unanswered::Undelivered);
	}
	let mut result = 0;
	// SAFETY: pointer-bearing system messages are marshalled for another
	// process. Same-thread dispatch is synchronous; same-process dispatch
	// to another thread is refused above before a buffer can outlive us.
	// SetLastError clears a stale error: a failed send does not always set one.
	let answered = unsafe {
		SetLastError(0);
		SendMessageTimeoutW(target, message, wparam, lparam, SMTO_ABORTIFHUNG, wait_ms, &mut result)
	};
	if answered != 0 {
		return Ok(result as isize);
	}
	// SAFETY: GetLastError reads this thread's last error.
	match unsafe { GetLastError() } {
		ERROR_ACCESS_DENIED | ERROR_INVALID_WINDOW_HANDLE => Err(Unanswered::Undelivered),
		_ => Err(Unanswered::NoAnswer),
	}
}

#[cfg(target_os = "windows")]
pub(super) fn set_combo(
	hwnd: windows_sys::Win32::Foundation::HWND,
	text: &str,
	enabled: bool,
	secure: bool,
) -> CoreResult<()> {
	use windows_sys::Win32::UI::{
		Controls::{COMBOBOXINFO, GetComboBoxInfo},
		WindowsAndMessaging::{
			CB_FINDSTRINGEXACT, CB_GETCURSEL, CB_SETCURSEL, CBN_EDITCHANGE, CBN_SELCHANGE,
			CBN_SELENDOK, GWL_STYLE, GetDlgCtrlID, GetParent, GetWindowLongW, IsWindow, WM_COMMAND,
			WM_GETTEXT, WM_SETTEXT,
		},
	};

	use super::super::error::DesktopError;
	let writing = std::cell::Cell::new(false);
	let failed = || combo_failure(writing.get());
	let send = |target, message, wparam, lparam| {
		let pointer = matches!(message, CB_FINDSTRINGEXACT | WM_SETTEXT | WM_GETTEXT);
		send_message(target, message, wparam, lparam, pointer).map_err(
			|unanswered| match unanswered {
				Unanswered::OtherThread => DesktopError::ax_failed(if writing.get() {
					"the combo box's value could not be confirmed safely; pointer-bearing messages to \
					 another thread in this process are unsafe after a timeout; the value may already \
					 have changed, so inspect the target before trying again"
				} else {
					"the combo box's value could not be confirmed safely; pointer-bearing messages to \
					 another thread in this process are unsafe after a timeout; nothing was written; \
					 use press/click instead"
				}),
				Unanswered::Undelivered | Unanswered::NoAnswer => failed(),
			},
		)
	};
	if text.contains('\0') {
		return Err(failed());
	}
	// SAFETY: GetWindowLongW queries the native combo handle.
	let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
	if plan(enabled, style, None) == ComboPlan::Refuse {
		return Err(DesktopError::ax_failed(
			"the combo box is disabled or does not expose string items; select the item via \
			 press/click instead; nothing was written",
		));
	}
	let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
	// The native search is case-insensitive. It only supplies a candidate:
	// exact post-write text and index readback decide success. Never query
	// item names through MSAA (unbounded provider calls) or CB_GETLBTEXT
	// (an unbounded caller-buffer copy if the item grows).
	let candidate_index =
		usize::try_from(send(hwnd, CB_FINDSTRINGEXACT, usize::MAX, wide.as_ptr() as isize)?).ok();
	let mut actual = vec![0_u16; wide.len() + 1];
	let length = send(hwnd, WM_GETTEXT, actual.len(), actual.as_mut_ptr() as isize).ok();
	if length.and_then(|length| usize::try_from(length).ok()) == Some(wide.len() - 1)
		&& actual[..wide.len() - 1] == wide[..wide.len() - 1]
		&& send(hwnd, CB_GETCURSEL, 0, 0)
			.is_ok_and(|index| index == candidate_index.map_or(-1, |index| index as isize))
	{
		return Ok(());
	}
	// SAFETY: GetParent accepts the native combo handle.
	let parent = unsafe { GetParent(hwnd) };
	if parent.is_null() {
		return Err(failed());
	}
	// SAFETY: GetDlgCtrlID reads the native control's identifier.
	let id = unsafe { GetDlgCtrlID(hwnd) } as u32 & 0xffff;
	match plan(enabled, style, candidate_index) {
		ComboPlan::Refuse => Err(failed()),
		ComboPlan::NoItem => Err(DesktopError::ax_failed(
			"the combo box has no matching item; select the item via press/click instead; nothing \
			 was written",
		)),
		ComboPlan::Select(index) => {
			writing.set(true);
			if send(hwnd, CB_SETCURSEL, index, 0)? != index as isize {
				return Err(failed());
			}
			// Native combo documentation specifies SELENDOK before SELCHANGE:
			// https://learn.microsoft.com/en-us/windows/win32/controls/about-combo-boxes
			for code in [CBN_SELENDOK, CBN_SELCHANGE] {
				send(parent, WM_COMMAND, (id | (code << 16)) as usize, hwnd as isize)?;
				// A synchronous app handler may destroy the combo. Do not
				// deliver another notification naming its now-stale HWND.
				// SAFETY: IsWindow only checks the supplied native handles.
				if unsafe { IsWindow(hwnd) == 0 || IsWindow(parent) == 0 } {
					return Err(failed());
				}
			}
			if send(hwnd, CB_GETCURSEL, 0, 0).is_ok_and(|actual| actual != index as isize) {
				return Err(failed());
			}
			Ok(())
		},
		ComboPlan::Edit => {
			let mut info = COMBOBOXINFO {
				cbSize: std::mem::size_of::<COMBOBOXINFO>() as u32,
				..Default::default()
			};
			// SAFETY: info is writable and its cbSize matches COMBOBOXINFO.
			if unsafe { GetComboBoxInfo(hwnd, &mut info) } == 0 || info.hwndItem.is_null() {
				return Err(failed());
			}
			// A native message can bypass an edit child's read-only policy.
			// Refuse before clearing the combo's existing selection.
			// SAFETY: IsWindowEnabled only queries the identified edit handle.
			if unsafe {
				windows_sys::Win32::UI::Input::KeyboardAndMouse::IsWindowEnabled(info.hwndItem)
			} == 0
				// SAFETY: GetWindowLongW only queries the identified edit handle.
				|| unsafe { GetWindowLongW(info.hwndItem, GWL_STYLE) }
					& windows_sys::Win32::UI::WindowsAndMessaging::ES_READONLY
					!= 0
			{
				return Err(DesktopError::ax_failed(
					"the combo box edit is disabled or read-only; nothing was written",
				));
			}
			// Typed text that matches no item leaves the combo with no list
			// selection; without this the app reads the previously selected item
			// next to the new text. Clearing the selection also empties the edit,
			// which WM_SETTEXT then fills.
			writing.set(true);
			send(hwnd, CB_SETCURSEL, usize::MAX, 0)?;
			if send(info.hwndItem, WM_SETTEXT, 0, wide.as_ptr() as isize)? == 0 {
				return Err(failed());
			}
			// On native Win32 and WinForms combos, WM_SETTEXT on the edit
			// child does not forward CBN_EDITCHANGE (verified on Windows 11).
			// Send it explicitly so the app sees exactly one text change.
			send(parent, WM_COMMAND, (id | (CBN_EDITCHANGE << 16)) as usize, hwnd as isize)?;
			if send(hwnd, CB_GETCURSEL, 0, 0).is_ok_and(|actual| actual != -1) {
				return Err(failed());
			}
			Ok(())
		},
	}?;
	// WM_GETTEXT takes the buffer capacity, unlike CB_GETLBTEXT. One extra
	// code unit beyond the expected text distinguishes a longer value from
	// an exact match even when the read is truncated.
	let length = send(hwnd, WM_GETTEXT, actual.len(), actual.as_mut_ptr() as isize)
		.ok()
		.and_then(|length| usize::try_from(length).ok())
		.filter(|&length| length < actual.len());
	let expected_index = candidate_index.map_or(-1, |index| index as isize);
	if send(hwnd, CB_GETCURSEL, 0, 0).is_ok_and(|actual| actual != expected_index) {
		return Err(failed());
	}
	// A successful write and notification are not disproved by a read timeout.
	let Some(length) = length else { return Ok(()) };
	if actual[..length] == wide[..wide.len() - 1] {
		return Ok(());
	}
	let error = combo_verdict(text, &String::from_utf16_lossy(&actual[..length]), secure);
	if length + 1 == actual.len() && !secure {
		return error.map_err(|error| {
			DesktopError::ax_failed(format!("{} (bounded readback prefix)", error.message))
		});
	}
	error
}

/// Writes a Win32 or `WinForms` edit control's whole value with `WM_SETTEXT`,
/// one call that returns whether the edit took the value. A single-line edit
/// tells its app with `EN_CHANGE`; a multi-line one does not, so it is marked
/// modified (`EM_SETMODIFY`) before notifying its unchanged parent and ID
/// (Notepad marks its document changed).
/// The system's UI Automation proxy for these classes activates the control's
/// window to set a value, taking the foreground and the user's next keys;
/// these messages need neither focus nor activation. `password` is UI
/// Automation's verdict: a protected or unknown field's text is never quoted.
#[cfg(target_os = "windows")]
pub(super) fn set_edit(
	hwnd: windows_sys::Win32::Foundation::HWND,
	text: &str,
	enabled: bool,
	password: Option<bool>,
) -> CoreResult<()> {
	use windows_sys::Win32::UI::{
		Controls::{EM_GETLIMITTEXT, EM_SETMODIFY},
		Input::KeyboardAndMouse::IsWindowEnabled,
		WindowsAndMessaging::{
			EN_CHANGE, ES_MULTILINE, ES_NUMBER, ES_PASSWORD, ES_READONLY, GA_PARENT, GWL_STYLE,
			GetAncestor, GetDlgCtrlID, GetWindowLongW, IsWindow, WM_COMMAND, WM_GETTEXT, WM_SETTEXT,
			WS_CHILD,
		},
	};

	use super::super::{ax::truncate_chars, control, error::DesktopError};
	let unsent = |reason: &str| DesktopError::ax_failed(format!("{reason}; nothing was written"));
	if let Some(reason) = super::window::uipi_block(hwnd) {
		return Err(DesktopError::permission_denied(format!(
			"cannot write the text field: {reason}"
		)));
	}
	let writing = std::cell::Cell::new(false);
	let send = |target, message, wparam, lparam, pointer| {
		send_message_within(target, message, wparam, lparam, pointer, operation_wait_ms()).map_err(
			|unanswered| match unanswered {
				// A message never delivered changed nothing.
				Unanswered::Undelivered | Unanswered::OtherThread if !writing.get() => {
					unsent("the text field could not be sent the value")
				},
				_ if writing.get() || message == WM_SETTEXT => DesktopError::ax_failed(
					"the text field may already have changed, but its value was not confirmed; inspect \
					 the target before writing again",
				),
				_ => unsent("the text field did not answer"),
			},
		)
	};
	if text.contains('\0') {
		return Err(unsent("the text contains a NUL character"));
	}
	// SAFETY: GetWindowLongW and IsWindowEnabled only query the edit handle.
	let (style, window_enabled) =
		unsafe { (GetWindowLongW(hwnd, GWL_STYLE) as u32, IsWindowEnabled(hwnd) != 0) };
	// These messages bypass the checks the control applies to typing.
	if !enabled || !window_enabled || style & ES_READONLY as u32 != 0 {
		return Err(unsent("the text field is disabled or read-only"));
	}
	// Match WindowsEditBox.IValueProvider.SetValue: ES_NUMBER rejects only
	// char.IsLetter, not signs or punctuation. .NET tests UTF-16 code units.
	// https://github.com/dotnet/wpf/blob/main/src/Microsoft.DotNet.Wpf/src/UIAutomation/UIAutomationClientSideProviders/MS/Internal/AutomationProxies/WindowsEditBox.cs
	if style & ES_NUMBER as u32 != 0 {
		static LETTER: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
			regex::Regex::new(r"[\p{L}&&[\u0000-\uFFFF]]").expect("valid letter category")
		});
		if LETTER.is_match(text) {
			return Err(unsent("the numeric text field does not accept letters"));
		}
	}
	let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
	let limit = send(hwnd, EM_GETLIMITTEXT, 0, 0, false)?;
	if usize::try_from(limit).is_ok_and(|limit| wide.len() - 1 > limit) {
		return Err(unsent(&format!("the text field holds at most {limit} characters")));
	}
	let multiline = style & ES_MULTILINE as u32 != 0;
	// Only a true child parent receives WM_COMMAND; GetParent can return a
	// popup owner instead. Preserve the recipient across synchronous handlers.
	// SAFETY: these calls only query the edit's native relationship.
	let (parent, id) = unsafe { (GetAncestor(hwnd, GA_PARENT), GetDlgCtrlID(hwnd)) };
	if multiline && (style & WS_CHILD == 0 || parent.is_null()) {
		return Err(unsent("the multi-line text field has no control parent to notify"));
	}
	control::check()?;
	if send(hwnd, WM_SETTEXT, 0, wide.as_ptr() as isize, true)? == 0 {
		return Err(DesktopError::ax_failed(
			"the text field refused the value; inspect the target before writing again",
		));
	}
	writing.set(true);
	if multiline {
		send(hwnd, EM_SETMODIFY, 1, 0, false)?;
		// SAFETY: these calls only revalidate the original child and recipient.
		let unchanged = unsafe {
			IsWindow(hwnd) != 0
				&& GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_CHILD != 0
				&& GetAncestor(hwnd, GA_PARENT) == parent
				&& GetDlgCtrlID(hwnd) == id
		};
		if !unchanged {
			return Err(DesktopError::ax_failed(
				"the text field may already have changed, but its parent or control ID changed; \
				 EN_CHANGE was not sent; inspect the target before writing again",
			));
		}
		let notification = ((EN_CHANGE as usize) << 16) | (id as u16 as usize);
		send(parent, WM_COMMAND, notification, hwnd as isize, false)?;
	}
	// Another process cannot read a password edit's text, and a field UI
	// Automation calls protected gives no evidence either way; `WM_SETTEXT`
	// already reported the write.
	if style & ES_PASSWORD as u32 != 0 || password == Some(true) {
		return Ok(());
	}
	// One code unit beyond the expected text tells a longer value from an
	// exact match even when the read is truncated.
	let mut actual = vec![0_u16; wide.len() + 1];
	let length = send(hwnd, WM_GETTEXT, actual.len(), actual.as_mut_ptr() as isize, true)
		.ok()
		.and_then(|length| usize::try_from(length).ok())
		.filter(|&length| length < actual.len());
	// A read timeout does not disprove the write `WM_SETTEXT` reported.
	let Some(length) = length else { return Ok(()) };
	if actual[..length] == wide[..wide.len() - 1] {
		return Ok(());
	}
	let actual = String::from_utf16_lossy(&actual[..length]);
	if password == Some(false) {
		// A known plain edit reads back exactly what it holds.
		return Err(DesktopError::ax_failed(format!(
			"the text field took the value but now reads {:?}; the app may have changed it",
			truncate_chars(actual, 200)
		)));
	}
	text_readback(text, text, Some(&actual), true).map_err(|error| {
		DesktopError::ax_failed(format!(
			"the text field's value is unverified and may already have changed; {}",
			error.message
		))
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn native_combo_and_edit_classes_use_native_messages() {
		assert_eq!(route("combobox", ""), ValueRoute::Combo);
		assert_eq!(route("WindowsForms10.COMBOBOX.app.0.141b42a_r8_ad1", ""), ValueRoute::Combo);
		assert_eq!(route("ComboBoxEx32", ""), ValueRoute::RefuseCombo);
		assert_eq!(route("Edit", ""), ValueRoute::Edit);
		assert_eq!(route("Edit", "SysIPAddress32"), ValueRoute::Pattern);
		assert_eq!(route("WindowsForms10.EDIT.app.0.34f5582_r6_ad1", ""), ValueRoute::Edit);
		assert_eq!(route("WindowsForms10.RichEdit20W.app.0.141b42a_r8_ad1", ""), ValueRoute::Pattern);
		assert_eq!(route("", ""), ValueRoute::Pattern);
		assert_eq!(route("Chrome_RenderWidgetHostHWND", ""), ValueRoute::Pattern);
	}

	#[test]
	fn readback_prefers_empty_pattern_value_and_falls_back_only_when_unavailable() {
		assert!(verdict("", Some(""), Some("stale"), Some(false)).is_ok());
		assert!(verdict("abc", None, Some("abc"), Some(false)).is_ok());
		assert!(verdict("abc", Some("ABC"), Some("abc"), Some(false)).is_err());
		assert!(verdict("abc", None, None, Some(false)).is_ok());
		assert!(verdict("secret", None, None, Some(true)).is_ok());
		let secure = verdict("secret", Some("different"), None, None).unwrap_err();
		assert!(!secure.message.contains("secret"));
		assert!(!secure.message.contains("different"));
	}

	#[test]
	fn a_password_readback_never_disproves_a_write() {
		for read in [Some(""), Some("protected")] {
			assert!(verdict("secret", read, None, Some(true)).is_ok());
		}
	}

	#[test]
	fn readable_empty_values_still_disprove_a_nonempty_write() {
		assert!(verdict("ordinary", Some(""), None, Some(false)).is_err());
		assert!(verdict("ordinary", None, Some(""), Some(false)).is_err());
	}

	#[test]
	fn rich_edit_paragraph_marks_confirm_a_write() {
		let rich = "WindowsForms10.RichEdit20W.app.0.141b42a_r8_ad1";
		assert!(rich_edit_holds(rich, "abc", "abc\r"));
		assert!(rich_edit_holds("RICHEDIT50W", "a\r\nb\n", "a\rb\r\r"));
		assert!(!rich_edit_holds("RICHEDIT50W", "abc", "ABC\r"));
		assert!(!rich_edit_holds("RICHEDIT50W", "abc", "abc\rd\r"));
		assert!(!rich_edit_holds("Edit", "abc", "abc\r"));
	}

	#[test]
	fn combo_plan_refuses_unsafe_targets_and_distinguishes_selection_from_editing() {
		assert_eq!(plan(false, CBS_DROPDOWN, Some(2)), ComboPlan::Refuse);
		for owner_draw in [CBS_OWNERDRAWFIXED, CBS_OWNERDRAWVARIABLE] {
			assert_eq!(plan(true, owner_draw, Some(2)), ComboPlan::Refuse);
			assert_eq!(plan(true, owner_draw | CBS_HASSTRINGS, Some(2)), ComboPlan::Select(2));
		}
		assert_eq!(plan(true, CBS_DROPDOWNLIST, None), ComboPlan::NoItem);
		assert_eq!(plan(true, CBS_DROPDOWN, None), ComboPlan::Edit);
		assert_eq!(plan(true, CBS_DROPDOWNLIST, Some(2)), ComboPlan::Select(2));
	}

	#[cfg(target_os = "windows")]
	#[test]
	fn combo_preparation_errors_confirm_nothing_was_written() {
		for text in ["contains\0nul", "invalid handle"] {
			let error = set_combo(std::ptr::null_mut(), text, true, false)
				.unwrap_err()
				.to_string();
			assert!(error.contains("nothing was written"), "{error}");
			assert!(!error.contains("may already have changed"), "{error}");
		}
	}

	#[test]
	fn combo_readback_requires_exact_case_and_reports_possible_mutation() {
		assert!(combo_verdict("abc", "abc", false).is_ok());
		let error = combo_verdict("abc", "ABC", false).unwrap_err().to_string();
		assert!(error.contains("unverified"));
		assert!(error.contains("may already have changed"));
		assert!(error.contains("\"ABC\""));
		assert!(
			!combo_verdict("secret", "different", true)
				.unwrap_err()
				.message
				.contains("different")
		);
	}

	#[cfg(target_os = "windows")]
	std::thread_local! {
		static ORIGINAL_COMBO_PROC: std::cell::Cell<windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC>
			= const { std::cell::Cell::new(None) };
		static ITEM_NAME_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
		static POINTER_CALLS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
		static ORIGINAL_PARENT_PROC: std::cell::Cell<windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC>
			= const { std::cell::Cell::new(None) };
		static DESTROY_ON_NOTIFICATION: std::cell::Cell<u32> = const { std::cell::Cell::new(u32::MAX) };
		static NOTIFICATIONS: std::cell::RefCell<Vec<u32>> = const { std::cell::RefCell::new(Vec::new()) };
		static ORIGINAL_EDIT_PROC: std::cell::Cell<windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC>
			= const { std::cell::Cell::new(None) };
		static IGNORED_SETTEXT_RESULT: std::cell::Cell<isize> = const { std::cell::Cell::new(0) };
		static CHANGE_TARGETS: std::cell::RefCell<Vec<(isize, u16)>> = const { std::cell::RefCell::new(Vec::new()) };
		static CLEAR_MODIFIED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
	}

	#[cfg(target_os = "windows")]
	unsafe extern "system" fn notification_parent(
		hwnd: windows_sys::Win32::Foundation::HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::WindowsAndMessaging::{
			CallWindowProcW, DestroyWindow, WM_COMMAND,
		};
		if message == WM_COMMAND {
			let code = ((wparam >> 16) & 0xffff) as u32;
			NOTIFICATIONS.with(|notifications| notifications.borrow_mut().push(code));
			if code == windows_sys::Win32::UI::WindowsAndMessaging::EN_CHANGE {
				CHANGE_TARGETS
					.with(|targets| targets.borrow_mut().push((hwnd as isize, wparam as u16)));
				if CLEAR_MODIFIED.with(std::cell::Cell::get) {
					// SAFETY: lparam names the edit that sent this notification.
					unsafe {
						windows_sys::Win32::UI::WindowsAndMessaging::SendMessageW(
							lparam as _,
							windows_sys::Win32::UI::Controls::EM_SETMODIFY,
							0,
							0,
						)
					};
				}
			}
			if code == DESTROY_ON_NOTIFICATION.with(|destroy| destroy.get()) {
				// SAFETY: lparam is the combo this test created and owns.
				unsafe { DestroyWindow(lparam as _) };
			}
		}
		let original = ORIGINAL_PARENT_PROC.with(|proc| proc.get());
		// SAFETY: the test saved this native parent's original procedure.
		unsafe { CallWindowProcW(original, hwnd, message, wparam, lparam) }
	}

	/// An edit whose app ignores `WM_SETTEXT`, answering it with
	/// `IGNORED_SETTEXT_RESULT`: 0 refuses, 1 claims a write that never
	/// happened.
	#[cfg(target_os = "windows")]
	unsafe extern "system" fn ignoring_edit(
		hwnd: windows_sys::Win32::Foundation::HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::WindowsAndMessaging::{CallWindowProcW, WM_SETTEXT};
		if message == WM_SETTEXT {
			return IGNORED_SETTEXT_RESULT.with(std::cell::Cell::get);
		}
		let original = ORIGINAL_EDIT_PROC.with(|proc| proc.get());
		// SAFETY: the test saved this edit's original procedure.
		unsafe { CallWindowProcW(original, hwnd, message, wparam, lparam) }
	}

	#[cfg(target_os = "windows")]
	unsafe extern "system" fn renumbering_edit(
		hwnd: windows_sys::Win32::Foundation::HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::WindowsAndMessaging::{
			CallWindowProcW, GWLP_ID, GWLP_USERDATA, GetWindowLongPtrW, SetParent, SetWindowLongPtrW,
			WM_SETTEXT,
		};
		if message == WM_SETTEXT {
			// SAFETY: this test owns the edit and its new parent.
			unsafe {
				SetParent(hwnd, GetWindowLongPtrW(hwnd, GWLP_USERDATA) as _);
				SetWindowLongPtrW(hwnd, GWLP_ID, 42);
			}
		}
		let original = ORIGINAL_EDIT_PROC.with(|proc| proc.get());
		// SAFETY: the test saved this edit's original procedure.
		unsafe { CallWindowProcW(original, hwnd, message, wparam, lparam) }
	}

	#[cfg(target_os = "windows")]
	#[test]
	fn native_combo_notifications_stop_after_the_target_is_destroyed() {
		use windows_sys::Win32::UI::WindowsAndMessaging::{
			CB_ADDSTRING, CBN_SELCHANGE, CBN_SELENDOK, CreateWindowExW, DestroyWindow, GWLP_WNDPROC,
			IsWindow, SendMessageW, SetWindowLongPtrW, WNDPROC, WS_CHILD, WS_OVERLAPPED,
		};
		let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
		// SAFETY: this thread owns the windows and subclasses only its parent;
		// the strings outlive their synchronous native calls.
		unsafe {
			let parent = CreateWindowExW(
				0,
				wide("STATIC").as_ptr(),
				wide("").as_ptr(),
				WS_OVERLAPPED,
				0,
				0,
				100,
				100,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null(),
			);
			assert!(!parent.is_null());
			let original =
				SetWindowLongPtrW(parent, GWLP_WNDPROC, notification_parent as *const () as isize);
			ORIGINAL_PARENT_PROC
				.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
			for destroy_on in [u32::MAX, CBN_SELENDOK, CBN_SELCHANGE] {
				let combo = CreateWindowExW(
					0,
					wide("COMBOBOX").as_ptr(),
					wide("").as_ptr(),
					WS_CHILD | CBS_DROPDOWN | CBS_HASSTRINGS,
					0,
					0,
					100,
					100,
					parent,
					1 as _,
					std::ptr::null_mut(),
					std::ptr::null(),
				);
				assert!(!combo.is_null());
				SendMessageW(combo, CB_ADDSTRING, 0, wide("green").as_ptr() as isize);
				DESTROY_ON_NOTIFICATION.with(|destroy| destroy.set(destroy_on));
				NOTIFICATIONS.with(|notifications| notifications.borrow_mut().clear());
				let result = set_combo(combo, "green", true, false);
				if destroy_on == u32::MAX {
					result.unwrap();
				} else {
					let error = result.unwrap_err().to_string();
					assert!(error.contains("may already have changed"), "{error}");
					assert!(!error.contains("nothing was written"), "{error}");
				}
				let expected: &[u32] = if destroy_on == CBN_SELENDOK {
					&[CBN_SELENDOK]
				} else {
					&[CBN_SELENDOK, CBN_SELCHANGE]
				};
				NOTIFICATIONS
					.with(|notifications| assert_eq!(notifications.borrow().as_slice(), expected));
				if destroy_on == u32::MAX {
					NOTIFICATIONS.with(|notifications| notifications.borrow_mut().clear());
					set_combo(combo, "green", true, false).unwrap();
					NOTIFICATIONS.with(|notifications| assert!(notifications.borrow().is_empty()));
				}
				if IsWindow(combo) != 0 {
					DestroyWindow(combo);
				}
			}
			DestroyWindow(parent);
		}
	}

	#[cfg(target_os = "windows")]
	#[test]
	fn edit_values_are_written_without_focus_and_refused_when_read_only() {
		use windows_sys::Win32::UI::{
			Controls::{EM_GETMODIFY, EM_SETREADONLY},
			Input::KeyboardAndMouse::GetFocus,
			WindowsAndMessaging::{
				CreateWindowExW, DestroyWindow, EN_CHANGE, ES_AUTOHSCROLL, ES_MULTILINE, ES_NUMBER,
				ES_UPPERCASE, GWLP_USERDATA, GWLP_WNDPROC, GetWindowTextW, SendMessageW,
				SetWindowLongPtrW, WM_SETTEXT, WNDPROC, WS_CHILD, WS_OVERLAPPED,
			},
		};

		let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
		// SAFETY: this thread owns the windows and subclasses only its parent;
		// the strings and buffer outlive their synchronous native calls.
		unsafe {
			let parent = CreateWindowExW(
				0,
				wide("STATIC").as_ptr(),
				wide("").as_ptr(),
				WS_OVERLAPPED,
				0,
				0,
				100,
				100,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null(),
			);
			assert!(!parent.is_null());
			let original =
				SetWindowLongPtrW(parent, GWLP_WNDPROC, notification_parent as *const () as isize);
			ORIGINAL_PARENT_PROC
				.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
			let child = |style: i32| {
				CreateWindowExW(
					0,
					wide("EDIT").as_ptr(),
					wide("old").as_ptr(),
					WS_CHILD | style as u32,
					0,
					0,
					100,
					20,
					parent,
					1 as _,
					std::ptr::null_mut(),
					std::ptr::null(),
				)
			};
			let read = |edit| {
				let mut buffer = [0_u16; 64];
				let length = GetWindowTextW(edit, buffer.as_mut_ptr(), buffer.len() as i32);
				String::from_utf16_lossy(&buffer[..length as usize])
			};
			let changes = || {
				NOTIFICATIONS.with(|notifications| {
					notifications
						.borrow_mut()
						.drain(..)
						.filter(|&code| code == EN_CHANGE)
						.count()
				})
			};
			// Single- and multi-line edits each tell the app once that their
			// text changed; the multi-line one is marked modified, as after a
			// paste.
			for style in [ES_AUTOHSCROLL, ES_MULTILINE] {
				let edit = child(style);
				assert!(!edit.is_null());
				changes();
				CLEAR_MODIFIED.with(|clear| clear.set(style == ES_AUTOHSCROLL));
				set_edit(edit, "new value", true, Some(false)).unwrap();
				assert_eq!(read(edit), "new value");
				assert_eq!(changes(), 1, "style {style:#x}");
				assert_eq!(
					SendMessageW(edit, EM_GETMODIFY, 0, 0),
					isize::from(style == ES_MULTILINE),
					"style {style:#x}"
				);
			}
			CLEAR_MODIFIED.with(|clear| clear.set(false));
			// Reparenting or detaching during the write is partial delivery,
			// never a notification to either the old or a new recipient.
			let new_parent = CreateWindowExW(
				0,
				wide("STATIC").as_ptr(),
				wide("").as_ptr(),
				WS_CHILD,
				0,
				0,
				100,
				100,
				parent,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null(),
			);
			assert!(!new_parent.is_null());
			SetWindowLongPtrW(new_parent, GWLP_WNDPROC, notification_parent as *const () as isize);
			for target in [new_parent, std::ptr::null_mut()] {
				let renumbered = child(ES_MULTILINE);
				SetWindowLongPtrW(renumbered, GWLP_USERDATA, target as isize);
				let original =
					SetWindowLongPtrW(renumbered, GWLP_WNDPROC, renumbering_edit as *const () as isize);
				ORIGINAL_EDIT_PROC
					.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
				CHANGE_TARGETS.with(|targets| targets.borrow_mut().clear());
				let error = set_edit(renumbered, "renumbered", true, Some(false)).unwrap_err();
				assert_eq!(read(renumbered), "renumbered");
				assert!(error.message.contains("may already have changed"), "{error:?}");
				assert!(error.message.contains("EN_CHANGE was not sent"), "{error:?}");
				CHANGE_TARGETS.with(|targets| assert!(targets.borrow().is_empty()));
				DestroyWindow(renumbered);
			}
			let numeric = child(ES_NUMBER);
			set_edit(numeric, "-12.5", true, Some(false)).unwrap();
			assert_eq!(read(numeric), "-12.5");
			assert!(set_edit(numeric, "12a", true, Some(false)).is_err());
			assert_eq!(read(numeric), "-12.5");
			assert!(GetFocus().is_null());
			let edit = child(ES_AUTOHSCROLL);
			set_edit(edit, "new value", true, Some(false)).unwrap();
			SendMessageW(edit, EM_SETREADONLY, 1, 0);
			let error = set_edit(edit, "other", true, Some(false))
				.unwrap_err()
				.to_string();
			assert!(error.contains("nothing was written"), "{error}");
			assert_eq!(read(edit), "new value");
			// The control changes what it stores; when UI Automation cannot say
			// the field is unprotected, the mismatch is reported without its text.
			let upper = child(ES_UPPERCASE);
			let error = set_edit(upper, "secret", true, None)
				.unwrap_err()
				.to_string();
			assert!(error.contains("may already have changed"), "{error}");
			assert!(!error.contains("SECRET"), "{error}");
			// An app that ignores the write: a refusal is reported, and a claimed
			// write is caught by the read-back, exactly on a known plain field
			// even when what it holds looks like a mask.
			let ignoring = |style: i32, holds: &str| {
				let edit = child(style);
				SendMessageW(edit, WM_SETTEXT, 0, wide(holds).as_ptr() as isize);
				let original =
					SetWindowLongPtrW(edit, GWLP_WNDPROC, ignoring_edit as *const () as isize);
				ORIGINAL_EDIT_PROC
					.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
				edit
			};
			for style in [ES_AUTOHSCROLL, ES_MULTILINE] {
				IGNORED_SETTEXT_RESULT.with(|result| result.set(0));
				let refusing = ignoring(style, "old");
				let error = set_edit(refusing, "value", true, Some(false)).unwrap_err();
				assert!(error.message.contains("refused the value"), "{error:?}");
				assert_eq!(read(refusing), "old");
				IGNORED_SETTEXT_RESULT.with(|result| result.set(1));
				let claiming = ignoring(style, "*****");
				let error = set_edit(claiming, "value", true, Some(false)).unwrap_err();
				assert!(error.message.contains("now reads \"*****\""), "{error:?}");
			}
			DestroyWindow(parent);
		}
	}

	#[cfg(target_os = "windows")]
	unsafe extern "system" fn rejecting_item_names(
		hwnd: windows_sys::Win32::Foundation::HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::WindowsAndMessaging::{
			CB_GETLBTEXT, CB_GETLBTEXTLEN, CallWindowProcW, WM_GETOBJECT,
		};
		if matches!(message, CB_GETLBTEXT | CB_GETLBTEXTLEN | WM_GETOBJECT) {
			ITEM_NAME_READS.with(|count| count.set(count.get() + 1));
			return if message == WM_GETOBJECT { 0 } else { -1 };
		}
		let original = ORIGINAL_COMBO_PROC.with(|proc| proc.get());
		// SAFETY: this test saved the original native window procedure.
		unsafe { CallWindowProcW(original, hwnd, message, wparam, lparam) }
	}

	#[cfg(target_os = "windows")]
	unsafe extern "system" fn recording_combo(
		hwnd: windows_sys::Win32::Foundation::HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::WindowsAndMessaging::{CB_FINDSTRINGEXACT, CallWindowProcW};
		if message == CB_FINDSTRINGEXACT {
			POINTER_CALLS.with(|calls| calls.set(calls.get() + 1));
			// Count forbidden dispatch without dereferencing its text pointer.
			return -1;
		}
		let original = ORIGINAL_COMBO_PROC.with(|proc| proc.get());
		// SAFETY: this test saved the original native window procedure.
		unsafe { CallWindowProcW(original, hwnd, message, wparam, lparam) }
	}

	#[cfg(target_os = "windows")]
	#[test]
	fn same_process_cross_thread_messages_are_unconfirmed() {
		use std::sync::mpsc;

		use windows_sys::Win32::UI::WindowsAndMessaging::{
			CreateWindowExW, DestroyWindow, DispatchMessageW, GWLP_WNDPROC, GetMessageW, MSG,
			PostThreadMessageW, SetWindowLongPtrW, WM_QUIT, WNDPROC, WS_CHILD, WS_OVERLAPPED,
		};
		// Keep the target and sender in one isolated child process, while
		// their window procedures run on different threads.
		const CHILD: &str = "PI_NATIVE_COMBO_TIMEOUT_CHILD";
		if std::env::var_os(CHILD).is_none() {
			let output = std::process::Command::new(std::env::current_exe().unwrap())
				.args(["--exact", "desktop::win32::value_write::tests::same_process_cross_thread_messages_are_unconfirmed", "--nocapture"])
				.env(CHILD, "1")
				.output()
				.unwrap();
			assert!(
				output.status.success(),
				"{}{}",
				String::from_utf8_lossy(&output.stdout),
				String::from_utf8_lossy(&output.stderr)
			);
			print!("{}", String::from_utf8_lossy(&output.stdout));
			return;
		}
		let (ready, handle) = mpsc::channel();
		let owner = std::thread::spawn(move || {
			let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
			// SAFETY: this thread owns both native windows and pumps their
			// messages until the test requests cleanup.
			unsafe {
				let parent = CreateWindowExW(
					0,
					wide("STATIC").as_ptr(),
					wide("").as_ptr(),
					WS_OVERLAPPED,
					0,
					0,
					100,
					100,
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null(),
				);
				let combo = CreateWindowExW(
					0,
					wide("COMBOBOX").as_ptr(),
					wide("").as_ptr(),
					WS_CHILD | CBS_DROPDOWN,
					0,
					0,
					100,
					100,
					parent,
					1 as _,
					std::ptr::null_mut(),
					std::ptr::null(),
				);
				let edit = CreateWindowExW(
					0,
					wide("EDIT").as_ptr(),
					wide("old").as_ptr(),
					WS_CHILD,
					0,
					0,
					100,
					20,
					parent,
					2 as _,
					std::ptr::null_mut(),
					std::ptr::null(),
				);
				assert!(!edit.is_null());
				assert!(!parent.is_null() && !combo.is_null());
				let original =
					SetWindowLongPtrW(combo, GWLP_WNDPROC, recording_combo as *const () as isize);
				ORIGINAL_COMBO_PROC
					.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
				ready
					.send((
						combo as usize,
						edit as usize,
						windows_sys::Win32::System::Threading::GetCurrentThreadId(),
					))
					.unwrap();
				let mut message = MSG::default();
				while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
					DispatchMessageW(&message);
				}
				let mut text = [0_u16; 16];
				let length = windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW(
					edit,
					text.as_mut_ptr(),
					text.len() as i32,
				);
				assert_eq!(String::from_utf16_lossy(&text[..length as usize]), "old");
				DestroyWindow(parent);
				assert_eq!(
					POINTER_CALLS.with(|calls| calls.get()),
					0,
					"pointer-bearing message must not reach the other thread"
				);
			}
		});
		let (hwnd, edit, thread) = handle.recv().unwrap();
		let result = set_combo(hwnd as _, "green", true, false);
		let edit_error = set_edit(edit as _, "new", true, Some(false)).unwrap_err();
		assert!(edit_error.message.contains("nothing was written"), "{edit_error:?}");
		// SAFETY: this test created the owner thread and its message queue;
		// WM_QUIT carries no pointers and wakes GetMessageW for cleanup.
		assert_ne!(unsafe { PostThreadMessageW(thread, WM_QUIT, 0, 0) }, 0);
		owner.join().unwrap();
		let error = result.unwrap_err().to_string();
		assert!(error.contains("value could not be confirmed safely"), "{error}");
		assert!(error.contains("another thread in this process"), "{error}");
		assert!(error.contains("nothing was written"), "{error}");
		println!("same-process cross-thread target: refused before dispatch: {error}");
	}

	#[cfg(target_os = "windows")]
	unsafe extern "system" fn growing_combo(
		hwnd: windows_sys::Win32::Foundation::HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::WindowsAndMessaging::{
			CB_DELETESTRING, CB_FINDSTRINGEXACT, CB_INSERTSTRING, CallWindowProcW, SendMessageW,
		};
		let original = ORIGINAL_COMBO_PROC.with(|proc| proc.get());
		// SAFETY: original is the native procedure saved when installing this
		// test subclass, and this callback preserves the message arguments.
		let result = unsafe { CallWindowProcW(original, hwnd, message, wparam, lparam) };
		if message == CB_FINDSTRINGEXACT && result == 2 {
			// Replace the matched item before the caller reads its name.
			// This seam uses the documented native search result, independent
			// of how any accessibility provider retrieves that item's text.
			let larger: Vec<u16> = "a much longer dynamically replaced candidate"
				.encode_utf16()
				.chain(Some(0))
				.collect();
			// SAFETY: this thread owns the combo; the string outlives both
			// synchronous messages. Simulate growth after finding a candidate.
			unsafe {
				SendMessageW(hwnd, CB_DELETESTRING, result as usize, 0);
				SendMessageW(hwnd, CB_INSERTSTRING, result as usize, larger.as_ptr() as isize);
			}
		}
		result
	}

	#[cfg(target_os = "windows")]
	#[test]
	fn editing_an_unlisted_value_clears_the_previous_selection() {
		use windows_sys::Win32::UI::{
			Controls::{
				CBEM_GETCOMBOCONTROL, CBEM_GETEDITCONTROL, COMBOBOXINFO, GetComboBoxInfo,
				ICC_USEREX_CLASSES, INITCOMMONCONTROLSEX, InitCommonControlsEx,
			},
			WindowsAndMessaging::{
				CB_ADDSTRING, CB_GETCURSEL, CB_SETCURSEL, CBS_DROPDOWN, CBS_HASSTRINGS,
				CreateWindowExW, DestroyWindow, GWLP_WNDPROC, GetWindowTextW, SendMessageW,
				SetWindowLongPtrW, WNDPROC, WS_CHILD, WS_OVERLAPPED,
			},
		};
		let wide = |text: &str| text.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
		let (frame, combo, empty) = (wide("STATIC"), wide("COMBOBOX"), wide(""));
		// SAFETY: the class and title strings are NUL-terminated and outlive the
		// calls; both are system classes, and messages to a window this thread
		// created run synchronously.
		unsafe {
			let parent = CreateWindowExW(
				0,
				frame.as_ptr(),
				empty.as_ptr(),
				WS_OVERLAPPED,
				0,
				0,
				200,
				200,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null(),
			);
			let hwnd = CreateWindowExW(
				0,
				combo.as_ptr(),
				empty.as_ptr(),
				WS_CHILD | (CBS_DROPDOWN | CBS_HASSTRINGS) as u32,
				0,
				0,
				100,
				200,
				parent,
				7 as _,
				std::ptr::null_mut(),
				std::ptr::null(),
			);
			assert!(!parent.is_null() && !hwnd.is_null());
			for item in ["red", "green"] {
				SendMessageW(hwnd, CB_ADDSTRING, 0, wide(item).as_ptr() as isize);
			}
			SendMessageW(hwnd, CB_SETCURSEL, 1, 0);
			let mut info = COMBOBOXINFO {
				cbSize: std::mem::size_of::<COMBOBOXINFO>() as u32,
				..Default::default()
			};
			assert_ne!(GetComboBoxInfo(hwnd, &mut info), 0);
			assert_eq!(combo_target(info.hwndItem), hwnd);
			assert_eq!(combo_target(hwnd), hwnd);
			let original =
				SetWindowLongPtrW(hwnd, GWLP_WNDPROC, rejecting_item_names as *const () as isize);
			ORIGINAL_COMBO_PROC.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
			ITEM_NAME_READS.with(|count| count.set(0));
			let selected = set_combo(hwnd, "green", true, false);
			let inexact = set_combo(hwnd, "GREEN", true, false);
			SetWindowLongPtrW(hwnd, GWLP_WNDPROC, original);
			selected.unwrap();
			let error = inexact.unwrap_err().to_string();
			assert!(error.contains("unverified"));
			assert!(error.contains("may already have changed"));
			assert!(error.contains("\"green\""), "{error}");
			assert_eq!(ITEM_NAME_READS.with(|count| count.get()), 0);
			assert_eq!(SendMessageW(hwnd, CB_GETCURSEL, 0, 0), 1);
			SendMessageW(info.hwndItem, windows_sys::Win32::UI::Controls::EM_SETREADONLY, 1, 0);
			let error = set_combo(combo_target(info.hwndItem), "purple", true, false).unwrap_err();
			assert!(error.to_string().contains("read-only"));
			assert_eq!(SendMessageW(hwnd, CB_GETCURSEL, 0, 0), 1);
			let mut unchanged = [0_u16; 32];
			let length = GetWindowTextW(hwnd, unchanged.as_mut_ptr(), unchanged.len() as i32);
			assert_eq!(String::from_utf16_lossy(&unchanged[..length as usize]), "green");
			SendMessageW(info.hwndItem, windows_sys::Win32::UI::Controls::EM_SETREADONLY, 0, 0);
			windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(info.hwndItem, 0);
			let error = set_combo(combo_target(info.hwndItem), "purple", true, false).unwrap_err();
			assert!(error.to_string().contains("disabled"));
			assert_eq!(SendMessageW(hwnd, CB_GETCURSEL, 0, 0), 1);
			windows_sys::Win32::UI::Input::KeyboardAndMouse::EnableWindow(info.hwndItem, 1);

			set_combo(combo_target(info.hwndItem), "purple", true, false).unwrap();

			assert_eq!(SendMessageW(hwnd, CB_GETCURSEL, 0, 0), -1);
			let mut buffer = [0_u16; 128];
			let length = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
			assert_eq!(String::from_utf16_lossy(&buffer[..length as usize]), "purple");
			SendMessageW(hwnd, CB_ADDSTRING, 0, wide("grow").as_ptr() as isize);
			let original = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, growing_combo as *const () as isize);
			assert_ne!(original, 0);
			ORIGINAL_COMBO_PROC.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
			let result = set_combo(hwnd, "grow", true, false);
			SetWindowLongPtrW(hwnd, GWLP_WNDPROC, original);
			let error = result.unwrap_err().to_string();
			assert!(error.contains("unverified"));
			assert!(error.contains("may already have changed"));
			// The candidate changed after the search. Selection is observable,
			// but its inexact text must never be reported as success.
			assert_eq!(SendMessageW(hwnd, CB_GETCURSEL, 0, 0), 2);
			let length = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
			assert_eq!(
				String::from_utf16_lossy(&buffer[..length as usize]),
				"a much longer dynamically replaced candidate"
			);

			let common = INITCOMMONCONTROLSEX {
				dwSize: std::mem::size_of::<INITCOMMONCONTROLSEX>() as u32,
				dwICC:  ICC_USEREX_CLASSES,
			};
			assert_ne!(InitCommonControlsEx(&common), 0);
			let extended = CreateWindowExW(
				0,
				wide("ComboBoxEx32").as_ptr(),
				empty.as_ptr(),
				WS_CHILD | CBS_DROPDOWN as u32,
				0,
				0,
				100,
				100,
				parent,
				8 as _,
				std::ptr::null_mut(),
				std::ptr::null(),
			);
			assert!(!extended.is_null());
			let inner = SendMessageW(extended, CBEM_GETCOMBOCONTROL, 0, 0)
				as windows_sys::Win32::Foundation::HWND;
			let edit = SendMessageW(extended, CBEM_GETEDITCONTROL, 0, 0)
				as windows_sys::Win32::Foundation::HWND;
			assert!(!inner.is_null() && !edit.is_null());
			for descendant in [extended, inner, edit] {
				let target = combo_target(descendant);
				assert_eq!(target, extended);
				assert_eq!(
					route(&super::super::window::class_name(target), ""),
					ValueRoute::RefuseCombo
				);
			}
			DestroyWindow(parent);
		}
	}
}
