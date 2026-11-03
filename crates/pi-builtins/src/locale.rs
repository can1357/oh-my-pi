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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Condvar, Mutex, PoisonError, mpsc};
use std::time::{Duration, Instant};

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

/// The locale `setlocale(category, "")` selects when none of `LC_ALL`, the
/// category and `LANG` is set: C on glibc and the BSDs, and on musl C.UTF-8
/// (musl `src/locale/locale_map.c`, `__get_locale`, line 47).
pub(crate) const UNSET_LOCALE: &str = if cfg!(target_env = "musl") { "C.UTF-8" } else { "C" };

/// Whether a `language_TERRITORY[.codeset][@modifier]` name has a UTF-8
/// codeset (`C.UTF-8` included).
pub(crate) fn codeset_is_utf8(name: &str) -> bool {
	name.split(['.', '@']).nth(1).is_some_and(|codeset| {
		codeset.eq_ignore_ascii_case("utf-8") || codeset.eq_ignore_ascii_case("utf8")
	})
}

/// The categories a locale environment names, with the mask `newlocale`
/// knows each by: the six POSIX ones and, on glibc, the six it adds. A
/// utility's `setlocale(LC_ALL, "")` has to load every one of them.
#[cfg(unix)]
const LOCALE_CATEGORIES: &[(&str, libc::c_int)] = &[
	("LC_CTYPE", libc::LC_CTYPE_MASK),
	("LC_NUMERIC", libc::LC_NUMERIC_MASK),
	("LC_TIME", libc::LC_TIME_MASK),
	("LC_COLLATE", libc::LC_COLLATE_MASK),
	("LC_MONETARY", libc::LC_MONETARY_MASK),
	("LC_MESSAGES", libc::LC_MESSAGES_MASK),
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	("LC_PAPER", libc::LC_PAPER_MASK),
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	("LC_NAME", libc::LC_NAME_MASK),
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	("LC_ADDRESS", libc::LC_ADDRESS_MASK),
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	("LC_TELEPHONE", libc::LC_TELEPHONE_MASK),
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	("LC_MEASUREMENT", libc::LC_MEASUREMENT_MASK),
	#[cfg(all(target_os = "linux", target_env = "gnu"))]
	("LC_IDENTIFICATION", libc::LC_IDENTIFICATION_MASK),
];

/// Every category of [`LOCALE_CATEGORIES`] at once: glibc's `LC_ALL_MASK`,
/// which the Rust bindings do not declare for musl.
#[cfg(unix)]
pub(crate) const ALL_CATEGORIES_MASK: libc::c_int = {
	let mut mask = 0;
	let mut index = 0;
	while index < LOCALE_CATEGORIES.len() {
		mask |= LOCALE_CATEGORIES[index].1;
		index += 1;
	}
	mask
};

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
	/// error, unless the command was cancelled, which reports only that; the
	/// caller falls back to reading the names, never to claiming the C
	/// locale.
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
			Loadable::Cancelled => return ShellLocale::Unasked,
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
	let name = shell_locale(host, "LC_CTYPE").unwrap_or(UNSET_LOCALE);
	if name == "C" || name == "POSIX" {
		return false;
	}
	#[cfg(unix)]
	{
		match shell_locale_initialises(host) {
			ShellLocale::C => return false,
			ShellLocale::Unasked => return name_reads_as_utf8(name),
			ShellLocale::Set => {},
		}
		let env = |key: &str| host.var(key).map(str::to_owned);
		return match loaded_codeset(name, &env, &host.cancel_flag()) {
			Codeset::Loaded(codeset, _) => is_utf8_charset(&codeset),
			Codeset::Unloadable => false,
			Codeset::Unasked(why) => {
				host.warn(format!("warning: cannot read the locale \"{name}\": {why}"));
				name_reads_as_utf8(name)
			},
			Codeset::Cancelled => name_reads_as_utf8(name),
		};
	}
	#[cfg(not(unix))]
	codeset_is_utf8(name)
}

