//! N-API bindings for in-process Git and Jujutsu operations.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use napi::{Env, Result, bindgen_prelude::*};
use napi_derive::napi;
use pi_vcs::types as core;
use tokio_util::sync::CancellationToken;

use crate::{
	iso::{IsoBackendKind, from_napi_kind, to_napi_kind},
	task,
};

/// Build the JS `VcsError` on the JS thread and hand it to napi as the
/// rejection/throw value. napi retains a reference to the constructed object,
/// so JS receives exactly this error: a real `Error` with `name: "VcsError"`,
/// a machine-readable `code` (the [`pi_vcs::Error::kind`] discriminant), and
/// the CLI result fields (`exitCode`/`stdout`/`stderr`; non-CLI failures
/// mirror the message into `stderr` and synthesize `exitCode: 1`).
fn rich_error(env: Env, err: pi_vcs::Error) -> napi::Error {
	let message = err.to_string();
	let kind = err.kind();
	let (exit_code, stdout, stderr) = match err {
		pi_vcs::Error::Cli { exit_code, stdout, stderr, .. } => (exit_code, stdout, stderr),
		_ => (1, String::new(), message.clone()),
	};
	let built: Result<napi::Error> = (|| {
		let mut object = env.create_error(napi::Error::from_reason(message.clone()))?;
		object.set_named_property("name", "VcsError")?;
		object.set_named_property("code", kind)?;
		object.set_named_property("exitCode", exit_code)?;
		object.set_named_property("stdout", stdout.as_str())?;
		object.set_named_property("stderr", stderr.as_str())?;
		Ok(napi::Error::from(object.to_unknown()))
	})();
	built.unwrap_or_else(|_| napi::Error::from_reason(message))
}

fn canceled_error(env: Env, _reason: task::AbortReason) -> napi::Error {
	rich_error(env, pi_vcs::Error::Canceled)
}
/// Run a tokio-backed VCS future, rejecting with the rich `VcsError` built on
/// the JS thread. A deferred promise is used because napi future rejections
/// can only carry a message string; the deferred resolver runs with `Env` and
/// can hand back a real error object.
fn vcs_future<'env, T: ToNapiValue + Send + 'static>(
	env: &'env Env,
	tag: &'static str,
	work: impl Future<Output = pi_vcs::Result<T>> + Send + 'static,
) -> Result<Object<'env>> {
	let (deferred, promise) = env.create_deferred()?;
	spawn(async move {
		let _guard = crate::prof::profile_region(tag);
		let outcome = work.await;
		deferred.resolve(move |env| outcome.map_err(|err| rich_error(env, err)));
	});
	Ok(promise)
}

/// Promise produced by VCS blocking tasks: [`task::MappedPromise`] carrying
/// [`pi_vcs::Error`] for the JS-thread rich-error conversion. Named
/// `Promise` so the napi macro emits a plain `Promise<T>` TS return type.
type Promise<T> = task::MappedPromise<T, pi_vcs::Error>;

fn path_string(path: impl AsRef<Path>) -> String {
	path.as_ref().to_string_lossy().into_owned()
}
fn cancellation_token(signal: Option<Unknown>) -> Option<CancellationToken> {
	signal.and_then(|value| {
		let token = CancellationToken::new();
		if task::signal_aborted(&value) {
			token.cancel();
			return Some(token);
		}
		let signal = AbortSignal::from_unknown(value).ok()?;
		let abort = token.clone();
		signal.on_abort(move || abort.cancel());
		Some(token)
	})
}

/// Discovered Git repository paths.
#[napi(object)]
pub struct VcsGitRepoInfo {
	pub repo_root:      String,
	pub git_entry_path: String,
	pub git_dir:        String,
	pub common_dir:     String,
	pub head_path:      String,
	pub is_reftable:    bool,
}
/// Git status counts.
#[napi(object)]
pub struct VcsStatusSummary {
	pub staged:    u32,
	pub unstaged:  u32,
	pub untracked: u32,
}
/// Resolved HEAD state.
#[napi(object)]
pub struct VcsHeadState {
	pub kind:     String,
	pub ref_name: Option<String>,
	pub branch:   Option<String>,
	pub commit:   Option<String>,
}
/// Linked worktree metadata.
#[napi(object)]
pub struct VcsLinkedWorktree {
	pub root:         String,
	pub primary_root: String,
}
/// One worktree listing row.
#[napi(object)]
pub struct VcsWorktreeEntry {
	pub path:        String,
	pub head:        Option<String>,
	pub branch:      Option<String>,
	pub detached:    bool,
	/// Owner of a setup that is not finished yet (`setupOwner` when it was
	/// added); unset once it is done.
	pub setup_owner: Option<String>,
	/// The worktree's git directory: `<common dir>/worktrees/<id>` for a linked
	/// worktree, which stays the same when `git worktree move` moves it; the
	/// common git dir for the main one.
	pub git_dir:     String,
}
/// Worktree creation options.
#[napi(object)]
pub struct VcsWorktreeAddOptions {
	pub detach:       bool,
	pub clone:        bool,
	pub backend:      Option<IsoBackendKind>,
	/// Carry the source checkout's uncommitted changes into the new worktree
	/// (target must be the source `HEAD`).
	pub keep_changes: Option<bool>,
	/// Mark the new worktree as still being set up by this owner, from before
	/// it is listed until `worktreeEndSetup`. Git commands ignore the mark.
	pub setup_owner:  Option<String>,
}
/// Worktree creation outcome.
#[napi(object)]
pub struct VcsWorktreeAddResult {
	pub cloned_with: Option<IsoBackendKind>,
	pub clone_error: Option<String>,
}
/// Commit author identity.
#[napi(object)]
pub struct VcsCommitAuthor {
	pub name:  String,
	pub email: String,
	pub date:  Option<String>,
}
/// Commit metadata.
#[napi(object)]
pub struct VcsCommitDetails {
	pub sha:     String,
	pub parents: Vec<String>,
	pub author:  VcsCommitAuthor,
	pub message: String,
}
/// Per-file line counts.
#[napi(object)]
pub struct VcsNumstatEntry {
	pub path:    String,
	pub added:   Option<u32>,
	pub removed: Option<u32>,
}
/// Bounded object contents.
#[napi(object)]
pub struct VcsShowResult {
	pub data:      Buffer,
	pub truncated: bool,
}
/// Diff generation options.
#[napi(object)]
#[derive(Default)]
pub struct VcsDiffOptions {
	pub cached:    Option<bool>,
	pub base:      Option<String>,
	pub head:      Option<String>,
	pub files:     Option<Vec<String>>,
	pub context:   Option<u32>,
	pub binary:    Option<bool>,
	/// Fail with an `OutputTooLarge` `VcsError` once the rendered patch exceeds
	/// this many bytes, instead of buffering an arbitrarily large string.
	/// Carried as a double so a budget past 2^32 reaches the renderer intact
	/// (a `u32` field would wrap it); values beyond `usize` saturate.
	pub max_bytes: Option<f64>,
}
/// Status query options.
#[napi(object)]
#[derive(Default)]
pub struct VcsStatusOptions {
	pub untracked:      Option<String>,
	pub pathspecs:      Option<Vec<String>>,
	pub nul_terminated: Option<bool>,
}
/// Commit creation options.
#[napi(object)]
#[derive(Default)]
pub struct VcsCommitOptions {
	pub author:      Option<VcsCommitAuthor>,
	pub allow_empty: Option<bool>,
	pub amend:       Option<bool>,
	pub files:       Option<Vec<String>>,
}
/// Patch application options.
#[napi(object)]
#[derive(Default)]
pub struct VcsApplyOptions {
	pub cached:     Option<bool>,
	pub index_path: Option<String>,
	pub reverse:    Option<bool>,
	pub three_way:  Option<bool>,
}
/// Restore options.
#[napi(object)]
#[derive(Default)]
pub struct VcsRestoreOptions {
	pub source:   Option<String>,
	pub staged:   Option<bool>,
	pub worktree: Option<bool>,
	pub files:    Option<Vec<String>>,
}
/// Clean options.
#[napi(object)]
#[derive(Default)]
pub struct VcsCleanOptions {
	pub ignored_only:    Option<bool>,
	pub include_ignored: Option<bool>,
	pub paths:           Option<Vec<String>>,
}
/// Push options.
#[napi(object)]
#[derive(Default)]
pub struct VcsPushOptions {
	pub remote:           Option<String>,
	pub refspec:          Option<String>,
	pub force_with_lease: Option<bool>,
}
/// Clone options.
#[napi(object)]
#[derive(Default)]
pub struct VcsCloneOptions {
	pub ref_name:   Option<String>,
	pub sha:        Option<String>,
	pub timeout_ms: Option<u32>,
}
/// Selected hunks or line range for a path.
#[napi(object)]
pub struct VcsHunkSelection {
	pub path:    String,
	pub kind:    String,
	pub indices: Option<Vec<u32>>,
	pub start:   Option<u32>,
	pub end:     Option<u32>,
}
/// Invalid hunk selection.
#[napi(object)]
pub struct VcsHunkSelectionError {
	pub path:    String,
	pub message: String,
}

