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

use std::sync::LazyLock;

use chrono::{Local, NaiveDateTime, TimeZone};
use regex::bytes::{Captures, Regex};

static RATE: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(sent \S+ bytes  received \S+ bytes  )\S+( bytes/sec)$").unwrap());
static LIST_TIME: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?m)^(File list (?:generation|transfer) time: )[0-9.]+( seconds)$").unwrap());
static STAMP: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\d{4}/\d\d/\d\d \d\d:\d\d:\d\d").unwrap());
static PID: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\{TIME\} \[\d+\]").unwrap());

/// Applies every rule above to `data` produced in work directory `w` while
/// the wall clock was within `window` (Unix seconds, inclusive).
pub(super) fn normalize(data: &[u8], w: &[u8], window: (i64, i64)) -> Vec<u8> {
	let data = replace_all(data, w, b"{W}");
	let data = RATE.replace_all(&data, &b"${1}#${2}"[..]);
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
	out
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
