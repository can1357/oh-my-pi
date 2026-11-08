//! The C library's locale data, as zsh reads it.
//!
//! `nl_langinfo` items (zsh/langinfo's `$langinfo`) and `strftime` conversions
//! (zsh/datetime's `strftime`) in a named locale, each through a `newlocale`
//! object made for the one category asked about (zsh's per-category
//! `setlocale`).

/// A locale category.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Category {
	/// `LC_CTYPE`.
	Ctype,
	/// `LC_TIME`.
	Time,
	/// `LC_NUMERIC`.
	Numeric,
	/// `LC_MESSAGES`.
	Messages,
	/// `LC_MONETARY`.
	Monetary,
}

/// Broken-down time for [`strftime`] (C `struct tm`).
#[derive(Clone, Debug, Default)]
pub struct Tm {
	/// `tm_sec`.
	pub sec:    i32,
	/// `tm_min`.
	pub min:    i32,
	/// `tm_hour`.
	pub hour:   i32,
	/// `tm_mday`.
	pub mday:   i32,
	/// `tm_mon` (0–11).
	pub mon:    i32,
	/// `tm_year` (since 1900).
	pub year:   i32,
	/// `tm_wday` (0 = Sunday).
	pub wday:   i32,
	/// `tm_yday` (0-based).
	pub yday:   i32,
	/// `tm_gmtoff`: seconds east of UTC.
	pub gmtoff: i64,
	/// `tm_zone`.
	pub zone:   Vec<u8>,
}

/// `nl_langinfo(item)` of `locale` for category `cat`.
///
/// `item` by its
/// `<langinfo.h>` name (`CODESET`, `D_T_FMT`, …). A locale the C library
/// does not know (or an empty name) reads as `C`. `None`: an item this
/// target lacks, or a target without the C library's locale functions.
pub fn langinfo(locale: &[u8], cat: Category, item: &str) -> Option<Vec<u8>> {
	native::langinfo(locale, cat, item)
}

/// C `strftime_l(fmt, tm)` in `locale`'s `LC_TIME`; `None` when the
/// target lacks it.
pub fn strftime(locale: &[u8], fmt: &[u8], tm: &Tm) -> Option<Vec<u8>> {
	native::strftime(locale, fmt, tm)
}

/// A locale's `LC_COLLATE` order (C `strcoll`), the order zsh sorts words
/// in (`sort.c` `eltpcmp`).
pub struct Collator(native::Coll);

impl Collator {
	/// The collation of locale `name`; `None` for `C`, `POSIX`, an empty
	/// or unknown name (strings compare as bytes), or a target without the
	/// C library's locale functions.
	pub fn new(name: &[u8]) -> Option<Self> {
		native::Coll::new(name).map(Self)
	}

	/// C `strxfrm_l` of `s` (up to its first NUL): keys compare bytewise as
	/// `strcoll` compares the strings.
	pub fn key(&self, s: &[u8]) -> Vec<u8> {
		self.0.key(s)
	}
}

/// What [`strptime`] made of its input.
pub enum Parse {
	/// The fields and the number of input bytes used.
	Matched(Tm, usize),
	/// The format does not match.
	NoMatch,
}

/// C `strptime(input, fmt, &tm)` in `locale`'s `LC_TIME`.
///
/// `tm` starts zeroed with `tm_mday` 1 and `tm_isdst` -1 (zsh's
/// `reverse_strftime`); `None` when the target lacks it. Input and
/// format end at their first NUL byte, as C sees them.
pub fn strptime(locale: &[u8], fmt: &[u8], input: &[u8]) -> Option<Parse> {
	native::strptime(locale, fmt, input)
}

#[cfg(any(
	target_vendor = "apple",
	all(target_os = "linux", any(target_env = "gnu", target_env = "musl"))
))]
mod native {
	use core::ffi::{CStr, c_char, c_int};
	use std::ffi::CString;

