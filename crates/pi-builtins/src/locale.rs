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
///
/// `newlocale` splits a name carrying a `;` per category where `setlocale`
/// would take it whole ([`reads_as_a_composite`]). Nothing here refuses such
/// a name: the reference loads locale data literally so named, and a filter
/// on the punctuation would turn those into the C locale.
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

/// Where libc looks for locale data, and for the charset aliases it checks
/// that data against: `LOCPATH` on glibc and musl, `PATH_LOCALE` on the
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
	let relative = relative_entry_in(&shell) || relative_entry_in(&ours);
	let same_cwd = !relative || (shell_cwd.is_some() && shell_cwd == ours_cwd.as_deref());
	// A name `newlocale` would split per category has to go to the utility
	// even when nothing else would send it there, because only `setlocale`
	// reads it the way the reference does.
	if shell == ours && same_cwd && !reads_as_a_composite(locale) {
		return loaded_codeset_here(locale);
	}
	let cwd = match relative_entry_in(&shell) {
		false => None,
		true => match shell_cwd {
			Some(cwd) => Some(cwd),
			None => {
				return Codeset::Unasked(
					"the shell's locale environment is relative to a working directory no process can enter"
						.to_owned(),
				);
			},
		},
	};
	codeset_from_locale_utility(locale, &shell, cwd)
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
		let codeset = libc::nl_langinfo_l(libc::CODESET, handle);
		let answer = match codeset.is_null() {
			true => Codeset::Unloadable,
			false => Codeset::Loaded(std::ffi::CStr::from_ptr(codeset).to_string_lossy().into_owned()),
		};
		libc::freelocale(handle);
		answer
	}
}

