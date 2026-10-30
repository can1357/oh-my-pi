//! Local attribute handling: destination permissions (`dest_mode`), mtime
//! comparison (`--modify-window`), applying owner/group/perms/times to a
//! transferred entry (`set_file_attrs`), the attribute part of itemizing, and
//! the `--fake-super` stat xattr.
//!
//! Every filesystem access goes through [`Tree`]. Failures are reported through
//! the [`Logger`] at [`LogCode::ErrorXfer`] with upstream's wording; the logger
//! records those so the run ends with `RERR_PARTIAL` (23).

use std::{
	ffi::OsStr,
	io,
	path::Path,
	time::{SystemTime, UNIX_EPOCH},
};

use pi_vfs::{FileTime, FileType, Metadata, Permissions};

use crate::rsync::{
	time::system_time,
	consts::{
		ACCESSPERMS, CHMOD_BITS, FLAG_DIR_CREATED, FLAG_SKIP_GROUP, FLAG_TIME_FAILED,
		ITEM_LOCAL_CHANGE, ITEM_MATCHED, S_IFMT, S_ISGID, S_ISUID,
		ITEM_REPORT_ACL, ITEM_REPORT_ATIME, ITEM_REPORT_CHANGE, ITEM_REPORT_CRTIME,
		ITEM_REPORT_GROUP, ITEM_REPORT_OWNER, ITEM_REPORT_PERMS, ITEM_REPORT_SIZE,
		ITEM_REPORT_TIME, ITEM_REPORT_TIMEFAIL, ITEM_TRANSFER, ITEM_XNAME_FOLLOWS, mode_is_device,
		mode_is_dir, mode_is_lnk, mode_is_reg, mode_is_special,
	},
	exit::{RERR_FILEIO, RsyncError},
	flist::FileEntry,
	log::{self, LogCode, Logger},
	tree::Tree,
};

/// `set_file_attrs` flag: print the `--info=name2` "uptodate" line.
pub(crate) const ATTRS_REPORT: u32 = 1 << 0;
/// `set_file_attrs` flag: leave the modification time alone.
pub(crate) const ATTRS_SKIP_MTIME: u32 = 1 << 1;
/// `set_file_attrs` flag: compare times exactly (ignore `--modify-window`).
pub(crate) const ATTRS_ACCURATE_TIME: u32 = 1 << 2;
/// `set_file_attrs` flag: leave the access time alone.
pub(crate) const ATTRS_SKIP_ATIME: u32 = 1 << 3;
/// `set_file_attrs` flag: leave the creation time alone.
pub(crate) const ATTRS_SKIP_CRTIME: u32 = 1 << 5;

/// Name of the `--fake-super` stat xattr (upstream `XSTAT_ATTR`): Linux keeps it in
/// the `user.` namespace, platforms without xattr namespaces use the bare name.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub(crate) const XSTAT_ATTR: &str = "user.rsync.%stat";
/// Name of the `--fake-super` stat xattr (upstream `XSTAT_ATTR`).
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub(crate) const XSTAT_ATTR: &str = "rsync.%stat";

/// The stat xattr is read into a 256-byte buffer upstream; longer values fail with ERANGE.
const XSTAT_MAX: usize = 255;

/// Attribute-preservation options.
#[derive(Clone, Debug, Default)]
pub(crate) struct MetaOpts {
	/// `-p`.
	pub perms: bool,
	/// `-E`.
	pub executability: bool,
	/// `-o`.
	pub owner: bool,
	/// `-g`.
	pub group: bool,
	/// Running as root, or `--super`: ownership may be changed.
	pub am_root: bool,
	/// `--fake-super`: ownership, special bits, and device numbers live in [`XSTAT_ATTR`].
	pub fake_super: bool,
	/// `-t`.
	pub times: bool,
	/// `-O`.
	pub omit_dir_times: bool,
	/// `-J`, or symlink times are known to be unsettable.
	pub omit_link_times: bool,
	/// `-U`.
	pub atimes: bool,
	/// `-N`.
	pub crtimes: bool,
	/// `--modify-window` (negative: compare nanoseconds too).
	pub modify_window: i64,
	/// `-A`.
	pub acls: bool,
	/// `-X`.
	pub xattrs: bool,
	/// `-n`.
	pub dry_run: bool,
	/// `-L`: entries are statted through symlinks.
	pub copy_links: bool,
	/// `-K`: a symlink to a directory counts as the directory when re-statting.
	pub keep_dirlinks: bool,
}

impl MetaOpts {
	/// Whether ownership differences count (root, `--super`, or `--fake-super`).
	fn root_like(&self) -> bool {
		self.am_root || self.fake_super
	}
}

/// Upstream dest_mode: permissions for a destination given the sender's mode and
/// what exists.
///
/// With `-p` the sender's mode stands. Otherwise an existing entry keeps its
/// permissions (with `-E` adjusting execute bits of regular files), and a new one
/// gets the sender's mode limited to `dflt_perms` (the parent directory's default
/// ACL when `-A` is compiled in, else `0777 & ~umask`).
pub(crate) fn dest_mode_with(
	flist_mode: u32,
	existing_mode: Option<u32>,
	exists: bool,
	dflt_perms: u32,
	opts: &MetaOpts,
) -> u32 {
	if opts.perms {
		return flist_mode;
	}
	let Some(stat_mode) = existing_mode.filter(|_| exists) else {
		// New entry: default permissions, special bits dropped.
		return flist_mode & (!CHMOD_BITS | dflt_perms);
	};
	let mut mode = (flist_mode & !CHMOD_BITS) | (stat_mode & CHMOD_BITS);
	if opts.executability && mode_is_reg(flist_mode) {
		if flist_mode & 0o111 == 0 {
			mode &= !0o111;
		} else if stat_mode & 0o111 == 0 {
			// Executable for everyone who may read, only if not executable at all yet.
			mode |= (mode & 0o444) >> 2;
		}
	}
	mode
}

/// Time equality under `--modify-window`: `0` compares seconds, a negative
/// window compares seconds and nanoseconds, a positive one allows that many
/// seconds of difference (nanoseconds ignored).
pub(crate) fn same_time(a_sec: i64, a_nsec: u32, b_sec: i64, b_nsec: u32, window: i64) -> bool {
	match window {
		0 => a_sec == b_sec,
		..0 => a_sec == b_sec && a_nsec == b_nsec,
		w => a_sec.abs_diff(b_sec) <= w.unsigned_abs(),
	}
}

/// same_mtime with --modify-window and nsec rules.
pub(crate) fn same_mtime(entry: &FileEntry, local: &Metadata, opts: &MetaOpts) -> bool {
	mtime_matches(entry, local, opts, false)
}

/// [`same_mtime`], or with `accurate` an exact seconds+nanoseconds comparison
/// (used after a transfer or a checksum match, `ATTRS_ACCURATE_TIME`).
pub(crate) fn mtime_matches(
	entry: &FileEntry,
	local: &Metadata,
	opts: &MetaOpts,
	accurate: bool,
) -> bool {
	mtime_equal(entry, Snap::of(local).mtime, opts.modify_window, accurate)
}

fn mtime_equal(entry: &FileEntry, local: Option<(i64, u32)>, window: i64, accurate: bool) -> bool {
	let Some((sec, nsec)) = local else {
		return false;
	};
	if accurate {
		return sec == entry.mtime && nsec == entry.mtime_nsec;
	}
	same_time(entry.mtime, entry.mtime_nsec, sec, nsec, window)
}

/// Upstream's `symlink_timeset_failed_flags`: what itemize reports for a symlink
/// whose time could not be set (`FLAG_TIME_FAILED`).
pub(crate) const fn symlink_timeset_failed_flags(protocol: u32, am_server: bool) -> u32 {
	ITEM_REPORT_TIME | if protocol >= 30 || !am_server { ITEM_REPORT_TIMEFAIL } else { 0 }
}

/// Itemize context beyond the two stats (what [`attr_changes_with`] consults).
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ItemCtx<'a> {
	/// iflags gathered so far (`ITEM_TRANSFER`, `ITEM_LOCAL_CHANGE`, `ITEM_MATCHED`,
	/// `ITEM_XNAME_FOLLOWS`).
	pub iflags: u32,
	/// The xname sent with `ITEM_XNAME_FOLLOWS`.
	pub xname: Option<&'a [u8]>,
	/// The local creation time when already known (else taken from the metadata).
	pub crtime: Option<i64>,
	/// [`symlink_timeset_failed_flags`] for this session.
	pub timeset_failed_flags: u32,
}

