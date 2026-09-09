//! Complete bounded Git status, numstat, and unified-diff read models.

use std::{path::Path, str, str::FromStr as _};

use bytes::Bytes;
use strum::{EnumString, IntoStaticStr};
use tokio_util::sync::CancellationToken;

use super::{commands::CommandError, query::GitPath};

/// Kind of one index or worktree change reported by Git porcelain.
#[derive(Clone, Copy, Debug, EnumString, Eq, IntoStaticStr, PartialEq)]
pub enum ChangeKind {
	/// File contents or metadata changed.
	#[strum(serialize = "M")]
	Modified,
	/// Path was added.
	#[strum(serialize = "A")]
	Added,
	/// Path was deleted.
	#[strum(serialize = "D")]
	Deleted,
	/// Path was renamed.
	#[strum(serialize = "R")]
	Renamed,
	/// Path was copied.
	#[strum(serialize = "C")]
	Copied,
	/// File type changed.
	#[strum(serialize = "T")]
	TypeChanged,
	/// Index stages disagree because a merge is unresolved.
	#[strum(serialize = "U")]
	Unmerged,
}

/// One NUL-safe porcelain-v1 status record.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StatusEntry {
	/// Change between `HEAD` and the index.
	pub staged:     Option<ChangeKind>,
	/// Change between the index and worktree.
	pub worktree:   Option<ChangeKind>,
	/// Whether the XY pair is one of Git's unresolved merge states.
	pub conflicted: bool,
	/// Whether Git reported the path as untracked.
	pub untracked:  bool,
	/// Current repository-relative path.
	pub path:       GitPath,
	/// Original path for a rename or copy.
	pub orig_path:  Option<GitPath>,
}

/// Porcelain status counts.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct StatusCounts {
	/// Paths changed in the index.
	pub staged:    u32,
	/// Paths changed in the worktree.
	pub unstaged:  u32,
	/// Untracked paths.
	pub untracked: u32,
}

/// A parsed numstat count; binary files have no line count.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LineCount {
	/// Text line count.
	Lines(u64),
	/// Binary content (`-` in Git numstat).
	Binary,
}

/// One NUL-safe numstat entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NumstatEntry {
	/// Added lines or binary marker.
	pub added:    LineCount,
	/// Removed lines or binary marker.
	pub removed:  LineCount,
	/// Original path for a rename or copy.
	pub old_path: Option<GitPath>,
	/// Current path.
	pub path:     GitPath,
}

/// One unified hunk with exact raw bytes.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffHunk {
	/// Old-file starting line.
	pub old_start: u64,
	/// Old-file line count.
	pub old_count: u64,
	/// New-file starting line.
	pub new_start: u64,
	/// New-file line count.
	pub new_count: u64,
	/// Exact hunk bytes, including terminal newline when present.
	pub raw:       Bytes,
}

/// One parsed file patch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileDiff {
	/// Original path for a rename when declared by Git.
	pub old_path:             Option<Bytes>,
	/// Current path when available.
	pub path:                 Option<Bytes>,
	/// Whether Git declared binary patch content.
	pub binary:               bool,
	/// Whether an old-side line lacked its terminal newline.
	pub old_no_final_newline: bool,
	/// Whether a new-side line lacked its terminal newline.
	pub new_no_final_newline: bool,
	/// Parsed unified hunks.
	pub hunks:                Vec<DiffHunk>,
	/// Exact complete file-patch bytes.
	pub raw:                  Bytes,
}

/// Options shared by worktree and cached diffs.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DiffOptions {
	/// Compare the index to HEAD.
	pub cached:  bool,
	/// Include binary patch bodies.
	pub binary:  bool,
	/// Emit summary statistics.
	pub stat:    bool,
	/// Emit numstat records.
	pub numstat: bool,
}

/// Typed bounded Git diff facade.
#[derive(Clone, Copy, Default)]
pub struct GitDiff;

