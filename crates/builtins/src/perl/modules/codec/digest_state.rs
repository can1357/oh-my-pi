//! Persistent MD5 and SHA contexts for the modules' byte- and bit-oriented OO APIs.
//!
//! The RustCrypto one-shot digests do not expose their internal count and block.
//! This implements the RFC 1321 and FIPS 180-4 block operations for contexts
//! which must import/export those fields or contain a non-byte-aligned tail.

use std::fmt::Write as _;

use super::Algo;

include!("digest_constants.rs");

const STATE_LEN: usize = 4 + 16 + 8 * 8 + 128;

pub(super) struct State {
	pub alg: Algo,
	bits: u128,
	h: [u64; 8],
	block: [u8; 128],
}

impl State {
	pub fn new(alg: Algo) -> Self {
		use Algo::*;
		let h = match alg {
			Md5 => [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0, 0, 0, 0],
			Sha1 => [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0, 0, 0, 0],
			Sha224 => [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4],
			Sha256 => [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19],
			Sha384 => [0xcbbb9d5dc1059ed8, 0x629a292a367cd507, 0x9159015a3070dd17, 0x152fecd8f70e5939,
				0x67332667ffc00b31, 0x8eb44a8768581511, 0xdb0c2e0d64f98fa7, 0x47b5481dbefa4fa4],
			Sha512 => [0x6a09e667f3bcc908, 0xbb67ae8584caa73b, 0x3c6ef372fe94f82b, 0xa54ff53a5f1d36f1,
				0x510e527fade682d1, 0x9b05688c2b3e6c1f, 0x1f83d9abfb41bd6b, 0x5be0cd19137e2179],
			Sha512224 => [0x8c3d37c819544da2, 0x73e1996689dcd4d6, 0x1dfab7ae32ff9c82, 0x679dd514582f9fcf,
				0x0f6d2b697bd44da8, 0x77e36f7304c48942, 0x3f9d85a86a1d36c8, 0x1112e6ad91d692a1],
			Sha512256 => [0x22312194fc2bf72c, 0x9f555fa3c84c64c2, 0x2393b86b6f53b151, 0x963877195940eabd,
				0x96283ee2a88effe3, 0xbe5e1e2553863992, 0x2b0199fc2c85b8aa, 0x0eb72ddc81c52ca2],
		};
		Self { alg, bits: 0, h, block: [0; 128] }
	}
	pub fn decode(bytes: &[u8]) -> Option<Self> {
		if bytes.len() != STATE_LEN { return None; }
		let alg = Algo::from_num(i64::from(u32::from_be_bytes(bytes[..4].try_into().ok()?)))?;
		let bits = u128::from_be_bytes(bytes[4..20].try_into().ok()?);
		let mut h = [0; 8];
		for (s, d) in bytes[20..84].chunks_exact(8).zip(&mut h) { *d = u64::from_be_bytes(s.try_into().ok()?); }
		Some(Self { alg, bits, h, block: bytes[84..].try_into().ok()? })
	}
	pub fn encode(&self, bytes: &mut Vec<u8>) {
		bytes.clear();
		bytes.reserve(STATE_LEN);
		bytes.extend_from_slice(&(self.alg.number() as u32).to_be_bytes());
		bytes.extend_from_slice(&self.bits.to_be_bytes());
		for word in self.h { bytes.extend_from_slice(&word.to_be_bytes()); }
		bytes.extend_from_slice(&self.block);
	}
	fn pending(&self) -> usize { (self.bits as usize) % (self.alg.block() * 8) }
	pub fn append(&mut self, input: &[u8]) { self.append_bits(input, input.len().saturating_mul(8)); }
	pub fn append_bits(&mut self, input: &[u8], bits: usize) {
		let width = self.alg.block();
		let mut pending = self.pending();
		let bits = bits.min(input.len().saturating_mul(8));
		self.bits = self.bits.wrapping_add(bits as u128);
		let input_bytes = &input[..bits / 8];
		if pending % 8 == 0 {
			let mut bytes = input_bytes;
			if pending != 0 {
				let old = pending / 8;
				let copied = (width - old).min(bytes.len());
				self.block[old..old + copied].copy_from_slice(&bytes[..copied]);
				bytes = &bytes[copied..];
				pending += copied * 8;
				if pending / 8 == width {
					compress(self.alg, &mut self.h, &self.block[..width]);
					pending = 0;
				}
			}
			if pending == 0 {
				let mut blocks = bytes.chunks_exact(width);
				for block in &mut blocks { compress(self.alg, &mut self.h, block); }
				let partial = blocks.remainder();
				self.block[..partial.len()].copy_from_slice(partial);
				pending = partial.len() * 8;
			}
		} else {
			let shift = pending % 8;
			for &b in input_bytes {
				self.block[pending / 8] |= b >> shift;
				pending += 8;
				if pending / 8 == width {
					compress(self.alg, &mut self.h, &self.block[..width]);
					pending -= width * 8;
				}
				self.block[pending / 8] = b << (8 - shift);
			}
		}
		if bits % 8 != 0 {
			let mut segment = input[bits / 8];
			let count = bits % 8;
			let shift = pending % 8;
			segment &= 0xff << (8 - count);
			let byte = pending / 8;
			if shift == 0 { self.block[byte] = segment; }
			else { self.block[byte] |= segment >> shift; }
			if shift + count >= 8 {
				let next = if byte + 1 == width {
					compress(self.alg, &mut self.h, &self.block[..width]);
					0
				} else { byte + 1 };
				if shift + count > 8 { self.block[next] = segment << (8 - shift); }
			}
		}
	}
	pub fn finish(mut self) -> ([u8; 64], usize) {
		let width = self.alg.block();
		let pending = self.pending();
		let full = pending / 8;
		let shifts = pending % 8;
		if shifts == 0 { self.block[full] = 0x80; }
		else { self.block[full] |= 0x80 >> shifts; }
		self.block[full + 1..width].fill(0);
		let length_pos = width - width / 8;
		if full >= length_pos {
			compress(self.alg, &mut self.h, &self.block[..width]);
			self.block[..length_pos].fill(0);
		}
		if matches!(self.alg, Algo::Md5) {
			self.block[length_pos..width].copy_from_slice(&(self.bits as u64).to_le_bytes());
		} else {
			self.block[length_pos..width].copy_from_slice(&self.bits.to_be_bytes()[16 - width / 8..]);
		}
		compress(self.alg, &mut self.h, &self.block[..width]);
		let mut out = [0; 64];
		let len = self.alg.size() as usize / 8;
		if width == 128 {
			for (b, &h) in out.chunks_exact_mut(8).zip(&self.h) { b.copy_from_slice(&h.to_be_bytes()); }
		} else {
			for (b, &h) in out.chunks_exact_mut(4).zip(&self.h) {
				let h = h as u32;
				b.copy_from_slice(&if matches!(self.alg, Algo::Md5) { h.to_le_bytes() } else { h.to_be_bytes() });
			}
		}
		(out, len)
	}
	pub fn sha_text(&self) -> String {
		let block = self.alg.block();
		let pending = self.pending();
		let bits = self.bits;
		let mut out = String::with_capacity(block * 3 + 230);
		let _ = write!(out, "alg:{}\nH", self.alg.number());
		let width = if block == 64 { 8 } else { 16 };
		for word in self.h { let _ = write!(out, ":{word:0width$x}"); }
		out.push_str("\nblock");
		for n in 0..block {
			let code = if n * 8 < pending { self.block[n] } else { 0 };
			let _ = write!(out, ":{code:02x}");
		}
		let _ = write!(out, "\nblockcnt:{pending}\nlenhh:{}\nlenhl:{}\nlenlh:{}\nlenll:{}\n",
			(bits >> 96) as u32, (bits >> 64) as u32, (bits >> 32) as u32, bits as u32);
		out
	}
	pub fn from_sha_text(s: &str) -> Option<Self> {
		let mut lines = s.lines();
		let alg = Algo::from_num(lines.next()?.strip_prefix("alg:")?.parse().ok()?)?;
		if matches!(alg, Algo::Md5) { return None; }
		let mut ctx = Self::new(alg);
		let mut hash = lines.next()?.strip_prefix("H:")?.split(':');
		for h in &mut ctx.h {
			*h = u64::from_str_radix(hash.next()?, 16).ok()?;
			if alg.block() == 64 && *h > u64::from(u32::MAX) { return None; }
		}
		let mut block = lines.next()?.strip_prefix("block:")?.split(':');
		for b in &mut ctx.block[..alg.block()] { *b = u8::from_str_radix(block.next()?, 16).ok()?; }
		if hash.next().is_some() || block.next().is_some() { return None; }
		let pending: usize = lines.next()?.strip_prefix("blockcnt:")?.parse().ok()?;
		for part in ["lenhh:", "lenhl:", "lenlh:", "lenll:"] {
			let bits: u32 = lines.next()?.strip_prefix(part)?.parse().ok()?;
			ctx.bits = (ctx.bits << 32) | u128::from(bits);
		}
		if ctx.pending() != pending { return None; }
		if pending % 8 != 0 { ctx.block[pending / 8] &= 0xff << (8 - pending % 8); }
		Some(ctx)
	}
	pub fn md5_fields(&self) -> (u64, [u8; 16], &[u8]) {
		let mut bytes = [0; 16];
		for (word, out) in self.h.iter().zip(bytes.chunks_exact_mut(4)) { out.copy_from_slice(&(*word as u32).to_le_bytes()); }
		((self.bits / 512) as u64, bytes, &self.block[..self.pending() / 8])
	}
	pub fn from_md5_fields(blocks: u64, hash: &[u8], block: &[u8]) -> Option<Self> {
		if hash.len() != 16 || block.len() >= 64 { return None; }
		let mut ctx = Self::new(Algo::Md5);
		ctx.bits = u128::from(blocks) * 512 + (block.len() as u128) * 8;
		for (h, word) in ctx.h.iter_mut().zip(hash.chunks_exact(4)) { *h = u64::from(u32::from_le_bytes(word.try_into().ok()?)); }
		ctx.block[..block.len()].copy_from_slice(block);
		Some(ctx)
	}
}

