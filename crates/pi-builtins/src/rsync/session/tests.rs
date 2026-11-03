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

/// Escaping by printability is by the locale's `isprint`: rsync 3.5.1 under
/// `de_DE.ISO-8859-1`, where `c3` and `bc` both print (`Ã¼`), prints
/// `--bogus-ün` as it is. libc finds generated locale data only through a
/// `LOCPATH` the process was started with, so the check runs in a copy of
/// this test binary started with one.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn option_errors_print_the_bytes_the_locale_prints() {
	const LOCALES: &str = "OMP_RSYNC_TEST_LATIN1_LOCALES";
	if std::env::var_os(LOCALES).is_some() {
		let dir = tempfile::tempdir().unwrap();
		let mut env: Vec<(&str, String)> = crate::locale::inherited_search_path();
		env.push(("LC_ALL", "de_DE.ISO-8859-1".to_owned()));
		let env: Vec<(&str, &str)> = env.iter().map(|(key, value)| (*key, value.as_str())).collect();
		let (code, cap) = run_util_env::<Rsync>(&["--bogus-ün", "src/", "dst/"], "", dir.path(), &env);
		assert_eq!(code, 1);
		assert!(cap.err().starts_with("rsync: --bogus-ün: unknown option\n"), "{}", cap.err());
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let locale = dir.path().join("de_DE.ISO-8859-1");
	// `-c`: de_DE's source names characters ISO-8859-1 lacks, which is a warning.
	let _ = Command::new("localedef").args(["-c", "-i", "de_DE", "-f", "ISO-8859-1"]).arg(&locale).output();
	if !locale.join("LC_CTYPE").exists() {
		return;
	}
	let output = Command::new(std::env::current_exe().expect("test binary"))
		.args(["--exact", "rsync::session::tests::option_errors_print_the_bytes_the_locale_prints"])
		.env("LOCPATH", dir.path())
		.env(LOCALES, dir.path())
		.output()
		.expect("the test binary runs");
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		output.status.success() && stdout.contains(" 1 passed;"),
		"{stdout}{}",
		String::from_utf8_lossy(&output.stderr)
	);
}

/// A locale search path the shell exports after omp started is not read,
/// because libc takes one from the process environment only. The codeset
/// then comes from the locale's name, and the run says so on standard error
/// once — a local copy builds three loggers — while a run that prints
/// nothing through the locale (`-8`) neither reads it nor reports it, unless
/// `--iconv` asks for the locale's charset (`--iconv=.`); a charset named
/// outright (`--iconv=UTF-8`) needs no lookup either.
///
/// That is the documented limit: a name that spells its codeset keeps it
/// (`….ISO-8859-1` prints the name's bytes), and a bare alias reads as the
/// C locale's ASCII and escapes them, where the reference, finding the
/// alias through the shell's `LOCPATH`, may print them. musl reads no
/// search-path variable that changes an answer, so it has no such limit.
#[cfg(all(unix, not(target_env = "musl")))]
#[test]
fn a_search_path_only_the_shell_exports_is_read_from_the_name_and_reported_once() {
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("src")).unwrap();
	fs::write(dir.path().join("src/ünï.txt"), b"x\n").unwrap();
	let warnings = |err: &str| err.matches("rsync: warning: cannot read the locale").count();
	let run_with = |locale: &str, options: &[&str], dest: &str| {
		let mut argv = options.to_vec();
		argv.extend(["src/ünï.txt", dest]);
		let env = [("LC_ALL", locale), ("LOCPATH", "/nonexistent-shell-only-locales")];
		run_util_env::<Rsync>(&argv, "", dir.path(), &env)
	};
	let (code, cap) = run_with("omp_rsync_latin1.ISO-8859-1", &["-ai"], "dst-named/");
	assert_eq!(code, 0, "{}", cap.err());
	assert!(cap.out().contains(">f+++++++++ ünï.txt"), "{}", cap.out());
	assert_eq!(warnings(&cap.err()), 1, "{}", cap.err());
	assert!(cap.err().contains("the shell's LOCPATH is not the one omp was started with"), "{}", cap.err());
	let (code, cap) = run_with("omp_rsync_latin1", &["-ai"], "dst-bare/");
	assert_eq!(code, 0, "{}", cap.err());
	assert!(cap.out().contains(">f+++++++++ \\#303\\#274n\\#303\\#257.txt"), "{}", cap.out());
	assert_eq!(warnings(&cap.err()), 1, "{}", cap.err());
	let (code, cap) = run_with("omp_rsync_latin1", &["-ai", "-8"], "dst-8bit/");
	assert_eq!(code, 0, "{}", cap.err());
	assert!(cap.out().contains(">f+++++++++ ünï.txt"), "{}", cap.out());
	assert_eq!(warnings(&cap.err()), 0, "{}", cap.err());
	let (code, cap) = run_with("C.UTF-8", &["-ai", "-8", "--iconv=UTF-8"], "dst-iconv-named/");
	assert_eq!(code, 0, "{}", cap.err());
	assert_eq!(warnings(&cap.err()), 0, "a charset named outright needs no locale: {}", cap.err());
	let (code, cap) = run_with("C.UTF-8", &["-ai", "-8", "--iconv=."], "dst-iconv-locale/");
	assert_eq!(code, 0, "{}", cap.err());
	assert_eq!(warnings(&cap.err()), 1, "the locale's charset is looked up once: {}", cap.err());
}

