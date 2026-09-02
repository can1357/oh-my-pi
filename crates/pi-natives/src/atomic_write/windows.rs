//! Windows implementation of the private atomic local-file writer.
//!
//! The only absolute native open is the volume device root resolved from the
//! DOS drive mapping. Every component below it is opened relative to an owned
//! directory handle with `OBJ_DONT_REPARSE` and `FILE_OPEN_REPARSE_POINT`.

use std::{
	ffi::{OsStr, OsString, c_void},
	fs::File,
	io::Write,
	mem::size_of,
	os::windows::{
		ffi::OsStrExt,
		io::{AsRawHandle, FromRawHandle, OwnedHandle},
	},
	path::{Component, Path, Prefix},
	ptr,
	sync::atomic::{AtomicU64, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

use windows_sys::{
	Wdk::{
		Foundation::OBJECT_ATTRIBUTES,
		Storage::FileSystem::{
			FILE_CREATE, FILE_DIRECTORY_FILE, FILE_NON_DIRECTORY_FILE, FILE_OPEN,
			FILE_OPEN_REPARSE_POINT, FILE_RENAME_INFORMATION, FILE_SYNCHRONOUS_IO_NONALERT,
			FileRenameInformation, NtCreateFile, NtSetInformationFile,
		},
	},
	Win32::{
		Foundation::{
			ERROR_ACCESS_DENIED, ERROR_DIR_NOT_EMPTY, ERROR_DIRECTORY, ERROR_FILE_NOT_FOUND,
			ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_NAME, ERROR_INVALID_PARAMETER, ERROR_LOCK_FAILED,
			ERROR_LOCK_VIOLATION, ERROR_NOT_SAME_DEVICE, ERROR_NOT_SUPPORTED, ERROR_PATH_NOT_FOUND,
			ERROR_SHARING_VIOLATION, GetLastError, HANDLE, LocalFree, NTSTATUS, OBJ_CASE_INSENSITIVE,
			OBJ_DONT_REPARSE, RtlNtStatusToDosError, STATUS_FILE_IS_A_DIRECTORY,
			STATUS_NOT_A_DIRECTORY, STATUS_OBJECT_NAME_COLLISION, STATUS_OBJECT_NAME_NOT_FOUND,
			STATUS_OBJECT_PATH_NOT_FOUND, STATUS_REPARSE_POINT_ENCOUNTERED, STATUS_STOPPED_ON_SYMLINK,
			UNICODE_STRING,
		},
		Security::{
			ACCESS_ALLOWED_ACE, ACE_HEADER, ACL, ACL_REVISION, AddAccessAllowedAceEx,
			Authorization::GetSecurityInfo, CONTAINER_INHERIT_ACE, CreateWellKnownSid,
			DACL_SECURITY_INFORMATION, EqualSid, GetAce, GetLengthSid, GetSecurityDescriptorControl,
			GetTokenInformation, INHERITED_ACE, InitializeAcl, InitializeSecurityDescriptor,
			OBJECT_INHERIT_ACE, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
			SE_DACL_PROTECTED, SECURITY_DESCRIPTOR, SetSecurityDescriptorControl,
			SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TOKEN_QUERY, TOKEN_USER, TokenUser,
			WinLocalSystemSid,
		},
		Storage::FileSystem::{
			DELETE, FILE_ADD_FILE, FILE_ADD_SUBDIRECTORY, FILE_ALL_ACCESS, FILE_ATTRIBUTE_NORMAL,
			FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_INFO,
			FILE_ID_INFO, FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_SHARE_DELETE,
			FILE_SHARE_NONE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TRAVERSE, FILE_WRITE_ATTRIBUTES,
			FILE_WRITE_DATA, FileAttributeTagInfo, FileDispositionInfo, FileIdInfo,
			GetFileInformationByHandleEx, QueryDosDeviceW, READ_CONTROL, SYNCHRONIZE,
			SetFileInformationByHandle,
		},
		System::{
			SystemServices::{ACCESS_ALLOWED_ACE_TYPE, SECURITY_DESCRIPTOR_REVISION},
			Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcessToken},
		},
	},
};

use super::{
	AtomicWriteCommitState, AtomicWriteError, AtomicWriteErrorCode, AtomicWriteOutcome,
	AtomicWriteRequest,
};
use crate::task::CancelToken;

const DIRECTORY_TRAVERSE_ACCESS: u32 =
	FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE;
const DIRECTORY_CREATE_CHILD_ACCESS: u32 =
	FILE_ADD_SUBDIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
const DIRECTORY_MUTATE_ACCESS: u32 =
	DIRECTORY_TRAVERSE_ACCESS | FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY;
const DIRECTORY_OPEN_OPTIONS: u32 =
	FILE_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
const FILE_OPEN_OPTIONS: u32 =
	FILE_NON_DIRECTORY_FILE | FILE_OPEN_REPARSE_POINT | FILE_SYNCHRONOUS_IO_NONALERT;
const PRIVATE_ACE_FLAGS: u32 = OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE;
const STAGE_ATTEMPTS: u32 = 64;

static STAGE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A small owned byte region with pointer alignment suitable for Windows
/// structs. `Vec<u8>` does not promise the alignment required by ACL and SID
/// objects, even when the allocator happens to provide it in practice.
struct AlignedBytes {
	words:  Vec<usize>,
	length: usize,
}

impl AlignedBytes {
	fn zeroed(length: usize) -> Option<Self> {
		let word_size = size_of::<usize>();
		let words = length
			.checked_add(word_size.checked_sub(1)?)?
			.checked_div(word_size)?;
		Some(Self { words: vec![0; words], length })
	}

	fn as_ptr(&self) -> *const u8 {
		self.words.as_ptr().cast()
	}

	fn as_mut_ptr(&mut self) -> *mut u8 {
		self.words.as_mut_ptr().cast()
	}

	fn len(&self) -> usize {
		self.length
	}
}

/// A cloned SID whose backing bytes remain correctly aligned while it is used
/// as an owner in a security descriptor or compared against an ACL entry.
struct Sid {
	bytes: AlignedBytes,
}

impl Sid {
	fn from_psid(sid: PSID) -> Result<Self, AtomicWriteError> {
		if sid.is_null() {
			return Err(io_error("Windows returned a null SID"));
		}

		let length = unsafe { GetLengthSid(sid) as usize };
		if length == 0 {
			return Err(io_error("Windows returned an empty SID"));
		}
		let mut bytes =
			AlignedBytes::zeroed(length).ok_or_else(|| io_error("SID allocation size overflow"))?;
		unsafe {
			ptr::copy_nonoverlapping(sid.cast::<u8>(), bytes.as_mut_ptr(), length);
		}
		Ok(Self { bytes })
	}

	fn as_psid(&self) -> PSID {
		self.bytes.as_ptr().cast::<c_void>() as PSID
	}
}

/// The creation-time ACL used for the local root, newly created descendants,
/// and the stage. It is protected so parent inheritance cannot silently add a
/// principal, while the two explicit ACEs remain inheritable for future
/// descendants created by Windows.
struct PrivateSecurityDescriptor {
	owner:      Sid,
	system:     Sid,
	acl:        AlignedBytes,
	descriptor: SECURITY_DESCRIPTOR,
}

impl PrivateSecurityDescriptor {
	fn new() -> Result<Self, AtomicWriteError> {
		let owner = current_user_sid()?;
		let system = local_system_sid()?;
		let owner_ace = ace_size(owner.bytes.len())?;
		let system_ace = ace_size(system.bytes.len())?;
		let acl_len = size_of::<ACL>()
			.checked_add(owner_ace)
			.and_then(|length| length.checked_add(system_ace))
			.ok_or_else(|| io_error("ACL allocation size overflow"))?;
		let acl_len_u32 = u32::try_from(acl_len).map_err(|_| io_error("ACL is too large"))?;
		let acl = AlignedBytes::zeroed(acl_len).ok_or_else(|| io_error("ACL allocation failed"))?;

		let mut result = Self { owner, system, acl, descriptor: SECURITY_DESCRIPTOR::default() };
		let acl_ptr = result.acl.as_mut_ptr().cast::<ACL>();
		if unsafe { InitializeAcl(acl_ptr, acl_len_u32, ACL_REVISION) } == 0 {
			let error = unsafe { GetLastError() };
			return Err(win32_io_error("initialize private ACL", error));
		}
		if unsafe {
			AddAccessAllowedAceEx(
				acl_ptr,
				ACL_REVISION,
				PRIVATE_ACE_FLAGS,
				FILE_ALL_ACCESS,
				result.owner.as_psid(),
			)
		} == 0
		{
			let error = unsafe { GetLastError() };
			return Err(win32_io_error("grant owner access to private ACL", error));
		}
		if unsafe {
			AddAccessAllowedAceEx(
				acl_ptr,
				ACL_REVISION,
				PRIVATE_ACE_FLAGS,
				FILE_ALL_ACCESS,
				result.system.as_psid(),
			)
		} == 0
		{
			let error = unsafe { GetLastError() };
			return Err(win32_io_error("grant SYSTEM access to private ACL", error));
		}

		let descriptor = (&mut result.descriptor as *mut SECURITY_DESCRIPTOR).cast::<c_void>();
		if unsafe { InitializeSecurityDescriptor(descriptor, SECURITY_DESCRIPTOR_REVISION) } == 0 {
			let error = unsafe { GetLastError() };
			return Err(win32_io_error("initialize private security descriptor", error));
		}
		if unsafe { SetSecurityDescriptorOwner(descriptor, result.owner.as_psid(), 0) } == 0 {
			let error = unsafe { GetLastError() };
			return Err(win32_io_error("set private security descriptor owner", error));
		}
		if unsafe { SetSecurityDescriptorDacl(descriptor, 1, acl_ptr, 0) } == 0 {
			let error = unsafe { GetLastError() };
			return Err(win32_io_error("set private security descriptor DACL", error));
		}
		if unsafe { SetSecurityDescriptorControl(descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED) }
			== 0
		{
			let error = unsafe { GetLastError() };
			return Err(win32_io_error("protect private security descriptor DACL", error));
		}
		Ok(result)
	}

	fn as_ptr(&self) -> *const SECURITY_DESCRIPTOR {
		&self.descriptor
	}
}

fn ace_size(sid_length: usize) -> Result<usize, AtomicWriteError> {
	size_of::<ACCESS_ALLOWED_ACE>()
		.checked_sub(size_of::<u32>())
		.and_then(|length| length.checked_add(sid_length))
		.ok_or_else(|| io_error("ACE allocation size overflow"))
}

fn current_user_sid() -> Result<Sid, AtomicWriteError> {
	let mut raw_token = ptr::null_mut();
	if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut raw_token) } == 0 {
		let error = unsafe { GetLastError() };
		return Err(win32_io_error("open process token", error));
	}
	let token = unsafe { OwnedHandle::from_raw_handle(raw_token) };

	let mut needed = 0;
	if unsafe {
		GetTokenInformation(token.as_raw_handle(), TokenUser, ptr::null_mut(), 0, &mut needed)
	} != 0
	{
		return Err(io_error("querying TOKEN_USER unexpectedly succeeded without a buffer"));
	}
	let error = unsafe { GetLastError() };
	if error != ERROR_INSUFFICIENT_BUFFER || needed == 0 {
		return Err(win32_io_error("query TOKEN_USER size", error));
	}

	let mut buffer = AlignedBytes::zeroed(needed as usize)
		.ok_or_else(|| io_error("TOKEN_USER allocation size overflow"))?;
	if unsafe {
		GetTokenInformation(
			token.as_raw_handle(),
			TokenUser,
			buffer.as_mut_ptr().cast::<c_void>(),
			needed,
			&mut needed,
		)
	} == 0
	{
		let error = unsafe { GetLastError() };
		return Err(win32_io_error("read TOKEN_USER", error));
	}
	let token_user = unsafe { &*buffer.as_ptr().cast::<TOKEN_USER>() };
	Sid::from_psid(token_user.User.Sid)
}

