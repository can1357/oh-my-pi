//! Consumer-facing Git mutation primitives serialized by primary repository
//! root.

use std::{collections::HashSet, io, path::Path, str, sync::Arc};

use bytes::{Bytes, BytesMut};
use omp_core::{IntoStr, Str};
use tokio_util::sync::CancellationToken;

use super::{
	blocking,
	diff::{self, DiffHunk, FileDiff},
	lock,
	repo::Repository,
};

/// A validated subset of one file's diff hunks.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HunkSelector {
	/// Select the complete file patch, including a binary patch body.
	All,
	/// Select one-based hunk indices.
	Indices(Box<[usize]>),
	/// Select hunks intersecting this inclusive new-file line range.
	Lines {
		/// First selected new-file line, inclusive.
		start: u64,
		/// Last selected new-file line, inclusive.
		end:   u64,
	},
}

/// Hunk selection for one exact repository-relative path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HunkSelection {
	/// Exact path as emitted by the complete Git diff.
	pub path:     Str,
	/// Hunk subset to stage.
	pub selector: HunkSelector,
}

/// Inclusive one-based line range on one side of a unified diff.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LineRange {
	/// First selected line, inclusive.
	pub start: u64,
	/// Last selected line, inclusive.
	pub end:   u64,
}

impl LineRange {
	/// Creates an inclusive one-based line range.
	pub const fn new(start: u64, end: u64) -> Self {
		Self { start, end }
	}

	fn contains(self, line: u64) -> bool {
		self.start <= line && line <= self.end
	}

	fn is_valid(self) -> bool {
		self.start != 0 && self.start <= self.end
	}
}

/// Selected old-side deletions and new-side additions for a partial patch.
///
/// At least one side must be present. Supplying both sides allows one visual
/// selection to include removed and added lines from a replacement.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DiffLineSelection {
	/// Old-file line range selecting `-` records.
	pub old: Option<LineRange>,
	/// New-file line range selecting `+` records.
	pub new: Option<LineRange>,
}

impl DiffLineSelection {
	/// Selects only additions in an inclusive new-file range.
	pub const fn new_lines(start: u64, end: u64) -> Self {
		Self { old: None, new: Some(LineRange::new(start, end)) }
	}
}
/// Direction in which a synthesized line patch will be applied.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LinePatchDirection {
	/// Apply the patch from its old side to its new side.
	Apply,
	/// Apply the patch through `git apply --reverse`.
	Reverse,
}

/// Why a selective-hunk request was rejected before mutation.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SelectionError {
	/// No file patch had the requested path.
	#[error("no complete diff exists for path {path}")]
	PathMissing {
		/// Requested path.
		path: Str,
	},
	/// A path appeared more than once in one request.
	#[error("path {path} has duplicate hunk selections")]
	DuplicatePath {
		/// Duplicated path.
		path: Str,
	},
	/// Binary patches can only be selected as a whole.
	#[error("binary path {path} does not support selective hunks")]
	BinarySubset {
		/// Binary path.
		path: Str,
	},
	/// A one-based hunk index was zero or exceeded the complete file diff.
	#[error("path {path} requested hunk {index}, but the diff has {hunk_count} hunks")]
	InvalidHunkIndex {
		/// Requested path.
		path:       Str,
		/// Invalid one-based index.
		index:      usize,
		/// Complete hunk count for the file.
		hunk_count: usize,
	},
	/// A line range was empty or started at line zero.
	#[error("path {path} has an invalid line range")]
	InvalidLineRange {
		/// Requested path.
		path: Str,
	},
	/// None of the file's hunks matched the selector.
	#[error("no hunks matched path {path}")]
	NoMatchingHunks {
		/// Requested path.
		path: Str,
	},
	/// None of the selected line coordinates referred to a changed line.
	#[error("no changed lines matched path {path}")]
	NoMatchingLines {
		/// Requested path.
		path: Str,
	},
}

/// Failure before Git can return an exact mutation outcome.
#[derive(Debug, thiserror::Error)]
pub enum MutationError {
	/// Repository admission failed.
	#[error(transparent)]
	Lock(#[from] lock::LockError),
	/// A selected worktree file could not be read exactly.
	#[error("selected worktree file could not be read")]
	WorktreeRead(#[source] io::Error),
	/// The VCS backend rejected the operation.
	#[error(transparent)]
	Vcs(#[from] omp_vcs::Error),
	/// Selective staging was invalid against the captured complete diff.
	#[error(transparent)]
	Selection(#[from] SelectionError),
	/// Git emitted a non-UTF-8 scalar where its plumbing contract requires text.
	#[error("Git emitted a non-UTF-8 scalar")]
	NonUtf8,
	/// The caller requested an isolation-only operation through the wrong
	/// feature identity.
	#[error("Git isolation operation is not available to this consumer")]
	IsolationConsumer,
	/// The requested feature branch escaped its compile-time namespace.
	#[error("Git isolation branch is outside the consumer namespace")]
	IsolationBranch,
}
/// Closed identities permitted to perform feature-internal Git transactions.
///
/// This is deliberately not stringly typed: adding a consumer is a source
/// change subject to review, and no agent or command can mint a commit
/// authority at runtime.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitMutationConsumer {
	/// Autoresearch experiment isolation transactions.
	Autoresearch,
	/// User-driven `omp git` and `/git` staging-and-commit surface.
	InteractiveGit,
}

/// Fixed autoresearch transaction records accepted by [`GitMutation`].
///
/// There is intentionally no arbitrary commit-message variant. The mutation
/// API renders these records itself so it cannot become the §19 agentic
/// commit surface.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum IsolationCommit<'a> {
	/// Preserve the user's dirty tree as the experiment baseline.
	AutoresearchBaseline,
	/// Record the validated benchmark harness before the first run.
	AutoresearchHarness {
		/// Experiment display name.
		name: &'a str,
		/// Optional user goal.
		goal: Option<&'a str>,
	},
	/// Keep one measured experiment.
	AutoresearchRun {
		/// Human-readable experiment description.
		description:  &'a str,
		/// Canonical JSON metrics payload generated by autoresearch.
		metrics_json: &'a str,
	},
}

/// Successful in-process mutation result.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct OperationOutput;

/// Exact outcome of a repository mutation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MutationOutcome {
	/// Git completed the requested mutation.
	Applied(OperationOutput),
	/// Git stopped with unmerged index entries and preserved recoverable state.
	Conflict(OperationOutput),
	/// Git rejected the operation without a proven partial effect.
	Rejected(OperationOutput),
}

impl MutationOutcome {
	/// Returns whether Git completed successfully.
	pub const fn is_applied(&self) -> bool {
		matches!(self, Self::Applied(_))
	}
}

/// Patch application flags accepted by Git's binary-safe stdin path.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PatchOptions {
	/// Permit Git binary patch bodies.
	pub binary:    bool,
	/// Check applicability without changing the repository.
	pub check:     bool,
	/// Apply to the index rather than only the worktree.
	pub cached:    bool,
	/// Apply the patch in reverse.
	pub reverse:   bool,
	/// Fall back to Git's three-way merge machinery.
	pub three_way: bool,
}

