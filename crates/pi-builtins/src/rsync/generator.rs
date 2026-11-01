//! The generator: the receiving side's decision maker (upstream generate_files /
//! recv_generator).
//!
//! It walks the received file lists in order and, per entry, brings the destination
//! in line: directories are created (their times/permissions fixed in a final
//! touch-up pass), symlinks, devices, and specials are created or replaced, hard-link
//! followers are linked to their finished leader, and regular files that fail the
//! quick check are requested from the sender together with the block checksums of
//! the best basis file available (the old file, a `--partial-dir` file, a `--fuzzy`
//! match, or a `--compare-dest`/`--copy-dest`/`--link-dest` file). Every request is
//! `ndx`, the itemize flags, an optional basis-type byte and xname, an optional
//! xattr-value request, then a sum header and the block sums.
//!
//! The receiver reports back through a [`SibOut`]/[`SibIn`] pipe of [`Sibling`] items
//! (upstream's receiver→generator pipe): redo requests for files whose checksum failed,
//! successes (forwarded to the sender for `--remove-source-files`, and the trigger for
//! linking hard-link followers), failures, and the end of each phase. The generator
//! drives the phase protocol (NDX_DONE per phase, the redo phase with full-length
//! sums, the `--delay-updates` and late-deletion phases of protocols 29–31+), the
//! `--delete-*` passes through [`crate::rsync::delete::Deleter`], `--list-only`
//! output, and the end-of-run directory touch-up.
//!
//! The generator learns of new file-list segments only through that pipe, and it
//! writes its buffered socket output where upstream's generator process does: when it
//! must read more pipe input and has none queued (`wait_for_receiver`), at the loop
//! checks once the lists are complete, and at the end.
//!
//! The generator keeps its per-entry state (the mode `dest_mode` computes without
//! `-p`, FLAG_FILE_SENT / FLAG_MISSING_DIR / FLAG_DIR_CREATED, hard-link progress) in a
//! private overlay: the shared [`Flists`] entries stay exactly as received, because
//! the receiver thread reads them too (upstream's processes each own a copy).

mod basis;
mod dest;
mod entry;
mod hlinks;
mod listing;
#[cfg(test)]
mod tests;

use std::{
	collections::{HashMap, VecDeque},
	io::{self, Write},
	path::{Path, PathBuf},
	sync::{Arc, Mutex},
	time::{Duration, Instant},
};

use pi_vfs::Metadata;

use crate::rsync::{
	flists::lock,
	ids::effective_uid,
	time::{system_time, unix_now},
	acl::{self, AclReceiver, AclSet},
	consts::{
		FLAG_CONTENT_DIR, FLAG_HLINKED, FLAG_IMPLIED_DIR, FLAG_MISSING_DIR, FLAG_TIME_FAILED,
		MIN_FILECNT_LOOKAHEAD, MSG_SUCCESS, MSK_ALLOW_FLUSH, NDX_DONE, mode_is_dir, mode_is_lnk,
	},
	delete::{DelResult, Deleter},
	exit::{RERR_PROTOCOL, RERR_STREAMIO, RERR_TIMEOUT, RsyncError},
	filter::Filters,
	flist::{FileEntry, Hlink},
	flists::Flists,
	log::{Debug as DebugFlag, Info, LogCode, Logger},
	meta::{self, AttrHooks, MetaOpts},
	mux::MuxWriter,
	options::Options,
	paths::{self, rel_path},
	session::Ctx,
	tree::Tree,
	wire::{NdxCodec, WriteExt},
	xattr::{self, XattrCtx, XattrReceiver, XattrSet},
};

/// Receiver → generator items (upstream's error pipe).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Sibling {
	/// The received file failed its checksum: request it again in the redo phase.
	Redo(i32),
	/// The file was updated (MSG_SUCCESS).
	Success(i32),
	/// The file could not be sent or received (MSG_NO_SEND).
	NoSend(i32),
	/// The receiver finished a phase (upstream's NDX_DONE on the pipe).
	Done,
	/// The run is ending with this exit code.
	ErrorExit(i32),
	/// The receiver read one more file-list segment (upstream forwards its bytes).
	List,
	/// The receiver read NDX_FLIST_EOF.
	ListEof,
}

#[derive(Default)]
struct Outbox {
	/// Upstream `iobuf.msg` of the receiver: MSG_SUCCESS / MSG_REDO / MSG_NO_SEND.
	msgs: Vec<Sibling>,
	/// Upstream `iobuf.out` of the receiver: NDX_DONE, forwarded lists, NDX_FLIST_EOF.
	data: Vec<Sibling>,
}

/// The receiver's end of the receiver → generator pipe. Items are buffered and handed
/// to the generator only where upstream's receiver writes its pipe output: on each
/// refill of its socket input (messages first; data too unless input was already
/// waiting, upstream `perform_io`) and at its `io_flush` calls.
pub(crate) struct SibOut {
	outbox: Mutex<Outbox>,
	tx: flume::Sender<Vec<Sibling>>,
}

impl SibOut {
	/// Queues a message-class item.
	pub(crate) fn msg(&self, item: Sibling) {
		lock(&self.outbox).msgs.push(item);
	}

	/// Queues a data-class item.
	pub(crate) fn data(&self, item: Sibling) {
		lock(&self.outbox).data.push(item);
	}

	/// Hands `item` to the generator at once (an error exit).
	pub(crate) fn send_now(&self, item: Sibling) {
		let _ = self.tx.send(vec![item]);
	}

	/// One `perform_io` pass before reading more socket input: pending messages go out;
	/// pending data too unless `input_ready` (the pass that wrote the messages already
	/// satisfied the read).
	pub(crate) fn refill(&self, input_ready: bool) {
		let mut outbox = lock(&self.outbox);
		let mut batch = std::mem::take(&mut outbox.msgs);
		if batch.is_empty() || !input_ready {
			batch.append(&mut outbox.data);
		}
		drop(outbox);
		if !batch.is_empty() {
			let _ = self.tx.send(batch);
		}
	}

	/// `io_flush(FULL_FLUSH)`: everything queued goes out (messages first).
	pub(crate) fn flush_all(&self) {
		self.refill(false);
	}
}

/// The generator's end of the pipe plus the file-list view it starts with (the lists
/// read before the generator started).
pub(crate) struct SibIn {
	rx: flume::Receiver<Vec<Sibling>>,
	segments: usize,
	eof: bool,
}

impl SibIn {
	/// Everything delivered so far, in order (tests).
	#[cfg(test)]
	pub(crate) fn drain(&self) -> Vec<Sibling> {
		self.rx.try_iter().flatten().collect()
	}
}

/// Creates the receiver → generator pipe; the generator's initial view is the lists
/// `flists` holds now.
pub(crate) fn sib_pipe(flists: &Flists, inc_recurse: bool) -> (Arc<SibOut>, SibIn) {
	let (tx, rx) = flume::unbounded();
	let out = Arc::new(SibOut { outbox: Mutex::new(Outbox::default()), tx });
	let sib_in = SibIn { rx, segments: flists.len(), eof: !inc_recurse || flists.is_eof() };
	(out, sib_in)
}

