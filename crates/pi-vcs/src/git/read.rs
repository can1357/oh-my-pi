//! Read-side operations on [`GitRepo`](super::GitRepo).

use std::{
	collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
	path::{Path, PathBuf},
};

use gix::bstr::ByteSlice;

use super::{
	GitRepo,
	cli::Capture,
	open::{load_index_or_empty, status_with_fresh_index},
};
use crate::{
	error::{Error, Result},
	types::{
		CommitAuthor, CommitDetails, HeadState, ShowResult, StatusOptions, StatusSummary,
		UntrackedMode, WorktreeEntry,
	},
};

/// Bytes retained from a porcelain capture that only has to answer "any change
/// at all?". One status entry is enough; a few KiB leaves room for long paths.
const DIRTY_PROBE_CAPTURE_LIMIT: usize = 4 * 1024;

impl GitRepo {
	/// Resolve the repository HEAD, preserving an unborn symbolic branch.
	pub fn head(&self) -> Result<HeadState> {
		if self.is_reftable() {
			let symbolic = cli_try(self.root(), &["symbolic-ref", "HEAD"])?;
			let commit = cli_try(self.root(), &["rev-parse", "--verify", "HEAD"])?;
			return Ok(match symbolic {
				Some(ref_name) => HeadState::Ref {
					branch: ref_name.strip_prefix("refs/heads/").map(str::to_owned),
					ref_name,
					commit,
				},
				None => HeadState::Detached { commit },
			});
		}
		let content = std::fs::read_to_string(&self.info().head_path)?;
		let value = content.trim();
		if let Some(ref_name) = value.strip_prefix("ref:").map(str::trim) {
			return Ok(HeadState::Ref {
				ref_name: ref_name.to_owned(),
				branch:   ref_name.strip_prefix("refs/heads/").map(str::to_owned),
				commit:   self.peel_symbolic(self.read_ref(ref_name)?)?,
			});
		}
		Ok(HeadState::Detached { commit: nonempty(value) })
	}

	/// Return the commit currently named by HEAD, if HEAD is born.
	pub fn head_sha(&self) -> Result<Option<String>> {
		Ok(self.head()?.commit().map(str::to_owned))
	}

	/// Return the checked-out local branch, or `None` for detached HEAD.
	pub fn current_branch(&self) -> Result<Option<String>> {
		Ok(match self.head()? {
			HeadState::Ref { ref_name, branch, .. } => Some(branch.unwrap_or(ref_name)),
			HeadState::Detached { .. } => None,
		})
	}

	/// Return the default branch advertised by origin or upstream.
	pub fn default_branch(&self) -> Result<Option<String>> {
		for remote in ["origin", "upstream"] {
			let name = format!("refs/remotes/{remote}/HEAD");
			let Some(value) = self.read_ref(&name)? else {
				continue;
			};
			let Some(target) = value.strip_prefix("ref:").map(str::trim) else {
				continue;
			};
			let prefix = format!("refs/remotes/{remote}/");
			if let Some(branch) = target.strip_prefix(&prefix).filter(|v| !v.is_empty()) {
				return Ok(Some(branch.to_owned()));
			}
		}
		Ok(None)
	}

	/// Resolve a ref name or revision expression to its object id.
	pub fn resolve_ref(&self, name: &str) -> Result<Option<String>> {
		if name == "HEAD" {
			return self.head_sha();
		}
		if self.is_reftable() {
			return cli_try(self.root(), &["rev-parse", "--verify", name]);
		}
		if name.starts_with("refs/") {
			return self
				.read_ref(name)
				.and_then(|value| self.peel_symbolic(value));
		}
		let repo = self.gix()?;
		match repo.rev_parse_single(name) {
			Ok(id) => Ok(Some(id.detach().to_string())),
			Err(_) => Ok(None),
		}
	}

	/// Abbreviate the object `rev` names to its shortest unambiguous id
	/// (honoring `core.abbrev`), as `git rev-parse --short` does.
	pub fn short_id(&self, rev: &str) -> Result<String> {
		if self.is_reftable() {
			return Ok(cli_text(self.root(), &["rev-parse", "--short", rev])?
				.trim()
				.to_owned());
		}
		let repo = self.gix()?;
		let id = repo
			.rev_parse_single(rev)
			.map_err(|err| Error::backend("git rev-parse", err))?;
		Ok(id
			.shorten()
			.map_err(|err| Error::backend("git rev-parse", err))?
			.to_string())
	}

	/// Test whether a ref or revision resolves.
	pub fn ref_exists(&self, name: &str) -> Result<bool> {
		Ok(self.resolve_ref(name)?.is_some())
	}

	/// List tags pointing at `rev`, peeled through annotated tags.
	pub fn tags_at(&self, rev: &str) -> Result<Vec<String>> {
		if self.is_reftable() {
			return cli_lines(self.root(), &[
				"for-each-ref",
				"--points-at",
				rev,
				"--sort=-version:refname",
				"--format=%(refname:strip=2)",
				"refs/tags",
			]);
		}
		let Some(target) = self.resolve_ref(rev)? else {
			return Ok(Vec::new());
		};
		let repo = self.gix()?;
		let refs = repo
			.references()
			.map_err(|err| Error::backend("git tags", err))?;
		let iter = refs.tags().map_err(|err| Error::backend("git tags", err))?;
		let mut tags = Vec::new();
		for reference in iter {
			let mut reference = reference.map_err(|err| Error::backend("git tags", err))?;
			let id = reference
				.peel_to_id()
				.map_err(|err| Error::backend("git tags", err))?;
			if id.to_string() == target
				&& let Some(name) = reference
					.name()
					.as_bstr()
					.to_str()
					.ok()
					.and_then(|n| n.strip_prefix("refs/tags/"))
			{
				tags.push(name.to_owned());
			}
		}
		version_sort_desc(&mut tags);
		Ok(tags)
	}

	/// List local branches, optionally including remote-tracking branches.
	pub fn list_branches(&self, all: bool) -> Result<Vec<String>> {
		if self.is_reftable() {
			let mut args = vec!["branch"];
			if all {
				args.push("-a");
			}
			args.push("--format=%(refname:short)");
			return cli_lines(self.root(), &args);
		}
		let repo = self.gix()?;
		let refs = repo
			.references()
			.map_err(|err| Error::backend("git branch", err))?;
		let iter = refs
			.all()
			.map_err(|err| Error::backend("git branch", err))?;
		let mut out = Vec::new();
		for reference in iter {
			let reference = reference.map_err(|err| Error::backend("git branch", err))?;
			let name = reference
				.name()
				.as_bstr()
				.to_str()
				.map_err(|err| Error::backend("git branch", err))?;
			if let Some(short) = name.strip_prefix("refs/heads/") {
				out.push(short.to_owned());
			} else if all && let Some(short) = name.strip_prefix("refs/remotes/") {
				out.push(format!("remotes/{short}"));
			}
		}
		out.sort();
		Ok(out)
	}

	/// Whether default porcelain status reports a staged, unstaged, or untracked
	/// change.
	///
	/// Runs the same subprocess as [`Self::status_porcelain`] rather than its
	/// own in-process walk: this is a whole-worktree status with no pathspec,
	/// the exact shape whose peak memory and worker-thread spawn failures
	/// belong out of process (see [`Self::status_porcelain`]). Measured on a
	/// clean 4 GiB worktree the subprocess is also faster than the in-process
	/// walk, which no longer gets to stop at the first change.
	///
	/// The answer is a boolean, so the capture is capped at the first entries
	/// and the rest of the output is dropped as it arrives — a worktree with
	/// 100k untracked paths cannot make this allocate megabytes to decide
	/// `true`.
	pub fn is_dirty(&self) -> Result<bool> {
		self
			.status_porcelain_capped(&StatusOptions::default(), DIRTY_PROBE_CAPTURE_LIMIT)
			.map(|status| !status.is_empty())
	}

	/// Whether a merge, rebase, cherry-pick, revert, or `am` is underway in
	/// this checkout: the index holds unmerged entries, or the operation's
	/// state files remain because it is resolved but not yet committed or
	/// aborted (a phase `git ls-files --unmerged` no longer reports). A rebase
	/// is underway while its state directory exists; git leaves `REBASE_HEAD`
	/// behind after one finishes.
	pub fn operation_in_progress(&self) -> Result<bool> {
		const STATE: [&str; 5] =
			["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply"];
		if STATE
			.iter()
			.any(|name| self.info.git_dir.join(name).exists())
		{
			return Ok(true);
		}
		if self.is_reftable() {
			return Ok(!cli_text(self.root(), &["ls-files", "--unmerged"])?.is_empty());
		}
		let repo = self.gix()?;
		let index = load_index_or_empty(&repo, "git ls-files")?;
		Ok(index
			.entries()
			.iter()
			.any(|entry| entry.stage() != gix::index::entry::Stage::Unconflicted))
	}

	/// Render git status in porcelain-v1 form.
	///
	/// Prefers the git CLI: whole-worktree status is the one read whose peak
	/// memory scales with worktree pathology. Tens of thousands of untracked
	/// files drove gitoxide's parallel walk into the Windows commit limit
	/// (os error 1455, `ERROR_COMMITMENT_LIMIT`), which panics in gix's
	/// worker-thread spawn (`.expect("valid name")`) and pins gigabytes of
	/// committed memory until process exit. A subprocess bounds that blast
	/// radius: its memory returns to the OS when it exits and failure is an
	/// exit code, not a panic. Hosts without a git binary — and checkouts git
	/// refuses under its `safe.directory` ownership check, which gitoxide opens
	/// with `Trust::Full` regardless — fall back to the in-process walk (never
	/// for reftable repos, which are unreadable in-process).
	pub fn status_porcelain(&self, options: &StatusOptions) -> Result<String> {
		self.status_porcelain_capped(options, super::cli::OUTPUT_LIMIT_BYTES)
	}

	/// [`Self::status_porcelain`] with an explicit retention cap for the
	/// subprocess capture. The in-process fallback ignores the cap: it builds
	/// the rendering itself and has nothing to drain.
	fn status_porcelain_capped(&self, options: &StatusOptions, limit: usize) -> Result<String> {
		let mut args = vec!["status".to_owned(), "--porcelain".to_owned()];
		args.push(match options.untracked {
			UntrackedMode::No => "--untracked-files=no".to_owned(),
			UntrackedMode::Normal => "--untracked-files=normal".to_owned(),
			UntrackedMode::All => "--untracked-files=all".to_owned(),
		});
		if options.nul_terminated {
			args.push("-z".to_owned());
		}
		if !options.pathspecs.is_empty() {
			args.push("--".to_owned());
			args.extend(options.pathspecs.iter().cloned());
		}
		match cli_text_owned_capped(self.root(), &args, super::cli::COMMAND_TIMEOUT, limit) {
			Err(err) if !self.is_reftable() && super::cli::prefers_in_process(&err) => {
				self.status_porcelain_gix(options)
			},
			result => result,
		}
	}

