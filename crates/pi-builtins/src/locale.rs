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
/// then the answer is the codeset of the loaded locale read in the shell's
/// own context ([`loaded_codeset`]), not the one the name spells and not the
/// one this process's environment would find. When libc could not be asked,
/// the name is all there is, and reading it beats claiming the C locale:
/// that claim put a newline inside a UTF-8 character under `LC_ALL=C.UTF-8`.
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
		let child = host.child_env();
		let env = |key: &str| host.var(key).map(str::to_owned);
		return match loaded_codeset(name, &env, Some(&child)) {
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
/// locale of the whole host process — except for a name carrying a `;`,
/// which `newlocale` splits per category where `setlocale`, what every
/// caller models, takes it whole ([`reads_as_a_composite`]). Such a name
/// goes to the utility, and to the only answer libc gives to "would
/// `setlocale` take this": whether it complained. `charmap` cannot stand in
/// for that, because a locale whose charset is the C one and a name that
/// loaded nothing both print `ANSI_X3.4-1968` — a cleanly generated German
/// locale named `de_DE@ascii;valid` loads with the C charset and a decimal
/// comma, and reading its charset called both its ctype and its numerics
/// absent. The category `mask` names is the one set in the child, so the
/// answer is about that category and not about `LC_CTYPE` standing in for
/// it.
#[cfg(unix)]
pub(crate) fn locale_loadable(locale: &str, mask: libc::c_int) -> bool {
	if reads_as_a_composite(locale) {
		let ours: LocaleEnv = LOCALE_ENV_VARS.map(|name| std::env::var_os(name).filter(|v| !v.is_empty()));
		// This entry point answers about this process's own environment, so
		// a query it cannot put to libc is not a yes.
		return matches!(locale_utility_accepts(&category_variables(mask), locale, &ours, None), Loadable::Yes);
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
/// command the shell starts would: with the shell's locale search path and
/// working directory, not this process's.
///
/// The question the callers ask is about the shell's locale, so the context
/// has to be the shell's too — a locale only its `LOCPATH` can reach is
/// loadable for the reference and was not for this. When the shell's locale
/// environment is the one this process already carries and the name is an
/// ordinary one, the answer still comes from `newlocale` here and no
/// process is started.
#[cfg(unix)]
pub(crate) fn locale_loadable_in_shell(host: &Host, locale: &str, mask: libc::c_int) -> Loadable {
	let shell: LocaleEnv =
		LOCALE_ENV_VARS.map(|name| host.var(name).filter(|value| !value.is_empty()).map(std::ffi::OsString::from));
	let ours: LocaleEnv = LOCALE_ENV_VARS.map(|name| std::env::var_os(name).filter(|value| !value.is_empty()));
	let child = host.child_env();
	let shell_cwd = child.native_cwd().ok();
	let ours_cwd = std::env::current_dir().ok();
	let relative = needs_working_directory(&shell) || needs_working_directory(&ours);
	let same_cwd = !relative || (shell_cwd.is_some() && shell_cwd == ours_cwd.as_deref());
	if shell == ours && same_cwd && !reads_as_a_composite(locale) {
		return match locale_loadable(locale, mask) {
			true => Loadable::Yes,
			false => Loadable::No,
		};
	}
	let cwd = match needs_working_directory(&shell) {
		false => None,
		true => match shell_cwd {
			Some(cwd) => Some(cwd),
			None => {
				return Loadable::Unasked(
					"the shell's locale environment is relative to a working directory no process can name"
						.to_owned(),
				);
			},
		},
	};
	locale_utility_accepts(&category_variables(mask), locale, &shell, cwd)
}

/// Where libc looks for locale data, and for the charset aliases it checks
/// that data against: `LOCPATH` on glibc (musl reads `MUSL_LOCPATH`),
/// `PATH_LOCALE` on the
/// BSDs, `LOCALE_ARCHIVE` for glibc's archive, and `GCONV_PATH` for the
/// conversion configuration that `findlocale.c` compares a name's codeset
/// through (`__gconv_compare_alias`; measured: an alias-only `GCONV_PATH`
/// decides whether `astra.ASTRA_CUSTOM` loads at all). All are read from the
/// *process* environment, which the shell's exported variables never reach
/// (see [`Host::var`]), so a locale only the shell can see has to be
/// resolved somewhere that does see them.
///
/// `LD_*` is deliberately not one of them. These four choose the data libc
/// reads once a program is running, which is the question; `LD_*` chooses
/// the code the program runs, and which program answers is this code's
/// choice, never the caller's.
#[cfg(unix)]
const LOCALE_ENV_VARS: [&str; 4] = ["LOCPATH", "PATH_LOCALE", "LOCALE_ARCHIVE", "GCONV_PATH"];

/// The values of [`LOCALE_ENV_VARS`] in one environment, empty read as unset.
#[cfg(unix)]
type LocaleEnv = [Option<std::ffi::OsString>; 4];

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
/// ';')`) — where `setlocale(CATEGORY, …)` takes the whole string as the
/// name of one locale's data.
///
/// The reference does the latter, so a name with a `;` in it is never
/// answered from `newlocale` here: with no data of that name the reference
/// gets the C locale (measured: `LC_ALL=LC_CTYPE=astra;LC_TIME=C` reports
/// `ANSI_X3.4-1968`), and with data literally so named it loads it
/// (measured: `ISO-8859-1`, and rsync 3.5.1 prints `ünï.txt`). `=` on its
/// own is not part of this: `newlocale` reads it literally too.
#[cfg(unix)]
fn reads_as_a_composite(name: &str) -> bool {
	name.contains(';')
}

/// The codeset `nl_langinfo(CODESET)` reports once `locale` is loaded for
/// `LC_CTYPE`, as a command the shell starts would see it.
///
/// `env` is the shell's environment and `child` its child-process settings
/// ([`ChildEnv`], which carries the shell's working directory).
///
/// **Why this is not a call in this process.** libc reads the locale search
/// path from the process environment and from nowhere else: `newlocale`
/// calls `getenv ("LOCPATH")` itself (glibc 2.39 `locale/newlocale.c`), and
/// no entry point takes a search path as an argument. Applying the shell's
/// through the host's own libc would mean `setenv`, a process-wide write
/// every other thread's `getenv` can read. Handing libc an absolute locale
/// *name* is no way around that either: `_nl_make_l10nflist` still prefixes
/// every search-path entry to the name, so an absolute name resolves only
/// through an entry that puts nothing before its leading `/` — the entry `/`
/// itself, or an empty entry, which is joined as `"" + "/" + name`.
/// `LOCPATH=/`, `LOCPATH=:` and `LOCPATH=/not-real:` all load one;
/// `LOCPATH=/not-real`, `LOCPATH=:/not-real` (argz drops the leading
/// separator) and an unset `LOCPATH` do not (measured on glibc 2.39). Nor
/// does libc "refuse only a `.` or a `..` component": `valid_locale_name`
/// (`locale/findlocale.c`) rejects a name longer than 255 bytes, a `..`
/// component, and any name that contains a `/` without starting with one; a
/// single-dot component passes that check and then finds nothing, with
/// `errno` untouched rather than set to `EINVAL` (measured).
///
/// None of that makes an in-process answer *impossible*: a second libc in
/// its own `dlmopen(LM_ID_NEWLM, …)` namespace, with an environment vector
/// that namespace owns, answers while the host libc's locale lock is held,
/// and a review measured it doing so. It is glibc-specific and it doubles
/// the libc in the address space, so this takes the plain route instead — a
/// process whose environment this code builds: the system's `locale` utility
/// ([`codeset_from_locale_utility`]). While the shell's locale environment
/// and working directory are the ones this process already has, no process
/// is started at all and the answer comes from `newlocale` here.
#[cfg(unix)]
pub(crate) fn loaded_codeset(
	locale: &str,
	env: &dyn Fn(&str) -> Option<String>,
	child: Option<&crate::host::ChildEnv>,
) -> Codeset {
	// C and POSIX never reach the search path: glibc answers them from the
	// data in the library itself, before it looks at `LOCPATH`
	// (`findlocale.c`, `_nl_find_locale`).
	if locale == "C" || locale == "POSIX" {
		return loaded_codeset_here(locale);
	}
	let shell: LocaleEnv =
		LOCALE_ENV_VARS.map(|name| env(name).filter(|value| !value.is_empty()).map(std::ffi::OsString::from));
	let ours: LocaleEnv = LOCALE_ENV_VARS.map(|name| std::env::var_os(name).filter(|value| !value.is_empty()));
	// The working directory is part of the question only while something is
	// relative to it. Asking for it otherwise would let a directory no
	// process can enter decide the locale, which it does not for the
	// reference binary.
	let shell_cwd = child.and_then(|child| child.native_cwd().ok());
	let ours_cwd = std::env::current_dir().ok();
	let relative = needs_working_directory(&shell) || needs_working_directory(&ours);
	let same_cwd = !relative || (shell_cwd.is_some() && shell_cwd == ours_cwd.as_deref());
	// A name `newlocale` would split per category has to go to the utility
	// even when nothing else would send it there, because only `setlocale`
	// reads it the way the reference does.
	if shell == ours && same_cwd && !reads_as_a_composite(locale) {
		return loaded_codeset_here(locale);
	}
	let cwd = match needs_working_directory(&shell) {
		false => None,
		true => match shell_cwd {
			Some(cwd) => Some(cwd),
			None => {
				return Codeset::Unasked(
					"the shell's locale environment is relative to a working directory no process can name"
						.to_owned(),
				);
			},
		},
	};
	codeset_from_locale_utility(locale, &shell, cwd)
}

/// What `nl_langinfo(CODESET)` reports for the C locale, in libc's spellings.
#[cfg(unix)]
fn is_c_charset(codeset: &str) -> bool {
	["ANSI_X3.4-1968", "US-ASCII", "ASCII"].iter().any(|name| codeset.eq_ignore_ascii_case(name))
}

/// [`loaded_codeset`] through this process's own locale data.
#[cfg(unix)]
fn loaded_codeset_here(locale: &str) -> Codeset {
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

/// Whether an entry of `value` makes `name` resolve against the working
/// directory of whichever process libc runs in.
///
/// An empty entry is not one of those: glibc builds a search path with
/// `argz_create_sep`, which drops a leading or repeated separator and keeps a
/// trailing one as an empty directory name, and an empty name prefixes the
/// locale with `/` — the root, not the working directory (measured:
/// `LOCPATH=/nonexistent:` reads `/<name>/LC_CTYPE`). A value that is one
/// file name rather than a list, such as `LOCALE_ARCHIVE`, is split here
/// too: no value is ever rewritten, so the only cost of reading a colon in
/// one as a separator is asking for a working directory that is then the
/// right one anyway.
///
/// `PATH_LOCALE` is the BSDs' variable and no libc that runs on Linux reads
/// it, so a relative value in it cannot send a lookup there to the working
/// directory. It is still passed to the child; it just does not decide
/// whether the child needs a directory to be put in.
#[cfg(unix)]
fn entry_resolves_against_cwd(name: &str, value: &std::ffi::OsStr) -> bool {
	use std::os::unix::ffi::OsStrExt as _;

	if cfg!(target_os = "linux") && name == "PATH_LOCALE" {
		return false;
	}
	value.as_bytes().split(|&byte| byte == b':').any(|entry| !entry.is_empty() && entry[0] != b'/')
}

/// Whether a locale environment needs the working directory of the process
/// libc runs in ([`entry_resolves_against_cwd`]).
#[cfg(unix)]
fn needs_working_directory(env: &LocaleEnv) -> bool {
	LOCALE_ENV_VARS
		.iter()
		.zip(env)
		.any(|(name, value)| value.as_ref().is_some_and(|value| entry_resolves_against_cwd(name, value)))
}

/// Where the system's `locale` utility lives. Absolute and fixed: neither the
/// caller's `PATH` nor the shell's working directory — which a relative entry
/// of any `PATH` names for a child started there — may choose the program
/// that answers.
#[cfg(unix)]
const LOCALE_UTILITIES: [&str; 2] = ["/usr/bin/locale", "/bin/locale"];

/// How long that utility may take, counted from just before the spawn. A
/// locale load is a handful of file reads, so this bounds only the case where
/// it cannot finish at all — a search-path entry whose `LC_CTYPE` is a FIFO
/// nobody writes to, say, which blocks the reference binary for ever as well.
#[cfg(unix)]
const LOCALE_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// The most the utility may write before its output stops being one codeset.
#[cfg(unix)]
const LOCALE_ANSWER_LIMIT: usize = 1024;

/// Why a query produced no answer: the words the caller reports.
#[cfg(unix)]
struct Unanswered(String);

/// [`loaded_codeset`] as a process the shell starts would see it: the
/// system's `locale` utility, which reports `nl_langinfo(CODESET)` after
/// `setlocale(LC_CTYPE, "")` — the two calls rsync itself makes for this.
///
/// The utility is started with `posix_spawn`, so it runs in a fresh address
/// space: no lock copied out of a thread that held it, and no restriction to
/// async-signal-safe calls. It inherits this thread's signal mask, as any
/// exec'd program does; that cannot strand the query, because the deadline is
/// the parent's and the child has no part in enforcing it. It is named by an
/// absolute path, put in its own process group so that neither it nor a
/// descendant it leaves *in that group* outlives the query — one that calls
/// `setsid` leaves the group and is beyond this, as process-group semantics
/// imply — and handed an environment built here —
/// [`LOCALE_ENV_VARS`] as the shell set them, and `LC_CTYPE` — so no `PATH`
/// or `LD_*` of anyone else's reaches it.
///
/// Its working directory is the shell's whenever a value is relative to one,
/// set by the spawn's `chdir` file action rather than by rewriting the
/// value: a directory name is not a list element, and one containing `:` has
/// no spelling inside `LOCPATH` at all.
///
/// **A `chdir` that fails ends the query.** It is tempting to drop the
/// relative entries and ask again, and it is wrong: the error says nothing
/// about what the reference resolves from a directory it is already inside.
/// `EACCES` can come from an ancestor the reference never traverses;
/// `ENOENT` and `ENOTDIR` can mean the directory was renamed rather than
/// removed; and a removed directory's parent is reached by `./../` as well
/// as by `../`. Dropping entries also moves where the answer comes from: an
/// emptied `LOCPATH` turns glibc's locale archive back on (`findlocale.c`
/// consults it only when `locale_path == NULL`), which read `LOCPATH=missing`
/// from an unenterable working directory as the archive's `UTF-8` where the
/// reference reports `ANSI_X3.4-1968`. All of those are reported instead.
///
/// That is a deliberate reversal, not an oversight: an earlier revision
/// answered `ISO-8859-1` for `LOCPATH=missing:/…/latin` from a working
/// directory with mode 0600, which is what the reference answers there. No
/// process can enter that directory — the reference is in it, it did not
/// enter it — so the agreement was luck rather than derivation, and the same
/// reasoning gave wrong answers everywhere else it was tried. One matching
/// row is not worth six unsound ones.
///
/// A narrower version of that fallback was tried and withdrawn too — its
/// withdrawal changed 47 recorded answers, ten prefix cases replayed in
/// each of three directory conditions plus 15 delta and 2 strict
/// spellings. It cut the search path at its first relative entry and asked
/// the prefix, on the reasoning that libc takes the first directory whose
/// data loads. It
/// does not — `intl/l10nflist.c` tries each *name* candidate across every
/// directory before moving to the next candidate, so for `astra@special` a
/// prefix holding fallback data named `astra` answered `ISO-8859-1` where
/// the reference, inside the directory, found exact-name data further
/// along and answered `UTF-8`. Cutting can also invent a source:
/// `/nonexistent::missing` cut to `/nonexistent:` ends in an empty entry,
/// which is the root, and that loaded an absolute name the whole list never
/// would have. Two wrong affirmative answers are worse than the report they
/// replaced.
///
/// The working directory reaches the child as a pathname, so a directory
/// replaced between this call and the child's `chdir` is entered in place of
/// the one the shell sits in. [`crate::host::ChildEnv`] holds a pathname and
/// starts every other command of the shell's the same way; closing that
/// would take a different representation of the shell's working directory.
#[cfg(unix)]
fn codeset_from_locale_utility(locale: &str, env: &LocaleEnv, cwd: Option<&std::path::Path>) -> Codeset {
	match locale_utility_charmap(locale, env, cwd) {
		Ok(codeset) => Codeset::Loaded(codeset),
		Err(Unanswered(why)) => Codeset::Unasked(why),
	}
}

/// Which of the utility's streams the answer pipe carries. Only one is
/// taken, because taking both would cost a second pipe and the lookup's
/// whole margin under a tight descriptor limit is two descriptors.
#[cfg(unix)]
#[derive(Clone, Copy, PartialEq, Eq)]
enum Ask {
	/// The codeset on standard output, diagnostics discarded.
	Codeset,
	/// The diagnostics on standard error, output discarded: glibc's `locale`
	/// writes there, and nowhere else, when a category of the environment
	/// could not be set, and writes nothing at all when every one of them
	/// was (measured on glibc 2.39, including a search path naming
	/// directories that do not exist). That is the only answer libc gives to
	/// "would `setlocale` take this name", and `charmap` cannot stand in for
	/// it: a locale whose charset is the C one and a name that loaded
	/// nothing both print `ANSI_X3.4-1968`.
	Diagnostics,
}

/// Whether the utility could set `category` to `locale` — that is, whether
/// `setlocale(category, "")` would take that name — in the environment
/// given.
///
/// Two things have to hold, and the second is not implied by the first: the
/// utility said nothing on its standard error, *and* it gave a whole,
/// well-formed reply. Silence on its own is not an answer — a utility that
/// exits 0 writing nothing, and one that floods its standard output with
/// 200,000 bytes and no diagnostic, both pass the quiet test and have
/// reported nothing. That costs a second query, which is why the codeset
/// one is only asked once the quiet one has passed.
#[cfg(unix)]
fn locale_utility_accepts(
	categories: &[&str],
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
) -> Loadable {
	let program = LOCALE_UTILITIES.iter().copied().find(|at| std::fs::metadata(at).is_ok_and(|m| m.is_file()));
	let Some(program) = program else {
		return Loadable::Unasked(format!(
			"there is no locale utility at {} or {}",
			LOCALE_UTILITIES[0], LOCALE_UTILITIES[1]
		));
	};
	locale_utility_accepts_at(std::path::Path::new(program), categories, locale, env, cwd)
}

/// [`locale_utility_accepts`] against one named program.
#[cfg(unix)]
fn locale_utility_accepts_at(
	program: &std::path::Path,
	categories: &[&str],
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
) -> Loadable {
	let said = match locale_utility_output_at(program, categories, locale, env, cwd, Ask::Diagnostics) {
		Ok(said) => said,
		Err(Unanswered(why)) => return Loadable::Unasked(why),
	};
	if !said.is_empty() {
		return Loadable::No;
	}
	let printed = match locale_utility_output_at(program, categories, locale, env, cwd, Ask::Codeset) {
		Ok(printed) => printed,
		Err(Unanswered(why)) => return Loadable::Unasked(why),
	};
	match validated_codeset(&printed) {
		Some(_) => Loadable::Yes,
		None => {
			let shown = String::from_utf8_lossy(&printed[..printed.len().min(40)]).into_owned();
			Loadable::Unasked(format!("the locale utility reported {shown:?} where one codeset was due"))
		},
	}
}

/// [`locale_utility_accepts_at`] against a utility a test puts in place of
/// the system's.
#[cfg(all(unix, test))]
pub(crate) fn utility_accepts_for_test(program: &std::path::Path, locale: &str) -> Loadable {
	locale_utility_accepts_at(program, &["LC_CTYPE"], locale, &LOCALE_ENV_VARS.map(|_| None), None)
}

/// Every category `mask` names, as the environment variables the utility
/// reads them from.
///
/// Not `LC_ALL`: naming that would make the child require *every* category
/// to load, which is a stricter question than the mask asked. A shell that
/// names German data for `LC_CTYPE` and `LC_NUMERIC` and nothing else
/// initialises — `setlocale(LC_ALL, "")` succeeds there because every
/// other category selects C — and translating the pair to `LC_ALL` said it
/// did not, which put a newline inside `é` and C ordering into `sort -sn`.
#[cfg(unix)]
fn category_variables(mask: libc::c_int) -> Vec<&'static str> {
	LOCALE_CATEGORIES.iter().filter(|(_, bit)| mask & bit != 0).map(|(name, _)| *name).collect()
}

/// The body of [`codeset_from_locale_utility`]: one whole, validated
/// codeset, or why there is none.
#[cfg(unix)]
fn locale_utility_charmap(
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
) -> Result<String, Unanswered> {
	locale_utility_charmap_with(&["LC_CTYPE"], locale, env, cwd)
}

/// [`locale_utility_charmap`] with `locale` named for some other category,
/// which is how a loadability query checks that the utility replied at all.
#[cfg(unix)]
fn locale_utility_charmap_with(
	categories: &[&str],
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
) -> Result<String, Unanswered> {
	let printed = locale_utility_output(categories, locale, env, cwd, Ask::Codeset)?;
	validated_codeset(&printed).ok_or_else(|| {
		let shown = String::from_utf8_lossy(&printed[..printed.len().min(40)]).into_owned();
		Unanswered(format!("the locale utility reported {shown:?} where one codeset was due"))
	})
}

/// What the first locale utility that is there writes on the stream `ask`
/// names, with `category` set to `locale`.
#[cfg(unix)]
fn locale_utility_output(
	categories: &[&str],
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
	ask: Ask,
) -> Result<Vec<u8>, Unanswered> {
	let Some(program) =
		LOCALE_UTILITIES.iter().copied().find(|at| std::fs::metadata(at).is_ok_and(|meta| meta.is_file()))
	else {
		return Err(Unanswered(format!(
			"there is no locale utility at {} or {}",
			LOCALE_UTILITIES[0], LOCALE_UTILITIES[1]
		)));
	};
	locale_utility_output_at(std::path::Path::new(program), categories, locale, env, cwd, ask)
}

/// [`locale_utility_output`] against one named program: what the chosen
/// stream held when the child ended — which is not everything the child
/// wrote, see [`memory_file`] — or why there is none.
#[cfg(target_os = "linux")]
fn locale_utility_output_at(
	program: &std::path::Path,
	categories: &[&str],
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
	ask: Ask,
) -> Result<Vec<u8>, Unanswered> {
	use std::os::fd::AsRawFd as _;
	use std::os::unix::ffi::OsStrExt as _;

	let report = Unanswered;
	if children_are_reaped_for_us() {
		return Err(report(
			"this process has the kernel reap its children, so the locale utility's end cannot be observed \
			 and its process group cannot be ended without risking another"
				.to_owned(),
		));
	}
	let named = program.display();
	let text = |bytes: &[u8]| {
		std::ffi::CString::new(bytes)
			.map_err(|_| report("the locale name or search path contains a NUL byte".to_owned()))
	};
	let program_c = text(program.as_os_str().as_bytes())?;
	let argv0 = text(b"locale")?;
	let argv1 = text(b"charmap")?;
	let cwd_c = cwd.map(|cwd| text(cwd.as_os_str().as_bytes())).transpose()?;
	// `locale` sets each category it was given from the environment and
	// reports on its standard error every one it could not
	// (`locale/programs/locale.c`), so naming the categories directly is the
	// `setlocale(CATEGORY, "")` the callers model. Every category *not*
	// named is left to default to C, which is what makes this the question
	// asked rather than `LC_ALL`: a locale that holds only `LC_CTYPE` and
	// `LC_NUMERIC` initialises for a shell that names only those two, and
	// `setlocale(LC_ALL, "")` succeeds there because every other category
	// selects C.
	let mut vars = Vec::with_capacity(categories.len() + LOCALE_ENV_VARS.len());
	for category in categories {
		vars.push(text(format!("{category}={locale}").as_bytes())?);
	}
	for (name, value) in LOCALE_ENV_VARS.iter().zip(env) {
		if let Some(value) = value {
			let mut var = format!("{name}=").into_bytes();
			var.extend_from_slice(value.as_bytes());
			vars.push(text(&var)?);
		}
	}
	let argv: [*mut std::ffi::c_char; 3] =
		[argv0.as_ptr().cast_mut(), argv1.as_ptr().cast_mut(), std::ptr::null_mut()];
	let mut envp: Vec<*mut std::ffi::c_char> = vars.iter().map(|var| var.as_ptr().cast_mut()).collect();
	envp.push(std::ptr::null_mut());
	// The answer goes to a memory file rather than a pipe, and the whole
	// query costs two descriptors: this one and the handle the child is
	// made with. A pipe costs two on its own, which with the handle would
	// be three, and a lookup has to answer where two are free. What a pipe
	// gave and this does not is backpressure, so the child caps its own
	// output with `RLIMIT_FSIZE` instead.
	let answer = memory_file().map_err(|err| report(format!("no file for the answer: {err}")))?;
	// It has to sit above the standard descriptors, or the child's
	// `/dev/null` would land on the very descriptor the answer is written
	// to (reproduced with this process's own 1 and 2 closed).
	let answer = above_standard(answer).map_err(|err| report(format!("no file for the answer: {err}")))?;

	let deadline = std::time::Instant::now() + LOCALE_QUERY_TIMEOUT;
	// The child and the handle on it are made by the same call: a number a
	// spawn hands back is already recyclable, and opening a handle from it
	// afterwards can open whatever took it.
	// The deadline is this query's, and the only one: a wait inside the
	// spawn that started its own used the whole of it over again.
	let child =
		start_locale_utility(&program_c, &argv, &envp, answer.as_raw_fd(), cwd_c.as_deref(), ask, deadline)
			.map_err(|err| report(format!("{named} could not be started: {err}")))?;
	let completion = reap_locale_utility(&child, deadline, false);
	let printed = read_from_start(&answer, LOCALE_ANSWER_LIMIT + 1)
		.map_err(|err| report(format!("{named} could not be read: {err}")))?;
	if printed.len() > LOCALE_ANSWER_LIMIT {
		return Err(report(format!("{named} wrote more than {LOCALE_ANSWER_LIMIT} bytes")));
	}
	let answer = printed;
	match completion {
		// glibc's `locale` reports a locale it could not set on its standard
		// error and still exits 0 (measured on glibc 2.39), so any other
		// status is a utility this code does not know rather than a failed
		// load, and its output is not an answer.
		Completion::Exited(0) => {},
		// The three statuses below are the ones the child uses for its own
		// failures, and a utility is free to exit with any of them, so each
		// message says which reading it is.
		Completion::Exited(CHILD_NO_DIRECTORY) => {
			return Err(report(format!(
				"{named} exited with status {CHILD_NO_DIRECTORY}, which here means it could not enter the \
				 shell's working directory, unless the utility uses that status itself"
			)));
		},
		Completion::Exited(CHILD_NO_PROGRAM) => {
			return Err(report(format!(
				"{named} exited with status {CHILD_NO_PROGRAM}, which here means it would not run, unless \
				 the utility uses that status itself"
			)));
		},
		Completion::Exited(CHILD_NO_SETUP) => {
			return Err(report(format!(
				"{named} exited with status {CHILD_NO_SETUP}, which here means it could not be set up to \
				 answer, unless the utility uses that status itself"
			)));
		},
		Completion::Exited(status) => return Err(report(format!("{named} exited with status {status}"))),
		Completion::Ended(how) => return Err(report(format!("{named} {how}"))),
	}
	Ok(answer)
}

/// [`locale_utility_output_at`] where a child cannot be held by anything
/// but its number.
///
/// Nothing is started: the whole of the query's process lifetime — making
/// the child and the handle together, watching it, ending its group and
/// reaping it — is Linux's `clone3` and `pidfd`, and a child that could
/// only be reached by a recyclable number is one this code will not make.
#[cfg(all(unix, not(target_os = "linux")))]
fn locale_utility_output_at(
	_program: &std::path::Path,
	_categories: &[&str],
	_locale: &str,
	_env: &LocaleEnv,
	_cwd: Option<&std::path::Path>,
	_ask: Ask,
) -> Result<Vec<u8>, Unanswered> {
	Err(Unanswered(
		"a child cannot be held by anything but its number here, so the locale utility is not started".to_owned(),
	))
}

/// A file with no name and no directory, for the utility's answer.
///
/// Unlike the pipe it replaced, this is a channel the writer can go back
/// over: a utility that writes a diagnostic and then truncates it leaves
/// nothing behind, and the query accepts what remains, where the pipe would
/// have carried the diagnostic and refused. What is read is the state of
/// the file when the child ended, not everything the child wrote. That is a
/// weaker contract with a broken helper and not a boundary against a lying
/// one — a utility free to invent a codeset never needed to hide anything —
/// and it is the price of the one descriptor that lets the handle and the
/// answer both fit where two are free.
#[cfg(target_os = "linux")]
fn memory_file() -> std::io::Result<std::os::fd::OwnedFd> {
	use std::os::fd::FromRawFd as _;

	// SAFETY: a static name and the close-on-exec flag; the call either
	// returns a fresh descriptor or an error.
	let made = unsafe { libc::memfd_create(c"omp-locale".as_ptr(), libc::MFD_CLOEXEC) };
	if made < 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: a fresh descriptor nothing else owns.
	Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(made) })
}

/// At most `limit` bytes of `file`, read from its start without moving the
/// offset the child left behind.
#[cfg(target_os = "linux")]
fn read_from_start(file: &std::os::fd::OwnedFd, limit: usize) -> std::io::Result<Vec<u8>> {
	use std::os::fd::AsRawFd as _;

	let mut read = Vec::new();
	let mut buffer = vec![0u8; limit];
	loop {
		let taken = i64::try_from(read.len()).unwrap_or(i64::MAX);
		// SAFETY: the descriptor is the caller's and the buffer is this
		// scope's, with the length the call is given.
		let got = unsafe {
			libc::pread(file.as_raw_fd(), buffer.as_mut_ptr().cast(), limit - read.len(), taken)
		};
		if got < 0 {
			let err = std::io::Error::last_os_error();
			if err.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			return Err(err);
		}
		let got = usize::try_from(got).unwrap_or_default();
		if got == 0 {
			return Ok(read);
		}
		read.extend_from_slice(&buffer[..got]);
		if read.len() >= limit {
			return Ok(read);
		}
	}
}

/// [`codeset_from_locale_utility`] against a utility a test puts in place of
/// the system's, which is the only way to stand a hostile or broken one up
/// without replacing `/usr/bin/locale` for the whole machine.
#[cfg(all(unix, test))]
pub(crate) fn codeset_from_utility_for_test(
	program: &std::path::Path,
	locale: &str,
	env: &dyn Fn(&str) -> Option<String>,
) -> Codeset {
	let values: LocaleEnv =
		LOCALE_ENV_VARS.map(|name| env(name).filter(|value| !value.is_empty()).map(std::ffi::OsString::from));
	let printed = match locale_utility_output_at(program, &["LC_CTYPE"], locale, &values, None, Ask::Codeset) {
		Ok(printed) => printed,
		Err(Unanswered(why)) => return Codeset::Unasked(why),
	};
	match validated_codeset(&printed) {
		Some(codeset) => Codeset::Loaded(codeset),
		None => {
			let shown = String::from_utf8_lossy(&printed[..printed.len().min(40)]).into_owned();
			Codeset::Unasked(format!("the locale utility reported {shown:?} where one codeset was due"))
		},
	}
}

/// The whole of `answer` as one codeset, or `None` when it is anything else.
///
/// A prefix of a longer reply is not an answer and neither is a diagnostic
/// that happens to come first, so this takes the output entire: one line,
/// optionally ended by a newline, of the characters a codeset name is made
/// of. Measured against this: a utility whose output was `warning: alien
/// implementation\nUTF-8\n` otherwise read as the charset `warning: alien
/// implementation`, and a locale whose codeset field had been edited to
/// `UTF-8\nX` — which `nl_langinfo_l` returns whole — otherwise read as
/// `UTF-8`.
#[cfg(unix)]
fn validated_codeset(answer: &[u8]) -> Option<String> {
	let line = answer.strip_suffix(b"\n").unwrap_or(answer);
	let named = |byte: &u8| byte.is_ascii_alphanumeric() || b"-_.:+".contains(byte);
	if line.is_empty() || line.len() > 64 || !line.iter().all(named) {
		return None;
	}
	String::from_utf8(line.to_vec()).ok()
}

/// `fd`, moved clear of the standard descriptors if it landed on one.
#[cfg(unix)]
fn above_standard(fd: std::os::fd::OwnedFd) -> std::io::Result<std::os::fd::OwnedFd> {
	use std::os::fd::{AsRawFd as _, FromRawFd as _};

	if fd.as_raw_fd() >= 3 {
		return Ok(fd);
	}
	// SAFETY: duplicating a descriptor this scope owns; the original is closed
	// with `fd` at the end of the call.
	let moved = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
	if moved < 0 {
		return Err(std::io::Error::last_os_error());
	}
	// SAFETY: `moved` is a fresh descriptor nothing else owns.
	Ok(unsafe { std::os::fd::OwnedFd::from_raw_fd(moved) })
}

/// How the locale utility stopped.
#[cfg(target_os = "linux")]
enum Completion {
	/// It ended of its own accord, with this status.
	Exited(libc::c_int),
	/// It did not, in the words the caller reports.
	Ended(String),
}

/// A handle on the locale utility that names that one process whatever
/// happens to its number, made by the same call that makes the child.
///
/// A process number is not an identity, and it is recyclable from the
/// moment the child exists. A pidfd opened from a number the kernel handed
/// back is already too late: a review paused a query between the child's
/// creation and that open, let another thread's `waitpid(-1)` consume the
/// child, and watched the reused number be opened, signalled and reaped —
/// three times out of three, against a process with nothing to do with this
/// query. No ordering of a separate acquisition closes that, so there is no
/// separate acquisition: `clone3(CLONE_PIDFD)` returns the handle and the
/// child together, and watching, ending the group and reaping all go
/// through the handle, where a signal fails with `ESRCH` once that process
/// is gone rather than reaching whoever took its number.
///
/// Where this does not exist — a kernel without `clone3`, or any Unix that
/// is not Linux — no query is started, because its child could not be
/// ended safely afterwards.
#[cfg(target_os = "linux")]
struct ChildHandle(std::os::fd::OwnedFd);

/// `CLONE_PIDFD`: hand back a handle on the new child.
#[cfg(target_os = "linux")]
const CLONE_PIDFD: u64 = 0x0000_1000;

/// `PIDFD_SIGNAL_PROCESS_GROUP`: send to the process group the handle's
/// process leads. Linux 6.9 and later.
#[cfg(target_os = "linux")]
const PIDFD_SIGNAL_PROCESS_GROUP: libc::c_uint = 4;

/// The status the child exits with when it could not enter the shell's
/// working directory, and the one it uses when the program would not run.
/// A utility could exit with either of its own accord; both are refused
/// either way, and only the wording depends on telling them apart.
#[cfg(target_os = "linux")]
const CHILD_NO_DIRECTORY: libc::c_int = 125;
#[cfg(target_os = "linux")]
const CHILD_NO_PROGRAM: libc::c_int = 126;

/// The status the child uses when a step of its own setup failed.
#[cfg(target_os = "linux")]
const CHILD_NO_SETUP: libc::c_int = 124;

/// How much of a signal set the kernel takes: 64 signals in eight bytes,
/// whatever size the library's own `sigset_t` is.
#[cfg(target_os = "linux")]
const KERNEL_SIGSET_BYTES: usize = 8;

/// `clone3`'s argument block, as much of it as this uses.
#[cfg(target_os = "linux")]
#[repr(C)]
#[derive(Default)]
struct CloneArgs {
	flags: u64,
	pidfd: u64,
	child_tid: u64,
	parent_tid: u64,
	exit_signal: u64,
	stack: u64,
	stack_size: u64,
	tls: u64,
}

/// Whether this kernel has `clone3`, asked once with arguments it must
/// refuse: a kernel that knows the call answers `EINVAL`, one that does not
/// answers `ENOSYS`, and neither makes a process.
///
/// Asked *before* anything is started. A capability discovered afterwards
/// leaves a child that nothing here can end — five refusals used to leave
/// five of them.
#[cfg(target_os = "linux")]
static CAN_HOLD_A_CHILD: std::sync::LazyLock<bool> = std::sync::LazyLock::new(|| {
	// Each probe has to answer with the error that only a kernel knowing
	// the call can give. "Anything but `ENOSYS`" and "anything but
	// `EINVAL`" are not that: a `clone3` or a `waitid` denied by a seccomp
	// filter answers `EPERM`, `EACCES` or `ENOSYS`, and reading those as
	// capability left five real children and five zombies behind.
	//
	// SAFETY: a null argument block with a zero size is refused before the
	// kernel reads anything, so this makes no process either way.
	let cloned = unsafe { libc::syscall(libc::SYS_clone3, std::ptr::null::<CloneArgs>(), 0usize) };
	let clone3 = cloned < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL);
	// SAFETY: a descriptor number no process can have open answers `EBADF`
	// where the kernel knows `P_PIDFD`, and `EINVAL` where it does not;
	// neither waits for anything. A negative number is refused as an
	// identifier before the kernel looks at the kind at all, so it has to be
	// a large positive one. `P_PIDFD` is 3.
	let mut ended: libc::siginfo_t = unsafe { std::mem::zeroed() };
	let watched = unsafe {
		libc::syscall(
			libc::SYS_waitid,
			3,
			libc::c_int::MAX,
			&raw mut ended,
			libc::WEXITED | libc::WNOHANG,
			std::ptr::null_mut::<libc::c_void>(),
		)
	};
	let by_handle = watched < 0 && std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF);
	// Both, and asked together: `clone3` arrived in Linux 5.3 and waiting
	// by handle in 5.4, so a kernel between them would make a child this
	// code could then neither watch nor reap.
	clone3 && by_handle
});