/// Itemize helper: ITEM_REPORT_* bits for differences between `entry` and `local`
/// (upstream itemize's attribute part).
///
/// Covers size (regular files), time, atime, crtime, perms, owner, and group;
/// ACL and xattr bits come from `acl.rs` / `xattr.rs`. With fake-super, pass the
/// overlaid metadata from [`x_lstat`]. `ctx` decides `T` for entries whose time is
/// not preserved and for symlinks whose time could not be set.
pub(crate) fn attr_changes_with(
	entry: &FileEntry,
	local: &Metadata,
	opts: &MetaOpts,
	ctx: &ItemCtx<'_>,
) -> u32 {
	let cur = Snap::of(local);
	let mut bits = 0;
	let keep_time = opts.times
		&& if mode_is_dir(entry.mode) {
			!opts.omit_dir_times
		} else if mode_is_lnk(entry.mode) {
			!opts.omit_link_times
		} else {
			true
		};

	if mode_is_reg(entry.mode) && entry.size != cur.size {
		bits |= ITEM_REPORT_SIZE;
	}
	if entry.flags & FLAG_TIME_FAILED != 0 {
		if ctx.iflags & ITEM_LOCAL_CHANGE != 0 {
			bits |= ctx.timeset_failed_flags;
		}
	} else if keep_time {
		if !mtime_equal(entry, cur.mtime, opts.modify_window, false) {
			bits |= ITEM_REPORT_TIME;
		}
	} else if ctx.iflags & (ITEM_TRANSFER | ITEM_LOCAL_CHANGE) != 0
		&& ctx.iflags & ITEM_MATCHED == 0
		&& (ctx.iflags & ITEM_XNAME_FOLLOWS == 0 || ctx.xname.is_some_and(|x| !x.is_empty()))
	{
		bits |= ITEM_REPORT_TIME;
	}
	if opts.atimes
		&& !mode_is_dir(entry.mode)
		&& !mode_is_lnk(entry.mode)
		&& cur.atime.is_none_or(|atime| !same_time(entry.atime, 0, atime, 0, opts.modify_window))
	{
		bits |= ITEM_REPORT_ATIME;
	}
	if opts.crtimes {
		let crtime = ctx.crtime.or(cur.crtime).unwrap_or(0);
		if !same_time(crtime, 0, entry.crtime, 0, opts.modify_window) {
			bits |= ITEM_REPORT_CRTIME;
		}
	}
	if perms_differ(entry, cur.mode, opts) {
		bits |= ITEM_REPORT_PERMS;
	}
	if uid_differs(entry, &cur, opts) {
		bits |= ITEM_REPORT_OWNER;
	}
	if gid_differs(entry, &cur, opts) {
		bits |= ITEM_REPORT_GROUP;
	}
	bits
}

/// The non-ACL/xattr part of upstream `unchanged_attrs`: true when times (if
/// preserved), permissions, and ownership already match.
pub(crate) fn attrs_unchanged(
	entry: &FileEntry,
	local: &Metadata,
	opts: &MetaOpts,
	local_crtime: Option<i64>,
) -> bool {
	let cur = Snap::of(local);
	let check_time = opts.times && (!mode_is_lnk(entry.mode) || !opts.omit_link_times);
	if check_time {
		let mut differs = !mtime_equal(entry, cur.mtime, opts.modify_window, false);
		if !differs && opts.crtimes {
			let crtime = local_crtime.or(cur.crtime).unwrap_or(0);
			differs = !same_time(crtime, 0, entry.crtime, 0, opts.modify_window);
		}
		if differs {
			return false;
		}
	}
	!perms_differ(entry, cur.mode, opts) && !uid_differs(entry, &cur, opts) && !gid_differs(entry, &cur, opts)
}

fn perms_differ(entry: &FileEntry, local_mode: u32, opts: &MetaOpts) -> bool {
	if opts.perms {
		return stored_perms_differ(local_mode, entry.mode);
	}
	// Windows stores no execute bits, so `-E` has nothing to compare there.
	cfg!(unix) && opts.executability && ((local_mode & 0o111 != 0) != (entry.mode & 0o111 != 0))
}

/// Whether two modes differ in the permission bits the platform stores: all of
/// them on unix, only the read-only attribute (no write bit) on Windows.
fn stored_perms_differ(a: u32, b: u32) -> bool {
	if cfg!(unix) {
		(a ^ b) & CHMOD_BITS != 0
	} else {
		(a & 0o222 == 0) != (b & 0o222 == 0)
	}
}

fn uid_differs(entry: &FileEntry, cur: &Snap, opts: &MetaOpts) -> bool {
	opts.owner && opts.root_like() && cur.uid.is_some_and(|uid| uid != entry.uid)
}

fn gid_differs(entry: &FileEntry, cur: &Snap, opts: &MetaOpts) -> bool {
	opts.group && entry.flags & FLAG_SKIP_GROUP == 0 && cur.gid.is_some_and(|gid| gid != entry.gid)
}

/// The xattr and ACL steps of [`set_file_attrs_with`], supplied by callers that
/// preserve them; upstream runs them between ownership and permissions.
pub(crate) trait AttrHooks {
	/// Applies the entry's xattrs (after ownership, before times; never in a dry
	/// run). Reports its own failures.
	fn apply_xattrs(&mut self, _tree: &Tree, _rel: &Path, _entry: &FileEntry) {}

	/// Applies the entry's ACLs before the final chmod (also called in a dry run,
	/// where it must only detect a difference). Returns whether the ACLs changed;
	/// sets `cur_mode` to the permission bits an access-ACL write left behind.
	fn apply_acls(
		&mut self,
		_tree: &Tree,
		_rel: &Path,
		_entry: &FileEntry,
		_new_mode: u32,
		_cur_mode: &mut u32,
	) -> bool {
		false
	}
}

