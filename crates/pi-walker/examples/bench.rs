//! Walk timing harness, mirrored by gogrep's `walkbench`.
//!
//! Usage: bench (collect|parallel|tree) ROOT [--hidden] [--gitignore]
//! [--skip-git]        [--skip-nm] [--detail=min|full] [--cache] [--sorted]
//! [--workers=N]        [--iters=N] [--list]
//!
//! `collect` gathers every entry (path-sorted with `--sorted`, as
//! `walkbench collect` always does) and counts regular files; `parallel`
//! counts files from the streaming walk; `tree` counts files of the ordered
//! [`walk::Tree`] traversal (`--workers=1`: no read-ahead). `--list` prints
//! the files' sorted relative paths instead of timing.

use std::{
	hint::black_box,
	path::PathBuf,
	time::{Duration, Instant},
};

use futures::StreamExt;
use pi_walker::{Detail, FileType, Fs, walk};

struct Args {
	mode:   String,
	root:   PathBuf,
	opts:   walk::Options,
	sorted: bool,
	iters:  usize,
	list:   bool,
}

fn parse() -> Args {
	let mut argv = std::env::args().skip(1);
	let mode = argv
		.next()
		.expect("usage: bench (collect|parallel) ROOT [flags]");
	let root = PathBuf::from(argv.next().expect("root"));
	let mut args =
		Args { mode, root, opts: walk::Options::default(), sorted: false, iters: 10, list: false };
	for arg in argv {
		match arg.as_str() {
			"--hidden" => args.opts.hidden = true,
			"--gitignore" => args.opts.gitignore = true,
			"--skip-git" => args.opts.skip_git = true,
			"--skip-nm" => args.opts.skip_node_modules = true,
			"--detail=min" => args.opts.detail = Detail::Minimal,
			"--detail=full" => args.opts.detail = Detail::Full,
			"--cache" => args.opts.cache = true,
			"--sorted" => args.sorted = true,
			"--list" => args.list = true,
			"--order=path" | "--order=unordered" => {},
			other => {
				if let Some(n) = other.strip_prefix("--iters=") {
					args.iters = n.parse().expect("--iters=N");
				} else if let Some(n) = other.strip_prefix("--workers=") {
					args.opts.workers = Some(n.parse().expect("--workers=N"));
				} else {
					panic!("unknown flag {other}");
				}
			},
		}
	}
	args
}

async fn collect(args: &Args, list: Option<&mut Vec<String>>) -> usize {
	let entries = walk::collect(&Fs::native(), &args.root, &args.opts, args.sorted, |_, _| {
		walk::Action::Continue
	})
	.await
	.expect("collect");
	let files = entries
		.iter()
		.filter(|entry| entry.file_type == FileType::File);
	match list {
		Some(list) => {
			list.extend(files.map(|entry| entry.path_lossy().into_owned()));
			list.len()
		},
		None => black_box(files.count()),
	}
}

async fn parallel(args: &Args, mut list: Option<&mut Vec<String>>) -> usize {
	let listing = list.is_some();
	let mut walked = walk::walk(
		&Fs::native(),
		&args.root,
		&args.opts,
		move |_, entry, out: &mut Vec<Option<String>>| {
			if entry.file_type == FileType::File {
				out.push(listing.then(|| entry.path_lossy().into_owned()));
			}
			walk::Action::Continue
		},
	)
	.await
	.expect("walk");
	let mut files = 0;
	while let Some(batch) = walked.next().await {
		files += batch.items.len();
		if let Some(list) = &mut list {
			list.extend(batch.items.into_iter().flatten());
		}
	}
	files
}

async fn tree(args: &Args, mut list: Option<&mut Vec<String>>) -> usize {
	let opts = walk::TreeOptions {
		hidden: args.opts.hidden,
		gitignore: args.opts.gitignore,
		skip_git: args.opts.skip_git,
		skip_node_modules: args.opts.skip_node_modules,
		detail: args.opts.detail,
		workers: args.opts.workers,
		..walk::TreeOptions::default()
	};
	let mut tree = walk::Tree::new(&Fs::native(), &args.root, &opts)
		.await
		.expect("tree");
	let mut files = 0;
	while let Some(event) = tree.next().await {
		if let walk::Event::Entry(entry) = event
			&& entry.file_type == FileType::File
		{
			files += 1;
			if let Some(list) = &mut list {
				list.push(String::from_utf8_lossy(entry.path).into_owned());
			}
		}
	}
	files
}

async fn run(args: &Args, list: Option<&mut Vec<String>>) -> usize {
	match args.mode.as_str() {
		"collect" => collect(args, list).await,
		"parallel" => parallel(args, list).await,
		"tree" => tree(args, list).await,
		other => panic!("unknown mode {other}"),
	}
}

#[tokio::main]
async fn main() {
	let args = parse();
	if args.list {
		if args.opts.cache {
			run(&args, None).await;
		}
		let mut paths = Vec::new();
		run(&args, Some(&mut paths)).await;
		paths.sort_unstable();
		for path in paths {
			println!("{path}");
		}
		return;
	}
	let files = run(&args, None).await;
	let mut timings = Vec::with_capacity(args.iters);
	for _ in 0..args.iters {
		let started = Instant::now();
		black_box(run(&args, None).await);
		timings.push(started.elapsed());
	}
	timings.sort_unstable();
	let ms = |d: Duration| d.as_secs_f64() * 1000.0;
	println!(
		"rust {:<8} files={files} median={:.3}ms min={:.3}ms root={}",
		args.mode,
		ms(timings[timings.len() / 2]),
		ms(timings[0]),
		args.root.display()
	);
}
