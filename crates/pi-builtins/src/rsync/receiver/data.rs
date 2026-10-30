//! File reconstruction I/O for the receiver: the sliding read window over a
//! basis file, the output writer (write buffering, sparse holes, in-place
//! skips, 4 KiB block accounting), and `receive_data` itself.
//!
//! Sparse output (`-S`) defers runs of zero bytes: a leading or trailing zero
//! run of every write, and interior runs of at least [`SPARSE_WRITE_SIZE`]
//! bytes, become holes by moving the file position past them; the file is
//! extended to its final length with `set_len` at the end. Inside data that
//! already exists (in-place updates, preallocated space) a hole is punched
//! instead (Linux `fallocate`, elsewhere zeros are written), as rsync does.

use std::io::{self, Read, Seek, SeekFrom, Write};

use pi_vfs::File;

use super::{Loc, Receiver};
use crate::rsync::{
	flists::lock,
	checksum::{SumHead, Strong},
	consts::CHUNK_SIZE,
	exit::{RERR_FILEIO, RERR_PROTOCOL, RsyncError},
	flist::FileEntry,
	log::{Debug, LogCode, Role, big_num},
	token::Token,
	usage,
};

/// Interior zero runs shorter than this are written, not turned into holes.
pub(super) const SPARSE_WRITE_SIZE: usize = 1024;
/// The non-sparse write buffer (upstream `WRITE_SIZE * 8`).
const WRITE_BUFFER: usize = 32 * 1024 * 8;
/// Basis reads are aligned to this boundary.
const ALIGN: u64 = 1024;
/// Logical block size the protocol-33 statistics count.
const TRACK_BLOCK: u64 = 4096;

const fn aligned_len(len: u64) -> u64 {
	((len.saturating_sub(1)) | (ALIGN - 1)) + 1
}

/// Sliding-window access to a basis file (upstream map_file/map_ptr). Bytes
/// that cannot be read (the file shrank mid-transfer) read as zeros.
pub(super) struct BasisMap<'f> {
	file: &'f File,
	size: u64,
	window: u64,
	buf: Vec<u8>,
	start: u64,
	len: usize,
	/// Where the file position is (None: unknown).
	fd_pos: Option<u64>,
}

impl<'f> BasisMap<'f> {
	/// A map over the first `size` bytes of `file`, reading at least two blocks at a time.
	pub(super) fn new(file: &'f File, size: u64, blength: i32) -> Self {
		let blk = u64::try_from(blength.max(0)).unwrap_or(0);
		let mut read_size = (blk * 2).max(16 * 1024);
		if blk != 0 && !read_size.is_multiple_of(blk) {
			read_size += blk - read_size % blk;
		}
		Self { file, size, window: aligned_len(read_size), buf: Vec::new(), start: 0, len: 0, fd_pos: None }
	}

	/// `len` bytes at `offset`.
	pub(super) fn map(&mut self, offset: u64, len: usize) -> &[u8] {
		if len == 0 {
			return &[];
		}
		let want_end = offset.saturating_add(len as u64);
		if offset >= self.start && want_end <= self.start + self.len as u64 {
			let at = (offset - self.start) as usize;
			return &self.buf[at..at + len];
		}
		let fudge = offset % ALIGN;
		let start = offset - fudge;
		let mut size = self.window;
		if start + size > self.size {
			size = self.size.saturating_sub(start);
		}
		if size < len as u64 + fudge {
			size = aligned_len(len as u64 + fudge);
		}
		let size = size as usize;
		if self.buf.len() < size {
			self.buf.resize(size, 0);
		}
		let mut filled = 0usize;
		if self.fd_pos != Some(start) {
			let mut f = self.file;
			match f.seek(SeekFrom::Start(start)) {
				Ok(_) => self.fd_pos = Some(start),
				Err(_) => {
					self.fd_pos = None;
					filled = size;
					self.buf[..size].fill(0);
				}
			}
		}
		while filled < size {
			let mut f = self.file;
			match f.read(&mut self.buf[filled..size]) {
				Ok(0) | Err(_) => {
					self.buf[filled..size].fill(0);
					self.fd_pos = None;
					break;
				}
				Ok(n) => {
					filled += n;
					self.fd_pos = self.fd_pos.map(|pos| pos + n as u64);
				}
			}
		}
		self.start = start;
		self.len = size;
		let at = fudge as usize;
		&self.buf[at..at + len]
	}
}

