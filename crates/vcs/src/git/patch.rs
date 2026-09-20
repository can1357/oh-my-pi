//! Patch application, hunk staging, stash, and cherry-pick for
//! [`GitRepo`](super::GitRepo).
//!
//! Patch joins deliberately preserve binary-patch terminators (issue #8899).
//! Cherry-picks are fail-clean: unlike `git cherry-pick`, conflicts do not put
//! markers or unmerged entries in the checkout. Stash pop is likewise
//! preflighted so a rejected restore leaves no trace (issue #4175).

#[cfg(unix)]
use std::os::unix::fs::MetadataExt;
use std::{
	cell::RefCell,
	collections::{BTreeMap, BTreeSet},
	fs,
	path::{Component, Path, PathBuf},
	sync::{
		Arc, LazyLock,
		atomic::{AtomicU64, Ordering},
	},
};

use gix::{
	bstr::{BStr, ByteSlice},
	index::entry::{Flags, Mode, Stat},
	merge::tree::TreatAsUnresolved,
	objs::tree::EntryKind,
	refs::transaction::PreviousValue,
};
use omp_core::{FastHashMap, FastHashSet};
use parking_lot::Mutex;

use super::{GitRepo, mutate::update_reference};
use crate::{
	error::{Error, Result},
	types::{ApplyOptions, DiffOptions, HunkSelection, HunkSelectionError, HunkSpec},
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct FileEntry {
	id:            gix::ObjectId,
	mode:          Mode,
	/// Index entry carries git's intent-to-add flag (`git add -N`): the path
	/// is promised but has no staged content yet.
	intent_to_add: bool,
}
impl FileEntry {
	const fn new(id: gix::ObjectId, mode: Mode) -> Self {
		Self { id, mode, intent_to_add: false }
	}
}

#[derive(Clone, Debug)]
struct FilePatch {
	old_path: Option<String>,
	new_path: Option<String>,
	old_mode: Option<Mode>,
	new_mode: Option<Mode>,
	old_oid:  Option<String>,
	new_oid:  Option<String>,
	hunks:    Vec<Hunk>,
	binary:   Vec<BinaryBlock>,
	raw:      String,
}

#[derive(Clone, Debug)]
struct Hunk {
	old_start: usize,
	old_count: usize,
	new_start: usize,
	new_count: usize,
	lines:     Vec<HunkLine>,
	raw:       String,
}

#[derive(Clone, Debug)]
struct HunkLine {
	kind:       u8,
	data:       Vec<u8>,
	no_newline: bool,
}

#[derive(Clone, Debug)]
struct BinaryBlock {
	kind:    BinaryKind,
	size:    usize,
	encoded: Vec<String>,
}

#[derive(Clone, Copy, Debug)]
enum BinaryKind {
	Literal,
	Delta,
}

#[derive(Debug)]
enum ApplyFailure {
	Context(String),
	Invalid(String),
	/// A path naming the git store, carried as a field so callers can classify
	/// and redact the refusal rather than parsing a rendered message.
	GitStore {
		path: String,
	},
}

impl ApplyFailure {
	fn into_error(self) -> Error {
		match self {
			Self::Context(message) | Self::Invalid(message) => Error::PatchFailed { message },
			Self::GitStore { path } => Error::PathInGitStore { path },
		}
	}
}

impl GitRepo {
	/// Apply a git-format patch to the worktree or index.
	pub fn apply_patch(&self, patch_text: &str, options: &ApplyOptions) -> Result<()> {
		begin_operation();
		if patch_text.trim().is_empty() {
			return Ok(());
		}
		let patches = parse_patch(patch_text).map_err(ApplyFailure::into_error)?;
		let repo = self.gix()?;
		// Containment is checked for EVERY side before anything is read or
		// written. Two distinct reasons to do it first:
		//
		//   - Reading. `augment_patch_sources` opens each source to fill the state map.
		//     A source beneath an escaping symlink would be read from outside the
		//     worktree before any later check could refuse it, and a device or FIFO
		//     target — `link/dev/zero`, a named pipe — turns that read into unbounded
		//     memory growth or a hang.
		//   - Writing. Validating per path as each is reached leaves a patch whose
		//     early files are legitimate and whose later target escapes half-applied,
		//     and a rename would already have deleted its source.
		//
		// Rejecting up front keeps application all-or-nothing with respect to
		// path validity.
		if options.cached {
			// The index never resolves a path, so the worktree preflight does
			// not apply — but `write_index_map_at` only validates `.git` by
			// NAME. A live store under another name (`git init
			// --separate-git-dir=meta .`) would take `meta/hooks/pre-commit`
			// into the index, and a later checkout materializes it over the
			// live hook. Judge the store LOCATION for every staged target.
			assert_cached_targets_outside_store(self, &repo, &patches, options.reverse)?;
		} else {
			assert_patch_paths_contained(self, &patches, options.reverse)?;
		}
		let mut state = if options.cached {
			index_map_at(&repo, options.index_path.as_deref())?
		} else {
			worktree_map(self, &repo)?
		};
		if !options.cached {
			augment_patch_sources(self, &repo, &mut state, &patches, options.reverse)?;
		}
		apply_patches_to_map(&repo, &mut state, &patches, options)?;
		if options.cached {
			write_index_map_at(&repo, &state, options.index_path.as_deref())?;
		} else {
			write_patch_worktree(self, &patches, options.reverse, &state)?;
		}
		Ok(())
	}

	/// Check whether a patch applies without changing the index or worktree.
	pub fn can_apply_patch(&self, patch_text: &str, options: &ApplyOptions) -> Result<bool> {
		begin_operation();
		if patch_text.trim().is_empty() {
			return Ok(true);
		}
		let Ok(patches) = parse_patch(patch_text) else {
			return Ok(false);
		};
		let repo = self.gix()?.with_object_memory();
		// Refused before any source is opened, for the same two reasons as
		// `apply_patch`: a probe must not be usable to read outside the
		// worktree, and a patch that cannot apply without escaping does not
		// apply. Without this the predicate answers `true` for a patch
		// `apply_patch` then refuses, and a caller that gates on it would treat
		// an attack as a viable change.
		let contained = if options.cached {
			assert_cached_targets_outside_store(self, &repo, &patches, options.reverse).is_ok()
		} else {
			assert_patch_paths_contained(self, &patches, options.reverse).is_ok()
		};
		if !contained {
			return Ok(false);
		}
		let mut state = if options.cached {
			index_map_at(&repo, options.index_path.as_deref())?
		} else {
			worktree_map(self, &repo)?
		};
		if !options.cached {
			augment_patch_sources(self, &repo, &mut state, &patches, options.reverse)?;
		}
		match apply_patches_to_map(&repo, &mut state, &patches, options) {
			Ok(()) => Ok(true),
			Err(Error::PatchFailed { .. } | Error::Conflict { .. }) => Ok(false),
			Err(err) => Err(err),
		}
	}

	/// Stage selected hunks from a supplied or freshly generated worktree diff.
	pub fn stage_hunks(&self, selections: &[HunkSelection], raw_diff: Option<&str>) -> Result<()> {
		if selections.is_empty() {
			return Ok(());
		}
		let owned;
		let raw_diff = if let Some(raw_diff) = raw_diff {
			raw_diff
		} else {
			owned = self.diff_text(&DiffOptions::default())?;
			&owned
		};
		let files = parse_patch(raw_diff).map_err(ApplyFailure::into_error)?;
		let mut by_path = BTreeMap::new();
		for file in &files {
			if let Some(path) = file.new_path.as_ref().or(file.old_path.as_ref()) {
				by_path.insert(path.as_str(), file);
			}
		}
		let mut parts = Vec::with_capacity(selections.len());
		for selection in selections {
			let Some(file) = by_path.get(selection.path.as_str()) else {
				return Err(Error::PatchFailed {
					message: format!("No diff found for {}", selection.path),
				});
			};
			if !file.binary.is_empty() {
				if !matches!(selection.hunks, HunkSpec::All) {
					return Err(Error::PatchFailed {
						message: format!("Cannot select hunks for binary file {}", selection.path),
					});
				}
				parts.push(file.raw.clone());
				continue;
			}
			if matches!(selection.hunks, HunkSpec::All) {
				parts.push(file.raw.clone());
				continue;
			}
			let selected = select_hunks(file, &selection.hunks);
			if selected.is_empty() {
				return Err(Error::PatchFailed {
					message: format!("No hunks selected for {}", selection.path),
				});
			}
			let header = extract_file_header(&file.raw);
			let mut part = header.to_owned();
			for hunk in selected {
				if !part.ends_with('\n') {
					part.push('\n');
				}
				part.push_str(&hunk.raw);
			}
			parts.push(part);
		}
		let patch = join_patches(&parts);
		self.apply_patch(&patch, &ApplyOptions {
			cached:     true,
			index_path: None,
			reverse:    false,
			three_way:  false,
		})
	}

	/// Cherry-pick one commit with a fail-clean three-way tree merge.
	pub fn cherry_pick(&self, rev: &str) -> Result<()> {
		begin_operation();
		let repo = self.gix()?;
		let picked_id = repo
			.rev_parse_single(rev)
			.map_err(|err| Error::backend("git cherry-pick resolve", err))?
			.detach();
		let picked = repo
			.find_commit(picked_id)
			.map_err(|err| Error::backend("git cherry-pick commit", err))?;
		let parent_id = picked.parent_ids().next().map(|id| id.detach());
		let head = repo
			.head_commit()
			.map_err(|err| Error::backend("git cherry-pick HEAD", err))?;
		let head_id = head.id().detach();
		let head_tree = head
			.tree_id()
			.map_err(|err| Error::backend("git cherry-pick HEAD tree", err))?;
		let parent_tree = if let Some(parent_id) = parent_id {
			repo
				.find_commit(parent_id)
				.map_err(|err| Error::backend("git cherry-pick parent", err))?
				.tree_id()
				.map_err(|err| Error::backend("git cherry-pick parent tree", err))?
				.detach()
		} else {
			repo.empty_tree().id().detach()
		};
		let picked_tree = picked
			.tree_id()
			.map_err(|err| Error::backend("git cherry-pick picked tree", err))?;
		let options = repo
			.tree_merge_options()
			.map_err(|err| Error::backend("git cherry-pick options", err))?;
		let labels = gix::merge::blob::builtin_driver::text::Labels {
			ancestor: Some("base".into()),
			current:  Some("HEAD".into()),
			other:    Some(rev.into()),
		};
		let mut outcome = repo
			.merge_trees(parent_tree, head_tree, picked_tree, labels, options)
			.map_err(|err| Error::backend("git cherry-pick merge", err))?;
		if outcome.has_unresolved_conflicts(TreatAsUnresolved::default()) {
			return Err(Error::Conflict { paths: Vec::new() });
		}
		let merged_tree = outcome
			.tree
			.write()
			.map_err(|err| Error::backend("git cherry-pick write tree", err))?
			.detach();
		if merged_tree == head_tree.detach() {
			return Err(Error::EmptyCherryPick { sha: picked_id.to_string() });
		}
		let author = picked
			.author()
			.map_err(|err| Error::backend("git cherry-pick author", err))?;
		let committer = repo
			.committer()
			.ok_or_else(|| Error::backend("git cherry-pick", "committer identity is not configured"))?
			.map_err(|err| Error::backend("git cherry-pick committer", err))?;
		let message = picked
			.message_raw()
			.map_err(|err| Error::backend("git cherry-pick message", err))?
			.to_str_lossy();
		let merged = tree_map(&repo, merged_tree)?;
		let previous = index_map(&repo)?;
		// Refuse before HEAD moves. Discovering an escaping path after the
		// commit would leave HEAD ahead of a worktree and index that never
		// received it — a fail-clean pick must fail before it commits.
		assert_worktree_map_contained(self, &repo, &previous, &merged)?;
		repo
			.commit_as(committer, author, "HEAD", message.as_ref(), merged_tree, [head_id])
			.map_err(|err| Error::backend("git cherry-pick commit", err))?;
		write_worktree_map(self, &previous, &merged)?;
		write_index_map(&repo, &merged)
	}

	/// Clear cherry-pick state; fail-clean single-commit picks create none.
	pub const fn cherry_pick_abort(&self) -> Result<()> {
		Ok(())
	}

	/// Skip cherry-pick state; single-commit picks have no sequencer.
	pub const fn cherry_pick_skip(&self) -> Result<()> {
		Ok(())
	}

	/// Stash index, tracked worktree changes, and untracked files.
	pub fn stash_push(&self, message: Option<&str>) -> Result<bool> {
		begin_operation();
		let repo = self.gix()?;
		let head = repo
			.head_commit()
			.map_err(|err| Error::backend("git stash HEAD", err))?;
		let head_id = head.id().detach();
		let head_tree = head
			.tree_id()
			.map_err(|err| Error::backend("git stash HEAD tree", err))?
			.detach();
		let head_map = tree_map(&repo, head_tree)?;
		let index = index_map(&repo)?;
		// Before READING. `tracked_worktree_map` opens every indexed path to
		// build the map, so an indexed `dir/file` shadowed by an outbound `dir`
		// symlink is slurped from outside the worktree and written into a loose
		// blob before any later check can refuse it — and a large enough file
		// exhausts memory or disk on the way. Only prefixes are judged: the
		// leaf is the file being read, and whether it is itself a link is the
		// write-side question.
		assert_indexed_prefixes_contained(self, &repo, &index)?;
		let tracked_worktree = tracked_worktree_map(self, &repo, &index)?;
		let untracked = untracked_worktree_map(self, &repo, &index)?;
		if index == head_map && tracked_worktree == index && untracked.is_empty() {
			return Ok(false);
		}
		let index_tree = write_tree_map(&repo, &index)?;
		let worktree_tree = write_tree_map(&repo, &tracked_worktree)?;
		let untracked_tree = write_tree_map(&repo, &untracked)?;
		let label = message.unwrap_or("WIP");
		let index_commit = repo
			.new_commit(format!("index on HEAD: {label}"), index_tree, [head_id])
			.map_err(|err| Error::backend("git stash index commit", err))?;
		let untracked_commit = repo
			.new_commit("untracked files on HEAD", untracked_tree, std::iter::empty::<gix::ObjectId>())
			.map_err(|err| Error::backend("git stash untracked commit", err))?;
		let stash_commit = repo
			.new_commit(label, worktree_tree, [
				head_id,
				index_commit.id().detach(),
				untracked_commit.id().detach(),
			])
			.map_err(|err| Error::backend("git stash commit", err))?;
		// Refuse before `refs/stash` moves. Discovering an escaping path during
		// the writes below would install a stash and its reflog while leaving
		// the dirty worktree and index in place — the caller sees an error and
		// a stash it did not ask for. Same ordering `cherry_pick` uses. The
		// untracked paths were already judged inside `untracked_worktree_map`,
		// before any of them was read.
		let gix_repo = repo.clone();
		assert_worktree_map_contained(self, &gix_repo, &tracked_worktree, &head_map)?;
		update_stash_ref(
			&repo,
			stash_commit.id().detach(),
			PreviousValue::Any,
			format!("On HEAD: {label}"),
			true,
		)?;
		write_worktree_map(self, &tracked_worktree, &head_map)?;
		write_index_map(&repo, &head_map)?;
		for path in untracked.keys() {
			remove_worktree_path(self, path)?;
		}
		Ok(true)
	}

	/// Try to pop the top stash without leaving partial conflict state.
	pub fn stash_try_pop(&self, reinstate_index: bool) -> Result<bool> {
		begin_operation();
		let repo = self.gix()?;
		let Some(stash_ref) = repo
			.try_find_reference("refs/stash")
			.map_err(|err| Error::backend("git stash resolve", err))?
		else {
			return Ok(false);
		};
		let stash_id = stash_ref.id().detach();
		// Same ordering hazard as `stash_push`: the maps below read indexed
		// paths off disk before anything validates them.
		{
			let index = index_map(&repo)?;
			assert_indexed_prefixes_contained(self, &repo, &index)?;
		}
		let stash_log = fs::read(self.info().common_dir.join("logs/refs/stash")).ok();
		let stash = repo
			.find_commit(stash_id)
			.map_err(|err| Error::backend("git stash commit", err))?;
		let parents: Vec<_> = stash.parent_ids().map(|id| id.detach()).collect();
		if parents.len() < 2 {
			return Err(Error::backend("git stash pop", "stash commit has fewer than two parents"));
		}
		let base = repo
			.find_commit(parents[0])
			.map_err(|err| Error::backend("git stash base", err))?;
		let base_tree = base
			.tree_id()
			.map_err(|err| Error::backend("git stash base tree", err))?
			.detach();
		let stash_tree = stash
			.tree_id()
			.map_err(|err| Error::backend("git stash tree", err))?
			.detach();
		let current_index = index_map(&repo)?;
		let current_worktree = tracked_worktree_map(self, &repo, &current_index)?;
		let current_tree = write_tree_map(&repo, &current_worktree)?;
		let Some(merged_worktree) = merge_tree_maps(&repo, base_tree, current_tree, stash_tree)?
		else {
			return Ok(false);
		};
		let merged_index = if reinstate_index {
			let stash_index = repo
				.find_commit(parents[1])
				.map_err(|err| Error::backend("git stash index", err))?;
			let stash_index_tree = stash_index
				.tree_id()
				.map_err(|err| Error::backend("git stash index tree", err))?
				.detach();
			let current_index_tree = write_tree_map(&repo, &current_index)?;
			let Some(merged) =
				merge_tree_maps(&repo, base_tree, current_index_tree, stash_index_tree)?
			else {
				return Ok(false);
			};
			Some(merged)
		} else {
			None
		};
		let untracked = if let Some(parent) = parents.get(2) {
			let untracked_commit = repo
				.find_commit(*parent)
				.map_err(|err| Error::backend("git stash untracked", err))?;
			let tree = untracked_commit
				.tree_id()
				.map_err(|err| Error::backend("git stash untracked tree", err))?;
			tree_map(&repo, tree.detach())?
		} else {
			BTreeMap::new()
		};
		for path in untracked.keys() {
			if self.root().join(path).symlink_metadata().is_ok() {
				return Ok(false);
			}
		}
		// The collision probe above answers "is something already there", which
		// an outbound symlink in the PREFIX makes falsely negative: the external
		// target is absent, so the leaf looks free. Containment is a separate
		// question and must be settled for every destination — tracked and
		// untracked alike — before the first write, or a refusal lands after the
		// tracked half has been restored and the stash is still present.
		if let Some(index) = &merged_index {
			// Index-only entries can be absent from the restored worktree. Reject
			// them before any files change, not later in `write_index_map`.
			//
			// The store is judged by LOCATION as well as by name. An older or
			// hand-made stash can carry an index-only `meta/hooks/pre-commit`
			// from before `meta` became an in-worktree separate store; the pop
			// would accept it — `write_index_map` validates `.git` by name
			// alone — and a later checkout materializes it over the live hook.
			// Same rule the cached-patch preflight applies.
			for path in index.keys() {
				validate_repo_path(path).map_err(ApplyFailure::into_error)?;
				assert_prefix_outside_git_store(self, &repo, path)?;
			}
		}
		assert_worktree_map_contained(self, &repo, &current_worktree, &merged_worktree)?;
		// The untracked half is written AFTER the tracked map, so its topology
		// is the tracked map's RESULT, not the filesystem of today: a tracked
		// outbound `dir` the pop deletes is gone before an untracked `dir/u` is
		// restored, and a link the pop CREATES exists by the time an untracked
		// descendant is written. One plan expresses both — the tracked map's
		// steps, then the untracked writes, in the order `write_worktree_map`
		// and the loop below execute them.
		let mut plan = map_plan(self, &current_worktree, &merged_worktree);
		plan.extend(
			untracked
				.iter()
				.map(|(path, entry)| PlanStep::Write { path, mode: entry.mode }),
		);
		assert_plan_contained(self, &repo, plan)?;
		write_worktree_map(self, &current_worktree, &merged_worktree)?;
		for (path, entry) in &untracked {
			write_worktree_entry(self, path, entry, &repo)?;
		}
		if let Some(merged_index) = merged_index {
			write_index_map(&repo, &merged_index)?;
		}
		drop_stash(self, &repo, &stash_ref, stash_id, stash_log.as_deref())?;
		Ok(true)
	}
}

/// Join patch parts verbatim, adding one final newline only when absent.
pub fn join_patches(parts: &[String]) -> String {
	let capacity = parts
		.iter()
		.map(|part| part.len() + usize::from(!part.ends_with('\n')))
		.sum();
	let mut joined = String::with_capacity(capacity);
	for part in parts {
		joined.push_str(part);
		if !part.ends_with('\n') {
			joined.push('\n');
		}
	}
	joined
}

/// Validate hunk selections against a raw git diff.
pub fn validate_hunk_selections(
	raw_diff: &str,
	selections: &[HunkSelection],
) -> Vec<HunkSelectionError> {
	let Ok(files) = parse_patch(raw_diff) else {
		return Vec::new();
	};
	let mut by_path = BTreeMap::new();
	for file in &files {
		if let Some(path) = file.new_path.as_ref().or(file.old_path.as_ref()) {
			by_path.insert(path.as_str(), file);
		}
	}
	let mut errors = Vec::new();
	for selection in selections {
		let Some(file) = by_path.get(selection.path.as_str()) else {
			continue;
		};
		if matches!(selection.hunks, HunkSpec::All) {
			continue;
		}
		if !file.binary.is_empty() {
			errors.push(HunkSelectionError {
				path:    selection.path.clone(),
				message: format!("Cannot select hunks for binary file {}", selection.path),
			});
		} else if select_hunks(file, &selection.hunks).is_empty() {
			errors.push(HunkSelectionError {
				path:    selection.path.clone(),
				message: format!("No hunks selected for {}", selection.path),
			});
		}
	}
	errors
}

fn parse_patch(text: &str) -> std::result::Result<Vec<FilePatch>, ApplyFailure> {
	let starts: Vec<_> = text
		.match_indices("diff --git ")
		.filter(|(idx, _)| *idx == 0 || text.as_bytes()[idx - 1] == b'\n')
		.map(|(idx, _)| idx)
		.collect();
	if starts.is_empty() {
		return Err(ApplyFailure::Invalid("patch has no diff --git header".into()));
	}
	let mut files = Vec::with_capacity(starts.len());
	for (position, start) in starts.iter().copied().enumerate() {
		let end = starts.get(position + 1).copied().unwrap_or(text.len());
		files.push(parse_file_patch(&text[start..end])?);
	}
	Ok(files)
}

fn parse_file_patch(raw: &str) -> std::result::Result<FilePatch, ApplyFailure> {
	let lines: Vec<&str> = raw.split_inclusive('\n').collect();
	let first = lines
		.first()
		.map(|line| line.trim_end_matches('\n'))
		.unwrap_or_default();
	let paths = first
		.strip_prefix("diff --git ")
		.ok_or_else(|| ApplyFailure::Invalid("invalid diff header".into()))?;
	let (old_token, new_token) = split_diff_paths(paths)?;
	let mut patch = FilePatch {
		old_path: Some(strip_side_path(old_token, 'a')),
		new_path: Some(strip_side_path(new_token, 'b')),
		old_mode: None,
		new_mode: None,
		old_oid:  None,
		new_oid:  None,
		hunks:    Vec::new(),
		binary:   Vec::new(),
		raw:      raw.to_owned(),
	};
	let mut index = 1;
	while index < lines.len() {
		let line = lines[index].trim_end_matches('\n');
		if let Some(value) = line.strip_prefix("old mode ") {
			patch.old_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("new mode ") {
			patch.new_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("new file mode ") {
			patch.old_path = None;
			patch.new_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("deleted file mode ") {
			patch.new_path = None;
			patch.old_mode = parse_mode(value);
		} else if let Some(value) = line.strip_prefix("rename from ") {
			patch.old_path = Some(unquote_path(value));
		} else if let Some(value) = line.strip_prefix("rename to ") {
			patch.new_path = Some(unquote_path(value));
		} else if let Some(value) = line.strip_prefix("index ") {
			let ids = value.split_whitespace().next().unwrap_or_default();
			if let Some((old, new)) = ids.split_once("..") {
				patch.old_oid = Some(old.to_owned());
				patch.new_oid = Some(new.to_owned());
			}
			if let Some(mode) = value.split_whitespace().nth(1).and_then(parse_mode) {
				patch.old_mode.get_or_insert(mode);
				patch.new_mode.get_or_insert(mode);
			}
		} else if let Some(value) = line.strip_prefix("--- ") {
			patch.old_path = parse_marker_path(value, 'a');
		} else if let Some(value) = line.strip_prefix("+++ ") {
			patch.new_path = parse_marker_path(value, 'b');
		} else if line.starts_with("@@") {
			let (hunk, next) = parse_hunk(&lines, index)?;
			patch.hunks.push(hunk);
			index = next;
			continue;
		} else if line == "GIT binary patch" {
			index += 1;
			while index < lines.len() {
				let header = lines[index].trim_end_matches('\n');
				let Some((kind, size)) = parse_binary_header(header) else {
					break;
				};
				index += 1;
				let mut encoded = Vec::new();
				while index < lines.len() {
					let data = lines[index].trim_end_matches('\n');
					if data.is_empty() {
						index += 1;
						break;
					}
					if parse_binary_header(data).is_some() {
						break;
					}
					encoded.push(data.to_owned());
					index += 1;
				}
				patch.binary.push(BinaryBlock { kind, size, encoded });
			}
			continue;
		}
		index += 1;
	}
	if patch.hunks.is_empty()
		&& patch.binary.is_empty()
		&& patch.old_path == patch.new_path
		&& patch.old_mode == patch.new_mode
	{
		return Err(ApplyFailure::Invalid("patch contains no change".into()));
	}
	Ok(patch)
}

fn split_diff_paths(paths: &str) -> std::result::Result<(&str, &str), ApplyFailure> {
	if paths.starts_with('"') {
		return Err(ApplyFailure::Invalid("quoted paths in diff headers are unsupported".into()));
	}
	paths
		.split_once(' ')
		.ok_or_else(|| ApplyFailure::Invalid("invalid diff paths".into()))
}

fn unquote_path(path: &str) -> String {
	path.trim_matches('"').to_owned()
}

fn strip_side_path(token: &str, side: char) -> String {
	let prefix = format!("{side}/");
	unquote_path(token.strip_prefix(&prefix).unwrap_or(token))
}

fn parse_marker_path(value: &str, side: char) -> Option<String> {
	let path = value.split('\t').next().unwrap_or(value);
	if path == "/dev/null" {
		None
	} else {
		Some(strip_side_path(path, side))
	}
}

fn parse_mode(value: &str) -> Option<Mode> {
	let bits = u32::from_str_radix(value.trim(), 8).ok()?;
	Mode::from_bits(bits)
}

fn parse_hunk(lines: &[&str], start: usize) -> std::result::Result<(Hunk, usize), ApplyFailure> {
	let header = lines[start].trim_end_matches('\n');
	let (old_start, old_count, new_start, new_count) = parse_hunk_header(header)?;
	let mut body: Vec<HunkLine> = Vec::new();
	let mut raw = String::from(lines[start]);
	let mut index = start + 1;
	while index < lines.len() {
		let line = lines[index];
		let bare = line.trim_end_matches('\n');
		if bare.starts_with("@@") || bare.starts_with("diff --git ") || bare == "GIT binary patch" {
			break;
		}
		let Some(kind @ (b' ' | b'+' | b'-')) = bare.as_bytes().first().copied() else {
			if bare == "\\ No newline at end of file" {
				let Some(previous) = body.last_mut() else {
					return Err(ApplyFailure::Invalid("orphan no-newline marker".into()));
				};
				previous.no_newline = true;
				raw.push_str(line);
				index += 1;
				continue;
			}
			break;
		};
		body.push(HunkLine { kind, data: bare.as_bytes()[1..].to_vec(), no_newline: false });
		raw.push_str(line);
		index += 1;
	}
	let actual_old = body.iter().filter(|line| line.kind != b'+').count();
	let actual_new = body.iter().filter(|line| line.kind != b'-').count();
	if actual_old != old_count || actual_new != new_count {
		return Err(ApplyFailure::Invalid(format!("hunk count mismatch in {header}")));
	}
	Ok((Hunk { old_start, old_count, new_start, new_count, lines: body, raw }, index))
}

fn parse_hunk_header(
	header: &str,
) -> std::result::Result<(usize, usize, usize, usize), ApplyFailure> {
	let body = header
		.strip_prefix("@@ -")
		.and_then(|value| value.split_once(" @@").map(|pair| pair.0))
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk header: {header}")))?;
	let (old, new) = body
		.split_once(" +")
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk header: {header}")))?;
	let parse_range = |value: &str| -> Option<(usize, usize)> {
		let (start, count) = value.split_once(',').unwrap_or((value, "1"));
		Some((start.parse().ok()?, count.parse().ok()?))
	};
	let (old_start, old_count) = parse_range(old)
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk range: {header}")))?;
	let (new_start, new_count) = parse_range(new)
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid hunk range: {header}")))?;
	Ok((old_start, old_count, new_start, new_count))
}

fn parse_binary_header(line: &str) -> Option<(BinaryKind, usize)> {
	let (kind, size) = line.split_once(' ')?;
	let kind = match kind {
		"literal" => BinaryKind::Literal,
		"delta" => BinaryKind::Delta,
		_ => return None,
	};
	Some((kind, size.parse().ok()?))
}

fn select_hunks<'a>(file: &'a FilePatch, spec: &HunkSpec) -> Vec<&'a Hunk> {
	match spec {
		HunkSpec::All => file.hunks.iter().collect(),
		HunkSpec::Indices(indices) => {
			let wanted: BTreeSet<_> = indices
				.iter()
				.map(|index| (*index).max(1) as usize)
				.collect();
			file
				.hunks
				.iter()
				.enumerate()
				.filter(|(index, _)| wanted.contains(&(index + 1)))
				.map(|(_, hunk)| hunk)
				.collect()
		},
		HunkSpec::Lines { start, end } => file
			.hunks
			.iter()
			.filter(|hunk| {
				let first = hunk.new_start as u32;
				let last = first
					.saturating_add(hunk.new_count as u32)
					.saturating_sub(1);
				first <= *end && last >= *start
			})
			.collect(),
	}
}

fn extract_file_header(raw: &str) -> &str {
	raw.find("\n@@").map_or(raw, |position| &raw[..=position])
}

fn apply_patches_to_map(
	repo: &gix::Repository,
	state: &mut BTreeMap<String, FileEntry>,
	patches: &[FilePatch],
	options: &ApplyOptions,
) -> Result<()> {
	for patch in patches {
		let (source_path, target_path, source_mode, target_mode) =
			patch_sides(patch, options.reverse);
		// A create patch may land on an intent-to-add entry: git treats the
		// promised path as absent and stages the real content over it.
		if source_path.is_none()
			&& target_path
				.and_then(|path| state.get(path))
				.is_some_and(|entry| !entry.intent_to_add)
		{
			return Err(Error::PatchFailed {
				message: format!("{} already exists", target_path.unwrap_or_default()),
			});
		}
		let source = source_path.and_then(|path| state.get(path).cloned());
		if source_path.is_some() && source.is_none() {
			return Err(Error::PatchFailed {
				message: format!("{} does not exist", source_path.unwrap_or_default()),
			});
		}
		if source_mode.is_some_and(|mode| source.as_ref().is_some_and(|entry| entry.mode != mode)) {
			return Err(Error::PatchFailed {
				message: format!("mode does not match for {}", source_path.unwrap_or_default()),
			});
		}
		let source_bytes = match source.as_ref() {
			Some(entry) => blob_bytes(repo, entry.id)?,
			None => Vec::new(),
		};
		let direct = apply_file_bytes(patch, &source_bytes, options.reverse);
		let bytes = match direct {
			Ok(bytes) => bytes,
			Err(ApplyFailure::Context(_)) if options.three_way => {
				merge_patch_bytes(repo, patch, source.as_ref(), options.reverse)?
			},
			Err(err) => return Err(err.into_error()),
		};
		if let Some(path) = source_path
			&& target_path != Some(path)
		{
			state.remove(path);
		}
		if let Some(path) = target_path {
			validate_repo_path(path).map_err(ApplyFailure::into_error)?;
			let id = repo
				.write_blob(&bytes)
				.map_err(|err| Error::backend("git apply write blob", err))?
				.detach();
			let mode = target_mode
				.or_else(|| source.as_ref().map(|entry| entry.mode))
				.or(source_mode)
				.unwrap_or(Mode::FILE);
			state.insert(path.to_owned(), FileEntry::new(id, mode));
		}
	}
	Ok(())
}

fn patch_sides(
	patch: &FilePatch,
	reverse: bool,
) -> (Option<&str>, Option<&str>, Option<Mode>, Option<Mode>) {
	if reverse {
		(patch.new_path.as_deref(), patch.old_path.as_deref(), patch.new_mode, patch.old_mode)
	} else {
		(patch.old_path.as_deref(), patch.new_path.as_deref(), patch.old_mode, patch.new_mode)
	}
}

fn apply_file_bytes(
	patch: &FilePatch,
	source: &[u8],
	reverse: bool,
) -> std::result::Result<Vec<u8>, ApplyFailure> {
	if !patch.binary.is_empty() {
		let block = if reverse {
			patch.binary.get(1).or_else(|| patch.binary.first())
		} else {
			patch.binary.first()
		}
		.ok_or_else(|| ApplyFailure::Invalid("binary patch has no data block".into()))?;
		return decode_binary_block(block, source);
	}
	if patch.hunks.is_empty() {
		return Ok(source.to_vec());
	}
	let mut lines = split_lines(source);
	let mut offset: isize = 0;
	for hunk in &patch.hunks {
		let (start, count, replacement, expected) = hunk_sides(hunk, reverse);
		let position = if count == 0 {
			start as isize
		} else {
			start.saturating_sub(1) as isize
		} + offset;
		if position < 0 {
			return Err(ApplyFailure::Context("hunk position precedes file".into()));
		}
		let position = position as usize;
		if position.saturating_add(expected.len()) > lines.len()
			|| lines[position..position + expected.len()] != expected
		{
			return Err(ApplyFailure::Context(format!("hunk at line {start} does not apply")));
		}
		lines.splice(position..position + expected.len(), replacement.clone());
		offset += replacement.len() as isize - expected.len() as isize;
	}
	Ok(lines.concat())
}

fn hunk_sides(hunk: &Hunk, reverse: bool) -> (usize, usize, Vec<Vec<u8>>, Vec<Vec<u8>>) {
	let mut old = Vec::new();
	let mut new = Vec::new();
	for line in &hunk.lines {
		let mut content = line.data.clone();
		if !line.no_newline {
			content.push(b'\n');
		}
		if line.kind != b'+' {
			old.push(content.clone());
		}
		if line.kind != b'-' {
			new.push(content);
		}
	}
	if reverse {
		(hunk.new_start, hunk.new_count, old, new)
	} else {
		(hunk.old_start, hunk.old_count, new, old)
	}
}

fn split_lines(bytes: &[u8]) -> Vec<Vec<u8>> {
	let mut lines = Vec::new();
	let mut start = 0;
	for (index, byte) in bytes.iter().enumerate() {
		if *byte == b'\n' {
			lines.push(bytes[start..=index].to_vec());
			start = index + 1;
		}
	}
	if start < bytes.len() {
		lines.push(bytes[start..].to_vec());
	}
	lines
}

fn decode_binary_block(
	block: &BinaryBlock,
	base: &[u8],
) -> std::result::Result<Vec<u8>, ApplyFailure> {
	let mut compressed = Vec::new();
	for line in &block.encoded {
		let bytes = line.as_bytes();
		let Some(prefix) = bytes.first().copied() else {
			return Err(ApplyFailure::Invalid("empty binary data line".into()));
		};
		let decoded_len = match prefix {
			b'A'..=b'Z' => usize::from(prefix - b'A' + 1),
			b'a'..=b'z' => usize::from(prefix - b'a' + 27),
			_ => return Err(ApplyFailure::Invalid("invalid binary line length".into())),
		};
		let mut decoded = Vec::with_capacity((bytes.len().saturating_sub(1) / 5) * 4);
		for chunk in bytes[1..].chunks(5) {
			if chunk.len() != 5 {
				return Err(ApplyFailure::Invalid("truncated base85 group".into()));
			}
			let mut value = 0_u32;
			for byte in chunk {
				let digit = u32::from(decode_base85(*byte)?);
				value = value
					.checked_mul(85)
					.and_then(|value| value.checked_add(digit))
					.ok_or_else(|| ApplyFailure::Invalid("base85 overflow".into()))?;
			}
			decoded.extend_from_slice(&value.to_be_bytes());
		}
		if decoded_len > decoded.len() {
			return Err(ApplyFailure::Invalid("binary line length exceeds payload".into()));
		}
		compressed.extend_from_slice(&decoded[..decoded_len]);
	}
	let inflate_size = block.size;
	let mut inflated = vec![0; inflate_size];
	let mut decoder = gix::features::zlib::Inflate::default();
	let (status, consumed, written) = decoder
		.once(&compressed, &mut inflated)
		.map_err(|err| ApplyFailure::Invalid(format!("invalid zlib stream: {err}")))?;
	if status != gix::features::zlib::Status::StreamEnd || consumed != compressed.len() {
		return Err(ApplyFailure::Invalid("incomplete zlib stream".into()));
	}
	inflated.truncate(written);
	if inflated.len() != block.size {
		return Err(ApplyFailure::Invalid(format!(
			"binary payload size {} != {}",
			inflated.len(),
			block.size
		)));
	}
	match block.kind {
		BinaryKind::Literal => Ok(inflated),
		BinaryKind::Delta => apply_git_delta(base, &inflated),
	}
}

fn decode_base85(byte: u8) -> std::result::Result<u8, ApplyFailure> {
	const ALPHABET: &[u8; 85] =
		b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";
	ALPHABET
		.iter()
		.position(|candidate| *candidate == byte)
		.map(|position| position as u8)
		.ok_or_else(|| ApplyFailure::Invalid(format!("invalid base85 byte {byte}")))
}

fn apply_git_delta(base: &[u8], delta: &[u8]) -> std::result::Result<Vec<u8>, ApplyFailure> {
	let mut cursor = 0;
	let base_size = read_delta_varint(delta, &mut cursor)?;
	let result_size = read_delta_varint(delta, &mut cursor)?;
	if base_size != base.len() {
		return Err(ApplyFailure::Context("binary delta base size mismatch".into()));
	}
	let mut result = Vec::with_capacity(result_size);
	while cursor < delta.len() {
		let command = delta[cursor];
		cursor += 1;
		if command & 0x80 != 0 {
			let mut offset = 0_usize;
			let mut size = 0_usize;
			for bit in 0..4 {
				if command & (1 << bit) != 0 {
					offset |= usize::from(
						*delta
							.get(cursor)
							.ok_or_else(|| ApplyFailure::Invalid("truncated delta copy offset".into()))?,
					) << (8 * bit);
					cursor += 1;
				}
			}
			for bit in 0..3 {
				if command & (1 << (4 + bit)) != 0 {
					size |= usize::from(
						*delta
							.get(cursor)
							.ok_or_else(|| ApplyFailure::Invalid("truncated delta copy size".into()))?,
					) << (8 * bit);
					cursor += 1;
				}
			}
			if size == 0 {
				size = 0x1_0000;
			}
			let end = offset
				.checked_add(size)
				.ok_or_else(|| ApplyFailure::Invalid("delta copy overflow".into()))?;
			let slice = base
				.get(offset..end)
				.ok_or_else(|| ApplyFailure::Invalid("delta copy exceeds base".into()))?;
			result.extend_from_slice(slice);
		} else if command != 0 {
			let count = usize::from(command);
			let end = cursor
				.checked_add(count)
				.ok_or_else(|| ApplyFailure::Invalid("delta insert overflow".into()))?;
			result.extend_from_slice(
				delta
					.get(cursor..end)
					.ok_or_else(|| ApplyFailure::Invalid("truncated delta insert".into()))?,
			);
			cursor = end;
		} else {
			return Err(ApplyFailure::Invalid("invalid zero delta opcode".into()));
		}
	}
	if result.len() != result_size {
		return Err(ApplyFailure::Invalid("delta result length mismatch".into()));
	}
	Ok(result)
}

fn read_delta_varint(data: &[u8], cursor: &mut usize) -> std::result::Result<usize, ApplyFailure> {
	let mut value = 0_usize;
	let mut shift = 0;
	loop {
		let byte = *data
			.get(*cursor)
			.ok_or_else(|| ApplyFailure::Invalid("truncated delta header".into()))?;
		*cursor += 1;
		value |= usize::from(byte & 0x7f)
			.checked_shl(shift)
			.ok_or_else(|| ApplyFailure::Invalid("delta varint overflow".into()))?;
		if byte & 0x80 == 0 {
			return Ok(value);
		}
		shift += 7;
		if shift >= usize::BITS {
			return Err(ApplyFailure::Invalid("delta varint overflow".into()));
		}
	}
}

fn merge_patch_bytes(
	repo: &gix::Repository,
	patch: &FilePatch,
	current: Option<&FileEntry>,
	reverse: bool,
) -> Result<Vec<u8>> {
	let old_oid = if reverse {
		patch.new_oid.as_deref()
	} else {
		patch.old_oid.as_deref()
	}
	.ok_or_else(|| Error::PatchFailed {
		message: "3-way patch lacks an index base object".into(),
	})?;
	let base_id = resolve_object(repo, old_oid)?;
	let base = blob_bytes(repo, base_id)?;
	let theirs = apply_file_bytes(patch, &base, reverse).map_err(ApplyFailure::into_error)?;
	let ours = current.map_or_else(|| Ok(Vec::new()), |entry| blob_bytes(repo, entry.id))?;
	if ours == base {
		return Ok(theirs);
	}
	if theirs == base || ours == theirs {
		return Ok(ours);
	}
	let mode = current.map_or(Mode::FILE, |entry| entry.mode);
	let base_blob = repo
		.write_blob(&base)
		.map_err(|err| Error::backend("git apply 3-way base", err))?
		.detach();
	let ours_blob = repo
		.write_blob(&ours)
		.map_err(|err| Error::backend("git apply 3-way ours", err))?
		.detach();
	let theirs_blob = repo
		.write_blob(&theirs)
		.map_err(|err| Error::backend("git apply 3-way theirs", err))?
		.detach();
	let path = patch
		.new_path
		.as_deref()
		.or(patch.old_path.as_deref())
		.unwrap_or("file");
	let base_tree =
		write_tree_map(repo, &BTreeMap::from([(path.to_owned(), FileEntry::new(base_blob, mode))]))?;
	let ours_tree =
		write_tree_map(repo, &BTreeMap::from([(path.to_owned(), FileEntry::new(ours_blob, mode))]))?;
	let theirs_tree = write_tree_map(
		repo,
		&BTreeMap::from([(path.to_owned(), FileEntry::new(theirs_blob, mode))]),
	)?;
	let Some(merged) = merge_tree_maps(repo, base_tree, ours_tree, theirs_tree)? else {
		return Err(Error::Conflict { paths: vec![path.to_owned()] });
	};
	let entry = merged
		.get(path)
		.ok_or_else(|| Error::Conflict { paths: vec![path.to_owned()] })?;
	blob_bytes(repo, entry.id)
}

fn resolve_object(repo: &gix::Repository, spec: &str) -> Result<gix::ObjectId> {
	repo
		.rev_parse_single(spec)
		.map(|id| id.detach())
		.map_err(|err| Error::backend("git apply resolve base", err))
}

fn merge_tree_maps(
	repo: &gix::Repository,
	base: gix::ObjectId,
	ours: gix::ObjectId,
	theirs: gix::ObjectId,
) -> Result<Option<BTreeMap<String, FileEntry>>> {
	let options = repo
		.tree_merge_options()
		.map_err(|err| Error::backend("git merge options", err))?;
	let labels = gix::merge::blob::builtin_driver::text::Labels {
		ancestor: Some("base".into()),
		current:  Some("current".into()),
		other:    Some("stashed".into()),
	};
	let mut outcome = repo
		.merge_trees(base, ours, theirs, labels, options)
		.map_err(|err| Error::backend("git tree merge", err))?;
	if outcome.has_unresolved_conflicts(TreatAsUnresolved::default()) {
		return Ok(None);
	}
	let tree = outcome
		.tree
		.write()
		.map_err(|err| Error::backend("git merge write tree", err))?
		.detach();
	Ok(Some(tree_map(repo, tree)?))
}
fn drop_stash(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	stash_ref: &gix::Reference<'_>,
	stash_id: gix::ObjectId,
	log: Option<&[u8]>,
) -> Result<()> {
	let Some((previous, prior_log)) = log.and_then(previous_stash_from_log) else {
		return stash_ref
			.delete()
			.map_err(|err| Error::backend("git stash drop", err));
	};
	if previous.is_null() {
		return stash_ref
			.delete()
			.map_err(|err| Error::backend("git stash drop", err));
	}
	update_reference(
		gix_repo,
		"git stash drop",
		"refs/stash",
		previous,
		PreviousValue::MustExistAndMatch(gix::refs::Target::Object(stash_id)),
		"stash: drop",
		false,
	)?;
	let log_path = repo.info().common_dir.join("logs/refs/stash");
	fs::write(log_path, prior_log)?;
	Ok(())
}
fn update_stash_ref(
	repo: &gix::Repository,
	id: gix::ObjectId,
	expected: PreviousValue,
	message: String,
	force_create_reflog: bool,
) -> Result<()> {
	update_reference(
		repo,
		"git stash ref",
		"refs/stash",
		id,
		expected,
		&message,
		force_create_reflog,
	)
}

fn previous_stash_from_log(log: &[u8]) -> Option<(gix::ObjectId, &[u8])> {
	let end = log.iter().rposition(|byte| *byte != b'\n')? + 1;
	let start = log[..end]
		.iter()
		.rposition(|byte| *byte == b'\n')
		.map_or(0, |position| position + 1);
	let old_hex = log.get(start..end)?.split(|byte| *byte == b' ').next()?;
	let previous = gix::ObjectId::from_hex(old_hex).ok()?;
	Some((previous, &log[..start]))
}

fn blob_bytes(repo: &gix::Repository, id: gix::ObjectId) -> Result<Vec<u8>> {
	repo
		.find_blob(id)
		.map(|blob| blob.data.clone())
		.map_err(|err| Error::backend("git read blob", err))
}

fn index_map(repo: &gix::Repository) -> Result<BTreeMap<String, FileEntry>> {
	let index = repo
		.index_or_load_from_head_or_empty()
		.map_err(|err| Error::backend("git read index", err))?;
	Ok(index_state_map(&index))
}

fn index_map_at(
	repo: &gix::Repository,
	index_path: Option<&Path>,
) -> Result<BTreeMap<String, FileEntry>> {
	let Some(path) = index_path else {
		return index_map(repo);
	};
	match fs::metadata(path) {
		Ok(_) => {
			let index = gix::index::File::at(
				path,
				repo.object_hash(),
				false,
				gix::index::decode::Options::default(),
			)
			.map_err(|err| Error::backend("git read alternate index", err))?;
			Ok(index_state_map(&index))
		},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
		Err(err) => Err(err.into()),
	}
}

fn index_state_map(index: &gix::index::State) -> BTreeMap<String, FileEntry> {
	let mut map = BTreeMap::new();
	for entry in index.entries() {
		if entry.stage() == gix::index::entry::Stage::Unconflicted {
			let path = entry.path(index);
			map.insert(path.to_str_lossy().into_owned(), FileEntry {
				id:            entry.id,
				mode:          entry.mode,
				intent_to_add: entry.flags.contains(Flags::INTENT_TO_ADD),
			});
		}
	}
	map
}

fn tree_map(repo: &gix::Repository, tree: gix::ObjectId) -> Result<BTreeMap<String, FileEntry>> {
	let index = repo
		.index_from_tree(&tree)
		.map_err(|err| Error::backend("git read tree", err))?;
	let mut map = BTreeMap::new();
	for entry in index.entries() {
		let path = entry.path(&index);
		map.insert(path.to_str_lossy().into_owned(), FileEntry::new(entry.id, entry.mode));
	}
	Ok(map)
}

fn worktree_map(repo: &GitRepo, gix_repo: &gix::Repository) -> Result<BTreeMap<String, FileEntry>> {
	let index = index_map(gix_repo)?;
	// Both apply and probe read every indexed path, not just patch sources.
	assert_indexed_prefixes_contained(repo, gix_repo, &index)?;
	tracked_worktree_map(repo, gix_repo, &index)
}
fn augment_patch_sources(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	state: &mut BTreeMap<String, FileEntry>,
	patches: &[FilePatch],
	reverse: bool,
) -> Result<()> {
	for patch in patches {
		let (source, target, source_mode, target_mode) = patch_sides(patch, reverse);
		let path = if let Some(path) = source {
			path
		} else {
			let Some(target) = target else {
				continue;
			};
			target
		};
		if state.contains_key(path) {
			continue;
		}
		let mode = source_mode.or(target_mode).unwrap_or(Mode::FILE);
		if let Some((bytes, mode)) = read_worktree_entry(&repo.root().join(path), mode)? {
			let id = gix_repo
				.write_blob(bytes)
				.map_err(|err| Error::backend("git hash patch source", err))?
				.detach();
			state.insert(path.to_owned(), FileEntry::new(id, mode));
		}
	}
	Ok(())
}

fn tracked_worktree_map(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	index: &BTreeMap<String, FileEntry>,
) -> Result<BTreeMap<String, FileEntry>> {
	let mut map = BTreeMap::new();
	for (path, entry) in index {
		let absolute = repo.root().join(path);
		if let Some((bytes, mode)) = read_worktree_entry(&absolute, entry.mode)? {
			let id = gix_repo
				.write_blob(bytes)
				.map_err(|err| Error::backend("git hash worktree blob", err))?
				.detach();
			map.insert(path.clone(), FileEntry::new(id, mode));
		}
	}
	Ok(map)
}

fn untracked_worktree_map(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	index: &BTreeMap<String, FileEntry>,
) -> Result<BTreeMap<String, FileEntry>> {
	let mut walk_index = gix_repo
		.index_or_load_from_head_or_empty()
		.map_err(|err| Error::backend("git read index for untracked files", err))?
		.into_owned();
	for entry in walk_index.entries_mut() {
		entry.flags.insert(Flags::UPTODATE);
	}
	let options = gix_repo
		.dirwalk_options()
		.map_err(|err| Error::backend("git untracked options", err))?;
	let walk = gix_repo
		.dirwalk_iter(
			walk_index,
			std::iter::empty::<gix::bstr::BString>(),
			Default::default(),
			options,
		)
		.map_err(|err| Error::backend("git untracked walk", err))?;
	let mut map = BTreeMap::new();
	for item in walk {
		let item = item.map_err(|err| Error::backend("git untracked walk", err))?;
		if item.entry.status != gix::dir::entry::Status::Untracked
			|| !matches!(
				item.entry.disk_kind,
				Some(gix::dir::entry::Kind::File | gix::dir::entry::Kind::Symlink)
			) {
			continue;
		}
		let path = item.entry.rela_path.to_str_lossy().into_owned();
		if index.contains_key(&path) {
			continue;
		}
		// Refuse BEFORE reading. An in-worktree separate store (`git init
		// --separate-git-dir=meta sub`) is untracked as far as the outer
		// repository is concerned, so every pack inside it would otherwise be
		// opened, hashed and written as a loose blob — and the stash's tree and
		// commit objects minted on top — only for `stash_push` to refuse the
		// path afterwards. Same ordering `tracked_worktree_map` gets from
		// `assert_indexed_prefixes_contained`: judge the prefix first, since the
		// leaf is the file about to be read.
		validate_repo_path(&path).map_err(ApplyFailure::into_error)?;
		assert_prefix_within_root(repo.root(), &path)?;
		assert_prefix_outside_git_store(repo, gix_repo, &path)?;
		let absolute = repo.root().join(&path);
		if let Some((bytes, mode)) = read_worktree_entry(&absolute, Mode::FILE)? {
			let id = gix_repo
				.write_blob(bytes)
				.map_err(|err| Error::backend("git hash untracked blob", err))?
				.detach();
			map.insert(path, FileEntry::new(id, mode));
		}
	}
	Ok(map)
}

fn read_worktree_entry(path: &Path, index_mode: Mode) -> Result<Option<(Vec<u8>, Mode)>> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(err) => return Err(err.into()),
	};
	if metadata.file_type().is_symlink() {
		let target = fs::read_link(path)?;
		#[cfg(unix)]
		let bytes = {
			use std::os::unix::ffi::OsStrExt;
			target.as_os_str().as_bytes().to_vec()
		};
		#[cfg(not(unix))]
		let bytes = target.to_string_lossy().as_bytes().to_vec();
		return Ok(Some((bytes, Mode::SYMLINK)));
	}
	if !metadata.is_file() {
		return Ok(None);
	}
	let mode = worktree_file_mode(&metadata, index_mode);
	Ok(Some((fs::read(path)?, mode)))
}

