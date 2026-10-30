//! Backups of replaced and deleted files (`--backup`, `--backup-dir`, `--suffix`).
//!
//! Behavior follows rsync 3.5.1:
//!
//! - Without `--backup-dir` the backup sits beside the original as `NAME` + suffix
//!   (default `~`). With `--backup-dir=DIR` it goes to `DIR/NAME` + suffix (the suffix
//!   defaults to empty there), the relative structure being recreated below `DIR`. A
//!   relative `DIR` is relative to the destination root. `DIR` itself is created on the
//!   first backup (the session prints `(new) backup_dir is …` at start-up); every new
//!   directory below it takes the attributes of the destination directory it mirrors,
//!   and a non-directory in the way of the backup path is deleted.
//! - A backup is preferably a rename; callers that must keep the original
//!   (`prefer_rename == false`) get a hard link, and anything else falls back to a copy
//!   (symlinks and devices/specials are recreated when they are preserved; other
//!   non-regular files are skipped). An existing backup in the way is replaced.
//! - `--safe-links` never preserves an unsafe symlink in the backup area.
//! - The backup directory is an operator-supplied path: it is opened as an
//!   operator-named [`Tree`], so every creation, rename and deletion below it is
//!   confined per 3.5.0 unless `--insecure-links`.
//!
//! [`BackupOutcome`] carries upstream's distinction between "moved away" (1),
//! "duplicated" (2) and "nothing to keep" (3); upstream's failure (0) is `Err`, its
//! diagnostic already printed.

use std::{
	io::{self, Read, Write},
	path::{Path, PathBuf},
	sync::atomic::Ordering,
};

use pi_vfs::{Metadata, NodeKind};

use crate::rsync::{
	time::split_time,
	acl::{self, AclSet},
	consts::{
		ACCESSPERMS, DEL_FOR_BACKUP, DEL_RECURSE, MAXPATHLEN, S_IFMT, mode_is_blk, mode_is_chr,
		mode_is_device,
		mode_is_dir, mode_is_fifo, mode_is_lnk, mode_is_reg, mode_is_sock, mode_is_special,
	},
	delete::{DelResult, Deleter, Place, del_for_flag},
	exit::{RERR_FILEIO, RsyncError},
	filter::{FilterConfig, Filters},
	flist::FileEntry,
	generator::{CAN_HARDLINK_SPECIAL, CAN_HARDLINK_SYMLINK, DestTrees},
	log::{Debug as DebugFlag, Info, LogCode},
	meta::{self, ATTRS_ACCURATE_TIME, AttrHooks},
	paths::{self, bytes_path},
	session::Ctx,
	tree::{Tree, TreeOpts},
	xattr::{self, XattrCtx, XattrSet},
};

/// Default suffix without `--backup-dir` (upstream BACKUP_SUFFIX).
const DEFAULT_SUFFIX: &[u8] = b"~";

/// What [`make_backup`] did (upstream make_backup's non-zero return values).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum BackupOutcome {
	/// The original was renamed into the backup (upstream 1).
	Moved,
	/// The backup is a hard link or copy; the original is still in place (upstream 2).
	Duplicated,
	/// Nothing to keep: the original is missing or a skipped non-regular file (upstream 3).
	Absent,
}

/// make_backup: rename (or copy, for inplace/partial cases) `rel` to its backup name
/// (--backup-dir, --suffix), creating backup-dir parents. `Err` is upstream's failure
/// (0): the diagnostic was already printed and the error carries RERR_FILEIO and no
/// message.
pub(crate) fn make_backup(
	ctx: &Ctx,
	trees: &DestTrees,
	rel: &[u8],
	prefer_rename: bool,
) -> Result<BackupOutcome, RsyncError> {
	let mut deleter = Deleter::new(ctx);
	let filters = Filters::new(FilterConfig::default());
	let outcome = make_backup_with(ctx, trees, &mut deleter, &filters, rel, prefer_rename)
		.map_err(|_| failure())?;
	if let Some(fatal) = deleter.take_fatal() {
		return Err(fatal);
	}
	Ok(outcome)
}

/// The backup name as upstream prints it: `DIR/` + `rel` + suffix with `--backup-dir`,
/// else `rel` + suffix.
pub(crate) fn backup_name(ctx: &Ctx, rel: &[u8]) -> Vec<u8> {
	let mut name = backup_dir_prefix(ctx).unwrap_or_default();
	name.extend_from_slice(rel);
	name.extend_from_slice(&suffix(ctx));
	name
}

/// get_backup_name: the tree the backup of `rel` goes into (the backup-dir tree or the
/// destination) and the backup's path relative to it, with missing backup-dir parents
/// created (and validated) like upstream. `Ok(None)` is upstream's NULL (the error, if
/// any, was printed); `Err` only reports cancellation or a fatal filter error.
pub(crate) fn backup_path(
	ctx: &Ctx,
	trees: &DestTrees,
	rel: &[u8],
) -> Result<Option<(Tree, PathBuf)>, RsyncError> {
	ctx.check_cancel()?;
	let mut deleter = Deleter::new(ctx);
	let filters = Filters::new(FilterConfig::default());
	let found = backup_path_with(ctx, trees, &mut deleter, &filters, rel);
	if let Some(fatal) = deleter.take_fatal() {
		return Err(fatal);
	}
	Ok(found)
}

fn failure() -> RsyncError {
	RsyncError { code: RERR_FILEIO, message: None, site: None }
}

/// The suffix in effect (options finalize it to `~`, or `""` with a backup dir).
fn suffix(ctx: &Ctx) -> Vec<u8> {
	match &ctx.opts.backup_suffix {
		Some(s) => crate::host::os_bytes_lossy(s).into_owned(),
		None if backup_dir_prefix(ctx).is_some() => Vec::new(),
		None => DEFAULT_SUFFIX.to_vec(),
	}
}

/// `--backup-dir` with a trailing `/` (upstream backup_dir_buf), or None.
fn backup_dir_prefix(ctx: &Ctx) -> Option<Vec<u8>> {
	let dir = ctx.opts.backup_dir.as_ref()?;
	let mut bytes: &[u8] = &crate::host::os_bytes_lossy(dir);
	while bytes.starts_with(b"./") {
		bytes = &bytes[2..];
	}
	if bytes == b"." || bytes.is_empty() {
		return None;
	}
	let mut out = bytes.to_vec();
	if out.last() != Some(&b'/') {
		out.push(b'/');
	}
	Some(out)
}

