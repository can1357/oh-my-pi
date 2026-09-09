use std::{
	env,
	fs::{self, OpenOptions},
	io::{self, Write as _},
	mem,
	path::{Path, PathBuf},
	thread,
	time::Duration,
};

use rand::RngExt as _;
use thiserror::Error;
use zeroize::{Zeroize as _, Zeroizing};

/// File name used for the per-install placeholder key.
pub const PLACEHOLDER_KEY_FILE: &str = "secret-placeholder.key";
const WINNER_READ_ATTEMPTS: usize = 50;
const WINNER_READ_DELAY: Duration = Duration::from_millis(10);

/// Resolves the native state path for the persistent placeholder key.
pub fn native_path() -> Result<PathBuf, SecretKeyError> {
	if let Some(state) = env::var_os("XDG_STATE_HOME") {
		return Ok(PathBuf::from(state).join("omp").join(PLACEHOLDER_KEY_FILE));
	}
	let home = env::var_os("HOME").ok_or(SecretKeyError::MissingHome)?;
	Ok(PathBuf::from(home)
		.join(".omp/agent")
		.join(PLACEHOLDER_KEY_FILE))
}

/// Loads the native key without creating a file.
pub fn read_without_create() -> Result<Option<String>, SecretKeyError> {
	read_at(&native_path()?)
}

/// Loads the native key or exclusively creates it.
pub fn load_or_create() -> Result<String, SecretKeyError> {
	load_or_create_at(&native_path()?)
}

/// Loads a key at `path` without creating it.
pub fn read_at(path: &Path) -> Result<Option<String>, SecretKeyError> {
	read_once(path, true)
}

/// Loads a key at `path`, or creates one with mode 0600 and converges with
/// racing creators.
pub fn load_or_create_at(path: &Path) -> Result<String, SecretKeyError> {
	match read_once(path, true) {
		Ok(Some(existing)) => return Ok(existing),
		Ok(None) => {},
		Err(SecretKeyError::InvalidKey { .. }) => return read_winner(path),
		Err(error) => return Err(error),
	}
	let parent = path
		.parent()
		.filter(|parent| !parent.as_os_str().is_empty())
		.ok_or_else(|| SecretKeyError::NoParent { path: path.to_path_buf() })?;
	fs::create_dir_all(parent).map_err(|source| SecretKeyError::Io {
		operation: "create key directory",
		path: parent.to_path_buf(),
		source,
	})?;
	let mut random = Zeroizing::new(rand::rng().random::<[u8; 32]>());
	let mut encoded = Zeroizing::new(omp_core::base64_url::encode_raw(&*random).into_string());
	random.zeroize();
	let open = open_exclusive(path);
	match open {
		Ok(mut file) => {
			file
				.write_all(encoded.as_bytes())
				.map_err(|source| SecretKeyError::Io {
					operation: "write placeholder key",
					path: path.to_path_buf(),
					source,
				})?;
			file.sync_all().map_err(|source| SecretKeyError::Io {
				operation: "sync placeholder key",
				path: path.to_path_buf(),
				source,
			})?;
			Ok(mem::take(&mut *encoded))
		},
		Err(source) if source.kind() == io::ErrorKind::AlreadyExists => read_winner(path),
		Err(source) => Err(SecretKeyError::Io {
			operation: "exclusively create placeholder key",
			path: path.to_path_buf(),
			source,
		}),
	}
}

fn open_exclusive(path: &Path) -> io::Result<fs::File> {
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt as _;
		options.mode(0o600);
	}
	options.open(path)
}

fn read_winner(path: &Path) -> Result<String, SecretKeyError> {
	for attempt in 0..WINNER_READ_ATTEMPTS {
		if attempt > 0 {
			thread::sleep(WINNER_READ_DELAY);
		}
		match read_once(path, false) {
			Ok(Some(key)) => return Ok(key),
			Ok(None) => {},
			Err(SecretKeyError::InvalidKey { .. }) => {},
			Err(error) => return Err(error),
		}
	}
	Err(SecretKeyError::WinnerUnavailable { path: path.to_path_buf() })
}

