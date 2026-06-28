// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

use std::cell::Cell;

use windows_sys::{
	Win32::{
		Foundation::{CloseHandle, HANDLE, WAIT_FAILED, WAIT_OBJECT_0},
		System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE, WaitForSingleObject},
	},
	core::BOOL,
};

pub type Pid = u32;

pub struct ProcessChecker {
	dead:   Cell<bool>,
	handle: HANDLE,
}

impl ProcessChecker {
	pub fn new(process_id: Pid) -> Self {
		#[allow(non_snake_case)]
		let FALSE: BOOL = 0;
		let h = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, FALSE, process_id) };
		Self { dead: Cell::new(h.is_null()), handle: h }
	}

	pub fn is_dead(&self) -> bool {
		if !self.dead.get() {
			self.dead.set(unsafe {
				let status = WaitForSingleObject(self.handle, 0);
				status == WAIT_OBJECT_0 || status == WAIT_FAILED
			});
		}

		self.dead.get()
	}
}

impl Drop for ProcessChecker {
	fn drop(&mut self) {
		unsafe {
			CloseHandle(self.handle);
		}
	}
}

pub fn supports_pid_checks(_pid: Pid) -> bool {
	true
}
