//! The sending side's transfer loop (upstream send_files): answers the generator's
//! per-file requests with the file's delta.
//!
//! Per request the generator sends `ndx`, the item flags (`shortint`), the basis
//! type byte and an extra name when flagged, the xattr value request when
//! abbreviated xattrs differ, then — for `ITEM_TRANSFER` — the sum header and the
//! block sums. The sender echoes `ndx`/flags/basis/xname (plus any requested xattr
//! values) to the receiver, then the sum header, the token stream, and the
//! whole-file checksum (`xfer_sum_len` bytes of the negotiated transfer checksum).
//! Under `--only-write-batch` the sum header, tokens, and checksum go only to the
//! batch file (upstream `f_xfer`).
//!
//! Phases: each `NDX_DONE` from the generator ends a phase and is echoed; the third
//! (protocol 29+: transfer, redo, delay-updates) ends the loop, after which a final
//! `NDX_DONE` follows (and `MSG_IO_ERROR` first if new I/O errors happened, protocol
//! 30+). With incremental recursion an `NDX_DONE` first retires the oldest file-list
//! segment and is echoed without advancing the phase while segments remain. A
//! request for a file already sent (`FLAG_FILE_SENT`) is the redo pass: full-length
//! strong sums arrive and `--append` is suspended for it.
//!
//! Peer messages relevant to the sender (MSG_SUCCESS for `--remove-source-files`,
//! MSG_NO_SEND to forward) arrive on the `peer` channel as raw payloads. The mux
//! pump queues them before it decodes any data that follows them, so draining the
//! channel right after each request is read applies them in stream order, as
//! upstream's inline handling does (before an `NDX_DONE` frees their segment).
//!
//! Incremental recursion: segments go out (MIN_FILECNT_LOOKAHEAD) before each read
//! and after each request, and — like io.c's zero-timeout poll while a request is
//! awaited — one more segment at a time whenever no input is pending, up to
//! MAX_FILECNT_LOOKAHEAD queued files. Without the latter a generator that has
//! nothing to request in the queued segments would wait forever for the next one.

use std::io::{self, Read, Seek, SeekFrom, Write};
use std::sync::atomic::Ordering;
use std::sync::Mutex;

use crate::rsync::flists::lock;
use crate::rsync::checksum::{FileDigest, Strong};
use crate::rsync::consts::{
	CF_AVOID_XATTR_OPTIM, CF_INPLACE_PARTIAL_DIR, FLAG_FILE_SENT, FLAG_SKIP_GROUP, FNAMECMP_FNAME,
	MAX_WIRE_DEL_STAT,
	FNAMECMP_FUZZY, FNAMECMP_PARTIAL_DIR, IOERR_GENERAL, IOERR_VANISHED, ITEM_BASIS_TYPE_FOLLOWS,
	ITEM_IS_NEW, ITEM_LOCAL_CHANGE, ITEM_REPORT_XATTR, ITEM_TRANSFER, ITEM_XNAME_FOLLOWS, MAXPATHLEN,
	MIN_FILECNT_LOOKAHEAD, MSG_IO_ERROR, MSG_NO_SEND, MSG_SUCCESS, MSK_ALLOW_FLUSH, NDX_DEL_STATS, NDX_DONE, mode_is_device,
	mode_is_dir, mode_is_lnk, mode_is_reg,
};
use crate::rsync::exit::{self, RsyncError};
use crate::rsync::flist::FileEntry;
use crate::rsync::flists::Flists;
use crate::rsync::log::{Debug as DebugFlag, Info, LogCode, LogItem, big_num};
use crate::rsync::matcher::{self, MatchStats, Sums};
use crate::rsync::mux::{IdleWork, Msg, MuxReader, MuxWriter};
use crate::rsync::paths;
use crate::rsync::scan::Scanner;
use crate::rsync::session::Ctx;
use crate::rsync::token::{SkipCompress, TokenEncoder};
use crate::rsync::wire::{NdxCodec, ReadExt, WriteExt};
use crate::rsync::xattr::{self, XattrSender, XattrSet};

/// Most files queued ahead of the generator by the idle lookahead (rsync.h).
const MAX_FILECNT_LOOKAHEAD: usize = 10000;

/// The generator's request stream: data plus a non-blocking readiness probe.
pub(crate) trait Input: Read {
	/// Whether a read would return without waiting for the peer (data, EOF, or error).
	fn data_ready(&mut self) -> io::Result<bool>;

	/// A read that, instead of waiting for the peer, runs `idle` (one unit of
	/// side work) for as long as it asks to be called again (see
	/// [`MuxReader::read_idle`]).
	fn read_idle(&mut self, buf: &mut [u8], idle: IdleWork<'_>) -> io::Result<usize> {
		while !self.data_ready()? && idle()? {}
		self.read(buf)
	}
}

impl Input for MuxReader {
	fn data_ready(&mut self) -> io::Result<bool> {
		MuxReader::data_ready(self)
	}

	fn read_idle(&mut self, buf: &mut [u8], idle: IdleWork<'_>) -> io::Result<usize> {
		MuxReader::read_idle(self, buf, idle)
	}
}

