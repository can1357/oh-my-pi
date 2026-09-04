use std::{env, ffi::OsStr, path::Path};
#[cfg(unix)]
use std::{fs, os::unix::fs::PermissionsExt as _};

use strum::IntoStaticStr;

use crate::{Backend, PreparedSandbox, SandboxError, SandboxOperation, runner::PreparedResource};

#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
enum MaskKind {
	#[strum(serialize = "@omp-bwrap-file-mask@")]
	File,
	#[strum(serialize = "@omp-bwrap-directory-mask@")]
	Directory,
}

impl MaskKind {
	fn placeholder(self) -> &'static str {
		self.into()
	}
}

/// Replaces mask placeholders with empty artifacts owned by the prepared
/// sandbox. Dropping the prepared value closes and removes every mask.
pub fn prepare(mut prepared: PreparedSandbox) -> Result<PreparedSandbox, SandboxError> {
	if has_placeholder(&prepared, MaskKind::File) {
		let file = tempfile::Builder::new()
			.prefix("omp-sandbox-bwrap-mask-")
			.tempfile()
			.map_err(|source| SandboxError::Artifact {
				operation: SandboxOperation::Prepare,
				path: env::temp_dir(),
				source,
			})?;
		set_file_mode(file.path())?;
		replace_placeholder(&mut prepared, MaskKind::File, file.path())?;
		prepared.push_resource(PreparedResource::File(Some(file)));
	}
	if has_placeholder(&prepared, MaskKind::Directory) {
		let directory = tempfile::Builder::new()
			.prefix("omp-sandbox-bwrap-mask-")
			.tempdir()
			.map_err(|source| SandboxError::Artifact {
				operation: SandboxOperation::Prepare,
				path: env::temp_dir(),
				source,
			})?;
		set_directory_mode(directory.path())?;
		replace_placeholder(&mut prepared, MaskKind::Directory, directory.path())?;
		prepared.push_resource(PreparedResource::Directory(Some(directory)));
	}
	Ok(prepared)
}

fn has_placeholder(prepared: &PreparedSandbox, kind: MaskKind) -> bool {
	mount_sources(prepared).any(|source| source == OsStr::new(kind.placeholder()))
}

fn replace_placeholder(
	prepared: &mut PreparedSandbox,
	kind: MaskKind,
	replacement: &Path,
) -> Result<(), SandboxError> {
	let placeholder = OsStr::new(kind.placeholder());
	let mut replaced = false;
	let mut index = 0;
	while index + 1 < prepared.args.len() && prepared.args[index] != "--" {
		if prepared.args[index] == "--ro-bind" && prepared.args[index + 1] == placeholder {
			prepared.args[index + 1] = replacement.as_os_str().to_owned();
			replaced = true;
		}
		index += 1;
	}
	if replaced {
		Ok(())
	} else {
		Err(SandboxError::MissingPlanPlaceholder {
			backend:     Backend::Bubblewrap,
			placeholder: kind.placeholder(),
		})
	}
}

fn mount_sources(prepared: &PreparedSandbox) -> impl Iterator<Item = &OsStr> {
	prepared
		.args
		.windows(2)
		.take_while(|window| window[0] != "--")
		.filter(|window| window[0] == "--ro-bind")
		.map(|window| window[1].as_os_str())
}

#[cfg(unix)]
fn set_file_mode(path: &Path) -> Result<(), SandboxError> {
	fs::set_permissions(path, fs::Permissions::from_mode(0o600)).map_err(|source| {
		SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: path.to_path_buf(),
			source,
		}
	})
}

#[cfg(not(unix))]
fn set_file_mode(_path: &Path) -> Result<(), SandboxError> {
	Ok(())
}

#[cfg(unix)]
fn set_directory_mode(path: &Path) -> Result<(), SandboxError> {
	// A directory mask must remain traversable by bwrap; 0700 is the directory
	// analogue of a private 0600 file.
	fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(|source| {
		SandboxError::Artifact {
			operation: SandboxOperation::Prepare,
			path: path.to_path_buf(),
			source,
		}
	})
}

#[cfg(not(unix))]
fn set_directory_mode(_path: &Path) -> Result<(), SandboxError> {
	Ok(())
}
