//! Delta generation on the sending side: finds the generator's blocks inside the
//! source file and emits literal data and block-match tokens (upstream match.c).
//!
//! Facts that make the token stream identical to rsync 3.5.1's for the same
//! inputs (and therefore the literal/matched byte counts):
//!
//! - Blocks are looked up by their rolling checksum in a table of 65536 buckets
//!   (bucket = low 16 bits of `(s1 + s2)`), or, for more than 52423 blocks, of
//!   `count / 8 * 10 + 11` buckets (bucket = checksum modulo the size). Each
//!   bucket chains its blocks from the highest index down.
//! - The first chain entry whose checksum, length and strong sum (first
//!   `s2length` bytes) match wins, unless the block right after the previous
//!   match (`want_i`) matches too; at most 1024 equal-checksum candidates are
//!   examined per offset.
//! - After a match the search window restarts one byte before the end of the
//!   matched block and is rolled forward once, exactly like upstream.
//! - Unmatched data is flushed as a literal of `CHUNK_SIZE` once more than a
//!   block plus a chunk has accumulated (and the end is more than a chunk away);
//!   a matched block's literal prefix goes out in the same call as its token.
//! - When the receiver updates its basis in place, a block may only be reused
//!   at or after its own offset (or where the data already sits at the same
//!   offset), and an identical block at the current aligned position wins.
//!
//! The source is read through a sliding window (upstream `map_file`): only the
//! span between the last emitted token and the search position plus one block
//! is buffered, in reads of `max(3 * blength, MAX_MAP_SIZE)` bytes. A file that
//! turns out shorter than its stat size is zero-filled (status ENODATA) and a
//! read error zero-fills the rest; both are reported through
//! [`MatchStats::read_error`] so the caller sends a deliberately wrong checksum.

use std::io::{self, Read};

use crate::rsync::flists::lock;
use crate::rsync::checksum::{self, FileDigest, MAX_CSUM_LEN, Rolling, Strong, SumHead};
use crate::rsync::consts::{CHUNK_SIZE, MAX_MAP_SIZE};
use crate::rsync::exit::{self, RsyncError};
use crate::rsync::log::{Debug as DebugFlag, Info, LogCode, Logger, Role, big_num};
use crate::rsync::session::Ctx;
use crate::rsync::token::TokenEncoder;
use crate::rsync::wire::{Proto, ReadExt};

/// Bucket count of the classic hash table (TRADITIONAL_TABLESIZE).
const TRADITIONAL_TABLESIZE: usize = 1 << 16;
/// Most equal-checksum candidates examined at one offset (upstream MAX_CHAIN_LEN).
const MAX_CHAIN_LEN: u32 = 1024;
/// `sizeof(struct sum_buf)` on the 64-bit builds whose --max-alloc arithmetic we mirror.
const SUM_BUF_SIZE: u64 = 24;
/// How often (in search steps) the cancellation flag is polled.
const CANCEL_STRIDE: u32 = 1 << 16;

/// The generator's block sums for one file, plus the per-file matching mode.
#[derive(Clone, Debug, Default)]
pub(crate) struct Sums {
	/// The validated sum header as received.
	pub head: SumHead,
	/// Rolling checksum per block.
	sum1: Vec<u32>,
	/// Strong sums, `head.s2length` bytes per block.
	sum2: Vec<u8>,
	/// Length of the basis these sums describe (upstream `s->flength`).
	flength: i64,
	/// `--append` (1) / `--append-verify` (2) for this file; 0 otherwise.
	pub append_mode: u32,
	/// The receiver rewrites its basis in place (upstream `updating_basis_file`).
	pub updating_basis: bool,
}

