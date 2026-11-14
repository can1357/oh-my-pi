use super::super::{ax::text_readback, error::CoreResult};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ValueRoute {
	Pattern,
	Combo,
	RefuseCombo,
}

pub(super) fn route(class: &str) -> ValueRoute {
	if class.eq_ignore_ascii_case("ComboBox")
		|| class.split_once(".app.").is_some_and(|(base, suffix)| {
			base.eq_ignore_ascii_case("WindowsForms10.COMBOBOX") && !suffix.is_empty()
		}) {
		ValueRoute::Combo
	} else if class.eq_ignore_ascii_case("ComboBoxEx32") {
		ValueRoute::RefuseCombo
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
		if route(&super::window::class_name(ancestor)) == ValueRoute::RefuseCombo {
			return ancestor;
		}
		// SAFETY: GetParent only queries the native ancestry.
		ancestor = unsafe { GetParent(ancestor) };
	}
	// A raw UIA ref can name the edit child rather than the combo itself.
	// Only normalize the edit handle the native combo API identifies.
	// SAFETY: GetParent only queries the supplied handle.
	let parent = unsafe { GetParent(hwnd) };
	if !parent.is_null() && route(&super::window::class_name(parent)) == ValueRoute::Combo {
		let mut info =
			COMBOBOXINFO { cbSize: std::mem::size_of::<COMBOBOXINFO>() as u32, ..Default::default() };
		// SAFETY: info is writable with the correct size; parent is queried only.
		if unsafe { GetComboBoxInfo(parent, &mut info) } != 0 && info.hwndItem == hwnd {
			return parent;
		}
	}
	hwnd
}

#[cfg(target_os = "windows")]
pub(super) fn set_combo(
	hwnd: windows_sys::Win32::Foundation::HWND,
	text: &str,
	enabled: bool,
	secure: bool,
) -> CoreResult<()> {
	use windows_sys::Win32::{
		System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
		UI::{
			Controls::{COMBOBOXINFO, GetComboBoxInfo},
			WindowsAndMessaging::{
				CB_FINDSTRINGEXACT, CB_GETCURSEL, CB_SETCURSEL, CBN_EDITCHANGE, CBN_SELCHANGE,
				CBN_SELENDOK, GWL_STYLE, GetDlgCtrlID, GetParent, GetWindowLongW,
				GetWindowThreadProcessId, IsWindow, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_COMMAND,
				WM_GETTEXT, WM_SETTEXT,
			},
		},
	};

	use super::super::error::DesktopError;
	let writing = std::cell::Cell::new(false);
	let failed = || combo_failure(writing.get());
	let send = |target, message, wparam, lparam| {
		if matches!(message, CB_FINDSTRINGEXACT | WM_SETTEXT | WM_GETTEXT) {
			let mut process = 0;
			// SAFETY: these APIs only query window/process/thread identifiers.
			let local_other_thread = unsafe {
				let thread = GetWindowThreadProcessId(target, &mut process);
				process == GetCurrentProcessId() && thread != GetCurrentThreadId()
			};
			if local_other_thread {
				return Err(DesktopError::ax_failed(if writing.get() {
					"the combo box's value could not be confirmed safely; pointer-bearing messages to \
					 another thread in this process are unsafe after a timeout; the value may already \
					 have changed, so inspect the target before trying again"
				} else {
					"the combo box's value could not be confirmed safely; pointer-bearing messages to \
					 another thread in this process are unsafe after a timeout; nothing was written; \
					 use press/click instead"
				}));
			}
		}
		let mut result = 0;
		// SAFETY: pointer-bearing system messages are marshalled for another
		// process. Same-thread dispatch is synchronous; same-process dispatch
		// to another thread is refused above before a buffer can outlive us.
		let answered = unsafe {
			SendMessageTimeoutW(target, message, wparam, lparam, SMTO_ABORTIFHUNG, 3000, &mut result)
		};
		if answered == 0 {
			Err(failed())
		} else {
			Ok(result as isize)
		}
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

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn native_combo_classes_use_native_notifications() {
		assert_eq!(route("combobox"), ValueRoute::Combo);
		assert_eq!(route("WindowsForms10.COMBOBOX.app.0.141b42a_r8_ad1"), ValueRoute::Combo);
		assert_eq!(route("ComboBoxEx32"), ValueRoute::RefuseCombo);
		assert_eq!(route(""), ValueRoute::Pattern);
		assert_eq!(route("Chrome_RenderWidgetHostHWND"), ValueRoute::Pattern);
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
			if code == DESTROY_ON_NOTIFICATION.with(|destroy| destroy.get()) {
				// SAFETY: lparam is the combo this test created and owns.
				unsafe { DestroyWindow(lparam as _) };
			}
		}
		let original = ORIGINAL_PARENT_PROC.with(|proc| proc.get());
		// SAFETY: the test saved this native parent's original procedure.
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
				assert!(!parent.is_null() && !combo.is_null());
				let original =
					SetWindowLongPtrW(combo, GWLP_WNDPROC, recording_combo as *const () as isize);
				ORIGINAL_COMBO_PROC
					.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
				ready
					.send((combo as usize, windows_sys::Win32::System::Threading::GetCurrentThreadId()))
					.unwrap();
				let mut message = MSG::default();
				while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
					DispatchMessageW(&message);
				}
				DestroyWindow(parent);
				assert_eq!(
					POINTER_CALLS.with(|calls| calls.get()),
					0,
					"pointer-bearing message must not reach the other thread"
				);
			}
		});
		let (hwnd, thread) = handle.recv().unwrap();
		let result = set_combo(hwnd as _, "green", true, false);
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
				assert_eq!(route(&super::super::window::class_name(target)), ValueRoute::RefuseCombo);
			}
			DestroyWindow(parent);
		}
	}
}
