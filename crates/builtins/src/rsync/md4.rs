//! MD4 message digest (RFC 1320), used for rsync daemon authentication.
//!
//! rsync announces `md4` as the weakest daemon digest and seeds the
//! pre-negotiation variant with four zero bytes; both funnel through [`md4`],
//! which hashes the concatenation of its parts as one message.

/// Round 1 nonlinear function: `(x & y) | (!x & z)`.
fn f(x: u32, y: u32, z: u32) -> u32 {
	(x & y) | (!x & z)
}

/// Round 2 nonlinear function: `(x & y) | (x & z) | (y & z)`.
fn g(x: u32, y: u32, z: u32) -> u32 {
	(x & y) | (x & z) | (y & z)
}

/// Round 3 nonlinear function: `x ^ y ^ z`.
fn h(x: u32, y: u32, z: u32) -> u32 {
	x ^ y ^ z
}

/// Computes the MD4 digest (RFC 1320) of the concatenation of `parts`.
pub(super) fn md4(parts: &[&[u8]]) -> [u8; 16] {
	let mut a0: u32 = 0x6745_2301;
	let mut b0: u32 = 0xefcd_ab89;
	let mut c0: u32 = 0x98ba_dcfe;
	let mut d0: u32 = 0x1032_5476;

	let total: usize = parts.iter().map(|part| part.len()).sum();
	let bit_length = (total as u64).wrapping_mul(8);

	let mut message = Vec::with_capacity(total + 72);
	for part in parts {
		message.extend_from_slice(part);
	}
	message.push(0x80);
	while message.len() % 64 != 56 {
		message.push(0);
	}
	message.extend_from_slice(&bit_length.to_le_bytes());

	macro_rules! round {
		($f:expr, $a:ident, $b:ident, $c:ident, $d:ident, $x:expr, $s:expr, $t:expr) => {
			$a = $a
				.wrapping_add($f($b, $c, $d))
				.wrapping_add($x)
				.wrapping_add($t)
				.rotate_left($s);
		};
	}

	for chunk in message.chunks_exact(64) {
		let mut x = [0u32; 16];
		for (i, word) in x.iter_mut().enumerate() {
			*word = u32::from_le_bytes(chunk[i * 4..i * 4 + 4].try_into().unwrap());
		}

		let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);

		// Round 1: F, shifts 3/7/11/19, no constant.
		round!(f, a, b, c, d, x[0], 3, 0);
		round!(f, d, a, b, c, x[1], 7, 0);
		round!(f, c, d, a, b, x[2], 11, 0);
		round!(f, b, c, d, a, x[3], 19, 0);
		round!(f, a, b, c, d, x[4], 3, 0);
		round!(f, d, a, b, c, x[5], 7, 0);
		round!(f, c, d, a, b, x[6], 11, 0);
		round!(f, b, c, d, a, x[7], 19, 0);
		round!(f, a, b, c, d, x[8], 3, 0);
		round!(f, d, a, b, c, x[9], 7, 0);
		round!(f, c, d, a, b, x[10], 11, 0);
		round!(f, b, c, d, a, x[11], 19, 0);
		round!(f, a, b, c, d, x[12], 3, 0);
		round!(f, d, a, b, c, x[13], 7, 0);
		round!(f, c, d, a, b, x[14], 11, 0);
		round!(f, b, c, d, a, x[15], 19, 0);

		// Round 2: G, words in order 0,4,8,12,1,…, shifts 3/5/9/13, constant 2^30*sqrt(2).
		round!(g, a, b, c, d, x[0], 3, 0x5a82_7999);
		round!(g, d, a, b, c, x[4], 5, 0x5a82_7999);
		round!(g, c, d, a, b, x[8], 9, 0x5a82_7999);
		round!(g, b, c, d, a, x[12], 13, 0x5a82_7999);
		round!(g, a, b, c, d, x[1], 3, 0x5a82_7999);
		round!(g, d, a, b, c, x[5], 5, 0x5a82_7999);
		round!(g, c, d, a, b, x[9], 9, 0x5a82_7999);
		round!(g, b, c, d, a, x[13], 13, 0x5a82_7999);
		round!(g, a, b, c, d, x[2], 3, 0x5a82_7999);
		round!(g, d, a, b, c, x[6], 5, 0x5a82_7999);
		round!(g, c, d, a, b, x[10], 9, 0x5a82_7999);
		round!(g, b, c, d, a, x[14], 13, 0x5a82_7999);
		round!(g, a, b, c, d, x[3], 3, 0x5a82_7999);
		round!(g, d, a, b, c, x[7], 5, 0x5a82_7999);
		round!(g, c, d, a, b, x[11], 9, 0x5a82_7999);
		round!(g, b, c, d, a, x[15], 13, 0x5a82_7999);

		// Round 3: H, words in order 0,8,4,12,2,…, shifts 3/9/11/15, constant 2^30*sqrt(3).
		round!(h, a, b, c, d, x[0], 3, 0x6ed9_eba1);
		round!(h, d, a, b, c, x[8], 9, 0x6ed9_eba1);
		round!(h, c, d, a, b, x[4], 11, 0x6ed9_eba1);
		round!(h, b, c, d, a, x[12], 15, 0x6ed9_eba1);
		round!(h, a, b, c, d, x[2], 3, 0x6ed9_eba1);
		round!(h, d, a, b, c, x[10], 9, 0x6ed9_eba1);
		round!(h, c, d, a, b, x[6], 11, 0x6ed9_eba1);
		round!(h, b, c, d, a, x[14], 15, 0x6ed9_eba1);
		round!(h, a, b, c, d, x[1], 3, 0x6ed9_eba1);
		round!(h, d, a, b, c, x[9], 9, 0x6ed9_eba1);
		round!(h, c, d, a, b, x[5], 11, 0x6ed9_eba1);
		round!(h, b, c, d, a, x[13], 15, 0x6ed9_eba1);
		round!(h, a, b, c, d, x[3], 3, 0x6ed9_eba1);
		round!(h, d, a, b, c, x[11], 9, 0x6ed9_eba1);
		round!(h, c, d, a, b, x[7], 11, 0x6ed9_eba1);
		round!(h, b, c, d, a, x[15], 15, 0x6ed9_eba1);

		a0 = a0.wrapping_add(a);
		b0 = b0.wrapping_add(b);
		c0 = c0.wrapping_add(c);
		d0 = d0.wrapping_add(d);
	}

	let mut digest = [0u8; 16];
	digest[0..4].copy_from_slice(&a0.to_le_bytes());
	digest[4..8].copy_from_slice(&b0.to_le_bytes());
	digest[8..12].copy_from_slice(&c0.to_le_bytes());
	digest[12..16].copy_from_slice(&d0.to_le_bytes());
	digest
}

