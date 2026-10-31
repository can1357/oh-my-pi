//! End-to-end runs of the builtin: local copies (both halves in-process),
//! transfers against the reference `rsync --server` through a fake remote
//! shell, batch round trips, and the option outcomes.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::*;
use crate::host::{run_util, run_util_env};
use crate::rsync::Rsync;

fn run(argv: &[&str], cwd: &Path) -> (i32, String, String) {
	let (code, cap) = run_util::<Rsync>(argv, "", cwd);
	(code, cap.out(), cap.err())
}

/// The reference rsync 3.x binary, when one is installed.
fn reference() -> Option<PathBuf> {
	let mut candidates = vec![PathBuf::from("/opt/homebrew/bin/rsync")];
	if let Some(path) = std::env::var_os("PATH") {
		candidates.extend(std::env::split_paths(&path).map(|d| d.join("rsync")));
	}
	candidates.into_iter().find(|p| {
		Command::new(p)
			.arg("--version")
			.output()
			.is_ok_and(|o| String::from_utf8_lossy(&o.stdout).starts_with("rsync  version 3."))
	})
}

/// A small tree: a file, a nested file, and (unix) a symlink.
fn make_tree(root: &Path) {
	fs::create_dir_all(root.join("sub")).unwrap();
	fs::write(root.join("a"), b"hello\n").unwrap();
	fs::write(root.join("sub/b"), b"x\n").unwrap();
	fs::write(root.join("big"), (0..200_000u32).flat_map(|i| i.to_le_bytes()).collect::<Vec<u8>>()).unwrap();
	#[cfg(unix)]
	std::os::unix::fs::symlink("a", root.join("link")).unwrap();
}

/// Asserts `b` mirrors `a` (contents, symlink targets, and mtimes of files).
fn assert_same_tree(a: &Path, b: &Path) {
	let mut names: Vec<_> = fs::read_dir(a).unwrap().map(|e| e.unwrap().file_name()).collect();
	names.sort();
	let mut other: Vec<_> = fs::read_dir(b).unwrap().map(|e| e.unwrap().file_name()).collect();
	other.sort();
	assert_eq!(names, other, "entries of {}", b.display());
	for name in names {
		let (pa, pb) = (a.join(&name), b.join(&name));
		let ma = fs::symlink_metadata(&pa).unwrap();
		let mb = fs::symlink_metadata(&pb).unwrap();
		assert_eq!(ma.file_type().is_dir(), mb.file_type().is_dir(), "{}", pb.display());
		if ma.file_type().is_symlink() {
			assert_eq!(fs::read_link(&pa).unwrap(), fs::read_link(&pb).unwrap());
		} else if ma.is_dir() {
			assert_same_tree(&pa, &pb);
		} else {
			assert_eq!(fs::read(&pa).unwrap(), fs::read(&pb).unwrap(), "{}", pb.display());
		}
	}
}

fn mtime(p: &Path) -> std::time::SystemTime {
	fs::metadata(p).unwrap().modified().unwrap()
}

/// The physical path of `dir`, resolved like `realpath`: `fs::canonicalize`
/// spells Windows paths `\\?\…`, where `/` is not a separator.
fn physical(dir: &Path) -> PathBuf {
	pi_vfs::BlockingFs::native().canonicalize_with(dir, &pi_vfs::CanonicalizeOptions::default()).unwrap()
}

#[test]
fn version_and_help_go_to_stdout() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(&["--version"], dir.path());
	assert_eq!(code, 0);
	assert!(out.starts_with("rsync  version 3.5.1  protocol version 33\n"), "{out}");
	assert_eq!(err, "");
	let (code, out, _) = run(&["--help"], dir.path());
	assert_eq!(code, 0);
	assert!(out.contains("Usage: rsync [OPTION]... SRC [SRC]... DEST"), "{out}");
}

/// Captured from rsync 3.5.1: no arguments prints the usage to stderr.
#[test]
fn no_arguments_is_a_usage_error() {
	let dir = tempfile::tempdir().unwrap();
	let (code, out, err) = run(&[], dir.path());
	assert_eq!(code, 1);
	assert_eq!(out, "");
	assert!(err.ends_with("rsync error: syntax or usage error (code 1) at main.c(1898) [client=3.5.1]\n"), "{err}");
}

#[test]
fn daemon_mode_is_refused() {
	let dir = tempfile::tempdir().unwrap();
	let (code, _, err) = run(&["--daemon"], dir.path());
	assert_eq!(code, 4);
	assert!(err.starts_with("rsync: --daemon is not supported by this rsync\n"), "{err}");
	assert!(err.contains("(code 4) at main.c(1954)"), "{err}");
}

/// Captured from rsync 3.5.1 with `env -i LC_ALL=… rsync … --bogus-ün src dst`:
/// the option error is written before the locale charset is set up, so it is
/// escaped by printability in the C locale *and* in a UTF-8 one, and only the
/// `-8` the parser already saw prints the bytes.
#[test]
fn option_errors_escape_unless_8_bit_output_was_parsed() {
	let dir = tempfile::tempdir().unwrap();
	let escaped = "rsync: --bogus-\\#303\\#274n: unknown option\n";
	for locale in ["C", "C.UTF-8"] {
		let (code, cap) =
			run_util_env::<Rsync>(&["--bogus-ün", "src/", "dst/"], "", dir.path(), &[("LC_ALL", locale)]);
		assert_eq!(code, 1);
		assert!(cap.err().starts_with(escaped), "{locale}: {}", cap.err());
	}
	let (code, cap) = run_util_env::<Rsync>(
		&["-8", "--bogus-ün", "src/", "dst/"],
		"",
		dir.path(),
		&[("LC_ALL", "C")],
	);
	assert_eq!(code, 1);
	assert!(cap.err().starts_with("rsync: --bogus-ün: unknown option\n"), "{}", cap.err());
}

/// A locale name no installed locale archive can answer for, so only the
/// directory the test generates can supply it.
#[cfg(target_os = "linux")]
const SHELL_ONLY_LOCALE: &str = "omp_rsync_latin1";

/// An ISO-8859-1 locale under `<dir>/locales/<SHELL_ONLY_LOCALE>`, built with
/// `localedef`. ISO-8859-1 represents every byte, so rsync 3.5.1 under it
/// prints a non-ASCII name's bytes (measured: `env -i LOCPATH=… LC_ALL=…
/// rsync -ai "src/ünï.txt" dst/` prints them) where the C locale escapes
/// them. `None` on a host without locale sources, which cannot host the
/// scenario at all.
#[cfg(target_os = "linux")]
fn shell_only_locale(dir: &Path) -> Option<PathBuf> {
	let locales = dir.join("locales");
	fs::create_dir_all(locales.join(SHELL_ONLY_LOCALE)).unwrap();
	let built = Command::new("localedef")
		.args(["-i", "en_US", "-f", "ISO-8859-1"])
		.arg(locales.join(SHELL_ONLY_LOCALE))
		.output();
	fs::create_dir_all(dir.join("src")).unwrap();
	fs::write(dir.join("src/ünï.txt"), b"x\n").unwrap();
	built.is_ok_and(|built| built.status.success()).then_some(locales)
}

/// A locale only the shell knows about, reachable through `LOCPATH`, which
/// libc reads from the process environment the builtin does not share with its
/// shell: the builtin must print the name's bytes rather than fall back to the
/// C locale's escaping.
#[cfg(target_os = "linux")]
#[test]
fn a_locale_only_the_shell_exports_is_honoured() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	// Absolute, then relative: a relative entry resolves against the *shell's*
	// working directory (`cd /tmp/job; LOCPATH=locales rsync …`), which is this
	// run's `cwd` and not the one the test process sits in.
	for path in [locales.to_str().unwrap(), "locales"] {
		let dest = format!("dst-{}/", path.replace('/', "_"));
		let env = [("LC_ALL", SHELL_ONLY_LOCALE), ("LOCPATH", path)];
		let (code, cap) = run_util_env::<Rsync>(&["-ai", "src/ünï.txt", &dest], "", dir.path(), &env);
		assert_eq!(code, 0, "{path}: {}", cap.err());
		assert!(cap.out().contains("ünï.txt"), "{path}: {}", cap.out());
	}
	// One relative entry is enough, wherever it sits in the list — and the list
	// has to be the one this process carries too, or it already differs from
	// ours for another reason. nextest runs each test in its own process, so
	// this environment belongs to this test alone.
	let shared = "/nonexistent-locales:locales";
	// SAFETY: nextest gives this test its own process, and nothing else in it
	// reads `LOCPATH` concurrently.
	unsafe { std::env::set_var("LOCPATH", shared) };
	let env = [("LC_ALL", SHELL_ONLY_LOCALE), ("LOCPATH", shared)];
	let (code, cap) = run_util_env::<Rsync>(&["-ai", "src/ünï.txt", "dst-list/"], "", dir.path(), &env);
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
	assert_eq!(code, 0, "{shared}: {}", cap.err());
	assert!(cap.out().contains("ünï.txt"), "{shared}: {}", cap.out());
	// The shell's `PATH` decides nothing: the codeset comes from libc, not from
	// a command the shell's search path selects.
	let env = [("LC_ALL", SHELL_ONLY_LOCALE), ("LOCPATH", "locales"), ("PATH", "/nonexistent")];
	let (code, cap) = run_util_env::<Rsync>(&["-ai", "src/ünï.txt", "dst-nopath/"], "", dir.path(), &env);
	assert_eq!(code, 0, "restricted PATH: {}", cap.err());
	assert!(cap.out().contains("ünï.txt"), "restricted PATH: {}", cap.out());
}

/// The shell's working directory holds the files of whoever ran `cd`, so
/// nothing in it may be executed to settle the locale — not even through a
/// relative entry of this process's own `PATH`, which names that directory
/// for a child started there.
#[cfg(target_os = "linux")]
#[test]
fn nothing_in_the_shells_directory_runs_for_the_locale() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	// A `locale` command the shell's working directory supplies: it records
	// that it ran, and answers with the C locale's charset, which escapes the
	// name the real locale prints.
	let ran = dir.path().join("ran");
	let rogue = dir.path().join("locale");
	fs::write(&rogue, format!("#!/bin/sh\n: > '{}'\necho ANSI_X3.4-1968\n", ran.display())).unwrap();
	fs::set_permissions(&rogue, fs::Permissions::from_mode(0o755)).unwrap();
	let path = format!(".:{}", std::env::var("PATH").unwrap_or_default());
	// SAFETY: nextest gives this test its own process, and nothing else in it
	// reads `PATH` concurrently.
	unsafe { std::env::set_var("PATH", &path) };
	let env = [("LC_ALL", SHELL_ONLY_LOCALE), ("LOCPATH", locales.to_str().unwrap())];
	let (code, cap) = run_util_env::<Rsync>(&["-ai", "src/ünï.txt", "dst/"], "", dir.path(), &env);
	assert_eq!(code, 0, "{}", cap.err());
	assert!(!ran.exists(), "a program in the shell's directory ran: {}", cap.out());
	assert!(cap.out().contains("ünï.txt"), "{}", cap.out());
}