impl From<core::GitRepoInfo> for VcsGitRepoInfo {
	fn from(v: core::GitRepoInfo) -> Self {
		Self {
			repo_root:      path_string(v.repo_root),
			git_entry_path: path_string(v.git_entry_path),
			git_dir:        path_string(v.git_dir),
			common_dir:     path_string(v.common_dir),
			head_path:      path_string(v.head_path),
			is_reftable:    v.is_reftable,
		}
	}
}
impl From<core::StatusSummary> for VcsStatusSummary {
	fn from(v: core::StatusSummary) -> Self {
		Self { staged: v.staged, unstaged: v.unstaged, untracked: v.untracked }
	}
}
impl From<core::HeadState> for VcsHeadState {
	fn from(v: core::HeadState) -> Self {
		match v {
			core::HeadState::Ref { ref_name, branch, commit } => {
				Self { kind: "ref".into(), ref_name: Some(ref_name), branch, commit }
			},
			core::HeadState::Detached { commit } => {
				Self { kind: "detached".into(), ref_name: None, branch: None, commit }
			},
		}
	}
}
impl From<core::LinkedWorktree> for VcsLinkedWorktree {
	fn from(v: core::LinkedWorktree) -> Self {
		Self { root: path_string(v.root), primary_root: path_string(v.primary_root) }
	}
}
impl From<core::WorktreeEntry> for VcsWorktreeEntry {
	fn from(v: core::WorktreeEntry) -> Self {
		Self {
			path:        path_string(v.path),
			head:        v.head,
			branch:      v.branch,
			detached:    v.detached,
			setup_owner: v.setup_owner,
			git_dir:     path_string(v.git_dir),
		}
	}
}
impl From<core::CommitAuthor> for VcsCommitAuthor {
	fn from(v: core::CommitAuthor) -> Self {
		Self { name: v.name, email: v.email, date: v.date }
	}
}
impl From<VcsCommitAuthor> for core::CommitAuthor {
	fn from(v: VcsCommitAuthor) -> Self {
		Self { name: v.name, email: v.email, date: v.date }
	}
}
impl From<core::CommitDetails> for VcsCommitDetails {
	fn from(v: core::CommitDetails) -> Self {
		Self { sha: v.sha, parents: v.parents, author: v.author.into(), message: v.message }
	}
}
impl From<core::NumstatEntry> for VcsNumstatEntry {
	fn from(v: core::NumstatEntry) -> Self {
		Self { path: v.path, added: v.added, removed: v.removed }
	}
}
impl From<core::ShowResult> for VcsShowResult {
	fn from(v: core::ShowResult) -> Self {
		Self { data: v.bytes.into(), truncated: v.truncated }
	}
}
impl From<VcsDiffOptions> for core::DiffOptions {
	fn from(v: VcsDiffOptions) -> Self {
		Self {
			cached:    v.cached.unwrap_or(false),
			base:      v.base,
			head:      v.head,
			files:     v.files.unwrap_or_default(),
			context:   v.context,
			binary:    v.binary.unwrap_or(false),
			max_bytes: v.max_bytes.map(|v| v as usize),
		}
	}
}
impl TryFrom<VcsStatusOptions> for core::StatusOptions {
	type Error = napi::Error;

	fn try_from(v: VcsStatusOptions) -> Result<Self> {
		let untracked = match v.untracked.as_deref().unwrap_or("normal") {
			"no" => core::UntrackedMode::No,
			"normal" => core::UntrackedMode::Normal,
			"all" => core::UntrackedMode::All,
			x => return Err(napi::Error::from_reason(format!("invalid untracked mode: {x}"))),
		};
		Ok(Self {
			untracked,
			pathspecs: v.pathspecs.unwrap_or_default(),
			nul_terminated: v.nul_terminated.unwrap_or(false),
		})
	}
}
impl From<VcsCommitOptions> for core::CommitOptions {
	fn from(v: VcsCommitOptions) -> Self {
		Self {
			author:      v.author.map(Into::into),
			allow_empty: v.allow_empty.unwrap_or(false),
			amend:       v.amend.unwrap_or(false),
			files:       v.files.unwrap_or_default(),
		}
	}
}
impl From<VcsApplyOptions> for core::ApplyOptions {
	fn from(v: VcsApplyOptions) -> Self {
		Self {
			cached:     v.cached.unwrap_or(false),
			index_path: v.index_path.map(PathBuf::from),
			reverse:    v.reverse.unwrap_or(false),
			three_way:  v.three_way.unwrap_or(false),
		}
	}
}
impl From<VcsRestoreOptions> for core::RestoreOptions {
	fn from(v: VcsRestoreOptions) -> Self {
		Self {
			source:   v.source,
			staged:   v.staged.unwrap_or(false),
			worktree: v.worktree.unwrap_or(false),
			files:    v.files.unwrap_or_default(),
		}
	}
}
impl From<VcsCleanOptions> for core::CleanOptions {
	fn from(v: VcsCleanOptions) -> Self {
		Self {
			ignored_only:    v.ignored_only.unwrap_or(false),
			include_ignored: v.include_ignored.unwrap_or(false),
			paths:           v.paths.unwrap_or_default(),
		}
	}
}
impl From<VcsPushOptions> for core::PushOptions {
	fn from(v: VcsPushOptions) -> Self {
		Self {
			remote:           v.remote,
			refspec:          v.refspec,
			force_with_lease: v.force_with_lease.unwrap_or(false),
		}
	}
}
impl From<VcsCloneOptions> for core::CloneOptions {
	fn from(v: VcsCloneOptions) -> Self {
		Self {
			ref_name: v.ref_name,
			sha:      v.sha,
			timeout:  v.timeout_ms.map(|v| Duration::from_millis(u64::from(v))),
		}
	}
}
impl TryFrom<VcsHunkSelection> for core::HunkSelection {
	type Error = napi::Error;

	fn try_from(v: VcsHunkSelection) -> Result<Self> {
		let hunks = match v.kind.as_str() {
			"all" => core::HunkSpec::All,
			"indices" => core::HunkSpec::Indices(v.indices.unwrap_or_default()),
			"lines" => core::HunkSpec::Lines {
				start: v
					.start
					.ok_or_else(|| napi::Error::from_reason("lines selection requires start"))?,
				end:   v
					.end
					.ok_or_else(|| napi::Error::from_reason("lines selection requires end"))?,
			},
			x => return Err(napi::Error::from_reason(format!("invalid hunk selection kind: {x}"))),
		};
		Ok(Self { path: v.path, hunks })
	}
}

