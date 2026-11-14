//! Delta token streams: literal data and block-match tokens, plain or compressed
//! with zlib, zlibx, zstd or lz4, exactly as rsync 3.5.1 frames them.
//!
//! Plain streams send each literal run as `int len` + bytes (at most CHUNK_SIZE per
//! piece), a match of block `n` as `int -(n+1)`, and `int 0` at the end. Compressed
//! streams use flag bytes: compressed data frames (`DEFLATED_DATA` + 14-bit length)
//! and block tokens coded relative to the end of the previous run, with runs of
//! consecutive blocks collapsed.
//!
//! zlib (but not zlibx) also feeds every matched block into the compressor's and
//! decompressor's history so later literals can refer to it. Upstream does that
//! with a patched zlib (`Z_INSERT_ONLY`) or, built against a stock zlib like the
//! reference binary, a discarded sync-flush; both leave the history ending with the
//! block's bytes, which is what [`flate2::Compress::set_dictionary`] does on a raw
//! stream at a flushed boundary. The decoder inserts the same bytes by inflating
//! them as a stored block.

use std::{collections::HashSet, io};

use flate2::{Compression, Decompress, FlushCompress, FlushDecompress, Status};
use zstd::zstd_safe::{self, CCtx, CParameter, DCtx, InBuffer, OutBuffer, zstd_sys::ZSTD_EndDirective};

use crate::rsync::{
	checksum::{NameNum, NameTable},
	consts,
	exit::{self, RsyncError},
	paths,
	wire::{ReadExt, WriteExt},
};

/// End of the file's token stream.
const END_FLAG: u8 = 0;
/// Followed by a 32-bit token number.
const TOKEN_LONG: u8 = 0x20;
/// Followed by a 32-bit token number and a 16-bit run count.
const TOKENRUN_LONG: u8 = 0x21;
/// Plus the high 6 bits of the length, then the low length byte.
const DEFLATED_DATA: u8 = 0x40;
/// Plus a 6-bit token number relative to the previous run's end.
const TOKEN_REL: u8 = 0x80;
/// Like TOKEN_REL, followed by a 16-bit run count.
const TOKENRUN_REL: u8 = 0xc0;
/// Largest compressed frame (14-bit count).
const MAX_DATA_COUNT: usize = 16383;
/// Largest token number a compressed stream may name.
const MAX_TOKEN_INDEX: i32 = 0x7fff_fffe;
/// Longest stored block used to insert matched data into zlib history.
const MAX_STORED_LEN: usize = 0xffff;
/// The empty stored block that ends a sync flush (trimmed from the wire).
const SYNC_MARKER: [u8; 4] = [0, 0, 0xff, 0xff];
/// Default zstd level (ZSTD_CLEVEL_DEFAULT).
const ZSTD_DEFAULT_LEVEL: i32 = 3;

/// zlib's "enough output space for one call" bound used for inflate buffers.
const fn avail_out_size(n: usize) -> usize {
	n * 1001 / 1000 + 16
}

/// Compression algorithm (`--compress-choice`, negotiation names "zstd lz4 zlibx zlib none").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Compress {
	None,
	Zlib,
	Zlibx,
	Zstd,
	Lz4,
}

/// The compression negotiation table (strongest preference first).
pub(crate) static COMPRESS_NAMES: NameTable = NameTable {
	entries: &[
		NameNum { name: "zstd", main: "zstd", num: 4 },
		NameNum { name: "lz4", main: "lz4", num: 3 },
		NameNum { name: "zlibx", main: "zlibx", num: 2 },
		NameNum { name: "zlib", main: "zlib", num: 1 },
		NameNum { name: "none", main: "none", num: 0 },
	],
};

impl Compress {
	/// Negotiation name.
	pub(crate) fn name(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::Zlib => "zlib",
			Self::Zlibx => "zlibx",
			Self::Zstd => "zstd",
			Self::Lz4 => "lz4",
		}
	}

	/// Case-insensitive name lookup ("auto" is not a name; see [`parse_compress_choice`]).
	pub(crate) fn from_name(s: &str) -> Option<Self> {
		COMPRESS_NAMES.lookup(s.as_bytes()).and_then(|entry| Self::from_num(entry.num))
	}

	/// Upstream CPRES_* number.
	pub(crate) const fn num(self) -> u8 {
		match self {
			Self::None => 0,
			Self::Zlib => 1,
			Self::Zlibx => 2,
			Self::Lz4 => 3,
			Self::Zstd => 4,
		}
	}

	const fn from_num(num: u8) -> Option<Self> {
		Some(match num {
			0 => Self::None,
			1 => Self::Zlib,
			2 => Self::Zlibx,
			3 => Self::Lz4,
			4 => Self::Zstd,
			_ => return None,
		})
	}

	/// The level actually used for a requested `--compress-level` (None = not
	/// given), like upstream's init_compression_level: zlib/zlibx default to 6,
	/// take -1 as 6, clamp to 1..=9, and level 0 turns compression off (`None`);
	/// zstd defaults to 3, takes 0 as 3 and clamps to zstd's level range; lz4
	/// always uses 0. `Compress::None` has no level.
	pub(crate) fn effective_level(self, requested: Option<i32>) -> Option<i32> {
		match self {
			Self::None => None,
			Self::Zlib | Self::Zlibx => match requested {
				None | Some(-1) => Some(6),
				Some(0) => None,
				Some(level) => Some(level.clamp(1, 9)),
			},
			Self::Zstd => match requested {
				None | Some(0) => Some(ZSTD_DEFAULT_LEVEL),
				Some(level) => Some(level.clamp(zstd_safe::min_c_level(), zstd_safe::max_c_level())),
			},
			Self::Lz4 => Some(0),
		}
	}
}

/// Parses `--compress-choice=STR`: `Ok(None)` for "auto", else the algorithm.
/// The error is upstream's message without its newline; upstream reports it with
/// RERR_UNSUPPORTED at compat.c(190).
pub(crate) fn parse_compress_choice(arg: &str) -> Result<Option<Compress>, String> {
	if arg.eq_ignore_ascii_case("auto") {
		return Ok(None);
	}
	Compress::from_name(arg).map(Some).ok_or_else(|| format!("unknown compress name: {arg}"))
}

/// Our compression preference list as sent in negotiation (RSYNC_COMPRESS_LIST
/// aware). As for checksums, the client omits "none" from the default list and
/// reads the env value before '&'; the server reads the part after it. A batch
/// writer passes upstream's forced "zlib" as `env_override`.
pub(crate) fn compress_list(env_override: Option<&str>, am_server: bool) -> Vec<&'static str> {
	COMPRESS_NAMES.list(env_override, am_server)
}

/// Server-side `--compress-choice` check against RSYNC_COMPRESS_LIST.
pub(crate) fn compress_env_allows(env_override: Option<&str>, kind: Compress) -> bool {
	COMPRESS_NAMES.env_allows(env_override, &[kind.num()], false)
}

/// Upstream's default "dont compress" suffixes.
const DEFAULT_SKIP_SUFFIXES: &str = concat!(
	"3g2 3gp 7z aac ace apk avi bz2 deb dmg ear f4v flac flv gpg gz iso jar jpeg jpg lrz lz ",
	"lz4 lzma lzo m1a m1v m2a m2ts m2v m4a m4b m4p m4r m4v mka mkv mov mp1 mp2 mp3 mp4 mpa ",
	"mpeg mpg mpv mts odb odf odg odi odm odp ods odt oga ogg ogm ogv ogx opus otg oth otp ots ",
	"ott oxt png qt rar rpm rz rzip spx squashfs sxc sxd sxg sxm sxw sz tbz tbz2 tgz tlz ts ",
	"txz tzo vob war webm webp xz z zip zst",
);

