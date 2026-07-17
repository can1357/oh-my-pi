use std::{
	fs,
	path::{Path, PathBuf},
	ptr,
	sync::{
		Arc, LazyLock, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread,
};

use anyhow::{Context, Result, bail};
use windows_sys::Win32::{
	Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, LocalFree, WPARAM},
	Security::{
		Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1},
		DACL_SECURITY_INFORMATION, PROTECTED_DACL_SECURITY_INFORMATION, SetFileSecurityW,
	},
	System::LibraryLoader::GetModuleHandleW,
	UI::{
		HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
		WindowsAndMessaging::{
			CS_HREDRAW, CS_VREDRAW, CW_USEDEFAULT, CreateWindowExW, DefWindowProcW, DispatchMessageW,
			GetMessageW, MB_ICONINFORMATION, MB_OK, MSG, MessageBoxW, PostMessageW, PostQuitMessage,
			RegisterClassW, TranslateMessage, WM_CLOSE, WM_COMMAND, WM_DESTROY, WM_HOTKEY,
			WM_LBUTTONUP, WM_RBUTTONUP, WNDCLASSW, WS_OVERLAPPED,
		},
	},
};

use super::{
	capture,
	gateway::{self, GatewaySupervisor},
	hotkey::{HOTKEY_ID, RegisteredHotkey},
	single_instance::{self, InstanceGuard, PipeServer},
	tray::{self, TrayIcon},
	wide,
};
use crate::{
	config::{Command as HostCommand, Config},
	protocol::{ControlCommand, ControlRequest, ControlResponse},
};

const WM_CONTROL_OPEN: u32 = windows_sys::Win32::UI::WindowsAndMessaging::WM_APP + 10;
const WM_CONTROL_CAPTURE: u32 = WM_CONTROL_OPEN + 1;
const WM_CONTROL_STATUS: u32 = WM_CONTROL_OPEN + 2;

static APP: LazyLock<Mutex<Option<Arc<AppState>>>> = LazyLock::new(|| Mutex::new(None));

struct AppState {
	hwnd:      HWND,
	root:      PathBuf,
	gateway:   GatewaySupervisor,
	capturing: AtomicBool,
	status:    Mutex<String>,
}

unsafe impl Send for AppState {}
unsafe impl Sync for AppState {}

pub fn run(config: Config) -> Result<()> {
	if config.command == HostCommand::ProbeHotkey {
		return probe_hotkey(config);
	}
	let Some(instance) = InstanceGuard::acquire()? else {
		return forward_to_owner(config.command);
	};
	if config.command != HostCommand::Run {
		drop(instance);
		bail!("no running Desktop Tag host accepted the command");
	}
	secure_root(&config.root, &instance.sid)?;
	unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) };
	let module = unsafe { GetModuleHandleW(ptr::null()) };
	if module.is_null() {
		return Err(std::io::Error::last_os_error()).context("get host module handle");
	}
	let hwnd = create_hidden_window(module)?;
	let gateway = GatewaySupervisor::start(config.gateway_program, &config.root)?;
	let state = Arc::new(AppState {
		hwnd,
		root: config.root,
		gateway,
		capturing: AtomicBool::new(false),
		status: Mutex::new("ready".into()),
	});
	*APP.lock().unwrap_or_else(|value| value.into_inner()) = Some(Arc::clone(&state));
	let handler_state = Arc::clone(&state);
	let pipe = PipeServer::start(
		&instance.sid,
		Arc::new(move |request| handle_control(&handler_state, request)),
	)?;
	let hotkey = RegisteredHotkey::register(hwnd, config.hotkey)?;
	let tray = TrayIcon::add(hwnd, module, "ready")?;
	message_loop(&tray);
	*APP.lock().unwrap_or_else(|value| value.into_inner()) = None;
	drop(tray);
	drop(hotkey);
	drop(pipe);
	drop(state);
	drop(instance);
	Ok(())
}

