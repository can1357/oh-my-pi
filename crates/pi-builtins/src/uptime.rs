//! `uptime` builtin: tell how long the system has been running.
//!
//! Report line, user counting, and boot-time sources match the reference output.

use std::{
	ffi::{OsStr, OsString},
	io::Write,
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, ValueHint, builder::ValueParser};
use jiff::{Timestamp, tz::TimeZone};

use crate::{
	host::{Host, Utility, format_usage, matches_parser, util},
	time_zone::shell_time_zone,
};

mod options {
	pub const SINCE: &str = "since";
	pub const PATH: &str = "path";
	pub const PRETTY: &str = "pretty";
}

/// The login-records file read when no FILE operand is given (gnulib's
/// `UTMP_FILE`).
#[cfg(target_vendor = "apple")]
const UTMP_FILE: &str = "/var/run/utmpx";
#[cfg(target_os = "linux")]
const UTMP_FILE: &str = "/var/run/utmp";
#[cfg(not(any(target_vendor = "apple", target_os = "linux")))]
const UTMP_FILE: &str = "/etc/utmp";

/// Parsed `uptime` invocation.
pub(crate) struct Uptime {
	matches: ArgMatches,
}

matches_parser!(Uptime, app);

impl Utility for Uptime {
	const NAME: &'static str = "uptime";

	fn run(self, host: &mut Host) -> i32 {
		// GNU: the default file has entries of dead login processes weeded
		// out; an explicit FILE is taken as is.
		let (name, check_pids) = match self.matches.get_one::<OsString>(options::PATH) {
			Some(file) => (file.as_os_str(), false),
			None => (OsStr::new(UTMP_FILE), true),
		};
		let utmp = read_utmp(host, name, check_pids);
		let now = Timestamp::now().as_second();
		let zone = shell_time_zone(host);

		let (text, status) = if self.matches.get_flag(options::SINCE) {
			match utmp.boot_time {
				Some(boot) => (format!("{}\n", since_line(boot, &zone)), 0),
				None => return boot_time_unknown(host),
			}
		} else if self.matches.get_flag(options::PRETTY) {
			match utmp.boot_time {
				None => return boot_time_unknown(host),
				Some(boot) if boot > now => {
					host.error("boot time larger than current time", 1);
					return 1;
				},
				Some(boot) => (format!("{}\n", pretty_uptime(now - boot)), 0),
			}
		} else {
			if utmp.boot_time.is_none() {
				boot_time_unknown(host);
			}
			let (line, complete) = uptime_line(now, &zone, utmp.boot_time, utmp.users, &load_average());
			(line, i32::from(!complete))
		};
		match host.stdout.write_all(text.as_bytes()).and_then(|()| host.stdout.flush()) {
			Ok(()) => status,
			Err(error) => {
				host.error(error, 1);
				1
			},
		}
	}
}

/// GNU's diagnostic when no boot time could be determined; exit status 1.
fn boot_time_unknown(host: &mut Host) -> i32 {
	host.error("couldn't get boot time", 1);
	1
}

fn app() -> Command {
	Command::new("uptime")
		.version("0.8.0")
		.about(
			"Display the current time, the length of time the system has been up,\nthe number of \
			 users on the system, and the average number of jobs\nin the run queue over the last 1, \
			 5 and 15 minutes.",
		)
		.override_usage(format_usage("uptime [OPTION]... [FILE]"))
		.infer_long_args(true)
		.arg(
			Arg::new(options::SINCE)
				.short('s')
				.long(options::SINCE)
				.help("system up since")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PATH)
				.help("file to search boot time from")
				.action(ArgAction::Set)
				.num_args(0..=1)
				.value_parser(ValueParser::os_string())
				.value_hint(ValueHint::AnyPath),
		)
		.arg(
			Arg::new(options::PRETTY)
				.short('p')
				.long(options::PRETTY)
				.help("show uptime in pretty format")
				.action(ArgAction::SetTrue),
		)
}