/// Whether a locale name reads as a UTF-8 locale when libc cannot be asked.
/// On musl every name but C and POSIX is one — musl loads any name with its
/// built-in UTF-8 map (`src/locale/locale_map.c`) — and elsewhere the name has
/// to spell a UTF-8 codeset.
pub(crate) fn name_reads_as_utf8(name: &str) -> bool {
	if cfg!(target_env = "musl") { name != "C" && name != "POSIX" } else { codeset_is_utf8(name) }
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

/// How long one load of locale data may run before later loads stop waiting
/// for it. A load reads a handful of local files; one that has not returned
/// in a second is waiting on something that is not local file data — a FIFO
/// or an unresponsive mount on the search path — which is the case this is
/// for. Calling this wrong costs only that later loads are answered from the
/// locale's name, with a warning.
const LOAD_WEDGED_AFTER: Duration = Duration::from_secs(1);

/// How often a caller waiting on a load checks its own cancellation.
const LOAD_POLL: Duration = Duration::from_millis(20);

/// When the locale load now in progress started, if one is.
static LOAD_STARTED: Mutex<Option<Instant>> = Mutex::new(None);

/// Signalled whenever a load finishes.
static LOAD_FINISHED: Condvar = Condvar::new();

/// Clears [`LOAD_STARTED`] when the load it guards ends, however it ends.
struct LoadInProgress;

impl Drop for LoadInProgress {
	fn drop(&mut self) {
		*LOAD_STARTED.lock().unwrap_or_else(PoisonError::into_inner) = None;
		LOAD_FINISHED.notify_all();
	}
}

/// Runs `load`, a call into libc's locale loader, so that a load that never
/// finishes holds up neither the command that started it nor any other.
///
/// libc keeps one lock for every locale load in the process (glibc
/// `locale/newlocale.c`: `__libc_rwlock_wrlock (__libc_setlocale_lock)`;
/// musl `newlocale.c`: `LOCK(__locale_lock)`), and keeps it while a load
/// waits — measured: a load blocked opening an `LC_CTYPE` that is a FIFO
/// held up a load of `C.UTF-8` from another shell until the FIFO was
/// opened. So each load runs on a thread of its own, one at a time: the
/// caller returns as soon as its command is cancelled, and a caller that
/// finds another command's load running waits for it at most until that
/// load has run for [`LOAD_WEDGED_AFTER`], then answers without libc. The
/// stuck thread stays where it is until its data arrives; nothing can take
/// it out of the system call.
///
/// `Err` says why there is no answer.
pub(crate) fn libc_locale_load<T: Send + 'static>(
	cancel: &AtomicBool,
	load: impl FnOnce() -> T + Send + 'static,
) -> Result<T, NoAnswer> {
	// A cancelled command starts no load: nothing will use its answer.
	if cancel.load(Ordering::Relaxed) {
		return Err(NoAnswer::Cancelled);
	}
	let mut started = LOAD_STARTED.lock().unwrap_or_else(PoisonError::into_inner);
	loop {
		let Some(since) = *started else { break };
		if since.elapsed() >= LOAD_WEDGED_AFTER {
			return Err(NoAnswer::Unasked(format!(
				"a locale load another command started {} s ago has not finished, and libc lets no other \
				 load run until it does (is a file on the locale search path a FIFO, or on an unresponsive \
				 mount?)",
				since.elapsed().as_secs()
			)));
		}
		if cancel.load(Ordering::Relaxed) {
			return Err(NoAnswer::Cancelled);
		}
		started = LOAD_FINISHED.wait_timeout(started, LOAD_POLL).unwrap_or_else(PoisonError::into_inner).0;
	}
	*started = Some(Instant::now());
	drop(started);
	let (answer_tx, answer) = mpsc::sync_channel(1);
	let spawned = std::thread::Builder::new().name("locale-load".into()).spawn(move || {
		let _in_progress = LoadInProgress;
		let _ = answer_tx.send(load());
	});
	if let Err(error) = spawned {
		drop(LoadInProgress);
		return Err(NoAnswer::Unasked(format!("no thread could be started to read the locale data: {error}")));
	}
	loop {
		match answer.recv_timeout(LOAD_POLL) {
			Ok(answer) => return Ok(answer),
			Err(mpsc::RecvTimeoutError::Timeout) if cancel.load(Ordering::Relaxed) => return Err(NoAnswer::Cancelled),
			Err(mpsc::RecvTimeoutError::Timeout) => {},
			Err(mpsc::RecvTimeoutError::Disconnected) => {
				return Err(NoAnswer::Unasked("reading the locale data ended without an answer".to_owned()));
			},
		}
	}
}

/// Why [`libc_locale_load`] gave no answer.
#[derive(Debug)]
pub(crate) enum NoAnswer {
	/// The command was cancelled first. It ends reporting that, as the
	/// reference ends on its signal, and prints nothing about its locale:
	/// callers fall back as for [`NoAnswer::Unasked`] but stay silent.
	Cancelled,
	/// libc could not be asked, for the reason given, which the caller
	/// reports as a warning.
	Unasked(String),
}

/// Whether the system can load `locale` for the categories in `mask`, in
/// this process's own locale environment, when nothing cancels the asking.
/// [`locale_loadable_in_shell`] is the same question in the shell's.
#[cfg(unix)]
pub(crate) fn locale_loadable(locale: &str, mask: libc::c_int) -> bool {
	matches!(loadable(locale, mask, &AtomicBool::new(false)), Loadable::Yes)
}

/// Whether libc loads `locale` for `mask`, asked through
/// [`libc_locale_load`]. A name `newlocale` would split into categories is
/// not put to it and is not loadable ([`reads_as_a_composite`]).
#[cfg(unix)]
fn loadable(locale: &str, mask: libc::c_int, cancel: &AtomicBool) -> Loadable {
	if reads_as_a_composite(locale) {
		return Loadable::No;
	}
	let Ok(name) = std::ffi::CString::new(locale) else {
		return Loadable::No;
	};
	// SAFETY: `name` is a valid NUL-terminated string; a non-null result is a
	// fresh locale object owned here and freed immediately.
	let load = move || unsafe {
		let handle = libc::newlocale(mask, name.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			return false;
		}
		libc::freelocale(handle);
		true
	};
	match libc_locale_load(cancel, load) {
		Ok(true) => Loadable::Yes,
		Ok(false) => Loadable::No,
		Err(NoAnswer::Cancelled) => Loadable::Cancelled,
		Err(NoAnswer::Unasked(why)) => Loadable::Unasked(why),
	}
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
	/// The command was cancelled before libc answered ([`NoAnswer::Cancelled`]).
	Cancelled,
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
	loadable(locale, mask, &host.cancel_flag())
}

