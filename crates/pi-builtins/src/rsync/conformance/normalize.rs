//! Output normalization. Each rule masks one value that legitimately differs
//! between two runs of the *same* binary (or between two correct builds), and
//! nothing else:
//!
//! 1. The side's absolute work directory becomes `{W}`: each side runs in its
//!    own copy of the fixture, and diagnostics quote full paths.
//! 2. The transfer rate in the summary line
//!    (`sent N bytes  received N bytes  <rate> bytes/sec`) becomes `#`. The
//!    byte counts — that line's two, the log file's exit line's two
//!    (`sent N bytes  received N bytes  total size N`, which stays), and
//!    `--stats`'s `Total bytes sent/received: N` — become `{BYTES}` and are
//!    returned beside the text, in order, for [`counts_match`]: they count
//!    multiplex headers, whose number varies from run to run. The `speedup`
//!    (`total size / (sent + received)`) varies with them, so it becomes
//!    `{SPEEDUP}` only when it is what rsync prints for the counts of its
//!    own output, and otherwise stays as printed and so fails the comparison.
//! 3. `File list generation time:` / `File list transfer time:` seconds (in
//!    `--stats`) become `#`.
//! 4. Local-time stamps `YYYY/MM/DD hh:mm:ss` that fall inside the run's
//!    wall-clock window (± 2 s) become `{TIME}`: that is `%t` and the
//!    log-file line prefix. Stamps of pinned fixture mtimes (`--list-only`
//!    columns, `%M`) lie years outside the window and are compared as is.
//! 5. A `[pid]` right after a `{TIME}` at the start of a line (log files)
//!    becomes `[PID]`: the reference logs from forked processes.
//! 6. In `--version`, the indented lines under `Capabilities:` and
//!    `Optimizations:` are dropped: they describe the build (this
//!    implementation's capability set and its lack of SIMD/asm/OpenSSL code)
//!    rather than behavior. The header lines, the version line, the checksum,
//!    compress, and daemon-auth lists, and the license text still compare.

use std::sync::LazyLock;

use chrono::{Local, NaiveDateTime, TimeZone};
use regex::bytes::{Captures, Regex};

static RATE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(sent \S+ bytes  received \S+ bytes  )\S+( bytes/sec)$").unwrap());
/// The two counts of the summary line and of the log file's exit line, in
/// whatever spelling.
static SENT_RECEIVED: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(sent )(\S+)( bytes  received )(\S+)( bytes  )").unwrap());
/// `--stats`'s totals.
static TOTAL_BYTES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(Total bytes (?:sent|received): )(\S+)$").unwrap());
/// The summary's second line: the total size, then the speedup.
static SPEEDUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^total size is (\S+)  speedup is (\S+)").unwrap());
/// A count scaled to a unit, two decimals: `-h` (units of 1000) or `-hh`
/// (1024), for a count of at least one unit.
static SCALED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^((?:0|[1-9][0-9]*)\.[0-9]{2})([KMGTP])$").unwrap());
static LIST_TIME: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(File list (?:generation|transfer) time: )[0-9.]+( seconds)$").unwrap());
static STAMP: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d{4}/\d\d/\d\d \d\d:\d\d:\d\d").unwrap());
static PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\{TIME\} \[\d+\]").unwrap());

/// How rsync spells the numbers of one run: its `human_readable` level
/// (rsync 3.5.1 `options.c`: 1 by default, one more for each `-h`, 0 for
/// `--no-h`). At 1 or more an exact number is grouped by commas; at 2 a count
/// of at least 1000 is scaled by units of 1000, at 3 or more by 1024.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Spelling(pub(super) u8);