/// Whether `name` ends with the suffix (upstream is_backup_file).
pub(crate) fn is_backup_file(ctx: &Ctx, name: &[u8]) -> bool {
	let suffix = suffix(ctx);
	name.len() > suffix.len() && name.ends_with(&suffix)
}

/// Whether a `--backup-dir` is in effect.
pub(crate) fn has_backup_dir(ctx: &Ctx) -> bool {
	backup_dir_prefix(ctx).is_some()
}

/// The backup-dir tree: the one the generator opened (it existed at start-up), else
/// created on first use like upstream's make_path. Never creates anything in a dry run.
fn backup_tree(ctx: &Ctx, trees: &DestTrees, prefix: &[u8]) -> io::Result<Tree> {
	if let Some(tree) = &trees.backup_dir {
		return Ok(tree.clone());
	}
	let dir = &prefix[..prefix.len() - 1];
	let dir_path = bytes_path(dir)?;
	let create = !ctx.opts.dry_run;
	// The backup dir is an operator path (upstream resolves it with
	// operator_path_resolve): symlinks owned by root or us are followed, even when they
	// lead out of the destination. An absolute one is walked from "/"; a relative one
	// from the destination directory itself, so how the destination was reached does
	// not matter. --insecure-links follows everything by path.
	if paths::is_absolute_bytes(dir) || dir_path.is_absolute() {
		absolute_backup_tree(ctx, ctx.paths.resolve(dir_path), create)
	} else if ctx.opts.insecure_links {
		absolute_backup_tree(ctx, ctx.paths.resolve(trees.dest.root().join(dir_path)), create)
	} else {
		relative_backup_tree(ctx, trees, dir, create)
	}
}

/// The `/`-separated non-empty elements of `bytes`.
fn elements(bytes: &[u8]) -> std::collections::VecDeque<Vec<u8>> {
	bytes.split(|&b| paths::is_separator(b)).filter(|el| !el.is_empty()).map(<[u8]>::to_vec).collect()
}

/// Upstream's operator walk of a relative `--backup-dir`, anchored at the already
/// open destination root: each element is looked at without following; a symlink is
/// followed only when owned by root or us (its target spliced into the rest, an
/// absolute target restarting at "/"), `..` may climb out of the destination, and with
/// `--confine-root` every directory reached must stay below it. Missing directories
/// are created where the walk stops (upstream make_path).
fn relative_backup_tree(ctx: &Ctx, trees: &DestTrees, dir: &[u8], create: bool) -> io::Result<Tree> {
	let confine = ctx.opts.confine_root.as_ref().map(|c| {
		let c = PathBuf::from(c);
		ctx.fs.canonicalize(&c).unwrap_or(c)
	});
	// Physical location, tracked only when it must be measured against the root.
	let mut phys = match &confine {
		Some(_) => Some(ctx.fs.canonicalize(ctx.paths.resolve(trees.dest.root()))?),
		None => None,
	};
	let inside = |phys: &Option<PathBuf>| -> io::Result<()> {
		match (phys, &confine) {
			(Some(p), Some(root)) if !paths::within_confine(p, root) => Err(paths::loop_error()),
			_ => Ok(()),
		}
	};
	let mut stack: Vec<Tree> = vec![trees.dest.clone()];
	let mut remaining = elements(dir);
	let mut hops = 40u32;
	while let Some(comp) = remaining.pop_front() {
		let Some(cur) = stack.last().cloned() else {
			return Err(paths::loop_error());
		};
		match comp.as_slice() {
			b"." => continue,
			b".." => {
				if stack.len() > 1 {
					stack.pop();
				} else {
					// Above the anchor: its physical parent (a symlink-free path).
					let here = ctx.fs.canonicalize(ctx.paths.resolve(cur.root()))?;
					let parent = here.parent().ok_or_else(paths::loop_error)?.to_path_buf();
					stack = vec![Tree::open(&ctx.fs, &parent, &TreeOpts::default())?];
				}
				if let Some(p) = phys.as_mut() {
					p.pop();
				}
				inside(&phys)?;
				continue;
			},
			_ => {},
		}
		let name = bytes_path(&comp)?;
		let st = match cur.lstat(name) {
			Ok(st) => st,
			Err(err) if err.kind() == io::ErrorKind::NotFound => {
				// Everything from here on is created below `cur`.
				let mut rest = name.to_path_buf();
				for el in remaining.iter().filter(|el| el.as_slice() != b".") {
					if el.as_slice() == b".." {
						return Err(io::Error::from(io::ErrorKind::NotFound));
					}
					rest.push(bytes_path(el)?);
				}
				if let Some(p) = phys.as_mut() {
					p.push(&rest);
				}
				inside(&phys)?;
				if create {
					cur.make_path_count(&rest, ACCESSPERMS, false)?;
				}
				return cur.subtree(&rest);
			},
			Err(err) => return Err(err),
		};
		if st.is_symlink() {
			if !st.uid().is_none_or(paths::trusted_owner) || hops == 0 {
				return Err(paths::loop_error());
			}
			hops -= 1;
			let target = cur.read_link(name)?;
			let target_bytes = paths::path_bytes(&target).into_owned();
			if paths::is_absolute_bytes(&target_bytes) || target.is_absolute() {
				let mut abs = target;
				for el in &remaining {
					abs.push(bytes_path(el)?);
				}
				return absolute_backup_tree(ctx, abs, create);
			}
			for el in elements(&target_bytes).into_iter().rev() {
				remaining.push_front(el);
			}
		} else if st.is_dir() {
			stack.push(cur.subtree(name)?);
			if let Some(p) = phys.as_mut() {
				p.push(name);
			}
			inside(&phys)?;
		} else {
			return Err(io::Error::from(io::ErrorKind::NotADirectory));
		}
	}
	stack.pop().ok_or_else(paths::loop_error)
}

