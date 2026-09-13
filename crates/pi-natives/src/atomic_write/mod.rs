//! Native, handle-relative atomic replacement for plain `local://` writes.
//!
//! The N-API boundary validates the root and filename-component grammar once,
//! then passes an owned request to the platform implementation. Platform code
//! owns every filesystem mutation and the commit-state truth.

use std::{ffi::OsString, path::PathBuf};

use napi::{Env, Error, bindgen_prelude::*};
use napi_derive::napi;

use crate::task::{self, CancelToken};

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as platform;
#[cfg(windows)]
use windows as platform;

#[cfg(not(any(unix, windows)))]
compile_error!("atomic local writes require a Unix or Windows platform implementation");

/// Validated native request. Platform implementations receive no URI or
/// caller-selected path below the OMP-owned absolute root.
#[derive(Debug)]
pub struct AtomicWriteRequest {
	pub absolute_root:     PathBuf,
	pub target_components: Vec<OsString>,
	pub content:           Vec<u8>,
	pub executable:        bool,
}

/// Filesystem outcome after a successful replacement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AtomicWriteOutcome {
	pub bytes_written:   u32,
	pub made_executable: bool,
}

/// Truth about whether the target replacement happened.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[napi(string_enum)]
pub enum AtomicWriteCommitState {
	#[napi(value = "COMMITTED")]
	Committed,
	#[napi(value = "NOT_COMMITTED")]
	NotCommitted,
	#[napi(value = "INDETERMINATE")]
	Indeterminate,
}

impl AtomicWriteCommitState {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::Committed => "COMMITTED",
			Self::NotCommitted => "NOT_COMMITTED",
			Self::Indeterminate => "INDETERMINATE",
		}
	}
}

/// Stable machine-readable failure categories for atomic local writes.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[napi(string_enum)]
pub enum AtomicWriteErrorCode {
	#[napi(value = "INVALID_INPUT")]
	InvalidInput,
	#[napi(value = "ABORTED")]
	Aborted,
	#[napi(value = "BUSY")]
	Busy,
	#[napi(value = "UNSUPPORTED")]
	Unsupported,
	#[napi(value = "UNSAFE_PATH")]
	UnsafePath,
	#[napi(value = "IO")]
	Io,
}

impl AtomicWriteErrorCode {
	pub const fn as_str(self) -> &'static str {
		match self {
			Self::InvalidInput => "INVALID_INPUT",
			Self::Aborted => "ABORTED",
			Self::Busy => "BUSY",
			Self::Unsupported => "UNSUPPORTED",
			Self::UnsafePath => "UNSAFE_PATH",
			Self::Io => "IO",
		}
	}
}

/// A native failure together with the replacement truth known at return.
#[derive(Debug)]
pub struct AtomicWriteError {
	pub code:         AtomicWriteErrorCode,
	pub commit_state: AtomicWriteCommitState,
	pub message:      String,
}

impl AtomicWriteError {
	pub fn new(
		code: AtomicWriteErrorCode,
		commit_state: AtomicWriteCommitState,
		message: impl Into<String>,
	) -> Self {
		Self { code, commit_state, message: message.into() }
	}

	pub fn aborted(message: impl Into<String>) -> Self {
		Self::new(AtomicWriteErrorCode::Aborted, AtomicWriteCommitState::NotCommitted, message)
	}

	pub fn invalid_input(message: impl Into<String>) -> Self {
		Self::new(AtomicWriteErrorCode::InvalidInput, AtomicWriteCommitState::NotCommitted, message)
	}
}

/// JavaScript input for [`atomic_local_write`]. napi-rs derives camelCase field
/// names (`absoluteRoot`, `targetComponents`, `contentUtf8`, `executable`).
#[napi(object)]
pub struct AtomicLocalWriteOptions {
	pub absolute_root:     String,
	pub target_components: Vec<String>,
	pub content_utf8:      Uint8Array,
	pub executable:        bool,
}

