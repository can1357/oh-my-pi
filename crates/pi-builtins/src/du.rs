//! `du` builtin: estimate file space usage.
//!
//! Traversal: fts-order path spelling, hard-link and directory-cycle handling,
//! `--exclude` matched against every trailing part of a path, and `--time` styles.

use std::{
	collections::HashSet,
	ffi::{OsStr, OsString},
	io::{self, Read, Write},
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::PossibleValue};
use glob::Pattern;
use jiff::{
	Zoned,
	fmt::{
		StdIoWrite,
		strtime::{BrokenDownTime, Config as TimeFormatConfig},
	},
	tz::TimeZone,
};
use pi_vfs::{FileId, Metadata};
use uucore::{
	display::Quotable,
	i18n::UEncoding,
	parser::{
		parse_glob,
		parse_size::{ParseSizeError, Parser, allow_list_with_all_suffixes},
		shortcut_value_parser::ShortcutValueParser,
	},
	quoting_style::{QuotingStyle, escape_name},
};

use crate::{
	block_size::{BlockSize, Scale},
	host::{Host, StreamWriter, Utility, format_usage, matches_parser, os_bytes_lossy, strip_errno, util},
	locale::{NumericSymbols, ctype_is_utf8, numeric_symbols},
	quoting_style::quoting_style_by_name,
	time_zone::shell_time_zone,
};

/// Registration for the `du` builtin.
pub(crate) fn du_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Du, SE>()
}

mod options {
	pub const HELP: &str = "help";
	pub const NULL: &str = "0";
	pub const ALL: &str = "all";
	pub const APPARENT_SIZE: &str = "apparent-size";
	pub const BLOCK_SIZE: &str = "block-size";
	pub const BYTES: &str = "b";
	pub const TOTAL: &str = "c";
	pub const MAX_DEPTH: &str = "d";
	pub const HUMAN_READABLE: &str = "h";
	pub const BLOCK_SIZE_1K: &str = "k";
	pub const COUNT_LINKS: &str = "l";
	pub const BLOCK_SIZE_1M: &str = "m";
	pub const SEPARATE_DIRS: &str = "S";
	pub const SUMMARIZE: &str = "s";
	pub const THRESHOLD: &str = "threshold";
	pub const SI: &str = "si";
	pub const TIME: &str = "time";
	pub const TIME_STYLE: &str = "time-style";
	pub const ONE_FILE_SYSTEM: &str = "one-file-system";
	pub const DEREFERENCE: &str = "dereference";
	pub const DEREFERENCE_ARGS: &str = "dereference-args";
	pub const NO_DEREFERENCE: &str = "no-dereference";
	pub const INODES: &str = "inodes";
	pub const EXCLUDE: &str = "exclude";
	pub const EXCLUDE_FROM: &str = "exclude-from";
	pub const FILES0_FROM: &str = "files0-from";
	pub const FILE: &str = "FILE";
}

/// Parsed `du` invocation.
pub(crate) struct Du {
	matches: ArgMatches,
}

matches_parser!(Du, app);

impl Utility for Du {
	const NAME: &'static str = "du";

	fn run(self, host: &mut Host) -> i32 {
		run(host, &self.matches)
	}
}

/// The `du` argument model, as uutils' `uu_app` with GNU's option set.
fn app() -> Command {
	Command::new(Du::NAME)
		.version("9.8")
		.about("Summarize device usage of the set of FILEs, recursively for directories.")
		.override_usage(format_usage("du [OPTION]... [FILE]...\n  or:  du [OPTION]... --files0-from=F"))
		.after_help(
			"Display values are in units of the first available SIZE from --block-size,\nand the \
			 DU_BLOCK_SIZE, BLOCK_SIZE and BLOCKSIZE environment variables.\nOtherwise, units default to \
			 1024 bytes (or 512 if POSIXLY_CORRECT is set).\n\nThe SIZE argument is an integer and \
			 optional unit (example: 10K is 10*1024).\nUnits are K,M,G,T,P,E,Z,Y,R,Q (powers of 1024) or \
			 KB,MB,... (powers of 1000).\nBinary prefixes can be used, too: KiB=K, MiB=M, and so on.\n\nThe \
			 --time-style STYLE argument can be full-iso, long-iso, iso, or +FORMAT.\nFORMAT is \
			 interpreted like in date(1).\nAlso the TIME_STYLE environment variable sets the default style \
			 to use.",
		)
		.infer_long_args(true)
		.disable_help_flag(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("display this help and exit")
				.action(ArgAction::Help),
		)
		.arg(flag(options::NULL, Some('0'), Some("null"), "end each output line with NUL, not newline"))
		.arg(flag(options::ALL, Some('a'), Some(options::ALL), "write counts for all files, not just directories"))
		.arg(flag(
			options::APPARENT_SIZE,
			Some('A'),
			Some(options::APPARENT_SIZE),
			"print apparent sizes rather than device usage; although the apparent size is usually smaller, \
			 it may be larger due to holes in ('sparse') files, internal fragmentation, indirect blocks, etc.",
		))
		.arg(
			Arg::new(options::BLOCK_SIZE)
				.short('B')
				.long(options::BLOCK_SIZE)
				.value_name("SIZE")
				.help(
					"scale sizes by SIZE before printing them; See SIZE format below; E.g., '-BM' prints sizes \
					 in units of 1,048,576 bytes",
				),
		)
		.arg(flag(options::BYTES, Some('b'), Some("bytes"), "equivalent to '--apparent-size --block-size=1'"))
		.arg(flag(options::TOTAL, Some('c'), Some("total"), "produce a grand total"))
		.arg(
			Arg::new(options::DEREFERENCE_ARGS)
				.short('D')
				.visible_short_alias('H')
				.long(options::DEREFERENCE_ARGS)
				.help("dereference only symlinks that are listed on the command line")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MAX_DEPTH)
				.short('d')
				.long("max-depth")
				.value_name("N")
				.allow_hyphen_values(true)
				.help(
					"print the total for a directory (or file, with --all) only if it is N or fewer levels \
					 below the command line argument;  --max-depth=0 is the same as --summarize",
				),
		)
		.arg(
			Arg::new(options::FILES0_FROM)
				.long(options::FILES0_FROM)
				.value_name("F")
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString))
				.help(
					"summarize device usage of the NUL-terminated file names specified in file F;  if F is -, \
					 read names from standard input",
				),
		)
		.arg(flag(
			options::HUMAN_READABLE,
			Some('h'),
			Some("human-readable"),
			"print sizes in human readable format (e.g., 1K 234M 2G)",
		))
		.arg(flag(options::INODES, None, Some(options::INODES), "list inode usage information instead of block usage"))
		.arg(flag(options::BLOCK_SIZE_1K, Some('k'), None, "like --block-size=1K"))
		.arg(flag(options::DEREFERENCE, Some('L'), Some(options::DEREFERENCE), "dereference all symbolic links"))
		.arg(flag(options::COUNT_LINKS, Some('l'), Some("count-links"), "count sizes many times if hard linked"))
		.arg(flag(options::BLOCK_SIZE_1M, Some('m'), None, "like --block-size=1M"))
		.arg(flag(
			options::NO_DEREFERENCE,
			Some('P'),
			Some(options::NO_DEREFERENCE),
			"don't follow any symbolic links (this is the default)",
		))
		.arg(flag(
			options::SEPARATE_DIRS,
			Some('S'),
			Some("separate-dirs"),
			"for directories do not include size of subdirectories",
		))
		.arg(flag(options::SI, None, Some(options::SI), "like -h, but use powers of 1000 not 1024"))
		.arg(flag(options::SUMMARIZE, Some('s'), Some("summarize"), "display only a total for each argument"))
		.arg(
			Arg::new(options::THRESHOLD)
				.short('t')
				.long(options::THRESHOLD)
				.value_name("SIZE")
				.num_args(1)
				.allow_hyphen_values(true)
				.help("exclude entries smaller than SIZE if positive, or entries greater than SIZE if negative"),
		)
		.arg(
			Arg::new(options::TIME)
				.long(options::TIME)
				.value_name("WORD")
				.require_equals(true)
				.num_args(0..=1)
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("atime").alias("access").alias("use"),
					PossibleValue::new("ctime").alias("status"),
				]))
				.help(
					"show time of the last modification of any file in the directory, or any of its \
					 subdirectories; with WORD, show time as WORD instead of modification time: atime, \
					 access, use, ctime or status",
				),
		)
		.arg(
			Arg::new(options::TIME_STYLE)
				.long(options::TIME_STYLE)
				.value_name("STYLE")
				.help("time/date format with --time; see TIME_STYLE below"),
		)
		.arg(
			Arg::new(options::EXCLUDE_FROM)
				.short('X')
				.long(options::EXCLUDE_FROM)
				.value_name("FILE")
				.value_hint(clap::ValueHint::FilePath)
				.value_parser(clap::value_parser!(OsString))
				.help("exclude files that match any pattern in FILE")
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(options::EXCLUDE)
				.long(options::EXCLUDE)
				.value_name("PATTERN")
				.help("exclude files that match PATTERN")
				.action(ArgAction::Append),
		)
		.arg(flag(
			options::ONE_FILE_SYSTEM,
			Some('x'),
			Some(options::ONE_FILE_SYSTEM),
			"skip directories on different file systems",
		))
		.arg(
			Arg::new(options::FILE)
				.hide(true)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(clap::value_parser!(OsString))
				.action(ArgAction::Append),
		)
}

