//! Modular MD5-crypt and SHA-crypt formats used by Unix crypt(3).

use md5::Md5;
use sha2::{Digest, Sha256, Sha512, digest::Output};

use crate::perl::{interp::{Flow, Interp, PResult}, value::{PStr, Value}};

use super::ALPHABET;

pub(super) fn crypt(interp: &mut Interp<'_>, pass: &[u8], salt: &[u8]) -> PResult<Value> {
	if pass.len() > 512 { return invalid(interp); }
	let salt = salt.split(|&c| c == 0).next().unwrap_or_default();
	let (magic, mut salt, max_salt) = match salt {
		[b'$', id @ (b'1' | b'5' | b'6'), b'$', salt @ ..] => (*id, salt, if *id == b'1' { 8 } else { 16 }),
		_ => return invalid(interp),
	};
	let mut rounds = 5000;
	let mut explicit = false;
	if magic != b'1' {
		if let Some(setting) = salt.strip_prefix(b"rounds=") {
			if let Some(dollar) = memchr::memchr(b'$', setting) {
				let value = std::str::from_utf8(&setting[..dollar]).ok().and_then(|s| s.parse::<u32>().ok());
				let Some(value) = value else { return invalid(interp); };
				rounds = value.clamp(1000, 999_999_999);
				explicit = true;
				salt = &setting[dollar + 1..];
			}
		}
	}
	let salt = salt.split(|&c| c == b'$').next().unwrap_or_default();
	let salt = &salt[..salt.len().min(max_salt)];
	let mut out = Vec::with_capacity(3 + 17 * usize::from(explicit) + salt.len() + 1 + 86);
	out.extend_from_slice(&[b'$', magic, b'$']);
	if explicit {
		out.extend_from_slice(b"rounds=");
		out.extend_from_slice(rounds.to_string().as_bytes());
		out.push(b'$');
	}
	out.extend_from_slice(salt);
	out.push(b'$');
	match magic {
		b'1' => {
			let hash = md5_crypt(interp, pass, salt)?;
			emit(&mut out, &hash, &[(0, 6, 12), (1, 7, 13), (2, 8, 14), (3, 9, 15), (4, 10, 5)]);
			base64(&mut out, 0, 0, hash[11], 2);
		}
		b'5' => {
			let hash = sha_crypt::<Sha256>(interp, pass, salt, rounds)?;
			emit(&mut out, &hash, &[
				(0, 10, 20), (21, 1, 11), (12, 22, 2), (3, 13, 23), (24, 4, 14),
				(15, 25, 5), (6, 16, 26), (27, 7, 17), (18, 28, 8), (9, 19, 29),
			]);
			base64(&mut out, 0, hash[31], hash[30], 3);
		}
		b'6' => {
			let hash = sha_crypt::<Sha512>(interp, pass, salt, rounds)?;
			emit(&mut out, &hash, &[
				(0, 21, 42), (22, 43, 1), (44, 2, 23), (3, 24, 45), (25, 46, 4), (47, 5, 26),
				(6, 27, 48), (28, 49, 7), (50, 8, 29), (9, 30, 51), (31, 52, 10), (53, 11, 32),
				(12, 33, 54), (34, 55, 13), (56, 14, 35), (15, 36, 57), (37, 58, 16), (59, 17, 38),
				(18, 39, 60), (40, 61, 19), (62, 20, 41),
			]);
			base64(&mut out, 0, 0, hash[63], 2);
		}
		_ => unreachable!("validated hash format"),
	}
	Ok(Value::Str(PStr::new(out, false)))
}

fn invalid(interp: &mut Interp<'_>) -> PResult<Value> {
	interp.set_errno_code(libc::EINVAL);
	Ok(Value::Undef)
}

fn emit(out: &mut Vec<u8>, hash: &[u8], order: &[(usize, usize, usize)]) {
	for &(a, b, c) in order { base64(out, hash[a], hash[b], hash[c], 4); }
}

fn base64(out: &mut Vec<u8>, a: u8, b: u8, c: u8, size: usize) {
	let mut bits = u32::from_be_bytes([0, a, b, c]);
	for _ in 0..size {
		out.push(ALPHABET[(bits & 63) as usize]);
		bits >>= 6;
	}
}

fn seed<D: Digest>(pass: &[u8], salt: &[u8]) -> Output<D> {
	let mut h = D::new();
	h.update(pass);
	h.update(salt);
	h.update(pass);
	h.finalize()
}

fn repeat_bytes(h: &mut impl Digest, pattern: &[u8], bytes: usize) {
	for _ in 0..bytes / pattern.len() { h.update(pattern); }
	h.update(&pattern[..bytes % pattern.len()]);
}

fn md5_crypt(interp: &Interp<'_>, pass: &[u8], salt: &[u8]) -> PResult<Output<Md5>> {
	let b = seed::<Md5>(pass, salt);
	let mut h = Md5::new();
	h.update(pass);
	h.update(b"$1$");
	h.update(salt);
	repeat_bytes(&mut h, &b, pass.len());
	let mut remaining = pass.len();
	while remaining != 0 {
		if remaining & 1 == 1 { h.update([0]); } else { h.update(&pass[..1]); }
		remaining >>= 1;
	}
	let mut a = h.finalize();
	for i in 0..1000 {
		if i & 0xff == 0 && interp.is_cancelled() { return Err(Flow::Cancelled); }
		let mut h = Md5::new();
		if i & 1 == 1 { h.update(pass); } else { h.update(&a); }
		if i % 3 != 0 { h.update(salt); }
		if i % 7 != 0 { h.update(pass); }
		if i & 1 == 1 { h.update(&a); } else { h.update(pass); }
		a = h.finalize();
	}
	Ok(a)
}

fn sha_crypt<D: Digest>(interp: &Interp<'_>, pass: &[u8], salt: &[u8], rounds: u32) -> PResult<Output<D>> {
	let b = seed::<D>(pass, salt);
	let mut h = D::new();
	h.update(pass);
	h.update(salt);
	repeat_bytes(&mut h, &b, pass.len());
	let mut remaining = pass.len();
	while remaining != 0 {
		if remaining & 1 == 1 { h.update(&b); } else { h.update(pass); }
		remaining >>= 1;
	}
	let mut a = h.finalize();
	let mut h = D::new();
	for i in 0..pass.len() {
		if i & 0xff == 0 && interp.is_cancelled() { return Err(Flow::Cancelled); }
		h.update(pass);
	}
	let p = h.finalize();
	let mut h = D::new();
	for _ in 0..16 + usize::from(a[0]) { h.update(salt); }
	let s = h.finalize();
	for i in 0..rounds {
		if i & 0xff == 0 && interp.is_cancelled() { return Err(Flow::Cancelled); }
		let mut h = D::new();
		if i & 1 == 1 { repeat_bytes(&mut h, &p, pass.len()); } else { h.update(&a); }
		if i % 3 != 0 { repeat_bytes(&mut h, &s, salt.len()); }
		if i % 7 != 0 { repeat_bytes(&mut h, &p, pass.len()); }
		if i & 1 == 1 { h.update(&a); } else { repeat_bytes(&mut h, &p, pass.len()); }
		a = h.finalize();
	}
	Ok(a)
}
