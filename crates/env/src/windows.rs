//! Windows named-pipe transport for `env/v1` clients.
//!
//! The module is exported only on Windows. Named pipes use byte mode and the
//! same bounded protobuf varint framing as the Unix DATA transport.

use std::{
	ffi::OsStr,
	io, mem,
	os::windows::io::AsRawHandle as _,
	path::{Path, PathBuf},
	ptr, slice,
};

use bytes::BytesMut;
use omp_core::Str;
use omp_proto::{
	env::v1::{ClientFrame, ServerFrame},
	prost::Message,
};
use tokio::{
	io::{AsyncRead, AsyncReadExt as _, AsyncWrite, AsyncWriteExt as _},
	net::windows::named_pipe::{ClientOptions, NamedPipeClient, NamedPipeServer, ServerOptions},
	task::JoinHandle,
};
use windows_sys::Win32::{
	Foundation::{CloseHandle, GENERIC_ALL, HANDLE},
	Security::{
		ACCESS_ALLOWED_ACE, ACL, ACL_REVISION, AddAccessAllowedAce, EqualSid, GetLengthSid,
		GetTokenInformation, InitializeAcl, InitializeSecurityDescriptor, SECURITY_ATTRIBUTES,
		SECURITY_DESCRIPTOR, SetSecurityDescriptorDacl, TOKEN_QUERY, TOKEN_USER, TokenUser,
	},
	System::{
		Pipes::GetNamedPipeServerProcessId,
		Threading::{
			GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
		},
	},
};

use crate::{EnvClient, partition::FramePipe};

/// Maximum encoded size of one `env/v1` frame.
pub const FRAME_LIMIT: usize = 64 * 1024 * 1024;

/// Opens a raw byte stream to a ready owner-local Windows named pipe.
///
/// # Errors
/// Returns an OS error when the endpoint is not canonical/local, cannot be
/// opened, or its server process is not owned by the current user.
pub fn open_owner_pipe(endpoint: impl AsRef<Path>) -> io::Result<NamedPipeClient> {
	let endpoint = endpoint.as_ref();
	validate_local_pipe(endpoint.as_os_str())?;
	let client = ClientOptions::new().open(endpoint)?;
	verify_server_owner(&client)?;
	Ok(client)
}

/// Returns a deterministic digest of the current Windows user SID for
/// owner-scoped pipe identities.
///
/// # Errors
/// Returns an OS error when the process token or user SID cannot be queried.
pub fn current_user_pipe_scope() -> io::Result<Str> {
	let token = ProcessToken::current()?;
	let storage = token_user_storage(token.0)?;
	// SAFETY: token_user_storage initialized TOKEN_USER in aligned storage.
	let user = unsafe { &*(storage.as_ptr().cast::<TOKEN_USER>()) };
	// SAFETY: the SID belongs to the live TOKEN_USER storage above.
	let sid_bytes = unsafe { GetLengthSid(user.User.Sid) } as usize;
	if sid_bytes == 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: GetLengthSid returned the readable byte length of this live SID.
	let sid = unsafe { slice::from_raw_parts(user.User.Sid.cast::<u8>(), sid_bytes) };
	let mut hasher = omp_core::Hash32::hasher();
	hasher.update(b"omp/windows-user-pipe-scope/v1");
	hasher.update(sid);
	Ok(hasher.finalize().to_hex())
}

/// Returns the current Windows account name from the authenticated process
/// token.
///
/// # Errors
/// Returns an OS error when Windows cannot resolve the process account name.
pub fn current_user_name() -> io::Result<Str> {
	use windows_sys::Win32::System::WindowsProgramming::GetUserNameW;

	let mut units = 0_u32;
	// SAFETY: null/zero is the documented buffer sizing query.
	unsafe {
		GetUserNameW(ptr::null_mut(), &mut units);
	}
	if units == 0 {
		return Err(io::Error::last_os_error());
	}
	let mut name = vec![0_u16; units as usize];
	// SAFETY: `name` has `units` writable UTF-16 code units.
	if unsafe { GetUserNameW(name.as_mut_ptr(), &mut units) } == 0 {
		return Err(io::Error::last_os_error());
	}
	let length = name
		.iter()
		.position(|unit| *unit == 0)
		.unwrap_or(name.len());
	let name = String::from_utf16(&name[..length])
		.map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
	Ok(Str::from(name))
}

