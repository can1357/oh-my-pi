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

/// The codeset `nl_langinfo(CODESET)` reports once `locale` is loaded for
/// `LC_CTYPE`, as a command the shell starts would see it.
///
/// `env` is the shell's environment and `child` its child-process settings
/// ([`ChildEnv`], which carries the shell's working directory).
///
/// **Why this cannot be a call in this process.** libc reads the locale
/// search path from the process environment and from nowhere else:
/// `newlocale` calls `getenv ("LOCPATH")` itself (glibc 2.39
/// `locale/newlocale.c`), and no entry point takes a search path as an
/// argument. Applying the shell's would mean `setenv`, a process-wide write
/// every other thread's `getenv` can read. Handing libc an absolute locale
/// *name* is no way around it either: `_nl_make_l10nflist` still prefixes
/// every search-path entry to the name, so an absolute name resolves only
/// through an entry that puts nothing before its leading `/` — the entry `/`
/// itself, or an empty entry, which is joined as `"" + "/" + name`.
/// `LOCPATH=/`, `LOCPATH=:` and `LOCPATH=/not-real:` all load one;
/// `LOCPATH=/not-real`, `LOCPATH=:/not-real` (argz drops the leading
/// separator) and an unset `LOCPATH` do not (measured on glibc 2.39).
/// Nor does libc "refuse only a `.` or a
/// `..` component": `valid_locale_name` (`locale/findlocale.c`) rejects a
/// name longer than 255 bytes, a `..` component, and any name that contains
/// a `/` without starting with one; a single-dot component passes that check
/// and then finds nothing, with `errno` untouched rather than set to
/// `EINVAL` (measured).
///
/// So a differing search path goes to a process whose environment this code
/// builds: the system's `locale` utility ([`codeset_from_locale_utility`]).
/// While the shell's search path resolves to the one this process carries,
/// no process is started at all and the answer comes from `newlocale` here.
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
	let shell = LOCALE_PATH_VARS
		.map(|name| env(name).filter(|value| !value.is_empty()).map(std::ffi::OsString::from));
	let ours = LOCALE_PATH_VARS.map(|name| std::env::var_os(name).filter(|value| !value.is_empty()));
	// The working directory is read only for a relative entry. Asking for it
	// otherwise would let a directory no process can enter decide the locale,
	// which it does not for the reference binary.
	let shell_cwd = match relative_entry_in(&shell) {
		true => child.and_then(|child| child.native_cwd().ok()),
		false => None,
	};
	let ours_cwd = match relative_entry_in(&ours) {
		true => std::env::current_dir().ok(),
		false => None,
	};
	let shell_path = resolved_search_path(&shell, shell_cwd);
	let ours_path = resolved_search_path(&ours, ours_cwd.as_deref());
	if shell.iter().zip(&shell_path).any(|(raw, resolved)| raw.is_some() && resolved.is_none()) {
		return Codeset::Unasked(
			"the shell's locale search path is relative to a working directory no process can name".to_owned(),
		);
	}
	if shell_path == ours_path {
		return loaded_codeset_here(locale);
	}
	codeset_from_locale_utility(locale, &shell_path)
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

/// Whether any entry of a search path is relative, and so resolves against
/// the working directory of whichever process libc runs in.
///
/// An empty entry is not one of those: glibc builds the list with
/// `argz_create_sep`, which drops a leading or repeated separator and keeps a
/// trailing one as an empty directory name, and an empty name prefixes the
/// locale with `/` — the root, not the working directory (measured:
/// `LOCPATH=/nonexistent:` reads `/<name>/LC_CTYPE`).
#[cfg(unix)]
fn relative_entry_in(path: &[Option<std::ffi::OsString>; 2]) -> bool {
	use std::os::unix::ffi::OsStrExt as _;

	path.iter().flatten().any(|value| {
		value.as_bytes().split(|&byte| byte == b':').any(|entry| !entry.is_empty() && entry[0] != b'/')
	})
}

