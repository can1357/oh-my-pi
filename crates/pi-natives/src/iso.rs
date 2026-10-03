//! napi shim for the `pi-iso` PAL.
//!
//! Mirrors [`pi_iso::IsolationBackend`] across the FFI boundary:
//!
//! - `iso_backend()` — kind enum of the platform-native backend.
//! - `iso_resolve(preferred?)` — let the PAL pick the best backend (or honour a
//!   hint) and report any fallback to the caller.
//! - `iso_probe(kind?)` — backend availability, with an optional explicit kind
//!   override; falls back to the native backend when omitted.
//! - `iso_start(kind?, lower, merged)` / `iso_stop(kind?, merged)` — sync
//!   syscalls wrapped in `spawn_blocking` so the JS side gets a normal Promise.
//! - `iso_diff(lower, merged)` — backend-agnostic diff capture; emits one
//!   [`IsoFileChange`] per file. `diff` is `Some(unified)` for text files and
//!   `None` for binary files — callers copy the bytes from `merged` directly if
//!   they need them.
//!
//! `IsoError::Unavailable` is serialised with the `ISO_UNAVAILABLE:`
//! prefix so TS callers can distinguish "this backend isn't installed"
//! from a hard failure.

use napi::bindgen_prelude::*;
use napi_derive::napi;
use pi_iso::{BackendKind, ChangeKind, Diff, FileChange, IsoError, IsolationBackend};

use crate::js;

const ISO_UNAVAILABLE_PREFIX: &str = "ISO_UNAVAILABLE:";
const ISO_UNAVAILABLE_WITH_LEADING_SPACE: &str = " ISO_UNAVAILABLE:";

/// Isolation backend identifier. Numeric so the JS side can `switch` on
/// the enum without string comparisons.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum IsoBackendKind {
	Apfs              = 0,
	Btrfs             = 1,
	Zfs               = 2,
	LinuxReflink      = 3,
	Overlayfs         = 4,
	WindowsBlockClone = 5,
	Projfs            = 6,
	Rcopy             = 7,
}

/// How a single file changed between `lower` and `merged`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi]
pub enum IsoChangeKind {
	Added    = 0,
	Modified = 1,
	Removed  = 2,
}

/// Probe result for a specific isolation backend.
#[napi(object)]
pub struct IsoProbeResult {
	/// True when the backend's prerequisites are satisfied.
	pub available: bool,
	/// Human-readable explanation when `available` is false.
	pub reason:    Option<String>,
	/// Resolved backend kind.
	pub kind:      IsoBackendKind,
}

/// Outcome of [`iso_resolve`].
#[napi(object)]
pub struct IsoResolveResult {
	/// Backend that will actually be tried first.
	pub kind:       IsoBackendKind,
	/// Host-available backends in retry order, starting with `kind`.
	pub candidates: Vec<IsoBackendKind>,
	/// True when the resolver fell back from `preferred` (or from the
	/// first automatic candidate) to a different backend.
	pub fell_back:  bool,
	/// Human-readable reason for the fallback, if any.
	pub reason:     Option<String>,
}

/// One entry in an [`IsoDiff`].
#[napi(object)]
pub struct IsoFileChange {
	/// Path relative to `merged`.
	pub path: String,
	pub op:   IsoChangeKind,
	/// Unified-diff text. `None` (`null` in JS) means the file is binary;
	/// read it directly from `merged` if you need the bytes.
	pub diff: Option<String>,
}

#[napi(object)]
pub struct IsoDiff {
	pub files: Vec<IsoFileChange>,
}

/// Kind enum of the backend selected by default for this build target.
#[napi]
pub const fn iso_backend() -> IsoBackendKind {
	to_napi_kind(BackendKind::native())
}

/// Probe whether the requested backend can start on this host. Pass
/// `null`/omit `kind` to probe the platform-native backend.
#[napi]
pub fn iso_probe(kind: Option<IsoBackendKind>) -> IsoProbeResult {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let backend = pi_iso::backend(resolved);
	let probe = backend.probe();
	IsoProbeResult {
		available: probe.available,
		reason:    probe.reason,
		kind:      to_napi_kind(resolved),
	}
}

/// Pick the best backend available right now. `preferred` is treated as
/// a hint — see [`pi_iso::resolve`] for the exact priority rules.
#[napi]
pub fn iso_resolve(preferred: Option<IsoBackendKind>) -> IsoResolveResult {
	let resolution = pi_iso::resolve(preferred.map(from_napi_kind));
	IsoResolveResult {
		kind:       to_napi_kind(resolution.kind),
		candidates: resolution
			.candidates
			.into_iter()
			.map(to_napi_kind)
			.collect(),
		fell_back:  resolution.fell_back,
		reason:     resolution.reason,
	}
}