/// The request stream as read inside upstream's read_ndx_and_attrs: while
/// `extra_flist_sending_enabled` holds, every wait for the generator sends one
/// more inc-recursion file-list segment instead (io.c's zero-timeout poll),
/// until the list is complete or MAX_FILECNT_LOOKAHEAD files are queued.
struct Feed<'a> {
	input: &'a mut dyn Input,
	src: &'a mut dyn Source,
	out: &'a MuxWriter,
	flists: &'a Flists,
	/// Upstream file_old_total.
	old_total: usize,
	/// Upstream extra_flist_sending_enabled.
	enabled: bool,
}

impl Read for Feed<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if !self.enabled {
			return self.input.read(buf);
		}
		let Self { input, src, out, flists, old_total, enabled } = self;
		let (out, flists, old_total) = (*out, *flists, *old_total);
		let mut send_one = || -> io::Result<bool> {
			if flists.is_eof() || flists.file_total().saturating_sub(old_total) >= MAX_FILECNT_LOOKAHEAD {
				*enabled = false;
				return Ok(false);
			}
			src.set_old_total(old_total);
			// The list's own writes wait normally (upstream clears the flag
			// around send_extra_file_list).
			src.send_extra_at_least(out, flists, -1).map_err(io::Error::other)?;
			*enabled = !flists.is_eof();
			Ok(*enabled)
		};
		input.read_idle(buf, &mut send_one)
	}
}

/// What the transfer loop needs from the file-list side of the sender. [`Scanner`]
/// is the implementation; tests substitute their own.
pub(crate) trait Source {
	/// send_extra_file_list(`at_least`; negative = one more than already queued).
	fn send_extra_at_least(&mut self, out: &MuxWriter, flists: &Flists, at_least: i32) -> Result<(), RsyncError>;
	/// Upstream `file_old_total` (files in live segments up to the current one).
	fn set_old_total(&mut self, n: usize);
	/// The write-direction ndx codec of this connection.
	fn ndx_codec(&mut self) -> &mut NdxCodec;
	/// Opens the source of `ndx` (confined to its root).
	fn open_file(&self, ndx: i32, flists: &Flists) -> io::Result<(pi_vfs::File, pi_vfs::Metadata)>;
	/// --remove-source-files after MSG_SUCCESS.
	fn remove_source(&mut self, ndx: i32, flists: &Flists, dest: Option<(u64, u64)>) -> Result<(), RsyncError>;
	/// The xattr cache the file list was sent with.
	fn xattrs(&mut self) -> &mut XattrSender;
	/// upstream full_fname of the entry, as diagnostics quote it.
	fn full_fname(&self, ndx: i32, flists: &Flists) -> Vec<u8>;
	/// The entry's current local xattrs (for abbreviated-value requests).
	fn reread_xattrs(&self, ndx: i32, flists: &Flists) -> io::Result<XattrSet>;
	/// F_PATHNAME: the directory prefix `%f` shows on the sending side.
	fn pathname(&self, ndx: i32, flists: &Flists) -> Option<Vec<u8>>;
}

impl Source for Scanner {
	fn send_extra_at_least(&mut self, out: &MuxWriter, flists: &Flists, at_least: i32) -> Result<(), RsyncError> {
		Scanner::send_extra_at_least(self, out, flists, at_least)
	}

	fn set_old_total(&mut self, n: usize) {
		Scanner::set_old_total(self, n);
	}

	fn ndx_codec(&mut self) -> &mut NdxCodec {
		Scanner::ndx_codec(self)
	}

	fn open_file(&self, ndx: i32, flists: &Flists) -> io::Result<(pi_vfs::File, pi_vfs::Metadata)> {
		Scanner::open_file(self, ndx, flists)
	}

	fn remove_source(&mut self, ndx: i32, flists: &Flists, dest: Option<(u64, u64)>) -> Result<(), RsyncError> {
		Scanner::remove_source_checked(self, ndx, flists, dest)
	}

	fn xattrs(&mut self) -> &mut XattrSender {
		Scanner::xattrs(self)
	}

	fn full_fname(&self, ndx: i32, flists: &Flists) -> Vec<u8> {
		Scanner::full_fname(self, ndx, flists)
	}

	fn reread_xattrs(&self, ndx: i32, flists: &Flists) -> io::Result<XattrSet> {
		Scanner::reread_xattrs(self, ndx, flists)
	}

	fn pathname(&self, ndx: i32, flists: &Flists) -> Option<Vec<u8>> {
		Scanner::pathname(self, ndx, flists)
	}
}

/// send_files: runs until the generator's last phase ends and the final `NDX_DONE`
/// has been written (stats and goodbye are the session's).
pub(crate) fn run(
	ctx: &Ctx,
	scanner: &mut Scanner,
	flists: &Flists,
	input: &mut MuxReader,
	out: &MuxWriter,
	peer: &flume::Receiver<Msg>,
) -> Result<(), RsyncError> {
	run_with(ctx, scanner, flists, input, out, peer)
}