/// JavaScript result for [`atomic_local_write`].
#[napi(object)]
pub struct AtomicLocalWriteResult {
	pub bytes_written:   u32,
	pub made_executable: bool,
	pub commit_state:    AtomicWriteCommitState,
}

impl From<AtomicWriteOutcome> for AtomicLocalWriteResult {
	fn from(outcome: AtomicWriteOutcome) -> Self {
		Self {
			bytes_written:   outcome.bytes_written,
			made_executable: outcome.made_executable,
			commit_state:    AtomicWriteCommitState::Committed,
		}
	}
}

fn parse_request(
	options: AtomicLocalWriteOptions,
) -> std::result::Result<AtomicWriteRequest, AtomicWriteError> {
	let AtomicLocalWriteOptions { absolute_root, target_components, content_utf8, executable } =
		options;
	if absolute_root.contains('\0') {
		return Err(AtomicWriteError::invalid_input("absoluteRoot must not contain NUL bytes"));
	}

	let absolute_root = PathBuf::from(absolute_root);
	if !absolute_root.is_absolute() {
		return Err(AtomicWriteError::invalid_input("absoluteRoot must be an absolute path"));
	}

	if target_components.is_empty() {
		return Err(AtomicWriteError::invalid_input("targetComponents must not be empty"));
	}

	let mut validated_components = Vec::with_capacity(target_components.len());
	for component in target_components {
		if component.is_empty()
			|| matches!(component.as_str(), "." | "..")
			|| component
				.chars()
				.any(|character| matches!(character, '/' | '\\' | '\0'))
		{
			return Err(AtomicWriteError::invalid_input(
				"targetComponents must contain non-empty single path components",
			));
		}
		validated_components.push(OsString::from(component));
	}

	let content = content_utf8.as_ref();
	if u32::try_from(content.len()).is_err() {
		return Err(AtomicWriteError::invalid_input(
			"contentUtf8 exceeds the maximum supported size",
		));
	}

	Ok(AtomicWriteRequest {
		absolute_root,
		target_components: validated_components,
		content: content.to_vec(),
		executable,
	})
}

/// Compile-time contract for the private Unix/Windows implementations.
type PlatformWrite = fn(
	&AtomicWriteRequest,
	&CancelToken,
) -> std::result::Result<AtomicWriteOutcome, AtomicWriteError>;

#[cfg(unix)]
const _: PlatformWrite = unix::write;
#[cfg(windows)]
const _: PlatformWrite = windows::write;

/// Promise type named so napi-rs emits a plain `Promise<T>` declaration.
type Promise<T> = task::MappedPromise<T, AtomicWriteError>;

fn to_napi_error(env: Env, error: AtomicWriteError) -> Error {
	let AtomicWriteError { code, commit_state, message } = error;
	let fallback_message = message.clone();
	let built: napi::Result<Error> = (|| {
		let mut object = env.create_error(Error::from_reason(message))?;
		object.set_named_property("name", "AtomicLocalWriteError")?;
		object.set_named_property("code", code.as_str())?;
		object.set_named_property("commitState", commit_state.as_str())?;
		Ok(Error::from(object.to_unknown()))
	})();
	built.unwrap_or_else(|_| Error::from_reason(fallback_message))
}

/// Write bytes through a native, handle-relative, same-parent atomic
/// replacement. Invalid DTOs become typed rejections without calling a platform
/// mutator.
#[napi(js_name = "atomicLocalWrite")]
pub fn atomic_local_write(
	options: AtomicLocalWriteOptions,
	#[napi(ts_arg_type = "unknown | undefined")] signal: Option<Unknown>,
) -> Promise<AtomicLocalWriteResult> {
	let request = parse_request(options);
	let cancel_token = CancelToken::new(None, signal);

	task::blocking_mapped("atomic_write", cancel_token, to_napi_error, move |cancel_token| {
		let request = request?;
		platform::write(&request, &cancel_token).map(Into::into)
	})
}
