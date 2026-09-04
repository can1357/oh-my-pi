//! Fullscreen Git workbench.
//!
//! A split diff viewer with staging, a tree/flat sidebar, and a commit
//! composer. Repository reads use [`omp_vcs`] from the actor thread, while
//! every mutation is emitted as a typed [`HostCommand::Git`] for the
//! controller (ADR 0005). The panel re-reads status only after an outcome or
//! when the index, `HEAD`, or viewed file changes on disk.
//!
//! Deviations from the TS implementation, by ADR 0032 (the renderer owns
//! presentation policy) and the no-network actor rule: author avatars
//! (it fetches GitHub avatars over HTTP) and identicons are not painted; AI
//! staging and
//! commit-message generation are not wired (they need an inference seam).

use std::{
	collections::BTreeSet,
	fmt::Write as _,
	fs,
	path::{Path, PathBuf},
	time::{Duration, SystemTime},
};

use omp_core::{IntoStr, Str, sf};
use omp_dom::Dom;
use omp_tui::{
	Color, DiffActionKind, DiffBuildOptions, DiffDocument, DiffPane, DiffPaneState, DiffPatchTarget,
	DiffTarget, DiffWhitespaceMode, Frame, Icon, Key, MouseReport, Prop, Size, Ui, UiContext,
	UiEvent, ViewMode, cell_width,
	components::{Col, EditInput, EditorPane, Tree, TreeAnnotation, TreeNode},
	dom,
};
use omp_vcs::{DiffOptions, StatusOptions, UntrackedMode, git::GitRepo};

use super::{Outcome, Panel, PanelAnchor, PanelCx, PanelEvent, PanelNote, services::ServiceResult};
use crate::host::HostCommand;

/// How often the on-disk fingerprint is re-checked.
pub const REFRESH_MS: Duration = Duration::from_millis(2_000);
/// How long a non-sticky status message replaces the
/// key hints.
pub const STATUS_TTL: Duration = Duration::from_millis(6_000);
const SIDEBAR_MIN: u16 = 30;
const SIDEBAR_MAX: u16 = 48;
/// File rows the commit view keeps visible below the commit metadata.
const MIN_TREE_ROWS: u16 = 6;
/// Files above this size are not diffed in the actor.
const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES: usize = 8 * 1024;
/// Hint while the diff has focus.
const DIFF_HINT: &str = "alt+↓/↑ hunk · ]/[ file · shift+↑/↓ select · s/u stage · x discard · v \
                         view · c commit · q quit";
/// Hint while the sidebar has focus.
const SIDEBAR_HINT: &str =
	"↑/↓ move · ←/→ fold · space stage · enter open · alt+↓/↑ hunk · c commit · t tree · q quit";
/// The empty tree, the parent side of a root commit.
const EMPTY_TREE: &str = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

const DIFF_ID: &str = "git-diff";
const VIEW_ID: &str = "git-diff-view";
const STATUS_ID: &str = "git-status";
const SEPARATOR_ID: &str = "git-separator";
const SIDEBAR_ID: &str = "git-sidebar";
const SUMMARY_ID: &str = "git-commit-summary";
const DESCRIPTION_ID: &str = "git-commit-description";
const DESCRIPTION_PANE_ID: &str = "git-commit-description-pane";
const AMEND_ID: &str = "git-amend";
const COMMIT_ID: &str = "git-commit";
const VIEW_STYLE_ID: &str = "git-sidebar-view";

/// Repository mutation requested by the workbench through the controller.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GitOp {
	/// Add paths to the index; `None` stages every change.
	Stage(Option<Vec<Str>>),
	/// Remove paths from the index; `None` unstages every change.
	Unstage(Option<Vec<Str>>),
	/// Apply a unified patch to the index or worktree.
	Apply {
		/// Unified patch text.
		patch:  Str,
		/// Semantic mutation; the controller derives apply options from it.
		action: GitPatchAction,
		/// Whether the patch covers selected lines or a complete hunk.
		scope:  GitPatchScope,
	},
	/// Restore worktree paths from the index.
	Discard(Vec<Str>),
	/// Create or amend a commit.
	Commit {
		/// Complete commit message.
		message:   Str,
		/// Amend `HEAD`.
		amend:     bool,
		/// Stage every change before committing.
		stage_all: bool,
	},
}

/// Settled controller response for one [`GitOp`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitOutcome {
	/// Request that settled.
	pub op:     GitOp,
	/// Human-readable success line or typed service failure.
	pub result: ServiceResult<Str>,
}

/// Kind of change reported for one Git path.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
pub enum GitChangeKind {
	/// Existing file contents changed.
	#[strum(to_string = "M")]
	Modified,
	/// New tracked file.
	#[strum(to_string = "A")]
	Added,
	/// Removed tracked file.
	#[strum(to_string = "D")]
	Deleted,
	/// Path renamed from [`GitFileRow::orig_path`].
	#[strum(to_string = "R")]
	Renamed,
	/// New untracked file.
	#[strum(to_string = "?")]
	Untracked,
	/// File with unresolved conflicts.
	#[strum(to_string = "U")]
	Conflicted,
}

/// Repository area containing a Git file row.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitArea {
	/// Working-tree changes not present in the index.
	Unstaged,
	/// Changes present in the index.
	Staged,
	/// Changes belonging to the pinned (or HEAD) commit.
	Commit,
}

/// One changed file shown by the workbench.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitFileRow {
	/// Current repository-relative path.
	pub path:      Str,
	/// Previous path for a rename.
	pub orig_path: Option<Str>,
	/// Kind of file change.
	pub kind:      GitChangeKind,
	/// Repository area containing the change.
	pub area:      GitArea,
	/// Added line count, when known.
	pub additions: Option<u64>,
	/// Deleted line count, when known.
	pub deletions: Option<u64>,
}

/// Metadata and file changes for the HEAD or pinned commit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitInfo {
	/// Full commit object id.
	pub sha:          Str,
	/// First line of the commit message.
	pub subject:      Str,
	/// Remaining commit message body.
	pub body:         Str,
	/// Commit author's display name.
	pub author_name:  Str,
	/// Commit author's email address.
	pub author_email: Str,
	/// Commit author's strict ISO-8601 date.
	pub author_date:  Str,
	/// Full parent commit object ids.
	pub parents:      Vec<Str>,
	/// Files changed by this commit.
	pub files:        Vec<GitFileRow>,
}

/// Repository snapshot the workbench presents.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GitSnapshot {
	/// Current branch name, or `None` for detached/unborn HEAD.
	pub branch:   Option<Str>,
	/// Working-tree changes not present in the index (untracked included).
	pub unstaged: Vec<GitFileRow>,
	/// Changes present in the index.
	pub staged:   Vec<GitFileRow>,
	/// HEAD or pinned commit metadata, when available.
	pub head:     Option<GitCommitInfo>,
	/// Whether the workbench is pinned to a revision.
	pub pinned:   bool,
}

impl GitSnapshot {
	/// Whether the sidebar shows the commit view instead of the staging
	/// sections.
	#[must_use]
	pub const fn is_commit_view(&self) -> bool {
		self.pinned || (self.unstaged.is_empty() && self.staged.is_empty())
	}
}

/// Old and new text of one selected file.
#[derive(Clone, Debug, Eq, PartialEq)]
struct GitFileContents {
	old_text:  Str,
	new_text:  Str,
	binary:    bool,
	too_large: bool,
}

/// Semantic patch mutation requested from a diff selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPatchAction {
	/// Apply worktree changes to the index.
	Stage,
	/// Reverse index changes out of the index.
	Unstage,
	/// Reverse worktree changes out of the worktree.
	Discard,
}

/// Granularity of a selected patch, used for the controller's outcome line.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitPatchScope {
	/// Explicit line selection.
	Selection,
	/// Complete diff hunk.
	Hunk,
}