/// No `PATH` of anyone's decides the codeset — the program that answers is
/// named by an absolute path — and this process's own locale search path is
/// a different question from the shell's. Measured on rsync 3.5.1 under `env
/// -i LOCPATH=/nonexistent LC_ALL=… rsync -ai src/ünï.txt dst/`: `>f+++++++++
/// \#303\#274n\#303\#257.txt`, the C locale's escaping.
#[cfg(target_os = "linux")]
#[test]
fn no_search_path_but_the_shells_own_answers() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let empty = dir.path().join("empty-bin");
	fs::create_dir_all(&empty).unwrap();
	// SAFETY: nextest gives this test its own process, and nothing else in it
	// reads `PATH` or `LOCPATH` concurrently.
	unsafe { std::env::set_var("PATH", &empty) };
	let env = [("LC_ALL", SHELL_ONLY_LOCALE), ("LOCPATH", locales.to_str().unwrap())];
	let (code, cap) = run_util_env::<Rsync>(&["-ai", "src/ünï.txt", "dst/"], "", dir.path(), &env);
	assert_eq!(code, 0, "{}", cap.err());
	assert!(cap.out().contains("ünï.txt"), "{}", cap.out());
	// And the other way round: this process's search path finds the locale,
	// the shell's does not, so the C locale is the answer.
	// SAFETY: as above.
	unsafe { std::env::set_var("LOCPATH", &locales) };
	let env = [("LC_ALL", SHELL_ONLY_LOCALE), ("LOCPATH", "/nonexistent-locales")];
	let (code, cap) = run_util_env::<Rsync>(&["-ai", "src/ünï.txt", "dst-host/"], "", dir.path(), &env);
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
	assert_eq!(code, 0, "{}", cap.err());
	assert!(cap.out().contains("\\#303\\#274n\\#303\\#257.txt"), "{}", cap.out());
}

/// A working directory the child cannot be put into ends the query.
///
/// The error says nothing about what the reference resolves from a
/// directory it is already inside: `EACCES` can come from an ancestor the
/// reference never traverses, and `ENOENT` or `ENOTDIR` can mean the
/// directory was renamed rather than removed. Measured on the gate VM, the
/// reference answers `ISO-8859-1` in the ancestor and renamed cases and
/// `ANSI_X3.4-1968` in the archive one, and this cannot reproduce any of
/// them — so each is reported rather than answered from a question that was
/// changed to make it answerable.
///
/// The `unsearchable` row is the one that changed on purpose: an earlier
/// revision answered `ISO-8859-1` there, which is what the reference
/// answers, by dropping the relative entry. That agreement was luck — the
/// reference is inside a directory no process can enter — and the same
/// reasoning answered wrongly in every other row here.
#[cfg(target_os = "linux")]
#[test]
fn a_working_directory_the_child_cannot_enter_is_reported() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let mixed = format!("missing:{}", locales.display());
	let listed = format!("locales:{}", locales.display());
	let open = |at: &Path| fs::set_permissions(at, fs::Permissions::from_mode(0o755)).unwrap();
	let shut = |at: &Path| fs::set_permissions(at, fs::Permissions::from_mode(0o600)).unwrap();
	// Each case is a working directory and the search path the shell set in
	// it. The last is the one that used to come back from glibc's locale
	// archive, which an emptied `LOCPATH` turns back on: `en_US.utf8` is
	// installed, and the reference in that directory still reports the C
	// locale because its own `LOCPATH` names nothing it can read.
	let cases: [(&str, &str, &str); 5] = [
		("unsearchable", SHELL_ONLY_LOCALE, &mixed),
		("removed", SHELL_ONLY_LOCALE, &mixed),
		("ancestor/child", SHELL_ONLY_LOCALE, "locales"),
		("renamed", SHELL_ONLY_LOCALE, &listed),
		("archive", "en_US.utf8", "missing"),
	];
	for (at, locale, path) in cases {
		let cwd = dir.path().join(at);
		fs::create_dir_all(&cwd).unwrap();
		std::os::unix::fs::symlink(&locales, cwd.join("locales")).unwrap();
		// The shell is already in the directory; what no process can do is
		// enter it again, which is what putting a child there asks.
		let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
		let child = host.child_env();
		match at {
			"removed" => fs::remove_dir_all(&cwd).unwrap(),
			"ancestor/child" => shut(&dir.path().join("ancestor")),
			"renamed" => {
				fs::rename(&cwd, dir.path().join("renamed-away")).unwrap();
				fs::write(&cwd, b"not a directory\n").unwrap();
			},
			_ => shut(&cwd),
		}
		let env = |key: &str| (key == "LOCPATH").then(|| path.to_owned());
		let answer = crate::locale::loaded_codeset(locale, &env, Some(&child));
		match at {
			"removed" | "renamed" => {},
			"ancestor/child" => open(&dir.path().join("ancestor")),
			_ => open(&cwd),
		}
		assert!(matches!(&answer, crate::locale::Codeset::Unasked(_)), "{at}: {answer:?}");
	}
}

/// A working directory the child cannot be put into does not stop an answer
/// that never needed one.
///
/// `PATH_LOCALE` is the BSDs' variable, and no libc that runs on Linux
/// reads it, so a relative value there asks for no directory at all: the
/// lookup goes ahead and agrees with the reference.
///
/// A search path whose absolute entries come before its relative ones does
/// *not* get the same treatment, and the second half of this test holds
/// that line. Cutting the list at its first relative entry looked
/// order-preserving and is not: glibc tries each *name* candidate across
/// every directory before the next candidate (`intl/l10nflist.c`), so a
/// prefix can answer from fallback data where the whole list would have
/// found an exact match further along — measured for `astra@special`,
/// where the reference inside the directory chose UTF-8 and the prefix
/// chose Latin-1. A trailing cut can also invent a source: `/nonexistent::missing`
/// cut to `/nonexistent:` ends in an empty entry, which is the root.
#[cfg(target_os = "linux")]
#[test]
fn an_answer_that_needs_no_working_directory_is_still_given() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let absolute = locales.display().to_string();
	let cwd = dir.path().join("unsearchable");
	fs::create_dir_all(&cwd).unwrap();
	let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
	let child = host.child_env();
	fs::set_permissions(&cwd, fs::Permissions::from_mode(0o600)).unwrap();
	let free = |key: &str| match key {
		"LOCPATH" => Some(absolute.clone()),
		"PATH_LOCALE" => Some("relative-locales".to_owned()),
		_ => None,
	};
	let answered = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &free, Some(&child));
	// A list that starts absolute still needs the directory, because a
	// later entry can hold the better name candidate.
	let mixed = format!("{absolute}:missing");
	let bound = |key: &str| (key == "LOCPATH").then(|| mixed.clone());
	let reported = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &bound, Some(&child));
	fs::set_permissions(&cwd, fs::Permissions::from_mode(0o755)).unwrap();
	assert!(
		matches!(&answered, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"),
		"{answered:?}"
	);
	assert!(matches!(&reported, crate::locale::Codeset::Unasked(_)), "{reported:?}");
}

/// A process that has the kernel reap its children cannot hold the
/// utility's number, so no query is started there.
///
/// With `SIGCHLD` ignored or `SA_NOCLDWAIT` set the leader is reaped the
/// moment it exits: `waitid` then says `ECHILD`, the number is back in
/// circulation, and `kill(-pid, SIGKILL)` reaches whatever took it — an
/// unrelated process, three times out of three in a private PID namespace,
/// under each disposition. The lookup reports instead, and nothing it did
/// can have signalled anyone.
#[cfg(target_os = "linux")]
#[test]
fn a_process_whose_children_are_reaped_for_it_asks_nothing() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	// The same query answers under the ordinary disposition, so what the
	// second half measures is the disposition and nothing else.
	let ordinary = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	// SAFETY: nextest gives this test its own process, which starts no other
	// child; the disposition is put back below.
	let kept = unsafe { libc::signal(libc::SIGCHLD, libc::SIG_IGN) };
	let reaped_for_us = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGCHLD, kept) };
	assert!(
		matches!(&ordinary, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"),
		"{ordinary:?}"
	);
	let crate::locale::Codeset::Unasked(why) = &reaped_for_us else {
		panic!("{reaped_for_us:?}");
	};
	assert!(why.contains("reap its children"), "{why}");
}

/// A loadability answer needs a whole reply, not only silence.
///
/// A utility that exits 0 writing nothing, and one that floods its output
/// with no diagnostic at all, both pass the quiet test and have reported
/// nothing — and both used to affirm that a locale with no data anywhere
/// loads.
#[cfg(target_os = "linux")]
#[test]
fn a_silent_or_flooding_utility_affirms_nothing() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let cases: [(&str, &str, bool); 3] = [
		("quiet", "printf 'ISO-8859-1\\n'\n", true),
		("silent", "exit 0\n", false),
		("flood", "dd if=/dev/zero bs=1024 count=200 2>/dev/null | tr '\\\\0' 'X'\n", false),
	];
	for (name, body, accepts) in cases {
		let program = dir.path().join(name);
		fs::write(&program, format!("#!/bin/sh\n{body}")).unwrap();
		fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
		let answer = crate::locale::utility_accepts_for_test(&program, "de_DE@absent;bogus");
		match (&answer, accepts) {
			(crate::locale::Loadable::Yes, true) | (crate::locale::Loadable::Unasked(_), false) => {},
			_ => panic!("{name}: {}", matches!(answer, crate::locale::Loadable::No)),
		}
	}
}

/// A query libc could not be asked is not an observation of the C locale.
///
/// Under `SIGCHLD=SIG_IGN` no query runs at all, and reading that refusal
/// as "not a UTF-8 locale" put a newline inside `é`: GNU `fold -w1` on
/// `LC_ALL=C.UTF-8` gives `c3 a9`, and so must this.
#[cfg(target_os = "linux")]
#[test]
fn a_refused_query_falls_back_to_the_name_and_says_so() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let (host, capture) = crate::host::Host::for_test("fold", "", dir.path());
	let mut host = host;
	host.set_test_var("LC_ALL", "C.UTF-8");
	host.set_test_var("LOCPATH", locales.to_str().unwrap());
	// SAFETY: nextest gives this test its own process, which starts no other
	// child; the disposition is put back below.
	let kept = unsafe { libc::signal(libc::SIGCHLD, libc::SIG_IGN) };
	let utf8 = crate::locale::ctype_is_utf8(&host);
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGCHLD, kept) };
	assert!(utf8, "a refusal is not an observation of the C locale");
	assert!(
		String::from_utf8_lossy(&capture.stderr()).contains("cannot read the locale"),
		"{}",
		String::from_utf8_lossy(&capture.stderr())
	);
}

