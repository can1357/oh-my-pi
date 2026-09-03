//! POSIX implementation of handle-relative atomic local writes.
//!
//! Every mutable operation is relative to a descriptor opened from `/`. The
//! resulting target replacement is the only operation after the COMMITTING
//! boundary; cancellation is intentionally not observed after that point.

use std::{
	ffi::{CStr, CString, OsStr},
	io,
	mem::MaybeUninit,
	os::{
		fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
		unix::ffi::OsStrExt,
	},
	path::{Component, Path},
};

use crate::{
	atomic_write::{
		AtomicWriteCommitState, AtomicWriteError, AtomicWriteErrorCode, AtomicWriteOutcome,
		AtomicWriteRequest,
	},
	task::CancelToken,
};

const PRIVATE_DIRECTORY_MODE: libc::mode_t = 0o700;
const PRIVATE_STAGE_MODE: libc::mode_t = 0o600;
const PRIVATE_EXECUTABLE_STAGE_MODE: libc::mode_t = 0o700;
const MAX_STAGE_NAME_ATTEMPTS: usize = 64;

#[cfg(target_os = "linux")]
const RESOLVE_NO_XDEV: u64 = 0x01;
#[cfg(target_os = "linux")]
const RESOLVE_NO_SYMLINKS: u64 = 0x04;
#[cfg(target_os = "linux")]
const AT_EMPTY_PATH: libc::c_int = 0x1000;

#[cfg(target_os = "linux")]
#[repr(C)]
struct OpenHow {
	flags:   u64,
	mode:    u64,
	resolve: u64,
}

#[derive(Clone, Copy, Eq, PartialEq)]
struct FileIdentity {
	device: libc::dev_t,
	inode:  libc::ino_t,
}

/// A named staging file whose unlink-on-drop cleanup is valid only until the
/// replacement attempt begins. The descriptor is retained so cleanup can check
/// that the name still denotes this stage rather than a concurrent replacement.
struct Stage {
	file:          OwnedFd,
	parent_fd:     RawFd,
	name:          CString,
	cleanup_armed: bool,
}

impl Stage {
	fn new(file: OwnedFd, parent_fd: RawFd, name: CString) -> Self {
		Self { file, parent_fd, name, cleanup_armed: true }
	}

	fn name(&self) -> &CStr {
		&self.name
	}

	fn disarm_cleanup(&mut self) {
		self.cleanup_armed = false;
	}

	fn cleanup_if_uncommitted(&self) {
		remove_stage_if_matches(self.parent_fd, self.name(), self.file.as_raw_fd());
	}
}

impl Drop for Stage {
	fn drop(&mut self) {
		if self.cleanup_armed {
			self.cleanup_if_uncommitted();
		}
	}
}