fn flag(id: &'static str, short: Option<char>, long: Option<&'static str>, help: &'static str) -> Arg {
	let mut arg = Arg::new(id).help(help).action(ArgAction::SetTrue);
	if let Some(short) = short {
		arg = arg.short(short);
	}
	if let Some(long) = long {
		arg = arg.long(long);
	}
	arg
}

/// The last of `ids` given on the command line.
fn last_given<'a>(matches: &ArgMatches, ids: &[&'a str]) -> Option<&'a str> {
	ids.iter()
		.filter(|id| matches.get_flag(id))
		.filter_map(|id| Some((matches.indices_of(id)?.next_back()?, *id)))
		.max_by_key(|(index, _)| *index)
		.map(|(_, id)| id)
}

fn bytes_to_os(bytes: &[u8]) -> OsString {
	match uucore::os_str_from_bytes(bytes) {
		Ok(value) => value.into_owned(),
		Err(_) => OsString::from(String::from_utf8_lossy(bytes).into_owned()),
	}
}

// ── Exclusion patterns ────────────────────────────────────────────────────────

/// `--exclude`/`-X` patterns. As in GNU, a pattern excludes a file when it
/// matches the whole path or any part of it after a `/`.
#[derive(Default)]
struct Exclude {
	patterns: Vec<Pattern>,
}

impl Exclude {
	/// Adds `pattern`; one that is not a valid glob (`[a`) matches literally,
	/// as `fnmatch` treats it.
	fn add(&mut self, pattern: &str) {
		let pattern = parse_glob::from_str(pattern)
			.unwrap_or_else(|_| Pattern::new(&Pattern::escape(pattern)).expect("escaped pattern is valid"));
		self.patterns.push(pattern);
	}

	fn matches(&self, name: &[u8]) -> bool {
		if self.patterns.is_empty() {
			return false;
		}
		let name = String::from_utf8_lossy(name);
		let suffixes = std::iter::once(name.as_ref()).chain(
			name.match_indices('/')
				.map(|(slash, _)| &name[slash + 1..])
				.filter(|rest| !rest.starts_with('/')),
		);
		let suffixes: Vec<&str> = suffixes.collect();
		self.patterns
			.iter()
			.any(|pattern| suffixes.iter().any(|suffix| pattern.matches(suffix)))
	}
}

// ── Traversal ─────────────────────────────────────────────────────────────────

/// fts symlink handling: `-P`, `-D`/`-H`, `-L`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Deref {
	Physical,
	CommandLine,
	Logical,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum TimeKind {
	Modification,
	Access,
	Change,
}

/// Output-side settings.
struct Config {
	all:           bool,
	apparent:      bool,
	count_all:     bool,
	hash_all:      bool,
	separate_dirs: bool,
	one_fs:        bool,
	deref:         Deref,
	max_depth:     u64,
	threshold:     Option<Threshold>,
	block_size:    BlockSize,
	symbols:       NumericSymbols,
	inodes:        bool,
	nul:           bool,
	time:          Option<(TimeKind, String, TimeZone)>,
	/// Quoting style for names when stdout is a terminal.
	quote_output:  Option<QuotingStyle>,
	/// Whether names are UTF-8 for output quoting.
	utf8:          bool,
	excludes:      Exclude,
}

/// `--threshold`: entries smaller than a positive size, or larger than a
/// negative one, are not printed.
#[derive(Clone, Copy)]
enum Threshold {
	Lower(u64),
	Upper(u64),
}

impl Threshold {
	fn parse(spec: &str) -> Result<Self, ParseSizeError> {
		let allow_list = allow_list_with_all_suffixes("kKmMGTPEZYRQ");
		let allow_list: Vec<&str> = allow_list.iter().map(String::as_str).collect();
		let digits = spec.strip_prefix(['-', '+']).unwrap_or(spec);
		let size = Parser::default().with_allow_list(&allow_list).parse_u64(digits)?;
		if spec.starts_with('-') {
			// `-0` would only show empty entries; GNU rejects it.
			if size == 0 {
				return Err(ParseSizeError::ParseFailure(spec.to_owned()));
			}
			Ok(Self::Upper(size))
		} else {
			Ok(Self::Lower(size))
		}
	}

	const fn excludes(self, size: u64) -> bool {
		match self {
			Self::Upper(threshold) => size > threshold,
			Self::Lower(threshold) => size < threshold,
		}
	}
}

/// GNU's `struct duinfo`.
#[derive(Clone, Copy, Default)]
struct DuInfo {
	size:   u64,
	inodes: u64,
	/// Latest `(seconds, nanoseconds)` seen; `None` before any.
	tmax:   Option<(i64, i64)>,
}

