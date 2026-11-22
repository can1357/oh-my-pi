//! `watchexec` against real directories and real commands.
//!
//! Each watch filters to `.trigger` files (or one named file), so changes
//! the system reports late for the freshly made temporary directory itself
//! run nothing.

use std::{
	ffi::OsString,
	fs,
	path::{Path, PathBuf},
	time::Duration,
};

use clap::Parser as _;
use omp_xfs::watch::Flags;

use super::{
	TimeSpan, Watchexec, attach_optional_values,
	events::{Change, FileType, FsEvent, Kind, environment},
	filter::{Discovery, Filterer, Homes, Settings},
	parse_signal, span_millis, span_seconds, split_words,
};

fn os(words: &[&str]) -> Vec<OsString> {
	words.iter().map(OsString::from).collect()
}

fn parse(words: &[&str]) -> Result<Watchexec, clap::Error> {
	let argv = std::iter::once("watchexec").chain(words.iter().copied());
	Watchexec::try_parse_from(attach_optional_values(argv.map(OsString::from).collect()))
}

#[test]
fn time_spans_take_units_and_bare_numbers_in_the_options_unit() {
	let span = |span, unitless| TimeSpan { span, unitless };
	assert_eq!(span_millis("300"), Ok(span(Duration::from_millis(300), true)));
	assert_eq!(span_seconds("5"), Ok(span(Duration::from_secs(5), true)));
	assert_eq!(span_seconds("0"), Ok(span(Duration::ZERO, false)));
	assert_eq!(span_seconds("0.5"), Ok(span(Duration::from_millis(500), true)));
	assert_eq!(span_millis("5sec 20ms"), Ok(span(Duration::from_millis(5020), false)));
	assert_eq!(span_seconds("2min 5s"), Ok(span(Duration::from_secs(125), false)));
	assert_eq!(span_seconds("1.5s"), Ok(span(Duration::from_millis(1500), false)));
	assert_eq!(span_millis("abc"), Err("expected number at 0".into()));
	assert_eq!(span_millis("5 parsecs").unwrap_err().split(',').next(), Some("unknown time unit \"parsecs\""));
	assert_eq!(span_millis(""), Err("value was empty".into()));
}

#[test]
fn signals_parse_by_full_name_short_name_and_number() {
	let term = super::signal_number("TERM");
	assert_eq!(term, 15);
	for spelling in ["SIGTERM", "sigterm", "TERM", "term", "15"] {
		assert_eq!(parse_signal(spelling), Ok(term), "{spelling}");
	}
	assert_eq!(parse_signal("usr1"), Ok(super::signal_number("USR1")));
	assert_eq!(parse_signal("KILL"), Ok(9));
	assert_eq!(
		parse_signal("BOGUS"),
		Err("invalid signal `BOGUS`: unknown control name".into())
	);
	assert_eq!(super::KilledBy(15).to_string(), "Terminate");
	assert_eq!(super::KilledBy(9).to_string(), "ForceStop");
	assert_eq!(super::KilledBy(11).to_string(), "Custom(11)");
}

#[test]
fn optional_values_never_swallow_the_command() {
	let attach = |words: &[&str]| attach_optional_values(os(words));
	assert_eq!(attach(&["watchexec", "-c", "make", "test"]), os(&["watchexec", "--clear=clear", "make", "test"]));
	assert_eq!(attach(&["watchexec", "-c", "reset", "make"]), os(&["watchexec", "--clear=reset", "make"]));
	assert_eq!(attach(&["watchexec", "-rc", "make"]), os(&["watchexec", "-r", "--clear=clear", "make"]));
	assert_eq!(attach(&["watchexec", "--poll", "make"]), os(&["watchexec", "--poll=30s", "make"]));
	assert_eq!(attach(&["watchexec", "--poll", "5s", "make"]), os(&["watchexec", "--poll=5s", "make"]));
	assert_eq!(
		attach(&["watchexec", "--log-file", "w.log", "-e", "c", "-c", "ls", "-c"]),
		os(&["watchexec", "--log-file=w.log", "-e", "c", "--clear=clear", "ls", "-c"])
	);
	// Values of other options and everything after `--` stay as they are.
	assert_eq!(attach(&["watchexec", "-w", "-c", "--", "-c"]), os(&["watchexec", "-w", "-c", "--", "-c"]));

	let parsed = parse(&["-c", "-r", "--poll", "-e", "rs,.toml", "make", "-c", "test"]).unwrap();
	assert_eq!(parsed.clear, Some(super::Clear::Clear));
	assert_eq!(parsed.poll.map(|poll| poll.span), Some(Duration::from_secs(30)));
	assert_eq!(parsed.exts, ["rs", ".toml"]);
	assert_eq!(parsed.command, os(&["make", "-c", "test"]));
	assert!(parsed.restart);
}

