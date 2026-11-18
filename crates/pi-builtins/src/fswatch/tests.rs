use std::{
	ffi::OsString,
	fs,
	io::Write as _,
	path::{MAIN_SEPARATOR, Path},
	sync::Arc,
	time::{Duration, SystemTime},
};

use jiff::tz::TimeZone;
use parking_lot::Mutex;
use pi_watch::{Backend, Flags};
use tokio_util::sync::CancellationToken;

use super::{
	Fswatch, command_filters, filter_line,
	options::{self, Exit, Options},
	output::{self, Printer},
};
use crate::{
	extras::{self, Fd, Invocation},
	host::{AsyncUtility, Host, run_async_util},
};

/// 1971-01-01 00:00:00 UTC, a Friday.
fn new_year() -> SystemTime {
	SystemTime::UNIX_EPOCH + Duration::from_secs(365 * 86_400)
}

fn parse(args: &[&str]) -> Result<Options, Exit> {
	let args: Vec<OsString> = args.iter().map(OsString::from).collect();
	options::parse(&args)
}

/// What `fswatch ARGS dir` prints for one batch of `events` read at
/// [`new_year`], with `zone` as the local time zone.
fn render_in(zone: TimeZone, args: &[&str], events: &[(&str, u64, &[&str])]) -> String {
	let mut args = args.to_vec();
	args.push("dir");
	let options = parse(&args).expect("options");
	let printer = Printer::new(&options, &command_filters(&options), zone).expect("filters");
	let mut out = Vec::new();
	printer.events(new_year(), events, &mut out);
	String::from_utf8(out).expect("utf-8 output")
}

fn render(args: &[&str], events: &[(&str, u64, &[&str])]) -> String {
	render_in(TimeZone::UTC, args, events)
}

const CREATED_FILE: &[&str] = &["Created", "IsFile", "Updated"];

fn names(backend: Backend, flags: Flags, native: u32) -> Vec<&'static str> {
	output::decode(backend, flags, native)
		.iter()
		.map(|&flag| output::name(flag))
		.collect()
}

/// Failure mode: a script that checks `$?` or greps stderr for fswatch's
/// diagnostics sees another status or wording than the tool's.
#[test]
fn invalid_invocations_end_with_fswatchs_messages_and_statuses() {
	let cases: [(&[&str], i32, &str); 12] = [
		(&[], 1, "Invalid number of arguments.\n"),
		(&["-l", "0", "d"], 3, "Invalid value: 0\n"),
		(&["-l", "soon", "d"], 3, "Invalid value: soon\n"),
		(&["--latency=1e999", "d"], 3, "Value out of range: 1e999\n"),
		(&["-m", "no_such_monitor", "d"], 8, "Invalid monitor name.\n"),
		(&["--event", "Exploded", "d"], 7, "Unknown event type: Exploded\n"),
		(&["--filter-mode", "both", "d"], 7, "Invalid filter mode: both\n"),
		(&["--monitor-property", "novalue", "d"], 7, "Invalid property format.\n"),
		(&["--format", "%q", "d"], 9, "Invalid format.\n"),
		(&["--format", "%p%", "d"], 9, "Invalid format.\n"),
		(
			&["--format", "%p", "-x", "d"],
			9,
			"--format is incompatible with any other format option such as -t and -x.\n",
		),
		(&["--format", "%p", "-o", "d"], 9, "--format is incompatible with -o.\n"),
	];
	for (args, code, message) in cases {
		let exit = parse(args).err().unwrap_or_else(|| panic!("{args:?} was accepted"));
		assert_eq!((exit.code, exit.stderr.as_str(), exit.stdout.as_str()), (code, message, ""), "{args:?}");
	}

	// An option fswatch does not have: getopt's complaint, then the usage.
	for args in [&["--no-such-option", "d"][..], &["-Z", "d"], &["d", "-l"], &["--e", "x", "d"]] {
		let exit = parse(args).err().unwrap_or_else(|| panic!("{args:?} was accepted"));
		assert_eq!(exit.code, 1, "{args:?}");
		assert!(
			exit.stderr.starts_with("fswatch: ")
				&& exit.stderr.contains("\nUsage:\nfswatch [OPTION] ... path ...\n"),
			"{args:?}: {}",
			exit.stderr
		);
	}
}

