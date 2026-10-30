//! Building and exchanging file lists: the sending side's scan ([`Scanner`], upstream
//! send_file_list / send_extra_file_list) and the receiving side's decoding
//! ([`FlistReceiver`], upstream recv_file_list).
//!
//! Sender facts other modules rely on:
//!
//! - Entry names are relative to the entry's *base* (upstream `F_PATHNAME`): the directory
//!   part of the operand (`src` for `src/x`, the part before `/./` with `-R`), resolved
//!   against the shell cwd (or the `--files-from` directory). Names may start with `/`
//!   under `-R` with an absolute operand.
//! - Every filesystem access goes through a [`Tree`]. Directory scans and content opens are
//!   confined beneath the operand the operator named (3.5.0 `secure_relative_open`): each
//!   directory or `-R` operand is remembered as an anchor (pinned by dev/inode) and
//!   entries below it resolve under it, in-tree directory symlinks followed, escapes
//!   refused. `-L`, `-k`, `--copy-unsafe-links`, and `--insecure-links` use legacy
//!   unconfined resolution (as upstream's non-daemon sender does); `--files-from` entries
//!   resolve through the trusted-owner walk.
//! - Top-level operands and implied directories are stat'ed by path, like upstream.
//! - Under `--iconv` entries are kept with local names and sorted locally; the peer
//!   addresses them by transmission order (see [`Flists::to_wire`]).
//! - Incremental recursion: the initial list holds the operands (and the contents of a
//!   `.` operand); every content directory then gets its own segment, announced by
//!   `NDX_FLIST_OFFSET - dir_ndx`, in upstream's depth-first order over the per-segment
//!   sorted directory tree; `NDX_FLIST_EOF` ends the run.

mod receive;
#[cfg(test)]
mod tests;

pub(crate) use receive::FlistReceiver;

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::rsync::{flists::lock, time::unix_now};
use crate::rsync::acl::{self, AclSender};
use crate::rsync::checksum;
use crate::rsync::consts::{
	CF_SAFE_FLIST, CF_SYMLINK_ICONV, FLAG_CONTENT_DIR, FLAG_DIVERT_DIRS, FLAG_DUPLICATE,
	FLAG_IMPLIED_DIR, FLAG_LENGTH64, FLAG_MOD_NSEC, FLAG_MOUNT_DIR, FLAG_TOP_DIR,
	ACCESSPERMS, IOERR_GENERAL, IOERR_VANISHED, MAX_WIRE_NSEC, MAXPATHLEN,
	MSG_IO_ERROR, NDX_FLIST_EOF,
	NDX_FLIST_OFFSET, S_IFREG, mode_is_device, mode_is_dir, mode_is_lnk, mode_is_reg,
	mode_is_special,
};
use crate::rsync::exit::{
	RERR_FILESELECT, RERR_PROTOCOL, RERR_SYNTAX, RERR_UNSUPPORTED, RsyncError,
};
use crate::rsync::filter::{Filters, Side, Verdict};
use crate::rsync::flist::{CleanOpts, FileEntry, FileList, FlistEncoder, f_name_cmp};
use crate::rsync::flists::Flists;
use crate::rsync::hlink::HlinkTracker;
use crate::rsync::ids::IdLists;
use crate::rsync::log::{Debug as DebugFlag, Info, LogCode, Logger, big_num};
use crate::rsync::meta;
use crate::rsync::mux::MuxWriter;
use crate::rsync::paths::{
	self, CFN_COLLAPSE_DOT_DOT_DIRS, CFN_DROP_TRAILING_DOT_DIR, CFN_KEEP_TRAILING_SLASH,
	bytes_path, forward_slashes, full_fname, is_absolute_bytes, os_bytes, path_bytes,
	push_rel,
};
use crate::rsync::session::Ctx;
use crate::rsync::tree::{Tree, TreeOpts};
use crate::rsync::wire::NdxCodec;
use crate::rsync::xattr::{self, XattrCtx, XattrSender, XattrSet};

/// Upstream name types of an operand.
const NORMAL_NAME: u8 = 0;
const SLASH_ENDING_NAME: u8 = 1;
const DOTDIR_NAME: u8 = 2;
const MISSING_NAME: u8 = 3;

/// Upstream filter levels (as printed by `make_file`'s debug line).
const NO_FILTERS: u8 = 0;
const ALL_FILTERS: u8 = 2;

/// `--munge-links` prefix.
pub(crate) const SYMLINK_PREFIX: &[u8] = b"/rsyncd-munged/";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// `base` joined with a (possibly absolute) entry name.
fn join_name(base: &Path, name: &[u8]) -> io::Result<PathBuf> {
	if is_absolute_bytes(name) {
		return bytes_path(name).map(Path::to_path_buf);
	}
	let mut out = base.to_path_buf();
	push_rel(&mut out, name)?;
	Ok(out)
}

/// `st_rdev` → (major, minor).
#[cfg(unix)]
fn dev_split(rdev: u64) -> (u32, u32) {
	let dev = rdev as libc::dev_t;
	(libc::major(dev) as u32, libc::minor(dev) as u32)
}

#[cfg(not(unix))]
fn dev_split(rdev: u64) -> (u32, u32) {
	((rdev >> 32) as u32, rdev as u32)
}

/// What a stat produced (upstream `STRUCT_STAT` subset); all zero = a missing operand.
#[derive(Clone, Copy, Debug, Default)]
struct St {
	mode: u32,
	size: u64,
	mtime: i64,
	nsec: u32,
	atime: i64,
	crtime: i64,
	uid: u32,
	gid: u32,
	rdev: u64,
	dev: u64,
	ino: u64,
	nlink: u64,
	has_id: bool,
}

impl St {
	fn of(md: &pi_vfs::Metadata) -> Self {
		let crtime = md
			.created()
			.ok()
			.and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
			.map_or(0, |d| d.as_secs() as i64);
		Self {
			mode: md.mode(),
			size: md.len(),
			mtime: md.mtime().unwrap_or(0),
			nsec: md.mtime_nsec().unwrap_or(0).clamp(0, i64::from(u32::MAX)) as u32,
			atime: md.atime().unwrap_or(0),
			crtime,
			uid: md.uid().unwrap_or(0),
			gid: md.gid().unwrap_or(0),
			rdev: md.rdev().unwrap_or(0),
			dev: md.dev().unwrap_or(0),
			ino: md.ino().unwrap_or(0),
			nlink: md.nlink().unwrap_or(1),
			has_id: md.file_id().is_some(),
		}
	}
}

/// The data stream the file-list code writes to. It is never flushed here: like upstream,
/// the list stays in the output buffer until the sender next waits for input, so
/// `stats.flist_size` (the raw bytes written while the list was built) counts only what
/// spilled out on its own.
type Out = MuxWriter;

/// `output_flist` (`--debug=FLIST3`): one line per entry of a list.
fn output_flist(
	logger: &Logger,
	list: &FileList,
	root: &dyn Fn(usize) -> Vec<u8>,
	show_uid: bool,
	show_gid: bool,
) {
	let who = logger.role().name();
	let used = list.entries.len() as i32;
	logger.rprintf(
		LogCode::Info,
		format!("[{who}] flist start={}, used={used}, low=0, high={}\n", list.ndx_start, used - 1)
			.as_bytes(),
	);
	for (i, e) in list.entries.iter().enumerate() {
		let uid = if show_uid { format!(" uid={}", e.uid) } else { String::new() };
		let gid = if show_gid {
			if e.flags & crate::rsync::consts::FLAG_SKIP_GROUP != 0 {
				format!(" gid=({})", e.gid)
			} else {
				format!(" gid={}", e.gid)
			}
		} else {
			String::new()
		};
		let mut line = format!("[{who}] i={} ", i as i32 + list.ndx_start).into_bytes();
		if e.is_active() {
			line.extend_from_slice(&root(i));
			line.push(b' ');
			if !e.dirname.is_empty() {
				line.extend_from_slice(&e.dirname);
				line.push(b'/');
			}
			line.extend_from_slice(&e.basename);
			if e.is_dir() {
				line.push(b'/');
			}
		} else {
			line.push(b' ');
		}
		line.extend_from_slice(
			format!(" mode=0{:o} len={}{uid}{gid} flags={:x}\n", e.mode, big_num(e.size as i64, 1), e.flags)
				.as_bytes(),
		);
		logger.rprintf(LogCode::Info, &line);
	}
}

/// Upstream start_filelist_progress.
fn start_filelist_progress(ctx: &Ctx, kind: &str) {
	if ctx.opts.quiet > 0 {
		return;
	}
	ctx.logger.rprintf(LogCode::Client, format!("{kind} ... ").as_bytes());
	ctx.logger.set_needs_newline(1);
	ctx.logger.flush();
}

/// Upstream maybe_emit_filelist_progress.
fn maybe_emit_filelist_progress(ctx: &Ctx, show: bool, count: usize) {
	if !show
		|| ctx.logger.levels().info(Info::Flist) < 2
		|| !count.is_multiple_of(100)
		|| ctx.opts.quiet > 0
	{
		return;
	}
	if ctx.logger.needs_newline() == 2 {
		ctx.logger.set_needs_newline(0);
	}
	ctx.logger.rprintf(LogCode::Client, format!(" {count} files...\r").as_bytes());
	ctx.logger.set_needs_newline(2);
}

/// Upstream finish_filelist_progress.
fn finish_filelist_progress(ctx: &Ctx, used: usize) {
	ctx.logger.set_needs_newline(0);
	if ctx.logger.levels().info(Info::Flist) >= 2 {
		let s = if used == 1 { " " } else { "s " };
		ctx.logger.rprintf(LogCode::Info, format!("{used} file{s}to consider\n").as_bytes());
	} else {
		ctx.logger.rprintf(LogCode::Info, b"done\n");
	}
}

/// Upstream `show_filelist_progress`.
fn shows_filelist_progress(ctx: &Ctx) -> bool {
	ctx.logger.levels().info(Info::Flist) >= 1
		&& ctx.opts.xfer_dirs != 0
		&& !ctx.am_server
		&& !ctx.inc_recurse
}

/// Upstream `use_safe_inc_flist`.
fn safe_inc_flist(ctx: &Ctx) -> bool {
	ctx.proto.has(CF_SAFE_FLIST) || ctx.proto.version >= 31
}

/// Upstream `sender_symlink_iconv`.
fn symlink_iconv(ctx: &Ctx) -> bool {
	ctx.iconv.is_some() && ctx.proto.has(CF_SYMLINK_ICONV)
}

/// Sorts `entries` stably in upstream order; returns them sorted plus `order[t]` = sorted
/// position of the entry that was `t`-th.
fn sort_with_order<T>(entries: Vec<(FileEntry, T)>, proto: crate::rsync::wire::Proto) -> (Vec<(FileEntry, T)>, Vec<u32>) {
	let n = entries.len();
	let mut idx: Vec<usize> = (0..n).collect();
	idx.sort_by(|&a, &b| f_name_cmp(&entries[a].0, &entries[b].0, proto));
	let mut order = vec![0u32; n];
	for (pos, &t) in idx.iter().enumerate() {
		order[t] = pos as u32;
	}
	let mut slots: Vec<Option<(FileEntry, T)>> = entries.into_iter().map(Some).collect();
	let sorted = idx.iter().filter_map(|&t| slots[t].take()).collect();
	(sorted, order)
}