	use super::{Category, Parse, Tm};

	unsafe extern "C" {
		fn nl_langinfo_l(item: libc::nl_item, loc: libc::locale_t) -> *mut c_char;
		#[cfg(target_vendor = "apple")]
		fn strptime_l(
			buf: *const c_char,
			format: *const c_char,
			tm: *mut libc::tm,
			loc: libc::locale_t,
		) -> *mut c_char;
		fn strftime_l(
			s: *mut c_char,
			max: libc::size_t,
			format: *const c_char,
			tm: *const libc::tm,
			loc: libc::locale_t,
		) -> libc::size_t;
		fn strxfrm_l(
			dst: *mut c_char,
			src: *const c_char,
			n: libc::size_t,
			loc: libc::locale_t,
		) -> libc::size_t;
	}

	/// A locale object for `LC_COLLATE`.
	pub struct Coll(Loc);

	impl Coll {
		pub fn new(name: &[u8]) -> Option<Self> {
			if matches!(name, b"" | b"C" | b"POSIX") || name.contains(&0) {
				return None;
			}
			let c = CString::new(name).ok()?;
			// SAFETY: `c` is a valid C string; a null base asks for a new
			// object.
			let loc =
				unsafe { libc::newlocale(libc::LC_COLLATE_MASK, c.as_ptr(), core::ptr::null_mut()) };
			// Never wrap a null pointer: `Loc` frees it on drop.
			if loc.is_null() {
				None
			} else {
				Some(Self(Loc(loc)))
			}
		}

		pub fn key(&self, s: &[u8]) -> Vec<u8> {
			let s = c_prefix(s);
			let Ok(c) = CString::new(s) else {
				return s.to_vec();
			};
			// SAFETY: a null destination of size 0 asks for the length;
			// `c` is a valid C string, the locale object live.
			let n = unsafe { strxfrm_l(core::ptr::null_mut(), c.as_ptr(), 0, (self.0).0) };
			let mut buf = vec![0u8; n + 1];
			// SAFETY: `buf` holds `n + 1` bytes, room for the key and its
			// NUL.
			unsafe { strxfrm_l(buf.as_mut_ptr().cast(), c.as_ptr(), n + 1, (self.0).0) };
			buf.truncate(n);
			buf
		}
	}

	/// A `newlocale` object, freed on drop.
	struct Loc(libc::locale_t);

	impl Loc {
		/// `newlocale(mask, name)`, `C` when the name is empty or unknown.
		fn new(mask: c_int, name: &[u8]) -> Option<Self> {
			let name = if name.is_empty() || name.contains(&0) {
				&b"C"[..]
			} else {
				name
			};
			let c = CString::new(name).ok()?;
			// SAFETY: `c` is a valid C string; a null base asks for a new
			// object.
			let mut loc = unsafe { libc::newlocale(mask, c.as_ptr(), core::ptr::null_mut()) };
			if loc.is_null() {
				// SAFETY: as above, with a literal C string.
				loc = unsafe { libc::newlocale(mask, c"C".as_ptr(), core::ptr::null_mut()) };
			}
			// Never wrap a null pointer: `Loc` frees it on drop.
			if loc.is_null() { None } else { Some(Self(loc)) }
		}
	}

	impl Drop for Loc {
		fn drop(&mut self) {
			// SAFETY: made by `newlocale`, freed once.
			unsafe { libc::freelocale(self.0) };
		}
	}

	const fn mask(cat: Category) -> c_int {
		match cat {
			Category::Ctype => libc::LC_CTYPE_MASK,
			Category::Time => libc::LC_TIME_MASK,
			Category::Numeric => libc::LC_NUMERIC_MASK,
			Category::Messages => libc::LC_MESSAGES_MASK,
			Category::Monetary => libc::LC_MONETARY_MASK,
		}
	}