/// Longest suffix kept from one `--skip-compress` entry.
const MAX_SUFFIX_LEN: usize = 32;

/// `--skip-compress` suffix list (default list when None).
///
/// Note: rsync 3.5.1 cannot change the compression level mid-stream, so it never
/// acts on this list; it is kept for `--skip-compress` parsing/forwarding and for
/// callers that want to know which names it covers.
#[derive(Clone, Debug)]
pub(crate) struct SkipCompress {
	suffixes: HashSet<Box<[u8]>>,
}

impl SkipCompress {
	/// `spec` is the `--skip-compress` value: suffixes separated by '/', matched
	/// case-insensitively, with `[...]` character classes (a one-character class
	/// such as "[a]" is literal, "[]" matches nothing). Without a spec the default
	/// suffix list applies.
	pub(crate) fn new(spec: Option<&str>) -> Self {
		let mut suffixes = HashSet::new();
		match spec {
			None => {
				for word in DEFAULT_SKIP_SUFFIXES.split(' ') {
					suffixes.insert(word.as_bytes().into());
				}
			},
			Some(spec) => {
				for token in spec.as_bytes().split(|&b| b == b'/').filter(|t| !t.is_empty()) {
					let mut token = token.to_ascii_lowercase();
					token.truncate(MAX_SUFFIX_LEN);
					expand_suffix(token[0], &token[1..], &mut Vec::new(), &mut suffixes);
				}
			},
		}
		Self { suffixes }
	}

	/// Whether `name`'s suffix (after the last '.' of its last component, not a
	/// leading dot) is in the list.
	pub(crate) fn skips(&self, name: &[u8]) -> bool {
		let base = paths::basename(name);
		let Some(dot) = base.iter().rposition(|&b| b == b'.') else { return false };
		let suffix = &base[dot + 1..];
		if dot == 0 || suffix.is_empty() || suffix.len() > MAX_SUFFIX_LEN {
			return false;
		}
		let mut lower = [0u8; MAX_SUFFIX_LEN];
		let lower = &mut lower[..suffix.len()];
		lower.copy_from_slice(suffix);
		lower.make_ascii_lowercase();
		self.suffixes.contains(&*lower)
	}
}

/// Adds every suffix `ltr` + `rest` stands for, expanding `[...]` classes.
fn expand_suffix(ltr: u8, rest: &[u8], prefix: &mut Vec<u8>, out: &mut HashSet<Box<[u8]>>) {
	if ltr == b'['
		&& let Some(close) = memchr::memchr(b']', rest)
		&& close != 1
	{
		let after = &rest[close + 1..];
		for &member in &rest[..close] {
			expand_suffix(member, after, prefix, out);
		}
		return;
	}
	prefix.push(ltr);
	match rest.split_first() {
		Some((&next, tail)) => expand_suffix(next, tail, prefix, out),
		None => {
			out.insert(prefix.as_slice().into());
		},
	}
	prefix.pop();
}

/// What the token stream says next.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Token<'a> {
	Literal(&'a [u8]),
	Block(u32),
	End,
}

/// Token value for "data only, no token" (upstream -2).
const DATA_ONLY: i64 = -2;
/// Token value for "end of file" (upstream -1).
const END_TOKEN: i64 = -1;

/// Run-length state shared by the compressed formats.
struct Runs {
	last_token: i64,
	run_start: i64,
	last_run_end: i64,
}

impl Runs {
	const fn new() -> Self {
		Self { last_token: END_TOKEN, run_start: 0, last_run_end: 0 }
	}

	/// Records `token`, first emitting the pending run when it cannot be extended.
	/// Returns true when `token` starts a new file.
	fn advance(&mut self, w: &mut dyn io::Write, token: i64, has_data: bool) -> io::Result<bool> {
		let starts_file = self.last_token == END_TOKEN;
		if starts_file {
			self.last_run_end = 0;
			self.run_start = token;
		} else if self.last_token == DATA_ONLY {
			self.run_start = token;
		} else if has_data || token != self.last_token + 1 || token >= self.run_start + 65536 {
			let rel = self.run_start - self.last_run_end;
			let n = self.last_token - self.run_start;
			if (0..=63).contains(&rel) {
				let base = if n == 0 { TOKEN_REL } else { TOKENRUN_REL };
				w.write_u8(base + rel as u8)?;
			} else {
				w.write_u8(if n == 0 { TOKEN_LONG } else { TOKENRUN_LONG })?;
				w.write_int(self.run_start as i32)?;
			}
			if n != 0 {
				w.write_u8(n as u8)?;
				w.write_u8((n >> 8) as u8)?;
			}
			self.last_run_end = self.last_token;
			self.run_start = token;
		}
		self.last_token = token;
		Ok(starts_file)
	}
}

fn encode_error(message: String) -> io::Error {
	io::Error::other(message)
}

/// Sender side (send_token). One per transfer; `begin_file` resets per-file state.
pub(crate) struct TokenEncoder {
	kind: Compress,
	level: i32,
	threads: u32,
	proto_version: u32,
	runs: Runs,
	flush_pending: bool,
	obuf: Vec<u8>,
	deflate: Option<flate2::Compress>,
	zstd: Option<CCtx<'static>>,
}

impl TokenEncoder {
	/// `level` is the requested `--compress-level` (None = unspecified), resolved
	/// with [`Compress::effective_level`]; callers turn compression off beforehand
	/// when that yields None.
	pub(crate) fn new(kind: Compress, level: Option<i32>) -> Self {
		Self {
			kind,
			level: kind.effective_level(level).unwrap_or(0),
			threads: 0,
			proto_version: consts::PROTOCOL_VERSION,
			runs: Runs::new(),
			flush_pending: false,
			obuf: Vec::new(),
			deflate: None,
			zstd: None,
		}
	}

	/// The negotiated protocol: before 31, zlib re-inserts the first 64 KiB of a
	/// longer matched block instead of advancing through it (kept for compatibility).
	pub(crate) fn set_protocol(&mut self, version: u32) {
		self.proto_version = version;
	}

	/// `--compress-threads` for zstd (ignored when the zstd library lacks workers).
	pub(crate) fn set_threads(&mut self, threads: u32) {
		self.threads = threads;
	}

	/// Starts a file. Per-file state is already reset by the previous file's end;
	/// `compress_this_file` (the skip-compress verdict) does not change the stream
	/// because rsync 3.5.1 cannot change a compression level mid-stream.
	pub(crate) fn begin_file(&mut self, _compress_this_file: bool) {}

	/// Sends `literal` then, if `block` is Some, the block-match token; `matched` is the
	/// matched block's data (feeds compressor history for zlib).
	pub(crate) fn send(
		&mut self,
		w: &mut dyn io::Write,
		literal: &[u8],
		block: Option<u32>,
		matched: &[u8],
	) -> io::Result<()> {
		let token = match block {
			None => DATA_ONLY,
			Some(index) if index < MAX_TOKEN_INDEX as u32 + 1 => i64::from(index),
			Some(index) => {
				return Err(io::Error::new(
					io::ErrorKind::InvalidInput,
					format!("block token {index} out of range"),
				));
			},
		};
		self.token(w, token, literal, matched)
	}

	/// Ends the file's token stream.
	#[cfg(test)]
	pub(crate) fn end_file(&mut self, w: &mut dyn io::Write) -> io::Result<()> {
		self.token(w, END_TOKEN, &[], &[])
	}

	/// Ends the file with a final literal run in the same call, as upstream's
	/// matcher does for the tail of a file.
	pub(crate) fn end_file_with(&mut self, w: &mut dyn io::Write, literal: &[u8]) -> io::Result<()> {
		self.token(w, END_TOKEN, literal, &[])
	}

