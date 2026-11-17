//! `tar` builtin: create, list, and extract tape archives.
//!
//! Follows GNU tar 1.35's command line, diagnostics, exit statuses (0 success,
//! 2 errors), and listing format. Headers are encoded and decoded with the
//! `tar` crate (alexcrichton/tar-rs, MIT OR Apache-2.0); gzip, bzip2, xz, and
//! zstd go through `flate2`, `bzip2`, `lzma-rust2`, and `zstd`. Every path is
//! resolved and opened through the shell's [`Host`] filesystem view, so the
//! shell's working directory and `scheme://` paths work, and archives stream
//! through without being buffered whole.
//!
//! Supported:
//! - modes `-c`/`--create`, `-x`/`--extract`/`--get`, `-t`/`--list`, clustered
//!   (`-xzf a.tgz`), long, and old-style bundled (`tar czf - dir`);
//! - `-f`/`--file ARCHIVE` (`-`, also the default, is stdin/stdout);
//!   `-C`/`--directory DIR` (applies to the operands after it when creating,
//!   relative to the previous `-C`; the target directory when extracting);
//!   `-T`/`--files-from FILE` with `--null`; repeatable `--exclude PATTERN`
//!   (GNU wildcards, `*` matching `/`, unanchored, a matching directory
//!   excluding its contents); member operands selecting exact names and the
//!   contents of directories on list and extract;
//! - `-v`/`--verbose` (`-tv` and `-vv` print GNU's long listing; the names go
//!   to stderr when the archive or `-O` output is stdout), `-O`/`--to-stdout`,
//!   `--strip-components N`, `-k`/`--keep-old-files`, `--overwrite`,
//!   `-p`/`--preserve-permissions`/`--same-permissions`, `-m`/`--touch`,
//!   `--no-same-owner` (the default; ownership is never restored),
//!   `-h`/`--dereference`;
//! - `-z`/`--gzip`, `-j`/`--bzip2`, `-J`/`--xz`, `--zstd`, `-a`/`--auto-compress`
//!   (by archive suffix when creating), and compression detected by magic bytes
//!   when reading without a compression option.
//!
//! Creating stores regular files, directories, symlinks (followed with `-h`),
//! hard links between archived files, FIFOs, and device nodes, with mode,
//! owner names, and mtime in GNU format (`././@LongLink` for long names), padded
//! to GNU's 10240-byte records. Extracting strips leading `/`, refuses members
//! with `..` components, never writes through a symlink (an existing one in the
//! member's place is replaced), refuses parents reached through a symlink
//! leading outside the target directory, creates missing parents, and applies
//! modes (masked by the umask unless `-p`) and mtimes, directories last.
//!
//! Deviations from GNU tar: directories are archived in byte-sorted rather than
//! readdir order; `-T` lists are taken verbatim (no `-C` lines); `--overwrite`
//! replaces existing files like the default instead of rewriting them in
//! place; members whose names contain `..` are refused instead of having the
//! prefix stripped; device nodes are not extracted; a damaged header ends the
//! read instead of being skipped; decompression errors carry the decoder's
//! message.