/// GNU utilities initialise with `setlocale(LC_ALL, "")`, which fails as a
/// whole when one category's data is missing — and then they run in C.
///
/// Measured against GNU fold 9.12 and sort 9.4: with `LC_ALL` naming a
/// locale that holds only `LC_CTYPE`, `fold -w1` splits `é`; with one that
/// holds only `LC_NUMERIC`, `sort -sn` uses the C decimal point.
#[cfg(target_os = "linux")]
#[test]
fn a_locale_missing_a_category_leaves_the_utilities_in_c() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let partial = |name: &str, keep: &str| {
		let built = Command::new("localedef")
			.args(["-i", "de_DE", "-f", "UTF-8"])
			.arg(locales.join(name))
			.output()
			.is_ok_and(|built| built.status.success());
		if !built {
			return false;
		}
		for left in fs::read_dir(locales.join(name)).unwrap() {
			let left = left.unwrap();
			if left.file_name() == keep {
				continue;
			}
			match left.file_type().unwrap().is_dir() {
				true => fs::remove_dir_all(left.path()).unwrap(),
				false => fs::remove_file(left.path()).unwrap(),
			}
		}
		true
	};
	if !partial("de_DE@partial;ctype", "LC_CTYPE") || !partial("de_DE@partial;numeric", "LC_NUMERIC") {
		return;
	}
	let shell = |name: &str| {
		let (host, _) = crate::host::Host::for_test("fold", "", dir.path());
		let mut host = host;
		host.set_test_var("LC_ALL", name);
		host.set_test_var("LOCPATH", locales.to_str().unwrap());
		host
	};
	let ctype = shell("de_DE@partial;ctype");
	assert!(!crate::locale::ctype_is_utf8(&ctype), "a locale with no LC_NUMERIC leaves fold in C");
	let numeric = shell("de_DE@partial;numeric");
	assert_eq!(
		crate::locale::numeric_symbols(&numeric),
		crate::locale::NumericSymbols::C,
		"a locale with no LC_CTYPE leaves sort in C"
	);
	// The control: the same generation with every category kept does
	// initialise, and its numerics are the locale's.
	let whole = "de_DE@whole;valid";
	let built = Command::new("localedef")
		.args(["-i", "de_DE", "-f", "UTF-8"])
		.arg(locales.join(whole))
		.output()
		.is_ok_and(|built| built.status.success());
	if built {
		assert_ne!(crate::locale::numeric_symbols(&shell(whole)), crate::locale::NumericSymbols::C, "{whole}");
	}
}

/// Another reaper in this process must not turn the query into a signal
/// aimed at whoever took the utility's number.
///
/// The query holds the child by a handle rather than by number, so a
/// competing `waitpid(-1)` can take the child away from it — the query then
/// reports — but nothing it does afterwards reaches a recycled number.
#[cfg(target_os = "linux")]
#[test]
fn a_competing_reaper_does_not_turn_the_query_into_a_stray_signal() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
	let reaper = {
		let stop = std::sync::Arc::clone(&stop);
		std::thread::spawn(move || {
			while !stop.load(std::sync::atomic::Ordering::Relaxed) {
				// SAFETY: a non-blocking wait for any child of this process.
				unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) };
			}
		})
	};
	let answers: Vec<_> =
		(0..20).map(|_| crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None)).collect();
	stop.store(true, std::sync::atomic::Ordering::Relaxed);
	reaper.join().unwrap();
	for answer in &answers {
		assert!(
			matches!(answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1")
				|| matches!(answer, crate::locale::Codeset::Unasked(_)),
			"{answer:?}"
		);
	}
	// Nothing is left for the kernel to carry: every query either reaped
	// its own child or never started one. The children of *every* task,
	// because the query ran on a worker and `/proc/self/task/<pid>` is the
	// main thread's; and a list that cannot be read is a failure here, not
	// an empty one.
	let tasks = fs::read_dir("/proc/self/task").expect("this process's task list");
	for task in tasks {
		let task = task.expect("a task of this process");
		let left = fs::read_to_string(task.path().join("children")).expect("a task's children");
		assert!(left.trim().is_empty(), "children left behind by {:?}: {left}", task.file_name());
	}
}

/// Every caller of [`crate::locale::locale_loadable`] models
/// `setlocale(CATEGORY, "")`, which takes a name whole where `newlocale`
/// splits one carrying a `;` per category — and asks about the category it
/// was given, which a codeset cannot report on.
///
/// Measured: with no data named `LC_CTYPE=C;LC_TIME=C.UTF-8` the reference
/// reports `ANSI_X3.4-1968` and `fold -w1` splits the two bytes of `é`,
/// while `newlocale` loads that name and its `.UTF-8` tail reads as a UTF-8
/// locale; data literally named `astra;latin` loads as Latin-1 for the
/// reference while `newlocale` refuses it; and a German locale generated
/// against the ASCII charmap loads with a decimal comma while its codeset
/// is the C locale's, so reading loadability off `charmap` called its
/// numerics absent.
#[cfg(target_os = "linux")]
#[test]
fn a_composite_looking_name_is_loadable_only_as_the_reference_loads_it() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let mut copy = Command::new("cp");
	copy.arg("-a").arg(locales.join(SHELL_ONLY_LOCALE)).arg(locales.join("astra;latin"));
	assert!(copy.output().unwrap().status.success());
	// A locale whose charset is the C locale's but whose numerics are not.
	let ascii = "de_DE@ascii;valid";
	let built = Command::new("localedef")
		.args(["-i", "de_DE", "-f", "ANSI_X3.4-1968"])
		.arg(locales.join(ascii))
		.output()
		.is_ok_and(|built| built.status.success());
	// SAFETY: nextest gives this test its own process, and nothing else in
	// it reads `LOCPATH` concurrently.
	unsafe { std::env::set_var("LOCPATH", &locales) };
	let absent = crate::locale::locale_loadable("LC_CTYPE=C;LC_TIME=C.UTF-8", libc::LC_CTYPE_MASK);
	let present = crate::locale::locale_loadable("astra;latin", libc::LC_CTYPE_MASK);
	let numerics = built.then(|| crate::locale::locale_loadable(ascii, libc::LC_NUMERIC_MASK));
	let (utf8, _) = crate::host::Host::for_test("rsync", "", dir.path());
	let mut utf8 = utf8;
	utf8.set_test_var("LC_CTYPE", "LC_CTYPE=C;LC_TIME=C.UTF-8");
	let reads_as_utf8 = crate::locale::ctype_is_utf8(&utf8);
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
	assert!(!absent, "a name with no data of its own is not loadable");
	assert!(present, "data literally named with a semicolon is loadable");
	assert_ne!(numerics, Some(false), "an ASCII-charset locale still has its own numerics");
	assert!(!reads_as_utf8, "a name that loads nothing is not a UTF-8 locale");
}

/// A lock another thread of this process holds must not reach the lookup.
///
/// glibc takes one lock for every locale load, and a lookup that forks
/// inherits it held by a thread the child does not have: the child then
/// waits for it for ever. With `SIGALRM` blocked in the calling thread — as
/// it is inside that signal's own handler — the child inherits the mask too,
/// so even an alarm it set for itself cannot end the wait. Nothing here
/// loads a locale in this process or in a copy of it, so the lock is not
/// this lookup's business at all.
#[cfg(target_os = "linux")]
#[test]
fn a_locale_lock_another_thread_holds_does_not_reach_the_lookup() {
	use std::sync::mpsc;
	use std::time::Duration;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	// A locale whose `LC_CTYPE` is a FIFO nobody writes to: the thread that
	// loads it blocks in `open` with glibc's locale lock held.
	let blocking = dir.path().join("blocking");
	fs::create_dir_all(blocking.join("omp_rsync_fifo")).unwrap();
	let fifo = blocking.join("omp_rsync_fifo/LC_CTYPE");
	nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
	// SAFETY: nextest gives this test its own process, and nothing else in it
	// reads `LOCPATH` concurrently. libc reads it from the process
	// environment, so this is the only way to aim the holding thread at the
	// FIFO.
	unsafe { std::env::set_var("LOCPATH", &blocking) };
	std::thread::spawn(|| {
		// SAFETY: a valid NUL-terminated name; the call blocks and the handle,
		// if it ever returns one, is leaked with the thread.
		unsafe { libc::newlocale(libc::LC_CTYPE_MASK, c"omp_rsync_fifo".as_ptr(), std::ptr::null_mut()) };
	});
	// The lock is taken inside `newlocale`; give the thread time to reach it.
	std::thread::sleep(Duration::from_millis(300));

	let (answered, answer) = mpsc::channel();
	let shell_path = locales.to_str().unwrap().to_owned();
	std::thread::spawn(move || {
		let mut alarm = nix::sys::signal::SigSet::empty();
		alarm.add(nix::sys::signal::SIGALRM);
		alarm.thread_block().unwrap();
		let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
		let _ = answered.send(format!("{:?}", crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None)));
	});
	let codeset = answer.recv_timeout(Duration::from_secs(10));
	// Let the holding thread out of `open` before the directory goes.
	let _ = std::fs::OpenOptions::new().write(true).open(&fifo);
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
	assert_eq!(codeset.as_deref(), Ok("Loaded(\"ISO-8859-1\")"));
}

/// The lookup must spend no descriptor the answer does not need.
///
/// Measured with `RLIMIT_NOFILE=5`, which leaves two free: the reference
/// reports `ISO-8859-1`, while a lookup whose child keeps both ends of its
/// own result pipe has none left for the locale data and reports nothing.
/// Two free descriptors are exactly what the answer pipe costs here, and the
/// child that reads the locale keeps none of them.
#[cfg(target_os = "linux")]
#[test]
fn a_descriptor_limit_with_two_to_spare_still_answers() {
	use std::os::fd::{FromRawFd as _, OwnedFd};

	use nix::sys::resource::{Resource, getrlimit, setrlimit};

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	let (soft, hard) = getrlimit(Resource::RLIMIT_NOFILE).unwrap();
	let open = u64::try_from(fs::read_dir("/proc/self/fd").unwrap().count()).unwrap();
	// A limit just above what is open now, so filling it costs nothing.
	setrlimit(Resource::RLIMIT_NOFILE, open + 8, hard).unwrap();
	let mut burned: Vec<OwnedFd> = Vec::new();
	loop {
		// SAFETY: duplicating a descriptor this process owns until the limit
		// refuses; each result is owned here and closed below.
		let spare = unsafe { libc::dup(0) };
		if spare < 0 {
			break;
		}
		// SAFETY: `spare` is a fresh descriptor nothing else owns.
		burned.push(unsafe { OwnedFd::from_raw_fd(spare) });
	}
	// Give back exactly two: the answer pipe fits, and nothing else does.
	burned.truncate(burned.len().saturating_sub(2));
	let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	drop(burned);
	setrlimit(Resource::RLIMIT_NOFILE, soft, hard).unwrap();
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"), "{answer:?}");
}

/// A second locale under `<dir>/<name>`, in `codeset`. `None` on a host
/// without locale sources.
#[cfg(target_os = "linux")]
fn generated_locale(dir: &Path, name: &str, codeset: &str) -> Option<PathBuf> {
	fs::create_dir_all(dir.join(name)).unwrap();
	let built = Command::new("localedef").args(["-i", "en_US", "-f", codeset]).arg(dir.join(name)).output();
	built.is_ok_and(|built| built.status.success()).then(|| dir.to_path_buf())
}

