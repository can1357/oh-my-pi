use std::time::Duration;

#[derive(Clone, Debug)]
pub struct RestartBackoff {
	failures: u32,
	base:     Duration,
	maximum:  Duration,
}

impl Default for RestartBackoff {
	fn default() -> Self {
		Self { failures: 0, base: Duration::from_millis(500), maximum: Duration::from_secs(30) }
	}
}

impl RestartBackoff {
	pub fn next_delay(&mut self) -> Duration {
		let multiplier = 1_u32.checked_shl(self.failures.min(16)).unwrap_or(u32::MAX);
		self.failures = self.failures.saturating_add(1);
		self.base.saturating_mul(multiplier).min(self.maximum)
	}

	pub const fn reset(&mut self) {
		self.failures = 0;
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn restart_delay_is_exponential_and_bounded() {
		let mut policy = RestartBackoff::default();
		assert_eq!(policy.next_delay(), Duration::from_millis(500));
		assert_eq!(policy.next_delay(), Duration::from_secs(1));
		assert_eq!(policy.next_delay(), Duration::from_secs(2));
		for _ in 0..20 {
			assert!(policy.next_delay() <= Duration::from_secs(30));
		}
		policy.reset();
		assert_eq!(policy.next_delay(), Duration::from_millis(500));
	}
}