impl Sums {
	/// receive_sums: the header (validated per CVE-2026-53792) and, unless `append_mode`
	/// is active, `count` pairs of (`int` rolling sum, `s2length` strong-sum bytes).
	/// Allocations honor `--max-alloc` with upstream's message. `keepalive` runs every
	/// `lull_mod` blocks (protocol < 31 with `--timeout`).
	#[allow(clippy::too_many_arguments)]
	pub(crate) fn read(
		r: &mut dyn Read,
		proto: Proto,
		xfer_sum_len: usize,
		max_alloc: u64,
		append_mode: u32,
		lull_mod: u32,
		keepalive: &mut dyn FnMut() -> io::Result<()>,
		logger: &Logger,
	) -> Result<Self, RsyncError> {
		let head = SumHead::read(r, proto, xfer_sum_len)?;
		let debug = logger.levels().debug(DebugFlag::Deltasum);
		if debug >= 3 {
			logger.rprintf(
				LogCode::Info,
				format!(
					"count={} n={} rem={}\n",
					big_num(i64::from(head.count), 0),
					head.blength,
					head.remainder
				)
				.as_bytes(),
			);
		}
		let mut sums = Self { head, append_mode, ..Self::default() };
		if append_mode > 0 {
			sums.flength = head.flength();
			return Ok(sums);
		}
		if head.count == 0 {
			return Ok(sums);
		}
		let count = head.count as u64;
		alloc_check(count, SUM_BUF_SIZE, max_alloc, logger.role(), 364)?;
		alloc_check(count.saturating_mul(xfer_sum_len as u64), 1, max_alloc, logger.role(), 365)?;
		let s2 = head.s2length as usize;
		sums.sum1.reserve_exact(count as usize);
		sums.sum2.resize(count as usize * s2, 0);
		let mut offset: i64 = 0;
		for i in 0..head.count {
			sums.sum1.push(r.read_int().map_err(RsyncError::from_stream)? as u32);
			let at = i as usize * s2;
			crate::rsync::wire::fill(r, &mut sums.sum2[at..at + s2]).map_err(RsyncError::from_stream)?;
			let len = head.block_len(i);
			if lull_mod != 0 && (i as u32).is_multiple_of(lull_mod) {
				keepalive().map_err(RsyncError::from_stream)?;
			}
			if debug >= 3 {
				logger.rprintf(
					LogCode::Info,
					format!(
						"chunk[{i}] len={len} offset={} sum1={:08x}\n",
						big_num(offset, 0),
						sums.sum1[i as usize]
					)
					.as_bytes(),
				);
			}
			offset += i64::from(len);
		}
		sums.flength = offset;
		Ok(sums)
	}

	/// Sums built locally by tests: `sum1` and `sum2` (`s2length` bytes per block)
	/// must hold `head.count` entries.
	#[cfg(test)]
	pub(crate) fn from_parts(head: SumHead, sum1: Vec<u32>, sum2: Vec<u8>) -> Self {
		let flength = head.flength();
		Self { head, sum1, sum2, flength, append_mode: 0, updating_basis: false }
	}

	/// Length of the basis the sums describe (`s->flength`).
	#[cfg(test)]
	pub(crate) fn flength(&self) -> i64 {
		self.flength
	}

	fn block_len(&self, i: i32) -> i64 {
		i64::from(self.head.block_len(i))
	}

	fn block_offset(&self, i: i32) -> i64 {
		i64::from(i) * i64::from(self.head.blength)
	}

	fn strong(&self, i: i32) -> &[u8] {
		let s2 = self.head.s2length as usize;
		let at = i as usize * s2;
		&self.sum2[at..at + s2]
	}
}

/// my_alloc's --max-alloc refusal for `num` items of `size` bytes.
fn alloc_check(num: u64, size: u64, max_alloc: u64, who: Role, line: u32) -> Result<(), RsyncError> {
	if max_alloc != 0 && num >= max_alloc / size {
		return Err(RsyncError::new(
			exit::RERR_MALLOC,
			format!(
				"[{}] exceeded --max-alloc={} setting (file=sender.c, line={line})",
				who.name(),
				big_num(i64::try_from(max_alloc).unwrap_or(i64::MAX), 0)
			),
		)
		.at("util2.c", 80));
	}
	Ok(())
}

/// Per-file outcome of [`match_file`].
#[derive(Debug, Default)]
pub(crate) struct MatchStats {
	/// Bytes sent as literal data (upstream `data_transfer`).
	pub literal: u64,
	/// Bytes covered by block-match tokens.
	pub matched: u64,
	/// Buckets that had candidates.
	pub hash_hits: u32,
	/// Checksum matches whose strong sum differed.
	pub false_alarms: u32,
	/// Tokens matched.
	pub matches: u32,
	/// The first read failure (or ENODATA for a file shorter than its size).
	pub read_error: Option<io::Error>,
}