/// GNU's report line for `now`, plus whether every field was known (GNU
/// exits 1 when the uptime is not).
fn uptime_line(
	now: i64,
	zone: &TimeZone,
	boot_time: Option<i64>,
	users: usize,
	loads: &[f64],
) -> (String, bool) {
	let clock = Timestamp::from_second(now)
		.map(|now| now.to_zoned(zone.clone()).strftime(" %H:%M:%S  ").to_string());
	let mut complete = clock.is_ok();
	let mut line = clock.unwrap_or_else(|_| " ??:????  ".to_owned());
	match boot_time.and_then(|boot| now.checked_sub(boot)).filter(|uptime| *uptime >= 0) {
		Some(uptime) => line.push_str(&up_duration(uptime)),
		None => {
			line.push_str("up ???? days ??:??,  ");
			complete = false;
		},
	}
	line.push_str(&user_count(users));
	line.push_str(&load_suffix(loads));
	(line, complete)
}

/// GNU's `up …,  ` field for an uptime of `seconds`: `up  3:07,  ` under a
/// day, `up 2 days  3:07,  ` past it.
fn up_duration(seconds: i64) -> String {
	let days = seconds / 86400;
	let hours = seconds % 86400 / 3600;
	let minutes = seconds % 3600 / 60;
	match days {
		0 => format!("up {hours:2}:{minutes:02},  "),
		1 => format!("up 1 day {hours:2}:{minutes:02},  "),
		_ => format!("up {days} days {hours:2}:{minutes:02},  "),
	}
}

fn user_count(users: usize) -> String {
	if users == 1 { "1 user".to_owned() } else { format!("{users} users") }
}

/// What follows the user count: `,  load average: a, b, c` and the newline,
/// with as many averages as `getloadavg` produced. GNU prints only the
/// newline when the load average is unavailable.
fn load_suffix(loads: &[f64]) -> String {
	let mut suffix = String::new();
	for (index, load) in loads.iter().enumerate() {
		if index == 0 {
			suffix.push_str(&format!(",  load average: {load:.2}"));
		} else {
			suffix.push_str(&format!(", {load:.2}"));
		}
	}
	suffix.push('\n');
	suffix
}

/// `-p` output for an uptime of `seconds`, as uutils formats it.
fn pretty_uptime(seconds: i64) -> String {
	let plural = |count: i64, unit: &str| {
		if count == 1 { format!("1 {unit}") } else { format!("{count} {unit}s") }
	};
	let days = seconds / 86400;
	let hours = seconds % 86400 / 3600;
	let minutes = seconds % 3600 / 60;
	let mut parts = Vec::new();
	if days > 0 {
		parts.push(plural(days, "day"));
	}
	if hours > 0 {
		parts.push(plural(hours, "hour"));
	}
	if minutes > 0 || parts.is_empty() {
		parts.push(plural(minutes, "minute"));
	}
	format!("up {}", parts.join(", "))
}

/// `-s` output: the boot time in the shell's time zone.
fn since_line(boot: i64, zone: &TimeZone) -> String {
	match Timestamp::from_second(boot) {
		Ok(boot) => boot.to_zoned(zone.clone()).strftime("%Y-%m-%d %H:%M:%S").to_string(),
		Err(_) => boot.to_string(),
	}
}

/// The system load averages over 1, 5, and 15 minutes; empty when the
/// platform has none (GNU's `getloadavg` returning -1).
fn load_average() -> Vec<f64> {
	#[cfg(any(
		target_os = "linux",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly",
	))]
	{
		let mut loads = [0.0_f64; 3];
		// SAFETY: `loads` has room for the three samples requested.
		let count = unsafe { libc::getloadavg(loads.as_mut_ptr(), 3) };
		loads[..usize::try_from(count).unwrap_or(0).min(3)].to_vec()
	}
	#[cfg(not(any(
		target_os = "linux",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "dragonfly",
	)))]
	{
		Vec::new()
	}
}