/// Errors surfaced as sticky status messages.
#[derive(Debug, thiserror::Error)]
enum GitError {
	#[error("{0}")]
	Vcs(#[from] omp_vcs::Error),
	#[error("{0}")]
	Io(#[from] std::io::Error),
	#[error("Selection contains no changes")]
	EmptySelection,
}

type GitResult<T> = Result<T, GitError>;

/// Synchronous repository access for the workbench.
struct GitModel {
	repo:   GitRepo,
	pinned: Option<Str>,
}

impl GitModel {
	fn open(root: &Path, revision: Option<Str>) -> GitResult<Option<Self>> {
		Ok(GitRepo::discover(root)?.map(|repo| Self { repo, pinned: revision }))
	}

	fn root(&self) -> &Path {
		self.repo.root()
	}

	fn snapshot(&self) -> GitResult<GitSnapshot> {
		let branch = self.repo.current_branch()?.map(Str::new);
		let (unstaged, staged) = if self.pinned.is_some() {
			(Vec::new(), Vec::new())
		} else {
			self.status_rows()?
		};
		let clean = unstaged.is_empty() && staged.is_empty();
		let head = match self.pinned.as_deref() {
			Some(revision) => Some(self.commit(revision, true)?),
			None => match self.repo.head_sha()? {
				Some(sha) => Some(self.commit(&sha, clean)?),
				None => None,
			},
		};
		Ok(GitSnapshot { branch, unstaged, staged, head, pinned: self.pinned.is_some() })
	}

	fn status_rows(&self) -> GitResult<(Vec<GitFileRow>, Vec<GitFileRow>)> {
		let text = self.repo.status_porcelain(&StatusOptions {
			untracked:      UntrackedMode::All,
			pathspecs:      Vec::new(),
			nul_terminated: true,
		})?;
		let worktree = self.repo.numstat(&DiffOptions::default())?;
		let index = self
			.repo
			.numstat(&DiffOptions { cached: true, ..DiffOptions::default() })?;
		let counts = |stats: &[omp_vcs::NumstatEntry], path: &str| {
			stats
				.iter()
				.find(|entry| entry.path == path)
				.map(|entry| (entry.added.map(u64::from), entry.removed.map(u64::from)))
		};
		let mut unstaged = Vec::new();
		let mut staged = Vec::new();
		let mut fields = text.split('\0');
		while let Some(entry) = fields.next() {
			let mut chars = entry.chars();
			let (Some(x), Some(y), Some(' ')) = (chars.next(), chars.next(), chars.next()) else {
				continue;
			};
			let path = Str::new(chars.as_str());
			let orig_path = matches!(x, 'R' | 'C')
				.then(|| fields.next().map(Str::new))
				.flatten();
			let row = |kind, area, counts: Option<(Option<u64>, Option<u64>)>| GitFileRow {
				path: path.clone(),
				orig_path: orig_path.clone(),
				kind,
				area,
				additions: counts.and_then(|(added, _)| added),
				deletions: counts.and_then(|(_, removed)| removed),
			};
			if x == '?' {
				unstaged.push(row(GitChangeKind::Untracked, GitArea::Unstaged, None));
				continue;
			}
			if x == 'U' || y == 'U' || (x == 'A' && y == 'A') || (x == 'D' && y == 'D') {
				unstaged.push(row(GitChangeKind::Conflicted, GitArea::Unstaged, None));
				continue;
			}
			if let Some(kind) = change_kind(x) {
				staged.push(row(kind, GitArea::Staged, counts(&index, path.as_str())));
			}
			if let Some(kind) = change_kind(y) {
				unstaged.push(row(kind, GitArea::Unstaged, counts(&worktree, path.as_str())));
			}
		}
		Ok((unstaged, staged))
	}

	fn commit(&self, revision: &str, with_files: bool) -> GitResult<GitCommitInfo> {
		let details = self.repo.commit_details(revision)?;
		let (subject, body) = details
			.message
			.split_once('\n')
			.map_or((details.message.as_str(), ""), |(subject, body)| (subject, body.trim()));
		let files = if with_files {
			let base = details
				.parents
				.first()
				.map_or(EMPTY_TREE, String::as_str)
				.to_owned();
			self
				.repo
				.numstat(&DiffOptions {
					base: Some(base),
					head: Some(details.sha.clone()),
					..DiffOptions::default()
				})?
				.into_iter()
				.map(|entry| {
					let additions = entry.added.map(u64::from);
					let deletions = entry.removed.map(u64::from);
					let kind = if additions.unwrap_or_default() > 0 && deletions == Some(0) {
						GitChangeKind::Added
					} else {
						GitChangeKind::Modified
					};
					GitFileRow {
						path: Str::new(entry.path),
						orig_path: None,
						kind,
						area: GitArea::Commit,
						additions,
						deletions,
					}
				})
				.collect()
		} else {
			Vec::new()
		};
		Ok(GitCommitInfo {
			sha: Str::new(details.sha),
			subject: Str::new(subject),
			body: Str::new(body),
			author_name: Str::new(details.author.name),
			author_email: Str::new(details.author.email),
			author_date: Str::new(details.author.date.unwrap_or_default()),
			parents: details.parents.into_iter().map(Str::new).collect(),
			files,
		})
	}

	fn contents(&self, snapshot: &GitSnapshot, file: &GitFileRow) -> GitResult<GitFileContents> {
		let old_path = file.orig_path.as_deref().unwrap_or(file.path.as_str());
		let (old, new) = match file.area {
			GitArea::Unstaged => (
				self.blob_or_empty(&format!(":0:{old_path}")),
				self.worktree_or_empty(file.path.as_str())?,
			),
			GitArea::Staged => (
				self.blob_or_empty(&format!("HEAD:{old_path}")),
				self.blob_or_empty(&format!(":0:{}", file.path)),
			),
			GitArea::Commit => {
				let head = snapshot.head.as_ref();
				let sha = head.map_or("HEAD", |head| head.sha.as_str());
				let parent = head
					.and_then(|head| head.parents.first())
					.map_or(EMPTY_TREE, Str::as_str);
				(
					self.blob_or_empty(&format!("{parent}:{old_path}")),
					self.blob_or_empty(&format!("{sha}:{}", file.path)),
				)
			},
		};
		let too_large = old.len() > MAX_DIFF_BYTES || new.len() > MAX_DIFF_BYTES;
		let binary = is_binary(&old) || is_binary(&new);
		let text = |bytes: Vec<u8>| {
			if too_large || binary {
				Str::default()
			} else {
				Str::new(String::from_utf8_lossy(&bytes).replace('\r', ""))
			}
		};
		Ok(GitFileContents { old_text: text(old), new_text: text(new), binary, too_large })
	}

	fn blob_or_empty(&self, spec: &str) -> Vec<u8> {
		self
			.repo
			.show_blob(spec, None)
			.map(|shown| shown.bytes)
			.unwrap_or_default()
	}

	fn worktree_or_empty(&self, path: &str) -> GitResult<Vec<u8>> {
		match fs::read(self.root().join(path)) {
			Ok(bytes) => Ok(bytes),
			Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
			Err(error) => Err(error.into()),
		}
	}

	/// Builds the unified patch for one inclusive old/new line selection.
	/// Applying it is controller authority and happens only after the caller
	/// emits [`GitOp::Apply`].
	fn selected_patch(
		&self,
		action: GitPatchAction,
		path: &str,
		old: (u32, u32),
		new: (u32, u32),
	) -> GitResult<Str> {
		let raw = self.repo.diff_text(&DiffOptions {
			cached: action == GitPatchAction::Unstage,
			files: vec![path.to_owned()],
			..DiffOptions::default()
		})?;
		let reverse = action != GitPatchAction::Stage;
		select_lines(&raw, old, new, reverse)
			.map(Str::new)
			.ok_or(GitError::EmptySelection)
	}

	/// Filesystem facts whose change means the snapshot may be stale.
	fn fingerprint(&self, selected: Option<&str>) -> Fingerprint {
		let mtime = |path: &Path| fs::metadata(path).and_then(|meta| meta.modified()).ok();
		Fingerprint {
			index: mtime(&self.repo.info().git_dir.join("index")),
			head:  mtime(&self.repo.head_watch_target()),
			file:  selected.and_then(|path| mtime(&self.root().join(path))),
		}
	}
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
struct Fingerprint {
	index: Option<SystemTime>,
	head:  Option<SystemTime>,
	file:  Option<SystemTime>,
}

const fn change_kind(code: char) -> Option<GitChangeKind> {
	Some(match code {
		'M' | 'T' => GitChangeKind::Modified,
		'A' => GitChangeKind::Added,
		'D' => GitChangeKind::Deleted,
		'R' | 'C' => GitChangeKind::Renamed,
		_ => return None,
	})
}

fn is_binary(bytes: &[u8]) -> bool {
	bytes[..bytes.len().min(BINARY_SNIFF_BYTES)].contains(&0)
}

/// Synthesizes a one-file patch containing only the changed lines inside
/// the inclusive `old`/`new` ranges (`(0, 0)` = that side absent).
///
/// Forward patches keep unselected deletions as context and drop
/// unselected additions; reverse patches (unstage/discard, applied against
/// the new side) keep unselected additions as context and drop unselected
/// deletions. Hunk starts on the source side are preserved, so the
/// applier's positional check still holds.
fn select_lines(raw: &str, old: (u32, u32), new: (u32, u32), reverse: bool) -> Option<String> {
	let body_start = raw.find("\n@@").map(|at| at + 1)?;
	let header = &raw[..body_start];
	let mut hunks: Vec<&str> = Vec::new();
	let mut cursor = body_start;
	for (at, _) in raw[body_start..].match_indices("\n@@") {
		let at = body_start + at + 1;
		if at > cursor {
			hunks.push(&raw[cursor..at]);
		}
		cursor = at;
	}
	hunks.push(&raw[cursor..]);
	let mut out = String::with_capacity(raw.len());
	let mut selected_total = 0_usize;
	let mut change_total = 0_usize;
	let mut delta = 0_i64;
	for hunk in hunks {
		let (head, body) = hunk.split_once('\n').unwrap_or((hunk, ""));
		let (old_start, new_start) = parse_hunk_header(head)?;
		let suffix = head
			.get(2..)
			.and_then(|rest| rest.find("@@").map(|at| &rest[at + 2..]))
			.unwrap_or_default();
		let selection = LineFilter { old, new, reverse, old_start, new_start };
		let kept = select_hunk(body, &selection);
		change_total += kept.changes;
		if kept.selected == 0 {
			continue;
		}
		selected_total += kept.selected;
		let (source_start, target_start) = if reverse {
			(new_start, i64::from(new_start) + delta)
		} else {
			(old_start, i64::from(old_start) + delta)
		};
		let target_start = u32::try_from(target_start.max(0)).unwrap_or_default();
		let (old_count, new_count) = (kept.old_count, kept.new_count);
		if reverse {
			let _ =
				writeln!(out, "@@ -{target_start},{old_count} +{source_start},{new_count} @@{suffix}");
		} else {
			let _ =
				writeln!(out, "@@ -{source_start},{old_count} +{target_start},{new_count} @@{suffix}");
		}
		delta += i64::from(new_count) - i64::from(old_count);
		out.push_str(&kept.text);
		if !out.ends_with('\n') {
			out.push('\n');
		}
	}
	if selected_total == 0 {
		return None;
	}
	let partial = selected_total != change_total;
	let mut result = String::with_capacity(header.len() + out.len());
	if partial && (header.contains("\n--- /dev/null") || header.contains("\n+++ /dev/null")) {
		let file = header.lines().find_map(|line| {
			line
				.strip_prefix("+++ b/")
				.or_else(|| line.strip_prefix("--- a/"))
		})?;
		let _ = write!(result, "diff --git a/{file} b/{file}\n--- a/{file}\n+++ b/{file}\n");
	} else {
		result.push_str(header);
	}
	result.push_str(&out);
	Some(result)
}

/// Line ranges and direction one hunk is filtered by.
struct LineFilter {
	old:       (u32, u32),
	new:       (u32, u32),
	reverse:   bool,
	old_start: u32,
	new_start: u32,
}

/// One hunk body after filtering.
struct KeptHunk {
	text:      String,
	old_count: u32,
	new_count: u32,
	selected:  usize,
	changes:   usize,
}

fn select_hunk(body: &str, selection: &LineFilter) -> KeptHunk {
	let contains = |(start, end): (u32, u32), line: u32| start != 0 && (start..=end).contains(&line);
	let mut lines = body.split_inclusive('\n').peekable();
	let mut old_line = selection.old_start;
	let mut new_line = selection.new_start;
	let mut kept = KeptHunk {
		text:      String::with_capacity(body.len()),
		old_count: 0,
		new_count: 0,
		selected:  0,
		changes:   0,
	};
	while let Some(line) = lines.next() {
		let marker = if lines.peek().is_some_and(|next| next.starts_with('\\')) {
			lines.next()
		} else {
			None
		};
		let (kind, rest) = line.split_at(line.len().min(1));
		let emit = |text: &mut String, prefix: &str| {
			text.push_str(prefix);
			text.push_str(rest);
			if let Some(marker) = marker {
				text.push_str(marker);
			}
		};
		let (take, keep_as_context) = match kind {
			"-" => {
				kept.changes += 1;
				let take = contains(selection.old, old_line);
				old_line += 1;
				(Some(take), !selection.reverse)
			},
			"+" => {
				kept.changes += 1;
				let take = contains(selection.new, new_line);
				new_line += 1;
				(Some(take), selection.reverse)
			},
			_ => {
				old_line += 1;
				new_line += 1;
				(None, true)
			},
		};
		match take {
			Some(true) => {
				kept.selected += 1;
				if kind == "-" {
					kept.old_count += 1;
				} else {
					kept.new_count += 1;
				}
				emit(&mut kept.text, kind);
			},
			Some(false) if !keep_as_context => {},
			_ => {
				kept.old_count += 1;
				kept.new_count += 1;
				emit(&mut kept.text, " ");
			},
		}
	}
	kept
}

/// Old- and new-side start lines of one `@@ -a[,b] +c[,d] @@` header.
fn parse_hunk_header(head: &str) -> Option<(u32, u32)> {
	let inner = head.strip_prefix("@@ -")?;
	let (ranges, _) = inner.split_once(" @@")?;
	let (old, new) = ranges.split_once(" +")?;
	let start = |text: &str| text.split(',').next()?.parse::<u32>().ok();
	Some((start(old)?, start(new)?))
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum Focus {
	Diff,
	#[default]
	Sidebar,
}

impl Focus {
	const fn hint(self) -> &'static str {
		match self {
			Self::Diff => DIFF_HINT,
			Self::Sidebar => SIDEBAR_HINT,
		}
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PendingDiscard {
	path:   Str,
	target: DiffTarget,
}

#[derive(Clone, Debug)]
struct StatusMessage {
	text:   Str,
	color:  Color,
	at:     Duration,
	sticky: bool,
}

/// Visual partition within one staged or unstaged file section.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SidebarGroup {
	/// Modified, deleted, renamed, and conflicted tracked paths.
	Changes,
	/// Unstaged additions rendered separately without status badges.
	Additions,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum SidebarTarget {
	ViewStyle,
	Section { area: GitArea },
	Directory { area: GitArea, path: Str, depth: usize, group: SidebarGroup },
	File { area: GitArea, path: Str, depth: usize },
	Amend,
	Summary,
	Description,
	Commit,
}

impl SidebarTarget {
	fn key(&self) -> Str {
		match self {
			Self::ViewStyle => Str::new_static("sidebar-view"),
			Self::Section { area: GitArea::Unstaged } => Str::new_static("unstaged-section"),
			Self::Section { area: GitArea::Staged } => Str::new_static("staged-section"),
			Self::Section { area: GitArea::Commit } => Str::new_static("commit-section"),
			Self::Directory { area, path, group, .. } => sf!("dir:{area:?}:{group:?}:{path}"),
			Self::File { area, path, .. } => sf!("file:{area:?}:{path}"),
			Self::Amend => Str::new_static("amend"),
			Self::Summary => Str::new_static("summary"),
			Self::Description => Str::new_static("description"),
			Self::Commit => Str::new_static("commit"),
		}
	}

	const fn is_tree_node(&self) -> bool {
		matches!(self, Self::Section { .. } | Self::Directory { .. } | Self::File { .. })
	}

	const fn is_file_or_directory(&self) -> bool {
		matches!(self, Self::Directory { .. } | Self::File { .. })
	}

	const fn depth(&self) -> Option<usize> {
		match self {
			Self::Directory { depth, .. } | Self::File { depth, .. } => Some(*depth),
			_ => None,
		}
	}
}

#[derive(Clone)]
struct SidebarRow {
	target:       SidebarTarget,
	status:       Option<Str>,
	status_color: Color,
	directory:    Str,
	basename:     Str,
	additions:    Option<u64>,
	deletions:    Option<u64>,
	strike:       bool,
}

#[derive(Default)]
struct FileTreeNode {
	files:    Vec<(GitArea, GitFileRow)>,
	children: std::collections::BTreeMap<Str, FileTreeNode>,
}

/// Retained fullscreen Git workbench panel.
pub struct GitWorkbench {
	model: GitModel,
	ui: Ui,
	ctx: UiContext,
	snapshot: GitSnapshot,
	selected: Option<(GitArea, Str)>,
	sidebar_rows: Vec<SidebarRow>,
	sidebar_selected: usize,
	focus: Focus,
	tree: bool,
	collapsed: BTreeSet<Str>,
	contents: Option<GitFileContents>,
	whitespace: DiffWhitespaceMode,
	view_mode: ViewMode,
	wrap: bool,
	amend: bool,
	status: Option<StatusMessage>,
	pending_discard: Option<PendingDiscard>,
	sidebar_follow_selection: bool,
	pending_last_hunk: bool,
	now: Duration,
	next_refresh: Duration,
	fingerprint: Fingerprint,
	width: u16,
	height: u16,
}

impl GitWorkbench {
	/// Opens the workbench for the project root recorded in the session
	/// prompt facts (falling back to the process cwd); `revision` pins the
	/// view to one commit.
	pub fn open(cx: &PanelCx<'_>, revision: Option<Str>) -> Result<Self, Str> {
		let root = project_root(cx.dom);
		Self::open_at(&root, revision, cx.ui, cx.viewport)
	}

	/// Opens the workbench over the repository containing `root`.
	pub fn open_at(
		root: &Path,
		revision: Option<Str>,
		ctx: &UiContext,
		viewport: Size,
	) -> Result<Self, Str> {
		let model = GitModel::open(root, revision)
			.map_err(|error| sf!("{error}"))?
			.ok_or_else(|| sf!("Not a git repository: {}", root.display()))?;
		let snapshot = model.snapshot().map_err(|error| sf!("{error}"))?;
		let selected = first_file(&snapshot).map(|file| (file.area, file.path.clone()));
		let fingerprint = model.fingerprint(selected.as_ref().map(|(_, path)| path.as_str()));
		let mut workbench = Self {
			model,
			ui: Ui::from_root(dom! { <col/> }, viewport.width.max(1), ctx.clone()),
			ctx: ctx.clone(),
			snapshot,
			selected,
			sidebar_rows: Vec::new(),
			sidebar_selected: 0,
			focus: Focus::Sidebar,
			tree: true,
			collapsed: BTreeSet::new(),
			contents: None,
			whitespace: DiffWhitespaceMode::Off,
			view_mode: ViewMode::Split,
			wrap: false,
			amend: false,
			status: None,
			pending_discard: None,
			sidebar_follow_selection: true,
			pending_last_hunk: false,
			now: Duration::ZERO,
			next_refresh: Duration::ZERO,
			fingerprint,
			width: viewport.width.max(40),
			height: viewport.height.max(10),
		};
		workbench.load_selected();
		workbench.rebuild();
		Ok(workbench)
	}

	/// Current repository snapshot.
	#[must_use]
	pub fn snapshot(&self) -> &GitSnapshot {
		&self.snapshot
	}

	/// Currently shown key hint or status text.
	#[must_use]
	pub fn status_text(&self) -> Str {
		self
			.status
			.as_ref()
			.map_or_else(|| Str::new_static(self.focus.hint()), |status| status.text.clone())
	}

	/// Re-reads the repository and reconciles the selection.
	pub fn refresh(&mut self) {
		match self.model.snapshot() {
			Ok(snapshot) => self.apply_snapshot(snapshot),
			Err(error) => self.fail(error),
		}
	}

	fn fail(&mut self, error: GitError) {
		self.set_status(single_line(&error.to_string()), self.ctx.theme.err, true);
		self.pending_discard = None;
		self.rebuild();
	}

	fn done(&mut self, message: Str) {
		self.set_status(message, self.ctx.theme.ok, false);
		self.pending_discard = None;
		self.refresh();
	}

	fn set_status(&mut self, text: Str, color: Color, sticky: bool) {
		self.status = Some(StatusMessage { text: text.clone(), color, at: self.now, sticky });
		let _ = self.ui.set_text(STATUS_ID, text);
		let _ = self.ui.set_prop(STATUS_ID, Prop::Fg, color);
	}

	fn apply_snapshot(&mut self, snapshot: GitSnapshot) {
		self.pending_discard = None;
		let previous_rows = self.sidebar_rows.clone();
		let previous_target = self.current_sidebar_target().cloned();
		let previous_selected = self.selected.clone();
		self.snapshot = snapshot;
		self.sidebar_rows = sidebar_rows(&self.snapshot, self.tree, &self.ctx);
		if let Some(target) = previous_target {
			let key = target.key();
			if let Some(index) = self
				.sidebar_rows
				.iter()
				.position(|row| row.target.key() == key)
			{
				self.sidebar_selected = index;
			} else if let Some(survivor) = nearest_survivor(&previous_rows, &self.sidebar_rows, &key) {
				self.set_sidebar_index_for_key(survivor.as_str());
			}
		}
		self.selected = previous_selected
			.clone()
			.filter(|(area, path)| find_file(&self.snapshot, *area, path.as_str()).is_some());
		if self.selected.is_none() {
			self.selected = self
				.current_sidebar_target()
				.and_then(|target| match target {
					SidebarTarget::File { area, path, .. } => Some((*area, path.clone())),
					_ => None,
				})
				.or_else(|| first_file(&self.snapshot).map(|file| (file.area, file.path.clone())));
		}
		self.load_selected();
		self.fingerprint = self
			.model
			.fingerprint(self.selected.as_ref().map(|(_, path)| path.as_str()));
		self.rebuild();
	}

	fn load_selected(&mut self) {
		self.contents = self
			.selected
			.as_ref()
			.and_then(|(area, path)| find_file(&self.snapshot, *area, path.as_str()))
			.and_then(|file| self.model.contents(&self.snapshot, file).ok());
		self.install_document();
	}

	fn handle_key(&mut self, key: Key) -> PanelEvent {
		if key != Key::Char('x') {
			self.pending_discard = None;
		}
		if matches!(key, Key::Tab | Key::BackTab) {
			self.focus = if self.focus == Focus::Diff {
				Focus::Sidebar
			} else {
				Focus::Diff
			};
			self.focus_current();
			return PanelEvent::Consumed;
		}
		if key == Key::Esc {
			if self.focus == Focus::Sidebar && self.editing() {
				self.select_target_kind(&SidebarTarget::Commit);
				return PanelEvent::Consumed;
			}
			if self.focus == Focus::Diff && self.clear_diff_selection() {
				return PanelEvent::Consumed;
			}
			return PanelEvent::Close;
		}
		if !self.editing() {
			match key {
				Key::Char('q') => return PanelEvent::Close,
				Key::JumpPrevious | Key::RestoreQueue => return self.jump_hunk_or_file(-1),
				Key::JumpNext => return self.jump_hunk_or_file(1),
				Key::Char('[') => return self.select_adjacent_file(-1, false),
				Key::Char(']') => return self.select_adjacent_file(1, false),
				Key::Char('v') => {
					let next = match self.view_mode {
						ViewMode::File => ViewMode::Split,
						ViewMode::Split => ViewMode::Inline,
						ViewMode::Inline => ViewMode::Hunk,
						ViewMode::Hunk => ViewMode::File,
					};
					return self.set_mode(next);
				},
				Key::Char('1') => return self.set_mode(ViewMode::File),
				Key::Char('2') => return self.set_mode(ViewMode::Split),
				Key::Char('3') => return self.set_mode(ViewMode::Inline),
				Key::Char('4') => return self.set_mode(ViewMode::Hunk),
				Key::Char('w') => return self.toggle_wrap(),
				Key::Char('b') => return self.cycle_whitespace(),
				Key::Char('r') => {
					self.refresh();
					return PanelEvent::Consumed;
				},
				Key::Char('c') if !self.snapshot.is_commit_view() => {
					self.focus = Focus::Sidebar;
					self.select_target_kind(&SidebarTarget::Summary);
					return PanelEvent::Consumed;
				},
				_ => {},
			}
		}
		match self.focus {
			Focus::Diff => self.handle_diff_key(key),
			Focus::Sidebar => self.handle_sidebar_key(key),
		}
	}

	fn handle_diff_key(&mut self, key: Key) -> PanelEvent {
		match key {
			Key::Char('s') => self.request_diff_action(DiffActionKind::Stage),
			Key::Char('u') => self.request_diff_action(DiffActionKind::Unstage),
			Key::Char('x') => self.request_discard(),
			Key::Enter | Key::Char('n') => self.jump_hunk_or_file(1),
			Key::Char('p') => self.jump_hunk_or_file(-1),
			Key::Char('j') => self.route_diff_navigation(Key::Down),
			Key::Char('k') => self.route_diff_navigation(Key::Up),
			Key::Char('h') => self.route_diff_navigation(Key::Left),
			Key::Char('l') => self.route_diff_navigation(Key::Right),
			Key::Char('g') => self.route_diff_navigation(Key::Home),
			Key::Char('G') => self.route_diff_navigation(Key::End),
			Key::Space => self.route_diff_navigation(Key::PageDown),
			_ => self.route_diff_navigation(key),
		}
	}

	fn route_diff_navigation(&mut self, key: Key) -> PanelEvent {
		self.focus_current();
		let event = self.ui.handle_key(key);
		self.sync_control_values();
		self.route_ui(event)
	}

	fn handle_sidebar_key(&mut self, key: Key) -> PanelEvent {
		if self.editing() {
			return self.handle_editor_key(key);
		}
		if matches!(key, Key::Space | Key::Char('s') | Key::Char('u'))
			&& self
				.current_sidebar_target()
				.is_some_and(SidebarTarget::is_tree_node)
			&& let Some(selected) = self.tree_selected_key()
		{
			self.set_sidebar_index_for_key(selected.as_str());
		}
		let target = self.current_sidebar_target().cloned();
		match (target, key) {
			(_, Key::Char('t')) => {
				self.tree = !self.tree;
				self.rebuild();
				PanelEvent::Consumed
			},
			(Some(SidebarTarget::Amend), Key::Up | Key::Char('k')) => {
				self.focus_tree();
				PanelEvent::Consumed
			},
			(Some(SidebarTarget::Amend), Key::Down | Key::Char('j')) => {
				self.select_target_kind(&SidebarTarget::Summary);
				PanelEvent::Consumed
			},
			(Some(SidebarTarget::Amend), Key::Enter | Key::Space) => self.toggle_amend(),
			(Some(SidebarTarget::Commit), Key::Up | Key::Char('k')) => {
				self.select_target_kind(&SidebarTarget::Description);
				PanelEvent::Consumed
			},
			(Some(SidebarTarget::Commit), Key::Enter | Key::Space) => self.submit_commit(),
			(Some(SidebarTarget::ViewStyle), _) => self.route_sidebar_tree_key(key),
			(Some(target), Key::Space)
				if matches!(target, SidebarTarget::File { .. } | SidebarTarget::Directory { .. }) =>
			{
				self.activate_sidebar(true)
			},
			(Some(target), Key::Char('s')) if target.is_tree_node() => {
				self.explicit_sidebar_stage(true)
			},
			(Some(target), Key::Char('u')) if target.is_tree_node() => {
				self.explicit_sidebar_stage(false)
			},
			(Some(target), Key::Char('j')) if target.is_tree_node() => {
				self.route_sidebar_tree_key(Key::Down)
			},
			(Some(target), Key::Char('k')) if target.is_tree_node() => {
				self.route_sidebar_tree_key(Key::Up)
			},
			(Some(target), Key::Char('h')) if target.is_tree_node() => {
				self.route_sidebar_tree_key(Key::Left)
			},
			(Some(target), Key::Char('l')) if target.is_tree_node() => {
				self.route_sidebar_tree_key(Key::Right)
			},
			(Some(target), Key::Char('g')) if target.is_tree_node() => {
				self.route_sidebar_tree_key(Key::Home)
			},
			(Some(target), Key::Char('G')) if target.is_tree_node() => {
				self.route_sidebar_tree_key(Key::End)
			},
			(Some(target), _) if target.is_tree_node() => self.route_sidebar_tree_key(key),
			_ => {
				let event = self.ui.handle_key(key);
				self.sync_control_values();
				self.route_ui(event)
			},
		}
	}

	fn handle_editor_key(&mut self, key: Key) -> PanelEvent {
		match (self.current_sidebar_target().cloned(), key) {
			(Some(SidebarTarget::Summary), Key::Up) => {
				self.select_target_kind(&SidebarTarget::Amend);
				return PanelEvent::Consumed;
			},
			(Some(SidebarTarget::Summary), Key::Down | Key::Enter) => {
				self.select_target_kind(&SidebarTarget::Description);
				return PanelEvent::Consumed;
			},
			(Some(SidebarTarget::Description), Key::Up) if self.editor_on_first_line() => {
				self.select_target_kind(&SidebarTarget::Summary);
				return PanelEvent::Consumed;
			},
			(Some(SidebarTarget::Description), Key::Down) if self.editor_on_last_line() => {
				self.select_target_kind(&SidebarTarget::Commit);
				return PanelEvent::Consumed;
			},
			_ => {},
		}
		let event = self.ui.handle_key(key);
		self.sync_commit_button();
		self.route_ui(event)
	}

	fn activate_sidebar(&mut self, stage: bool) -> PanelEvent {
		let Some(target) = self.current_sidebar_target().cloned() else {
			return PanelEvent::Consumed;
		};
		match target {
			SidebarTarget::Directory { area, path, group, .. } if stage => {
				self.stage_directory(area, path.as_str(), group)
			},
			SidebarTarget::Directory { .. } => PanelEvent::Consumed,
			SidebarTarget::File { area, path, .. } if stage => self.stage_paths(area, vec![path]),
			SidebarTarget::File { .. } => {
				self.focus = Focus::Diff;
				self.focus_current();
				PanelEvent::Consumed
			},
			SidebarTarget::Section { area: GitArea::Unstaged } => self.stage_all(),
			SidebarTarget::Section { area: GitArea::Staged } => self.unstage_all(),
			SidebarTarget::Section { area: GitArea::Commit } | SidebarTarget::ViewStyle => {
				PanelEvent::Consumed
			},
			SidebarTarget::Amend => self.toggle_amend(),
			SidebarTarget::Summary | SidebarTarget::Description => {
				self.focus_current();
				PanelEvent::Consumed
			},
			SidebarTarget::Commit => self.submit_commit(),
		}
	}

	fn explicit_sidebar_stage(&mut self, stage: bool) -> PanelEvent {
		let Some(target) = self.current_sidebar_target().cloned() else {
			return PanelEvent::Consumed;
		};
		match target {
			SidebarTarget::File { area, path, .. }
				if (stage && area == GitArea::Unstaged) || (!stage && area == GitArea::Staged) =>
			{
				self.stage_paths(area, vec![path])
			},
			SidebarTarget::Directory { area, path, group, .. }
				if (stage && area == GitArea::Unstaged) || (!stage && area == GitArea::Staged) =>
			{
				self.stage_directory(area, path.as_str(), group)
			},
			SidebarTarget::Section { area: GitArea::Unstaged } if stage => self.stage_all(),
			SidebarTarget::Section { area: GitArea::Staged } if !stage => self.unstage_all(),
			_ => PanelEvent::Consumed,
		}
	}

	fn stage_directory(
		&mut self,
		area: GitArea,
		directory: &str,
		group: SidebarGroup,
	) -> PanelEvent {
		let files = match area {
			GitArea::Unstaged => &self.snapshot.unstaged,
			GitArea::Staged => &self.snapshot.staged,
			GitArea::Commit => return PanelEvent::Consumed,
		};
		let paths = files
			.iter()
			.filter(|file| {
				let in_directory = file
					.path
					.strip_prefix(directory)
					.is_some_and(|suffix| suffix.starts_with('/'));
				let in_group = is_addition(file) == (group == SidebarGroup::Additions);
				in_directory && (area != GitArea::Unstaged || in_group)
			})
			.map(|file| file.path.clone())
			.collect();
		self.stage_paths(area, paths)
	}

	fn stage_paths(&mut self, area: GitArea, paths: Vec<Str>) -> PanelEvent {
		if paths.is_empty() {
			return PanelEvent::Consumed;
		}
		let op = match area {
			GitArea::Unstaged => GitOp::Stage(Some(paths)),
			GitArea::Staged => GitOp::Unstage(Some(paths)),
			GitArea::Commit => return PanelEvent::Consumed,
		};
		PanelEvent::Command(HostCommand::Git(op))
	}

	fn stage_all(&mut self) -> PanelEvent {
		PanelEvent::Command(HostCommand::Git(GitOp::Stage(None)))
	}

	fn unstage_all(&mut self) -> PanelEvent {
		PanelEvent::Command(HostCommand::Git(GitOp::Unstage(None)))
	}

	fn settle(&mut self, outcome: &GitOutcome) -> PanelEvent {
		match &outcome.result {
			Ok(message) => {
				self.done(message.clone());
				if matches!(&outcome.op, GitOp::Commit { .. }) {
					self.amend = false;
					self.rebuild_with_form("", "");
				}
				PanelEvent::Notice(message.clone())
			},
			Err(error) => {
				let message = sf!("{error}");
				self.set_status(message.clone(), self.ctx.theme.err, true);
				self.pending_discard = None;
				self.rebuild();
				PanelEvent::Notice(message)
			},
		}
	}

	fn request_patch(
		&mut self,
		action: GitPatchAction,
		scope: GitPatchScope,
		path: &str,
		old: (u32, u32),
		new: (u32, u32),
		clear_selection: bool,
	) -> PanelEvent {
		let patch = match self.model.selected_patch(action, path, old, new) {
			Ok(patch) => patch,
			Err(error) => {
				self.fail(error);
				return PanelEvent::Consumed;
			},
		};
		if clear_selection {
			let _ = self.clear_diff_selection();
		}
		PanelEvent::Command(HostCommand::Git(GitOp::Apply { patch, action, scope }))
	}

	fn toggle_amend(&mut self) -> PanelEvent {
		self.amend = !self.amend;
		let (summary, description) = self.form_values();
		if self.amend
			&& summary.is_empty()
			&& description.is_empty()
			&& let Some(head) = &self.snapshot.head
		{
			let subject = head.subject.clone();
			let body = head.body.clone();
			self.rebuild_with_form(subject.as_str(), body.as_str());
			return PanelEvent::Consumed;
		}
		let _ = self.ui.set_prop(AMEND_ID, Prop::Checked, self.amend);
		self.sync_commit_button();
		PanelEvent::Consumed
	}

	fn submit_commit(&mut self) -> PanelEvent {
		let (summary, description) = self.form_values();
		if !self.commit_enabled_with(summary.as_str(), description.as_str()) {
			return PanelEvent::Consumed;
		}
		let summary = summary.as_str().trim();
		let body = description.as_str().trim();
		if summary.is_empty() {
			self.set_status(
				Str::new_static("Enter a commit summary first"),
				self.ctx.theme.warn,
				false,
			);
			return PanelEvent::Consumed;
		}
		let message = if body.is_empty() {
			summary.to_str()
		} else {
			sf!("{summary}\n\n{body}")
		};
		let stage_all = self.snapshot.staged.is_empty();
		PanelEvent::Command(HostCommand::Git(GitOp::Commit { message, amend: self.amend, stage_all }))
	}

	fn request_diff_action(&mut self, action: DiffActionKind) -> PanelEvent {
		let event = self
			.ui
			.with_component_mut::<DiffPane, _>(DIFF_ID, |pane| pane.request_action(action))
			.flatten();
		event.map_or(PanelEvent::Consumed, |event| self.route_ui(event))
	}

	fn request_discard(&mut self) -> PanelEvent {
		let event = self
			.ui
			.with_component_mut::<DiffPane, _>(DIFF_ID, |pane| {
				pane.request_action(DiffActionKind::Discard)
			})
			.flatten();
		let Some(UiEvent::DiffAction { target, .. }) = event else {
			return PanelEvent::Consumed;
		};
		self.confirm_discard(target)
	}

	fn confirm_discard(&mut self, target: DiffTarget) -> PanelEvent {
		if target == DiffTarget::File {
			return PanelEvent::Consumed;
		}
		let Some((GitArea::Unstaged, path)) = self.selected.clone() else {
			return PanelEvent::Consumed;
		};
		let identity = PendingDiscard { path, target: target.clone() };
		if self.pending_discard.as_ref() != Some(&identity) {
			let label = if matches!(target, DiffTarget::Lines { .. }) {
				"Discard selected lines? Press x again to confirm"
			} else {
				"Discard hunk? Press x (or click) again to confirm"
			};
			self.pending_discard = Some(identity);
			self.set_status(Str::new_static(label), self.ctx.theme.warn, false);
			return PanelEvent::Consumed;
		}
		self.pending_discard = None;
		self.map_diff_action(DiffActionKind::Discard, target)
	}

	fn route_ui(&mut self, event: UiEvent) -> PanelEvent {
		match event {
			UiEvent::TreeActivated { id, key } if id.as_str() == SIDEBAR_ID => {
				let selected = self.select_tree_key(key.as_str());
				if matches!(self.current_sidebar_target(), Some(SidebarTarget::Section { .. })) {
					if !self.collapsed.remove(&key) {
						self.collapsed.insert(key);
					}
					self.rebuild();
					return PanelEvent::Consumed;
				}
				if matches!(self.current_sidebar_target(), Some(SidebarTarget::File { .. })) {
					self.focus = Focus::Diff;
					self.focus_current();
				}
				selected
			},
			UiEvent::TreeToggled { id, key, expanded } if id.as_str() == SIDEBAR_ID => {
				self.set_sidebar_index_for_key(key.as_str());
				if let Some(expanded) = expanded {
					if expanded {
						self.collapsed.remove(&key);
					} else {
						self.collapsed.insert(key);
					}
					PanelEvent::Consumed
				} else {
					self.activate_sidebar(true)
				}
			},
			UiEvent::TreeAction { id, key, action } if id.as_str() == SIDEBAR_ID => {
				self.set_sidebar_index_for_key(key.as_str());
				match action.as_str() {
					"Stage All" => self.stage_all(),
					"Unstage All" => self.unstage_all(),
					_ => PanelEvent::Consumed,
				}
			},
			UiEvent::DiffAction { action: DiffActionKind::Discard, target, .. } => {
				self.confirm_discard(target)
			},
			UiEvent::DiffAction { action, target, .. } => self.map_diff_action(action, target),
			UiEvent::Pressed(id) => self.activate_chrome(id.as_str()),
			UiEvent::Changed { id, value } if id.as_str() == VIEW_STYLE_ID => {
				self.tree = value.as_str() == "tree";
				self.rebuild();
				PanelEvent::Consumed
			},
			UiEvent::Changed { id, value } if id.as_str() == VIEW_ID => {
				let Ok(mode) = value.as_str().parse::<ViewMode>() else {
					return PanelEvent::Consumed;
				};
				self.set_mode(mode)
			},
			UiEvent::Changed { id, value } if id.as_str() == AMEND_ID => {
				if (value.as_str() == "true") == self.amend {
					PanelEvent::Consumed
				} else {
					self.toggle_amend()
				}
			},
			UiEvent::Cancel => PanelEvent::Close,
			_ => PanelEvent::Consumed,
		}
	}

	fn map_diff_action(&mut self, action: DiffActionKind, target: DiffTarget) -> PanelEvent {
		let Some((area, path)) = self.selected.clone() else {
			return PanelEvent::Consumed;
		};
		let valid = matches!(
			(action, area),
			(DiffActionKind::Stage | DiffActionKind::Discard, GitArea::Unstaged)
				| (DiffActionKind::Unstage, GitArea::Staged)
		);
		if !valid || (action == DiffActionKind::Discard && target == DiffTarget::File) {
			return PanelEvent::Consumed;
		}
		let action = match action {
			DiffActionKind::Stage => GitPatchAction::Stage,
			DiffActionKind::Unstage => GitPatchAction::Unstage,
			DiffActionKind::Discard => GitPatchAction::Discard,
		};
		match target {
			DiffTarget::File => match action {
				GitPatchAction::Stage | GitPatchAction::Unstage => self.stage_paths(area, vec![path]),
				GitPatchAction::Discard => PanelEvent::Consumed,
			},
			DiffTarget::Lines { old, new } => {
				self.request_patch(action, GitPatchScope::Selection, path.as_str(), old, new, true)
			},
			DiffTarget::Hunk(index) => {
				let ranges = self
					.ui
					.with_component_mut::<DiffPane, _>(DIFF_ID, |pane| {
						pane.document().and_then(|document| {
							document.hunks.get(index).map(|hunk| {
								(inclusive_range(hunk.old_range), inclusive_range(hunk.new_range))
							})
						})
					})
					.flatten();
				let Some((old, new)) = ranges else {
					return PanelEvent::Consumed;
				};
				self.request_patch(action, GitPatchScope::Hunk, path.as_str(), old, new, false)
			},
		}
	}

	fn activate_chrome(&mut self, id: &str) -> PanelEvent {
		match id {
			"git-close" => PanelEvent::Close,
			"git-stage-file" | "git-unstage-file" => match self.selected.clone() {
				Some((area, path)) => self.stage_paths(area, vec![path]),
				None => PanelEvent::Consumed,
			},
			"git-up" => self.jump_hunk_or_file(-1),
			"git-down" => self.jump_hunk_or_file(1),
			"git-ws" => self.cycle_whitespace(),
			"git-wrap" => self.toggle_wrap(),
			COMMIT_ID => self.submit_commit(),
			_ => PanelEvent::Consumed,
		}
	}

	fn set_mode(&mut self, mode: ViewMode) -> PanelEvent {
		self.with_pane(|pane| pane.set_mode(mode));
		self.view_mode = mode;
		self.rebuild();
		PanelEvent::Consumed
	}

	fn toggle_wrap(&mut self) -> PanelEvent {
		self.with_pane(DiffPane::toggle_wrap);
		self.wrap = !self.wrap;
		let _ = self.ui.set_prop("git-wrap", Prop::Active, self.wrap);
		PanelEvent::Consumed
	}

	fn cycle_whitespace(&mut self) -> PanelEvent {
		let (next, label) = match self.whitespace {
			DiffWhitespaceMode::Off => {
				(DiffWhitespaceMode::Whitespace, "Ignoring whitespace-only line changes")
			},
			DiffWhitespaceMode::Whitespace => {
				(DiffWhitespaceMode::Formatting, "Ignoring formatting and import-only changes")
			},
			DiffWhitespaceMode::Formatting => (DiffWhitespaceMode::Off, "Showing all changes"),
		};
		self.whitespace = next;
		self.set_status(Str::new_static(label), self.ctx.theme.muted, false);
		self.install_document();
		self.rebuild();
		PanelEvent::Consumed
	}

	fn jump_hunk_or_file(&mut self, direction: i8) -> PanelEvent {
		let moved = self
			.ui
			.with_component_mut::<DiffPane, _>(DIFF_ID, |pane| pane.jump_hunk(direction))
			.unwrap_or(false);
		if moved {
			return PanelEvent::Consumed;
		}
		self.select_adjacent_file(if direction < 0 { -1 } else { 1 }, direction < 0)
	}

	fn select_adjacent_file(&mut self, direction: isize, land_last: bool) -> PanelEvent {
		let Some((area, path)) = self.selected.as_ref() else {
			return PanelEvent::Consumed;
		};
		let start = self
			.sidebar_rows
			.iter()
			.position(|row| {
				matches!(&row.target, SidebarTarget::File { area: row_area, path: row_path, .. }
					if row_area == area && row_path == path)
			})
			.unwrap_or(self.sidebar_selected);
		let Some(mut index) = start.checked_add_signed(direction) else {
			return PanelEvent::Consumed;
		};
		while index < self.sidebar_rows.len() {
			if matches!(self.sidebar_rows[index].target, SidebarTarget::File { .. }) {
				self.pending_last_hunk = land_last;
				self.select_sidebar(index);
				return PanelEvent::Consumed;
			}
			let Some(next) = index.checked_add_signed(direction) else {
				break;
			};
			index = next;
		}
		PanelEvent::Consumed
	}

	fn select_sidebar(&mut self, index: usize) {
		let index = index.min(self.sidebar_rows.len().saturating_sub(1));
		if self.sidebar_selected != index {
			self.sidebar_follow_selection = true;
		}
		self.sidebar_selected = index;
		if let Some(key) = self
			.current_sidebar_target()
			.filter(|target| target.is_tree_node())
			.map(SidebarTarget::key)
		{
			let _ = self
				.ui
				.with_component_mut::<Tree, _>(SIDEBAR_ID, |tree| tree.select_key(key.as_str()));
		}
		let next = self
			.current_sidebar_target()
			.and_then(|target| match target {
				SidebarTarget::File { area, path, .. } => Some((*area, path.clone())),
				_ => None,
			});
		self.focus_current();
		if let Some(next) = next
			&& self.selected.as_ref() != Some(&next)
		{
			self.selected = Some(next);
			self.load_selected();
			self.fingerprint = self
				.model
				.fingerprint(self.selected.as_ref().map(|(_, path)| path.as_str()));
			self.rebuild();
		}
	}

	fn set_sidebar_index_for_key(&mut self, key: &str) -> bool {
		let Some(index) = self
			.sidebar_rows
			.iter()
			.position(|row| row.target.key().as_str() == key)
		else {
			return false;
		};
		if self.sidebar_selected != index {
			self.sidebar_follow_selection = true;
		}
		self.sidebar_selected = index;
		true
	}

	fn select_tree_key(&mut self, key: &str) -> PanelEvent {
		if self.set_sidebar_index_for_key(key) {
			self.select_sidebar(self.sidebar_selected);
		}
		PanelEvent::Consumed
	}

	fn tree_selected_key(&self) -> Option<Str> {
		self
			.ui
			.values()
			.get(SIDEBAR_ID)
			.and_then(serde_json::Value::as_str)
			.map(Str::new)
	}

	fn route_sidebar_tree_key(&mut self, key: Key) -> PanelEvent {
		let before = self.tree_selected_key();
		let previous = self.current_sidebar_target().cloned();
		let event = self.ui.handle_key(key);
		let tree_event = matches!(
			event,
			UiEvent::TreeActivated { .. } | UiEvent::TreeToggled { .. } | UiEvent::TreeAction { .. }
		);
		self.sync_control_values();
		let routed = self.route_ui(event);
		if tree_event || routed != PanelEvent::Consumed {
			return routed;
		}
		let after = self.tree_selected_key();
		if after != before {
			return after
				.as_deref()
				.map_or(PanelEvent::Consumed, |selected| self.select_tree_key(selected));
		}
		match (previous, key) {
			(Some(SidebarTarget::ViewStyle), Key::Down) => self.focus_tree(),
			(Some(target), Key::Up) if target.is_tree_node() => {
				self.select_target_kind(&SidebarTarget::ViewStyle);
				PanelEvent::Consumed
			},
			(Some(target), Key::Down) if target.is_tree_node() && !self.snapshot.is_commit_view() => {
				self.select_target_kind(&SidebarTarget::Amend);
				PanelEvent::Consumed
			},
			_ => routed,
		}
	}

	fn focus_tree(&mut self) -> PanelEvent {
		let selected = self.tree_selected_key();
		if let Some(key) = &selected {
			self.set_sidebar_index_for_key(key.as_str());
		}
		let _ = self.ui.focus_id(SIDEBAR_ID);
		if let Some(key) = selected {
			let _ = self
				.ui
				.with_component_mut::<Tree, _>(SIDEBAR_ID, |tree| tree.select_key(key.as_str()));
		}
		PanelEvent::Consumed
	}

	fn current_sidebar_target(&self) -> Option<&SidebarTarget> {
		self
			.sidebar_rows
			.get(self.sidebar_selected)
			.map(|row| &row.target)
	}

	fn select_target_kind(&mut self, desired: &SidebarTarget) {
		let desired_key = desired.key();
		if let Some(index) = self
			.sidebar_rows
			.iter()
			.position(|row| row.target.key() == desired_key)
		{
			if self.sidebar_selected != index {
				self.sidebar_follow_selection = true;
			}
			self.sidebar_selected = index;
		}
		self.focus_current();
	}

	fn focus_current(&mut self) {
		let selected_tree_key = self
			.current_sidebar_target()
			.filter(|target| target.is_tree_node())
			.map(SidebarTarget::key);
		let id = match self.focus {
			Focus::Diff => DIFF_ID,
			Focus::Sidebar => match self.current_sidebar_target() {
				Some(SidebarTarget::ViewStyle) => VIEW_STYLE_ID,
				Some(SidebarTarget::Amend) => AMEND_ID,
				Some(SidebarTarget::Summary) => SUMMARY_ID,
				Some(SidebarTarget::Description) => DESCRIPTION_ID,
				Some(SidebarTarget::Commit) => COMMIT_ID,
				_ => SIDEBAR_ID,
			},
		};
		let _ = self.ui.focus_id(id);
		if self.focus == Focus::Sidebar
			&& let Some(key) = selected_tree_key
		{
			let _ = self
				.ui
				.with_component_mut::<Tree, _>(SIDEBAR_ID, |tree| tree.select_key(key.as_str()));
		}
		let color = if self.focus == Focus::Sidebar {
			self.ctx.theme.accent
		} else {
			self.ctx.theme.border
		};
		let _ = self.ui.set_prop(SEPARATOR_ID, Prop::Fg, color);
		if self.status.is_none() {
			let _ = self.ui.set_text(STATUS_ID, self.focus.hint());
		}
	}

	fn editing(&self) -> bool {
		self.focus == Focus::Sidebar
			&& matches!(
				self.current_sidebar_target(),
				Some(SidebarTarget::Summary | SidebarTarget::Description)
			)
	}

	fn editor_on_first_line(&mut self) -> bool {
		self
			.ui
			.with_component_mut::<EditorPane, _>(DESCRIPTION_PANE_ID, |editor| {
				editor.cursor_on_first_line()
			})
			.unwrap_or(true)
	}

	fn editor_on_last_line(&mut self) -> bool {
		self
			.ui
			.with_component_mut::<EditorPane, _>(DESCRIPTION_PANE_ID, |editor| {
				editor.cursor_on_last_line()
			})
			.unwrap_or(true)
	}

	fn clear_diff_selection(&mut self) -> bool {
		self
			.ui
			.with_component_mut::<DiffPane, _>(DIFF_ID, DiffPane::clear_selection)
			.unwrap_or(false)
	}

	fn form_values(&self) -> (Str, Str) {
		let values = self.ui.values();
		let text = |id: &str| {
			values
				.get(id)
				.and_then(serde_json::Value::as_str)
				.map_or_else(Str::default, Str::new)
		};
		(text(SUMMARY_ID), text(DESCRIPTION_ID))
	}

	fn commit_enabled_with(&self, summary: &str, description: &str) -> bool {
		(!summary.trim().is_empty() || description.trim().is_empty())
			&& (!self.snapshot.staged.is_empty()
				|| !self.snapshot.unstaged.is_empty()
				|| (self.amend && self.snapshot.head.is_some()))
	}

	fn commit_button_label(&self) -> &'static str {
		if self.snapshot.staged.is_empty() {
			"Stage all & commit"
		} else {
			"Commit staged changes"
		}
	}

	fn sync_commit_button(&mut self) {
		let (summary, description) = self.form_values();
		let disabled = !self.commit_enabled_with(summary.as_str(), description.as_str());
		let _ = self.ui.set_prop(COMMIT_ID, Prop::Dim, disabled);
	}

	fn sync_control_values(&mut self) {
		let values = self.ui.values();
		let view_style = values
			.get(VIEW_STYLE_ID)
			.and_then(serde_json::Value::as_str)
			.map(str::to_owned);
		let diff_view = values
			.get(VIEW_ID)
			.and_then(serde_json::Value::as_str)
			.map(str::to_owned);
		let amend = values.get(AMEND_ID).and_then(serde_json::Value::as_bool);
		if let Some(style) = view_style {
			let tree = style == "tree";
			if tree != self.tree {
				self.tree = tree;
				self.rebuild();
				return;
			}
		}
		if let Some(value) = diff_view
			&& let Ok(mode) = value.parse::<ViewMode>()
			&& mode != self.view_mode
		{
			self.view_mode = mode;
			self.with_pane(|pane| pane.set_mode(mode));
		}
		if let Some(checked) = amend
			&& checked != self.amend
		{
			let _ = self.toggle_amend();
		}
	}

	fn with_pane(&mut self, action: impl FnOnce(&mut DiffPane)) {
		let _ = self.ui.with_component_mut::<DiffPane, _>(DIFF_ID, action);
	}

	fn install_document(&mut self) {
		let contents = self.contents.clone();
		let selected = self.selected.clone();
		let whitespace = self.whitespace;
		let empty = if self.snapshot.pinned && self.snapshot.head.is_none() {
			"No commits yet"
		} else {
			"No changes"
		};
		let pending_last = self.pending_last_hunk;
		let installed = self
			.ui
			.with_component_mut::<DiffPane, _>(DIFF_ID, |pane| {
				pane.set_empty_message(empty);
				match (selected, contents) {
					(None, _) => pane.set_document(None, DiffPaneState::Empty),
					(_, None) => pane.set_document(None, DiffPaneState::Loading),
					(Some(_), Some(contents)) if contents.too_large => {
						pane.set_document(None, DiffPaneState::TooLarge);
					},
					(Some(_), Some(contents)) if contents.binary => {
						pane.set_document(None, DiffPaneState::Binary);
					},
					(Some((_, path)), Some(contents)) => {
						let options = DiffBuildOptions { whitespace, language: None };
						let document = DiffDocument::build(
							contents.old_text.as_str(),
							contents.new_text.as_str(),
							path.as_str(),
							&options,
						);
						pane.set_document(Some(document), DiffPaneState::Ready);
						if pending_last {
							while pane.jump_hunk(1) {}
						}
					},
				}
			})
			.is_some();
		if installed {
			self.pending_last_hunk = false;
			let target = self.patch_target();
			self.with_pane(|pane| pane.set_patch_target(target));
		}
	}

	fn patch_target(&self) -> Option<DiffPatchTarget> {
		let (area, path) = self.selected.as_ref()?;
		let file = find_file(&self.snapshot, *area, path.as_str())?;
		match area {
			GitArea::Unstaged
				if !matches!(file.kind, GitChangeKind::Untracked | GitChangeKind::Conflicted) =>
			{
				Some(DiffPatchTarget::Stage)
			},
			GitArea::Staged => Some(DiffPatchTarget::Unstage),
			GitArea::Unstaged | GitArea::Commit => None,
		}
	}

	fn rebuild(&mut self) {
		let (summary, description) = self.form_values();
		self.rebuild_with_form(summary.as_str(), description.as_str());
	}

	fn rebuild_with_form(&mut self, summary: &str, description: &str) {
		let previous_rows = self.sidebar_rows.clone();
		let previous_target = self.current_sidebar_target().cloned();
		self.sidebar_rows = sidebar_rows(&self.snapshot, self.tree, &self.ctx);
		if let Some(target) = previous_target {
			let key = target.key();
			if let Some(index) = self
				.sidebar_rows
				.iter()
				.position(|row| row.target.key() == key)
			{
				self.sidebar_selected = index;
			} else if let Some(survivor) = nearest_survivor(&previous_rows, &self.sidebar_rows, &key) {
				self.set_sidebar_index_for_key(survivor.as_str());
			}
		}
		let reconciled = self
			.sidebar_selected
			.min(self.sidebar_rows.len().saturating_sub(1));
		if reconciled != self.sidebar_selected {
			self.sidebar_follow_selection = true;
			self.sidebar_selected = reconciled;
		}
		self.rebuild_retained(summary, description);
	}

	fn rebuild_retained(&mut self, summary: &str, description: &str) {
		let follow_selection = self.sidebar_follow_selection;
		let (tree_selected, tree_scroll_top) = self
			.ui
			.with_component_mut::<Tree, _>(SIDEBAR_ID, |tree| {
				(tree.selected_key().map(Str::new), tree.scroll_top())
			})
			.unwrap_or_default();
		let fallback = self
			.current_sidebar_target()
			.filter(|target| target.is_tree_node())
			.map(SidebarTarget::key);
		let tree_selected = fallback.or_else(|| {
			tree_selected.filter(|key| self.sidebar_rows.iter().any(|row| row.target.key() == *key))
		});
		let content_rows = self.height.saturating_sub(2).max(1);
		let sidebar_width = (self.width * 3 / 10).clamp(SIDEBAR_MIN, SIDEBAR_MAX);
		let retained = self
			.ui
			.with_component_mut::<DiffPane, _>(DIFF_ID, std::mem::take);
		let fresh = retained.is_none();
		let mut pane = retained
			.unwrap_or_default()
			.with(Prop::Id, DIFF_ID)
			.with(Prop::H, content_rows)
			.with(Prop::Minimap, true);
		pane.set_mode(self.view_mode);
		if fresh && self.wrap {
			pane.toggle_wrap();
		}
		pane.set_patch_target(self.patch_target());
		let sidebar = self.sidebar_component(
			sidebar_width,
			summary,
			description,
			tree_selected.as_deref(),
			tree_scroll_top,
		);
		let root = self.root_component(pane, sidebar, sidebar_width, content_rows);
		self.ui = Ui::from_root(root, self.width.max(1), self.ctx.clone());
		self.focus_current();
		if !follow_selection {
			let _ = self
				.ui
				.with_component_mut::<Tree, _>(SIDEBAR_ID, |tree| tree.set_scroll_top(tree_scroll_top));
		}
		self.sidebar_follow_selection = false;
		if fresh {
			self.install_document();
		}
	}

	fn current_counts(&self) -> (u64, u64) {
		self
			.selected
			.as_ref()
			.and_then(|(area, path)| find_file(&self.snapshot, *area, path.as_str()))
			.map_or((0, 0), |file| (file.additions.unwrap_or(0), file.deletions.unwrap_or(0)))
	}

	fn scope_label(&self) -> Str {
		match self.selected.as_ref() {
			Some((GitArea::Unstaged, path)) => {
				if find_file(&self.snapshot, GitArea::Unstaged, path.as_str())
					.is_some_and(|file| file.kind == GitChangeKind::Untracked)
				{
					Str::new_static("Untracked")
				} else {
					Str::new_static("Unstaged")
				}
			},
			Some((GitArea::Staged, _)) => Str::new_static("Staged"),
			Some((GitArea::Commit, _)) => self
				.snapshot
				.head
				.as_ref()
				.map_or_else(|| Str::new_static("Commit"), |head| short_sha(&head.sha)),
			None => self
				.snapshot
				.branch
				.clone()
				.unwrap_or_else(|| Str::new_static("HEAD")),
		}
	}

	fn root_component(
		&self,
		pane: DiffPane,
		sidebar: Col,
		sidebar_width: u16,
		content_rows: u16,
	) -> Col {
		let diff_width = self.width.saturating_sub(sidebar_width.saturating_add(1));
		let path = self.selected.as_ref().map_or("", |(_, path)| path.as_str());
		let (directory, basename) = split_path(path);
		let (additions, deletions) = self.current_counts();
		let middle = self.status_text();
		let middle_color = self
			.status
			.as_ref()
			.map_or(self.ctx.theme.muted, |status| status.color);
		let encoding = self
			.contents
			.as_ref()
			.map_or("UTF-8", |contents| if contents.binary { "Binary" } else { "UTF-8" });
		let selected_area = self.selected.as_ref().map(|(area, _)| *area);
		let scope = self.scope_label();
		let scope_color = match selected_area {
			Some(GitArea::Staged) => "ok",
			Some(GitArea::Unstaged) => "warn",
			Some(GitArea::Commit) | None => "accent",
		};
		let mode_value: &'static str = self.view_mode.into();
		let up_icon = self.ctx.charset.icon(Icon::Up);
		let down_icon = self.ctx.charset.icon(Icon::Down);
		let close_icon = self.ctx.charset.icon(Icon::Close);
		let whitespace_icon = self.ctx.charset.icon(Icon::Whitespace);
		let whitespace_label = if self.whitespace == DiffWhitespaceMode::Formatting {
			sf!("{whitespace_icon}+")
		} else {
			Str::new(whitespace_icon)
		};
		let wrap_icon = self.ctx.charset.icon(Icon::WordWrap);
		let whitespace_active = self.whitespace != DiffWhitespaceMode::Off;
		let wraps = self.wrap;
		let separator_color = if self.focus == Focus::Sidebar {
			self.ctx.theme.accent
		} else {
			self.ctx.theme.border
		};
		let rule = self.ctx.charset.icon(Icon::SharpVertical);
		let mut separator = String::with_capacity(usize::from(content_rows) * (rule.len() + 1));
		for row in 0..content_rows {
			if row > 0 {
				separator.push('\n');
			}
			separator.push_str(rule);
		}
		let separator = Str::new(separator);
		let no_file = self.selected.is_none();
		dom! {
			<col>
				<row h=1 bg=surface gap=1>
					<row grow truncate>
						if no_file {
							<text dim>{"no file selected"}</text>
						} else {
							if !directory.is_empty() { <text dim>{directory}</text> }
							<text bold>{basename}</text>
						}
					</row>
					<text fg=ok>{sf!("+{additions}")}</text>
					<text fg=err>{sf!("−{deletions}")}</text>
					<spacer grow/>
					<text id={STATUS_ID} fg={middle_color} truncate>{middle}</text>
					<spacer grow/>
					<text dim>{encoding}</text>
					if selected_area == Some(GitArea::Unstaged) {
						<button id="git-stage-file" variant=pill color=ok active>{"Stage File"}</button>
					} else if selected_area == Some(GitArea::Staged) {
						<button id="git-unstage-file" variant=pill color=warn active>{"Unstage File"}</button>
					}
					<button id="git-close" variant=soft>{close_icon}</button>
				</row>
				<row h=1 bg=surface gap=1>
					<row w={diff_width} gap=1>
						<button variant=tint color={scope_color} active>{scope}</button>
						<spacer grow/>
						<button id="git-up" variant=ghost>{up_icon}</button>
						<button id="git-down" variant=ghost>{down_icon}</button>
						<segmented id={VIEW_ID} value={mode_value}>
							<option value="file" icon="file-diff"/>
							<option value="split" icon="split"/>
							<option value="inline" icon="inline"/>
							<option value="hunk" icon="hunk"/>
						</segmented>
						<spacer grow/>
						<button id="git-ws" variant=soft active={whitespace_active}>{whitespace_label}</button>
						<button id="git-wrap" variant=soft active={wraps}>{wrap_icon}</button>
					</row>
					<spacer grow/>
				</row>
				<row h={content_rows}>
					{pane}
					<pre id={SEPARATOR_ID} fg={separator_color}>{separator}</pre>
					{sidebar}
				</row>
			</col>
		}
	}

	fn sidebar_component(
		&self,
		width: u16,
		summary: &str,
		description: &str,
		selected_key: Option<&str>,
		scroll_top: usize,
	) -> Col {
		let mut tree = sidebar_tree(&self.sidebar_rows, &self.collapsed);
		let content_rows = self.height.saturating_sub(2).max(1);
		let mut body_lines = 0;
		let tree_rows = if self.snapshot.is_commit_view() {
			self.snapshot.head.as_ref().map_or(1, |head| {
				let text_rows = |text: &str| cell_width(text).div_ceil(width.max(1)).max(1);
				let fixed = text_rows(head.subject.as_str())
					.saturating_add(6)
					.saturating_add(u16::from(!head.parents.is_empty()));
				// The body yields to the file list: show at most eight
				// body lines, and never fewer than `MIN_TREE_ROWS` files.
				let budget = content_rows.saturating_sub(fixed.saturating_add(MIN_TREE_ROWS + 1));
				let mut body_rows = 0_u16;
				for line in head.body.lines().take(8) {
					let rows = text_rows(line);
					if body_rows.saturating_add(rows) > budget {
						break;
					}
					body_rows = body_rows.saturating_add(rows);
					body_lines += 1;
				}
				let metadata_rows =
					fixed.saturating_add(u16::from(body_rows > 0).saturating_add(body_rows));
				content_rows.saturating_sub(metadata_rows).max(1)
			})
		} else {
			let description_rows = u16::try_from(description.lines().count().clamp(1, 5)).unwrap_or(5);
			content_rows
				.saturating_sub(7_u16.saturating_add(description_rows))
				.max(1)
		};
		tree = tree.with(Prop::H, tree_rows);
		if let Some(key) = selected_key {
			let _ = tree.select_key(key);
		}
		tree.set_scroll_top(scroll_top);
		if self.snapshot.is_commit_view() {
			return commit_view(self.snapshot.head.as_ref(), body_lines, tree, self.tree, width);
		}
		let file_count = self.snapshot.unstaged.len() + self.snapshot.staged.len();
		let change_word = if file_count == 1 { "change" } else { "changes" };
		let branch = self
			.snapshot
			.branch
			.clone()
			.unwrap_or_else(|| Str::new_static("HEAD"));
		let view = if self.tree { "tree" } else { "path" };
		let amend = self.amend;
		let disabled = !self.commit_enabled_with(summary, description);
		let commit_label = self.commit_button_label();
		let commit_text = sf!("{} {commit_label}", self.ctx.charset.icon(Icon::CommitNode));
		let description_editor = EditorPane::new().with(Prop::Id, DESCRIPTION_PANE_ID).input(
			EditInput::new()
				.with(Prop::Id, DESCRIPTION_ID)
				.with(Prop::Value, description)
				.with(Prop::Rail, true)
				.with(Prop::Placeholder, "Description")
				.with(Prop::MaxRows, 5_u16),
		);
		dom! {
			<col w={width}>
				<row h=1 gap=1>
					<text bold truncate grow>{sf!("{file_count} file {change_word} on")}</text>
					<button variant=tint color=accent active>{branch}</button>
				</row>
				<row h=1 justify=center>
					<segmented id={VIEW_STYLE_ID} value={view}>
						<option value="path" icon="view-path" label="Path"/>
						<option value="tree" icon="view-tree" label="Tree"/>
					</segmented>
				</row>
				<hr fg=border/>
				{tree}
				<hr fg=border/>
				<checkbox id={AMEND_ID} checked={amend} label="Amend previous commit"/>
				<input id={SUMMARY_ID} value={summary} limit=72 rail placeholder="Commit summary"/>
				{description_editor}
				<row justify=center>
					<button id={COMMIT_ID} variant=pill color=accent dim={disabled}>{commit_text}</button>
				</row>
			</col>
		}
	}
}

impl Panel for GitWorkbench {
	fn id(&self) -> &'static str {
		"git"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Full
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		self.handle_key(key)
	}

	fn paste(&mut self, text: &str) -> PanelEvent {
		if self.editing() {
			let _ = self.ui.handle_paste(text);
			self.sync_commit_button();
		}
		PanelEvent::Consumed
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		let event = self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods);
		self.sync_control_values();
		self.route_ui(event)
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		match note {
			PanelNote::Outcome(Outcome::Git(outcome)) => self.settle(outcome),
			PanelNote::Outcome(_)
			| PanelNote::Dom(_)
			| PanelNote::Live(..)
			| PanelNote::SettingResult { .. } => PanelEvent::Ignored,
		}
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		let width = viewport.width.max(40);
		let height = viewport.height.max(10);
		if width != self.width || height != self.height {
			self.width = width;
			self.height = height;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		self.now = now;
		let mut changed = false;
		if self
			.status
			.as_ref()
			.is_some_and(|status| !status.sticky && now.saturating_sub(status.at) >= STATUS_TTL)
		{
			self.status = None;
			let _ = self.ui.set_text(STATUS_ID, self.focus.hint());
			let _ = self.ui.set_prop(STATUS_ID, Prop::Fg, self.ctx.theme.muted);
			changed = true;
		}
		if now >= self.next_refresh {
			self.next_refresh = now + REFRESH_MS;
			let fingerprint = self
				.model
				.fingerprint(self.selected.as_ref().map(|(_, path)| path.as_str()));
			if fingerprint != self.fingerprint {
				self.fingerprint = fingerprint;
				self.refresh();
				changed = true;
			}
		}
		changed
	}

	fn next_wake(&self) -> Option<Duration> {
		let status = self
			.status
			.as_ref()
			.filter(|status| !status.sticky)
			.map(|status| status.at + STATUS_TTL);
		Some(status.map_or(self.next_refresh, |status| status.min(self.next_refresh)))
	}
}

/// Clean-tree or pinned-commit sidebar: metadata above the file tree.
fn commit_view(
	head: Option<&GitCommitInfo>,
	body_lines: usize,
	file_tree: Tree,
	tree: bool,
	width: u16,
) -> Col {
	let Some(head) = head else {
		return dom! { <col w={width} justify=center align=center><text dim>{"No commits yet"}</text></col> };
	};
	let body = head
		.body
		.lines()
		.take(body_lines)
		.map(Str::new)
		.collect::<Vec<_>>();
	let author = head.author_name.clone();
	let email = head.author_email.clone();
	let authored = authored_age(head.author_date.as_str());
	let parents = head
		.parents
		.iter()
		.map(short_sha)
		.fold(String::new(), |mut output, parent| {
			if !output.is_empty() {
				output.push(' ');
			}
			output.push_str(parent.as_str());
			output
		});
	let additions = head
		.files
		.iter()
		.map(|file| file.additions.unwrap_or(0))
		.sum::<u64>();
	let deletions = head
		.files
		.iter()
		.map(|file| file.deletions.unwrap_or(0))
		.sum::<u64>();
	let file_count = head.files.len();
	let sha = short_sha(&head.sha);
	let view = if tree { "tree" } else { "path" };
	let date = head.author_date.clone();
	dom! {
		<col w={width}>
			<text bold wrap>{head.subject.clone()}</text>
			if !body.is_empty() {
				<spacer h=1/>
				for line in body { <text fg=muted wrap>{line}</text> }
			}
			<spacer h=1/>
			<row w={width} gap=1><text bold truncate>{author}</text><text dim truncate>{sf!("<{email}>")}</text></row>
			if let Some(age) = authored {
				<row w={width} gap=1><text dim>{"authored"}</text><time kind="relative" ms={age} dim/></row>
			} else {
				<text dim truncate>{sf!("authored {date}")}</text>
			}
			if !parents.is_empty() {
				<row w={width} gap=1><text dim>{"parent:"}</text><text fg=accent truncate>{parents}</text></row>
			}
			<hr fg=border/>
			<row w={width} gap=1>
				<text bold truncate grow>{sf!("{file_count} modified")}</text>
				<text fg=ok>{sf!("+{additions}")}</text>
				<text fg=err>{sf!("−{deletions}")}</text>
				<text dim>{sf!("· {sha}")}</text>
			</row>
			<row h=1 justify=center>
				<segmented id={VIEW_STYLE_ID} value={view}>
					<option value="path" icon="view-path" label="Path"/>
					<option value="tree" icon="view-tree" label="Tree"/>
				</segmented>
			</row>
			{file_tree}
		</col>
	}
}

/// Time elapsed since the authored timestamp, clamped to zero for future
/// (clock-skewed) dates; `None` when the date does not parse.
fn authored_age(value: &str) -> Option<Duration> {
	let then = value.parse::<jiff::Timestamp>().ok()?;
	Some(Duration::try_from(jiff::Timestamp::now().duration_since(then)).unwrap_or_default())
}

fn sidebar_rows(snapshot: &GitSnapshot, tree: bool, ctx: &UiContext) -> Vec<SidebarRow> {
	let mut rows = Vec::new();
	if snapshot.is_commit_view() {
		if let Some(head) = &snapshot.head {
			let files = head
				.files
				.iter()
				.cloned()
				.map(|file| (GitArea::Commit, file))
				.collect::<Vec<_>>();
			append_files(&mut rows, &files, tree, ctx, SidebarGroup::Changes);
		}
		rows.push(action_row(SidebarTarget::ViewStyle, Str::default()));
		return rows;
	}
	rows.push(action_row(
		SidebarTarget::Section { area: GitArea::Unstaged },
		sf!("Unstaged Files ({})", snapshot.unstaged.len()),
	));
	let unstaged = snapshot
		.unstaged
		.iter()
		.cloned()
		.map(|file| (GitArea::Unstaged, file))
		.collect::<Vec<_>>();
	let (additions, changes): (Vec<_>, Vec<_>) = unstaged
		.into_iter()
		.partition(|(_, file)| is_addition(file));
	append_files(&mut rows, &changes, tree, ctx, SidebarGroup::Changes);
	append_files(&mut rows, &additions, tree, ctx, SidebarGroup::Additions);
	rows.push(action_row(
		SidebarTarget::Section { area: GitArea::Staged },
		sf!("Staged Files ({})", snapshot.staged.len()),
	));
	let staged = snapshot
		.staged
		.iter()
		.cloned()
		.map(|file| (GitArea::Staged, file))
		.collect::<Vec<_>>();
	append_files(&mut rows, &staged, tree, ctx, SidebarGroup::Changes);
	rows.push(action_row(SidebarTarget::ViewStyle, Str::default()));
	rows.push(action_row(SidebarTarget::Amend, Str::default()));
	rows.push(action_row(SidebarTarget::Summary, Str::default()));
	rows.push(action_row(SidebarTarget::Description, Str::default()));
	rows.push(action_row(SidebarTarget::Commit, Str::default()));
	rows
}

fn action_row(target: SidebarTarget, basename: Str) -> SidebarRow {
	SidebarRow {
		target,
		status: None,
		status_color: Color::Default,
		directory: Str::default(),
		basename,
		additions: None,
		deletions: None,
		strike: false,
	}
}

const fn is_addition(file: &GitFileRow) -> bool {
	matches!(file.kind, GitChangeKind::Added | GitChangeKind::Untracked)
}

fn append_files(
	rows: &mut Vec<SidebarRow>,
	files: &[(GitArea, GitFileRow)],
	tree: bool,
	ctx: &UiContext,
	group: SidebarGroup,
) {
	if !tree {
		for (area, file) in files {
			rows.push(file_sidebar_row(*area, file, 0, false, ctx));
		}
		return;
	}
	let mut root = FileTreeNode::default();
	for (area, file) in files {
		let mut node = &mut root;
		let mut parts = file.path.as_str().split('/').peekable();
		while let Some(part) = parts.next() {
			if parts.peek().is_none() {
				node.files.push((*area, file.clone()));
			} else {
				node = node.children.entry(part.to_str()).or_default();
			}
		}
	}
	append_tree(rows, &root, "", 0, ctx, group);
}

fn append_tree(
	rows: &mut Vec<SidebarRow>,
	node: &FileTreeNode,
	prefix: &str,
	depth: usize,
	ctx: &UiContext,
	group: SidebarGroup,
) {
	for (name, child) in &node.children {
		let mut path = if prefix.is_empty() {
			name.clone()
		} else {
			sf!("{prefix}/{name}")
		};
		let mut compressed = name.clone();
		let mut current = child;
		while current.files.is_empty() && current.children.len() == 1 {
			let (next, next_node) = current.children.first_key_value().expect("one child");
			compressed = sf!("{compressed}/{next}");
			path = sf!("{path}/{next}");
			current = next_node;
		}
		let area = current
			.files
			.first()
			.map_or_else(|| subtree_area(current).unwrap_or(GitArea::Unstaged), |(area, _)| *area);
		rows.push(SidebarRow {
			target:       SidebarTarget::Directory { area, path: path.clone(), depth, group },
			status:       None,
			status_color: ctx.theme.muted,
			directory:    Str::default(),
			basename:     sf!("{compressed}/"),
			additions:    None,
			deletions:    None,
			strike:       false,
		});
		append_tree(rows, current, path.as_str(), depth + 1, ctx, group);
	}
	for (area, file) in &node.files {
		rows.push(file_sidebar_row(*area, file, depth, true, ctx));
	}
}

fn subtree_area(node: &FileTreeNode) -> Option<GitArea> {
	node
		.files
		.first()
		.map(|(area, _)| *area)
		.or_else(|| node.children.values().find_map(subtree_area))
}

fn file_sidebar_row(
	area: GitArea,
	file: &GitFileRow,
	depth: usize,
	tree: bool,
	ctx: &UiContext,
) -> SidebarRow {
	let status: &'static str = file.kind.into();
	let status_color = match file.kind {
		GitChangeKind::Modified => ctx.theme.warn,
		GitChangeKind::Added => ctx.theme.ok,
		GitChangeKind::Deleted | GitChangeKind::Conflicted => ctx.theme.err,
		GitChangeKind::Renamed => ctx.theme.accent,
		GitChangeKind::Untracked => ctx.theme.muted,
	};
	let (directory, basename) = split_path(file.path.as_str());
	SidebarRow {
		target: SidebarTarget::File { area, path: file.path.clone(), depth },
		status: (area != GitArea::Unstaged || !is_addition(file)).then(|| status.to_str()),
		status_color,
		directory: if tree {
			Str::default()
		} else {
			directory.to_str()
		},
		basename: basename.to_str(),
		additions: file.additions.filter(|count| *count != 0),
		deletions: file.deletions.filter(|count| *count != 0),
		strike: file.kind == GitChangeKind::Deleted,
	}
}

fn sidebar_tree(rows: &[SidebarRow], collapsed: &BTreeSet<Str>) -> Tree {
	let mut tree = Tree::new()
		.with(Prop::Id, SIDEBAR_ID)
		.with(Prop::Grow, true);
	let mut index = 0;
	while index < rows.len() {
		match rows[index].target {
			SidebarTarget::Section { area: GitArea::Unstaged | GitArea::Staged } => {
				let section = &rows[index];
				index += 1;
				let children = tree_level(rows, &mut index, 0, collapsed);
				let mut node = row_node(section, collapsed).with(
					Prop::Action,
					if matches!(section.target, SidebarTarget::Section { area: GitArea::Unstaged }) {
						"Stage All"
					} else {
						"Unstage All"
					},
				);
				for child in children {
					node = node.node(child);
				}
				tree = tree.node(node);
			},
			SidebarTarget::Directory { depth: 0, .. } | SidebarTarget::File { depth: 0, .. } => {
				for node in tree_level(rows, &mut index, 0, collapsed) {
					tree = tree.node(node);
				}
			},
			_ => index += 1,
		}
	}
	tree
}

fn tree_level(
	rows: &[SidebarRow],
	index: &mut usize,
	depth: usize,
	collapsed: &BTreeSet<Str>,
) -> Vec<TreeNode> {
	let mut nodes = Vec::new();
	while let Some(row) = rows.get(*index) {
		let Some(row_depth) = row.target.depth() else {
			break;
		};
		if row_depth != depth {
			break;
		}
		*index += 1;
		let mut node = row_node(row, collapsed);
		if matches!(row.target, SidebarTarget::Directory { .. }) {
			for child in tree_level(rows, index, depth + 1, collapsed) {
				node = node.node(child);
			}
		}
		nodes.push(node);
	}
	nodes
}

fn row_node(row: &SidebarRow, collapsed: &BTreeSet<Str>) -> TreeNode {
	let key = row.target.key();
	let mut node = TreeNode::new().key(key.clone()).label(row.basename.clone());
	match row.target {
		SidebarTarget::Section { .. } => {
			node = node
				.with(Prop::Open, !collapsed.contains(&key))
				.with(Prop::Bold, true)
				.with(Prop::ActionColor, "accent");
		},
		SidebarTarget::Directory { .. } => {
			node = node
				.with(Prop::Open, !collapsed.contains(&key))
				.with(Prop::Dim, true);
		},
		SidebarTarget::File { .. } => {
			if row.strike {
				node = node.with(Prop::Strike, true);
			}
			if let Some(status) = &row.status {
				node = node
					.badge(status.clone())
					.with(Prop::Color, row.status_color);
			}
			if !row.directory.is_empty() {
				node = node.prefix(row.directory.clone());
			}
			if let Some(additions) = row.additions {
				node = node.annotate(TreeAnnotation::new(sf!("+{additions}")).color("ok"));
			}
			if let Some(deletions) = row.deletions {
				node = node.annotate(TreeAnnotation::new(sf!("−{deletions}")).color("err"));
			}
		},
		_ => {},
	}
	node
}

fn nearest_survivor(previous: &[SidebarRow], current: &[SidebarRow], missing: &Str) -> Option<Str> {
	let index = previous
		.iter()
		.position(|row| row.target.key() == *missing)?;
	let current_key = |target: &SidebarTarget| {
		if !target.is_file_or_directory() {
			return None;
		}
		let key = target.key();
		current
			.iter()
			.any(|row| row.target.key() == key)
			.then_some(key)
	};
	for row in &previous[index + 1..] {
		if let Some(key) = current_key(&row.target) {
			return Some(key);
		}
	}
	for row in previous[..index].iter().rev() {
		if let Some(key) = current_key(&row.target) {
			return Some(key);
		}
	}
	current
		.iter()
		.find(|row| matches!(row.target, SidebarTarget::File { .. }))
		.map(|row| row.target.key())
}

fn first_file(snapshot: &GitSnapshot) -> Option<&GitFileRow> {
	if snapshot.is_commit_view() {
		snapshot.head.as_ref()?.files.first()
	} else {
		snapshot
			.unstaged
			.first()
			.or_else(|| snapshot.staged.first())
	}
}

fn find_file<'a>(snapshot: &'a GitSnapshot, area: GitArea, path: &str) -> Option<&'a GitFileRow> {
	let files: &[GitFileRow] = match area {
		GitArea::Unstaged => &snapshot.unstaged,
		GitArea::Staged => &snapshot.staged,
		GitArea::Commit => snapshot
			.head
			.as_ref()
			.map_or(&[], |head| head.files.as_slice()),
	};
	files.iter().find(|file| file.path.as_str() == path)
}

const fn inclusive_range((start, count): (u32, u32)) -> (u32, u32) {
	if count == 0 {
		(0, 0)
	} else {
		(start, start.saturating_add(count).saturating_sub(1))
	}
}

fn split_path(path: &str) -> (&str, &str) {
	path
		.rsplit_once('/')
		.map_or(("", path), |(directory, basename)| (&path[..directory.len() + 1], basename))
}

fn single_line(text: &str) -> Str {
	let mut line = String::with_capacity(text.len());
	for word in text.split_whitespace() {
		if !line.is_empty() {
			line.push(' ');
		}
		line.push_str(word);
	}
	line.into_str()
}

fn short_sha(sha: &Str) -> Str {
	sha.slice(..sha.len().min(8))
}

/// Project root from the session prompt facts (`cwd`), else the process
/// working directory.
pub(crate) fn project_root(dom: &Dom) -> PathBuf {
	let fact = dom
		.get(dom.meta())
		.and_then(|meta| meta.prop(&omp_dom::PropKey::Custom(Str::new_static("prompt-facts"))))
		.and_then(|value| match value {
			omp_dom::Value::Json(raw) => serde_json::from_str::<serde_json::Value>(raw.get()).ok(),
			_ => None,
		})
		.and_then(|facts| facts.get("cwd")?.as_str().map(PathBuf::from));
	fact.unwrap_or_else(|| std::env::current_dir().unwrap_or_default())
}

#[cfg(test)]
mod tests {
	use std::process::Command;