// ---------------------------------------------------------------------------
// Sender
// ---------------------------------------------------------------------------

/// How the sender resolves paths below its bases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Access {
	/// Default: confined beneath the operand (secure_relative_open).
	Confined,
	/// `-L`/`-k`/`--copy-unsafe-links`/`--insecure-links`: legacy kernel resolution.
	Follow,
	/// `--files-from`: the trusted-owner walk.
	FilesFrom,
}

/// Kinds of cached trees.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum TreeKind {
	/// Root followed like `chdir` (the cwd, a base, an operand anchor, `/`), resolution
	/// confined below it. `--confine-root` does not apply: it bounds operator- or
	/// peer-supplied paths (files-from entries, merge files), not transfer roots.
	Plain,
	/// Opened through the trusted-owner walk and `--confine-root` (files-from entries).
	Owner,
}

/// One pathname context (upstream `F_PATHNAME`).
struct Base {
	/// As given (None = the starting directory), for `--debug=FLIST3`.
	dir: Option<Vec<u8>>,
	abs: PathBuf,
}

/// A remembered operand root (upstream sender_source_root).
struct Anchor {
	full: Vec<u8>,
	path: PathBuf,
	id: Option<(u64, u64)>,
}

/// Sender-only data about one entry.
#[derive(Clone, Debug, Default)]
struct Aux {
	base: u32,
	/// Transmission-order directory number (upstream F_NDX under --iconv).
	dir_wire: i32,
	/// `-R` names deferred to this implied directory's segment.
	relnames: Vec<(u8, Vec<u8>)>,
}

/// One node of upstream's sender dir_flist tree.
struct DirNode {
	ndx: i32,
	wire: i32,
	base: u32,
	name: Vec<u8>,
	flags: u32,
	parent: i32,
	first_child: i32,
	next_sibling: i32,
	relnames: Vec<(u8, Vec<u8>)>,
	done: bool,
}

/// The implied directory most recently sent (upstream `lastpath_struct`).
#[derive(Clone, Copy, Debug)]
enum DirRef {
	Building(usize),
	Node(usize),
}

/// Where a stat for `make_file` goes.
#[derive(Clone, Copy)]
enum At<'a> {
	/// By path from the current base (operands, implied dirs, files-from names).
	Path,
	/// A leaf inside a directory being scanned (its tree held open).
	Dir(&'a Tree, &'a [u8]),
}

/// An entry `make_file` produced.
struct Made {
	e: FileEntry,
	st: St,
}

/// Counters folded into `ctx.stats` at the end of each list.
#[derive(Default)]
struct Counts {
	dirs: i32,
	symlinks: i32,
	devices: i32,
	specials: i32,
	total_size: i64,
}

/// Sender-side file-list builder (send_file_list / send_extra_file_list).
pub(crate) struct Scanner {
	ctx: Ctx,
	filters: Filters,
	files_from: Option<Box<dyn Read + Send>>,
	sources: Vec<Vec<u8>>,
	access: Access,
	recurse: bool,
	xfer_dirs: bool,
	relative: bool,
	implied_dirs: bool,
	orig: PathBuf,
	bases: Vec<Base>,
	cur_base: u32,
	anchors: Vec<Anchor>,
	trees: Mutex<HashMap<(PathBuf, TreeKind), Tree>>,
	enc: FlistEncoder,
	ids: IdLists,
	hlinks: HlinkTracker,
	acls: AclSender,
	xattrs: XattrSender,
	ndx: NdxCodec,
	building: Vec<(FileEntry, Aux)>,
	ndx_start: i32,
	/// Per pushed segment: (ndx_start, base of each sorted entry).
	seg_bases: Vec<(i32, Vec<u32>)>,
	dirs: Vec<DirNode>,
	send_dir_ndx: i32,
	send_dir_depth: i32,
	flist_eof: bool,
	old_total: usize,
	filesystem_dev: u64,
	dirs_sent: i32,
	lastpath: Vec<u8>,
	lastpath_base: Option<u32>,
	lastpath_ref: Option<DirRef>,
	counts: Counts,
	/// A fatal error `make_file` hit (a corrupt `--fake-super` stat record).
	fatal: Option<RsyncError>,
	show_progress: bool,
	use_ff: bool,
}

impl Scanner {
	/// Sender roots per operand (each a `Tree`), filters (sender side), optional files-from stream.
	///
	/// With `files_from`, `sources[0]` (if any) is the directory the names are relative to.
	pub(crate) fn new(
		ctx: &Ctx,
		sources: &[OsString],
		filters: Filters,
		files_from: Option<Box<dyn Read + Send>>,
	) -> Result<Self, RsyncError> {
		let o = &ctx.opts;
		let mut srcs = Vec::with_capacity(sources.len());
		for s in sources {
			let mut b = os_bytes(s).map_err(|e| RsyncError::new(RERR_SYNTAX, format!("{e}")))?.to_vec();
			forward_slashes(&mut b);
			srcs.push(b);
		}
		let follow = o.copy_links || o.copy_unsafe_links || o.copy_dirlinks || o.insecure_links;
		let access = if follow {
			Access::Follow
		} else if files_from.is_some() {
			Access::FilesFrom
		} else {
			Access::Confined
		};
		let proto = ctx.proto;
		let mut enc = FlistEncoder::new(proto, ctx.flist_opts.clone());
		enc.set_logger(ctx.logger.clone());
		let mut ids = IdLists::new(proto, &ctx.flist_opts);
		ids.set_logger(ctx.logger.clone());
		let mut hlinks = HlinkTracker::new(proto);
		hlinks.set_logger(ctx.logger.clone());
		let mut xattrs = XattrSender::with_opts(ctx.xattr_opts);
		xattrs.set_role(ctx.logger.role());
		let mut filters = filters;
		filters.set_role(ctx.logger.role());
		filters.set_logger(Some(ctx.logger.clone()));
		filters.set_am_sender(true);
		let relative = o.relative_paths > 0;
		// A local list may be read ahead; the protocol stream must not be.
		let files_from = match files_from {
			Some(r) if o.filesfrom_host.is_none() => {
				Some(Box::new(BufReader::new(r)) as Box<dyn Read + Send>)
			},
			other => other,
		};
		Ok(Self {
			ctx: ctx.clone(),
			filters,
			use_ff: files_from.is_some(),
			files_from,
			sources: srcs,
			access,
			recurse: o.recurse != 0,
			xfer_dirs: o.xfer_dirs != 0,
			relative,
			implied_dirs: o.implied_dirs || (relative && proto.version >= 30),
			orig: ctx.cwd.clone(),
			bases: Vec::new(),
			cur_base: 0,
			anchors: Vec::new(),
			trees: Mutex::new(HashMap::new()),
			enc,
			ids,
			hlinks,
			acls: AclSender::new(ctx.acl_opts),
			xattrs,
			ndx: NdxCodec::new(proto),
			building: Vec::new(),
			ndx_start: 0,
			seg_bases: Vec::new(),
			dirs: Vec::new(),
			send_dir_ndx: -1,
			send_dir_depth: -1,
			flist_eof: false,
			old_total: 0,
			filesystem_dev: 0,
			dirs_sent: 0,
			lastpath: Vec::new(),
			lastpath_base: None,
			lastpath_ref: None,
			counts: Counts::default(),
			fatal: None,
			show_progress: shows_filelist_progress(ctx),
		})
	}

	/// The write-direction ndx codec of this connection: every ndx the sending side writes
	/// (file indices, NDX_DONE, the NDX_FLIST_* markers) must go through it.
	pub(crate) fn ndx_codec(&mut self) -> &mut NdxCodec {
		&mut self.ndx
	}

	/// Upstream `file_old_total` (maintained by the sender loop).
	pub(crate) fn set_old_total(&mut self, n: usize) {
		self.old_total = n;
	}

	pub(crate) fn xattrs(&mut self) -> &mut XattrSender {
		&mut self.xattrs
	}

	// ----- small utilities --------------------------------------------------

	fn logger(&self) -> &Logger {
		&self.ctx.logger
	}

	fn add_io_error(&self, bits: i32) {
		self.ctx.io_error.fetch_or(bits, Ordering::Relaxed);
	}

	fn io_error(&self) -> i32 {
		self.ctx.io_error.load(Ordering::Relaxed)
	}

	fn base(&self) -> &Base {
		&self.bases[self.cur_base as usize]
	}

	/// Upstream full_fname relative to the current base.
	fn full_fname_in(&self, base: u32, name: &[u8]) -> Vec<u8> {
		full_fname(self.bases.get(base as usize).map_or(&self.orig, |b| &b.abs), name)
	}

	fn full_fname_cur(&self, name: &[u8]) -> Vec<u8> {
		self.full_fname_in(self.cur_base, name)
	}

	fn excluded(&self, name: &[u8], is_dir: bool) -> bool {
		self.filters.check(name, is_dir, Side::Sender) == Verdict::Exclude
	}

	fn tree_opts(&self, kind: TreeKind) -> TreeOpts {
		TreeOpts {
			insecure_links: self.access == Access::Follow,
			operator_named: kind == TreeKind::Owner,
			confine: if kind == TreeKind::Owner { self.ctx.opts.confine_root.as_ref().map(PathBuf::from) } else { None },
		}
	}

	fn open_tree(&self, root: &Path, kind: TreeKind) -> io::Result<Tree> {
		let key = (root.to_path_buf(), kind);
		let mut cache = lock(&self.trees);
		if let Some(t) = cache.get(&key) {
			return Ok(t.clone());
		}
		let tree = Tree::open(&self.ctx.fs, root, &self.tree_opts(kind))?;
		if cache.len() >= 256 {
			cache.clear();
		}
		cache.insert(key, tree.clone());
		Ok(tree)
	}

	/// The cleaned absolute spelling of `name` under `base` (sender_source_full_path).
	fn full_path_bytes(&self, base: u32, name: &[u8]) -> Vec<u8> {
		let joined = if is_absolute_bytes(name) {
			name.to_vec()
		} else {
			let mut b = path_bytes(&self.bases[base as usize].abs).into_owned();
			b.push(b'/');
			b.extend_from_slice(name);
			b
		};
		paths::clean_fname_flags(&joined, CFN_COLLAPSE_DOT_DOT_DIRS | CFN_DROP_TRAILING_DOT_DIR)
			.unwrap_or_else(|p| p)
	}

	/// Confined resolution of `name`: the best anchor and the rest of the path below it.
	fn anchor_for(&self, base: u32, name: &[u8]) -> io::Result<(Tree, Vec<u8>)> {
		let full = self.full_path_bytes(base, name);
		let mut best: Option<&Anchor> = None;
		for a in &self.anchors {
			let len = a.full.len();
			if full.starts_with(&a.full)
				&& (a.full.last() == Some(&b'/') || full.len() == len || full.get(len) == Some(&b'/'))
				&& best.is_none_or(|b| len > b.full.len())
			{
				best = Some(a);
			}
		}
		if let Some(a) = best {
			let tree = self.open_tree(&a.path, TreeKind::Plain)?;
			if let Some((dev, ino)) = a.id {
				let st = tree.lstat(Path::new(""))?;
				if st.dev().is_some_and(|d| d != dev) || st.ino().is_some_and(|i| i != ino) {
					return Err(paths::loop_error());
				}
			}
			let rel: Vec<u8> = full[a.full.len()..].iter().copied().skip_while(|&b| b == b'/').collect();
			return Ok((tree, rel));
		}
		if is_absolute_bytes(name) {
			let tree = self.open_tree(Path::new("/"), TreeKind::Plain)?;
			let rel = name.iter().copied().skip_while(|&b| b == b'/').collect();
			return Ok((tree, rel));
		}
		let tree = self.open_tree(&self.bases[base as usize].abs, TreeKind::Plain)?;
		Ok((tree, paths::clean_fname(name, false)))
	}