/// A search path with every relative entry joined onto `cwd`, which is what a
/// child started there resolves it to.
///
/// Joining rather than `chdir`ing is what keeps one unusable entry from
/// deciding the whole lookup: a working directory without search permission,
/// or one already removed, cannot be entered, and the reference binary —
/// which is already in it — still answers from an absolute entry of the same
/// list (measured: `LOCPATH=missing:/…/latin` reports `ISO-8859-1` from a
/// directory with mode 0600). `None` for a variable whose every entry needed
/// a `cwd` there is none of.
#[cfg(unix)]
fn resolved_search_path(
	path: &[Option<std::ffi::OsString>; 2],
	cwd: Option<&std::path::Path>,
) -> [Option<std::ffi::OsString>; 2] {
	use std::os::unix::ffi::{OsStrExt as _, OsStringExt as _};

	path.clone().map(|value| {
		let value = value?;
		let mut resolved: Vec<u8> = Vec::with_capacity(value.len());
		let mut empty = true;
		for entry in value.as_bytes().split(|&byte| byte == b':') {
			let prefix = match entry.first() {
				None | Some(b'/') => None,
				Some(_) => Some(cwd?),
			};
			if !empty {
				resolved.push(b':');
			}
			empty = false;
			if let Some(prefix) = prefix {
				resolved.extend_from_slice(prefix.as_os_str().as_bytes());
				if resolved.last() != Some(&b'/') {
					resolved.push(b'/');
				}
			}
			resolved.extend_from_slice(entry);
		}
		(!empty).then(|| std::ffi::OsString::from_vec(resolved))
	})
}

/// Where the system's `locale` utility lives. Absolute and fixed: neither the
/// caller's `PATH` nor the shell's working directory — which a relative entry
/// of any `PATH` names for a child started there — may choose the program
/// that answers.
#[cfg(unix)]
const LOCALE_UTILITIES: [&str; 2] = ["/usr/bin/locale", "/bin/locale"];

/// How long that utility may take. A locale load is a handful of file reads,
/// so this bounds only the case where it cannot finish at all — a search-path
/// entry whose `LC_CTYPE` is a FIFO nobody writes to, say, which blocks the
/// reference binary for ever as well.
#[cfg(unix)]
const LOCALE_QUERY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// [`loaded_codeset`] as a process the shell starts would see it: the
/// system's `locale` utility, which reports `nl_langinfo(CODESET)` after
/// `setlocale(LC_CTYPE, "")` — the two calls rsync itself makes.
///
/// The utility is started with `posix_spawn`, so it runs in a fresh address
/// space: no lock copied out of a thread that held it, no restriction to
/// async-signal-safe calls, and no signal mask of ours for a timeout of the
/// child's to fall foul of. It is named by an absolute path and handed an
/// environment built here — the two locale search-path variables as the shell
/// set them, and `LC_CTYPE` — so no `PATH`, `LD_*` or `GCONV_*` of anyone
/// else's reaches it. Its standard input and error are its own `/dev/null`,
/// opened in the child by the spawn's file actions rather than here, which
/// keeps this process's cost at the single answer pipe.
#[cfg(unix)]
fn codeset_from_locale_utility(locale: &str, path: &[Option<std::ffi::OsString>; 2]) -> Codeset {
	match locale_utility_charmap(locale, path) {
		Ok(codeset) => Codeset::Loaded(codeset),
		Err(why) => Codeset::Unasked(why),
	}
}

/// The body of [`codeset_from_locale_utility`]: the codeset, or why it could
/// not be read.
#[cfg(unix)]
fn locale_utility_charmap(locale: &str, path: &[Option<std::ffi::OsString>; 2]) -> Result<String, String> {
	use std::io::Read as _;
	use std::os::fd::AsRawFd as _;
	use std::os::unix::ffi::OsStrExt as _;

	let Some(program) =
		LOCALE_UTILITIES.iter().copied().find(|at| std::fs::metadata(at).is_ok_and(|meta| meta.is_file()))
	else {
		return Err(format!("there is no locale utility at {} or {}", LOCALE_UTILITIES[0], LOCALE_UTILITIES[1]));
	};
	let text = |bytes: &[u8]| {
		std::ffi::CString::new(bytes).map_err(|_| "the locale name or search path contains a NUL byte".to_owned())
	};
	let program_c = text(program.as_bytes())?;
	let argv0 = text(b"locale")?;
	let argv1 = text(b"charmap")?;
	// `locale` sets only `LC_CTYPE` and `LC_MESSAGES` from the environment
	// (glibc `locale/programs/locale.c`), so naming the category directly asks
	// exactly what rsync's `setlocale(LC_CTYPE, "")` asks, and a locale whose
	// other categories are missing cannot drag the answer down to C.
	let mut vars = vec![text(format!("LC_CTYPE={locale}").as_bytes())?];
	for (name, value) in LOCALE_PATH_VARS.iter().zip(path) {
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
	let (mut reader, writer) =
		std::io::pipe().map_err(|err| format!("no pipe for the locale utility's answer: {err}"))?;
	let pid = spawn_locale_utility(&program_c, &argv, &envp, writer.as_raw_fd())
		.map_err(|err| format!("{program} could not be started: {err}"))?;
	// The write end is the child's now; holding it here would keep the read
	// below from ever seeing the end of the answer.
	drop(writer);

	let deadline = std::time::Instant::now() + LOCALE_QUERY_TIMEOUT;
	let mut answer = Vec::new();
	let mut timed_out = false;
	while answer.len() < 1024 {
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
			if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
				continue;
			}
			break;
		}
		let mut buffer = [0u8; 128];
		match reader.read(&mut buffer) {
			Ok(0) => break,
			Ok(read) => answer.extend_from_slice(&buffer[..read]),
			Err(err) if err.kind() == std::io::ErrorKind::Interrupted => {},
			Err(_) => break,
		}
	}
	reap_locale_utility(pid, deadline, timed_out);
	if timed_out {
		return Err(format!("{program} did not answer within {}s", LOCALE_QUERY_TIMEOUT.as_secs()));
	}
	// The utility writes the codeset, and nothing else, on its standard
	// output; a name libc cannot load leaves the C locale and it writes that
	// locale's `ANSI_X3.4-1968`, which is the answer the reference binary gets
	// there too. Its exit status is 1 when it could not set the locale, so the
	// output decides and the status does not.
	let printed = String::from_utf8_lossy(&answer);
	match printed.lines().map(str::trim).find(|line| !line.is_empty()) {
		Some(codeset) => Ok(codeset.to_owned()),
		None => Err(format!("{program} reported no codeset")),
	}
}

