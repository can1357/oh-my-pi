use std::{
	env, fs, io,
	path::{Path, PathBuf},
};
#[cfg(unix)]
use std::{
	ffi::{CString, OsString},
	os::unix::{
		ffi::{OsStrExt as _, OsStringExt as _},
		fs::{DirBuilderExt as _, MetadataExt as _, OpenOptionsExt as _, PermissionsExt as _},
	},
};

use crate::{
	Backend, PreparedSandbox, SandboxError, SandboxOperation, SandboxSpec, WriteMode,
	backends::seatbelt::EPHEMERAL_ROOT_PLACEHOLDER, runner::PreparedResource,
};

/// Materializes Seatbelt runtime state. The prepared sandbox owns the clone's
/// temporary directory, so its profile and cwd cannot outlive the clone.
pub fn prepare(spec: &SandboxSpec, prepared: &mut PreparedSandbox) -> Result<(), SandboxError> {
	if spec.write != WriteMode::Ephemeral {
		return Ok(());
	}
	let workspace = workspace_root(spec)?;
	let metadata = fs::symlink_metadata(&workspace).map_err(|source| SandboxError::Artifact {
		operation: SandboxOperation::Prepare,
		path: workspace.clone(),
		source,
	})?;
	if !metadata.is_dir() {
		return Err(SandboxError::WorkspaceRootNotDirectory { path: workspace });
	}

	let temporary = tempfile::Builder::new()
		.prefix("omp-sandbox-ephemeral-")
		.tempdir()
		.map_err(|source| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: env::temp_dir(),
			source,
		})?;
	let clone_root = temporary.path().join("workspace");
	clone_entry(&workspace, &clone_root)?;
	let clone_root = fs::canonicalize(&clone_root)
		.map_err(|source| SandboxError::Canonicalize { path: clone_root, source })?;

	replace_placeholder(prepared, EPHEMERAL_ROOT_PLACEHOLDER, &clone_root)?;
	prepared.cwd = Some(clone_root);
	prepared.push_resource(PreparedResource::Directory(Some(temporary)));
	Ok(())
}

fn workspace_root(spec: &SandboxSpec) -> Result<PathBuf, SandboxError> {
	let requested = match &spec.dir {
		Some(dir) => dir.clone(),
		None => env::current_dir().map_err(|source| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: PathBuf::from("."),
			source,
		})?,
	};
	fs::canonicalize(&requested)
		.map_err(|source| SandboxError::Canonicalize { path: requested, source })
}

#[cfg(unix)]
fn replace_placeholder(
	prepared: &mut PreparedSandbox,
	placeholder: &'static str,
	replacement: &Path,
) -> Result<(), SandboxError> {
	// sandbox-exec arguments are `-p`, profile, executable, user args. Only the
	// generated profile is eligible for placeholder substitution; user argv is
	// intentionally left byte-for-byte unchanged.
	let Some(profile) = prepared.args.get_mut(1) else {
		return Err(SandboxError::MissingPlanPlaceholder { backend: Backend::Seatbelt, placeholder });
	};
	let token = placeholder.as_bytes();
	let bytes = profile.as_os_str().as_bytes();
	if !bytes.windows(token.len()).any(|window| window == token) {
		return Err(SandboxError::MissingPlanPlaceholder { backend: Backend::Seatbelt, placeholder });
	}
	let replacement = replacement.as_os_str().as_bytes();
	let mut replaced = Vec::with_capacity(bytes.len());
	let mut remaining = bytes;
	while let Some(offset) = remaining
		.windows(token.len())
		.position(|window| window == token)
	{
		replaced.extend_from_slice(&remaining[..offset]);
		replaced.extend_from_slice(replacement);
		remaining = &remaining[offset + token.len()..];
	}
	replaced.extend_from_slice(remaining);
	*profile = OsString::from_vec(replaced);
	Ok(())
}

#[cfg(not(unix))]
fn replace_placeholder(
	_prepared: &mut PreparedSandbox,
	placeholder: &'static str,
	_replacement: &Path,
) -> Result<(), SandboxError> {
	Err(SandboxError::MissingPlanPlaceholder { backend: Backend::Seatbelt, placeholder })
}

fn clone_entry(source: &Path, destination: &Path) -> Result<(), SandboxError> {
	let metadata = fs::symlink_metadata(source).map_err(|source_error| SandboxError::Artifact {
		operation: SandboxOperation::Prepare,
		path:      source.to_path_buf(),
		source:    source_error,
	})?;
	let file_type = metadata.file_type();
	if file_type.is_dir() {
		clone_directory(source, destination, &metadata)
	} else if file_type.is_file() {
		clone_regular_file(source, destination, &metadata)
	} else if file_type.is_symlink() {
		clone_symlink(source, destination, &metadata)
	} else {
		#[cfg(unix)]
		let mode = metadata.mode();
		#[cfg(not(unix))]
		let mode = 0;
		Err(SandboxError::UnsupportedWorkspaceEntry { path: source.to_path_buf(), mode })
	}
}

