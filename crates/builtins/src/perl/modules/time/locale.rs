//! POSIX locale selection and conversion data. Locale names belong to the
//! interpreter; libc locale objects are used only through explicit `_l` APIs.

use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	modules::constant,
	value::{HKey, HashEntries, PStr, Ref, Sv, Value, new_hv, new_sv},
};

const STATE: &str = "POSIX::_omp_locale";
const ALL: i32 = libc::LC_ALL;
const C: &[u8] = b"C";

struct Category {
	name: &'static str,
	id: i32,
	#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
	mask: i32,
}

macro_rules! category {
	($name:ident, $mask:ident) => {
		Category {
			name: stringify!($name),
			id: libc::$name,
			// Darwin's mask bits are not indexed by category ID.
			#[cfg(target_vendor = "apple")]
			mask: libc::$mask,
			#[cfg(all(target_os = "linux", target_env = "gnu"))]
			mask: 1 << libc::$name,
		}
	};
}


const CATEGORIES: &[Category] = &[
	category!(LC_CTYPE, LC_CTYPE_MASK), category!(LC_NUMERIC, LC_NUMERIC_MASK),
	category!(LC_TIME, LC_TIME_MASK), category!(LC_COLLATE, LC_COLLATE_MASK),
	category!(LC_MONETARY, LC_MONETARY_MASK),
	#[cfg(unix)] category!(LC_MESSAGES, LC_MESSAGES_MASK),
	// glibc's additional locale category IDs and mask bits.
	#[cfg(all(target_os = "linux", target_env = "gnu"))] Category { name: "LC_PAPER", id: 7, mask: 1 << 7 },
	#[cfg(all(target_os = "linux", target_env = "gnu"))] Category { name: "LC_NAME", id: 8, mask: 1 << 8 },
	#[cfg(all(target_os = "linux", target_env = "gnu"))] Category { name: "LC_ADDRESS", id: 9, mask: 1 << 9 },
	#[cfg(all(target_os = "linux", target_env = "gnu"))] Category { name: "LC_TELEPHONE", id: 10, mask: 1 << 10 },
	#[cfg(all(target_os = "linux", target_env = "gnu"))] Category { name: "LC_MEASUREMENT", id: 11, mask: 1 << 11 },
	#[cfg(all(target_os = "linux", target_env = "gnu"))] Category { name: "LC_IDENTIFICATION", id: 12, mask: 1 << 12 },
];

pub(super) fn constants(interp: &mut Interp<'_>) {
	constant(interp, "POSIX::LC_ALL", Value::Int(ALL.into()));
	for cat in CATEGORIES { constant(interp, &format!("POSIX::{}", cat.name), Value::Int(cat.id.into())); }
}