	use omp_tui::{Mods, Mouse, MouseButton, frame_text};
	use omp_vcs::{ApplyOptions, CommitOptions, StatusOptions, UntrackedMode};

	use super::*;

	fn point(text: &str, needle: &str) -> (u16, u16) {
		text
			.lines()
			.enumerate()
			.find_map(|(row, line)| {
				let byte = line.find(needle)?;
				Some((cell_width(&line[..byte]), u16::try_from(row).ok()?))
			})
			.expect("text point")
	}

	fn click(col: u16, row: u16) -> MouseReport {
		MouseReport {
			kind: Mouse::Click,
			col,
			row,
			button: MouseButton::Left,
			mods: Mods::default(),
			pressed: true,
		}
	}

	fn git(root: &Path, args: &[&str]) {
		let output = Command::new("git")
			.args(args)
			.current_dir(root)
			.env("GIT_AUTHOR_NAME", "Ada")
			.env("GIT_AUTHOR_EMAIL", "ada@example.com")
			.env("GIT_COMMITTER_NAME", "Ada")
			.env("GIT_COMMITTER_EMAIL", "ada@example.com")
			.output()
			.expect("git runs");
		assert!(output.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&output.stderr));
	}

	/// One commit, then `src/lib.rs` modified and `notes.txt` untracked.
	fn fixture() -> tempfile::TempDir {
		let dir = tempfile::tempdir().expect("tempdir");
		let root = dir.path();
		git(root, &["init", "-q", "-b", "main"]);
		git(root, &["config", "user.name", "Ada"]);
		git(root, &["config", "user.email", "ada@example.com"]);
		fs::create_dir_all(root.join("src")).expect("src dir");
		fs::write(root.join("src/lib.rs"), "fn a() {}\nfn b() {}\nfn c() {}\n").expect("lib");
		git(root, &["add", "."]);
		git(root, &["commit", "-q", "-m", "initial"]);
		fs::write(root.join("src/lib.rs"), "fn a() {}\nfn b2() {}\nfn c() {}\nfn d() {}\n")
			.expect("modify");
		fs::write(root.join("notes.txt"), "todo\n").expect("untracked");
		dir
	}