fn local_system_sid() -> Result<Sid, AtomicWriteError> {
	let mut needed = 0;
	if unsafe {
		CreateWellKnownSid(WinLocalSystemSid, ptr::null_mut(), ptr::null_mut(), &mut needed)
	} != 0
	{
		return Err(io_error("querying the SYSTEM SID unexpectedly succeeded without a buffer"));
	}
	let error = unsafe { GetLastError() };
	if error != ERROR_INSUFFICIENT_BUFFER || needed == 0 {
		return Err(win32_io_error("query SYSTEM SID size", error));
	}

	let mut bytes = AlignedBytes::zeroed(needed as usize)
		.ok_or_else(|| io_error("SYSTEM SID allocation size overflow"))?;
	if unsafe {
		CreateWellKnownSid(
			WinLocalSystemSid,
			ptr::null_mut(),
			bytes.as_mut_ptr().cast::<c_void>() as PSID,
			&mut needed,
		)
	} == 0
	{
		let error = unsafe { GetLastError() };
		return Err(win32_io_error("create SYSTEM SID", error));
	}
	Ok(Sid { bytes })
}

/// Owns the security descriptor that `GetSecurityInfo` allocates with
/// `LocalAlloc`. The contained pointers remain valid only for this guard.
struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

impl Drop for LocalSecurityDescriptor {
	fn drop(&mut self) {
		if !self.0.is_null() {
			unsafe {
				LocalFree(self.0);
			}
		}
	}
}