/// The variables that decide where libc finds locale data, each with
/// whether it holds a `:`-separated list or one pathname: glibc's `LOCPATH`;
/// the conversion configuration glibc checks a name's codeset against
/// (`GCONV_PATH`, `findlocale.c`'s `__gconv_compare_alias`); the locale
/// archive Nix's glibc reads (`LOCALE_ARCHIVE`); and the BSDs' `PATH_LOCALE`,
/// which no libc on Linux reads.
///
/// None of them is read on musl, and musl's own `MUSL_LOCPATH` cannot change
/// an answer: `__get_locale` gives every name a locale, and every `LC_CTYPE`
/// name but C and POSIX a non-null map whether or not a file is found there
/// (`src/locale/locale_map.c` lines 95–110); the codeset is UTF-8 for a
/// non-null `LC_CTYPE` map and ASCII otherwise (`src/locale/langinfo.c` line
/// 35).
#[cfg(unix)]
const LOCALE_SEARCH_VARS: &[(&str, bool)] = &[
	#[cfg(not(target_env = "musl"))]
	("LOCPATH", true),
	#[cfg(not(target_env = "musl"))]
	("GCONV_PATH", true),
	#[cfg(not(target_env = "musl"))]
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

/// Which bytes `isprint` accepts in a locale, by byte value.
pub(crate) type Printable = [bool; 256];

/// [`Printable`] in the C locale: space to `~`.
pub(crate) const C_PRINTABLE: Printable = {
	let mut table = [false; 256];
	let mut byte = b' ';
	while byte <= b'~' {
		table[byte as usize] = true;
		byte += 1;
	}
	table
};

/// What libc reports for a locale name, and whether libc could be asked at
/// all.
#[cfg(unix)]
#[derive(Debug)]
pub(crate) enum Codeset {
	/// `nl_langinfo(CODESET)` for the loaded locale, in libc's own spelling
	/// (`ISO-8859-1` for an alias like a generated bare `en_US`, whose name
	/// carries no codeset at all), and which bytes `isprint` accepts there.
	Loaded(String, Printable),
	/// libc cannot load the name, which is what `setlocale` finds there: it
	/// fails and leaves the C locale in place.
	Unloadable,
	/// The question could not be put to libc in the shell's context, for the
	/// reason given. This is not an answer: reading it as the C locale would
	/// silently escape names the reference prints, so the caller reports it.
	Unasked(String),
	/// The command was cancelled before libc answered ([`NoAnswer::Cancelled`]):
	/// read as [`Codeset::Unasked`], without a report.
	Cancelled,
}

/// Whether glibc's `newlocale` would read `name` as a *composite* —
/// `LC_CTYPE=…;LC_TIME=…`, split per category (`locale/newlocale.c`, on
/// `strchr (locale, ';')`) — where `setlocale(CATEGORY, "")`, what every
/// caller models, takes the whole string as the name of one locale's data.
///
/// Such a name is read as one no data exists for, which is what the
/// reference finds for every name a locale ships under (measured:
/// `LC_ALL=LC_CTYPE=astra;LC_TIME=C` reports `ANSI_X3.4-1968`). Data
/// literally named with a `;` is the one case where that differs: the
/// reference loads it, and `newlocale` cannot be asked about it. musl's
/// `newlocale` takes a name whole, as its `setlocale` of one category does,
/// so there it is simply asked.
#[cfg(unix)]
fn reads_as_a_composite(name: &str) -> bool {
	!cfg!(target_env = "musl") && name.contains(';')
}

/// The codeset `nl_langinfo(CODESET)` reports once `locale` is loaded for
/// `LC_CTYPE`, as a command the shell starts would see it. `env` is the
/// shell's environment, and `cancel` the command's cancellation.
///
/// The answer comes from `newlocale` in this process, through
/// [`libc_locale_load`], and is [`Codeset::Unasked`] when the shell's locale
/// search path is not this process's ([`shell_search_path_unreadable`]) or
/// the load could not be waited for.
#[cfg(unix)]
pub(crate) fn loaded_codeset(locale: &str, env: &dyn Fn(&str) -> Option<String>, cancel: &AtomicBool) -> Codeset {
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
	let load = move || unsafe {
		let handle = libc::newlocale(libc::LC_CTYPE_MASK, name.as_ptr(), std::ptr::null_mut());
		if handle.is_null() {
			return Codeset::Unloadable;
		}
		// The thread is `libc_locale_load`'s own, so making the locale its
		// current one for `isprint` affects nothing else.
		let previous = libc::uselocale(handle);
		let printable: Printable = std::array::from_fn(|byte| libc::isprint(byte as libc::c_int) != 0);
		libc::uselocale(previous);
		let codeset = langinfo_of_locale(libc::CODESET, handle);
		let answer = match codeset.is_null() {
			true => Codeset::Unloadable,
			false => Codeset::Loaded(std::ffi::CStr::from_ptr(codeset).to_string_lossy().into_owned(), printable),
		};
		libc::freelocale(handle);
		answer
	};
	match libc_locale_load(cancel, load) {
		Ok(codeset) => codeset,
		Err(NoAnswer::Cancelled) => Codeset::Cancelled,
		Err(NoAnswer::Unasked(why)) => Codeset::Unasked(why),
	}
}

/// What GNU `sort -M` matches month names with after `setlocale(LC_ALL, "")`
/// (coreutils `sort.c`, `inittables` and `getmonth`): each byte's `toupper`
/// in the `LC_CTYPE` locale, the blanks a line's month may follow (`blanks[]`:
/// `isblank` there, and newline, which a `-z` record can hold), and the
/// `LC_TIME` locale's abbreviated month names (`nl_langinfo(ABMON_1..12)`)
/// with every `isblank` byte removed and every byte folded.
#[derive(Debug)]
pub(crate) struct MonthNames {
	/// `toupper` of each byte.
	pub fold:  [u8; 256],
	/// `isblank` of each byte, or newline.
	pub blank: [bool; 256],
	/// January to December, folded, blanks removed.
	pub names: [Vec<u8>; 12],
}

impl MonthNames {
	/// The C locale's: ASCII case folding, space, tab and newline blank, and
	/// the given names, folded the same way.
	pub(crate) fn c_locale(names: &[Vec<u8>; 12]) -> Self {
		let mut fold = [0u8; 256];
		let mut blank = [false; 256];
		for byte in 0..=255u8 {
			fold[usize::from(byte)] = byte.to_ascii_uppercase();
			blank[usize::from(byte)] = matches!(byte, b' ' | b'\t' | b'\n');
		}
		let names = names.clone().map(|name| {
			name.iter().filter(|b| !blank[usize::from(**b)]).map(|b| fold[usize::from(*b)]).collect()
		});
		Self { fold, blank, names }
	}
}

/// [`MonthNames`] for the shell's `LC_TIME` and `LC_CTYPE`, or `None` when the
/// environment leaves the C locale ([`shell_locale_initialises`]) or the
/// names could not be read.
///
/// Read with `newlocale` for the shell's own locales — never `setlocale`,
/// which would change this process's locale and read omp's — through
/// [`libc_locale_load`] with `cancel`, so locale data that never arrives holds
/// up neither this command nor another. Only a lookup that succeeds is kept,
/// per pair of locale names: a cancelled or abandoned one leaves this command
/// with the C names, and the next asks again.
#[cfg(unix)]
pub(crate) fn shell_month_names(host: &Host, cancel: &AtomicBool) -> Option<std::sync::Arc<MonthNames>> {
	type Read = Vec<((String, String), std::sync::Arc<MonthNames>)>;
	static READ: Mutex<Read> = Mutex::new(Vec::new());
	let time = shell_locale(host, "LC_TIME").unwrap_or(UNSET_LOCALE);
	let ctype = shell_locale(host, "LC_CTYPE").unwrap_or(UNSET_LOCALE);
	let is_c = |name: &str| name == "C" || name == "POSIX";
	if (is_c(time) && is_c(ctype)) || !matches!(shell_locale_initialises(host), ShellLocale::Set) {
		return None;
	}
	let key = (time.to_owned(), ctype.to_owned());
	if let Some((_, names)) = READ.lock().unwrap_or_else(PoisonError::into_inner).iter().find(|(read, _)| *read == key) {
		return Some(std::sync::Arc::clone(names));
	}
	let (Ok(time_c), Ok(ctype_c)) = (std::ffi::CString::new(time), std::ffi::CString::new(ctype)) else {
		return None;
	};
	const ABMON: [libc::nl_item; 12] = [
		libc::ABMON_1,
		libc::ABMON_2,
		libc::ABMON_3,
		libc::ABMON_4,
		libc::ABMON_5,
		libc::ABMON_6,
		libc::ABMON_7,
		libc::ABMON_8,
		libc::ABMON_9,
		libc::ABMON_10,
		libc::ABMON_11,
		libc::ABMON_12,
	];
	// SAFETY: both names are valid NUL-terminated strings. The closure runs on
	// a thread of its own (`libc_locale_load`), so making the locale object
	// that thread's current locale with `uselocale` affects nothing else; it
	// is restored and freed before returning, and every name `nl_langinfo`
	// lends out is copied first.
	let load = move || unsafe {
		let times = libc::newlocale(libc::LC_TIME_MASK, time_c.as_ptr(), std::ptr::null_mut());
		if times.is_null() {
			return None;
		}
		let both = libc::newlocale(libc::LC_CTYPE_MASK, ctype_c.as_ptr(), times);
		if both.is_null() {
			libc::freelocale(times);
			return None;
		}
		let previous = libc::uselocale(both);
		let mut fold = [0u8; 256];
		let mut blank = [false; 256];
		for byte in 0..=255u8 {
			fold[usize::from(byte)] = libc::toupper(libc::c_int::from(byte)) as u8;
			blank[usize::from(byte)] = libc::isblank(libc::c_int::from(byte)) != 0 || byte == b'\n';
		}
		let mut names: [Vec<u8>; 12] = Default::default();
		let mut complete = true;
		for (slot, item) in names.iter_mut().zip(ABMON) {
			let name = libc::nl_langinfo(item);
			if name.is_null() {
				complete = false;
				break;
			}
			*slot = std::ffi::CStr::from_ptr(name)
				.to_bytes()
				.iter()
				.filter(|byte| !blank[usize::from(**byte)])
				.map(|byte| fold[usize::from(*byte)])
				.collect();
			complete &= !slot.is_empty();
		}
		libc::uselocale(previous);
		libc::freelocale(both);
		complete.then_some(MonthNames { fold, blank, names })
	};
	match libc_locale_load(cancel, load) {
		Ok(Some(names)) => {
			let names = std::sync::Arc::new(names);
			let mut read = READ.lock().unwrap_or_else(PoisonError::into_inner);
			if !read.iter().any(|(known, _)| *known == key) {
				read.push((key, std::sync::Arc::clone(&names)));
			}
			Some(names)
		},
		Ok(None) | Err(NoAnswer::Cancelled) => None,
		Err(NoAnswer::Unasked(why)) => {
			host.warn(format!("warning: cannot read the month names of the locale \"{time}\": {why}"));
			None
		},
	}
}

/// GNU `sort`'s byte tables after `setlocale(LC_ALL, "")` (coreutils `sort.c`,
/// `inittables`), for the `LC_CTYPE` locale, and that locale's display widths
/// for `--debug` (`debug_width`, gnulib `mbsnwidth`).
pub(crate) struct SortCtype {
	/// `blanks[]`: `isblank`, and newline. What `-b` skips, what separates
	/// fields without `-t`, and what a number may follow under `-n` and `-h`.
	pub blank:      [bool; 256],
	/// `isspace`: what `strtold` skips before a `-g` number.
	pub space:      [bool; 256],
	/// Not `nondictionary[]`: `isalnum`, or a blank. What `-d` keeps.
	pub dictionary: [bool; 256],
	/// Not `nonprinting[]`: `isprint`. What `-i` keeps.
	pub printable:  [bool; 256],
	/// `iscntrl`: no display width in a single-byte locale.
	pub control:    [bool; 256],
	/// `fold_toupper[]`: `toupper`. How `-f` folds.
	pub fold:       [u8; 256],
	/// The loaded locale, for multibyte display widths; `None` when every
	/// character is one byte (`MB_CUR_MAX` 1), whose widths the tables give.
	#[cfg(unix)]
	multibyte:      Option<LocaleObject>,
}

/// A loaded locale object, freed when dropped. glibc and musl locale objects
/// are never changed once made, so any thread may make one its current locale.
#[cfg(unix)]
struct LocaleObject(libc::locale_t);

// SAFETY: see `LocaleObject`.
#[cfg(unix)]
unsafe impl Send for LocaleObject {}
// SAFETY: as above.
#[cfg(unix)]
unsafe impl Sync for LocaleObject {}

#[cfg(unix)]
impl Drop for LocaleObject {
	fn drop(&mut self) {
		// SAFETY: the object came from `newlocale` and nothing uses it any more.
		unsafe { libc::freelocale(self.0) };
	}
}

impl std::fmt::Debug for SortCtype {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("SortCtype").finish_non_exhaustive()
	}
}

