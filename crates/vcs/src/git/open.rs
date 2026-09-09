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
