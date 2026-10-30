//! Number formatting, time and permission strings, the itemize string, and
//! the `--out-format` / `--log-file-format` escape engine.

use std::fmt::NumBuffer;

use crate::rsync::consts::{
	ITEM_DELETED, ITEM_IS_NEW, ITEM_LOCAL_CHANGE, ITEM_MISSING_DATA, ITEM_REPORT_ACL,
	ITEM_REPORT_ATIME, ITEM_REPORT_CHANGE, ITEM_REPORT_CRTIME, ITEM_REPORT_GROUP,
	ITEM_REPORT_OWNER, ITEM_REPORT_PERMS, ITEM_REPORT_SIZE, ITEM_REPORT_TIME,
	ITEM_REPORT_TIMEFAIL, ITEM_REPORT_XATTR, ITEM_TRANSFER, ITEM_XNAME_FOLLOWS, MAXPATHLEN,
	S_IFBLK, S_IFCHR, S_IFDIR, S_IFIFO, S_IFLNK, S_IFMT, S_IFSOCK, S_ISGID, S_ISUID, S_ISVTX,
	mode_is_device, mode_is_dir, mode_is_lnk, mode_is_special,
};
use crate::rsync::paths;

/// "1,234" / "1.23K" (-h levels) number formatting (do_big_num / human_num).
///
/// `human` 0 prints plain digits, 1 adds thousands separators, 2 scales by 1000 with a
/// K/M/G/T/P suffix, 3 (or more) scales by 1024.
pub(crate) fn big_num(n: i64, human: u8) -> String {
	big_num_fract(n, human, "")
}

/// do_big_num with a fraction string appended when no unit suffix is used.
fn big_num_fract(n: i64, human: u8, fract: &str) -> String {
	if human > 1 {
		let mult: i64 = if human == 2 { 1000 } else { 1024 };
		if n >= mult || n <= -mult {
			let multf = mult as f64;
			let mut value = (n as f64 / multf).abs();
			let mut unit = 'K';
			for next in ['M', 'G', 'T'] {
				if value < multf {
					break;
				}
				value /= multf;
				unit = next;
			}
			if value >= multf {
				value /= multf;
				unit = 'P';
			}
			if n < 0 {
				value = -value;
			}
			return format!("{value:.2}{unit}");
		}
	}
	let mut buf = NumBuffer::new();
	let digits = n.unsigned_abs().format_into(&mut buf);
	let mut out = String::with_capacity(digits.len() * 4 / 3 + fract.len() + 1);
	if n < 0 {
		out.push('-');
	}
	if human > 0 {
		for (index, ch) in digits.chars().enumerate() {
			if index != 0 && (digits.len() - index).is_multiple_of(3) {
				out.push(',');
			}
			out.push(ch);
		}
	} else {
		out.push_str(digits);
	}
	out.push_str(fract);
	out
}

/// do_big_dnum: a double with `digits` decimals; separators/units only from 1000 up.
pub(crate) fn big_dnum(value: f64, human: u8, digits: usize) -> String {
	let plain = format!("{value:.digits$}");
	if human == 0 || (value < 1000.0 && value > -1000.0) || !value.is_finite() {
		return plain;
	}
	// The fraction is whatever follows the leading run of digits (after the first char).
	let skip = plain
		.char_indices()
		.skip(1)
		.find(|(_, ch)| !ch.is_ascii_digit())
		.map_or(plain.len(), |(index, _)| index);
	big_num_fract(value as i64, human, &plain[skip..])
}

/// Upstream timestring(): local `YYYY/MM/DD hh:mm:ss`.
pub(crate) fn timestring(seconds: i64, tz: &jiff::tz::TimeZone) -> String {
	match jiff::Timestamp::from_second(seconds) {
		Ok(ts) => {
			let zoned = ts.to_zoned(tz.clone());
			format!(
				"{:4}/{:02}/{:02} {:02}:{:02}:{:02}",
				zoned.year(),
				zoned.month(),
				zoned.day(),
				zoned.hour(),
				zoned.minute(),
				zoned.second()
			)
		}
		Err(_) => "(time out of range)".to_owned(),
	}
}