/// Upstream set_file_attrs: applies owner, group, xattrs (via `hooks`), times, ACLs
/// (via `hooks`), and perms (and the fake-super stat) to `rel`; returns the
/// ITEM_REPORT_* bits that changed.
///
/// `local` is the entry's current (fake-super overlaid, see [`x_lstat`]) metadata;
/// `None` stats it here (and, in a dry run, returns [`ITEM_REPORT_CHANGE`] without
/// looking). Bits: `TIME`, `ATIME`, `CRTIME`, `PERMS`, `OWNER`, `GROUP`, `ACL`; a
/// symlink whose times could not be set adds `ITEM_REPORT_TIMEFAIL` (the caller sets
/// `FLAG_TIME_FAILED`). Failures are logged (exit 23) and end the update early;
/// `Err` is returned only for a corrupt stat xattr (see [`corrupt_fake_stat`]).
#[allow(clippy::too_many_arguments, reason = "upstream set_file_attrs inputs plus the hooks")]
pub(crate) fn set_file_attrs_with(
	tree: &Tree,
	rel: &Path,
	entry: &FileEntry,
	local: Option<&Metadata>,
	opts: &MetaOpts,
	mut flags: u32,
	logger: &Logger,
	hooks: &mut dyn AttrHooks,
) -> io::Result<u32> {
	let fname_bytes = crate::host::os_bytes_lossy(rel.as_os_str());
	let fname: &[u8] = &fname_bytes;
	let statted;
	let (meta, inherit) = match local {
		Some(meta) => (meta, !opts.perms && entry.flags & FLAG_DIR_CREATED != 0),
		None => {
			if opts.dry_run {
				return Ok(ITEM_REPORT_CHANGE);
			}
			match x_lstat(tree, rel, opts, logger) {
				Ok(meta) => statted = meta,
				Err(err) if is_corrupt_fake_stat(&err) => return Err(err),
				Err(err) => {
					let text = [&b"stat "[..], &full_fname(tree, rel), b" failed"].concat();
					logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(0);
				},
			}
			(&statted, !opts.perms)
		},
	};
	let mut cur = Snap::of(meta);
	let mut updated = 0u32;

	let mut new_mode = entry.mode;
	if inherit && mode_is_dir(new_mode) && cur.mode & S_ISGID != 0 {
		// A directory we just created keeps the setgid bit it inherited.
		new_mode |= S_ISGID;
	}

	let change_uid = uid_differs(entry, &cur, opts);
	let change_gid = gid_differs(entry, &cur, opts);
	if change_uid || change_gid {
		if logger.levels().debug(log::Debug::Own) >= 1 {
			if let (true, Some(from)) = (change_uid, cur.uid) {
				let tail = format!(" from {from} to {}\n", entry.uid);
				let text = [&b"set uid of "[..], fname, tail.as_bytes()].concat();
				logger.rprintf(LogCode::Info, &text);
			}
			if let (true, Some(from)) = (change_gid, cur.gid) {
				let tail = format!(" from {from} to {}\n", entry.gid);
				let text = [&b"set gid of "[..], fname, tail.as_bytes()].concat();
				logger.rprintf(LogCode::Info, &text);
			}
		}
		if !opts.fake_super {
			let uid = if change_uid { Some(entry.uid) } else { cur.uid };
			let gid = if change_gid { Some(entry.gid) } else { cur.gid };
			if !opts.dry_run {
				if let Err(err) = tree.chown(rel, uid, gid, false) {
					let verb: &[u8] = if change_uid { b"chown " } else { b"chgrp " };
					let text = [verb, &full_fname(tree, rel), b" failed"].concat();
					logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(updated);
				}
			}
			for (what, new, old) in [("uid", uid, cur.uid), ("gid", gid, cur.gid)] {
				if new == Some(u32::MAX) && old != Some(u32::MAX) {
					let head = format!("{what} 4294967295 (-1) is impossible to set on ");
					let text = [head.as_bytes(), &full_fname(tree, rel), b"\n"].concat();
					logger.rprintf(LogCode::ErrorXfer, &text);
				}
			}
			if !opts.dry_run && cur.mode & (S_ISUID | S_ISGID) != 0 {
				// chown clears setuid/setgid: see what is left before deciding on chmod.
				let restat = if opts.keep_dirlinks && mode_is_dir(cur.mode) {
					tree.stat(rel)
				} else {
					tree.lstat(rel)
				};
				if let Ok(meta) = restat {
					cur = Snap::of(&meta);
				}
			}
		}
		if change_uid {
			updated |= ITEM_REPORT_OWNER;
		}
		if change_gid {
			updated |= ITEM_REPORT_GROUP;
		}
	}

	if opts.fake_super && !opts.dry_run {
		sync_fake_stat(tree, rel, entry, new_mode, logger)?;
	}
	if opts.xattrs && !opts.dry_run {
		hooks.apply_xattrs(tree, rel, entry);
	}

	let is_dir = mode_is_dir(cur.mode);
	let is_lnk = mode_is_lnk(cur.mode);
	if (opts.omit_dir_times && is_dir) || (opts.omit_link_times && is_lnk) {
		flags |= ATTRS_SKIP_MTIME | ATTRS_SKIP_ATIME | ATTRS_SKIP_CRTIME;
	} else {
		if !opts.times {
			flags |= ATTRS_SKIP_MTIME;
		}
		if !opts.atimes || is_dir {
			flags |= ATTRS_SKIP_ATIME;
		}
		if is_dir && cur.ino == Some(2) {
			// Never the creation date of an HFS+ volume root.
			flags |= ATTRS_SKIP_CRTIME;
		}
	}
	let accurate = flags & ATTRS_ACCURATE_TIME != 0;
	let mut new_mtime = None;
	let mut new_atime = None;
	if flags & ATTRS_SKIP_MTIME == 0 && !mtime_equal(entry, cur.mtime, opts.modify_window, accurate)
	{
		new_mtime = Some((entry.mtime, entry.mtime_nsec));
		updated |= ITEM_REPORT_TIME;
	}
	if flags & ATTRS_SKIP_ATIME == 0
		&& (accurate
			|| cur.atime.is_none_or(|atime| !same_time(atime, 0, entry.atime, 0, opts.modify_window)))
	{
		new_atime = Some((entry.atime, 0));
		updated |= ITEM_REPORT_ATIME;
	}
	if opts.crtimes && flags & ATTRS_SKIP_CRTIME == 0 {
		let crtime = cur.crtime.or_else(|| tree.crtime(rel, false).ok().flatten()).unwrap_or(0);
		if !same_time(crtime, 0, entry.crtime, 0, opts.modify_window)
			&& (opts.dry_run || tree.set_crtime(rel, entry.crtime, false).is_ok())
		{
			updated |= ITEM_REPORT_CRTIME;
		}
	}
	let mut time_failed = false;
	if (new_mtime.is_some() || new_atime.is_some()) && !opts.dry_run {
		let result = match (to_file_time(new_atime), to_file_time(new_mtime)) {
			(Ok(atime), Ok(mtime)) => tree.set_times(rel, atime, mtime, false),
			(Err(err), _) | (_, Err(err)) => Err(err),
		};
		if let Err(err) = result {
			if is_lnk && is_unsupported(&err) {
				updated &= !(ITEM_REPORT_TIME | ITEM_REPORT_ATIME);
				time_failed = true;
			} else {
				let text = [&b"failed to set times on "[..], &full_fname(tree, rel)].concat();
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
				return Ok(updated);
			}
		}
	}

	if opts.acls
		&& !mode_is_lnk(new_mode)
		&& hooks.apply_acls(tree, rel, entry, new_mode, &mut cur.mode)
	{
		updated |= ITEM_REPORT_ACL;
	}

	if stored_perms_differ(cur.mode, new_mode) {
		let changed = if opts.fake_super || opts.dry_run {
			true
		} else {
			match tree.chmod(rel, new_mode & CHMOD_BITS) {
				Ok(()) => true,
				// Symlink modes are best effort unless permissions are preserved.
				Err(_) if mode_is_lnk(new_mode) && !opts.perms && !opts.executability => true,
				Err(err) if mode_is_lnk(new_mode) && is_unsupported(&err) => false,
				Err(err) => {
					let text = [&b"failed to set permissions on "[..], &full_fname(tree, rel)].concat();
					logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(updated);
				},
			}
		};
		if changed {
			updated |= ITEM_REPORT_PERMS;
		}
	}

	if flags & ATTRS_REPORT != 0 && logger.levels().info(log::Info::Name) >= 2 {
		let tail: &[u8] = if updated != 0 { b"\n" } else { b" is uptodate\n" };
		logger.rprintf(LogCode::Client, &[fname, tail].concat());
	}
	if time_failed {
		updated |= ITEM_REPORT_TIMEFAIL;
	}
	Ok(updated)
}

/// Upstream `full_fname`: the quoted path as diagnostics show it, relative names
/// prefixed with the tree root.
pub(crate) fn full_fname(tree: &Tree, rel: &Path) -> Vec<u8> {
	crate::rsync::paths::full_fname(tree.root(), &crate::rsync::paths::path_bytes(rel))
}

/// The `--fake-super` stat record: what the entry would be if we were root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct FakeStat {
	/// Full mode, type bits included (protocol encoding of symlinks).
	pub mode: u32,
	/// Device major number (0 unless a device).
	pub rdev_major: u32,
	/// Device minor number (0 unless a device).
	pub rdev_minor: u32,
	/// Owner as root would have set it.
	pub uid: u32,
	/// Group as root would have set it.
	pub gid: u32,
}

impl FakeStat {
	/// The xattr value: `"<mode octal> <major>,<minor> <uid>:<gid>"`.
	pub(crate) fn encode(&self) -> Vec<u8> {
		format!(
			"{:o} {},{} {}:{}",
			self.mode, self.rdev_major, self.rdev_minor, self.uid, self.gid
		)
		.into_bytes()
	}

	/// Parses an xattr value the way upstream's `sscanf("%o %d,%d %d:%d")` does:
	/// whitespace before each number is skipped, numbers may carry a sign, the
	/// value ends at a NUL, and anything after the fifth number is ignored.
	pub(crate) fn decode(value: &[u8]) -> Option<Self> {
		let end = memchr::memchr(0, value).unwrap_or(value.len());
		let mut scan = Scan { buf: &value[..end], pos: 0 };
		let mode = scan.number(8)?;
		let rdev_major = scan.number(10)?;
		scan.literal(b',')?;
		let rdev_minor = scan.number(10)?;
		let uid = scan.number(10)?;
		scan.literal(b':')?;
		let gid = scan.number(10)?;
		Some(Self { mode, rdev_major, rdev_minor, uid, gid })
	}

	/// The device number as the local `st_rdev` encodes it.
	pub(crate) fn rdev(&self) -> u64 {
		dev_join(self.rdev_major, self.rdev_minor)
	}

	/// `real` with this record's mode, owner, and device number in place of the
	/// on-disk ones (what upstream's `x_lstat` returns).
	pub(crate) fn overlay(&self, real: &Metadata) -> Metadata {
		let mut meta = Metadata::new(
			FileType::from_mode(self.mode),
			real.len(),
			Permissions::from_mode(self.mode),
		);
		if let Ok(time) = real.modified() {
			meta = meta.with_modified(time);
		}
		if let Ok(time) = real.accessed() {
			meta = meta.with_accessed(time);
		}
		if let Ok(time) = real.created() {
			meta = meta.with_created(time);
		}
		if let Ok(time) = real.changed() {
			meta = meta.with_changed(time);
		}
		if let Some(id) = real.file_id() {
			meta = if id.is_native() {
				meta.with_native_id(id.dev(), id.ino())
			} else {
				meta.with_id(id.dev(), id.ino())
			};
		}
		if let Some(nlink) = real.nlink() {
			meta = meta.with_nlink(nlink);
		}
		if let (Some(blocks), Some(blksize)) = (real.blocks(), real.blksize()) {
			meta = meta.with_blocks(blocks, blksize);
		}
		meta.with_owner(self.uid, self.gid).with_rdev(self.rdev())
	}
}

