//! The C library's POSIX regular expressions (`regcomp`/`regexec`), as zsh's
//! zsh/regex module uses them for `[[ s =~ re ]]` and `-regex-match`.
//!
//! zsh hands the pattern to the system's `regcomp(REG_EXTENDED
//! [| REG_ICASE])`, so its group rules, escapes and error texts are the C
//! library's (macOS reports `(a|ab)(c|bcd)(d*)` on `abcd` as `ab c d` and
//! fails `(` with `parentheses not balanced`; glibc differs). [`ere_match`]
//! calls the same functions under the shell's character set (a UTF-8 or
//! the C `LC_CTYPE`, set per thread with `uselocale`). Targets whose
//! `regex_t` layout is not spelled out here use the engine's own ERE
//! ([`crate::bash::pattern::Regex`], glibc's rules).

use core::ops::Range;

/// Why [`ere_match`] failed: the C library's `regerror` text.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RegexFail {
	/// `regcomp` rejected the pattern.
	Compile(String),
	/// `regexec` failed other than by not matching.
	Exec(String),
}

/// zsh/regex's match.
///
/// Compile `pattern` as `regcomp(REG_EXTENDED)` (`icase`
/// adds `REG_ICASE`) in a UTF-8 (`utf8`) or the C locale and run it on
/// `subject`. Both are C strings to the library: each ends at its first
/// NUL byte. `Ok(None)` when it does not match; otherwise the byte ranges
/// of the whole match and of every parenthesized group (`re_nsub + 1`
/// entries, `None` for a group the match did not use).
///
/// # Errors
/// The `regerror` text of a failed compile or match.
pub fn ere_match(
	pattern: &[u8],
	subject: &[u8],
	icase: bool,
	utf8: bool,
) -> Result<Option<Vec<Option<Range<usize>>>>, RegexFail> {
	native::ere_match(c_prefix(pattern), c_prefix(subject), icase, utf8)
}

/// `s` up to its first NUL byte (what a C function sees of it).
fn c_prefix(s: &[u8]) -> &[u8] {
	s.iter().position(|&c| c == 0).map_or(s, |n| &s[..n])
}

#[cfg(any(
	target_vendor = "apple",
	all(target_os = "linux", any(target_env = "gnu", target_env = "musl"))
))]
mod native {
	use core::{
		ffi::{c_char, c_int, c_void},
		ops::Range,
	};
	use std::{ffi::CString, sync::LazyLock};

	use super::RegexFail;

	/// `regex_t` (`<regex.h>`): only `re_nsub` is read.
	#[cfg(target_vendor = "apple")]
	#[repr(C)]
	#[allow(dead_code, reason = "the C layout; only `re_nsub` is read")]
	struct RegexT {
		magic:   c_int,
		re_nsub: usize,
		re_endp: *const c_char,
		re_g:    *mut c_void,
	}

	/// `regoff_t`.
	#[cfg(target_vendor = "apple")]
	type RegOff = i64;

	/// glibc's `regex_t` (`struct re_pattern_buffer`).
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	#[repr(C)]
	#[allow(dead_code, reason = "the C layout; only `re_nsub` is read")]
	struct RegexT {
		buffer:    *mut c_void,
		allocated: usize,
		used:      usize,
		syntax:    core::ffi::c_ulong,
		fastmap:   *mut c_char,
		translate: *mut c_char,
		re_nsub:   usize,
		bits:      core::ffi::c_uint,
	}

	/// `regoff_t`.
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	type RegOff = c_int;

	/// musl's `regex_t`.
	#[cfg(all(target_os = "linux", target_env = "musl"))]
	#[repr(C)]
	#[allow(dead_code, reason = "the C layout; only `re_nsub` is read")]
	struct RegexT {
		re_nsub:  usize,
		opaque:   *mut c_void,
		padding:  [*mut c_void; 4],
		nsub2:    usize,
		padding2: c_char,
	}

	/// `regoff_t`.
	#[cfg(all(target_os = "linux", target_env = "musl"))]
	type RegOff = core::ffi::c_long;

	/// `regmatch_t`.
	#[repr(C)]
	#[derive(Clone, Copy)]
	struct RegMatch {
		rm_so: RegOff,
		rm_eo: RegOff,
	}

	/// `REG_EXTENDED`, `REG_ICASE`, `REG_NOMATCH`: the same on every target
	/// here.
	const REG_EXTENDED: c_int = 1;
	const REG_ICASE: c_int = 2;
	const REG_NOMATCH: c_int = 1;

	unsafe extern "C" {
		fn regcomp(preg: *mut RegexT, pattern: *const c_char, cflags: c_int) -> c_int;
		fn regexec(
			preg: *const RegexT,
			string: *const c_char,
			nmatch: usize,
			pmatch: *mut RegMatch,
			eflags: c_int,
		) -> c_int;
		fn regerror(
			errcode: c_int,
			preg: *const RegexT,
			errbuf: *mut c_char,
			errbuf_size: usize,
		) -> usize;
		fn regfree(preg: *mut RegexT);
	}

	/// A `locale_t` made once and never freed (shared read-only by every
	/// thread that selects it).
	struct Locale(libc::locale_t);