pub(super) fn write(
	request: &AtomicWriteRequest,
	cancel_token: &CancelToken,
) -> std::result::Result<AtomicWriteOutcome, AtomicWriteError> {
	let absolute_components = absolute_root_components(&request.absolute_root)?;
	let target_components = target_component_names(&request.target_components)?;
	let bytes_written = u32::try_from(request.content.len()).map_err(|_| {
		AtomicWriteError::new(
			AtomicWriteErrorCode::InvalidInput,
			AtomicWriteCommitState::NotCommitted,
			"content exceeds the maximum atomic write size",
		)
	})?;

	heartbeat(cancel_token)?;
	let mut current = open_root().map_err(|error| precommit_io("opening /", error))?;
	for component in &absolute_components {
		current = open_or_create_directory(&current, component, None, cancel_token)?;
	}

	heartbeat(cancel_token)?;
	let local_root_device = private_directory_device(current.as_raw_fd(), "local root")?;
	let (target_name, parent_components) = target_components
		.split_last()
		.expect("target component validation rejects an empty list");
	for component in parent_components {
		current =
			open_or_create_directory(&current, component, Some(local_root_device), cancel_token)?;
	}
	reject_existing_target_link(&current, target_name, local_root_device, cancel_token)?;

	let mut stage = create_stage(&current, target_name, cancel_token)?;
	write_all(&stage, &request.content, cancel_token)?;
	set_stage_mode(&stage, request.executable, cancel_token)?;
	sync_stage(&stage, cancel_token)?;

	// The last pre-commit heartbeat is the cancellation boundary. Disarming
	// cleanup latches COMMITTING: from this point the stage name may become the
	// target, so no heartbeat or second replacement attempt is permitted.
	heartbeat(cancel_token)?;
	stage.disarm_cleanup();
	let rename_result = unsafe {
		// SAFETY: both names are NUL-terminated single components and both directory
		// descriptors refer to the same verified final-parent directory.
		libc::renameat(
			current.as_raw_fd(),
			stage.name().as_ptr(),
			current.as_raw_fd(),
			target_name.as_ptr(),
		)
	};
	if rename_result == 0 {
		return Ok(AtomicWriteOutcome { bytes_written, made_executable: request.executable });
	}

	let error = io::Error::last_os_error();
	if replacement_is_ambiguous(&error) {
		return Err(AtomicWriteError::new(
			AtomicWriteErrorCode::Io,
			AtomicWriteCommitState::Indeterminate,
			format!("atomic replacement result is indeterminate: {error}"),
		));
	}

	// A definite failed rename leaves the stage name unchanged, so it is safe to
	// remove only if it still resolves to the open stage descriptor.
	stage.cleanup_if_uncommitted();
	Err(replacement_error(error))
}

fn absolute_root_components(root: &Path) -> std::result::Result<Vec<CString>, AtomicWriteError> {
	if !root.is_absolute() {
		return Err(AtomicWriteError::invalid_input("absolute root must be absolute"));
	}

	let mut saw_root = false;
	let mut components = Vec::new();
	for component in root.components() {
		match component {
			Component::RootDir if !saw_root => saw_root = true,
			Component::Normal(component) if saw_root => {
				components.push(c_string(component, "absolute root component")?);
			},
			_ => {
				return Err(AtomicWriteError::invalid_input(
					"absolute root must be a root-to-leaf POSIX path",
				));
			},
		}
	}
	if !saw_root {
		return Err(AtomicWriteError::invalid_input("absolute root must contain /"));
	}
	Ok(components)
}

fn target_component_names(
	components: &[std::ffi::OsString],
) -> std::result::Result<Vec<CString>, AtomicWriteError> {
	if components.is_empty() {
		return Err(AtomicWriteError::invalid_input("target components must not be empty"));
	}

	components
		.iter()
		.map(|component| {
			let component = component.as_os_str();
			let bytes = component.as_bytes();
			if bytes.is_empty()
				|| bytes == b"."
				|| bytes == b".."
				|| bytes
					.iter()
					.any(|byte| matches!(*byte, b'/' | b'\\' | b'\0'))
			{
				return Err(AtomicWriteError::invalid_input(
					"target components must be non-empty single names",
				));
			}
			c_string(component, "target component")
		})
		.collect()
}

fn c_string(value: &OsStr, label: &str) -> std::result::Result<CString, AtomicWriteError> {
	CString::new(value.as_bytes())
		.map_err(|_| AtomicWriteError::invalid_input(format!("{label} must not contain NUL bytes")))
}

fn heartbeat(cancel_token: &CancelToken) -> std::result::Result<(), AtomicWriteError> {
	cancel_token.heartbeat().map_err(|error| {
		AtomicWriteError::aborted(format!("atomic write cancelled before commit: {error}"))
	})
}