/// sscanf-like cursor for [`FakeStat::decode`].
struct Scan<'a> {
	buf: &'a [u8],
	pos: usize,
}

impl Scan<'_> {
	fn number(&mut self, radix: u32) -> Option<u32> {
		while self.buf.get(self.pos).is_some_and(u8::is_ascii_whitespace) {
			self.pos += 1;
		}
		let negative = match self.buf.get(self.pos) {
			Some(b'-') => {
				self.pos += 1;
				true
			},
			Some(b'+') => {
				self.pos += 1;
				false
			},
			_ => false,
		};
		let start = self.pos;
		let mut value = 0u32;
		while let Some(digit) = self.buf.get(self.pos).and_then(|&b| char::from(b).to_digit(radix)) {
			value = value.wrapping_mul(radix).wrapping_add(digit);
			self.pos += 1;
		}
		if self.pos == start {
			return None;
		}
		Some(if negative { value.wrapping_neg() } else { value })
	}

	fn literal(&mut self, byte: u8) -> Option<()> {
		(self.buf.get(self.pos) == Some(&byte)).then(|| self.pos += 1)
	}
}

/// A stat xattr that does not parse ends the run (`RERR_FILEIO`); the io::Error
/// carries that `RsyncError` inside, so `RsyncError::from_io` returns it verbatim.
fn is_corrupt_fake_stat(err: &io::Error) -> bool {
	err.get_ref().is_some_and(|inner| inner.is::<RsyncError>())
}

/// The fatal error for a corrupt stat xattr (`Corrupt rsync.%stat xattr attached
/// to "…": "…"`, exit 11), if `err` is one; other errors are not fatal.
pub(crate) fn corrupt_fake_stat(err: &io::Error) -> Option<RsyncError> {
	err.get_ref()?.downcast_ref::<RsyncError>().cloned()
}

/// Stores `stat` as the entry's stat xattr.
fn write_fake_stat(tree: &Tree, rel: &Path, stat: &FakeStat) -> io::Result<()> {
	tree.set_xattr(rel, OsStr::new(XSTAT_ATTR), &stat.encode(), false)
}

/// Upstream `x_lstat` (`x_stat` with `-L`): the entry's metadata with the
/// fake-super record folded in when `--fake-super` is on. Read failures of the
/// xattr are logged and the real metadata is returned.
pub(crate) fn x_lstat(
	tree: &Tree,
	rel: &Path,
	opts: &MetaOpts,
	logger: &Logger,
) -> io::Result<Metadata> {
	let real = if opts.copy_links { tree.stat(rel)? } else { tree.lstat(rel)? };
	if !opts.fake_super {
		return Ok(real);
	}
	match fake_stat_for(tree, rel, &real) {
		Ok(Some(stat)) => Ok(stat.overlay(&real)),
		Ok(None) => Ok(real),
		Err(err) if is_corrupt_fake_stat(&err) => Err(err),
		Err(err) => {
			log_xattr_failure(tree, rel, logger, &err, b"read");
			Ok(real)
		},
	}
}

/// The entry's fake-super record given its real metadata `real`.
///
/// `None` when there is no record, the filesystem has no xattrs, or the entry
/// is a device/special (which fake-super never stores as such). A symlink whose
/// xattrs we may not read reads as owned by 0:0. An unparsable value fails with
/// an error [`corrupt_fake_stat`] recognizes.
fn fake_stat_for(tree: &Tree, rel: &Path, real: &Metadata) -> io::Result<Option<FakeStat>> {
	let mode = real.mode();
	if mode_is_device(mode) || mode_is_special(mode) {
		return Ok(None);
	}
	match tree.get_xattr(rel, OsStr::new(XSTAT_ATTR), false) {
		Ok(None) => Ok(None),
		Ok(Some(value)) if value.len() > XSTAT_MAX => Err(errno_error(Errno::Range)),
		Ok(Some(value)) => match FakeStat::decode(&value) {
			Some(stat) => Ok(Some(stat)),
			None => {
				let end = memchr::memchr(0, &value).unwrap_or(value.len());
				let head = format!("Corrupt {XSTAT_ATTR} xattr attached to ");
				let text =
					[head.as_bytes(), &full_fname(tree, rel), b": \"", &value[..end], b"\""].concat();
				let text = String::from_utf8_lossy_owned(text);
				let fatal = RsyncError::new(RERR_FILEIO, text).at("xattrs.c", 1257);
				Err(io::Error::new(io::ErrorKind::InvalidData, fatal))
			},
		},
		Err(err) if is_no_xattr(&err) => Ok(None),
		Err(err) if is_eperm(&err) && mode_is_lnk(mode) => {
			let (rdev_major, rdev_minor) = real.rdev().map_or((0, 0), dev_split);
			Ok(Some(FakeStat { mode, rdev_major, rdev_minor, uid: 0, gid: 0 }))
		},
		Err(err) => Err(err),
	}
}

/// Upstream `set_stat_xattr`: makes the on-disk entry owner-accessible with the
/// sender's plain permissions and records whatever else (special bits, type,
/// device, owner) differs in the stat xattr, removing a record that became moot.
fn sync_fake_stat(
	tree: &Tree,
	rel: &Path,
	entry: &FileEntry,
	new_mode: u32,
	logger: &Logger,
) -> io::Result<()> {
	let real = match tree.lstat(rel) {
		Ok(meta) => meta,
		Err(err) => {
			let text = [&b"failed to re-stat "[..], &full_fname(tree, rel)].concat();
			logger.rsyserr(LogCode::ErrorXfer, &err, &text);
			return Ok(());
		},
	};
	let existing = match fake_stat_for(tree, rel, &real) {
		Ok(stat) => stat,
		Err(err) if is_corrupt_fake_stat(&err) => return Err(err),
		Err(err) => {
			log_xattr_failure(tree, rel, logger, &err, b"read");
			None
		},
	};

	let disk_mode = real.mode() & (S_IFMT | CHMOD_BITS);
	let want_mode = new_mode & (S_IFMT | CHMOD_BITS);
	let want_rdev = if mode_is_device(want_mode) { entry.rdev.unwrap_or((0, 0)) } else { (0, 0) };
	let owner_bits = if mode_is_dir(disk_mode) { 0o700 } else { 0o600 };
	let plain_mode = (disk_mode & S_IFMT) | (want_mode & ACCESSPERMS) | owner_bits;
	if disk_mode != plain_mode {
		// Best effort, like upstream: a failure shows up in the record instead.
		let _ = tree.chmod(rel, plain_mode & CHMOD_BITS);
	}
	let disk_rdev = match real.rdev() {
		Some(rdev) if mode_is_device(disk_mode) => dev_split(rdev),
		_ => (0, 0),
	};

	if plain_mode == want_mode
		&& disk_rdev == want_rdev
		&& real.uid() == Some(entry.uid)
		&& real.gid() == Some(entry.gid)
	{
		// The real entry says it all: drop a stale record.
		if existing.is_some_and(|stat| stat.mode != 0) {
			if let Err(err) = tree.remove_xattr(rel, OsStr::new(XSTAT_ATTR), false) {
				let text = [&b"delete of stat xattr failed for "[..], &full_fname(tree, rel)].concat();
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
			}
		}
		return Ok(());
	}

	let want = FakeStat {
		mode: want_mode,
		rdev_major: want_rdev.0,
		rdev_minor: want_rdev.1,
		uid: entry.uid,
		gid: entry.gid,
	};
	if existing != Some(want) {
		if let Err(err) = write_fake_stat(tree, rel, &want) {
			if !(is_eperm(&err) && mode_is_lnk(disk_mode)) {
				log_xattr_failure(tree, rel, logger, &err, b"write");
			}
		}
	}
	Ok(())
}

/// "failed to read|write xattr rsync.%stat for \"…\"".
fn log_xattr_failure(tree: &Tree, rel: &Path, logger: &Logger, err: &io::Error, verb: &[u8]) {
	let mid = format!(" xattr {XSTAT_ATTR} for ");
	let text = [&b"failed to "[..], verb, mid.as_bytes(), &full_fname(tree, rel)].concat();
	logger.rsyserr(LogCode::ErrorXfer, err, &text);
}

/// The attribute name is absent or the filesystem has no xattrs.
fn is_no_xattr(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(unix)]
	{
		#[cfg(any(target_os = "linux", target_os = "android"))]
		let missing = libc::ENODATA;
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		let missing = libc::ENOATTR;
		err.raw_os_error().is_some_and(|code| {
			code == missing || code == libc::ENOTSUP || code == libc::EOPNOTSUPP
		})
	}
	#[cfg(not(unix))]
	{
		false
	}
}