/// Convert a panic escaping a VCS operation into a typed [`pi_vcs::Error`].
///
/// gitoxide `.expect(...)`s on fallible OS work in places — e.g. worker-thread
/// spawn inside its parallel status walk fails under memory pressure (Windows
/// `ERROR_COMMITMENT_LIMIT`, os error 1455) and the panic resumes on the
/// joining thread. The task-level guard in [`task`] keeps the process alive
/// either way, but its rejection bypasses [`rich_error`]; catching here
/// preserves the structured `VcsError` contract (name/code/stderr) for every
/// failure mode.
fn catch_panic<T>(tag: &'static str, f: impl FnOnce() -> pi_vcs::Result<T>) -> pi_vcs::Result<T> {
	// AssertUnwindSafe: the captured repo handles are read-mostly caches; an
	// abandoned operation cannot leave them logically corrupt.
	match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
		Ok(result) => result,
		Err(payload) => {
			// Extract the message BEFORE disposal: disposal is the one
			// remaining step that can panic again.
			let message = crate::crash_handler::panic_payload(&*payload);
			task::dispose_panic_payload(payload);
			Err(pi_vcs::Error::backend(tag, format!("native panic: {message}")))
		},
	}
}

fn blocking<T: Send + 'static + ToNapiValue + TypeName>(
	tag: &'static str,
	repo: Arc<pi_vcs::git::GitRepo>,
	signal: Option<Unknown>,
	f: impl FnOnce(&pi_vcs::git::GitRepo) -> pi_vcs::Result<T> + Send + 'static,
) -> Promise<T> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped(tag, ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic(tag, || f(&repo))
	})
}
fn repo_blocking<T: Send + 'static + ToNapiValue + TypeName>(
	tag: &'static str,
	repo: pi_vcs::Repo,
	signal: Option<Unknown>,
	f: impl FnOnce(&pi_vcs::Repo) -> pi_vcs::Result<T> + Send + 'static,
) -> Promise<T> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped(tag, ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic(tag, || f(&repo))
	})
}

/// Backend-agnostic repository handle for portable VCS reads.
#[napi]
pub struct VcsRepo {
	inner: pi_vcs::Repo,
}

/// Discover the repository owning a directory.
#[napi]
pub fn vcs_discover(env: Env, dir: String) -> Result<Option<VcsRepo>> {
	pi_vcs::detect(Path::new(&dir))
		.map(|repo| repo.map(|inner| VcsRepo { inner }))
		.map_err(|err| rich_error(env, err))
}

/// Discover the repository presenting a directory: equal-root jj+git ties
/// prefer Jujutsu. Git-safe automation must keep using [`vcs_discover`].
#[napi]
pub fn vcs_discover_for_display(env: Env, dir: String) -> Result<Option<VcsRepo>> {
	pi_vcs::detect_for_display(Path::new(&dir))
		.map(|repo| repo.map(|inner| VcsRepo { inner }))
		.map_err(|err| rich_error(env, err))
}

/// [`vcs_discover`] off the JS thread, so a stalled checkout can't block it.
#[napi]
pub fn vcs_discover_async(dir: String, signal: Option<Unknown>) -> Promise<Option<VcsRepo>> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped("vcs.discoverAsync", ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic("vcs.discoverAsync", || {
			pi_vcs::detect(Path::new(&dir)).map(|repo| repo.map(|inner| VcsRepo { inner }))
		})
	})
}

#[napi]
impl VcsRepo {
	/// Backend kind (`"git"` or `"jj"`).
	#[napi]
	pub fn kind(&self) -> String {
		match self.inner.kind() {
			core::VcsKind::Git => "git",
			core::VcsKind::Jj => "jj",
		}
		.to_owned()
	}

	/// Checkout or workspace root.
	#[napi]
	pub fn root(&self) -> String {
		path_string(self.inner.root())
	}

	/// Primary checkout or default workspace root.
	#[napi]
	pub fn primary_root(&self) -> String {
		path_string(self.inner.primary_root())
	}

	/// Worktree-relative prefix of a directory.
	#[napi]
	pub fn prefix_of(&self, dir: String) -> Option<String> {
		self.inner.prefix_of(Path::new(&dir))
	}

	/// Filesystem target to watch for repository-head changes.
	#[napi]
	pub fn watch_target(&self) -> String {
		path_string(self.inner.watch_target())
	}

	/// Whether this backend implements a portable feature.
	#[napi]
	pub fn supports(&self, env: Env, feature: String) -> Result<bool> {
		let parsed = pi_vcs::Feature::parse(&feature).ok_or_else(|| {
			rich_error(
				env,
				pi_vcs::Error::backend(
					"vcs supports",
					format!("unknown feature `{feature}`; valid: stagedDiff, revDiff"),
				),
			)
		})?;
		Ok(self.inner.supports(parsed))
	}

	/// Git-specific handle when this repository is backed by Git.
	#[napi]
	pub fn as_git(&self) -> Option<VcsGitRepo> {
		self
			.inner
			.as_git()
			.map(|inner| VcsGitRepo { inner: inner.clone() })
	}

	/// Jujutsu-specific handle when this repository is backed by Jujutsu.
	#[napi]
	pub fn as_jj(&self) -> Option<VcsJjWorkspace> {
		self
			.inner
			.as_jj()
			.map(|inner| VcsJjWorkspace { inner: inner.clone() })
	}

	/// Human label for the working copy.
	#[napi]
	pub fn label(&self, signal: Option<Unknown>) -> Promise<Option<String>> {
		repo_blocking("vcs.label", self.inner.clone(), signal, |repo| repo.label())
	}

	/// Working-copy commit id.
	#[napi]
	pub fn head_id(&self, signal: Option<Unknown>) -> Promise<Option<String>> {
		repo_blocking("vcs.headId", self.inner.clone(), signal, |repo| repo.head_id())
	}

	/// Status counts.
	#[napi]
	pub fn status_summary(&self, signal: Option<Unknown>) -> Promise<VcsStatusSummary> {
		repo_blocking("vcs.statusSummary", self.inner.clone(), signal, |repo| {
			repo.status_summary().map(Into::into)
		})
	}

	/// Porcelain status.
	#[napi]
	pub fn status_porcelain(
		&self,
		options: VcsStatusOptions,
		signal: Option<Unknown>,
	) -> Promise<String> {
		let options = core::StatusOptions::try_from(options);
		repo_blocking("vcs.statusPorcelain", self.inner.clone(), signal, move |repo| {
			repo.status_porcelain(&options.map_err(|error| pi_vcs::Error::Backend {
				context: "vcs status options",
				message: error.to_string(),
			})?)
		})
	}

	/// Render a patch.
	#[napi]
	pub fn diff_text(&self, options: VcsDiffOptions, signal: Option<Unknown>) -> Promise<String> {
		let options = options.into();
		repo_blocking("vcs.diffText", self.inner.clone(), signal, move |repo| {
			repo.diff_text(&options)
		})
	}

	/// Changed paths.
	#[napi]
	pub fn changed_files(
		&self,
		options: VcsDiffOptions,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		let options = options.into();
		repo_blocking("vcs.changedFiles", self.inner.clone(), signal, move |repo| {
			repo.changed_files(&options)
		})
	}

	/// Per-file line counts.
	#[napi]
	pub fn numstat(
		&self,
		options: VcsDiffOptions,
		signal: Option<Unknown>,
	) -> Promise<Vec<VcsNumstatEntry>> {
		let options = options.into();
		repo_blocking("vcs.numstat", self.inner.clone(), signal, move |repo| {
			repo
				.numstat(&options)
				.map(|entries| entries.into_iter().map(Into::into).collect())
		})
	}

	/// Every working-copy change since the last commit.
	#[napi]
	pub fn uncommitted_diff(&self, files: Vec<String>, signal: Option<Unknown>) -> Promise<String> {
		repo_blocking("vcs.uncommittedDiff", self.inner.clone(), signal, move |repo| {
			repo.uncommitted_diff(&files)
		})
	}

	/// Recent subjects.
	#[napi]
	pub fn log_subjects(&self, count: u32, signal: Option<Unknown>) -> Promise<Vec<String>> {
		repo_blocking("vcs.logSubjects", self.inner.clone(), signal, move |repo| {
			repo.log_subjects(count as usize)
		})
	}

	/// Recent one-line commits.
	#[napi]
	pub fn log_onelines(&self, count: u32, signal: Option<Unknown>) -> Promise<Vec<String>> {
		repo_blocking("vcs.logOnelines", self.inner.clone(), signal, move |repo| {
			repo.log_onelines(count as usize)
		})
	}

