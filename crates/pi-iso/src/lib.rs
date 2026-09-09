//! Cross-platform isolation PAL.
//!
//! A backend gives the caller a writable "merged" view of a read-only
//! "lower" tree without paying for a deep copy, and tree-cloning backends can
//! also copy-on-write clone a checkout while omitting selected top-level
//! entries:
//!
//! - **macOS** uses `clonefile(2)` to seed an APFS copy-on-write clone.
//! - **Linux** mounts a kernel `overlay` filesystem, falling back to
//!   `fuse-overlayfs` when the syscall is denied.
//! - **Windows** projects an existing tree through `ProjFS`.
//! - **`Rcopy`** is the cross-platform fallback: `git worktree` if `lower` is a
//!   git repo, plain recursive copy otherwise.
//!
//! Every backend also knows how to surface the changes the workload made.
//! When `merged` is a git repository — true for every git-backed task in
//! omp regardless of which lifecycle backend was used —
//! [`IsolationBackend::diff`] delegates to `git diff` so the output is
//! byte-identical to what `git apply` consumes downstream. For non-git trees
//! (only reachable via `Rcopy`) it walks both trees, using `(size, mtime)` as a
//! cheap short-circuit before doing a content diff.

#![cfg_attr(
	not(any(target_os = "macos", target_os = "linux", windows)),
	allow(unused_imports, dead_code, reason = "platform without an isolation backend")
)]

use std::{fmt, path::Path};

use async_trait::async_trait;

mod apfs;
mod btrfs;
mod diff;
mod linux_reflink;
mod overlayfs;
mod projfs;
mod rcopy;
mod windows_block_clone;
mod zfs;

pub use diff::{ChangeKind, Diff, FileChange};

/// Stable identifier for which backend a build was compiled with.
///
/// Exposed to callers so they can render diagnostics or pick mode-specific
/// configuration without re-implementing the per-OS branching.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum BackendKind {
	/// APFS `clonefile(2)` reflink clone (macOS).
	Apfs,
	/// btrfs `subvolume snapshot` clone (Linux + btrfs).
	Btrfs,
	/// ZFS dataset snapshot+clone (Linux/FreeBSD/macOS + a ZFS pool).
	Zfs,
	/// Linux `FICLONE` per-file reflink tree (btrfs, XFS+reflink, bcachefs, …).
	LinuxReflink,
	/// Kernel `overlay` filesystem (Linux), with optional `fuse-overlayfs`
	/// fallback.
	Overlayfs,
	/// Windows `FSCTL_DUPLICATE_EXTENTS_TO_FILE` block clone tree (NTFS/ReFS).
	WindowsBlockClone,
	/// Windows Projected File System.
	Projfs,
	/// `git worktree` when `lower` is a git repo, otherwise plain recursive
	/// copy. Always available; the universal fallback.
	Rcopy,
}

impl BackendKind {
	/// Whether this backend can clone a directory tree in place.
	pub const fn clones_tree(self) -> bool {
		matches!(self, Self::Apfs | Self::LinuxReflink | Self::WindowsBlockClone)
	}

	/// Short, stable string identifier. Used by the napi shim.
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Apfs => "apfs",
			Self::Btrfs => "btrfs",
			Self::Zfs => "zfs",
			Self::LinuxReflink => "linux-reflink",
			Self::Overlayfs => "overlayfs",
			Self::WindowsBlockClone => "windows-block-clone",
			Self::Projfs => "projfs",
			Self::Rcopy => "rcopy",
		}
	}

	/// Parse the inverse of [`Self::as_str`]. Returns `None` for unknown
	/// strings so callers can surface a precise error.
	#[allow(
		clippy::should_implement_trait,
		reason = "Option<Self> return is more ergonomic than FromStr's Result"
	)]
	pub fn from_str(s: &str) -> Option<Self> {
		Some(match s {
			"apfs" => Self::Apfs,
			"btrfs" => Self::Btrfs,
			"zfs" => Self::Zfs,
			"linux-reflink" | "reflink" => Self::LinuxReflink,
			"overlayfs" => Self::Overlayfs,
			"windows-block-clone" | "block-clone" => Self::WindowsBlockClone,
			"projfs" => Self::Projfs,
			"rcopy" => Self::Rcopy,
			_ => return None,
		})
	}

	/// Backend chosen for the current build target when the caller doesn't
	/// specify one. Platform-native `CoW` first, [`Rcopy`](Self::Rcopy) as the
	/// last resort.
	pub const fn native() -> Self {
		#[cfg(target_os = "macos")]
		{
			Self::Apfs
		}
		#[cfg(target_os = "linux")]
		{
			Self::Overlayfs
		}
		#[cfg(windows)]
		{
			Self::Projfs
		}
		#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
		{
			Self::Rcopy
		}
	}
}

