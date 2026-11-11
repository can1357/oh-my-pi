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
	use windows_sys::Win32::UI::{
		Controls::{COMBOBOXINFO, GetComboBoxInfo},
		WindowsAndMessaging::{
			CB_FINDSTRINGEXACT, CB_GETCURSEL, CB_SETCURSEL, CBN_EDITCHANGE, CBN_SELCHANGE,
			CBN_SELENDOK, GWL_STYLE, GetDlgCtrlID, GetParent, GetWindowLongW, SMTO_ABORTIFHUNG,
			SendMessageTimeoutW, WM_COMMAND, WM_GETTEXT, WM_SETTEXT,
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
	// The native search is case-insensitive. It only supplies a candidate:
	// exact post-write text and index readback decide success. Never query
	// item names through MSAA (unbounded provider calls) or CB_GETLBTEXT
	// (an unbounded caller-buffer copy if the item grows).
	let candidate_index =
		usize::try_from(send(hwnd, CB_FINDSTRINGEXACT, usize::MAX, wide.as_ptr() as isize)?).ok();
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
	}?;
	// WM_GETTEXT takes the buffer capacity, unlike CB_GETLBTEXT. One extra
	// code unit beyond the expected text distinguishes a longer value from
	// an exact match even when the read is truncated.
	let mut actual = vec![0_u16; wide.len() + 1];
	let length =
		usize::try_from(send(hwnd, WM_GETTEXT, actual.len(), actual.as_mut_ptr() as isize)?)
			.map_err(|_| failed())?;
	if length >= actual.len() {
		return Err(failed());
	}
	let expected_index = candidate_index.map_or(-1, |index| index as isize);
	if send(hwnd, CB_GETCURSEL, 0, 0)? != expected_index {
		return Err(failed());
	}
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

	// Drives an external hidden-desktop fixture without loading an addon.
	// PI_NATIVE_COMBO_PROBE_JSON supplies hwnd, text, mode (fixed/main),
	// and optional stall_message/stall_marker for a sleeping WndProc.
	#[cfg(target_os = "windows")]
	#[test]
	#[ignore = "requires an external native/WinForms fixture"]
	fn external_combo_probe() {
		use uiautomation::{UIAutomation, patterns::UIValuePattern, types::Handle};
		let input: serde_json::Value =
			serde_json::from_str(&std::env::var("PI_NATIVE_COMBO_PROBE_JSON").unwrap()).unwrap();
		let hwnd = input["hwnd"].as_u64().unwrap() as usize as _;
		let text = input["text"].as_str().unwrap();
		let mode = input["mode"].as_str().unwrap();
		let pattern = if mode == "main" {
			// This is origin/main's Windows value-write path: retrieve the
			// ValuePattern and invoke its setter, with no native notifications.
			let automation = UIAutomation::new().unwrap();
			let element = automation
				.element_from_handle(Handle::from(input["hwnd"].as_u64().unwrap() as isize))
				.unwrap();
			Some(element.get_pattern::<UIValuePattern>().unwrap())
		} else {
			assert_eq!(mode, "fixed");
			None
		};
		if let Some(message) = input["stall_message"].as_u64() {
			let marker = std::path::Path::new(input["stall_marker"].as_str().unwrap());
			assert_ne!(
				// SAFETY: the fixture owns this handle and custom stall message.
				unsafe {
					windows_sys::Win32::UI::WindowsAndMessaging::PostMessageW(hwnd, message as u32, 0, 0)
				},
				0
			);
			let waiting = std::time::Instant::now();
			while !marker.exists() {
				assert!(waiting.elapsed() < std::time::Duration::from_secs(5));
				std::thread::sleep(std::time::Duration::from_millis(10));
			}
		}
		let start = std::time::Instant::now();
		let result = if let Some(pattern) = pattern {
			pattern.set_value(text).map_err(|error| error.to_string())
		} else {
			set_combo(hwnd, text, true, false).map_err(|error| error.to_string())
		};
		println!(
			"{}",
			serde_json::json!({
				"mode": mode, "text": text, "elapsed_ms": start.elapsed().as_millis(),
				"ok": result.is_ok(), "error": result.err(),
			})
		);
	}

	#[cfg(target_os = "windows")]
	std::thread_local! {
		static ORIGINAL_COMBO_PROC: std::cell::Cell<windows_sys::Win32::UI::WindowsAndMessaging::WNDPROC>
			= const { std::cell::Cell::new(None) };
		static ITEM_NAME_READS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
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
	unsafe extern "system" fn sleeping_combo(
		hwnd: windows_sys::Win32::Foundation::HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::WindowsAndMessaging::{CB_FINDSTRINGEXACT, CallWindowProcW};
		if message == CB_FINDSTRINGEXACT {
			std::thread::sleep(std::time::Duration::from_secs(6));
			// Do not dereference the caller's message pointer after its timeout.
			return -1;
		}
		let original = ORIGINAL_COMBO_PROC.with(|proc| proc.get());
		// SAFETY: this test saved the original native window procedure.
		unsafe { CallWindowProcW(original, hwnd, message, wparam, lparam) }
	}

	#[cfg(target_os = "windows")]
	#[test]
	fn a_combo_that_stops_pumping_does_not_block_the_worker() {
		use std::sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
			mpsc,
		};

		use windows_sys::Win32::UI::WindowsAndMessaging::{
			CreateWindowExW, DestroyWindow, DispatchMessageW, GWLP_WNDPROC, MSG, PM_REMOVE,
			PeekMessageW, SetWindowLongPtrW, WNDPROC, WS_CHILD, WS_OVERLAPPED,
		};
		let stop = Arc::new(AtomicBool::new(false));
		let stopped = Arc::clone(&stop);
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
					SetWindowLongPtrW(combo, GWLP_WNDPROC, sleeping_combo as *const () as isize);
				ORIGINAL_COMBO_PROC
					.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
				ready.send(combo as usize).unwrap();
				while !stopped.load(Ordering::Relaxed) {
					let mut message = MSG::default();
					if PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
						DispatchMessageW(&message);
					}
					std::thread::sleep(std::time::Duration::from_millis(1));
				}
				DestroyWindow(parent);
			}
		});
		let hwnd = handle
			.recv_timeout(std::time::Duration::from_secs(10))
			.unwrap() as _;
		let start = std::time::Instant::now();
		let result = set_combo(hwnd, "green", true, false);
		let elapsed = start.elapsed();
		stop.store(true, Ordering::Relaxed);
		owner.join().unwrap();
		let error = result.unwrap_err().to_string();
		assert!(error.contains("no value or selection was confirmed"), "{error}");
		assert!(error.contains("nothing was written"), "{error}");
		assert!(elapsed >= std::time::Duration::from_secs(2), "{elapsed:?}");
		assert!(elapsed < std::time::Duration::from_secs(5), "{elapsed:?}");
		println!("hung combo: returned in {elapsed:?}: {error}");
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