/// match_sums + hash_search: writes the file's token stream (ending with the end
/// token) for `len` bytes of `data` against `sums`, feeding every byte of the file
/// into `digest` in order. The whole-file checksum trailer is the caller's
/// (see [`file_sum_trailer`]).
#[allow(clippy::too_many_arguments)]
pub(crate) fn match_file(
	ctx: &Ctx,
	sums: &Sums,
	data: &mut dyn Read,
	len: u64,
	enc: &mut TokenEncoder,
	out: &mut dyn std::io::Write,
	digest: &mut FileDigest,
) -> Result<MatchStats, RsyncError> {
	let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
	let len = i64::try_from(len).unwrap_or(i64::MAX);
	let read_size = (sums.head.blength as usize).saturating_mul(3).max(MAX_MAP_SIZE);
	let progress = !ctx.am_server
		&& ctx.logger.levels().info(Info::Progress) >= 1
		&& ctx.progress.is_some();
	let mut m = Matcher {
		ctx,
		sums,
		map: Window::new(data, len, read_size),
		enc,
		out,
		digest,
		strong,
		last_match: 0,
		stats: MatchStats::default(),
		debug: ctx.logger.levels().debug(DebugFlag::Deltasum),
		progress,
	};

	let mut count = sums.head.count;
	if sums.append_mode > 0 {
		let flength = sums.flength.min(len).max(0);
		if sums.append_mode == 2 {
			let mut j = CHUNK_SIZE as i64;
			while j < flength {
				m.show_progress();
				m.digest_span(m.last_match, CHUNK_SIZE as i64)?;
				m.last_match = j;
				j += CHUNK_SIZE as i64;
			}
			if m.last_match < flength {
				m.show_progress();
				m.digest_span(m.last_match, flength - m.last_match)?;
			}
		}
		m.last_match = flength;
		m.map.set_floor(flength);
		count = 0;
	}

	if len > 0 && count > 0 {
		let table = Table::build(sums);
		if m.debug >= 2 {
			ctx.logger.rprintf(LogCode::Info, b"built hash table\n");
		}
		m.hash_search(table, len)?;
		if m.debug >= 2 {
			ctx.logger.rprintf(LogCode::Info, b"done hash search\n");
		}
	} else {
		let mut j = m.last_match + CHUNK_SIZE as i64;
		while j < len {
			m.matched(j, Tok::Data)?;
			j += CHUNK_SIZE as i64;
		}
		m.matched(len, Tok::End)?;
	}
	m.stats.read_error = m.map.status.take();
	Ok(m.stats)
}

/// The whole-file checksum the sender transmits after the token stream
/// (`xfer_sum_len` bytes). After a read error upstream sends a checksum that cannot
/// match: all zero bits, or (if the real one was all zeros) a final 1.
pub(crate) fn file_sum_trailer(digest: FileDigest, xfer_sum_len: usize, read_failed: bool) -> Vec<u8> {
	let mut sum = digest.finish();
	sum.resize(xfer_sum_len.max(sum.len()), 0);
	sum.truncate(xfer_sum_len);
	if read_failed && !sum.is_empty() {
		let all_zero = sum.iter().all(|&b| b == 0);
		sum.iter_mut().for_each(|b| *b = 0);
		if all_zero && let Some(last) = sum.last_mut() {
			*last = 1;
		}
	}
	sum
}

/// What one `matched()` step sends after the pending literal.
#[derive(Clone, Copy)]
enum Tok {
	Block(i32),
	Data,
	End,
}

/// The block lookup table: bucket heads plus per-block chain links.
struct Table {
	heads: Vec<i32>,
	chain: Vec<i32>,
	same_offset: Vec<bool>,
	traditional: bool,
}

impl Table {
	fn build(sums: &Sums) -> Self {
		let count = sums.head.count.max(0) as usize;
		let size = ((count / 8) * 10 + 11).max(TRADITIONAL_TABLESIZE);
		let traditional = size == TRADITIONAL_TABLESIZE;
		let mut table =
			Self { heads: vec![-1; size], chain: vec![-1; count], same_offset: vec![false; count], traditional };
		for (i, &sum) in sums.sum1.iter().enumerate().take(count) {
			let bucket = table.bucket(sum);
			table.chain[i] = table.heads[bucket];
			table.heads[bucket] = i as i32;
		}
		table
	}

	fn bucket(&self, sum: u32) -> usize {
		if self.traditional {
			((sum & 0xffff).wrapping_add(sum >> 16) & 0xffff) as usize
		} else {
			(sum as usize) % self.heads.len()
		}
	}
}

/// Where the chain walk came from (for unlinking blocks an in-place update can't use).
#[derive(Clone, Copy)]
enum Link {
	Head(usize),
	Node(usize),
}