	fn token(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8], matched: &[u8]) -> io::Result<()> {
		match self.kind {
			Compress::None => simple_send(w, token, data),
			Compress::Zlib | Compress::Zlibx => self.deflate_send(w, token, data, matched),
			Compress::Zstd => self.zstd_send(w, token, data),
			Compress::Lz4 => self.lz4_send(w, token, data),
		}
	}

	fn deflate_send(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8], matched: &[u8]) -> io::Result<()> {
		if self.runs.advance(w, token, !data.is_empty())? {
			match &mut self.deflate {
				Some(deflate) => deflate.reset(),
				None => {
					self.deflate = Some(flate2::Compress::new_with_window_bits(
						Compression::new(self.level.clamp(0, 9) as u32),
						false,
						15,
					));
				},
			}
			self.flush_pending = false;
		}
		let Some(deflate) = self.deflate.as_mut() else {
			return Err(encode_error("compression init failed".into()));
		};
		if self.obuf.len() < 2 + MAX_DATA_COUNT {
			self.obuf.resize(2 + MAX_DATA_COUNT, 0);
		}

		// A data-only call without data has nothing to deflate (upstream would
		// fail here with Z_BUF_ERROR; the matcher never asks for it).
		if (!data.is_empty() || self.flush_pending) && !(data.is_empty() && token == DATA_ONLY) {
			deflate_frames(deflate, w, &mut self.obuf, data, token != DATA_ONLY)?;
			self.flush_pending = token == DATA_ONLY;
		}

		if token == END_TOKEN {
			w.write_u8(END_FLAG)?;
		} else if token != DATA_ONLY && self.kind == Compress::Zlib {
			let mut offset = 0;
			let mut left = matched.len();
			while left > 0 {
				let n = left.min(MAX_STORED_LEN);
				let piece = &matched[offset..offset + n];
				deflate.set_dictionary(piece).map_err(|e| {
					encode_error(format!("deflate on token returned -2 ({n} bytes left): {e}"))
				})?;
				left -= n;
				if self.proto_version >= 31 {
					offset += n;
				}
			}
		}
		Ok(())
	}

	fn zstd_send(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8]) -> io::Result<()> {
		if self.zstd.is_none() {
			let mut cctx = CCtx::try_create().ok_or_else(|| encode_error("compression init failed".into()))?;
			// Upstream ignores parameter errors (e.g. workers without zstdmt).
			let _ = cctx.set_parameter(CParameter::CompressionLevel(self.level));
			if self.threads > 0 {
				let _ = cctx.set_parameter(CParameter::NbWorkers(self.threads));
			}
			self.zstd = Some(cctx);
			self.obuf.resize(2 + MAX_DATA_COUNT, 0);
		}
		if self.runs.advance(w, token, !data.is_empty())? {
			self.flush_pending = false;
		}
		let Some(cctx) = self.zstd.as_mut() else {
			return Err(encode_error("compression init failed".into()));
		};
		if !data.is_empty() || self.flush_pending {
			let flush = token != DATA_ONLY;
			let directive = if flush { ZSTD_EndDirective::ZSTD_e_flush } else { ZSTD_EndDirective::ZSTD_e_continue };
			let mut input = InBuffer::around(data);
			loop {
				let (left, produced) = {
					let mut out = OutBuffer::around(&mut self.obuf[2..2 + MAX_DATA_COUNT]);
					let left = cctx
						.compress_stream2(&mut out, &mut input, directive)
						.map_err(|code| encode_error(format!("ZSTD_compressStream returned {}", code as i32)))?;
					(left, out.pos())
				};
				let finished = if flush { left == 0 } else { input.pos == data.len() };
				if produced != 0 {
					write_frame(w, &mut self.obuf, produced)?;
				}
				if finished {
					break;
				}
			}
			self.flush_pending = token == DATA_ONLY;
		}
		if token == END_TOKEN {
			w.write_u8(END_FLAG)?;
		}
		Ok(())
	}

	fn lz4_send(&mut self, w: &mut dyn io::Write, token: i64, data: &[u8]) -> io::Result<()> {
		let cap = lz4_flex::block::get_maximum_output_size(MAX_DATA_COUNT);
		if self.obuf.len() < 2 + cap {
			self.obuf.resize(2 + cap, 0);
		}
		self.runs.advance(w, token, !data.is_empty())?;
		// Every frame is an independent LZ4 block. Unlike upstream, an empty
		// frame is never sent: upstream receivers would take it for end-of-file.
		let mut rest = data;
		while !rest.is_empty() {
			let mut take = rest.len().min(MAX_DATA_COUNT);
			loop {
				let out_len = lz4_flex::block::compress_into(&rest[..take], &mut self.obuf[2..2 + cap])
					.map_err(|e| encode_error(format!("compress returned 0: {e}")))?;
				if out_len <= MAX_DATA_COUNT {
					write_frame(w, &mut self.obuf, out_len)?;
					rest = &rest[take..];
					break;
				}
				take /= 2;
			}
		}
		if token == END_TOKEN {
			w.write_u8(END_FLAG)?;
		}
		Ok(())
	}
}

/// Uncompressed tokens: literal pieces of at most CHUNK_SIZE, then the token.
fn simple_send(w: &mut dyn io::Write, token: i64, data: &[u8]) -> io::Result<()> {
	for piece in data.chunks(consts::CHUNK_SIZE) {
		w.write_int(piece.len() as i32)?;
		w.write_all(piece)?;
	}
	if token != DATA_ONLY {
		w.write_int((-(token + 1)) as i32)?;
	}
	Ok(())
}

/// Writes `obuf[2..2 + n]` as one DEFLATED_DATA frame.
fn write_frame(w: &mut dyn io::Write, obuf: &mut [u8], n: usize) -> io::Result<()> {
	obuf[0] = DEFLATED_DATA | (n >> 8) as u8;
	obuf[1] = n as u8;
	w.write_all(&obuf[..n + 2])
}

/// Deflates `data` into DEFLATED_DATA frames. With `flush`, the input ends with a
/// sync flush whose trailing empty stored block (00 00 ff ff) is not sent: frames
/// filled during the flush hold their last four bytes back for the next frame.
fn deflate_frames(
	deflate: &mut flate2::Compress,
	w: &mut dyn io::Write,
	obuf: &mut [u8],
	data: &[u8],
	flush: bool,
) -> io::Result<()> {
	let mut rest = data;
	let mut avail: &[u8] = &[];
	let mut filled = 0usize;
	let mut room = 0usize;
	let mut mode = FlushCompress::None;
	loop {
		if avail.is_empty() && !rest.is_empty() {
			let n = rest.len().min(consts::CHUNK_SIZE);
			(avail, rest) = rest.split_at(n);
		}
		if room == 0 {
			filled = 0;
			room = MAX_DATA_COUNT;
			if mode != FlushCompress::None {
				obuf.copy_within(2 + MAX_DATA_COUNT - 4..2 + MAX_DATA_COUNT, 2);
				filled = 4;
				room -= 4;
			}
		}
		if rest.is_empty() && flush {
			mode = FlushCompress::Sync;
		}
		let (in_before, out_before) = (deflate.total_in(), deflate.total_out());
		let status = deflate
			.compress(avail, &mut obuf[2 + filled..2 + filled + room], mode)
			.map_err(|e| encode_error(format!("deflate returned -2: {e}")))?;
		if status == Status::StreamEnd {
			return Err(encode_error("deflate returned 1".into()));
		}
		let consumed = (deflate.total_in() - in_before) as usize;
		let produced = (deflate.total_out() - out_before) as usize;
		avail = &avail[consumed..];
		filled += produced;
		room -= produced;
		let all_given = rest.is_empty();
		if all_given || room == 0 {
			let n = if mode == FlushCompress::None { filled } else { filled.saturating_sub(4) };
			if n > 0 {
				write_frame(w, obuf, n)?;
			}
		}
		if all_given && room != 0 {
			return Ok(());
		}
		if consumed == 0 && produced == 0 {
			return Err(encode_error("deflate returned -5".into()));
		}
	}
}

