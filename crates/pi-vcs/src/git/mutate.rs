//! In-process local Git mutations.

use std::{
	borrow::Cow,
	collections::{BTreeMap, BTreeSet},
	ffi::OsStr,
	fs,
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use gix::bstr::{BString, ByteSlice};

use super::{
	GitRepo, SETUP_MARK,
	filter::WorktreeFilter,
	normalize_path,
	open::{load_index_or_empty, load_index_or_head, status_with_fresh_index, status_with_index},
	read::literal_pathspec,
	read_setup_mark,
};
use crate::{
	error::{Error, Result},
	types::{
		CleanOptions, CommitAuthor, CommitOptions, DetachGitDirResult, ResetMode, RestoreOptions,
		WorktreeAddOptions, WorktreeAddResult, WorktreeClone,
	},
};

const INDEX_WRITE: gix::index::write::Options = gix::index::write::Options {
	extensions: gix::index::write::Extensions::None,
	skip_hash:  false,
};
/// Apply a ref update, synthesizing a committer for the reflog entry when no
/// identity is configured. Reflog lines require a signature, but git never
/// fails branch/reset/stash ref updates over missing identity — only
/// `git commit` demands one — so parity requires a fallback here.
pub(crate) fn update_reference(
	repo: &gix::Repository,
	op: &'static str,
	name: &str,
	id: gix::hash::ObjectId,
	expected: gix::refs::transaction::PreviousValue,
	message: &str,
	force_create_reflog: bool,
) -> Result<()> {
	let name: gix::refs::FullName = name.try_into().map_err(|err| Error::backend(op, err))?;
	let edit = gix::refs::transaction::RefEdit {
		change: gix::refs::transaction::Change::Update {
			log: gix::refs::transaction::LogChange {
				mode: gix::refs::transaction::RefLog::AndReference,
				force_create_reflog,
				message: message.into(),
			},
			expected,
			new: gix::refs::Target::Object(id),
		},
		name,
		deref: false,
	};
	let now;
	let committer = if let Some(signature) = repo
		.committer()
		.transpose()
		.map_err(|err| Error::backend(op, err))?
	{
		signature
	} else {
		now = format!(
			"{} +0000",
			std::time::SystemTime::now()
				.duration_since(std::time::UNIX_EPOCH)
				.map_or(0, |elapsed| elapsed.as_secs())
		);
		gix::actor::SignatureRef { name: "omp".into(), email: "omp@localhost".into(), time: &now }
	};
	repo
		.edit_references_as(Some(edit), Some(committer))
		.map_err(|err| Error::backend(op, err))?;
	Ok(())
}

impl GitRepo {
	/// Stage worktree files, or every change when `files` is empty.
	///
	/// Empty `files` matches `git add -A`: refresh tracked paths and add
	/// untracked files that survive the standard ignore stack (nested
	/// `.gitignore`, exclude files). Content goes through the worktree-to-git
	/// filter pipeline (`.gitattributes` `text`/`eol`, `core.autocrlf`, clean
	/// drivers) so the index blob matches what `git add` would store — a
	/// `*.cmd text eol=crlf` file stages as LF even though the checkout is
	/// CRLF. When `core.precomposeUnicode` is set,
	/// a worktree path that is a unicode-composition equivalent of an
	/// existing index path (macOS NFD dirent vs NFC index name) is stored
	/// under the index name. Unrelated names that share an inode (hardlinks)
	/// and distinct NFC/NFD files when precompose is off stay separate.
	pub fn stage_files(&self, files: &[String]) -> Result<()> {
		let repo = self.gix()?;
		let mut index = load_index_or_head(&repo, "git add")?;
		// Whole seconds since the epoch before any file is stat'ed (see
		// `stage_one`).
		let staging_started = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_secs());
		let all = files.is_empty();
		let mut requested: BTreeSet<String> = files
			.iter()
			.map(|path| normalize_stage_path(path))
			.collect();
		if precompose_unicode_enabled(&repo) {
			requested = remap_composed_index_paths(self.root(), &index, requested);
		}
		let mut selected = collect_stage_paths(self, &requested, all)?;
		for entry in index.entries() {
			let path = entry.path(&index).to_str_lossy().into_owned();
			if (all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(&path, wanted)))
				&& fs::symlink_metadata(self.root().join(&path)).is_ok()
			{
				selected.insert(path);
			}
		}
		index.remove_entries(|_, path, _| {
			let path = path.to_str_lossy();
			(all
				|| requested
					.iter()
					.any(|wanted| stage_path_matches(&path, wanted)))
				&& !selected.contains(path.as_ref())
		});
		let (mut filter, filter_index) = repo
			.filter_pipeline(None)
			.map_err(|err| Error::backend("git add", err))?;
		// Hash every selected path first, then rewrite the index in one pass:
		// removing entries path by path rescans the whole index each time.
		let mut replaced = std::collections::HashSet::<BString>::new();
		let mut staged = Vec::new();
		for path in selected {
			match stage_one(self.root(), &mut filter, &filter_index, &path, staging_started)? {
				Staged::Entry(entry) => {
					replaced.insert(path.into());
					staged.push(entry);
				},
				Staged::Removed => {
					replaced.insert(path.into());
				},
				Staged::Kept => {},
			}
		}
		index.remove_entries(|_, path, _| replaced.contains(path));
		// A kept entry's stat as new as the old index is racy: only that
		// index's timestamp makes git re-check the file's content, and the
		// index written here is newer, so the stat is dropped to keep the
		// check (git smudges such entries when it writes an index).
		let racy_from = index.timestamp();
		for entry in index.entries_mut() {
			if entry.stat.is_racy(racy_from, Default::default()) {
				entry.stat = gix::index::entry::Stat::default();
			}
		}
		for entry in staged {
			index.dangerously_push_entry(
				entry.stat,
				entry.id,
				gix::index::entry::Flags::empty(),
				entry.mode,
				entry.path.as_bstr(),
			);
		}
		index.sort_entries();
		index
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git add", err))
	}

	/// Reset selected index entries to HEAD while preserving the worktree.
	pub fn unstage(&self, files: &[String]) -> Result<()> {
		let repo = self.gix()?;
		let head = head_tree(&repo)?;
		let head_index = index_for_tree(&repo, head.as_ref())?;
		let mut current = load_index_or_head(&repo, "git reset")?;
		copy_index_paths(&mut current, &head_index, files);
		current
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git reset", err))
	}

	/// Create a commit and return its object id. With `commit.gpgSign` enabled
	/// the object is written by `git commit-tree -S` so Git runs the
	/// configured signer; a signer failure leaves HEAD unchanged.
	pub fn commit_create(&self, message: &str, options: &CommitOptions) -> Result<String> {
		let repo = self.gix()?;
		// Git rejects a malformed value before doing any work; reading it as
		// `false` would silently write unsigned commits.
		let sign = repo
			.config_snapshot()
			.try_boolean("commit.gpgSign")
			.transpose()
			.map_err(|err| Error::backend("git commit read commit.gpgSign", err))?
			.unwrap_or(false);
		run_commit_hook(self, "pre-commit", &[])?;
		let mut head = repo
			.head()
			.map_err(|err| Error::backend("git commit", err))?;
		let old_commit = head
			.try_peel_to_id()
			.map_err(|err| Error::backend("git commit", err))?
			.map(|id| id.detach());
		let index = load_index_or_head(&repo, "git commit")?;
		let tree = if options.files.is_empty() {
			write_index_tree(&repo, &index)?
		} else {
			let base = index_for_tree(
				&repo,
				old_commit
					.as_ref()
					.map(|id| commit_tree(&repo, id))
					.transpose()?
					.as_ref(),
			)?;
			let mut partial = base;
			copy_index_paths(&mut partial, &index, &options.files);
			write_index_tree(&repo, &partial)?
		};
		let (parents, inherited_author) = if options.amend {
			let id = old_commit
				.ok_or_else(|| Error::backend("git commit", "cannot amend an unborn HEAD"))?;
			let commit = repo
				.find_commit(id)
				.map_err(|err| Error::backend("git commit", err))?;
			let parents: Vec<gix::hash::ObjectId> =
				commit.parent_ids().map(|id| id.detach()).collect();
			let author = commit
				.author()
				.map_err(|err| Error::backend("git commit", err))?
				.to_owned()
				.map_err(|err| Error::backend("git commit", err))?;
			(parents, Some(author))
		} else {
			(old_commit.into_iter().collect(), None)
		};
		if !options.allow_empty {
			if let Some(parent) = parents.first() {
				if commit_tree(&repo, parent)? == tree {
					return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
				}
			} else if tree == repo.empty_tree().id {
				return Err(Error::backend("git commit", "nothing to commit, working tree clean"));
			}
		}
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git commit", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git commit", err))?;
		let override_author = options.author.as_ref().map(signature_for).transpose()?;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = override_author.as_ref() {
			author.to_ref(&mut author_time)
		} else if let Some(author) = inherited_author.as_ref() {
			author.to_ref(&mut author_time)
		} else {
			repo
				.author()
				.ok_or_else(|| Error::backend("git commit", "author identity is not configured"))?
				.map_err(|err| Error::backend("git commit", err))?
		};
		let message_path = self.info().git_dir.join("COMMIT_EDITMSG");
		fs::write(&message_path, message)?;
		run_commit_hook(self, "commit-msg", &[message_path.as_os_str()])?;
		let message = fs::read_to_string(&message_path)
			.map_err(|err| Error::backend("git commit read commit-msg result", err))?;
		let id = if sign {
			sign_commit(self, &message, tree, &parents, author, committer)?
		} else {
			repo
				.new_commit_as(committer, author, message, tree, parents)
				.map_err(|err| Error::backend("git commit", err))?
				.id
		};
		let expected = old_commit
			.map_or(gix::refs::transaction::PreviousValue::MustNotExist, |old| {
				gix::refs::transaction::PreviousValue::MustExistAndMatch(old.into())
			});
		repo
			.edit_reference(gix::refs::transaction::RefEdit {
				change: gix::refs::transaction::Change::Update {
					log: gix::refs::transaction::LogChange {
						mode:                gix::refs::transaction::RefLog::AndReference,
						force_create_reflog: false,
						message:             if options.amend {
							"commit (amend)"
						} else {
							"commit"
						}
						.into(),
					},
					expected,
					new: gix::refs::Target::Object(id),
				},
				name:   "HEAD"
					.try_into()
					.map_err(|err| Error::backend("git commit", err))?,
				deref:  true,
			})
			.map_err(|err| Error::backend("git commit", err))?;
		let _ = run_commit_hook(self, "post-commit", &[]);
		Ok(id.to_hex().to_string())
	}

	/// Write a commit object for `tree` on top of `parents` without touching
	/// HEAD, the index, any ref, or the worktree (`git commit-tree`). No hooks
	/// run. Returns the new commit id.
	pub fn commit_tree(
		&self,
		tree: &str,
		parents: &[String],
		message: &str,
		author: Option<&CommitAuthor>,
	) -> Result<String> {
		let repo = self.gix()?;
		let tree = resolve_tree(&repo, tree)?;
		let parents = parents
			.iter()
			.map(|parent| resolve_commit(&repo, parent))
			.collect::<Result<Vec<_>>>()?;
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git commit-tree", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git commit-tree", err))?;
		let override_author = author.map(signature_for).transpose()?;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = override_author.as_ref() {
			author.to_ref(&mut author_time)
		} else {
			repo
				.author()
				.ok_or_else(|| Error::backend("git commit-tree", "author identity is not configured"))?
				.map_err(|err| Error::backend("git commit-tree", err))?
		};
		let commit = repo
			.new_commit_as(committer, author, message, tree, parents)
			.map_err(|err| Error::backend("git commit-tree", err))?;
		Ok(commit.id.to_hex().to_string())
	}

	/// Checkout a branch or detached revision without overwriting local changes.
	pub fn checkout(&self, rev: &str) -> Result<()> {
		let repo = self.gix()?;
		let (target, symbolic) = resolve_checkout_target(&repo, rev)?;
		checkout_tree(self, &repo, target, false)?;
		write_head(self.info().head_path.as_path(), symbolic.as_deref(), target)?;
		Ok(())
	}

	/// Create or force-move a local branch.
	pub fn create_branch(&self, name: &str, start: &str, force: bool) -> Result<()> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, start)?;
		let full = format!("refs/heads/{name}");
		if force && branch_is_checked_out(&self.info().common_dir, &full) {
			return Err(Error::backend(
				"git branch",
				format!(
					"cannot force update the branch '{name}' checked out at '{}'",
					self.root().display()
				),
			));
		}
		let constraint = if force {
			gix::refs::transaction::PreviousValue::Any
		} else {
			gix::refs::transaction::PreviousValue::MustNotExist
		};
		// git's reflog tells a `-f` move apart from a creation.
		let exists = force
			&& repo
				.try_find_reference(&full)
				.map_err(|e| Error::backend("git branch", e))?
				.is_some();
		let message = if exists {
			format!("branch: Reset to {start}")
		} else {
			format!("branch: Created from {start}")
		};
		update_reference(&repo, "git branch", &full, id, constraint, &message, false)?;
		Ok(())
	}

	/// Delete a local branch, returning false for missing or unsafe deletion.
	///
	/// Once the ref is deleted, every `[branch "<name>"]` section is removed
	/// from the shared config (as `git branch -D` does); a missing,
	/// checked-out or unmerged (without `force`) branch leaves the config
	/// untouched. A failure to rewrite the config does not undo or fail the
	/// deletion.
	pub fn delete_branch(&self, name: &str, force: bool) -> Result<bool> {
		let repo = self.gix()?;
		let full = format!("refs/heads/{name}");
		if branch_is_checked_out(&self.info().common_dir, &full) {
			return Ok(false);
		}
		let Ok(mut reference) = repo.find_reference(&full) else {
			return Ok(false);
		};
		let id = match reference.peel_to_id() {
			Ok(id) => id.detach(),
			Err(_) => return Ok(false),
		};
		if !force {
			let Ok(head) = repo.head_commit() else {
				return Ok(false);
			};
			let mut walk = head
				.ancestors()
				.all()
				.map_err(|err| Error::backend("git branch", err))?;
			let merged = walk.any(|item| item.is_ok_and(|info| info.id == id));
			if !merged {
				return Ok(false);
			}
		}
		let edit = gix::refs::transaction::RefEdit {
			change: gix::refs::transaction::Change::Delete {
				expected: gix::refs::transaction::PreviousValue::MustExistAndMatch(id.into()),
				log:      gix::refs::transaction::RefLog::AndReference,
			},
			name:   full
				.try_into()
				.map_err(|err| Error::backend("git branch", err))?,
			deref:  false,
		};
		if repo.edit_reference(edit).is_err() {
			return Ok(false);
		}
		// `git branch -D` also drops the branch's config; the ref is already
		// gone, so a config failure must not report the deletion as failed.
		let _ = remove_config_sections(&self.info().common_dir.join("config"), "branch", name);
		Ok(true)
	}

	/// Compare-and-swap `refs/heads/<name>`, performed by `git update-ref`.
	///
	/// `expected: None` requires the branch to be absent; `Some(oid)` requires
	/// it to resolve to exactly that full object id. `target: Some(rev)` sets
	/// the branch to that commit (reflog entry `omp: restore branch`);
	/// `None` deletes it and, once deleted, removes its `[branch "<name>"]`
	/// config sections like [`Self::delete_branch`]. Returns `Ok(false)`,
	/// changing nothing, when `expected` does not hold or when `expected` is
	/// `Some` and the branch is checked out in any worktree. Both `None` is
	/// the no-op "make it absent": `Ok(true)` when already absent, else
	/// `Ok(false)`. An unparsable `expected` or unresolvable `target` is an
	/// error.
	///
	/// The git binary is required: `update-ref` takes the ref lock first and
	/// verifies the old value under it, so a concurrent git writer is never
	/// overwritten, and it handles packed refs and reftable. The checked-out
	/// check and the update run under the cross-process worktree-add lock, so
	/// a native [`Self::worktree_add`] cannot register a worktree on the
	/// branch in between; a plain `git worktree add` does not take that lock.
	pub fn swap_branch(
		&self,
		name: &str,
		expected: Option<&str>,
		target: Option<&str>,
	) -> Result<bool> {
		let full = format!("refs/heads/{name}");
		if expected.is_none() && target.is_none() {
			return Ok(self.resolve_ref(&full)?.is_none());
		}
		let repo = self.gix()?;
		let expected_id = expected
			.map(|oid| {
				gix::hash::ObjectId::from_hex(oid.as_bytes())
					.map_err(|err| Error::backend("git branch", err))
			})
			.transpose()?;
		let new = target.map(|rev| resolve_commit(&repo, rev)).transpose()?;
		let _add_lock = if expected_id.is_some() {
			Some(lock_worktree_adds(&self.info().common_dir)?)
		} else {
			None
		};
		if expected_id.is_some() && branch_is_checked_out(&self.info().common_dir, &full) {
			return Ok(false);
		}
		let old = expected_id
			.unwrap_or_else(|| gix::hash::ObjectId::null(repo.object_hash()))
			.to_hex()
			.to_string();
		let args: Vec<String> = match new {
			Some(id) => vec![
				"update-ref".to_owned(),
				"-m".to_owned(),
				"omp: restore branch".to_owned(),
				full.clone(),
				id.to_hex().to_string(),
				old,
			],
			None => vec!["update-ref".to_owned(), "-d".to_owned(), full.clone(), old],
		};
		let output = super::cli::run_sync_write(
			self.root(),
			&args,
			super::cli::SYNC_TIMEOUT,
			&super::cli::SyncWrite { stdin: &[], env: &[] },
		)?;
		if output.exit_code != 0 {
			// A rejected old value and a real failure both exit non-zero; the
			// ref's current value tells them apart without parsing stderr.
			let current = self.resolve_ref(&full)?;
			let expected_hex = expected_id.map(|id| id.to_hex().to_string());
			if current != expected_hex {
				return Ok(false);
			}
			output.into_checked(&args)?;
		}
		if new.is_none() {
			let _ = remove_config_sections(&self.info().common_dir.join("config"), "branch", name);
		}
		Ok(true)
	}

	/// Create a branch at HEAD and switch to it without touching files.
	pub fn checkout_new_branch(&self, name: &str) -> Result<()> {
		self.create_branch(name, "HEAD", false)?;
		fs::write(&self.info().head_path, format!("ref: refs/heads/{name}\n"))?;
		Ok(())
	}

	/// Restore index and/or worktree paths from a selected source.
	pub fn restore(&self, options: &RestoreOptions) -> Result<()> {
		let repo = self.gix()?;
		let restore_worktree = options.worktree || !options.staged;
		let mut index = load_index_or_head(&repo, "git restore")?;
		if options.staged {
			let source = resolve_tree(&repo, options.source.as_deref().unwrap_or("HEAD"))?;
			let source_index = index_for_tree(&repo, Some(&source))?;
			copy_index_paths(&mut index, &source_index, &options.files);
			index
				.write(INDEX_WRITE)
				.map_err(|e| Error::backend("git restore", e))?;
		}
		if restore_worktree {
			let source_index = if let Some(source) = options.source.as_deref() {
				index_for_tree(&repo, Some(&resolve_tree(&repo, source)?))?
			} else {
				index
			};
			restore_index_paths(self.root(), &repo, &source_index, &options.files)?;
		}
		Ok(())
	}

	/// Reset HEAD, index, and optionally the worktree to a target commit.
	pub fn reset(&self, mode: ResetMode, target: Option<&str>) -> Result<()> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, target.unwrap_or("HEAD"))?;
		if mode == ResetMode::Hard {
			checkout_tree(self, &repo, id, true)?;
		} else if mode == ResetMode::Mixed {
			self.read_tree(&id.to_hex().to_string(), None)?;
		}
		update_current_head(&repo, &self.info().head_path, id)?;
		Ok(())
	}

	/// Remove untracked files and directories according to ignore mode.
	pub fn clean(&self, options: &CleanOptions) -> Result<()> {
		// `.` (and `./`) normalize to "" and mean "everything", so they drop out
		// of the restriction set. A literally empty string is rejected the way
		// git rejects it instead of silently widening to the whole worktree.
		let mut paths = BTreeSet::new();
		for raw in &options.paths {
			if raw.is_empty() {
				return Err(Error::backend("git clean", "empty string is not a valid pathspec"));
			}
			let normalized = normalize_stage_path(raw);
			if !normalized.is_empty() {
				paths.insert(normalized);
			}
		}

		// Fresh open: the cached handle snapshots config, so a
		// `core.excludesFile` configured after first use would be missed and
		// its excluded files deleted.
		let repo = self.gix_fresh()?;
		let mut platform =
			status_with_index(&repo, "git clean", load_index_or_head(&repo, "git clean")?)?
				.untracked_files(gix::status::UntrackedFiles::Files);
		let emit_ignored = options.include_ignored || options.ignored_only;
		let for_deletion = if emit_ignored {
			gix::dir::walk::ForDeletionMode::FindNonBareRepositoriesInIgnoredDirectories
		} else {
			gix::dir::walk::ForDeletionMode::IgnoredDirectoriesCanHideNestedRepositories
		};
		platform = platform.dirwalk_options(|opts| {
			let opts = opts
				.emit_empty_directories(true)
				.for_deletion(Some(for_deletion));
			if emit_ignored {
				opts.emit_ignored(Some(gix::dir::walk::EmissionMode::Matching))
			} else {
				opts
			}
		});

		let iter = platform
			.into_index_worktree_iter(
				paths
					.iter()
					.map(|path| literal_pathspec(path).into_bytes().into()),
			)
			.map_err(|e| Error::backend("git clean", e))?;

		for item in iter {
			let item = item.map_err(|e| Error::backend("git clean", e))?;
			let gix::status::index_worktree::Item::DirectoryContents { entry, .. } = item else {
				continue;
			};
			if entry.disk_kind == Some(gix::dir::entry::Kind::Repository) {
				continue;
			}
			let wanted = if options.ignored_only {
				matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else if options.include_ignored {
				entry.status == gix::dir::entry::Status::Untracked
					|| matches!(entry.status, gix::dir::entry::Status::Ignored(_))
			} else {
				entry.status == gix::dir::entry::Status::Untracked
			};
			if !wanted {
				continue;
			}
			let full = self.root().join(entry.rela_path.to_str_lossy().as_ref());
			remove_existing(&full)?;
			prune_empty_parents(self.root(), full.parent(), &paths)?;
		}
		Ok(())
	}

	/// Replace an index file with the entries from `treeish`.
	pub fn read_tree(&self, treeish: &str, index_path: Option<&Path>) -> Result<()> {
		let repo = self.gix()?;
		let tree = resolve_tree(&repo, treeish)?;
		let mut index = repo
			.index_from_tree(&tree)
			.map_err(|e| Error::backend("git read-tree", e))?;
		if let Some(path) = index_path {
			index.set_path(path);
		}
		index
			.write(INDEX_WRITE)
			.map_err(|e| Error::backend("git read-tree", e))
	}

	/// Write an index as a tree object and return its object id.
	pub fn write_tree(&self, index_path: Option<&Path>) -> Result<String> {
		let repo = self.gix()?;
		let index = match index_path {
			Some(path) => gix::index::File::at(path, repo.object_hash(), false, Default::default())
				.map_err(|e| Error::backend("git write-tree", e))?,
			None => repo
				.open_index()
				.map_err(|e| Error::backend("git write-tree", e))?,
		};
		Ok(write_index_tree(&repo, &index)?.to_hex().to_string())
	}

	/// Set one repository-local configuration value while preserving formatting.
	pub fn config_set(&self, key: &str, value: &str) -> Result<()> {
		set_config_file(&self.info().common_dir.join("config"), key, value)
	}

	/// Add a remote idempotently when its URL already matches.
	pub fn remote_add(&self, name: &str, url: &str) -> Result<()> {
		let key = format!("remote.{name}.url");
		let repo = self.gix()?;
		if let Some(existing) = repo.config_snapshot().string(&key) {
			let existing = existing.to_str_lossy();
			if existing == url {
				return Ok(());
			}
			return Err(Error::backend(
				"git remote add",
				format!("remote {name} already exists with URL {existing}, expected {url}"),
			));
		}
		self.config_set(&key, url)
	}

	/// Create a linked worktree and materialize its checkout.
	pub fn worktree_add(
		&self,
		path: &Path,
		ref_name: &str,
		options: WorktreeAddOptions,
	) -> Result<WorktreeAddResult> {
		// Another omp process adding the same path at once would otherwise
		// register into the same directory.
		let _add_lock = lock_worktree_adds(&self.info().common_dir)?;
		let repo = self.gix()?;
		let id = resolve_commit(&repo, ref_name)?;
		if path.exists() && fs::read_dir(path)?.next().is_some() {
			return Err(Error::backend(
				"git worktree add",
				"destination already exists and is not empty",
			));
		}
		if options.keep_changes {
			let source_head = repo
				.head_id()
				.map_err(|e| Error::backend("git worktree add", e))?
				.detach();
			if source_head != id {
				return Err(Error::backend(
					"git worktree add",
					"keeping uncommitted changes requires the target to be the source HEAD",
				));
			}
		}
		let head = if options.detach {
			id.to_hex().to_string()
		} else {
			let full = if ref_name.starts_with("refs/heads/") {
				ref_name.to_owned()
			} else {
				format!("refs/heads/{ref_name}")
			};
			if branch_is_checked_out(&self.info().common_dir, &full) {
				return Err(Error::backend(
					"git worktree add",
					format!("'{full}' is already checked out"),
				));
			}
			if repo
				.try_find_reference(&full)
				.map_err(|e| Error::backend("git worktree add", e))?
				.is_none()
			{
				update_reference(
					&repo,
					"git worktree add",
					full.as_str(),
					id,
					gix::refs::transaction::PreviousValue::MustNotExist,
					"branch: Created from worktree add",
					false,
				)?;
			}
			format!("ref: {full}")
		};

		let preferred = match options.clone {
			WorktreeClone::Off => None,
			WorktreeClone::Auto => Some(None),
			WorktreeClone::Prefer(kind) => Some(Some(kind)),
		};
		let mut clone_error = None;
		let owner = options.setup_owner.as_deref();
		if let Some(preferred) = preferred {
			for kind in pi_iso::clone_candidates(preferred) {
				match self.worktree_add_cloned(path, id, &head, kind, options.keep_changes, owner) {
					Ok(admin) => {
						finish_worktree_add(path, &admin)?;
						return Ok(WorktreeAddResult { cloned_with: Some(kind), clone_error });
					},
					Err(err) => {
						clone_error = Some(err.to_string());
						cleanup_worktree_add(path, &self.info().common_dir);
					},
				}
			}
		}

		fs::create_dir_all(path)?;
		let admin = register_worktree(path, &self.info().common_dir, &head, owner)?;
		let materialized: Result<()> = (|| {
			let linked = Self::require(path)?;
			let linked_repo = linked.gix()?;
			checkout_tree(&linked, &linked_repo, id, true)?;
			if options.keep_changes {
				self.seed_worktree_changes(path, &admin, id)?;
			}
			Ok(())
		})();
		if let Err(err) = materialized {
			// Left registered, as before, but neither being created nor set up any
			// more.
			let _ = end_setup_admin(&admin);
			let _ = unlock_admin(&admin);
			return Err(err);
		}
		// Created: lifted as git lifts it, before any hook runs. A setup mark
		// stays.
		finish_worktree_add(path, &admin)?;
		Ok(WorktreeAddResult { cloned_with: None, clone_error })
	}

	/// Replicate the source checkout's uncommitted state onto a worktree at
	/// `path` freshly checked out at the source `HEAD` (`head_commit`): copy
	/// every staged, dirty tracked, and untracked file (deleting what the
	/// source deleted), then install the source index so staged hunks stay
	/// staged, with its stat cache rebased onto the files now on disk.
	fn seed_worktree_changes(
		&self,
		path: &Path,
		admin: &Path,
		head_commit: gix::hash::ObjectId,
	) -> Result<()> {
		let repo = self.gix()?;
		let (dirty_tracked, untracked) = collect_clone_reconciliation_paths(&repo)?;
		// One snapshot of the source index decides which paths to copy and is
		// what gets installed, so a concurrent `git add` in the source cannot
		// split the two.
		let source_index = if self.info().git_dir.join("index").is_file() {
			Some(load_index_or_empty(&repo, "git worktree add")?)
		} else {
			None
		};
		// The checkout wrote `HEAD` content, so paths whose index entry differs
		// from `HEAD` (staged edits, additions, and deletions) need the source
		// bytes too, even when the source worktree matches its index.
		let staged = match &source_index {
			Some(source_index) => {
				let head_index = repo
					.index_from_tree(&commit_tree(&repo, &head_commit)?)
					.map_err(|err| Error::backend("git worktree add", err))?;
				index_diff_paths(source_index, &head_index)
			},
			None => BTreeSet::new(),
		};

		for relative in dirty_tracked.iter().chain(&untracked).chain(&staged) {
			let relative = relative.to_path_lossy();
			let src = self.root().join(&relative);
			let dst = path.join(&relative);
			match fs::symlink_metadata(&src) {
				Ok(meta) if meta.file_type().is_symlink() => {
					remove_existing(&dst)?;
					if let Some(parent) = dst.parent() {
						fs::create_dir_all(parent)?;
					}
					copy_symlink(&src, &dst)?;
				},
				Ok(meta) if meta.is_file() => {
					remove_existing(&dst)?;
					if let Some(parent) = dst.parent() {
						fs::create_dir_all(parent)?;
					}
					fs::copy(&src, &dst)?;
				},
				Ok(_) => {},
				Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
					remove_existing(&dst)?;
					prune_empty_parents(path, dst.parent(), &BTreeSet::new())?;
				},
				Err(err) => return Err(err.into()),
			}
		}
		let Some(mut index) = source_index else {
			return Ok(());
		};
		// The source stat cache describes the source files. Checkout filters
		// (e.g. `core.autocrlf`) can write clean files at a different size, and
		// git reports a size mismatch as modified without hashing the content.
		refresh_clean_index_stats(&mut index, path, &dirty_tracked)?;
		index.set_path(admin.join("index"));
		index
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git worktree add", err))
	}

	/// Returns the new worktree's administration directory.
	fn worktree_add_cloned(
		&self,
		path: &Path,
		id: gix::hash::ObjectId,
		head: &str,
		kind: pi_iso::BackendKind,
		keep_changes: bool,
		setup_owner: Option<&str>,
	) -> Result<PathBuf> {
		let repo = self.gix()?;
		for key in ["core.sparseCheckout", "core.splitIndex"] {
			if repo.config_snapshot().string(key).is_some_and(|value| {
				!matches!(value.to_str_lossy().as_ref(), "false" | "no" | "off" | "0")
			}) {
				return Err(Error::backend("git worktree add", format!("{key} is enabled")));
			}
		}
		let source_index = self.info().git_dir.join("index");
		if !source_index.is_file() {
			return Err(Error::backend("git worktree add", "source index is missing"));
		}

		pi_iso::backend(kind)
			.clone_tree(self.root(), path, &[OsStr::new(".git")])
			.map_err(|err| Error::backend("git worktree add", err))?;
		let admin = register_worktree(path, &self.info().common_dir, head, setup_owner)?;
		fs::copy(&source_index, admin.join("index"))?;

		let (dirty_tracked, untracked) = collect_clone_reconciliation_paths(&repo)?;
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		let mut current = load_index_or_empty(&linked_repo, "git worktree add")?;
		if keep_changes {
			// The clone already mirrors the source's live tree and the copied
			// index carries its staged state. Only the stat cache is stale
			// (new inodes); refresh it for entries the source reports clean so
			// dirty files still hash on the next status.
			refresh_clean_index_stats(&mut current, path, &dirty_tracked)?;
			current
				.write(INDEX_WRITE)
				.map_err(|err| Error::backend("git worktree add", err))?;
			return Ok(admin);
		}
		let tree = commit_tree(&linked_repo, &id)?;
		let mut target = linked_repo
			.index_from_tree(&tree)
			.map_err(|err| Error::backend("git worktree add", err))?;

		let differing = index_diff_paths(&current, &target);
		let (write_paths, removed): (BTreeSet<BString>, BTreeSet<BString>) = differing
			.into_iter()
			.partition(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_some());
		let mut delete = removed;
		delete.extend(untracked);
		delete.extend(
			dirty_tracked
				.iter()
				.filter(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_none())
				.cloned(),
		);

		let mut write = write_paths;
		write.extend(
			dirty_tracked
				.iter()
				.filter(|entry_path| target.entry_by_path(entry_path.as_bstr()).is_some())
				.cloned(),
		);

		for relative in &delete {
			let full = path.join(relative.to_path_lossy());
			match fs::remove_file(&full) {
				Ok(()) => prune_empty_parents(path, full.parent(), &BTreeSet::new())?,
				Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
				Err(err) => return Err(err.into()),
			}
		}

		// `remove_entries` keeps the path backing even when it drops every
		// entry, and gix's checkout asserts the two are empty together; a
		// clone that already matches the target tree must not enter it.
		let changed = if write.is_empty() {
			None
		} else {
			let mut changed = target.clone();
			changed.remove_entries(|_, entry_path, _| !write.contains(entry_path));
			let mut checkout_options = linked_repo
				.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
				.map_err(|err| Error::backend("git worktree add", err))?;
			checkout_options.overwrite_existing = true;
			let progress = gix::progress::Discard;
			let interrupt = std::sync::atomic::AtomicBool::new(false);
			let outcome = gix::worktree::state::checkout(
				&mut changed,
				path,
				linked_repo
					.objects
					.into_arc()
					.map_err(|err| Error::backend("git worktree add", err))?,
				&progress,
				&progress,
				&interrupt,
				checkout_options,
			)
			.map_err(|err| Error::backend("git worktree add", err))?;
			if !outcome.collisions.is_empty() || !outcome.errors.is_empty() {
				return Err(Error::backend(
					"git worktree add",
					format!(
						"checkout reported {} collisions and {} errors",
						outcome.collisions.len(),
						outcome.errors.len()
					),
				));
			}
			Some(changed)
		};

		for (entry, entry_path) in target.entries_mut_with_paths() {
			if let Some(written) = changed
				.as_ref()
				.and_then(|changed| changed.entry_by_path(entry_path))
			{
				entry.stat = written.stat;
			} else {
				let metadata = gix::index::fs::Metadata::from_path_no_follow(
					&path.join(entry_path.to_path_lossy()),
				)?;
				entry.stat = gix::index::entry::Stat::from_fs(&metadata)
					.map_err(|err| Error::backend("git worktree add", err))?;
			}
		}
		target
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git worktree add", err))?;
		Ok(admin)
	}

	/// Where git's `find_hook` looks for hook `name`, whether or not a file
	/// exists there: under `core.hooksPath` (path-valued, so `~/` and
	/// `%(prefix)/` expand; a relative value resolves against the checkout
	/// root) or else the shared `hooks` directory, which linked worktrees read
	/// from the common dir.
	pub fn hook_location(&self, name: &str) -> Result<PathBuf> {
		let repo = self.gix()?;
		let snapshot = repo.config_snapshot();
		let dir = match snapshot.trusted_path("core.hooksPath") {
			Some(Ok(value)) => self.root().join(value),
			// Not expandable (e.g. `~unknown-user/`): use it literally rather
			// than failing every caller.
			Some(Err(_)) => self.root().join(
				snapshot
					.string("core.hooksPath")
					.map_or_else(String::new, |value| value.to_str_lossy().into_owned()),
			),
			None => self.info().common_dir.join("hooks"),
		};
		Ok(dir.join(name))
	}

	/// Resolve the executable hook `name` as git's `find_hook` does (see
	/// [`Self::hook_location`]). `None` when the hook is missing or not
	/// executable.
	pub fn hook_path(&self, name: &str) -> Result<Option<PathBuf>> {
		let hook = self.hook_location(name)?;
		Ok(hook_is_executable(&hook).then_some(hook))
	}

	/// Remove a linked worktree, returning false when dirty and not forced, or
	/// when `path` is not itself a discoverable worktree (its `.git` is gone and
	/// an enclosing checkout would be found instead).
	pub fn worktree_remove(&self, path: &Path, force: bool) -> Result<bool> {
		let Some(linked) = Self::discover(path)? else {
			return Ok(false);
		};
		let real = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| normalize_path(p));
		if real(&linked.info().repo_root) != real(path) {
			return Ok(false);
		}
		if !force && tracked_worktree_dirty(&linked)? {
			return Ok(false);
		}
		let admin = linked.info().git_dir.clone();
		fs::remove_dir_all(path)?;
		if admin.starts_with(self.info().common_dir.join("worktrees")) {
			fs::remove_dir_all(admin)?;
		}
		Ok(true)
	}

	/// Prune linked-worktree administration entries whose back-reference
	/// vanished. Locked entries and entries still being set up (setup mark) are
	/// kept: their worktree may sit on a volume that is offline.
	pub fn worktree_prune(&self) -> Result<()> {
		let root = self.info().common_dir.join("worktrees");
		let Ok(entries) = fs::read_dir(&root) else {
			return Ok(());
		};
		for entry in entries {
			let entry = entry?;
			if entry.path().join("locked").exists() || entry.path().join(SETUP_MARK).exists() {
				continue;
			}
			let back = fs::read_to_string(entry.path().join("gitdir")).unwrap_or_default();
			if back.trim().is_empty() || !Path::new(back.trim()).exists() {
				fs::remove_dir_all(entry.path())?;
			}
		}
		Ok(())
	}

	/// Clear the setup mark [`WorktreeAddOptions::setup_owner`] left on the
	/// worktree at `path`, also once its `.git` is gone.
	pub fn worktree_end_setup(&self, path: &Path) -> Result<()> {
		match self.worktree_admin(path)? {
			Some(admin) => end_setup_admin(&admin),
			None => Ok(()),
		}
	}

	/// Compare-and-swap of the setup mark in the administration directory
	/// `git_dir`, atomic against worktree adds and other swaps, so two processes
	/// recovering one stale setup can't both act on it, and a mark is cleared
	/// only while it is still the expected owner's. `replacement` `None` removes
	/// it. Returns false, changing nothing, when the mark is missing or another
	/// owner's.
	pub fn worktree_replace_setup_owner(
		&self,
		git_dir: &Path,
		expected: &str,
		replacement: Option<&str>,
	) -> Result<bool> {
		let common = &self.info().common_dir;
		let _add_lock = lock_worktree_adds(common)?;
		let worktrees = fs::canonicalize(common.join("worktrees"))?;
		// Already gone (removed with its worktree): nothing to swap.
		let admin = match fs::canonicalize(git_dir) {
			Ok(admin) => admin,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
			Err(err) => return Err(err.into()),
		};
		if admin.parent() != Some(worktrees.as_path()) {
			return Err(Error::backend(
				"git worktree setup",
				format!("{} is not a worktree administration directory", git_dir.display()),
			));
		}
		if read_setup_mark(&admin)?.as_deref() != Some(expected) {
			return Ok(false);
		}
		match replacement {
			Some(owner) => {
				let temp = admin.join(format!("{SETUP_MARK}.tmp-{}", std::process::id()));
				fs::write(&temp, format!("{owner}\n"))?;
				if let Err(err) = fs::rename(&temp, admin.join(SETUP_MARK)) {
					let _ = fs::remove_file(&temp);
					return Err(err.into());
				}
			},
			None => remove_if_present(&admin.join(SETUP_MARK))?,
		}
		Ok(true)
	}

	/// Administration directory of the linked worktree at `path`: the one its
	/// `.git` names, else (it is gone) the registration pointing at it.
	pub(crate) fn worktree_admin(&self, path: &Path) -> Result<Option<PathBuf>> {
		let worktrees = self.info().common_dir.join("worktrees");
		if let Ok(Some(admin)) = registered_admin(&path.join(".git"))
			&& admin.starts_with(&worktrees)
		{
			return Ok(Some(admin));
		}
		let target = normalize_path(&path.join(".git"));
		let Ok(entries) = fs::read_dir(&worktrees) else {
			return Ok(None);
		};
		for entry in entries {
			let admin = entry?.path();
			let back = fs::read_to_string(admin.join("gitdir")).unwrap_or_default();
			if normalize_path(Path::new(back.trim())) == target {
				return Ok(Some(admin));
			}
		}
		Ok(None)
	}
}