	/// A tree and relative path through which `name`'s own object is reached.
	fn locate(&self, base: u32, name: &[u8]) -> io::Result<(Tree, PathBuf)> {
		match self.access {
			Access::Confined => {
				let (tree, rel) = self.anchor_for(base, name)?;
				Ok((tree, bytes_path(&rel)?.to_path_buf()))
			},
			Access::Follow | Access::FilesFrom => {
				let full = join_name(&self.bases[base as usize].abs, name)?;
				let kind = if self.access == Access::Follow { TreeKind::Plain } else { TreeKind::Owner };
				match (full.parent(), full.file_name()) {
					(Some(parent), Some(leaf)) => {
						let leaf = PathBuf::from(leaf);
						Ok((self.open_tree(parent, kind)?, leaf))
					},
					_ => Ok((self.open_tree(&full, kind)?, PathBuf::new())),
				}
			},
		}
	}

	/// A tree rooted at the directory `name` (for scanning it).
	fn locate_dir(&self, base: u32, name: &[u8]) -> io::Result<Tree> {
		match self.access {
			Access::Confined => {
				let (tree, rel) = self.anchor_for(base, name)?;
				if rel.is_empty() || rel == b"." { Ok(tree) } else { tree.subtree(&bytes_path(&rel)?) }
			},
			Access::Follow => self.open_tree(&join_name(&self.bases[base as usize].abs, name)?, TreeKind::Plain),
			Access::FilesFrom => {
				let tree = Tree::open(
					&self.ctx.fs,
					&join_name(&self.bases[base as usize].abs, name)?,
					&self.tree_opts(TreeKind::Owner),
				)?;
				Ok(tree)
			},
		}
	}

	// ----- stats ------------------------------------------------------------

	/// link_stat: `follow_dirlinks` follows a symlink to a directory; `force_follow`
	/// is upstream's temporary `copy_links = 1` (implied directories). Under
	/// `--fake-super` the stat xattr is folded in (upstream's x_stat/x_lstat).
	fn link_stat(&self, at: At<'_>, name: &[u8], follow_dirlinks: bool, force_follow: bool) -> io::Result<St> {
		let st = self.link_stat_raw(at, name, follow_dirlinks, force_follow)?;
		self.fake_overlay(at, name, st)
	}

	/// `--fake-super`: `st` with the mode, owner, and device number the entry's
	/// `rsync.%stat` xattr records (read without following, like upstream's
	/// `lgetxattr`). Devices and specials never carry one; a corrupt record is fatal.
	fn fake_overlay(&self, at: At<'_>, name: &[u8], mut st: St) -> io::Result<St> {
		if !self.ctx.meta.fake_super || mode_is_device(st.mode) || mode_is_special(st.mode) {
			return Ok(st);
		}
		let (tree, rel) = self.reader(at, name)?;
		// Re-stat the same object `st` describes (followed unless it is the link itself).
		let mut mo = self.ctx.meta.clone();
		mo.copy_links = !mode_is_lnk(st.mode);
		let md = meta::x_lstat(&tree, &rel, &mo, &self.ctx.logger)?;
		let fake = St::of(&md);
		st.mode = fake.mode;
		st.uid = fake.uid;
		st.gid = fake.gid;
		st.rdev = fake.rdev;
		Ok(st)
	}

	fn link_stat_raw(&self, at: At<'_>, name: &[u8], follow_dirlinks: bool, force_follow: bool) -> io::Result<St> {
		let copy_links = self.ctx.opts.copy_links || force_follow;
		match at {
			At::Dir(tree, leaf) => {
				let leaf = bytes_path(leaf)?;
				if copy_links {
					return tree.stat(&leaf).map(|m| St::of(&m));
				}
				let st = St::of(&tree.lstat(&leaf)?);
				if mode_is_lnk(st.mode) && follow_dirlinks {
					if self.access == Access::FilesFrom {
						return self.ff_follow(name, st);
					}
					if let Ok(m) = tree.stat(&leaf)
						&& m.is_dir()
					{
						return Ok(St::of(&m));
					}
				}
				Ok(st)
			},
			At::Path => {
				if self.access == Access::FilesFrom {
					let (tree, leaf) = self.locate(self.cur_base, name)?;
					let st = St::of(&tree.lstat(&leaf)?);
					if mode_is_lnk(st.mode) && (follow_dirlinks || copy_links) {
						return self.ff_follow(name, st);
					}
					return Ok(st);
				}
				let path = join_name(&self.base().abs, name)?;
				if copy_links {
					return self.ctx.fs.metadata(&path).map(|m| St::of(&m));
				}
				let st = St::of(&self.ctx.fs.symlink_metadata(&path)?);
				if mode_is_lnk(st.mode)
					&& follow_dirlinks
					&& let Ok(m) = self.ctx.fs.metadata(&path)
					&& m.is_dir()
				{
					return Ok(St::of(&m));
				}
				Ok(st)
			},
		}
	}

	/// files-from: a list-selected directory symlink is followed only through the
	/// trusted-owner (and `--confine-root`) walk. A target that is missing, not a
	/// directory, or unreadable keeps the symlink's own stat; a refused walk (ELOOP) fails
	/// the stat, as upstream's filesfrom_link_stat does.
	fn ff_follow(&self, name: &[u8], lst: St) -> io::Result<St> {
		let full = join_name(&self.base().abs, name)?;
		match Tree::open(&self.ctx.fs, &full, &self.tree_opts(TreeKind::Owner))
			.and_then(|t| t.lstat(Path::new("")))
		{
			Ok(m) => Ok(St::of(&m)),
			Err(e)
				if matches!(
					e.kind(),
					io::ErrorKind::NotFound | io::ErrorKind::NotADirectory | io::ErrorKind::PermissionDenied
				) =>
			{
				Ok(lst)
			},
			Err(e) => Err(e),
		}
	}

	fn readlink(&self, at: At<'_>, name: &[u8]) -> io::Result<Vec<u8>> {
		let target = match at {
			At::Dir(tree, leaf) => tree.read_link(&bytes_path(leaf)?)?,
			At::Path => {
				if self.access == Access::FilesFrom {
					let (tree, leaf) = self.locate(self.cur_base, name)?;
					tree.read_link(&leaf)?
				} else {
					self.ctx.fs.read_link(join_name(&self.base().abs, name)?)?
				}
			},
		};
		let mut bytes = os_bytes(target.as_os_str())?.to_vec();
		forward_slashes(&mut bytes);
		Ok(bytes)
	}

	/// Plain lstat (x_lstat), whatever the link options say.
	fn x_lstat(&self, at: At<'_>, name: &[u8]) -> io::Result<St> {
		match at {
			At::Dir(tree, leaf) => tree.lstat(&bytes_path(leaf)?).map(|m| St::of(&m)),
			At::Path => self.ctx.fs.symlink_metadata(join_name(&self.base().abs, name)?).map(|m| St::of(&m)),
		}
	}

	fn x_stat(&self, at: At<'_>, name: &[u8]) -> io::Result<St> {
		let st = match at {
			At::Dir(tree, leaf) => tree.stat(&bytes_path(leaf)?).map(|m| St::of(&m))?,
			At::Path => self.ctx.fs.metadata(join_name(&self.base().abs, name)?).map(|m| St::of(&m))?,
		};
		self.fake_overlay(at, name, st)
	}

	/// readlink_stat: the stat (per the link options) plus a symlink's target.
	fn readlink_stat(&self, at: At<'_>, name: &[u8], force_follow: bool) -> io::Result<(St, Option<Vec<u8>>)> {
		let o = &self.ctx.opts;
		let st = self.link_stat(at, name, o.copy_dirlinks, force_follow)?;
		if !mode_is_lnk(st.mode) {
			return Ok((st, None));
		}
		let mut target = self.readlink(at, name)?;
		if o.copy_unsafe_links && paths::unsafe_symlink(&target, name) {
			if self.logger().levels().info(Info::Symsafe) >= 1 {
				self.logger().rprintf(
					LogCode::Info,
					&[&b"copying unsafe symlink \""[..], name, b"\" -> \"", &target, b"\"\n"].concat(),
				);
			}
			return Ok((self.x_stat(at, name)?, None));
		}
		if o.munge_symlinks && target.len() > SYMLINK_PREFIX.len() && target.starts_with(SYMLINK_PREFIX) {
			target.drain(..SYMLINK_PREFIX.len());
		}
		Ok((st, Some(target)))
	}

	/// Reading handle for the object `name` (ACLs, xattrs, checksum, device size).
	fn reader(&self, at: At<'_>, name: &[u8]) -> io::Result<(Tree, PathBuf)> {
		match at {
			At::Dir(tree, leaf) => Ok((tree.clone(), bytes_path(leaf)?.to_path_buf())),
			At::Path => self.locate(self.cur_base, name),
		}
	}

	/// upstream interpret_stat_error.
	fn interpret_stat_error(&self, name: &[u8], err: &io::Error, is_dir: bool) {
		if err.kind() == io::ErrorKind::NotFound {
			self.add_io_error(IOERR_VANISHED);
			let what: &[u8] = if is_dir { b"directory" } else { b"file" };
			self.logger().rprintf(
				LogCode::Warning,
				&[what, b" has vanished: ", &self.full_fname_cur(name), b"\n"].concat(),
			);
		} else {
			self.add_io_error(IOERR_GENERAL);
			let text = [&b"link_stat "[..], &self.full_fname_cur(name), b" failed"].concat();
			self.logger().rsyserr(LogCode::ErrorXfer, err, &text);
		}
	}

	// ----- pathname contexts --------------------------------------------------

	/// change_pathname(NULL, dir, -dirlen): switches the base, false on failure.
	fn change_pathname(&mut self, dir: Option<&[u8]>) -> bool {
		if let Some(i) = self.bases.iter().position(|b| b.dir.as_deref() == dir) {
			self.cur_base = i as u32;
			let abs = path_bytes(&self.bases[i].abs);
			self.filters.set_curr_dir(&abs);
			return true;
		}
		let abs = match dir {
			None => Ok(self.orig.clone()),
			Some(d) if is_absolute_bytes(d) => bytes_path(d).map(|p| self.ctx.paths.resolve(p)),
			Some(d) => join_name(&self.orig, d),
		};
		let checked = abs.and_then(|abs| match self.ctx.fs.metadata(&abs) {
			Ok(m) if m.is_dir() => Ok(abs),
			Ok(_) => Err(io::Error::from(io::ErrorKind::NotADirectory)),
			Err(e) => Err(e),
		});
		match checked {
			Ok(abs) => {
				self.filters.set_curr_dir(&path_bytes(&abs));
				self.bases.push(Base { dir: dir.map(<[u8]>::to_vec), abs });
				self.cur_base = (self.bases.len() - 1) as u32;
				true
			},
			Err(e) => {
				self.add_io_error(IOERR_GENERAL);
				let ff = full_fname(&self.orig, dir.unwrap_or(b"."));
				self.logger().rsyserr(LogCode::ErrorXfer, &e, &[&b"change_dir "[..], &ff, b" failed"].concat());
				false
			},
		}
	}