/// Connects raw frame channels to an owner-local Windows named pipe.
///
/// Only local pipe names in the `\\.\pipe\` namespace are accepted. Access is
/// ultimately authorized by the listener's current-user-only DACL; this
/// function never falls back to TCP or a filesystem transport.
///
/// # Errors
/// Returns an OS error when the endpoint is not a canonical local named pipe
/// or its ready listener cannot be opened.
#[tracing::instrument(
	name = "environment_connect",
	level = "debug",
	skip_all,
	fields(endpoint = %endpoint.as_ref().display())
)]
pub fn connect_owner_pipe_frames(
	endpoint: impl AsRef<Path>,
) -> io::Result<(FramePipe, JoinHandle<io::Result<()>>)> {
	let stream = open_owner_pipe(endpoint)?;
	let (outgoing, requests) = flume::bounded(64);
	let (responses, incoming) = flume::bounded(64);
	let task = tokio::spawn(async move {
		let (mut reader, mut writer) = {
			use tokio::io;
			io::split(stream)
		};
		let read = async move {
			let mut scratch = BytesMut::new();
			loop {
				let Some(frame) = read_server_frame(&mut reader, &mut scratch).await? else {
					return Ok::<(), io::Error>(());
				};
				if responses.send_async(frame).await.is_err() {
					return Ok(());
				}
			}
		};
		let write = async move {
			let mut scratch = BytesMut::new();
			while let Ok(frame) = requests.recv_async().await {
				write_client_frame(&mut writer, &frame, &mut scratch).await?;
			}
			Ok::<(), io::Error>(())
		};
		tokio::select! {
			result = read => result,
			result = write => result,
		}
	});
	Ok((FramePipe::new(outgoing, incoming), task))
}

/// Connects an environment client to an owner-local Windows named pipe.
///
/// # Errors
/// Returns an OS error when the endpoint is not a canonical local named pipe
/// or its ready listener cannot be opened.
pub fn connect_owner_pipe(
	endpoint: impl AsRef<Path>,
) -> io::Result<(EnvClient, JoinHandle<io::Result<()>>)> {
	let (frames, task) = connect_owner_pipe_frames(endpoint)?;
	let (outgoing, incoming) = frames.into_parts();
	Ok((EnvClient::from_channels(outgoing, incoming), task))
}

/// Reads one length-delimited client frame from a Windows DATA byte stream.
///
/// End-of-stream before a new prefix returns `Ok(None)`; truncation after a
/// prefix and malformed or oversized frames are protocol I/O errors.
///
/// # Errors
/// Returns an I/O error for truncated, malformed, or oversized frames.
#[doc(hidden)]
pub async fn read_client_frame<R>(
	reader: &mut R,
	scratch: &mut BytesMut,
) -> io::Result<Option<ClientFrame>>
where
	R: AsyncRead + Unpin,
{
	read_frame(reader, scratch).await
}

/// Reads one length-delimited server frame from a Windows DATA byte stream.
///
/// # Errors
/// Returns an I/O error for truncated, malformed, or oversized frames.
#[doc(hidden)]
pub async fn read_server_frame<R>(
	reader: &mut R,
	scratch: &mut BytesMut,
) -> io::Result<Option<ServerFrame>>
where
	R: AsyncRead + Unpin,
{
	read_frame(reader, scratch).await
}

/// Writes one length-delimited client frame to a Windows DATA byte stream.
///
/// # Errors
/// Returns an I/O error when the frame is oversized or the stream write fails.
#[doc(hidden)]
pub async fn write_client_frame<W>(
	writer: &mut W,
	frame: &ClientFrame,
	scratch: &mut BytesMut,
) -> io::Result<()>
where
	W: AsyncWrite + Unpin,
{
	write_frame(writer, frame, scratch).await
}

/// Writes one length-delimited server frame to a Windows DATA byte stream.
///
/// # Errors
/// Returns an I/O error when the frame is oversized or the stream write fails.
#[doc(hidden)]
pub async fn write_server_frame<W>(
	writer: &mut W,
	frame: &ServerFrame,
	scratch: &mut BytesMut,
) -> io::Result<()>
where
	W: AsyncWrite + Unpin,
{
	write_frame(writer, frame, scratch).await
}

/// A ready, current-user-only local Windows named-pipe listener.
///
/// The first instance is exclusive, every accepted connection receives a
/// replacement listener before it is returned, and dropping the value removes
/// its pending instance from the pipe namespace.
pub struct OwnerPipeListener {
	endpoint: PathBuf,
	pending:  Option<NamedPipeServer>,
}

