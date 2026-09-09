//! Typed Git branch, ref, remote, configuration, and checkout commands.

use std::{path::Path, sync::Arc};

use omp_core::{IntoStr, Str};
use tokio_util::sync::CancellationToken;

use super::{blocking, lock, repo::Repository};

/// A Git operation failed.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
	/// The in-process VCS backend rejected the operation.
	#[error(transparent)]
	Vcs(#[from] omp_vcs::Error),
	/// A plumbing record was not valid UTF-8 or was structurally incomplete.
	#[error("Git emitted invalid plumbing output")]
	NonUtf8,
	/// A remote name already exists with another URL.
	#[error("Git remote {name} already exists with a different URL")]
	RemoteConflict {
		/// Conflicting remote name.
		name:      Str,
		/// URL already configured for the remote.
		existing:  Str,
		/// URL requested by the caller.
		requested: Str,
	},
	/// A mutating operation was cancelled while waiting for repository
	/// authority.
	#[error(transparent)]
	Lock(#[from] lock::LockError),
}

/// Environment-owned typed Git command facade.
#[derive(Clone, Copy, Default)]
pub struct GitCommands;

impl GitCommands {
	/// Creates a command facade.
	pub const fn new() -> Self {
		Self
	}

	async fn repo(
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Arc<omp_vcs::git::GitRepo>, CommandError> {
		let cwd = cwd.to_owned();
		blocking(Some(cancel), move || omp_vcs::git::GitRepo::require(&cwd).map(Arc::new))
			.await
			.map_err(Into::into)
	}

	/// Reads the current branch name, or `None` for detached `HEAD`.
	pub async fn current_branch(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Option<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.current_branch())
			.await?
			.map(Str::from))
	}

	/// Discovers the repository's configured or conventional default branch.
	pub async fn default_branch(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Option<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.default_branch())
			.await?
			.map(Str::from))
	}

	/// Lists local branches and optionally remote-tracking branches.
	pub async fn list_branches(
		&self,
		cwd: &Path,
		all: bool,
		cancel: &CancellationToken,
	) -> Result<Vec<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.list_branches(all))
			.await?
			.into_iter()
			.map(Str::from)
			.collect())
	}

	/// Creates a branch at the requested starting revision.
	pub async fn create_branch(
		&self,
		repository: &Repository,
		name: &str,
		start: &str,
		cancel: &CancellationToken,
	) -> Result<(), CommandError> {
		let _guard = lock::write(repository, cancel).await?;
		let (repo, name, start) = (repository.handle.clone(), name.to_owned(), start.to_owned());
		blocking(Some(cancel), move || repo.create_branch(&name, &start, false)).await?;
		Ok(())
	}

	/// Deletes a branch after acquiring repository mutation authority.
	pub async fn delete_branch(
		&self,
		repository: &Repository,
		name: &str,
		force: bool,
		cancel: &CancellationToken,
	) -> Result<(), CommandError> {
		let _guard = lock::write(repository, cancel).await?;
		let (repo, name) = (repository.handle.clone(), name.to_owned());
		blocking(Some(cancel), move || repo.delete_branch(&name, force).map(drop)).await?;
		Ok(())
	}

	/// Checks out an existing branch or revision.
	pub async fn checkout(
		&self,
		repository: &Repository,
		reference: &str,
		cancel: &CancellationToken,
	) -> Result<(), CommandError> {
		let _guard = lock::write(repository, cancel).await?;
		let (repo, reference) = (repository.handle.clone(), reference.to_owned());
		blocking(Some(cancel), move || repo.checkout(&reference)).await?;
		Ok(())
	}

	/// Creates and checks out a branch from the current `HEAD`.
	pub async fn checkout_new(
		&self,
		repository: &Repository,
		name: &str,
		cancel: &CancellationToken,
	) -> Result<(), CommandError> {
		let _guard = lock::write(repository, cancel).await?;
		let (repo, name) = (repository.handle.clone(), name.to_owned());
		blocking(Some(cancel), move || repo.checkout_new_branch(&name)).await?;
		Ok(())
	}

	/// Resolves a revision expression to an object identifier when it exists.
	pub async fn resolve_ref(
		&self,
		cwd: &Path,
		reference: &str,
		cancel: &CancellationToken,
	) -> Result<Option<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let reference = reference.to_owned();
		Ok(blocking(Some(cancel), move || repo.resolve_ref(&reference))
			.await?
			.map(Str::from))
	}

	/// Reports whether a revision expression resolves in the repository.
	pub async fn ref_exists(
		&self,
		cwd: &Path,
		reference: &str,
		cancel: &CancellationToken,
	) -> Result<bool, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let reference = reference.to_owned();
		Ok(blocking(Some(cancel), move || repo.ref_exists(&reference)).await?)
	}

	/// Lists tags that point at the requested revision.
	pub async fn tags(
		&self,
		cwd: &Path,
		reference: &str,
		cancel: &CancellationToken,
	) -> Result<Vec<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let reference = reference.to_owned();
		Ok(blocking(Some(cancel), move || repo.tags_at(&reference))
			.await?
			.into_iter()
			.map(Str::from)
			.collect())
	}

	/// Lists configured remote names.
	pub async fn remotes(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Vec<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.remote_list())
			.await?
			.into_iter()
			.map(Str::from)
			.collect())
	}

	/// Reads a remote's URL when that remote exists.
	pub async fn remote_url(
		&self,
		cwd: &Path,
		name: &str,
		cancel: &CancellationToken,
	) -> Result<Option<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let name = name.to_owned();
		Ok(blocking(Some(cancel), move || repo.remote_url(&name))
			.await?
			.map(Str::from))
	}

	/// Adds a remote unless the name already maps to another URL.
	pub async fn add_remote(
		&self,
		repository: &Repository,
		name: &str,
		url: &str,
		cancel: &CancellationToken,
	) -> Result<(), CommandError> {
		if let Some(existing) = self
			.remote_url(&repository.worktree_root, name, cancel)
			.await?
		{
			if existing.as_str() == url {
				return Ok(());
			}
			return Err(CommandError::RemoteConflict {
				name: name.to_str(),
				existing,
				requested: url.to_str(),
			});
		}
		let _guard = lock::write(repository, cancel).await?;
		let (repo, name, url) = (repository.handle.clone(), name.to_owned(), url.to_owned());
		blocking(Some(cancel), move || repo.remote_add(&name, &url)).await?;
		Ok(())
	}

	/// Fetches one source refspec into a local target reference.
	pub async fn fetch_refspec(
		&self,
		repository: &Repository,
		remote: &str,
		source: &str,
		target: &str,
		cancel: &CancellationToken,
	) -> Result<(), CommandError> {
		repository
			.handle
			.fetch(remote, source, target, None, Some(cancel.clone()))
			.await?;
		Ok(())
	}

	/// Reads a repository configuration value when present.
	pub async fn config_get(
		&self,
		cwd: &Path,
		key: &str,
		cancel: &CancellationToken,
	) -> Result<Option<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let key = key.to_owned();
		Ok(blocking(Some(cancel), move || repo.config_get(&key))
			.await?
			.map(Str::from))
	}

	/// Writes a repository configuration value under mutation authority.
	pub async fn config_set(
		&self,
		repository: &Repository,
		key: &str,
		value: &str,
		cancel: &CancellationToken,
	) -> Result<(), CommandError> {
		let _guard = lock::write(repository, cancel).await?;
		let (repo, key, value) = (repository.handle.clone(), key.to_owned(), value.to_owned());
		blocking(Some(cancel), move || repo.config_set(&key, &value)).await?;
		Ok(())
	}

	/// Computes the repository-relative prefix of a working directory.
	pub async fn workdir_prefix(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Option<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let cwd = cwd.to_owned();
		Ok(blocking(Some(cancel), move || Ok(repo.prefix_of(&cwd)))
			.await?
			.map(Str::from))
	}
}
