//! Deterministic endpoint naming shared by every process that dials or binds.
//!
//! The helpers here are pure so the naming rules (stem sanitizing, `sun_path`
//! relocation, Windows pipe shape) are testable on any host OS.

#[cfg(windows)]
use std::path::{self, Path};
#[cfg(unix)]
use std::{
	env,
	path::{Component, Path, PathBuf},
};

use xxhash_rust::xxh64::xxh64;

/// `name` with every char outside `[A-Za-z0-9._-]` replaced by `_`.
pub fn sanitize_stem(name: &str) -> String {
	name
		.chars()
		.map(|ch| {
			if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
				ch
			} else {
				'_'
			}
		})
		.collect()
}

/// 16 lowercase hex digits identifying `bytes`.
pub fn hash16(bytes: &[u8]) -> String {
	format!("{:016x}", xxh64(bytes, 0))
}

/// Private per-user directory that hosts relocated Unix sockets.
#[cfg_attr(windows, allow(dead_code, reason = "pure helper unit-tested on every host"))]
pub fn relocation_dir(euid: u32) -> String {
	format!("/tmp/omp-{euid}")
}

/// Unix socket path for `name` in the already-resolved `dir`.
///
/// `sun_path_max` is the size of `sockaddr_un::sun_path` including the NUL
/// terminator; a path that does not fit is relocated under
/// [`relocation_dir`] with a hashed basename.
#[cfg_attr(windows, allow(dead_code, reason = "pure helper unit-tested on every host"))]
pub fn unix_endpoint(dir: &str, name: &str, euid: u32, sun_path_max: usize) -> String {
	let stem = sanitize_stem(name);
	let direct = if dir.ends_with('/') {
		format!("{dir}{stem}.sock")
	} else {
		format!("{dir}/{stem}.sock")
	};
	if direct.len() < sun_path_max {
		return direct;
	}
	let mut key = Vec::with_capacity(dir.len() + 1 + name.len());
	key.extend_from_slice(dir.as_bytes());
	key.push(0);
	key.extend_from_slice(name.as_bytes());
	format!("{}/{}.sock", relocation_dir(euid), hash16(&key))
}

/// Windows named-pipe path for `name` in the already-resolved `dir`.
#[cfg_attr(not(windows), allow(dead_code, reason = "pure helper unit-tested on every host"))]
pub fn windows_pipe_name(dir: &str, name: &str) -> String {
	format!(r"\\.\pipe\omp-{}-{}", sanitize_stem(name), hash16(dir.to_lowercase().as_bytes()))
}

/// Size of `sockaddr_un::sun_path` on this platform, including the NUL.
#[cfg(unix)]
pub const SUN_PATH_MAX: usize = if cfg!(any(target_os = "linux", target_os = "android")) {
	108
} else {
	104
};

/// Lexically absolute, normalized form of `dir` (like Node's `path.resolve`).
#[cfg(unix)]
pub fn resolve_dir(dir: &str) -> String {
	let path = Path::new(dir);
	let joined = if path.is_absolute() {
		path.to_path_buf()
	} else {
		env::current_dir()
			.unwrap_or_else(|_| PathBuf::from("/"))
			.join(path)
	};
	let mut resolved = PathBuf::from("/");
	for component in joined.components() {
		match component {
			Component::ParentDir => {
				resolved.pop();
			},
			Component::Normal(part) => resolved.push(part),
			Component::RootDir | Component::CurDir | Component::Prefix(_) => {},
		}
	}
	resolved
		.into_os_string()
		.into_string()
		.unwrap_or_else(|raw| raw.to_string_lossy().into_owned())
}

/// Lexically absolute, normalized form of `dir` (like Node's `path.resolve`).
#[cfg(windows)]
pub fn resolve_dir(dir: &str) -> String {
	let target = if dir.is_empty() {
		Path::new(".")
	} else {
		Path::new(dir)
	};
	let resolved = path::absolute(target).unwrap_or_else(|_| target.to_path_buf());
	let mut text = resolved
		.into_os_string()
		.into_string()
		.unwrap_or_else(|raw| raw.to_string_lossy().into_owned());
	// `GetFullPathNameW` keeps a trailing separator; `path.resolve` drops it
	// except on a drive root such as `C:\`.
	while text.len() > 3 && text.ends_with(['\\', '/']) {
		text.pop();
	}
	text
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn sanitizes_stem_per_char() {
		assert_eq!(sanitize_stem("a b"), "a_b");
		assert_eq!(sanitize_stem("Ok.name_1-x"), "Ok.name_1-x");
		assert_eq!(sanitize_stem("a/b\\c:é"), "a_b_c__");
	}

	#[test]
	fn hash16_is_sixteen_hex_digits_and_stable() {
		let hash = hash16(b"abc");
		assert_eq!(hash.len(), 16);
		assert!(
			hash
				.bytes()
				.all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
		);
		assert_eq!(hash, hash16(b"abc"));
		assert_ne!(hash, hash16(b"abd"));
	}

	#[test]
	fn unix_endpoint_keeps_short_paths_in_dir() {
		assert_eq!(unix_endpoint("/tmp/x", "a b", 501, 104), "/tmp/x/a_b.sock");
		assert_eq!(unix_endpoint("/", "s", 501, 104), "/s.sock");
	}

	#[test]
	fn unix_endpoint_relocates_at_sun_path_threshold() {
		// `<dir>/<stem>.sock` plus NUL must fit in `sun_path_max`.
		let name = "n";
		let suffix_len = "/n.sock".len();
		let fits = format!("/{}", "d".repeat(104 - 1 - suffix_len - 1));
		let direct = format!("{fits}/n.sock");
		assert_eq!(direct.len(), 103);
		assert_eq!(unix_endpoint(&fits, name, 501, 104), direct);

		let too_long = format!("{fits}d");
		let relocated = unix_endpoint(&too_long, name, 501, 104);
		let mut key = too_long.clone().into_bytes();
		key.push(0);
		key.extend_from_slice(name.as_bytes());
		assert_eq!(relocated, format!("/tmp/omp-501/{}.sock", hash16(&key)));
		// Linux's larger sun_path keeps the same directory in place.
		assert_eq!(unix_endpoint(&too_long, name, 501, 108), format!("{too_long}/n.sock"));
	}

	#[test]
	fn relocation_hash_separates_dir_and_name() {
		let dir = format!("/{}", "x".repeat(200));
		assert_ne!(unix_endpoint(&dir, "ab", 0, 104), unix_endpoint(&format!("{dir}a"), "b", 0, 104));
	}

	#[test]
	fn windows_pipe_name_shape() {
		let name = windows_pipe_name(r"C:\Users\Me\Proj", "my sock");
		assert_eq!(name, format!(r"\\.\pipe\omp-my_sock-{}", hash16(br"c:\users\me\proj")));
		assert_eq!(name, windows_pipe_name(r"c:\users\me\PROJ", "my sock"));
	}

	#[cfg(unix)]
	#[test]
	fn resolve_dir_normalizes_lexically() {
		assert_eq!(resolve_dir("/a/b/../c/./d/"), "/a/c/d");
		assert_eq!(resolve_dir("/.."), "/");
		let cwd = std::env::current_dir().unwrap();
		assert_eq!(resolve_dir("x"), cwd.join("x").to_str().unwrap());
	}
}