fn owned_fd(fd: RawFd) -> io::Result<OwnedFd> {
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: a nonnegative descriptor returned by the caller's open operation has
	// one owner; `OwnedFd` takes that ownership and closes it exactly once on drop.
	Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

fn open_root() -> io::Result<OwnedFd> {
	// SAFETY: the byte string is a static, NUL-terminated POSIX root path.
	let root = unsafe { CStr::from_bytes_with_nul_unchecked(b"/\0") };
	let fd = unsafe {
		// SAFETY: `root` is NUL-terminated and the flags only open a directory
		// descriptor; no filesystem mutation occurs here.
		libc::open(
			root.as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	owned_fd(fd)
}

fn open_or_create_directory(
	parent: &OwnedFd,
	name: &CStr,
	local_root_device: Option<libc::dev_t>,
	cancel_token: &CancelToken,
) -> std::result::Result<OwnedFd, AtomicWriteError> {
	loop {
		heartbeat(cancel_token)?;
		match open_directory_at(parent.as_raw_fd(), name, local_root_device.is_some()) {
			Ok(directory) => {
				if let Some(expected_device) = local_root_device {
					heartbeat(cancel_token)?;
					let actual_device =
						private_directory_device(directory.as_raw_fd(), "descendant directory")?;
					if actual_device != expected_device {
						return Err(AtomicWriteError::new(
							AtomicWriteErrorCode::UnsafePath,
							AtomicWriteCommitState::NotCommitted,
							"a descendant directory crosses the local-root device boundary",
						));
					}
				}
				return Ok(directory);
			},
			Err(error) if is_errno(&error, libc::ENOENT) => {
				heartbeat(cancel_token)?;
				let mkdir_result = unsafe {
					// SAFETY: `parent` is an open directory descriptor and `name` is a
					// NUL-terminated validated single component.
					libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), PRIVATE_DIRECTORY_MODE)
				};
				if mkdir_result == 0 {
					continue;
				}
				let mkdir_error = io::Error::last_os_error();
				if is_errno(&mkdir_error, libc::EEXIST) || is_errno(&mkdir_error, libc::EINTR) {
					continue;
				}
				return Err(precommit_io("creating a private directory", mkdir_error));
			},
			Err(error) => return Err(precommit_io("opening a directory component", error)),
		}
	}
}

fn open_directory_at(parent_fd: RawFd, name: &CStr, reject_mounts: bool) -> io::Result<OwnedFd> {
	#[cfg(target_os = "linux")]
	if reject_mounts {
		match open_directory_at_no_xdev(parent_fd, name) {
			Ok(directory) => return Ok(directory),
			Err(error) if openat2_is_unavailable(&error) => {},
			Err(error) => return Err(error),
		}
	}

	let fd = unsafe {
		// SAFETY: `name` is NUL-terminated and `parent_fd` is an open directory
		// descriptor. O_NOFOLLOW and O_DIRECTORY reject links and non-directories.
		libc::openat(
			parent_fd,
			name.as_ptr(),
			libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
		)
	};
	owned_fd(fd)
}

#[cfg(target_os = "linux")]
fn open_directory_at_no_xdev(parent_fd: RawFd, name: &CStr) -> io::Result<OwnedFd> {
	let how = OpenHow {
		flags:   (libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) as u64,
		mode:    0,
		resolve: RESOLVE_NO_XDEV | RESOLVE_NO_SYMLINKS,
	};
	let fd = unsafe {
		// SAFETY: `name` is NUL-terminated, `how` has the kernel ABI layout, and
		// `parent_fd` is an open directory descriptor.
		libc::syscall(
			libc::SYS_openat2,
			parent_fd,
			name.as_ptr(),
			std::ptr::addr_of!(how),
			std::mem::size_of::<OpenHow>(),
		)
	};
	if fd < 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: a nonnegative openat2 return value is a newly owned descriptor.
	Ok(unsafe { OwnedFd::from_raw_fd(fd as RawFd) })
}

#[cfg(target_os = "linux")]
fn openat2_is_unavailable(error: &io::Error) -> bool {
	is_errno(error, libc::ENOSYS) || is_errno(error, libc::EINVAL)
}

fn private_directory_device(
	fd: RawFd,
	label: &str,
) -> std::result::Result<libc::dev_t, AtomicWriteError> {
	let stat = fd_stat(fd).map_err(|error| precommit_io(&format!("inspecting {label}"), error))?;
	if stat.st_mode & libc::S_IFMT != libc::S_IFDIR {
		return Err(AtomicWriteError::new(
			AtomicWriteErrorCode::UnsafePath,
			AtomicWriteCommitState::NotCommitted,
			format!("{label} is not a directory"),
		));
	}
	let owner = unsafe { libc::geteuid() };
	let permissions = stat.st_mode & 0o777;
	if stat.st_uid != owner || permissions & 0o022 != 0 {
		return Err(AtomicWriteError::new(
			AtomicWriteErrorCode::UnsafePath,
			AtomicWriteCommitState::NotCommitted,
			format!(
				"{label} must be owned by the invoking user and not group/other-writable (owner {}, \
				 mode {:04o})",
				stat.st_uid, permissions
			),
		));
	}
	if permissions != PRIVATE_DIRECTORY_MODE {
		tighten_private_directory_mode(fd, label)?;
		let tightened =
			fd_stat(fd).map_err(|error| precommit_io(&format!("rechecking {label}"), error))?;
		if tightened.st_uid != owner || tightened.st_mode & 0o777 != PRIVATE_DIRECTORY_MODE {
			return Err(AtomicWriteError::new(
				AtomicWriteErrorCode::UnsafePath,
				AtomicWriteCommitState::NotCommitted,
				format!("{label} could not be secured to owner-only mode 0700"),
			));
		}
	}
	Ok(stat.st_dev)
}

fn tighten_private_directory_mode(
	fd: RawFd,
	label: &str,
) -> std::result::Result<(), AtomicWriteError> {
	loop {
		let result = unsafe {
			// SAFETY: `fd` is the already-open directory descriptor whose owner and
			// non-writable mode were verified immediately before this call.
			libc::fchmod(fd, PRIVATE_DIRECTORY_MODE)
		};
		if result == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		if is_errno(&error, libc::EINTR) {
			continue;
		}
		return Err(precommit_io(&format!("securing {label} to mode 0700"), error));
	}
}

fn fd_identity(fd: RawFd) -> io::Result<FileIdentity> {
	let stat = fd_stat(fd)?;
	Ok(FileIdentity { device: stat.st_dev, inode: stat.st_ino })
}

fn fd_stat(fd: RawFd) -> io::Result<libc::stat> {
	let mut stat = MaybeUninit::<libc::stat>::zeroed();
	let result = unsafe {
		// SAFETY: `stat` points to valid writable storage and `fd` is a live
		// descriptor for the duration of this metadata query.
		libc::fstat(fd, stat.as_mut_ptr())
	};
	if result != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: successful fstat initializes every field of `stat`.
	Ok(unsafe { stat.assume_init() })
}

fn create_stage(
	parent: &OwnedFd,
	target_name: &CStr,
	cancel_token: &CancelToken,
) -> std::result::Result<Stage, AtomicWriteError> {
	#[cfg(target_os = "linux")]
	if let Some(stage) = try_create_tmpfile_stage(parent, target_name, cancel_token)? {
		return Ok(stage);
	}

	create_named_stage(parent, target_name, cancel_token)
}

#[cfg(target_os = "linux")]
fn try_create_tmpfile_stage(
	parent: &OwnedFd,
	target_name: &CStr,
	cancel_token: &CancelToken,
) -> std::result::Result<Option<Stage>, AtomicWriteError> {
	heartbeat(cancel_token)?;
	// SAFETY: the byte string is a static NUL-terminated single component.
	let dot = unsafe { CStr::from_bytes_with_nul_unchecked(b".\0") };
	let fd = unsafe {
		// SAFETY: `parent` is an open directory descriptor and `dot` is a
		// NUL-terminated component naming that directory itself.
		libc::openat(
			parent.as_raw_fd(),
			dot.as_ptr(),
			libc::O_WRONLY | libc::O_TMPFILE | libc::O_CLOEXEC,
			PRIVATE_STAGE_MODE as libc::c_uint,
		)
	};
	if fd < 0 {
		let error = io::Error::last_os_error();
		if tmpfile_is_unavailable(&error) {
			return Ok(None);
		}
		return Err(precommit_io("creating an unnamed private stage", error));
	}
	// SAFETY: a nonnegative openat return value is a newly owned descriptor.
	let file = unsafe { OwnedFd::from_raw_fd(fd) };

	for _ in 0..MAX_STAGE_NAME_ATTEMPTS {
		let name = stage_name(target_name, cancel_token)?;
		// SAFETY: the byte string is a static NUL-terminated empty pathname used
		// with Linux's AT_EMPTY_PATH extension to name the O_TMPFILE descriptor.
		let empty = unsafe { CStr::from_bytes_with_nul_unchecked(b"\0") };
		let link_result = unsafe {
			// SAFETY: `file` and `parent` are live descriptors, and both names are
			// NUL-terminated. The new name is a validated private stage component.
			libc::linkat(
				file.as_raw_fd(),
				empty.as_ptr(),
				parent.as_raw_fd(),
				name.as_ptr(),
				AT_EMPTY_PATH,
			)
		};
		if link_result == 0 {
			return Ok(Some(Stage::new(file, parent.as_raw_fd(), name)));
		}

		let error = io::Error::last_os_error();
		if is_errno(&error, libc::EEXIST) {
			continue;
		}
		remove_stage_if_matches(parent.as_raw_fd(), &name, file.as_raw_fd());
		if tmpfile_link_is_unavailable(&error) {
			return Ok(None);
		}
		return Err(precommit_io("naming an unnamed private stage", error));
	}

	Err(AtomicWriteError::new(
		AtomicWriteErrorCode::Io,
		AtomicWriteCommitState::NotCommitted,
		"could not allocate a unique private stage name",
	))
}

#[cfg(target_os = "linux")]
fn tmpfile_is_unavailable(error: &io::Error) -> bool {
	is_errno(error, libc::EOPNOTSUPP)
		|| is_errno(error, libc::EINVAL)
		|| is_errno(error, libc::ENOSYS)
}

#[cfg(target_os = "linux")]
fn tmpfile_link_is_unavailable(error: &io::Error) -> bool {
	is_errno(error, libc::EPERM)
		|| is_errno(error, libc::EOPNOTSUPP)
		|| is_errno(error, libc::EINVAL)
		|| is_errno(error, libc::ENOSYS)
}

fn create_named_stage(
	parent: &OwnedFd,
	target_name: &CStr,
	cancel_token: &CancelToken,
) -> std::result::Result<Stage, AtomicWriteError> {
	for _ in 0..MAX_STAGE_NAME_ATTEMPTS {
		let name = stage_name(target_name, cancel_token)?;
		let fd = unsafe {
			// SAFETY: `parent` is an open directory descriptor and `name` is a
			// NUL-terminated randomized single component.
			libc::openat(
				parent.as_raw_fd(),
				name.as_ptr(),
				libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
				PRIVATE_STAGE_MODE as libc::c_uint,
			)
		};
		if fd >= 0 {
			// SAFETY: a nonnegative openat return value is a newly owned descriptor.
			let file = unsafe { OwnedFd::from_raw_fd(fd) };
			return Ok(Stage::new(file, parent.as_raw_fd(), name));
		}

		let error = io::Error::last_os_error();
		if is_errno(&error, libc::EEXIST) || is_errno(&error, libc::EINTR) {
			continue;
		}
		return Err(precommit_io("creating a private stage", error));
	}

	Err(AtomicWriteError::new(
		AtomicWriteErrorCode::Io,
		AtomicWriteCommitState::NotCommitted,
		"could not allocate a unique private stage name",
	))
}

fn stage_name(
	target_name: &CStr,
	cancel_token: &CancelToken,
) -> std::result::Result<CString, AtomicWriteError> {
	let mut nonce = [0_u8; 16];
	heartbeat(cancel_token)?;
	fill_random(&mut nonce).map_err(|error| precommit_io("generating a stage name", error))?;

	let mut bytes = Vec::with_capacity(b".omp-atomic-".len() + nonce.len() * 2);
	bytes.extend_from_slice(b".omp-atomic-");
	for byte in nonce {
		const HEX: &[u8; 16] = b"0123456789abcdef";
		bytes.push(HEX[usize::from(byte >> 4)]);
		bytes.push(HEX[usize::from(byte & 0x0f)]);
	}
	let name = CString::new(bytes).map_err(|_| {
		AtomicWriteError::new(
			AtomicWriteErrorCode::Io,
			AtomicWriteCommitState::NotCommitted,
			"generated an invalid private stage name",
		)
	})?;
	if name.as_c_str() == target_name {
		return Err(AtomicWriteError::new(
			AtomicWriteErrorCode::Io,
			AtomicWriteCommitState::NotCommitted,
			"generated a stage name equal to the target name",
		));
	}
	Ok(name)
}

#[cfg(target_os = "linux")]
fn fill_random(bytes: &mut [u8]) -> io::Result<()> {
	let mut written = 0;
	while written < bytes.len() {
		let result = unsafe {
			// SAFETY: the remaining slice is writable for the specified byte count.
			libc::syscall(
				libc::SYS_getrandom,
				bytes[written..].as_mut_ptr().cast::<libc::c_void>(),
				bytes.len() - written,
				0_u32,
			)
		};
		if result < 0 {
			let error = io::Error::last_os_error();
			if is_errno(&error, libc::EINTR) {
				continue;
			}
			return Err(error);
		}
		if result == 0 {
			return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "getrandom returned no bytes"));
		}
		written += result as usize;
	}
	Ok(())
}

