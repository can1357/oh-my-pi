//! Rolling and strong checksums, sum headers, and checksum-name negotiation.
//!
//! Everything here is wire-visible: the rolling checksum and every strong
//! digest must produce exactly the bytes rsync 3.5.1 produces for the same
//! algorithm, seed and protocol, including the quirks of the legacy MD4
//! variants that pre-3.0 peers used.

use std::io::{self, Read, Write};

use md5::{Digest, Md5};
use sha1::Sha1;
use xxhash_rust::{
	xxh3::{Xxh3Default, xxh3_64_with_seed, xxh3_128_with_seed},
	xxh64::{Xxh64, xxh64},
};

use crate::rsync::{
	cstr::is_c_space,
	consts,
	exit::{self, RsyncError},
	log::Role,
	wire::{Proto, ReadExt, WriteExt},
};

/// Bias of the strong-sum length heuristic (`BLOCKSUM_BIAS`).
const BLOCKSUM_BIAS: i32 = 10;

/// The longest digest any [`CsumType`] produces.
pub(crate) const MAX_CSUM_LEN: usize = 20;

/// Strong-checksum algorithms (upstream CSUM_* + names used in negotiation).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CsumType {
	None,
	/// MD4 as used before protocol 21 (no final padding for 64-byte multiples).
	Md4Archaic,
	/// MD4 as used by protocols 21–26 (same padding bug as archaic).
	Md4Busted,
	/// MD4 for protocols 27–29: correct digest, seed mixed into file sums.
	Md4Old,
	Md4,
	Md5,
	Sha1,
	Xxh64,
	Xxh3,
	Xxh128,
}

impl CsumType {
	/// Digest length in bytes (`csum_len_for_type(type, 0)`).
	pub(crate) const fn digest_len(self) -> usize {
		match self {
			Self::None => 1,
			Self::Md4Archaic | Self::Md4Busted | Self::Md4Old | Self::Md4 | Self::Md5 => 16,
			Self::Sha1 => 20,
			Self::Xxh64 | Self::Xxh3 => 8,
			Self::Xxh128 => 16,
		}
	}

	/// Length of the file-list checksum (`csum_len_for_type(type, 1)`): the archaic
	/// MD4 variant only ever sent 2 bytes there.
	pub(crate) const fn flist_len(self) -> usize {
		match self {
			Self::Md4Archaic => 2,
			other => other.digest_len(),
		}
	}

	/// Negotiation name (the legacy MD4 variants all call themselves "md4").
	pub(crate) fn name(self) -> &'static str {
		match self {
			Self::None => "none",
			Self::Md4Archaic | Self::Md4Busted | Self::Md4Old | Self::Md4 => "md4",
			Self::Md5 => "md5",
			Self::Sha1 => "sha1",
			Self::Xxh64 => "xxh64",
			Self::Xxh3 => "xxh3",
			Self::Xxh128 => "xxh128",
		}
	}

	/// Case-insensitive lookup of a checksum name (including the "xxhash" alias).
	pub(crate) fn from_name(name: &str) -> Option<Self> {
		CHECKSUM_NAMES.lookup(name.as_bytes()).and_then(|entry| Self::from_num(entry.num))
	}

	/// Pre-negotiation default for a protocol version (and whether a seed fix applies).
	///
	/// Protocol 30+ uses MD5; whether its block sums put the seed first or last is
	/// decided by [`Proto::has`]`(CF_CHKSUM_SEED_FIX)` when hashing (see [`Strong`]).
	pub(crate) fn default_for(proto: Proto) -> Self {
		match proto.version {
			30.. => Self::Md5,
			27..=29 => Self::Md4Old,
			21..=26 => Self::Md4Busted,
			_ => Self::Md4Archaic,
		}
	}

	/// Upstream's CSUM_* number (the negotiation table key).
	const fn num(self) -> u8 {
		match self {
			Self::None => 0,
			Self::Md4Archaic => 1,
			Self::Md4Busted => 2,
			Self::Md4Old => 3,
			Self::Md4 => 4,
			Self::Md5 => 5,
			Self::Xxh64 => 6,
			Self::Xxh3 => 7,
			Self::Xxh128 => 8,
			Self::Sha1 => 9,
		}
	}

	const fn from_num(num: u8) -> Option<Self> {
		Some(match num {
			0 => Self::None,
			1 => Self::Md4Archaic,
			2 => Self::Md4Busted,
			3 => Self::Md4Old,
			4 => Self::Md4,
			5 => Self::Md5,
			6 => Self::Xxh64,
			7 => Self::Xxh3,
			8 => Self::Xxh128,
			9 => Self::Sha1,
			_ => return None,
		})
	}
}

/// `--checksum-choice` / RSYNC_CHECKSUM_LIST parsing and the negotiation string.
///
/// `None` for a half means "auto": negotiate (or use the protocol default).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ChecksumChoice {
	pub xfer: Option<CsumType>,
	pub file: Option<CsumType>,
}

impl ChecksumChoice {
	/// Parses `--checksum-choice=STR` (`NAME`, `XFER,FILE`, `auto`).
	///
	/// The error is upstream's message without its newline (`unknown checksum
	/// name: …`); upstream reports it with RERR_UNSUPPORTED at checksum.c(157).
	/// Like upstream, an unknown first half echoes the whole remaining argument.
	pub(crate) fn parse(arg: &str) -> Result<Self, String> {
		let unknown = |shown: &str| format!("unknown checksum name: {shown}");
		let one = |name: &str, shown: &str| -> Result<Option<CsumType>, String> {
			if name.eq_ignore_ascii_case("auto") {
				return Ok(None);
			}
			CsumType::from_name(name).map(Some).ok_or_else(|| unknown(shown))
		};
		match arg.split_once(',') {
			Some((xfer, file)) => Ok(Self { xfer: one(xfer, arg)?, file: one(file, file)? }),
			None => {
				let kind = one(arg, arg)?;
				Ok(Self { xfer: kind, file: kind })
			},
		}
	}

	/// Both halves after "auto" resolution for the negotiated protocol (when no
	/// negotiation took place).
	pub(crate) fn resolve(self, proto: Proto) -> (CsumType, CsumType) {
		let auto = CsumType::default_for(proto);
		(self.xfer.unwrap_or(auto), self.file.unwrap_or(auto))
	}
}

/// One negotiable algorithm name (upstream `name_num_item`).
pub(crate) struct NameNum {
	/// Name as it may appear on the wire or in an env list.
	pub name: &'static str,
	/// Canonical name this entry stands for (differs for aliases such as "xxhash").
	pub main: &'static str,
	/// Upstream algorithm number (CSUM_* / CPRES_*).
	pub num: u8,
}

/// A negotiation table (upstream `name_num_obj`), strongest first.
pub(crate) struct NameTable {
	/// Names in preference order, aliases after their main entry.
	pub entries: &'static [NameNum],
}

/// The checksum negotiation table of a build with xxhash, xxh3 and openssl.
pub(crate) static CHECKSUM_NAMES: NameTable = NameTable {
	entries: &[
		NameNum { name: "xxh128", main: "xxh128", num: 8 },
		NameNum { name: "xxh3", main: "xxh3", num: 7 },
		NameNum { name: "xxh64", main: "xxh64", num: 6 },
		NameNum { name: "xxhash", main: "xxh64", num: 6 },
		NameNum { name: "md5", main: "md5", num: 5 },
		NameNum { name: "md4", main: "md4", num: 4 },
		NameNum { name: "sha1", main: "sha1", num: 9 },
		NameNum { name: "none", main: "none", num: 0 },
	],
};