fn clone_directory(
	source: &Path,
	destination: &Path,
	metadata: &fs::Metadata,
) -> Result<(), SandboxError> {
	let mut builder = fs::DirBuilder::new();
	#[cfg(unix)]
	builder.mode(0o700);
	builder
		.create(destination)
		.map_err(|source| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: destination.to_path_buf(),
			source,
		})?;
	for entry in fs::read_dir(source).map_err(|source_error| SandboxError::Artifact {
		operation: SandboxOperation::Prepare,
		path:      source.to_path_buf(),
		source:    source_error,
	})? {
		let entry = entry.map_err(|source_error| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path:      source.to_path_buf(),
			source:    source_error,
		})?;
		clone_entry(&entry.path(), &destination.join(entry.file_name()))?;
	}
	preserve_metadata(destination, metadata, false);
	Ok(())
}

fn clone_regular_file(
	source: &Path,
	destination: &Path,
	metadata: &fs::Metadata,
) -> Result<(), SandboxError> {
	#[cfg(target_os = "macos")]
	if clonefile(source, destination) {
		preserve_metadata(destination, metadata, false);
		return Ok(());
	}
	copy_regular_file(source, destination, metadata)?;
	preserve_metadata(destination, metadata, false);
	Ok(())
}

#[cfg(target_os = "macos")]
fn clonefile(source: &Path, destination: &Path) -> bool {
	const CLONE_NOFOLLOW: u32 = 0x0000_0001;
	let Ok(source) = CString::new(source.as_os_str().as_bytes()) else {
		return false;
	};
	let Ok(destination) = CString::new(destination.as_os_str().as_bytes()) else {
		return false;
	};
	unsafe extern "C" {
		fn clonefile(
			source: *const libc::c_char,
			destination: *const libc::c_char,
			flags: u32,
		) -> libc::c_int;
	}
	// SAFETY: both C strings remain alive for the call and point to NUL-terminated
	// path bytes. clonefile creates the destination or leaves it absent on error.
	unsafe { clonefile(source.as_ptr(), destination.as_ptr(), CLONE_NOFOLLOW) == 0 }
}

fn copy_regular_file(
	source: &Path,
	destination: &Path,
	metadata: &fs::Metadata,
) -> Result<(), SandboxError> {
	let mut input = fs::File::open(source).map_err(|source_error| SandboxError::Artifact {
		operation: SandboxOperation::Prepare,
		path:      source.to_path_buf(),
		source:    source_error,
	})?;
	let mut options = fs::OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	options.mode(metadata.mode() & 0o777);
	let mut output = options
		.open(destination)
		.map_err(|source_error| SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path:      destination.to_path_buf(),
			source:    source_error,
		})?;
	io::copy(&mut input, &mut output).map_err(|source_error| SandboxError::Artifact {
		operation: SandboxOperation::Prepare,
		path:      destination.to_path_buf(),
		source:    source_error,
	})?;
	Ok(())
}

#[cfg(unix)]
fn clone_symlink(
	source: &Path,
	destination: &Path,
	metadata: &fs::Metadata,
) -> Result<(), SandboxError> {
	let target = fs::read_link(source).map_err(|source_error| SandboxError::Artifact {
		operation: SandboxOperation::Prepare,
		path:      source.to_path_buf(),
		source:    source_error,
	})?;
	std::os::unix::fs::symlink(target, destination).map_err(|source_error| {
		SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path:      destination.to_path_buf(),
			source:    source_error,
		}
	})?;
	preserve_metadata(destination, metadata, true);
	Ok(())
}

#[cfg(not(unix))]
fn clone_symlink(
	source: &Path,
	_destination: &Path,
	_metadata: &fs::Metadata,
) -> Result<(), SandboxError> {
	Err(SandboxError::UnsupportedWorkspaceEntry { path: source.to_path_buf(), mode: 0 })
}

#[cfg(unix)]
fn preserve_metadata(path: &Path, metadata: &fs::Metadata, no_follow: bool) {
	if !no_follow {
		let _ = fs::set_permissions(path, fs::Permissions::from_mode(metadata.mode() & 0o777));
	}
	let Ok(path) = CString::new(path.as_os_str().as_bytes()) else {
		return;
	};
	// Ownership preservation is deliberately best-effort: unprivileged callers
	// cannot chown, while clone correctness must not depend on that privilege.
	unsafe {
		libc::lchown(path.as_ptr(), metadata.uid(), metadata.gid());
	}
	let times = [
		libc::timespec { tv_sec: metadata.atime(), tv_nsec: metadata.atime_nsec() },
		libc::timespec { tv_sec: metadata.mtime(), tv_nsec: metadata.mtime_nsec() },
	];
	let flags = if no_follow {
		libc::AT_SYMLINK_NOFOLLOW
	} else {
		0
	};
	unsafe {
		libc::utimensat(libc::AT_FDCWD, path.as_ptr(), times.as_ptr(), flags);
	}
}

#[cfg(not(unix))]
fn preserve_metadata(_path: &Path, _metadata: &fs::Metadata, _no_follow: bool) {}