impl OwnerPipeListener {
	/// Binds a local endpoint with a DACL granting only the current user access.
	///
	/// # Errors
	/// Returns an OS error for an invalid or already-owned endpoint or when the
	/// current-user security descriptor cannot be installed.
	#[tracing::instrument(
		name = "environment_bind",
		level = "debug",
		skip_all,
		fields(endpoint = %endpoint.as_ref().display())
	)]
	pub fn bind(endpoint: impl AsRef<Path>) -> io::Result<Self> {
		let endpoint = endpoint.as_ref();
		validate_local_pipe(endpoint.as_os_str())?;
		let pending = create_pipe(endpoint, true)?;
		Ok(Self { endpoint: endpoint.to_path_buf(), pending: Some(pending) })
	}

	/// Returns the endpoint made ready by [`Self::bind`].
	pub fn endpoint(&self) -> &Path {
		&self.endpoint
	}

	/// Accepts one connection and installs its replacement listener instance.
	///
	/// Cancelling this future leaves the pending instance ready for the next
	/// call.
	///
	/// # Errors
	/// Returns an OS error when accepting or creating the replacement fails.
	pub async fn accept(&mut self) -> io::Result<NamedPipeServer> {
		let pending = self.pending.as_mut().ok_or_else(|| {
			io::Error::new(io::ErrorKind::NotConnected, "named-pipe listener is closed")
		})?;
		pending.connect().await?;
		let connected = self.pending.take().ok_or_else(|| {
			io::Error::new(io::ErrorKind::NotConnected, "connected pipe instance was lost")
		})?;
		match create_pipe(&self.endpoint, false) {
			Ok(replacement) => self.pending = Some(replacement),
			Err(error) => {
				drop(connected);
				return Err(error);
			},
		}
		Ok(connected)
	}
}

fn create_pipe(endpoint: &Path, first: bool) -> io::Result<NamedPipeServer> {
	let mut security = OwnerSecurity::new()?;
	let mut attributes = security.attributes();
	let mut options = ServerOptions::new();
	options
		.first_pipe_instance(first)
		.reject_remote_clients(true);
	// SAFETY: `attributes` points to a valid descriptor and DACL for the
	// duration of CreateNamedPipeW, which copies the descriptor.
	unsafe {
		options.create_with_security_attributes_raw(
			endpoint,
			(&mut attributes as *mut SECURITY_ATTRIBUTES).cast(),
		)
	}
}

struct OwnerSecurity {
	descriptor: Box<SECURITY_DESCRIPTOR>,
	acl:        Vec<usize>,
}

impl OwnerSecurity {
	fn new() -> io::Result<Self> {
		let token = ProcessToken::current()?;
		let mut token_bytes = 0_u32;
		// SAFETY: `token` is live; null/zero is the documented sizing query.
		unsafe {
			GetTokenInformation(token.0, TokenUser, ptr::null_mut(), 0, &mut token_bytes);
		}
		if token_bytes == 0 {
			return Err(io::Error::last_os_error());
		}
		let word = mem::size_of::<usize>();
		let mut token_storage = vec![0_usize; (token_bytes as usize).div_ceil(word)];
		// SAFETY: aligned storage has the requested byte length and remains live.
		if unsafe {
			GetTokenInformation(
				token.0,
				TokenUser,
				token_storage.as_mut_ptr().cast(),
				token_bytes,
				&mut token_bytes,
			)
		} == 0
		{
			return Err(io::Error::last_os_error());
		}
		// SAFETY: GetTokenInformation initialized TOKEN_USER in aligned storage.
		let user = unsafe { &*(token_storage.as_ptr().cast::<TOKEN_USER>()) };
		let sid = user.User.Sid;
		// SAFETY: `sid` belongs to that initialized TOKEN_USER.
		let sid_bytes = unsafe { GetLengthSid(sid) } as usize;
		if sid_bytes == 0 {
			return Err(io::Error::last_os_error());
		}
		let acl_bytes = mem::size_of::<ACL>() + mem::size_of::<ACCESS_ALLOWED_ACE>()
			- mem::size_of::<u32>()
			+ sid_bytes;
		let mut acl = vec![0_usize; acl_bytes.div_ceil(word)];
		let acl_ptr = acl.as_mut_ptr().cast::<ACL>();
		// SAFETY: ACL storage is aligned/sized and AddAccessAllowedAce copies SID.
		let acl_initialized = unsafe {
			InitializeAcl(acl_ptr, acl_bytes as u32, ACL_REVISION) != 0
				&& AddAccessAllowedAce(acl_ptr, ACL_REVISION, GENERIC_ALL, sid) != 0
		};
		if !acl_initialized {
			return Err(io::Error::last_os_error());
		}
		let mut descriptor = Box::<SECURITY_DESCRIPTOR>::default();
		let descriptor_ptr = (&mut *descriptor as *mut SECURITY_DESCRIPTOR).cast();
		// SAFETY: descriptor and ACL allocations remain live through pipe creation.
		let descriptor_initialized = unsafe {
			InitializeSecurityDescriptor(descriptor_ptr, 1) != 0
				&& SetSecurityDescriptorDacl(descriptor_ptr, 1, acl_ptr, 0) != 0
		};
		if !descriptor_initialized {
			return Err(io::Error::last_os_error());
		}
		Ok(Self { descriptor, acl })
	}

