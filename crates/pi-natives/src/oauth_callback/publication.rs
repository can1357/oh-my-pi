use std::{
	fs::{self, File, OpenOptions},
	io::{self, Write},
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Publishes `contents` at `path` as one complete file without replacing an
/// existing callback.
///
/// The caller owns the private parent directory. A same-directory temporary
/// file and an atomic hard-link publication keep readers from observing a
/// partial value and make concurrent publishers race safely.
pub(crate) fn publish_once(path: &Path, contents: &[u8]) -> io::Result<()> {
	let parent = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
		.ok_or_else(|| {
			io::Error::new(io::ErrorKind::InvalidInput, "callback path has no parent directory")
		})?;
	let file_name = path.file_name().ok_or_else(|| {
		io::Error::new(io::ErrorKind::InvalidInput, "callback path has no file name")
	})?;

	let (temporary_path, mut temporary) = create_temporary(parent, file_name)?;
	let result = (|| {
		temporary.write_all(contents)?;
		temporary.sync_all()?;
		drop(temporary);

		// `hard_link` creates the destination name atomically and fails when it
		// already exists on every supported filesystem. `rename` cannot provide
		// that no-replace guarantee portably.
		fs::hard_link(&temporary_path, path)?;
		Ok(())
	})();
	let cleanup_result = fs::remove_file(&temporary_path);

	match (result, cleanup_result) {
		(Err(error), _) => Err(error),
		(Ok(()), Ok(())) => Ok(()),
		(Ok(()), Err(error)) => Err(io::Error::new(
			error.kind(),
			format!("callback was published but its temporary link could not be removed: {error}"),
		)),
	}
}

fn create_temporary(parent: &Path, file_name: &std::ffi::OsStr) -> io::Result<(PathBuf, File)> {
	for _ in 0..128 {
		let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let name =
			format!(".{}.{}.{}.tmp", file_name.to_string_lossy(), std::process::id(), sequence);
		let path = parent.join(name);
		let mut options = OpenOptions::new();
		options.write(true).create_new(true);
		configure_private_mode(&mut options);
		match options.open(&path) {
			Ok(file) => {
				if let Err(error) = set_private_permissions(&file) {
					drop(file);
					let _ = fs::remove_file(&path);
					return Err(error);
				}
				return Ok((path, file));
			},
			Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {},
			Err(error) => return Err(error),
		}
	}

	Err(io::Error::new(
		io::ErrorKind::AlreadyExists,
		"could not allocate a unique callback temporary file",
	))
}

#[cfg(unix)]
fn configure_private_mode(options: &mut OpenOptions) {
	use std::os::unix::fs::OpenOptionsExt as _;
	options.mode(0o600);
}

#[cfg(not(unix))]
fn configure_private_mode(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_private_permissions(file: &File) -> io::Result<()> {
	use std::os::unix::fs::PermissionsExt as _;
	file.set_permissions(fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn set_private_permissions(_file: &File) -> io::Result<()> {
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		sync::{Arc, Barrier},
		thread,
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::*;

	struct TestDirectory(PathBuf);

	impl TestDirectory {
		fn new(label: &str) -> Self {
			let nonce = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system clock should follow the Unix epoch")
				.as_nanos();
			let path = std::env::temp_dir()
				.join(format!("omp-oauth-relay-{label}-{}-{nonce}", std::process::id()));
			fs::create_dir(&path).expect("create test transaction directory");
			Self(path)
		}
	}

	impl Drop for TestDirectory {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	#[test]
	fn publishes_exact_utf8_without_a_byte_order_mark_or_newline() {
		let directory = TestDirectory::new("utf8");
		let callback = directory.0.join("callback.url");
		let value = "omp-test://oauth/callback?name=Jörg&check=✓";

		publish_once(&callback, value.as_bytes()).expect("publish callback");

		assert_eq!(fs::read(&callback).expect("read callback"), value.as_bytes());
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;
			assert_eq!(
				fs::metadata(callback)
					.expect("read callback metadata")
					.permissions()
					.mode() & 0o777,
				0o600
			);
		}
	}

	#[test]
	fn refuses_to_replace_an_existing_callback() {
		let directory = TestDirectory::new("existing");
		let callback = directory.0.join("callback.url");
		fs::write(&callback, b"first").expect("seed callback");

		let error = publish_once(&callback, b"second").expect_err("replacement must fail");

		assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
		assert_eq!(fs::read(callback).expect("read callback"), b"first");
	}

	#[test]
	fn concurrent_publishers_have_exactly_one_winner() {
		let directory = TestDirectory::new("race");
		let callback = directory.0.join("callback.url");
		let barrier = Arc::new(Barrier::new(3));
		let mut threads = Vec::new();

		for value in [b"first".as_slice(), b"second".as_slice()] {
			let callback = callback.clone();
			let barrier = Arc::clone(&barrier);
			let value = value.to_vec();
			threads.push(thread::spawn(move || {
				barrier.wait();
				publish_once(&callback, &value)
			}));
		}
		barrier.wait();

		let results: Vec<_> = threads
			.into_iter()
			.map(|thread| thread.join().expect("publisher should not panic"))
			.collect();
		assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
		assert_eq!(
			results
				.iter()
				.filter(|result| result
					.as_ref()
					.is_err_and(|error| error.kind() == io::ErrorKind::AlreadyExists))
				.count(),
			1
		);
		let published = fs::read(callback).expect("read callback");
		assert!(published == b"first" || published == b"second");
	}

	#[test]
	fn does_not_create_a_missing_transaction_directory() {
		let directory = TestDirectory::new("missing-parent");
		let missing = directory.0.join("missing");
		let callback = missing.join("callback.url");

		publish_once(&callback, b"value").expect_err("missing parent must fail");

		assert!(!missing.exists());
	}
}