fn words32<const N: usize>(block: &[u8], little: bool) -> [u32; N] {
	let mut result = [0; N];
	for (dest, word) in result.iter_mut().zip(block.as_chunks::<4>().0) {
		*dest = if little { u32::from_le_bytes(*word) } else { u32::from_be_bytes(*word) };
	}
	result
}

fn compress(alg: Algo, h: &mut [u64; 8], block: &[u8]) {
	match alg {
		Algo::Md5 => md5(h, block),
		Algo::Sha1 => sha1(h, block),
		Algo::Sha224 | Algo::Sha256 => sha2_32(h, block),
		_ => sha2_64(h, block),
	}
}
fn md5(h: &mut [u64; 8], block: &[u8]) {
	let w = words32::<16>(block, true);
	let [mut a, mut b, mut c, mut d, ..] = h.map(|x| x as u32);
	let rotations = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
	for (i, &k) in MD5_K.iter().enumerate() {
		let (f, j) = match i / 16 {
			0 => ((b & c) | (!b & d), i), 1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
			2 => (b ^ c ^ d, (3 * i + 5) % 16), _ => (c ^ (b | !d), (7 * i) % 16),
		};
		let next = a.wrapping_add(f).wrapping_add(k).wrapping_add(w[j]).rotate_left(rotations[i / 16][i % 4]);
		[a, b, c, d] = [d, b.wrapping_add(next), b, c];
	}
	for (h, v) in h.iter_mut().zip([a, b, c, d]) { *h = u64::from((*h as u32).wrapping_add(v)); }
}
fn sha1(h: &mut [u64; 8], block: &[u8]) {
	let mut w = words32::<80>(block, false);
	for n in 16..w.len() { w[n] = (w[n - 3] ^ w[n - 8] ^ w[n - 14] ^ w[n - 16]).rotate_left(1); }
	let [mut a, mut b, mut c, mut d, mut e, ..] = h.map(|x| x as u32);
	for (i, w) in w.into_iter().enumerate() {
		let (f, k) = match i / 20 {
			0 => ((b & c) | (!b & d), 0x5a827999), 1 => (b ^ c ^ d, 0x6ed9eba1),
			2 => ((b & c) | (b & d) | (c & d), 0x8f1bbcdc), _ => (b ^ c ^ d, 0xca62c1d6),
		};
		let next = a.rotate_left(5).wrapping_add(f).wrapping_add(e).wrapping_add(k).wrapping_add(w);
		[a, b, c, d, e] = [next, a, b.rotate_left(30), c, d];
	}
	for (h, v) in h.iter_mut().zip([a, b, c, d, e]) { *h = u64::from((*h as u32).wrapping_add(v)); }
}
macro_rules! sha2_rounds {
	($h:expr, $w:expr, $word:ty, $key:expr, $s0:expr, $s1:expr, $sum0:expr, $sum1:expr) => {{
		let mut w = $w;
		for n in 16..w.len() {
			w[n] = w[n - 16].wrapping_add(($s0)(w[n - 15])).wrapping_add(w[n - 7]).wrapping_add(($s1)(w[n - 2]));
		}
		let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = $h.map(|x| x as $word);
		for (n, w) in w.into_iter().enumerate() {
			let ch = (e & f) ^ (!e & g);
			let maj = (a & b) ^ (a & c) ^ (b & c);
			let t1 = h.wrapping_add(($sum1)(e)).wrapping_add(ch).wrapping_add(($key)(n)).wrapping_add(w);
			let t2 = ($sum0)(a).wrapping_add(maj);
			[a, b, c, d, e, f, g, h] = [t1.wrapping_add(t2), a, b, c, d.wrapping_add(t1), e, f, g];
		}
		for (old, v) in $h.iter_mut().zip([a, b, c, d, e, f, g, h]) {
			*old = u64::from((*old as $word).wrapping_add(v));
		}
	}};
}
fn sha2_32(h: &mut [u64; 8], block: &[u8]) {
	sha2_rounds!(h, words32::<64>(block, false), u32, |n: usize| (SHA2_K[n] >> 32) as u32,
		|x: u32| x.rotate_right(7) ^ x.rotate_right(18) ^ (x >> 3),
		|x: u32| x.rotate_right(17) ^ x.rotate_right(19) ^ (x >> 10),
		|x: u32| x.rotate_right(2) ^ x.rotate_right(13) ^ x.rotate_right(22),
		|x: u32| x.rotate_right(6) ^ x.rotate_right(11) ^ x.rotate_right(25));
}
fn sha2_64(h: &mut [u64; 8], block: &[u8]) {
	let mut w = [0u64; 80];
	for (dest, word) in w.iter_mut().zip(block.as_chunks::<8>().0) { *dest = u64::from_be_bytes(*word); }
	sha2_rounds!(h, w, u64, |n: usize| SHA2_K[n],
		|x: u64| x.rotate_right(1) ^ x.rotate_right(8) ^ (x >> 7),
		|x: u64| x.rotate_right(19) ^ x.rotate_right(61) ^ (x >> 6),
		|x: u64| x.rotate_right(28) ^ x.rotate_right(34) ^ x.rotate_right(39),
		|x: u64| x.rotate_right(14) ^ x.rotate_right(18) ^ x.rotate_right(41));
}

