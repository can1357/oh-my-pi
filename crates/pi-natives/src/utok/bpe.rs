//! Core byte-pair encoding engine over rank tables (tiktoken algorithm).
//!
//! A [`RankTable`] maps token byte sequences to ranks; merge priority is
//! rank order, so no merges list exists. Tables parse from the UTOK1
//! container (see `data/families.json` for the format) after zstd
//! decompression in [`tables`](crate::utok::tables).
//!
//! Input is encoding-generic: [`BpeEncoding::count`]/[`encode`]
//! (`BpeEncoding::encode`) take `&[U: Unit]`. Pre-tokenization scans the
//! units natively; each piece is then UTF-8-encoded into a reused buffer
//! for the byte-keyed rank table (`str` input skips that copy entirely,
//! non-UTF-8 flavors narrow ASCII runs 1:1). Steady state performs no
//! per-call allocation beyond one scratch buffer for non-UTF-8 flavors.
//!
//! Per-flavor native rank-table views (`HashMap<Box<[u16]>, u32>` etc.)
//! were considered and measured out: with the ASCII narrow path, u16
//! input already runs at 81-97% of the str path per codepoint (M4 Max,
//! english/CJK), so a second table per flavor (2x memory, plus a
//! ragged-token eligibility rule for tokens that split codepoints) buys
//! almost nothing. Revisit only with profile evidence.

use std::{
	borrow::Cow,
	cmp::Reverse,
	collections::{BinaryHeap, HashMap},
	hash::{BuildHasherDefault, Hash, Hasher},
};

use crate::utok::{
	pretoken::{self, Splitter},
	utf::Unit,
};

/// Firefox/rustc Fx hash: multiplicative word-at-a-time mixing. Rank
/// lookups hash short byte keys on every merge step; `SipHash` is the
/// dominant cost there (~30% end-to-end at the default hasher).
#[derive(Default)]
struct FxHasher(u64);

impl Hasher for FxHasher {
	#[inline]
	fn write(&mut self, bytes: &[u8]) {
		const SEED: u64 = 0x51_7c_c1_b7_27_22_0a_95;
		let mut h = self.0;
		let mut b = bytes;
		while let Some(chunk) = b.first_chunk::<8>() {
			h = (h.rotate_left(5) ^ u64::from_le_bytes(*chunk)).wrapping_mul(SEED);
			b = &b[8..];
		}
		if let Some(chunk) = b.first_chunk::<4>() {
			h = (h.rotate_left(5) ^ u64::from(u32::from_le_bytes(*chunk))).wrapping_mul(SEED);
			b = &b[4..];
		}
		for &byte in b {
			h = (h.rotate_left(5) ^ u64::from(byte)).wrapping_mul(SEED);
		}
		self.0 = h;
	}

	#[inline]
	fn finish(&self) -> u64 {
		self.0
	}
}

type Fx = BuildHasherDefault<FxHasher>;
type FxMap = HashMap<Box<[u8]>, u32, Fx>;

const SHORT_MAX: usize = 15;

/// A [`pack`]ed short key as four `u32` words. A `u128` key is 16-byte
/// aligned, which pads every `(key, rank)` bucket from 20 to 32 bytes; the
/// rank table holds one bucket per short token, ~6 MB of padding on o200k
/// and Qwen3 combined.
#[derive(Clone, Copy, PartialEq, Eq)]
struct ShortKey([u32; 4]);

impl Hash for ShortKey {
	/// Two word-sized writes: the same Fx mixing a `u128` key got.
	#[inline]
	fn hash<H: Hasher>(&self, state: &mut H) {
		let [a, b, c, d] = self.0;
		state.write_u64(u64::from(a) | u64::from(b) << 32);
		state.write_u64(u64::from(c) | u64::from(d) << 32);
	}
}