fn remove_if_present(file: &Path) -> Result<()> {
	match fs::remove_file(file) {
		Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
		_ => Ok(()),
	}
}

fn unlock_admin(admin: &Path) -> Result<()> {
	remove_if_present(&admin.join("locked"))
}

fn end_setup_admin(admin: &Path) -> Result<()> {
	remove_if_present(&admin.join(SETUP_MARK))
}

fn run_commit_hook(repository: &GitRepo, name: &str, args: &[&OsStr]) -> Result<()> {
	let Some(hook) = repository.hook_path(name)? else {
		return Ok(());
	};
	// Windows CreateProcess cannot execute a shebang script directly. Let Git
	// invoke the hook through its own shell, as `git commit` does.
	#[cfg(windows)]
	let mut command = {
		let _ = hook;
		let mut command = Command::new("git");
		command.args(["hook", "run", "--ignore-missing", name, "--"]);
		command
	};
	#[cfg(not(windows))]
	let mut command = Command::new(&hook);
	let output = command
		.args(args)
		.current_dir(repository.root())
		.env("GIT_DIR", &repository.info().git_dir)
		.env("GIT_WORK_TREE", repository.root())
		.env("GIT_TERMINAL_PROMPT", "0")
		.stdin(Stdio::null())
		.output()
		.map_err(|err| Error::Cli {
			command:   format!("git commit ({name} hook)"),
			exit_code: 1,
			stdout:    String::new(),
			stderr:    err.to_string(),
		})?;
	if output.status.success() {
		return Ok(());
	}
	Err(Error::Cli {
		command:   format!("git commit ({name} hook)"),
		exit_code: output.status.code().unwrap_or(1),
		stdout:    String::from_utf8_lossy(&output.stdout).into_owned(),
		stderr:    String::from_utf8_lossy(&output.stderr).into_owned(),
	})
}