	/// In-process porcelain rendering via gitoxide; fallback for hosts
	/// without a git binary. Must stay byte-identical to `git status
	/// --porcelain` — the oracle test compares both against the real CLI.
	fn status_porcelain_gix(&self, options: &StatusOptions) -> Result<String> {
		let repo = self.gix()?;
		let untracked = match options.untracked {
			UntrackedMode::No => gix::status::UntrackedFiles::None,
			UntrackedMode::Normal => gix::status::UntrackedFiles::Collapsed,
			UntrackedMode::All => gix::status::UntrackedFiles::Files,
		};
		let platform = status_with_fresh_index(&repo, "git status")?.untracked_files(untracked);
		let iter = platform
			.into_iter(options.pathspecs.iter().map(|path| path.as_bytes().into()))
			.map_err(|err| Error::backend("git status", err))?;
		let mut states: BTreeMap<String, (char, char, Option<String>)> = BTreeMap::new();
		// git emits tracked changes first, then untracked entries, each block
		// sorted by path — not one merged sort.
		let mut untracked_paths: std::collections::BTreeSet<String> =
			std::collections::BTreeSet::new();
		for item in iter {
			let item = item.map_err(|err| Error::backend("git status", err))?;
			use gix::status::{Item, index_worktree};
			match item {
				Item::TreeIndex(change) => {
					use gix::diff::index::ChangeRef;
					match change {
						ChangeRef::Addition { location, .. } => {
							set_index(&mut states, &location, 'A', None);
						},
						ChangeRef::Deletion { location, .. } => {
							set_index(&mut states, &location, 'D', None);
						},
						ChangeRef::Modification { location, .. } => {
							set_index(&mut states, &location, 'M', None);
						},
						ChangeRef::Rewrite { source_location, location, copy, .. } => {
							set_index(
								&mut states,
								&location,
								if copy { 'C' } else { 'R' },
								Some(bytes_to_path(&source_location)),
							);
						},
					}
				},
				Item::IndexWorktree(change) => match change {
					index_worktree::Item::Modification { rela_path, status, .. } => {
						use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
						let code = match status {
							EntryStatus::Conflict { .. } => 'U',
							EntryStatus::Change(Change::Removed) => 'D',
							EntryStatus::Change(Change::Type { .. }) => 'T',
							EntryStatus::Change(
								Change::Modification { .. } | Change::SubmoduleModification(_),
							) => 'M',
							// git reports `git add -N` entries as worktree-side
							// additions (` A`); the index side stays clean.
							EntryStatus::IntentToAdd => 'A',
							EntryStatus::NeedsUpdate(_) => continue,
						};
						set_worktree(&mut states, rela_path.as_bstr(), code);
					},
					index_worktree::Item::DirectoryContents { entry, .. }
						if entry.status == gix::dir::entry::Status::Untracked =>
					{
						let mut path = bytes_to_path(entry.rela_path.as_bstr());
						// A collapsed untracked directory renders with a
						// trailing slash (`?? newdir/`).
						if entry.disk_kind == Some(gix::dir::entry::Kind::Directory) {
							// git only lists an untracked directory when at
							// least one file exists beneath it; a tree of
							// empty directories is invisible to status.
							if !dir_contains_file(&self.info().repo_root.join(&path)) {
								continue;
							}
							path.push('/');
						}
						untracked_paths.insert(path);
					},
					index_worktree::Item::Rewrite { source, dirwalk_entry, copy, .. } => {
						let old = match source {
							index_worktree::RewriteSource::RewriteFromIndex {
								source_rela_path, ..
							} => bytes_to_path(source_rela_path.as_bstr()),
							index_worktree::RewriteSource::CopyFromDirectoryEntry {
								source_dirwalk_entry,
								..
							} => bytes_to_path(source_dirwalk_entry.rela_path.as_bstr()),
						};
						let new = bytes_to_path(dirwalk_entry.rela_path.as_bstr());
						states.insert(new, (' ', if copy { 'C' } else { 'R' }, Some(old)));
					},
					_ => {},
				},
			}
		}
		let separator = if options.nul_terminated { '\0' } else { '\n' };
		let mut out = String::new();
		for (path, (x, y, old)) in states.into_iter().chain(
			untracked_paths
				.into_iter()
				.map(|path| (path, ('?', '?', None))),
		) {
			out.push(x);
			out.push(y);
			out.push(' ');
			if options.nul_terminated {
				out.push_str(&path);
				out.push(separator);
				if let Some(old) = old {
					out.push_str(&old);
					out.push(separator);
				}
			} else {
				if let Some(old) = old {
					out.push_str(&quote_path(&old));
					out.push_str(" -> ");
				}
				out.push_str(&quote_path(&path));
				out.push(separator);
			}
		}
		Ok(out)
	}

	/// Count staged, unstaged, and untracked status entries.
	pub fn status_summary(&self) -> Result<StatusSummary> {
		let text = self.status_porcelain(&StatusOptions {
			untracked: UntrackedMode::Normal,
			..Default::default()
		})?;
		let mut summary = StatusSummary::default();
		for line in text.lines().filter(|line| line.len() >= 2) {
			let bytes = line.as_bytes();
			if bytes[0] == b'?' && bytes[1] == b'?' {
				summary.untracked += 1;
			} else {
				if bytes[0] != b' ' {
					summary.staged += 1;
				}
				if bytes[1] != b' ' {
					summary.unstaged += 1;
				}
			}
		}
		Ok(summary)
	}

	/// Read a scalar git config value.
	pub fn config_get(&self, key: &str) -> Result<Option<String>> {
		if self.is_reftable() {
			return cli_try(self.root(), &["config", "--get", key]);
		}
		let repo = self.gix_fresh()?;
		Ok(repo
			.config_snapshot()
			.string(key)
			.and_then(|v| nonempty(v.to_str_lossy().trim())))
	}

	/// List configured remote names.
	pub fn remote_list(&self) -> Result<Vec<String>> {
		if self.is_reftable() {
			return cli_lines(self.root(), &["remote"]);
		}
		let repo = self.gix_fresh()?;
		let mut names = BTreeSet::new();
		for section in repo
			.config_snapshot()
			.sections_by_name("remote")
			.into_iter()
			.flatten()
		{
			if let Some(name) = section
				.header()
				.subsection_name()
				.and_then(|v| v.to_str().ok())
			{
				names.insert(name.to_owned());
			}
		}
		Ok(names.into_iter().collect())
	}

	/// Return a remote's fetch URL.
	pub fn remote_url(&self, name: &str) -> Result<Option<String>> {
		if self.is_reftable() {
			return cli_try(self.root(), &["remote", "get-url", name]);
		}
		let repo = self.gix_fresh()?;
		let Some(remote) = repo.try_find_remote(name.as_bytes().as_bstr()) else {
			return Ok(None);
		};
		let remote = remote.map_err(|err| Error::backend("git remote", err))?;
		Ok(remote
			.url(gix::remote::Direction::Fetch)
			.map(|url| url.to_bstring().to_str_lossy().into_owned()))
	}

	/// List the primary and linked worktrees.
	pub fn worktrees(&self) -> Result<Vec<WorktreeEntry>> {
		if self.is_reftable() {
			return Ok(parse_worktree_cli(&cli_text(self.root(), &[
				"worktree",
				"list",
				"--porcelain",
			])?));
		}
		let primary_root = self
			.info()
			.common_dir
			.parent()
			.filter(|_| {
				self
					.info()
					.common_dir
					.file_name()
					.is_some_and(|name| name == ".git")
			})
			.unwrap_or_else(|| self.root())
			.to_owned();
		let primary_head =
			parse_head_with_refs(&self.info().common_dir.join("HEAD"), &self.info().common_dir)?;
		let mut out = vec![entry_from_head(primary_root, &primary_head)];
		let admin_root = self.info().common_dir.join("worktrees");
		let Ok(admins) = std::fs::read_dir(admin_root) else {
			return Ok(out);
		};
		let mut admins: Vec<_> = admins.filter_map(std::result::Result::ok).collect();
		admins.sort_by_key(std::fs::DirEntry::file_name);
		for admin in admins {
			let dir = admin.path();
			let Ok(pointer) = std::fs::read_to_string(dir.join("gitdir")) else {
				continue;
			};
			let dotgit = PathBuf::from(pointer.trim());
			let Some(root) = dotgit.parent().map(Path::to_owned) else {
				continue;
			};
			let head = parse_head_with_refs(&dir.join("HEAD"), &self.info().common_dir)?;
			out.push(entry_from_head(root, &head));
		}
		Ok(out)
	}

	/// Return recent commit subjects, newest first.
	pub fn log_subjects(&self, count: usize) -> Result<Vec<String>> {
		if self.is_reftable() {
			return cli_lines(self.root(), &["log", &format!("-n{count}"), "--pretty=format:%s"]);
		}
		let repo = self.gix()?;
		let mut out = Vec::new();
		for id in self.walk_commit_ids("HEAD", count)? {
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git log", err))?;
			out.push(commit_subject(&commit).map_err(|err| Error::backend("git log", err))?);
		}
		Ok(out)
	}

	/// Return each stash entry's commit subject, `stash@{0}` first: git's
	/// `WIP on <branch>: …` or `On <branch>: <message>`.
	pub fn stash_subjects(&self) -> Result<Vec<String>> {
		if !self.ref_exists("refs/stash")? {
			return Ok(Vec::new());
		}
		Ok(cli_text(self.root(), &["log", "--walk-reflogs", "--format=%s", "refs/stash"])?
			.lines()
			.map(str::to_owned)
			.collect())
	}

	/// Return recent commits as `<short-sha> <subject>` lines.
	pub fn log_onelines(&self, count: usize) -> Result<Vec<String>> {
		if self.is_reftable() {
			return cli_lines(self.root(), &[
				"log",
				&format!("-{count}"),
				"--oneline",
				"--no-decorate",
			]);
		}
		let mut out = Vec::new();
		let repo = self.gix()?;
		for id in self.walk_commit_ids("HEAD", count)? {
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git log", err))?;
			let short = commit
				.short_id()
				.map_err(|err| Error::backend("git log", err))?;
			out.push(format!(
				"{} {}",
				short,
				commit_subject(&commit).map_err(|err| Error::backend("git log", err))?
			));
		}
		Ok(out)
	}

