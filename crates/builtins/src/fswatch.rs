//! The `fswatch` builtin: fswatch 1.22's command line and output on the
//! shared watcher (`omp-xfs`), so it behaves alike wherever the shell runs.
//!
//! The watcher delivers batches on a thread of its own, where they are
//! filtered and formatted; the body only writes what arrives, fires idle
//! events and ends on `-1`.

mod options;
mod output;
#[cfg(test)]
mod tests;

use std::{
	ffi::OsString,
	io::{self, Write as _},
	path::{Path, PathBuf},
	sync::Arc,
	time::Duration,
};

use clap::Parser;
use omp_xfs::watch::{Backend, Batch, Config, Root, Watcher};

use self::{
	options::{EXIT_ERROR, Exit, FilterSpec, Options},
	output::{Overflowed, Printer},
};
use crate::{
	host::{AsyncUtility, Host},
	time_zone::shell_time_zone,
};

/// Reports file-system changes below the given paths.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct Fswatch {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<OsString>,
}

/// What the watcher's thread hands the body.
enum Report {
	/// The output of one batch; empty when the filters left nothing of it.
	Batch(Vec<u8>),
	/// Events were lost and `--allow-overflow` was not given.
	Overflow,
	/// The watch ended on its own.
	Failed(io::Error),
}

/// One line of a `--filter-from` file: `None` for a blank line or a comment,
/// `Err` for a line that is no filter.
fn filter_line(line: &str) -> Option<Result<FilterSpec, ()>> {
	if line.is_empty() || line.starts_with('#') {
		return None;
	}
	// `+` or `-`, then `e` (extended) and `i` (case insensitive) in any
	// number, a space, and the expression.
	let include = match line.as_bytes()[0] {
		b'+' => true,
		b'-' => false,
		_ => return Some(Err(())),
	};
	let rest = &line[1..];
	let modifiers = rest.bytes().take_while(|byte| matches!(byte, b'e' | b'i')).count();
	let Some(pattern) = rest[modifiers..].strip_prefix(' ').filter(|pattern| !pattern.is_empty())
	else {
		return Some(Err(()));
	};
	// Trailing spaces go, unless a backslash escapes them.
	let mut text = pattern.to_owned();
	while text.len() > 1 && text.ends_with(' ') {
		let escapes = text[..text.len() - 1].bytes().rev().take_while(|&byte| byte == b'\\').count();
		if escapes % 2 != 0 {
			break;
		}
		text.pop();
	}
	if text == " " {
		return Some(Err(()));
	}
	Some(Ok(FilterSpec {
		text,
		include,
		extended: rest[..modifiers].contains('e'),
		case_sensitive: !rest[..modifiers].contains('i'),
	}))
}

/// The `-e` and `-i` filters, which `-E` and `-I` apply to alike.
fn command_filters(options: &Options) -> Vec<FilterSpec> {
	options
		.filters
		.iter()
		.map(|filter| FilterSpec {
			text:           filter.text.clone(),
			include:        filter.include,
			extended:       options.extended,
			case_sensitive: !options.insensitive,
		})
		.collect()
}

/// `path` with its symbolic links resolved, as FSEvents names it; what does
/// not exist yet keeps its spelling below the part that does.
fn canonical(path: &Path) -> PathBuf {
	let mut below = Vec::new();
	let mut existing = path;
	loop {
		if let Ok(mut real) = std::fs::canonicalize(existing) {
			real.extend(below.iter().rev());
			return real;
		}
		match (existing.parent(), existing.file_name()) {
			(Some(parent), Some(name)) => {
				below.push(name);
				existing = parent;
			},
			_ => return path.to_path_buf(),
		}
	}
}

/// What to watch, as fswatch's `backend` monitor would.
fn config(options: &Options, backend: Backend, host: &Host) -> Config {
	let roots = options.paths.iter().filter_map(|path| {
		let path = host.resolve(path);
		// FSEvents reports real paths whatever the stream was given, and its
		// streams, like `ReadDirectoryChangesW` as fswatch calls it, always
		// cover the subtree.
		let path = if backend == Backend::FsEvents { canonical(&path) } else { path };
		let recursive =
			options.recursive || matches!(backend, Backend::FsEvents | Backend::Windows);
		// `-d`: the monitors that open what they watch skip files.
		let skipped = options.directories
			&& matches!(backend, Backend::Inotify | Backend::Kqueue)
			&& !path.is_dir();
		(!skipped).then_some(Root { path, recursive })
	});
	let mut config = Config::new(roots);
	config.backend = backend;
	// One record per event the system reports, with its flags as reported.
	config.coalesce = false;
	config.stat_ambiguous = false;
	config.follow_links = options.follow_links;
	config.access = options.access;
	let latency = Duration::try_from_secs_f64(options.latency).unwrap_or(Duration::MAX);
	match backend {
		Backend::FsEvents => {
			config.latency = latency;
			config.no_defer = options.no_defer
				|| match options.property("darwin.eventStream.noDefer") {
					Some(value) if !value.is_empty() => value == "true",
					_ => !host.stdin.file().is_terminal(),
				};
		},
		// fswatch sleeps whole seconds between scans, one at least.
		Backend::Poll => config.poll_interval = Duration::from_secs(options.latency.max(1.0) as u64),
		// The other monitors report as soon as the system does; the latency
		// gathers what follows a first event.
		_ => {
			config.latency = latency;
			config.no_defer = true;
		},
	}
	config.buffer_bytes = options
		.property("windows.ReadDirectoryChangesW.buffer.size")
		.and_then(|size| size.parse().ok());
	config
}