/// Every local tree the receiving side writes to.
pub(crate) struct DestTrees {
	pub dest: Tree,
	/// Some(name) when the destination is a single non-directory file (get_local_name).
	pub single_file: Option<Vec<u8>>,
	/// --partial-dir (relative ⇒ per-directory).
	pub partial_dir: Option<Vec<u8>>,
	/// --temp-dir.
	pub temp_dir: Option<Tree>,
	/// --backup-dir, when it already existed as a directory at startup (backup.rs
	/// creates a missing one on first use).
	pub backup_dir: Option<Tree>,
	/// --compare-dest/--copy-dest/--link-dest (in order; dirs that could not be opened
	/// are left out, which matches upstream's per-file stat failures).
	pub alt_dirs: Vec<Tree>,
	/// Upstream `dry_run > 1`: under `--dry-run` the destination directory does not
	/// exist, so every entry is missing and nothing may touch `dest`.
	pub dry_missing: bool,
	/// Device of an existing destination directory (upstream `filesystem_dev` for `-x`).
	pub dest_dev: Option<u64>,
}

/// generate_files: per-entry decisions, itemize, sums, phases/redo, deletions (via delete.rs),
/// hard links, dir-time fixups, --list-only listing, NDX_DEL_STATS, final NDX_DONEs.
#[allow(clippy::too_many_arguments, reason = "pinned cross-module contract")]
pub(crate) fn run(
	ctx: &Ctx,
	trees: &DestTrees,
	flists: &Flists,
	xattrs: Arc<Mutex<XattrReceiver>>,
	acls: Arc<Mutex<AclReceiver>>,
	filters: Filters,
	out: &MuxWriter,
	sib: &SibIn,
) -> Result<(), RsyncError> {
	let mut generator = Gen::new(ctx, trees, flists, xattrs, acls, filters, out, sib);
	generator.generate_files()
}

/// Upstream's logcode for name lines: `None` is FNONE.
type Code = Option<LogCode>;

/// What upstream's file-type switch distinguishes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Ftype {
	Reg,
	Symlink,
	Dir,
	Special,
	Device,
	Unsupported,
}

fn ftype_of(mode: u32) -> Ftype {
	use crate::rsync::consts::{mode_is_device, mode_is_reg, mode_is_special};
	if mode_is_reg(mode) {
		Ftype::Reg
	} else if mode_is_lnk(mode) {
		Ftype::Symlink
	} else if mode_is_dir(mode) {
		Ftype::Dir
	} else if mode_is_special(mode) {
		Ftype::Special
	} else if mode_is_device(mode) {
		Ftype::Device
	} else {
		Ftype::Unsupported
	}
}

/// Platforms where a symlink's own permissions can be changed (upstream CAN_CHMOD_SYMLINK).
const CAN_CHMOD_SYMLINK: bool = cfg!(any(
	target_os = "macos",
	target_os = "ios",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "dragonfly"
));
/// A symlink can be hard-linked without following it (upstream CAN_HARDLINK_SYMLINK).
pub(crate) const CAN_HARDLINK_SYMLINK: bool = cfg!(unix);
/// Devices and specials can be hard-linked (upstream CAN_HARDLINK_SPECIAL).
pub(crate) const CAN_HARDLINK_SPECIAL: bool = cfg!(unix);

/// Generator-private changes to a shared entry.
#[derive(Clone, Copy, Debug, Default)]
struct Over {
	set: u32,
	clear: u32,
	mode: Option<u32>,
	/// Upstream F_HL_PREV (also the alt-dest index once FIRST|DONE).
	prev: Option<i32>,
}

/// A path in one of the local trees.
#[derive(Clone)]
struct Loc {
	tree: Tree,
	rel: PathBuf,
	/// The name as upstream prints it (relative for the destination, the joined basis
	/// path for alt dirs).
	disp: Vec<u8>,
}

impl Loc {
	fn full(&self) -> Vec<u8> {
		meta::full_fname(&self.tree, &self.rel)
	}
}

/// The `stat_x` of upstream: a stat plus lazily read xattrs/ACLs of `src`.
#[derive(Default)]
struct Sx {
	st: Option<Metadata>,
	src: Option<(Tree, PathBuf)>,
	xattr: Option<XattrSet>,
	acl: Option<AclSet>,
}

impl Sx {
	fn of(st: Metadata, tree: &Tree, rel: &Path) -> Self {
		Self { st: Some(st), src: Some((tree.clone(), rel.to_path_buf())), xattr: None, acl: None }
	}

	fn mode(&self) -> u32 {
		self.st.as_ref().map_or(0, Metadata::mode)
	}

	fn dev_ino(&self) -> Option<(u64, u64)> {
		self.st.as_ref().and_then(Metadata::file_id).map(|id| (id.dev(), id.ino()))
	}
}

/// Options that the redo pass negates or overrides (upstream's globals toggled in
/// check_for_finished_files).
#[derive(Clone, Copy, Debug)]
struct Toggles {
	csum_length: i32,
	max_size: i64,
	min_size: i64,
	ignore_existing: i32,
	ignore_non_existing: i32,
	update_only: i32,
	always_checksum: i32,
	size_only: i32,
	append_mode: i32,
	make_backups: i32,
	ignore_times: i32,
}

/// A local directory listing entry for `--fuzzy`.
#[derive(Clone, Debug)]
struct FuzzyCand {
	name: Vec<u8>,
	mode: u32,
	size: u64,
	mtime: i64,
	sent: bool,
}

struct Gen<'a> {
	ctx: &'a Ctx,
	opts: &'a Options,
	trees: &'a DestTrees,
	flists: &'a Flists,
	xattrs: Arc<Mutex<XattrReceiver>>,
	acls: Arc<Mutex<AclReceiver>>,
	filters: Filters,
	out: MuxWriter,
	sib: &'a flume::Receiver<Vec<Sibling>>,
	/// Pipe input already read (upstream `iobuf.in` of the generator).
	inbox: VecDeque<Sibling>,
	/// File-list segments the generator has read (upstream: lists it received).
	seen_segments: usize,
	/// The generator read NDX_FLIST_EOF (upstream `flist_eof`).
	seen_eof: bool,
	ndx_out: NdxCodec,
	deleter: Deleter,
	log: Logger,
	meta: MetaOpts,

	itemizing: bool,
	attrs_report: u32,
	code: Code,
	solo: bool,
	dir_tweaking: bool,
	retouch_times: bool,
	retouch_perms: bool,
	loopchk_limit: i32,
	timeset_failed: u32,
	implied_dirs_missing: bool,
	whole_file: bool,
	want_xattr_optim: bool,
	dry_run: bool,
	t: Toggles,
	phase: i32,
	msgdone: u32,
	dflt_perms: u32,
	accurate_time: u32,
	our_uid: Option<u32>,

	parent_dirname: Option<Vec<u8>>,
	prior_dir: Option<Vec<u8>>,
	dry_missing_dir: Option<FileEntry>,
	skip_dir: Option<FileEntry>,
	fuzzy_dirlist: Vec<Option<Vec<FuzzyCand>>>,
	need_fuzzy_dirlist: bool,

	over: HashMap<i32, Over>,
	redo: VecDeque<i32>,
	hlink_list: VecDeque<i32>,
	in_progress: HashMap<usize, i32>,
	to_redo: HashMap<usize, i32>,
	first_seg: usize,
	cur_seg: usize,
	active_files: i32,
	active_bytes: i64,
	touch_counter: i32,
}