fn verify_private_object(
	handle: HANDLE,
	private: &PrivateSecurityDescriptor,
) -> Result<(), AtomicWriteError> {
	let mut owner = ptr::null_mut();
	let mut dacl = ptr::null_mut();
	let mut descriptor = ptr::null_mut();
	let status = unsafe {
		GetSecurityInfo(
			handle,
			windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT,
			OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
			&mut owner,
			ptr::null_mut(),
			&mut dacl,
			ptr::null_mut(),
			&mut descriptor,
		)
	};
	if status != 0 {
		return Err(unsafe_path(format!(
			"cannot prove the local root or parent has a private DACL (Win32 error {status})"
		)));
	}
	if descriptor.is_null() || owner.is_null() || dacl.is_null() {
		return Err(unsafe_path("local root or parent has no complete private security descriptor"));
	}
	let descriptor = LocalSecurityDescriptor(descriptor);

	let mut control = 0;
	let mut revision = 0;
	if unsafe { GetSecurityDescriptorControl(descriptor.0, &mut control, &mut revision) } == 0 {
		return Err(unsafe_path("cannot read local root or parent DACL protection"));
	}
	if control & SE_DACL_PROTECTED == 0 {
		return Err(unsafe_path("local root or parent DACL is not protected"));
	}
	if unsafe { EqualSid(owner, private.owner.as_psid()) } == 0 {
		return Err(unsafe_path("local root or parent is not owned by the invoking user"));
	}

	let acl = unsafe { &*dacl };
	if acl.AceCount != 2 {
		return Err(unsafe_path(
			"local root or parent DACL has principals outside the private policy",
		));
	}

	let mut owner_seen = false;
	let mut system_seen = false;
	for index in 0..u32::from(acl.AceCount) {
		let mut raw_ace = ptr::null_mut();
		if unsafe { GetAce(dacl as *const ACL, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
			return Err(unsafe_path("cannot inspect a local root or parent DACL entry"));
		}
		let header = unsafe { &*raw_ace.cast::<ACE_HEADER>() };
		if header.AceType != ACCESS_ALLOWED_ACE_TYPE as u8
			|| header.AceFlags != PRIVATE_ACE_FLAGS as u8
			|| header.AceFlags & INHERITED_ACE as u8 != 0
			|| usize::from(header.AceSize) < size_of::<ACCESS_ALLOWED_ACE>()
		{
			return Err(unsafe_path(
				"local root or parent DACL is not the protected owner/SYSTEM policy",
			));
		}
		let ace = unsafe { &*raw_ace.cast::<ACCESS_ALLOWED_ACE>() };
		if ace.Mask != FILE_ALL_ACCESS {
			return Err(unsafe_path("local root or parent DACL grants incomplete private access"));
		}
		let sid = ptr::addr_of!(ace.SidStart).cast::<c_void>() as PSID;
		if unsafe { EqualSid(sid, private.owner.as_psid()) } != 0 {
			if owner_seen {
				return Err(unsafe_path("local root or parent DACL repeats the owner ACE"));
			}
			owner_seen = true;
		} else if unsafe { EqualSid(sid, private.system.as_psid()) } != 0 {
			if system_seen {
				return Err(unsafe_path("local root or parent DACL repeats the SYSTEM ACE"));
			}
			system_seen = true;
		} else {
			return Err(unsafe_path("local root or parent DACL grants another principal access"));
		}
	}
	if !owner_seen || !system_seen {
		return Err(unsafe_path("local root or parent DACL omits the owner or SYSTEM ACE"));
	}
	Ok(())
}

/// A Unicode name whose descriptor always points to its own stable UTF-16
/// backing store. NTDLL uses the byte length, not a trailing NUL.
struct UnicodeName {
	wide:       Vec<u16>,
	descriptor: UNICODE_STRING,
}

impl UnicodeName {
	fn native_path(wide: Vec<u16>) -> Result<Self, AtomicWriteError> {
		if wide.is_empty() || wide.iter().any(|character| *character == 0) {
			return Err(unsafe_path("native volume path is invalid"));
		}
		let byte_length = wide
			.len()
			.checked_mul(size_of::<u16>())
			.and_then(|length| u16::try_from(length).ok())
			.ok_or_else(|| unsafe_path("native volume path is too long"))?;
		let mut result = Self {
			wide,
			descriptor: UNICODE_STRING {
				Length:        byte_length,
				MaximumLength: byte_length,
				Buffer:        ptr::null_mut(),
			},
		};
		result.descriptor.Buffer = result.wide.as_mut_ptr();
		Ok(result)
	}

	fn component(component: &OsStr) -> Result<Self, AtomicWriteError> {
		let wide: Vec<u16> = component.encode_wide().collect();
		validate_component(&wide)?;
		Self::native_path(wide)
	}
}

fn validate_component(component: &[u16]) -> Result<(), AtomicWriteError> {
	if component.is_empty()
		|| component == [u16::from(b'.')]
		|| component == [u16::from(b'.'), u16::from(b'.')]
		|| component.iter().any(|character| {
			let character = *character;
			character == 0
				|| character == u16::from(b'/')
				|| character == u16::from(b'\\')
				|| character == u16::from(b':')
		}) {
		return Err(unsafe_path("target component is not a single Windows file name"));
	}
	Ok(())
}

struct VolumeAnchor {
	native_root: Vec<u16>,
	components:  Vec<OsString>,
}

fn parse_absolute_root(path: &Path) -> Result<VolumeAnchor, AtomicWriteError> {
	if !path.is_absolute() {
		return Err(unsafe_path("absoluteRoot is not a Windows absolute path"));
	}

	let mut components = path.components();
	let Some(Component::Prefix(prefix)) = components.next() else {
		return Err(unsafe_path("absoluteRoot has no Windows volume prefix"));
	};
	let drive = match prefix.kind() {
		Prefix::Disk(letter) | Prefix::VerbatimDisk(letter) => letter.to_ascii_uppercase(),
		_ => {
			return Err(AtomicWriteError::new(
				AtomicWriteErrorCode::Unsupported,
				AtomicWriteCommitState::NotCommitted,
				"Windows atomic local writes require a local drive-rooted absoluteRoot",
			));
		},
	};
	if !matches!(components.next(), Some(Component::RootDir)) {
		return Err(unsafe_path("absoluteRoot is not rooted at its volume"));
	}

	let mut root_components = Vec::new();
	for component in components {
		match component {
			Component::Normal(component) => {
				let wide: Vec<u16> = component.encode_wide().collect();
				validate_component(&wide)?;
				root_components.push(component.to_os_string());
			},
			Component::CurDir | Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
				return Err(unsafe_path("absoluteRoot contains a non-directory component"));
			},
		}
	}
	if root_components.is_empty() {
		return Err(unsafe_path("absoluteRoot must name a private directory below the volume root"));
	}

	let native_root = resolve_volume_device(drive)?;
	Ok(VolumeAnchor { native_root, components: root_components })
}

