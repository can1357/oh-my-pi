//! jj-lib-backed operations on [`JjWorkspace`](super::JjWorkspace):
//! working-copy label, status summary, and git-format diffs.

use std::{
	collections::{BTreeMap, BTreeSet, BinaryHeap},
	future::Future,
	path::PathBuf,
	pin::Pin,
	sync::Arc,
};

use jj_lib::{
	backend::{CommitId, CopyId, TreeValue},
	commit::Commit,
	config::{ConfigSource, StackedConfig},
	conflicts::{ConflictMarkerStyle, ConflictMaterializeOptions, materialize_tree_value},
	default_backend_factories::{default_backend_factories, default_working_copy_factories},
	diff_presentation::{
		LineCompareMode,
		unified::{DiffLineType, GitDiffPart, git_diff_part, unified_diff_hunks},
	},
	gitignore::GitIgnoreFile,
	matchers::{EverythingMatcher, NothingMatcher},
	merge::{Diff, MergedTreeValue},
	merged_tree::MergedTree,
	object_id::{HexPrefix, ObjectId as _, PrefixResolution},
	repo::{ReadonlyRepo, Repo},
	repo_path::{RepoPath, RepoPathBuf},
	settings::UserSettings,
	working_copy::{SnapshotOptions, WorkingCopyFreshness},
	workspace::Workspace,
};

use super::JjWorkspace;
use crate::{
	error::{Error, Result},
	types::{CommitAuthor, CommitDetails, NumstatEntry, StatusOptions, StatusSummary},
};

const DIFF_CONTEXT: usize = 3;

#[derive(Debug)]
struct TreeChange {
	before_path:    RepoPathBuf,
	after_path:     RepoPathBuf,
	before:         MergedTreeValue,
	after:          MergedTreeValue,
	copy_operation: Option<&'static str>,
}

impl JjWorkspace {
	/// Return the nearest local bookmark, or the shortest unique working-copy
	/// change ID.
	pub fn working_copy_label(&self) -> Result<Option<String>> {
		self.with_current_repo("jj log", |workspace, repo| {
			Box::pin(async move {
				let Some(wc_id) = repo
					.view()
					.get_wc_commit_id(workspace.workspace_name())
					.cloned()
				else {
					return Ok(None);
				};
				let wc_commit = repo
					.store()
					.get_commit_async(&wc_id)
					.await
					.map_err(|err| Error::backend("jj log", err))?;

				let wc_bookmarks = local_bookmarks_for_commit(repo.as_ref(), &wc_id);
				if !wc_bookmarks.is_empty() {
					return Ok(Some(wc_bookmarks.join(" ")));
				}

				let mut candidates = BTreeSet::new();
				for (_, target) in repo.view().local_bookmarks() {
					for id in target.added_ids() {
						if repo
							.index()
							.is_ancestor(id, &wc_id)
							.await
							.map_err(|err| Error::backend("jj log", err))?
						{
							candidates.insert(id.clone());
						}
					}
				}
				let mut candidate_iter = candidates.iter();
				let heads = repo
					.index()
					.heads(&mut candidate_iter)
					.await
					.map_err(|err| Error::backend("jj log", err))?;
				let bookmark_group = heads
					.iter()
					.map(|id| local_bookmarks_for_commit(repo.as_ref(), id).join(" "))
					.find(|names| !names.is_empty());
				if let Some(names) = bookmark_group {
					return Ok(Some(names));
				}

				let prefix_len = repo
					.shortest_unique_change_id_prefix_len(wc_commit.change_id())
					.map_err(|err| Error::backend("jj log", err))?
					.max(8);
				let change_id = wc_commit.change_id().reverse_hex();
				Ok(Some(change_id[..prefix_len.min(change_id.len())].to_owned()))
			})
		})
	}

	/// Return the working-copy commit id, or `None` when the workspace has no
	/// working-copy commit.
	pub fn head_id(&self) -> Result<Option<String>> {
		self.with_current_repo("jj log", |workspace, repo| {
			Box::pin(async move {
				Ok(repo
					.view()
					.get_wc_commit_id(workspace.workspace_name())
					.map(|id| id.hex()))
			})
		})
	}

	/// Count the recorded changes in `@` relative to its merged parent tree.
	pub fn status_summary(&self) -> Result<StatusSummary> {
		self.with_current_repo("jj status", |workspace, repo| {
			Box::pin(async move {
				let Some((before, after)) =
					working_copy_trees(workspace, repo.as_ref(), "jj status").await?
				else {
					return Ok(StatusSummary::default());
				};
				let changes = collect_changes(&before, &after, &[], "jj status")?;
				let mut summary = StatusSummary::default();
				for change in changes {
					if change.before.is_absent() {
						summary.untracked = summary.untracked.saturating_add(1);
					} else {
						summary.unstaged = summary.unstaged.saturating_add(1);
					}
				}
				Ok(summary)
			})
		})
	}

	/// Render `@` versus its merged parents in git porcelain-v1 form.
	pub fn status_porcelain(&self, options: &StatusOptions) -> Result<String> {
		let pathspecs = options.pathspecs.clone();
		let nul_terminated = options.nul_terminated;
		self.with_current_repo("jj status", move |workspace, repo| {
			Box::pin(async move {
				let Some((before, after)) =
					working_copy_trees(workspace, repo.as_ref(), "jj status").await?
				else {
					return Ok(String::new());
				};
				let changes = collect_changes(&before, &after, &pathspecs, "jj status")?;
				Ok(render_status_porcelain(&changes, nul_terminated))
			})
		})
	}

