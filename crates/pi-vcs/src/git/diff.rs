//! Git-compatible patch generation.

use std::{fmt::Write as _, io::Write as _, path::Path};

use gix::bstr::{BStr, BString, ByteSlice};

use super::{
	GitRepo,
	open::{load_index_or_empty, status_with_fresh_index},
};
use crate::{
	error::{Error, Result},
	types::{DiffOptions, NumstatEntry, ShowResult},
};

#[derive(Clone)]
struct FileChange {
	old_path:     String,
	new_path:     String,
	old_id:       gix::ObjectId,
	new_id:       gix::ObjectId,
	old_mode:     Option<gix::objs::tree::EntryMode>,
	new_mode:     Option<gix::objs::tree::EntryMode>,
	similarity:   Option<u8>,
	worktree_new: bool,
}

struct Rendered {
	text:    String,
	added:   Option<u32>,
	removed: Option<u32>,
}

impl GitRepo {
	/// Render changes as a git patch.
	pub fn diff_text(&self, options: &DiffOptions) -> Result<String> {
		let repo = self.gix()?;
		let changes = collect_changes(&repo, options)?;
		render_changes(&repo, &changes, options.context.unwrap_or(3), options.binary)
			.map(|rendered| rendered.into_iter().map(|item| item.text).collect())
	}

	/// Return changed paths, using the destination path for renames.
	pub fn changed_files(&self, options: &DiffOptions) -> Result<Vec<String>> {
		let repo = self.gix()?;
		Ok(collect_changes(&repo, options)?
			.into_iter()
			.map(|change| change.new_path)
			.collect())
	}

	/// Return per-file line counts, with no counts for binary files.
	pub fn numstat(&self, options: &DiffOptions) -> Result<Vec<NumstatEntry>> {
		let repo = self.gix()?;
		let changes = collect_changes(&repo, options)?;
		let rendered = render_changes(&repo, &changes, 0, false)?;
		Ok(changes
			.into_iter()
			.zip(rendered)
			.map(|(change, rendered)| NumstatEntry {
				path:    change.new_path,
				added:   rendered.added,
				removed: rendered.removed,
			})
			.collect())
	}

	/// Return whether the selected comparison contains at least one change.
	pub fn has_diff(&self, options: &DiffOptions) -> Result<bool> {
		let repo = self.gix()?;
		Ok(!collect_changes(&repo, options)?.is_empty())
	}

	/// Render the recursive patch between two revisions.
	pub fn diff_tree(&self, base: &str, head: &str, binary: bool) -> Result<String> {
		self.diff_text(&DiffOptions {
			base: Some(base.to_owned()),
			head: Some(head.to_owned()),
			binary,
			..DiffOptions::default()
		})
	}

	/// Render a no-index patch between filesystem paths.
	pub fn diff_no_index(&self, left: &Path, right: &Path, binary: bool) -> Result<String> {
		let repo = self.gix()?;
		let left_file = read_no_index_file(self.root(), left)?;
		let right_file = read_no_index_file(self.root(), right)?;
		if left_file.is_none() && right_file.is_none() {
			return Ok(String::new());
		}
		let old_path = left_file
			.as_ref()
			.map_or_else(|| no_index_label(self.root(), right), |_| no_index_label(self.root(), left));
		let new_path = right_file
			.as_ref()
			.map_or_else(|| no_index_label(self.root(), left), |_| no_index_label(self.root(), right));
		let old_id = write_no_index_blob(&repo, left_file.as_ref())?;
		let new_id = write_no_index_blob(&repo, right_file.as_ref())?;
		let null = repo.object_hash().null();
		let change = FileChange {
			old_path,
			new_path,
			old_id: old_id.unwrap_or(null),
			new_id: new_id.unwrap_or(null),
			old_mode: left_file.as_ref().map(|file| file.mode),
			new_mode: right_file.as_ref().map(|file| file.mode),
			similarity: None,
			worktree_new: false,
		};
		let mut cache = repo
			.diff_resource_cache_for_tree_diff()
			.map_err(|err| Error::backend("git diff --no-index", err))?;
		render_change(&repo, &mut cache, &change, 3, binary).map(|rendered| rendered.text)
	}

	/// Render a commit header and its patch against its first parent.
	pub fn show_commit(&self, rev: &str, max_bytes: Option<usize>) -> Result<ShowResult> {
		let repo = self.gix()?;
		let id = repo
			.rev_parse_single(rev)
			.map_err(|err| Error::backend("git show", err))?;
		let object = id.object().map_err(|err| Error::backend("git show", err))?;
		let commit = object
			.peel_to_commit()
			.map_err(|err| Error::backend("git show", err))?;
		let decoded = commit
			.decode()
			.map_err(|err| Error::backend("git show", err))?;
		let author = commit
			.author()
			.map_err(|err| Error::backend("git show", err))?;
		let author_time = author
			.time()
			.map_err(|err| Error::backend("git show", err))?;
		let mut text = format!(
			"commit {}\nAuthor: {} <{}>\nDate:   {}\n\n",
			commit.id,
			author.name,
			author.email,
			author_time.format_or_unix(gix::date::time::format::DEFAULT)
		);
		for line in decoded.message.as_bstr().lines() {
			text.push_str("    ");
			text.push_str(&String::from_utf8_lossy(line));
			text.push('\n');
		}
		text.push('\n');

		let tree = commit
			.tree()
			.map_err(|err| Error::backend("git show", err))?;
		let parent_tree = if let Some(id) = commit.parent_ids().next() {
			let object = id.object().map_err(|err| Error::backend("git show", err))?;
			let parent = object
				.peel_to_commit()
				.map_err(|err| Error::backend("git show", err))?;
			Some(
				parent
					.tree()
					.map_err(|err| Error::backend("git show", err))?,
			)
		} else {
			None
		};
		let changes = tree_changes(&repo, parent_tree.as_ref(), Some(&tree), &[])?;
		for rendered in render_changes(&repo, &changes, 3, false)? {
			text.push_str(&rendered.text);
		}

		let mut bytes = text.into_bytes();
		let truncated = max_bytes.is_some_and(|limit| bytes.len() > limit);
		if let Some(limit) = max_bytes {
			bytes.truncate(limit);
		}
		Ok(ShowResult { bytes, truncated })
	}
}

fn collect_changes(repo: &gix::Repository, options: &DiffOptions) -> Result<Vec<FileChange>> {
	if let Some(base) = options.base.as_deref() {
		let old = revision_tree(repo, base)?;
		if let Some(head) = options.head.as_deref() {
			let new = revision_tree(repo, head)?;
			return tree_changes(repo, Some(&old), Some(&new), &options.files);
		}
		return base_worktree_changes(repo, old.id, &options.files);
	}
	if options.cached {
		return cached_changes(repo, &options.files);
	}
	worktree_changes(repo, &options.files)
}