/// Write a signed commit object through `git commit-tree -S`, which runs the
/// signer configured by `gpg.format`/`gpg.program`/`user.signingKey`.
/// gitoxide cannot sign, so this is the one commit path that leaves the
/// process; HEAD is still updated in-process by the caller.
fn sign_commit(
	repository: &GitRepo,
	message: &str,
	tree: gix::hash::ObjectId,
	parents: &[gix::hash::ObjectId],
	author: gix::actor::SignatureRef<'_>,
	committer: gix::actor::SignatureRef<'_>,
) -> Result<gix::hash::ObjectId> {
	let mut args = vec![
		// The repository was opened with `Trust::Full`; without this override
		// git's ownership check rejects checkouts owned by another user
		// (host-mounted repositories in containers) that commit fine unsigned.
		"-c".to_owned(),
		"safe.directory=*".to_owned(),
		"commit-tree".to_owned(),
		"-S".to_owned(),
		tree.to_hex().to_string(),
	];
	for parent in parents {
		args.push("-p".to_owned());
		args.push(parent.to_hex().to_string());
	}
	// Raw `<seconds> <offset>` dates need the `@` marker: without it git falls
	// back to its approximate-date parser, which rejects timestamps under
	// nine digits.
	let author_date = format!("@{}", author.time);
	let committer_date = format!("@{}", committer.time);
	let env: [(&str, &OsStr); 6] = [
		("GIT_AUTHOR_NAME", &author.name.to_os_str_lossy()),
		("GIT_AUTHOR_EMAIL", &author.email.to_os_str_lossy()),
		("GIT_AUTHOR_DATE", author_date.as_ref()),
		("GIT_COMMITTER_NAME", &committer.name.to_os_str_lossy()),
		("GIT_COMMITTER_EMAIL", &committer.email.to_os_str_lossy()),
		("GIT_COMMITTER_DATE", committer_date.as_ref()),
	];
	// The message travels over stdin so it reaches git byte-for-byte, with no
	// file path to re-encode.
	let output = super::cli::run_sync_write(
		repository.root(),
		&args,
		super::cli::COMMAND_TIMEOUT,
		&super::cli::SyncWrite { stdin: message.as_bytes(), env: &env },
	)?
	.into_checked(&args)?;
	gix::hash::ObjectId::from_hex(output.stdout.trim().as_bytes())
		.map_err(|err| Error::backend("git commit-tree", err))
}

/// Mirrors git's `find_hook`: any failure to stat the hook (missing, or
/// `core.hooksPath` pointing at a non-directory such as `/dev/null`) means
/// "no hook", never a commit failure.
fn hook_is_executable(path: &Path) -> bool {
	let Ok(metadata) = fs::metadata(path) else {
		return false;
	};
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		metadata.is_file() && metadata.permissions().mode() & 0o111 != 0
	}
	#[cfg(not(unix))]
	{
		metadata.is_file()
	}
}

fn read_optional_file(path: &Path) -> Result<Option<Vec<u8>>> {
	match fs::read(path) {
		Ok(bytes) => Ok(Some(bytes)),
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
		Err(err) => Err(err.into()),
	}
}

/// Sever a copied linked worktree from its source metadata without copying
/// objects.
pub fn detach_git_dir(
	worktree_root: &Path,
	source_common_dir: &Path,
) -> Result<DetachGitDirResult> {
	let git_entry = worktree_root.join(".git");
	let meta = match fs::symlink_metadata(&git_entry) {
		Ok(meta) => meta,
		Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(DetachGitDirResult::NoGit),
		Err(e) => return Err(e.into()),
	};
	let source_common =
		fs::canonicalize(source_common_dir).unwrap_or_else(|_| normalize_path(source_common_dir));
	let original = GitRepo::require(worktree_root)?;
	let iso_common = fs::canonicalize(&original.info().common_dir)
		.unwrap_or_else(|_| normalize_path(&original.info().common_dir));
	if iso_common != source_common {
		return Ok(DetachGitDirResult::Independent);
	}
	let repo = original.gix()?;
	let head = read_optional_file(&original.info().head_path)?;
	let index = read_optional_file(&original.info().git_dir.join("index"))?;
	let refs = snapshot_refs(&repo)?;
	let config_values = [
		"user.name",
		"user.email",
		"core.fileMode",
		"core.splitIndex",
		"core.sparseCheckout",
		"core.sparseCheckoutCone",
	]
	.into_iter()
	.filter_map(|key| {
		repo
			.config_snapshot()
			.string(key)
			.map(|v| (key, v.to_str_lossy().into_owned()))
	})
	.collect::<Vec<_>>();
	let shared = copy_named_files(&original.info().git_dir, "sharedindex.")?;
	let sparse = read_optional_file(&original.info().git_dir.join("info/sparse-checkout"))?;
	let shallow = read_optional_file(&source_common.join("shallow"))?;
	let own_admin = if meta.is_file() {
		registered_admin(&git_entry)?
	} else {
		None
	};
	if meta.is_dir() {
		fs::remove_dir_all(&git_entry)?;
	} else {
		fs::remove_file(&git_entry)?;
	}
	if let Some(admin) = own_admin {
		fs::remove_dir_all(admin)?;
	}
	gix::init(worktree_root).map_err(|e| Error::backend("git init", e))?;
	let objects_info = git_entry.join("objects/info");
	fs::create_dir_all(&objects_info)?;
	let mut alternates = vec![source_common.join("objects")];
	if let Ok(chained) = fs::read_to_string(source_common.join("objects/info/alternates")) {
		for line in chained
			.lines()
			.map(str::trim)
			.filter(|line| !line.is_empty())
		{
			let path = Path::new(line);
			alternates.push(if path.is_absolute() {
				path.to_owned()
			} else {
				source_common.join("objects").join(path)
			});
		}
	}
	let alternate_text = alternates
		.iter()
		.map(|p| p.to_string_lossy())
		.collect::<Vec<_>>()
		.join("\n")
		+ "\n";
	fs::write(objects_info.join("alternates"), alternate_text)?;
	for (name, id) in refs {
		write_loose_ref(&git_entry, &name, id)?;
	}
	if let Some(head) = head {
		fs::write(git_entry.join("HEAD"), head)?;
	}
	for (key, value) in config_values {
		set_config_file(&git_entry.join("config"), key, &value)?;
	}
	if let Some(bytes) = shallow {
		fs::write(git_entry.join("shallow"), bytes)?;
	}
	if let Some(bytes) = sparse {
		fs::create_dir_all(git_entry.join("info"))?;
		fs::write(git_entry.join("info/sparse-checkout"), bytes)?;
	}
	for (name, bytes) in shared {
		fs::write(git_entry.join(name), bytes)?;
	}
	if let Some(bytes) = index {
		fs::write(git_entry.join("index"), bytes)?;
	} else if let Ok(detached) = GitRepo::require(worktree_root)
		&& resolve_commit(&detached.gix()?, "HEAD").is_ok()
	{
		detached.read_tree("HEAD", None)?;
	}
	Ok(DetachGitDirResult::Detached)
}

/// Author signature for an explicit [`CommitAuthor`]; a missing date means now.
fn signature_for(author: &CommitAuthor) -> Result<gix::actor::Signature> {
	let time = match &author.date {
		Some(date) => {
			gix::date::parse(date, None).map_err(|err| Error::backend("git commit", err))?
		},
		None => gix::date::Time::now_local_or_utc(),
	};
	Ok(gix::actor::Signature {
		name: author.name.clone().into(),
		email: author.email.clone().into(),
		time,
	})
}

fn resolve_commit(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_commit()
		.map(|commit| commit.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn resolve_tree(repo: &gix::Repository, spec: &str) -> Result<gix::hash::ObjectId> {
	let id = repo
		.rev_parse_single(spec)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	let object = id
		.object()
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })?;
	object
		.peel_to_tree()
		.map(|tree| tree.id)
		.map_err(|_| Error::ObjectNotFound { spec: spec.to_owned() })
}

fn commit_tree(repo: &gix::Repository, id: &gix::hash::ObjectId) -> Result<gix::hash::ObjectId> {
	let commit = repo
		.find_commit(*id)
		.map_err(|e| Error::backend("git commit", e))?;
	commit
		.tree_id()
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git commit", e))
}

fn head_tree(repo: &gix::Repository) -> Result<Option<gix::hash::ObjectId>> {
	match repo
		.head()
		.map_err(|e| Error::backend("git reset", e))?
		.try_peel_to_id()
		.map_err(|e| Error::backend("git reset", e))?
	{
		Some(id) => Ok(Some(
			id.object()
				.map_err(|e| Error::backend("git reset", e))?
				.peel_to_commit()
				.map_err(|e| Error::backend("git reset", e))?
				.tree_id()
				.map_err(|e| Error::backend("git reset", e))?
				.detach(),
		)),
		None => Ok(None),
	}
}

fn index_for_tree(
	repo: &gix::Repository,
	tree: Option<&gix::hash::ObjectId>,
) -> Result<gix::index::File> {
	match tree {
		Some(tree) => repo
			.index_from_tree(tree)
			.map_err(|e| Error::backend("git index", e)),
		None => Ok(gix::index::File::from_state(
			gix::index::State::new(repo.object_hash()),
			repo.index_path(),
		)),
	}
}

fn collect_stage_paths(
	repo: &GitRepo,
	requested: &BTreeSet<String>,
	all: bool,
) -> Result<BTreeSet<String>> {
	let untracked = if all || requested.contains("") {
		repo.ls_files(true, true)?
	} else {
		repo.ls_files_at_paths(true, true, requested)?
	};
	Ok(untracked.into_iter().collect())
}

fn normalize_stage_path(path: &str) -> String {
	let normalized = path.replace('\\', "/");
	let mut relative = normalized.as_str();
	while let Some(stripped) = relative.strip_prefix("./") {
		relative = stripped;
	}
	if relative == "." {
		String::new()
	} else {
		relative.trim_end_matches('/').to_owned()
	}
}

fn stage_path_matches(path: &str, wanted: &str) -> bool {
	wanted.is_empty() || path_matches(path, wanted)
}

fn remap_composed_index_paths(
	root: &Path,
	index: &gix::index::File,
	selected: BTreeSet<String>,
) -> BTreeSet<String> {
	let mut exact = BTreeSet::new();
	let mut by_composed = BTreeMap::new();
	let mut dir_by_composed: BTreeMap<String, String> = BTreeMap::new();
	for entry in index.entries() {
		let Ok(name) = entry.path(index).to_str() else {
			continue;
		};
		exact.insert(name.to_owned());
		by_composed
			.entry(precomposed(name).into_owned())
			.or_insert_with(|| name.to_owned());
		let mut start = 0;
		while let Some(slash) = name[start..].find('/') {
			let dir = &name[..start + slash];
			if !dir.is_empty() {
				dir_by_composed
					.entry(precomposed(dir).into_owned())
					.or_insert_with(|| dir.to_owned());
			}
			start += slash + 1;
		}
	}
	selected
		.into_iter()
		.map(|path| {
			if exact.contains(&path) {
				return path;
			}
			if let Some(alias) = by_composed.get(precomposed(&path).as_ref())
				&& alias != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias.clone();
				}
			}
			let composed = precomposed(&path);
			if let Some(alias_dir) = dir_by_composed.get(composed.as_ref())
				&& alias_dir != &path
			{
				let Ok(meta) = fs::symlink_metadata(root.join(&path)) else {
					return path;
				};
				let Ok(imeta) = fs::symlink_metadata(root.join(alias_dir)) else {
					return path;
				};
				if same_worktree_file(&meta, &imeta) {
					return alias_dir.clone();
				}
			}
			path
		})
		.collect()
}

fn precompose_unicode_enabled(repo: &gix::Repository) -> bool {
	repo
		.config_snapshot()
		.boolean("core.precomposeUnicode")
		.unwrap_or(false)
}

fn precomposed(path: &str) -> std::borrow::Cow<'_, str> {
	gix_utils::str::precompose(std::borrow::Cow::Borrowed(path))
}

#[cfg(unix)]
fn same_worktree_file(left: &fs::Metadata, right: &fs::Metadata) -> bool {
	use std::os::unix::fs::MetadataExt;
	left.dev() == right.dev() && left.ino() == right.ino()
}

#[cfg(not(unix))]
#[allow(clippy::missing_const_for_fn, reason = "matches non-const unix signature")]
fn same_worktree_file(_: &fs::Metadata, _: &fs::Metadata) -> bool {
	false
}

/// The new index entry for a staged path.
struct StagedEntry {
	path: BString,
	stat: gix::index::entry::Stat,
	id:   gix::ObjectId,
	mode: gix::index::entry::Mode,
}

/// What staging a path does to its index entries.
enum Staged {
	/// Replace them with this entry.
	Entry(StagedEntry),
	/// Drop them: the path vanished or is untrackable (socket), as `git add`
	/// would.
	Removed,
	/// Leave them: a plain directory.
	Kept,
}

/// Write the filtered worktree content at `path` into the object database.
fn stage_one(
	root: &Path,
	filter: &mut gix::filter::Pipeline<'_>,
	filter_index: &gix::index::State,
	path: &str,
	staging_started: u64,
) -> Result<Staged> {
	use gix::objs::tree::EntryKind;
	let rela_path = path.as_bytes().as_bstr();
	// Stat before reading, as `git add` does, so the entry keeps a valid stat
	// cache: a write landing after the stat changes the file's stat and later
	// status calls re-hash it. A file last changed in the second staging
	// began could change again within that second and keep its stat, so its
	// stat is not recorded and the next status compares contents instead.
	let stat = gix::index::fs::Metadata::from_path_no_follow(&root.join(path))
		.ok()
		.and_then(|metadata| gix::index::entry::Stat::from_fs(&metadata).ok())
		.filter(|stat| u64::from(stat.mtime.secs) < staging_started)
		.unwrap_or_default();
	let Some((id, kind, _)) = filter
		.worktree_file_to_object(rela_path, filter_index)
		.map_err(|err| Error::backend("git add", err))?
	else {
		return Ok(Staged::Removed);
	};
	let mode = match kind {
		EntryKind::Blob => gix::index::entry::Mode::FILE,
		EntryKind::BlobExecutable => gix::index::entry::Mode::FILE_EXECUTABLE,
		EntryKind::Link => gix::index::entry::Mode::SYMLINK,
		EntryKind::Commit => gix::index::entry::Mode::COMMIT,
		EntryKind::Tree => return Ok(Staged::Kept),
	};
	Ok(Staged::Entry(StagedEntry { path: rela_path.to_owned(), stat, id, mode }))
}

fn copy_index_paths(dest: &mut gix::index::File, source: &gix::index::File, files: &[String]) {
	let all = files.is_empty();
	dest.remove_entries(|_, path, _| {
		all || files
			.iter()
			.any(|wanted| path_matches(&path.to_str_lossy(), wanted))
	});
	for entry in source.entries() {
		let path = entry.path(source);
		if all
			|| files
				.iter()
				.any(|wanted| path_matches(&path.to_str_lossy(), wanted))
		{
			dest.dangerously_push_entry(entry.stat, entry.id, entry.flags, entry.mode, path);
		}
	}
	dest.sort_entries();
}

#[derive(Default)]
struct TreeNode {
	files: Vec<(BString, gix::index::entry::Mode, gix::hash::ObjectId)>,
	dirs:  BTreeMap<BString, Self>,
}

fn write_index_tree(
	repo: &gix::Repository,
	index: &gix::index::File,
) -> Result<gix::hash::ObjectId> {
	let mut root = TreeNode::default();
	for entry in index
		.entries()
		.iter()
		.filter(|e| e.stage() == gix::index::entry::Stage::Unconflicted)
	{
		let parts: Vec<&[u8]> = entry.path(index).split(|b| *b == b'/').collect();
		let mut node = &mut root;
		for part in &parts[..parts.len().saturating_sub(1)] {
			node = node.dirs.entry(BString::from(*part)).or_default();
		}
		if let Some(name) = parts.last() {
			node
				.files
				.push((BString::from(*name), entry.mode, entry.id));
		}
	}
	write_tree_node(repo, root)
}

