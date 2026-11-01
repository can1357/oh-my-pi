//! Receiver-side deletions: `--delete` (before/during/delay/after), `--delete-excluded`,
//! `--force`, `--max-delete`, `--ignore-errors`, and making room for an entry of another
//! type.
//!
//! Behavior follows rsync 3.5.1:
//!
//! - A directory's local entries are read, filtered by the receiver-side rules
//!   (protect/risk; rules that `--delete-excluded` turned sender-only do not protect),
//!   sorted in file-list order and processed in REVERSE order; whatever the file list
//!   lacks (regardless of type) is deleted. Inside a directory that is being deleted,
//!   perishable rules are ignored and anything still excluded keeps the directory
//!   ("cannot delete non-empty directory").
//! - Directories are emptied depth-first before their removal; entries owned by us
//!   without user-write permission get it first (non-root).
//! - `-x` leaves other file systems alone: `cannot delete mount point` (or, with `-xx`,
//!   such directories are not even listed).
//! - Once an I/O error was seen, deletion is skipped (`IO error encountered -- skipping
//!   file deletion`, once) unless `--ignore-errors`.
//! - `--max-delete=N` stops after N deletions; every refused deletion counts as skipped
//!   and [`Deleter::finish`] prints `Deletions stopped due to --max-delete limit (N
//!   skipped)` and sets IOERR_DEL_LIMIT (exit 25).
//! - With `--backup` a deleted non-directory is backed up first (except files that are
//!   themselves backups when there is no `--backup-dir`).
//! - Counts go straight into `ctx.stats.deleted_*` (upstream's `stats`); the
//!   `--max-delete` limit is checked against them. [`Deleter::send_stats`] writes them
//!   as NDX_DEL_STATS.
//! - `--delete-delay` deletions are queued in memory (upstream spools them to an
//!   unlinked temp file) and replayed by [`Deleter::run_delayed`].

use std::{
	collections::HashSet,
	io::{self, Read, Write},
	path::Path,
	sync::{Arc, atomic::Ordering},
};

use crate::rsync::{
	flists::lock,
	ids::effective_uid,
	backup::{self, BackupOutcome},
	consts::{
		DEL_DIR_IS_EMPTY, DEL_FOR_BACKUP, DEL_FOR_DEVICE, DEL_FOR_DIR, DEL_FOR_FILE,
		DEL_FOR_SPECIAL, DEL_FOR_SYMLINK, DEL_MAKE_ROOM, DEL_NO_UID_WRITE, DEL_RECURSE,
		FLAG_CONTENT_DIR, FLAG_TOP_DIR, IOERR_DEL_LIMIT, IOERR_GENERAL, IOERR_VANISHED,
		MAXPATHLEN, NDX_DEL_STATS, S_IFMT, mode_is_device, mode_is_dir, mode_is_lnk,
		mode_is_reg,
	},
	exit::RsyncError,
	filter::{Filters, NameKind, Side, Verdict},
	flist::{FileEntry, f_name_cmp},
	flists::Flists,
	generator::DestTrees,
	log::{Debug as DebugFlag, Info, LogCode},
	meta,
	paths::{self, bytes_path},
	session::Ctx,
	tree::Tree,
	wire::{NdxCodec, WriteExt},
};

/// User-write permission bit.
const S_IWUSR: u32 = 0o200;

/// Outcome of one deletion (upstream `enum delret`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DelResult {
	/// Gone (or already missing, or a dry run): DR_SUCCESS.
	Deleted,
	/// A directory kept because something in it stayed: DR_NOT_EMPTY.
	DirNotEmpty,
	/// Refused by `--max-delete`: DR_AT_LIMIT.
	Skipped,
	/// The removal failed (reported): DR_FAILURE.
	Error,
}

/// Where a deletion happens: a tree plus the prefix names below it are shown (and
/// filtered) with (empty for the destination; the `--backup-dir` text for the backup
/// area).
pub(crate) struct Place<'a> {
	pub tree: &'a Tree,
	pub prefix: &'a [u8],
}

impl Place<'_> {
	fn shown(&self, rel: &[u8]) -> Vec<u8> {
		[self.prefix, rel].concat()
	}
}

/// One local entry of a directory being scanned (upstream get_dirlist output).
struct LocalItem {
	entry: FileEntry,
	/// Path relative to the place's tree.
	rel: Vec<u8>,
	/// A directory on another file system (`-x`).
	mount: bool,
	/// Owned by the effective uid (upstream FLAG_OWNED_BY_US).
	owned: bool,
}

/// A `--delete-delay` record.
struct Delayed {
	rel: Vec<u8>,
	mode: u32,
	flags: u32,
}

/// Receiver-side deletion state: skipped count, the delayed queue, `-x` devices.
pub(crate) struct Deleter {
	skipped: i32,
	delayed: Vec<Delayed>,
	warned_io: bool,
	/// Devices of top-level directories (`-x`).
	top_devs: HashSet<u64>,
	filesystem_dev: Option<u64>,
	/// Perishable rules are ignored inside a directory being deleted.
	ignore_perishable: bool,
	our_uid: Option<u32>,
	/// A fatal error (unreadable merge-file rules) met where no `Result` is returned.
	fatal: Option<RsyncError>,
	/// Opens absolute merge-file names (operator-file walk).
	fs: pi_vfs::BlockingFs,
	insecure_links: bool,
	/// `--confine-root`: merge files must stay below it.
	confine: Option<std::path::PathBuf>,
	/// Resolves the destination root for relative merge-file names.
	paths: crate::host::ShellPaths,
}

/// The DEL_FOR_* flag for an entry of `mode` (upstream get_del_for_flag).
pub(crate) fn del_for_flag(mode: u32) -> u32 {
	if mode_is_reg(mode) {
		DEL_FOR_FILE
	} else if mode_is_dir(mode) {
		DEL_FOR_DIR
	} else if mode_is_lnk(mode) {
		DEL_FOR_SYMLINK
	} else if mode_is_device(mode) {
		DEL_FOR_DEVICE
	} else {
		DEL_FOR_SPECIAL
	}
}

impl Deleter {
	/// Fresh state for one receiving side.
	pub(crate) fn new(ctx: &Ctx) -> Self {
		Self {
			skipped: 0,
			delayed: Vec::new(),
			warned_io: false,
			top_devs: HashSet::new(),
			filesystem_dev: None,
			ignore_perishable: false,
			our_uid: effective_uid(),
			fatal: None,
			fs: ctx.fs.clone(),
			insecure_links: ctx.opts.insecure_links,
			confine: ctx.opts.confine_root.as_ref().map(std::path::PathBuf::from),
			paths: ctx.paths.clone(),
		}
	}

	fn reader<'a>(&'a self, tree: &'a Tree) -> impl Fn(&[u8]) -> io::Result<Option<Vec<u8>>> + 'a {
		let opts = paths::OperatorOpts { insecure: self.insecure_links, confine: self.confine.as_deref() };
		merge_reader(self.paths.resolve(tree.root()), &self.fs, opts)
	}