/// A directory name is not a list element: a working directory holding a
/// `:` has no spelling inside `LOCPATH`, so nothing may try to give it one.
///
/// Measured from a cwd named `with:colon` holding a `locales` symlink: the
/// reference reports `ISO-8859-1` for `LOCPATH=locales`, for `LOCPATH=.`,
/// and for the mixed list, and rsync 3.5.1 prints `ünï.txt` in each.
#[cfg(target_os = "linux")]
#[test]
fn a_colon_in_the_working_directory_is_not_a_list_separator() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let Some(utf8) = generated_locale(&dir.path().join("utf8"), SHELL_ONLY_LOCALE, "UTF-8") else { return };
	let cwd = dir.path().join("with:colon");
	fs::create_dir_all(&cwd).unwrap();
	std::os::unix::fs::symlink(&locales, cwd.join("locales")).unwrap();
	std::os::unix::fs::symlink(locales.join(SHELL_ONLY_LOCALE), cwd.join(SHELL_ONLY_LOCALE)).unwrap();
	let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
	let child = host.child_env();
	// The last one puts a UTF-8 locale of the same name second in the list,
	// so a lookup that loses the relative entry answers `UTF-8` rather than
	// merely falling back to C.
	for path in ["locales".to_owned(), ".".to_owned(), format!("locales:{}", utf8.display())] {
		let env = |key: &str| (key == "LOCPATH").then(|| path.clone());
		let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, Some(&child));
		assert!(
			matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"),
			"{path}: {answer:?}"
		);
	}
}

/// A working directory the shell is in but that no longer exists keeps a
/// parent in the kernel that its vanished pathname does not: the reference
/// resolves `../locales` from it and this cannot. An answer from somewhere
/// else is not that answer, so the lookup says so instead of giving one —
/// and `./../` reaches that parent exactly as `../` does, so no reading of
/// the entries can stand in for entering the directory.
#[cfg(target_os = "linux")]
#[test]
fn a_vanished_working_directory_is_reported_rather_than_guessed() {
	let dir = tempfile::tempdir().unwrap();
	if shell_only_locale(dir.path()).is_none() {
		return;
	}
	for path in ["../locales", "./../locales", "././../locales"] {
		let cwd = dir.path().join(path.replace(['.', '/'], "-"));
		fs::create_dir_all(&cwd).unwrap();
		let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
		let child = host.child_env();
		fs::remove_dir(&cwd).unwrap();
		let env = |key: &str| (key == "LOCPATH").then(|| path.to_owned());
		let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, Some(&child));
		assert!(matches!(&answer, crate::locale::Codeset::Unasked(_)), "{path}: {answer:?}");
	}
}

/// A utility that does not answer whole, or does not finish, has not
/// answered. A byte cap bounds what is stored, not what it means.
#[cfg(target_os = "linux")]
#[test]
fn a_locale_utility_that_misbehaves_is_reported() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let env = |_: &str| None;
	let cases: [(&str, &str, &str); 7] = [
		("plain", "printf 'ISO-8859-1\\n'\n", ""),
		("status", "printf 'UTF-8\\n'\nexit 7\n", "exited with status 7"),
		("signal", "printf 'UTF-8\\n'\nkill -9 $$\n", "ended on signal 9"),
		("diagnostic-first", "printf 'warning: alien\\nUTF-8\\n'\n", "where one codeset was due"),
		("nul", "printf 'UTF-8\\000junk\\n'\n", "where one codeset was due"),
		("flood", "dd if=/dev/zero bs=1024 count=4096 2>/dev/null | tr '\\\\0' 'X'\n", "wrote more than"),
		("closes-and-lingers", "printf 'UTF-8\\n'\nexec 1>&-\nsleep 30\n", "was ended before it finished"),
	];
	for (name, body, expected) in cases {
		let program = dir.path().join(name);
		fs::write(&program, format!("#!/bin/sh\n{body}")).unwrap();
		fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
		let answer = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &env);
		match (&answer, expected) {
			(crate::locale::Codeset::Loaded(codeset), "") => assert_eq!(codeset, "ISO-8859-1", "{name}"),
			(crate::locale::Codeset::Unasked(why), _) if !expected.is_empty() => {
				assert!(why.contains(expected), "{name}: {why}");
			},
			_ => panic!("{name}: {answer:?}"),
		}
	}
}

/// Nothing the utility leaves in its process group outlives the query,
/// whether it answered or not: a descendant that closes the answer pipe and
/// sleeps used to survive, because the normal-exit path returned without
/// sweeping the group. One that calls `setsid` leaves the group and is
/// beyond this.
#[cfg(target_os = "linux")]
#[test]
fn a_descendant_of_the_utility_does_not_outlive_the_query() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let program = dir.path().join("locale");
	let marker = dir.path().join("descendant");
	// The utility leaves a descendant that closes the pipe it inherited and
	// sleeps, records that descendant's process id (`$$` in a subshell is
	// still the shell's), answers, and exits 0.
	let body = format!(
		"#!/bin/sh\n(exec 1>&-; exec sleep 30) &\necho $! > '{}'\nprintf 'ISO-8859-1\\n'\nexit 0\n",
		marker.display()
	);
	fs::write(&program, body).unwrap();
	fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
	let env = |_: &str| None;
	let answer = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &env);
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"), "{answer:?}");
	let descendant: i32 = fs::read_to_string(&marker).unwrap().trim().parse().unwrap();
	// The kill is delivered as the group leader is reaped; give it the
	// moment the scheduler needs, then insist the process is gone.
	for _ in 0..200 {
		// SAFETY: a signal-free existence probe for a process this test
		// started and does not reap.
		if unsafe { libc::kill(descendant, 0) } != 0 {
			return;
		}
		std::thread::sleep(std::time::Duration::from_millis(10));
	}
	// SAFETY: as above; the test cleans up what it started before failing.
	unsafe { libc::kill(descendant, libc::SIGKILL) };
	panic!("the descendant {descendant} outlived the query");
}

/// A standard descriptor the caller has closed must not become the answer.
///
/// Whichever of them is closed, the open the child does for `/dev/null`
/// takes that number, so the answer stream has to be redirected first:
/// doing it the other way round put the answer file in `/dev/null`'s place
/// and left the later duplications reading *it* as their source. Measured
/// with stderr closed and real `/usr/bin/locale`: the diagnostics stream
/// carried `ISO-8859-1` instead of nothing and a loadable locale read as
/// unloadable.
#[cfg(target_os = "linux")]
#[test]
fn a_closed_standard_descriptor_never_becomes_the_answer() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	// A name only the utility can answer for, so the diagnostics stream is
	// exercised as well as the codeset one.
	let literal = "omp;literal";
	let mut copy = Command::new("cp");
	copy.arg("-a").arg(locales.join(SHELL_ONLY_LOCALE)).arg(locales.join(literal));
	assert!(copy.output().unwrap().status.success());
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	// SAFETY: nextest gives this test its own process, and nothing else in
	// it reads `LOCPATH` concurrently.
	unsafe { std::env::set_var("LOCPATH", &locales) };
	for closed in 1..8u32 {
		let wanted: Vec<i32> = (0..3).filter(|standard| closed & (1 << standard) != 0).collect();
		// SAFETY: every descriptor is put back below, before anything else
		// in this process writes to one.
		let kept: Vec<(i32, i32)> =
			wanted.iter().map(|standard| (*standard, unsafe { libc::dup(*standard) })).collect();
		// SAFETY: as above.
		for (standard, _) in &kept {
			unsafe { libc::close(*standard) };
		}
		let codeset = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
		let loadable = crate::locale::locale_loadable(literal, libc::LC_CTYPE_MASK);
		// SAFETY: as above; every saved descriptor is this test's own.
		for (standard, saved) in &kept {
			unsafe {
				libc::dup2(*saved, *standard);
				libc::close(*saved);
			}
		}
		assert!(
			matches!(&codeset, crate::locale::Codeset::Loaded(found) if found == "ISO-8859-1"),
			"closed {wanted:?}: {codeset:?}"
		);
		assert!(loadable, "closed {wanted:?}: the literal name is loadable");
	}
	// SAFETY: as above.
	unsafe { std::env::remove_var("LOCPATH") };
}

/// A query leaves the caller's signal mask as it found it, and leaves an
/// ignored disposition ignored.
///
/// Blocking every signal across the clone is this code's business and not
/// the caller's: a mask call whose failure went unchecked used to "restore"
/// an empty set and hand back a thread with nothing blocked. And resetting
/// *ignored* dispositions is not `posix_spawn`'s contract — with `SIGPIPE`
/// ignored in the caller, a utility that raises it and then answers
/// succeeds under `posix_spawn` and died on signal 13 when this reset it.
#[cfg(target_os = "linux")]
#[test]
fn a_query_leaves_the_callers_signal_settings_alone() {
	use std::os::unix::fs::PermissionsExt as _;

	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let shell_path = locales.to_str().unwrap().to_owned();
	let env = move |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
	let blocked = |signal| {
		let mask = nix::sys::signal::SigSet::thread_get_mask();
		mask.map(|held| held.contains(signal)).unwrap_or_default()
	};
	let mut usr1 = nix::sys::signal::SigSet::empty();
	usr1.add(nix::sys::signal::SIGUSR1);
	usr1.thread_block().unwrap();
	// SAFETY: nextest gives this test its own process; the disposition is
	// put back below.
	let kept = unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
	let before = blocked(nix::sys::signal::SIGUSR1);
	let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, None);
	let after = blocked(nix::sys::signal::SIGUSR1);
	// A utility that raises the signal the caller ignores, then answers.
	let program = dir.path().join("locale");
	fs::write(&program, "#!/bin/sh\nkill -PIPE $$\nprintf 'UTF-8\\n'\n").unwrap();
	fs::set_permissions(&program, fs::Permissions::from_mode(0o755)).unwrap();
	let ignored = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &|_| None);
	// SAFETY: as above.
	unsafe { libc::signal(libc::SIGPIPE, kept) };
	usr1.thread_unblock().unwrap();
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(found) if found == "ISO-8859-1"), "{answer:?}");
	assert!(before && after, "the caller's mask is its own: before {before}, after {after}");
	assert!(
		matches!(&ignored, crate::locale::Codeset::Loaded(found) if found == "UTF-8"),
		"an ignored disposition stays ignored: {ignored:?}"
	);
}

