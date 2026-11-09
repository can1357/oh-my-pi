//! Timing statistics shared by the shell benchmarks.

use std::time::Duration;

/// Median and p99 of a nonempty sample, sorted in place for benchmark
/// reporting.
///
/// # Panics
/// Panics when `samples` is empty.
pub fn quantiles(samples: &mut [Duration]) -> (Duration, Duration) {
	samples.sort_unstable();
	(samples[samples.len() / 2], samples[samples.len() * 99 / 100])
}