use std::{
	borrow::Cow,
	collections::{HashMap, HashSet},
	ffi::{OsStr, OsString},
	fmt::Display,
	io::{self, BufReader, BufWriter, ErrorKind, Read, Write},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use ::tar::{Archive, Builder, EntryType, Header};
use clap::{Arg, ArgAction, ArgMatches, Command};
use jiff::tz::TimeZone;
use pi_vfs::{BlockingFs, FileId, FileTime, Metadata, OpenOptions, Permissions};

use crate::{
	host::{
		Host, INTERRUPTED_EXIT_CODE, StreamWriter, Utility, format_usage, matches_parser,
		os_bytes_lossy, strip_errno,
	},
	time_zone::shell_time_zone,
};

/// GNU's default record: 20 blocks of 512 bytes.
const RECORD_SIZE: u64 = 10240;
/// Width of the name and link name fields of a header.
const NAME_FIELD: usize = 100;
/// Buffer size for streaming member data and archive files.
const COPY_BUFFER: usize = 64 * 1024;
/// GNU's `-tv` user/group/size column, widened as wider rows appear.
const UGS_WIDTH: usize = 19;
/// GNU's `-tv` date column (`YYYY-MM-DD HH:MM`).
const DATE_WIDTH: usize = 16;

const TRY_HELP: &str = "Try 'tar --help' or 'tar --usage' for more information.";
const NOT_RECOVERABLE: &str = "tar: Error is not recoverable: exiting now";
const FAILURE_TRAILER: &str = "tar: Exiting with failure status due to previous errors";

mod opt {
	pub const HELP: &str = "help";
	pub const CREATE: &str = "create";
	pub const EXTRACT: &str = "extract";
	pub const LIST: &str = "list";
	pub const FILE: &str = "file";
	pub const DIRECTORY: &str = "directory";
	pub const VERBOSE: &str = "verbose";
	pub const FILES_FROM: &str = "files-from";
	pub const NULL: &str = "null";
	pub const EXCLUDE: &str = "exclude";
	pub const STRIP_COMPONENTS: &str = "strip-components";
	pub const TO_STDOUT: &str = "to-stdout";
	pub const KEEP_OLD_FILES: &str = "keep-old-files";
	pub const OVERWRITE: &str = "overwrite";
	pub const PRESERVE_PERMISSIONS: &str = "preserve-permissions";
	pub const TOUCH: &str = "touch";
	pub const NO_SAME_OWNER: &str = "no-same-owner";
	pub const DEREFERENCE: &str = "dereference";
	pub const GZIP: &str = "gzip";
	pub const BZIP2: &str = "bzip2";
	pub const XZ: &str = "xz";
	pub const ZSTD: &str = "zstd";
	pub const AUTO_COMPRESS: &str = "auto-compress";
	pub const OPERANDS: &str = "operands";
}

pub(crate) struct Tar {
	matches: ArgMatches,
}

matches_parser!(Tar, app);

impl Utility for Tar {
	const NAME: &'static str = "tar";
	const USAGE_ERROR: u8 = 2;

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		expand_old_options(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let config = match Config::from_matches(&self.matches, host) {
			Ok(config) => config,
			Err(code) => return code,
		};
		match config.mode {
			Mode::Create => create(host, &config),
			Mode::Extract | Mode::List => read_archive(host, &config),
		}
	}
}

fn flag(id: &'static str, short: Option<char>, help: &'static str) -> Arg {
	let arg = Arg::new(id).long(id).help(help).action(ArgAction::SetTrue);
	match short {
		Some(short) => arg.short(short),
		None => arg,
	}
}

fn app() -> Command {
	Command::new(Tar::NAME)
		.version("1.35")
		.override_usage(format_usage("tar [OPTION...] [FILE]..."))
		.about(
			"GNU 'tar' saves many files together into a single tape or disk archive, and can \
			 restore individual files from the archive.\n\nExamples:\n  tar -cf archive.tar foo \
			 bar  # Create archive.tar from files foo and bar.\n  tar -tvf archive.tar         # \
			 List all files in archive.tar verbosely.\n  tar -xf archive.tar          # Extract \
			 all files from archive.tar.",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.disable_help_flag(true)
		.arg(Arg::new(opt::HELP).long(opt::HELP).help("give this help list").action(ArgAction::Help))
		.arg(flag(opt::CREATE, Some('c'), "create a new archive"))
		.arg(flag(opt::EXTRACT, Some('x'), "extract files from an archive").visible_alias("get"))
		.arg(flag(opt::LIST, Some('t'), "list the contents of an archive"))
		.arg(
			Arg::new(opt::FILE)
				.short('f')
				.long(opt::FILE)
				.value_name("ARCHIVE")
				.help("use archive file or device ARCHIVE")
				.value_parser(clap::value_parser!(OsString))
				.action(ArgAction::Set),
		)
		.arg(
			Arg::new(opt::DIRECTORY)
				.short('C')
				.long(opt::DIRECTORY)
				.value_name("DIR")
				.help("change to directory DIR")
				.value_parser(clap::value_parser!(OsString))
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(opt::VERBOSE)
				.short('v')
				.long(opt::VERBOSE)
				.help("verbosely list files processed")
				.action(ArgAction::Count),
		)
		.arg(
			Arg::new(opt::FILES_FROM)
				.short('T')
				.long(opt::FILES_FROM)
				.value_name("FILE")
				.help("get names to extract or create from FILE")
				.value_parser(clap::value_parser!(OsString))
				.action(ArgAction::Append),
		)
		.arg(flag(opt::NULL, None, "-T reads null-terminated names"))
		.arg(
			Arg::new(opt::EXCLUDE)
				.long(opt::EXCLUDE)
				.value_name("PATTERN")
				.help("exclude files, given as a PATTERN")
				.value_parser(clap::value_parser!(OsString))
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(opt::STRIP_COMPONENTS)
				.long(opt::STRIP_COMPONENTS)
				.value_name("NUMBER")
				.help("strip NUMBER leading components from file names on extraction")
				.value_parser(clap::value_parser!(usize))
				.action(ArgAction::Set),
		)
		.arg(flag(opt::TO_STDOUT, Some('O'), "extract files to standard output"))
		.arg(flag(
			opt::KEEP_OLD_FILES,
			Some('k'),
			"don't replace existing files when extracting, treat them as errors",
		))
		.arg(flag(opt::OVERWRITE, None, "overwrite existing files when extracting"))
		.arg(
			flag(
				opt::PRESERVE_PERMISSIONS,
				Some('p'),
				"extract information about file permissions",
			)
			.visible_alias("same-permissions"),
		)
		.arg(flag(opt::TOUCH, Some('m'), "don't extract file modified time"))
		.arg(flag(
			opt::NO_SAME_OWNER,
			None,
			"extract files as yourself (default for ordinary users)",
		))
		.arg(flag(opt::DEREFERENCE, Some('h'), "follow symlinks; archive the files they point to"))
		.arg(
			flag(opt::GZIP, Some('z'), "filter the archive through gzip")
				.visible_aliases(["gunzip", "ungzip"]),
		)
		.arg(flag(opt::BZIP2, Some('j'), "filter the archive through bzip2"))
		.arg(flag(opt::XZ, Some('J'), "filter the archive through xz"))
		.arg(flag(opt::ZSTD, None, "filter the archive through zstd"))
		.arg(flag(
			opt::AUTO_COMPRESS,
			Some('a'),
			"use archive suffix to determine the compression program",
		))
		.arg(
			Arg::new(opt::OPERANDS)
				.value_name("FILE")
				.value_parser(clap::value_parser!(OsString))
				.action(ArgAction::Append),
		)
}

/// Expands GNU's old-style first argument (`tar czf - dir`): when it does
/// not start with `-`, each letter is an option and the letters taking an
/// argument consume the following words in order.
fn expand_old_options(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
	let Some(letters) = argv.get(1).and_then(|first| first.to_str()) else {
		return Ok(argv);
	};
	if letters.is_empty() || letters.starts_with('-') {
		return Ok(argv);
	}
	let letters = letters.to_owned();
	let mut words = argv.into_iter();
	let mut expanded: Vec<OsString> = words.next().into_iter().collect();
	words.next();
	for letter in letters.chars() {
		expanded.push(format!("-{letter}").into());
		if matches!(letter, 'f' | 'C' | 'T') {
			let Some(value) = words.next() else {
				return Err(format!("option requires an argument -- '{letter}'\n{TRY_HELP}"));
			};
			expanded.push(value);
		}
	}
	expanded.extend(words);
	Ok(expanded)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	Create,
	Extract,
	List,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Compression {
	Gzip,
	Bzip2,
	Xz,
	Zstd,
}

impl Compression {
	/// The compression `-a` picks for an archive name, by GNU's suffix table.
	fn from_suffix(name: &OsStr) -> Option<Self> {
		const SUFFIXES: [(&[u8], Compression); 11] = [
			(b".gz", Compression::Gzip),
			(b".tgz", Compression::Gzip),
			(b".taz", Compression::Gzip),
			(b".bz2", Compression::Bzip2),
			(b".tz2", Compression::Bzip2),
			(b".tbz2", Compression::Bzip2),
			(b".tbz", Compression::Bzip2),
			(b".xz", Compression::Xz),
			(b".txz", Compression::Xz),
			(b".zst", Compression::Zstd),
			(b".tzst", Compression::Zstd),
		];
		let name = os_bytes_lossy(name);
		SUFFIXES
			.iter()
			.find(|(suffix, _)| name.ends_with(suffix))
			.map(|&(_, compression)| compression)
	}

	/// The compression a stream starting with `prefix` uses.
	fn from_magic(prefix: &[u8]) -> Option<Self> {
		if prefix.starts_with(&[0x1f, 0x8b]) {
			Some(Self::Gzip)
		} else if prefix.starts_with(b"BZh") {
			Some(Self::Bzip2)
		} else if prefix.starts_with(&[0xfd, b'7', b'z', b'X', b'Z', 0]) {
			Some(Self::Xz)
		} else if prefix.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
			Some(Self::Zstd)
		} else {
			None
		}
	}
}

/// A name-list item, in command-line order.
enum Operand {
	Chdir(OsString),
	Name(OsString),
	FilesFrom(OsString),
}

struct Config {
	mode:          Mode,
	archive:       OsString,
	compression:   Option<Compression>,
	auto_compress: bool,
	verbose:       u8,
	null:          bool,
	excludes:      Vec<Vec<u8>>,
	strip:         usize,
	to_stdout:     bool,
	keep_old:      bool,
	preserve:      bool,
	touch:         bool,
	dereference:   bool,
	operands:      Vec<Operand>,
}

impl Config {
	fn from_matches(matches: &ArgMatches, host: &mut Host) -> Result<Self, i32> {
		let modes: Vec<Mode> = [
			(opt::CREATE, Mode::Create),
			(opt::EXTRACT, Mode::Extract),
			(opt::LIST, Mode::List),
		]
		.into_iter()
		.filter(|(id, _)| matches.get_flag(id))
		.map(|(_, mode)| mode)
		.collect();
		let mode = match modes.as_slice() {
			[] => {
				return Err(usage(
					host,
					"You must specify one of the '-Acdtrux', '--delete' or '--test-label' options",
				));
			},
			[mode] => *mode,
			_ => {
				return Err(usage(
					host,
					"You may not specify more than one '-Acdtrux', '--delete' or  '--test-label' \
					 option",
				));
			},
		};

		let compressions: Vec<Compression> = [
			(opt::GZIP, Compression::Gzip),
			(opt::BZIP2, Compression::Bzip2),
			(opt::XZ, Compression::Xz),
			(opt::ZSTD, Compression::Zstd),
		]
		.into_iter()
		.filter(|(id, _)| matches.get_flag(id))
		.map(|(_, compression)| compression)
		.collect();
		if compressions.len() > 1 {
			return Err(usage(host, "Conflicting compression options"));
		}

		let mut ordered: Vec<(usize, Operand)> = Vec::new();
		let kinds: [(&str, fn(OsString) -> Operand); 3] = [
			(opt::DIRECTORY, Operand::Chdir),
			(opt::OPERANDS, Operand::Name),
			(opt::FILES_FROM, Operand::FilesFrom),
		];
		for (id, make) in kinds {
			if let (Some(values), Some(indices)) =
				(matches.get_many::<OsString>(id), matches.indices_of(id))
			{
				ordered.extend(indices.zip(values).map(|(index, value)| (index, make(value.clone()))));
			}
		}
		ordered.sort_by_key(|&(index, _)| index);

		Ok(Self {
			mode,
			archive: matches
				.get_one::<OsString>(opt::FILE)
				.cloned()
				.unwrap_or_else(|| OsString::from("-")),
			compression: compressions.first().copied(),
			auto_compress: matches.get_flag(opt::AUTO_COMPRESS),
			verbose: matches.get_count(opt::VERBOSE),
			null: matches.get_flag(opt::NULL),
			excludes: matches
				.get_many::<OsString>(opt::EXCLUDE)
				.into_iter()
				.flatten()
				.map(|pattern| os_bytes_lossy(pattern).into_owned())
				.collect(),
			strip: matches.get_one::<usize>(opt::STRIP_COMPONENTS).copied().unwrap_or(0),
			to_stdout: matches.get_flag(opt::TO_STDOUT),
			keep_old: matches.get_flag(opt::KEEP_OLD_FILES) && !matches.get_flag(opt::OVERWRITE),
			preserve: matches.get_flag(opt::PRESERVE_PERMISSIONS),
			touch: matches.get_flag(opt::TOUCH),
			dereference: matches.get_flag(opt::DEREFERENCE),
			operands: ordered.into_iter().map(|(_, operand)| operand).collect(),
		})
	}

	fn archive_is_stdio(&self) -> bool {
		self.archive == "-"
	}

	/// Whether `--exclude` drops `name` (no trailing slash).
	fn excluded(&self, name: &[u8]) -> bool {
		self.excludes.iter().any(|pattern| exclude_matches(pattern, name))
	}
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

/// Reports a usage error the way GNU tar does and returns status 2.
fn usage(host: &mut Host, message: impl Display) -> i32 {
	host.error(message, 2);
	let _ = writeln!(host.stderr, "{TRY_HELP}");
	2
}

/// Reports an error tar cannot continue after and returns status 2.
fn fatal(host: &mut Host, message: impl Display) -> i32 {
	host.error(message, 2);
	let _ = writeln!(host.stderr, "{NOT_RECOVERABLE}");
	2
}

/// `NAME: WHAT: ERRNO`, recorded as status 2.
fn report(host: &mut Host, name: &[u8], what: &str, err: &io::Error) {
	host.error(format_args!("{}: {what}: {}", quote(name), strip_errno(err)), 2);
}

/// A warning that leaves the exit status alone.
fn warn(host: &mut Host, message: impl Display) {
	let _ = writeln!(host.stderr, "tar: {message}");
}

/// The status of a run that got to the end, with GNU's trailer after errors.
fn finish(host: &mut Host) -> i32 {
	let code = host.exit_code();
	if code == 2 {
		let _ = writeln!(host.stderr, "{FAILURE_TRAILER}");
	}
	code
}

/// The status for an I/O failure on the archive or stdout: cancellation and
/// a departed reader end quietly, anything else is fatal.
fn stream_failure(host: &mut Host, archive: &OsStr, what: &str, err: &io::Error) -> i32 {
	if host.sigpipe_hit() {
		return 2;
	}
	if pi_vfs::is_cancelled(err) || host.is_cancelled() {
		return INTERRUPTED_EXIT_CODE;
	}
	if err.kind() == ErrorKind::UnexpectedEof || err.to_string().contains("entire block") {
		return fatal(host, "Unexpected EOF in archive");
	}
	if archive == "-" || what.is_empty() {
		return fatal(host, strip_errno(err));
	}
	fatal(host, format_args!("{}: {what}: {}", quote_os(archive), strip_errno(err)))
}

/// GNU's default `escape` quoting of a file name: backslash escapes for
/// backslash and control characters, octal for bytes that are not text.
fn quote_into(out: &mut Vec<u8>, name: &[u8]) {
	for chunk in name.utf8_chunks() {
		for c in chunk.valid().chars() {
			let escape: &[u8] = match c {
				'\\' => b"\\\\",
				'\x07' => b"\\a",
				'\x08' => b"\\b",
				'\x0c' => b"\\f",
				'\n' => b"\\n",
				'\r' => b"\\r",
				'\t' => b"\\t",
				'\x0b' => b"\\v",
				c if c.is_control() => {
					let mut utf8 = [0; 4];
					for byte in c.encode_utf8(&mut utf8).bytes() {
						let _ = write!(out, "\\{byte:03o}");
					}
					continue;
				},
				c => {
					let mut utf8 = [0; 4];
					out.extend_from_slice(c.encode_utf8(&mut utf8).as_bytes());
					continue;
				},
			};
			out.extend_from_slice(escape);
		}
		for byte in chunk.invalid() {
			let _ = write!(out, "\\{byte:03o}");
		}
	}
}

fn quote(name: &[u8]) -> String {
	let mut out = Vec::with_capacity(name.len());
	quote_into(&mut out, name);
	String::from_utf8_lossy_owned(out)
}

fn quote_os(name: &OsStr) -> String {
	quote(&os_bytes_lossy(name))
}

/// Leading member-name prefixes already reported as removed.
#[derive(Default)]
struct Warnings {
	removed: HashSet<Vec<u8>>,
}

impl Warnings {
	fn removed(&mut self, host: &mut Host, prefix: &[u8]) {
		if !self.removed.contains(prefix) {
			self.removed.insert(prefix.to_vec());
			warn(host, format_args!("Removing leading '{}' from member names", quote(prefix)));
		}
	}
}

// ── Names and patterns ────────────────────────────────────────────────────────

#[cfg(unix)]
fn bytes_to_os(bytes: &[u8]) -> OsString {
	use std::os::unix::ffi::OsStrExt as _;
	OsStr::from_bytes(bytes).to_os_string()
}

#[cfg(not(unix))]
fn bytes_to_os(bytes: &[u8]) -> OsString {
	OsString::from(String::from_utf8_lossy(bytes).into_owned())
}

fn bytes_to_path(bytes: &[u8]) -> PathBuf {
	PathBuf::from(bytes_to_os(bytes))
}

/// A host path as member-name bytes, with `/` separators.
fn path_bytes(path: &OsStr) -> Vec<u8> {
	let bytes = os_bytes_lossy(path).into_owned();
	#[cfg(windows)]
	let bytes = bytes.into_iter().map(|b| if b == b'\\' { b'/' } else { b }).collect();
	bytes
}

fn trim_trailing_slashes(name: &[u8]) -> &[u8] {
	let end = name.iter().rposition(|&b| b != b'/').map_or(0, |last| last + 1);
	&name[..end]
}

/// `parent/child`, without doubling a separator `parent` already ends with.
fn join_member(parent: &[u8], child: &[u8]) -> Vec<u8> {
	let mut joined = Vec::with_capacity(parent.len() + 1 + child.len());
	joined.extend_from_slice(parent);
	if !parent.ends_with(b"/") {
		joined.push(b'/');
	}
	joined.extend_from_slice(child);
	joined
}

/// GNU `safer_name_suffix`: the length of the prefix dropped from a name
/// being archived — a drive, every leading component up to the last `..`,
/// and the slashes after them.
fn safer_prefix_len(name: &[u8]) -> usize {
	let mut prefix = drive_prefix_len(name);
	let mut p = prefix;
	while p < name.len() {
		if name[p..].starts_with(b"..") && (p + 2 == name.len() || name[p + 2] == b'/') {
			prefix = p + 2;
		}
		while p < name.len() {
			p += 1;
			if name[p - 1] == b'/' {
				break;
			}
		}
	}
	while prefix < name.len() && name[prefix] == b'/' {
		prefix += 1;
	}
	prefix
}

/// The length of a Windows drive prefix (`C:`); none elsewhere.
fn drive_prefix_len(name: &[u8]) -> usize {
	if cfg!(windows) && name.len() >= 2 && name[1] == b':' && name[0].is_ascii_alphabetic() {
		2
	} else {
		0
	}
}

fn has_dot_dot(name: &[u8]) -> bool {
	name.split(|&b| b == b'/').any(|part| part == b"..")
}

/// The components of `name` left after `--strip-components`, `None` when
/// nothing is left.
fn strip_components(name: &[u8], strip: usize) -> Option<Vec<&[u8]>> {
	let parts: Vec<&[u8]> = name.split(|&b| b == b'/').filter(|part| !part.is_empty()).collect();
	if strip > 0 && parts.len() <= strip {
		return None;
	}
	Some(parts[strip.min(parts.len())..].to_vec())
}

/// GNU `fnmatch` without `FNM_PATHNAME`/`FNM_PERIOD`: `*` and `?` match `/`,
/// `[...]` classes (with `!`/`^` negation, ranges, and `[:class:]`), and
/// backslash escapes.
fn fnmatch(pattern: &[u8], name: &[u8]) -> bool {
	let (mut p, mut n) = (0, 0);
	let mut backtrack: Option<(usize, usize)> = None;
	while n < name.len() {
		let c = name[n];
		let next = match pattern.get(p) {
			Some(b'*') => {
				backtrack = Some((p, n));
				p += 1;
				continue;
			},
			Some(b'?') => Some(p + 1),
			Some(b'[') => match bracket(pattern, p + 1, c) {
				Some((true, end)) => Some(end),
				Some((false, _)) => None,
				None => (c == b'[').then_some(p + 1),
			},
			Some(b'\\') if p + 1 < pattern.len() => (pattern[p + 1] == c).then_some(p + 2),
			Some(&literal) => (literal == c).then_some(p + 1),
			None => None,
		};
		match (next, backtrack) {
			(Some(next), _) => {
				p = next;
				n += 1;
			},
			(None, Some((star, start))) => {
				p = star + 1;
				n = start + 1;
				backtrack = Some((star, start + 1));
			},
			(None, None) => return false,
		}
	}
	pattern[p.min(pattern.len())..].iter().all(|&b| b == b'*')
}

/// Matches `c` against the bracket expression starting after `[` at
/// `start`: `Some((matched, index after ']'))`, or `None` when unterminated.
fn bracket(pattern: &[u8], start: usize, c: u8) -> Option<(bool, usize)> {
	let mut i = start;
	let negate = matches!(pattern.get(i), Some(b'!' | b'^'));
	if negate {
		i += 1;
	}
	let mut matched = false;
	let mut first = true;
	loop {
		let &b = pattern.get(i)?;
		if b == b']' && !first {
			return Some((matched != negate, i + 1));
		}
		first = false;
		if b == b'[' && pattern.get(i + 1) == Some(&b':') {
			let close = pattern[i + 2..].windows(2).position(|w| w == b":]")?;
			let class = &pattern[i + 2..i + 2 + close];
			matched |= match class {
				b"alpha" => c.is_ascii_alphabetic(),
				b"digit" => c.is_ascii_digit(),
				b"alnum" => c.is_ascii_alphanumeric(),
				b"upper" => c.is_ascii_uppercase(),
				b"lower" => c.is_ascii_lowercase(),
				b"space" => c.is_ascii_whitespace() || c == 0x0b,
				b"blank" => c == b' ' || c == b'\t',
				b"punct" => c.is_ascii_punctuation(),
				b"xdigit" => c.is_ascii_hexdigit(),
				b"cntrl" => c.is_ascii_control(),
				b"print" => c.is_ascii_graphic() || c == b' ',
				b"graph" => c.is_ascii_graphic(),
				_ => false,
			};
			i += close + 4;
			continue;
		}
		let (low, after) = if b == b'\\' {
			(*pattern.get(i + 1)?, i + 2)
		} else {
			(b, i + 1)
		};
		if pattern.get(after) == Some(&b'-') && pattern.get(after + 1).is_some_and(|&b| b != b']') {
			let (high, end) = if pattern[after + 1] == b'\\' {
				(*pattern.get(after + 2)?, after + 3)
			} else {
				(pattern[after + 1], after + 2)
			};
			matched |= (low..=high).contains(&c);
			i = end;
		} else {
			matched |= low == c;
			i = after;
		}
	}
}

/// GNU's `--exclude` matching: unanchored (the pattern may match any trailing
/// run of components) with `FNM_LEADING_DIR` (a match on leading components
/// excludes what lies below).
fn exclude_matches(pattern: &[u8], name: &[u8]) -> bool {
	let starts = std::iter::once(0)
		.chain(name.iter().enumerate().filter(|&(_, &b)| b == b'/').map(|(i, _)| i + 1));
	starts.into_iter().any(|start| {
		let tail = &name[start..];
		fnmatch(pattern, tail)
			|| tail
				.iter()
				.enumerate()
				.any(|(i, &b)| b == b'/' && fnmatch(pattern, &tail[..i]))
	})
}

// ── Paths through the host ────────────────────────────────────────────────────

/// Where a name operand lives: under the current `-C` directory unless it is
/// absolute.
fn operand_path(host: &Host, base: Option<&Path>, name: &OsStr) -> PathBuf {
	let path = Path::new(name);
	match base {
		Some(base)
			if !path.is_absolute()
				&& !os_bytes_lossy(name).starts_with(b"/")
				&& !pi_vfs::is_virtual_path(path) =>
		{
			base.join(path)
		},
		_ => host.resolve(path),
	}
}

/// Applies `-C DIR`, which must name a directory.
fn change_dir(host: &mut Host, base: Option<&Path>, dir: &OsStr) -> Result<PathBuf, i32> {
	let path = operand_path(host, base, dir);
	match host.fs().metadata(&path) {
		Ok(metadata) if metadata.is_dir() => Ok(path),
		Ok(_) => Err(fatal(host, format_args!("{}: Cannot open: Not a directory", quote_os(dir)))),
		Err(err) => Err(fatal(host, format_args!("{}: Cannot open: {}", quote_os(dir), strip_errno(&err)))),
	}
}

/// The names a `-T` list holds: lines, or NUL-terminated with `--null`.
fn read_name_list(host: &mut Host, list: &OsStr, null: bool) -> Result<Vec<OsString>, i32> {
	let data = if list == "-" {
		let mut data = Vec::new();
		host.stdin.read_to_end(&mut data).map(|_| data)
	} else {
		host.fs().read(host.resolve(list))
	};
	match data {
		Ok(data) => {
			let separator = if null { 0 } else { b'\n' };
			Ok(data
				.split(|&b| b == separator)
				.filter(|name| !name.is_empty())
				.map(bytes_to_os)
				.collect())
		},
		Err(err) => Err(fatal(host, format_args!("{}: Cannot open: {}", quote_os(list), strip_errno(&err)))),
	}
}

// ── Listing ───────────────────────────────────────────────────────────────────

/// GNU's ten-character mode column for a member.
fn mode_string(type_char: u8, mode: u32) -> [u8; 10] {
	let mut out = *b"----------";
	out[0] = type_char;
	let bits = [(0o400, b'r'), (0o200, b'w'), (0o100, b'x'), (0o040, b'r'), (0o020, b'w'), (0o010, b'x'), (0o004, b'r'), (0o002, b'w'), (0o001, b'x')];
	for (i, (bit, letter)) in bits.into_iter().enumerate() {
		if mode & bit != 0 {
			out[i + 1] = letter;
		}
	}
	for (special, index, set, unset) in [(0o4000, 3, b's', b'S'), (0o2000, 6, b's', b'S'), (0o1000, 9, b't', b'T')] {
		if mode & special != 0 {
			out[index] = if out[index] == b'x' { set } else { unset };
		}
	}
	out
}

fn type_char(kind: u8, name: &[u8]) -> u8 {
	match kind {
		b'0' | b'\0' | b'S' if name.ends_with(b"/") => b'd',
		b'0' | b'\0' | b'S' => b'-',
		b'1' => b'h',
		b'2' => b'l',
		b'3' => b'c',
		b'4' => b'b',
		b'5' | b'D' => b'd',
		b'6' => b'p',
		b'7' => b'C',
		b'L' | b'K' => b'L',
		b'V' => b'V',
		b'M' => b'M',
		_ => b'?',
	}
}

/// `YYYY-MM-DD HH:MM` in the shell's time zone.
fn format_time(seconds: u64, zone: &TimeZone) -> String {
	i64::try_from(seconds)
		.ok()
		.and_then(|seconds| jiff::Timestamp::from_second(seconds).ok())
		.map_or_else(
			|| seconds.to_string(),
			|time| time.to_zoned(zone.clone()).strftime("%Y-%m-%d %H:%M").to_string(),
		)
}

/// Prints the members processed: names, or GNU's long listing.
struct Lister {
	/// Standard output; `None` lists on stderr (archive or `-O` data on stdout).
	out:        Option<StreamWriter>,
	enabled:    bool,
	long:       bool,
	ugs_width:  usize,
	date_width: usize,
	zone:       Option<TimeZone>,
	line:       Vec<u8>,
}

impl Lister {
	fn new(host: &Host, config: &Config, to_stderr: bool) -> Self {
		let list = config.mode == Mode::List;
		let long = (list && config.verbose > 0) || config.verbose > 1;
		Self {
			out: (!to_stderr).then(|| host.stdout_writer()),
			enabled: list || config.verbose > 0,
			long,
			ugs_width: UGS_WIDTH,
			date_width: DATE_WIDTH,
			zone: long.then(|| shell_time_zone(host)),
			line: Vec::new(),
		}
	}

	fn entry(
		&mut self,
		host: &mut Host,
		header: &Header,
		name: &[u8],
		link: Option<&[u8]>,
		size: u64,
	) -> io::Result<()> {
		if !self.enabled {
			return Ok(());
		}
		let mut line = std::mem::take(&mut self.line);
		line.clear();
		let kind = header.entry_type().as_byte();
		if self.long {
			self.long_prefix(&mut line, header, kind, name, size);
		}
		quote_into(&mut line, name);
		if self.long {
			match (kind, link) {
				(b'2', Some(link)) => {
					line.extend_from_slice(b" -> ");
					quote_into(&mut line, link);
				},
				(b'1', Some(link)) => {
					line.extend_from_slice(b" link to ");
					quote_into(&mut line, link);
				},
				_ => {},
			}
		}
		line.push(b'\n');
		let result = match &mut self.out {
			Some(out) => out.write_all(&line),
			None => host.stderr.write_all(&line),
		};
		self.line = line;
		result
	}

	/// GNU `simple_print_header` up to the name: mode, owner, size, date.
	fn long_prefix(&mut self, line: &mut Vec<u8>, header: &Header, kind: u8, name: &[u8], size: u64) {
		let mode = header.mode().unwrap_or(0);
		let owner = |stored: Option<&[u8]>, id: io::Result<u64>| match stored {
			Some(stored) if !stored.is_empty() => String::from_utf8_lossy(stored).into_owned(),
			_ => id.unwrap_or(0).to_string(),
		};
		let user = owner(header.username_bytes(), header.uid());
		let group = owner(header.groupname_bytes(), header.gid());
		let size = match kind {
			b'3' | b'4' => format!(
				"{},{}",
				header.device_major().ok().flatten().unwrap_or(0),
				header.device_minor().ok().flatten().unwrap_or(0)
			),
			_ => size.to_string(),
		};
		let date = match &self.zone {
			Some(zone) => format_time(header.mtime().unwrap_or(0), zone),
			None => String::new(),
		};
		let pad = user.len() + 1 + group.len() + 1 + size.len();
		self.ugs_width = self.ugs_width.max(pad);
		self.date_width = self.date_width.max(date.len());
		line.extend_from_slice(&mode_string(type_char(kind, name), mode));
		let _ = write!(
			line,
			" {user}/{group} {size:>size_width$} {date:<date_width$} ",
			size_width = self.ugs_width - pad + size.len(),
			date_width = self.date_width,
		);
	}

	fn flush(&mut self, host: &mut Host) -> io::Result<()> {
		match &mut self.out {
			Some(out) => out.flush(),
			None => host.stderr.flush(),
		}
	}
}

// ── Create ────────────────────────────────────────────────────────────────────

/// Where the archive bytes go.
enum Sink {
	Stdout(StreamWriter),
	File(BufWriter<pi_vfs::File>),
}

impl Write for Sink {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::Stdout(out) => out.write(buf),
			Self::File(file) => file.write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Stdout(out) => out.flush(),
			Self::File(file) => file.flush(),
		}
	}
}

impl Sink {
	fn finish(self) -> io::Result<()> {
		match self {
			Self::Stdout(mut out) => out.flush(),
			Self::File(file) => file.into_inner().map_err(io::IntoInnerError::into_error)?.close(),
		}
	}
}

/// The compressor between the tar stream and the [`Sink`].
enum Encoder {
	Plain(Sink),
	Gzip(flate2::write::GzEncoder<Sink>),
	Bzip2(bzip2::write::BzEncoder<Sink>),
	Xz(lzma_rust2::XzWriter<Sink>),
	Zstd(zstd::stream::write::Encoder<'static, Sink>),
}

impl Encoder {
	fn new(sink: Sink, compression: Option<Compression>) -> io::Result<Self> {
		Ok(match compression {
			None => Self::Plain(sink),
			Some(Compression::Gzip) => {
				Self::Gzip(flate2::write::GzEncoder::new(sink, flate2::Compression::default()))
			},
			Some(Compression::Bzip2) => {
				Self::Bzip2(bzip2::write::BzEncoder::new(sink, bzip2::Compression::default()))
			},
			Some(Compression::Xz) => {
				Self::Xz(lzma_rust2::XzWriter::new(sink, lzma_rust2::XzOptions::with_preset(6))?)
			},
			Some(Compression::Zstd) => Self::Zstd(zstd::stream::write::Encoder::new(sink, 0)?),
		})
	}

	fn finish(self) -> io::Result<Sink> {
		match self {
			Self::Plain(sink) => Ok(sink),
			Self::Gzip(encoder) => encoder.finish(),
			Self::Bzip2(encoder) => encoder.finish(),
			Self::Xz(encoder) => encoder.finish(),
			Self::Zstd(encoder) => encoder.finish(),
		}
	}
}

impl Write for Encoder {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match self {
			Self::Plain(sink) => sink.write(buf),
			Self::Gzip(encoder) => encoder.write(buf),
			Self::Bzip2(encoder) => encoder.write(buf),
			Self::Xz(encoder) => encoder.write(buf),
			Self::Zstd(encoder) => encoder.write(buf),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match self {
			Self::Plain(sink) => sink.flush(),
			Self::Gzip(encoder) => encoder.flush(),
			Self::Bzip2(encoder) => encoder.flush(),
			Self::Xz(encoder) => encoder.flush(),
			Self::Zstd(encoder) => encoder.flush(),
		}
	}
}

/// Counts the tar stream so it can be padded to whole records, as GNU does.
struct Records<W> {
	inner:   W,
	written: u64,
}

impl<W: Write> Write for Records<W> {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		let written = self.inner.write(buf)?;
		self.written += written as u64;
		Ok(written)
	}

	fn flush(&mut self) -> io::Result<()> {
		self.inner.flush()
	}
}

impl<W: Write> Records<W> {
	fn finish(mut self) -> io::Result<W> {
		let pad = (RECORD_SIZE - self.written % RECORD_SIZE) % RECORD_SIZE;
		io::copy(&mut io::repeat(0).take(pad), &mut self.inner)?;
		Ok(self.inner)
	}
}

fn fill_field(field: &mut [u8], value: &[u8]) {
	let len = value.len().min(field.len());
	field[..len].copy_from_slice(&value[..len]);
	field[len..].fill(0);
}

/// Writes a GNU `././@LongLink` record carrying a name too long for its field.
fn append_long<W: Write>(builder: &mut Builder<W>, kind: EntryType, value: &[u8]) -> io::Result<()> {
	let mut header = Header::new_gnu();
	fill_field(&mut header.as_old_mut().name, b"././@LongLink");
	header.set_mode(0o644);
	header.set_uid(0);
	header.set_gid(0);
	header.set_mtime(0);
	header.set_size(value.len() as u64 + 1);
	header.set_entry_type(kind);
	let _ = header.set_username("root");
	let _ = header.set_groupname("root");
	header.set_cksum();
	builder.append(&header, value.chain(&[0u8][..]))
}

/// Appends a member under the exact `name` (and link target) bytes.
fn append_named<W: Write>(
	builder: &mut Builder<W>,
	header: &mut Header,
	name: &[u8],
	link: Option<&[u8]>,
	data: impl Read,
) -> io::Result<()> {
	if name.len() > NAME_FIELD {
		append_long(builder, EntryType::GNULongName, name)?;
	}
	fill_field(&mut header.as_old_mut().name, name);
	if let Some(link) = link {
		if link.len() > NAME_FIELD {
			append_long(builder, EntryType::GNULongLink, link)?;
		}
		fill_field(&mut header.as_old_mut().linkname, link);
	}
	header.set_cksum();
	builder.append(header, data)
}

/// A file's data as the archive records it: exactly `remaining` bytes, zero
/// padded when the file shrinks or fails to read.
struct FileData {
	file:      pi_vfs::File,
	remaining: u64,
	missing:   u64,
	error:     Option<io::Error>,
	cancel:    Arc<AtomicBool>,
}

impl Read for FileData {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if self.remaining == 0 {
			return Ok(0);
		}
		if self.cancel.load(Ordering::Relaxed) {
			return Err(pi_vfs::cancelled());
		}
		let want = buf.len().min(usize::try_from(self.remaining).unwrap_or(usize::MAX));
		let buf = &mut buf[..want];
		let read = if self.error.is_some() || self.missing > 0 {
			0
		} else {
			loop {
				match self.file.read(buf) {
					Ok(read) => break read,
					Err(err) if err.kind() == ErrorKind::Interrupted => {},
					Err(err) => {
						self.error = Some(err);
						break 0;
					},
				}
			}
		};
		let read = if read == 0 {
			buf.fill(0);
			if self.error.is_none() {
				self.missing += want as u64;
			}
			want
		} else {
			read
		};
		self.remaining -= read as u64;
		Ok(read)
	}
}

