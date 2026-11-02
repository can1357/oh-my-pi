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
/// A count in digits only: `--no-h`, or fewer than four digits.
static PLAIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^(?:0|[1-9][0-9]*)$").unwrap());
/// A count with its digits grouped in threes by commas: the default.
static GROUPED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[1-9][0-9]{0,2}(?:,[0-9]{3})+$").unwrap());
/// A count scaled to a unit, two decimals: `-h` (units of 1000) or `-hh`
/// (1024), for a count of at least one unit.
static SCALED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^([0-9]+\.[0-9]{2})([KMGTP])$").unwrap());
/// The speedup: `comma_dnum(…, 2)`, grouped like a count, two decimals.
static RATIO: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"^(?:0|[1-9][0-9]*|[1-9][0-9]{0,2}(?:,[0-9]{3})+)\.[0-9]{2}$").unwrap());
static LIST_TIME: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(File list (?:generation|transfer) time: )[0-9.]+( seconds)$").unwrap());
static STAMP: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d{4}/\d\d/\d\d \d\d:\d\d:\d\d").unwrap());
static PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\{TIME\} \[\d+\]").unwrap());

/// Applies every rule above to `data` produced in work directory `w` while
/// the wall clock was within `window` (Unix seconds, inclusive), and returns
/// the byte counts it masked, in order.
pub(super) fn normalize(data: &[u8], w: &[u8], window: (i64, i64)) -> (Vec<u8>, Vec<Vec<u8>>) {
	let data = replace_all(data, w, b"{W}");
	let data = RATE.replace_all(&data, &b"${1}#${2}"[..]);
	let (data, counts) = mask_counts(&data);
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
fn mask_counts(data: &[u8]) -> (Vec<u8>, Vec<Vec<u8>>) {
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
			counts.push(caps[2].to_vec());
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
			counts.extend([caps[2].to_vec(), caps[4].to_vec()]);
			summary = Some((caps[2].to_vec(), caps[4].to_vec()));
		} else if let Some(caps) = SPEEDUP.captures(line)
			&& let Some((sent, received)) = &summary
			&& speedup_is_printed_for(&caps[2], &caps[1], sent, received)
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
/// many counts, and each pair spelled the same way and equal or exactly one
/// multiplex header apart, in either direction — the variation the module
/// comment of `conformance.rs` explains. Nothing else is accepted: not 1 to
/// 3 bytes, not two headers.
///
/// A count spelled in a way rsync never prints (`1,,000`) matches only
/// itself, and a grouped count never matches a plain one (`1,000` against
/// `1000`). A scaled count (`1.97M`) stands for every count that prints so;
/// the pair matches when two counts it can stand for are that far apart, so
/// a scaled count is checked to its printed precision. Whether it was scaled
/// by 1000 (`-h`) or 1024 (`-hh`) is not in the text, so both are tried;
/// for two counts within a few bytes the answer is the same either way.
pub(super) fn counts_match(ours: &[Vec<u8>], theirs: &[Vec<u8>]) -> bool {
	ours.len() == theirs.len() && ours.iter().zip(theirs).all(|(ours, theirs)| count_matches(ours, theirs))
}

fn count_matches(ours: &[u8], theirs: &[u8]) -> bool {
	if let (Some(a), Some(b)) = (grouping(ours), grouping(theirs))
		&& a != b
	{
		return false;
	}
	let accepted = [1000, 1024].into_iter().any(|unit| {
		let (Some((ours_lo, ours_hi)), Some((theirs_lo, theirs_hi))) = (range(ours, unit), range(theirs, unit)) else {
			return false;
		};
		let apart = theirs_lo - ours_hi..=theirs_hi - ours_lo;
		[-MUX_HEADER, 0, MUX_HEADER].iter().any(|difference| apart.contains(difference))
	});
	accepted || ours == theirs
}

/// Whether a count is grouped by commas (`Some(true)`), plain with four or
/// more digits (`Some(false)`), or neither: shorter, scaled, or misspelled.
fn grouping(count: &[u8]) -> Option<bool> {
	if GROUPED.is_match(count) {
		Some(true)
	} else if PLAIN.is_match(count) && count.len() >= 4 {
		Some(false)
	} else {
		None
	}
}

/// The counts a printed count can stand for, as an inclusive range, when a
/// scaled count's unit is `unit` bytes; `None` for a spelling rsync never
/// prints (rsync 3.5.1 `lib/compat.c`, `do_big_num`).
///
/// A scaled count `x.yzU` stands for the counts that `%.2f` rounds to it,
/// widened by one byte on each side for the rounding of a binary fraction,
/// and never for less than one unit, which rsync prints unscaled.
fn range(count: &[u8], unit: i128) -> Option<(i128, i128)> {
	if PLAIN.is_match(count) || GROUPED.is_match(count) {
		let value = count
			.iter()
			.filter(|b| b.is_ascii_digit())
			.try_fold(0i128, |n, b| n.checked_mul(10)?.checked_add(i128::from(b - b'0')))?;
		return Some((value, value));
	}
	let caps = SCALED.captures(count)?;
	let shown: f64 = std::str::from_utf8(&caps[1]).ok()?.parse().ok()?;
	let power = b"KMGTP".iter().position(|u| *u == caps[2][0])? as u32 + 1;
	let scale = (unit as f64).powi(power as i32);
	let lo = ((shown - 0.005) * scale).ceil() as i128 - 1;
	let hi = ((shown + 0.005) * scale).floor() as i128 + 1;
	Some((lo.max(unit), hi))
}

/// Whether `speedup` is what rsync prints for `size / (sent + received)`
/// (`%.2f`, so within half a hundredth) for some counts the printed ones can
/// stand for ([`range`]).
fn speedup_is_printed_for(speedup: &[u8], size: &[u8], sent: &[u8], received: &[u8]) -> bool {
	if !RATIO.is_match(speedup) {
		return false;
	}
	let digits: String = speedup.iter().filter(|b| **b != b',').map(|b| char::from(*b)).collect();
	let Ok(printed) = digits.parse::<f64>() else {
		return false;
	};
	[1000, 1024].into_iter().any(|unit| {
		let (Some(size), Some(sent), Some(received)) = (range(size, unit), range(sent, unit), range(received, unit))
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
	})
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

	fn counts(tokens: &[&str]) -> Vec<Vec<u8>> {
		tokens.iter().map(|t| t.as_bytes().to_vec()).collect()
	}

	fn pair(ours: &str, theirs: &str) -> bool {
		counts_match(&counts(&[ours]), &counts(&[theirs]))
	}

	/// The one variation rsync shows is a whole multiplex header, either
	/// way; a count off by anything else — 1 to 3 bytes, two headers — is a
	/// different transfer and must fail the scenario.
	#[test]
	fn byte_counts_match_only_when_equal_or_one_header_apart() {
		for difference in -9i128..=9 {
			let theirs = (716 + difference).to_string();
			let expected = [-4, 0, 4].contains(&difference);
			assert_eq!(pair("716", &theirs), expected, "716 against {theirs}");
			let grouped_ours = "1,716";
			let grouped_theirs = format!("1,{}", 716 + difference);
			assert_eq!(pair(grouped_ours, &grouped_theirs), expected, "1,716 against {grouped_theirs}");
		}
		// As many counts on both sides, or the outputs are not alike.
		assert!(!counts_match(&counts(&["716"]), &counts(&["716", "40"])));
		assert!(!counts_match(&counts(&["716", "40"]), &counts(&["716"])));
		assert!(counts_match(&counts(&["716", "40"]), &counts(&["720", "40"])));
		assert!(!counts_match(&counts(&["716", "40"]), &counts(&["720", "41"])));
	}

	/// The spelling of a count is still compared: a grouped count never
	/// matches a plain one, and a spelling rsync never prints matches only
	/// itself. A count may cross a thousand by a header (`999`, `1,003`).
	#[test]
	fn byte_counts_keep_their_spelling() {
		assert!(!pair("1,000", "1000"));
		assert!(!pair("1000", "1,004"));
		assert!(!pair("1,,,000", "1,000"));
		assert!(!pair("1,000", "01,000"));
		assert!(!pair("0716", "716"));
		assert!(pair("1,,,000", "1,,,000"));
		assert!(pair("999", "1,003"));
		assert!(pair("999", "1003"));
	}

	/// A scaled count (`-h`, `-hh`) stands for the counts that print so, and
	/// is checked to that precision; the other count of its line is still
	/// checked to the byte.
	#[test]
	fn scaled_counts_match_to_their_printed_precision() {
		assert!(pair("1.97M", "1.97M"));
		// Neighbours at a rounding boundary can be one header apart.
		assert!(pair("1.97M", "1.98M"));
		assert!(!pair("1.97M", "1.99M"));
		assert!(pair("999", "1.00K"));
		assert!(!pair("1.97M", "1.97G"));
		assert!(!pair("1.97M", "1.970M"));
		assert!(counts_match(&counts(&["1.97M", "464"]), &counts(&["1.97M", "460"])));
		assert!(!counts_match(&counts(&["1.97M", "464"]), &counts(&["1.97M", "462"])));
	}

	/// Each stream's counts are masked and returned in order: the summary
	/// line's, `--stats`'s, and a log file's exit line's, whose total size
	/// is not a count and stays.
	#[test]
	fn counts_are_masked_and_returned_in_order() {
		let stats = b"Total bytes sent: 1,234\nTotal bytes received: 56\n\nsent 1,234 bytes  received 56 bytes  2,580.00 bytes/sec\n";
		let (text, found) = normalize(stats, b"/w", (0, 0));
		assert_eq!(found, counts(&["1,234", "56", "1,234", "56"]));
		assert_eq!(
			String::from_utf8(text).unwrap(),
			"Total bytes sent: {BYTES}\nTotal bytes received: {BYTES}\n\nsent {BYTES} bytes  received {BYTES} bytes  # bytes/sec\n"
		);
		let log = b"2001/01/01 00:00:00 [123] sent 1.97M bytes  received 464 bytes  total size 9,999\n";
		let (text, found) = normalize(log, b"/w", (0, 0));
		assert_eq!(found, counts(&["1.97M", "464"]));
		assert_eq!(
			String::from_utf8(text).unwrap(),
			"2001/01/01 00:00:00 [123] sent {BYTES} bytes  received {BYTES} bytes  total size 9,999\n"
		);
	}

	/// The speedup varies with the counts, so it is masked when it is what
	/// rsync prints for its own output's counts and total size, and kept as
	/// printed otherwise, so that the comparison shows it.
	#[test]
	fn speedup_is_masked_only_when_it_agrees_with_its_counts() {
		let summary = |speedup: &str| {
			let text = format!("sent 1,000 bytes  received 24 bytes  12.00 bytes/sec\ntotal size is 2,048  speedup is {speedup}\n");
			String::from_utf8(normalize(text.as_bytes(), b"/w", (0, 0)).0).unwrap()
		};
		assert!(summary("2.00").ends_with("speedup is {SPEEDUP}\n"), "{}", summary("2.00"));
		for wrong in ["2.01", "1.99", "2.0", "2,00", "02.00"] {
			assert!(summary(wrong).ends_with(&format!("speedup is {wrong}\n")), "{wrong}: {}", summary(wrong));
		}
		let dry = "sent 52 bytes  received 20 bytes  144.00 bytes/sec\ntotal size is 2,050,000  speedup is 28,472.22 (DRY RUN)\n";
		assert!(String::from_utf8(normalize(dry.as_bytes(), b"/w", (0, 0)).0).unwrap().contains("speedup is {SPEEDUP} (DRY RUN)"));
		let scaled = "sent 1.97M bytes  received 464 bytes  1.31M bytes/sec\ntotal size is 1.97M  speedup is 1.00\n";
		assert!(String::from_utf8(normalize(scaled.as_bytes(), b"/w", (0, 0)).0).unwrap().contains("speedup is {SPEEDUP}"));
	}
}
