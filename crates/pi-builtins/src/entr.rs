//! `entr`: run a utility whenever one of the files listed on standard input
//! changes, with the options, messages and exit statuses of entr 5.9.
//!
//! The list is read once: every regular file and symbolic link in it is
//! watched by name through its directory, so a file that is replaced
//! (write-temp-then-rename saves) or deleted and created again stays under
//! watch. A listed directory, and with `-d` the directory of every listed
//! file, is watched for entries appearing and disappearing, which ends `entr`
//! with status 2. Paths may be the shell's `scheme://` URLs: they are read
//! through the host's filesystem and watched at the host file behind them.
//!
//! The utility runs through the host, so builtins and URLs work in it. A
//! burst of changes becomes one run: changes are gathered until the files have
//! been quiet for a moment, and changes made while the utility runs are its
//! own business unless `-a` asks for them.
//!
//! With a terminal on stdout or stderr (and without `-n`), a space runs the
//! utility at once and `q` quits; without one `entr` simply runs
//! non-interactively.

use std::{
	collections::HashMap,
	ffi::{OsStr, OsString},
	future::Future,
	io::{self, Write as _},
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant, SystemTime},
};

use clap::Parser;
use futures::{FutureExt as _, future::BoxFuture};

use crate::{
	extras::Fd,
	host::{AsyncUtility, CommandStatus, Host, ShellCommand, strip_errno},
};

/// The release whose behavior this follows, as the usage text prints it.
const RELEASE: &str = "5.9";

const USAGE: &str = "usage: entr [-acdnprsxz] utility [argument [/_] ...] < filenames";

const SUMMARY: &str = "summary:
    -a  Do not consolidate events
    -c  Clear screen before execution
    -d  Track files added or removed from directories
    -n  Non-interactive mode
    -p  Wait for first event
    -r  Run as a background process, use signal to restart
    -s  Evaluate using a shell
    -x  Format exit status
    -z  Exit after the utility completes
docs:
    man entr
";

/// The status script `-x` installs when there is none.
const EXAMPLE_STATUS_SCRIPT: &str = "# http://eradman.com/entrproject/status-filters.html
/^signal/ { print $3, \"terminated by signal\", $2; }
/^exit/ { print $3, \"returned exit code\", $2; }
";

/// The longest listed path, as entr bounds it by the platform's `PATH_MAX`.
const PATH_MAX: usize = if cfg!(target_vendor = "apple") { 1024 } else { 4096 };

/// How long the watcher gathers changes into one batch.
const LATENCY: Duration = Duration::from_millis(10);
/// How long the files must stay quiet before a burst of changes runs the
/// utility.
const QUIET: Duration = Duration::from_millis(50);
/// How long the files must stay quiet after the utility ran (or, with `-r`,
/// started) before changes count again: what it wrote itself must not run it
/// in a loop.
const SETTLE: Duration = Duration::from_millis(100);
/// The longest a burst holds a run back, or keeps changes discounted.
const BURST_LIMIT: Duration = Duration::from_secs(1);
/// The pause between two looks for a file that went away, or at a directory
/// whose entries are changing.
const RETRY: Duration = Duration::from_millis(100);
/// How often a file that went away is looked for before `entr` gives up.
const REAPPEAR_TRIES: u32 = 10;
/// How often a directory is counted before its entries are taken as changed.
const DIRECTORY_TRIES: u32 = 5;

/// The numbers of the signals `ENTR_RESTART_SIGNAL` may name.
#[cfg(unix)]
mod signal {
	pub const HUP: i32 = libc::SIGHUP;
	pub const INT: i32 = libc::SIGINT;
	pub const QUIT: i32 = libc::SIGQUIT;
	pub const TERM: i32 = libc::SIGTERM;
	pub const USR1: i32 = libc::SIGUSR1;
	pub const USR2: i32 = libc::SIGUSR2;
}

/// The numbers of the signals `ENTR_RESTART_SIGNAL` may name, as the shell
/// numbers them where the system has none.
#[cfg(not(unix))]
mod signal {
	pub const HUP: i32 = 1;
	pub const INT: i32 = 2;
	pub const QUIT: i32 = 3;
	pub const TERM: i32 = 15;
	pub const USR1: i32 = 10;
	pub const USR2: i32 = 12;
}

#[derive(Parser, Debug)]
#[command(name = "entr", disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct Entr {
	/// Options and the utility with its arguments, split as entr does.
	#[arg(value_name = "ARGS", trailing_var_arg = true, allow_hyphen_values = true, num_args = 0..)]
	args: Vec<OsString>,
}

impl AsyncUtility for Entr {
	const NAME: &'static str = "entr";
	const RUNS_COMMANDS: bool = true;

	async fn run(self, host: &mut Host) -> i32 {
		let (options, utility) = match parse(&self.args) {
			Parsed::Run(options, at) => (options, self.args[at..].to_vec()),
			Parsed::Summary => return summary(host),
			Parsed::Usage => return usage(host),
			Parsed::Illegal(flag) => {
				if cfg!(any(target_os = "linux", target_os = "android")) {
					warn(host, format_args!("invalid option -- '{flag}'"));
				} else {
					warn(host, format_args!("illegal option -- {flag}"));
				}
				return usage(host);
			},
			Parsed::Refused(message) => return fail(host, message),
		};
		let restart_signal = match restart_signal(host.var("ENTR_RESTART_SIGNAL")) {
			Ok(signal) => signal,
			Err(name) => {
				return fail(
					host,
					format_args!("unrecognized signal: {name} <> (HUP, INT, QUIT, TERM, USR1, USR2)"),
				);
			},
		};
		if cfg!(any(target_os = "linux", target_os = "android")) {
			if host.var("ENTR_INOTIFY_WORKAROUND").is_some() {
				warn(host, "broken inotify workaround enabled");
			} else if host.var("ENTR_INOTIFY_SYMLINK").is_some() {
				warn(host, "monitoring symlinks");
			}
		}
		// The list comes from a pipe or a file, never from the keyboard.
		if host.stdin.file().is_terminal() {
			return usage(host);
		}
		let mut input = Vec::new();
		if let Err(error) = host.read_stdin_to_end(&mut input, usize::MAX).await {
			return fail(host, strip_errno(&error));
		}
		let fs = host.vfs();
		let follow = host.var("ENTR_FOLLOW_SYMLINK").is_some();
		let list = match WatchList::read(host, &fs, options, follow, &input).await {
			Ok(list) => list,
			Err(code) => return code,
		};
		drop(input);
		if list.entries.is_empty() {
			return fail(host, "No regular files to watch");
		}
		let WatchList { entries, index, roots } = list;
		// Watching starts before the first run, so nothing the utility's
		// start races with is lost.
		let changes = match Native::start(roots, Arc::new(index)) {
			Ok(changes) => changes,
			Err(error) => return fail(host, strip_errno(&error)),
		};
		let terminal = if options.non_interactive { None } else { Terminal::open(host) };
		let shell = host.var("SHELL").map_or_else(|| OsString::from("/bin/sh"), OsString::from);
		let label = base_name(if options.shell { &shell } else { &utility[0] });
		let status = match options.status {
			0 => None,
			level => match StatusFilter::start(host, &fs, level, label).await {
				Ok(filter) => Some(filter),
				Err(code) => return code,
			},
		};
		let session = Session {
			options,
			utility,
			shell: engine_shell(shell),
			default_pager: cfg!(unix) && host.var("PAGER").is_none(),
			restart_signal,
			follow,
			trace: host.var("EV_TRACE").is_some(),
			fs,
			entries,
			leading: 0,
			leading_set: false,
			pending: false,
			altered: false,
			child: None,
			superseded: Vec::new(),
			status,
			terminal,
			counted: Vec::new(),
		};
		session.watch(host, changes).await
	}
}

// ── Command line ──────────────────────────────────────────────────────────────

/// entr's options.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Options {
	/// `-a`: changes made while the utility runs run it again.
	all_events:      bool,
	/// `-c`: clear the screen before each run; twice, the scrollback too.
	clear:           u8,
	/// `-d`: track the directories of the listed files; twice, entries whose
	/// names start with a dot count too.
	directories:     u8,
	/// `-n`: never read the terminal.
	non_interactive: bool,
	/// `-p`: no run before the first change.
	postpone:        bool,
	/// `-r`: the utility keeps running and is signalled and started again.
	restart:         bool,
	/// `-s`: the utility is one command line for `$SHELL`.
	shell:           bool,
	/// `-x`: exit statuses go through the status script; twice, the script
	/// may run commands and redirect.
	status:          u8,
	/// `-z`: exit once the utility does, with its status.
	oneshot:         bool,
}