	fn open(root: &Path) -> GitWorkbench {
		let ctx = UiContext::default();
		GitWorkbench::open_at(root, None, &ctx, Size { width: 120, height: 30 }).expect("opens")
	}

	fn status(root: &Path) -> String {
		GitRepo::require(root)
			.expect("repo")
			.status_porcelain(&StatusOptions {
				untracked: UntrackedMode::All,
				..StatusOptions::default()
			})
			.expect("status")
	}

	fn controller_outcome(root: &Path, op: GitOp) -> GitOutcome {
		let repo = GitRepo::require(root).expect("repo");
		let result = match &op {
			GitOp::Stage(paths) => {
				let paths = paths
					.as_ref()
					.map(|paths| paths.iter().map(ToString::to_string).collect::<Vec<_>>())
					.unwrap_or_default();
				repo
					.stage_files(&paths)
					.map(|()| match paths.as_slice() {
						[] => Str::new_static("Staged all changes"),
						[path] => sf!("Staged {path}"),
						paths => sf!("Staged {} files", paths.len()),
					})
					.map_err(super::super::services::ServiceError::failed)
			},
			GitOp::Unstage(paths) => {
				let paths = paths
					.as_ref()
					.map(|paths| paths.iter().map(ToString::to_string).collect::<Vec<_>>())
					.unwrap_or_default();
				repo
					.unstage(&paths)
					.map(|()| match paths.as_slice() {
						[] => Str::new_static("Unstaged all changes"),
						[path] => sf!("Unstaged {path}"),
						paths => sf!("Unstaged {} files", paths.len()),
					})
					.map_err(super::super::services::ServiceError::failed)
			},
			GitOp::Apply { patch, action, scope } => {
				let options = ApplyOptions {
					cached:     *action != GitPatchAction::Discard,
					index_path: None,
					reverse:    *action != GitPatchAction::Stage,
					three_way:  false,
				};
				repo
					.apply_patch(patch.as_str(), &options)
					.map(|()| {
						let verb = match action {
							GitPatchAction::Stage => "Staged",
							GitPatchAction::Unstage => "Unstaged",
							GitPatchAction::Discard => "Discarded",
						};
						let scope = match scope {
							GitPatchScope::Selection => "selection",
							GitPatchScope::Hunk => "hunk",
						};
						sf!("{verb} {scope}")
					})
					.map_err(super::super::services::ServiceError::failed)
			},
			GitOp::Discard(_) => unreachable!("the panel represents discards as selected patches"),
			GitOp::Commit { message, amend, stage_all } => {
				let staged = if *stage_all {
					repo.stage_files(&[])
				} else {
					Ok(())
				};
				staged
					.and_then(|()| {
						repo.commit_create(message.as_str(), &CommitOptions {
							amend: *amend,
							..CommitOptions::default()
						})
					})
					.map(|sha| {
						let short = &sha[..sha.len().min(7)];
						if *amend {
							sf!("Amended {short}")
						} else {
							sf!("Committed {short}")
						}
					})
					.map_err(super::super::services::ServiceError::failed)
			},
		};
		GitOutcome { op, result }
	}