/// What `uptime` learns from the login records.
#[derive(Debug, Default)]
struct UtmpSummary {
	/// The last `BOOT_TIME` record's time, or the system's boot time when the
	/// default file has none; `None` when unknown (or recorded as 0).
	boot_time: Option<i64>,
	/// `USER_PROCESS` records with a user name.
	users:     usize,
}

/// One login record, reduced to the fields `uptime` consults.
#[derive(Debug)]
struct Record {
	kind:          i16,
	pid:           i32,
	has_user:      bool,
	/// `user == "runlevel" && line == "~"`: Linux's run-level change record.
	runlevel_mark: bool,
	seconds:       i64,
}

const BOOT_TIME: i16 = 2;
const USER_PROCESS: i16 = 7;

/// gnulib's `read_utmp (name, …)` as `uptime` consumes it. `name` is the
/// operand as given: the system boot-time fallbacks apply only when it
/// spells the default file exactly.
///
/// The records are parsed here rather than through libc's `utmpxname` and
/// `getutxent` (or `uucore::utmpx`, which wraps them): that state is
/// process-global, so one shell's `uptime FILE` would redirect another's
/// default read; Apple's `getutxent` creates and signs a missing or empty
/// file; and only [`Host::fs`] reaches the shell's virtual paths.
fn read_utmp(host: &Host, name: &OsStr, check_pids: bool) -> UtmpSummary {
	let path = host.resolve(Path::new(name));
	let records = read_records(host, &path);
	let mut summary = UtmpSummary::default();
	let is_default = name == OsStr::new(UTMP_FILE);

	// gnulib's Raspbian workaround: a boot record stamped before the clock
	// was set takes the time of the later run-level record.
	let runlevel = records
		.iter()
		.rev()
		.find(|record| record.runlevel_mark)
		.map(|record| record.seconds);
	let mut first_boot = true;
	for record in &records {
		if record.kind == USER_PROCESS && record.has_user && !(check_pids && process_is_gone(record.pid)) {
			summary.users += 1;
		}
		if record.kind == BOOT_TIME {
			let mut seconds = record.seconds;
			if cfg!(target_os = "linux") && is_default && first_boot && seconds <= 60 {
				seconds = runlevel.filter(|&time| time != 0).unwrap_or(seconds);
			}
			first_boot = false;
			summary.boot_time = Some(seconds);
		}
	}
	if is_default && first_boot {
		summary.boot_time = system_boot_time(host);
	}
	summary.boot_time = summary.boot_time.filter(|&boot| boot != 0);
	summary
}

/// Whether `kill(pid, 0)` reports no such process (`READ_UTMP_CHECK_PIDS`).
#[cfg(unix)]
fn process_is_gone(pid: i32) -> bool {
	// SAFETY: signal 0 only probes for the process; nothing is delivered.
	pid > 0
		&& unsafe { libc::kill(pid, 0) } < 0
		&& std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
}

#[cfg(not(unix))]
fn process_is_gone(_pid: i32) -> bool {
	false
}

/// macOS stores login records as 628-byte `utmpx32` entries behind a
/// signature record; libc's `getutxent` converts them to `struct utmpx`.
#[cfg(target_vendor = "apple")]
mod layout {
	pub const RECORD: usize = 628;
	pub const USER: usize = 0;
	pub const USER_LEN: usize = 256;
	pub const PID: usize = 292;
	pub const TYPE: usize = 296;
	pub const SECONDS: usize = 300;
	pub const SIGNATURE: &[u8] = b"utmpx-1.00";
	pub const SIGNATURE_TYPE: i16 = 10;
}

/// The bytes of `path` when it is a readable regular file. Anything else
/// holds no records: a directory or unreadable file reads as empty, and a
/// FIFO or device is not opened at all (GNU would block on a FIFO).
#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
fn regular_file_bytes(host: &Host, path: &Path) -> Vec<u8> {
	match host.fs().metadata(path) {
		Ok(metadata) if metadata.is_file() => host.fs().read(path).unwrap_or_default(),
		_ => Vec::new(),
	}
}