/// Exact result of a patch preflight.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PatchCheck {
	/// Whether Git proved that the patch can be applied.
	pub applies: bool,
	/// Complete bounded command output and exit status.
	pub output:  OperationOutput,
}

/// Typed cherry-pick result; advancing the sequencer remains caller-controlled.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CherryPickOutcome {
	/// The selected commit was applied.
	Applied(OperationOutput),
	/// The current sequencer commit collapsed to an empty change.
	Empty(OperationOutput),
	/// Git left recoverable unmerged entries for the caller to resolve or abort.
	Conflict(OperationOutput),
	/// Git rejected the request for another reason.
	Rejected(OperationOutput),
}

/// Result of creating an include-untracked stash.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StashPushOutcome {
	/// Whether `refs/stash` changed to a newly-created entry.
	pub created: bool,
	/// Exact result of `git stash push`.
	pub output:  OperationOutput,
}

/// Safe top-stash restoration result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum StashPopOutcome {
	/// Preflight and pop both succeeded; Git dropped the stash entry.
	Applied(OperationOutput),
	/// Three-way preflight proved the stash would conflict, so no pop ran.
	PreflightConflict(OperationOutput),
	/// Pop failed, but stash-scoped tracked restore and untracked cleanup
	/// succeeded.
	RolledBack(OperationOutput),
	/// Pop failed and at least one bounded rollback operation also failed.
	Partial {
		/// Original failed pop result.
		pop:     OperationOutput,
		/// Exact tracked-path restore result when it failed.
		restore: Option<OperationOutput>,
		/// Literal-path cleanup result when it failed.
		clean:   Option<OperationOutput>,
	},
}

/// Tree-wide reset policy.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ResetMode {
	/// Preserve index and worktree.
	Soft,
	/// Reset the index and preserve the worktree.
	#[default]
	Mixed,
	/// Reset both index and worktree.
	Hard,
}

/// Untracked-path cleanup policy.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum CleanMode {
	/// Remove untracked paths but preserve ignored paths.
	#[default]
	Untracked,
	/// Remove untracked and ignored paths.
	IncludeIgnored,
	/// Remove only ignored paths.
	IgnoredOnly,
}

/// Result of serializing the current index as a Git tree object.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WriteTreeOutcome {
	/// Newly written tree object identifier.
	Written(Str),
	/// The index contains unmerged entries.
	Conflict(OperationOutput),
	/// Git rejected the operation for another reason.
	Rejected(OperationOutput),
}
/// Result of cloning a repository, including whether the shallow transport
/// needed the compatibility fallback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CloneOutcome {
	/// The clone completed. `omp-vcs` internally owns shallow-to-full fallback.
	Applied,
}

/// Exact identity and timestamp flags for one low-level commit creation.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CommitOptions<'a> {
	/// Git-compatible `Name <email>` author identity.
	pub author:      Option<&'a str>,
	/// Git-compatible author and committer date.
	pub date:        Option<&'a str>,
	/// Permit creation when the index tree equals `HEAD`.
	pub allow_empty: bool,
	/// Replace `HEAD` while preserving Git's ordinary amend semantics.
	pub amend:       bool,
}

/// Lease protection accepted by one push.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct PushOptions<'a> {
	/// Optional `refname[:expected]` value for `--force-with-lease`.
	pub force_with_lease: Option<&'a str>,
}

/// Clones `remote` into `target` through the sanctioned network transport.
pub async fn clone_repository(
	cwd: &Path,
	remote: &str,
	target: &str,
	cancel: &CancellationToken,
) -> Result<CloneOutcome, MutationError> {
	let target = if Path::new(target).is_absolute() {
		Path::new(target).to_owned()
	} else {
		cwd.join(target)
	};
	omp_vcs::git::clone(remote, &target, &omp_vcs::CloneOptions::default(), Some(cancel.clone()))
		.await?;
	Ok(CloneOutcome::Applied)
}