fn revision_tree<'repo>(repo: &'repo gix::Repository, rev: &str) -> Result<gix::Tree<'repo>> {
	let id = repo
		.rev_parse_single(rev)
		.map_err(|err| Error::backend("git diff revision", err))?;
	let object = id
		.object()
		.map_err(|err| Error::backend("git diff revision", err))?;
	object
		.peel_to_tree()
		.map_err(|err| Error::backend("git diff revision", err))
}

fn tree_changes(
	repo: &gix::Repository,
	old: Option<&gix::Tree<'_>>,
	new: Option<&gix::Tree<'_>>,
	files: &[String],
) -> Result<Vec<FileChange>> {
	let changes = repo
		.diff_tree_to_tree(old, new, None)
		.map_err(|err| Error::backend("git diff-tree", err))?;
	let mut pathspec = make_pathspec(repo, files, false)?;
	let null = repo.object_hash().null();
	let mut out = Vec::with_capacity(changes.len());
	for change in changes {
		use gix::object::tree::diff::ChangeDetached;
		let item = match change {
			ChangeDetached::Addition { location, entry_mode, id, .. } => FileChange {
				old_path:     path_string(location.as_ref()),
				new_path:     path_string(location.as_ref()),
				old_id:       null,
				new_id:       id,
				old_mode:     None,
				new_mode:     Some(entry_mode),
				similarity:   None,
				worktree_new: false,
			},
			ChangeDetached::Deletion { location, entry_mode, id, .. } => FileChange {
				old_path:     path_string(location.as_ref()),
				new_path:     path_string(location.as_ref()),
				old_id:       id,
				new_id:       null,
				old_mode:     Some(entry_mode),
				new_mode:     None,
				similarity:   None,
				worktree_new: false,
			},
			ChangeDetached::Modification {
				location,
				previous_entry_mode,
				previous_id,
				entry_mode,
				id,
			} => FileChange {
				old_path:     path_string(location.as_ref()),
				new_path:     path_string(location.as_ref()),
				old_id:       previous_id,
				new_id:       id,
				old_mode:     Some(previous_entry_mode),
				new_mode:     Some(entry_mode),
				similarity:   None,
				worktree_new: false,
			},
			ChangeDetached::Rewrite {
				source_location,
				source_entry_mode,
				source_id,
				diff,
				entry_mode,
				id,
				location,
				copy,
				..
			} => {
				if copy {
					continue;
				}
				FileChange {
					old_path:     path_string(source_location.as_ref()),
					new_path:     path_string(location.as_ref()),
					old_id:       source_id,
					new_id:       id,
					old_mode:     Some(source_entry_mode),
					new_mode:     Some(entry_mode),
					similarity:   Some(
						diff.map_or(100, |stats| (stats.similarity * 100.0).floor() as u8),
					),
					worktree_new: false,
				}
			},
		};
		if item
			.old_mode
			.or(item.new_mode)
			.is_some_and(|mode| mode.kind() == gix::objs::tree::EntryKind::Tree)
		{
			continue;
		}
		if pathspec.as_mut().is_none_or(|spec| {
			spec.is_included(item.old_path.as_bytes().as_bstr(), Some(false))
				|| spec.is_included(item.new_path.as_bytes().as_bstr(), Some(false))
		}) {
			out.push(item);
		}
	}
	sort_changes(&mut out);
	Ok(out)
}

fn cached_changes(repo: &gix::Repository, files: &[String]) -> Result<Vec<FileChange>> {
	let tree_id = repo
		.head_tree_id_or_empty()
		.map_err(|err| Error::backend("git diff --cached", err))?;
	index_changes(repo, tree_id.detach(), files)
}

fn index_changes(
	repo: &gix::Repository,
	tree_id: gix::ObjectId,
	files: &[String],
) -> Result<Vec<FileChange>> {
	let index = load_index_or_empty(repo, "git diff --cached")?;
	let mut pathspec = make_pathspec(repo, files, false)?;
	let mut out = Vec::new();
	repo
		.tree_index_status(
			&tree_id,
			&index,
			pathspec.as_mut(),
			gix::status::tree_index::TrackRenames::AsConfigured,
			|change, _, _| -> Result<_> {
				out.push(index_change(repo, change.into_owned())?);
				Ok(std::ops::ControlFlow::Continue(()))
			},
		)
		.map_err(|err| Error::backend("git diff --cached", err))?;
	sort_changes(&mut out);
	Ok(out)
}

fn base_worktree_changes(
	repo: &gix::Repository,
	base_tree: gix::ObjectId,
	files: &[String],
) -> Result<Vec<FileChange>> {
	let staged = index_changes(repo, base_tree, files)?;
	let worktree = worktree_changes(repo, files)?;
	let mut combined = std::collections::BTreeMap::new();
	for change in staged {
		combined.insert(change.new_path.clone(), change);
	}
	for change in worktree {
		if let Some(previous) = combined.get_mut(&change.old_path) {
			previous.new_id = change.new_id;
			previous.new_mode = change.new_mode;
			previous.new_path = change.new_path;
			previous.worktree_new = true;
		} else {
			combined.insert(change.new_path.clone(), change);
		}
	}
	let mut out = combined
		.into_values()
		.filter(|change| change.old_id != change.new_id || change.old_mode != change.new_mode)
		.collect::<Vec<_>>();
	sort_changes(&mut out);
	Ok(out)
}