/// Starts the locale utility, in its own process group, with `answer` as
/// the stream `ask` names, its own `/dev/null` for the other two, and `cwd`
/// as its working directory when one is given.
///
/// The two `/dev/null`s are opened by the child, not here, which keeps this
/// process's cost at the one answer file — the whole margin the lookup has
/// under a descriptor limit that leaves two free. `clone3` without
/// `CLONE_VM` leaves the child a copy of this process, as `fork` does, so
/// everything it does before `execve` is async-signal-safe and reads only
/// values built before the call.
///
/// Every step of that setup is required, and a child that cannot take one
/// of them ends instead of carrying on: a `/dev/null` that would not open
/// used to leave the utility writing its answer onto the caller's own
/// standard output, a `setpgid` that failed left a descendant nothing
/// would end, and a `setrlimit` that failed left the answer unbounded.
///
/// Signals are blocked across the clone, and every disposition this
/// process *caught* is put back to default in the child — an ignored one
/// is left as it is, which is the pre-exec contract `posix_spawn` was
/// keeping here: a handler of this process's that ran between the clone
/// and the `execve` wrote into the answer and turned a loadable locale
/// into a refusal. A disposition the child can neither read nor set is
/// left blocked instead, which closes the same window without having to
/// know what was there.
#[cfg(target_os = "linux")]
fn start_locale_utility(
	program: &std::ffi::CStr,
	argv: &[*mut std::ffi::c_char; 3],
	envp: &[*mut std::ffi::c_char],
	answer: std::os::fd::RawFd,
	cwd: Option<&std::ffi::CStr>,
	ask: Ask,
	deadline: std::time::Instant,
) -> Result<ChildHandle, std::io::Error> {
	use std::os::fd::FromRawFd as _;

	if !*CAN_HOLD_A_CHILD {
		return Err(std::io::Error::from(std::io::ErrorKind::Unsupported));
	}
	let (taken, discarded) = match ask {
		Ask::Codeset => (1, 2),
		Ask::Diagnostics => (2, 1),
	};
	let mut handle: libc::c_int = -1;
	let args = CloneArgs {
		flags: CLONE_PIDFD,
		pidfd: (&raw mut handle) as u64,
		exit_signal: u64::try_from(libc::SIGCHLD).unwrap_or_default(),
		..CloneArgs::default()
	};
	// SAFETY: both sets are filled in by the calls that take them. A block
	// that did not happen must not be "restored": `held` would be the empty
	// set, and putting that on would unblock everything the caller had
	// blocked and deliver whatever was pending.
	let held = unsafe {
		let mut every = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
		let mut held = std::mem::MaybeUninit::<libc::sigset_t>::uninit();
		if libc::sigfillset(every.as_mut_ptr()) != 0 {
			return Err(std::io::Error::last_os_error());
		}
		// `pthread_sigmask` *returns* its error number and does not set
		// `errno`, so reading `errno` here reported whatever the capability
		// probe had left behind.
		let blocked = libc::pthread_sigmask(libc::SIG_SETMASK, every.as_ptr(), held.as_mut_ptr());
		if blocked != 0 {
			return Err(std::io::Error::from_raw_os_error(blocked));
		}
		held.assume_init()
	};
	// SAFETY: the argument block is initialised and outlives the call; the
	// kernel writes `handle` in this process. The child branch below ends in
	// `execve` or `_exit`, so no destructor and no `atexit` handler of this
	// process's runs there.
	let child = unsafe { libc::syscall(libc::SYS_clone3, &raw const args, size_of::<CloneArgs>()) };
	if child == 0 {
		// SAFETY: this is the whole of the child, and every call here is
		// async-signal-safe.
		unsafe {
			// No handler this process installed may run here. An *ignored*
			// disposition is left alone, which is `posix_spawn`'s contract
			// and not a window of any kind: with `SIGPIPE` ignored in the
			// caller, a utility that raises it and then answers succeeds
			// under `posix_spawn` and died on signal 13 when this reset it.
			//
			// A disposition that cannot be read is the awkward case, and
			// three readings of it were wrong before this one. Skipping
			// every failed read let a handler live where a filter denied
			// one application signal. Skipping the numbers below the
			// library's own minimum took that minimum for the end of the
			// unreadable ones, and it is not: a library that allocates
			// realtime signals moves the minimum up (34 to 54 over twenty
			// allocations on glibc 2.39) while only the fixed numbers it
			// keeps are refused, so 34 to 53 took handlers and an
			// inherited one on 34 ran before the `execve`. Taking a
			// refused `sigaddset` for "the library keeps this" was the
			// third: a `sigaddset` made to fail for `SIGUSR1` let that
			// handler run in 77 children, because a call that fails says
			// only that it failed.
			//
			// So nothing here is a classification. Each step is tried and
			// its result is checked, and the next is only reached because
			// the one before it was refused:
			//
			// * the disposition is read, and a *caught* one is put back
			//   to default — an ignored one is left alone;
			// * where the read is refused, the *set* is asked for the old
			//   disposition in the same call, which is what the read was
			//   going to say: a handler it has just replaced stays
			//   replaced, and an ignored disposition is put straight
			//   back, because that one is the caller's own instruction
			//   and `execve` carries it through. Setting default blind
			//   instead gains nothing — `execve` resets a caught
			//   disposition by itself — and cost a utility its ignored
			//   `SIGPIPE`: with the read of 13 denied, it raised the
			//   signal and died on it where it used to answer;
			// * a signal whose handler cannot be replaced, whichever way
			//   round the refusal came, is kept *blocked* in the mask the
			//   utility starts with, because a blocked signal cannot be
			//   delivered before the `execve`, and the `execve` drops the
			//   handler. A read that worked and a set that did not used
			//   to end the child outright, which made the easier failure
			//   the one this handled worse: a filter denying only the
			//   write gave status 124 where denying the read *as well*
			//   answered;
			// * and a signal that cannot be blocked either ends the
			//   child, because nothing is left to make it safe.
			//
			// The numbers the library keeps for itself — 32 and 33 on
			// glibc 2.39, 32 to 34 on musl — reach the blocking step:
			// they can be neither read nor set, and `sigaddset` will not
			// name them, so the bit goes in directly and the mask is
			// restored through the kernel's own call, which does not take
			// them back out as `pthread_sigmask` does. They are then
			// blocked in the utility, where the library never delivered
			// them to an application anyway.
			//
			// The cost of that last rung, stated rather than engineered
			// around: a signal that reaches it is blocked in the utility,
			// with whatever that implies for the utility's own timers,
			// children and termination. Measured, with reading and
			// setting 10 both refused: a stand-in that raises `SIGUSR1`
			// to itself exits 78; and with other numbers blocked the same
			// way, a one-second `SIGALRM` wake-up became a five-second
			// query timeout, a blocked `SIGCHLD` kept a handler from
			// running, and a blocked `SIGTERM` left a utility running
			// where it would have ended. There is no fourth thing to do
			// with a handler that cannot be replaced: the signal is
			// blocked, or the handler is left alive to run before the
			// `execve`, or the query answers nothing at all.
			let mut starts_with = held;
			for signal in 1..=libc::SIGRTMAX() {
				if signal == libc::SIGKILL || signal == libc::SIGSTOP {
					continue;
				}
				let mut default = std::mem::MaybeUninit::<libc::sigaction>::zeroed().assume_init();
				default.sa_sigaction = libc::SIG_DFL;
				if libc::sigemptyset(&raw mut default.sa_mask) != 0 {
					libc::_exit(CHILD_NO_SETUP);
				}
				let mut current = std::mem::MaybeUninit::<libc::sigaction>::zeroed();
				if libc::sigaction(signal, std::ptr::null(), current.as_mut_ptr()) == 0 {
					let current = current.assume_init();
					if current.sa_sigaction == libc::SIG_IGN
						|| current.sa_sigaction == libc::SIG_DFL
						|| libc::sigaction(signal, &raw const default, std::ptr::null_mut()) == 0
					{
						continue;
					}
				} else {
					// The read was refused, so the set is asked what was
					// there. It answers atomically: nothing of this
					// process's runs in between.
					let mut was = std::mem::MaybeUninit::<libc::sigaction>::zeroed();
					if libc::sigaction(signal, &raw const default, was.as_mut_ptr()) == 0 {
						let was = was.assume_init();
						if was.sa_sigaction != libc::SIG_IGN
							|| libc::sigaction(signal, &raw const was, std::ptr::null_mut()) == 0
						{
							continue;
						}
					}
				}
				// `sigaddset` first, and the bit itself where the library
				// refuses the number. A signal set is the kernel's own
				// array of words, signal `n` in bit `n - 1` of it.
				if libc::sigaddset(&raw mut starts_with, signal) != 0 {
					let place = usize::try_from(signal - 1).unwrap_or_default();
					let wide = 8 * size_of::<libc::c_ulong>();
					let one: libc::c_ulong = 1;
					let word = (&raw mut starts_with).cast::<libc::c_ulong>().add(place / wide);
					word.write_unaligned(word.read_unaligned() | one << (place % wide));
				}
			}
			// The mask this thread had, plus whatever could be neither
			// read nor set, put on through the kernel rather than through
			// `pthread_sigmask`, which removes the library's own numbers
			// from a set before passing it on. Nothing can carry the
			// number a call returns out of a child, so the setup status is
			// all the caller is told — which is why "the return value is
			// reported on every failure" is not something this code
			// claims.
			let mut on: libc::sigset_t = std::mem::zeroed();
			if libc::syscall(
				libc::SYS_rt_sigprocmask,
				libc::SIG_SETMASK,
				&raw const starts_with,
				std::ptr::null_mut::<libc::sigset_t>(),
				KERNEL_SIGSET_BYTES,
			) != 0 || libc::syscall(
				libc::SYS_rt_sigprocmask,
				libc::SIG_SETMASK,
				std::ptr::null::<libc::sigset_t>(),
				&raw mut on,
				KERNEL_SIGSET_BYTES,
			) != 0
			{
				libc::_exit(CHILD_NO_SETUP);
			}
			// Every signal that had to be blocked is blocked. `SIGKILL`
			// and `SIGSTOP` never are, and were never put in.
			let wanted = (&raw const starts_with).cast::<libc::c_ulong>();
			let held_now = (&raw const on).cast::<libc::c_ulong>();
			for word in 0..KERNEL_SIGSET_BYTES / size_of::<libc::c_ulong>() {
				if wanted.add(word).read_unaligned() & !held_now.add(word).read_unaligned() != 0 {
					libc::_exit(CHILD_NO_SETUP);
				}
			}
			if libc::setpgid(0, 0) != 0 {
				libc::_exit(CHILD_NO_SETUP);
			}
			// What a pipe used to do by filling up: a utility that writes
			// past this dies on `SIGXFSZ` instead of filling memory with an
			// answer that was never going to be one. One byte over the
			// limit is let through, so the length reports it rather than
			// the signal.
			let cap = libc::rlimit {
				rlim_cur: LOCALE_ANSWER_LIMIT as libc::rlim_t + 1,
				rlim_max: LOCALE_ANSWER_LIMIT as libc::rlim_t + 1,
			};
			if libc::setrlimit(libc::RLIMIT_FSIZE, &raw const cap) != 0 {
				libc::_exit(CHILD_NO_SETUP);
			}
			// The answer stream is redirected *before* `/dev/null` is
			// opened. With the selected stream closed on entry the open
			// takes that very number, and duplicating the answer onto it
			// afterwards left the later duplications reading the answer
			// file as their source: the diagnostics stream then carried the
			// codeset and a loadable locale read as unloadable.
			if libc::dup2(answer, taken) < 0 {
				libc::_exit(CHILD_NO_SETUP);
			}
			let null = libc::open(c"/dev/null".as_ptr(), libc::O_RDWR);
			if null < 0 || libc::dup2(null, 0) < 0 || libc::dup2(null, discarded) < 0 {
				libc::_exit(CHILD_NO_SETUP);
			}
			if null > 2 {
				libc::close(null);
			}
			if let Some(cwd) = cwd
				&& libc::chdir(cwd.as_ptr()) != 0
			{
				libc::_exit(CHILD_NO_DIRECTORY);
			}
			libc::execve(program.as_ptr(), argv.as_ptr().cast(), envp.as_ptr().cast());
			libc::_exit(CHILD_NO_PROGRAM);
		}
	}
	// The handle is owned before anything else can go wrong. A child
	// exists from the moment the clone returns, and an error path that
	// leaves before this point abandons both it and the descriptor the
	// kernel wrote: a denied mask restoration left five zombies and two
	// leaked descriptors while the query process lived, and a utility
	// sleeping past the query that started it.
	//
	// SAFETY: a fresh descriptor the kernel wrote for a child it made,
	// owned from here. `clone3` fills it in whenever it succeeds with
	// `CLONE_PIDFD`.
	let started = (child > 0 && handle >= 0)
		.then(|| ChildHandle(unsafe { std::os::fd::OwnedFd::from_raw_fd(handle) }));
	// Read before the mask call below, which reports through its return
	// value and leaves `errno` as it finds it.
	let spawned = match (child < 0, started.is_some()) {
		(true, _) => Err(std::io::Error::last_os_error()),
		// A child with no handle: not something `clone3` with
		// `CLONE_PIDFD` produces, and nothing this code can hold.
		(false, false) => Err(std::io::Error::from(std::io::ErrorKind::Unsupported)),
		(false, true) => Ok(()),
	};
	// SAFETY: putting back the mask this thread had before the clone.
	let restored = unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, &raw const held, std::ptr::null_mut()) };
	// A restoration that failed leaves the caller with nearly every signal
	// blocked, and that is reported on every way out of here. Returning
	// the clone's own refusal first lost it: a denied clone and a denied
	// restoration together said *Operation not permitted* and nothing at
	// all about a thread left blocking 62 signals.
	let failed = match (spawned, restored) {
		(Ok(()), 0) => None,
		(Ok(()), code) => Some(std::io::Error::from_raw_os_error(code)),
		(Err(spawn), 0) => Some(spawn),
		(Err(spawn), code) => {
			let mask = std::io::Error::from_raw_os_error(code);
			Some(std::io::Error::new(
				mask.kind(),
				format!("{spawn}, and this thread's signal mask was left as the clone needed it: {mask}"),
			))
		},
	};
	let Some(failed) = failed else {
		// `spawned` is `Ok` only where the handle above was owned.
		return started.ok_or_else(|| std::io::Error::from(std::io::ErrorKind::Unsupported));
	};
	match started {
		// The child is already running. Closing the descriptor is not
		// enough: it has to be ended and reaped before this returns.
		Some(started) => {
			started.end_group();
			let _ = started.reap();
		},
		// A child with no handle cannot be signalled safely — an unheld
		// number is the one thing this code will not reach — so it is
		// waited for, and no longer than the query it was started for was
		// going to live: the deadline is the query's own, not a second
		// one starting here. A review that erased the descriptor to reach
		// this branch left the wait pending at 6.5 seconds, and a fresh
		// five seconds after a parent held up for two took 7.
		None => {
			if let Some(number) = libc::pid_t::try_from(child).ok().filter(|number| *number > 0) {
				let mut status: libc::c_int = 0;
				loop {
					// SAFETY: `number` names this scope's child; no signal
					// is sent, so a competing reaper taking it only yields
					// `ECHILD` here.
					let waited = unsafe { libc::waitpid(number, &raw mut status, libc::WNOHANG) };
					let pending = waited == 0
						|| (waited < 0
							&& std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted);
					if !pending || std::time::Instant::now() >= deadline {
						break;
					}
					std::thread::sleep(std::time::Duration::from_millis(1));
				}
			}
		},
	}
	Err(failed)
}