/// ls-style 10-character mode string (`drwxr-xr-x`).
pub(crate) fn permstring(mode: u32) -> [u8; 10] {
	let mut out = *b"----------";
	let map = b"rwxrwxrwx";
	for bit in 0..9 {
		if mode & (1 << bit) != 0 {
			out[9 - bit] = map[8 - bit];
		}
	}
	if mode & S_ISUID != 0 {
		out[3] = if mode & 0o100 != 0 { b's' } else { b'S' };
	}
	if mode & S_ISGID != 0 {
		out[6] = if mode & 0o010 != 0 { b's' } else { b'S' };
	}
	if mode & S_ISVTX != 0 {
		out[9] = if mode & 0o001 != 0 { b't' } else { b'T' };
	}
	out[0] = match mode & S_IFMT {
		S_IFDIR => b'd',
		S_IFLNK => b'l',
		S_IFBLK => b'b',
		S_IFCHR => b'c',
		S_IFSOCK => b's',
		S_IFIFO => b'p',
		_ => b'-',
	};
	out
}

/// Session facts the itemize string depends on.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ItemizeCtx {
	/// Both halves run in this process (local copy): sends still show `>`.
	pub local_server: bool,
	/// `-t` in effect.
	pub preserve_mtimes: bool,
	/// The receiver can set symlink times.
	pub receiver_symlink_times: bool,
}

/// The `%i` string: `*deleting  ` or the 11-character `YXcstpoguax` summary.
pub(crate) fn itemize(iflags: u32, mode: u32, op: &str, ctx: ItemizeCtx) -> [u8; 11] {
	if iflags & ITEM_DELETED != 0 {
		return *b"*deleting  ";
	}
	let flag = |bit: u32, ch: u8| if iflags & bit != 0 { ch } else { b'.' };
	let mut c = [b'.'; 11];
	c[0] = if iflags & ITEM_LOCAL_CHANGE != 0 {
		if iflags & ITEM_XNAME_FOLLOWS != 0 { b'h' } else { b'c' }
	} else if iflags & ITEM_TRANSFER == 0 {
		b'.'
	} else if !ctx.local_server && op.starts_with('s') {
		b'<'
	} else {
		b'>'
	};
	let time_changed = iflags & ITEM_REPORT_TIME != 0;
	if mode_is_lnk(mode) {
		c[1] = b'L';
		c[3] = b'.';
		c[4] = if !time_changed {
			b'.'
		} else if !ctx.preserve_mtimes
			|| !ctx.receiver_symlink_times
			|| iflags & ITEM_REPORT_TIMEFAIL != 0
		{
			b'T'
		} else {
			b't'
		};
	} else {
		c[1] = if mode_is_dir(mode) {
			b'd'
		} else if mode_is_special(mode) {
			b'S'
		} else if mode_is_device(mode) {
			b'D'
		} else {
			b'f'
		};
		c[3] = flag(ITEM_REPORT_SIZE, b's');
		c[4] = if !time_changed {
			b'.'
		} else if !ctx.preserve_mtimes {
			b'T'
		} else {
			b't'
		};
	}
	c[2] = flag(ITEM_REPORT_CHANGE, b'c');
	c[5] = flag(ITEM_REPORT_PERMS, b'p');
	c[6] = flag(ITEM_REPORT_OWNER, b'o');
	c[7] = flag(ITEM_REPORT_GROUP, b'g');
	let both = ITEM_REPORT_ATIME | ITEM_REPORT_CRTIME;
	c[8] = match iflags & both {
		0 => b'.',
		bits if bits == both => b'b',
		ITEM_REPORT_ATIME => b'u',
		_ => b'n',
	};
	c[9] = flag(ITEM_REPORT_ACL, b'a');
	c[10] = flag(ITEM_REPORT_XATTR, b'x');
	if iflags & (ITEM_IS_NEW | ITEM_MISSING_DATA) != 0 {
		let fill = if iflags & ITEM_IS_NEW != 0 { b'+' } else { b'?' };
		c[2..].fill(fill);
	} else if matches!(c[0], b'.' | b'h' | b'c') && c[2..].iter().all(|&ch| ch == b'.') {
		c[2..].fill(b' ');
	}
	c
}

/// Width/justification modifiers of one escape (`%-10l`, `%05n`).
#[derive(Clone, Copy, Debug, Default)]
struct Spec {
	left: bool,
	zero: bool,
	width: usize,
	/// Any `-` or digit was given (upstream's `fmt[1]`).
	present: bool,
}