fn probe_hotkey(config: Config) -> Result<()> {
	let registered = RegisteredHotkey::register(ptr::null_mut(), config.hotkey)?;
	drop(registered);
	Ok(())
}

fn forward_to_owner(command: HostCommand) -> Result<()> {
	let command = match command {
		HostCommand::Run | HostCommand::Open => ControlCommand::Open,
		HostCommand::Capture => ControlCommand::Capture,
		HostCommand::Status => ControlCommand::Status,
		HostCommand::Shutdown => ControlCommand::Shutdown,
		HostCommand::ProbeHotkey => unreachable!(),
	};
	let sid = single_instance::current_user_sid()?;
	let response = single_instance::forward(&sid, &ControlRequest { version: 1, command })?;
	if !response.ok {
		bail!("Desktop Tag host rejected command: {}", response.status);
	}
	Ok(())
}

fn create_hidden_window(instance: HINSTANCE) -> Result<HWND> {
	let class_name = wide("OhMyPi.DesktopTag.Host");
	let class = WNDCLASSW {
		style: CS_HREDRAW | CS_VREDRAW,
		lpfnWndProc: Some(window_proc),
		hInstance: instance,
		lpszClassName: class_name.as_ptr(),
		..Default::default()
	};
	if unsafe { RegisterClassW(&class) } == 0 {
		return Err(std::io::Error::last_os_error()).context("register Desktop Tag window class");
	}
	let hwnd = unsafe {
		CreateWindowExW(
			0,
			class_name.as_ptr(),
			wide("Oh My Pi Desktop Tag").as_ptr(),
			WS_OVERLAPPED,
			CW_USEDEFAULT,
			CW_USEDEFAULT,
			0,
			0,
			ptr::null_mut(),
			ptr::null_mut(),
			instance,
			ptr::null_mut(),
		)
	};
	if hwnd.is_null() {
		return Err(std::io::Error::last_os_error()).context("create Desktop Tag message window");
	}
	Ok(hwnd)
}

fn message_loop(tray: &TrayIcon) {
	let mut message = MSG::default();
	while unsafe { GetMessageW(&mut message, ptr::null_mut(), 0, 0) } > 0 {
		unsafe {
			TranslateMessage(&message);
			DispatchMessageW(&message);
		}
		if let Some(state) = app_state() {
			tray.set_status(
				&state
					.status
					.lock()
					.unwrap_or_else(|value| value.into_inner()),
			);
		}
	}
}

unsafe extern "system" fn window_proc(
	hwnd: HWND,
	message: u32,
	wparam: WPARAM,
	lparam: LPARAM,
) -> LRESULT {
	match message {
		WM_HOTKEY if wparam as i32 == HOTKEY_ID => begin_capture(),
		tray::WM_TRAY if matches!(tray::tray_event_message(lparam), WM_RBUTTONUP | WM_LBUTTONUP) => {
			if let Some(command) = tray::show_menu(hwnd) {
				handle_menu(command);
			}
		},
		WM_COMMAND => handle_menu(wparam & 0xffff),
		WM_CONTROL_OPEN => open_overlay(),
		WM_CONTROL_CAPTURE => begin_capture(),
		WM_CONTROL_STATUS => show_status(),
		WM_CLOSE | WM_DESTROY => unsafe { PostQuitMessage(0) },
		_ => return unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
	}
	0
}

fn handle_menu(command: usize) {
	match command {
		tray::CMD_OPEN => open_overlay(),
		tray::CMD_CAPTURE => begin_capture(),
		tray::CMD_STATUS => show_status(),
		tray::CMD_STARTUP => {
			let result = std::env::current_exe().and_then(|path| {
				tray::toggle_startup(&path.to_string_lossy()).map_err(std::io::Error::other)
			});
			set_status(match result {
				Ok(true) => "start at sign-in enabled".into(),
				Ok(false) => "start at sign-in disabled".into(),
				Err(error) => format!("startup setting failed: {error}"),
			});
		},
		tray::CMD_EXIT => unsafe { PostQuitMessage(0) },
		_ => {},
	}
}