	/// The device `-x` compares against (upstream `filesystem_dev`), as the generator
	/// sets it for top-level directories.
	pub(crate) fn set_filesystem_dev(&mut self, dev: u64) {
		self.filesystem_dev = Some(dev);
	}

	/// A fatal error met inside [`Deleter::delete_item`] (a dir-merge file of a deleted
	/// directory that could not be parsed); the other entry points return it themselves.
	pub(crate) fn take_fatal(&mut self) -> Option<RsyncError> {
		self.fatal.take()
	}

	/// delete_in_dir: remove what `dir_ndx`'s directory holds locally but the list lacks.
	///
	/// `dir` is the directory entry's name relative to the destination ("." for the
	/// root), `dir_ndx` its global index. Without incremental recursion the whole list
	/// is compared; with it, the segment holding that directory's contents.
	pub(crate) fn delete_in_dir(
		&mut self,
		ctx: &Ctx,
		trees: &DestTrees,
		flists: &Flists,
		filters: &mut Filters,
		dir: &[u8],
		dir_ndx: i32,
	) -> Result<(), RsyncError> {
		let Some(entry) = flists.entry(dir_ndx) else {
			return Ok(());
		};
		let seg = if ctx.inc_recurse { flists.segment_for_dir(dir_ndx) } else { Some(0) };
		let dev = self.dir_dev(ctx, trees, dir);
		self.in_dir(ctx, trees, flists, filters, dir, &entry, seg, dev)?;
		self.take_fatal().map_or(Ok(()), Err)
	}

	/// change_local_filter_dir for an entry that is not a content directory.
	pub(crate) fn note_dir(
		&mut self,
		filters: &mut Filters,
		dir: &[u8],
		depth: usize,
		trees: &DestTrees,
	) -> Result<(), RsyncError> {
		filters.change_dir(Some(dir), depth, &self.reader(&trees.dest))
	}

	/// Leaves every per-directory rule set entered so far (upstream delete_in_dir(NULL)).
	pub(crate) fn leave_all(&mut self, filters: &mut Filters) {
		// Leaving reads nothing, so it cannot fail.
		let _ = filters.change_dir(None, 0, &|_| Ok(None));
	}

	/// delete_item: one path (recursive for dirs per --force rules), backups, logging.
	pub(crate) fn delete_item(
		&mut self,
		ctx: &Ctx,
		trees: &DestTrees,
		filters: &Filters,
		rel: &[u8],
		mode: u32,
		flags: u32,
	) -> DelResult {
		let place = Place { tree: &trees.dest, prefix: b"" };
		self.item(ctx, trees, filters, &place, rel, mode, flags)
	}

	/// --delete-before / --delete-after full pass over every list.
	pub(crate) fn full_pass(
		&mut self,
		ctx: &Ctx,
		trees: &DestTrees,
		flists: &Flists,
		filters: &mut Filters,
	) -> Result<(), RsyncError> {
		// A dry run into a missing destination has nothing to delete (upstream dry_run > 1).
		if ctx.opts.list_only != 0 || trees.dry_missing {
			return Ok(());
		}
		let logger = &ctx.logger;
		for seg in 0..flists.len() {
			let Some(start) = flists.segment_start(seg) else {
				continue;
			};
			let Some(items) = flists.with_segment(seg, |list| {
				list.entries
					.iter()
					.enumerate()
					.filter(|(_, e)| e.is_active())
					.map(|(i, e)| (start + i as i32, e.clone()))
					.collect::<Vec<_>>()
			}) else {
				continue;
			};
			for (ndx, entry) in items {
				ctx.check_cancel()?;
				let name = entry.name();
				let depth = usize::try_from(entry.depth()).unwrap_or(0);
				if entry.flags & FLAG_CONTENT_DIR == 0 {
					filters.change_dir(Some(&name), depth, &self.reader(&trees.dest))?;
					continue;
				}
				if logger.levels().debug(DebugFlag::Del) >= 1 && entry.flags & FLAG_TOP_DIR != 0 {
					logger.rprintf(LogCode::Info, &[&b"deleting in "[..], &name, b"\n"].concat());
				}
				let Ok(path) = bytes_path(&name) else {
					continue;
				};
				let st = match link_stat(ctx, &trees.dest, &path, ctx.opts.keep_dirlinks) {
					Ok(st) if st.is_dir() => st,
					_ => continue,
				};
				let seg_cmp = if ctx.inc_recurse { flists.segment_for_dir(ndx) } else { Some(seg) };
				let dev = st.dev().unwrap_or(0);
				self.in_dir(ctx, trees, flists, filters, &name, &entry, seg_cmp, dev)?;
				if let Some(fatal) = self.take_fatal() {
					return Err(fatal);
				}
			}
		}
		self.leave_all(filters);
		if logger.levels().info(Info::Flist) >= 2 && !ctx.am_server {
			logger.rprintf(LogCode::Info, b"                    \r");
		}
		Ok(())
	}

	/// Replays the --delete-delay queue (each item recursively), in queue order.
	pub(crate) fn run_delayed(
		&mut self,
		ctx: &Ctx,
		trees: &DestTrees,
		filters: &Filters,
	) -> Result<(), RsyncError> {
		let queue = std::mem::take(&mut self.delayed);
		let place = Place { tree: &trees.dest, prefix: b"" };
		for d in queue {
			ctx.check_cancel()?;
			self.item(ctx, trees, filters, &place, &d.rel, d.mode, d.flags | DEL_RECURSE);
			if let Some(fatal) = self.take_fatal() {
				return Err(fatal);
			}
		}
		Ok(())
	}

	/// Writes NDX_DEL_STATS with the counts (protocol ≥ 31). The counts were folded into
	/// `ctx.stats` as the deletions happened; this only transmits them. A batch replay
	/// writes the index as a plain int (upstream write_del_stats).
	pub(crate) fn send_stats(
		&self,
		ctx: &Ctx,
		out: &mut dyn Write,
		ndx: &mut NdxCodec,
	) -> io::Result<()> {
		if ctx.proto.version < 31 {
			return Ok(());
		}
		let (files, dirs, symlinks, devices, specials) = {
			let stats = lock(&ctx.stats);
			(
				stats.deleted_files,
				stats.deleted_dirs,
				stats.deleted_symlinks,
				stats.deleted_devices,
				stats.deleted_specials,
			)
		};
		if ctx.opts.read_batch {
			out.write_int(NDX_DEL_STATS)?;
		} else {
			ndx.write(out, NDX_DEL_STATS)?;
		}
		out.write_varint(files - dirs - symlinks - devices - specials)?;
		out.write_varint(dirs)?;
		out.write_varint(symlinks)?;
		out.write_varint(devices)?;
		out.write_varint(specials)
	}

