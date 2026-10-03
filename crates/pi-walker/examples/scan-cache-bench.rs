use std::{
	hint::black_box,
	path::PathBuf,
	time::{Duration, Instant},
};

use pi_walker::{CollectedEntry, WalkOptions, collect_entries_without_heartbeat, invalidate_all};

fn main() -> Result<(), String> {
	let root = PathBuf::from(
		std::env::args_os()
			.nth(1)
			.ok_or("usage: scan-cache-bench ROOT")?,
	);
	let options = WalkOptions {
		cache: true,
		skip_git: true,
		skip_node_modules: true,
		..WalkOptions::default()
	};
	let initial = collect_entries_without_heartbeat(&root, WalkOptions { cache: false, ..options })
		.map_err(|error| error.to_string())?;
	let payload_bytes = initial.entries.capacity() * size_of::<CollectedEntry>()
		+ initial
			.entries
			.iter()
			.map(|entry| entry.path.capacity())
			.sum::<usize>();
	let count = initial.entries.len();
	let started = Instant::now();
	for _ in 0..16 {
		black_box(initial.entries.clone());
	}
	println!(
		"entries={count} scan_payload_bytes={payload_bytes} clone_16_ms={:.3}",
		started.elapsed().as_secs_f64() * 1000.0
	);
	drop(initial);
	invalidate_all();
	for depth in 32..48 {
		black_box(
			collect_entries_without_heartbeat(&root, WalkOptions { max_depth: depth, ..options })
				.map_err(|error| error.to_string())?,
		);
	}
	std::thread::sleep(Duration::from_millis(2));
	let started = Instant::now();
	let mut hits = 0;
	for depth in (32..48).rev() {
		let scan =
			collect_entries_without_heartbeat(&root, WalkOptions { max_depth: depth, ..options })
				.map_err(|error| error.to_string())?;
		hits += usize::from(scan.cache_age_ms > 0);
		black_box(scan);
	}
	println!(
		"second_pass_cache_hits={hits}/16 second_pass_ms={:.3}",
		started.elapsed().as_secs_f64() * 1000.0
	);
	Ok(())
}