	fn settle_command(panel: &mut GitWorkbench, root: &Path, event: PanelEvent) -> GitOp {
		let op = match event {
			PanelEvent::Command(HostCommand::Git(op)) => op,
			other => panic!("expected typed Git command, got {other:?}"),
		};
		let outcome = controller_outcome(root, op.clone());
		assert!(matches!(
			panel.notify(PanelNote::Outcome(&Outcome::Git(outcome))),
			PanelEvent::Notice(_)
		));
		op
	}

	#[test]
	fn close_button_mouse_hit_routes_through_the_workbench_reducer() {
		let dir = fixture();
		let mut panel = open(dir.path());
		let close = panel.ctx.charset.icon(Icon::Close);
		let painted = frame_text(panel.frame(Size { width: 120, height: 30 }));
		let (col, row) = point(&painted, close);
		assert_eq!(panel.mouse(click(col, row)), PanelEvent::Close);
	}

	#[test]
	fn workbench_lists_sections_stages_commits_and_closes() {
		let dir = fixture();
		let root = dir.path();
		let mut panel = open(root);
		assert_eq!(panel.id(), "git");
		assert_eq!(panel.anchor(), PanelAnchor::Full);
		let text = frame_text(panel.frame(Size { width: 120, height: 30 }));
		assert!(text.contains("Unstaged Files (2)"), "unstaged section missing:\n{text}");
		assert!(text.contains("Staged Files (0)"), "staged section missing:\n{text}");
		assert!(text.contains("lib.rs"), "modified file missing:\n{text}");
		assert!(text.contains("notes.txt"), "untracked file missing:\n{text}");
		assert!(text.contains("fn b2()"), "diff pane missing new side:\n{text}");
		assert!(text.contains("Stage all & commit"), "commit button missing:\n{text}");
		assert!(text.contains("space stage · enter open"), "sidebar hint missing:\n{text}");
		assert_eq!(panel.status_text(), SIDEBAR_HINT);

		assert_eq!(panel.key(Key::Tab), PanelEvent::Consumed);
		let text = frame_text(panel.frame(Size { width: 120, height: 30 }));
		assert!(text.contains("shift+↑/↓ select"), "diff hint missing after Tab:\n{text}");
		assert_eq!(panel.status_text(), DIFF_HINT);
		assert_eq!(panel.key(Key::BackTab), PanelEvent::Consumed);

		// The cursor starts on the section header; ↓ walks section → src/ → lib.rs.
		assert!(matches!(panel.current_sidebar_target(), Some(SidebarTarget::Section { .. })));
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert!(matches!(panel.current_sidebar_target(), Some(SidebarTarget::Directory { .. })));
		assert_eq!(panel.key(Key::Char('j')), PanelEvent::Consumed);
		assert!(matches!(
			panel.current_sidebar_target(),
			Some(SidebarTarget::File { area: GitArea::Unstaged, .. })
		));
		let event = panel.key(Key::Space);
		assert_eq!(
			event,
			PanelEvent::Command(HostCommand::Git(GitOp::Stage(Some(vec![Str::new_static(
				"src/lib.rs"
			),]))))
		);
		assert!(status(root).contains(" M src/lib.rs"), "actor mutated the index: {}", status(root));
		settle_command(&mut panel, root, event);
		assert_eq!(panel.status_text(), "Staged src/lib.rs");
		assert!(status(root).contains("M  src/lib.rs"), "not staged: {}", status(root));
		assert_eq!(panel.snapshot().staged.len(), 1);

		assert_eq!(panel.key(Key::Char('c')), PanelEvent::Consumed);
		assert!(matches!(panel.current_sidebar_target(), Some(SidebarTarget::Summary)));
		for ch in "tweak b".chars() {
			assert_eq!(panel.key(Key::Char(ch)), PanelEvent::Consumed);
		}
		assert_eq!(panel.key(Key::Enter), PanelEvent::Consumed);
		assert!(matches!(panel.current_sidebar_target(), Some(SidebarTarget::Description)));
		assert_eq!(panel.key(Key::Down), PanelEvent::Consumed);
		assert!(matches!(panel.current_sidebar_target(), Some(SidebarTarget::Commit)));
		let event = panel.key(Key::Enter);
		assert_eq!(
			event,
			PanelEvent::Command(HostCommand::Git(GitOp::Commit {
				message:   Str::new_static("tweak b"),
				amend:     false,
				stage_all: false,
			}))
		);
		assert!(
			GitRepo::require(root)
				.expect("repo")
				.log_onelines(1)
				.expect("log before outcome")[0]
				.ends_with("initial")
		);
		settle_command(&mut panel, root, event);
		assert!(panel.status_text().starts_with("Committed "), "status: {}", panel.status_text());
		let log = GitRepo::require(root)
			.expect("repo")
			.log_onelines(1)
			.expect("log");
		assert!(log[0].ends_with("tweak b"), "log: {log:?}");
		assert!(status(root).contains("?? notes.txt"));
		assert!(!status(root).contains("src/lib.rs"));

		assert_eq!(panel.key(Key::Char('q')), PanelEvent::Close);
	}

