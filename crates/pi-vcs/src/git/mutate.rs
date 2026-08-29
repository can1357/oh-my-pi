//! In-process local Git mutations.

use std::{
	collections::{BTreeMap, BTreeSet},
	ffi::OsStr,
	fs,
	path::{Path, PathBuf},
	process::{Command, Stdio},
};

use gix::bstr::{BString, ByteSlice};

use super::{GitRepo, normalize_path};
use crate::{
	error::{Error, Result},
	types::{CleanOptions, CommitOptions, DetachGitDirResult, ResetMode, RestoreOptions},
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
		gix::actor::SignatureRef {
			name:  "oh-my-pi".into(),
			email: "omp@localhost".into(),
			time:  &now,
		}
	};
	repo
		.edit_references_as(Some(edit), Some(committer))
		.map_err(|err| Error::backend(op, err))?;
	Ok(())
}

impl GitRepo {
	/// Stage worktree files, or every change when `files` is empty.
	pub fn stage_files(&self, files: &[String]) -> Result<()> {
		let repo = self.gix()?;
		let mut index = repo
			.index_or_load_from_head_or_empty()
			.map_err(|err| Error::backend("git add", err))?
			.into_owned();
		let mut selected = collect_stage_paths(self.root(), files)?;
		let all = files.is_empty();
		let requested: BTreeSet<&str> = files.iter().map(String::as_str).collect();
		for entry in index.entries() {
			let path = entry.path(&index).to_str_lossy().into_owned();
			if (all || requested.iter().any(|wanted| path_matches(&path, wanted)))
				&& fs::symlink_metadata(self.root().join(&path)).is_ok()
			{
				selected.insert(path);
			}
		}
		index.remove_entries(|_, path, _| {
			let p = path.to_str_lossy();
			(all || requested.iter().any(|wanted| path_matches(&p, wanted)))
				&& !selected.contains(&p.into_owned())
		});
		for path in selected {
			stage_one(&repo, self.root(), &mut index, &path)?;
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
		let mut current = repo
			.index_or_load_from_head_or_empty()
			.map_err(|err| Error::backend("git reset", err))?
			.into_owned();
		copy_index_paths(&mut current, &head_index, files);
		current
			.write(INDEX_WRITE)
			.map_err(|err| Error::backend("git reset", err))
	}

	/// Create a commit and return its object id.
	pub fn commit_create(&self, message: &str, options: &CommitOptions) -> Result<String> {
		let repo = self.gix()?;
		run_commit_hook(self, &repo, "pre-commit", &[])?;
		let mut head = repo
			.head()
			.map_err(|err| Error::backend("git commit", err))?;
		let old_commit = head
			.try_peel_to_id()
			.map_err(|err| Error::backend("git commit", err))?
			.map(|id| id.detach());
		let index = repo
			.index_or_load_from_head_or_empty()
			.map_err(|err| Error::backend("git commit", err))?
			.into_owned();
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
		let override_author;
		let mut author_time = gix::date::parse::TimeBuf::default();
		let author = if let Some(author) = &options.author {
			let time = match &author.date {
				Some(date) => {
					gix::date::parse(date, None).map_err(|err| Error::backend("git commit", err))?
				},
				None => gix::date::Time::now_local_or_utc(),
			};
			override_author = gix::actor::Signature {
				name: author.name.clone().into(),
				email: author.email.clone().into(),
				time,
			};
			override_author.to_ref(&mut author_time)
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
		run_commit_hook(self, &repo, "commit-msg", &[message_path.as_os_str()])?;
		let message = fs::read_to_string(&message_path)
			.map_err(|err| Error::backend("git commit read commit-msg result", err))?;
		let commit = repo
			.new_commit_as(committer, author, message, tree, parents)
			.map_err(|err| Error::backend("git commit", err))?;
		let id = commit.id;
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
		let _ = run_commit_hook(self, &repo, "post-commit", &[]);
		Ok(id.to_hex().to_string())
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
		update_reference(
			&repo,
			"git branch",
			&full,
			id,
			constraint,
			&format!("branch: Created from {start}"),
			false,
		)?;
		Ok(())
	}

	/// Delete a local branch, returning false for missing or unsafe deletion.
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
		Ok(repo.edit_reference(edit).is_ok())
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
		let mut index = repo
			.index_or_load_from_head_or_empty()
			.map_err(|e| Error::backend("git restore", e))?
			.into_owned();
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
		let repo = self.gix()?;
		let index = repo
			.index_or_load_from_head_or_empty()
			.map_err(|e| Error::backend("git clean", e))?;
		let tracked: BTreeSet<String> = index
			.entries()
			.iter()
			.map(|e| e.path(&index).to_str_lossy().into_owned())
			.collect();
		let ignores = load_ignore_patterns(self.root());
		let mut paths = Vec::new();
		walk_files(self.root(), self.root(), &mut paths)?;
		for rel in paths {
			if tracked.contains(&rel)
				|| !options.paths.is_empty() && !options.paths.iter().any(|p| path_matches(&rel, p))
			{
				continue;
			}
			let ignored = is_ignored(&rel, &ignores);
			if (options.ignored_only && !ignored)
				|| (!options.ignored_only && !options.include_ignored && ignored)
			{
				continue;
			}
			let path = self.root().join(&rel);
			if path.is_dir() {
				fs::remove_dir_all(path)?;
			} else {
				fs::remove_file(path)?;
			}
		}
		remove_empty_dirs(self.root(), self.root())?;
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
	pub fn worktree_add(&self, path: &Path, ref_name: &str, detach: bool) -> Result<()> {
		let repo = self.gix()?;
		let id = resolve_commit(&repo, ref_name)?;
		if path.exists() && fs::read_dir(path)?.next().is_some() {
			return Err(Error::backend(
				"git worktree add",
				"destination already exists and is not empty",
			));
		}
		fs::create_dir_all(path)?;
		let name = worktree_admin_name(&self.info().common_dir, path);
		let admin = self.info().common_dir.join("worktrees").join(&name);
		fs::create_dir_all(&admin)?;
		fs::write(path.join(".git"), format!("gitdir: {}\n", admin.display()))?;
		fs::write(admin.join("gitdir"), format!("{}\n", path.join(".git").display()))?;
		fs::write(admin.join("commondir"), "../..\n")?;
		let head = if detach {
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
		fs::write(admin.join("HEAD"), format!("{head}\n"))?;
		let linked = Self::require(path)?;
		let linked_repo = linked.gix()?;
		checkout_tree(&linked, &linked_repo, id, true)?;
		Ok(())
	}

	/// Remove a linked worktree, returning false when dirty and not forced.
	pub fn worktree_remove(&self, path: &Path, force: bool) -> Result<bool> {
		let Some(linked) = Self::discover(path)? else {
			return Ok(false);
		};
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
	/// vanished.
	pub fn worktree_prune(&self) -> Result<()> {
		let root = self.info().common_dir.join("worktrees");
		let Ok(entries) = fs::read_dir(&root) else {
			return Ok(());
		};
		for entry in entries {
			let entry = entry?;
			let back = fs::read_to_string(entry.path().join("gitdir")).unwrap_or_default();
			if back.trim().is_empty() || !Path::new(back.trim()).exists() {
				fs::remove_dir_all(entry.path())?;
			}
		}
		Ok(())
	}
}

fn run_commit_hook(
	repository: &GitRepo,
	repo: &gix::Repository,
	name: &str,
	args: &[&OsStr],
) -> Result<()> {
	let hooks_dir = repo
		.config_snapshot()
		.string("core.hooksPath")
		.map(|value| PathBuf::from(value.to_str_lossy().into_owned()))
		.map_or_else(
			|| repository.info().git_dir.join("hooks"),
			|path| {
				if path.is_absolute() {
					path
				} else {
					repository.root().join(path)
				}
			},
		);
	let hook = hooks_dir.join(name);
	if !hook_is_executable(&hook)? {
		return Ok(());
	}
	let output = Command::new(&hook)
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

fn hook_is_executable(path: &Path) -> Result<bool> {
	let metadata = match fs::metadata(path) {
		Ok(metadata) => metadata,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(false),
		Err(err) => return Err(err.into()),
	};
	if !metadata.is_file() {
		return Ok(false);
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		Ok(metadata.permissions().mode() & 0o111 != 0)
	}
	#[cfg(not(unix))]
	{
		Ok(true)
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

fn collect_stage_paths(root: &Path, files: &[String]) -> Result<BTreeSet<String>> {
	let ignores = load_ignore_patterns(root);
	let mut candidates = Vec::new();
	if files.is_empty() {
		walk_files(root, root, &mut candidates)?;
	} else {
		for item in files {
			let path = root.join(item);
			if path.is_dir() {
				walk_files(root, &path, &mut candidates)?;
			} else if path.exists() || fs::symlink_metadata(&path).is_ok() {
				candidates.push(item.replace('\\', "/"));
			}
		}
	}
	Ok(candidates
		.into_iter()
		.filter(|path| !is_ignored(path, &ignores))
		.collect())
}

fn stage_one(
	repo: &gix::Repository,
	root: &Path,
	index: &mut gix::index::File,
	path: &str,
) -> Result<()> {
	let full = root.join(path);
	let metadata = fs::symlink_metadata(&full)?;
	let (data, mode) = if metadata.file_type().is_symlink() {
		(
			fs::read_link(&full)?
				.to_string_lossy()
				.into_owned()
				.into_bytes(),
			gix::index::entry::Mode::SYMLINK,
		)
	} else {
		let mode = if is_executable(&metadata) {
			gix::index::entry::Mode::FILE_EXECUTABLE
		} else {
			gix::index::entry::Mode::FILE
		};
		(fs::read(&full)?, mode)
	};
	let id = repo
		.write_blob(&data)
		.map_err(|e| Error::backend("git add", e))?
		.detach();
	index.remove_entries(|_, p, _| p == path.as_bytes().as_bstr());
	index.dangerously_push_entry(
		Default::default(),
		id,
		gix::index::entry::Flags::empty(),
		mode,
		path.as_bytes().as_bstr(),
	);
	Ok(())
}

#[cfg(unix)]
fn is_executable(meta: &fs::Metadata) -> bool {
	use std::os::unix::fs::PermissionsExt;
	meta.permissions().mode() & 0o111 != 0
}
#[cfg(not(unix))]
fn is_executable(_: &fs::Metadata) -> bool {
	false
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
	let current = repo
		.index_or_load_from_head_or_empty()
		.map_err(|e| Error::backend("git checkout", e))?
		.into_owned();
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
	for entry in current.entries() {
		let path = entry.path(current).to_str_lossy().into_owned();
		let target_entry = target.entry_by_path(path.as_bytes().as_bstr());
		if target_entry.is_some_and(|e| e.id == entry.id && e.mode == entry.mode) {
			continue;
		}
		if worktree_id(repo, &root.join(&path), entry.mode)? != Some(entry.id) {
			conflicts.push(path);
		}
	}
	conflicts.sort();
	conflicts.dedup();
	Ok(conflicts)
}

fn worktree_id(
	repo: &gix::Repository,
	path: &Path,
	mode: gix::index::entry::Mode,
) -> Result<Option<gix::hash::ObjectId>> {
	if !path.exists() && fs::symlink_metadata(path).is_err() {
		return Ok(None);
	}
	let data = if mode == gix::index::entry::Mode::SYMLINK {
		fs::read_link(path)?
			.to_string_lossy()
			.into_owned()
			.into_bytes()
	} else {
		fs::read(path)?
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
	for entry in index.entries() {
		let path = entry.path(index).to_str_lossy();
		if files.is_empty() || files.iter().any(|wanted| path_matches(&path, wanted)) {
			let object = repo
				.find_object(entry.id)
				.map_err(|e| Error::backend("git restore", e))?;
			let blob = object
				.try_into_blob()
				.map_err(|e| Error::backend("git restore", e))?;
			let full = root.join(path.as_ref());
			if let Some(parent) = full.parent() {
				fs::create_dir_all(parent)?;
			}
			fs::write(full, &blob.data)?;
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

fn walk_files(root: &Path, dir: &Path, out: &mut Vec<String>) -> Result<()> {
	for entry in fs::read_dir(dir)? {
		let entry = entry?;
		let path = entry.path();
		if path == root.join(".git") {
			continue;
		}
		let kind = entry.file_type()?;
		if kind.is_dir() {
			walk_files(root, &path, out)?;
		} else {
			out.push(
				path
					.strip_prefix(root)
					.map_err(|e| Error::backend("git walk", e))?
					.to_string_lossy()
					.replace('\\', "/"),
			);
		}
	}
	Ok(())
}

fn load_ignore_patterns(root: &Path) -> Vec<String> {
	let mut out = Vec::new();
	for path in [root.join(".gitignore"), root.join(".git/info/exclude")] {
		if let Ok(text) = fs::read_to_string(path) {
			out.extend(
				text
					.lines()
					.map(str::trim)
					.filter(|l| !l.is_empty() && !l.starts_with('#'))
					.map(str::to_owned),
			);
		}
	}
	out
}

fn is_ignored(path: &str, patterns: &[String]) -> bool {
	let mut ignored = false;
	for raw in patterns {
		let (negate, pattern) = raw
			.strip_prefix('!')
			.map_or((false, raw.as_str()), |p| (true, p));
		let pattern = pattern.trim_start_matches('/').trim_end_matches('/');
		let matches = if pattern.contains('*') {
			wildcard_match(pattern, path) || path.split('/').any(|part| wildcard_match(pattern, part))
		} else {
			path == pattern
				|| path.starts_with(&format!("{pattern}/"))
				|| path.split('/').any(|part| part == pattern)
		};
		if matches {
			ignored = !negate;
		}
	}
	ignored
}

const fn wildcard_match(pattern: &str, text: &str) -> bool {
	let (mut p, mut t, mut star, mut mark) = (0, 0, None, 0);
	let (pb, tb) = (pattern.as_bytes(), text.as_bytes());
	while t < tb.len() {
		if p < pb.len() && (pb[p] == b'?' || pb[p] == tb[t]) {
			p += 1;
			t += 1;
		} else if p < pb.len() && pb[p] == b'*' {
			star = Some(p);
			p += 1;
			mark = t;
		} else if let Some(s) = star {
			p = s + 1;
			mark += 1;
			t = mark;
		} else {
			return false;
		}
	}
	while p < pb.len() && pb[p] == b'*' {
		p += 1;
	}
	p == pb.len()
}

fn remove_empty_dirs(root: &Path, dir: &Path) -> Result<bool> {
	for entry in fs::read_dir(dir)? {
		let path = entry?.path();
		if path.is_dir() && path != root.join(".git") {
			remove_empty_dirs(root, &path)?;
		}
	}
	let empty = dir != root && fs::read_dir(dir)?.next().is_none();
	if empty {
		fs::remove_dir(dir)?;
	}
	Ok(empty)
}

fn set_config_file(path: &Path, key: &str, value: &str) -> Result<()> {
	let mut config = if path.exists() {
		gix::config::File::from_path_no_includes(path.to_owned(), gix::config::Source::Local)
			.map_err(|e| Error::backend("git config", e))?
	} else {
		gix::config::File::default()
	};
	config
		.set_raw_value(key, value)
		.map_err(|e| Error::backend("git config", e))?;
	let mut bytes = Vec::new();
	config.write_to(&mut bytes)?;
	fs::write(path, bytes)?;
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
	let index = gix
		.index_or_load_from_head_or_empty()
		.map_err(|e| Error::backend("git worktree remove", e))?
		.into_owned();
	for entry in index.entries() {
		if worktree_id(
			&gix,
			&repo.root().join(entry.path(&index).to_str_lossy().as_ref()),
			entry.mode,
		)? != Some(entry.id)
		{
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
		fs::write(temp.path().join("a"), "one\n").unwrap();
		fs::write(temp.path().join("b"), "two\n").unwrap();
		git(temp.path(), &["add", "."]);
		git(temp.path(), &["commit", "-qm", "base"]);
		let repo = GitRepo::require(temp.path()).unwrap();
		(temp, repo)
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
	fn write_hook(path: &Path, body: &str, executable: bool) {
		use std::os::unix::fs::PermissionsExt;
		fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
		let mode = if executable { 0o755 } else { 0o644 };
		fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
	}

	#[cfg(unix)]
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

		fs::write(temp.path().join("b"), "one more\n").unwrap();
		repo.stage_files(&["b".into()]).unwrap();
		write_hook(&pre_commit, "echo should-not-run >&2\nexit 1", false);
		repo
			.commit_create("non-executable hook is skipped", &CommitOptions::default())
			.unwrap();
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

	#[cfg(unix)]
	#[test]
	fn detach_git_dir_does_not_mutate_when_index_snapshot_fails() {
		use std::os::unix::fs::PermissionsExt;

		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-unreadable-index");
		let _ = fs::remove_dir_all(&linked);
		repo.worktree_add(&linked, "main", true).unwrap();
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
	fn mutate_worktree_and_detach() {
		let (temp, repo) = fixture();
		let linked = temp.path().join("../linked-mut");
		let _ = fs::remove_dir_all(&linked);
		repo.worktree_add(&linked, "main", true).unwrap();
		assert!(
			git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(linked.to_string_lossy().as_ref())
		);
		assert!(repo.worktree_remove(&linked, true).unwrap());

		let linked = temp.path().join("../linked-detach");
		let _ = fs::remove_dir_all(&linked);
		repo.worktree_add(&linked, "main", true).unwrap();
		let common = fs::canonicalize(repo.info().common_dir.clone()).unwrap();
		let source_head = git(temp.path(), &["rev-parse", "HEAD"]);
		assert_eq!(detach_git_dir(&linked, &common).unwrap(), DetachGitDirResult::Detached);
		let alternates = fs::read_to_string(linked.join(".git/objects/info/alternates")).unwrap();
		assert!(alternates.contains(common.join("objects").to_string_lossy().as_ref()));
		assert_eq!(git(&linked, &["rev-parse", "HEAD"]), git(temp.path(), &["rev-parse", "HEAD"]));
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), source_head);
		assert!(
			!git(temp.path(), &["worktree", "list", "--porcelain"])
				.contains(linked.to_string_lossy().as_ref())
		);
		assert!(repo.worktree_prune().is_ok());
		let _ = fs::remove_dir_all(linked);
	}
}