/// An inherited *handler* does not run in the child, in the one window
/// `execve` does not close by itself.
///
/// A successful `execve` resets every caught disposition on its own, so a
/// utility that raises a signal once it is running says nothing about
/// this code: the test that did that passed with the whole reset loop
/// deleted. The handler has to be observed — or observed not to run —
/// *before* the `execve`, and the child's life up to there is a few dozen
/// microseconds.
///
/// So this takes a process group of its own and sends `SIGUSR1` to it as
/// fast as it can while a query runs. The child is in that group until
/// its own `setpgid`, it starts with every signal blocked, and a signal
/// that arrives in that window is delivered the moment it puts the
/// caller's mask back — after the reset loop and before the `execve`.
///
/// The program named does not exist, so the only way the child can end
/// *on* the signal is by taking it before the `execve`; anything else
/// exits with the "would not run" status. That makes the test say when it
/// missed the window instead of passing because nothing happened. With
/// the reset loop deleted the inherited handler runs in the child
/// instead, writes the child's own number into the record below, and the
/// child goes on to the `execve` it cannot do — so both halves fail.
///
/// The storm carries a second signal, one the caller *ignores*. That is
/// the caller's own instruction and it has to reach the utility, so the
/// last query here runs a utility that reads its own `/proc` entry,
/// refuses unless that number is ignored and unblocked, and only then
/// raises it at itself and answers. Surviving the signal is not proof on
/// its own — a blocked signal with the default disposition survives too,
/// and a mutant that reset the readable ignore and then blocked the
/// number passed the survival form twenty times out of twenty. What this
/// cannot reach is an ignored disposition whose *read* is denied,
/// because denying one read needs a kernel filter, which lives in this
/// lane's harness rather than here.
#[cfg(target_os = "linux")]
#[test]
fn an_inherited_handler_does_not_run_in_the_child_before_exec() {
	use std::os::fd::AsRawFd as _;
	use std::os::unix::fs::PermissionsExt as _;
	use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};

	/// This test's own number, and the descriptor the handler writes to.
	static OWNER: AtomicI32 = AtomicI32::new(0);
	static RECORD: AtomicI32 = AtomicI32::new(-1);

	extern "C" fn note_whoever_runs_this(_signal: libc::c_int) {
		// SAFETY: `getpid` and `write` are async-signal-safe, and the file
		// the descriptor names outlives every delivery below. A process
		// that is not this test is a child running an inherited handler.
		unsafe {
			let me = libc::getpid();
			if me != OWNER.load(Ordering::Relaxed) {
				let number = me.to_ne_bytes();
				libc::write(RECORD.load(Ordering::Relaxed), number.as_ptr().cast(), number.len());
			}
		}
	}

	let dir = tempfile::tempdir().unwrap();
	let record = dir.path().join("ran");
	let file = fs::File::create(&record).unwrap();
	// SAFETY: reading this process's own number.
	OWNER.store(unsafe { libc::getpid() }, Ordering::Relaxed);
	RECORD.store(file.as_raw_fd(), Ordering::Relaxed);
	// SAFETY: nextest gives this test its own process; the disposition and
	// the process group are both put back below. `SA_RESTART` keeps the
	// storm from turning this process's own calls into `EINTR`.
	let (kept, ignored, grouped) = unsafe {
		let mut catching: libc::sigaction = std::mem::zeroed();
		catching.sa_sigaction = note_whoever_runs_this as libc::sighandler_t;
		catching.sa_flags = libc::SA_RESTART;
		libc::sigemptyset(&raw mut catching.sa_mask);
		let mut kept: libc::sigaction = std::mem::zeroed();
		assert_eq!(libc::sigaction(libc::SIGUSR1, &raw const catching, &raw mut kept), 0);
		// And one the caller *ignores*, which is its own instruction and
		// has to reach the utility: a child that put it back to default
		// would die on the storm's own delivery of it.
		let ignored = libc::signal(libc::SIGUSR2, libc::SIG_IGN);
		assert_ne!(ignored, libc::SIG_ERR);
		let was = libc::getpgrp();
		// Its own group, so the storm reaches this test and its children
		// and nothing else the runner has going.
		assert_eq!(libc::setpgid(0, 0), 0, "a group of this test's own: {}", std::io::Error::last_os_error());
		(kept, ignored, was)
	};
	let storming = std::sync::Arc::new(AtomicBool::new(true));
	let until = std::sync::Arc::clone(&storming);
	let storm = std::thread::spawn(move || {
		while until.load(Ordering::Relaxed) {
			// SAFETY: the group is this test's own, made above.
			unsafe {
				libc::kill(0, libc::SIGUSR2);
				libc::kill(0, libc::SIGUSR1);
			}
			// A gap, because a storm with none starves this process: every
			// delivery interrupts the query's own waiting, and the whole
			// test made no progress in 90 seconds. A fifth of a
			// millisecond still puts a signal inside a window the child
			// takes tens of microseconds to cross, and the round below
			// that sees it is the first.
			std::thread::sleep(std::time::Duration::from_micros(200));
		}
	});
	let program = dir.path().join("locale-no-such-program");
	let mut taken = None;
	let mut last = String::new();
	let mut died_ignoring = None;
	for _ in 0..64 {
		let answer = crate::locale::codeset_from_utility_for_test(&program, "C.UTF-8", &|_| None);
		let crate::locale::Codeset::Unasked(why) = &answer else {
			panic!("a program that is not there answered: {answer:?}");
		};
		last = why.clone();
		if why.contains(&format!("ended on signal {}", libc::SIGUSR2)) {
			died_ignoring = Some(why.clone());
			break;
		}
		if why.contains(&format!("ended on signal {}", libc::SIGUSR1)) {
			taken = Some(why.clone());
			break;
		}
	}
	storming.store(false, Ordering::Relaxed);
	storm.join().unwrap();
	// With the storm stopped, one query says outright whether the ignored
	// disposition reached a child. Surviving the signal is not enough to
	// say it: a *blocked* signal with the default disposition survives
	// too, and a mutant that reset the readable ignore and then blocked
	// the number passed that form twenty times out of twenty. So the
	// utility reads its own `/proc` entry first and refuses unless the
	// number is in `SigIgn` and out of `SigBlk`, and only then raises it
	// at itself and answers. What this cannot reach is still said where
	// it is said above; restoring the *wrong* number, and skipping the
	// mask read-back, are covered by this lane's harness probes rather
	// than from here.
	let bit = 1u64 << (libc::SIGUSR2 - 1);
	let raises = dir.path().join("locale-raises-the-ignored-signal");
	let script = format!(
		"#!/bin/sh\n\
		 ignored=$(awk '/^SigIgn:/ {{ print $2 }}' /proc/$$/status)\n\
		 blocked=$(awk '/^SigBlk:/ {{ print $2 }}' /proc/$$/status)\n\
		 [ $(( 0x$ignored & {bit} )) -ne 0 ] || exit 71\n\
		 [ $(( 0x$blocked & {bit} )) -eq 0 ] || exit 72\n\
		 kill -{signal} $$\n\
		 printf 'UTF-8\\n'\n",
		signal = libc::SIGUSR2
	);
	fs::write(&raises, script).unwrap();
	fs::set_permissions(&raises, fs::Permissions::from_mode(0o755)).unwrap();
	let ignoring = crate::locale::codeset_from_utility_for_test(&raises, "C.UTF-8", &|_| None);
	// SAFETY: putting back what this test changed, before it can fail.
	unsafe {
		libc::sigaction(libc::SIGUSR1, &raw const kept, std::ptr::null_mut());
		libc::signal(libc::SIGUSR2, ignored);
		libc::setpgid(0, grouped);
	}
	let ran: Vec<i32> = fs::read(&record)
		.unwrap()
		.chunks_exact(4)
		.map(|number| i32::from_ne_bytes(number.try_into().unwrap()))
		.collect();
	assert!(ran.is_empty(), "the handler ran in the child before its `execve`: {ran:?}");
	assert!(taken.is_some(), "no query took the signal before its `execve`, so nothing was proved: {last}");
	assert!(
		died_ignoring.is_none(),
		"a disposition the caller ignores was not left ignored: {died_ignoring:?}"
	);
	assert!(
		matches!(&ignoring, crate::locale::Codeset::Loaded(found) if found == "UTF-8"),
		"the signal the caller ignores reached the utility ignored and unblocked, and it survived \
		 raising it — status 71 is a disposition that is no longer ignored, 72 is a blocked one: \
		 {ignoring:?}"
	);
}

/// A name is the name of locale data, whatever punctuation it carries.
///
/// `newlocale` splits a name containing `;` per category and `setlocale`
/// takes it whole, so the one answer that is right is the reference's: data
/// literally so named loads (measured: `ISO-8859-1`, and rsync 3.5.1 prints
/// `ünï.txt`), and with no such data the C locale follows. This asserts
/// against `locale charmap` under the same environment, through both of
/// this code's paths — the shell's search path differing from this
/// process's, which spawns, and neither set, which does not.
#[cfg(target_os = "linux")]
#[test]
fn a_name_is_the_name_of_the_data_whatever_punctuation_it_carries() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let literal = ["astra=latin", "astra;latin", "LC_CTYPE=astra;LC_TIME=C"];
	for name in literal {
		let mut copy = Command::new("cp");
		copy.arg("-a").arg(locales.join(SHELL_ONLY_LOCALE)).arg(locales.join(name));
		assert!(copy.output().unwrap().status.success(), "{name}");
	}
	let absent = format!("LC_CTYPE={SHELL_ONLY_LOCALE};LC_TIME=C");
	let shell_path = locales.to_str().unwrap().to_owned();
	for name in literal.iter().copied().chain([absent.as_str()]) {
		let reference = Command::new("/usr/bin/locale")
			.arg("charmap")
			.env_clear()
			.env("LC_CTYPE", name)
			.env("LOCPATH", &locales)
			.output()
			.unwrap();
		let reference = String::from_utf8_lossy(&reference.stdout).trim().to_owned();
		// Spawning: the shell's search path is not this process's.
		let env = |key: &str| (key == "LOCPATH").then(|| shell_path.clone());
		let spawned = crate::locale::loaded_codeset(name, &env, None);
		assert!(
			matches!(&spawned, crate::locale::Codeset::Loaded(codeset) if *codeset == reference),
			"{name} spawned: {spawned:?} vs {reference}"
		);
		// In process: neither search path is set, so the same name has to
		// read the same way through `newlocale` or not be answered there.
		// SAFETY: nextest gives this test its own process, and nothing else
		// in it reads `LOCPATH` concurrently.
		unsafe { std::env::set_var("LOCPATH", &locales) };
		let here = crate::locale::loaded_codeset(name, &env, None);
		// SAFETY: as above.
		unsafe { std::env::remove_var("LOCPATH") };
		assert!(
			matches!(&here, crate::locale::Codeset::Loaded(codeset) if *codeset == reference),
			"{name} in process: {here:?} vs {reference}"
		);
	}
}

/// A long list of relative entries is passed to the child as the shell wrote
/// it, so nothing it is joined with can push it past what `execve` takes.
#[cfg(target_os = "linux")]
#[test]
fn two_thousand_relative_entries_still_resolve() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let cwd = dir.path().join("a-working-directory-with-a-name-of-its-own");
	fs::create_dir_all(&cwd).unwrap();
	std::os::unix::fs::symlink(locales.join(SHELL_ONLY_LOCALE), cwd.join(SHELL_ONLY_LOCALE)).unwrap();
	let (host, _) = crate::host::Host::for_test("rsync", "", &cwd);
	let child = host.child_env();
	let path = vec!["."; 2048].join(":");
	let env = |key: &str| (key == "LOCPATH").then(|| path.clone());
	let answer = crate::locale::loaded_codeset(SHELL_ONLY_LOCALE, &env, Some(&child));
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if codeset == "ISO-8859-1"), "{answer:?}");
}