#[cfg(target_os = "macos")]
fn fill_random(bytes: &mut [u8]) -> io::Result<()> {
	unsafe {
		// SAFETY: `bytes` is writable for its full length; Darwin's arc4random_buf
		// fills it from the kernel-backed CSPRNG and has no error return.
		libc::arc4random_buf(bytes.as_mut_ptr().cast::<libc::c_void>(), bytes.len());
	}
	Ok(())
}

fn write_all(
	stage: &Stage,
	content: &[u8],
	cancel_token: &CancelToken,
) -> std::result::Result<(), AtomicWriteError> {
	let mut offset = 0;
	while offset < content.len() {
		heartbeat(cancel_token)?;
		let remaining = content.len() - offset;
		let write_len = remaining.min(isize::MAX as usize);
		let written = unsafe {
			// SAFETY: the remaining content slice is readable for `write_len` bytes
			// and the stage descriptor remains open for this write.
			libc::write(
				stage.file.as_raw_fd(),
				content[offset..].as_ptr().cast::<libc::c_void>(),
				write_len,
			)
		};
		if written < 0 {
			let error = io::Error::last_os_error();
			if is_errno(&error, libc::EINTR) {
				continue;
			}
			return Err(precommit_io("writing the private stage", error));
		}
		if written == 0 {
			return Err(AtomicWriteError::new(
				AtomicWriteErrorCode::Io,
				AtomicWriteCommitState::NotCommitted,
				"writing the private stage made no progress",
			));
		}
		offset += written as usize;
	}
	Ok(())
}

