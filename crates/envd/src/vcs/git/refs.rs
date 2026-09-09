//! Git HEAD projection and invalidation polling backed by `omp-vcs`.

#[cfg(unix)]
use std::os::unix::fs;
use std::{
	path::Path,
	time::{Duration, SystemTime},
};

use flume::Receiver;
use omp_core::Str;
use tokio::{time, time::MissedTickBehavior};
use tokio_util::sync::CancellationToken;

use super::{blocking, repo::Repository};

const POLL_INTERVAL: Duration = Duration::from_millis(250);

/// Fully resolved repository HEAD state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HeadState {
	/// `HEAD` is attached to a branch and resolves to a commit.
	Branch {
		/// Fully qualified reference named by `HEAD`.
		reference: Str,
		/// Short branch name when the reference is under `refs/heads`.
		branch:    Option<Str>,
		/// Resolved commit object identifier.
		commit:    Str,
	},
	/// `HEAD` names a branch that has no commits yet.
	Unborn {
		/// Fully qualified reference named by `HEAD`.
		reference: Str,
		/// Short branch name when the reference is under `refs/heads`.
		branch:    Option<Str>,
	},
	/// `HEAD` points directly to a commit.
	Detached {
		/// Resolved commit object identifier.
		commit: Str,
	},
}
impl HeadState {
	/// Provides the resolved commit when `HEAD` has one.
	pub fn commit(&self) -> Option<&str> {
		match self {
			Self::Branch { commit, .. } | Self::Detached { commit } => Some(commit.as_str()),
			Self::Unborn { .. } => None,
		}
	}

	/// Provides the short branch name when `HEAD` is attached.
	pub fn branch(&self) -> Option<&str> {
		match self {
			Self::Branch { branch, .. } | Self::Unborn { branch, .. } => branch.as_deref(),
			Self::Detached { .. } => None,
		}
	}
}

/// HEAD resolution failure.
#[derive(Debug, thiserror::Error)]
pub enum RefError {
	#[error(transparent)]
	/// The VCS backend could not inspect a reference.
	Vcs(#[from] omp_vcs::Error),
}

/// Detects whether the repository stores references in reftable format.
pub async fn is_reftable(repository: &Repository) -> Result<bool, RefError> {
	Ok(repository.handle.is_reftable())
}

/// Resolves `HEAD` into its attached, unborn, or detached projection.
pub async fn resolve_head(
	repository: &Repository,
	cancel: &CancellationToken,
) -> Result<HeadState, RefError> {
	let repo = repository.handle.clone();
	let head = blocking(Some(cancel), move || repo.head()).await?;
	Ok(match head {
		omp_vcs::HeadState::Ref { ref_name, branch, commit: Some(commit) } => HeadState::Branch {
			reference: Str::from(ref_name),
			branch:    branch.map(Str::from),
			commit:    Str::from(commit),
		},
		omp_vcs::HeadState::Ref { ref_name, branch, commit: None } => {
			HeadState::Unborn { reference: Str::from(ref_name), branch: branch.map(Str::from) }
		},
		omp_vcs::HeadState::Detached { commit: Some(commit) } => {
			HeadState::Detached { commit: Str::from(commit) }
		},
		omp_vcs::HeadState::Detached { commit: None } => {
			HeadState::Unborn { reference: Str::new_static("HEAD"), branch: None }
		},
	})
}

/// Resolves a reference to its object identifier when it exists.
pub async fn read_ref(repository: &Repository, reference: &str) -> Result<Option<Str>, RefError> {
	let repo = repository.handle.clone();
	let reference = reference.to_owned();
	Ok(blocking(None, move || repo.resolve_ref(&reference))
		.await?
		.map(Str::from))
}

/// Coalescing HEAD invalidation stream.
pub struct HeadInvalidations {
	receiver: Receiver<()>,
	cancel:   CancellationToken,
}
impl HeadInvalidations {
	/// Starts a coalescing watcher for changes to the repository's `HEAD` state.
	pub async fn start(repository: &Repository) -> Result<Self, RefError> {
		let target = repository.handle.head_watch_target();
		let (sender, receiver) = flume::bounded(1);
		let cancel = CancellationToken::new();
		let task_cancel = cancel.clone();
		tokio::spawn(async move {
			let mut previous = fingerprint(&target).await;
			let mut interval = time::interval(POLL_INTERVAL);
			interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
			loop {
				tokio::select! {()=task_cancel.cancelled()=>break,_=interval.tick()=>{let current=fingerprint(&target).await;if current!=previous{previous=current;let _=sender.try_send(());}}}
			}
		});
		Ok(Self { receiver, cancel })
	}

	/// Waits until the repository's `HEAD` state may have changed.
	pub async fn changed(&self) -> Result<(), flume::RecvError> {
		self.receiver.recv_async().await
	}
}
impl Drop for HeadInvalidations {
	fn drop(&mut self) {
		self.cancel.cancel();
	}
}
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Fingerprint {
	modified: Option<SystemTime>,
	len:      u64,
	inode:    u64,
}
async fn fingerprint(path: &Path) -> Option<Fingerprint> {
	let metadata = tokio::fs::metadata(path).await.ok()?;
	#[cfg(unix)]
	let inode = fs::MetadataExt::ino(&metadata);
	#[cfg(not(unix))]
	let inode = 0;
	Some(Fingerprint { modified: metadata.modified().ok(), len: metadata.len(), inode })
}