#[cfg(target_os = "linux")]
impl ChildHandle {
	/// Whether the utility has ended, without consuming it: `Ok(true)`
	/// reapable, `Ok(false)` running.
	#[cfg(unix)]
	fn ended(&self) -> std::io::Result<bool> {
		use std::os::fd::AsRawFd as _;

		loop {
			// SAFETY: an all-zero `siginfo_t` is a valid out-parameter, the
			// descriptor is this handle's, and `WNOWAIT` leaves the child for
			// the reap that follows. `P_PIDFD` is 3.
			let mut ended: libc::siginfo_t = unsafe { std::mem::zeroed() };
			let watched = unsafe {
				libc::syscall(
					libc::SYS_waitid,
					3,
					self.0.as_raw_fd(),
					&raw mut ended,
					libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
					std::ptr::null_mut::<libc::c_void>(),
				)
			};
			if watched >= 0 {
				return Ok(ended.si_signo != 0);
			}
			let err = std::io::Error::last_os_error();
			if err.kind() != std::io::ErrorKind::Interrupted {
				return Err(err);
			}
		}
	}

	/// Ends the utility and everything left in its process group.
	///
	/// A kernel that does not know `PIDFD_SIGNAL_PROCESS_GROUP` (before
	/// Linux 6.9) ends the utility alone; a descendant it left in the group
	/// outlives the query there, which is the one thing this handle buys
	/// less of than a group signal by number — and a group signal by number
	/// is what reached somebody else's processes.
	#[cfg(unix)]
	fn end_group(&self) {
		use std::os::fd::AsRawFd as _;

		for flags in [PIDFD_SIGNAL_PROCESS_GROUP, 0] {
			// SAFETY: the descriptor is this handle's and the siginfo
			// pointer is null, which asks the kernel to synthesise one.
			let sent = unsafe {
				libc::syscall(
					libc::SYS_pidfd_send_signal,
					self.0.as_raw_fd(),
					libc::SIGKILL,
					std::ptr::null_mut::<libc::siginfo_t>(),
					flags,
				)
			};
			if sent >= 0 {
				return;
			}
		}
	}