/// What a command line asks for.
#[derive(Debug, PartialEq, Eq)]
enum Parsed {
	/// The options, and where the utility starts.
	Run(Options, usize),
	/// `-h`, `--help`: the option summary.
	Summary,
	/// No utility: the usage text.
	Usage,
	/// An option entr does not have.
	Illegal(char),
	/// A combination entr refuses, with its message.
	Refused(&'static str),
}

/// Splits `args` (without the command name): clustered single-letter options
/// up to the first word that is not one, which names the utility; `--` ends
/// them early.
fn parse(args: &[OsString]) -> Parsed {
	if args.first().is_some_and(|first| first == "-h" || first == "--help") {
		return Parsed::Summary;
	}
	let mut options = Options::default();
	let mut at = 0;
	while let Some(arg) = args.get(at) {
		let bytes = arg.as_encoded_bytes();
		if bytes == b"--" {
			at += 1;
			break;
		}
		if bytes.len() < 2 || bytes[0] != b'-' {
			break;
		}
		for &flag in &bytes[1..] {
			match flag {
				b'a' => options.all_events = true,
				b'c' => options.clear = (options.clear + 1).min(2),
				b'd' => options.directories = (options.directories + 1).min(2),
				b'n' => options.non_interactive = true,
				b'p' => options.postpone = true,
				b'r' => options.restart = true,
				b's' => options.shell = true,
				b'x' => options.status = (options.status + 1).min(2),
				b'z' => options.oneshot = true,
				other => return Parsed::Illegal(char::from(other)),
			}
		}
		at += 1;
	}
	if at >= args.len() {
		return Parsed::Usage;
	}
	if options.status > 0 && options.restart {
		return Parsed::Refused("-r and -x may not be combined");
	}
	if options.shell && args.len() > at + 1 {
		return Parsed::Refused("-s requires commands to be formatted as a single argument");
	}
	Parsed::Run(options, at)
}

/// The signal that ends the utility under `-r`: `SIGTERM`, or the one
/// `ENTR_RESTART_SIGNAL` names, with or without its `SIG`. `Err` carries a
/// name entr does not accept.
fn restart_signal(name: Option<&str>) -> Result<i32, String> {
	let Some(name) = name else {
		return Ok(signal::TERM);
	};
	let name = name.strip_prefix("SIG").unwrap_or(name);
	Ok(match name {
		"HUP" => signal::HUP,
		"INT" => signal::INT,
		"QUIT" => signal::QUIT,
		"TERM" => signal::TERM,
		"USR1" => signal::USR1,
		"USR2" => signal::USR2,
		_ => return Err(name.to_owned()),
	})
}

/// The usage text on stderr, for a command line `entr` cannot run; the
/// status is 1.
fn usage(host: &mut Host) -> i32 {
	let _ = writeln!(host.stderr, "release: {RELEASE}\n{USAGE}\nhint: use -h to display option summary");
	1
}

/// The usage text and the option summary on stdout, for `-h` and `--help`.
fn summary(host: &Host) -> i32 {
	let _ = write!(host.stdout_writer(), "release: {RELEASE}\n{USAGE}\n{SUMMARY}");
	0
}

/// Writes `entr: <message>` to stderr.
fn warn(host: &mut Host, message: impl std::fmt::Display) {
	let _ = writeln!(host.stderr, "entr: {message}");
}

/// [`warn`], for an error that ends `entr` with status 1.
fn fail(host: &mut Host, message: impl std::fmt::Display) -> i32 {
	warn(host, message);
	1
}

/// The last component of a command name, for status messages.
fn base_name(name: &OsStr) -> String {
	Path::new(name)
		.file_name()
		.unwrap_or(name)
		.to_string_lossy()
		.into_owned()
}

/// `$SHELL` as the host runs it: a shell the embedding engine implements
/// itself goes by its bare name, so the command line runs in the engine; any
/// other shell is the program at that path.
fn engine_shell(shell: OsString) -> OsString {
	match Path::new(&shell).file_name() {
		Some(name) if name == "sh" || name == "bash" || name == "zsh" => name.to_owned(),
		_ => shell,
	}
}

// ── The watch list ────────────────────────────────────────────────────────────

/// One listed file or tracked directory.
struct Entry {
	/// The path the utility is given for `/_`: the listed one, made absolute.
	/// Also what the host opens.
	path: PathBuf,
	/// The path as listed, for diagnostics.
	name: OsString,
	kind: Kind,
}

enum Kind {
	/// A regular file or symbolic link, with what was last seen of it.
	File(Seen),
	/// A directory, with the number of entries it had when it was listed.
	Directory { entries: usize },
}

/// What a change of attributes is measured against.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Seen {
	mode:     u32,
	ino:      Option<u64>,
	modified: Option<SystemTime>,
}

impl Seen {
	fn of(metadata: &pi_vfs::Metadata) -> Self {
		Self { mode: metadata.mode(), ino: metadata.ino(), modified: metadata.modified().ok() }
	}
}

/// What happened to a watched path.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct Notes(u8);

impl Notes {
	/// Attributes changed: permissions, owner, times, link count.
	const ATTRIBUTES: Self = Self(1 << 3);
	/// The path came into being: created, or something was moved onto it.
	const CAME: Self = Self(1 << 2);
	/// A directory gained or lost an entry.
	const ENTRIES: Self = Self(1 << 4);
	/// The path went away: removed, or moved elsewhere.
	const GONE: Self = Self(1 << 0);
	/// Changes were lost; anything may have happened.
	const LOST: Self = Self(1 << 5);
	/// The contents changed.
	const WRITTEN: Self = Self(1 << 1);

	const fn intersects(self, other: Self) -> bool {
		self.0 & other.0 != 0
	}

	const fn with(self, other: Self) -> Self {
		Self(self.0 | other.0)
	}
}

/// A change to one [`Entry`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Hit {
	entry: u32,
	notes: Notes,
}

/// Where a watched host path sits in the list.
#[derive(Clone, Copy)]
struct Slot {
	entry:     u32,
	directory: bool,
}

/// The watched host paths. Shared with the watcher's thread, which drops
/// every change to another path before it is batched.
#[derive(Default)]
struct Index {
	paths: HashMap<PathBuf, Slot>,
}

impl Index {
	/// The tracked directory `path` is an entry of.
	fn directory_of(&self, path: &Path) -> Option<u32> {
		let slot = self.paths.get(path.parent()?)?;
		slot.directory.then_some(slot.entry)
	}

	/// Whether a change `notes` to `path` concerns the list.
	fn wants(&self, path: &Path, notes: Notes) -> bool {
		notes.intersects(Notes::LOST)
			|| self.paths.contains_key(path)
			|| (notes.intersects(Notes::GONE.with(Notes::CAME)) && self.directory_of(path).is_some())
	}

	/// Appends what a change `notes` to `path` means for the list: a hit on
	/// the listed file, and one on the tracked directory that gained or lost
	/// it.
	fn hits(&self, path: &Path, notes: Notes, hits: &mut Vec<Hit>) {
		if notes.intersects(Notes::LOST) {
			hits.push(Hit { entry: 0, notes: Notes::LOST });
		}
		let appeared_or_went = notes.intersects(Notes::GONE.with(Notes::CAME));
		match self.paths.get(path) {
			Some(slot) if slot.directory => {
				if appeared_or_went {
					hits.push(Hit { entry: slot.entry, notes: Notes::ENTRIES });
				}
			},
			Some(slot) => hits.push(Hit { entry: slot.entry, notes }),
			None => {},
		}
		if appeared_or_went && let Some(entry) = self.directory_of(path) {
			hits.push(Hit { entry, notes: Notes::ENTRIES });
		}
	}
}

/// The list read from stdin, ready to watch.
struct WatchList {
	entries: Vec<Entry>,
	index:   Index,
	/// The directories to watch: each tracked directory, and the directory of
	/// each listed file.
	roots:   Vec<PathBuf>,
}

impl WatchList {
	/// Reads the list, one path per line, skipping what is neither a file, a
	/// symbolic link nor a directory. `Err` is the status of an error that
	/// ends `entr`.
	async fn read(
		host: &mut Host,
		fs: &pi_vfs::Fs,
		options: Options,
		follow: bool,
		input: &[u8],
	) -> Result<Self, i32> {
		let mut list = Self { entries: Vec::new(), index: Index::default(), roots: Vec::new() };
		for line in input.split(|&byte| byte == b'\n') {
			let line = if cfg!(windows) { line.strip_suffix(b"\r").unwrap_or(line) } else { line };
			if line.is_empty() {
				continue;
			}
			if line.len() + 1 > PATH_MAX {
				let shown = String::from_utf8_lossy(&line[..100]);
				return Err(fail(host, format_args!("path too long: {shown}..")));
			}
			let name = os_string(line);
			let path = located(host, Path::new(&name));
			let Ok(metadata) = stat(fs, &path, follow).await else {
				warn(host, format_args!("unable to stat '{}'", name.display()));
				continue;
			};
			if metadata.is_dir() {
				list.add_directory(host, fs, options, name, path).await?;
			} else if metadata.is_file() || metadata.is_symlink() {
				let directory = (options.directories > 0).then(|| parent_name(Path::new(&name)));
				list.add_file(host, fs, follow, name, path, &metadata).await;
				let Some(directory) = directory else {
					continue;
				};
				let tracked = list
					.entries
					.iter()
					.any(|entry| matches!(entry.kind, Kind::Directory { .. }) && entry.name == directory);
				if tracked {
					continue;
				}
				let path = located(host, Path::new(&directory));
				match fs.metadata(&path).await {
					Ok(metadata) if metadata.is_dir() => {
						list.add_directory(host, fs, options, directory, path).await?;
					},
					Ok(_) => {},
					Err(_) => warn(host, format_args!("unable to stat '{}'", directory.display())),
				}
			}
		}
		Ok(list)
	}