#[cfg(test)]
mod tests {
	use super::md4;

	fn hex(parts: &[&[u8]]) -> String {
		md4(parts).iter().map(|byte| format!("{byte:02x}")).collect()
	}

	#[test]
	fn rfc1320_vectors() {
		let cases: [(&[u8], &str); 6] = [
			(b"", "31d6cfe0d16ae931b73c59d7e0c089c0"),
			(b"a", "bde52cb31de33e46245e05fbdbd6fb24"),
			(b"abc", "a448017aaf21d8525fc10ae87aa6729d"),
			(b"message digest", "d9130a8164549fe818874806e1c7014b"),
			(b"abcdefghijklmnopqrstuvwxyz", "d79e1c308aa5bbcdeea8ed63df412da9"),
			(
				b"12345678901234567890123456789012345678901234567890123456789012345678901234567890",
				"e33b4ddc9c38f2199c3e7b164fcc0536",
			),
		];
		for (input, expected) in cases {
			assert_eq!(hex(&[input]), expected, "input {input:?}");
		}
	}

	#[test]
	fn split_parts_match_joined() {
		let joined = hex(&[b"abcdefghijklmnopqrstuvwxyz"]);
		let split = hex(&[b"abc", b"defgh", b"ijklmnopqrstuvwxyz"]);
		assert_eq!(joined, split);
	}
}