	/// Switches to an existing base (change_pathname(file, NULL, 0)).
	fn use_base(&mut self, base: u32) {
		if self.cur_base != base && (base as usize) < self.bases.len() {
			self.cur_base = base;
			let abs = path_bytes(&self.bases[base as usize].abs);
			self.filters.set_curr_dir(&abs);
		}
	}

	/// remember_sender_source_arg.
	fn remember_arg(&mut self, name: &[u8], st: &St) {
		let full = self.full_path_bytes(self.cur_base, name);
		let (full, id) = if mode_is_dir(st.mode) {
			(full, st.has_id.then_some((st.dev, st.ino)))
		} else {
			let Some(slash) = memchr::memrchr(b'/', &full) else {
				return;
			};
			let parent = if slash == 0 { full[..1].to_vec() } else { full[..slash].to_vec() };
			let Ok(path) = bytes_path(&parent) else {
				return;
			};
			match self.ctx.fs.metadata(&path) {
				Ok(m) if m.is_dir() => {
					let s = St::of(&m);
					(parent, s.has_id.then_some((s.dev, s.ino)))
				},
				_ => return,
			}
		};
		if self.anchors.iter().any(|a| a.full == full) {
			return;
		}
		let Ok(path) = bytes_path(&full).map(Path::to_path_buf) else {
			return;
		};
		self.anchors.push(Anchor { full, path, id });
	}

	/// Reads per-directory merge files the way upstream's parse_filter_file opens them:
	/// through the trusted-owner walk, confined to `--confine-root`; a file that cannot
	/// be opened (missing, refused, outside the root) simply contributes no rules.
	fn filter_reader(&self) -> impl Fn(&[u8]) -> io::Result<Option<Vec<u8>>> + use<> {
		let fs = self.ctx.fs.clone();
		let base = self.base().abs.clone();
		let insecure = self.ctx.opts.insecure_links;
		let confine = self.ctx.opts.confine_root.as_ref().map(PathBuf::from);
		move |p: &[u8]| -> io::Result<Option<Vec<u8>>> {
			let path = join_name(&base, p)?;
			let opts = paths::OperatorOpts { insecure, confine: confine.as_deref() };
			let Ok(mut file) = paths::open_operator_file_with(&fs, &path, &opts) else {
				return Ok(None);
			};
			let mut data = Vec::new();
			file.read_to_end(&mut data)?;
			Ok(Some(data))
		}
	}

	/// change_local_filter_dir.
	fn change_filter_dir(&mut self, dir: Option<&[u8]>, depth: usize) -> Result<(), RsyncError> {
		let read = self.filter_reader();
		self.filters.change_dir(dir, depth, &read)?;
		if self.filters.take_io_error() {
			self.add_io_error(IOERR_GENERAL);
		}
		Ok(())
	}

	// ----- entries ----------------------------------------------------------

	/// make_file.
	#[allow(clippy::too_many_arguments)]
	fn make_file(
		&mut self,
		fname: &[u8],
		stp: Option<&St>,
		mut flags: u32,
		filter_level: u8,
		at: At<'_>,
		implied: bool,
	) -> Option<Made> {
		let o = Arc::clone(&self.ctx.opts);
		if fname.len() >= MAXPATHLEN {
			self.add_io_error(IOERR_GENERAL);
			self.logger().rprintf(LogCode::ErrorXfer, &[&b"skipping overly long name: "[..], fname, b"\n"].concat());
			return None;
		}
		let thisname = paths::clean_fname(fname, false);
		let filtering = filter_level != NO_FILTERS && !implied;
		let (st, link) = match stp {
			Some(st) if mode_is_dir(st.mode) || st.mode == 0 => (*st, None),
			_ => match self.readlink_stat(at, &thisname, implied) {
				Ok(v) => v,
				Err(err) => {
					if let Some(fatal) = meta::corrupt_fake_stat(&err) {
						self.fatal = Some(fatal);
						return None;
					}
					if filtering && (self.excluded(&thisname, false) || self.excluded(&thisname, true)) {
						return None;
					}
					if err.kind() == io::ErrorKind::NotFound {
						let follows = o.copy_links || o.copy_unsafe_links || o.copy_dirlinks || implied;
						let dangling = follows && self.x_lstat(at, &thisname).is_ok_and(|s| mode_is_lnk(s.mode));
						if dangling {
							self.add_io_error(IOERR_GENERAL);
							self.logger().rprintf(
								LogCode::ErrorXfer,
								&[&b"symlink has no referent: "[..], &self.full_fname_cur(&thisname), b"\n"].concat(),
							);
						} else {
							self.add_io_error(IOERR_VANISHED);
							self.logger().rprintf(
								LogCode::Warning,
								&[&b"file has vanished: "[..], &self.full_fname_cur(&thisname), b"\n"].concat(),
							);
						}
					} else {
						self.add_io_error(IOERR_GENERAL);
						let text = [&b"readlink_stat("[..], &self.full_fname_cur(&thisname), b") failed"].concat();
						self.logger().rsyserr(LogCode::ErrorXfer, &err, &text);
					}
					return None;
				},
			},
		};
		if stp.is_none_or(|s| s.mode != 0) && st.mode == 0 {
			self.add_io_error(IOERR_GENERAL);
			self.logger().rprintf(
				LogCode::Info,
				&[&b"skipping file with bogus (zero) st_mode: "[..], &self.full_fname_cur(&thisname), b"\n"].concat(),
			);
			return None;
		}

		if filter_level != NO_FILTERS {
			if mode_is_dir(st.mode) {
				if !self.xfer_dirs && !implied {
					self.logger().rprintf(LogCode::Info, &[&b"skipping directory "[..], &thisname, b"\n"].concat());
					return None;
				}
				if o.one_file_system > 0
					&& st.dev != self.filesystem_dev
					&& flags & FLAG_CONTENT_DIR != 0
					&& flags & FLAG_TOP_DIR == 0
				{
					if o.one_file_system > 1 {
						if self.logger().levels().info(Info::Mount) >= 1 {
							let who = self.logger().role().name();
							self.logger().rprintf(
								LogCode::Info,
								&[format!("[{who}] skipping mount-point dir ").as_bytes(), &thisname, b"\n"].concat(),
							);
						}
						return None;
					}
					flags |= FLAG_MOUNT_DIR;
					flags &= !FLAG_CONTENT_DIR;
				}
			} else {
				flags &= !FLAG_CONTENT_DIR;
			}
			if filtering && self.excluded(&thisname, mode_is_dir(st.mode)) {
				return None;
			}
		}

		if self.logger().levels().debug(DebugFlag::Flist) >= 2 {
			let who = self.logger().role().name();
			self.logger().rprintf(
				LogCode::Info,
				&[format!("[{who}] make_file(").as_bytes(), &thisname, format!(",*,{filter_level})\n").as_bytes()].concat(),
			);
		}

		let (dir, base) = paths::split_name_rooted(&thisname);
		if base.is_empty() {
			return None;
		}
		let mut st = st;
		if o.copy_devices && mode_is_device(st.mode) {
			if st.size == 0
				&& let Ok((tree, rel)) = self.reader(at, &thisname)
				&& let Ok(mut f) = tree.open_read(&rel, true)
			{
				st.size = match f.seek(SeekFrom::End(0)) {
					Ok(n) => {
						if let Err(e) = f.seek(SeekFrom::Start(0)) {
							self.logger().rsyserr(
								LogCode::Error,
								&e,
								&[&b"failed to seek device back to start: "[..], &thisname].concat(),
							);
						}
						n
					},
					Err(e) => {
						self.logger().rsyserr(
							LogCode::Error,
							&e,
							&[&b"failed to get device size via seek: "[..], &thisname].concat(),
						);
						0
					},
				};
			}
			st.mode = S_IFREG | (st.mode & ACCESSPERMS);
			st.mtime = unix_now();
			st.nsec = 0;
		}

		let v = self.ctx.proto.version;
		let mut e = FileEntry {
			dirname: Arc::from(dir),
			basename: base.into(),
			mode: st.mode,
			size: st.size,
			mtime: st.mtime,
			..FileEntry::default()
		};
		e.flags = flags & !FLAG_DIVERT_DIRS;
		let nsec = if st.nsec as i64 > i64::from(MAX_WIRE_NSEC) { 0 } else { st.nsec };
		if nsec != 0 && v >= 31 {
			e.flags |= FLAG_MOD_NSEC;
			e.mtime_nsec = nsec;
		}
		if st.size > 0xFFFF_FFFF && mode_is_reg(st.mode) {
			e.flags |= FLAG_LENGTH64;
		}
		if o.always_checksum && mode_is_reg(st.mode) {
			let follow = o.copy_links || o.copy_unsafe_links;
			let len = self.ctx.flist_opts.checksum_len;
			let sum = self
				.reader(at, &thisname)
				.and_then(|(tree, rel)| tree.open_read(&rel, follow))
				.and_then(|f| {
					checksum::file_checksum(self.ctx.file_sum, self.ctx.seed, self.ctx.proto, &mut f.take(st.size))
				})
				.unwrap_or_else(|_| vec![0; len]);
			let mut sum = sum;
			sum.resize(len, 0);
			e.sum = Some(sum.into());
		}
		if mode_is_device(st.mode) {
			e.rdev = Some(dev_split(st.rdev));
			e.size = 0;
		} else if mode_is_special(st.mode) {
			e.size = 0;
		}
		if o.preserve_uid {
			e.uid = st.uid;
		}
		if o.preserve_gid {
			e.gid = st.gid;
		}
		if self.ctx.flist_opts.preserve_atimes && !mode_is_dir(st.mode) {
			e.atime = st.atime;
		}
		if self.ctx.flist_opts.preserve_crtimes {
			e.crtime = if st.crtime != 0 { st.crtime } else { st.mtime };
		}
		e.link = link.map(Into::into);
		Some(Made { e, st })
	}

