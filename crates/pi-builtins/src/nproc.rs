//! `nproc` builtin: print the number of processing units available.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{io::Write, thread};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, util};

static OPT_ALL: &str = "all";
static OPT_IGNORE: &str = "ignore";

/// Parsed `nproc` invocation.
pub(crate) struct Nproc {
	matches: ArgMatches,
}

matches_parser!(Nproc, app);

impl Utility for Nproc {
	const NAME: &'static str = "nproc";

	fn run(self, host: &mut Host) -> i32 {
		let ignore = match self.matches.get_one::<String>(OPT_IGNORE) {
			Some(numstr) => match numstr.trim().parse::<usize>() {
				Ok(num) => num,
				Err(error) => {
					host.error(format!("{} is not a valid number: {error}", numstr.quote()), 1);
					return 1;
				},
			},
			None => 0,
		};

		let limit = match host.var("OMP_THREAD_LIMIT") {
			// Use the OpenMP variable to limit the number of threads. A parse
			// failure or zero means no limit.
			Some(threads) => match threads.parse() {
				Ok(0) | Err(_) => usize::MAX,
				Ok(n) => n,
			},
			None => usize::MAX,
		};

		let mut cores = if self.matches.get_flag(OPT_ALL) {
			num_cpus_all()
		} else {
			match host.var("OMP_NUM_THREADS") {
				Some(threads) => {
					// OMP_NUM_THREADS may be "x,y,z"; GNU nproc uses only the
					// first value. A parse failure or zero falls back to CPU detection.
					match threads.split_terminator(',').next() {
						None => available_parallelism(),
						Some(value) => match value.trim().parse() {
							Ok(0) | Err(_) => available_parallelism(),
							Ok(n) => n,
						},
					}
				},
				None => available_parallelism(),
			}
		};

		cores = std::cmp::min(limit, cores);
		if cores <= ignore {
			cores = 1;
		} else {
			cores -= ignore;
		}

		if let Err(error) = writeln!(host.stdout, "{cores}") {
			host.error(error, 1);
			return 1;
		}
		0
	}
}

fn app() -> Command {
	Command::new("nproc")
		.version("0.8.0")
		.about(
			"Print the number of cores available to the current process.\nIf the OMP_NUM_THREADS or \
			 OMP_THREAD_LIMIT environment variables are set, then\nthey will determine the minimum \
			 and maximum returned value respectively.",
		)
		.override_usage(format_usage("nproc [OPTIONS]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_ALL)
				.long(OPT_ALL)
				.help("print the number of cores available to the system")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_IGNORE)
				.long(OPT_IGNORE)
				.value_name("N")
				.help("ignore up to N cores"),
		)
}

#[cfg(unix)]
fn num_cpus_all() -> usize {
	// In some situations, /proc and /sys are not mounted, and sysconf returns 1.
	// However, we want to guarantee that `nproc --all` >= `nproc`.
	unsafe { libc::sysconf(libc::_SC_NPROCESSORS_CONF) }
		.try_into()
		.ok()
		.filter(|&n: &isize| n > 1)
		.map_or_else(available_parallelism, |n| n as usize)
}

#[cfg(not(unix))]
fn num_cpus_all() -> usize {
	available_parallelism()
}

/// Returns the available parallelism, falling back to one like GNU `nproc`.
fn available_parallelism() -> usize {
	thread::available_parallelism().map_or(1, std::num::NonZeroUsize::get)
}

/// Creates the `nproc` builtin registration.
pub(crate) fn nproc_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Nproc, SE>()
}

#[cfg(test)]
mod tests {
	use std::ffi::OsString;

	use clap::Parser;

	use super::*;

	fn run_in(env: &[(&str, &str)], args: &[&str]) -> (i32, crate::host::Capture) {
		let (mut host, capture) = Host::for_test("nproc", "", ".");
		for (key, value) in env {
			host.set_test_var(key, value);
		}
		let argv: Vec<OsString> = std::iter::once(OsString::from("nproc"))
			.chain(args.iter().map(OsString::from))
			.collect();
		let parsed = Nproc::try_parse_from(argv).expect("test arguments should parse");
		let code = parsed.run(&mut host);
		(code, capture)
	}

	#[test]
	fn host_omp_num_threads_forces_count() {
		let (code, capture) = run_in(&[("OMP_NUM_THREADS", "3")], &[]);
		assert_eq!((code, capture.out(), capture.err()), (0, "3\n".to_string(), String::new()));
	}

	#[test]
	fn omp_thread_limit_caps_omp_num_threads() {
		let (code, capture) = run_in(
			&[("OMP_NUM_THREADS", "64"), ("OMP_THREAD_LIMIT", "2")],
			&[],
		);
		assert_eq!((code, capture.out(), capture.err()), (0, "2\n".to_string(), String::new()));
	}

	#[test]
	fn all_prints_positive_integer_and_ignores_omp_num_threads() {
		let (code, capture) = run_in(&[("OMP_NUM_THREADS", "0")], &["--all"]);
		assert_eq!(code, 0);
		assert_eq!(capture.err(), "");
		let n: usize = capture.out().trim_end().parse().expect("--all output is an integer");
		assert!(n >= 1);
	}

	#[test]
	fn process_environment_is_not_consulted() {
		// A variable present only in the host process must not affect the shell
		// builtin, whose exported environment lives on `Host`.
		unsafe { std::env::set_var("OMP_NUM_THREADS", "1234") };
		let (code, capture) = run_in(&[], &[]);
		unsafe { std::env::remove_var("OMP_NUM_THREADS") };
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_ne!(capture.out(), "1234\n");
		let n: usize = capture.out().trim_end().parse().expect("output is an integer");
		assert!(n >= 1);
	}

	#[test]
	fn ignore_subtracts_and_floors_at_one() {
		let (code, capture) = run_in(&[("OMP_NUM_THREADS", "8")], &["--ignore=3"]);
		assert_eq!((code, capture.out()), (0, "5\n".to_string()));

		let (code, capture) = run_in(&[("OMP_NUM_THREADS", "2")], &["--ignore=5"]);
		assert_eq!((code, capture.out()), (0, "1\n".to_string()));
	}

	#[test]
	fn invalid_ignore_value_is_an_error() {
		let (code, capture) = run_in(&[], &["--ignore=bogus"]);
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "");
		assert!(capture.err().contains("is not a valid number"), "stderr: {}", capture.err());
	}
}