/// [`SortCtype`] for the C locale.
const fn c_sort_ctype() -> SortCtype {
	let mut ctype = SortCtype {
		blank:      [false; 256],
		space:      [false; 256],
		dictionary: [false; 256],
		printable:  [false; 256],
		control:    [false; 256],
		fold:       [0; 256],
		#[cfg(unix)]
		multibyte:                     None,
	};
	let mut byte = 0usize;
	while byte < 256 {
		let b = byte as u8;
		ctype.blank[byte] = matches!(b, b' ' | b'\t' | b'\n');
		ctype.space[byte] = matches!(b, b' ' | b'\t' | b'\n' | 0x0b | 0x0c | b'\r');
		ctype.dictionary[byte] = b.is_ascii_alphanumeric() || ctype.blank[byte];
		ctype.printable[byte] = matches!(b, b' '..=b'~');
		ctype.control[byte] = b < b' ' || b == 0x7f;
		ctype.fold[byte] = b.to_ascii_uppercase();
		byte += 1;
	}
	ctype
}

/// [`SortCtype`] for the C locale, for borrowing with a `'static` lifetime.
pub(crate) static C_SORT_CTYPE: SortCtype = c_sort_ctype();

impl Default for SortCtype {
	fn default() -> Self {
		c_sort_ctype()
	}
}