#[cfg(unix)]
fn worktree_file_mode(metadata: &fs::Metadata, _index_mode: Mode) -> Mode {
	use std::os::unix::fs::PermissionsExt;
	if metadata.permissions().mode() & 0o111 != 0 {
		Mode::FILE_EXECUTABLE
	} else {
		Mode::FILE
	}
}

#[cfg(not(unix))]
fn worktree_file_mode(_metadata: &fs::Metadata, index_mode: Mode) -> Mode {
	index_mode
}

fn write_index_map(repo: &gix::Repository, map: &BTreeMap<String, FileEntry>) -> Result<()> {
	write_index_map_at(repo, map, None)
}

fn write_index_map_at(
	repo: &gix::Repository,
	map: &BTreeMap<String, FileEntry>,
	index_path: Option<&Path>,
) -> Result<()> {
	let mut state = gix::index::State::new(repo.object_hash());
	for (path, entry) in map {
		validate_repo_path(path).map_err(ApplyFailure::into_error)?;
		// INTENT_TO_ADD lives in the extended flag word; losing it here would
		// silently stage promised paths as empty files.
		let flags = if entry.intent_to_add {
			Flags::EXTENDED | Flags::INTENT_TO_ADD
		} else {
			Flags::empty()
		};
		state.dangerously_push_entry(
			Stat::default(),
			entry.id,
			flags,
			entry.mode,
			BStr::new(path.as_bytes()),
		);
	}
	state.sort_entries();
	let mut index = gix::index::File::from_state(
		state,
		index_path.map_or_else(|| repo.index_path(), Path::to_owned),
	);
	index.remove_tree();
	index
		.write(gix::index::write::Options::default())
		.map_err(|err| Error::backend("git write index", err))
}