/// `posix_spawn` of the locale utility with `answer` as its standard output
/// and its own `/dev/null` for the other two.
#[cfg(unix)]
fn spawn_locale_utility(
	program: &std::ffi::CStr,
	argv: &[*mut std::ffi::c_char; 3],
	envp: &[*mut std::ffi::c_char],
	answer: std::os::fd::RawFd,
) -> Result<libc::pid_t, std::io::Error> {
	let mut actions = std::mem::MaybeUninit::<libc::posix_spawn_file_actions_t>::uninit();
	let mut pid: libc::pid_t = 0;
	// SAFETY: every pointer names a value that outlives the call; `actions` is
	// initialised before it is used and destroyed on every path out of the
	// block; `answer` is a descriptor the caller owns for the whole call. The
	// pipe's own descriptors are close-on-exec, so the child keeps nothing but
	// the three standard ones.
	let status = unsafe {
		let started = libc::posix_spawn_file_actions_init(actions.as_mut_ptr());
		if started != 0 {
			return Err(std::io::Error::from_raw_os_error(started));
		}
		let actions = actions.as_mut_ptr();
		let mut status =
			libc::posix_spawn_file_actions_addopen(actions, 0, c"/dev/null".as_ptr(), libc::O_RDONLY, 0);
		if status == 0 {
			status = libc::posix_spawn_file_actions_addopen(actions, 2, c"/dev/null".as_ptr(), libc::O_WRONLY, 0);
		}
		if status == 0 {
			status = libc::posix_spawn_file_actions_adddup2(actions, answer, 1);
		}
		if status == 0 {
			status = libc::posix_spawn(
				&raw mut pid,
				program.as_ptr(),
				actions,
				std::ptr::null(),
				argv.as_ptr(),
				envp.as_ptr(),
			);
		}
		libc::posix_spawn_file_actions_destroy(actions);
		status
	};
	match status {
		0 => Ok(pid),
		status => Err(std::io::Error::from_raw_os_error(status)),
	}
}

/// Reaps the locale utility, bounded by the deadline the answer had: a child
/// that stops writing without exiting is killed rather than waited for.
#[cfg(unix)]
fn reap_locale_utility(pid: libc::pid_t, deadline: std::time::Instant, kill_now: bool) {
	let mut killed = kill_now;
	loop {
		if killed {
			// SAFETY: `pid` names this scope's child, which nothing else
			// reaps, so the number cannot have been reused.
			unsafe { libc::kill(pid, libc::SIGKILL) };
			// SAFETY: as above, and a killed child is reapable at once.
			unsafe { libc::waitpid(pid, std::ptr::null_mut(), 0) };
			return;
		}
		// SAFETY: as above.
		let reaped = unsafe { libc::waitpid(pid, std::ptr::null_mut(), libc::WNOHANG) };
		let interrupted =
			reaped < 0 && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted;
		if reaped != 0 && !interrupted {
			return;
		}
		killed = std::time::Instant::now() >= deadline;
		if !killed {
			std::thread::sleep(std::time::Duration::from_millis(1));
		}
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
