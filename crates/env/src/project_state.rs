//! Project-scoped runtime state paths kept outside tool-writable workspaces.
//!
//! Both the environment host and every client derive the same owner-local
//! addresses from a data directory and a project root, so the derivation lives
//! beside the client rather than in any one composition.

use std::{
	env, fs, io,
	path::{Path, PathBuf},
};

use omp_core::{Hash32, encoding::hex};

#[cfg(any(unix, windows))]
use crate::build_id::current;
#[cfg(windows)]
use crate::windows::current_user_pipe_scope;

/// Returns the canonical per-project state directory below an owner's private
/// data directory.
///
/// Canonicalizing the project root gives aliases and symlinked paths one stable
/// state identity.
///
/// # Errors
///
/// Fails when `project_root` cannot be canonicalized.
pub fn directory(data_dir: &Path, project_root: &Path) -> io::Result<PathBuf> {
	let root = fs::canonicalize(project_root)?;
	let digest = Hash32::sum(root.as_os_str().as_encoded_bytes());
	Ok(data_dir
		.join("projects")
		.join(hex::encode_n(digest.as_bytes()).as_str()))
}

/// Returns the short owner-local environment socket path for `state_dir`.
///
/// The path is keyed by the running executable's filesystem generation: a
/// rebuilt `omp` binds its own listener immediately while stale-build listeners
/// drain and idle-exit, with no takeover protocol. The document socket stays
/// build-stable because its authority must remain singular per project.
#[cfg(unix)]
#[must_use]
pub fn environment_socket(state_dir: &Path) -> PathBuf {
	let build = current();
	let key = if build.is_empty() {
		"unknown"
	} else {
		&build[..8]
	};
	socket_path(state_dir, &format!("{key}-env"))
}

/// Returns the deterministic current-user environment named pipe.
///
/// The executable-generation key lets rebuilt owners bind immediately while
/// older listeners drain independently.
#[cfg(windows)]
#[must_use]
pub fn environment_socket(state_dir: &Path) -> PathBuf {
	let build = current();
	let key = if build.is_empty() {
		"unknown"
	} else {
		&build[..8]
	};
	windows_pipe_path(state_dir, &format!("{key}-env"))
}

/// Returns the short owner-local document socket path for `state_dir`.
#[cfg(unix)]
#[must_use]
pub fn document_socket(state_dir: &Path) -> PathBuf {
	socket_path(state_dir, "doc")
}
/// Returns the short owner-local DATA socket for one extension host identity.
///
/// The address is domain-separated by the canonical state directory, exact
/// host key fields, runtime session, and runtime generation while its
/// fixed-size filename remains within every supported Unix `sockaddr_un`.
#[cfg(unix)]
#[must_use]
pub fn extension_socket(
	state_dir: &Path,
	layer: &str,
	tier: &str,
	extension: &str,
	session_id: &str,
	session_generation: u64,
) -> PathBuf {
	let canonical = fs::canonicalize(state_dir).unwrap_or_else(|_| state_dir.to_path_buf());
	let mut digest = Hash32::hasher();
	digest.update(b"omp/extension-data-socket/v1");
	for field in [
		canonical.as_os_str().as_encoded_bytes(),
		layer.as_bytes(),
		tier.as_bytes(),
		extension.as_bytes(),
		session_id.as_bytes(),
	] {
		digest.update((field.len() as u64).to_le_bytes());
		digest.update(field);
	}
	digest.update(session_generation.to_le_bytes());
	unix_socket_path(&digest.finalize(), "ext")
}

/// Returns the deterministic current-user document-authority named pipe.
#[cfg(windows)]
#[must_use]
pub fn document_socket(state_dir: &Path) -> PathBuf {
	windows_pipe_path(state_dir, "doc")
}

/// Returns the base directory holding every Environment-owned worktree.
///
/// `OMP_WORKTREE_DIR` overrides configuration. A relative `configured` path
/// resolves against `data_dir`; an absent one defaults to
/// `<data_dir>/worktrees`.
#[must_use]
pub fn worktree_base(data_dir: &Path, configured: Option<&Path>) -> PathBuf {
	if let Some(path) = env::var_os("OMP_WORKTREE_DIR").filter(|value| !value.is_empty()) {
		return PathBuf::from(path);
	}
	match configured {
		Some(path) if path.is_absolute() => path.to_path_buf(),
		Some(path) => data_dir.join(path),
		None => data_dir.join("worktrees"),
	}
}