	fn attributes(&mut self) -> SECURITY_ATTRIBUTES {
		let _ = self.acl.as_ptr();
		SECURITY_ATTRIBUTES {
			nLength:              mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
			lpSecurityDescriptor: (&mut *self.descriptor as *mut SECURITY_DESCRIPTOR).cast(),
			bInheritHandle:       0,
		}
	}
}

struct ProcessToken(HANDLE);

impl ProcessToken {
	fn current() -> io::Result<Self> {
		// SAFETY: GetCurrentProcess always returns a valid pseudo-handle.
		let process = unsafe { GetCurrentProcess() };
		Self::for_process(process)
	}

	fn for_process(process: HANDLE) -> io::Result<Self> {
		let mut token = ptr::null_mut();
		// SAFETY: `process` is a live handle and token points to writable storage.
		if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
			return Err(io::Error::last_os_error());
		}
		Ok(Self(token))
	}
}

impl Drop for ProcessToken {
	fn drop(&mut self) {
		// SAFETY: this owned handle came from OpenProcessToken.
		unsafe {
			let _ = CloseHandle(self.0);
		}
	}
}

fn verify_server_owner(client: &NamedPipeClient) -> io::Result<()> {
	let mut process_id = 0_u32;
	// SAFETY: the raw handle belongs to the live NamedPipeClient and the output
	// pointer is writable for one process identifier.
	if unsafe { GetNamedPipeServerProcessId(client.as_raw_handle().cast(), &mut process_id) } == 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: OpenProcess receives a PID reported by the connected kernel pipe.
	let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
	if process.is_null() {
		return Err(io::Error::last_os_error());
	}
	let process = KernelHandle(process);
	let owner_token = ProcessToken::for_process(process.0)?;
	let current_token = ProcessToken::current()?;
	let owner = token_user_storage(owner_token.0)?;
	let current = token_user_storage(current_token.0)?;
	// SAFETY: both buffers contain initialized TOKEN_USER values and remain live.
	let owner_sid = unsafe { (&*owner.as_ptr().cast::<TOKEN_USER>()).User.Sid };
	let current_sid = unsafe { (&*current.as_ptr().cast::<TOKEN_USER>()).User.Sid };
	// SAFETY: both SID pointers belong to the live token information buffers.
	if unsafe { EqualSid(owner_sid, current_sid) } == 0 {
		return Err(io::Error::new(
			io::ErrorKind::PermissionDenied,
			"environment pipe server is not owned by the current user",
		));
	}
	Ok(())
}

fn token_user_storage(token: HANDLE) -> io::Result<Vec<usize>> {
	let mut bytes = 0_u32;
	// SAFETY: token is live; null/zero is the documented sizing query.
	unsafe {
		GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut bytes);
	}
	if bytes == 0 {
		return Err(io::Error::last_os_error());
	}
	let mut storage = vec![0_usize; (bytes as usize).div_ceil(mem::size_of::<usize>())];
	// SAFETY: aligned storage has the byte length returned by the sizing query.
	if unsafe {
		GetTokenInformation(token, TokenUser, storage.as_mut_ptr().cast(), bytes, &mut bytes)
	} == 0
	{
		return Err(io::Error::last_os_error());
	}
	Ok(storage)
}

struct KernelHandle(HANDLE);

impl Drop for KernelHandle {
	fn drop(&mut self) {
		// SAFETY: this owned handle came from OpenProcess.
		unsafe {
			let _ = CloseHandle(self.0);
		}
	}
}

fn validate_local_pipe(endpoint: &OsStr) -> io::Result<()> {
	let endpoint = endpoint.to_string_lossy();
	let Some(identity) = endpoint.strip_prefix(r"\\.\pipe\") else {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"environment endpoint must be a local Windows named pipe",
		));
	};
	if identity.is_empty() || identity.contains('\\') || identity.contains('/') {
		return Err(io::Error::new(
			io::ErrorKind::InvalidInput,
			"environment pipe identity must be one non-empty path component",
		));
	}
	Ok(())
}