	/// List commits in `base..head`, oldest first.
	pub fn rev_list_range(&self, base: &str, head: &str) -> Result<Vec<String>> {
		if self.is_reftable() {
			return cli_lines(self.root(), &["rev-list", "--reverse", &format!("{base}..{head}")]);
		}
		let repo = self.gix()?;
		let base_id = repo
			.rev_parse_single(base)
			.map_err(|err| Error::backend("git rev-list", err))?
			.detach();
		let head_id = repo
			.rev_parse_single(head)
			.map_err(|err| Error::backend("git rev-list", err))?
			.detach();
		let walk = repo
			.rev_walk([head_id])
			.with_hidden([base_id])
			.sorting(gix::revision::walk::Sorting::ByCommitTime(
				gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
			))
			.all()
			.map_err(|err| Error::backend("git rev-list", err))?;
		let mut out = walk
			.map(|r| {
				r.map(|i| i.id.to_string())
					.map_err(|e| Error::backend("git rev-list", e))
			})
			.collect::<Result<Vec<_>>>()?;
		out.reverse();
		Ok(out)
	}

	/// Return the best common ancestor of `a` and `b` (`git merge-base a b`),
	/// or `None` when their histories are unrelated. Used for PR-style diffs,
	/// which compare the merge base against the head rather than the two tips.
	pub fn merge_base(&self, a: &str, b: &str) -> Result<Option<String>> {
		if self.is_reftable() {
			// `git merge-base` exits 1 for unrelated histories but 128 for fatal
			// failures (missing ref, corrupt object); only the former is `None`.
			let args = ["merge-base".to_owned(), a.to_owned(), b.to_owned()];
			let out = super::cli::run_sync(self.root(), &args, super::cli::SYNC_TIMEOUT)?;
			return match out.exit_code {
				0 => Ok(nonempty(out.stdout.trim())),
				1 => Ok(None),
				_ => out.into_checked(&args).map(|_| None),
			};
		}
		let repo = self.gix()?;
		let a_id = repo
			.rev_parse_single(a)
			.map_err(|err| Error::backend("git merge-base", err))?
			.detach();
		let b_id = repo
			.rev_parse_single(b)
			.map_err(|err| Error::backend("git merge-base", err))?
			.detach();
		match repo.merge_base(a_id, b_id) {
			Ok(id) => Ok(Some(id.detach().to_string())),
			Err(gix::repository::merge_base::Error::NotFound { .. }) => Ok(None),
			Err(err) => Err(Error::backend("git merge-base", err)),
		}
	}

	/// List commits touching `file`, newest first.
	pub fn rev_list_touching(&self, rev: &str, file: &str, limit: usize) -> Result<Vec<String>> {
		if self.is_reftable() {
			return cli_lines(self.root(), &[
				"rev-list",
				&format!("--max-count={limit}"),
				rev,
				"--",
				file,
			]);
		}
		let mut out = Vec::new();
		let repo = self.gix()?;
		for id in self.walk_commit_ids(rev, usize::MAX)? {
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git rev-list", err))?;
			let current = tree_entry_id(
				&commit
					.tree()
					.map_err(|e| Error::backend("git rev-list", e))?,
				file,
			)?;
			let parent = match commit.parent_ids().next() {
				Some(id) => tree_entry_id(
					&id.object()
						.map_err(|e| Error::backend("git rev-list", e))?
						.into_commit()
						.tree()
						.map_err(|e| Error::backend("git rev-list", e))?,
					file,
				)?,
				None => None,
			};
			if current != parent {
				out.push(id.to_string());
				if out.len() == limit {
					break;
				}
			}
		}
		Ok(out)
	}

	/// Read commit identity, parent ids, author, date, and full message.
	pub fn commit_details(&self, rev: &str) -> Result<CommitDetails> {
		if self.is_reftable() {
			let raw = cli_text(self.root(), &[
				"show",
				"-s",
				"--format=%H%x00%P%x00%an%x00%ae%x00%aI%x00%B",
				rev,
			])?;
			return Ok(parse_commit_details(&raw));
		}
		let repo = self.gix()?;
		let id = repo
			.rev_parse_single(rev)
			.map_err(|err| Error::backend("git show", err))?;
		let commit = id
			.object()
			.map_err(|err| Error::backend("git show", err))?
			.peel_to_commit()
			.map_err(|err| Error::backend("git show", err))?;
		let author = commit
			.author()
			.map_err(|err| Error::backend("git show", err))?;
		let date = author
			.time()
			.map_err(|err| Error::backend("git show", err))?
			.format(gix::date::time::format::ISO8601_STRICT)
			.map_err(|err| Error::backend("git show", err))?;
		let raw_message = commit
			.message_raw()
			.map_err(|err| Error::backend("git show", err))?
			.to_str_lossy();
		let message = raw_message
			.strip_suffix('\n')
			.unwrap_or_else(|| raw_message.as_ref())
			.to_owned();
		Ok(CommitDetails {
			sha: commit.id.to_string(),
			parents: commit
				.parent_ids()
				.map(|parent| parent.detach().to_string())
				.collect(),
			author: CommitAuthor {
				name:  author.name.to_str_lossy().into_owned(),
				email: author.email.to_str_lossy().into_owned(),
				date:  Some(date),
			},
			message,
		})
	}

	/// List index paths, or untracked paths when `others` is true.
	pub fn ls_files(&self, others: bool, exclude_standard: bool) -> Result<Vec<String>> {
		Ok(self
			.ls_files_at_paths(others, exclude_standard, &BTreeSet::new())?
			.0)
	}

	/// [`Self::ls_files`], with the directories git reported it could not read.
	///
	/// Empty when git walked everything, or when the in-process walk answered
	/// (it reaches what it can open and fails otherwise, rather than warning).
	/// An error when git may have reported a directory this cannot name: its
	/// stderr outgrew the capture, and the cut may have taken one of those
	/// reports; the capture stopped before git's stderr ended (a failed read,
	/// or a reader thread that could not start or panicked); or a report is
	/// there with no readable name. Either way the listing's completeness is
	/// unknown.
	pub fn ls_files_with_warnings(
		&self,
		others: bool,
		exclude_standard: bool,
	) -> Result<(Vec<String>, Vec<String>)> {
		let (paths, warnings) = self.ls_files_at_paths(others, exclude_standard, &BTreeSet::new())?;
		Ok((paths, unreadable_directories(&warnings)?))
	}

	/// Untracked listing (`others`) is a whole-worktree walk, the same shape
	/// [`Self::status_porcelain`] moved into a subprocess so its peak memory and
	/// worker-thread spawn failures stay outside this process. The in-process
	/// gitoxide walk below covers the three cases the subprocess cannot: no git
	/// binary, a checkout git refuses under its `safe.directory` ownership check
	/// that gitoxide opens with `Trust::Full`, and output too large to capture.
	/// Tracked listing is a bounded index read and stays in-process (reftable
	/// repos excepted: unreadable in-process).
	/// `-z` keeps paths raw — the newline form quotes non-ASCII names, which the
	/// gitoxide path does not.
	pub(crate) fn ls_files_at_paths(
		&self,
		others: bool,
		exclude_standard: bool,
		paths: &BTreeSet<String>,
	) -> Result<(Vec<String>, Capture)> {
		if self.is_reftable() || others {
			let mut args = vec!["ls-files".to_owned(), "-z".to_owned()];
			if others {
				args.push("--others".to_owned());
			}
			if exclude_standard {
				args.push("--exclude-standard".to_owned());
			}
			if !paths.is_empty() {
				args.push("--".to_owned());
				args.extend(paths.iter().map(|path| literal_pathspec(path)));
			}
			// A whole-worktree walk legitimately outlives the interactive
			// deadline; the index read does not.
			let timeout = if others {
				super::cli::COMMAND_TIMEOUT
			} else {
				super::cli::SYNC_TIMEOUT
			};
			match cli_text_and_warnings_capped(self.root(), &args, timeout, path_list_capture_limit())
			{
				// The subprocess capture is capped, and this output is the
				// return value rather than a diagnostic: a list cut at the cap,
				// or one whose capture stopped early, would silently hide
				// paths, so re-run the walk in-process. Reftable repos cannot
				// be walked in-process, so they fail.
				Ok((stdout, _)) if super::cli::is_truncated(&stdout.text) || stdout.loss.is_some() => {
					if self.is_reftable() {
						let reason = stdout.loss.map_or_else(
							|| "path list exceeded the subprocess capture limit".to_owned(),
							|loss| format!("path list was not captured whole: {loss}"),
						);
						return Err(Error::backend("git ls-files", reason));
					}
				},
				Ok((stdout, warnings)) => {
					return Ok((
						stdout
							.text
							.split('\0')
							.filter(|path| !path.is_empty())
							.map(str::to_owned)
							.collect(),
						warnings,
					));
				},
				Err(err) if self.is_reftable() || !super::cli::prefers_in_process(&err) => {
					return Err(err);
				},
				Err(_) => {},
			}
		}
		if !others {
			let repo = self.gix()?;
			let index = load_index_or_empty(&repo, "git ls-files")?;
			let mut out: Vec<_> = index
				.entries()
				.iter()
				.filter(|e| e.stage() == gix::index::entry::Stage::Unconflicted)
				.map(|e| bytes_to_path(e.path(&index)))
				.filter(|path| {
					paths.is_empty() || paths.iter().any(|wanted| path_matches(path, wanted))
				})
				.collect();
			out.sort();
			out.dedup();
			return Ok((out, Capture::default()));
		}
		let repo = self.gix()?;
		let mut platform = status_with_fresh_index(&repo, "git ls-files")?
			.untracked_files(gix::status::UntrackedFiles::Files);
		if !exclude_standard {
			platform = platform.dirwalk_options(|opts| {
				opts.emit_ignored(Some(gix::dir::walk::EmissionMode::Matching))
			});
		}
		let iter = platform
			.into_index_worktree_iter(
				paths
					.iter()
					.map(|path| literal_pathspec(path).into_bytes().into()),
			)
			.map_err(|e| Error::backend("git ls-files", e))?;
		let mut out = Vec::new();
		for item in iter {
			if let gix::status::index_worktree::Item::DirectoryContents { entry, .. } =
				item.map_err(|e| Error::backend("git ls-files", e))?
			{
				let wanted = entry.status == gix::dir::entry::Status::Untracked
					|| (!exclude_standard
						&& matches!(entry.status, gix::dir::entry::Status::Ignored(_)));
				if wanted {
					out.push(bytes_to_path(entry.rela_path.as_bstr()));
				}
			}
		}
		out.sort();
		// The in-process walk reaches what it can open and fails otherwise, so
		// it has no warnings to report.
		Ok((out, Capture::default()))
	}

