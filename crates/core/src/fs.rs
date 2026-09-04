//! Filesystem publication helpers.

use std::{
	fs, io,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

static NEXT_BACKUP: AtomicU64 = AtomicU64::new(1);
/// Failure while publishing or rolling back an atomic file replacement.
#[derive(Debug, thiserror::Error)]
pub enum AtomicReplaceError {
	/// The staged file could not be published.
	#[error("atomic file publication failed: {0}")]
	Publish(#[source] io::Error),
	/// Publication failed after moving the destination aside, and restoring the
	/// destination failed too.
	#[error(
		"atomic file publication failed ({initial}); retry failed ({replacement}); rollback failed \
		 ({rollback})"
	)]
	Rollback {
		/// Initial rename-over-target failure.
		initial:     io::Error,
		/// Failure publishing after the destination was moved aside.
		replacement: io::Error,
		/// Failure restoring the original destination.
		#[source]
		rollback:    io::Error,
	},
}

/// Publishes a staged sibling file, preserving an existing destination when
/// Windows rejects rename-over-target with `EPERM` or `EEXIST` semantics.
///
/// On platforms where rename replaces an existing file, this is one atomic
/// operation. When replacement is refused, the destination is first moved to a
/// unique sibling backup. A failed second rename rolls that backup into place
/// before the publication error is returned.
pub fn replace_file_atomically(staged: &Path, target: &Path) -> Result<(), AtomicReplaceError> {
	match fs::rename(staged, target) {
		Ok(()) => Ok(()),
		Err(error)
			if matches!(
				error.kind(),
				io::ErrorKind::PermissionDenied | io::ErrorKind::AlreadyExists
			) =>
		{
			replace_after_windows_failure(staged, target, error)
		},
		Err(error) => Err(AtomicReplaceError::Publish(error)),
	}
}

fn replace_after_windows_failure(
	staged: &Path,
	target: &Path,
	initial: io::Error,
) -> Result<(), AtomicReplaceError> {
	let backup = backup_path(target);
	match fs::rename(target, &backup) {
		Ok(()) => {},
		Err(error) if error.kind() == io::ErrorKind::NotFound => {
			return fs::rename(staged, target).map_err(AtomicReplaceError::Publish);
		},
		Err(_) => return Err(AtomicReplaceError::Publish(initial)),
	}

	if let Err(replacement) = fs::rename(staged, target) {
		if let Err(rollback) = fs::rename(&backup, target) {
			return Err(AtomicReplaceError::Rollback { initial, replacement, rollback });
		}
		return Err(AtomicReplaceError::Publish(replacement));
	}
	if let Err(error) = fs::remove_file(&backup)
		&& error.kind() != io::ErrorKind::NotFound
	{
		tracing::warn!(path = %target.display(), backup = %backup.display(), %error, "failed to remove atomic replacement backup");
	}
	Ok(())
}

fn backup_path(target: &Path) -> PathBuf {
	let sequence = NEXT_BACKUP.fetch_add(1, Ordering::Relaxed);
	let name = target
		.file_name()
		.and_then(|name| name.to_str())
		.unwrap_or("file");
	target.with_file_name(format!(".{name}.{}-{sequence}.bak", std::process::id()))
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::replace_file_atomically;

	#[test]
	fn publishes_staged_sibling_over_existing_file() {
		let directory = std::env::temp_dir().join(format!(
			"omp-core-atomic-replace-{}-{}",
			std::process::id(),
			super::NEXT_BACKUP.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
		));
		fs::create_dir(&directory).expect("temporary directory");
		let target = directory.join("artifact.md");
		let staged = directory.join(".artifact.md.tmp");
		fs::write(&target, b"old").expect("seed target");
		fs::write(&staged, b"new").expect("stage replacement");

		replace_file_atomically(&staged, &target).expect("publish replacement");

		assert_eq!(fs::read(&target).expect("read target"), b"new");
		assert!(!staged.exists());
		fs::remove_dir_all(directory).expect("remove temporary directory");
	}
}