	/// Commit details.
	#[napi]
	pub fn commit_details(&self, rev: String, signal: Option<Unknown>) -> Promise<VcsCommitDetails> {
		repo_blocking("vcs.commitDetails", self.inner.clone(), signal, move |repo| {
			repo.commit_details(&rev).map(Into::into)
		})
	}

	/// List tracked or untracked paths.
	#[napi]
	pub fn ls_files(
		&self,
		others: bool,
		exclude_standard: bool,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		repo_blocking("vcs.lsFiles", self.inner.clone(), signal, move |repo| {
			repo.ls_files(others, exclude_standard)
		})
	}
}

/// In-process Git repository handle.
#[napi]
pub struct VcsGitRepo {
	inner: Arc<pi_vcs::git::GitRepo>,
}

/// Discover the Git checkout containing a directory.
#[napi]
pub fn vcs_git_discover(env: Env, dir: String) -> Result<Option<VcsGitRepo>> {
	pi_vcs::git::GitRepo::discover(Path::new(&dir))
		.map(|v| v.map(|inner| VcsGitRepo { inner: Arc::new(inner) }))
		.map_err(|err| rich_error(env, err))
}
/// [`vcs_git_discover`] off the JS thread, so a stalled checkout can't block
/// it.
#[napi]
pub fn vcs_git_discover_async(dir: String, signal: Option<Unknown>) -> Promise<Option<VcsGitRepo>> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped("vcs.gitDiscoverAsync", ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic("vcs.gitDiscoverAsync", || {
			pi_vcs::git::GitRepo::discover(Path::new(&dir))
				.map(|v| v.map(|inner| VcsGitRepo { inner: Arc::new(inner) }))
		})
	})
}
/// Discover Git metadata without opening the repository.
#[napi]
pub fn vcs_git_repo_info(env: Env, dir: String) -> Result<Option<VcsGitRepoInfo>> {
	pi_vcs::git::discover_info(Path::new(&dir))
		.map(|v| v.map(Into::into))
		.map_err(|err| rich_error(env, err))
}
/// Where Git looks for hook `name` in the checkout containing `dir`.
///
/// `core.hooksPath` or the shared hooks directory, whether or not a file
/// exists there; `null` outside any checkout. Discovery runs off the JS thread
/// too, so a stalled repository can't block it.
#[napi]
pub fn vcs_git_hook_location(
	dir: String,
	name: String,
	signal: Option<Unknown>,
) -> Promise<Option<String>> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped("vcs.gitHookLocation", ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic("vcs.gitHookLocation", || {
			let Some(repo) = pi_vcs::git::GitRepo::discover(Path::new(&dir))? else {
				return Ok(None);
			};
			repo
				.hook_location(&name)
				.map(|location| Some(path_string(location)))
		})
	})
}

/// Deallocate the head of a capture file another process is still writing,
/// so it stops taking disk space.
///
/// The size and the last `keep_bytes` bytes are unchanged. Windows only:
/// resolves `false` elsewhere, and on a filesystem without sparse files.
#[napi]
pub fn vcs_drop_capture_head(
	path: String,
	keep_bytes: u32,
	signal: Option<Unknown>,
) -> Promise<bool> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped("vcs.dropCaptureHead", ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic("vcs.dropCaptureHead", || {
			drop_capture_head(Path::new(&path), u64::from(keep_bytes)).map_err(pi_vcs::Error::from)
		})
	})
}

/// Whether another process still has the file open (Windows only; `false`
/// elsewhere or when it can't be told), so a capture a lingering child writes
/// to isn't deleted, which would only hide it.
///
/// The open runs off the JS thread, so a stalled network `TMPDIR` can't freeze
/// the process.
#[napi]
pub fn vcs_capture_held(path: String, signal: Option<Unknown>) -> Promise<bool> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped("vcs.captureHeld", ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic("vcs.captureHeld", || Ok::<_, pi_vcs::Error>(capture_held(Path::new(&path))))
	})
}

#[allow(clippy::missing_const_for_fn, reason = "the Windows signature")]
#[cfg(not(windows))]
fn capture_held(_path: &Path) -> bool {
	false
}

#[cfg(windows)]
fn capture_held(path: &Path) -> bool {
	use std::os::windows::fs::OpenOptionsExt as _;

	use windows_sys::Win32::Foundation::ERROR_SHARING_VIOLATION;

	// Sharing none: the open fails while any other handle to the file exists.
	std::fs::OpenOptions::new()
		.read(true)
		.share_mode(0)
		.open(path)
		.is_err_and(|err| err.raw_os_error() == Some(ERROR_SHARING_VIOLATION as i32))
}

#[allow(clippy::unnecessary_wraps, clippy::missing_const_for_fn, reason = "the Windows signature")]
#[cfg(not(windows))]
fn drop_capture_head(_path: &Path, _keep: u64) -> std::io::Result<bool> {
	Ok(false)
}

#[cfg(windows)]
fn drop_capture_head(path: &Path, keep: u64) -> std::io::Result<bool> {
	use std::{ffi::c_void, os::windows::io::AsRawHandle as _};

	use windows_sys::Win32::{
		Foundation::{ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER, ERROR_NOT_SUPPORTED},
		System::{
			IO::DeviceIoControl,
			Ioctl::{
				FILE_SET_SPARSE_BUFFER, FILE_ZERO_DATA_INFORMATION, FSCTL_SET_SPARSE,
				FSCTL_SET_ZERO_DATA,
			},
		},
	};

	fn control<I>(file: &std::fs::File, code: u32, input: &I) -> std::io::Result<()> {
		let mut returned = 0u32;
		// SAFETY: the handle is valid for the call, `input` is a live `I` of the
		// stated size, there is no output buffer, and the call is synchronous.
		let ok = unsafe {
			DeviceIoControl(
				file.as_raw_handle() as _,
				code,
				std::ptr::from_ref(input).cast::<c_void>(),
				size_of::<I>() as u32,
				std::ptr::null_mut(),
				0,
				&raw mut returned,
				std::ptr::null_mut(),
			)
		};
		if ok == 0 {
			Err(std::io::Error::last_os_error())
		} else {
			Ok(())
		}
	}

	// std opens with read|write|delete sharing, so the writing child isn't
	// disturbed.
	let file = std::fs::OpenOptions::new().write(true).open(path)?;
	if let Err(err) = control(&file, FSCTL_SET_SPARSE, &FILE_SET_SPARSE_BUFFER { SetSparse: true }) {
		return match err.raw_os_error().map(|code| code as u32) {
			Some(ERROR_INVALID_FUNCTION | ERROR_NOT_SUPPORTED | ERROR_INVALID_PARAMETER) => Ok(false),
			_ => Err(err),
		};
	}
	let len = file.metadata()?.len();
	if len > keep {
		let zero =
			FILE_ZERO_DATA_INFORMATION { FileOffset: 0, BeyondFinalZero: (len - keep) as i64 };
		control(&file, FSCTL_SET_ZERO_DATA, &zero)?;
	}
	Ok(true)
}

/// Wait up to 9 s for the worktree adds still running in this process to
/// finish.
///
/// Only filesystems without file locks use claim files; this is for an exit
/// that would end those adds without their own cleanup. The claims of adds
/// still running then are left in place: removing them would let another
/// process add the same path while this one still writes it. Such a leftover
/// makes a later add fail naming the file.
#[napi]
pub fn vcs_release_worktree_add_claims() -> Promise<()> {
	let ct = task::CancelToken::new(None, None);
	task::blocking_mapped("vcs.releaseWorktreeAddClaims", ct, rich_error, canceled_error, |_| {
		catch_panic("vcs.releaseWorktreeAddClaims", || {
			// Just under postmortem's 10 s cleanup deadline.
			pi_vcs::git::release_worktree_add_claims(Duration::from_secs(9));
			Ok(())
		})
	})
}