/// The operation cannot be done on this kind of entry (lchmod/lutimes missing).
fn is_unsupported(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(unix)]
	{
		err.raw_os_error().is_some_and(|code| {
			code == libc::ENOTSUP || code == libc::EOPNOTSUPP || code == libc::ENOSYS
		})
	}
	#[cfg(not(unix))]
	{
		false
	}
}

/// `EPERM` (Windows reports access problems as `PermissionDenied` only).
fn is_eperm(err: &io::Error) -> bool {
	#[cfg(unix)]
	{
		err.raw_os_error() == Some(libc::EPERM)
	}
	#[cfg(not(unix))]
	{
		let _ = err;
		false
	}
}

/// Errors upstream reports with an errno of its own making.
#[derive(Clone, Copy)]
enum Errno {
	Range,
	Inval,
}

fn errno_error(errno: Errno) -> io::Error {
	#[cfg(unix)]
	{
		io::Error::from_raw_os_error(match errno {
			Errno::Range => libc::ERANGE,
			Errno::Inval => libc::EINVAL,
		})
	}
	#[cfg(not(unix))]
	{
		match errno {
			Errno::Range => io::Error::new(io::ErrorKind::InvalidData, "Result too large"),
			Errno::Inval => io::Error::from(io::ErrorKind::InvalidInput),
		}
	}
}

/// `st_rdev` → (major, minor) in the local encoding.
#[cfg(unix)]
fn dev_split(rdev: u64) -> (u32, u32) {
	let dev = rdev as libc::dev_t;
	(libc::major(dev) as u32, libc::minor(dev) as u32)
}

/// (major, minor) → `st_rdev` in the local encoding (MAKEDEV).
#[cfg(unix)]
#[allow(clippy::unnecessary_cast, clippy::useless_conversion, reason = "dev_t differs per OS")]
pub(crate) fn dev_join(major: u32, minor: u32) -> u64 {
	libc::makedev(major as _, minor as _) as u64
}

/// Windows has no device nodes; keep the pair recoverable.
#[cfg(not(unix))]
fn dev_split(rdev: u64) -> (u32, u32) {
	((rdev >> 32) as u32, rdev as u32)
}

/// (major, minor) → a recoverable `st_rdev` (Windows has no device nodes).
#[cfg(not(unix))]
pub(crate) fn dev_join(major: u32, minor: u32) -> u64 {
	(u64::from(major) << 32) | u64::from(minor)
}

/// `(secs, nsec)` → a `FileTime` to set (`None` leaves the time alone).
fn to_file_time(time: Option<(i64, u32)>) -> io::Result<Option<FileTime>> {
	let Some((secs, nsec)) = time else {
		return Ok(None);
	};
	system_time(secs, i64::from(nsec))
		.map(|t| Some(FileTime::At(t)))
		.ok_or_else(|| errno_error(Errno::Inval))
}

/// Whole seconds since the epoch, rounded toward negative infinity.
fn unix_secs(time: SystemTime) -> i64 {
	match time.duration_since(UNIX_EPOCH) {
		Ok(after) => i64::try_from(after.as_secs()).unwrap_or(i64::MAX),
		Err(before) => {
			let d = before.duration();
			let secs = i64::try_from(d.as_secs()).unwrap_or(i64::MAX);
			-secs - i64::from(d.subsec_nanos() > 0)
		},
	}
}

/// The fields of a stat this module consults.
#[derive(Clone, Copy, Debug)]
struct Snap {
	mode: u32,
	size: u64,
	uid: Option<u32>,
	gid: Option<u32>,
	ino: Option<u64>,
	mtime: Option<(i64, u32)>,
	atime: Option<i64>,
	crtime: Option<i64>,
}

