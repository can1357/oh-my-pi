use std::{
	fs,
	path::{Path, PathBuf},
	sync::LazyLock,
};

use tokio::runtime::{Builder, Runtime};

use crate::desktop::error::{CoreResult, DesktopError};

/// Process-wide Tokio runtime shared by every xdg-desktop-portal call.
///
/// `ashpd` caches a process-global D-Bus connection whose I/O tasks are bound
/// to the runtime that first creates it. A long-lived multi-thread runtime
/// keeps that connection alive and drives it while portal callers block.
static PORTAL_RUNTIME: LazyLock<Result<Runtime, String>> = LazyLock::new(|| {
	Builder::new_multi_thread()
		.worker_threads(1)
		.enable_all()
		.build()
		.map_err(|err| err.to_string())
});

/// Borrow the shared portal runtime, surfacing a one-time build failure.
pub(super) fn portal_runtime() -> CoreResult<&'static Runtime> {
	PORTAL_RUNTIME
		.as_ref()
		.map_err(|err| DesktopError::internal(format!("xdg-desktop-portal runtime: {err}")))
}

/// File name of the `RemoteDesktop` restore token that pre-#7884 builds wrote
/// (world-readable) during read-only `computer` calls. Nothing reads it after
/// #7884 dropped the restore-token path.
const ORPHANED_REMOTE_DESKTOP_TOKEN: &str = "remote-desktop-token";

/// Resolves the `omp` state directory (`$XDG_STATE_HOME/omp` or
/// `~/.local/state/omp`) that holds portal tokens.
fn omp_state_dir() -> Option<PathBuf> {
	let base = std::env::var_os("XDG_STATE_HOME")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))?;
	Some(base.join("omp"))
}

fn remove_token_in(dir: &Path) {
	let _ = fs::remove_file(dir.join(ORPHANED_REMOTE_DESKTOP_TOKEN));
}

/// Best-effort removal of the orphaned `RemoteDesktop` restore token left
/// behind by pre-#7884 builds. Runs on Wayland backend construction; a missing
/// file is success, so it is safe to call on every session.
pub(super) fn remove_orphaned_remote_desktop_token() {
	if let Some(dir) = omp_state_dir() {
		remove_token_in(&dir);
	}
}

#[cfg(feature = "wayland-pipewire")]
fn token_path(name: &str) -> Option<PathBuf> {
	Some(omp_state_dir()?.join(name))
}

#[cfg(feature = "wayland-pipewire")]
pub(super) fn read_token(name: &str) -> Option<String> {
	fs::read_to_string(token_path(name)?)
		.ok()
		.map(|token| token.trim().to_string())
		.filter(|token| !token.is_empty())
}

#[cfg(feature = "wayland-pipewire")]
pub(super) fn store_token(name: &str, token: Option<&str>) {
	let (Some(path), Some(token)) = (token_path(name), token) else {
		return;
	};
	let Some(parent) = path.parent() else {
		return;
	};
	if fs::create_dir_all(parent).is_ok() {
		let _ = fs::write(path, token);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// Every portal caller (libei input init and PipeWire capture) must borrow
	/// one persistent runtime; a regression to per-call runtimes would return
	/// distinct instances and re-open the orphaned-connection bug (#7886).
	#[test]
	fn portal_runtime_is_shared_across_calls() {
		let first = portal_runtime().expect("portal runtime builds");
		let second = portal_runtime().expect("portal runtime builds");
		assert!(
			std::ptr::eq(first, second),
			"portal_runtime must hand back one long-lived runtime, not a fresh per-call instance"
		);
	}

	/// The orphaned RemoteDesktop token written by pre-#7884 builds must be
	/// removed, and a second removal on the now-missing file must stay a no-op.
	#[test]
	fn removes_orphaned_remote_desktop_token() {
		let dir = std::env::temp_dir().join(format!("omp-token-test-{}", std::process::id()));
		fs::create_dir_all(&dir).expect("create token test dir");
		let token = dir.join(ORPHANED_REMOTE_DESKTOP_TOKEN);
		fs::write(&token, "cafef00d").expect("plant orphaned token");
		remove_token_in(&dir);
		assert!(!token.exists(), "orphaned token must be removed");
		remove_token_in(&dir);
		let _ = fs::remove_dir_all(&dir);
	}
}