/// User and group names for headers, looked up once per id.
#[derive(Default)]
struct Owners {
	users:  HashMap<u32, Option<String>>,
	groups: HashMap<u32, Option<String>>,
}

impl Owners {
	fn user(&mut self, uid: u32) -> Option<&str> {
		self.users.entry(uid).or_insert_with(|| lookup_user(uid)).as_deref()
	}

	fn group(&mut self, gid: u32) -> Option<&str> {
		self.groups.entry(gid).or_insert_with(|| lookup_group(gid)).as_deref()
	}
}

#[cfg(unix)]
fn lookup_user(uid: u32) -> Option<String> {
	uucore::entries::uid2usr(uid).ok()
}

#[cfg(unix)]
fn lookup_group(gid: u32) -> Option<String> {
	uucore::entries::gid2grp(gid).ok()
}

#[cfg(not(unix))]
fn lookup_user(_: u32) -> Option<String> {
	None
}

#[cfg(not(unix))]
fn lookup_group(_: u32) -> Option<String> {
	None
}

fn mtime_seconds(metadata: &Metadata) -> u64 {
	metadata
		.mtime()
		.or_else(|| {
			metadata
				.modified()
				.ok()
				.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
				.and_then(|age| i64::try_from(age.as_secs()).ok())
		})
		.and_then(|seconds| u64::try_from(seconds).ok())
		.unwrap_or(0)
}