	/// End of the deletion work: the `--max-delete` warning and IOERR_DEL_LIMIT.
	pub(crate) fn finish(&mut self, ctx: &Ctx) {
		if ctx.opts.max_delete >= 0 && self.skipped > 0 {
			let text =
				format!("Deletions stopped due to --max-delete limit ({} skipped)\n", self.skipped);
			ctx.logger.rprintf(LogCode::Warning, text.as_bytes());
			ctx.io_error.fetch_or(IOERR_DEL_LIMIT, Ordering::Relaxed);
		}
	}

	// ----- the engine ---------------------------------------------------------

	/// The device of the directory being scanned (`-x`); an unreadable directory takes
	/// the current file-system device, like upstream's generator.
	fn dir_dev(&self, ctx: &Ctx, trees: &DestTrees, dir: &[u8]) -> u64 {
		bytes_path(dir)
			.and_then(|p| link_stat(ctx, &trees.dest, &p, ctx.opts.keep_dirlinks))
			.ok()
			.and_then(|st| st.dev())
			.or(self.filesystem_dev)
			.or(trees.dest_dev)
			.unwrap_or(0)
	}

	#[allow(clippy::too_many_arguments, reason = "upstream delete_in_dir's inputs")]
	fn in_dir(
		&mut self,
		ctx: &Ctx,
		trees: &DestTrees,
		flists: &Flists,
		filters: &mut Filters,
		dir: &[u8],
		entry: &FileEntry,
		seg: Option<usize>,
		dev: u64,
	) -> Result<(), RsyncError> {
		ctx.check_cancel()?;
		let logger = &ctx.logger;
		if logger.levels().debug(DebugFlag::Del) >= 2 {
			logger.rprintf(LogCode::Info, &[&b"delete_in_dir("[..], dir, b")\n"].concat());
		}
		if ctx.io_error.load(Ordering::Relaxed) & IOERR_GENERAL != 0 && !ctx.opts.ignore_errors {
			if !self.warned_io {
				logger.rprintf(LogCode::Info, b"IO error encountered -- skipping file deletion\n");
				self.warned_io = true;
			}
			return Ok(());
		}
		let depth = usize::try_from(entry.depth()).unwrap_or(0);
		filters.change_dir(Some(dir), depth, &self.reader(&trees.dest))?;

		if ctx.opts.one_file_system > 0 {
			if entry.flags & FLAG_TOP_DIR != 0 {
				self.top_devs.insert(dev);
				self.filesystem_dev = Some(dev);
			} else if self.filesystem_dev != Some(dev) {
				if !self.top_devs.contains(&dev) {
					return Ok(());
				}
				// A prior top-level directory's device.
				self.filesystem_dev = Some(dev);
			}
		}

		let place = Place { tree: &trees.dest, prefix: b"" };
		let (items, _) = self.dirlist(ctx, filters, &place, dir);
		let Some(seg) = seg else {
			return Ok(());
		};
		let Some(listed) = flists.with_segment(seg, |list| {
			items.iter().map(|it| list.find(&it.rel).is_some()).collect::<Vec<bool>>()
		}) else {
			return Ok(());
		};
		for (item, listed) in items.iter().zip(listed).rev() {
			ctx.check_cancel()?;
			let mode = item.entry.mode;
			if item.mount && mode_is_dir(mode) {
				if logger.levels().info(Info::Mount) >= 1 {
					let text = [&b"cannot delete mount point: "[..], &item.rel, b"\n"].concat();
					logger.rprintf(LogCode::Info, &text);
				}
				continue;
			}
			if listed {
				continue;
			}
			let mut flags = DEL_RECURSE;
			if mode & S_IWUSR == 0 && !ctx.am_root && item.owned {
				flags |= DEL_NO_UID_WRITE;
			}
			if ctx.opts.delete_during == 2 {
				self.delayed.push(Delayed { rel: item.rel.clone(), mode, flags });
			} else {
				self.item(ctx, trees, filters, &place, &item.rel, mode, flags);
				if self.fatal.is_some() {
					break;
				}
			}
		}
		Ok(())
	}

	/// get_dirlist with the receiver's rules: the entries of `dir` in file-list order,
	/// plus how many were excluded while perishable rules are ignored (upstream
	/// non_perishable_cnt).
	fn dirlist(
		&self,
		ctx: &Ctx,
		filters: &Filters,
		place: &Place<'_>,
		dir: &[u8],
	) -> (Vec<LocalItem>, usize) {
		let logger = &ctx.logger;
		let mut excluded = 0usize;
		let Ok(dir_path) = bytes_path(dir) else {
			return (Vec::new(), 0);
		};
		let names = match place.tree.read_dir(&dir_path) {
			Ok(names) => names,
			Err(err) if err.kind() == io::ErrorKind::NotFound => return (Vec::new(), 0),
			Err(err) => {
				ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
				let text = [&b"opendir "[..], &meta::full_fname(place.tree, &dir_path), b" failed"].concat();
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
				return (Vec::new(), 0);
			},
		};
		let root = dir == b".";
		let dirname: Arc<[u8]> = if root { Arc::from(&b""[..]) } else { Arc::from(dir) };
		let remainder = if dir == b"/" { MAXPATHLEN - 1 } else { MAXPATHLEN.saturating_sub(dir.len() + 1) };
		let mut items = Vec::with_capacity(names.len());
		for os_name in names {
			let Some(name) = crate::host::os_bytes(&os_name) else {
				ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
				let shown = crate::host::os_bytes_lossy(&os_name);
				let text = [&b"cannot convert filename: "[..], &place.shown(dir), b"/", &shown, b"\n"].concat();
				logger.rprintf(LogCode::ErrorXfer, &text);
				continue;
			};
			if name == b"." || name == b".." {
				continue;
			}
			if name.len() >= remainder {
				ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
				let over = name.len() - remainder + 1;
				let head = format!("filename overflows max-path len by {over}: ");
				let text = [head.as_bytes(), dir, b"/", name, b"\n"].concat();
				logger.rprintf(LogCode::ErrorXfer, &text);
				continue;
			}
			if name.is_empty() {
				continue;
			}
			let rel = if root { name.to_vec() } else { [dir, b"/", name].concat() };
			let shown = place.shown(&rel);
			let Ok(path) = bytes_path(&rel) else {
				continue;
			};
			let st = match read_stat(ctx, place.tree, &path, &rel) {
				Ok(st) => st,
				Err(err) => {
					let is_excl = |is_dir| {
						let kind = if is_dir { NameKind::Dir } else { NameKind::File };
						filters.check_full(&shown, kind, Side::Receiver, self.ignore_perishable)
							== Verdict::Exclude
					};
					if is_excl(false) || is_excl(true) {
						if self.ignore_perishable && err.kind() != io::ErrorKind::NotFound {
							excluded += 1;
						}
						continue;
					}
					let full = meta::full_fname(place.tree, &path);
					if err.kind() == io::ErrorKind::NotFound {
						ctx.io_error.fetch_or(IOERR_VANISHED, Ordering::Relaxed);
						logger.rprintf(LogCode::Warning, &[&b"file has vanished: "[..], &full, b"\n"].concat());
					} else {
						ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
						let text = [&b"readlink_stat("[..], &full, b") failed"].concat();
						logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					}
					continue;
				},
			};
			let mode = st.mode();
			if mode & S_IFMT == 0 {
				ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
				let full = meta::full_fname(place.tree, &path);
				let text = [&b"skipping file with bogus (zero) st_mode: "[..], &full, b"\n"].concat();
				logger.rprintf(LogCode::Info, &text);
				continue;
			}
			let is_dir = mode_is_dir(mode);
			let mut mount = false;
			if is_dir
				&& ctx.opts.one_file_system > 0
				&& let Some(fs_dev) = self.filesystem_dev
				&& st.dev().unwrap_or(0) != fs_dev
			{
				if ctx.opts.one_file_system > 1 {
					if logger.levels().info(Info::Mount) >= 1 {
						let head = format!("[{}] skipping mount-point dir ", logger.role().name());
						logger.rprintf(LogCode::Info, &[head.as_bytes(), &shown, b"\n"].concat());
					}
					continue;
				}
				mount = true;
			}
			let kind = if is_dir { NameKind::Dir } else { NameKind::File };
			if filters.check_full(&shown, kind, Side::Receiver, self.ignore_perishable) == Verdict::Exclude {
				if self.ignore_perishable {
					excluded += 1;
				}
				continue;
			}
			let owned = match (st.uid(), self.our_uid) {
				(Some(uid), Some(ours)) => uid == ours,
				// No POSIX owners (Windows, some providers): everything is ours.
				_ => true,
			};
			let entry = FileEntry {
				dirname: Arc::clone(&dirname),
				basename: name.into(),
				mode,
				..FileEntry::default()
			};
			items.push(LocalItem { entry, rel, mount, owned });
		}
		let proto = ctx.proto;
		items.sort_by(|a, b| f_name_cmp(&a.entry, &b.entry, proto));
		(items, excluded)
	}