#[derive(Clone)]
/// Lock-serialized repository mutation facade for an authorized consumer.
pub struct GitMutation {
	repository: Repository,
	consumer:   GitMutationConsumer,
}
impl GitMutation {
	/// Creates a mutation facade bound to one repository and consumer identity.
	pub const fn new(repository: Repository, consumer: GitMutationConsumer) -> Self {
		Self { repository, consumer }
	}

	fn repo(&self) -> Arc<omp_vcs::git::GitRepo> {
		self.repository.handle.clone()
	}

	async fn locked<T: Send + 'static>(
		&self,
		cancel: &CancellationToken,
		op: impl FnOnce(Arc<omp_vcs::git::GitRepo>) -> Result<T, omp_vcs::Error> + Send + 'static,
	) -> Result<T, MutationError> {
		let _guard = lock::write(&self.repository, cancel).await?;
		let repo = self.repo();
		Ok(blocking(Some(cancel), move || op(repo)).await?)
	}

	/// Creates and checks out a branch in the autoresearch isolation namespace.
	pub async fn create_isolation_branch(
		&self,
		branch: &str,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		if self.consumer != GitMutationConsumer::Autoresearch || !valid_autoresearch_branch(branch) {
			return Err(MutationError::IsolationBranch);
		}
		let branch = branch.to_owned();
		self
			.locked(cancel, move |r| r.checkout_new_branch(&branch))
			.await?;
		Ok(applied())
	}

	/// Stages selected paths and records an authorized isolation commit.
	pub async fn commit_isolation(
		&self,
		record: IsolationCommit<'_>,
		paths: &[&str],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		if self.consumer != GitMutationConsumer::Autoresearch {
			return Err(MutationError::IsolationConsumer);
		}
		if paths.is_empty() {
			return Ok(applied());
		}
		let files = paths.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
		let message = isolation_commit_message(record);
		self
			.locked(cancel, move |r| {
				r.stage_files(&files)?;
				r.commit_create(&message, &omp_vcs::CommitOptions { files, ..Default::default() })
					.map(drop)
			})
			.await?;
		Ok(applied())
	}

	/// Restores tracked paths and removes untracked paths from an isolation run.
	pub async fn rollback_isolation(
		&self,
		target: &str,
		tracked: &[&str],
		untracked: &[&str],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		if self.consumer != GitMutationConsumer::Autoresearch {
			return Err(MutationError::IsolationConsumer);
		}
		let target = target.to_owned();
		let tracked = tracked.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
		let untracked = untracked
			.iter()
			.map(|p| (*p).to_owned())
			.collect::<Vec<_>>();
		self
			.locked(cancel, move |r| {
				if !tracked.is_empty() {
					r.restore(&omp_vcs::RestoreOptions {
						source:   Some(target),
						staged:   true,
						worktree: true,
						files:    tracked,
					})?;
				}
				if !untracked.is_empty() {
					r.clean(&omp_vcs::CleanOptions { paths: untracked, ..Default::default() })?;
				}
				Ok(())
			})
			.await?;
		Ok(applied())
	}

	/// Stages the requested repository-relative paths.
	pub async fn stage_files(
		&self,
		paths: &[&str],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let paths = paths.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
		if paths.is_empty() {
			return Ok(applied());
		}
		self.locked(cancel, move |r| r.stage_files(&paths)).await?;
		Ok(applied())
	}

	/// Stages every tracked and untracked path in the repository.
	pub async fn stage_all(
		&self,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self
			.locked(cancel, move |r| {
				let mut paths = r.ls_files(false, false)?;
				paths.extend(r.ls_files(true, true)?);
				r.stage_files(&paths)
			})
			.await?;
		Ok(applied())
	}

	/// Resets the complete index to `HEAD` while preserving the worktree.
	pub async fn unstage_all(
		&self,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self
			.locked(cancel, move |r| r.reset(omp_vcs::ResetMode::Mixed, None))
			.await?;
		Ok(applied())
	}

	/// Resets selected index entries to `HEAD`.
	pub async fn reset_index_entries(
		&self,
		paths: &[&str],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let paths = paths.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
		self.locked(cancel, move |r| r.unstage(&paths)).await?;
		Ok(applied())
	}

	/// Stages validated whole-file or hunk selections from the worktree diff.
	pub async fn stage_hunks(
		&self,
		selections: &[HunkSelection],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let selections = selections
			.iter()
			.map(|s| omp_vcs::HunkSelection {
				path:  s.path.as_str().to_owned(),
				hunks: match &s.selector {
					HunkSelector::All => omp_vcs::HunkSpec::All,
					HunkSelector::Indices(v) => {
						omp_vcs::HunkSpec::Indices(v.iter().map(|n| *n as u32).collect())
					},
					HunkSelector::Lines { start, end } => {
						omp_vcs::HunkSpec::Lines { start: *start as u32, end: *end as u32 }
					},
				},
			})
			.collect::<Vec<_>>();
		self
			.locked(cancel, move |r| r.stage_hunks(&selections, None))
			.await?;
		Ok(applied())
	}

	/// Removes validated whole-file or hunk selections from the index.
	pub async fn unstage_hunks(
		&self,
		selections: &[HunkSelection],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self.apply_selected_hunks(selections, true, cancel).await
	}

	/// Discards validated whole-file or hunk selections from the worktree.
	pub async fn discard_hunks(
		&self,
		selections: &[HunkSelection],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self.apply_selected_hunks(selections, false, cancel).await
	}

	async fn apply_selected_hunks(
		&self,
		selections: &[HunkSelection],
		cached: bool,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		if selections.is_empty() {
			return Ok(applied());
		}
		let repo = self.repo();
		let options = omp_vcs::DiffOptions { cached, binary: true, ..Default::default() };
		let raw = Bytes::from(blocking(Some(cancel), move || repo.diff_text(&options)).await?);
		let patch = build_selected_patch(&raw, selections)?;
		self
			.apply_patch(&patch, PatchOptions { cached, reverse: true, ..Default::default() }, cancel)
			.await
	}

	async fn selected_lines(
		&self,
		path: &str,
		selection: DiffLineSelection,
		cached: bool,
		reverse: bool,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let repo = self.repo();
		let path_owned = path.to_owned();
		let options = omp_vcs::DiffOptions { cached, binary: true, ..Default::default() };
		let raw = blocking(Some(cancel), move || repo.diff_text(&options)).await?;
		let files = diff::parse_unified(Bytes::from(raw));
		let file = files
			.into_iter()
			.find(|f| file_matches_path(f, path_owned.as_bytes()))
			.ok_or_else(|| SelectionError::PathMissing { path: path_owned.as_str().into() })?;
		let line_endings = self
			.line_endings(&file, cached, &path_owned, cancel)
			.await?;
		let patch = build_line_patch_with_endings(
			&file,
			&path_owned,
			selection,
			if reverse {
				LinePatchDirection::Reverse
			} else {
				LinePatchDirection::Apply
			},
			&line_endings,
		)?;
		self
			.apply_patch(
				&patch,
				PatchOptions { cached: cached || !reverse, reverse, ..Default::default() },
				cancel,
			)
			.await
	}

	/// Reads the pre- and post-image contents backing `file` so synthesized
	/// line patches can preserve per-line CRLF terminators.
	async fn line_endings(
		&self,
		file: &FileDiff,
		cached: bool,
		path: &str,
		cancel: &CancellationToken,
	) -> Result<LineEndings, MutationError> {
		let old_path = file
			.old_path
			.as_deref()
			.and_then(|path| str::from_utf8(path).ok())
			.unwrap_or(path)
			.to_owned();
		let new_path = file
			.path
			.as_deref()
			.and_then(|path| str::from_utf8(path).ok())
			.unwrap_or(path)
			.to_owned();
		let repo = self.repo();
		let old_spec = if cached {
			format!("HEAD:{old_path}")
		} else {
			format!(":0:{old_path}")
		};
		let old = blocking(Some(cancel), {
			let repo = repo.clone();
			move || Ok(blob_or_empty(&repo, &old_spec))
		})
		.await?;
		let new = if cached {
			blocking(Some(cancel), move || Ok(blob_or_empty(&repo, &format!(":0:{new_path}")))).await?
		} else {
			match tokio::fs::read(self.repository.worktree_root.join(&new_path)).await {
				Ok(bytes) => bytes,
				Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
				Err(error) => return Err(MutationError::WorktreeRead(error)),
			}
		};
		Ok(LineEndings::from_contents(&old, &new))
	}

	/// Stages changed lines selected by old-side and new-side coordinates.
	pub async fn stage_lines(
		&self,
		path: &str,
		range: DiffLineSelection,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self.selected_lines(path, range, false, false, cancel).await
	}

	/// Removes selected changed lines from the index.
	pub async fn unstage_lines(
		&self,
		path: &str,
		range: DiffLineSelection,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self.selected_lines(path, range, true, true, cancel).await
	}

	/// Discards selected changed lines from the worktree.
	pub async fn discard_lines(
		&self,
		path: &str,
		range: DiffLineSelection,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self.selected_lines(path, range, false, true, cancel).await
	}

	/// Applies a binary-safe patch with explicit index and merge options.
	pub async fn apply_patch(
		&self,
		patch: &[u8],
		options: PatchOptions,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let patch = str::from_utf8(patch)
			.map_err(|_| MutationError::NonUtf8)?
			.to_owned();
		self
			.locked(cancel, move |r| {
				r.apply_patch(&patch, &omp_vcs::ApplyOptions {
					cached:     options.cached,
					reverse:    options.reverse,
					three_way:  options.three_way,
					index_path: None,
				})
			})
			.await?;
		Ok(applied())
	}

	/// Checks whether a patch can be applied without mutating the repository.
	pub async fn check_patch(
		&self,
		patch: &[u8],
		options: PatchOptions,
		cancel: &CancellationToken,
	) -> Result<PatchCheck, MutationError> {
		let patch = str::from_utf8(patch)
			.map_err(|_| MutationError::NonUtf8)?
			.to_owned();
		let applies = self
			.locked(cancel, move |r| {
				r.can_apply_patch(&patch, &omp_vcs::ApplyOptions {
					cached:     options.cached,
					reverse:    options.reverse,
					three_way:  options.three_way,
					index_path: None,
				})
			})
			.await?;
		Ok(PatchCheck { applies, output: OperationOutput })
	}

	/// Applies one commit and reports empty, conflicting, or rejected outcomes.
	pub async fn cherry_pick(
		&self,
		revision: &str,
		cancel: &CancellationToken,
	) -> Result<CherryPickOutcome, MutationError> {
		let revision = revision.to_owned();
		match self.locked(cancel, move |r| r.cherry_pick(&revision)).await {
			Ok(()) => Ok(CherryPickOutcome::Applied(OperationOutput)),
			Err(MutationError::Vcs(omp_vcs::Error::EmptyCherryPick { .. })) => {
				Ok(CherryPickOutcome::Empty(OperationOutput))
			},
			Err(MutationError::Vcs(omp_vcs::Error::Conflict { .. })) => {
				Ok(CherryPickOutcome::Conflict(OperationOutput))
			},
			Err(e) => Err(e),
		}
	}

	/// Creates a stash containing tracked and untracked worktree changes.
	pub async fn stash_push(
		&self,
		message: Option<&str>,
		cancel: &CancellationToken,
	) -> Result<StashPushOutcome, MutationError> {
		let message = message.map(str::to_owned);
		let created = self
			.locked(cancel, move |r| r.stash_push(message.as_deref()))
			.await?;
		Ok(StashPushOutcome { created, output: OperationOutput })
	}

	/// Restores and drops the top stash entry.
	pub async fn stash_pop(
		&self,
		restore_index: bool,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		self
			.locked(cancel, move |r| r.stash_try_pop(restore_index))
			.await?;
		Ok(applied())
	}

	/// Preflights stash restoration and rolls back bounded partial failures.
	pub async fn stash_try_pop(
		&self,
		restore_index: bool,
		cancel: &CancellationToken,
	) -> Result<StashPopOutcome, MutationError> {
		match self
			.locked(cancel, move |r| r.stash_try_pop(restore_index))
			.await
		{
			Ok(_) => Ok(StashPopOutcome::Applied(OperationOutput)),
			Err(MutationError::Vcs(omp_vcs::Error::Conflict { .. })) => {
				Ok(StashPopOutcome::PreflightConflict(OperationOutput))
			},
			Err(e) => Err(e),
		}
	}

	/// Restores selected paths from an optional source into the index or
	/// worktree.
	pub async fn restore(
		&self,
		paths: &[&str],
		source: Option<&str>,
		staged: bool,
		worktree: bool,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let o = omp_vcs::RestoreOptions {
			source: source.map(str::to_owned),
			staged,
			worktree,
			files: paths.iter().map(|p| (*p).to_owned()).collect(),
		};
		self.locked(cancel, move |r| r.restore(&o)).await?;
		Ok(applied())
	}

	/// Resets `HEAD`, the index, or the worktree according to the selected mode.
	pub async fn reset(
		&self,
		mode: ResetMode,
		target: Option<&str>,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let mode = match mode {
			ResetMode::Soft => omp_vcs::ResetMode::Soft,
			ResetMode::Mixed => omp_vcs::ResetMode::Mixed,
			ResetMode::Hard => omp_vcs::ResetMode::Hard,
		};
		let target = target.map(str::to_owned);
		self
			.locked(cancel, move |r| r.reset(mode, target.as_deref()))
			.await?;
		Ok(applied())
	}

	/// Removes untracked paths according to the selected cleanup policy.
	pub async fn clean(
		&self,
		mode: CleanMode,
		paths: &[&str],
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let o = omp_vcs::CleanOptions {
			ignored_only:    mode == CleanMode::IgnoredOnly,
			include_ignored: mode == CleanMode::IncludeIgnored,
			paths:           paths.iter().map(|p| (*p).to_owned()).collect(),
		};
		self.locked(cancel, move |r| r.clean(&o)).await?;
		Ok(applied())
	}

	/// Replaces the index with the tree selected by a revision.
	pub async fn read_tree(
		&self,
		treeish: &str,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let treeish = treeish.to_owned();
		self
			.locked(cancel, move |r| r.read_tree(&treeish, None))
			.await?;
		Ok(applied())
	}

	/// Serializes the current index as a tree object.
	pub async fn write_tree(
		&self,
		cancel: &CancellationToken,
	) -> Result<WriteTreeOutcome, MutationError> {
		let tree = self.locked(cancel, move |r| r.write_tree(None)).await?;
		Ok(WriteTreeOutcome::Written(Str::from(tree)))
	}

	/// Creates a commit from the current index with controlled identity options.
	pub async fn create_commit(
		&self,
		message: &[u8],
		options: CommitOptions<'_>,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		let message = str::from_utf8(message)
			.map_err(|_| MutationError::NonUtf8)?
			.to_owned();
		let author =
			options
				.author
				.and_then(parse_author)
				.map(|(name, email)| omp_vcs::CommitAuthor {
					name,
					email,
					date: options.date.map(str::to_owned),
				});
		let o = omp_vcs::CommitOptions {
			author,
			allow_empty: options.allow_empty,
			amend: options.amend,
			..Default::default()
		};
		self
			.locked(cancel, move |r| r.commit_create(&message, &o).map(drop))
			.await?;
		Ok(applied())
	}

	/// Pushes a refspec with optional force-with-lease protection.
	pub async fn push(
		&self,
		remote: &str,
		refspecs: &[&str],
		options: PushOptions<'_>,
		cancel: &CancellationToken,
	) -> Result<MutationOutcome, MutationError> {
		for refspec in refspecs {
			self
				.repository
				.handle
				.push(
					&omp_vcs::PushOptions {
						remote:           Some(remote.to_owned()),
						refspec:          Some((*refspec).to_owned()),
						force_with_lease: options.force_with_lease.map(str::to_owned),
					},
					Some(cancel.clone()),
				)
				.await?;
		}
		Ok(applied())
	}
}
fn applied() -> MutationOutcome {
	MutationOutcome::Applied(OperationOutput)
}
fn parse_author(value: &str) -> Option<(String, String)> {
	let (name, email) = value.rsplit_once(" <")?;
	Some((name.to_owned(), email.strip_suffix('>')?.to_owned()))
}
fn valid_autoresearch_branch(branch: &str) -> bool {
	branch.strip_prefix("autoresearch/").is_some_and(|s| {
		!s.is_empty() && !s.starts_with('/') && !s.ends_with('/') && !s.contains("..")
	})
}
fn isolation_commit_message(record: IsolationCommit<'_>) -> String {
	match record {
		IsolationCommit::AutoresearchBaseline => "autoresearch: preserve baseline".to_owned(),
		IsolationCommit::AutoresearchHarness { name, goal } => format!(
			"autoresearch: validate {name}{}",
			goal.map_or(String::new(), |g| format!("\n\nGoal: {g}"))
		),
		IsolationCommit::AutoresearchRun { description, metrics_json } => {
			format!("autoresearch: {description}\n\n{metrics_json}")
		},
	}
}

