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

/// Whether the shell's `LC_CTYPE` is a UTF-8 locale the system can load: the
/// multibyte character rules GNU utilities switch on after `setlocale`.
pub(crate) fn ctype_is_utf8(host: &Host) -> bool {
	let Some(name) = shell_locale(host, "LC_CTYPE") else {
		return false;
	};
	#[cfg(unix)]
	if !locale_loadable(name, libc::LC_CTYPE_MASK) {
		return false;
	}
	codeset_is_utf8(name)
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

/// Whether the system can load `locale` for the categories in `mask`, probed
/// with `newlocale` rather than `setlocale`, which would change the C locale
/// of the whole host process.
#[cfg(unix)]
pub(crate) fn locale_loadable(locale: &str, mask: libc::c_int) -> bool {
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

/// Where libc looks for locale data that is not in the system archive:
/// `LOCPATH` on glibc and musl, `PATH_LOCALE` on the BSDs. Both are read from
/// the *process* environment, which the shell's exported variables never
/// reach (see [`Host::var`]), so a locale only the shell can see has to be
/// resolved somewhere that does see them.
#[cfg(unix)]
const LOCALE_PATH_VARS: [&str; 2] = ["LOCPATH", "PATH_LOCALE"];

/// The codeset `nl_langinfo(CODESET)` reports once `locale` is loaded for
/// `LC_CTYPE`, in libc's own spelling: `ISO-8859-1` for an alias like a
/// generated bare `en_US`, whose name carries no codeset at all. `None` when
/// the system cannot load the name, which is what `setlocale` does there —
/// it fails and leaves the C locale in place.
///
/// `env` is the shell's environment and `child` its child-process settings
/// ([`ChildEnv`], which carries the shell's working directory). While the
/// shell's locale search path matches the process's and is absolute, the
/// answer comes from `newlocale` here; otherwise it comes from `locale
/// charmap` run as a child of the shell, because libc takes the search path
/// from the environment only (`newlocale` and `setlocale` both refuse a
/// path-shaped locale name), setting it around the call would be a
/// process-wide write other threads can read, and a relative search path
/// resolves against the working directory, which is the shell's and not this
/// process's.
#[cfg(unix)]
pub(crate) fn loaded_codeset(
	locale: &str,
	env: &dyn Fn(&str) -> Option<String>,
	child: Option<&crate::host::ChildEnv>,
) -> Option<String> {
	let shell_path = LOCALE_PATH_VARS.map(|name| env(name).filter(|value| !value.is_empty()));
	let needs_shell = LOCALE_PATH_VARS.iter().zip(&shell_path).any(|(name, shell)| {
		let relative = shell.as_ref().is_some_and(|value| !value.starts_with('/'));
		relative || *shell != std::env::var(name).ok().filter(|value| !value.is_empty())
	});
	if needs_shell {
		if let Some(codeset) = codeset_from_locale_command(locale, &shell_path, child) {
			return Some(codeset);
		}
	}
	loaded_codeset_here(locale)
}

/// [`loaded_codeset`] through this process's own locale data.
#[cfg(unix)]
fn loaded_codeset_here(locale: &str) -> Option<String> {
	let locale = std::ffi::CString::new(locale).ok()?;
	// SAFETY: `locale` is a valid NUL-terminated string; the locale object is
	// used only for this query and freed before returning, and the codeset
	// string it lends out is copied first.
	unsafe {
		let handle = libc::newlocale(libc::LC_CTYPE_MASK, locale.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			return None;
		}
		let codeset = libc::nl_langinfo_l(libc::CODESET, handle);
		let codeset = (!codeset.is_null())
			.then(|| std::ffi::CStr::from_ptr(codeset).to_string_lossy().into_owned());
		libc::freelocale(handle);
		codeset
	}
}

/// `locale charmap` under the shell's locale environment: the POSIX way to ask
/// libc for the codeset of a locale an environment makes visible. It runs
/// through [`ChildEnv::command`], so it starts in the shell's working
/// directory with the shell's environment, the way the reference binary does;
/// without one it falls back to a bare child carrying only the locale
/// variables. A locale it cannot load leaves the C locale, whose charmap it
/// prints, which is the answer that locale deserves. `None` when no `locale`
/// command answers.
#[cfg(unix)]
fn codeset_from_locale_command(
	locale: &str,
	path: &[Option<String>; 2],
	child: Option<&crate::host::ChildEnv>,
) -> Option<String> {
	let mut command = match child {
		Some(child) => child.command("locale").ok()?,
		None => {
			let mut command = std::process::Command::new("locale");
			command.env_clear();
			for (name, value) in LOCALE_PATH_VARS.iter().zip(path) {
				if let Some(value) = value {
					command.env(name, value);
				}
			}
			command
		},
	};
	command.arg("charmap").env("LC_ALL", locale);
	let output = command.output().ok()?;
	if !output.status.success() {
		return None;
	}
	let codeset = String::from_utf8(output.stdout).ok()?;
	let codeset = codeset.lines().next()?.trim();
	(!codeset.is_empty()).then(|| codeset.to_owned())
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
	if !locale_loadable(name, libc::LC_NUMERIC_MASK) {
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