fn set_stage_mode(
	stage: &Stage,
	executable: bool,
	cancel_token: &CancelToken,
) -> std::result::Result<(), AtomicWriteError> {
	let mode = if executable {
		PRIVATE_EXECUTABLE_STAGE_MODE
	} else {
		PRIVATE_STAGE_MODE
	};
	loop {
		heartbeat(cancel_token)?;
		let result = unsafe {
			// SAFETY: the stage descriptor is open and owned for this metadata update.
			libc::fchmod(stage.file.as_raw_fd(), mode)
		};
		if result == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		if is_errno(&error, libc::EINTR) {
			continue;
		}
		return Err(precommit_io("applying private stage permissions", error));
	}
}

fn sync_stage(
	stage: &Stage,
	cancel_token: &CancelToken,
) -> std::result::Result<(), AtomicWriteError> {
	loop {
		heartbeat(cancel_token)?;
		let result = unsafe {
			// SAFETY: the stage descriptor is open and owned for this sync operation.
			libc::fsync(stage.file.as_raw_fd())
		};
		if result == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		if is_errno(&error, libc::EINTR) {
			continue;
		}
		return Err(precommit_io("syncing the private stage", error));
	}
}

fn remove_stage_if_matches(parent_fd: RawFd, name: &CStr, stage_fd: RawFd) {
	let Ok(stage_identity) = fd_identity(stage_fd) else {
		return;
	};
	let Ok(named_identity) = name_identity(parent_fd, name) else {
		return;
	};
	if named_identity != stage_identity {
		return;
	}
	unsafe {
		// SAFETY: `parent_fd` is a live directory descriptor and `name` is a
		// NUL-terminated stage component. This never names the target component.
		let _ = libc::unlinkat(parent_fd, name.as_ptr(), 0);
	}
}

