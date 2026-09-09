//! ZFS snapshot/clone-based isolation.
//!
//! ZFS can create a writable clone from a point-in-time snapshot without
//! copying file data. This backend only accepts a `lower` path that exactly
//! matches a mounted ZFS dataset mountpoint, snapshots that dataset, and clones
//! it to a sibling dataset mounted at `merged`.

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(unix))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct ZfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&ZfsBackend
}

#[async_trait]
impl IsolationBackend for ZfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Zfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(unix)]
		{
			imp::probe()
		}
		#[cfg(not(unix))]
		{
			ProbeResult::unavailable("ZFS clone isolation is only available on Unix platforms")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(unix)]
		{
			imp::start(lower, merged)
		}
		#[cfg(not(unix))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("ZFS clone isolation is only available on Unix platforms"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(unix)]
		{
			imp::stop(merged)
		}
		#[cfg(not(unix))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

#[cfg(unix)]
mod imp {
	use std::{
		fs, io,
		path::{Path, PathBuf},
		process::{Command, Output},
	};

	use crate::{IsoError, IsoResult, ProbeResult};

	const SNAP_PREFIX: &str = "pi-iso-";

	pub fn probe() -> ProbeResult {
		if command_available(["version"]) || command_available(["list", "-H"]) {
			ProbeResult::available()
		} else {
			ProbeResult::unavailable("zfs CLI is unavailable or cannot list datasets")
		}
	}

	pub fn start(lower: &Path, merged: &Path) -> IsoResult<()> {
		ensure_zfs_available()?;

		let lower = canonical_existing_dir(lower)?;
		let merged = absolute_path(merged);
		let source = dataset_for_mountpoint(&lower)?.ok_or_else(|| {
			IsoError::unavailable(format!(
				"{} is not exactly a mounted ZFS dataset mountpoint",
				lower.display()
			))
		})?;

		if let Some(parent) = merged.parent() {
			fs::create_dir_all(parent).map_err(|err| {
				IsoError::other(format!("unable to create parent of {}: {err}", merged.display()))
			})?;
		}

		stop(&merged)?;

		let suffix = dataset_suffix(&merged);
		let snapshot = format!("{source}@{SNAP_PREFIX}{suffix}");
		let clone = sibling_dataset(&source, &format!("{SNAP_PREFIX}{suffix}"));

		clear_stale_clone(&clone, &source)?;
		let _ = run_zfs_status(["destroy", snapshot.as_str()]);

		run_zfs_other(["snapshot", snapshot.as_str()])?;
		let mountpoint = merged.to_string_lossy();
		let mount_opt = format!("mountpoint={mountpoint}");
		match run_zfs_other(["clone", "-o", mount_opt.as_str(), snapshot.as_str(), clone.as_str()]) {
			Ok(()) => Ok(()),
			Err(err) => {
				let _ = run_zfs_status(["destroy", snapshot.as_str()]);
				Err(err)
			},
		}
	}

	pub fn stop(merged: &Path) -> IsoResult<()> {
		let merged = absolute_path(merged);
		if !merged.exists() {
			return Ok(());
		}
		match dataset_for_mountpoint(&merged)? {
			Some(dataset) => {
				let origin = zfs_get_value("origin", &dataset)?;
				if !is_own_clone(&dataset, &origin) {
					return Err(IsoError::other(format!(
						"refusing to destroy unrelated ZFS dataset {dataset} mounted at {}",
						merged.display()
					)));
				}
				run_zfs_other(["destroy", dataset.as_str()])?;
				run_zfs_other(["destroy", origin.as_str()])?;
				Ok(())
			},
			None => match fs::remove_dir_all(&merged) {
				Ok(()) => Ok(()),
				Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
				Err(err) => Err(IsoError::other(format!(
					"unable to remove ZFS clone mountpoint {}: {err}",
					merged.display()
				))),
			},
		}
	}

	fn ensure_zfs_available() -> IsoResult<()> {
		if command_available(["version"]) || command_available(["list", "-H"]) {
			Ok(())
		} else {
			Err(IsoError::unavailable("zfs CLI is unavailable or cannot list datasets"))
		}
	}