/// An absolute backup dir: the deepest existing ancestor is opened as an
/// operator-named tree (ownership walk from "/", `--confine-root`); the rest is
/// created through it.
fn absolute_backup_tree(ctx: &Ctx, host: PathBuf, create: bool) -> io::Result<Tree> {
	let mut base = host.clone();
	let mut missing = Vec::new();
	while !ctx.fs.metadata(&base).is_ok_and(|m| m.is_dir()) {
		let (Some(name), Some(parent)) = (base.file_name().map(ToOwned::to_owned), base.parent())
		else {
			break;
		};
		missing.push(name);
		base = parent.to_path_buf();
	}
	let opts = TreeOpts {
		insecure_links: ctx.opts.insecure_links,
		operator_named: true,
		confine: ctx.opts.confine_root.as_ref().map(PathBuf::from),
	};
	let tree = Tree::open(&ctx.fs, &base, &opts)?;
	if missing.is_empty() {
		return Ok(tree);
	}
	let rest: PathBuf = missing.iter().rev().collect();
	if create {
		tree.make_path_count(&rest, ACCESSPERMS, false)?;
	}
	tree.subtree(&rest)
}

/// get_backup_name with the caller's deletion state (for replacing what is in the way).
pub(crate) fn backup_path_with(
	ctx: &Ctx,
	trees: &DestTrees,
	del: &mut Deleter,
	filters: &Filters,
	rel: &[u8],
) -> Option<(Tree, PathBuf)> {
	let logger = &ctx.logger;
	let suffix = suffix(ctx);
	let mut name = rel.to_vec();
	name.extend_from_slice(&suffix);
	let Some(prefix) = backup_dir_prefix(ctx) else {
		if name.len() >= MAXPATHLEN {
			logger.rprintf(LogCode::Error, b"backup filename too long\n");
			return None;
		}
		return bytes_path(&name).ok().map(|p| (trees.dest.clone(), p.to_path_buf()));
	};
	if prefix.len() + name.len() >= MAXPATHLEN {
		logger.rprintf(LogCode::Error, b"backup filename too long\n");
		return None;
	}
	let tree = backup_tree(ctx, trees, &prefix).ok()?;
	if !ctx.opts.dry_run && !copy_valid_path(ctx, trees, del, filters, &tree, &prefix, rel) {
		return None;
	}
	bytes_path(&name).ok().map(|p| (tree, p.to_path_buf()))
}

/// Makes sure every parent of `rel` exists as a directory below the backup tree,
/// replacing non-directories in the way and giving new directories the attributes of
/// the destination directories they mirror (upstream copy_valid_path).
fn copy_valid_path(
	ctx: &Ctx,
	trees: &DestTrees,
	del: &mut Deleter,
	filters: &Filters,
	tree: &Tree,
	prefix: &[u8],
	rel: &[u8],
) -> bool {
	let ends: Vec<usize> =
		rel.iter().enumerate().filter(|&(i, &b)| b == b'/' && i > 0).map(|(i, _)| i).collect();
	let mut first_missing = None;
	for (k, &end) in ends.iter().enumerate() {
		match validate_backup_dir(ctx, trees, del, filters, tree, prefix, &rel[..end]) {
			Validity::Dir => {},
			Validity::Missing => {
				first_missing = Some(k);
				break;
			},
			Validity::Failed => return false,
		}
	}
	let Some(start) = first_missing else {
		return true;
	};
	let logger = &ctx.logger;
	for &end in &ends[start..] {
		let dir = &rel[..end];
		let Ok(path) = bytes_path(dir) else {
			return false;
		};
		loop {
			match tree.mkdir(&path, ACCESSPERMS) {
				Ok(()) => break,
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists => {
					match validate_backup_dir(ctx, trees, del, filters, tree, prefix, dir) {
						Validity::Dir => break,
						Validity::Missing => {},
						Validity::Failed => return false,
					}
				},
				Err(err) => {
					let text = [&b"backup mkdir "[..], prefix, dir, b" failed"].concat();
					logger.rsyserr(LogCode::Error, &err, &text);
					return false;
				},
			}
		}
		// Carry over the settings of the directory the files come from.
		let local = match source_stat(ctx, &trees.dest, &path) {
			Ok(local) => local,
			Err(err) => {
				let text = [&b"backup stat "[..], &meta::full_fname(&trees.dest, &path), b" failed"].concat();
				logger.rsyserr(LogCode::Error, &err, &text);
				continue;
			},
		};
		let entry = entry_from_meta(dir, &local, None);
		let mut hooks = BackupHooks::read(ctx, &trees.dest, &path, &local, true);
		// set_file_attrs reports its own failures.
		let _ = meta::set_file_attrs_with(tree, &path, &entry, None, &ctx.meta, 0, logger, &mut hooks);
	}
	true
}

enum Validity {
	Dir,
	Missing,
	Failed,
}

/// upstream validate_backup_dir.
fn validate_backup_dir(
	ctx: &Ctx,
	trees: &DestTrees,
	del: &mut Deleter,
	filters: &Filters,
	tree: &Tree,
	prefix: &[u8],
	dir: &[u8],
) -> Validity {
	let Ok(path) = bytes_path(dir) else {
		return Validity::Failed;
	};
	match tree.lstat(&path) {
		Err(err) if err.kind() == io::ErrorKind::NotFound => Validity::Missing,
		Err(err) => {
			let text = [&b"backup lstat "[..], prefix, dir, b" failed"].concat();
			ctx.logger.rsyserr(LogCode::Error, &err, &text);
			Validity::Failed
		},
		Ok(st) if !st.is_dir() => {
			let mode = st.mode();
			let flags = del_for_flag(mode) | DEL_FOR_BACKUP | DEL_RECURSE;
			let place = Place { tree, prefix };
			if del.item(ctx, trees, filters, &place, dir, mode, flags) == DelResult::Deleted {
				Validity::Missing
			} else {
				Validity::Failed
			}
		},
		Ok(_) => Validity::Dir,
	}
}