	/// Reaps the utility and reports how it ended.
	#[cfg(unix)]
	fn reap(&self) -> std::io::Result<Completion> {
		use std::os::fd::AsRawFd as _;

		loop {
			// SAFETY: as in `ended`, without `WNOHANG` or `WNOWAIT`, so this
			// consumes the child it names and nothing else.
			let mut ended: libc::siginfo_t = unsafe { std::mem::zeroed() };
			let reaped = unsafe {
				libc::syscall(
					libc::SYS_waitid,
					3,
					self.0.as_raw_fd(),
					&raw mut ended,
					libc::WEXITED,
					std::ptr::null_mut::<libc::c_void>(),
				)
			};
			if reaped >= 0 {
				return Ok(completion_of(&ended));
			}
			let err = std::io::Error::last_os_error();
			if err.kind() != std::io::ErrorKind::Interrupted {
				return Err(err);
			}
		}
	}
}

/// Ends the locale utility and everything left in its process group, within
/// the deadline the answer had, and reaps it — all through the handle, so
/// no number of anyone else's can be reached.
#[cfg(target_os = "linux")]
fn reap_locale_utility(child: &ChildHandle, deadline: std::time::Instant, kill_now: bool) -> Completion {
	let mut finished = false;
	let mut watch_failed = None;
	loop {
		match child.ended() {
			Ok(false) if !kill_now && std::time::Instant::now() < deadline => {
				std::thread::sleep(std::time::Duration::from_millis(1));
			},
			Ok(ended) => {
				finished = ended;
				break;
			},
			Err(err) => {
				watch_failed = Some(err);
				break;
			},
		}
	}
	child.end_group();
	let reaped = child.reap();
	if let Some(err) = watch_failed {
		return Completion::Ended(format!("could not be waited for: {err}"));
	}
	if !finished {
		return Completion::Ended("was ended before it finished".to_owned());
	}
	match reaped {
		Ok(completion) => completion,
		Err(err) => Completion::Ended(format!("could not be waited for: {err}")),
	}
}