/// Resolve a drive letter once to a real `\\Device\\…` object. Rejecting any
/// target with a suffix prevents a SUBST/device-map alias from serving as an
/// invented lower trust anchor.
fn resolve_volume_device(drive: u8) -> Result<Vec<u16>, AtomicWriteError> {
	let name = [u16::from(drive), u16::from(b':'), 0];
	let mut capacity = 256usize;
	loop {
		let mut output = vec![0u16; capacity];
		let result = unsafe { QueryDosDeviceW(name.as_ptr(), output.as_mut_ptr(), capacity as u32) };
		if result != 0 {
			let Some(length) = output.iter().position(|character| *character == 0) else {
				return Err(unsafe_path("drive mapping is not NUL terminated"));
			};
			let mut mapping = output[..length].to_vec();
			const DEVICE_PREFIX: &[u16] = &[
				b'\\' as u16,
				b'D' as u16,
				b'e' as u16,
				b'v' as u16,
				b'i' as u16,
				b'c' as u16,
				b'e' as u16,
				b'\\' as u16,
			];
			if !mapping.starts_with(DEVICE_PREFIX)
				|| mapping.len() == DEVICE_PREFIX.len()
				|| mapping[DEVICE_PREFIX.len()..].contains(&(b'\\' as u16))
			{
				return Err(AtomicWriteError::new(
					AtomicWriteErrorCode::Unsupported,
					AtomicWriteCommitState::NotCommitted,
					"drive mapping is not a direct volume-device root",
				));
			}
			mapping.push(u16::from(b'\\'));
			return Ok(mapping);
		}

		let error = unsafe { GetLastError() };
		if error != ERROR_INSUFFICIENT_BUFFER || capacity >= 32 * 1024 {
			return Err(win32_io_error("resolve volume device", error));
		}
		capacity = capacity
			.checked_mul(2)
			.ok_or_else(|| io_error("drive-mapping buffer size overflow"))?;
	}
}

