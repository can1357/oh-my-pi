//! moreutils-inspired `ts` builtin: prefix each line of standard input with a
//! timestamp.
//!
//! This in-process port preserves moreutils' absolute, elapsed, monotonic, and
//! relative timestamping modes while routing streams, cancellation, and `TZ`
//! through the shell invocation's host.
//!
//! Elapsed durations are formatted as if they were seconds since the Unix epoch
//! rendered in UTC. The moreutils subsecond extensions `%.S`, `%.s`, and `%.T`
//! append microseconds to the seconds field.

use std::{
	io::{self, BufRead, BufReader, Write},
	sync::atomic::Ordering,
	time::Instant,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use jiff::{Timestamp, fmt::strtime, tz::TimeZone};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_RELATIVE: &str = "relative";
const OPT_INCREMENTAL: &str = "incremental";
const OPT_SINCE_START: &str = "since-start";
const OPT_MONOTONIC: &str = "monotonic";
const ARG_FORMAT: &str = "format";

const DEFAULT_ABSOLUTE_FORMAT: &str = "%b %d %H:%M:%S";
const DEFAULT_ELAPSED_FORMAT: &str = "%H:%M:%S";

/// Byte length of a syslog-style `%b %d %H:%M:%S` timestamp prefix.
const SYSLOG_LEN: usize = 15;

/// Parsed `ts` invocation.
pub(crate) struct Ts {
	matches: ArgMatches,
}

matches_parser!(Ts, command);

impl Utility for Ts {
	const NAME: &'static str = "ts";
	const USAGE_ERROR: u8 = 2;

	fn run(self, host: &mut Host) -> i32 {
		match timestamp_lines(&self.matches, host) {
			Ok(code) => code,
			Err(err) if err.kind() == io::ErrorKind::BrokenPipe => 0,
			Err(err) => {
				host.error(err, 1);
				1
			},
		}
	}
}

/// The `ts` argument model.
fn command() -> Command {
	Command::new(Ts::NAME)
		.version("ts (pi-shell) 17.2.11")
		.about("Timestamp each line of standard input.")
		.override_usage(format_usage("ts [-r] [-i | -s] [-m] [FORMAT]"))
		.disable_help_flag(true)
		.disable_version_flag(true)
		.arg(
			Arg::new(OPT_RELATIVE)
				.short('r')
				.help("convert existing leading timestamps to relative times")
				.conflicts_with_all([OPT_INCREMENTAL, OPT_SINCE_START])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INCREMENTAL)
				.short('i')
				.help("timestamp with the time elapsed since the last line")
				.conflicts_with(OPT_SINCE_START)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SINCE_START)
				.short('s')
				.help("timestamp with the time elapsed since program start")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_MONOTONIC)
				.short('m')
				.help("use the monotonic clock for elapsed timestamps")
				.action(ArgAction::SetTrue),
		)
		.arg(Arg::new("help").long("help").action(ArgAction::Help))
		.arg(Arg::new("version").long("version").action(ArgAction::Version))
		.arg(
			Arg::new(ARG_FORMAT)
				.value_name("FORMAT")
				.help("strftime format string"),
		)
}

/// Timestamping mode selected by the flags.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Absolute,
	SinceLast,
	SinceStart,
	Relative,
}