/// Upper bound of one expanded escape (upstream's scratch buffer).
const ESCAPE_CAP: usize = MAXPATHLEN - 1;

impl Spec {
	/// printf `%<spec>s`: pad to width (zeros when the width starts with 0, as the
	/// reference libc does even for strings), truncated like the scratch buffer.
	fn pad(self, value: &[u8], cap: usize) -> Vec<u8> {
		let mut out = Vec::with_capacity(value.len().max(self.width).min(cap));
		let fill = self.width.saturating_sub(value.len());
		if !self.left {
			let byte = if self.zero { b'0' } else { b' ' };
			out.resize(fill.min(cap), byte);
		}
		out.extend_from_slice(value);
		if self.left {
			let target = out.len().saturating_add(fill).min(cap);
			out.resize(target.max(out.len()), b' ');
		}
		out.truncate(cap);
		out
	}
}

/// Everything an escape needs besides the item.
pub(super) struct FormatEnv<'a> {
	pub itemize: ItemizeCtx,
	pub preserve_uid: bool,
	pub preserve_gid: bool,
	pub tz: &'a jiff::tz::TimeZone,
	pub now: i64,
	pub pid: u32,
	pub module: Option<&'a [u8]>,
	pub host: Option<&'a [u8]>,
	pub addr: Option<&'a [u8]>,
	pub user: Option<&'a [u8]>,
	pub module_path: Option<&'a [u8]>,
	/// `%C` digest, already rendered (`Some(hex)`) or blank of this many hex digits.
	pub checksum: Result<Vec<u8>, usize>,
}

/// The data one formatted line describes.
pub(super) struct FormatItem<'a> {
	pub name: &'a [u8],
	pub dir_prefix: Option<&'a [u8]>,
	pub mode: u32,
	pub size: u64,
	pub mtime: i64,
	pub uid: u32,
	pub gid: u32,
	pub skip_group: bool,
	pub link: Option<&'a [u8]>,
	pub hlink: Option<&'a [u8]>,
	pub iflags: u32,
	pub op: &'a str,
	pub bytes_xfer: u64,
	pub bytes_csum: u64,
	/// The name came from a deletion (`log_delete`), not a file-list entry.
	pub from_delete: bool,
}

/// Why a format could not be expanded (upstream exits with RERR_MESSAGEIO).
#[derive(Debug, PartialEq, Eq)]
pub(super) enum FormatError {
	/// The format string itself exceeds MAXPATHLEN.
	TooLong,
	/// Expansion overflowed the line buffer at this escape letter.
	Overflow(u8),
}

impl FormatError {
	pub(super) fn message(&self) -> String {
		match self {
			Self::TooLong => "log-format string is WAY too long!".to_owned(),
			Self::Overflow(letter) => {
				format!("buffer overflow expanding %{} -- exiting", char::from(*letter))
			}
		}
	}
}

/// Width digits an escape may carry (upstream's 32-byte scratch format minus room).
const MAX_SPEC_LEN: usize = 32 - 8;

/// log_format_has: does `format` use escape `esc` (`b` in `%9b`)?
pub(crate) fn log_format_has(format: &[u8], esc: u8) -> bool {
	let mut pos = 0;
	while let Some(offset) = memchr::memchr(b'%', &format[pos..]) {
		let mut p = pos + offset + 1;
		while format.get(p) == Some(&b'\'') {
			p += 1;
		}
		let mut spec_len = 1;
		if format.get(p) == Some(&b'-') {
			p += 1;
			spec_len += 1;
		}
		while format.get(p).is_some_and(u8::is_ascii_digit) && spec_len < MAX_SPEC_LEN {
			p += 1;
			spec_len += 1;
		}
		while format.get(p) == Some(&b'\'') {
			p += 1;
		}
		let Some(&letter) = format.get(p) else {
			break;
		};
		if letter == esc {
			return true;
		}
		if letter == b'%' {
			p += 1;
		}
		pos = p;
	}
	false
}

/// Joins a sender's directory prefix and a name (pathjoin).
fn path_join(dir: &[u8], name: &[u8]) -> Vec<u8> {
	let mut out = Vec::with_capacity(dir.len() + name.len() + 1);
	out.extend_from_slice(dir);
	if !dir.is_empty() && !dir.ends_with(b"/") {
		out.push(b'/');
	}
	out.extend_from_slice(name);
	out
}