fn index_change(repo: &gix::Repository, change: gix::diff::index::Change) -> Result<FileChange> {
	use gix::diff::index::ChangeRef;
	let null = repo.object_hash().null();
	let result = match change {
		ChangeRef::Addition { location, entry_mode, id, .. } => FileChange {
			old_path:     path_string(location.as_ref()),
			new_path:     path_string(location.as_ref()),
			old_id:       null,
			new_id:       id.into_owned(),
			old_mode:     None,
			new_mode:     index_mode(entry_mode)?,
			similarity:   None,
			worktree_new: false,
		},
		ChangeRef::Deletion { location, entry_mode, id, .. } => FileChange {
			old_path:     path_string(location.as_ref()),
			new_path:     path_string(location.as_ref()),
			old_id:       id.into_owned(),
			new_id:       null,
			old_mode:     index_mode(entry_mode)?,
			new_mode:     None,
			similarity:   None,
			worktree_new: false,
		},
		ChangeRef::Modification {
			location,
			previous_entry_mode,
			previous_id,
			entry_mode,
			id,
			..
		} => FileChange {
			old_path:     path_string(location.as_ref()),
			new_path:     path_string(location.as_ref()),
			old_id:       previous_id.into_owned(),
			new_id:       id.into_owned(),
			old_mode:     index_mode(previous_entry_mode)?,
			new_mode:     index_mode(entry_mode)?,
			similarity:   None,
			worktree_new: false,
		},
		ChangeRef::Rewrite {
			source_location,
			source_entry_mode,
			source_id,
			location,
			entry_mode,
			id,
			copy,
			..
		} => {
			if copy {
				return Err(Error::backend("git diff --cached", "unexpected copy tracking"));
			}
			let identical = source_id == id;
			FileChange {
				old_path:     path_string(source_location.as_ref()),
				new_path:     path_string(location.as_ref()),
				old_id:       source_id.into_owned(),
				new_id:       id.into_owned(),
				old_mode:     index_mode(source_entry_mode)?,
				new_mode:     index_mode(entry_mode)?,
				similarity:   Some(if identical { 100 } else { u8::MAX }),
				worktree_new: false,
			}
		},
	};
	Ok(result)
}

fn worktree_changes(repo: &gix::Repository, files: &[String]) -> Result<Vec<FileChange>> {
	let patterns = bstring_patterns(files);
	let mut iter = status_with_fresh_index(repo, "git diff")?
		.untracked_files(gix::status::UntrackedFiles::None)
		.index_worktree_options_mut(|options| options.dirwalk_options = None)
		.into_index_worktree_iter(patterns)
		.map_err(|err| Error::backend("git diff", err))?;
	let mut pending = Vec::new();
	for item in &mut iter {
		let item = item.map_err(|err| Error::backend("git diff", err))?;
		if let gix::status::index_worktree::Item::Modification { entry, rela_path, status, .. } = item
		{
			pending.push((entry, rela_path, status));
		}
	}

	let (mut filter, filter_index) = repo
		.filter_pipeline(None)
		.map_err(|err| Error::backend("git diff filter", err))?;
	let null = repo.object_hash().null();
	let mut out = Vec::with_capacity(pending.len());
	for (entry, path, status) in pending {
		use gix::status::plumbing::index_as_worktree::{Change, EntryStatus};
		let mut old_id = entry.id;
		let mut old_mode = index_mode(entry.mode)?;
		let mut new_id = null;
		let mut new_mode = None;
		match status {
			EntryStatus::Change(Change::Removed) => {},
			EntryStatus::Change(Change::Type { .. } | Change::Modification { .. }) => {
				if let Some((id, kind, _)) = filter
					.worktree_file_to_object(path.as_ref(), &filter_index)
					.map_err(|err| Error::backend("git diff filter", err))?
				{
					new_id = id;
					new_mode = Some(kind.into());
				}
			},
			EntryStatus::IntentToAdd => {
				old_id = null;
				old_mode = None;
				if let Some((id, kind, _)) = filter
					.worktree_file_to_object(path.as_ref(), &filter_index)
					.map_err(|err| Error::backend("git diff filter", err))?
				{
					new_id = id;
					new_mode = Some(kind.into());
				}
			},
			EntryStatus::Conflict { .. }
			| EntryStatus::NeedsUpdate(_)
			| EntryStatus::Change(Change::SubmoduleModification(_)) => continue,
		}
		if new_mode.is_some() && old_id == new_id && old_mode == new_mode {
			continue;
		}
		let path = path_string(path.as_ref());
		out.push(FileChange {
			old_path: path.clone(),
			new_path: path,
			old_id,
			new_id,
			old_mode,
			new_mode,
			similarity: None,
			worktree_new: true,
		});
	}
	sort_changes(&mut out);
	Ok(out)
}

fn render_changes(
	repo: &gix::Repository,
	changes: &[FileChange],
	context: u32,
	binary_patch: bool,
) -> Result<Vec<Rendered>> {
	let roots = if changes.iter().any(|change| change.worktree_new) {
		gix::diff::blob::pipeline::WorktreeRoots {
			old_root: None,
			new_root: repo.workdir().map(std::path::Path::to_owned),
		}
	} else {
		Default::default()
	};
	let mut cache = repo
		.diff_resource_cache(gix::diff::blob::pipeline::Mode::ToGit, roots)
		.map_err(|err| Error::backend("git diff", err))?;
	let mut out = Vec::with_capacity(changes.len());
	for change in changes {
		out.push(render_change(repo, &mut cache, change, context, binary_patch)?);
		cache.clear_resource_cache_keep_allocation();
	}
	Ok(out)
}

fn render_change(
	repo: &gix::Repository,
	cache: &mut gix::diff::blob::Platform,
	change: &FileChange,
	context: u32,
	binary_patch: bool,
) -> Result<Rendered> {
	let old_kind = change
		.old_mode
		.or(change.new_mode)
		.ok_or_else(|| Error::backend("git diff", "change has no file mode"))?
		.kind();
	let new_kind = change
		.new_mode
		.or(change.old_mode)
		.ok_or_else(|| Error::backend("git diff", "change has no file mode"))?
		.kind();
	cache
		.set_resource(
			change.old_id,
			old_kind,
			change.old_path.as_bytes().as_bstr(),
			gix::diff::blob::ResourceKind::OldOrSource,
			repo,
		)
		.map_err(|err| Error::backend("git diff", err))?;
	cache
		.set_resource(
			change.new_id,
			new_kind,
			change.new_path.as_bytes().as_bstr(),
			gix::diff::blob::ResourceKind::NewOrDestination,
			repo,
		)
		.map_err(|err| Error::backend("git diff", err))?;
	let prepared = cache
		.prepare_diff()
		.map_err(|err| Error::backend("git diff", err))?;

	let mut text = String::new();
	text.push_str("diff --git a/");
	text.push_str(&change.old_path);
	text.push_str(" b/");
	text.push_str(&change.new_path);
	text.push('\n');
	let is_binary = matches!(
		prepared.operation,
		gix::diff::blob::platform::prepare_diff::Operation::SourceOrDestinationIsBinary
	);
	let similarity = if change.similarity == Some(u8::MAX) {
		compute_similarity(&prepared)
	} else {
		change.similarity
	};
	append_metadata(&mut text, change, similarity, binary_patch && is_binary);

	match prepared.operation {
		gix::diff::blob::platform::prepare_diff::Operation::SourceOrDestinationIsBinary => {
			if binary_patch {
				text.push_str("GIT binary patch\n");
				let old = object_bytes(repo, change.old_id)?;
				let new = object_bytes(repo, change.new_id)?;
				append_binary_body(&mut text, &old, &new)?;
				append_binary_body(&mut text, &new, &old)?;
			} else {
				text.push_str("Binary files ");
				push_old_path(&mut text, change);
				text.push_str(" and ");
				push_new_path(&mut text, change);
				text.push_str(" differ\n");
			}
			Ok(Rendered { text, added: None, removed: None })
		},
		gix::diff::blob::platform::prepare_diff::Operation::InternalDiff { algorithm } => {
			// Tokenize with line terminators kept: git's xdiff treats the
			// terminator as part of the line, so CRLF content diffs with
			// literal `\r` bytes and a final line without a newline is a
			// different line than the same text with one. The convenience
			// `prepared.interned_input()` strips LF/CRLF and would lose both.
			let input = gix::diff::blob::InternedInput::new(
				prepared.old.intern_source(),
				prepared.new.intern_source(),
			);
			let diff = gix::diff::blob::diff_with_slider_heuristics(algorithm, &input);
			let added = diff.count_additions();
			let removed = diff.count_removals();
			if added != 0 || removed != 0 {
				text.push_str("--- ");
				push_old_path(&mut text, change);
				text.push('\n');
				text.push_str("+++ ");
				push_new_path(&mut text, change);
				text.push('\n');
				let old_data = prepared.old.data.as_slice().unwrap_or_default();
				let sink = GitHunks { out: &mut text, old_data };
				gix::diff::blob::UnifiedDiff::new(
					&diff,
					&input,
					sink,
					gix::diff::blob::unified_diff::ContextSize::symmetrical(context),
				)
				.consume()
				.map_err(|err| Error::backend("git diff", err))?;
			}
			Ok(Rendered { text, added: Some(added), removed: Some(removed) })
		},
		gix::diff::blob::platform::prepare_diff::Operation::ExternalCommand { .. } => {
			Err(Error::backend("git diff", "external diff drivers cannot be rendered in-process"))
		},
	}
}

