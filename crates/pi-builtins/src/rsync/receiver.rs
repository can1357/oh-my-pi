//! The receiver (upstream recv_files): reads what the sender transmits for each
//! file the generator asked for and rebuilds the file in the destination tree.
//!
//! Per file the sender sends its index, the item flags, the basis type and
//! name the generator chose, the echo of the sum header, the delta tokens, and
//! the whole-file checksum. The receiver picks the same basis (destination
//! file, `--partial-dir` file, backup, fuzzy match, or an alternate
//! destination), reconstructs the data into a temporary file (or in place),
//! verifies the checksum, and finishes the file: backup, attributes, rename.
//! A verification failure in the first pass asks the generator to redo the
//! file (`Sibling::Redo`); in the redo pass it is an error.
//!
//! Facts other modules rely on:
//! - every index read from the sender goes through `fr.ndx_codec()` and then
//!   `Flists::from_wire`; `Sibling` messages carry local indices;
//! - the receiver tracks "already sent once" (upstream `FLAG_FILE_SENT`)
//!   locally and never writes entries back into `Flists`;
//! - with inc-recursion the receiver releases each segment when the sender's
//!   per-segment `NDX_DONE` arrives (the generator never releases);
//! - `Sibling::Done` is sent once per phase change, not per segment;
//! - counters go straight into `ctx.stats` as upstream's receiver counts them.
//!
//! All filesystem access goes through [`Tree`]: an alternate-destination basis
//! is opened without following a final symlink (3.5.1), the output temp file is
//! created `O_EXCL|O_NOFOLLOW` beside the destination (or in `--temp-dir`).

mod data;
#[cfg(test)]
mod tests;

use std::{
	collections::{HashSet, VecDeque},
	io::{self, Read, Seek, SeekFrom},
	path::{Path, PathBuf},
	sync::{
		Arc, Mutex,
		atomic::{AtomicU32, Ordering},
	},
};

use pi_vfs::{File, Metadata};

use self::data::{Source, Target};
use crate::rsync::{
	flists::lock,
	acl::{self, AclReceiver},
	backup::{self, BackupOutcome},
	consts::{
		ACCESSPERMS, FLAG_HLINKED, FLAG_SKIP_GROUP, FNAMECMP_BACKUP, FNAMECMP_FNAME,
		FNAMECMP_FUZZY,
		FNAMECMP_PARTIAL_DIR, ITEM_BASIS_TYPE_FOLLOWS, ITEM_IS_NEW, ITEM_LOCAL_CHANGE,
		ITEM_REPORT_XATTR, ITEM_TRANSFER, ITEM_XNAME_FOLLOWS, MAXPATHLEN, MAX_WIRE_DEL_STAT,
		NDX_DEL_STATS, NDX_DONE, NDX_FLIST_EOF, NDX_FLIST_OFFSET, CF_AVOID_XATTR_OPTIM,
		CF_INPLACE_PARTIAL_DIR, mode_is_device, mode_is_dir, mode_is_lnk, mode_is_reg,
	},
	exit::{RERR_FILEIO, RERR_PROTOCOL, RsyncError},
	flist::FileEntry,
	flists::Flists,
	generator::{DestTrees, SibOut, Sibling},
	log::{Debug, Info, LogCode, LogItem, Logger},
	meta::{self, ATTRS_ACCURATE_TIME, ATTRS_SKIP_ATIME, ATTRS_SKIP_CRTIME, ATTRS_SKIP_MTIME, AttrHooks},
	mux::{MuxReader, MuxWriter},
	paths::{self, bytes_os_lossy, rel_path_lossy},
	scan::FlistReceiver,
	session::Ctx,
	token::TokenDecoder,
	tree::{self, Tree, TreeOpts},
	usage,
	wire::ReadExt,
	xattr::{self, XattrCtx, XattrReceiver},
};

/// Upstream `INITACCESSPERMS`.
const INITACCESSPERMS: u32 = 0o700;
/// Highest phase (protocol ≥ 29: transfer, redo, final).
const MAX_PHASE: u32 = 2;

/// recv_files: receives every file the sender transmits until the last phase ends.
pub(crate) fn run(
	ctx: &Ctx,
	trees: &DestTrees,
	flists: &Flists,
	fr: &mut FlistReceiver,
	input: &mut MuxReader,
	out: &MuxWriter,
	sib: &SibOut,
) -> Result<(), RsyncError> {
	run_batch(ctx, trees, flists, fr, input, out, sib, None)
}

/// [`run`] for `--read-batch`: `batch_gen` is upstream's `batch_gen_fd`, the
/// generator's output (plain ints) telling which batched updates it wants.
#[allow(clippy::too_many_arguments, reason = "run plus the batch generator stream")]
pub(crate) fn run_batch(
	ctx: &Ctx,
	trees: &DestTrees,
	flists: &Flists,
	fr: &mut FlistReceiver,
	input: &mut MuxReader,
	out: &MuxWriter,
	sib: &SibOut,
	batch_gen: Option<&mut dyn Read>,
) -> Result<(), RsyncError> {
	let mut rx = Receiver::new(ctx, trees, flists, out, sib, fr, batch_gen);
	let result = rx.recv_files(fr, input);
	if result.is_err() {
		rx.cleanup();
	} else {
		// main.c do_recv: io_flush(FULL_FLUSH) after recv_files.
		sib.flush_all();
	}
	result
}

/// `dir/name` (just `name` for an empty dir).
fn join_bytes(dir: &[u8], name: &[u8]) -> Vec<u8> {
	if dir.is_empty() { name.to_vec() } else { [dir, b"/", name].concat() }
}

fn is_dir_error(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::IsADirectory
}

fn is_eacces(err: &io::Error) -> bool {
	#[cfg(unix)]
	if err.raw_os_error() == Some(libc::EACCES) {
		return true;
	}
	err.kind() == io::ErrorKind::PermissionDenied
}

fn eacces() -> io::Error {
	#[cfg(unix)]
	{
		io::Error::from_raw_os_error(libc::EACCES)
	}
	#[cfg(not(unix))]
	{
		io::Error::from(io::ErrorKind::PermissionDenied)
	}
}

fn is_xdev(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::CrossesDevices
}

fn is_txtbsy(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::ExecutableFileBusy
}

fn is_not_found(err: &io::Error) -> bool {
	err.kind() == io::ErrorKind::NotFound
}

/// A path inside one tree plus the name upstream would print for it.
#[derive(Clone)]
struct Loc {
	tree: Tree,
	rel: PathBuf,
	/// The name as upstream spells it in messages (fname, partialptr, …).
	name: Vec<u8>,
}

impl Loc {
	/// full_fname: the quoted path diagnostics show.
	fn full(&self) -> Vec<u8> {
		meta::full_fname(&self.tree, &self.rel)
	}

	fn parent(&self) -> PathBuf {
		self.rel.parent().map_or_default(Path::to_path_buf)
	}
}

/// Which basis upstream's `fnamecmp` ended up naming.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
	Fname,
	Partial,
	Backup,
	Fuzzy,
	Alt,
}

/// One request read by read_ndx_and_attrs.
struct Item {
	ndx: i32,
	iflags: u32,
	ftype: u8,
	xname: Option<Vec<u8>>,
}

/// The temp file a fatal exit must clean up (upstream cleanup_set).
struct Pending {
	tmp: Loc,
	/// partialptr (fname without `--partial-dir`).
	new_name: Option<Loc>,
	file: FileEntry,
}

/// A `--delay-updates` file waiting for the end of the transfer.
struct Delayed {
	ndx: i32,
	fname: Vec<u8>,
	file: FileEntry,
}

/// upstream batch_gen_fd bookkeeping (`--read-batch`).
struct BatchGen<'b> {
	r: &'b mut dyn Read,
	next_ndx: i32,
	done_cnt: i32,
	got_eof: bool,
	redo_ndx: i32,
	redo_list: VecDeque<i32>,
}

/// The absolute `--partial-dir`: a tree on its parent plus its own name.
struct AbsPartial {
	tree: Tree,
	leaf: PathBuf,
}

