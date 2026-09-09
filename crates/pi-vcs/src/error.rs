//! Error type shared by the git and jj backends.
//!
//! Failure modes that TypeScript callers previously detected by regexing
//! subprocess stderr (e.g. an empty cherry-pick) are first-class variants here
//! so the TS layer can match on a structured `kind` instead of message text.

use std::path::PathBuf;

/// Crate-wide result alias.
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Unified error for all VCS operations.
#[derive(Debug, thiserror::Error)]
pub enum Error {
	/// The directory is not inside a git repository / jj workspace.
	#[error("not a repository: {path}")]
	NotARepository {
		/// Directory the lookup started from.
		path: PathBuf,
	},

	/// A named ref (branch, tag, `refs/...`) does not exist.
	#[error("reference not found: {name}")]
	RefNotFound {
		/// The ref name as given by the caller.
		name: String,
	},

	/// A revision/object lookup failed (`rev-parse` style spec, blob path,
	/// tree).
	#[error("object not found: {spec}")]
	ObjectNotFound {
		/// The revision or object spec as given by the caller.
		spec: String,
	},

	/// Cherry-picking `sha` produced an empty commit (already applied or
	/// auto-resolved to HEAD). Callers should skip and continue the range —
	/// replaces the historical `/the previous cherry-pick is now empty/` stderr
	/// regex.
	#[error("cherry-pick of {sha} is empty")]
	EmptyCherryPick {
		/// The commit that collapsed to a no-op.
		sha: String,
	},

	/// A merge-style operation (cherry-pick, stash pop, 3-way apply) hit
	/// conflicting changes.
	#[error("merge conflict in {} file(s)", paths.len())]
	Conflict {
		/// Worktree-relative paths left in a conflicted state.
		paths: Vec<String>,
	},

	/// A patch did not apply (context mismatch, missing file, malformed input).
	#[error("patch does not apply: {message}")]
	PatchFailed {
		/// Human-readable reason, including the offending path when known.
		message: String,
	},

	/// A CLI-backed operation (push/fetch/clone, reftable fallback) exited
	/// non-zero. Carries the captured streams for user-facing error surfaces.
	#[error("{}", crate::error::cli_message(command, *exit_code, stdout, stderr))]
	Cli {
		/// Rendered command line (`git push --no-follow-tags …`).
		command:   String,
		/// Process exit code.
		exit_code: i32,
		/// Captured stdout (may be truncated).
		stdout:    String,
		/// Captured stderr (may be truncated).
		stderr:    String,
	},

	/// A CLI-backed operation exceeded its deadline and was killed.
	#[error("timed out: {command}")]
	CliTimeout {
		/// Rendered command line.
		command: String,
	},

	/// Filesystem error outside any more specific failure mode.
	#[error(transparent)]
	Io(#[from] std::io::Error),

	/// An underlying gix / jj-lib failure that has no dedicated variant.
	#[error("{context}: {message}")]
	Backend {
		/// Operation being performed (`"git status"`, `"jj snapshot"`, …).
		context: &'static str,
		/// Backend error rendered as text (full source chain).
		message: String,
	},

	/// The operation was canceled via its interrupt flag.
	#[error("operation canceled")]
	Canceled,
	/// The operation has no implementation on this backend (e.g. staged diffs
	/// on a Jujutsu workspace, which has no index).
	#[error(
		"`{operation}` is not supported on a {} repository",
		match backend {
			crate::VcsKind::Git => "git",
			crate::VcsKind::Jj => "jj",
		}
	)]
	Unsupported {
		/// Operation or feature name as exposed to JS (camelCase).
		operation: &'static str,
		/// Backend that lacks it.
		backend:   crate::VcsKind,
	},
}

impl Error {
	/// Wrap an arbitrary backend error with the operation it occurred in.
	pub fn backend(context: &'static str, err: impl std::fmt::Display) -> Self {
		Self::Backend { context, message: err.to_string() }
	}

	/// Stable machine-readable discriminant for this failure, used as the
	/// `code` property on errors crossing the N-API boundary.
	pub const fn kind(&self) -> &'static str {
		match self {
			Self::NotARepository { .. } => "NotARepository",
			Self::RefNotFound { .. } => "RefNotFound",
			Self::ObjectNotFound { .. } => "ObjectNotFound",
			Self::EmptyCherryPick { .. } => "EmptyCherryPick",
			Self::Conflict { .. } => "Conflict",
			Self::PatchFailed { .. } => "PatchFailed",
			Self::Cli { .. } => "Cli",
			Self::CliTimeout { .. } => "CliTimeout",
			Self::Io(_) => "Io",
			Self::Backend { .. } => "Backend",
			Self::Canceled => "Canceled",
			Self::Unsupported { .. } => "Unsupported",
		}
	}
}

/// Format a CLI failure the way the TS wrapper did: prefer stderr, then
/// stdout, then a generic exit-code message.
pub(crate) fn cli_message(command: &str, exit_code: i32, stdout: &str, stderr: &str) -> String {
	let stderr = stderr.trim();
	if !stderr.is_empty() {
		return stderr.to_owned();
	}
	let stdout = stdout.trim();
	if !stdout.is_empty() {
		return stdout.to_owned();
	}
	format!("{command} failed with exit code {exit_code}")
}
