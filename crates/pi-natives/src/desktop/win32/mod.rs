#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(any(target_os = "windows", test))]
mod geometry;
#[cfg(target_os = "windows")]
mod input;
#[cfg(target_os = "windows")]
mod menus;
#[cfg(any(target_os = "windows", test))]
mod session;
#[cfg(target_os = "windows")]
pub(super) use session::screen_state;
#[cfg(any(target_os = "windows", test))]
mod value_write;
#[cfg(target_os = "windows")]
mod window;

#[cfg(target_os = "windows")]
use enigo::Enigo;
#[cfg(target_os = "windows")]
use image::RgbaImage;

#[cfg(target_os = "windows")]
use self::ax::Win32Ax;
#[cfg(target_os = "windows")]
use super::ax::AxHandle;
#[cfg(target_os = "windows")]
use super::backend::{
	AxBackend, Backend, DeliveryMode, ElementDelivery, ElementInput, PointerEvent,
};
#[cfg(target_os = "windows")]
use super::control::OperationToken;
#[cfg(target_os = "windows")]
use super::error::{CoreResult, DesktopError};
#[cfg(target_os = "windows")]
use super::frame::FrameGeometry;
#[cfg(target_os = "windows")]
use super::keys::KeyName;
#[cfg(target_os = "windows")]
use super::types::{
	CaptureCaps, DesktopCapabilities, DesktopDisplay, DesktopWindow, DisplaySelector, ScreenState,
	Target,
};

#[cfg(target_os = "windows")]
pub(crate) struct Win32Backend {
	display:      DisplaySelector,
	global_input: Enigo,
	ax:           Win32Ax,
}

#[cfg(target_os = "windows")]
impl Win32Backend {
	pub(crate) fn new(display: DisplaySelector) -> CoreResult<Self> {
		// Initialize DPI awareness before xcap or input observes desktop
		// geometry, keeping both APIs in the same per-monitor physical
		// coordinate regime.
		let global_input = input::create_global_input()?;
		let _ = capture::displays()?;
		Ok(Self { display, global_input, ax: Win32Ax::new() })
	}
}

#[cfg(target_os = "windows")]
impl Backend for Win32Backend {
	fn capabilities(&mut self) -> DesktopCapabilities {
		let display_count =
			capture::displays().map_or(0, |displays| displays.len().min(u32::MAX as usize) as u32);
		let screen = self.screen_state(None);
		DesktopCapabilities {
			backend: "win32".to_string(),
			display_server: Some("win32".to_string()),
			capture: display_count > 0,
			input: true,
			ax: true,
			background_window_input: true,
			takeover: true,
			applications: super::applications::supported(),
			menus: true,
			held_input: true,
			spaces: false,
			global_escape: true,
			secure_input: false,
			secure_input_app: None,
			capture_permission: if display_count > 0 {
				"granted"
			} else {
				"unknown"
			}
			.to_string(),
			input_permission: "granted".to_string(),
			ax_permission: "granted".to_string(),
			display_count,
			screen_locked: screen.locked,
			display_asleep: screen.display_asleep,
		}
	}

	fn screen_state(&mut self, _: Option<&DisplaySelector>) -> ScreenState {
		session::screen_state(&self.display)
	}

	fn displays(&mut self) -> CoreResult<Vec<DesktopDisplay>> {
		capture::displays()
	}

	fn windows(&mut self) -> CoreResult<Vec<DesktopWindow>> {
		capture::windows()
	}

	fn capture(
		&mut self,
		target: &Target,
		_caps: &CaptureCaps,
		selector: Option<&DisplaySelector>,
	) -> CoreResult<(RgbaImage, FrameGeometry)> {
		let explicit = target.display_selector();
		capture::capture(selector.or(explicit.as_ref()).unwrap_or(&self.display), target)
	}

	fn pointer(
		&mut self,
		target: &Target,
		event: PointerEvent,
		_frame: &FrameGeometry,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::pointer(&mut self.global_input, &mut self.ax, target, event, mode)
	}

