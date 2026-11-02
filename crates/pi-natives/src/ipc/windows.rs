//! Windows named-pipe transport.

use std::{
	ffi::c_void,
	io::{self, IoSlice},
	iter,
	os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
	ptr, slice,
	time::Duration,
};

use tokio::{
	net::windows::named_pipe::{
		ClientOptions, NamedPipeClient, NamedPipeServer, PipeMode, ServerOptions,
	},
	time::Instant,
};
use windows_sys::{
	Win32::{
		Foundation::{
			ERROR_ACCESS_DENIED, ERROR_BAD_PATHNAME, ERROR_BROKEN_PIPE, ERROR_FILE_NOT_FOUND,
			ERROR_INVALID_NAME, ERROR_INVALID_PARAMETER, ERROR_NETNAME_DELETED, ERROR_NO_DATA,
			ERROR_NOT_ENOUGH_MEMORY, ERROR_OPERATION_ABORTED, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND,
			ERROR_PIPE_BUSY, ERROR_PIPE_NOT_CONNECTED, ERROR_SEM_TIMEOUT, ERROR_TOO_MANY_OPEN_FILES,
			HANDLE, LocalFree,
		},
		Security::{
			Authorization::{
				ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW,
				SDDL_REVISION_1,
			},
			EqualSid, GetTokenInformation, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
			TOKEN_QUERY, TOKEN_USER, TokenUser,
		},
		System::{
			Pipes::GetNamedPipeServerProcessId,
			Threading::{
				GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
			},
		},
	},
	core::PWSTR,
};

use super::IpcError;

/// Delay between `ERROR_PIPE_BUSY` retries while every instance is taken.
const BUSY_RETRY: Duration = Duration::from_millis(20);

/// Errno-style name for a raw Win32 error.
pub const fn os_error_code(code: i32) -> Option<&'static str> {
	Some(match code as u32 {
		ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => "ENOENT",
		ERROR_ACCESS_DENIED => "EACCES",
		ERROR_PIPE_BUSY => "EBUSY",
		ERROR_BROKEN_PIPE | ERROR_NO_DATA => "EPIPE",
		ERROR_PIPE_NOT_CONNECTED => "ENOTCONN",
		ERROR_SEM_TIMEOUT => "ETIMEDOUT",
		ERROR_INVALID_NAME | ERROR_BAD_PATHNAME | ERROR_INVALID_PARAMETER => "EINVAL",
		ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY => "ENOMEM",
		ERROR_TOO_MANY_OPEN_FILES => "EMFILE",
		ERROR_NETNAME_DELETED => "ECONNRESET",
		ERROR_OPERATION_ABORTED => "ECANCELED",
		_ => return None,
	})
}

/// A peer that closed its pipe handle surfaces as a broken/disconnected pipe,
/// which is the named-pipe spelling of EOF.
pub fn is_orderly_eof(error: &io::Error) -> bool {
	matches!(
		error.raw_os_error().map(|code| code as u32),
		Some(ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA)
	)
}

/// `TOKEN_USER` copied out of a token, in pointer-aligned storage.
struct TokenUserBuf(Vec<u64>);

impl TokenUserBuf {
	const fn sid(&self) -> PSID {
		// SAFETY: the buffer was filled by `GetTokenInformation(TokenUser)`,
		// is 8-byte aligned, and outlives the returned pointer's uses.
		unsafe { (*self.0.as_ptr().cast::<TOKEN_USER>()).User.Sid }
	}
}

/// User SID of the token of `process` (a real or pseudo process handle).
fn process_user(process: HANDLE) -> io::Result<TokenUserBuf> {
	let mut raw_token: HANDLE = ptr::null_mut();
	// SAFETY: `process` is a live process handle and `raw_token` a valid out
	// pointer.
	if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut raw_token) } == 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `OpenProcessToken` returned a fresh handle we now own.
	let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };
	let mut len = 0u32;
	// SAFETY: a null buffer with zero length only queries the required size.
	unsafe {
		GetTokenInformation(token.as_raw_handle(), TokenUser, ptr::null_mut(), 0, &mut len);
	}
	if len == 0 {
		return Err(io::Error::last_os_error());
	}
	let mut buf = vec![0u64; (len as usize).div_ceil(size_of::<u64>())];
	// SAFETY: `buf` provides at least `len` writable, aligned bytes.
	let ok = unsafe {
		GetTokenInformation(token.as_raw_handle(), TokenUser, buf.as_mut_ptr().cast(), len, &mut len)
	};
	if ok == 0 {
		return Err(io::Error::last_os_error());
	}
	Ok(TokenUserBuf(buf))
}