/// make_backup with the caller's deletion state. `Err` is upstream's failure (0),
/// carrying the error behind it when there is one.
pub(crate) fn make_backup_with(
	ctx: &Ctx,
	trees: &DestTrees,
	del: &mut Deleter,
	filters: &Filters,
	rel: &[u8],
	prefer_rename: bool,
) -> Result<BackupOutcome, Option<io::Error>> {
	let logger = &ctx.logger;
	let dest = &trees.dest;
	let path = bytes_path(rel).map_err(Some)?;
	let Ok(st) = source_lstat(ctx, dest, &path) else {
		return Ok(BackupOutcome::Absent);
	};
	let shown = backup_name(ctx, rel);
	let mode = st.mode();
	let opts = &ctx.opts;

	if opts.dry_run {
		// Nothing is touched; report what the real run would do.
		if shown.len() >= MAXPATHLEN {
			logger.rprintf(LogCode::Error, b"backup filename too long\n");
			return Err(None);
		}
		if skips_unsafe_link(ctx, dest, &path, rel, mode) {
			return Ok(success(ctx, rel, &shown, BackupOutcome::Duplicated));
		}
		let outcome = if prefer_rename {
			debug_backup(ctx, b"RENAME", rel);
			BackupOutcome::Moved
		} else {
			let can_link = !(mode_is_lnk(mode) && !CAN_HARDLINK_SYMLINK)
				&& !((mode_is_special(mode) || mode_is_device(mode)) && !CAN_HARDLINK_SPECIAL);
			let how: &[u8] = if can_link { b"HLINK" } else { b"COPY" };
			debug_backup(ctx, how, rel);
			BackupOutcome::Duplicated
		};
		return Ok(success(ctx, rel, &shown, outcome));
	}

	let Some((tree, bpath)) = backup_path_with(ctx, trees, del, filters, rel) else {
		return Err(None);
	};
	if skips_unsafe_link(ctx, dest, &path, rel, mode) {
		return Ok(success(ctx, rel, &shown, BackupOutcome::Duplicated));
	}

	let mut attempt = link_or_rename(ctx, dest, &path, &tree, &bpath, prefer_rename, &st, rel);
	if let Some(done) = attempt.done {
		return Ok(success(ctx, rel, &shown, done));
	}
	if attempt.err.as_ref().is_some_and(|e| is_exists(e) || is_isdir(e)) {
		if let Ok(bst) = tree.lstat(&bpath) {
			let bmode = bst.mode();
			let flags = del_for_flag(bmode) | DEL_FOR_BACKUP | DEL_RECURSE;
			let bname = paths::path_bytes(&bpath).into_owned();
			let prefix = backup_dir_prefix(ctx).unwrap_or_default();
			let place = Place { tree: &tree, prefix: &prefix };
			if del.item(ctx, trees, filters, &place, &bname, bmode, flags) != DelResult::Deleted {
				return Err(None);
			}
		}
		attempt = link_or_rename(ctx, dest, &path, &tree, &bpath, prefer_rename, &st, rel);
		if let Some(done) = attempt.done {
			return Ok(success(ctx, rel, &shown, done));
		}
	}

	duplicate(ctx, dest, path, &st, &tree, &bpath, rel, &shown)
}

/// upstream make_backup_inner's copy fallback: recreates `path` (whose metadata is `st`)
/// at `bpath` in `tree` — a device/special node (a 0600 placeholder under
/// `--fake-super`), a symlink, or a data copy — then copies the attributes over.
#[allow(clippy::too_many_arguments, reason = "source and backup locations plus names")]
fn duplicate(
	ctx: &Ctx,
	dest: &Tree,
	path: &Path,
	st: &Metadata,
	tree: &Tree,
	bpath: &Path,
	rel: &[u8],
	shown: &[u8],
) -> Result<BackupOutcome, Option<io::Error>> {
	let logger = &ctx.logger;
	let opts = &ctx.opts;
	let mode = st.mode();
	let link = if mode_is_lnk(mode) {
		match dest.read_link(path) {
			Ok(t) => Some(paths::path_bytes(&t).into_owned()),
			Err(_) => return Ok(BackupOutcome::Absent),
		}
	} else {
		None
	};
	let entry = entry_from_meta(rel, st, link.as_deref());
	let mut hooks = BackupHooks::read(ctx, dest, path, st, false);
	let mut done = None;

	// Upstream's am_root is non-zero for root, --super and --fake-super (-1).
	let fake_super = opts.am_root < 0 || ctx.meta.fake_super;
	let root_like = ctx.am_root || opts.am_root != 0 || fake_super;
	if (root_like && opts.preserve_devices && mode_is_device(mode))
		|| (opts.preserve_specials && mode_is_special(mode))
	{
		let made = if fake_super {
			// --fake-super keeps a special file as an inert 0600 placeholder; the
			// stat xattr written by set_file_attrs below records the real type.
			tree.open_write(bpath, true, true).map(drop)
		} else {
			tree.mknod(bpath, node_kind(mode, st.rdev().unwrap_or(0)), mode)
		};
		match made {
			Err(err) => {
				let text = [&b"mknod "[..], &meta::full_fname(tree, bpath), b" failed"].concat();
				logger.rsyserr(LogCode::Error, &err, &text);
			},
			Ok(()) => debug_backup(ctx, b"DEVICE", rel),
		}
		done = Some(BackupOutcome::Duplicated);
	}

	if done.is_none()
		&& opts.preserve_links
		&& let Some(target) = &link
	{
		if opts.safe_symlinks && paths::unsafe_symlink(target, rel) {
			if logger.levels().info(Info::Symsafe) >= 1 {
				let text = [&b"not backing up unsafe symlink \""[..], rel, b"\" -> \"", target, b"\"\n"].concat();
				logger.rprintf(LogCode::Info, &text);
			}
		} else {
			match bytes_path(target).and_then(|t| tree.symlink(t, bpath)) {
				Err(err) => {
					let full = meta::full_fname(tree, bpath);
					let text = [&b"link "[..], &full, b" -> \"", target, b"\""].concat();
					logger.rsyserr(LogCode::Error, &err, &text);
				},
				Ok(()) => debug_backup(ctx, b"SYMLINK", rel),
			}
		}
		done = Some(BackupOutcome::Duplicated);
	}

	if done.is_none() && !mode_is_reg(mode) {
		if logger.levels().info(Info::Nonreg) >= 1 {
			logger.rprintf(LogCode::Info, &[&b"make_bak: skipping non-regular file "[..], rel, b"\n"].concat());
		}
		return Ok(BackupOutcome::Absent);
	}

	if done.is_none() {
		if let Err(err) = copy_file(ctx, dest, path, tree, bpath, mode) {
			let text = [&b"keep_backup failed: "[..], &meta::full_fname(dest, path), b" -> \"", shown, b"\""].concat();
			logger.rsyserr(LogCode::Error, &err, &text);
			return Err(Some(err));
		}
		debug_backup(ctx, b"COPY", rel);
	}

	// The copy keeps the original's attributes (xattrs are not re-applied, like upstream).
	hooks.xattr = None;
	let mut opts_noxattr = ctx.meta.clone();
	opts_noxattr.xattrs = false;
	// set_file_attrs reports its own failures.
	let _ = meta::set_file_attrs_with(
		tree,
		bpath,
		&entry,
		None,
		&opts_noxattr,
		ATTRS_ACCURATE_TIME,
		logger,
		&mut hooks,
	);
	Ok(success(ctx, rel, shown, BackupOutcome::Duplicated))
}