impl Snap {
	fn of(meta: &Metadata) -> Self {
		let mtime = meta
			.mtime()
			.map(|secs| (secs, meta.mtime_nsec().and_then(|n| u32::try_from(n).ok()).unwrap_or(0)));
		Self {
			mode: meta.mode(),
			size: meta.len(),
			uid: meta.uid(),
			gid: meta.gid(),
			ino: meta.ino(),
			mtime,
			atime: meta.atime(),
			crtime: meta.created().ok().map(unix_secs),
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{Arc, Mutex},
		time::{Duration, UNIX_EPOCH},
	};

	use super::*;
	use crate::rsync::{
		log::{LogConfig, OutLevels},
		tree::TreeOpts,
	};

	const T0: i64 = 1_700_000_000;

	fn vmeta(mode: u32, size: u64) -> Metadata {
		Metadata::new(FileType::from_mode(mode), size, Permissions::from_mode(mode))
	}

	fn at(secs: i64, nsec: u32) -> SystemTime {
		UNIX_EPOCH + Duration::new(secs.unsigned_abs(), nsec)
	}

	fn with_mtime(meta: Metadata, secs: i64, nsec: u32) -> Metadata {
		meta.with_modified(at(secs, nsec))
	}

	fn entry(mode: u32) -> FileEntry {
		FileEntry { basename: Box::from(&b"f"[..]), mode, mtime: T0, ..FileEntry::default() }
	}

	#[derive(Clone, Default)]
	struct Sink(Arc<Mutex<Vec<u8>>>);

	impl io::Write for Sink {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.0.lock().unwrap().extend_from_slice(buf);
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl Sink {
		fn contains(&self, needle: &[u8]) -> bool {
			self.0.lock().unwrap().windows(needle.len()).any(|w| w == needle)
		}
	}

	fn logger_with(levels: OutLevels) -> (Logger, Sink) {
		let sink = Sink::default();
		let cfg = LogConfig { levels, ..LogConfig::default() };
		(Logger::local(Box::new(sink.clone()), Box::new(sink.clone()), cfg), sink)
	}

	fn logger() -> (Logger, Sink) {
		logger_with(OutLevels::default())
	}

	fn tree(dir: &tempfile::TempDir) -> Tree {
		Tree::open(&pi_vfs::BlockingFs::native(), dir.path(), &TreeOpts::default()).unwrap()
	}

	struct NoHooks;

	impl AttrHooks for NoHooks {}

	fn set_file_attrs(
		tree: &Tree,
		rel: &Path,
		entry: &FileEntry,
		local: Option<&Metadata>,
		opts: &MetaOpts,
		flags: u32,
		logger: &Logger,
	) -> io::Result<u32> {
		set_file_attrs_with(tree, rel, entry, local, opts, flags, logger, &mut NoHooks)
	}

	fn attr_changes(entry: &FileEntry, local: &Metadata, opts: &MetaOpts) -> u32 {
		attr_changes_with(entry, local, opts, &ItemCtx::default())
	}

	#[cfg(unix)]
	fn read_fake_stat(tree: &Tree, rel: &Path) -> io::Result<Option<FakeStat>> {
		fake_stat_for(tree, rel, &tree.lstat(rel)?)
	}

	#[test]
	fn dest_mode_matrix() {
		// (opts, default perms for new entries = 0777 & ~umask)
		let off = |umask: u32, executability| {
			(MetaOpts { executability, ..MetaOpts::default() }, 0o777 & !umask)
		};
		let perms = (MetaOpts { perms: true, ..MetaOpts::default() }, 0o700);
		// (flist mode, existing mode, exists, (opts, dflt perms), expected)
		let cases: &[(u32, Option<u32>, bool, (MetaOpts, u32), u32)] = &[
			// -p: the sender's mode stands, new or existing.
			(0o104755, Some(0o100600), true, perms.clone(), 0o104755),
			(0o104755, None, false, perms.clone(), 0o104755),
			// New entries: umask-limited, special bits dropped.
			(0o104755, None, false, off(0o022, false), 0o100755),
			(0o100666, None, false, off(0o022, false), 0o100644),
			(0o100755, None, false, off(0o077, false), 0o100700),
			(0o042775, None, false, off(0o022, false), 0o040755),
			(0o100600, None, false, off(0o022, true), 0o100600),
			// "Exists" without a stat, or a stat that does not count (just-created dir).
			(0o100777, None, true, off(0o022, false), 0o100755),
			(0o100777, Some(0o100600), false, off(0o022, false), 0o100755),
			// Existing entries keep their permissions...
			(0o100755, Some(0o100640), true, off(0o022, false), 0o100640),
			(0o104755, Some(0o100640), true, off(0o077, false), 0o100640),
			// ...with -E granting x where readable when the source is executable...
			(0o100755, Some(0o100640), true, off(0o022, true), 0o100750),
			(0o104755, Some(0o100644), true, off(0o022, true), 0o100755),
			// ...but not touching an already-executable file...
			(0o100755, Some(0o100711), true, off(0o022, true), 0o100711),
			// ...and dropping x when the source is not executable.
			(0o100644, Some(0o100755), true, off(0o022, true), 0o100644),
			(0o100600, Some(0o100640), true, off(0o022, true), 0o100640),
			// -E only concerns regular files.
			(0o040755, Some(0o040700), true, off(0o022, true), 0o040700),
			// The type always comes from the file list.
			(0o100644, Some(0o120777), true, off(0o022, false), 0o100777),
		];
		for (i, (flist, existing, exists, (opts, dflt), want)) in cases.iter().enumerate() {
			let got = dest_mode_with(*flist, *existing, *exists, *dflt, opts);
			assert_eq!(got, *want, "case {i}: {flist:o} {existing:?} {exists}: got {got:o}");
		}
		// A default-ACL mask only matters for new entries.
		let opts = off(0o022, false).0;
		assert_eq!(dest_mode_with(0o100777, None, false, 0o750, &opts), 0o100750);
		assert_eq!(dest_mode_with(0o100777, Some(0o100600), true, 0o750, &opts), 0o100600);
	}

	#[test]
	fn same_mtime_modify_window() {
		let window = |modify_window| MetaOpts { modify_window, ..MetaOpts::default() };
		let mut e = entry(0o100644);
		e.mtime_nsec = 500;
		let local = |secs, nsec| with_mtime(vmeta(0o100644, 0), secs, nsec);

		// 0: whole seconds only.
		assert!(same_mtime(&e, &local(T0, 999), &window(0)));
		assert!(!same_mtime(&e, &local(T0 + 1, 500), &window(0)));
		// Positive: that many seconds either way, nanoseconds ignored.
		assert!(same_mtime(&e, &local(T0 + 1, 0), &window(1)));
		assert!(same_mtime(&e, &local(T0 - 1, 0), &window(1)));
		assert!(!same_mtime(&e, &local(T0 + 2, 500), &window(1)));
		assert!(!same_mtime(&e, &local(T0 - 2, 500), &window(1)));
		// Negative: seconds and nanoseconds must both match.
		assert!(!same_mtime(&e, &local(T0, 501), &window(-1)));
		assert!(same_mtime(&e, &local(T0, 500), &window(-1)));
		// Accurate comparisons ignore the window.
		assert!(!mtime_matches(&e, &local(T0 + 1, 500), &window(5), true));
		assert!(!mtime_matches(&e, &local(T0, 0), &window(0), true));
		assert!(mtime_matches(&e, &local(T0, 500), &window(5), true));
		// Unknown local time never matches.
		assert!(!same_mtime(&e, &vmeta(0o100644, 0), &window(0)));
		// Extreme values do not overflow.
		assert!(!same_time(i64::MIN, 0, i64::MAX, 0, 1));
		assert!(same_time(i64::MAX, 0, i64::MAX - 3, 0, 3));
	}

	#[test]
	fn attr_changes_bits() {
		let base = MetaOpts { times: true, perms: true, ..MetaOpts::default() };
		let e = entry(0o100644);
		let same = with_mtime(vmeta(0o100644, 0), T0, 0).with_owner(10, 20);
		assert_eq!(attr_changes(&e, &same, &base), 0);
		assert!(attrs_unchanged(&e, &same, &base, None));

		// Size (regular files only), time, and perms.
		let other = with_mtime(vmeta(0o100600, 7), T0 + 1, 0).with_owner(10, 20);
		assert_eq!(
			attr_changes(&e, &other, &base),
			ITEM_REPORT_SIZE | ITEM_REPORT_TIME | ITEM_REPORT_PERMS
		);
		assert!(!attrs_unchanged(&e, &other, &base, None));
		let dir = entry(0o040755);
		let local_dir = with_mtime(vmeta(0o040755, 7), T0 + 1, 0);
		assert_eq!(attr_changes(&dir, &local_dir, &base), ITEM_REPORT_TIME);

		// Without -p, -E compares only executability.
		let exec = MetaOpts { times: true, executability: true, ..MetaOpts::default() };
		let local_exec = with_mtime(vmeta(0o100711, 0), T0, 0);
		let want = if cfg!(unix) { ITEM_REPORT_PERMS } else { 0 };
		assert_eq!(attr_changes(&e, &local_exec, &exec), want);
		assert_eq!(attr_changes(&e, &with_mtime(vmeta(0o100600, 0), T0, 0), &exec), 0);

		// Omitted dir times: T only when the entry is transferred/changed and not matched.
		let omit = MetaOpts { omit_dir_times: true, ..base.clone() };
		assert_eq!(attr_changes(&dir, &local_dir, &omit), 0);
		let ctx = |iflags, xname| ItemCtx { iflags, xname, ..ItemCtx::default() };
		let changed = ctx(ITEM_LOCAL_CHANGE, None);
		assert_eq!(attr_changes_with(&dir, &local_dir, &omit, &changed), ITEM_REPORT_TIME);
		let matched = ctx(ITEM_LOCAL_CHANGE | ITEM_MATCHED, None);
		assert_eq!(attr_changes_with(&dir, &local_dir, &omit, &matched), 0);
		let empty_xname = ctx(ITEM_TRANSFER | ITEM_XNAME_FOLLOWS, Some(&b""[..]));
		assert_eq!(attr_changes_with(&dir, &local_dir, &omit, &empty_xname), 0);
		let xname = ctx(ITEM_TRANSFER | ITEM_XNAME_FOLLOWS, Some(&b"x"[..]));
		assert_eq!(attr_changes_with(&dir, &local_dir, &omit, &xname), ITEM_REPORT_TIME);

		// A symlink whose time could not be set reports the failure flags on change.
		let mut link = entry(0o120777);
		link.flags |= FLAG_TIME_FAILED;
		let local_link = with_mtime(vmeta(0o120777, 0), T0 + 9, 0);
		let failed = ItemCtx {
			iflags: ITEM_LOCAL_CHANGE,
			timeset_failed_flags: symlink_timeset_failed_flags(31, false),
			..ItemCtx::default()
		};
		assert_eq!(
			attr_changes_with(&link, &local_link, &base, &failed),
			ITEM_REPORT_TIME | ITEM_REPORT_TIMEFAIL
		);
		assert_eq!(attr_changes(&link, &local_link, &base), 0);
		// -J: symlink time differences are not reported or compared.
		link.flags = 0;
		let omit_links = MetaOpts { omit_link_times: true, ..base.clone() };
		assert_eq!(attr_changes(&link, &local_link, &omit_links), 0);
		assert!(attrs_unchanged(&link, &local_link, &omit_links, None));

		// Ownership: uid only as root (or fake-super), gid unless FLAG_SKIP_GROUP.
		let mut owned = entry(0o100644);
		owned.uid = 11;
		owned.gid = 21;
		let owners = MetaOpts { owner: true, group: true, ..base.clone() };
		assert_eq!(attr_changes(&owned, &same, &owners), ITEM_REPORT_GROUP);
		let root = MetaOpts { am_root: true, ..owners.clone() };
		assert_eq!(attr_changes(&owned, &same, &root), ITEM_REPORT_OWNER | ITEM_REPORT_GROUP);
		let fake = MetaOpts { fake_super: true, ..owners.clone() };
		assert_eq!(attr_changes(&owned, &same, &fake), ITEM_REPORT_OWNER | ITEM_REPORT_GROUP);
		owned.flags |= FLAG_SKIP_GROUP;
		assert_eq!(attr_changes(&owned, &same, &root), ITEM_REPORT_OWNER);
		// Unknown local ownership is never reported.
		assert_eq!(attr_changes(&owned, &with_mtime(vmeta(0o100644, 0), T0, 0), &root), 0);

		// -U: atime of non-directories, whole seconds.
		let atimes = MetaOpts { atimes: true, ..base.clone() };
		let mut e_at = entry(0o100644);
		e_at.atime = T0 - 50;
		let local_at = same.clone().with_accessed(at(T0 - 50, 999));
		assert_eq!(attr_changes(&e_at, &local_at, &atimes), 0);
		let local_at = same.clone().with_accessed(at(T0 - 49, 0));
		assert_eq!(attr_changes(&e_at, &local_at, &atimes), ITEM_REPORT_ATIME);

		// -N: creation time from the context, else the metadata.
		let crtimes = MetaOpts { crtimes: true, ..base.clone() };
		let mut e_cr = entry(0o100644);
		e_cr.crtime = T0 - 100;
		let cr_ctx = ItemCtx { crtime: Some(T0 - 100), ..ItemCtx::default() };
		assert_eq!(attr_changes_with(&e_cr, &same, &crtimes, &cr_ctx), 0);
		assert_eq!(attr_changes(&e_cr, &same, &crtimes), ITEM_REPORT_CRTIME);
		let local_cr = same.clone().with_created(at(T0 - 100, 0));
		assert_eq!(attr_changes(&e_cr, &local_cr, &crtimes), 0);
		assert!(!attrs_unchanged(&e_cr, &same, &crtimes, None));
		assert!(attrs_unchanged(&e_cr, &same, &crtimes, Some(T0 - 100)));
	}

	#[test]
	fn timeset_failed_flags_by_protocol() {
		assert_eq!(symlink_timeset_failed_flags(29, true), ITEM_REPORT_TIME);
		assert_eq!(symlink_timeset_failed_flags(29, false), ITEM_REPORT_TIME | ITEM_REPORT_TIMEFAIL);
		assert_eq!(symlink_timeset_failed_flags(30, true), ITEM_REPORT_TIME | ITEM_REPORT_TIMEFAIL);
	}

	#[test]
	fn fake_stat_codec() {
		// Values written by rsync 3.5.1 --fake-super (macOS).
		let f = FakeStat { mode: 0o104755, rdev_major: 0, rdev_minor: 0, uid: 501, gid: 0 };
		assert_eq!(f.encode(), b"104755 0,0 501:0");
		assert_eq!(FakeStat::decode(b"104755 0,0 501:0"), Some(f));
		let fifo = FakeStat { mode: 0o10644, rdev_major: 0, rdev_minor: 0, uid: 501, gid: 0 };
		assert_eq!(FakeStat::decode(b"10644 0,0 501:0"), Some(fifo));

		let dev = FakeStat { mode: 0o20600, rdev_major: 4, rdev_minor: 64, uid: 0, gid: 5 };
		assert_eq!(FakeStat::decode(&dev.encode()), Some(dev));
		let max = FakeStat {
			mode: 0o177777,
			rdev_major: u32::MAX,
			rdev_minor: u32::MAX,
			uid: u32::MAX,
			gid: u32::MAX,
		};
		assert_eq!(FakeStat::decode(&max.encode()), Some(max));

		// sscanf leniency: whitespace before numbers, signs, trailing junk.
		let lenient = FakeStat::decode(b"  100644\t 1,+2 \n3:4 trailing").unwrap();
		assert_eq!(
			lenient,
			FakeStat { mode: 0o100644, rdev_major: 1, rdev_minor: 2, uid: 3, gid: 4 }
		);
		let negative = FakeStat::decode(b"100644 -1,0 -2:0").unwrap();
		assert_eq!((negative.rdev_major, negative.uid), (u32::MAX, u32::MAX - 1));

		for bad in [
			&b""[..],
			b"garbage",
			b"100644",
			b"100644 0,0 0",
			b"100644 0 ,0 0:0",
			b"100644 0,0 0 :0",
			b"100644 0,0\x000:0",
			b"1006448 0,0 0:0",
			b"100644 0;0 0:0",
		] {
			assert_eq!(FakeStat::decode(bad), None, "{:?}", String::from_utf8_lossy(bad));
		}
	}

	#[test]
	fn set_file_attrs_sets_times() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("f"), b"data").unwrap();
		let tree = tree(&dir);
		let (logger, _sink) = logger();
		let rel = Path::new("f");
		// Without -p the caller has already put the local permissions in the entry.
		let mut e = entry(tree.lstat(rel).unwrap().mode());
		e.mtime = 1_000_000_000;
		e.mtime_nsec = 123_456_700;
		let opts = MetaOpts { times: true, ..MetaOpts::default() };

		let local = tree.lstat(rel).unwrap();
		let bits = set_file_attrs(&tree, rel, &e, Some(&local), &opts, 0, &logger).unwrap();
		assert_eq!(bits, ITEM_REPORT_TIME);
		let modified = std::fs::metadata(dir.path().join("f")).unwrap().modified().unwrap();
		assert_eq!(modified, at(1_000_000_000, 123_456_700));
		// Already right: nothing to do (statting it ourselves this time).
		assert_eq!(set_file_attrs(&tree, rel, &e, None, &opts, 0, &logger).unwrap(), 0);

		// Within --modify-window nothing changes, unless the time must be accurate.
		let window = MetaOpts { modify_window: 10, ..opts.clone() };
		e.mtime += 3;
		assert_eq!(set_file_attrs(&tree, rel, &e, None, &window, 0, &logger).unwrap(), 0);
		let bits = set_file_attrs(&tree, rel, &e, None, &window, ATTRS_ACCURATE_TIME, &logger);
		assert_eq!(bits.unwrap(), ITEM_REPORT_TIME);
		// ATTRS_SKIP_MTIME leaves it alone.
		e.mtime += 100;
		assert_eq!(set_file_attrs(&tree, rel, &e, None, &opts, ATTRS_SKIP_MTIME, &logger).unwrap(), 0);
		let modified = std::fs::metadata(dir.path().join("f")).unwrap().modified().unwrap();
		assert_eq!(modified, at(1_000_000_003, 123_456_700));

		// -U sets the access time (whole seconds).
		let atimes = MetaOpts { atimes: true, ..opts.clone() };
		e.mtime = 1_000_000_003;
		e.atime = 1_100_000_000;
		let bits = set_file_attrs(&tree, rel, &e, None, &atimes, 0, &logger).unwrap();
		assert_eq!(bits, ITEM_REPORT_ATIME);
		let accessed = std::fs::metadata(dir.path().join("f")).unwrap().accessed().unwrap();
		assert_eq!(accessed, at(1_100_000_000, 0));
	}