	/// send_file_name: makes the entry, sends it (+ ACL/xattr data) and appends it to the
	/// list being built. Returns its position in that list.
	#[allow(clippy::too_many_arguments)]
	fn send_file_name(
		&mut self,
		w: &mut Out,
		fname: &[u8],
		stp: Option<&St>,
		flags: u32,
		filter_level: u8,
		at: At<'_>,
		implied: bool,
	) -> Result<Option<usize>, RsyncError> {
		let Some(Made { mut e, st }) = self.make_file(fname, stp, flags, filter_level, at, implied) else {
			return match self.fatal.take() {
				Some(fatal) => Err(fatal),
				None => Ok(None),
			};
		};
		let o = Arc::clone(&self.ctx.opts);
		if let Some(rules) = &o.chmod_modes
			&& !mode_is_lnk(e.mode)
			&& e.mode != 0
		{
			e.mode = rules.apply(e.mode);
		}
		let name = e.name();
		if self.ctx.flist_opts.preserve_links && mode_is_lnk(e.mode) && e.link.as_deref().is_none_or(<[u8]>::is_empty) {
			self.add_io_error(IOERR_GENERAL);
			self.logger().rprintf(
				LogCode::ErrorXfer,
				&[&b"skipping symlink with 0-length value: "[..], &self.full_fname_cur(&name), b"\n"].concat(),
			);
			return Ok(None);
		}

		// The wire spelling (--iconv).
		let wire = match &self.ctx.iconv {
			None => None,
			Some(ic) => {
				let who = self.logger().role().name();
				let conv = |part: &[u8]| ic.to_wire_io(part);
				let dir = if e.dirname.is_empty() { Ok(Vec::new()) } else { conv(&e.dirname) };
				let names = dir.and_then(|d| conv(&e.basename).map(|b| (d, b)));
				let (wdir, wbase) = match names {
					Ok(v) => v,
					Err(err) => {
						self.add_io_error(IOERR_GENERAL);
						self.logger().rprintf(
							LogCode::ErrorXfer,
							&[
								format!("[{who}] cannot convert filename: ").as_bytes(),
								&name,
								format!(" ({})\n", crate::rsync::log::strerror(&err)).as_bytes(),
							]
							.concat(),
						);
						return Ok(None);
					},
				};
				let mut we = e.clone();
				we.dirname = Arc::from(wdir.as_slice());
				we.basename = wbase.into();
				if symlink_iconv(&self.ctx)
					&& let Some(link) = &e.link
					&& !link.is_empty()
				{
					match ic.to_wire_io(link) {
						Ok(l) => we.link = Some(l.into()),
						Err(err) => {
							self.add_io_error(IOERR_GENERAL);
							self.logger().rprintf(
								LogCode::ErrorXfer,
								&[
									format!("[{who}] cannot convert symlink data for: ").as_bytes(),
									&self.full_fname_cur(&name),
									format!(" ({})\n", crate::rsync::log::strerror(&err)).as_bytes(),
								]
								.concat(),
							);
							return Ok(None);
						},
					}
				}
				Some(we)
			},
		};

		let acl_set = if self.ctx.flist_opts.preserve_acls && !mode_is_lnk(e.mode) {
			match self.reader(at, &name).and_then(|(tree, rel)| {
				acl::read_local_with(&tree, &rel, e.mode, self.ctx.acl_opts, Some(&self.ctx.logger))
			}) {
				Ok(set) => Some(set),
				Err(_) => {
					self.add_io_error(IOERR_GENERAL);
					return Ok(None);
				},
			}
		} else {
			None
		};
		let xattr_set = if self.ctx.flist_opts.preserve_xattrs {
			match self.read_xattrs(at, &name, e.mode) {
				Ok(set) => Some(set),
				Err(_) => {
					self.add_io_error(IOERR_GENERAL);
					return Ok(None);
				},
			}
		} else {
			None
		};

		let ndx = self.ndx_start + self.building.len() as i32;
		if self.ctx.flist_opts.preserve_hard_links && self.ctx.proto.version >= 28 && !mode_is_dir(st.mode) {
			e.hlink = self.hlinks.assign(st.dev, st.ino, st.nlink, st.mode, ndx);
		}

		// send_file_entry and its counters; the wire copy carries the hard-link decision.
		let wire = wire.map(|mut we| {
			we.hlink = e.hlink;
			we
		});
		let sent = wire.as_ref().unwrap_or(&e);
		self.enc.send_entry(w, sent, ndx, &mut self.ids).map_err(RsyncError::from_stream)?;
		if let Some(set) = &acl_set {
			self.acls.send(w, set, e.mode, &mut self.ids).map_err(RsyncError::from_stream)?;
		}
		if let Some(set) = &xattr_set {
			let x = self.xattrs.send_indexed(w, set, self.ctx.proto).map_err(RsyncError::from_stream)?;
			e.xattr = Some(x);
		}
		let mut aux = Aux { base: self.cur_base, dir_wire: -1, relnames: Vec::new() };
		if mode_is_dir(e.mode) {
			aux.dir_wire = self.dirs_sent;
			self.dirs_sent += 1;
			self.counts.dirs += 1;
		} else if mode_is_lnk(e.mode) {
			self.counts.symlinks += 1;
		} else if mode_is_device(e.mode) {
			self.counts.devices += 1;
		} else if mode_is_special(e.mode) {
			self.counts.specials += 1;
		}
		if mode_is_reg(e.mode) || mode_is_lnk(e.mode) {
			self.counts.total_size += e.size as i64;
		}
		self.building.push((e, aux));
		let pos = self.building.len() - 1;
		maybe_emit_filelist_progress(&self.ctx, self.show_progress, self.building.len());
		Ok(Some(pos))
	}

	fn read_xattrs(&self, at: At<'_>, name: &[u8], mode: u32) -> io::Result<XattrSet> {
		let (tree, rel) = self.reader(at, name)?;
		let excl = |n: &[u8]| self.filters.xattr_excluded(n);
		let xctx = XattrCtx {
			filter: if self.filters.has_xattr_rules() { Some(&excl) } else { None },
			logger: Some(&self.ctx.logger),
			..XattrCtx::default()
		};
		xattr::read_local_with(&tree, &rel, Some(mode), false, self.ctx.xattr_opts, xctx)
	}

	fn building_is_dir(&self, pos: Option<usize>) -> bool {
		pos.and_then(|p| self.building.get(p)).is_some_and(|(e, _)| e.is_dir())
	}

	/// send_directory: sends the contents of the directory `dir` (a name under the base).
	fn send_directory(&mut self, w: &mut Out, dir: &[u8], flags: u32) -> Result<(), RsyncError> {
		let divert = flags & FLAG_DIVERT_DIRS != 0;
		let start = self.building.len();
		let opened = self.locate_dir(self.cur_base, dir).and_then(|tree| {
			let names = tree.read_dir(Path::new(""))?;
			Ok((tree, names))
		});
		let (tree, names) = match opened {
			Ok(v) => v,
			Err(err) => {
				if err.kind() == io::ErrorKind::NotFound {
					self.interpret_stat_error(dir, &err, true);
					return Ok(());
				}
				self.add_io_error(IOERR_GENERAL);
				let text = [&b"opendir "[..], &self.full_fname_cur(dir), b" failed"].concat();
				self.logger().rsyserr(LogCode::ErrorXfer, &err, &text);
				return Ok(());
			},
		};
		let prefix: Vec<u8> = if dir == b"/" { Vec::new() } else { dir.to_vec() };
		let remainder = if dir == b"/" {
			MAXPATHLEN - 1
		} else if dir.len() < MAXPATHLEN - 1 {
			MAXPATHLEN - (dir.len() + 1)
		} else {
			0
		};
		for os in names {
			self.ctx.check_cancel()?;
			let dname = match os_bytes(&os) {
				Ok(b) => b,
				Err(err) => {
					self.add_io_error(IOERR_GENERAL);
					let text = [&b"readdir("[..], &self.full_fname_cur(dir), b")"].concat();
					self.logger().rsyserr(LogCode::ErrorXfer, &err, &text);
					continue;
				},
			};
			if dname == b"." || dname == b".." {
				continue;
			}
			if dname.len() >= remainder {
				self.add_io_error(IOERR_GENERAL);
				self.logger().rprintf(
					LogCode::ErrorXfer,
					&[
						format!("filename overflows max-path len by {}: ", dname.len() - remainder + 1).as_bytes(),
						dir,
						b"/",
						&dname,
						b"\n",
					]
					.concat(),
				);
				continue;
			}
			if dname.is_empty() {
				self.add_io_error(IOERR_GENERAL);
				self.logger().rprintf(
					LogCode::ErrorXfer,
					&[&b"cannot send file with empty name in "[..], &self.full_fname_cur(dir), b"\n"].concat(),
				);
				continue;
			}
			let mut fbuf = prefix.clone();
			fbuf.push(b'/');
			fbuf.extend_from_slice(&dname);
			self.send_file_name(w, &fbuf, None, flags, ALL_FILTERS, At::Dir(&tree, &dname), false)?;
		}
		if self.recurse && !divert {
			let end = self.building.len();
			for i in start..end {
				self.send_if_directory(w, i, flags)?;
			}
		}
		Ok(())
	}

	/// send_if_directory (non-incremental recursion).
	fn send_if_directory(&mut self, w: &mut Out, pos: usize, flags: u32) -> Result<(), RsyncError> {
		let (is_dir, mount, name) = {
			let (e, _) = &self.building[pos];
			(e.is_dir(), e.flags & FLAG_MOUNT_DIR != 0, e.name())
		};
		if !is_dir || mount {
			return Ok(());
		}
		let mut name = name;
		if name.len() > 1 {
			name.pop_if(|b| *b == b'/');
		}
		let read = self.filter_reader();
		let mark = self.filters.enter_dir(&name, &read)?;
		if self.filters.take_io_error() {
			self.add_io_error(IOERR_GENERAL);
		}
		let res = self.send_directory(w, &name, flags);
		self.filters.leave_dir(mark);
		res
	}

	/// send_implied_dirs.
	fn send_implied_dirs(
		&mut self,
		w: &mut Out,
		fname: &[u8],
		start: usize,
		limit: usize,
		flags: u32,
		name_type: u8,
	) -> Result<(), RsyncError> {
		let flags = (flags | FLAG_IMPLIED_DIR) & !(FLAG_TOP_DIR | FLAG_CONTENT_DIR);
		let inc = self.ctx.inc_recurse;
		let mut start = start;
		let mut depth = 0usize;
		let need_new_dir = if inc {
			!(self.lastpath_ref.is_some()
				&& self.lastpath_base == Some(self.cur_base)
				&& self.lastpath.as_slice() == &fname[..limit])
		} else {
			let mut i = 0;
			loop {
				if i == limit {
					if matches!(self.lastpath.get(i), None | Some(&b'/')) {
						return Ok(());
					}
					break;
				}
				if self.lastpath.get(i) != Some(&fname[i]) {
					break;
				}
				if fname[i] == b'/' {
					start = i;
					depth += 1;
				}
				i += 1;
			}
			true
		};
		if need_new_dir {
			let prefix = fname[..limit].to_vec();
			let mut from = start + 1;
			while let Some(off) = prefix.get(from..).and_then(|rest| memchr::memchr(b'/', rest)) {
				let slash = from + off;
				let sub = prefix[..slash].to_vec();
				let pos = self.send_file_name(w, &sub, None, flags, ALL_FILTERS, At::Path, true)?;
				depth += 1;
				if !inc && self.building_is_dir(pos) {
					self.change_filter_dir(Some(&sub), depth)?;
				}
				from = slash + 1;
			}
			let pos = self.send_file_name(w, &prefix, None, flags, ALL_FILTERS, At::Path, true)?;
			if inc {
				self.lastpath_ref = if self.building_is_dir(pos) { pos.map(DirRef::Building) } else { None };
			} else if self.building_is_dir(pos) {
				depth += 1;
				self.change_filter_dir(Some(&prefix), depth)?;
			}
			self.lastpath = prefix;
			self.lastpath_base = Some(self.cur_base);
			if !inc {
				return Ok(());
			}
		}
		let Some(r) = self.lastpath_ref else {
			return Ok(());
		};
		let rel = fname.get(limit + 1..).unwrap_or(b"").to_vec();
		match r {
			DirRef::Building(p) => {
				if let Some((_, aux)) = self.building.get_mut(p) {
					aux.relnames.push((name_type, rel));
				}
			},
			DirRef::Node(n) => {
				if let Some(node) = self.dirs.get_mut(n)
					&& !node.done
				{
					node.relnames.push((name_type, rel));
				}
			},
		}
		Ok(())
	}

	// ----- list finishing ---------------------------------------------------