/// Reads the records of `path` as Apple libc's `getutxent` does: a file
/// whose first record is not the signature holds no entries.
#[cfg(target_vendor = "apple")]
fn read_records(host: &Host, path: &Path) -> Vec<Record> {
	use layout::*;

	let bytes = regular_file_bytes(host, path);
	let i16_at = |record: &[u8; RECORD], at: usize| i16::from_ne_bytes([record[at], record[at + 1]]);
	let i32_at = |record: &[u8; RECORD], at: usize| {
		i32::from_ne_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]])
	};
	let mut chunks = bytes.as_chunks::<RECORD>().0.iter();
	let signed = chunks.next().is_some_and(|signature| {
		let user = &signature[USER..USER + USER_LEN];
		user.split(|&byte| byte == 0).next() == Some(SIGNATURE)
			&& i16_at(signature, TYPE) == SIGNATURE_TYPE
	});
	if !signed {
		return Vec::new();
	}
	chunks
		.map(|record| Record {
			kind:          i16_at(record, TYPE),
			pid:           i32_at(record, PID),
			has_user:      record[USER] != 0,
			// The run-level workaround is Linux-only.
			runlevel_mark: false,
			seconds:       i64::from(i32_at(record, SECONDS)),
		})
		.collect()
}

/// Reads glibc `struct utmpx` records; like `getutxent`, a trailing partial
/// record is ignored.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
fn read_records(host: &Host, path: &Path) -> Vec<Record> {
	let bytes = regular_file_bytes(host, path);
	let text = |field: &[libc::c_char]| -> Vec<u8> {
		field.iter().map(|&c| c as u8).take_while(|&byte| byte != 0).collect()
	};
	bytes
		.chunks_exact(size_of::<libc::utmpx>())
		.map(|chunk| {
			// SAFETY: `chunk` holds exactly one `utmpx`, a plain-data struct
			// valid for any bit pattern; the read tolerates misalignment.
			let entry: libc::utmpx = unsafe { std::ptr::read_unaligned(chunk.as_ptr().cast()) };
			#[allow(clippy::useless_conversion, reason = "`tv_sec` is i32 or i64 by architecture")]
			let seconds = i64::from(entry.ut_tv.tv_sec);
			Record {
				kind: entry.ut_type,
				pid: entry.ut_pid,
				has_user: entry.ut_user[0] != 0,
				runlevel_mark: text(&entry.ut_user) == b"runlevel" && text(&entry.ut_line) == b"~",
				seconds,
			}
		})
		.collect()
}

/// Platforms whose login-record format is not modelled read no entries.
#[cfg(not(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu"))))]
fn read_records(_host: &Host, _path: &Path) -> Vec<Record> {
	Vec::new()
}

/// The kernel's boot time, which gnulib substitutes when the default file
/// has no boot record.
#[cfg(target_vendor = "apple")]
fn system_boot_time(_host: &Host) -> Option<i64> {
	let mut mib = [libc::CTL_KERN, libc::KERN_BOOTTIME];
	// SAFETY: an all-zero `timeval` is valid.
	let mut boot: libc::timeval = unsafe { std::mem::zeroed() };
	let mut len = size_of::<libc::timeval>();
	// SAFETY: `mib` names a read-only `timeval` sysctl and `boot`/`len`
	// describe a buffer of exactly that size; nothing is written to the kernel.
	let status = unsafe {
		libc::sysctl(
			mib.as_mut_ptr(),
			2,
			(&raw mut boot).cast(),
			&raw mut len,
			std::ptr::null_mut(),
			0,
		)
	};
	(status == 0).then_some(boot.tv_sec)
}