/// Decoder state (upstream recv_state).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecvState {
	Init,
	Idle,
	Running,
	Inflating,
	Inflated,
}

/// One decoded step before borrowing the output buffer.
enum Step {
	Data(usize),
	Block(u32),
	End,
}

fn decode_error(message: String, line: u32) -> RsyncError {
	RsyncError::new(exit::RERR_STREAMIO, message).at("token.c", line)
}

fn invalid_token() -> RsyncError {
	RsyncError::new(exit::RERR_PROTOCOL, "invalid token number in compressed stream").at("token.c", 531)
}

/// zlib return code for a flate2 result, for upstream's diagnostics.
fn zlib_code(result: &Result<Status, flate2::DecompressError>) -> i32 {
	match result {
		Ok(Status::Ok) => 0,
		Ok(Status::StreamEnd) => 1,
		Ok(Status::BufError) => -5,
		Err(err) if err.needs_dictionary().is_some() => 2,
		Err(_) => -3,
	}
}

/// Receiver side (recv_token + see_token).
pub(crate) struct TokenDecoder {
	kind: Compress,
	proto_version: u32,
	state: RecvState,
	rx_token: i32,
	rx_run: i32,
	saved_flag: Option<u8>,
	residue: usize,
	data: Vec<u8>,
	cbuf: Vec<u8>,
	cpos: usize,
	clen: usize,
	inflate: Option<Decompress>,
	zstd: Option<DCtx<'static>>,
	pending: Option<RsyncError>,
}

impl TokenDecoder {
	/// A decoder for `kind`; buffers are allocated on first use and bounded.
	pub(crate) fn new(kind: Compress) -> Self {
		Self {
			kind,
			proto_version: consts::PROTOCOL_VERSION,
			state: RecvState::Init,
			rx_token: 0,
			rx_run: 0,
			saved_flag: None,
			residue: 0,
			data: Vec::new(),
			cbuf: Vec::new(),
			cpos: 0,
			clen: 0,
			inflate: None,
			zstd: None,
			pending: None,
		}
	}

	/// The negotiated protocol (see [`TokenEncoder::set_protocol`]).
	pub(crate) fn set_protocol(&mut self, version: u32) {
		self.proto_version = version;
	}