/// A locale libc could not be asked about is not an observation of the C
/// locale: reading it as one put a newline inside `é`, where GNU `fold -w1`
/// on `LC_ALL=C.UTF-8` gives `c3 a9`. The name stands, and the lookup says
/// why it was not made.
#[cfg(all(unix, not(target_env = "musl")))]
#[test]
fn an_unreadable_shell_locale_keeps_its_name_and_says_so() {
	let dir = tempfile::tempdir().unwrap();
	let (mut host, capture) = crate::host::Host::for_test("fold", "", dir.path());
	host.set_test_var("LC_ALL", "C.UTF-8");
	host.set_test_var("LOCPATH", "/nonexistent-shell-only-locales");
	assert!(crate::locale::ctype_is_utf8(&host), "an unread locale is not the C locale");
	let err = String::from_utf8_lossy(&capture.stderr()).into_owned();
	assert!(err.contains("cannot read the locale \"C.UTF-8\"") && err.contains("LOCPATH"), "{err}");
}

/// Every caller of [`crate::locale::locale_loadable`] models
/// `setlocale(CATEGORY, "")`, which takes a name whole where glibc's
/// `newlocale` splits one carrying a `;` per category.
///
/// Measured: with no data named `LC_CTYPE=C;LC_TIME=C.UTF-8` the reference
/// reports `ANSI_X3.4-1968` and `fold -w1` splits the two bytes of `é`,
/// while `newlocale` loads that name and its `.UTF-8` tail reads as a UTF-8
/// locale. musl's `newlocale` takes the name whole, as its `setlocale` does.
#[cfg(all(unix, not(target_env = "musl")))]
#[test]
fn a_composite_looking_name_is_not_loadable() {
	let name = "LC_CTYPE=C;LC_TIME=C.UTF-8";
	assert!(!crate::locale::locale_loadable(name, libc::LC_CTYPE_MASK));
	let ours = |key: &str| std::env::var(key).ok();
	let codeset = crate::locale::loaded_codeset(name, &ours, &std::sync::atomic::AtomicBool::new(false));
	assert!(matches!(codeset, crate::locale::Codeset::Unloadable), "{codeset:?}");
	let dir = tempfile::tempdir().unwrap();
	let (mut host, _) = crate::host::Host::for_test("fold", "", dir.path());
	for (key, value) in crate::locale::inherited_search_path() {
		host.set_test_var(key, &value);
	}
	host.set_test_var("LC_CTYPE", name);
	assert!(!crate::locale::ctype_is_utf8(&host), "a name that loads nothing is not a UTF-8 locale");
}