/// Whether any entry of the shell's locale environment is relative, and so
/// resolves against the working directory of whichever process libc runs in.
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
#[cfg(unix)]
fn relative_entry_in(env: &LocaleEnv) -> bool {
	use std::os::unix::ffi::OsStrExt as _;

	env.iter().flatten().any(|value| {
		value.as_bytes().split(|&byte| byte == b':').any(|entry| !entry.is_empty() && entry[0] != b'/')
	})
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
/// absolute path, put in its own process group so neither it nor a
/// descendant outlives the query, and handed an environment built here —
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

/// The body of [`codeset_from_locale_utility`]: the first utility that is
/// there, asked.
#[cfg(unix)]
fn locale_utility_charmap(
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
) -> Result<String, Unanswered> {
	let Some(program) =
		LOCALE_UTILITIES.iter().copied().find(|at| std::fs::metadata(at).is_ok_and(|meta| meta.is_file()))
	else {
		return Err(Unanswered(format!(
			"there is no locale utility at {} or {}",
			LOCALE_UTILITIES[0], LOCALE_UTILITIES[1]
		)));
	};
	locale_utility_charmap_at(std::path::Path::new(program), locale, env, cwd)
}

/// [`locale_utility_charmap`] against one named program: one whole,
/// validated codeset from a child that ran to a normal end, or why there is
/// none.
#[cfg(unix)]
fn locale_utility_charmap_at(
	program: &std::path::Path,
	locale: &str,
	env: &LocaleEnv,
	cwd: Option<&std::path::Path>,
) -> Result<String, Unanswered> {
	use std::io::Read as _;
	use std::os::fd::AsRawFd as _;
	use std::os::unix::ffi::OsStrExt as _;

	let report = Unanswered;
	let named = program.display();
	let text = |bytes: &[u8]| {
		std::ffi::CString::new(bytes)
			.map_err(|_| report("the locale name or search path contains a NUL byte".to_owned()))
	};
	let program_c = text(program.as_os_str().as_bytes())?;
	let argv0 = text(b"locale")?;
	let argv1 = text(b"charmap")?;
	let cwd_c = cwd.map(|cwd| text(cwd.as_os_str().as_bytes())).transpose()?;
	// `locale` reads `LC_CTYPE` from the environment for the category this
	// asks about (`locale/programs/locale.c` sets that category on its own
	// before anything else), so naming it directly is rsync's
	// `setlocale(LC_CTYPE, "")`, and every other category is left to default
	// to C rather than to a locale whose data is only partly there.
	let mut vars = vec![text(format!("LC_CTYPE={locale}").as_bytes())?];
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
	let (reader, writer) =
		std::io::pipe().map_err(|err| report(format!("no pipe for the locale utility's answer: {err}")))?;
	// Both ends have to sit above the standard descriptors, or the file
	// actions below would open `/dev/null` over the very descriptor the
	// answer is written to (reproduced with this process's own 1 and 2
	// closed, which is when `pipe` hands them out).
	let reader = above_standard(reader.into()).map_err(|err| report(format!("no pipe: {err}")))?;
	let writer = above_standard(writer.into()).map_err(|err| report(format!("no pipe: {err}")))?;
	let mut reader = std::fs::File::from(reader);

	let deadline = std::time::Instant::now() + LOCALE_QUERY_TIMEOUT;
	let pid = spawn_locale_utility(&program_c, &argv, &envp, writer.as_raw_fd(), cwd_c.as_deref()).map_err(
		|err| match cwd_c.is_some() {
			true => report(format!("{named} could not enter the shell's working directory or start: {err}")),
			false => report(format!("{named} could not be started: {err}")),
		},
	)?;
	// The write end is the child's now; holding it here would keep the read
	// below from ever seeing the end of the answer.
	drop(writer);

	let mut answer = Vec::new();
	let mut timed_out = false;
	let mut too_much = false;
	let mut read_failed = None;
	loop {
		let left = deadline.saturating_duration_since(std::time::Instant::now());
		if left.is_zero() {
			timed_out = true;
			break;
		}
		let mut poll = [libc::pollfd { fd: reader.as_raw_fd(), events: libc::POLLIN, revents: 0 }];
		// SAFETY: one initialised `pollfd` naming a descriptor this scope owns.
		let ready =
			unsafe { libc::poll(poll.as_mut_ptr(), 1, i32::try_from(left.as_millis()).unwrap_or(i32::MAX)) };
		if ready == 0 {
			timed_out = true;
			break;
		}
		if ready < 0 {
			let err = std::io::Error::last_os_error();
			if err.kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			read_failed = Some(err);
			break;
		}
		let mut buffer = [0u8; 128];
		match reader.read(&mut buffer) {
			Ok(0) => break,
			Ok(read) => answer.extend_from_slice(&buffer[..read]),
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {},
			Err(err) => {
				read_failed = Some(err);
				break;
			},
		}
		if answer.len() > LOCALE_ANSWER_LIMIT {
			too_much = true;
			break;
		}
	}
	// A child that is still writing, or still running with nothing more to
	// say, is ended here rather than waited for.
	let completion = reap_locale_utility(pid, deadline, timed_out || too_much || read_failed.is_some());
	if timed_out {
		return Err(report(format!("{named} did not answer within {}s", LOCALE_QUERY_TIMEOUT.as_secs())));
	}
	if too_much {
		return Err(report(format!("{named} wrote more than {LOCALE_ANSWER_LIMIT} bytes")));
	}
	if let Some(err) = read_failed {
		return Err(report(format!("{named} could not be read: {err}")));
	}
	match completion {
		// glibc's `locale` reports a locale it could not set on its standard
		// error and still exits 0 (measured on glibc 2.39), so any other
		// status is a utility this code does not know rather than a failed
		// load, and its output is not an answer.
		Completion::Exited(0) => {},
		Completion::Exited(status) => return Err(report(format!("{named} exited with status {status}"))),
		Completion::Ended(how) => return Err(report(format!("{named} {how}"))),
	}
	validated_codeset(&answer).ok_or_else(|| {
		let shown = String::from_utf8_lossy(&answer[..answer.len().min(40)]).into_owned();
		report(format!("{named} reported {shown:?} where one codeset was due"))
	})
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
	match locale_utility_charmap_at(program, locale, &values, None) {
		Ok(codeset) => Codeset::Loaded(codeset),
		Err(Unanswered(why)) => Codeset::Unasked(why),
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

/// `posix_spawn` of the locale utility, in its own process group, with
/// `answer` as its standard output, its own `/dev/null` for the other two,
/// and `cwd` as its working directory when one is given.
///
/// The two `/dev/null`s are opened by the child, not here, which keeps this
/// process's cost at the one answer pipe — the whole margin the lookup has
/// under a descriptor limit that leaves two free.
#[cfg(unix)]
fn spawn_locale_utility(
	program: &std::ffi::CStr,
	argv: &[*mut std::ffi::c_char; 3],
	envp: &[*mut std::ffi::c_char],
	answer: std::os::fd::RawFd,
	cwd: Option<&std::ffi::CStr>,
) -> Result<libc::pid_t, std::io::Error> {
	let mut actions = std::mem::MaybeUninit::<libc::posix_spawn_file_actions_t>::uninit();
	let mut attributes = std::mem::MaybeUninit::<libc::posix_spawnattr_t>::uninit();
	let mut pid: libc::pid_t = 0;
	// SAFETY: every pointer names a value that outlives the call; the actions
	// and the attributes are initialised before use and destroyed on every
	// path out of the block; `answer` is a descriptor the caller owns for the
	// whole call, and it is duplicated onto the child's standard output before
	// anything else can take that number.
	let status = unsafe {
		let started = libc::posix_spawn_file_actions_init(actions.as_mut_ptr());
		if started != 0 {
			return Err(std::io::Error::from_raw_os_error(started));
		}
		let started = libc::posix_spawnattr_init(attributes.as_mut_ptr());
		if started != 0 {
			libc::posix_spawn_file_actions_destroy(actions.as_mut_ptr());
			return Err(std::io::Error::from_raw_os_error(started));
		}
		let actions = actions.as_mut_ptr();
		let attributes = attributes.as_mut_ptr();
		let mut status = libc::posix_spawn_file_actions_adddup2(actions, answer, 1);
		if status == 0 {
			status = libc::posix_spawn_file_actions_addopen(actions, 0, c"/dev/null".as_ptr(), libc::O_RDONLY, 0);
		}
		if status == 0 {
			status = libc::posix_spawn_file_actions_addopen(actions, 2, c"/dev/null".as_ptr(), libc::O_WRONLY, 0);
		}
		if status == 0 && let Some(cwd) = cwd {
			status = add_chdir(actions, cwd);
		}
		if status == 0 {
			status = libc::posix_spawnattr_setpgroup(attributes, 0);
		}
		if status == 0 {
			status = libc::posix_spawnattr_setflags(
				attributes,
				libc::c_short::try_from(libc::POSIX_SPAWN_SETPGROUP).unwrap_or_default(),
			);
		}
		if status == 0 {
			status =
				libc::posix_spawn(&raw mut pid, program.as_ptr(), actions, attributes, argv.as_ptr(), envp.as_ptr());
		}
		libc::posix_spawnattr_destroy(attributes);
		libc::posix_spawn_file_actions_destroy(actions);
		status
	};
	match status {
		0 => Ok(pid),
		status => Err(std::io::Error::from_raw_os_error(status)),
	}
}

/// Adds the child's `chdir` to a spawn's file actions.
///
/// # Safety
///
/// `actions` is an initialised file-action list and `cwd` outlives the spawn.
#[cfg(all(unix, not(target_os = "linux")))]
unsafe fn add_chdir(_actions: *mut libc::posix_spawn_file_actions_t, _cwd: &std::ffi::CStr) -> libc::c_int {
	// No portable file action does this, and nothing else here can put the
	// child in the shell's working directory, so the query is reported
	// rather than asked from a directory that is not the one in question.
	libc::ENOSYS
}

/// Adds the child's `chdir` to a spawn's file actions.
///
/// # Safety
///
/// `actions` is an initialised file-action list and `cwd` outlives the spawn.
#[cfg(target_os = "linux")]
unsafe fn add_chdir(actions: *mut libc::posix_spawn_file_actions_t, cwd: &std::ffi::CStr) -> libc::c_int {
	// SAFETY: the caller's contract.
	unsafe { libc::posix_spawn_file_actions_addchdir_np(actions, cwd.as_ptr()) }
}

/// How the locale utility stopped.
#[cfg(unix)]
enum Completion {
	/// It ended of its own accord, with this status.
	Exited(libc::c_int),
	/// It did not, in the words the caller reports.
	Ended(String),
}

/// Reaps the locale utility, bounded by the deadline the answer had: a child
/// that stops writing without exiting is killed rather than waited for, and
/// so is any descendant it left in its process group.
#[cfg(unix)]
fn reap_locale_utility(pid: libc::pid_t, deadline: std::time::Instant, kill_now: bool) -> Completion {
	let interrupted = || std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted;
	let mut killed = kill_now;
	let mut status: libc::c_int = 0;
	loop {
		if killed {
			// SAFETY: `pid` leads a process group of this scope's making,
			// which nothing else reaps, so the number cannot have been reused.
			unsafe { libc::kill(-pid, libc::SIGKILL) };
			loop {
				// SAFETY: as above, and a killed child is reapable at once.
				if unsafe { libc::waitpid(pid, &raw mut status, 0) } >= 0 || !interrupted() {
					break;
				}
			}
			return Completion::Ended("was ended before it finished".to_owned());
		}
		// SAFETY: as above.
		let reaped = unsafe { libc::waitpid(pid, &raw mut status, libc::WNOHANG) };
		if reaped == pid {
			let completion = completion_of(status);
			// The leader is gone; anything it left in the group is not an
			// answer and must not outlive the query. The group number is the
			// leader's, and the kernel keeps it while the group has members.
			// SAFETY: as above.
			unsafe { libc::kill(-pid, libc::SIGKILL) };
			return completion;
		}
		if reaped < 0 && !interrupted() {
			return Completion::Ended(format!("could not be waited for: {}", std::io::Error::last_os_error()));
		}
		killed = std::time::Instant::now() >= deadline;
		if !killed {
			std::thread::sleep(std::time::Duration::from_millis(1));
		}
	}
}

/// A reaped `wait` status, read the way [`Completion`] puts it.
#[cfg(unix)]
fn completion_of(status: libc::c_int) -> Completion {
	if libc::WIFEXITED(status) {
		return Completion::Exited(libc::WEXITSTATUS(status));
	}
	if libc::WIFSIGNALED(status) {
		return Completion::Ended(format!("ended on signal {}", libc::WTERMSIG(status)));
	}
	Completion::Ended(format!("ended with wait status {status}"))
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