/// Whether this process has asked the kernel to reap its children for it,
/// with `SIGCHLD` ignored or `SA_NOCLDWAIT` set.
///
/// A query cannot be run then: the utility's number is released the moment
/// it exits, so neither its end nor its process group can be reached
/// without the risk of reaching somebody else's.
#[cfg(target_os = "linux")]
fn children_are_reaped_for_us() -> bool {
	// SAFETY: reading the current disposition with a null new action changes
	// nothing; the structure is initialised by the call before it is read.
	let mut current = std::mem::MaybeUninit::<libc::sigaction>::zeroed();
	let read = unsafe { libc::sigaction(libc::SIGCHLD, std::ptr::null(), current.as_mut_ptr()) };
	if read != 0 {
		return false;
	}
	// SAFETY: `sigaction` filled it in.
	let current = unsafe { current.assume_init() };
	current.sa_sigaction == libc::SIG_IGN || (current.sa_flags & libc::SA_NOCLDWAIT) != 0
}

/// A reaped child's `siginfo_t`, read the way [`Completion`] puts it.
#[cfg(target_os = "linux")]
fn completion_of(ended: &libc::siginfo_t) -> Completion {
	// SAFETY: `si_status` is the status member of a `siginfo_t` a completed
	// `waitid` filled in, which is what the caller passes.
	let status = unsafe { ended.si_status() };
	match ended.si_code {
		libc::CLD_EXITED => Completion::Exited(status),
		libc::CLD_KILLED | libc::CLD_DUMPED => Completion::Ended(format!("ended on signal {status}")),
		code => Completion::Ended(format!("ended with wait code {code}")),
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