struct Receiver<'a, 'b> {
	ctx: &'a Ctx,
	trees: &'a DestTrees,
	flists: &'a Flists,
	out: &'a MuxWriter,
	sib: &'a SibOut,
	log: &'a Logger,
	batch: Option<BatchGen<'b>>,
	xattrs: Arc<Mutex<XattrReceiver>>,
	acls: Arc<Mutex<AclReceiver>>,
	dec: TokenDecoder,
	phase: u32,
	redoing: bool,
	/// Indices sent once already (upstream FLAG_FILE_SENT on the receiver's copy).
	sent: HashSet<i32>,
	delayed: Vec<Delayed>,
	/// Segments released so far (inc-recursion): the first live one.
	released: usize,
	got_literal: bool,
	pending: Option<Pending>,
	sender_sum: Vec<u8>,
	dflt_perms: Option<(Vec<u8>, u32)>,
	abs_partial: Option<Option<AbsPartial>>,
	/// Dense file index for progress (upstream current_file_index).
	cur_index: i32,
	initial_read: u64,
	initial_written: u64,
	itemizing: bool,
	whole_file: bool,
	inplace_partial: bool,
	want_xattr_optim: bool,
	updating_basis: bool,
}

/// Applies xattrs and ACLs from the file-list caches inside set_file_attrs.
struct Hooks<'h> {
	ctx: &'h Ctx,
	xattrs: &'h Mutex<XattrReceiver>,
	acls: &'h Mutex<AclReceiver>,
	basis: Option<&'h Loc>,
}

impl AttrHooks for Hooks<'_> {
	fn apply_xattrs(&mut self, tree: &Tree, rel: &Path, entry: &FileEntry) {
		let Some(ndx) = entry.xattr else { return };
		let xctx = XattrCtx {
			logger: Some(&self.ctx.logger),
			basis: self.basis.map(|loc| (&loc.tree, loc.rel.as_path())),
			..XattrCtx::default()
		};
		// Per-item failures are reported by the xattr layer through the logger.
		let _ = lock(self.xattrs).apply(ndx, tree, rel, false, self.ctx.xattr_opts, xctx);
	}

	fn apply_acls(&mut self, tree: &Tree, rel: &Path, entry: &FileEntry, new_mode: u32, cur_mode: &mut u32) -> bool {
		if entry.acl.is_none() && entry.def_acl.is_none() {
			return false;
		}
		let wanted = lock(self.acls).get(entry.acl, entry.def_acl);
		let logger = Some(&self.ctx.logger);
		let local = acl::read_local_with(tree, rel, *cur_mode, self.ctx.acl_opts, logger).unwrap_or_default();
		match acl::apply_with(tree, rel, &wanted, &local, *cur_mode, new_mode, self.ctx.acl_opts, logger) {
			Ok(applied) => {
				*cur_mode = applied.mode;
				applied.changed
			}
			// Already reported by the ACL layer.
			Err(_) => false,
		}
	}
}

impl<'a, 'b> Receiver<'a, 'b> {
	fn new(
		ctx: &'a Ctx,
		trees: &'a DestTrees,
		flists: &'a Flists,
		out: &'a MuxWriter,
		sib: &'a SibOut,
		fr: &FlistReceiver,
		batch_gen: Option<&'b mut dyn Read>,
	) -> Self {
		let opts = &*ctx.opts;
		let mut dec = TokenDecoder::new(ctx.compress);
		dec.set_protocol(ctx.proto.version);
		let itemizing = if ctx.am_server { opts.logfile_format_has_i } else { opts.stdout_format_has_i != 0 };
		let whole_file = opts.whole_file > 0 || (opts.whole_file < 0 && ctx.local_server && opts.write_batch == 0);
		Self {
			ctx,
			trees,
			flists,
			out,
			sib,
			log: &ctx.logger,
			batch: batch_gen.map(|r| BatchGen {
				r,
				next_ndx: -1,
				done_cnt: 0,
				got_eof: false,
				redo_ndx: -1,
				redo_list: VecDeque::new(),
			}),
			xattrs: fr.xattrs(),
			acls: fr.acls(),
			dec,
			phase: 0,
			redoing: false,
			sent: HashSet::new(),
			delayed: Vec::new(),
			released: 0,
			got_literal: false,
			pending: None,
			sender_sum: Vec::new(),
			dflt_perms: None,
			abs_partial: None,
			cur_index: 0,
			initial_read: 0,
			initial_written: 0,
			itemizing,
			whole_file,
			inplace_partial: ctx.proto.has(CF_INPLACE_PARTIAL_DIR),
			want_xattr_optim: ctx.proto.version >= 31 && !ctx.proto.has(CF_AVOID_XATTR_OPTIM),
			updating_basis: false,
		}
	}

	// ----- small helpers -------------------------------------------------------