/// Failure mode: an agent's usual spellings (clustered flags, attached
/// values, abbreviated long options, options after the path) are read as
/// paths or rejected.
#[test]
fn options_are_scanned_as_getopt_long_scans_them() {
	let options = parse(&[
		"src",
		"-tx0",
		"-l0.25",
		"--fire-idle-event",
		"--one-ev",
		"--batch-marker",
		"-e",
		"-swap$",
		"--include=\\.rs$",
		"--event=Created",
		"--event",
		"12",
		"--",
		"-odd",
	])
	.expect("options");
	assert_eq!(options.paths, ["src", "-odd"]);
	assert!(options.timestamp && options.event_flags && options.print0);
	assert!(options.idle_events && options.one_event && !options.one_per_batch);
	assert_eq!(options.latency, 0.25);
	assert_eq!(options.batch_marker.as_deref(), Some("NoOp"));
	let filters: Vec<_> =
		options.filters.iter().map(|filter| (filter.text.as_str(), filter.include)).collect();
	assert_eq!(filters, [("-swap$", false), ("\\.rs$", true)]);
	// A name is one flag; a number is a mask, and `NoOp` (0) is in every mask.
	assert_eq!(options.events, [2, 0, 4, 8]);

	// The first `-h`, `-M` or bad value ends the scan; `--version` waits for
	// its end.
	let version = parse(&["--version", "d"]).err().expect("--version exits");
	assert_eq!((version.code, version.stdout.as_str()), (0, "fswatch 1.22.0\n"));
	let monitors = parse(&["--version", "-M", "-l", "0"]).err().expect("-M exits");
	let listed: Vec<&str> = monitors.stdout.lines().collect();
	let native = format!("  {}", Backend::Default.monitor_name());
	assert!(listed.contains(&native.as_str()) && listed.contains(&"  poll_monitor"), "{listed:?}");
	assert!(listed.is_sorted(), "{listed:?}");
}

/// Failure mode: flags print in another order, or under other names, than
/// fswatch's monitor for the same system event, so `-x` consumers and
/// `--event` filters written against fswatch stop matching.
#[test]
fn system_events_decode_to_fswatchs_flag_lists() {
	// FSEvents: ItemCreated | ItemIsFile | ItemModified, and friends.
	assert_eq!(names(Backend::FsEvents, Flags::NO_OP, 0x100 | 0x1_0000 | 0x1000), CREATED_FILE);
	assert_eq!(
		names(Backend::FsEvents, Flags::NO_OP, 0x4000 | 0x100 | 0x2_0000 | 0x200),
		["OwnerModified", "Created", "IsDir", "Removed"]
	);
	assert_eq!(
		names(Backend::FsEvents, Flags::NO_OP, 0x1_0000 | 0x200 | 0x800),
		["IsFile", "Removed", "Renamed"]
	);
	// Inode metadata and extended attributes are both `AttributeModified`.
	assert_eq!(
		names(Backend::FsEvents, Flags::NO_OP, 0x400 | 0x8000 | 0x1_0000),
		["AttributeModified", "IsFile", "AttributeModified"]
	);

	// inotify: IN_CREATE | IN_ISDIR, the halves of a rename, a finished write.
	assert_eq!(names(Backend::Inotify, Flags::NO_OP, 0x100 | 0x4000_0000), ["IsDir", "Created"]);
	assert_eq!(names(Backend::Inotify, Flags::NO_OP, 0x40), ["Removed", "MovedFrom"]);
	assert_eq!(names(Backend::Inotify, Flags::NO_OP, 0x80), ["Created", "MovedTo"]);
	assert_eq!(names(Backend::Inotify, Flags::NO_OP, 0x8), ["CloseWrite"]);
	// An entry found by a scan carries no mask.
	assert_eq!(names(Backend::Inotify, Flags::CREATED | Flags::IS_FILE, 0), ["Created"]);

	// ReadDirectoryChangesW: FILE_ACTION_RENAMED_OLD_NAME / _NEW_NAME.
	assert_eq!(names(Backend::Windows, Flags::NO_OP, 4), ["MovedFrom", "Renamed"]);
	assert_eq!(names(Backend::Windows, Flags::NO_OP, 5), ["MovedTo", "Renamed"]);

	// kqueue: NOTE_WRITE | NOTE_EXTEND, NOTE_DELETE | NOTE_LINK.
	assert_eq!(names(Backend::Kqueue, Flags::NO_OP, 0x2 | 0x4), ["Updated", "PlatformSpecific"]);
	assert_eq!(names(Backend::Kqueue, Flags::NO_OP, 0x1 | 0x10), ["Removed", "Link"]);

	// The poll monitor has no system flags: the watcher's own, lowest first,
	// with every inode change an attribute change and no types.
	assert_eq!(names(Backend::Poll, Flags::IS_FILE | Flags::UPDATED, 0), ["Updated", "AttributeModified"]);
	assert_eq!(names(Backend::Poll, Flags::IS_FILE | Flags::OWNER_MODIFIED, 0), ["AttributeModified"]);
	assert_eq!(names(Backend::Poll, Flags::IS_DIR | Flags::CREATED, 0), ["Created"]);
	assert_eq!(
		names(Backend::FsEvents, Flags::CREATED | Flags::IS_DIR, 0),
		["Created", "IsDir"]
	);
}

