//! Backend-agnostic change capture.
//!
//! Two code paths, both producing a [`Diff`] = list of [`FileChange`]:
//!
//! - **Git mode.** When `merged/.git` exists we shell `git diff --no-color
//!   HEAD` plus `git ls-files --others --exclude-standard` (for untracked),
//!   split the output on `diff --git` headers, and emit one [`FileChange`] per
//!   file. Binary entries surface as `diff: None`.
//! - **Plain mode.** No `.git`; we walk both trees in parallel, short-circuit
//!   on `(size, mtime-truncated-to-seconds)` equality, and emit a unified diff
//!   for each surviving pair via `similar`. NUL within the first 8 KiB
//!   classifies the file as binary → `diff: None`.
//!
//! Per the PAL contract: for binary files we don't materialize the bytes
//! in the patch — callers that want them read directly from `merged`
//! (for `Added`/`Modified`) or `lower` (for `Removed`).

use std::{
	collections::BTreeMap,
	fs::Metadata,
	path::{Path, PathBuf},
	time::SystemTime,
};

use tokio::process::Command;

use crate::{IsoError, IsoResult, command_failed};

/// Captured changes between a `lower` baseline and a `merged` view.
#[derive(Debug, Clone, Default)]
pub struct Diff {
	pub files: Vec<FileChange>,
}

impl Diff {
	pub const fn is_empty(&self) -> bool {
		self.files.is_empty()
	}

	/// Concatenated unified-diff text for every text-representable entry.
	/// Binary entries are skipped — enumerate via [`files`](Self::files)
	/// and copy them out-of-band if you need their contents.
	pub fn unified_text(&self) -> String {
		let mut out = String::new();
		for file in &self.files {
			let Some(diff) = &file.diff else { continue };
			if diff.is_empty() {
				continue;
			}
			if !out.is_empty() && !out.ends_with('\n') {
				out.push('\n');
			}
			out.push_str(diff);
		}
		out
	}
}

/// One entry in a [`Diff`].
///
/// `path` is relative to `merged`. `diff = None` means the file is binary
/// or otherwise text-unrepresentable — copy the contents from the merged
/// tree if you need them (or skip if you only care about text).
#[derive(Debug, Clone)]
pub struct FileChange {
	pub path: PathBuf,
	pub op:   ChangeKind,
	pub diff: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChangeKind {
	Added,
	Modified,
	Removed,
}

/// Default backend diff: git when available, mtime-skipped walk otherwise.
pub async fn default_diff(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	if is_git_tree(merged).await {
		git_diff(merged).await
	} else {
		walk_diff(lower, merged).await
	}
}

async fn is_git_tree(merged: &Path) -> bool {
	tokio::fs::symlink_metadata(merged.join(".git"))
		.await
		.is_ok()
}

// ─── git mode ───────────────────────────────────────────────────────────────

async fn git_diff(merged: &Path) -> IsoResult<Diff> {
	// `--no-color`: keep ANSI out of patch text.
	// No `--binary`: we *want* git's `Binary files … differ` placeholder
	// so we can map it to `diff: None`.
	let tracked =
		git_run(merged, &["-c", "core.quotepath=off", "diff", "--no-color", "HEAD"]).await?;

	let untracked_list = git_run(merged, &[
		"-c",
		"core.quotepath=off",
		"ls-files",
		"--others",
		"--exclude-standard",
		"-z",
	])
	.await?;

	let mut files = parse_git_diff(&tracked);

	let mut untracked_paths: Vec<&[u8]> = untracked_list
		.split(|b| *b == 0)
		.filter(|s| !s.is_empty())
		.collect();
	untracked_paths.sort_unstable();

	for path_bytes in untracked_paths {
		let path_str = std::str::from_utf8(path_bytes)
			.map_err(|err| IsoError::other(format!("untracked path is not valid UTF-8: {err}")))?;
		let one = git_run_allow_exit1(merged, &[
			"-c",
			"core.quotepath=off",
			"diff",
			"--no-color",
			"--no-index",
			git_null_path(),
			path_str,
		])
		.await?;
		files.extend(parse_git_diff(&one));
	}

	files.sort_by(|a, b| a.path.cmp(&b.path));
	Ok(Diff { files })
}

#[cfg(windows)]
const fn git_null_path() -> &'static str {
	"NUL"
}

#[cfg(not(windows))]
const fn git_null_path() -> &'static str {
	"/dev/null"
}

/// Format a failed `git` invocation, rendering a signal death as `exit ?`.
fn git_failure(args: &[&str], output: &std::process::Output) -> IsoError {
	command_failed(
		format_args!("git {}", args.join(" ")),
		output
			.status
			.code()
			.map_or_else(|| "?".into(), |c| c.to_string()),
		&output.stderr,
	)
}