async fn read_frame<M, R>(reader: &mut R, scratch: &mut BytesMut) -> io::Result<Option<M>>
where
	M: Message + Default,
	R: AsyncRead + Unpin,
{
	let Some(length) = read_length(reader).await? else {
		return Ok(None);
	};
	if length > FRAME_LIMIT {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"environment frame exceeds the configured limit",
		));
	}
	scratch.clear();
	scratch.resize(length, 0);
	reader.read_exact(scratch).await?;
	M::decode(&scratch[..]).map(Some).map_err(io::Error::other)
}

async fn write_frame<M, W>(writer: &mut W, frame: &M, scratch: &mut BytesMut) -> io::Result<()>
where
	M: Message,
	W: AsyncWrite + Unpin,
{
	if frame.encoded_len() > FRAME_LIMIT {
		return Err(io::Error::new(
			io::ErrorKind::InvalidData,
			"environment frame exceeds the configured limit",
		));
	}
	scratch.clear();
	frame
		.encode_length_delimited(&mut *scratch)
		.map_err(io::Error::other)?;
	writer.write_all(scratch).await?;
	writer.flush().await
}

async fn read_length<R>(reader: &mut R) -> io::Result<Option<usize>>
where
	R: AsyncRead + Unpin,
{
	let mut value = 0_u64;
	for shift in (0..70).step_by(7) {
		let mut byte = [0_u8; 1];
		match reader.read_exact(&mut byte).await {
			Ok(_) => {},
			Err(error) if error.kind() == io::ErrorKind::UnexpectedEof && shift == 0 => {
				return Ok(None);
			},
			Err(error) => return Err(error),
		}
		let part = u64::from(byte[0] & 0x7f);
		if shift == 63 && part > 1 {
			return Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frame varint"));
		}
		value |= part << shift;
		if byte[0] & 0x80 == 0 {
			return usize::try_from(value)
				.map(Some)
				.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "frame length overflow"));
		}
	}
	Err(io::Error::new(io::ErrorKind::InvalidData, "invalid frame varint"))
}

#[cfg(test)]
mod tests {
	use omp_proto::env::v1::ClientHello;

	use super::*;

	#[tokio::test]
	async fn codec_round_trips_the_shared_varint_format() {
		let frame = ClientFrame {
			request_id: 0,
			body: Some(client_frame::Body::Hello(ClientHello {
				client: "windows-codec".into(),
				..ClientHello::default()
			})),
			..ClientFrame::default()
		};
		use tokio::io;

		let (mut reader, mut writer) = io::duplex(4096);
		let mut encoded = BytesMut::new();
		write_client_frame(&mut writer, &frame, &mut encoded)
			.await
			.expect("encode frame");
		let decoded = read_client_frame(&mut reader, &mut BytesMut::new())
			.await
			.expect("decode frame")
			.expect("one frame");
		assert_eq!(decoded, frame);
	}

	#[tokio::test]
	async fn codec_rejects_oversized_prefix_before_body_allocation() {
		let (mut reader, mut writer) = io::duplex(32);
		let oversized = (FRAME_LIMIT as u64 + 1).encode_varint();
		writer.write_all(&oversized).await.expect("write prefix");
		let error = read_client_frame(&mut reader, &mut BytesMut::new())
			.await
			.expect_err("oversized frame");
		assert_eq!(error.kind(), ErrorKind::InvalidData);
	}

	#[test]
	fn security_descriptor_has_exactly_one_owner_ace() {
		let security = OwnerSecurity::new().expect("owner security descriptor");
		// SAFETY: OwnerSecurity initializes ACL at the aligned allocation start.
		let acl = unsafe { &*security.acl.as_ptr().cast::<ACL>() };
		assert_eq!(acl.AceCount, 1);
	}

	#[test]
	fn current_user_scope_and_name_are_stable_nonempty_identities() {
		let first = current_user_pipe_scope().expect("current user SID");
		let second = current_user_pipe_scope().expect("current user SID");
		assert_eq!(first, second);
		assert!(!first.is_empty());
		assert!(!current_user_name().expect("current user name").is_empty());
	}

	trait EncodeVarint {
		fn encode_varint(self) -> Vec<u8>;
	}

	impl EncodeVarint for u64 {
		fn encode_varint(mut self) -> Vec<u8> {
			let mut encoded = Vec::with_capacity(10);
			loop {
				let mut byte = (self & 0x7f) as u8;
				self >>= 7;
				if self != 0 {
					byte |= 0x80;
				}
				encoded.push(byte);
				if self == 0 {
					return encoded;
				}
			}
		}
	}
}
