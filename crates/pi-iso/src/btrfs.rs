//! Linux btrfs subvolume snapshot isolation.
//!
//! When `lower` is a btrfs subvolume, `btrfs subvolume snapshot` creates an
//! O(1) writable snapshot at `merged`. The CLI owns the filesystem-specific
//! details; this backend only validates paths, invokes it without a shell, and
//! removes the snapshot on [`stop`](IsolationBackend::stop).

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(target_os = "linux"))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct BtrfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&BtrfsBackend
}

#[async_trait]
impl IsolationBackend for BtrfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Btrfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(target_os = "linux")]
		{
			imp::probe()
		}
		#[cfg(not(target_os = "linux"))]
		{
			ProbeResult::unavailable("btrfs snapshot isolation is only available on Linux")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("btrfs snapshot isolation is only available on Linux"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(target_os = "linux")]
		{
			imp::stop(merged)
		}
		#[cfg(not(target_os = "linux"))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(target_os = "linux")]
mod imp {
	use std::{
		fs,
		path::{Path, PathBuf},
		process::{Command, Stdio},
	};

	use crate::{IsoError, IsoResult, ProbeResult};

	pub fn probe() -> ProbeResult {
		match Command::new("btrfs")
			.arg("version")
			.stdin(Stdio::null())
			.stdout(Stdio::null())
			.stderr(Stdio::null())
			.status()
		{
			Ok(status) if status.success() => ProbeResult::available(),
			Ok(status) => ProbeResult::unavailable(format!(
				"btrfs CLI probe failed with exit {}",
				status.code().unwrap_or(-1)
			)),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
				ProbeResult::unavailable("`btrfs` CLI not on PATH")
			},
			Err(err) => ProbeResult::unavailable(format!("unable to probe btrfs CLI: {err}")),
		}
	}

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		let lower = canonical_existing_dir(lower)?;
		prepare_destination(merged)?;

		let output = Command::new("btrfs")
			.args(["subvolume", "snapshot"])
			.arg(&lower)
			.arg(merged)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.output()
			.map_err(|err| {
				if err.kind() == std::io::ErrorKind::NotFound {
					IsoError::unavailable("`btrfs` CLI not on PATH")
				} else {
					IsoError::other(format!("spawn btrfs subvolume snapshot: {err}"))
				}
			})?;

		if output.status.success() {
			return Ok(());
		}

		let _ = delete_subvolume_or_tree(merged);
		let message = command_message(&output.stderr, &output.stdout);
		if is_unsupported_btrfs_failure(&message) {
			return Err(IsoError::unavailable(format!(
				"btrfs snapshot unsupported for {} -> {}: {message}",
				lower.display(),
				merged.display()
			)));
		}
		Err(IsoError::other(format!(
			"btrfs subvolume snapshot {} -> {} (exit {}): {message}",
			lower.display(),
			merged.display(),
			output.status.code().unwrap_or(-1)
		)))
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		delete_subvolume_or_tree(merged)
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		};
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("invalid btrfs snapshot source {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::other(format!(
				"btrfs snapshot source {} is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn prepare_destination(merged: &Path) -> IsoResult<()> {
		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("create parent of {}: {err}", merged.display()))
			})?;
		}
		delete_subvolume_or_tree(merged).map_err(|err| match err {
			IsoError::Other(message) => IsoError::other(format!(
				"unable to clear {} before btrfs snapshot: {message}",
				merged.display()
			)),
			other => other,
		})
	}

	fn delete_subvolume_or_tree(path: &Path) -> IsoResult<()> {
		if !path_exists(path)? {
			return Ok(());
		}

		match Command::new("btrfs")
			.args(["subvolume", "delete"])
			.arg(path)
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.output()
		{
			Ok(output) if output.status.success() => Ok(()),
			Ok(output) => {
				let message = command_message(&output.stderr, &output.stdout);
				if is_not_subvolume_failure(&message) || is_unsupported_btrfs_failure(&message) {
					remove_tree_if_present(path)
				} else {
					Err(IsoError::other(format!(
						"btrfs subvolume delete {} (exit {}): {message}",
						path.display(),
						output.status.code().unwrap_or(-1)
					)))
				}
			},
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => remove_tree_if_present(path),
			Err(err) => Err(IsoError::other(format!("spawn btrfs subvolume delete: {err}"))),
		}
	}

	fn remove_tree_if_present(path: &Path) -> IsoResult<()> {
		match fs::symlink_metadata(path) {
			Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)
				.map_err(|err| IsoError::other(format!("remove {}: {err}", path.display()))),
			Ok(_) => fs::remove_file(path)
				.map_err(|err| IsoError::other(format!("remove {}: {err}", path.display()))),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
			Err(err) => Err(IsoError::other(format!("inspect {}: {err}", path.display()))),
		}
	}

	fn path_exists(path: &Path) -> IsoResult<bool> {
		match fs::symlink_metadata(path) {
			Ok(_) => Ok(true),
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
			Err(err) => Err(IsoError::other(format!("inspect {}: {err}", path.display()))),
		}
	}

	fn command_message(stderr: &[u8], stdout: &[u8]) -> String {
		let stderr = String::from_utf8_lossy(stderr);
		let stderr = stderr.trim();
		if !stderr.is_empty() {
			return stderr.to_owned();
		}
		let stdout = String::from_utf8_lossy(stdout);
		let stdout = stdout.trim();
		if stdout.is_empty() {
			"no command output".to_string()
		} else {
			stdout.to_owned()
		}
	}

	fn is_unsupported_btrfs_failure(message: &str) -> bool {
		let message = message.to_ascii_lowercase();
		message.contains("not a btrfs filesystem")
			|| message.contains("not a btrfs file system")
			|| message.contains("not a subvolume")
			|| message.contains("not btrfs")
			|| message.contains("invalid argument")
			|| message.contains("operation not supported")
			|| message.contains("inappropriate ioctl")
	}

	fn is_not_subvolume_failure(message: &str) -> bool {
		let message = message.to_ascii_lowercase();
		message.contains("not a subvolume")
			|| message.contains("not a btrfs filesystem")
			|| message.contains("not a btrfs file system")
	}
}