/// Pack a key of ≤15 bytes losslessly into 128 bits: bytes little-endian
/// at bits 0..len*8, zero padding, length tag at bits 120..128 (a
/// 15-byte key leaves the top byte free, so equal packs imply equal keys
/// even across lengths and with NUL bytes). Built from two overlapping
/// unaligned reads — a variable-length memcpy here benched slower than
/// hashing the raw bytes; the overlap region ORs identical bits.
#[inline]
#[allow(
	clippy::cast_possible_truncation,
	reason = "splits the packed u128 into its four u32 words"
)]
fn pack(key: &[u8]) -> Option<ShortKey> {
	let n = key.len();
	if n > SHORT_MAX {
		return None;
	}
	let v: u128 = if let (Some(lo), Some(hi)) = (key.first_chunk::<8>(), key.last_chunk::<8>()) {
		u128::from(u64::from_le_bytes(*lo)) | u128::from(u64::from_le_bytes(*hi)) << ((n - 8) * 8)
	} else if let (Some(lo), Some(hi)) = (key.first_chunk::<4>(), key.last_chunk::<4>()) {
		u128::from(u32::from_le_bytes(*lo)) | u128::from(u32::from_le_bytes(*hi)) << ((n - 4) * 8)
	} else if let (Some(lo), Some(hi)) = (key.first_chunk::<2>(), key.last_chunk::<2>()) {
		u128::from(u16::from_le_bytes(*lo)) | u128::from(u16::from_le_bytes(*hi)) << ((n - 2) * 8)
	} else if let [b] = key {
		u128::from(*b)
	} else {
		0
	};
	let v = v | (n as u128) << 120;
	Some(ShortKey([v as u32, (v >> 32) as u32, (v >> 64) as u32, (v >> 96) as u32]))
}

/// Token bytes → rank map decoded from a UTOK1 blob.
///
/// Split by key length into three stores, matching the merge loop's
/// query mix (measured on o200k, M4 Max: +18% english / +34% code /
/// +14% cjk end-to-end vs a single `FxMap<Box<[u8]>, u32>`):
///
/// - 2 bytes — direct-indexed table: the merge seed loop queries every adjacent
///   byte pair, so over half of all lookups land here as one array load.
/// - other ≤15 bytes — [`pack`]ed [`ShortKey`]s in an Fx map: KV inline in the
///   table, no `Box` pointer chase, no byte-wise compare.
/// - >15 bytes — plain byte-keyed Fx map (~3% of vocab; spans this long are
///   > almost always misses).
pub struct RankTable {
	/// Rank of 2-byte token `[a, b]` at `a << 8 | b`; `u32::MAX` where
	/// absent (ranks are vocab indices, far below the sentinel).
	pairs:             Box<[u32; 65536]>,
	/// Tokens of 1 or 3..=15 bytes, keyed by [`pack`].
	short:             HashMap<ShortKey, u32, Fx>,
	/// Tokens longer than 15 bytes.
	long:              FxMap,
	/// Longest token in bytes; callers may use it to bound scans.
	pub max_token_len: usize,
}

impl RankTable {
	/// Pieces longer than this merge through
	/// [`merge_long`](Self::merge_long): [`merge`](Self::merge) rescans every
	/// pair after each merge, quadratic in the piece length.
	const LONG_PIECE: usize = 128;

	/// Parse a zstd-compressed UTOK1 blob. Panics on malformed data — the
	/// blobs are compile-time embedded, so corruption is a build error.
	///
	/// Zero-length entries are *skipped*: packers emit merge-unreachable
	/// ("dead") vocab slots as empty strings to keep rank contiguity, and
	/// those ranks must never be produced.
	pub fn parse(zst: &[u8]) -> Self {
		let raw = zstd::decode_all(zst).expect("utoken: zstd decode failed");
		let mut p = &raw[..];
		assert_eq!(&p[..6], b"UTOK1\n", "utoken: bad magic");
		p = &p[6..];
		let n = u32::from_le_bytes(p[..4].try_into().unwrap()) as usize;
		p = &p[4..];
		// Size `short` to its real population: dead slots and pair/long
		// tokens would otherwise round a sparse table up a power of two. A
		// sparse subset table (Jev's base set: 49k short tokens over 200k
		// ranks) still keeps half the container's slots: it answers mostly
		// misses, which at a ~0.75 load cost Jev ~12% of its count time.
		let short_count = {
			let mut entries = p;
			(0..n)
				.map(|_| read_token(&mut entries))
				.filter(|key| matches!(key.len(), 1 | 3..=SHORT_MAX))
				.count()
		};
		let mut pairs: Box<[u32; 65536]> =
			vec![u32::MAX; 65536].into_boxed_slice().try_into().unwrap();
		let mut short = HashMap::with_capacity_and_hasher(short_count.max(n / 2), Fx::default());
		let mut long = FxMap::default();
		let mut max_token_len = 0usize;
		for rank in 0..n as u32 {
			let key = read_token(&mut p);
			if !key.is_empty() {
				if let [a, b] = key {
					pairs[usize::from(*a) << 8 | usize::from(*b)] = rank;
				} else if let Some(k) = pack(key) {
					short.insert(k, rank);
				} else {
					long.insert(key.into(), rank);
				}
				max_token_len = max_token_len.max(key.len());
			}
		}
		assert!(p.is_empty(), "utoken: trailing bytes in UTOK1 blob");
		Self { pairs, short, long, max_token_len }
	}