/// Opaque start identity of process `pid`, to tell it from a later process
/// reusing the pid.
///
/// `None` where the platform reports none, or when the process is gone.
#[napi]
pub fn vcs_process_start_time(pid: u32) -> Option<String> {
	#[cfg(target_os = "linux")]
	{
		pi_builtins::proc_sys::start_time(i32::try_from(pid).ok()?).map(|ticks| ticks.to_string())
	}
	#[cfg(target_os = "macos")]
	{
		let info = pi_builtins::proc_sys::bsdinfo(i32::try_from(pid).ok()?)?;
		Some((info.pbi_start_tvsec * 1_000_000 + info.pbi_start_tvusec).to_string())
	}
	#[cfg(not(any(target_os = "linux", target_os = "macos")))]
	{
		let _ = pid;
		None
	}
}

/// Identifies this machine (macOS hardware UUID, Windows machine GUID), so pid
/// scopes of two machines with the same hostname differ.
///
/// The macOS id survives reboots, so a setup owner from before a restart isn't
/// taken for another machine.
///
/// `None` where the platform reports none (Linux reads `/proc` in JS).
#[allow(clippy::missing_const_for_fn, reason = "not const on macOS and Windows")]
#[napi]
pub fn vcs_machine_id() -> Option<String> {
	#[cfg(target_os = "macos")]
	{
		let mut uuid = [0u8; 16];
		let wait = libc::timespec { tv_sec: 1, tv_nsec: 0 };
		// SAFETY: `uuid` is the 16 writable bytes of a `uuid_t`; `wait` is a
		// valid timespec.
		if unsafe { libc::gethostuuid(uuid.as_mut_ptr(), &raw const wait) } != 0 {
			return None;
		}
		Some(uuid.iter().map(|byte| format!("{byte:02x}")).collect())
	}
	#[cfg(windows)]
	{
		use windows_sys::Win32::System::Registry::{
			HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY, RegGetValueW,
		};

		let subkey: Vec<u16> = "SOFTWARE\\Microsoft\\Cryptography"
			.encode_utf16()
			.chain(Some(0))
			.collect();
		let value: Vec<u16> = "MachineGuid".encode_utf16().chain(Some(0)).collect();
		let mut buffer = [0u16; 128];
		let mut bytes = std::mem::size_of_val(&buffer) as u32;
		// SAFETY: both names are NUL-terminated; `buffer`/`bytes` describe a
		// writable buffer of `bytes` bytes.
		let status = unsafe {
			RegGetValueW(
				HKEY_LOCAL_MACHINE,
				subkey.as_ptr(),
				value.as_ptr(),
				RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY,
				std::ptr::null_mut(),
				buffer.as_mut_ptr().cast(),
				&raw mut bytes,
			)
		};
		if status != 0 {
			return None;
		}
		let units = &buffer[..(bytes as usize / 2).min(buffer.len())];
		let end = units
			.iter()
			.position(|&unit| unit == 0)
			.unwrap_or(units.len());
		Some(String::from_utf16_lossy(&units[..end]))
	}
	#[cfg(not(any(target_os = "macos", windows)))]
	{
		None
	}
}

#[napi]
impl VcsGitRepo {
	/// Repository metadata.
	#[napi]
	pub fn info(&self) -> VcsGitRepoInfo {
		self.inner.info().clone().into()
	}

	/// Primary checkout root.
	#[napi]
	pub fn primary_root(&self) -> String {
		path_string(self.inner.primary_root())
	}

	/// Linked-worktree metadata.
	#[napi]
	pub fn linked_worktree(&self) -> Option<VcsLinkedWorktree> {
		self.inner.linked_worktree().map(Into::into)
	}

	/// Resolve HEAD synchronously.
	#[napi]
	pub fn head_sync(&self, env: Env) -> Result<VcsHeadState> {
		self
			.inner
			.head()
			.map(Into::into)
			.map_err(|err| rich_error(env, err))
	}

	/// Worktree-relative prefix of a directory.
	#[napi]
	pub fn prefix_of(&self, dir: String) -> Option<String> {
		self.inner.prefix_of(Path::new(&dir))
	}

	/// Resolve HEAD.
	#[napi]
	pub fn head(&self, signal: Option<Unknown>) -> Promise<VcsHeadState> {
		blocking("vcs.head", self.inner.clone(), signal, |r| r.head().map(Into::into))
	}

	/// Resolve HEAD SHA.
	#[napi]
	pub fn head_sha(&self, signal: Option<Unknown>) -> Promise<Option<String>> {
		blocking("vcs.headSha", self.inner.clone(), signal, |r| r.head_sha())
	}

	/// Current branch.
	#[napi]
	pub fn current_branch(&self, signal: Option<Unknown>) -> Promise<Option<String>> {
		blocking("vcs.currentBranch", self.inner.clone(), signal, |r| r.current_branch())
	}

	/// Default remote branch.
	#[napi]
	pub fn default_branch(&self, signal: Option<Unknown>) -> Promise<Option<String>> {
		blocking("vcs.defaultBranch", self.inner.clone(), signal, |r| r.default_branch())
	}

	/// Resolve a revision.
	#[napi]
	pub fn resolve_ref(&self, name: String, signal: Option<Unknown>) -> Promise<Option<String>> {
		blocking("vcs.resolveRef", self.inner.clone(), signal, move |r| r.resolve_ref(&name))
	}

	/// Test revision existence.
	#[napi]
	pub fn ref_exists(&self, name: String, signal: Option<Unknown>) -> Promise<bool> {
		blocking("vcs.refExists", self.inner.clone(), signal, move |r| r.ref_exists(&name))
	}

	/// Whether the reflog of `refs/heads/<name>` holds the entry
	/// `Branch: renamed refs/heads/<from> to refs/heads/<name>` that
	/// `git branch -m` writes, proving the branch was renamed from `from`.
	/// False when the branch, its reflog, or a matching entry is absent.
	#[napi]
	pub fn branch_renamed_from(
		&self,
		name: String,
		from: String,
		signal: Option<Unknown>,
	) -> Promise<bool> {
		blocking("vcs.branchRenamedFrom", self.inner.clone(), signal, move |r| {
			r.branch_renamed_from(&name, &from)
		})
	}

	/// Tags pointing at a revision.
	#[napi]
	pub fn tags_at(&self, rev: String, signal: Option<Unknown>) -> Promise<Vec<String>> {
		blocking("vcs.tagsAt", self.inner.clone(), signal, move |r| r.tags_at(&rev))
	}

	/// List branches.
	#[napi]
	pub fn list_branches(&self, all: bool, signal: Option<Unknown>) -> Promise<Vec<String>> {
		blocking("vcs.listBranches", self.inner.clone(), signal, move |r| r.list_branches(all))
	}

	/// Whether default porcelain status reports a staged, unstaged, or untracked
	/// change.
	#[napi]
	pub fn is_dirty(&self, signal: Option<Unknown>) -> Promise<bool> {
		blocking("vcs.isDirty", self.inner.clone(), signal, |repo| repo.is_dirty())
	}

	/// Porcelain status.
	#[napi]
	pub fn status_porcelain(
		&self,
		options: VcsStatusOptions,
		signal: Option<Unknown>,
	) -> Promise<String> {
		let options = core::StatusOptions::try_from(options);
		blocking("vcs.statusPorcelain", self.inner.clone(), signal, move |r| {
			r.status_porcelain(&options.map_err(|error| pi_vcs::Error::Backend {
				context: "git status options",
				message: error.to_string(),
			})?)
		})
	}

	/// Status counts.
	#[napi]
	pub fn status_summary(&self, signal: Option<Unknown>) -> Promise<VcsStatusSummary> {
		blocking("vcs.statusSummary", self.inner.clone(), signal, |r| {
			r.status_summary().map(Into::into)
		})
	}

	/// Read config.
	#[napi]
	pub fn config_get(&self, key: String, signal: Option<Unknown>) -> Promise<Option<String>> {
		blocking("vcs.configGet", self.inner.clone(), signal, move |r| r.config_get(&key))
	}

	/// Set config.
	#[napi]
	pub fn config_set(&self, key: String, value: String, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.configSet", self.inner.clone(), signal, move |r| r.config_set(&key, &value))
	}