impl GitDiff {
	/// Creates a diff facade.
	pub const fn new() -> Self {
		Self
	}

	async fn repo(
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<std::sync::Arc<omp_vcs::git::GitRepo>, CommandError> {
		let cwd = cwd.to_owned();
		super::blocking(Some(cancel), move || {
			omp_vcs::git::GitRepo::require(&cwd).map(std::sync::Arc::new)
		})
		.await
		.map_err(Into::into)
	}

	fn options(options: DiffOptions, paths: &[&str]) -> omp_vcs::DiffOptions {
		omp_vcs::DiffOptions {
			cached: options.cached,
			binary: options.binary,
			files: paths.iter().map(|p| (*p).to_owned()).collect(),
			..Default::default()
		}
	}

	/// Captures a complete raw worktree or cached diff.
	pub async fn raw(
		&self,
		cwd: &Path,
		options: DiffOptions,
		paths: &[&str],
		cancel: &CancellationToken,
	) -> Result<Bytes, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let vcs_options = Self::options(options, paths);
		if options.numstat {
			let entries = super::blocking(Some(cancel), move || repo.numstat(&vcs_options)).await?;
			let mut out = Vec::new();
			for entry in entries {
				let added = entry
					.added
					.map_or_else(|| "-".to_owned(), |n| n.to_string());
				let removed = entry
					.removed
					.map_or_else(|| "-".to_owned(), |n| n.to_string());
				out.extend_from_slice(format!("{added}\t{removed}\t{}", entry.path).as_bytes());
				out.push(0);
			}
			return Ok(Bytes::from(out));
		}
		Ok(Bytes::from(super::blocking(Some(cancel), move || repo.diff_text(&vcs_options)).await?))
	}

	/// Lists changed paths.
	pub async fn names(
		&self,
		cwd: &Path,
		cached: bool,
		cancel: &CancellationToken,
	) -> Result<Vec<GitPath>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let options = omp_vcs::DiffOptions { cached, ..Default::default() };
		Ok(super::blocking(Some(cancel), move || repo.changed_files(&options))
			.await?
			.into_iter()
			.map(|p| GitPath::from_bytes(p.as_bytes()))
			.collect())
	}

	/// Returns whether a worktree or cached diff exists.
	pub async fn has(
		&self,
		cwd: &Path,
		cached: bool,
		cancel: &CancellationToken,
	) -> Result<bool, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let options = omp_vcs::DiffOptions { cached, ..Default::default() };
		Ok(super::blocking(Some(cancel), move || repo.has_diff(&options)).await?)
	}

	/// Captures a two-revision diff.
	pub async fn tree(
		&self,
		cwd: &Path,
		base: &str,
		head: &str,
		binary: bool,
		cancel: &CancellationToken,
	) -> Result<Bytes, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let base = base.to_owned();
		let head = head.to_owned();
		Ok(Bytes::from(
			super::blocking(Some(cancel), move || repo.diff_tree(&base, &head, binary)).await?,
		))
	}

	/// Captures a no-index filesystem diff.
	pub async fn no_index(
		&self,
		cwd: &Path,
		old: &Path,
		new: &Path,
		binary: bool,
		cancel: &CancellationToken,
	) -> Result<Bytes, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let old = old.to_owned();
		let new = new.to_owned();
		Ok(Bytes::from(
			super::blocking(Some(cancel), move || repo.diff_no_index(&old, &new, binary)).await?,
		))
	}

	/// Reads status counts.
	pub async fn status_counts(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<StatusCounts, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let value = super::blocking(Some(cancel), move || repo.status_summary()).await?;
		Ok(StatusCounts {
			staged:    value.staged,
			unstaged:  value.unstaged,
			untracked: value.untracked,
		})
	}

	/// Reads NUL-framed porcelain-v1 status.
	pub async fn status_raw(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Bytes, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let options = omp_vcs::StatusOptions {
			untracked: omp_vcs::UntrackedMode::All,
			nul_terminated: true,
			..Default::default()
		};
		Ok(Bytes::from(super::blocking(Some(cancel), move || repo.status_porcelain(&options)).await?))
	}

	/// Returns numstat for a two-revision diff.
	pub async fn numstat_tree(
		&self,
		cwd: &Path,
		base: &str,
		head: &str,
		cancel: &CancellationToken,
	) -> Result<Vec<NumstatEntry>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let options = omp_vcs::DiffOptions {
			base: Some(base.to_owned()),
			head: Some(head.to_owned()),
			..Default::default()
		};
		Ok(super::blocking(Some(cancel), move || repo.numstat(&options))
			.await?
			.into_iter()
			.map(|entry| NumstatEntry {
				added:    entry
					.added
					.map_or(LineCount::Binary, |value| LineCount::Lines(value.into())),
				removed:  entry
					.removed
					.map_or(LineCount::Binary, |value| LineCount::Lines(value.into())),
				old_path: None,
				path:     GitPath::from_bytes(entry.path.as_bytes()),
			})
			.collect())
	}

	/// Reads rich porcelain-v1 status entries.
	pub async fn status_entries(
		&self,
		cwd: &Path,
		cancel: &CancellationToken,
	) -> Result<Vec<StatusEntry>, CommandError> {
		let repo = Self::repo(cwd, cancel).await?;
		let options = omp_vcs::StatusOptions {
			untracked: omp_vcs::UntrackedMode::All,
			nul_terminated: true,
			..Default::default()
		};
		let text = super::blocking(Some(cancel), move || repo.status_porcelain(&options)).await?;
		Ok(parse_status_entries(text.as_bytes()))
	}
}

