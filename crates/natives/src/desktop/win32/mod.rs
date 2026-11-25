#[cfg(target_os = "windows")]
mod ax;
#[cfg(target_os = "windows")]
mod capture;
pub mod delivery;
#[cfg(any(target_os = "windows", test))]
mod geometry;
#[cfg(target_os = "windows")]
mod input;
#[cfg(any(target_os = "windows", test))]
mod keyboard;
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

	fn window_covered(&mut self, id: &str) -> bool {
		capture::window_covered(id)
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
		fmt::Write as _,
		io::{BufRead, BufReader, Write},
		process::{Child, ChildStdout, Command, Stdio},
		sync::Arc,
		time::Duration,
	};

	use windows_sys::Win32::{
		Foundation::HWND,
		UI::{
			Input::KeyboardAndMouse::VK_RETURN,
			WindowsAndMessaging::{
				CW_USEDEFAULT, CreateWindowExW, DispatchMessageW, ES_AUTOHSCROLL, FindWindowW,
				GetForegroundWindow, GetMessageW, MSG, PostMessageW, SPI_GETWHEELSCROLLCHARS,
				SPI_GETWHEELSCROLLLINES, SendMessageW, SetForegroundWindow, SystemParametersInfoW,
				TranslateMessage, WM_APP, WM_GETTEXT, WM_KEYDOWN, WM_SETTEXT, WS_OVERLAPPEDWINDOW,
				WS_VISIBLE,
			},
		},
	};

	use super::*;
	use crate::desktop::{
		Request, Response, Takeover, Worker,
		control::{self, CancellationSource},
		error::ErrorCode,
	};

	fn wide(text: &str) -> Vec<u16> {
		text.encode_utf16().chain(Some(0)).collect()
	}

	const USER: &str = "omp test: user window";
	const TARGET: &str = "omp test: takeover target";
	/// Set for the copy of this test binary that hosts the windows.
	const HOST: &str = "OMP_TAKEOVER_TEST_WINDOWS";

	/// Posted to the target window: once its thread reads the next key-down,
	/// it stops reading messages for `wParam` milliseconds, as a busy app's
	/// does, and the rest of the keys wait in its queue.
	const HANG: u32 = WM_APP;
	/// The target's Return moves the foreground to `wParam`.
	const RETURN_TO: u32 = WM_APP + 1;

	/// Two top-level edit windows in another process, as another app's would
	/// be: the user's window and the takeover target, each on its own thread.
	/// `windows()` leaves out this process's own windows, so a copy of this
	/// test binary running `takeover_test_windows` opens them and pumps their
	/// messages until it is killed. Their text is their title, which
	/// `windows()` needs to list them.
	struct Windows {
		user:        HWND,
		target:      HWND,
		host:        Child,
		output:      BufReader<ChildStdout>,
		editor:      HWND,
		editor_host: Option<Child>,
	}

	impl Windows {
		fn open() -> Self {
			Self::open_with_layout(false)
		}

		fn open_with_layout(editor: bool) -> Self {
			let mut host = Command::new(std::env::current_exe().unwrap())
				.args([
					"--ignored",
					"--exact",
					"desktop::win32::tests::takeover_test_windows",
					"--nocapture",
				])
				.env(HOST, "1")
				.env("OMP_TAKEOVER_TEST_LAYOUT", if editor { "1" } else { "" })
				.stdout(Stdio::piped())
				.spawn()
				.unwrap();
			let mut output = BufReader::new(host.stdout.take().unwrap());
			let line = (&mut output)
				.lines()
				.map_while(Result::ok)
				.find(|line| line.starts_with("windows "))
				.expect("the window host printed its windows");
			let mut handles = line
				.split(' ')
				.skip(1)
				.map(|handle| handle.parse::<usize>().unwrap());
			let (user, target) = (handles.next().unwrap(), handles.next().unwrap());
			let (editor, editor_host) = if editor {
				let mut child = Command::new(std::env::current_exe().unwrap())
					.args([
						"--ignored",
						"--exact",
						"desktop::win32::tests::takeover_test_windows",
						"--nocapture",
					])
					.env(HOST, "1")
					.env("OMP_TAKEOVER_TEST_LAYOUT", "1")
					.env("OMP_TAKEOVER_EDITOR_PARENT", target.to_string())
					.stdout(Stdio::piped())
					.spawn()
					.unwrap();
				output = BufReader::new(child.stdout.take().unwrap());
				let line = (&mut output)
					.lines()
					.map_while(Result::ok)
					.find(|line| line.starts_with("windows "))
					.unwrap();
				let editor = line.split(' ').nth(3).unwrap().parse::<usize>().unwrap();
				(editor, Some(child))
			} else {
				(0, None)
			};
			Self {
				user: user as HWND,
				target: target as HWND,
				host,
				output,
				editor: editor as HWND,
				editor_host,
			}
		}

		fn text(window: HWND) -> String {
			let mut buffer = [0u16; 1024];
			// SAFETY: `buffer` holds the length WM_GETTEXT is told.
			let length =
				unsafe { SendMessageW(window, WM_GETTEXT, buffer.len(), buffer.as_mut_ptr() as isize) };
			String::from_utf16_lossy(&buffer[..length as usize])
		}
	}

	impl Drop for Windows {
		fn drop(&mut self) {
			if let Some(editor) = &mut self.editor_host {
				let _ = editor.kill();
				let _ = editor.wait();
			}
			let _ = self.host.kill();
			let _ = self.host.wait();
		}
	}

	/// The window host `Windows::open` starts: opens both windows, prints their
	/// handles and pumps their messages until it is killed. Run any other way,
	/// it returns at once.
	#[test]
	#[ignore = "the window host of the takeover tests"]
	fn takeover_test_windows() {
		if std::env::var_os(HOST).is_none() {
			return;
		}
		fn create(title: &str) -> HWND {
			let (class, text) = (wide("EDIT"), wide(title));
			// SAFETY: both strings are NUL-terminated and outlive the call;
			// EDIT is a system class, so no instance handle is needed.
			unsafe {
				CreateWindowExW(
					0,
					class.as_ptr(),
					text.as_ptr(),
					WS_OVERLAPPEDWINDOW | WS_VISIBLE | ES_AUTOHSCROLL as u32,
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
		}
		/// Pumps this thread's messages; [`HANG`] stops it for a while at the
		/// next key-down.
		fn pump() {
			let mut hang = 0;
			let mut return_to = std::ptr::null_mut();
			// SAFETY: `message` is writable for each call.
			unsafe {
				let mut message: MSG = std::mem::zeroed();
				while GetMessageW(&mut message, std::ptr::null_mut(), 0, 0) > 0 {
					if message.message == HANG {
						hang = message.wParam as u64;
						continue;
					}
					if message.message == RETURN_TO {
						return_to = message.wParam as HWND;
						continue;
					}
					if message.message == WM_KEYDOWN && hang != 0 {
						std::thread::sleep(Duration::from_millis(hang));
						hang = 0;
					}
					if message.message == WM_KEYDOWN
						&& message.wParam == usize::from(VK_RETURN)
						&& !return_to.is_null()
					{
						SetForegroundWindow(return_to);
					}
					TranslateMessage(&message);
					DispatchMessageW(&message);
				}
			}
		}

		if let Ok(parent) = std::env::var("OMP_TAKEOVER_EDITOR_PARENT") {
			use windows_sys::Win32::UI::{
				Input::KeyboardAndMouse::{ActivateKeyboardLayout, LoadKeyboardLayoutW},
				WindowsAndMessaging::{RegisterClassW, WNDCLASSW, WS_CHILD},
			};
			let target = parent.parse::<usize>().unwrap() as HWND;
			// SAFETY: the class and layout strings outlive their calls.
			unsafe {
				let class = wide("omp layout receiver");
				let definition = WNDCLASSW {
					lpfnWndProc: Some(layout_receiver),
					lpszClassName: class.as_ptr(),
					..Default::default()
				};
				assert_ne!(RegisterClassW(&definition), 0);
				let layout = LoadKeyboardLayoutW(wide("00000407").as_ptr(), 0);
				assert!(!layout.is_null());
				assert!(!ActivateKeyboardLayout(layout, 0).is_null());
				let editor = CreateWindowExW(
					0,
					class.as_ptr(),
					wide("").as_ptr(),
					WS_CHILD | WS_VISIBLE,
					0,
					0,
					200,
					100,
					target,
					std::ptr::null_mut(),
					std::ptr::null_mut(),
					std::ptr::null(),
				);
				assert!(!editor.is_null());
				println!("windows 0 0 {}", editor as usize);
				std::io::stdout().flush().unwrap();
			}
			pump();
			return;
		}

		let (sender, receiver) = std::sync::mpsc::channel();
		std::thread::spawn(move || {
			let user = create(USER);
			sender.send(user as usize).unwrap();
			pump();
		});
		let user = receiver.recv().unwrap();
		let target = create(TARGET);
		assert!(user != 0 && !target.is_null());
		if std::env::var("OMP_TAKEOVER_TEST_LAYOUT").as_deref() == Ok("1") {
			use windows_sys::Win32::UI::{
				Input::KeyboardAndMouse::{ActivateKeyboardLayout, LoadKeyboardLayoutW},
				WindowsAndMessaging::{GWLP_WNDPROC, SetWindowLongPtrW},
			};
			// SAFETY: the layout string is NUL-terminated; this thread owns
			// the frame and the callback lives until exit.
			unsafe {
				ActivateKeyboardLayout(LoadKeyboardLayoutW(wide("00000409").as_ptr(), 0), 0);
				SetWindowLongPtrW(target, GWLP_WNDPROC, layout_receiver as *const () as isize);
			}
		}
		println!("windows {user} {}", target as usize);
		std::io::stdout().flush().unwrap();
		pump();
	}

	unsafe extern "system" fn layout_receiver(
		hwnd: HWND,
		message: u32,
		wparam: usize,
		lparam: isize,
	) -> isize {
		use windows_sys::Win32::UI::{
			Input::KeyboardAndMouse::{ActivateKeyboardLayout, LoadKeyboardLayoutW, SetFocus},
			WindowsAndMessaging::{DefWindowProcW, WM_APP, WM_CHAR, WM_INPUTLANGCHANGE},
		};
		match message {
			WM_APP => {
				// SAFETY: this callback runs on the window's owning thread.
				unsafe {
					if wparam == 0 {
						SetFocus(hwnd);
					} else {
						ActivateKeyboardLayout(LoadKeyboardLayoutW(wide("00000409").as_ptr(), 0), 0);
					}
				}
				0
			},
			WM_INPUTLANGCHANGE => 0,
			WM_CHAR => {
				println!("received {wparam}");
				std::io::stdout().flush().unwrap();
				0
			},
			// SAFETY: all arguments came from the window procedure.
			_ => unsafe { DefWindowProcW(hwnd, message, wparam, lparam) },
		}
	}

	#[test]
	#[ignore = "moves focus in a signed-in Windows desktop session"]
	fn takeover_keys_use_the_focused_child_threads_layout_after_focus() {
		use windows_sys::Win32::UI::WindowsAndMessaging::WM_APP;

		let mut windows = Windows::open_with_layout(true);
		// SAFETY: both handles belong to the host, and layout queries retain no
		// pointers.
		unsafe {
			use windows_sys::Win32::UI::{
				Input::KeyboardAndMouse::GetKeyboardLayout,
				WindowsAndMessaging::GetWindowThreadProcessId,
			};
			let frame =
				GetKeyboardLayout(GetWindowThreadProcessId(windows.target, std::ptr::null_mut()));
			let child =
				GetKeyboardLayout(GetWindowThreadProcessId(windows.editor, std::ptr::null_mut()));
			assert_eq!(frame as usize & 0xffff, 0x0409, "frame layout");
			assert_eq!(child as usize & 0xffff, 0x0407, "child layout");
		}
		// SAFETY: the window belongs to the test host.
		unsafe { SetForegroundWindow(windows.user) };
		assert!(window::wait_for_foreground(windows.user, Duration::from_secs(2)).unwrap());
		input::element_foreground(
			&(windows.target as usize).to_string(),
			&ElementInput::Chord(vec![KeyName::Char('?')]),
			|| {
				// SAFETY: the test callback focuses the child on its owning thread.
				unsafe { SendMessageW(windows.editor, WM_APP, 0, 0) };
				// SAFETY: the live frame's callback keeps its layout independent
				// from the focused child.
				unsafe { SendMessageW(windows.target, WM_APP, 1, 0) };
				assert_eq!(window::focused_descendant(windows.target), Some(windows.editor));
				// SAFETY: the frame remains live while its child has focus.
				unsafe {
					use windows_sys::Win32::UI::{
						Input::KeyboardAndMouse::GetKeyboardLayout,
						WindowsAndMessaging::GetWindowThreadProcessId,
					};
					let frame =
						GetKeyboardLayout(GetWindowThreadProcessId(windows.target, std::ptr::null_mut()));
					assert_eq!(frame as usize & 0xffff, 0x0409, "focused frame layout");
					let child =
						GetKeyboardLayout(GetWindowThreadProcessId(windows.editor, std::ptr::null_mut()));
					assert_eq!(child as usize & 0xffff, 0x0407, "focused child layout");
				}
				Ok(())
			},
		)
		.unwrap();
		let received = (&mut windows.output).lines().next().unwrap().unwrap();
		assert_eq!(received, format!("received {}", u32::from('?')));
		assert_eq!(Windows::text(windows.user), USER);
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
			// Both windows belong to the window host.
			let pid = Some(windows.host.id());
			assert_eq!(
				control::take_focus_return().map(|r| (r.handed_back, r.previous_pid, r.front_pid)),
				Some((true, pid, pid)),
				"after {input:?}"
			);
		}
		// Whether focusing an edit selects its text is the control's business;
		// the keys reached the target and nothing reached the user's window.
		let typed = Windows::text(windows.target);
		assert!(typed != TARGET && typed.contains('x'), "target text {typed:?}");
		assert_eq!(Windows::text(windows.user), USER);

		// With the target already in front nothing is handed back.
		// SAFETY: a window handle this test created.
		unsafe { SetForegroundWindow(windows.target) };
		assert!(window::wait_for_foreground(windows.target, Duration::from_secs(2)).unwrap());
		let input = ElementInput::Chord(vec![KeyName::End]);
		backend
			.element_input(&element, &input, DeliveryMode::ForegroundReturnFocus, &token)
			.unwrap();
		let pid = Some(windows.host.id());
		assert_eq!(
			control::take_focus_return().map(|r| (r.handed_back, r.previous_pid, r.front_pid)),
			Some((false, pid, pid))
		);
	}

	/// 240 characters, each block numbered so a dropped one shows.
	fn long_text() -> String {
		(0..30).fold(String::new(), |mut text, k| {
			let _ = write!(text, "t{k:03}-ab ");
			text
		})
	}

	/// Types [`long_text`] in takeover into the emptied target, whose thread
	/// stops reading messages for `hang` at the first key, starting with the
	/// user's window in front; returns the call's result and its unconfirmed
	/// report.
	fn type_into_busy_target(windows: &Windows, hang: Duration) -> (CoreResult<()>, Option<String>) {
		let mut backend = Win32Backend::new(DisplaySelector::Active).unwrap();
		let empty = wide("");
		// SAFETY: WM_SETTEXT copies the NUL-terminated string before it
		// returns; the handles are windows this test's host created.
		unsafe {
			SendMessageW(windows.target, WM_SETTEXT, 0, empty.as_ptr() as isize);
			SetForegroundWindow(windows.user);
		}
		assert!(
			window::wait_for_foreground(windows.user, Duration::from_secs(2)).unwrap(),
			"this process cannot take the foreground; run it from a focused terminal"
		);
		// SAFETY: posts a plain message to a window this test's host created.
		unsafe { PostMessageW(windows.target, HANG, usize::try_from(hang.as_millis()).unwrap(), 0) };
		let token = CancellationSource::default().token();
		control::take_text_unconfirmed();
		let result = backend.type_text(
			&Target::Window((windows.target as usize).to_string()),
			&long_text(),
			DeliveryMode::ForegroundReturnFocus,
			&token,
		);
		(result, control::take_text_unconfirmed())
	}

	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn takeover_typing_hands_the_foreground_back_once_a_busy_target_read_the_text() {
		let windows = Windows::open();
		let (result, unconfirmed) = type_into_busy_target(&windows, Duration::from_millis(1500));
		result.unwrap();
		assert_eq!(unconfirmed, None);
		// SAFETY: no preconditions.
		assert_eq!(unsafe { GetForegroundWindow() }, windows.user);
		// The target read every key before the foreground went back: none
		// reached the user's window.
		assert_eq!(Windows::text(windows.target), long_text());
		assert_eq!(Windows::text(windows.user), USER);
	}

	fn type_with_return_moving_foreground(text: &str) -> Option<String> {
		let windows = Windows::open();
		let mut backend = Win32Backend::new(DisplaySelector::Active).unwrap();
		let empty = wide("");
		// SAFETY: these handles belong to the test host; WM_SETTEXT copies
		// the string synchronously and RETURN_TO carries a window handle.
		unsafe {
			SendMessageW(windows.target, WM_SETTEXT, 0, empty.as_ptr() as isize);
			PostMessageW(windows.target, RETURN_TO, windows.user as usize, 0);
			SetForegroundWindow(windows.user);
		}
		assert!(
			window::wait_for_foreground(windows.user, Duration::from_secs(2)).unwrap(),
			"this process cannot take the foreground; run it from a focused terminal"
		);
		let token = CancellationSource::default().token();
		control::take_text_unconfirmed();
		backend
			.type_text(
				&Target::Window((windows.target as usize).to_string()),
				text,
				DeliveryMode::ForegroundReturnFocus,
				&token,
			)
			.unwrap();
		let unconfirmed = control::take_text_unconfirmed();
		// SAFETY: no preconditions.
		assert_eq!(unsafe { GetForegroundWindow() }, windows.user);
		if text.ends_with('\n') {
			assert_eq!(Windows::text(windows.target), "submitted");
			assert_eq!(Windows::text(windows.user), USER);
		}
		unconfirmed
	}

	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn takeover_typing_does_not_report_foreground_moved_by_its_closing_return() {
		assert_eq!(type_with_return_moving_foreground("submitted\n"), None);
	}

	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn takeover_typing_reports_foreground_moved_by_a_mid_text_return() {
		let reason = type_with_return_moving_foreground("submitted\nremaining")
			.expect("a mid-text Return cannot confirm the remaining text arrived");
		assert!(reason.contains("foreground left"), "{reason}");
	}

	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn takeover_typing_into_a_hung_target_says_the_text_is_unconfirmed() {
		let windows = Windows::open();
		let (result, unconfirmed) = type_into_busy_target(&windows, Duration::from_secs(8));
		result.unwrap();
		// The 5 s wait runs out, or Windows puts a ghost window in front of
		// the hung one first.
		let reason = unconfirmed.expect("the call reported the text unconfirmed");
		assert!(reason.contains("read all the typed text"), "{reason}");
	}

	const MARK: u32 = WM_APP + 7;
	const GROW: u32 = WM_APP + 11;
	const CHROMIUM: u32 = WM_APP + 12;
	const PIN_ACROSS: u32 = WM_APP + 13;
	/// The fixture activates its own windows: it owns the foreground, so
	/// Windows lets it, where a test process outside the foreground is refused.
	const FRONT: u32 = WM_APP + 14;
	const BACK: u32 = WM_APP + 15;
	const SWAP: u32 = WM_APP + 16;
	const WPF_LIST: &str = r#"
Add-Type -ReferencedAssemblies PresentationFramework,PresentationCore,WindowsBase,System.Xaml,UIAutomationProvider,UIAutomationTypes,WindowsFormsIntegration,System.Windows.Forms,System.Drawing -TypeDefinition @'
using System; using System.Windows; using System.Windows.Controls; using System.Windows.Interop;
using System.Windows.Automation; using System.Windows.Automation.Peers; using System.Windows.Automation.Provider;
using System.Runtime.InteropServices; using System.Collections.Generic;
public class WheelMarker : System.Windows.Forms.NativeWindow {
	public static int Wheels;
	protected override void WndProc(ref System.Windows.Forms.Message message) {
		if (message.Msg == 0x020A || message.Msg == 0x020E) Wheels++;
		base.WndProc(ref message);
	}
}
public class DecorativeHost : HwndHost {
	delegate IntPtr WindowProc(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
	struct WindowClass {
		public uint style; public WindowProc procedure; public int classExtra, windowExtra;
		public IntPtr instance, icon, cursor, background, menu;
		[MarshalAs(UnmanagedType.LPWStr)] public string name;
	}
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern ushort RegisterClass(ref WindowClass value);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(int ex, string kind, string title, int style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr parameter);
	[DllImport("user32.dll")] static extern bool DestroyWindow(IntPtr hwnd);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr DefWindowProc(IntPtr hwnd, uint message, IntPtr w, IntPtr l);
	[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
	static WindowProc procedure = DefWindowProc;
	static IntPtr instance = GetModuleHandle(null);
	IntPtr chromium;
	protected override HandleRef BuildWindowCore(HandleRef parent) {
		var kind = new WindowClass { procedure = procedure, instance = instance, name = "Chrome_RenderWidgetHostHWND" };
		if (RegisterClass(ref kind) == 0) throw new Exception("register synthetic Chromium class");
		var hwnd = CreateWindowEx(0, "STATIC", "", 0x50000000, 0, 0, 80, 50, parent.Handle, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
		if (hwnd == IntPtr.Zero) throw new Exception("create decorative STATIC");
		return new HandleRef(this, hwnd);
	}
	public void ToggleChromium() {
		if (chromium != IntPtr.Zero) { DestroyWindow(chromium); chromium = IntPtr.Zero; return; }
		chromium = CreateWindowEx(0, "Chrome_RenderWidgetHostHWND", "", 0x50000000, 0, 0, 10, 10, Handle, IntPtr.Zero, instance, IntPtr.Zero);
		if (chromium == IntPtr.Zero) throw new Exception("create synthetic Chromium child");
	}
	protected override void DestroyWindowCore(HandleRef hwnd) { DestroyWindow(hwnd.Handle); }
}
public class TestList : ListBox { protected override AutomationPeer OnCreateAutomationPeer() { return new TestPeer(this); } }
public class TestPeer : ListBoxAutomationPeer, IScrollProvider {
	public TestPeer(ListBox owner) : base(owner) {}
	IScrollProvider Inner { get { return (IScrollProvider)base.GetPattern(PatternInterface.Scroll); } }
	public override object GetPattern(PatternInterface pattern) { return pattern == PatternInterface.Scroll ? this : base.GetPattern(pattern); }
	public void Scroll(ScrollAmount across, ScrollAmount down) { if (!Fixture.Grow()) Inner.Scroll(across, down); if (across != ScrollAmount.NoAmount) Fixture.Swap(Inner); }
	public void SetScrollPercent(double across, double down) { Inner.SetScrollPercent(across, down); }
	public double HorizontalScrollPercent { get { return Inner.HorizontalScrollPercent; } }
	public double VerticalScrollPercent { get { return Inner.VerticalScrollPercent; } }
	public double HorizontalViewSize { get { return Inner.HorizontalViewSize; } }
	public double VerticalViewSize { get { return Inner.VerticalViewSize; } }
	public bool HorizontallyScrollable { get { return Inner.HorizontallyScrollable; } }
	public bool VerticallyScrollable { get { return Inner.VerticallyScrollable; } }
}
public static class Fixture {
	static ListBox list, page2; static System.Windows.Forms.ListBox hosted;
	static DecorativeHost decorative;
	delegate bool EnumChild(IntPtr hwnd, IntPtr parameter);
	[DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr hwnd, EnumChild callback, IntPtr parameter);
	static Dictionary<IntPtr, WheelMarker> markers = new Dictionary<IntPtr, WheelMarker>();
	static void MarkChildren(IntPtr root) {
		EnumChildWindows(root, (hwnd, parameter) => {
			if (!markers.ContainsKey(hwnd)) { var marker = new WheelMarker(); marker.AssignHandle(hwnd); markers.Add(hwnd, marker); }
			return true;
		}, IntPtr.Zero);
	}
	static bool grow, swap; static double offset, across, page2Offset; static Window other;
	static int calls;
	public static bool Grow() {
		calls++; if (!grow) return false;
		grow = false; var count = list.Items.Count;
		for (var row = count + 1; row <= count + 60; row++) list.Items.Add("Row " + row);
		list.UpdateLayout();
		return true;
	}
	public static void Swap(IScrollProvider inner) {
		if (!swap) return;
		list.UpdateLayout();
		if (inner.HorizontalScrollPercent > 0) return;
		swap = false; page2.Visibility = Visibility.Visible; page2.UpdateLayout();
	}
	static IntPtr Hook(IntPtr hwnd, int message, IntPtr w, IntPtr l, ref bool handled) {
		if (message == 0x020A || message == 0x020E) { Console.WriteLine("wheel"); Console.Out.Flush(); }
		else if (message == 0x8007) {
			list.UpdateLayout();
			Console.WriteLine("{0} {1} {2} {3} {4} {5} {6}", offset, list.Items.Count, hosted.TopIndex, calls, across, WheelMarker.Wheels, page2Offset);
			Console.Out.Flush();
		}
		else if (message == 0x800B) grow = true;
		else if (message == 0x800C) { decorative.ToggleChromium(); MarkChildren(hwnd); }
		else if (message == 0x800E) Window.GetWindow(HwndSource.FromHwnd(hwnd).RootVisual).Activate();
		else if (message == 0x800F) other.Activate();
		else if (message == 0x800D) { ((IScrollProvider)UIElementAutomationPeer.CreatePeerForElement(list).GetPattern(PatternInterface.Scroll)).SetScrollPercent(100, -1); list.UpdateLayout(); }
		else if (message == 0x8010) swap = true;
		return IntPtr.Zero; }
	public static void Run() {
		list = new TestList();
		page2 = new ListBox { Visibility = Visibility.Hidden };
		ScrollViewer.SetCanContentScroll(page2, true);
		VirtualizingPanel.SetScrollUnit(page2, ScrollUnit.Item);
		for (var row = 1; row <= 60; row++) page2.Items.Add("Page 2 row " + row);
		page2.AddHandler(ScrollViewer.ScrollChangedEvent, new ScrollChangedEventHandler((sender, e) => { page2Offset = e.VerticalOffset; }));
		hosted = new System.Windows.Forms.ListBox { IntegralHeight = false };
		for (var row = 1; row <= 60; row++) { list.Items.Add("Row " + row + new string('x', 100)); hosted.Items.Add("Hosted " + row); }
		ScrollViewer.SetHorizontalScrollBarVisibility(list, ScrollBarVisibility.Auto);
		list.AddHandler(ScrollViewer.ScrollChangedEvent, new ScrollChangedEventHandler((sender, e) => { offset = e.VerticalOffset; across = e.HorizontalOffset; }));
		var panel = new DockPanel(); var header = new DockPanel { Height = 50, LastChildFill = false };
		decorative = new DecorativeHost { Width = 80, Height = 50 };
		DockPanel.SetDock(decorative, Dock.Right); header.Children.Add(decorative);
		DockPanel.SetDock(header, Dock.Top); panel.Children.Add(header);
		var host = new System.Windows.Forms.Integration.WindowsFormsHost { Width = 120, Child = hosted };
		DockPanel.SetDock(host, Dock.Right); panel.Children.Add(host);
		var pages = new Grid(); pages.Children.Add(list); pages.Children.Add(page2); panel.Children.Add(pages);
		var window = new Window { Title = "omp test: wpf list", Left = 40, Top = 40, Width = 420, Height = 240, Content = panel };
		other = new Window { Title = "omp test: wpf other", Left = 500, Top = 40, Width = 240, Height = 160 };
		window.SourceInitialized += (sender, e) => HwndSource.FromHwnd(new WindowInteropHelper(window).Handle).AddHook(Hook);
		window.ContentRendered += (sender, e) => { MarkChildren(new WindowInteropHelper(window).Handle); other.Show(); Console.WriteLine("ready"); Console.Out.Flush(); };
		window.ShowDialog(); }
}
'@
[Fixture]::Run()
"#;
	struct WpfList {
		host:   Child,
		output: std::io::Lines<BufReader<ChildStdout>>,
		window: HWND,
		other:  HWND,
	}
	impl WpfList {
		fn open() -> Self {
			let mut host = Command::new("powershell")
				.args(["-NoProfile", "-Command", WPF_LIST])
				.stdout(Stdio::piped())
				.spawn()
				.unwrap();
			let output = BufReader::new(host.stdout.take().unwrap()).lines();
			let mut list =
				Self { host, output, window: std::ptr::null_mut(), other: std::ptr::null_mut() };
			assert_eq!(list.output.next().unwrap().unwrap(), "ready");
			// SAFETY: both titles are NUL-terminated and outlive these calls.
			unsafe {
				list.window = FindWindowW(std::ptr::null(), wide("omp test: wpf list").as_ptr());
				list.other = FindWindowW(std::ptr::null(), wide("omp test: wpf other").as_ptr());
			}
			assert!(!list.window.is_null() && !list.other.is_null());
			list
		}

		fn post(&self, message: u32) {
			// SAFETY: a plain message to a window this fixture owns.
			assert_ne!(unsafe { PostMessageW(self.window, message, 0, 0) }, 0);
		}

		fn state(&mut self) -> [f64; 7] {
			self.post(MARK);
			// MARK is a queue barrier: every native child counts wheels, and
			// an unexpected root wheel marker fails this parse.
			let line = self.output.next().unwrap().unwrap();
			let mut values = line.split_whitespace();
			std::array::from_fn(|_| values.next().unwrap().parse().unwrap())
		}
	}
	impl Drop for WpfList {
		fn drop(&mut self) {
			let _ = self.host.kill();
			let _ = self.host.wait();
		}
	}
	#[test]
	#[ignore = "moves the foreground between windows it opens; run with --ignored from a focused \
	            terminal in a signed-in desktop session"]
	fn wpf_scrolls_go_through_ui_automation_in_front_and_report_what_moved() {
		let _serial = control::OWNERSHIP_TEST.lock();
		const OFFSET: usize = 0;
		const ROWS: usize = 1;
		const HOSTED: usize = 2;
		const CALLS: usize = 3;
		const ACROSS: usize = 4;
		const NATIVE_WHEELS: usize = 5;
		const PAGE2_OFFSET: usize = 6;
		let mut list = WpfList::open();
		let mut worker = Worker::new(DisplaySelector::Active, Arc::default(), Arc::default());
		let token = CancellationSource::default().token();
		let target = Target::Window(list.window.expose_provenance().to_string());
		let mut per_notch = 3_u32;
		let mut characters = 3_u32;
		// SAFETY: this action writes one u32 to the pointer given.
		unsafe {
			SystemParametersInfoW(SPI_GETWHEELSCROLLLINES, 0, (&raw mut per_notch).cast(), 0);
			SystemParametersInfoW(SPI_GETWHEELSCROLLCHARS, 0, (&raw mut characters).cast(), 0);
		}
		assert!((1..=20).contains(&per_notch), "the test needs 1 to 20 wheel lines per notch");
		assert!(characters > 0, "the test needs horizontal wheel scrolling enabled");
		// SAFETY: GetForegroundWindow has no preconditions.
		let foreground = || unsafe { GetForegroundWindow() };
		assert!(window::wait_for_foreground(list.other, Duration::from_secs(2)).unwrap());
		let request = Request::Capture {
			target: target.clone(),
			caps:   CaptureCaps::default(),
			reply:  flume::unbounded().0,
		};
		let Response::Capture(frame) = worker.execute(&request, &token).unwrap() else {
			panic!("expected capture")
		};
		let (width, height) = (f64::from(frame.coordinate_width), f64::from(frame.coordinate_height));
		let (x, y) = (width / 3.0, height / 2.0);
		let mut scroll = |x, y, (dx, dy), takeover| {
			let request = Request::Scroll {
				target: target.clone(),
				x,
				y,
				dx,
				dy,
				takeover: Takeover::new(takeover, None),
				reply: flume::unbounded().0,
			};
			worker.execute(&request, &token).map(drop)
		};
		let initial = list.state();
		let error = scroll(x, y, (0.0, 27_400.0), None).unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable, "{error}");
		assert_eq!(list.state(), initial);
		assert_eq!(foreground(), list.other);
		scroll(width * 0.85, y, (0.0, 100.0), None).unwrap();
		let hosted = list.state();
		assert!(hosted[HOSTED] > initial[HOSTED]);
		assert_eq!(hosted[OFFSET], initial[OFFSET]);
		assert_eq!(hosted[CALLS], initial[CALLS]);
		assert!(hosted[NATIVE_WHEELS] > initial[NATIVE_WHEELS]);
		assert_eq!(foreground(), list.other);
		// A synthetic Chromium-class descendant exercises root admission,
		// not a real WebView2 provider.
		list.post(CHROMIUM);
		assert_eq!(list.state(), hosted);
		assert!(window::has_chromium_descendant(list.window));
		let error = scroll(width * 0.85, y, (0.0, 100.0), None).unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable, "{error}");
		assert_eq!(list.state(), hosted);
		assert_eq!(foreground(), list.other);
		// No wheel steps: nothing is sent, so nothing is refused or taken over.
		scroll(x, y, (0.0, 0.0), None).unwrap();
		assert_eq!(list.state(), hosted);
		assert_eq!(foreground(), list.other);
		list.post(CHROMIUM);
		assert_eq!(list.state(), hosted);
		assert!(!window::has_chromium_descendant(list.window));
		list.post(FRONT);
		assert!(window::wait_for_foreground(list.window, Duration::from_secs(2)).unwrap());
		let before = list.state();
		let error = scroll(x, y, (100.0, 27_400.0), None).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed, "{error}");
		assert_eq!(list.state(), before, "neither axis may scroll an oversized request");
		scroll(x, y, (100.0, 0.0), None).unwrap();
		let across = list.state();
		assert!(across[ACROSS] > initial[ACROSS]);
		assert_eq!(across[OFFSET], initial[OFFSET]);
		assert!(across[CALLS] > initial[CALLS]);
		scroll(x, y, (0.0, 100.0), None).unwrap();
		let moved = list.state();
		assert_eq!(moved[OFFSET], initial[OFFSET] + f64::from(per_notch));
		assert!(moved[CALLS] > initial[CALLS]);
		let error = scroll(x, height * 0.2, (0.0, 100.0), None).unwrap_err();
		assert_eq!(error.code, ErrorCode::BackgroundUnavailable, "{error}");
		assert_eq!(list.state(), moved);
		assert_eq!(foreground(), list.window);
		list.post(PIN_ACROSS);
		let pinned = list.state();
		assert!(pinned[ACROSS] > moved[ACROSS]);
		assert_eq!(pinned[OFFSET], moved[OFFSET]);
		scroll(x, y, (100.0, 100.0), None).unwrap();
		let mixed = list.state();
		assert_eq!(mixed[ACROSS], pinned[ACROSS]);
		assert_eq!(mixed[OFFSET], pinned[OFFSET] + f64::from(per_notch));
		assert!(mixed[CALLS] > pinned[CALLS]);
		scroll(x, y, (0.0, 27_300.0), None).unwrap();
		let end = list.state();
		assert!(end[OFFSET] > moved[OFFSET]);
		let error = scroll(x, y, (0.0, 100.0), None).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed, "{error}");
		assert_eq!(list.state(), end);
		list.post(GROW);
		assert_eq!(list.state(), end);
		// Rows added during a step move the scroll percentage but not the
		// offset: the step did not move, and is not reported as moved.
		let error = scroll(x, y, (0.0, -100.0), None).unwrap_err();
		assert_eq!(error.code, ErrorCode::InputFailed, "{error}");
		let grown = list.state();
		assert_eq!(grown[OFFSET], end[OFFSET]);
		assert_eq!(grown[ROWS], 120.0);
		assert_eq!(grown[CALLS], end[CALLS] + 1.0);
		list.post(BACK);
		assert!(window::wait_for_foreground(list.other, Duration::from_secs(2)).unwrap());
		scroll(x, y, (0.0, -100.0), Some(true)).unwrap();
		assert_eq!(list.output.next().unwrap().unwrap(), "wheel");
		let wheel = list.state();
		assert_eq!(wheel[OFFSET], grown[OFFSET] - f64::from(per_notch));
		assert_eq!(wheel[CALLS], grown[CALLS]);
		assert_eq!(foreground(), list.other);
		list.post(FRONT);
		assert!(window::wait_for_foreground(list.window, Duration::from_secs(2)).unwrap());
		let before_swap = list.state();
		assert!(before_swap[ACROSS] > 0.0);
		list.post(SWAP);
		let result = scroll(x, y, (-27_300.0, 100.0), None);
		let swapped = list.state();
		assert_eq!(swapped[ACROSS], 0.0, "the horizontal axis must reach the left edge");
		assert_eq!(
			swapped[PAGE2_OFFSET],
			before_swap[PAGE2_OFFSET] + f64::from(per_notch),
			"the vertical axis must scroll the page now under the point: {result:?}"
		);
		assert_eq!(swapped[OFFSET], before_swap[OFFSET], "the covered page must not scroll");
		result.unwrap();
	}
}