#[test]
fn usage_errors_are_claps() {
	let kind = |words: &[&str]| parse(words).unwrap_err().kind();
	assert_eq!(kind(&[]), clap::error::ErrorKind::MissingRequiredArgument);
	assert_eq!(kind(&["--no-meta", "--fs-events", "create", "true"]), clap::error::ErrorKind::ArgumentConflict);
	assert_eq!(kind(&["--only-emit-events", "true"]), clap::error::ErrorKind::ArgumentConflict);
	assert_eq!(kind(&["-o", "bogus", "true"]), clap::error::ErrorKind::InvalidValue);
	assert_eq!(kind(&["-E", "FOO", "true"]), clap::error::ErrorKind::ValueValidation);
	assert_eq!(kind(&["--stop-signal", "BOGUS", "true"]), clap::error::ErrorKind::ValueValidation);
	// Options watchexec has and this one lacks go to the host's program.
	assert_eq!(kind(&["--socket", "8080", "true"]), clap::error::ErrorKind::UnknownArgument);
	assert!(parse(&["--only-emit-events"]).is_ok());
	assert!(parse(&["--completions", "zsh"]).is_ok());
	assert_eq!(split_words("zsh -x -o 'a b' c\\ d"), os(&["zsh", "-x", "-o", "a b", "c d"]));
}

fn change(path: &str, kind: Kind, file_type: Option<FileType>) -> Change {
	Change { path: PathBuf::from(path), kind, file_type }
}

#[test]
fn events_take_watchexecs_text_json_and_environment_forms() {
	let mut changes = Vec::new();
	Change::expand(
		Path::new("/p/src/a.rs"),
		Flags::CREATED | Flags::UPDATED | Flags::IS_FILE,
		&mut changes,
	);
	Change::expand(
		Path::new("/p/src/old.rs"),
		Flags::RENAMED | Flags::MOVED_FROM | Flags::IS_FILE,
		&mut changes,
	);
	Change::expand(Path::new("/p/docs"), Flags::REMOVED | Flags::IS_DIR, &mut changes);
	assert_eq!(changes, [
		change("/p/src/a.rs", Kind::Create, Some(FileType::File)),
		change("/p/src/a.rs", Kind::Data, Some(FileType::File)),
		change("/p/src/old.rs", Kind::RenameFrom, Some(FileType::File)),
		change("/p/docs", Kind::Remove, Some(FileType::Dir)),
	]);

	let mut text = String::new();
	for change in &changes {
		change.write_text(&mut text);
	}
	assert_eq!(text, "create:/p/src/a.rs\nmodify:/p/src/a.rs\nrename:/p/src/old.rs\nremove:/p/docs\n");

	let mut json = String::new();
	changes[0].write_json(&mut json);
	changes[3].write_json(&mut json);
	assert_eq!(
		json,
		concat!(
			r#"{"tags":[{"kind":"source","source":"filesystem"},{"kind":"fs","simple":"create","full":"Create(File)"},{"kind":"path","absolute":"/p/src/a.rs","filetype":"file"}]}"#,
			"\n",
			r#"{"tags":[{"kind":"source","source":"filesystem"},{"kind":"fs","simple":"remove","full":"Remove(Folder)"},{"kind":"path","absolute":"/p/docs","filetype":"dir"}]}"#,
			"\n",
		)
	);
	assert_eq!(
		changes[2].describe(2),
		"[EVENT 2] Event source=Filesystem kind=Modify(Name(From)) path=/p/src/old.rs filetype=file"
	);

	let separator = if cfg!(windows) { ";" } else { ":" };
	let mut variables = environment(&changes);
	variables.sort_unstable();
	assert_eq!(variables, [
		("WATCHEXEC_COMMON_PATH", "/p".to_owned()),
		("WATCHEXEC_CREATED_PATH", "src/a.rs".to_owned()),
		("WATCHEXEC_REMOVED_PATH", "docs".to_owned()),
		("WATCHEXEC_RENAMED_PATH", "src/old.rs".to_owned()),
		("WATCHEXEC_WRITTEN_PATH", "src/a.rs".to_owned()),
	]);
	// One file: the common path is its directory.
	let one = [
		change("/p/src/b.rs", Kind::Metadata, Some(FileType::File)),
		change("/p/src/a.rs", Kind::Metadata, Some(FileType::File)),
	];
	assert_eq!(environment(&one), [
		("WATCHEXEC_META_CHANGED_PATH", format!("a.rs{separator}b.rs")),
		("WATCHEXEC_COMMON_PATH", "/p/src".to_owned()),
	]);
	assert!(environment(&[]).is_empty());
}