	#[test]
	fn esc_ladder_blurs_editor_before_closing_and_status_expires() {
		let dir = fixture();
		let mut panel = open(dir.path());
		assert_eq!(panel.key(Key::Char('c')), PanelEvent::Consumed);
		assert!(panel.editing());
		assert_eq!(panel.key(Key::Esc), PanelEvent::Consumed);
		assert!(!panel.editing());
		assert_eq!(panel.key(Key::Esc), PanelEvent::Close);

		panel.tick(Duration::from_secs(10));
		assert_eq!(panel.key(Key::Char('b')), PanelEvent::Consumed);
		assert_eq!(panel.status_text(), "Ignoring whitespace-only line changes");
		assert_eq!(panel.next_wake(), Some(Duration::from_secs(12)));
		assert!(!panel.tick(Duration::from_secs(12)));
		assert!(panel.tick(Duration::from_secs(16)));
		assert_eq!(panel.status_text(), SIDEBAR_HINT);
	}

	#[test]
	fn diff_focus_stages_the_current_hunk_and_view_keys_switch_modes() {
		let dir = fixture();
		let root = dir.path();
		let mut panel = open(root);
		assert_eq!(panel.key(Key::Tab), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Char('4')), PanelEvent::Consumed);
		assert_eq!(panel.view_mode, ViewMode::Hunk);
		let event = panel.key(Key::Char('s'));
		assert!(matches!(
			&event,
			PanelEvent::Command(HostCommand::Git(GitOp::Apply {
				action: GitPatchAction::Stage,
				scope: GitPatchScope::Hunk,
				..
			}))
		));
		assert!(status(root).contains(" M src/lib.rs"), "actor mutated the index: {}", status(root));
		settle_command(&mut panel, root, event);
		assert_eq!(panel.status_text(), "Staged hunk", "status: {}", panel.status_text());
		assert!(status(root).contains("M  src/lib.rs"), "status: {}", status(root));
		assert_eq!(panel.key(Key::Char('v')), PanelEvent::Consumed);
		assert_eq!(panel.view_mode, ViewMode::File);
		assert_eq!(panel.key(Key::Char('w')), PanelEvent::Consumed);
		assert!(panel.wrap);
	}

	#[test]
	fn hunk_unstage_and_double_x_discard_round_trip() {
		let dir = fixture();
		let root = dir.path();
		let mut panel = open(root);
		assert_eq!(panel.key(Key::Tab), PanelEvent::Consumed);
		assert_eq!(panel.key(Key::Char('4')), PanelEvent::Consumed);
		let event = panel.key(Key::Char('s'));
		assert!(matches!(
			&event,
			PanelEvent::Command(HostCommand::Git(GitOp::Apply {
				action: GitPatchAction::Stage,
				scope: GitPatchScope::Hunk,
				..
			}))
		));
		settle_command(&mut panel, root, event);
		assert_eq!(panel.status_text(), "Staged hunk");
		// Move onto the staged copy and pull the hunk back out of the index.
		panel.selected = Some((GitArea::Staged, Str::new_static("src/lib.rs")));
		panel.load_selected();
		panel.rebuild();
		let event = panel.key(Key::Char('u'));
		assert!(matches!(
			&event,
			PanelEvent::Command(HostCommand::Git(GitOp::Apply {
				action: GitPatchAction::Unstage,
				scope: GitPatchScope::Hunk,
				..
			}))
		));
		settle_command(&mut panel, root, event);
		assert_eq!(panel.status_text(), "Unstaged hunk");
		assert!(status(root).contains(" M src/lib.rs"), "status: {}", status(root));
		// Discard needs a second x within the pending window.
		panel.selected = Some((GitArea::Unstaged, Str::new_static("src/lib.rs")));
		panel.load_selected();
		panel.rebuild();
		assert_eq!(panel.key(Key::Char('x')), PanelEvent::Consumed);
		assert_eq!(panel.status_text(), "Discard hunk? Press x (or click) again to confirm");
		assert_eq!(panel.key(Key::Char('j')), PanelEvent::Consumed);
		assert!(panel.pending_discard.is_none(), "any other key cancels the confirmation");
		assert_eq!(panel.key(Key::Char('x')), PanelEvent::Consumed);
		let event = panel.key(Key::Char('x'));
		assert!(matches!(
			&event,
			PanelEvent::Command(HostCommand::Git(GitOp::Apply {
				action: GitPatchAction::Discard,
				scope: GitPatchScope::Hunk,
				..
			}))
		));
		settle_command(&mut panel, root, event);
		assert_eq!(panel.status_text(), "Discarded hunk");
		assert_eq!(
			fs::read_to_string(root.join("src/lib.rs")).expect("lib"),
			"fn a() {}\nfn b() {}\nfn c() {}\n"
		);
		assert!(!status(root).contains("src/lib.rs"), "status: {}", status(root));
	}

	#[test]
	fn tick_refreshes_after_the_index_changes_on_disk() {
		let dir = fixture();
		let root = dir.path();
		let mut panel = open(root);
		assert!(!panel.tick(Duration::from_secs(1)));
		git(root, &["add", "notes.txt"]);
		let index = root.join(".git/index");
		let bumped = SystemTime::now() + Duration::from_secs(5);
		fs::File::open(&index)
			.and_then(|file| file.set_modified(bumped))
			.expect("bump index mtime");
		assert!(!panel.tick(Duration::from_secs(2)), "before the refresh deadline");
		assert!(panel.tick(Duration::from_secs(4)));
		assert_eq!(panel.snapshot().staged.len(), 1);
		assert_eq!(panel.snapshot().staged[0].path, "notes.txt");
	}

	#[test]
	fn opening_outside_a_repository_reports_the_directory() {
		let dir = tempfile::tempdir().expect("tempdir");
		let error = GitWorkbench::open_at(dir.path(), None, &UiContext::default(), Size {
			width:  80,
			height: 24,
		})
		.err()
		.expect("no repo");
		assert!(error.starts_with("Not a git repository: "), "{error}");
	}

	#[test]
	fn pinned_revision_shows_the_commit_view() {
		let dir = fixture();
		let mut panel = GitWorkbench::open_at(
			dir.path(),
			Some(Str::new_static("HEAD")),
			&UiContext::default(),
			Size { width: 120, height: 30 },
		)
		.expect("opens");
		assert!(panel.snapshot().pinned);
		let text = frame_text(panel.frame(Size { width: 120, height: 30 }));
		assert!(text.contains("initial"), "subject missing:\n{text}");
		assert!(text.contains("Ada"), "author missing:\n{text}");
		assert!(text.contains("1 modified"), "file count missing:\n{text}");
		assert!(text.contains("lib.rs"), "commit file missing:\n{text}");
	}

	const RAW: &str = "diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ \
	                   -1,3 +1,4 @@\n a\n-b\n+b2\n c\n+d\n";

	#[test]
	fn select_lines_keeps_only_the_chosen_changes() {
		let forward = select_lines(RAW, (0, 0), (4, 4), false).expect("patch");
		assert_eq!(
			forward,
			"diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,3 +1,4 \
			 @@\n a\n b\n c\n+d\n"
		);
		let reverse = select_lines(RAW, (2, 2), (0, 0), true).expect("patch");
		assert_eq!(
			reverse,
			"diff --git a/f.txt b/f.txt\nindex 1..2 100644\n--- a/f.txt\n+++ b/f.txt\n@@ -1,5 +1,4 \
			 @@\n a\n-b\n b2\n c\n d\n"
		);
		assert_eq!(select_lines(RAW, (0, 0), (0, 0), false), None);
		assert_eq!(select_lines(RAW, (1, 1), (1, 1), false), None);
		let whole = select_lines(RAW, (1, 3), (1, 4), false).expect("patch");
		assert_eq!(whole, RAW);
	}
}
