//! Atomic whole-file replacement for the utilities that rewrite a file they
//! may also have read (`sponge FILE`, `sd PATTERN REPLACEMENT FILE`).

use std::{
	ffi::OsStr,
	io::{self, Write},
	path::{Path, PathBuf},
};

use pi_vfs::{BlockingFs, File, TempOptions};

/// Writes `contents` to a fresh temporary file beside `target`, copies the
/// existing target's permissions onto it, then renames it over the target so
/// readers never observe a truncated file. `tag` names the utility in the
/// temporary file's name (`.<basename>.<tag>.<random>`).
///
/// A symlink at `target` is replaced, not followed; callers that edit the
/// link's target canonicalize first.
///
/// # Errors
///
/// Creating, writing, or closing the temporary file, copying permissions, or
/// the rename failed; the temporary file is removed and `target` is intact.
pub(crate) fn replace(fs: &BlockingFs, target: &Path, contents: &[u8], tag: &str) -> io::Result<()> {
	let (temp_path, temp) = create_sibling_temp(fs, target, tag)?;
	let result = write_and_swap(fs, target, &temp_path, temp, contents);
	if result.is_err() {
		// The operation filesystem may be cancelled; cleanup must still run.
		let _ = fs.for_cleanup().remove_file(&temp_path);
	}
	result
}

fn write_and_swap(
	fs: &BlockingFs,
	target: &Path,
	temp_path: &Path,
	mut temp: File,
	contents: &[u8],
) -> io::Result<()> {
	let written = temp.write_all(contents);
	// Close before the rename so providers that commit on close publish the
	// complete contents under the final name, and report their errors. Also
	// close after a failed write so the handle is released before cleanup.
	let closed = temp.close();
	written.and(closed)?;
	if let Ok(metadata) = fs.metadata(target) {
		fs.set_permissions(temp_path, metadata.permissions())?;
	}
	fs.rename(temp_path, target)
}

/// Creates a uniquely named `.<basename>.<tag>.<random>` file next to `target`
/// with `create_new`, retrying on collision. The temp file gets the default
/// creation mode so a new target ends up with ordinary permissions.
fn create_sibling_temp(fs: &BlockingFs, target: &Path, tag: &str) -> io::Result<(PathBuf, File)> {
	let dir = pi_vfs::parent_path(target)
		.filter(|p| !p.is_empty())
		.unwrap_or_else(|| Path::new("."));
	let base = pi_vfs::file_name(target);
	let base = base.as_deref().unwrap_or(OsStr::new(tag)).to_string_lossy();
	let options = TempOptions::new()
		.prefix(format!(".{base}.{tag}."))
		.random_len(16)
		.mode(0o666);
	fs.create_temp(dir, &options)
}