/// GNU utilities initialise with `setlocale(LC_ALL, "")`, which fails as a
/// whole when one category's data is missing — and then they run in C.
///
/// Measured against GNU fold 9.12 and sort 9.4: with `LC_ALL` naming a
/// locale that holds only `LC_CTYPE`, `fold -w1` splits `é`; with one that
/// holds only `LC_NUMERIC`, `sort -sn` uses the C decimal point.
///
/// libc finds generated locale data only through a `LOCPATH` the process
/// was started with, so the check runs in a copy of this test binary
/// started with one, rather than by changing this process's environment
/// while other tests read it.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn a_locale_missing_a_category_leaves_the_utilities_in_c() {
	const LOCALES: &str = "OMP_RSYNC_TEST_GENERATED_LOCALES";
	// The shell carries this process's search path, which in the copy of
	// the binary started below holds the generated locales.
	let shell = |name: &str| {
		let (mut host, _) = crate::host::Host::for_test("fold", "", std::env::temp_dir());
		for (key, value) in crate::locale::inherited_search_path() {
			host.set_test_var(key, &value);
		}
		host.set_test_var("LC_ALL", name);
		host
	};
	if std::env::var_os(LOCALES).is_some() {
		assert!(
			!crate::locale::ctype_is_utf8(&shell("de_DE@partial_ctype")),
			"a locale with no LC_NUMERIC leaves fold in C"
		);
		assert_eq!(
			crate::locale::numeric_symbols(&shell("de_DE@partial_numeric")),
			crate::locale::NumericSymbols::C,
			"a locale with no LC_CTYPE leaves sort in C"
		);
		// The control: the same generation with every category kept does
		// initialise, and its numerics are the locale's.
		assert_ne!(crate::locale::numeric_symbols(&shell("de_DE@whole")), crate::locale::NumericSymbols::C);
		// `sort -M` reads the month names of the shell's `LC_TIME`, not of
		// this process (whose locale is not German): May is `Mai` and October
		// `Okt`, matched uppercased.
		let months = crate::sort::locale_month_names(&shell("de_DE@whole"), &std::sync::atomic::AtomicBool::new(false))
			.expect("the generated locale's month names");
		assert_eq!((months.names[4].as_slice(), months.names[9].as_slice()), (&b"MAI"[..], &b"OKT"[..]));
		// A locale environment that leaves C has the C names.
		assert!(crate::sort::locale_month_names(&shell("de_DE@partial_ctype"), &std::sync::atomic::AtomicBool::new(false)).is_none());
		// And `sort -M` sorts by them: März before Dezember. With the C names
		// both are unknown and the lines compare as bytes, `Dez` first.
		let mut env: Vec<(&str, String)> = crate::locale::inherited_search_path();
		env.push(("LC_ALL", "de_DE@whole".to_owned()));
		let env: Vec<(&str, &str)> = env.iter().map(|(key, value)| (*key, value.as_str())).collect();
		let (code, cap) = run_util_env::<crate::sort::Sort>(&["-M"], "Dez\nM\u{e4}r\n", &std::env::temp_dir(), &env);
		assert_eq!((code, cap.out()), (0, "M\u{e4}r\nDez\n".to_owned()), "{}", cap.err());
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let generate = |name: &str, keep: Option<&str>| {
		let built = Command::new("localedef")
			.args(["-i", "de_DE", "-f", "UTF-8"])
			.arg(dir.path().join(name))
			.output()
			.is_ok_and(|built| built.status.success());
		if let (true, Some(keep)) = (built, keep) {
			for left in fs::read_dir(dir.path().join(name)).unwrap() {
				let left = left.unwrap();
				if left.file_name() == keep {
					continue;
				}
				match left.file_type().unwrap().is_dir() {
					true => fs::remove_dir_all(left.path()).unwrap(),
					false => fs::remove_file(left.path()).unwrap(),
				}
			}
		}
		built
	};
	let generated = generate("de_DE@partial_ctype", Some("LC_CTYPE"))
		&& generate("de_DE@partial_numeric", Some("LC_NUMERIC"))
		&& generate("de_DE@whole", None);
	if !generated {
		return;
	}
	let output = Command::new(std::env::current_exe().expect("test binary"))
		.args(["--exact", "rsync::session::tests::a_locale_missing_a_category_leaves_the_utilities_in_c"])
		.env("LOCPATH", dir.path())
		.env(LOCALES, dir.path())
		.output()
		.expect("the test binary runs");
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		output.status.success() && stdout.contains(" 1 passed;"),
		"{stdout}{}",
		String::from_utf8_lossy(&output.stderr)
	);
}