fn build_selected_patch(
	raw: &Bytes,
	selections: &[HunkSelection],
) -> Result<Bytes, SelectionError> {
	let files = diff::parse_unified(raw.clone());
	let mut seen = HashSet::with_capacity(selections.len());
	let mut patch = BytesMut::with_capacity(raw.len());
	for selection in selections {
		if !seen.insert(selection.path.clone()) {
			return Err(SelectionError::DuplicatePath { path: selection.path.clone() });
		}
		let file = files
			.iter()
			.find(|file| file_matches_path(file, selection.path.as_bytes()))
			.ok_or_else(|| SelectionError::PathMissing { path: selection.path.clone() })?;
		match &selection.selector {
			HunkSelector::All => append_patch_part(&mut patch, &file.raw),
			HunkSelector::Indices(indices) => {
				if file.binary {
					return Err(SelectionError::BinarySubset { path: selection.path.clone() });
				}
				if let Some(index) = indices
					.iter()
					.copied()
					.find(|index| *index == 0 || *index > file.hunks.len())
				{
					return Err(SelectionError::InvalidHunkIndex {
						path: selection.path.clone(),
						index,
						hunk_count: file.hunks.len(),
					});
				}
				let wanted: HashSet<usize> = indices.iter().copied().collect();
				let hunks: Vec<_> = file
					.hunks
					.iter()
					.enumerate()
					.filter(|(index, _)| wanted.contains(&(index + 1)))
					.map(|(_, hunk)| hunk)
					.collect();
				append_selected_hunks(&mut patch, file, &hunks, &selection.path)?;
			},
			HunkSelector::Lines { start, end } => {
				if file.binary {
					return Err(SelectionError::BinarySubset { path: selection.path.clone() });
				}
				if *start == 0 || start > end {
					return Err(SelectionError::InvalidLineRange { path: selection.path.clone() });
				}
				let selected = build_line_patch(
					file,
					selection.path.as_str(),
					DiffLineSelection::new_lines(*start, *end),
					LinePatchDirection::Apply,
				)?;
				append_patch_part(&mut patch, &selected);
			},
		}
	}
	Ok(patch.freeze())
}