fn append_metadata(out: &mut String, change: &FileChange, similarity: Option<u8>, full_ids: bool) {
	if let Some(similarity) = similarity {
		let _ = writeln!(out, "similarity index {similarity}%");
		out.push_str("rename from ");
		out.push_str(&change.old_path);
		out.push('\n');
		out.push_str("rename to ");
		out.push_str(&change.new_path);
		out.push('\n');
	}
	match (change.old_mode, change.new_mode) {
		(None, Some(mode)) => {
			let _ = writeln!(out, "new file mode {:06o}", mode.value());
		},
		(Some(mode), None) => {
			let _ = writeln!(out, "deleted file mode {:06o}", mode.value());
		},
		(Some(old), Some(new)) if old != new => {
			let _ = writeln!(out, "old mode {:06o}", old.value());
			let _ = writeln!(out, "new mode {:06o}", new.value());
		},
		_ => {},
	}
	if change.old_id != change.new_id {
		let old = display_id(change.old_id, full_ids);
		let new = display_id(change.new_id, full_ids);
		out.push_str("index ");
		out.push_str(&old);
		out.push_str("..");
		out.push_str(&new);
		if let (true, Some(mode)) = (change.old_mode == change.new_mode, change.old_mode) {
			let _ = write!(out, " {:06o}", mode.value());
		}
		out.push('\n');
	}
}

fn compute_similarity(
	prepared: &gix::diff::blob::platform::prepare_diff::Outcome<'_>,
) -> Option<u8> {
	let gix::diff::blob::platform::prepare_diff::Operation::InternalDiff { algorithm } =
		prepared.operation
	else {
		return Some(50);
	};
	let input = gix::diff::blob::InternedInput::new(
		prepared.old.intern_source(),
		prepared.new.intern_source(),
	);
	let diff = gix::diff::blob::Diff::compute(algorithm, &input);
	let removed_bytes = diff
		.hunks()
		.flat_map(|hunk| &input.before[hunk.before.start as usize..hunk.before.end as usize])
		.map(|token| input.interner[*token].len())
		.sum::<usize>();
	let old_len = prepared.old.data.as_slice()?.len();
	let new_len = prepared.new.data.as_slice()?.len();
	if old_len.max(new_len) == 0 {
		return Some(100);
	}
	Some((((old_len.saturating_sub(removed_bytes)) * 100) / old_len.max(new_len)) as u8)
}

struct GitHunks<'a> {
	out:      &'a mut String,
	old_data: &'a [u8],
}

impl gix::diff::blob::unified_diff::ConsumeHunk for GitHunks<'_> {
	type Out = ();

	fn consume_hunk(
		&mut self,
		header: gix::diff::blob::unified_diff::HunkHeader,
		lines: &[(gix::diff::blob::unified_diff::DiffLineKind, &[u8])],
	) -> std::io::Result<()> {
		let old_start = zero_start(header.before_hunk_start, header.before_hunk_len);
		let new_start = zero_start(header.after_hunk_start, header.after_hunk_len);
		self.out.push_str("@@ -");
		push_range(self.out, old_start, header.before_hunk_len);
		self.out.push_str(" +");
		push_range(self.out, new_start, header.after_hunk_len);
		self.out.push_str(" @@");
		if let Some(function) = function_context(self.old_data, header.before_hunk_start) {
			self.out.push(' ');
			self.out.push_str(&String::from_utf8_lossy(function));
		}
		self.out.push('\n');
		for &(kind, content) in lines {
			self.out.push(kind.to_prefix());
			self.out.push_str(&String::from_utf8_lossy(content));
			// Tokens carry their terminator; a token without one is the
			// final line of a file that does not end in a newline.
			if content.last() != Some(&b'\n') {
				self.out.push('\n');
				self.out.push_str("\\ No newline at end of file\n");
			}
		}
		Ok(())
	}

	fn finish(self) {}
}

fn append_binary_body(out: &mut String, source: &[u8], target: &[u8]) -> Result<()> {
	let literal = zlib_compress(target)?;
	let delta = if source.is_empty() || target.is_empty() {
		None
	} else {
		git_delta(source, target, literal.len())
			.map(|delta| {
				let size = delta.len();
				zlib_compress(&delta).map(|compressed| (size, compressed))
			})
			.transpose()?
	};
	if let Some((size, compressed)) =
		delta.filter(|(_, compressed)| compressed.len() < literal.len())
	{
		append_binary_block(out, "delta", size, &compressed)
	} else {
		append_binary_block(out, "literal", target.len(), &literal)
	}
}