/// A project with a `.git` directory and the given files.
fn project(files: &[(&str, &str)]) -> (tempfile::TempDir, PathBuf) {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path().canonicalize().unwrap();
	fs::create_dir(root.join(".git")).unwrap();
	for (name, content) in files {
		let path = root.join(name);
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(path, content).unwrap();
	}
	(dir, root)
}

fn settings(origin: &Path) -> Settings {
	Settings {
		origin:         origin.to_path_buf(),
		fs_events:      vec![FsEvent::Create, FsEvent::Remove, FsEvent::Rename, FsEvent::Modify, FsEvent::Metadata],
		filters:        Vec::new(),
		ignores:        Vec::new(),
		extensions:     Vec::new(),
		default_ignore: true,
		discovery:      Some(Discovery { vcs: true, project: true, global: true }),
		ignore_files:   Vec::new(),
		watched_files:  Vec::new(),
		homes:          Homes { home: None, xdg_config: None, appdata: None },
	}
}

/// Whether a write to the file `name` below `root` passes `filterer`.
fn passes(filterer: &Filterer, root: &Path, name: &str) -> bool {
	filterer.passes(&Change { path: root.join(name), kind: Kind::Data, file_type: Some(FileType::File) })
}

#[test]
fn filters_ignores_and_extensions_decide_as_watchexec_does() {
	let (_dir, root) = project(&[]);
	let fs = omp_vfs::BlockingFs::native();

	let plain = Filterer::new(&fs, settings(&root));
	assert!(passes(&plain, &root, "src/main.rs"));
	// Default ignores: version control innards, editor droppings, bytecode.
	for ignored in [".git/index", "sub/.git/HEAD", "src/.main.rs.swp", "pkg/mod.pyc", ".DS_Store", "a/.DS_Store"] {
		assert!(!passes(&plain, &root, ignored), "{ignored}");
	}
	let nothing = Filterer::new(&fs, Settings { default_ignore: false, ..settings(&root) });
	assert!(passes(&nothing, &root, ".git/index"));

	let extensions = Filterer::new(&fs, Settings {
		extensions: vec!["rs".into(), "toml".into()],
		..settings(&root)
	});
	assert!(passes(&extensions, &root, "src/main.rs") && passes(&extensions, &root, "Cargo.toml"));
	assert!(!passes(&extensions, &root, "README.md") && !passes(&extensions, &root, "Makefile"));
	let directory = Change { path: root.join("dir.rs"), kind: Kind::Create, file_type: Some(FileType::Dir) };
	assert!(!extensions.passes(&directory));

	// A pattern without a slash matches a name at any depth; one with a
	// slash is relative to the origin. Ignores beat filters.
	let patterns = Filterer::new(&fs, Settings {
		filters: vec!["*.rs".into(), "/docs/**".into()],
		ignores: vec!["generated*".into(), "target/**".into()],
		..settings(&root)
	});
	assert!(passes(&patterns, &root, "src/deep/lib.rs") && passes(&patterns, &root, "docs/a/b.md"));
	assert!(!passes(&patterns, &root, "src/notes.md") && !passes(&patterns, &root, "sub/docs/b.md"));
	assert!(!passes(&patterns, &root, "src/generated.rs") && !passes(&patterns, &root, "target/debug/x.rs"));

	// A file watched by name passes whatever the patterns say.
	let named = Filterer::new(&fs, Settings {
		extensions: vec!["rs".into()],
		watched_files: vec![root.join("config.toml")],
		..settings(&root)
	});
	assert!(passes(&named, &root, "config.toml") && !passes(&named, &root, "other.toml"));

	// `--fs-events` selects kinds; lost events pass whatever the filters.
	let no_meta = Filterer::new(&fs, Settings {
		fs_events: vec![FsEvent::Create, FsEvent::Modify],
		extensions: vec!["rs".into()],
		..settings(&root)
	});
	let event = |kind| Change { path: root.join("a.rs"), kind, file_type: Some(FileType::File) };
	assert!(no_meta.passes(&event(Kind::Create)) && no_meta.passes(&event(Kind::Data)));
	assert!(!no_meta.passes(&event(Kind::Metadata)) && !no_meta.passes(&event(Kind::Remove)));
	assert!(!plain.passes(&event(Kind::CloseWrite)), "access events are off unless asked for");
	let overflow = |dir: &str| Change { path: root.join(dir), kind: Kind::Other, file_type: Some(FileType::Dir) };
	assert!(no_meta.passes(&overflow("src")) && !no_meta.passes(&overflow(".git/objects")));
}