fn reject_existing_target_link(
	parent: &OwnedFd,
	target_name: &CStr,
	local_root_device: libc::dev_t,
	cancel_token: &CancelToken,
) -> std::result::Result<(), AtomicWriteError> {
	loop {
		heartbeat(cancel_token)?;
		match name_stat(parent.as_raw_fd(), target_name) {
			Ok(stat) if stat.st_dev != local_root_device => {
				return Err(AtomicWriteError::new(
					AtomicWriteErrorCode::UnsafePath,
					AtomicWriteCommitState::NotCommitted,
					"the target name crosses the local-root device boundary",
				));
			},
			Ok(stat) if stat.st_mode & libc::S_IFMT == libc::S_IFLNK => {
				return Err(AtomicWriteError::new(
					AtomicWriteErrorCode::UnsafePath,
					AtomicWriteCommitState::NotCommitted,
					"the target name is a symbolic link",
				));
			},
			Ok(_) => return Ok(()),
			Err(error) if is_errno(&error, libc::ENOENT) => return Ok(()),
			Err(error) if is_errno(&error, libc::EINTR) => continue,
			Err(error) => return Err(precommit_io("inspecting the target name", error)),
		}
	}
}

fn name_identity(parent_fd: RawFd, name: &CStr) -> io::Result<FileIdentity> {
	let stat = name_stat(parent_fd, name)?;
	Ok(FileIdentity { device: stat.st_dev, inode: stat.st_ino })
}