fn append_binary_block(out: &mut String, kind: &str, size: usize, compressed: &[u8]) -> Result<()> {
	let _ = writeln!(out, "{kind} {size}");
	for line in compressed.chunks(52) {
		let len = line.len();
		out.push(if len <= 26 {
			char::from(b'A' + u8::try_from(len - 1).unwrap_or(0))
		} else {
			char::from(b'a' + u8::try_from(len - 27).unwrap_or(0))
		});
		for chunk in line.chunks(4) {
			let mut bytes = [0_u8; 4];
			bytes[..chunk.len()].copy_from_slice(chunk);
			let mut value = u32::from_be_bytes(bytes);
			let mut encoded = [0_u8; 5];
			for byte in encoded.iter_mut().rev() {
				*byte = BASE85[(value % 85) as usize];
				value /= 85;
			}
			out.push_str(
				std::str::from_utf8(&encoded).map_err(|err| Error::backend("git binary patch", err))?,
			);
		}
		out.push('\n');
	}
	out.push('\n');
	Ok(())
}

#[derive(Clone, Copy)]
struct DeltaEntry {
	offset: usize,
	hash:   u32,
}

fn git_delta(source: &[u8], target: &[u8], max_size: usize) -> Option<Vec<u8>> {
	const WINDOW: usize = 16;
	let table = rabin_table();
	let remove = rabin_remove_table(&table);
	let entry_count = source.len().saturating_sub(1) / WINDOW;
	if entry_count == 0 || source.len() > u32::MAX as usize {
		return None;
	}
	let mut bits = 4_u32;
	while (1_usize << bits) < entry_count / 4 {
		bits += 1;
	}
	let bucket_count = 1_usize << bits;
	let mask = bucket_count - 1;
	let mut raw = Vec::<DeltaEntry>::with_capacity(entry_count);
	let mut previous = u32::MAX;
	for block in (1..=entry_count).rev() {
		let end = block * WINDOW;
		let mut hash = 0_u32;
		for &byte in &source[end - WINDOW + 1..=end] {
			hash = rabin_update(hash, byte, &table);
		}
		if hash == previous {
			if let Some(entry) = raw.last_mut() {
				entry.offset = end;
			}
		} else {
			raw.push(DeltaEntry { offset: end, hash });
			previous = hash;
		}
	}
	let mut buckets = vec![Vec::new(); bucket_count];
	for entry in raw {
		buckets[entry.hash as usize & mask].push(entry);
	}
	for bucket in &mut buckets {
		bucket.sort_unstable_by_key(|entry| entry.offset);
		if bucket.len() > 64 {
			cull_delta_bucket(bucket);
		}
	}

	let mut out = Vec::with_capacity(target.len().min(max_size.saturating_add(64)));
	push_delta_varint(&mut out, source.len());
	push_delta_varint(&mut out, target.len());
	out.push(0);
	let initial = target.len().min(WINDOW);
	out.extend_from_slice(&target[..initial]);
	let mut insert_count = initial;
	let mut position = initial;
	let mut hash = target[..initial]
		.iter()
		.fold(0_u32, |value, &byte| rabin_update(value, byte, &table));
	let mut match_offset = 0_usize;
	let mut match_size = 0_usize;

	while position < target.len() {
		if match_size < 4096 {
			hash ^= remove[target[position - WINDOW] as usize];
			hash = rabin_update(hash, target[position], &table);
			for entry in &buckets[hash as usize & mask] {
				if entry.hash != hash {
					continue;
				}
				let available = (source.len() - entry.offset).min(target.len() - position);
				if available <= match_size {
					break;
				}
				let mut length = 0;
				while length < available && source[entry.offset + length] == target[position + length] {
					length += 1;
				}
				if length > match_size {
					match_size = length;
					match_offset = entry.offset;
					if match_size >= 4096 {
						break;
					}
				}
			}
		}

		if match_size < 4 {
			if insert_count == 0 {
				out.push(0);
			}
			out.push(target[position]);
			position += 1;
			insert_count += 1;
			if insert_count == 0x7f {
				let slot = out.len() - insert_count - 1;
				out[slot] = u8::try_from(insert_count).ok()?;
				insert_count = 0;
			}
			match_size = 0;
		} else {
			if insert_count != 0 {
				while match_offset != 0
					&& position != 0
					&& source[match_offset - 1] == target[position - 1]
				{
					match_size += 1;
					match_offset -= 1;
					position -= 1;
					out.pop();
					insert_count -= 1;
					if insert_count == 0 {
						out.pop();
						break;
					}
				}
				if insert_count != 0 {
					let slot = out.len() - insert_count - 1;
					out[slot] = u8::try_from(insert_count).ok()?;
				}
				insert_count = 0;
			}

			let leftover = match_size.saturating_sub(0x10000);
			match_size -= leftover;
			push_delta_copy(&mut out, match_offset, match_size);
			position += match_size;
			match_offset += match_size;
			match_size = if match_offset > u32::MAX as usize {
				0
			} else {
				leftover
			};
			if match_size < 4096 && position >= WINDOW {
				hash = target[position - WINDOW..position]
					.iter()
					.fold(0_u32, |value, &byte| rabin_update(value, byte, &table));
			}
		}
		if out.len() > max_size {
			return None;
		}
	}
	if insert_count != 0 {
		let slot = out.len() - insert_count - 1;
		out[slot] = u8::try_from(insert_count).ok()?;
	}
	Some(out)
}

fn rabin_table() -> [u32; 256] {
	const POLYNOMIAL: u32 = 0xab59_b4d1;
	let mut basis = [0_u32; 8];
	basis[0] = POLYNOMIAL;
	for index in 1..basis.len() {
		let previous = basis[index - 1];
		basis[index] = (previous << 1)
			^ if previous & 0x4000_0000 != 0 {
				POLYNOMIAL
			} else {
				0
			};
	}
	let mut table = [0_u32; 256];
	for (value, slot) in table.iter_mut().enumerate() {
		for (bit, basis) in basis.iter().enumerate() {
			if value & (1 << bit) != 0 {
				*slot ^= basis;
			}
		}
	}
	table
}

fn rabin_remove_table(table: &[u32; 256]) -> [u32; 256] {
	let mut remove = [0_u32; 256];
	for (byte, slot) in remove.iter_mut().enumerate() {
		let mut value = byte as u32;
		for _ in 0..15 {
			value = rabin_update(value, 0, table);
		}
		*slot = value;
	}
	remove
}

fn rabin_update(value: u32, byte: u8, table: &[u32; 256]) -> u32 {
	(value << 8 | u32::from(byte)) ^ table[(value >> 23) as u8 as usize]
}