	async fn add_file(
		&mut self,
		host: &mut Host,
		fs: &pi_vfs::Fs,
		follow: bool,
		name: OsString,
		path: PathBuf,
		metadata: &pi_vfs::Metadata,
	) {
		let Some(watched) = host_path(fs, &path).await else {
			warn(host, format_args!("unable to watch '{}'", name.display()));
			return;
		};
		let entry = self.entries.len() as u32;
		// With `ENTR_FOLLOW_SYMLINK`, a link is watched where it leads as well.
		if follow
			&& let Ok(target) = fs.canonicalize(&watched).await
			&& target != watched
		{
			self.watch(target, Slot { entry, directory: false });
		}
		self.watch(watched, Slot { entry, directory: false });
		self.entries.push(Entry { path, name, kind: Kind::File(Seen::of(metadata)) });
	}

	async fn add_directory(
		&mut self,
		host: &mut Host,
		fs: &pi_vfs::Fs,
		options: Options,
		name: OsString,
		path: PathBuf,
	) -> Result<(), i32> {
		let Ok(entries) = count_entries(fs, &path, options.directories == 2).await else {
			return Err(fail(host, format_args!("unable to open directory: '{}'", name.display())));
		};
		let Some(watched) = host_path(fs, &path).await else {
			warn(host, format_args!("unable to watch '{}'", name.display()));
			return Ok(());
		};
		let entry = self.entries.len() as u32;
		self.watch(watched, Slot { entry, directory: true });
		self.entries.push(Entry { path, name, kind: Kind::Directory { entries } });
		Ok(())
	}

	/// Puts `path` under watch for `slot`; the first listing of a path wins.
	fn watch(&mut self, path: PathBuf, slot: Slot) {
		let root = if slot.directory { Some(path.as_path()) } else { path.parent() };
		if let Some(root) = root
			&& !self.roots.iter().any(|known| known == root)
		{
			self.roots.push(root.to_path_buf());
		}
		self.index.paths.entry(path).or_insert(slot);
	}
}

/// A listed path as bytes, as a path.
fn os_string(bytes: &[u8]) -> OsString {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt as _;
		OsStr::from_bytes(bytes).to_owned()
	}
	#[cfg(not(unix))]
	{
		String::from_utf8_lossy(bytes).into_owned().into()
	}
}

/// `path` as the host opens it: absolute, without `.` and `..`; a URL as it
/// is.
fn located(host: &Host, path: &Path) -> PathBuf {
	let resolved = host.resolve(path);
	if pi_vfs::is_virtual_path(&resolved) { resolved } else { pi_vfs::normalize_lexically(&resolved) }
}

/// The directory a listed path names its file in; `.` for a bare name.
fn parent_name(path: &Path) -> OsString {
	match pi_vfs::parent_path(path) {
		Some(parent) if !parent.as_os_str().is_empty() => parent.as_os_str().to_owned(),
		_ => OsString::from("."),
	}
}

/// The host path to watch for `path`: itself, or the file a URL stands for;
/// `None` for a URL with no host file behind it.
async fn host_path(fs: &pi_vfs::Fs, path: &Path) -> Option<PathBuf> {
	match fs.backing_path(path).await {
		Ok(Some(backing)) => Some(backing),
		_ if pi_vfs::is_virtual_path(path) => None,
		_ => Some(path.to_path_buf()),
	}
}

/// What `path` is now; a link itself unless links are followed.
async fn stat(fs: &pi_vfs::Fs, path: &Path, follow: bool) -> io::Result<pi_vfs::Metadata> {
	if follow { fs.metadata(path).await } else { fs.symlink_metadata(path).await }
}

/// The number of entries of the directory `path`; those whose names start
/// with a dot only count with `hidden`.
async fn count_entries(fs: &pi_vfs::Fs, path: &Path, hidden: bool) -> io::Result<usize> {
	let mut count = 0;
	for entry in fs.read_dir(path).await? {
		if hidden || !entry?.file_name().as_encoded_bytes().starts_with(b".") {
			count += 1;
		}
	}
	Ok(count)
}

// ── The change source ─────────────────────────────────────────────────────────

/// Where the watch loop learns of changes to the list.
trait Changes: Send {
	/// Appends the changes reported so far to `hits`, waiting for the first:
	/// forever, or for `wait` when there is one, leaving `hits` as it was
	/// once that passes. Dropping the future loses nothing.
	///
	/// # Errors
	///
	/// The error that ended the watch.
	fn next(
		&mut self,
		wait: Option<Duration>,
		hits: &mut Vec<Hit>,
	) -> impl Future<Output = io::Result<()>> + Send;
}

/// The operating system's change notification, through [`pi_watch`].
struct Native {
	batches:  flume::Receiver<io::Result<Vec<Hit>>>,
	_watcher: pi_watch::Watcher,
}

impl Native {
	/// Watches the entries of `roots` for changes to the paths of `index`.
	fn start(roots: Vec<PathBuf>, index: Arc<Index>) -> io::Result<Self> {
		let mut config = pi_watch::Config::new(roots.into_iter().map(pi_watch::Root::flat));
		config.latency = LATENCY;
		let wanted = Arc::clone(&index);
		config.filter = Some(Box::new(move |path, flags| wanted.wants(path, notes_of(flags))));
		let (sender, batches) = flume::unbounded();
		let watcher = pi_watch::Watcher::start(config, move |batch| {
			let hits = batch.map(|batch| {
				let mut hits = Vec::with_capacity(batch.len());
				for event in batch.iter() {
					index.hits(event.path, notes_of(event.flags), &mut hits);
				}
				hits
			});
			if !hits.as_ref().is_ok_and(Vec::is_empty) {
				let _ = sender.send(hits);
			}
		})?;
		Ok(Self { batches, _watcher: watcher })
	}
}

impl Changes for Native {
	async fn next(&mut self, wait: Option<Duration>, hits: &mut Vec<Hit>) -> io::Result<()> {
		let first = match wait {
			None => self.batches.recv_async().await,
			Some(wait) => match tokio::time::timeout(wait, self.batches.recv_async()).await {
				Ok(first) => first,
				Err(_) => return Ok(()),
			},
		};
		let mut first = first.map_err(|_| io::Error::other("the watch ended"))??;
		hits.append(&mut first);
		while let Ok(more) = self.batches.try_recv() {
			hits.append(&mut more?);
		}
		Ok(())
	}
}

/// What the watcher's flags mean to `entr`.
fn notes_of(flags: pi_watch::Flags) -> Notes {
	use pi_watch::Flags;

	let mut notes = Notes::default();
	if flags.intersects(Flags::REMOVED.union(Flags::RENAMED).union(Flags::MOVED_FROM)) {
		notes = notes.with(Notes::GONE);
	}
	if flags.intersects(Flags::CREATED.union(Flags::MOVED_TO)) {
		notes = notes.with(Notes::CAME);
	}
	if flags.intersects(Flags::UPDATED.union(Flags::CLOSE_WRITE)) {
		notes = notes.with(Notes::WRITTEN);
	}
	if flags.intersects(Flags::ATTRIBUTE_MODIFIED.union(Flags::OWNER_MODIFIED).union(Flags::LINK)) {
		notes = notes.with(Notes::ATTRIBUTES);
	}
	if flags.intersects(Flags::OVERFLOW) {
		notes = notes.with(Notes::LOST);
	}
	notes
}

// ── The terminal ──────────────────────────────────────────────────────────────

/// The terminal `entr` takes its commands from: the one its output goes to.
#[cfg(unix)]
struct Terminal {
	keys:      crate::stdio::Source,
	device:    std::fs::File,
	/// The modes the terminal came with, which the utility runs under.
	cooked:    nix::sys::termios::Termios,
	/// The same without line editing and echo: every key is a command.
	immediate: nix::sys::termios::Termios,
	listening: bool,
	open:      bool,
}

#[cfg(unix)]
impl Terminal {
	/// The terminal behind stdout or stderr; `None` when neither is one.
	fn open(host: &Host) -> Option<Self> {
		use std::os::unix::fs::OpenOptionsExt as _;

		use nix::sys::termios::{LocalFlags, tcgetattr};

		let name = [host.stdout_clone(), host.stderr_clone()]
			.iter()
			.filter(|file| file.is_terminal())
			.find_map(|file| nix::unistd::ttyname(file.try_borrow_as_fd().ok()?).ok())?;
		let device = std::fs::OpenOptions::new()
			.read(true)
			.custom_flags(libc::O_NOCTTY)
			.open(name)
			.ok()?;
		let cooked = tcgetattr(&device).ok()?;
		let mut immediate = cooked.clone();
		immediate
			.local_flags
			.remove(LocalFlags::ICANON | LocalFlags::ECHO);
		let keys = crate::stdio::Source::inherited(&crate::openfile::OpenFile::from(device.try_clone().ok()?)).ok()?;
		Some(Self { keys, device, cooked, immediate, listening: false, open: true })
	}

