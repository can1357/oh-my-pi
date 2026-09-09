//! Environment-backed native Git materialization for pinned extension trees.

use std::{
	fs, io,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use omp_core::Hash32;
use omp_ext::{ExtensionCode, ExtensionError, config::SourceSpec};
use tokio_util::sync::CancellationToken;

use super::vcs::git::{blocking, commands::GitCommands, repo::Repository};
static GIT_MATERIALIZATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone)]
/// Materializes pinned Git extension sources through the shared VCS backend.
pub struct NativeGitResolver {
	commands:   GitCommands,
	cache_root: PathBuf,
}
impl NativeGitResolver {
	/// Creates a resolver rooted at the app-owned repository cache.
	pub fn new(cache_root: PathBuf) -> Self {
		Self { commands: GitCommands::new(), cache_root }
	}

	/// Fetches and verifies one pinned source before atomically publishing it.
	pub async fn materialize(
		&self,
		source: &SourceSpec,
		destination: &Path,
		cancel: &CancellationToken,
	) -> Result<PathBuf, ExtensionError> {
		let SourceSpec::Git { repository, revision, subdirectory } = source else {
			return Err(ext_git_error("native Git resolver requires a git: source"));
		};
		if destination.exists() {
			return Err(ext_git_error("Git materialization destination already exists"));
		}
		fs::create_dir_all(&self.cache_root).map_err(git_io)?;
		let cache = self
			.cache_root
			.join(Hash32::sum(repository.as_bytes()).to_hex().as_str());
		if !cache.is_dir() {
			let sequence = GIT_MATERIALIZATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
			let stage = self
				.cache_root
				.join(format!(".git-cache-{sequence:016x}.tmp"));
			let stage2 = stage.clone();
			let repo = blocking(Some(cancel), move || omp_vcs::git::init_bare(&stage2))
				.await
				.map_err(git_vcs)?;
			drop(repo);
			match fs::rename(&stage, &cache) {
				Ok(()) => {},
				Err(_) if cache.is_dir() => {
					let _ = fs::remove_dir_all(&stage);
				},
				Err(e) => {
					let _ = fs::remove_dir_all(&stage);
					return Err(git_io(e));
				},
			}
		}
		let handle = Arc::new(omp_vcs::git::GitRepo::require(&cache).map_err(git_vcs)?);
		let bare = Repository::from_handle(handle);
		self
			.commands
			.add_remote(&bare, "origin", repository, cancel)
			.await
			.map_err(git_command)?;
		let target = "refs/omp/extensions/source";
		self
			.commands
			.fetch_refspec(&bare, "origin", revision, target, cancel)
			.await
			.map_err(git_command)?;
		let resolved = self
			.commands
			.resolve_ref(&cache, &format!("{target}^{{commit}}"), cancel)
			.await
			.map_err(git_command)?
			.ok_or_else(|| ext_git_error("fetched Git revision is absent"))?;
		if matches!(revision.len(), 40 | 64) && !resolved.eq_ignore_ascii_case(revision) {
			return Err(ext_git_error("fetched Git revision differs from the pinned commit"));
		}
		let sequence = GIT_MATERIALIZATION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		if let Some(parent) = destination.parent() {
			fs::create_dir_all(parent).map_err(git_io)?;
		}
		let stage = destination.with_file_name(format!(".git-source-{sequence:016x}.tmp"));
		omp_vcs::git::clone(
			utf8_path(&cache)?,
			&stage,
			&omp_vcs::CloneOptions { sha: Some(resolved.as_str().to_owned()), ..Default::default() },
			Some(cancel.clone()),
		)
		.await
		.map_err(git_vcs)?;
		let repo = Arc::new(omp_vcs::git::GitRepo::require(&stage).map_err(git_vcs)?);
		let selected = resolved.as_str().to_owned();
		blocking(Some(cancel), move || repo.checkout(&selected))
			.await
			.map_err(git_vcs)?;
		fs::remove_dir_all(stage.join(".git")).map_err(git_io)?;
		fs::rename(&stage, destination).map_err(git_io)?;
		let root = fs::canonicalize(destination).map_err(git_io)?;
		let selected = subdirectory
			.as_ref()
			.map_or_else(|| root.clone(), |p| root.join(p));
		let selected = fs::canonicalize(selected).map_err(git_io)?;
		if !selected.starts_with(&root) {
			return Err(ext_git_error("Git source subdirectory escapes the materialized tree"));
		}
		Ok(selected)
	}
}
fn utf8_path(path: &Path) -> Result<&str, ExtensionError> {
	path
		.to_str()
		.ok_or_else(|| ext_git_error("Git materialization path is not UTF-8"))
}
fn ext_git_error(detail: &str) -> ExtensionError {
	ExtensionError::new(ExtensionCode::EIntegrity, detail)
}
fn git_io(error: io::Error) -> ExtensionError {
	ExtensionError::new(ExtensionCode::EIntegrity, format!("Git materialization I/O: {error}"))
}
fn git_vcs(error: omp_vcs::Error) -> ExtensionError {
	ExtensionError::new(ExtensionCode::EIntegrity, format!("Environment Git failed: {error}"))
}
fn git_command(error: super::vcs::git::commands::CommandError) -> ExtensionError {
	ExtensionError::new(ExtensionCode::EIntegrity, format!("Environment Git failed: {error}"))
}