	// SAFETY: a `locale_t` is immutable once made; any thread may select it
	// with `uselocale`.
	unsafe impl Send for Locale {}
	// SAFETY: as above.
	unsafe impl Sync for Locale {}

	/// The first of `names` the C library knows as an `LC_CTYPE` locale.
	fn make_locale(names: &[&core::ffi::CStr]) -> Option<Locale> {
		names.iter().find_map(|name| {
			// SAFETY: `name` is a NUL-terminated string; a null base asks for
			// a new object.
			let loc =
				unsafe { libc::newlocale(libc::LC_CTYPE_MASK, name.as_ptr(), core::ptr::null_mut()) };
			(!loc.is_null()).then_some(Locale(loc))
		})
	}

	/// The `LC_CTYPE` locale for the shell's character set.
	fn locale(utf8: bool) -> Option<libc::locale_t> {
		static UTF8: LazyLock<Option<Locale>> =
			LazyLock::new(|| make_locale(&[c"C.UTF-8", c"UTF-8", c"en_US.UTF-8"]));
		static C: LazyLock<Option<Locale>> = LazyLock::new(|| make_locale(&[c"C"]));
		let found = if utf8 { &*UTF8 } else { &*C };
		found.as_ref().map(|l| l.0)
	}

	/// Restores the thread's previous locale when dropped.
	struct UseLocale(Option<libc::locale_t>);

	impl Drop for UseLocale {
		fn drop(&mut self) {
			if let Some(prev) = self.0 {
				// SAFETY: `prev` is what `uselocale` returned: a valid
				// locale or `LC_GLOBAL_LOCALE`.
				unsafe {
					libc::uselocale(prev);
				}
			}
		}
	}

	/// A compiled `regex_t`, freed on drop.
	struct Compiled(RegexT);

	impl Drop for Compiled {
		fn drop(&mut self) {
			// SAFETY: `regcomp` succeeded on it.
			unsafe { regfree(&raw mut self.0) };
		}
	}

	/// `regerror(code, re)`.
	fn error_text(code: c_int, re: &RegexT) -> String {
		// SAFETY: a null buffer of size 0 asks for the needed size.
		let size = unsafe { regerror(code, re, core::ptr::null_mut(), 0) };
		let mut buf = vec![0u8; size.max(1)];
		// SAFETY: `buf` holds `buf.len()` writable bytes.
		unsafe { regerror(code, re, buf.as_mut_ptr().cast(), buf.len()) };
		let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
		String::from_utf8_lossy(&buf[..end]).into_owned()
	}

	/// See [`super::ere_match`]; `pattern` and `subject` hold no NUL.
	pub(super) fn ere_match(
		pattern: &[u8],
		subject: &[u8],
		icase: bool,
		utf8: bool,
	) -> Result<Option<Vec<Option<Range<usize>>>>, RegexFail> {
		let (Ok(pat), Ok(text)) = (CString::new(pattern), CString::new(subject)) else {
			return Ok(None);
		};
		let _restore = UseLocale(locale(utf8).map(|loc| {
			// SAFETY: `loc` is a live locale object.
			unsafe { libc::uselocale(loc) }
		}));
		let mut cflags = REG_EXTENDED;
		if icase {
			cflags |= REG_ICASE;
		}
		// SAFETY: `regex_t` is plain data (integers and pointers); all-zero
		// is a valid value for `regcomp` to overwrite.
		let mut re: RegexT = unsafe { core::mem::zeroed() };
		// SAFETY: `re` is writable, `pat` NUL-terminated.
		let r = unsafe { regcomp(&raw mut re, pat.as_ptr(), cflags) };
		if r != 0 {
			return Err(RegexFail::Compile(error_text(r, &re)));
		}
		let re = Compiled(re);
		let n = re.0.re_nsub + 1;
		let mut m = vec![RegMatch { rm_so: -1, rm_eo: -1 }; n];
		// SAFETY: `re` is compiled, `text` NUL-terminated, `m` holds `n`
		// entries.
		let r = unsafe { regexec(&raw const re.0, text.as_ptr(), n, m.as_mut_ptr(), 0) };
		if r == REG_NOMATCH {
			return Ok(None);
		}
		if r != 0 {
			return Err(RegexFail::Exec(error_text(r, &re.0)));
		}
		Ok(Some(
			m.iter()
				.map(|g| {
					let so = usize::try_from(g.rm_so).ok()?;
					let eo = usize::try_from(g.rm_eo).ok()?;
					Some(so..eo)
				})
				.collect(),
		))
	}
}

#[cfg(not(any(
	target_vendor = "apple",
	all(target_os = "linux", any(target_env = "gnu", target_env = "musl"))
)))]
mod native {
	use core::ops::Range;

	use super::RegexFail;
	use crate::bash::pattern::Regex;

	/// See [`super::ere_match`]: the engine's ERE where the C library's
	/// `regex_t` layout is not known here.
	pub(super) fn ere_match(
		pattern: &[u8],
		subject: &[u8],
		icase: bool,
		utf8: bool,
	) -> Result<Option<Vec<Option<Range<usize>>>>, RegexFail> {
		let re =
			Regex::with_utf8(pattern, icase, utf8).map_err(|e| RegexFail::Compile(e.to_string()))?;
		Ok(re.captures(subject))
	}
}