	fn canonical_existing_dir(path: &Path) -> IsoResult<PathBuf> {
		let resolved = absolute_path(path);
		let meta = fs::metadata(&resolved).map_err(|err| {
			IsoError::unavailable(format!("invalid ZFS clone source {}: {err}", resolved.display()))
		})?;
		if !meta.is_dir() {
			return Err(IsoError::unavailable(format!(
				"ZFS clone source {} is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn dataset_for_mountpoint(path: &Path) -> IsoResult<Option<String>> {
		let wanted = normalize_path(path);
		let output = run_zfs_output(["list", "-H", "-o", "name,mountpoint", "-t", "filesystem"])?;
		let stdout = String::from_utf8_lossy(&output.stdout);
		for line in stdout.lines() {
			let mut fields = line.splitn(2, '\t');
			let Some(name) = fields.next() else { continue };
			let Some(mountpoint) = fields.next() else {
				continue;
			};
			if mountpoint == "-" || mountpoint == "none" || mountpoint == "legacy" {
				continue;
			}
			if normalize_path(Path::new(mountpoint)) == wanted {
				return Ok(Some(name.to_owned()));
			}
		}
		Ok(None)
	}

	fn clear_stale_clone(clone: &str, source: &str) -> IsoResult<()> {
		let output = run_zfs_status(["get", "-H", "-o", "value", "origin", clone]);
		match output {
			Ok(output) if output.status.success() => {
				let origin = trim_stdout(&output);
				if origin.starts_with(source)
					&& origin[source.len()..].starts_with('@')
					&& is_own_snapshot(origin)
				{
					run_zfs_other(["destroy", "-r", clone])
				} else {
					Err(IsoError::other(format!(
						"refusing to destroy existing non-stale ZFS dataset {clone}"
					)))
				}
			},
			Ok(output) => {
				let stderr = String::from_utf8_lossy(&output.stderr);
				if stderr_is_unavailable(&stderr) {
					Ok(())
				} else {
					Err(IsoError::other(format!("zfs get origin {clone}: {}", stderr.trim())))
				}
			},
			Err(err) if err.kind() == io::ErrorKind::NotFound => {
				Err(IsoError::unavailable("zfs CLI is unavailable"))
			},
			Err(err) => Err(IsoError::other(format!("zfs get origin {clone}: {err}"))),
		}
	}

	fn zfs_get_value(property: &str, dataset: &str) -> IsoResult<String> {
		let output = run_zfs_output(["get", "-H", "-o", "value", property, dataset])?;
		Ok(trim_stdout(&output).to_owned())
	}

	fn run_zfs_other<const N: usize>(args: [&str; N]) -> IsoResult<()> {
		let output = run_zfs_status(args).map_err(|err| {
			if err.kind() == io::ErrorKind::NotFound {
				IsoError::unavailable("zfs CLI is unavailable")
			} else {
				IsoError::other(format!("unable to execute zfs: {err}"))
			}
		})?;
		if output.status.success() {
			return Ok(());
		}
		let stderr = String::from_utf8_lossy(&output.stderr);
		if stderr_is_unavailable(&stderr) {
			Err(IsoError::unavailable(stderr.trim().to_owned()))
		} else {
			Err(IsoError::other(format!("zfs failed: {}", stderr.trim())))
		}
	}

	fn run_zfs_output<const N: usize>(args: [&str; N]) -> IsoResult<Output> {
		let output = run_zfs_status(args).map_err(|err| {
			if err.kind() == io::ErrorKind::NotFound {
				IsoError::unavailable("zfs CLI is unavailable")
			} else {
				IsoError::other(format!("unable to execute zfs: {err}"))
			}
		})?;
		if output.status.success() {
			return Ok(output);
		}
		let stderr = String::from_utf8_lossy(&output.stderr);
		if stderr_is_unavailable(&stderr) {
			Err(IsoError::unavailable(stderr.trim().to_owned()))
		} else {
			Err(IsoError::other(format!("zfs failed: {}", stderr.trim())))
		}
	}

	fn run_zfs_status<const N: usize>(args: [&str; N]) -> io::Result<Output> {
		Command::new("zfs").args(args).output()
	}

	fn command_available<const N: usize>(args: [&str; N]) -> bool {
		matches!(run_zfs_status(args), Ok(output) if output.status.success())
	}

	fn stderr_is_unavailable(stderr: &str) -> bool {
		let stderr = stderr.to_ascii_lowercase();
		stderr.contains("dataset does not exist")
			|| stderr.contains("no datasets available")
			|| stderr.contains("not a zfs filesystem")
			|| stderr.contains("not a zfs file system")
			|| stderr.contains("operation not supported")
			|| stderr.contains("not supported")
			|| stderr.contains("no such pool")
			|| stderr.contains("modules are not loaded")
			|| stderr.contains("failed to initialize libzfs")
	}

	fn sibling_dataset(source: &str, child: &str) -> String {
		match source.rsplit_once('/') {
			Some((parent, _)) => format!("{parent}/{child}"),
			None => format!("{source}/{child}"),
		}
	}

	fn dataset_suffix(path: &Path) -> String {
		let normalized = normalize_path(&absolute_path(path));
		let bytes = normalized.as_bytes();
		let a = fnv1a64(bytes, 0xcbf29ce484222325);
		let b = fnv1a64(bytes, 0x84222325cbf29ce4 ^ bytes.len() as u64);
		format!("{a:016x}-{b:016x}")
	}

	fn fnv1a64(bytes: &[u8], seed: u64) -> u64 {
		let mut hash = seed;
		for byte in bytes {
			hash ^= u64::from(*byte);
			hash = hash.wrapping_mul(0x100000001b3);
		}
		hash
	}

	fn is_own_name(name: &str) -> bool {
		name.starts_with(SNAP_PREFIX)
			&& name[SNAP_PREFIX.len()..]
				.bytes()
				.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
	}

	fn is_own_snapshot(snapshot: &str) -> bool {
		let Some((_, name)) = snapshot.rsplit_once('@') else {
			return false;
		};
		is_own_name(name)
	}

	fn is_own_clone(dataset: &str, origin: &str) -> bool {
		let Some(name) = dataset.rsplit('/').next() else {
			return false;
		};
		is_own_name(name) && is_own_snapshot(origin)
	}

	fn absolute_path(path: &Path) -> PathBuf {
		if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		}
	}

	fn normalize_path(path: &Path) -> String {
		path.to_string_lossy().trim_end_matches('/').to_owned()
	}

	fn trim_stdout(output: &Output) -> &str {
		std::str::from_utf8(&output.stdout).unwrap_or("").trim()
	}
}