impl Spelling {
	/// The spelling a client run with `args` uses.
	pub(super) fn of_args(args: &[&str]) -> Self {
		let mut level = 1u8;
		for arg in args {
			match *arg {
				"--" => break,
				"--human-readable" => level = level.saturating_add(1),
				"--no-human-readable" | "--no-h" => level = 0,
				short if short.starts_with('-') && !short.starts_with("--") => {
					for letter in short.chars().skip(1) {
						// The rest of the word is this option's value.
						if "BefMT@".contains(letter) {
							break;
						}
						if letter == 'h' {
							level = level.saturating_add(1);
						}
					}
				},
				_ => {},
			}
		}
		Self(level)
	}

	fn grouped(self) -> bool {
		self.0 >= 1
	}

	/// The unit a count of at least one unit is scaled by, if counts are scaled.
	fn unit(self) -> Option<i128> {
		match self.0 {
			0 | 1 => None,
			2 => Some(1000),
			_ => Some(1024),
		}
	}
}

/// A byte count masked out of an output, and how that output spells
/// numbers: a log file's exit line spells them plainly whatever the run's
/// `-h`, so the spelling travels with each count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Count {
	pub(super) token: Vec<u8>,
	pub(super) spelling: Spelling,
}

/// Applies every rule above to `data` produced in work directory `w` while
/// the wall clock was within `window` (Unix seconds, inclusive) by a run
/// spelling numbers as `spelling` does, and returns the byte counts it
/// masked, in order.
pub(super) fn normalize(data: &[u8], w: &[u8], window: (i64, i64), spelling: Spelling) -> (Vec<u8>, Vec<Count>) {
	let data = replace_all(data, w, b"{W}");
	let data = RATE.replace_all(&data, &b"${1}#${2}"[..]);
	let (data, counts) = mask_counts(&data, spelling);
	let data = LIST_TIME.replace_all(&data, &b"${1}#${2}"[..]);
	let data = STAMP.replace_all(&data, |caps: &Captures<'_>| {
		let stamp = &caps[0];
		let during_run = std::str::from_utf8(stamp)
			.ok()
			.and_then(|s| NaiveDateTime::parse_from_str(s, "%Y/%m/%d %H:%M:%S").ok())
			.and_then(|local| Local.from_local_datetime(&local).earliest())
			.is_some_and(|t| (window.0 - 2..=window.1 + 2).contains(&t.timestamp()));
		if during_run { b"{TIME}".to_vec() } else { stamp.to_vec() }
	});
	let data = PID.replace_all(&data, &b"{TIME} [PID]"[..]);
	let mut out = Vec::with_capacity(data.len());
	let mut in_build_block = false;
	for (index, line) in data.split(|&b| b == b'\n').enumerate() {
		if in_build_block && line.starts_with(b"    ") {
			continue;
		}
		in_build_block = line == b"Capabilities:" || line == b"Optimizations:";
		if index > 0 {
			out.push(b'\n');
		}
		out.extend_from_slice(line);
	}
	(out, counts)
}

/// Masks the byte counts and the speedup of rule 2, line by line, and
/// returns the counts in order.
fn mask_counts(data: &[u8], spelling: Spelling) -> (Vec<u8>, Vec<Count>) {
	let mut out = Vec::with_capacity(data.len());
	let mut counts = Vec::new();
	// The sent and received counts of the last summary line, which the
	// speedup on the next line is computed from.
	let mut summary: Option<(Vec<u8>, Vec<u8>)> = None;
	for (index, line) in data.split(|&b| b == b'\n').enumerate() {
		if index > 0 {
			out.push(b'\n');
		}
		if let Some(caps) = TOTAL_BYTES.captures(line) {
			counts.push(Count { token: caps[2].to_vec(), spelling });
			out.extend_from_slice(&caps[1]);
			out.extend_from_slice(b"{BYTES}");
		} else if let Some(caps) = SENT_RECEIVED.captures(line) {
			let whole = caps.get(0).unwrap();
			out.extend_from_slice(&line[..whole.start()]);
			out.extend_from_slice(&caps[1]);
			out.extend_from_slice(b"{BYTES}");
			out.extend_from_slice(&caps[3]);
			out.extend_from_slice(b"{BYTES}");
			out.extend_from_slice(&caps[5]);
			out.extend_from_slice(&line[whole.end()..]);
			counts.extend([caps[2].to_vec(), caps[4].to_vec()].map(|token| Count { token, spelling }));
			summary = Some((caps[2].to_vec(), caps[4].to_vec()));
		} else if let Some(caps) = SPEEDUP.captures(line)
			&& let Some((sent, received)) = &summary
			&& speedup_is_printed_for(&caps[2], &caps[1], sent, received, spelling)
		{
			let speedup = caps.get(2).unwrap();
			out.extend_from_slice(&line[..speedup.start()]);
			out.extend_from_slice(b"{SPEEDUP}");
			out.extend_from_slice(&line[speedup.end()..]);
		} else {
			out.extend_from_slice(line);
		}
	}
	(out, counts)
}