impl NameTable {
	/// Case-insensitive exact-length name lookup (`get_nni_by_name`).
	pub(crate) fn lookup(&self, name: &[u8]) -> Option<&'static NameNum> {
		self.entries.iter().find(|e| e.name.as_bytes().eq_ignore_ascii_case(name))
	}

	/// Size of the rank array: one past the largest algorithm number. A rank equal
	/// to this value can never win a negotiation (an upstream quirk that makes the
	/// fifth entry of a compress list unselectable).
	fn saw_len(&self) -> usize {
		self.entries.iter().map(|e| usize::from(e.num) + 1).max().unwrap_or(0)
	}

	/// The built-in list (`get_default_nno_list`): aliases dropped, and "none"
	/// omitted unless we are the server.
	pub(crate) fn default_list(&self, am_server: bool) -> Vec<&'static str> {
		self.entries
			.iter()
			.filter(|e| e.name == e.main && (am_server || e.num != 0))
			.map(|e| e.name)
			.collect()
	}

	/// Simplifies a user list (`parse_nni_str`): whitespace-separated, stops at '&',
	/// unknown names and duplicates dropped, aliases canonicalized. A list that named
	/// something but kept nothing becomes `["INVALID"]`.
	pub(crate) fn parse_list(&self, list: &str) -> Vec<&'static str> {
		let list = list.as_bytes();
		let list = &list[..memchr::memchr(b'&', list).unwrap_or(list.len())];
		let mut seen = [false; 256];
		let mut out = Vec::new();
		let mut saw_token = false;
		for token in list.split(|&b| is_c_space(b)).filter(|t| !t.is_empty()) {
			saw_token = true;
			if let Some(entry) = self.lookup(token)
				&& !seen[usize::from(entry.num)]
			{
				seen[usize::from(entry.num)] = true;
				out.push(entry.main);
			}
		}
		if saw_token && out.is_empty() {
			out.push("INVALID");
		}
		out
	}

	/// The list we send (`send_negotiate_str`): the env override when it yields a
	/// non-empty list, else the built-in default. On the server only the text after
	/// the first '&' of the env value counts; on the client the text before it.
	pub(crate) fn list(&self, env_override: Option<&str>, am_server: bool) -> Vec<&'static str> {
		if let Some(env) = env_override.map(|env| server_part(env, am_server))
			&& !env.is_empty()
		{
			let parsed = self.parse_list(env);
			if !parsed.is_empty() {
				return parsed;
			}
		}
		self.default_list(am_server)
	}

	/// 1-based preference ranks of `ours`, indexed by algorithm number.
	fn ranks(&self, ours: &[&str]) -> [u8; 256] {
		let mut saw = [0u8; 256];
		let mut cnt = 0u8;
		for name in ours {
			if let Some(entry) = self.lookup(name.as_bytes())
				&& saw[usize::from(entry.num)] == 0
			{
				cnt = cnt.saturating_add(1);
				saw[usize::from(entry.num)] = cnt;
			}
		}
		saw
	}

	/// Our most preferred name that the peer listed (`parse_negotiate_str`).
	pub(crate) fn pick(&self, ours: &[&str], theirs: &[u8]) -> Option<&'static str> {
		let saw = self.ranks(ours);
		let mut best = self.saw_len();
		let mut chosen = None;
		for token in theirs.split(|&b| b == b' ').filter(|t| !t.is_empty()) {
			let Some(entry) = self.lookup(token) else { continue };
			let rank = usize::from(saw[usize::from(entry.num)]);
			if rank == 0 || best <= rank {
				continue;
			}
			best = rank;
			chosen = Some(entry.main);
			if best == 1 {
				break;
			}
		}
		chosen
	}

	/// Server-side check that an explicit choice is in the env list
	/// (`validate_choice_vs_env`); `nums` are the chosen algorithm numbers and
	/// `md4_family` lets "md4" admit the legacy MD4 variants.
	pub(crate) fn env_allows(&self, env_override: Option<&str>, nums: &[u8], md4_family: bool) -> bool {
		let Some(env) = env_override else { return true };
		let env = server_part(env, true).trim_start_matches(|c: char| c.is_ascii() && is_c_space(c as u8));
		if env.is_empty() {
			return true;
		}
		let parsed = self.parse_list(env);
		let mut saw = self.ranks(&parsed);
		if md4_family {
			let md4 = saw[usize::from(CsumType::Md4.num())];
			for kind in [CsumType::Md4Archaic, CsumType::Md4Busted, CsumType::Md4Old] {
				saw[usize::from(kind.num())] = md4;
			}
		}
		nums.iter().all(|&n| saw[usize::from(n)] != 0)
	}
}

/// The part of an RSYNC_*_LIST value a role uses: after the first '&' on the server.
fn server_part(env: &str, am_server: bool) -> &str {
	match env.split_once('&') {
		Some((_, after)) if am_server => after,
		_ => env,
	}
}

/// Our preference list as sent in negotiation (env override aware).
///
/// `am_server` matters: the client omits "none" from its default list and reads
/// the env value before '&'; the server reads it after '&'. When writing a batch
/// file the caller passes upstream's forced list ("md5", or "md4" before protocol
/// 30) as `env_override`.
pub(crate) fn checksum_list(env_override: Option<&str>, am_server: bool) -> Vec<&'static str> {
	CHECKSUM_NAMES.list(env_override, am_server)
}

/// Picks the negotiated algorithm exactly like upstream (`negotiate_the_strings`).
///
/// Works for both checksum and compression lists: each side independently takes
/// its own most-preferred name that also appears in the peer's list. Returns the
/// canonical name. `we_are_server` does not change the choice (it only affects
/// which side reports a failure, see [`negotiate_failure`]).
pub(crate) fn pick(ours: &[&str], theirs: &[u8], _we_are_server: bool) -> Option<String> {
	table_for(ours).pick(ours, theirs).map(str::to_owned)
}

/// The table `ours` was drawn from (compression names other than "none" are
/// never checksum names).
fn table_for(ours: &[&str]) -> &'static NameTable {
	let compress = &crate::rsync::token::COMPRESS_NAMES;
	let is_compress = ours.iter().any(|name| {
		compress.lookup(name.as_bytes()).is_some() && CHECKSUM_NAMES.lookup(name.as_bytes()).is_none()
	});
	if is_compress { compress } else { &CHECKSUM_NAMES }
}