	/// delete_item on any place (the destination, or the backup area for DEL_FOR_BACKUP).
	#[allow(clippy::too_many_arguments, reason = "upstream delete_item plus the place")]
	pub(crate) fn item(
		&mut self,
		ctx: &Ctx,
		trees: &DestTrees,
		filters: &Filters,
		place: &Place<'_>,
		rel: &[u8],
		mode: u32,
		flags: u32,
	) -> DelResult {
		let logger = &ctx.logger;
		let shown = place.shown(rel);
		if logger.levels().debug(DebugFlag::Del) >= 2 {
			let text = format!(") mode={mode:o} flags={flags}\n");
			logger.rprintf(LogCode::Info, &[&b"delete_item("[..], &shown, text.as_bytes()].concat());
		}
		let path = match bytes_path(rel) {
			Ok(path) => path,
			Err(err) => {
				let text = [&b"delete_file: unlink("[..], &shown, b") failed"].concat();
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
				return self.check_ret(ctx, DelResult::Error, flags, &shown);
			},
		};
		if flags & DEL_NO_UID_WRITE != 0 {
			self.chmod(ctx, place.tree, &path, mode | S_IWUSR);
		}
		let ret = 'done: {
			if mode_is_dir(mode) && flags & DEL_DIR_IS_EMPTY == 0 {
				// Only the outermost call: dir_contents recurses with DEL_DIR_IS_EMPTY.
				self.ignore_perishable = true;
				let ret = self.dir_contents(ctx, trees, filters, place, rel, flags);
				self.ignore_perishable = false;
				if matches!(ret, DelResult::DirNotEmpty | DelResult::Skipped) {
					break 'done ret;
				}
			}
			if flags & DEL_MAKE_ROOM == 0 && self.at_limit(ctx) {
				self.skipped += 1;
				return DelResult::Skipped;
			}
			let (what, result): (&str, io::Result<()>) = if mode_is_dir(mode) {
				("rmdir", self.rmdir(ctx, place.tree, &path))
			} else if ctx.opts.make_backups
				&& flags & DEL_FOR_BACKUP == 0
				&& (backup::has_backup_dir(ctx) || !backup::is_backup_file(ctx, rel))
			{
				match backup::make_backup_with(ctx, trees, self, filters, rel, true) {
					Ok(BackupOutcome::Duplicated) => ("unlink", self.unlink(ctx, place.tree, &path)),
					Ok(_) => ("make_backup", Ok(())),
					Err(err) => ("make_backup", Err(err.unwrap_or_else(|| io::Error::other("backup failed")))),
				}
			} else {
				("unlink", self.unlink(ctx, place.tree, &path))
			};
			match result {
				Ok(()) => {
					if flags & DEL_MAKE_ROOM == 0 {
						logger.log_delete(&shown, mode);
						self.count(ctx, mode);
					}
					DelResult::Deleted
				},
				Err(err) if mode_is_dir(mode) && is_not_empty(&err) => {
					let text = [&b"cannot delete non-empty directory: "[..], &shown, b"\n"].concat();
					logger.rprintf(LogCode::Info, &text);
					DelResult::DirNotEmpty
				},
				Err(err) if err.kind() == io::ErrorKind::NotFound => DelResult::Deleted,
				Err(err) => {
					let text = [format!("delete_file: {what}(").as_bytes(), &shown, b") failed"].concat();
					logger.rsyserr(LogCode::ErrorXfer, &err, &text);
					DelResult::Error
				},
			}
		};
		self.check_ret(ctx, ret, flags, &shown)
	}

	/// The "could not make way" report for a failed DEL_FOR_* deletion.
	fn check_ret(&self, ctx: &Ctx, ret: DelResult, flags: u32, shown: &[u8]) -> DelResult {
		if ret != DelResult::Deleted && flags & DEL_MAKE_ROOM != 0 {
			let desc: &[u8] = match flags & DEL_MAKE_ROOM {
				DEL_FOR_FILE => b"regular file",
				DEL_FOR_DIR => b"directory",
				DEL_FOR_SYMLINK => b"symlink",
				DEL_FOR_DEVICE => b"device file",
				_ => b"special file",
			};
			let what: &[u8] = if flags & DEL_FOR_BACKUP != 0 { b"backup" } else { b"new" };
			let text = [&b"could not make way for "[..], what, b" ", desc, b": ", shown, b"\n"].concat();
			ctx.logger.rprintf(LogCode::ErrorXfer, &text);
		}
		ret
	}

	/// delete_dir_contents: empties `rel` (only checks for content without DEL_RECURSE).
	fn dir_contents(
		&mut self,
		ctx: &Ctx,
		trees: &DestTrees,
		filters: &Filters,
		place: &Place<'_>,
		rel: &[u8],
		flags: u32,
	) -> DelResult {
		let logger = &ctx.logger;
		let shown = place.shown(rel);
		if logger.levels().debug(DebugFlag::Del) >= 3 {
			let text = format!(") flags={flags}\n");
			logger.rprintf(LogCode::Info, &[&b"delete_dir_contents("[..], &shown, text.as_bytes()].concat());
		}
		// The directory's own merge files apply to what it contains.
		let local_filters = if filters.saw_dir_merge() || logger.levels().debug(DebugFlag::Filter) >= 2 {
			let mut local = filters.clone();
			let entered = local.enter_dir(&shown, &self.reader(&trees.dest));
			match entered {
				Ok(_) => Some(local),
				Err(err) => {
					self.fatal.get_or_insert(err);
					return DelResult::DirNotEmpty;
				},
			}
		} else {
			None
		};
		let filters = local_filters.as_ref().unwrap_or(filters);

		let (items, excluded) = self.dirlist(ctx, filters, place, rel);
		let mut ret = if excluded > 0 { DelResult::DirNotEmpty } else { DelResult::Deleted };
		'scan: {
			if items.is_empty() {
				break 'scan;
			}
			if flags & DEL_RECURSE == 0 {
				ret = DelResult::DirNotEmpty;
				break 'scan;
			}
			// Our own recursion: delete_item below must not recurse.
			let child_flags =
				(flags & !(DEL_RECURSE | DEL_MAKE_ROOM | DEL_NO_UID_WRITE)) | DEL_DIR_IS_EMPTY;
			for item in items.iter().rev() {
				if ctx.cancel.load(Ordering::Relaxed) || self.fatal.is_some() {
					ret = DelResult::DirNotEmpty;
					break;
				}
				let mode = item.entry.mode;
				if item.mount && mode_is_dir(mode) {
					if logger.levels().debug(DebugFlag::Del) >= 1 {
						let text =
							[&b"mount point, "[..], &place.shown(&item.rel), b", pins parent directory\n"].concat();
						logger.rprintf(LogCode::Info, &text);
					}
					ret = DelResult::DirNotEmpty;
					continue;
				}
				if mode & S_IWUSR == 0 && !ctx.am_root && item.owned
					&& let Ok(path) = bytes_path(&item.rel)
				{
					self.chmod(ctx, place.tree, &path, mode | S_IWUSR);
				}
				if mode_is_dir(mode)
					&& self.dir_contents(ctx, trees, filters, place, &item.rel, child_flags | DEL_RECURSE)
						!= DelResult::Deleted
				{
					ret = DelResult::DirNotEmpty;
				}
				if self.item(ctx, trees, filters, place, &item.rel, mode, child_flags) != DelResult::Deleted {
					ret = DelResult::DirNotEmpty;
				}
			}
		}
		if ret == DelResult::DirNotEmpty {
			let text = [&b"cannot delete non-empty directory: "[..], &shown, b"\n"].concat();
			logger.rprintf(LogCode::Info, &text);
		}
		ret
	}

	fn at_limit(&self, ctx: &Ctx) -> bool {
		let max = ctx.opts.max_delete;
		if max < 0 {
			return false;
		}
		let stats = lock(&ctx.stats);
		stats.deleted_files >= max
	}

	fn count(&self, ctx: &Ctx, mode: u32) {
		let mut stats = lock(&ctx.stats);
		stats.deleted_files += 1;
		if mode_is_dir(mode) {
			stats.deleted_dirs += 1;
		} else if mode_is_lnk(mode) {
			stats.deleted_symlinks += 1;
		} else if mode_is_device(mode) {
			stats.deleted_devices += 1;
		} else if !mode_is_reg(mode) {
			stats.deleted_specials += 1;
		}
	}

	fn chmod(&self, ctx: &Ctx, tree: &Tree, path: &Path, mode: u32) {
		if !ctx.opts.dry_run {
			// Best effort, like upstream's unchecked do_chmod before a removal.
			let _ = tree.chmod(path, mode & 0o7777);
		}
	}

	fn unlink(&self, ctx: &Ctx, tree: &Tree, path: &Path) -> io::Result<()> {
		if ctx.opts.dry_run { Ok(()) } else { tree.unlink(path) }
	}

	fn rmdir(&self, ctx: &Ctx, tree: &Tree, path: &Path) -> io::Result<()> {
		if ctx.opts.dry_run { Ok(()) } else { tree.rmdir(path) }
	}
}

