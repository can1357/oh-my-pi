//! Per-journal monotonic ULID generation.

use std::time::{SystemTime, UNIX_EPOCH};

use omp_core::Ulid;
use thiserror::Error;

/// A monotonic ULID generator scoped to one journal.
#[derive(Clone, Copy, Debug, Default)]
pub struct MonotonicUlid {
	last: Option<u128>,
}

impl MonotonicUlid {
	/// Creates a generator whose next identity is greater than `floor`.
	#[must_use]
	pub fn seeded(floor: Option<Ulid>) -> Self {
		Self { last: floor.map(|value| u128::from_be_bytes(value.to_bytes())) }
	}

	/// Generates the next strictly increasing ULID.
	///
	/// # Errors
	///
	/// Returns [`UlidGenerationError`] only if the 128-bit identifier space has
	/// been exhausted.
	pub fn generate(&mut self) -> Result<Ulid, UlidGenerationError> {
		let millis = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis();
		let millis = u64::try_from(millis)
			.unwrap_or(u64::MAX)
			.min((1_u64 << 48) - 1);
		self.generate_at(millis)
	}

	fn generate_at(&mut self, millis: u64) -> Result<Ulid, UlidGenerationError> {
		let candidate = match self.last {
			Some(last) if millis <= timestamp(last) => {
				last.checked_add(1).ok_or(UlidGenerationError::Exhausted)?
			},
			_ => {
				let mut bytes = Ulid::generate().to_bytes();
				bytes[..6].copy_from_slice(&millis.to_be_bytes()[2..]);
				u128::from_be_bytes(bytes)
			},
		};
		self.last = Some(candidate);
		Ok(Ulid::from_bytes(candidate.to_be_bytes()))
	}
}

/// Monotonic ULID generation failure.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Error)]
pub enum UlidGenerationError {
	/// Every representable ULID has been consumed.
	#[error("ULID space is exhausted")]
	Exhausted,
}

const fn timestamp(value: u128) -> u64 {
	(value >> 80) as u64
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn ten_thousand_ids_are_strictly_increasing_within_one_millisecond() {
		let mut generator = MonotonicUlid::default();
		let mut previous = generator.generate_at(42).expect("first id");
		for _ in 1..10_000 {
			let next = generator.generate_at(42).expect("next id");
			assert!(next > previous);
			assert_eq!(timestamp(u128::from_be_bytes(next.to_bytes())), 42);
			previous = next;
		}
	}
}