/// Failure mode: a consumer parsing fswatch records (`while read path
/// flags`, `xargs -0`, a `--format` template) gets another shape.
#[test]
fn records_follow_the_format_options() {
	let created = [("/w/a.txt", 737_010_311, CREATED_FILE)];
	assert_eq!(render(&[], &created), "/w/a.txt\n");
	assert_eq!(render(&["-x"], &created), "/w/a.txt Created IsFile Updated\n");
	assert_eq!(render(&["-0", "-x"], &created), "/w/a.txt Created IsFile Updated\0");
	assert_eq!(render(&["-n"], &created), "/w/a.txt 518\n");
	// A flag fswatch lists twice counts twice.
	assert_eq!(
		render(&["-n"], &[("/w/a.txt", 0, &["AttributeModified", "IsFile", "AttributeModified"][..])]),
		"/w/a.txt 640\n"
	);
	assert_eq!(render(&["-t"], &created), "Fri Jan  1 00:00:00 1971 /w/a.txt\n");
	assert_eq!(
		render(&["-tx", "-f", "%Y-%m-%d %H:%M"], &created),
		"1971-01-01 00:00 /w/a.txt Created IsFile Updated\n"
	);
	assert_eq!(
		render(
			&["--format", "%t|%p|%f|%c|%K|%P|%%|%n|X", "--event-flag-separator=,"],
			&created
		),
		"Fri Jan  1 00:00:00 1971|/w/a.txt|Created,IsFile,Updated|737010311|||%|\n|X\n"
	);

	// `%t` is local to the shell's zone unless `-u` asks for UTC.
	let tokyo = || TimeZone::get("Asia/Tokyo").expect("zone");
	assert_eq!(render_in(tokyo(), &["-t", "-f", "%H:%M"], &created), "09:00 /w/a.txt\n");
	assert_eq!(render_in(tokyo(), &["-t", "-u", "-f", "%H:%M"], &created), "00:00 /w/a.txt\n");
}

/// Failure mode: `fswatch -o dir | while read count` loops, and readers that
/// split on the batch marker, see the wrong number of lines per batch.
#[test]
fn batches_end_with_their_count_and_marker() {
	let batch = [("/w/a", 0, CREATED_FILE), ("/w/b", 0, &["Removed"][..])];
	assert_eq!(render(&["-o"], &batch), "2\n");
	assert_eq!(render(&["--batch-marker"], &batch), "/w/a\n/w/b\nNoOp\n");
	assert_eq!(render(&["-o", "-0", "--batch-marker=EOF"], &batch), "2\0EOF\0");
	// A batch the filters empty prints nothing, marker included.
	assert_eq!(render(&["-o", "--batch-marker", "-e", "/w/"], &batch), "");
}