fn write_tree_node(repo: &gix::Repository, node: TreeNode) -> Result<gix::hash::ObjectId> {
	let mut entries = Vec::with_capacity(node.files.len() + node.dirs.len());
	for (name, mode, oid) in node.files {
		let mode = gix::objs::tree::EntryMode::try_from(mode.bits())
			.map_err(|m| Error::backend("git write-tree", format!("invalid mode {m:o}")))?;
		entries.push(gix::objs::tree::Entry { mode, filename: name, oid });
	}
	for (name, child) in node.dirs {
		entries.push(gix::objs::tree::Entry {
			mode:     gix::objs::tree::EntryKind::Tree.into(),
			filename: name,
			oid:      write_tree_node(repo, child)?,
		});
	}
	entries.sort();
	repo
		.write_object(&gix::objs::Tree { entries })
		.map(|id| id.detach())
		.map_err(|e| Error::backend("git write-tree", e))
}

fn resolve_checkout_target(
	repo: &gix::Repository,
	rev: &str,
) -> Result<(gix::hash::ObjectId, Option<String>)> {
	let branch = if rev.starts_with("refs/heads/") {
		Some(rev.to_owned())
	} else {
		let full = format!("refs/heads/{rev}");
		repo
			.try_find_reference(&full)
			.map_err(|e| Error::backend("git checkout", e))?
			.map(|_| full)
	};
	Ok((resolve_commit(repo, branch.as_deref().unwrap_or(rev))?, branch))
}

fn checkout_tree(
	owner: &GitRepo,
	repo: &gix::Repository,
	commit: gix::hash::ObjectId,
	overwrite: bool,
) -> Result<()> {
	let tree = commit_tree(repo, &commit)?;
	let mut target = repo
		.index_from_tree(&tree)
		.map_err(|e| Error::backend("git checkout", e))?;
	let current = load_index_or_head(repo, "git checkout")?;
	let conflicts = checkout_conflicts(owner.root(), repo, &current, &target)?;
	if !overwrite && !conflicts.is_empty() {
		return Err(Error::Conflict { paths: conflicts });
	}
	let mut collisions = Vec::new();
	for entry in target.entries() {
		let path = entry.path(&target).to_str_lossy().into_owned();
		if current.entry_by_path(path.as_bytes().as_bstr()).is_none()
			&& fs::symlink_metadata(owner.root().join(&path)).is_ok()
		{
			collisions.push(path);
		}
	}
	if !collisions.is_empty() {
		return Err(Error::Conflict { paths: collisions });
	}
	let target_paths: BTreeSet<String> = target
		.entries()
		.iter()
		.map(|e| e.path(&target).to_str_lossy().into_owned())
		.collect();
	for entry in current.entries() {
		let path = entry.path(&current).to_str_lossy();
		if !target_paths.contains(path.as_ref()) {
			let full = owner.root().join(path.as_ref());
			if full.is_file() || fs::symlink_metadata(&full).is_ok() {
				fs::remove_file(full)?;
			}
		}
	}
	let mut opts = repo
		.checkout_options(gix::worktree::stack::state::attributes::Source::IdMapping)
		.map_err(|e| Error::backend("git checkout", e))?;
	opts.overwrite_existing = true;
	let progress = gix::progress::Discard;
	let interrupt = std::sync::atomic::AtomicBool::new(false);
	gix::worktree::state::checkout(
		&mut target,
		owner.root(),
		repo
			.objects
			.clone()
			.into_arc()
			.map_err(|e| Error::backend("git checkout", e))?,
		&progress,
		&progress,
		&interrupt,
		opts,
	)
	.map_err(|e| Error::backend("git checkout", e))?;
	target
		.write(INDEX_WRITE)
		.map_err(|e| Error::backend("git checkout", e))
}

fn checkout_conflicts(
	root: &Path,
	repo: &gix::Repository,
	current: &gix::index::File,
	target: &gix::index::File,
) -> Result<Vec<String>> {
	let mut conflicts = Vec::new();
	let mut filter = WorktreeFilter::staging(repo, "git checkout")?;
	for entry in current.entries() {
		let path = entry.path(current).to_str_lossy().into_owned();
		let target_entry = target.entry_by_path(path.as_bytes().as_bstr());
		if target_entry.is_some_and(|e| e.id == entry.id && e.mode == entry.mode) {
			continue;
		}
		if worktree_id(repo, &mut filter, root, &path, entry.mode)? != Some(entry.id) {
			conflicts.push(path);
		}
	}
	conflicts.sort();
	conflicts.dedup();
	Ok(conflicts)
}

/// Blob id the worktree entry at repo-relative `path` would be staged as —
/// regular files pass through the clean filters, so a CRLF checkout under
/// `core.autocrlf` matches its LF blob — or `None` when it is missing.
fn worktree_id(
	repo: &gix::Repository,
	filter: &mut WorktreeFilter<'_>,
	root: &Path,
	path: &str,
	mode: gix::index::entry::Mode,
) -> Result<Option<gix::hash::ObjectId>> {
	let absolute = root.join(path);
	if !absolute.exists() && fs::symlink_metadata(&absolute).is_err() {
		return Ok(None);
	}
	let data = if mode == gix::index::entry::Mode::SYMLINK {
		fs::read_link(&absolute)?
			.to_string_lossy()
			.into_owned()
			.into_bytes()
	} else {
		filter.worktree_to_git(path, fs::read(&absolute)?)?
	};
	Ok(Some(
		gix::objs::compute_hash(repo.object_hash(), gix::objs::Kind::Blob, &data)
			.map_err(|e| Error::backend("git checkout", e))?,
	))
}

fn write_head(path: &Path, symbolic: Option<&str>, id: gix::hash::ObjectId) -> Result<()> {
	fs::write(path, match symbolic {
		Some(name) => format!("ref: {name}\n"),
		None => format!("{}\n", id.to_hex()),
	})?;
	Ok(())
}

fn update_current_head(repo: &gix::Repository, path: &Path, id: gix::hash::ObjectId) -> Result<()> {
	let content = fs::read_to_string(path).unwrap_or_default();
	if let Some(name) = content.trim().strip_prefix("ref: ") {
		update_reference(
			repo,
			"git reset",
			name,
			id,
			gix::refs::transaction::PreviousValue::Any,
			"reset: moving to target",
			false,
		)?;
	} else {
		fs::write(path, format!("{}\n", id.to_hex()))?;
	}
	Ok(())
}

fn restore_index_paths(
	root: &Path,
	repo: &gix::Repository,
	index: &gix::index::File,
	files: &[String],
) -> Result<()> {
	let mut filter = WorktreeFilter::staging(repo, "git restore")?;
	for entry in index.entries() {
		let path = entry.path(index).to_str_lossy();
		if files.is_empty() || files.iter().any(|wanted| path_matches(&path, wanted)) {
			let object = repo
				.find_object(entry.id)
				.map_err(|e| Error::backend("git restore", e))?;
			let mut blob = object
				.try_into_blob()
				.map_err(|e| Error::backend("git restore", e))?;
			let full = root.join(path.as_ref());
			if let Some(parent) = full.parent() {
				fs::create_dir_all(parent)?;
			}
			fs::write(full, filter.git_to_worktree(&path, blob.take_data())?)?;
		}
	}
	Ok(())
}

fn path_matches(path: &str, wanted: &str) -> bool {
	let wanted = wanted.trim_end_matches('/');
	path == wanted
		|| path
			.strip_prefix(wanted)
			.is_some_and(|r| r.starts_with('/'))
}

/// Edit a config file the way git does, under its lockfile protocol: take
/// `<config>.lock` with `create_new` (retrying for ~100 ms while another writer
/// holds it, then erroring), read the config only once the lock is held so a
/// concurrent writer's committed change is seen, let `edit` change it, write
/// the result into the lock with the old file's permissions, sync, and rename
/// it over the config. A symlinked config is edited at its target. When `edit`
/// returns false the lock is released without rewriting. A missing config
/// starts empty. The rest of the file is written back as gix serializes it
/// (mostly lossless). Only a lock this call created is ever removed.
fn edit_config_locked(
	path: &Path,
	edit: impl FnOnce(&mut gix::config::File<'static>) -> Result<bool>,
) -> Result<()> {
	use std::{
		io::Write,
		thread,
		time::{Duration, Instant},
	};

	// As git's lockfile does: a symlinked config, even one whose target does not
	// exist yet, is edited at its target with the lock beside it, so the link
	// stays. Up to five levels, as git follows.
	let mut resolved = path.to_path_buf();
	for _ in 0..5 {
		let Ok(target) = fs::read_link(&resolved) else {
			break;
		};
		resolved = match resolved.parent() {
			Some(dir) if target.is_relative() => dir.join(target),
			_ => target,
		};
	}
	let path = resolved.as_path();
	let mut lock_name = path.as_os_str().to_owned();
	lock_name.push(".lock");
	let lock_path = PathBuf::from(lock_name);

	let deadline = Instant::now() + Duration::from_millis(100);
	let mut lock = loop {
		match fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&lock_path)
		{
			Ok(file) => break file,
			Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
				if Instant::now() >= deadline {
					return Err(e.into());
				}
				thread::sleep(Duration::from_millis(5));
			},
			Err(e) => return Err(e.into()),
		}
	};

	let published = (|| -> Result<bool> {
		let existing = fs::metadata(path).ok();
		let mut config = if existing.is_some() {
			gix::config::File::from_path_no_includes(path.to_owned(), gix::config::Source::Local)
				.map_err(|e| Error::backend("git config", e))?
		} else {
			gix::config::File::default()
		};
		if !edit(&mut config)? {
			return Ok(false);
		}
		// As git does: the lock takes the old file's mode before any content is
		// written, so a 0600 config holding credentials is never readable through
		// it, and the published file keeps that mode.
		if let Some(existing) = &existing {
			lock.set_permissions(existing.permissions())?;
		}
		let mut bytes = Vec::new();
		config.write_to(&mut bytes)?;
		lock.write_all(&bytes)?;
		lock.sync_all()?;
		fs::rename(&lock_path, path)?;
		Ok(true)
	})();
	if !matches!(published, Ok(true)) {
		let _ = fs::remove_file(&lock_path);
	}
	published.map(|_| ())
}

/// Drop every `[<section> "<subsection>"]` section from a config file, under
/// [`edit_config_locked`]; nothing is rewritten when none matches.
fn remove_config_sections(path: &Path, section: &str, subsection: &str) -> Result<()> {
	edit_config_locked(path, |config| {
		let mut removed = false;
		while config
			.remove_section(section, Some(subsection.into()))
			.is_some()
		{
			removed = true;
		}
		Ok(removed)
	})
}

fn set_config_file(path: &Path, key: &str, value: &str) -> Result<()> {
	edit_config_locked(path, |config| {
		config
			.set_raw_value(key, value)
			.map_err(|e| Error::backend("git config", e))?;
		Ok(true)
	})
}

/// Paths whose entry differs between `left` and `right` (blob id or mode), or
/// that exist on only one side.
fn index_diff_paths(left: &gix::index::File, right: &gix::index::File) -> BTreeSet<BString> {
	let mut paths = BTreeSet::new();
	for entry in left.entries() {
		let entry_path = entry.path(left);
		if right
			.entry_by_path(entry_path)
			.is_none_or(|other| other.id != entry.id || other.mode != entry.mode)
		{
			paths.insert(entry_path.to_owned());
		}
	}
	for entry in right.entries() {
		let entry_path = entry.path(right);
		if left.entry_by_path(entry_path).is_none() {
			paths.insert(entry_path.to_owned());
		}
	}
	paths
}

/// Point the stat cache of every index entry outside `dirty` at the file now
/// under `root`, so entries whose content matches the index read as clean.
fn refresh_clean_index_stats(
	index: &mut gix::index::File,
	root: &Path,
	dirty: &BTreeSet<BString>,
) -> Result<()> {
	for (entry, entry_path) in index.entries_mut_with_paths() {
		if dirty.contains(entry_path) {
			continue;
		}
		let Ok(metadata) =
			gix::index::fs::Metadata::from_path_no_follow(&root.join(entry_path.to_path_lossy()))
		else {
			continue;
		};
		entry.stat = gix::index::entry::Stat::from_fs(&metadata)
			.map_err(|err| Error::backend("git worktree add", err))?;
	}
	Ok(())
}

fn collect_clone_reconciliation_paths(
	repo: &gix::Repository,
) -> Result<(BTreeSet<BString>, BTreeSet<BString>)> {
	let platform = status_with_fresh_index(repo, "git worktree add")?
		.untracked_files(gix::status::UntrackedFiles::Files);
	let iter = platform
		.into_iter(std::iter::empty::<gix::bstr::BString>())
		.map_err(|err| Error::backend("git worktree add", err))?;
	let mut dirty_tracked = BTreeSet::new();
	let mut untracked = BTreeSet::new();
	for item in iter {
		let item = item.map_err(|err| Error::backend("git worktree add", err))?;
		let gix::status::Item::IndexWorktree(change) = item else {
			continue;
		};
		use gix::status::index_worktree;
		match change {
			index_worktree::Item::Modification { rela_path, status, .. }
				if !matches!(
					status,
					gix::status::plumbing::index_as_worktree::EntryStatus::NeedsUpdate(_)
				) =>
			{
				dirty_tracked.insert(rela_path);
			},
			index_worktree::Item::DirectoryContents { entry, .. }
				if entry.status == gix::dir::entry::Status::Untracked =>
			{
				untracked.insert(entry.rela_path);
			},
			index_worktree::Item::Rewrite { source, dirwalk_entry, .. } => {
				dirty_tracked.insert(dirwalk_entry.rela_path);
				match source {
					index_worktree::RewriteSource::RewriteFromIndex { source_rela_path, .. } => {
						dirty_tracked.insert(source_rela_path);
					},
					index_worktree::RewriteSource::CopyFromDirectoryEntry {
						source_dirwalk_entry,
						..
					} => {
						untracked.insert(source_dirwalk_entry.rela_path);
					},
				}
			},
			_ => {},
		}
	}
	Ok((dirty_tracked, untracked))
}

fn git_metadata_path(path: &Path) -> Cow<'_, str> {
	let display = path.to_string_lossy();
	if cfg!(windows) {
		Cow::Owned(display.replace('\\', "/"))
	} else {
		display
	}
}

fn register_worktree(
	path: &Path,
	common: &Path,
	head: &str,
	setup_owner: Option<&str>,
) -> Result<PathBuf> {
	fs::create_dir_all(path)?;
	let name = worktree_admin_name(common, path);
	let admin = common.join("worktrees").join(name);
	fs::create_dir_all(&admin)?;
	let written: Result<()> = (|| {
		// Both before the worktree is listed: git's lock while it is created, and
		// the setup mark.
		fs::write(admin.join("locked"), "initializing\n")?;
		if let Some(owner) = setup_owner {
			fs::write(admin.join(SETUP_MARK), format!("{owner}\n"))?;
		}
		fs::write(path.join(".git"), format!("gitdir: {}\n", git_metadata_path(&admin)))?;
		fs::write(admin.join("gitdir"), format!("{}\n", git_metadata_path(&path.join(".git"))))?;
		fs::write(admin.join("commondir"), "../..\n")?;
		fs::write(admin.join("HEAD"), format!("{head}\n"))?;
		Ok(())
	})();
	if let Err(err) = written {
		// A locked entry without its back-reference would never be pruned: remove
		// it, as git does.
		let _ = fs::remove_dir_all(&admin);
		return Err(err);
	}
	Ok(admin)
}

/// Lift git's creation lock as git does, before any hook runs. If that fails,
/// roll the add back: a live setup mark on a worktree reported as failed would
/// make other processes refuse it for as long as this one lives. A checkout
/// that cannot be deleted stays listed and owned, recoverable by
/// `git worktree remove`.
fn finish_worktree_add(path: &Path, admin: &Path) -> Result<()> {
	unlock_admin(admin).inspect_err(|_| {
		let removed = match fs::remove_dir_all(path) {
			Ok(()) => true,
			Err(err) => err.kind() == std::io::ErrorKind::NotFound,
		};
		// Unlisting a worktree whose checkout survives would leave a directory
		// whose `.git` points at deleted admin data, and a retry would fail on
		// it.
		if !removed {
			return;
		}
		// `gitdir` first: until it is gone the entry stays whole, listed and
		// owned, so other processes refuse it. Once it is, nothing lists
		// the entry, and the rest can go, mark included: `HEAD` next, which
		// `branch_is_checked_out` reads from every entry, listed or not.
		if remove_if_present(&admin.join("gitdir")).is_ok() {
			let _ = remove_if_present(&admin.join("HEAD"));
			let _ = fs::remove_dir_all(admin);
		}
	})
}

/// Held for one `worktree_add`: a file lock, or, where the filesystem has none,
/// an exclusively created claim file, removed when dropped.
enum WorktreeAddLock {
	Locked(#[allow(dead_code, reason = "held for its lock")] fs::File),
	/// The claim file, counted in [`RUNNING_CLAIMS`].
	Claimed(PathBuf),
}

/// How many claim files of adds in this process exist, for
/// [`release_worktree_add_claims`]. The condvar signals a claim's end.
static RUNNING_CLAIMS: std::sync::Mutex<usize> = std::sync::Mutex::new(0);
static CLAIM_ENDED: std::sync::Condvar = std::sync::Condvar::new();

fn running_claims() -> std::sync::MutexGuard<'static, usize> {
	RUNNING_CLAIMS
		.lock()
		.unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Drop for WorktreeAddLock {
	fn drop(&mut self) {
		if let Self::Claimed(claim) = self {
			let mut running = running_claims();
			let _ = fs::remove_file(claim);
			*running -= 1;
			CLAIM_ENDED.notify_all();
		}
	}
}

/// Wait up to `wait` for the worktree adds running in this process to finish.
///
/// For an exit that would end them without unwinding (a signal handler exiting
/// the process). Only filesystems without file locks use claim files. Adds are
/// not abortable, so the claims of adds still running after `wait` stay:
/// removing them would let another process add the same path while this one
/// still writes it. Such a leftover makes a later add fail naming the file.
pub fn release_worktree_add_claims(wait: std::time::Duration) {
	let _ = CLAIM_ENDED
		.wait_timeout_while(running_claims(), wait, |running| *running > 0)
		.unwrap_or_else(std::sync::PoisonError::into_inner);
}

/// How long an add waits for another one holding the lock or claim file.
const WORKTREE_ADD_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// Sleeps one backoff step (10 ms doubling to 500 ms); false once `deadline`
/// has passed.
fn back_off(deadline: std::time::Instant, pause: &mut std::time::Duration) -> bool {
	if std::time::Instant::now() >= deadline {
		return false;
	}
	std::thread::sleep(*pause);
	*pause = (*pause * 2).min(std::time::Duration::from_millis(500));
	true
}

fn lock_worktree_adds(common: &Path) -> Result<WorktreeAddLock> {
	lock_worktree_adds_within(common, WORKTREE_ADD_WAIT)
}

fn lock_worktree_adds_within(common: &Path, wait: std::time::Duration) -> Result<WorktreeAddLock> {
	let lock_path = common.join("omp-worktree-add.lock");
	let file = fs::OpenOptions::new()
		.create(true)
		.write(true)
		.truncate(false)
		.open(&lock_path)?;
	let deadline = std::time::Instant::now() + wait;
	let mut pause = std::time::Duration::from_millis(10);
	loop {
		let err = match file.try_lock() {
			Ok(()) => return Ok(WorktreeAddLock::Locked(file)),
			// Bounded so a stalled holder cannot hang every later add, and the
			// callers cannot be aborted.
			Err(std::fs::TryLockError::WouldBlock) => {
				if back_off(deadline, &mut pause) {
					continue;
				}
				return Err(Error::backend(
					"git worktree add",
					format!(
						"another omp process has been adding a worktree in this repository for over {} \
						 s (holding '{}'); try again",
						wait.as_secs(),
						lock_path.display()
					),
				));
			},
			Err(std::fs::TryLockError::Error(err)) => err,
		};
		// Without lock support (e.g. NFSv3 without lockd): O_EXCL creation, as
		// git's own lock files use, with a fresh wait.
		let unsupported = err.kind() == std::io::ErrorKind::Unsupported;
		#[cfg(unix)]
		let unsupported = unsupported || err.raw_os_error() == Some(libc::ENOLCK);
		return if unsupported {
			claim_worktree_adds(common, wait)
		} else {
			Err(err.into())
		};
	}
}

fn claim_worktree_adds(common: &Path, wait: std::time::Duration) -> Result<WorktreeAddLock> {
	let claim = common.join("omp-worktree-add.claim");
	let deadline = std::time::Instant::now() + wait;
	let mut pause = std::time::Duration::from_millis(10);
	loop {
		match fs::OpenOptions::new()
			.write(true)
			.create_new(true)
			.open(&claim)
		{
			Ok(_) => {
				*running_claims() += 1;
				return Ok(WorktreeAddLock::Claimed(claim));
			},
			Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
				if !back_off(deadline, &mut pause) {
					// Left by a process that died mid-add without its exit cleanup,
					// as with git's `index.lock`.
					return Err(Error::backend(
						"git worktree add",
						format!(
							"'{}' exists: another omp process seems to be adding a worktree; if none is, \
							 remove the file",
							claim.display()
						),
					));
				}
			},
			Err(err) => return Err(err.into()),
		}
	}
}

