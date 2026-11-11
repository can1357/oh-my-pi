use super::super::{ax::text_readback, error::CoreResult};

#[derive(Debug, PartialEq, Eq)]
pub(super) enum ValueRoute {
	Pattern,
	Combo,
	RefuseCombo,
}

pub(super) fn route(class: &str, combo: bool) -> ValueRoute {
	if class.eq_ignore_ascii_case("ComboBox")
		|| class.split_once(".app.").is_some_and(|(base, suffix)| {
			base.eq_ignore_ascii_case("WindowsForms10.COMBOBOX") && !suffix.is_empty()
		}) {
		ValueRoute::Combo
	} else if combo {
		ValueRoute::RefuseCombo
	} else {
		ValueRoute::Pattern
	}
}

pub(super) fn verify(expected: &str, actual: Option<&str>, secure: bool) -> CoreResult<()> {
	text_readback(expected, expected, actual, secure)
}

#[cfg(target_os = "windows")]
pub(super) fn set_combo(hwnd: windows_sys::Win32::Foundation::HWND, text: &str) -> CoreResult<()> {
	use windows_sys::Win32::UI::{
		Controls::{COMBOBOXINFO, GetComboBoxInfo},
		WindowsAndMessaging::{
			CB_FINDSTRINGEXACT, CB_GETCURSEL, CB_SETCURSEL, CBN_EDITCHANGE, CBN_SELCHANGE,
			CBN_SELENDOK, GWL_STYLE, GetDlgCtrlID, GetParent, GetWindowLongW, SMTO_ABORTIFHUNG,
			SendMessageTimeoutW, WM_COMMAND, WM_SETTEXT,
		},
	};

	use super::super::error::DesktopError;
	let failed = || {
		DesktopError::ax_failed(
			"the combo box selection could not be confirmed; select the item via press/click and \
			 inspect the target before writing again",
		)
	};
	let send = |target, message, wparam, lparam| {
		let mut result = 0;
		// SAFETY: string pointers remain valid until this synchronous message
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
	let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
	if style & 0x30 != 0 && style & 0x200 == 0 {
		return Err(failed());
	}
	let wide: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
	let index = send(hwnd, CB_FINDSTRINGEXACT, usize::MAX, wide.as_ptr() as isize)?;
	let parent = unsafe { GetParent(hwnd) };
	if parent.is_null() {
		return Err(failed());
	}
	let id = unsafe { GetDlgCtrlID(hwnd) } as u32 & 0xffff;
	if index < 0 {
		if style & 3 == 3 {
			return Err(DesktopError::ax_failed(
				"the combo box has no matching item; select the item via press/click instead",
			));
		}
		let mut info =
			COMBOBOXINFO { cbSize: std::mem::size_of::<COMBOBOXINFO>() as u32, ..Default::default() };
		if unsafe { GetComboBoxInfo(hwnd, &mut info) } == 0 || info.hwndItem.is_null() {
			return Err(failed());
		}
		if send(info.hwndItem, WM_SETTEXT, 0, wide.as_ptr() as isize)? == 0 {
			return Err(failed());
		}
		send(parent, WM_COMMAND, (id | (CBN_EDITCHANGE << 16)) as usize, hwnd as isize)?;
		return Ok(());
	}
	// The parent handles these synchronous notifications before readback.
	if send(hwnd, CB_SETCURSEL, index as usize, 0)? != index {
		return Err(failed());
	}
	for code in [CBN_SELENDOK, CBN_SELCHANGE] {
		send(parent, WM_COMMAND, (id | (code << 16)) as usize, hwnd as isize)?;
	}
	if send(hwnd, CB_GETCURSEL, 0, 0)? != index {
		return Err(failed());
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn native_combos_notify_instead_of_writing_only_uia_text() {
		assert_eq!(route("ComboBox", true), ValueRoute::Combo);
		assert_eq!(route("WindowsForms10.COMBOBOX.app.0.141b42a_r8_ad1", true), ValueRoute::Combo);
		assert_eq!(route("ComboBoxEx32", true), ValueRoute::RefuseCombo);
		assert_eq!(route("Edit", false), ValueRoute::Pattern);
	}

	#[test]
	fn windows_value_write_requires_exact_readback() {
		assert!(verify("abc", Some("abc"), false).is_ok());
		let error = verify("abc", Some("ABC"), false).unwrap_err();
		assert!(error.message.contains("field now reads"));
		assert!(verify("abc", None, false).is_err());
		let secure = verify("secret", Some("different"), true).unwrap_err();
		assert!(!secure.message.contains("secret"));
		assert!(!secure.message.contains("different"));
	}
}