/// `--safe-links` with `-l`: an unsafe (or unreadable) symlink is not backed up; the
/// caller reports it as duplicated so a deletion proceeds.
fn skips_unsafe_link(ctx: &Ctx, dest: &Tree, path: &Path, rel: &[u8], mode: u32) -> bool {
	let opts = &ctx.opts;
	if !(opts.preserve_links && mode_is_lnk(mode) && opts.safe_symlinks) {
		return false;
	}
	let logger = &ctx.logger;
	let target = dest.read_link(path).ok().map(|t| paths::path_bytes(&t).into_owned());
	match target.filter(|t| !t.is_empty()) {
		None => {
			if logger.levels().info(Info::Symsafe) >= 1 {
				let text = [&b"not backing up symlink with unreadable target \""[..], rel, b"\"\n"].concat();
				logger.rprintf(LogCode::Info, &text);
			}
			true
		},
		Some(target) if paths::unsafe_symlink(&target, rel) => {
			if logger.levels().info(Info::Symsafe) >= 1 {
				let text = [&b"not backing up unsafe symlink \""[..], rel, b"\" -> \"", &target, b"\"\n"].concat();
				logger.rprintf(LogCode::Info, &text);
			}
			true
		},
		Some(_) => false,
	}
}

/// What one hard-link-or-rename attempt did.
struct Attempt {
	done: Option<BackupOutcome>,
	err: Option<io::Error>,
}

/// upstream link_or_rename.
#[allow(clippy::too_many_arguments, reason = "both trees and both paths are needed")]
fn link_or_rename(
	ctx: &Ctx,
	dest: &Tree,
	path: &Path,
	tree: &Tree,
	bpath: &Path,
	prefer_rename: bool,
	st: &Metadata,
	rel: &[u8],
) -> Attempt {
	let mode = st.mode();
	if !prefer_rename {
		if mode_is_lnk(mode) && !CAN_HARDLINK_SYMLINK {
			return Attempt { done: None, err: None };
		}
		if (mode_is_special(mode) || mode_is_device(mode)) && !CAN_HARDLINK_SPECIAL {
			return Attempt { done: None, err: None };
		}
		match tree.hard_link((dest, path), bpath) {
			Ok(()) => {
				debug_backup(ctx, b"HLINK", rel);
				return Attempt { done: Some(BackupOutcome::Duplicated), err: None };
			},
			Err(err) => {
				// A regular file is renamed rather than copied.
				if !mode_is_reg(mode) || is_exists(&err) || is_isdir(&err) {
					return Attempt { done: None, err: Some(err) };
				}
			},
		}
	}
	match tree.rename((dest, path), bpath) {
		Ok(()) => {
			if st.nlink().is_some_and(|n| n > 1) && !mode_is_dir(mode) {
				// A file already hard-linked into the backup area makes rename a no-op.
				let _ = dest.unlink(path);
			}
			debug_backup(ctx, b"RENAME", rel);
			Attempt { done: Some(BackupOutcome::Moved), err: None }
		},
		Err(err) => Attempt { done: None, err: Some(err) },
	}
}

fn success(ctx: &Ctx, rel: &[u8], shown: &[u8], outcome: BackupOutcome) -> BackupOutcome {
	if ctx.logger.levels().info(Info::Backup) >= 1 {
		ctx.logger.rprintf(LogCode::Info, &[&b"backed up "[..], rel, b" to ", shown, b"\n"].concat());
	}
	outcome
}

fn debug_backup(ctx: &Ctx, how: &[u8], rel: &[u8]) {
	if ctx.logger.levels().debug(DebugFlag::Backup) >= 1 {
		let text = [&b"make_backup: "[..], how, b" ", rel, b" successful.\n"].concat();
		ctx.logger.rprintf(LogCode::Info, &text);
	}
}

/// upstream copy_file: replaces `to` with a copy of `from`'s data, created with the
/// original's permissions less the umask.
fn copy_file(ctx: &Ctx, from_tree: &Tree, from: &Path, tree: &Tree, to: &Path, mode: u32) -> io::Result<()> {
	let mut src = from_tree.open_read(from, false)?;
	match tree.unlink(to) {
		Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(err),
		_ => {},
	}
	let mut dst = tree.open_write(to, true, true)?;
	let mut buf = vec![0u8; 256 * 1024];
	loop {
		if ctx.cancel.load(Ordering::Relaxed) {
			return Err(RsyncError::cancelled_io());
		}
		let n = match src.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => n,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(err) => return Err(err),
		};
		dst.write_all(&buf[..n])?;
	}
	dst.flush()?;
	drop(dst);
	tree.chmod(to, mode & 0o777 & !ctx.umask)
}

/// The original's metadata as upstream's `x_lstat` sees it (no `-L`; fake-super applied).
fn source_lstat(ctx: &Ctx, tree: &Tree, path: &Path) -> io::Result<Metadata> {
	let mut opts = ctx.meta.clone();
	opts.copy_links = false;
	meta::x_lstat(tree, path, &opts, &ctx.logger)
}

/// A destination directory's metadata for copying onto a new backup directory
/// (upstream make_file's link_stat: follows with `-L`).
fn source_stat(ctx: &Ctx, tree: &Tree, path: &Path) -> io::Result<Metadata> {
	meta::x_lstat(tree, path, &ctx.meta, &ctx.logger)
}

fn node_kind(mode: u32, rdev: u64) -> NodeKind {
	if mode_is_chr(mode) {
		NodeKind::CharDevice(rdev)
	} else if mode_is_blk(mode) {
		NodeKind::BlockDevice(rdev)
	} else if mode_is_fifo(mode) {
		NodeKind::Fifo
	} else if mode_is_sock(mode) {
		NodeKind::Socket
	} else {
		NodeKind::Regular
	}
}