/// The output side of one file transfer (upstream fileio.c state).
pub(super) struct Output<'f> {
	file: &'f File,
	/// File offset the next buffered byte lands at.
	pos: u64,
	sparse: bool,
	buf: Vec<u8>,
	sparse_seek: u64,
	sparse_past_write: u64,
	/// Bytes already allocated (in-place basis size, preallocation).
	pub(super) preallocated_len: u64,
	last_block: Option<u64>,
	/// 4 KiB logical blocks written.
	pub(super) touched: i64,
}

impl<'f> Output<'f> {
	pub(super) fn new(file: &'f File, sparse: bool) -> Self {
		Self {
			file,
			pos: 0,
			sparse,
			buf: Vec::new(),
			sparse_seek: 0,
			sparse_past_write: 0,
			preallocated_len: 0,
			last_block: None,
			touched: 0,
		}
	}

	fn seek_to(&mut self, pos: u64) -> io::Result<()> {
		let mut f = self.file;
		f.seek(SeekFrom::Start(pos))?;
		self.pos = pos;
		Ok(())
	}

	/// Moves the output position to `offset` (`--append`), returning where it is.
	pub(super) fn position_at(&mut self, offset: u64) -> io::Result<()> {
		self.flush()?;
		self.seek_to(offset)
	}

	fn raw_write(&mut self, data: &[u8]) -> io::Result<()> {
		let mut f = self.file;
		f.write_all(data)?;
		self.pos += data.len() as u64;
		Ok(())
	}

	/// Writes buffered data out.
	pub(super) fn flush(&mut self) -> io::Result<()> {
		if self.buf.is_empty() {
			return Ok(());
		}
		let data = std::mem::take(&mut self.buf);
		let result = self.raw_write(&data);
		self.buf = data;
		self.buf.clear();
		result
	}

	/// Upstream track_block_touches.
	fn track(&mut self, offset: u64, len: usize) {
		if len == 0 {
			return;
		}
		let start = offset / TRACK_BLOCK;
		let end = start + ((offset % TRACK_BLOCK) + len as u64 - 1) / TRACK_BLOCK;
		let add = match self.last_block {
			Some(last) if start <= last => end.saturating_sub(last),
			_ => end - start + 1,
		};
		self.touched = self.touched.saturating_add(i64::try_from(add).unwrap_or(i64::MAX));
		if self.last_block.is_none_or(|last| end > last) {
			self.last_block = Some(end);
		}
	}

	/// write_file: `data` belongs at `offset` (the current output position).
	pub(super) fn write(&mut self, offset: u64, data: &[u8]) -> io::Result<()> {
		if self.sparse {
			return self.write_sparse(false, offset, data);
		}
		self.track(offset, data.len());
		if self.buf.len() + data.len() > WRITE_BUFFER {
			self.flush()?;
		}
		if data.len() >= WRITE_BUFFER {
			return self.raw_write(data);
		}
		self.buf.extend_from_slice(data);
		Ok(())
	}

	/// skip_matched: identical data already sits at `offset` (in-place update).
	pub(super) fn skip(&mut self, offset: u64, data: &[u8]) -> io::Result<()> {
		if self.sparse {
			return self.write_sparse(true, offset, data);
		}
		self.flush()?;
		self.seek_to(self.pos + data.len() as u64)
	}

	/// Turns a deferred zero run into a hole and moves past it.
	fn flush_hole(&mut self) -> io::Result<()> {
		if self.sparse_seek == 0 {
			return Ok(());
		}
		let len = std::mem::take(&mut self.sparse_seek);
		if self.sparse_past_write >= self.preallocated_len {
			self.seek_to(self.pos + len)
		} else {
			punch_hole(self.file, self.sparse_past_write, len)?;
			self.pos = self.sparse_past_write + len;
			Ok(())
		}
	}

	fn emit_span(&mut self, use_seek: bool, data: &[u8]) -> io::Result<()> {
		self.flush_hole()?;
		if use_seek {
			return self.seek_to(self.pos + data.len() as u64);
		}
		self.raw_write(data)
	}