/// Failure of a negotiation (`recv_negotiate_str`): RERR_UNSUPPORTED at
/// compat.c(406). `what` is "checksum" or "compress"; `theirs` is the list as
/// received. A server in a negotiating session exits without a message.
pub(crate) fn negotiate_failure(
	what: &str,
	ours: &[&str],
	theirs: &[u8],
	am_server: bool,
	negotiated_strings: bool,
) -> RsyncError {
	let message = (!am_server || !negotiated_strings).then(|| {
		let (peer, us) = if am_server { ("Client", "Server") } else { ("Server", "Client") };
		let table = table_for(ours);
		let mut mine: String = ours
			.iter()
			.filter_map(|name| table.lookup(name.as_bytes()))
			.map(|entry| format!(" {}", entry.main))
			.collect();
		if mine.is_empty() {
			mine.push_str(" INVALID");
		}
		format!(
			"Failed to negotiate a {what} choice.\n{peer} list: {}\n{us} list:{mine}",
			String::from_utf8_lossy(theirs)
		)
	});
	let mut err = RsyncError::new(exit::RERR_UNSUPPORTED, String::new()).at("compat.c", 406);
	err.message = message;
	err
}

/// Server-side `--checksum-choice` check against RSYNC_CHECKSUM_LIST (the part
/// after '&'): listing "md4" also admits the legacy MD4 variants.
pub(crate) fn checksum_env_allows(env_override: Option<&str>, xfer: CsumType, file: CsumType) -> bool {
	CHECKSUM_NAMES.env_allows(env_override, &[xfer.num(), file.num()], true)
}

/// "Your --<what>-choice value (<choice>) was refused by the server."
/// (RERR_UNSUPPORTED at compat.c(450)).
pub(crate) fn choice_refused(what: &str, choice: &str) -> RsyncError {
	RsyncError::new(
		exit::RERR_UNSUPPORTED,
		format!("Your --{what}-choice value ({choice}) was refused by the server."),
	)
	.at("compat.c", 450)
}

/// Upstream get_checksum1 (CHAR_OFFSET 0): bytes are summed as signed chars.
pub(crate) fn checksum1(buf: &[u8]) -> u32 {
	let (s1, s2) = sums(buf);
	(s1 & 0xffff) | (s2 << 16)
}

fn sums(buf: &[u8]) -> (u32, u32) {
	let mut s1: u32 = 0;
	let mut s2: u32 = 0;
	for &b in buf {
		s1 = s1.wrapping_add(signed(b));
		s2 = s2.wrapping_add(s1);
	}
	(s1, s2)
}

/// A byte as the C `schar` value, widened modulo 2^32.
const fn signed(b: u8) -> u32 {
	b as i8 as i32 as u32
}

/// Rolling form of checksum1 over a sliding window.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Rolling {
	s1: u32,
	s2: u32,
	len: u32,
}

impl Rolling {
	/// Checksum of `window`, ready to slide.
	pub(crate) fn new(window: &[u8]) -> Self {
		let (s1, s2) = sums(window);
		Self { s1, s2, len: u32::try_from(window.len()).unwrap_or(u32::MAX) }
	}

	/// Slides the window one byte: drops `out` (the first byte), appends `inp`.
	pub(crate) fn roll(&mut self, out: u8, inp: u8) {
		let out = signed(out);
		self.s1 = self.s1.wrapping_sub(out).wrapping_add(signed(inp));
		self.s2 = self.s2.wrapping_sub(self.len.wrapping_mul(out)).wrapping_add(self.s1);
	}

	/// Drops the first byte without appending (the window shrinks at EOF).
	pub(crate) fn rollout(&mut self, out: u8) {
		let out = signed(out);
		self.s1 = self.s1.wrapping_sub(out);
		self.s2 = self.s2.wrapping_sub(self.len.wrapping_mul(out));
		self.len = self.len.saturating_sub(1);
	}

	/// Current checksum1 value.
	pub(crate) fn value(&self) -> u32 {
		(self.s1 & 0xffff) | (self.s2 << 16)
	}
}

/// MD4 (RFC 1320) with the hooks rsync's legacy variants need: an unpadded
/// result for 64-byte-aligned input and a 32-bit bit count before protocol 27.
#[derive(Clone)]
struct Md4 {
	state: [u32; 4],
	block: [u8; 64],
	filled: usize,
	total: u64,
	short_bit_count: bool,
}

impl Md4 {
	fn new(proto_version: u32) -> Self {
		Self {
			state: [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476],
			block: [0; 64],
			filled: 0,
			total: 0,
			short_bit_count: proto_version < 27,
		}
	}

	fn update(&mut self, mut data: &[u8]) {
		self.total = self.total.wrapping_add(data.len() as u64);
		if self.filled > 0 {
			let take = (64 - self.filled).min(data.len());
			self.block[self.filled..self.filled + take].copy_from_slice(&data[..take]);
			self.filled += take;
			data = &data[take..];
			if self.filled < 64 {
				return;
			}
			let block = self.block;
			md4_compress(&mut self.state, &block);
			self.filled = 0;
		}
		let (blocks, rest) = data.as_chunks::<64>();
		for block in blocks {
			md4_compress(&mut self.state, block);
		}
		self.block[..rest.len()].copy_from_slice(rest);
		self.filled = rest.len();
	}

	/// The digest. With `legacy_tail` set, input that ended on a 64-byte boundary
	/// is not padded at all (the pre-protocol-27 bug).
	fn finish(mut self, legacy_tail: bool) -> [u8; 16] {
		if !(legacy_tail && self.filled == 0) {
			let mut bits = self.total.wrapping_mul(8);
			if self.short_bit_count {
				bits &= 0xffff_ffff;
			}
			let mut pad = [0u8; 72];
			pad[0] = 0x80;
			let pad_len = if self.filled < 56 { 56 - self.filled } else { 120 - self.filled };
			pad[pad_len..pad_len + 8].copy_from_slice(&bits.to_le_bytes());
			self.update(&pad[..pad_len + 8]);
		}
		let mut out = [0u8; 16];
		for (dst, word) in out.as_chunks_mut::<4>().0.iter_mut().zip(self.state) {
			*dst = word.to_le_bytes();
		}
		out
	}
}

fn md4_compress(state: &mut [u32; 4], block: &[u8; 64]) {
	let mut x = [0u32; 16];
	for (word, &bytes) in x.iter_mut().zip(block.as_chunks::<4>().0) {
		*word = u32::from_le_bytes(bytes);
	}
	let [mut a, mut b, mut c, mut d] = *state;
	const ROUND2: u32 = 0x5a82_7999;
	const ROUND3: u32 = 0x6ed9_eba1;
	const ORDER3: [usize; 16] = [0, 8, 4, 12, 2, 10, 6, 14, 1, 9, 5, 13, 3, 11, 7, 15];
	for i in 0..16 {
		let f = (b & c) | (!b & d);
		let t = a.wrapping_add(f).wrapping_add(x[i]).rotate_left([3, 7, 11, 19][i % 4]);
		(a, b, c, d) = (d, t, b, c);
	}
	for i in 0..16 {
		let g = (b & c) | (b & d) | (c & d);
		let k = (i % 4) * 4 + i / 4;
		let t = a.wrapping_add(g).wrapping_add(x[k]).wrapping_add(ROUND2).rotate_left([3, 5, 9, 13][i % 4]);
		(a, b, c, d) = (d, t, b, c);
	}
	for i in 0..16 {
		let h = b ^ c ^ d;
		let t = a
			.wrapping_add(h)
			.wrapping_add(x[ORDER3[i]])
			.wrapping_add(ROUND3)
			.rotate_left([3, 9, 11, 15][i % 4]);
		(a, b, c, d) = (d, t, b, c);
	}
	state[0] = state[0].wrapping_add(a);
	state[1] = state[1].wrapping_add(b);
	state[2] = state[2].wrapping_add(c);
	state[3] = state[3].wrapping_add(d);
}