	/// Sorts the list being built (keeping duplicates, marking duplicate dirs under
	/// inc-recursion), returning it with its sorted aux data and the wire order.
	fn take_sorted(&mut self) -> (FileList, Vec<Aux>, Vec<u32>) {
		let proto = self.ctx.proto;
		let building = std::mem::take(&mut self.building);
		let (sorted, order) = sort_with_order(building, proto);
		let (entries, aux): (Vec<FileEntry>, Vec<Aux>) = sorted.into_iter().unzip();
		let mut list = FileList { entries, ndx_start: self.ndx_start, parent_ndx: -1 };
		list.sort_and_clean_with(
			CleanOpts {
				proto,
				strip_root: false,
				am_sender: true,
				inc_recurse: self.ctx.inc_recurse,
				prune_empty_dirs: None,
			},
			&self.ctx.logger,
		);
		if let Some(DirRef::Building(t)) = self.lastpath_ref {
			// Re-pointed at the dir node by add_dirs_to_tree (or dropped).
			self.lastpath_ref = order.get(t).map(|&p| DirRef::Building(p as usize));
		}
		(list, aux, order)
	}

	/// add_dirs_to_tree: links the list's directories under `parent` (-1 = root).
	fn add_dirs_to_tree(&mut self, parent: i32, list: &FileList, aux: &mut [Aux]) -> Vec<i32> {
		let mut added = Vec::new();
		let mut prev: Option<usize> = None;
		let mut sorted_to_node: HashMap<usize, usize> = HashMap::new();
		for (pos, e) in list.entries.iter().enumerate() {
			if !e.is_dir() {
				continue;
			}
			let a = std::mem::take(&mut aux[pos]);
			let node = DirNode {
				ndx: list.ndx_start + pos as i32,
				wire: a.dir_wire,
				base: a.base,
				name: e.name(),
				flags: e.flags,
				parent: -1,
				first_child: -1,
				next_sibling: -1,
				relnames: a.relnames,
				done: false,
			};
			self.dirs.push(node);
			let idx = self.dirs.len() - 1;
			sorted_to_node.insert(pos, idx);
			added.push(list.ndx_start + pos as i32);
			if &*e.basename == b"." {
				continue;
			}
			if let Some(p) = prev {
				self.dirs[p].next_sibling = idx as i32;
			} else if parent >= 0 {
				self.dirs[parent as usize].first_child = idx as i32;
			} else {
				self.send_dir_ndx = idx as i32;
			}
			self.dirs[idx].parent = parent;
			self.dirs[idx].first_child = -1;
			prev = Some(idx);
		}
		if let Some(p) = prev {
			self.dirs[p].next_sibling = -1;
		}
		if let Some(DirRef::Building(p)) = self.lastpath_ref {
			self.lastpath_ref = sorted_to_node.get(&p).map(|&n| DirRef::Node(n));
		}
		added
	}

	/// Folds this list's counters into ctx.stats.
	fn flush_counts(&mut self, list_len: usize, initial: bool, written: u64) {
		let c = std::mem::take(&mut self.counts);
		let mut stats = lock(&self.ctx.stats);
		stats.num_dirs += c.dirs;
		stats.num_symlinks += c.symlinks;
		stats.num_devices += c.devices;
		stats.num_specials += c.specials;
		stats.total_size += c.total_size;
		stats.flist_size += written as i64;
		if initial {
			stats.num_files = list_len as i32;
		} else {
			stats.num_files += list_len as i32;
		}
	}

	fn debug_list(&self, list: &FileList, bases: &[u32]) {
		if self.logger().levels().debug(DebugFlag::Flist) >= 3 {
			let root = |i: usize| -> Vec<u8> {
				bases
					.get(i)
					.and_then(|&b| self.bases.get(b as usize))
					.and_then(|b| b.dir.clone())
					.unwrap_or_else(|| b"<NULL>".to_vec())
			};
			let o = &self.ctx.flist_opts;
			output_flist(self.logger(), list, &root, o.preserve_uid, o.preserve_gid);
		}
	}

	fn debug_eof(&self) {
		if self.logger().levels().debug(DebugFlag::Flist) >= 3 {
			let who = self.logger().role().name();
			self.logger().rprintf(LogCode::Info, format!("[{who}] flist_eof=1\n").as_bytes());
		}
	}

	/// fatal_unsafe_io_error.
	fn fatal_unsafe_io_error(&self) -> RsyncError {
		let kind = if self.ctx.opts.delete_during == 2 { "delay" } else { "during" };
		let text = format!(
			"FATAL I/O ERROR: dying to avoid a --delete-{kind} issue with a pre-3.0.7 receiver."
		);
		self.logger().rprintf(LogCode::ErrorXfer, format!("{text}\n").as_bytes());
		RsyncError::new(RERR_UNSUPPORTED, text).at("flist.c", 2554)
	}

	// ----- files-from ---------------------------------------------------------

	/// read_line on the files-from stream; None at the end.
	fn next_files_from(&mut self) -> Result<Option<Vec<u8>>, RsyncError> {
		let remote = self.ctx.opts.filesfrom_host.is_some();
		let eol_nulls = self.ctx.opts.eol_nulls || remote;
		let Some(reader) = self.files_from.as_mut() else {
			return Ok(None);
		};
		let line = read_line(reader.as_mut(), eol_nulls, !remote, &self.ctx)?;
		if line.is_empty() {
			return Ok(None);
		}
		let convert = self.ctx.opts.protect_args > 0 && remote;
		let line = match (&self.ctx.iconv, convert) {
			(Some(ic), true) => ic.from_wire_io(&line).unwrap_or(line),
			_ => line,
		};
		Ok(Some(paths::sanitize_path_flags(&line, Some(b""), 0, true)))
	}

	// ----- the initial list ---------------------------------------------------

	/// send_file_list: initial list (+ id lists, ACL/xattr data, io_error end marker).
	pub(crate) fn send_initial(&mut self, out: &MuxWriter, flists: &Flists) -> Result<(), RsyncError> {
		let ctx = self.ctx.clone();
		let o = Arc::clone(&ctx.opts);
		let inc = ctx.inc_recurse;
		let logger = ctx.logger.clone();
		let mut w: Out = out.clone();

		logger.rprintf(LogCode::Log, b"building file list\n");
		if self.show_progress {
			start_filelist_progress(&ctx, "building file list");
		} else if inc && logger.levels().info(Info::Flist) >= 1 && !ctx.am_server {
			logger.rprintf(LogCode::Client, b"sending incremental file list\n");
		}
		let start_write = ctx.counters.total_written();
		let start = Instant::now();
		self.ndx_start = flists.next_ndx_start(inc);
		self.enc.start_list(self.ndx_start);
		let mut flags = if self.recurse { FLAG_CONTENT_DIR } else { 0 };
		if inc {
			flags |= FLAG_DIVERT_DIRS;
		}

		if self.use_ff {
			if let Some(dir) = self.sources.first().cloned() {
				let path = bytes_path(&dir).map(|p| ctx.paths.resolve(p));
				let checked = path.and_then(|p| match ctx.fs.metadata(&p) {
					Ok(m) if m.is_dir() => Ok(p),
					Ok(_) => Err(io::Error::from(io::ErrorKind::NotADirectory)),
					Err(e) => Err(e),
				});
				match checked {
					Ok(p) => self.orig = p,
					Err(e) => {
						let text = [&b"change_dir "[..], &full_fname(&self.orig, &dir), b" failed"].concat();
						logger.rsyserr(LogCode::ErrorXfer, &e, &text);
						return Err(RsyncError::new(RERR_FILESELECT, String::from_utf8_lossy(&text)).at("flist.c", 2791));
					},
				}
			}
		}
		self.bases.clear();
		self.bases.push(Base { dir: None, abs: self.orig.clone() });
		self.cur_base = 0;
		self.filters.set_curr_dir(&path_bytes(&self.orig));

		let mut implied_dot_dir = 0i32;
		let mut last_dir: Option<Option<Vec<u8>>> = None;
		let mut argi = 0usize;
		loop {
			ctx.check_cancel()?;
			let fbuf = if self.use_ff {
				match self.next_files_from()? {
					Some(line) => line,
					None => break,
				}
			} else {
				let Some(arg) = self.sources.get(argi).cloned() else {
					break;
				};
				argi += 1;
				arg
			};
			self.send_operand(&mut w, fbuf, flags, &mut implied_dot_dir, &mut last_dir)?;
		}

		let built = start.elapsed();
		{
			let mut stats = lock(&ctx.stats);
			stats.flist_buildtime = (built.as_millis() as i64).max(1);
		}
		let xfer_start = Instant::now();

		let io_error = self.io_error();
		let safe = safe_inc_flist(&ctx);
		let end_err = if io_error == 0 || o.ignore_errors {
			0
		} else if safe {
			io_error
		} else {
			if o.delete_during != 0 && inc {
				return Err(self.fatal_unsafe_io_error());
			}
			0
		};
		self.enc.send_end(&mut w, end_err).map_err(RsyncError::from_stream)?;
		if ctx.flist_opts.preserve_hard_links && ctx.proto.version >= 30 && !inc {
			self.hlinks.clear();
		}
		if self.show_progress {
			finish_filelist_progress(&ctx, self.building.len());
		}
		{
			let mut stats = lock(&ctx.stats);
			stats.flist_xfertime = xfer_start.elapsed().as_millis() as i64;
		}

		let (mut list, mut aux, order) = self.take_sorted();
		self.ids.send_lists(&mut w, ctx.proto, &ctx.flist_opts).map_err(RsyncError::from_stream)?;
		if ctx.proto.version < 30 {
			let v = if o.ignore_errors { 0 } else { io_error };
			self.enc.send_io_error_int(&mut w, v).map_err(RsyncError::from_stream)?;
		} else if !safe && io_error != 0 && !o.ignore_errors {
			out.send_msg(MSG_IO_ERROR, &io_error.to_le_bytes()).map_err(RsyncError::from_stream)?;
		}
		let written = ctx.counters.total_written().saturating_sub(start_write);
		let len = list.entries.len();
		self.flush_counts(len, true, written);

		let bases: Vec<u32> = aux.iter().map(|a| a.base).collect();
		self.debug_list(&list, &bases);
		if logger.levels().debug(DebugFlag::Flist) >= 2 {
			logger.rprintf(LogCode::Info, b"send_file_list done\n");
		}

		let wire_order = o.need_unsorted_flist.then_some(order);
		if inc {
			self.send_dir_depth = 1;
			let dirs = self.add_dirs_to_tree(-1, &list, &mut aux);
			let first_is_dot = list.entries.iter().find(|e| e.is_active()).is_some_and(|e| &*e.basename == b".");
			list.parent_ndx = if len > 0 && first_is_dot { list.ndx_start + first_active(&list) } else { -1 };
			self.seg_bases.push((list.ndx_start, bases));
			flists.push_full(list, dirs, wire_order);
			if self.send_dir_ndx < 0 {
				self.ndx.write(&mut w, NDX_FLIST_EOF).map_err(RsyncError::from_stream)?;
				self.flist_eof = true;
				flists.set_eof();
				self.debug_eof();
			} else if flists.file_total() == 1 {
				self.send_extra_at_least(out, flists, 1)?;
			}
		} else {
			self.seg_bases.push((list.ndx_start, bases));
			flists.push_full(list, Vec::new(), wire_order);
			self.flist_eof = true;
			flists.set_eof();
			self.debug_eof();
		}
		Ok(())
	}

