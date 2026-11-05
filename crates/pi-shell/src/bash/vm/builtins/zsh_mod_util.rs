//! Helpers shared by the zsh module ports (`zsh_mod_*.rs`).
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use std::io;

use bstr::{BString, ByteSlice};

use crate::bash::{
	diag::strerror,
	vm::{
		expand::{Expander, X},
		zsh::params::{self, PmFlags},
	},
};

/// zsh `zerrmsg`'s `%e`: the `strerror` text of `err` with its first letter
/// lowercased (kept for `EIO`); `EINTR` reads `interrupt`.
pub fn zsh_errmsg(err: &io::Error) -> String {
	if err.kind() == io::ErrorKind::Interrupted {
		return "interrupt".into();
	}
	let text = strerror(err);
	#[cfg(unix)]
	if err.raw_os_error() == Some(libc::EIO) {
		return text.into_owned();
	}
	let mut chars = text.chars();
	chars.next().map_or_else(String::new, |first| {
		let mut s = String::with_capacity(text.len());
		s.push(first.to_ascii_lowercase());
		s.push_str(chars.as_str());
		s
	})
}

/// zsh `zstrtol(s, &t, 10)`: leading blanks and a sign skipped, then the
/// decimal digits (wrapping like `zlong`); the value and the unparsed rest
/// (after the sign when no digit follows).
pub fn zstrtol(s: &[u8]) -> (i64, &[u8]) {
	let s = s.trim_start_with(|c| c == ' ' || c == '\t');
	let (neg, body) = match s.first() {
		Some(b'-') => (true, &s[1..]),
		Some(b'+') => (false, &s[1..]),
		_ => (false, s),
	};
	let n = body.iter().take_while(|c| c.is_ascii_digit()).count();
	let v = body[..n]
		.iter()
		.fold(0i64, |v, &c| v.wrapping_mul(10).wrapping_add(i64::from(c - b'0')));
	(if neg { v.wrapping_neg() } else { v }, &body[n..])
}

/// The local zone at `secs` since the epoch (zsh `localtime`, which
/// follows an exported `TZ`): its offset east of UTC in seconds and its
/// abbreviation.
///
/// # Errors
/// A store failure reading `TZ`.
pub fn local_zone(ex: &mut Expander<'_, '_>, secs: i64) -> X<(i32, BString)> {
	let mb = params::mb(ex)?;
	let tz = params::getparam(ex, b"TZ")?
		.filter(|p| p.flags.contains(PmFlags::EXPORTED))
		.map(|p| p.strval(mb));
	Ok(ex.cx.host.tz_offset(tz.as_ref().map(|t| t.as_bstr()), secs))
}

/// zsh `ztrftime(buf, …, fmt, localtime(secs))` for the module listings:
/// C `strftime` plus zsh's `%K`, `%L` (24h and 12h hour, space padded) and
/// `%f` (day of month, unpadded).
///
/// # Errors
/// A store failure reading `TZ`.
pub fn ztrftime(ex: &mut Expander<'_, '_>, fmt: &[u8], secs: i64) -> X<Vec<u8>> {
	let (offset, abbr) = local_zone(ex, secs)?;
	let mut f = Vec::with_capacity(fmt.len());
	let mut i = 0;
	while i < fmt.len() {
		if fmt[i] == b'%' && i + 1 < fmt.len() {
			match fmt[i + 1] {
				b'K' => f.extend_from_slice(b"%k"),
				b'L' => f.extend_from_slice(b"%l"),
				b'f' => f.extend_from_slice(b"%-d"),
				c => f.extend_from_slice(&[b'%', c]),
			}
			i += 2;
			continue;
		}
		f.push(fmt[i]);
		i += 1;
	}
	Ok(super::strftime::format(&f, secs, offset, &abbr))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn zstrtol_reads_like_zsh() {
		assert_eq!(zstrtol(b"12x"), (12, &b"x"[..]));
		assert_eq!(zstrtol(b"x"), (0, &b"x"[..]));
		assert_eq!(zstrtol(b" -3"), (-3, &b""[..]));
		assert_eq!(zstrtol(b"-"), (0, &b""[..]));
	}

	#[cfg(unix)]
	#[test]
	fn errno_text_is_lowercased_except_eio() {
		assert_eq!(zsh_errmsg(&io::Error::from_raw_os_error(libc::EINVAL)), "invalid argument");
		assert_eq!(zsh_errmsg(&io::ErrorKind::Interrupted.into()), "interrupt");
	}
}
