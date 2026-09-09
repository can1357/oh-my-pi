//! Lazy gitoxide handle management for [`GitRepo`](super::GitRepo).
//!
//! Owns the single place a `gix::ThreadSafeRepository` is opened: isolated
//! from ambient `GIT_DIR`/`GIT_INDEX_FILE`-style environment overrides (the
//! wrapper always operates on the discovered repository), while still honoring
//! user/system config for identity and diff settings. Reftable repositories
//! must never be opened here — callers route those through [`super::cli`].

use gix::{
	open::{Options, Permissions, permissions},
	sec::{Permission, Trust},
};

use super::GitRepo;
use crate::error::{Error, Result};

impl GitRepo {
	/// Thread-local gitoxide repository for this checkout, opening the shared
	/// thread-safe handle on first use.
	///
	/// Errors on reftable repositories: they are unreadable in-process and
	/// every operation on them must use the CLI fallback instead.
	pub(crate) fn gix(&self) -> Result<gix::Repository> {
		if self.info().is_reftable {
			return Err(Error::backend(
				"git open",
				"reftable repository cannot be opened in-process; use the CLI fallback",
			));
		}
		if let Some(repo) = self.gix.get() {
			return Ok(repo.to_thread_local());
		}
		let opened = open_options()
			.open(self.root())
			.map_err(|err| Error::backend("git open", err))?;
		// A concurrent open may have won the race; either handle is equivalent.
		let repo = self.gix.get_or_init(move || opened);
		Ok(repo.to_thread_local())
	}

	/// Freshly opened gitoxide repository, bypassing the cached handle.
	///
	/// The cached handle snapshots config and refs at first open; callers that
	/// must observe out-of-band mutations (config writes, remote edits) pay
	/// for a fresh open instead.
	pub(crate) fn gix_fresh(&self) -> Result<gix::Repository> {
		if self.info().is_reftable {
			return Err(Error::backend(
				"git open",
				"reftable repository cannot be opened in-process; use the CLI fallback",
			));
		}
		Ok(open_options()
			.open(self.root())
			.map_err(|err| Error::backend("git open", err))?
			.to_thread_local())
	}
}

/// Load the persisted worktree index straight from disk, reconstructing it from
/// `HEAD^{tree}` (or an empty index when `HEAD` is unborn) if no index file
/// exists.
///
/// Reads bypass gix's shared, mtime-gated index snapshot. The cached
/// [`gix`](GitRepo::gix) handle shares one
/// `SharedFileSnapshot<gix_index::File>` across every thread-local clone and
/// only reloads it when the index file's mtime is *strictly* newer than the
/// snapshot — gix's freshness check is deliberately sub-second-racy (`gix_fs`
/// `recent_snapshot` notes it "relies on sub-section precision or else is a
/// race … up to the caller"). The in-process mutators here write a fresh index
/// within the same mtime tick as the read that populated the snapshot, so a
/// later read through that snapshot would return the pre-mutation index — e.g.
/// a commit right after staging sees an unchanged tree and fails with "nothing
/// to commit, working tree clean". Reading the index from disk makes
/// mutate→read deterministic regardless of filesystem timestamp granularity.
pub(crate) fn load_index_or_head(
	repo: &gix::Repository,
	op: &'static str,
) -> Result<gix::index::File> {
	match repo.open_index() {
		Ok(index) => Ok(index),
		Err(gix::worktree::open_index::Error::IndexFile(gix::index::file::init::Error::Io(err)))
			if err.kind() == std::io::ErrorKind::NotFound =>
		{
			Ok(repo
				.index_or_load_from_head_or_empty()
				.map_err(|err| Error::backend(op, err))?
				.into_owned())
		},
		Err(err) => Err(Error::backend(op, err)),
	}
}

/// Load the persisted worktree index straight from disk, falling back to an
/// empty index (never `HEAD^{tree}`) when no index file exists.
///
/// Same snapshot-bypass rationale as [`load_index_or_head`]; the empty-index
/// fallback matches gix's [`index_or_empty`](gix::Repository::index_or_empty).
pub(crate) fn load_index_or_empty(
	repo: &gix::Repository,
	op: &'static str,
) -> Result<gix::index::File> {
	match repo.open_index() {
		Ok(index) => Ok(index),
		Err(gix::worktree::open_index::Error::IndexFile(gix::index::file::init::Error::Io(err)))
			if err.kind() == std::io::ErrorKind::NotFound =>
		{
			Ok(repo
				.index_or_empty()
				.map_err(|err| Error::backend(op, err))?
				.into_owned_or_cloned())
		},
		Err(err) => Err(Error::backend(op, err)),
	}
}

/// Start a status query over an explicitly supplied index.
pub(crate) fn status_with_index<'repo>(
	repo: &'repo gix::Repository,
	op: &'static str,
	index: gix::index::File,
) -> Result<gix::status::Platform<'repo, gix::progress::Discard>> {
	Ok(repo
		.status(gix::progress::Discard)
		.map_err(|err| Error::backend(op, err))?
		.index(index.into()))
}

/// Start a status query with an index loaded directly from disk.
///
/// Supplying the index is required even after other read paths bypass the
/// shared snapshot: [`gix::Repository::status`] otherwise reacquires that same
/// mtime-gated snapshot internally.
pub(crate) fn status_with_fresh_index<'repo>(
	repo: &'repo gix::Repository,
	op: &'static str,
) -> Result<gix::status::Platform<'repo, gix::progress::Discard>> {
	status_with_index(repo, op, load_index_or_empty(repo, op)?)
}

/// Open options for repositories the agent operates on.
///
/// - Environment: deny `GIT_*` location/object overrides — operations bind to
///   the discovered repository, mirroring the env-stripping the subprocess
///   wrapper performed. Home/XDG stay allowed so user config resolves.
/// - Config: user/system/git config allowed (identity, diff drivers), without
///   ever executing the git binary for its install-prefix config.
/// - Trust: full. This is a local dev tool operating on the user's own
///   checkout; ownership quarantine would only reject repos the user already
///   chose to work in.
fn open_options() -> Options {
	Options::default()
		.permissions(Permissions {
			env:        permissions::Environment {
				xdg_config_home: Permission::Allow,
				home:            Permission::Allow,
				http_transport:  Permission::Deny,
				identity:        Permission::Allow,
				objects:         Permission::Deny,
				git_prefix:      Permission::Deny,
				ssh_prefix:      Permission::Deny,
			},
			config:     permissions::Config::all(),
			attributes: permissions::Attributes::all(),
		})
		.with(Trust::Full)
}