	/// One operand (or files-from name) of send_file_list.
	fn send_operand(
		&mut self,
		w: &mut Out,
		mut fbuf: Vec<u8>,
		flags: u32,
		implied_dot_dir: &mut i32,
		last_dir: &mut Option<Option<Vec<u8>>>,
	) -> Result<(), RsyncError> {
		let o = Arc::clone(&self.ctx.opts);
		let inc = self.ctx.inc_recurse;
		let mut name_type;
		if self.relative {
			name_type = NORMAL_NAME;
		} else if fbuf.is_empty() || fbuf.last() == Some(&b'/') {
			if fbuf == b"./" {
				fbuf.pop();
			} else {
				if fbuf.len() + 1 >= MAXPATHLEN {
					return Err(overflow());
				}
				fbuf.push(b'.');
			}
			name_type = DOTDIR_NAME;
		} else if fbuf.len() > 1
			&& fbuf.ends_with(b"..")
			&& (fbuf.len() == 2 || fbuf[fbuf.len() - 3] == b'/')
		{
			if fbuf.len() + 2 >= MAXPATHLEN {
				return Err(overflow());
			}
			fbuf.extend_from_slice(b"/.");
			name_type = DOTDIR_NAME;
		} else if fbuf.last() == Some(&b'.') && (fbuf.len() == 1 || fbuf[fbuf.len() - 2] == b'/') {
			name_type = DOTDIR_NAME;
		} else {
			name_type = NORMAL_NAME;
		}

		let dir: Option<Vec<u8>>;
		let mut fname: Vec<u8>;
		if !self.relative {
			match memchr::memrchr(b'/', &fbuf) {
				Some(p) => {
					dir = Some(if p == 0 { b"/".to_vec() } else { fbuf[..p].to_vec() });
					fname = fbuf[p + 1..].to_vec();
				},
				None => {
					dir = None;
					fname = fbuf.clone();
				},
			}
		} else {
			match memchr::memmem::find(&fbuf, b"/./") {
				Some(p) => {
					dir = Some(if p == 0 { b"/".to_vec() } else { paths::clean_fname(&fbuf[..p], false) });
					fname = fbuf[p + 3..].iter().copied().skip_while(|&b| b == b'/').collect();
				},
				None => {
					dir = None;
					fname = fbuf.clone();
				},
			}
			if fname.starts_with(b"./") && fname.len() > 2 && *implied_dot_dir == 0 {
				*implied_dot_dir = -1;
			}
			fname = paths::clean_fname_flags(&fname, CFN_KEEP_TRAILING_SLASH | CFN_DROP_TRAILING_DOT_DIR)
				.unwrap_or_else(|p| p);
			if fname.len() == 1 {
				if fname[0] == b'/' {
					fname = b"/.".to_vec();
					name_type = DOTDIR_NAME;
				} else if fname[0] == b'.' {
					name_type = DOTDIR_NAME;
				}
			} else if fname.pop_if(|b| *b == b'/').is_some() {
				name_type = if fname == b"." { DOTDIR_NAME } else { SLASH_ENDING_NAME };
			}
			let mut i = 0;
			while let Some(off) = memchr::memmem::find(&fname[i..], b"..") {
				let p = i + off;
				let after = fname.get(p + 2).copied();
				if matches!(after, None | Some(b'/')) && (p == 0 || fname[p - 1] == b'/') {
					let text = [&b"found \"..\" dir in relative path: "[..], &fname].concat();
					self.logger().rprintf(LogCode::Error, &[&text[..], b"\n"].concat());
					return Err(RsyncError::new(RERR_SYNTAX, String::from_utf8_lossy(&text)).at("flist.c", 2905));
				}
				i = p + 2;
			}
		}
		if fname.is_empty() {
			fname = b".".to_vec();
			name_type = DOTDIR_NAME;
		}

		let switched = if last_dir.as_ref() != Some(&dir) {
			let ok = self.change_pathname(dir.as_deref());
			if ok {
				*last_dir = Some(dir.clone());
			}
			ok
		} else {
			self.change_pathname(dir.as_deref())
		};
		if !switched {
			if *implied_dot_dir < 0 {
				*implied_dot_dir = 0;
			}
			return Ok(());
		}
		if *implied_dot_dir < 0 {
			*implied_dot_dir = 1;
			self.send_file_name(w, b".", None, (flags | FLAG_IMPLIED_DIR) & !FLAG_CONTENT_DIR, ALL_FILTERS, At::Path, false)?;
		}
		let fbuf = fname;

		let follow = o.copy_dirlinks || name_type != NORMAL_NAME;
		let st = match self.link_stat(At::Path, &fbuf, follow, false) {
			Ok(st) => st,
			Err(err) => {
				if let Some(fatal) = meta::corrupt_fake_stat(&err) {
					return Err(fatal);
				}
				let enoent = err.kind() == io::ErrorKind::NotFound;
				if !enoent || o.missing_args == 0 {
					if !enoent {
						self.add_io_error(IOERR_GENERAL);
					}
					let text = [&b"link_stat "[..], &self.full_fname_cur(&fbuf), b" failed"].concat();
					self.logger().rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(());
				}
				if o.missing_args == 1 {
					return Ok(());
				}
				St::default()
			},
		};
		if name_type != DOTDIR_NAME && st.mode != 0 && self.excluded(&fbuf, mode_is_dir(st.mode)) {
			return Ok(());
		}
		if mode_is_dir(st.mode) && !self.xfer_dirs {
			self.logger().rprintf(LogCode::Info, &[&b"skipping directory "[..], &fbuf, b"\n"].concat());
			return Ok(());
		}
		if !self.use_ff && st.mode != 0 && (self.relative || mode_is_dir(st.mode)) {
			self.remember_arg(&fbuf, &st);
		}

		if inc && self.relative && !fbuf.is_empty() {
			if let Some(off) = fbuf.get(1..).and_then(|rest| memchr::memchr(b'/', rest)) {
				let mut p = off + 1;
				let mut defer = true;
				if p == 1 && fbuf[0] == b'.' {
					match fbuf.get(p + 1..).and_then(|rest| memchr::memchr(b'/', rest)) {
						Some(off2) => p = p + 1 + off2,
						None => defer = false,
					}
				}
				let nt = if st.mode == 0 { MISSING_NAME } else { name_type };
				self.send_implied_dirs(w, &fbuf, 0, p, flags, nt)?;
				if defer {
					return Ok(());
				}
			}
		} else if self.implied_dirs
			&& let Some(p) = memchr::memrchr(b'/', &fbuf)
			&& p != 0
		{
			self.send_implied_dirs(w, &fbuf, 0, p, flags, NORMAL_NAME)?;
		}

		if o.one_file_system > 0 {
			self.filesystem_dev = st.dev;
		}
		if self.recurse || (self.xfer_dirs && name_type != NORMAL_NAME) {
			let pos = self.send_file_name(
				w,
				&fbuf,
				Some(&st),
				FLAG_TOP_DIR | FLAG_CONTENT_DIR | flags,
				NO_FILTERS,
				At::Path,
				false,
			)?;
			let Some(pos) = pos else {
				return Ok(());
			};
			if inc {
				if name_type == DOTDIR_NAME {
					if self.send_dir_depth < 0 {
						self.send_dir_depth = 0;
						self.change_filter_dir(Some(&fbuf), 0)?;
					}
					self.send_directory(w, &fbuf, flags)?;
				}
			} else {
				self.send_if_directory(w, pos, flags)?;
			}
		} else {
			self.send_file_name(w, &fbuf, Some(&st), flags, NO_FILTERS, At::Path, false)?;
		}
		Ok(())
	}

	// ----- extra lists --------------------------------------------------------

	/// send_extra_file_list with upstream's `at_least` (negative: one more than queued).
	pub(crate) fn send_extra_at_least(
		&mut self,
		out: &MuxWriter,
		flists: &Flists,
		at_least: i32,
	) -> Result<(), RsyncError> {
		if self.flist_eof || !self.ctx.inc_recurse {
			return Ok(());
		}
		let ctx = self.ctx.clone();
		let o = Arc::clone(&ctx.opts);
		let save_io_error = self.io_error();
		let queued = |s: &Self| flists.file_total() as i64 - s.old_total as i64;
		let at_least = if at_least < 0 { queued(self) + 1 } else { i64::from(at_least) };
		let mut w: Out = out.clone();
		while queued(self) < at_least {
			ctx.check_cancel()?;
			let Some(first) = usize::try_from(self.send_dir_ndx).ok().filter(|&i| i < self.dirs.len()) else {
				break;
			};
			let start_write = ctx.counters.total_written();
			self.ndx_start = flists.next_ndx_start(true);
			self.enc.start_list(self.ndx_start);
			let dir_ndx = if o.need_unsorted_flist { self.dirs[first].wire } else { first as i32 };
			self.ndx.write(&mut w, NDX_FLIST_OFFSET - dir_ndx).map_err(RsyncError::from_stream)?;
			let parent_global = self.dirs[first].ndx;
			let pathname = self.dirs[first].base;

			self.send1extra(&mut w, first)?;
			let mut cur = first;
			let mut prev_flags = self.dirs[cur].flags;
			loop {
				let sib = self.dirs[cur].next_sibling;
				let Some(s) = usize::try_from(sib).ok().filter(|&s| s < self.dirs.len()) else {
					break;
				};
				if self.dirs[s].flags & FLAG_DUPLICATE == 0 {
					break;
				}
				self.send_dir_ndx = s as i32;
				cur = s;
				if self.dirs[s].base == pathname && prev_flags & FLAG_CONTENT_DIR != 0 {
					self.dirs[s].flags &= !FLAG_CONTENT_DIR;
				}
				self.send1extra(&mut w, s)?;
				prev_flags = self.dirs[s].flags;
			}

			let io_error = self.io_error();
			let end_err = if io_error == save_io_error || o.ignore_errors {
				0
			} else if safe_inc_flist(&ctx) {
				io_error
			} else {
				if o.delete_during != 0 {
					return Err(self.fatal_unsafe_io_error());
				}
				0
			};
			self.enc.send_end(&mut w, end_err).map_err(RsyncError::from_stream)?;

			let (mut list, mut aux, order) = self.take_sorted();
			list.parent_ndx = parent_global;
			let bases: Vec<u32> = aux.iter().map(|a| a.base).collect();
			let dirs = self.add_dirs_to_tree(cur as i32, &list, &mut aux);
			let len = list.entries.len();
			self.flush_counts(len, false, ctx.counters.total_written().saturating_sub(start_write));
			self.debug_list(&list, &bases);
			self.seg_bases.push((list.ndx_start, bases));
			flists.push_full(list, dirs, o.need_unsorted_flist.then_some(order));

			// Next directory, depth first.
			let mut dp = cur;
			if self.dirs[dp].first_child >= 0 {
				self.send_dir_ndx = self.dirs[dp].first_child;
				self.send_dir_depth += 1;
			} else {
				loop {
					if self.dirs[dp].next_sibling >= 0 {
						break;
					}
					let parent = self.dirs[dp].parent;
					if parent < 0 {
						self.ndx.write(&mut w, NDX_FLIST_EOF).map_err(RsyncError::from_stream)?;
						self.flist_eof = true;
						flists.set_eof();
						self.debug_eof();
						self.change_filter_dir(None, 0)?;
						return self.finish_extra(out, save_io_error);
					}
					self.send_dir_depth -= 1;
					dp = parent as usize;
				}
				self.send_dir_ndx = self.dirs[dp].next_sibling;
			}
		}
		self.finish_extra(out, save_io_error)
	}