/// gnulib's Linux fallbacks: the modification time of a file only the boot
/// sequence touches, else now minus `CLOCK_BOOTTIME`.
#[cfg(target_os = "linux")]
fn system_boot_time(host: &Host) -> Option<i64> {
	const BOOT_TOUCHED_FILES: [&str; 4] = [
		"/var/lib/systemd/random-seed",
		"/var/lib/urandom/random-seed",
		"/var/lib/random-seed",
		"/var/run/utmp",
	];
	// Older stamps are bogus (2005-07-25, predating the distros involved).
	const PLAUSIBLE: i64 = 1_122_334_455;
	for file in BOOT_TOUCHED_FILES {
		if let Some(mtime) = host.fs().metadata(file).ok().and_then(|metadata| metadata.mtime())
			&& mtime >= PLAUSIBLE
		{
			return Some(mtime);
		}
	}
	// SAFETY: an all-zero `timespec` is valid.
	let mut uptime: libc::timespec = unsafe { std::mem::zeroed() };
	// SAFETY: `uptime` is a valid out-pointer for the clock read.
	if unsafe { libc::clock_gettime(libc::CLOCK_BOOTTIME, &raw mut uptime) } != 0 {
		return None;
	}
	let uptime_ns = i128::from(uptime.tv_sec) * 1_000_000_000 + i128::from(uptime.tv_nsec);
	let boot_ns = Timestamp::now().as_nanosecond() - uptime_ns;
	i64::try_from(boot_ns.div_euclid(1_000_000_000)).ok()
}

/// Windows: now minus the milliseconds since boot.
#[cfg(windows)]
fn system_boot_time(_host: &Host) -> Option<i64> {
	use windows_sys::Win32::System::SystemInformation::GetTickCount64;
	// SAFETY: no preconditions.
	let since_boot = unsafe { GetTickCount64() } / 1000;
	Some(Timestamp::now().as_second() - i64::try_from(since_boot).ok()?)
}

#[cfg(not(any(target_vendor = "apple", target_os = "linux", windows)))]
fn system_boot_time(_host: &Host) -> Option<i64> {
	None
}