	/// The next literal piece, block match, or end of the file.
	pub(crate) fn recv(&mut self, r: &mut dyn io::Read) -> Result<Token<'_>, RsyncError> {
		if let Some(err) = self.pending.take() {
			return Err(err);
		}
		let step = match self.kind {
			Compress::None => self.simple_step(r)?,
			Compress::Zlib | Compress::Zlibx => self.inflate_step(r)?,
			Compress::Zstd => self.zstd_step(r)?,
			Compress::Lz4 => self.lz4_step(r)?,
		};
		Ok(match step {
			Step::Data(n) => Token::Literal(&self.data[..n]),
			Step::Block(index) => Token::Block(index),
			Step::End => Token::End,
		})
	}

	/// Feeds a matched block's data into decompressor history (see_token). Only
	/// zlib keeps such history; an inflate failure is reported by the next `recv`.
	pub(crate) fn see_block(&mut self, data: &[u8]) {
		if self.kind != Compress::Zlib || self.pending.is_some() {
			return;
		}
		if let Err(err) = self.insert_history(data) {
			self.pending = Some(err);
		}
	}

	fn simple_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		if self.residue == 0 {
			let len = r.read_int().map_err(RsyncError::from_stream)?;
			if len == 0 {
				return Ok(Step::End);
			}
			if len < 0 {
				return Ok(Step::Block((-(i64::from(len) + 1)) as u32));
			}
			self.residue = len as usize;
		}
		let n = self.residue.min(consts::CHUNK_SIZE);
		if self.data.len() < consts::CHUNK_SIZE {
			self.data.resize(consts::CHUNK_SIZE, 0);
		}
		r.read_exact(&mut self.data[..n]).map_err(RsyncError::from_stream)?;
		self.residue -= n;
		Ok(Step::Data(n))
	}

	/// Reads a DEFLATED_DATA payload into `cbuf`.
	fn read_frame(&mut self, r: &mut dyn io::Read, flag: u8) -> Result<(), RsyncError> {
		let low = r.read_u8().map_err(RsyncError::from_stream)?;
		let n = (usize::from(flag & 0x3f) << 8) | usize::from(low);
		if self.cbuf.len() < MAX_DATA_COUNT {
			self.cbuf.resize(MAX_DATA_COUNT, 0);
		}
		r.read_exact(&mut self.cbuf[..n]).map_err(RsyncError::from_stream)?;
		self.cpos = 0;
		self.clen = n;
		self.state = RecvState::Inflating;
		Ok(())
	}

	fn read_flag(&mut self, r: &mut dyn io::Read) -> Result<u8, RsyncError> {
		match self.saved_flag.take() {
			Some(flag) => Ok(flag),
			None => r.read_u8().map_err(RsyncError::from_stream),
		}
	}

	/// A token flag byte (anything but data and END_FLAG).
	fn token_num(&mut self, r: &mut dyn io::Read, flag: u8) -> Result<Step, RsyncError> {
		let mut run_bit = flag & 1;
		if flag & TOKEN_REL != 0 {
			let incr = i32::from(flag & 0x3f);
			if self.rx_token > MAX_TOKEN_INDEX - incr {
				return Err(invalid_token());
			}
			self.rx_token += incr;
			run_bit = (flag >> 6) & 1;
		} else {
			self.rx_token = r.read_int().map_err(RsyncError::from_stream)?;
			if !(0..=MAX_TOKEN_INDEX).contains(&self.rx_token) {
				return Err(invalid_token());
			}
		}
		if run_bit != 0 {
			let lo = r.read_u8().map_err(RsyncError::from_stream)?;
			let hi = r.read_u8().map_err(RsyncError::from_stream)?;
			self.rx_run = i32::from(lo) | (i32::from(hi) << 8);
			if self.rx_run <= 0 || self.rx_token > MAX_TOKEN_INDEX - self.rx_run {
				return Err(invalid_token());
			}
			self.state = RecvState::Running;
		}
		Ok(Step::Block(self.rx_token as u32))
	}

	fn run_step(&mut self) -> Result<Step, RsyncError> {
		if self.rx_run <= 0 || self.rx_token >= MAX_TOKEN_INDEX {
			return Err(invalid_token());
		}
		self.rx_token += 1;
		self.rx_run -= 1;
		if self.rx_run == 0 {
			self.state = RecvState::Idle;
		}
		Ok(Step::Block(self.rx_token as u32))
	}

	fn ensure_inflate(&mut self) -> &mut Decompress {
		let out = avail_out_size(consts::CHUNK_SIZE);
		if self.data.len() < out {
			self.data.resize(out, 0);
		}
		self.inflate.get_or_insert_with(|| Decompress::new_with_window_bits(false, 15))
	}

	fn inflate_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		loop {
			match self.state {
				RecvState::Init => {
					if self.inflate.is_some() {
						self.ensure_inflate().reset(false);
					} else {
						self.ensure_inflate();
					}
					self.state = RecvState::Idle;
					self.rx_token = 0;
				},
				RecvState::Idle | RecvState::Inflated => {
					let flag = self.read_flag(r)?;
					if flag & 0xc0 == DEFLATED_DATA {
						self.read_frame(r, flag)?;
						continue;
					}
					if self.state == RecvState::Inflated {
						let out = avail_out_size(consts::CHUNK_SIZE);
						let Self { inflate, data, .. } = self;
						let Some(inflate) = inflate.as_mut() else { return Err(invalid_token()) };
						let before = inflate.total_out();
						let result = inflate.decompress(&[], &mut data[..out], FlushDecompress::Sync);
						let n = (inflate.total_out() - before) as usize;
						let code = zlib_code(&result);
						if code != 0 && code != -5 {
							return Err(decode_error(
								format!("inflate flush returned {code} ({n} bytes)"),
								628,
							));
						}
						if n != 0 && code != -5 {
							self.saved_flag = Some(flag);
							return Ok(Step::Data(n));
						}
						// The sender trimmed the sync flush's empty stored block;
						// supply it, which must complete without output.
						let (in_before, out_before) = (inflate.total_in(), inflate.total_out());
						let result = inflate.decompress(&SYNC_MARKER, &mut data[..out], FlushDecompress::Sync);
						if result.is_err()
							|| inflate.total_in() - in_before != SYNC_MARKER.len() as u64
							|| inflate.total_out() != out_before
						{
							return Err(decode_error("decompressor lost sync!".into(), 643));
						}
						self.state = RecvState::Idle;
					}
					if flag == END_FLAG {
						self.state = RecvState::Init;
						return Ok(Step::End);
					}
					return self.token_num(r, flag);
				},
				RecvState::Inflating => {
					let out = avail_out_size(consts::CHUNK_SIZE);
					let Self { inflate, data, cbuf, cpos, clen, state, .. } = self;
					let Some(inflate) = inflate.as_mut() else { return Err(invalid_token()) };
					let (in_before, out_before) = (inflate.total_in(), inflate.total_out());
					let result = inflate.decompress(&cbuf[*cpos..*clen], &mut data[..out], FlushDecompress::None);
					let n = (inflate.total_out() - out_before) as usize;
					*cpos += (inflate.total_in() - in_before) as usize;
					let code = zlib_code(&result);
					if code != 0 {
						return Err(decode_error(format!("inflate returned {code} ({n} bytes)"), 668));
					}
					if *cpos == *clen {
						*state = RecvState::Inflated;
					}
					if n != 0 {
						return Ok(Step::Data(n));
					}
				},
				RecvState::Running => return self.run_step(),
			}
		}
	}

	/// Inflates `data` as stored blocks so it lands in the history window.
	fn insert_history(&mut self, data: &[u8]) -> Result<(), RsyncError> {
		let proto_version = self.proto_version;
		self.ensure_inflate();
		let out = avail_out_size(consts::CHUNK_SIZE);
		let Self { inflate, data: scratch, .. } = self;
		let Some(inflate) = inflate.as_mut() else { return Err(invalid_token()) };
		let mut offset = 0;
		let mut left = data.len();
		while left > 0 {
			let n = left.min(MAX_STORED_LEN);
			let header = [0, n as u8, (n >> 8) as u8, !(n as u8), !((n >> 8) as u8)];
			inflate_all(inflate, &header, &mut scratch[..out])?;
			inflate_all(inflate, &data[offset..offset + n], &mut scratch[..out])?;
			left -= n;
			if proto_version >= 31 {
				offset += n;
			}
		}
		Ok(())
	}

	fn zstd_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		if self.zstd.is_none() {
			let dctx = DCtx::try_create().ok_or_else(|| {
				RsyncError::new(exit::RERR_PROTOCOL, "ZSTD_createDStream failed").at("token.c", 850)
			})?;
			self.zstd = Some(dctx);
			self.data.resize(DCtx::out_size() * 2, 0);
		}
		loop {
			match self.state {
				RecvState::Init => {
					self.state = RecvState::Idle;
					self.rx_token = 0;
				},
				RecvState::Idle | RecvState::Inflated => {
					let flag = self.read_flag(r)?;
					if flag & 0xc0 == DEFLATED_DATA {
						self.read_frame(r, flag)?;
						continue;
					}
					if flag == END_FLAG {
						self.state = RecvState::Init;
						return Ok(Step::End);
					}
					return self.token_num(r, flag);
				},
				RecvState::Inflating => {
					let Self { zstd, data, cbuf, cpos, clen, state, .. } = self;
					let Some(dctx) = zstd.as_mut() else { return Err(invalid_token()) };
					let out_size = data.len();
					let mut input = InBuffer { src: &cbuf[..*clen], pos: *cpos };
					let mut output = OutBuffer::around(&mut data[..]);
					let result = dctx.decompress_stream(&mut output, &mut input);
					let n = output.pos();
					*cpos = input.pos;
					if let Err(code) = result {
						return Err(decode_error(
							format!("ZSTD decomp returned {} ({n} bytes)", code as i32),
							903,
						));
					}
					if *cpos == *clen && n < out_size {
						*state = RecvState::Idle;
					}
					if n != 0 {
						return Ok(Step::Data(n));
					}
				},
				RecvState::Running => return self.run_step(),
			}
		}
	}

	fn lz4_step(&mut self, r: &mut dyn io::Read) -> Result<Step, RsyncError> {
		let size = lz4_flex::block::get_maximum_output_size(consts::CHUNK_SIZE).max(MAX_DATA_COUNT + 2);
		if self.data.len() < size {
			self.data.resize(size, 0);
		}
		loop {
			match self.state {
				RecvState::Init => {
					self.state = RecvState::Idle;
					self.rx_token = 0;
				},
				RecvState::Idle | RecvState::Inflated => {
					let flag = self.read_flag(r)?;
					if flag & 0xc0 == DEFLATED_DATA {
						self.read_frame(r, flag)?;
						continue;
					}
					if flag == END_FLAG {
						self.state = RecvState::Init;
						return Ok(Step::End);
					}
					return self.token_num(r, flag);
				},
				RecvState::Inflating => {
					let n = lz4_flex::block::decompress_into(&self.cbuf[..self.clen], &mut self.data[..size])
						.map_err(|_| decode_error("uncompress failed: -1".into(), 1047))?;
					self.state = RecvState::Idle;
					// An empty block is not end-of-file; skip it.
					if n != 0 {
						return Ok(Step::Data(n));
					}
				},
				RecvState::Running => return self.run_step(),
			}
		}
	}
}