#[cfg(unix)]
fn device_numbers(metadata: &Metadata) -> (u32, u32) {
	let rdev = metadata.rdev().unwrap_or(0) as rustix::fs::Dev;
	(rustix::fs::major(rdev), rustix::fs::minor(rdev))
}

#[cfg(not(unix))]
fn device_numbers(_: &Metadata) -> (u32, u32) {
	(0, 0)
}

struct Creator<'c> {
	config:     &'c Config,
	fs:         BlockingFs,
	builder:    Builder<Records<Encoder>>,
	lister:     Lister,
	warnings:   Warnings,
	owners:     Owners,
	/// The archive file itself, never archived into itself.
	archive_id: Option<FileId>,
	/// First member name of each multiply-linked file archived so far.
	hard_links: HashMap<FileId, Vec<u8>>,
	cancel:     Arc<AtomicBool>,
}

fn create(host: &mut Host, config: &Config) -> i32 {
	if config.operands.iter().all(|operand| matches!(operand, Operand::Chdir(_))) {
		return usage(host, "Cowardly refusing to create an empty archive");
	}
	let compression = config.compression.or_else(|| {
		config
			.auto_compress
			.then(|| Compression::from_suffix(&config.archive))
			.flatten()
	});
	let to_stdout = config.archive_is_stdio();
	let (sink, archive_id) = if to_stdout {
		if host.stdout.is_terminal() {
			return fatal(host, "Refusing to write archive contents to terminal (missing -f option?)");
		}
		(Sink::Stdout(StreamWriter::block(host.stdout_clone())), None)
	} else {
		match host.fs().create(host.resolve(&config.archive)) {
			Ok(file) => {
				let id = file.file_id().ok();
				(Sink::File(BufWriter::with_capacity(COPY_BUFFER, file)), id)
			},
			Err(err) => {
				return fatal(
					host,
					format_args!("{}: Cannot open: {}", quote_os(&config.archive), strip_errno(&err)),
				);
			},
		}
	};
	let encoder = match Encoder::new(sink, compression) {
		Ok(encoder) => encoder,
		Err(err) => return stream_failure(host, &config.archive, "Cannot write", &err),
	};
	let mut creator = Creator {
		config,
		fs: host.fs().clone(),
		builder: Builder::new(Records { inner: encoder, written: 0 }),
		lister: Lister::new(host, config, to_stdout),
		warnings: Warnings::default(),
		owners: Owners::default(),
		archive_id,
		hard_links: HashMap::new(),
		cancel: host.cancel_flag(),
	};
	let mut base: Option<PathBuf> = None;
	for operand in &config.operands {
		if host.is_cancelled() {
			return INTERRUPTED_EXIT_CODE;
		}
		let result = match operand {
			Operand::Chdir(dir) => match change_dir(host, base.as_deref(), dir) {
				Ok(dir) => {
					base = Some(dir);
					Ok(())
				},
				Err(code) => return code,
			},
			Operand::Name(name) => creator.add_operand(host, base.as_deref(), name),
			Operand::FilesFrom(list) => match read_name_list(host, list, config.null) {
				Ok(names) => names
					.iter()
					.try_for_each(|name| creator.add_operand(host, base.as_deref(), name)),
				Err(code) => return code,
			},
		};
		if let Err(err) = result {
			return stream_failure(host, &config.archive, "Cannot write", &err);
		}
	}
	let Creator { builder, mut lister, .. } = creator;
	let finished = builder
		.into_inner()
		.and_then(Records::finish)
		.and_then(Encoder::finish)
		.and_then(Sink::finish)
		.and_then(|()| lister.flush(host));
	if let Err(err) = finished {
		return stream_failure(host, &config.archive, "Cannot write", &err);
	}
	finish(host)
}