struct Matcher<'a, 'd> {
	ctx: &'a Ctx,
	sums: &'a Sums,
	map: Window<'d>,
	enc: &'a mut TokenEncoder,
	out: &'a mut dyn std::io::Write,
	digest: &'a mut FileDigest,
	strong: Strong,
	/// End of the data already covered by tokens.
	last_match: i64,
	stats: MatchStats,
	debug: u8,
	progress: bool,
}

impl Matcher<'_, '_> {
	fn info(&self, text: String) {
		self.ctx.logger.rprintf(LogCode::Info, text.as_bytes());
	}

	fn show_progress(&self) {
		if self.progress
			&& let Some(progress) = &self.ctx.progress
		{
			let mut p = lock(&progress);
			p.update(self.last_match.max(0) as u64, false);
		}
	}

	fn digest_span(&mut self, from: i64, n: i64) -> Result<(), RsyncError> {
		let mut done = 0;
		while done < n {
			let piece = (n - done).min(CHUNK_SIZE as i64);
			let bytes = self.map.get(from + done, piece as usize)?;
			self.digest.update(bytes);
			done += piece;
		}
		Ok(())
	}

	/// Upstream `matched()`: sends the literal run since `last_match` up to `offset`,
	/// then the token; digests both; advances `last_match`.
	fn matched(&mut self, offset: i64, tok: Tok) -> Result<(), RsyncError> {
		let n = offset - self.last_match;
		let block_len = match tok {
			Tok::Block(i) => self.sums.block_len(i),
			_ => 0,
		};
		if self.debug >= 2
			&& let Tok::Block(i) = tok
		{
			self.info(format!(
				"match at {} last_match={} j={i} len={block_len} n={n}\n",
				big_num(offset, 0),
				big_num(self.last_match, 0)
			));
		}
		let total = (n + block_len) as usize;
		let span = self.map.get(self.last_match, total)?;
		let (literal, block) = span.split_at(n as usize);
		let sent = match tok {
			Tok::Block(i) => self.enc.send(self.out, literal, Some(i as u32), block),
			Tok::Data => self.enc.send(self.out, literal, None, &[]),
			Tok::End => self.enc.end_file_with(self.out, literal),
		};
		sent.map_err(RsyncError::from_stream)?;
		self.stats.literal += n as u64;
		self.stats.matched += block_len as u64;
		for piece in span.chunks(CHUNK_SIZE) {
			self.digest.update(piece);
		}
		self.last_match = offset + block_len;
		self.map.set_floor(self.last_match - 1);
		self.show_progress();
		Ok(())
	}