#[test]
fn ignore_files_apply_from_the_origin_down_and_can_be_switched_off() {
	let (dir, root) = project(&[
		(".gitignore", "target/\n*.log\n!keep.log\n"),
		(".ignore", "scratch/\n"),
		(".git/info/exclude", "excluded.txt\n"),
		("sub/.gitignore", "local.txt\n!important.log\n"),
		("home/.gitignore", "global.txt\n"),
		("home/.watchexec/ignore", "mine.txt\n"),
		("extra.ignore", "extra.txt\n"),
	]);
	let fs = omp_vfs::BlockingFs::native();
	let home = root.join("home").to_string_lossy().into_owned();
	let with = |discovery, ignore_files| {
		Filterer::new(&fs, Settings {
			discovery,
			ignore_files,
			homes: Homes { home: Some(home.clone()), xdg_config: None, appdata: None },
			..settings(&root)
		})
	};
	let all = Some(Discovery { vcs: true, project: true, global: true });

	let filterer = with(all, vec![root.join("extra.ignore")]);
	for ignored in [
		"target/debug/app",
		"build.log",
		"sub/deep/trace.log",
		"scratch/notes.txt",
		"excluded.txt",
		"sub/local.txt",
		"global.txt",
		"mine.txt",
		"extra.txt",
	] {
		assert!(!passes(&filterer, &root, ignored), "{ignored} should be ignored");
	}
	for kept in ["src/main.rs", "keep.log", "sub/important.log", "local.txt"] {
		assert!(passes(&filterer, &root, kept), "{kept} should pass");
	}
	// Directories nothing can pass in get no watch.
	assert!(!filterer.watches(&root.join("target")) && !filterer.watches(&root.join(".git")));
	assert!(filterer.watches(&root.join("src")) && filterer.watches(&root.join("sub")));

	let no_vcs = with(Some(Discovery { vcs: false, project: true, global: true }), Vec::new());
	assert!(passes(&no_vcs, &root, "build.log") && passes(&no_vcs, &root, "global.txt"));
	assert!(!passes(&no_vcs, &root, "scratch/notes.txt") && !passes(&no_vcs, &root, "mine.txt"));

	let no_project = with(Some(Discovery { vcs: true, project: false, global: true }), Vec::new());
	assert!(passes(&no_project, &root, "build.log") && passes(&no_project, &root, "scratch/notes.txt"));
	assert!(!passes(&no_project, &root, "global.txt"));

	let no_global = with(Some(Discovery { vcs: true, project: true, global: false }), Vec::new());
	assert!(passes(&no_global, &root, "global.txt") && passes(&no_global, &root, "mine.txt"));
	assert!(!passes(&no_global, &root, "build.log"));

	let none = with(None, vec![root.join("extra.ignore")]);
	assert!(passes(&none, &root, "build.log") && !passes(&none, &root, "extra.txt"));

	// An ignore file that changes is read again.
	assert!(passes(&filterer, &root, "sub/fresh.txt"));
	fs::write(root.join("sub/.gitignore"), "fresh.txt\n").unwrap();
	assert!(passes(&filterer, &root, "sub/.gitignore"));
	assert!(!passes(&filterer, &root, "sub/fresh.txt"));
	drop(dir);
}

#[test]
fn project_origin_is_the_marked_directory_above_the_watched_paths() {
	let (_dir, root) = project(&[("crates/a/Cargo.toml", ""), ("crates/a/src/lib.rs", "")]);
	let fs = omp_vfs::BlockingFs::native();
	let origin = |paths: &[PathBuf]| super::filter::project_origin(&fs, paths, None, Path::new("/elsewhere"));
	// The topmost marked directory; whatever lies above the temporary
	// directory may be marked too.
	for watched in [root.join("crates/a/src"), root.clone()] {
		let found = origin(&[watched]);
		assert!(root.starts_with(&found), "{found:?}");
	}
	let bare = tempfile::tempdir().unwrap();
	let bare = bare.path().canonicalize().unwrap();
	// The home directory's markers do not make it an origin.
	let unmarked = super::filter::project_origin(&fs, &[bare.clone()], bare.parent(), Path::new("/elsewhere"));
	assert!(unmarked == Path::new("/elsewhere") || bare.starts_with(&unmarked), "{unmarked:?}");
}

#[cfg(unix)]
mod running {
	use std::{collections::HashMap, time::Instant};

	use tokio_util::sync::CancellationToken;

	use super::*;
	use crate::{
		extras::{Fd, Invocation, run},
		host::TestRunner,
	};

	const TIMEOUT: Duration = Duration::from_secs(30);