	/// Rank of an exact token byte sequence, if present.
	#[inline]
	pub fn rank(&self, piece: &[u8]) -> Option<u32> {
		if let [a, b] = piece {
			let r = self.pairs[usize::from(*a) << 8 | usize::from(*b)];
			return (r != u32::MAX).then_some(r);
		}
		match pack(piece) {
			Some(k) => self.short.get(&k).copied(),
			None => self.long.get(piece).copied(),
		}
	}

	/// Append the BPE token ids of one pre-tokenized piece to `out`.
	pub fn encode_piece(&self, piece: &[u8], out: &mut Vec<u32>) {
		if piece.is_empty() {
			return;
		}
		if let Some(rank) = self.rank(piece) {
			out.push(rank);
			return;
		}
		Self::merge(
			piece,
			|p| self.rank(p).unwrap_or(u32::MAX),
			|start, end| {
				out.push(
					self
						.rank(&piece[start..end])
						.expect("utoken: unreachable merge state"),
				);
			},
		);
	}

	/// Token count of one pre-tokenized piece without materializing ids.
	pub fn count_piece(&self, piece: &[u8]) -> u32 {
		if piece.is_empty() {
			return 0;
		}
		if self.rank(piece).is_some() {
			return 1;
		}
		let mut n = 0u32;
		Self::merge(piece, |p| self.rank(p).unwrap_or(u32::MAX), |_, _| n += 1);
		n
	}

	/// Token count of `piece` from the merge loop alone: unlike
	/// [`count_piece`](Self::count_piece), a whole-piece table hit is not
	/// short-circuited, so entries the merges cannot reach stay split. Jev
	/// resolves whole pieces against a separate vocabulary and uses its
	/// base table only for merging.
	pub fn count_merged(&self, piece: &[u8]) -> u32 {
		if piece.is_empty() {
			return 0;
		}
		let mut n = 0u32;
		Self::merge(piece, |p| self.rank(p).unwrap_or(u32::MAX), |_, _| n += 1);
		n
	}

	/// tiktoken's `byte_pair_merge`: start from single bytes, repeatedly
	/// merge the adjacent pair with the lowest rank, then emit each final
	/// span via `emit(start, end)`. `rank_of` prices a span, `u32::MAX` when
	/// it is no token.
	fn merge(piece: &[u8], rank_of: impl Fn(&[u8]) -> u32, mut emit: impl FnMut(usize, usize)) {
		if piece.len() > Self::LONG_PIECE {
			return Self::merge_long(piece, rank_of, emit);
		}
		// parts[k] = (start offset, rank of merging part k with part k+1).
		// Two sentinels keep `parts[i + 3].0` in-bounds when recomputing
		// the rank of the pair formed after a merge at the end.
		let mut parts: Vec<(usize, u32)> = Vec::with_capacity(piece.len() + 1);
		let mut min_rank: (u32, usize) = (u32::MAX, usize::MAX);
		for i in 0..piece.len() - 1 {
			let rank = rank_of(&piece[i..i + 2]);
			if rank < min_rank.0 {
				min_rank = (rank, i);
			}
			parts.push((i, rank));
		}
		parts.push((piece.len() - 1, u32::MAX));
		parts.push((piece.len(), u32::MAX));

		// Rank of merging part `k` with part `k+1` once parts `i` and
		// `i+1` have conceptually fused (called before the `remove`, so
		// the fused pair spans parts[k].0 .. parts[k + 3].0).
		let get_rank = |parts: &[(usize, u32)], k: usize| -> u32 {
			if k + 3 < parts.len() {
				rank_of(&piece[parts[k].0..parts[k + 3].0])
			} else {
				u32::MAX
			}
		};

		while min_rank.0 != u32::MAX {
			let i = min_rank.1;
			if i > 0 {
				parts[i - 1].1 = get_rank(&parts, i - 1);
			}
			parts[i].1 = get_rank(&parts, i);
			parts.remove(i + 1);

			min_rank = (u32::MAX, usize::MAX);
			for (k, &(_, rank)) in parts[..parts.len() - 1].iter().enumerate() {
				if rank < min_rank.0 {
					min_rank = (rank, k);
				}
			}
		}
		for w in parts.windows(2) {
			emit(w[0].0, w[1].0);
		}
	}