/// The shell's conversion configuration decides whether a name's codeset is
/// an alias of the locale's own, and so whether libc loads it at all
/// (`findlocale.c`, `__gconv_compare_alias`). This asserts against the
/// reference under the same environment, so it holds whatever that glibc
/// makes of the alias.
#[cfg(target_os = "linux")]
#[test]
fn the_shells_conversion_configuration_reaches_the_lookup() {
	let dir = tempfile::tempdir().unwrap();
	let Some(locales) = shell_only_locale(dir.path()) else { return };
	let gconv = dir.path().join("gconv");
	fs::create_dir_all(&gconv).unwrap();
	fs::write(gconv.join("gconv-modules"), "alias OMP_RSYNC_ALIAS// ISO-8859-1//\n").unwrap();
	let aliased = format!("{SHELL_ONLY_LOCALE}.OMP_RSYNC_ALIAS");
	std::os::unix::fs::symlink(locales.join(SHELL_ONLY_LOCALE), locales.join(&aliased)).unwrap();
	let reference = Command::new("/usr/bin/locale")
		.arg("charmap")
		.env_clear()
		.env("LC_CTYPE", &aliased)
		.env("LOCPATH", &locales)
		.env("GCONV_PATH", &gconv)
		.output();
	let Ok(reference) = reference else { return };
	let reference = String::from_utf8_lossy(&reference.stdout).trim().to_owned();
	let locales = locales.to_str().unwrap().to_owned();
	let gconv = gconv.to_str().unwrap().to_owned();
	let env = |key: &str| match key {
		"LOCPATH" => Some(locales.clone()),
		"GCONV_PATH" => Some(gconv.clone()),
		_ => None,
	};
	let answer = crate::locale::loaded_codeset(&aliased, &env, None);
	assert!(matches!(&answer, crate::locale::Codeset::Loaded(codeset) if *codeset == reference), "{answer:?} vs {reference}");
}

/// Captured from rsync 3.5.1: `rsync --protocol=19 -a src/ d/` on a local copy.
#[test]
fn too_old_protocol_is_a_mismatch() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, _, err) = run(&["--protocol=19", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 2);
	// The server half fails the same check and is stopped by its client
	// (upstream: SIGUSR1 to the local child).
	assert_eq!(
		err,
		"protocol version mismatch -- is your shell clean?\n(see the rsync manpage for an explanation)\n\
		 rsync error: protocol incompatibility (code 2) at compat.c(625) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1: when the server half of a local copy fails while
/// setting up, the client exits with its code and prints nothing of its own.
#[test]
fn local_server_setup_failure_is_reported_once() {
	let tmp = tempfile::tempdir().unwrap();
	let dir = physical(tmp.path());
	fs::create_dir_all(dir.join("src")).unwrap();
	fs::write(dir.join("src/a"), b"a\n").unwrap();
	// A file list far larger than the in-process pipe, so the client is still
	// writing it when the server half gives up.
	for i in 0..600 {
		let name = format!("{i:04}-a-rather-long-file-name-to-make-the-file-list-big.txt");
		fs::write(dir.join("src").join(name), b"x").unwrap();
	}
	let (code, _, err) = run(&["-ai", "src/", "dst/new/deeper/"], &dir);
	assert_eq!(code, 11, "{err}");
	assert_eq!(
		err,
		format!(
			"rsync: [Receiver] mkdir \"{}/dst/new/deeper\" failed: No such file or directory (2)\n\
			 rsync error: error in file IO (code 11) at main.c(821) [Receiver=3.5.1]\n",
			String::from_utf8_lossy(&crate::rsync::paths::path_bytes(&dir))
		)
	);
	let (code, _, err) = run(&["-ai", "--temp-dir=../nope", "src/", "dst2/"], &dir);
	assert_eq!(code, 1, "{err}");
	assert_eq!(
		err,
		"The temp-dir does not exist: ../nope\n\
		 rsync error: syntax or usage error (code 1) at main.c(1069) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1: `rsync --protocol=40 -a src/ d/`.
#[test]
fn too_new_protocol_option_on_a_local_copy() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, _, err) = run(&["--protocol=40", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 2);
	assert_eq!(
		err,
		"--protocol must be no more than 33 on the Client.\n\
		 rsync error: protocol incompatibility (code 2) at compat.c(639) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [Receiver=3.5.1]\n"
	);
}

/// Captured from rsync 3.5.1 (a build without preallocation): `rsync --preallocate f h`.
#[test]
fn preallocate_is_refused_by_the_receiving_half() {
	let dir = tempfile::tempdir().unwrap();
	fs::write(dir.path().join("f"), b"x\n").unwrap();
	let (code, _, err) = run(&["--preallocate", "f", "h"], dir.path());
	if crate::rsync::usage::SUPPORT_PREALLOCATION {
		assert_eq!(code, 0, "{err}");
		return;
	}
	assert_eq!(code, 12, "{err}");
	assert_eq!(
		err,
		"preallocation is not supported on this Server\n\
		 rsync error: syntax or usage error (code 1) at compat.c(660) [Receiver=3.5.1]\n\
		 rsync: connection unexpectedly closed (0 bytes received so far) [sender]\n\
		 rsync error: error in rsync protocol data stream (code 12) at io.c(303) [sender=3.5.1]\n"
	);
}

/// Protocol 33 MSG_BLOCK_STATS: the receiving half's 4 KiB block count reaches
/// the sending client's --stats (rsync 3.5.1 prints 1 for this delta).
#[test]
fn touched_blocks_reach_the_sending_client() {
	let dir = tempfile::tempdir().unwrap();
	let data: Vec<u8> = (0..65536u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
	fs::write(dir.path().join("src"), &data).unwrap();
	fs::write(dir.path().join("dst"), &data).unwrap();
	let mut changed = data;
	changed[..3].copy_from_slice(b"xyz");
	fs::write(dir.path().join("src"), &changed).unwrap();
	let (code, out, err) = run(&["-a", "--stats", "--inplace", "-I", "--no-whole-file", "src", "dst"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("Number of 4 KiB logical blocks touched: 1\n"), "{out}");
	assert_eq!(fs::read(dir.path().join("dst")).unwrap(), changed);
}

/// `--confine-root` bounds option paths and --files-from entries, not the
/// transfer roots or the list file (rsync 3.5.1 exits 0 for both).
#[test]
fn confine_root_leaves_roots_and_list_file_alone() {
	let tmp = tempfile::tempdir().unwrap();
	// Physical paths: the confine check (like the reference's) refuses a path
	// that only reaches the root through an alias such as macOS's /var symlink.
	let dir = physical(tmp.path());
	let root = dir.join("X/root");
	fs::create_dir_all(&root).unwrap();
	fs::write(root.join("keep"), b"k\n").unwrap();
	fs::write(dir.join("list"), b"keep\n").unwrap();
	let confine = format!("--confine-root={}", root.display());
	let keep = root.join("keep");
	let (code, _, err) = run(&["-r", &confine, keep.to_str().unwrap(), "d/"], &dir);
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.join("d/keep")).unwrap(), b"k\n");
	let list = format!("--files-from={}", dir.join("list").display());
	let src = format!("{}/", root.display());
	let (code, _, err) = run(&["-r", &confine, &list, &src, "d2/"], &dir);
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.join("d2/keep")).unwrap(), b"k\n");
}

/// `host://path` is a host spec unless the shell's filesystem routes the scheme.
#[test]
fn url_spelled_operand_without_a_provider_is_remote() {
	let fs = crate::host::ShellPaths::default().fs().clone();
	assert!(!routes_locally(&fs, OsStr::new("localhost:///tmp/x")));
	assert!(!routes_locally(&fs, OsStr::new("/tmp/x")));
}

#[cfg(unix)]
#[test]
fn url_spelled_remote_operand_reaches_the_shell() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("Y/src")).unwrap();
	fs::write(dir.path().join("Y/src/file"), b"hi\n").unwrap();
	let rsh = fake_rsh(dir.path());
	let rpath = format!("--rsync-path={}", rsync.display());
	let source = format!("h:/{}/Y/src/file", dir.path().display());
	assert!(source.starts_with("h://"));
	let (code, _, err) = run(&["-a", "-e", rsh.to_str().unwrap(), &rpath, &source, "d1/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(fs::read(dir.path().join("d1/file")).unwrap(), b"hi\n");
}

/// Parses "sent X bytes  received Y bytes" (commas allowed) from a line.
fn sent_received(line: &str) -> (i64, i64) {
	let num = |word: &str| word.replace(',', "").parse::<i64>().unwrap();
	let words: Vec<&str> = line.split_whitespace().collect();
	let at = |key: &str| words.iter().position(|w| *w == key).map(|i| num(words[i + 1])).unwrap();
	(at("sent"), at("received"))
}

/// The bytes of the log-file exit line (`sent N bytes  received M bytes  total size T`).
fn log_exit_line(log: &str) -> (i64, i64) {
	let line = log.lines().find(|l| l.contains("] sent ") && l.contains(" total size ")).unwrap();
	sent_received(line)
}

/// The --log-file exit line reports the connection's live byte counters (log_exit),
/// which include what was exchanged after the --stats snapshot (handle_stats).
/// Every comparison is within one run, because byte totals can vary between runs.
#[test]
fn log_file_exit_line_uses_live_counters() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	fs::create_dir_all(&src).unwrap();
	fs::write(src.join("a"), (0..300_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 11) as u8).collect::<Vec<u8>>()).unwrap();
	fs::write(src.join("b"), b"hi\n").unwrap();

	// Local push. A clean client run with --stats writes no exit line, but one
	// ending with code 23 writes both (the summary, then log_exit on the error
	// exit), so a missing extra source puts the two in one run. Measured with
	// rsync 3.5.1 (`-a --stats --log-file=r.log src/ nope dst/`, six runs, all
	// identical): --stats sent 300,244 / received 57, log line sent 300249 /
	// received 74. That is +5 sent (the sender's goodbye NDX_DONE frame) and +17
	// received (the receiver's MSG_BLOCK_STATS frame, 12, and goodbye frame, 5).
	let (code, out, _) = run(&["-a", "--stats", "--log-file=r.log", "src/", "nope", "d1/"], dir.path());
	assert_eq!(code, 23, "{out}");
	let summary = sent_received(out.lines().find(|l| l.starts_with("sent ")).unwrap());
	let log = fs::read_to_string(dir.path().join("r.log")).unwrap();
	assert_eq!(log_exit_line(&log), (summary.0 + 5, summary.1 + 17), "{log}");

	// Pull from the reference server. A pulling client logs the exit line only
	// on a clean run without --stats, so its counterpart is the server's own
	// log line for the same connection: the client sent exactly what the
	// server received. The client received what the server sent, plus whatever
	// the server wrote after logging. Measured with rsync 3.5.1 on both ends
	// (five runs): client sent 70 = server received 70 every time; client
	// received 300264 or 300280 against server sent 300264.
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let Some(rsync) = reference() else { return };
		// Runs the remote command through sh so --rsync-path can carry options.
		let rsh = dir.path().join("shrsh");
		fs::write(&rsh, "#!/bin/sh\nshift\nexec /bin/sh -c \"$*\"\n").unwrap();
		fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
		let server_log = dir.path().join("s.log");
		let rpath = format!("--rsync-path={} --log-file={}", rsync.display(), server_log.display());
		let source = format!("h:{}/src/", dir.path().display());
		let (code, _, err) = run(&["-a", "--log-file=p.log", "-e", rsh.to_str().unwrap(), &rpath, &source, "p/"], dir.path());
		assert_eq!((code, err.as_str()), (0, ""));
		let client = log_exit_line(&fs::read_to_string(dir.path().join("p.log")).unwrap());
		let server = log_exit_line(&fs::read_to_string(&server_log).unwrap());
		assert_eq!(client.0, server.1, "client sent vs server received");
		assert!(matches!(client.1 - server.0, 0 | 16), "client received {} vs server sent {}", client.1, server.0);
	}
}