fn timestamp_lines(matches: &ArgMatches, host: &mut Host) -> io::Result<i32> {
	let mode = if matches.get_flag(OPT_RELATIVE) {
		Mode::Relative
	} else if matches.get_flag(OPT_INCREMENTAL) {
		Mode::SinceLast
	} else if matches.get_flag(OPT_SINCE_START) {
		Mode::SinceStart
	} else {
		Mode::Absolute
	};
	let monotonic = matches.get_flag(OPT_MONOTONIC);
	let default_format = if mode == Mode::Absolute {
		DEFAULT_ABSOLUTE_FORMAT
	} else {
		DEFAULT_ELAPSED_FORMAT
	};
	let format = expand_subseconds(
		matches
			.get_one::<String>(ARG_FORMAT)
			.map_or(default_format, String::as_str),
	);
	let tz = local_timezone(host.var("TZ"));

	if host.is_cancelled() {
		return Ok(130);
	}
	let cancel = host.cancel_flag();
	let mut reader = BufReader::new(&mut host.stdin);
	let out = &mut host.stdout;
	let start_wall = Timestamp::now();
	let start_mono = Instant::now();
	let mut last_wall = start_wall;
	let mut last_mono = start_mono;
	let mut buf = Vec::new();

	loop {
		if cancel.load(Ordering::Relaxed) {
			return Ok(130);
		}
		buf.clear();
		let n = reader.read_until(b'\n', &mut buf)?;
		if n == 0 {
			break;
		}
		let had_newline = buf.last() == Some(&b'\n');
		let content = if had_newline { &buf[..n - 1] } else { &buf[..] };

		match mode {
			Mode::Relative => {
				write_relative_line(out, content, Timestamp::now(), &tz)?;
			},
			Mode::Absolute => {
				let zoned = Timestamp::now().to_zoned(tz.clone());
				let stamp = strtime::format(&format, &zoned).map_err(io::Error::other)?;
				out.write_all(stamp.as_bytes())?;
				out.write_all(b" ")?;
				out.write_all(content)?;
			},
			Mode::SinceLast | Mode::SinceStart => {
				let nanos = if monotonic {
					let now = Instant::now();
					let anchor = if mode == Mode::SinceLast { last_mono } else { start_mono };
					last_mono = now;
					i128::try_from(now.duration_since(anchor).as_nanos()).unwrap_or(i128::MAX)
				} else {
					let now = Timestamp::now();
					let anchor = if mode == Mode::SinceLast { last_wall } else { start_wall };
					last_wall = now;
					now.duration_since(anchor).as_nanos().max(0)
				};
				let stamp = format_elapsed(nanos, &format).map_err(io::Error::other)?;
				out.write_all(stamp.as_bytes())?;
				out.write_all(b" ")?;
				out.write_all(content)?;
			},
		}
		if had_newline {
			out.write_all(b"\n")?;
		}
		// `ts` is commonly used on live pipes; make each line visible promptly.
		out.flush()?;
	}
	Ok(0)
}

/// Formats an elapsed duration as seconds-since-epoch rendered in UTC.
fn format_elapsed(nanos: i128, format: &str) -> Result<String, String> {
	let stamp = Timestamp::from_nanosecond(nanos).map_err(|err| err.to_string())?;
	strtime::format(format, &stamp.to_zoned(TimeZone::UTC)).map_err(|err| err.to_string())
}

/// Resolves `TZ` from the shell environment, then the system timezone, then UTC.
fn local_timezone(tz: Option<&str>) -> TimeZone {
	if let Some(tz) = tz
		&& let Ok(tz) = TimeZone::get(tz)
	{
		return tz;
	}
	TimeZone::try_system().unwrap_or(TimeZone::UTC)
}

/// Rewrites moreutils' subsecond extensions to fixed six-digit jiff fractions.
fn expand_subseconds(format: &str) -> String {
	let mut out = String::with_capacity(format.len());
	let bytes = format.as_bytes();
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'%' && i + 1 < bytes.len() {
			match &bytes[i + 1..] {
				[b'%', ..] => {
					out.push_str("%%");
					i += 2;
					continue;
				},
				[b'.', b'S', ..] => {
					out.push_str("%S.%6f");
					i += 3;
					continue;
				},
				[b'.', b's', ..] => {
					out.push_str("%s.%6f");
					i += 3;
					continue;
				},
				[b'.', b'T', ..] => {
					out.push_str("%H:%M:%S.%6f");
					i += 3;
					continue;
				},
				_ => {},
			}
		}
		let len = utf8_len(bytes[i]);
		out.push_str(std::str::from_utf8(&bytes[i..i + len]).unwrap_or("\u{fffd}"));
		i += len;
	}
	out
}

/// Length of the UTF-8 sequence introduced by `first`.
const fn utf8_len(first: u8) -> usize {
	match first {
		0xc0..=0xdf => 2,
		0xe0..=0xef => 3,
		0xf0..=0xf7 => 4,
		_ => 1,
	}
}