/// The size of one multiplex frame header.
pub(super) const MUX_HEADER: i128 = 4;

/// Whether two runs' byte counts ([`normalize`]) are the same transfer: as
/// many counts, and each pair spelled as rsync spells it in that output
/// and equal or exactly one multiplex header apart, in either direction —
/// the variation the module comment of `conformance.rs` explains. Nothing
/// else is accepted: not 1 to 3 bytes, not two headers.
///
/// A count spelled in a way rsync never prints there — `1000`
/// where numbers are grouped, `1,000` where they are not, `2070000` or
/// `2070.00K` where it would be `2.07M`, `0.00G`, `02.07M` — matches only
/// itself. A scaled count stands for every count that prints so, and the
/// pair matches when two counts it can stand for are that far apart, so a
/// scaled count is checked to its printed precision.
pub(super) fn counts_match(ours: &[Count], theirs: &[Count]) -> bool {
	ours.len() == theirs.len()
		&& ours.iter().zip(theirs).all(|(ours, theirs)| {
			ours.spelling == theirs.spelling && count_matches(&ours.token, &theirs.token, ours.spelling)
		})
}

fn count_matches(ours: &[u8], theirs: &[u8], spelling: Spelling) -> bool {
	let (Some((ours_lo, ours_hi)), Some((theirs_lo, theirs_hi))) = (range(ours, spelling), range(theirs, spelling))
	else {
		return ours == theirs;
	};
	let apart = theirs_lo - ours_hi..=theirs_hi - ours_lo;
	[-MUX_HEADER, 0, MUX_HEADER].iter().any(|difference| apart.contains(difference))
}

/// rsync's spelling of an exact number (`do_big_num` without a unit):
/// digits, grouped in threes by commas when `grouped`.
fn exact(value: i128, grouped: bool) -> String {
	let digits = value.to_string();
	if !grouped {
		return digits;
	}
	let mut out = String::with_capacity(digits.len() + digits.len() / 3);
	for (index, digit) in digits.chars().enumerate() {
		if index > 0 && (digits.len() - index) % 3 == 0 {
			out.push(',');
		}
		out.push(digit);
	}
	out
}

/// The value of a number spelled with digits and commas only.
fn digits_value(text: &str) -> Option<i128> {
	if text.is_empty() || !text.bytes().all(|b| b.is_ascii_digit() || b == b',') {
		return None;
	}
	text.bytes()
		.filter(u8::is_ascii_digit)
		.try_fold(0i128, |n, b| n.checked_mul(10)?.checked_add(i128::from(b - b'0')))
}

