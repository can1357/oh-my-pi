//! The shell's locale, as the utility builtins see it.
//!
//! Locale categories are read per invocation from the *shell's* environment
//! (`LC_ALL`, then the category, then `LANG`): uucore's i18n getters read the
//! host process environment once and cache it, which would ignore
//! `LC_ALL=C sort` at the prompt. Nothing here calls `setlocale`, which would
//! change the C locale of the whole host process.
//!
//! Used by `sort` (collation, numerics), `uniq`, `date`, `du`, `df`, `env`, and
//! `fold`.

#![allow(dead_code, reason = "each utility uses a subset")]

use icu_decimal::provider::{Baked, DecimalSymbolsV1};
use icu_locale_core::Locale;
use icu_provider::{DataIdentifierBorrowed, DataLocale, DataProvider, DataRequest};

use crate::host::Host;

/// The shell's value for locale category `category` (`"LC_CTYPE"`, …):
/// `LC_ALL`, then the category, then `LANG`, with empty values treated as
/// unset (POSIX). `None` means the C locale.
pub(crate) fn shell_locale<'h>(host: &'h Host, category: &str) -> Option<&'h str> {
	["LC_ALL", category, "LANG"]
		.into_iter()
		.find_map(|key| host.var(key).filter(|value| !value.is_empty()))
}

/// Whether a `language_TERRITORY[.codeset][@modifier]` name has a UTF-8
/// codeset (`C.UTF-8` included).
pub(crate) fn codeset_is_utf8(name: &str) -> bool {
	name.split(['.', '@']).nth(1).is_some_and(|codeset| {
		codeset.eq_ignore_ascii_case("utf-8") || codeset.eq_ignore_ascii_case("utf8")
	})
}

/// The categories a locale environment names, with the mask `newlocale`
/// knows each by: the six POSIX ones and, on Linux, the six glibc adds. A
/// utility's `setlocale(LC_ALL, "")` has to load every one of them.
#[cfg(unix)]
const LOCALE_CATEGORIES: &[(&str, libc::c_int)] = &[
	("LC_CTYPE", libc::LC_CTYPE_MASK),
	("LC_NUMERIC", libc::LC_NUMERIC_MASK),
	("LC_TIME", libc::LC_TIME_MASK),
	("LC_COLLATE", libc::LC_COLLATE_MASK),
	("LC_MONETARY", libc::LC_MONETARY_MASK),
	("LC_MESSAGES", libc::LC_MESSAGES_MASK),
	#[cfg(target_os = "linux")]
	("LC_PAPER", libc::LC_PAPER_MASK),
	#[cfg(target_os = "linux")]
	("LC_NAME", libc::LC_NAME_MASK),
	#[cfg(target_os = "linux")]
	("LC_ADDRESS", libc::LC_ADDRESS_MASK),
	#[cfg(target_os = "linux")]
	("LC_TELEPHONE", libc::LC_TELEPHONE_MASK),
	#[cfg(target_os = "linux")]
	("LC_MEASUREMENT", libc::LC_MEASUREMENT_MASK),
	#[cfg(target_os = "linux")]
	("LC_IDENTIFICATION", libc::LC_IDENTIFICATION_MASK),
];

/// What a GNU utility's `setlocale(LC_ALL, "")` would make of the shell's
/// locale environment.
#[cfg(unix)]
pub(crate) enum ShellLocale {
	/// Every category the environment names loads, so the utility runs
	/// under those rules.
	Set,
	/// One of them does not, so `setlocale` fails as a whole and the
	/// utility stays in the C locale, whatever the names spell.
	C,
	/// libc could not be asked. Already reported to the caller's standard
	/// error; the caller falls back to reading the names, never to claiming
	/// the C locale.
	Unasked,
}