fn cull_delta_bucket(bucket: &mut Vec<DeltaEntry>) {
	let original_len = bucket.len();
	let mut kept = Vec::with_capacity(64);
	let mut accumulator = 0_isize;
	let mut index = 0;
	while index < original_len && kept.len() < 64 {
		accumulator += (original_len - 64) as isize;
		kept.push(bucket[index]);
		index += 1;
		while accumulator > 0 && index < original_len {
			index += 1;
			accumulator -= 64;
		}
	}
	*bucket = kept;
}

fn push_delta_varint(out: &mut Vec<u8>, mut value: usize) {
	while value >= 0x80 {
		out.push((value as u8) | 0x80);
		value >>= 7;
	}
	out.push(value as u8);
}

fn push_delta_copy(out: &mut Vec<u8>, offset: usize, size: usize) {
	let mut opcode = 0x80_u8;
	let slot = out.len();
	out.push(0);
	for index in 0..4 {
		let byte = ((offset >> (index * 8)) & 0xff) as u8;
		if byte != 0 {
			opcode |= 1 << index;
			out.push(byte);
		}
	}
	for index in 0..2 {
		let byte = ((size >> (index * 8)) & 0xff) as u8;
		if byte != 0 {
			opcode |= 0x10 << index;
			out.push(byte);
		}
	}
	out[slot] = opcode;
}

const BASE85: &[u8; 85] =
	b"0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz!#$%&()*+-;<=>?@^_`{|}~";

fn zlib_compress(data: &[u8]) -> Result<Vec<u8>> {
	let mut writer = gix::features::zlib::stream::deflate::Write::new(Vec::new());
	writer
		.write_all(data)
		.and_then(|()| writer.flush())
		.map_err(|err| Error::backend("git binary patch", err))?;
	Ok(writer.into_inner())
}

fn object_bytes(repo: &gix::Repository, id: gix::ObjectId) -> Result<Vec<u8>> {
	if id.is_null() {
		return Ok(Vec::new());
	}
	repo
		.find_object(id)
		.map(|object| object.detach().data)
		.map_err(|err| Error::backend("git diff object", err))
}

struct NoIndexFile {
	data: Vec<u8>,
	mode: gix::objs::tree::EntryMode,
}

fn read_no_index_file(root: &Path, path: &Path) -> Result<Option<NoIndexFile>> {
	if is_null_device(path) {
		return Ok(None);
	}
	let resolved = if path.is_absolute() {
		path.to_owned()
	} else {
		root.join(path)
	};
	let metadata = match std::fs::symlink_metadata(&resolved) {
		Ok(metadata) => metadata,
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
		Err(err) => return Err(err.into()),
	};
	let file_type = metadata.file_type();
	let (data, kind) = if file_type.is_symlink() {
		let target = std::fs::read_link(&resolved)?;
		(os_path_bytes(&target), gix::objs::tree::EntryKind::Link)
	} else if file_type.is_file() {
		let kind = if is_executable(&metadata) {
			gix::objs::tree::EntryKind::BlobExecutable
		} else {
			gix::objs::tree::EntryKind::Blob
		};
		(std::fs::read(&resolved)?, kind)
	} else {
		return Err(Error::backend(
			"git diff --no-index",
			format!("unsupported filesystem entry: {}", resolved.display()),
		));
	};
	Ok(Some(NoIndexFile { data, mode: kind.into() }))
}

fn write_no_index_blob(
	repo: &gix::Repository,
	file: Option<&NoIndexFile>,
) -> Result<Option<gix::ObjectId>> {
	file
		.map(|file| {
			repo
				.write_blob(&file.data)
				.map(gix::Id::detach)
				.map_err(|err| Error::backend("git diff --no-index", err))
		})
		.transpose()
}

fn no_index_label(root: &Path, path: &Path) -> String {
	let path = if path.is_absolute() {
		path.strip_prefix(root).unwrap_or(path)
	} else {
		path
	};
	path.to_string_lossy().replace('\\', "/")
}

fn is_null_device(path: &Path) -> bool {
	path == Path::new("/dev/null") || path.to_string_lossy().eq_ignore_ascii_case("NUL")
}

#[cfg(unix)]
fn is_executable(metadata: &std::fs::Metadata) -> bool {
	use std::os::unix::fs::PermissionsExt;
	metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
#[allow(clippy::missing_const_for_fn, reason = "matches non-const unix signature")]
fn is_executable(_metadata: &std::fs::Metadata) -> bool {
	false
}

#[cfg(unix)]
fn os_path_bytes(path: &Path) -> Vec<u8> {
	use std::os::unix::ffi::OsStrExt;
	path.as_os_str().as_bytes().to_vec()
}

#[cfg(not(unix))]
fn os_path_bytes(path: &Path) -> Vec<u8> {
	path.to_string_lossy().into_owned().into_bytes()
}

fn make_pathspec<'repo>(
	repo: &'repo gix::Repository,
	files: &[String],
	worktree: bool,
) -> Result<Option<gix::Pathspec<'repo>>> {
	if files.is_empty() {
		return Ok(None);
	}
	let index = load_index_or_empty(repo, "git diff pathspec")?;
	repo
		.pathspec(
			false,
			bstring_patterns(files),
			worktree,
			&index,
			if worktree {
				gix::worktree::stack::state::attributes::Source::WorktreeThenIdMapping
			} else {
				gix::worktree::stack::state::attributes::Source::IdMapping
			},
		)
		.map(Some)
		.map_err(|err| Error::backend("git diff pathspec", err))
}

fn bstring_patterns(files: &[String]) -> Vec<BString> {
	files
		.iter()
		.map(|path| BString::from(path.as_bytes()))
		.collect()
}

fn index_mode(mode: gix::index::entry::Mode) -> Result<Option<gix::objs::tree::EntryMode>> {
	mode
		.to_tree_entry_mode()
		.map(Some)
		.ok_or_else(|| Error::backend("git diff", "invalid index entry mode"))
}

fn path_string(path: &BStr) -> String {
	String::from_utf8_lossy(path).into_owned()
}

fn display_id(id: gix::ObjectId, full: bool) -> String {
	if id.is_null() {
		if full {
			"0".repeat(id.kind().len_in_hex())
		} else {
			"0000000".to_owned()
		}
	} else if full {
		id.to_string()
	} else {
		id.to_string().chars().take(7).collect()
	}
}

fn function_context(data: &[u8], hunk_start: u32) -> Option<&[u8]> {
	let before = usize::try_from(hunk_start.saturating_sub(1)).ok()?;
	let mut candidate = None;
	for line in data.split(|&byte| byte == b'\n').take(before) {
		let line = line.strip_suffix(b"\r").unwrap_or(line);
		if line
			.first()
			.is_some_and(|byte| !byte.is_ascii_whitespace() && *byte != b'}')
		{
			candidate = Some(line);
		}
	}
	candidate
}

