//! Observer-local git facts for the status band: the checked-out branch and
//! whether the worktree is dirty, kept live by watching the repository's head
//! marker with a stat-poll safety net.
//!
//! Nothing here is journaled (ADR 0005): the watcher is a projection input of
//! one observer, exactly like the terminal size.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use flume::{Receiver, Sender};
use notify::{RecursiveMode, Watcher as _};
use omp_core::Str;
use omp_vcs::git::GitRepo;
use serde::Deserialize;
use tokio::{process::Command, task::JoinHandle, time};

use crate::status_band::{GitStatus, PullRequest, WorktreeLabel};

/// Safety-poll cadence when the head watcher is silent or unavailable.
pub const GIT_POLL: Duration = Duration::from_secs(5);

/// A PR lookup is never allowed to stall observer-local status refresh.
const PR_TIMEOUT: Duration = Duration::from_secs(5);

/// Coalescing window after a filesystem event before the repository is
/// re-probed, so one `git checkout` (HEAD, index, ORIG_HEAD) probes once.
const SETTLE: Duration = Duration::from_millis(100);

/// Repository facts the band paints.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GitFacts {
	/// Checked-out local branch; `None` outside a checkout or on a detached
	/// HEAD.
	pub branch:       Option<Str>,
	/// Exact porcelain counts. `None` only for the cheap synchronous launch
	/// snapshot before the first background probe.
	pub status:       Option<GitStatus>,
	/// Pull request associated with the branch, refreshed after HEAD events.
	pub pull_request: Option<PullRequest>,
	/// Linked-worktree identity for the compact path segment.
	pub worktree:     Option<WorktreeLabel>,
}

/// A running head watcher. Dropping it stops the task and releases the
/// filesystem watch.
pub struct GitWatch {
	launch: GitFacts,
	task:   JoinHandle<()>,
}

impl GitWatch {
	/// Starts watching the repository containing `project` with the
	/// production [`GIT_POLL`] cadence. `None` when `project` is not inside a
	/// git checkout or no tokio runtime is current.
	#[must_use]
	pub fn start(project: &Path) -> Option<(Self, Receiver<GitFacts>)> {
		Self::start_with(project, GIT_POLL)
	}

	/// [`Self::start`] with an explicit safety-poll cadence.
	#[must_use]
	pub fn start_with(project: &Path, poll: Duration) -> Option<(Self, Receiver<GitFacts>)> {
		let handle = tokio::runtime::Handle::try_current().ok()?;
		let repo = Arc::new(GitRepo::discover(project).ok().flatten()?);
		// The branch and linked-worktree identity are metadata reads; porcelain
		// status and GitHub lookup stay off the launch path.
		let launch = GitFacts {
			branch:       branch_of(&repo),
			status:       None,
			pull_request: None,
			worktree:     worktree_label(&repo),
		};
		let (events, changes) = flume::unbounded::<()>();
		let watcher = HeadWatcher::install(&repo, events);
		let (sender, receiver) = flume::unbounded();
		let task = handle.spawn(watch_loop(repo, watcher, launch.clone(), changes, sender, poll));
		Some((Self { launch, task }, receiver))
	}

	/// Facts probed synchronously at start: the branch is exact, `dirty` is
	/// resolved by the first delivered [`GitFacts`].
	#[must_use]
	pub const fn launch(&self) -> &GitFacts {
		&self.launch
	}
}

impl Drop for GitWatch {
	fn drop(&mut self) {
		self.task.abort();
	}
}

/// Platform watch over the head marker (in-place writes) and the directory
/// holding it (atomic replacement by git/jj, which would silence a watch
/// bound to the old inode). `None` when the platform watcher cannot be
/// installed; the poll still runs.
struct HeadWatcher {
	watcher: notify::RecommendedWatcher,
	target:  PathBuf,
}