	/// Takes keys as commands (`listening`), or gives the terminal back as
	/// it came.
	fn listen(&mut self, listening: bool) {
		if self.listening != listening {
			let modes = if listening { &self.immediate } else { &self.cooked };
			// Never waits for pending output to drain: that would hold a
			// runtime thread for as long as nobody reads the terminal.
			let _ = nix::sys::termios::tcsetattr(&self.device, nix::sys::termios::SetArg::TCSANOW, modes);
			self.listening = listening;
		}
	}

	/// The terminal as a utility's stdin.
	fn stdin(&self) -> Option<Fd> {
		self.device.try_clone().ok().map(Fd::File)
	}

	/// Whether the terminal still has keys to give.
	const fn is_open(&self) -> bool {
		self.open
	}

	/// The next key; `None` once the terminal is gone.
	async fn key(&mut self) -> Option<u8> {
		let mut key = [0];
		match self.keys.read(&mut key).await {
			Ok(1) => Some(key[0]),
			_ => {
				self.open = false;
				None
			},
		}
	}
}

#[cfg(unix)]
impl Drop for Terminal {
	fn drop(&mut self) {
		self.listen(false);
	}
}

/// No terminal to take commands from on this platform.
#[cfg(not(unix))]
enum Terminal {}

#[cfg(not(unix))]
impl Terminal {
	const fn open(_host: &Host) -> Option<Self> {
		None
	}

	const fn listen(&mut self, _listening: bool) {
		match *self {}
	}

	const fn stdin(&self) -> Option<Fd> {
		match *self {}
	}

	const fn is_open(&self) -> bool {
		match *self {}
	}

	#[allow(clippy::unused_async, reason = "the terminal's signature where there is one")]
	async fn key(&mut self) -> Option<u8> {
		match *self {}
	}
}

/// The next key of `terminal`; never, without a terminal that has any.
async fn key(terminal: &mut Option<Terminal>) -> Option<u8> {
	match terminal {
		Some(terminal) if terminal.is_open() => terminal.key().await,
		_ => std::future::pending().await,
	}
}

// ── The utility ───────────────────────────────────────────────────────────────

/// A utility that was started and not waited for (`-r`, `-z`).
struct Child {
	exit:    BoxFuture<'static, io::Result<CommandStatus>>,
	/// Signals for the utility's process tree.
	signals: flume::Sender<i32>,
}

/// How `child` ended; never, without one.
async fn exited(child: &mut Option<Child>) -> io::Result<CommandStatus> {
	match child {
		Some(child) => (&mut child.exit).await,
		None => std::future::pending().await,
	}
}

/// The awk process `-x` formats exit statuses with: it reads one
/// `exit|<status>|<name>` or `signal|<number>|<name>` line per run.
struct StatusFilter {
	lines: io::PipeWriter,
	exit:  BoxFuture<'static, io::Result<CommandStatus>>,
	/// The utility's name in the lines.
	label: String,
}

impl StatusFilter {
	/// Starts awk on the status script, installing the example script when
	/// there is none. `Err` is the status of an error that ends `entr`.
	async fn start(host: &mut Host, fs: &pi_vfs::Fs, level: u8, label: String) -> Result<Self, i32> {
		let script = match host.var("ENTR_STATUS_SCRIPT").filter(|script| !script.is_empty()) {
			Some(script) => PathBuf::from(script),
			None => match host.var(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
				Some(home) => Path::new(home).join(".entr").join("status.awk"),
				None => return Err(fail(host, "getpwuid")),
			},
		};
		let path = located(host, &script);
		if !fs.exists(&path).await {
			if let Some(directory) = pi_vfs::parent_path(&path)
				&& !fs.exists(directory).await
			{
				let _ = fs.create_dir(directory).await;
			}
			let _ = writeln!(host.stdout_writer(), "entr: created '{}'", script.display());
			if let Err(error) = fs.write(&path, EXAMPLE_STATUS_SCRIPT).await {
				return Err(fail(host, format_args!("open: {}", strip_errno(&error))));
			}
		}
		// The script is confined by the system awk's own sandbox; with `-xx`
		// it is not, and any awk runs it.
		let mut argv: Vec<OsString> = match level {
			1 => match system_awk(host) {
				Some(awk) => vec![awk.into_os_string()],
				None => return Err(fail(host, "could not exec /usr/bin/awk")),
			},
			_ => vec!["awk".into()],
		};
		argv.extend(["-F".into(), "|".into(), "-f".into(), script.into_os_string()]);
		if level == 1 {
			argv.push(if cfg!(any(target_os = "linux", target_os = "android")) { "-S" } else { "-safe" }.into());
		}
		let started = match io::pipe() {
			Ok((reader, lines)) => host
				.spawn_command_async(ShellCommand::new(argv).stdin(Fd::File(pipe_file(reader))))
				.await
				.map(|running| (running, lines)),
			Err(error) => Err(error),
		};
		match started {
			Ok((running, lines)) => Ok(Self { lines, exit: running.wait().boxed(), label }),
			Err(error) => Err(fail(host, format_args!("pipe: {}", strip_errno(&error)))),
		}
	}

	/// Hands `status` to the script.
	fn report(&mut self, status: CommandStatus) {
		let _ = match status {
			CommandStatus::Exited(code) => writeln!(self.lines, "exit|{code}|{}", self.label),
			CommandStatus::Signaled(signal) => writeln!(self.lines, "signal|{signal}|{}", self.label),
		};
	}

	/// Ends the script's input and waits for what it still prints.
	async fn close(self) {
		let Self { lines, exit, .. } = self;
		drop(lines);
		let _ = exit.await;
	}
}

/// Resolves once the status process of `filter` is gone; never, without one.
async fn filter_gone(filter: &mut Option<StatusFilter>) {
	match filter {
		Some(filter) => {
			let _ = (&mut filter.exit).await;
		},
		None => std::future::pending().await,
	}
}

/// The read end of a pipe as a command's stdin.
fn pipe_file(reader: io::PipeReader) -> std::fs::File {
	#[cfg(unix)]
	{
		std::fs::File::from(std::os::fd::OwnedFd::from(reader))
	}
	#[cfg(windows)]
	{
		std::fs::File::from(std::os::windows::io::OwnedHandle::from(reader))
	}
}

/// The system's awk, which has the sandbox `-x` confines the status script
/// to: `/usr/bin/awk`, else the first on `PATH`.
fn system_awk(host: &Host) -> Option<PathBuf> {
	if cfg!(windows) {
		return None;
	}
	std::iter::once(PathBuf::from("/usr/bin/awk"))
		.chain(
			host
				.var("PATH")
				.into_iter()
				.flat_map(std::env::split_paths)
				.map(|directory| directory.join("awk")),
		)
		.find(|awk| awk.is_file())
}

// ── The watch loop ────────────────────────────────────────────────────────────

/// Where the loop stands between runs.
#[derive(Clone, Copy)]
enum Phase {
	/// Nothing is pending.
	Idle,
	/// A change is waiting for the burst it belongs to to end.
	Gathering { since: Instant },
	/// The utility just ran or started: changes are discounted until the files
	/// have been quiet.
	Settling { since: Instant },
}

/// What ended a wait.
enum Wake {
	Changes(io::Result<()>),
	Key(Option<u8>),
	Exited(io::Result<CommandStatus>),
	StatusProcessGone,
}

/// One run of `entr`, from the first run of the utility to the exit status.
struct Session {
	options:        Options,
	/// The utility and its arguments.
	utility:        Vec<OsString>,
	/// `-s`: the shell that evaluates the utility.
	shell:          OsString,
	/// Whether the utility gets `PAGER=/bin/cat`, so nothing waits for a key
	/// to page its output.
	default_pager:  bool,
	restart_signal: i32,
	/// `ENTR_FOLLOW_SYMLINK`: listed links are looked through.
	follow:         bool,
	/// `EV_TRACE`: every change is printed.
	trace:          bool,
	fs:             pi_vfs::Fs,
	entries:        Vec<Entry>,
	/// The entry `/_` stands for: the first file to change before a run; the
	/// first listed until then.
	leading:        usize,
	/// Whether a change since the last run chose [`Session::leading`].
	leading_set:    bool,
	/// A change is waiting to run the utility.
	pending:        bool,
	/// A tracked directory gained or lost an entry.
	altered:        bool,
	child:          Option<Child>,
	/// `-z` without `-r`: earlier runs a change started another run beside.
	superseded:     Vec<Child>,
	status:         Option<StatusFilter>,
	terminal:       Option<Terminal>,
	/// The directories counted since the last wait.
	counted:        Vec<u32>,
}

