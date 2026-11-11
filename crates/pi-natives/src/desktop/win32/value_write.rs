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
	secure: bool,
) -> CoreResult<()> {
	// An empty ValuePattern result is a confirmed value, not a missing read.
	text_readback(expected, expected, pattern.or(legacy), secure)
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

pub(super) const fn plan(enabled: bool, style: u32, exact_index: Option<usize>) -> ComboPlan {
	if !enabled
		|| (style & (CBS_OWNERDRAWFIXED | CBS_OWNERDRAWVARIABLE) != 0 && style & CBS_HASSTRINGS == 0)
	{
		ComboPlan::Refuse
	} else if let Some(index) = exact_index {
		ComboPlan::Select(index)
	} else if style & CBS_TYPE_MASK == CBS_DROPDOWNLIST {
		ComboPlan::NoItem
	} else {
		ComboPlan::Edit
	}
}

fn find_exact(
	expected: &[u16],
	count: usize,
	mut next: impl FnMut(usize) -> CoreResult<Option<(usize, Vec<u16>)>>,
) -> CoreResult<Option<usize>> {
	let mut start = usize::MAX;
	let mut first = None;
	for _ in 0..count {
		let Some((index, item)) = next(start)? else {
			break;
		};
		if first == Some(index) {
			break;
		}
		first.get_or_insert(index);
		if item == expected {
			return Ok(Some(index));
		}
		start = index;
	}
	Ok(None)
}

fn combo_failure(writing: bool) -> super::super::error::DesktopError {
	super::super::error::DesktopError::ax_failed(if writing {
		"the combo box may already have changed, but its selection could not be confirmed; select \
		 the item via press/click and inspect the target before writing again"
	} else {
		"the combo box could not be prepared for writing; select the item via press/click instead; \
		 nothing was written"
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
) -> CoreResult<()> {
	use windows_sys::Win32::UI::{
		Controls::{COMBOBOXINFO, GetComboBoxInfo},
		WindowsAndMessaging::{
			CB_FINDSTRINGEXACT, CB_GETCOUNT, CB_GETCURSEL, CB_GETLBTEXT, CB_GETLBTEXTLEN,
			CB_SETCURSEL, CBN_EDITCHANGE, CBN_SELCHANGE, CBN_SELENDOK, GWL_STYLE, GetDlgCtrlID,
			GetParent, GetWindowLongW, SMTO_ABORTIFHUNG, SendMessageTimeoutW, WM_COMMAND, WM_SETTEXT,
		},
	};

	use super::super::error::DesktopError;
	let writing = std::cell::Cell::new(false);
	let failed = || combo_failure(writing.get());
	let send = |target, message, wparam, lparam| {
		let mut result = 0;
		// SAFETY: string buffers remain valid until the synchronous message
		// returns.
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
	let count = usize::try_from(send(hwnd, CB_GETCOUNT, 0, 0)?).map_err(|_| failed())?;
	let exact_index = find_exact(&wide[..wide.len() - 1], count, |start| {
		let found = send(hwnd, CB_FINDSTRINGEXACT, start, wide.as_ptr() as isize)?;
		let Ok(index) = usize::try_from(found) else {
			return Ok(None);
		};
		let len = usize::try_from(send(hwnd, CB_GETLBTEXTLEN, index, 0)?).map_err(|_| failed())?;
		let mut item = vec![0_u16; len + 1];
		let copied = usize::try_from(send(hwnd, CB_GETLBTEXT, index, item.as_mut_ptr() as isize)?)
			.map_err(|_| failed())?;
		if copied > len {
			return Err(failed());
		}
		item.truncate(copied);
		Ok(Some((index, item)))
	})?;
	// SAFETY: GetParent accepts the native combo handle.
	let parent = unsafe { GetParent(hwnd) };
	if parent.is_null() {
		return Err(failed());
	}
	// SAFETY: GetDlgCtrlID reads the native control's identifier.
	let id = unsafe { GetDlgCtrlID(hwnd) } as u32 & 0xffff;
	match plan(enabled, style, exact_index) {
		ComboPlan::Refuse => Err(failed()),
		ComboPlan::NoItem => Err(DesktopError::ax_failed(
			"the combo box has no exactly matching item; select the item via press/click instead; \
			 nothing was written",
		)),
		ComboPlan::Select(index) => {
			writing.set(true);
			if send(hwnd, CB_SETCURSEL, index, 0)? != index as isize {
				return Err(failed());
			}
			for code in [CBN_SELENDOK, CBN_SELCHANGE] {
				send(parent, WM_COMMAND, (id | (code << 16)) as usize, hwnd as isize)?;
			}
			if send(hwnd, CB_GETCURSEL, 0, 0)? != index as isize {
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
			// SAFETY: GetWindowLongW only queries the identified edit handle.
			if unsafe { GetWindowLongW(info.hwndItem, GWL_STYLE) }
				& windows_sys::Win32::UI::WindowsAndMessaging::ES_READONLY
				!= 0
			{
				return Err(DesktopError::ax_failed(
					"the combo box edit is read-only; nothing was written",
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
			if send(hwnd, CB_GETCURSEL, 0, 0)? != -1 {
				return Err(failed());
			}
			Ok(())
		},
	}
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
		assert!(verdict("", Some(""), Some("stale"), false).is_ok());
		assert!(verdict("abc", None, Some("abc"), false).is_ok());
		assert!(verdict("abc", Some("ABC"), Some("abc"), false).is_err());
		assert!(verdict("abc", None, None, false).is_err());
		let secure = verdict("secret", None, None, true).unwrap_err();
		assert!(!secure.message.contains("secret"));
		let secure = verdict("secret", Some("different"), None, true).unwrap_err();
		assert!(!secure.message.contains("secret"));
		assert!(!secure.message.contains("different"));
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

	#[test]
	fn combo_errors_distinguish_preparation_from_partial_writes() {
		let preparation = combo_failure(false).to_string();
		assert!(preparation.contains("nothing was written"));
		assert!(!preparation.contains("may already have changed"));
		let partial = combo_failure(true).to_string();
		assert!(partial.contains("may already have changed"));
		assert!(!partial.contains("nothing was written"));
	}
	#[cfg(target_os = "windows")]
	#[test]
	fn combo_preparation_errors_confirm_nothing_was_written() {
		for text in ["contains\0nul", "invalid handle"] {
			let error = set_combo(std::ptr::null_mut(), text, true)
				.unwrap_err()
				.to_string();
			assert!(error.contains("nothing was written"), "{error}");
			assert!(!error.contains("may already have changed"), "{error}");
		}
	}

	#[test]
	fn case_insensitive_candidates_do_not_choose_a_differently_cased_item() {
		let expected: Vec<u16> = "abc".encode_utf16().collect();
		let actual = find_exact(&expected, 2, |start| {
			let (index, text) = if start == usize::MAX {
				(0, "ABC")
			} else {
				(1, "abc")
			};
			Ok(Some((index, text.encode_utf16().collect())))
		})
		.unwrap();
		assert_eq!(actual, Some(1));
		let actual =
			find_exact(&expected, 2, |_| Ok(Some((0, "ABC".encode_utf16().collect())))).unwrap();
		assert_eq!(actual, None);
	}

	#[cfg(target_os = "windows")]
	#[test]
	fn editing_an_unlisted_value_clears_the_previous_selection() {
		use windows_sys::Win32::UI::{
			Controls::{COMBOBOXINFO, GetComboBoxInfo},
			WindowsAndMessaging::{
				CB_ADDSTRING, CB_GETCURSEL, CB_SETCURSEL, CBS_DROPDOWN, CBS_HASSTRINGS,
				CreateWindowExW, DestroyWindow, GetWindowTextW, SendMessageW, WS_CHILD, WS_OVERLAPPED,
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
			SendMessageW(info.hwndItem, windows_sys::Win32::UI::Controls::EM_SETREADONLY, 1, 0);
			let error = set_combo(combo_target(info.hwndItem), "purple", true).unwrap_err();
			assert!(error.to_string().contains("read-only"));
			assert_eq!(SendMessageW(hwnd, CB_GETCURSEL, 0, 0), 1);
			let mut unchanged = [0_u16; 32];
			let length = GetWindowTextW(hwnd, unchanged.as_mut_ptr(), unchanged.len() as i32);
			assert_eq!(String::from_utf16_lossy(&unchanged[..length as usize]), "green");
			SendMessageW(info.hwndItem, windows_sys::Win32::UI::Controls::EM_SETREADONLY, 0, 0);

			set_combo(combo_target(info.hwndItem), "purple", true).unwrap();

			assert_eq!(SendMessageW(hwnd, CB_GETCURSEL, 0, 0), -1);
			let mut buffer = [0_u16; 32];
			let length = GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32);
			assert_eq!(String::from_utf16_lossy(&buffer[..length as usize]), "purple");
			DestroyWindow(parent);
		}
	}
}