/// A file-list entry describing a local item (upstream make_file with NO_FILTERS).
fn entry_from_meta(rel: &[u8], st: &Metadata, link: Option<&[u8]>) -> FileEntry {
	let (dirname, basename) = paths::split_name(rel);
	let (mtime, mtime_nsec) = st.modified().map_or((0, 0), split_time);
	let (atime, _) = st.accessed().map_or((0, 0), split_time);
	let (crtime, _) = st.created().map_or((0, 0), split_time);
	FileEntry {
		dirname: dirname.into(),
		basename: basename.into(),
		mode: st.mode(),
		size: st.len(),
		mtime,
		mtime_nsec,
		atime,
		crtime,
		uid: st.uid().unwrap_or(0),
		gid: st.gid().unwrap_or(0),
		link: link.map(Into::into),
		..FileEntry::default()
	}
}

/// ACLs (and, for directories, xattrs) read from the original and applied to the backup
/// by set_file_attrs (upstream cache_tmp_acl / cache_tmp_xattr).
struct BackupHooks<'a> {
	ctx: &'a Ctx,
	acl: Option<AclSet>,
	xattr: Option<XattrSet>,
}

impl<'a> BackupHooks<'a> {
	fn read(ctx: &'a Ctx, tree: &Tree, path: &Path, st: &Metadata, with_xattrs: bool) -> Self {
		let mode = st.mode();
		let acl = (ctx.meta.acls && !mode_is_lnk(mode))
			.then(|| acl::read_local_with(tree, path, mode, ctx.acl_opts, Some(&ctx.logger)).ok())
			.flatten();
		let xattr = (ctx.meta.xattrs && with_xattrs)
			.then(|| {
				let xctx = XattrCtx { logger: Some(&ctx.logger), local_mode: Some(mode), ..XattrCtx::default() };
				xattr::read_local_with(tree, path, Some(mode), false, ctx.xattr_opts, xctx).ok()
			})
			.flatten();
		Self { ctx, acl, xattr }
	}
}

impl AttrHooks for BackupHooks<'_> {
	fn apply_xattrs(&mut self, tree: &Tree, rel: &Path, _entry: &FileEntry) {
		if let Some(set) = &self.xattr {
			let xctx = XattrCtx { logger: Some(&self.ctx.logger), ..XattrCtx::default() };
			// Failures are reported through the logger.
			let _ = xattr::apply_with(tree, rel, set, false, self.ctx.xattr_opts, xctx);
		}
	}

	fn apply_acls(
		&mut self,
		tree: &Tree,
		rel: &Path,
		entry: &FileEntry,
		new_mode: u32,
		cur_mode: &mut u32,
	) -> bool {
		let Some(wanted) = &self.acl else {
			return false;
		};
		let type_bits = entry.mode & S_IFMT;
		let logger = Some(&self.ctx.logger);
		let Ok(local) = acl::read_local_with(tree, rel, type_bits | *cur_mode, self.ctx.acl_opts, logger)
		else {
			return false;
		};
		match acl::apply_with(tree, rel, wanted, &local, *cur_mode, new_mode, self.ctx.acl_opts, logger) {
			Ok(applied) => {
				*cur_mode = applied.mode;
				applied.changed
			},
			Err(_) => false,
		}
	}
}

fn is_exists(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::AlreadyExists
}

fn is_isdir(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::IsADirectory
}

#[cfg(all(test, unix))]
mod tests {
	use std::{
		ffi::OsString,
		path::Path,
	};

	use super::*;
	use crate::rsync::{
		delete::test_support::*,
		options::Options,
	};

	/// Destination of the backup reference fixture.
	fn fixture(dst: &Path) {
		put(dst, "a", "old");
		put(dst, "extra", "x");
		put(dst, "extra~", "pre");
		link(dst, "lnk", "tgt");
		put(dst, "sub/yy", "y");
		put(dst, "sub/inner/ii", "i");
		put(dst, "sub/s", "s");
	}

	fn backup_opts(dir: Option<&str>, suffix: &str) -> Options {
		Options {
			delete_mode: true,
			delete_during: 1,
			recurse: 2,
			do_xfers: true,
			make_backups: true,
			backup_dir: dir.map(OsString::from),
			backup_suffix: Some(OsString::from(suffix)),
			..Options::default()
		}
	}

	const OUT: Out = Out { verbose: 1, info: Some("backup"), format: Some(b"%n%L"), itemize: 0 };

	/// `rsync -r --delete -v --info=backup <opts> src/ dst/` minus the transfer of `a`.
	fn run(dst: &Path, opts: Options, rules: &[&[u8]]) -> String {
		let (ctx, trees, sink) = setup(dst, opts, &OUT);
		let mut filters = filters(&ctx, dst, rules, false);
		let flists = flists(&ctx, &[("a", REG), ("sub", DIR), ("sub/s", REG)]);
		let mut del = Deleter::new(&ctx);
		del.full_pass(&ctx, &trees, &flists, &mut filters).unwrap();
		sink.text()
	}

	#[test]
	fn default_suffix_backups_match_reference() {
		let dir = tempfile::tempdir().unwrap();
		fixture(dir.path());
		// Options add "P *~" for -b with --delete (no --backup-dir).
		let out = run(dir.path(), backup_opts(None, "~"), &[b"P *~"]);
		assert_eq!(
			out,
			"backed up lnk to lnk~\ndeleting lnk\nbacked up extra to extra~\ndeleting extra\n\
			 backed up sub/inner/ii to sub/inner/ii~\ndeleting sub/inner/ii\n\
			 cannot delete non-empty directory: sub/inner\n\
			 backed up sub/yy to sub/yy~\ndeleting sub/yy\n"
		);
		assert_eq!(
			listing(dir.path()),
			[
				"a: old", "extra~: x", "lnk~ -> tgt", "sub/", "sub/inner/", "sub/inner/ii~: i",
				"sub/s: s", "sub/yy~: y",
			]
		);
	}