impl Creator<'_> {
	/// Archives a name operand. `Err` is a failure to write the archive;
	/// problems with the file itself are reported and skipped.
	fn add_operand(&mut self, host: &mut Host, base: Option<&Path>, operand: &OsStr) -> io::Result<()> {
		let path = operand_path(host, base, operand);
		let mut name = path_bytes(operand);
		let trimmed = trim_trailing_slashes(&name).len().max(1).min(name.len());
		name.truncate(trimmed);
		let prefix = safer_prefix_len(&name);
		if prefix > 0 {
			self.warnings.removed(host, &name[..prefix]);
		}
		let member = if prefix == name.len() {
			b".".to_vec()
		} else {
			name[prefix..].to_vec()
		};
		self.add(host, &path, member, name)
	}

	fn add(&mut self, host: &mut Host, path: &Path, member: Vec<u8>, display: Vec<u8>) -> io::Result<()> {
		if self.cancel.load(Ordering::Relaxed) {
			return Err(pi_vfs::cancelled());
		}
		if self.config.excluded(&member) {
			return Ok(());
		}
		let metadata = if self.config.dereference {
			self.fs.metadata(path)
		} else {
			self.fs.symlink_metadata(path)
		};
		let metadata = match metadata {
			Ok(metadata) => metadata,
			Err(err) => {
				report(host, &display, "Cannot stat", &err);
				return Ok(());
			},
		};
		let file_type = metadata.file_type();
		if file_type.is_dir() {
			self.add_dir(host, path, &member, &display, &metadata)
		} else if file_type.is_file() {
			self.add_file(host, path, &member, &display, &metadata)
		} else if file_type.is_symlink() {
			let target = match self.fs.read_link(path) {
				Ok(target) => path_bytes(target.as_os_str()),
				Err(err) => {
					report(host, &display, "Cannot readlink", &err);
					return Ok(());
				},
			};
			let mut header = self.header(&metadata, EntryType::Symlink, 0);
			self.append(host, &mut header, &member, Some(&target), io::empty(), 0)
		} else if file_type.is_fifo() {
			let mut header = self.header(&metadata, EntryType::Fifo, 0);
			self.append(host, &mut header, &member, None, io::empty(), 0)
		} else if file_type.is_char_device() || file_type.is_block_device() {
			let kind = if file_type.is_char_device() {
				EntryType::Char
			} else {
				EntryType::Block
			};
			let mut header = self.header(&metadata, kind, 0);
			let (major, minor) = device_numbers(&metadata);
			let _ = header.set_device_major(major);
			let _ = header.set_device_minor(minor);
			self.append(host, &mut header, &member, None, io::empty(), 0)
		} else if file_type.is_socket() {
			warn(host, format_args!("{}: socket ignored", quote(&display)));
			Ok(())
		} else {
			host.error(format_args!("{}: Unknown file type; file ignored", quote(&display)), 2);
			Ok(())
		}
	}

	fn add_dir(
		&mut self,
		host: &mut Host,
		path: &Path,
		member: &[u8],
		display: &[u8],
		metadata: &Metadata,
	) -> io::Result<()> {
		let mut header = self.header(metadata, EntryType::Directory, 0);
		let dir_name = join_member(member, b"");
		self.append(host, &mut header, &dir_name, None, io::empty(), 0)?;
		let entries = match self.fs.read_dir(path) {
			Ok(entries) => entries,
			Err(err) => {
				report(host, display, "Cannot open", &err);
				return Ok(());
			},
		};
		let mut children: Vec<(Vec<u8>, PathBuf)> = Vec::new();
		for entry in entries {
			match entry {
				Ok(entry) => children.push((path_bytes(&entry.file_name()), entry.path())),
				Err(err) => report(host, display, "Cannot read", &err),
			}
		}
		children.sort_unstable_by(|a, b| a.0.cmp(&b.0));
		for (child, child_path) in children {
			self.add(host, &child_path, join_member(member, &child), join_member(display, &child))?;
		}
		Ok(())
	}

	fn add_file(
		&mut self,
		host: &mut Host,
		path: &Path,
		member: &[u8],
		display: &[u8],
		metadata: &Metadata,
	) -> io::Result<()> {
		let id = metadata.file_id();
		if id.is_some() && id == self.archive_id {
			warn(host, format_args!("{}: file is the archive; not dumped", quote(display)));
			return Ok(());
		}
		let linked = id.filter(|_| metadata.nlink().unwrap_or(1) > 1);
		if let Some(target) = linked.and_then(|id| self.hard_links.get(&id).cloned()) {
			let mut header = self.header(metadata, EntryType::Link, 0);
			return self.append(host, &mut header, member, Some(&target), io::empty(), 0);
		}
		let file = match self.fs.open(path) {
			Ok(file) => file,
			Err(err) => {
				report(host, display, "Cannot open", &err);
				return Ok(());
			},
		};
		if let Some(id) = linked {
			self.hard_links.insert(id, member.to_vec());
		}
		let size = metadata.len();
		let mut header = self.header(metadata, EntryType::Regular, size);
		let mut data = FileData {
			file,
			remaining: size,
			missing: 0,
			error: None,
			cancel: Arc::clone(&self.cancel),
		};
		self.append(host, &mut header, member, None, &mut data, size)?;
		let FileData { file, missing, error, .. } = data;
		let _ = file.close();
		if let Some(err) = error {
			report(host, display, "Read error", &err);
		} else if missing > 0 {
			host.error(
				format_args!("{}: File shrank by {missing} bytes; padding with zeros", quote(display)),
				2,
			);
		}
		Ok(())
	}

	/// A GNU header carrying `metadata`'s mode, owner, and mtime.
	fn header(&mut self, metadata: &Metadata, kind: EntryType, size: u64) -> Header {
		let mut header = Header::new_gnu();
		header.set_entry_type(kind);
		header.set_mode(metadata.mode() & 0o7777);
		let (uid, gid) = (metadata.uid().unwrap_or(0), metadata.gid().unwrap_or(0));
		header.set_uid(uid.into());
		header.set_gid(gid.into());
		header.set_size(size);
		header.set_mtime(mtime_seconds(metadata));
		if let Some(user) = self.owners.user(uid) {
			let _ = header.set_username(user);
		}
		if let Some(group) = self.owners.group(gid) {
			let _ = header.set_groupname(group);
		}
		header
	}

	fn append(
		&mut self,
		host: &mut Host,
		header: &mut Header,
		name: &[u8],
		link: Option<&[u8]>,
		data: impl Read,
		size: u64,
	) -> io::Result<()> {
		self.lister.entry(host, header, name, link, size)?;
		append_named(&mut self.builder, header, name, link, data)
	}
}

// ── List and extract ──────────────────────────────────────────────────────────

/// Opens the decompressor `explicit` names, or the one the stream's magic
/// bytes identify.
fn open_input(mut source: Box<dyn Read>, explicit: Option<Compression>) -> io::Result<Box<dyn Read>> {
	let mut prefix = [0u8; 6];
	let mut filled = 0;
	while filled < prefix.len() {
		match source.read(&mut prefix[filled..]) {
			Ok(0) => break,
			Ok(read) => filled += read,
			Err(err) if err.kind() == ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
	let compression = explicit.or_else(|| Compression::from_magic(&prefix[..filled]));
	let stream: Box<dyn Read> = Box::new(io::Cursor::new(prefix).take(filled as u64).chain(source));
	Ok(match compression {
		None => stream,
		Some(Compression::Gzip) => Box::new(flate2::read::MultiGzDecoder::new(stream)),
		Some(Compression::Bzip2) => Box::new(bzip2::read::MultiBzDecoder::new(stream)),
		Some(Compression::Xz) => Box::new(lzma_rust2::XzReader::new(stream, true)),
		Some(Compression::Zstd) => Box::new(zstd::stream::read::Decoder::new(stream)?),
	})
}

/// A member operand of list or extract.
struct Member {
	name:  Vec<u8>,
	found: bool,
}

impl Member {
	fn new(name: &OsStr) -> Self {
		let name = path_bytes(name);
		let len = trim_trailing_slashes(&name).len().max(1).min(name.len());
		Self { name: name[..len].to_vec(), found: false }
	}

	/// Whether the member `name` is this one or lies inside it.
	fn matches(&self, name: &[u8]) -> bool {
		name.strip_prefix(self.name.as_slice())
			.is_some_and(|rest| rest.is_empty() || rest.starts_with(b"/"))
	}
}

/// A directory whose mode and mtime are applied once extraction is done.
struct DelayedDir {
	path:  PathBuf,
	name:  Vec<u8>,
	mode:  u32,
	mtime: u64,
}

struct Extractor {
	fs:          BlockingFs,
	root:        PathBuf,
	root_canon:  PathBuf,
	umask:       u32,
	directories: Vec<DelayedDir>,
	buffer:      Box<[u8]>,
}

fn read_archive(host: &mut Host, config: &Config) -> i32 {
	let mut members: Vec<Member> = Vec::new();
	let mut base: Option<PathBuf> = None;
	for operand in &config.operands {
		match operand {
			Operand::Chdir(dir) => match change_dir(host, base.as_deref(), dir) {
				Ok(dir) => base = Some(dir),
				Err(code) => return code,
			},
			Operand::Name(name) => members.push(Member::new(name)),
			Operand::FilesFrom(list) => match read_name_list(host, list, config.null) {
				Ok(names) => members.extend(names.iter().map(|name| Member::new(name))),
				Err(code) => return code,
			},
		}
	}

	let source: Box<dyn Read> = if config.archive_is_stdio() {
		if host.stdin.file().is_terminal() {
			return fatal(host, "Refusing to read archive contents from terminal (missing -f option?)");
		}
		match host.stdin.try_clone() {
			Ok(stdin) => Box::new(BufReader::with_capacity(COPY_BUFFER, stdin)),
			Err(err) => return fatal(host, format_args!("-: Cannot open: {}", strip_errno(&err))),
		}
	} else {
		match host.fs().open(host.resolve(&config.archive)) {
			Ok(file) => Box::new(BufReader::with_capacity(COPY_BUFFER, file)),
			Err(err) => {
				return fatal(
					host,
					format_args!("{}: Cannot open: {}", quote_os(&config.archive), strip_errno(&err)),
				);
			},
		}
	};
	let input = match open_input(source, config.compression) {
		Ok(input) => input,
		Err(err) => return stream_failure(host, &config.archive, "Cannot read", &err),
	};

	let extractor = (config.mode == Mode::Extract).then(|| {
		let fs = host.fs().clone();
		let root = base.clone().unwrap_or_else(|| host.cwd().to_path_buf());
		let root_canon = fs.canonicalize(&root).unwrap_or_else(|_| root.clone());
		Extractor {
			fs,
			root,
			root_canon,
			umask: host.umask(),
			directories: Vec::new(),
			buffer: vec![0; COPY_BUFFER].into_boxed_slice(),
		}
	});
	let to_stderr = config.to_stdout;
	let mut reader = Reader {
		config,
		members,
		warnings: Warnings::default(),
		lister: Lister::new(host, config, to_stderr),
		stdout: config.to_stdout.then(|| host.stdout_writer()),
		extractor,
		cancel: host.cancel_flag(),
	};

	let mut archive = Archive::new(input);
	let entries = match archive.entries() {
		Ok(entries) => entries,
		Err(err) => return stream_failure(host, &config.archive, "Cannot read", &err),
	};
	let mut first = true;
	for entry in entries {
		if host.is_cancelled() {
			return INTERRUPTED_EXIT_CODE;
		}
		let mut entry = match entry {
			Ok(entry) => entry,
			Err(err) if first && err.kind() == ErrorKind::Other => {
				host.error("This does not look like a tar archive", 2);
				break;
			},
			Err(err) => return stream_failure(host, &config.archive, "Cannot read", &err),
		};
		first = false;
		if let Err(err) = reader.entry(host, &mut entry) {
			return stream_failure(host, &config.archive, "", &err);
		}
	}
	reader.finish(host)
}

struct Reader<'c> {
	config:    &'c Config,
	members:   Vec<Member>,
	warnings:  Warnings,
	lister:    Lister,
	/// Standard output for `-O` data.
	stdout:    Option<StreamWriter>,
	extractor: Option<Extractor>,
	cancel:    Arc<AtomicBool>,
}

impl Reader<'_> {
	/// Whether the member operands (all members when there are none) select
	/// `name`, marking the operands that do as found.
	fn selected(&mut self, name: &[u8]) -> bool {
		if self.members.is_empty() {
			return true;
		}
		let mut selected = false;
		for member in &mut self.members {
			if member.matches(name) {
				member.found = true;
				selected = true;
			}
		}
		selected
	}

	/// Lists or extracts one member. `Err` is a failure reading the archive or
	/// writing stdout; problems with the member itself are reported.
	fn entry<R: Read>(&mut self, host: &mut Host, entry: &mut ::tar::Entry<'_, R>) -> io::Result<()> {
		let kind = entry.header().entry_type();
		if kind.is_pax_global_extensions() {
			return Ok(());
		}
		let raw = entry.path_bytes().into_owned();
		let link = entry.link_name_bytes().map(Cow::into_owned);
		let slashes = raw.iter().take_while(|&&b| b == b'/').count();
		if slashes > 0 {
			self.warnings.removed(host, &raw[..slashes]);
		}
		let name: &[u8] = if slashes == raw.len() {
			b"./"
		} else {
			&raw[slashes..]
		};
		let bare = trim_trailing_slashes(name);
		let bare: &[u8] = if bare.is_empty() { b"." } else { bare };
		if !self.selected(bare) || self.config.excluded(bare) {
			return Ok(());
		}
		let size = entry.size();
		if self.extractor.is_none() {
			return self.lister.entry(host, entry.header(), name, link.as_deref(), size);
		}
		if has_dot_dot(bare) {
			host.error(format_args!("{}: Member name contains '..'", quote(name)), 2);
			return Ok(());
		}
		let Some(parts) = strip_components(bare, self.config.strip) else {
			return Ok(());
		};
		let stripped = parts.join(&b'/');
		let header = entry.header().clone();
		let kind = kind.as_byte();
		if let Some(out) = &mut self.stdout {
			if matches!(kind, b'0' | b'\0' | b'7' | b'S') {
				self.lister.entry(host, &header, name, link.as_deref(), size)?;
				copy_member(entry, out, &self.cancel, size)?;
			}
			return Ok(());
		}
		self.lister.entry(host, &header, name, link.as_deref(), size)?;
		let Some(extractor) = &mut self.extractor else {
			return Ok(());
		};
		let parts: Vec<&[u8]> = parts.into_iter().filter(|&part| part != b".").collect();
		let config = self.config;
		extractor.extract(host, config, &header, kind, &stripped, &parts, link.as_deref(), entry, &self.cancel)
	}

	fn finish(mut self, host: &mut Host) -> i32 {
		if let Some(extractor) = &mut self.extractor {
			extractor.finish(host, self.config);
		}
		let flushed = self
			.lister
			.flush(host)
			.and_then(|()| self.stdout.as_mut().map_or(Ok(()), |out| out.flush()));
		if let Err(err) = flushed {
			return stream_failure(host, OsStr::new("-"), "", &err);
		}
		for member in self.members.iter().filter(|member| !member.found) {
			host.error(format_args!("{}: Not found in archive", quote(&member.name)), 2);
		}
		finish(host)
	}
}