	fn item(name: &str) -> Option<libc::nl_item> {
		use libc::*;
		Some(match name {
			"CODESET" => CODESET,
			"D_T_FMT" => D_T_FMT,
			"D_FMT" => D_FMT,
			"T_FMT" => T_FMT,
			"RADIXCHAR" => RADIXCHAR,
			"THOUSEP" => THOUSEP,
			"YESEXPR" => YESEXPR,
			"NOEXPR" => NOEXPR,
			"CRNCYSTR" => CRNCYSTR,
			"ABDAY_1" => ABDAY_1,
			"ABDAY_2" => ABDAY_2,
			"ABDAY_3" => ABDAY_3,
			"ABDAY_4" => ABDAY_4,
			"ABDAY_5" => ABDAY_5,
			"ABDAY_6" => ABDAY_6,
			"ABDAY_7" => ABDAY_7,
			"DAY_1" => DAY_1,
			"DAY_2" => DAY_2,
			"DAY_3" => DAY_3,
			"DAY_4" => DAY_4,
			"DAY_5" => DAY_5,
			"DAY_6" => DAY_6,
			"DAY_7" => DAY_7,
			"ABMON_1" => ABMON_1,
			"ABMON_2" => ABMON_2,
			"ABMON_3" => ABMON_3,
			"ABMON_4" => ABMON_4,
			"ABMON_5" => ABMON_5,
			"ABMON_6" => ABMON_6,
			"ABMON_7" => ABMON_7,
			"ABMON_8" => ABMON_8,
			"ABMON_9" => ABMON_9,
			"ABMON_10" => ABMON_10,
			"ABMON_11" => ABMON_11,
			"ABMON_12" => ABMON_12,
			"MON_1" => MON_1,
			"MON_2" => MON_2,
			"MON_3" => MON_3,
			"MON_4" => MON_4,
			"MON_5" => MON_5,
			"MON_6" => MON_6,
			"MON_7" => MON_7,
			"MON_8" => MON_8,
			"MON_9" => MON_9,
			"MON_10" => MON_10,
			"MON_11" => MON_11,
			"MON_12" => MON_12,
			"T_FMT_AMPM" => T_FMT_AMPM,
			"AM_STR" => AM_STR,
			"PM_STR" => PM_STR,
			"ERA" => ERA,
			"ERA_D_FMT" => ERA_D_FMT,
			"ERA_D_T_FMT" => ERA_D_T_FMT,
			"ERA_T_FMT" => ERA_T_FMT,
			"ALT_DIGITS" => ALT_DIGITS,
			_ => return None,
		})
	}

	pub fn langinfo(locale: &[u8], cat: Category, name: &str) -> Option<Vec<u8>> {
		let it = item(name)?;
		let loc = Loc::new(mask(cat), locale)?;
		// SAFETY: `loc` is a live locale object; the result is a C string
		// valid until the locale is freed (copied before that).
		let p = unsafe { nl_langinfo_l(it, loc.0) };
		if p.is_null() {
			return Some(Vec::new());
		}
		// SAFETY: non-null C string from the library.
		Some(unsafe { CStr::from_ptr(p) }.to_bytes().to_vec())
	}

	/// `s` up to its first NUL byte.
	fn c_prefix(s: &[u8]) -> &[u8] {
		s.iter().position(|&c| c == 0).map_or(s, |n| &s[..n])
	}