	/// Render `@` versus its merged parents as a git-format patch.
	pub fn diff_text(&self, files: &[String], snapshot: bool) -> Result<String> {
		let files = files.to_vec();
		self.with_repo(snapshot, "jj diff", move |workspace, repo| {
			Box::pin(async move {
				let Some((before, after)) =
					working_copy_trees(workspace, repo.as_ref(), "jj diff").await?
				else {
					return Ok(String::new());
				};
				let changes = collect_changes(&before, &after, &files, "jj diff")?;
				render_git_diff(repo.as_ref(), &before, &after, changes).await
			})
		})
	}

	/// List target paths changed in `@` relative to its merged parents.
	pub fn changed_files(&self, files: &[String], snapshot: bool) -> Result<Vec<String>> {
		let files = files.to_vec();
		self.with_repo(snapshot, "jj diff", move |workspace, repo| {
			Box::pin(async move {
				let Some((before, after)) =
					working_copy_trees(workspace, repo.as_ref(), "jj diff").await?
				else {
					return Ok(Vec::new());
				};
				Ok(collect_changes(&before, &after, &files, "jj diff")?
					.into_iter()
					.map(|change| change.after_path.as_internal_file_string().to_owned())
					.collect())
			})
		})
	}

	/// Return per-file line counts for `@` relative to its merged parents.
	pub fn numstat(&self, files: &[String]) -> Result<Vec<NumstatEntry>> {
		let files = files.to_vec();
		self.with_repo(true, "jj diff", move |workspace, repo| {
			Box::pin(async move {
				let Some((before, after)) =
					working_copy_trees(workspace, repo.as_ref(), "jj diff").await?
				else {
					return Ok(Vec::new());
				};
				let changes = collect_changes(&before, &after, &files, "jj diff")?;
				render_numstat(repo.as_ref(), &before, &after, changes).await
			})
		})
	}

	/// Return recent commit subjects, newest first.
	pub fn log_subjects(&self, count: usize) -> Result<Vec<String>> {
		self.with_current_repo("jj log", |workspace, repo| {
			Box::pin(async move {
				Ok(walk_commits(workspace, repo.as_ref(), count, "jj log")
					.await?
					.into_iter()
					.map(|commit| commit_subject(&commit))
					.collect())
			})
		})
	}

	/// Return recent commits as `<change-id> <subject>` lines.
	pub fn log_onelines(&self, count: usize) -> Result<Vec<String>> {
		self.with_current_repo("jj log", |workspace, repo| {
			Box::pin(async move {
				let commits = walk_commits(workspace, repo.as_ref(), count, "jj log").await?;
				let mut lines = Vec::with_capacity(commits.len());
				for commit in commits {
					let prefix_len = repo
						.shortest_unique_change_id_prefix_len(commit.change_id())
						.map_err(|err| Error::backend("jj log", err))?
						.max(8);
					let change_id = commit.change_id().reverse_hex();
					let prefix = &change_id[..prefix_len.min(change_id.len())];
					lines.push(format!("{prefix} {}", commit_subject(&commit)));
				}
				Ok(lines)
			})
		})
	}

	/// Read commit identity, parents, author, date, and full message.
	pub fn commit_details(&self, rev: &str) -> Result<CommitDetails> {
		let rev = rev.to_owned();
		self.with_current_repo("jj show", move |workspace, repo| {
			Box::pin(async move {
				let commit_id = resolve_commit_id(workspace, repo.as_ref(), &rev)?
					.ok_or_else(|| Error::ObjectNotFound { spec: rev.clone() })?;
				let commit = repo
					.store()
					.get_commit_async(&commit_id)
					.await
					.map_err(|err| Error::backend("jj show", err))?;
				let root_id = repo.store().root_commit_id();
				let author = commit.author();
				let date = author
					.timestamp
					.to_datetime()
					.map_err(|err| Error::backend("jj show", err))?
					.to_rfc3339();
				let raw_message = commit.description();
				let message = raw_message
					.strip_suffix('\n')
					.unwrap_or(raw_message)
					.to_owned();
				Ok(CommitDetails {
					sha: commit.id().hex(),
					parents: commit
						.parent_ids()
						.iter()
						.filter(|id| *id != root_id)
						.map(|id| id.hex())
						.collect(),
					author: CommitAuthor {
						name:  author.name.clone(),
						email: author.email.clone(),
						date:  Some(date),
					},
					message,
				})
			})
		})
	}

	/// List paths tracked in `@`.
	///
	/// When `others` is true, the result is empty because jj snapshots every
	/// non-ignored path into `@`, so it has no distinct untracked set.
	pub fn ls_files(&self, others: bool) -> Result<Vec<String>> {
		if others {
			return Ok(Vec::new());
		}
		self.with_current_repo("jj files", |workspace, repo| {
			Box::pin(async move {
				let Some(wc_id) = repo.view().get_wc_commit_id(workspace.workspace_name()) else {
					return Ok(Vec::new());
				};
				let commit = repo
					.store()
					.get_commit_async(wc_id)
					.await
					.map_err(|err| Error::backend("jj files", err))?;
				Ok(tree_entries(&commit.tree(), "jj files")?
					.into_keys()
					.map(|path| path.as_internal_file_string().to_owned())
					.collect())
			})
		})
	}