async fn git_run(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = git_spawn(cwd, args).await?;
	if !output.status.success() {
		return Err(git_failure(args, &output));
	}
	Ok(output.stdout)
}

/// `git diff --no-index` returns exit code 1 when files differ — that's
/// not an error for us, treat it as success with the produced patch.
async fn git_run_allow_exit1(cwd: &Path, args: &[&str]) -> IsoResult<Vec<u8>> {
	let output = git_spawn(cwd, args).await?;
	if output.status.success() || output.status.code() == Some(1) {
		return Ok(output.stdout);
	}
	Err(git_failure(args, &output))
}

async fn git_spawn(cwd: &Path, args: &[&str]) -> IsoResult<std::process::Output> {
	let mut cmd = Command::new("git");
	cmd.arg("-C").arg(cwd).args(args);
	cmd.stdin(std::process::Stdio::null());
	cmd.output().await.map_err(|err| {
		if err.kind() == std::io::ErrorKind::NotFound {
			IsoError::unavailable("`git` not on PATH; cannot capture diff for git-tracked tree")
		} else {
			IsoError::other(format!("spawn git: {err}"))
		}
	})
}

/// Split a `git diff` blob into per-file [`FileChange`] entries. Each
/// entry covers exactly one `diff --git a/<path> b/<path>` block. Binary
/// blocks are emitted with `diff: None`; the rest carry their original
/// unified-diff slice unchanged so `git apply` produces byte-identical
/// results downstream.
fn parse_git_diff(blob: &[u8]) -> Vec<FileChange> {
	let Ok(text) = std::str::from_utf8(blob) else {
		return Vec::new();
	};
	let mut out = Vec::<FileChange>::new();
	let iter = text.split_inclusive('\n');
	let mut buf = String::new();
	let mut header_path: Option<PathBuf> = None;
	let mut header_kind = ChangeKind::Modified;
	let mut header_binary = false;

	let flush = |buf: &mut String,
	             path: &mut Option<PathBuf>,
	             kind: &mut ChangeKind,
	             binary: &mut bool,
	             out: &mut Vec<FileChange>| {
		if let Some(p) = path.take() {
			let diff = if *binary {
				None
			} else {
				Some(std::mem::take(buf))
			};
			out.push(FileChange { path: p, op: *kind, diff });
		}
		buf.clear();
		*kind = ChangeKind::Modified;
		*binary = false;
	};

	for line in iter {
		if let Some(rest) = line.strip_prefix("diff --git ") {
			flush(&mut buf, &mut header_path, &mut header_kind, &mut header_binary, &mut out);
			let trimmed = rest.trim_end_matches('\n');
			if let Some((_, b)) = trimmed.split_once(' ') {
				let path = b.strip_prefix("b/").unwrap_or(b);
				header_path = Some(PathBuf::from(path));
			}
			buf.push_str(line);
			continue;
		}
		if header_path.is_some() {
			if line.starts_with("new file mode ") {
				header_kind = ChangeKind::Added;
			} else if line.starts_with("deleted file mode ") {
				header_kind = ChangeKind::Removed;
			} else if line.starts_with("Binary files ") || line.starts_with("GIT binary patch") {
				header_binary = true;
			}
			buf.push_str(line);
		}
	}
	flush(&mut buf, &mut header_path, &mut header_kind, &mut header_binary, &mut out);
	out
}

// ─── plain mode ─────────────────────────────────────────────────────────────

async fn walk_diff(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	let lower = lower.to_path_buf();
	let merged = merged.to_path_buf();
	tokio::task::spawn_blocking(move || walk_diff_blocking(&lower, &merged))
		.await
		.map_err(|err| IsoError::other(format!("walk_diff join: {err}")))?
}

fn walk_diff_blocking(lower: &Path, merged: &Path) -> IsoResult<Diff> {
	let lower_index = index_tree(lower)?;
	let merged_index = index_tree(merged)?;

	let mut files: Vec<FileChange> = Vec::new();

	for (rel, m_meta) in &merged_index {
		match lower_index.get(rel) {
			None => files.push(plain_change(merged, rel, ChangeKind::Added, None)?),
			Some(l_meta) => {
				if metas_equal(l_meta, m_meta) {
					continue;
				}
				files.push(plain_change(merged, rel, ChangeKind::Modified, Some(lower))?);
			},
		}
	}
	for rel in lower_index.keys() {
		if !merged_index.contains_key(rel) {
			files.push(plain_change(lower, rel, ChangeKind::Removed, None)?);
		}
	}

	files.sort_by(|a, b| a.path.cmp(&b.path));
	Ok(Diff { files })
}