/// Failure mode: `--event` and `-e`/`-i` let unwanted records through or
/// drop wanted ones, so a watch loop fires on noise or never fires.
#[test]
fn filters_select_by_event_type_and_path() {
	// Flags that are not asked for go; an event left without one is dropped.
	let lifetime = [
		("/w/a", 0, CREATED_FILE),
		("/w/a", 0, &["Created", "IsFile", "Updated", "Removed"][..]),
		("/w/b", 0, &["IsFile", "Renamed"][..]),
	];
	assert_eq!(
		render(&["-x", "--event", "Removed", "--event", "Renamed"], &lifetime),
		"/w/a Removed\n/w/b Renamed\n"
	);
	assert_eq!(render(&["-x", "--event", "8"], &lifetime), "/w/a Removed\n");

	let files = [
		("/w/x.txt", 0, CREATED_FILE),
		("/w/x.log", 0, CREATED_FILE),
		("/w/sub/y.TXT", 0, CREATED_FILE),
		("/w/tmp/z.txt", 0, CREATED_FILE),
	];
	// Legacy mode: an include that matches wins over every exclude.
	assert_eq!(render(&["-e", ".*", "-i", "\\.txt$"], &files), "/w/x.txt\n/w/tmp/z.txt\n");
	assert_eq!(
		render(&["-I", "-E", "-e", ".*", "-i", "\\.(txt|md)$"], &files),
		"/w/x.txt\n/w/sub/y.TXT\n/w/tmp/z.txt\n"
	);
	assert_eq!(render(&["-e", "\\.log$"], &files), "/w/x.txt\n/w/sub/y.TXT\n/w/tmp/z.txt\n");
	// Conjunctive mode: an exclude that matches wins.
	assert_eq!(
		render(&["--filter-mode", "conjunctive", "-i", "\\.txt$", "-e", "/tmp/"], &files),
		"/w/x.txt\n"
	);
	// Without `-E` the expressions are basic: `+` is a plus sign.
	let plus = [("/w/aa", 0, CREATED_FILE), ("/w/a+", 0, CREATED_FILE)];
	assert_eq!(render(&["-e", "a+"], &plus), "/w/aa\n");
	assert_eq!(render(&["-E", "-e", "a+"], &plus), "");
}

/// Failure mode: `-b` prints one record per system event instead of one per
/// path, or loses flags while merging.
#[test]
fn bubbling_merges_the_events_of_a_path() {
	let events = [
		("/w/b", 0, &["Created"][..]),
		("/w/a", 0, &["Updated"][..]),
		("/w/b", 0, &["IsFile", "Removed", "Created"][..]),
	];
	assert_eq!(render(&["-b", "-x"], &events), "/w/a Updated\n/w/b Created Removed IsFile\n");
	assert_eq!(render(&["-b", "-o"], &events), "2\n");
}

/// Failure mode: the idle event has another shape than fswatch's empty-path
/// `NoOp` record, or slips past the filters fswatch applies to it.
#[test]
fn the_idle_event_is_a_no_op_record_subject_to_the_filters() {
	let idle = |args: &[&str]| {
		let mut args = args.to_vec();
		args.push("dir");
		let options = parse(&args).expect("options");
		let printer =
			Printer::new(&options, &command_filters(&options), TimeZone::UTC).expect("filters");
		let mut out = Vec::new();
		let shown = printer.idle(&mut out);
		(shown, String::from_utf8(out).expect("utf-8 output"))
	};
	assert_eq!(idle(&["-x"]), (true, " NoOp\n".to_owned()));
	assert_eq!(idle(&["-o"]), (true, "1\n".to_owned()));
	assert_eq!(idle(&["-x", "--event", "NoOp"]), (true, " NoOp\n".to_owned()));
	assert_eq!(idle(&["-x", "--event", "Created"]), (false, String::new()));
	assert_eq!(idle(&["-x", "-e", ".*"]), (false, String::new()));
}