	fn with_current_repo<T, F>(&self, context: &'static str, operation: F) -> Result<T>
	where
		F: for<'a> FnOnce(
			&'a Workspace,
			Arc<ReadonlyRepo>,
		) -> Pin<Box<dyn Future<Output = Result<T>> + 'a>>,
	{
		self.with_repo(false, context, operation)
	}

	fn with_repo<T, F>(&self, snapshot: bool, context: &'static str, operation: F) -> Result<T>
	where
		F: for<'a> FnOnce(
			&'a Workspace,
			Arc<ReadonlyRepo>,
		) -> Pin<Box<dyn Future<Output = Result<T>> + 'a>>,
	{
		let settings = user_settings().map_err(|err| Error::backend(context, err))?;
		let store_factories = default_backend_factories();
		let working_copy_factories = default_working_copy_factories();
		let mut workspace =
			Workspace::load(&settings, &self.root, &store_factories, &working_copy_factories)
				.map_err(|err| Error::backend(context, err))?;
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.map_err(|err| Error::backend(context, err))?;
		runtime.block_on(async move {
			let mut repo = workspace
				.repo_loader()
				.load_at_head()
				.await
				.map_err(|err| Error::backend(context, err))?;
			if snapshot {
				repo = snapshot_working_copy(&mut workspace, repo).await?;
			}
			operation(&workspace, repo).await
		})
	}
}
#[allow(
	clippy::future_not_send,
	reason = "driven on a per-call current-thread runtime; `&dyn Repo` is !Send"
)]
async fn walk_commits(
	workspace: &Workspace,
	repo: &dyn Repo,
	count: usize,
	context: &'static str,
) -> Result<Vec<Commit>> {
	if count == 0 {
		return Ok(Vec::new());
	}
	let Some(wc_id) = repo
		.view()
		.get_wc_commit_id(workspace.workspace_name())
		.cloned()
	else {
		return Ok(Vec::new());
	};
	let root_id = repo.store().root_commit_id();
	if &wc_id == root_id {
		return Ok(Vec::new());
	}
	let wc_commit = repo
		.store()
		.get_commit_async(&wc_id)
		.await
		.map_err(|err| Error::backend(context, err))?;
	let mut queued = BTreeSet::from([wc_id]);
	let mut heap = BinaryHeap::from([(wc_commit.committer().timestamp, wc_commit)]);
	let mut commits = Vec::with_capacity(count);
	while let Some((_, commit)) = heap.pop() {
		for parent in commit
			.parents()
			.await
			.map_err(|err| Error::backend(context, err))?
		{
			if parent.id() != root_id && queued.insert(parent.id().clone()) {
				heap.push((parent.committer().timestamp, parent));
			}
		}
		commits.push(commit);
		if commits.len() == count {
			break;
		}
	}
	Ok(commits)
}

fn commit_subject(commit: &Commit) -> String {
	commit
		.description()
		.lines()
		.next()
		.unwrap_or_default()
		.to_owned()
}

fn resolve_commit_id(
	workspace: &Workspace,
	repo: &dyn Repo,
	rev: &str,
) -> Result<Option<CommitId>> {
	if rev == "@" {
		return Ok(repo
			.view()
			.get_wc_commit_id(workspace.workspace_name())
			.cloned());
	}
	if let Some(prefix) = HexPrefix::try_from_reverse_hex(rev) {
		let resolution = repo
			.resolve_change_id_prefix(&prefix)
			.map_err(|err| Error::backend("jj show", err))?;
		if let PrefixResolution::SingleMatch(targets) = resolution {
			let mut visible = targets.visible_with_offsets().map(|(_, id)| id.clone());
			let first = visible.next();
			if first.is_some() && visible.next().is_none() {
				return Ok(first);
			}
		}
	}
	if let Some(prefix) = HexPrefix::try_from_hex(rev) {
		let resolution = repo
			.index()
			.resolve_commit_id_prefix(&prefix)
			.map_err(|err| Error::backend("jj show", err))?;
		if let PrefixResolution::SingleMatch(id) = resolution {
			return Ok(Some(id));
		}
	}
	Ok(None)
}

fn user_settings() -> std::result::Result<UserSettings, jj_lib::config::ConfigGetError> {
	let mut config = StackedConfig::with_defaults();
	for path in user_config_paths() {
		if path.is_dir() {
			let _ = config.load_dir(ConfigSource::User, &path);
		} else if path.is_file() {
			let _ = config.load_file(ConfigSource::User, &path);
		}
	}
	UserSettings::from_config(config)
}

fn user_config_paths() -> Vec<PathBuf> {
	if let Some(path) = std::env::var_os("JJ_CONFIG") {
		return vec![PathBuf::from(path)];
	}
	let mut paths = Vec::new();
	if let Some(config_home) = std::env::var_os("XDG_CONFIG_HOME")
		.map(PathBuf::from)
		.or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config")))
	{
		paths.push(config_home.join("jj").join("config.toml"));
		paths.push(config_home.join("jj").join("conf.d"));
	}
	if let Some(home) = std::env::var_os("HOME") {
		paths.push(PathBuf::from(home).join(".jjconfig.toml"));
	}
	paths
}