#[cfg(target_os = "macos")]
const MACOS_AUTO_ORDER: &[BackendKind] = &[BackendKind::Apfs, BackendKind::Zfs, BackendKind::Rcopy];
#[cfg(target_os = "linux")]
const LINUX_AUTO_ORDER: &[BackendKind] = &[
	BackendKind::Btrfs,
	BackendKind::Zfs,
	BackendKind::LinuxReflink,
	BackendKind::Overlayfs,
	BackendKind::Rcopy,
];
#[cfg(windows)]
const WINDOWS_AUTO_ORDER: &[BackendKind] =
	&[BackendKind::WindowsBlockClone, BackendKind::Projfs, BackendKind::Rcopy];
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
const FALLBACK_AUTO_ORDER: &[BackendKind] = &[BackendKind::Rcopy];

impl fmt::Display for BackendKind {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.as_str())
	}
}

/// Result of a backend probe.
///
/// `available == false` means [`IsolationBackend::start`] will fail with
/// [`IsoError::Unavailable`]; `reason` is a human-readable explanation
/// suitable for surfacing in a UI.
#[derive(Debug, Clone)]
pub struct ProbeResult {
	pub available: bool,
	pub reason:    Option<String>,
}

impl ProbeResult {
	pub const fn available() -> Self {
		Self { available: true, reason: None }
	}

	pub fn unavailable(reason: impl Into<String>) -> Self {
		Self { available: false, reason: Some(reason.into()) }
	}
}

/// Error returned by every backend operation.
///
/// `Unavailable` is the only variant callers are expected to treat specially —
/// it indicates the platform prerequisite is missing (no `ProjFS` DLL, no
/// `overlay` support, etc.) and the workload should fall back rather than
/// surface a hard failure.
#[derive(Debug, Clone)]
pub enum IsoError {
	Unavailable(String),
	Other(String),
}

impl IsoError {
	pub fn unavailable(msg: impl Into<String>) -> Self {
		Self::Unavailable(msg.into())
	}

	pub fn other(msg: impl Into<String>) -> Self {
		Self::Other(msg.into())
	}

	pub const fn is_unavailable(&self) -> bool {
		matches!(self, Self::Unavailable(_))
	}

	pub fn message(&self) -> &str {
		match self {
			Self::Unavailable(m) | Self::Other(m) => m,
		}
	}
}

impl fmt::Display for IsoError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(self.message())
	}
}

impl std::error::Error for IsoError {}

pub type IsoResult<T> = Result<T, IsoError>;

/// Build the [`IsoError::Other`] for a failed external command, rendered as
/// `<what> (exit <code>): <trimmed stderr>`.
///
/// `stderr` is decoded lossily. `code` is preformatted by the caller so
/// per-site conventions for signal deaths (`-1` vs `?`) are preserved.
pub(crate) fn command_failed(
	what: impl fmt::Display,
	code: impl fmt::Display,
	stderr: &[u8],
) -> IsoError {
	let stderr = String::from_utf8_lossy(stderr);
	IsoError::other(format!("{what} (exit {code}): {}", stderr.trim()))
}

/// Backend contract.
///
/// `lower` is the read-only source tree; `merged` is the destination where
/// the writable view is materialised. Implementations are responsible for
/// creating any auxiliary directories (e.g. overlayfs upper/work dirs) and
/// for tearing them down in [`stop`](Self::stop).
///
/// `start` / `stop` are synchronous because the platform primitives they
/// wrap (`mount`, `clonefile`, `PrjStartVirtualizing`) are blocking
/// syscalls that callers are expected to drive from `spawn_blocking`.
/// [`diff`](Self::diff) is async because it does heavy I/O — walking
/// trees, reading files, spawning git — and benefits from the runtime
/// interleaving requests with other work.
#[async_trait]
pub trait IsolationBackend: Send + Sync {
	fn kind(&self) -> BackendKind;

	fn probe(&self) -> ProbeResult;

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()>;

	/// Clone `lower` into `merged` copy-on-write, omitting named top-level
	/// entries.
	fn clone_tree(
		&self,
		_lower: &Path,
		_merged: &Path,
		_skip: &[&std::ffi::OsStr],
	) -> IsoResult<()> {
		Err(IsoError::unavailable(format!("{} cannot clone a directory tree in place", self.kind())))
	}

	fn stop(&self, merged: &Path) -> IsoResult<()>;

	/// Capture the changes between `lower` and the current state of
	/// `merged`. The default implementation delegates to `git diff` when
	/// `merged` is a git working tree, otherwise walks both trees using
	/// `(size, mtime)` to skip equal files before falling back to a
	/// content comparison.
	///
	/// Backends are free to override when they know a cheaper path —
	/// overlayfs can scan the upper dir, `ProjFS` can query the placeholder
	/// set — but the default is correct everywhere.
	async fn diff(&self, lower: &Path, merged: &Path) -> IsoResult<Diff> {
		diff::default_diff(lower, merged).await
	}
}

