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
	collections::HashMap,
	hash::{BuildHasherDefault, Hasher},
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

/// Pack a key of ≤15 bytes losslessly into a `u128`: bytes little-endian
/// at bits 0..len*8, zero padding, length tag at bits 120..128 (a
/// 15-byte key leaves the top byte free, so equal packs imply equal keys
/// even across lengths and with NUL bytes). Built from two overlapping
/// unaligned reads — a variable-length memcpy here benched slower than
/// hashing the raw bytes; the overlap region ORs identical bits.
#[inline]
fn pack(key: &[u8]) -> Option<u128> {
	let n = key.len();
	if n > 15 {
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
	Some(v | (n as u128) << 120)
}

/// Token bytes → rank map decoded from a UTOK1 blob.
///
/// Split by key length into three stores, matching the merge loop's
/// query mix (measured on o200k, M4 Max: +18% english / +34% code /
/// +14% cjk end-to-end vs a single `FxMap<Box<[u8]>, u32>`):
///
/// - 2 bytes — direct-indexed table: the merge seed loop queries every adjacent
///   byte pair, so over half of all lookups land here as one array load.
/// - other ≤15 bytes — [`pack`]ed `u128` keys in an Fx map: KV inline in the
///   table, no `Box` pointer chase, no byte-wise compare.
/// - >15 bytes — plain byte-keyed Fx map (~3% of vocab; spans this long are
///   > almost always misses).
pub struct RankTable {
	/// Rank of 2-byte token `[a, b]` at `a << 8 | b`; `u32::MAX` where
	/// absent (ranks are vocab indices, far below the sentinel).
	pairs:             Box<[u32; 65536]>,
	/// Tokens of 1 or 3..=15 bytes, keyed by [`pack`].
	short:             HashMap<u128, u32, Fx>,
	/// Tokens longer than 15 bytes.
	long:              FxMap,
	/// Longest token in bytes; callers may use it to bound scans.
	pub max_token_len: usize,
}

impl RankTable {
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
		let mut pairs: Box<[u32; 65536]> =
			vec![u32::MAX; 65536].into_boxed_slice().try_into().unwrap();
		let mut short = HashMap::with_capacity_and_hasher(n, Fx::default());
		let mut long = FxMap::default();
		let mut max_token_len = 0usize;
		for rank in 0..n as u32 {
			let mut len = 0usize;
			let mut shift = 0;
			loop {
				let b = p[0];
				p = &p[1..];
				len |= ((b & 0x7f) as usize) << shift;
				if b < 0x80 {
					break;
				}
				shift += 7;
			}
			if len > 0 {
				let key = &p[..len];
				if let [a, b] = key {
					pairs[usize::from(*a) << 8 | usize::from(*b)] = rank;
				} else if let Some(k) = pack(key) {
					short.insert(k, rank);
				} else {
					long.insert(key.into(), rank);
				}
				max_token_len = max_token_len.max(len);
				p = &p[len..];
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
		self.merge(piece, |start, end| {
			out.push(
				self
					.rank(&piece[start..end])
					.expect("utoken: unreachable merge state"),
			);
		});
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
		self.merge(piece, |_, _| n += 1);
		n
	}

	/// tiktoken's `byte_pair_merge`: start from single bytes, repeatedly
	/// merge the adjacent pair with the lowest rank, then emit each final
	/// span via `emit(start, end)`.
	fn merge(&self, piece: &[u8], mut emit: impl FnMut(usize, usize)) {
		// parts[k] = (start offset, rank of merging part k with part k+1).
		// Two sentinels keep `parts[i + 3].0` in-bounds when recomputing
		// the rank of the pair formed after a merge at the end.
		let mut parts: Vec<(usize, u32)> = Vec::with_capacity(piece.len() + 1);
		let mut min_rank: (u32, usize) = (u32::MAX, usize::MAX);
		for i in 0..piece.len() - 1 {
			let rank = self.rank(&piece[i..i + 2]).unwrap_or(u32::MAX);
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
				self
					.rank(&piece[parts[k].0..parts[k + 3].0])
					.unwrap_or(u32::MAX)
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
		self.run(units, &mut |t, p| n += t.count_piece(p));
		n
	}

	pub fn encode<U: Unit>(&self, units: &[U]) -> Vec<u32> {
		let mut out = Vec::new();
		self.run(units, &mut |t, p| t.encode_piece(p, &mut out));
		out
	}

	/// Normalize/transcode as required, split, and feed each piece's
	/// UTF-8 bytes to `f` alongside the rank table.
	fn run<U: Unit>(&self, units: &[U], f: &mut impl FnMut(&RankTable, &[u8])) {
		if let Some(bytes) = U::as_utf8(units) {
			// UTF-8 flavor: valid by construction (`str`/`String` input).
			if self.nfc
				&& let Ok(text) = std::str::from_utf8(bytes)
				&& let Cow::Owned(norm) = pretoken::nfc(text)
			{
				return self.scan(norm.as_bytes(), f);
			}
			return self.scan(bytes, f);
		}
		// Non-UTF-8 flavors: owned UTF-8 needed only when NFC actually has
		// work to do, or while the test-only regex oracle is active.
		#[cfg(test)]
		let regex_splitter = self.splitter.is_regex();
		#[cfg(not(test))]
		let regex_splitter = false;
		if (self.nfc && !nfc_quick(units)) || regex_splitter {
			let s = decode_lossy(units);
			let s = match pretoken::nfc(&s) {
				Cow::Owned(o) if self.nfc => o,
				_ => s,
			};
			return self.scan(s.as_bytes(), f);
		}
		self.scan(units, f);
	}

	fn scan<U: Unit>(&self, units: &[U], f: &mut impl FnMut(&RankTable, &[u8])) {
		let mut buf = Vec::new();
		self
			.splitter
			.for_each_piece(units, |piece| f(&self.table, piece_bytes(piece, &mut buf)));
	}
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
