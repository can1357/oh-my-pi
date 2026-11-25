use std::{cell::RefCell, io, path::{Path, PathBuf}, rc::Rc};

use omp_vfs::{BlockingFs, TempOptions, absolute_path, parent_path};

use crate::{atomic_write, host::Host};

use super::{Handle, Io, Layers, OpenMode, bad_fd, input_path};

struct Pending {
	fs: BlockingFs,
	path: PathBuf,
	output: Io,
	bytes: Rc<RefCell<Vec<u8>>>,
}

/// State for Perl's `-i[extension]` when reading files via ARGV. Each `advance`
/// yields the input and the corresponding `ARGVOUT`; select the latter as the
/// default print handle. Treat `-`/empty ARGV as ordinary stdin/stdout in the
/// interpreter, not as edits. Call `finish` when leaving the ARGV loop.
pub(in crate::perl) struct InPlace {
	extension: Vec<u8>,
	pending: Option<Pending>,
}

impl InPlace {
	/// Set the backup extension (empty means no backup).
	pub fn new(extension: &[u8]) -> Self {
		Self { extension: extension.to_vec(), pending: None }
	}

	/// Publish the previous edit, then open the next ARGV file (already resolved
	/// through the interpreter's cwd) and write any backup before selecting its
	/// output. On failure the new source is not edited.
	/// Keep its original spelling for the full-path `*` extension substitution.
	/// `reuse` is ARGVOUT's current IO slot: when it is not open, the output is opened into that
	/// same object (perl reopens the glob's IO), so a selection or localized `*ARGVOUT` keeps tracking it.
	#[allow(clippy::too_many_arguments)]
	pub fn advance_resolved(
		&mut self, host: &mut Host, resolved: PathBuf, spelling: &[u8], cwd: &Path, input_layers: Layers, output_layers: Layers, reuse: Option<Io>,
	) -> io::Result<(Handle, Io)> {
		self.finish()?;
		self.advance_at(host, resolved, spelling, cwd, input_layers, output_layers, reuse)
	}

	#[allow(clippy::too_many_arguments)]
	fn advance_at(
		&mut self, host: &Host, resolved: PathBuf, spelling: &[u8], cwd: &Path, input_layers: Layers, output_layers: Layers, reuse: Option<Io>,
	) -> io::Result<(Handle, Io)> {
		let meta = host.fs().metadata(&resolved)?;
		if !meta.is_file() {
			return Err(io::Error::new(io::ErrorKind::InvalidInput, "not a regular file"));
		}
		let input = Handle::from_file(host.fs().open(&resolved)?, OpenMode::READ, input_layers);
		if let Some(backup) = backup_name(spelling, &self.extension) {
			let backup = host.resolve(absolute_path(cwd, &input_path(&backup)?));
			let same_file = host.fs().symlink_metadata(&backup).is_ok_and(|other| meta.same_file(&other));
			if resolved != backup && !same_file {
				backup_file(host.fs(), &resolved, &backup, meta.permissions())?;
			}
		}
		let bytes = Rc::new(RefCell::new(Vec::new()));
		let handle = Handle::in_place(output_layers, Rc::clone(&bytes));
		let output = match reuse {
			Some(io) if io.try_borrow().is_ok_and(|h| !h.is_open()) => {
				if let Ok(mut slot) = io.try_borrow_mut() { *slot = handle; }
				io
			},
			_ => Rc::new(RefCell::new(handle)),
		};
		self.pending = Some(Pending { fs: host.fs().clone(), path: resolved, output: Rc::clone(&output), bytes });
		Ok((input, output))
	}

	/// Close ARGVOUT and atomically publish its bytes at the original name.
	/// On an error, the original stays intact.
	pub fn finish(&mut self) -> io::Result<()> {
		if let Some(pending) = self.pending.take() {
			let mut output = pending.output.try_borrow_mut().map_err(|_| bad_fd())?;
			if output.is_open() {
				output.close()?;
			}
			drop(output);
			let bytes = pending.bytes.try_borrow().map_err(|_| bad_fd())?;
			atomic_write::replace(&pending.fs, &pending.path, &bytes, "perl")?;
		}
		Ok(())
	}
}

fn backup_name(spelling: &[u8], ext: &[u8]) -> Option<Vec<u8>> {
	if ext.is_empty() || ext == b"*" { return None; }
	let stars = memchr::memchr_iter(b'*', ext).count();
	if stars == 0 {
		let mut backup = Vec::with_capacity(spelling.len() + ext.len());
		backup.extend_from_slice(spelling);
		backup.extend_from_slice(ext);
		return Some(backup);
	}
	let mut pieces = ext.split(|&b| b == b'*');
	let mut backup = Vec::with_capacity(ext.len() - stars + stars.saturating_mul(spelling.len()));
	backup.extend_from_slice(pieces.next()?);
	for piece in pieces {
		backup.extend_from_slice(spelling);
		backup.extend_from_slice(piece);
	}
	Some(backup)
}

/// Backup creation mustn't write through an existing symlink or hard link at
/// the backup path, nor destroy a previous backup on a failed copy.
fn backup_file(fs: &BlockingFs, source: &Path, backup: &Path, permissions: omp_vfs::Permissions) -> io::Result<()> {
	let dir = parent_path(backup).filter(|p| !p.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
	let options = TempOptions::new().prefix(".perl-backup.").random_len(16).mode(0o600);
	let (temp_path, mut temp) = fs.create_temp(dir, &options)?;
	let result = (|| {
		let mut input = fs.open(source)?;
		let copied = io::copy(&mut input, &mut temp).and_then(|_| temp.set_permissions(permissions));
		let closed = temp.close();
		copied.and(closed)?;
		fs.rename(&temp_path, backup)
	})();
	if result.is_err() {
		let _ = fs.for_cleanup().remove_file(&temp_path);
	}
	result
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn backup_can_append_a_suffix_or_substitute_full_argv_spelling_multiple_times() {
		assert_eq!(backup_name(b"dir/file", b".orig"), Some(b"dir/file.orig".to_vec()));
		assert_eq!(backup_name(b"dir/file", b"backups/*.*"), Some(b"backups/dir/file.dir/file".to_vec()));
		assert_eq!(backup_name(b"dir/file", b""), None);
		assert_eq!(backup_name(b"dir/file", b"*"), None);
	}

	#[test]
	fn finish_preserves_original_as_backup_even_after_manual_close() {
		let dir = tempfile::tempdir().unwrap();
		let (mut host, _) = Host::for_test("perl", Vec::new(), dir.path());
		let source = host.resolve("source");
		let backup = host.resolve("source.bak");
		host.fs().write(&source, b"before\n").unwrap();
		let mut inplace = InPlace::new(b".bak");
		let cwd = host.cwd().to_path_buf();
		let (mut input, output) =
			inplace.advance_resolved(&mut host, source.clone(), b"source", &cwd, Layers::raw(), Layers::raw(), None).unwrap();
		assert_eq!(input.read_record(&super::super::RecordSep::default()).unwrap().unwrap().bytes, b"before\n");
		{
			let mut output = output.borrow_mut();
			output.write(&super::super::PStr::from_bytes(b"after\n")).unwrap();
			output.close().unwrap();
		}
		inplace.finish().unwrap();
		assert_eq!(host.fs().read(&source).unwrap(), b"after\n");
		assert_eq!(host.fs().read(&backup).unwrap(), b"before\n");
	}
}