impl DuInfo {
	fn add(&mut self, other: &Self) {
		self.size = self.size.saturating_add(other.size);
		self.inodes = self.inodes.wrapping_add(other.inodes);
		if other.tmax > self.tmax {
			self.tmax = other.tmax;
		}
	}
}

/// What a visited entry contributes to its parent directory.
struct Counted {
	own:      DuInfo,
	dir_type: bool,
	/// For directories, everything below: entries plus subdirectory totals.
	inner:    DuInfo,
}

struct Walker<'h> {
	host:      &'h mut Host,
	out:       StreamWriter,
	cfg:       &'h Config,
	seen:      HashSet<FileId>,
	/// Identities of the directories on the current path.
	ancestors: Vec<Option<FileId>>,
	mounts:    Option<HashSet<FileId>>,
	total:     DuInfo,
	root_dev:  Option<u64>,
	ok:        bool,
	stopped:   bool,
	write_err: Option<io::Error>,
}

impl Walker<'_> {
	fn error(&mut self, message: impl std::fmt::Display) {
		let _ = writeln!(self.host.stderr, "du: {message}");
		self.ok = false;
	}

	fn check_stop(&mut self) -> bool {
		if !self.stopped && (self.host.is_cancelled() || self.host.sigpipe_hit()) {
			self.stopped = true;
		}
		self.stopped
	}

	/// One operand: GNU's `du_files` on a single root.
	fn root(&mut self, operand: &[u8]) {
		let mut len = operand.len();
		if len > 2 && operand[len - 1] == b'/' {
			while len > 1 && operand[len - 2] == b'/' {
				len -= 1;
			}
		}
		let display = &operand[..len];
		let path = self.host.resolve(bytes_to_os(display));
		self.root_dev = None;
		self.visit(display, &path, 0);
	}

	fn metadata(&self, path: &Path, follow: bool) -> io::Result<Metadata> {
		if follow { self.host.fs().metadata(path) } else { self.host.fs().symlink_metadata(path) }
	}

	/// GNU's `process_file` for one entry and, for a directory, its subtree.
	fn visit(&mut self, display: &[u8], path: &Path, level: usize) -> Option<Counted> {
		if self.check_stop() {
			return None;
		}
		let cfg = self.cfg;
		let follow = cfg.deref == Deref::Logical || (cfg.deref == Deref::CommandLine && level == 0);
		let excluded = cfg.excludes.matches(display);
		let meta = match self.metadata(path, follow) {
			Ok(meta) => meta,
			Err(error) => {
				let dangling = follow
					&& error.kind() == io::ErrorKind::NotFound
					&& self.host.fs().symlink_metadata(path).is_ok();
				// Entries that vanish mid-walk are not reported.
				if !dangling && level > 0 && error.kind() == io::ErrorKind::NotFound {
					return None;
				}
				if excluded {
					return None;
				}
				if dangling {
					self.error(format_args!("cannot access {}", bytes_to_os(display).quote()));
				} else {
					self.error(format_args!("cannot access {}: {}", bytes_to_os(display).quote(), strip_errno(&error)));
				}
				return None;
			},
		};
		if level == 0 {
			self.root_dev = meta.dev();
		}
		let is_dir = meta.is_dir();
		if excluded || (cfg.one_fs && level > 0 && meta.dev() != self.root_dev) {
			return None;
		}
		let id = meta.file_id();
		if !cfg.count_all
			&& (cfg.hash_all || (!is_dir && meta.nlink().unwrap_or(1) > 1))
			&& let Some(id) = id
			&& !self.seen.insert(id)
		{
			return None;
		}
		if is_dir
			&& let Some(id) = id
			&& let Some(cycle) = self.ancestors.iter().position(|ancestor| *ancestor == Some(id))
		{
			let warn = cfg.deref == Deref::Physical || (cfg.deref == Deref::CommandLine && level > 0);
			if warn && !self.mount_point_in_cycle(id, cycle) {
				self.error(format_args!(
					"WARNING: Circular directory structure.\nThis almost certainly means that you have a \
					 corrupted file system.\nNOTIFY YOUR SYSTEM MANAGER.\nThe following directory is part \
					 of the cycle:\n  {}\n",
					bytes_to_os(display).maybe_quote()
				));
			}
			return None;
		}

		let size = if cfg.apparent {
			if meta.is_file() || meta.is_symlink() { meta.len() } else { 0 }
		} else {
			meta.blocks()
				.map(|blocks| blocks.saturating_mul(512))
				.or_else(|| self.host.fs().allocated_size(path).ok())
				.unwrap_or_else(|| meta.len())
		};
		let own = DuInfo { size, inodes: 1, tmax: entry_time(&meta, cfg) };

		let mut ent = DuInfo::default();
		let mut subdir = DuInfo::default();
		if is_dir {
			match self.host.fs().read_dir(path) {
				Err(error) => {
					if level > 0 && error.kind() == io::ErrorKind::NotFound {
						return None;
					}
					self.error(format_args!(
						"cannot read directory {}: {}",
						bytes_to_os(display).quote(),
						strip_errno(&error)
					));
				},
				Ok(entries) => {
					let mut children = Vec::new();
					let mut read_error = None;
					for entry in entries {
						if self.check_stop() {
							return None;
						}
						match entry {
							Ok(entry) => children.push((entry.file_name(), entry.path())),
							Err(error) => {
								read_error = Some(error);
								break;
							},
						}
					}
					self.ancestors.push(id);
					let mut child_display = display.to_vec();
					if child_display.last() != Some(&b'/') {
						child_display.push(b'/');
					}
					let prefix = child_display.len();
					for (name, child_path) in children {
						child_display.truncate(prefix);
						child_display.extend_from_slice(&os_bytes_lossy(&name));
						let Some(child) = self.visit(&child_display, &child_path, level + 1) else {
							continue;
						};
						if !(cfg.separate_dirs && child.dir_type) {
							ent.add(&child.own);
						}
						if child.dir_type {
							subdir.add(&child.inner);
						}
					}
					self.ancestors.pop();
					if let Some(error) = read_error {
						self.error(format_args!("{}: {}", bytes_to_os(display).maybe_quote(), strip_errno(&error)));
					}
				},
			}
			if self.stopped {
				return None;
			}
		}

		let mut to_print = own;
		to_print.add(&ent);
		if !cfg.separate_dirs {
			to_print.add(&subdir);
		}
		self.total.add(&own);

		let depth = u64::try_from(level).unwrap_or(u64::MAX);
		if (is_dir && depth <= cfg.max_depth) || (cfg.all && depth <= cfg.max_depth) || level == 0 {
			let value = if cfg.inodes { to_print.inodes } else { to_print.size };
			if !cfg.threshold.is_some_and(|threshold| threshold.excludes(value)) {
				self.print(&to_print, display, true);
			}
		}

		let mut inner = ent;
		inner.add(&subdir);
		Some(Counted { own, dir_type: is_dir, inner })
	}

	/// Whether the cycle closing at `ancestors[cycle]` passes through a
	/// local mount point (a bind mount, which GNU does not warn about).
	fn mount_point_in_cycle(&mut self, id: FileId, cycle: usize) -> bool {
		if self.mounts.is_none() {
			#[cfg_attr(not(unix), allow(unused_mut))]
			let mut mounts = HashSet::new();
			#[cfg(unix)]
			if let Ok(list) = uucore::fsext::read_fs_list() {
				for mount in list.into_iter().filter(|mount| !mount.remote && !mount.dummy) {
					if let Ok(meta) = self.host.fs().metadata(&mount.mount_dir)
						&& let Some(mount_id) = meta.file_id()
					{
						mounts.insert(mount_id);
					}
				}
			}
			self.mounts = Some(mounts);
		}
		let mounts = self.mounts.as_ref().expect("mount table loaded above");
		mounts.contains(&id)
			|| self.ancestors[cycle + 1..]
				.iter()
				.flatten()
				.any(|ancestor| mounts.contains(ancestor))
	}

	/// GNU's `print_size`.
	fn print(&mut self, info: &DuInfo, name: &[u8], quote: bool) {
		if self.stopped {
			return;
		}
		let cfg = self.cfg;
		let value = if cfg.inodes { info.inodes } else { info.size };
		let mut line = if value == u64::MAX {
			b"Infinity".to_vec()
		} else {
			cfg.block_size.format(value, cfg.symbols).into_bytes()
		};
		if let Some((_, format, zone)) = &cfg.time {
			line.push(b'\t');
			show_date(&mut line, info.tmax, format, zone);
		}
		line.push(b'\t');
		match cfg.quote_output {
			Some(style) if quote => {
				let encoding = if cfg.utf8 { UEncoding::Utf8 } else { UEncoding::Ascii };
				line.extend_from_slice(&os_bytes_lossy(&escape_name(&bytes_to_os(name), style, encoding)));
			},
			_ => line.extend_from_slice(name),
		}
		line.push(if cfg.nul { b'\0' } else { b'\n' });
		if let Err(error) = self.out.write_all(&line).and_then(|()| self.out.flush()) {
			self.stopped = true;
			self.write_err = Some(error);
		}
	}
}