fn begin_capture() {
	let Some(state) = app_state() else { return };
	if state.capturing.swap(true, Ordering::AcqRel) {
		set_status("capture already in progress".into());
		return;
	}
	let capture_root = state.root.join("captures");
	let snapshot = capture::snapshot_foreground(&capture_root);
	match snapshot {
		Err(error) => {
			state.capturing.store(false, Ordering::Release);
			set_status(format!("capture failed: {error:#}"));
		},
		Ok(snapshot) => {
			set_status("captured; staging context".into());
			thread::spawn(move || {
				let result = snapshot
					.persist(&capture_root)
					.and_then(|manifest| state.gateway.stage(&manifest))
					.and_then(|url| gateway::launch_url(&url));
				set_status(match result {
					Ok(()) => "overlay opened".into(),
					Err(error) => format!("stage failed; overlay not opened: {error:#}"),
				});
				state.capturing.store(false, Ordering::Release);
			});
		},
	}
}

fn open_overlay() {
	if let Some(state) = app_state() {
		set_status(match state.gateway.open_overlay() {
			Ok(()) => "overlay opened".into(),
			Err(error) => format!("open failed: {error:#}"),
		});
	}
}

fn show_status() {
	let Some(state) = app_state() else { return };
	let text = format!(
		"{}\n{}",
		state
			.status
			.lock()
			.unwrap_or_else(|value| value.into_inner()),
		state.gateway.state().status
	);
	unsafe {
		MessageBoxW(
			state.hwnd,
			wide(&text).as_ptr(),
			wide("Desktop Tag Status").as_ptr(),
			MB_OK | MB_ICONINFORMATION,
		)
	};
}

fn handle_control(state: &Arc<AppState>, request: ControlRequest) -> ControlResponse {
	if request.version != 1 {
		return ControlResponse {
			version: 1,
			ok:      false,
			status:  "unsupported protocol version".into(),
		};
	}
	let message = match request.command {
		ControlCommand::Open => Some(WM_CONTROL_OPEN),
		ControlCommand::Capture => Some(WM_CONTROL_CAPTURE),
		ControlCommand::Status => Some(WM_CONTROL_STATUS),
		ControlCommand::Shutdown => None,
	};
	let posted = unsafe { PostMessageW(state.hwnd, message.unwrap_or(WM_CLOSE), 0, 0) } != 0;
	ControlResponse {
		version: 1,
		ok:      posted,
		status:  if posted {
			state
				.status
				.lock()
				.unwrap_or_else(|value| value.into_inner())
				.clone()
		} else {
			"command dispatch failed".into()
		},
	}
}

fn app_state() -> Option<Arc<AppState>> {
	APP.lock()
		.unwrap_or_else(|value| value.into_inner())
		.clone()
}

fn set_status(status: String) {
	if let Some(state) = app_state() {
		*state
			.status
			.lock()
			.unwrap_or_else(|value| value.into_inner()) = status;
	}
}

fn secure_root(root: &Path, sid: &str) -> Result<()> {
	fs::create_dir_all(root)?;
	let descriptor = wide(&format!("D:P(A;;FA;;;{sid})"));
	let mut security = ptr::null_mut();
	if unsafe {
		ConvertStringSecurityDescriptorToSecurityDescriptorW(
			descriptor.as_ptr(),
			SDDL_REVISION_1,
			&mut security,
			ptr::null_mut(),
		)
	} == 0
	{
		return Err(std::io::Error::last_os_error()).context("build Desktop Tag directory ACL");
	}
	let result = unsafe {
		SetFileSecurityW(
			wide(&root.to_string_lossy()).as_ptr(),
			DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
			security,
		)
	};
	unsafe { LocalFree(security) };
	if result == 0 {
		return Err(std::io::Error::last_os_error()).context("secure Desktop Tag private directory");
	}
	Ok(())
}