	fn who(&self) -> &'static str {
		self.log.role().name()
	}

	/// Queues a message for the generator (upstream send_msg_int on the pipe; it leaves
	/// with the receiver's next input refill or flush).
	fn tell(&self, msg: Sibling) {
		self.sib.msg(msg);
	}

	fn no_send(&self, ndx: i32) {
		if self.ctx.inc_recurse {
			self.tell(Sibling::NoSend(ndx));
		}
	}

	fn debug(&self, flag: Debug, level: u8, text: &[u8]) {
		if self.log.levels().debug(flag) >= level {
			self.log.rprintf(LogCode::Info, text);
		}
	}

	/// Upstream sparse_files after the redo-pass toggles.
	fn sparse_active(&self) -> bool {
		self.ctx.opts.sparse_files && !(self.redoing && self.ctx.opts.append_mode != 0)
	}

	/// Upstream append_mode (negated, i.e. off, in the redo pass).
	fn append_mode(&self) -> u32 {
		if self.redoing { 0 } else { self.ctx.opts.append_mode }
	}

	/// Upstream `make_backups > 0` (negated in the redo pass for `--partial` without a dir).
	fn make_backups(&self) -> bool {
		let opts = &*self.ctx.opts;
		opts.make_backups && !(self.redoing && opts.keep_partial && self.trees.partial_dir.is_none())
	}

	fn dest(&self, name: &[u8]) -> Loc {
		Loc { tree: self.trees.dest.clone(), rel: rel_path_lossy(name), name: name.to_vec() }
	}

	fn partial_is_abs(&self) -> bool {
		self.trees.partial_dir.as_deref().is_some_and(|dir| {
			dir.first() == Some(&b'/') || Path::new(&bytes_os_lossy(dir)).is_absolute()
		})
	}

	fn abs_partial(&mut self) -> Option<&AbsPartial> {
		if self.abs_partial.is_none() {
			let opened = self.trees.partial_dir.as_deref().and_then(|dir| {
				let path = self.ctx.paths.resolve(bytes_os_lossy(dir));
				let leaf = path.file_name().map_or_default(PathBuf::from);
				let parent = path.parent().map(Path::to_path_buf).unwrap_or_else(|| path.clone());
				let opts = TreeOpts {
					insecure_links: self.ctx.opts.insecure_links,
					operator_named: true,
					confine: self.ctx.opts.confine_root.as_ref().map(|c| self.ctx.paths.resolve(c)),
				};
				Tree::open(&self.ctx.fs, &parent, &opts).ok().map(|tree| AbsPartial { tree, leaf })
			});
			self.abs_partial = Some(opened);
		}
		self.abs_partial.as_ref().and_then(Option::as_ref)
	}

	/// partial_dir_fname: where `fname`'s partial file lives (None when too long).
	fn partial_loc(&mut self, fname: &[u8]) -> Option<Loc> {
		let dir = self.trees.partial_dir.clone()?;
		let (fdir, base) = paths::split_name(fname);
		if self.partial_is_abs() {
			let name = join_bytes(&dir, base);
			if name.len() >= MAXPATHLEN {
				return None;
			}
			let abs = self.abs_partial()?;
			let rel = abs.leaf.join(bytes_os_lossy(base));
			return Some(Loc { tree: abs.tree.clone(), rel, name });
		}
		let name = join_bytes(&join_bytes(fdir, &dir), base);
		if name.len() >= MAXPATHLEN {
			return None;
		}
		Some(self.dest(&name))
	}

	/// The partial-dir file `p` re-rooted at its own directory, which is opened
	/// through the trusted-owner walk (upstream `operator_path_resolve`): a symlink
	/// on the way that someone else owns is refused (ELOOP), never followed.
	/// Writes, renames, and unlinks of partial-dir files go through this; reading
	/// a partial basis keeps the confined transfer-tree open, as upstream does.
	/// Without `--partial-dir`, `p` is the destination name and is returned as is.
	fn partial_target(&self, p: &Loc) -> io::Result<Loc> {
		if self.trees.partial_dir.is_none() {
			return Ok(p.clone());
		}
		let opts = &*self.ctx.opts;
		let tree_opts = TreeOpts {
			insecure_links: opts.insecure_links,
			operator_named: true,
			confine: opts.confine_root.as_ref().map(|c| self.ctx.paths.resolve(c)),
		};
		let tree = Tree::open(&self.ctx.fs, &p.tree.root().join(p.parent()), &tree_opts)?;
		let rel = p.rel.file_name().map_or_default(PathBuf::from);
		Ok(Loc { tree, rel, name: p.name.clone() })
	}

	/// handle_partial_dir: creates (or, for a relative dir, removes) the partial dir
	/// holding `p`. Without `--partial-dir` there is nothing to do.
	fn handle_partial_dir(&self, p: &Loc, create: bool) -> bool {
		if self.trees.partial_dir.is_none() {
			return true;
		}
		if !create && self.partial_is_abs() {
			return true;
		}
		let dir = p.parent();
		if dir.is_empty() {
			return true;
		}
		if create {
			match p.tree.lstat(&dir) {
				Ok(meta) if meta.is_dir() => true,
				Ok(_) => p.tree.unlink(&dir).is_ok() && p.tree.mkdir(&dir, 0o700).is_ok(),
				Err(_) => p.tree.mkdir(&dir, 0o700).is_ok(),
			}
		} else {
			let _ = p.tree.rmdir(&dir);
			true
		}
	}

	/// Index lookup (flist_for_ndx): the segment holding `ndx`, and whether `ndx` is
	/// the gap index naming the segment's parent directory.
	fn locate(&self, ndx: i32) -> Option<(usize, bool)> {
		let found = match self.flists.segment_of(ndx) {
			Some(seg) => Some((seg, ndx < self.flists.segment_start(seg)?)),
			// A gap index precedes its segment's first entry; the segment may be empty
			// (a directory without contents), so look it up by its start.
			None => self.segment_starting_at(ndx.checked_add(1)?).map(|seg| (seg, true)),
		};
		found.filter(|&(seg, _)| seg >= self.released)
	}

	/// The segment whose first index is `start` (segment starts strictly increase).
	fn segment_starting_at(&self, start: i32) -> Option<usize> {
		let (mut lo, mut hi) = (0, self.flists.len());
		while lo < hi {
			let mid = usize::midpoint(lo, hi);
			match self.flists.segment_start(mid)?.cmp(&start) {
				std::cmp::Ordering::Equal => return Some(mid),
				std::cmp::Ordering::Less => lo = mid + 1,
				std::cmp::Ordering::Greater => hi = mid,
			}
		}
		None
	}

	fn last_ndx(&self) -> i32 {
		let count = self.flists.len();
		if count == 0 || self.released >= count {
			return -1;
		}
		let seg = count - 1;
		match (self.flists.segment_start(seg), self.flists.segment_len(seg)) {
			(Some(start), Some(len)) => start + len as i32 - 1,
			_ => -1,
		}
	}

	fn index_error(&self, ndx: i32, loc: &str) -> RsyncError {
		let (first, last) = if self.released < self.flists.len() {
			(self.flists.segment_start(self.released).unwrap_or(0) - 1, self.last_ndx())
		} else {
			(0, -1)
		};
		RsyncError::new(
			RERR_PROTOCOL,
			format!("File-list index {ndx} not in {first} - {last} ({loc}) [{}]", self.who()),
		)
		.at("rsync.c", 982)
	}

	/// Upstream flist_num of a segment (segments count from 1 under inc-recursion).
	fn flist_num(&self, seg: usize) -> i32 {
		seg as i32 + i32::from(self.ctx.inc_recurse)
	}

	// ----- progress ------------------------------------------------------------

	fn progress_start(&mut self, ndx: i32, seg: usize, size: u64) {
		self.cur_index = ndx - self.flist_num(seg);
		if let Some(progress) = &self.ctx.progress {
			let (transferred, total) = {
				let stats = lock(&self.ctx.stats);
				(stats.total_transferred_size, stats.total_size)
			};
			let mut p = lock(progress);
			p.set_totals(u64::try_from(transferred).unwrap_or(0), u64::try_from(total).unwrap_or(0));
			p.start_file(size);
		}
	}

	fn progress_show(&self, ofs: u64, _total: u64) {
		if let Some(progress) = &self.ctx.progress {
			lock(progress).update(ofs, false);
		}
	}

	fn progress_end(&self, size: u64) {
		let Some(progress) = &self.ctx.progress else { return };
		let (xferred, num_files, transferred, total) = {
			let stats = lock(&self.ctx.stats);
			(stats.xferred_files, stats.num_files, stats.total_transferred_size, stats.total_size)
		};
		let to_check = (num_files - self.cur_index - 1).max(0);
		let mut p = lock(progress);
		p.set_totals(u64::try_from(transferred).unwrap_or(0), u64::try_from(total).unwrap_or(0));
		p.end_file(size, xferred.max(0) as u32, to_check as u32, num_files.max(0) as u32);
	}

	// ----- logging -------------------------------------------------------------

	fn log_entry(&self, code: Option<LogCode>, file: &FileEntry, iflags: u32, hlink: Option<&[u8]>) {
		let name = file.name();
		let always = self.ctx.opts.always_checksum;
		let checksum = if always { file.sum.as_deref() } else { Some(&self.sender_sum[..]) };
		let item = LogItem {
			name: &name,
			mode: file.mode,
			size: file.size,
			mtime: file.mtime,
			uid: file.uid,
			gid: file.gid,
			link: file.link.as_deref(),
			hlink,
			iflags,
			op: "recv",
			bytes_xfer: self.ctx.counters.total_read().saturating_sub(self.initial_read),
			bytes_csum: self.ctx.counters.total_written().saturating_sub(self.initial_written),
			checksum: checksum.filter(|sum| !sum.is_empty()),
			is_dir: file.is_dir(),
			dir_prefix: None,
			skip_group: file.flags & FLAG_SKIP_GROUP != 0,
		};
		match code {
			Some(code) => self.log.log_item(code, &item),
			None => self.log.maybe_log_item(&item, self.itemizing),
		}
	}

	// ----- the main loop -------------------------------------------------------

	fn recv_files(&mut self, fr: &mut FlistReceiver, input: &mut MuxReader) -> Result<(), RsyncError> {
		if self.log.levels().debug(Debug::Recv) >= 1 {
			let count = self.flists.segment_len(0).unwrap_or(0);
			self.log.rprintf(LogCode::Info, format!("recv_files({count}) starting\n").as_bytes());
		}
		if let Some(progress) = &self.ctx.progress {
			lock(progress).set_flist_eof(self.flists.is_eof());
		}
		loop {
			self.pending = None;
			let Some(item) = self.read_ndx_and_attrs(fr, input)? else {
				if self.ndx_done()? {
					break;
				}
				continue;
			};
			self.recv_one(input, item)?;
		}
		self.debug(Debug::Recv, 1, b"recv_files finished\n");
		Ok(())
	}

	/// NDX_DONE: returns true when the last phase ended.
	fn ndx_done(&mut self) -> Result<bool, RsyncError> {
		if !self.ctx.am_server
			&& self.released < self.flists.len()
			&& self.log.levels().info(Info::Progress) >= 2
		{
			self.cur_index = self.last_ndx() - self.flist_num(self.flists.len() - 1);
			self.progress_end(0);
		}
		let live = self.released < self.flists.len();
		if self.ctx.inc_recurse && live {
			if self.batch.is_some() {
				let seg = self.released;
				let ndx = self.flists.segment_start(seg).unwrap_or(0)
					+ self.flists.segment_len(seg).unwrap_or(0) as i32;
				self.gen_wants_ndx(ndx, self.flist_num(seg))?;
			}
			self.flists.release(self.released);
			self.released += 1;
			if self.released < self.flists.len() {
				return Ok(false);
			}
		} else if self.batch.is_some() && live {
			let ndx = self.flists.segment_len(self.released).unwrap_or(0) as i32;
			self.gen_wants_ndx(ndx, self.flist_num(self.released))?;
		}
		self.phase += 1;
		if self.phase > MAX_PHASE {
			return Ok(true);
		}
		self.debug(Debug::Recv, 1, format!("recv_files phase={}\n", self.phase).as_bytes());
		if self.phase == 2 && self.ctx.opts.delay_updates {
			self.handle_delayed_updates()?;
		}
		// write_int(f_out, NDX_DONE): pipe data, not a message.
		self.sib.data(Sibling::Done);
		Ok(false)
	}

	/// read_ndx_and_attrs: the next file request, or None for NDX_DONE.
	fn read_ndx_and_attrs(&mut self, fr: &mut FlistReceiver, input: &mut MuxReader) -> Result<Option<Item>, RsyncError> {
		loop {
			let wire = loop {
				self.ctx.check_cancel()?;
				let ndx = fr.ndx_codec().read(input).map_err(|e| self.ctx.stream_error(&e))?;
				if ndx >= 0 {
					break ndx;
				}
				if ndx == NDX_DONE {
					return Ok(None);
				}
				if ndx == NDX_DEL_STATS {
					self.read_del_stats(input)?;
					continue;
				}
				if !self.ctx.inc_recurse {
					return Err(RsyncError::new(
						RERR_PROTOCOL,
						format!("Invalid file index: {ndx} ({NDX_DONE} - {}) [{}]", self.last_ndx(), self.who()),
					)
					.at("rsync.c", 353));
				}
				if ndx == NDX_FLIST_EOF {
					self.flists.set_eof();
					self.sib.data(Sibling::ListEof);
					if let Some(progress) = &self.ctx.progress {
						lock(progress).set_flist_eof(true);
					}
					continue;
				}
				// Upstream forwards the list's bytes to the generator as pipe data.
				let before = self.flists.len();
				fr.recv_extra(input, self.flists, NDX_FLIST_OFFSET - ndx)?;
				for _ in before..self.flists.len() {
					self.sib.data(Sibling::List);
				}
			};
			let ndx = self.flists.from_wire(wire);
			let iflags = u32::from(input.read_shortint().map_err(|e| self.ctx.stream_error(&e))?);
			// Protocol 29's keep-alive: an IS_NEW item one past the end of the list.
			if self.ctx.proto.version < 30
				&& iflags == ITEM_IS_NEW
				&& self.flists.segment_len(0).is_some_and(|len| len as i64 == i64::from(ndx))
			{
				continue;
			}
			let Some((_, gap)) = self.locate(ndx) else {
				return Err(self.index_error(ndx, "read_ndx_and_attrs"));
			};
			let ftype = if iflags & ITEM_BASIS_TYPE_FOLLOWS != 0 {
				input.read_u8().map_err(|e| self.ctx.stream_error(&e))?
			} else {
				FNAMECMP_FNAME
			};
			let xname = if iflags & ITEM_XNAME_FOLLOWS != 0 { Some(self.read_xname(input, ftype)?) } else { None };
			if iflags & ITEM_TRANSFER != 0 {
				let regular = !gap && self.flists.entry(ndx).is_some_and(|e| mode_is_reg(e.mode));
				if !regular {
					return Err(RsyncError::new(
						RERR_PROTOCOL,
						format!("received request to transfer non-regular file: {ndx} [{}]", self.who()),
					)
					.at("rsync.c", 442));
				}
			}
			return Ok(Some(Item { ndx, iflags, ftype, xname }));
		}
	}

	fn read_xname(&self, input: &mut MuxReader, ftype: u8) -> Result<Vec<u8>, RsyncError> {
		let mut name = input
			.read_vstring(MAXPATHLEN, RERR_PROTOCOL, ("rsync.c", 410))
			.map_err(|e| self.ctx.stream_error(&e))?;
		// A basis xname joins an operator directory: it may never climb out of it.
		if ftype >= FNAMECMP_FUZZY && !name.is_empty() {
			name = paths::sanitize_path(&name, Some(b""), 0);
		}
		Ok(name)
	}

	fn read_del_stats(&self, input: &mut MuxReader) -> Result<(), RsyncError> {
		let role = self.log.role();
		let mut counts = [0i32; 5];
		let names = ["deleted_files", "deleted_dirs", "deleted_symlinks", "deleted_devices", "deleted_specials"];
		for (count, name) in counts.iter_mut().zip(names) {
			*count = xattr::read_varint_bounded(input, 0, MAX_WIRE_DEL_STAT, name, role)?;
		}
		let mut stats = lock(&self.ctx.stats);
		stats.deleted_dirs = counts[1];
		stats.deleted_symlinks = counts[2];
		stats.deleted_devices = counts[3];
		stats.deleted_specials = counts[4];
		stats.deleted_files = counts.iter().sum();
		Ok(())
	}

	// ----- one file ------------------------------------------------------------

	fn recv_one(&mut self, input: &mut MuxReader, item: Item) -> Result<(), RsyncError> {
		let ctx = self.ctx;
		let opts = &*ctx.opts;
		let Item { ndx, iflags, ftype, xname } = item;
		let Some((seg, gap)) = self.locate(ndx) else {
			return Err(self.index_error(ndx, "recv_files"));
		};
		let file = match self.flists.entry(ndx) {
			Some(file) => file,
			None if gap => return Err(RsyncError::bare(RERR_PROTOCOL).at("receiver.c", 884)),
			None => FileEntry::default(),
		};
		if !file.is_active() {
			return Err(RsyncError::new(RERR_PROTOCOL, format!("rsync: refusing transfer of cleared file index {ndx}"))
				.at("receiver.c", 896));
		}
		let mut file = file;
		let fname = self.trees.single_file.clone().unwrap_or_else(|| file.name());
		self.debug(Debug::Recv, 1, &[&b"recv_files("[..], &fname, b")\n"].concat());

		let both = ITEM_XNAME_FOLLOWS | ITEM_LOCAL_CHANGE;
		let xattr_item = opts.preserve_xattrs > 0 && iflags & ITEM_REPORT_XATTR != 0 && opts.do_xfers;
		if xattr_item && !(self.want_xattr_optim && iflags & both == both) {
			let Some(xndx) = file.xattr else {
				return Err(RsyncError::new(RERR_PROTOCOL, "recv_xattr_request: internal data error!")
					.at("xattrs.c", 719));
			};
			lock(&self.xattrs).recv_values_named(input, xndx, &fname)?;
		}

		if iflags & ITEM_TRANSFER == 0 {
			self.log_entry(None, &file, iflags, xname.as_deref());
			if xattr_item && iflags & both != both {
				let loc = self.dest(&fname);
				self.set_attrs(&loc, &file, Some(&loc), 0)?;
			}
			if iflags & ITEM_IS_NEW != 0 {
				let mut stats = lock(&ctx.stats);
				stats.created_files += 1;
				if mode_is_dir(file.mode) {
					stats.created_dirs += 1;
				} else if mode_is_lnk(file.mode) {
					stats.created_symlinks += 1;
				} else if mode_is_device(file.mode) {
					stats.created_devices += 1;
				} else if !mode_is_reg(file.mode) {
					stats.created_specials += 1;
				}
			}
			return Ok(());
		}
		if self.phase == 2 {
			return Err(RsyncError::new(RERR_PROTOCOL, format!("got transfer request in phase 2 [{}]", self.who()))
				.at("receiver.c", 946));
		}

		if self.sent.contains(&ndx) {
			self.redoing = true;
		} else {
			self.redoing = false;
			if iflags & ITEM_IS_NEW != 0 {
				lock(&ctx.stats).created_files += 1;
			}
		}
		{
			let mut stats = lock(&ctx.stats);
			stats.xferred_files += 1;
			stats.total_transferred_size += i64::try_from(file.size).unwrap_or(i64::MAX);
		}
		if !ctx.am_server {
			self.progress_start(ndx, seg, file.size);
		}
		self.got_literal = false;

		if self.batch.is_some() {
			let wanted = if self.redoing { self.we_want_redo(ndx)? } else { self.gen_wants_ndx(ndx, self.flist_num(seg))? };
			if !wanted {
				let resend: &[u8] = if self.redoing { b" resend of" } else { b"" };
				self.log.rprintf(LogCode::Info, &[&b"(Skipping batched update for"[..], resend, b" \"", &fname, b"\")\n"].concat());
				self.discard(input, &file)?;
				self.sent.insert(ndx);
				return Ok(());
			}
		}

		self.initial_read = ctx.counters.total_read();
		self.initial_written = ctx.counters.total_written();

		if !opts.do_xfers {
			self.log_entry(Some(LogCode::Client), &file, iflags, None);
			if self.batch.is_some() {
				self.discard(input, &file)?;
			}
			return Ok(());
		}
		if opts.write_batch < 0 {
			self.log_entry(Some(LogCode::Client), &file, iflags, None);
			if !ctx.am_server {
				self.discard(input, &file)?;
			}
			if ctx.inc_recurse {
				self.tell(Sibling::Success(ndx));
			}
			return Ok(());
		}

		let fname_loc = self.dest(&fname);
		let partial_set = self.trees.partial_dir.is_some();
		let mut partialptr: Option<Loc> =
			if partial_set { self.partial_loc(&fname) } else { Some(fname_loc.clone()) };

		// ---- basis selection ----
		let alt_count = self.trees.alt_dirs.len();
		let dirname = file.dirname.clone();
		let (mut kind, mut cmp): (Kind, Option<Loc>) = match ftype {
			FNAMECMP_FNAME => (Kind::Fname, Some(fname_loc.clone())),
			FNAMECMP_PARTIAL_DIR if partial_set => (Kind::Partial, partialptr.clone()),
			FNAMECMP_PARTIAL_DIR => (Kind::Fname, Some(fname_loc.clone())),
			FNAMECMP_BACKUP => match backup::backup_path(ctx, self.trees, &fname) {
				Ok(Some((tree, rel))) => {
					(Kind::Backup, Some(Loc { tree, rel, name: backup::backup_name(ctx, &fname) }))
				}
				Ok(None) => (Kind::Fname, None),
				Err(err) => return Err(err),
			},
			FNAMECMP_FUZZY => {
				let x = xname.clone().unwrap_or_default();
				if opts.fuzzy_basis == 0 {
					let text = [&b"rsync: refusing malicious fuzzy operation for "[..], &x, b"\n"].concat();
					self.log.rprintf(LogCode::ErrorXfer, &text);
					return Err(RsyncError::bare(RERR_PROTOCOL).at("receiver.c", 1028));
				}
				(Kind::Fuzzy, Some(self.dest(&join_bytes(&dirname, &x))))
			}
			t if t > FNAMECMP_FUZZY && usize::from(t - FNAMECMP_FUZZY) <= alt_count => {
				let n = usize::from(t - FNAMECMP_FUZZY - 1);
				let x = xname.clone().unwrap_or_default();
				let name = join_bytes(&dirname, &x);
				let tree = self.trees.alt_dirs[n].clone();
				(Kind::Alt, Some(Loc { rel: rel_path_lossy(&name), name, tree }))
			}
			t if usize::from(t) >= alt_count => {
				return Err(RsyncError::new(RERR_PROTOCOL, format!("invalid basis_dir index: {t}."))
					.at("receiver.c", 1049));
			}
			t => {
				let tree = self.trees.alt_dirs[usize::from(t)].clone();
				(Kind::Alt, Some(Loc { tree, rel: rel_path_lossy(&fname), name: fname.clone() }))
			}
		};
		if cmp.is_none() {
			kind = Kind::Fname;
			cmp = Some(fname_loc.clone());
		}
		let mut cmp = cmp.unwrap_or_else(|| fname_loc.clone());

		let mut basis: Option<(File, Metadata)> = None;
		match cmp.tree.open_read(&cmp.rel, false) {
			Ok(f) => match f.metadata() {
				Ok(meta) => basis = Some((f, meta)),
				Err(err) => {
					self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"fstat "[..], &cmp.full(), b" failed"].concat());
					self.discard(input, &file)?;
					self.no_send(ndx);
					return Ok(());
				}
			},
			Err(err) if is_dir_error(&err) && kind == Kind::Fname => {
				self.is_a_directory(input, &file, &cmp, ndx)?;
				return Ok(());
			}
			Err(_) => {}
		}
		if kind == Kind::Partial && basis.is_none() {
			kind = Kind::Fname;
			cmp = fname_loc.clone();
		}
		if basis.as_ref().is_some_and(|(_, m)| m.is_dir()) && kind == Kind::Fname {
			self.is_a_directory(input, &file, &cmp, ndx)?;
			return Ok(());
		}

		let one_inplace = self.inplace_partial && partial_set && kind == Kind::Partial && basis.is_some();
		self.updating_basis = one_inplace || (opts.inplace && matches!(kind, Kind::Fname | Kind::Backup));

		let mut size_r = basis.as_ref().map_or(0, |(_, m)| m.len());
		let write_to_device = opts.write_devices && basis.as_ref().is_some_and(|(_, m)| mode_is_device(m.mode()));
		if write_to_device {
			if size_r == 0
				&& let Some((f, _)) = basis.as_ref()
			{
				let mut f = f;
				size_r = f.seek(SeekFrom::End(0)).unwrap_or(0);
			}
		} else if basis.take_if(|(_, m)| !m.is_file()).is_some() {
			size_r = 0;
		}

		if !opts.preserve_perms {
			let exists = basis.is_some();
			let existing = basis.as_ref().map(|(_, m)| m.mode());
			let dflt = self.default_perms(&dirname);
			file.mode = meta::dest_mode_with(file.mode, existing, exists, dflt, &ctx.meta);
		}

		// ---- the output ----
		let (target_loc, out_file) = if opts.inplace || one_inplace {
			let target = if one_inplace { partialptr.clone().unwrap_or_else(|| fname_loc.clone()) } else { fname_loc.clone() };
			// The in-place partial output resolves through the ownership walk.
			let opened = self.open_inplace(&target, one_inplace);
			match opened {
				Ok(opened) => opened,
				Err(err) => {
					self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"open "[..], &target.full(), b" failed"].concat());
					self.discard(input, &file)?;
					self.no_send(ndx);
					return Ok(());
				}
			}
		} else {
			match self.open_tmpfile(&fname_loc, &file) {
				Some((tmp, f)) => {
					self.pending = Some(Pending { tmp: tmp.clone(), new_name: partialptr.clone(), file: file.clone() });
					(tmp, f)
				}
				None => {
					self.discard(input, &file)?;
					self.no_send(ndx);
					return Ok(());
				}
			}
		};

		if opts.log_before_transfer {
			self.log_entry(Some(LogCode::Client), &file, iflags, None);
		} else if !ctx.am_server
			&& self.log.levels().info(Info::Name) >= 1
			&& self.log.levels().info(Info::Progress) == 1
		{
			self.log.rprintf(LogCode::Info, &[&fname[..], b"\n"].concat());
		}

		let source = basis.as_ref().map(|(f, _)| Source { file: f, size: size_r, loc: &cmp });
		let target = Target { file: &out_file, loc: &target_loc, is_device: write_to_device };
		let recv_ok = self.receive_data(input, source, Some(target), &file, opts.inplace || one_inplace)?;

		let log_code = if opts.log_before_transfer { LogCode::Log } else { LogCode::Info };
		self.log_entry(Some(log_code), &file, iflags, None);

		drop(basis);
		if let Err(err) = out_file.close() {
			self.log.rsyserr(LogCode::Error, &err, &[&b"close failed on "[..], &target_loc.full()].concat());
			return Err(RsyncError::bare(RERR_FILEIO).at("receiver.c", 1299));
		}

		// ---- finishing ----
		let mut status: i32 = i32::from(recv_ok);
		let delay = opts.delay_updates;
		if (recv_ok && (!delay || partialptr.is_none())) || opts.inplace {
			if !partial_set {
				partialptr = None;
			}
			let ok = self.finish_transfer(
				&fname_loc,
				&target_loc,
				Some(&cmp),
				kind == Kind::Fname,
				partialptr.as_ref(),
				&file,
				recv_ok,
				true,
			)?;
			if !ok {
				status = -1;
			} else if kind == Kind::Partial {
				if let Some(p) = partialptr.as_ref() {
					if !one_inplace && let Ok(owned) = self.partial_target(p) {
						let _ = owned.tree.unlink(&owned.rel);
					}
					self.handle_partial_dir(p, false);
				}
			}
		} else if opts.keep_partial
			&& let Some(p) = partialptr.clone()
			&& (!one_inplace || delay)
		{
			if !self.handle_partial_dir(&p, true) {
				let what: &[u8] = if recv_ok { b"completed file" } else { b"partial file" };
				let text = [&b"Unable to create partial-dir for "[..], &fname, b" -- discarding ", what, b".\n"].concat();
				self.log.rprintf(LogCode::Error, &text);
				let _ = target_loc.tree.unlink(&target_loc.rel);
				status = -1;
			} else if !self.keep_partial(
				&p,
				&target_loc,
				Some(&cmp),
				!partial_set && kind == Kind::Fname,
				&file,
				recv_ok,
				!partial_set,
			)? {
				status = -1;
			} else if delay && recv_ok {
				self.delayed.push(Delayed { ndx, fname: fname.clone(), file: file.clone() });
				status = 2;
			} else {
				partialptr = None;
			}
		} else if !one_inplace {
			let _ = target_loc.tree.unlink(&target_loc.rel);
		}
		self.pending = None;

		if self.batch.is_some() {
			self.sent.insert(ndx);
		}

		match status {
			2 => {}
			1 => {
				if opts.remove_source_files != 0
					|| ctx.inc_recurse
					|| (opts.preserve_hard_links != 0 && file.flags & FLAG_HLINKED != 0)
				{
					self.tell(Sibling::Success(ndx));
				}
			}
			0 => {
				let is_error = self.redoing;
				if is_error || self.log.levels().info(Info::Name) >= 1 || opts.stdout_format_has_i != 0 {
					let kept: &[u8] = if !(opts.keep_partial && partialptr.is_some()) && !opts.inplace {
						b"discarded"
					} else if partial_set {
						b"put into partial-dir"
					} else {
						b"retained"
					};
					let shown = if self.trees.single_file.is_some() { file.name() } else { fname.clone() };
					let (head, code, redo): (&[u8], LogCode, &[u8]) = if is_error {
						(b"ERROR", LogCode::ErrorXfer, b"")
					} else if self.batch.is_some() {
						(b"WARNING", LogCode::Warning, b" (may try again)")
					} else {
						(b"WARNING", LogCode::Warning, b" (will try again)")
					};
					let text = [head, b": ", &shown, b" failed verification -- update ", kept, redo, b".\n"].concat();
					self.log.rprintf(code, &text);
				}
				if !self.redoing {
					if let Some(batch) = self.batch.as_mut() {
						batch.redo_list.push_back(ndx);
					}
					self.tell(Sibling::Redo(ndx));
					self.sent.insert(ndx);
				} else {
					self.no_send(ndx);
				}
			}
			_ => self.no_send(ndx),
		}
		Ok(())
	}

	fn is_a_directory(&mut self, input: &mut MuxReader, file: &FileEntry, cmp: &Loc, ndx: i32) -> Result<(), RsyncError> {
		let text = [&b"recv_files: "[..], &cmp.full(), b" is a directory\n"].concat();
		self.log.rprintf(LogCode::ErrorXfer, &text);
		self.discard(input, file)?;
		self.no_send(ndx);
		Ok(())
	}

	/// discard_receive_data.
	fn discard(&mut self, input: &mut MuxReader, file: &FileEntry) -> Result<(), RsyncError> {
		self.updating_basis = false;
		self.receive_data(input, None, None, file, false).map(drop)
	}

	/// Default permissions for new files in `dir` (its default ACL, else the umask).
	fn default_perms(&mut self, dir: &[u8]) -> u32 {
		if let Some((cached, perms)) = &self.dflt_perms
			&& cached.as_slice() == dir
		{
			return *perms;
		}
		let perms = if usage::SUPPORT_ACLS {
			let rel = if dir.is_empty() { PathBuf::from(".") } else { rel_path_lossy(dir) };
			acl::default_perms_for_dir(&self.trees.dest, &rel, self.ctx.umask, self.ctx.opts.dry_run, Some(self.log))
		} else {
			ACCESSPERMS & !self.ctx.umask
		};
		self.dflt_perms = Some((dir.to_vec(), perms));
		perms
	}

	/// open_tmpfile: the mkstemp-style temp file the data is assembled in.
	fn open_tmpfile(&self, fname: &Loc, file: &FileEntry) -> Option<(Loc, File)> {
		let opts = &*self.ctx.opts;
		let (fdir, base) = paths::split_name(&fname.name);
		let (tree, dir, dotted, dir_len) = match &self.trees.temp_dir {
			Some(tree) => {
				let len = opts.tmpdir.as_ref().map_or(0, |t| crate::host::os_bytes_lossy(t).len() + 1);
				(tree.clone(), PathBuf::new(), false, len)
			}
			None => {
				(self.trees.dest.clone(), fname.parent(), true, if fdir.is_empty() { 0 } else { fdir.len() + 1 })
			}
		};
		let template = match tree::temp_template(base, dir_len, dotted) {
			Ok(template) => template,
			Err(_) => {
				self.log.rprintf(LogCode::ErrorXfer, &[&b"temporary filename too long: "[..], &fname.name, b"\n"].concat());
				return None;
			}
		};
		// secure_mkstemp: a --temp-dir template that climbs with ".." is refused
		// (EINVAL) before anything is created; --insecure-links restores the
		// legacy behavior.
		if let Some(tmpdir) = opts.tmpdir.as_ref().filter(|_| !opts.insecure_links) {
			let tmpdir = crate::host::os_bytes_lossy(tmpdir);
			let mut path = [&tmpdir[..], b"/", &template].concat();
			if cfg!(windows) {
				path.iter_mut().filter(|b| **b == b'\\').for_each(|b| *b = b'/');
			}
			if path.starts_with(b"../") || memchr::memmem::find(&path, b"/../").is_some() {
				let shown = self.trees.dest.root().join(bytes_os_lossy(&path));
				let shown = [&b"\""[..], &crate::host::os_bytes_lossy(shown.as_os_str()), b"\""].concat();
				let err = io::Error::from(io::ErrorKind::InvalidInput);
				self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"mkstemp "[..], &shown, b" failed"].concat());
				return None;
			}
		}
		let added = if self.ctx.opts.am_root < 0 { 0o600 } else { 0o200 };
		let mode = (file.mode | added) & INITACCESSPERMS;
		match tree.create_temp_with(&dir, &bytes_os_lossy(base), mode, dotted) {
			Ok((rel, f)) => {
				let name = if self.trees.temp_dir.is_some() {
					crate::host::os_bytes_lossy(tree.root().join(&rel).as_os_str()).into_owned()
				} else {
					paths::path_bytes(&rel).into_owned()
				};
				Some((Loc { tree, rel, name }, f))
			}
			Err(err) => {
				let shown = Loc { rel: dir.join(bytes_os_lossy(&template)), tree, name: template };
				self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"mkstemp "[..], &shown.full(), b" failed"].concat());
				None
			}
		}
	}

	/// Where one in-place open attempt goes. The in-place partial-dir output
	/// (`owner_walk`, upstream `one_inplace`) is resolved again by path through
	/// the trusted-owner walk for every attempt, as upstream's secure_recv_open
	/// does, so a partial dir swapped for a foreign symlink between attempts is
	/// refused, not reached through a handle held from before.
	fn inplace_attempt(&self, target: &Loc, owner_walk: bool) -> io::Result<Loc> {
		if owner_walk { self.partial_target(target) } else { Ok(target.clone()) }
	}

	/// The in-place output open (with upstream's read-only-file recovery).
	/// Returns the location actually opened.
	fn open_inplace(&self, target: &Loc, owner_walk: bool) -> io::Result<(Loc, File)> {
		let loc = self.inplace_attempt(target, owner_walk)?;
		let first = loc.tree.open_write(&loc.rel, true, false);
		#[cfg(test)]
		let first = tests::hooks::after_inplace_open(first);
		let err = match first {
			Ok(f) => return Ok((loc, f)),
			Err(err) => err,
		};
		if !is_eacces(&err) {
			return Err(err);
		}
		// Linux protected_regular refuses O_CREAT on some existing files.
		#[cfg(any(target_os = "linux", target_os = "android"))]
		let err = {
			let loc = self.inplace_attempt(target, owner_walk)?;
			match loc.tree.open_write(&loc.rel, false, false) {
				Ok(f) => return Ok((loc, f)),
				Err(err) => err,
			}
		};
		if !is_eacces(&err) {
			return Err(err);
		}
		self.open_readonly_inplace(target, owner_walk)
	}

	/// open_readonly_inplace: briefly grants owner-write to open a read-only file.
	fn open_readonly_inplace(&self, target: &Loc, owner_walk: bool) -> io::Result<(Loc, File)> {
		// The lookup's own failure (ELOOP for a refused symlink, …) stands; only
		// "not a read-only regular file" is reported as EACCES.
		let probe = self.inplace_attempt(target, owner_walk)?;
		let meta = probe.tree.lstat(&probe.rel)?;
		let prior = meta.mode() & 0o7777;
		if !meta.is_file() || prior & 0o200 != 0 {
			return Err(eacces());
		}
		probe.tree.chmod(&probe.rel, prior | 0o200)?;
		let opened =
			self.inplace_attempt(target, owner_walk).and_then(|loc| loc.tree.open_write(&loc.rel, false, false).map(|f| (loc, f)));
		if let Err(err) = probe.tree.chmod(&probe.rel, prior) {
			drop(opened);
			return Err(err);
		}
		opened
	}

	// ----- finishing -----------------------------------------------------------

	fn set_attrs(&self, loc: &Loc, file: &FileEntry, basis: Option<&Loc>, flags: u32) -> Result<(), RsyncError> {
		let mut hooks = Hooks { ctx: self.ctx, xattrs: &self.xattrs, acls: &self.acls, basis };
		match meta::set_file_attrs_with(&loc.tree, &loc.rel, file, None, &self.ctx.meta, flags, self.log, &mut hooks) {
			Ok(_) => Ok(()),
			Err(err) => match meta::corrupt_fake_stat(&err) {
				Some(fatal) => Err(fatal),
				None => Ok(()),
			},
		}
	}

	/// finish_transfer: backup, attributes, and the rename into place.
	#[allow(clippy::too_many_arguments, reason = "mirrors finish_transfer's inputs")]
	fn finish_transfer(
		&self,
		fname: &Loc,
		tmp: &Loc,
		cmp: Option<&Loc>,
		cmp_is_fname: bool,
		partialptr: Option<&Loc>,
		file: &FileEntry,
		ok_to_set_time: bool,
		overwriting_basis: bool,
	) -> Result<bool, RsyncError> {
		let flags = if ok_to_set_time {
			ATTRS_ACCURATE_TIME
		} else {
			ATTRS_SKIP_MTIME | ATTRS_SKIP_ATIME | ATTRS_SKIP_CRTIME
		};
		let temp_copy = partialptr.filter(|_| !self.partial_is_abs()).cloned();

		if self.ctx.opts.inplace {
			self.debug(Debug::Recv, 1, &[&b"finishing "[..], &fname.name, b"\n"].concat());
			self.set_attrs(fname, file, cmp, flags)?;
			if let Some(tc) = temp_copy.as_ref() {
				self.handle_partial_dir(tc, false);
			}
			return Ok(true);
		}

		let mut backup_basis: Option<Loc> = None;
		if self.make_backups() && overwriting_basis {
			match backup::make_backup(self.ctx, self.trees, &fname.name, false) {
				Err(_) => return Err(RsyncError::bare(RERR_FILEIO).at("rsync.c", 900)),
				Ok(BackupOutcome::Moved)
					if cmp_is_fname
						&& let Ok(Some((tree, rel))) = backup::backup_path(self.ctx, self.trees, &fname.name) =>
				{
					backup_basis = Some(Loc { tree, rel, name: backup::backup_name(self.ctx, &fname.name) });
				}
				Ok(_) => {}
			}
		}
		let cmp = backup_basis.as_ref().or(cmp);

		self.set_attrs(tmp, file, cmp, flags)?;
		self.debug(Debug::Recv, 1, &[&b"renaming "[..], &tmp.name, b" to ", &fname.name, b"\n"].concat());
		match self.robust_rename(tmp, fname, temp_copy.as_ref(), file.mode) {
			Err((copying, err)) => {
				let verb: &[u8] = if copying { b"copy " } else { b"rename " };
				let text = [verb, &tmp.full(), b" -> \"", &fname.name, b"\""].concat();
				self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
				let keep = match partialptr {
					Some(p) if !(copying && temp_copy.is_some()) => self
						.partial_target(p)
						.is_ok_and(|p| self.robust_rename(tmp, &p, None, file.mode).is_ok()),
					_ => false,
				};
				if !keep {
					let _ = tmp.tree.unlink(&tmp.rel);
				}
				Ok(false)
			}
			Ok(false) => Ok(true),
			Ok(true) => {
				let Some(tc) = temp_copy.as_ref() else {
					self.set_attrs(fname, file, cmp, flags)?;
					return Ok(true);
				};
				// The copy landed in the partial dir (robust_rename resolved it the same way).
				let placed = match self.partial_target(tc) {
					Ok(placed) => placed,
					Err(err) => {
						let text = [&b"rename "[..], &tc.full(), b" -> \"", &fname.name, b"\""].concat();
						self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
						return Ok(false);
					}
				};
				self.set_attrs(&placed, file, cmp, flags)?;
				if let Err(err) = fname.tree.rename((&placed.tree, &placed.rel), &fname.rel) {
					let text = [&b"rename "[..], &tc.full(), b" -> \"", &fname.name, b"\""].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(false);
				}
				self.handle_partial_dir(tc, false);
				Ok(true)
			}
		}
	}

	/// Keeps a received (or partial) file in its partial-dir place `p` (upstream's
	/// `finish_transfer(partialptr, …)` after `handle_partial_dir(PDIR_CREATE)`):
	/// the partial dir is resolved through [`Self::partial_target`] first.
	#[allow(clippy::too_many_arguments, reason = "mirrors finish_transfer's inputs")]
	fn keep_partial(
		&self,
		p: &Loc,
		tmp: &Loc,
		cmp: Option<&Loc>,
		cmp_is_fname: bool,
		file: &FileEntry,
		ok_to_set_time: bool,
		overwriting_basis: bool,
	) -> Result<bool, RsyncError> {
		match self.partial_target(p) {
			Ok(owned) => self.finish_transfer(&owned, tmp, cmp, cmp_is_fname, None, file, ok_to_set_time, overwriting_basis),
			Err(err) => {
				let text = [&b"rename "[..], &tmp.full(), b" -> \"", &p.name, b"\""].concat();
				self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
				let _ = tmp.tree.unlink(&tmp.rel);
				Ok(false)
			}
		}
	}

	/// robust_rename: Ok(false) renamed, Ok(true) copied across filesystems;
	/// Err((true, _)) when the copy failed, Err((false, _)) otherwise.
	fn robust_rename(&self, from: &Loc, to: &Loc, partialptr: Option<&Loc>, mode: u32) -> Result<bool, (bool, io::Error)> {
		let mut tries = 4;
		loop {
			let err = match to.tree.rename((&from.tree, &from.rel), &to.rel) {
				Ok(()) => return Ok(false),
				Err(err) => err,
			};
			tries -= 1;
			if is_txtbsy(&err) && tries > 0 {
				if let Err(err) = self.robust_unlink(to) {
					return Err((false, err));
				}
				continue;
			}
			if is_xdev(&err) {
				let dest = match partialptr {
					Some(p) => {
						if !self.handle_partial_dir(p, true) {
							return Err((true, err));
						}
						self.partial_target(p).map_err(|e| (true, e))?
					}
					None => to.clone(),
				};
				self.copy_file(from, &dest, mode).map_err(|e| (true, e))?;
				let _ = from.tree.unlink(&from.rel);
				return Ok(true);
			}
			return Err((false, err));
		}
	}

	/// robust_unlink: unlink, or move a busy executable aside as `.rsyncNNN`.
	fn robust_unlink(&self, loc: &Loc) -> io::Result<()> {
		static COUNTER: AtomicU32 = AtomicU32::new(1);
		let err = match loc.tree.unlink(&loc.rel) {
			Ok(()) => return Ok(()),
			Err(err) => err,
		};
		if !is_txtbsy(&err) {
			return Err(err);
		}
		let dir = loc.parent();
		let start = COUNTER.load(Ordering::Relaxed);
		let mut counter = start;
		let mut candidate;
		loop {
			candidate = dir.join(format!(".rsync{counter:03}"));
			counter = if counter + 1 >= 1000 { 1 } else { counter + 1 };
			if loc.tree.lstat(&candidate).is_err() || counter == start {
				break;
			}
		}
		COUNTER.store(counter, Ordering::Relaxed);
		if self.log.levels().info(Info::Misc) >= 1 {
			let shown = paths::path_bytes(&candidate).into_owned();
			let text = [&b"renaming "[..], &loc.name, b" to ", &shown, b" because of text busy\n"].concat();
			self.log.rprintf(LogCode::Warning, &text);
		}
		loc.tree.rename((&loc.tree, &loc.rel), &candidate).map_err(|_| err)
	}

	/// copy_file: the cross-filesystem fallback of a rename.
	fn copy_file(&self, src: &Loc, dst: &Loc, _mode: u32) -> io::Result<()> {
		let log = self.log;
		let input = src.tree.open_read(&src.rel, false).inspect_err(|err| {
			log.rsyserr(LogCode::ErrorXfer, err, &[&b"open "[..], &src.full()].concat());
		})?;
		if let Err(err) = self.robust_unlink(dst)
			&& !is_not_found(&err)
		{
			log.rsyserr(LogCode::ErrorXfer, &err, &[&b"unlink "[..], &dst.full()].concat());
			return Err(err);
		}
		let output = dst.tree.open_write(&dst.rel, true, true).inspect_err(|err| {
			log.rsyserr(LogCode::ErrorXfer, err, &[&b"open "[..], &dst.full()].concat());
		})?;
		let mut buf = vec![0u8; 8 * 1024];
		loop {
			if self.ctx.cancel.load(Ordering::Relaxed) {
				return Err(RsyncError::cancelled_io());
			}
			let n = match (&input).read(&mut buf) {
				Ok(n) => n,
				Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
				Err(err) => {
					log.rsyserr(LogCode::ErrorXfer, &err, &[&b"read "[..], &src.full()].concat());
					return Err(err);
				}
			};
			if n == 0 {
				break;
			}
			if let Err(err) = io::Write::write_all(&mut &output, &buf[..n]) {
				log.rsyserr(LogCode::ErrorXfer, &err, &[&b"write "[..], &dst.full()].concat());
				return Err(err);
			}
		}
		if self.ctx.opts.do_fsync
			&& let Err(err) = output.sync_all()
		{
			log.rsyserr(LogCode::Error, &err, &[&b"fsync failed on "[..], &dst.full()].concat());
			return Err(err);
		}
		if self.ctx.opts.preserve_xattrs > 0 {
			let xctx = XattrCtx { logger: Some(log), ..XattrCtx::default() };
			let _ = xattr::copy_local((&src.tree, &src.rel), (&dst.tree, &dst.rel), false, self.ctx.xattr_opts, xctx);
		}
		drop(input);
		if let Err(err) = output.close() {
			log.rsyserr(LogCode::ErrorXfer, &err, &[&b"close failed on "[..], &dst.full()].concat());
			return Err(err);
		}
		Ok(())
	}

	/// handle_delayed_updates: moves `--delay-updates` files into place.
	fn handle_delayed_updates(&mut self) -> Result<(), RsyncError> {
		let delayed = std::mem::take(&mut self.delayed);
		for d in delayed {
			let Some(partial) = self.partial_loc(&d.fname) else { continue };
			if self.make_backups() && backup::make_backup(self.ctx, self.trees, &d.fname, false).is_err() {
				continue;
			}
			self.debug(Debug::Recv, 1, &[&b"renaming "[..], &partial.name, b" to ", &d.fname, b"\n"].concat());
			let target = self.dest(&d.fname);
			let moved = self
				.partial_target(&partial)
				.and_then(|src| target.tree.rename((&src.tree, &src.rel), &target.rel));
			match moved {
				Err(err) => {
					let text = [&b"rename failed for "[..], &target.full(), b" (from ", &partial.name, b")"].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
				}
				Ok(()) => {
					let opts = &*self.ctx.opts;
					if opts.remove_source_files != 0 || (opts.preserve_hard_links != 0 && d.file.flags & FLAG_HLINKED != 0) {
						self.tell(Sibling::Success(d.ndx));
					}
					self.handle_partial_dir(&partial, false);
				}
			}
		}
		Ok(())
	}

	/// The fatal-exit part of upstream's cleanup: keep a partial file (with
	/// `--partial` and some literal data received) or remove the temp file.
	fn cleanup(&mut self) {
		let Some(pending) = self.pending.take() else { return };
		let opts = &*self.ctx.opts;
		if self.got_literal
			&& opts.keep_partial
			&& let Some(new_name) = pending.new_name.clone()
			&& self.handle_partial_dir(&new_name, true)
		{
			let partial_set = self.trees.partial_dir.is_some();
			let mut file = pending.file.clone();
			if !partial_set {
				// An unfinished file must not look current to a later --update.
				file.mtime = 0;
				file.mtime_nsec = 0;
			}
			let _ = self.keep_partial(&new_name, &pending.tmp, None, false, &file, !partial_set, !partial_set);
			return;
		}
		let _ = pending.tmp.tree.unlink(&pending.tmp.rel);
	}

	// ----- --read-batch ----------------------------------------------------------

	fn batch_read_int(&mut self) -> Result<i32, RsyncError> {
		let Some(batch) = self.batch.as_mut() else { return Ok(-1) };
		let value = batch.r.read_int();
		value.map_err(|e| self.ctx.stream_error(&e))
	}

	/// no_batched_update.
	fn no_batched_update(&self, ndx: i32, is_redo: bool) -> Result<(), RsyncError> {
		let Some((_, gap)) = self.locate(ndx) else {
			return Err(self.index_error(ndx, "no_batched_update"));
		};
		if gap {
			return Err(RsyncError::bare(RERR_PROTOCOL).at("receiver.c", 743));
		}
		let name = self.flists.entry(ndx).map_or_default(|e| e.name());
		let resend: &[u8] = if is_redo { b" resend of" } else { b"" };
		self.log.rprintf(LogCode::ErrorXfer, &[&b"(No batched update for"[..], resend, b" \"", &name, b"\")\n"].concat());
		if self.ctx.inc_recurse && !self.ctx.opts.dry_run {
			self.tell(Sibling::NoSend(ndx));
		}
		Ok(())
	}

	/// gen_wants_ndx: does the generator want the batched update of `desired`?
	fn gen_wants_ndx(&mut self, desired: i32, flist_num: i32) -> Result<bool, RsyncError> {
		if self.batch.as_ref().is_none_or(|b| b.got_eof) {
			return Ok(false);
		}
		// Upstream io_flush(FULL_FLUSH) before reading the generator's batch stream.
		self.sib.flush_all();
		loop {
			let Some(batch) = self.batch.as_ref() else { return Ok(false) };
			let next = batch.next_ndx;
			if next >= desired {
				break;
			}
			if self.ctx.inc_recurse && flist_num <= batch.done_cnt {
				return Ok(false);
			}
			if next >= 0 {
				self.no_batched_update(next, false)?;
			}
			let value = self.batch_read_int()?;
			let Some(batch) = self.batch.as_mut() else { return Ok(false) };
			batch.next_ndx = value;
			if value < 0 {
				if self.ctx.inc_recurse {
					batch.done_cnt += 1;
					continue;
				}
				batch.got_eof = true;
				return Ok(false);
			}
		}
		let Some(batch) = self.batch.as_mut() else { return Ok(false) };
		if batch.next_ndx == desired {
			batch.next_ndx = -1;
			return Ok(true);
		}
		Ok(false)
	}

	/// we_want_redo: is `desired` the next batched resend?
	fn we_want_redo(&mut self, desired: i32) -> Result<bool, RsyncError> {
		loop {
			let Some(batch) = self.batch.as_ref() else { return Ok(false) };
			let redo = batch.redo_ndx;
			if redo >= desired {
				break;
			}
			if redo >= 0 {
				self.no_batched_update(redo, true)?;
			}
			let Some(batch) = self.batch.as_mut() else { return Ok(false) };
			match batch.redo_list.pop_front() {
				Some(next) => batch.redo_ndx = next,
				None => {
					batch.redo_ndx = -1;
					return Ok(false);
				}
			}
		}
		let Some(batch) = self.batch.as_mut() else { return Ok(false) };
		if batch.redo_ndx == desired {
			batch.redo_ndx = -1;
			return Ok(true);
		}
		Ok(false)
	}
}