fn is_not_empty(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::DirectoryNotEmpty {
		return true;
	}
	#[cfg(unix)]
	{
		err.raw_os_error() == Some(libc::EEXIST)
	}
	#[cfg(not(unix))]
	{
		false
	}
}

/// upstream link_stat: lstat, or stat with `-L`; with `follow_dirlinks` a symlink to a
/// directory counts as the directory.
fn link_stat(ctx: &Ctx, tree: &Tree, path: &Path, follow_dirlinks: bool) -> io::Result<pi_vfs::Metadata> {
	if ctx.opts.copy_links {
		return tree.stat(path);
	}
	let st = tree.lstat(path)?;
	if follow_dirlinks
		&& st.is_symlink()
		&& let Ok(target) = tree.stat(path)
		&& target.is_dir()
	{
		return Ok(target);
	}
	Ok(st)
}

/// upstream readlink_stat for a directory scan: link_stat with `-k`, and with
/// `--copy-unsafe-links` an unsafe symlink is followed.
fn read_stat(ctx: &Ctx, tree: &Tree, path: &Path, rel: &[u8]) -> io::Result<pi_vfs::Metadata> {
	let st = link_stat(ctx, tree, path, ctx.opts.copy_dirlinks)?;
	if st.is_symlink() {
		let target = tree.read_link(path)?;
		if ctx.opts.copy_unsafe_links && paths::unsafe_symlink(&paths::path_bytes(&target), rel) {
			return tree.stat(path);
		}
	}
	Ok(st)
}

/// Reads per-directory merge files; a missing file is `Ok(None)`.
///
/// Like upstream's parse_filter_file, every name is opened as an operator path (the
/// ownership walk: symlinks owned by root or us are followed) and must stay below
/// `--confine-root`; a relative name starts at the destination directory `base`.
fn merge_reader<'a>(
	base: std::path::PathBuf,
	fs: &'a pi_vfs::BlockingFs,
	opts: paths::OperatorOpts<'a>,
) -> impl Fn(&[u8]) -> io::Result<Option<Vec<u8>>> + 'a {
	move |name: &[u8]| {
		let path = bytes_path(name)?;
		let full = if name.first() == Some(&b'/') || path.is_absolute() {
			path.to_path_buf()
		} else {
			base.join(path)
		};
		let opened = paths::open_operator_file_with(fs, &full, &opts);
		let mut file = match opened {
			Ok(file) => file,
			Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(err) => return Err(err),
		};
		let mut data = Vec::new();
		file.read_to_end(&mut data)?;
		Ok(Some(data))
	}
}

/// Fixtures shared by the deletion and backup tests.
#[cfg(all(test, unix))]
pub(crate) mod test_support {
	use std::{
		fs,
		path::Path,
		sync::{Arc, Mutex},
	};

	use super::*;
	use crate::rsync::{
		filter::{FilterConfig, RuleArg},
		flist::FileList,
		log::{LogConfig, Logger, OutLevels, Role},
		options::Options,
		tree::TreeOpts,
		wire::Proto,
	};

	pub(crate) const DIR: u32 = 0o040755;
	pub(crate) const REG: u32 = 0o100644;