/// [`run`] over any [`Source`] and request stream.
pub(crate) fn run_with(
	ctx: &Ctx,
	src: &mut dyn Source,
	flists: &Flists,
	input: &mut dyn Input,
	out: &MuxWriter,
	peer: &flume::Receiver<Msg>,
) -> Result<(), RsyncError> {
	let opts = &*ctx.opts;
	let mut enc = TokenEncoder::new(ctx.compress, ctx.compress_level);
	enc.set_protocol(ctx.proto.version);
	if opts.do_compression_threads > 0 {
		enc.set_threads(opts.do_compression_threads as u32);
	}
	let skip = opts.skip_compress.as_ref().map(|s| s.to_string_lossy().into_owned());
	let mut sender = Sender {
		ctx,
		flists,
		out: out.clone(),
		codec_in: NdxCodec::new(ctx.proto),
		enc,
		skip: SkipCompress::new(skip.as_deref()),
		strong: Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto },
		xfer_sum_len: ctx.xfer_sum.digest_len(),
		first_live: 0,
		cur_seg: None,
		old_total: 0,
		last_sum: vec![0; ctx.xfer_sum.digest_len()],
		totals: MatchStats::default(),
		debug_send: ctx.logger.levels().debug(DebugFlag::Send),
		debug_delta: ctx.logger.levels().debug(DebugFlag::Deltasum),
		progress_level: ctx.logger.levels().info(Info::Progress),
	};
	sender.codec_in.set_role(ctx.logger.role());
	sender.send_files(src, input, peer)
}

/// One request from the generator.
struct Request {
	/// Index into the flists (sorted order).
	ndx: i32,
	/// The index as it travels on the wire.
	wire: i32,
	seg: usize,
	iflags: u32,
	fnamecmp_type: u8,
	xname: Option<Vec<u8>>,
}

struct Sender<'a> {
	ctx: &'a Ctx,
	flists: &'a Flists,
	out: MuxWriter,
	codec_in: NdxCodec,
	enc: TokenEncoder,
	skip: SkipCompress,
	strong: Strong,
	xfer_sum_len: usize,
	/// First segment not yet retired by an NDX_DONE (upstream first_flist).
	first_live: usize,
	/// Segment of the last request (upstream cur_flist).
	cur_seg: Option<usize>,
	/// Upstream file_old_total.
	old_total: usize,
	/// Upstream sender_file_sum (shown by `%C`; stale for items not sent).
	last_sum: Vec<u8>,
	totals: MatchStats,
	debug_send: u8,
	debug_delta: u8,
	progress_level: u8,
}

/// Bytes written through it (upstream total_data_written deltas, for `%b`).
struct Counting<W> {
	inner: W,
	n: u64,
}

impl<W: Write> Write for Counting<W> {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		let n = self.inner.write(buf)?;
		self.n += n as u64;
		Ok(n)
	}

	fn flush(&mut self) -> io::Result<()> {
		self.inner.flush()
	}
}

/// Bytes read through it (for `%c`).
struct CountingRead<'r> {
	inner: &'r mut dyn Read,
	n: u64,
}

impl Read for CountingRead<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = self.inner.read(buf)?;
		self.n += n as u64;
		Ok(n)
	}
}

/// Where the delta goes: the connection, or only the batch file.
struct Xfer<'w, W: Write> {
	out: &'w mut Counting<W>,
	batch: Option<&'w Mutex<Box<dyn Write + Send>>>,
}

impl<W: Write> Write for Xfer<'_, W> {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self.batch {
			Some(batch) => {
				lock(&batch).write_all(buf)?;
				Ok(buf.len())
			},
			None => self.out.write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self.batch {
			Some(batch) => lock(&batch).flush(),
			None => self.out.flush(),
		}
	}
}