	/// [`merge`](Self::merge) in O(n log n) for long pieces. Pending pairs sit
	/// in a min-heap keyed by (rank, start): the lowest rank still merges
	/// first, and among equal ranks the leftmost pair, exactly as the linear
	/// rescan picks. A merge leaves the heap entries of the pairs it changed
	/// stale; they are skipped when popped.
	fn merge_long(piece: &[u8], rank_of: impl Fn(&[u8]) -> u32, mut emit: impl FnMut(usize, usize)) {
		const NONE: usize = usize::MAX;
		let len = piece.len();
		// Parts are named by their start offset. `next[s]` is the start of
		// the part after `s` (`len` past the last), `prev[s]` the start of the
		// part before it, and `rank[s]` the rank of merging `s` with its
		// successor (`u32::MAX` when impossible or once `s` was merged away).
		let mut next: Vec<usize> = (1..=len).collect();
		let mut prev: Vec<usize> = (0..len).map(|s| s.checked_sub(1).unwrap_or(NONE)).collect();
		let mut rank = vec![u32::MAX; len];
		let mut heap = BinaryHeap::with_capacity(len);
		for s in 0..len - 1 {
			rank[s] = rank_of(&piece[s..s + 2]);
			if rank[s] != u32::MAX {
				heap.push(Reverse((rank[s], s)));
			}
		}
		let pair_rank = |next: &[usize], s: usize| -> u32 {
			let successor = next[s];
			if successor >= len {
				return u32::MAX;
			}
			rank_of(&piece[s..next[successor]])
		};

		while let Some(Reverse((pair, s))) = heap.pop() {
			if rank[s] != pair {
				continue;
			}
			let absorbed = next[s];
			next[s] = next[absorbed];
			if next[s] < len {
				prev[next[s]] = s;
			}
			rank[absorbed] = u32::MAX;
			rank[s] = pair_rank(&next, s);
			if rank[s] != u32::MAX {
				heap.push(Reverse((rank[s], s)));
			}
			let before = prev[s];
			if before != NONE {
				rank[before] = pair_rank(&next, before);
				if rank[before] != u32::MAX {
					heap.push(Reverse((rank[before], before)));
				}
			}
		}
		let mut s = 0;
		while s < len {
			emit(s, next[s]);
			s = next[s];
		}
	}
}

fn read_token<'a>(p: &mut &'a [u8]) -> &'a [u8] {
	let mut len = 0usize;
	let mut shift = 0;
	loop {
		let b = p[0];
		*p = &p[1..];
		len |= ((b & 0x7f) as usize) << shift;
		if b < 0x80 {
			break;
		}
		shift += 7;
	}
	let (key, rest) = p.split_at(len);
	*p = rest;
	key
}

/// A full BPE tokenizer: piece splitter + rank table + family flags.
pub struct BpeEncoding {
	pub table:         RankTable,
	pub splitter:      Splitter,
	/// Apply Unicode NFC to input before splitting (Qwen3).
	pub nfc:           bool,
	/// HF `ignore_merges`: whole-piece vocab hit bypasses the merge loop
	/// (GLM-5). The engine already short-circuits whole-piece hits, which
	/// is proven equivalent for GLM-5 (see GLM tests); flag kept for
	/// documentation and any future divergence.
	#[allow(dead_code, reason = "retained to document the GLM-5 tokenizer behavior")]
	pub ignore_merges: bool,
}