fn cleanup_worktree_add(path: &Path, common: &Path) {
	let admin = registered_admin(&path.join(".git")).ok().flatten();
	let _ = fs::remove_dir_all(path);
	if let Some(admin) = admin.filter(|admin| admin.starts_with(common.join("worktrees"))) {
		let _ = fs::remove_dir_all(admin);
	}
}

/// Remove a file, symlink, or directory tree at `path`; missing is fine.
fn remove_existing(path: &Path) -> Result<()> {
	match fs::symlink_metadata(path) {
		Ok(meta) if meta.is_dir() => fs::remove_dir_all(path)?,
		Ok(_) => fs::remove_file(path)?,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {},
		Err(err) => return Err(err.into()),
	}
	Ok(())
}

/// Recreate the symlink at `src` as `dst` (a plain file holding the link
/// target on platforms without symlinks, matching git's `core.symlinks=false`).
fn copy_symlink(src: &Path, dst: &Path) -> Result<()> {
	let target = fs::read_link(src)?;
	#[cfg(unix)]
	std::os::unix::fs::symlink(&target, dst)?;
	#[cfg(not(unix))]
	fs::write(dst, target.to_string_lossy().as_bytes())?;
	Ok(())
}

/// Remove now-empty ancestors of a deleted entry, walking up from `parent`
/// and stopping at `root`, the first non-empty directory, or — when `scope`
/// is non-empty — the first directory outside every scoped pathspec.
fn prune_empty_parents(
	root: &Path,
	mut parent: Option<&Path>,
	scope: &BTreeSet<String>,
) -> Result<()> {
	while let Some(dir) = parent {
		if dir == root {
			break;
		}
		if !scope.is_empty() {
			let Ok(rel) = dir.strip_prefix(root) else {
				break;
			};
			let rel = rel.to_string_lossy().replace('\\', "/");
			let in_scope = scope.iter().any(|p| {
				*p == rel
					|| rel
						.strip_prefix(p.as_str())
						.is_some_and(|r| r.starts_with('/'))
			});
			if !in_scope {
				break;
			}
		}
		match fs::remove_dir(dir) {
			Ok(()) => parent = dir.parent(),
			Err(err)
				if matches!(
					err.kind(),
					std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
				) =>
			{
				break;
			},
			Err(err) => return Err(err.into()),
		}
	}
	Ok(())
}

fn worktree_admin_name(common: &Path, path: &Path) -> String {
	let base = path
		.file_name()
		.and_then(|s| s.to_str())
		.filter(|s| !s.is_empty())
		.unwrap_or("worktree");
	let mut name = base.to_owned();
	let mut n = 1;
	while common.join("worktrees").join(&name).exists() {
		name = format!("{base}{n}");
		n += 1;
	}
	name
}

fn branch_is_checked_out(common: &Path, full_ref: &str) -> bool {
	let expected = format!("ref: {full_ref}");
	if fs::read_to_string(common.join("HEAD")).is_ok_and(|head| head.trim() == expected) {
		return true;
	}
	let Ok(entries) = fs::read_dir(common.join("worktrees")) else {
		return false;
	};
	entries.filter_map(std::result::Result::ok).any(|entry| {
		fs::read_to_string(entry.path().join("HEAD")).is_ok_and(|head| head.trim() == expected)
	})
}

fn tracked_worktree_dirty(repo: &GitRepo) -> Result<bool> {
	let gix = repo.gix()?;
	let index = load_index_or_head(&gix, "git worktree remove")?;
	let mut filter = WorktreeFilter::staging(&gix, "git worktree remove")?;
	for entry in index.entries() {
		let path = entry.path(&index).to_str_lossy();
		if worktree_id(&gix, &mut filter, repo.root(), &path, entry.mode)? != Some(entry.id) {
			return Ok(true);
		}
	}
	Ok(false)
}

fn snapshot_refs(repo: &gix::Repository) -> Result<Vec<(String, gix::hash::ObjectId)>> {
	let platform = repo
		.references()
		.map_err(|e| Error::backend("git detach", e))?;
	let iter = platform
		.all()
		.map_err(|e| Error::backend("git detach", e))?;
	let mut out = Vec::new();
	for reference in iter {
		let mut reference = reference.map_err(|e| Error::backend("git detach", e))?;
		let name = reference.name().as_bstr().to_str_lossy().into_owned();
		if let Ok(id) = reference.peel_to_id() {
			out.push((name, id.detach()));
		}
	}
	Ok(out)
}

fn copy_named_files(dir: &Path, prefix: &str) -> Result<Vec<(String, Vec<u8>)>> {
	let mut out = Vec::new();
	let Ok(entries) = fs::read_dir(dir) else {
		return Ok(out);
	};
	for entry in entries {
		let entry = entry?;
		let name = entry.file_name().to_string_lossy().into_owned();
		if name.starts_with(prefix) {
			out.push((name, fs::read(entry.path())?));
		}
	}
	Ok(out)
}

fn registered_admin(git_entry: &Path) -> Result<Option<PathBuf>> {
	let text = fs::read_to_string(git_entry)?;
	let Some(raw) = text.trim().strip_prefix("gitdir:") else {
		return Ok(None);
	};
	let admin = normalize_path(
		&git_entry
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(raw.trim()),
	);
	let back = fs::read_to_string(admin.join("gitdir")).unwrap_or_default();
	let real_back =
		fs::canonicalize(back.trim()).unwrap_or_else(|_| normalize_path(Path::new(back.trim())));
	let real_entry = fs::canonicalize(git_entry).unwrap_or_else(|_| normalize_path(git_entry));
	Ok((real_back == real_entry).then_some(admin))
}

fn write_loose_ref(git_dir: &Path, name: &str, id: gix::hash::ObjectId) -> Result<()> {
	let path = git_dir.join(name);
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent)?;
	}
	fs::write(path, format!("{}\n", id.to_hex()))?;
	Ok(())
}
#[cfg(test)]
mod tests {
	use std::process::Command;

	use tempfile::TempDir;

	use super::*;
	use crate::types::CommitAuthor;

