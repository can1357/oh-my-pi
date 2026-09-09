#[cfg(any(windows, test))]
use std::path::{Path, PathBuf};

#[cfg(windows)]
use crate::{Backend, CleanupFailure, SandboxError, SandboxOperation};

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AclAccess {
	Traverse,
	ReadExecute,
	WriteDelete,
	ReadWriteExecuteDelete,
}

#[cfg(any(windows, test))]
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AclMutation {
	pub(crate) path:   PathBuf,
	pub(crate) access: AclAccess,
	pub(crate) deny:   bool,
}

/// Expands the policy-level ordering. Runtime tree expansion preserves this
/// ordering: every deny is installed before any traversal or allow grant.
#[cfg(any(windows, test))]
pub(crate) fn mutation_plan(
	read_deny: &[PathBuf],
	write_deny: &[PathBuf],
	read_grants: &[PathBuf],
	write_grants: &[PathBuf],
) -> Vec<AclMutation> {
	let mut mutations = Vec::new();
	mutations.extend(read_deny.iter().cloned().map(|path| AclMutation {
		path,
		access: AclAccess::ReadExecute,
		deny: true,
	}));
	mutations.extend(write_deny.iter().cloned().map(|path| AclMutation {
		path,
		access: AclAccess::WriteDelete,
		deny: true,
	}));
	for path in read_grants {
		mutations.push(AclMutation {
			path:   path.clone(),
			access: AclAccess::ReadExecute,
			deny:   false,
		});
	}
	for path in write_grants {
		mutations.push(AclMutation {
			path:   path.clone(),
			access: AclAccess::ReadWriteExecuteDelete,
			deny:   false,
		});
	}
	mutations
}

#[cfg(windows)]
pub(crate) struct AclMutationStack {
	sid:     windows_sys::Win32::Security::PSID,
	applied: Vec<AclMutation>,
}

#[cfg(windows)]
impl AclMutationStack {
	pub(crate) fn apply(
		sid: windows_sys::Win32::Security::PSID,
		read_deny: &[PathBuf],
		write_deny: &[PathBuf],
		read_grants: &[PathBuf],
		write_grants: &[PathBuf],
	) -> Result<Self, (SandboxError, Vec<CleanupFailure>)> {
		let mut stack = Self { sid, applied: Vec::new() };
		for mutation in mutation_plan(read_deny, write_deny, read_grants, write_grants) {
			if mutation.deny && !mutation.path.exists() {
				continue;
			}
			if let Err(error) = stack.apply_tree(mutation) {
				let cleanup = stack.cleanup();
				return Err((error, cleanup));
			}
		}
		Ok(stack)
	}

	fn apply_tree(&mut self, mutation: AclMutation) -> Result<(), SandboxError> {
		use std::os::windows::fs::MetadataExt as _;

		use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

		let metadata =
			std::fs::symlink_metadata(&mutation.path).map_err(|source| SandboxError::BackendPath {
				backend: Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				path: mutation.path.clone(),
				source,
			})?;
		if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return Err(SandboxError::BackendPath {
				backend:   Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				path:      mutation.path.clone(),
				source:    std::io::Error::new(
					std::io::ErrorKind::InvalidInput,
					"refusing ACL mutation through a reparse point",
				),
			});
		}

		if !mutation.deny {
			for ancestor in traversal_ancestors(&mutation.path) {
				if self.applied.iter().any(|item| {
					!item.deny && item.access == AclAccess::Traverse && item.path == ancestor
				}) {
					continue;
				}
				let traversal =
					AclMutation { path: ancestor, access: AclAccess::Traverse, deny: false };
				unsafe { update_acl(self.sid, &traversal, false) }.map_err(|source| {
					SandboxError::BackendPath {
						backend: Backend::AppContainer,
						operation: SandboxOperation::Prepare,
						path: traversal.path.clone(),
						source,
					}
				})?;
				self.applied.push(traversal);
			}
		}