/// Materialise `merged` as a writable view of `lower` using the requested
/// backend. `kind` defaults to the native backend.
#[napi]
pub async fn iso_start(kind: Option<IsoBackendKind>, lower: String, merged: String) -> Result<()> {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let lower_path = std::path::PathBuf::from(lower);
	let merged_path = std::path::PathBuf::from(merged);
	tokio::task::spawn_blocking(move || pi_iso::backend(resolved).start(&lower_path, &merged_path))
		.await
		.map_err(|err| Error::from_reason(format!("iso_start join: {err}")))?
		.map_err(to_napi_error)
}

/// Tear down a previously started backend at `merged`.
#[napi]
pub async fn iso_stop(kind: Option<IsoBackendKind>, merged: String) -> Result<()> {
	let resolved = kind.map_or_else(BackendKind::native, from_napi_kind);
	let merged_path = std::path::PathBuf::from(merged);
	tokio::task::spawn_blocking(move || pi_iso::backend(resolved).stop(&merged_path))
		.await
		.map_err(|err| Error::from_reason(format!("iso_stop join: {err}")))?
		.map_err(to_napi_error)
}

/// Capture the changes between `lower` and `merged`.
///
/// Uses [`pi_iso::IsolationBackend::diff`]'s default implementation —
/// `git diff` when `merged/.git` exists, otherwise a mtime-skipped tree
/// walk. The backend selection only affects the lifecycle methods; diff
/// behaviour is uniform.
#[napi]
pub async fn iso_diff(lower: String, merged: String) -> Result<IsoDiff> {
	let lower_path = std::path::PathBuf::from(lower);
	let merged_path = std::path::PathBuf::from(merged);
	// Every backend inherits the same default `diff()` body, so we pick
	// Rcopy as the always-available host.
	let backend = pi_iso::backend(BackendKind::Rcopy);
	let diff = backend
		.diff(&lower_path, &merged_path)
		.await
		.map_err(to_napi_error)?;
	Ok(into_iso_diff(diff))
}

/// True if `message` is an error message produced by [`IsoError::Unavailable`].
/// Use this to distinguish "this backend isn't installed" from a hard
/// failure when handling caught errors on the JS side.
#[napi]
pub fn iso_is_unavailable_error(message: napi::JsString) -> Result<bool> {
	let message = js::utf8(message)?;
	Ok(message.starts_with(ISO_UNAVAILABLE_PREFIX)
		|| message.contains(ISO_UNAVAILABLE_WITH_LEADING_SPACE))
}

pub(crate) const fn to_napi_kind(kind: BackendKind) -> IsoBackendKind {
	match kind {
		BackendKind::Apfs => IsoBackendKind::Apfs,
		BackendKind::Btrfs => IsoBackendKind::Btrfs,
		BackendKind::Zfs => IsoBackendKind::Zfs,
		BackendKind::LinuxReflink => IsoBackendKind::LinuxReflink,
		BackendKind::Overlayfs => IsoBackendKind::Overlayfs,
		BackendKind::WindowsBlockClone => IsoBackendKind::WindowsBlockClone,
		BackendKind::Projfs => IsoBackendKind::Projfs,
		BackendKind::Rcopy => IsoBackendKind::Rcopy,
	}
}

pub(crate) const fn from_napi_kind(kind: IsoBackendKind) -> BackendKind {
	match kind {
		IsoBackendKind::Apfs => BackendKind::Apfs,
		IsoBackendKind::Btrfs => BackendKind::Btrfs,
		IsoBackendKind::Zfs => BackendKind::Zfs,
		IsoBackendKind::LinuxReflink => BackendKind::LinuxReflink,
		IsoBackendKind::Overlayfs => BackendKind::Overlayfs,
		IsoBackendKind::WindowsBlockClone => BackendKind::WindowsBlockClone,
		IsoBackendKind::Projfs => BackendKind::Projfs,
		IsoBackendKind::Rcopy => BackendKind::Rcopy,
	}
}

const fn to_napi_change_kind(kind: ChangeKind) -> IsoChangeKind {
	match kind {
		ChangeKind::Added => IsoChangeKind::Added,
		ChangeKind::Modified => IsoChangeKind::Modified,
		ChangeKind::Removed => IsoChangeKind::Removed,
	}
}

fn to_napi_error(err: IsoError) -> Error {
	match err {
		IsoError::Unavailable(msg) => Error::from_reason(format!("{ISO_UNAVAILABLE_PREFIX} {msg}")),
		IsoError::Other(msg) => Error::from_reason(msg),
	}
}

fn into_iso_diff(diff: Diff) -> IsoDiff {
	IsoDiff {
		files: diff
			.files
			.into_iter()
			.map(|f| IsoFileChange {
				path: f.path.to_string_lossy().into_owned(),
				op:   to_napi_change_kind(f.op),
				diff: f.diff,
			})
			.collect(),
	}
}

#[allow(dead_code, reason = "compile-time check that the trait stays dyn-compatible")]
fn _assert_backend_object_safe() {
	fn assert_object_safe(_: &dyn IsolationBackend) {}
	let backend = pi_iso::default_backend();
	assert_object_safe(backend);
	let _: FileChange;
}