	/// List recursive blob paths in a tree, optionally filtered by pathspec-like
	/// prefixes.
	pub fn ls_tree(&self, rev: &str, paths: &[String]) -> Result<Vec<String>> {
		if self.is_reftable() {
			let mut owned = vec![
				"ls-tree".to_owned(),
				"--name-only".to_owned(),
				"-r".to_owned(),
				"-z".to_owned(),
				rev.to_owned(),
			];
			if !paths.is_empty() {
				owned.push("--".to_owned());
				owned.extend(paths.iter().cloned());
			}
			return Ok(cli_text_owned(self.root(), &owned, super::cli::SYNC_TIMEOUT)?
				.split('\0')
				.filter(|s| !s.is_empty())
				.map(str::to_owned)
				.collect());
		}
		let repo = self.gix()?;
		let tree = repo
			.rev_parse_single(rev)
			.map_err(|e| Error::backend("git ls-tree", e))?
			.object()
			.map_err(|e| Error::backend("git ls-tree", e))?
			.peel_to_tree()
			.map_err(|e| Error::backend("git ls-tree", e))?;
		let mut out: Vec<_> = tree
			.traverse()
			.breadthfirst
			.files()
			.map_err(|e| Error::backend("git ls-tree", e))?
			.into_iter()
			.filter(|e| e.mode.is_blob() || e.mode.is_link())
			.map(|e| bytes_to_path(e.filepath.as_bstr()))
			.filter(|p| paths.is_empty() || paths.iter().any(|wanted| path_matches(p, wanted)))
			.collect();
		out.sort();
		Ok(out)
	}

	/// List checked-out submodule paths recursively.
	pub fn submodule_paths(&self) -> Result<Vec<String>> {
		let mut out = Vec::new();
		let mut queue = VecDeque::from([(self.root().to_owned(), String::new())]);
		while let Some((root, prefix)) = queue.pop_front() {
			for path in parse_gitmodules(&root.join(".gitmodules")) {
				let full = root.join(&path);
				if !full.join(".git").exists() {
					continue;
				}
				let joined = if prefix.is_empty() {
					path
				} else {
					format!("{prefix}/{path}")
				};
				out.push(joined.clone());
				queue.push_back((full, joined));
			}
		}
		Ok(out)
	}

	/// Read an object or `rev:path` blob, with an optional byte cap.
	pub fn show_blob(&self, spec: &str, max_bytes: Option<usize>) -> Result<ShowResult> {
		if self.is_reftable() {
			let text = cli_text(self.root(), &["show", spec])?;
			return Ok(cap_bytes(text.into_bytes(), max_bytes));
		}
		let repo = self.gix()?;
		let id = repo
			.rev_parse_single(spec)
			.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
		let object = id
			.object()
			.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
		Ok(cap_bytes(
			{
				let mut blob = object
					.try_into_blob()
					.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
				blob.take_data()
			},
			max_bytes,
		))
	}

	/// Resolve Git LFS's local object directory.
	pub fn lfs_media_dir(&self) -> Result<Option<PathBuf>> {
		let base = self.info().common_dir.clone();
		Ok(Some(match self.config_get("lfs.storage")? {
			Some(value) => {
				let path = PathBuf::from(value);
				if path.is_absolute() {
					path
				} else {
					base.join(path)
				}
			},
			None => base.join("lfs").join("objects"),
		}))
	}

	/// Return the filesystem target whose metadata changes when HEAD moves.
	pub fn head_watch_target(&self) -> PathBuf {
		if self.is_reftable() {
			self.info().git_dir.join("reftable")
		} else {
			self.info().head_path.clone()
		}
	}

	fn read_ref(&self, name: &str) -> Result<Option<String>> {
		if !valid_ref_path(name) {
			return Ok(None);
		}
		if self.is_reftable() {
			if let Some(target) = cli_try(self.root(), &["symbolic-ref", name])? {
				return Ok(Some(format!("ref: {target}")));
			}
			return cli_try(self.root(), &["rev-parse", "--verify", name]);
		}
		for dir in [&self.info().git_dir, &self.info().common_dir] {
			if let Ok(value) = std::fs::read_to_string(dir.join(name))
				&& let Some(value) = nonempty(value.trim())
			{
				return Ok(Some(value));
			}
		}
		for dir in [&self.info().git_dir, &self.info().common_dir] {
			let Ok(content) = std::fs::read_to_string(dir.join("packed-refs")) else {
				continue;
			};
			for line in content
				.lines()
				.map(str::trim)
				.filter(|line| !line.is_empty() && !line.starts_with(['#', '^']))
			{
				if let Some((sha, ref_name)) = line.split_once(' ')
					&& ref_name == name
				{
					return Ok(Some(sha.to_owned()));
				}
			}
		}
		Ok(None)
	}

	fn peel_symbolic(&self, value: Option<String>) -> Result<Option<String>> {
		let mut value = value;
		let mut seen = HashSet::new();
		while let Some(current) = value {
			let Some(target) = current.strip_prefix("ref:").map(str::trim) else {
				return Ok(Some(current));
			};
			if !seen.insert(target.to_owned()) {
				return Ok(None);
			}
			value = self.read_ref(target)?;
		}
		Ok(None)
	}

	/// The first `limit` commits reachable from `rev`, newest first. Like
	/// `git log -n<limit>`, the walk stops there, so older history is never
	/// read.
	fn walk_commit_ids(&self, rev: &str, limit: usize) -> Result<Vec<gix::ObjectId>> {
		let repo = self.gix()?;
		let id = repo
			.rev_parse_single(rev)
			.map_err(|err| Error::backend("git rev-list", err))?
			.detach();
		repo
			.rev_walk([id])
			.sorting(gix::revision::walk::Sorting::ByCommitTime(
				gix::traverse::commit::simple::CommitTimeOrder::NewestFirst,
			))
			.all()
			.map_err(|err| Error::backend("git rev-list", err))?
			.take(limit)
			.map(|item| {
				item
					.map(|info| info.id)
					.map_err(|err| Error::backend("git rev-list", err))
			})
			.collect()
	}
}

fn nonempty(value: &str) -> Option<String> {
	(!value.is_empty()).then(|| value.to_owned())
}
fn valid_ref_path(name: &str) -> bool {
	!name.is_empty()
		&& !name.starts_with('/')
		&& !name.contains('\\')
		&& name
			.split('/')
			.all(|component| !matches!(component, "" | "." | ".."))
}
fn bytes_to_path(value: &gix::bstr::BStr) -> String {
	value.to_str_lossy().into_owned()
}

/// Whether any regular file (or symlink) exists beneath `dir`. git omits
/// untracked directories that hold nothing but empty directories.
fn dir_contains_file(dir: &Path) -> bool {
	let Ok(entries) = std::fs::read_dir(dir) else {
		return false;
	};
	for entry in entries.flatten() {
		match entry.file_type() {
			Ok(kind) if kind.is_dir() => {
				if dir_contains_file(&entry.path()) {
					return true;
				}
			},
			Ok(_) => return true,
			Err(_) => {},
		}
	}
	false
}
fn set_index(
	states: &mut BTreeMap<String, (char, char, Option<String>)>,
	path: &gix::bstr::BStr,
	code: char,
	old: Option<String>,
) {
	states
		.entry(bytes_to_path(path))
		.and_modify(|s| {
			s.0 = code;
			s.2.clone_from(&old);
		})
		.or_insert((code, ' ', old));
}
fn set_worktree(
	states: &mut BTreeMap<String, (char, char, Option<String>)>,
	path: &gix::bstr::BStr,
	code: char,
) {
	states
		.entry(bytes_to_path(path))
		.and_modify(|s| s.1 = code)
		.or_insert((' ', code, None));
}

fn cli_try(cwd: &Path, args: &[&str]) -> Result<Option<String>> {
	let owned: Vec<_> = args.iter().map(|v| (*v).to_owned()).collect();
	let out = super::cli::run_sync(cwd, &owned, super::cli::SYNC_TIMEOUT)?;
	if out.exit_code != 0 {
		return Ok(None);
	}
	Ok(nonempty(out.stdout.trim()))
}
fn cli_text(cwd: &Path, args: &[&str]) -> Result<String> {
	let owned: Vec<_> = args.iter().map(|v| (*v).to_owned()).collect();
	cli_text_owned(cwd, &owned, super::cli::SYNC_TIMEOUT)
}
fn cli_text_owned(cwd: &Path, args: &[String], timeout: std::time::Duration) -> Result<String> {
	Ok(super::cli::run_sync(cwd, args, timeout)?
		.into_checked(args)?
		.stdout)
}

/// [`cli_text_owned`] with an explicit retention cap, for reads whose output is
/// the return value rather than a diagnostic.
fn cli_text_owned_capped(
	cwd: &Path,
	args: &[String],
	timeout: std::time::Duration,
	limit: usize,
) -> Result<String> {
	Ok(cli_text_and_warnings_capped(cwd, args, timeout, limit)?
		.0
		.text)
}

/// [`cli_text_owned_capped`], keeping what the command said on stderr, and
/// keeping for each stream why its capture stopped early, if it did.
///
/// `git ls-files --others` reports a directory it could not open as a warning
/// and exits 0, so the listing alone cannot say whether it is complete. The
/// warning is the only record of what git did not look at, and a caller that
/// deletes a workspace on the strength of that listing needs it. It is
/// parseable because this module runs git with `LC_MESSAGES=C`.
fn cli_text_and_warnings_capped(
	cwd: &Path,
	args: &[String],
	timeout: std::time::Duration,
	limit: usize,
) -> Result<(Capture, Capture)> {
	let output = super::cli::run_sync_capped(cwd, args, timeout, limit)?;
	let warnings = Capture { text: output.stderr.clone(), loss: output.stderr_loss.clone() };
	let output = output.into_checked(args)?;
	Ok((Capture { text: output.stdout, loss: output.stdout_loss }, warnings))
}

/// The opening of git's report of a directory it could not open. The path
/// follows raw, then `': ` and the reason.
const COULD_NOT_OPEN: &str = "warning: could not open directory '";

