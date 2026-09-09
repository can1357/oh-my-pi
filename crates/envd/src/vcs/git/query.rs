//! Repository file and history queries backed by `omp-vcs`.

use std::{path::Path, sync::Arc};

use bytes::Bytes;
use omp_core::Str;
use tokio_util::sync::CancellationToken;

use super::{blocking, commands::CommandError};

/// A repository-relative path.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GitPath(Bytes);
impl GitPath {
	/// Exposes the exact repository-relative path bytes.
	pub fn as_bytes(&self) -> &[u8] {
		&self.0
	}

	/// Copies exact Git path bytes into the repository path model.
	pub(super) fn from_bytes(bytes: &[u8]) -> Self {
		Self(Bytes::copy_from_slice(bytes))
	}
}

/// Commit author and message metadata.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommitMetadata {
	/// Full commit object identifier.
	pub hash:         Str,
	/// Parent commit object identifiers in recorded order.
	pub parents:      Vec<Str>,
	/// Author display name.
	pub author_name:  Str,
	/// Author email address.
	pub author_email: Str,
	/// Git-formatted author timestamp.
	pub author_date:  Str,
	/// Complete commit message.
	pub body:         Str,
}

/// Typed read-only Git query facade.
#[derive(Clone, Copy, Default)]
pub struct GitQuery;
impl GitQuery {
	/// Creates a read-only query facade.
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

	/// Reads the blob selected by a revision-and-path specification.
	pub async fn show_path(
		&self,
		cwd: &Path,
		spec: &str,
		cancel: &CancellationToken,
	) -> Result<Bytes, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let spec = spec.to_owned();
		Ok(Bytes::from(
			blocking(Some(cancel), move || repo.show_blob(&spec, None))
				.await?
				.bytes,
		))
	}

	/// Reads a selected blob and forwards its bytes to a streaming consumer.
	pub async fn show_path_stream(
		&self,
		cwd: &Path,
		spec: &str,
		cancel: &CancellationToken,
		on_stdout: &mut (impl FnMut(Bytes) + Send),
	) -> Result<Bytes, CommandError> {
		let bytes = self.show_path(cwd, spec, cancel).await?;
		on_stdout(bytes.clone());
		Ok(bytes)
	}

	/// Lists paths tracked by the index.
	pub async fn tracked(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Vec<GitPath>, CommandError> {
		self.files(cwd, false, false, cancel).await
	}

	/// Lists untracked paths after applying standard ignore rules.
	pub async fn untracked(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Vec<GitPath>, CommandError> {
		self.files(cwd, true, true, cancel).await
	}

	async fn files(
		&self,
		cwd: &Path,
		others: bool,
		exclude: bool,
		cancel: &CancellationToken,
	) -> Result<Vec<GitPath>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.ls_files(others, exclude))
			.await?
			.into_iter()
			.map(|p| GitPath::from_bytes(p.as_bytes()))
			.collect())
	}

	/// Lists paths contained in a tree, optionally restricted by pathspecs.
	pub async fn tree(
		&self,
		cwd: &Path,
		tree: &str,
		paths: &[&str],
		cancel: &CancellationToken,
	) -> Result<Vec<GitPath>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let tree = tree.to_owned();
		let paths = paths.iter().map(|p| (*p).to_owned()).collect::<Vec<_>>();
		Ok(blocking(Some(cancel), move || repo.ls_tree(&tree, &paths))
			.await?
			.into_iter()
			.map(|p| GitPath::from_bytes(p.as_bytes()))
			.collect())
	}

	/// Lists repository-relative submodule paths.
	pub async fn submodules(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Vec<GitPath>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.submodule_paths())
			.await?
			.into_iter()
			.map(|p| GitPath::from_bytes(p.as_bytes()))
			.collect())
	}

	/// Reads the newest commit subjects up to the requested count.
	pub async fn log_subjects(
		&self,
		cwd: &Path,
		count: usize,
		cancel: &CancellationToken,
	) -> Result<Vec<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.log_subjects(count))
			.await?
			.into_iter()
			.map(Str::from)
			.collect())
	}

	/// Reads abbreviated object identifiers and subjects for recent commits.
	pub async fn log_onelines(
		&self,
		cwd: &Path,
		count: usize,
		cancel: &CancellationToken,
	) -> Result<Vec<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		Ok(blocking(Some(cancel), move || repo.log_onelines(count))
			.await?
			.into_iter()
			.map(Str::from)
			.collect())
	}

	/// Lists commits reachable from one revision but not another.
	pub async fn rev_list_range(
		&self,
		cwd: &Path,
		base: &str,
		head: &str,
		cancel: &CancellationToken,
	) -> Result<Vec<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let base = base.to_owned();
		let head = head.to_owned();
		Ok(blocking(Some(cancel), move || repo.rev_list_range(&base, &head))
			.await?
			.into_iter()
			.map(Str::from)
			.collect())
	}

	/// Lists commits touching a path along the requested history.
	pub async fn rev_list_touching(
		&self,
		cwd: &Path,
		reference: &str,
		path: &str,
		limit: usize,
		cancel: &CancellationToken,
	) -> Result<Vec<Str>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let reference = reference.to_owned();
		let path = path.to_owned();
		Ok(blocking(Some(cancel), move || repo.rev_list_touching(&reference, &path, limit))
			.await?
			.into_iter()
			.map(Str::from)
			.collect())
	}

	/// Reads author, ancestry, timestamp, and message metadata for a commit.
	pub async fn commit_metadata(
		&self,
		cwd: &Path,
		revision: &str,
		cancel: &CancellationToken,
	) -> Result<CommitMetadata, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let revision = revision.to_owned();
		let d = blocking(Some(cancel), move || repo.commit_details(&revision)).await?;
		Ok(CommitMetadata {
			hash:         Str::from(d.sha),
			parents:      d.parents.into_iter().map(Str::from).collect(),
			author_name:  Str::from(d.author.name),
			author_email: Str::from(d.author.email),
			author_date:  Str::from(d.author.date.unwrap_or_default()),
			body:         Str::from(d.message),
		})
	}
}
