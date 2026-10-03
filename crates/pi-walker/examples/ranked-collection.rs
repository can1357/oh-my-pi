use std::{env, error::Error, time::Instant};

use pi_walker::{WalkFilter, WalkOptions, WalkOrder, WalkRank, WalkRequest};

fn main() -> Result<(), Box<dyn Error>> {
	let root = env::args().nth(1).ok_or("expected tree path")?;
	let limit = env::args().nth(2).unwrap_or_else(|| "100".into()).parse()?;
	let request = WalkRequest::from_options(root, WalkOptions {
		order: WalkOrder::Unordered,
		..WalkOptions::default()
	})
	.filter(WalkFilter::files_only());
	let started = Instant::now();
	let outcome = request
		.collect_ranked(WalkRank::MtimeDescPathAsc, limit)
		.map_err(|err| err.to_string())?;
	println!(
		"elapsed_ms={} scanned={} filtered={} limited={} returned={} first={:?}",
		started.elapsed().as_secs_f64() * 1000.0,
		outcome.stats.scanned_entries,
		outcome.stats.filtered_entries,
		outcome.stats.limited_entries,
		outcome.entries.len(),
		outcome.entries.first().map(|entry| &entry.path),
	);
	Ok(())
}