impl BpeEncoding {
	pub fn count<U: Unit>(&self, units: &[U]) -> u32 {
		let mut n = 0u32;
		for_each_piece(&self.splitter, self.nfc, units, &mut |p| n += self.table.count_piece(p));
		n
	}

	pub fn encode<U: Unit>(&self, units: &[U]) -> Vec<u32> {
		let mut out = Vec::new();
		for_each_piece(&self.splitter, self.nfc, units, &mut |p| {
			self.table.encode_piece(p, &mut out);
		});
		out
	}
}

/// Normalize/transcode as required, split with `splitter`, and feed each
/// piece's UTF-8 bytes to `f`. Crate-visible so count-only families that
/// price pieces differently (Jev) reuse the normalization and splitting
/// unchanged.
pub(crate) fn for_each_piece<U: Unit>(
	splitter: &Splitter,
	nfc: bool,
	units: &[U],
	f: &mut impl FnMut(&[u8]),
) {
	if let Some(bytes) = U::as_utf8(units) {
		// UTF-8 flavor: valid by construction (`str`/`String` input).
		if nfc
			&& let Ok(text) = std::str::from_utf8(bytes)
			&& let Cow::Owned(norm) = pretoken::nfc(text)
		{
			return scan(splitter, norm.as_bytes(), f);
		}
		return scan(splitter, bytes, f);
	}
	// Non-UTF-8 flavors: owned UTF-8 needed only when NFC actually has
	// work to do, or while the test-only regex oracle is active.
	#[cfg(test)]
	let regex_splitter = splitter.is_regex();
	#[cfg(not(test))]
	let regex_splitter = false;
	if (nfc && !nfc_quick(units)) || regex_splitter {
		let s = decode_lossy(units);
		let s = match pretoken::nfc(&s) {
			Cow::Owned(o) if nfc => o,
			_ => s,
		};
		return scan(splitter, s.as_bytes(), f);
	}
	scan(splitter, units, f);
}

fn scan<U: Unit>(splitter: &Splitter, units: &[U], f: &mut impl FnMut(&[u8])) {
	let mut buf = Vec::new();
	splitter.for_each_piece(units, |piece| f(piece_bytes(piece, &mut buf)));
}

/// UTF-8 bytes of one piece: identity for `u8`, otherwise re-encoded into
/// `buf` (reused across pieces — one allocation per call, amortized nil).
fn piece_bytes<'a, U: Unit>(piece: &'a [U], buf: &'a mut Vec<u8>) -> &'a [u8] {
	if let Some(bytes) = U::as_utf8(piece) {
		return bytes;
	}
	buf.clear();
	buf.reserve(piece.len());
	let mut i = 0;
	while i < piece.len() {
		// ASCII runs narrow 1:1 without the decode/encode round-trip
		// (dominant for code/English u16 input, cf. xutf's ASCII kernels;
		// the trivial loop autovectorizes).
		if let Some(b) = piece[i].ascii() {
			buf.push(b);
			i += 1;
		} else {
			let (c, n) = U::decode(piece, i);
			i += n;
			let mut tmp = [0u8; 4];
			buf.extend_from_slice(c.encode_utf8(&mut tmp).as_bytes());
		}
	}
	buf
}

/// Permissive whole-input decode (malformed units → U+FFFD).
fn decode_lossy<U: Unit>(units: &[U]) -> String {
	let mut s = String::with_capacity(units.len());
	let mut i = 0;
	while i < units.len() {
		let (c, n) = U::decode(units, i);
		i += n;
		s.push(c);
	}
	s
}

/// NFC quick-check over the decoded codepoint stream, allocation-free
/// (conservative: `false` means "may need normalization").
fn nfc_quick<U: Unit>(units: &[U]) -> bool {
	struct Cps<'a, U: Unit>(&'a [U], usize);
	impl<U: Unit> Iterator for Cps<'_, U> {
		type Item = u32;

		fn next(&mut self) -> Option<u32> {
			(self.1 < self.0.len()).then(|| {
				let (c, n) = U::decode(self.0, self.1);
				self.1 += n;
				c as u32
			})
		}
	}
	xutf::is_nfc_codepoints(Cps(units, 0))
}