fn current_user() -> io::Result<TokenUserBuf> {
	// SAFETY: `GetCurrentProcess` returns a pseudo handle that needs no close.
	process_user(unsafe { GetCurrentProcess() })
}

/// Security attributes whose DACL grants access to the current user only.
struct PipeSecurity {
	descriptor: PSECURITY_DESCRIPTOR,
	attributes: SECURITY_ATTRIBUTES,
}

// SAFETY: the descriptor is immutable LocalAlloc memory owned by this value;
// Win32 only reads it while creating pipe instances.
unsafe impl Send for PipeSecurity {}
// SAFETY: see `Send`; shared access is read-only.
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
	fn current_user_only() -> io::Result<Box<Self>> {
		let user = current_user()?;
		let mut sid_text: PWSTR = ptr::null_mut();
		// SAFETY: `user.sid()` is a valid SID and `sid_text` a valid out pointer.
		if unsafe { ConvertSidToStringSidW(user.sid(), &mut sid_text) } == 0 {
			return Err(io::Error::last_os_error());
		}
		// SAFETY: `sid_text` is a NUL-terminated wide string from LocalAlloc.
		let sid = unsafe {
			let mut len = 0;
			while *sid_text.add(len) != 0 {
				len += 1;
			}
			let text = String::from_utf16_lossy(slice::from_raw_parts(sid_text, len));
			LocalFree(sid_text.cast());
			text
		};
		let sddl: Vec<u16> = format!("D:P(A;;GA;;;{sid})")
			.encode_utf16()
			.chain(iter::once(0))
			.collect();
		let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
		// SAFETY: `sddl` is NUL-terminated; `descriptor` is a valid out pointer.
		let ok = unsafe {
			ConvertStringSecurityDescriptorToSecurityDescriptorW(
				sddl.as_ptr(),
				SDDL_REVISION_1,
				&mut descriptor,
				ptr::null_mut(),
			)
		};
		if ok == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(Box::new(Self {
			descriptor,
			attributes: SECURITY_ATTRIBUTES {
				nLength:              size_of::<SECURITY_ATTRIBUTES>() as u32,
				lpSecurityDescriptor: descriptor,
				bInheritHandle:       0,
			},
		}))
	}

	fn create_instance(&self, name: &str, first: bool) -> io::Result<NamedPipeServer> {
		let mut options = ServerOptions::new();
		options
			.first_pipe_instance(first)
			.reject_remote_clients(true)
			.pipe_mode(PipeMode::Byte);
		// SAFETY: `self.attributes` is a valid SECURITY_ATTRIBUTES whose
		// descriptor lives as long as `self`; Win32 copies it during creation.
		unsafe {
			options.create_with_security_attributes_raw(
				name,
				(&raw const self.attributes).cast_mut().cast::<c_void>(),
			)
		}
	}
}

impl Drop for PipeSecurity {
	fn drop(&mut self) {
		// SAFETY: `descriptor` came from LocalAlloc via the SDDL conversion and
		// is freed exactly once.
		unsafe { LocalFree(self.descriptor) };
	}
}

/// Named pipes leave nothing on disk to clean up.
pub struct Bound;

#[allow(clippy::needless_pass_by_value, reason = "consumes the bound endpoint like Unix")]
pub const fn release(_bound: Bound) {}

/// Pipe server keeping one pending instance for the next client.
pub struct Listener {
	name:     String,
	security: Box<PipeSecurity>,
	pending:  Option<NamedPipeServer>,
}

impl Listener {
	/// Next connected client; immediately re-arms a pending instance.
	pub async fn accept(&mut self) -> io::Result<Stream> {
		let pending = match self.pending.take() {
			Some(pending) => pending,
			None => self.security.create_instance(&self.name, false)?,
		};
		let pending = self.pending.insert(pending);
		let connected = pending.connect().await;
		let instance = self.pending.take();
		self.pending = self.security.create_instance(&self.name, false).ok();
		connected?;
		instance
			.map(Stream::Server)
			.ok_or_else(|| io::ErrorKind::NotConnected.into())
	}
}

/// Create the first instance of `endpoint` (see `IpcServer.listen`).
#[allow(clippy::unused_async, reason = "async on Unix; one shared call shape")]
pub async fn listen(endpoint: &str) -> Result<(Listener, Bound), IpcError> {
	let security = PipeSecurity::current_user_only()
		.map_err(|error| IpcError::io(&error, "build pipe security descriptor"))?;
	let first = security.create_instance(endpoint, true).map_err(|error| {
		match error.raw_os_error().map(|code| code as u32) {
			Some(ERROR_ACCESS_DENIED | ERROR_PIPE_BUSY) => {
				IpcError::new("EADDRINUSE", format!("{endpoint} already has a listener"))
			},
			_ => IpcError::io(&error, &format!("create {endpoint}")),
		}
	})?;
	Ok((Listener { name: endpoint.to_owned(), security, pending: Some(first) }, Bound))
}