fn name_stat(parent_fd: RawFd, name: &CStr) -> io::Result<libc::stat> {
	let mut stat = MaybeUninit::<libc::stat>::zeroed();
	let result = unsafe {
		// SAFETY: `stat` is writable and `name` is a NUL-terminated component for
		// a no-follow metadata query rooted at the live parent descriptor.
		libc::fstatat(parent_fd, name.as_ptr(), stat.as_mut_ptr(), libc::AT_SYMLINK_NOFOLLOW)
	};
	if result != 0 {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: successful fstatat initializes every field of `stat`.
	Ok(unsafe { stat.assume_init() })
}

fn replacement_is_ambiguous(error: &io::Error) -> bool {
	matches!(error.raw_os_error(), Some(libc::EINTR | libc::EIO | libc::ESTALE | libc::ETIMEDOUT))
}

fn replacement_error(error: io::Error) -> AtomicWriteError {
	let code = if is_errno(&error, libc::EBUSY) {
		AtomicWriteErrorCode::Busy
	} else if is_unsafe_path_error(&error) {
		AtomicWriteErrorCode::UnsafePath
	} else {
		AtomicWriteErrorCode::Io
	};
	AtomicWriteError::new(
		code,
		AtomicWriteCommitState::NotCommitted,
		format!("atomic replacement failed without committing: {error}"),
	)
}

fn precommit_io(operation: &str, error: io::Error) -> AtomicWriteError {
	let code = if is_errno(&error, libc::EBUSY) {
		AtomicWriteErrorCode::Busy
	} else if is_unsafe_path_error(&error) {
		AtomicWriteErrorCode::UnsafePath
	} else {
		AtomicWriteErrorCode::Io
	};
	AtomicWriteError::new(
		code,
		AtomicWriteCommitState::NotCommitted,
		format!("atomic local write failed while {operation}: {error}"),
	)
}

fn is_unsafe_path_error(error: &io::Error) -> bool {
	matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR | libc::EXDEV))
}

fn is_errno(error: &io::Error, errno: libc::c_int) -> bool {
	error.raw_os_error() == Some(errno)
}