	/// A running `watchexec` over a project directory of its own.
	struct Watch {
		_project: tempfile::TempDir,
		/// The project, by its real path.
		root:     PathBuf,
		/// Where stdout and stderr land: outside the project.
		logs:     tempfile::TempDir,
		cancel:   CancellationToken,
		task:     tokio::task::JoinHandle<i32>,
	}

	impl Watch {
		/// Starts `watchexec ARGS` in a project holding `files`.
		fn start(files: &[(&str, &str)], args: &[&str]) -> Self {
			let (project, root) = project(files);
			let logs = tempfile::tempdir().unwrap();
			let open = |name: &str| fs::File::create(logs.path().join(name)).unwrap();
			let (out, err) = (open("out"), open("err"));
			let mut env: HashMap<String, String> = std::env::vars()
				.filter(|(name, _)| !name.starts_with("WATCHEXEC_") && name != "XDG_CONFIG_HOME")
				.collect();
			// No ignore files of whoever runs the tests.
			env.insert("HOME".into(), logs.path().to_string_lossy().into_owned());
			let argv = std::iter::once("watchexec")
				.chain(args.iter().copied())
				.map(str::to_owned)
				.collect();
			let mut invocation = Invocation::new(argv, root.clone(), omp_vfs::Fs::native());
			let cancel = CancellationToken::new();
			invocation.commands = Some(Box::new(
				TestRunner::new(env.clone(), root.clone(), out.try_clone().unwrap(), err.try_clone().unwrap())
					.ending_with(cancel.clone()),
			));
			invocation.env = env;
			invocation.stdio =
				[Fd::File(fs::File::open("/dev/null").unwrap()), Fd::File(out), Fd::File(err)];
			invocation.cancel = Some(cancel.clone());
			let task = tokio::spawn(run(invocation));
			Self { _project: project, root, logs, cancel, task }
		}

		/// Starts `watchexec -p -v ARGS` and waits until it watches: a
		/// postponed watch gives no other sign of being ready.
		async fn postponed(files: &[(&str, &str)], args: &[&str]) -> Self {
			let args: Vec<&str> = ["-p", "-v"].into_iter().chain(args.iter().copied()).collect();
			let watch = Self::start(files, &args);
			let deadline = Instant::now() + TIMEOUT;
			while !watch.err().contains(" watchexec: watching with ") {
				assert!(Instant::now() < deadline && !watch.task.is_finished(), "{}", watch.err());
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
			watch
		}

		fn out(&self) -> String {
			fs::read_to_string(self.logs.path().join("out")).unwrap_or_default()
		}

		fn err(&self) -> String {
			fs::read_to_string(self.logs.path().join("err")).unwrap_or_default()
		}

		/// Waits until `done` holds for stdout.
		async fn until(&self, done: impl Fn(&str) -> bool) -> String {
			let deadline = Instant::now() + TIMEOUT;
			loop {
				let out = self.out();
				if done(&out) {
					return out;
				}
				assert!(
					Instant::now() < deadline && !self.task.is_finished(),
					"timed out or ended\nstdout: {out}\nstderr: {}",
					self.err()
				);
				tokio::time::sleep(Duration::from_millis(15)).await;
			}
		}

		/// Waits until stdout has not grown for `quiet`.
		async fn settled(&self, quiet: Duration) -> String {
			let mut out = self.out();
			let mut since = Instant::now();
			while since.elapsed() < quiet {
				tokio::time::sleep(Duration::from_millis(15)).await;
				let now = self.out();
				if now != out {
					out = now;
					since = Instant::now();
				}
			}
			out
		}

		fn write(&self, name: &str) {
			let path = self.root.join(name);
			fs::create_dir_all(path.parent().unwrap()).unwrap();
			fs::write(path, "changed").unwrap();
		}

		/// Cancels the watch, as the shell does, and returns its status,
		/// stdout and stderr.
		async fn cancelled(self) -> (i32, String, String) {
			self.cancel.cancel();
			self.ended().await
		}

		/// Waits for the watch to end on its own.
		async fn ended(mut self) -> (i32, String, String) {
			let code = tokio::time::timeout(TIMEOUT, &mut self.task)
				.await
				.expect("watchexec did not end")
				.expect("watchexec panicked");
			(code, self.out(), self.err())
		}
	}

	impl Drop for Watch {
		/// A watch a failed assertion leaves behind is cancelled, which kills
		/// its command, and awaited: the runtime does not shut down around a
		/// process that never ends.
		fn drop(&mut self) {
			self.cancel.cancel();
			let deadline = Instant::now() + Duration::from_secs(10);
			while !self.task.is_finished() && Instant::now() < deadline {
				std::thread::sleep(Duration::from_millis(10));
			}
		}
	}

