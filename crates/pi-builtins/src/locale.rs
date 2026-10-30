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
/// shell's locale search path is the one this process carries and no entry of
/// it is relative, the answer comes from `newlocale` here; otherwise it comes
/// from a forked child ([`codeset_in_shell_context`]), because libc takes the
/// search path from the environment only, setting it around the call here
/// would be a process-wide write other threads can read, and a relative entry
/// resolves against the working directory, which is the shell's and not this
/// process's. A path-shaped locale name is no way around either: libc takes
/// one — it refuses only a `.` or `..` component, with `EINVAL` — but still
/// prepends every search-path entry to it, so an absolute name resolves
/// under `LOCPATH=/` and under nothing else (measured on glibc 2.39).
#[cfg(unix)]
pub(crate) fn loaded_codeset(
	locale: &str,
	env: &dyn Fn(&str) -> Option<String>,
	child: Option<&crate::host::ChildEnv>,
) -> Option<String> {
	let shell_path = LOCALE_PATH_VARS.map(|name| env(name).filter(|value| !value.is_empty()));
	// A search path is a colon-separated list, and one relative entry is enough
	// to need the shell's working directory: libc resolves it there. An empty
	// entry is not one of those — glibc builds the list with `argz_create_sep`,
	// which drops a leading or a repeated separator and keeps a trailing one as
	// an empty directory name, so `LOCPATH=/nonexistent:` reads
	// `/<name>/LC_CTYPE` off the root, measured, and never the working
	// directory.
	let relative = shell_path
		.iter()
		.flatten()
		.any(|value| value.split(':').any(|entry| !entry.is_empty() && !entry.starts_with('/')));
	let differs = LOCALE_PATH_VARS
		.iter()
		.zip(&shell_path)
		.any(|(name, shell)| *shell != std::env::var(name).ok().filter(|value| !value.is_empty()));
	if !relative && !differs {
		return loaded_codeset_here(locale);
	}
	// The working directory is part of the answer only for a relative entry.
	// Asking for it otherwise would let a directory no process can enter — one
	// without search permission, or one already removed — decide the locale,
	// which it does not for the reference binary.
	let cwd = match relative {
		true => Some(child?.native_cwd().ok()?),
		false => None,
	};
	codeset_in_shell_context(locale, &shell_path, cwd)
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

/// How long the child of [`codeset_in_shell_context`] may take: a locale load
/// is a handful of file reads, so this bounds only the case where it cannot
/// finish at all.
#[cfg(unix)]
const CODESET_CHILD_SECONDS: std::ffi::c_uint = 5;

/// [`loaded_codeset`] as a process the shell starts would see it: a forked
/// child carrying the shell's locale search path, and its working directory
/// when an entry is relative.
///
/// The child runs no program, so nothing a search path or a directory names
/// can be executed, and the only thing of the shell's that reaches libc is
/// the two search-path variables: it replaces `environ` with a vector built
/// before the fork rather than calling `setenv`, which would be a
/// process-wide write other threads can read. `None` when it reports nothing
/// — a locale libc cannot load, a working directory it cannot enter, or no
/// child at all — which is the C locale and never this process's own answer:
/// the shell's context is the question, and this process's is a different
/// one.
#[cfg(unix)]
fn codeset_in_shell_context(
	locale: &str,
	path: &[Option<String>; 2],
	cwd: Option<&std::path::Path>,
) -> Option<String> {
	use std::io::Read as _;
	use std::os::unix::ffi::OsStrExt as _;

	let locale = std::ffi::CString::new(locale).ok()?;
	let cwd = cwd.map(|cwd| std::ffi::CString::new(cwd.as_os_str().as_bytes())).transpose().ok()?;
	let mut vars = Vec::with_capacity(LOCALE_PATH_VARS.len());
	for (name, value) in LOCALE_PATH_VARS.iter().zip(path) {
		if let Some(value) = value {
			vars.push(std::ffi::CString::new(format!("{name}={value}")).ok()?);
		}
	}
	let mut block: Vec<*mut std::ffi::c_char> = vars
		.iter()
		.map(|var| var.as_ptr().cast_mut())
		.chain(std::iter::once(std::ptr::null_mut()))
		.collect();
	let (mut reader, writer) = std::io::pipe().ok()?;
	// SAFETY: the child half is [`report_codeset`], which writes the codeset
	// and `_exit`s; everything it reads was built above, before the fork.
	match unsafe { nix::unistd::fork() }.ok()? {
		nix::unistd::ForkResult::Child => report_codeset(&locale, cwd.as_deref(), &mut block, writer),
		nix::unistd::ForkResult::Parent { child } => {
			drop(writer);
			let mut codeset = String::new();
			let read = reader.read_to_string(&mut codeset);
			let status = nix::sys::wait::waitpid(child, None);
			if read.is_err() || !matches!(status, Ok(nix::sys::wait::WaitStatus::Exited(_, 0))) {
				return None;
			}
			let codeset = codeset.trim();
			(!codeset.is_empty()).then(|| codeset.to_owned())
		},
	}
}

// libc's own environment pointer. `getenv` reads the array it points at, so
// the forked child gives libc the shell's locale search path by replacing the
// pointer — no `setenv`, which would allocate and lock in a child that has
// neither guarantee.
#[cfg(unix)]
unsafe extern "C" {
	static mut environ: *mut *mut std::ffi::c_char;
}

/// The forked half of [`codeset_in_shell_context`]: reports the codeset of
/// `locale` on `writer`, and never returns.
///
/// A fork leaves the child one thread, so a lock another thread held at that
/// moment is never released here, and `newlocale` takes one. The alarm bounds
/// that to [`CODESET_CHILD_SECONDS`] instead of hanging the utility; the
/// parent sees the signalled status and reads it as no answer.
#[cfg(unix)]
fn report_codeset(
	locale: &std::ffi::CStr,
	cwd: Option<&std::ffi::CStr>,
	vars: &mut [*mut std::ffi::c_char],
	writer: std::io::PipeWriter,
) -> ! {
	// SAFETY: this is the whole child process. It ends in `_exit`, so no
	// destructor and no `atexit` handler inherited from the parent runs, and
	// the strings `vars` points at were built before the fork, which leaves
	// them mapped here.
	unsafe {
		let _ = nix::sys::signal::signal(nix::sys::signal::SIGALRM, nix::sys::signal::SigHandler::SigDfl);
		nix::unistd::alarm::set(CODESET_CHILD_SECONDS);
		if let Some(cwd) = cwd
			&& libc::chdir(cwd.as_ptr()) != 0
		{
			libc::_exit(1);
		}
		environ = vars.as_mut_ptr();
		let handle = libc::newlocale(libc::LC_CTYPE_MASK, locale.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			libc::_exit(1);
		}
		let codeset = libc::nl_langinfo_l(libc::CODESET, handle);
		if codeset.is_null() {
			libc::_exit(1);
		}
		let codeset = std::ffi::CStr::from_ptr(codeset).to_bytes();
		let mut written = 0;
		while written < codeset.len() {
			match nix::unistd::write(&writer, &codeset[written..]) {
				Ok(0) => libc::_exit(1),
				Ok(count) => written += count,
				Err(nix::errno::Errno::EINTR) => {},
				Err(_) => libc::_exit(1),
			}
		}
		libc::_exit(0)
	}
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
