//! Path searching utilities.
//!
//! Every probe goes through the shell's filesystem, so a provider decides
//! what exists and what is executable. Whether the operating system can then
//! run a match is the caller's concern (see [`crate::commands`]).

use std::{
	ops::ControlFlow,
	path::{Path, PathBuf},
};

use pi_vfs::{BlockingFs, Fs};

#[cfg(windows)]
use crate::sys;

/// Resolves `path` to the executable file it names, if any.
///
/// On Windows a file counts as executable when its extension is listed in
/// `PATHEXT`, and appending a `PATHEXT` extension may name the actual file.
/// Elsewhere the path is returned unchanged when the user may execute it.
pub async fn resolve_executable(fs: &Fs, path: PathBuf) -> Option<PathBuf> {
	#[cfg(windows)]
	{
		if sys::fs::has_executable_extension(&path) && fs.is_file(&path).await {
			return Some(path);
		}
		for extension in sys::fs::executable_extensions() {
			let candidate = with_appended_extension(&path, extension);
			if fs.is_file(&candidate).await {
				return Some(candidate);
			}
		}
		None
	}

	#[cfg(not(windows))]
	{
		fs.access(&path, false, false, true).await.is_ok().then_some(path)
	}
}

/// Blocking twin of [`resolve_executable`], for utilities running on
/// blocking worker threads.
pub fn resolve_executable_blocking(fs: &BlockingFs, path: PathBuf) -> Option<PathBuf> {
	#[cfg(windows)]
	{
		if sys::fs::has_executable_extension(&path) && fs.is_file(&path) {
			return Some(path);
		}
		sys::fs::executable_extensions()
			.iter()
			.map(|extension| with_appended_extension(&path, extension))
			.find(|candidate| fs.is_file(candidate))
	}

	#[cfg(not(windows))]
	{
		fs.access(&path, false, false, true).is_ok().then_some(path)
	}
}

/// Returns whether `path` names something the current user may execute (on
/// Windows: a file with, or completed by, a `PATHEXT` extension).
pub async fn is_executable(fs: &Fs, path: &Path) -> bool {
	#[cfg(windows)]
	{
		resolve_executable(fs, path.to_path_buf()).await.is_some()
	}

	#[cfg(not(windows))]
	{
		fs.access(path, false, false, true).await.is_ok()
	}
}

#[cfg(windows)]
fn with_appended_extension(path: &Path, extension: &str) -> PathBuf {
	let mut name = path.as_os_str().to_owned();
	name.push(extension);
	PathBuf::from(name)
}

/// Visits, in `dirs` order, each executable named `filename` until `visit`
/// breaks. Directories named `filename` are skipped.
async fn search(
	fs: &Fs,
	dirs: impl IntoIterator<Item = impl AsRef<Path>>,
	filename: &Path,
	mut visit: impl FnMut(PathBuf) -> ControlFlow<()>,
) {
	for dir in dirs {
		let candidate = pi_vfs::join_path(dir.as_ref(), filename);
		if fs.is_dir(&candidate).await {
			continue;
		}
		if let Some(resolved) = resolve_executable(fs, candidate).await
			&& visit(resolved).is_break()
		{
			return;
		}
	}
}

/// Finds the first executable named `filename` in `dirs`.
pub async fn find_executable(
	fs: &Fs,
	dirs: impl IntoIterator<Item = impl AsRef<Path>>,
	filename: &Path,
) -> Option<PathBuf> {
	let mut found = None;
	search(fs, dirs, filename, |path| {
		found = Some(path);
		ControlFlow::Break(())
	})
	.await;
	found
}

/// Finds every executable named `filename` in `dirs`, in `dirs` order.
pub async fn find_executables(
	fs: &Fs,
	dirs: impl IntoIterator<Item = impl AsRef<Path>>,
	filename: &Path,
) -> Vec<PathBuf> {
	let mut found = Vec::new();
	search(fs, dirs, filename, |path| {
		found.push(path);
		ControlFlow::Continue(())
	})
	.await;
	found
}

/// Blocking twin of [`find_executable`]/[`find_executables`]: returns the
/// first match, or every match when `all` is set.
pub fn find_executables_blocking(
	fs: &BlockingFs,
	dirs: impl IntoIterator<Item = impl AsRef<Path>>,
	filename: &Path,
	all: bool,
) -> Vec<PathBuf> {
	let mut found = Vec::new();
	for dir in dirs {
		let candidate = pi_vfs::join_path(dir.as_ref(), filename);
		if fs.is_dir(&candidate) {
			continue;
		}
		if let Some(resolved) = resolve_executable_blocking(fs, candidate) {
			found.push(resolved);
			if !all {
				break;
			}
		}
	}
	found
}

/// Finds executables in `dirs` whose file names start with `filename_prefix`
/// (compared ASCII case-insensitively when `case_insensitive`).
pub(crate) async fn find_executables_with_prefix(
	fs: &Fs,
	dirs: impl IntoIterator<Item = impl AsRef<Path>>,
	filename_prefix: &str,
	case_insensitive: bool,
) -> Vec<PathBuf> {
	let stored_prefix;
	let filename_prefix = if case_insensitive {
		stored_prefix = filename_prefix.to_ascii_lowercase();
		stored_prefix.as_str()
	} else {
		filename_prefix
	};

	let mut found = Vec::new();
	for dir in dirs {
		let Ok(entries) = fs.read_dir(dir.as_ref()).await else {
			continue;
		};
		for entry in entries.flatten() {
			if let Ok(mut filename) = entry.file_name().into_string() {
				if case_insensitive {
					filename.make_ascii_lowercase();
				}

				if !filename.starts_with(filename_prefix) {
					continue;
				}
			}

			let Ok(file_type) = entry.file_type_async().await else {
				continue;
			};
			if file_type.is_file() || file_type.is_symlink() {
				let entry_path = entry.path();
				if is_executable(fs, &entry_path).await {
					found.push(entry_path);
				}
			}
		}
	}
	found
}
