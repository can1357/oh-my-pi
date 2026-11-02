use std::{
	io,
	os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
	ptr,
};

use windows_sys::{
	Wdk::{
		Foundation::OBJECT_ATTRIBUTES,
		Storage::FileSystem::{NtOpenDirectoryObject, NtQueryDirectoryObject},
	},
	Win32::{
		Foundation::{
			ERROR_ALREADY_EXISTS, GetLastError, NTSTATUS, OBJ_CASE_INSENSITIVE, RtlNtStatusToDosError,
			STATUS_MORE_ENTRIES, STATUS_NO_MORE_ENTRIES, SetLastError, UNICODE_STRING,
		},
		System::Threading::{CreateMutexExW, SYNCHRONIZATION_SYNCHRONIZE},
	},
};

/// Windows lease held by the exclusive lifetime of a named kernel object.
pub struct PlatformFileLock {
	handle: Option<OwnedHandle>,
}

fn wide_name(path: &str) -> Vec<u16> {
	format!(r"Global\{}", super::memory_lock_name(path))
		.encode_utf16()
		.chain(std::iter::once(0))
		.collect()
}

pub fn try_acquire(path: &str) -> io::Result<Option<PlatformFileLock>> {
	let wide_name = wide_name(path);

	// The name's existence, not thread-affine mutex ownership, is the lease.
	// A handle can therefore be released from a different native worker thread.
	// Contenders see ERROR_ALREADY_EXISTS and immediately close their handle.
	// CreateMutexW requests MUTEX_ALL_ACCESS for an existing object. A lease
	// only needs a handle, so do not reject a contender allowed to synchronize
	// but not to modify the owner's security descriptor.
	// SAFETY: SetLastError(0) safely resets the thread-local error status before
	// the call.
	unsafe { SetLastError(0) };
	// SAFETY: the attributes pointer is null, and `wide_name` is a live,
	// NUL-terminated UTF-16 string for the duration of the call.
	let raw_handle =
		unsafe { CreateMutexExW(ptr::null(), wide_name.as_ptr(), 0, SYNCHRONIZATION_SYNCHRONIZE) };
	if raw_handle.is_null() {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `CreateMutexExW` returned a fresh owned handle. `OwnedHandle`
	// closes it exactly once on every return path.
	let handle = unsafe { OwnedHandle::from_raw_handle(raw_handle) };
	// SAFETY: this immediately observes the last-error value set by
	// `CreateMutexExW`; no intervening system call can overwrite it.
	if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
		return Ok(None);
	}
	Ok(Some(PlatformFileLock { handle: Some(handle) }))
}

/// The object-manager directory that `Global\` names live in.
const BASE_NAMED_OBJECTS: &str = r"\BaseNamedObjects";
/// `DIRECTORY_QUERY` access (wdm.h), defined here to avoid the large
/// `Wdk_System_SystemServices` feature for one constant.
const DIRECTORY_QUERY: u32 = 0x0001;
/// First listing buffer, enough for a typical `\BaseNamedObjects` in one call.
const LISTING_START_BYTES: usize = 64 * 1024;
/// Largest listing buffer before falling back to paging (tens of thousands of
/// objects).
const LISTING_MAX_BYTES: usize = 4 * 1024 * 1024;

/// One `NtQueryDirectoryObject` entry (`OBJECT_DIRECTORY_INFORMATION`).
#[repr(C)]
struct ObjectDirectoryInformation {
	name:      UNICODE_STRING,
	type_name: UNICODE_STRING,
}

fn nt_result(status: NTSTATUS) -> io::Result<()> {
	if status >= 0 {
		return Ok(());
	}
	// SAFETY: a pure status-code translation.
	let code = unsafe { RtlNtStatusToDosError(status) };
	Err(io::Error::from_raw_os_error(code.cast_signed()))
}