/// Synthesizes one standalone apply-intent patch containing only selected
/// changed lines from `file`.
///
/// For [`LinePatchDirection::Apply`], unselected additions are omitted and
/// unselected deletions become context. Reverse patches use the inverse
/// transformation so their source is the complete new side. Hunk coordinates
/// and no-final-newline markers are rewritten without decoding file content.
pub fn build_line_patch(
	file: &FileDiff,
	path: &str,
	selection: DiffLineSelection,
	direction: LinePatchDirection,
) -> Result<Bytes, SelectionError> {
	build_line_patch_with_endings(file, path, selection, direction, &LineEndings::default())
}

/// Reads the blob `spec` names, treating every failure (unborn HEAD, path not
/// yet tracked) as empty contents — mirroring `git show`'s use as an
/// optional-content probe.
fn blob_or_empty(repo: &omp_vcs::git::GitRepo, spec: &str) -> Vec<u8> {
	repo
		.show_blob(spec, None)
		.map(|shown| shown.bytes)
		.unwrap_or_default()
}

fn build_line_patch_with_endings(
	file: &FileDiff,
	path: &str,
	selection: DiffLineSelection,
	direction: LinePatchDirection,
	line_endings: &LineEndings,
) -> Result<Bytes, SelectionError> {
	let path = path.to_str();
	if file.binary {
		return Err(SelectionError::BinarySubset { path });
	}
	if selection.old.is_none() && selection.new.is_none()
		|| selection.old.is_some_and(|range| !range.is_valid())
		|| selection.new.is_some_and(|range| !range.is_valid())
	{
		return Err(SelectionError::InvalidLineRange { path });
	}
	if file.hunks.is_empty() {
		return Err(SelectionError::NoMatchingLines { path });
	}

	let header_end = find_bytes(&file.raw, &file.hunks[0].raw).unwrap_or(file.raw.len());
	let mut transformed_hunks = Vec::with_capacity(file.hunks.len());
	let mut delta = 0_i64;
	let mut selected_changes = 0_usize;
	for hunk in &file.hunks {
		let Some(transformed) = transform_hunk(hunk, selection, delta, direction, line_endings)
		else {
			continue;
		};
		selected_changes += transformed.selected_changes;
		delta += transformed.delta;
		transformed_hunks.push(transformed);
	}
	if transformed_hunks.is_empty() {
		return Err(SelectionError::NoMatchingLines { path });
	}
	let total_changes = file
		.hunks
		.iter()
		.flat_map(|hunk| hunk.raw.split_inclusive(|byte| *byte == b'\n').skip(1))
		.filter(|line| matches!(line.first(), Some(b'+' | b'-')))
		.count();
	let mut patch = BytesMut::with_capacity(file.raw.len());
	append_line_patch_header(
		&mut patch,
		file,
		header_end,
		direction,
		selected_changes == total_changes,
	);
	for transformed in transformed_hunks {
		patch.extend_from_slice(&transformed.raw);
	}
	if !patch.ends_with(b"\n") {
		patch.extend_from_slice(b"\n");
	}
	Ok(patch.freeze())
}
fn append_line_patch_header(
	patch: &mut BytesMut,
	file: &FileDiff,
	header_end: usize,
	direction: LinePatchDirection,
	complete: bool,
) {
	let normalize = match (&file.old_path, &file.path) {
		(Some(old_path), Some(path)) => old_path != path,
		(Some(_), None) => direction == LinePatchDirection::Apply && !complete,
		(None, Some(_)) => direction == LinePatchDirection::Reverse && !complete,
		(None, None) => false,
	};
	if normalize && let Some(path) = file.path.as_ref().or(file.old_path.as_ref()) {
		patch.extend_from_slice(b"diff --git a/");
		patch.extend_from_slice(path);
		patch.extend_from_slice(b" b/");
		patch.extend_from_slice(path);
		patch.extend_from_slice(b"\n--- a/");
		patch.extend_from_slice(path);
		patch.extend_from_slice(b"\n+++ b/");
		patch.extend_from_slice(path);
		patch.extend_from_slice(b"\n");
		return;
	}
	patch.extend_from_slice(&file.raw[..header_end]);
}