fn usage(interp: &mut Interp<'_>, sig: &str) -> crate::perl::interp::Flow { interp.die_msg(format!("Usage: POSIX::{sig}")) }
fn category_name(slots: &HashEntries, cat: &Category) -> PStr {
	slots.get(&HKey::new(&PStr::from_str(cat.name))).map_or_else(|| PStr::from_bytes(C), |sv| sv.get().to_pstr())
}
fn all_name(slots: &HashEntries) -> PStr {
	let first = category_name(slots, &CATEGORIES[0]);
	if CATEGORIES[1..].iter().all(|cat| category_name(slots, cat) == first) { return first; }
	let mut joined = PStr::default();
	for (i, cat) in CATEGORIES.iter().enumerate() {
		if i != 0 { joined.push_bytes(b";"); }
		joined.push_bytes(cat.name.as_bytes());
		joined.push_bytes(b"=");
		joined.push(&category_name(slots, cat));
	}
	joined
}
fn env_locale(env: &HashEntries, category: &str) -> PStr {
	for name in ["LC_ALL", category, "LANG"] {
		if let Some(sv) = env.get(&HKey::new(&PStr::from_str(name))) {
			let name = sv.get().to_pstr();
			if !name.is_empty() { return name; }
		}
	}
	PStr::from_bytes(C)
}

pub(super) fn setlocale(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !(1..=2).contains(&args.len()) { return Err(usage(interp, "setlocale(category, locale = 0)")); }
	let id = interp.read_sv(&args[0])?.to_i64();
	let cats = if id == i64::from(ALL) { CATEGORIES }
	else if let Some(cat) = CATEGORIES.iter().find(|cat| i64::from(cat.id) == id) { std::slice::from_ref(cat) }
	else { return Ok(Ret::One(Value::Undef)); };
	let locale = interp.hv(STATE);
	let value = if let Some(sv) = args.get(1) { interp.read_sv(sv)? } else { Value::Undef };
	if !value.is_undef() {
		let requested = value.to_pstr();
		let result = if requested.is_empty() {
			let env = interp.hv("main::ENV");
			let env = env.entries();
			cats.iter().map(|cat| platform::name(cat, &env_locale(&env, cat.name))).collect()
		} else if id == i64::from(ALL) && requested.bytes.contains(&b'=') {
			cats.iter().map(|cat| {
				let name = requested.bytes.split(|b| *b == b';').find_map(|entry| {
					entry.strip_prefix(cat.name.as_bytes()).and_then(|entry| entry.strip_prefix(b"="))
				}).ok_or(libc::EINVAL)?;
				platform::name(cat, &PStr::from_bytes(name))
			}).collect()
		} else { platform::names(cats, &requested) };
		let names = match result {
			Ok(names) => names,
			Err(code) => { interp.set_errno_code(code); return Ok(Ret::One(Value::Undef)); }
		};
		let mut slots = locale.entries_mut();
		for (cat, name) in cats.iter().zip(names) {
			slots.insert(HKey::new(&PStr::from_str(cat.name)), new_sv(Value::Str(name)));
		}
	}
	let slots = locale.entries();
	Ok(Ret::One(Value::Str(if id == i64::from(ALL) { all_name(&slots) } else { category_name(&slots, &cats[0]) })))
}

pub(super) fn localeconv(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !args.is_empty() { return Err(usage(interp, "localeconv()")); }
	let out = new_hv();
	{
		let mut fields = out.entries_mut();
		put_bytes(&mut fields, "decimal_point", b".");
		#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
		{
			let locale = interp.hv(STATE);
			let slots = locale.entries();
			for id in [libc::LC_NUMERIC, libc::LC_MONETARY] {
				let cat = CATEGORIES.iter().find(|cat| cat.id == id).unwrap();
				let name = category_name(&slots, cat);
				if !is_c(&name) && let Err(code) = platform::conventions(&mut fields, cat, &name) {
					interp.set_errno_code(code);
					return Ok(Ret::One(Value::Undef));
				}
			}
		}
	}
	Ok(Ret::One(Value::Ref(Ref::Hash(out))))
}

fn is_c(name: &PStr) -> bool { matches!(name.bytes.as_slice(), b"C" | b"POSIX") }

#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
fn collation(interp: &mut Interp<'_>) -> (&'static Category, PStr) {
	let cat = CATEGORIES.iter().find(|cat| cat.id == libc::LC_COLLATE).unwrap();
	let name = category_name(&interp.hv(STATE).entries(), cat);
	(cat, name)
}
fn c_bytes(mut s: PStr) -> Vec<u8> {
	if let Some(i) = s.bytes.iter().position(|&b| b == 0) { s.bytes.truncate(i); }
	s.bytes
}
pub(super) fn strcoll(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if args.len() != 2 { return Err(usage(interp, "strcoll(s1, s2)")); }
	let l = c_bytes(interp.read_sv(&args[0])?.to_pstr());
	let r = c_bytes(interp.read_sv(&args[1])?.to_pstr());
	#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
	{
		let (cat, locale) = collation(interp);
		if !is_c(&locale) { return collation_result(interp, platform::compare(cat, &locale, l, r).map(|n| Value::Int(n.into()))); }
	}
	let n = l.iter().copied().chain([0]).zip(r.iter().copied().chain([0]))
		.find_map(|(a, b)| (a != b).then_some(i64::from(a) - i64::from(b))).unwrap_or(0);
	Ok(Ret::One(Value::Int(n)))
}
pub(super) fn strxfrm(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if args.len() != 1 { return Err(usage(interp, "strxfrm(src)")); }
	let bytes = c_bytes(interp.read_sv(&args[0])?.to_pstr());
	#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
	{
		let (cat, locale) = collation(interp);
		if !is_c(&locale) { return collation_result(interp, platform::transform(cat, &locale, bytes).map(|b| Value::Str(PStr::new(b, false)))); }
	}
	Ok(Ret::One(Value::Str(PStr::new(bytes, false))))
}
#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
fn collation_result(interp: &mut Interp<'_>, result: Result<Value, i32>) -> PResult<Ret> {
	Ok(Ret::One(match result {
		Ok(value) => value,
		Err(code) => { interp.set_errno_code(code); Value::Undef }
	}))
}

fn put_bytes(fields: &mut HashEntries, key: &str, bytes: &[u8]) {
	if !bytes.is_empty() { fields.insert(HKey::new(&PStr::from_str(key)), new_sv(Value::Str(PStr::from_bytes(bytes)))); }
}

#[cfg(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu")))]
mod platform {
	use std::{ffi::{CStr, CString, c_char}, io, ptr};

	use super::*;

	unsafe extern "C" {
		#[cfg(target_vendor = "apple")]
		fn querylocale(mask: i32, locale: libc::locale_t) -> *const c_char;
		#[cfg(target_vendor = "apple")]
		fn localeconv_l(locale: libc::locale_t) -> *const libc::lconv;
		#[cfg(all(target_os = "linux", target_env = "gnu"))]
		fn nl_langinfo_l(item: i32, locale: libc::locale_t) -> *const c_char;
		fn strcoll_l(a: *const c_char, b: *const c_char, locale: libc::locale_t) -> i32;
		fn strxfrm_l(out: *mut c_char, src: *const c_char, len: usize, locale: libc::locale_t) -> usize;
	}

	struct Locale(libc::locale_t);
	impl Locale {
		fn new(mask: i32, name: &PStr) -> Result<Self, i32> {
			let name = CString::new(name.bytes.as_slice()).map_err(|_| libc::EINVAL)?;
			// SAFETY: a valid C string and a null base create an independent locale.
			let raw = unsafe { libc::newlocale(mask, name.as_ptr(), ptr::null_mut()) };
			if raw.is_null() { Err(io::Error::last_os_error().raw_os_error().unwrap_or(libc::ENOENT)) }
			else { Ok(Self(raw)) }
		}
	}
	impl Drop for Locale {
		fn drop(&mut self) {
			// SAFETY: self uniquely owns a live newlocale handle.
			unsafe { libc::freelocale(self.0); }
		}
	}

	#[cfg(target_vendor = "apple")]
	fn name_ptr(locale: &Locale, cat: &Category) -> *const c_char {
		// SAFETY: locale is live and cat.mask contains exactly one category.
		unsafe { querylocale(cat.mask, locale.0) }
	}
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	fn name_ptr(locale: &Locale, cat: &Category) -> *const c_char { item_ptr(locale, cat.id, 0xffff) }

	pub(super) fn names(cats: &[Category], name: &PStr) -> Result<Vec<PStr>, i32> {
		if name.bytes.as_slice() == C { return Ok(vec![PStr::from_bytes(C); cats.len()]); }
		let locale = Locale::new(cats.iter().fold(0, |mask, cat| mask | cat.mask), name)?;
		Ok(cats.iter().map(|cat| canonical_name(&locale, cat, name)).collect())
	}

	pub(super) fn name(cat: &Category, name: &PStr) -> Result<PStr, i32> {
		if name.bytes.as_slice() == C { return Ok(PStr::from_bytes(C)); }
		let locale = Locale::new(cat.mask, name)?;
		Ok(canonical_name(&locale, cat, name))
	}
	fn canonical_name(locale: &Locale, cat: &Category, requested: &PStr) -> PStr {
		let ptr = name_ptr(locale, cat);
		if ptr.is_null() { return requested.clone(); }
		// SAFETY: the returned NUL-terminated string is borrowed from the live locale.
		PStr::from_bytes(unsafe { CStr::from_ptr(ptr) }.to_bytes())
	}

	pub(super) fn compare(cat: &Category, locale: &PStr, a: Vec<u8>, b: Vec<u8>) -> Result<i32, i32> {
		let locale = Locale::new(cat.mask, locale)?;
		let a = CString::new(a).map_err(|_| libc::EINVAL)?;
		let b = CString::new(b).map_err(|_| libc::EINVAL)?;
		// SAFETY: valid strings and an explicit live collation locale.
		Ok(unsafe { strcoll_l(a.as_ptr(), b.as_ptr(), locale.0) })
	}
	pub(super) fn transform(cat: &Category, locale: &PStr, src: Vec<u8>) -> Result<Vec<u8>, i32> {
		let locale = Locale::new(cat.mask, locale)?;
		let src = CString::new(src).map_err(|_| libc::EINVAL)?;
		// SAFETY: C permits null destination when size is zero.
		let n = unsafe { strxfrm_l(ptr::null_mut(), src.as_ptr(), 0, locale.0) };
		let size = n.checked_add(1).ok_or(libc::ENOMEM)?;
		let mut transformed: Vec<u8> = Vec::new();
		transformed.try_reserve_exact(size).map_err(|_| libc::ENOMEM)?;
		// SAFETY: capacity covers n bytes and the trailing NUL. The locale and
		// source are unchanged since the sizing call.
		let actual = unsafe { strxfrm_l(transformed.as_mut_ptr().cast(), src.as_ptr(), size, locale.0) };
		if actual > n { return Err(libc::EINVAL); }
		// SAFETY: the second call initialized actual bytes before the NUL.
		unsafe { transformed.set_len(actual); }
		Ok(transformed)
	}

	fn put_int(fields: &mut HashEntries, key: &str, value: c_char) {
		if value != c_char::MAX { fields.insert(HKey::new(&PStr::from_str(key)), new_sv(Value::Int(value.into()))); }
	}

	#[cfg(target_vendor = "apple")]
	pub(super) fn conventions(fields: &mut HashEntries, cat: &Category, name: &PStr) -> Result<(), i32> {
		let locale = Locale::new(cat.mask, name)?;
		// SAFETY: localeconv_l borrows locale, whose lifetime covers all field accesses.
		let values = unsafe { localeconv_l(locale.0).as_ref() }.ok_or(libc::EINVAL)?;
		macro_rules! strings {
			($($field:ident),*) => {$(
				// SAFETY: lconv's string fields are NUL-terminated strings owned by locale.
				put_bytes(fields, stringify!($field), unsafe { CStr::from_ptr(values.$field) }.to_bytes());
			)*};
		}
		if cat.id == libc::LC_NUMERIC { strings!(decimal_point, thousands_sep, grouping); }
		else {
			strings!(int_curr_symbol, currency_symbol, mon_decimal_point, mon_thousands_sep, mon_grouping, positive_sign, negative_sign);
			macro_rules! numbers { ($($field:ident),*) => {$(put_int(fields, stringify!($field), values.$field);)*}; }
			numbers!(int_frac_digits, frac_digits, p_cs_precedes, p_sep_by_space, n_cs_precedes, n_sep_by_space, p_sign_posn, n_sign_posn,
				int_p_cs_precedes, int_p_sep_by_space, int_n_cs_precedes, int_n_sep_by_space, int_p_sign_posn, int_n_sign_posn);
		}
		Ok(())
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	fn item_ptr(locale: &Locale, id: i32, item: i32) -> *const c_char {
		// SAFETY: the item is a glibc langinfo field and locale is a live handle.
		unsafe { nl_langinfo_l((id << 16) | item, locale.0) }
	}

	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	pub(super) fn conventions(fields: &mut HashEntries, cat: &Category, name: &PStr) -> Result<(), i32> {
		let locale = Locale::new(cat.mask, name)?;
		// These are the lconv-equivalent items in glibc's <langinfo.h>. Unlike
		// localeconv(), nl_langinfo_l does not write a process-wide static lconv.
		let keys: &[&str] = if cat.id == libc::LC_NUMERIC { &["decimal_point", "thousands_sep", "grouping"] }
		else { &["int_curr_symbol", "currency_symbol", "mon_decimal_point", "mon_thousands_sep", "mon_grouping", "positive_sign", "negative_sign"] };
		for (index, key) in keys.iter().enumerate() {
			// SAFETY: these items are NUL-terminated strings owned by locale.
			let value = unsafe { CStr::from_ptr(item_ptr(&locale, cat.id, index as i32)) };
			put_bytes(fields, key, value.to_bytes());
		}
		if cat.id == libc::LC_MONETARY {
			for (index, key) in [(7, "int_frac_digits"), (8, "frac_digits"), (9, "p_cs_precedes"), (10, "p_sep_by_space"),
				(11, "n_cs_precedes"), (12, "n_sep_by_space"), (13, "p_sign_posn"), (14, "n_sign_posn"),
				(16, "int_p_cs_precedes"), (17, "int_p_sep_by_space"), (18, "int_n_cs_precedes"), (19, "int_n_sep_by_space"),
				(20, "int_p_sign_posn"), (21, "int_n_sign_posn")] {
				// SAFETY: these items are single bytes owned by locale.
				put_int(fields, key, unsafe { *item_ptr(&locale, cat.id, index) });
			}
		}
		Ok(())
	}
}

#[cfg(not(any(target_vendor = "apple", all(target_os = "linux", target_env = "gnu"))))]
mod platform {
	use super::*;

	pub(super) fn names(cats: &[Category], name: &PStr) -> Result<Vec<PStr>, i32> {
		if matches!(name.bytes.as_slice(), b"C" | b"POSIX") { Ok(vec![PStr::from_bytes(C); cats.len()]) }
		else { Err(libc::ENOENT) }
	}
	pub(super) fn name(_: &Category, name: &PStr) -> Result<PStr, i32> {
		if is_c(name) { Ok(PStr::from_bytes(C)) } else { Err(libc::ENOENT) }
	}
}