	#[test]
	fn custom_suffix_backs_up_old_backups_too() {
		let dir = tempfile::tempdir().unwrap();
		fixture(dir.path());
		let out = run(dir.path(), backup_opts(None, ".bak"), &[b"P *.bak"]);
		assert_eq!(
			out,
			"backed up lnk to lnk.bak\ndeleting lnk\nbacked up extra~ to extra~.bak\n\
			 deleting extra~\nbacked up extra to extra.bak\ndeleting extra\n\
			 backed up sub/inner/ii to sub/inner/ii.bak\ndeleting sub/inner/ii\n\
			 cannot delete non-empty directory: sub/inner\n\
			 backed up sub/yy to sub/yy.bak\ndeleting sub/yy\n"
		);
		assert_eq!(
			listing(dir.path()),
			[
				"a: old", "extra.bak: x", "extra~.bak: pre", "lnk.bak -> tgt", "sub/", "sub/inner/",
				"sub/inner/ii.bak: i", "sub/s: s", "sub/yy.bak: y",
			]
		);
	}

	#[test]
	fn backup_dir_recreates_structure_like_reference() {
		for (suffix, tail) in [("", ""), (".old", ".old")] {
			let dir = tempfile::tempdir().unwrap();
			fixture(dir.path());
			let out = run(dir.path(), backup_opts(Some("bk"), suffix), &[]);
			assert_eq!(
				out,
				format!(
					"backed up lnk to bk/lnk{tail}\ndeleting lnk\n\
					 backed up extra~ to bk/extra~{tail}\ndeleting extra~\n\
					 backed up extra to bk/extra{tail}\ndeleting extra\n\
					 backed up sub/inner/ii to bk/sub/inner/ii{tail}\ndeleting sub/inner/ii\n\
					 deleting sub/inner/\n\
					 backed up sub/yy to bk/sub/yy{tail}\ndeleting sub/yy\n"
				)
			);
			let expected: Vec<String> = [
				"a: old".to_owned(),
				"bk/".to_owned(),
				format!("bk/extra{tail}: x"),
				format!("bk/extra~{tail}: pre"),
				format!("bk/lnk{tail} -> tgt"),
				"bk/sub/".to_owned(),
				"bk/sub/inner/".to_owned(),
				format!("bk/sub/inner/ii{tail}: i"),
				format!("bk/sub/yy{tail}: y"),
				"sub/".to_owned(),
				"sub/s: s".to_owned(),
			]
			.into();
			let mut got = listing(dir.path());
			got.sort();
			let mut want = expected;
			want.sort();
			assert_eq!(got, want);
		}
	}

	#[test]
	fn absolute_backup_dir_outside_destination() {
		let dir = tempfile::tempdir().unwrap();
		let bk = tempfile::tempdir().unwrap();
		let bk_dir = bk.path().join("new/deeper");
		fixture(dir.path());
		let shown = bk_dir.to_string_lossy().into_owned();
		let out = run(dir.path(), backup_opts(Some(&shown), ""), &[]);
		assert!(out.starts_with(&format!("backed up lnk to {shown}/lnk\ndeleting lnk\n")), "{out}");
		assert_eq!(
			listing(&bk_dir),
			["extra: x", "extra~: pre", "lnk -> tgt", "sub/", "sub/inner/", "sub/inner/ii: i", "sub/yy: y"]
		);
		assert_eq!(listing(dir.path()), ["a: old", "sub/", "sub/s: s"]);
	}

	#[test]
	fn keeping_the_original_hard_links_and_replaces_old_backup() {
		let dir = tempfile::tempdir().unwrap();
		put(dir.path(), "a", "old");
		put(dir.path(), "a~/inner", "stale");
		let (ctx, trees, _) = setup(dir.path(), backup_opts(None, "~"), &OUT);
		let outcome = make_backup(&ctx, &trees, b"a", false).unwrap();
		assert_eq!(outcome, BackupOutcome::Duplicated);
		assert_eq!(listing(dir.path()), ["a: old", "a~: old"]);
		let a = std::fs::metadata(dir.path().join("a")).unwrap();
		let b = std::fs::metadata(dir.path().join("a~")).unwrap();
		assert_eq!(std::os::unix::fs::MetadataExt::ino(&a), std::os::unix::fs::MetadataExt::ino(&b));

		assert_eq!(make_backup(&ctx, &trees, b"missing", true).unwrap(), BackupOutcome::Absent);
		assert_eq!(make_backup(&ctx, &trees, b"a", true).unwrap(), BackupOutcome::Moved);
		assert_eq!(listing(dir.path()), ["a~: old"]);
	}

	#[test]
	fn backup_names_and_paths() {
		let dir = tempfile::tempdir().unwrap();
		put(dir.path(), "d/f", "f");
		let (ctx, trees, _) = setup(dir.path(), backup_opts(Some("./bk"), ""), &OUT);
		assert_eq!(backup_name(&ctx, b"d/f"), b"bk/d/f");
		let (tree, path) = backup_path(&ctx, &trees, b"d/f").unwrap().unwrap();
		assert_eq!(path, Path::new("d/f"));
		assert!(tree.lstat(Path::new("d")).unwrap().is_dir(), "parents are created");
		assert!(dir.path().join("bk/d").is_dir());

		let (ctx, _, _) = setup(dir.path(), backup_opts(None, "~"), &OUT);
		assert_eq!(backup_name(&ctx, b"d/f"), b"d/f~");
		assert!(is_backup_file(&ctx, b"d/f~"));
		assert!(!is_backup_file(&ctx, b"~"));
	}

	#[test]
	fn dry_run_reports_without_touching() {
		let dir = tempfile::tempdir().unwrap();
		fixture(dir.path());
		let before = listing(dir.path());
		let opts = Options { dry_run: true, do_xfers: false, ..backup_opts(Some("bk"), "") };
		let out = run(dir.path(), opts, &[]);
		assert!(out.starts_with("backed up lnk to bk/lnk\ndeleting lnk\n"), "{out}");
		assert_eq!(listing(dir.path()), before);
	}