/// The directories a `git ls-files` run reported it could not open.
///
/// The listing silently lacks every such directory, so this answer fails
/// closed whenever git may have reported one it cannot name: when the capture
/// stopped before git's stderr ended, or cut it at the limit (the report may
/// be in the part that never arrived), and when a report is present but no
/// directory can be read out of it. Everything else on stderr is skipped,
/// because it is not a report of an unread directory: traces, anything a hook
/// printed, and access warnings for single files git still walked past (an
/// unreadable `.gitignore` warns, and its subtree is still listed). Refusing
/// on those refused healthy captures. The form is fixed because this module
/// forces `LC_MESSAGES=C`.
fn unreadable_directories(warnings: &Capture) -> Result<Vec<String>> {
	if let Some(loss) = &warnings.loss {
		return Err(Error::backend(
			"git ls-files",
			format!(
				"its warnings were not captured whole ({loss}), so the directories it could not open \
				 are unknown"
			),
		));
	}
	let stderr = warnings.text.as_str();
	if super::cli::is_truncated(stderr) {
		return Err(Error::backend(
			"git ls-files",
			"its warnings exceeded the subprocess capture limit, so the directories it could not \
			 open are unknown",
		));
	}
	let mut out = Vec::new();
	// git ends each report with a newline, so every report opens a line.
	let mut rest = stderr;
	while !rest.is_empty() {
		let Some(record) = rest.strip_prefix(COULD_NOT_OPEN) else {
			rest = rest.split_once('\n').map_or("", |(_, next)| next);
			continue;
		};
		let Some((name, next)) = could_not_open_record(record) else {
			return Err(Error::backend(
				"git ls-files",
				"it reported a directory it could not open without a readable name, so the \
				 directories it could not open are unknown",
			));
		};
		out.push(name.to_owned());
		rest = next;
	}
	out.sort();
	out.dedup();
	Ok(out)
}

/// The directory one `could not open directory` report names, and the stderr
/// that follows the report; `None` when no directory can be read out of it.
///
/// git writes the path raw, so a newline in a directory name is a newline in
/// the report, and a report can span lines. It ends at the first line end
/// where the text so far reads as `<path>': <reason>`. A line that opens the
/// next report ends the search: git cut this one short (it caps a report at
/// 4 KiB, which a path past `PATH_MAX` reaches), and its name is lost.
///
/// A name holding `/': ` and then a newline reads as a shorter name, since
/// the report itself cannot tell the two apart. It is still a name, so the
/// listing is still not taken as complete.
fn could_not_open_record(record: &str) -> Option<(&str, &str)> {
	let mut line_start = 0;
	loop {
		let line_end = record[line_start..]
			.find('\n')
			.map_or(record.len(), |at| line_start + at);
		if let Some(name) = could_not_open_name(&record[..line_end]) {
			return Some((name, record.get(line_end + 1..).unwrap_or_default()));
		}
		line_start = line_end + 1;
		if line_start >= record.len() || record[line_start..].starts_with(COULD_NOT_OPEN) {
			return None;
		}
	}
}

/// The directory in `text` when it reads as a whole report body:
/// `<path>': <reason>`. git opens `.` for the top of the tree and `<dir>/`
/// for anything below it, and the reason is the C locale's strerror text: one
/// line holding no `'`. The last `': ` closes the path, since a name may hold
/// `': ` itself.
fn could_not_open_name(text: &str) -> Option<&str> {
	let (path, reason) = text.rsplit_once("': ")?;
	if reason.is_empty() || reason.contains(['\'', '\n']) {
		return None;
	}
	if path == "." {
		return Some(path);
	}
	path.strip_suffix('/').filter(|name| !name.is_empty())
}

/// Retention cap for path-list captures.
///
/// A thread-local in test builds: the walk runs on the calling thread, so a
/// test lowers the cap for its own invocations without truncating captures in
/// tests running concurrently.
#[cfg(test)]
fn path_list_capture_limit() -> usize {
	tests::CAPTURE_LIMIT.get()
}

#[cfg(not(test))]
const fn path_list_capture_limit() -> usize {
	super::cli::OUTPUT_LIMIT_BYTES
}
fn cli_lines(cwd: &Path, args: &[&str]) -> Result<Vec<String>> {
	Ok(cli_text(cwd, args)?
		.lines()
		.filter(|s| !s.is_empty())
		.map(str::to_owned)
		.collect())
}

fn quote_path(path: &str) -> String {
	if path
		.bytes()
		.all(|b| (0x20..0x7f).contains(&b) && b != b'"' && b != b'\\')
	{
		return path.to_owned();
	}
	let mut out = String::from("\"");
	for byte in path.bytes() {
		match byte {
			b'\\' => out.push_str("\\\\"),
			b'"' => out.push_str("\\\""),
			b'\n' => out.push_str("\\n"),
			b'\r' => out.push_str("\\r"),
			b'\t' => out.push_str("\\t"),
			0x20..=0x7e => out.push(char::from(byte)),
			_ => {
				use std::fmt::Write as _;
				let _ = write!(out, "\\{byte:03o}");
			},
		}
	}
	out.push('"');
	out
}
fn version_sort_desc(values: &mut [String]) {
	values.sort_by(|a, b| version_key(b).cmp(&version_key(a)).then_with(|| b.cmp(a)));
}
fn version_key(value: &str) -> Vec<(bool, String)> {
	value
		.split_inclusive(|c: char| c.is_ascii_digit())
		.map(|s| {
			let digits = s.trim_matches(|c: char| !c.is_ascii_digit());
			(
				!digits.is_empty(),
				if digits.is_empty() {
					s.to_owned()
				} else {
					format!("{:020}", digits.parse::<u64>().unwrap_or(u64::MAX))
				},
			)
		})
		.collect()
}

fn entry_from_head(path: PathBuf, head: &HeadState) -> WorktreeEntry {
	WorktreeEntry {
		path,
		head: head.commit().map(str::to_owned),
		branch: match head {
			HeadState::Ref { ref_name, .. } => Some(ref_name.clone()),
			HeadState::Detached { .. } => None,
		},
		detached: matches!(head, HeadState::Detached { .. }),
	}
}
fn parse_head_with_refs(head_path: &Path, common_dir: &Path) -> Result<HeadState> {
	let content = std::fs::read_to_string(head_path)?;
	let value = content.trim();
	if let Some(name) = value.strip_prefix("ref:").map(str::trim) {
		let commit = std::fs::read_to_string(common_dir.join(name))
			.ok()
			.and_then(|value| nonempty(value.trim()))
			.or_else(|| {
				std::fs::read_to_string(common_dir.join("packed-refs"))
					.ok()?
					.lines()
					.filter_map(|line| line.split_once(' '))
					.find_map(|(sha, candidate)| (candidate == name).then(|| sha.to_owned()))
			});
		Ok(HeadState::Ref {
			ref_name: name.to_owned(),
			branch: name.strip_prefix("refs/heads/").map(str::to_owned),
			commit,
		})
	} else {
		Ok(HeadState::Detached { commit: nonempty(value) })
	}
}
fn parse_worktree_cli(raw: &str) -> Vec<WorktreeEntry> {
	let mut out = Vec::new();
	for record in raw.split("\n\n") {
		let mut path = None;
		let mut head = None;
		let mut branch = None;
		let mut detached = false;
		for line in record.lines() {
			if let Some(v) = line.strip_prefix("worktree ") {
				path = Some(PathBuf::from(v));
			} else if let Some(v) = line.strip_prefix("HEAD ") {
				head = nonempty(v);
			} else if let Some(v) = line.strip_prefix("branch ") {
				branch = nonempty(v);
			} else if line == "detached" {
				detached = true;
			}
		}
		if let Some(path) = path {
			out.push(WorktreeEntry { path, head, branch, detached });
		}
	}
	out
}
fn commit_subject(
	commit: &gix::Commit<'_>,
) -> std::result::Result<String, gix::object::commit::Error> {
	Ok(commit
		.message()?
		.title
		.to_str_lossy()
		.trim_end_matches('\n')
		.to_owned())
}
fn tree_entry_id(tree: &gix::Tree<'_>, path: &str) -> Result<Option<String>> {
	Ok(tree
		.lookup_entry_by_path(path)
		.map_err(|e| Error::backend("git rev-list", e))?
		.map(|e| e.id().detach().to_string()))
}
fn parse_commit_details(raw: &str) -> CommitDetails {
	let mut fields = raw.splitn(6, '\0');
	let sha = fields.next().unwrap_or_default().to_owned();
	let parents = fields
		.next()
		.unwrap_or_default()
		.split_whitespace()
		.map(str::to_owned)
		.collect();
	let name = fields.next().unwrap_or_default().to_owned();
	let email = fields.next().unwrap_or_default().to_owned();
	let date = fields.next().and_then(nonempty);
	let raw_message = fields.next().unwrap_or_default();
	let message = raw_message
		.strip_suffix('\n')
		.unwrap_or(raw_message)
		.to_owned();
	CommitDetails { sha, parents, author: CommitAuthor { name, email, date }, message }
}
pub(crate) fn literal_pathspec(path: &str) -> String {
	format!(":(literal){path}")
}

fn path_matches(path: &str, wanted: &str) -> bool {
	let wanted = wanted.trim_end_matches('/');
	path == wanted
		|| path
			.strip_prefix(wanted)
			.is_some_and(|rest| rest.starts_with('/'))
}
/// `path =` values from `.gitmodules`, keeping only plain relative paths:
/// like Git, reject absolute, `.`, and `..` components, which could escape
/// the checkout or make the recursive walk revisit a parent forever.
fn parse_gitmodules(path: &Path) -> Vec<String> {
	let Ok(content) = std::fs::read_to_string(path) else {
		return Vec::new();
	};
	content
		.lines()
		.filter_map(|line| {
			let line = line.trim();
			let (key, value) = line.split_once('=')?;
			let value = value.trim();
			(key.trim().eq_ignore_ascii_case("path")
				&& !value.is_empty()
				&& Path::new(value)
					.components()
					.all(|component| matches!(component, std::path::Component::Normal(_))))
			.then(|| value.to_owned())
		})
		.collect()
}
fn cap_bytes(mut bytes: Vec<u8>, max: Option<usize>) -> ShowResult {
	let truncated = max.is_some_and(|cap| bytes.len() > cap);
	if let Some(cap) = max {
		bytes.truncate(cap);
	}
	ShowResult { bytes, truncated }
}

#[cfg(test)]
mod tests {
	use std::{fs, process::Command};

	use tempfile::TempDir;

	use super::*;

	type TestResult = std::result::Result<(), Box<dyn std::error::Error>>;