fn is_not_found(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::NotFound
}

/// AttrHooks applying the received xattrs and ACLs (set_file_attrs' xattr/ACL steps).
struct Hooks<'g> {
	xattrs: Option<&'g Mutex<XattrReceiver>>,
	acls: Option<&'g Mutex<AclReceiver>>,
	ctx: &'g Ctx,
	filters: &'g Filters,
	logger: &'g Logger,
}

impl AttrHooks for Hooks<'_> {
	fn apply_xattrs(&mut self, tree: &Tree, rel: &Path, entry: &FileEntry) {
		let (Some(xattrs), Some(ndx)) = (self.xattrs, entry.xattr) else {
			return;
		};
		let set = {
			let cache = lock(&xattrs);
			match cache.get(ndx) {
				Some(set) => set.clone(),
				None => return,
			}
		};
		let filters = self.filters;
		let exclude = |name: &[u8]| filters.xattr_excluded(name);
		let filter: Option<&dyn Fn(&[u8]) -> bool> =
			if filters.has_xattr_rules() { Some(&exclude) } else { None };
		let xctx = XattrCtx {
			filter,
			logger: Some(self.logger),
			basis: None,
			am_generator: true,
			local_mode: None,
		};
		let _ = xattr::apply_with(tree, rel, &set, false, self.ctx.xattr_opts, xctx);
	}

	fn apply_acls(
		&mut self,
		tree: &Tree,
		rel: &Path,
		entry: &FileEntry,
		new_mode: u32,
		cur_mode: &mut u32,
	) -> bool {
		let Some(acls) = self.acls else {
			return false;
		};
		let wanted = {
			let cache = lock(&acls);
			cache.get(entry.acl, entry.def_acl)
		};
		let local = acl::read_local_with(tree, rel, *cur_mode, self.ctx.acl_opts, Some(self.logger))
			.unwrap_or_default();
		match acl::apply_with(
			tree,
			rel,
			&wanted,
			&local,
			*cur_mode,
			new_mode,
			self.ctx.acl_opts,
			Some(self.logger),
		) {
			Ok(applied) => {
				*cur_mode = applied.mode;
				applied.changed
			},
			Err(_) => false,
		}
	}
}

impl<'a> Gen<'a> {
	#[allow(clippy::too_many_arguments, reason = "mirrors run()")]
	fn new(
		ctx: &'a Ctx,
		trees: &'a DestTrees,
		flists: &'a Flists,
		xattrs: Arc<Mutex<XattrReceiver>>,
		acls: Arc<Mutex<AclReceiver>>,
		filters: Filters,
		out: &MuxWriter,
		sib: &'a SibIn,
	) -> Self {
		let opts: &Options = &ctx.opts;
		let log = ctx.logger.clone();
		let mut ndx_out = NdxCodec::new(ctx.proto);
		ndx_out.set_role(log.role());
		ndx_out.set_plain_writes(opts.read_batch);
		let mut meta_opts = ctx.meta.clone();
		meta_opts.copy_links = false;
		meta_opts.keep_dirlinks = opts.keep_dirlinks;
		let stdout_has_i = opts.stdout_format_has_i;
		let solo = trees.single_file.is_some();
		let dry_run = opts.dry_run;
		let list_only = opts.list_only != 0;
		let allowed_lull = if opts.io_timeout > 0 { (opts.io_timeout + 1) / 2 } else { 0 };
		let t = Toggles {
			csum_length: crate::rsync::consts::SHORT_SUM_LENGTH as i32,
			max_size: opts.max_size,
			min_size: opts.min_size,
			ignore_existing: i32::from(opts.ignore_existing),
			ignore_non_existing: i32::from(opts.ignore_non_existing),
			update_only: i32::from(opts.update_only),
			always_checksum: i32::from(opts.always_checksum),
			size_only: i32::from(opts.size_only),
			append_mode: opts.append_mode as i32,
			make_backups: i32::from(opts.make_backups),
			ignore_times: i32::from(opts.ignore_times),
		};
		// Upstream forces --whole-file for local copies (unless batching) and whenever
		// the negotiated block checksum is "none"; --append always uses deltas.
		let mut whole_file = opts.whole_file;
		if whole_file < 0 && ctx.local_server && opts.write_batch == 0 {
			whole_file = 1;
		}
		if ctx.xfer_sum == crate::rsync::checksum::CsumType::None {
			whole_file = 1;
		}
		if t.append_mode > 0 || whole_file < 0 {
			whole_file = 0;
		}
		let want_xattr_optim = ctx.proto.version >= 31
			&& !ctx.proto.has(crate::rsync::consts::CF_AVOID_XATTR_OPTIM);
		let deleter = Deleter::new(ctx);
		let our_uid = effective_uid();
		Self {
			ctx,
			opts,
			trees,
			flists,
			xattrs,
			acls,
			filters,
			out: out.clone(),
			sib: &sib.rx,
			inbox: VecDeque::new(),
			seen_segments: sib.segments,
			seen_eof: sib.eof,
			ndx_out,
			deleter,
			log,
			meta: meta_opts,
			itemizing: true,
			attrs_report: if stdout_has_i != 0 { 0 } else { meta::ATTRS_REPORT },
			code: if opts.logfile_format_has_i { None } else { Some(LogCode::Log) },
			solo,
			dir_tweaking: !(list_only || solo || dry_run),
			retouch_times: opts.preserve_mtimes && opts.omit_dir_times == 0,
			retouch_perms: false,
			loopchk_limit: if allowed_lull > 0 { allowed_lull * 5 } else { 200 },
			timeset_failed: meta::symlink_timeset_failed_flags(ctx.proto.version, ctx.am_server),
			implied_dirs_missing: opts.relative_paths > 0
				&& !opts.implied_dirs
				&& ctx.proto.version < 30,
			whole_file: whole_file > 0,
			want_xattr_optim,
			dry_run,
			t,
			phase: 0,
			msgdone: 0,
			dflt_perms: 0o777 & !ctx.umask,
			accurate_time: 0,
			our_uid,
			parent_dirname: None,
			prior_dir: None,
			dry_missing_dir: None,
			skip_dir: None,
			fuzzy_dirlist: vec![None; opts.fuzzy_basis as usize],
			need_fuzzy_dirlist: false,
			over: HashMap::new(),
			redo: VecDeque::new(),
			hlink_list: VecDeque::new(),
			in_progress: HashMap::new(),
			to_redo: HashMap::new(),
			first_seg: 0,
			cur_seg: 0,
			active_files: 0,
			active_bytes: 0,
			touch_counter: 0,
		}
	}