fn write_tree_map(
	repo: &gix::Repository,
	map: &BTreeMap<String, FileEntry>,
) -> Result<gix::ObjectId> {
	let empty = repo.empty_tree();
	let mut editor = empty
		.edit()
		.map_err(|err| Error::backend("git edit tree", err))?;
	for (path, entry) in map {
		validate_repo_path(path).map_err(ApplyFailure::into_error)?;
		editor
			.upsert(path.as_str(), entry_kind(entry.mode), entry.id)
			.map_err(|err| Error::backend("git edit tree", err))?;
	}
	editor
		.write()
		.map(|id| id.detach())
		.map_err(|err| Error::backend("git write tree", err))
}

fn entry_kind(mode: Mode) -> EntryKind {
	if mode == Mode::FILE_EXECUTABLE {
		EntryKind::BlobExecutable
	} else if mode == Mode::SYMLINK {
		EntryKind::Link
	} else if mode == Mode::COMMIT {
		EntryKind::Commit
	} else {
		EntryKind::Blob
	}
}

fn write_patch_worktree(
	repo: &GitRepo,
	patches: &[FilePatch],
	reverse: bool,
	state: &BTreeMap<String, FileEntry>,
) -> Result<()> {
	for patch in patches {
		let (source, target, ..) = patch_sides(patch, reverse);
		if let Some(source) = source
			&& target != Some(source)
		{
			remove_worktree_path(repo, source)?;
		}
		if let Some(target) = target {
			let entry = state.get(target).ok_or_else(|| Error::PatchFailed {
				message: format!("missing applied path {target}"),
			})?;
			write_worktree_entry(repo, target, entry, &repo.gix()?)?;
		}
	}
	Ok(())
}

fn write_worktree_map(
	repo: &GitRepo,
	previous: &BTreeMap<String, FileEntry>,
	next: &BTreeMap<String, FileEntry>,
) -> Result<()> {
	let gix_repo = repo.gix()?;
	// Every removal and every write is validated before the first one happens,
	// so a refusal cannot leave the worktree half-written. Callers that mutate
	// repository state first must call `assert_worktree_map_contained` BEFORE
	// they commit, not rely on this one.
	assert_worktree_map_contained(repo, &gix_repo, previous, next)?;
	for path in previous.keys() {
		if !next.contains_key(path) {
			remove_worktree_path(repo, path)?;
		}
	}
	for (path, entry) in next {
		if previous.get(path) != Some(entry) || !repo.root().join(path).exists() {
			write_worktree_entry(repo, path, entry, &gix_repo)?;
		}
	}
	Ok(())
}

fn write_worktree_entry(
	repo: &GitRepo,
	path: &str,
	entry: &FileEntry,
	gix_repo: &gix::Repository,
) -> Result<()> {
	validate_repo_path(path).map_err(ApplyFailure::into_error)?;
	// A symlink is unlinked and recreated, never opened through, so its leaf is
	// not resolved; resolving it would reject repositories that legitimately
	// track a link pointing outside the worktree.
	if entry.mode == Mode::SYMLINK {
		assert_prefix_within_root(repo.root(), path)?;
	} else {
		assert_within_root(repo.root(), path)?;
	}
	let absolute = repo.root().join(path);
	if let Some(parent) = absolute.parent() {
		fs::create_dir_all(parent)?;
	}
	let bytes = blob_bytes(gix_repo, entry.id)?;
	if entry.mode == Mode::SYMLINK {
		let _ = fs::remove_file(&absolute);
		#[cfg(unix)]
		{
			use std::os::unix::{ffi::OsStrExt, fs::symlink};
			symlink(std::ffi::OsStr::from_bytes(&bytes), &absolute)?;
		}
		#[cfg(not(unix))]
		fs::write(&absolute, bytes)?;
		return Ok(());
	}
	fs::write(&absolute, bytes)?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let permissions = fs::Permissions::from_mode(if entry.mode == Mode::FILE_EXECUTABLE {
			0o755
		} else {
			0o644
		});
		fs::set_permissions(&absolute, permissions)?;
	}
	Ok(())
}

fn remove_worktree_path(repo: &GitRepo, path: &str) -> Result<()> {
	validate_repo_path(path).map_err(ApplyFailure::into_error)?;
	// Only the PREFIX is resolved: `remove_file` unlinks a directory entry
	// without following it, so a tracked symlink pointing outside the worktree
	// is safe to delete and must stay deletable.
	assert_prefix_within_root(repo.root(), path)?;
	assert_prefix_outside_git_store(repo, &repo.gix()?, path)?;
	let absolute = repo.root().join(path);
	match fs::remove_file(&absolute) {
		Ok(()) => {},
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
		Err(err) => return Err(err.into()),
	}
	let mut directory = absolute.parent();
	while let Some(current) = directory {
		if current == repo.root() {
			break;
		}
		match fs::remove_dir(current) {
			Ok(()) => directory = current.parent(),
			Err(_) => break,
		}
	}
	Ok(())
}

fn validate_repo_path(path: &str) -> std::result::Result<(), ApplyFailure> {
	let candidate = PathBuf::from(path);
	if candidate.is_absolute()
		|| candidate.components().any(|component| {
			matches!(component, Component::ParentDir | Component::RootDir | Component::Prefix(_))
		}) || path.is_empty()
	{
		return Err(ApplyFailure::Invalid(format!("unsafe patch path: {path}")));
	}
	// A patch must never touch `.git/` — doing so could overwrite hooks, the
	// index, or the objects store, giving the patch author arbitrary code
	// execution on the host. Checked per-component so `sub/.git/…` (a nested
	// repository) is rejected just like a leading `.git`.
	if candidate
		.components()
		.any(|component| is_git_store_alias(component.as_os_str()))
	{
		return Err(ApplyFailure::GitStore { path: path.to_owned() });
	}
	Ok(())
}

/// Whether HFS+ folds this codepoint away when comparing filenames.
///
/// Git's exact `core.protectHFS` set (`is_hfs_dotgit` in `utf8.c`), not the
/// `Cf` general category: `Cf` is far wider, and rejecting a path git accepts
/// breaks every later operation that rewrites an index containing it.
const fn is_hfs_ignorable(c: char) -> bool {
	matches!(
		c,
		'\u{200c}' | '\u{200d}' | '\u{200e}' | '\u{200f}'
			| '\u{202a}'..='\u{202e}'
			| '\u{206a}'..='\u{206f}'
			| '\u{feff}'
	)
}

/// Collapse `.` components and duplicate separators so two spellings of the
/// same repository path compare equal.
///
/// `validate_repo_path` has already refused `..`, absolute paths and prefixes,
/// so this only has to fold the harmless-looking forms — `./link/file` names
/// exactly the hierarchy `link/file` does.
///
/// The result is a COMPARISON KEY, never a filesystem path. It folds what the
/// filesystems a portable patch may land on fold: case (macOS and Windows
/// defaults) and canonical equivalence (macOS normalizes names, so a minted
/// `é` and a later `e◌́/file` are one entry). Over-folding can only refuse
/// MORE descendants of a minted link, never fewer.
///
/// xutf has normalization but only ASCII case folding. Decompose first, then
/// use scalar lower/upper/lower mappings to merge Unicode case variants and
/// expansions (including final sigma and sharp S), and compose the key again.
/// This deliberately over-folds some names; it is only used to refuse unsafe
/// topology, never to authorize removal or to open a filesystem path.
///
/// HFS-ignorable codepoints drop out entirely. [`is_hfs_ignorable`] already
/// names the set HFS+ folds away when comparing filenames, and
/// [`validate_repo_path`] uses it to catch `.gi\u{200c}t`. The same set has to
/// leave the comparison key, or `link -> .git` and a later
/// `l\u{200c}ink/config` are one entry on disk and two distinct keys here —
/// the link is written first and the content write follows it into the store.
fn normalize_repo_path(rel: &str) -> String {
	let mut normalized = String::with_capacity(rel.len());
	for segment in rel
		.split(['/', '\\'])
		.filter(|segment| !segment.is_empty() && *segment != ".")
	{
		if !normalized.is_empty() {
			normalized.push('/');
		}
		normalized.push_str(segment);
	}
	let decomposed = xutf::IntoUnicodeNormalized::into_nfd(normalized);
	let folded: String = decomposed
		.chars()
		.filter(|c| !is_hfs_ignorable(*c))
		.flat_map(char::to_lowercase)
		.flat_map(char::to_uppercase)
		.flat_map(char::to_lowercase)
		.collect();
	xutf::IntoUnicodeNormalized::into_nfc(folded)
}

/// Refuse proper descendants of links in the resulting topology, and every
/// entry that collides with a link's key. Normalized names are comparison
/// keys, never filesystem paths.
///
/// The key equality case is not redundant with the ancestor walk. A tree
/// authored on a case-sensitive filesystem may hold outbound symlink `Link`
/// and regular file `link`; they are two entries there and ONE entry on a
/// case-insensitive target, where the writer creates the link first and the
/// regular write then follows it.
///
/// Exactly one entry may carry a key: the one that OWNS it, meaning the link
/// whose insertion created it. Exempting links as a class instead would admit
/// `Link -> x` alongside `link -> y`, where the second write replaces the
/// first filesystem entry while HEAD and the index still name both — a
/// cherry-pick that reports success against a worktree that does not match.
fn assert_key_free(path: &str, links: &FastHashSet<String>, owns_key: bool) -> Result<()> {
	if has_normalized_ancestor_in(path, links)
		|| (!owns_key && links.contains(&normalize_repo_path(path)))
	{
		return Err(Error::PathEscapesRoot { path: path.to_owned() });
	}
	Ok(())
}

/// Claim `path`'s normalized key, refusing a second entry that wants it.
///
/// Ownership is established by INSERTION: the first entry to claim a key keeps
/// it, and any later entry collides. Used both for link keys during the patch
/// preflight and for whole-tree uniqueness in the worktree-map preflight,
/// where two regular names folding together are equally a lossy write.
fn claim_key(path: &str, keys: &mut FastHashSet<String>) -> Result<()> {
	if !keys.insert(normalize_repo_path(path)) {
		return Err(Error::PathEscapesRoot { path: path.to_owned() });
	}
	Ok(())
}

/// Entries the removal pass will take out before anything is written, with
/// their filesystem identities resolved ONCE.
///
/// Whether a proper ancestor of a path names the same filesystem entry as a
/// removed one is judged by the FILESYSTEM, not by string rules. Neither
/// string strategy is right on its own. Folding case and Unicode form says
/// `Link` covers `link` and NFC `é` covers NFD `é`, which is true on the
/// default macOS filesystem and false on a case-sensitive Linux one: there,
/// removing `Link` leaves an untracked outbound `link` in place, and skipping
/// containment lets the child resolve through it after HEAD has moved. Exact
/// comparison says the opposite and refuses a safe macOS pick. The only
/// authority on whether two spellings are one entry is the filesystem itself,
/// so each candidate ancestor is compared against the removed entries by
/// identity — same device and inode — rather than by name.
///
/// Identity is necessary, not sufficient. Unix permits hard links to symlinks
/// (`ln -P Link link`), and then two DISTINCT directory entries share one
/// inode while unlinking either leaves the other in place. So a match also
/// requires the inode to have exactly one name: with `nlink > 1` the removed
/// spelling and the candidate ancestor may be separate entries, the removal
/// cannot be assumed to take the ancestor with it, and the caller falls back
/// to judging the ancestor as it stands. That is the conservative side —
/// a hard-linked entry that IS the same spelling still matches textually.
///
/// Built once per preflight. Resolving the removed set inside the per-path
/// query made a transition with A additions and R removals cost O(A×R)
/// metadata calls; the identities are fixed for the duration of the check,
/// so they are read once here, and each ancestor prefix a query touches is
/// stat'ed at most once across the whole pass.
struct RemovedEntries<'a> {
	names:      FastHashSet<&'a str>,
	root:       &'a Path,
	identities: FastHashSet<(u64, u64)>,
	/// Prefix -> identity, memoised across queries. `None` records a prefix
	/// that is absent or hard-linked so it is not stat'ed again either.
	seen:       RefCell<FastHashMap<&'a str, Option<(u64, u64)>>>,
}

impl<'a> RemovedEntries<'a> {
	fn new(root: &'a Path, names: impl IntoIterator<Item = &'a str>) -> Self {
		let mut entries = Self {
			names: FastHashSet::default(),
			root,
			identities: FastHashSet::default(),
			seen: RefCell::new(FastHashMap::default()),
		};
		for name in names {
			entries.insert(name);
		}
		entries
	}

	/// Record one more removed name, resolving its identity exactly once.
	///
	/// Lets the patch preflight grow the set in write order: each source joins
	/// after its removal is validated and before its target is checked.
	fn insert(&mut self, name: &'a str) {
		if self.names.insert(name)
			&& let Some(id) = entry_identity(self.root, name)
		{
			self.identities.insert(id);
		}
	}

	/// Whether a PROPER ancestor of `path` is removed — by name, or by being
	/// the same single-named filesystem entry as a removed name.
	fn covers_ancestor_of(&self, path: &'a str) -> bool {
		if self.names.is_empty() {
			return false;
		}
		let mut prefix = path;
		while let Some(cut) = prefix.rfind('/') {
			prefix = &prefix[..cut];
			// A textual match is sufficient: the entry is named for removal as-is.
			if self.names.contains(prefix) {
				return true;
			}
			if self.identities.is_empty() {
				continue;
			}
			// Otherwise the spelling differs; only the filesystem can say whether
			// it is still the same entry — and only when that entry has one name.
			let id = *self
				.seen
				.borrow_mut()
				.entry(prefix)
				.or_insert_with(|| entry_identity(self.root, prefix));
			if id.is_some_and(|id| self.identities.contains(&id)) {
				return true;
			}
		}
		false
	}
}

/// `(dev, ino)` of `rel` when it exists and has exactly one directory entry.
fn entry_identity(root: &Path, rel: &str) -> Option<(u64, u64)> {
	let meta = std::fs::symlink_metadata(root.join(rel)).ok()?;
	(meta.nlink() == 1).then_some((meta.dev(), meta.ino()))
}

/// Whether any PROPER ancestor of `path` is in `set`, comparing by the same
/// filesystem-normalized key [`normalize_repo_path`] produces.
///
/// Every set consulted for topology — links a write will create, entries a
/// write will remove first — must be built with that key too, or an NFD
/// spelling in one map and an NFC spelling in the other name the same
/// directory and never match.
fn has_normalized_ancestor_in(path: &str, set: &FastHashSet<String>) -> bool {
	if set.is_empty() {
		return false;
	}
	let normalized = normalize_repo_path(path);
	let mut prefix = normalized.as_str();
	while let Some(cut) = prefix.rfind('/') {
		prefix = &prefix[..cut];
		if set.contains(prefix) {
			return true;
		}
	}
	false
}

/// Mode of `rel` as it exists in the worktree today, if it exists at all.
///
/// Used to infer a mode the patch does not state — a 100% rename omits the
/// mode headers entirely, and application resolves it from the source entry.
///
/// The answer is the COMPLETE mode, not merely "symlink or not". A regular
/// source is `Some(FILE)`, and that is what stops the caller from consulting
/// the target: `worktree_entry_mode(a) == None` must mean `a` is absent, or a
/// tracked regular `a` renamed onto an untracked `b -> .git/config` would be
/// judged by the symlink at `b` and pass with a prefix check while the write
/// follows `b` into the store.
fn worktree_entry_mode(repo: &GitRepo, rel: &str) -> Option<Mode> {
	let metadata = std::fs::symlink_metadata(repo.root().join(rel)).ok()?;
	let file_type = metadata.file_type();
	if file_type.is_symlink() {
		Some(Mode::SYMLINK)
	} else if file_type.is_dir() {
		Some(Mode::DIR)
	} else {
		Some(worktree_file_mode(&metadata, Mode::FILE))
	}
}

/// Mode a mode-less patch entry will be written with.
///
/// Mirrors [`apply_patches_to_map`]: the declared mode wins, then the SOURCE
/// entry's mode. The target is consulted only when there is no source at all
/// (a mode-less update of an existing entry), never as a fallback for a source
/// that exists — the source decides what the write does, and the target is
/// exactly what an attacker controls.
fn inferred_target_mode(
	repo: &GitRepo,
	declared: Option<Mode>,
	source: Option<&str>,
	target: &str,
) -> Option<Mode> {
	if let Some(mode) = declared {
		return Some(mode);
	}
	match source {
		Some(source) => worktree_entry_mode(repo, source),
		None => worktree_entry_mode(repo, target),
	}
}

/// Refuse a staged path that lands in a live Git store, by LOCATION.
///
/// `--cached` writes only the index, so nothing is resolved through a symlink
/// and the worktree preflight does not apply. What still applies is the store:
/// `write_index_map_at` validates `.git` by NAME only, so after
/// `git init --separate-git-dir=meta .` a patch staging `meta/hooks/pre-commit`
/// is accepted, and the next checkout or reset materializes that entry over
/// the live hook. Both sides are judged — a staged deletion of a store path is
/// equally a store mutation.
fn assert_cached_targets_outside_store(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	patches: &[FilePatch],
	reverse: bool,
) -> Result<()> {
	for patch in patches {
		let (source, target, ..) = patch_sides(patch, reverse);
		for path in [source, target].into_iter().flatten() {
			validate_repo_path(path).map_err(ApplyFailure::into_error)?;
			// The leaf is never opened — only an index entry is written — so
			// the prefix policy is the one that matches the operation.
			assert_prefix_outside_git_store(repo, gix_repo, path)?;
			// But the leaf can BE the store. With the git directory at exactly
			// `meta`, staging a blob at `meta` compares only its parent — the
			// worktree root — and passes, and a later checkout or
			// `reset --hard` tries to materialize that blob over the store.
			// The spelling settles it without resolving an alias.
			assert_spelling_outside_git_store(repo, gix_repo, path)?;
		}
	}
	Ok(())
}

/// Validate every path a patch would touch, before any of them is touched.
///
/// Mirrors exactly what [`write_patch_worktree`] will do per side: a source
/// that is only unlinked is checked with the prefix guard, a target that is
/// opened for writing with the full guard. Keeping the two in step is what
/// makes the preflight meaningful — a rule enforced here but not there would
/// reject a valid patch, and one enforced there but not here would reopen the
/// partial-write window this exists to close.
fn assert_patch_paths_contained(
	repo: &GitRepo,
	patches: &[FilePatch],
	reverse: bool,
) -> Result<()> {
	let gix_repo = repo.gix()?;
	assert_plan_contained(repo, &gix_repo, patch_plan(repo, patches, reverse))
}

/// Refuse a path that lands inside the repository's ACTUAL Git store.
///
/// [`validate_repo_path`] rejects components *named* `.git` under any spelling
/// a filesystem accepts, which covers the ordinary layout and nested
/// repositories. It cannot cover a store that does not carry that name: after
/// `git init --separate-git-dir=meta .` the worktree holds a `.git` FILE
/// pointing at `meta/`, and `meta/hooks/pre-commit` is both a real hook and an
/// unremarkable-looking path inside the root. Worktrees created by
/// `git worktree add` have the same shape, with `common_dir` naming the shared
/// store the linked one borrows objects and hooks from.
///
/// So the store is refused by LOCATION as well as by name — canonicalized, so
/// a symlinked or relative spelling cannot dodge the comparison.
fn assert_outside_git_store(repo: &GitRepo, gix_repo: &gix::Repository, rel: &str) -> Result<()> {
	assert_store_containment(repo, gix_repo, rel, LeafPolicy::Resolve)
}

/// Whether the leaf itself is opened, or only unlinked and recreated.
#[derive(Clone, Copy, PartialEq, Eq)]
enum LeafPolicy {
	/// The leaf is opened through: resolve it.
	Resolve,
	/// The leaf is unlinked or recreated, never followed: judge its prefix.
	Prefix,
	/// An ancestor is already scheduled for unlink, so the prefix as it stands
	/// today does not survive into the write: judge the SPELLING only.
	Spelling,
}

/// Refuse a path whose spelling lands in the git store, resolving nothing.
///
/// For a target under an ancestor an earlier entry unlinks. Resolving that
/// ancestor asks about a topology the write never sees: a doomed
/// `dir -> .git` would make a safe `dir/file` look like a write into the
/// store, and both apply and probe would refuse an operation git accepts.
/// The spelling still has to be judged, or a patch could delete `meta` and
/// write `meta/hooks/pre-commit` beneath the store it just unlinked.
fn assert_spelling_outside_git_store(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	rel: &str,
) -> Result<()> {
	assert_store_containment(repo, gix_repo, rel, LeafPolicy::Spelling)
}

/// Refuse a path whose PREFIX lands in the git store, leaving the leaf alone.
///
/// Deleting an entry, or replacing a symlink, cannot reach through the leaf —
/// `remove_file` unlinks the directory entry and `symlink` creates a new one.
/// Resolving it would refuse a tracked symlink that happens to point into the
/// store, which is a link the repository is entitled to delete.
fn assert_prefix_outside_git_store(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	rel: &str,
) -> Result<()> {
	assert_store_containment(repo, gix_repo, rel, LeafPolicy::Prefix)
}

fn assert_store_containment(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	rel: &str,
	leaf: LeafPolicy,
) -> Result<()> {
	let joined = repo.root().join(rel);
	let candidate = if leaf == LeafPolicy::Prefix {
		match joined.parent() {
			Some(parent) => parent.to_path_buf(),
			// No parent means the join produced the root, which is not a store.
			None => return Ok(()),
		}
	} else {
		joined
	};
	// Two comparisons, because resolution can move a path OUT of a store it is
	// spelled inside. With the store at `meta` and `meta/hooks -> ../hookdir`,
	// `meta/hooks/pre-commit` canonicalizes to `<root>/hookdir/pre-commit`,
	// which no longer starts with `<root>/meta` — yet git runs that hook
	// through the same link. So the UNRESOLVED spelling, canonicalized only at
	// the root, is judged as well.
	let root_canonical =
		std::fs::canonicalize(repo.root()).unwrap_or_else(|_| repo.root().to_path_buf());
	let unresolved = candidate
		.strip_prefix(repo.root())
		.map_or_else(|_| candidate.clone(), |tail| root_canonical.join(tail));
	// Resolution catches the other direction — an alias that leads INTO a store
	// under a name that does not spell it. It is skipped for `Spelling`, where
	// an ancestor is already scheduled for unlink: resolving it would judge a
	// topology the write never sees and refuse a safe operation.
	let resolved = if leaf == LeafPolicy::Spelling {
		unresolved.clone()
	} else {
		// The candidate usually does not exist yet, so resolve the deepest
		// existing ancestor: a store lives in directories that do exist.
		let mut probe = candidate.as_path();
		loop {
			if let Ok(canonical) = std::fs::canonicalize(probe) {
				// Re-attach the unresolved tail so `meta/hooks/pre-commit` is
				// still compared as a path under `meta`, not just as `meta`.
				let tail = candidate.strip_prefix(probe).unwrap_or(Path::new(""));
				break canonical.join(tail);
			}
			match probe.parent() {
				Some(parent) if parent != probe => probe = parent,
				// Nothing along the path exists: only the spelling can be judged.
				_ => break unresolved.clone(),
			}
		}
	};
	let inside = |store: &Path| unresolved.starts_with(store) || resolved.starts_with(store);
	for store in [gix_repo.git_dir(), gix_repo.common_dir()] {
		let store = std::fs::canonicalize(store).unwrap_or_else(|_| store.to_path_buf());
		if inside(&store) {
			return Err(Error::PathInGitStore { path: rel.to_owned() });
		}
	}
	// A NESTED repository may keep its store anywhere — `git init
	// --separate-git-dir=nested-meta sub` leaves a live store with no `.git`
	// component, and it is a SIBLING of `sub` rather than a descendant, so
	// walking the candidate's ancestors never finds it. Every `.git` FILE under
	// the root names one; each is followed and the candidate compared against
	// its target.
	let scan = nested_stores(repo);
	if scan.stores.iter().any(|store| inside(store)) {
		return Err(Error::PathInGitStore { path: rel.to_owned() });
	}
	// An incomplete scan is not an empty one. A traversable but unlistable
	// directory hides every store beneath it while leaving a known path inside
	// it writable, so the set above is only a lower bound and this path cannot
	// be cleared. Fail closed rather than admit an unexamined hierarchy.
	if !scan.complete {
		return Err(Error::PathInGitStore { path: rel.to_owned() });
	}
	Ok(())
}

/// Discovered stores plus whether the scan that produced them was complete.
type StoreScan = (u64, Arc<StoreSet>);

/// A scan result. `complete` is false when some directory could not be listed,
/// which makes the store set a LOWER BOUND rather than the full picture.
struct StoreSet {
	stores:   Vec<PathBuf>,
	complete: bool,
}

/// Every nested repository store under `repo`'s root.
///
/// Discovery is a directory walk and the containment guards run per affected
/// path, so a thousand-file change would otherwise repeat the same traversal a
/// thousand times. It is therefore cached — but only for the CURRENT
/// operation: a process-global cache in a long-lived agent would never see a
/// nested repository created after its first scan, and an untrusted patch
/// could then reach that store's hooks. [`begin_operation`] invalidates it.
///
/// Keyed by root, one slot per repository. Mutations on different
/// repositories are allowed to interleave — the envd lock serializes by
/// `common_dir`, not globally — and a single shared slot would be evicted by
/// the other root on every path check, recreating the per-path rescan the
/// cache exists to remove. Entries from earlier operations are dropped on the
/// next insert, so the map never outgrows the set of live roots.
fn nested_stores(repo: &GitRepo) -> Arc<StoreSet> {
	// Per-root discovery results stamped with their scan generation. Lookup,
	// retention and insertion only — no ordering — so this is the mandated
	// discretionary-cache map, not a tree.
	static CACHE: LazyLock<Mutex<FastHashMap<PathBuf, StoreScan>>> =
		LazyLock::new(|| Mutex::new(FastHashMap::default()));

	let root = repo.root();
	let generation = OPERATION.load(Ordering::Acquire);
	{
		let cache = CACHE.lock();
		if let Some((stamp, found)) = cache.get(root)
			&& *stamp == generation
		{
			return Arc::clone(found);
		}
	}
	let mut stores = Vec::new();
	let complete = collect_nested_stores(root, &mut stores);
	let found = Arc::new(StoreSet { stores, complete });
	let mut cache = CACHE.lock();
	publish_store_scan(&mut cache, root, generation, OPERATION.load(Ordering::Acquire), &found);
	found
}

/// Called under the cache lock, after sampling the current operation stamp.
fn publish_store_scan(
	cache: &mut FastHashMap<PathBuf, StoreScan>,
	root: &Path,
	generation: u64,
	current: u64,
	found: &Arc<StoreSet>,
) {
	// A later operation may have published while this scan ran unlocked.
	if current != generation {
		return;
	}
	cache.retain(|_, (stamp, _)| *stamp == generation);
	cache.insert(root.to_path_buf(), (generation, Arc::clone(found)));
}

/// Monotonic operation stamp; bumping it invalidates [`nested_stores`].
static OPERATION: AtomicU64 = AtomicU64::new(0);