	fn write_sparse(&mut self, use_seek: bool, offset: u64, data: &[u8]) -> io::Result<()> {
		let len = data.len();
		let lead = data.iter().take_while(|&&b| b == 0).count();
		self.sparse_seek += lead as u64;
		if lead == len {
			return Ok(());
		}
		let trail = data[lead..].iter().rev().take_while(|&&b| b == 0).count();
		let end = len - trail;
		let mut start = lead;
		let mut i = lead;
		let result = (|| -> io::Result<()> {
			while i < end {
				if data[i] != 0 {
					i += 1;
					continue;
				}
				let run = data[i..end].iter().take_while(|&&b| b == 0).count();
				if run < SPARSE_WRITE_SIZE {
					i += run;
					continue;
				}
				if i > start {
					if !use_seek {
						self.track(offset + start as u64, i - start);
					}
					self.emit_span(use_seek, &data[start..i])?;
					self.sparse_past_write = offset + i as u64;
				}
				self.sparse_seek += run as u64;
				i += run;
				start = i;
			}
			if end > start {
				if !use_seek {
					self.track(offset + start as u64, end - start);
				}
				self.emit_span(use_seek, &data[start..end])?;
			}
			Ok(())
		})();
		if let Err(err) = result {
			self.sparse_seek = 0;
			return Err(err);
		}
		self.sparse_seek = trail as u64;
		self.sparse_past_write = offset + (len - trail) as u64;
		Ok(())
	}

	/// sparse_end: finishes a sparse file of `size` bytes.
	pub(super) fn sparse_end(&mut self, size: u64, updating_basis: bool) -> io::Result<()> {
		let seek = std::mem::take(&mut self.sparse_seek);
		let past = std::mem::take(&mut self.sparse_past_write);
		if updating_basis {
			if seek != 0 {
				punch_hole(self.file, past, seek)?;
			}
			self.file.set_len(size)
		} else if seek != 0 {
			self.file.set_len(size)
		} else {
			Ok(())
		}
	}
}

/// Deallocates `len` bytes at `pos` (upstream do_punch_hole): Linux punches a
/// real hole (or zeroes the range); elsewhere zeros are written.
pub(super) fn punch_hole(file: &File, pos: u64, len: u64) -> io::Result<()> {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	if let Some(native) = file.native() {
		use std::os::fd::AsRawFd;
		let fd = native.as_raw_fd();
		let (Ok(off), Ok(n)) = (libc::off_t::try_from(pos), libc::off_t::try_from(len)) else {
			return Err(io::Error::from_raw_os_error(libc::EFBIG));
		};
		for mode in [libc::FALLOC_FL_PUNCH_HOLE | libc::FALLOC_FL_KEEP_SIZE, libc::FALLOC_FL_ZERO_RANGE] {
			// SAFETY: `fd` is the open descriptor `native` owns for the whole call.
			if unsafe { libc::fallocate(fd, mode, off, n) } == 0 {
				let mut f = file;
				f.seek(SeekFrom::Start(pos + len))?;
				return Ok(());
			}
		}
	}
	let mut f = file;
	f.seek(SeekFrom::Start(pos))?;
	let zeros = [0u8; 4096];
	let mut left = len;
	while left > 0 {
		let n = left.min(zeros.len() as u64) as usize;
		f.write_all(&zeros[..n])?;
		left -= n as u64;
	}
	Ok(())
}

/// do_fallocate: reserves `len` bytes for `--preallocate`; returns the length
/// considered allocated.
pub(super) fn preallocate(file: &File, len: u64, keep_size: bool) -> io::Result<u64> {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	if let Some(native) = file.native() {
		use std::os::fd::AsRawFd;
		// Upstream deliberately requests a length that differs from the wanted one.
		let length = if len & 1 == 1 { len + 1 } else { len - 1 };
		let n = libc::off_t::try_from(length).map_err(|_| io::Error::from_raw_os_error(libc::EFBIG))?;
		let mode = if keep_size { libc::FALLOC_FL_KEEP_SIZE } else { 0 };
		// SAFETY: `native` owns the descriptor for the whole call.
		if unsafe { libc::fallocate(native.as_raw_fd(), mode, 0, n) } != 0 {
			return Err(io::Error::last_os_error());
		}
		if keep_size {
			return Ok(length);
		}
		return Ok(file.metadata().ok().and_then(|m| m.blocks()).map_or(length, |blocks| blocks * 512));
	}
	let _ = (file, len, keep_size);
	Err(io::Error::from(io::ErrorKind::Unsupported))
}