	fn hash_search(&mut self, mut table: Table, len: i64) -> Result<(), RsyncError> {
		let sums = self.sums;
		let head = sums.head;
		let blen = i64::from(head.blength);
		let count = head.count;
		let s2 = head.s2length as usize;
		let updating = sums.updating_basis;
		let mut want_i: i32 = 0;
		if self.debug >= 2 {
			self.info(format!("hash search b={} len={}\n", head.blength, big_num(len, 0)));
		}
		let mut k = len.min(blen);
		let mut roll = Rolling::new(self.map.get(0, k as usize)?);
		if self.debug >= 3 {
			self.info(format!("sum={:08x} k={k}\n", roll.value()));
		}
		let mut offset: i64 = 0;
		let mut aligned_offset: i64 = 0;
		let mut aligned_i: i32 = 0;
		let end = len + 1 - sums.block_len(count - 1);
		if self.debug >= 3 {
			self.info(format!(
				"hash search s->blength={} len={} count={}\n",
				head.blength,
				big_num(len, 0),
				big_num(i64::from(count), 0)
			));
		}
		let mut sum2 = [0u8; MAX_CSUM_LEN];
		let mut steps: u32 = 0;
		loop {
			steps = steps.wrapping_add(1);
			if steps.is_multiple_of(CANCEL_STRIDE) {
				self.ctx.check_cancel()?;
			}
			let mut sum = roll.value();
			if self.debug >= 4 {
				self.info(format!(
					"offset={} sum={:04x}{:04x}\n",
					big_num(offset, 0),
					sum >> 16,
					sum & 0xffff
				));
			}
			let bucket = table.bucket(sum);
			let mut i = table.heads[bucket];
			if i >= 0 {
				self.stats.hash_hits += 1;
				let mut done_csum2 = false;
				let mut chain_len = 0u32;
				let mut prev = Link::Head(bucket);
				while i >= 0 {
					let next = table.chain[i as usize];
					if updating && sums.block_offset(i) < offset && !table.same_offset[i as usize] {
						match prev {
							Link::Head(b) => table.heads[b] = next,
							Link::Node(p) => table.chain[p] = next,
						}
						i = next;
						continue;
					}
					prev = Link::Node(i as usize);
					if sum != sums.sum1[i as usize] {
						i = next;
						continue;
					}
					chain_len += 1;
					if chain_len > MAX_CHAIN_LEN {
						break;
					}
					let l = blen.min(len - offset);
					if l != sums.block_len(i) {
						i = next;
						continue;
					}
					if self.debug >= 3 {
						self.info(format!("potential match at {} i={i} sum={sum:08x}\n", big_num(offset, 0)));
					}
					if !done_csum2 {
						let data = self.map.get(offset, l as usize)?;
						self.strong.block_into(data, &mut sum2);
						done_csum2 = true;
					}
					if sum2[..s2] != *sums.strong(i) {
						self.stats.false_alarms += 1;
						i = next;
						continue;
					}

					if updating {
						while aligned_offset < offset {
							aligned_offset += blen;
							aligned_i += 1;
						}
						let aligned_ok = (offset == aligned_offset
							|| (sum == 0 && l == blen && aligned_offset + l <= len))
							&& aligned_i < count;
						if aligned_ok && self.realign(&mut i, &mut offset, &mut sum, &mut sum2, aligned_i, aligned_offset, l)? {
							table.same_offset[i as usize] = true;
							want_i = i;
						}
					}

					// Prefer the block after the previous match (cheaper run encoding).
					if i != want_i
						&& want_i < count
						&& (!updating
							|| sums.block_offset(want_i) >= offset
							|| table.same_offset[want_i as usize])
						&& sum == sums.sum1[want_i as usize]
						&& l == sums.block_len(want_i)
						&& sum2[..s2] == *sums.strong(want_i)
					{
						i = want_i;
					}
					want_i = i + 1;

					self.matched(offset, Tok::Block(i))?;
					offset += sums.block_len(i) - 1;
					k = blen.min(len - offset);
					roll = Rolling::new(self.map.get(offset, k as usize)?);
					self.stats.matches += 1;
					break;
				}
			}

			// Slide the window one byte.
			let backup = (offset - self.last_match).max(0);
			let more = offset + k < len;
			let first = self.map.byte(offset)?;
			if more {
				let next = self.map.byte(offset + k)?;
				roll.roll(first, next);
			} else {
				roll.rollout(first);
				k -= 1;
			}
			if backup >= blen + CHUNK_SIZE as i64 && end - offset > CHUNK_SIZE as i64 {
				self.matched(offset - blen, Tok::Data)?;
			}
			offset += 1;
			if offset >= end {
				break;
			}
		}
		self.matched(len, Tok::End)
	}

	/// In-place updates: switch the match to the block at the aligned position when it
	/// holds the same data, re-aligning a run of zeros forward when needed. Returns
	/// whether the (possibly switched) block now sits at its own offset.
	#[allow(clippy::too_many_arguments)]
	fn realign(
		&mut self,
		i: &mut i32,
		offset: &mut i64,
		sum: &mut u32,
		sum2: &mut [u8; MAX_CSUM_LEN],
		aligned_i: i32,
		aligned_offset: i64,
		l: i64,
	) -> Result<bool, RsyncError> {
		let sums = self.sums;
		let s2 = sums.head.s2length as usize;
		if *i != aligned_i {
			if *sum != sums.sum1[aligned_i as usize]
				|| l != sums.block_len(aligned_i)
				|| sum2[..s2] != *sums.strong(aligned_i)
			{
				return Ok(false);
			}
			*i = aligned_i;
		}
		if *offset != aligned_offset {
			let data = self.map.get(aligned_offset, l as usize)?;
			let realigned = checksum::checksum1(data);
			*sum = realigned;
			if realigned != sums.sum1[*i as usize] {
				return Ok(false);
			}
			self.strong.block_into(data, sum2);
			if sum2[..s2] != *sums.strong(*i) {
				return Ok(false);
			}
			*offset = aligned_offset;
		}
		Ok(true)
	}
}

