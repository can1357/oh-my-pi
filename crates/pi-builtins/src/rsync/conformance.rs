//! Differential conformance suite: the builtin against the reference rsync
//! 3.5.1 on identical fixtures.
//!
//! Every scenario (see [`cases`]) builds the same fixture ([`fixture`]) twice,
//! in `<base>/ours` and `<base>/theirs`, runs the builtin
//! ([`run_util`]) in one and the reference binary in the other with the same
//! arguments, and requires equal:
//!
//! - exit codes (and both equal to the table's expected code);
//! - stdout and stderr after [`normalize`] (each rule is documented there);
//! - the work directory afterwards ([`snapshot`]): names, types, contents,
//!   permission bits, owners, mtimes (to the nanosecond when not set by the
//!   run itself), symlink targets, hard-link groups, empty directories.
//!
//! The reference itself is not deterministic run to run: its three local
//! processes (and a remote peer) report through one stream, so sender,
//! generator, and receiver lines interleave differently, and its byte totals
//! (`Total bytes sent/received`, the `sent … received …` summary) depend on
//! how many multiplexed frames each run happened to flush. Rather than mask
//! those values, the comparison stays exact and samples the reference: when
//! ours differs from the reference in any way, the reference is rerun on a
//! fresh fixture up to [`REFERENCE_RETRIES`] times, and the scenario passes if
//! ours exactly equals (exit code, normalized stdout and stderr, tree) any
//! one reference outcome. A real bug still fails because ours matches none of
//! them; the failure report names how many distinct reference outcomes were
//! seen and diffs ours against the first.
//!
//! The reference runs with an empty environment (plus `TZ` when set, so
//! local-time output uses one zone on both sides), matching the test host's
//! empty shell environment; the fake remote shell, the reference server, and
//! the password files are named by the same absolute paths on both sides.
//! The suite skips itself when no rsync 3.5.1 is installed. Set
//! `RSYNC_CONFORMANCE_FILTER=<substring>` to run only matching scenarios.
#![cfg(unix)]

mod cases;
mod daemon;
mod fixture;
mod normalize;
mod snapshot;

use std::fmt::Write as _;
use std::fs;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use self::daemon::Daemon;
use self::normalize::normalize;
use self::snapshot::Snapshot;
use crate::host::run_util;
use crate::rsync::Rsync;

/// How many extra reference runs a mismatch gets.
const REFERENCE_RETRIES: usize = 8;

/// One scenario: see [`cases`] for the field conventions.
struct Case {
	name: &'static str,
	exit: i32,
	tweaks: &'static str,
	args: &'static [&'static str],
	/// Compare stdout as a sorted multiset of lines.
	unordered: bool,
}

/// A table row.
const fn c(name: &'static str, exit: i32, tweaks: &'static str, args: &'static [&'static str]) -> Case {
	Case { name, exit, tweaks, args, unordered: false }
}

/// A table row whose stdout order is racy in the reference.
const fn u(name: &'static str, exit: i32, tweaks: &'static str, args: &'static [&'static str]) -> Case {
	Case { name, exit, tweaks, args, unordered: true }
}

/// How the scenario reaches its peer.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Local,
	/// `-e {RSH} --rsync-path={REF}` prepended.
	Rsh,
	/// A reference daemon per side; `{PORT}` is its port.
	Daemon,
}

/// Which client runs.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Client {
	Ours,
	Reference,
}

/// Everything compared about one run.
#[derive(PartialEq, Eq)]
struct Outcome {
	code: i32,
	out: Vec<u8>,
	err: Vec<u8>,
	tree: Snapshot,
}

/// The reference rsync 3.5.1 binary, when one is installed. Other versions
/// are skipped: the builtin's output is byte-for-byte 3.5.1's.
fn reference() -> Option<PathBuf> {
	let mut candidates = vec![PathBuf::from("/opt/homebrew/bin/rsync")];
	if let Some(path) = std::env::var_os("PATH") {
		candidates.extend(std::env::split_paths(&path).map(|d| d.join("rsync")));
	}
	candidates.into_iter().find(|p| {
		Command::new(p).arg("--version").env_clear().output().is_ok_and(|o| {
			String::from_utf8_lossy(&o.stdout).starts_with("rsync  version 3.5.1  protocol version 33\n")
		})
	})
}