/// Block (get_checksum2) and whole-file (sum_init/update/end) digests.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Strong {
	pub kind: CsumType,
	pub seed: i32,
	pub proto: Proto,
}

impl Strong {
	/// Strong sum of one block; full `digest_len`, callers truncate to s2length.
	pub(crate) fn block(&self, data: &[u8]) -> Vec<u8> {
		let mut out = [0u8; MAX_CSUM_LEN];
		let len = self.block_into(data, &mut out);
		out[..len].to_vec()
	}

	/// Allocation-free [`Strong::block`]: writes the digest into the front of
	/// `out` and returns its length.
	pub(crate) fn block_into(&self, data: &[u8], out: &mut [u8; MAX_CSUM_LEN]) -> usize {
		let seed = self.seed.to_le_bytes();
		let seeded = self.seed != 0;
		let xxh_seed = i64::from(self.seed) as u64;
		match self.kind {
			CsumType::None => out[0] = 0,
			CsumType::Xxh64 => out[..8].copy_from_slice(&xxh64(data, xxh_seed).to_le_bytes()),
			CsumType::Xxh3 => {
				out[..8].copy_from_slice(&xxh3_64_with_seed(data, xxh_seed).to_le_bytes());
			},
			CsumType::Xxh128 => {
				out[..16].copy_from_slice(&xxh3_128_with_seed(data, xxh_seed).to_le_bytes());
			},
			CsumType::Md5 => {
				// The seed goes first unless a protocol-30+ peer lacks the seed-order fix.
				let seed_first =
					self.proto.version < 30 || self.proto.has(consts::CF_CHKSUM_SEED_FIX);
				let mut md = Md5::new();
				if seeded && seed_first {
					md.update(seed);
				}
				md.update(data);
				if seeded && !seed_first {
					md.update(seed);
				}
				out[..16].copy_from_slice(&md.finalize());
			},
			CsumType::Sha1 => {
				let mut sha = Sha1::new();
				if seeded {
					sha.update(seed);
				}
				sha.update(data);
				out[..20].copy_from_slice(&sha.finalize());
			},
			CsumType::Md4 | CsumType::Md4Old | CsumType::Md4Busted | CsumType::Md4Archaic => {
				let mut md = Md4::new(self.proto.version);
				md.update(data);
				if seeded {
					md.update(&seed);
				}
				out[..16].copy_from_slice(&md.finish(legacy_md4_tail(self.kind)));
			},
		}
		self.kind.digest_len()
	}

	/// Whole-file digest accumulator seeded like upstream's sum_init: only the
	/// legacy MD4 variants mix the seed in (always, even a zero seed).
	pub(crate) fn file(&self) -> FileDigest {
		let mut digest = FileDigest::new(self.kind, self.proto);
		if matches!(self.kind, CsumType::Md4Old | CsumType::Md4Busted | CsumType::Md4Archaic) {
			digest.update(&self.seed.to_le_bytes());
		}
		digest
	}
}

/// Whether an MD4 variant skips padding for 64-byte-aligned input.
const fn legacy_md4_tail(kind: CsumType) -> bool {
	matches!(kind, CsumType::Md4Busted | CsumType::Md4Archaic)
}

/// A running whole-file digest.
pub(crate) struct FileDigest {
	kind: CsumType,
	state: DigestState,
}

enum DigestState {
	None,
	Md4(Md4),
	Md5(Md5),
	Sha1(Sha1),
	Xxh64(Xxh64),
	Xxh3(Box<Xxh3Default>),
}

impl FileDigest {
	/// An unseeded accumulator.
	fn new(kind: CsumType, proto: Proto) -> Self {
		let state = match kind {
			CsumType::None => DigestState::None,
			CsumType::Md4 | CsumType::Md4Old | CsumType::Md4Busted | CsumType::Md4Archaic => {
				DigestState::Md4(Md4::new(proto.version))
			},
			CsumType::Md5 => DigestState::Md5(Md5::new()),
			CsumType::Sha1 => DigestState::Sha1(Sha1::new()),
			CsumType::Xxh64 => DigestState::Xxh64(Xxh64::new(0)),
			CsumType::Xxh3 | CsumType::Xxh128 => DigestState::Xxh3(Box::new(Xxh3Default::new())),
		};
		Self { kind, state }
	}

	/// Feeds data (sum_update).
	pub(crate) fn update(&mut self, data: &[u8]) {
		match &mut self.state {
			DigestState::None => {},
			DigestState::Md4(md) => md.update(data),
			DigestState::Md5(md) => md.update(data),
			DigestState::Sha1(sha) => sha.update(data),
			DigestState::Xxh64(xxh) => xxh.update(data),
			DigestState::Xxh3(xxh) => xxh.update(data),
		}
	}

	/// The digest (sum_end), `kind.digest_len()` bytes.
	pub(crate) fn finish(self) -> Vec<u8> {
		match self.state {
			DigestState::None => vec![0],
			DigestState::Md4(md) => md.finish(legacy_md4_tail(self.kind)).to_vec(),
			DigestState::Md5(md) => md.finalize().to_vec(),
			DigestState::Sha1(sha) => sha.finalize().to_vec(),
			DigestState::Xxh64(xxh) => xxh.digest().to_le_bytes().to_vec(),
			DigestState::Xxh3(xxh) if self.kind == CsumType::Xxh128 => {
				xxh.digest128().to_le_bytes().to_vec()
			},
			DigestState::Xxh3(xxh) => xxh.digest().to_le_bytes().to_vec(),
		}
	}
}