impl Sender<'_> {
	fn info(&self, text: String) {
		self.ctx.logger.rprintf(LogCode::Info, text.as_bytes());
	}

	fn who(&self) -> &'static str {
		self.ctx.logger.role().name()
	}

	fn stats(&self) -> std::sync::MutexGuard<'_, crate::rsync::log::Stats> {
		lock(&self.ctx.stats)
	}

	fn io_error_or(&self, bits: i32) {
		self.ctx.io_error.fetch_or(bits, Ordering::Relaxed);
	}

	fn send_files(
		&mut self,
		src: &mut dyn Source,
		input: &mut dyn Input,
		peer: &flume::Receiver<Msg>,
	) -> Result<(), RsyncError> {
		let ctx = self.ctx;
		let opts = &*ctx.opts;
		let mut phase = 0;
		let max_phase = 2;
		let itemizing = if ctx.am_server { opts.logfile_format_has_i } else { opts.stdout_format_has_i != 0 };
		let log_code = if opts.log_before_transfer { LogCode::Log } else { LogCode::Info };
		let save_io_error = ctx.io_error.load(Ordering::Relaxed);
		if self.debug_send >= 1 {
			ctx.logger.rprintf(LogCode::Info, b"send_files starting\n");
		}

		loop {
			ctx.check_cancel()?;
			self.drain_peer(src, peer)?;
			if ctx.inc_recurse {
				src.set_old_total(self.old_total);
				src.send_extra_at_least(&self.out, self.flists, MIN_FILECNT_LOOKAHEAD)?;
			}
			let req = self.read_request(src, input)?;
			// Upstream handles MSG_SUCCESS / MSG_NO_SEND inline while reading, so every
			// message the peer sent before this ndx is applied before acting on it — in
			// particular before an NDX_DONE retires the segment the messages name.
			self.drain_peer(src, peer)?;
			let Some(req) = req else {
				// NDX_DONE.
				if !ctx.am_server
					&& let Some(cur) = self.cur_seg
					&& self.progress_level >= 2
				{
					let start = self.flists.segment_start(cur).unwrap_or(0);
					let used = self.flists.segment_len(cur).unwrap_or(0) as i32;
					let index = used + start - 1 - self.flist_num(cur);
					self.end_progress(0, index);
				}
				if ctx.inc_recurse && self.first_live < self.flists.len() {
					let first = self.first_live;
					self.old_total =
						self.old_total.saturating_sub(self.flists.segment_len(first).unwrap_or(0));
					self.flists.release(first);
					self.first_live += 1;
					if self.first_live < self.flists.len() {
						if Some(self.first_live) == self.cur_seg {
							self.old_total = self.flists.segment_len(self.first_live).unwrap_or(0);
						}
						self.write_ndx(src, NDX_DONE)?;
						continue;
					}
				}
				phase += 1;
				if phase > max_phase {
					break;
				}
				if self.debug_send >= 1 {
					self.info(format!("send_files phase={phase}\n"));
				}
				self.write_ndx(src, NDX_DONE)?;
				continue;
			};

			if ctx.inc_recurse {
				src.set_old_total(self.old_total);
				src.send_extra_at_least(&self.out, self.flists, MIN_FILECNT_LOOKAHEAD)?;
			}
			self.handle(src, input, &req, phase, itemizing, log_code)?;
		}

		self.drain_peer(src, peer)?;
		let io_error = ctx.io_error.load(Ordering::Relaxed);
		if io_error != save_io_error && ctx.proto.version >= 30 {
			self.out.send_msg(MSG_IO_ERROR, &io_error.to_le_bytes()).map_err(RsyncError::from_stream)?;
		}
		if self.debug_send >= 1 {
			ctx.logger.rprintf(LogCode::Info, b"send files finished\n");
		}
		if self.debug_delta >= 1 {
			let literal = self.stats().literal_data;
			self.info(format!(
				"total: matches={}  hash_hits={}  false_alarms={} data={}\n",
				self.totals.matches,
				self.totals.hash_hits,
				self.totals.false_alarms,
				big_num(literal, 0)
			));
		}
		self.write_ndx(src, NDX_DONE)
	}

	fn write_ndx(&mut self, src: &mut dyn Source, ndx: i32) -> Result<(), RsyncError> {
		src.ndx_codec().write(&mut self.out, ndx).map_err(RsyncError::from_stream)
	}

	/// Upstream flist_num of a segment (inc-recursion lists start at 1).
	fn flist_num(&self, seg: usize) -> i32 {
		seg as i32 + i32::from(self.ctx.inc_recurse)
	}

	/// Live segment whose range (including its leading parent-dir gap) holds `ndx`.
	fn segment_for(&self, ndx: i32) -> Option<usize> {
		(self.first_live..self.flists.len()).find(|&seg| {
			let (Some(start), Some(len)) = (self.flists.segment_start(seg), self.flists.segment_len(seg))
			else {
				return false;
			};
			ndx >= start - 1 && ndx < start + len as i32
		})
	}

	/// "File-list index N not in A - B (loc) [role]".
	fn not_in_list(&self, ndx: i32, loc: &str) -> RsyncError {
		let (first, last) = self.range();
		RsyncError::new(
			exit::RERR_PROTOCOL,
			format!("File-list index {ndx} not in {first} - {last} ({loc}) [{}]", self.who()),
		)
		.at("rsync.c", 982)
	}

	fn range(&self) -> (i32, i32) {
		let count = self.flists.len();
		if self.first_live >= count {
			return (0, -1);
		}
		let first = self.flists.segment_start(self.first_live).unwrap_or(0) - 1;
		let last_seg = count - 1;
		let last = self.flists.segment_start(last_seg).unwrap_or(0)
			+ self.flists.segment_len(last_seg).unwrap_or(0) as i32
			- 1;
		(first, last)
	}

	/// read_ndx_and_attrs for the sender: None at NDX_DONE. Its waits send extra
	/// file-list segments (see [`Feed`]).
	fn read_request(&mut self, src: &mut dyn Source, input: &mut dyn Input) -> Result<Option<Request>, RsyncError> {
		let ctx = self.ctx;
		let out = self.out.clone();
		let mut input = Feed {
			input,
			src,
			out: &out,
			flists: self.flists,
			old_total: self.old_total,
			enabled: ctx.inc_recurse && !self.flists.is_eof(),
		};
		loop {
			let wire = self.codec_in.read(&mut input).map_err(RsyncError::from_stream)?;
			if wire == NDX_DONE {
				return Ok(None);
			}
			if wire == NDX_DEL_STATS {
				self.read_del_stats(&mut input)?;
				if ctx.am_sender && ctx.am_server {
					self.write_del_stats(&mut *input.src)?;
				}
				continue;
			}
			if wire < 0 {
				let last = if self.first_live < self.flists.len() { self.range().1 } else { -1 };
				return Err(RsyncError::new(
					exit::RERR_PROTOCOL,
					format!("Invalid file index: {wire} ({NDX_DONE} - {last}) [{}]", self.who()),
				)
				.at("rsync.c", 353));
			}
			let iflags = u32::from(input.read_shortint().map_err(RsyncError::from_stream)?);

			// Protocol-29 keep-alive: an IS_NEW "request" one past the list.
			if ctx.proto.version < 30 && iflags == ITEM_IS_NEW {
				let used = self.flists.segment_len(self.cur_seg.unwrap_or(0)).unwrap_or(0);
				if wire == used as i32 {
					self.out.maybe_keepalive(MSK_ALLOW_FLUSH).map_err(RsyncError::from_stream)?;
					continue;
				}
			}

			let ndx = self.flists.from_wire(wire);
			let seg = self.segment_for(ndx).ok_or_else(|| self.not_in_list(ndx, "read_ndx_and_attrs"))?;
			if self.cur_seg != Some(seg) {
				self.cur_seg = Some(seg);
				self.old_total =
					(self.first_live..=seg).map(|s| self.flists.segment_len(s).unwrap_or(0)).sum();
				input.old_total = self.old_total;
			}

			let fnamecmp_type =
				if iflags & ITEM_BASIS_TYPE_FOLLOWS != 0 { input.read_u8().map_err(RsyncError::from_stream)? } else { FNAMECMP_FNAME };
			let xname = if iflags & ITEM_XNAME_FOLLOWS != 0 {
				let name = input
					.read_vstring(MAXPATHLEN, exit::RERR_PROTOCOL, ("rsync.c", 410))
					.map_err(RsyncError::from_stream)?;
				Some(if fnamecmp_type >= FNAMECMP_FUZZY { paths::sanitize_path(&name, Some(&b""[..]), 0) } else { name })
			} else {
				None
			};

			if iflags & ITEM_TRANSFER != 0 {
				let start = self.flists.segment_start(seg).unwrap_or(0);
				let regular = ndx >= start && self.flists.entry(ndx).is_some_and(|e| mode_is_reg(e.mode));
				if !regular {
					return Err(RsyncError::new(
						exit::RERR_PROTOCOL,
						format!("received request to transfer non-regular file: {ndx} [{}]", self.who()),
					)
					.at("rsync.c", 442));
				}
			}
			return Ok(Some(Request { ndx, wire, seg, iflags, fnamecmp_type, xname }));
		}
	}

	fn read_del_stats(&mut self, input: &mut dyn Read) -> Result<(), RsyncError> {
		let role = self.ctx.logger.role();
		let mut next = |what: &str| xattr::read_varint_bounded(input, 0, MAX_WIRE_DEL_STAT, what, role);
		let files = next("deleted_files")?;
		let dirs = next("deleted_dirs")?;
		let symlinks = next("deleted_symlinks")?;
		let devices = next("deleted_devices")?;
		let specials = next("deleted_specials")?;
		let mut stats = self.stats();
		stats.deleted_dirs = dirs;
		stats.deleted_symlinks = symlinks;
		stats.deleted_devices = devices;
		stats.deleted_specials = specials;
		stats.deleted_files = files + dirs + symlinks + devices + specials;
		Ok(())
	}

	fn write_del_stats(&mut self, src: &mut dyn Source) -> Result<(), RsyncError> {
		self.write_ndx(src, NDX_DEL_STATS)?;
		let (files, dirs, symlinks, devices, specials) = {
			let s = self.stats();
			(
				s.deleted_files - s.deleted_dirs - s.deleted_symlinks - s.deleted_devices - s.deleted_specials,
				s.deleted_dirs,
				s.deleted_symlinks,
				s.deleted_devices,
				s.deleted_specials,
			)
		};
		for v in [files, dirs, symlinks, devices, specials] {
			self.out.write_varint(v).map_err(RsyncError::from_stream)?;
		}
		Ok(())
	}

	/// MSG_SUCCESS (remove-source-files) and MSG_NO_SEND (forwarded) from the peer.
	fn drain_peer(&mut self, src: &mut dyn Source, peer: &flume::Receiver<Msg>) -> Result<(), RsyncError> {
		while let Ok(msg) = peer.try_recv() {
			match msg.code {
				MSG_SUCCESS => self.successful_send(src, &msg.payload)?,
				MSG_NO_SEND => {
					self.check_len(&msg, 4)?;
					self.out.send_msg(MSG_NO_SEND, &msg.payload).map_err(RsyncError::from_stream)?;
				},
				_ => {},
			}
		}
		Ok(())
	}

	fn check_len(&self, msg: &Msg, want: usize) -> Result<(), RsyncError> {
		if msg.payload.len() != want {
			return Err(RsyncError::new(
				exit::RERR_STREAMIO,
				format!(
					"invalid multi-message {}:{} [{}{}]",
					msg.code,
					msg.payload.len(),
					self.who(),
					if self.ctx.inc_recurse { "/inc" } else { "" }
				),
			)
			.at("io.c", 1837));
		}
		Ok(())
	}

	fn successful_send(&mut self, src: &mut dyn Source, payload: &[u8]) -> Result<(), RsyncError> {
		let want = if self.ctx.local_server { 4 + 8 + 8 } else { 4 };
		self.check_len(&Msg { code: MSG_SUCCESS, payload: payload.to_vec() }, want)?;
		if self.ctx.opts.remove_source_files == 0 {
			return Ok(());
		}
		let word = |at: usize| u64::from_le_bytes(*payload[at..].first_chunk().expect("length checked"));
		let wire = i32::from_le_bytes(*payload.first_chunk().expect("length checked"));
		let dest = self.ctx.local_server.then(|| (word(4), word(12)));
		let ndx = self.flists.from_wire(wire);
		let seg = self.segment_for(ndx).ok_or_else(|| self.not_in_list(ndx, "successful_send"))?;
		if ndx < self.flists.segment_start(seg).unwrap_or(0) {
			return Err(RsyncError::bare(exit::RERR_PROTOCOL).at("sender.c", 411));
		}
		src.remove_source(ndx, self.flists, dest)
	}

	/// The entry a request names and the index it lives at: a segment's leading gap
	/// index (`ndx_start - 1`) stands for the segment's parent directory
	/// (`dir_flist->files[cur_flist->parent_ndx]`), whose own index is what its
	/// `F_PATHNAME` and xattrs are looked up by.
	fn entry_for(&self, req: &Request) -> Result<(i32, FileEntry), RsyncError> {
		let start = self.flists.segment_start(req.seg).unwrap_or(0);
		let at = if req.ndx >= start {
			req.ndx
		} else {
			self.flists.segment_parent(req.seg).unwrap_or(-1)
		};
		let entry = if at < 0 { None } else { self.flists.entry(at) };
		let entry = entry.ok_or_else(|| RsyncError::bare(exit::RERR_PROTOCOL).at("sender.c", 556))?;
		if !entry.is_active() {
			return Err(RsyncError::new(
				exit::RERR_PROTOCOL,
				format!("rsync: refusing transfer of cleared file index {}", req.ndx),
			)
			.at("sender.c", 563));
		}
		Ok((at, entry))
	}

	fn handle(
		&mut self,
		src: &mut dyn Source,
		input: &mut dyn Read,
		req: &Request,
		phase: i32,
		itemizing: bool,
		log_code: LogCode,
	) -> Result<(), RsyncError> {
		let ctx = self.ctx;
		let opts = &*ctx.opts;
		let (entry_ndx, entry) = self.entry_for(req)?;
		let fname = entry.name();
		let dir_prefix = src.pathname(entry_ndx, self.flists);
		if self.debug_send >= 1 {
			// "%s%s%s": F_PATHNAME, then "/" whenever the entry has one.
			let (path, slash) = match dir_prefix.as_deref() {
				Some(path) => (String::from_utf8_lossy(path), "/"),
				None => (String::from_utf8_lossy(b""), ""),
			};
			self.info(format!("send_files({}, {path}{slash}{})\n", req.ndx, String::from_utf8_lossy(&fname)));
		}

		// The generator's request for abbreviated xattr values comes first.
		let want_xattr_optim = ctx.proto.version >= 31 && !ctx.proto.has(CF_AVOID_XATTR_OPTIM);
		let mut xattr_values = Vec::new();
		if opts.preserve_xattrs != 0
			&& req.iflags & ITEM_REPORT_XATTR != 0
			&& opts.do_xfers
			&& !(want_xattr_optim
				&& req.iflags & (ITEM_XNAME_FOLLOWS | ITEM_LOCAL_CHANGE)
					== ITEM_XNAME_FOLLOWS | ITEM_LOCAL_CHANGE)
		{
			let set = src.reread_xattrs(entry_ndx, self.flists).unwrap_or_default();
			let logger = ctx.logger.clone();
			src.xattrs().answer_request_at(input, &mut xattr_values, entry.xattr, &set, &fname, Some(&logger))?;
		}

		let mut out = Counting { inner: self.out.clone(), n: 0 };

		if req.iflags & ITEM_TRANSFER == 0 {
			let item = self.log_item(&entry, &fname, req, req.xname.as_deref(), dir_prefix.as_deref(), 0, 0);
			ctx.logger.maybe_log_item(&item, itemizing);
			self.write_ndx_and_attrs(src, &mut out, req, &xattr_values)?;
			if req.iflags & ITEM_IS_NEW != 0 {
				let mut stats = self.stats();
				stats.created_files += 1;
				if mode_is_reg(entry.mode) {
				} else if mode_is_dir(entry.mode) {
					stats.created_dirs += 1;
				} else if mode_is_lnk(entry.mode) {
					stats.created_symlinks += 1;
				} else if mode_is_device(entry.mode) {
					stats.created_devices += 1;
				} else {
					stats.created_specials += 1;
				}
			}
			return Ok(());
		}
		if phase == 2 {
			return Err(RsyncError::new(
				exit::RERR_PROTOCOL,
				format!("got transfer request in phase 2 [{}]", self.who()),
			)
			.at("sender.c", 608));
		}

		// Redo pass for a file already sent: full sums, no append.
		let redo = entry.flags & FLAG_FILE_SENT != 0;
		let append_mode = if redo { 0 } else { opts.append_mode };
		if !redo && req.iflags & ITEM_IS_NEW != 0 {
			self.stats().created_files += 1;
		}
		let inplace_partial = ctx.proto.version >= 30 && ctx.proto.has(CF_INPLACE_PARTIAL_DIR);
		let updating_basis = (inplace_partial && req.fnamecmp_type == FNAMECMP_PARTIAL_DIR)
			|| (opts.inplace && req.fnamecmp_type == FNAMECMP_FNAME);

		let index = req.ndx - self.flist_num(req.seg);
		{
			let mut stats = self.stats();
			stats.xferred_files += 1;
			stats.total_transferred_size += entry.size as i64;
		}

		if !opts.do_xfers {
			let item = self.log_item(&entry, &fname, req, None, dir_prefix.as_deref(), 0, 0);
			ctx.logger.log_item(LogCode::Client, &item);
			return self.write_ndx_and_attrs(src, &mut out, req, &xattr_values);
		}

		let mut counted = CountingRead { inner: input, n: 0 };
		let lull_mod = if ctx.proto.version >= 31 || opts.io_timeout <= 0 {
			0
		} else {
			((opts.io_timeout as u32).div_ceil(2)) * 5
		};
		let keep_out = self.out.clone();
		let mut keepalive = || keep_out.maybe_keepalive(MSK_ALLOW_FLUSH);
		let mut sums = Sums::read(
			&mut counted,
			ctx.proto,
			self.xfer_sum_len,
			opts.max_alloc,
			append_mode,
			lull_mod,
			&mut keepalive,
			&ctx.logger,
		)?;
		sums.updating_basis = updating_basis;
		let bytes_csum = counted.n;

		let (mut file, meta) = match src.open_file(req.ndx, self.flists) {
			Ok(opened) => opened,
			Err(err) => {
				let full = src.full_fname(req.ndx, self.flists);
				if err.kind() == io::ErrorKind::NotFound {
					self.io_error_or(IOERR_VANISHED);
					let mut text = b"file has vanished: ".to_vec();
					text.extend_from_slice(&full);
					text.push(b'\n');
					ctx.logger.rprintf(LogCode::Warning, &text);
				} else {
					self.io_error_or(IOERR_GENERAL);
					let mut text = b"send_files failed to open ".to_vec();
					text.extend_from_slice(&full);
					ctx.logger.rsyserr(LogCode::ErrorXfer, &err, &text);
				}
				return self.no_send(req);
			},
		};

		let mut size = meta.len();
		if mode_is_device(meta.mode()) {
			if !opts.copy_devices {
				return Err(RsyncError::new(
					exit::RERR_PROTOCOL,
					"attempt to copy device contents without --copy-devices",
				)
				.at("sender.c", 741));
			}
			if size == 0 {
				size = device_size(&mut file);
			}
		}

		if append_mode > 0 && size < entry.size {
			let mut text = b"skipped diminished file: ".to_vec();
			text.extend_from_slice(&src.full_fname(req.ndx, self.flists));
			text.push(b'\n');
			ctx.logger.rprintf(LogCode::Warning, &text);
			return self.no_send(req);
		}

		if self.debug_delta >= 2 {
			self.info(format!(
				"send_files mapped {} of size {}\n",
				String::from_utf8_lossy(&fname),
				big_num(size as i64, 0)
			));
		}

		self.write_ndx_and_attrs(src, &mut out, req, &xattr_values)?;
		let batch = ctx.batch_only.as_deref();
		let mut xfer = Xfer { out: &mut out, batch };
		sums.head.write(&mut xfer, ctx.proto).map_err(RsyncError::from_stream)?;

		if self.debug_delta >= 2 {
			self.info(format!("calling match_sums {}\n", String::from_utf8_lossy(&fname)));
		}
		if opts.log_before_transfer {
			let item = self.log_item(&entry, &fname, req, None, dir_prefix.as_deref(), 0, 0);
			ctx.logger.log_item(LogCode::Client, &item);
		} else if !ctx.am_server
			&& ctx.logger.levels().info(Info::Name) >= 1
			&& self.progress_level == 1
		{
			let mut line = fname.clone();
			line.push(b'\n');
			ctx.logger.rprintf(LogCode::Client, &line);
		}
		self.start_progress(size);

		self.enc.begin_file(!self.skip.skips(&fname));
		let mut digest: FileDigest = self.strong.file();
		let result = if size == 0 {
			matcher::match_file(ctx, &sums, &mut io::empty(), 0, &mut self.enc, &mut xfer, &mut digest)
		} else {
			matcher::match_file(ctx, &sums, &mut file, size, &mut self.enc, &mut xfer, &mut digest)
		};
		let mut mstats = result?;
		let read_error = mstats.read_error.take();
		self.last_sum = matcher::file_sum_trailer(digest, self.xfer_sum_len, read_error.is_some());
		if self.debug_delta >= 2 {
			ctx.logger.rprintf(LogCode::Info, b"sending file_sum\n");
		}
		xfer.write_all(&self.last_sum).map_err(RsyncError::from_stream)?;
		if self.debug_delta >= 2 {
			self.info(format!(
				"false_alarms={} hash_hits={} matches={}\n",
				mstats.false_alarms, mstats.hash_hits, mstats.matches
			));
		}
		{
			let mut stats = self.stats();
			stats.literal_data += mstats.literal as i64;
			stats.matched_data += mstats.matched as i64;
		}
		self.totals.literal += mstats.literal;
		self.totals.matched += mstats.matched;
		self.totals.hash_hits += mstats.hash_hits;
		self.totals.false_alarms += mstats.false_alarms;
		self.totals.matches += mstats.matches;

		if self.progress_level >= 1 {
			self.end_progress(size, index);
		}
		let bytes_xfer = out.n;
		let item = self.log_item(&entry, &fname, req, None, dir_prefix.as_deref(), bytes_xfer, bytes_csum);
		ctx.logger.log_item(log_code, &item);

		if let Some(err) = read_error {
			self.io_error_or(IOERR_GENERAL);
			let mut text = b"read errors mapping ".to_vec();
			text.extend_from_slice(&src.full_fname(req.ndx, self.flists));
			ctx.logger.rsyserr(LogCode::ErrorXfer, &err, &text);
		}
		drop(file);

		if self.debug_send >= 1 {
			self.info(format!("sender finished {}\n", String::from_utf8_lossy(&fname)));
		}
		self.flists.update(req.ndx, |e| e.flags |= FLAG_FILE_SENT);
		Ok(())
	}

	/// MSG_NO_SEND for a request that cannot be served (protocol 30+).
	fn no_send(&mut self, req: &Request) -> Result<(), RsyncError> {
		if self.ctx.proto.version >= 30 {
			self.out.send_msg(MSG_NO_SEND, &req.wire.to_le_bytes()).map_err(RsyncError::from_stream)?;
		}
		Ok(())
	}

	fn write_ndx_and_attrs(
		&mut self,
		src: &mut dyn Source,
		out: &mut Counting<MuxWriter>,
		req: &Request,
		xattr_values: &[u8],
	) -> Result<(), RsyncError> {
		src.ndx_codec().write(out, req.wire).map_err(RsyncError::from_stream)?;
		out.write_shortint(req.iflags as u16).map_err(RsyncError::from_stream)?;
		if req.iflags & ITEM_BASIS_TYPE_FOLLOWS != 0 {
			out.write_u8(req.fnamecmp_type).map_err(RsyncError::from_stream)?;
		}
		if req.iflags & ITEM_XNAME_FOLLOWS != 0 {
			out.write_vstring(req.xname.as_deref().unwrap_or_default()).map_err(RsyncError::from_stream)?;
		}
		out.write_all(xattr_values).map_err(RsyncError::from_stream)
	}

	/// The `--out-format` item for `entry`. Only the non-transfer itemize line
	/// (maybe_log_item) passes the request's extra name as `%L`'s `=> name`; the
	/// transfer-time log_item calls pass none (sender.c), so a fuzzy basis name
	/// never shows on a transfer line.
	#[allow(clippy::too_many_arguments)]
	fn log_item<'e>(
		&'e self,
		entry: &'e FileEntry,
		name: &'e [u8],
		req: &'e Request,
		xname: Option<&'e [u8]>,
		dir_prefix: Option<&'e [u8]>,
		bytes_xfer: u64,
		bytes_csum: u64,
	) -> LogItem<'e> {
		let checksum = if self.ctx.opts.always_checksum { entry.sum.as_deref() } else { Some(&self.last_sum[..]) };
		LogItem {
			name,
			mode: entry.mode,
			size: entry.size,
			mtime: entry.mtime,
			uid: entry.uid,
			gid: entry.gid,
			link: entry.link.as_deref(),
			hlink: xname,
			iflags: req.iflags,
			op: "send",
			bytes_xfer,
			bytes_csum,
			checksum,
			is_dir: entry.is_dir(),
			dir_prefix,
			skip_group: entry.flags & FLAG_SKIP_GROUP != 0,
		}
	}

	fn start_progress(&self, size: u64) {
		if self.ctx.am_server || self.progress_level == 0 {
			return;
		}
		if let Some(progress) = &self.ctx.progress {
			let (transferred, total) = {
				let s = self.stats();
				(s.total_transferred_size.max(0) as u64, s.total_size.max(0) as u64)
			};
			let mut p = lock(&progress);
			p.set_flist_eof(self.flists.is_eof());
			p.set_totals(transferred, total);
			p.start_file(size);
		}
	}

	/// end_progress with upstream's `(xfr#N, to-chk=M/T)` counters.
	fn end_progress(&self, size: u64, current_index: i32) {
		if self.ctx.am_server {
			return;
		}
		if let Some(progress) = &self.ctx.progress {
			let (xferred, num_files, transferred, total) = {
				let s = self.stats();
				(s.xferred_files, s.num_files, s.total_transferred_size.max(0) as u64, s.total_size.max(0) as u64)
			};
			let mut p = lock(&progress);
			p.set_flist_eof(self.flists.is_eof());
			p.set_totals(transferred, total);
			let to_check = (num_files - current_index - 1).max(0);
			p.end_file(size, xferred.max(0) as u32, to_check as u32, num_files.max(0) as u32);
		}
	}
}

/// Size of a device opened for --copy-devices (upstream get_device_size: seek to end).
fn device_size(file: &mut pi_vfs::File) -> u64 {
	let size = file.seek(SeekFrom::End(0)).unwrap_or(0);
	let _ = file.seek(SeekFrom::Start(0));
	size
}

#[cfg(test)]
mod tests;