/// Returns the backend selected for the current build target.
///
/// Each backend is a unit struct with no per-call state, so we hand out a
/// `&'static` reference and avoid the indirection of building a fresh trait
/// object on every call.
pub fn default_backend() -> &'static dyn IsolationBackend {
	backend(BackendKind::native())
}

/// Look up a backend by [`BackendKind`].
///
/// Every kind is dispatchable in every build; backends that aren't compiled
/// in for the current target (`Apfs` off Linux/macOS, `Projfs` off Windows…)
/// return their own platform stub which fails
/// [`probe`](IsolationBackend::probe) with `available = false` and rejects
/// [`start`](IsolationBackend::start) with [`IsoError::Unavailable`]. This way
/// the napi shim can mirror the user's `task.isolation.mode` setting without an
/// extra "is this platform" check.
pub fn backend(kind: BackendKind) -> &'static dyn IsolationBackend {
	match kind {
		BackendKind::Apfs => apfs::backend(),
		BackendKind::Btrfs => btrfs::backend(),
		BackendKind::Zfs => zfs::backend(),
		BackendKind::LinuxReflink => linux_reflink::backend(),
		BackendKind::Overlayfs => overlayfs::backend(),
		BackendKind::WindowsBlockClone => windows_block_clone::backend(),
		BackendKind::Projfs => projfs::backend(),
		BackendKind::Rcopy => &rcopy::RcopyBackend,
	}
}

/// Convenience accessor for [`default_backend`]'s [`BackendKind`].
pub fn backend_kind() -> BackendKind {
	default_backend().kind()
}

/// Backend preference order for automatic isolation on this build target.
///
/// The order is intentionally broader than [`BackendKind::native`]: it tries
/// filesystem-native snapshot/reflink mechanisms first, then mount/projection
/// overlays, and keeps [`BackendKind::Rcopy`] as the universal final fallback.
pub const fn auto_order() -> &'static [BackendKind] {
	#[cfg(target_os = "macos")]
	{
		MACOS_AUTO_ORDER
	}
	#[cfg(target_os = "linux")]
	{
		LINUX_AUTO_ORDER
	}
	#[cfg(windows)]
	{
		WINDOWS_AUTO_ORDER
	}
	#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
	{
		FALLBACK_AUTO_ORDER
	}
}

/// Outcome of [`resolve`].
///
/// `kind` is the first host-available backend to try. `candidates` contains
/// every host-available backend in fallback order, starting with `kind`, so
/// callers can retry when a backend is unavailable for a specific filesystem
/// path. `fell_back` is `true` when a `preferred` choice (or earlier automatic
/// candidate) was unusable. `reason` carries the first unavailable probe's
/// explanation when available.
#[derive(Debug, Clone)]
pub struct Resolution {
	pub kind:       BackendKind,
	pub candidates: Vec<BackendKind>,
	pub fell_back:  bool,
	pub reason:     Option<String>,
}

/// Host-available tree-cloning backends in fallback order.
///
/// A preferred cloning backend is tried first when available. Non-cloning
/// backends are excluded.
pub fn clone_candidates(preferred: Option<BackendKind>) -> Vec<BackendKind> {
	let mut candidates = Vec::new();
	if let Some(kind) = preferred
		&& kind.clones_tree()
		&& backend(kind).probe().available
	{
		candidates.push(kind);
	}
	for &kind in auto_order() {
		if Some(kind) != preferred && kind.clones_tree() && backend(kind).probe().available {
			candidates.push(kind);
		}
	}
	candidates
}

/// Pick the best backend whose host-level prerequisites are available.
///
/// Caller priority:
/// 1. If `preferred` is `Some` and its [`probe`](IsolationBackend::probe)
///    reports `available`, use it as-is.
/// 2. Otherwise walk [`auto_order`], skipping `preferred` if present.
/// 3. [`BackendKind::Rcopy`] is the final automatic candidate and is expected
///    to be available on every platform.
///
/// This is only a host-level probe. Some backends still reject a specific
/// `lower`/`merged` pair at [`IsolationBackend::start`] time (cross-device
/// reflinks, non-subvolume btrfs paths, non-ZFS mountpoints).
pub fn resolve(preferred: Option<BackendKind>) -> Resolution {
	let mut reason = None;
	let mut candidates = Vec::with_capacity(auto_order().len() + usize::from(preferred.is_some()));

	if let Some(p) = preferred {
		let probe = backend(p).probe();
		if probe.available {
			candidates.push(p);
		} else {
			reason = probe.reason;
		}
	}

	for candidate in auto_order() {
		if Some(*candidate) == preferred {
			continue;
		}
		let probe = backend(*candidate).probe();
		if probe.available {
			candidates.push(*candidate);
		} else if reason.is_none() {
			reason = probe.reason;
		}
	}

	if candidates.is_empty() {
		candidates.push(BackendKind::Rcopy);
	}
	let kind = candidates[0];
	let fell_back = match preferred {
		Some(p) => kind != p,
		None => kind != auto_order()[0],
	};

	Resolution { kind, candidates, fell_back, reason }
}
