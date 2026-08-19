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
		// SAFETY: `name` is a live null-terminated UTF-16 buffer; null security
		// attributes request the default descriptor, and the result is checked.
		let handle = unsafe { CreateMutexW(ptr::null(), 0, name.as_ptr()) };
		if handle.is_null() {
			return Err(std::io::Error::last_os_error()).context("create Desktop Tag mutex");
		}
		// SAFETY: This immediately reads the thread-local error set by `CreateMutexW`.
		if unsafe { windows_sys::Win32::Foundation::GetLastError() } == ERROR_ALREADY_EXISTS {
			// SAFETY: `handle` is the live mutex handle created above and is not retained.
			unsafe { CloseHandle(handle) };
			return Ok(None);
		}
		Ok(Some(Self { handle, sid }))
	}
}

impl Drop for InstanceGuard {
	fn drop(&mut self) {
		// SAFETY: The guard exclusively owns this live mutex handle and drops once.
		unsafe { CloseHandle(self.handle) };
	}
}

pub fn pipe_name(sid: &str) -> String {
	format!(r"\\.\pipe\ompk-desktop-tag-{sid}")
}

pub fn forward(sid: &str, request: &ControlRequest) -> Result<ControlResponse> {
	let name = wide(&pipe_name(sid));
	// SAFETY: `name` is live and null-terminated, null security/template pointers
	// are permitted, and ownership of a successful handle is transferred below.
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
	// SAFETY: `handle` is a unique successful `CreateFileW` result, so ownership
	// may transfer to `File` exactly once.
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
		// SAFETY: `pipe` is a live server pipe and the null overlapped pointer
		// requests a synchronous connection.
		let connected = unsafe { ConnectNamedPipe(pipe, ptr::null_mut()) };
		if connected == 0 {
			let error = std::io::Error::last_os_error()
				.raw_os_error()
				.unwrap_or_default() as u32;
			if error != windows_sys::Win32::Foundation::ERROR_PIPE_CONNECTED {
				// SAFETY: No `File` owns this still-live pipe on the error path.
				unsafe { CloseHandle(pipe) };
				continue;
			}
		}
		// SAFETY: The connected pipe handle has unique ownership, transferred to
		// `File` exactly once for automatic closing.
		let mut file = unsafe { std::fs::File::from_raw_handle(pipe) };
		let mut data = String::new();
		let result = BufReader::new(&mut file)
			.take(MAX_MESSAGE as u64 + 1)
			.read_line(&mut data);
		if result.is_ok()
			&& data.len() <= MAX_MESSAGE
			&& !data.is_empty()
			&& let Ok(request) = serde_json::from_str::<ControlRequest>(&data)
		{
			let response = handler(request);
			if serde_json::to_writer(&mut file, &response).is_ok() {
				let _ = file.write_all(b"\n");
			}
		}
		// SAFETY: `pipe` remains live and owned by `file`; disconnecting ends the
		// session before `file` closes the handle.
		unsafe { DisconnectNamedPipe(pipe) };
	}
}

fn create_pipe(name: &str, sid: &str) -> Result<HANDLE> {
	let sddl = wide(&format!("D:P(A;;GA;;;{sid})"));
	let mut descriptor: *mut c_void = ptr::null_mut();
	// SAFETY: `sddl` is live and null-terminated, while `descriptor` is valid
	// writable storage for the API-owned allocation pointer.
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
	let attributes = SECURITY_ATTRIBUTES {
		nLength:              size_of::<SECURITY_ATTRIBUTES>() as u32,
		lpSecurityDescriptor: descriptor,
		bInheritHandle:       0,
	};
	// SAFETY: The pipe name and security descriptor remain live through the call;
	// all sizes are bounded by `MAX_MESSAGE`, and the result is checked.
	let pipe = unsafe {
		CreateNamedPipeW(
			wide(name).as_ptr(),
			PIPE_ACCESS_DUPLEX,
			PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE | PIPE_WAIT,
			1,
			MAX_MESSAGE as u32,
			MAX_MESSAGE as u32,
			0,
			&attributes,
		)
	};
	// SAFETY: `descriptor` was allocated by the Windows local allocator and the
	// synchronous pipe-creation call no longer references it.
	unsafe { LocalFree(descriptor) };
	if pipe == INVALID_HANDLE_VALUE {
		return Err(std::io::Error::last_os_error()).context("create control pipe");
	}
	Ok(pipe)
}

pub fn current_user_sid() -> Result<String> {
	let mut token = ptr::null_mut();
	// SAFETY: `GetCurrentProcess` returns a valid pseudo-handle, and `token` is
	// writable storage for the owned token handle returned by the call.
	if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
		return Err(std::io::Error::last_os_error()).context("open current process token");
	}
	let result = (|| {
		let mut length = 0;
		// SAFETY: This documented sizing query accepts a null output buffer and
		// writes the required byte count to `length`.
		unsafe { GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length) };
		if length == 0 {
			bail!("current user SID is unavailable");
		}
		let mut buffer = vec![0_usize; (length as usize).div_ceil(size_of::<usize>())];
		// SAFETY: `buffer` is pointer-aligned and has at least `length` writable
		// bytes; `token` remains live throughout the query.
		if unsafe {
			GetTokenInformation(token, TokenUser, buffer.as_mut_ptr().cast(), length, &mut length)
		} == 0
		{
			return Err(std::io::Error::last_os_error()).context("read current user SID");
		}
		// SAFETY: The aligned buffer was initialized successfully as `TOKEN_USER`
		// by `GetTokenInformation` and remains alive for this borrow.
		let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
		let mut text = ptr::null_mut();
		// SAFETY: The SID points into the live token-information buffer, and
		// `text` is writable storage for a local-allocator-owned UTF-16 pointer.
		if unsafe { ConvertSidToStringSidW(user.User.Sid, &mut text) } == 0 {
			return Err(std::io::Error::last_os_error()).context("format current user SID");
		}
		let mut len = 0;
		// SAFETY: `ConvertSidToStringSidW` guarantees a null-terminated UTF-16
		// allocation; advance only until that required terminator.
		while unsafe { *text.add(len) } != 0 {
			len += 1;
		}
		// SAFETY: The scan above established that `len` initialized UTF-16 code
		// units precede the terminator in the live allocation.
		let sid = String::from_utf16(unsafe { std::slice::from_raw_parts(text, len) });
		// SAFETY: `text` came from the Windows local allocator and the string has
		// been copied, so the allocation is no longer referenced.
		unsafe { LocalFree(text.cast()) };
		Ok(sid?)
	})();
	// SAFETY: `token` is the live owned handle opened above and is no longer used.
	unsafe { CloseHandle(token) };
	result
}

use std::os::windows::io::FromRawHandle;