	/// List remotes.
	#[napi]
	pub fn remote_list(&self, signal: Option<Unknown>) -> Promise<Vec<String>> {
		blocking("vcs.remoteList", self.inner.clone(), signal, |r| r.remote_list())
	}

	/// Remote URL.
	#[napi]
	pub fn remote_url(&self, name: String, signal: Option<Unknown>) -> Promise<Option<String>> {
		blocking("vcs.remoteUrl", self.inner.clone(), signal, move |r| r.remote_url(&name))
	}

	/// Add remote.
	#[napi]
	pub fn remote_add(&self, name: String, url: String, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.remoteAdd", self.inner.clone(), signal, move |r| r.remote_add(&name, &url))
	}

	/// List worktrees.
	#[napi]
	pub fn worktrees(&self, signal: Option<Unknown>) -> Promise<Vec<VcsWorktreeEntry>> {
		blocking("vcs.worktrees", self.inner.clone(), signal, |r| {
			r.worktrees()
				.map(|v| v.into_iter().map(Into::into).collect())
		})
	}

	/// Add worktree.
	#[napi]
	pub fn worktree_add(
		&self,
		path: String,
		ref_name: String,
		options: VcsWorktreeAddOptions,
		signal: Option<Unknown>,
	) -> Promise<VcsWorktreeAddResult> {
		blocking("vcs.worktreeAdd", self.inner.clone(), signal, move |r| {
			let clone = if !options.clone {
				core::WorktreeClone::Off
			} else if let Some(kind) = options.backend {
				core::WorktreeClone::Prefer(from_napi_kind(kind))
			} else {
				core::WorktreeClone::Auto
			};
			r.worktree_add(Path::new(&path), &ref_name, core::WorktreeAddOptions {
				detach: options.detach,
				clone,
				keep_changes: options.keep_changes.unwrap_or(false),
				setup_owner: options.setup_owner,
			})
			.map(|result| VcsWorktreeAddResult {
				cloned_with: result.cloned_with.map(to_napi_kind),
				clone_error: result.clone_error,
			})
		})
	}

	/// Remove worktree.
	#[napi]
	pub fn worktree_remove(
		&self,
		path: String,
		force: bool,
		signal: Option<Unknown>,
	) -> Promise<bool> {
		blocking("vcs.worktreeRemove", self.inner.clone(), signal, move |r| {
			r.worktree_remove(Path::new(&path), force)
		})
	}

	/// Prune worktrees.
	#[napi]
	pub fn worktree_prune(&self, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.worktreePrune", self.inner.clone(), signal, |r| r.worktree_prune())
	}