	// ----- small helpers -------------------------------------------------------------

	fn info(&self, flag: Info) -> u8 {
		self.log.levels().info(flag)
	}

	fn debug(&self, flag: DebugFlag) -> u8 {
		self.log.levels().debug(flag)
	}

	fn say(&self, code: LogCode, text: &[u8]) {
		self.log.rprintf(code, text);
	}

	fn say_code(&self, code: Code, text: &[u8]) {
		if let Some(code) = code {
			self.log.rprintf(code, text);
		}
	}

	fn stdout_has_i(&self) -> u32 {
		self.opts.stdout_format_has_i
	}

	fn hard_links(&self) -> bool {
		self.opts.preserve_hard_links > 0
	}

	fn inc(&self) -> bool {
		self.ctx.inc_recurse
	}

	fn am_root(&self) -> bool {
		self.opts.am_root != 0
	}

	fn check_cancel(&self) -> Result<(), RsyncError> {
		self.ctx.check_cancel()?;
		let stop_at = self.opts.stop_at_utime;
		if stop_at != 0 && unix_now() >= stop_at {
			return Err(RsyncError::new(RERR_TIMEOUT, "stopping at requested limit").at("io.c", 945));
		}
		Ok(())
	}

	/// The entry as the generator sees it (shared entry + private overlay).
	fn file(&self, key: i32) -> Option<FileEntry> {
		let mut e = self.flists.entry(key)?;
		if let Some(o) = self.over.get(&key) {
			e.flags = (e.flags & !o.clear) | o.set;
			if let Some(mode) = o.mode {
				e.mode = mode;
			}
			if let (Some(prev), Hlink::Linked { gnum, .. }) = (o.prev, e.hlink) {
				e.hlink = Hlink::Linked { gnum, prev };
			}
		}
		Some(e)
	}

	fn file_or_err(&self, key: i32, site: &str) -> Result<FileEntry, RsyncError> {
		self.file(key).ok_or_else(|| self.ndx_error(key, site))
	}

	fn ndx_error(&self, ndx: i32, site: &str) -> RsyncError {
		let first = self.flists.segment_start(self.first_seg).map_or(0, |s| s - 1);
		let last = self.flists.last_ndx();
		RsyncError::new(
			RERR_PROTOCOL,
			format!(
				"File-list index {ndx} not in {first} - {last} ({site}) [{}]",
				self.log.role().name()
			),
		)
		.at("rsync.c", 982)
	}

	fn add_flags(&mut self, key: i32, flags: u32) {
		let o = self.over.entry(key).or_default();
		o.set |= flags;
		o.clear &= !flags;
	}

	fn clear_flags(&mut self, key: i32, flags: u32) {
		let o = self.over.entry(key).or_default();
		o.clear |= flags;
		o.set &= !flags;
	}

	fn set_mode(&mut self, key: i32, mode: u32) {
		self.over.entry(key).or_default().mode = Some(mode);
	}

	fn hl_prev(&self, key: i32) -> i32 {
		if let Some(prev) = self.over.get(&key).and_then(|o| o.prev) {
			return prev;
		}
		match self.flists.entry(key).map(|e| e.hlink) {
			Some(Hlink::Linked { prev, .. }) => prev,
			_ => -1,
		}
	}

	fn set_hl_prev(&mut self, key: i32, prev: i32) {
		self.over.entry(key).or_default().prev = Some(prev);
	}

	/// flist_for_ndx: the generator-live segment holding `ndx` (gap index included).
	fn seg_for(&self, ndx: i32) -> Option<usize> {
		(self.first_seg..self.seen_segments).find(|&seg| {
			let (Some(start), Some(len)) = (self.flists.segment_start(seg), self.flists.segment_len(seg))
			else {
				return false;
			};
			ndx >= start - 1 && ndx < start + len as i32
		})
	}

	fn bump(map: &mut HashMap<usize, i32>, seg: usize, by: i32) {
		*map.entry(seg).or_insert(0) += by;
	}

	/// The destination-relative location of a received name.
	fn dest_loc(&self, name: &[u8]) -> io::Result<Loc> {
		Ok(Loc { tree: self.trees.dest.clone(), rel: rel_path(name)?, disp: name.to_vec() })
	}

	fn alt_loc(&self, j: usize, name: &[u8]) -> io::Result<Loc> {
		let tree = self.trees.alt_dirs[j].clone();
		let rel = rel_path(name)?;
		let disp = paths::path_bytes(&tree.root().join(&rel)).into_owned();
		Ok(Loc { tree, rel, disp })
	}

	fn full(&self, name: &[u8]) -> Vec<u8> {
		match rel_path(name) {
			Ok(rel) => meta::full_fname(&self.trees.dest, &rel),
			Err(_) => [&b"\""[..], name, b"\""].concat(),
		}
	}

	/// link_stat without following (fake-super folded in), optionally following a
	/// final symlink to a directory (-K).
	fn stat_loc(&self, tree: &Tree, rel: &Path, follow_dirlinks: bool) -> io::Result<Metadata> {
		let st = meta::x_lstat(tree, rel, &self.meta, &self.log)?;
		if follow_dirlinks && st.is_symlink() {
			if let Ok(target) = tree.stat(rel) {
				if target.is_dir() {
					return Ok(target);
				}
			}
		}
		Ok(st)
	}

	/// set_file_attrs with this run's xattr/ACL hooks. A symlink whose time could not be
	/// set gets FLAG_TIME_FAILED (upstream sets it inside set_file_attrs).
	fn set_attrs(
		&mut self,
		key: i32,
		loc: &Loc,
		file: &FileEntry,
		local: Option<&Metadata>,
		flags: u32,
		with_xattrs: bool,
	) -> Result<u32, RsyncError> {
		let mut opts = self.meta.clone();
		opts.xattrs = opts.xattrs && with_xattrs;
		let mut hooks = Hooks {
			xattrs: opts.xattrs.then_some(&*self.xattrs),
			acls: opts.acls.then_some(&*self.acls),
			ctx: self.ctx,
			filters: &self.filters,
			logger: &self.log,
		};
		let result =
			meta::set_file_attrs_with(&loc.tree, &loc.rel, file, local, &opts, flags, &self.log, &mut hooks);
		match result {
			Ok(bits) => {
				if bits & crate::rsync::consts::ITEM_REPORT_TIMEFAIL != 0 && mode_is_lnk(file.mode) {
					self.add_flags(key, FLAG_TIME_FAILED);
				}
				Ok(bits)
			},
			Err(err) => match meta::corrupt_fake_stat(&err) {
				Some(fatal) => Err(fatal),
				None => Ok(0),
			},
		}
	}