fn entry_time(meta: &Metadata, cfg: &Config) -> Option<(i64, i64)> {
	let (kind, ..) = cfg.time.as_ref()?;
	match kind {
		TimeKind::Modification => Some((meta.mtime()?, meta.mtime_nsec()?)),
		TimeKind::Access => Some((meta.atime()?, meta.atime_nsec()?)),
		TimeKind::Change => Some((meta.ctime()?, meta.ctime_nsec()?)),
	}
}

/// GNU `show_date`, falling back to the raw seconds when the time cannot be
/// broken down.
fn show_date(out: &mut Vec<u8>, time: Option<(i64, i64)>, format: &str, zone: &TimeZone) {
	let Some((seconds, nanos)) = time else {
		out.extend_from_slice(b"???");
		return;
	};
	let Ok(timestamp) = jiff::Timestamp::new(seconds, i32::try_from(nanos).unwrap_or(0)) else {
		out.extend_from_slice(seconds.to_string().as_bytes());
		return;
	};
	let zoned = Zoned::new(timestamp, zone.clone());
	let mut rendered = Vec::new();
	let formatted = BrokenDownTime::from(&zoned).format_with_config(
		&TimeFormatConfig::new().lenient(true),
		format,
		&mut StdIoWrite(&mut rendered),
	);
	if formatted.is_ok() {
		out.extend_from_slice(&rendered);
	} else {
		out.extend_from_slice(seconds.to_string().as_bytes());
	}
}

// ── Main ──────────────────────────────────────────────────────────────────────

/// Reads all of `name` (`-` is standard input) for `-X` and `--files0-from`.
fn read_input(host: &mut Host, name: &OsStr) -> io::Result<Vec<u8>> {
	let mut data = Vec::new();
	if name == "-" {
		host.stdin.read_to_end(&mut data)?;
	} else {
		host.fs().open(host.resolve(name))?.read_to_end(&mut data)?;
	}
	Ok(data)
}

/// `size_error`'s wording for a rejected `--block-size` or `--threshold`.
fn size_error(error: &ParseSizeError, option: &str, value: &str) -> String {
	let value = value.quote();
	match error {
		ParseSizeError::InvalidSuffix(_) => format!("invalid suffix in --{option} argument {value}"),
		ParseSizeError::SizeTooBig(_) => format!("--{option} argument {value} too large"),
		ParseSizeError::ParseFailure(_) | ParseSizeError::PhysicalMem(_) => {
			format!("invalid --{option} argument {value}")
		},
	}
}

/// The `strftime` format for `--time`: `--time-style`, else `TIME_STYLE`
/// (its `posix-` prefixes, `locale`, and lines after the first of a
/// `+FORMAT` ignored), else `long-iso`. Styles may be abbreviated.
fn time_format(host: &Host, style: Option<&str>) -> Result<String, String> {
	let style = match style {
		Some(style) => style.to_owned(),
		None => match host.var("TIME_STYLE") {
			None | Some("locale") => "long-iso".to_owned(),
			Some(style) if style.starts_with('+') => style.split('\n').next().unwrap_or_default().to_owned(),
			Some(mut style) => {
				while let Some(rest) = style.strip_prefix("posix-") {
					style = rest;
				}
				style.to_owned()
			},
		},
	};
	if let Some(format) = style.strip_prefix('+') {
		return Ok(format.to_owned());
	}
	const STYLES: [(&str, &str); 3] = [
		("full-iso", "%Y-%m-%d %H:%M:%S.%N %z"),
		("long-iso", "%Y-%m-%d %H:%M"),
		("iso", "%Y-%m-%d"),
	];
	let prefixed: Vec<&str> =
		STYLES.iter().filter(|(name, _)| name.starts_with(style.as_str())).map(|(_, format)| *format).collect();
	let exact = STYLES.iter().find(|(name, _)| *name == style).map(|(_, format)| *format);
	match (exact, prefixed.as_slice()) {
		(Some(format), _) | (None, &[format]) => Ok(format.to_owned()),
		(None, found) => Err(format!(
			"{} argument {} for 'time style'\nValid arguments are:\n  - full-iso\n  - long-iso\n  - iso\n  - \
			 +FORMAT (e.g., +%H:%M) for a 'date'-style format",
			if found.is_empty() { "invalid" } else { "ambiguous" },
			style.quote()
		)),
	}
}

/// The quoting style for names written to a terminal: `QUOTING_STYLE`, else
/// shell-escape; `None` for `literal`.
fn output_quoting(host: &mut Host) -> Option<QuotingStyle> {
	let style = match host.var("QUOTING_STYLE").map(str::to_owned) {
		None => QuotingStyle::SHELL_ESCAPE,
		Some(name) => match quoting_style_by_name(&name) {
			Some(QuotingStyle::Literal { .. }) => return None,
			Some(style) => style,
			None => {
				let _ = writeln!(
					host.stderr,
					"du: ignoring invalid value of environment variable QUOTING_STYLE: {}",
					name.quote()
				);
				QuotingStyle::SHELL_ESCAPE
			},
		},
	};
	Some(style)
}