/// Whether the shell's locale environment would initialise the way GNU
/// coreutils ask it to: `setlocale(LC_ALL, "")`, which fails as a whole
/// when any one category's data is missing.
///
/// This is a different question from rsync's, which loads `LC_CTYPE` alone,
/// and the difference shows: with `LC_ALL` naming a locale that has only
/// `LC_CTYPE`, GNU `fold -w1` puts a newline inside `é` because its
/// `setlocale` failed and left C, while that same name loads perfectly well
/// for `LC_CTYPE` on its own.
#[cfg(unix)]
pub(crate) fn shell_locale_initialises(host: &Host) -> ShellLocale {
	let all = host.var("LC_ALL").filter(|value| !value.is_empty());
	let lang = host.var("LANG").filter(|value| !value.is_empty());
	// Each category takes `LC_ALL`, then its own variable, then `LANG`, then
	// C — which is in the library and always loads.
	let mut named: Vec<(&str, libc::c_int)> = Vec::new();
	for (category, mask) in LOCALE_CATEGORIES {
		let name = all.or_else(|| host.var(category).filter(|value| !value.is_empty())).or(lang);
		let Some(name) = name.filter(|name| *name != "C" && *name != "POSIX") else {
			continue;
		};
		match named.iter_mut().find(|(known, _)| *known == name) {
			Some((_, masks)) => *masks |= mask,
			None => named.push((name, *mask)),
		}
	}
	for (name, masks) in named {
		match locale_loadable_in_shell(host, name, masks) {
			Loadable::Yes => {},
			Loadable::No => return ShellLocale::C,
			Loadable::Unasked(why) => {
				host.warn(format!(
					"warning: cannot read the locale \"{name}\" the way a command started from this shell \
					 would: {why}"
				));
				return ShellLocale::Unasked;
			},
		}
	}
	ShellLocale::Set
}

/// Whether the shell's `LC_CTYPE` is a UTF-8 locale the system can load: the
/// multibyte character rules GNU utilities switch on after `setlocale`.
///
/// The whole environment has to initialise first
/// ([`shell_locale_initialises`]), because that is what those utilities do;
/// then the answer is the codeset of the loaded locale ([`loaded_codeset`]),
/// not the one the name spells. When libc could not be asked, the name is
/// all there is, and reading it beats claiming the C locale: that claim put
/// a newline inside a UTF-8 character under `LC_ALL=C.UTF-8`.
pub(crate) fn ctype_is_utf8(host: &Host) -> bool {
	let Some(name) = shell_locale(host, "LC_CTYPE") else {
		return false;
	};
	#[cfg(unix)]
	{
		match shell_locale_initialises(host) {
			ShellLocale::C => return false,
			ShellLocale::Unasked => return codeset_is_utf8(name),
			ShellLocale::Set => {},
		}
		let env = |key: &str| host.var(key).map(str::to_owned);
		return match loaded_codeset(name, &env) {
			Codeset::Loaded(codeset) => is_utf8_charset(&codeset),
			Codeset::Unloadable => false,
			Codeset::Unasked(why) => {
				host.warn(format!("warning: cannot read the locale \"{name}\": {why}"));
				codeset_is_utf8(name)
			},
		};
	}
	#[cfg(not(unix))]
	codeset_is_utf8(name)
}

/// Whether a codeset libc named is UTF-8, in either of its spellings.
#[cfg(unix)]
fn is_utf8_charset(codeset: &str) -> bool {
	codeset.eq_ignore_ascii_case("utf-8") || codeset.eq_ignore_ascii_case("utf8")
}

/// Parses a locale name the way uucore parses the process one:
/// `language_TERRITORY[.codeset][@modifier]` becomes a BCP 47 locale plus
/// whether the codeset is UTF-8. `None` means the C locale: C/POSIX, or a name
/// ICU cannot read.
pub(crate) fn parse_locale_name(name: &str) -> Option<(Locale, bool)> {
	let language = name
		.split(['.', '@'])
		.next()
		.filter(|language| !matches!(*language, "C" | "POSIX"))?;
	let locale = Locale::try_from_str(&language.replace('_', "-"))
		.ok()
		.filter(|locale| *locale != Locale::UNKNOWN)?;
	Some((locale, codeset_is_utf8(name)))
}