/// Where the reconstructed data goes.
pub(super) struct Target<'f> {
	pub(super) file: &'f File,
	pub(super) loc: &'f Loc,
	/// `--write-devices`: the output is a device (never truncated).
	pub(super) is_device: bool,
}

/// The basis the sender's block matches refer to.
pub(super) struct Source<'f> {
	pub(super) file: &'f File,
	pub(super) size: u64,
	pub(super) loc: &'f Loc,
}

impl Receiver<'_, '_> {
	/// receive_data: reads one file's sum-head echo, token stream, and whole-file
	/// checksum, writing the result to `target` (None: discard). Returns whether the
	/// checksum matched (always true when discarding).
	pub(super) fn receive_data(
		&mut self,
		input: &mut dyn Read,
		basis: Option<Source<'_>>,
		target: Option<Target<'_>>,
		file: &FileEntry,
		inplace_sizing: bool,
	) -> Result<bool, RsyncError> {
		let ctx = self.ctx;
		let opts = &*ctx.opts;
		let total = file.size;
		let size_r = basis.as_ref().map_or(0, |b| b.size);
		let sparse = self.sparse_active();
		let mut out = target.as_ref().map(|t| Output::new(t.file, sparse));

		let mut prealloc: Option<u64> = None;
		if usage::SUPPORT_PREALLOCATION
			&& opts.preallocate_files
			&& let Some(t) = &target
			&& total > 0
			&& (!inplace_sizing || total > size_r)
		{
			let keep_size = (opts.inplace || opts.preallocate_files) && !sparse;
			match preallocate(t.file, total, keep_size) {
				Ok(len) => prealloc = Some(len),
				Err(err) => {
					let text = [&b"do_fallocate "[..], &t.loc.full()].concat();
					self.log.rsyserr(LogCode::Warning, &err, &text);
					prealloc = Some(0);
				}
			}
		}
		let preallocated = match prealloc {
			Some(len) => len,
			None if inplace_sizing => {
				if sparse && self.whole_file && target.as_ref().is_some_and(|t| t.file.set_len(0).is_ok()) {
					0
				} else {
					size_r
				}
			}
			None => 0,
		};
		if let Some(o) = out.as_mut() {
			o.preallocated_len = preallocated;
		}

		let xfer_len = ctx.xfer_sum.digest_len();
		let head = SumHead::read_as(input, ctx.proto, xfer_len, Role::Receiver)?;
		let mut map = basis.as_ref().filter(|b| b.size > 0).map(|b| BasisMap::new(b.file, b.size, head.blength));
		if map.is_some() && self.log.levels().debug(Debug::Deltasum) >= 2 {
			let b = basis.as_ref().map_or_default(|b| b.loc.name.clone());
			let text = [&b"recv mapped "[..], &b, b" of size ", big_num(size_r as i64, 0).as_bytes(), b"\n"].concat();
			self.log.rprintf(LogCode::Info, &text);
		}

		let digest = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto }.file();
		let mut state = Flow { offset: 0, digest };
		let result = self.receive_tokens(input, &head, &mut map, out.as_mut(), target.as_ref(), total, &mut state);
		if let Err(err) = result {
			if let Some(o) = out.as_mut() {
				let _ = o.flush();
				self.add_touched(o.touched);
			}
			return Err(err);
		}
		let offset = state.offset;

		if let (Some(o), Some(t)) = (out.as_mut(), target.as_ref())
			&& offset > 0
		{
			let finished = if sparse { o.sparse_end(offset, self.updating_basis) } else { o.flush() };
			if let Err(err) = finished {
				self.add_touched(o.touched);
				return Err(self.write_failed(&err, t.loc));
			}
		}
		if let (Some(o), Some(t)) = (out.as_ref(), target.as_ref())
			&& (inplace_sizing || o.preallocated_len > offset)
			&& !t.is_device
			&& let Err(err) = t.file.set_len(offset)
		{
			let text = [&b"ftruncate failed on "[..], &t.loc.full()].concat();
			self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
		}
		if let Some(o) = out.as_ref() {
			self.add_touched(o.touched);
		}
		self.progress_end(total);