impl Session {
	/// Runs the utility, then again on every change, until a key, the
	/// utility's exit (`-z`) or an altered directory ends it. Returns the exit
	/// status.
	async fn watch(mut self, host: &mut Host, mut changes: impl Changes) -> i32 {
		let mut phase = Phase::Idle;
		if !self.options.postpone {
			if let Err(code) = self.run_utility(host).await {
				return self.finish(code).await;
			}
			if !self.options.all_events {
				phase = Phase::Settling { since: Instant::now() };
			}
		}
		let mut hits = Vec::new();
		loop {
			let wait = match phase {
				Phase::Idle => None,
				Phase::Gathering { .. } => Some(QUIET),
				Phase::Settling { .. } => Some(SETTLE),
			};
			if let Some(terminal) = &mut self.terminal {
				terminal.listen(true);
			}
			let _ = host.flush_output().await;
			hits.clear();
			let wake = tokio::select! {
				result = changes.next(wait, &mut hits) => Wake::Changes(result),
				key = key(&mut self.terminal) => Wake::Key(key),
				status = exited(&mut self.child) => Wake::Exited(status),
				() = filter_gone(&mut self.status) => Wake::StatusProcessGone,
			};
			if let Some(terminal) = &mut self.terminal {
				terminal.listen(false);
			}
			let mut run_now = false;
			match wake {
				Wake::Changes(Ok(())) => {},
				Wake::Changes(Err(error)) => {
					warn(host, strip_errno(&error));
					return self.finish(1).await;
				},
				Wake::Key(Some(b' ')) => run_now = true,
				Wake::Key(Some(b'q')) => return self.finish(0).await,
				Wake::Key(_) => continue,
				Wake::Exited(status) => {
					self.child = None;
					let status = self.ended(host, status);
					if self.options.oneshot {
						if !self.options.restart {
							self.report(status);
						}
						return self.finish(status.code()).await;
					}
					continue;
				},
				Wake::StatusProcessGone => {
					self.status = None;
					warn(host, "status process terminated");
					return self.finish(0).await;
				},
			}
			match phase {
				Phase::Settling { since } => {
					if let Err(code) = self.recover(host, &hits).await {
						return self.finish(code).await;
					}
					if !run_now && !hits.is_empty() && since.elapsed() < BURST_LIMIT {
						continue;
					}
					phase = Phase::Idle;
					if !run_now {
						continue;
					}
				},
				Phase::Idle | Phase::Gathering { .. } => {
					let changed = match self.absorb(host, &hits).await {
						Ok(changed) => changed,
						Err(code) => return self.finish(code).await,
					};
					if changed && !run_now {
						let since = match phase {
							Phase::Gathering { since } => since,
							_ => Instant::now(),
						};
						if since.elapsed() < BURST_LIMIT {
							phase = Phase::Gathering { since };
							continue;
						}
					}
					phase = Phase::Idle;
				},
			}
			if run_now || self.pending {
				self.pending = false;
				if let Err(code) = self.run_utility(host).await {
					return self.finish(code).await;
				}
				self.leading_set = false;
				if !self.options.all_events {
					phase = Phase::Settling { since: Instant::now() };
				}
			}
			if self.altered {
				warn(host, "directory altered");
				return self.finish(2).await;
			}
		}
	}

	/// Takes in the changes `hits`: whether any of them calls for a run, now
	/// or once the burst ends. `Err` is the status of an error that ends
	/// `entr`.
	async fn absorb(&mut self, host: &mut Host, hits: &[Hit]) -> Result<bool, i32> {
		let mut changed = false;
		self.counted.clear();
		for (at, hit) in hits.iter().enumerate() {
			let entry = hit.entry as usize;
			if hit.notes.intersects(Notes::LOST) {
				// Anything may have changed: run, and count every directory.
				self.pending = true;
				changed = true;
				for entry in 0..self.entries.len() {
					changed |= self.count(host, entry).await?;
				}
				continue;
			}
			if matches!(self.entries[entry].kind, Kind::Directory { .. }) {
				changed |= self.count(host, entry).await?;
				continue;
			}
			let replaced = hit.notes.intersects(Notes::GONE.with(Notes::CAME));
			let mut triggers = replaced || hit.notes.intersects(Notes::WRITTEN);
			if replaced {
				self.reappear(host, entry).await?;
			} else {
				// A change of attributes alone counts when it shows: other
				// permissions, another file, a new modification time.
				triggers |= self.look(entry).await;
			}
			if self.trace {
				let mode = match &self.entries[entry].kind {
					Kind::File(seen) => seen.mode,
					Kind::Directory { .. } => 0,
				};
				let _ = writeln!(
					host.stderr,
					"{at}/{}: fflags: 0x{:x} r {mode:o} {}",
					hits.len(),
					hit.notes.0,
					self.entries[entry].path.display()
				);
			}
			if triggers {
				changed = true;
				self.pending = true;
				if !self.leading_set {
					self.leading = entry;
					self.leading_set = true;
				}
			}
		}
		Ok(changed)
	}

	/// Takes in changes made while the utility ran: they call for no run, but
	/// a file that went away is still waited for.
	async fn recover(&mut self, host: &mut Host, hits: &[Hit]) -> Result<(), i32> {
		for hit in hits {
			let entry = hit.entry as usize;
			if matches!(self.entries[entry].kind, Kind::File(_)) && !hit.notes.intersects(Notes::LOST) {
				if hit.notes.intersects(Notes::GONE.with(Notes::CAME)) {
					self.reappear(host, entry).await?;
				} else {
					self.look(entry).await;
				}
			}
		}
		Ok(())
	}

	/// Looks at the file `entry` again: whether its permissions, identity or
	/// modification time differ from what was last seen.
	async fn look(&mut self, entry: usize) -> bool {
		let Ok(metadata) = stat(&self.fs, &self.entries[entry].path, self.follow).await else {
			return false;
		};
		let now = Seen::of(&metadata);
		match &mut self.entries[entry].kind {
			Kind::File(seen) if *seen != now => {
				*seen = now;
				true
			},
			_ => false,
		}
	}

	/// Waits for the file `entry`, which was removed, renamed or replaced, to
	/// be there again: an editor saving it puts it back within moments.
	/// `Err` once it stays away.
	async fn reappear(&mut self, host: &mut Host, entry: usize) -> Result<(), i32> {
		let mut tries = 0;
		let error = loop {
			match stat(&self.fs, &self.entries[entry].path, self.follow).await {
				Ok(metadata) => {
					if let Kind::File(seen) = &mut self.entries[entry].kind {
						*seen = Seen::of(&metadata);
					}
					return Ok(());
				},
				Err(error) if tries == REAPPEAR_TRIES => break error,
				Err(_) => {
					tries += 1;
					tokio::time::sleep(RETRY).await;
				},
			}
		};
		Err(fail(
			host,
			format_args!("cannot open '{}': {}", self.entries[entry].name.display(), strip_errno(&error)),
		))
	}

	/// Counts the entries of the directory `entry`, once per wait: whether
	/// their number is still off after a save in progress had time to end. An
	/// altered directory calls for a run unless the utility is persistent.
	async fn count(&mut self, host: &mut Host, entry: usize) -> Result<bool, i32> {
		let Kind::Directory { entries } = self.entries[entry].kind else {
			return Ok(false);
		};
		if self.altered || self.counted.contains(&(entry as u32)) {
			return Ok(false);
		}
		self.counted.push(entry as u32);
		let hidden = self.options.directories == 2;
		for tries in 0..DIRECTORY_TRIES {
			if tries > 0 {
				tokio::time::sleep(RETRY).await;
			}
			match count_entries(&self.fs, &self.entries[entry].path, hidden).await {
				Ok(now) if now == entries => return Ok(false),
				Ok(_) => {},
				Err(_) => {
					return Err(fail(
						host,
						format_args!("unable to open directory: '{}'", self.entries[entry].name.display()),
					));
				},
			}
		}
		self.altered = true;
		if !self.options.restart {
			self.pending = true;
		}
		Ok(true)
	}

	/// The utility's command line for this run: the first `/_` is the file
	/// that changed first; under `-s` that file is the shell's `$0`.
	fn command(&self) -> ShellCommand {
		let leading = self.entries[self.leading].path.as_os_str();
		let argv = if self.options.shell {
			vec![self.shell.clone(), "-c".into(), self.utility[0].clone(), leading.to_owned()]
		} else {
			let mut replaced = false;
			self
				.utility
				.iter()
				.map(|argument| {
					if !replaced && argument == "/_" {
						replaced = true;
						leading.to_owned()
					} else {
						argument.clone()
					}
				})
				.collect()
		};
		let command = ShellCommand::new(argv);
		if self.default_pager { command.env("PAGER", "/bin/cat") } else { command }
	}

