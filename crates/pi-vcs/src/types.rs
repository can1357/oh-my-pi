//! Data types shared across the git and jj backends and their NAPI surface.
//!
//! These mirror the live surface of the TypeScript wrappers they replace
//! (`utils/git.ts`, `utils/jj.ts`): shapes consumed by the coding agent's
//! commit pipeline, status line, review flow, and worktree isolation machinery.

use std::{path::PathBuf, time::Duration};

/// Which VCS backs a working directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VcsKind {
	/// A git repository (possibly a linked worktree).
	Git,
	/// A Jujutsu workspace (possibly colocated with git).
	Jj,
}

/// Status counts shown by status displays.
///
/// Jujutsu has no index, so its `staged` is always zero.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StatusSummary {
	/// Files with staged (index) changes.
	pub staged:    u32,
	/// Files with unstaged worktree modifications.
	pub unstaged:  u32,
	/// Untracked files (gitignore-filtered).
	pub untracked: u32,
}

/// Resolved git repository metadata, discovered by walking the filesystem —
/// never a subprocess. Mirrors the TS `GitRepository` shape.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitRepoInfo {
	/// Checkout root: the directory containing the `.git` entry.
	pub repo_root:      PathBuf,
	/// The `.git` entry itself (directory, or pointer file for linked
	/// worktrees).
	pub git_entry_path: PathBuf,
	/// Resolved git directory (worktree-private for linked worktrees).
	pub git_dir:        PathBuf,
	/// Shared common directory (equals `git_dir` for primary checkouts).
	pub common_dir:     PathBuf,
	/// Path of the `HEAD` file inside `git_dir`.
	pub head_path:      PathBuf,
	/// Whether refs are stored in the reftable format (`extensions.refStorage`).
	/// Reftable repos route ref reads through the git CLI: neither gitoxide nor
	/// libgit2 can read reftable yet.
	pub is_reftable:    bool,
}

/// HEAD resolution: on a ref (born or unborn) or detached at a commit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HeadState {
	/// HEAD is a symbolic ref.
	Ref {
		/// Full ref name (`refs/heads/main`).
		ref_name: String,
		/// Short branch name when the ref lives under `refs/heads/`.
		branch:   Option<String>,
		/// Commit the ref points at; `None` for an unborn branch.
		commit:   Option<String>,
	},
	/// HEAD points directly at a commit.
	Detached {
		/// The commit SHA; `None` when HEAD is unreadable/empty.
		commit: Option<String>,
	},
}

impl HeadState {
	/// Commit SHA HEAD ultimately resolves to, when born.
	pub fn commit(&self) -> Option<&str> {
		match self {
			Self::Ref { commit, .. } | Self::Detached { commit } => commit.as_deref(),
		}
	}

	/// Short branch name when HEAD is on a local branch.
	pub fn branch(&self) -> Option<&str> {
		match self {
			Self::Ref { branch, .. } => branch.as_deref(),
			Self::Detached { .. } => None,
		}
	}
}

/// Linked-worktree metadata for a checkout that is not the primary one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkedWorktree {
	/// The worktree's own checkout root.
	pub root:         PathBuf,
	/// The shared primary checkout root that names the project.
	pub primary_root: PathBuf,
}

/// One row of `worktree list`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeEntry {
	/// Checkout root of the worktree.
	pub path:     PathBuf,
	/// HEAD commit, when known.
	pub head:     Option<String>,
	/// Checked-out branch ref, when not detached.
	pub branch:   Option<String>,
	/// Whether the worktree is on a detached HEAD.
	pub detached: bool,
}

/// Clone strategy for linked-worktree creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorktreeClone {
	/// Materialize the target tree from the object database.
	Off,
	/// Try every available copy-on-write tree-cloning backend.
	Auto,
	/// Try this backend first, then other available cloning backends.
	Prefer(pi_iso::BackendKind),
}

/// Options for linked-worktree creation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorktreeAddOptions {
	pub detach:       bool,
	pub clone:        WorktreeClone,
	/// Carry the source checkout's staged, unstaged, and untracked changes
	/// into the new worktree instead of starting from a clean tree. Requires
	/// the target ref to resolve to the source `HEAD` commit.
	pub keep_changes: bool,
}

/// Outcome of linked-worktree creation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorktreeAddResult {
	pub cloned_with: Option<pi_iso::BackendKind>,
	pub clone_error: Option<String>,
}

/// Commit authorship for commit creation and replay flows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitAuthor {
	/// Author name.
	pub name:  String,
	/// Author email.
	pub email: String,
	/// Author date (RFC 3339 / git date format), when overriding "now".
	pub date:  Option<String>,
}

/// Commit metadata for replay/rewrite flows (mirror of `git show -s`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitDetails {
	/// Full commit SHA.
	pub sha:     String,
	/// Parent SHAs; empty for a root commit.
	pub parents: Vec<String>,
	/// Author identity and date.
	pub author:  CommitAuthor,
	/// Full commit message (subject + body, no trailing newline).
	pub message: String,
}

/// Per-file added/removed line counts (`diff --numstat`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NumstatEntry {
	/// Worktree-relative path (new path for renames).
	pub path:    String,
	/// Added lines; `None` for binary files.
	pub added:   Option<u32>,
	/// Removed lines; `None` for binary files.
	pub removed: Option<u32>,
}