/// Resolves the project-specific worktree root used by the Environment.
///
/// `configured` is the persisted `worktree.base` policy of the data directory
/// owning `state_dir`.
#[must_use]
pub fn project_worktree_root(state_dir: &Path, configured: Option<&Path>) -> PathBuf {
	let data_dir = owning_data_dir(state_dir);
	let project_key = state_dir
		.file_name()
		.filter(|name| !name.is_empty())
		.map_or_else(
			|| {
				Hash32::sum(state_dir.as_os_str().as_encoded_bytes())
					.to_hex()
					.to_string()
			},
			|name| name.to_string_lossy().into_owned(),
		);
	worktree_base(&data_dir, configured).join(project_key)
}

/// Recovers the data directory owning a `<data>/projects/<key>` state path.
fn owning_data_dir(state_dir: &Path) -> PathBuf {
	state_dir
		.parent()
		.filter(|parent| parent.file_name().is_some_and(|name| name == "projects"))
		.and_then(Path::parent)
		.map_or_else(|| state_dir.to_path_buf(), Path::to_path_buf)
}

#[cfg(unix)]
fn socket_path(state_dir: &Path, kind: &str) -> PathBuf {
	let canonical = fs::canonicalize(state_dir).unwrap_or_else(|_| state_dir.to_path_buf());
	let digest = Hash32::sum(canonical.as_os_str().as_encoded_bytes());
	unix_socket_path(&digest, kind)
}

#[cfg(unix)]
fn unix_socket_path(digest: &Hash32, kind: &str) -> PathBuf {
	let short: [u8; 16] = digest.as_bytes()[..16]
		.try_into()
		.expect("a SHA-256 digest contains 16 prefix bytes");
	PathBuf::from("/tmp").join(format!(
		"omp-{}-{}-{kind}.sock",
		nix::unistd::geteuid().as_raw(),
		hex::encode_n(&short)
	))
}

#[cfg(windows)]
fn windows_pipe_path(state_dir: &Path, kind: &str) -> PathBuf {
	let owner =
		current_user_pipe_scope().expect("the process has an authenticated Windows user SID");
	let mut digest = Hash32::hasher();
	digest.update(b"omp/project-owner-pipe/v1");
	digest.update(&(owner.len() as u64).to_le_bytes());
	digest.update(owner.as_bytes());
	let state = state_dir.as_os_str().as_encoded_bytes();
	digest.update(&(state.len() as u64).to_le_bytes());
	digest.update(state);
	digest.update(&(kind.len() as u64).to_le_bytes());
	digest.update(kind.as_bytes());
	let digest = hex::encode_n(digest.finalize().as_bytes());
	PathBuf::from(format!(r"\\.\pipe\omp-{}-{kind}", &digest[..32]))
}

#[cfg(all(test, unix))]
mod tests {
	use std::{mem, path::PathBuf};

	use super::{document_socket, environment_socket, extension_socket};

	#[test]
	fn socket_paths_fit_the_platform_address_limit() {
		let state_dir = PathBuf::from("/").join("long-project-state-segment".repeat(32));
		let env = environment_socket(&state_dir);
		let docs = document_socket(&state_dir);
		let extension = extension_socket(
			&state_dir,
			"workspace",
			"trusted",
			"fixture.extension",
			"fixture-session",
			u64::MAX,
		);
		// SAFETY: every all-zero bit pattern is valid for libc's sockaddr_un
		// integer fields and fixed-size character array.
		let address: libc::sockaddr_un = unsafe { mem::zeroed() };
		let capacity = address.sun_path.len();

		assert_ne!(env, docs);
		assert_ne!(env, extension);
		assert_ne!(docs, extension);
		assert!(env.as_os_str().as_encoded_bytes().len() < capacity);
		assert!(docs.as_os_str().as_encoded_bytes().len() < capacity);
		assert!(extension.as_os_str().as_encoded_bytes().len() < capacity);
	}
}

#[cfg(all(test, windows))]
mod windows_tests {

	use super::{document_socket, environment_socket};

	#[test]
	fn pipe_names_are_local_deterministic_and_domain_separated() {
		let state = Path::new(r"C:\Users\owner\AppData\Local\omp\project");
		let first = environment_socket(state);
		assert_eq!(first, environment_socket(state));
		assert_ne!(first, document_socket(state));
		assert!(first.to_string_lossy().starts_with(r"\\.\pipe\omp-"));
	}

	#[test]
	fn project_identity_changes_the_pipe_name() {
		let first = Path::new(r"C:\omp\projects\one");
		let second = Path::new(r"C:\omp\projects\two");
		assert_ne!(environment_socket(first), environment_socket(second));
		assert_ne!(document_socket(first), document_socket(second));
	}
}