	pub fn strptime(locale: &[u8], fmt: &[u8], input: &[u8]) -> Option<Parse> {
		let loc = Loc::new(libc::LC_TIME_MASK, locale)?;
		let f = CString::new(c_prefix(fmt)).ok()?;
		let b = CString::new(c_prefix(input)).ok()?;
		// SAFETY: all-zero is a valid `struct tm`.
		let mut t: libc::tm = unsafe { core::mem::zeroed() };
		t.tm_mday = 1;
		t.tm_isdst = -1;
		#[cfg(target_vendor = "apple")]
		// SAFETY: valid C strings, a live `tm` and locale object.
		let end = unsafe { strptime_l(b.as_ptr(), f.as_ptr(), &mut t, loc.0) };
		#[cfg(not(target_vendor = "apple"))]
		// SAFETY: as above; the thread's locale is switched for the call
		// and restored after it.
		let end = unsafe {
			let old = libc::uselocale(loc.0);
			let end = libc::strptime(b.as_ptr(), f.as_ptr(), &mut t);
			libc::uselocale(old);
			end
		};
		if end.is_null() {
			return Some(Parse::NoMatch);
		}
		let used = (end as usize).wrapping_sub(b.as_ptr() as usize);
		let tm = Tm {
			sec:    t.tm_sec,
			min:    t.tm_min,
			hour:   t.tm_hour,
			mday:   t.tm_mday,
			mon:    t.tm_mon,
			year:   t.tm_year,
			wday:   t.tm_wday,
			yday:   t.tm_yday,
			gmtoff: 0,
			zone:   Vec::new(),
		};
		Some(Parse::Matched(tm, used))
	}

	pub fn strftime(locale: &[u8], fmt: &[u8], tm: &Tm) -> Option<Vec<u8>> {
		let loc = Loc::new(libc::LC_TIME_MASK, locale)?;
		let f = CString::new(fmt).ok()?;
		let zone = CString::new(tm.zone.clone()).ok()?;
		// SAFETY: all-zero is a valid `struct tm` (null zone pointer).
		let mut t: libc::tm = unsafe { core::mem::zeroed() };
		t.tm_sec = tm.sec;
		t.tm_min = tm.min;
		t.tm_hour = tm.hour;
		t.tm_mday = tm.mday;
		t.tm_mon = tm.mon;
		t.tm_year = tm.year;
		t.tm_wday = tm.wday;
		t.tm_yday = tm.yday;
		t.tm_isdst = 0;
		t.tm_gmtoff = tm.gmtoff as _;
		t.tm_zone = zone.as_ptr().cast_mut();
		let mut size = 64 + fmt.len() * 8;
		for _ in 0..6 {
			let mut buf = vec![0u8; size];
			// SAFETY: `buf` has `size` bytes; `f`, `t`, `zone` and `loc`
			// outlive the call.
			let n = unsafe { strftime_l(buf.as_mut_ptr().cast(), size, f.as_ptr(), &t, loc.0) };
			if n > 0 || fmt.is_empty() {
				buf.truncate(n);
				return Some(buf);
			}
			size *= 4;
		}
		// Every size came back empty: the conversion's output is empty.
		Some(Vec::new())
	}
}

#[cfg(not(any(
	target_vendor = "apple",
	all(target_os = "linux", any(target_env = "gnu", target_env = "musl"))
)))]
mod native {
	use super::{Category, Tm};

	/// No locale objects here: strings compare as bytes.
	pub struct Coll;

	impl Coll {
		pub const fn new(_name: &[u8]) -> Option<Self> {
			None
		}

		#[expect(clippy::unused_self, reason = "same shape as the locale-backed `Coll::key`")]
		pub fn key(&self, s: &[u8]) -> Vec<u8> {
			s.to_vec()
		}
	}

	#[expect(clippy::missing_const_for_fn, reason = "same shape as the libc-backed `langinfo`")]
	pub fn langinfo(_locale: &[u8], _cat: Category, _item: &str) -> Option<Vec<u8>> {
		None
	}

	#[expect(clippy::missing_const_for_fn, reason = "same shape as the libc-backed `strftime`")]
	pub fn strftime(_locale: &[u8], _fmt: &[u8], _tm: &Tm) -> Option<Vec<u8>> {
		None
	}

	#[expect(clippy::missing_const_for_fn, reason = "same shape as the libc-backed `strptime`")]
	pub fn strptime(_locale: &[u8], _fmt: &[u8], _input: &[u8]) -> Option<super::Parse> {
		None
	}
}