/// Locale data that never arrives — here an `LC_CTYPE` that is a FIFO
/// nobody writes to — holds up neither the command whose locale it is nor
/// another command's.
///
/// libc keeps one lock for every locale load in the process while a load
/// waits, so before this a cancelled command stayed blocked in `openat`
/// and a fresh shell's `LC_ALL=C.UTF-8` hung behind it until the FIFO was
/// opened. Now the cancelled command returns at once and, as the reference
/// ends on its signal, prints nothing about its locale; the other answers
/// without libc once the stuck load has run for a second, and says why;
/// and when the data arrives, libc answers again.
///
/// The search path has to be the process's own for the lookup to happen
/// at all, so the check runs in a copy of this test binary started with
/// it.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn locale_data_that_never_arrives_holds_up_neither_its_command_nor_another() {
	use std::sync::Arc;
	use std::sync::atomic::{AtomicBool, Ordering};
	use std::sync::mpsc;
	use std::time::{Duration, Instant};

	const FIFO: &str = "OMP_RSYNC_TEST_FIFO_LOCALE";
	if let Ok(fifo) = std::env::var(FIFO) {
		let ours = |key: &str| std::env::var(key).ok();
		let lookup = |name: &'static str, cancel: Arc<AtomicBool>| {
			let (answered, answer) = mpsc::channel();
			std::thread::spawn(move || {
				let started = Instant::now();
				let codeset = crate::locale::loaded_codeset(name, &|key| std::env::var(key).ok(), &cancel);
				let _ = answered.send((format!("{codeset:?}"), started.elapsed()));
			});
			answer
		};
		// The command whose locale is the FIFO is cancelled 200 ms in. Its run
		// reads the locale charset as the name spells it and has no warning
		// to print: its standard error ends with the signal trailer alone.
		let cancel = Arc::new(AtomicBool::new(false));
		let (answered, blocked) = mpsc::channel();
		let flag = Arc::clone(&cancel);
		std::thread::spawn(move || {
			let started = Instant::now();
			let env = |key: &str| if key == "LC_ALL" { Some("fifo.UTF-8".to_owned()) } else { std::env::var(key).ok() };
			let locale = crate::rsync::iconv::locale_charset(&env, &flag);
			let _ = answered.send((locale.charset, locale.warning, started.elapsed()));
		});
		std::thread::sleep(Duration::from_millis(200));
		cancel.store(true, Ordering::Relaxed);
		let (charset, warning, took) = blocked.recv_timeout(Duration::from_secs(5)).expect("the cancelled lookup returns");
		assert_eq!((charset.as_str(), warning), ("UTF-8", None), "after {took:?}");
		assert!(took < Duration::from_secs(2), "{took:?}");
		// Another command's lookup of a locale that loads is held up at most
		// until the stuck load has run for a second, and says why.
		let other = lookup("C.UTF-8", Arc::new(AtomicBool::new(false)));
		let (codeset, took) = other.recv_timeout(Duration::from_secs(5)).expect("another command's lookup returns");
		assert!(codeset.contains("has not finished") && took < Duration::from_secs(2), "{codeset} after {took:?}");
		// So does a `sort -M` that needs the month names: it goes on with the C
		// names, and nothing is cached for the next sort.
		let (mut sort_shell, _) = crate::host::Host::for_test("sort", "", std::env::temp_dir());
		for (key, value) in crate::locale::inherited_search_path() {
			sort_shell.set_test_var(key, &value);
		}
		sort_shell.set_test_var("LC_ALL", "C.UTF-8");
		let started = Instant::now();
		let months = crate::sort::locale_month_names(&sort_shell, &AtomicBool::new(false));
		let took = started.elapsed();
		assert!(took < Duration::from_secs(2) && months.is_none(), "after {took:?}");
		// The data arrives (a writer opens the FIFO and closes it), the stuck
		// load ends, and libc answers again.
		drop(fs::OpenOptions::new().write(true).open(&fifo).unwrap());
		let deadline = Instant::now() + Duration::from_secs(5);
		loop {
			let codeset = crate::locale::loaded_codeset("C", &ours, &AtomicBool::new(false));
			if matches!(&codeset, crate::locale::Codeset::Loaded(..)) {
				break;
			}
			assert!(Instant::now() < deadline, "libc never answered again: {codeset:?}");
			std::thread::sleep(Duration::from_millis(50));
		}
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	fs::create_dir_all(dir.path().join("fifo.UTF-8")).unwrap();
	let fifo = dir.path().join("fifo.UTF-8/LC_CTYPE");
	nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
	let output = Command::new(std::env::current_exe().expect("test binary"))
		.args(["--exact", "rsync::session::tests::locale_data_that_never_arrives_holds_up_neither_its_command_nor_another"])
		.env("LOCPATH", dir.path())
		.env(FIFO, &fifo)
		.output()
		.expect("the test binary runs");
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		output.status.success() && stdout.contains(" 1 passed;"),
		"{stdout}{}",
		String::from_utf8_lossy(&output.stderr)
	);
}