	fn type_text(
		&mut self,
		target: &Target,
		text: &str,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::type_text(target, text, mode)
	}

	fn key_chord(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::key_chord(&mut self.global_input, target, keys, mode)
	}

	/// Background keys go straight to the element's own control window,
	/// leaving the window's focus and the foreground alone: UI Automation's
	/// `SetFocus` would bring the window to the front, taking the user's
	/// keyboard. A windowless element (WPF, `WinUI`, web content) has no
	/// window to post to, so background input refuses. Takeover saves the
	/// user's foreground window, brings the target forward, and only then
	/// focuses the element and types through the foreground route.
	fn element_input(
		&mut self,
		element: &AxHandle,
		input: &ElementInput,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<ElementDelivery> {
		token.check()?;
		let windows = capture::windows()?;
		let id = self.ax.window_id(element, &windows)?;
		match mode {
			DeliveryMode::Background => {
				let own = Win32Ax::own_window(element)?.ok_or_else(|| {
					DesktopError::background_unavailable(format!(
						"this element of window {id} is drawn without a control window of its own, so \
						 background keys cannot address it, and focusing it would bring the window to \
						 the front; nothing was sent"
					))
				})?;
				input::element_background(&id, own, input)?;
			},
			DeliveryMode::Foreground | DeliveryMode::ForegroundReturnFocus => {
				input::element_foreground(&id, input, || self.ax.focus(element))?;
			},
		}
		Ok(ElementDelivery::Delivered)
	}

	fn hold_keys(
		&mut self,
		target: &Target,
		keys: &[KeyName],
		duration: std::time::Duration,
		mode: DeliveryMode,
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		input::hold_keys(&mut self.global_input, target, keys, duration, mode)
	}

	fn menu_items(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
	) -> CoreResult<Vec<super::menus::DesktopMenuItem>> {
		menus::items(window, path)
	}

	fn menu_select(
		&mut self,
		window: &DesktopWindow,
		path: &[String],
		token: &OperationToken,
	) -> CoreResult<()> {
		token.check()?;
		menus::select(window, path)
	}

	fn raise_window(&mut self, id: &str, token: &OperationToken) -> CoreResult<()> {
		token.check()?;
		input::raise_window(id)
	}

	fn ax(&mut self) -> Option<&mut dyn AxBackend> {
		Some(&mut self.ax)
	}
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
	use std::{
		io::{BufRead, BufReader, Write},
		process::{Child, Command, Stdio},
		time::Duration,
	};

	use windows_sys::Win32::{
		Foundation::HWND,
		UI::WindowsAndMessaging::{
			CW_USEDEFAULT, CreateWindowExW, DispatchMessageW, GetForegroundWindow, GetMessageW, MSG,
			SendMessageW, SetForegroundWindow, TranslateMessage, WM_GETTEXT, WS_OVERLAPPEDWINDOW,
			WS_VISIBLE,
		},
	};

	use super::*;
	use crate::desktop::control::CancellationSource;

	fn wide(text: &str) -> Vec<u16> {
		text.encode_utf16().chain(Some(0)).collect()
	}

	const USER: &str = "omp test: user window";
	const TARGET: &str = "omp test: takeover target";
	/// Set for the copy of this test binary that hosts the windows.
	const HOST: &str = "OMP_TAKEOVER_TEST_WINDOWS";

	/// Two top-level edit windows in another process, as another app's would
	/// be: the user's window and the takeover target. `windows()` leaves out
	/// this process's own windows, so a copy of this test binary running
	/// `takeover_test_windows` opens them and pumps their messages until it is
	/// killed. Their text is their title, which `windows()` needs to list them.
	struct Windows {
		user:   HWND,
		target: HWND,
		host:   Child,
	}

	impl Windows {
		fn open() -> Self {
			let mut host = Command::new(std::env::current_exe().unwrap())
				.args([
					"--ignored",
					"--exact",
					"desktop::win32::tests::takeover_test_windows",
					"--nocapture",
				])
				.env(HOST, "1")
				.stdout(Stdio::piped())
				.spawn()
				.unwrap();
			let line = BufReader::new(host.stdout.take().unwrap())
				.lines()
				.map_while(Result::ok)
				.find(|line| line.starts_with("windows "))
				.expect("the window host printed its windows");
			let mut handles = line
				.split(' ')
				.skip(1)
				.map(|handle| handle.parse::<usize>().unwrap());
			let (user, target) = (handles.next().unwrap(), handles.next().unwrap());
			Self { user: user as HWND, target: target as HWND, host }
		}

		fn text(window: HWND) -> String {
			let mut buffer = [0u16; 256];
			// SAFETY: `buffer` holds the length WM_GETTEXT is told.
			let length =
				unsafe { SendMessageW(window, WM_GETTEXT, buffer.len(), buffer.as_mut_ptr() as isize) };
			String::from_utf16_lossy(&buffer[..length as usize])
		}
	}

	impl Drop for Windows {
		fn drop(&mut self) {
			let _ = self.host.kill();
			let _ = self.host.wait();
		}
	}

	/// The window host `Windows::open` starts: opens both windows, prints their
	/// handles and pumps their messages until it is killed. Run any other way,
	/// it returns at once.
	#[test]
	#[ignore = "the window host of element_takeover_hands_the_foreground_back_to_the_users_window"]
	fn takeover_test_windows() {
		if std::env::var_os(HOST).is_none() {
			return;
		}
		let create = |title: &str| {
			let (class, text) = (wide("EDIT"), wide(title));
			// SAFETY: both strings are NUL-terminated and outlive the call;
			// EDIT is a system class, so no instance handle is needed.
			unsafe {
				CreateWindowExW(
					0,
					class.as_ptr(),
					text.as_ptr(),
					WS_OVERLAPPEDWINDOW | WS_VISIBLE,
					CW_USEDEFAULT,
					CW_USEDEFAULT,
					400,
					300,
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null(),
				)
			}
		};
		let (user, target) = (create(USER), create(TARGET));
		assert!(!user.is_null() && !target.is_null());
		println!("windows {} {}", user as usize, target as usize);
		std::io::stdout().flush().unwrap();
		// SAFETY: `message` is writable for each call.
		unsafe {
			let mut message: MSG = std::mem::zeroed();
			while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
				TranslateMessage(&message);
				DispatchMessageW(&message);
			}
		}
	}

	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn element_takeover_hands_the_foreground_back_to_the_users_window() {
		let windows = Windows::open();
		let mut backend = Win32Backend::new(DisplaySelector::Active).unwrap();
		let target = backend
			.windows()
			.unwrap()
			.into_iter()
			.find(|window| window.id == (windows.target as usize).to_string())
			.expect("the target window is listed");
		let element = backend.ax.window_root(&target).unwrap();
		let token = CancellationSource::default().token();
		for input in [
			ElementInput::Text("typed".to_string()),
			ElementInput::Chord(vec![KeyName::Home]),
			ElementInput::Text("x".to_string()),
		] {
			// SAFETY: a window handle this test created.
			unsafe { SetForegroundWindow(windows.user) };
			assert!(
				window::wait_for_foreground(windows.user, Duration::from_secs(2)).unwrap(),
				"this process cannot take the foreground; run it from a focused terminal"
			);
			backend
				.element_input(&element, &input, DeliveryMode::ForegroundReturnFocus, &token)
				.unwrap();
			// SAFETY: no preconditions.
			assert_eq!(unsafe { GetForegroundWindow() }, windows.user, "after {input:?}");
		}
		// Whether focusing an edit selects its text is the control's business;
		// the keys reached the target and nothing reached the user's window.
		let typed = Windows::text(windows.target);
		assert!(typed != TARGET && typed.contains('x'), "target text {typed:?}");
		assert_eq!(Windows::text(windows.user), USER);
	}
}
