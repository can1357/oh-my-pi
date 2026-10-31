//! Times `grep` and `glob` like `scour grep|glob -bench N`: one warm-up run,
//! then `RUNS` (default 10) timed runs; prints the median and minimum.
//!
//! ```text
//! search_bench grep [-F] [-i] [-m N] [-workers N] [-cache] PATTERN ROOT
//! search_bench glob [-sort] [-m N] [-workers N] [-cache] PATTERN ROOT
//! ```
//!
//! Traversal defaults match `scour`: hidden entries skipped, ignore files
//! honoured, `.git` and `node_modules` pruned.

use std::{path::PathBuf, sync::Arc, time::Instant};

use pi_walker::{
	Fs,
	glob::{self, GlobOptions},
	grep::{self, Engine, GrepOptions},
	walk,
};

struct Args {
	literal:     bool,
	ignore_case: bool,
	sort:        bool,
	max:         Option<u64>,
	walk:        walk::Options,
	pattern:     String,
	root:        PathBuf,
}

fn parse(mut args: impl Iterator<Item = String>) -> Args {
	let mut parsed = Args {
		literal:     false,
		ignore_case: false,
		sort:        false,
		max:         None,
		walk:        walk::Options { gitignore: true, ..walk::Options::default() },
		pattern:     String::new(),
		root:        PathBuf::new(),
	};
	let mut operands = Vec::new();
	while let Some(arg) = args.next() {
		let mut value = || {
			args
				.next()
				.and_then(|v| v.parse().ok())
				.expect("flag value")
		};
		match arg.as_str() {
			"-F" => parsed.literal = true,
			"-i" => parsed.ignore_case = true,
			"-sort" => parsed.sort = true,
			"-cache" => parsed.walk.cache = true,
			"-m" => parsed.max = Some(value()),
			"-workers" => parsed.walk.workers = Some(value() as usize),
			_ => operands.push(arg),
		}
	}
	let [pattern, root] = <[String; 2]>::try_from(operands).expect("PATTERN ROOT");
	parsed.pattern = pattern;
	parsed.root = PathBuf::from(root);
	parsed
}

/// Runs `run` once to warm up, then `RUNS` times, and prints the timings
/// with the warm-up's summary.
async fn bench(summary: &str, run: impl AsyncFn()) {
	let runs: usize = std::env::var("RUNS")
		.ok()
		.and_then(|v| v.parse().ok())
		.unwrap_or(10);
	let mut times = Vec::with_capacity(runs.max(1));
	for _ in 0..runs.max(1) {
		let start = Instant::now();
		run().await;
		times.push(start.elapsed().as_secs_f64() * 1e3);
	}
	times.sort_by(f64::total_cmp);
	println!(
		"median={:.3}ms min={:.3}ms runs={} {summary}",
		times[times.len() / 2],
		times[0],
		times.len()
	);
}

#[tokio::main]
async fn main() {
	let mut args = std::env::args().skip(1);
	let mode = args.next().expect("grep or glob");
	let args = parse(args);
	let fs = Fs::native();
	match mode.as_str() {
		"grep" => {
			let pattern = if args.literal {
				regex::escape(&args.pattern)
			} else {
				args.pattern.clone()
			};
			let engine =
				Arc::new(Engine::compile(&pattern, args.ignore_case, false).expect("pattern"));
			let opts = GrepOptions {
				max_count: args.max,
				walk: args.walk.clone(),
				..GrepOptions::new(engine)
			};
			let run = async || {
				grep::grep(&fs, &args.root, opts.clone())
					.await
					.expect("grep")
			};
			let first = run().await;
			let summary = format!(
				"matches={} files_with_matches={} files_searched={}",
				first.matches.len(),
				first.files_with_matches,
				first.files_searched
			);
			bench(&summary, async || {
				run().await;
			})
			.await;
		},
		"glob" => {
			let opts = GlobOptions {
				pattern: args.pattern.clone(),
				recursive: true,
				max_results: args.max.map(|m| m as usize),
				sort_by_mtime: args.sort,
				walk: args.walk.clone(),
				..GlobOptions::default()
			};
			let run = async || glob::glob(&fs, &args.root, &opts).await.expect("glob");
			let summary = format!("matches={}", run().await.len());
			bench(&summary, async || {
				run().await;
			})
			.await;
		},
		other => panic!("unknown mode {other}"),
	}
}
