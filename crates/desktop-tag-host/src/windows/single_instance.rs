use std::{
	ffi::c_void,
	io::{BufRead, BufReader, Read, Write},
	mem::size_of,
	ptr,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread,
};

use anyhow::{Context, Result, bail};
use windows_sys::Win32::{
	Foundation::{
		CloseHandle, ERROR_ALREADY_EXISTS, GENERIC_READ, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
		LocalFree,
	},
	Security::{
		Authorization::{
			ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
			SDDL_REVISION_1,
		},
		GetTokenInformation, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER, TokenUser,
	},
	Storage::FileSystem::{CreateFileW, FILE_ATTRIBUTE_NORMAL, OPEN_EXISTING, PIPE_ACCESS_DUPLEX},
	System::{
		Pipes::{
			ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_MESSAGE,
			PIPE_TYPE_MESSAGE, PIPE_WAIT,
		},
		Threading::{CreateMutexW, GetCurrentProcess, OpenProcessToken},
	},
};

use super::wide;
use crate::protocol::{ControlRequest, ControlResponse};

const MAX_MESSAGE: usize = 4096;

pub struct InstanceGuard {
	handle:  HANDLE,
	pub sid: String,
}

impl InstanceGuard {
	pub fn acquire() -> Result<Option<Self>> {
		let sid = current_user_sid()?;
		let name = wide(&format!("Local\\OhMyPi.DesktopTag.{sid}"));
		let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
		if handle.is_null() {
			return Err(std::io::Error::last_os_error()).context("create Desktop Tag mutex");
		}
		if unsafe { windows_sys::Win32::Foundation::GetLastError() } == ERROR_ALREADY_EXISTS {
			unsafe { CloseHandle(handle) };
			return Ok(None);
		}
		Ok(Some(Self { handle, sid }))
	}
}

impl Drop for InstanceGuard {
	fn drop(&mut self) {
		unsafe { CloseHandle(self.handle) };
	}
}

pub fn pipe_name(sid: &str) -> String {
	format!(r"\\.\pipe\ompk-desktop-tag-{sid}")
}

pub fn forward(sid: &str, request: &ControlRequest) -> Result<ControlResponse> {
	let name = wide(&pipe_name(sid));
	let handle = unsafe {
		CreateFileW(
			name.as_ptr(),
			GENERIC_READ | GENERIC_WRITE,
			0,
			ptr::null(),
			OPEN_EXISTING,
			FILE_ATTRIBUTE_NORMAL,
			ptr::null_mut(),
		)
	};
	if handle == INVALID_HANDLE_VALUE {
		return Err(std::io::Error::last_os_error()).context("connect to running Desktop Tag host");
	}
	let mut file = unsafe { std::fs::File::from_raw_handle(handle) };
	serde_json::to_writer(&mut file, request)?;
	file.write_all(b"\n")?;
	file.flush()?;
	let mut response = String::new();
	BufReader::new(file)
		.take(MAX_MESSAGE as u64)
		.read_line(&mut response)?;
	Ok(serde_json::from_str(&response)?)
}

pub struct PipeServer {
	name:    String,
	thread:  Option<thread::JoinHandle<()>>,
	stopped: Arc<AtomicBool>,
}

impl PipeServer {
	pub fn start(
		sid: &str,
		handler: Arc<dyn Fn(ControlRequest) -> ControlResponse + Send + Sync>,
	) -> Result<Self> {
		let name = pipe_name(sid);
		let thread_name = name.clone();
		let sid = sid.to_owned();
		let stopped = Arc::new(AtomicBool::new(false));
		let thread_stopped = Arc::clone(&stopped);
		let thread = thread::Builder::new()
			.name("desktop-tag-control".into())
			.spawn(move || serve(&thread_name, &sid, &handler, &thread_stopped))?;
		Ok(Self { name, thread: Some(thread), stopped })
	}
}

impl Drop for PipeServer {
	fn drop(&mut self) {
		self.stopped.store(true, Ordering::Release);
		if let Ok(mut wake) = std::fs::OpenOptions::new()
			.read(true)
			.write(true)
			.open(&self.name)
		{
			let _ = wake.write_all(b"\n");
		}
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

fn serve(
	name: &str,
	sid: &str,
	handler: &Arc<dyn Fn(ControlRequest) -> ControlResponse + Send + Sync>,
	stopped: &AtomicBool,
) {
	while !stopped.load(Ordering::Acquire) {
		let Ok(pipe) = create_pipe(name, sid) else {
			return;
		};
		let connected = unsafe { ConnectNamedPipe(pipe, ptr::null_mut()) };
		if connected == 0 {
			let error = std::io::Error::last_os_error()
				.raw_os_error()
				.unwrap_or_default() as u32;
			if error != windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED {
				unsafe { CloseHandle(pipe) };
				continue;
			}
		}
		let mut file = unsafe { std::fs::File::from_raw_handle(pipe) };
		let mut data = String::new();
		let result = BufReader::new(&mut file)
			.take(MAX_MESSAGE as u64 + 1)
			.read_line(&mut data);
		if result.is_ok() && data.len() <= MAX_MESSAGE && !data.is_empty() {
			if let Ok(request) = serde_json::from_str::<ControlRequest>(&data) {
				let response = handler(request);
				if serde_json::to_writer(&mut file, &response).is_ok() {
					let _ = file.write_all(b"\n");
				}
			}
		}
		unsafe { DisconnectNamedPipe(pipe) };
	}
}

fn create_pipe(name: &str, sid: &str) -> Result<HANDLE> {
	let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
	let mut descriptor: *mut c_void = ptr::null_mut();
	let converted = unsafe {
		ConvertStringSecurityDescriptorToSecurityDescriptorW(
			sddl.as_ptr(),
			SDDL_REVISION_1,
			&mut descriptor,
			ptr::null_mut(),
		)
	};
	if converted == 0 {
		return Err(std::io::Error::last_os_error()).context("create pipe security descriptor");
	}
	let mut attributes = SECURITY_ATTRIBUTES {
		nLength:              size_of::<SECURITY_ATTRIBUTES>() as u32,
		lpSecurityDescriptor: descriptor,
		bInheritHandle:       0,
	};
	let pipe = unsafe {
		CreateNamedPipeW(
			wide(name).as_ptr(),
			PIPE_ACCESS_DUPLEX,
			PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
			1,
			MAX_MESSAGE as u32,
			MAX_MESSAGE as u32,
			0,
			&mut attributes,
		)
	};
	unsafe { LocalFree(descriptor) };
	if pipe == INVALID_HANDLE_VALUE {
		return Err(std::io::Error::last_os_error()).context("create control pipe");
	}
	Ok(pipe)
}

pub fn current_user_sid() -> Result<String> {
	let mut token = ptr::null_mut();
	if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
		return Err(std::io::Error::last_os_error()).context("open current process token");
	}
	let result = (|| {
		let mut length = 0;
		unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length) };
		if length == 0 {
			bail!("current user SID is unavailable");
		}
		let mut buffer = vec![0_u8; length as usize];
		if unsafe {
			GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length)
		} == 0
		{
			return Err(std::io::Error::last_os_error()).context("read current user SID");
		}
		let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
		let mut text = ptr::null_mut();
		if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
			return Err(std::io::Error::last_os_error()).context("format current user SID");
		}
		let len = (0..)
			.take_while(|&index| unsafe { *text.add(index) } != 0)
			.count();
		let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) });
		unsafe { LocalFree(text.cast()) };
		Ok(sid?)
	})();
	unsafe { CloseHandle(token) };
	result
}

use std::os::windows::io::FromRawHandle;