/// Whole-file checksum of a local file for `--checksum` (file_checksum).
///
/// Upstream never seeds these digests, so `_seed` is unused; the legacy MD4
/// variants keep their aligned-input padding quirk. Reads `reader` to EOF.
pub(crate) fn file_checksum(
	kind: CsumType,
	_seed: i32,
	proto: Proto,
	reader: &mut dyn Read,
) -> io::Result<Vec<u8>> {
	let mut digest = FileDigest::new(kind, proto);
	let mut buf = [0u8; 32 * 1024];
	loop {
		match reader.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => digest.update(&buf[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
	Ok(digest.finish())
}

/// The sum header (count, block length, strong length, remainder).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct SumHead {
	pub count: i32,
	pub blength: i32,
	pub s2length: i32,
	pub remainder: i32,
}

impl SumHead {
	/// Upstream sum_sizes_sqroot sizing for a basis of `len` bytes (first pass,
	/// short strong sums). `count == -1` means the length cannot be described.
	/// The generator sizes with [`SumHead::sized`]; this first-pass form serves tests.
	#[cfg(test)]
	pub(crate) fn for_len(len: i64, block_size_opt: u32, proto: Proto, xfer_sum_len: usize) -> Self {
		Self::sized(len, block_size_opt, proto, xfer_sum_len, consts::SHORT_SUM_LENGTH as i32)
	}

	/// sum_sizes_sqroot with an explicit `csum_length` (SUM_LENGTH in the redo pass).
	pub(crate) fn sized(
		len: i64,
		block_size_opt: u32,
		proto: Proto,
		xfer_sum_len: usize,
		csum_length: i32,
	) -> Self {
		if len < 0 {
			return Self { count: -1, ..Self::default() };
		}
		let sum_length = consts::SUM_LENGTH as i32;
		let max_s2length = sum_length.min(i32::try_from(xfer_sum_len).unwrap_or(i32::MAX));
		let block_size = i64::from(consts::BLOCK_SIZE);
		let blength: i64 = if block_size_opt != 0 {
			i64::from(block_size_opt)
		} else if len <= block_size * block_size {
			block_size
		} else {
			let max_blength = max_block_len(proto);
			let mut c: i64 = 1;
			let mut l = len >> 2;
			while l != 0 {
				c <<= 1;
				l >>= 2;
			}
			if c >= max_blength {
				max_blength
			} else {
				// Largest multiple of 8 whose square does not exceed len.
				let mut b: i64 = 0;
				while c >= 8 {
					b |= c;
					if len < b * b {
						b &= !c;
					}
					c >>= 1;
				}
				b.max(block_size)
			}
		};

		let s2length = if csum_length == sum_length {
			max_s2length
		} else {
			let mut bits = BLOCKSUM_BIAS;
			let mut l = len >> 1;
			while l != 0 {
				bits += 2;
				l >>= 1;
			}
			let mut c = blength >> 1;
			while c != 0 && bits != 0 {
				bits -= 1;
				c >>= 1;
			}
			// Add a bit, subtract the 32 rolling-sum bits, round up to bytes.
			((bits + 1 - 32 + 7) / 8).max(csum_length).min(max_s2length)
		};

		let remainder = len % blength;
		let count = len / blength + i64::from(remainder != 0);
		Self {
			count: i32::try_from(count).unwrap_or(-1),
			blength: i32::try_from(blength).unwrap_or(i32::MAX),
			s2length,
			remainder: remainder as i32,
		}
	}

	/// Length of block `index` (the last one may be the remainder).
	pub(crate) fn block_len(&self, index: i32) -> i32 {
		if index == self.count - 1 && self.remainder != 0 { self.remainder } else { self.blength }
	}

	/// Total file length these sums describe.
	pub(crate) fn flength(&self) -> i64 {
		if self.count <= 0 {
			return 0;
		}
		let full = i64::from(self.count) * i64::from(self.blength);
		if self.remainder != 0 { full - i64::from(self.blength) + i64::from(self.remainder) } else { full }
	}

	/// Reads and validates a sum header (read_sum_head), reporting as the sender.
	pub(crate) fn read(r: &mut dyn Read, proto: Proto, xfer_sum_len: usize) -> Result<Self, RsyncError> {
		Self::read_as(r, proto, xfer_sum_len, Role::Sender)
	}

	/// [`SumHead::read`] with the role named in the error messages (who_am_i).
	/// Rejects negative fields, oversize block or strong lengths, a remainder
	/// beyond the block length, and a zero block length with a non-zero count
	/// (CVE-2026-53792), all with RERR_PROTOCOL.
	pub(crate) fn read_as(
		r: &mut dyn Read,
		proto: Proto,
		xfer_sum_len: usize,
		who: Role,
	) -> Result<Self, RsyncError> {
		let who = who.name();
		let fail = |message: String, line: u32| -> Result<Self, RsyncError> {
			Err(RsyncError::new(exit::RERR_PROTOCOL, message).at("io.c", line))
		};

		let count = read_i32(r)?;
		if count < 0 {
			return fail(format!("Invalid checksum count {count} [{who}]"), 2240);
		}
		let blength = read_i32(r)?;
		if blength < 0 || i64::from(blength) > max_block_len(proto) {
			return fail(format!("Invalid block length {blength} [{who}]"), 2261);
		}
		if count != 0 && blength == 0 {
			return fail(format!("Invalid zero block length [{who}]"), 2266);
		}
		let s2length = read_i32(r)?;
		if s2length < 0 || s2length as usize > xfer_sum_len {
			return fail(format!("Invalid checksum length {s2length} [{who}]"), 2282);
		}
		let remainder = read_i32(r)?;
		if remainder < 0 || remainder > blength {
			return fail(format!("Invalid remainder length {remainder} [{who}]"), 2288);
		}
		Ok(Self { count, blength, s2length, remainder })
	}

	/// write_sum_head (protocol 27+ layout; older protocols are refused earlier).
	pub(crate) fn write(&self, w: &mut dyn Write, _proto: Proto) -> io::Result<()> {
		w.write_int(self.count)?;
		w.write_int(self.blength)?;
		w.write_int(self.s2length)?;
		w.write_int(self.remainder)
	}
}

/// One wire `int`, with stream errors mapped like upstream's read_int.
fn read_i32(r: &mut dyn Read) -> Result<i32, RsyncError> {
	r.read_int().map_err(RsyncError::from_stream)
}

/// Largest block length a protocol allows.
fn max_block_len(proto: Proto) -> i64 {
	i64::from(if proto.version < 30 { consts::OLD_MAX_BLOCK_SIZE } else { consts::MAX_BLOCK_SIZE })
}

/// Deterministic data shared by the checksum and token tests: the same bytes the
/// reference captures were made from.
#[cfg(test)]
pub(crate) mod capture {
	/// Pseudo-random bytes: x = x*1103515245+12345, byte = x>>16.
	pub(crate) fn lcg_bytes(n: usize, seed: u32) -> Vec<u8> {
		let mut x = seed;
		(0..n)
			.map(|_| {
				x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
				(x >> 16) as u8
			})
			.collect()
	}

	/// Compressible text built from eight words with the same generator.
	pub(crate) fn lcg_text(n: usize, seed: u32) -> Vec<u8> {
		const WORDS: [&[u8]; 8] =
			[b"alpha", b"beta", b"gamma", b"delta", b"rsync", b"block", b"token", b"zlib"];
		let mut x = seed;
		let mut out = Vec::new();
		while out.len() < n {
			x = x.wrapping_mul(1_103_515_245).wrapping_add(12345);
			out.extend_from_slice(WORDS[((x >> 16) % 8) as usize]);
			out.push(b' ');
		}
		out.truncate(n);
		out
	}

	/// Basis of the token-stream capture (2228 bytes, blocks of 700).
	pub(crate) fn token_basis() -> Vec<u8> {
		[lcg_text(2100, 1), lcg_bytes(128, 2)].concat()
	}

	/// Source of the token-stream capture: matches of blocks 0, 1, 2 and the
	/// 128-byte tail, with literals that reuse block-0 text in between.
	pub(crate) fn token_source() -> Vec<u8> {
		let basis = token_basis();
		[
			&basis[..1400],
			b"LITERAL-".as_slice(),
			&basis[100..600],
			&basis[1400..2100],
			&lcg_text(900, 3),
			&basis[2100..],
		]
		.concat()
	}
}

#[cfg(test)]
mod tests {
	use super::{
		capture::{lcg_bytes, token_source},
		*,
	};

	fn p33() -> Proto {
		Proto::new(33, consts::CF_CHKSUM_SEED_FIX)
	}

	fn to_hex(b: &[u8]) -> String {
		b.iter().map(|b| format!("{b:02x}")).collect()
	}

	/// Basis blocks of the block-sum capture: 3×700 bytes + a 128-byte remainder.
	fn capture_blocks() -> Vec<Vec<u8>> {
		lcg_bytes(2228, 9).chunks(700).map(<[u8]>::to_vec).collect()
	}

	/// Asserts the strong sums the reference generator sent for `capture_blocks`
	/// (redo pass, full-length sums) with `--checksum-seed=seed`.
	fn check_blocks(kind: CsumType, seed: i32, p: Proto, expected: [&str; 4]) {
		let strong = Strong { kind, seed, proto: p };
		for (block, want) in capture_blocks().iter().zip(expected) {
			let got = strong.block(block);
			assert_eq!(got.len(), kind.digest_len());
			assert_eq!(to_hex(&got[..want.len() / 2]), want, "{kind:?} seed {seed}");
		}
	}

	#[test]
	fn checksum1_matches_reference_block_sums() {
		let blocks = capture_blocks();
		let want = [0x43de_f3c8, 0xf4e4_f664, 0xf007_02bb, 0xcb4a_03f4];
		for (block, want) in blocks.iter().zip(want) {
			assert_eq!(checksum1(block), want);
		}
		assert_eq!(checksum1(&[]), 0);
		// Bytes >= 0x80 count as negative (signed char).
		assert_eq!(checksum1(&[0xff]), 0xffff_ffff);
		assert_eq!(checksum1(&[0x80, 0x01]), 0xff01_ff81);
	}

	#[test]
	fn rolling_matches_recomputation_over_random_windows() {
		let data = lcg_bytes(5000, 77);
		for &window in &[1usize, 2, 3, 5, 64, 700, 1024] {
			let mut roll = Rolling::new(&data[..window]);
			assert_eq!(roll.value(), checksum1(&data[..window]));
			for start in 1..=data.len() - window {
				roll.roll(data[start - 1], data[start + window - 1]);
				assert_eq!(roll.value(), checksum1(&data[start..start + window]), "w={window} s={start}");
			}
			// Shrink at EOF.
			let mut start = data.len() - window;
			while start < data.len() {
				roll.rollout(data[start]);
				start += 1;
				assert_eq!(roll.value(), checksum1(&data[start..]));
			}
		}
	}

	#[test]
	fn md4_matches_rfc1320_vectors() {
		let cases: [(&[u8], &str); 5] = [
			(b"", "31d6cfe0d16ae931b73c59d7e0c089c0"),
			(b"abc", "a448017aaf21d8525fc10ae87aa6729d"),
			(b"message digest", "d9130a8164549fe818874806e1c7014b"),
			(b"abcdefghijklmnopqrstuvwxyz", "d79e1c308aa5bbcdeea8ed63df412da9"),
			(
				b"12345678901234567890123456789012345678901234567890123456789012345678901234567890",
				"e33b4ddc9c38f2199c3e7b164fcc0536",
			),
		];
		for (input, want) in cases {
			let mut md = Md4::new(33);
			md.update(input);
			assert_eq!(to_hex(&md.finish(false)), want);
		}
	}

	#[test]
	fn md4_block_sums_with_appended_seed_match_reference() {
		let want = [
			"99fcd2ebe8f304293ee376fa108a8b68",
			"5fac68a79a794844319fc88d1d930092",
			"883e1fe5826e8f556edbd45a8d07a583",
			"208036d57beee4ea661df5c140f6622f",
		];
		// Protocol 29 (MD4_OLD) and a negotiated "md4" at protocol 33 agree.
		check_blocks(CsumType::Md4Old, 12345, Proto::new(29, 0), want);
		check_blocks(CsumType::Md4, 12345, p33(), want);
	}

	#[test]
	fn md5_seed_order_follows_seed_fix() {
		let prepend = [
			"16cd6a4661c7f024706ff6293aa71927",
			"0bb3ac3299881e6865cfa13867afb966",
			"44924c89a448b1af9877fe437f5aac68",
			"00959c12c2042d1bd195b15b9fc4270e",
		];
		check_blocks(CsumType::Md5, 12345, p33(), prepend);
		check_blocks(CsumType::Md5, 12345, Proto::new(30, consts::CF_CHKSUM_SEED_FIX), prepend);
		// A protocol-30+ peer without CF_CHKSUM_SEED_FIX appends the seed.
		check_blocks(CsumType::Md5, 12345, Proto::new(31, 0), [
			"fdf3e18589f53e3ad9b0da9d85e78c6e",
			"b4c5290f46429da2a5429e6537c9af17",
			"3c35a6c5d8b108030187c064268345c3",
			"e63ada5849b868259611c8bf020930b0",
		]);
		check_blocks(CsumType::Md5, -5, p33(), [
			"0b642590689992228ef5e7d852fbc75e",
			"ae1b83cf5b6cdfadf56eff92e99d1b67",
			"5be32ad11ae2cf3b9f2f35fb8184f037",
			"623ca9d1a05f2cab2125c600076223a2",
		]);
	}

	#[test]
	fn sha1_and_xxhash_block_sums_match_reference() {
		check_blocks(CsumType::Sha1, 12345, p33(), [
			"88d25e30b59b8087a70fc16f0aaead3b",
			"d507756c66f4bf8aff1187cf6422c303",
			"ee175b4e846ce1be45d314bbda05c585",
			"d15d97ecdf375134180de0a2cb71f0ad",
		]);
		check_blocks(CsumType::Xxh64, 12345, p33(), [
			"bdfe4a802e6f615d",
			"aff68070da8d9816",
			"b4a144ee10b97e0f",
			"a6236604971a5222",
		]);
		check_blocks(CsumType::Xxh3, 12345, p33(), [
			"c44eddb311895746",
			"5fe7a1e08878e7f0",
			"6459d56aa2fca6c8",
			"97abb034aa4585d9",
		]);
		check_blocks(CsumType::Xxh128, 12345, p33(), [
			"c44eddb311895746202f1620da30c4e8",
			"5fe7a1e08878e7f0f2aa763632a58d83",
			"6459d56aa2fca6c893500407aa6b974c",
			"eff6d05827572ce9eb6895d8b0a65293",
		]);
		// Negative seeds are sign-extended into the 64-bit xxhash seed.
		check_blocks(CsumType::Xxh64, -5, p33(), [
			"ea9ac427b93a299b",
			"0b76b494be688699",
			"4480d855ba6d2882",
			"80824c53a095e0ed",
		]);
		check_blocks(CsumType::Xxh128, -5, p33(), [
			"79745ba2c7f8152893ef3a1ba920188a",
			"d615b808200deb16c3439e52642aba5a",
			"f9a5a3dd86f7347615a4fd8da3534767",
			"5742b3937098993de7cabecb0267a291",
		]);
	}

	#[test]
	fn legacy_md4_skips_padding_for_aligned_input() {
		let data = lcg_bytes(128, 3);
		let busted = Strong { kind: CsumType::Md4Busted, seed: 0, proto: Proto::new(26, 0) };
		let old = Strong { kind: CsumType::Md4Old, seed: 0, proto: Proto::new(29, 0) };
		// 128 bytes: busted returns the raw state after two blocks, old pads.
		let mut raw = [0x6745_2301u32, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
		for chunk in data.as_chunks::<64>().0 {
			md4_compress(&mut raw, chunk);
		}
		let raw: Vec<u8> = raw.iter().flat_map(|w| w.to_le_bytes()).collect();
		assert_eq!(busted.block(&data), raw);
		assert_ne!(old.block(&data), raw);
		// Unaligned input is padded normally by every variant.
		assert_eq!(busted.block(&data[..100]), old.block(&data[..100]));
		// Empty input: busted yields the initial state.
		assert_eq!(to_hex(&busted.block(&[])), "0123456789abcdeffedcba9876543210");
		// A seed of 60 bytes + 4 seed bytes is aligned too.
		let seeded = Strong { kind: CsumType::Md4Archaic, seed: 7, proto: Proto::new(20, 0) };
		let mut expect = [0x6745_2301u32, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];
		let mut block = [0u8; 64];
		block[..60].copy_from_slice(&data[..60]);
		block[60..].copy_from_slice(&7i32.to_le_bytes());
		md4_compress(&mut expect, &block);
		let expect: Vec<u8> = expect.iter().flat_map(|w| w.to_le_bytes()).collect();
		assert_eq!(seeded.block(&data[..60]), expect);
	}

	#[test]
	fn md4_before_protocol_27_counts_only_32_bits() {
		// The bit count only differs for inputs >= 512 MiB; check the padding block
		// directly instead: the high word of the length field must be zero.
		let mut short = Md4::new(26);
		let mut full = Md4::new(27);
		short.total = 1 << 32;
		full.total = 1 << 32;
		assert_ne!(short.finish(false), full.finish(false));
	}

	fn file_sum(kind: CsumType, seed: i32, p: Proto, data: &[u8]) -> String {
		let mut digest = Strong { kind, seed, proto: p }.file();
		for chunk in data.chunks(1000) {
			digest.update(chunk);
		}
		to_hex(&digest.finish())
	}

	#[test]
	fn transfer_file_sums_match_reference() {
		let src = token_source();
		let p = p33();
		assert_eq!(file_sum(CsumType::Md4Old, 12345, Proto::new(29, 0), &src), "4ebc81d1ed4225aad279595d15eeed7a");
		assert_eq!(file_sum(CsumType::Md5, 12345, Proto::new(30, 0), &src), "88daea5a522e3e5d07e276282f7570e6");
		assert_eq!(file_sum(CsumType::Md4, 12345, p, &src), "bad775a36e234d3b21e6b00d8af5b17c");
		assert_eq!(file_sum(CsumType::Sha1, 12345, p, &src), "1388d52c99e794807025b028c0e95f2eee75a1c3");
		assert_eq!(file_sum(CsumType::Xxh64, 12345, p, &src), "0f830ce18508eb10");
		assert_eq!(file_sum(CsumType::Xxh3, 12345, p, &src), "672b4ba4dd71ec7e");
		assert_eq!(file_sum(CsumType::Xxh128, 12345, p, &src), "672b4ba4dd71ec7effa45ed1afba4d6e");
		assert_eq!(file_sum(CsumType::None, 12345, p, &src), "00");
	}

	#[test]
	fn file_checksum_matches_reference_listing() {
		let mut big = Vec::new();
		for i in 0..100_000u32 {
			big.push(((i * 7 + 3) % 256) as u8);
		}
		let cases: [(CsumType, &[u8], &str); 10] = [
			(CsumType::Md4, b"hello world\n", "97668ab2f29d0115bd0d1161b9bec520"),
			(CsumType::Md4, &[0; 64], "2f6f7b10c5cadca6d5770f428c899ba7"),
			(CsumType::Md4, &big, "f3609f9a4fc2732b996dfc6a9abf6642"),
			(CsumType::Md5, &big, "59f08777fcd1aa2b8e0c8f892cfaae09"),
			(CsumType::Sha1, b"hello world\n", "22596363b3de40b06f981fb85d82312e8c0ed511"),
			(CsumType::Xxh64, b"hello world\n", "5215e13b207d6d8c"),
			(CsumType::Xxh3, &[], "2d06800538d394c2"),
			(CsumType::Xxh3, &big, "0c056f6fcc340974"),
			(CsumType::Xxh128, b"hello world\n", "eefac9d87100cd1336b2e733a5484425"),
			(CsumType::Xxh128, &big, "d9e155dd16e141d00c056f6fcc340974"),
		];
		for (kind, data, want) in cases {
			let mut sum = file_checksum(kind, 999, p33(), &mut &data[..]).unwrap();
			// The listing prints xxhash values most significant byte first.
			if matches!(kind, CsumType::Xxh64 | CsumType::Xxh3 | CsumType::Xxh128) {
				sum.reverse();
			}
			assert_eq!(to_hex(&sum), want, "{kind:?}");
		}
	}

	#[test]
	fn checksum_choice_parsing() {
		assert_eq!(ChecksumChoice::parse("auto").unwrap(), ChecksumChoice::default());
		assert_eq!(ChecksumChoice::parse("AUTO,auto").unwrap(), ChecksumChoice::default());
		assert_eq!(
			ChecksumChoice::parse("MD5").unwrap(),
			ChecksumChoice { xfer: Some(CsumType::Md5), file: Some(CsumType::Md5) }
		);
		assert_eq!(
			ChecksumChoice::parse("xxhash,auto").unwrap(),
			ChecksumChoice { xfer: Some(CsumType::Xxh64), file: None }
		);
		assert_eq!(ChecksumChoice::parse("foo").unwrap_err(), "unknown checksum name: foo");
		assert_eq!(ChecksumChoice::parse("foo,md5").unwrap_err(), "unknown checksum name: foo,md5");
		assert_eq!(ChecksumChoice::parse("md5,bar").unwrap_err(), "unknown checksum name: bar");
		assert_eq!(ChecksumChoice::parse(",md5").unwrap_err(), "unknown checksum name: ,md5");
		assert_eq!(ChecksumChoice::parse("md5,").unwrap_err(), "unknown checksum name: ");
		assert_eq!(ChecksumChoice::parse("").unwrap_err(), "unknown checksum name: ");
		let (x, f) = ChecksumChoice::parse("sha1,auto").unwrap().resolve(Proto::new(29, 0));
		assert_eq!((x, f), (CsumType::Sha1, CsumType::Md4Old));
	}

	#[test]
	fn defaults_per_protocol() {
		assert_eq!(CsumType::default_for(Proto::new(33, 0)), CsumType::Md5);
		assert_eq!(CsumType::default_for(Proto::new(29, 0)), CsumType::Md4Old);
		assert_eq!(CsumType::default_for(Proto::new(26, 0)), CsumType::Md4Busted);
		assert_eq!(CsumType::default_for(Proto::new(20, 0)), CsumType::Md4Archaic);
		assert_eq!(CsumType::Md4Archaic.flist_len(), 2);
		assert_eq!(CsumType::Md4Archaic.digest_len(), 16);
	}

	#[test]
	fn negotiation_lists_match_reference_wire() {
		assert_eq!(checksum_list(None, false).join(" "), "xxh128 xxh3 xxh64 md5 md4 sha1");
		assert_eq!(checksum_list(None, true).join(" "), "xxh128 xxh3 xxh64 md5 md4 sha1 none");
		let env = Some("md5 XXHASH foo md5 none&sha1");
		assert_eq!(checksum_list(env, false).join(" "), "md5 xxh64 none");
		assert_eq!(checksum_list(env, true).join(" "), "sha1");
		assert_eq!(checksum_list(Some("  \t"), false).len(), 6);
		assert_eq!(checksum_list(Some("&md5"), false).len(), 6);
		assert_eq!(checksum_list(Some("bogus"), false), ["INVALID"]);
	}

	#[test]
	fn pick_prefers_our_order() {
		let ours = checksum_list(None, false);
		let theirs = b"xxh128 xxh3 xxh64 md5 md4 sha1 none";
		assert_eq!(pick(&ours, theirs, false).as_deref(), Some("xxh128"));
		assert_eq!(pick(&["md5", "xxh64", "none"], b"sha1 XXHASH md5", false).as_deref(), Some("md5"));
		assert_eq!(pick(&["xxh64", "md5"], b"sha1 XXHASH md5", false).as_deref(), Some("xxh64"));
		assert_eq!(pick(&["md5", "xxh64", "none"], b"sha1", true), None);
		assert_eq!(pick(&["INVALID"], b"md5", true), None);
		// Non-negotiating peer: the fixed string.
		assert_eq!(pick(&ours, b"md5", false).as_deref(), Some("md5"));
	}

	#[test]
	fn negotiation_failure_text() {
		let err = negotiate_failure("checksum", &["md5", "xxh64", "none"], b"sha1", false, true);
		assert_eq!(err.code, exit::RERR_UNSUPPORTED);
		assert_eq!(err.site, Some(("compat.c", 406)));
		assert_eq!(
			err.message.as_deref(),
			Some("Failed to negotiate a checksum choice.\nServer list: sha1\nClient list: md5 xxh64 none")
		);
		let silent = negotiate_failure("checksum", &["sha1"], b"md5", true, true);
		assert_eq!(silent.message, None);
		let invalid = negotiate_failure("checksum", &["INVALID"], b"md5", true, false);
		assert_eq!(
			invalid.message.as_deref(),
			Some("Failed to negotiate a checksum choice.\nClient list: md5\nServer list: INVALID")
		);
	}

	#[test]
	fn env_validation_of_explicit_choice() {
		assert!(checksum_env_allows(None, CsumType::Md5, CsumType::Md5));
		assert!(checksum_env_allows(Some("xxh64&  "), CsumType::Sha1, CsumType::Sha1));
		assert!(checksum_env_allows(Some("&md4 md5"), CsumType::Md4Old, CsumType::Md5));
		assert!(!checksum_env_allows(Some("&md5"), CsumType::Md4Old, CsumType::Md5));
		assert!(!checksum_env_allows(Some("md5"), CsumType::Md5, CsumType::Sha1));
	}

	#[test]
	fn sum_sizes_follow_upstream_math() {
		let p = p33();
		let cases: [(i64, [i32; 4]); 9] = [
			(0, [0, 700, 2, 0]),
			(1, [1, 700, 2, 1]),
			(700, [1, 700, 2, 0]),
			(701, [2, 700, 2, 1]),
			(490_001, [701, 700, 2, 1]),
			(1 << 20, [1024, 1024, 2, 0]),
			(10_000_000, [3165, 3160, 2, 1760]),
			(4 << 30, [65536, 65536, 4, 0]),
			(1 << 40, [8_388_608, 131_072, 6, 0]),
		];
		for (len, [count, blength, s2length, remainder]) in cases {
			assert_eq!(
				SumHead::for_len(len, 0, p, 16),
				SumHead { count, blength, s2length, remainder },
				"len {len}"
			);
		}
		// Protocol 29 caps at OLD_MAX_BLOCK_SIZE instead.
		assert_eq!(SumHead::for_len(1 << 40, 0, Proto::new(29, 0), 16), SumHead {
			count: 1_048_576,
			blength: 1_048_576,
			s2length: 5,
			remainder: 0,
		});
		assert_eq!(SumHead::for_len(1 << 20, 1000, p, 16), SumHead {
			count: 1049,
			blength: 1000,
			s2length: 2,
			remainder: 576,
		});
		// Redo pass: full strong sums, capped by the digest length.
		assert_eq!(SumHead::sized(1 << 20, 0, p, 16, 16).s2length, 16);
		assert_eq!(SumHead::sized(1 << 20, 0, p, 8, 16).s2length, 8);
		assert_eq!(SumHead::for_len(1 << 40, 0, p, 1).s2length, 1);
		assert_eq!(SumHead::for_len(-1, 0, p, 16).count, -1);
		assert_eq!(SumHead::for_len(1 << 62, 0, p, 16).count, -1);
	}

	fn head_bytes(fields: [i32; 4]) -> Vec<u8> {
		fields.iter().flat_map(|v| v.to_le_bytes()).collect()
	}

	#[test]
	fn sum_head_round_trip() {
		let head = SumHead { count: 3165, blength: 3160, s2length: 2, remainder: 1760 };
		let mut buf = Vec::new();
		head.write(&mut buf, p33()).unwrap();
		assert_eq!(buf, head_bytes([3165, 3160, 2, 1760]));
		assert_eq!(SumHead::read(&mut buf.as_slice(), p33(), 16).unwrap(), head);
		assert_eq!(head.flength(), 10_000_000);
		assert_eq!(head.block_len(3164), 1760);
		assert_eq!(head.block_len(0), 3160);
	}

	#[test]
	fn sum_head_validation() {
		let read = |fields: [i32; 4], p: Proto| {
			SumHead::read_as(&mut head_bytes(fields).as_slice(), p, 16, Role::Receiver)
		};
		let err = read([5, 0, 2, 0], p33()).unwrap_err();
		assert_eq!(err.code, exit::RERR_PROTOCOL);
		assert_eq!(err.message.as_deref(), Some("Invalid zero block length [receiver]"));
		assert_eq!(err.site, Some(("io.c", 2266)));
		assert!(read([0, 0, 0, 0], p33()).is_ok());
		let msg = |fields, p| read(fields, p).unwrap_err().message.unwrap();
		assert_eq!(msg([-1, 700, 2, 0], p33()), "Invalid checksum count -1 [receiver]");
		assert_eq!(msg([1, 131_073, 2, 0], p33()), "Invalid block length 131073 [receiver]");
		assert!(read([1, 131_073, 2, 0], Proto::new(29, 0)).is_ok());
		assert_eq!(msg([1, -5, 2, 0], p33()), "Invalid block length -5 [receiver]");
		assert_eq!(msg([1, 700, 17, 0], p33()), "Invalid checksum length 17 [receiver]");
		assert_eq!(msg([1, 700, -1, 0], p33()), "Invalid checksum length -1 [receiver]");
		assert_eq!(msg([1, 700, 2, 701], p33()), "Invalid remainder length 701 [receiver]");
		assert_eq!(msg([1, 700, 2, -1], p33()), "Invalid remainder length -1 [receiver]");
		// Truncated input is a stream error, not a panic.
		let short = SumHead::read(&mut &head_bytes([1, 700, 2, 0])[..10], p33(), 16).unwrap_err();
		assert_ne!(short.code, exit::RERR_OK);
	}
}