/// Copies a member's `size` bytes of data to `out`; a short read is an
/// archive that ended early.
fn copy_member(data: &mut impl Read, out: &mut impl Write, cancel: &AtomicBool, size: u64) -> io::Result<()> {
	let mut buffer = [0u8; 8192];
	let mut copied = 0;
	loop {
		if cancel.load(Ordering::Relaxed) {
			return Err(pi_vfs::cancelled());
		}
		let read = match data.read(&mut buffer) {
			Ok(0) => break,
			Ok(read) => read,
			Err(err) if err.kind() == ErrorKind::Interrupted => continue,
			Err(err) => return Err(err),
		};
		out.write_all(&buffer[..read])?;
		copied += read as u64;
	}
	if copied < size {
		return Err(ErrorKind::UnexpectedEof.into());
	}
	Ok(())
}

/// `EEXIST` as GNU prints it.
fn file_exists() -> io::Error {
	io::Error::new(ErrorKind::AlreadyExists, "File exists")
}

fn system_time(seconds: u64) -> SystemTime {
	UNIX_EPOCH + Duration::from_secs(seconds)
}

impl Extractor {
	fn mode_for(&self, config: &Config, header: &Header) -> u32 {
		let mode = header.mode().unwrap_or(0o644) & 0o7777;
		if config.preserve { mode } else { mode & !self.umask }
	}

	/// The destination of `parts` under the root, its missing parents created.
	/// A parent reached through a symlink must stay inside the root.
	fn prepare(&self, parts: &[&[u8]]) -> Result<PathBuf, String> {
		let mut path = self.root.clone();
		let Some((last, parents)) = parts.split_last() else {
			return Ok(path);
		};
		for part in parents {
			path.push(bytes_to_path(part));
			match self.fs.symlink_metadata(&path) {
				Ok(metadata) if metadata.is_dir() => {},
				Ok(metadata) if metadata.is_symlink() => {
					let target = self
						.fs
						.canonicalize(&path)
						.map_err(|err| format!("Cannot open: {}", strip_errno(&err)))?;
					if !target.starts_with(&self.root_canon) {
						return Err("Cannot open: Path leads outside the extraction directory through a \
						            symbolic link"
							.to_owned());
					}
					if !self.fs.is_dir(&target) {
						return Err("Cannot open: Not a directory".to_owned());
					}
				},
				Ok(_) => return Err("Cannot open: Not a directory".to_owned()),
				Err(err) if err.kind() == ErrorKind::NotFound => match self.fs.create_dir(&path) {
					Ok(()) => {},
					Err(err) if err.kind() == ErrorKind::AlreadyExists => {},
					Err(err) => return Err(format!("Cannot mkdir: {}", strip_errno(&err))),
				},
				Err(err) => return Err(format!("Cannot open: {}", strip_errno(&err))),
			}
		}
		path.push(bytes_to_path(last));
		Ok(path)
	}

	/// Clears the way for a new non-directory at `path`: existing entries are
	/// removed (never written through), or refused under `-k`.
	fn remove_existing(&self, config: &Config, path: &Path) -> io::Result<()> {
		match self.fs.symlink_metadata(path) {
			Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
			Err(err) => Err(err),
			Ok(_) if config.keep_old => Err(file_exists()),
			Ok(metadata) if metadata.is_dir() => self.fs.remove_dir(path),
			Ok(_) => self.fs.remove_file(path),
		}
	}

	fn set_mode(&self, host: &mut Host, name: &[u8], path: &Path, mode: u32) {
		if let Err(err) = self.fs.set_permissions(path, Permissions::from_mode(mode)) {
			let letters = mode_string(b'-', mode);
			let what = format!("Cannot change mode to {}", String::from_utf8_lossy(&letters[1..]));
			report(host, name, &what, &err);
		}
	}

	fn set_mtime(&self, host: &mut Host, config: &Config, name: &[u8], path: &Path, mtime: u64, follow: bool) {
		if config.touch {
			return;
		}
		if let Err(err) = self.fs.set_times(path, FileTime::Now, system_time(mtime), follow) {
			report(host, name, "Cannot utime", &err);
		}
	}

	#[allow(clippy::too_many_arguments, reason = "one member's decoded fields")]
	fn extract(
		&mut self,
		host: &mut Host,
		config: &Config,
		header: &Header,
		kind: u8,
		name: &[u8],
		parts: &[&[u8]],
		link: Option<&[u8]>,
		data: &mut impl Read,
		cancel: &AtomicBool,
	) -> io::Result<()> {
		let mode = self.mode_for(config, header);
		let mtime = header.mtime().unwrap_or(0);
		let path = match self.prepare(parts) {
			Ok(path) => path,
			Err(message) => {
				host.error(format_args!("{}: {message}", quote(name)), 2);
				return Ok(());
			},
		};
		match kind {
			b'5' | b'D' => {
				if path != self.root {
					self.make_dir(host, config, name, &path);
				}
				self.directories.push(DelayedDir { path, name: name.to_vec(), mode, mtime });
			},
			b'2' => {
				let target = link.unwrap_or_default();
				if let Err(err) = self.remove_existing(config, &path) {
					report(host, name, "Cannot open", &err);
					return Ok(());
				}
				if let Err(err) = self.fs.symlink(bytes_to_path(target), &path) {
					let what = format!("Cannot create symlink to '{}'", quote(target));
					report(host, name, &what, &err);
					return Ok(());
				}
				if !config.touch {
					let _ = self.fs.set_times(&path, FileTime::Now, system_time(mtime), false);
				}
			},
			b'1' => self.hard_link(host, config, name, &path, link.unwrap_or_default()),
			b'6' => {
				if let Err(err) = self.remove_existing(config, &path) {
					report(host, name, "Cannot open", &err);
					return Ok(());
				}
				if let Err(err) = self.fs.make_fifo(&path, mode) {
					report(host, name, "Cannot mkfifo", &err);
					return Ok(());
				}
				self.set_mode(host, name, &path, mode);
				self.set_mtime(host, config, name, &path, mtime, true);
			},
			b'3' | b'4' => {
				host.error(format_args!("{}: Cannot mknod: Operation not permitted", quote(name)), 2);
			},
			_ => {
				if !matches!(kind, b'0' | b'\0' | b'7' | b'S') {
					warn(
						host,
						format_args!(
							"{}: Unknown file type '{}', extracted as normal file",
							quote(name),
							char::from(kind)
						),
					);
				}
				return self.write_file(host, config, name, &path, mode, mtime, data, cancel);
			},
		}
		Ok(())
	}

	fn make_dir(&self, host: &mut Host, config: &Config, name: &[u8], path: &Path) {
		match self.fs.symlink_metadata(path) {
			Ok(metadata) if metadata.is_dir() => return,
			Ok(_) if config.keep_old => {
				report(host, name, "Cannot mkdir", &file_exists());
				return;
			},
			Ok(_) => {
				if let Err(err) = self.fs.remove_file(path) {
					report(host, name, "Cannot mkdir", &err);
					return;
				}
			},
			Err(_) => {},
		}
		match self.fs.create_dir(path) {
			Ok(()) => {},
			Err(err) if err.kind() == ErrorKind::AlreadyExists && self.fs.is_dir(path) => {},
			Err(err) => report(host, name, "Cannot mkdir", &err),
		}
	}