#[allow(
	clippy::future_not_send,
	reason = "driven on a per-call current-thread runtime; jj-lib's LockedWorkingCopy is !Sync"
)]
async fn snapshot_working_copy(
	workspace: &mut Workspace,
	repo: Arc<ReadonlyRepo>,
) -> Result<Arc<ReadonlyRepo>> {
	let workspace_name = workspace.workspace_name().to_owned();
	let Some(initial_wc_id) = repo.view().get_wc_commit_id(&workspace_name).cloned() else {
		return Ok(repo);
	};
	let initial_wc_commit = repo
		.store()
		.get_commit_async(&initial_wc_id)
		.await
		.map_err(|err| Error::backend("jj snapshot", err))?;
	let mut locked_workspace = workspace
		.start_working_copy_mutation()
		.await
		.map_err(|err| Error::backend("jj snapshot", err))?;
	let (repo, wc_commit) = match WorkingCopyFreshness::check_stale(
		locked_workspace.locked_wc(),
		&initial_wc_commit,
		&repo,
	)
	.await
	.map_err(|err| Error::backend("jj snapshot", err))?
	{
		WorkingCopyFreshness::Fresh => (repo, initial_wc_commit),
		WorkingCopyFreshness::Updated(operation) => {
			let repo = repo
				.loader()
				.load_at(&operation)
				.await
				.map_err(|err| Error::backend("jj snapshot", err))?;
			let Some(wc_id) = repo.view().get_wc_commit_id(&workspace_name) else {
				return Ok(repo);
			};
			let wc_commit = repo
				.store()
				.get_commit_async(wc_id)
				.await
				.map_err(|err| Error::backend("jj snapshot", err))?;
			(repo, wc_commit)
		},
		WorkingCopyFreshness::WorkingCopyStale => {
			return Err(Error::backend(
				"jj snapshot",
				"working copy is stale; run `jj workspace update-stale`",
			));
		},
		WorkingCopyFreshness::SiblingOperation => {
			return Err(Error::backend(
				"jj snapshot",
				"working copy operation is a sibling of the current repository operation",
			));
		},
	};
	let everything = EverythingMatcher;
	let nothing = NothingMatcher;
	let options = SnapshotOptions {
		base_ignores:           GitIgnoreFile::empty(),
		progress:               None,
		start_tracking_matcher: &everything,
		force_tracking_matcher: &nothing,
		max_new_file_size:      1024 * 1024,
	};
	let (new_tree, _) = locked_workspace
		.locked_wc()
		.snapshot(&options)
		.await
		.map_err(|err| Error::backend("jj snapshot", err))?;
	let repo = if new_tree.tree_ids_and_labels() == wc_commit.tree().tree_ids_and_labels() {
		repo
	} else {
		let mut transaction = repo.start_transaction();
		transaction.set_workspace_name(&workspace_name);
		transaction.set_is_snapshot(true);
		let new_commit = transaction
			.repo_mut()
			.rewrite_commit(&wc_commit)
			.set_tree(new_tree)
			.write()
			.await
			.map_err(|err| Error::backend("jj snapshot", err))?;
		transaction
			.repo_mut()
			.set_wc_commit(workspace_name, new_commit.id().clone())
			.map_err(|err| Error::backend("jj snapshot", err))?;
		transaction
			.repo_mut()
			.rebase_descendants()
			.await
			.map_err(|err| Error::backend("jj snapshot", err))?;
		transaction
			.commit("snapshot working copy")
			.await
			.map_err(|err| Error::backend("jj snapshot", err))?
	};
	locked_workspace
		.finish(repo.op_id().clone())
		.await
		.map_err(|err| Error::backend("jj snapshot", err))?;
	Ok(repo)
}

#[allow(
	clippy::future_not_send,
	reason = "driven on a per-call current-thread runtime; `&dyn Repo` is !Send"
)]
async fn working_copy_trees(
	workspace: &Workspace,
	repo: &dyn Repo,
	context: &'static str,
) -> Result<Option<(MergedTree, MergedTree)>> {
	let Some(wc_id) = repo.view().get_wc_commit_id(workspace.workspace_name()) else {
		return Ok(None);
	};
	let commit = repo
		.store()
		.get_commit_async(wc_id)
		.await
		.map_err(|err| Error::backend(context, err))?;
	let parent_tree = commit
		.parent_tree(repo)
		.await
		.map_err(|err| Error::backend(context, err))?;
	Ok(Some((parent_tree, commit.tree())))
}

fn tree_entries(
	tree: &MergedTree,
	context: &'static str,
) -> Result<BTreeMap<RepoPathBuf, MergedTreeValue>> {
	tree
		.entries()
		.map(|(path, value)| {
			value
				.map(|value| (path, value))
				.map_err(|err| Error::backend(context, err))
		})
		.collect()
}

