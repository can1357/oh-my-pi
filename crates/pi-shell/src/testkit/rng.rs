//! Seeded xorshift64* generator: reproducible fault plans and latencies.

/// Deterministic generator; the same seed yields the same sequence.
#[derive(Clone, Debug)]
pub struct Rng(u64);

impl Rng {
	/// Generator from `seed` (any value, including 0).
	pub const fn new(seed: u64) -> Self {
		Self(seed.wrapping_mul(0x9e37_79b9_7f4a_7c15) | 1)
	}

	/// Next 64 random bits.
	pub const fn next_u64(&mut self) -> u64 {
		let mut x = self.0;
		x ^= x >> 12;
		x ^= x << 25;
		x ^= x >> 27;
		self.0 = x;
		x.wrapping_mul(0x2545_f491_4f6c_dd1d)
	}

	/// Uniform in `0..n` (0 when `n` is 0).
	pub const fn below(&mut self, n: u64) -> u64 {
		if n == 0 { 0 } else { self.next_u64() % n }
	}

	/// `true` with probability `p`.
	pub fn chance(&mut self, p: f64) -> bool {
		if p >= 1.0 {
			return true;
		}
		p > 0.0 && ((self.next_u64() >> 11) as f64 / (1u64 << 53) as f64) < p
	}
}