/// Whether the system can load `locale` for the categories in `mask`, in
/// this process's own locale environment. [`locale_loadable_in_shell`] is
/// the same question in the shell's.
///
/// Probed with `newlocale` rather than `setlocale`, which would change the C
/// locale of the whole host process. A name carrying a `;` is not put to
/// `newlocale` at all and is not loadable ([`reads_as_a_composite`]).
#[cfg(unix)]
pub(crate) fn locale_loadable(locale: &str, mask: libc::c_int) -> bool {
	if reads_as_a_composite(locale) {
		return false;
	}
	let Ok(locale) = std::ffi::CString::new(locale) else {
		return false;
	};
	// SAFETY: `locale` is a valid NUL-terminated string; a non-null result is
	// a fresh locale object owned here and freed immediately.
	unsafe {
		let handle = libc::newlocale(mask, locale.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			return false;
		}
		libc::freelocale(handle);
	}
	true
}

/// Whether the system can load a locale, when libc could be asked at all.
#[cfg(unix)]
pub(crate) enum Loadable {
	/// libc loads it.
	Yes,
	/// libc does not.
	No,
	/// libc could not be asked, for the reason given. Not a no: reading it
	/// as one puts the caller in the C locale on no evidence.
	Unasked(String),
}

/// Whether the system can load `locale` for the categories in `mask` as a
/// command the shell starts would.
///
/// libc reads its locale search path from the process environment, never
/// from the shell's exported variables ([`Host::var`]), so this answers
/// through `newlocale` while the shell's search path is this process's own,
/// and is [`Loadable::Unasked`] otherwise ([`shell_search_path_unreadable`]).
#[cfg(unix)]
pub(crate) fn locale_loadable_in_shell(host: &Host, locale: &str, mask: libc::c_int) -> Loadable {
	if let Some(why) = shell_search_path_unreadable(&|key: &str| host.var(key).map(str::to_owned)) {
		return Loadable::Unasked(why);
	}
	match locale_loadable(locale, mask) {
		true => Loadable::Yes,
		false => Loadable::No,
	}
}

/// The variables that decide where libc finds locale data, each with
/// whether it holds a `:`-separated list or one pathname: glibc's `LOCPATH`;
/// the conversion configuration glibc checks a name's codeset against
/// (`GCONV_PATH`, `findlocale.c`'s `__gconv_compare_alias`); the locale
/// archive Nix's glibc reads (`LOCALE_ARCHIVE`); and the BSDs' `PATH_LOCALE`,
/// which no libc on Linux reads.
///
/// musl's `MUSL_LOCPATH` is not one of them. musl gives every `LC_CTYPE`
/// name but C and POSIX its built-in UTF-8 map whether or not a file is
/// found there, and makes a locale for any name it is given
/// (`src/locale/locale_map.c`, `__get_locale`), so that variable changes
/// neither a codeset nor whether a name loads.
#[cfg(unix)]
const LOCALE_SEARCH_VARS: &[(&str, bool)] = &[
	("LOCPATH", true),
	("GCONV_PATH", true),
	("LOCALE_ARCHIVE", false),
	#[cfg(not(target_os = "linux"))]
	("PATH_LOCALE", false),
];

/// What a shell omp starts carries for the variables of
/// [`LOCALE_SEARCH_VARS`]: this process's own values. A test gives a shell
/// these unless it means the shell's search path to differ, because a host
/// that sets one of them (Nix sets `LOCALE_ARCHIVE` for every session)
/// otherwise reads every shell as unreadable.
#[cfg(test)]
pub(crate) fn inherited_search_path() -> Vec<(&'static str, String)> {
	#[cfg(unix)]
	return LOCALE_SEARCH_VARS
		.iter()
		.filter_map(|&(name, _)| Some((name, std::env::var(name).ok()?)))
		.collect();
	#[cfg(not(unix))]
	return Vec::new();
}