/// Open a new operation, so store discovery is redone rather than reused.
///
/// Called by every entry point that applies or restores changes. Discovery
/// within one operation is still a single walk; across operations it is never
/// stale, which is what a long-lived agent needs.
fn begin_operation() {
	OPERATION.fetch_add(1, Ordering::AcqRel);
}

/// Walk `dir` for nested stores, recording every directory git treats as one.
///
/// Unbounded by depth: a cap is a hole, since `a/b/c/sub/.git` pointing at
/// `deep-meta` is as live a store as one at the root. The cost is paid once per
/// operation — see [`nested_stores`] — not once per path.
///
/// Returns `false` when any directory could not be listed. A traversable but
/// unlistable directory (mode `0300`) hides every store beneath it while a
/// known path like `secret/meta/hooks/pre-commit` stays writable, so an
/// incomplete scan must not be mistaken for an empty one — the caller turns
/// that into a refusal rather than admitting the path.
fn collect_nested_stores(dir: &Path, found: &mut Vec<PathBuf>) -> bool {
	let Ok(entries) = std::fs::read_dir(dir) else {
		return false;
	};
	let mut complete = true;
	for entry in entries.map(scan_item) {
		// `ReadDir` opens fine and then fails mid-walk on a FUSE or NFS
		// worktree. Dropping that item — what `flatten()` did — hides every
		// store below it while leaving `complete` true, so a containment check
		// would clear a path against a set that silently lost entries.
		let Some(entry) = entry else {
			complete = false;
			continue;
		};
		let path = entry.path();
		let Ok(kind) = entry.file_type() else {
			complete = false;
			continue;
		};

		// A `.git` FILE points at a store. For a LINKED worktree it points at
		// `…/worktrees/<name>`, which is only half the story: git reads
		// `commondir` from there and uses the parent as its common store, so
		// `meta/hooks/pre-commit` is live even though the pointer never names
		// `meta`. Record both — but only once the target has proved to BE a
		// store, see [`gitfile_stores`].
		if kind.is_file() && path.file_name().is_some_and(|name| name == ".git") {
			if let Some(bytes) = read_store_metadata(&path)
				&& let Ok(target) = gix::discover::parse::gitdir(&bytes)
			{
				found.extend(gitfile_stores(&canonical_or_self(&dir.join(target))));
			}
			continue;
		}
		if !kind.is_dir() {
			continue;
		}
		// A BARE repository has no `.git` file at all — `git init --bare bare`
		// leaves the store itself on disk, hooks included, under an arbitrary
		// name. Require a parseable HEAD, not merely familiar directory names.
		if is_bare_store(&path) {
			found.push(canonical_or_self(&path));
			continue;
		}
		// Do not descend through links: a nested store does not live behind one,
		// and following it would leave the worktree.
		if !collect_nested_stores(&path, found) {
			complete = false;
		}
	}
	complete
}

/// One `ReadDir` item, or `None` when the walk could not produce it.
///
/// Split out because the failure is the interesting half and it cannot be
/// provoked through permissions on every filesystem: a directory that cannot
/// be read usually fails at `read_dir`, while FUSE and NFS surface EIO on the
/// ITEM. `None` means the scan has lost an entry and is no longer a complete
/// picture of the tree — never that the directory held nothing there.
fn scan_item(entry: std::io::Result<fs::DirEntry>) -> Option<fs::DirEntry> {
	entry.ok()
}
fn canonical_or_self(path: &Path) -> PathBuf {
	std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// The store(s) a gitfile target stands for, or nothing when the target is
/// not a Git directory at all.
///
/// The directive is untrusted worktree content. A stale or ordinary `sub/.git`
/// reading `gitdir: ../docs` must not turn `docs/` into a protected store that
/// every later patch, cherry-pick and stash write refuses with
/// `PathInGitStore` — git itself cannot open `sub` as a repository through
/// it. So the target is admitted only with the layout git requires to open
/// it: a valid loose `HEAD`, and `objects/` + `refs/` either in the target
/// (a separate or bare store) or in the `commondir` it names (a linked
/// worktree). When `commondir` is present it is validated too; a gitdir whose
/// common store is missing is not one git would open either.
fn gitfile_stores(store: &Path) -> Vec<PathBuf> {
	if !has_valid_loose_head(store) {
		return Vec::new();
	}
	match fs::symlink_metadata(store.join("commondir")) {
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
			if has_object_and_ref_dirs(store) {
				vec![store.to_path_buf()]
			} else {
				Vec::new()
			}
		},
		Err(_) => Vec::new(),
		Ok(_) => {
			let Some(common) = read_store_metadata(&store.join("commondir")) else {
				return Vec::new();
			};
			let common = common.trim_end();
			if common.is_empty() {
				return Vec::new();
			}
			let Ok(common) = gix::path::try_from_bstr(common.as_bstr()) else {
				return Vec::new();
			};
			let common = canonical_or_self(&store.join(common));
			if has_object_and_ref_dirs(&common) {
				vec![common, store.to_path_buf()]
			} else {
				Vec::new()
			}
		},
	}
}

/// Recognize a store by Git's directory layout and a valid loose HEAD, without
/// opening a repository (which would read arbitrary configuration/includes).
fn is_bare_store(dir: &Path) -> bool {
	has_object_and_ref_dirs(dir) && has_valid_loose_head(dir)
}

fn has_object_and_ref_dirs(dir: &Path) -> bool {
	dir.join("objects").is_dir() && dir.join("refs").is_dir()
}

/// Whether `dir/HEAD` parses as a loose reference — the one file every Git
/// directory, bare, separate or per-worktree, must carry.
fn has_valid_loose_head(dir: &Path) -> bool {
	let Some(head) = read_store_metadata(&dir.join("HEAD")) else {
		return false;
	};
	let Ok(name) = gix::refs::FullName::try_from("HEAD") else {
		return false;
	};
	let hex_len = head
		.iter()
		.take_while(|byte| byte.is_ascii_hexdigit())
		.count();
	let Some(hash) = gix::hash::Kind::from_hex_len(hex_len) else {
		return false;
	};
	gix::refs::file::loose::Reference::try_from_path(name, &head, hash).is_ok()
}

/// Metadata discovered in a worktree is untrusted: never follow a metadata
/// symlink, open a special file, or read an unlimited directive/reference.
fn read_store_metadata(path: &Path) -> Option<Vec<u8>> {
	use std::io::Read as _;

	const LIMIT: u64 = 64 * 1024;
	let metadata = fs::symlink_metadata(path).ok()?;
	if !metadata.is_file() || metadata.len() > LIMIT {
		return None;
	}
	let mut options = fs::OpenOptions::new();
	options.read(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt as _;
		// Also prevent a swapped symlink/FIFO from following or blocking at open.
		options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
	}
	let file = options.open(path).ok()?;
	let metadata = file.metadata().ok()?;
	if !metadata.is_file() || metadata.len() > LIMIT {
		return None;
	}
	let mut bytes = Vec::new();
	file.take(LIMIT + 1).read_to_end(&mut bytes).ok()?;
	(bytes.len() as u64 <= LIMIT).then_some(bytes)
}

/// Refuse any indexed path whose PREFIX leaves the worktree, before a caller
/// reads those paths off disk.
///
/// The leaf is deliberately not resolved: it is the file about to be read, and
/// whether it is itself an outbound link is the write-side question. What this
/// stops is reading THROUGH an escaping directory prefix.
fn assert_indexed_prefixes_contained(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	index: &BTreeMap<String, FileEntry>,
) -> Result<()> {
	for path in index.keys() {
		validate_repo_path(path).map_err(ApplyFailure::into_error)?;
		assert_prefix_within_root(repo.root(), path)?;
		assert_prefix_outside_git_store(repo, gix_repo, path)?;
	}
	Ok(())
}

/// Validate every path a worktree-map write would remove or create.
///
/// Split out of [`write_worktree_map`] because some callers advance repository
/// state BEFORE writing: `cherry_pick` runs `commit_as`, moving HEAD, and only
/// then writes the worktree. A refusal discovered during the write would leave
/// HEAD ahead of an index and worktree that never received the change —
/// exactly the fail-clean contract those operations document. Such callers run
/// this first, while the refusal is still free.
fn assert_worktree_map_contained(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	previous: &BTreeMap<String, FileEntry>,
	next: &BTreeMap<String, FileEntry>,
) -> Result<()> {
	// Whole-tree key uniqueness FIRST, over every entry in the result — not
	// only the ones the plan writes. An unchanged entry already on disk is
	// never written, so it is absent from the plan, but it still occupies its
	// key: regular `A` unchanged plus a new `a` collide on a case-insensitive
	// worktree exactly as two new entries would, and `cherry_pick` has already
	// advanced HEAD by then. A git tree holds files, symlinks and submodules
	// but never directories, so an entry whose key is the proper ancestor of
	// another is equally a conflict — `A` with `a/file` fails partway through
	// the checkout.
	let mut keys: FastHashSet<String> = FastHashSet::default();
	for path in next.keys() {
		validate_repo_path(path).map_err(ApplyFailure::into_error)?;
		claim_key(path, &mut keys)?;
	}
	for path in next.keys() {
		assert_key_free(path, &keys, true)?;
	}
	// Then the ordered plan: removals, then the writes that actually happen.
	assert_plan_contained(repo, gix_repo, map_plan(repo, previous, next))
}

/// One filesystem step a write pass will take, in the order it takes it.
///
/// The three writers — [`write_patch_worktree`], [`write_worktree_map`] and
/// the untracked half of `stash_try_pop` — reduce to exactly two primitives:
/// [`remove_worktree_path`] and [`write_worktree_entry`]. Naming that sequence
/// is what lets one validator judge all three: before this existed, each
/// preflight re-simulated its writer by hand, and every divergence between the
/// two models was a bug. Three quarters of the review findings on this branch
/// came from that duplication, including rules that landed in one preflight
/// and were missed in the other two.
#[derive(Clone, Copy)]
enum PlanStep<'a> {
	/// `remove_worktree_path`: unlinks the entry, never follows the leaf.
	Remove { path: &'a str },
	/// `write_worktree_entry`: creates the leaf, opening through it unless the
	/// entry is a symlink, which is unlinked and recreated instead.
	Write { path: &'a str, mode: Mode },
}

impl<'a> PlanStep<'a> {
	const fn path(self) -> &'a str {
		match self {
			Self::Remove { path } | Self::Write { path, .. } => path,
		}
	}
}

/// Judge an ordered write plan before its first step runs.
///
/// Every rule the preflights used to carry separately, applied once:
///
/// - **Shape.** Every path is validated, removals included.
/// - **Key ownership.** Each written path claims its normalized key; a removed
///   path releases the key it held. Two entries folding onto one filesystem
///   entry is a lossy write, whether both are regular files or one is a link.
/// - **Minted links.** A path written as a symlink shadows everything under its
///   key for every LATER step, which the current filesystem cannot show.
/// - **Doomed ancestors.** A path under something an EARLIER step unlinks is
///   judged by spelling: resolving it asks about a topology the write never
///   sees.
/// - **Leaf policy.** A removal and a symlink write never follow the leaf; a
///   content write does. Mirrors the write site exactly.
fn assert_plan_contained<'a>(
	repo: &GitRepo,
	gix_repo: &gix::Repository,
	plan: impl IntoIterator<Item = PlanStep<'a>>,
) -> Result<()> {
	let mut minted_links: FastHashSet<String> = FastHashSet::default();
	let mut claimed: FastHashSet<String> = FastHashSet::default();
	let mut removed = RemovedEntries::new(repo.root(), std::iter::empty());
	for step in plan {
		let path = step.path();
		validate_repo_path(path).map_err(ApplyFailure::into_error)?;
		match step {
			PlanStep::Remove { path } => {
				assert_key_free(path, &minted_links, false)?;
				// The entry is gone after this step: its key is free for a
				// later write, and its subtree no longer resolves through it.
				claimed.remove(&normalize_repo_path(path));
				assert_prefix_within_root(repo.root(), path)?;
				assert_prefix_outside_git_store(repo, gix_repo, path)?;
				removed.insert(path);
			},
			PlanStep::Write { path, mode } => {
				let is_link = mode == Mode::SYMLINK;
				assert_key_free(path, &minted_links, is_link)?;
				claim_key(path, &mut claimed)?;
				if removed.covers_ancestor_of(path) {
					assert_spelling_outside_git_store(repo, gix_repo, path)?;
				} else if is_link {
					assert_prefix_within_root(repo.root(), path)?;
					assert_prefix_outside_git_store(repo, gix_repo, path)?;
				} else {
					assert_within_root(repo.root(), path)?;
					assert_outside_git_store(repo, gix_repo, path)?;
				}
				if is_link {
					minted_links.insert(normalize_repo_path(path));
				}
			},
		}
	}
	Ok(())
}

/// The plan [`write_patch_worktree`] will execute: each entry's source is
/// unlinked, then its target written, in patch order.
fn patch_plan<'a>(repo: &GitRepo, patches: &'a [FilePatch], reverse: bool) -> Vec<PlanStep<'a>> {
	let mut plan = Vec::new();
	for patch in patches {
		let (source, target, _, declared_mode) = patch_sides(patch, reverse);
		if let Some(source) = source
			&& target != Some(source)
		{
			plan.push(PlanStep::Remove { path: source });
		}
		if let Some(target) = target {
			// A 100% rename carries no mode header and application inherits
			// the source's mode, so the plan has to infer it the same way or
			// it misses a link this patch is about to mint.
			let mode = inferred_target_mode(repo, declared_mode, source, target).unwrap_or(Mode::FILE);
			plan.push(PlanStep::Write { path: target, mode });
		}
	}
	plan
}

/// The plan [`write_worktree_map`] will execute: every entry `previous` holds
/// and `next` does not is unlinked, then every changed entry is written.
fn map_plan<'a>(
	repo: &GitRepo,
	previous: &'a BTreeMap<String, FileEntry>,
	next: &'a BTreeMap<String, FileEntry>,
) -> Vec<PlanStep<'a>> {
	let mut plan = Vec::new();
	for path in previous.keys() {
		if !next.contains_key(path) {
			plan.push(PlanStep::Remove { path });
		}
	}
	for (path, entry) in next {
		// Exactly the predicate the write loop uses: an unchanged path that is
		// already on disk is never touched, so validating what it resolves
		// through would fail an operation for a path it will not write.
		if previous.get(path) != Some(entry) || !repo.root().join(path).exists() {
			plan.push(PlanStep::Write { path, mode: entry.mode });
		}
	}
	plan
}

/// Whether a single path component names the Git store under any spelling a
/// filesystem may accept for it.
///
/// Git itself refuses these same aliases when checking out a tree (see
/// `is_ntfs_dotgit` and the `core.protectNTFS`/`core.protectHFS` defaults);
/// this mirrors that rule for patch application.
fn is_git_store_alias(component: &std::ffi::OsStr) -> bool {
	let Some(name) = component.to_str() else {
		// A non-UTF-8 component cannot spell `.git` in any of the forms
		// below, and `validate_repo_path` has already rejected traversal.
		return false;
	};
	// HFS+ treats a specific set of codepoints as invisible when comparing
	// names, so `.\u{200c}git` opens the real `.git`; git refuses those
	// spellings under `core.protectHFS`.
	//
	// It must be git's EXACT set, not the whole `Cf` general category. Folding
	// more is not the safe direction it looks like: `.g\u{2060}it/file` is a
	// path git accepts, and refusing it fails every later operation that
	// rewrites an index containing it — an unrelated cherry-pick included.
	// Verified against `git update-index`: U+200C and U+206F are rejected by
	// git, U+2060 is accepted.
	let folded: String = name.chars().filter(|c| !is_hfs_ignorable(*c)).collect();
	let name = folded.as_str();
	// NTFS reaches a directory through its alternate-stream syntax, so
	// `.git::$INDEX_ALLOCATION` and `.git:x` open the same store. Cut at the
	// first colon before anything else: the stream suffix survives the
	// dot/space trim below and would otherwise carry the name past every
	// comparison.
	let name = name.split(':').next().unwrap_or(name);
	// NTFS and HFS+ then ignore trailing dots and spaces, so `.git.`, `.git `
	// and `git~1.` all reach the store too. Compare the trimmed spelling
	// against BOTH protected names: checking only `.git` lets
	// `sub/git~1./hooks/pre-commit` through, and a nested store is invisible to
	// `assert_outside_git_store`, which only knows the outer one.
	let trimmed = name.trim_end_matches(['.', ' ']);
	trimmed.eq_ignore_ascii_case(".git") || trimmed.eq_ignore_ascii_case("git~1")
}

/// Refuse a path that would leave the worktree once symlinks are resolved.
///
/// The leaf is resolved too, so this is the guard for anything that OPENS the
/// path — writing a file, creating a directory. To delete an entry, use
/// [`assert_prefix_within_root`]: unlinking does not follow the leaf, and
/// resolving it would reject legitimately tracked symlinks.
///
/// THREAT MODEL. The check is not atomic with the write that follows it: a
/// symlink planted into the prefix between the two would still be followed.
/// Closing that window needs `openat`/`O_NOFOLLOW` descriptor-relative writes,
/// which the surrounding code does not use. It is accepted here because a
/// worktree is operated by a single agent at a time — an attacker able to
/// plant directories mid-apply already has write access to the workspace and
/// does not need a patch to exercise it. What this guard does stop is the
/// untrusted PATCH TEXT, which is the actual attacker-controlled input.
fn assert_within_root(root: &Path, rel: &str) -> Result<()> {
	assert_contained(root, rel, root.join(rel).as_path())
}

/// Refuse a path whose PREFIX would leave the worktree, ignoring the leaf.
///
/// For deletion: `remove_file` unlinks a directory entry without following it,
/// so a tracked symlink whose target is outside the worktree (or dangling) is
/// both safe to remove and must stay removable.
fn assert_prefix_within_root(root: &Path, rel: &str) -> Result<()> {
	let absolute = root.join(rel);
	// No parent means the join produced the root itself, which is contained by
	// definition; `validate_repo_path` has already refused empty and absolute
	// paths, so this cannot be an escape.
	let Some(parent) = absolute.parent() else {
		return Ok(());
	};
	assert_contained(root, rel, parent)
}

/// Walk `probe` up to the deepest existing ancestor and require it to resolve
/// inside `root`. `rel` names the original path for the error message.
fn assert_contained(root: &Path, rel: &str, probe: &Path) -> Result<()> {
	// Resolve the deepest existing ancestor against a canonicalized root so a
	// symlinked directory (macOS /var -> /private/var, or a hostile symlink
	// planted inside the root) is resolved consistently — a nonexistent leaf
	// must not be compared unresolved against a resolved root, which would
	// false-positive on symlinked prefixes.
	let root_canonical = std::fs::canonicalize(root).unwrap_or_else(|_| root.to_path_buf());
	let escaped = || Error::PathEscapesRoot { path: rel.to_owned() };
	let mut probe = probe;
	loop {
		if probe == root {
			return Ok(());
		}
		match std::fs::canonicalize(probe) {
			Ok(canonical) if canonical.starts_with(&root_canonical) => return Ok(()),
			Ok(_) => return Err(escaped()),
			// `canonicalize` fails both for a path that does not exist and for a
			// DANGLING symlink. Only the first may walk up: a dangling link is a
			// real directory entry, and the write below would follow it and land
			// at its target, outside the root.
			Err(_) => {
				if std::fs::symlink_metadata(probe).is_ok() {
					return Err(escaped());
				}
				match probe.parent() {
					Some(parent) if parent != probe => probe = parent,
					_ => return Ok(()),
				}
			},
		}
	}
}

#[cfg(test)]
mod tests {
	use std::process::Command;

	use tempfile::TempDir;

	use super::*;

	fn git(cwd: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.current_dir(cwd)
			.args(args)
			.output()
			.expect("run git");
		assert!(
			output.status.success(),
			"git {} failed: {}",
			args.join(" "),
			String::from_utf8_lossy(&output.stderr)
		);
		String::from_utf8(output.stdout).expect("git output is UTF-8")
	}
	fn git_with_index(cwd: &Path, index: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.current_dir(cwd)
			.env("GIT_INDEX_FILE", index)
			.args(args)
			.output()
			.expect("run git with alternate index");
		assert!(
			output.status.success(),
			"git {} failed: {}",
			args.join(" "),
			String::from_utf8_lossy(&output.stderr)
		);
		String::from_utf8(output.stdout).expect("git output is UTF-8")
	}

	fn init(files: &[(&str, &[u8])]) -> TempDir {
		let temp = tempfile::tempdir().expect("tempdir");
		git(temp.path(), &["init", "-q"]);
		git(temp.path(), &["config", "user.name", "Patch Test"]);
		git(temp.path(), &["config", "user.email", "patch@example.com"]);
		for (path, bytes) in files {
			let absolute = temp.path().join(path);
			if let Some(parent) = absolute.parent() {
				fs::create_dir_all(parent).expect("create parent");
			}
			fs::write(absolute, bytes).expect("write fixture");
		}
		git(temp.path(), &["add", "-A"]);
		git(temp.path(), &["commit", "-qm", "base"]);
		temp
	}

	fn repo(path: &Path) -> GitRepo {
		GitRepo::require(path).expect("discover repo")
	}

	fn reset(path: &Path) {
		git(path, &["reset", "--hard", "-q", "HEAD"]);
		git(path, &["clean", "-fdq"]);
	}

	#[test]
	fn patch_stage_hunks_stages_intent_to_add_and_preserves_unrelated_promise() {
		let temp = init(&[("base.txt", b"one\ntwo\n")]);
		fs::write(temp.path().join("picked.txt"), b"picked\n").expect("write picked");
		fs::write(temp.path().join("promised.txt"), b"promised\n").expect("write promised");
		git(temp.path(), &["add", "-N", "picked.txt", "promised.txt"]);
		fs::write(temp.path().join("base.txt"), b"one changed\ntwo\n").expect("edit base");
		let repo = repo(temp.path());
		let raw = repo.diff_text(&DiffOptions::default()).expect("diff");
		repo
			.stage_hunks(
				&[
					HunkSelection { path: "picked.txt".into(), hunks: HunkSpec::Indices(vec![1]) },
					HunkSelection { path: "base.txt".into(), hunks: HunkSpec::All },
				],
				Some(&raw),
			)
			.expect("stage hunks over intent-to-add");
		// git is the oracle: the create patch lands on the promised entry and
		// the unrelated intent-to-add flag survives the index rewrite.
		let status = git(temp.path(), &["status", "--porcelain"]);
		assert!(status.contains("A  picked.txt"), "picked.txt staged: {status}");
		assert!(status.contains("M  base.txt"), "base.txt staged: {status}");
		assert!(status.contains(" A promised.txt"), "promised.txt keeps intent-to-add: {status}");
	}

	#[test]
	fn patch_join_and_validation_preserve_binary_terminators() {
		assert_eq!(join_patches(&["one\n\n".into(), "two".into(), String::new()]), "one\n\ntwo\n\n");
		let binary = "diff --git a/a.bin b/a.bin\nindex 1111111..2222222 100644\nGIT binary \
		              patch\nliteral 1\nIc${O300000\n\n";
		let errors = validate_hunk_selections(binary, &[
			HunkSelection { path: "missing".into(), hunks: HunkSpec::Indices(vec![1]) },
			HunkSelection { path: "a.bin".into(), hunks: HunkSpec::Indices(vec![1]) },
		]);
		assert_eq!(errors.len(), 1);
		assert_eq!(errors[0].path, "a.bin");
	}

	#[test]
	fn patch_apply_matches_git_for_text_binary_mode_rename_and_no_eof() {
		let binary: Vec<u8> = (0_u8..=255).cycle().take(4096).collect();
		let files: Vec<(&str, &[u8])> = vec![
			("text.txt", b"alpha\nbeta\ngamma\n"),
			("old.txt", b"rename body\nsecond\n"),
			("noeof.txt", b"before"),
			("script.sh", b"#!/bin/sh\necho hi\n"),
			("data.bin", &binary),
			("deleted.txt", b"delete this unique file\n"),
		];
		let ours = init(&files);
		let oracle = init(&files);
		fs::write(ours.path().join("text.txt"), b"alpha\nBETA\ngamma\n").expect("edit text");
		fs::rename(ours.path().join("old.txt"), ours.path().join("new.txt")).expect("rename");
		fs::write(ours.path().join("new.txt"), b"rename body\nchanged\n").expect("edit rename");
		git(ours.path(), &["add", "-N", "new.txt"]);
		fs::remove_file(ours.path().join("deleted.txt")).expect("delete file");
		fs::write(ours.path().join("created.txt"), b"new unique file\n").expect("create file");
		git(ours.path(), &["add", "-N", "created.txt"]);
		fs::write(ours.path().join("noeof.txt"), b"after").expect("edit no-eof");
		let mut changed_binary = binary;
		changed_binary[7] ^= 0xff;
		changed_binary.extend_from_slice(b"\0tail");
		fs::write(ours.path().join("data.bin"), &changed_binary).expect("edit binary");
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt;
			fs::set_permissions(ours.path().join("script.sh"), fs::Permissions::from_mode(0o755))
				.expect("chmod");
		}
		let patch = git(ours.path(), &["diff", "--binary", "--find-renames"]);
		reset(ours.path());
		assert!(
			repo(ours.path())
				.can_apply_patch(&patch, &ApplyOptions::default())
				.expect("check patch")
		);
		repo(ours.path())
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("apply worktree");
		let patch_file = oracle.path().join("change.patch");
		fs::write(&patch_file, &patch).expect("write patch");
		git(oracle.path(), &["apply", "--binary", "change.patch"]);
		fs::remove_file(patch_file).expect("remove patch");
		assert_eq!(
			git(ours.path(), &["status", "--porcelain"]),
			git(oracle.path(), &["status", "--porcelain"])
		);
		for path in ["text.txt", "new.txt", "noeof.txt", "script.sh", "data.bin", "created.txt"] {
			assert_eq!(
				fs::read(ours.path().join(path))
					.unwrap_or_else(|err| panic!("read ours {path}: {err}")),
				fs::read(oracle.path().join(path)).expect("read oracle"),
				"{path}"
			);
		}
		assert!(!ours.path().join("deleted.txt").exists());
		assert!(!oracle.path().join("deleted.txt").exists());
		repo(ours.path())
			.apply_patch(&patch, &ApplyOptions {
				cached:     false,
				index_path: None,
				reverse:    true,
				three_way:  false,
			})
			.expect("reverse worktree patch");
		let patch_file = oracle.path().join("change.patch");
		fs::write(&patch_file, &patch).expect("write reverse patch");
		git(oracle.path(), &["apply", "--reverse", "--binary", "change.patch"]);
		fs::remove_file(patch_file).expect("remove reverse patch");
		assert_eq!(
			git(ours.path(), &["status", "--porcelain"]),
			git(oracle.path(), &["status", "--porcelain"])
		);