impl SortCtype {
	/// Whether `-f` folds as ASCII does (every locale but a few single-byte ones).
	pub(crate) fn folds_ascii(&self) -> bool {
		self.fold == C_SORT_CTYPE.fold
	}

	/// GNU `debug_width`: the columns `text` takes, as gnulib `mbsnwidth`
	/// counts them (a byte that starts no character takes one, a control
	/// character none), plus one for each tab.
	pub(crate) fn width(&self, text: &[u8]) -> usize {
		let tabs = text.iter().filter(|&&b| b == b'\t').count();
		#[cfg(unix)]
		if let Some(object) = &self.multibyte {
			return multibyte_width(object, text) + tabs;
		}
		let single = |b: &u8| match (self.printable[usize::from(*b)], self.control[usize::from(*b)]) {
			(true, _) => 1,
			(false, true) => 0,
			(false, false) => 1,
		};
		text.iter().map(single).sum::<usize>() + tabs
	}
}

/// gnulib `mbsnwidth` with no flags, in the locale `object`: printable ASCII
/// takes one column; otherwise `mbrtowc` and `wcwidth`, a byte no character
/// starts taking one column, an incomplete character at the end one column
/// for all its bytes, a character `wcwidth` cannot measure one unless it is a
/// control character.
#[cfg(unix)]
fn multibyte_width(object: &LocaleObject, text: &[u8]) -> usize {
	// SAFETY: the object is a live locale for as long as it is borrowed; the
	// previous locale of this thread is restored before returning. `state` is
	// a zeroed conversion state, as `mbrtowc` expects at the start.
	unsafe {
		let previous = libc::uselocale(object.0);
		let mut width = 0usize;
		let mut rest = text;
		let mut state = MbState([0; 128]);
		while let Some(&first) = rest.first() {
			if matches!(first, b' '..=b'~') {
				width += 1;
				rest = &rest[1..];
				continue;
			}
			let mut wc: libc::wchar_t = 0;
			let used = mbrtowc(&mut wc, rest.as_ptr().cast(), rest.len(), &mut state);
			if used == usize::MAX {
				// Invalid: one column for the byte (gnulib).
				state = MbState([0; 128]);
				width += 1;
				rest = &rest[1..];
				continue;
			}
			if used == usize::MAX - 1 {
				// Incomplete at the end: one column for the rest (gnulib).
				width += 1;
				break;
			}
			let used = used.max(1);
			let columns = wcwidth(wc);
			if columns >= 0 {
				width += columns as usize;
			} else if iswcntrl(wc as WintT) == 0 {
				width += 1;
			}
			rest = &rest[used..];
		}
		libc::uselocale(previous);
		width
	}
}