/// Why the shell's locale cannot be read in this process, or `None` when it
/// can.
///
/// It cannot when the shell's locale search path is not this process's, or
/// when it names a directory relative to the working directory, which libc
/// would resolve against this process's where a command started from the
/// shell resolves it against the shell's. libc takes a search path from the
/// process environment only, and setting the shell's there would change it
/// for every thread, so such a locale is not looked up: the caller reads the
/// name and reports why, with what the user can do about it.
#[cfg(unix)]
fn shell_search_path_unreadable(env: &dyn Fn(&str) -> Option<String>) -> Option<String> {
	for &(name, list) in LOCALE_SEARCH_VARS {
		let shell = env(name).filter(|value| !value.is_empty());
		let relative = |entry: &str| !entry.is_empty() && !entry.starts_with('/');
		let has_relative = shell.as_deref().is_some_and(|value| match list {
			true => value.split(':').any(relative),
			false => relative(value),
		});
		if has_relative {
			return Some(format!(
				"{name} names a relative directory, which libc would resolve against omp's working directory \
				 rather than the shell's; make it absolute"
			));
		}
		let ours = std::env::var_os(name).filter(|value| !value.is_empty());
		if shell.as_deref().map(std::ffi::OsStr::new) != ours.as_deref() {
			return Some(format!(
				"the shell's {name} is not the one omp was started with, and libc reads only omp's; set it \
				 before starting omp"
			));
		}
	}
	None
}

/// What libc reports for a locale name, and whether libc could be asked at
/// all.
#[cfg(unix)]
#[derive(Debug)]
pub(crate) enum Codeset {
	/// `nl_langinfo(CODESET)` for the loaded locale, in libc's own spelling:
	/// `ISO-8859-1` for an alias like a generated bare `en_US`, whose name
	/// carries no codeset at all.
	Loaded(String),
	/// libc cannot load the name, which is what `setlocale` finds there: it
	/// fails and leaves the C locale in place.
	Unloadable,
	/// The question could not be put to libc in the shell's context, for the
	/// reason given. This is not an answer: reading it as the C locale would
	/// silently escape names the reference prints, so the caller reports it.
	Unasked(String),
}

/// Whether `newlocale` would read `name` as a *composite* — `LC_CTYPE=…;
/// LC_TIME=…`, split per category (`locale/newlocale.c`, on `strchr (locale,
/// ';')`) — where `setlocale(CATEGORY, "")`, what every caller models, takes
/// the whole string as the name of one locale's data.
///
/// Such a name is read as one no data exists for, which is what the
/// reference finds for every name a locale ships under (measured:
/// `LC_ALL=LC_CTYPE=astra;LC_TIME=C` reports `ANSI_X3.4-1968`). Data
/// literally named with a `;` is the one case where that differs: the
/// reference loads it, and `newlocale` cannot be asked about it.
#[cfg(unix)]
fn reads_as_a_composite(name: &str) -> bool {
	name.contains(';')
}

/// The codeset `nl_langinfo(CODESET)` reports once `locale` is loaded for
/// `LC_CTYPE`, as a command the shell starts would see it. `env` is the
/// shell's environment.
///
/// The answer comes from `newlocale` in this process, and is
/// [`Codeset::Unasked`] when the shell's locale search path is not this
/// process's ([`shell_search_path_unreadable`]).
#[cfg(unix)]
pub(crate) fn loaded_codeset(locale: &str, env: &dyn Fn(&str) -> Option<String>) -> Codeset {
	// C and POSIX never reach the search path: glibc answers them from the
	// data in the library itself, before it looks at `LOCPATH`
	// (`findlocale.c`, `_nl_find_locale`).
	if locale != "C"
		&& locale != "POSIX"
		&& let Some(why) = shell_search_path_unreadable(env)
	{
		return Codeset::Unasked(why);
	}
	if reads_as_a_composite(locale) {
		return Codeset::Unloadable;
	}
	let Ok(name) = std::ffi::CString::new(locale) else {
		return Codeset::Unloadable;
	};
	// SAFETY: `name` is a valid NUL-terminated string; the locale object is
	// used only for this query and freed before returning, and the codeset
	// string it lends out is copied first.
	unsafe {
		let handle = libc::newlocale(libc::LC_CTYPE_MASK, name.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			return Codeset::Unloadable;
		}
		let codeset = codeset_of_locale(handle);
		let answer = match codeset.is_null() {
			true => Codeset::Unloadable,
			false => Codeset::Loaded(std::ffi::CStr::from_ptr(codeset).to_string_lossy().into_owned()),
		};
		libc::freelocale(handle);
		answer
	}
}