	fn hard_link(&self, host: &mut Host, config: &Config, name: &[u8], path: &Path, target: &[u8]) {
		let target = &target[target.iter().take_while(|&&b| b == b'/').count()..];
		let target_name = trim_trailing_slashes(target);
		if has_dot_dot(target_name) {
			host.error(format_args!("{}: Member name contains '..'", quote(target)), 2);
			return;
		}
		let Some(parts) = strip_components(target_name, config.strip) else {
			return;
		};
		let source = parts
			.iter()
			.filter(|&&part| part != b".")
			.fold(self.root.clone(), |path, part| path.join(bytes_to_path(part)));
		let inside = source
			.parent()
			.and_then(|parent| self.fs.canonicalize(parent).ok())
			.is_some_and(|parent| parent.starts_with(&self.root_canon));
		let what = format!("Cannot hard link to '{}'", quote(target));
		if !inside {
			report(host, name, &what, &io::Error::new(ErrorKind::NotFound, "No such file or directory"));
			return;
		}
		if let Err(err) = self.remove_existing(config, path) {
			report(host, name, "Cannot open", &err);
			return;
		}
		if let Err(err) = self.fs.hard_link(&source, path) {
			report(host, name, &what, &err);
		}
	}

	#[allow(clippy::too_many_arguments, reason = "one member's decoded fields")]
	fn write_file(
		&mut self,
		host: &mut Host,
		config: &Config,
		name: &[u8],
		path: &Path,
		mode: u32,
		mtime: u64,
		data: &mut impl Read,
		cancel: &AtomicBool,
	) -> io::Result<()> {
		if let Err(err) = self.remove_existing(config, path) {
			report(host, name, "Cannot open", &err);
			return Ok(());
		}
		let mut options = OpenOptions::new();
		options.write(true).create_new(true).mode(0o600);
		let mut file = match self.fs.open_with(path, &options) {
			Ok(file) => file,
			Err(err) => {
				report(host, name, "Cannot open", &err);
				return Ok(());
			},
		};
		let mut write_error = None;
		loop {
			if cancel.load(Ordering::Relaxed) {
				return Err(pi_vfs::cancelled());
			}
			let read = match data.read(&mut self.buffer) {
				Ok(0) => break,
				Ok(read) => read,
				Err(err) if err.kind() == ErrorKind::Interrupted => continue,
				Err(err) => return Err(err),
			};
			if write_error.is_none()
				&& let Err(err) = file.write_all(&self.buffer[..read])
			{
				write_error = Some(err);
			}
		}
		let closed = file.close();
		if let Some(err) = write_error.or(closed.err()) {
			report(host, name, "Cannot write", &err);
			return Ok(());
		}
		self.set_mode(host, name, path, mode);
		self.set_mtime(host, config, name, path, mtime, false);
		Ok(())
	}

	/// Applies directory modes and mtimes, deepest first, once their contents
	/// are in place.
	fn finish(&mut self, host: &mut Host, config: &Config) {
		for dir in std::mem::take(&mut self.directories).into_iter().rev() {
			self.set_mode(host, &dir.name, &dir.path, dir.mode);
			self.set_mtime(host, config, &dir.name, &dir.path, dir.mtime, true);
		}
	}
}

#[cfg(test)]
mod tests {
	use std::{fs, path::Path};

	use clap::Parser as _;

	use super::*;
	use crate::host::{Capture, run_caught};

	const LISTING: &str = "src/\nsrc/a.txt\nsrc/sub/\nsrc/sub/b.txt\n";
	const FAILURE: &str = "tar: Exiting with failure status due to previous errors\n";

	/// Runs `tar argv` in `cwd` with `stdin` and `TZ=UTC`.
	fn run(argv: &[&str], stdin: impl Into<Vec<u8>>, cwd: &Path) -> (i32, Capture) {
		let (mut host, capture) = Host::for_test("tar", stdin, cwd);
		host.set_test_var("TZ", "UTC");
		let argv: Vec<OsString> = std::iter::once("tar").chain(argv.iter().copied()).map(OsString::from).collect();
		let argv = Tar::rewrite_argv(argv).expect("old-style options expand");
		let parsed = Tar::try_parse_from(argv).expect("arguments parse");
		let code = run_caught::<Tar>(parsed, &mut host);
		(code, capture)
	}

	/// `src/a.txt` and `src/sub/b.txt` in a fresh directory.
	fn fixture() -> tempfile::TempDir {
		let tree = tempfile::tempdir().unwrap();
		let src = tree.path().join("src");
		fs::create_dir_all(src.join("sub")).unwrap();
		fs::write(src.join("a.txt"), "hello\n").unwrap();
		fs::write(src.join("sub/b.txt"), "bee\n").unwrap();
		tree
	}

	/// A member with raw header `name` bytes, owned by alice:staff, dated
	/// 2023-11-14 22:13:20 UTC.
	fn raw_entry(builder: &mut ::tar::Builder<Vec<u8>>, name: &[u8], kind: EntryType, mode: u32, data: &[u8], link: &[u8]) {
		let mut header = Header::new_gnu();
		header.as_old_mut().name[..name.len()].copy_from_slice(name);
		header.as_old_mut().linkname[..link.len()].copy_from_slice(link);
		header.set_entry_type(kind);
		header.set_mode(mode);
		header.set_size(data.len() as u64);
		header.set_mtime(1_700_000_000);
		header.set_uid(501);
		header.set_gid(20);
		header.set_username("alice").unwrap();
		header.set_groupname("staff").unwrap();
		header.set_cksum();
		builder.append(&header, data).unwrap();
	}

	fn create_fixture_archive(tree: &Path, flags: &[&str], archive: &str) {
		let mut argv = vec!["-c"];
		argv.extend_from_slice(flags);
		argv.extend(["-f", archive, "src"]);
		let (code, capture) = run(&argv, "", tree);
		assert_eq!((code, capture.err()), (0, String::new()));
	}