/// Forward-only sliding view of the source (map_file / map_ptr semantics).
struct Window<'d> {
	src: &'d mut dyn Read,
	/// The size the file had when opened; nothing past it is read.
	file_size: i64,
	read_size: usize,
	/// File offset of `buf[0]`.
	start: i64,
	buf: Vec<u8>,
	/// Bytes before this offset will not be requested again.
	floor: i64,
	/// The source is exhausted or failed: everything further reads as zeros.
	eof_fill: bool,
	status: Option<io::Error>,
}

impl<'d> Window<'d> {
	fn new(src: &'d mut dyn Read, file_size: i64, read_size: usize) -> Self {
		Self {
			src,
			file_size,
			read_size,
			start: 0,
			buf: Vec::new(),
			floor: 0,
			eof_fill: false,
			status: None,
		}
	}

	fn set_floor(&mut self, floor: i64) {
		self.floor = self.floor.max(floor);
	}

	fn end(&self) -> i64 {
		self.start + self.buf.len() as i64
	}

	#[inline]
	fn byte(&mut self, pos: i64) -> Result<u8, RsyncError> {
		if pos >= self.start && pos < self.end() {
			return Ok(self.buf[(pos - self.start) as usize]);
		}
		Ok(self.get(pos, 1)?[0])
	}

	/// `len` bytes at `pos` (zero-filled past what the file delivered).
	fn get(&mut self, pos: i64, len: usize) -> Result<&[u8], RsyncError> {
		let want_end = pos + len as i64;
		if pos < self.start || want_end > self.file_size {
			// The search never asks for discarded or out-of-file data.
			return Err(RsyncError::new(
				exit::RERR_FILEIO,
				format!("invalid read of {len} bytes at {pos} passed to map_ptr"),
			)
			.at("fileio.c", 348));
		}
		if want_end > self.end() {
			self.fill(want_end)?;
		}
		let at = (pos - self.start) as usize;
		Ok(&self.buf[at..at + len])
	}

	fn fill(&mut self, want_end: i64) -> Result<(), RsyncError> {
		// Drop what can no longer be requested.
		let drop_to = self.floor.min(self.end()).max(self.start);
		if drop_to > self.start {
			self.buf.drain(..(drop_to - self.start) as usize);
			self.start = drop_to;
		}
		// Skip (read and discard) data below the floor that was never needed.
		if self.end() < self.floor {
			let mut scratch = vec![0u8; self.read_size.min((self.floor - self.end()) as usize)];
			while self.start < self.floor {
				let want = scratch.len().min((self.floor - self.start) as usize);
				let n = self.read_into(&mut scratch[..want])?;
				if n == 0 {
					self.start = self.floor;
					break;
				}
				self.start += n as i64;
			}
		}
		let target = (self.end() + self.read_size as i64).max(want_end).min(self.file_size);
		let need = (target - self.end()) as usize;
		let old = self.buf.len();
		self.buf.resize(old + need, 0);
		let mut got = old;
		while got < old + need {
			let mut piece = std::mem::take(&mut self.buf);
			let n = self.read_into(&mut piece[got..]);
			self.buf = piece;
			match n? {
				0 => break,
				n => got += n,
			}
		}
		// Bytes not delivered stay zero (upstream zero-fills the window).
		Ok(())
	}

	/// One read from the source; 0 once it is exhausted or failed (status recorded).
	fn read_into(&mut self, buf: &mut [u8]) -> Result<usize, RsyncError> {
		if self.eof_fill || buf.is_empty() {
			return Ok(0);
		}
		loop {
			match self.src.read(buf) {
				Ok(0) => {
					self.status.get_or_insert_with(enodata);
					self.eof_fill = true;
					return Ok(0);
				},
				Ok(n) => return Ok(n),
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
				Err(err) => {
					// Cancellation (and other run-ending errors) carried by the reader.
					if let Some(inner) = err.get_ref()
						&& inner.downcast_ref::<RsyncError>().is_some()
					{
						return Err(RsyncError::from_io(&err, exit::RERR_FILEIO));
					}
					self.status.get_or_insert(err);
					self.eof_fill = true;
					return Ok(0);
				},
			}
		}
	}
}

/// The status a file shorter than its stat size leaves (upstream ENODATA).
fn enodata() -> io::Error {
	#[cfg(unix)]
	{
		io::Error::from_raw_os_error(libc::ENODATA)
	}
	#[cfg(not(unix))]
	{
		io::Error::new(io::ErrorKind::UnexpectedEof, "No data available")
	}
}

#[cfg(test)]
mod tests;