	fn git(cwd: &Path, args: &[&str]) -> std::result::Result<String, Box<dyn std::error::Error>> {
		let output = Command::new("git").current_dir(cwd).args(args).output()?;
		if !output.status.success() {
			return Err(
				format!("git {} failed: {}", args.join(" "), String::from_utf8_lossy(&output.stderr))
					.into(),
			);
		}
		Ok(String::from_utf8(output.stdout)?)
	}

	fn repo() -> std::result::Result<(TempDir, GitRepo), Box<dyn std::error::Error>> {
		let dir = tempfile::tempdir()?;
		git(dir.path(), &["init", "-b", "main"])?;
		git(dir.path(), &["config", "user.name", "Test User"])?;
		git(dir.path(), &["config", "user.email", "test@example.com"])?;
		let repo = GitRepo::require(dir.path())?;
		Ok((dir, repo))
	}

	fn commit(cwd: &Path, name: &str, contents: &str, subject: &str) -> TestResult {
		fs::write(cwd.join(name), contents)?;
		git(cwd, &["add", name])?;
		git(cwd, &["commit", "-m", subject])?;
		Ok(())
	}

	#[test]
	fn bounded_logs_read_only_the_requested_prefix_like_git_log() -> TestResult {
		let (dir, repo) = repo()?;
		commit(dir.path(), "one", "one\n", "first")?;
		let first = repo.head_sha()?.ok_or("missing HEAD")?;
		commit(dir.path(), "two", "two\n", "second")?;
		commit(dir.path(), "three", "three\n", "third")?;
		assert_eq!(repo.log_subjects(1)?, ["third"]);
		assert!(repo.log_subjects(0)?.is_empty());
		assert!(repo.log_onelines(0)?.is_empty());
		assert_eq!(
			repo.log_onelines(1)?,
			git(dir.path(), &["log", "-1", "--oneline", "--no-decorate"])?
				.lines()
				.map(str::to_owned)
				.collect::<Vec<_>>()
		);
		fs::remove_file(
			dir.path()
				.join(".git/objects")
				.join(&first[..2])
				.join(&first[2..]),
		)?;
		// A fresh handle cannot satisfy the missing ancestor from an object
		// cache. A prefix that stops before it never reads it, as `git log -1`
		// does not; a walk that reaches it reports it.
		let repo = GitRepo::require(dir.path())?;
		assert_eq!(repo.log_subjects(1)?, ["third"]);
		assert_eq!(repo.log_onelines(1)?.len(), 1);
		assert!(repo.log_subjects(0)?.is_empty());
		for result in [repo.log_subjects(3), repo.log_onelines(3)] {
			assert!(matches!(result, Err(Error::Backend { context: "git rev-list", .. })));
		}
		Ok(())
	}

	#[test]
	fn submodule_paths_skip_escaping_and_self_referential_entries() -> TestResult {
		let outer = tempfile::tempdir()?;
		let root = outer.path().join("root");
		fs::create_dir_all(root.join("sub"))?;
		fs::create_dir_all(outer.path().join("victim"))?;
		git(&root, &["init", "-q"])?;
		git(&root.join("sub"), &["init", "-q"])?;
		git(&outer.path().join("victim"), &["init", "-q"])?;
		// `.` and `a/..` would re-enqueue the root forever; `../victim` and the
		// absolute path point at a real checkout outside the repository.
		let absolute = outer.path().join("victim");
		fs::write(
			root.join(".gitmodules"),
			format!(
				"[submodule \"self\"]\n\tpath = .\n[submodule \"up\"]\n\tpath = sub/..\n[submodule \
				 \"escape\"]\n\tpath = ../victim\n[submodule \"abs\"]\n\tpath = {}\n[submodule \
				 \"sub\"]\n\tpath = sub\n",
				absolute.display()
			),
		)?;
		assert_eq!(GitRepo::require(&root)?.submodule_paths()?, ["sub"]);
		Ok(())
	}

	thread_local! {
		/// Retention cap consulted by [`path_list_capture_limit`]; per-thread so
		/// lowering it here cannot truncate captures in concurrent tests.
		pub(super) static CAPTURE_LIMIT: std::cell::Cell<usize> =
			const { std::cell::Cell::new(super::super::cli::OUTPUT_LIMIT_BYTES) };
	}

	/// Run `f` with the path-list capture cap lowered to `limit`.
	fn with_capture_limit<R>(limit: usize, f: impl FnOnce() -> R) -> R {
		struct Restore(usize);
		impl Drop for Restore {
			fn drop(&mut self) {
				CAPTURE_LIMIT.set(self.0);
			}
		}
		let _restore = Restore(CAPTURE_LIMIT.get());
		CAPTURE_LIMIT.set(limit);
		f()
	}

	/// Create `count` untracked files whose combined path bytes exceed any small
	/// capture cap, and return them in the order git reports.
	fn untracked_fixture(
		root: &Path,
		count: usize,
	) -> std::result::Result<Vec<String>, Box<dyn std::error::Error>> {
		let mut expected = Vec::with_capacity(count);
		for index in 0..count {
			let name = format!("{}-{index:03}.txt", "u".repeat(40));
			fs::write(root.join(&name), "x")?;
			expected.push(name);
		}
		expected.sort();
		Ok(expected)
	}

	#[test]
	fn is_dirty_answers_from_a_capped_capture() -> TestResult {
		let (dir, repo) = repo()?;
		let root = dir.path();
		commit(root, "tracked", "tracked\n", "tracked")?;
		assert!(!repo.is_dirty()?);

		// Enough entries that the porcelain rendering outgrows
		// DIRTY_PROBE_CAPTURE_LIMIT, so the answer has to survive a capture that
		// was cut short rather than depend on reading the whole listing.
		untracked_fixture(root, 150)?;
		let full = repo.status_porcelain(&StatusOptions::default())?;
		assert!(
			full.len() > DIRTY_PROBE_CAPTURE_LIMIT,
			"fixture must outgrow the probe cap, got {} bytes",
			full.len()
		);
		assert!(repo.is_dirty()?);
		Ok(())
	}

	#[test]
	fn ls_files_returns_every_untracked_path_when_the_capture_truncates() -> TestResult {
		let (dir, repo) = repo()?;
		let root = dir.path();
		commit(root, "tracked", "tracked\n", "tracked")?;
		let expected = untracked_fixture(root, 60)?;
		// Pin the precondition: at this cap the subprocess capture really is cut
		// short, so the equality below is evidence of the in-process retry and
		// not of a capture that happened to fit.
		let capped = cli_text_owned_capped(
			root,
			&["ls-files".to_owned(), "-z".to_owned(), "--others".to_owned()],
			super::super::cli::SYNC_TIMEOUT,
			256,
		)?;
		assert!(super::super::cli::is_truncated(&capped), "fixture must overflow the cap");

		let listed = with_capture_limit(256, || repo.ls_files(true, true))?;
		assert_eq!(listed, expected);
		Ok(())
	}

	/// Take every permission on `dir` away from this process, or report that
	/// the process reads it anyway (root, or a filesystem that ignores modes),
	/// in which case the mode is restored and the caller skips.
	#[cfg(unix)]
	fn lock_dir(dir: &Path) -> std::result::Result<bool, Box<dyn std::error::Error>> {
		use std::os::unix::fs::PermissionsExt;
		fs::set_permissions(dir, fs::Permissions::from_mode(0o000))?;
		if fs::read_dir(dir).is_ok() {
			fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
			eprintln!("skipping: this process can read a mode-000 directory");
			return Ok(false);
		}
		Ok(true)
	}

	#[cfg(unix)]
	fn unlock_dir(dir: &Path) -> TestResult {
		use std::os::unix::fs::PermissionsExt;
		fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
		Ok(())
	}

	/// A stderr capture that got all of `text`.
	fn whole(text: &str) -> Capture {
		Capture { text: text.to_owned(), loss: None }
	}

	#[test]
	fn unreadable_directories_reads_only_the_could_not_open_warning() -> TestResult {
		// A trace line and a per-file access warning are not directories git
		// skipped; a name may itself contain `':`, so the last one ends it.
		let stderr = [
			"trace: built-in: git ls-files",
			"warning: unable to access 'd/.gitignore': Permission denied",
			"warning: could not open directory 'b/c/': Permission denied",
			"warning: could not open directory 'it's': odd/': Permission denied",
			"warning: could not open directory 'b/c/': Permission denied",
		]
		.join("\n");
		assert_eq!(unreadable_directories(&whole(&stderr))?, ["b/c", "it's': odd"]);
		assert!(unreadable_directories(&whole(""))?.is_empty());
		Ok(())
	}

	#[cfg(unix)]
	#[test]
	fn ls_files_with_warnings_names_a_directory_git_could_not_open() -> TestResult {
		let (dir, repo) = repo()?;
		let root = dir.path();
		commit(root, ".gitignore", "build/\n", "ignore build")?;
		fs::write(root.join("seen.txt"), "x")?;
		let locked = root.join("locked");
		fs::create_dir(&locked)?;
		fs::write(locked.join("only-copy.txt"), "x")?;
		// Ignored, so git never opens it and has nothing to report.
		let ignored = root.join("build").join("cache");
		fs::create_dir_all(&ignored)?;
		if !lock_dir(&locked)? {
			return Ok(());
		}
		let ignored_locked = lock_dir(&ignored)?;

		let listed = repo.ls_files_with_warnings(true, true);
		// The plain listing is the same short list, with nothing to say that it
		// is short: the reason the variant above exists.
		let plain = repo.ls_files(true, true);
		unlock_dir(&locked)?;
		if ignored_locked {
			unlock_dir(&ignored)?;
		}

		let (paths, unreadable) = listed?;
		assert_eq!(paths, ["seen.txt"]);
		assert_eq!(unreadable, ["locked"]);
		assert_eq!(plain?, ["seen.txt"]);
		Ok(())
	}

	#[cfg(unix)]
	#[test]
	fn ls_files_with_warnings_refuses_a_warning_stream_cut_at_the_capture_limit() -> TestResult {
		let (dir, repo) = repo()?;
		let root = dir.path();
		commit(root, "tracked", "tracked\n", "tracked")?;
		// Nothing readable is untracked, so stdout stays empty and under the
		// cap: only stderr is cut, and the listing is not retried in-process.
		let mut locked = Vec::new();
		for index in 0..8 {
			let path = root.join(format!("{}-{index}", "d".repeat(40)));
			fs::create_dir(&path)?;
			if !lock_dir(&path)? {
				return Ok(());
			}
			locked.push(path);
		}
		let args = ["ls-files".to_owned(), "-z".to_owned(), "--others".to_owned()];
		let capped = cli_text_and_warnings_capped(root, &args, super::super::cli::SYNC_TIMEOUT, 128);
		let listed = with_capture_limit(128, || repo.ls_files_with_warnings(true, true));
		for path in &locked {
			unlock_dir(path)?;
		}

		// Pin the precondition: at this cap stderr really is cut and stdout is
		// not, so the error below comes from the cut warnings alone.
		let (stdout, stderr) = capped?;
		assert!(
			!super::super::cli::is_truncated(&stdout.text),
			"stdout must fit the cap: {stdout:?}"
		);
		assert!(
			super::super::cli::is_truncated(&stderr.text),
			"stderr must overflow the cap: {stderr:?}"
		);
		let err = listed.expect_err("a cut warning stream must not answer");
		assert!(err.to_string().contains("capture limit"), "unexpected error: {err}");
		Ok(())
	}

