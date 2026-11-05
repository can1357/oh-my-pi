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
static LIST_TIME: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(File list (?:generation|transfer) time: )[0-9.]+( seconds)$").unwrap());
static STAMP: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d{4}/\d\d/\d\d \d\d:\d\d:\d\d").unwrap());
static PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\{TIME\} \[\d+\]").unwrap());

/// How rsync spells the numbers of one run: its `human_readable` level
/// (1 by default, one more for each `-h`, 0 for `--no-h`). Counts are
/// printed with `human_num` and the speedup with `comma_dnum` (rsync 3.5.1
/// `inums.h`), both through `do_big_num` ([`big_num`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Spelling(pub(super) u8);

impl Spelling {
	/// The level a client run with `args` (no program name) prints with, as
	/// rsync's own option parsing reads it: the builtin's parser, which takes
	/// `-h` in clusters and a following word as the value of an option that
	/// takes one (`--exclude -h`). Parsing that fails leaves the default; such
	/// a run prints no counts.
	pub(super) fn of_args(args: &[String]) -> Self {
		let argv: Vec<std::ffi::OsString> = args.iter().map(Into::into).collect();
		match crate::rsync::options::parse(&argv, &|_| None) {
			Ok(crate::rsync::options::Parsed::Run(options)) => Self(options.human_readable.min(3) as u8),
			_ => Self(1),
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
pub(super) const MUX_HEADER: u64 = 4;

/// How many headers two runs' counts may differ by. Each time a writer waits
/// for input it closes its pending frame, and how often it waits depends on
/// scheduling: rsync 3.5.1 itself was measured one header apart on most
/// rows and two apart on `push_checksum_xxh64` (4 of 100 runs), and the
/// builtin three apart there once under load.
pub(super) const MAX_HEADERS: u64 = 4;

/// Whether two runs' byte counts ([`normalize`]) are the same transfer: as
/// many counts, each pair from outputs spelled alike, and two counts the
/// tokens can stand for equal or a whole number of multiplex headers apart,
/// at most [`MAX_HEADERS`], in either direction — the variation the module
/// comment of `conformance.rs` explains. A difference that is not a whole
/// number of headers is never accepted.
///
/// A token stands for the counts rsync 3.5.1 prints exactly so at that
/// spelling ([`values_printed_as`]); one rsync never prints there matches
/// only itself.
pub(super) fn counts_match(ours: &[Count], theirs: &[Count]) -> bool {
	ours.len() == theirs.len()
		&& ours.iter().zip(theirs).all(|(ours, theirs)| {
			ours.spelling == theirs.spelling && count_matches(&ours.token, &theirs.token, ours.spelling)
		})
}

fn count_matches(ours: &[u8], theirs: &[u8], spelling: Spelling) -> bool {
	let (Some((ours_lo, ours_hi)), Some((theirs_lo, theirs_hi))) =
		(values_printed_as(ours, spelling), values_printed_as(theirs, spelling))
	else {
		return ours == theirs;
	};
	// Some count each stands for, a whole number of headers apart.
	let (ours_lo, ours_hi, theirs_lo, theirs_hi) =
		(i128::from(ours_lo), i128::from(ours_hi), i128::from(theirs_lo), i128::from(theirs_hi));
	let headers = i128::from(MAX_HEADERS);
	(-headers..=headers).any(|n| {
		let d = n * i128::from(MUX_HEADER);
		ours_lo + d <= theirs_hi && theirs_lo <= ours_hi + d
	})
}

/// rsync 3.5.1's `do_big_num(num, level, NULL)` for a count (`lib/compat.c`
/// lines 170–246): at `level` 2 or more a count of at least one unit (1000,
/// or 1024 from level 3) is divided in `double`s down to K, M, G, T or P and
/// printed `%.2f`; otherwise the digits, grouped by commas from level 1.
pub(super) fn big_num(num: u64, level: u8) -> String {
	if level > 1 {
		let mult: u64 = if level == 2 { 1000 } else { 1024 };
		if num >= mult {
			let mult = mult as f64;
			let mut value = num as f64 / mult;
			let mut unit = 'K';
			for next in ['M', 'G', 'T', 'P'] {
				if value < mult {
					break;
				}
				value /= mult;
				unit = next;
			}
			return format!("{}{unit}", printf_fixed(value, 2));
		}
	}
	grouped_digits(num, level >= 1, "")
}

/// rsync 3.5.1's `comma_dnum(value, 2)`, how the speedup prints:
/// `do_big_dnum(value, level != 0, 2)` (`lib/compat.c` lines 252–265), which
/// prints `%.2f` and, from 1000 on with grouping, puts the fraction of that
/// rounding after the grouped digits of the *truncated* value — so 9999.999
/// prints `9,999.00`.
pub(super) fn comma_dnum(value: f64, level: u8) -> String {
	let fixed = printf_fixed(value, 2);
	if level == 0 || (value < 1000.0 && value > -1000.0) {
		return fixed;
	}
	let fraction = fixed.find('.').map_or("", |dot| &fixed[dot..]);
	grouped_digits(value as u64, true, fraction)
}

/// Digits of `num`, grouped in threes by commas when `grouped`, then `tail`.
fn grouped_digits(num: u64, grouped: bool, tail: &str) -> String {
	let digits = num.to_string();
	let mut out = String::with_capacity(digits.len() + digits.len() / 3 + tail.len());
	for (index, digit) in digits.chars().enumerate() {
		if grouped && index > 0 && (digits.len() - index) % 3 == 0 {
			out.push(',');
		}
		out.push(digit);
	}
	out.push_str(tail);
	out
}

/// C's `printf("%.*f", places, value)` for a finite, non-negative value of at
/// most 2^64: the exact binary value rounded to `places` decimals, ties to
/// even (the default rounding mode), as glibc does.
fn printf_fixed(value: f64, places: u32) -> String {
	let scale = 10u128.pow(places);
	let rounded = printf_rounded(value, places);
	let (whole, fraction) = (rounded / scale, rounded % scale);
	match places {
		0 => whole.to_string(),
		_ => format!("{whole}.{fraction:0width$}", width = places as usize),
	}
}

/// The integer [`printf_fixed`] prints `value * 10^places` as. It never
/// decreases as `value` grows.
fn printf_rounded(value: f64, places: u32) -> u128 {
	let bits = value.to_bits();
	let exponent = ((bits >> 52) & 0x7ff) as i32;
	let fraction = bits & ((1 << 52) - 1);
	let (mantissa, power) = match exponent {
		0 => (fraction, -1074),
		_ => (fraction | (1 << 52), exponent - 1075),
	};
	let scaled = u128::from(mantissa) * 10u128.pow(places);
	// value * 10^places = scaled * 2^power, rounded to an integer.
	if power >= 0 {
		scaled << power
	} else if -power >= 128 {
		0
	} else {
		let shift = (-power) as u32;
		let whole = scaled >> shift;
		let rest = scaled - (whole << shift);
		let half = 1u128 << (shift - 1);
		match rest.cmp(&half) {
			std::cmp::Ordering::Greater => whole + 1,
			std::cmp::Ordering::Equal => whole + (whole & 1),
			std::cmp::Ordering::Less => whole,
		}
	}
}

/// The first integer of the inclusive `range` where `holds`, which is false
/// and then true as the integer grows; `None` when it never holds.
fn first_where(range: (u128, u128), holds: impl Fn(u128) -> bool) -> Option<u128> {
	let (mut lo, mut hi) = (range.0, range.1 + 1);
	while lo < hi {
		let mid = lo + (hi - lo) / 2;
		if holds(mid) {
			hi = mid;
		} else {
			lo = mid + 1;
		}
	}
	(lo <= range.1).then_some(lo)
}

/// The counts rsync prints as exactly `token` at `spelling`, an inclusive
/// range, or `None` when it prints no count so.
///
/// [`big_num`] never prints a smaller count as a larger number, so the counts
/// printing as one token are the run of counts between the first that does
/// and the last that does, found by bisection over every `u64` on the
/// printed number's order (unit, then digits).
fn values_printed_as(token: &[u8], spelling: Spelling) -> Option<(u64, u64)> {
	let token = std::str::from_utf8(token).ok()?;
	let key = printed_order(token)?;
	let order = |num: u128| printed_order(&big_num(num as u64, spelling.0));
	let every = (0, u128::from(u64::MAX));
	let lo = first_where(every, |num| order(num).is_some_and(|order| order >= key))?;
	let hi = first_where(every, |num| order(num).is_some_and(|order| order > key)).map_or(every.1, |after| after - 1);
	(lo <= hi && big_num(lo as u64, spelling.0) == token).then(|| (lo as u64, hi as u64))
}

/// Where a printed count sorts among the counts rsync prints: its unit
/// (none, K, M, G, T, P), then its digits with the decimal point removed.
fn printed_order(token: &str) -> Option<(u8, u128)> {
	let (number, unit) = match token.as_bytes().last()? {
		b'K' => (&token[..token.len() - 1], 1),
		b'M' => (&token[..token.len() - 1], 2),
		b'G' => (&token[..token.len() - 1], 3),
		b'T' => (&token[..token.len() - 1], 4),
		b'P' => (&token[..token.len() - 1], 5),
		_ => (token, 0),
	};
	let mut digits = 0u128;
	let mut any = false;
	for byte in number.bytes() {
		match byte {
			b'0'..=b'9' => {
				digits = digits.checked_mul(10)?.checked_add(u128::from(byte - b'0'))?;
				any = true;
			},
			b',' | b'.' => {},
			_ => return None,
		}
	}
	any.then_some((unit, digits))
}

/// Whether `speedup` is what rsync prints ([`comma_dnum`] of
/// `size / (sent + received)`, in `double`s as rsync divides them) for some
/// whole counts the printed `size`, `sent` and `received` stand for.
///
/// The quotients printing as `speedup` are at most two runs of `double`s
/// ([`quotients_printed_as`]). A quotient never falls as the size grows and
/// never rises as the divisor grows, so for each run the divisors at which
/// some size can reach it form one range, found by bisection, and at each of
/// them the smallest size whose quotient reaches the run is a witness if any
/// size is. The speedup is accepted exactly when a witness exists.
///
/// Divisors are tried from the largest, where one more byte of size moves the
/// quotient least. Below 2^40, from a divisor of 250 up, that move is smaller
/// than the narrowest run (half a hundredth), so the first divisor tried is a
/// witness unless every divisor in range is below 250. From 2^40 up, no token
/// stands for more than 1.2·10^13 sizes, so about a dozen divisors at most
/// are in range.
fn speedup_is_printed_for(speedup: &[u8], size: &[u8], sent: &[u8], received: &[u8], spelling: Spelling) -> bool {
	let (Ok(speedup), Some(size), Some(sent), Some(received)) = (
		std::str::from_utf8(speedup),
		values_printed_as(size, spelling),
		values_printed_as(sent, spelling),
		values_printed_as(received, spelling),
	) else {
		return false;
	};
	let size = (u128::from(size.0), u128::from(size.1));
	// A divisor of 0 is left out: every run's counts include the protocol
	// greeting, so rsync never divides by it.
	let moved = ((u128::from(sent.0) + u128::from(received.0)).max(1), u128::from(sent.1) + u128::from(received.1));
	if moved.0 > moved.1 {
		return false;
	}
	let quotient = |size: u128, moved: u128| size as f64 / moved as f64;
	quotients_printed_as(speedup, spelling.0).into_iter().any(|(least, most)| {
		// From the first divisor at which the smallest size's quotient is at
		// most `most`, to the last at which the largest size's is at least `least`.
		let Some(first) = first_where(moved, |m| quotient(size.0, m) <= most) else {
			return false;
		};
		let last = first_where(moved, |m| quotient(size.1, m) < least).map_or(moved.1, |after| after - 1);
		(first..=last)
			.rev()
			.any(|m| first_where(size, |z| quotient(z, m) >= least).is_some_and(|z| quotient(z, m) <= most))
	})
}

/// The largest quotient [`speedup_is_printed_for`] divides out, 2^64 (a `u64`
/// size over a divisor of at least 1), as a bit pattern. Up to it, bit
/// patterns sort as the values do.
const MAX_QUOTIENT_BITS: u128 = 0x43F0_0000_0000_0000;

/// The `double`s [`comma_dnum`] prints as `speedup` at `level`, as inclusive
/// runs (least, most). The printed text is the rounded hundredths (below
/// 1000, or without grouping), or the truncated whole part and the rounded
/// fraction (from 1000 with grouping, where `W.995` up to `W + 1` also prints
/// `W.00`); each of those never falls as the quotient grows, so the
/// quotients printing one text are at most two runs, found by bisection.
fn quotients_printed_as(speedup: &str, level: u8) -> Vec<(f64, f64)> {
	let Some((whole_text, fraction_text)) = speedup.split_once('.') else {
		return Vec::new();
	};
	let grouped = level > 0 && whole_text.contains(',');
	let (Ok(whole), Ok(fraction)) = (whole_text.replace(',', "").parse::<u128>(), fraction_text.parse::<u128>()) else {
		return Vec::new();
	};
	let Some(hundredths) = whole.checked_mul(100).and_then(|h| h.checked_add(fraction)) else {
		return Vec::new();
	};
	type Run = Option<(u128, u128)>;
	let every = (0, MAX_QUOTIENT_BITS);
	let value = |bits: u128| f64::from_bits(bits as u64);
	// The bit patterns where `key`, which never falls, is `target`.
	let run = |key: &dyn Fn(f64) -> u128, target: u128| -> Run {
		let lo = first_where(every, |bits| key(value(bits)) >= target)?;
		let hi = first_where(every, |bits| key(value(bits)) > target).map_or(every.1, |after| after - 1);
		(lo <= hi).then_some((lo, hi))
	};
	let both = |a: Run, b: Run| -> Run {
		let ((a_lo, a_hi), (b_lo, b_hi)) = (a?, b?);
		let (lo, hi) = (a_lo.max(b_lo), a_hi.min(b_hi));
		(lo <= hi).then_some((lo, hi))
	};
	let rounded = |q: f64| printf_rounded(q, 2);
	let thousand = u128::from(1000f64.to_bits());
	let runs: Vec<Run> = if grouped {
		let truncated = both(run(&|q: f64| u128::from(q as u64), whole), Some((thousand, every.1)));
		let mut runs = vec![both(truncated, run(&rounded, hundredths))];
		if fraction == 0
			&& let Some(next_whole) = hundredths.checked_add(100)
		{
			runs.push(both(truncated, run(&rounded, next_whole)));
		}
		runs
	} else {
		let below = if level > 0 { thousand - 1 } else { every.1 };
		vec![both(run(&rounded, hundredths), Some((0, below)))]
	};
	// Every quotient of a run prints alike: keep the runs that print `speedup`.
	runs.into_iter()
		.flatten()
		.map(|(lo, hi)| (value(lo), value(hi)))
		.filter(|&(least, _)| comma_dnum(least, level) == speedup)
		.collect()
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

	/// The level is read as rsync's option parsing reads it: `-h` in a
	/// cluster counts; a word that is another option's value does not, whether
	/// attached (`-T/tmp/hh`) or the next word (`--exclude -h`, `-M -h`).
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
			(&["-ai", "--exclude", "-h", "src/", "dst/"], 1),
			(&["-ai", "--include", "-hh", "src/", "dst/"], 1),
			(&["-ai", "--out-format", "-h", "src/", "dst/"], 1),
			(&["-ai", "-M", "-h", "src/", "dst/"], 1),
			(&["-ai", "--", "-h", "dst/"], 1),
		] {
			let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
			assert_eq!(Spelling::of_args(&args), Spelling(level), "{args:?}");
		}
	}

	/// The variation rsync shows is whole multiplex headers, either way, up to
	/// [`MAX_HEADERS`]; a count off by anything else — 1 to 3 bytes, 5, or more
	/// than four headers — is a different transfer and must fail the scenario.
	#[test]
	fn byte_counts_match_only_when_whole_headers_apart() {
		for difference in -21i128..=21 {
			let theirs = (716 + difference).to_string();
			let expected = difference % 4 == 0 && difference.abs() <= 16;
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
		// Across a unit, the counts each token stands for are rsync's own:
		// `999.98K` ends at 999,984 (999,995 prints `1000.00K`), four headers
		// below `1.00M`'s 1,000,000; `999.97K` ends at 999,974, more than four.
		assert!(pair("999.98K", "1.00M", BY_1000));
		assert!(!pair("999.97K", "1.00M", BY_1000));
		assert!(pair("1000.00K", "1.00M", BY_1000));
		assert!(!pair("1023.97K", "1.00M", BY_1024));
	}

	/// The formatters are rsync 3.5.1's, rounding included: `do_big_num`
	/// divides in `double`s and prints `%.2f` (ties to even on the exact
	/// binary value), and `comma_dnum` puts the rounded fraction after the
	/// truncated whole part.
	#[test]
	fn the_formatters_print_what_rsync_prints() {
		for (count, level, printed) in [
			(0, 1, "0"),
			(999, 2, "999"),
			(1000, 2, "1.00K"),
			(1005, 2, "1.00K"),
			(1006, 2, "1.01K"),
			(1152, 3, "1.12K"),
			(999_994, 2, "999.99K"),
			(999_995, 2, "1000.00K"),
			(1_000_000, 2, "1.00M"),
			(1_048_575, 3, "1024.00K"),
			(1_048_576, 3, "1.00M"),
			(2_065_712, 1, "2,065,712"),
			(2_065_712, 0, "2065712"),
		] {
			assert_eq!(big_num(count, level), printed, "{count} at level {level}");
		}
		for (value, level, printed) in [
			(2.0, 1, "2.00"),
			(28_472.222, 1, "28,472.22"),
			(28_472.222, 0, "28472.22"),
			(9_999.999, 1, "9,999.00"),
			(201.0 / 200.0, 1, "1.00"),
		] {
			assert_eq!(comma_dnum(value, level), printed, "{value} at level {level}");
		}
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
		// rsync's truncation quirk: 9,999,999 / 1,000 prints `9,999.00`.
		let quirk = |speedup: &str| {
			masked(&format!("sent 900 bytes  received 100 bytes  2.00 bytes/sec\ntotal size is 9,999,999  speedup is {speedup}\n"), GROUPED)
		};
		assert!(quirk("9,999.00").contains("speedup is {SPEEDUP}"));
		assert!(quirk("10,000.00").contains("speedup is 10,000.00"));
		// A speedup rounded the other way at a boundary is not masked.
		let boundary = |speedup: &str| {
			masked(&format!("sent 181 bytes  received 19 bytes  2.00 bytes/sec\ntotal size is 201  speedup is {speedup}\n"), GROUPED)
		};
		assert!(boundary("1.00").contains("speedup is {SPEEDUP}"));
		assert!(boundary("1.01").contains("speedup is 1.01"));
		// Very large counts, at every level: the speedup rsync prints for them
		// is masked, though a `double` that large is coarser than a hundredth.
		for level in 0..=3 {
			let (size, sent, received) = (72_057_594_037_927_960u64, 181u64, 341u64);
			let speedup = comma_dnum(size as f64 / (sent + received) as f64, level);
			let text = format!(
				"sent {} bytes  received {} bytes  1.00 bytes/sec\ntotal size is {}  speedup is {speedup}\n",
				big_num(sent, level),
				big_num(received, level),
				big_num(size, level)
			);
			assert!(masked(&text, Spelling(level)).contains("speedup is {SPEEDUP}"), "level {level}: {text}");
		}
	}

	/// A count of at most `max_bits` bits, its bit length drawn uniformly so
	/// that every magnitude comes up (xorshift64 on `state`).
	fn draw(state: &mut u64, max_bits: u32) -> u64 {
		let mut step = || {
			*state ^= *state << 13;
			*state ^= *state >> 7;
			*state ^= *state << 17;
			*state
		};
		let bits = (step() % u64::from(max_bits + 1)) as u32;
		if bits == 0 { 0 } else { step() >> (64 - bits) }
	}

	/// The summary lines rsync prints for `size`, `sent` and `received` at
	/// `level`, with the speedup `speedup` gives for their quotient.
	fn summary_lines(size: u64, sent: u64, received: u64, level: u8, speedup: impl Fn(f64) -> f64) -> String {
		let quotient = size as f64 / (u128::from(sent) + u128::from(received)) as f64;
		format!(
			"sent {} bytes  received {} bytes  1.00 bytes/sec\ntotal size is {}  speedup is {}\n",
			big_num(sent, level),
			big_num(received, level),
			big_num(size, level),
			comma_dnum(speedup(quotient), level)
		)
	}

	fn speedup_masked(text: &str, level: u8) -> bool {
		let (normalized, _) = normalize(text.as_bytes(), b"/w", (0, 0), Spelling(level));
		String::from_utf8(normalized).unwrap().contains("speedup is {SPEEDUP}")
	}

	/// The counts a token stands for reach `u64::MAX`, at every level.
	#[test]
	fn token_ranges_reach_u64_max() {
		for level in 0..=3u8 {
			let token = big_num(u64::MAX, level);
			let range = values_printed_as(token.as_bytes(), Spelling(level));
			assert_eq!(range.map(|(_, hi)| hi), Some(u64::MAX), "level {level}: {token}");
		}
		assert_eq!(values_printed_as(b"18446744073709551615", PLAIN), Some((u64::MAX, u64::MAX)));
		assert_eq!(values_printed_as(b"18,446,744,073,709,551,615", GROUPED), Some((u64::MAX, u64::MAX)));
	}

	/// Whatever counts rsync prints, the speedup it prints with them is masked,
	/// at every level: witnesses at an edge of a scaled token's range (a `4.50P`
	/// size over 522 bytes), counts in G on both sides, the truncation quirk
	/// from 1000 up, the 1000 boundary, and counts of every magnitude.
	#[test]
	fn the_speedup_rsync_prints_is_always_masked() {
		let mut cases = vec![
			(4_495_000_000_000_000u64, 181u64, 341u64),
			(4_020_000_021, 4_000_000_000, 20),
			(4_020_000_021, 4_000_000_004, 20),
			(9_999_999, 900, 100),
			(999_996, 900, 100),
			(1_000_004, 900, 100),
			(u64::MAX, 1, 0),
			(u64::MAX, 181, 341),
			(0, 52, 20),
		];
		let mut state = 0x9E37_79B9_7F4A_7C15;
		for _ in 0..300 {
			cases.push((draw(&mut state, 64), draw(&mut state, 61).max(1), draw(&mut state, 61)));
		}
		// Quotients from W.995 up to W + 1, which print `W.00` from 1000 up.
		for _ in 0..50 {
			let (whole, divisor) = (1000 + draw(&mut state, 30), 200 + draw(&mut state, 16));
			cases.push((whole * divisor + divisor - 1, divisor - 20, 20));
		}
		for (size, sent, received) in cases {
			for level in 0..=3u8 {
				let text = summary_lines(size, sent, received, level, |q| q);
				assert!(speedup_masked(&text, level), "level {level}: {text}");
			}
		}
	}

	/// A speedup no counts the tokens stand for give is kept as printed: with
	/// exact counts (levels 0 and 1) one a hundredth either way, and at every
	/// level one twice as large and more.
	#[test]
	fn a_speedup_its_counts_do_not_give_is_kept() {
		let mut state = 0x2545_F491_4F6C_DD1D;
		for _ in 0..200 {
			let (size, sent, received) = (draw(&mut state, 64), draw(&mut state, 61).max(1), draw(&mut state, 61));
			for level in 0..=3u8 {
				let printed = summary_lines(size, sent, received, level, |q| q);
				let mut others = vec![summary_lines(size, sent, received, level, |q| q * 2.0 + 1.0)];
				if level <= 1 {
					others.push(summary_lines(size, sent, received, level, |q| q + 0.01));
					others.push(summary_lines(size, sent, received, level, |q| (q - 0.01).max(0.0)));
				}
				for other in others.into_iter().filter(|other| *other != printed) {
					assert!(!speedup_masked(&other, level), "level {level}: {other}");
				}
			}
		}
	}

	/// Two correct runs a few headers apart compare equal at every level, even
	/// where a header changes the speedup rsync prints (`4.02G` over `4.00G`
	/// and 20 bytes prints 1.01, and 1.00 with four bytes more).
	#[test]
	fn runs_whole_headers_apart_compare_equal() {
		let mut cases = vec![(4_020_000_021u64, 4_000_000_000u64, 20u64)];
		let mut state = 0xD1B5_4A32_D192_ED03;
		for _ in 0..40 {
			cases.push((draw(&mut state, 64), draw(&mut state, 61).max(1), draw(&mut state, 61)));
		}
		for (size, sent, received) in cases {
			for headers in 1..=MAX_HEADERS {
				for level in 0..=3u8 {
					let spelling = Spelling(level);
					let ours = summary_lines(size, sent, received, level, |q| q);
					let theirs = summary_lines(size, sent + headers * MUX_HEADER, received, level, |q| q);
					let (ours_text, ours_counts) = normalize(ours.as_bytes(), b"/w", (0, 0), spelling);
					let (theirs_text, theirs_counts) = normalize(theirs.as_bytes(), b"/w", (0, 0), spelling);
					assert_eq!(ours_text, theirs_text, "level {level}:\n{ours}{theirs}");
					assert!(counts_match(&ours_counts, &theirs_counts), "level {level}:\n{ours}{theirs}");
				}
			}
		}
	}
}