	/// delete_item through the Deleter; true when the path is gone (DR_SUCCESS).
	fn delete(&mut self, name: &[u8], mode: u32, flags: u32) -> Result<bool, RsyncError> {
		let result = self.deleter.delete_item(self.ctx, self.trees, &self.filters, name, mode, flags);
		if let Some(fatal) = self.deleter.take_fatal() {
			return Err(fatal);
		}
		Ok(result == DelResult::Deleted)
	}

	fn write_ndx(&mut self, ndx: i32) -> Result<(), RsyncError> {
		let wire = if ndx >= 0 { self.flists.to_wire(ndx) } else { ndx };
		self.ndx_out.write(&mut self.out, wire).map_err(RsyncError::from_stream)
	}

	/// io_flush: writes buffered output and, in the same `perform_io` passes, reads the
	/// pipe input that is waiting. Nothing happens when nothing is buffered.
	fn flush(&mut self) -> Result<(), RsyncError> {
		if !self.out.output_pending() {
			return Ok(());
		}
		self.out.flush().map_err(RsyncError::from_stream)?;
		self.pull_input();
		Ok(())
	}

	/// Moves every batch the receiver has delivered into the inbox (no waiting).
	fn pull_input(&mut self) {
		while let Ok(batch) = self.sib.try_recv() {
			self.inbox.extend(batch);
		}
	}

	/// Entries in the lists the generator has read and not finished (upstream
	/// `file_total` in the generator process).
	fn view_file_total(&self) -> usize {
		(self.first_seg..self.seen_segments).filter_map(|seg| self.flists.segment_len(seg)).sum()
	}

	/// send_msg_success: tells the sender a file is done (for --remove-source-files).
	///
	/// With `--only-write-batch` nothing has been duplicated on this side yet, so success
	/// is never turned into a sender-side removal (upstream send_msg_success).
	fn send_success(&mut self, name: &[u8], ndx: i32) -> Result<(), RsyncError> {
		if self.opts.write_batch < 0 && self.opts.remove_source_files != 0 {
			return Ok(());
		}
		let wire = self.flists.to_wire(ndx);
		let mut payload = wire.to_le_bytes().to_vec();
		if self.ctx.local_server {
			let (dev, ino) = rel_path(name)
				.ok()
				.filter(|_| self.opts.remove_source_files != 0)
				.and_then(|rel| self.trees.dest.stat(&rel).ok())
				.and_then(|st| st.file_id())
				.map_or((0, 0), |id| (id.dev(), id.ino()));
			payload.extend_from_slice(&dev.to_le_bytes());
			payload.extend_from_slice(&ino.to_le_bytes());
		}
		self.out.send_msg(MSG_SUCCESS, &payload).map_err(RsyncError::from_stream)
	}

	/// Upstream's loop-check keepalive / maybe_flush_socket(0) between entries. Without
	/// `--timeout` upstream's `last_io_out` never advances, so once the lists are
	/// complete every loop check flushes buffered data.
	fn loopchk(&mut self) -> Result<(), RsyncError> {
		if self.opts.io_timeout > 0 {
			self.out.maybe_keepalive(MSK_ALLOW_FLUSH).map_err(RsyncError::from_stream)
		} else if self.seen_eof && self.out.data_pending() {
			self.flush()
		} else {
			Ok(())
		}
	}

	// ----- the receiver side channel -----------------------------------------------

	/// wait_for_receiver: handles the next item from the receiver (one message, a
	/// phase end, or one more file list). Pipe input already read is handled without
	/// any I/O; otherwise the generator refills like upstream's `perform_io`.
	fn wait_for_receiver(&mut self) -> Result<(), RsyncError> {
		if self.inbox.is_empty() {
			self.refill()?;
		}
		match self.inbox.pop_front() {
			Some(item) => self.handle_sibling(item),
			None => self.sibling_gone(),
		}
	}

	/// perform_io for more pipe input. The first pass writes the messages sent since the
	/// last output pass, or else the buffered data; when it wrote messages and input
	/// was already waiting, the data stays buffered. Then every waiting batch is read,
	/// blocking (with keepalives) until one arrives.
	fn refill(&mut self) -> Result<(), RsyncError> {
		let ready = !self.sib.is_empty();
		self.out.output_pass(ready).map_err(RsyncError::from_stream)?;
		self.pull_input();
		// Output keeps going out while later passes wait for input; what is still
		// unwritten when input arrives waits for the next pass, as upstream's.
		let _grant = self.inbox.is_empty().then(|| self.out.grant());
		let mut last_idle = Instant::now();
		while self.inbox.is_empty() {
			self.check_cancel()?;
			match self.sib.recv_timeout(Duration::from_millis(100)) {
				Ok(batch) => {
					self.inbox.extend(batch);
					self.pull_input();
				},
				Err(flume::RecvTimeoutError::Disconnected) => return Ok(()),
				Err(flume::RecvTimeoutError::Timeout) => {
					if last_idle.elapsed() >= Duration::from_millis(500) {
						last_idle = Instant::now();
						self.out.idle(MSK_ALLOW_FLUSH).map_err(|e| self.log.io_error(&e, RERR_STREAMIO, 0))?;
					}
				},
			}
		}
		Ok(())
	}

	/// The receiver thread went away while the generator still waits on it.
	fn sibling_gone(&self) -> Result<(), RsyncError> {
		self.check_cancel()?;
		Err(RsyncError::bare(RERR_STREAMIO).at("io.c", 1976))
	}

	fn handle_sibling(&mut self, msg: Sibling) -> Result<(), RsyncError> {
		match msg {
			Sibling::Done => {
				self.msgdone += 1;
				Ok(())
			},
			Sibling::ErrorExit(code) => Err(RsyncError::bare(code)),
			Sibling::Redo(ndx) => self.entry_status(Status::Redo, ndx),
			Sibling::Success(ndx) => self.entry_status(Status::Success, ndx),
			Sibling::NoSend(ndx) => self.entry_status(Status::NoSend, ndx),
			Sibling::List => {
				self.seen_segments += 1;
				Ok(())
			},
			Sibling::ListEof => {
				self.seen_eof = true;
				Ok(())
			},
		}
	}