const fn zero_start(start: u32, len: u32) -> u32 {
	if len == 0 {
		start.saturating_sub(1)
	} else {
		start
	}
}

fn push_range(out: &mut String, start: u32, len: u32) {
	out.push_str(&start.to_string());
	if len != 1 {
		out.push(',');
		out.push_str(&len.to_string());
	}
}

fn push_old_path(out: &mut String, change: &FileChange) {
	if change.old_mode.is_some() {
		out.push_str("a/");
		out.push_str(&change.old_path);
	} else {
		out.push_str("/dev/null");
	}
}

fn push_new_path(out: &mut String, change: &FileChange) {
	if change.new_mode.is_some() {
		out.push_str("b/");
		out.push_str(&change.new_path);
	} else {
		out.push_str("/dev/null");
	}
}

fn sort_changes(changes: &mut [FileChange]) {
	changes.sort_unstable_by(|left, right| {
		left
			.new_path
			.as_bytes()
			.cmp(right.new_path.as_bytes())
			.then_with(|| left.old_path.as_bytes().cmp(right.old_path.as_bytes()))
	});
}
#[cfg(test)]
mod tests {
	use std::{fs, path::Path, process::Command};

	use tempfile::TempDir;

	use super::*;

	fn git(dir: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.args(args)
			.current_dir(dir)
			.output()
			.unwrap_or_else(|err| panic!("run git {args:?}: {err}"));
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
		String::from_utf8(output.stdout).expect("git output is UTF-8")
	}
	fn git_diff(dir: &Path, args: &[&str]) -> String {
		let output = Command::new("git")
			.args(args)
			.current_dir(dir)
			.output()
			.unwrap_or_else(|err| panic!("run git {args:?}: {err}"));
		assert_eq!(
			output.status.code(),
			Some(1),
			"git {args:?}: {}",
			String::from_utf8_lossy(&output.stderr)
		);
		String::from_utf8(output.stdout).expect("git output is UTF-8")
	}

	fn fixture() -> TempDir {
		let dir = tempfile::tempdir().expect("tempdir");
		git(dir.path(), &["init", "-q"]);
		git(dir.path(), &["config", "user.name", "Diff Test"]);
		git(dir.path(), &["config", "user.email", "diff@example.com"]);
		fs::write(dir.path().join("file.txt"), "one\ntwo\nthree\nfour\nfive\nsix\nseven\n")
			.expect("write");
		fs::write(dir.path().join("delete.txt"), "delete\n").expect("write");
		git(dir.path(), &["add", "."]);
		git(dir.path(), &["commit", "-qm", "initial"]);
		dir
	}

	#[test]
	fn diff_matches_git_for_worktree_text() {
		let dir = fixture();
		fs::write(dir.path().join("file.txt"), "one\nchanged\nthree\n").expect("write");
		fs::remove_file(dir.path().join("delete.txt")).expect("delete");
		let repo = GitRepo::discover(dir.path())
			.expect("discover")
			.expect("repository");
		let actual = repo.diff_text(&DiffOptions::default()).expect("diff");
		let expected = git(dir.path(), &["diff"]);
		assert_eq!(actual, expected);
		assert_eq!(
			repo.changed_files(&DiffOptions::default()).expect("names"),
			git(dir.path(), &["diff", "--name-only"])
				.lines()
				.map(str::to_owned)
				.collect::<Vec<_>>()
		);
		let expected_numstat = git(dir.path(), &["diff", "--numstat"])
			.lines()
			.map(|line| {
				let mut fields = line.split('\t');
				NumstatEntry {
					added:   fields.next().and_then(|value| value.parse().ok()),
					removed: fields.next().and_then(|value| value.parse().ok()),
					path:    fields.next().unwrap_or_default().to_owned(),
				}
			})
			.collect::<Vec<_>>();
		assert_eq!(repo.numstat(&DiffOptions::default()).expect("numstat"), expected_numstat);
		fs::write(dir.path().join("intent.txt"), "intent\n").expect("write intent");
		git(dir.path(), &["add", "-N", "intent.txt"]);
		assert_eq!(
			repo
				.diff_text(&DiffOptions::default())
				.expect("intent-to-add diff"),
			git(dir.path(), &["diff"])
		);
	}

	#[test]
	fn status_reads_observe_same_tick_stage_on_reused_handle() {
		let dir = fixture();
		fs::write(dir.path().join("file.txt"), "changed\n").expect("edit tracked");
		fs::write(dir.path().join("new.txt"), "new\n").expect("write untracked");
		let repo = GitRepo::discover(dir.path())
			.expect("discover")
			.expect("repository");

		// Populate gix's shared index snapshot through status-backed diff before
		// staging, then force the write back onto the same mtime tick.
		crate::git::pin_index_mtime(&repo);
		assert!(
			!repo
				.diff_text(&DiffOptions::default())
				.expect("initial diff")
				.is_empty()
		);
		repo
			.stage_files(&["file.txt".into(), "new.txt".into()])
			.expect("stage files");
		crate::git::pin_index_mtime(&repo);

		assert_eq!(
			repo
				.diff_text(&DiffOptions::default())
				.expect("worktree diff"),
			git(dir.path(), &["diff"])
		);
		assert_eq!(
			repo
				.status_porcelain(&crate::types::StatusOptions::default())
				.expect("status"),
			git(dir.path(), &["status", "--porcelain"])
		);
		assert_eq!(repo.status_summary().expect("summary"), crate::types::StatusSummary {
			staged:    2,
			unstaged:  0,
			untracked: 0,
		});
		assert_eq!(repo.ls_files(true, true).expect("untracked files"), Vec::<String>::new());

		repo
			.commit_create("stage all", &crate::types::CommitOptions::default())
			.expect("commit staged files");
		assert!(!repo.is_dirty().expect("clean after commit"));
		assert_eq!(
			repo
				.status_porcelain(&crate::types::StatusOptions::default())
				.expect("clean status"),
			""
		);
	}

	#[test]
	fn cached_rename_add_and_path_filters_match_git() {
		let dir = fixture();
		git(dir.path(), &["mv", "file.txt", "renamed.txt"]);
		fs::write(dir.path().join("renamed.txt"), "one\ntwo\nchanged\nfour\nfive\nsix\nseven\n")
			.expect("modify rename");
		fs::write(dir.path().join("added.txt"), "new\n").expect("write");
		git(dir.path(), &["add", "."]);
		let repo = GitRepo::discover(dir.path())
			.expect("discover")
			.expect("repository");
		let options = DiffOptions { cached: true, ..DiffOptions::default() };
		assert_eq!(repo.diff_text(&options).expect("diff"), git(dir.path(), &["diff", "--cached"]));
		let filtered = DiffOptions { files: vec!["added.txt".into()], ..options };
		assert_eq!(
			repo.diff_text(&filtered).expect("filtered diff"),
			git(dir.path(), &["diff", "--cached", "--", "added.txt"])
		);
	}