/// Looks the name up by listing `\BaseNamedObjects` instead of opening the
/// mutex: any open handle, even one that only observes, keeps a releasing
/// holder's object alive, so a racing `try_acquire` would see
/// `ERROR_ALREADY_EXISTS` with no owner left. A directory listing references
/// no object, so a concurrent `try_acquire` never meets this probe. The listing
/// needs no access to the mutex itself, so an owner that denies access still
/// reads as held.
// shortcut: lists the whole directory per probe. A listing that fits one call
// is a snapshot taken under the directory's lock, so the buffer grows (up to
// LISTING_MAX_BYTES) until it does; only a larger directory is read in pages,
// where an insert between pages can skip the name and misreport a held lease
// as free (never blocking a claim).
pub fn is_held(path: &str) -> io::Result<bool> {
	let name: Vec<u16> = super::memory_lock_name(path).encode_utf16().collect();
	let directory_name: Vec<u16> = BASE_NAMED_OBJECTS.encode_utf16().collect();
	let directory_bytes = u16::try_from(directory_name.len() * 2).expect("short directory name");
	let directory_unicode = UNICODE_STRING {
		Length:        directory_bytes,
		MaximumLength: directory_bytes,
		Buffer:        directory_name.as_ptr().cast_mut(),
	};
	let attributes = OBJECT_ATTRIBUTES {
		Length:                   u32::try_from(size_of::<OBJECT_ATTRIBUTES>())
			.expect("attributes size"),
		RootDirectory:            ptr::null_mut(),
		ObjectName:               &raw const directory_unicode,
		Attributes:               OBJ_CASE_INSENSITIVE,
		SecurityDescriptor:       ptr::null(),
		SecurityQualityOfService: ptr::null(),
	};
	let mut raw_directory = ptr::null_mut();
	// SAFETY: `attributes` and the name it points to outlive the call, and
	// `raw_directory` receives the opened handle.
	nt_result(unsafe {
		NtOpenDirectoryObject(&raw mut raw_directory, DIRECTORY_QUERY, &raw const attributes)
	})?;
	// SAFETY: the successful call returned one owned handle.
	let directory = unsafe { OwnedHandle::from_raw_handle(raw_directory) };

	// u64 elements keep the buffer aligned for the pointer-bearing entries.
	let mut buffer = vec![0_u64; LISTING_START_BYTES / size_of::<u64>()];
	let mut context = 0_u32;
	let mut restart = true;
	loop {
		let buffer_bytes = u32::try_from(buffer.len() * size_of::<u64>()).expect("buffer size");
		let mut returned = 0_u32;
		// SAFETY: `buffer` is writable for `buffer_bytes` and outlives the call;
		// `context` and `returned` are valid out-parameters.
		let status = unsafe {
			NtQueryDirectoryObject(
				directory.as_raw_handle(),
				buffer.as_mut_ptr().cast(),
				buffer_bytes,
				false,
				restart,
				&raw mut context,
				&raw mut returned,
			)
		};
		if restart
			&& status == STATUS_MORE_ENTRIES
			&& buffer.len() * size_of::<u64>() < LISTING_MAX_BYTES
		{
			// Retake the whole listing in one call rather than paging it.
			buffer = vec![0_u64; buffer.len() * 2];
			continue;
		}
		restart = false;
		if status == STATUS_NO_MORE_ENTRIES {
			return Ok(false);
		}
		nt_result(status)?;
		// Scan no further than the bytes this call wrote (and the buffer), so a
		// missing terminator can never expose a previous page's stale entries.
		let written = usize::try_from(returned)
			.unwrap_or(usize::MAX)
			.min(buffer.len() * size_of::<u64>());
		let entries = buffer.as_ptr().cast::<ObjectDirectoryInformation>();
		for index in 0..written / size_of::<ObjectDirectoryInformation>() {
			// SAFETY: `index` addresses an entry inside the `written` bytes this
			// call filled; their names point into `buffer`, which is still
			// borrowed.
			let entry = unsafe { &*entries.add(index) };
			if entry.name.Buffer.is_null() {
				break;
			}
			// SAFETY: `Length` bytes of UTF-16 at `Buffer`, inside `buffer`.
			let found = unsafe {
				std::slice::from_raw_parts(entry.name.Buffer, usize::from(entry.name.Length / 2))
			};
			if found == name.as_slice() {
				return Ok(true);
			}
		}
		if status != STATUS_MORE_ENTRIES {
			return Ok(false);
		}
	}
}