	/// B16: `rsync -a --backup --backup-dir=opd/sub src/ dest/` where `dest/opd` is the
	/// operator's own symlink to a directory outside the destination: upstream follows
	/// it (exit 0) and the old file lands in `outside/sub/f0`.
	#[test]
	fn relative_backup_dir_through_own_symlink() {
		let base = tempfile::tempdir().unwrap();
		let dest = base.path().join("dest");
		let outside = base.path().join("outside");
		std::fs::create_dir_all(&outside).unwrap();
		put(&dest, "f0", "OLD");
		link(&dest, "opd", outside.to_str().unwrap());
		let (ctx, trees, _) = setup(&dest, backup_opts(Some("opd/sub"), ""), &OUT);

		let (tree, path) = backup_path(&ctx, &trees, b"f0").unwrap().expect("backup dir accepted");
		assert_eq!(path, Path::new("f0"));
		assert!(tree.lstat(Path::new(".")).unwrap().is_dir());

		assert_eq!(make_backup(&ctx, &trees, b"f0", false).unwrap(), BackupOutcome::Duplicated);
		assert_eq!(std::fs::read_to_string(outside.join("sub/f0")).unwrap(), "OLD");
		assert_eq!(std::fs::read_to_string(dest.join("f0")).unwrap(), "OLD");
	}

	/// The relative walk starts at the destination itself: `..` may leave it (an
	/// operator path), relative symlinks are spliced, and `--confine-root` bounds it.
	#[test]
	fn relative_backup_dir_walk_is_anchored_at_destination() {
		let base = tempfile::tempdir().unwrap();
		let base = std::fs::canonicalize(base.path()).unwrap();
		let dest = base.join("dest");
		put(&dest, "f0", "OLD");
		std::fs::create_dir_all(dest.join("real")).unwrap();
		link(&dest, "rel", "real");

		let (ctx, trees, _) = setup(&dest, backup_opts(Some("../outside/sub"), ""), &OUT);
		assert!(backup_path(&ctx, &trees, b"f0").unwrap().is_some());
		assert!(base.join("outside/sub").is_dir(), "`..` climbs out of the destination");

		let (ctx, trees, _) = setup(&dest, backup_opts(Some("rel/deep"), ""), &OUT);
		assert!(backup_path(&ctx, &trees, b"f0").unwrap().is_some());
		assert!(dest.join("real/deep").is_dir(), "relative symlink target spliced");

		let confined = Options {
			confine_root: Some(dest.clone().into_os_string()),
			..backup_opts(Some("../escape"), "")
		};
		let (ctx, trees, _) = setup(&dest, confined, &OUT);
		assert!(backup_path(&ctx, &trees, b"f0").unwrap().is_none());
		assert!(!base.join("escape").exists(), "nothing created outside --confine-root");

		// As root, symlinks owned by another user are untrusted: one on the way to the
		// destination does not matter (upstream starts at the destination), one inside
		// the backup path is refused.
		if crate::rsync::ids::effective_uid() != Some(0) {
			return;
		}
		link(&base, "via", dest.to_str().unwrap());
		std::os::unix::fs::lchown(base.join("via"), Some(1), Some(1)).unwrap();
		let (ctx, trees, _) = setup(&base.join("via"), backup_opts(Some("bk"), ""), &OUT);
		assert!(backup_path(&ctx, &trees, b"f0").unwrap().is_some());
		assert!(dest.join("bk").is_dir());

		link(&dest, "foreign", base.to_str().unwrap());
		std::os::unix::fs::lchown(dest.join("foreign"), Some(1), Some(1)).unwrap();
		let (ctx, trees, _) = setup(&dest, backup_opts(Some("foreign/sub"), ""), &OUT);
		assert!(backup_path(&ctx, &trees, b"f0").unwrap().is_none());
		assert!(!base.join("sub").exists());
	}

	/// B11: under `--fake-super` a special file is a regular placeholder plus the
	/// stat xattr; its backup copy must be another inert 0600 placeholder (upstream
	/// do_mknod with am_root < 0), never a live FIFO.
	#[test]
	fn fake_super_special_backup_is_a_placeholder() {
		let dir = tempfile::tempdir().unwrap();
		put(dir.path(), "victim", "");
		let opts = Options { am_root: -1, preserve_specials: true, ..backup_opts(None, "~") };
		let (mut ctx, trees, _) = setup(dir.path(), opts, &OUT);
		ctx.meta.fake_super = true;
		let fifo = meta::FakeStat { mode: 0o010600, rdev_major: 0, rdev_minor: 0, uid: 0, gid: 0 };
		let xstat = std::ffi::OsStr::new(meta::XSTAT_ATTR);
		if trees.dest.set_xattr(Path::new("victim"), xstat, &fifo.encode(), false).is_err() {
			// No xattr support on this file system: nothing to represent.
			return;
		}
		let st = source_lstat(&ctx, &trees.dest, Path::new("victim")).unwrap();
		assert!(mode_is_fifo(st.mode()), "the stat xattr is overlaid");

		let outcome =
			duplicate(&ctx, &trees.dest, Path::new("victim"), &st, &trees.dest, Path::new("victim~"), b"victim", b"victim~")
				.unwrap();
		assert_eq!(outcome, BackupOutcome::Duplicated);
		let real = std::fs::symlink_metadata(dir.path().join("victim~")).unwrap();
		assert!(real.file_type().is_file(), "placeholder, not a FIFO");
		let raw = trees.dest.get_xattr(Path::new("victim~"), xstat, false).unwrap().expect("stat record");
		let stat = meta::FakeStat::decode(&raw).expect("valid stat record");
		assert_eq!(stat.mode & 0o170000, 0o010000);
		let overlaid = source_lstat(&ctx, &trees.dest, Path::new("victim~")).unwrap();
		assert!(mode_is_fifo(overlaid.mode()), "x_lstat sees the FIFO again");

		// Without --fake-super the special file itself is recreated.
		let plain = tempfile::tempdir().unwrap();
		let opts = Options { preserve_specials: true, ..backup_opts(None, "~") };
		let (ctx, trees, _) = setup(plain.path(), opts, &OUT);
		nix::unistd::mkfifo(&plain.path().join("p"), nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
		let st = source_lstat(&ctx, &trees.dest, Path::new("p")).unwrap();
		duplicate(&ctx, &trees.dest, Path::new("p"), &st, &trees.dest, Path::new("p~"), b"p", b"p~").unwrap();
		let real = std::fs::symlink_metadata(plain.path().join("p~")).unwrap();
		assert!(std::os::unix::fs::FileTypeExt::is_fifo(&real.file_type()));
	}
}