/// Parses porcelain v1 (line or NUL framed) and v2 records into counts.
/// Parses NUL-framed porcelain-v1 records, including rename origins and
/// unresolved merge states.
pub fn parse_status_entries(bytes: &[u8]) -> Vec<StatusEntry> {
	const CONFLICTS: [[u8; 2]; 7] = [*b"DD", *b"AU", *b"UD", *b"UA", *b"DU", *b"AA", *b"UU"];

	let records: Vec<_> = bytes.split(|byte| *byte == 0).collect();
	let mut entries = Vec::new();
	let mut index = 0;
	while let Some(record) = records.get(index).copied() {
		index += 1;
		if record.len() < 3 || record[2] != b' ' {
			continue;
		}
		let xy = [record[0], record[1]];
		if xy == *b"!!" {
			continue;
		}
		let untracked = xy == *b"??";
		let conflicted = CONFLICTS.contains(&xy);
		let renamed_or_copied = xy.iter().any(|kind| matches!(kind, b'R' | b'C'));
		let orig_path = if renamed_or_copied {
			let origin = records.get(index).copied().filter(|path| !path.is_empty());
			index += usize::from(index < records.len());
			origin.map(GitPath::from_bytes)
		} else {
			None
		};
		let kind = |value: &[u8]| {
			str::from_utf8(value)
				.ok()
				.and_then(|value| ChangeKind::from_str(value).ok())
		};
		entries.push(StatusEntry {
			staged: if untracked { None } else { kind(&record[..1]) },
			worktree: if untracked { None } else { kind(&record[1..2]) },
			conflicted,
			untracked,
			path: GitPath::from_bytes(&record[3..]),
			orig_path,
		});
	}
	entries
}