#[allow(clippy::too_many_lines, reason = "mirrors GNU du's main()")]
fn run(host: &mut Host, matches: &ArgMatches) -> i32 {
	let summarize = matches.get_flag(options::SUMMARIZE);
	let all = matches.get_flag(options::ALL);
	let inodes = matches.get_flag(options::INODES);
	let apparent = matches.get_flag(options::APPARENT_SIZE) || matches.get_flag(options::BYTES);

	let max_depth = match matches.get_one::<String>(options::MAX_DEPTH) {
		None => None,
		// Like GNU's base-0 `xstrtoimax`: decimal, `0x` hex, or `0` octal.
		Some(depth) => match Parser::default().with_allow_list(&[]).parse_u64(depth.trim_start()) {
			Ok(depth) => Some(depth),
			Err(_) => return host.usage_error(format_args!("invalid maximum depth {}", depth.quote()), 1),
		},
	};

	let scales = [
		(options::BLOCK_SIZE, Scale::Spec),
		(options::BYTES, Scale::Bytes),
		(options::HUMAN_READABLE, Scale::Human),
		(options::SI, Scale::Si),
		(options::BLOCK_SIZE_1K, Scale::Kilo),
		(options::BLOCK_SIZE_1M, Scale::Mega),
	];
	let mut block_size = match BlockSize::from_matches(matches, &scales, host, "DU_BLOCK_SIZE") {
		Ok(block_size) => block_size,
		Err((error, spec)) => {
			host.error(error.message("--block-size", &spec), 1);
			return 1;
		},
	};

	let threshold = match matches.get_one::<String>(options::THRESHOLD) {
		None => None,
		Some(spec) => match Threshold::parse(spec) {
			Ok(threshold) => Some(threshold),
			Err(error) => {
				host.error(size_error(&error, options::THRESHOLD, spec), 1);
				return 1;
			},
		},
	};

	let mut excludes = Exclude::default();
	for pattern in matches.get_many::<String>(options::EXCLUDE).into_iter().flatten() {
		excludes.add(pattern);
	}
	let mut ok = true;
	for name in matches.get_many::<OsString>(options::EXCLUDE_FROM).into_iter().flatten() {
		match read_input(host, name) {
			Ok(data) => {
				for line in data.split(|&b| b == b'\n') {
					let end = line.iter().rposition(|b| !b.is_ascii_whitespace()).map_or(0, |last| last + 1);
					if end > 0 {
						excludes.add(&String::from_utf8_lossy(&line[..end]));
					}
				}
			},
			Err(error) => {
				let _ = writeln!(host.stderr, "du: {}: {}", name.maybe_quote(), strip_errno(&error));
				ok = false;
			},
		}
	}
	if !ok {
		return host.try_help(1);
	}

	let nul = matches.get_flag(options::NULL);
	let quote_output = if !nul && host.stdout.is_terminal() { output_quoting(host) } else { None };

	if all && summarize {
		return host.usage_error("cannot both summarize and show all entries", 1);
	}
	match max_depth {
		Some(0) if summarize => {
			let _ = writeln!(host.stderr, "du: warning: summarizing is the same as using --max-depth=0");
		},
		Some(depth) if summarize => {
			return host.usage_error(format_args!("warning: summarizing conflicts with --max-depth={depth}"), 1);
		},
		_ => {},
	}
	let max_depth = if summarize { 0 } else { max_depth.unwrap_or(u64::MAX) };
	if inodes {
		if apparent {
			let _ = writeln!(host.stderr, "du: warning: options --apparent-size and -b are ineffective with --inodes");
		}
		block_size = block_size.with_bytes(1);
	}

	let time = if matches.contains_id(options::TIME)
		&& matches.value_source(options::TIME) == Some(clap::parser::ValueSource::CommandLine)
	{
		let kind = match matches.get_one::<String>(options::TIME).map(String::as_str) {
			None => TimeKind::Modification,
			Some("atime") => TimeKind::Access,
			Some(_) => TimeKind::Change,
		};
		let style = matches.get_one::<String>(options::TIME_STYLE).map(String::as_str);
		match time_format(host, style) {
			Ok(format) => Some((kind, format, shell_time_zone(host))),
			Err(message) => return host.usage_error(message, 1),
		}
	} else {
		None
	};

	let deref = match last_given(matches, &[options::DEREFERENCE, options::DEREFERENCE_ARGS, options::NO_DEREFERENCE]) {
		Some(options::DEREFERENCE) => Deref::Logical,
		Some(options::DEREFERENCE_ARGS) => Deref::CommandLine,
		_ => Deref::Physical,
	};

	let operands: Vec<&OsString> = matches.get_many::<OsString>(options::FILE).into_iter().flatten().collect();
	let files_from = matches.get_one::<OsString>(options::FILES0_FROM);
	let (names, hash_all, from_stdin, read_error) = if let Some(files_from) = files_from {
		if let Some(extra) = operands.first() {
			return host.usage_error(
				format_args!("extra operand {}\nfile operands cannot be combined with --files0-from", extra.quote()),
				1,
			);
		}
		let from_stdin = files_from == "-";
		let mut data = Vec::new();
		let mut read_failure = None;
		if from_stdin {
			if let Err(error) = host.stdin.read_to_end(&mut data) {
				read_failure = Some(error);
			}
		} else {
			match host.fs().open(host.resolve(files_from)) {
				Ok(mut file) => {
					if let Err(error) = file.read_to_end(&mut data) {
						read_failure = Some(error);
					}
				},
				Err(error) if error.kind() == io::ErrorKind::IsADirectory => read_failure = Some(error),
				Err(error) => {
					host.error(
						format_args!("cannot open {} for reading: {}", files_from.quote(), strip_errno(&error)),
						1,
					);
					return 1;
				},
			}
		}
		let mut names: Vec<Vec<u8>> = data.split(|&b| b == 0).map(<[u8]>::to_vec).collect();
		// A final name needs no terminator, and a terminator needs no name after
		// it; a read error loses the name it interrupted.
		if read_failure.is_some() || names.last().is_some_and(Vec::is_empty) {
			names.pop();
		}
		// Reported once the names read before the failure are processed.
		let read_error = read_failure
			.map(|error| format!("{}: read error: {}", files_from.maybe_quote(), strip_errno(&error)));
		(names, true, from_stdin, read_error)
	} else {
		let hash_all = operands.len() > 1 || deref == Deref::Logical;
		let names = if operands.is_empty() {
			vec![b".".to_vec()]
		} else {
			operands.iter().map(|operand| os_bytes_lossy(operand).into_owned()).collect()
		};
		(names, hash_all, false, None)
	};

	let cfg = Config {
		all,
		apparent,
		count_all: matches.get_flag(options::COUNT_LINKS),
		hash_all,
		separate_dirs: matches.get_flag(options::SEPARATE_DIRS),
		one_fs: matches.get_flag(options::ONE_FILE_SYSTEM),
		deref,
		max_depth,
		threshold,
		block_size,
		symbols: numeric_symbols(host),
		inodes,
		nul,
		time,
		quote_output,
		utf8: ctype_is_utf8(host),
		excludes,
	};
	let out = host.stdout_writer();
	let mut walker = Walker {
		host,
		out,
		cfg: &cfg,
		seen: HashSet::new(),
		ancestors: Vec::new(),
		mounts: None,
		total: DuInfo::default(),
		root_dev: None,
		ok: true,
		stopped: false,
		write_err: None,
	};
	for (index, name) in names.iter().enumerate() {
		if walker.check_stop() {
			break;
		}
		if from_stdin && name.as_slice() == b"-" {
			walker.error("when reading file names from standard input, no file name of '-' allowed");
			continue;
		}
		if name.is_empty() {
			match files_from {
				None => walker.error("invalid zero-length file name"),
				Some(files_from) => {
					walker.error(format_args!("{}:{}: invalid zero-length file name", files_from.maybe_quote(), index + 1));
				},
			}
			continue;
		}
		walker.root(name);
	}
	if let Some(message) = read_error {
		walker.error(message);
	}
	if matches.get_flag(options::TOTAL) {
		let grand = walker.total;
		walker.print(&grand, b"total", false);
	}
	let _ = walker.out.flush();
	if let Some(error) = walker.write_err.take() {
		if walker.host.sigpipe_hit() {
			return 1;
		}
		walker.error(format_args!("write error: {}", strip_errno(&error)));
		return 1;
	}
	if walker.ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::*;
	use crate::host::run_caught;

	/// Runs `du` from `cwd` with exported `vars` and `stdin`, like the shell would.
	fn du_env(cwd: &Path, args: &[&str], vars: &[(&str, &str)], stdin: &str) -> (i32, Vec<u8>, String) {
		let (mut host, capture) = Host::for_test("du", stdin.as_bytes().to_vec(), cwd);
		for (key, value) in vars {
			host.set_test_var(key, value);
		}
		let argv: Vec<OsString> = std::iter::once("du").chain(args.iter().copied()).map(OsString::from).collect();
		let code = match <Du as clap::Parser>::try_parse_from(&argv) {
			Ok(parsed) => run_caught::<Du>(parsed, &mut host),
			Err(error) => {
				let _ = write!(host.stderr, "{error}");
				1
			},
		};
		(code, capture.stdout(), capture.err())
	}

	fn du(cwd: &Path, args: &[&str]) -> (i32, String, String) {
		let (code, out, err) = du_env(cwd, args, &[], "");
		(code, String::from_utf8_lossy(&out).into_owned(), err)
	}

	/// The fixture tree: nested dirs, a 300 KiB file, a 50 MiB sparse file,
	/// a hard link across directories, symlinks (to a dir, dangling, to a file).
	fn tree() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().expect("tempdir");
		let root = dir.path().canonicalize().expect("canonical");
		fs::create_dir_all(root.join("a/b/c")).unwrap();
		fs::create_dir_all(root.join("d")).unwrap();
		fs::create_dir_all(root.join("e")).unwrap();
		fs::write(root.join("a/f1.txt"), "hello").unwrap();
		fs::write(root.join("a/b/big"), vec![1_u8; 300 * 1024]).unwrap();
		fs::File::create(root.join("a/sparse")).unwrap().set_len(50 << 20).unwrap();
		fs::write(root.join("a/b/x.log"), "log\n").unwrap();
		fs::write(root.join("d/y.log"), "log2\n").unwrap();
		fs::hard_link(root.join("a/f1.txt"), root.join("d/hard")).unwrap();
		#[cfg(unix)]
		{
			std::os::unix::fs::symlink("../a", root.join("e/linkdir")).unwrap();
			std::os::unix::fs::symlink("nowhere", root.join("e/dangling")).unwrap();
			std::os::unix::fs::symlink("f1.txt", root.join("a/flink")).unwrap();
		}
		(dir, root)
	}

	/// Output lines as `(value, name)` pairs.
	fn rows(out: &str) -> Vec<(String, String)> {
		out.lines()
			.map(|line| {
				let (value, name) = line.split_once('\t').expect("tab-separated");
				(value.to_owned(), name.to_owned())
			})
			.collect()
	}

	fn value_of(out: &str, name: &str) -> String {
		rows(out)
			.into_iter()
			.find(|(_, row)| row == name)
			.unwrap_or_else(|| panic!("no row {name:?} in {out:?}"))
			.0
	}

	#[test]
	fn names_keep_the_operand_spelling_and_print_directories_after_their_contents() {
		let (_dir, root) = tree();
		let (code, out, err) = du(&root, &["--inodes"]);
		assert_eq!((code, err.as_str()), (0, ""));
		let names: Vec<String> = rows(&out).into_iter().map(|(_, name)| name).collect();
		for name in ["./a/b/c", "./a/b", "./a", "./d", "./e", "."] {
			assert!(names.contains(&name.to_owned()), "{name} missing from {names:?}");
		}
		let position = |name: &str| names.iter().position(|row| row == name).unwrap();
		assert!(position("./a/b/c") < position("./a/b") && position("./a/b") < position("./a"));
		assert_eq!(names.last().map(String::as_str), Some("."));

		// fts trims repeated trailing slashes to one and joins children after it.
		let (_, out, _) = du(&root, &["--inodes", "a//"]);
		let names: Vec<String> = rows(&out).into_iter().map(|(_, name)| name).collect();
		assert!(names.contains(&"a/b".to_owned()) && names.last().map(String::as_str) == Some("a/"), "{names:?}");
	}

	#[test]
	fn hard_links_count_once_unless_count_links() {
		let (_dir, root) = tree();
		// `d/hard` is a second link to `a/f1.txt`.
		let (_, out, _) = du(&root, &["--inodes", "-s", "d"]);
		assert_eq!(out, "3\td\n");
		let (_, out, _) = du(&root, &["--inodes", "-s", "a", "d"]);
		assert_eq!(out, "8\ta\n2\td\n");
		let (_, out, _) = du(&root, &["--inodes", "-s", "-l", "a", "d"]);
		assert_eq!(out, "8\ta\n3\td\n");
	}

	#[test]
	fn an_operand_already_counted_under_another_prints_nothing() {
		let (_dir, root) = tree();
		let (code, out, _) = du(&root, &["--inodes", "a", "a/b"]);
		assert_eq!(code, 0);
		assert!(rows(&out).iter().all(|(_, name)| name.starts_with("a/") || name == "a"));
		assert_eq!(rows(&out).iter().filter(|(_, name)| name == "a/b").count(), 1);
	}

	#[test]
	fn apparent_sizes_use_st_size_and_ignore_directories() {
		let (_dir, root) = tree();
		// 5 + 6 (symlink text) + 50 MiB sparse + 300 KiB + 4.
		let (_, out, _) = du(&root, &["-sb", "a"]);
		assert_eq!(out, "52736015\ta\n");
		let (_, out, _) = du(&root, &["-A", "-a", "-BK", "a/b"]);
		assert_eq!(value_of(&out, "a/b/big"), "300K");
		assert_eq!(value_of(&out, "a/b/x.log"), "1K");
		assert_eq!(value_of(&out, "a/b/c"), "0K");
	}

	#[test]
	fn block_size_comes_from_the_shell_environment() {
		let (_dir, root) = tree();
		let run = |vars: &[(&str, &str)]| {
			let (_, out, _) = du_env(&root, &["-s", "-A", "a"], vars, "");
			String::from_utf8(out).unwrap()
		};
		assert_eq!(run(&[("DU_BLOCK_SIZE", "1")]), "52736015\ta\n");
		// An invalid suffix keeps the number, as gnulib does.
		assert_eq!(run(&[("DU_BLOCK_SIZE", "5x")]), "10547203\ta\n");
		assert_eq!(run(&[("DU_BLOCK_SIZE", ""), ("BLOCK_SIZE", "1")]), "51501\ta\n");
		assert_eq!(run(&[("BLOCKSIZE", "1")]), "52736015\ta\n");
		assert_eq!(run(&[("POSIXLY_CORRECT", "")]), "103001\ta\n");
		assert_eq!(run(&[("BLOCK_SIZE", "human-readable")]), "51M\ta\n");
		let (_, out, _) = du_env(&root, &["-s", "-A", "-k", "a"], &[("DU_BLOCK_SIZE", "1")], "");
		assert_eq!(out, b"51501\ta\n");
	}

	#[test]
	fn depth_summary_threshold_and_separate_dirs_select_rows() {
		let (_dir, root) = tree();
		let (_, out, _) = du(&root, &["-b", "-d1", "a"]);
		let names: Vec<String> = rows(&out).into_iter().map(|(_, name)| name).collect();
		assert_eq!(names, ["a/b", "a"]);
		let (_, out, _) = du(&root, &["-b", "-a", "-t", "1K", "a"]);
		let names: Vec<String> = rows(&out).into_iter().map(|(_, name)| name).collect();
		assert!(names.contains(&"a/sparse".to_owned()) && !names.contains(&"a/f1.txt".to_owned()), "{names:?}");
		let (_, out, _) = du(&root, &["-b", "-a", "-t", "-5", "a"]);
		assert!(rows(&out).iter().all(|(value, _)| value.parse::<u64>().unwrap() <= 5), "{out}");
		// -S leaves a/b's 307204 bytes out of a.
		let (_, out, _) = du(&root, &["-b", "-S", "a"]);
		assert_eq!(value_of(&out, "a"), "52428811");
		let (_, out, _) = du(&root, &["-b", "-S", "-c", "a"]);
		assert_eq!(value_of(&out, "total"), "52736015");
	}

	#[test]
	fn null_terminates_every_line_including_the_total() {
		let (_dir, root) = tree();
		let (_, out, _) = du_env(&root, &["-0", "-c", "--inodes", "-s", "d"], &[], "");
		assert_eq!(out, b"3\td\x003\ttotal\x00");
	}

	#[test]
	fn exclusions_match_any_trailing_part_of_the_path() {
		let (_dir, root) = tree();
		let names = |args: &[&str]| -> Vec<String> {
			let (_, out, _) = du(&root, args);
			rows(&out).into_iter().map(|(_, name)| name).collect()
		};
		let all = names(&["-a", "--exclude=*.log", "a"]);
		assert!(!all.iter().any(|name| name.ends_with(".log")) && all.contains(&"a/b/big".to_owned()));
		assert_eq!(names(&["--exclude=b", "a"]), ["a"]);
		assert_eq!(names(&["--exclude=a/b", "a"]), ["a"]);
		assert!(names(&["--exclude=a"]).iter().all(|name| !name.starts_with("./a")));
		assert!(names(&["--exclude=a", "a"]).is_empty());

		let excludes = |pattern: &str, name: &str| {
			let mut exclude = Exclude::default();
			exclude.add(pattern);
			exclude.matches(name.as_bytes())
		};
		assert!(excludes("*.log", "./a/b/x.log"));
		assert!(excludes("a?b", "x/a/b") && excludes("b", "./a/b") && !excludes("b", "./a/bc"));
		assert!(excludes("[^a]x", "bx") && !excludes("[!a]x", "ax"));
		// An unterminated bracket is literal, as for fnmatch.
		assert!(excludes("[a", "d/[a"));
	}

	#[test]
	fn exclude_from_trims_lines_and_reads_stdin() {
		let (_dir, root) = tree();
		let (code, out, err) = du_env(&root, &["-a", "-X", "-", "a"], &[], "b \n\n*.txt\n");
		let names: Vec<String> = rows(&String::from_utf8(out).unwrap()).into_iter().map(|(_, name)| name).collect();
		assert_eq!((code, err.as_str()), (0, ""));
		assert!(!names.iter().any(|name| name.starts_with("a/b") || name.ends_with(".txt")), "{names:?}");
		let (code, out, err) = du(&root, &["-X", "missing", "a"]);
		assert_eq!((code, out.as_str()), (1, ""));
		assert_eq!(err, "du: missing: No such file or directory\nTry 'du --help' for more information.\n");
	}

	#[test]
	fn files0_from_reports_bad_names_by_record() {
		let (_dir, root) = tree();
		let (code, out, err) = du_env(&root, &["--inodes", "-s", "--files0-from=-"], &[], "d\0-\0\0d");
		assert_eq!(code, 1);
		assert_eq!(out, b"3\td\n");
		assert_eq!(
			err,
			"du: when reading file names from standard input, no file name of '-' allowed\ndu: -:3: invalid \
			 zero-length file name\n"
		);
		fs::write(root.join("list"), "d\0").unwrap();
		let (code, out, _) = du(&root, &["--inodes", "--files0-from=list"]);
		assert_eq!((code, out.as_str()), (0, "3\td\n"));
		let (code, _, err) = du(&root, &["--files0-from=list", "a"]);
		assert_eq!(code, 1);
		assert_eq!(
			err,
			"du: extra operand 'a'\nfile operands cannot be combined with --files0-from\nTry 'du --help' for more \
			 information.\n"
		);
		let (code, _, err) = du(&root, &["--files0-from=nope"]);
		assert_eq!((code, err.as_str()), (1, "du: cannot open 'nope' for reading: No such file or directory\n"));
	}

	#[test]
	fn invalid_option_values_are_rejected() {
		let (_dir, root) = tree();
		let cases: &[(&[&str], &str)] = &[
			(&["-d", "x"], "du: invalid maximum depth 'x'\nTry 'du --help' for more information.\n"),
			(&["-d", "-1"], "du: invalid maximum depth '-1'\nTry 'du --help' for more information.\n"),
			(&["-as"], "du: cannot both summarize and show all entries\nTry 'du --help' for more information.\n"),
			(&["-s", "-d1"], "du: warning: summarizing conflicts with --max-depth=1\nTry 'du --help' for more information.\n"),
			(&["-t", "-0"], "du: invalid --threshold argument '-0'\n"),
			(&["-t", "x"], "du: invalid --threshold argument 'x'\n"),
			(&["-B", "5x"], "du: invalid suffix in --block-size argument '5x'\n"),
			(&["--block-size=0"], "du: invalid --block-size argument '0'\n"),
			(&["--threshold=5Q"], "du: --threshold argument '5Q' too large\n"),
			(
				&["--time", "--time-style=bogus"],
				"du: invalid argument 'bogus' for 'time style'\nValid arguments are:\n  - full-iso\n  - long-iso\n  - \
				 iso\n  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\nTry 'du --help' for more information.\n",
			),
		];
		for (args, expected) in cases {
			let (code, out, err) = du(&root, args);
			assert_eq!((code, out.as_str(), err.as_str()), (1, "", *expected), "du {args:?}");
		}
		// Usage errors from the argument model exit 1 too.
		for args in [&["--time=bogus"][..], &["-z"], &["-B"], &["--all=3"]] {
			let (code, out, err) = du(&root, args);
			assert_eq!((code, out.as_str()), (1, ""), "du {args:?}");
			assert!(err.starts_with("error: "), "du {args:?}: {err}");
		}
	}

	#[test]
	fn option_values_accept_gnu_spellings() {
		let (_dir, root) = tree();
		// --max-depth is base 0; --time words and styles may be abbreviated.
		let (_, out, _) = du(&root, &["--inodes", "-d", "0x0", "a"]);
		assert_eq!(out, "8\ta\n");
		let (code, out, _) = du_env(&root, &["--inodes", "--time=s", "--time-style=f", "-s", "d"], &[("TZ", "UTC")], "");
		assert_eq!(code, 0);
		assert!(String::from_utf8(out).unwrap().ends_with(" +0000\td\n"));
		// The last of -k/-m/-b/-h/--si/-B wins.
		let (_, out, _) = du(&root, &["-h", "-k", "-A", "-s", "a"]);
		assert_eq!(out, "51501\ta\n");
		let (_, out, _) = du(&root, &["-k", "-h", "-A", "-s", "a"]);
		assert_eq!(out, "51M\ta\n");
		let (_, out, _) = du(&root, &["-BK", "-A", "-s", "a"]);
		assert_eq!(out, "51501K\ta\n");
	}

	#[test]
	fn help_and_end_of_options() {
		let (_dir, root) = tree();
		let help = <Du as clap::Parser>::try_parse_from(["du", "-s", "--he"]).err().expect("help is reported");
		assert_eq!(help.kind(), clap::error::ErrorKind::DisplayHelp);
		assert!(help.to_string().contains("Usage: du [OPTION]... [FILE]..."));
		let (code, out, err) = du(&root, &["--", "-a"]);
		assert_eq!((code, out.as_str()), (1, ""));
		assert_eq!(err, "du: cannot access '-a': No such file or directory\n");
	}

	#[test]
	fn missing_operands_fail_but_the_rest_are_reported() {
		let (_dir, root) = tree();
		let (code, out, err) = du(&root, &["--inodes", "missing", "d", ""]);
		assert_eq!(code, 1);
		assert_eq!(out, "3\td\n");
		assert_eq!(
			err,
			"du: cannot access 'missing': No such file or directory\ndu: invalid zero-length file name\n"
		);
	}

	#[cfg(unix)]
	#[test]
	fn symlinks_are_followed_only_as_asked() {
		let (_dir, root) = tree();
		let (_, out, _) = du(&root, &["--inodes", "-s", "e/linkdir"]);
		assert_eq!(out, "1\te/linkdir\n");
		let (_, out, _) = du(&root, &["--inodes", "-s", "-D", "e/linkdir"]);
		assert_eq!(out, "8\te/linkdir\n");
		let (_, out, _) = du(&root, &["--inodes", "-s", "e/linkdir/"]);
		assert_eq!(out, "8\te/linkdir/\n");
		let (code, out, err) = du(&root, &["--inodes", "-L", "e"]);
		assert_eq!(code, 1);
		assert_eq!(err, "du: cannot access 'e/dangling'\n");
		// Under -L, a/flink is a second sighting of a/f1.txt.
		assert_eq!(value_of(&out, "e/linkdir"), "7");
		assert_eq!(value_of(&out, "e"), "8");
		// -P after -L restores the default.
		let (_, out, _) = du(&root, &["--inodes", "-s", "-LP", "e"]);
		assert_eq!(out, "3\te\n");
	}

	#[cfg(unix)]
	#[test]
	fn unreadable_directories_are_reported_and_still_counted() {
		use std::os::unix::fs::PermissionsExt;
		if nix::unistd::geteuid().is_root() {
			return;
		}
		let (_dir, root) = tree();
		fs::create_dir(root.join("locked")).unwrap();
		fs::write(root.join("locked/secret"), "s").unwrap();
		fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0)).unwrap();
		let (code, out, err) = du(&root, &["--inodes", "locked"]);
		fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
		assert_eq!(code, 1);
		assert_eq!(out, "1\tlocked\n");
		assert_eq!(err, "du: cannot read directory 'locked': Permission denied\n");
	}

	#[test]
	fn time_shows_the_newest_timestamp_below_each_directory() {
		let (_dir, root) = tree();
		let at = |secs: u64| std::time::UNIX_EPOCH + std::time::Duration::from_secs(secs);
		let set = |path: &str, secs: u64| {
			fs::File::options()
				.write(true)
				.open(root.join(path))
				.or_else(|_| fs::File::open(root.join(path)))
				.unwrap()
				.set_modified(at(secs))
				.unwrap();
		};
		set("d/y.log", 1_000_000_000);
		set("a/f1.txt", 1_500_000_000);
		set("d", 900_000_000);
		let (_, out, _) = du_env(&root, &["--time", "--inodes", "-s", "d"], &[("TZ", "UTC")], "");
		assert_eq!(out, b"3\t2017-07-14 02:40\td\n");
		let (_, out, _) = du_env(
			&root,
			&["--time", "--time-style=full-iso", "--inodes", "-s", "d"],
			&[("TZ", "UTC")],
			"",
		);
		assert_eq!(out, b"3\t2017-07-14 02:40:00.000000000 +0000\td\n");
		let (_, out, _) = du_env(&root, &["--time", "--inodes", "-s", "d"], &[("TZ", "UTC"), ("TIME_STYLE", "+%s")], "");
		assert_eq!(out, b"3\t1500000000\td\n");
	}

	#[test]
	fn cancellation_stops_the_walk() {
		let (_dir, root) = tree();
		let (mut host, capture) = Host::for_test("du", Vec::new(), &root);
		host.cancel_for_test();
		let parsed = <Du as clap::Parser>::try_parse_from(["du"]).unwrap();
		run_caught::<Du>(parsed, &mut host);
		assert!(capture.stdout().is_empty());
	}
}