fn metas_equal(a: &Metadata, b: &Metadata) -> bool {
	if a.len() != b.len() {
		return false;
	}
	match (a.modified(), b.modified()) {
		(Ok(ma), Ok(mb)) => systime_eq(ma, mb),
		_ => false,
	}
}

fn systime_eq(a: SystemTime, b: SystemTime) -> bool {
	// Filesystems carry mtime at different resolutions (HFS+ seconds, APFS
	// nanos, FAT 2 seconds). Compare at second granularity so a metadata-
	// preserving copy that flushed through a coarse layer doesn't look
	// modified.
	let to_secs = |t: SystemTime| {
		t.duration_since(SystemTime::UNIX_EPOCH)
			.map_or(0, |d| d.as_secs())
	};
	to_secs(a) == to_secs(b)
}

fn index_tree(root: &Path) -> IsoResult<BTreeMap<PathBuf, Metadata>> {
	let mut out = BTreeMap::new();
	if !root.exists() {
		return Ok(out);
	}
	walk(root, root, &mut out)?;
	Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Metadata>) -> IsoResult<()> {
	let entries = std::fs::read_dir(dir)
		.map_err(|err| IsoError::other(format!("read_dir {}: {err}", dir.display())))?;
	for entry in entries {
		let entry =
			entry.map_err(|err| IsoError::other(format!("dir entry in {}: {err}", dir.display())))?;
		let path = entry.path();
		let meta = entry
			.metadata()
			.map_err(|err| IsoError::other(format!("metadata {}: {err}", path.display())))?;
		if meta.is_symlink() {
			let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
			out.insert(rel, meta);
			continue;
		}
		if meta.is_dir() {
			walk(root, &path, out)?;
			continue;
		}
		let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
		out.insert(rel, meta);
	}
	Ok(())
}

/// Build a [`FileChange`] for an entry observed by [`walk_diff_blocking`].
///
/// `op == Modified` requires `peer_root = Some(lower)` so we can read the
/// counterpart; `Added`/`Removed` only need the side we already know about.
fn plain_change(
	side: &Path,
	rel: &Path,
	op: ChangeKind,
	peer_root: Option<&Path>,
) -> IsoResult<FileChange> {
	let full = side.join(rel);
	let primary = std::fs::read(&full)
		.map_err(|err| IsoError::other(format!("read {}: {err}", full.display())))?;
	if looks_binary(&primary) {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	}
	let (old_bytes, new_bytes) = match op {
		ChangeKind::Added => (Vec::new(), primary),
		ChangeKind::Removed => (primary, Vec::new()),
		ChangeKind::Modified => {
			let peer = peer_root.expect("modified change requires peer root");
			let peer_full = peer.join(rel);
			let peer_bytes = std::fs::read(&peer_full)
				.map_err(|err| IsoError::other(format!("read {}: {err}", peer_full.display())))?;
			if looks_binary(&peer_bytes) {
				return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
			}
			(peer_bytes, primary)
		},
	};
	let (Ok(old_text), Ok(new_text)) =
		(std::str::from_utf8(&old_bytes), std::str::from_utf8(&new_bytes))
	else {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	};
	Ok(FileChange {
		path: rel.to_path_buf(),
		op,
		diff: Some(render_unified(rel, op, old_text, new_text)),
	})
}

fn render_unified(rel: &Path, op: ChangeKind, old: &str, new: &str) -> String {
	let rel_str = rel.to_string_lossy();
	let (from_label, to_label) = match op {
		ChangeKind::Added => (String::from("/dev/null"), format!("b/{rel_str}")),
		ChangeKind::Removed => (format!("a/{rel_str}"), String::from("/dev/null")),
		ChangeKind::Modified => (format!("a/{rel_str}"), format!("b/{rel_str}")),
	};
	use std::fmt::Write as _;
	let mut out = String::new();
	let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
	match op {
		ChangeKind::Added => {
			let _ = writeln!(out, "new file mode 100644");
		},
		ChangeKind::Removed => {
			let _ = writeln!(out, "deleted file mode 100644");
		},
		ChangeKind::Modified => {},
	}
	let body = similar::TextDiff::from_lines(old, new)
		.unified_diff()
		.context_radius(3)
		.header(&from_label, &to_label)
		.to_string();
	out.push_str(&body);
	if !out.ends_with('\n') {
		out.push('\n');
	}
	out
}

fn looks_binary(bytes: &[u8]) -> bool {
	bytes.iter().take(8192).any(|&b| b == 0)
}