fn collect_changes(
	before_tree: &MergedTree,
	after_tree: &MergedTree,
	files: &[String],
	context: &'static str,
) -> Result<Vec<TreeChange>> {
	let before = tree_entries(before_tree, context)?;
	let after = tree_entries(after_tree, context)?;
	let mut changes = Vec::new();
	let mut removed: BTreeSet<RepoPathBuf> = before
		.keys()
		.filter(|path| !after.contains_key(*path))
		.cloned()
		.collect();

	for (path, after_value) in &after {
		if let Some(before_value) = before.get(path) {
			if before_value != after_value && path_selected(path, path, files) {
				changes.push(TreeChange {
					before_path:    path.clone(),
					after_path:     path.clone(),
					before:         before_value.clone(),
					after:          after_value.clone(),
					copy_operation: None,
				});
			}
			continue;
		}

		let source = non_placeholder_copy_id(after_value).and_then(|copy_id| {
			before.iter().find_map(|(source_path, source_value)| {
				(non_placeholder_copy_id(source_value) == Some(copy_id)).then_some(source_path)
			})
		});
		if let Some(source_path) = source {
			let operation = if removed.remove(source_path) {
				"rename"
			} else {
				"copy"
			};
			if path_selected(source_path, path, files) {
				changes.push(TreeChange {
					before_path:    source_path.clone(),
					after_path:     path.clone(),
					before:         before[source_path].clone(),
					after:          after_value.clone(),
					copy_operation: Some(operation),
				});
			}
		} else if path_selected(path, path, files) {
			changes.push(TreeChange {
				before_path:    path.clone(),
				after_path:     path.clone(),
				before:         MergedTreeValue::absent(),
				after:          after_value.clone(),
				copy_operation: None,
			});
		}
	}

	for path in removed {
		if path_selected(&path, &path, files) {
			changes.push(TreeChange {
				before_path:    path.clone(),
				after_path:     path.clone(),
				before:         before[&path].clone(),
				after:          MergedTreeValue::absent(),
				copy_operation: None,
			});
		}
	}
	changes.sort_by(|left, right| left.after_path.cmp(&right.after_path));
	Ok(changes)
}
fn render_status_porcelain(changes: &[TreeChange], nul_terminated: bool) -> String {
	let mut output = String::new();
	for change in changes {
		output.push_str(status_code(change));
		output.push(' ');
		let before_path = change.before_path.as_internal_file_string();
		let after_path = change.after_path.as_internal_file_string();
		if nul_terminated {
			output.push_str(after_path);
			output.push('\0');
			if change.copy_operation.is_some() {
				output.push_str(before_path);
				output.push('\0');
			}
		} else {
			if change.copy_operation.is_some() {
				output.push_str(before_path);
				output.push_str(" -> ");
			}
			output.push_str(after_path);
			output.push('\n');
		}
	}
	output
}

fn status_code(change: &TreeChange) -> &'static str {
	if change.after.as_resolved().is_none() {
		return "UU";
	}
	match change.copy_operation {
		Some("rename") => "R ",
		Some("copy") => "C ",
		_ if change.before.is_absent() => "A ",
		_ if change.after.is_absent() => "D ",
		_ => "M ",
	}
}

fn non_placeholder_copy_id(value: &MergedTreeValue) -> Option<&CopyId> {
	match value.as_resolved()? {
		Some(TreeValue::File { copy_id, .. }) if !copy_id.as_bytes().is_empty() => Some(copy_id),
		_ => None,
	}
}

fn path_selected(before: &RepoPath, after: &RepoPath, files: &[String]) -> bool {
	files.is_empty()
		|| files.iter().any(|file| {
			let file = file.trim_matches('/');
			matches_path(before.as_internal_file_string(), file)
				|| matches_path(after.as_internal_file_string(), file)
		})
}

fn matches_path(path: &str, prefix: &str) -> bool {
	prefix.is_empty()
		|| path == prefix
		|| path
			.strip_prefix(prefix)
			.is_some_and(|tail| tail.starts_with('/'))
}
#[allow(
	clippy::future_not_send,
	reason = "driven on a per-call current-thread runtime; `&dyn Repo` is !Send"
)]
async fn render_numstat(
	repo: &dyn Repo,
	before_tree: &MergedTree,
	after_tree: &MergedTree,
	changes: Vec<TreeChange>,
) -> Result<Vec<NumstatEntry>> {
	let options = conflict_materialize_options(repo);
	let mut entries = Vec::with_capacity(changes.len());
	for change in changes {
		let (before_part, after_part) =
			materialize_diff_parts(repo, before_tree, after_tree, &change, &options).await?;
		let (added, removed) = if before_part.content.is_binary || after_part.content.is_binary {
			(None, None)
		} else {
			let mut added = 0u32;
			let mut removed = 0u32;
			for hunk in unified_diff_hunks(
				Diff::new(before_part.content.contents.as_ref(), after_part.content.contents.as_ref()),
				0,
				LineCompareMode::Exact,
			) {
				for (line_type, _) in hunk.lines {
					match line_type {
						DiffLineType::Context => {},
						DiffLineType::Removed => removed = removed.saturating_add(1),
						DiffLineType::Added => added = added.saturating_add(1),
					}
				}
			}
			(Some(added), Some(removed))
		};
		entries.push(NumstatEntry {
			path: change.after_path.as_internal_file_string().to_owned(),
			added,
			removed,
		});
	}
	Ok(entries)
}