fn read_once(path: &Path, reject_invalid: bool) -> Result<Option<String>, SecretKeyError> {
	let bytes = match fs::read(path) {
		Ok(bytes) => Zeroizing::new(bytes),
		Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(source) => {
			return Err(SecretKeyError::Io {
				operation: "read placeholder key",
				path: path.to_path_buf(),
				source,
			});
		},
	};
	validate_permissions(path)?;
	let value = str::from_utf8(&bytes).ok().map(str::trim);
	if let Some(value) = value.filter(|value| valid_key(value)) {
		return Ok(Some(value.to_owned()));
	}
	if !reject_invalid && bytes.iter().all(u8::is_ascii_whitespace) {
		return Ok(None);
	}
	Err(SecretKeyError::InvalidKey { path: path.to_path_buf() })
}

fn valid_key(value: &str) -> bool {
	if value.len() != 43
		|| !value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
	{
		return false;
	}
	omp_core::base64_url::decode_raw(value)
		.into_vec()
		.is_ok_and(|mut bytes| {
			let valid = bytes.len() == 32;
			bytes.zeroize();
			valid
		})
}

#[cfg(unix)]
fn validate_permissions(path: &Path) -> Result<(), SecretKeyError> {
	use std::os::unix::fs::PermissionsExt as _;
	let mode = fs::metadata(path)
		.map_err(|source| SecretKeyError::Io {
			operation: "inspect placeholder key permissions",
			path: path.to_path_buf(),
			source,
		})?
		.permissions()
		.mode()
		& 0o777;
	if mode != 0o600 {
		return Err(SecretKeyError::InsecurePermissions { path: path.to_path_buf(), mode });
	}
	Ok(())
}

#[cfg(not(unix))]
fn validate_permissions(_path: &Path) -> Result<(), SecretKeyError> {
	Ok(())
}

/// Persistent placeholder-key failure.
#[derive(Debug, Error)]
pub enum SecretKeyError {
	/// Neither XDG state nor the user home can be resolved.
	#[error("HOME is unavailable while resolving the secret placeholder key")]
	MissingHome,
	/// The caller supplied a path without a parent directory.
	#[error("secret placeholder key path has no parent: {path}")]
	NoParent {
		/// Invalid path.
		path: PathBuf,
	},
	/// A filesystem operation failed.
	#[error("failed to {operation} at {path}")]
	Io {
		/// Operation being attempted.
		operation: &'static str,
		/// Affected path.
		path:      PathBuf,
		/// Underlying I/O failure.
		#[source]
		source:    io::Error,
	},
	/// Existing bytes are not one valid 256-bit base64url key.
	#[error("secret placeholder key is invalid: {path}")]
	InvalidKey {
		/// Invalid file path.
		path: PathBuf,
	},
	/// Existing key permissions permit access beyond the owner.
	#[error("secret placeholder key at {path} has mode {mode:o}; expected 600")]
	InsecurePermissions {
		/// Insecure file path.
		path: PathBuf,
		/// Observed Unix permission bits.
		mode: u32,
	},
	/// A racing creator left no readable valid winner.
	#[error("racing creator did not publish a valid secret placeholder key at {path}")]
	WinnerUnavailable {
		/// Winner file path.
		path: PathBuf,
	},
}

#[cfg(test)]
mod tests {
	use std::sync::{Arc, Barrier};

	use super::*;

	#[test]
	fn exclusive_creators_converge_on_one_key() {
		let scratch = tempfile::tempdir().expect("scratch");
		let path = Arc::new(scratch.path().join(PLACEHOLDER_KEY_FILE));
		let barrier = Arc::new(Barrier::new(8));
		let threads: Vec<_> = (0..8)
			.map(|_| {
				let path = Arc::clone(&path);
				let barrier = Arc::clone(&barrier);
				thread::spawn(move || {
					barrier.wait();
					load_or_create_at(&path).expect("creator")
				})
			})
			.collect();
		let keys: Vec<_> = threads
			.into_iter()
			.map(|thread| thread.join().expect("thread"))
			.collect();
		assert!(keys.iter().all(|key| key == &keys[0]));
		assert_eq!(read_at(&path).expect("read").as_deref(), Some(keys[0].as_str()));
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;
			assert_eq!(fs::metadata(&*path).expect("metadata").permissions().mode() & 0o777, 0o600);
		}
	}

	#[test]
	fn read_without_create_does_not_touch_disk() {
		let scratch = tempfile::tempdir().expect("scratch");
		let path = scratch.path().join(PLACEHOLDER_KEY_FILE);
		assert_eq!(read_at(&path).expect("missing key"), None);
		assert!(!path.exists());
	}
}