/// Expands one format line (log_formatted); the result carries the trailing newline.
pub(super) fn expand(
	format: &[u8],
	item: &FormatItem<'_>,
	env: &FormatEnv<'_>,
) -> Result<Vec<u8>, FormatError> {
	if format.len() > MAXPATHLEN {
		return Err(FormatError::TooLong);
	}
	let line_cap = MAXPATHLEN + 1024;
	let mut out = Vec::with_capacity(format.len() + 64);
	let mut pos = 0;
	while pos < format.len() {
		let Some(offset) = memchr::memchr(b'%', &format[pos..]) else {
			out.extend_from_slice(&format[pos..]);
			break;
		};
		out.extend_from_slice(&format[pos..pos + offset]);
		let start = pos + offset;
		let mut p = start + 1;
		let mut humanize: u8 = 0;
		let mut spec = Spec::default();
		while format.get(p) == Some(&b'\'') {
			humanize = humanize.saturating_add(1);
			p += 1;
		}
		let mut spec_len = 1;
		if format.get(p) == Some(&b'-') {
			spec.left = true;
			spec.present = true;
			spec_len += 1;
			p += 1;
		}
		let mut first_digit = true;
		while let Some(&digit) = format.get(p).filter(|b| b.is_ascii_digit()) {
			if spec_len >= MAX_SPEC_LEN {
				break;
			}
			if first_digit && digit == b'0' {
				spec.zero = true;
			}
			first_digit = false;
			spec.present = true;
			spec.width = spec.width.saturating_mul(10).saturating_add(usize::from(digit - b'0'));
			spec_len += 1;
			p += 1;
		}
		while format.get(p) == Some(&b'\'') {
			humanize = humanize.saturating_add(1);
			p += 1;
		}
		// The appended newline is the escape letter of a format ending in `%`.
		let letter = format.get(p).copied().unwrap_or(b'\n');
		match expand_escape(letter, spec, humanize, item, env) {
			Some(text) => {
				out.extend_from_slice(&text);
				pos = p + 1;
			}
			None => {
				out.extend_from_slice(&format[start..p.min(format.len())]);
				pos = p;
			}
		}
		if out.len() + 1 >= line_cap {
			return Err(FormatError::Overflow(letter));
		}
	}
	out.push(b'\n');
	Ok(out)
}