fn conflict_materialize_options(repo: &dyn Repo) -> ConflictMaterializeOptions {
	ConflictMaterializeOptions {
		marker_style: ConflictMarkerStyle::Diff,
		marker_len:   None,
		merge:        repo.store().merge_options().clone(),
	}
}

#[allow(
	clippy::future_not_send,
	reason = "driven on a per-call current-thread runtime; `&dyn Repo` is !Send"
)]
async fn materialize_diff_parts(
	repo: &dyn Repo,
	before_tree: &MergedTree,
	after_tree: &MergedTree,
	change: &TreeChange,
	options: &ConflictMaterializeOptions,
) -> Result<(GitDiffPart, GitDiffPart)> {
	let before_value = materialize_tree_value(
		repo.store(),
		&change.before_path,
		change.before.clone(),
		before_tree.labels(),
	)
	.await
	.map_err(|err| Error::backend("jj diff", err))?;
	let after_value = materialize_tree_value(
		repo.store(),
		&change.after_path,
		change.after.clone(),
		after_tree.labels(),
	)
	.await
	.map_err(|err| Error::backend("jj diff", err))?;
	let before_part = git_diff_part(&change.before_path, before_value, options)
		.await
		.map_err(|err| Error::backend("jj diff", err))?;
	let after_part = git_diff_part(&change.after_path, after_value, options)
		.await
		.map_err(|err| Error::backend("jj diff", err))?;
	Ok((before_part, after_part))
}

#[allow(
	clippy::future_not_send,
	reason = "driven on a per-call current-thread runtime; `&dyn Repo` is !Send"
)]
async fn render_git_diff(
	repo: &dyn Repo,
	before_tree: &MergedTree,
	after_tree: &MergedTree,
	changes: Vec<TreeChange>,
) -> Result<String> {
	let materialize_options = conflict_materialize_options(repo);
	let mut output = Vec::new();
	for change in changes {
		let (before_part, after_part) =
			materialize_diff_parts(repo, before_tree, after_tree, &change, &materialize_options)
				.await?;
		let before_path = change.before_path.as_internal_file_string();
		let after_path = change.after_path.as_internal_file_string();
		output.extend_from_slice(format!("diff --git a/{before_path} b/{after_path}\n").as_bytes());
		match (before_part.mode, after_part.mode) {
			(None, Some(after_mode)) => {
				output.extend_from_slice(format!("new file mode {after_mode}\n").as_bytes());
				output.extend_from_slice(
					format!("index {}..{}\n", before_part.hash, after_part.hash).as_bytes(),
				);
			},
			(Some(before_mode), None) => {
				output.extend_from_slice(format!("deleted file mode {before_mode}\n").as_bytes());
				output.extend_from_slice(
					format!("index {}..{}\n", before_part.hash, after_part.hash).as_bytes(),
				);
			},
			(Some(before_mode), Some(after_mode)) => {
				if let Some(operation) = change.copy_operation {
					output.extend_from_slice(format!("{operation} from {before_path}\n").as_bytes());
					output.extend_from_slice(format!("{operation} to {after_path}\n").as_bytes());
				}
				if before_mode != after_mode {
					output.extend_from_slice(format!("old mode {before_mode}\n").as_bytes());
					output.extend_from_slice(format!("new mode {after_mode}\n").as_bytes());
					if before_part.hash != after_part.hash {
						output.extend_from_slice(
							format!("index {}..{}\n", before_part.hash, after_part.hash).as_bytes(),
						);
					}
				} else if before_part.hash != after_part.hash {
					output.extend_from_slice(
						format!("index {}..{} {before_mode}\n", before_part.hash, after_part.hash)
							.as_bytes(),
					);
				}
			},
			(None, None) => continue,
		}
		if before_part.content.contents == after_part.content.contents {
			continue;
		}
		let before_header = if before_part.mode.is_some() {
			format!("a/{before_path}")
		} else {
			"/dev/null".to_owned()
		};
		let after_header = if after_part.mode.is_some() {
			format!("b/{after_path}")
		} else {
			"/dev/null".to_owned()
		};
		if before_part.content.is_binary || after_part.content.is_binary {
			output.extend_from_slice(
				format!("Binary files {before_header} and {after_header} differ\n").as_bytes(),
			);
			continue;
		}
		output.extend_from_slice(format!("--- {before_header}\n+++ {after_header}\n").as_bytes());
		for hunk in unified_diff_hunks(
			Diff::new(before_part.content.contents.as_ref(), after_part.content.contents.as_ref()),
			DIFF_CONTEXT,
			LineCompareMode::Exact,
		) {
			let before_start = line_number(&hunk.left_line_range);
			let after_start = line_number(&hunk.right_line_range);
			output.extend_from_slice(
				format!(
					"@@ -{},{} +{},{} @@\n",
					before_start,
					hunk.left_line_range.len(),
					after_start,
					hunk.right_line_range.len()
				)
				.as_bytes(),
			);
			for (line_type, tokens) in hunk.lines {
				output.push(match line_type {
					DiffLineType::Context => b' ',
					DiffLineType::Removed => b'-',
					DiffLineType::Added => b'+',
				});
				for (_, content) in &tokens {
					output.extend_from_slice(content);
				}
				if tokens
					.last()
					.is_some_and(|(_, content)| !content.ends_with(b"\n"))
				{
					output.extend_from_slice(b"\n\\ No newline at end of file\n");
				}
			}
		}
	}
	Ok(String::from_utf8_lossy(&output).into_owned())
}