impl HeadWatcher {
	fn install(repo: &GitRepo, events: Sender<()>) -> Option<Self> {
		let target = repo.head_watch_target();
		let directory = if target.is_dir() {
			target.as_path()
		} else {
			target.parent()?
		};
		let mut watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
			if event.is_ok() {
				let _ = events.send(());
			}
		})
		.ok()?;
		watcher.watch(directory, RecursiveMode::NonRecursive).ok()?;
		let mut watcher = Self { watcher, target };
		watcher.rearm();
		Some(watcher)
	}

	/// Re-binds the marker watch to whatever inode now sits at the target
	/// path; a failure just leaves the directory watch and the poll.
	fn rearm(&mut self) {
		if self.target.is_dir() {
			return;
		}
		let _ = self.watcher.unwatch(&self.target);
		let _ = self
			.watcher
			.watch(&self.target, RecursiveMode::NonRecursive);
	}
}

async fn watch_loop(
	repo: Arc<GitRepo>,
	mut watcher: Option<HeadWatcher>,
	mut last: GitFacts,
	changes: Receiver<()>,
	sender: Sender<GitFacts>,
	poll: Duration,
) {
	// Deliver the status counts and PR the launch probe skipped.
	let mut due = true;
	let mut refresh_pr = true;
	loop {
		if !due {
			tokio::select! {
				change = changes.recv_async() => {
					if change.is_ok() {
						time::sleep(SETTLE).await;
						while changes.try_recv().is_ok() {}
						if let Some(watcher) = watcher.as_mut() {
							watcher.rearm();
						}
						refresh_pr = true;
					}
				},
				() = time::sleep(poll) => {},
			}
		}
		due = false;
		let probe = Arc::clone(&repo);
		let Ok(mut facts) = tokio::task::spawn_blocking(move || probe_facts(&probe)).await else {
			return;
		};
		if refresh_pr {
			facts.pull_request = lookup_pr(&repo).await;
			refresh_pr = false;
		} else {
			facts.pull_request.clone_from(&last.pull_request);
		}
		if facts != last {
			last = facts.clone();
			if sender.send(facts).is_err() {
				return;
			}
		}
	}
}

fn branch_of(repo: &GitRepo) -> Option<Str> {
	repo.current_branch().ok().flatten().map(Str::from)
}

fn probe_facts(repo: &GitRepo) -> GitFacts {
	let status = repo.status_summary().ok().map(|status| GitStatus {
		staged:    status.staged,
		unstaged:  status.unstaged,
		untracked: status.untracked,
	});
	GitFacts { branch: branch_of(repo), status, pull_request: None, worktree: worktree_label(repo) }
}

fn worktree_label(repo: &GitRepo) -> Option<WorktreeLabel> {
	let linked = repo.linked_worktree()?;
	let project = repo
		.primary_root()
		.file_name()
		.and_then(|name| name.to_str())
		.map(Str::new)?;
	let worktree = linked
		.root
		.file_name()
		.and_then(|name| name.to_str())
		.map(Str::new)?;
	Some(WorktreeLabel { project, worktree })
}

#[derive(Deserialize)]
struct GhPullRequest {
	number: u64,
	url:    Str,
}