#[derive(Default)]
struct LineEndings {
	old_crlf: Vec<bool>,
	new_crlf: Vec<bool>,
}

impl LineEndings {
	fn from_contents(old: &[u8], new: &[u8]) -> Self {
		Self { old_crlf: crlf_lines(old), new_crlf: crlf_lines(new) }
	}

	fn old_is_crlf(&self, line: u64) -> bool {
		line
			.checked_sub(1)
			.and_then(|index| usize::try_from(index).ok())
			.and_then(|index| self.old_crlf.get(index))
			.copied()
			.unwrap_or(false)
	}

	fn new_is_crlf(&self, line: u64) -> bool {
		line
			.checked_sub(1)
			.and_then(|index| usize::try_from(index).ok())
			.and_then(|index| self.new_crlf.get(index))
			.copied()
			.unwrap_or(false)
	}
}

fn crlf_lines(contents: &[u8]) -> Vec<bool> {
	contents
		.split_inclusive(|byte| *byte == b'\n')
		.map(|line| line.ends_with(b"\r\n"))
		.collect()
}

struct TransformedHunk {
	raw:              Bytes,
	delta:            i64,
	selected_changes: usize,
}

fn transform_hunk(
	hunk: &DiffHunk,
	selection: DiffLineSelection,
	delta_before: i64,
	direction: LinePatchDirection,
	line_endings: &LineEndings,
) -> Option<TransformedHunk> {
	let header_end = hunk
		.raw
		.iter()
		.position(|byte| *byte == b'\n')
		.map_or(hunk.raw.len(), |position| position + 1);
	let header = &hunk.raw[..header_end];
	let closing = find_bytes(header.get(2..).unwrap_or_default(), b"@@").map(|offset| offset + 2)?;
	let suffix = &header[closing + 2..];
	let mut body = BytesMut::with_capacity(hunk.raw.len().saturating_sub(header_end));
	let mut old_line = hunk.old_start;
	let mut new_line = hunk.new_start;
	let mut old_count = 0_u64;
	let mut new_count = 0_u64;
	let mut selected_additions = 0_i64;
	let mut selected_deletions = 0_i64;
	let mut matched = false;
	let mut deletions = Vec::new();
	let mut additions = Vec::new();
	let mut lines = hunk.raw[header_end..]
		.split_inclusive(|byte| *byte == b'\n')
		.peekable();

	while let Some(line) = lines.next() {
		let marker = if lines
			.peek()
			.is_some_and(|next| next.first() == Some(&b'\\'))
		{
			lines.next()
		} else {
			None
		};
		match line.first().copied() {
			Some(b' ') => {
				append_transformed_change_block(
					&mut body,
					&mut deletions,
					&mut additions,
					direction,
					&mut old_count,
					&mut new_count,
					&mut selected_deletions,
					&mut selected_additions,
				);
				append_context_hunk_line(
					&mut body,
					line,
					marker,
					line_endings.old_is_crlf(old_line),
					line_endings.new_is_crlf(new_line),
				);
				old_count += 1;
				new_count += 1;
				old_line += 1;
				new_line += 1;
			},
			Some(b'-') => {
				let selected = selection.old.is_some_and(|range| range.contains(old_line));
				matched |= selected;
				deletions.push(PendingHunkLine {
					raw: line,
					marker,
					selected,
					crlf: line_endings.old_is_crlf(old_line),
				});
				old_line += 1;
			},
			Some(b'+') => {
				let selected = selection.new.is_some_and(|range| range.contains(new_line));
				matched |= selected;
				additions.push(PendingHunkLine {
					raw: line,
					marker,
					selected,
					crlf: line_endings.new_is_crlf(new_line),
				});
				new_line += 1;
			},
			_ => {
				append_transformed_change_block(
					&mut body,
					&mut deletions,
					&mut additions,
					direction,
					&mut old_count,
					&mut new_count,
					&mut selected_deletions,
					&mut selected_additions,
				);
				append_hunk_line(&mut body, line, marker, false);
			},
		}
	}
	append_transformed_change_block(
		&mut body,
		&mut deletions,
		&mut additions,
		direction,
		&mut old_count,
		&mut new_count,
		&mut selected_deletions,
		&mut selected_additions,
	);
	if !matched {
		return None;
	}

	let (old_start, new_start) = match direction {
		LinePatchDirection::Apply => {
			(hunk.old_start, transformed_new_start(hunk.old_start, old_count, new_count, delta_before))
		},
		LinePatchDirection::Reverse => {
			(transformed_old_start(hunk.new_start, old_count, new_count, delta_before), hunk.new_start)
		},
	};
	let mut raw = BytesMut::with_capacity(header.len() + body.len() + 48);
	let header = format!("@@ -{},{} +{},{} @@", old_start, old_count, new_start, new_count);
	raw.extend_from_slice(header.as_bytes());
	raw.extend_from_slice(suffix);
	raw.extend_from_slice(&body);
	Some(TransformedHunk {
		raw:              raw.freeze(),
		delta:            selected_additions - selected_deletions,
		selected_changes: (selected_additions + selected_deletions) as usize,
	})
}