/// The counts a printed count can stand for, as an inclusive range, when
/// it is a spelling rsync 3.5.1 prints under `spelling` (`lib/compat.c`,
/// `do_big_num`); `None` for any other.
///
/// An exact count is valid when it is below the scaling unit (if any) and
/// spelled exactly as rsync spells that value. A scaled count `x.yzU` needs
/// a unit, `x.yz` of at least 1.00 and, below `P`, of at most one unit
/// (`%.2f` can round up to exactly one unit); it stands for the counts that
/// `%.2f` rounds to it, widened by one byte on each side for the rounding of
/// a binary fraction, and never for less than one unit.
fn range(count: &[u8], spelling: Spelling) -> Option<(i128, i128)> {
	if let Some(caps) = SCALED.captures(count) {
		let unit = spelling.unit()?;
		let shown: f64 = std::str::from_utf8(&caps[1]).ok()?.parse().ok()?;
		let letter = caps[2][0];
		if shown < 1.0 || (letter != b'P' && shown > unit as f64) {
			return None;
		}
		let power = b"KMGTP".iter().position(|u| *u == letter)? as i32 + 1;
		let scale = (unit as f64).powi(power);
		let lo = ((shown - 0.005) * scale).ceil() as i128 - 1;
		let hi = ((shown + 0.005) * scale).floor() as i128 + 1;
		return Some((lo.max(unit), hi));
	}
	let text = std::str::from_utf8(count).ok()?;
	let value = digits_value(text)?;
	if spelling.unit().is_some_and(|unit| value >= unit) {
		return None;
	}
	(exact(value, spelling.grouped()) == text).then_some((value, value))
}

/// Whether `speedup` is what rsync prints for `size / (sent + received)`
/// (`comma_dnum(…, 2)`: `%.2f`, so within half a hundredth, with the whole
/// part spelled like an exact number) for some counts the printed ones can
/// stand for ([`range`]).
fn speedup_is_printed_for(speedup: &[u8], size: &[u8], sent: &[u8], received: &[u8], spelling: Spelling) -> bool {
	let Some((whole, hundredths)) = std::str::from_utf8(speedup).ok().and_then(|text| text.split_once('.')) else {
		return false;
	};
	let Some(whole_value) = digits_value(whole) else {
		return false;
	};
	if exact(whole_value, spelling.grouped()) != whole
		|| hundredths.len() != 2
		|| !hundredths.bytes().all(|b| b.is_ascii_digit())
	{
		return false;
	}
	let printed = whole_value as f64 + hundredths.parse::<f64>().unwrap_or(f64::NAN) / 100.0;
	let (Some(size), Some(sent), Some(received)) =
		(range(size, spelling), range(sent, spelling), range(received, spelling))
	else {
		return false;
	};
	let (fewest, most) = (sent.0 + received.0, sent.1 + received.1);
	if fewest <= 0 {
		return false;
	}
	let lowest = size.0 as f64 / most as f64;
	let highest = size.1 as f64 / fewest as f64;
	(lowest - 0.005 - 1e-9..=highest + 0.005 + 1e-9).contains(&printed)
}