/// Parses porcelain v1 (line or NUL framed) and v2 records into counts.
pub fn parse_status(bytes: &[u8]) -> StatusCounts {
	let nul_framed = bytes.contains(&0);
	let records: Vec<_> = bytes
		.split(|byte| *byte == 0 || !nul_framed && *byte == b'\n')
		.filter(|record| !record.is_empty())
		.collect();
	let mut counts = StatusCounts::default();
	let mut index = 0;
	while index < records.len() {
		let record = records[index];
		let mut consumes_origin = false;
		let xy = match record.first().copied() {
			Some(b'?') if record.get(1) == Some(&b'?') || record.get(1) == Some(&b' ') => {
				counts.untracked = counts.untracked.saturating_add(1);
				index += 1;
				continue;
			},
			Some(b'!') | Some(b'#') => {
				index += 1;
				continue;
			},
			Some(b'1' | b'u') => record.split(|byte| *byte == b' ').nth(1),
			Some(b'2') => {
				consumes_origin = nul_framed;
				record.split(|byte| *byte == b' ').nth(1)
			},
			_ => {
				consumes_origin = nul_framed && matches!(record.first(), Some(b'R' | b'C'));
				record.get(..2)
			},
		};
		if let Some(xy) = xy.filter(|xy| xy.len() >= 2) {
			if !matches!(xy[0], b' ' | b'.' | b'?' | b'!') {
				counts.staged = counts.staged.saturating_add(1);
			}
			if !matches!(xy[1], b' ' | b'.' | b'?' | b'!') {
				counts.unstaged = counts.unstaged.saturating_add(1);
			}
		}
		index += if consumes_origin { 2 } else { 1 };
	}
	counts
}

/// Parses `git diff --numstat -z`, including its three-record rename form.
pub fn parse_numstat(bytes: Bytes) -> Result<Vec<NumstatEntry>, CommandError> {
	let fields: Vec<_> = bytes
		.split(|byte| *byte == 0)
		.filter(|field| !field.is_empty())
		.collect();
	let mut result = Vec::new();
	let mut index = 0;
	while index < fields.len() {
		let record = fields[index];
		let first = record
			.iter()
			.position(|byte| *byte == b'\t')
			.ok_or(CommandError::NonUtf8)?;
		let second_rel = record[first + 1..]
			.iter()
			.position(|byte| *byte == b'\t')
			.ok_or(CommandError::NonUtf8)?;
		let second = first + 1 + second_rel;
		let added = parse_count(&record[..first])?;
		let removed = parse_count(&record[first + 1..second])?;
		let inline_path = &record[second + 1..];
		if inline_path.is_empty() {
			let old = fields.get(index + 1).ok_or(CommandError::NonUtf8)?;
			let new = fields.get(index + 2).ok_or(CommandError::NonUtf8)?;
			result.push(NumstatEntry {
				added,
				removed,
				old_path: Some(GitPath::from_bytes(old)),
				path: GitPath::from_bytes(new),
			});
			index += 3;
		} else {
			result.push(NumstatEntry {
				added,
				removed,
				old_path: None,
				path: GitPath::from_bytes(inline_path),
			});
			index += 1;
		}
	}
	Ok(result)
}

/// Parses complete unified diff bytes while retaining every original byte.
pub fn parse_unified(bytes: Bytes) -> Vec<FileDiff> {
	let starts = find_all(&bytes, b"diff --git ");
	let mut files = Vec::with_capacity(starts.len());
	for (position, start) in starts.iter().copied().enumerate() {
		let end = starts.get(position + 1).copied().unwrap_or(bytes.len());
		let raw = bytes.slice(start..end);
		files.push(parse_file(raw));
	}
	files
}