impl Fswatch {
	/// Reads the filter files, compiles the filters and starts the watcher.
	///
	/// # Errors
	///
	/// fswatch's report of what keeps the monitor from starting.
	async fn start(
		options: &Options,
		host: &mut Host,
	) -> Result<(Watcher, Arc<Printer>, flume::Receiver<Report>, flume::Sender<Vec<u8>>), Exit> {
		let mut filters = command_filters(options);
		for file in &options.filter_files {
			let Ok(content) = host.vfs().read(host.resolve(file)).await else {
				return Err(Exit::error(
					EXIT_ERROR,
					format!("File not found: {}", file.to_string_lossy()),
				));
			};
			for line in String::from_utf8_lossy(&content).lines() {
				match filter_line(line) {
					Some(Ok(filter)) => filters.push(filter),
					Some(Err(())) => {
						let _ = writeln!(host.stderr, "Invalid filter: {line}");
					},
					None => {},
				}
			}
		}
		if options.latency < 0.0 {
			return Err(Exit::error(EXIT_ERROR, "Latency cannot be negative.\nStatus code: 1024"));
		}
		let printer = Arc::new(Printer::new(options, &filters, shell_time_zone(host))?);
		let prune = options
			.prune
			.iter()
			.map(|text| output::compile(text, options.extended, !options.insensitive))
			.collect::<Result<Vec<_>, _>>()?;

		let backend = options
			.monitor
			.as_deref()
			.and_then(Backend::from_monitor_name)
			.unwrap_or_default()
			.resolve();
		let mut config = config(options, backend, host);
		config.file_ids = printer.wants_correlation();
		if !prune.is_empty() {
			config.descend = Some(Box::new(move |directory: &Path| {
				let directory = directory.as_os_str().as_encoded_bytes();
				!prune.iter().any(|regex| regex.is_match(directory))
			}));
		}

		let (reports, received) = flume::unbounded();
		// Output buffers the body is done with, for the next batches.
		let (spare, spares) = flume::bounded::<Vec<u8>>(4);
		let sink = {
			let printer = Arc::clone(&printer);
			move |batch: io::Result<&Batch>| {
				let report = match batch {
					Ok(batch) => {
						let mut out = spares.try_recv().unwrap_or_default();
						match printer.batch(backend, batch, &mut out) {
							Ok(_) => Report::Batch(out),
							Err(Overflowed) => Report::Overflow,
						}
					},
					Err(error) => Report::Failed(error),
				};
				let _ = reports.send(report);
			}
		};
		match Watcher::start(config, sink) {
			Ok(watcher) => Ok((watcher, printer, received, spare)),
			Err(error) => Err(Exit::error(EXIT_ERROR, format!("fswatch: {error}"))),
		}
	}

	/// Writes what the watcher reports until `-1` is satisfied or the watch
	/// ends; the shell's cancellation drops the body, and the watcher with it.
	async fn watch(options: &Options, host: &mut Host) -> Result<i32, Exit> {
		let (_watcher, printer, reports, spare) = Self::start(options, host).await?;
		// What the filter files had wrong is said before the wait begins.
		let _ = host.sync_output().await;
		// fswatch fires an idle event once nothing was reported for a tenth
		// longer than the latency.
		let idle = options
			.idle_events
			.then(|| Duration::try_from_secs_f64(options.latency * 1.1).unwrap_or(Duration::MAX));
		let mut stdout = host.stdout_writer();
		loop {
			let report = match idle {
				Some(idle) => match tokio::time::timeout(idle, reports.recv_async()).await {
					Ok(report) => report,
					Err(_) => {
						let mut out = Vec::new();
						printer.idle(&mut out);
						Ok(Report::Batch(out))
					},
				},
				None => reports.recv_async().await,
			};
			let mut out = match report {
				Ok(Report::Batch(out)) => out,
				Ok(Report::Overflow) => {
					return Err(Exit::error(EXIT_ERROR, "Event queue overflow.\nStatus code: 1"));
				},
				Ok(Report::Failed(error)) => {
					return Err(Exit::error(EXIT_ERROR, format!("fswatch: {error}")));
				},
				// The watcher is gone, which it is not while this holds it.
				Err(flume::RecvError::Disconnected) => return Ok(0),
			};
			if !out.is_empty() {
				let written = stdout.write_all(&out);
				// fswatch flushes every record, into a file as well.
				let delivered = host.sync_output().await;
				if host.sigpipe_hit() {
					return Ok(0);
				}
				if written.and(delivered).is_err() {
					return Ok(1);
				}
				if options.one_event {
					return Ok(0);
				}
				out.clear();
			}
			let _ = spare.try_send(out);
		}
	}
}

impl AsyncUtility for Fswatch {
	const NAME: &'static str = "fswatch";

	/// Puts a `--` ahead of the arguments so clap hands every one through:
	/// fswatch's options are read as `getopt_long` reads them.
	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		if !argv.is_empty() {
			argv.insert(1, "--".into());
		}
		Ok(argv)
	}

	async fn run(self, host: &mut Host) -> i32 {
		let outcome = match options::parse(&self.argv) {
			Ok(options) => Self::watch(&options, host).await,
			Err(exit) => Err(exit),
		};
		match outcome {
			Ok(code) => code,
			Err(Exit { code, stdout, stderr }) => {
				let _ = host.stdout_writer().write_all(stdout.as_bytes());
				let _ = host.stderr.write_all(stderr.as_bytes());
				code
			},
		}
	}
}