	fn git(dir: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.arg("-C")
			.arg(dir)
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout)
			.unwrap()
			.trim_end()
			.to_owned()
	}

	fn fixture() -> (TempDir, GitRepo) {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "user.name", "Test"]);
		git(temp.path(), &["config", "user.email", "test@example.com"]);
		// gix reads the developer's `~/.gitconfig`, where a global
		// `core.hooksPath` would redirect hook lookup away from this fixture.
		git(temp.path(), &["config", "core.hooksPath", ".git/hooks"]);
		// Assertions compare exact worktree bytes; Git for Windows' system
		// `core.autocrlf=true` would check them out as CRLF. Tests covering
		// line-ending conversion opt back in explicitly.
		git(temp.path(), &["config", "core.autocrlf", "false"]);
		fs::write(temp.path().join("a"), "one\n").unwrap();
		fs::write(temp.path().join("b"), "two\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "base"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		(temp, repo)
	}

	#[cfg(unix)]
	#[test]
	fn hook_location_expands_a_home_relative_hooks_path_like_git() {
		let (temp, _) = fixture();
		git(temp.path(), &["config", "core.hooksPath", "~/omp-hook-location-test"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		let expected = git(temp.path(), &[
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"hooks/post-checkout",
		]);

		assert_eq!(repo.hook_location("post-checkout").unwrap(), PathBuf::from(expected));
	}

	#[test]
	fn mutate_stage_commit_amend_and_empty() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("a"), "changed\n").unwrap();
		fs::write(temp.path().join("new"), "new\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "M  a\n?? new");
		let first = repo
			.commit_create("change", &CommitOptions {
				author: Some(CommitAuthor {
					name:  "Other".into(),
					email: "other@example.com".into(),
					date:  Some("2020-01-02T03:04:05Z".into()),
				}),
				..Default::default()
			})
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), first);
		assert_eq!(
			git(temp.path(), &["show", "-s", "--format=%an <%ae>", "HEAD"]),
			"Other <other@example.com>"
		);
		assert!(
			repo
				.commit_create("empty", &CommitOptions::default())
				.is_err()
		);
		fs::write(temp.path().join("a"), "amended\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let amended = repo
			.commit_create("amended", &CommitOptions { amend: true, ..Default::default() })
			.unwrap();
		assert_ne!(first, amended);
		assert_eq!(git(temp.path(), &["rev-list", "--count", "HEAD"]), "2");
		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "A  new");
		repo.unstage(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "?? new");
	}

	#[cfg(unix)]
	#[test]
	fn commit_respects_configured_signing_and_refuses_failed_signatures() {
		let (temp, _) = fixture();
		// A pre-1973 author date: git rejects a bare `<seconds> <offset>` under
		// nine digits, so the amend below proves the raw date reaches the
		// signed commit intact.
		git(temp.path(), &["commit", "-q", "--amend", "--no-edit", "--date=@86400 +0130"]);
		let key = temp.path().join("signing-key");
		let output = Command::new("ssh-keygen")
			.args(["-q", "-t", "ed25519", "-N", "", "-f"])
			.arg(&key)
			.output()
			.unwrap();
		assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
		let signers = temp.path().join("allowed-signers");
		fs::write(
			&signers,
			format!("test@example.com {}\n", fs::read_to_string(key.with_extension("pub")).unwrap()),
		)
		.unwrap();
		git(temp.path(), &["config", "gpg.format", "ssh"]);
		git(temp.path(), &["config", "user.signingkey", key.to_str().unwrap()]);
		git(temp.path(), &["config", "gpg.ssh.allowedSignersFile", signers.to_str().unwrap()]);
		git(temp.path(), &["config", "commit.gpgsign", "true"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		let identity = |rev: &str| {
			git(temp.path(), &["log", "-1", "--date=raw", "--format=%an|%ae|%ad|%cn|%ce", rev])
		};

		fs::write(temp.path().join("a"), "amended\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let amended = repo
			.commit_create("signed amend", &CommitOptions { amend: true, ..Default::default() })
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), amended);
		git(temp.path(), &["verify-commit", "HEAD"]);
		assert_eq!(identity("HEAD"), "Test|test@example.com|86400 +0130|Test|test@example.com");
		assert_eq!(git(temp.path(), &["rev-list", "--count", "HEAD"]), "1");

		let message = "subject ünïcode\n\nbody line\n";
		fs::write(temp.path().join("b"), "signed\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		let signed = repo
			.commit_create(message, &CommitOptions::default())
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), signed);
		git(temp.path(), &["verify-commit", "HEAD"]);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD^"]), amended);
		let raw = git(temp.path(), &["cat-file", "commit", "HEAD"]);
		assert!(raw.ends_with(&format!("\n\n{}", message.trim_end())), "{raw}");

		git(temp.path(), &["config", "user.signingkey", "/no-such-signing-key"]);
		fs::write(temp.path().join("a"), "must not commit\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let error = repo
			.commit_create("failed signer", &CommitOptions::default())
			.unwrap_err();
		assert!(matches!(error, Error::Cli { .. }), "{error:?}");
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), signed);

		// Git refuses a malformed boolean; committing unsigned instead would
		// silently drop the signature the user asked for.
		git(temp.path(), &["config", "commit.gpgsign", "sometimes"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		assert!(
			repo
				.commit_create("malformed config", &CommitOptions::default())
				.is_err()
		);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), signed);

		git(temp.path(), &["config", "commit.gpgsign", "false"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		repo
			.commit_create("unsigned by choice", &CommitOptions::default())
			.unwrap();
		assert!(!git(temp.path(), &["cat-file", "-p", "HEAD"]).contains("\ngpgsig "));
	}

	/// Staged entries record the file's stat so later status calls can skip
	/// re-hashing them; a zeroed stat would force a content check every time.
	/// A file changed in the second staging began could change again within
	/// that second without its stat changing, so it records none.
	#[test]
	fn stage_files_records_the_stat_cache_unless_racy() {
		let (temp, repo) = fixture();
		let set_mtime = |path: &str, when: std::time::SystemTime| {
			fs::OpenOptions::new()
				.write(true)
				.open(temp.path().join(path))
				.and_then(|file| file.set_modified(when))
				.unwrap();
		};
		let now = std::time::SystemTime::now();
		fs::write(temp.path().join("a"), "changed content\n").unwrap();
		set_mtime("a", now - std::time::Duration::from_secs(30));
		set_mtime("b", now + std::time::Duration::from_secs(60));
		repo.stage_files(&[]).unwrap();
		let index = gix::open(temp.path()).unwrap().open_index().unwrap();
		let stat = |path: &str| index.entry_by_path(path.into()).unwrap().stat;
		let size = fs::metadata(temp.path().join("a")).unwrap().len();
		assert_eq!(u64::from(stat("a").size), size, "a records its size");
		assert_ne!(stat("a").mtime, gix::index::entry::stat::Time::default(), "a records its mtime");
		assert_eq!(stat("b"), gix::index::entry::Stat::default(), "a racy stat is not recorded");
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "M  a");
	}

	#[test]
	fn stage_applies_worktree_to_git_filters() {
		// Regression: staging stored raw worktree bytes, so under
		// `*.cmd text eol=crlf` a CRLF checkout staged a CRLF blob over the LF
		// HEAD blob. `stage_files(&[])` re-stages every tracked path, so every
		// untouched .cmd file surfaced as modified in both index and worktree.
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitattributes"), "*.cmd text eol=crlf\n").unwrap();
		fs::write(temp.path().join("run.cmd"), "echo one\r\necho two\r\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "crlf"]);
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		fs::write(temp.path().join("run.cmd"), "echo one\r\necho three\r\n").unwrap();
		repo.stage_files(&["run.cmd".into()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "M  run.cmd");
		assert_eq!(git(temp.path(), &["show", ":run.cmd"]), "echo one\necho three");
	}

	#[test]
	fn stage_all_skips_nested_gitignore_like_git_add() {
		let (temp, repo) = fixture();
		fs::create_dir_all(temp.path().join("tests/e2e/screenshots")).unwrap();
		fs::write(temp.path().join("tests/e2e/.gitignore"), "screenshots/\ntest-results/\n").unwrap();
		fs::write(temp.path().join("tests/e2e/screenshots/homepage.png"), "png").unwrap();
		fs::write(temp.path().join("tests/e2e/visible.txt"), "ok\n").unwrap();
		repo.stage_files(&[]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(!status.contains("screenshots"), "nested-ignored screenshot was staged:\n{status}");
		assert!(
			status.contains("tests/e2e/.gitignore"),
			"gitignore itself should be staged:\n{status}"
		);
		assert!(
			status.contains("tests/e2e/visible.txt"),
			"unignored sibling should be staged:\n{status}"
		);
	}

	#[test]
	fn stage_explicit_ignored_file_is_skipped() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "secret\n").unwrap();
		fs::write(temp.path().join("secret"), "x\n").unwrap();
		fs::write(temp.path().join("visible"), "y\n").unwrap();
		repo
			.stage_files(&["secret".into(), "visible".into()])
			.unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(!status.contains("secret"), "explicit ignored path was staged:\n{status}");
		assert!(status.contains("visible"), "explicit unignored path should be staged:\n{status}");
	}

	#[test]
	fn stage_dot_pathspec_matches_repository_root() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("a"), "changed\n").unwrap();
		fs::write(temp.path().join(".gitignore"), "secret\n").unwrap();
		fs::write(temp.path().join("visible"), "visible\n").unwrap();
		fs::write(temp.path().join("secret"), "secret\n").unwrap();

		repo.stage_files(&[".".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(status.contains("M  a"), "tracked root file should be staged:\n{status}");
		assert!(status.contains("A  visible"), "untracked root file should be staged:\n{status}");
		assert!(
			!git(temp.path(), &["ls-files"])
				.lines()
				.any(|path| path == "secret"),
			"ignored root file must stay untracked"
		);
	}

	#[test]
	fn stage_dot_prefixed_directory_pathspec_is_scoped() {
		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("dir")).unwrap();
		fs::write(temp.path().join("dir/tracked"), "base\n").unwrap();
		git(temp.path(), &["add", "--", "dir/tracked"]);
		git(temp.path(), &["commit", "-qm", "directory"]);
		fs::write(temp.path().join("dir/tracked"), "changed\n").unwrap();
		fs::write(temp.path().join("dir/new"), "new\n").unwrap();
		fs::write(temp.path().join("outside"), "outside\n").unwrap();

		repo.stage_files(&["./dir".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(status.contains("M  dir/tracked"), "tracked child should be staged:\n{status}");
		assert!(status.contains("A  dir/new"), "untracked child should be staged:\n{status}");
		assert!(status.contains("?? outside"), "unrequested path should stay untracked:\n{status}");
	}

	#[test]
	fn stage_explicit_metachar_directory_is_literal() {
		let (temp, repo) = fixture();
		fs::create_dir(temp.path().join("[x]")).unwrap();
		fs::create_dir(temp.path().join("x")).unwrap();
		fs::write(temp.path().join("[x]/selected"), "selected\n").unwrap();
		fs::write(temp.path().join("x/unselected"), "unselected\n").unwrap();

		repo.stage_files(&["[x]".into()]).unwrap();
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(
			status.contains("A  [x]/selected"),
			"literal metacharacter directory should be staged:\n{status}"
		);
		assert!(
			status.contains("?? x/"),
			"pattern lookalike directory should stay untracked:\n{status}"
		);
	}

	#[cfg(target_os = "macos")]
	#[test]
	fn stage_all_does_not_add_nfd_duplicate_of_nfc_index_path() {
		let (temp, repo) = fixture();
		let nfc = "caf\u{e9}.txt";
		let nfd = "cafe\u{301}.txt";
		fs::write(temp.path().join(nfc), "hello\n").unwrap();
		git(temp.path(), &["add", "--", nfc]);
		git(temp.path(), &["commit", "-qm", "accent"]);
		let before = git(temp.path(), &["ls-files", "-z"]);
		assert!(
			before.split('\0').filter(|p| p.contains("caf")).count() == 1,
			"setup should track one NFC path, got {before:?}"
		);
		assert!(!before.contains('\u{301}'), "git add should store NFC, got {before:?}");

		repo.stage_files(&[]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		let after = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = after.split('\0').filter(|p| p.contains("caf")).collect();
		assert_eq!(cafe, [nfc], "native add created a unicode duplicate: {after:?}");

		repo.stage_files(&[nfd.to_owned()]).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		let after_explicit = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = after_explicit
			.split('\0')
			.filter(|p| p.contains("caf"))
			.collect();
		assert_eq!(cafe, [nfc], "explicit NFD add created a unicode duplicate: {after_explicit:?}");
	}

	#[cfg(unix)]
	#[test]
	fn stage_explicit_hardlink_keeps_unrelated_name() {
		let (temp, repo) = fixture();
		fs::hard_link(temp.path().join("a"), temp.path().join("link")).unwrap();
		repo.stage_files(&["link".into()]).unwrap();
		let files = git(temp.path(), &["ls-files"]);
		assert!(files.contains('a'), "tracked original must remain:\n{files}");
		assert!(
			files.contains("link"),
			"unrelated hardlink name must be staged as its own path:\n{files}"
		);
	}

	#[test]
	fn stage_keeps_distinct_nfc_and_nfd_when_precompose_is_off() {
		let temp = tempfile::tempdir().unwrap();
		git(temp.path(), &["init", "-q", "-b", "main"]);
		git(temp.path(), &["config", "user.name", "Test"]);
		git(temp.path(), &["config", "user.email", "test@example.com"]);
		git(temp.path(), &["config", "core.precomposeunicode", "false"]);
		fs::write(temp.path().join("tracked"), "base\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "base"]);
		let repo = GitRepo::require(temp.path()).unwrap();

		let nfc = "caf\u{e9}.txt";
		let nfd = "cafe\u{301}.txt";
		fs::write(temp.path().join(nfc), "nfc\n").unwrap();
		fs::write(temp.path().join(nfd), "nfd\n").unwrap();
		let nfc_body = fs::read_to_string(temp.path().join(nfc)).unwrap();
		let nfd_body = fs::read_to_string(temp.path().join(nfd)).unwrap();
		if nfc_body == nfd_body {
			return;
		}

		git(temp.path(), &["add", "--", nfc]);
		git(temp.path(), &["commit", "-qm", "nfc"]);
		repo.stage_files(&[nfd.to_owned()]).unwrap();
		let files = git(temp.path(), &["ls-files", "-z"]);
		let cafe: Vec<_> = files.split('\0').filter(|p| p.contains("caf")).collect();
		assert_eq!(cafe.len(), 2, "NFC and NFD must stay distinct when precompose is off: {files:?}");
		assert!(cafe.contains(&nfc), "{cafe:?}");
		assert!(cafe.contains(&nfd), "{cafe:?}");
	}

	#[cfg(unix)]
	fn write_hook(path: &Path, body: &str, executable: bool) {
		use std::os::unix::fs::PermissionsExt;
		fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
		let mode = if executable { 0o755 } else { 0o644 };
		fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
	}

	#[cfg(windows)]
	fn write_hook(path: &Path, body: &str, _executable: bool) {
		fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
	}

	#[test]
	fn stage_commit_survives_unadvanced_index_mtime() {
		// Regression: a commit right after staging on the same cached handle used
		// to read a stale in-memory index snapshot when the on-disk index mtime
		// did not advance past the snapshot's (sub-second writes / coarse mtime
		// filesystems), failing with "nothing to commit, working tree clean".
		let (temp, repo) = fixture();
		// Pin the mtime so the snapshot captured while staging and the index the
		// write leaves behind collide on the exact same tick.
		crate::git::pin_index_mtime(&repo);

		fs::write(temp.path().join("a"), "changed\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		// Staging bumped the mtime; forcing it back reproduces the same-tick
		// collision that made gix serve the pre-stage index.
		crate::git::pin_index_mtime(&repo);

		let sha = repo
			.commit_create("change", &CommitOptions::default())
			.unwrap();
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), sha);
		// The commit must carry the staged content, not the stale base index.
		assert_eq!(git(temp.path(), &["show", "HEAD:a"]), "changed");
	}

	#[test]
	fn commit_hooks_match_git_commit_behavior() {
		let (temp, repo) = fixture();
		let hooks = temp.path().join(".git/hooks");
		let pre_commit = hooks.join("pre-commit");
		write_hook(&pre_commit, "echo 'policy says no' >&2\nexit 1", true);
		fs::write(temp.path().join("a"), "blocked\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let before = git(temp.path(), &["rev-parse", "HEAD"]);
		let error = repo
			.commit_create("blocked", &CommitOptions::default())
			.unwrap_err();
		assert!(matches!(
			&error,
			Error::Cli { stderr, .. } if stderr.contains("policy says no")
		));
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), before);

		fs::remove_file(&pre_commit).unwrap();
		write_hook(
			&hooks.join("commit-msg"),
			"printf 'rewritten subject\\n\\nrewritten body\\n' > \"$1\"",
			true,
		);
		repo
			.commit_create("original", &CommitOptions::default())
			.unwrap();
		assert_eq!(
			git(temp.path(), &["log", "-1", "--pretty=%B"]),
			"rewritten subject\n\nrewritten body"
		);

		fs::write(temp.path().join("b"), "changed again\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		fs::remove_file(hooks.join("commit-msg")).unwrap();
		repo
			.commit_create("missing hook is skipped", &CommitOptions::default())
			.unwrap();

		#[cfg(unix)]
		{
			fs::write(temp.path().join("b"), "one more\n").unwrap();
			repo.stage_files(&["b".into()]).unwrap();
			write_hook(&pre_commit, "echo should-not-run >&2\nexit 1", false);
			repo
				.commit_create("non-executable hook is skipped", &CommitOptions::default())
				.unwrap();
		}
		#[cfg(unix)]
		fs::remove_file(&pre_commit).unwrap();
		repo
			.commit_create("subject\n\nbody\n\n", &CommitOptions {
				allow_empty: true,
				..CommitOptions::default()
			})
			.unwrap();
		assert_eq!(repo.commit_details("HEAD").unwrap().message, "subject\n\nbody\n");
	}

	#[test]
	fn mutate_checkout_branches_and_resets() {
		let (temp, repo) = fixture();
		repo.create_branch("other", "HEAD", false).unwrap();
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		let main = repo
			.commit_create("main", &CommitOptions::default())
			.unwrap();
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.checkout("other").unwrap();
		assert_eq!(git(temp.path(), &["symbolic-ref", "--short", "HEAD"]), "other");
		repo.checkout("main").unwrap();
		repo.reset(ResetMode::Soft, Some("HEAD^")).unwrap();
		assert!(git(temp.path(), &["status", "--porcelain"]).starts_with("M  a"));
		repo.reset(ResetMode::Hard, Some(&main)).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");
		fs::write(temp.path().join("a"), "mixed\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		repo.reset(ResetMode::Mixed, Some("HEAD^")).unwrap();
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), " M a");
		repo.reset(ResetMode::Hard, Some(&main)).unwrap();
		assert!(repo.delete_branch("other", true).unwrap());
		assert!(!repo.delete_branch("missing", true).unwrap());
	}

	#[test]
	fn checkout_restore_and_worktree_remove_honor_autocrlf() {
		// Regression: conflict and dirty checks hashed raw worktree bytes, so a
		// CRLF checkout under `core.autocrlf=true` (the Git for Windows default)
		// read as modified and blocked the next checkout or a non-forced
		// worktree removal, and restore wrote LF where git writes CRLF.
		let (temp, repo) = fixture();
		git(temp.path(), &["config", "core.autocrlf", "true"]);
		repo.create_branch("other", "HEAD", false).unwrap();
		fs::write(temp.path().join("a"), "main\n").unwrap();
		repo.stage_files(&["a".into()]).unwrap();
		repo
			.commit_create("main", &CommitOptions::default())
			.unwrap();
		repo.checkout("other").unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "one\r\n");
		repo.checkout("main").unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "main\r\n");
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		fs::write(temp.path().join("a"), "dirty\r\n").unwrap();
		assert!(matches!(repo.checkout("other"), Err(Error::Conflict { .. })));
		repo
			.restore(&RestoreOptions { files: vec!["a".into()], ..Default::default() })
			.unwrap();
		assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "main\r\n");
		assert_eq!(git(temp.path(), &["status", "--porcelain"]), "");

		let linked = temp.path().join("../linked-autocrlf");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				setup_owner:  None,
			})
			.unwrap();
		assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "main\r\n");
		assert!(repo.worktree_remove(&linked, false).unwrap(), "clean CRLF checkout is not dirty");
	}

	#[test]
	fn mutate_clean_and_alternate_index() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "ignored\n").unwrap();
		repo.stage_files(&[".gitignore".into()]).unwrap();
		repo
			.commit_create("ignore", &CommitOptions::default())
			.unwrap();
		fs::write(temp.path().join("ignored"), "x").unwrap();
		fs::write(temp.path().join("untracked"), "x").unwrap();
		repo.clean(&CleanOptions::default()).unwrap();
		assert!(temp.path().join("ignored").exists());
		assert!(!temp.path().join("untracked").exists());
		repo
			.clean(&CleanOptions { ignored_only: true, ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("ignored").exists());
		fs::write(temp.path().join("ignored"), "x").unwrap();
		fs::write(temp.path().join("untracked"), "x").unwrap();
		repo
			.clean(&CleanOptions { include_ignored: true, ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("ignored").exists());
		assert!(!temp.path().join("untracked").exists());
		let alternate = temp.path().join("alternate-index");
		repo.read_tree("HEAD", Some(&alternate)).unwrap();
		assert_eq!(
			repo.write_tree(Some(&alternate)).unwrap(),
			git(temp.path(), &["rev-parse", "HEAD^{tree}"])
		);
	}

	#[test]
	fn clean_respects_nested_ignores_and_preserves_submodules() {
		let (temp, repo) = fixture();
		let outside = tempfile::tempdir().unwrap();
		// 1. Nested gitignore
		let nested = temp.path().join("nested");
		fs::create_dir_all(&nested).unwrap();
		fs::write(nested.join(".gitignore"), "secret.env\n").unwrap();
		repo.stage_files(&["nested/.gitignore".into()]).unwrap();
		repo
			.commit_create("add nested gitignore", &CommitOptions::default())
			.unwrap();
		fs::write(nested.join("secret.env"), "secret\n").unwrap();
		fs::write(nested.join("untracked.txt"), "delete\n").unwrap();

		// 2. Checked-out submodule
		let sub = temp.path().join("sub-repo");
		fs::create_dir_all(&sub).unwrap();
		git(&sub, &["init", "-q", "-b", "main"]);
		git(&sub, &["config", "user.email", "test@example.com"]);
		git(&sub, &["config", "user.name", "test"]);
		fs::write(sub.join("sub-file.txt"), "committed-in-sub\n").unwrap();
		git(&sub, &["add", "."]);
		git(&sub, &["commit", "-qm", "sub init"]);

		git(temp.path(), &[
			"-c",
			"protocol.file.allow=always",
			"submodule",
			"-q",
			"add",
			sub.to_str().unwrap(),
			"my-submodule",
		]);
		git(temp.path(), &["commit", "-qm", "add submodule"]);

		let checked_out_sub = temp.path().join("my-submodule");
		fs::write(checked_out_sub.join("dirty-untracked.txt"), "sub untracked\n").unwrap();
		fs::write(checked_out_sub.join("sub-file.txt"), "sub modified\n").unwrap();

		// 3. Parent untracked file
		fs::write(temp.path().join("parent-untracked.txt"), "delete\n").unwrap();

		// 4. Global excludesfile (core.excludesFile), configured *after* `repo`'s
		//    cached gix handle was opened by the staging calls above. The clean
		//    below must observe it or `global.env` is deleted.
		let global_exclude = outside.path().join("global-excludes");
		fs::write(&global_exclude, "global.env\n").unwrap();
		git(temp.path(), &["config", "core.excludesFile", global_exclude.to_str().unwrap()]);
		fs::write(temp.path().join("global.env"), "global-secret\n").unwrap();

		// 4b. Repository-local `.git/info/exclude`
		let info_dir = repo.info().git_dir.join("info");
		fs::create_dir_all(&info_dir).unwrap();
		fs::write(info_dir.join("exclude"), "info-excluded.env\n").unwrap();
		fs::write(temp.path().join("info-excluded.env"), "info-secret\n").unwrap();

		// 5. Untracked nested repository
		let untracked_repo = temp.path().join("untracked-nested-repo");
		fs::create_dir_all(&untracked_repo).unwrap();
		git(&untracked_repo, &["init", "-q", "-b", "main"]);
		fs::write(untracked_repo.join("nested.txt"), "nested content\n").unwrap();

		// 6. Symlink to directory (must unlink the symlink, not delete the target
		//    directory)
		#[cfg(unix)]
		let target_dir = outside.path().join("target-dir");
		#[cfg(unix)]
		{
			fs::create_dir_all(&target_dir).unwrap();
			fs::write(target_dir.join("important.txt"), "keep this\n").unwrap();
			std::os::unix::fs::symlink(&target_dir, temp.path().join("symlink-to-dir")).unwrap();
		}

		// 7. Untracked directory with file inside: empty directory gets pruned
		let to_prune = temp.path().join("untracked-dir/subdir");
		fs::create_dir_all(&to_prune).unwrap();
		fs::write(to_prune.join("leaf.txt"), "leaf\n").unwrap();

		// 8. Untracked directory initially empty: pruned (-d contract)
		let initially_empty = temp.path().join("initially-empty-dir");
		fs::create_dir_all(&initially_empty).unwrap();

		// 9. Ignored empty directory: MUST SURVIVE
		let ignored_empty = temp.path().join("ignored-empty-dir");
		fs::create_dir_all(&ignored_empty).unwrap();
		let sub_gitignore = temp.path().join(".gitignore");
		let mut current_gitignore = fs::read_to_string(&sub_gitignore).unwrap_or_default();
		current_gitignore.push_str("ignored-empty-dir/\n");
		fs::write(&sub_gitignore, current_gitignore).unwrap();

		repo
			.clean(&CleanOptions { paths: vec!["nested".into()], ..Default::default() })
			.unwrap();
		assert!(
			!nested.join("untracked.txt").exists(),
			"pathspec-scoped clean removes matches under the path"
		);
		assert!(
			nested.join("secret.env").exists(),
			"pathspec-scoped clean still honors nested ignores"
		);
		assert!(
			temp.path().join("parent-untracked.txt").exists(),
			"pathspec-scoped clean leaves paths outside the pathspec"
		);
		assert!(
			initially_empty.exists(),
			"pathspec-scoped clean leaves directories outside the pathspec"
		);
		// 10. Pathspec scoping: cleaning with a pathspec prunes empty dirs inside
		//     the pathspec but preserves the parent
		let pathspec_dir = temp.path().join("pathspec-parent/child/grandchild");
		fs::create_dir_all(&pathspec_dir).unwrap();
		fs::write(pathspec_dir.join("leaf.txt"), "leaf\n").unwrap();
		repo
			.clean(&CleanOptions { paths: vec!["pathspec-parent/child".into()], ..Default::default() })
			.unwrap();
		assert!(
			!temp.path().join("pathspec-parent/child").exists(),
			"empty dir inside pathspec must be pruned"
		);
		assert!(
			temp.path().join("pathspec-parent").exists(),
			"parent directory outside pathspec must not be pruned"
		);

		repo.clean(&CleanOptions::default()).unwrap();

		// Untracked files deleted and parent directories pruned
		assert!(!temp.path().join("parent-untracked.txt").exists());
		assert!(!nested.join("untracked.txt").exists());
		assert!(!temp.path().join("untracked-dir").exists());
		assert!(!temp.path().join("pathspec-parent").exists());
		assert!(!initially_empty.exists(), "empty untracked directory must be pruned by -d");

		// Ignored empty directory MUST SURVIVE
		assert!(ignored_empty.exists(), "ignored empty directory must survive clean");

		// Nested ignored file MUST SURVIVE
		assert!(nested.join("secret.env").exists());
		assert_eq!(fs::read_to_string(nested.join("secret.env")).unwrap(), "secret\n");

		// Global excluded file MUST SURVIVE (config set after the handle was
		// cached)
		assert!(temp.path().join("global.env").exists());
		assert_eq!(fs::read_to_string(temp.path().join("global.env")).unwrap(), "global-secret\n");

		// `.git/info/exclude` file MUST SURVIVE
		assert_eq!(
			fs::read_to_string(temp.path().join("info-excluded.env")).unwrap(),
			"info-secret\n"
		);

		// Submodule files and .git MUST SURVIVE
		assert!(checked_out_sub.join(".git").exists());
		assert!(checked_out_sub.join("sub-file.txt").exists());
		assert_eq!(
			fs::read_to_string(checked_out_sub.join("sub-file.txt")).unwrap(),
			"sub modified\n"
		);
		assert!(checked_out_sub.join("dirty-untracked.txt").exists());

		// Untracked nested repo MUST SURVIVE
		assert!(untracked_repo.join(".git").exists());
		assert!(untracked_repo.join("nested.txt").exists());
		// Symlink to directory: symlink is removed, target directory content
		// survives
		#[cfg(unix)]
		{
			assert!(!temp.path().join("symlink-to-dir").exists());
			assert!(target_dir.join("important.txt").exists());
		}
	}

	#[test]
	fn clean_rejects_empty_pathspec_and_treats_dot_as_everything() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join("untracked.txt"), "x").unwrap();

		let err = repo
			.clean(&CleanOptions { paths: vec![String::new()], ..Default::default() })
			.unwrap_err();
		assert!(
			err.to_string()
				.contains("empty string is not a valid pathspec"),
			"{err}"
		);
		assert!(
			temp.path().join("untracked.txt").exists(),
			"an empty pathspec must not widen to the whole worktree"
		);

		repo
			.clean(&CleanOptions { paths: vec!["./".into()], ..Default::default() })
			.unwrap();
		assert!(!temp.path().join("untracked.txt").exists(), "`.` selects everything like git");
	}

	#[cfg(unix)]
	#[test]
	fn detach_git_dir_does_not_mutate_when_index_snapshot_fails() {
		use std::os::unix::fs::PermissionsExt;

		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-unreadable-index");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				setup_owner:  None,
			})
			.unwrap();
		let common = fs::canonicalize(repo.info().common_dir.clone()).unwrap();
		let linked_repo = GitRepo::require(&linked).unwrap();
		let index_path = linked_repo.info().git_dir.join("index");
		let original_mode = fs::metadata(&index_path).unwrap().permissions().mode();
		let pointer_before = fs::read(linked.join(".git")).unwrap();
		fs::set_permissions(&index_path, fs::Permissions::from_mode(0o000)).unwrap();

		let result = detach_git_dir(&linked, &common);
		fs::set_permissions(&index_path, fs::Permissions::from_mode(original_mode)).unwrap();
		assert!(matches!(
			&result,
			Err(Error::Io(err)) if err.kind() == std::io::ErrorKind::PermissionDenied
		));
		assert_eq!(fs::read(linked.join(".git")).unwrap(), pointer_before);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), git(&linked, &["rev-parse", "HEAD"]));
		let _ = fs::remove_dir_all(linked);
	}

	#[test]
	fn worktree_registration_paths_are_accepted_by_git() {
		let (temp, repo) = fixture();
		let linked_dir = tempfile::tempdir().unwrap();
		let linked = linked_dir.path().to_path_buf();
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				setup_owner:  None,
			})
			.unwrap();

		let admin = registered_admin(&linked.join(".git")).unwrap().unwrap();
		assert_eq!(
			fs::read_to_string(linked.join(".git")).unwrap(),
			format!("gitdir: {}\n", git_metadata_path(&admin))
		);
		assert_eq!(
			fs::read_to_string(admin.join("gitdir")).unwrap(),
			format!("{}\n", git_metadata_path(&linked.join(".git")))
		);

		let listed = git(temp.path(), &["worktree", "list", "--porcelain"]);
		let expected = format!("worktree {}", git_metadata_path(&linked));
		assert!(listed.lines().any(|line| line == expected), "{listed}");
		git(temp.path(), &["worktree", "repair", linked.to_str().unwrap()]);
	}

	#[test]
	fn clone_first_worktree_reconciles_source_state_to_target_tree() {
		let (temp, repo) = fixture();
		fs::write(temp.path().join(".gitignore"), "build/\n").unwrap();
		git(temp.path(), &["add", ".gitignore"]);
		git(temp.path(), &["commit", "-qm", "ignore build"]);
		git(temp.path(), &["checkout", "-qb", "target"]);
		fs::write(temp.path().join("a"), "target\n").unwrap();
		fs::remove_file(temp.path().join("b")).unwrap();
		fs::write(temp.path().join("c"), "added\n").unwrap();
		git(temp.path(), &["add", "-A"]);
		git(temp.path(), &["commit", "-qm", "target tree"]);
		git(temp.path(), &["checkout", "-q", "main"]);
		fs::write(temp.path().join("a"), "dirty\n").unwrap();
		fs::write(temp.path().join("untracked"), "untracked\n").unwrap();
		fs::create_dir_all(temp.path().join("build")).unwrap();
		fs::write(temp.path().join("build/out.txt"), "ignored\n").unwrap();

		let linked = temp.path().join("../linked-clone-first");
		let _ = fs::remove_dir_all(&linked);
		let result = repo
			.worktree_add(&linked, "target", WorktreeAddOptions {
				detach:       false,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
				setup_owner:  None,
			})
			.unwrap();

		assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "target\n");
		assert_eq!(fs::read_to_string(linked.join("c")).unwrap(), "added\n");
		assert!(!linked.join("b").exists());
		assert!(!linked.join("untracked").exists());
		assert!(
			fs::read_to_string(linked.join(".git"))
				.unwrap()
				.starts_with("gitdir: ")
		);
		let linked_repo = GitRepo::require(&linked).unwrap();
		assert_eq!(
			fs::read_to_string(&linked_repo.info().head_path).unwrap(),
			"ref: refs/heads/target\n"
		);
		let gix = linked_repo.gix().unwrap();
		let mut status = status_with_fresh_index(&gix, "git status")
			.unwrap()
			.untracked_files(gix::status::UntrackedFiles::Files)
			.into_iter(std::iter::empty::<BString>())
			.unwrap();
		assert!(status.next().is_none());

		if result.cloned_with.is_some() {
			assert_eq!(fs::read_to_string(linked.join("build/out.txt")).unwrap(), "ignored\n");
		} else {
			assert!(!linked.join("build/out.txt").exists());
			assert!(
				result.clone_error.is_some() || pi_iso::clone_candidates(None).is_empty(),
				"a failed clone attempt must surface its reason"
			);
		}
		let _ = repo.worktree_remove(&linked, true);
	}

	/// Whether any host-available clone backend can actually clone a tree
	/// on `dir`'s filesystem. `pi_iso::clone_candidates` is a host-level
	/// probe only: Linux reports reflink support even when the temp dir
	/// sits on ext4, where `FICLONE` fails with `EOPNOTSUPP`.
	fn clone_works_on(dir: &Path) -> bool {
		let source = dir.join("clone-probe-src");
		let target = dir.join("clone-probe-dst");
		fs::create_dir_all(&source).unwrap();
		fs::write(source.join("file"), b"probe\n").unwrap();
		let works = pi_iso::clone_candidates(None).into_iter().any(|kind| {
			let _ = fs::remove_dir_all(&target);
			pi_iso::backend(kind)
				.clone_tree(&source, &target, &[])
				.is_ok()
		});
		let _ = fs::remove_dir_all(&source);
		let _ = fs::remove_dir_all(&target);
		works
	}

	#[test]
	fn clone_first_worktree_at_source_head_needs_no_checkout() {
		let (temp, repo) = fixture();
		git(temp.path(), &["branch", "same-as-head"]);
		let linked = temp.path().join("../linked-clone-noop");
		let _ = fs::remove_dir_all(&linked);
		let clone_works = clone_works_on(temp.path());
		let result = repo
			.worktree_add(&linked, "same-as-head", WorktreeAddOptions {
				detach:       false,
				clone:        WorktreeClone::Auto,
				keep_changes: false,
				setup_owner:  None,
			})
			.unwrap();
		if clone_works {
			assert!(
				result.cloned_with.is_some(),
				"an identical tree must not fail the clone path: {:?}",
				result.clone_error
			);
		} else {
			assert!(
				result.clone_error.is_some() || pi_iso::clone_candidates(None).is_empty(),
				"a failed clone attempt must surface its reason"
			);
		}
		assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
		assert_eq!(git(&linked, &["status", "--porcelain"]), "");
		let _ = repo.worktree_remove(&linked, true);
	}

	#[test]
	fn worktree_add_keep_changes_carries_dirty_state_on_both_paths() {
		for clone in [WorktreeClone::Auto, WorktreeClone::Off] {
			let (temp, repo) = fixture();
			fs::write(temp.path().join(".gitignore"), "build/\n").unwrap();
			git(temp.path(), &["add", ".gitignore"]);
			git(temp.path(), &["commit", "-qm", "ignore build"]);
			fs::write(temp.path().join("a"), "staged\n").unwrap();
			git(temp.path(), &["add", "a"]);
			fs::write(temp.path().join("a"), "staged then edited\n").unwrap();
			fs::remove_file(temp.path().join("b")).unwrap();
			fs::create_dir_all(temp.path().join("new/dir")).unwrap();
			fs::write(temp.path().join("new/dir/untracked"), "untracked\n").unwrap();
			fs::create_dir_all(temp.path().join("build")).unwrap();
			fs::write(temp.path().join("build/out.txt"), "ignored\n").unwrap();
			git(temp.path(), &["branch", "kept"]);

			let linked = temp.path().join(format!("../linked-keep-{clone:?}"));
			let _ = fs::remove_dir_all(&linked);
			let result = repo
				.worktree_add(&linked, "kept", WorktreeAddOptions {
					detach: false,
					clone,
					keep_changes: true,
					setup_owner: None,
				})
				.unwrap();
			if clone == WorktreeClone::Off {
				assert!(result.cloned_with.is_none());
			}

			assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "staged then edited\n");
			assert!(!linked.join("b").exists());
			assert_eq!(fs::read_to_string(linked.join("new/dir/untracked")).unwrap(), "untracked\n");
			assert_eq!(
				linked.join("build/out.txt").exists(),
				result.cloned_with.is_some(),
				"ignored files ride along only with a clone"
			);
			assert_eq!(
				git(&linked, &["status", "--porcelain"]),
				git(temp.path(), &["status", "--porcelain"]),
				"linked worktree must report the same staged/unstaged/untracked set"
			);
			assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
			assert_eq!(git(&linked, &["symbolic-ref", "HEAD"]), "refs/heads/kept");
			// The source keeps its own dirty state untouched.
			assert_eq!(fs::read_to_string(temp.path().join("a")).unwrap(), "staged then edited\n");

			let rejected = repo.worktree_add(
				&temp.path().join("../linked-keep-rejected"),
				"HEAD~1",
				WorktreeAddOptions { detach: true, clone, keep_changes: true, setup_owner: None },
			);
			assert!(rejected.is_err(), "keep_changes must require the source HEAD as target");
			let _ = repo.worktree_remove(&linked, true);
		}
	}

	#[test]
	fn worktree_add_keep_changes_carries_staged_only_state_without_phantom_edits() {
		for clone in [WorktreeClone::Auto, WorktreeClone::Off] {
			let (temp, repo) = fixture();
			fs::write(temp.path().join("c"), "three\n").unwrap();
			git(temp.path(), &["add", "c"]);
			git(temp.path(), &["commit", "-qm", "add c"]);
			// The source keeps its LF files; a plain checkout under autocrlf
			// writes CRLF, so clean files land at a different size.
			git(temp.path(), &["config", "core.autocrlf", "true"]);
			fs::write(temp.path().join("a"), "staged only\n").unwrap();
			git(temp.path(), &["add", "a"]);
			git(temp.path(), &["rm", "-q", "b"]);
			fs::write(temp.path().join("added"), "staged add\n").unwrap();
			git(temp.path(), &["add", "added"]);
			let source_status = git(temp.path(), &["status", "--porcelain"]);
			assert_eq!(source_status, "M  a\nA  added\nD  b");
			git(temp.path(), &["branch", "kept-staged"]);

			let linked = temp.path().join(format!("../linked-keep-staged-{clone:?}"));
			let _ = fs::remove_dir_all(&linked);
			let result = repo
				.worktree_add(&linked, "kept-staged", WorktreeAddOptions {
					detach: false,
					clone,
					keep_changes: true,
					setup_owner: None,
				})
				.unwrap();
			if clone == WorktreeClone::Off {
				assert!(result.cloned_with.is_none());
			}

			assert_eq!(fs::read_to_string(linked.join("a")).unwrap(), "staged only\n");
			assert_eq!(fs::read_to_string(linked.join("added")).unwrap(), "staged add\n");
			assert!(!linked.join("b").exists());
			assert_eq!(
				git(&linked, &["status", "--porcelain"]),
				source_status,
				"clean and staged-only files must not read as unstaged edits"
			);
			let _ = repo.worktree_remove(&linked, true);
		}
	}

	#[test]
	fn delete_branch_drops_only_that_branchs_config_section() {
		let (temp, repo) = fixture();
		git(temp.path(), &["branch", "feature"]);
		git(temp.path(), &["branch", "keep"]);
		for (branch, key, value) in [
			("feature", "remote", "origin"),
			("feature", "merge", "refs/heads/feature"),
			("feature", "ompCustom", "yes"),
			("keep", "remote", "origin"),
		] {
			repo
				.config_set(&format!("branch.{branch}.{key}"), value)
				.unwrap();
		}
		repo.config_set("custom.unrelated", "stay").unwrap();

		assert!(repo.delete_branch("feature", true).unwrap());

		let config = fs::read_to_string(temp.path().join(".git/config")).unwrap();
		assert!(!config.contains("[branch \"feature\"]"), "{config}");
		assert!(!config.contains("ompCustom"), "{config}");
		assert!(config.contains("[branch \"keep\"]"), "{config}");
		assert!(config.contains("unrelated = stay"), "{config}");
		assert_eq!(git(temp.path(), &["config", "--get", "branch.keep.remote"]), "origin");
		assert!(!temp.path().join(".git/config.lock").exists(), "the config lock is released");
	}

	#[test]
	fn delete_branch_leaves_branch_config_alone_while_another_writer_holds_config_lock() {
		let (temp, repo) = fixture();
		git(temp.path(), &["branch", "feature"]);
		repo.config_set("branch.feature.remote", "origin").unwrap();
		let lock = temp.path().join(".git/config.lock");
		fs::write(&lock, "[other]\n\twriter = busy\n").unwrap();

		assert!(repo.delete_branch("feature", true).unwrap());

		assert!(
			git(temp.path(), &["for-each-ref", "refs/heads/feature"]).is_empty(),
			"the branch ref is gone"
		);
		let config = fs::read_to_string(temp.path().join(".git/config")).unwrap();
		assert!(config.contains("[branch \"feature\"]"), "{config}");
		assert_eq!(fs::read_to_string(&lock).unwrap(), "[other]\n\twriter = busy\n");
	}

	#[cfg(unix)]
	#[test]
	fn delete_branch_keeps_the_config_files_permissions() {
		use std::os::unix::fs::PermissionsExt;
		let (temp, repo) = fixture();
		git(temp.path(), &["branch", "feature"]);
		repo.config_set("branch.feature.remote", "origin").unwrap();
		let config = temp.path().join(".git/config");
		// A config holding credentials kept private by its owner.
		fs::set_permissions(&config, fs::Permissions::from_mode(0o600)).unwrap();

		assert!(repo.delete_branch("feature", true).unwrap());

		assert!(
			!fs::read_to_string(&config)
				.unwrap()
				.contains("[branch \"feature\"]")
		);
		assert_eq!(fs::metadata(&config).unwrap().permissions().mode() & 0o777, 0o600);
	}

	#[cfg(unix)]
	#[test]
	fn delete_branch_edits_the_target_of_a_symlinked_config() {
		let (temp, repo) = fixture();
		let outside = tempfile::tempdir().unwrap();
		let link = temp.path().join(".git/config");
		let target = outside.path().join("config");
		fs::rename(&link, &target).unwrap();
		std::os::unix::fs::symlink(&target, &link).unwrap();
		git(temp.path(), &["branch", "feature"]);
		repo.config_set("branch.feature.remote", "origin").unwrap();

		assert!(repo.delete_branch("feature", true).unwrap());

		assert!(
			fs::symlink_metadata(&link)
				.unwrap()
				.file_type()
				.is_symlink(),
			"the link is kept"
		);
		let config = fs::read_to_string(&target).unwrap();
		assert!(!config.contains("[branch \"feature\"]"), "{config}");
		assert!(
			!outside.path().join("config.lock").exists()
				&& !temp.path().join(".git/config.lock").exists()
		);
	}

	#[test]
	fn swap_branch_only_changes_the_branch_when_expected_holds() {
		let (temp, repo) = fixture();
		let first = git(temp.path(), &["rev-parse", "HEAD"]);
		fs::write(temp.path().join("swap"), "x\n").unwrap();
		git(temp.path(), &["add", "swap"]);
		git(temp.path(), &["commit", "-qm", "second"]);
		let second = git(temp.path(), &["rev-parse", "HEAD"]);
		let head_of = |branch: &str| git(temp.path(), &["rev-parse", "--verify", branch]);

		// Create only while absent.
		assert!(repo.swap_branch("swap", None, Some(&first)).unwrap());
		assert_eq!(head_of("swap"), first);
		assert!(!repo.swap_branch("swap", None, Some(&second)).unwrap());
		assert_eq!(head_of("swap"), first);

		// Update only from the expected value.
		assert!(
			!repo
				.swap_branch("swap", Some(&second), Some(&second))
				.unwrap()
		);
		assert_eq!(head_of("swap"), first);
		assert!(
			repo
				.swap_branch("swap", Some(&first), Some(&second))
				.unwrap()
		);
		assert_eq!(head_of("swap"), second);
		assert!(
			git(temp.path(), &["reflog", "show", "refs/heads/swap"]).contains("omp: restore branch")
		);

		// Delete only from the expected value, dropping the branch config.
		repo.config_set("branch.swap.remote", "origin").unwrap();
		repo.config_set("branch.other.remote", "origin").unwrap();
		assert!(!repo.swap_branch("swap", Some(&first), None).unwrap());
		assert_eq!(head_of("swap"), second);
		assert!(repo.swap_branch("swap", Some(&second), None).unwrap());
		assert!(repo.resolve_ref("refs/heads/swap").unwrap().is_none());
		let config = fs::read_to_string(temp.path().join(".git/config")).unwrap();
		assert!(!config.contains("[branch \"swap\"]"), "{config}");
		assert!(config.contains("[branch \"other\"]"), "{config}");

		// Deleting a branch that no longer exists is a failed expectation.
		assert!(!repo.swap_branch("swap", Some(&second), None).unwrap());
		assert!(repo.swap_branch("swap", Some("not-an-oid"), None).is_err());
	}

	#[test]
	fn swap_branch_leaves_a_branch_checked_out_in_a_worktree() {
		let (temp, repo) = fixture();
		let first = git(temp.path(), &["rev-parse", "HEAD"]);
		fs::write(temp.path().join("swap"), "x\n").unwrap();
		git(temp.path(), &["add", "swap"]);
		git(temp.path(), &["commit", "-qm", "second"]);
		let second = git(temp.path(), &["rev-parse", "HEAD"]);
		git(temp.path(), &["branch", "busy", &first]);
		let linked = temp.path().join("../linked-swap-busy");
		let _ = fs::remove_dir_all(&linked);
		git(temp.path(), &["worktree", "add", linked.to_str().unwrap(), "busy"]);

		assert!(
			!repo
				.swap_branch("busy", Some(&first), Some(&second))
				.unwrap()
		);
		assert!(!repo.swap_branch("busy", Some(&first), None).unwrap());
		assert_eq!(git(temp.path(), &["rev-parse", "--verify", "busy"]), first);
		let _ = repo.worktree_remove(&linked, true);
	}

	/// Commit `name` with a file change and return its oid.
	fn commit_file(dir: &Path, name: &str) -> String {
		fs::write(dir.join(name), "x\n").unwrap();
		git(dir, &["add", name]);
		git(dir, &["commit", "-qm", name]);
		git(dir, &["rev-parse", "HEAD"])
	}

	#[test]
	fn swap_branch_checks_the_expected_value_under_the_ref_lock() {
		let (temp, repo) = fixture();
		let a = git(temp.path(), &["rev-parse", "HEAD"]);
		let b = commit_file(temp.path(), "b");
		let c = commit_file(temp.path(), "c");
		git(temp.path(), &["config", "core.filesRefLockTimeout", "5000"]);
		git(temp.path(), &["branch", "x", &a]);
		let live = temp.path().join(".git/refs/heads/x");
		let lock = temp.path().join(".git/refs/heads/x.lock");
		fs::write(&lock, format!("{b}\n")).unwrap();

		let result = std::thread::scope(|scope| {
			let writer = scope.spawn(|| {
				std::thread::sleep(std::time::Duration::from_millis(300));
				fs::rename(&lock, &live).unwrap();
			});
			let result = repo.swap_branch("x", Some(&a), Some(&c));
			writer.join().unwrap();
			result
		});

		assert!(!result.unwrap());
		assert_eq!(git(temp.path(), &["rev-parse", "--verify", "x"]), b);
	}

	#[test]
	fn swap_branch_with_no_expected_and_no_target_reports_absence() {
		let (temp, repo) = fixture();
		let a = git(temp.path(), &["rev-parse", "HEAD"]);
		assert!(repo.swap_branch("gone", None, None).unwrap());
		git(temp.path(), &["branch", "here", &a]);
		assert!(!repo.swap_branch("here", None, None).unwrap());
		assert_eq!(git(temp.path(), &["rev-parse", "--verify", "here"]), a);
	}

	#[test]
	fn swap_branch_holds_the_worktree_add_lock_across_the_checked_out_check() {
		let (temp, repo) = fixture();
		let a = git(temp.path(), &["rev-parse", "HEAD"]);
		git(temp.path(), &["branch", "busy", &a]);
		let linked = temp.path().join("../linked-swap-lock");
		let _ = fs::remove_dir_all(&linked);

		let guard = lock_worktree_adds(&repo.info().common_dir).unwrap();
		let result = std::thread::scope(|scope| {
			let swap = scope.spawn(|| repo.swap_branch("busy", Some(&a), None));
			std::thread::sleep(std::time::Duration::from_millis(200));
			assert!(!swap.is_finished(), "swap_branch ran without the worktree-add lock");
			git(temp.path(), &["worktree", "add", linked.to_str().unwrap(), "busy"]);
			drop(guard);
			swap.join().unwrap()
		});

		assert!(!result.unwrap());
		assert_eq!(git(temp.path(), &["rev-parse", "--verify", "busy"]), a);
		let _ = repo.worktree_remove(&linked, true);
	}

	#[test]
	fn mutate_worktree_and_detach() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-mut");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				setup_owner:  None,
			})
			.unwrap();
		assert!(
			git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(git_metadata_path(&linked).as_ref())
		);
		assert!(repo.worktree_remove(&linked, true).unwrap());

		let linked = temp.path().join("../linked-detach");
		let _ = fs::remove_dir_all(&linked);
		repo
			.worktree_add(&linked, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				setup_owner:  None,
			})
			.unwrap();
		let common = fs::canonicalize(repo.info().common_dir.clone()).unwrap();
		let source_head = git(temp.path(), &["rev-parse", "HEAD"]);
		assert_eq!(detach_git_dir(&linked, &common).unwrap(), DetachGitDirResult::Detached);
		let alternates = fs::read_to_string(linked.join(".git/objects/info/alternates")).unwrap();
		assert!(alternates.contains(common.join("objects").to_string_lossy().as_ref()));
		assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), source_head);
		assert!(
			!git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(git_metadata_path(&linked).as_ref())
		);
		assert!(repo.worktree_prune().is_ok());
		let _ = fs::remove_dir_all(linked);
	}

	fn setup_owner_of(repo: &GitRepo, path: &Path) -> Vec<Option<String>> {
		let entries = repo.worktrees().unwrap();
		entries
			.into_iter()
			.filter(|entry| entry.path == path)
			.map(|entry| entry.setup_owner)
			.collect()
	}

	fn add_detached(repo: &GitRepo, path: &Path, setup_owner: Option<&str>) {
		repo
			.worktree_add(path, "main", WorktreeAddOptions {
				detach:       true,
				clone:        WorktreeClone::Off,
				keep_changes: false,
				setup_owner:  setup_owner.map(str::to_owned),
			})
			.unwrap();
	}

	#[test]
	fn setup_mark_outlives_git_lock_and_leaves_git_commands_alone() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-setup-mark");
		let _ = fs::remove_dir_all(&linked);
		add_detached(&repo, &linked, Some("owner-1"));

		// Created: git's `initializing` lock is lifted, as git lifts it before
		// running hooks…
		assert!(!git(temp.path(), &["worktree", "list", "--porcelain"]).contains("locked"));
		// …while other processes still see the setup as unfinished.
		assert_eq!(setup_owner_of(&repo, &linked), [Some("owner-1".to_owned())]);
		// A hook can lock its new worktree, and ending the setup leaves that lock
		// alone.
		git(temp.path(), &["worktree", "lock", "--reason", "by-hook", linked.to_str().unwrap()]);
		repo.worktree_end_setup(&linked).unwrap();
		assert_eq!(setup_owner_of(&repo, &linked), [None]);
		assert!(git(temp.path(), &["worktree", "list", "--porcelain"]).contains("locked by-hook"));
		git(temp.path(), &["worktree", "unlock", linked.to_str().unwrap()]);
		assert!(repo.worktree_remove(&linked, true).unwrap());
	}

	#[test]
	fn replace_setup_owner_swaps_only_the_expected_owner() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-setup-swap");
		let _ = fs::remove_dir_all(&linked);
		add_detached(&repo, &linked, Some("a"));
		let admin = repo.worktree_admin(&linked).unwrap().unwrap();

		assert!(
			repo
				.worktree_replace_setup_owner(&admin, "a", Some("b"))
				.unwrap()
		);
		assert_eq!(setup_owner_of(&repo, &linked), [Some("b".to_owned())]);
		assert!(
			!repo
				.worktree_replace_setup_owner(&admin, "a", None)
				.unwrap()
		);
		assert_eq!(setup_owner_of(&repo, &linked), [Some("b".to_owned())]);
		assert!(
			repo
				.worktree_replace_setup_owner(&admin, "b", None)
				.unwrap()
		);
		assert_eq!(setup_owner_of(&repo, &linked), [None]);
		assert!(repo.worktree_remove(&linked, true).unwrap());
	}

	#[test]
	fn replace_setup_owner_refuses_a_directory_outside_worktrees() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		assert!(
			repo
				.worktree_replace_setup_owner(&common, "a", None)
				.is_err()
		);
	}

	#[test]
	fn an_unreadable_setup_mark_is_an_error_not_a_finished_setup() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-setup-unreadable");
		let _ = fs::remove_dir_all(&linked);
		add_detached(&repo, &linked, None);
		// Neither missing nor readable, as on shared metadata that is briefly
		// unavailable.
		let admin = repo.worktree_admin(&linked).unwrap().unwrap();
		fs::create_dir(admin.join(SETUP_MARK)).unwrap();
		assert!(repo.worktrees().is_err());
		fs::remove_dir(admin.join(SETUP_MARK)).unwrap();
		assert!(repo.worktree_remove(&linked, true).unwrap());
	}

	#[test]
	fn ending_a_setup_finds_its_own_registration() {
		let (temp, repo) = fixture();
		// A stale registration of the same path: removed with `rm -rf`, never
		// pruned.
		let twin = temp.path().join("../linked-setup-twin");
		let _ = fs::remove_dir_all(&twin);
		git(temp.path(), &["worktree", "add", "-q", "--detach", twin.to_str().unwrap()]);
		fs::remove_dir_all(&twin).unwrap();
		add_detached(&repo, &twin, Some("owner-1"));
		repo.worktree_end_setup(&twin).unwrap();
		assert!(setup_owner_of(&repo, &twin).iter().all(Option::is_none));
		assert!(repo.worktree_remove(&twin, true).unwrap());

		// The hook deleted the checkout's `.git`: found through the registration
		// instead.
		let gone = temp.path().join("../linked-setup-gone");
		let _ = fs::remove_dir_all(&gone);
		add_detached(&repo, &gone, Some("owner-1"));
		fs::remove_file(gone.join(".git")).unwrap();
		repo.worktree_end_setup(&gone).unwrap();
		assert_eq!(setup_owner_of(&repo, &gone), [None]);
		fs::remove_dir_all(&gone).unwrap();
		repo.worktree_prune().unwrap();
		assert!(setup_owner_of(&repo, &gone).is_empty());
	}

	#[test]
	fn prune_keeps_worktrees_git_locked() {
		let (temp, repo) = fixture();
		let offline = temp.path().join("../linked-prune-offline");
		let stale = temp.path().join("../linked-prune-stale");
		for dir in [&offline, &stale] {
			let _ = fs::remove_dir_all(dir);
			add_detached(&repo, dir, None);
		}
		// Locked while its volume is offline: git keeps its registration.
		git(temp.path(), &["worktree", "lock", "--reason", "offline", offline.to_str().unwrap()]);
		fs::remove_dir_all(&offline).unwrap();
		fs::remove_dir_all(&stale).unwrap();
		repo.worktree_prune().unwrap();
		assert_eq!(setup_owner_of(&repo, &offline).len(), 1);
		assert!(setup_owner_of(&repo, &stale).is_empty());
		git(temp.path(), &["worktree", "unlock", offline.to_str().unwrap()]);
		repo.worktree_prune().unwrap();
	}

	#[test]
	fn remove_without_git_file_spares_enclosing_worktree() {
		let (temp, repo) = fixture();
		let outer = temp.path().join("../linked-remove-outer");
		let _ = fs::remove_dir_all(&outer);
		add_detached(&repo, &outer, None);
		let inner = outer.join("nested");
		add_detached(&repo, &inner, None);
		fs::remove_file(inner.join(".git")).unwrap();
		let outer_admin = GitRepo::require(&outer).unwrap().info().git_dir.clone();

		assert!(!repo.worktree_remove(&inner, true).unwrap());
		assert!(outer_admin.exists());
		assert!(outer.join(".git").exists());
		assert_eq!(setup_owner_of(&repo, &outer).len(), 1);

		fs::remove_dir_all(&inner).unwrap();
		repo.worktree_prune().unwrap();
		assert!(repo.worktree_remove(&outer, true).unwrap());
	}

	#[test]
	fn prune_keeps_worktrees_still_being_set_up() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-prune-setup");
		let away = temp.path().join("../linked-prune-setup-away");
		for dir in [&linked, &away] {
			let _ = fs::remove_dir_all(dir);
		}
		add_detached(&repo, &linked, Some("owner-1"));
		// Checkout moved away, as when its volume is offline.
		fs::rename(&linked, &away).unwrap();
		repo.worktree_prune().unwrap();
		assert_eq!(setup_owner_of(&repo, &linked), [Some("owner-1".to_owned())]);
		repo.worktree_end_setup(&linked).unwrap();
		repo.worktree_prune().unwrap();
		assert!(setup_owner_of(&repo, &linked).is_empty());
		fs::remove_dir_all(&away).unwrap();
	}

	#[cfg(unix)]
	#[test]
	fn failed_registration_leaves_no_entry_behind() {
		use std::os::unix::fs::PermissionsExt;
		let (temp, repo) = fixture();
		let target = temp.path().join("../linked-read-only");
		let _ = fs::remove_dir_all(&target);
		fs::create_dir(&target).unwrap();
		fs::set_permissions(&target, fs::Permissions::from_mode(0o555)).unwrap();
		// Root writes anyway, so there would be no failure to observe.
		if fs::write(target.join("probe"), "").is_ok() {
			let _ = fs::remove_dir_all(&target);
			return;
		}
		let added = repo.worktree_add(&target, "main", WorktreeAddOptions {
			detach:       true,
			clone:        WorktreeClone::Off,
			keep_changes: false,
			setup_owner:  Some("owner-1".to_owned()),
		});
		fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
		let _ = fs::remove_dir_all(&target);

		assert!(added.is_err());
		// A locked leftover would be listed by nothing and pruned by nothing.
		let admins = fs::read_dir(repo.info().common_dir.join("worktrees"));
		assert!(admins.map_or(true, |mut admins| admins.next().is_none()));
	}

	#[test]
	fn two_adds_of_one_path_at_once_never_share_a_checkout() {
		let (temp, repo) = fixture();
		let root = temp.path().to_path_buf();
		for round in 0..10 {
			let target = root.join(format!("../linked-race-{round}"));
			let _ = fs::remove_dir_all(&target);
			let barrier = std::sync::Barrier::new(2);
			let results: Vec<std::result::Result<(), String>> = std::thread::scope(|scope| {
				let racers: Vec<_> = (0..2)
					.map(|_| {
						scope.spawn(|| {
							let own = GitRepo::require(&root).unwrap();
							barrier.wait();
							own.worktree_add(&target, "main", WorktreeAddOptions {
								detach:       true,
								clone:        WorktreeClone::Off,
								keep_changes: false,
								setup_owner:  None,
							})
							.map(|_| ())
							.map_err(|err| err.to_string())
						})
					})
					.collect();
				racers
					.into_iter()
					.map(|racer| racer.join().unwrap())
					.collect()
			});
			let failures: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).collect();
			assert_eq!(failures.len(), 1, "round {round}: exactly one add must win: {results:?}");
			assert!(failures[0].contains("not empty"), "round {round}: {}", failures[0]);
			assert_eq!(setup_owner_of(&repo, &target).len(), 1, "round {round}");
			let _ = repo.worktree_remove(&target, true);
			let _ = fs::remove_dir_all(&target);
		}
	}

	#[test]
	fn a_worktree_whose_creation_lock_cannot_be_lifted_is_rolled_back_not_left_owned() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-stuck-lock");
		let _ = fs::remove_dir_all(&linked);
		add_detached(&repo, &linked, Some("owner-1"));
		let admin = repo.worktree_admin(&linked).unwrap().unwrap();
		// A non-empty directory cannot be removed as a file.
		fs::create_dir(admin.join("locked")).unwrap();
		fs::write(admin.join("locked").join("stuck"), "").unwrap();

		assert!(finish_worktree_add(&linked, &admin).is_err());

		assert!(!linked.exists());
		assert!(setup_owner_of(&repo, &linked).is_empty());
		assert!(!admin.join(SETUP_MARK).exists());
	}

	/// Roll back an add whose `locked` can't be lifted while `stuck` (given the
	/// admin dir and the checkout, and naming a directory in either) is made
	/// read-only, then report what `worktrees()` lists for it.
	#[cfg(unix)]
	fn worktrees_after_a_stuck_rollback(
		name: &str,
		stuck: impl Fn(&Path, &Path) -> PathBuf,
	) -> (Result<()>, Result<Vec<Option<String>>>) {
		use std::os::unix::fs::PermissionsExt;
		let (temp, repo) = fixture();
		let linked = temp.path().join(format!("../{name}"));
		let _ = fs::remove_dir_all(&linked);
		add_detached(&repo, &linked, Some("owner-1"));
		let admin = repo.worktree_admin(&linked).unwrap().unwrap();
		// A `locked` that can't be removed as a file, as one held open without
		// delete sharing on Windows.
		fs::create_dir(admin.join("locked")).unwrap();
		fs::write(admin.join("locked").join("stuck"), "").unwrap();
		let stuck = stuck(&admin, &linked);
		fs::set_permissions(&stuck, fs::Permissions::from_mode(0o500)).unwrap();

		let rolled_back = finish_worktree_add(&linked, &admin);
		let listed = repo.worktrees().map(|entries| {
			entries
				.into_iter()
				.filter(|entry| entry.path == linked)
				.map(|entry| entry.setup_owner)
				.collect()
		});
		fs::set_permissions(&stuck, fs::Permissions::from_mode(0o700)).unwrap();
		let _ = fs::remove_dir_all(&admin);
		let _ = fs::remove_dir_all(&linked);
		(rolled_back, listed)
	}

	#[cfg(unix)]
	#[test]
	fn a_rollback_stuck_on_the_creation_lock_unlists_the_worktree_instead_of_half_listing_it() {
		// Root deletes regardless of permissions.
		if unsafe { libc::geteuid() } == 0 {
			return;
		}
		let (rolled_back, listed) =
			worktrees_after_a_stuck_rollback("linked-stuck-lock-dir", |admin, _| admin.join("locked"));
		assert!(rolled_back.is_err());
		// Never listed without its `HEAD`, which would fail every listing.
		assert_eq!(listed.unwrap(), Vec::<Option<String>>::new());
	}

	#[cfg(unix)]
	#[test]
	fn a_rollback_that_cannot_unlist_the_worktree_leaves_it_owned() {
		if unsafe { libc::geteuid() } == 0 {
			return;
		}
		let (rolled_back, listed) =
			worktrees_after_a_stuck_rollback("linked-stuck-admin", |admin, _| admin.to_path_buf());
		assert!(rolled_back.is_err());
		// Still listed, so other processes must see it as being set up.
		assert_eq!(listed.unwrap(), [Some("owner-1".to_owned())]);
	}

	#[cfg(unix)]
	#[test]
	fn a_rollback_that_cannot_delete_the_checkout_keeps_the_worktree_listed_and_owned() {
		if unsafe { libc::geteuid() } == 0 {
			return;
		}
		let (rolled_back, listed) =
			worktrees_after_a_stuck_rollback("linked-stuck-checkout", |_, linked| {
				let held = linked.join("held");
				fs::create_dir(&held).unwrap();
				fs::write(held.join("file"), "").unwrap();
				held
			});
		assert!(rolled_back.is_err());
		// Unlisted, the surviving checkout would point at deleted admin data.
		assert_eq!(listed.unwrap(), [Some("owner-1".to_owned())]);
	}

	#[test]
	fn without_file_locks_a_second_add_waits_for_the_first_claim_and_is_refused_after_the_wait() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		let first = claim_worktree_adds(&common, std::time::Duration::ZERO).unwrap();
		let refused = claim_worktree_adds(&common, std::time::Duration::ZERO)
			.err()
			.unwrap();
		assert!(refused.to_string().contains("omp-worktree-add.claim"), "{refused}");
		std::thread::scope(|scope| {
			let waiting = scope
				.spawn(|| claim_worktree_adds(&common, std::time::Duration::from_secs(10)).is_ok());
			// Only makes it likely the waiter already met the claim; it gets it
			// either way.
			std::thread::sleep(std::time::Duration::from_millis(50));
			drop(first);
			assert!(waiting.join().unwrap(), "a waiting add must get the claim once it is free");
		});
	}

	#[test]
	fn exit_cleanup_leaves_the_claim_of_an_add_still_running_after_the_wait() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		let claim = common.join("omp-worktree-add.claim");
		let running = claim_worktree_adds(&common, std::time::Duration::ZERO).unwrap();
		release_worktree_add_claims(std::time::Duration::from_millis(50));
		assert!(claim.exists(), "exit cleanup deleted the claim of an add still writing its path");
		let refused = claim_worktree_adds(&common, std::time::Duration::ZERO)
			.err()
			.unwrap();
		assert!(refused.to_string().contains("omp-worktree-add.claim"), "{refused}");
		drop(running);
		assert!(!claim.exists());
	}

	#[test]
	fn exit_cleanup_waits_for_a_running_add_before_freeing_its_claim() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		let claim = common.join("omp-worktree-add.claim");
		let running = claim_worktree_adds(&common, std::time::Duration::ZERO).unwrap();
		std::thread::scope(|scope| {
			scope.spawn(|| {
				// Only makes it likely the release already waits; it must not
				// delete the file before the add ends either way.
				std::thread::sleep(std::time::Duration::from_millis(100));
				assert!(claim.exists(), "exit cleanup deleted the claim of a running add");
				drop(running);
			});
			release_worktree_add_claims(std::time::Duration::from_secs(10));
		});
		assert!(!claim.exists());
	}

	fn hold_add_lock(common: &Path) -> fs::File {
		let file = fs::OpenOptions::new()
			.create(true)
			.write(true)
			.truncate(false)
			.open(common.join("omp-worktree-add.lock"))
			.unwrap();
		file.lock().unwrap();
		file
	}

	#[test]
	fn an_add_behind_a_stalled_lock_holder_is_refused_after_the_wait_instead_of_hanging() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		let _stalled = hold_add_lock(&common);
		let (sender, receiver) = std::sync::mpsc::channel();
		// Detached: on a build that blocks forever this must fail the test, not
		// hang it.
		std::thread::spawn(move || {
			let refused = lock_worktree_adds_within(&common, std::time::Duration::ZERO)
				.err()
				.map(|err| err.to_string());
			let _ = sender.send(refused);
		});
		let refused = receiver
			.recv_timeout(std::time::Duration::from_secs(5))
			.expect("the add waited on the lock past its deadline")
			.expect("an add must not get a lock another process holds");
		assert!(refused.contains("omp-worktree-add.lock"), "{refused}");
	}

	#[test]
	fn a_waiting_add_gets_the_lock_once_the_holder_releases_it() {
		let (_temp, repo) = fixture();
		let common = repo.info().common_dir.clone();
		let holder = hold_add_lock(&common);
		std::thread::scope(|scope| {
			let waiting = scope.spawn(|| {
				lock_worktree_adds_within(&common, std::time::Duration::from_secs(10)).is_ok()
			});
			// Only makes it likely the waiter already met the lock; it gets it
			// either way.
			std::thread::sleep(std::time::Duration::from_millis(50));
			drop(holder);
			assert!(waiting.join().unwrap(), "a waiting add must get the lock once it is free");
		});
	}
}