	/// Protocol 30 without the safe-flist marker reports new I/O errors by message.
	fn finish_extra(&mut self, out: &MuxWriter, save_io_error: i32) -> Result<(), RsyncError> {
		let io_error = self.io_error();
		if io_error != save_io_error && self.ctx.proto.version == 30 && !self.ctx.opts.ignore_errors {
			out.send_msg(MSG_IO_ERROR, &io_error.to_le_bytes()).map_err(RsyncError::from_stream)?;
		}
		Ok(())
	}

	/// send1extra: the contents of one directory node (and its deferred `-R` names).
	fn send1extra(&mut self, w: &mut Out, node: usize) -> Result<(), RsyncError> {
		let flags = FLAG_DIVERT_DIRS | FLAG_CONTENT_DIR;
		let name = self.dirs[node].name.clone();
		if name.is_empty() {
			return Ok(());
		}
		let dlen = name.len();
		let base = self.dirs[node].base;
		if (base as usize) >= self.bases.len() {
			return Err(RsyncError::new(RERR_FILESELECT, "change_dir failed").at("flist.c", 2569));
		}
		self.use_base(base);
		let depth = usize::try_from(self.send_dir_depth).unwrap_or(0);
		self.change_filter_dir(Some(&name), depth)?;
		if self.dirs[node].flags & FLAG_CONTENT_DIR != 0 {
			let mut scan = true;
			if self.ctx.opts.one_file_system > 0 {
				match self.link_stat(At::Path, &name, self.ctx.opts.copy_dirlinks, false) {
					Ok(st) => self.filesystem_dev = st.dev,
					Err(err) => {
						self.interpret_stat_error(&name, &err, true);
						scan = false;
					},
				}
			}
			if !scan {
				self.dirs[node].done = true;
				return Ok(());
			}
			self.send_directory(w, &name, flags)?;
		}
		self.dirs[node].done = true;
		if !self.relative {
			return Ok(());
		}
		let relnames = std::mem::take(&mut self.dirs[node].relnames);
		for (name_type, rel) in relnames {
			self.ctx.check_cancel()?;
			let mut fbuf = name.clone();
			fbuf.push(b'/');
			fbuf.extend_from_slice(&rel);
			if fbuf.len() >= MAXPATHLEN {
				continue;
			}
			if let Some(off) = memchr::memchr(b'/', &fbuf[dlen + 1..]) {
				let slash = dlen + 1 + off;
				self.send_implied_dirs(w, &fbuf, dlen + 1, slash, flags, name_type)?;
				continue;
			}
			if name_type != NORMAL_NAME {
				let st = if name_type == MISSING_NAME {
					St::default()
				} else {
					match self.link_stat(At::Path, &fbuf, true, false) {
						Ok(st) => st,
						Err(err) => {
							self.interpret_stat_error(&fbuf, &err, true);
							continue;
						},
					}
				};
				self.send_file_name(w, &fbuf, Some(&st), FLAG_TOP_DIR | flags, ALL_FILTERS, At::Path, false)?;
			} else {
				self.send_file_name(w, &fbuf, None, FLAG_TOP_DIR | flags, ALL_FILTERS, At::Path, false)?;
			}
		}
		Ok(())
	}

	// ----- transfer-time helpers ------------------------------------------------

	/// The base and name of entry `ndx` (None: unknown index). A segment's gap index
	/// (`ndx_start - 1`, how the generator addresses the directory a segment fills) is the
	/// parent directory's entry, as upstream's `dir_flist->files[parent_ndx]`.
	fn entry_ctx(&self, ndx: i32, flists: &Flists) -> Option<(u32, FileEntry)> {
		let ndx = flists.resolve_ndx(ndx)?;
		let e = flists.entry(ndx)?;
		let seg = self.seg_bases.partition_point(|(start, _)| *start <= ndx).checked_sub(1)?;
		let (start, bases) = &self.seg_bases[seg];
		let base = *bases.get(usize::try_from(ndx - start).ok()?)?;
		Some((base, e))
	}

	/// Opens the source file for `ndx` confined to its root (secure_relative_open semantics).
	pub(crate) fn open_file(&self, ndx: i32, flists: &Flists) -> io::Result<(pi_vfs::File, pi_vfs::Metadata)> {
		let Some((base, e)) = self.entry_ctx(ndx, flists) else {
			return Err(io::Error::from_raw_os_error(invalid_errno()));
		};
		let o = &self.ctx.opts;
		let name = e.name();
		let follow = o.copy_links || o.copy_unsafe_links;
		let file = if self.access == Access::Confined {
			let (tree, rel) = self.locate(base, &name)?;
			tree.open_read(&rel, false)?
		} else if o.copy_links || o.copy_unsafe_links {
			self.ctx.fs.open(join_name(&self.bases[base as usize].abs, &name)?)?
		} else {
			let (tree, rel) = self.locate(base, &name)?;
			tree.open_read(&rel, follow)?
		};
		let md = file.metadata()?;
		Ok((file, md))
	}

	/// Upstream `F_PATHNAME` of entry `ndx`: the directory its name is relative to, as the
	/// operand spelled it (None for the starting directory).
	pub(crate) fn pathname(&self, ndx: i32, flists: &Flists) -> Option<Vec<u8>> {
		let (base, _) = self.entry_ctx(ndx, flists)?;
		self.bases.get(base as usize)?.dir.clone()
	}

	/// Upstream full_fname of entry `ndx` as the sender prints it.
	pub(crate) fn full_fname(&self, ndx: i32, flists: &Flists) -> Vec<u8> {
		match self.entry_ctx(ndx, flists) {
			Some((base, e)) => self.full_fname_in(base, &e.name()),
			None => b"\"(null)\"".to_vec(),
		}
	}

	/// The entry's current local xattrs (for answering abbreviated-value requests).
	pub(crate) fn reread_xattrs(&self, ndx: i32, flists: &Flists) -> io::Result<XattrSet> {
		let Some((base, e)) = self.entry_ctx(ndx, flists) else {
			return Err(io::Error::from_raw_os_error(invalid_errno()));
		};
		let (tree, rel) = self.locate(base, &e.name())?;
		let excl = |n: &[u8]| self.filters.xattr_excluded(n);
		let xctx = XattrCtx {
			filter: if self.filters.has_xattr_rules() { Some(&excl) } else { None },
			logger: Some(&self.ctx.logger),
			..XattrCtx::default()
		};
		xattr::read_local_with(&tree, &rel, Some(e.mode), false, self.ctx.xattr_opts, xctx)
	}

	/// --remove-source-files after MSG_SUCCESS, with upstream's same-file safety re-stat;
	/// `dest_id` is the destination's (dev, ino) a local receiver sent in MSG_SUCCESS (the
	/// sender never removes the file it just wrote).
	pub(crate) fn remove_source_checked(
		&mut self,
		ndx: i32,
		flists: &Flists,
		dest_id: Option<(u64, u64)>,
	) -> Result<(), RsyncError> {
		if self.ctx.opts.remove_source_files == 0 {
			return Ok(());
		}
		let Some((base, e)) = self.entry_ctx(ndx, flists) else {
			let last = flists.last_ndx();
			let who = self.logger().role().name();
			let text = format!("File-list index {ndx} not in 0 - {last} (successful_send) [{who}]");
			self.logger().rprintf(LogCode::Error, format!("{text}\n").as_bytes());
			return Err(RsyncError::new(RERR_PROTOCOL, text).at("sender.c", 411));
		};
		let fname = e.name();
		let logger = self.logger().clone();
		let fail = |op: &str, err: &io::Error| {
			if err.kind() == io::ErrorKind::NotFound {
				logger.rprintf(LogCode::Info, &[&b"sender file already removed: "[..], &fname, b"\n"].concat());
			} else {
				logger.rsyserr(LogCode::ErrorXfer, err, &[format!("sender failed to {op} ").as_bytes(), &fname].concat());
			}
		};
		let (tree, rel) = match self.locate(base, &fname) {
			Ok(v) => v,
			Err(err) => {
				fail("secure-open-parent", &err);
				return Ok(());
			},
		};
		let md = if self.ctx.opts.copy_links { tree.stat(&rel) } else { tree.lstat(&rel) };
		let md = match md {
			Ok(m) => m,
			Err(err) => {
				fail("re-lstat", &err);
				return Ok(());
			},
		};
		let st = St::of(&md);
		if self.ctx.local_server
			&& let Some((dev, ino)) = dest_id
			&& st.dev == dev
			&& st.ino == ino
		{
			logger.rprintf(
				LogCode::ErrorXfer,
				&[&b"ERROR: Skipping sender remove of destination file: "[..], &fname, b"\n"].concat(),
			);
			return Ok(());
		}
		let nsec_differs = e.flags & FLAG_MOD_NSEC != 0 && st.nsec != e.mtime_nsec;
		if st.size != e.size || st.mtime != e.mtime || nsec_differs {
			logger.rprintf(
				LogCode::ErrorXfer,
				&[&b"ERROR: Skipping sender remove for changed file: "[..], &fname, b"\n"].concat(),
			);
			return Ok(());
		}
		match tree.unlink(&rel) {
			Err(err) => fail("remove", &err),
			Ok(()) => {
				if logger.levels().info(Info::Remove) >= 1 {
					logger.rprintf(LogCode::Info, &[&b"sender removed "[..], &fname, b"\n"].concat());
				}
			},
		}
		Ok(())
	}
}

/// Index of the first active entry.
fn first_active(list: &FileList) -> i32 {
	list.entries.iter().position(FileEntry::is_active).unwrap_or(0) as i32
}

fn overflow() -> RsyncError {
	RsyncError::new(RERR_PROTOCOL, "ERROR: buffer overflow in send_file_list").at("util1.c", 1)
}

fn invalid_errno() -> i32 {
	#[cfg(unix)]
	return libc::EINVAL;
	#[cfg(not(unix))]
	return 22;
}

/// Upstream read_line for files-from: one name per line (`\n` or `\r`, or NUL with
/// `eol_nulls`); with `dump_comments` (a local file) empty lines and lines starting with
/// `#` or `;` are skipped. An empty result means the end of the list.
fn read_line(r: &mut dyn Read, eol_nulls: bool, dump_comments: bool, ctx: &Ctx) -> Result<Vec<u8>, RsyncError> {
	loop {
		let mut line = Vec::new();
		loop {
			let mut b = [0u8; 1];
			let n = loop {
				match r.read(&mut b) {
					Ok(n) => break n,
					Err(e) if e.kind() == io::ErrorKind::Interrupted => {
						ctx.check_cancel()?;
					},
					Err(e) => return Err(RsyncError::from_stream(e)),
				}
			};
			if n == 0 {
				break;
			}
			let eol = if eol_nulls { b[0] == 0 } else { b[0] == b'\r' || b[0] == b'\n' };
			if eol {
				if dump_comments && line.is_empty() {
					continue;
				}
				break;
			}
			if line.len() < MAXPATHLEN - 1 {
				line.push(b[0]);
			}
		}
		if dump_comments && matches!(line.first(), Some(b'#' | b';')) {
			continue;
		}
		return Ok(line);
	}
}