		let file_sum = state.digest.finish();
		if opts.do_fsync
			&& let Some(t) = target.as_ref()
			&& let Err(err) = t.file.sync_all()
		{
			let text = [&b"fsync failed on "[..], &t.loc.full()].concat();
			self.log.rsyserr(LogCode::Error, &err, &text);
			return Err(RsyncError::bare(RERR_FILEIO).at("receiver.c", 681));
		}
		drop(map);

		self.sender_sum.resize(xfer_len, 0);
		input.read_exact(&mut self.sender_sum).map_err(|e| self.ctx.stream_error(&e))?;
		if self.log.levels().debug(Debug::Deltasum) >= 2 {
			self.log.rprintf(LogCode::Info, b"got file_sum\n");
		}
		Ok(target.is_none() || file_sum.get(..xfer_len) == Some(&self.sender_sum[..]))
	}

	#[allow(clippy::too_many_arguments, reason = "the per-file transfer state")]
	fn receive_tokens(
		&mut self,
		input: &mut dyn Read,
		head: &SumHead,
		map: &mut Option<BasisMap<'_>>,
		mut out: Option<&mut Output<'_>>,
		target: Option<&Target<'_>>,
		total: u64,
		st: &mut Flow,
	) -> Result<(), RsyncError> {
		let ctx = self.ctx;
		let log = self.log;
		let deltasum = log.levels().debug(Debug::Deltasum);
		let keepalive = ctx.opts.io_timeout != 0;
		let append = self.append_mode();

		if append > 0 {
			let flength = u64::try_from(head.flength()).unwrap_or(0);
			if append == 2
				&& let Some(map) = map.as_mut()
			{
				let chunk = CHUNK_SIZE as u64;
				let mut offset = 0u64;
				let mut j = chunk;
				while j < flength {
					self.progress_show(offset, total);
					st.digest.update(map.map(offset, CHUNK_SIZE));
					offset = j;
					j += chunk;
				}
				if offset < flength {
					self.progress_show(offset, total);
					st.digest.update(map.map(offset, (flength - offset) as usize));
				}
			}
			st.offset = flength;
			if let (Some(o), Some(t)) = (out.as_deref_mut(), target)
				&& let Err(err) = o.position_at(flength)
			{
				let text = [
					&b"lseek of "[..],
					&t.loc.full(),
					b" returned -1, not ",
					big_num(flength as i64, 0).as_bytes(),
				]
				.concat();
				log.rsyserr(LogCode::ErrorXfer, &err, &text);
				return Err(RsyncError::bare(RERR_FILEIO).at("receiver.c", 548));
			}
		}

		loop {
			ctx.check_cancel()?;
			let offset = st.offset;
			// The literal borrows the decoder: everything below touches other fields only.
			match self.dec.recv(input)? {
				Token::End => break,
				Token::Literal(data) => {
					progress_show(ctx, offset, total);
					if keepalive {
						self.out.note_active_receiver();
					}
					if deltasum >= 3 {
						let text = format!("data recv {} at {}\n", data.len(), big_num(offset as i64, 0));
						log.rprintf(LogCode::Info, text.as_bytes());
					}
					lock(&ctx.stats).literal_data += data.len() as i64;
					self.got_literal = true;
					st.digest.update(data);
					if let Some(o) = out.as_deref_mut()
						&& let Err(err) = o.write(offset, data)
					{
						let loc = target.map(|t| t.loc);
						return Err(write_failed(log, &err, loc));
					}
					st.offset += data.len() as u64;
				}
				Token::Block(index) => {
					progress_show(ctx, offset, total);
					if keepalive {
						self.out.note_active_receiver();
					}
					let i = i32::try_from(index).unwrap_or(i32::MAX);
					if i >= head.count {
						return Err(RsyncError::new(
							RERR_PROTOCOL,
							format!("Invalid block index {i} (count={}) [{}]", head.count, log.role().name()),
						)
						.at("receiver.c", 589));
					}
					let offset2 = u64::from(index) * u64::try_from(head.blength).unwrap_or(0);
					let len = usize::try_from(head.block_len(i)).unwrap_or(0);
					lock(&ctx.stats).matched_data += len as i64;
					let Some(map) = map.as_mut() else {
						if let Some(t) = target {
							return Err(RsyncError::new(
								RERR_PROTOCOL,
								format!(
									"got a block match with no basis file for {} [{}]",
									String::from_utf8_lossy(&t.loc.full()),
									log.role().name()
								),
							)
							.at("receiver.c", 620));
						}
						st.offset += len as u64;
						continue;
					};
					if deltasum >= 3 {
						let seek = if self.updating_basis && offset == offset2 { " (seek)" } else { "" };
						let text = format!(
							"chunk[{i}] of size {len} at {} offset={}{seek}\n",
							big_num(offset2 as i64, 0),
							big_num(offset as i64, 0)
						);
						log.rprintf(LogCode::Info, text.as_bytes());
					}
					let data = map.map(offset2, len);
					self.dec.see_block(data);
					st.digest.update(data);
					if let Some(o) = out.as_deref_mut() {
						let written = if self.updating_basis && offset == offset2 {
							o.skip(offset, data)
						} else {
							o.write(offset, data)
						};
						if let Err(err) = written {
							return Err(write_failed(log, &err, target.map(|t| t.loc)));
						}
					}
					st.offset += len as u64;
				}
			}
		}
		Ok(())
	}

	fn add_touched(&self, touched: i64) {
		if touched > 0 {
			let mut stats = lock(&self.ctx.stats);
			stats.touched_blocks_4k = stats.touched_blocks_4k.saturating_add(touched);
		}
	}

	fn write_failed(&self, err: &io::Error, loc: &Loc) -> RsyncError {
		write_failed(self.log, err, Some(loc))
	}
}

