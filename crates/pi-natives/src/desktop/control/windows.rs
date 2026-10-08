//! Low-level physical Escape observation, with an event-driven message loop.
use std::{
	cell::RefCell,
	thread::{self, JoinHandle},
};

use windows_sys::Win32::{
	Foundation::{LPARAM, LRESULT, WPARAM},
	System::Threading::GetCurrentThreadId,
	UI::{
		Input::KeyboardAndMouse::VK_ESCAPE,
		WindowsAndMessaging::{
			CallNextHookEx, GetMessageW, KBDLLHOOKSTRUCT, LLKHF_INJECTED, MSG, PM_NOREMOVE,
			PeekMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx, WH_KEYBOARD_LL,
			WM_KEYDOWN, WM_QUIT, WM_SYSKEYDOWN,
		},
	},
};

use super::{CoreResult, DesktopError, EmergencyStop};

thread_local! { static STOP: RefCell<Option<EmergencyStop>> = const { RefCell::new(None) }; }

unsafe extern "system" fn observe(code: i32, message: WPARAM, data: LPARAM) -> LRESULT {
	if code >= 0 && (message == WM_KEYDOWN as usize || message == WM_SYSKEYDOWN as usize) {
		// SAFETY: a nonnegative keyboard hook callback provides this structure.
		let key = unsafe { &*(data as *const KBDLLHOOKSTRUCT) };
		if key.vkCode == u32::from(VK_ESCAPE) && key.flags & LLKHF_INJECTED == 0 {
			STOP.with_borrow(|stop| {
				if let Some(stop) = stop {
					stop.cancel();
				}
			});
		}
	}
	// SAFETY: forward the original callback unchanged; never swallow Escape.
	unsafe { CallNextHookEx(std::ptr::null_mut(), code, message, data) }
}

pub(super) struct EscapeMonitor {
	thread: Option<JoinHandle<()>>,
	id:     u32,
}

impl EscapeMonitor {
	pub(super) fn start(stop: EmergencyStop) -> CoreResult<Self> {
		let (ready, receive) = flume::bounded(1);
		let worker = thread::Builder::new()
			.name("desktop-escape".into())
			.spawn(move || {
				STOP.with_borrow_mut(|slot| *slot = Some(stop));
				// SAFETY: this hook callback is process-lived and uses no DLL
				// state.
				let hook =
					unsafe { SetWindowsHookExW(WH_KEYBOARD_LL, Some(observe), std::ptr::null_mut(), 0) };
				if hook.is_null() {
					let _ = ready.send(None);
					return;
				}
				// SAFETY: MSG is plain integer/pointer storage; PeekMessage ensures
				// the queue exists before the owner may post its teardown wake.
				let mut message: MSG = unsafe { std::mem::zeroed() };
				// SAFETY: message is writable storage owned by this thread; a null
				// HWND with no filter only creates/inspects this thread's queue.
				unsafe {
					PeekMessageW(&raw mut message, std::ptr::null_mut(), 0, 0, PM_NOREMOVE);
				}
				// SAFETY: GetCurrentThreadId has no preconditions.
				let _ = ready.send(Some(unsafe { GetCurrentThreadId() }));
				loop {
					// SAFETY: writable message storage, no filter; WM_QUIT wakes it.
					let status = unsafe { GetMessageW(&raw mut message, std::ptr::null_mut(), 0, 0) };
					if status <= 0 {
						if status < 0 {
							STOP.with_borrow(|stop| {
								if let Some(stop) = stop {
									stop.cancel();
								}
							});
						}
						break;
					}
				}
				// SAFETY: this thread owns the installed hook.
				unsafe {
					UnhookWindowsHookEx(hook);
				}
				STOP.with_borrow_mut(|slot| *slot = None);
			})
			.map_err(|error| {
				DesktopError::input_failed(format!("cannot start emergency Escape monitor: {error}"))
			})?;
		let Some(id) = receive.recv().ok().flatten() else {
			let _ = worker.join();
			return Err(DesktopError::permission_denied(
				"cannot install the physical Escape monitor; desktop control was not granted",
			));
		};
		Ok(Self { thread: Some(worker), id })
	}
}

impl Drop for EscapeMonitor {
	fn drop(&mut self) {
		// SAFETY: this id is the dedicated monitor thread; it retains no input.
		unsafe {
			PostThreadMessageW(self.id, WM_QUIT, 0, 0);
		}
		if let Some(worker) = self.thread.take()
			&& worker.thread().id() != thread::current().id()
		{
			let _ = worker.join();
		}
	}
}