/// Parses a supported timestamp at the start of `line`.
fn parse_leading_timestamp(line: &[u8], year: i16, tz: &TimeZone) -> Option<(usize, Timestamp)> {
	let token_len = line
		.iter()
		.position(|b| b.is_ascii_whitespace())
		.unwrap_or(line.len());
	if let Ok(token) = std::str::from_utf8(&line[..token_len]) {
		if let Ok(ts) = token.parse::<Timestamp>() {
			return Some((token_len, ts));
		}
		if let Ok(dt) = token.parse::<jiff::civil::DateTime>()
			&& let Ok(zoned) = dt.to_zoned(tz.clone())
		{
			return Some((token_len, zoned.timestamp()));
		}
	}

	if line.len() < SYSLOG_LEN || (line.len() > SYSLOG_LEN && !line[SYSLOG_LEN].is_ascii_whitespace())
	{
		return None;
	}
	let mut prefix: [u8; SYSLOG_LEN] = line[..SYSLOG_LEN].try_into().ok()?;
	if prefix[4] == b' ' {
		prefix[4] = b'0';
	}
	let text = std::str::from_utf8(&prefix).ok()?;
	let tm = strtime::parse("%Y %b %d %H:%M:%S", format!("{year} {text}")).ok()?;
	let zoned = tm.to_datetime().ok()?.to_zoned(tz.clone()).ok()?;
	Some((SYSLOG_LEN, zoned.timestamp()))
}

/// Rewrites a leading timestamp relative to the pinned `now`, or copies the line.
fn write_relative_line(
	out: &mut impl Write,
	line: &[u8],
	now: Timestamp,
	tz: &TimeZone,
) -> io::Result<()> {
	let year = now.to_zoned(tz.clone()).year();
	if let Some((consumed, then)) = parse_leading_timestamp(line, year, tz) {
		out.write_all(render_relative(then, now).as_bytes())?;
		out.write_all(&line[consumed..])
	} else {
		out.write_all(line)
	}
}

/// Renders `then` relative to `now` using the largest nonzero time unit.
fn render_relative(then: Timestamp, now: Timestamp) -> String {
	let secs = now.duration_since(then).as_secs();
	let magnitude = secs.unsigned_abs();
	let (count, unit) = if magnitude >= 86_400 {
		(magnitude / 86_400, 'd')
	} else if magnitude >= 3_600 {
		(magnitude / 3_600, 'h')
	} else if magnitude >= 60 {
		(magnitude / 60, 'm')
	} else {
		(magnitude, 's')
	};
	if secs >= 0 {
		format!("{count}{unit} ago")
	} else {
		format!("in {count}{unit}")
	}
}

/// Creates the `ts` builtin registration.
pub(crate) fn ts_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Ts, SE>()
}

#[cfg(test)]
mod tests {
	use clap::Parser;
	use jiff::{Timestamp, tz::TimeZone};

	use super::{
		Ts, expand_subseconds, format_elapsed, parse_leading_timestamp, render_relative,
		write_relative_line,
	};
	use crate::host::{Host, Utility, run_util};

	fn run_ts(stdin: &str, args: &[&str]) -> (i32, Vec<u8>, String) {
		let (code, capture) = run_util::<Ts>(args, stdin, "/");
		(code, capture.stdout(), capture.err())
	}