	/// A shared byte sink standing in for stdout and stderr (one stream, emission order).
	#[derive(Clone, Default)]
	pub(crate) struct Sink(Arc<Mutex<Vec<u8>>>);

	impl Write for Sink {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.0.lock().unwrap().extend_from_slice(buf);
			Ok(buf.len())
		}

		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	impl Sink {
		pub(crate) fn text(&self) -> String {
			String::from_utf8_lossy(&self.0.lock().unwrap()).into_owned()
		}
	}

	/// Output settings of a test run.
	pub(crate) struct Out {
		pub verbose: u8,
		pub info: Option<&'static str>,
		pub format: Option<&'static [u8]>,
		pub itemize: u8,
	}

	/// `-n -i`.
	pub(crate) const ITEMIZE: Out = Out { verbose: 0, info: None, format: Some(b"%i %n%L"), itemize: 1 };
	/// `-v`.
	pub(crate) const VERBOSE: Out = Out { verbose: 1, info: None, format: Some(b"%n%L"), itemize: 0 };

	pub(crate) fn put(root: &Path, rel: &str, data: &str) {
		let path = root.join(rel);
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(path, data).unwrap();
	}

	pub(crate) fn link(root: &Path, rel: &str, target: &str) {
		std::os::unix::fs::symlink(target, root.join(rel)).unwrap();
	}

	/// The receiving side of a test run: generator context, destination trees, output.
	pub(crate) fn setup(dest: &Path, opts: Options, out: &Out) -> (Ctx, DestTrees, Sink) {
		let mut levels = OutLevels::from_verbose(out.verbose);
		if let Some(words) = out.info {
			levels.apply_info(words).unwrap();
		}
		let dry_run = opts.dry_run;
		let mut ctx = Ctx::for_tests(opts);
		let sink = Sink::default();
		let cfg = LogConfig {
			levels,
			out_format: out.format.map(<[u8]>::to_vec),
			itemize_changes: out.itemize,
			dry_run,
			..LogConfig::default()
		};
		ctx.logger = Logger::local(Box::new(sink.clone()), Box::new(sink.clone()), cfg)
			.with_role(Role::Generator);
		ctx.proto = Proto::new(33, 0);
		ctx.inc_recurse = false;
		ctx.am_root = false;
		ctx.am_server = false;
		ctx.meta.dry_run = dry_run;
		let dest_tree = Tree::open(&ctx.fs, dest, &TreeOpts::default()).unwrap();
		let trees = DestTrees {
			dest: dest_tree,
			single_file: None,
			partial_dir: None,
			temp_dir: None,
			backup_dir: None,
			alt_dirs: Vec::new(),
			dry_missing: false,
			dest_dev: None,
		};
		(ctx, trees, sink)
	}

	/// Receiver-side rules as the generator holds them after option parsing.
	pub(crate) fn filters(ctx: &Ctx, dest: &Path, rules: &[&[u8]], delete_excluded: bool) -> Filters {
		let cfg = FilterConfig {
			delete_mode: true,
			delete_excluded,
			local_server: true,
			role: Role::Generator,
			..FilterConfig::default()
		};
		let mut filters = Filters::new(cfg);
		for rule in rules {
			filters.add(RuleArg::Filter(rule), &|_| Err(io::ErrorKind::NotFound.into())).unwrap();
		}
		// The client-side exchange resolves which one-sided rules apply locally (a
		// --delete-excluded exclude becomes sender-only); a local copy writes nothing.
		let mut wire = Vec::new();
		filters.send(&mut wire, ctx.proto, true).unwrap();
		filters.set_curr_dir(&paths::path_bytes(dest));
		filters.set_logger(Some(ctx.logger.clone()));
		filters
	}

	pub(crate) fn entry(name: &str, mode: u32, flags: u32) -> FileEntry {
		let name = name.as_bytes();
		let (dirname, basename) = paths::split_name(name);
		FileEntry { dirname: dirname.into(), basename: basename.into(), mode, flags, ..FileEntry::default() }
	}

	/// A sender file list (non-incremental): `.` as the top content dir plus `items`.
	pub(crate) fn flists(ctx: &Ctx, items: &[(&str, u32)]) -> Arc<Flists> {
		let mut entries = vec![entry(".", DIR, FLAG_TOP_DIR | FLAG_CONTENT_DIR)];
		for &(name, mode) in items {
			let flags = if mode_is_dir(mode) { FLAG_CONTENT_DIR } else { 0 };
			entries.push(entry(name, mode, flags));
		}
		let mut list = FileList { entries, ndx_start: 0, parent_ndx: -1 };
		list.sort_and_clean(ctx.proto, false, &ctx.logger);
		let flists = Flists::new();
		flists.push(list);
		flists.set_eof();
		flists
	}

	/// Global index of `name` in segment 0.
	pub(crate) fn ndx_of(flists: &Flists, name: &str) -> i32 {
		flists.with_segment(0, |l| l.find(name.as_bytes())).flatten().unwrap() as i32
	}

	/// `find dir | sort` with contents and link targets.
	pub(crate) fn listing(root: &Path) -> Vec<String> {
		fn walk(root: &Path, rel: &Path, out: &mut Vec<String>) {
			let mut names: Vec<_> =
				fs::read_dir(root.join(rel)).unwrap().map(|e| e.unwrap().file_name()).collect();
			names.sort();
			for name in names {
				let child = rel.join(&name);
				let path = root.join(&child);
				let shown = child.to_string_lossy().into_owned();
				let meta = fs::symlink_metadata(&path).unwrap();
				if meta.file_type().is_symlink() {
					out.push(format!("{shown} -> {}", fs::read_link(&path).unwrap().display()));
				} else if meta.is_dir() {
					out.push(format!("{shown}/"));
					walk(root, &child, out);
				} else {
					out.push(format!("{shown}: {}", fs::read_to_string(&path).unwrap().trim_end()));
				}
			}
		}
		let mut out = Vec::new();
		walk(root, Path::new(""), &mut out);
		out
	}
}

#[cfg(all(test, unix))]
mod tests {
	use std::{fs, path::Path};

	use super::{test_support::*, *};
	use crate::rsync::options::Options;

	/// The destination of the main reference fixture (see each test for the command).
	fn main_fixture(dst: &Path) {
		put(dst, "a", "a");
		put(dst, "sub/s", "s");
		put(dst, "extra", "x");
		put(dst, "keep1", "k");
		put(dst, "excl1", "e");
		put(dst, "excl_r", "r");
		put(dst, "zz", "z");
		put(dst, "sub/yy", "y");
		put(dst, "gone/deep/f", "d");
		put(dst, "gone/g", "g");
		put(dst, "gone/keep2", "kk");
		link(dst, "lnk", "nowhere");
		put(dst, "keepdir/q", "q");
	}

	const MAIN_SRC: &[(&str, u32)] = &[("a", REG), ("sub", DIR), ("sub/s", REG)];
	const MAIN_RULES: &[&[u8]] = &[b"P keep*", b"R excl_r", b"- excl*"];