fn replace_all(data: &[u8], needle: &[u8], with: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(data.len());
	let mut rest = data;
	while let Some(at) = memchr::memmem::find(rest, needle) {
		out.extend_from_slice(&rest[..at]);
		out.extend_from_slice(with);
		rest = &rest[at + needle.len()..];
	}
	out.extend_from_slice(rest);
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The spelling of a run with no `-h` (numbers grouped, never scaled),
	/// of `--no-h`, of `-h` and of `-hh`.
	const GROUPED: Spelling = Spelling(1);
	const PLAIN: Spelling = Spelling(0);
	const BY_1000: Spelling = Spelling(2);
	const BY_1024: Spelling = Spelling(3);

	fn counts(tokens: &[&str], spelling: Spelling) -> Vec<Count> {
		tokens.iter().map(|t| Count { token: t.as_bytes().to_vec(), spelling }).collect()
	}

	fn pair(ours: &str, theirs: &str, spelling: Spelling) -> bool {
		counts_match(&counts(&[ours], spelling), &counts(&[theirs], spelling))
	}

	/// The level is read from the client's own options: `-h` in a cluster
	/// counts, a letter inside another option's value does not.
	#[test]
	fn the_spelling_follows_the_human_readable_options() {
		for (args, level) in [
			(&["-ai", "src/", "dst/"][..], 1),
			(&["-avh", "src/", "dst/"], 2),
			(&["-a", "--stats", "-hh", "src/", "dst/"], 3),
			(&["-ah", "--human-readable", "src/", "dst/"], 3),
			(&["-ah", "--no-h", "src/", "dst/"], 0),
			(&["-ai", "-e", "/bin/sh", "src/", "dst/"], 1),
			(&["-aiT/tmp/hh", "src/", "dst/"], 1),
			(&["-ai", "--", "-h"], 1),
		] {
			assert_eq!(Spelling::of_args(args), Spelling(level), "{args:?}");
		}
	}

	/// The one variation rsync shows is a whole multiplex header, either
	/// way; a count off by anything else — 1 to 3 bytes, two headers — is a
	/// different transfer and must fail the scenario.
	#[test]
	fn byte_counts_match_only_when_equal_or_one_header_apart() {
		for difference in -9i128..=9 {
			let theirs = (716 + difference).to_string();
			let expected = [-4, 0, 4].contains(&difference);
			assert_eq!(pair("716", &theirs, GROUPED), expected, "716 against {theirs}");
			let grouped_theirs = format!("1,{}", 716 + difference);
			assert_eq!(pair("1,716", &grouped_theirs, GROUPED), expected, "1,716 against {grouped_theirs}");
		}
		// The same spelling on both sides: a log count never pairs with a summary count.
		assert!(!counts_match(&counts(&["716"], GROUPED), &counts(&["716"], PLAIN)));
		// As many counts on both sides, or the outputs are not alike.
		assert!(!counts_match(&counts(&["716"], GROUPED), &counts(&["716", "40"], GROUPED)));
		assert!(!counts_match(&counts(&["716", "40"], GROUPED), &counts(&["716"], GROUPED)));
		assert!(counts_match(&counts(&["716", "40"], GROUPED), &counts(&["720", "40"], GROUPED)));
		assert!(!counts_match(&counts(&["716", "40"], GROUPED), &counts(&["720", "41"], GROUPED)));
	}

	/// A count must be spelled as rsync spells it in that run; any other
	/// spelling matches only itself. A count may cross a thousand by a
	/// header (`999`, `1,003`).
	#[test]
	fn byte_counts_keep_their_spelling() {
		assert!(!pair("1,000", "1000", GROUPED));
		assert!(!pair("1000", "1,004", GROUPED));
		assert!(!pair("1,,,000", "1,000", GROUPED));
		assert!(!pair("1,000", "01,000", GROUPED));
		assert!(!pair("0716", "716", GROUPED));
		assert!(pair("1,,,000", "1,,,000", GROUPED));
		assert!(pair("999", "1,003", GROUPED));
		assert!(!pair("999", "1003", GROUPED));
		assert!(pair("999", "1003", PLAIN));
		assert!(!pair("1,000", "1,004", PLAIN));
	}

	/// A scaled count (`-h`, `-hh`) stands for the counts that print so, and
	/// is checked to that precision; the other count of its line is still
	/// checked to the byte. A scaled spelling rsync never prints — a leading
	/// zero, a mantissa below 1.00 or above one unit, an exact count of a unit
	/// or more, a scaled count where nothing is scaled — matches only itself.
	#[test]
	fn scaled_counts_match_to_their_printed_precision() {
		assert!(pair("1.97M", "1.97M", BY_1000));
		// Neighbours at a rounding boundary can be one header apart.
		assert!(pair("1.97M", "1.98M", BY_1000));
		assert!(!pair("1.97M", "1.99M", BY_1000));
		assert!(pair("999", "1.00K", BY_1000));
		assert!(pair("1,020", "1.00K", BY_1024));
		assert!(pair("1024.00K", "1024.00K", BY_1024));
		assert!(counts_match(&counts(&["1.97M", "464"], BY_1000), &counts(&["1.97M", "460"], BY_1000)));
		assert!(!counts_match(&counts(&["1.97M", "464"], BY_1000), &counts(&["1.97M", "462"], BY_1000)));
		for wrong in ["1.97G", "1.970M", "01.97M", "1970000", "1,970,000", "1970.00K", "0.00G", "0.99M"] {
			assert!(!pair(wrong, "1.97M", BY_1000), "{wrong}");
			assert!(!pair("1.97M", wrong, BY_1000), "{wrong}");
		}
		// Where nothing is scaled, a scaled count matches only itself.
		assert!(pair("1.97M", "1.97M", GROUPED));
		assert!(!pair("1.97M", "1.98M", GROUPED));
	}

	/// Each stream's counts are masked and returned in order: the summary
	/// line's, `--stats`'s, and a log file's exit line's, whose total size
	/// is not a count and stays.
	#[test]
	fn counts_are_masked_and_returned_in_order() {
		let stats = b"Total bytes sent: 1,234\nTotal bytes received: 56\n\nsent 1,234 bytes  received 56 bytes  2,580.00 bytes/sec\n";
		let (text, found) = normalize(stats, b"/w", (0, 0), GROUPED);
		assert_eq!(found, counts(&["1,234", "56", "1,234", "56"], GROUPED));
		assert_eq!(
			String::from_utf8(text).unwrap(),
			"Total bytes sent: {BYTES}\nTotal bytes received: {BYTES}\n\nsent {BYTES} bytes  received {BYTES} bytes  # bytes/sec\n"
		);
		let log = b"2001/01/01 00:00:00 [123] sent 1970000 bytes  received 464 bytes  total size 9999\n";
		let (text, found) = normalize(log, b"/w", (0, 0), PLAIN);
		assert_eq!(found, counts(&["1970000", "464"], PLAIN));
		assert_eq!(
			String::from_utf8(text).unwrap(),
			"2001/01/01 00:00:00 [123] sent {BYTES} bytes  received {BYTES} bytes  total size 9999\n"
		);
	}

	/// The speedup varies with the counts, so it is masked when it is what
	/// rsync prints for its own output's counts and total size, spelled as
	/// that run spells numbers, and kept as printed otherwise, so that the
	/// comparison shows it.
	#[test]
	fn speedup_is_masked_only_when_it_agrees_with_its_counts() {
		let masked = |text: &str, spelling: Spelling| String::from_utf8(normalize(text.as_bytes(), b"/w", (0, 0), spelling).0).unwrap();
		let summary = |speedup: &str| {
			masked(&format!("sent 1,000 bytes  received 24 bytes  12.00 bytes/sec\ntotal size is 2,048  speedup is {speedup}\n"), GROUPED)
		};
		assert!(summary("2.00").ends_with("speedup is {SPEEDUP}\n"), "{}", summary("2.00"));
		for wrong in ["2.01", "1.99", "2.0", "2,00", "02.00"] {
			assert!(summary(wrong).ends_with(&format!("speedup is {wrong}\n")), "{wrong}: {}", summary(wrong));
		}
		let dry = |speedup: &str, spelling: Spelling, size: &str| {
			masked(&format!("sent 52 bytes  received 20 bytes  144.00 bytes/sec\ntotal size is {size}  speedup is {speedup} (DRY RUN)\n"), spelling)
		};
		assert!(dry("28,472.22", GROUPED, "2,050,000").contains("speedup is {SPEEDUP} (DRY RUN)"));
		assert!(dry("28472.22", GROUPED, "2,050,000").contains("speedup is 28472.22 (DRY RUN)"));
		assert!(dry("28472.22", PLAIN, "2050000").contains("speedup is {SPEEDUP} (DRY RUN)"));
		assert!(dry("28,472.22", PLAIN, "2050000").contains("speedup is 28,472.22 (DRY RUN)"));
		let scaled = "sent 1.97M bytes  received 464 bytes  1.31M bytes/sec\ntotal size is 1.97M  speedup is 1.00\n";
		assert!(masked(scaled, BY_1000).contains("speedup is {SPEEDUP}"));
	}
}