fn line_number(range: &std::ops::Range<usize>) -> usize {
	if range.is_empty() {
		range.start
	} else {
		range.start + 1
	}
}

fn local_bookmarks_for_commit(repo: &dyn Repo, commit_id: &CommitId) -> Vec<String> {
	repo
		.view()
		.local_bookmarks_for_commit(commit_id)
		.map(|(name, _)| name.as_str().to_owned())
		.collect()
}

#[cfg(test)]
mod tests {
	use std::{collections::BTreeMap, fs, path::Path, process::Command};

	use super::*;

	fn init_internal_jj(root: &Path) {
		let settings = user_settings().unwrap();
		let runtime = tokio::runtime::Builder::new_current_thread()
			.enable_all()
			.build()
			.unwrap();
		runtime
			.block_on(Workspace::init_internal_git(&settings, root, gix::hash::Kind::Sha1))
			.unwrap();
	}

	fn jj_available() -> bool {
		Command::new("jj").arg("--version").output().is_ok()
	}

	fn run_jj(root: &Path, args: &[&str]) -> String {
		let output = Command::new("jj")
			.current_dir(root)
			.env("JJ_USER", "VCS Test")
			.env("JJ_EMAIL", "vcs@example.com")
			.args(args)
			.output()
			.unwrap();
		assert!(output.status.success(), "jj {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout).unwrap()
	}

	fn parse_label(raw: &str) -> Option<String> {
		let mut change_id = None;
		for line in raw.lines() {
			let (change, bookmarks) = line.split_once('|').unwrap_or((line, ""));
			if change_id.is_none() && !change.trim().is_empty() {
				change_id = Some(change.trim().to_owned());
			}
			if !bookmarks.trim().is_empty() {
				return Some(bookmarks.split_whitespace().collect::<Vec<_>>().join(" "));
			}
		}
		change_id
	}

	fn parse_summary(raw: &str) -> StatusSummary {
		let mut summary = StatusSummary::default();
		for line in raw.lines() {
			match line.trim().as_bytes().first() {
				Some(b'A') => summary.untracked += 1,
				Some(_) => summary.unstaged += 1,
				None => {},
			}
		}
		summary
	}

	fn patch_files(raw: &str) -> BTreeSet<String> {
		raw.lines()
			.filter_map(|line| line.strip_prefix("diff --git a/"))
			.filter_map(|line| line.split_once(" b/").map(|(_, path)| path.to_owned()))
			.collect()
	}

	fn parse_status_nul(raw: &str) -> Vec<(String, Vec<String>)> {
		let mut entries = Vec::new();
		let mut index = 0;
		while index + 3 <= raw.len() {
			let token = raw[index..index + 3].to_owned();
			index += 3;
			let Some(path_end) = raw[index..].find('\0').map(|offset| index + offset) else {
				break;
			};
			let mut paths = vec![raw[index..path_end].to_owned()];
			index = path_end + 1;
			if token.starts_with('R') || token.starts_with('C') {
				let Some(path_end) = raw[index..].find('\0').map(|offset| index + offset) else {
					break;
				};
				paths.push(raw[index..path_end].to_owned());
				index = path_end + 1;
			}
			entries.push((token, paths));
		}
		entries
	}

	fn patch_numstat(raw: &str) -> BTreeMap<String, (u32, u32)> {
		let mut counts = BTreeMap::new();
		let mut current = None;
		for line in raw.lines() {
			if let Some(header) = line.strip_prefix("diff --git a/") {
				current = header.split_once(" b/").map(|(_, path)| path.to_owned());
				if let Some(path) = &current {
					counts.insert(path.clone(), (0, 0));
				}
				continue;
			}
			let Some(path) = &current else {
				continue;
			};
			let count = counts.get_mut(path).unwrap();
			if line.starts_with('+') && !line.starts_with("+++") {
				count.0 += 1;
			} else if line.starts_with('-') && !line.starts_with("---") {
				count.1 += 1;
			}
		}
		counts
	}

	#[test]
	fn portable_jj_reads_work_without_the_jj_cli() {
		let temp = tempfile::tempdir().unwrap();
		init_internal_jj(temp.path());
		fs::write(temp.path().join("alpha.txt"), "one\ntwo\n").unwrap();
		let repo = crate::detect(temp.path()).unwrap().unwrap();
		assert_eq!(repo.kind(), crate::VcsKind::Jj);
		assert_eq!(repo.primary_root(), temp.path());
		assert_eq!(repo.watch_target(), temp.path().join(".jj/repo/op_heads/heads"));

		let patch = repo.diff_text(&crate::DiffOptions::default()).unwrap();
		assert!(patch.contains("diff --git a/alpha.txt b/alpha.txt"));
		assert_eq!(repo.status_porcelain(&StatusOptions::default()).unwrap(), "A  alpha.txt\n");
		let nul = repo
			.status_porcelain(&StatusOptions { nul_terminated: true, ..StatusOptions::default() })
			.unwrap();
		assert_eq!(parse_status_nul(&nul), vec![("A  ".to_owned(), vec!["alpha.txt".to_owned()])]);
		assert_eq!(repo.changed_files(&crate::DiffOptions::default()).unwrap(), vec!["alpha.txt"]);
		assert_eq!(repo.numstat(&crate::DiffOptions::default()).unwrap(), vec![NumstatEntry {
			path:    "alpha.txt".to_owned(),
			added:   Some(2),
			removed: Some(0),
		}]);
		assert_eq!(repo.ls_files(false, false).unwrap(), vec!["alpha.txt"]);
		assert_eq!(repo.ls_files(true, true).unwrap(), Vec::<String>::new());

		let head = repo.head_id().unwrap().unwrap();
		let details = repo.commit_details("@").unwrap();
		assert_eq!(details.sha, head);
		assert_eq!(details.parents, Vec::<String>::new());
		assert_eq!(details.message, "");
		assert_eq!(repo.log_subjects(1).unwrap(), vec![""]);
		let lines = repo.log_onelines(1).unwrap();
		assert_eq!(lines.len(), 1);
		let (change_id, subject) = lines[0].split_once(' ').unwrap();
		assert!(change_id.len() >= 8);
		assert_eq!(subject, "");
	}

	#[test]
	fn jj_operations_match_cli() {
		if !jj_available() {
			return;
		}
		let temp = tempfile::tempdir().unwrap();
		run_jj(temp.path(), &["git", "init", "."]);
		std::fs::write(temp.path().join("alpha.txt"), "one\ntwo\n").unwrap();
		run_jj(temp.path(), &["bookmark", "create", "main", "-r", "@"]);
		let workspace = JjWorkspace::require(temp.path()).unwrap();

		let label_raw = run_jj(temp.path(), &[
			"log",
			"--no-graph",
			"--ignore-working-copy",
			"-r",
			"@ | heads(::@ & bookmarks())",
			"-T",
			"change_id.shortest(8) ++ \"|\" ++ local_bookmarks ++ \"\\n\"",
		]);
		assert_eq!(workspace.working_copy_label().unwrap(), parse_label(&label_raw));

		let summary_raw =
			run_jj(temp.path(), &["diff", "-r", "@", "--summary", "--ignore-working-copy"]);
		assert_eq!(workspace.status_summary().unwrap(), parse_summary(&summary_raw));

		let expected_patch = run_jj(temp.path(), &["diff", "--git", "--ignore-working-copy"]);
		let actual_patch = workspace.diff_text(&[], false).unwrap();
		assert_eq!(patch_files(&actual_patch), patch_files(&expected_patch));
		assert_eq!(
			actual_patch
				.lines()
				.filter(|line| line.starts_with("@@ "))
				.count(),
			expected_patch
				.lines()
				.filter(|line| line.starts_with("@@ "))
				.count()
		);
	}

	#[test]
	fn jj_portable_status_log_and_numstat_match_cli_fixture() {
		if !jj_available() {
			return;
		}
		let temp = tempfile::tempdir().unwrap();
		run_jj(temp.path(), &["git", "init", "."]);
		fs::write(temp.path().join("rename.txt"), "rename\n").unwrap();
		fs::write(temp.path().join("delete.txt"), "delete\n").unwrap();
		fs::write(temp.path().join("modify.txt"), "before\n").unwrap();
		run_jj(temp.path(), &["commit", "-m", "base"]);
		fs::rename(temp.path().join("rename.txt"), temp.path().join("renamed.txt")).unwrap();
		fs::remove_file(temp.path().join("delete.txt")).unwrap();
		fs::write(temp.path().join("modify.txt"), "after\n").unwrap();
		fs::write(temp.path().join("added.txt"), "added\n").unwrap();
		let workspace = JjWorkspace::require(temp.path()).unwrap();
		let patch = workspace.diff_text(&[], true).unwrap();

		let lines = workspace
			.status_porcelain(&StatusOptions::default())
			.unwrap();
		assert!(lines.contains("A  added.txt\n"));
		assert!(lines.contains("D  delete.txt\n"));
		assert!(lines.contains("M  modify.txt\n"));
		assert!(lines.contains("R  rename.txt -> renamed.txt\n"));
		let nul = workspace
			.status_porcelain(&StatusOptions { nul_terminated: true, ..StatusOptions::default() })
			.unwrap();
		let framed = parse_status_nul(&nul);
		assert!(
			framed
				.contains(&("R  ".to_owned(), vec!["renamed.txt".to_owned(), "rename.txt".to_owned()]))
		);

		let actual_numstat = workspace
			.numstat(&[])
			.unwrap()
			.into_iter()
			.map(|entry| (entry.path, (entry.added.unwrap(), entry.removed.unwrap())))
			.collect::<BTreeMap<_, _>>();
		assert_eq!(actual_numstat, patch_numstat(&patch));
		assert_eq!(workspace.ls_files(true).unwrap(), Vec::<String>::new());

		let log = workspace.log_onelines(2).unwrap();
		assert_eq!(log.len(), 2);
		assert!(log[1].ends_with(" base"));
		let details = workspace.commit_details("@").unwrap();
		assert_eq!(details.sha, workspace.head_id().unwrap().unwrap());
		assert_eq!(details.parents.len(), 1);
	}
}