/// Options for diff generation.
///
/// The output contract is git patch format — the TS layer parses it with the
/// same parsers it applies to `git diff` output today (`parseFileDiffs`,
/// `parseFileHunks`), so header lines, `index`/mode lines, `GIT binary patch`
/// blocks, and rename headers must match the CLI dialect.
#[derive(Debug, Clone, Default)]
pub struct DiffOptions {
	/// Diff the index against HEAD instead of the worktree against the index.
	pub cached:  bool,
	/// Base revision; with `head` produces a two-rev diff.
	pub base:    Option<String>,
	/// Head revision (requires `base`).
	pub head:    Option<String>,
	/// Restrict to these worktree-relative paths.
	pub files:   Vec<String>,
	/// Unified context lines (default 3).
	pub context: Option<u32>,
	/// Include binary patch blocks (`GIT binary patch`) instead of the
	/// "Binary files differ" placeholder.
	pub binary:  bool,
}

/// Untracked-file reporting mode for status queries.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum UntrackedMode {
	/// Do not report untracked files.
	No,
	/// Report untracked directories as single entries (git default).
	#[default]
	Normal,
	/// Report every untracked file individually.
	All,
}

/// Options for porcelain status queries.
#[derive(Debug, Clone, Default)]
pub struct StatusOptions {
	/// Untracked reporting mode.
	pub untracked:      UntrackedMode,
	/// Restrict to these pathspecs.
	pub pathspecs:      Vec<String>,
	/// Terminate entries with NUL and disable path quoting (`-z`).
	pub nul_terminated: bool,
}

/// Options for commit creation.
#[derive(Debug, Clone, Default)]
pub struct CommitOptions {
	/// Author override; committer stays the repo identity.
	pub author:      Option<CommitAuthor>,
	/// Permit an empty commit.
	pub allow_empty: bool,
	/// Amend HEAD instead of appending.
	pub amend:       bool,
	/// Commit only these paths (pathspec commit).
	pub files:       Vec<String>,
}

/// Which hunks of a file a selection covers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HunkSpec {
	/// The whole file diff.
	All,
	/// 1-based hunk indices within the file's diff.
	Indices(Vec<u32>),
	/// Hunks overlapping this 1-based new-file line range.
	Lines {
		/// First line (inclusive).
		start: u32,
		/// Last line (inclusive).
		end:   u32,
	},
}

/// Selection of hunks to stage for one file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkSelection {
	/// Worktree-relative path as it appears in the diff.
	pub path:  String,
	/// Which hunks to take.
	pub hunks: HunkSpec,
}

/// A rejected hunk selection: the selection names hunks the diff does not
/// have, or selects hunks of a binary file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HunkSelectionError {
	/// Path of the offending selection.
	pub path:    String,
	/// Human-readable reason.
	pub message: String,
}

/// Options for patch application (`git apply` semantics).
#[derive(Debug, Clone, Default)]
pub struct ApplyOptions {
	/// Apply to the index instead of the worktree.
	pub cached:     bool,
	/// Alternate index file for cached application (`GIT_INDEX_FILE`
	/// equivalent); ignored for worktree application.
	pub index_path: Option<PathBuf>,
	/// Apply in reverse.
	pub reverse:    bool,
	/// Fall back to 3-way merge using the patch's recorded blob bases.
	pub three_way:  bool,
}

/// Reset mode for tree-wide resets.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum ResetMode {
	/// Move HEAD only.
	Soft,
	/// Move HEAD and reset the index (git default).
	#[default]
	Mixed,
	/// Move HEAD, reset index and worktree. Destructive.
	Hard,
}

/// Options for `restore`.
#[derive(Debug, Clone, Default)]
pub struct RestoreOptions {
	/// Source revision (defaults to HEAD for staged, index for worktree).
	pub source:   Option<String>,
	/// Restore the index.
	pub staged:   bool,
	/// Restore the worktree.
	pub worktree: bool,
	/// Restrict to these paths.
	pub files:    Vec<String>,
}

/// Options for `clean` (untracked file removal). Always recursive (`-d`).
#[derive(Debug, Clone, Default)]
pub struct CleanOptions {
	/// Remove only ignored files (`-X`).
	pub ignored_only:    bool,
	/// Remove ignored files too (`-x`).
	pub include_ignored: bool,
	/// Restrict to these literal paths (no glob expansion).
	pub paths:           Vec<String>,
}

/// Options for the CLI-backed `push`.
#[derive(Debug, Clone, Default)]
pub struct PushOptions {
	/// Remote name; git's configured default when absent.
	pub remote:           Option<String>,
	/// Refspec to push; the current branch when absent.
	pub refspec:          Option<String>,
	/// Use `--force-with-lease`.
	pub force_with_lease: bool,
}

/// Options for the CLI-backed `clone`.
#[derive(Debug, Clone, Default)]
pub struct CloneOptions {
	/// Branch or tag to clone (`--branch`).
	pub ref_name: Option<String>,
	/// Pin to a specific commit; forces a full (non-shallow) clone.
	pub sha:      Option<String>,
	/// Network deadline override.
	pub timeout:  Option<Duration>,
}

/// Outcome of severing a copied working tree from shared git metadata.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DetachGitDirResult {
	/// The tree had no `.git`; nothing to detach.
	NoGit,
	/// `.git` already resolves to an independent object DB — left untouched.
	Independent,
	/// Detached into a standalone repo borrowing the source's objects.
	Detached,
}

/// Bounded object read (`git show` equivalent).
#[derive(Debug, Clone)]
pub struct ShowResult {
	/// Object bytes, capped at the requested maximum.
	pub bytes:     Vec<u8>,
	/// True when the object was larger than the cap and `bytes` is incomplete.
	pub truncated: bool,
}