	#[test]
	fn set_file_attrs_reports_uptodate() {
		let dir = tempfile::tempdir().unwrap();
		std::fs::write(dir.path().join("f"), b"").unwrap();
		let tree = tree(&dir);
		let (logger, sink) = logger_with(OutLevels::from_verbose(2));
		let rel = Path::new("f");
		let e = entry(tree.lstat(rel).unwrap().mode());
		let opts = MetaOpts::default();
		assert_eq!(set_file_attrs(&tree, rel, &e, None, &opts, ATTRS_REPORT, &logger).unwrap(), 0);
		logger.flush();
		assert!(sink.contains(b"f is uptodate\n"));
	}

	#[test]
	fn set_file_attrs_stat_failure_is_logged() {
		let dir = tempfile::tempdir().unwrap();
		let tree = tree(&dir);
		let (logger, sink) = logger();
		let e = entry(0o100644);
		let opts = MetaOpts { times: true, ..MetaOpts::default() };
		let rel = Path::new("missing");
		assert_eq!(set_file_attrs(&tree, rel, &e, None, &opts, 0, &logger).unwrap(), 0);
		logger.flush();
		let mut want = b"stat ".to_vec();
		want.extend_from_slice(&full_fname(&tree, rel));
		want.extend_from_slice(b" failed");
		assert!(sink.contains(&want));
		// Recorded so the run ends with "some files/attrs were not transferred" (23).
		assert!(logger.got_xfer_error());
		// A dry run does not even look.
		let dry = MetaOpts { dry_run: true, ..opts };
		assert_eq!(set_file_attrs(&tree, rel, &e, None, &dry, 0, &logger).unwrap(), ITEM_REPORT_CHANGE);
	}

	#[cfg(unix)]
	mod unix {
		use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};

		use super::*;

		fn mode_of(path: &Path) -> u32 {
			std::fs::symlink_metadata(path).unwrap().mode()
		}

