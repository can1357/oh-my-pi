//! Forwarding the files a shell run changed to the host.
//!
//! [`FileChangeSink`] is the [`ChangeSink`] behind
//! `ShellFilesystem.onFileChange`. It wants only what a commit could hold:
//! files in a git work tree that git does not ignore and that are not part
//! of a `.git` directory. Logs, build output and scratch files under the
//! temp directory are never read.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	sync::atomic::{AtomicU64, Ordering},
};

use ignore::{
	Match,
	gitignore::{Gitignore, GitignoreBuilder, gitconfig_excludes_path},
};
use napi::{bindgen_prelude::Buffer, threadsafe_function::ThreadsafeFunctionCallMode};
use omp_vfs::ChangeSink;
use parking_lot::Mutex;

use super::vfs::{ShellFileChange, ShellFileChangeHandler};

/// Bytes of file content one sink reports. Changes past it go unreported, so
/// a script rewriting files in a loop stops paying for the comparison.
const MAX_REPORTED_BYTES: u64 = 64 << 20;

/// Which paths git would track, cached per directory for one sink.
#[derive(Default)]
struct Tracked {
	/// The work tree above each directory asked about, with its shared
	/// rules; `None` outside any.
	trees: HashMap<PathBuf, Option<WorkTree>>,
	/// Each directory's own `.gitignore`; empty where there is none.
	local: HashMap<PathBuf, Gitignore>,
}

/// A checkout and the ignore rules that hold for all of it.
#[derive(Clone)]
struct WorkTree {
	root:   PathBuf,
	/// `info/exclude` and git's global excludes file, relative to `root`.
	shared: Gitignore,
}

impl WorkTree {
	fn above(dir: &Path) -> Option<Self> {
		let info = omp_vcs::git::discover_info(dir).ok()??;
		let mut shared = GitignoreBuilder::new(&info.repo_root);
		// A missing file adds no rule.
		shared.add(info.common_dir.join("info").join("exclude"));
		if let Some(global) = gitconfig_excludes_path() {
			shared.add(global);
		}
		Some(Self {
			shared: shared.build().unwrap_or_else(|_| Gitignore::empty()),
			root:   info.repo_root,
		})
	}
}

impl Tracked {
	/// Whether `path` names a file git would track: in a work tree, outside
	/// `.git`, and not ignored. The nearest `.gitignore` with a rule for the
	/// path decides, then the work tree's shared rules.
	fn holds(&mut self, path: &Path) -> bool {
		if path.components().any(|part| part.as_os_str() == ".git") {
			return false;
		}
		let Some(dir) = path.parent() else {
			return false;
		};
		let Some(tree) = self
			.trees
			.entry(dir.to_path_buf())
			.or_insert_with(|| WorkTree::above(dir))
			.clone()
		else {
			return false;
		};
		// Reached through a symlink: its rules cannot be matched by path.
		if !path.starts_with(&tree.root) {
			return true;
		}
		for dir in dir.ancestors() {
			let rules = self
				.local
				.entry(dir.to_path_buf())
				.or_insert_with(|| Gitignore::new(dir.join(".gitignore")).0);
			match rules.matched_path_or_any_parents(path, false) {
				Match::Ignore(_) => return false,
				Match::Whitelist(_) => return true,
				Match::None => {},
			}
			if dir == tree.root {
				break;
			}
		}
		!tree
			.shared
			.matched_path_or_any_parents(path, false)
			.is_ignore()
	}
}

/// Sends the changed files git would track to the host callback.
pub(super) struct FileChangeSink {
	handler:  ShellFileChangeHandler,
	tracked:  Mutex<Tracked>,
	/// Bytes of content sent so far, against [`MAX_REPORTED_BYTES`].
	reported: AtomicU64,
}

impl FileChangeSink {
	pub(super) fn new(handler: ShellFileChangeHandler) -> Self {
		Self { handler, tracked: Mutex::default(), reported: AtomicU64::new(0) }
	}
}

impl ChangeSink for FileChangeSink {
	fn wants(&self, path: &Path) -> bool {
		self.reported.load(Ordering::Relaxed) < MAX_REPORTED_BYTES && self.tracked.lock().holds(path)
	}

	fn changed(&self, path: PathBuf, before: Option<Vec<u8>>, after: Option<Vec<u8>>) {
		let Ok(path) = path.into_os_string().into_string() else {
			return;
		};
		let bytes = before.as_ref().map_or(0, Vec::len) + after.as_ref().map_or(0, Vec::len);
		self.reported.fetch_add(bytes as u64, Ordering::Relaxed);
		let change =
			ShellFileChange { path, before: before.map(Buffer::from), after: after.map(Buffer::from) };
		// Dropped when the callback's queue is closing: nothing is listening.
		let _ = self
			.handler
			.call(Ok(change), ThreadsafeFunctionCallMode::NonBlocking);
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn holds_only_what_git_would_track() {
		let outside = tempfile::tempdir().expect("temp dir");
		let repo = tempfile::tempdir().expect("temp dir");
		let root = repo.path();
		let write = |name: &str, content: &str| {
			let path = root.join(name);
			std::fs::create_dir_all(path.parent().expect("parent")).expect("directory");
			std::fs::write(path, content).expect("write");
		};
		write(".git/HEAD", "ref: refs/heads/main\n");
		write(".git/info/exclude", "scratch/\n");
		write(".gitignore", "build/\n*.out\n!kept.out\n");
		write("sub/.gitignore", "local.txt\n");
		std::fs::create_dir_all(root.join("build/deep")).expect("directory");
		std::fs::create_dir_all(root.join("scratch")).expect("directory");

		let mut tracked = Tracked::default();
		let held = [
			"src.rs",
			"sub/src.rs",
			"sub/new/later.rs",
			"kept.out",
			"build/deep/a.o",
			"run.out",
			"sub/local.txt",
			"scratch/notes.md",
			".git/config",
		]
		.map(|name| tracked.holds(&root.join(name)));

		assert_eq!(held, [true, true, true, true, false, false, false, false, false]);
		assert!(!tracked.holds(&outside.path().join("file.rs")));
	}
}