struct Directory(OwnedHandle);

impl Directory {
	fn raw(&self) -> HANDLE {
		self.0.as_raw_handle()
	}
}

#[derive(Clone, Copy)]
struct VolumeIdentity {
	serial: u64,
}

#[derive(Clone, Copy)]
struct NtFailure {
	status: NTSTATUS,
}

impl NtFailure {
	fn is_not_found(self) -> bool {
		matches!(self.status, STATUS_OBJECT_NAME_NOT_FOUND | STATUS_OBJECT_PATH_NOT_FOUND)
	}

	fn is_name_collision(self) -> bool {
		self.status == STATUS_OBJECT_NAME_COLLISION
	}

	fn is_reparse(self) -> bool {
		matches!(self.status, STATUS_REPARSE_POINT_ENCOUNTERED | STATUS_STOPPED_ON_SYMLINK)
	}

	fn win32_error(self) -> u32 {
		unsafe { RtlNtStatusToDosError(self.status) }
	}
}

fn nt_create(
	root: HANDLE,
	name: &UnicodeName,
	desired_access: u32,
	share_access: u32,
	create_disposition: u32,
	create_options: u32,
	security: Option<&PrivateSecurityDescriptor>,
) -> Result<OwnedHandle, NtFailure> {
	let attributes = OBJECT_ATTRIBUTES {
		Length:                   size_of::<OBJECT_ATTRIBUTES>() as u32,
		RootDirectory:            root,
		ObjectName:               &name.descriptor,
		Attributes:               OBJ_CASE_INSENSITIVE | OBJ_DONT_REPARSE,
		SecurityDescriptor:       security.map_or(ptr::null(), |descriptor| descriptor.as_ptr()),
		SecurityQualityOfService: ptr::null(),
	};
	let mut handle = ptr::null_mut();
	let mut io_status = unsafe { std::mem::zeroed() };
	let status = unsafe {
		NtCreateFile(
			&mut handle,
			desired_access,
			&attributes,
			&mut io_status,
			ptr::null(),
			FILE_ATTRIBUTE_NORMAL,
			share_access,
			create_disposition,
			create_options,
			ptr::null(),
			0,
		)
	};
	if status < 0 {
		return Err(NtFailure { status });
	}
	Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

fn open_volume_root(anchor: &VolumeAnchor, access: u32) -> Result<Directory, AtomicWriteError> {
	let name = UnicodeName::native_path(anchor.native_root.clone())?;
	nt_create(
		ptr::null_mut(),
		&name,
		access,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		FILE_OPEN,
		DIRECTORY_OPEN_OPTIONS,
		None,
	)
	.map(Directory)
	.map_err(|failure| path_nt_error("open volume root", failure))
}

fn open_directory(
	parent: &Directory,
	name: &UnicodeName,
	access: u32,
) -> Result<Directory, NtFailure> {
	nt_create(
		parent.raw(),
		name,
		access,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		FILE_OPEN,
		DIRECTORY_OPEN_OPTIONS,
		None,
	)
	.map(Directory)
}

fn create_directory(
	parent: &Directory,
	name: &UnicodeName,
	private: &PrivateSecurityDescriptor,
) -> Result<Directory, NtFailure> {
	nt_create(
		parent.raw(),
		name,
		DIRECTORY_MUTATE_ACCESS,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		FILE_CREATE,
		DIRECTORY_OPEN_OPTIONS,
		Some(private),
	)
	.map(Directory)
}

fn inspect_volume_root(directory: &Directory) -> Result<VolumeIdentity, AtomicWriteError> {
	ensure_not_reparse(directory.raw())?;
	let mut info = FILE_ID_INFO::default();
	if unsafe {
		GetFileInformationByHandleEx(
			directory.raw(),
			FileIdInfo,
			(&mut info as *mut FILE_ID_INFO).cast::<c_void>(),
			size_of::<FILE_ID_INFO>() as u32,
		)
	} == 0
	{
		let error = unsafe { GetLastError() };
		return Err(win32_io_error("read volume identity", error));
	}
	Ok(VolumeIdentity { serial: info.VolumeSerialNumber })
}

fn inspect_path_object(handle: HANDLE, volume: VolumeIdentity) -> Result<(), AtomicWriteError> {
	ensure_not_reparse(handle)?;
	let mut info = FILE_ID_INFO::default();
	if unsafe {
		GetFileInformationByHandleEx(
			handle,
			FileIdInfo,
			(&mut info as *mut FILE_ID_INFO).cast::<c_void>(),
			size_of::<FILE_ID_INFO>() as u32,
		)
	} == 0
	{
		let error = unsafe { GetLastError() };
		return Err(win32_io_error("read path volume identity", error));
	}
	if info.VolumeSerialNumber != volume.serial {
		return Err(unsafe_path("path crossed away from the pinned volume"));
	}
	Ok(())
}

fn ensure_not_reparse(handle: HANDLE) -> Result<(), AtomicWriteError> {
	let mut tag = FILE_ATTRIBUTE_TAG_INFO::default();
	if unsafe {
		GetFileInformationByHandleEx(
			handle,
			FileAttributeTagInfo,
			(&mut tag as *mut FILE_ATTRIBUTE_TAG_INFO).cast::<c_void>(),
			size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
		)
	} == 0
	{
		let error = unsafe { GetLastError() };
		return Err(win32_io_error("inspect reparse attributes", error));
	}
	if tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return Err(unsafe_path("reparse points are refused in the local write path"));
	}
	Ok(())
}