fn now_ns() -> i128 {
	SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos() as i128
}

/// Shared per-scenario state: the base directory holding both sides plus the
/// helpers both clients use by the same absolute path.
struct Bench {
	base: PathBuf,
	reference: PathBuf,
	mode: Mode,
}

impl Bench {
	fn new(base: &Path, reference: &Path, mode: Mode) -> Self {
		let bin = base.join("bin");
		fs::create_dir_all(&bin).unwrap();
		// Like ssh, the fake remote shell drops the host name and hands the
		// rest to a shell as one command line (so `--old-args` word splitting
		// happens remotely). The remote command runs in the client's cwd.
		let rsh = bin.join("fakersh");
		fs::write(&rsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$*\"\n").unwrap();
		fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
		for (name, password) in [("pw", "sekrit\n"), ("badpw", "wrong\n")] {
			let file = bin.join(name);
			fs::write(&file, password).unwrap();
			fs::set_permissions(&file, fs::Permissions::from_mode(0o600)).unwrap();
		}
		Self { base: base.to_path_buf(), reference: reference.to_path_buf(), mode }
	}

	/// The scenario's argv for a daemon on `port`.
	fn argv(&self, case: &Case, port: u16) -> Vec<String> {
		let bin = self.base.join("bin");
		let rsh = bin.join("fakersh");
		let subst = |arg: &str| {
			arg.replace("{RSH}", &rsh.display().to_string())
				.replace("{REF}", &self.reference.display().to_string())
				.replace("{BIN}", &bin.display().to_string())
				.replace("{PORT}", &port.to_string())
		};
		let mut argv = Vec::new();
		if self.mode == Mode::Rsh {
			argv.extend(["-e".to_owned(), subst("{RSH}"), subst("--rsync-path={REF}")]);
		}
		argv.extend(case.args.iter().map(|a| subst(a)));
		argv
	}

	/// Builds the fixture in `<base>/<side>` and runs `client` there.
	fn run(&self, case: &Case, side: &str, client: Client) -> Outcome {
		let w = self.base.join(side);
		fs::create_dir_all(&w).unwrap();
		fixture::build(&w, case.tweaks);
		let daemon = (self.mode == Mode::Daemon).then(|| {
			fixture::module_root(&w);
			Daemon::start(&self.reference, &self.base.join(format!("daemon-{side}")), &w)
		});
		let argv = self.argv(case, daemon.as_ref().map_or(0, |d| d.port));
		let start = now_ns();
		let (code, out, err) = match client {
			Client::Ours => {
				let refs: Vec<&str> = argv.iter().map(String::as_str).collect();
				let (code, cap) = run_util::<Rsync>(&refs, "", &w);
				(code, cap.stdout(), cap.stderr())
			}
			Client::Reference => {
				let mut cmd = Command::new(&self.reference);
				cmd.args(&argv).current_dir(&w).env_clear();
				if let Some(tz) = std::env::var_os("TZ") {
					cmd.env("TZ", tz);
				}
				let output = cmd.output().unwrap();
				(output.status.code().unwrap_or(-1), output.stdout, output.stderr)
			}
		};
		let end = now_ns();
		drop(daemon);
		let window = ((start / 1_000_000_000) as i64, (end / 1_000_000_000) as i64);
		let wb = w.as_os_str().as_bytes();
		let mut out = normalize(&out, wb, window);
		if case.unordered {
			let sorted = sorted_lines(&out).join(&b'\n');
			out = sorted;
		}
		Outcome {
			code,
			out,
			err: normalize(&err, wb, window),
			tree: Snapshot::take(&w, start, end),
		}
	}
}

fn sorted_lines(data: &[u8]) -> Vec<&[u8]> {
	let mut lines: Vec<&[u8]> = data.split(|&byte| byte == b'\n').collect();
	lines.sort_unstable();
	lines
}