	fn round_trip(flags: &[&str], magic: &[u8]) {
		let tree = fixture();
		create_fixture_archive(tree.path(), flags, "arch");
		let bytes = fs::read(tree.path().join("arch")).unwrap();
		assert!(bytes.starts_with(magic), "archive starts with {:02x?}", &bytes[..8]);

		let mut argv = vec!["-t"];
		argv.extend_from_slice(flags);
		argv.extend(["-f", "arch"]);
		let (code, capture) = run(&argv, "", tree.path());
		assert_eq!((code, capture.out(), capture.err()), (0, LISTING.to_owned(), String::new()));

		fs::create_dir(tree.path().join("out")).unwrap();
		let mut argv = vec!["-x"];
		argv.extend_from_slice(flags);
		argv.extend(["-f", "arch", "-C", "out"]);
		let (code, capture) = run(&argv, "", tree.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(fs::read_to_string(tree.path().join("out/src/a.txt")).unwrap(), "hello\n");
		assert_eq!(fs::read_to_string(tree.path().join("out/src/sub/b.txt")).unwrap(), "bee\n");
	}

	#[test]
	fn plain_round_trip_writes_gnu_records() {
		round_trip(&[], b"src/");
		let tree = fixture();
		create_fixture_archive(tree.path(), &[], "arch");
		let bytes = fs::read(tree.path().join("arch")).unwrap();
		assert_eq!(&bytes[257..265], b"ustar  \0");
		assert_eq!(bytes.len() % 10240, 0);
	}

	#[test]
	fn gzip_round_trip() {
		round_trip(&["-z"], &[0x1f, 0x8b]);
	}

	#[test]
	fn zstd_round_trip() {
		round_trip(&["--zstd"], &[0x28, 0xb5, 0x2f, 0xfd]);
	}

	#[test]
	fn bzip2_round_trip() {
		round_trip(&["-j"], b"BZh");
	}

	#[test]
	fn xz_round_trip() {
		round_trip(&["-J"], &[0xfd, b'7', b'z', b'X', b'Z', 0]);
	}

	#[test]
	fn reading_detects_compression_without_a_flag() {
		let tree = fixture();
		create_fixture_archive(tree.path(), &["-z"], "arch.tgz");
		fs::create_dir(tree.path().join("out")).unwrap();
		let (code, capture) = run(&["-xf", "arch.tgz", "-C", "out"], "", tree.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(fs::read_to_string(tree.path().join("out/src/a.txt")).unwrap(), "hello\n");
	}

	#[test]
	fn auto_compress_picks_the_suffix_compression() {
		let tree = fixture();
		create_fixture_archive(tree.path(), &["-a"], "arch.tar.xz");
		let bytes = fs::read(tree.path().join("arch.tar.xz")).unwrap();
		assert!(bytes.starts_with(&[0xfd, b'7', b'z', b'X', b'Z', 0]));
	}

	#[test]
	fn directory_option_applies_to_later_operands_when_creating() {
		let tree = fixture();
		let (code, capture) = run(&["-cf", "arch", "-C", "src", "a.txt", "sub"], "", tree.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		let (_, capture) = run(&["-tf", "arch"], "", tree.path());
		assert_eq!(capture.out(), "a.txt\nsub/\nsub/b.txt\n");
	}

	#[test]
	fn missing_extract_directory_is_fatal() {
		let tree = fixture();
		create_fixture_archive(tree.path(), &[], "arch");
		let (code, capture) = run(&["-xf", "arch", "-C", "nowhere"], "", tree.path());
		assert_eq!(code, 2);
		assert_eq!(
			capture.err(),
			"tar: nowhere: Cannot open: No such file or directory\ntar: Error is not recoverable: \
			 exiting now\n"
		);
	}

	#[test]
	fn strip_components_drops_leading_directories() {
		let tree = fixture();
		create_fixture_archive(tree.path(), &[], "arch");
		fs::create_dir(tree.path().join("out")).unwrap();
		let (code, capture) = run(&["-xf", "arch", "--strip-components", "1", "-C", "out"], "", tree.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(fs::read_to_string(tree.path().join("out/a.txt")).unwrap(), "hello\n");
		assert_eq!(fs::read_to_string(tree.path().join("out/sub/b.txt")).unwrap(), "bee\n");
		assert!(!tree.path().join("out/src").exists());
	}

	#[test]
	fn exclude_drops_matching_names_at_any_depth() {
		let tree = fixture();
		fs::write(tree.path().join("src/x.log"), "log").unwrap();
		fs::write(tree.path().join("src/sub/y.log"), "log").unwrap();
		let (code, _) = run(&["-cf", "arch", "--exclude", "*.log", "src"], "", tree.path());
		assert_eq!(code, 0);
		let (_, capture) = run(&["-tf", "arch"], "", tree.path());
		assert_eq!(capture.out(), LISTING);
		let (_, capture) = run(&["-tf", "arch", "--exclude=sub"], "", tree.path());
		assert_eq!(capture.out(), "src/\nsrc/a.txt\n");
	}

	#[test]
	fn files_from_reads_null_separated_names() {
		let tree = fixture();
		fs::write(tree.path().join("list"), "src/sub/b.txt\0src/a.txt\0").unwrap();
		let (code, capture) = run(&["-cf", "arch", "--null", "-T", "list"], "", tree.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		let (_, capture) = run(&["-tf", "arch"], "", tree.path());
		assert_eq!(capture.out(), "src/sub/b.txt\nsrc/a.txt\n");
	}

	#[test]
	fn to_stdout_prints_member_contents() {
		let tree = fixture();
		create_fixture_archive(tree.path(), &[], "arch");
		let (code, capture) = run(&["-xOf", "arch", "src/a.txt"], "", tree.path());
		assert_eq!((code, capture.out(), capture.err()), (0, "hello\n".to_owned(), String::new()));
	}

	#[test]
	fn members_with_dot_dot_are_refused() {
		let tree = tempfile::tempdir().unwrap();
		let mut builder = ::tar::Builder::new(Vec::new());
		raw_entry(&mut builder, b"../evil", EntryType::Regular, 0o644, b"evil", b"");
		raw_entry(&mut builder, b"good.txt", EntryType::Regular, 0o644, b"good", b"");
		fs::write(tree.path().join("evil.tar"), builder.into_inner().unwrap()).unwrap();
		fs::create_dir_all(tree.path().join("x/out")).unwrap();
		let (code, capture) = run(&["-xf", "evil.tar", "-C", "x/out"], "", tree.path());
		assert_eq!(code, 2);
		assert_eq!(capture.err(), format!("tar: ../evil: Member name contains '..'\n{FAILURE}"));
		assert!(!tree.path().join("x/evil").exists());
		assert_eq!(fs::read_to_string(tree.path().join("x/out/good.txt")).unwrap(), "good");
	}

	#[cfg(unix)]
	#[test]
	fn parents_through_escaping_symlinks_are_refused() {
		let tree = tempfile::tempdir().unwrap();
		fs::create_dir_all(tree.path().join("outside")).unwrap();
		fs::create_dir_all(tree.path().join("out")).unwrap();
		let mut builder = ::tar::Builder::new(Vec::new());
		raw_entry(&mut builder, b"link", EntryType::Symlink, 0o777, b"", b"../outside");
		raw_entry(&mut builder, b"link/pwn.txt", EntryType::Regular, 0o644, b"pwn", b"");
		fs::write(tree.path().join("a.tar"), builder.into_inner().unwrap()).unwrap();
		let (code, capture) = run(&["-xf", "a.tar", "-C", "out"], "", tree.path());
		assert_eq!(code, 2);
		assert!(capture.err().starts_with("tar: link/pwn.txt: Cannot open: "), "{}", capture.err());
		assert!(!tree.path().join("outside/pwn.txt").exists());
	}

	#[test]
	fn leading_slash_is_stripped_on_extract() {
		let tree = tempfile::tempdir().unwrap();
		let mut builder = ::tar::Builder::new(Vec::new());
		raw_entry(&mut builder, b"/abs/x.txt", EntryType::Regular, 0o644, b"x", b"");
		fs::write(tree.path().join("a.tar"), builder.into_inner().unwrap()).unwrap();
		fs::create_dir(tree.path().join("out")).unwrap();
		let (code, capture) = run(&["-xf", "a.tar", "-C", "out"], "", tree.path());
		assert_eq!((code, capture.err()), (0, "tar: Removing leading '/' from member names\n".to_owned()));
		assert_eq!(fs::read_to_string(tree.path().join("out/abs/x.txt")).unwrap(), "x");
	}

	#[cfg(unix)]
	#[test]
	fn leading_slash_is_stripped_on_create() {
		let tree = fixture();
		let absolute = tree.path().join("src/a.txt");
		let absolute = absolute.to_str().unwrap();
		let (code, capture) = run(&["-cf", "arch", absolute], "", tree.path());
		assert_eq!((code, capture.err()), (0, "tar: Removing leading '/' from member names\n".to_owned()));
		let (_, capture) = run(&["-tf", "arch"], "", tree.path());
		assert_eq!(capture.out(), format!("{}\n", absolute.trim_start_matches('/')));
	}

	#[test]
	fn verbose_list_uses_the_gnu_long_format() {
		let tree = tempfile::tempdir().unwrap();
		let mut builder = ::tar::Builder::new(Vec::new());
		raw_entry(&mut builder, b"a.txt", EntryType::Regular, 0o644, b"hello\n", b"");
		raw_entry(&mut builder, b"d/", EntryType::Directory, 0o755, b"", b"");
		raw_entry(&mut builder, b"l", EntryType::Symlink, 0o777, b"", b"a.txt");
		raw_entry(&mut builder, b"h", EntryType::Link, 0o4755, b"", b"a.txt");
		fs::write(tree.path().join("a.tar"), builder.into_inner().unwrap()).unwrap();
		let (code, capture) = run(&["-tvf", "a.tar"], "", tree.path());
		assert_eq!(code, 0);
		assert_eq!(
			capture.out(),
			"-rw-r--r-- alice/staff       6 2023-11-14 22:13 a.txt\n\
			 drwxr-xr-x alice/staff       0 2023-11-14 22:13 d/\n\
			 lrwxrwxrwx alice/staff       0 2023-11-14 22:13 l -> a.txt\n\
			 hrwsr-xr-x alice/staff       0 2023-11-14 22:13 h link to a.txt\n"
		);
	}

	#[test]
	fn unmatched_member_exits_2() {
		let tree = fixture();
		create_fixture_archive(tree.path(), &[], "arch");
		let (code, capture) = run(&["-tf", "arch", "nosuch", "src/sub"], "", tree.path());
		assert_eq!(code, 2);
		assert_eq!(capture.out(), "src/sub/\nsrc/sub/b.txt\n");
		assert_eq!(capture.err(), format!("tar: nosuch: Not found in archive\n{FAILURE}"));
	}

	#[test]
	fn old_style_options_stream_through_stdio() {
		let tree = fixture();
		let (code, created) = run(&["czf", "-", "src"], "", tree.path());
		assert_eq!((code, created.err()), (0, String::new()));
		let bytes = created.stdout();
		assert!(bytes.starts_with(&[0x1f, 0x8b]));
		let (code, listed) = run(&["tzf", "-"], bytes.clone(), tree.path());
		assert_eq!((code, listed.out()), (0, LISTING.to_owned()));
		fs::create_dir(tree.path().join("out")).unwrap();
		let (code, capture) = run(&["-xzf", "-", "-C", "out"], bytes, tree.path());
		assert_eq!((code, capture.err()), (0, String::new()));
		assert_eq!(fs::read_to_string(tree.path().join("out/src/sub/b.txt")).unwrap(), "bee\n");
	}

	#[test]
	fn verbose_create_lists_on_stdout_or_stderr_when_archive_is_stdout() {
		let tree = fixture();
		let (code, capture) = run(&["-cvf", "arch", "src"], "", tree.path());
		assert_eq!((code, capture.out()), (0, LISTING.to_owned()));
		let (code, capture) = run(&["-cvf", "-", "src"], "", tree.path());
		assert_eq!((code, capture.err()), (0, LISTING.to_owned()));
	}

	#[test]
	fn keep_old_files_refuses_and_default_replaces() {
		let tree = fixture();
		create_fixture_archive(tree.path(), &[], "arch");
		fs::create_dir(tree.path().join("out")).unwrap();
		run(&["-xf", "arch", "-C", "out"], "", tree.path());
		let extracted = tree.path().join("out/src/a.txt");
		fs::write(&extracted, "changed").unwrap();
		let (code, capture) = run(&["-xkf", "arch", "-C", "out", "src/a.txt"], "", tree.path());
		assert_eq!(code, 2);
		assert_eq!(capture.err(), format!("tar: src/a.txt: Cannot open: File exists\n{FAILURE}"));
		assert_eq!(fs::read_to_string(&extracted).unwrap(), "changed");
		let (code, _) = run(&["-xf", "arch", "-C", "out"], "", tree.path());
		assert_eq!(code, 0);
		assert_eq!(fs::read_to_string(&extracted).unwrap(), "hello\n");
		fs::write(&extracted, "changed").unwrap();
		let (code, _) = run(&["-xf", "arch", "--overwrite", "-C", "out"], "", tree.path());
		assert_eq!(code, 0);
		assert_eq!(fs::read_to_string(&extracted).unwrap(), "hello\n");
	}

	#[test]
	fn mtimes_are_restored_unless_touch() {
		let tree = tempfile::tempdir().unwrap();
		let mut builder = ::tar::Builder::new(Vec::new());
		raw_entry(&mut builder, b"x.txt", EntryType::Regular, 0o644, b"x", b"");
		fs::write(tree.path().join("a.tar"), builder.into_inner().unwrap()).unwrap();
		let stored = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
		run(&["-xf", "a.tar"], "", tree.path());
		let mtime = fs::metadata(tree.path().join("x.txt")).unwrap().modified().unwrap();
		assert_eq!(mtime, stored);
		run(&["-xmf", "a.tar"], "", tree.path());
		let mtime = fs::metadata(tree.path().join("x.txt")).unwrap().modified().unwrap();
		assert!(mtime > stored + Duration::from_secs(86_400 * 365));
	}

	#[cfg(unix)]
	#[test]
	fn modes_are_masked_by_the_umask_unless_preserved() {
		use std::os::unix::fs::PermissionsExt as _;

		let tree = tempfile::tempdir().unwrap();
		let mut builder = ::tar::Builder::new(Vec::new());
		raw_entry(&mut builder, b"x.sh", EntryType::Regular, 0o777, b"x", b"");
		fs::write(tree.path().join("a.tar"), builder.into_inner().unwrap()).unwrap();
		let mode = || fs::metadata(tree.path().join("x.sh")).unwrap().permissions().mode() & 0o7777;
		run(&["-xf", "a.tar"], "", tree.path());
		assert_eq!(mode(), 0o777 & !crate::host::process_umask());
		run(&["-xpf", "a.tar", "--no-same-owner"], "", tree.path());
		assert_eq!(mode(), 0o777);
	}

	#[cfg(unix)]
	#[test]
	fn dereference_archives_symlink_targets() {
		let tree = fixture();
		std::os::unix::fs::symlink("a.txt", tree.path().join("src/link")).unwrap();
		run(&["-cf", "arch", "src/link"], "", tree.path());
		let (_, capture) = run(&["-tvf", "arch"], "", tree.path());
		assert!(capture.out().starts_with('l'), "{}", capture.out());
		run(&["-chf", "arch", "src/link"], "", tree.path());
		let (_, capture) = run(&["-tvf", "arch"], "", tree.path());
		assert!(capture.out().starts_with('-'), "{}", capture.out());
		let (_, capture) = run(&["-xOf", "arch"], "", tree.path());
		assert_eq!(capture.out(), "hello\n");
	}

	#[test]
	fn a_mode_is_required() {
		let tree = tempfile::tempdir().unwrap();
		let (code, capture) = run(&["-f", "arch"], "", tree.path());
		assert_eq!(code, 2);
		assert_eq!(
			capture.err(),
			"tar: You must specify one of the '-Acdtrux', '--delete' or '--test-label' options\nTry \
			 'tar --help' or 'tar --usage' for more information.\n"
		);
	}

	#[test]
	fn creating_nothing_is_refused() {
		let tree = tempfile::tempdir().unwrap();
		let (code, capture) = run(&["-cf", "arch"], "", tree.path());
		assert_eq!(code, 2);
		assert!(capture.err().starts_with("tar: Cowardly refusing to create an empty archive\n"));
	}

	#[test]
	fn exclude_patterns_follow_gnu_wildcards() {
		assert!(exclude_matches(b"*.log", b"dir/x.log"));
		assert!(exclude_matches(b"sub", b"src/sub/b.txt"));
		assert!(exclude_matches(b"src/*", b"src/sub/b.txt"));
		assert!(exclude_matches(b"[ab].txt", b"a.txt"));
		assert!(!exclude_matches(b"[!ab].txt", b"a.txt"));
		assert!(!exclude_matches(b"*.log", b"x.logs"));
		assert!(!exclude_matches(b"ub", b"src/sub"));
	}
}