		fn chmod(path: &Path, mode: u32) {
			std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).unwrap();
		}

		#[test]
		fn perms_and_times_applied_in_one_pass() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("f");
			std::fs::write(&path, b"data").unwrap();
			chmod(&path, 0o600);
			let tree = tree(&dir);
			let (logger, _sink) = logger();
			let rel = Path::new("f");
			let mut e = entry(0o100754);
			e.mtime = 1_000_000_000;
			e.mtime_nsec = 123_456_789;
			let opts = MetaOpts { perms: true, times: true, ..MetaOpts::default() };

			// A dry run reports without touching anything.
			let dry = MetaOpts { dry_run: true, ..opts.clone() };
			let local = tree.lstat(rel).unwrap();
			let bits = set_file_attrs(&tree, rel, &e, Some(&local), &dry, 0, &logger).unwrap();
			assert_eq!(bits, ITEM_REPORT_PERMS | ITEM_REPORT_TIME);
			assert_eq!(mode_of(&path) & 0o7777, 0o600);

			let bits = set_file_attrs(&tree, rel, &e, Some(&local), &opts, 0, &logger).unwrap();
			assert_eq!(bits, ITEM_REPORT_PERMS | ITEM_REPORT_TIME);
			let meta = std::fs::symlink_metadata(&path).unwrap();
			assert_eq!(meta.mode() & 0o7777, 0o754);
			assert_eq!((meta.mtime(), meta.mtime_nsec()), (1_000_000_000, 123_456_789));
			assert_eq!(set_file_attrs(&tree, rel, &e, None, &opts, 0, &logger).unwrap(), 0);

			// Not root: a different owner is neither attempted nor reported; the
			// group we already have is left alone.
			let owners = MetaOpts { owner: true, group: true, ..opts.clone() };
			let mut other = e.clone();
			other.uid = meta.uid().wrapping_add(1);
			other.gid = meta.gid();
			assert_eq!(set_file_attrs(&tree, rel, &other, None, &owners, 0, &logger).unwrap(), 0);
			assert_eq!(std::fs::symlink_metadata(&path).unwrap().uid(), meta.uid());
		}

		#[test]
		fn omitted_dir_and_link_times() {
			let dir = tempfile::tempdir().unwrap();
			std::fs::create_dir(dir.path().join("d")).unwrap();
			chmod(&dir.path().join("d"), 0o755);
			symlink("target", dir.path().join("l")).unwrap();
			let tree = tree(&dir);
			let (logger, _sink) = logger();
			let before = std::fs::symlink_metadata(dir.path().join("d")).unwrap().mtime();

			let mut d = entry(0o040755);
			d.mtime = 1_000_000_000;
			let opts = MetaOpts { perms: true, times: true, omit_dir_times: true, ..MetaOpts::default() };
			assert_eq!(set_file_attrs(&tree, Path::new("d"), &d, None, &opts, 0, &logger).unwrap(), 0);
			assert_eq!(std::fs::symlink_metadata(dir.path().join("d")).unwrap().mtime(), before);
			let opts = MetaOpts { omit_dir_times: false, ..opts };
			let bits = set_file_attrs(&tree, Path::new("d"), &d, None, &opts, 0, &logger).unwrap();
			assert_eq!(bits, ITEM_REPORT_TIME);

			let mut l = entry(tree.lstat(Path::new("l")).unwrap().mode());
			l.mtime = 1_000_000_000;
			let opts = MetaOpts { times: true, omit_link_times: true, ..MetaOpts::default() };
			assert_eq!(set_file_attrs(&tree, Path::new("l"), &l, None, &opts, 0, &logger).unwrap(), 0);
			let opts = MetaOpts { omit_link_times: false, ..opts };
			let bits = set_file_attrs(&tree, Path::new("l"), &l, None, &opts, 0, &logger).unwrap();
			// Either the symlink's own time was set, or the platform cannot.
			assert!(bits == ITEM_REPORT_TIME || bits == ITEM_REPORT_TIMEFAIL, "{bits:#x}");
			if bits == ITEM_REPORT_TIME {
				let link = std::fs::symlink_metadata(dir.path().join("l")).unwrap();
				assert_eq!(link.mtime(), 1_000_000_000);
			}
		}

		#[test]
		fn new_dir_keeps_inherited_setgid_without_perms() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("d");
			std::fs::create_dir(&path).unwrap();
			chmod(&path, 0o2755);
			if mode_of(&path) & S_ISGID == 0 {
				return; // the platform refuses setgid on this directory
			}
			let tree = tree(&dir);
			let (logger, _sink) = logger();
			let mut d = entry(0o040755);
			d.flags |= FLAG_DIR_CREATED;
			let opts = MetaOpts::default();
			let local = tree.lstat(Path::new("d")).unwrap();
			let bits = set_file_attrs(&tree, Path::new("d"), &d, Some(&local), &opts, 0, &logger);
			assert_eq!(bits.unwrap(), 0);
			assert_eq!(mode_of(&path) & 0o7777, 0o2755);
		}

		/// Whether the filesystem under `dir` takes our stat xattr at all.
		fn xattrs_usable(tree: &Tree, rel: &Path) -> bool {
			match tree.set_xattr(rel, OsStr::new(XSTAT_ATTR), b"0 0,0 0:0", false) {
				Ok(()) => {
					tree.remove_xattr(rel, OsStr::new(XSTAT_ATTR), false).unwrap();
					true
				},
				Err(err) if is_no_xattr(&err) || err.kind() == io::ErrorKind::PermissionDenied => false,
				Err(err) => panic!("set_xattr: {err}"),
			}
		}

		#[test]
		fn fake_super_round_trip() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("f");
			std::fs::write(&path, b"data").unwrap();
			chmod(&path, 0o644);
			let tree = tree(&dir);
			let rel = Path::new("f");
			if !xattrs_usable(&tree, rel) {
				return;
			}
			let (logger, _sink) = logger();
			let real = std::fs::symlink_metadata(&path).unwrap();

			assert_eq!(read_fake_stat(&tree, rel).unwrap(), None);
			let stat = FakeStat { mode: 0o104755, rdev_major: 0, rdev_minor: 0, uid: 0, gid: 0 };
			write_fake_stat(&tree, rel, &stat).unwrap();
			assert_eq!(read_fake_stat(&tree, rel).unwrap(), Some(stat));
			let raw = tree.get_xattr(rel, OsStr::new(XSTAT_ATTR), false).unwrap();
			assert_eq!(raw.as_deref(), Some(&b"104755 0,0 0:0"[..]));

			// x_lstat folds the record in only with --fake-super.
			let fake = MetaOpts { fake_super: true, ..MetaOpts::default() };
			let seen = x_lstat(&tree, rel, &fake, &logger).unwrap();
			assert_eq!((seen.mode(), seen.uid(), seen.gid()), (0o104755, Some(0), Some(0)));
			assert_eq!(seen.len(), 4);
			assert_eq!(seen.mtime(), Some(real.mtime()));
			let plain = x_lstat(&tree, rel, &MetaOpts::default(), &logger).unwrap();
			assert_eq!((plain.mode(), plain.uid()), (real.mode(), Some(real.uid())));

			// A corrupt record is fatal (exit 11) with upstream's message.
			tree.set_xattr(rel, OsStr::new(XSTAT_ATTR), b"garbage", false).unwrap();
			let err = read_fake_stat(&tree, rel).unwrap_err();
			let fatal = corrupt_fake_stat(&err).unwrap();
			assert_eq!(fatal.code, RERR_FILEIO);
			let mut want = format!("Corrupt {XSTAT_ATTR} xattr attached to ").into_bytes();
			want.extend_from_slice(&full_fname(&tree, rel));
			want.extend_from_slice(b": \"garbage\"");
			assert_eq!(fatal.message.as_deref(), Some(&*String::from_utf8_lossy(&want)));
			assert!(x_lstat(&tree, rel, &fake, &logger).is_err());
			assert!(corrupt_fake_stat(&io::Error::other("x")).is_none());
		}

		#[test]
		fn fake_super_set_file_attrs() {
			let dir = tempfile::tempdir().unwrap();
			let path = dir.path().join("f");
			std::fs::write(&path, b"data").unwrap();
			chmod(&path, 0o644);
			let tree = tree(&dir);
			let rel = Path::new("f");
			if !xattrs_usable(&tree, rel) {
				return;
			}
			let (logger, _sink) = logger();
			let real = std::fs::symlink_metadata(&path).unwrap();
			let opts = MetaOpts {
				fake_super: true,
				perms: true,
				owner: true,
				group: true,
				..MetaOpts::default()
			};

			// Root-owned setuid file: recorded in the xattr, disk gets plain owner-rw perms.
			let mut e = entry(0o104755);
			e.mtime = real.mtime();
			e.uid = 0;
			e.gid = real.gid().wrapping_add(1);
			let local = x_lstat(&tree, rel, &opts, &logger).unwrap();
			let bits = set_file_attrs(&tree, rel, &e, Some(&local), &opts, 0, &logger).unwrap();
			let mut want = ITEM_REPORT_GROUP | ITEM_REPORT_PERMS;
			if real.uid() != 0 {
				want |= ITEM_REPORT_OWNER;
			}
			assert_eq!(bits, want);
			assert_eq!(mode_of(&path) & 0o7777, 0o755);
			let stored = read_fake_stat(&tree, rel).unwrap().unwrap();
			assert_eq!(stored, FakeStat { mode: 0o104755, rdev_major: 0, rdev_minor: 0, uid: 0, gid: e.gid });
			// Seen through the record, everything already matches.
			let local = x_lstat(&tree, rel, &opts, &logger).unwrap();
			assert_eq!(set_file_attrs(&tree, rel, &e, Some(&local), &opts, 0, &logger).unwrap(), 0);

			// Once the real file says it all, the record goes away.
			let mut plain = entry(0o100644);
			plain.mtime = real.mtime();
			plain.uid = real.uid();
			plain.gid = real.gid();
			set_file_attrs(&tree, rel, &plain, None, &opts, 0, &logger).unwrap();
			assert_eq!(read_fake_stat(&tree, rel).unwrap(), None);
			assert_eq!(mode_of(&path) & 0o7777, 0o644);
		}
	}
}