	#[test]
	fn absolute_mode_prefixes_default_format() {
		let (code, stdout, stderr) = run_ts("hello\n", &["[stamp]"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(stdout, b"[stamp] hello\n");
	}

	#[test]
	fn elapsed_modes_start_at_zero() {
		for args in [&["-i", "elapsed"][..], &["-s", "elapsed"], &["-s", "-m", "elapsed"]] {
			let (code, stdout, _) = run_ts("line\n", args);
			assert_eq!((code, stdout.as_slice()), (0, b"elapsed line\n".as_slice()));
		}
	}

	#[test]
	fn subsecond_extensions_render_microseconds() {
		assert_eq!(expand_subseconds("%.S %.s %.T %%"), "%S.%6f %s.%6f %H:%M:%S.%6f %%");
		assert_eq!(format_elapsed(1_234_567_890, "%S.%6f").unwrap(), "01.234567");
	}

	#[test]
	fn binary_lines_survive_byte_for_byte() {
		let parsed = Ts::try_parse_from([Ts::NAME, "-s", "fixed"]).unwrap();
		let (mut host, capture) = Host::for_test("ts", b"ab\xff\xfecd\n".to_vec(), "/");
		assert_eq!(parsed.run(&mut host), 0);
		assert_eq!(capture.stdout(), b"fixed ab\xff\xfecd\n");
	}

	#[test]
	fn final_line_without_newline_is_timestamped_without_newline() {
		let (code, stdout, _) = run_ts("first\nlast", &["-s", "fixed"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, b"fixed first\nfixed last");
	}

	#[test]
	fn incremental_conflicts_with_since_start() {
		let (code, _, stderr) = run_ts("", &["-i", "-s"]);
		assert_eq!(code, 2);
		assert!(stderr.contains("cannot be used with"), "stderr: {stderr:?}");
	}

	#[test]
	fn relative_conflicts_with_elapsed_modes() {
		let (code, ..) = run_ts("", &["-r", "-i"]);
		assert_eq!(code, 2);
	}

	#[test]
	fn render_relative_uses_largest_nonzero_unit() {
		let now: Timestamp = "2024-06-01T12:00:00Z".parse().unwrap();
		let at = |secs: i64| Timestamp::from_second(now.as_second() - secs).unwrap();
		assert_eq!(render_relative(at(45), now), "45s ago");
		assert_eq!(render_relative(at(12 * 60), now), "12m ago");
		assert_eq!(render_relative(at(3 * 3600 + 59), now), "3h ago");
		assert_eq!(render_relative(at(9 * 86_400), now), "9d ago");
		assert_eq!(render_relative(at(0), now), "0s ago");
		assert_eq!(render_relative(at(-2 * 3600), now), "in 2h");
	}

	#[test]
	fn parse_leading_timestamp_accepts_supported_formats() {
		let tz = TimeZone::UTC;
		let (consumed, ts) = parse_leading_timestamp(b"2024-01-01T12:00:00Z boot", 2024, &tz).unwrap();
		assert_eq!(consumed, 20);
		assert_eq!(ts, "2024-01-01T12:00:00Z".parse::<Timestamp>().unwrap());
		let (consumed, ts) =
			parse_leading_timestamp(b"2024-01-01T12:00:00.500-05:00 x", 2024, &tz).unwrap();
		assert_eq!(consumed, 29);
		assert_eq!(ts, "2024-01-01T17:00:00.5Z".parse::<Timestamp>().unwrap());
		let (consumed, ts) = parse_leading_timestamp(b"2024-01-01T12:00:00 x", 2024, &tz).unwrap();
		assert_eq!(consumed, 19);
		assert_eq!(ts, "2024-01-01T12:00:00Z".parse::<Timestamp>().unwrap());
		for input in [b"Jan 02 03:04:05 msg".as_slice(), b"Jan  2 03:04:05 msg"] {
			let (consumed, ts) = parse_leading_timestamp(input, 2024, &tz).unwrap();
			assert_eq!(consumed, 15);
			assert_eq!(ts, "2024-01-02T03:04:05Z".parse::<Timestamp>().unwrap());
		}
		assert!(parse_leading_timestamp(b"plain text line", 2024, &tz).is_none());
		assert!(parse_leading_timestamp(b"Jan 02 03:04:05x", 2024, &tz).is_none());
	}

	#[test]
	fn relative_mode_rewrites_matching_lines_and_passes_others() {
		let (code, stdout, stderr) = run_ts("no timestamp here\n", &["-r"]);
		assert_eq!((code, stderr.as_str()), (0, ""));
		assert_eq!(stdout, b"no timestamp here\n");

		let now: Timestamp = "2024-01-03T00:00:00Z".parse().unwrap();
		let mut rewritten = Vec::new();
		write_relative_line(
			&mut rewritten,
			b"2024-01-01T00:00:00Z boot",
			now,
			&TimeZone::UTC,
		)
		.unwrap();
		assert_eq!(rewritten, b"2d ago boot");
	}
}