/// Failure mode: a `--filter-from` file written for fswatch selects other
/// paths here.
#[test]
fn filter_file_lines_parse_as_fswatchs() {
	let parsed = |line: &str| {
		filter_line(line).map(|filter| {
			filter
				.map(|filter| (filter.text, filter.include, filter.extended, filter.case_sensitive))
				.ok()
		})
	};
	assert_eq!(parsed("+ \\.txt$"), Some(Some(("\\.txt$".to_owned(), true, false, true))));
	assert_eq!(parsed("-ei ^/tmp/Foo  "), Some(Some(("^/tmp/Foo".to_owned(), false, true, false))));
	// An escaped trailing space belongs to the expression.
	assert_eq!(parsed("- name\\ "), Some(Some(("name\\ ".to_owned(), false, false, true))));
	assert_eq!(parsed("# a comment"), None);
	assert_eq!(parsed(""), None);
	for invalid in ["\\.txt$", "+e", "+x \\.txt$", "-  "] {
		assert_eq!(parsed(invalid), Some(None), "{invalid:?}");
	}
}

/// Failure mode: a filter or latency fswatch refuses starts a watch that
/// never matches, instead of ending with fswatch's error.
#[tokio::test]
async fn what_keeps_the_monitor_from_starting_is_reported_with_status_5() {
	let dir = tempfile::tempdir().expect("tempdir");
	fs::write(dir.path().join("filters"), "+ \\.txt$\nnot a filter\n-e (\n").expect("filter file");
	let cases: [(&[&str], &str); 4] = [
		(&["-E", "-e", "(", "."], "An error occurred during the compilation of (\nStatus code: 2048\n"),
		(&["-l", "-1", "."], "Latency cannot be negative.\nStatus code: 1024\n"),
		(&["--filter-from", "missing-filters", "."], "File not found: missing-filters\n"),
		(
			&["--filter-from", "filters", "."],
			"Invalid filter: not a filter\nAn error occurred during the compilation of (\nStatus code: \
			 2048\n",
		),
	];
	for (args, message) in cases {
		let (code, capture) = run_async_util::<Fswatch>(args, "", dir.path()).await;
		assert_eq!((code, capture.err().as_str(), capture.out().as_str()), (5, message, ""), "{args:?}");
	}
}

// ── The running watch ───────────────────────────────────────────────────────

/// Every test below ends well within this, or fails with what was printed.
const LIMIT: Duration = Duration::from_secs(60);

/// The standard output of a running `fswatch`.
#[derive(Clone)]
struct Seen(Arc<Mutex<Vec<u8>>>);

impl Seen {
	fn text(&self) -> String {
		String::from_utf8_lossy(&self.0.lock()).into_owned()
	}