/// The same for conversion data: `iconv_open` reads `gconv-modules` from the
/// search path, here a FIFO nobody writes to, under a lock glibc keeps for
/// the whole process. Opening the message check of a non-UTF-8 locale
/// charset (upstream's `ic_chck`) and an explicit `--iconv` charset each go
/// through the same guard as the locale loads: the cancelled command returns
/// at once, another command answers within about a second and says why, and
/// when the data arrives the conversion opens.
///
/// glibc reads `GCONV_PATH` from the process environment once, so the check
/// runs in a copy of this test binary started with it.
#[cfg(all(target_os = "linux", target_env = "gnu"))]
#[test]
fn conversion_data_that_never_arrives_holds_up_neither_its_command_nor_another() {
	use std::sync::Arc;
	use std::sync::atomic::{AtomicBool, Ordering};
	use std::sync::mpsc;
	use std::time::{Duration, Instant};

	use crate::rsync::iconv::{Iconv, MsgCharset};

	const FIFO: &str = "OMP_RSYNC_TEST_FIFO_GCONV";
	if let Ok(fifo) = std::env::var(FIFO) {
		// The command whose locale charset is ISO-8859-1 is cancelled 200 ms in.
		let cancel = Arc::new(AtomicBool::new(false));
		let (answered, answer) = mpsc::channel();
		let flag = Arc::clone(&cancel);
		std::thread::spawn(move || {
			let started = Instant::now();
			let check = MsgCharset::for_locale("ISO-8859-1", &crate::locale::C_PRINTABLE, &flag).err();
			let _ = answered.send((check, started.elapsed()));
		});
		std::thread::sleep(Duration::from_millis(200));
		cancel.store(true, Ordering::Relaxed);
		let (why, took) = answer.recv_timeout(Duration::from_secs(5)).expect("the cancelled open returns");
		assert!(matches!(why, Some(crate::locale::NoAnswer::Cancelled)) && took < Duration::from_secs(2), "{why:?} after {took:?}");
		// Another command's `--iconv` open is held up at most until the stuck
		// open has run for a second, and says why.
		let started = Instant::now();
		let err = Iconv::with_locale(b"ISO-8859-1", false, None, &AtomicBool::new(false)).unwrap_err();
		let message = err.message.unwrap_or_default();
		assert!(
			message.starts_with("iconv_open(\"UTF-8\", \"ISO-8859-1\") failed: ") && message.contains("has not finished"),
			"{message}"
		);
		assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
		// The data arrives (a writer opens the FIFO and closes it), and the
		// conversion opens again.
		drop(fs::OpenOptions::new().write(true).open(&fifo).unwrap());
		let deadline = Instant::now() + Duration::from_secs(5);
		while !matches!(
			MsgCharset::for_locale("ISO-8859-1", &crate::locale::C_PRINTABLE, &AtomicBool::new(false)),
			Ok(MsgCharset::Other(_))
		) {
			assert!(Instant::now() < deadline, "the conversion never opened again");
			std::thread::sleep(Duration::from_millis(50));
		}
		return;
	}
	let dir = tempfile::tempdir().unwrap();
	let fifo = dir.path().join("gconv-modules");
	nix::unistd::mkfifo(&fifo, nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
	let output = Command::new(std::env::current_exe().expect("test binary"))
		.args(["--exact", "rsync::session::tests::conversion_data_that_never_arrives_holds_up_neither_its_command_nor_another"])
		.env("GCONV_PATH", dir.path())
		.env(FIFO, &fifo)
		.output()
		.expect("the test binary runs");
	let stdout = String::from_utf8_lossy(&output.stdout);
	assert!(
		output.status.success() && stdout.contains(" 1 passed;"),
		"{stdout}{}",
		String::from_utf8_lossy(&output.stderr)
	);
}

/// A command already cancelled starts no locale load: nothing would use the
/// answer, and its cancellation is all its run reports.
#[test]
fn a_cancelled_command_starts_no_locale_load() {
	use std::sync::Arc;
	use std::sync::atomic::{AtomicBool, Ordering};

	let ran = Arc::new(AtomicBool::new(false));
	let flag = Arc::clone(&ran);
	let answer = crate::locale::libc_locale_load(&AtomicBool::new(true), move || flag.store(true, Ordering::Relaxed));
	assert!(matches!(answer, Err(crate::locale::NoAnswer::Cancelled)), "{answer:?}");
	assert!(!ran.load(Ordering::Relaxed), "the load ran");
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

/// rsync 3.5.1 opens a conversion `--iconv` names right after it starts the
/// other side and before the protocol exchange, so one iconv refuses fails the
/// run first: with `--protocol=19` it exits 4 for the conversion, never 2 for
/// the protocol. A side whose own conversion is refused (`UTF-8,INVALID`, the
/// server's half) ends before sending its version, and the client reports the
/// connection closed: exit 12. Both captured from rsync 3.5.1 (30 runs each:
/// always these codes, the second always this output).
#[test]
fn a_refused_conversion_fails_before_the_protocol_exchange() {
	let dir = tempfile::tempdir().unwrap();
	make_tree(&dir.path().join("src"));
	let (code, _, err) = run(&["--protocol=19", "--iconv=INVALID", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 4, "{err}");
	assert!(err.contains("iconv_open(\"UTF-8\", \"INVALID\") failed\n"), "{err}");
	assert!(err.contains("rsync error: requested action not supported (code 4) at rsync.c(134) [sender=3.5.1]\n"), "{err}");
	assert!(!err.contains("protocol version mismatch"), "{err}");
	let (code, _, err) = run(&["--iconv=UTF-8,INVALID", "-a", "src/", "d/"], dir.path());
	assert_eq!(code, 12, "{err}");
	assert_eq!(
		err,
		"iconv_open(\"UTF-8\", \"INVALID\") failed\n\
		 rsync error: requested action not supported (code 4) at rsync.c(134) [Receiver=3.5.1]\n\
		 rsync: connection unexpectedly closed (0 bytes received so far) [sender]\n\
		 rsync error: error in rsync protocol data stream (code 12) at io.c(303) [sender=3.5.1]\n"
	);
}

/// A received name the `--iconv` conversion refuses becomes empty, as in
/// rsync 3.5.1's recv_file_entry, so nothing is created under the name as
/// sent. Captured from rsync 3.5.1 under `LC_ALL=C` (20 runs, always so):
/// with `é` and `plain` at the top, `--iconv=UTF-8,` reports the name, copies
/// `plain` and exits 23, and does not itemize `./` as new (the empty, inactive
/// entry sorts first, so main.c's `files[low]` is not `.`); refused by the
/// sender instead (`--iconv=,UTF-8`) the name is never sent and `./` is
/// itemized, as it is in a dry run (`-n`) of the first copy, which makes no
/// directory. With `sub/é2` in an incremental list the empty name is outside
/// `sub`, which aborts the transfer (exit 4) as the receiver, once.
///
/// Not on musl: its iconv writes `*` for a character the charset lacks
/// instead of refusing it ([`crate::rsync::iconv`]'s
/// `invalid_sequence_is_reported`), as for rsync built against musl, so a
/// local copy has no name to refuse.
#[cfg(not(target_env = "musl"))]
#[test]
fn a_received_name_the_conversion_refuses_creates_nothing() {
	let eilseq = crate::rsync::log::strerror(&std::io::Error::from_raw_os_error(libc::EILSEQ));
	let run = |argv: &[&str], cwd: &Path| {
		let (code, cap) = run_util_env::<Rsync>(argv, "", cwd, &[("LC_ALL", "C")]);
		(code, cap.out(), cap.err())
	};
	let dir = tempfile::tempdir().unwrap();
	let src = dir.path().join("src");
	fs::create_dir_all(&src).unwrap();
	fs::write(src.join("\u{e9}"), b"x").unwrap();
	fs::write(src.join("plain"), b"y").unwrap();
	let (code, out, err) = run(&["-ai", "--iconv=UTF-8,", "src/", "d1/"], dir.path());
	assert_eq!(code, 23, "{out}{err}");
	assert_eq!(out, "created directory d1\n>f+++++++++ plain\n");
	assert!(err.starts_with(&format!("[Receiver] cannot convert filename: \\#303\\#251 ({eilseq})\n")), "{err}");
	let names: Vec<_> = fs::read_dir(dir.path().join("d1")).unwrap().map(|e| e.unwrap().file_name()).collect();
	assert_eq!(names, [std::ffi::OsString::from("plain")]);
	let (code, out, err) = run(&["-ai", "--iconv=,UTF-8", "src/", "d3/"], dir.path());
	assert_eq!(code, 23, "{out}{err}");
	assert_eq!(out, "created directory d3\ncd+++++++++ ./\n>f+++++++++ plain\n");
	assert!(err.starts_with(&format!("[sender] cannot convert filename: \\#303\\#251 ({eilseq})\n")), "{err}");
	// A dry run makes no directory, so the generator finds `./` missing.
	let (code, out, err) = run(&["-ain", "--iconv=UTF-8,", "src/", "d4/"], dir.path());
	assert_eq!(code, 23, "{out}{err}");
	assert_eq!(out, "created directory d4\ncd+++++++++ ./\n>f+++++++++ plain\n");
	assert!(err.starts_with(&format!("[Receiver] cannot convert filename: \\#303\\#251 ({eilseq})\n")), "{err}");
	assert!(!dir.path().join("d4").exists());

	fs::create_dir_all(src.join("sub")).unwrap();
	fs::write(src.join("sub/\u{e9}2"), b"z").unwrap();
	let (code, out, err) = run(&["-ai", "--iconv=UTF-8,", "src/", "d2/"], dir.path());
	assert_eq!(code, 4, "{out}{err}");
	assert!(err.contains(&format!("[receiver] cannot convert filename: sub/\\#303\\#2512 ({eilseq})\n")), "{err}");
	assert_eq!(err.matches("ABORTING due to invalid path from sender: /\n").count(), 1, "{err}");
	assert!(err.ends_with("rsync error: requested action not supported (code 4) at flist.c(3230) [receiver=3.5.1]\n"), "{err}");
	let made: Vec<_> = walkdir_names(&dir.path().join("d2"));
	assert!(made.iter().all(|name| !name.contains('\u{e9}') && !name.contains("\\#")), "{made:?}");
}

/// Every path below `root`, relative to it.
#[cfg(not(target_env = "musl"))]
fn walkdir_names(root: &Path) -> Vec<String> {
	let mut names = Vec::new();
	let mut stack = vec![root.to_path_buf()];
	while let Some(dir) = stack.pop() {
		let Ok(entries) = fs::read_dir(&dir) else { continue };
		for entry in entries {
			let path = entry.unwrap().path();
			names.push(path.strip_prefix(root).unwrap().to_string_lossy().into_owned());
			if path.is_dir() {
				stack.push(path);
			}
		}
	}
	names
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
	// Adding the extras bumped dst's mtime; restore src's so only the deletions are itemized
	// rather than also `.d..t...... ./` whenever the writes crossed a timestamp tick.
	let src_mtime = fs::metadata(&src).unwrap().modified().unwrap();
	fs::set_times_nofollow(dir.path().join("dst"), fs::FileTimes::new().set_modified(src_mtime)).unwrap();
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
	// The batch file carries our protocol (33); an older reference refuses it.
	let version = Command::new(&rsync).arg("--version").output().unwrap();
	if !String::from_utf8_lossy(&version.stdout).contains("protocol version 33") {
		return;
	}
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
