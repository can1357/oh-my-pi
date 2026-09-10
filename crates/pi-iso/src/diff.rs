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
	let (primary_link, primary) = read_entry(&full)?;
	let (old_link, new_link, old_bytes, new_bytes) = match op {
		ChangeKind::Added => (false, primary_link, Vec::new(), primary),
		ChangeKind::Removed => (primary_link, false, primary, Vec::new()),
		ChangeKind::Modified => {
			let peer = peer_root.expect("modified change requires peer root");
			let peer_full = peer.join(rel);
			let (pl, peer_bytes) = read_entry(&peer_full)?;
			(pl, primary_link, peer_bytes, primary)
		},
	};
	let is_link = old_link || new_link;
	if !is_link && (looks_binary(&old_bytes) || looks_binary(&new_bytes)) {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	}
	let (Ok(old_text), Ok(new_text)) =
		(std::str::from_utf8(&old_bytes), std::str::from_utf8(&new_bytes))
	else {
		return Ok(FileChange { path: rel.to_path_buf(), op, diff: None });
	};
	Ok(FileChange {
		path: rel.to_path_buf(),
		op,
		diff: Some(render_unified(rel, op, old_text, new_text, old_link, new_link)),
	})
}

/// Read one tree entry without following symlinks: regular files yield their
/// contents, symlinks yield the link target so an out-of-tree target's data
/// never lands in the patch (mirroring git's mode-120000 blob).
fn read_entry(path: &Path) -> IsoResult<(bool, Vec<u8>)> {
	if std::fs::symlink_metadata(path)
		.map_err(|err| IsoError::other(format!("metadata {}: {err}", path.display())))?
		.is_symlink()
	{
		let target = std::fs::read_link(path)
			.map_err(|err| IsoError::other(format!("readlink {}: {err}", path.display())))?;
		return Ok((true, target.to_string_lossy().into_owned().into_bytes()));
	}
	let bytes = std::fs::read(path)
		.map_err(|err| IsoError::other(format!("read {}: {err}", path.display())))?;
	Ok((false, bytes))
}

fn render_unified(
	rel: &Path,
	op: ChangeKind,
	old: &str,
	new: &str,
	old_is_link: bool,
	new_is_link: bool,
) -> String {
	let rel_str = rel.to_string_lossy();
	let mode = |link: bool| if link { 120000 } else { 100644 };
	let (from_label, to_label) = match op {
		ChangeKind::Added => (String::from("/dev/null"), format!("b/{rel_str}")),
		ChangeKind::Removed => (format!("a/{rel_str}"), String::from("/dev/null")),
		ChangeKind::Modified => (format!("a/{rel_str}"), format!("b/{rel_str}")),
	};
	use std::fmt::Write as _;
	let mut out = String::new();
	// Git's patch format treats mode lines as extended headers that only make
	// sense after the per-file `diff --git` header; `git apply` needs the
	// header to associate them.
	match op {
		ChangeKind::Added => {
			let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
			let _ = writeln!(out, "new file mode {}", mode(new_is_link));
			push_unified_body(&mut out, old, new, &from_label, &to_label);
		},
		ChangeKind::Removed => {
			let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
			let _ = writeln!(out, "deleted file mode {}", mode(old_is_link));
			push_unified_body(&mut out, old, new, &from_label, &to_label);
		},
		ChangeKind::Modified if old_is_link != new_is_link => {
			// `git apply` rejects a single-block old mode/new mode
			// transition across filesystem types ("new mode of entry does
			// not match old mode"), in either direction, so type changes
			// use git's canonical delete + create representation.
			let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
			let _ = writeln!(out, "deleted file mode {}", mode(old_is_link));
			push_unified_body(&mut out, old, "", &from_label, "/dev/null");
			let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
			let _ = writeln!(out, "new file mode {}", mode(new_is_link));
			push_unified_body(&mut out, "", new, "/dev/null", &to_label);
		},
		ChangeKind::Modified => {
			let _ = writeln!(out, "diff --git a/{rel_str} b/{rel_str}");
			push_unified_body(&mut out, old, new, &from_label, &to_label);
		},
	}
	if !out.ends_with('\n') {
		out.push('\n');
	}
	out
}