/// C `wint_t`.
#[cfg(all(unix, not(target_vendor = "apple")))]
type WintT = libc::c_uint;
/// C `wint_t`.
#[cfg(target_vendor = "apple")]
type WintT = libc::c_int;

/// Room for C `mbstate_t`, which the Rust bindings do not declare for every
/// C library: 8 bytes in glibc and musl, 128 in Apple's.
#[cfg(unix)]
#[repr(C, align(8))]
struct MbState([u8; 128]);

#[cfg(unix)]
unsafe extern "C" {
	fn mbrtowc(wc: *mut libc::wchar_t, text: *const libc::c_char, len: libc::size_t, state: *mut MbState) -> libc::size_t;
	fn wcwidth(wc: libc::wchar_t) -> libc::c_int;
	fn iswcntrl(wc: WintT) -> libc::c_int;
}

/// [`SortCtype`] for the C locale, shared.
pub(crate) fn c_sort_ctype_shared() -> std::sync::Arc<SortCtype> {
	static C: std::sync::LazyLock<std::sync::Arc<SortCtype>> =
		std::sync::LazyLock::new(|| std::sync::Arc::new(c_sort_ctype()));
	std::sync::Arc::clone(&C)
}

/// [`SortCtype`] for the shell's `LC_CTYPE`: the C tables when the
/// environment leaves the C locale ([`shell_locale_initialises`]) or the
/// locale cannot be read. Read with `newlocale` through [`libc_locale_load`]
/// with `cancel`, like [`shell_month_names`]; only a lookup that succeeds is
/// kept, per locale name.
#[cfg(unix)]
pub(crate) fn shell_sort_ctype(host: &Host, cancel: &AtomicBool) -> std::sync::Arc<SortCtype> {
	static READ: Mutex<Vec<(String, std::sync::Arc<SortCtype>)>> = Mutex::new(Vec::new());
	let name = shell_locale(host, "LC_CTYPE").unwrap_or(UNSET_LOCALE);
	if name == "C" || name == "POSIX" || !matches!(shell_locale_initialises(host), ShellLocale::Set) {
		return c_sort_ctype_shared();
	}
	if let Some((_, ctype)) = READ.lock().unwrap_or_else(PoisonError::into_inner).iter().find(|(read, _)| read == name) {
		return std::sync::Arc::clone(ctype);
	}
	let Ok(name_c) = std::ffi::CString::new(name) else {
		return c_sort_ctype_shared();
	};
	// SAFETY: the name is a valid NUL-terminated string. The closure runs on
	// a thread of its own (`libc_locale_load`), so making the locale object
	// that thread's current locale affects nothing else; the previous one is
	// restored before returning. The object is owned by the tables when kept
	// for multibyte widths, and freed here otherwise.
	let load = move || unsafe {
		let object = libc::newlocale(libc::LC_CTYPE_MASK, name_c.as_ptr(), std::ptr::null_mut());
		if object.is_null() {
			return None;
		}
		let previous = libc::uselocale(object);
		let mut ctype = c_sort_ctype();
		for byte in 0..=255u8 {
			let (i, c) = (usize::from(byte), libc::c_int::from(byte));
			ctype.blank[i] = libc::isblank(c) != 0 || byte == b'\n';
			ctype.space[i] = libc::isspace(c) != 0;
			ctype.dictionary[i] = libc::isalnum(c) != 0 || ctype.blank[i];
			ctype.printable[i] = libc::isprint(c) != 0;
			ctype.control[i] = libc::iscntrl(c) != 0;
			ctype.fold[i] = libc::toupper(c) as u8;
		}
		let multibyte = mb_cur_max() > 1;
		libc::uselocale(previous);
		if multibyte {
			ctype.multibyte = Some(LocaleObject(object));
		} else {
			libc::freelocale(object);
		}
		Some(ctype)
	};
	match libc_locale_load(cancel, load) {
		Ok(Some(ctype)) => {
			let mut read = READ.lock().unwrap_or_else(PoisonError::into_inner);
			if let Some((_, known)) = read.iter().find(|(known, _)| known == name) {
				return std::sync::Arc::clone(known);
			}
			let ctype = std::sync::Arc::new(ctype);
			read.push((name.to_owned(), std::sync::Arc::clone(&ctype)));
			ctype
		},
		Ok(None) | Err(NoAnswer::Cancelled) => c_sort_ctype_shared(),
		Err(NoAnswer::Unasked(why)) => {
			host.warn(format!("warning: cannot read the character classes of the locale \"{name}\": {why}"));
			c_sort_ctype_shared()
		},
	}
}