		reset(ours.path());
		reset(oracle.path());
		repo(ours.path())
			.apply_patch(&patch, &ApplyOptions {
				cached:     true,
				index_path: None,
				reverse:    false,
				three_way:  false,
			})
			.expect("apply cached");
		let patch_file = oracle.path().join("change.patch");
		fs::write(&patch_file, &patch).expect("write patch");
		git(oracle.path(), &["apply", "--cached", "--binary", "change.patch"]);
		fs::remove_file(patch_file).expect("remove patch");
		assert_eq!(git(ours.path(), &["write-tree"]), git(oracle.path(), &["write-tree"]));
		assert_eq!(
			git(ours.path(), &["status", "--porcelain"]),
			git(oracle.path(), &["status", "--porcelain"])
		);
	}

	#[test]
	fn patch_stage_hunks_selects_indices_and_lines() {
		let original = (1..=20).fold(String::new(), |mut out, line| {
			use std::fmt::Write as _;
			let _ = writeln!(out, "line {line}");
			out
		});
		let temp = init(&[("file.txt", original.as_bytes())]);
		let changed = original
			.replace("line 2\n", "LINE TWO\n")
			.replace("line 18\n", "LINE EIGHTEEN\n");
		fs::write(temp.path().join("file.txt"), changed).expect("edit");
		let diff = git(temp.path(), &["diff", "--unified=1"]);
		let repository = repo(temp.path());
		repository
			.stage_hunks(
				&[HunkSelection { path: "file.txt".into(), hunks: HunkSpec::Indices(vec![1]) }],
				Some(&diff),
			)
			.expect("stage first hunk");
		let staged = git(temp.path(), &["show", ":file.txt"]);
		assert!(staged.contains("LINE TWO"));
		assert!(staged.contains("line 18"));
		assert!(!staged.contains("LINE EIGHTEEN"));
	}
	#[test]
	fn patch_cached_mixed_creation_uses_dev_null_with_alternate_index() {
		let temp = init(&[("tracked.txt", b"base\n")]);
		fs::create_dir_all(temp.path().join("src")).expect("create src");
		fs::write(temp.path().join("src/new.py"), b"WIP header\nunchanged\n")
			.expect("write WIP file");
		let repository = repo(temp.path());
		let created = repository
			.diff_no_index(Path::new("/dev/null"), Path::new("src/new.py"), true)
			.expect("creation patch");
		assert!(created.contains("--- /dev/null"));

		git(temp.path(), &["add", "src/new.py"]);
		fs::write(temp.path().join("tracked.txt"), b"changed\n").expect("edit tracked");
		fs::write(temp.path().join("src/new.py"), b"WIP header\nagent-edit\n")
			.expect("edit WIP file");
		let modified = repository
			.diff_text(&DiffOptions { binary: true, ..DiffOptions::default() })
			.expect("mixed tracked patch");
		assert!(modified.contains("--- a/src/new.py"));

		let ours_index = temp.path().join("ours-mixed.index");
		let oracle_index = temp.path().join("oracle-mixed.index");
		repository
			.read_tree("HEAD", Some(&ours_index))
			.expect("seed ours index");
		git_with_index(temp.path(), &oracle_index, &["read-tree", "HEAD"]);
		let options = ApplyOptions {
			cached:     true,
			index_path: Some(ours_index.clone()),
			reverse:    false,
			three_way:  false,
		};
		repository
			.apply_patch(&created, &options)
			.expect("apply creation patch");
		repository
			.apply_patch(&modified, &options)
			.expect("apply following modification patch");

		let creation_file = temp.path().join("creation.patch");
		let modified_file = temp.path().join("modified.patch");
		fs::write(&creation_file, &created).expect("write creation patch");
		fs::write(&modified_file, &modified).expect("write modified patch");
		git_with_index(temp.path(), &oracle_index, &[
			"apply",
			"--cached",
			"--binary",
			"creation.patch",
		]);
		git_with_index(temp.path(), &oracle_index, &[
			"apply",
			"--cached",
			"--binary",
			"modified.patch",
		]);
		let ours_tree = repository
			.write_tree(Some(&ours_index))
			.expect("write ours mixed tree");
		let oracle_tree = git_with_index(temp.path(), &oracle_index, &["write-tree"]);
		assert_eq!(ours_tree, oracle_tree.trim());
	}

	#[test]
	fn patch_cached_alternate_index_matches_git_and_preserves_real_index() {
		let temp = init(&[("file.txt", b"base\n")]);
		fs::write(temp.path().join("file.txt"), b"patched\n").expect("edit");
		let patch = git(temp.path(), &["diff", "--full-index"]);
		reset(temp.path());
		let repository = repo(temp.path());
		let ours_index = temp.path().join("ours.index");
		let oracle_index = temp.path().join("oracle.index");
		repository
			.read_tree("HEAD", Some(&ours_index))
			.expect("seed ours index");
		git_with_index(temp.path(), &oracle_index, &["read-tree", "HEAD"]);
		let real_index_before = fs::read(temp.path().join(".git/index")).expect("real index");
		let options = ApplyOptions {
			cached:     true,
			index_path: Some(ours_index.clone()),
			reverse:    false,
			three_way:  false,
		};
		let ours_before_check = fs::read(&ours_index).expect("ours index before check");
		assert!(
			repository
				.can_apply_patch(&patch, &options)
				.expect("alternate index check")
		);
		assert_eq!(fs::read(&ours_index).expect("ours index after check"), ours_before_check);
		repository
			.apply_patch(&patch, &options)
			.expect("apply alternate index");
		let patch_file = temp.path().join("alternate.patch");
		fs::write(&patch_file, &patch).expect("write patch");
		git_with_index(temp.path(), &oracle_index, &[
			"apply",
			"--cached",
			"--binary",
			"alternate.patch",
		]);
		fs::remove_file(patch_file).expect("remove patch");
		let ours_tree = repository
			.write_tree(Some(&ours_index))
			.expect("write ours tree");
		let oracle_tree = git_with_index(temp.path(), &oracle_index, &["write-tree"]);
		assert_eq!(ours_tree, oracle_tree.trim());
		assert_eq!(
			fs::read(temp.path().join(".git/index")).expect("real index after"),
			real_index_before
		);
	}

	#[test]
	fn patch_three_way_check_merges_drift_and_rejects_conflict() {
		let temp = init(&[("file.txt", b"one\ntwo\nthree\n")]);
		fs::write(temp.path().join("file.txt"), b"one\nTWO\nthree\n").expect("patch edit");
		let patch = git(temp.path(), &["diff", "--full-index"]);
		reset(temp.path());
		fs::write(temp.path().join("file.txt"), b"ONE\ntwo\nthree\n").expect("drift");
		let repository = repo(temp.path());
		assert!(
			!repository
				.can_apply_patch(&patch, &ApplyOptions::default())
				.expect("direct check")
		);
		let three_way =
			ApplyOptions { cached: false, index_path: None, reverse: false, three_way: true };
		assert!(
			repository
				.can_apply_patch(&patch, &three_way)
				.expect("three-way check")
		);
		repository
			.apply_patch(&patch, &three_way)
			.expect("three-way apply");
		assert_eq!(
			fs::read(temp.path().join("file.txt")).expect("merged file"),
			b"ONE\nTWO\nthree\n"
		);

		reset(temp.path());
		fs::write(temp.path().join("file.txt"), b"one\nOTHER\nthree\n").expect("conflict");
		assert!(
			!repository
				.can_apply_patch(&patch, &three_way)
				.expect("conflict check")
		);
	}

	#[test]
	fn patch_cherry_pick_and_stash_are_fail_clean() {
		let temp = init(&[("file.txt", b"base\n"), (".gitignore", b"ignored.txt\n")]);
		let base_branch = git(temp.path(), &["branch", "--show-current"])
			.trim()
			.to_owned();
		let base_sha = git(temp.path(), &["rev-parse", "HEAD"]).trim().to_owned();
		git(temp.path(), &["checkout", "-qb", "topic"]);
		fs::write(temp.path().join("file.txt"), b"base\ntopic\n").expect("topic edit");
		git(temp.path(), &["commit", "-qam", "topic change"]);
		let topic = git(temp.path(), &["rev-parse", "HEAD"]).trim().to_owned();
		fs::write(temp.path().join("remaining.txt"), b"remaining\n").expect("remaining edit");
		git(temp.path(), &["add", "remaining.txt"]);
		git(temp.path(), &["commit", "-qm", "remaining change"]);
		let topic_tip = git(temp.path(), &["rev-parse", "HEAD"]).trim().to_owned();
		git(temp.path(), &["checkout", "-q", &base_branch]);
		let repository = repo(temp.path());
		repository.cherry_pick(&topic).expect("clean cherry-pick");
		assert_eq!(fs::read(temp.path().join("file.txt")).expect("read"), b"base\ntopic\n");
		assert!(matches!(repository.cherry_pick(&topic), Err(Error::EmptyCherryPick { .. })));
		for commit in repository
			.rev_list_range(&base_sha, &topic_tip)
			.expect("topic range")
		{
			match repository.cherry_pick(&commit) {
				Ok(()) | Err(Error::EmptyCherryPick { .. }) => {},
				Err(error) => panic!("range cherry-pick failed: {error}"),
			}
		}
		assert_eq!(
			fs::read(temp.path().join("remaining.txt")).expect("remaining landed"),
			b"remaining\n"
		);
		let conflict = init(&[("file.txt", b"base\n")]);
		let conflict_base = git(conflict.path(), &["branch", "--show-current"])
			.trim()
			.to_owned();
		git(conflict.path(), &["checkout", "-qb", "other"]);
		fs::write(conflict.path().join("file.txt"), b"other\n").expect("other edit");
		git(conflict.path(), &["commit", "-qam", "other"]);
		let other = git(conflict.path(), &["rev-parse", "HEAD"])
			.trim()
			.to_owned();
		git(conflict.path(), &["checkout", "-q", &conflict_base]);
		fs::write(conflict.path().join("file.txt"), b"current\n").expect("current edit");
		git(conflict.path(), &["commit", "-qam", "current"]);
		let before_head = git(conflict.path(), &["rev-parse", "HEAD"]);
		let before_index = fs::read(conflict.path().join(".git/index")).expect("conflict index");
		assert!(matches!(repo(conflict.path()).cherry_pick(&other), Err(Error::Conflict { .. })));
		assert_eq!(git(conflict.path(), &["rev-parse", "HEAD"]), before_head);
		assert_eq!(
			fs::read(conflict.path().join(".git/index")).expect("conflict index after"),
			before_index
		);
		assert_eq!(fs::read(conflict.path().join("file.txt")).expect("conflict file"), b"current\n");

		fs::write(temp.path().join("file.txt"), b"base\ntopic\nstaged\n").expect("staged edit");
		git(temp.path(), &["add", "file.txt"]);
		fs::write(temp.path().join("file.txt"), b"base\ntopic\nstaged\nworktree\n")
			.expect("worktree edit");
		fs::write(temp.path().join("untracked.txt"), b"untracked\n").expect("untracked");
		fs::write(temp.path().join("ignored.txt"), b"ignored\n").expect("ignored");
		assert!(
			repository
				.stash_push(Some("roundtrip"))
				.expect("stash push")
		);
		assert!(!temp.path().join("untracked.txt").exists());
		assert!(temp.path().join("ignored.txt").exists());
		assert!(repository.stash_try_pop(true).expect("stash pop"));
		assert_eq!(
			fs::read(temp.path().join("file.txt")).expect("restored"),
			b"base\ntopic\nstaged\nworktree\n"
		);
		assert_eq!(
			fs::read(temp.path().join("untracked.txt")).expect("restored untracked"),
			b"untracked\n"
		);
		assert_eq!(fs::read(temp.path().join("ignored.txt")).expect("ignored remains"), b"ignored\n");

		reset(temp.path());
		fs::write(temp.path().join("file.txt"), b"stashed\n").expect("stash conflict edit");
		assert!(repository.stash_push(None).expect("stash conflict"));
		fs::write(temp.path().join("file.txt"), b"current\n").expect("current conflict edit");
		let before_file = fs::read(temp.path().join("file.txt")).expect("before file");
		let before_index = fs::read(temp.path().join(".git/index")).expect("before index");
		let before_stash = git(temp.path(), &["rev-parse", "refs/stash"]);
		assert!(!repository.stash_try_pop(false).expect("conflicting pop"));
		assert_eq!(fs::read(temp.path().join("file.txt")).expect("after file"), before_file);
		assert_eq!(fs::read(temp.path().join(".git/index")).expect("after index"), before_index);
		assert_eq!(git(temp.path(), &["rev-parse", "refs/stash"]), before_stash);
	}
	#[test]
	fn patch_stash_pop_preserves_older_stack_entry() {
		let temp = init(&[("file.txt", b"base\n")]);
		let repository = repo(temp.path());
		fs::write(temp.path().join("file.txt"), b"first\n").expect("first stash");
		assert!(repository.stash_push(Some("first")).expect("push first"));
		let first = git(temp.path(), &["rev-parse", "refs/stash"]);
		fs::write(temp.path().join("file.txt"), b"second\n").expect("second stash");
		assert!(repository.stash_push(Some("second")).expect("push second"));
		assert_ne!(git(temp.path(), &["rev-parse", "refs/stash"]), first);
		assert!(repository.stash_try_pop(false).expect("pop second"));
		assert_eq!(git(temp.path(), &["rev-parse", "refs/stash"]), first);
		assert_eq!(fs::read(temp.path().join("file.txt")).expect("second restored"), b"second\n");
	}

	#[test]
	fn validate_repo_path_rejects_git_store_and_escapes() {
		for path in [
			".git",
			".git/config",
			".git/hooks/pre-commit",
			"sub/.git/objects",
			"../outside",
			"/abs/path",
			"",
		] {
			assert!(validate_repo_path(path).is_err(), "expected {path:?} to be rejected");
		}
		// Ordinary relative paths still apply.
		assert!(validate_repo_path("src/main.rs").is_ok());
		assert!(validate_repo_path("a/b/c.txt").is_ok());
	}

	#[test]
	fn validate_repo_path_rejects_case_insensitive_git_aliases() {
		// macOS and Windows default to case-insensitive filesystems, where each
		// of these opens the real `.git`. The byte-exact check they replaced
		// admitted every one of them.
		for path in [
			".GIT/hooks/pre-commit",
			".Git/config",
			".gIt/objects/pack",
			"sub/.GIT/config",
			"GIT~1/hooks/pre-commit",
			"git~1/config",
			".git./config",
			".git /config",
		] {
			assert!(validate_repo_path(path).is_err(), "expected {path:?} to be rejected");
		}
		// Names that merely start with or contain `git` are ordinary files.
		assert!(validate_repo_path("gitignore").is_ok());
		assert!(validate_repo_path(".gitignore").is_ok());
		assert!(validate_repo_path("src/git/patch.rs").is_ok());
		assert!(validate_repo_path("digits/x.txt").is_ok());
	}

	#[test]
	fn validate_repo_path_rejects_hfs_ignorable_git_spellings() {
		// HFS+ folds these codepoints away when comparing names, so each of
		// these opens the real `.git`. Git refuses the same set under
		// `core.protectHFS`; a nested repository under `sub/` is reachable the
		// same way, and `assert_outside_git_store` cannot help there — it only
		// knows the OUTER repository's store.
		for path in [
			".\u{200c}git/config",
			".g\u{200d}it/hooks/pre-commit",
			".gi\u{feff}t/objects",
			".git\u{202a}/config",
			"sub/.\u{200c}git/hooks/pre-commit",
			"sub/.g\u{206f}it/config",
		] {
			assert!(validate_repo_path(path).is_err(), "expected {path:?} to be rejected");
		}
		// Ordinary names containing no ignorable characters still apply.
		assert!(validate_repo_path("sub/gitignore").is_ok());
		assert!(validate_repo_path("digit/x.txt").is_ok());
	}

	#[test]
	fn apply_patch_refuses_to_write_through_symlink_outside_root() {
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		// A symlinked directory inside the worktree aliases an untracked path
		// that would otherwise be written into the repo root. The patch must
		// not follow the link out of the worktree.
		#[cfg(unix)]
		{
			use std::os::unix::fs::symlink;
			symlink(outside.path(), temp.path().join("link")).expect("create symlink");
		}
		#[cfg(not(unix))]
		{
			let _ = &outside;
		}
		let repository = repo(temp.path());
		// Craft a minimal "new file" patch targeting the symlinked prefix.
		let patch = concat!(
			"diff --git a/link/sneaky.txt b/link/sneaky.txt\n",
			"new file mode 100644\n",
			"index 0000000..3b18e51\n",
			"--- /dev/null\n",
			"+++ b/link/sneaky.txt\n",
			"@@ -0,0 +1 @@\n",
			"+pwned\n",
		);
		let result = repository.apply_patch(patch, &ApplyOptions::default());
		#[cfg(unix)]
		{
			assert!(result.is_err(), "patch must refuse symlink traversal");
			assert!(
				!outside.path().join("sneaky.txt").exists(),
				"file written through symlink escape"
			);
		}
		#[cfg(not(unix))]
		{
			let _ = result;
		}
	}

	#[test]
	fn apply_patch_refuses_to_write_through_dangling_symlink_outside_root() {
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		// The link's target does not exist yet. `canonicalize` fails for a
		// dangling link exactly as it does for an absent path, so a guard that
		// walks up on any error admits it — and `create_dir_all` then
		// materialises the target while following the link.
		let ghost = outside.path().join("ghost");
		#[cfg(unix)]
		{
			use std::os::unix::fs::symlink;
			symlink(&ghost, temp.path().join("link")).expect("create dangling symlink");
		}
		#[cfg(not(unix))]
		{
			let _ = &outside;
		}
		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/link/sneaky.txt b/link/sneaky.txt\n",
			"new file mode 100644\n",
			"index 0000000..3b18e51\n",
			"--- /dev/null\n",
			"+++ b/link/sneaky.txt\n",
			"@@ -0,0 +1 @@\n",
			"+pwned\n",
		);
		let result = repository.apply_patch(patch, &ApplyOptions::default());
		#[cfg(unix)]
		{
			assert!(result.is_err(), "patch must refuse dangling symlink traversal");
			assert!(!ghost.exists(), "patch materialised the link target outside the root");
		}
		#[cfg(not(unix))]
		{
			let _ = result;
			let _ = &ghost;
		}
	}

	#[test]
	fn apply_patch_leaves_worktree_untouched_when_a_later_path_escapes() {
		let temp = init(&[("keep.txt", b"base\n"), ("doomed.txt", b"victim\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		#[cfg(unix)]
		{
			use std::os::unix::fs::symlink;
			symlink(outside.path(), temp.path().join("link")).expect("create symlink");
		}
		#[cfg(not(unix))]
		{
			let _ = &outside;
		}
		let repository = repo(temp.path());
		// Three sides in order: a legitimate edit, a legitimate deletion, then
		// a target beneath the escaping symlink. Validating per-side as each is
		// reached would commit the first two before refusing the third.
		let patch = concat!(
			"diff --git a/keep.txt b/keep.txt\n",
			"--- a/keep.txt\n",
			"+++ b/keep.txt\n",
			"@@ -1 +1 @@\n",
			"-base\n",
			"+edited\n",
			"diff --git a/doomed.txt b/doomed.txt\n",
			"deleted file mode 100644\n",
			"--- a/doomed.txt\n",
			"+++ /dev/null\n",
			"@@ -1 +0,0 @@\n",
			"-victim\n",
			"diff --git a/link/sneaky.txt b/link/sneaky.txt\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/link/sneaky.txt\n",
			"@@ -0,0 +1 @@\n",
			"+pwned\n",
		);
		let result = repository.apply_patch(patch, &ApplyOptions::default());
		#[cfg(unix)]
		{
			assert!(result.is_err(), "patch must refuse the escaping target");
			assert_eq!(
				fs::read(temp.path().join("keep.txt")).expect("keep.txt"),
				b"base\n",
				"earlier edit was committed before the escape was caught"
			);
			assert!(
				temp.path().join("doomed.txt").exists(),
				"earlier deletion was committed before the escape was caught"
			);
			assert!(!outside.path().join("sneaky.txt").exists(), "escape was written");
		}
		#[cfg(not(unix))]
		{
			let _ = result;
		}
	}

	#[test]
	fn can_apply_patch_reports_false_for_an_escaping_patch() {
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		#[cfg(unix)]
		{
			use std::os::unix::fs::symlink;
			symlink(outside.path(), temp.path().join("link")).expect("create symlink");
		}
		#[cfg(not(unix))]
		{
			let _ = &outside;
		}
		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/link/sneaky.txt b/link/sneaky.txt\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/link/sneaky.txt\n",
			"@@ -0,0 +1 @@\n",
			"+pwned\n",
		);
		#[cfg(unix)]
		{
			// The predicate must agree with `apply_patch`: a caller gating on it
			// would otherwise treat an attack as a viable change.
			assert!(
				!repository
					.can_apply_patch(patch, &ApplyOptions::default())
					.expect("probe"),
				"can_apply_patch claimed an escaping patch applies"
			);
			assert!(
				repository
					.apply_patch(patch, &ApplyOptions::default())
					.is_err()
			);
		}
		#[cfg(not(unix))]
		{
			let _ = (&repository, patch);
		}
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_deletes_a_tracked_symlink_pointing_outside_the_root() {
		use std::os::unix::fs::symlink;

		// A repository may legitimately track a symlink whose target lies
		// outside the worktree. Unlinking it does not follow it, so deletion
		// must keep working — resolving the leaf would break ordinary patch
		// deletion, cherry-pick, and stash cleanup.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let link = temp.path().join("outbound");
		symlink(outside.path().join("target"), &link).expect("create dangling symlink");
		git(temp.path(), &["add", "outbound"]);
		git(temp.path(), &["commit", "-m", "track symlink"]);

		let repository = repo(temp.path());
		let target_id = git(temp.path(), &["rev-parse", "HEAD:outbound"]);
		let patch = format!(
			concat!(
				"diff --git a/outbound b/outbound\n",
				"deleted file mode 120000\n",
				"index {}..0000000\n",
				"--- a/outbound\n",
				"+++ /dev/null\n",
				"@@ -1 +0,0 @@\n",
				"-{}\n",
				"\\ No newline at end of file\n",
			),
			&target_id[..7],
			outside.path().join("target").display(),
		);
		repository
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("delete tracked symlink");
		assert!(
			link.symlink_metadata().is_err(),
			"tracked symlink pointing outside the root was not deleted"
		);
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_refuses_to_read_a_source_through_an_escaping_symlink() {
		use std::os::unix::fs::symlink;

		// The source side is READ to build the state map. Before the preflight
		// moved ahead of that read, a patch could name a source beneath an
		// escaping symlink and have it slurped from outside the worktree — and
		// pointing it at a device or FIFO turned that read into unbounded
		// memory growth or a hang.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let secret = outside.path().join("secret.txt");
		fs::write(&secret, b"classified\n").expect("write secret");
		symlink(outside.path(), temp.path().join("link")).expect("create symlink");

		let repository = repo(temp.path());
		let objects_before = loose_object_count(temp.path());
		let patch = concat!(
			"diff --git a/link/secret.txt b/link/secret.txt\n",
			"deleted file mode 100644\n",
			"--- a/link/secret.txt\n",
			"+++ /dev/null\n",
			"@@ -1 +0,0 @@\n",
			"-classified\n",
		);
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"patch must refuse a source outside the worktree"
		);
		assert!(
			!repository
				.can_apply_patch(patch, &ApplyOptions::default())
				.expect("probe"),
			"probe must refuse it too — it reads the same sources"
		);
		assert!(secret.exists(), "external file was consumed by the patch");
		// Refusal alone proves nothing: the patch is refused either way, just
		// later. What separates the two orderings is whether the source was
		// READ — `augment_patch_sources` writes every source it reads into the
		// object store as a blob, so the store growing is the observable
		// evidence that external content was slurped before the refusal.
		assert_eq!(
			loose_object_count(temp.path()),
			objects_before,
			"external file was read into the object store before the refusal"
		);
	}

	#[test]
	fn apply_patch_refuses_a_separate_git_dir_store() {
		// `git init --separate-git-dir=meta .` leaves a `.git` FILE pointing at
		// `meta/`, so the real store carries a name the component check cannot
		// recognise. `meta/hooks/pre-commit` is a genuine hook and an
		// unremarkable-looking path inside the root.
		let temp = TempDir::new().expect("tempdir");
		git(temp.path(), &["init", "--separate-git-dir=meta", "."]);
		git(temp.path(), &["config", "user.email", "test@example.com"]);
		git(temp.path(), &["config", "user.name", "Test"]);
		fs::write(temp.path().join("keep.txt"), b"base\n").expect("seed");
		git(temp.path(), &["add", "keep.txt"]);
		git(temp.path(), &["commit", "-m", "seed"]);

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/meta/hooks/pre-commit b/meta/hooks/pre-commit\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/meta/hooks/pre-commit\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"patch installed a hook into the separate git dir"
		);
		assert!(
			!temp.path().join("meta/hooks/pre-commit").exists(),
			"hook was written into the real git store"
		);
		// A path that merely shares the prefix is not the store.
		assert!(validate_repo_path("metadata/notes.txt").is_ok());
	}

	#[test]
	#[cfg(unix)]
	fn stash_roundtrip_preserves_a_tracked_outbound_symlink() {
		use std::os::unix::fs::symlink;

		// A repository may track a symlink whose target lies outside the
		// worktree. Writing such an entry unlinks and recreates the link
		// without following it, so stash and pop must keep working — resolving
		// the leaf would fail every operation that merely carries the entry
		// along, even when the link itself is untouched.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let link = temp.path().join("outbound");
		symlink(outside.path().join("target"), &link).expect("create symlink");
		git(temp.path(), &["add", "outbound"]);
		git(temp.path(), &["commit", "-m", "track outbound symlink"]);

		let repository = repo(temp.path());
		fs::write(temp.path().join("keep.txt"), b"dirty\n").expect("dirty the tree");
		assert!(
			repository.stash_push(Some("wip")).expect("stash"),
			"stash must not choke on the link"
		);
		assert!(link.symlink_metadata().is_ok(), "stash removed the tracked symlink");
		assert!(repository.stash_try_pop(false).expect("pop"), "pop must restore the change");
		assert_eq!(fs::read(temp.path().join("keep.txt")).expect("keep.txt"), b"dirty\n");
		assert!(link.symlink_metadata().is_ok(), "pop lost the tracked symlink");
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_refuses_before_advancing_head_when_a_path_escapes() {
		use std::os::unix::fs::symlink;

		// `cherry_pick` merges trees, commits with `commit_as` — moving HEAD —
		// and only THEN writes the worktree. A path refused during that write
		// leaves HEAD ahead of a worktree that never received the change.
		//
		// The escape has to be invisible to the tree merge, so it is planted in
		// the worktree only: `nested/` is a real tracked directory in both
		// trees, replaced on disk by a symlink pointing outside the root.
		let temp = init(&[("keep.txt", b"base\n")]);
		fs::create_dir_all(temp.path().join("nested")).expect("mkdir");
		fs::write(temp.path().join("nested/tracked.txt"), b"one\n").expect("write");
		git(temp.path(), &["add", "nested/tracked.txt"]);
		git(temp.path(), &["commit", "-m", "track nested"]);

		git(temp.path(), &["checkout", "-q", "-b", "side"]);
		fs::write(temp.path().join("nested/tracked.txt"), b"two\n").expect("write");
		git(temp.path(), &["commit", "-aqm", "edit nested"]);
		let side = git(temp.path(), &["rev-parse", "HEAD"]).trim().to_string();
		git(temp.path(), &["checkout", "-q", "-"]);

		// Swap the real directory for a link out of the worktree. The trees
		// still merge cleanly — only the write is an escape.
		let outside = tempfile::tempdir().expect("outside tempdir");
		fs::remove_dir_all(temp.path().join("nested")).expect("drop real dir");
		symlink(outside.path(), temp.path().join("nested")).expect("create symlink");

		let repository = repo(temp.path());
		let head_before = git(temp.path(), &["rev-parse", "HEAD"]);
		assert!(repository.cherry_pick(&side).is_err(), "cherry-pick must refuse the escaping path");
		assert_eq!(
			git(temp.path(), &["rev-parse", "HEAD"]),
			head_before,
			"HEAD advanced even though the worktree write was refused"
		);
		assert!(!outside.path().join("tracked.txt").exists(), "file written outside the worktree");
	}

	/// Number of loose objects in a repository's store.
	fn loose_object_count(cwd: &Path) -> usize {
		let output = git(cwd, &["count-objects", "-v"]);
		output
			.lines()
			.find_map(|line| line.strip_prefix("count: "))
			.and_then(|count| count.trim().parse().ok())
			.expect("count-objects reports a count")
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_repoints_a_tracked_symlink_that_targets_outside_the_root() {
		use std::os::unix::fs::symlink;

		// A patch whose target mode is 120000 is unlinked and recreated, never
		// opened through. Resolving its CURRENT destination would reject a
		// valid patch that merely repoints an outbound link.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let first = outside.path().join("one");
		let second = outside.path().join("two");
		fs::write(&first, b"one\n").expect("first target");
		fs::write(&second, b"two\n").expect("second target");
		symlink(&first, temp.path().join("outbound")).expect("create symlink");
		git(temp.path(), &["add", "outbound"]);
		git(temp.path(), &["commit", "-m", "track outbound symlink"]);

		let repository = repo(temp.path());
		let blob = git(temp.path(), &["rev-parse", "HEAD:outbound"]);
		let patch = format!(
			concat!(
				"diff --git a/outbound b/outbound\n",
				"index {}..1111111 120000\n",
				"--- a/outbound\n",
				"+++ b/outbound\n",
				"@@ -1 +1 @@\n",
				"-{}\n",
				"\\ No newline at end of file\n",
				"+{}\n",
				"\\ No newline at end of file\n",
			),
			&blob.trim()[..7],
			first.display(),
			second.display(),
		);
		repository
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("repointing an outbound symlink is a valid patch");
		assert_eq!(
			fs::read_link(temp.path().join("outbound")).expect("still a symlink"),
			second,
			"symlink was not repointed"
		);
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_ignores_an_unchanged_path_the_write_loop_would_not_touch() {
		use std::os::unix::fs::symlink;

		// The map preflight must validate exactly what the write loop writes.
		// An unrelated, unchanged tracked path that has locally become an
		// outbound symlink is never written, so it must not fail the pick.
		let temp = init(&[("keep.txt", b"base\n"), ("untouched.txt", b"stable\n")]);
		git(temp.path(), &["checkout", "-q", "-b", "side"]);
		fs::write(temp.path().join("keep.txt"), b"edited\n").expect("edit");
		git(temp.path(), &["commit", "-aqm", "edit keep"]);
		let side = git(temp.path(), &["rev-parse", "HEAD"]).trim().to_string();
		git(temp.path(), &["checkout", "-q", "-"]);

		let outside = tempfile::tempdir().expect("outside tempdir");
		let target = outside.path().join("elsewhere");
		fs::write(&target, b"stable\n").expect("outside target");
		fs::remove_file(temp.path().join("untouched.txt")).expect("drop real file");
		symlink(&target, temp.path().join("untouched.txt")).expect("shadow with symlink");

		let repository = repo(temp.path());
		repository
			.cherry_pick(&side)
			.expect("unrelated unchanged path must not block the pick");
		assert_eq!(fs::read(temp.path().join("keep.txt")).expect("keep.txt"), b"edited\n");
	}

	#[test]
	#[cfg(unix)]
	fn stash_push_refuses_before_installing_a_stash() {
		use std::os::unix::fs::symlink;

		// `update_stash_ref` runs before the worktree is rewritten, so a
		// refusal discovered during the write would leave a stash the caller
		// never asked for alongside the still-dirty tree.
		let temp = init(&[("keep.txt", b"base\n"), ("nested/tracked.txt", b"one\n")]);
		fs::write(temp.path().join("nested/tracked.txt"), b"two\n").expect("dirty the tree");

		let outside = tempfile::tempdir().expect("outside tempdir");
		fs::remove_file(temp.path().join("nested/tracked.txt")).expect("drop file");
		fs::remove_dir(temp.path().join("nested")).expect("drop dir");
		symlink(outside.path(), temp.path().join("nested")).expect("shadow the prefix");

		let repository = repo(temp.path());
		// `git()` panics on a non-zero status, and `--verify --quiet` exits 1
		// when no stash exists — which is exactly the state under test.
		let stash_ref = |cwd: &Path| -> Option<String> {
			let output = Command::new("git")
				.current_dir(cwd)
				.args(["rev-parse", "--verify", "--quiet", "refs/stash"])
				.output()
				.expect("run git");
			output
				.status
				.success()
				.then(|| String::from_utf8_lossy(&output.stdout).trim().to_owned())
		};
		let before = stash_ref(temp.path());
		assert!(repository.stash_push(Some("wip")).is_err(), "stash must refuse the escaping path");
		assert_eq!(stash_ref(temp.path()), before, "a stash was installed despite the refusal");
	}

	#[test]
	fn containment_refusals_carry_the_path_as_a_typed_field() {
		// The refusal must be classifiable and the path redactable without
		// parsing a rendered message.
		let temp = init(&[("keep.txt", b"base\n")]);
		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/.git/hooks/pre-commit b/.git/hooks/pre-commit\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/.git/hooks/pre-commit\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		match repository.apply_patch(patch, &ApplyOptions::default()) {
			Err(Error::PathInGitStore { path }) => {
				assert_eq!(path, ".git/hooks/pre-commit");
				assert_eq!(Error::PathInGitStore { path }.kind(), "PathInGitStore");
			},
			other => panic!("expected a typed git-store refusal, got {other:?}"),
		}
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_refuses_a_path_under_a_symlink_the_same_patch_creates() {
		// The per-path guards interrogate the CURRENT filesystem, where the
		// link does not exist yet, so both paths pass and the refusal would
		// land only after `write_patch_worktree` created the link.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let repository = repo(temp.path());
		let patch = format!(
			concat!(
				"diff --git a/link b/link\n",
				"new file mode 120000\n",
				"--- /dev/null\n",
				"+++ b/link\n",
				"@@ -0,0 +1 @@\n",
				"+{}\n",
				"\\ No newline at end of file\n",
				"diff --git a/link/sneaky.txt b/link/sneaky.txt\n",
				"new file mode 100644\n",
				"--- /dev/null\n",
				"+++ b/link/sneaky.txt\n",
				"@@ -0,0 +1 @@\n",
				"+pwned\n",
			),
			outside.path().display(),
		);
		assert!(
			repository
				.apply_patch(&patch, &ApplyOptions::default())
				.is_err(),
			"patch must refuse a path under a symlink it mints itself"
		);
		assert!(!temp.path().join("link").symlink_metadata().is_ok(), "the link was created anyway");
		assert!(!outside.path().join("sneaky.txt").exists(), "wrote through the minted link");
	}

	#[test]
	fn validate_repo_path_rejects_the_trimmed_dos_alias() {
		// Windows ignores trailing dots and spaces before lookup, so trimming
		// and then comparing only against `.git` lets the DOS alias through.
		for path in [
			"git~1./hooks/pre-commit",
			"git~1 /config",
			"sub/git~1./hooks/pre-commit",
			"GIT~1.//config",
		] {
			assert!(validate_repo_path(path).is_err(), "expected {path:?} to be rejected");
		}
		// Names that merely resemble it stay valid.
		assert!(validate_repo_path("git~10/notes.txt").is_ok());
		assert!(validate_repo_path("sub/gitlab/config").is_ok());
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_deletes_a_tracked_symlink_pointing_into_the_git_store() {
		use std::os::unix::fs::symlink;

		// Unlinking cannot modify the link's target, so a repository that
		// tracks a link into its own store is entitled to delete it. Resolving
		// the leaf would refuse an operation that touches nothing.
		let temp = init(&[("keep.txt", b"base\n")]);
		let link = temp.path().join("storelink");
		symlink(temp.path().join(".git/config"), &link).expect("create symlink");
		git(temp.path(), &["add", "-f", "storelink"]);
		git(temp.path(), &["commit", "-m", "track store symlink"]);

		let repository = repo(temp.path());
		let blob = git(temp.path(), &["rev-parse", "HEAD:storelink"]);
		let patch = format!(
			concat!(
				"diff --git a/storelink b/storelink\n",
				"deleted file mode 120000\n",
				"index {}..0000000\n",
				"--- a/storelink\n",
				"+++ /dev/null\n",
				"@@ -1 +0,0 @@\n",
				"-{}\n",
				"\\ No newline at end of file\n",
			),
			&blob.trim()[..7],
			temp.path().join(".git/config").display(),
		);
		repository
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("deleting the link is safe");
		assert!(link.symlink_metadata().is_err(), "tracked store symlink was not deleted");
		assert!(temp.path().join(".git/config").exists(), "the link target was disturbed");
	}

	#[test]
	fn error_kind_is_derived_from_the_variant_name() {
		// Derived, so a new variant cannot drift from its reported kind.
		assert_eq!(Error::PathEscapesRoot { path: "a".to_owned() }.kind(), "PathEscapesRoot");
		assert_eq!(Error::PathInGitStore { path: "a".to_owned() }.kind(), "PathInGitStore");
		assert_eq!(Error::Canceled.kind(), "Canceled");
		assert_eq!(Error::PatchFailed { message: "x".to_owned() }.kind(), "PatchFailed");
	}

	#[test]
	fn validate_repo_path_rejects_ntfs_alternate_stream_aliases() {
		// NTFS opens a directory through its stream syntax, and the suffix
		// survives the dot/space trim, so it would otherwise carry the name
		// past every comparison.
		for path in [
			".git::$INDEX_ALLOCATION/hooks/pre-commit",
			"git~1::$INDEX_ALLOCATION/config",
			"sub/.git::$INDEX_ALLOCATION/hooks/pre-commit",
			".git:x/config",
			".GIT::$INDEX_ALLOCATION/config",
		] {
			assert!(validate_repo_path(path).is_err(), "expected {path:?} to be rejected");
		}
		// A colon elsewhere in a name is not a store alias.
		assert!(validate_repo_path("notes:draft.txt").is_ok());
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_refuses_a_path_under_a_renamed_symlink_with_no_mode_header() {
		use std::os::unix::fs::symlink;

		// A 100% rename carries no mode headers, so `target_mode` is None and
		// application inherits SYMLINK from the source entry. The topology scan
		// has to infer it the same way, or it misses the minted link.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		symlink(outside.path(), temp.path().join("old")).expect("create symlink");
		git(temp.path(), &["add", "old"]);
		git(temp.path(), &["commit", "-m", "track symlink"]);

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/old b/link\n",
			"similarity index 100%\n",
			"rename from old\n",
			"rename to link\n",
			"diff --git a/link/sneaky.txt b/link/sneaky.txt\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/link/sneaky.txt\n",
			"@@ -0,0 +1 @@\n",
			"+pwned\n",
		);
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"patch must refuse a path under a symlink it renames into place"
		);
		assert!(!outside.path().join("sneaky.txt").exists(), "wrote through the renamed link");
		assert!(temp.path().join("old").symlink_metadata().is_ok(), "the rename was applied anyway");
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_refuses_a_mode_less_rename_of_a_regular_file_onto_a_store_symlink() {
		use std::os::unix::fs::symlink;

		// The source is a tracked REGULAR file, so the write follows whatever
		// sits at the target. An untracked `b -> .git/config` there is the
		// attacker's leaf. Inferring the mode from the target instead of the
		// source calls the entry a symlink, runs the prefix check only, and
		// the write then overwrites Git's own configuration.
		let temp = init(&[("a", b"payload\n")]);
		symlink(".git/config", temp.path().join("b")).expect("create symlink");
		let config_before = fs::read(temp.path().join(".git/config")).expect("read config");

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/a b/b\n",
			"similarity index 100%\n",
			"rename from a\n",
			"rename to b\n",
		);
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"a regular file renamed onto a symlink into the store must be refused"
		);
		assert_eq!(
			fs::read(temp.path().join(".git/config")).expect("read config"),
			config_before,
			"the rename wrote through the target symlink into the git store"
		);
		assert!(temp.path().join("a").is_file(), "the source was removed anyway");
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_refuses_a_hard_linked_symlink_alias_of_a_removed_link() {
		use std::os::unix::fs::symlink;

		// `Link` is tracked and outbound. `link` is an untracked HARD link to
		// that symlink: same inode, separate directory entry. A pick that
		// deletes `Link` and adds `link/file.txt` removes one name and leaves
		// the other, so `link/file.txt` still resolves through the outbound
		// link. Inode equality alone calls the ancestor "removed" and skips
		// containment; after HEAD advances the child write escapes the root.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		symlink(outside.path(), temp.path().join("Link")).expect("create symlink");
		git(temp.path(), &["add", "Link"]);
		git(temp.path(), &["commit", "-m", "track outbound symlink"]);
		let linked = std::process::Command::new("ln")
			.args(["-P", "Link", "link"])
			.current_dir(temp.path())
			.status()
			.expect("run ln");
		if !linked.success() {
			// The filesystem refuses hard links to symlinks; the alias cannot
			// be constructed and the case does not arise here.
			return;
		}
		let alias = temp
			.path()
			.join("link")
			.symlink_metadata()
			.expect("alias metadata");
		assert!(alias.file_type().is_symlink(), "ln -P did not produce a symlink entry");
		assert_eq!(alias.nlink(), 2, "alias is not a second name for the same inode");

		let gix_repo = repo(temp.path()).gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let mut map = tree_map(&gix_repo, head_tree).expect("base map");
		map.remove("Link");
		let file = gix_repo.write_blob(b"pwned\n").expect("file blob").detach();
		map.insert("link/file.txt".to_owned(), FileEntry::new(file, Mode::FILE));
		let tree = write_tree_map(&gix_repo, &map).expect("picked tree");
		let picked = gix_repo
			.new_commit("replace link", tree, [head.id().detach()])
			.expect("picked commit")
			.id()
			.to_string();
		let head_before = git(temp.path(), &["rev-parse", "HEAD"]);

		let repository = repo(temp.path());
		assert!(
			repository.cherry_pick(&picked).is_err(),
			"child under a surviving hard-linked alias must be refused"
		);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head_before, "HEAD moved");
		assert!(!outside.path().join("file.txt").exists(), "wrote through the surviving alias");
		assert!(
			temp.path().join("Link").symlink_metadata().is_ok(),
			"the removal was applied anyway"
		);
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_replaces_a_tracked_outbound_symlink_with_a_directory() {
		use std::os::unix::fs::symlink;

		// The removal pass takes `dir` out before the creation pass writes
		// `dir/file`, so judging the child against the pre-removal filesystem
		// would reject a safe operation: the escaping ancestor does not survive
		// into the write.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		symlink(outside.path(), temp.path().join("dir")).expect("create symlink");
		git(temp.path(), &["add", "dir"]);
		git(temp.path(), &["commit", "-m", "track outbound symlink"]);

		git(temp.path(), &["checkout", "-q", "-b", "side"]);
		git(temp.path(), &["rm", "-q", "dir"]);
		fs::create_dir_all(temp.path().join("dir")).expect("mkdir");
		fs::write(temp.path().join("dir/file.txt"), b"real file\n").expect("write");
		git(temp.path(), &["add", "dir/file.txt"]);
		git(temp.path(), &["commit", "-m", "replace link with a directory"]);
		let side = git(temp.path(), &["rev-parse", "HEAD"]).trim().to_string();
		git(temp.path(), &["checkout", "-q", "-"]);

		let repository = repo(temp.path());
		repository
			.cherry_pick(&side)
			.expect("replacing a removed symlink ancestor is safe");
		assert_eq!(fs::read(temp.path().join("dir/file.txt")).expect("dir/file.txt"), b"real file\n");
		assert!(!outside.path().join("file.txt").exists(), "wrote through the old link");
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_normalizes_spellings_before_matching_a_minted_symlink() {
		// `./link/file` and `link/file` name the same hierarchy, so a raw
		// prefix comparison misses the link this patch mints.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let repository = repo(temp.path());
		let patch = format!(
			concat!(
				"diff --git a/link b/link\n",
				"new file mode 120000\n",
				"--- /dev/null\n",
				"+++ b/link\n",
				"@@ -0,0 +1 @@\n",
				"+{}\n",
				"\\ No newline at end of file\n",
				"diff --git a/./link/sneaky.txt b/./link/sneaky.txt\n",
				"new file mode 100644\n",
				"--- /dev/null\n",
				"+++ b/./link/sneaky.txt\n",
				"@@ -0,0 +1 @@\n",
				"+pwned\n",
			),
			outside.path().display(),
		);
		assert!(
			repository
				.apply_patch(&patch, &ApplyOptions::default())
				.is_err(),
			"a dot-prefixed spelling must not slip past the minted link"
		);
		assert!(!outside.path().join("sneaky.txt").exists(), "wrote through the minted link");
	}

	#[test]
	fn apply_patch_refuses_a_nested_repositorys_separate_git_dir() {
		// `git init --separate-git-dir=… sub` leaves a live store with no
		// `.git` component, outside the outer repository's own directories.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--separate-git-dir=nested-meta", "sub"]);

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/nested-meta/hooks/pre-commit b/nested-meta/hooks/pre-commit\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/nested-meta/hooks/pre-commit\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"patch installed a hook into a nested repository's store"
		);
		assert!(
			!temp.path().join("nested-meta/hooks/pre-commit").exists(),
			"hook was written into the nested store"
		);
	}

	#[test]
	fn apply_patch_does_not_protect_the_target_of_a_stale_gitfile() {
		// `sub/.git` reads `gitdir: ../docs`, but `docs/` is an ordinary
		// directory: git cannot open `sub` as a repository through it. Treating
		// every parseable directive as a store would refuse every later write
		// under `docs/` with `PathInGitStore` for as long as the stale file
		// sits in the tree.
		let temp = init(&[("keep.txt", b"base\n"), ("docs/readme.md", b"docs\n")]);
		fs::create_dir(temp.path().join("sub")).expect("mkdir sub");
		fs::write(temp.path().join("sub/.git"), b"gitdir: ../docs\n").expect("write stale gitfile");

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/docs/guide.md b/docs/guide.md\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/docs/guide.md\n",
			"@@ -0,0 +1 @@\n",
			"+guide\n",
		);
		repository
			.apply_patch(patch, &ApplyOptions::default())
			.expect("an ordinary directory named by a stale gitfile is not a store");
		assert_eq!(fs::read(temp.path().join("docs/guide.md")).expect("read"), b"guide\n");
	}

	#[test]
	fn gitfile_target_with_a_missing_commondir_is_not_protected() {
		// A gitdir that names a `commondir` git cannot find is not one git
		// would open; protecting it — or worse, protecting whatever the dangling
		// commondir resolves to — would refuse writes for no live store.
		let temp = init(&[("keep.txt", b"base\n"), ("data/x.txt", b"x\n")]);
		let fake = temp.path().join("fake-gitdir");
		fs::create_dir(&fake).expect("mkdir fake gitdir");
		fs::write(fake.join("HEAD"), b"ref: refs/heads/main\n").expect("write HEAD");
		fs::write(fake.join("commondir"), b"../data\n").expect("write commondir");
		fs::create_dir(temp.path().join("sub")).expect("mkdir sub");
		fs::write(temp.path().join("sub/.git"), b"gitdir: ../fake-gitdir\n").expect("write gitfile");

		assert!(
			gitfile_stores(&fake).is_empty(),
			"a gitdir whose commondir lacks objects/ and refs/ is not a store"
		);
		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/data/y.txt b/data/y.txt\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/data/y.txt\n",
			"@@ -0,0 +1 @@\n",
			"+y\n",
		);
		repository
			.apply_patch(patch, &ApplyOptions::default())
			.expect("the directory a dangling commondir points at is writable");
	}

	#[test]
	fn error_kind_stays_usable_in_a_const_context() {
		// Downstream code classifies in const/static initializers; narrowing
		// the API would break it silently.
		const CANCELED: &str = Error::Canceled.kind();
		assert_eq!(CANCELED, "Canceled");
		assert_eq!(Error::PathInGitStore { path: "a".to_owned() }.kind(), "PathInGitStore");
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_folds_case_and_separators_when_matching_a_minted_symlink() {
		// `Link` and `link` are the same directory on the case-insensitive
		// filesystems macOS and Windows default to, and `link\\file` is a path
		// on Windows. An exact comparison misses both, so the descendant is
		// refused only after the link has been created.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let repository = repo(temp.path());

		for descendant in ["link/sneaky.txt", "Link/sneaky.txt", "link\\sneaky.txt"] {
			let patch = format!(
				concat!(
					"diff --git a/Link b/Link\n",
					"new file mode 120000\n",
					"--- /dev/null\n",
					"+++ b/Link\n",
					"@@ -0,0 +1 @@\n",
					"+{}\n",
					"\\ No newline at end of file\n",
					"diff --git a/{} b/{}\n",
					"new file mode 100644\n",
					"--- /dev/null\n",
					"+++ b/{}\n",
					"@@ -0,0 +1 @@\n",
					"+pwned\n",
				),
				outside.path().display(),
				descendant,
				descendant,
				descendant,
			);
			assert!(
				repository
					.apply_patch(&patch, &ApplyOptions::default())
					.is_err(),
				"spelling {descendant:?} slipped past the minted link"
			);
			assert!(
				!temp.path().join("Link").symlink_metadata().is_ok(),
				"the link was created before {descendant:?} was refused"
			);
			assert!(!outside.path().join("sneaky.txt").exists(), "wrote through the minted link");
		}
	}

	#[test]
	fn normalize_repo_path_folds_case_dots_and_both_separators() {
		assert_eq!(normalize_repo_path("./Link/File.txt"), "link/file.txt");
		assert_eq!(normalize_repo_path("link\\file.txt"), "link/file.txt");
		assert_eq!(normalize_repo_path("LINK//./file.txt"), "link/file.txt");
		// Distinct hierarchies stay distinct.
		assert_ne!(normalize_repo_path("linkx/file.txt"), normalize_repo_path("link/file.txt"));
	}

	#[test]
	fn validate_repo_path_keeps_format_characters_git_does_not_fold() {
		// Folding the whole `Cf` category rejects paths git accepts, and then
		// every later operation that rewrites an index containing one fails —
		// an unrelated cherry-pick included. Verified against `git
		// update-index`: U+2060 is accepted by git even under protectHFS.
		assert!(validate_repo_path(".g\u{2060}it/file").is_ok());
		assert!(validate_repo_path("a\u{00ad}b/notes.txt").is_ok());
		// The set git DOES fold stays refused.
		assert!(validate_repo_path(".g\u{200c}it/file").is_err());
		assert!(validate_repo_path(".g\u{206f}it/file").is_err());
	}

	#[test]
	fn apply_patch_refuses_a_linked_worktrees_common_store() {
		// A linked worktree's `.git` points at `meta/worktrees/<name>`, and git
		// reads `commondir` from there to find `meta` — where the hooks live.
		// The worktree is created OUTSIDE the outer root and only its checkout
		// moved in, so the only pointer the scanner can see is the linked one.
		//
		// What this pins is the OUTCOME, not one guard: `meta` is also
		// bare-shaped, so `is_bare_store` catches it first and the commondir
		// resolution is defence in depth behind it. Removing either alone
		// leaves the patch refused; removing both lets it through, which is
		// what this test fails on.
		let temp = init(&[("keep.txt", b"base\n")]);
		let host = tempfile::tempdir().expect("host tempdir");
		git(host.path(), &["init", "-q", "--separate-git-dir=meta", "inner"]);
		let inner = host.path().join("inner");
		git(&inner, &["config", "user.email", "test@example.com"]);
		git(&inner, &["config", "user.name", "Test"]);
		fs::write(inner.join("f.txt"), b"x\n").expect("seed inner");
		git(&inner, &["add", "f.txt"]);
		git(&inner, &["commit", "-m", "seed"]);
		git(&inner, &["worktree", "add", "-q", "../wt"]);

		// Move only the linked checkout into the worktree under test, and put
		// the common store where the patch will aim.
		std::fs::rename(host.path().join("wt"), temp.path().join("wt")).expect("move worktree");
		std::fs::rename(host.path().join("meta"), temp.path().join("meta")).expect("move store");
		let pointer = temp.path().join("wt/.git");
		fs::write(&pointer, format!("gitdir: {}\n", temp.path().join("meta/worktrees/wt").display()))
			.expect("repoint");

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/meta/hooks/pre-commit b/meta/hooks/pre-commit\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/meta/hooks/pre-commit\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"patch installed a hook into a linked worktree's common store"
		);
		assert!(!temp.path().join("meta/hooks/pre-commit").exists(), "hook was written");
	}

	#[test]
	fn apply_patch_refuses_a_nested_bare_repository() {
		// `git init --bare bare` leaves the store itself on disk under an
		// arbitrary name, with no `.git` file to discover it by. Its hooks run
		// when the repository receives a push.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--bare", "inner.git"]);

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/inner.git/hooks/pre-receive b/inner.git/hooks/pre-receive\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/inner.git/hooks/pre-receive\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"patch installed a hook into a nested bare repository"
		);
		assert!(!temp.path().join("inner.git/hooks/pre-receive").exists(), "hook was written");
	}

	#[test]
	fn nested_store_discovery_sees_repositories_created_after_an_earlier_operation() {
		// A process-global cache in a long-lived agent would never see a store
		// created after its first scan, and an untrusted patch could then reach
		// that store's hooks.
		let temp = init(&[("keep.txt", b"base\n")]);
		let repository = repo(temp.path());
		let benign = concat!(
			"diff --git a/keep.txt b/keep.txt\n",
			"--- a/keep.txt\n",
			"+++ b/keep.txt\n",
			"@@ -1 +1 @@\n",
			"-base\n",
			"+edited\n",
		);
		repository
			.apply_patch(benign, &ApplyOptions::default())
			.expect("first operation");

		// Only now does the nested store exist.
		git(temp.path(), &["init", "-q", "--bare", "later.git"]);
		let attack = concat!(
			"diff --git a/later.git/hooks/pre-receive b/later.git/hooks/pre-receive\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/later.git/hooks/pre-receive\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		assert!(
			repository
				.apply_patch(attack, &ApplyOptions::default())
				.is_err(),
			"a store created after the first scan was not discovered"
		);
		assert!(!temp.path().join("later.git/hooks/pre-receive").exists(), "hook was written");
	}

	#[test]
	#[cfg(unix)]
	fn stash_push_refuses_before_reading_through_an_escaping_prefix() {
		use std::os::unix::fs::symlink;

		// `tracked_worktree_map` opens every indexed path, so an indexed
		// `dir/file` shadowed by an outbound `dir` is slurped from outside the
		// worktree and hashed into a loose blob before any later check refuses
		// it. A large enough file exhausts memory or disk on the way.
		let temp = init(&[("keep.txt", b"base\n"), ("dir/file.txt", b"tracked\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		fs::write(outside.path().join("file.txt"), b"classified\n").expect("external file");
		fs::remove_file(temp.path().join("dir/file.txt")).expect("drop file");
		fs::remove_dir(temp.path().join("dir")).expect("drop dir");
		symlink(outside.path(), temp.path().join("dir")).expect("shadow the prefix");

		let repository = repo(temp.path());
		let objects_before = loose_object_count(temp.path());
		assert!(repository.stash_push(Some("wip")).is_err(), "stash must refuse the escaping prefix");
		assert_eq!(
			loose_object_count(temp.path()),
			objects_before,
			"external content was read into the object store before the refusal"
		);
	}

	#[test]
	#[cfg(unix)]
	fn patch_and_probe_refuse_an_unrelated_escaping_indexed_prefix_before_reading() {
		use std::os::unix::fs::symlink;

		let temp = init(&[("keep.txt", b"base\n"), ("escape/file", b"tracked\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		fs::write(outside.path().join("file"), b"external secret\n").expect("outside file");
		fs::remove_file(temp.path().join("escape/file")).expect("remove tracked file");
		fs::remove_dir(temp.path().join("escape")).expect("remove directory");
		symlink(outside.path(), temp.path().join("escape")).expect("shadow indexed prefix");
		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/keep.txt b/keep.txt\n",
			"--- a/keep.txt\n+++ b/keep.txt\n",
			"@@ -1 +1 @@\n-base\n+changed\n",
		);
		let objects_before = loose_object_count(temp.path());
		assert!(matches!(
			repository.can_apply_patch(patch, &ApplyOptions::default()),
			Err(Error::PathEscapesRoot { .. }) | Ok(false)
		));
		assert!(matches!(
			repository.apply_patch(patch, &ApplyOptions::default()),
			Err(Error::PathEscapesRoot { .. })
		));
		assert_eq!(loose_object_count(temp.path()), objects_before, "external bytes were persisted");
		assert_eq!(fs::read(temp.path().join("keep.txt")).expect("unchanged file"), b"base\n");
	}

	#[test]
	#[cfg(unix)]
	fn stash_push_refuses_an_untracked_separate_store_before_reading_it() {
		// `git init --separate-git-dir=meta sub` leaves `meta/` untracked as far
		// as the outer repository is concerned. Its packs must not be opened,
		// hashed and written as loose blobs — nor a stash tree minted on top —
		// only for the path to be refused afterwards.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--separate-git-dir=meta", "sub"]);
		fs::write(temp.path().join("meta/objects/pack/big.pack"), vec![0u8; 256 * 1024])
			.expect("fake pack");

		let repository = repo(temp.path());
		let objects_before = loose_object_count(temp.path());
		assert!(repository.stash_push(Some("wip")).is_err(), "stash must refuse the nested store");
		assert_eq!(
			loose_object_count(temp.path()),
			objects_before,
			"nested store content was hashed into the outer object store before the refusal"
		);
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_accepts_a_child_under_a_link_the_same_patch_deletes_first() {
		use std::os::unix::fs::symlink;

		// The write loop unlinks each entry's source before writing its target,
		// in patch order. A patch that deletes tracked outbound `dir` and then
		// adds regular `dir/file` never resolves through the link; judging the
		// child against the current filesystem rejects a valid patch.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		symlink(outside.path(), temp.path().join("dir")).expect("create symlink");
		git(temp.path(), &["add", "dir"]);
		git(temp.path(), &["commit", "-m", "track outbound symlink"]);

		let repository = repo(temp.path());
		let patch = format!(
			concat!(
				"diff --git a/dir b/dir\n",
				"deleted file mode 120000\n",
				"--- a/dir\n",
				"+++ /dev/null\n",
				"@@ -1 +0,0 @@\n",
				"-{}\n",
				"\\ No newline at end of file\n",
				"diff --git a/dir/file.txt b/dir/file.txt\n",
				"new file mode 100644\n",
				"--- /dev/null\n",
				"+++ b/dir/file.txt\n",
				"@@ -0,0 +1 @@\n",
				"+real\n",
			),
			outside.path().display(),
		);
		repository
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("a child under a link deleted earlier in the same patch is safe");
		assert!(temp.path().join("dir").is_dir(), "the link was not replaced by a directory");
		assert_eq!(fs::read(temp.path().join("dir/file.txt")).expect("read"), b"real\n");
		assert!(!outside.path().join("file.txt").exists(), "wrote through the deleted link");

		// Order matters: the same two entries reversed create the child
		// through the still-present link and must be refused.
		let temp = init(&[("keep.txt", b"base\n")]);
		symlink(outside.path(), temp.path().join("dir")).expect("create symlink");
		git(temp.path(), &["add", "dir"]);
		git(temp.path(), &["commit", "-m", "track outbound symlink"]);
		let repository = repo(temp.path());
		let reversed = format!(
			concat!(
				"diff --git a/dir/file.txt b/dir/file.txt\n",
				"new file mode 100644\n",
				"--- /dev/null\n",
				"+++ b/dir/file.txt\n",
				"@@ -0,0 +1 @@\n",
				"+real\n",
				"diff --git a/dir b/dir\n",
				"deleted file mode 120000\n",
				"--- a/dir\n",
				"+++ /dev/null\n",
				"@@ -1 +0,0 @@\n",
				"-{}\n",
				"\\ No newline at end of file\n",
			),
			outside.path().display(),
		);
		assert!(
			repository
				.apply_patch(&reversed, &ApplyOptions::default())
				.is_err(),
			"a removal AFTER the child does not make the child safe"
		);
		assert!(!outside.path().join("file.txt").exists(), "wrote through the link");
	}

	#[test]
	fn stash_index_refusal_preserves_worktree_index_and_stash() {
		let temp = init(&[("keep.txt", b"base\n")]);
		let repository = repo(temp.path());
		let gix_repo = repository.gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_id = head.id().detach();
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let blob = gix_repo
			.write_blob(b"staged\n")
			.expect("staged blob")
			.detach();
		let child = gix_repo
			.write_object(&gix::objs::Tree {
				entries: vec![gix::objs::tree::Entry {
					mode:     EntryKind::Blob.into(),
					filename: "file".into(),
					oid:      blob,
				}],
			})
			.expect("child tree")
			.detach();
		let mut index_tree = gix_repo
			.find_tree(head_tree)
			.expect("base tree")
			.decode()
			.expect("decode tree")
			.to_owned();
		index_tree.entries.push(gix::objs::tree::Entry {
			mode:     EntryKind::Tree.into(),
			// A spelling gix's tree validation ACCEPTS (it applies HFS folding
			// and NTFS trailing-dot trimming separately) but our per-component
			// policy refuses (it composes them): `.git` + U+200C + `.` reaches
			// the store on a mount that both ignores the joiner and trims the
			// dot. It has to be one gix will write into a tree, or the merge
			// rejects it first and this test proves nothing about the guard.
			filename: ".git\u{200c}.".into(),
			oid:      child,
		});
		index_tree.entries.sort();
		let index_tree = gix_repo
			.write_object(&index_tree)
			.expect("legacy index tree")
			.detach();
		let index_commit = gix_repo
			.new_commit("legacy index", index_tree, [head_id])
			.expect("index commit")
			.id()
			.detach();
		let mut restored = tree_map(&gix_repo, head_tree).expect("base map");
		restored.get_mut("keep.txt").expect("tracked file").id = blob;
		let restored_tree = write_tree_map(&gix_repo, &restored).expect("restored tree");
		let stash = gix_repo
			.new_commit("legacy stash", restored_tree, [head_id, index_commit])
			.expect("stash commit")
			.id()
			.detach();
		update_stash_ref(&gix_repo, stash, PreviousValue::Any, "legacy stash".to_owned(), true)
			.expect("stash ref");
		let index_before = fs::read(gix_repo.git_dir().join("index")).expect("index before");
		let log_before = fs::read(gix_repo.common_dir().join("logs/refs/stash")).expect("stash log");

		assert!(repository.stash_try_pop(true).is_err(), "unsafe index must be refused");
		assert_eq!(fs::read(temp.path().join("keep.txt")).expect("tracked file"), b"base\n");
		assert_eq!(fs::read(gix_repo.git_dir().join("index")).expect("index"), index_before);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]).trim(), head_id.to_string());
		assert_eq!(git(temp.path(), &["rev-parse", "refs/stash"]).trim(), stash.to_string());
		assert_eq!(
			fs::read(gix_repo.common_dir().join("logs/refs/stash")).expect("stash log"),
			log_before
		);
		assert!(
			repository
				.stash_try_pop(false)
				.expect("pop without reinstating index")
		);
		assert_eq!(fs::read(temp.path().join("keep.txt")).expect("restored file"), b"staged\n");
	}

	/// Commit a tree that pairs an outbound symlink with a regular file whose
	/// path is a case-alias descendant of it — the shape a Linux-authored tree
	/// takes when checked out on the case-insensitive macOS default.
	#[cfg(unix)]
	fn commit_case_aliased_symlink_tree(temp: &TempDir, outside: &Path) -> String {
		let gix_repo = repo(temp.path()).gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let mut map = tree_map(&gix_repo, head_tree).expect("base map");
		let link = gix_repo
			.write_blob(outside.as_os_str().as_encoded_bytes())
			.expect("link blob")
			.detach();
		let file = gix_repo.write_blob(b"pwned\n").expect("file blob").detach();
		map.insert("Link".to_owned(), FileEntry::new(link, Mode::SYMLINK));
		map.insert("link/file.txt".to_owned(), FileEntry::new(file, Mode::FILE));
		let tree = write_tree_map(&gix_repo, &map).expect("aliased tree");
		gix_repo
			.new_commit("aliased", tree, [head.id().detach()])
			.expect("aliased commit")
			.id()
			.to_string()
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_refuses_a_case_aliased_symlink_descendant_before_moving_head() {
		// `Link` and `link/file.txt` are distinct on the filesystem that
		// authored them and one hierarchy on the one applying them. Judging
		// each against the CURRENT filesystem misses the relationship: the
		// write pass creates the link first and refuses the child afterwards,
		// by which point HEAD has already advanced.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let picked = commit_case_aliased_symlink_tree(&temp, outside.path());
		let head_before = git(temp.path(), &["rev-parse", "HEAD"]);
		let repository = repo(temp.path());

		assert!(repository.cherry_pick(&picked).is_err(), "aliased descendant must be refused");
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head_before, "HEAD moved");
		assert!(temp.path().join("Link").symlink_metadata().is_err(), "the link was minted");
		assert!(!outside.path().join("file.txt").exists(), "wrote through the minted link");
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_folds_canonical_equivalence_when_matching_a_minted_symlink() {
		// macOS normalizes names, so a minted `é` (U+00E9) and a later target
		// under `e` + U+0301 are one directory entry. Scalar lowercasing leaves
		// them byte-distinct and the descendant slips past the preflight.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let repository = repo(temp.path());
		let patch = format!(
			concat!(
				"diff --git a/\u{e9} b/\u{e9}\n",
				"new file mode 120000\n",
				"--- /dev/null\n",
				"+++ b/\u{e9}\n",
				"@@ -0,0 +1 @@\n",
				"+{}\n",
				"\\ No newline at end of file\n",
				"diff --git a/e\u{301}/sneaky.txt b/e\u{301}/sneaky.txt\n",
				"new file mode 100644\n",
				"--- /dev/null\n",
				"+++ b/e\u{301}/sneaky.txt\n",
				"@@ -0,0 +1 @@\n",
				"+pwned\n",
			),
			outside.path().display(),
		);
		assert!(
			repository
				.apply_patch(&patch, &ApplyOptions::default())
				.is_err(),
			"a decomposed spelling must not slip past the composed minted link"
		);
		assert!(
			temp.path().join("\u{e9}").symlink_metadata().is_err(),
			"the link was created before the descendant was refused"
		);
		assert!(!outside.path().join("sneaky.txt").exists(), "wrote through the minted link");
	}

	#[test]
	fn normalize_repo_path_folds_canonical_equivalence_and_case_together() {
		assert_eq!(normalize_repo_path("e\u{301}/File"), normalize_repo_path("\u{e9}/file"));
		assert_eq!(normalize_repo_path("\u{c9}/x"), normalize_repo_path("\u{e9}/x"));
		assert_ne!(normalize_repo_path("e/x"), normalize_repo_path("\u{e9}/x"));
	}

	#[test]
	#[cfg(unix)]
	fn patch_refuses_casefold_aliases_of_a_minted_store_link() {
		for (link, alias) in [("Σ", "ς"), ("ß", "ss"), ("ᾀ", "ἀι")] {
			let temp = init(&[("keep.txt", b"base\n")]);
			let config = fs::read(temp.path().join(".git/config")).expect("config");
			let patch = format!(
				"diff --git a/{link} b/{link}\nnew file mode 120000\n--- /dev/null\n+++ b/{link}\n@@ \
				 -0,0 +1 @@\n+.git\n\\ No newline at end of file\ndiff --git a/{alias}/config \
				 b/{alias}/config\nnew file mode 100644\n--- /dev/null\n+++ b/{alias}/config\n@@ -0,0 \
				 +1 @@\n+payload\n"
			);
			assert!(
				repo(temp.path())
					.apply_patch(&patch, &ApplyOptions::default())
					.is_err()
			);
			assert_eq!(fs::read(temp.path().join(".git/config")).expect("config"), config);
			assert!(fs::symlink_metadata(temp.path().join(link)).is_err(), "partial application");
		}
	}

	#[test]
	#[cfg(unix)]
	fn patch_rename_can_replace_its_source_link_with_a_directory() {
		use std::os::unix::fs::symlink;

		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside");
		symlink(outside.path(), temp.path().join("dir")).expect("link");
		git(temp.path(), &["add", "dir"]);
		git(temp.path(), &["commit", "-m", "track link"]);
		let patch = "diff --git a/dir b/dir/file\nsimilarity index 100%\nrename from dir\nrename to \
		             dir/file\n";
		let repository = repo(temp.path());
		assert!(
			repository
				.can_apply_patch(patch, &ApplyOptions::default())
				.expect("probe")
		);
		repository
			.apply_patch(patch, &ApplyOptions::default())
			.expect("rename");
		assert!(temp.path().join("dir").is_dir());
		assert_eq!(fs::read_link(temp.path().join("dir/file")).expect("moved link"), outside.path());
		assert!(!outside.path().join("file").exists());
	}

	#[test]
	#[cfg(unix)]
	fn nested_store_discovery_does_not_open_a_fifo_named_dot_git() {
		// A FIFO named `.git` is not a gitfile, but `is_dir()` is false for it
		// too, and a plain `read_to_string` blocks every apply, cherry-pick and
		// stash preflight until something writes to the pipe.
		let temp = init(&[("keep.txt", b"base\n")]);
		let dir = temp.path().join("sub");
		fs::create_dir(&dir).expect("nested dir");
		let fifo = std::ffi::CString::new(dir.join(".git").as_os_str().as_encoded_bytes())
			.expect("fifo path");
		// SAFETY: `fifo` is a valid NUL-terminated path for the duration of the
		// call and `mkfifo` does not retain it.
		assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "mkfifo");

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/keep.txt b/keep.txt\n",
			"--- a/keep.txt\n",
			"+++ b/keep.txt\n",
			"@@ -1 +1 @@\n",
			"-base\n",
			"+edited\n",
		);
		// Would hang forever before the fix; a bounded, non-following read
		// simply skips the entry and the unrelated patch applies.
		repository
			.apply_patch(patch, &ApplyOptions::default())
			.expect("discovery must not block on a FIFO");
		assert_eq!(fs::read(temp.path().join("keep.txt")).expect("edited"), b"edited\n");
	}

	#[test]
	fn store_metadata_reads_are_bounded_and_never_follow_links() {
		// Metadata found in a worktree is untrusted. A `.git` FILE holds one
		// short `gitdir:` line; anything larger is not a gitfile and must not
		// be slurped into memory, and a symlink named `.git` must not be
		// followed to wherever it points.
		let temp = init(&[("keep.txt", b"base\n")]);
		let mut huge = b"gitdir: ../elsewhere".to_vec();
		huge.resize(1024 * 1024, b'x');
		fs::write(temp.path().join("huge"), huge).expect("oversized metadata");
		assert!(read_store_metadata(&temp.path().join("huge")).is_none(), "oversized file was read");

		let small = temp.path().join("small");
		fs::write(&small, b"gitdir: meta\n").expect("small metadata");
		assert_eq!(read_store_metadata(&small).as_deref(), Some(&b"gitdir: meta\n"[..]));

		#[cfg(unix)]
		{
			let link = temp.path().join("link");
			std::os::unix::fs::symlink(&small, &link).expect("metadata symlink");
			assert!(read_store_metadata(&link).is_none(), "symlinked metadata was followed");
		}
	}

	#[test]
	fn ordinary_directory_with_head_objects_and_refs_is_not_a_store() {
		// `HEAD`, `objects/` and `refs/` are not exotic names. A project that
		// happens to use all three is not a bare repository, and refusing
		// every write beneath it would break that project for no reason.
		let temp = init(&[("keep.txt", b"base\n")]);
		let dir = temp.path().join("lookalike");
		fs::create_dir_all(dir.join("objects")).expect("objects dir");
		fs::create_dir_all(dir.join("refs")).expect("refs dir");
		fs::write(dir.join("HEAD"), b"this is a header file, not a git ref\n").expect("HEAD");

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/lookalike/objects/note.txt b/lookalike/objects/note.txt\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/lookalike/objects/note.txt\n",
			"@@ -0,0 +1 @@\n",
			"+not a git object\n",
		);
		repository
			.apply_patch(patch, &ApplyOptions::default())
			.expect("a look-alike directory must stay writable");
		assert!(temp.path().join("lookalike/objects/note.txt").is_file(), "patch was refused");
	}

	#[test]
	fn bare_store_recognition_requires_a_valid_head() {
		// Positive: what `git init --bare` produces. Negative: the same layout
		// with a HEAD that is neither a symbolic ref nor an object id.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--bare", "real.git"]);
		assert!(is_bare_store(&temp.path().join("real.git")), "real bare store not recognized");

		let fake = temp.path().join("fake");
		fs::create_dir_all(fake.join("objects")).expect("objects dir");
		fs::create_dir_all(fake.join("refs")).expect("refs dir");
		fs::write(fake.join("HEAD"), b"nonsense\n").expect("HEAD");
		assert!(!is_bare_store(&fake), "garbage HEAD was accepted as a store");
	}

	/// A stash whose tracked half restores an outbound symlink named
	/// `link_name`, and whose untracked half restores `untracked_path`. Built
	/// directly, not via `stash_push`, because the interesting stashes are the
	/// ones authored on a filesystem with different rules than the one popping.
	#[cfg(unix)]
	fn stash_with_symlink_and_untracked(
		temp: &TempDir,
		outside: &Path,
		link_name: &str,
		untracked_path: &str,
	) -> gix::ObjectId {
		let gix_repo = repo(temp.path()).gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_id = head.id().detach();
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let link = gix_repo
			.write_blob(outside.as_os_str().as_encoded_bytes())
			.expect("link blob")
			.detach();
		let mut tracked = tree_map(&gix_repo, head_tree).expect("base map");
		tracked.insert(link_name.to_owned(), FileEntry::new(link, Mode::SYMLINK));
		let tracked_tree = write_tree_map(&gix_repo, &tracked).expect("tracked tree");
		let index_commit = gix_repo
			.new_commit("index", head_tree, [head_id])
			.expect("index commit")
			.id()
			.detach();
		let file = gix_repo
			.write_blob(b"pwned\n")
			.expect("untracked blob")
			.detach();
		let mut untracked = BTreeMap::new();
		untracked.insert(untracked_path.to_owned(), FileEntry::new(file, Mode::FILE));
		let untracked_tree = write_tree_map(&gix_repo, &untracked).expect("untracked tree");
		let untracked_commit = gix_repo
			.new_commit("untracked", untracked_tree, std::iter::empty::<gix::ObjectId>())
			.expect("untracked commit")
			.id()
			.detach();
		let stash = gix_repo
			.new_commit("stash", tracked_tree, [head_id, index_commit, untracked_commit])
			.expect("stash commit")
			.id()
			.detach();
		update_stash_ref(&gix_repo, stash, PreviousValue::Any, "stash".to_owned(), true)
			.expect("stash ref");
		stash
	}

	#[test]
	#[cfg(unix)]
	fn stash_pop_refuses_an_untracked_descendant_of_a_restored_link_before_writing() {
		// The tracked half restores an outbound `é` (NFC) link; the untracked
		// half restores `e◌́/u` (NFD). On a normalizing filesystem that is a
		// write THROUGH the link — but the link does not exist yet when the
		// untracked loop consults the filesystem, so both halves used to pass
		// and the refusal landed after the tracked half was written.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let stash =
			stash_with_symlink_and_untracked(&temp, outside.path(), "\u{e9}", "e\u{301}/u.txt");
		let repository = repo(temp.path());

		assert!(
			repository.stash_try_pop(false).is_err(),
			"descendant of restored link must be refused"
		);
		assert!(temp.path().join("\u{e9}").symlink_metadata().is_err(), "tracked link was restored");
		assert!(!outside.path().join("u.txt").exists(), "wrote through the restored link");
		assert_eq!(git(temp.path(), &["rev-parse", "refs/stash"]).trim(), stash.to_string());
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_accepts_a_child_replacing_a_removed_link_under_another_spelling() {
		use std::os::unix::fs::symlink;

		// HEAD tracks an outbound `é` (NFC) link; the pick replaces it with a
		// regular `e◌́/file.txt` (NFD). The write pass removes the link before
		// creating the child, so the operation is safe — but a removal set
		// keyed on raw strings never matches the NFD child's ancestor, and the
		// preflight resolves through the still-present link and refuses.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		symlink(outside.path(), temp.path().join("\u{e9}")).expect("track a link");
		git(temp.path(), &["add", "-A"]);
		git(temp.path(), &["commit", "-qm", "link"]);

		let gix_repo = repo(temp.path()).gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let mut map = tree_map(&gix_repo, head.tree_id().expect("tree").detach()).expect("map");
		map.remove("\u{e9}").expect("link tracked");
		let file = gix_repo.write_blob(b"child\n").expect("blob").detach();
		map.insert("e\u{301}/file.txt".to_owned(), FileEntry::new(file, Mode::FILE));
		let tree = write_tree_map(&gix_repo, &map).expect("tree");
		let picked = gix_repo
			.new_commit("replace", tree, [head.id().detach()])
			.expect("commit")
			.id()
			.to_string();

		repo(temp.path())
			.cherry_pick(&picked)
			.expect("replacing a removed link under another spelling is safe");
		assert!(temp.path().join("e\u{301}/file.txt").is_file(), "child was not written");
		assert!(!outside.path().join("file.txt").exists(), "wrote through the old link");
	}

	#[test]
	fn stale_store_scan_preserves_newer_results_for_all_roots() {
		let mut cache = FastHashMap::default();
		let store =
			|name: &str| Arc::new(StoreSet { stores: vec![PathBuf::from(name)], complete: true });
		let (old, new, other) = (store("old-store"), store("new-store"), store("other-store"));
		publish_store_scan(&mut cache, Path::new("a"), 2, 2, &new);
		publish_store_scan(&mut cache, Path::new("b"), 2, 2, &other);
		// Operation 1 finishes after operation 2 has populated both roots.
		publish_store_scan(&mut cache, Path::new("a"), 1, 2, &old);
		assert_eq!(cache[Path::new("a")].1.stores, new.stores);
		assert_eq!(cache[Path::new("b")].1.stores, other.stores);
		assert_eq!(cache[Path::new("a")].0, 2);
	}

	#[test]
	#[cfg(unix)]
	fn patch_refuses_a_regular_entry_aliasing_a_symlink_the_same_patch_mints() {
		// `Link -> .git/config` and regular `link` are two entries on the
		// filesystem that authored them and ONE on a case-insensitive target,
		// where the link is created first and the regular write follows it.
		let temp = init(&[("keep.txt", b"base\n")]);
		let config = fs::read(temp.path().join(".git/config")).expect("config");
		let patch = concat!(
			"diff --git a/Link b/Link\n",
			"new file mode 120000\n",
			"--- /dev/null\n",
			"+++ b/Link\n",
			"@@ -0,0 +1 @@\n",
			"+.git/config\n",
			"\\ No newline at end of file\n",
			"diff --git a/link b/link\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/link\n",
			"@@ -0,0 +1 @@\n",
			"+payload\n",
		);
		let repository = repo(temp.path());
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"a regular entry aliasing a minted symlink must be refused"
		);
		assert_eq!(
			fs::read(temp.path().join(".git/config")).expect("config"),
			config,
			"the regular write followed the minted link into the store"
		);
		assert!(
			fs::symlink_metadata(temp.path().join("Link")).is_err(),
			"the link was created before the alias was refused"
		);
	}

	#[test]
	#[cfg(unix)]
	fn patch_still_accepts_the_symlink_entry_that_owns_its_own_key() {
		// The equality rule must not refuse the link itself: repointing a
		// tracked outbound symlink is a valid patch.
		use std::os::unix::fs::symlink;

		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let newer = tempfile::tempdir().expect("newer tempdir");
		symlink(outside.path(), temp.path().join("link")).expect("create symlink");
		git(temp.path(), &["add", "link"]);
		git(temp.path(), &["commit", "-m", "track link"]);
		let patch = format!(
			concat!(
				"diff --git a/link b/link\n",
				"index 1111111..2222222 120000\n",
				"--- a/link\n",
				"+++ b/link\n",
				"@@ -1 +1 @@\n",
				"-{}\n",
				"\\ No newline at end of file\n",
				"+{}\n",
				"\\ No newline at end of file\n",
			),
			outside.path().display(),
			newer.path().display(),
		);
		repo(temp.path())
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("repointing a tracked outbound symlink is valid");
		assert_eq!(fs::read_link(temp.path().join("link")).expect("link"), newer.path());
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_refuses_two_distinct_symlinks_sharing_one_normalized_key() {
		// `Link -> x` and `link -> y` are two entries where they were authored
		// and ONE on a case-insensitive target: the second write replaces the
		// first while HEAD and the index still name both, so the pick would
		// report success against a worktree that does not match.
		let temp = init(&[("keep.txt", b"base\n")]);
		let first = tempfile::tempdir().expect("first target");
		let second = tempfile::tempdir().expect("second target");
		let gix_repo = repo(temp.path()).gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let mut map = tree_map(&gix_repo, head_tree).expect("base map");
		let upper = gix_repo
			.write_blob(first.path().as_os_str().as_encoded_bytes())
			.expect("first blob")
			.detach();
		let lower = gix_repo
			.write_blob(second.path().as_os_str().as_encoded_bytes())
			.expect("second blob")
			.detach();
		map.insert("Link".to_owned(), FileEntry::new(upper, Mode::SYMLINK));
		map.insert("link".to_owned(), FileEntry::new(lower, Mode::SYMLINK));
		let tree = write_tree_map(&gix_repo, &map).expect("colliding tree");
		let picked = gix_repo
			.new_commit("colliding links", tree, [head.id().detach()])
			.expect("commit")
			.id()
			.to_string();
		let head_before = git(temp.path(), &["rev-parse", "HEAD"]);

		assert!(
			repo(temp.path()).cherry_pick(&picked).is_err(),
			"two symlinks sharing one normalized key must be refused"
		);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head_before, "HEAD moved");
		assert!(fs::symlink_metadata(temp.path().join("Link")).is_err(), "a link was created");
	}

	#[test]
	#[cfg(unix)]
	fn stash_pop_restores_an_untracked_child_under_a_link_the_tracked_half_deletes() {
		use std::os::unix::fs::symlink;

		// `dir` is a tracked outbound symlink, PRESENT on disk at pop time.
		// The stash's tracked half deletes it and its untracked half restores
		// `dir/u`. `write_worktree_map` unlinks `dir` before the untracked
		// entry is created, so resolving the current `dir` judges a topology
		// the restore never sees and rejects a safe pop.
		let temp = init(&[("keep.txt", b"base\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		symlink(outside.path(), temp.path().join("dir")).expect("create symlink");
		git(temp.path(), &["add", "dir"]);
		git(temp.path(), &["commit", "-m", "track outbound link"]);

		let repository = repo(temp.path());
		let gix_repo = repository.gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_id = head.id().detach();
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		// Tracked half: HEAD without `dir`, so the pop deletes it.
		let mut tracked = tree_map(&gix_repo, head_tree).expect("base map");
		tracked.remove("dir");
		let tracked_tree = write_tree_map(&gix_repo, &tracked).expect("tracked tree");
		// Untracked half: a regular child beneath the doomed link.
		let child = gix_repo
			.write_blob(b"child\n")
			.expect("child blob")
			.detach();
		let mut untracked = BTreeMap::new();
		untracked.insert("dir/u".to_owned(), FileEntry::new(child, Mode::FILE));
		let untracked_tree = write_tree_map(&gix_repo, &untracked).expect("untracked tree");
		let index_commit = gix_repo
			.new_commit("index on HEAD: wip", tracked_tree, [head_id])
			.expect("index commit");
		let untracked_commit = gix_repo
			.new_commit("untracked files on HEAD", untracked_tree, std::iter::empty::<gix::ObjectId>())
			.expect("untracked commit");
		let stash = gix_repo
			.new_commit("wip", tracked_tree, [
				head_id,
				index_commit.id().detach(),
				untracked_commit.id().detach(),
			])
			.expect("stash commit");
		update_stash_ref(
			&gix_repo,
			stash.id().detach(),
			PreviousValue::Any,
			"On HEAD: wip".to_owned(),
			true,
		)
		.expect("install stash");
		assert!(
			temp.path().join("dir").symlink_metadata().is_ok(),
			"the doomed link must be present at pop time"
		);

		assert!(repository.stash_try_pop(false).expect("pop"), "pop refused a safe restore");
		assert_eq!(
			fs::read(temp.path().join("dir/u")).expect("restored child"),
			b"child\n",
			"the untracked child was not restored"
		);
		assert!(temp.path().join("dir").is_dir(), "the link was not replaced by a directory");
		assert!(!outside.path().join("u").exists(), "wrote through the deleted link");
	}

	#[test]
	fn cached_patch_refuses_a_hook_in_a_separate_git_dir() {
		// `--cached` writes only the index, so the worktree preflight does not
		// run — but `meta/` is a live store, and a later checkout would
		// materialize a staged hook over the real one.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--separate-git-dir=meta", "sub"]);
		let patch = concat!(
			"diff --git a/meta/hooks/pre-commit b/meta/hooks/pre-commit\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/meta/hooks/pre-commit\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		let repository = repo(temp.path());
		let options = ApplyOptions { cached: true, ..ApplyOptions::default() };
		assert!(
			repository.apply_patch(patch, &options).is_err(),
			"a staged path inside a live store must be refused"
		);
		assert!(
			!repository.can_apply_patch(patch, &options).expect("probe"),
			"the probe must agree with the applier"
		);
		assert!(
			!git(temp.path(), &["ls-files"]).contains("meta/hooks"),
			"the hook was staged into the index"
		);
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_replaces_a_doomed_store_link_with_a_directory() {
		use std::os::unix::fs::symlink;

		// `dir -> .git` is tracked and deleted by this patch before `dir/file`
		// is created, so the write never reaches the store. Resolving the
		// doomed ancestor makes the safe child look like a write into `.git`.
		let temp = init(&[("keep.txt", b"base\n")]);
		symlink(".git", temp.path().join("dir")).expect("link into the store");
		git(temp.path(), &["add", "dir"]);
		git(temp.path(), &["commit", "-m", "track store link"]);
		let config = fs::read(temp.path().join(".git/config")).expect("config");

		let repository = repo(temp.path());
		let patch = concat!(
			"diff --git a/dir b/dir\n",
			"deleted file mode 120000\n",
			"--- a/dir\n",
			"+++ /dev/null\n",
			"@@ -1 +0,0 @@\n",
			"-.git\n",
			"\\ No newline at end of file\n",
			"diff --git a/dir/file.txt b/dir/file.txt\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/dir/file.txt\n",
			"@@ -0,0 +1 @@\n",
			"+real\n",
		);
		assert!(
			repository
				.can_apply_patch(patch, &ApplyOptions::default())
				.expect("probe"),
			"the probe refused a patch the writer applies safely"
		);
		repository
			.apply_patch(patch, &ApplyOptions::default())
			.expect("deleting a store link before writing its child is safe");
		assert!(temp.path().join("dir").is_dir(), "the link was not replaced by a directory");
		assert_eq!(fs::read(temp.path().join("dir/file.txt")).expect("child"), b"real\n");
		assert_eq!(
			fs::read(temp.path().join(".git/config")).expect("config"),
			config,
			"the child was written through the store link"
		);
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_still_refuses_a_child_of_a_deleted_store_directory() {
		// The spelling is judged even when an ancestor is doomed: deleting the
		// gitfile and writing beneath the store it names is not made safe by
		// the removal.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--separate-git-dir=meta", "sub"]);
		let patch = concat!(
			"diff --git a/meta/hooks/pre-commit b/meta/hooks/pre-commit\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/meta/hooks/pre-commit\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		assert!(
			repo(temp.path())
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"a hook inside a live store must stay refused"
		);
		assert!(!temp.path().join("meta/hooks/pre-commit").exists(), "the hook was written");
	}

	#[test]
	fn normalize_repo_path_drops_hfs_ignorable_codepoints() {
		// `is_hfs_ignorable` names what HFS+ folds away when comparing names,
		// so the comparison key must drop the same set or `link` and
		// `l\u{200c}ink` are one entry on disk and two keys here.
		assert_eq!(normalize_repo_path("l\u{200c}ink/config"), normalize_repo_path("link/config"));
		assert_eq!(normalize_repo_path("\u{feff}Link"), normalize_repo_path("link"));
		assert_eq!(normalize_repo_path("li\u{202e}nk"), normalize_repo_path("LINK"));
		// A format character git does NOT fold stays distinct.
		assert_ne!(normalize_repo_path("li\u{2060}nk"), normalize_repo_path("link"));
	}

	#[test]
	#[cfg(unix)]
	fn patch_refuses_an_hfs_ignorable_alias_of_a_minted_store_link() {
		let temp = init(&[("keep.txt", b"base\n")]);
		let config = fs::read(temp.path().join(".git/config")).expect("config");
		let patch = concat!(
			"diff --git a/link b/link\n",
			"new file mode 120000\n",
			"--- /dev/null\n",
			"+++ b/link\n",
			"@@ -0,0 +1 @@\n",
			"+.git\n",
			"\\ No newline at end of file\n",
			"diff --git a/l\u{200c}ink/config b/l\u{200c}ink/config\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/l\u{200c}ink/config\n",
			"@@ -0,0 +1 @@\n",
			"+payload\n",
		);
		assert!(
			repo(temp.path())
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"an HFS-ignorable alias of a minted link must be refused"
		);
		assert_eq!(
			fs::read(temp.path().join(".git/config")).expect("config"),
			config,
			"the write followed the minted link into the store"
		);
		assert!(fs::symlink_metadata(temp.path().join("link")).is_err(), "the link was created");
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_refuses_two_regular_entries_sharing_one_normalized_key() {
		// Regular `A` and `a` collide on a case-insensitive worktree: one
		// filesystem entry, two index entries, after HEAD has advanced.
		let temp = init(&[("keep.txt", b"base\n")]);
		let gix_repo = repo(temp.path()).gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let mut map = tree_map(&gix_repo, head_tree).expect("base map");
		let upper = gix_repo
			.write_blob(b"upper\n")
			.expect("upper blob")
			.detach();
		let lower = gix_repo
			.write_blob(b"lower\n")
			.expect("lower blob")
			.detach();
		map.insert("A".to_owned(), FileEntry::new(upper, Mode::FILE));
		map.insert("a".to_owned(), FileEntry::new(lower, Mode::FILE));
		let tree = write_tree_map(&gix_repo, &map).expect("colliding tree");
		let picked = gix_repo
			.new_commit("colliding names", tree, [head.id().detach()])
			.expect("commit")
			.id()
			.to_string();
		let head_before = git(temp.path(), &["rev-parse", "HEAD"]);

		assert!(
			repo(temp.path()).cherry_pick(&picked).is_err(),
			"two regular entries sharing one normalized key must be refused"
		);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head_before, "HEAD moved");
	}

	#[test]
	#[cfg(unix)]
	fn cherry_pick_refuses_an_entry_under_another_entrys_key() {
		// Blob `A` and tree entry `a/file` have DISTINCT keys, so uniqueness
		// alone passes. On a case-insensitive worktree `A` is written first and
		// creating directory `a` then fails, leaving a partial checkout after
		// HEAD has already moved.
		let temp = init(&[("keep.txt", b"base\n")]);
		let gix_repo = repo(temp.path()).gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let mut map = tree_map(&gix_repo, head_tree).expect("base map");
		let blob = gix_repo.write_blob(b"file\n").expect("blob").detach();
		let child = gix_repo
			.write_blob(b"child\n")
			.expect("child blob")
			.detach();
		map.insert("A".to_owned(), FileEntry::new(blob, Mode::FILE));
		map.insert("a/file".to_owned(), FileEntry::new(child, Mode::FILE));
		let tree = write_tree_map(&gix_repo, &map).expect("colliding tree");
		let picked = gix_repo
			.new_commit("file and descendant", tree, [head.id().detach()])
			.expect("commit")
			.id()
			.to_string();
		let head_before = git(temp.path(), &["rev-parse", "HEAD"]);

		assert!(
			repo(temp.path()).cherry_pick(&picked).is_err(),
			"an entry under another entry's key must be refused"
		);
		assert_eq!(git(temp.path(), &["rev-parse", "HEAD"]), head_before, "HEAD moved");
		assert!(!temp.path().join("A").exists(), "the parent entry was written");
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_refuses_two_regular_targets_sharing_one_key() {
		// `apply_patch` never runs the worktree-map preflight, so all-entry key
		// ownership has to hold in the patch preflight too: on a
		// case-insensitive worktree both contents land in one file and the
		// apply reports success against a lossy result.
		let temp = init(&[("keep.txt", b"base\n")]);
		let patch = concat!(
			"diff --git a/A b/A\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/A\n",
			"@@ -0,0 +1 @@\n",
			"+upper\n",
			"diff --git a/a b/a\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/a\n",
			"@@ -0,0 +1 @@\n",
			"+lower\n",
		);
		let repository = repo(temp.path());
		assert!(
			repository
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"two regular targets folding to one key must be refused"
		);
		assert!(!temp.path().join("A").exists(), "a target was written before the refusal");
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_accepts_a_rename_onto_a_case_folded_spelling_of_its_source() {
		// The writer unlinks the source before creating the target, so a rename
		// from `Name` to `name` is not a key collision with itself.
		let temp = init(&[("Name", b"body\n")]);
		let patch = concat!(
			"diff --git a/Name b/name\n",
			"similarity index 100%\n",
			"rename from Name\n",
			"rename to name\n",
		);
		repo(temp.path())
			.apply_patch(patch, &ApplyOptions::default())
			.expect("a rename releasing its own key is valid");
		assert_eq!(fs::read(temp.path().join("name")).expect("renamed"), b"body\n");
	}

	#[test]
	fn cached_patch_refuses_a_leaf_equal_to_the_live_store() {
		// The git directory is exactly `meta`, so staging a blob AT `meta`
		// compares only its parent — the worktree root — and would pass.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--separate-git-dir=meta", "sub"]);
		let patch = concat!(
			"diff --git a/meta b/meta\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/meta\n",
			"@@ -0,0 +1 @@\n",
			"+payload\n",
		);
		let repository = repo(temp.path());
		let options = ApplyOptions { cached: true, ..ApplyOptions::default() };
		assert!(
			repository.apply_patch(patch, &options).is_err(),
			"a staged leaf equal to the live store must be refused"
		);
		assert!(!repository.can_apply_patch(patch, &options).expect("probe"), "probe disagreed");
		assert!(temp.path().join("meta").is_dir(), "the store was replaced");
	}

	#[test]
	#[cfg(unix)]
	fn stash_pop_refuses_two_untracked_entries_sharing_one_key() {
		// `A` and `a` in the untracked half are two entries where the stash was
		// authored and one on a case-insensitive target: the second write
		// replaces the first and the stash is then dropped, losing a file.
		let temp = init(&[("keep.txt", b"base\n")]);
		let repository = repo(temp.path());
		let gix_repo = repository.gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_id = head.id().detach();
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let base = tree_map(&gix_repo, head_tree).expect("base map");
		let upper = gix_repo.write_blob(b"upper\n").expect("upper").detach();
		let lower = gix_repo.write_blob(b"lower\n").expect("lower").detach();
		let mut untracked = BTreeMap::new();
		untracked.insert("A".to_owned(), FileEntry::new(upper, Mode::FILE));
		untracked.insert("a".to_owned(), FileEntry::new(lower, Mode::FILE));
		let untracked_tree = write_tree_map(&gix_repo, &untracked).expect("untracked tree");
		let index_tree = write_tree_map(&gix_repo, &base).expect("index tree");
		let index_commit = gix_repo
			.new_commit("index on HEAD: wip", index_tree, [head_id])
			.expect("index commit");
		let untracked_commit = gix_repo
			.new_commit("untracked files on HEAD", untracked_tree, std::iter::empty::<gix::ObjectId>())
			.expect("untracked commit");
		let stash = gix_repo
			.new_commit("wip", index_tree, [
				head_id,
				index_commit.id().detach(),
				untracked_commit.id().detach(),
			])
			.expect("stash commit");
		update_stash_ref(
			&gix_repo,
			stash.id().detach(),
			PreviousValue::Any,
			"On HEAD: wip".to_owned(),
			true,
		)
		.expect("install stash");

		assert!(
			repository.stash_try_pop(false).is_err(),
			"two untracked entries folding to one key must be refused"
		);
		assert!(
			gix_repo
				.try_find_reference("refs/stash")
				.expect("lookup")
				.is_some(),
			"the stash was dropped despite the refusal"
		);
	}

	#[test]
	fn a_failed_scan_item_is_not_an_absent_entry() {
		// The item error is the interesting half and cannot be provoked through
		// permissions on APFS — an unreadable directory fails at `read_dir`,
		// while FUSE and NFS surface EIO on the item. Pinned directly: an `Err`
		// classifies as `None`, which the walk turns into `complete = false`
		// rather than silently dropping the entry.
		let failed = scan_item(Err(std::io::Error::from_raw_os_error(libc::EIO)));
		assert!(failed.is_none(), "an item error must not look like an absent entry");

		// And the walk reports a directory it could not open at all.
		let temp = init(&[("keep.txt", b"base\n")]);
		let mut found = Vec::new();
		assert!(
			collect_nested_stores(temp.path(), &mut found),
			"a readable tree must report a complete scan"
		);
		assert!(
			!collect_nested_stores(&temp.path().join("absent"), &mut found),
			"an unopenable directory must report an incomplete scan"
		);
	}

	#[test]
	#[cfg(unix)]
	fn patch_refuses_a_path_when_store_discovery_cannot_list_a_directory() {
		use std::os::unix::fs::PermissionsExt;

		// A traversable but unlistable directory hides every store beneath it
		// while leaving a known path inside it writable. An incomplete scan is
		// not an empty one.
		let temp = init(&[("keep.txt", b"base\n")]);
		let secret = temp.path().join("secret");
		fs::create_dir(&secret).expect("mkdir secret");
		git(temp.path(), &["init", "-q", "--separate-git-dir=secret/meta", "secret/sub"]);
		fs::set_permissions(&secret, fs::Permissions::from_mode(0o300)).expect("chmod 0300");

		let patch = concat!(
			"diff --git a/other.txt b/other.txt\n",
			"new file mode 100644\n",
			"--- /dev/null\n",
			"+++ b/other.txt\n",
			"@@ -0,0 +1 @@\n",
			"+x\n",
		);
		let refused = repo(temp.path())
			.apply_patch(patch, &ApplyOptions::default())
			.is_err();
		// Restore permissions before asserting so a failure cannot leave an
		// undeletable tempdir behind.
		fs::set_permissions(&secret, fs::Permissions::from_mode(0o700)).expect("restore mode");
		assert!(refused, "an unlistable directory must not be treated as free of stores");
		assert!(!temp.path().join("other.txt").exists(), "wrote despite an incomplete scan");
	}

	#[test]
	#[cfg(unix)]
	fn stash_pop_refuses_a_reinstated_index_entry_inside_a_live_store() {
		// An index-only `meta/hooks/pre-commit` predating `meta` becoming a
		// separate store: the pop would stage it and a later checkout
		// materializes it over the live hook.
		let temp = init(&[("keep.txt", b"base\n")]);
		let repository = repo(temp.path());
		let gix_repo = repository.gix().expect("open repository");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_id = head.id().detach();
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let base = tree_map(&gix_repo, head_tree).expect("base map");
		let hook = gix_repo
			.write_blob(b"#!/bin/sh\nevil\n")
			.expect("hook blob")
			.detach();
		let mut staged = base.clone();
		staged
			.insert("meta/hooks/pre-commit".to_owned(), FileEntry::new(hook, Mode::FILE_EXECUTABLE));
		let index_tree = write_tree_map(&gix_repo, &staged).expect("index tree");
		let worktree_tree = write_tree_map(&gix_repo, &base).expect("worktree tree");
		let index_commit = gix_repo
			.new_commit("index on HEAD: wip", index_tree, [head_id])
			.expect("index commit");
		// Empty untracked half: a non-empty one whose paths already exist on
		// disk makes the collision probe bail out with `Ok(false)` before the
		// index is ever judged.
		let empty_tree = write_tree_map(&gix_repo, &BTreeMap::new()).expect("empty tree");
		let untracked_commit = gix_repo
			.new_commit("untracked files on HEAD", empty_tree, std::iter::empty::<gix::ObjectId>())
			.expect("untracked commit");
		let stash = gix_repo
			.new_commit("wip", worktree_tree, [
				head_id,
				index_commit.id().detach(),
				untracked_commit.id().detach(),
			])
			.expect("stash commit");
		update_stash_ref(
			&gix_repo,
			stash.id().detach(),
			PreviousValue::Any,
			"On HEAD: wip".to_owned(),
			true,
		)
		.expect("install stash");
		// `meta` only becomes a store after the stash was authored.
		git(temp.path(), &["init", "-q", "--separate-git-dir=meta", "sub"]);

		assert!(
			repository.stash_try_pop(true).is_err(),
			"a reinstated index entry inside a live store must be refused"
		);
		assert!(
			!git(temp.path(), &["ls-files"]).contains("meta/hooks"),
			"the hook was staged into the index"
		);
	}

	#[test]
	#[cfg(unix)]
	fn stash_pop_refuses_an_untracked_entry_under_an_untracked_link_restored_first() {
		// Both halves are UNTRACKED: `A -> .git` is restored before `a/config`,
		// so judging untracked paths against only the tracked links misses the
		// hierarchy entirely.
		let temp = init(&[("keep.txt", b"base\n")]);
		let repository = repo(temp.path());
		let gix_repo = repository.gix().expect("open repository");
		let link = gix_repo.write_blob(b".git").expect("link blob").detach();
		let file = gix_repo
			.write_blob(b"payload\n")
			.expect("file blob")
			.detach();
		let mut untracked = BTreeMap::new();
		untracked.insert("A".to_owned(), FileEntry::new(link, Mode::SYMLINK));
		untracked.insert("a/config".to_owned(), FileEntry::new(file, Mode::FILE));
		let untracked_tree = write_tree_map(&gix_repo, &untracked).expect("untracked tree");
		let head = gix_repo.head_commit().expect("HEAD");
		let head_id = head.id().detach();
		let head_tree = head.tree_id().expect("HEAD tree").detach();
		let base = tree_map(&gix_repo, head_tree).expect("base map");
		let index_tree = write_tree_map(&gix_repo, &base).expect("index tree");
		let index_commit = gix_repo
			.new_commit("index on HEAD: wip", index_tree, [head_id])
			.expect("index commit");
		let untracked_commit = gix_repo
			.new_commit("untracked files on HEAD", untracked_tree, std::iter::empty::<gix::ObjectId>())
			.expect("untracked commit");
		let stash = gix_repo
			.new_commit("wip", index_tree, [
				head_id,
				index_commit.id().detach(),
				untracked_commit.id().detach(),
			])
			.expect("stash commit");
		update_stash_ref(
			&gix_repo,
			stash.id().detach(),
			PreviousValue::Any,
			"On HEAD: wip".to_owned(),
			true,
		)
		.expect("install stash");
		let config = fs::read(temp.path().join(".git/config")).expect("config");

		assert!(
			repository.stash_try_pop(false).is_err(),
			"an untracked child under an untracked link restored first must be refused"
		);
		assert_eq!(
			fs::read(temp.path().join(".git/config")).expect("config"),
			config,
			"the untracked write followed the restored link into the store"
		);
		assert!(fs::symlink_metadata(temp.path().join("A")).is_err(), "the link was restored");
	}

	#[test]
	#[cfg(unix)]
	fn patch_refuses_a_hook_reached_through_a_symlinked_store_subdirectory() {
		use std::os::unix::fs::symlink;

		// `meta/hooks -> ../hookdir` moves the hook OUT of the store when
		// resolved, but git still runs it through that link.
		let temp = init(&[("keep.txt", b"base\n")]);
		git(temp.path(), &["init", "-q", "--separate-git-dir=meta", "sub"]);
		fs::remove_dir_all(temp.path().join("meta/hooks")).expect("drop hooks dir");
		fs::create_dir(temp.path().join("hookdir")).expect("mkdir hookdir");
		symlink("../hookdir", temp.path().join("meta/hooks")).expect("link hooks");

		let patch = concat!(
			"diff --git a/meta/hooks/pre-commit b/meta/hooks/pre-commit\n",
			"new file mode 100755\n",
			"--- /dev/null\n",
			"+++ b/meta/hooks/pre-commit\n",
			"@@ -0,0 +1 @@\n",
			"+#!/bin/sh\n",
		);
		assert!(
			repo(temp.path())
				.apply_patch(patch, &ApplyOptions::default())
				.is_err(),
			"a hook reached through a symlinked store subdirectory must be refused"
		);
		assert!(
			!temp.path().join("hookdir/pre-commit").exists(),
			"the hook was installed through the store's symlinked subdirectory"
		);
	}

	#[test]
	fn nested_store_cache_keeps_one_slot_per_root_within_an_operation() {
		// Two repositories interleaving path checks inside one operation must
		// not evict each other: a single shared slot would rescan the whole
		// worktree on every alternation. Same operation, alternating roots,
		// and the SAME `Arc` must come back for each — a rescan allocates a
		// fresh one.
		let a = init(&[("a.txt", b"a\n")]);
		let b = init(&[("b.txt", b"b\n")]);
		let (repo_a, repo_b) = (repo(a.path()), repo(b.path()));
		begin_operation();
		let first_a = nested_stores(&repo_a);
		let first_b = nested_stores(&repo_b);
		let second_a = nested_stores(&repo_a);
		let second_b = nested_stores(&repo_b);
		assert!(Arc::ptr_eq(&first_a, &second_a), "root A was rescanned after root B was checked");
		assert!(Arc::ptr_eq(&first_b, &second_b), "root B was rescanned after root A was checked");
		// And a new operation still invalidates both.
		begin_operation();
		assert!(
			!Arc::ptr_eq(&first_a, &nested_stores(&repo_a)),
			"stale scan survived a new operation"
		);
	}

	#[test]
	#[cfg(unix)]
	fn apply_patch_accepts_deleting_a_child_before_minting_its_parent_as_a_link() {
		// Valid ordering: `link/file` is deleted and its empty directory removed
		// BEFORE symlink `link` is created, so the deletion never traverses the
		// link. Judging the source against the final set of minted links would
		// reject a patch git itself accepts.
		let temp = init(&[("keep.txt", b"base\n"), ("link/file.txt", b"child\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let repository = repo(temp.path());
		let blob = git(temp.path(), &["rev-parse", "HEAD:link/file.txt"]);
		let patch = format!(
			concat!(
				"diff --git a/link/file.txt b/link/file.txt\n",
				"deleted file mode 100644\n",
				"index {}..0000000\n",
				"--- a/link/file.txt\n",
				"+++ /dev/null\n",
				"@@ -1 +0,0 @@\n",
				"-child\n",
				"diff --git a/link b/link\n",
				"new file mode 120000\n",
				"--- /dev/null\n",
				"+++ b/link\n",
				"@@ -0,0 +1 @@\n",
				"+{}\n",
				"\\ No newline at end of file\n",
			),
			&blob.trim()[..7],
			outside.path().display(),
		);
		repository
			.apply_patch(&patch, &ApplyOptions::default())
			.expect("delete-then-mint is a valid ordering");
		assert!(
			temp
				.path()
				.join("link")
				.symlink_metadata()
				.is_ok_and(|m| m.file_type().is_symlink())
		);
	}

	#[test]
	#[cfg(unix)]
	fn map_preflight_does_not_treat_a_differently_named_entry_as_the_removed_ancestor() {
		// On a case-sensitive filesystem `Link` and `link` are two entries.
		// Removing tracked `Link` must not be taken as removing untracked
		// outbound `link`, or `link/file` skips containment and resolves
		// through a symlink the write pass never touches. Where the filesystem
		// folds case, the two ARE one entry and the skip is correct — so the
		// check asks the filesystem rather than a string rule.
		use std::os::unix::fs::symlink;
		let temp = init(&[("keep.txt", b"base\n"), ("Link", b"tracked\n")]);
		let outside = tempfile::tempdir().expect("outside tempdir");
		let folds = {
			fs::write(temp.path().join("PROBE"), b"").expect("probe");
			let same = temp.path().join("probe").exists();
			fs::remove_file(temp.path().join("PROBE")).expect("cleanup");
			same
		};
		if folds {
			// Cannot construct two distinct entries here; the NFC/NFD test
			// covers the folding side of this behaviour.
			return;
		}
		symlink(outside.path(), temp.path().join("link")).expect("untracked outbound link");

		let mut previous = BTreeMap::new();
		let gix_repo = repo(temp.path()).gix().expect("open");
		let id = gix_repo.write_blob(b"tracked\n").expect("blob").detach();
		previous.insert("Link".to_owned(), FileEntry { id, mode: Mode::FILE, intent_to_add: false });
		let mut next = BTreeMap::new();
		next.insert("link/file.txt".to_owned(), FileEntry {
			id,
			mode: Mode::FILE,
			intent_to_add: false,
		});

		let repository = repo(temp.path());
		assert!(
			assert_worktree_map_contained(&repository, &gix_repo, &previous, &next).is_err(),
			"removing `Link` was taken as removing `link`, skipping containment"
		);
	}
}