	/// git's own bytes, captured from `git ls-files --others --exclude-standard
	/// -z` (git 2.43, `LC_MESSAGES=C`) over mode-000 directories: a name is
	/// written raw, a CR in it becomes `?`, and an LF stays an LF.
	#[test]
	fn unreadable_directories_reads_a_report_whose_name_spans_lines() -> TestResult {
		// Failure mode: read line by line, the first line had the opening and
		// no close and the second had no opening, both were dropped, and the
		// empty list let the teardown delete the directory's only copy.
		let lf = "warning: could not open directory 'locked\npart/': Permission denied\n";
		let crlf = "warning: could not open directory 'locked?\npart/': Permission denied\n";
		let lf_then_plain = "warning: could not open directory 'a\nb/': Permission denied\nwarning: \
		                     could not open directory 'plain/': Permission denied\n";
		// Directory `x/': y\nz`: the first line already reads as a whole
		// report, so the name comes out short, but a name comes out.
		let lf_after_close = "warning: could not open directory 'x/': y\nz/': Permission denied\n";
		assert_eq!(unreadable_directories(&whole(lf))?, ["locked\npart"]);
		assert_eq!(unreadable_directories(&whole(crlf))?, ["locked?\npart"]);
		assert_eq!(unreadable_directories(&whole(lf_then_plain))?, ["a\nb", "plain"]);
		assert_eq!(unreadable_directories(&whole(lf_after_close))?, ["x"]);
		Ok(())
	}

	#[test]
	fn unreadable_directories_refuses_a_report_it_cannot_name() {
		// Failure mode: a report with no readable name was skipped, and the
		// empty list read as a complete walk. git caps a report at 4 KiB, so a
		// path past PATH_MAX is cut before it closes; these are git 2.43's
		// bytes for 24 nested 199-byte names.
		let mut path = String::new();
		for level in 0..24 {
			path += &level.to_string();
			path += &"x".repeat(198);
			path.push('/');
		}
		let mut cut = format!("warning: could not open directory '{path}': File name too long");
		cut.truncate(4095);
		cut.push('\n');
		// The next report's close must not be taken for this one's.
		let then_plain =
			format!("{cut}warning: could not open directory 'plain/': Permission denied\n");
		for stderr in [&cut, &then_plain] {
			let err =
				unreadable_directories(&whole(stderr)).expect_err("an unnamed report must not answer");
			assert!(err.to_string().contains("without a readable name"), "unexpected error: {err}");
		}
	}

	#[test]
	fn unreadable_directories_refuses_a_capture_that_stopped_early() {
		// Failure mode: a stderr capture that failed came back as silence,
		// which read as a walk that reached every directory. Each cause is
		// named, so the refusal says which one it was.
		use super::super::cli::CaptureLoss;
		let losses = [
			(CaptureLoss::Read("Input/output error (os error 5)".to_owned()), "reading it failed"),
			(CaptureLoss::Spawn("Resource temporarily unavailable".to_owned()), "could not start"),
			(CaptureLoss::Panic, "panicked"),
		];
		for (loss, cause) in losses {
			let silence = Capture { text: String::new(), loss: Some(loss) };
			let err = unreadable_directories(&silence).expect_err("a lost capture must not answer");
			let message = err.to_string();
			assert!(message.contains("not captured whole"), "unexpected error: {message}");
			assert!(message.contains(cause), "cause not named: {message}");
		}
	}

	#[cfg(unix)]
	#[test]
	fn ls_files_with_warnings_names_a_directory_whose_name_holds_a_newline() -> TestResult {
		// Failure mode: git exits 0 with no paths and a report that spans two
		// lines, and the listing came back empty and complete.
		let (dir, repo) = repo()?;
		let mut locked = Vec::new();
		for name in ["locked\npart", "locked\r\npart"] {
			let path = dir.path().join(name);
			fs::create_dir(&path)?;
			fs::write(path.join("only-copy.txt"), "x")?;
			if !lock_dir(&path)? {
				return Ok(());
			}
			locked.push(path);
		}
		let listed = repo.ls_files_with_warnings(true, true);
		for path in &locked {
			unlock_dir(path)?;
		}

		let (paths, unreadable) = listed?;
		assert!(paths.is_empty(), "{paths:?}");
		// git writes the CR as `?`, so that name is lossy; it is still a name,
		// which is what stops the capture.
		assert_eq!(unreadable.len(), 2, "{unreadable:?}");
		assert!(unreadable.iter().any(|name| name == "locked\npart"), "{unreadable:?}");
		Ok(())
	}

	#[cfg(unix)]
	#[test]
	fn ls_files_with_warnings_answers_past_an_unreadable_gitignore() -> TestResult {
		// Failure mode: a refusal on a safe warning, which gets the refusal
		// disabled. git cannot read the `.gitignore`, says so, and lists the
		// subtree it would have ignored, so the listing is complete.
		use std::os::unix::fs::PermissionsExt;
		let (dir, repo) = repo()?;
		let root = dir.path();
		let gitignore = root.join(".gitignore");
		fs::write(&gitignore, "unseen/\n")?;
		fs::create_dir(root.join("unseen"))?;
		fs::write(root.join("unseen").join("work"), "x")?;
		fs::set_permissions(&gitignore, fs::Permissions::from_mode(0o000))?;
		if fs::read(&gitignore).is_ok() {
			fs::set_permissions(&gitignore, fs::Permissions::from_mode(0o600))?;
			eprintln!("skipping: this process can read a mode-000 file");
			return Ok(());
		}
		let args = ["ls-files", "-z", "--others", "--exclude-standard"].map(str::to_owned);
		let warned = cli_text_and_warnings_capped(
			root,
			&args,
			super::super::cli::SYNC_TIMEOUT,
			super::super::cli::OUTPUT_LIMIT_BYTES,
		);
		let listed = repo.ls_files_with_warnings(true, true);
		fs::set_permissions(&gitignore, fs::Permissions::from_mode(0o600))?;

		// Pin the precondition: git did warn, so the answer below is the
		// parser passing the warning by, not a quiet stderr.
		let (_, Capture { text: stderr, .. }) = warned?;
		assert!(stderr.contains("warning: unable to access '.gitignore'"), "{stderr:?}");
		let (paths, unreadable) = listed?;
		assert_eq!(paths, [".gitignore", "unseen/work"]);
		assert!(unreadable.is_empty(), "{unreadable:?}");
		Ok(())
	}

	/// Nest `depth` directories of 199-byte names in `root`, each made
	/// relative to its parent, so the whole path can pass `PATH_MAX`.
	#[cfg(unix)]
	fn deep_tree(root: &Path, depth: usize) -> TestResult {
		use std::{
			ffi::CString,
			os::fd::{AsRawFd, FromRawFd, OwnedFd},
		};
		let mut dir = OwnedFd::from(fs::File::open(root)?);
		for level in 0..depth {
			let name = CString::new(format!("{level}{}", "x".repeat(198)))?;
			// SAFETY: `dir` is an open directory descriptor, and `name` is a
			// NUL-terminated string that outlives the call.
			if unsafe { libc::mkdirat(dir.as_raw_fd(), name.as_ptr(), 0o700) } != 0 {
				return Err(std::io::Error::last_os_error().into());
			}
			// SAFETY: as for `mkdirat` above.
			let child = unsafe {
				libc::openat(
					dir.as_raw_fd(),
					name.as_ptr(),
					libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC,
				)
			};
			if child < 0 {
				return Err(std::io::Error::last_os_error().into());
			}
			// SAFETY: `child` was just opened by this call and nothing else
			// owns it.
			dir = unsafe { OwnedFd::from_raw_fd(child) };
		}
		Ok(())
	}

	#[cfg(unix)]
	#[test]
	fn ls_files_with_warnings_refuses_a_directory_past_path_max() -> TestResult {
		// Failure mode: git cannot open a directory past PATH_MAX, exits 0,
		// and cuts its report before the name closes; the report was skipped
		// and the empty list read as a complete walk.
		let (dir, repo) = repo()?;
		deep_tree(dir.path(), 24)?;
		match repo.ls_files_with_warnings(true, true) {
			Err(err) => {
				assert!(err.to_string().contains("without a readable name"), "unexpected error: {err}");
			},
			// A git that writes the whole report names the directory, which
			// refuses the capture as well.
			Ok((paths, unreadable)) => {
				assert!(!unreadable.is_empty(), "a short listing answered as complete: {paths:?}");
			},
		}
		Ok(())
	}

	/// Initialize a reftable repository, or report that this git cannot.
	///
	/// `--ref-format` arrived in git 2.45. There is no way to fake the fixture
	/// on an older binary: writing `extensions.refstorage = reftable` by hand
	/// makes git reject the repository outright, so every command in the test
	/// would fail for the wrong reason.
	fn init_reftable(root: &Path) -> std::result::Result<bool, Box<dyn std::error::Error>> {
		let out = Command::new("git")
			.current_dir(root)
			.args(["init", "-q", "-b", "main", "--ref-format=reftable"])
			.output()?;
		if out.status.success() {
			return Ok(true);
		}
		let stderr = String::from_utf8_lossy(&out.stderr);
		if stderr.contains("ref-format") {
			eprintln!("skipping reftable coverage: this git has no --ref-format ({})", stderr.trim());
			return Ok(false);
		}
		Err(format!("git init --ref-format=reftable failed: {stderr}").into())
	}