	/// Clear the setup mark `setupOwner` left on the worktree at `path`, also
	/// once its `.git` is gone.
	#[napi]
	pub fn worktree_end_setup(&self, path: String, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.worktreeEndSetup", self.inner.clone(), signal, move |r| {
			r.worktree_end_setup(Path::new(&path))
		})
	}

	/// Compare-and-swap of a setup mark: replaces (or, with no replacement,
	/// clears) it only while it is still `expected`'s, under the worktree-add
	/// lock. `false` when the mark is missing or another owner's.
	#[napi]
	pub fn worktree_replace_setup_owner(
		&self,
		git_dir: String,
		expected: String,
		replacement: Option<String>,
		signal: Option<Unknown>,
	) -> Promise<bool> {
		blocking("vcs.worktreeReplaceSetupOwner", self.inner.clone(), signal, move |r| {
			r.worktree_replace_setup_owner(Path::new(&git_dir), &expected, replacement.as_deref())
		})
	}

	/// Recent subjects.
	#[napi]
	pub fn log_subjects(&self, count: u32, signal: Option<Unknown>) -> Promise<Vec<String>> {
		blocking("vcs.logSubjects", self.inner.clone(), signal, move |r| {
			r.log_subjects(count as usize)
		})
	}

	/// Recent one-line commits.
	#[napi]
	pub fn log_onelines(&self, count: u32, signal: Option<Unknown>) -> Promise<Vec<String>> {
		blocking("vcs.logOnelines", self.inner.clone(), signal, move |r| {
			r.log_onelines(count as usize)
		})
	}

	/// Commits in a range.
	#[napi]
	pub fn rev_list_range(
		&self,
		base: String,
		head: String,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		blocking("vcs.revListRange", self.inner.clone(), signal, move |r| {
			r.rev_list_range(&base, &head)
		})
	}

	/// Best common ancestor of two revisions.
	#[napi]
	pub fn merge_base(
		&self,
		a: String,
		b: String,
		signal: Option<Unknown>,
	) -> Promise<Option<String>> {
		blocking("vcs.mergeBase", self.inner.clone(), signal, move |r| r.merge_base(&a, &b))
	}

	/// Commits touching a file.
	#[napi]
	pub fn rev_list_touching(
		&self,
		rev: String,
		file: String,
		limit: u32,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		blocking("vcs.revListTouching", self.inner.clone(), signal, move |r| {
			r.rev_list_touching(&rev, &file, limit as usize)
		})
	}

	/// Commit details.
	#[napi]
	pub fn commit_details(&self, rev: String, signal: Option<Unknown>) -> Promise<VcsCommitDetails> {
		blocking("vcs.commitDetails", self.inner.clone(), signal, move |r| {
			r.commit_details(&rev).map(Into::into)
		})
	}

	/// List index or untracked paths.
	#[napi]
	pub fn ls_files(
		&self,
		others: bool,
		exclude_standard: bool,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		blocking("vcs.lsFiles", self.inner.clone(), signal, move |r| {
			r.ls_files(others, exclude_standard)
		})
	}

	/// List tree paths.
	#[napi]
	pub fn ls_tree(
		&self,
		rev: String,
		paths: Vec<String>,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		blocking("vcs.lsTree", self.inner.clone(), signal, move |r| r.ls_tree(&rev, &paths))
	}

	/// List submodule paths.
	#[napi]
	pub fn submodule_paths(&self, signal: Option<Unknown>) -> Promise<Vec<String>> {
		blocking("vcs.submodulePaths", self.inner.clone(), signal, |r| r.submodule_paths())
	}

	/// Read blob bytes.
	#[napi]
	pub fn show_blob(
		&self,
		spec: String,
		max_bytes: Option<u32>,
		signal: Option<Unknown>,
	) -> Promise<VcsShowResult> {
		blocking("vcs.showBlob", self.inner.clone(), signal, move |r| {
			r.show_blob(&spec, max_bytes.map(|v| v as usize))
				.map(Into::into)
		})
	}

	/// Read commit and patch bytes.
	#[napi]
	pub fn show_commit(
		&self,
		rev: String,
		max_bytes: Option<u32>,
		signal: Option<Unknown>,
	) -> Promise<VcsShowResult> {
		blocking("vcs.showCommit", self.inner.clone(), signal, move |r| {
			r.show_commit(&rev, max_bytes.map(|v| v as usize))
				.map(Into::into)
		})
	}

	/// Local LFS media directory.
	#[napi]
	pub fn lfs_media_dir(&self, signal: Option<Unknown>) -> Promise<Option<String>> {
		blocking("vcs.lfsMediaDir", self.inner.clone(), signal, |r| {
			r.lfs_media_dir().map(|v| v.map(path_string))
		})
	}

	/// Render a patch.
	#[napi]
	pub fn diff_text(&self, options: VcsDiffOptions, signal: Option<Unknown>) -> Promise<String> {
		let options = options.into();
		blocking("vcs.diffText", self.inner.clone(), signal, move |r| r.diff_text(&options))
	}

	/// Render a no-index patch between two filesystem paths.
	#[napi]
	pub fn diff_no_index(
		&self,
		left: String,
		right: String,
		binary: bool,
		signal: Option<Unknown>,
	) -> Promise<String> {
		blocking("vcs.diffNoIndex", self.inner.clone(), signal, move |repo| {
			repo.diff_no_index(Path::new(&left), Path::new(&right), binary)
		})
	}

	/// Changed paths.
	#[napi]
	pub fn changed_files(
		&self,
		options: VcsDiffOptions,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		let options = options.into();
		blocking("vcs.changedFiles", self.inner.clone(), signal, move |r| r.changed_files(&options))
	}

	/// Per-file line counts.
	#[napi]
	pub fn numstat(
		&self,
		options: VcsDiffOptions,
		signal: Option<Unknown>,
	) -> Promise<Vec<VcsNumstatEntry>> {
		let options = options.into();
		blocking("vcs.numstat", self.inner.clone(), signal, move |r| {
			r.numstat(&options)
				.map(|v| v.into_iter().map(Into::into).collect())
		})
	}

	/// Test for a diff.
	#[napi]
	pub fn has_diff(&self, options: VcsDiffOptions, signal: Option<Unknown>) -> Promise<bool> {
		let options = options.into();
		blocking("vcs.hasDiff", self.inner.clone(), signal, move |r| r.has_diff(&options))
	}

	/// Diff two trees.
	#[napi]
	pub fn diff_tree(
		&self,
		base: String,
		head: String,
		binary: bool,
		signal: Option<Unknown>,
	) -> Promise<String> {
		blocking("vcs.diffTree", self.inner.clone(), signal, move |r| {
			r.diff_tree(&base, &head, binary)
		})
	}

	/// Stage paths.
	#[napi]
	pub fn stage_files(&self, files: Vec<String>, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.stageFiles", self.inner.clone(), signal, move |r| r.stage_files(&files))
	}

	/// Unstage paths.
	#[napi]
	pub fn unstage(&self, files: Vec<String>, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.unstage", self.inner.clone(), signal, move |r| r.unstage(&files))
	}

	/// Stage selected hunks.
	#[napi]
	pub fn stage_hunks(
		&self,
		selections: Vec<VcsHunkSelection>,
		raw_diff: Option<String>,
		signal: Option<Unknown>,
	) -> Promise<()> {
		let selections: Result<Vec<_>> = selections.into_iter().map(TryInto::try_into).collect();
		blocking("vcs.stageHunks", self.inner.clone(), signal, move |r| {
			r.stage_hunks(
				&selections.map_err(|error| pi_vcs::Error::Backend {
					context: "git hunk selection",
					message: error.to_string(),
				})?,
				raw_diff.as_deref(),
			)
		})
	}

	/// Create commit.
	#[napi]
	pub fn commit_create(
		&self,
		message: String,
		options: VcsCommitOptions,
		signal: Option<Unknown>,
	) -> Promise<String> {
		let options = options.into();
		blocking("vcs.commitCreate", self.inner.clone(), signal, move |r| {
			r.commit_create(&message, &options)
		})
	}

	/// Write a commit object for `tree` on `parents` without moving any ref or
	/// touching the index/worktree (`git commit-tree`).
	#[napi]
	pub fn commit_tree(
		&self,
		tree: String,
		parents: Vec<String>,
		message: String,
		author: Option<VcsCommitAuthor>,
		signal: Option<Unknown>,
	) -> Promise<String> {
		let author: Option<core::CommitAuthor> = author.map(Into::into);
		blocking("vcs.commitTree", self.inner.clone(), signal, move |r| {
			r.commit_tree(&tree, &parents, &message, author.as_ref())
		})
	}

	/// Checkout revision.
	#[napi]
	pub fn checkout(&self, rev: String, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.checkout", self.inner.clone(), signal, move |r| r.checkout(&rev))
	}

	/// Create branch.
	#[napi]
	pub fn create_branch(
		&self,
		name: String,
		start: String,
		force: bool,
		signal: Option<Unknown>,
	) -> Promise<()> {
		blocking("vcs.createBranch", self.inner.clone(), signal, move |r| {
			r.create_branch(&name, &start, force)
		})
	}

	/// Delete branch.
	#[napi]
	pub fn delete_branch(
		&self,
		name: String,
		force: bool,
		signal: Option<Unknown>,
	) -> Promise<bool> {
		blocking("vcs.deleteBranch", self.inner.clone(), signal, move |r| {
			r.delete_branch(&name, force)
		})
	}

	/// Compare-and-swap a local branch through `git update-ref`, which checks
	/// the old value under the ref lock (git must be on `PATH`).
	///
	/// `expected` of `null`/absent requires the branch not to exist;
	/// otherwise it must resolve to exactly that full object id. `target`
	/// sets the branch to that commit, or deletes it (and its
	/// `[branch "<name>"]` config) when `null`/absent. Resolves `false`,
	/// changing nothing, when `expected` does not hold or when `expected` is
	/// set and the branch is checked out in any worktree.
	#[napi]
	pub fn swap_branch(
		&self,
		name: String,
		expected: Option<String>,
		target: Option<String>,
		signal: Option<Unknown>,
	) -> Promise<bool> {
		blocking("vcs.swapBranch", self.inner.clone(), signal, move |r| {
			r.swap_branch(&name, expected.as_deref(), target.as_deref())
		})
	}

	/// Create and checkout branch.
	#[napi]
	pub fn checkout_new_branch(&self, name: String, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.checkoutNewBranch", self.inner.clone(), signal, move |r| {
			r.checkout_new_branch(&name)
		})
	}

	/// Restore paths.
	#[napi]
	pub fn restore(&self, options: VcsRestoreOptions, signal: Option<Unknown>) -> Promise<()> {
		let options = options.into();
		blocking("vcs.restore", self.inner.clone(), signal, move |r| r.restore(&options))
	}

	/// Reset repository state.
	#[napi]
	pub fn reset(
		&self,
		mode: String,
		target: Option<String>,
		signal: Option<Unknown>,
	) -> Promise<()> {
		let mode = match mode.as_str() {
			"soft" => Ok(core::ResetMode::Soft),
			"mixed" => Ok(core::ResetMode::Mixed),
			"hard" => Ok(core::ResetMode::Hard),
			x => Err(napi::Error::from_reason(format!("invalid reset mode: {x}"))),
		};
		blocking("vcs.reset", self.inner.clone(), signal, move |r| {
			r.reset(
				mode.map_err(|error| pi_vcs::Error::Backend {
					context: "git reset mode",
					message: error.to_string(),
				})?,
				target.as_deref(),
			)
		})
	}

	/// Clean untracked paths.
	#[napi]
	pub fn clean(&self, options: VcsCleanOptions, signal: Option<Unknown>) -> Promise<()> {
		let options = options.into();
		blocking("vcs.clean", self.inner.clone(), signal, move |r| r.clean(&options))
	}

	/// Read tree into index.
	#[napi]
	pub fn read_tree(
		&self,
		treeish: String,
		index_path: Option<String>,
		signal: Option<Unknown>,
	) -> Promise<()> {
		blocking("vcs.readTree", self.inner.clone(), signal, move |r| {
			r.read_tree(&treeish, index_path.as_deref().map(Path::new))
		})
	}

	/// Write index tree.
	#[napi]
	pub fn write_tree(
		&self,
		index_path: Option<String>,
		signal: Option<Unknown>,
	) -> Promise<String> {
		blocking("vcs.writeTree", self.inner.clone(), signal, move |r| {
			r.write_tree(index_path.as_deref().map(Path::new))
		})
	}

	/// Apply patch.
	#[napi]
	pub fn apply_patch(
		&self,
		patch: String,
		options: VcsApplyOptions,
		signal: Option<Unknown>,
	) -> Promise<()> {
		let options = options.into();
		blocking("vcs.applyPatch", self.inner.clone(), signal, move |r| {
			r.apply_patch(&patch, &options)
		})
	}

	/// Check patch applicability.
	#[napi]
	pub fn can_apply_patch(
		&self,
		patch: String,
		options: VcsApplyOptions,
		signal: Option<Unknown>,
	) -> Promise<bool> {
		let options = options.into();
		blocking("vcs.canApplyPatch", self.inner.clone(), signal, move |r| {
			r.can_apply_patch(&patch, &options)
		})
	}

	/// Cherry-pick commit.
	#[napi]
	pub fn cherry_pick(&self, rev: String, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.cherryPick", self.inner.clone(), signal, move |r| r.cherry_pick(&rev))
	}

	/// Abort cherry-pick.
	#[napi]
	pub fn cherry_pick_abort(&self, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.cherryPickAbort", self.inner.clone(), signal, |r| r.cherry_pick_abort())
	}

	/// Skip cherry-pick.
	#[napi]
	pub fn cherry_pick_skip(&self, signal: Option<Unknown>) -> Promise<()> {
		blocking("vcs.cherryPickSkip", self.inner.clone(), signal, |r| r.cherry_pick_skip())
	}

	/// Push stash.
	#[napi]
	pub fn stash_push(&self, message: Option<String>, signal: Option<Unknown>) -> Promise<bool> {
		blocking("vcs.stashPush", self.inner.clone(), signal, move |r| {
			r.stash_push(message.as_deref())
		})
	}

	/// Pop stash if cleanly applicable.
	#[napi]
	pub fn stash_try_pop(&self, reinstate_index: bool, signal: Option<Unknown>) -> Promise<bool> {
		blocking("vcs.stashTryPop", self.inner.clone(), signal, move |r| {
			r.stash_try_pop(reinstate_index)
		})
	}

	/// Push via Git CLI.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn push<'e>(
		&self,
		options: VcsPushOptions,
		signal: Option<Unknown>,
		env: &'e Env,
	) -> Result<Object<'e>> {
		let repo = self.inner.clone();
		let options = options.into();
		let cancel = cancellation_token(signal);
		vcs_future(env, "vcs.push", async move { repo.push(&options, cancel).await })
	}

	/// Fetch a refspec via Git CLI.
	#[napi(ts_return_type = "Promise<void>")]
	pub fn fetch<'e>(
		&self,
		remote: String,
		source: String,
		target: String,
		timeout_ms: Option<u32>,
		signal: Option<Unknown>,
		env: &'e Env,
	) -> Result<Object<'e>> {
		let repo = self.inner.clone();
		let cancel = cancellation_token(signal);
		vcs_future(env, "vcs.fetch", async move {
			repo
				.fetch(
					&remote,
					&source,
					&target,
					timeout_ms.map(|v| Duration::from_millis(u64::from(v))),
					cancel,
				)
				.await
		})
	}
}