/// Runs one scenario; `Err` carries the report.
fn check(reference: &Path, mode: Mode, case: &Case) -> Result<(), String> {
	let dir = tempfile::tempdir().unwrap();
	// Canonical, so the paths both clients print agree with what `getcwd`
	// reports to the reference (macOS: /var → /private/var).
	let base = fs::canonicalize(dir.path()).unwrap();
	let bench = Bench::new(&base, reference, mode);
	let ours = bench.run(case, "ours", Client::Ours);
	// Distinct reference outcomes seen so far, first run first.
	let mut seen: Vec<Outcome> = Vec::new();
	for attempt in 0..=REFERENCE_RETRIES {
		let outcome = bench.run(case, &format!("theirs{attempt}"), Client::Reference);
		if outcome == ours {
			if ours.code == case.exit {
				return Ok(());
			}
			seen.insert(0, outcome);
			break;
		}
		if !seen.contains(&outcome) {
			seen.push(outcome);
		}
	}
	let theirs = &seen[0];
	let verdict = if ours == *theirs {
		format!("ours matched one of {} distinct reference outcome(s)", seen.len())
	} else {
		format!("ours matched none of {} distinct reference outcome(s); diff against the first", seen.len())
	};
	let mut report = format!("{} {:?}\n  {verdict}\n", case.name, bench.argv(case, 0));
	if theirs.code != case.exit {
		writeln!(report, "  reference exited {} (table expects {})", theirs.code, case.exit).unwrap();
	}
	if ours.code != theirs.code {
		writeln!(report, "  exit: ours {} vs reference {}", ours.code, theirs.code).unwrap();
	}
	for (what, a, b) in [("stdout", &ours.out, &theirs.out), ("stderr", &ours.err, &theirs.err)] {
		if a != b {
			writeln!(
				report,
				"  {what} differs:\n--- ours\n{}--- reference\n{}---",
				String::from_utf8_lossy(a),
				String::from_utf8_lossy(b)
			)
			.unwrap();
		}
	}
	report.push_str(&ours.tree.diff(&theirs.tree));
	Err(report)
}

/// Runs every scenario of `table` (a few at a time) and fails with all reports.
fn run_table(mode: Mode, table: &[Case]) {
	let Some(reference) = reference() else { return };
	let filter = std::env::var("RSYNC_CONFORMANCE_FILTER").unwrap_or_default();
	let cases: Vec<&Case> = table.iter().filter(|c| c.name.contains(filter.as_str())).collect();
	let next = AtomicUsize::new(0);
	let failures = Mutex::new(Vec::new());
	let workers = std::thread::available_parallelism().map_or(2, |n| n.get().min(4));
	std::thread::scope(|scope| {
		for _ in 0..workers {
			scope.spawn(|| {
				while let Some(case) = cases.get(next.fetch_add(1, Ordering::Relaxed)) {
					let result = std::panic::catch_unwind(|| check(&reference, mode, case))
						.unwrap_or_else(|panic| {
							let text = panic
								.downcast_ref::<String>()
								.cloned()
								.or_else(|| panic.downcast_ref::<&str>().map(|s| (*s).to_owned()))
								.unwrap_or_default();
							Err(format!("{}: harness panicked: {text}\n", case.name))
						});
					if let Err(report) = result {
						failures.lock().unwrap().push(report);
					}
				}
			});
		}
	});
	let mut failures = failures.into_inner().unwrap();
	failures.sort();
	assert!(
		failures.is_empty(),
		"{} of {} scenarios differ from rsync 3.5.1:\n\n{}",
		failures.len(),
		cases.len(),
		failures.join("\n")
	);
}

#[test]
fn local_transfers_match_reference() {
	run_table(Mode::Local, cases::LOCAL);
}

#[test]
fn remote_shell_transfers_match_reference() {
	run_table(Mode::Rsh, cases::RSH);
}

#[test]
fn daemon_transfers_match_reference() {
	run_table(Mode::Daemon, cases::DAEMON);
}
