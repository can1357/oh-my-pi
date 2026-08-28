//! Read-side operations on [`GitRepo`](super::GitRepo).

use std::{
	collections::{BTreeMap, BTreeSet, HashSet, VecDeque},
	path::{Path, PathBuf},
};

use gix::bstr::ByteSlice;

use super::GitRepo;
use crate::{
	error::{Error, Result},
	types::{
		CommitAuthor, CommitDetails, HeadState, ShowResult, StatusOptions, StatusSummary,
		UntrackedMode, WorktreeEntry,
	},
};

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
	pub fn is_dirty(&self) -> Result<bool> {
		let options = StatusOptions::default();
		if self.is_reftable() {
			return self
				.status_porcelain(&options)
				.map(|status| !status.is_empty());
		}
		let repo = self.gix()?;
		let platform = repo
			.status(gix::progress::Discard)
			.map_err(|err| Error::backend("git status", err))?
			.untracked_files(gix::status::UntrackedFiles::Collapsed);
		let iter = platform
			.into_iter(options.pathspecs.iter().map(|path| path.as_bytes().into()))
			.map_err(|err| Error::backend("git status", err))?;
		use gix::status::{Item, index_worktree, plumbing::index_as_worktree::EntryStatus};
		for item in iter {
			let item = item.map_err(|err| Error::backend("git status", err))?;
			match item {
				Item::TreeIndex(_) | Item::IndexWorktree(index_worktree::Item::Rewrite { .. }) => {
					return Ok(true);
				},
				Item::IndexWorktree(index_worktree::Item::Modification { status, .. })
					if !matches!(status, EntryStatus::NeedsUpdate(_)) =>
				{
					return Ok(true);
				},
				Item::IndexWorktree(index_worktree::Item::DirectoryContents { entry, .. })
					if entry.status == gix::dir::entry::Status::Untracked
						&& (entry.disk_kind != Some(gix::dir::entry::Kind::Directory)
							|| dir_contains_file(
								&self
									.info()
									.repo_root
									.join(bytes_to_path(entry.rela_path.as_bstr())),
							)) =>
				{
					return Ok(true);
				},
				_ => {},
			}
		}
		Ok(false)
	}

	/// Render git status in porcelain-v1 form.
	pub fn status_porcelain(&self, options: &StatusOptions) -> Result<String> {
		if self.is_reftable() {
			let mut owned = vec!["status".to_owned(), "--porcelain".to_owned()];
			owned.push(match options.untracked {
				UntrackedMode::No => "--untracked-files=no".to_owned(),
				UntrackedMode::Normal => "--untracked-files=normal".to_owned(),
				UntrackedMode::All => "--untracked-files=all".to_owned(),
			});
			if options.nul_terminated {
				owned.push("-z".to_owned());
			}
			if !options.pathspecs.is_empty() {
				owned.push("--".to_owned());
				owned.extend(options.pathspecs.iter().cloned());
			}
			return cli_text_owned(self.root(), &owned);
		}
		let repo = self.gix()?;
		let untracked = match options.untracked {
			UntrackedMode::No => gix::status::UntrackedFiles::None,
			UntrackedMode::Normal => gix::status::UntrackedFiles::Collapsed,
			UntrackedMode::All => gix::status::UntrackedFiles::Files,
		};
		let platform = repo
			.status(gix::progress::Discard)
			.map_err(|err| Error::backend("git status", err))?
			.untracked_files(untracked);
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
		for id in self.walk_commit_ids("HEAD")?.into_iter().take(count) {
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git log", err))?;
			out.push(commit_subject(&commit).map_err(|err| Error::backend("git log", err))?);
		}
		Ok(out)
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
		for id in self.walk_commit_ids("HEAD")?.into_iter().take(count) {
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
		for id in self.walk_commit_ids(rev)? {
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
		if self.is_reftable() {
			let mut args = vec!["ls-files"];
			if others {
				args.push("--others");
			}
			if exclude_standard {
				args.push("--exclude-standard");
			}
			return cli_lines(self.root(), &args);
		}
		if !others {
			let repo = self.gix()?;
			let index = repo
				.index_or_empty()
				.map_err(|err| Error::backend("git ls-files", err))?;
			let mut out: Vec<_> = index
				.entries()
				.iter()
				.filter(|e| e.stage() == gix::index::entry::Stage::Unconflicted)
				.map(|e| bytes_to_path(e.path(&index)))
				.collect();
			out.sort();
			out.dedup();
			return Ok(out);
		}
		let repo = self.gix()?;
		let mut platform = repo
			.status(gix::progress::Discard)
			.map_err(|e| Error::backend("git ls-files", e))?
			.untracked_files(gix::status::UntrackedFiles::Files);
		if !exclude_standard {
			platform = platform.dirwalk_options(|opts| {
				opts.emit_ignored(Some(gix::dir::walk::EmissionMode::Matching))
			});
		}
		let iter = platform
			.into_index_worktree_iter(std::iter::empty::<gix::bstr::BString>())
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
		Ok(out)
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
			return Ok(cli_text_owned(self.root(), &owned)?
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
					path.clone()
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

	fn walk_commit_ids(&self, rev: &str) -> Result<Vec<gix::ObjectId>> {
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
	let out = super::cli::run_sync(cwd, &owned)?;
	if out.exit_code != 0 {
		return Ok(None);
	}
	Ok(nonempty(out.stdout.trim()))
}
fn cli_text(cwd: &Path, args: &[&str]) -> Result<String> {
	let owned: Vec<_> = args.iter().map(|v| (*v).to_owned()).collect();
	cli_text_owned(cwd, &owned)
}
fn cli_text_owned(cwd: &Path, args: &[String]) -> Result<String> {
	Ok(super::cli::run_sync(cwd, args)?.into_checked(args)?.stdout)
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
fn path_matches(path: &str, wanted: &str) -> bool {
	let wanted = wanted.trim_end_matches('/');
	path == wanted
		|| path
			.strip_prefix(wanted)
			.is_some_and(|rest| rest.starts_with('/'))
}
fn parse_gitmodules(path: &Path) -> Vec<String> {
	let Ok(content) = std::fs::read_to_string(path) else {
		return Vec::new();
	};
	content
		.lines()
		.filter_map(|line| {
			let line = line.trim();
			let (key, value) = line.split_once('=')?;
			(key.trim().eq_ignore_ascii_case("path")).then(|| value.trim().to_owned())
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
		assert_eq!(worktrees[1].path, linked.canonicalize()?);
		assert_eq!(worktrees[1].branch.as_deref(), Some("refs/heads/linked-branch"));
		Ok(())
	}
}