	/// Runs the utility: to its end, or with `-r` and `-z` only started (a
	/// persistent one is ended first). `Err` is the status of an error that
	/// ends `entr`.
	async fn run_utility(&mut self, host: &mut Host) -> Result<(), i32> {
		if self.options.restart {
			self.terminate().await;
			tokio::time::sleep(Duration::from_millis(1)).await;
		} else if let Some(child) = self.child.take() {
			self.superseded.push(child);
		}
		let clear: &[u8] = match self.options.clear {
			0 => b"",
			1 => b"\x1b[2J\x1b[H",
			_ => b"\x1b[2J\x1b[3J\x1b[H",
		};
		let _ = host.stdout_writer().write_all(clear);
		let mut command = self.command();
		// A persistent utility reads nothing; any other may ask its questions
		// on the terminal.
		if !self.options.restart
			&& let Some(stdin) = self.terminal.as_ref().and_then(Terminal::stdin)
		{
			command = command.stdin(stdin);
		}
		// Only a utility that is not waited for here is ever signalled.
		let mut signals = None;
		if self.options.restart || self.options.oneshot {
			let (sender, receiver) = flume::unbounded();
			command = command.signals(receiver);
			signals = Some(sender);
		}
		let running = match host.spawn_command_async(command).await {
			Ok(running) => running,
			Err(error) => return Err(fail(host, strip_errno(&error))),
		};
		match signals {
			Some(signals) => self.child = Some(Child { exit: running.wait().boxed(), signals }),
			None => {
				let status = running.wait().await;
				let status = self.ended(host, status);
				self.report(status);
			},
		}
		Ok(())
	}

	/// How a run ended; one that could not start says so and counts as a
	/// failed run.
	fn ended(&self, host: &mut Host, status: io::Result<CommandStatus>) -> CommandStatus {
		status.unwrap_or_else(|error| {
			let program = if self.options.shell { &self.shell } else { &self.utility[0] };
			// The host reports a command it cannot find or run by kind alone.
			let reason = match error.kind() {
				io::ErrorKind::NotFound => "No such file or directory".to_owned(),
				io::ErrorKind::PermissionDenied => "Permission denied".to_owned(),
				_ => strip_errno(&error),
			};
			warn(host, format_args!("exec {}: {reason}", program.display()));
			CommandStatus::Exited(1)
		})
	}

	/// `-x`: hands the exit status to the status script.
	fn report(&mut self, status: CommandStatus) {
		if let Some(filter) = &mut self.status {
			filter.report(status);
		}
	}

	/// Ends a utility that is still running and waits until it is gone, so
	/// what it held (a socket, a lock) is free again.
	async fn terminate(&mut self) {
		if let Some(child) = self.child.take() {
			let _ = child.signals.send(self.restart_signal);
			let _ = child.exit.await;
		}
	}

	/// Ends what is still running and returns `code`.
	async fn finish(mut self, code: i32) -> i32 {
		self.terminate().await;
		for child in std::mem::take(&mut self.superseded) {
			let _ = child.signals.send(self.restart_signal);
			let _ = child.exit.await;
		}
		if let Some(filter) = self.status.take() {
			filter.close().await;
		}
		code
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn args(words: &[&str]) -> Vec<OsString> {
		words.iter().map(OsString::from).collect()
	}

	/// Failure mode: an option of the utility is taken for one of entr's, or
	/// a clustered or repeated option is lost.
	#[test]
	fn options_end_at_the_utility() {
		let expected = Options { clear: 2, restart: true, oneshot: true, ..Options::default() };
		assert_eq!(parse(&args(&["-cc", "-rz", "node", "-p", "app.js"])), Parsed::Run(expected, 2));
		assert_eq!(parse(&args(&["--", "-odd"])), Parsed::Run(Options::default(), 1));
		assert_eq!(parse(&args(&["-p"])), Parsed::Usage);
		assert_eq!(parse(&args(&["-q", "make"])), Parsed::Illegal('q'));
	}

	/// Failure mode: `-s` silently drops the words after its command line, or
	/// `-r` runs with a status filter that would report its restarts.
	#[test]
	fn refused_combinations_are_named() {
		assert_eq!(
			parse(&args(&["-s", "make", "test"])),
			Parsed::Refused("-s requires commands to be formatted as a single argument")
		);
		assert_eq!(parse(&args(&["-rx", "make"])), Parsed::Refused("-r and -x may not be combined"));
	}

	/// Failure mode: `ENTR_RESTART_SIGNAL=SIGUSR1` restarts with `SIGTERM`, or
	/// a misspelt signal is accepted.
	#[test]
	fn the_restart_signal_is_named_with_or_without_sig() {
		assert_eq!(restart_signal(None), Ok(signal::TERM));
		assert_eq!(restart_signal(Some("SIGUSR1")), Ok(signal::USR1));
		assert_eq!(restart_signal(Some("INT")), Ok(signal::INT));
		assert_eq!(restart_signal(Some("SIGKILL")), Err("KILL".to_owned()));
	}
}

/// `entr` against real files, with its commands run by the test runner.
#[cfg(all(test, unix))]
mod watching {
	use std::{
		collections::HashMap,
		fs,
		io::{Read as _, Write as _},
		path::{Path, PathBuf},
		time::{Duration, Instant},
	};

	use tokio_util::sync::CancellationToken;

	use crate::{
		extras::{Fd, Invocation},
		host::TestRunner,
	};

	/// How long anything `entr` should do may take before a test fails.
	const PATIENCE: Duration = Duration::from_secs(20);
	/// Longer than `entr` discounts changes for after a run.
	const SETTLED: Duration = Duration::from_millis(400);

	/// A running `entr`, its output in files that can be read while it runs.
	struct Watching {
		running: tokio::task::JoinHandle<i32>,
		cancel:  CancellationToken,
		logs:    tempfile::TempDir,
	}

	impl Watching {
		/// Starts `entr argv` in `cwd` with `list` on stdin.
		fn start(cwd: &Path, argv: &[&str], list: &str) -> Self {
			Self::start_with(cwd, argv, list, &[], pi_vfs::Fs::native())
		}

		fn start_with(cwd: &Path, argv: &[&str], list: &str, env: &[(&str, &str)], filesystem: pi_vfs::Fs) -> Self {
			let logs = tempfile::tempdir().expect("log directory");
			let log = |name: &str| {
				fs::OpenOptions::new()
					.create(true)
					.append(true)
					.open(logs.path().join(name))
					.expect("log file")
			};
			let (stdout, stderr) = (log("out"), log("err"));
			fs::write(logs.path().join("list"), list).expect("list");
			let stdin = fs::File::open(logs.path().join("list")).expect("list");
			let cancel = CancellationToken::new();
			let invocation = invocation(cwd, argv, env, filesystem, [stdin, stdout, stderr], cancel.clone());
			Self { running: tokio::spawn(crate::extras::run(invocation)), cancel, logs }
		}

		fn out(&self) -> String {
			fs::read_to_string(self.logs.path().join("out")).expect("stdout")
		}

		fn err(&self) -> String {
			fs::read_to_string(self.logs.path().join("err")).expect("stderr")
		}

		/// Waits until stdout satisfies `done`, and returns it.
		async fn until(&self, done: impl Fn(&str) -> bool) -> String {
			let deadline = Instant::now() + PATIENCE;
			loop {
				let out = self.out();
				if done(&out) {
					return out;
				}
				assert!(Instant::now() < deadline, "stdout {out:?}, stderr {:?}", self.err());
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		}

		/// Makes `change` until stdout satisfies `done`: a change that falls
		/// into the moment `entr` discounts changes for is made again.
		async fn nudge(&self, change: impl Fn(), done: impl Fn(&str) -> bool) -> String {
			let deadline = Instant::now() + PATIENCE;
			loop {
				change();
				let tried = Instant::now();
				while tried.elapsed() < Duration::from_secs(1) {
					let out = self.out();
					if done(&out) {
						return out;
					}
					tokio::time::sleep(Duration::from_millis(10)).await;
				}
				assert!(Instant::now() < deadline, "stdout {:?}, stderr {:?}", self.out(), self.err());
			}
		}

		/// Waits for `entr` to exit by itself: its status, stdout and stderr.
		async fn exit(self) -> (i32, String, String) {
			let Self { running, logs, .. } = self;
			let code = tokio::time::timeout(PATIENCE, running)
				.await
				.expect("entr should have exited")
				.expect("entr task");
			let read = |name: &str| fs::read_to_string(logs.path().join(name)).expect("log");
			(code, read("out"), read("err"))
		}

		/// Cancels `entr` as the shell does, and waits for it.
		async fn stop(self) -> (i32, String, String) {
			self.cancel.cancel();
			self.exit().await
		}
	}