fn push_unified_body(out: &mut String, old: &str, new: &str, from_label: &str, to_label: &str) {
	let body = similar::TextDiff::from_lines(old, new)
		.unified_diff()
		.context_radius(3)
		.header(from_label, to_label)
		.to_string();
	out.push_str(&body);
}

fn looks_binary(bytes: &[u8]) -> bool {
	bytes.iter().take(8192).any(|&b| b == 0)
}

/// Apply-level regression tests: plain-mode symlink patches must survive the
/// real `git apply` with the correct filesystem type, not just the right
/// bytes. See PR #11443 review — a mode-120000 line without its
/// `diff --git` header produces a regular file instead of a symlink.
#[cfg(all(test, unix))]
mod tests {
	use std::{
		fs,
		io::Write as _,
		path::{Path, PathBuf},
		process::{Command, Stdio},
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::*;

	struct TempDirGuard(PathBuf);

	impl TempDirGuard {
		fn new() -> Self {
			static COUNTER: AtomicU64 = AtomicU64::new(0);
			let nanos = SystemTime::now()
				.duration_since(UNIX_EPOCH)
				.expect("system time should be after epoch")
				.as_nanos();
			let dir = std::env::temp_dir().join(format!(
				"pi-iso-diff-test-{}-{nanos}-{}",
				std::process::id(),
				COUNTER.fetch_add(1, Ordering::Relaxed)
			));
			fs::create_dir_all(&dir).expect("create temp test directory");
			Self(dir)
		}

		fn path(&self) -> &Path {
			&self.0
		}
	}

	impl Drop for TempDirGuard {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	/// One entry in a synthetic test tree: a regular file's contents or a
	/// symlink's target.
	enum Entry {
		File(&'static str),
		Link(&'static str),
	}

	fn write_tree(root: &Path, entries: &[(&str, Entry)]) {
		fs::create_dir_all(root).expect("create test tree root");
		for (name, entry) in entries {
			match entry {
				Entry::File(contents) => {
					fs::write(root.join(name), contents).expect("write test file");
				},
				Entry::Link(target) => {
					std::os::unix::fs::symlink(target, root.join(name)).expect("create test symlink");
				},
			}
		}
	}

	/// Render the plain-mode diff between two synthetic trees and pipe it
	/// through the real `git apply` against a fresh copy of `lower`. Returns
	/// the applied target tree and the emitted patch text.
	///
	/// Entry contents are chosen so regular files and link targets differ in
	/// size, keeping second-granularity mtime equality from collapsing the
	/// Modified cases into "unchanged".
	fn apply_plain_diff(lower: &[(&str, Entry)], merged: &[(&str, Entry)]) -> (TempDirGuard, String) {
		let lower_dir = TempDirGuard::new();
		let merged_dir = TempDirGuard::new();
		let target_dir = TempDirGuard::new();
		write_tree(lower_dir.path(), lower);
		write_tree(merged_dir.path(), merged);
		// `git apply` starts from the lower state.
		write_tree(target_dir.path(), lower);

		let diff = walk_diff_blocking(lower_dir.path(), merged_dir.path())
			.expect("plain walk should produce a diff");
		let patch: String = diff
			.files
			.iter()
			.filter_map(|change| change.diff.as_deref())
			.collect();
		assert!(!patch.is_empty(), "plain diff should render a text patch");

		let mut child = Command::new("git")
			.args(["apply", "--whitespace=nowarn"])
			.current_dir(target_dir.path())
			.stdin(Stdio::piped())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.spawn()
			.expect("spawn git apply");
		child
			.stdin
			.as_mut()
			.expect("git apply stdin")
			.write_all(patch.as_bytes())
			.expect("write patch to git apply");
		let output = child.wait_with_output().expect("wait for git apply");
		assert!(
			output.status.success(),
			"git apply failed: {}{}",
			String::from_utf8_lossy(&output.stdout),
			String::from_utf8_lossy(&output.stderr)
		);

		(target_dir, patch)
	}

	/// The applied entry must match the merged tree's *type* — symlink vs
	/// regular file — plus its target or contents.
	fn assert_entry_matches(root: &Path, name: &str, entry: &Entry) {
		let path = root.join(name);
		match entry {
			Entry::File(contents) => {
				let meta = fs::symlink_metadata(&path)
					.unwrap_or_else(|err| panic!("{name} should exist: {err}"));
				assert!(!meta.is_symlink(), "{name} should be a regular file");
				assert_eq!(
					fs::read_to_string(&path).unwrap_or_else(|err| panic!("{name} readable: {err}")),
					*contents
				);
			},
			Entry::Link(target) => {
				let meta = fs::symlink_metadata(&path)
					.unwrap_or_else(|err| panic!("{name} should exist: {err}"));
				assert!(meta.is_symlink(), "{name} should be a symlink");
				assert_eq!(fs::read_link(&path).expect("read link target").to_string_lossy(), *target);
			},
		}
	}

	fn assert_absent(root: &Path, name: &str) {
		assert!(
			fs::symlink_metadata(root.join(name)).is_err(),
			"{name} should have been removed by the patch"
		);
	}

	#[test]
	fn added_symlink_patch_applies_as_symlink() {
		let (target, patch) = apply_plain_diff(
			&[("keep.txt", Entry::File("keep\n"))],
			&[("keep.txt", Entry::File("keep\n")), ("link", Entry::Link("data.bin"))],
		);
		assert!(
			patch.contains("diff --git a/link b/link\nnew file mode 120000\n"),
			"added symlink patch must carry the git header before the mode line:\n{patch}"
		);
		assert_entry_matches(target.path(), "link", &Entry::Link("data.bin"));
		assert_entry_matches(target.path(), "keep.txt", &Entry::File("keep\n"));
	}

	#[test]
	fn removed_symlink_patch_applies_as_deletion() {
		let (target, patch) = apply_plain_diff(
			&[("keep.txt", Entry::File("keep\n")), ("link", Entry::Link("data.bin"))],
			&[("keep.txt", Entry::File("keep\n"))],
		);
		assert!(
			patch.contains("diff --git a/link b/link\ndeleted file mode 120000\n"),
			"removed symlink patch must carry the git header before the mode line:\n{patch}"
		);
		assert_absent(target.path(), "link");
		assert_entry_matches(target.path(), "keep.txt", &Entry::File("keep\n"));
	}

	#[test]
	fn regular_to_symlink_patch_applies_type_transition() {
		let (target, patch) = apply_plain_diff(
			&[("entry", Entry::File("payload\n"))],
			&[("entry", Entry::Link("elsewhere"))],
		);
		// Git's canonical typechange representation is delete + create, in
		// either direction (see `git diff` on a 100644 -> 120000 transition).
		assert!(
			patch.contains("diff --git a/entry b/entry\ndeleted file mode 100644\n")
				&& patch.contains("diff --git a/entry b/entry\nnew file mode 120000\n"),
			"regular-to-symlink patch must emit git's canonical delete + create pair:\n{patch}"
		);
		assert_entry_matches(target.path(), "entry", &Entry::Link("elsewhere"));
	}

	#[test]
	fn symlink_to_regular_patch_applies_type_transition() {
		let (target, patch) = apply_plain_diff(
			&[("entry", Entry::Link("elsewhere"))],
			&[("entry", Entry::File("payload\n"))],
		);
		// `git apply` rejects a single 120000 -> 100644 mode transition, so
		// the patch must use git's canonical delete + create representation.
		assert!(
			patch.contains("diff --git a/entry b/entry\ndeleted file mode 120000\n")
				&& patch.contains("diff --git a/entry b/entry\nnew file mode 100644\n"),
			"symlink-to-regular patch must emit git's canonical delete + create pair:\n{patch}"
		);
		assert_entry_matches(target.path(), "entry", &Entry::File("payload\n"));
	}
}