fn checked_directory(
	directory: Directory,
	volume: VolumeIdentity,
	private: Option<&PrivateSecurityDescriptor>,
) -> Result<Directory, AtomicWriteError> {
	inspect_path_object(directory.raw(), volume)?;
	if let Some(private) = private {
		verify_private_object(directory.raw(), private)?;
	}
	Ok(directory)
}

fn reopen_root_parent_for_mutation(
	anchor: &VolumeAnchor,
	chain: &[Directory],
	component_index: usize,
	volume: VolumeIdentity,
) -> Result<Directory, AtomicWriteError> {
	if component_index == 0 {
		let directory = open_volume_root(anchor, DIRECTORY_CREATE_CHILD_ACCESS)?;
		return checked_directory(directory, volume, None);
	}

	let parent_name = UnicodeName::component(&anchor.components[component_index - 1])?;
	let directory =
		open_directory(&chain[component_index - 1], &parent_name, DIRECTORY_CREATE_CHILD_ACCESS)
			.map_err(|failure| path_nt_error("reopen parent directory for creation", failure))?;
	checked_directory(directory, volume, None)
}

fn walk_local_root(
	anchor: &VolumeAnchor,
	initial_volume_root: Directory,
	volume: VolumeIdentity,
	private: &PrivateSecurityDescriptor,
	cancel: &CancelToken,
) -> Result<Directory, AtomicWriteError> {
	let mut chain = vec![initial_volume_root];
	for (index, component) in anchor.components.iter().enumerate() {
		heartbeat(cancel)?;
		let name = UnicodeName::component(component)?;
		let is_local_root = index + 1 == anchor.components.len();
		let access = if is_local_root {
			DIRECTORY_MUTATE_ACCESS
		} else {
			DIRECTORY_TRAVERSE_ACCESS
		};
		let child = match open_directory(
			chain.last().expect("volume-root chain is never empty"),
			&name,
			access,
		) {
			Ok(directory) => checked_directory(directory, volume, is_local_root.then_some(private))?,
			Err(failure) if failure.is_not_found() => {
				let mutable_parent = reopen_root_parent_for_mutation(anchor, &chain, index, volume)?;
				match create_directory(&mutable_parent, &name, private) {
					Ok(directory) => {
						checked_directory(directory, volume, is_local_root.then_some(private))?
					},
					Err(failure) if failure.is_name_collision() => {
						let directory = open_directory(&mutable_parent, &name, access)
							.map_err(|failure| path_nt_error("open raced root directory", failure))?;
						checked_directory(directory, volume, is_local_root.then_some(private))?
					},
					Err(failure) => return Err(path_nt_error("create root directory", failure)),
				}
			},
			Err(failure) => return Err(path_nt_error("open root directory", failure)),
		};
		chain.push(child);
	}
	chain
		.pop()
		.ok_or_else(|| unsafe_path("absoluteRoot did not contain a local-root directory"))
}

fn open_or_create_target_directory(
	parent: &Directory,
	name: &UnicodeName,
	volume: VolumeIdentity,
	private: &PrivateSecurityDescriptor,
) -> Result<Directory, AtomicWriteError> {
	match open_directory(parent, name, DIRECTORY_MUTATE_ACCESS) {
		Ok(directory) => checked_directory(directory, volume, Some(private)),
		Err(failure) if failure.is_not_found() => match create_directory(parent, name, private) {
			Ok(directory) => checked_directory(directory, volume, Some(private)),
			Err(failure) if failure.is_name_collision() => {
				let directory = open_directory(parent, name, DIRECTORY_MUTATE_ACCESS)
					.map_err(|failure| path_nt_error("open raced target parent", failure))?;
				checked_directory(directory, volume, Some(private))
			},
			Err(failure) => Err(path_nt_error("create target parent", failure)),
		},
		Err(failure) => Err(path_nt_error("open target parent", failure)),
	}
}

fn verify_existing_target(
	parent: &Directory,
	name: &UnicodeName,
	volume: VolumeIdentity,
) -> Result<(), AtomicWriteError> {
	match nt_create(
		parent.raw(),
		name,
		FILE_READ_ATTRIBUTES | SYNCHRONIZE,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
		FILE_OPEN,
		FILE_OPEN_OPTIONS,
		None,
	) {
		Ok(handle) => inspect_path_object(handle.as_raw_handle(), volume),
		Err(failure) if failure.is_not_found() => Ok(()),
		Err(failure) => Err(path_nt_error("inspect existing target", failure)),
	}
}

struct Stage {
	file:              File,
	delete_on_failure: bool,
}

impl Stage {
	fn raw(&self) -> HANDLE {
		self.file.as_raw_handle()
	}

	fn disarm_cleanup(&mut self) {
		self.delete_on_failure = false;
	}