/// [`SortCtype`] for the shell's `LC_CTYPE`; the C tables where locales are
/// not read.
#[cfg(not(unix))]
pub(crate) fn shell_sort_ctype(_host: &Host, _cancel: &AtomicBool) -> std::sync::Arc<SortCtype> {
	c_sort_ctype_shared()
}

/// gnulib `memcoll0`'s order over `cmp`, a collation of NUL-free pieces:
/// equal bytes are equal; otherwise the NUL-separated pieces are collated in
/// turn, and when every piece collates equal the string with pieces left
/// over is greater. GNU `sort` compares text this way in every locale it
/// collates in, so an embedded NUL separates, where a collation that ignores
/// U+0000 (ICU) would join the pieces around it.
pub(crate) fn memcoll_pieces(
	a: &[u8],
	b: &[u8],
	mut cmp: impl FnMut(&[u8], &[u8]) -> std::cmp::Ordering,
) -> std::cmp::Ordering {
	use std::cmp::Ordering;
	if a == b {
		return Ordering::Equal;
	}
	let (mut pieces_a, mut pieces_b) = (a.split(|&byte| byte == 0), b.split(|&byte| byte == 0));
	loop {
		match (pieces_a.next(), pieces_b.next()) {
			(Some(piece_a), Some(piece_b)) => match cmp(piece_a, piece_b) {
				Ordering::Equal => {},
				diff => return diff,
			},
			(None, None) => return Ordering::Equal,
			(None, Some(_)) => return Ordering::Less,
			(Some(_), None) => return Ordering::Greater,
		}
	}
}

/// GNU `sort`'s collation: `strcoll` in the `LC_COLLATE` locale, through a
/// locale object.
#[cfg(unix)]
pub(crate) struct LibcCollator(LocaleObject);

#[cfg(unix)]
impl std::fmt::Debug for LibcCollator {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("LibcCollator").finish_non_exhaustive()
	}
}

#[cfg(unix)]
thread_local! {
	/// A NUL-terminated copy of each piece one comparison collates.
	static COLLATE_BUFS: std::cell::RefCell<(Vec<u8>, Vec<u8>)> =
		const { std::cell::RefCell::new((Vec::new(), Vec::new())) };
}

#[cfg(unix)]
impl LibcCollator {
	/// gnulib `memcoll0` with `strcoll_l` ([`memcoll_pieces`]).
	pub(crate) fn compare(&self, a: &[u8], b: &[u8]) -> std::cmp::Ordering {
		COLLATE_BUFS.with_borrow_mut(|(sa, sb)| {
			memcoll_pieces(a, b, |piece_a, piece_b| {
				for (buf, piece) in [(&mut *sa, piece_a), (&mut *sb, piece_b)] {
					buf.clear();
					buf.extend_from_slice(piece);
					buf.push(0);
				}
				// SAFETY: each buffer is a piece, which holds no NUL, and one NUL
				// after it, so a C string; the locale object is live while borrowed.
				unsafe { strcoll_l(sa.as_ptr().cast(), sb.as_ptr().cast(), self.0.0) }.cmp(&0)
			})
		})
	}

