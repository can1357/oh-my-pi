//! Always-on circular buffer profiler for work scheduling.
//!
//! Samples are continuously collected into a fixed-size circular buffer.
//! Call `get_work_profile()` to retrieve the last N seconds of profiling data.

use std::{cell::RefCell, cmp::Reverse, collections::HashMap, sync::LazyLock, time::Instant};

use napi_derive::napi;
use parking_lot::Mutex;
use smallvec::SmallVec;

/// Maximum samples to keep (roughly 60s at high activity).
const MAX_SAMPLES: usize = 10_000;

/// Process start time for relative timestamps.
static PROCESS_START: LazyLock<Instant> = LazyLock::new(Instant::now);

/// Circular buffer of profiling samples.
static PROFILE_BUFFER: LazyLock<Mutex<CircularBuffer>> =
	LazyLock::new(|| Mutex::new(CircularBuffer::new(MAX_SAMPLES)));

thread_local! {
	/// Thread-local stack of active regions.
	static REGION_STACK: RefCell<SmallVec<[&'static str; 4]>> = const { RefCell::new(SmallVec::new_const()) };
}

/// A single profiling sample with timing data.
#[derive(Clone)]
struct ProfileSample {
	/// Stack of region names (from root to leaf).
	stack:        SmallVec<[&'static str; 4]>,
	/// Duration in microseconds.
	duration_us:  u64,
	/// Timestamp (microseconds since process start).
	timestamp_us: u64,
}

/// Circular buffer for samples.
struct CircularBuffer {
	samples:   Vec<ProfileSample>,
	capacity:  usize,
	write_pos: usize,
	count:     usize,
}

impl CircularBuffer {
	fn new(capacity: usize) -> Self {
		Self { samples: Vec::with_capacity(capacity), capacity, write_pos: 0, count: 0 }
	}

	fn push(&mut self, sample: ProfileSample) {
		if self.samples.len() < self.capacity {
			self.samples.push(sample);
		} else {
			self.samples[self.write_pos] = sample;
		}
		self.write_pos = (self.write_pos + 1) % self.capacity;
		self.count = self.count.saturating_add(1);
	}

	fn get_since(&self, cutoff_us: u64) -> Vec<ProfileSample> {
		self
			.samples
			.iter()
			.filter(|s| s.timestamp_us >= cutoff_us)
			.cloned()
			.collect()
	}
}

/// RAII guard that records timing when dropped.
pub struct ProfileGuard {
	region: &'static str,
	start:  Instant,
}

impl ProfileGuard {
	#[inline]
	fn new(region: &'static str) -> Self {
		REGION_STACK.with(|stack| stack.borrow_mut().push(region));
		Self { region, start: Instant::now() }
	}
}

impl Drop for ProfileGuard {
	fn drop(&mut self) {
		let duration = self.start.elapsed();
		let duration_us = duration.as_micros() as u64;
		let timestamp_us = PROCESS_START.elapsed().as_micros() as u64;

		REGION_STACK.with(|stack| {
			let mut stack = stack.borrow_mut();
			let sample =
				ProfileSample { stack: stack.iter().copied().collect(), duration_us, timestamp_us };

			if stack.last() == Some(&self.region) {
				stack.pop();
			}

			PROFILE_BUFFER.lock().push(sample);
		});
	}
}

/// Start a profiling region. Returns a guard that records timing on drop.
#[inline]
pub fn profile_region(region: &'static str) -> ProfileGuard {
	ProfileGuard::new(region)
}

// ─────────────────────────────────────────────────────────────────────────────
// Work Profile Results
// ─────────────────────────────────────────────────────────────────────────────

/// Profiling results returned to JavaScript.
#[napi(object)]
#[derive(Clone)]
pub struct WorkProfile {
	/// Folded stack format for flamegraph tools.
	pub folded:       String,
	/// Markdown summary of profiling results.
	pub summary:      String,
	/// SVG flamegraph (if generation succeeded).
	pub svg:          Option<String>,
	/// Total profiled duration in milliseconds.
	pub total_ms:     f64,
	/// Number of samples collected.
	pub sample_count: u32,
}

fn generate_folded(samples: &[ProfileSample]) -> String {
	let mut aggregated: HashMap<String, u64> = HashMap::new();

	for sample in samples {
		if sample.stack.is_empty() {
			continue;
		}
		let key = sample.stack.join(";");
		*aggregated.entry(key).or_insert(0) += sample.duration_us;
	}

	let mut sorted: Vec<_> = aggregated.into_iter().collect();
	sorted.sort_by_key(|x| Reverse(x.1));

	let mut output = String::new();
	for (stack, count) in sorted {
		output.push_str(&stack);
		output.push(' ');
		output.push_str(&count.to_string());
		output.push('\n');
	}

	output
}

fn generate_summary(samples: &[ProfileSample], window_ms: f64) -> String {
	let mut by_region: HashMap<&'static str, (u64, usize)> = HashMap::new();

	for sample in samples {
		if let Some(&region) = sample.stack.last() {
			let entry = by_region.entry(region).or_insert((0, 0));
			entry.0 += sample.duration_us;
			entry.1 += 1;
		}
	}

	let mut sorted: Vec<_> = by_region.into_iter().collect();
	sorted.sort_by_key(|x| Reverse((x.1).0));

	let total_us: u64 = sorted.iter().map(|(_, (us, _))| us).sum();
	let total_ms = total_us as f64 / 1000.0;

	let mut lines = vec![
		"# Work Profile Summary".to_string(),
		String::new(),
		format!("Window: {window_ms:.1}ms"),
		format!("Total work time: {total_ms:.1}ms"),
		format!("Samples: {}", samples.len()),
		String::new(),
		"## Time by Region".to_string(),
		String::new(),
		"| Region | Time (ms) | % | Calls |".to_string(),
		"|--------|-----------|---|-------|".to_string(),
	];

	for (region, (time_us, count)) in sorted {
		let time_ms = time_us as f64 / 1000.0;
		let pct = if total_us > 0 {
			(time_us as f64 / total_us as f64) * 100.0
		} else {
			0.0
		};
		lines.push(format!("| {region} | {time_ms:.2} | {pct:.1}% | {count} |"));
	}

	lines.join("\n")
}

fn generate_svg(folded: &str) -> Option<String> {
	use inferno::flamegraph::{self, Options};

	let mut options = Options::default();
	options.title = "Work Profile".to_string();
	options.count_name = "μs".to_string();
	options.min_width = 0.1;

	let mut svg_output = Vec::new();
	let reader = std::io::Cursor::new(folded.as_bytes());

	match flamegraph::from_reader(&mut options, reader, &mut svg_output) {
		Ok(()) => String::from_utf8(svg_output).ok(),
		Err(_) => None,
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// N-API Exports
// ─────────────────────────────────────────────────────────────────────────────

/// Get work profile data from the last N seconds.
///
/// Always-on profiling - no need to start/stop. Just call this to get
/// recent activity.
#[napi]
pub fn get_work_profile(last_seconds: f64) -> WorkProfile {
	let window_us = (last_seconds * 1_000_000.0) as u64;
	let now_us = PROCESS_START.elapsed().as_micros() as u64;
	let cutoff_us = now_us.saturating_sub(window_us);

	let samples = PROFILE_BUFFER.lock().get_since(cutoff_us);

	let folded = generate_folded(&samples);
	let summary = generate_summary(&samples, last_seconds * 1000.0);
	let svg = if folded.is_empty() {
		None
	} else {
		generate_svg(&folded)
	};

	let total_ms = samples.iter().map(|s| (s.duration_us as f64) * 0.001).sum();
	WorkProfile { folded, summary, svg, total_ms, sample_count: samples.len() as u32 }
}