		unsafe { update_acl(self.sid, &mutation, false) }.map_err(|source| {
			SandboxError::BackendPath {
				backend: Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				path: mutation.path.clone(),
				source,
			}
		})?;
		self.applied.push(mutation.clone());
		if metadata.is_dir() {
			self.apply_children(&mutation.path, mutation.access, mutation.deny)?;
		}
		Ok(())
	}

	fn apply_children(
		&mut self,
		root: &Path,
		access: AclAccess,
		deny: bool,
	) -> Result<(), SandboxError> {
		use std::os::windows::fs::MetadataExt as _;

		use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;

		for entry in std::fs::read_dir(root).map_err(|source| SandboxError::BackendPath {
			backend: Backend::AppContainer,
			operation: SandboxOperation::Prepare,
			path: root.to_path_buf(),
			source,
		})? {
			let entry = entry.map_err(|source| SandboxError::BackendPath {
				backend: Backend::AppContainer,
				operation: SandboxOperation::Prepare,
				path: root.to_path_buf(),
				source,
			})?;
			let path = entry.path();
			let metadata =
				std::fs::symlink_metadata(&path).map_err(|source| SandboxError::BackendPath {
					backend: Backend::AppContainer,
					operation: SandboxOperation::Prepare,
					path: path.clone(),
					source,
				})?;
			if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
				return Err(SandboxError::BackendPath {
					backend: Backend::AppContainer,
					operation: SandboxOperation::Prepare,
					path,
					source: std::io::Error::new(
						std::io::ErrorKind::InvalidInput,
						"refusing ACL mutation through a reparse point",
					),
				});
			}
			let mutation = AclMutation { path: path.clone(), access, deny };
			unsafe { update_acl(self.sid, &mutation, false) }.map_err(|source| {
				SandboxError::BackendPath {
					backend: Backend::AppContainer,
					operation: SandboxOperation::Prepare,
					path: mutation.path.clone(),
					source,
				}
			})?;
			self.applied.push(mutation);
			if metadata.is_dir() {
				self.apply_children(&path, access, deny)?;
			}
		}
		Ok(())
	}

	/// Revokes in strict reverse application order and returns every failure in
	/// attempted order. Calling cleanup more than once is harmless.
	pub(crate) fn cleanup(&mut self) -> Vec<CleanupFailure> {
		let mut failures = Vec::new();
		while let Some(mutation) = self.applied.pop() {
			if let Err(source) = unsafe { update_acl(self.sid, &mutation, true) } {
				failures.push(CleanupFailure::BackendPath {
					backend: Backend::AppContainer,
					operation: SandboxOperation::Cleanup,
					path: mutation.path,
					source,
				});
			}
		}
		failures
	}
}

#[cfg(windows)]
impl Drop for AclMutationStack {
	fn drop(&mut self) {
		let _ = self.cleanup();
	}
}

#[cfg(any(windows, test))]
pub(crate) fn traversal_ancestors(target: &Path) -> Vec<PathBuf> {
	let mut result = Vec::new();
	let mut child = target;
	while let Some(parent) = child.parent() {
		if parent.as_os_str().is_empty() || parent == child {
			break;
		}
		result.push(parent.to_path_buf());
		child = parent;
	}
	result.reverse();
	result
}