struct PendingHunkLine<'a> {
	raw:      &'a [u8],
	marker:   Option<&'a [u8]>,
	selected: bool,
	crlf:     bool,
}

fn append_transformed_change_block(
	body: &mut BytesMut,
	deletions: &mut Vec<PendingHunkLine<'_>>,
	additions: &mut Vec<PendingHunkLine<'_>>,
	direction: LinePatchDirection,
	old_count: &mut u64,
	new_count: &mut u64,
	selected_deletions: &mut i64,
	selected_additions: &mut i64,
) {
	let rows = deletions.len().max(additions.len());
	for index in 0..rows {
		if let Some(line) = deletions.get(index) {
			match (direction, line.selected) {
				(_, true) => {
					append_hunk_line(body, line.raw, line.marker, line.crlf);
					*old_count += 1;
					*selected_deletions += 1;
				},
				(LinePatchDirection::Apply, false) => {
					append_context_hunk_line(body, line.raw, line.marker, line.crlf, line.crlf);
					*old_count += 1;
					*new_count += 1;
				},
				(LinePatchDirection::Reverse, false) => {},
			}
		}
		if let Some(line) = additions.get(index) {
			match (direction, line.selected) {
				(_, true) => {
					append_hunk_line(body, line.raw, line.marker, line.crlf);
					*new_count += 1;
					*selected_additions += 1;
				},
				(LinePatchDirection::Reverse, false) => {
					append_context_hunk_line(body, line.raw, line.marker, line.crlf, line.crlf);
					*old_count += 1;
					*new_count += 1;
				},
				(LinePatchDirection::Apply, false) => {},
			}
		}
	}
	deletions.clear();
	additions.clear();
}