/// Running state of one `receive_data`.
struct Flow {
	offset: u64,
	digest: crate::rsync::checksum::FileDigest,
}

/// "write failed on %s" and the RERR_FILEIO exit.
fn write_failed(log: &crate::rsync::log::Logger, err: &io::Error, loc: Option<&Loc>) -> RsyncError {
	let name = loc.map_or_default(Loc::full);
	log.rsyserr(LogCode::ErrorXfer, err, &[&b"write failed on "[..], &name].concat());
	RsyncError::bare(RERR_FILEIO).at("receiver.c", 660)
}

/// show_progress without borrowing the receiver.
fn progress_show(ctx: &crate::rsync::session::Ctx, ofs: u64, _total: u64) {
	if let Some(progress) = &ctx.progress {
		lock(progress).update(ofs, false);
	}
}

/// Whether the filesystem holding `dir` leaves a hole when a write skips past
/// the end of a file. Some volumes (e.g. APFS on an encrypted macOS data volume)
/// allocate the skipped range anyway; there the reference rsync's `-S` output is
/// fully allocated too, so allocation can only be asserted where holes exist.
#[cfg(all(test, unix))]
pub(super) fn fs_makes_holes(dir: &std::path::Path) -> bool {
	use std::os::unix::fs::MetadataExt;
	let path = dir.join(".hole-probe");
	let probe = (|| -> io::Result<u64> {
		let mut file = std::fs::File::create(&path)?;
		file.write_all(b"a")?;
		file.seek(SeekFrom::Start(4 * 1024 * 1024))?;
		file.write_all(b"b")?;
		drop(file);
		Ok(std::fs::metadata(&path)?.blocks() * 512)
	})();
	let _ = std::fs::remove_file(&path);
	probe.is_ok_and(|allocated| allocated < 1024 * 1024)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn temp_file(dir: &tempfile::TempDir, name: &str) -> (std::path::PathBuf, File) {
		let path = dir.path().join(name);
		let file = std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(true).open(&path).unwrap();
		(path, File::from(file))
	}

	#[test]
	fn plain_writes_are_buffered_and_tracked() {
		let dir = tempfile::tempdir().unwrap();
		let (path, file) = temp_file(&dir, "out");
		let mut out = Output::new(&file, false);
		out.write(0, &[1u8; 5000]).unwrap();
		out.write(5000, &[2u8; 100]).unwrap();
		out.flush().unwrap();
		let data = std::fs::read(&path).unwrap();
		assert_eq!(data.len(), 5100);
		assert!(data[..5000].iter().all(|&b| b == 1) && data[5000..].iter().all(|&b| b == 2));
		// Bytes 0..5100 touch 4 KiB blocks 0 and 1.
		assert_eq!(out.touched, 2);
	}

	#[test]
	fn track_counts_each_block_once() {
		let dir = tempfile::tempdir().unwrap();
		let (_path, file) = temp_file(&dir, "out");
		let mut out = Output::new(&file, false);
		out.track(0, 10);
		out.track(10, 10);
		out.track(4090, 10);
		out.track(8192, 1);
		assert_eq!(out.touched, 3);
	}

	#[test]
	fn skip_moves_past_existing_data() {
		let dir = tempfile::tempdir().unwrap();
		let (path, file) = temp_file(&dir, "out");
		std::fs::write(&path, b"AAAABBBB").unwrap();
		let mut out = Output::new(&file, false);
		out.skip(0, b"AAAA").unwrap();
		out.write(4, b"CC").unwrap();
		out.flush().unwrap();
		assert_eq!(std::fs::read(&path).unwrap(), b"AAAACCBB");
		assert_eq!(out.touched, 1);
	}

	#[test]
	fn sparse_output_keeps_data_and_length() {
		let dir = tempfile::tempdir().unwrap();
		let (path, file) = temp_file(&dir, "sparse");
		let mut out = Output::new(&file, true);
		let mut data = vec![0u8; 3 * 1024 * 1024];
		data[1024 * 1024] = 7;
		data[1024 * 1024 + 5000] = 9;
		let mut offset = 0u64;
		for chunk in data.chunks(32 * 1024) {
			out.write(offset, chunk).unwrap();
			offset += chunk.len() as u64;
		}
		out.sparse_end(offset, false).unwrap();
		let written = std::fs::read(&path).unwrap();
		assert_eq!(written, data);
		// Only the non-zero spans were written: two 4 KiB blocks.
		assert_eq!(out.touched, 2);
		#[cfg(unix)]
		if fs_makes_holes(dir.path()) {
			use std::os::unix::fs::MetadataExt;
			let meta = std::fs::metadata(&path).unwrap();
			// Allocated space stays far below the 3 MiB length.
			assert!(meta.blocks() * 512 < 1024 * 1024, "blocks={}", meta.blocks());
		}
	}

	#[test]
	fn sparse_short_interior_zero_runs_are_written() {
		let dir = tempfile::tempdir().unwrap();
		let (path, file) = temp_file(&dir, "s");
		let mut out = Output::new(&file, true);
		let mut data = vec![5u8; 3000];
		data[1000..1500].fill(0);
		data[2000..3000].fill(0);
		out.write(0, &data).unwrap();
		out.sparse_end(3000, false).unwrap();
		assert_eq!(std::fs::read(&path).unwrap(), data);
	}

	#[test]
	fn sparse_in_place_punches_holes_in_existing_data() {
		let dir = tempfile::tempdir().unwrap();
		let (path, file) = temp_file(&dir, "p");
		std::fs::write(&path, vec![0xAAu8; 8192]).unwrap();
		let mut out = Output::new(&file, true);
		out.preallocated_len = 8192;
		let mut data = vec![0xAAu8; 8192];
		data[2048..6144].fill(0);
		out.write(0, &data).unwrap();
		out.sparse_end(8192, true).unwrap();
		assert_eq!(std::fs::read(&path).unwrap(), data);
	}

	#[test]
	fn basis_map_windows_and_zero_fills_past_eof() {
		let dir = tempfile::tempdir().unwrap();
		let (path, _file) = temp_file(&dir, "basis");
		let content: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
		std::fs::write(&path, &content).unwrap();
		let file = File::from(std::fs::File::open(&path).unwrap());
		let mut map = BasisMap::new(&file, content.len() as u64, 700);
		assert_eq!(map.map(700, 700), &content[700..1400]);
		assert_eq!(map.map(40_000, 700), &content[40_000..40_700]);
		assert_eq!(map.map(0, 700), &content[..700]);
		// A block reaching past the end (the file shrank) reads zeros there.
		let tail = map.map(49_800, 700).to_vec();
		assert_eq!(&tail[..200], &content[49_800..]);
		assert!(tail[200..].iter().all(|&b| b == 0));
	}
}