#[cfg(windows)]
unsafe fn update_acl(
	sid: windows_sys::Win32::Security::PSID,
	mutation: &AclMutation,
	revoke: bool,
) -> Result<(), std::io::Error> {
	use std::{ffi::c_void, os::windows::ffi::OsStrExt as _, ptr};

	use windows_sys::Win32::{
		Foundation::{ERROR_SUCCESS, GENERIC_EXECUTE, GENERIC_READ, GENERIC_WRITE, LocalFree},
		Security::{
			ACL,
			Authorization::{
				DENY_ACCESS, EXPLICIT_ACCESS_W, GRANT_ACCESS, GetNamedSecurityInfoW, REVOKE_ACCESS,
				SE_FILE_OBJECT, SetEntriesInAclW, SetNamedSecurityInfoW, TRUSTEE_IS_GROUP,
				TRUSTEE_IS_SID, TRUSTEE_W,
			},
			DACL_SECURITY_INFORMATION, NO_INHERITANCE, PSECURITY_DESCRIPTOR,
			SUB_CONTAINERS_AND_OBJECTS_INHERIT,
		},
		Storage::FileSystem::{DELETE, FILE_DELETE_CHILD},
	};

	let mut wide = mutation
		.path
		.as_os_str()
		.encode_wide()
		.chain(Some(0))
		.collect::<Vec<_>>();
	let mut old_acl: *mut ACL = ptr::null_mut();
	let mut descriptor: PSECURITY_DESCRIPTOR = ptr::null_mut();
	let status = unsafe {
		GetNamedSecurityInfoW(
			wide.as_ptr(),
			SE_FILE_OBJECT,
			DACL_SECURITY_INFORMATION,
			ptr::null_mut(),
			ptr::null_mut(),
			&mut old_acl,
			ptr::null_mut(),
			&mut descriptor,
		)
	};
	if status != ERROR_SUCCESS {
		return Err(std::io::Error::from_raw_os_error(status as i32));
	}

	let permissions = match mutation.access {
		AclAccess::Traverse | AclAccess::ReadExecute => GENERIC_READ | GENERIC_EXECUTE,
		AclAccess::WriteDelete => GENERIC_WRITE | DELETE | FILE_DELETE_CHILD,
		AclAccess::ReadWriteExecuteDelete => {
			GENERIC_READ | GENERIC_WRITE | GENERIC_EXECUTE | DELETE | FILE_DELETE_CHILD
		},
	};
	let inheritance = if mutation.access == AclAccess::Traverse {
		NO_INHERITANCE
	} else {
		SUB_CONTAINERS_AND_OBJECTS_INHERIT
	};
	let trustee = TRUSTEE_W {
		pMultipleTrustee:         ptr::null_mut(),
		MultipleTrusteeOperation: 0,
		TrusteeForm:              TRUSTEE_IS_SID,
		TrusteeType:              TRUSTEE_IS_GROUP,
		ptstrName:                sid.cast(),
	};
	let entry = EXPLICIT_ACCESS_W {
		grfAccessPermissions: if revoke { 0 } else { permissions },
		grfAccessMode:        if revoke {
			REVOKE_ACCESS
		} else if mutation.deny {
			DENY_ACCESS
		} else {
			GRANT_ACCESS
		},
		grfInheritance:       inheritance,
		Trustee:              trustee,
	};
	let mut new_acl: *mut ACL = ptr::null_mut();
	let status = unsafe { SetEntriesInAclW(1, &entry, old_acl, &mut new_acl) };
	if status == ERROR_SUCCESS {
		let apply_status = unsafe {
			SetNamedSecurityInfoW(
				wide.as_mut_ptr(),
				SE_FILE_OBJECT,
				DACL_SECURITY_INFORMATION,
				ptr::null_mut(),
				ptr::null_mut(),
				new_acl,
				ptr::null_mut(),
			)
		};
		unsafe { LocalFree(new_acl.cast::<c_void>()) };
		unsafe { LocalFree(descriptor.cast::<c_void>()) };
		if apply_status != ERROR_SUCCESS {
			return Err(std::io::Error::from_raw_os_error(apply_status as i32));
		}
		Ok(())
	} else {
		unsafe { LocalFree(descriptor.cast::<c_void>()) };
		Err(std::io::Error::from_raw_os_error(status as i32))
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn denies_precede_allows() {
		let plan = mutation_plan(
			&[PathBuf::from("read-secret")],
			&[PathBuf::from("write-secret")],
			&[PathBuf::from("read")],
			&[PathBuf::from("write")],
		);
		assert!(plan[..2].iter().all(|mutation| mutation.deny));
		assert!(plan[2..].iter().all(|mutation| !mutation.deny));
	}

	#[test]
	fn traversal_is_root_to_leaf() {
		let ancestors = traversal_ancestors(Path::new("/one/two/three"));
		assert_eq!(ancestors, [PathBuf::from("/"), PathBuf::from("/one"), PathBuf::from("/one/two")]);
	}
}