/// Bounded, event-driven PR lookup. It runs only at launch and after HEAD
/// changes, never on animation frames or the five-second safety poll.
async fn lookup_pr(repo: &GitRepo) -> Option<PullRequest> {
	let github = repo.remote_list().ok()?.into_iter().any(|name| {
		repo
			.remote_url(&name)
			.ok()
			.flatten()
			.is_some_and(|url| url.contains("github.com"))
	});
	if !github {
		return None;
	}
	let mut command = Command::new("gh");
	command
		.args(["pr", "view", "--json", "number,url"])
		.current_dir(repo.root())
		.kill_on_drop(true);
	let output = time::timeout(PR_TIMEOUT, command.output())
		.await
		.ok()?
		.ok()?;
	if !output.status.success() {
		return None;
	}
	let pull: GhPullRequest = serde_json::from_slice(&output.stdout).ok()?;
	Some(PullRequest { number: pull.number, url: pull.url })
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::*;

	/// Generous bound for a platform watcher delivery plus the settle window.
	const WATCHER: Duration = Duration::from_secs(3);

	fn seeded_repo(root: &Path) -> (GitRepo, Str) {
		omp_vcs::git::init(root).expect("git init");
		fs::write(root.join("note.txt"), "one\n").expect("seed file");
		let repo = GitRepo::discover(root).expect("discover").expect("repo");
		let branch = repo.current_branch().expect("branch").expect("born branch");
		(repo, Str::from(branch))
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn head_moves_reach_the_receiver_through_the_watcher() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let root = scratch.path();
		let (repo, seeded) = seeded_repo(root);
		// A poll this slow cannot be what delivers below.
		let (watch, facts) = GitWatch::start_with(root, Duration::from_secs(60)).expect("watch");
		assert_eq!(watch.launch().branch, Some(seeded.clone()));
		assert!(watch.launch().status.is_none());

		// The launch probe skips the porcelain walk; the first delivery resolves it.
		let first = facts.recv_timeout(WATCHER).expect("initial status probe");
		assert_eq!(first.branch, Some(seeded));
		assert!(first.status.is_some_and(GitStatus::dirty));

		// In-place rewrite of the marker.
		let head = repo.info().head_path.clone();
		fs::write(&head, "ref: refs/heads/other\n").expect("move HEAD");
		let moved = facts.recv_timeout(WATCHER).expect("in-place HEAD write");
		assert_eq!(moved.branch.as_deref(), Some("other"));

		// git's own checkout path: write a lock file, rename it over HEAD.
		let lock = head.with_extension("lock");
		fs::write(&lock, "ref: refs/heads/third\n").expect("lock");
		fs::rename(&lock, &head).expect("replace HEAD");
		let replaced = facts.recv_timeout(WATCHER).expect("renamed HEAD");
		assert_eq!(replaced.branch.as_deref(), Some("third"));

		// And again in place, proving the watch survived the inode swap.
		fs::write(&head, "ref: refs/heads/fourth\n").expect("move HEAD again");
		let again = facts.recv_timeout(WATCHER).expect("post-rename HEAD write");
		assert_eq!(again.branch.as_deref(), Some("fourth"));
		assert!(again.status.is_some_and(GitStatus::dirty));
		drop(watch);
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn worktree_edits_reach_the_receiver_through_the_poll() {
		let scratch = tempfile::tempdir().expect("tempdir");
		let root = scratch.path();
		let (_, seeded) = seeded_repo(root);
		let poll = Duration::from_millis(200);
		let (watch, facts) = GitWatch::start_with(root, poll).expect("watch");
		let first = facts.recv_timeout(poll * 10).expect("initial status probe");
		assert_eq!(first.branch, Some(seeded.clone()));
		assert!(first.status.is_some_and(GitStatus::dirty));

		// Worktree files are outside the watched git dir: only the poll sees
		// them.
		fs::remove_file(root.join("note.txt")).expect("clean worktree");
		let clean = facts.recv_timeout(poll * 10).expect("clean probe");
		assert_eq!(clean.branch, Some(seeded.clone()));
		assert!(clean.status.is_some_and(|status| !status.dirty()));

		fs::write(root.join("again.txt"), "two\n").expect("dirty again");
		let dirty = facts.recv_timeout(poll * 10).expect("dirty probe");
		assert_eq!(dirty.branch, Some(seeded));
		assert!(dirty.status.is_some_and(GitStatus::dirty));

		assert!(facts.recv_timeout(poll * 3).is_err(), "unchanged facts are not re-sent");
		drop(watch);
	}

	#[tokio::test]
	async fn outside_a_checkout_there_is_nothing_to_watch() {
		let scratch = tempfile::tempdir().expect("tempdir");
		assert!(GitWatch::start(scratch.path()).is_none());
	}
}