/// `nl_langinfo_l(CODESET, …)`, which the Rust bindings declare on Linux
/// and not on the BSDs, where the C library has it all the same.
///
/// # Safety
///
/// `handle` is a live locale object, and the string it lends out lives only
/// until that object is freed.
#[cfg(target_os = "linux")]
unsafe fn codeset_of_locale(handle: libc::locale_t) -> *mut libc::c_char {
	// SAFETY: the caller's contract.
	unsafe { libc::nl_langinfo_l(libc::CODESET, handle) }
}

/// `nl_langinfo_l(CODESET, …)`, declared here because the Rust bindings do
/// not declare it for this target.
///
/// # Safety
///
/// As for the Linux one.
#[cfg(all(unix, not(target_os = "linux")))]
unsafe fn codeset_of_locale(handle: libc::locale_t) -> *mut libc::c_char {
	unsafe extern "C" {
		fn nl_langinfo_l(item: libc::nl_item, locale: libc::locale_t) -> *mut libc::c_char;
	}
	// SAFETY: the caller's contract, and `CODESET` is the item this asks for.
	unsafe { nl_langinfo_l(libc::CODESET, handle) }
}

/// Single-byte decimal point and thousands separator of a numeric locale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct NumericSymbols {
	pub decimal_point: u8,
	/// `None` when the locale groups digits with no separator or with a
	/// multibyte one (GNU ignores those too).
	pub thousands_sep: Option<u8>,
}

impl NumericSymbols {
	/// The C locale: `.` and no grouping.
	pub const C: Self = Self { decimal_point: b'.', thousands_sep: None };
}

/// Decimal point and thousands separator for the shell's `LC_NUMERIC`, from
/// ICU's CLDR data for that locale (the data uucore reads for the process
/// locale). C rules apply when it names C, or on Unix a locale the system
/// cannot load (GNU's fallback); Windows has no system locale to probe, so any
/// locale ICU parses uses its CLDR rules.
pub(crate) fn numeric_symbols(host: &Host) -> NumericSymbols {
	let Some(name) = shell_locale(host, "LC_NUMERIC") else {
		return NumericSymbols::C;
	};
	let Some((locale, utf8)) = parse_locale_name(name) else {
		return NumericSymbols::C;
	};
	#[cfg(unix)]
	// GNU utilities take their numerics from `setlocale(LC_ALL, "")`, so a
	// locale environment that does not initialise leaves C's. One libc
	// could not be asked about is reported there and the names stand.
	if matches!(shell_locale_initialises(host), ShellLocale::C) {
		return NumericSymbols::C;
	}
	let data_locale = DataLocale::from(&locale);
	let request = DataRequest {
		id:       DataIdentifierBorrowed::for_locale(&data_locale),
		metadata: Default::default(),
	};
	let Ok(response) = DataProvider::<DecimalSymbolsV1>::load(&Baked, request) else {
		return NumericSymbols::C;
	};
	let symbols = response.payload.get();
	NumericSymbols {
		decimal_point: match symbols.decimal_separator().as_bytes().first() {
			Some(b',') => b',',
			_ => b'.',
		},
		// Upstream GNU coreutils ignore multibyte thousands separators
		// (FIXME in C source). We keep the same single-byte behavior.
		thousands_sep: match symbols.grouping_separator().as_bytes() {
			[b] => Some(*b),
			// ICU returns NBSP as UTF-8 (0xC2 0xA0). In non-UTF8 locales like
			// ISO-8859-1, the input byte is 0xA0, so map it to a single byte.
			[0xc2, 0xa0] if !utf8 => Some(0xa0),
			_ => None,
		},
	}
}