/// The text of one escape, or None when it stays literal.
fn expand_escape(
	letter: u8,
	spec: Spec,
	humanize: u8,
	item: &FormatItem<'_>,
	env: &FormatEnv<'_>,
) -> Option<Vec<u8>> {
	let cap = ESCAPE_CAP;
	let padded = |value: &[u8]| if spec.present { spec.pad(value, cap) } else { value.to_vec() };
	let text = match letter {
		b'h' => padded(env.host?),
		b'a' => padded(env.addr?),
		b'm' => padded(env.module.unwrap_or_default()),
		b'P' => padded(env.module_path?),
		b'u' => padded(env.user?),
		b'l' => {
			let size = i64::try_from(item.size).unwrap_or(i64::MAX);
			spec.pad(big_num(size, humanize).as_bytes(), cap)
		}
		b'U' => {
			let uid = if env.preserve_uid { item.uid } else { 0 };
			spec.pad(uid.format_into(&mut NumBuffer::new()).as_bytes(), cap)
		}
		b'G' => {
			if !env.preserve_gid || item.skip_group {
				padded(b"DEFAULT")
			} else {
				spec.pad(item.gid.format_into(&mut NumBuffer::new()).as_bytes(), cap)
			}
		}
		b'p' => spec.pad(env.pid.format_into(&mut NumBuffer::new()).as_bytes(), cap),
		b'M' => {
			let mut stamp = timestring(item.mtime, env.tz).into_bytes();
			for byte in &mut stamp {
				if *byte == b' ' {
					*byte = b'-';
				}
			}
			padded(&stamp)
		}
		b'B' => padded(&permstring(item.mode)[1..]),
		b'o' => padded(item.op.as_bytes()),
		b'f' => {
			let joined = match item.dir_prefix {
				Some(dir) if !item.from_delete => paths::clean_fname(&path_join(dir, item.name), false),
				_ => paths::clean_fname(item.name, false),
			};
			let shown = joined.strip_prefix(b"/").unwrap_or(&joined);
			padded(shown)
		}
		b'n' => {
			let mut name = item.name.to_vec();
			if mode_is_dir(item.mode) {
				name.push(b'/');
			}
			padded(&name)
		}
		b'L' => {
			let (arrow, target): (&[u8], &[u8]) = match (item.hlink, item.link) {
				(Some(hlink), _) if !hlink.is_empty() => (&b" => "[..], hlink),
				(_, link) if mode_is_lnk(item.mode) && !item.from_delete => {
					(&b" -> "[..], link.unwrap_or_default())
				}
				_ if !spec.present => return Some(Vec::new()),
				_ => (&b"    "[..], &b""[..]),
			};
			let mut text = arrow.to_vec();
			text.extend_from_slice(&spec.pad(target, cap.saturating_sub(4)));
			text
		}
		b't' => padded(timestring(env.now, env.tz).as_bytes()),
		b'b' | b'c' => {
			let bytes = if item.iflags & ITEM_TRANSFER == 0 {
				0
			} else if letter == b'b' {
				item.bytes_xfer
			} else {
				item.bytes_csum
			};
			let bytes = i64::try_from(bytes).unwrap_or(i64::MAX);
			spec.pad(big_num(bytes, humanize).as_bytes(), cap)
		}
		b'C' => match &env.checksum {
			Ok(hex) => padded(hex),
			// Upstream builds the blank directly in its scratch buffer: no width applied.
			Err(hex_len) => vec![b' '; (*hex_len).min(cap)],
		},
		b'i' => padded(&itemize(item.iflags, item.mode, item.op, env.itemize)),
		b'%' => padded(b"%"),
		_ => return None,
	};
	Some(text)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn big_num_levels() {
		let cases: [(i64, [&str; 4]); 7] = [
			(0, ["0", "0", "0", "0"]),
			(999, ["999", "999", "999", "999"]),
			(1000, ["1000", "1,000", "1.00K", "1,000"]),
			(1023, ["1023", "1,023", "1.02K", "1,023"]),
			(1024, ["1024", "1,024", "1.02K", "1.00K"]),
			(1_000_000, ["1000000", "1,000,000", "1.00M", "976.56K"]),
			(1_234_567, ["1234567", "1,234,567", "1.23M", "1.18M"]),
		];
		for (n, expected) in cases {
			for (human, want) in expected.iter().enumerate() {
				assert_eq!(big_num(n, human as u8), *want, "big_num({n}, {human})");
			}
		}
		assert_eq!(big_num(-1_234_567, 1), "-1,234,567");
		assert_eq!(big_num(-2048, 3), "-2.00K");
		assert_eq!(big_num(i64::MIN, 0), "-9223372036854775808");
		assert_eq!(big_num(5 * 1024_i64.pow(5), 3), "5.00P");
		assert_eq!(big_num(123_456, 1), "123,456");
		assert_eq!(big_num(12_345, 1), "12,345");
	}

	#[test]
	fn big_dnum_levels() {
		// Values from the reference --stats summaries.
		assert_eq!(big_dnum(2_480_766.0, 1, 2), "2,480,766.00");
		assert_eq!(big_dnum(212.0, 2, 2), "212.00");
		assert_eq!(big_dnum(1_239_606.0 / 318.0, 1, 2), "3,898.13");
		assert_eq!(big_dnum(2_480_766.0, 2, 2), "2.48M");
		assert_eq!(big_dnum(0.999_37, 1, 2), "1.00");
		assert_eq!(big_dnum(0.006, 1, 3), "0.006");
		assert_eq!(big_dnum(2_480_766.0, 0, 2), "2480766.00");
	}

	#[test]
	fn permstrings() {
		assert_eq!(&permstring(0o040_755), b"drwxr-xr-x");
		assert_eq!(&permstring(0o100_644), b"-rw-r--r--");
		assert_eq!(&permstring(0o104_755), b"-rwsr-xr-x");
		assert_eq!(&permstring(0o102_644), b"-rw-r-Sr--");
		assert_eq!(&permstring(0o041_777), b"drwxrwxrwt");
		assert_eq!(&permstring(0o120_777), b"lrwxrwxrwx");
	}

	const CTX: ItemizeCtx =
		ItemizeCtx { local_server: true, preserve_mtimes: true, receiver_symlink_times: true };

	fn item(iflags: u32, mode: u32) -> String {
		String::from_utf8(itemize(iflags, mode, "recv", CTX).to_vec()).unwrap()
	}

	#[test]
	fn itemize_strings_match_reference() {
		// Every expected string below was printed by the 3.5.1 reference (`-i`/`-ii`).
		let reg = 0o100_644;
		let dir = 0o040_755;
		let lnk = 0o120_777;
		assert_eq!(item(ITEM_TRANSFER | ITEM_IS_NEW, reg), ">f+++++++++");
		assert_eq!(item(ITEM_LOCAL_CHANGE | ITEM_IS_NEW, dir), "cd+++++++++");
		assert_eq!(item(ITEM_LOCAL_CHANGE | ITEM_IS_NEW, lnk), "cL+++++++++");
		assert_eq!(
			item(ITEM_LOCAL_CHANGE | ITEM_XNAME_FOLLOWS | ITEM_IS_NEW, reg),
			"hf+++++++++"
		);
		assert_eq!(item(ITEM_TRANSFER | ITEM_REPORT_SIZE, reg), ">f.s.......");
		assert_eq!(item(ITEM_TRANSFER | ITEM_REPORT_TIME, reg), ">f..t......");
		assert_eq!(item(ITEM_LOCAL_CHANGE | ITEM_REPORT_CHANGE, lnk), "cLc........");
		assert_eq!(item(ITEM_REPORT_PERMS, reg), ".f...p.....");
		assert_eq!(
			item(ITEM_LOCAL_CHANGE | ITEM_XNAME_FOLLOWS | ITEM_REPORT_SIZE, reg),
			"hf.s......."
		);
		assert_eq!(item(ITEM_DELETED, reg), "*deleting  ");
		assert_eq!(item(ITEM_REPORT_TIME, dir), ".d..t......");
		// -ii: unchanged items show spaces.
		assert_eq!(item(0, dir), ".d         ");
		assert_eq!(item(0, lnk), ".L         ");
		assert_eq!(item(ITEM_LOCAL_CHANGE | ITEM_XNAME_FOLLOWS, reg), "hf         ");
		// A non-local sender shows `<`.
		let remote = ItemizeCtx { local_server: false, ..CTX };
		assert_eq!(&itemize(ITEM_TRANSFER, reg, "send", remote), b"<f.........");
		assert_eq!(&itemize(ITEM_TRANSFER, reg, "send", CTX), b">f.........");
		// Time letters: T when times are not preserved or symlink times cannot be set.
		let no_t = ItemizeCtx { preserve_mtimes: false, ..CTX };
		assert_eq!(&itemize(ITEM_REPORT_TIME, reg, "recv", no_t), b".f..T......");
		let no_lt = ItemizeCtx { receiver_symlink_times: false, ..CTX };
		assert_eq!(&itemize(ITEM_REPORT_TIME, lnk, "recv", no_lt), b".L..T......");
		assert_eq!(
			item(ITEM_REPORT_TIME | ITEM_REPORT_TIMEFAIL, lnk),
			".L..T......"
		);
		// Remaining attribute letters.
		let attrs = ITEM_REPORT_OWNER
			| ITEM_REPORT_GROUP
			| ITEM_REPORT_ATIME
			| ITEM_REPORT_ACL
			| ITEM_REPORT_XATTR;
		assert_eq!(item(attrs, reg), ".f....oguax");
		assert_eq!(item(ITEM_REPORT_ATIME | ITEM_REPORT_CRTIME, reg), ".f......b..");
		assert_eq!(item(ITEM_REPORT_CRTIME, reg), ".f......n..");
		assert_eq!(item(ITEM_TRANSFER | ITEM_MISSING_DATA, reg), ">f?????????");
		assert_eq!(item(ITEM_TRANSFER, 0o020_644), ">D.........");
		assert_eq!(item(ITEM_TRANSFER, 0o010_644), ">S.........");
	}

	#[test]
	fn format_has() {
		assert!(log_format_has(b"%i %n%L", b'i'));
		assert!(log_format_has(b"%'-10b", b'b'));
		assert!(!log_format_has(b"%%i", b'i'));
		assert!(!log_format_has(b"%n", b'i'));
		assert!(!log_format_has(b"100%", b'i'));
	}
}