/// Dial `endpoint`, waiting out `ERROR_PIPE_BUSY` until `timeout`, then
/// verify the server process runs as our user.
pub async fn connect(endpoint: &str, timeout: Duration) -> Result<Stream, IpcError> {
	let deadline = Instant::now() + timeout;
	let client = loop {
		match ClientOptions::new().open(endpoint) {
			Ok(client) => break client,
			Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) => {
				let now = Instant::now();
				if now >= deadline {
					return Err(IpcError::new(
						"ETIMEDOUT",
						format!("{endpoint} stayed busy for {} ms", timeout.as_millis()),
					));
				}
				tokio::time::sleep(BUSY_RETRY.min(deadline - now)).await;
			},
			Err(error) => return Err(IpcError::io(&error, &format!("connect {endpoint}"))),
		}
	};
	verify_server_user(client.as_raw_handle(), endpoint)?;
	Ok(Stream::Client(client))
}

fn verify_server_user(pipe: HANDLE, endpoint: &str) -> Result<(), IpcError> {
	let mut pid = 0u32;
	// SAFETY: `pipe` is a live client pipe handle; `pid` a valid out pointer.
	if unsafe { GetNamedPipeServerProcessId(pipe, &mut pid) } == 0 {
		return Err(IpcError::io(&io::Error::last_os_error(), "query pipe server process"));
	}
	// SAFETY: plain OpenProcess call; the result is checked before use.
	let raw = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if raw.is_null() {
		return Err(IpcError::io(&io::Error::last_os_error(), "open pipe server process"));
	}
	// SAFETY: `OpenProcess` returned a fresh handle we now own.
	let process = unsafe { OwnedHandle::from_raw_handle(raw) };
	let server = process_user(process.as_raw_handle())
		.map_err(|error| IpcError::io(&error, "read pipe server token"))?;
	let ours = current_user().map_err(|error| IpcError::io(&error, "read own token"))?;
	// SAFETY: both SIDs point into live token buffers.
	if unsafe { EqualSid(server.sid(), ours.sid()) } == 0 {
		return Err(IpcError::new(
			"EACCES",
			format!("{endpoint} is served by a process of another user"),
		));
	}
	Ok(())
}

/// How [`Stream::finish_write`] left the stream.
pub enum WriteFinish {
	/// Write side shut; reading continues until EOF.
	#[allow(dead_code, reason = "Unix-only outcome kept in the shared shape")]
	HalfClosed,
	/// The whole stream must be dropped now.
	Closed,
}

/// Connected pipe end.
pub enum Stream {
	Server(NamedPipeServer),
	Client(NamedPipeClient),
}

impl Stream {
	pub async fn readable(&self) -> io::Result<()> {
		match self {
			Self::Server(pipe) => pipe.readable().await,
			Self::Client(pipe) => pipe.readable().await,
		}
	}

	/// Read into `buf`'s spare capacity without initializing it first.
	pub fn try_read_buf(&self, buf: &mut Vec<u8>) -> io::Result<usize> {
		match self {
			Self::Server(pipe) => pipe.try_read_buf(buf),
			Self::Client(pipe) => pipe.try_read_buf(buf),
		}
	}

	pub async fn writable(&self) -> io::Result<()> {
		match self {
			Self::Server(pipe) => pipe.writable().await,
			Self::Client(pipe) => pipe.writable().await,
		}
	}

	pub fn try_write_vectored(&self, bufs: &[IoSlice<'_>]) -> io::Result<usize> {
		match self {
			Self::Server(pipe) => pipe.try_write_vectored(bufs),
			Self::Client(pipe) => pipe.try_write_vectored(bufs),
		}
	}

	/// Pipes have no half-close: the caller drops the handle. Dropping keeps
	/// in-flight overlapped writes running (mio only cancels reads), and
	/// closing — unlike `DisconnectNamedPipe` — leaves unread data readable
	/// by the peer before it sees the broken pipe.
	#[allow(
		clippy::unnecessary_wraps,
		clippy::unused_self,
		reason = "fallible half-close on Unix; one shared call shape"
	)]
	pub const fn finish_write(&self) -> io::Result<WriteFinish> {
		Ok(WriteFinish::Closed)
	}
}
