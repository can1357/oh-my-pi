//! Output normalization. Each rule masks one value that legitimately differs
//! between two runs of the *same* binary (or between two correct builds), and
//! nothing else:
//!
//! 1. The side's absolute work directory becomes `{W}`: each side runs in its
//!    own copy of the fixture, and diagnostics quote full paths.
//! 2. The transfer rate in the summary line
//!    (`sent N bytes  received N bytes  <rate> bytes/sec`) becomes `#`; the
//!    byte counts and the `speedup` stay (they derive from byte counts only).
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

use std::ops::Range;

use chrono::{Local, NaiveDateTime, TimeZone};
use memchr::memchr_iter;

/// Applies every rule above to `data` produced in work directory `w` while
/// the wall clock was within `window` (Unix seconds, inclusive).
pub(super) fn normalize(data: &[u8], w: &[u8], window: (i64, i64)) -> Vec<u8> {
	let data = replace_all(data, w, b"{W}");
	let mut out = Vec::with_capacity(data.len());
	let mut in_build_block = false;
	let mut start = 0;
	for end in memchr_iter(b'\n', &data).chain([data.len()]) {
		let line = &data[start..end];
		if !in_build_block || !line.starts_with(b"    ") {
			in_build_block = line == b"Capabilities:" || line == b"Optimizations:";
			if start > 0 {
				out.push(b'\n');
			}
			normalize_line(line, window, &mut out);
		}
		start = end + 1;
	}
	out
}

/// Writes a line with volatile rates, timings and log prefixes masked.
fn normalize_line(line: &[u8], window: (i64, i64), out: &mut Vec<u8>) {
	// These summary forms cannot contain a log prefix or a timestamp spanning two fields.
	if let Some(rate) = transfer_rate(line).or_else(|| list_time(line)) {
		out.extend_from_slice(&line[..rate.start]);
		out.push(b'#');
		out.extend_from_slice(&line[rate.end..]);
		return;
	}
	let mut copied = 0;
	if let Some(len) = line.strip_prefix(b"{TIME}").and_then(log_pid_len) {
		out.extend_from_slice(b"{TIME} [PID]");
		copied = b"{TIME}".len() + len;
	}
	let mut matched_end = copied;
	for slash in memchr_iter(b'/', line) {
		let Some(start) = slash.checked_sub(4).filter(|&start| start >= matched_end) else {
			continue;
		};
		let Some(stamp) = line.get(start..start + 19).filter(|stamp| is_timestamp(stamp)) else {
			continue;
		};
		// Even a timestamp outside the window consumes its entire span.
		matched_end = start + stamp.len();
		let during_run = std::str::from_utf8(stamp)
			.ok()
			.and_then(|s| NaiveDateTime::parse_from_str(s, "%Y/%m/%d %H:%M:%S").ok())
			.and_then(|local| Local.from_local_datetime(&local).earliest())
			.is_some_and(|t| (window.0 - 2..=window.1 + 2).contains(&t.timestamp()));
		if during_run {
			out.extend_from_slice(&line[copied..start]);
			out.extend_from_slice(b"{TIME}");
			copied = matched_end;
			if start == 0
				&& let Some(len) = log_pid_len(&line[copied..])
			{
				out.extend_from_slice(b" [PID]");
				copied += len;
				matched_end = copied;
			}
		}
	}
	out.extend_from_slice(&line[copied..]);
}

/// Locates the variable rate in `sent N bytes  received N bytes  RATE bytes/sec`.
fn transfer_rate(line: &[u8]) -> Option<Range<usize>> {
	let rest = line.strip_prefix(b"sent ")?.strip_suffix(b" bytes/sec")?;
	let sent_end = memchr::memchr(b' ', rest)?;
	let received = rest[sent_end..].strip_prefix(b" bytes  received ")?;
	let received_end = memchr::memchr(b' ', received)?;
	let rate = received[received_end..].strip_prefix(b" bytes  ")?;
	if !is_nonblank_word(&rest[..sent_end]) || !is_nonblank_word(&received[..received_end]) || !is_nonblank_word(rate) {
		return None;
	}
	let end = line.len() - b" bytes/sec".len();
	Some(end - rate.len()..end)
}

/// Whether a byte field is valid UTF-8 text without whitespace.
fn is_nonblank_word(word: &[u8]) -> bool {
	if word.is_empty() {
		return false;
	}
	match word.iter().find(|&&b| matches!(b, b' ' | b'\t'..=b'\r' | 0x80..=0xff)) {
		None => true,
		Some(0x80..=0xff) => is_nonblank_utf8(word),
		Some(_) => false,
	}
}

/// Whether a non-ASCII field is valid UTF-8 text without whitespace.
#[cold]
fn is_nonblank_utf8(word: &[u8]) -> bool {
	std::str::from_utf8(word).is_ok_and(|word| !word.contains(char::is_whitespace))
}

/// Locates the elapsed time on a `File list generation time:` or `File list transfer time:` line.
fn list_time(line: &[u8]) -> Option<Range<usize>> {
	let rest = line.strip_prefix(b"File list ")?;
	let rest = rest.strip_prefix(b"generation time: ").or_else(|| rest.strip_prefix(b"transfer time: "))?;
	let seconds = rest.strip_suffix(b" seconds")?;
	if seconds.is_empty() || !seconds.iter().all(|b| matches!(b, b'0'..=b'9' | b'.')) {
		return None;
	}
	let start = line.len() - rest.len();
	Some(start..start + seconds.len())
}

/// Recognizes the `YYYY/MM/DD hh:mm:ss` timestamp layout.
fn is_timestamp(stamp: &[u8]) -> bool {
	matches!(stamp, [
		b'0'..=b'9', b'0'..=b'9', b'0'..=b'9', b'0'..=b'9', b'/',
		b'0'..=b'9', b'0'..=b'9', b'/', b'0'..=b'9', b'0'..=b'9', b' ',
		b'0'..=b'9', b'0'..=b'9', b':', b'0'..=b'9', b'0'..=b'9', b':', b'0'..=b'9', b'0'..=b'9',
	])
}

/// The length of the ` [1234]` process ID following a timestamp.
fn log_pid_len(suffix: &[u8]) -> Option<usize> {
	let digits = suffix.strip_prefix(b" [")?;
	let end = digits.iter().take_while(|b| b.is_ascii_digit()).count();
	(end > 0 && digits.get(end) == Some(&b']')).then_some(end + 3)
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