	#[test]
	fn context_and_two_revision_tree_diff_match_git() {
		let dir = fixture();
		fs::write(dir.path().join("file.txt"), "one\ntwo\nthree\nchanged\nfive\nsix\nseven\n")
			.expect("write");
		fs::create_dir_all(dir.path().join("src")).expect("create nested directory");
		fs::write(dir.path().join("src/new.py"), "nested\n").expect("write nested file");
		git(dir.path(), &["add", "."]);
		git(dir.path(), &["commit", "-qm", "second"]);
		let repo = GitRepo::discover(dir.path())
			.expect("discover")
			.expect("repository");
		let options = DiffOptions {
			base: Some("HEAD^".into()),
			head: Some("HEAD".into()),
			context: Some(1),
			..DiffOptions::default()
		};
		assert_eq!(
			repo.diff_text(&options).expect("diff"),
			git(dir.path(), &["diff", "-U1", "HEAD^", "HEAD"])
		);
		assert_eq!(
			repo.diff_tree("HEAD^", "HEAD", false).expect("diff-tree"),
			git(dir.path(), &["diff-tree", "-r", "-p", "HEAD^", "HEAD"])
		);
		assert_eq!(
			repo.show_commit("HEAD", None).expect("show").bytes,
			git(dir.path(), &["show", "HEAD"]).into_bytes()
		);
		fs::write(dir.path().join("file.txt"), "one\ntwo\nthree\nchanged\nfive\nworktree\nseven\n")
			.expect("modify worktree");
		let base_only = DiffOptions { base: Some("HEAD^".into()), ..DiffOptions::default() };
		assert_eq!(
			repo.diff_text(&base_only).expect("base diff"),
			git(dir.path(), &["diff", "HEAD^"])
		);
	}

	#[test]
	fn binary_and_missing_newline_match_git() {
		let dir = fixture();
		fs::write(dir.path().join("binary.dat"), [0, 1, 2, 3, 4, 5]).expect("write binary");
		let mut state = 1_u32;
		let mut large = (0..8192)
			.map(|_| {
				state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
				(state >> 24) as u8
			})
			.collect::<Vec<_>>();
		fs::write(dir.path().join("large.dat"), &large).expect("write large binary");
		fs::write(dir.path().join("nonewline.txt"), "old").expect("write text");
		git(dir.path(), &["add", "."]);
		git(dir.path(), &["commit", "-qm", "binary base"]);
		fs::write(dir.path().join("binary.dat"), [0, 1, 9, 3, 4, 5]).expect("modify binary");
		large[4000..4010].fill(42);
		fs::write(dir.path().join("large.dat"), &large).expect("modify large binary");
		fs::write(dir.path().join("nonewline.txt"), "new").expect("modify text");
		let repo = GitRepo::discover(dir.path())
			.expect("discover")
			.expect("repository");
		assert_eq!(
			repo.diff_text(&DiffOptions::default()).expect("diff"),
			git(dir.path(), &["diff"])
		);
		let binary = DiffOptions { binary: true, ..DiffOptions::default() };
		assert_eq!(
			repo.diff_text(&binary).expect("binary diff"),
			git(dir.path(), &["diff", "--binary"])
		);
		let stats = repo.numstat(&DiffOptions::default()).expect("numstat");
		assert!(stats.iter().any(|entry| entry.path == "binary.dat"
			&& entry.added.is_none()
			&& entry.removed.is_none()));
		fs::write(dir.path().join("new-binary.dat"), [0, 7, 8, 9]).expect("add binary");
		git(dir.path(), &["add", "new-binary.dat"]);
		git(dir.path(), &["rm", "-fq", "binary.dat"]);
		let cached_binary = DiffOptions { cached: true, binary: true, ..DiffOptions::default() };
		assert_eq!(
			repo.diff_text(&cached_binary).expect("cached binary diff"),
			git(dir.path(), &["diff", "--cached", "--binary"])
		);
	}

	#[cfg(unix)]
	#[test]
	fn no_index_text_binary_executable_and_symlink_match_git() {
		use std::os::unix::fs::{PermissionsExt, symlink};

		let dir = fixture();
		fs::write(dir.path().join("untracked.txt"), "untracked\n").expect("write text");
		fs::write(dir.path().join("untracked.dat"), [0, 1, 2, 3, 4]).expect("write binary");
		fs::write(dir.path().join("executable"), "#!/bin/sh\nexit 0\n").expect("write executable");
		let mut permissions = fs::metadata(dir.path().join("executable"))
			.expect("metadata")
			.permissions();
		permissions.set_mode(0o755);
		fs::set_permissions(dir.path().join("executable"), permissions).expect("chmod");
		symlink("untracked.txt", dir.path().join("link")).expect("symlink");
		let repo = GitRepo::discover(dir.path())
			.expect("discover")
			.expect("repository");
		for path in ["untracked.txt", "untracked.dat", "executable", "link"] {
			assert_eq!(
				repo
					.diff_no_index(Path::new("/dev/null"), Path::new(path), true)
					.expect("no-index diff"),
				git_diff(dir.path(), &["diff", "--no-index", "--binary", "/dev/null", path])
			);
		}
	}

	#[cfg(unix)]
	#[test]
	fn mode_change_and_crlf_match_git() {
		use std::os::unix::fs::PermissionsExt;

		let dir = fixture();
		fs::write(dir.path().join("crlf.txt"), b"one\r\ntwo\r\n").expect("write CRLF");
		git(dir.path(), &["add", "."]);
		git(dir.path(), &["commit", "-qm", "crlf"]);
		fs::write(dir.path().join("crlf.txt"), b"one\r\nchanged\r\n").expect("modify CRLF");
		let path = dir.path().join("file.txt");
		let mut permissions = fs::metadata(&path).expect("metadata").permissions();
		permissions.set_mode(0o755);
		fs::set_permissions(path, permissions).expect("chmod");
		let repo = GitRepo::discover(dir.path())
			.expect("discover")
			.expect("repository");
		assert_eq!(
			repo.diff_text(&DiffOptions::default()).expect("diff"),
			git(dir.path(), &["diff"])
		);
	}
}