	/// got_flist_entry_status.
	fn entry_status(&mut self, status: Status, ndx: i32) -> Result<(), RsyncError> {
		let Some(seg) = self.seg_for(ndx) else {
			return Err(self.ndx_error(ndx, "got_flist_entry_status"));
		};
		let start = self.flists.segment_start(seg).unwrap_or(0);
		if ndx < start {
			return Err(RsyncError::bare(RERR_PROTOCOL).at("io.c", 1230));
		}
		let file = self.file_or_err(ndx, "got_flist_entry_status")?;
		if self.opts.remove_source_files != 0 {
			self.active_files -= 1;
			self.active_bytes -= file.size as i64;
		}
		if self.inc() {
			Self::bump(&mut self.in_progress, seg, -1);
		}
		match status {
			Status::Success | Status::NoSend => {
				if status == Status::Success
					&& self.opts.remove_source_files != 0
					&& self.opts.write_batch >= 0
				{
					let name = self.solo_or_name(&file);
					self.send_success(&name, ndx)?;
				}
				if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
					if status == Status::NoSend {
						self.hlink_list.push_back(-2);
					}
					self.hlink_list.push_back(ndx);
					if self.inc() {
						Self::bump(&mut self.in_progress, seg, 1);
					}
				}
			},
			Status::Redo => {
				if self.opts.read_batch {
					if self.inc() {
						Self::bump(&mut self.in_progress, seg, 1);
					}
				} else {
					if self.inc() {
						Self::bump(&mut self.to_redo, seg, 1);
					}
					self.redo.push_back(ndx);
				}
			},
		}
		Ok(())
	}

	fn solo_or_name(&self, file: &FileEntry) -> Vec<u8> {
		match &self.trees.single_file {
			Some(name) => name.clone(),
			None => file.name(),
		}
	}

	/// increment_active_files: throttles --remove-source-files bookkeeping.
	fn increment_active_files(&mut self, file: &FileEntry) -> Result<(), RsyncError> {
		loop {
			let limit = if self.active_bytes >= 128 * 1024 { 10 } else { 50 };
			if self.active_files < limit {
				break;
			}
			self.check_for_finished_files(false)?;
			if self.active_files < limit {
				break;
			}
			self.wait_for_receiver()?;
		}
		self.active_files += 1;
		self.active_bytes += file.size as i64;
		Ok(())
	}

	// ----- phases --------------------------------------------------------------------

	fn check_for_finished_files(&mut self, check_redo: bool) -> Result<(), RsyncError> {
		loop {
			if self.hard_links()
				&& let Some(mut ndx) = self.hlink_list.pop_front()
			{
				let send_failed = ndx == -2;
				if send_failed {
					ndx = self.hlink_list.pop_front().unwrap_or(-1);
				}
				let Some(seg) = self.seg_for(ndx) else {
					return Err(self.ndx_error(ndx, "check_for_finished_files.1"));
				};
				if ndx < self.flists.segment_start(seg).unwrap_or(0) {
					return Err(RsyncError::bare(RERR_PROTOCOL).at("generator.c", 2635));
				}
				if send_failed {
					self.handle_skipped_hlink(ndx)?;
				} else {
					let file = self.file_or_err(ndx, "check_for_finished_files.1")?;
					let name = file.name();
					self.finish_hard_link(ndx, &name, ndx, None, self.itemizing, self.code, -1)?;
				}
				Self::bump(&mut self.in_progress, seg, -1);
				continue;
			}

			if check_redo && let Some(ndx) = self.redo.pop_front() {
				let saved = self.t;
				self.t.csum_length = crate::rsync::consts::SUM_LENGTH as i32;
				self.t.max_size = -1;
				self.t.min_size = -1;
				self.t.ignore_existing = -self.t.ignore_existing;
				self.t.ignore_non_existing = -self.t.ignore_non_existing;
				self.t.update_only = -self.t.update_only;
				self.t.always_checksum = -self.t.always_checksum;
				self.t.size_only = -self.t.size_only;
				self.t.append_mode = -self.t.append_mode;
				self.t.make_backups = -self.t.make_backups;
				self.t.ignore_times += 1;

				let saved_seg = self.cur_seg;
				let Some(seg) = self.seg_for(ndx) else {
					return Err(self.ndx_error(ndx, "check_for_finished_files.2"));
				};
				if ndx < self.flists.segment_start(seg).unwrap_or(0) {
					return Err(RsyncError::bare(RERR_PROTOCOL).at("generator.c", 2665));
				}
				self.cur_seg = seg;
				let file = self.file_or_err(ndx, "check_for_finished_files.2")?;
				let fname = self.solo_or_name(&file);
				let result = self.recv_generator(&fname, ndx, ndx, self.itemizing, self.code);
				Self::bump(&mut self.to_redo, seg, -1);
				self.cur_seg = saved_seg;
				self.t = saved;
				result?;
				continue;
			}

			if self.cur_seg == self.first_seg {
				break;
			}
			// Only reachable with incremental recursion.
			let first = self.first_seg;
			if self.in_progress.get(&first).copied().unwrap_or(0) > 0
				|| self.to_redo.get(&first).copied().unwrap_or(0) > 0
			{
				break;
			}
			// Upstream follows this with maybe_flush_socket(important), but only while the
			// lists are still arriving, and that function flushes only after the last list
			// arrived: it never flushes here.
			self.write_ndx(NDX_DONE)?;
			if self.opts.delete_during != 2 && self.dir_tweaking {
				let parent = self.flists.segment_parent(first).unwrap_or(-1);
				if parent >= 0 {
					self.touch_up_dir(parent, parent)?;
				}
			}
			self.first_seg += 1;
		}
		Ok(())
	}

	fn generate_files(&mut self) -> Result<(), RsyncError> {
		if self.debug(DebugFlag::Genr) >= 1 {
			let text = format!("generator starting pid={}\n", std::process::id());
			self.say(LogCode::Info, text.as_bytes());
		}
		if let Some(dev) = self.trees.dest_dev {
			self.deleter.set_filesystem_dev(dev);
		}
		let list_only = self.opts.list_only != 0;
		if self.opts.delete_before
			&& !self.solo
			&& !list_only
			&& !self.trees.dry_missing
			&& self.flists.segment_len(0).unwrap_or(0) > 0
		{
			self.deleter.full_pass(self.ctx, self.trees, self.flists, &mut self.filters)?;
		}
		if self.debug(DebugFlag::Flist) >= 1 {
			let how = if self.whole_file {
				"disabled for local transfer or --whole-file"
			} else {
				"enabled"
			};
			self.say(LogCode::Info, format!("delta-transmission {how}\n").as_bytes());
		}

		let mut next_loopchk = 0i32;
		self.cur_seg = 0;
		'lists: loop {
			// Upstream's cur_flist always exists here; this only guards an empty view.
			while self.cur_seg >= self.seen_segments {
				if self.seen_eof {
					self.cur_seg = self.seen_segments;
					break 'lists;
				}
				self.wait_for_receiver()?;
			}
			if self.hard_links() && self.inc() {
				while !self.seen_eof && (self.view_file_total() as i32) < MIN_FILECNT_LOOKAHEAD / 2 {
					self.wait_for_receiver()?;
				}
			}
			let start = self.flists.segment_start(self.cur_seg).unwrap_or(0);
			let len = self.flists.segment_len(self.cur_seg).unwrap_or(0) as i32;
			let parent = self.flists.segment_parent(self.cur_seg).unwrap_or(-1);
			if self.inc() && parent >= 0 {
				if let Some(fp) = self.file(parent) {
					let fbuf = self.solo_or_name(&fp);
					self.recv_generator(&fbuf, parent, start - 1, self.itemizing, self.code)?;
					let fp = self.file(parent).unwrap_or(fp);
					if self.opts.delete_during != 0
						&& !self.trees.dry_missing
						&& !list_only
						&& fp.flags & FLAG_MISSING_DIR == 0
					{
						self.delete_dir_contents(&fbuf, parent, &fp)?;
					}
				}
			}
			for i in 0..len {
				self.check_cancel()?;
				let ndx = start + i;
				let Some(file) = self.file(ndx) else {
					continue;
				};
				if !file.is_active() {
					continue;
				}
				let fname = self.solo_or_name(&file);
				self.recv_generator(&fname, ndx, ndx, self.itemizing, self.code)?;
				self.check_for_finished_files(false)?;
				if ndx >= next_loopchk {
					self.loopchk()?;
					next_loopchk += self.loopchk_limit;
				}
			}

			if !self.inc() {
				self.write_ndx(NDX_DONE)?;
				break;
			}
			loop {
				self.check_for_finished_files(true)?;
				if self.seen_segments > self.cur_seg + 1 || self.seen_eof {
					break;
				}
				self.wait_for_receiver()?;
			}
			if self.seen_segments <= self.cur_seg + 1 {
				// Upstream's cur_flist becomes NULL here, so check_for_finished_files
				// frees (and sends NDX_DONE for) every remaining list, the last included.
				self.cur_seg = self.seen_segments;
				break;
			}
			self.cur_seg += 1;
		}

		if self.opts.delete_during != 0 {
			self.deleter.leave_all(&mut self.filters);
		}
		self.next_phase()?;

		loop {
			self.check_for_finished_files(true)?;
			if self.msgdone > 0 {
				break;
			}
			self.wait_for_receiver()?;
		}

		self.next_phase()?;
		let early_delay = !self.opts.delay_updates;
		let early_delete = !(self.opts.delete_during == 2 || self.opts.delete_after);
		let del_stats = self.opts.delete_mode || self.opts.force_delete || self.opts.read_batch;
		let proto = self.ctx.proto.version;

		self.write_ndx(NDX_DONE)?;
		if early_delay {
			self.write_ndx(NDX_DONE)?;
		}
		if proto >= 31 && early_delete {
			if del_stats {
				self.send_del_stats()?;
			}
			if early_delay {
				self.write_ndx(NDX_DONE)?;
			}
		}

		loop {
			self.check_for_finished_files(false)?;
			if self.msgdone > 1 {
				break;
			}
			self.wait_for_receiver()?;
		}

		self.next_phase()?;
		if !early_delay {
			self.write_ndx(NDX_DONE)?;
			if proto >= 31 && early_delete {
				self.write_ndx(NDX_DONE)?;
			}
		}
		while self.msgdone == 2 {
			self.wait_for_receiver()?;
		}

		if self.opts.delete_during == 2 {
			self.deleter.run_delayed(self.ctx, self.trees, &self.filters)?;
		}
		if self.opts.delete_after
			&& !self.solo
			&& !list_only
			&& !self.trees.dry_missing
			&& self.flists.file_total() > 0
		{
			self.deleter.full_pass(self.ctx, self.trees, self.flists, &mut self.filters)?;
		}
		self.deleter.finish(self.ctx);

		if proto >= 31 {
			if !early_delete {
				if del_stats {
					self.send_del_stats()?;
				}
				self.write_ndx(NDX_DONE)?;
			}
			while self.msgdone == 3 {
				self.wait_for_receiver()?;
			}
		}

		if (self.retouch_perms || self.retouch_times)
			&& self.dir_tweaking
			&& (!self.inc() || self.opts.delete_during == 2)
		{
			self.touch_up_all_dirs()?;
		}
		if self.debug(DebugFlag::Genr) >= 1 {
			self.say(LogCode::Info, b"generate_files finished\n");
		}
		self.flush()
	}

	fn next_phase(&mut self) -> Result<(), RsyncError> {
		self.phase += 1;
		if self.debug(DebugFlag::Genr) >= 1 {
			let text = format!("generate_files phase={}\n", self.phase);
			self.say(LogCode::Info, text.as_bytes());
		}
		Ok(())
	}

	fn send_del_stats(&mut self) -> Result<(), RsyncError> {
		let mut out = self.out.clone();
		self.deleter.send_stats(self.ctx, &mut out, &mut self.ndx_out).map_err(RsyncError::from_stream)
	}

	/// Per-directory deletion (or just the filter-dir change for a non-content dir).
	fn delete_dir_contents(&mut self, fname: &[u8], key: i32, dir: &FileEntry) -> Result<(), RsyncError> {
		if dir.flags & FLAG_CONTENT_DIR != 0 {
			self.deleter.delete_in_dir(self.ctx, self.trees, self.flists, &mut self.filters, fname, key)
		} else {
			let depth = usize::try_from(dir.depth()).unwrap_or(0);
			self.deleter.note_dir(&mut self.filters, fname, depth, self.trees)
		}
	}

	// ----- directory touch-up ------------------------------------------------------

	fn touch_up_all_dirs(&mut self) -> Result<(), RsyncError> {
		if self.inc() {
			for dir_idx in 0..self.flists.dir_count() {
				if let Some(ndx) = self.flists.dir_ndx(dir_idx) {
					self.touch_up_dir(ndx, dir_idx as i32)?;
				}
			}
		} else {
			let len = self.flists.segment_len(0).unwrap_or(0) as i32;
			let start = self.flists.segment_start(0).unwrap_or(0);
			for i in 0..len {
				self.touch_up_dir(start + i, i)?;
			}
		}
		Ok(())
	}

	/// touch_up_dirs for one entry: restore the permissions tweaked for writing and the
	/// modification time the transfer disturbed.
	fn touch_up_dir(&mut self, key: i32, index: i32) -> Result<(), RsyncError> {
		self.touch_counter += 1;
		let Some(file) = self.file(key) else {
			return Ok(());
		};
		if !file.is_active() || !file.is_dir() || (!self.opts.implied_dirs && file.flags & FLAG_IMPLIED_DIR != 0) {
			return Ok(());
		}
		let fname = file.name();
		if self.debug(DebugFlag::Time) >= 2 {
			let text = [&b"touch_up_dirs: "[..], &fname, format!(" ({index})\n").as_bytes()].concat();
			self.say(LogCode::Info, &text);
		}
		let fix_dir_perms = !self.am_root() && file.mode & 0o200 == 0;
		if file.flags & FLAG_MISSING_DIR != 0 || !(self.retouch_times || fix_dir_perms) {
			return self.touch_loopchk();
		}
		if let Ok(rel) = rel_path(&fname) {
			if fix_dir_perms {
				let _ = self.trees.dest.chmod(&rel, file.mode & 0o7777);
			}
			if self.retouch_times
				&& let Ok(st) = self.stat_loc(&self.trees.dest, &rel, false)
				&& !meta::same_mtime(&file, &st, &self.meta)
			{
				let mtime =
					system_time(file.mtime, i64::from(file.mtime_nsec)).map(pi_vfs::FileTime::At);
				if let Err(err) = self.trees.dest.set_times(&rel, None, mtime, false) {
					let text = [&b"failed to set times on "[..], &meta::full_fname(&self.trees.dest, &rel)].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
				}
			}
		}
		self.touch_loopchk()
	}

	fn touch_loopchk(&mut self) -> Result<(), RsyncError> {
		if self.touch_counter >= self.loopchk_limit {
			self.touch_counter = 0;
			self.loopchk()?;
		}
		Ok(())
	}

	// ----- itemize -------------------------------------------------------------------

	/// Upstream itemize(): computes the ITEM_REPORT_* bits against `sx` (statret >= 0)
	/// and, when significant, sends ndx + iflags (+ basis type, xname, xattr request).
	#[allow(clippy::too_many_arguments, reason = "mirrors upstream itemize()")]
	fn itemize(
		&mut self,
		file: &FileEntry,
		ndx: i32,
		statret: i32,
		sx: &mut Sx,
		mut iflags: u32,
		fnamecmp_type: u8,
		xname: Option<&[u8]>,
	) -> Result<(), RsyncError> {
		use crate::rsync::consts::{
			ITEM_BASIS_TYPE_FOLLOWS, ITEM_IS_NEW, ITEM_LOCAL_CHANGE, ITEM_REPORT_ACL,
			ITEM_REPORT_PERMS, ITEM_REPORT_XATTR, ITEM_TRANSFER, ITEM_XNAME_FOLLOWS,
			SIGNIFICANT_ITEM_FLAGS,
		};
		if statret >= 0
			&& let Some(st) = sx.st.as_ref()
		{
			let bits = {
				let ictx = meta::ItemCtx {
					iflags,
					xname,
					crtime: None,
					timeset_failed_flags: self.timeset_failed,
				};
				let mut bits = meta::attr_changes_with(file, st, &self.meta, &ictx);
				if !CAN_CHMOD_SYMLINK && mode_is_lnk(file.mode) {
					bits &= !ITEM_REPORT_PERMS;
				}
				bits
			};
			iflags |= bits;
			if self.meta.acls && !mode_is_lnk(file.mode) && self.acls_differ(file, sx) {
				iflags |= ITEM_REPORT_ACL;
			}
			if self.meta.xattrs && self.xattrs_differ(file, sx, true) {
				iflags |= ITEM_REPORT_XATTR;
			}
		} else {
			if self.meta.xattrs {
				let mut cache = lock(&self.xattrs);
				if cache.diff(file.xattr, None, true) {
					iflags |= ITEM_REPORT_XATTR;
				}
			}
			iflags |= ITEM_IS_NEW;
		}

		iflags &= 0xffff;
		let xname_nonempty = xname.is_some_and(|x| !x.is_empty());
		if (iflags & (SIGNIFICANT_ITEM_FLAGS | ITEM_REPORT_XATTR) != 0
			|| self.info(Info::Name) >= 2
			|| self.stdout_has_i() > 1
			|| xname_nonempty)
			&& !self.opts.read_batch
		{
			if ndx >= 0 {
				self.write_ndx(ndx)?;
			}
			self.out.write_shortint(iflags as u16).map_err(RsyncError::from_stream)?;
			if iflags & ITEM_BASIS_TYPE_FOLLOWS != 0 {
				self.out.write_u8(fnamecmp_type).map_err(RsyncError::from_stream)?;
			}
			if iflags & ITEM_XNAME_FOLLOWS != 0 {
				self.out.write_vstring(xname.unwrap_or_default()).map_err(RsyncError::from_stream)?;
			}
			if self.meta.xattrs && self.opts.do_xfers && iflags & (ITEM_REPORT_XATTR | ITEM_TRANSFER) != 0 {
				let send = iflags & ITEM_REPORT_XATTR != 0
					&& !(self.want_xattr_optim
						&& iflags & (ITEM_XNAME_FOLLOWS | ITEM_LOCAL_CHANGE)
							== ITEM_XNAME_FOLLOWS | ITEM_LOCAL_CHANGE);
				let mut cache = lock(&self.xattrs);
				let set = file.xattr.unwrap_or(u32::MAX);
				if send {
					let mut out = self.out.clone();
					cache.request_missing(&mut out, set, ndx).map_err(RsyncError::from_stream)?;
				} else if let Some(set) = file.xattr {
					cache.settle(set);
				}
			}
		}
		Ok(())
	}

	fn xattrs_differ(&self, file: &FileEntry, sx: &mut Sx, find_all: bool) -> bool {
		if sx.xattr.is_none() {
			let local = match (&sx.src, &sx.st) {
				(Some((tree, rel)), Some(st)) => {
					let filters = &self.filters;
					let exclude = |name: &[u8]| filters.xattr_excluded(name);
					let filter: Option<&dyn Fn(&[u8]) -> bool> =
						if filters.has_xattr_rules() { Some(&exclude) } else { None };
					let xctx = XattrCtx { filter, logger: Some(&self.log), ..XattrCtx::default() };
					xattr::read_local_with(tree, rel, Some(st.mode()), false, self.ctx.xattr_opts, xctx)
						.unwrap_or_default()
				},
				_ => XattrSet::default(),
			};
			sx.xattr = Some(local);
		}
		let mut cache = lock(&self.xattrs);
		cache.diff(file.xattr, sx.xattr.as_ref(), find_all)
	}

	fn acls_differ(&self, file: &FileEntry, sx: &mut Sx) -> bool {
		if sx.acl.is_none() {
			let local = match (&sx.src, &sx.st) {
				(Some((tree, rel)), Some(st)) => {
					acl::read_local_with(tree, rel, st.mode(), self.ctx.acl_opts, Some(&self.log))
						.unwrap_or_default()
				},
				_ => AclSet::default(),
			};
			sx.acl = Some(local);
		}
		let wanted = {
			let cache = lock(&self.acls);
			cache.get(file.acl, file.def_acl)
		};
		sx.acl.as_ref().is_some_and(|local| acl::differs(local, &wanted, file.mode))
	}

	/// unchanged_attrs.
	fn unchanged_attrs(&self, file: &FileEntry, sx: &mut Sx) -> bool {
		let Some(st) = sx.st.as_ref() else {
			return false;
		};
		if mode_is_lnk(file.mode) {
			let mut opts = self.meta.clone();
			if !CAN_CHMOD_SYMLINK {
				opts.perms = false;
				opts.executability = false;
			}
			if !meta::attrs_unchanged(file, st, &opts, None) {
				return false;
			}
			return !(self.meta.xattrs && self.xattrs_differ(file, sx, false));
		}
		if !meta::attrs_unchanged(file, st, &self.meta, None) {
			return false;
		}
		if self.meta.acls && self.acls_differ(file, sx) {
			return false;
		}
		!(self.meta.xattrs && self.xattrs_differ(file, sx, false))
	}
}

/// What the receiver reported about an entry (upstream FES_*).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Status {
	Success,
	NoSend,
	Redo,
}