/// Local `--delete` copies terminate at protocol 29 (the server's input is not
/// multiplexed, so its reads never refill) and at 33 (inc-recursion: the receiver's
/// successes are messages that can hold back its forwarded lists): before the
/// receiver blocks on the socket it hands every queued item to the generator.
#[test]
fn local_delete_copies_terminate() {
	for args in [&["-aiH", "--delete", "--protocol=29"][..], &["-ai", "--delete", "--protocol=29"], &["-ai", "--delete"]] {
		let dir = tempfile::tempdir().unwrap();
		make_tree(&dir.path().join("src"));
		fs::create_dir_all(dir.path().join("dst/sub")).unwrap();
		fs::write(dir.path().join("dst/stale"), b"x").unwrap();
		fs::write(dir.path().join("dst/sub/stale2"), b"y").unwrap();
		let cwd = dir.path().to_path_buf();
		let mut argv: Vec<&'static str> = args.to_vec();
		argv.extend(["src/", "dst/"]);
		let (tx, rx) = std::sync::mpsc::channel();
		std::thread::spawn(move || {
			let _ = tx.send(run(&argv, &cwd));
		});
		let (code, _, err) = rx.recv_timeout(std::time::Duration::from_secs(60)).expect("local --delete copy hung");
		assert_eq!((code, err.as_str()), (0, ""), "{args:?}");
		assert!(!dir.path().join("dst/stale").exists() && !dir.path().join("dst/sub/stale2").exists());
	}
}

/// Byte totals are a function of the transfer, not of thread timing: the same
/// local copy run repeatedly reports identical `sent`/`received` counts (rsync
/// 3.5.1 is deterministic here, even under CPU load). Frames meet reads only where
/// upstream's processes would: reads happen at refills with the socketpair-sized
/// in-process pipe, never ahead of them.
#[test]
fn local_copy_byte_totals_are_deterministic() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	for i in 0..20 {
		fs::write(dir.path().join(format!("src/sub/f{i}")), format!("file {i}\n").repeat(i + 1)).unwrap();
	}
	let mut totals = Vec::new();
	for run_no in 0..5 {
		let dest = format!("d{run_no}/");
		let (code, out, err) = run(&["-a", "--stats", "src/", &dest], dir.path());
		assert_eq!((code, err.as_str()), (0, ""), "{out}");
		let summary = out.lines().find(|l| l.starts_with("sent ")).unwrap();
		totals.push(sent_received(summary));
	}
	assert!(totals.windows(2).all(|w| w[0] == w[1]), "{totals:?}");
}

/// A server's stdio may be O_NONBLOCK: EAGAIN is retried, not fatal.
#[test]
fn shared_writer_retries_would_block() {
	struct Flaky {
		left: usize,
		out: Arc<Mutex<Vec<u8>>>,
	}
	impl Write for Flaky {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			if self.left > 0 {
				self.left -= 1;
				return Err(io::ErrorKind::WouldBlock.into());
			}
			lock(&self.out).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let out = Arc::new(Mutex::new(Vec::new()));
	let cancel = Arc::new(AtomicBool::new(false));
	let mut w = SharedWrite::new(Box::new(Flaky { left: 3, out: Arc::clone(&out) }), &cancel);
	w.write_all(b"data").unwrap();
	assert_eq!(&*lock(&out), b"data");
	let mut stuck = SharedWrite::new(Box::new(Flaky { left: usize::MAX, out }), &cancel);
	cancel.store(true, Ordering::Relaxed);
	let err = stuck.write_all(b"x").unwrap_err();
	assert_eq!(RsyncError::from_io(&err, 0).code, RERR_SIGNAL);
}

/// Cancelling while the client waits on its peer (a remote shell that never
/// answers) ends the run promptly with upstream's signal exit: code 20 and the
/// `received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874)` trailer.
#[cfg(unix)]
#[test]
fn cancel_mid_connection_exits_20_with_trailer() {
	use std::os::unix::fs::PermissionsExt;

	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let rsh = dir.path().join("stuckrsh");
	fs::write(&rsh, "#!/bin/sh\nexec sleep 30\n").unwrap();
	fs::set_permissions(&rsh, fs::Permissions::from_mode(0o755)).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(300));
		cancel.store(true, Ordering::Relaxed);
	});
	let rsh_arg = rsh.to_str().unwrap().to_string();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "-e", &rsh_arg, "src/", "h:dst/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL);
	assert!(started.elapsed() < Duration::from_secs(10), "cancellation was not prompt");
	assert_eq!(cap.err(), "rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n");
}

/// Cancelling a local copy mid-transfer: the client reports the signal, then
/// stops its server half, whose generator reports SIGUSR1. Captured from
/// rsync 3.5.1 (`rsync -a bigsrc/ dst/`, SIGTERM to the client), three runs:
/// exactly these two lines, exit 20.
#[test]
fn cancel_local_copy_reports_like_upstream() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("bigsrc")).unwrap();
	fs::write(dir.path().join("bigsrc/f"), vec![0u8; 8 << 20]).unwrap();
	let (mut host, cap) = crate::host::Host::for_test_owning("rsync", Vec::new(), dir.path());
	let cancel = host.cancel_flag_for_test();
	let canceller = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(500));
		cancel.store(true, Ordering::Relaxed);
	});
	// --bwlimit keeps the copy running well past the cancellation.
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "--bwlimit=500", "bigsrc/", "dst/"]).unwrap();
	let started = Instant::now();
	let code = crate::host::run_caught::<Rsync>(parsed, &mut host);
	canceller.join().unwrap();
	assert_eq!(code, RERR_SIGNAL);
	assert!(started.elapsed() < Duration::from_secs(10), "cancellation was not prompt");
	assert_eq!(
		cap.err(),
		"rsync error: received SIGINT, SIGTERM, or SIGHUP (code 20) at rsync.c(874) [sender=3.5.1]\n\
		 rsync error: received SIGUSR1 (code 19) at main.c(1687) [generator=3.5.1]\n"
	);
}

/// A cancelled run ends with upstream's signal exit (code 20).
#[test]
fn cancelled_run_exits_20() {
	use clap::Parser as _;
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (mut host, _cap) = crate::host::Host::for_test("rsync", Vec::new(), dir.path());
	host.cancel_for_test();
	let parsed = Rsync::try_parse_from(["rsync", "--", "-a", "src/", "dst/"]).unwrap();
	assert_eq!(crate::host::run_caught::<Rsync>(parsed, &mut host), RERR_SIGNAL);
}

#[test]
fn local_archive_copy_then_noop_rerun() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, out, err) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert_same_tree(&src, &dir.path().join("dst"));
	assert_eq!(mtime(&src.join("big")), mtime(&dir.path().join("dst/big")));
	let mut expected = String::from("created directory dst\ncd+++++++++ ./\n>f+++++++++ a\n>f+++++++++ big\n");
	if cfg!(unix) {
		expected.push_str("cL+++++++++ link -> a\n");
	}
	expected.push_str("cd+++++++++ sub/\n>f+++++++++ sub/b\n");
	assert_eq!(out, expected);
	// Nothing changed: a second run itemizes nothing.
	let (code, out, err) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!((code, out.as_str(), err.as_str()), (0, "", ""));
}

#[test]
fn itemize_output_matches_reference() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	fs::create_dir_all(dir.path().join("ours")).unwrap();
	fs::create_dir_all(dir.path().join("theirs")).unwrap();
	fs::write(dir.path().join("ours/a"), b"old!!\n").unwrap();
	fs::write(dir.path().join("theirs/a"), b"old!!\n").unwrap();
	let theirs = Command::new(&rsync).args(["-ai", "src/", "theirs/"]).current_dir(dir.path()).output().unwrap();
	let (code, out, _) = run(&["-ai", "src/", "ours/"], dir.path());
	assert_eq!(code, 0);
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
	let theirs = Command::new(&rsync).args(["-ai", "src/", "theirs/"]).current_dir(dir.path()).output().unwrap();
	let (_, out, _) = run(&["-ai", "src/", "ours/"], dir.path());
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
}