	#[test]
	fn reftable_ls_files_errors_rather_than_returning_a_truncated_prefix() -> TestResult {
		let dir = tempfile::tempdir()?;
		let root = dir.path();
		if !init_reftable(root)? {
			return Ok(());
		}
		git(root, &["config", "user.name", "Test User"])?;
		git(root, &["config", "user.email", "test@example.com"])?;
		let repo = GitRepo::require(root)?;
		assert!(repo.is_reftable(), "fixture must use reftable ref storage");
		let expected = untracked_fixture(root, 60)?;

		// Uncapped, the reftable repo reads through the same CLI path.
		assert_eq!(repo.ls_files(true, true)?, expected);

		// Capped, there is no in-process walk to fall back to, so a short list
		// must surface as an error instead of a silent prefix.
		let err = with_capture_limit(256, || repo.ls_files(true, true))
			.expect_err("truncated reftable listing must fail");
		assert!(err.to_string().contains("capture limit"), "unexpected error: {err}");
		Ok(())
	}

	#[test]
	fn read_head_branch_detached_unborn_and_packed() -> TestResult {
		let (dir, repo) = repo()?;
		assert_eq!(repo.head()?, HeadState::Ref {
			ref_name: "refs/heads/main".to_owned(),
			branch:   Some("main".to_owned()),
			commit:   None,
		});
		commit(dir.path(), "one", "one\n", "one")?;
		let sha = git(dir.path(), &["rev-parse", "HEAD"])?.trim().to_owned();
		assert_eq!(repo.head_sha()?, Some(sha.clone()));
		git(dir.path(), &["pack-refs", "--all", "--prune"])?;
		assert_eq!(repo.head_sha()?, Some(sha.clone()));
		git(dir.path(), &["checkout", "--detach"])?;
		assert_eq!(repo.head()?, HeadState::Detached { commit: Some(sha) });
		assert_eq!(repo.current_branch()?, None);
		Ok(())
	}

	#[test]
	fn merge_base_resolves_rejects_and_errors() -> TestResult {
		let (dir, repo) = repo()?;
		let root = dir.path();
		commit(root, "base", "base\n", "base")?;
		let fork = git(root, &["rev-parse", "HEAD"])?.trim().to_owned();

		git(root, &["checkout", "-b", "feature"])?;
		commit(root, "feature", "feature\n", "feature")?;
		git(root, &["checkout", "main"])?;
		commit(root, "advance", "advance\n", "advance")?;

		// Divergent branches share the fork commit as their merge base.
		assert_eq!(repo.merge_base("main", "feature")?, Some(fork));

		// Orphan branch has no common ancestor: `None`, not an error.
		git(root, &["checkout", "--orphan", "orphan"])?;
		git(root, &["rm", "-rf", "."])?;
		commit(root, "other", "other\n", "orphan")?;
		assert_eq!(repo.merge_base("main", "orphan")?, None);

		// A missing ref is a fatal failure, never reported as "no merge base".
		assert!(repo.merge_base("main", "does-not-exist").is_err());
		Ok(())
	}
	#[test]
	fn read_status_porcelain_survives_output_larger_than_pipe_buffer() -> TestResult {
		let (dir, repo) = repo()?;
		commit(dir.path(), "seed", "seed\n", "initial")?;
		// >64 KiB of porcelain output: the sync CLI runner used to poll
		// `try_wait` without draining the pipes, so a chatty child blocked on
		// a full pipe and died as a spurious `CliTimeout`.
		for i in 0..3000 {
			fs::write(
				dir.path()
					.join(format!("untracked-scratch-file-{i:04}.txt")),
				"x\n",
			)?;
		}
		let text = repo.status_porcelain(&StatusOptions {
			untracked: UntrackedMode::All,
			..Default::default()
		})?;
		assert_eq!(text.lines().count(), 3000);
		Ok(())
	}

	#[test]
	fn read_status_matches_porcelain_oracle() -> TestResult {
		let (dir, repo) = repo()?;
		commit(dir.path(), "rename-me", "rename\n", "initial")?;
		fs::write(dir.path().join("staged"), "staged\n")?;
		git(dir.path(), &["add", "staged"])?;
		fs::write(dir.path().join("staged"), "staged\nmodified\n")?;
		git(dir.path(), &["mv", "rename-me", "renamed"])?;
		fs::write(dir.path().join("untracked"), "new\n")?;
		// Intent-to-add (`git add -N`) must surface as an unstaged addition
		// (` A`); it was previously skipped and invisible to the git TUI.
		fs::write(dir.path().join("promised"), "promised\n")?;
		git(dir.path(), &["add", "-N", "promised"])?;
		// An untracked DIRECTORY must collapse to one entry (git porcelain
		// default) — the status line summary counted 25 instead of 5 on a
		// real repo when this used per-file emission.
		fs::create_dir(dir.path().join("newdir"))?;
		fs::write(dir.path().join("newdir").join("a"), "a\n")?;
		fs::write(dir.path().join("newdir").join("b"), "b\n")?;
		// Directories containing no files anywhere beneath them are invisible
		// to `git status`, even when nested (regression: phantom `?? undefined/`
		// entries for empty scaffold dirs).
		fs::create_dir_all(dir.path().join("empty").join("nested"))?;
		let expected = git(dir.path(), &["status", "--porcelain", "--untracked-files=normal"])?;
		let actual = repo.status_porcelain(&StatusOptions::default())?;
		assert_eq!(actual.as_bytes(), expected.as_bytes());
		// The in-process gitoxide fallback (hosts without a git binary) must
		// render the same bytes as the CLI-first public path.
		let fallback = repo.status_porcelain_gix(&StatusOptions::default())?;
		assert_eq!(fallback.as_bytes(), expected.as_bytes());
		assert_eq!(repo.status_summary()?, StatusSummary {
			staged:    2,
			unstaged:  2,
			untracked: 2,
		});
		Ok(())
	}

	#[test]
	fn read_range_is_oldest_first_and_config_is_trimmed() -> TestResult {
		let (dir, repo) = repo()?;
		commit(dir.path(), "one", "one\n", "one")?;
		let base = git(dir.path(), &["rev-parse", "HEAD"])?.trim().to_owned();
		commit(dir.path(), "two", "two\n", "two")?;
		let second = git(dir.path(), &["rev-parse", "HEAD"])?.trim().to_owned();
		commit(dir.path(), "three", "three\n", "three")?;
		let third = git(dir.path(), &["rev-parse", "HEAD"])?.trim().to_owned();
		assert_eq!(repo.rev_list_range(&base, "HEAD")?, vec![second, third]);
		git(dir.path(), &["config", "custom.value", "  configured  "])?;
		assert_eq!(repo.config_get("custom.value")?, Some("configured".to_owned()));
		assert_eq!(repo.config_get("custom.missing")?, None);
		Ok(())
	}

	#[test]
	fn read_objects_logs_and_refs() -> TestResult {
		let (dir, repo) = repo()?;
		commit(dir.path(), "one", "one\n", "first subject")?;
		let first = repo.head_sha()?.ok_or("missing HEAD")?;
		commit(dir.path(), "two", "two\n", "second subject")?;
		let second = repo.head_sha()?.ok_or("missing HEAD")?;
		git(dir.path(), &["tag", "-a", "v1.2.0", "-m", "release", "HEAD"])?;

		assert_eq!(repo.resolve_ref("main")?, Some(second.clone()));
		assert!(repo.ref_exists("refs/heads/main")?);
		assert_eq!(repo.tags_at("HEAD")?, vec!["v1.2.0"]);
		assert_eq!(repo.list_branches(false)?, vec!["main"]);
		assert_eq!(repo.log_subjects(2)?, vec!["second subject", "first subject"]);
		let expected_onelines: Vec<_> =
			git(dir.path(), &["log", "-2", "--oneline", "--no-decorate"])?
				.lines()
				.map(str::to_owned)
				.collect();
		assert_eq!(repo.log_onelines(2)?, expected_onelines);
		assert_eq!(repo.rev_list_touching("HEAD", "two", 10)?, vec![second.clone()]);
		assert_eq!(repo.ls_tree("HEAD", &[])?, vec!["one", "two"]);
		let shown = repo.show_blob("HEAD:two", Some(3))?;
		assert_eq!(shown.bytes, b"two");
		assert!(shown.truncated);
		let details = repo.commit_details("HEAD")?;
		assert_eq!(details.sha, second);
		assert_eq!(details.parents, vec![first]);
		assert_eq!(details.author.name, "Test User");
		assert_eq!(details.message, "second subject");

		git(dir.path(), &["remote", "add", "origin", "https://example.test/repo"])?;
		assert_eq!(repo.remote_list()?, vec!["origin"]);
		assert_eq!(repo.remote_url("origin")?.as_deref(), Some("https://example.test/repo"));
		assert_eq!(repo.lfs_media_dir()?, Some(repo.info().common_dir.join("lfs").join("objects")));
		assert_eq!(repo.head_watch_target(), repo.info().head_path);
		Ok(())
	}

	#[test]
	fn read_ls_files_honors_standard_excludes() -> TestResult {
		let (dir, repo) = repo()?;
		commit(dir.path(), "tracked", "tracked\n", "initial")?;
		fs::write(dir.path().join(".gitignore"), "ignored\n")?;
		fs::write(dir.path().join("ignored"), "ignored\n")?;
		fs::write(dir.path().join("visible"), "visible\n")?;
		let all = repo.ls_files(true, false)?;
		let expected_all: Vec<_> = git(dir.path(), &["ls-files", "--others"])?
			.lines()
			.map(str::to_owned)
			.collect();
		assert_eq!(all, expected_all);
		let filtered = repo.ls_files(true, true)?;
		let expected_filtered: Vec<_> =
			git(dir.path(), &["ls-files", "--others", "--exclude-standard"])?
				.lines()
				.map(str::to_owned)
				.collect();
		assert_eq!(filtered, expected_filtered);
		Ok(())
	}

	#[test]
	fn read_worktrees_and_remote_default_branch() -> TestResult {
		let (dir, repo) = repo()?;
		commit(dir.path(), "tracked", "tracked\n", "initial")?;
		git(dir.path(), &["update-ref", "refs/remotes/origin/main", "HEAD"])?;
		git(dir.path(), &["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])?;
		assert_eq!(repo.default_branch()?, Some("main".to_owned()));

		let linked = dir.path().join("linked");
		let linked_text = linked.to_string_lossy().into_owned();
		git(dir.path(), &["worktree", "add", "-b", "linked-branch", &linked_text])?;
		let worktrees = repo.worktrees()?;
		assert_eq!(worktrees.len(), 2);
		assert_eq!(worktrees[0].path, dir.path());
		// git records the real path, with `/` separators on Windows; compare
		// resolved locations rather than spellings.
		assert_eq!(worktrees[1].path.canonicalize()?, linked.canonicalize()?);
		assert_eq!(worktrees[1].branch.as_deref(), Some("refs/heads/linked-branch"));
		Ok(())
	}
}