/// Creates the `uptime` builtin registration.
pub(crate) fn uptime_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Uptime, SE>()
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::host::run_util;

	fn run(args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Uptime>(args, "", std::env::temp_dir());
		(code, capture.out(), capture.err())
	}

	fn run_with_env(env: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
		let (mut host, capture) = Host::for_test("uptime", "", std::env::temp_dir());
		for (key, value) in env {
			host.set_test_var(key, value);
		}
		let parsed =
			<Uptime as clap::Parser>::try_parse_from(std::iter::once("uptime").chain(args.iter().copied()))
				.expect("valid arguments");
		let code = parsed.run(&mut host);
		(code, capture.out(), capture.err())
	}

	fn utc() -> TimeZone {
		TimeZone::UTC
	}

	#[test]
	fn duration_field_matches_gnu_boundaries() {
		assert_eq!(up_duration(0), "up  0:00,  ");
		assert_eq!(up_duration(59), "up  0:00,  ");
		assert_eq!(up_duration(59 * 60), "up  0:59,  ");
		assert_eq!(up_duration(3600), "up  1:00,  ");
		assert_eq!(up_duration(86399), "up 23:59,  ");
		assert_eq!(up_duration(86400), "up 1 day  0:00,  ");
		assert_eq!(up_duration(86400 + 21 * 3600 + 13 * 60), "up 1 day 21:13,  ");
		assert_eq!(up_duration(2 * 86400 + 5 * 60), "up 2 days  0:05,  ");
		assert_eq!(up_duration(400 * 86400), "up 400 days  0:00,  ");
	}

	#[test]
	fn user_count_is_singular_only_for_one() {
		assert_eq!(user_count(0), "0 users");
		assert_eq!(user_count(1), "1 user");
		assert_eq!(user_count(2), "2 users");
	}

	#[test]
	fn load_suffix_prints_what_getloadavg_returned() {
		assert_eq!(load_suffix(&[0.0, 1.005, 12.345]), ",  load average: 0.00, 1.00, 12.35\n");
		assert_eq!(load_suffix(&[3.5]), ",  load average: 3.50\n");
		assert_eq!(load_suffix(&[]), "\n");
	}

	#[test]
	fn report_line_has_gnu_spacing_and_clock() {
		// 2026-10-12 08:07:54 UTC, booted 1 day 21:13:30 earlier.
		let now = 1_791_792_474;
		let boot = now - (86400 + 21 * 3600 + 13 * 60 + 30);
		let (line, complete) = uptime_line(now, &utc(), Some(boot), 1, &[5.06, 10.68, 10.42]);
		assert!(complete);
		assert_eq!(line, " 08:07:54  up 1 day 21:13,  1 user,  load average: 5.06, 10.68, 10.42\n");

		let (line, _) = uptime_line(now, &TimeZone::get("Europe/Berlin").unwrap(), Some(boot), 3, &[]);
		assert_eq!(line, " 10:07:54  up 1 day 21:13,  3 users\n");
	}

	#[test]
	fn unknown_or_future_boot_time_prints_question_marks() {
		let now = 1_791_792_474;
		for boot in [None, Some(now + 1)] {
			let (line, complete) = uptime_line(now, &utc(), boot, 0, &[1.0, 2.0, 3.0]);
			assert!(!complete);
			assert_eq!(line, " 08:07:54  up ???? days ??:??,  0 users,  load average: 1.00, 2.00, 3.00\n");
		}
	}

	#[test]
	fn pretty_format_boundaries() {
		assert_eq!(pretty_uptime(0), "up 0 minutes");
		assert_eq!(pretty_uptime(59), "up 0 minutes");
		assert_eq!(pretty_uptime(60), "up 1 minute");
		assert_eq!(pretty_uptime(59 * 60), "up 59 minutes");
		assert_eq!(pretty_uptime(3600), "up 1 hour");
		assert_eq!(pretty_uptime(2 * 3600 + 60), "up 2 hours, 1 minute");
		assert_eq!(pretty_uptime(86400), "up 1 day");
		assert_eq!(pretty_uptime(86400 + 3600 + 60), "up 1 day, 1 hour, 1 minute");
		assert_eq!(pretty_uptime(3 * 86400 + 5 * 60), "up 3 days, 5 minutes");
	}

	#[test]
	fn since_is_boot_time_in_shell_zone() {
		assert_eq!(since_line(1_791_629_675, &utc()), "2026-10-10 10:54:35");
		assert_eq!(
			since_line(1_791_629_675, &TimeZone::get("America/New_York").unwrap()),
			"2026-10-10 06:54:35"
		);
	}

	#[test]
	fn extra_operand_is_a_usage_error() {
		let (code, out, err) = run(&["a", "b"]);
		assert_eq!((code, out.as_str()), (1, ""));
		assert!(err.starts_with("error: unexpected value 'b' for '[path]' found"), "{err}");
	}

	#[test]
	fn options_combine_and_abbreviate() {
		for (args, since, pretty, path) in [
			(&["-ps"][..], true, true, None),
			(&["--pre", "f"][..], false, true, Some("f")),
			(&["f", "--si"][..], true, false, Some("f")),
			(&["--", "-p"][..], false, false, Some("-p")),
		] {
			let parsed = <Uptime as clap::Parser>::try_parse_from(
				std::iter::once("uptime").chain(args.iter().copied()),
			)
			.expect("valid arguments");
			let matches = &parsed.matches;
			assert_eq!(matches.get_flag(options::SINCE), since, "{args:?}");
			assert_eq!(matches.get_flag(options::PRETTY), pretty, "{args:?}");
			assert_eq!(
				matches.get_one::<OsString>(options::PATH).and_then(|path| path.to_str()),
				path,
				"{args:?}"
			);
		}
		let (code, _, err) = run(&["-x"]);
		assert_eq!(code, 1);
		assert!(err.contains("'-x'"), "{err}");
	}

	#[test]
	fn missing_file_reports_unknown_uptime() {
		let (code, out, err) = run_with_env(&[("TZ", "UTC")], &["/nonexistent/utmp"]);
		assert_eq!(code, 1);
		assert_eq!(err, "uptime: couldn't get boot time\n");
		assert!(out.starts_with(' ') && out.contains("  up ???? days ??:??,  0 users"), "{out}");
		assert!(out.ends_with('\n'));
	}

	#[test]
	fn directory_operand_holds_no_records() {
		let dir = tempfile::tempdir().unwrap();
		let (code, out, err) = run_with_env(&[], &[dir.path().to_str().unwrap()]);
		assert_eq!(code, 1);
		assert_eq!(err, "uptime: couldn't get boot time\n");
		assert!(out.contains("up ???? days ??:??,  0 users"), "{out}");
	}

	#[test]
	fn since_and_pretty_fail_without_boot_time() {
		for flag in ["-s", "-p"] {
			let (code, out, err) = run(&[flag, "/nonexistent/utmp"]);
			assert_eq!((code, out.as_str()), (1, ""), "{flag}");
			assert_eq!(err, "uptime: couldn't get boot time\n", "{flag}");
		}
	}

	/// Serializes records in the platform's on-disk login-record format.
	#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
	fn utmp_file(records: &[(i16, i32, &str, i64)]) -> tempfile::NamedTempFile {
		let mut bytes = Vec::new();
		#[cfg(target_vendor = "apple")]
		{
			use layout::*;
			let mut push = |kind: i16, pid: i32, user: &[u8], seconds: i64| {
				let mut record = vec![0_u8; RECORD];
				record[USER..USER + user.len()].copy_from_slice(user);
				record[PID..PID + 4].copy_from_slice(&pid.to_ne_bytes());
				record[TYPE..TYPE + 2].copy_from_slice(&kind.to_ne_bytes());
				record[SECONDS..SECONDS + 4].copy_from_slice(&(seconds as i32).to_ne_bytes());
				bytes.extend_from_slice(&record);
			};
			push(SIGNATURE_TYPE, 0, SIGNATURE, 0);
			for &(kind, pid, user, seconds) in records {
				push(kind, pid, user.as_bytes(), seconds);
			}
		}
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		for &(kind, pid, user, seconds) in records {
			// SAFETY: `utmpx` is plain data; all-zero is valid.
			let mut entry: libc::utmpx = unsafe { std::mem::zeroed() };
			entry.ut_type = kind;
			entry.ut_pid = pid;
			for (slot, &byte) in entry.ut_user.iter_mut().zip(user.as_bytes()) {
				*slot = byte as libc::c_char;
			}
			entry.ut_tv.tv_sec = seconds as _;
			// SAFETY: viewing a plain-data struct as its bytes.
			let raw = unsafe {
				std::slice::from_raw_parts((&raw const entry).cast::<u8>(), size_of::<libc::utmpx>())
			};
			bytes.extend_from_slice(raw);
		}
		let mut file = tempfile::NamedTempFile::new().unwrap();
		file.write_all(&bytes).unwrap();
		file
	}

	#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
	#[test]
	fn file_operand_counts_named_user_processes_and_uses_last_boot_record() {
		let now = Timestamp::now().as_second();
		let boot = now - (2 * 86400 + 3 * 3600 + 4 * 60 + 5);
		let file = utmp_file(&[
			(BOOT_TIME, 0, "", now - 10 * 86400),
			(BOOT_TIME, 1, "", boot),
			(USER_PROCESS, 1, "alice", now),
			// Named user processes count without a liveness check for FILE.
			(USER_PROCESS, i32::MAX, "bob", now),
			// Unnamed and non-user records do not.
			(USER_PROCESS, 1, "", now),
			(8, 1, "carol", now),
		]);
		let path = file.path().to_str().unwrap();

		let (code, out, err) = run_with_env(&[("TZ", "UTC")], &[path]);
		assert_eq!((code, err.as_str()), (0, ""));
		assert!(out.contains("  up 2 days  3:04,  2 users"), "{out}");

		let (code, out, _) = run_with_env(&[("TZ", "UTC")], &["-s", path]);
		assert_eq!((code, out), (0, format!("{}\n", since_line(boot, &utc()))));

		let (code, out, _) = run(&["--pretty", path]);
		assert_eq!((code, out.as_str()), (0, "up 2 days, 3 hours, 4 minutes\n"));
	}

	#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
	#[test]
	fn file_without_boot_record_is_an_error_but_still_counts_users() {
		let now = Timestamp::now().as_second();
		let file = utmp_file(&[(USER_PROCESS, 1, "alice", now)]);
		let (code, out, err) = run(&[file.path().to_str().unwrap()]);
		assert_eq!(code, 1);
		assert_eq!(err, "uptime: couldn't get boot time\n");
		assert!(out.contains("up ???? days ??:??,  1 user"), "{out}");
	}

	#[cfg(target_vendor = "apple")]
	#[test]
	fn unsigned_utmpx_file_holds_no_records() {
		let now = Timestamp::now().as_second();
		let signed = utmp_file(&[(BOOT_TIME, 1, "", now - 60), (USER_PROCESS, 1, "alice", now)]);
		let mut bytes = std::fs::read(signed.path()).unwrap();
		bytes[..layout::SIGNATURE.len()].copy_from_slice(b"utmpx-9.99");
		let mut file = tempfile::NamedTempFile::new().unwrap();
		file.write_all(&bytes).unwrap();
		let (code, out, err) = run(&[file.path().to_str().unwrap()]);
		assert_eq!((code, err.as_str()), (1, "uptime: couldn't get boot time\n"));
		assert!(out.contains("up ???? days ??:??,  0 users"), "{out}");
	}

	/// GNU blocks forever opening a FIFO operand; the builtin reads nothing
	/// from it.
	#[cfg(unix)]
	#[test]
	fn fifo_operand_is_not_opened() {
		let dir = tempfile::tempdir().unwrap();
		let fifo = dir.path().join("fifo");
		let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
		// SAFETY: `name` is a live NUL-terminated path.
		assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
		let (code, out, err) = run(&[fifo.to_str().unwrap()]);
		assert_eq!((code, err.as_str()), (1, "uptime: couldn't get boot time\n"));
		assert!(out.contains("0 users"), "{out}");
	}

	#[cfg(any(target_vendor = "apple", target_os = "linux", windows))]
	#[test]
	fn live_system_report() {
		let (code, out, err) = run(&[]);
		assert_eq!((code, err.as_str()), (0, ""));
		let line = out.strip_suffix('\n').expect("newline-terminated");
		let rest = line.strip_prefix(' ').expect("leading space");
		let (clock, rest) = rest.split_at(8);
		assert!(clock.bytes().enumerate().all(|(i, b)| if i % 3 == 2 { b == b':' } else { b.is_ascii_digit() }));
		assert!(rest.starts_with("  up "), "{line}");
		assert!(rest.contains(" user"), "{line}");

		let (code, out, _) = run(&["-p"]);
		assert_eq!(code, 0);
		assert!(out.starts_with("up ") && out.ends_with("\n"), "{out}");
	}

	#[cfg(target_vendor = "apple")]
	#[test]
	fn live_since_matches_kern_boottime() {
		let (host, _) = Host::for_test("uptime", "", std::env::temp_dir());
		let boot = system_boot_time(&host).expect("kern.boottime");
		let (code, out, err) = run_with_env(&[("TZ", "UTC")], &["-s"]);
		assert_eq!((code, err.as_str()), (0, ""));
		assert_eq!(out, format!("{}\n", since_line(boot, &utc())));
	}
}