	fn invocation(
		cwd: &Path,
		argv: &[&str],
		env: &[(&str, &str)],
		filesystem: pi_vfs::Fs,
		[stdin, stdout, stderr]: [fs::File; 3],
		cancel: CancellationToken,
	) -> Invocation {
		let mut vars: HashMap<String, String> = std::env::vars().collect();
		vars.insert("SHELL".into(), "/bin/sh".into());
		for name in ["ENTR_RESTART_SIGNAL", "ENTR_FOLLOW_SYMLINK", "ENTR_STATUS_SCRIPT", "EV_TRACE"] {
			vars.remove(name);
		}
		vars.extend(env.iter().map(|(name, value)| ((*name).to_owned(), (*value).to_owned())));
		let runner = TestRunner::new(
			vars.clone(),
			cwd.to_path_buf(),
			stdout.try_clone().expect("stdout"),
			stderr.try_clone().expect("stderr"),
		);
		let argv = std::iter::once("entr").chain(argv.iter().copied()).map(str::to_owned).collect();
		let mut invocation = Invocation::new(argv, cwd.to_path_buf(), filesystem);
		invocation.env = vars;
		invocation.stdio = [Fd::File(stdin), Fd::File(stdout), Fd::File(stderr)];
		invocation.commands = Some(Box::new(runner));
		invocation.cancel = Some(cancel);
		invocation
	}

	/// A directory holding the files `names`, by its real path (the temporary
	/// directory is behind a symbolic link on macOS).
	fn tree(names: &[&str]) -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().expect("directory");
		let root = dir.path().canonicalize().expect("real path");
		for name in names {
			fs::write(root.join(name), "first\n").expect("file");
		}
		(dir, root)
	}

	fn runs(out: &str) -> usize {
		out.matches("ran\n").count()
	}

	fn append(path: &Path) {
		let mut file = fs::OpenOptions::new().append(true).open(path).expect("open");
		file.write_all(b"more\n").expect("write");
	}

	/// Failure mode: the utility does not run when `entr` starts, or a write
	/// to a listed file does not run it again; a cancelled `entr` lingers.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_change_runs_the_utility_again() {
		let (_dir, root) = tree(&["a.txt", "b.txt"]);
		let watching = Watching::start(&root, &["echo", "ran"], "a.txt\nb.txt\n");
		watching.until(|out| runs(out) == 1).await;
		watching.nudge(|| append(&root.join("b.txt")), |out| runs(out) >= 2).await;
		let (code, _, err) = watching.stop().await;
		assert_eq!((code, err.as_str()), (130, ""));
	}

	/// Failure mode: `-p` still runs the utility before anything changed.
	#[tokio::test(flavor = "multi_thread")]
	async fn postponing_waits_for_the_first_change() {
		let (_dir, root) = tree(&["a.txt"]);
		let watching = Watching::start(&root, &["-p", "echo", "ran"], "a.txt\n");
		tokio::time::sleep(SETTLED).await;
		assert_eq!(watching.out(), "");
		watching.nudge(|| append(&root.join("a.txt")), |out| runs(out) >= 1).await;
		assert_eq!(watching.stop().await.0, 130);
	}

	/// Failure mode: `/_` is not replaced, every `/_` is, or it names a file
	/// other than the first listed (before any change) and the one that
	/// changed (after).
	#[tokio::test(flavor = "multi_thread")]
	async fn the_placeholder_names_the_file_that_changed() {
		let (_dir, root) = tree(&["a.txt", "b.txt"]);
		let watching = Watching::start(&root, &["echo", "saw", "/_", "/_"], "a.txt\nb.txt\n");
		let first = format!("saw {} /_\n", root.join("a.txt").display());
		assert_eq!(watching.until(|out| out.ends_with('\n')).await, first);
		let second = format!("saw {} /_\n", root.join("b.txt").display());
		let out = watching
			.nudge(|| append(&root.join("b.txt")), |out| out.len() > first.len() && out.ends_with('\n'))
			.await;
		assert_eq!(&out[first.len()..first.len() + second.len()], second);
		watching.stop().await;
	}