/// Inflates all of `input` (with sync flushes), discarding the output.
fn inflate_all(inflate: &mut Decompress, input: &[u8], scratch: &mut [u8]) -> Result<(), RsyncError> {
	let mut pos = 0;
	loop {
		let (in_before, out_before) = (inflate.total_in(), inflate.total_out());
		let result = inflate.decompress(&input[pos..], scratch, FlushDecompress::Sync);
		let code = zlib_code(&result);
		if code != 0 && code != -5 {
			return Err(decode_error(format!("inflate (token) returned {code}"), 724));
		}
		let consumed = (inflate.total_in() - in_before) as usize;
		let produced = (inflate.total_out() - out_before) as usize;
		pos += consumed;
		if pos == input.len() && produced < scratch.len() {
			return Ok(());
		}
		if consumed == 0 && produced == 0 {
			return Err(decode_error("inflate (token) returned -5".into(), 724));
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rsync::checksum::capture::{lcg_bytes, lcg_text, token_basis, token_source};

	fn unhex(s: &str) -> Vec<u8> {
		(0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
	}

	/// Token streams the reference sender produced for `token_source` against
	/// `token_basis` (blocks 0,1 + literal 508 + block 2 + literal 900 + block 3).
	const REF_ZLIB: &str = concat!(
		"c001004010f2f10c710d72f4d11d2d1b475ed908008140817cd6391680300845d1fdefda928b4f6c",
		"ac6272f823ad27ef4b9230a56c85f2c65123b9142bb3785fa5672acb03bb2cb5409997cf8703ef85",
		"c136e4060739a01103a5ad63b2d9c8cab5e5ac28f80b94eff48e913cec0b4eda6a3842b2c00bd225",
		"65518fb5c2dcea408372c0c08eed36ff81b6a8bd0ca2b06c4fc238d15183a1fb078100",
	);
	const REF_ZLIBX: &str = concat!(
		"c0010040986c914b0e83300c44af920bf4105db0406255f5020e4414257c44d9c0e9a11e4b19a09b",
		"111adbe3e75095efe2f5ac1edef9b0885bc61806d356fa5edc963a4f82927eea009a244d1f71f377",
		"1d6ab6d1dc84743850f83e8d7544234fdabc16af1be17288455d43b885afc9c82a7fcf625e641aa9",
		"ea3d130ef6b24f0f815142b0733236144b3324af3fa1fc8a7c29b39dc8f36fb83f3d20760081408b",
		"7cd34b0e00310802d0fbdf7a1259f85ad2d999d61f081ec6490788bd463eb3225dd8cb269ed4bd8c",
		"f36b2ca3b4cc03a395403a0a692a138ac25eab04c600962cf8b483401ed4c8415e92a869d0831a17",
		"547b4cb1c1bfe97f0e38a8b9edea0491b6bd1e426be225a92fc7712d6a1bd6c25e4d19afc35b6de6",
		"69ba5b00ade252d8e4b5c5609b1dda1b137f008100",
	);
	const REF_ZSTD: &str = concat!(
		"c0010040ba28b52ffd00588c050034034c49544552414c2d62206265746120746f6b656e67616d6d",
		"61207a6c6962616c706861207273796e6364656c7461626c6f636b3720304266d67913e2c0223928",
		"66831e077ce66031603cc073c1cd81000ea86fc019c076c0bf065c037232e01d58f9020332033e40",
		"d703ea008d387c401ca07700a7018503b433b4066310ec026cdf202a076639008143068872480c50",
		"8300bc309041c70173a8c408312b942168ee8809ba07b8012106904192152681409bc40400406574",
		"61616c70686156a8e0d7502221850c6f113440c1a2bc356b06993a59c8e85d348f2555b9bcc89904",
		"7ab841b7204a798b486da22ef9d958083cc1db6bffe5131fa80cf38b28a30ccffbcb0ab987084c3b",
		"d6496870e0a88a30ee39674e204e6f463a80f748c55e2a47487ae06a5580baf202e85eff9b57e562",
		"e67086e9a156c913def366544028b43731530098c80d1268cd7b4e52eb8100",
	);
	const REF_LZ4: &str = concat!(
		"c00100410df3054c49544552414c2d62206265746120746f6b656e0600a767616d6d61207a6c6962",
		"0500022100011500013100022500b2616c706861207273796e634800021700022d005364656c7461",
		"060002180052626c6f636b2900083a00034000011d00016200010500024500023300084500034b00",
		"00b600084500082300023b00020600014c0001b300010500010f0006050002240002060002420002",
		"540002770002060002710002240002060002120002b700021200020600021200016800023b000217",
		"00016f00020b00011c00026300020600027500012200071c00023e00022200020c00011d00026000",
		"023300021700028a00021200032f00001901081700020c00022f0060746f6b656e208141b1626465",
		"6c7461200600f308626c6f636b20616c70686120746f6b656e207273796e631800437a6c69621d00",
		"010b00021600022800020c002b62654500023f00020600026300025d00080c00021e00021800020c",
		"004467616d6d0c00075300021d00077b00022800020600025200028d00020c00013a00020b00023a",
		"0003a40001e40003120001b000060500011b0002270001670007260002a000015400022100021c00",
		"026000021d00020600013900022300028e0002290002060002120002290002b800020c0002180007",
		"5e00025800020600021d00082f00084d00021e00027100014100021100022f000206000212000206",
		"00029f0000f300025d00024b00013900082d00021700023300020c00082f00020c0002300002c100",
		"074100021d00020600023b00029d00022900020600023b00020600082a00019e00083500021d0002",
		"3500024700031e0000c200024000021700020600022f00020c00019300015100021600024500023f",
		"00021200022800020c00012900021100020600011100083400023a00021301023400066200028a00",
		"021600020c00022800014500010500021c00025b0008560050616c7068618100",
	);

	/// Decodes `stream` against `basis` (blocks of `blen`), feeding matched blocks
	/// back with `see_block`; returns the reconstruction.
	fn decode(kind: Compress, proto: u32, stream: &[u8], basis: &[u8], blen: usize, files: usize) -> Vec<Vec<u8>> {
		let mut decoder = TokenDecoder::new(kind);
		decoder.set_protocol(proto);
		let mut r = stream;
		let mut out = Vec::new();
		for _ in 0..files {
			let mut file = Vec::new();
			loop {
				match decoder.recv(&mut r).unwrap() {
					Token::Literal(data) => file.extend_from_slice(data),
					Token::Block(i) => {
						let start = i as usize * blen;
						let block = &basis[start..(start + blen).min(basis.len())];
						file.extend_from_slice(block);
						decoder.see_block(block);
					},
					Token::End => break,
				}
			}
			out.push(file);
		}
		assert!(r.is_empty(), "{} trailing bytes", r.len());
		out
	}

	#[test]
	fn reference_streams_decode() {
		let basis = token_basis();
		let want = token_source();
		for (kind, stream) in [
			(Compress::Zlib, REF_ZLIB),
			(Compress::Zlibx, REF_ZLIBX),
			(Compress::Zstd, REF_ZSTD),
			(Compress::Lz4, REF_LZ4),
		] {
			let got = decode(kind, 33, &unhex(stream), &basis, 700, 1);
			assert_eq!(got[0], want, "{kind:?}");
		}
	}

	#[test]
	fn plain_stream_matches_reference_layout() {
		let src = token_source();
		let basis = token_basis();
		let blocks: Vec<&[u8]> = basis.chunks(700).collect();
		let mut enc = TokenEncoder::new(Compress::None, None);
		let mut out = Vec::new();
		enc.begin_file(true);
		enc.send(&mut out, &[], Some(0), blocks[0]).unwrap();
		enc.send(&mut out, &[], Some(1), blocks[1]).unwrap();
		enc.send(&mut out, &src[1400..1908], Some(2), blocks[2]).unwrap();
		enc.send(&mut out, &src[2608..3508], Some(3), blocks[3]).unwrap();
		enc.end_file(&mut out).unwrap();
		let mut want = Vec::new();
		for v in [-1i32, -2, 508] {
			want.extend_from_slice(&v.to_le_bytes());
		}
		want.extend_from_slice(&src[1400..1908]);
		want.extend_from_slice(&(-3i32).to_le_bytes());
		want.extend_from_slice(&900i32.to_le_bytes());
		want.extend_from_slice(&src[2608..3508]);
		want.extend_from_slice(&(-4i32).to_le_bytes());
		want.extend_from_slice(&0i32.to_le_bytes());
		assert_eq!(out, want);
		assert_eq!(decode(Compress::None, 33, &out, &basis, 700, 1)[0], src);
	}

	#[test]
	fn plain_literals_split_at_chunk_size() {
		let data = lcg_bytes(70_000, 5);
		let mut out = Vec::new();
		let mut enc = TokenEncoder::new(Compress::None, None);
		enc.end_file_with(&mut out, &data).unwrap();
		let mut r = out.as_slice();
		let mut lens = Vec::new();
		loop {
			let n = r.read_int().unwrap();
			if n == 0 {
				break;
			}
			lens.push(n);
			r = &r[n as usize..];
		}
		assert_eq!(lens, [32768, 32768, 4464]);
		// A peer may send runs longer than CHUNK_SIZE; they arrive in pieces.
		let mut long = 70_000i32.to_le_bytes().to_vec();
		long.extend_from_slice(&data);
		long.extend_from_slice(&0i32.to_le_bytes());
		assert_eq!(decode(Compress::None, 33, &long, &[], 1, 1)[0], data);
	}

	/// One send call: literal, then optionally a block.
	type Op = (Vec<u8>, Option<u32>);

	/// Encodes `files` (ops + trailing literal) and decodes them again.
	fn round_trip(kind: Compress, proto: u32, basis: &[u8], blen: usize, files: &[(Vec<Op>, Vec<u8>)]) {
		let mut enc = TokenEncoder::new(kind, None);
		enc.set_protocol(proto);
		let mut stream = Vec::new();
		let mut want = Vec::new();
		for (ops, tail) in files {
			enc.begin_file(true);
			let mut file = Vec::new();
			for (literal, block) in ops {
				let matched: &[u8] = match block {
					Some(i) => {
						let start = *i as usize * blen;
						&basis[start..(start + blen).min(basis.len())]
					},
					None => &[],
				};
				enc.send(&mut stream, literal, *block, matched).unwrap();
				file.extend_from_slice(literal);
				file.extend_from_slice(matched);
			}
			enc.end_file_with(&mut stream, tail).unwrap();
			file.extend_from_slice(tail);
			want.push(file);
		}
		let got = decode(kind, proto, &stream, basis, blen, files.len());
		assert_eq!(got.len(), want.len());
		for (i, (g, w)) in got.iter().zip(&want).enumerate() {
			assert!(g == w, "{kind:?} proto {proto} file {i}: {} vs {} bytes", g.len(), w.len());
		}
	}

	const ALL: [Compress; 5] = [Compress::None, Compress::Zlib, Compress::Zlibx, Compress::Zstd, Compress::Lz4];

	#[test]
	fn round_trips_with_interleaved_literals_and_blocks() {
		let basis = [lcg_text(40_000, 11), lcg_bytes(9_000, 12)].concat();
		let text = lcg_text(100_000, 13);
		let noise = lcg_bytes(80_000, 14);
		let files = vec![
			(
				vec![
					(vec![], Some(0)),
					(vec![], Some(1)),
					(basis[100..900].to_vec(), Some(2)),
					(text[..20_000].to_vec(), None),
					(noise[..50_000].to_vec(), Some(60)),
					(vec![], Some(61)),
					(vec![], Some(62)),
					(basis[1000..1500].to_vec(), Some(5)),
					(vec![], Some(4)),
					(b"x".to_vec(), Some(48)),
				],
				text[20_000..60_000].to_vec(),
			),
			(vec![], Vec::new()),
			(vec![(vec![], Some(3))], Vec::new()),
			(vec![(noise[..10].to_vec(), None), (noise[10..40_000].to_vec(), None)], basis[..3000].to_vec()),
		];
		for kind in ALL {
			round_trip(kind, 33, &basis, 700, &files);
			round_trip(kind, 30, &basis, 700, &files);
		}
	}

	#[test]
	fn zlib_history_covers_matched_blocks() {
		// Literals that repeat a matched block compress to back-references only if
		// both sides inserted the block into their history.
		let basis = lcg_text(7000, 21);
		let files = vec![(
			vec![(vec![], Some(0)), (basis[..700].to_vec(), Some(3)), (basis[2100..2800].to_vec(), None)],
			basis[..700].to_vec(),
		)];
		round_trip(Compress::Zlib, 33, &basis, 700, &files);
		let mut stream = Vec::new();
		let mut enc = TokenEncoder::new(Compress::Zlib, None);
		enc.send(&mut stream, &[], Some(0), &basis[..700]).unwrap();
		enc.send(&mut stream, &lcg_bytes(16, 1), Some(1), &basis[700..1400]).unwrap();
		let before = stream.len();
		enc.end_file_with(&mut stream, &basis[..700]).unwrap();
		assert!(stream.len() - before < 60, "history not used: {}", stream.len() - before);
	}

	#[test]
	fn long_blocks_and_protocol_30_history_quirk() {
		// Blocks over 64 KiB take several stored pieces; before protocol 31 the
		// first piece is repeated instead of advancing. Both sides must agree.
		let basis = [lcg_text(140_000, 31), lcg_bytes(60_000, 32)].concat();
		let blen = 100_000;
		let files = vec![(
			vec![
				(vec![], Some(0)),
				(basis[70_000..72_000].to_vec(), Some(1)),
				(basis[10..5000].to_vec(), None),
			],
			basis[99_000..100_000].to_vec(),
		)];
		for proto in [30, 31] {
			round_trip(Compress::Zlib, proto, &basis, blen, &files);
		}
	}

	#[test]
	fn token_runs_use_relative_and_long_forms() {
		let blen = 1;
		let basis = lcg_bytes(200_000, 41);
		let mut ops: Vec<Op> = (0..70_000).map(|i| (vec![], Some(i))).collect();
		ops.push((vec![], Some(70_100)));
		ops.push((vec![], Some(100)));
		ops.push((b"abc".to_vec(), Some(199_999)));
		let files = vec![(ops, Vec::new())];
		for kind in [Compress::Zlibx, Compress::Zstd, Compress::Lz4, Compress::Zlib] {
			round_trip(kind, 33, &basis, blen, &files);
		}
		// Exact flag bytes for a short sequence.
		let mut out = Vec::new();
		let mut enc = TokenEncoder::new(Compress::Lz4, None);
		for i in [0, 1, 2, 5, 200] {
			enc.send(&mut out, &[], Some(i), &[]).unwrap();
		}
		enc.end_file(&mut out).unwrap();
		let mut want = vec![TOKENRUN_REL, 2, 0, TOKEN_REL + 3, TOKEN_LONG];
		want.extend_from_slice(&200i32.to_le_bytes());
		want.push(END_FLAG);
		assert_eq!(out, want);
	}

	#[test]
	fn compressed_reference_layout_is_reproduced() {
		// Same calls as the reference sender: identical flag skeleton.
		let src = token_source();
		let basis = token_basis();
		let blocks: Vec<&[u8]> = basis.chunks(700).collect();
		for kind in [Compress::Zlib, Compress::Zlibx, Compress::Zstd, Compress::Lz4] {
			let mut enc = TokenEncoder::new(kind, None);
			let mut out = Vec::new();
			enc.send(&mut out, &[], Some(0), blocks[0]).unwrap();
			enc.send(&mut out, &[], Some(1), blocks[1]).unwrap();
			enc.send(&mut out, &src[1400..1908], Some(2), blocks[2]).unwrap();
			enc.send(&mut out, &src[2608..3508], Some(3), blocks[3]).unwrap();
			enc.end_file(&mut out).unwrap();
			assert_eq!(&out[..3], &[TOKENRUN_REL, 1, 0], "{kind:?}");
			assert_eq!(out[3] & 0xc0, DEFLATED_DATA);
			assert_eq!(out[out.len() - 2..], [TOKEN_REL + 1, END_FLAG]);
			assert_eq!(decode(kind, 33, &out, &basis, 700, 1)[0], src);
		}
	}

	fn recv_err(kind: Compress, stream: &[u8]) -> RsyncError {
		let mut decoder = TokenDecoder::new(kind);
		let mut r = stream;
		loop {
			match decoder.recv(&mut r) {
				Ok(Token::End) => panic!("stream accepted"),
				Ok(_) => {},
				Err(err) => return err,
			}
		}
	}

	#[test]
	fn decoder_rejects_bad_tokens() {
		for kind in [Compress::Zlib, Compress::Zstd, Compress::Lz4] {
			// Negative long token.
			let mut s = vec![TOKEN_LONG];
			s.extend_from_slice(&(-5i32).to_le_bytes());
			assert_eq!(recv_err(kind, &s).code, exit::RERR_PROTOCOL);
			// Run of zero.
			assert_eq!(recv_err(kind, &[TOKENRUN_REL, 0, 0]).code, exit::RERR_PROTOCOL);
			// Relative token past MAX_TOKEN_INDEX.
			let mut s = vec![TOKEN_LONG];
			s.extend_from_slice(&MAX_TOKEN_INDEX.to_le_bytes());
			s.push(TOKEN_REL + 1);
			let err = recv_err(kind, &s);
			assert_eq!(err.message.as_deref(), Some("invalid token number in compressed stream"));
			// A run that would overflow.
			let mut s = vec![TOKENRUN_LONG];
			s.extend_from_slice(&(MAX_TOKEN_INDEX - 1).to_le_bytes());
			s.extend_from_slice(&[2, 0]);
			assert_eq!(recv_err(kind, &s).code, exit::RERR_PROTOCOL);
			// Truncated frame.
			let err = recv_err(kind, &[DEFLATED_DATA | 0x3f, 0xff, 1, 2, 3]);
			assert_ne!(err.code, exit::RERR_OK);
		}
		// Garbage compressed data.
		let mut s = vec![DEFLATED_DATA, 8];
		s.extend_from_slice(&[0xff; 8]);
		s.push(END_FLAG);
		for kind in [Compress::Zlib, Compress::Zstd, Compress::Lz4] {
			assert_eq!(recv_err(kind, &s).code, exit::RERR_STREAMIO, "{kind:?}");
		}
		// Plain stream cut short.
		let mut s = 10i32.to_le_bytes().to_vec();
		s.extend_from_slice(b"abc");
		assert_ne!(recv_err(Compress::None, &s).code, exit::RERR_OK);
	}

	#[test]
	fn lz4_empty_frame_is_not_end_of_file() {
		let mut s = vec![DEFLATED_DATA, 1, 0];
		s.extend_from_slice(&[DEFLATED_DATA, 3, 0x20, b'h', b'i']);
		s.push(END_FLAG);
		let mut decoder = TokenDecoder::new(Compress::Lz4);
		let mut r = s.as_slice();
		assert_eq!(decoder.recv(&mut r).unwrap(), Token::Literal(&b"hi"[..]));
		assert_eq!(decoder.recv(&mut r).unwrap(), Token::End);
	}

	#[test]
	fn compress_names_and_lists() {
		assert_eq!(compress_list(None, false).join(" "), "zstd lz4 zlibx zlib");
		assert_eq!(compress_list(None, true).join(" "), "zstd lz4 zlibx zlib none");
		assert_eq!(compress_list(Some("none&"), false), ["none"]);
		assert_eq!(compress_list(Some("zlib&zstd lz4 zlibx none zlib"), true).len(), 5);
		assert_eq!(Compress::from_name("ZSTD"), Some(Compress::Zstd));
		assert_eq!(Compress::from_name("xxh64"), None);
		assert_eq!(parse_compress_choice("auto"), Ok(None));
		assert_eq!(parse_compress_choice("Lz4"), Ok(Some(Compress::Lz4)));
		assert_eq!(parse_compress_choice("").unwrap_err(), "unknown compress name: ");
		assert_eq!(parse_compress_choice("foo").unwrap_err(), "unknown compress name: foo");
		let server = compress_list(None, true);
		let client = compress_list(None, false);
		assert_eq!(
			crate::rsync::checksum::pick(&client, server.join(" ").as_bytes(), false).as_deref(),
			Some("zstd")
		);
		// The fifth entry of a five-name list can never be chosen (upstream quirk).
		assert_eq!(crate::rsync::checksum::pick(&server, b"none", true), None);
		let reordered = compress_list(Some("x&zstd lz4 zlibx none zlib"), true);
		assert_eq!(crate::rsync::checksum::pick(&reordered, b"zlib", true), None);
		assert_eq!(crate::rsync::checksum::pick(&["none"], server.join(" ").as_bytes(), false).as_deref(), Some("none"));
		assert!(compress_env_allows(Some("zlib&zstd"), Compress::Zstd));
		assert!(!compress_env_allows(Some("zstd&zlib"), Compress::Zstd));
		assert!(compress_env_allows(None, Compress::Lz4));
	}

	#[test]
	fn compression_levels_match_reference() {
		let cases: [(Option<i32>, [Option<i32>; 4]); 9] = [
			(None, [Some(6), Some(6), Some(3), Some(0)]),
			(Some(-1), [Some(6), Some(6), Some(-1), Some(0)]),
			(Some(0), [None, None, Some(3), Some(0)]),
			(Some(1), [Some(1), Some(1), Some(1), Some(0)]),
			(Some(9), [Some(9), Some(9), Some(9), Some(0)]),
			(Some(10), [Some(9), Some(9), Some(10), Some(0)]),
			(Some(-5), [Some(1), Some(1), Some(-5), Some(0)]),
			(Some(23), [Some(9), Some(9), Some(22), Some(0)]),
			(Some(100), [Some(9), Some(9), Some(22), Some(0)]),
		];
		for (requested, want) in cases {
			let got = [Compress::Zlib, Compress::Zlibx, Compress::Zstd, Compress::Lz4]
				.map(|kind| kind.effective_level(requested));
			assert_eq!(got, want, "level {requested:?}");
		}
		assert_eq!(Compress::None.effective_level(Some(5)), None);
	}

	#[test]
	fn skip_compress_lists() {
		let default = SkipCompress::new(None);
		assert!(default.skips(b"dir/photo.JPG"));
		assert!(default.skips(b"a.tar.gz"));
		assert!(default.skips(b"x.squashfs"));
		assert!(!default.skips(b"notes.txt"));
		assert!(!default.skips(b".gz"));
		assert!(!default.skips(b"dir.gz/file"));
		assert!(!default.skips(b"gz"));
		assert!(!default.skips(b"file."));

		let custom = SkipCompress::new(Some("GZ/jpg/mp[34]/7z//bz2"));
		for name in [&b"a.gz"[..], b"b.mp3", b"c.MP4", b"d.7z", b"e.bz2", b"f.jpg"] {
			assert!(custom.skips(name), "{}", String::from_utf8_lossy(name));
		}
		assert!(!custom.skips(b"g.mp5"));
		assert!(!custom.skips(b"h.png"));
		// One-character classes are literal; "[]" matches nothing; "[x" is literal.
		let odd = SkipCompress::new(Some("[a]/b[]c/[x/q[rs]t[uv]"));
		assert!(odd.skips(b"f.[a]"));
		assert!(!odd.skips(b"f.a"));
		assert!(!odd.skips(b"f.bc"));
		assert!(odd.skips(b"f.[x"));
		for name in [&b"f.qrtu"[..], b"f.qrtv", b"f.qstu", b"f.qstv"] {
			assert!(odd.skips(name));
		}
		// Entries are cut at 32 characters.
		let long = SkipCompress::new(Some(&"a".repeat(40)));
		assert!(long.skips(format!("f.{}", "a".repeat(32)).as_bytes()));
		assert!(!long.skips(format!("f.{}", "a".repeat(40)).as_bytes()));
		assert!(!SkipCompress::new(Some("")).skips(b"a.gz"));
	}
}