	fn opts(dry_run: bool) -> Options {
		Options {
			dry_run,
			do_xfers: !dry_run,
			delete_mode: true,
			delete_during: 1,
			recurse: 2,
			..Options::default()
		}
	}

	/// Runs the deletion pass over the main fixture: root first, then `sub`.
	fn run_main(dst: &Path, opts: Options, out: &Out, rules: &[&[u8]], delete_excluded: bool) -> (Ctx, String) {
		let (ctx, trees, sink) = setup(dst, opts, out);
		let mut filters = filters(&ctx, dst, rules, delete_excluded);
		let flists = flists(&ctx, MAIN_SRC);
		let mut del = Deleter::new(&ctx);
		del.full_pass(&ctx, &trees, &flists, &mut filters).unwrap();
		del.finish(&ctx);
		(ctx, sink.text())
	}

	// rsync -r --delete -n -i -f 'P keep*' -f 'R excl_r' -f '- excl*' src/ dst/
	#[test]
	fn protect_exclude_and_risk_match_reference_dry_run() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let before = listing(dir.path());
		let (_, out) = run_main(dir.path(), opts(true), &ITEMIZE, MAIN_RULES, false);
		assert_eq!(
			out,
			"*deleting   gone/deep/f\n*deleting   gone/deep/\n*deleting   gone/g\n\
			 cannot delete non-empty directory: gone\n*deleting   zz\n*deleting   lnk\n\
			 *deleting   extra\n*deleting   excl_r\n*deleting   sub/yy\n"
		);
		assert_eq!(listing(dir.path()), before, "a dry run changes nothing");
	}

	// Same command with -v instead of -n -i.
	#[test]
	fn real_run_leaves_reference_tree_and_counts() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let (ctx, out) = run_main(dir.path(), opts(false), &VERBOSE, MAIN_RULES, false);
		assert_eq!(
			out,
			"deleting gone/deep/f\ndeleting gone/deep/\ndeleting gone/g\n\
			 cannot delete non-empty directory: gone\ndeleting zz\ndeleting lnk\n\
			 deleting extra\ndeleting excl_r\ndeleting sub/yy\n"
		);
		assert_eq!(
			listing(dir.path()),
			[
				"a: a", "excl1: e", "gone/", "gone/keep2: kk", "keep1: k", "keepdir/", "keepdir/q: q",
				"sub/", "sub/s: s",
			]
		);
		let stats = ctx.stats.lock().unwrap();
		assert_eq!(
			(stats.deleted_files, stats.deleted_dirs, stats.deleted_symlinks),
			(8, 1, 1)
		);
	}

	// rsync -r --delete --delete-excluded -n -i -f 'P keep*' -f '- excl*' src/ dst/
	#[test]
	fn delete_excluded_drops_exclude_protection_only() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let rules: &[&[u8]] = &[b"P keep*", b"- excl*"];
		let (_, out) = run_main(dir.path(), opts(true), &ITEMIZE, rules, true);
		assert_eq!(
			out,
			"*deleting   gone/deep/f\n*deleting   gone/deep/\n*deleting   gone/g\n\
			 cannot delete non-empty directory: gone\n*deleting   zz\n*deleting   lnk\n\
			 *deleting   extra\n*deleting   excl_r\n*deleting   excl1\n*deleting   sub/yy\n"
		);
	}

	// rsync -r --delete --max-delete=2 -n -i src/ dst/  (exit 25)
	#[test]
	fn max_delete_stops_and_reports_skipped() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let o = Options { max_delete: 2, ..opts(true) };
		let (ctx, out) = run_main(dir.path(), o, &ITEMIZE, &[], false);
		assert_eq!(
			out,
			"*deleting   keepdir/q\n*deleting   keepdir/\n\
			 cannot delete non-empty directory: gone/deep\ncannot delete non-empty directory: gone\n\
			 Deletions stopped due to --max-delete limit (11 skipped)\n"
		);
		assert_ne!(ctx.io_error.load(Ordering::Relaxed) & IOERR_DEL_LIMIT, 0);
	}

	// rsync -r --delete --max-delete=0 -n -i src/ dst/  (exit 25)
	#[test]
	fn max_delete_zero_deletes_nothing() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let o = Options { max_delete: 0, ..opts(true) };
		let (_, out) = run_main(dir.path(), o, &ITEMIZE, &[], false);
		assert_eq!(
			out,
			"cannot delete non-empty directory: keepdir\n\
			 cannot delete non-empty directory: gone/deep\ncannot delete non-empty directory: gone\n\
			 Deletions stopped due to --max-delete limit (12 skipped)\n"
		);
	}

	// rsync -r --delete -n -i -f '-p *.o' [-f '- core'] src/ dst/
	#[test]
	fn perishable_rules_do_not_keep_a_deleted_directory() {
		for (rules, expected) in [
			(
				&[&b"-p *.o"[..]][..],
				"*deleting   d1/sub/f.o\n*deleting   d1/sub/\n*deleting   d1/f.o\n*deleting   d1/core\n\
				 *deleting   d1/\n",
			),
			(
				&[&b"-p *.o"[..], &b"- core"[..]][..],
				"*deleting   d1/sub/f.o\n*deleting   d1/sub/\n*deleting   d1/f.o\n\
				 cannot delete non-empty directory: d1\n",
			),
		] {
			let dir = tempfile::tempdir().unwrap();
			put(dir.path(), "d1/core", "x");
			put(dir.path(), "d1/f.o", "y");
			put(dir.path(), "d1/sub/f.o", "z");
			let (ctx, trees, sink) = setup(dir.path(), opts(true), &ITEMIZE);
			let mut filters = filters(&ctx, dir.path(), rules, false);
			let flists = flists(&ctx, &[]);
			let mut del = Deleter::new(&ctx);
			del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b".", ndx_of(&flists, ".")).unwrap();
			assert_eq!(sink.text(), expected);
		}
	}

	// rsync -r src/ dst/ where src/d is a file and dst/d a non-empty dir (no --delete/--force)
	#[test]
	fn make_room_without_recursion_keeps_non_empty_dir() {
		let dir = tempfile::tempdir().unwrap();
		put(dir.path(), "d/c", "c");
		let o = Options { delete_mode: false, delete_during: 0, ..opts(false) };
		let (ctx, trees, sink) = setup(dir.path(), o, &VERBOSE);
		let filters = filters(&ctx, dir.path(), &[], false);
		let mut del = Deleter::new(&ctx);
		let ret = del.delete_item(&ctx, &trees, &filters, b"d", DIR, DEL_FOR_FILE);
		assert_eq!(ret, DelResult::DirNotEmpty);
		assert_eq!(
			sink.text(),
			"cannot delete non-empty directory: d\ncould not make way for new regular file: d\n"
		);
		assert_eq!(listing(dir.path()), ["d/", "d/c: c"]);
		assert_eq!(ctx.stats.lock().unwrap().deleted_files, 0);
	}

	// rsync -r --delete -n -i: the make-room deletion logs the contents, not the dir.
	#[test]
	fn make_room_with_recursion_logs_contents_only() {
		let dir = tempfile::tempdir().unwrap();
		put(dir.path(), "d/c", "c");
		let (ctx, trees, sink) = setup(dir.path(), opts(true), &ITEMIZE);
		let filters = filters(&ctx, dir.path(), &[], false);
		let mut del = Deleter::new(&ctx);
		let ret = del.delete_item(&ctx, &trees, &filters, b"d", DIR, DEL_FOR_FILE | DEL_RECURSE);
		assert_eq!(ret, DelResult::Deleted);
		assert_eq!(sink.text(), "*deleting   d/c\n");
	}

	#[test]
	fn io_error_skips_deletion_with_one_notice() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let (ctx, trees, sink) = setup(dir.path(), opts(false), &VERBOSE);
		ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
		let mut filters = filters(&ctx, dir.path(), &[], false);
		let flists = flists(&ctx, MAIN_SRC);
		let mut del = Deleter::new(&ctx);
		let before = listing(dir.path());
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b".", ndx_of(&flists, ".")).unwrap();
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b"sub", ndx_of(&flists, "sub")).unwrap();
		assert_eq!(sink.text(), "IO error encountered -- skipping file deletion\n");
		assert_eq!(listing(dir.path()), before);

		let o = Options { ignore_errors: true, ..opts(false) };
		let (ctx, trees, sink) = setup(dir.path(), o, &VERBOSE);
		ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
		let mut del = Deleter::new(&ctx);
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b"sub", ndx_of(&flists, "sub")).unwrap();
		assert_eq!(sink.text(), "deleting sub/yy\n");
	}

	#[test]
	fn read_only_entries_owned_by_us_are_deleted() {
		let dir = tempfile::tempdir().unwrap();
		put(dir.path(), "ro/f", "f");
		use std::os::unix::fs::PermissionsExt;
		let ro = dir.path().join("ro");
		fs::set_permissions(ro.join("f"), fs::Permissions::from_mode(0o444)).unwrap();
		fs::set_permissions(&ro, fs::Permissions::from_mode(0o555)).unwrap();
		let (ctx, trees, sink) = setup(dir.path(), opts(false), &VERBOSE);
		let mut filters = filters(&ctx, dir.path(), &[], false);
		let flists = flists(&ctx, &[]);
		let mut del = Deleter::new(&ctx);
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b".", ndx_of(&flists, ".")).unwrap();
		assert_eq!(sink.text(), "deleting ro/f\ndeleting ro/\n");
		assert!(listing(dir.path()).is_empty());
	}

	#[test]
	fn delete_delay_queues_until_replayed() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let o = Options { delete_during: 2, ..opts(false) };
		let (ctx, trees, sink) = setup(dir.path(), o, &VERBOSE);
		let mut filters = filters(&ctx, dir.path(), MAIN_RULES, false);
		let flists = flists(&ctx, MAIN_SRC);
		let mut del = Deleter::new(&ctx);
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b".", ndx_of(&flists, ".")).unwrap();
		del.delete_in_dir(&ctx, &trees, &flists, &mut filters, b"sub", ndx_of(&flists, "sub")).unwrap();
		del.leave_all(&mut filters);
		assert_eq!(sink.text(), "");
		assert!(dir.path().join("zz").exists());
		del.run_delayed(&ctx, &trees, &filters).unwrap();
		assert_eq!(
			sink.text(),
			"deleting gone/deep/f\ndeleting gone/deep/\ndeleting gone/g\n\
			 cannot delete non-empty directory: gone\ndeleting zz\ndeleting lnk\n\
			 deleting extra\ndeleting excl_r\ndeleting sub/yy\n"
		);
	}

	/// NDX_DEL_STATS as the reference server generator wrote it after
	/// `rsync -r --delete src/ host:dst/` over the main fixture (14 deletions: 10 files,
	/// 3 dirs, 1 symlink): `ff 02 0a 03 01 00 00`.
	#[test]
	fn del_stats_bytes_match_reference() {
		let dir = tempfile::tempdir().unwrap();
		main_fixture(dir.path());
		let (ctx, _) = run_main(dir.path(), opts(false), &VERBOSE, &[], false);
		let del = Deleter::new(&ctx);
		let mut out = Vec::new();
		let mut ndx = NdxCodec::new(ctx.proto);
		del.send_stats(&ctx, &mut out, &mut ndx).unwrap();
		assert_eq!(out, [0xff, 0x02, 0x0a, 0x03, 0x01, 0x00, 0x00]);

		let mut batch_ctx = ctx.clone();
		let mut o = (*ctx.opts).clone();
		o.read_batch = true;
		batch_ctx.opts = Arc::new(o);
		let mut out = Vec::new();
		del.send_stats(&batch_ctx, &mut out, &mut NdxCodec::new(ctx.proto)).unwrap();
		assert_eq!(out, [0xfd, 0xff, 0xff, 0xff, 0x0a, 0x03, 0x01, 0x00, 0x00]);

		let mut old_ctx = ctx.clone();
		old_ctx.proto = crate::rsync::wire::Proto::new(30, 0);
		let mut out = Vec::new();
		del.send_stats(&old_ctx, &mut out, &mut NdxCodec::new(old_ctx.proto)).unwrap();
		assert!(out.is_empty());
	}

	/// B8: per-directory merge files are opened like upstream's parse_filter_file —
	/// operator paths that may leave the destination (`../rules`), but never past
	/// `--confine-root`, where they read as missing and the rule is dropped.
	#[test]
	fn merge_files_honor_confine_root() {
		let base = tempfile::tempdir().unwrap();
		let base = fs::canonicalize(base.path()).unwrap();
		let root = base.join("root");
		let dest = root.join("dest");
		put(&dest, "inside", "+ x\n");
		put(&root, "rules", "- y\n");
		put(&base, "outside-secret", "secretword\n");

		let (ctx, trees, _) = setup(&dest, opts(false), &VERBOSE);
		let del = Deleter::new(&ctx);
		let read = del.reader(&trees.dest);
		assert_eq!(read(b"inside").unwrap().as_deref(), Some(&b"+ x\n"[..]));
		assert_eq!(read(b"../rules").unwrap().as_deref(), Some(&b"- y\n"[..]));
		assert_eq!(read(b"missing").unwrap(), None);

		let confined = Options { confine_root: Some(root.clone().into_os_string()), ..opts(false) };
		let (ctx, trees, _) = setup(&dest, confined, &VERBOSE);
		let del = Deleter::new(&ctx);
		let read = del.reader(&trees.dest);
		assert_eq!(read(b"../rules").unwrap().as_deref(), Some(&b"- y\n"[..]));
		assert!(!matches!(read(b"../../outside-secret"), Ok(Some(_))), "outside --confine-root");
		let abs = base.join("outside-secret");
		assert!(!matches!(read(abs.to_str().unwrap().as_bytes()), Ok(Some(_))));
	}
}