/// Clone a Git repository.
#[napi(ts_return_type = "Promise<void>")]
pub fn vcs_git_clone<'e>(
	env: &'e Env,
	url: String,
	target: String,
	options: VcsCloneOptions,
	signal: Option<Unknown>,
) -> Result<Object<'e>> {
	let options = options.into();
	let cancel = cancellation_token(signal);
	vcs_future(env, "vcs.clone", async move {
		pi_vcs::git::clone(&url, Path::new(&target), &options, cancel).await
	})
}
/// Detach copied Git metadata.
#[napi]
pub fn vcs_detach_git_dir(
	worktree_root: String,
	source_common_dir: String,
	signal: Option<Unknown>,
) -> Promise<String> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped("vcs.detachGitDir", ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		pi_vcs::git::detach_git_dir(Path::new(&worktree_root), Path::new(&source_common_dir)).map(
			|v| {
				match v {
					core::DetachGitDirResult::NoGit => "no-git",
					core::DetachGitDirResult::Independent => "independent",
					core::DetachGitDirResult::Detached => "detached",
				}
				.into()
			},
		)
	})
}
/// Join patch fragments.
#[napi]
pub fn vcs_join_patches(parts: Vec<String>) -> String {
	pi_vcs::git::join_patches(&parts)
}
/// Validate hunk selections.
#[napi]
pub fn vcs_validate_hunk_selections(
	raw_diff: String,
	selections: Vec<VcsHunkSelection>,
) -> Vec<VcsHunkSelectionError> {
	let selections: Vec<_> = selections
		.into_iter()
		.filter_map(|v| v.try_into().ok())
		.collect();
	pi_vcs::git::validate_hunk_selections(&raw_diff, &selections)
		.into_iter()
		.map(|v| VcsHunkSelectionError { path: v.path, message: v.message })
		.collect()
}
/// Test whether a directory is a pure jj workspace.
#[napi]
pub fn vcs_is_pure_jj(env: Env, dir: String) -> Result<bool> {
	pi_vcs::is_pure_jj(Path::new(&dir)).map_err(|err| rich_error(env, err))
}

/// In-process Jujutsu workspace handle.
#[napi]
pub struct VcsJjWorkspace {
	inner: Arc<pi_vcs::jj::JjWorkspace>,
}
/// Discover a Jujutsu workspace.
#[napi]
pub fn vcs_jj_discover(env: Env, dir: String) -> Result<Option<VcsJjWorkspace>> {
	pi_vcs::jj::JjWorkspace::discover(Path::new(&dir))
		.map(|v| v.map(|inner| VcsJjWorkspace { inner: Arc::new(inner) }))
		.map_err(|err| rich_error(env, err))
}
fn jj_blocking<T: Send + 'static + ToNapiValue + TypeName>(
	tag: &'static str,
	ws: Arc<pi_vcs::jj::JjWorkspace>,
	signal: Option<Unknown>,
	f: impl FnOnce(&pi_vcs::jj::JjWorkspace) -> pi_vcs::Result<T> + Send + 'static,
) -> Promise<T> {
	let ct = task::CancelToken::new(None, signal);
	task::blocking_mapped(tag, ct, rich_error, canceled_error, move |ct| {
		if ct.heartbeat().is_err() {
			return Err(pi_vcs::Error::Canceled);
		}
		catch_panic(tag, || f(&ws))
	})
}
#[napi]
impl VcsJjWorkspace {
	/// Workspace root.
	#[napi]
	pub fn root(&self) -> String {
		path_string(self.inner.root())
	}

	/// Shared store directory.
	#[napi]
	pub fn store_dir(&self) -> String {
		path_string(self.inner.store_dir())
	}

	/// Working-copy label.
	#[napi]
	pub fn working_copy_label(&self, signal: Option<Unknown>) -> Promise<Option<String>> {
		jj_blocking("vcs.jjWorkingCopyLabel", self.inner.clone(), signal, |w| w.working_copy_label())
	}

	/// Status counts.
	#[napi]
	pub fn status_summary(&self, signal: Option<Unknown>) -> Promise<VcsStatusSummary> {
		jj_blocking("vcs.jjStatusSummary", self.inner.clone(), signal, |w| {
			w.status_summary().map(Into::into)
		})
	}

	/// Render working-copy patch.
	#[napi]
	pub fn diff_text(
		&self,
		files: Vec<String>,
		snapshot: bool,
		signal: Option<Unknown>,
	) -> Promise<String> {
		jj_blocking("vcs.jjDiffText", self.inner.clone(), signal, move |w| {
			w.diff_text(&files, snapshot)
		})
	}

	/// List changed paths.
	#[napi]
	pub fn changed_files(
		&self,
		files: Vec<String>,
		snapshot: bool,
		signal: Option<Unknown>,
	) -> Promise<Vec<String>> {
		jj_blocking("vcs.jjChangedFiles", self.inner.clone(), signal, move |w| {
			w.changed_files(&files, snapshot)
		})
	}
}
#[cfg(test)]
mod tests {
	use super::catch_panic;

	/// A gix-style panic (e.g. worker-thread spawn `.expect(...)` hitting
	/// `ERROR_COMMITMENT_LIMIT`) must surface as a typed backend error carrying
	/// the operation tag and panic message — never as an unwind.
	#[test]
	fn catch_panic_converts_native_panics_into_backend_errors() {
		let err = catch_panic("vcs.test", || -> pi_vcs::Result<()> {
			panic!("valid name: Os {{ code: 1455 }}")
		})
		.unwrap_err();
		match err {
			pi_vcs::Error::Backend { context, message } => {
				assert_eq!(context, "vcs.test");
				assert!(message.contains("1455"), "panic message lost: {message}");
			},
			other => panic!("unexpected error variant: {other}"),
		}
		// Non-panicking work passes through untouched.
		assert_eq!(catch_panic("vcs.test", || Ok(7)).unwrap(), 7);
	}
}