	/// Waits for output that satisfies `found`.
	async fn until(&self, found: impl Fn(&str) -> bool) -> String {
		loop {
			let text = self.text();
			if found(&text) {
				return text;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	}

	/// Rewrites `probe` until fswatch prints something: from then on the
	/// watch is running and every change is reported.
	async fn live(&self, probe: &Path) {
		let mut round = 0u32;
		while self.0.lock().is_empty() {
			fs::write(probe, round.to_string()).expect("probe");
			round += 1;
			tokio::time::sleep(Duration::from_millis(25)).await;
		}
	}

	/// Waits until nothing was printed for a while, and returns how much was
	/// printed by then.
	async fn settled(&self) -> usize {
		let mut printed = self.0.lock().len();
		loop {
			tokio::time::sleep(Duration::from_millis(400)).await;
			let now = self.0.lock().len();
			if now == printed {
				return printed;
			}
			printed = now;
		}
	}
}

/// Runs `fswatch ARGS` in `cwd` next to `drive`, which changes files and
/// watches the output. When `drive` returns the command is dropped, as the
/// shell drops a cancelled one. Returns the exit status if fswatch ended on
/// its own, and what it wrote to stdout and stderr.
async fn fswatch(
	args: &[&str],
	cwd: &Path,
	drive: impl AsyncFnOnce(Seen),
) -> (Option<i32>, String, String) {
	let (mut host, capture) = Host::for_test_async("fswatch", "", cwd);
	let seen = Seen(capture.stdout_buffer());
	let command = Fswatch { argv: args.iter().map(OsString::from).collect() };
	let outcome = tokio::time::timeout(LIMIT, async {
		tokio::select! {
			code = command.run(&mut host) => Some(code),
			() = drive(seen) => None,
		}
	})
	.await;
	let Ok(code) = outcome else {
		panic!(
			"fswatch {args:?} did not get there within {LIMIT:?}\nstdout: {}\nstderr: {}",
			capture.out(),
			capture.err()
		);
	};
	let _ = host.flush_output().await;
	(code, capture.out(), capture.err())
}

/// The `%p|%f` records of `out`: path and flags.
fn records(out: &str) -> impl Iterator<Item = (&str, &str)> {
	out.lines().filter_map(|line| line.rsplit_once('|'))
}

/// Whether `out` has a `%p|%f` record for the entry `name` with `flag`.
fn reported(out: &str, name: &str, flag: &str) -> bool {
	let entry = format!("{MAIN_SEPARATOR}{name}");
	records(out).any(|(path, flags)| path.ends_with(&entry) && flags.split(' ').any(|have| have == flag))
}

fn text(path: &Path) -> &str {
	path.to_str().expect("utf-8 temp path")
}

/// Rewrites `path` until dropped.
async fn keep_writing(path: &Path) {
	loop {
		fs::write(path, "x").expect("write");
		tokio::time::sleep(Duration::from_millis(25)).await;
	}
}

/// The flags of a rename's old and new name, by monitor.
const RENAME: (&str, &str) = if cfg!(target_os = "macos") {
	("Renamed", "Renamed")
} else {
	("MovedFrom", "MovedTo")
};

/// Failure mode: a kind of change (content, rename, removal, new directory,
/// mode) goes unreported or carries the wrong flag, so a consumer filtering
/// on it never fires.
#[tokio::test]
async fn each_kind_of_change_is_reported_with_its_flag() {
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path();
	for name in ["updated.txt", "old.txt", "gone.txt", "mode.txt"] {
		fs::write(root.join(name), "before").expect("fixture");
	}
	let (code, _, err) = fswatch(&["-l", "0.05", "--format", "%p|%f", text(root)], root, async |seen| {
		seen.live(&root.join("probe")).await;

		fs::write(root.join("created.txt"), "new").expect("create");
		seen.until(|out| reported(out, "created.txt", "Created")).await;

		let mut updated = fs::OpenOptions::new().append(true).open(root.join("updated.txt")).expect("open");
		updated.write_all(b"more").expect("append");
		drop(updated);
		seen.until(|out| reported(out, "updated.txt", "Updated")).await;

		fs::rename(root.join("old.txt"), root.join("moved.txt")).expect("rename");
		seen
			.until(|out| reported(out, "old.txt", RENAME.0) && reported(out, "moved.txt", RENAME.1))
			.await;

		fs::remove_file(root.join("gone.txt")).expect("remove");
		seen.until(|out| reported(out, "gone.txt", "Removed")).await;

		fs::create_dir(root.join("made")).expect("mkdir");
		seen.until(|out| reported(out, "made", "Created")).await;

		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;

			// FSEvents files a mode change under the owner's; inotify under
			// the attributes'.
			let flag = if cfg!(target_os = "macos") { "OwnerModified" } else { "AttributeModified" };
			fs::set_permissions(root.join("mode.txt"), fs::Permissions::from_mode(0o600)).expect("chmod");
			seen.until(|out| reported(out, "mode.txt", flag)).await;
		}
	})
	.await;
	assert_eq!((code, err.as_str()), (None, ""));
}

/// Failure mode: with `-r`, files in a directory created after the watch
/// began are missed, because the directory was not watched in time.
#[tokio::test]
async fn files_in_directories_made_during_the_watch_are_reported() {
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path();
	let (code, _, err) =
		fswatch(&["-r", "-l", "0.05", "--format", "%p|%f", text(root)], root, async |seen| {
			seen.live(&root.join("probe")).await;
			// No pause between making the directories and filling them.
			fs::create_dir_all(root.join("a/b")).expect("mkdir");
			fs::write(root.join("a/b/early.txt"), "x").expect("write");
			seen.until(|out| reported(out, "early.txt", "Created")).await;
			fs::create_dir(root.join("a/b/c")).expect("mkdir");
			fs::write(root.join("a/b/c/late.txt"), "x").expect("write");
			seen.until(|out| reported(out, "late.txt", "Created")).await;
		})
		.await;
	assert_eq!((code, err.as_str()), (None, ""));
}

/// Failure mode: a burst (a checkout, an unpacked archive) loses events
/// without a word, so a consumer acts on a partial picture.
#[tokio::test]
async fn a_burst_of_five_thousand_files_is_reported_in_full_or_as_an_overflow() {
	const FILES: usize = 5000;
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path().to_path_buf();
	let args = ["--allow-overflow", "-r", "-l", "0.05", "--format", "%p|%f", text(&root)];
	let (code, out, err) = fswatch(&args, &root, async |seen| {
		seen.live(&root.join("probe")).await;
		let burst = root.clone();
		tokio::task::spawn_blocking(move || {
			for index in 0..FILES {
				fs::write(burst.join(format!("burst-{index:04}")), "x").expect("write");
			}
		})
		.await
		.expect("burst");
		seen
			.until(|out| {
				let mut overflowed = false;
				let mut files = std::collections::HashSet::new();
				for (path, flags) in records(out) {
					overflowed |= flags == "Overflow";
					if let Some((_, name)) = path.rsplit_once(MAIN_SEPARATOR)
						&& name.starts_with("burst-")
					{
						files.insert(name);
					}
				}
				overflowed || files.len() == FILES
			})
			.await;
	})
	.await;
	assert_eq!((code, err.as_str()), (None, ""), "stdout: {} bytes", out.len());
}

/// Failure mode: a file watched by name stops being reported once an editor
/// replaces it (write a temporary, rename it over), or its siblings leak into
/// the output.
#[tokio::test]
async fn a_watched_file_survives_being_replaced_by_rename() {
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path();
	let file = root.join("config.json");
	fs::write(&file, "{}").expect("fixture");
	let (code, out, err) = fswatch(&["-l", "0.05", "--format", "%p|%f", text(&file)], root, async |seen| {
		seen.live(&file).await;
		for round in 0..2 {
			let before = seen.settled().await;
			let temporary = root.join("config.json.tmp");
			fs::write(&temporary, format!("{{\"round\": {round}}}")).expect("write");
			fs::rename(&temporary, &file).expect("rename");
			seen.until(|out| out.len() > before).await;
		}
	})
	.await;
	assert_eq!((code, err.as_str()), (None, ""));
	let foreign: Vec<_> =
		records(&out).filter(|(path, _)| !path.ends_with("config.json")).collect();
	assert!(foreign.is_empty(), "{foreign:?}");
}

/// Failure mode: `-e`/`-i` are applied to something other than the reported
/// path, so excluded files show up in a live watch.
#[tokio::test]
async fn path_filters_apply_to_live_events() {
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path();
	let args = ["-l", "0.05", "-e", ".*", "-i", "\\.txt$", text(root)];
	let (code, out, err) = fswatch(&args, root, async |seen| {
		seen.live(&root.join("probe.txt")).await;
		fs::write(root.join("skipped.log"), "x").expect("write");
		fs::write(root.join("kept.txt"), "x").expect("write");
		seen.until(|out| out.contains("kept.txt\n")).await;
	})
	.await;
	assert_eq!((code, err.as_str()), (None, ""));
	assert!(!out.contains("skipped.log"), "{out}");
}

/// Failure mode: `fswatch -1` (and `-1 -o`, which upstream never ends) keeps
/// running after the first batch, so a one-shot wait hangs until its timeout.
#[tokio::test]
async fn one_event_ends_after_the_first_batch() {
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path();
	let tick = root.join("tick.txt");

	let (code, out, err) =
		fswatch(&["-1", "-l", "0.05", text(root)], root, async |_| keep_writing(&tick).await).await;
	assert_eq!((code, err.as_str()), (Some(0), ""));
	// The first batch may also be the system's word on the new directory.
	let watched = root.file_name().and_then(|name| name.to_str()).expect("directory name");
	assert!(out.lines().next().is_some_and(|line| line.contains(watched)), "{out:?}");

	let args = ["-1", "-o", "--batch-marker=done", "-l", "0.05", text(root)];
	let (code, out, err) = fswatch(&args, root, async |_| keep_writing(&tick).await).await;
	assert_eq!((code, err.as_str()), (Some(0), ""));
	let lines: Vec<&str> = out.lines().collect();
	assert!(
		matches!(lines[..], [count, "done"] if count.parse::<usize>().is_ok_and(|count| count > 0)),
		"{out:?}"
	);
}

/// Failure mode: waiting for a file that does not exist yet (`fswatch -1
/// dir/done.flag`) fails at once or never notices the file.
#[tokio::test]
async fn a_path_that_does_not_exist_yet_is_reported_once_it_appears() {
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path();
	let flag = root.join("done.flag");
	let (code, out, err) = fswatch(&["-1", "-l", "0.05", text(&flag)], root, async |_| {
		// Long enough for the watch to start on the missing path.
		tokio::time::sleep(Duration::from_millis(500)).await;
		keep_writing(&flag).await;
	})
	.await;
	assert_eq!((code, err.as_str()), (Some(0), ""));
	assert!(out.lines().next().is_some_and(|line| line.ends_with("done.flag")), "{out:?}");
}

/// Failure mode: `--fire-idle-event` stays silent while nothing changes, so
/// a consumer waiting for quiet never proceeds.
#[tokio::test]
async fn idle_events_fire_while_nothing_changes() {
	let dir = tempfile::tempdir().expect("tempdir");
	let root = dir.path();
	let args = ["--fire-idle-event", "-x", "-l", "0.1", text(root)];
	let (code, _, err) = fswatch(&args, root, async |seen| {
		seen
			.until(|out| out.lines().filter(|line| *line == " NoOp").count() >= 2)
			.await;
	})
	.await;
	assert_eq!((code, err.as_str()), (None, ""));
}

/// Failure mode: a watch redirected into a file (`fswatch dir > log &`)
/// shows nothing until it ends, or a cancelled one (shell abort, `timeout`,
/// a stopped background job) keeps running or ends with another status
/// than 130.
#[tokio::test]
async fn a_watch_into_a_file_delivers_as_it_goes_and_ends_with_130_when_cancelled() {
	let dir = tempfile::tempdir().expect("tempdir");
	// Outside the watched directory, so the log is no change of its own.
	let logs = tempfile::tempdir().expect("tempdir");
	let (out, err) = (logs.path().join("out"), logs.path().join("err"));
	let filters = logs.path().join("filters");
	fs::write(&filters, "nonsense\n").expect("filter file");
	let argv = ["fswatch", "-l", "0.05", "--filter-from", text(&filters), text(dir.path())];
	let mut invocation = Invocation::new(
		argv.iter().map(ToString::to_string).collect(),
		dir.path().to_path_buf(),
		pi_vfs::Fs::native(),
	);
	invocation.stdio = [
		Fd::Closed,
		Fd::from(fs::File::create(&out).expect("stdout file")),
		Fd::from(fs::File::create(&err).expect("stderr file")),
	];
	let cancel = CancellationToken::new();
	invocation.cancel = Some(cancel.clone());
	let running = tokio::spawn(extras::run(invocation));

	let probe = dir.path().join("probe");
	tokio::time::timeout(LIMIT, async {
		while fs::metadata(&out).expect("stdout file").len() == 0 {
			fs::write(&probe, "x").expect("probe");
			tokio::time::sleep(Duration::from_millis(25)).await;
		}
	})
	.await
	.expect("no record reached the file while fswatch ran");
	assert_eq!(fs::read_to_string(&err).expect("stderr file"), "Invalid filter: nonsense\n");
	assert!(!running.is_finished(), "fswatch ended on its own");

	cancel.cancel();
	let code = tokio::time::timeout(Duration::from_secs(10), running)
		.await
		.expect("cancelled fswatch should end promptly")
		.expect("fswatch task");
	assert_eq!(code, 130);
}