impl PlatformFileLock {
	#[allow(clippy::unnecessary_wraps, reason = "uniform cross-platform interface")]
	pub fn release(&mut self) -> io::Result<()> {
		drop(self.handle.take());
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicBool, Ordering},
		},
		thread,
		time::{SystemTime, UNIX_EPOCH},
	};

	use windows_sys::Win32::Security::{
		ACL_REVISION, AddAccessAllowedAce, InitializeAcl, SE_DACL_PRESENT, SECURITY_ATTRIBUTES,
		SECURITY_DESCRIPTOR, SECURITY_WORLD_SID_AUTHORITY, SID,
	};

	use super::*;

	fn restricted_mutex(path: &str, allowed_access: u32) -> OwnedHandle {
		let mut sid = SID {
			Revision:            1,
			SubAuthorityCount:   1,
			IdentifierAuthority: SECURITY_WORLD_SID_AUTHORITY,
			SubAuthority:        [0],
		};
		let mut acl_storage = [0_u32; 16];
		let acl = acl_storage.as_mut_ptr().cast();
		// SAFETY: storage is DWORD-aligned and has room for an ACL and one
		// allowed ACE containing the complete Everyone SID.
		unsafe {
			assert_ne!(InitializeAcl(acl, 64, ACL_REVISION), 0);
			assert_ne!(
				AddAccessAllowedAce(acl, ACL_REVISION, allowed_access, (&raw mut sid).cast()),
				0
			);
		}
		let mut descriptor = SECURITY_DESCRIPTOR {
			Revision: 1,
			Control: SE_DACL_PRESENT,
			Dacl: acl,
			..SECURITY_DESCRIPTOR::default()
		};
		let attributes = SECURITY_ATTRIBUTES {
			nLength:              size_of::<SECURITY_ATTRIBUTES>()
				.try_into()
				.expect("attributes size"),
			lpSecurityDescriptor: (&raw mut descriptor).cast(),
			bInheritHandle:       0,
		};
		let name = wide_name(path);
		// SAFETY: descriptor, ACL, SID, and NUL-terminated name all remain
		// valid for the call. Zero access is enough to hold the object's
		// lifetime.
		let handle = unsafe { CreateMutexExW(&raw const attributes, name.as_ptr(), 0, 0) };
		assert!(!handle.is_null(), "{}", io::Error::last_os_error());
		// SAFETY: the successful call returned one owned handle.
		unsafe { OwnedHandle::from_raw_handle(handle) }
	}

	#[test]
	fn limited_access_contender_observes_held_lease_and_can_acquire_after_release() {
		let path = format!("oauth-lock-limited-{}", std::process::id());
		let owner = restricted_mutex(&path, SYNCHRONIZATION_SYNCHRONIZE);
		assert!(
			try_acquire(&path)
				.expect("limited-access contention")
				.is_none()
		);
		drop(owner);
		let mut successor = try_acquire(&path)
			.expect("acquire after release")
			.expect("exclusive lease");
		successor.release().expect("release successor");
	}

	#[test]
	fn denied_access_is_not_treated_as_contention() {
		let path = format!("oauth-lock-denied-{}", std::process::id());
		let _owner = restricted_mutex(&path, 0);
		let Err(error) = try_acquire(&path) else {
			panic!("denied access must remain an error");
		};
		assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
	}

	#[test]
	fn probe_reports_an_owner_that_denies_access_as_held() {
		let path = format!("oauth-lock-probe-denied-{}", std::process::id());
		assert!(!is_held(&path).expect("probe free name"));
		let owner = restricted_mutex(&path, 0);
		assert!(is_held(&path).expect("probe denied owner"));
		drop(owner);
		assert!(!is_held(&path).expect("probe released name"));
	}

	#[test]
	fn probe_never_makes_a_racing_acquire_fail() {
		let path = format!("oauth-lock-probe-race-{}", std::process::id());
		let stop = Arc::new(AtomicBool::new(false));
		let probe_thread = {
			let (path, stop) = (path.clone(), Arc::clone(&stop));
			thread::spawn(move || {
				let (mut probes, mut held) = (0_u64, 0_u64);
				while !stop.load(Ordering::Relaxed) {
					probes += 1;
					held += u64::from(is_held(&path).expect("probe"));
				}
				(probes, held)
			})
		};
		let mut failures = 0;
		for _ in 0..20_000 {
			match try_acquire(&path).expect("acquire") {
				Some(mut lease) => lease.release().expect("release"),
				None => failures += 1,
			}
		}
		stop.store(true, Ordering::Relaxed);
		let (probes, held) = probe_thread.join().expect("probe thread");
		assert_eq!(failures, 0, "{held} of {probes} probes saw the lease");
		assert!(held > 0, "the probe never overlapped a holder ({probes} probes)");
	}

	#[test]
	fn releases_from_a_different_worker_thread() {
		let nonce = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.expect("system clock")
			.as_nanos();
		let path = format!("oauth-lock-thread-{}-{nonce}", std::process::id());
		let mut lease = try_acquire(&path)
			.expect("acquire lease")
			.expect("exclusive lease");
		assert!(try_acquire(&path).expect("contend").is_none());
		thread::spawn(move || lease.release().expect("release on another worker"))
			.join()
			.expect("worker completed");
		let mut successor = try_acquire(&path)
			.expect("acquire successor")
			.expect("released lease");
		successor.release().expect("release successor");
	}
}