	/// How many lines of `text` are `line`.
	fn count(text: &str, line: &str) -> usize {
		text.lines().filter(|&found| found == line).count()
	}

	/// Runs `watchexec -1 ARGS` (one run, then its status) to its end.
	async fn once(args: &[&str]) -> (i32, String, String) {
		let args: Vec<&str> = std::iter::once("-1").chain(args.iter().copied()).collect();
		Watch::start(&[("sub/file", "")], &args).ended().await
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn runs_at_start_and_again_on_each_change_until_cancelled() {
		let watch = Watch::start(&[], &["-e", "trigger", "-n", "--", "echo", "ran"]);
		watch.until(|out| count(out, "ran") == 1).await;
		watch.write("a.trigger");
		watch.until(|out| count(out, "ran") == 2).await;
		watch.write("sub/deep/b.trigger");
		watch.until(|out| count(out, "ran") == 3).await;
		let (code, _, err) = watch.cancelled().await;
		assert_eq!(code, 130);
		assert!(err.starts_with("[Running: echo ran]\n[Command was successful]\n[Running: echo ran]\n"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn postpone_waits_for_a_change_that_passes_the_filters() {
		let watch = Watch::postponed(&[(".gitignore", "ignored/\n")], &[
			"--print-events",
			"-e",
			"trigger",
			"-i",
			"skip*",
			"-n",
			"--",
			"echo",
			"ran",
		])
		.await;
		// None of these passes: wrong extension, an ignore pattern, the
		// project's `.gitignore`, a default ignore.
		for dropped in ["notes.txt", "skip.trigger", "ignored/x.trigger", ".git/y.trigger"] {
			watch.write(dropped);
		}
		assert_eq!(watch.settled(Duration::from_millis(700)).await, "");
		watch.write("go.trigger");
		watch.until(|out| count(out, "ran") == 1).await;
		watch.settled(Duration::from_millis(300)).await;
		let go = format!(" path={} filetype=file", watch.root.join("go.trigger").display());
		let (_, out, err) = watch.cancelled().await;
		assert_eq!(out, "ran\n");
		let events: Vec<&str> = err.lines().filter(|line| line.starts_with("[EVENT ")).collect();
		assert!(events.first().is_some_and(|event| event.starts_with("[EVENT 0] Event source=Filesystem kind=")), "{err}");
		assert!(events.iter().all(|event| event.ends_with(&go)), "{err}");
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn no_vcs_ignore_lets_gitignored_paths_through() {
		let watch = Watch::postponed(&[(".gitignore", "ignored/\n")], &[
			"--no-vcs-ignore",
			"-e",
			"trigger",
			"-n",
			"--",
			"echo",
			"ran",
		])
		.await;
		watch.write("ignored/x.trigger");
		watch.until(|out| count(out, "ran") >= 1).await;
		watch.cancelled().await;
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn debounce_gathers_a_burst_into_one_run_with_every_event() {
		let watch =
			Watch::postponed(&[], &["-d", "700ms", "-e", "trigger", "--emit-events-to=stdio", "cat; echo ran"]).await;
		for index in 0..20 {
			watch.write(&format!("burst-{index}.trigger"));
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
		watch.until(|out| count(out, "ran") == 1).await;
		let out = watch.settled(Duration::from_millis(900)).await;
		assert_eq!(count(&out, "ran"), 1, "{out}");
		for index in 0..20 {
			let path = watch.root.join(format!("burst-{index}.trigger"));
			let reported = ["create", "modify"]
				.iter()
				.any(|kind| count(&out, &format!("{kind}:{}", path.display())) >= 1);
			assert!(reported, "burst-{index} missing from {out}");
		}
		watch.cancelled().await;
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn a_burst_of_thousands_of_changes_runs_the_command_not_once_per_change() {
		let watch = Watch::postponed(&[], &["-d", "3s", "-e", "trigger", "-n", "--", "echo", "ran"]).await;
		let writing = Instant::now();
		for index in 0..2000 {
			watch.write(&format!("d{}/f{index}.trigger", index % 20));
		}
		let wrote_in = writing.elapsed();
		watch.until(|out| count(out, "ran") >= 1).await;
		let out = watch.settled(Duration::from_millis(800)).await;
		// One run for a burst that fits the debounce time.
		assert!(count(&out, "ran") == 1 || wrote_in > Duration::from_secs(2), "{} runs", count(&out, "ran"));
		watch.cancelled().await;
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn restart_stops_the_running_command_and_starts_it_again() {
		let watch = Watch::start(&[], &["-r", "-e", "trigger", "echo start; exec sleep 30"]);
		watch.until(|out| count(out, "start") == 1).await;
		let started = Instant::now();
		watch.write("a.trigger");
		watch.until(|out| count(out, "start") == 2).await;
		assert!(started.elapsed() < Duration::from_secs(10), "the stop signal did not stop the command");
		let (code, _, err) = watch.cancelled().await;
		assert_eq!(code, 130);
		// A restart is not a failure of the command: nothing but starts.
		assert!(err.lines().count() >= 2, "{err}");
		assert!(err.lines().all(|line| line == "[Running: echo start; exec sleep 30]"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn restart_sends_the_stop_signal_then_kills_after_the_stop_timeout() {
		let polite = "trap 'echo got-int; exit 0' INT; echo ready; while :; do sleep 0.05; done";
		let watch = Watch::start(&[], &["-r", "--stop-signal", "SIGINT", "-e", "trigger", polite]);
		watch.until(|out| count(out, "ready") == 1).await;
		watch.write("a.trigger");
		let out = watch.until(|out| count(out, "ready") == 2).await;
		assert!(count(&out, "got-int") >= 1, "{out}");
		watch.cancelled().await;

		let deaf = "trap '' TERM; echo ready; while :; do sleep 0.05; done";
		let watch = Watch::start(&[], &["-r", "--stop-timeout", "400ms", "-e", "trigger", deaf]);
		watch.until(|out| count(out, "ready") == 1).await;
		let stopped = Instant::now();
		watch.write("a.trigger");
		watch.until(|out| count(out, "ready") == 2).await;
		assert!(stopped.elapsed() >= Duration::from_millis(400), "killed before the stop timeout");
		watch.cancelled().await;
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn signal_mode_signals_the_running_command_without_restarting_it() {
		let reloading = "trap 'echo reloaded' USR1; echo ready; while :; do sleep 0.05; done";
		let watch = Watch::start(&[], &["-s", "usr1", "-e", "trigger", reloading]);
		watch.until(|out| count(out, "ready") == 1).await;
		watch.write("a.trigger");
		let out = watch.until(|out| count(out, "reloaded") >= 1).await;
		assert_eq!(count(&out, "ready"), 1, "{out}");
		watch.cancelled().await;
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn queue_runs_again_after_the_command_ends_and_the_default_does_not() {
		let slow = "echo start; sleep 1; echo end";
		let queued = Watch::start(&[], &["-o", "queue", "-e", "trigger", slow]);
		let ignoring = Watch::start(&[], &["-e", "trigger", slow]);
		for watch in [&queued, &ignoring] {
			watch.until(|out| count(out, "start") == 1).await;
			watch.write("a.trigger");
			watch.write("b.trigger");
		}
		let out = queued.until(|out| count(out, "end") == 2).await;
		assert_eq!(out, "start\nend\nstart\nend\n");
		ignoring.until(|out| count(out, "end") == 1).await;
		assert_eq!(ignoring.settled(Duration::from_millis(600)).await, "start\nend\n");
		queued.cancelled().await;
		ignoring.cancelled().await;
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn events_reach_the_command_in_the_form_asked_for() {
		let show = "echo \"common=$WATCHEXEC_COMMON_PATH changed=$WATCHEXEC_CREATED_PATH,$WATCHEXEC_WRITTEN_PATH\"";
		let environment = Watch::postponed(&[], &["--emit-events-to=environment", "-e", "trigger", show]).await;
		let json = Watch::postponed(&[], &["--emit-events-to=json-stdio", "-e", "trigger", "cat"]).await;
		let file =
			Watch::postponed(&[], &["--emit-events-to=file", "-e", "trigger", "cat \"$WATCHEXEC_EVENTS_FILE\""]).await;
		let only = Watch::postponed(&[], &["--only-emit-events", "--emit-events-to=stdio", "-e", "trigger"]).await;
		for watch in [&environment, &json, &file, &only] {
			watch.write("one.trigger");
		}

		let out = environment.until(|out| out.contains("common=")).await;
		let line = out.lines().next().unwrap();
		assert!(line.starts_with(&format!("common={} changed=", environment.root.display())), "{line}");
		assert!(line.contains("one.trigger"), "{line}");

		let path = json.root.join("one.trigger");
		let out = json.until(|out| out.contains('\n')).await;
		assert!(
			out.starts_with(r#"{"tags":[{"kind":"source","source":"filesystem"},{"kind":"fs","simple":""#)
				&& out.contains(&format!(r#"{{"kind":"path","absolute":"{}","filetype":"file"}}]}}"#, path.display())),
			"{out}"
		);

		for watch in [&file, &only] {
			let path = watch.root.join("one.trigger");
			let out = watch.until(|out| out.contains('\n')).await;
			let line = out.lines().next().unwrap();
			assert!(
				[format!("create:{}", path.display()), format!("modify:{}", path.display())].contains(&line.to_owned()),
				"{line}"
			);
		}
		for watch in [environment, json, file, only] {
			assert_eq!(watch.cancelled().await.0, 130);
		}
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn messages_and_statuses_are_watchexecs() {
		assert_eq!(once(&["-n", "false"]).await, (1, String::new(), "[Running: false]\n[Command exited with 1]\n".into()));
		assert_eq!(once(&["-q", "-n", "false"]).await, (1, String::new(), String::new()));
		assert_eq!(
			once(&["--color=always", "--bell", "-n", "true"]).await,
			(
				0,
				"\u{7}".into(),
				"\u{1b}[0m\u{1b}[0m\u{1b}[32m[Running: true]\n\u{1b}[0m\u{1b}[0m\u{1b}[0m\u{1b}[32m[Command was \
				 successful]\n\u{1b}[0m"
					.into()
			)
		);
		let (code, _, err) = once(&["--timings", "exit 3"]).await;
		assert_eq!(code, 3);
		let tail = err.strip_prefix("[Running: exit 3]\n[Command exited with 3, lasted ").expect(&err);
		assert!(tail.ends_with("s]\n"), "{err}");

		let (code, _, err) = once(&["kill -TERM $$"]).await;
		assert_eq!((code, err.as_str()), (143, "[Running: kill -TERM $$]\n[Command killed by Terminate]\n"));

		let (code, _, err) = once(&["-n", "no-such-program-of-ours"]).await;
		assert_eq!(code, 127);
		assert!(err.contains("watchexec: no-such-program-of-ours: command not found\n"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn command_options_shape_how_the_command_runs() {
		assert_eq!(once(&["-q", "-E", "FOO=bar", "-E", "BAZ=a=b", "echo $FOO $BAZ"]).await.1, "bar a=b\n");
		assert!(once(&["-q", "--workdir", "sub", "pwd"]).await.1.ends_with("/sub\n"));
		// One word with `--shell=none` is split; several are the argv.
		assert_eq!(once(&["-q", "--shell=none", "echo a  b"]).await.1, "a b\n");
		assert_eq!(once(&["-q", "-n", "--", "echo", "a  b", "$HOME"]).await.1, "a  b $HOME\n");
		assert_eq!(once(&["-q", "--shell", "sh -u", "echo ${UNSET_VARIABLE-unset}"]).await.1, "unset\n");
		let started = Instant::now();
		assert_eq!(once(&["-q", "--delay-run", "400ms", "-n", "true"]).await.0, 0);
		assert!(started.elapsed() >= Duration::from_millis(400));
		let (code, _, err) = once(&["-d", "100", "-q", "-n", "true"]).await;
		assert_eq!(code, 0);
		assert!(err.starts_with("Warning: unitless non-zero time span values are deprecated"), "{err}");
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn startup_failures_and_stdin_quit_end_watchexec() {
		let (code, _, err) = once(&["-w", "no-such-directory", "-n", "true"]).await;
		assert_eq!(code, 1);
		assert!(err.starts_with("Error:   \u{d7} ") && err.contains("No such file or directory"), "{err}");

		// Stdin is at its end from the start.
		let watch = Watch::start(&[], &["--stdin-quit", "-p", "-n", "--", "echo", "ran"]);
		let (code, out, err) = watch.ended().await;
		assert_eq!((code, out.as_str()), (0, ""));
		assert_eq!(err, "[Waiting 10s for processes to exit before stopping...]\n");

		let (code, out, _) = Watch::start(&[], &["--completions", "bash"]).ended().await;
		assert_eq!(code, 0);
		assert!(out.contains("_watchexec()"), "{}", &out[..out.len().min(200)]);
		let (code, out, _) = Watch::start(&[], &["--manual"]).ended().await;
		assert_eq!(code, 0);
		assert!(out.contains(".TH watchexec 1"), "{}", &out[..out.len().min(200)]);
		let (code, out, _) = Watch::start(&[], &["-V"]).ended().await;
		assert_eq!((code, out.as_str()), (0, "watchexec 2.3.2\n"));
	}

	#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
	async fn polling_notices_changes_too() {
		let watch = Watch::postponed(&[], &["--poll=100ms", "-e", "trigger", "-n", "--", "echo", "ran"]).await;
		watch.write("a.trigger");
		watch.until(|out| count(out, "ran") >= 1).await;
		assert_eq!(watch.cancelled().await.0, 130);
	}
}