	/// Failure mode: `-s` does not hand the command line to the shell, or the
	/// changed file is not its `$0`.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_shell_command_line_reads_the_file_from_its_name() {
		let (_dir, root) = tree(&["a.txt"]);
		let watching = Watching::start(&root, &["-s", "echo \"$0\" | tr a-z A-Z"], "a.txt\n");
		let expected = format!("{}\n", root.join("a.txt").display()).to_uppercase();
		assert_eq!(watching.until(|out| out.ends_with('\n')).await, expected);
		watching.stop().await;
	}

	/// Failure mode: `-z` keeps watching after the utility exits, or loses
	/// its exit status or the signal that killed it.
	#[tokio::test(flavor = "multi_thread")]
	async fn oneshot_exits_with_the_status_of_the_utility() {
		let (_dir, root) = tree(&["a.txt"]);
		let (code, ..) = Watching::start(&root, &["-z", "sh", "-c", "exit 7"], "a.txt\n")
			.exit()
			.await;
		assert_eq!(code, 7);
		let (code, ..) = Watching::start(&root, &["-z", "sh", "-c", "kill -TERM $$"], "a.txt\n")
			.exit()
			.await;
		assert_eq!(code, 128 + libc::SIGTERM);

		let watching = Watching::start(&root, &["-pz", "sh", "-c", "echo ran; exit 3"], "a.txt\n");
		watching.nudge(|| append(&root.join("a.txt")), |out| runs(out) >= 1).await;
		let (code, out, _) = watching.exit().await;
		assert_eq!((code, out.as_str()), (3, "ran\n"));
	}

	/// Failure mode: a file added to the directory of a listed file goes
	/// unnoticed, so the caller's loop never lists it; or a hidden file ends
	/// the watch without `-dd`.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_new_file_in_a_tracked_directory_exits_with_2() {
		let (_dir, root) = tree(&["a.txt"]);
		let watching = Watching::start(&root, &["-d", "echo", "ran"], "a.txt\n");
		watching.until(|out| runs(out) == 1).await;
		tokio::time::sleep(SETTLED).await;
		fs::write(root.join(".hidden"), "").expect("hidden file");
		tokio::time::sleep(Duration::from_secs(1)).await;
		assert!(!watching.running.is_finished(), "stderr {:?}", watching.err());

		let deadline = Instant::now() + PATIENCE;
		let mut made = 0;
		while !watching.running.is_finished() {
			assert!(Instant::now() < deadline, "stderr {:?}", watching.err());
			fs::write(root.join(format!("new{made}.txt")), "").expect("new file");
			made += 1;
			tokio::time::sleep(Duration::from_secs(1)).await;
		}
		let (code, out, err) = watching.exit().await;
		assert_eq!((code, err.as_str()), (2, "entr: directory altered\n"));
		assert_eq!(runs(&out), 2, "the utility runs once more before entr exits");
	}

	/// Failure mode: a file saved by writing a temporary file and renaming it
	/// over the original is watched no longer after the first save; a file
	/// deleted and created again ends the watch.
	#[tokio::test(flavor = "multi_thread")]
	async fn replaced_files_stay_under_watch() {
		let (_dir, root) = tree(&["a.txt"]);
		let file = root.join("a.txt");
		let watching = Watching::start(&root, &["echo", "ran"], "a.txt\n");
		watching.until(|out| runs(out) == 1).await;
		let save = || {
			let temporary = root.join(".a.txt.tmp");
			fs::write(&temporary, "saved\n").expect("temporary file");
			fs::rename(&temporary, &file).expect("rename");
		};
		for seen in 1..=3 {
			watching.nudge(save, |out| runs(out) > seen).await;
			tokio::time::sleep(SETTLED).await;
		}
		let seen = runs(&watching.out());
		let recreate = || {
			fs::remove_file(&file).expect("remove");
			std::thread::sleep(Duration::from_millis(30));
			fs::write(&file, "again\n").expect("create");
		};
		watching.nudge(recreate, |out| runs(out) > seen).await;
		let (code, _, err) = watching.stop().await;
		assert_eq!((code, err.as_str()), (130, ""));
	}

	/// Failure mode: `entr` keeps waiting for a listed file that is gone for
	/// good.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_file_that_stays_away_ends_the_watch() {
		let (_dir, root) = tree(&["a.txt"]);
		let watching = Watching::start(&root, &["echo", "ran"], "a.txt\n");
		watching.until(|out| runs(out) == 1).await;
		tokio::time::sleep(SETTLED).await;
		fs::remove_file(root.join("a.txt")).expect("remove");
		let (code, _, err) = watching.exit().await;
		assert_eq!((code, err.as_str()), (1, "entr: cannot open 'a.txt': No such file or directory\n"));
	}

	/// Failure mode: `-r` starts a second copy beside the running utility, or
	/// leaves it running when `entr` exits.
	#[tokio::test(flavor = "multi_thread")]
	async fn reload_ends_the_utility_before_starting_it_again() {
		let (_dir, root) = tree(&["a.txt"]);
		let server = "echo up; trap 'echo down; exit 0' TERM; while :; do sleep 0.05; done";
		let watching = Watching::start(&root, &["-r", "sh", "-c", server], "a.txt\n");
		watching.until(|out| out == "up\n").await;
		let out = watching
			.nudge(|| append(&root.join("a.txt")), |out| out.matches("up\n").count() >= 2)
			.await;
		assert!(out.starts_with("up\ndown\nup\n"), "{out:?}");
		tokio::time::sleep(SETTLED).await;
		fs::remove_file(root.join("a.txt")).expect("remove");
		let (code, out, _) = watching.exit().await;
		assert_eq!(code, 1);
		assert!(out.ends_with("up\ndown\n"), "{out:?}");
		assert_eq!(out.matches("up\n").count(), out.matches("down\n").count(), "{out:?}");
	}

	/// Failure mode: a utility that writes a listed file runs itself in a
	/// loop; with `-a` such a change is not answered.
	#[tokio::test(flavor = "multi_thread")]
	async fn changes_made_during_a_run_only_count_when_asked_for() {
		let (_dir, root) = tree(&["a.txt"]);
		let rewrite = "echo ran; echo more >> a.txt";
		let watching = Watching::start(&root, &["sh", "-c", rewrite], "a.txt\n");
		watching.until(|out| runs(out) == 1).await;
		tokio::time::sleep(Duration::from_secs(1)).await;
		assert_eq!(runs(&watching.out()), 1);
		watching.stop().await;

		let watching = Watching::start(&root, &["-a", "sh", "-c", rewrite], "a.txt\n");
		watching.until(|out| runs(out) >= 3).await;
		watching.stop().await;
	}

	/// Failure mode: a burst of writes (a checkout, a formatter) runs the
	/// utility once per write.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_burst_of_changes_is_one_run() {
		let (_dir, root) = tree(&["a.txt", "b.txt", "c.txt"]);
		let watching = Watching::start(&root, &["echo", "ran"], "a.txt\nb.txt\nc.txt\n");
		watching.until(|out| runs(out) == 1).await;
		tokio::time::sleep(SETTLED).await;
		for _ in 0..200 {
			for name in ["a.txt", "b.txt", "c.txt"] {
				append(&root.join(name));
			}
		}
		watching.until(|out| runs(out) == 2).await;
		tokio::time::sleep(Duration::from_secs(1)).await;
		assert_eq!(runs(&watching.out()), 2);
		watching.stop().await;
	}

	/// Failure mode: `-xx` prints no status line, or the example script is
	/// not installed where `ENTR_STATUS_SCRIPT` points.
	#[cfg(feature = "util.awk")]
	#[tokio::test(flavor = "multi_thread")]
	async fn the_status_script_formats_the_exit_status() {
		let (_dir, root) = tree(&["a.txt"]);
		let scripts = tempfile::tempdir().expect("script directory");
		let script = scripts.path().join("status.awk");
		let script = script.to_str().expect("utf-8 path");
		let watching = Watching::start_with(
			&root,
			&["-xxz", "sh", "-c", "exit 3"],
			"a.txt\n",
			&[("ENTR_STATUS_SCRIPT", script)],
			pi_vfs::Fs::native(),
		);
		let (code, out, err) = watching.exit().await;
		assert_eq!((code, err.as_str()), (3, ""));
		assert_eq!(out, format!("entr: created '{script}'\nsh returned exit code 3\n"));
	}

	/// Failure mode: a list with nothing to watch starts a watch that can
	/// never fire, or a listed path that does not exist is passed over in
	/// silence.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_list_without_files_is_an_error() {
		let (_dir, root) = tree(&[]);
		let (code, out, err) = Watching::start(&root, &["echo", "ran"], "\nmissing.txt\n")
			.exit()
			.await;
		assert_eq!(code, 1);
		assert_eq!(out, "");
		assert_eq!(err, "entr: unable to stat 'missing.txt'\nentr: No regular files to watch\n");
	}

	/// A provider serving `local://` from the host directory `root`.
	#[derive(Debug)]
	struct Local {
		root: PathBuf,
	}

	impl Local {
		fn host(&self, path: &Path) -> Option<PathBuf> {
			let below = path.to_str()?.strip_prefix("local://")?;
			Some(self.root.join(below))
		}
	}

	#[async_trait::async_trait]
	impl pi_vfs::FileSystem for Local {
		fn is_native_local(&self, path: &Path) -> bool {
			!pi_vfs::is_virtual_path(path)
		}

		async fn backing_path(&self, path: &Path) -> std::io::Result<Option<PathBuf>> {
			Ok(self.host(path))
		}

		async fn open(&self, _path: &Path, _options: &pi_vfs::OpenOptions) -> std::io::Result<pi_vfs::File> {
			Err(std::io::ErrorKind::Unsupported.into())
		}

		async fn metadata(&self, path: &Path) -> std::io::Result<pi_vfs::Metadata> {
			match self.host(path) {
				Some(file) => fs::metadata(file).map(pi_vfs::Metadata::from),
				None => Err(std::io::ErrorKind::NotFound.into()),
			}
		}

		async fn read_dir(&self, _path: &Path) -> std::io::Result<pi_vfs::ReadDir> {
			Err(std::io::ErrorKind::NotFound.into())
		}
	}

	/// Failure mode: a `scheme://` path in the list is skipped as missing, a
	/// change to the file behind it goes unnoticed, or `/_` hands the utility
	/// a host path it did not list.
	#[tokio::test(flavor = "multi_thread")]
	async fn listed_urls_are_watched_at_the_files_behind_them() {
		let (_dir, root) = tree(&["a.txt", "notes.md"]);
		let filesystem = pi_vfs::Fs::new(std::sync::Arc::new(Local { root: root.clone() }));
		let watching =
			Watching::start_with(&root, &["-p", "echo", "saw", "/_"], "a.txt\nlocal://notes.md\n", &[], filesystem);
		let out = watching
			.nudge(|| append(&root.join("notes.md")), |out| out.ends_with('\n'))
			.await;
		assert!(out.starts_with("saw local://notes.md\n"), "{out:?}");
		assert_eq!(watching.stop().await.2, "");
	}

	/// Failure mode: an idle `entr` does not end when the shell cancels it
	/// (Ctrl-C, `timeout`, a stopped background job).
	#[tokio::test(flavor = "multi_thread")]
	async fn cancelling_ends_an_idle_watch() {
		let (_dir, root) = tree(&["a.txt"]);
		let watching = Watching::start(&root, &["-p", "echo", "ran"], "a.txt\n");
		tokio::time::sleep(Duration::from_millis(100)).await;
		assert!(!watching.running.is_finished());
		let (code, out, err) = watching.stop().await;
		assert_eq!((code, out.as_str(), err.as_str()), (130, "", ""));
	}

	/// Failure mode: with a terminal, a space does not run the utility or `q`
	/// does not end `entr` with status 0; the terminal is left without echo.
	#[tokio::test(flavor = "multi_thread")]
	async fn keys_run_the_utility_and_quit() {
		use nix::{
			fcntl::{FcntlArg, OFlag, fcntl},
			sys::termios::{LocalFlags, tcgetattr},
		};

		let (_dir, root) = tree(&["a.txt"]);
		let pty = nix::pty::openpty(None, None).expect("pty");
		fcntl(&pty.master, FcntlArg::F_SETFL(OFlag::O_NONBLOCK)).expect("non-blocking master");
		let mut master = fs::File::from(pty.master);
		let terminal = fs::File::from(pty.slave);
		let logs = tempfile::tempdir().expect("log directory");
		fs::write(logs.path().join("list"), "a.txt\n").expect("list");
		let stdin = fs::File::open(logs.path().join("list")).expect("list");
		let stdio = [stdin, terminal.try_clone().expect("stdout"), terminal.try_clone().expect("stderr")];
		let invocation =
			invocation(&root, &["echo", "ran"], &[], pi_vfs::Fs::native(), stdio, CancellationToken::new());
		let running = tokio::spawn(crate::extras::run(invocation));

		// Presses `key` until the terminal has shown `ran` `wanted` times, or
		// `entr` has exited when no count is wanted.
		let mut shown = Vec::new();
		let deadline = Instant::now() + PATIENCE;
		let mut press = async |key: Option<&[u8]>, wanted: Option<usize>| {
			let mut pressed: Option<Instant> = None;
			loop {
				let mut chunk = [0; 512];
				while let Ok(read @ 1..) = master.read(&mut chunk) {
					shown.extend_from_slice(&chunk[..read]);
				}
				let seen = String::from_utf8_lossy(&shown).matches("ran").count();
				match wanted {
					Some(wanted) if seen >= wanted => return,
					None if running.is_finished() => return,
					_ => {},
				}
				assert!(Instant::now() < deadline, "terminal showed {:?}", String::from_utf8_lossy(&shown));
				if let Some(key) = key
					&& pressed.is_none_or(|at| at.elapsed() >= Duration::from_millis(500))
				{
					master.write_all(key).expect("key");
					pressed = Some(Instant::now());
				}
				tokio::time::sleep(Duration::from_millis(10)).await;
			}
		};
		press(None, Some(1)).await;
		press(Some(b" "), Some(2)).await;
		press(Some(b"q"), None).await;
		assert_eq!(running.await.expect("entr task"), 0);
		let modes = tcgetattr(&terminal).expect("terminal modes");
		assert!(modes.local_flags.contains(LocalFlags::ICANON | LocalFlags::ECHO));
	}
}