#[test]
fn delete_removes_extraneous_files() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	assert_eq!(run(&["-a", "src/", "dst/"], dir.path()).0, 0);
	fs::write(dir.path().join("dst/extra"), b"gone").unwrap();
	fs::create_dir(dir.path().join("dst/olddir")).unwrap();
	let (code, out, err) = run(&["-ai", "--delete", "src/", "dst/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_eq!(out, "*deleting   olddir/\n*deleting   extra\n");
	assert_same_tree(&src, &dir.path().join("dst"));
}

#[test]
fn checksum_mode_catches_same_size_and_time() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	assert_eq!(run(&["-a", "src/", "dst/"], dir.path()).0, 0);
	let target = dir.path().join("dst/a");
	let when = mtime(&target);
	fs::write(&target, b"HELLO\n").unwrap();
	fs::File::options().write(true).open(&target).unwrap().set_modified(when).unwrap();
	// The quick check sees nothing to do.
	let (_, out, _) = run(&["-ai", "src/", "dst/"], dir.path());
	assert_eq!(out, "");
	assert_eq!(fs::read(&target).unwrap(), b"HELLO\n");
	// -c compares contents.
	let (code, out, _) = run(&["-aic", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert_eq!(out, ">fc........ a\n");
	assert_eq!(fs::read(&target).unwrap(), b"hello\n");
}

#[test]
fn dry_run_changes_nothing() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, out, _) = run(&["-ain", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.starts_with("created directory dst\ncd+++++++++ ./\n>f+++++++++ a\n"), "{out}");
	assert!(!dir.path().join("dst").exists());
	let (code, out, _) = run(&["-an", "--stats", "src/", "dst/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.contains("Number of regular files transferred: 3"), "{out}");
	assert!(out.trim_end().ends_with("(DRY RUN)"), "{out}");
}

#[test]
fn list_only_matches_reference() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, out, _) = run(&["--list-only", "src/"], dir.path());
	assert_eq!(code, 0);
	assert!(out.lines().any(|l| l.starts_with("-rw") && l.ends_with(" a")), "{out}");
	let Some(rsync) = reference() else { return };
	let theirs = Command::new(&rsync).args(["--list-only", "src/"]).current_dir(dir.path()).output().unwrap();
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
	let (_, out, _) = run(&["-r", "src"], dir.path());
	let theirs = Command::new(&rsync).args(["-r", "src"]).current_dir(dir.path()).output().unwrap();
	assert_eq!(out, String::from_utf8_lossy(&theirs.stdout));
}

/// A fake remote shell that runs the remote command locally.
#[cfg(unix)]
fn fake_rsh(dir: &Path) -> PathBuf {
	use std::os::unix::fs::PermissionsExt;
	let path = dir.join("fakersh");
	fs::write(&path, "#!/bin/sh\nshift\nexec \"$@\"\n").unwrap();
	fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
	path
}

#[cfg(unix)]
#[test]
fn remote_shell_push_and_pull_against_reference_server() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let rsh = fake_rsh(dir.path());
	let rsh = rsh.to_str().unwrap();
	let rpath = format!("--rsync-path={}", rsync.display());
	let pushed = dir.path().join("pushed");
	let dest = format!("h:{}/", pushed.display());
	let (code, out, err) = run(&["-ai", "-e", rsh, &rpath, "src/", &dest], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	// A pushing client itemizes sends with `<` (rsync 3.5.1 over a remote shell).
	assert!(out.contains("<f+++++++++ sub/b\n"), "{out}");
	assert_same_tree(&src, &pushed);
	// Pull it back, with deltas against a stale copy.
	let pulled = dir.path().join("pulled");
	fs::create_dir(&pulled).unwrap();
	let mut stale = fs::read(src.join("big")).unwrap();
	stale.truncate(500_000);
	stale.extend_from_slice(b"stale tail");
	fs::write(pulled.join("big"), stale).unwrap();
	let source = format!("h:{}/", pushed.display());
	let (code, out, err) = run(&["-a", "--stats", "-e", rsh, &rpath, &source, "pulled/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert!(out.contains("Matched data: "), "{out}");
	assert_same_tree(&src, &pulled);
	// Protocol 29 against the same server.
	let old = dir.path().join("old");
	let dest = format!("h:{}/", old.display());
	let (code, _, err) = run(&["-a", "--protocol=29", "-e", rsh, &rpath, "src/", &dest], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &old);
}

/// A tree whose only file is unreadable (`m/file`, mode 000); false when running
/// as root, where the file stays readable.
#[cfg(unix)]
fn unreadable_only_file(dir: &Path) -> bool {
	use std::os::unix::fs::PermissionsExt;
	let file = dir.join("m/file");
	fs::create_dir_all(dir.join("m")).unwrap();
	fs::write(&file, b"payload\n").unwrap();
	fs::set_permissions(&file, fs::Permissions::from_mode(0)).unwrap();
	fs::File::open(&file).is_err()
}

/// Runs `argv` in `cwd` on its own thread; panics when it does not finish.
#[cfg(unix)]
fn run_bounded(argv: Vec<String>, cwd: &Path, what: &str) -> (i32, String, String) {
	let cwd = cwd.to_path_buf();
	let (tx, rx) = std::sync::mpsc::channel();
	std::thread::spawn(move || {
		let argv: Vec<&str> = argv.iter().map(String::as_str).collect();
		let _ = tx.send(run(&argv, &cwd));
	});
	rx.recv_timeout(std::time::Duration::from_secs(60)).unwrap_or_else(|_| panic!("{what} hung"))
}

/// Under inc-recursion the sender's MSG_NO_SEND for the only file reaches the
/// receiving side while its receiver already waits for input; the receiver
/// forwards it to the generator in its next output pass, which completes the
/// segment, so the run ends with code 23 instead of hanging (rsync 3.5.1).
#[cfg(unix)]
#[test]
fn unreadable_only_file_is_a_partial_transfer() {
	let dir = tempfile::tempdir().unwrap();
	if !unreadable_only_file(dir.path()) {
		return;
	}
	let argv = vec!["-r".to_owned(), "m/file".to_owned(), "d1/".to_owned()];
	let (code, out, err) = run_bounded(argv, dir.path(), "local copy of an unreadable file");
	assert_eq!(code, 23, "{out}{err}");
	assert!(err.starts_with("rsync: [sender] send_files failed to open \""), "{err}");
	assert!(err.contains("m/file\": Permission denied (13)\n"), "{err}");
	assert!(
		err.ends_with(
			"rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1412) [sender=3.5.1]\n"
		),
		"{err}"
	);
	assert!(!dir.path().join("d1/file").exists());

	// The same from a reference `--server --sender`: our receiver forwards its
	// MSG_NO_SEND.
	let Some(rsync) = reference() else { return };
	let rsh = fake_rsh(dir.path());
	let argv = vec![
		"-r".to_owned(),
		"-e".to_owned(),
		rsh.to_str().unwrap().to_owned(),
		format!("--rsync-path={}", rsync.display()),
		format!("h:{}/m/file", dir.path().display()),
		"d2/".to_owned(),
	];
	let (code, out, err) = run_bounded(argv, dir.path(), "pull of an unreadable file");
	assert_eq!(code, 23, "{out}{err}");
	assert!(err.contains("send_files failed to open"), "{err}");
	assert!(
		err.ends_with(
			"rsync error: some files/attrs were not transferred (see previous errors) (code 23) at main.c(1983) [generator=3.5.1]\n"
		),
		"{err}"
	);
}

#[cfg(unix)]
#[test]
fn remote_error_exit_code_is_the_servers() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let rsh = fake_rsh(dir.path());
	let rpath = format!("--rsync-path={}", rsync.display());
	let source = format!("h:{}/nonexistent/", dir.path().display());
	let (code, _, err) = run(&["-r", "-e", rsh.to_str().unwrap(), &rpath, &source, "out/"], dir.path());
	assert_eq!(code, 23, "{err}");
	assert!(err.contains("change_dir"), "{err}");
	// Captured from rsync 3.5.1: after the trailer the client's MSG_ERROR_EXIT
	// meets the departed server (exit_cleanup's tail).
	assert!(
		err.ends_with(
			"(code 23) at main.c(1983) [Receiver=3.5.1]\nrsync: [Receiver] write error: Broken pipe (32)\n"
		),
		"{err}"
	);
}

#[test]
fn batch_write_then_read_round_trip() {
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, _, err) = run(&["-a", "--exclude=*.o", "--write-batch=b", "src/", "d1/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &dir.path().join("d1"));
	let script = fs::read_to_string(dir.path().join("b.sh")).unwrap();
	assert_eq!(script, "'rsync' --filter='._-' '-a' --read-batch='b' ${1:-'d1/'} <<'#E#'\n- *.o\n#E#\n");
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt;
		let mode = fs::metadata(dir.path().join("b.sh")).unwrap().permissions().mode() & 0o777;
		assert_eq!(mode, 0o700);
	}
	let (code, out, err) = run(&["-a", "-i", "--read-batch=b", "d2/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""), "{out}");
	assert_same_tree(&src, &dir.path().join("d2"));
	// --only-write-batch leaves the destination alone.
	let (code, out, _) = run(&["-a", "--only-write-batch=c", "-v", "src/", "d3/"], dir.path());
	assert_eq!(code, 0);
	assert!(!dir.path().join("d3").exists());
	assert!(out.trim_end().ends_with("(BATCH ONLY)"), "{out}");
	let (code, _, _) = run(&["-a", "--read-batch=c", "d3/"], dir.path());
	assert_eq!(code, 0);
	assert_same_tree(&src, &dir.path().join("d3"));
}

#[test]
fn batch_read_by_reference_rsync() {
	let Some(rsync) = reference() else { return };
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	make_tree(&src);
	let (code, _, _) = run(&["-a", "--only-write-batch=b", "src/", "d1/"], dir.path());
	assert_eq!(code, 0);
	let status = Command::new(&rsync).args(["-a", "--read-batch=b", "d1/"]).current_dir(dir.path()).status().unwrap();
	assert!(status.success());
	assert_same_tree(&src, &dir.path().join("d1"));
	// And the other way round.
	let status = Command::new(&rsync).args(["-a", "--only-write-batch=r", "src/", "d2/"]).current_dir(dir.path()).status().unwrap();
	assert!(status.success());
	let (code, _, err) = run(&["-a", "--read-batch=r", "d2/"], dir.path());
	assert_eq!((code, err.as_str()), (0, ""));
	assert_same_tree(&src, &dir.path().join("d2"));
}

#[test]
fn missing_source_is_a_partial_transfer() {
	let dir = tempfile::tempdir().unwrap();
	let (code, _, err) = run(&["-a", "nope", "dst/"], dir.path());
	assert_eq!(code, 23, "{err}");
	assert!(err.contains("link_stat"), "{err}");
	assert!(err.ends_with("(code 23) at main.c(1412) [sender=3.5.1]\n"), "{err}");
}

#[test]
fn fold_exit_precedence() {
	assert_eq!(fold_exit(0, IOERR_DEL_LIMIT | IOERR_VANISHED, false), RERR_VANISHED);
	assert_eq!(fold_exit(0, IOERR_VANISHED, true), crate::rsync::exit::RERR_PARTIAL);
	assert_eq!(fold_exit(0, IOERR_DEL_LIMIT, false), crate::rsync::exit::RERR_DEL_LIMIT);
	assert_eq!(fold_exit(12, IOERR_GENERAL, true), 12);
	assert_eq!(fold_exit(0, 0, false), 0);
}

#[test]
fn delete_excluded_position_counts_rules_before_it() {
	let argv: Vec<OsString> =
		["rsync", "-f- a", "--exclude", "b", "--delete-excluded", "--include=c", "x", "y"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 3), 2);
	let argv: Vec<OsString> = ["rsync", "--delete-excluded", "-f- a"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 1), 0);
	let argv: Vec<OsString> = ["rsync", "-e", "--delete-excluded", "-f- a"].iter().map(OsString::from).collect();
	assert_eq!(delete_excluded_position(&argv, 1), 1);
}

#[test]
fn d_option_hint_for_old_servers() {
	let buf = std::sync::Arc::new(Mutex::new(Vec::new()));
	struct Out(Arc<Mutex<Vec<u8>>>);
	impl Write for Out {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			lock(&self.0).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let logger = Logger::local(Box::new(io::sink()), Box::new(Out(Arc::clone(&buf))), LogConfig::default());
	check_for_d_option_error(&logger, b"rsync: on remote machine: -vde.LsfxC: unknown option");
	check_for_d_option_error(&logger, b"rsync: on remote machine: --dirs: unknown option");
	assert_eq!(&*lock(&buf), b"*** Try using \"--old-d\" if remote rsync is <= 2.6.3 ***\n");
}

#[test]
fn files_from_forwarding_collapses_lines() {
	let counters = IoCounters::default();
	struct Out(Arc<Mutex<Vec<u8>>>);
	impl Write for Out {
		fn write(&mut self, b: &[u8]) -> io::Result<usize> {
			lock(&self.0).extend_from_slice(b);
			Ok(b.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}
	let buf = Arc::new(Mutex::new(Vec::new()));
	let w = MuxWriter::new(Box::new(Out(Arc::clone(&buf))), counters, WriteConfig::default());
	// With -R the whole forwarded path is what was asked for.
	let implied = Mutex::new(ImpliedFilters::new(true, false, false));
	let src: Box<dyn Read + Send> = Box::new(&b"\n\na\r\n\nb/c\nlast"[..]);
	forward_files_from(src, &w, 31, false, Some(&implied), &AtomicBool::new(false)).unwrap();
	assert_eq!(&*lock(&buf), b"a\0b/c\0last\0\0");
	assert_eq!(lock(&implied).check(b"b/c", false), crate::rsync::filter::Verdict::Include);
}
