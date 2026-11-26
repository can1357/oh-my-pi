//! Unix crypt(3): DES, BSD extended DES and modular hashes where supported.

#[cfg(all(unix, not(target_os = "macos")))]
mod modular;

use crate::perl::{
	ast::{Builtin, Call},
	interp::{Interp, PResult},
	value::Value,
};
#[cfg(unix)]
use crate::perl::value::PStr;

use super::{scalar_args, stringify};

pub(super) fn call(interp: &mut Interp<'_>, call: &Call) -> PResult<Value> {
	let args = scalar_args(interp, Builtin::Crypt, call, 2, 2)?;
	let pass = interp.eval_scalar(&args[0])?;
	let salt = interp.eval_scalar(&args[1])?;
	let pass = latin1(interp, pass, &args[0])?;
	let salt = latin1(interp, salt, &args[1])?;
	crypt(interp, &pass, &salt)
}

fn latin1(interp: &mut Interp<'_>, v: Value, expr: &crate::perl::ast::Expr) -> PResult<Vec<u8>> {
	let s = stringify(interp, v, Some(expr), "crypt", false)?;
	if s.utf8 { s.downgraded().ok_or_else(|| interp.die_msg("Wide character in crypt")) } else { Ok(s.bytes) }
}

#[cfg(not(unix))]
fn crypt(interp: &mut Interp<'_>, _pass: &[u8], _salt: &[u8]) -> PResult<Value> {
	Err(interp.die_msg("The crypt() function is unimplemented due to excessive paranoia"))
}

#[cfg(unix)]
fn crypt(interp: &mut Interp<'_>, pass: &[u8], salt: &[u8]) -> PResult<Value> {
	let pass = pass.split(|&c| c == 0).next().unwrap_or_default();
	#[cfg(not(target_os = "macos"))]
	if salt.starts_with(b"$") {
		return modular::crypt(interp, pass, salt);
	}
	let extended = salt.first() == Some(&b'_');
	let (count, effect) = if extended {
		(decode(salt.get(1..).unwrap_or_default().iter().take(4)), decode(salt.get(5..).unwrap_or_default().iter().take(4)))
	} else {
		(25, decode(salt.iter().take(2)))
	};
	let mut chunks = pass.chunks(8);
	let mut key = key_word(chunks.next().unwrap_or_default());
	if extended {
		for chunk in chunks {
			if interp.is_cancelled() { return Err(crate::perl::interp::Flow::Cancelled); }
			key = permute(encrypt(permute(key, 64, &IP), &schedule(key), 0), 64, &FP) ^ key_word(chunk);
		}
	}
	let schedule = schedule(key);
	let mask = effect.reverse_bits() as u64 >> 8;
	let mut block = 0;
	for round in 0..count {
		if round & 0xff == 0 && interp.is_cancelled() { return Err(crate::perl::interp::Flow::Cancelled); }
		block = encrypt(block, &schedule, mask);
	}
	block = permute(block, 64, &FP);
	let head = if extended { 9 } else { 2 };
	let mut out = Vec::with_capacity(head + 11);
	out.extend((0..head).map(|i| match salt.get(i) {
		Some(&b) if b != 0 => b,
		_ => b'.',
	}));
	for i in 0..10 { out.push(ALPHABET[((block >> (58 - i * 6)) & 63) as usize]); }
	out.push(ALPHABET[((block & 15) << 2) as usize]);
	Ok(Value::Str(PStr::new(out, false)))
}

#[cfg(unix)]
const ALPHABET: &[u8; 64] = b"./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

#[cfg(unix)]
fn decode<'a>(chars: impl Iterator<Item = &'a u8>) -> u32 {
	chars.enumerate().fold(0, |n, (i, c)| {
		n | (ALPHABET.iter().position(|v| v == c).unwrap_or(0) as u32) << (6 * i)
	})
}

#[cfg(unix)]
fn key_word(bytes: &[u8]) -> u64 {
	let mut key = [0; 8];
	for (slot, &b) in key.iter_mut().zip(bytes) { *slot = b << 1; }
	u64::from_be_bytes(key)
}

#[cfg(unix)]
fn schedule(key: u64) -> [u64; 16] {
	let key = permute(key, 64, &PC1);
	let mut left = key >> 28;
	let mut right = key & 0xfff_ffff;
	std::array::from_fn(|i| {
		let shift = if matches!(i, 0 | 1 | 8 | 15) { 1 } else { 2 };
		left = ((left << shift) | (left >> (28 - shift))) & 0xfff_ffff;
		right = ((right << shift) | (right >> (28 - shift))) & 0xfff_ffff;
		permute((left << 28) | right, 56, &PC2)
	})
}

#[cfg(unix)]
fn encrypt(block: u64, schedule: &[u64; 16], mask: u64) -> u64 {
	let (mut left, mut right) = ((block >> 32) as u32, block as u32);
	for &key in schedule {
		let mut expansion = permute(u64::from(right), 32, &E);
		let swap = (expansion ^ (expansion >> 24)) & mask;
		expansion ^= key ^ swap ^ (swap << 24);
		let mut result = 0;
		for (i, sbox) in SP.iter().enumerate() {
			result |= sbox[((expansion >> (42 - 6 * i)) & 63) as usize];
		}
		(left, right) = (right, left ^ result);
	}
	(u64::from(right) << 32) | u64::from(left)
}

#[cfg(unix)]
const fn permute(word: u64, width: u8, positions: &[u8]) -> u64 {
	let mut result = 0;
	let mut i = 0;
	while i < positions.len() {
		result = (result << 1) | ((word >> (width - positions[i])) & 1);
		i += 1;
	}
	result
}

// Standard DES tables from FIPS 46-3, section 3 and Appendix 1.
#[cfg(unix)]
const IP: [u8; 64] = [
	58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4,
	62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8,
	57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3,
	61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7,
];
#[cfg(unix)]
const FP: [u8; 64] = [
	40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31,
	38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29,
	36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27,
	34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25,
];
#[cfg(unix)]
const PC1: [u8; 56] = [
	57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2,
	59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39,
	31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37,
	29, 21, 13, 5, 28, 20, 12, 4,
];
#[cfg(unix)]
const PC2: [u8; 48] = [
	14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4,
	26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40,
	51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32,
];
#[cfg(unix)]
const E: [u8; 48] = [
	32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11,
	12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21,
	22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1,
];
#[cfg(unix)]
const P: [u8; 32] = [
	16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10,
	2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25,
];
#[cfg(unix)]
const S: [[u8; 64]; 8] = [
	[14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7,
	 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8,
	 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0,
	 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
	[15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10,
	 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5,
	 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15,
	 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
	[10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8,
	 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1,
	 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7,
	 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
	[7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15,
	 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9,
	 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4,
	 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
	[2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9,
	 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6,
	 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14,
	 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
	[12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11,
	 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8,
	 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6,
	 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
	[4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1,
	 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6,
	 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2,
	 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
	[13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7,
	 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2,
	 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8,
	 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];

#[cfg(unix)]
const SP: [[u32; 64]; 8] = {
	let mut table = [[0; 64]; 8];
	let mut i = 0;
	while i < 8 {
		let mut x = 0;
		while x < 64 {
			let row = ((x & 32) >> 4) | (x & 1);
			let col = (x >> 1) & 15;
			let nibble = (S[i][16 * row + col] as u64) << (28 - 4 * i);
			table[i][x] = permute(nibble, 32, &P) as u32;
			x += 1;
		}
		i += 1;
	}
	table
};