fn parse_file(raw: Bytes) -> FileDiff {
	let mut old_path = None;
	let mut path = None;
	if let Some(header) = raw.split(|byte| *byte == b'\n').next()
		&& let Some(paths) = header.strip_prefix(b"diff --git a/")
		&& let Some(separator) = paths.windows(3).rposition(|window| window == b" b/")
	{
		old_path = Some(Bytes::copy_from_slice(&paths[..separator]));
		path = Some(Bytes::copy_from_slice(&paths[separator + 3..]));
	}
	let mut binary = false;
	let mut old_no_final_newline = false;
	let mut new_no_final_newline = false;
	let mut hunks = Vec::new();
	let mut offset = 0;
	let mut hunk_start = None;
	let mut hunk_range = None;
	let mut previous_prefix = None;
	for line in raw.split_inclusive(|byte| *byte == b'\n') {
		let line_without_newline = line.strip_suffix(b"\n").unwrap_or(line);
		if let Some(value) = line_without_newline.strip_prefix(b"rename from ") {
			old_path = Some(Bytes::copy_from_slice(value));
		} else if let Some(value) = line_without_newline.strip_prefix(b"rename to ") {
			path = Some(Bytes::copy_from_slice(value));
		} else if old_path.is_none()
			&& let Some(value) = line_without_newline.strip_prefix(b"--- a/")
		{
			old_path = Some(Bytes::copy_from_slice(value));
		} else if path.is_none()
			&& let Some(value) = line_without_newline.strip_prefix(b"+++ b/")
		{
			path = Some(Bytes::copy_from_slice(value));
		} else if line_without_newline.starts_with(b"Binary files ")
			|| line_without_newline == b"GIT binary patch"
		{
			binary = true;
		} else if line_without_newline.starts_with(b"@@ ") {
			if let (Some(start), Some(range)) = (hunk_start.take(), hunk_range.take()) {
				hunks.push(make_hunk(&raw, start, offset, range));
			}
			hunk_range = parse_hunk_header(line_without_newline);
			hunk_start = Some(offset);
		} else if line_without_newline == b"\\ No newline at end of file" {
			match previous_prefix {
				Some(b'-') => old_no_final_newline = true,
				Some(b'+') => new_no_final_newline = true,
				_ => {},
			}
		}
		if matches!(line_without_newline.first(), Some(b'+' | b'-'))
			&& !line_without_newline.starts_with(b"+++")
			&& !line_without_newline.starts_with(b"---")
		{
			previous_prefix = line_without_newline.first().copied();
		}
		offset += line.len();
	}
	if let (Some(start), Some(range)) = (hunk_start, hunk_range) {
		hunks.push(make_hunk(&raw, start, raw.len(), range));
	}
	FileDiff { old_path, path, binary, old_no_final_newline, new_no_final_newline, hunks, raw }
}

fn make_hunk(raw: &Bytes, start: usize, end: usize, range: (u64, u64, u64, u64)) -> DiffHunk {
	DiffHunk {
		old_start: range.0,
		old_count: range.1,
		new_start: range.2,
		new_count: range.3,
		raw:       raw.slice(start..end),
	}
}

fn parse_hunk_header(line: &[u8]) -> Option<(u64, u64, u64, u64)> {
	let text = str::from_utf8(line).ok()?;
	let mut fields = text.split_whitespace();
	(fields.next()? == "@@").then_some(())?;
	let old = parse_range(fields.next()?.strip_prefix('-')?)?;
	let new = parse_range(fields.next()?.strip_prefix('+')?)?;
	Some((old.0, old.1, new.0, new.1))
}

fn parse_range(value: &str) -> Option<(u64, u64)> {
	match value.split_once(',') {
		Some((start, count)) => Some((start.parse().ok()?, count.parse().ok()?)),
		None => Some((value.parse().ok()?, 1)),
	}
}

fn parse_count(bytes: &[u8]) -> Result<LineCount, CommandError> {
	if bytes == b"-" {
		return Ok(LineCount::Binary);
	}
	let text = str::from_utf8(bytes).map_err(|_| CommandError::NonUtf8)?;
	text
		.parse()
		.map(LineCount::Lines)
		.map_err(|_| CommandError::NonUtf8)
}

fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
	let mut offsets = Vec::new();
	let mut position = 0;
	while position + needle.len() <= haystack.len() {
		if (position == 0 || haystack[position - 1] == b'\n')
			&& &haystack[position..position + needle.len()] == needle
		{
			offsets.push(position);
			position += needle.len();
		} else {
			position += 1;
		}
	}
	offsets
}