	/// Only used while a replacement is known not to have been attempted or is
	/// known to have failed. Calling it after an indeterminate rename could
	/// delete the committed target, so callers disarm instead in that case.
	fn cleanup_if_safe(&mut self) {
		if !self.delete_on_failure {
			return;
		}
		let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };
		if unsafe {
			SetFileInformationByHandle(
				self.raw(),
				FileDispositionInfo,
				(&disposition as *const FILE_DISPOSITION_INFO).cast::<c_void>(),
				size_of::<FILE_DISPOSITION_INFO>() as u32,
			)
		} != 0
		{
			self.delete_on_failure = false;
		}
	}
}

impl Drop for Stage {
	fn drop(&mut self) {
		self.cleanup_if_safe();
	}
}

fn stage_name(attempt: u32) -> OsString {
	let sequence = STAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
	let time = SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_nanos();
	let process = unsafe { GetCurrentProcessId() };
	OsString::from(format!(
		".omp-atomic-{time:032x}-{process:08x}-{sequence:016x}-{attempt:02x}.tmp"
	))
}

fn create_stage(
	parent: &Directory,
	volume: VolumeIdentity,
	private: &PrivateSecurityDescriptor,
	cancel: &CancelToken,
) -> Result<Stage, AtomicWriteError> {
	for attempt in 0..STAGE_ATTEMPTS {
		heartbeat(cancel)?;
		let name = UnicodeName::component(&stage_name(attempt))?;
		match nt_create(
			parent.raw(),
			&name,
			DELETE
				| FILE_WRITE_DATA
				| FILE_WRITE_ATTRIBUTES
				| FILE_READ_ATTRIBUTES
				| READ_CONTROL
				| SYNCHRONIZE,
			FILE_SHARE_NONE,
			FILE_CREATE,
			FILE_OPEN_OPTIONS,
			Some(private),
		) {
			Ok(handle) => {
				let stage = Stage { file: File::from(handle), delete_on_failure: true };
				inspect_path_object(stage.raw(), volume)?;
				verify_private_object(stage.raw(), private)?;
				return Ok(stage);
			},
			Err(failure) if failure.is_name_collision() => continue,
			Err(failure) => return Err(path_nt_error("create same-parent stage", failure)),
		}
	}
	Err(io_error("could not allocate a unique same-parent stage name"))
}

/// Builds the variable-length `FILE_RENAME_INFO` buffer before COMMITTING.
/// The target component is copied into this buffer, so no allocation or path
/// parsing is necessary after the commit latch.
struct RenameInformation {
	storage: AlignedBytes,
	length:  u32,
}

impl RenameInformation {
	fn new(target: &UnicodeName, parent: HANDLE) -> Result<Self, AtomicWriteError> {
		let name_bytes = target
			.wide
			.len()
			.checked_mul(size_of::<u16>())
			.ok_or_else(|| io_error("rename target length overflow"))?;
		let byte_length = std::mem::offset_of!(FILE_RENAME_INFORMATION, FileName)
			.checked_add(name_bytes)
			.ok_or_else(|| io_error("rename information allocation size overflow"))?;
		let length =
			u32::try_from(byte_length).map_err(|_| io_error("rename information is too large"))?;
		let mut storage = AlignedBytes::zeroed(byte_length)
			.ok_or_else(|| io_error("rename information allocation failed"))?;
		let info = storage.as_mut_ptr().cast::<FILE_RENAME_INFORMATION>();
		unsafe {
			(*info).Anonymous.ReplaceIfExists = true;
			(*info).RootDirectory = parent;
			(*info).FileNameLength = name_bytes as u32;
			ptr::copy_nonoverlapping(
				target.wide.as_ptr(),
				(*info).FileName.as_mut_ptr(),
				target.wide.len(),
			);
		}
		Ok(Self { storage, length })
	}

	fn as_ptr(&self) -> *const c_void {
		self.storage.as_ptr().cast()
	}
}

fn write_stage_and_replace(
	stage: &mut Stage,
	content: &[u8],
	made_executable: bool,
	rename: &RenameInformation,
	cancel: &CancelToken,
) -> Result<AtomicWriteOutcome, AtomicWriteError> {
	let bytes_written = u32::try_from(content.len())
		.map_err(|_| io_error("content length exceeds the atomic writer limit"))?;
	let mut written = 0;
	while written < content.len() {
		heartbeat(cancel)?;
		let count = stage
			.file
			.write(&content[written..])
			.map_err(|error| io_error(format!("write same-parent stage: {error}")))?;
		if count == 0 {
			return Err(io_error("write same-parent stage made no progress"));
		}
		written = written
			.checked_add(count)
			.ok_or_else(|| io_error("stage write length overflow"))?;
	}
	if unsafe { windows_sys::Win32::Storage::FileSystem::FlushFileBuffers(stage.raw()) } == 0 {
		let error = unsafe { GetLastError() };
		return Err(win32_io_error("flush same-parent stage", error));
	}

	// Constructed and flushed above: this is the COMMITTING latch. There is no
	// cancellation point below it, and this is the sole replacement syscall.
	heartbeat(cancel)?;
	let mut io_status = unsafe { std::mem::zeroed() };
	let status = unsafe {
		NtSetInformationFile(
			stage.raw(),
			&mut io_status,
			rename.as_ptr(),
			rename.length,
			FileRenameInformation,
		)
	};
	if status >= 0 {
		stage.disarm_cleanup();
		return Ok(AtomicWriteOutcome { bytes_written, made_executable });
	}

	let error = unsafe { RtlNtStatusToDosError(status) };
	Err(commit_error(error))
}