#[cfg(test)]
mod tests {
	use md5::{Digest, Md5};
	use sha1::Sha1;
	use sha2::{Sha224, Sha256, Sha384, Sha512, Sha512_224, Sha512_256};

	use super::{Algo, State};

	#[test]
	fn streaming_contexts_match_byte_digests() {
		let message: Vec<_> = (0..1024).map(|n| (n ^ (n >> 3)) as u8).collect();
		for (algorithm, expected) in [
			(Algo::Md5, Md5::digest(&message).to_vec()),
			(Algo::Sha1, Sha1::digest(&message).to_vec()),
			(Algo::Sha224, Sha224::digest(&message).to_vec()),
			(Algo::Sha256, Sha256::digest(&message).to_vec()),
			(Algo::Sha384, Sha384::digest(&message).to_vec()),
			(Algo::Sha512, Sha512::digest(&message).to_vec()),
			(Algo::Sha512224, Sha512_224::digest(&message).to_vec()),
			(Algo::Sha512256, Sha512_256::digest(&message).to_vec()),
		] {
			let mut state = State::new(algorithm);
			for chunk in message.chunks(73) { state.append(chunk); }
			let (digest, len) = state.finish();
			assert_eq!(&digest[..len], expected.as_slice());
		}
	}

	#[test]
	fn sha_state_round_trip_keeps_bits_and_portable_fields() {
		let mut state = State::new(Algo::Sha256);
		state.append_bits(b"\x80", 1);
		state.append_bits(b"\x40", 2);
		let portable = state.sha_text();
		assert!(portable.contains("\nblock:a0:"));
		assert!(portable.ends_with("\nlenll:3\n"));
		let (digest, len) = State::from_sha_text(&portable).expect("portable SHA state").finish();
		let hex = digest[..len].iter().map(|b| format!("{b:02x}")).collect::<String>();
		assert_eq!(hex, "36c2b2165533d184079d0431fdfa588021eff5cb79a6a6ad82d7d0377c81928b");
	}
}