fn append_hunk_line(body: &mut BytesMut, line: &[u8], marker: Option<&[u8]>, crlf: bool) {
	if crlf {
		let content = line
			.strip_suffix(b"\r\n")
			.or_else(|| line.strip_suffix(b"\n"))
			.unwrap_or(line);
		body.extend_from_slice(content);
		body.extend_from_slice(b"\r\n");
	} else {
		body.extend_from_slice(line);
	}
	if let Some(marker) = marker {
		body.extend_from_slice(marker);
	}
}

fn append_context_hunk_line(
	body: &mut BytesMut,
	line: &[u8],
	marker: Option<&[u8]>,
	old_crlf: bool,
	new_crlf: bool,
) {
	if old_crlf || new_crlf {
		let content = line
			.strip_suffix(b"\r\n")
			.or_else(|| line.strip_suffix(b"\n"))
			.unwrap_or(line);
		body.extend_from_slice(b"-");
		body.extend_from_slice(&content[1..]);
		body.extend_from_slice(if old_crlf { b"\r\n" } else { b"\n" });
		body.extend_from_slice(b"+");
		body.extend_from_slice(&content[1..]);
		body.extend_from_slice(if new_crlf { b"\r\n" } else { b"\n" });
	} else {
		body.extend_from_slice(b" ");
		body.extend_from_slice(&line[1..]);
	}
	if let Some(marker) = marker {
		body.extend_from_slice(marker);
	}
}

fn transformed_new_start(old_start: u64, old_count: u64, new_count: u64, delta_before: i64) -> u64 {
	let base = if old_count == 0 {
		old_start.saturating_add(1)
	} else if new_count == 0 {
		old_start.saturating_sub(1)
	} else {
		old_start
	};
	if delta_before.is_negative() {
		base.saturating_sub(delta_before.unsigned_abs())
	} else {
		base.saturating_add(delta_before as u64)
	}
}
fn transformed_old_start(new_start: u64, old_count: u64, new_count: u64, delta_before: i64) -> u64 {
	let base = if old_count == 0 {
		new_start.saturating_sub(1)
	} else if new_count == 0 {
		new_start.saturating_add(1)
	} else {
		new_start
	};
	if delta_before.is_negative() {
		base.saturating_add(delta_before.unsigned_abs())
	} else {
		base.saturating_sub(delta_before as u64)
	}
}

fn file_matches_path(file: &FileDiff, path: &[u8]) -> bool {
	file.path.as_deref() == Some(path) || file.old_path.as_deref() == Some(path)
}

fn append_selected_hunks(
	patch: &mut BytesMut,
	file: &FileDiff,
	hunks: &[&DiffHunk],
	path: &Str,
) -> Result<(), SelectionError> {
	if hunks.is_empty() {
		return Err(SelectionError::NoMatchingHunks { path: path.clone() });
	}
	let header_end = find_bytes(&file.raw, &file.hunks[0].raw).unwrap_or(file.raw.len());
	patch.extend_from_slice(&file.raw[..header_end]);
	for hunk in hunks {
		patch.extend_from_slice(&hunk.raw);
	}
	if !patch.ends_with(b"\n") {
		patch.extend_from_slice(b"\n");
	}
	Ok(())
}

fn append_patch_part(patch: &mut BytesMut, part: &[u8]) {
	patch.extend_from_slice(part);
	if !part.ends_with(b"\n") {
		patch.extend_from_slice(b"\n");
	}
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
	if needle.is_empty() {
		return Some(0);
	}
	haystack
		.windows(needle.len())
		.position(|window| window == needle)
}