fn commit_error(error: u32) -> AtomicWriteError {
	if matches!(
		error,
		ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION | ERROR_LOCK_FAILED
	) {
		return AtomicWriteError::new(
			AtomicWriteErrorCode::Busy,
			AtomicWriteCommitState::NotCommitted,
			format!("atomic replacement is busy (Win32 error {error})"),
		);
	}
	if matches!(
		error,
		ERROR_DIRECTORY
			| ERROR_DIR_NOT_EMPTY
			| ERROR_FILE_NOT_FOUND
			| ERROR_INVALID_NAME
			| ERROR_INVALID_PARAMETER
			| ERROR_NOT_SAME_DEVICE
			| ERROR_NOT_SUPPORTED
			| ERROR_PATH_NOT_FOUND
	) {
		return AtomicWriteError::new(
			AtomicWriteErrorCode::Io,
			AtomicWriteCommitState::NotCommitted,
			format!("atomic replacement was rejected before completion (Win32 error {error})"),
		);
	}
	AtomicWriteError::new(
		AtomicWriteErrorCode::Io,
		AtomicWriteCommitState::Indeterminate,
		format!("atomic replacement returned an ambiguous Win32 error {error}"),
	)
}

fn heartbeat(cancel: &CancelToken) -> Result<(), AtomicWriteError> {
	cancel.heartbeat().map_err(|error| {
		AtomicWriteError::aborted(format!("atomic write cancelled before commit: {error}"))
	})
}

fn path_nt_error(context: &str, failure: NtFailure) -> AtomicWriteError {
	if failure.is_reparse() {
		return unsafe_path(format!("{context} encountered a reparse point"));
	}
	let error = failure.win32_error();
	if matches!(error, ERROR_SHARING_VIOLATION | ERROR_LOCK_VIOLATION | ERROR_LOCK_FAILED) {
		return AtomicWriteError::new(
			AtomicWriteErrorCode::Busy,
			AtomicWriteCommitState::NotCommitted,
			format!("{context} is busy (Win32 error {error})"),
		);
	}
	if error == ERROR_ACCESS_DENIED {
		return unsafe_path(format!("{context} cannot be proven safe (Win32 error {error})"));
	}
	if matches!(failure.status, STATUS_FILE_IS_A_DIRECTORY | STATUS_NOT_A_DIRECTORY) {
		return unsafe_path(format!("{context} resolved to the wrong file type"));
	}
	win32_io_error(context, error)
}

fn io_error(message: impl Into<String>) -> AtomicWriteError {
	AtomicWriteError::new(AtomicWriteErrorCode::Io, AtomicWriteCommitState::NotCommitted, message)
}

fn win32_io_error(context: &str, error: u32) -> AtomicWriteError {
	io_error(format!("{context} failed (Win32 error {error})"))
}

fn unsafe_path(message: impl Into<String>) -> AtomicWriteError {
	AtomicWriteError::new(
		AtomicWriteErrorCode::UnsafePath,
		AtomicWriteCommitState::NotCommitted,
		message,
	)
}

pub(super) fn write(
	request: &AtomicWriteRequest,
	cancel: &CancelToken,
) -> Result<AtomicWriteOutcome, AtomicWriteError> {
	if u32::try_from(request.content.len()).is_err() {
		return Err(AtomicWriteError::new(
			AtomicWriteErrorCode::InvalidInput,
			AtomicWriteCommitState::NotCommitted,
			"content exceeds the maximum supported size",
		));
	}
	if request.target_components.is_empty() {
		return Err(AtomicWriteError::new(
			AtomicWriteErrorCode::InvalidInput,
			AtomicWriteCommitState::NotCommitted,
			"targetComponents must not be empty",
		));
	}
	for component in &request.target_components {
		validate_component(&component.encode_wide().collect::<Vec<_>>())?;
	}

	let private = PrivateSecurityDescriptor::new()?;
	heartbeat(cancel)?;
	let anchor = parse_absolute_root(&request.absolute_root)?;
	let volume_root = open_volume_root(&anchor, DIRECTORY_TRAVERSE_ACCESS)?;
	let volume = inspect_volume_root(&volume_root)?;
	let mut parent = walk_local_root(&anchor, volume_root, volume, &private, cancel)?;

	for component in &request.target_components[..request.target_components.len() - 1] {
		heartbeat(cancel)?;
		let name = UnicodeName::component(component)?;
		parent = open_or_create_target_directory(&parent, &name, volume, &private)?;
	}

	let target = UnicodeName::component(
		request
			.target_components
			.last()
			.expect("targetComponents was checked non-empty"),
	)?;
	heartbeat(cancel)?;
	verify_existing_target(&parent, &target, volume)?;
	let mut stage = create_stage(&parent, volume, &private, cancel)?;
	let rename = RenameInformation::new(&target, parent.raw())?;

	// Windows has no writable execute permission bit. The result records the
	// actual operation: no execute metadata was applied even when requested.
	let made_executable = false;
	let result =
		write_stage_and_replace(&mut stage, &request.content, made_executable, &rename, cancel);
	match result {
		Ok(outcome) => Ok(outcome),
		Err(error) => {
			if error.commit_state == AtomicWriteCommitState::NotCommitted {
				stage.cleanup_if_safe();
			} else {
				stage.disarm_cleanup();
			}
			Err(error)
		},
	}
}