	/// The `strxfrm_l` key of `s`, piece by piece between NULs and joined by
	/// a NUL (which no key holds), so that two keys are equal exactly when
	/// [`Self::compare`] finds the strings equal. GNU `sort -R` hashes this
	/// form, so strings the locale equates hash the same.
	pub(crate) fn transform(&self, s: &[u8]) -> Vec<u8> {
		let mut key = Vec::new();
		COLLATE_BUFS.with_borrow_mut(|(piece_c, _)| {
			for (n, piece) in s.split(|&byte| byte == 0).enumerate() {
				if n > 0 {
					key.push(0);
				}
				piece_c.clear();
				piece_c.extend_from_slice(piece);
				piece_c.push(0);
				let start = key.len();
				let mut room = piece.len() * 4 + 16;
				loop {
					key.resize(start + room, 0);
					// SAFETY: `piece_c` is a C string (a piece holds no NUL); the
					// destination has `room` bytes; the locale object is live.
					let need = unsafe {
						strxfrm_l(key[start..].as_mut_ptr().cast(), piece_c.as_ptr().cast(), room, self.0.0)
					};
					if need < room {
						key.truncate(start + need);
						break;
					}
					room = need + 1;
				}
			}
		});
		key
	}
}

#[cfg(unix)]
unsafe extern "C" {
	fn strcoll_l(a: *const libc::c_char, b: *const libc::c_char, locale: libc::locale_t) -> libc::c_int;
	fn strxfrm_l(dest: *mut libc::c_char, src: *const libc::c_char, n: libc::size_t, locale: libc::locale_t) -> libc::size_t;
}

/// [`LibcCollator`] for the locale named `name` (the shell's `LC_COLLATE`),
/// loaded with `newlocale` through [`libc_locale_load`] with `cancel`; `None`
/// when libc cannot load it, where GNU `sort` compares bytes. A lookup that
/// succeeds is kept for the life of the process, per name.
#[cfg(unix)]
pub(crate) fn libc_collator(host: &Host, name: &str, cancel: &AtomicBool) -> Option<std::sync::Arc<LibcCollator>> {
	static READ: Mutex<Vec<(String, std::sync::Arc<LibcCollator>)>> = Mutex::new(Vec::new());
	if let Some((_, known)) = READ.lock().unwrap_or_else(PoisonError::into_inner).iter().find(|(read, _)| read == name) {
		return Some(std::sync::Arc::clone(known));
	}
	let name_c = std::ffi::CString::new(name).ok()?;
	// SAFETY: the name is a valid NUL-terminated string; the object is owned
	// by the collator from here on.
	let load = move || unsafe {
		let object = libc::newlocale(libc::LC_COLLATE_MASK, name_c.as_ptr(), std::ptr::null_mut());
		(!object.is_null()).then(|| LibcCollator(LocaleObject(object)))
	};
	match libc_locale_load(cancel, load) {
		Ok(Some(collator)) => {
			let mut read = READ.lock().unwrap_or_else(PoisonError::into_inner);
			if let Some((_, known)) = read.iter().find(|(known, _)| known == name) {
				return Some(std::sync::Arc::clone(known));
			}
			let collator = std::sync::Arc::new(collator);
			read.push((name.to_owned(), std::sync::Arc::clone(&collator)));
			Some(collator)
		},
		Ok(None) | Err(NoAnswer::Cancelled) => None,
		Err(NoAnswer::Unasked(why)) => {
			host.warn(format!("warning: cannot read the collation of the locale \"{name}\": {why}"));
			None
		},
	}
}

/// `MB_CUR_MAX` for this thread's locale.
#[cfg(all(unix, not(target_vendor = "apple")))]
fn mb_cur_max() -> usize {
	unsafe extern "C" {
		fn __ctype_get_mb_cur_max() -> libc::size_t;
	}
	// SAFETY: reads the current thread's locale; no arguments.
	unsafe { __ctype_get_mb_cur_max() }
}

/// `MB_CUR_MAX` for this thread's locale.
#[cfg(target_vendor = "apple")]
fn mb_cur_max() -> usize {
	unsafe extern "C" {
		fn ___mb_cur_max() -> libc::c_int;
	}
	// SAFETY: reads the current thread's locale; no arguments.
	usize::try_from(unsafe { ___mb_cur_max() }).unwrap_or(1)
}

/// `nl_langinfo_l(item, …)`, which the Rust bindings declare on Linux and
/// not on the BSDs, where the C library has it all the same.
///
/// # Safety
///
/// `handle` is a live locale object, and the string it lends out lives only
/// until that object is freed.
#[cfg(target_os = "linux")]
unsafe fn langinfo_of_locale(item: libc::nl_item, handle: libc::locale_t) -> *mut libc::c_char {
	// SAFETY: the caller's contract.
	unsafe { libc::nl_langinfo_l(item, handle) }
}

/// `nl_langinfo_l(item, …)`, declared here because the Rust bindings do not
/// declare it for this target.
///
/// # Safety
///
/// As for the Linux one.
#[cfg(all(unix, not(target_os = "linux")))]
unsafe fn langinfo_of_locale(item: libc::nl_item, handle: libc::locale_t) -> *mut libc::c_char {
	unsafe extern "C" {
		fn nl_langinfo_l(item: libc::nl_item, locale: libc::locale_t) -> *mut libc::c_char;
	}
	// SAFETY: the caller's contract.
	unsafe { nl_langinfo_l(item, handle) }
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
