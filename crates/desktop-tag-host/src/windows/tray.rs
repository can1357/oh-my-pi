use std::{mem::size_of, ptr};

use anyhow::{Context, Result};
use windows_sys::Win32::{
	Foundation::{HINSTANCE, HWND, LPARAM, POINT},
	System::Registry::{
		HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE, REG_OPTION_NON_VOLATILE, REG_SZ,
		RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegQueryValueExW, RegSetValueExW,
	},
	UI::{
		Shell::{
			NIF_ICON, NIF_MESSAGE, NIF_TIP, NIM_ADD, NIM_DELETE, NIM_MODIFY, NIM_SETVERSION,
			NOTIFYICON_VERSION_4, NOTIFYICONDATAW, Shell_NotifyIconW,
		},
		WindowsAndMessaging::{
			AppendMenuW, CreatePopupMenu, DestroyMenu, GetCursorPos, IDI_APPLICATION, LoadIconW,
			MF_CHECKED, MF_SEPARATOR, MF_STRING, SetForegroundWindow, TPM_BOTTOMALIGN, TPM_LEFTALIGN,
			TPM_RETURNCMD, TrackPopupMenu, WM_APP,
		},
	},
};

use super::wide;

pub const WM_TRAY: u32 = WM_APP + 1;
pub const CMD_OPEN: usize = 1001;
pub const CMD_CAPTURE: usize = 1002;
pub const CMD_STATUS: usize = 1003;
pub const CMD_STARTUP: usize = 1004;
pub const CMD_EXIT: usize = 1005;

pub struct TrayIcon {
	hwnd: HWND,
}

impl TrayIcon {
	pub fn add(hwnd: HWND, instance: HINSTANCE, status: &str) -> Result<Self> {
		let mut data = notify_data(hwnd, status);
		data.hIcon = unsafe { LoadIconW(instance, IDI_APPLICATION) };
		if unsafe { Shell_NotifyIconW(NIM_ADD, &data) } == 0 {
			return Err(std::io::Error::last_os_error()).context("add Desktop Tag tray icon");
		}
		data.Anonymous.uVersion = NOTIFYICON_VERSION_4;
		unsafe { Shell_NotifyIconW(NIM_SETVERSION, &data) };
		Ok(Self { hwnd })
	}

	pub fn set_status(&self, status: &str) {
		let data = notify_data(self.hwnd, status);
		unsafe { Shell_NotifyIconW(NIM_MODIFY, &data) };
	}

	pub fn show_menu(&self) -> Option<usize> {
		show_menu(self.hwnd)
	}
}

impl Drop for TrayIcon {
	fn drop(&mut self) {
		let data = notify_data(self.hwnd, "");
		unsafe { Shell_NotifyIconW(NIM_DELETE, &data) };
	}
}

pub fn show_menu(hwnd: HWND) -> Option<usize> {
	let menu = unsafe { CreatePopupMenu() };
	if menu.is_null() {
		return None;
	}
	let startup = startup_enabled().unwrap_or(false);
	unsafe {
		AppendMenuW(menu, MF_STRING, CMD_OPEN, wide("Open Tag").as_ptr());
		AppendMenuW(menu, MF_STRING, CMD_CAPTURE, wide("Capture Foreground").as_ptr());
		AppendMenuW(menu, MF_STRING, CMD_STATUS, wide("Status / Restart Gateway").as_ptr());
		AppendMenuW(
			menu,
			MF_STRING | if startup { MF_CHECKED } else { 0 },
			CMD_STARTUP,
			wide("Start at sign-in").as_ptr(),
		);
		AppendMenuW(menu, MF_SEPARATOR, 0, ptr::null());
		AppendMenuW(menu, MF_STRING, CMD_EXIT, wide("Exit").as_ptr());
		let mut point = POINT::default();
		GetCursorPos(&mut point);
		SetForegroundWindow(hwnd);
		let command = TrackPopupMenu(
			menu,
			TPM_LEFTALIGN | TPM_BOTTOMALIGN | TPM_RETURNCMD,
			point.x,
			point.y,
			0,
			hwnd,
			ptr::null(),
		);
		DestroyMenu(menu);
		(command != 0).then_some(command as usize)
	}
}

fn notify_data(hwnd: HWND, status: &str) -> NOTIFYICONDATAW {
	let mut data = NOTIFYICONDATAW::default();
	data.cbSize = size_of::<NOTIFYICONDATAW>() as u32;
	data.hWnd = hwnd;
	data.uID = 1;
	data.uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP;
	data.uCallbackMessage = WM_TRAY;
	let tip = wide(&format!("Oh My Pi Desktop Tag — {status}"));
	let length = tip.len().saturating_sub(1).min(data.szTip.len() - 1);
	data.szTip[..length].copy_from_slice(&tip[..length]);
	data
}

pub fn toggle_startup(executable: &str) -> Result<bool> {
	let enabled = startup_enabled()?;
	let key = open_run_key(KEY_SET_VALUE)?;
	let name = wide("OhMyPi-DesktopTag");
	let result = if enabled {
		unsafe { RegDeleteValueW(key, name.as_ptr()) }
	} else {
		let command = wide(&format!("\"{executable}\" run"));
		unsafe {
			RegSetValueExW(
				key,
				name.as_ptr(),
				0,
				REG_SZ,
				command.as_ptr().cast(),
				(command.len() * 2) as u32,
			)
		}
	};
	unsafe { RegCloseKey(key) };
	if result != 0 {
		return Err(std::io::Error::from_raw_os_error(result as i32))
			.context("update Desktop Tag sign-in startup");
	}
	Ok(!enabled)
}

fn startup_enabled() -> Result<bool> {
	let key = open_run_key(KEY_QUERY_VALUE)?;
	let result = unsafe {
		RegQueryValueExW(
			key,
			wide("OhMyPi-DesktopTag").as_ptr(),
			ptr::null_mut(),
			ptr::null_mut(),
			ptr::null_mut(),
			ptr::null_mut(),
		)
	};
	unsafe { RegCloseKey(key) };
	Ok(result == 0)
}

fn open_run_key(access: u32) -> Result<HKEY> {
	let mut key = ptr::null_mut();
	let result = unsafe {
		RegCreateKeyExW(
			HKEY_CURRENT_USER,
			wide(r"Software\Microsoft\Windows\CurrentVersion\Run").as_ptr(),
			0,
			ptr::null_mut(),
			REG_OPTION_NON_VOLATILE,
			access,
			ptr::null(),
			&mut key,
			ptr::null_mut(),
		)
	};
	if result != 0 {
		return Err(std::io::Error::from_raw_os_error(result as i32))
			.context("open current-user Run key");
	}
	Ok(key)
}

pub fn tray_event_message(lparam: LPARAM) -> u32 {
	(lparam as u32) & 0xffff
}
