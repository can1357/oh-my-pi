//! The `lsof` builtin: lists the files processes hold open.
//!
//! Matches lsof 4.91's selection semantics, table layout, field (`-F`) output,
//! diagnostics and exit status for the options below; written against lsof's
//! manual and observed output, not ported. The Darwin `proc_info.h` record
//! layouts in `lsof/macos.rs` are ported from libproc-rs 0.14 (MIT).
//!
//! Selection: `-p s`, `-c c` (prefix or `/regex/[bix]`), `-u s`, `-g [s]`
//! and `-d s` (names, numbers, `a-b` ranges), `-i [i]`
//! (`[46][proto][@host][:port|service[,…][-…]]`), `-U`, `+d s`/`+D D`,
//! `+L l`, and file operands (matched by device and inode; a mount point or
//! block device, or any operand under `+f`, selects its whole file system;
//! `-f` forces plain files). Sets are ORed unless `-a` ANDs them; `^` items
//! of `-p`/`-c`/`-u`/`-g` and `-s p:s` TCP/UDP state lists filter first.
//!
//! Output: the `COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME` table,
//! `-t` (unique PIDs), `-F [f]`/`-F0` field records, `-l`, `-n`, `-P`, `-R`,
//! `-g` (PGID column), `+c w`, `+L`/`-L`, `-o`, `-s`, `-T [qs]`, `-V` (items
//! not located; on Linux also the rows of processes whose files cannot be
//! read). `-h`/`-?` and `-F?` print help, `-v` the version. Accepted and
//! ignored: `-b`, `+w`/`-w`, `-C`, `-O`, `-X`, `-K [i]`, `+M`/`-M`, `-S [t]`,
//! `-x [fl]`, `--`.
//!
//! Exit status 0 when something was listed and every requested PID, command,
//! user, PGID, Internet address and name was located; 1 otherwise, and for
//! usage errors.
//!
//! Platforms: Linux reads `/proc/<pid>/{cwd,root,exe,maps,fd,fdinfo}`,
//! `/proc/net/{tcp,tcp6,udp,udp6,unix,netlink}` and `/proc/locks`; macOS reads
//! libproc. Windows has no handle-table walk here: a process lists only its
//! executable (`txt`) and its TCP/UDP endpoints from the IP Helper owner-PID
//! tables (FD `NOFD`), with no cwd row, so file operands, `+d`/`+D` and `-u`
//! never match there.
//!
//! Deviations: host names come from the hosts file only (no DNS reverse
//! lookups) and port names from the services file; Linux tasks (threads) are
//! not listed (as with `-Ki`); `-o` always prints `0t` offsets; `-c /re/b`
//! uses extended syntax; processes whose files cannot be read are skipped
//! silently unless `-V`.

use std::{
	borrow::Cow,
	cell::OnceCell,
	collections::{HashMap, HashSet},
	fmt::Write as _,
	io::{self, Write as _},
	net::{IpAddr, ToSocketAddrs},
	path::{Path, PathBuf},
};

use clap::Parser;
use tokio_util::sync::CancellationToken;

use crate::{
	host::{INTERRUPTED_EXIT_CODE, ProcContext, Process, ShellPaths, strip_errno},
	proc_snapshot::ProcInfo,
};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(target_os = "windows")]
use windows as platform;

/// Lists open files and the processes holding them.
#[derive(Parser)]
#[command(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct LsofCommand {
	#[arg(num_args = 0.., trailing_var_arg = true, allow_hyphen_values = true)]
	argv: Vec<String>,
}

impl Process for LsofCommand {
	const USES_PATHS: bool = true;

	/// Puts a `--` ahead of the arguments so clap hands every one through,
	/// including a later `--` that ends lsof's own option scan.
	fn rewrite_argv(mut argv: Vec<String>) -> Vec<String> {
		if !argv.is_empty() {
			argv.insert(1, "--".to_owned());
		}
		argv
	}

	fn run(&self, context: &ProcContext) -> impl Future<Output = io::Result<i32>> + Send {
		async move {
			let argv = self.argv.clone();
			let paths = context.paths().clone();
			let cancel = context.cancel_token();
			let outcome = tokio::task::spawn_blocking(move || execute(&argv, &paths, cancel.as_ref()))
				.await
				.map_err(io::Error::other)?;
			context.stdout().write_all(outcome.stdout.as_bytes())?;
			context.stderr().write_all(outcome.stderr.as_bytes())?;
			Ok(outcome.code)
		}
	}
}

const VERSION: &str = "4.91";

/// lsof 4.91's version banner and short usage, byte for byte.
const USAGE: &str = "\
lsof 4.91
 latest revision: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/
 latest FAQ: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/FAQ
 latest man page: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/lsof_man
 usage: [-?abhlnNoOPRtUvVX] [+|-c c] [+|-d s] [+D D] [+|-f[cgG]]
 [-F [f]] [-g [s]] [-i [i]] [+|-L [l]] [+|-M] [-o [o]] [-p s]
 [+|-r [t]] [-s [p:s]] [-S [t]] [-T [t]] [-u s] [+|-w] [-x [fl]] [--] [names]
";

const HELP: &str = "\
Defaults in parentheses; comma-separated set (s) items; dash-separated ranges.
  -?|-h list help          -a AND selections (OR)     -b avoid kernel blocks
  -c c  cmd c ^c /c/[bix]  +c w  COMMAND width (9)    +d s  dir s files
  -d s  select by FD set   +D D  dir D tree *SLOW?*   -i select IPv[46] files
  -l list UID numbers      -n no host names           -P no port names
  -o list file offset      -R list paRent PID         -s list file size
  -t terse listing         -T disable TCP/TPI info    -U select Unix socket
  -v list version info     -V verbose search          +|-w  Warnings (+)
  -- end option scan
  +f|-f  +filesystem or -file names
  -F [f] select fields; -F? for help
  +|-L [l] list (+) suppress (-) link counts < l (0 = all; default = 0)
  -p s   exclude(^)|select PIDs
  -T qs  TCP/TPI Q,St (s) info
  -g [s] exclude(^)|select and print process group IDs
  -i i   select by IPv[46] address: [46][proto][@host|addr][:svc_list|port_list]
  -s p:s  exclude(^)|select protocol (p = TCP|UDP) states by name(s).
  -u s   exclude(^)|select login|UID set s
  names  select named files or files on named file systems
";

const FIELD_HELP: &str = "\
ID    field description
 a    access: r = read; w = write; u = read/write
 c    command name
 d    device character code
 D    major/minor device number as 0x<hex>
 f    file descriptor (always selected)
 g    process group ID
 i    inode number
 k    link count
 l    lock: r/R = read; w/W = write
 L    login name
 n    comment, name, Internet addresses
 o    file offset as 0t<dec> or 0x<hex>
 p    process ID (always selected)
 P    protocol name
 R    paRent PID
 s    file size
 t    file type
 T    TCP/TPI info
 u    user ID
 0    use NUL field terminator character in place of NL
";

/// Field identifiers `-F` understands; others are ignored like lsof does.
const FIELD_CHARS: &str = "acdDfgikLlnopPRstTu0";

/// Everything one run prints, and its exit status.
#[derive(Default)]
struct Outcome {
	stdout: String,
	stderr: String,
	code:   i32,
}

impl Outcome {
	fn usage_error(message: &str) -> Self {
		Self { stderr: format!("lsof: {message}\n{USAGE}{}", help_hint()), code: 1, ..Self::default() }
	}
}

fn help_hint() -> &'static str {
	"Use the ``-h'' option to get more help information.\n"
}

/// Parses `argv`, scans the processes and renders the listing.
fn execute(argv: &[String], paths: &ShellPaths, cancel: Option<&CancellationToken>) -> Outcome {
	let names = NameCache::default();
	let options = match parse(argv, paths, cancel, &names) {
		Ok(Parsed::Run(options)) => options,
		Ok(Parsed::Help) => {
			return Outcome {
				stderr: format!("{USAGE}{HELP}"),
				..Outcome::default()
			};
		},
		Ok(Parsed::FieldHelp) => return Outcome { stderr: FIELD_HELP.to_owned(), ..Outcome::default() },
		Ok(Parsed::Version) => {
			return Outcome {
				stderr: format!("lsof version information:\n    revision: {VERSION}\n"),
				..Outcome::default()
			};
		},
		Err(ParseError::Usage(message)) => return Outcome::usage_error(&message),
		Err(ParseError::Interrupted) => return Outcome { code: INTERRUPTED_EXIT_CODE, ..Outcome::default() },
	};
	let Some(listed) = scan(&options, cancel) else {
		return Outcome { code: INTERRUPTED_EXIT_CODE, ..Outcome::default() };
	};
	let mut outcome = Outcome::default();
	render(&options, &listed.processes, &names, &mut outcome.stdout);
	let missing = listed.located.missing(&options.select);
	if options.verbose {
		for message in &missing {
			let _ = writeln!(outcome.stderr, "lsof: {message}");
		}
	}
	outcome.code = i32::from(listed.processes.is_empty() || !missing.is_empty());
	outcome
}

// ── Open-file model shared with the platform scanners ───────────────────────

/// What lsof's FD column names: a descriptor number or a special mapping.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code, reason = "each platform reports a subset")]
enum Fd {
	Cwd,
	Rtd,
	Txt,
	Mem,
	/// A deleted mapped file (Linux `DEL`).
	Del,
	/// No descriptor: unreadable fd directory, or a Windows endpoint.
	NoFd,
	Num(i32),
}

impl Fd {
	fn label(self) -> Cow<'static, str> {
		match self {
			Self::Cwd => "cwd".into(),
			Self::Rtd => "rtd".into(),
			Self::Txt => "txt".into(),
			Self::Mem => "mem".into(),
			Self::Del => "DEL".into(),
			Self::NoFd => "NOFD".into(),
			Self::Num(fd) => fd.to_string().into(),
		}
	}
}

/// The DEVICE column.
#[allow(dead_code, reason = "each platform reports a subset")]
enum Device {
	/// A device number, shown `major,minor` (field `D` in hex).
	Numbers { raw: u64, major: u32, minor: u32 },
	/// A kernel object address (field `d`).
	Address(u64),
	/// Text such as a Linux socket inode (field `d`).
	Text(String),
}

impl Device {
	fn column(&self) -> String {
		match self {
			Self::Numbers { major, minor, .. } => format!("{major},{minor}"),
			Self::Address(address) => format!("{address:#x}"),
			Self::Text(text) => text.clone(),
		}
	}
}

/// The NODE column.
#[allow(dead_code, reason = "each platform reports a subset")]
enum Node {
	Inode(u64),
	Protocol(&'static str),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Proto {
	Tcp,
	Udp,
}

impl Proto {
	const fn name(self) -> &'static str {
		match self {
			Self::Tcp => "TCP",
			Self::Udp => "UDP",
		}
	}
}

/// An Internet endpoint pair.
#[derive(Clone)]
struct Inet {
	proto:  Proto,
	local:  (IpAddr, u16),
	remote: Option<(IpAddr, u16)>,
	/// The platform's state name (TCP; UDP on Linux).
	state:  Option<&'static str>,
	/// Receive and send queue lengths.
	queues: Option<(u64, u64)>,
}

impl Inet {
	/// An endpoint pair; an unspecified `remote` with port 0 means unconnected.
	fn new(proto: Proto, local: (IpAddr, u16), remote: (IpAddr, u16)) -> Self {
		let remote = (!remote.0.is_unspecified() || remote.1 != 0).then_some(remote);
		Self { proto, local, remote, state: None, queues: None }
	}
}

/// One row of the listing.
struct Entry {
	fd:      Fd,
	access:  char,
	lock:    char,
	kind:    Cow<'static, str>,
	device:  Option<Device>,
	size:    Option<u64>,
	offset:  Option<u64>,
	node:    Option<Node>,
	nlink:   Option<u64>,
	name:    String,
	/// Device and inode, for file operands and `+d`/`+D`.
	file_id: Option<(u64, u64)>,
	inet:    Option<Inet>,
}

impl Entry {
	fn new(fd: Fd, kind: impl Into<Cow<'static, str>>) -> Self {
		Self {
			fd,
			access: ' ',
			lock: ' ',
			kind: kind.into(),
			device: None,
			size: None,
			offset: None,
			node: None,
			nlink: None,
			name: String::new(),
			file_id: None,
			inet: None,
		}
	}
}

/// A process's open files. `denied` means they could not be read; `entries`
/// then holds only what `-V` reports.
struct Listing {
	entries: Vec<Entry>,
	denied:  bool,
}

// ── Options ──────────────────────────────────────────────────────────────────

enum Parsed {
	Run(Box<Options>),
	Help,
	FieldHelp,
	Version,
}

enum ParseError {
	Usage(String),
	Interrupted,
}

impl From<String> for ParseError {
	fn from(message: String) -> Self {
		Self::Usage(message)
	}
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum SizeMode {
	Auto,
	Size,
	Offset,
}

/// `-F` field selection.
struct FieldSet {
	chars:      HashSet<char>,
	/// `T` was named explicitly (UDP queue fields are printed only then).
	explicit_t: bool,
	terminator: char,
}

impl FieldSet {
	fn parse(value: &str) -> Self {
		let mut chars: HashSet<char> = if value.chars().all(|c| c == '0') {
			FIELD_CHARS.chars().filter(|c| *c != '0').collect()
		} else {
			value.chars().filter(|c| FIELD_CHARS.contains(*c) && *c != '0').collect()
		};
		chars.insert('p');
		chars.insert('f');
		Self { chars, explicit_t: value.contains('T'), terminator: if value.contains('0') { '\0' } else { '\n' } }
	}

	fn has(&self, field: char) -> bool {
		self.chars.contains(&field)
	}
}

struct Options {
	select:         Selection,
	terse:          bool,
	fields:         Option<FieldSet>,
	numeric_hosts:  bool,
	numeric_ports:  bool,
	numeric_users:  bool,
	show_ppid:      bool,
	show_pgid:      bool,
	/// COMMAND characters shown; `None` shows all.
	command_width:  Option<usize>,
	show_links:     bool,
	size_mode:      SizeMode,
	tcp_state:      bool,
	tcp_queues:     bool,
	verbose:        bool,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			select:        Selection::default(),
			terse:         false,
			fields:        None,
			numeric_hosts: false,
			numeric_ports: false,
			numeric_users: false,
			show_ppid:     false,
			show_pgid:     false,
			command_width: Some(9),
			show_links:    false,
			size_mode:     SizeMode::Auto,
			tcp_state:     true,
			tcp_queues:    false,
			verbose:       false,
		}
	}
}

/// Takes the value of an option that requires one: the rest of the option
/// group, else the next argument whatever it looks like.
fn required_value(rest: &str, argv: &[String], next: &mut usize) -> Option<String> {
	if !rest.is_empty() {
		return Some(rest.to_owned());
	}
	let value = argv.get(*next)?.clone();
	*next += 1;
	Some(value)
}

/// Takes an optional value: the rest of the group, else the next argument
/// when `accept` recognizes it.
fn optional_value(
	rest: &str,
	argv: &[String],
	next: &mut usize,
	accept: impl Fn(&str) -> bool,
) -> Option<String> {
	if !rest.is_empty() {
		return Some(rest.to_owned());
	}
	let candidate = argv.get(*next).filter(|value| accept(value))?.clone();
	*next += 1;
	Some(candidate)
}

/// lsof takes the next argument as the `-i` address unless it is an option.
fn looks_like_inet(value: &str) -> bool {
	!value.starts_with(['-', '+'])
}

fn looks_like_states(value: &str) -> bool {
	value
		.split_once(':')
		.is_some_and(|(proto, _)| proto.eq_ignore_ascii_case("tcp") || proto.eq_ignore_ascii_case("udp"))
}

fn parse(
	argv: &[String],
	paths: &ShellPaths,
	cancel: Option<&CancellationToken>,
	names: &NameCache,
) -> Result<Parsed, ParseError> {
	let mut options = Options::default();
	let mut operands = Vec::new();
	let mut directories = Vec::new();
	let mut file_systems = None;
	let mut next = 0;
	while next < argv.len() {
		let arg = &argv[next];
		next += 1;
		if arg == "--" {
			operands.extend(argv[next..].iter().cloned());
			break;
		}
		let plus = arg.starts_with('+');
		if !(arg.starts_with('-') || plus) || arg.len() < 2 {
			operands.push(arg.clone());
			continue;
		}
		let body = &arg[1..];
		let mut position = 0;
		while let Some(option) = body[position..].chars().next() {
			position += option.len_utf8();
			let rest = &body[position..];
			// Whether an optional value swallowed the rest of the group;
			// options with a value always do (see the end of the loop).
			let mut consumed = false;
			match option {
				'a' => options.select.and = true,
				'b' | 'C' | 'O' | 'X' | 'M' | 'w' => {},
				'h' | '?' => return Ok(Parsed::Help),
				'v' => return Ok(Parsed::Version),
				'V' => options.verbose = true,
				'l' => options.numeric_users = true,
				'n' => options.numeric_hosts = true,
				'P' => options.numeric_ports = true,
				'R' => options.show_ppid = true,
				't' => options.terse = true,
				'U' => options.select.unix = true,
				'c' if plus => {
					let value = required_value(rest, argv, &mut next)
						.ok_or_else(|| "missing +c option value".to_owned())?;
					let width: usize =
						value.parse().map_err(|_| format!("illegal +c value: {value}"))?;
					options.command_width = (width != 0).then(|| width.max("COMMAND".len()));
				},
				'c' => {
					let value = required_value(rest, argv, &mut next)
						.ok_or_else(|| "missing -c option value".to_owned())?;
					options.select.add_command(&value)?;
				},
				'd' => {
					let value = required_value(rest, argv, &mut next)
						.ok_or_else(|| format!("missing {}d option value", if plus { '+' } else { '-' }))?;
					if plus {
						directories.push((value, false));
					} else {
						options.select.add_fds(&value)?;
					}
				},
				'D' if plus => {
					let value = required_value(rest, argv, &mut next)
						.ok_or_else(|| "missing +D option value".to_owned())?;
					directories.push((value, true));
				},
				'f' => {
					file_systems = Some(plus);
					consumed = !rest.is_empty() && rest.chars().all(|c| "cfgGn".contains(c));
				},
				'F' => {
					let value = optional_value(rest, argv, &mut next, |value| {
						value.chars().all(|c| FIELD_CHARS.contains(c) || c == '?')
					})
					.unwrap_or_default();
					if value.contains('?') {
						return Ok(Parsed::FieldHelp);
					}
					options.fields = Some(FieldSet::parse(&value));
				},
				'g' => {
					options.show_pgid = true;
					if let Some(value) = optional_value(rest, argv, &mut next, |value| {
						value.chars().all(|c| c.is_ascii_digit() || c == ',' || c == '^')
					}) {
						options.select.add_pgids(&value)?;
					}
				},
				'i' => {
					let value = optional_value(rest, argv, &mut next, looks_like_inet).unwrap_or_default();
					let spec = parse_inet(&value, names)?;
					options.select.inet.get_or_insert_with(Vec::new).push(spec);
				},
				'K' => consumed = rest == "i",
				'L' => {
					if plus {
						options.show_links = true;
						if let Some(value) = optional_value(rest, argv, &mut next, |value| {
							!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
						}) {
							let limit: u64 =
								value.parse().map_err(|_| format!("illegal +L value: {value}"))?;
							options.select.link_below = (limit != 0).then_some(limit);
						}
					} else {
						if rest.starts_with(|c: char| c.is_ascii_digit()) {
							return Err("no number may follow -L".to_owned().into());
						}
						options.show_links = false;
						options.select.link_below = None;
					}
				},
				'o' => {
					let digits = optional_value(rest, argv, &mut next, |value| {
						!value.is_empty() && value.bytes().all(|b| b.is_ascii_digit())
					});
					match digits {
						Some(value) if value.bytes().all(|b| b.is_ascii_digit()) => consumed = true,
						_ => options.size_mode = SizeMode::Offset,
					}
				},
				'p' => {
					let value =
						required_value(rest, argv, &mut next).ok_or_else(|| "no process ID specified".to_owned())?;
					options.select.add_pids(&value)?;
				},
				's' => {
					if !rest.is_empty() {
						options.select.add_states(rest)?;
					} else if let Some(value) = optional_value(rest, argv, &mut next, looks_like_states) {
						options.select.add_states(&value)?;
					} else {
						options.size_mode = SizeMode::Size;
					}
				},
				'S' => consumed = rest.bytes().all(|b| b.is_ascii_digit()),
				'T' => {
					let value = optional_value(rest, argv, &mut next, |value| {
						!value.is_empty() && value.chars().all(|c| "fqsw".contains(c))
					})
					.unwrap_or_default();
					options.tcp_state = value.contains('s');
					options.tcp_queues = value.contains('q');
				},
				'u' => {
					let value = required_value(rest, argv, &mut next)
						.ok_or_else(|| "missing -u option value".to_owned())?;
					options.select.add_users(&value)?;
				},
				'x' => consumed = rest.chars().all(|c| "fl".contains(c)),
				other => return Err(format!("illegal option character: {other}").into()),
			}
			if consumed
				|| matches!(option, 'c' | 'd' | 'D' | 'F' | 'g' | 'i' | 'p' | 'T' | 'u')
				|| (option == 'L' && plus)
				|| (option == 's' && !rest.is_empty())
			{
				break;
			}
		}
	}
	options.select.check_pids()?;
	for operand in operands {
		let target = resolve_operand(&operand, paths, file_systems)?;
		options.select.names.push(NameItem { text: operand, target });
	}
	for (directory, recursive) in directories {
		let target = resolve_directory(&directory, recursive, paths, cancel)?;
		options.select.names.push(NameItem { text: directory, target });
	}
	Ok(Parsed::Run(Box::new(options)))
}

/// Folds a device number to the representation the scanner reports.
fn device_key(dev: u64) -> u64 {
	platform::normalize_dev(dev)
}

/// What a file operand selects: its own inode, or its whole file system for
/// a mount point, a block device, or under `+f`.
fn resolve_operand(
	operand: &str,
	paths: &ShellPaths,
	file_systems: Option<bool>,
) -> Result<NameTarget, ParseError> {
	let resolved = paths.resolve(operand);
	let metadata = paths
		.fs()
		.metadata(&resolved)
		.map_err(|error| format!("status error on {operand}: {}", strip_errno(&error)))?;
	let (Some(dev), Some(ino)) = (metadata.dev(), metadata.ino()) else {
		return Ok(NameTarget::Unknown);
	};
	let dev = device_key(dev);
	if metadata.file_type().is_block_device() {
		return Ok(metadata.rdev().map_or(NameTarget::Unknown, |rdev| NameTarget::FileSystem(device_key(rdev))));
	}
	let whole = file_systems.unwrap_or_else(|| is_mount_point(paths, &resolved, dev));
	Ok(if whole { NameTarget::FileSystem(dev) } else { NameTarget::File(dev, ino) })
}

fn is_mount_point(paths: &ShellPaths, path: &Path, dev: u64) -> bool {
	let Ok(canonical) = paths.fs().canonicalize(path) else {
		return false;
	};
	match canonical.parent() {
		None => true,
		Some(parent) => paths
			.fs()
			.metadata(parent)
			.ok()
			.and_then(|metadata| metadata.dev())
			.is_some_and(|parent_dev| device_key(parent_dev) != dev),
	}
}

/// The device/inode set of `+d` (top level) or `+D` (whole tree) `directory`;
/// subdirectories on other file systems are not entered.
fn resolve_directory(
	directory: &str,
	recursive: bool,
	paths: &ShellPaths,
	cancel: Option<&CancellationToken>,
) -> Result<NameTarget, ParseError> {
	let root = paths.resolve(directory);
	let metadata = paths
		.fs()
		.metadata(&root)
		.map_err(|error| format!("status error on {directory}: {}", strip_errno(&error)))?;
	let (Some(root_dev), Some(root_ino)) = (metadata.dev(), metadata.ino()) else {
		return Ok(NameTarget::Unknown);
	};
	let mut ids = HashSet::from([(device_key(root_dev), root_ino)]);
	let mut pending: Vec<PathBuf> = if metadata.is_dir() { vec![root] } else { Vec::new() };
	while let Some(dir) = pending.pop() {
		let Ok(entries) = paths.fs().read_dir(&dir) else {
			continue;
		};
		for entry in entries.flatten() {
			if cancel.is_some_and(CancellationToken::is_cancelled) {
				return Err(ParseError::Interrupted);
			}
			let Ok(metadata) = entry.metadata() else {
				continue;
			};
			let (Some(dev), Some(ino)) = (metadata.dev(), metadata.ino()) else {
				continue;
			};
			ids.insert((device_key(dev), ino));
			if recursive && metadata.is_dir() && !metadata.file_type().is_symlink() && dev == root_dev {
				pending.push(entry.path());
			}
		}
	}
	Ok(NameTarget::Tree(ids))
}

// ── Selection ────────────────────────────────────────────────────────────────

struct CommandPattern {
	text:  String,
	regex: Option<regex::Regex>,
}

impl CommandPattern {
	fn parse(value: &str) -> Result<Self, String> {
		let regex = match value.strip_prefix('/').and_then(|body| body.rsplit_once('/')) {
			Some((pattern, modifiers)) if modifiers.chars().all(|c| "bix".contains(c)) => Some(
				regex::RegexBuilder::new(pattern)
					.case_insensitive(modifiers.contains('i'))
					.build()
					.map_err(|_| format!("invalid regular expression: {value}"))?,
			),
			_ => None,
		};
		Ok(Self { text: value.to_owned(), regex })
	}

	fn matches(&self, command: &str) -> bool {
		match &self.regex {
			Some(regex) => regex.is_match(command),
			None => command.starts_with(&self.text),
		}
	}
}

struct UserItem {
	uid:  u32,
	text: String,
	/// Given as a login name rather than a number.
	named: bool,
}

enum FdItem {
	Range(i32, i32),
	Name(String),
}

struct FdList {
	exclude: bool,
	items:   Vec<FdItem>,
}

impl FdList {
	fn matches(&self, fd: Fd) -> bool {
		let listed = self.items.iter().any(|item| match (item, fd) {
			(FdItem::Range(low, high), Fd::Num(number)) => (*low..=*high).contains(&number),
			(FdItem::Name(name), _) => *name == fd.label(),
			_ => false,
		});
		listed != self.exclude
	}
}

struct PortRange {
	low:   u32,
	high:  u32,
	proto: Option<Proto>,
}

/// One `-i` address.
struct InetSpec {
	text:    String,
	/// `Some(true)` for `6`, `Some(false)` for `4`.
	v6:      Option<bool>,
	proto:   Option<Proto>,
	hosts:   Option<Vec<IpAddr>>,
	ports:   Vec<PortRange>,
}

impl InetSpec {
	fn matches(&self, entry: &Entry) -> bool {
		let Some(inet) = &entry.inet else {
			return false;
		};
		if self.v6.is_some_and(|v6| v6 != (entry.kind == "IPv6")) || self.proto.is_some_and(|proto| proto != inet.proto)
		{
			return false;
		}
		let endpoints = std::iter::once(inet.local).chain(inet.remote);
		if let Some(hosts) = &self.hosts {
			let mut addresses = endpoints.clone().map(|(address, _)| address.to_canonical());
			if !addresses.any(|address| hosts.contains(&address)) {
				return false;
			}
		}
		self.ports.is_empty()
			|| self.ports.iter().any(|range| {
				range.proto.is_none_or(|proto| proto == inet.proto)
					&& endpoints.clone().any(|(_, port)| (range.low..=range.high).contains(&u32::from(port)))
			})
	}
}

enum NameTarget {
	File(u64, u64),
	FileSystem(u64),
	Tree(HashSet<(u64, u64)>),
	/// A name with no device identity (a virtual path): matches nothing.
	Unknown,
}

struct NameItem {
	text:   String,
	target: NameTarget,
}

impl NameItem {
	fn matches(&self, entry: &Entry) -> bool {
		let Some(id) = entry.file_id else {
			return false;
		};
		match &self.target {
			NameTarget::File(dev, ino) => id == (*dev, *ino),
			NameTarget::FileSystem(dev) => id.0 == *dev,
			NameTarget::Tree(ids) => ids.contains(&id),
			NameTarget::Unknown => false,
		}
	}
}

#[derive(Default)]
struct StateFilter {
	include: Vec<&'static str>,
	exclude: Vec<&'static str>,
}

impl StateFilter {
	fn allows(&self, state: Option<&'static str>) -> bool {
		match state {
			Some(state) => {
				(self.include.is_empty() || self.include.contains(&state)) && !self.exclude.contains(&state)
			},
			None => self.include.is_empty(),
		}
	}
}

/// The process facts selection looks at.
struct ProcHead {
	pid:     i32,
	ppid:    Option<i32>,
	pgid:    Option<i32>,
	command: String,
	uid:     Option<u32>,
}

#[derive(Default)]
struct Selection {
	and:               bool,
	pids:              Vec<i32>,
	excluded_pids:     Vec<i32>,
	pgids:             Vec<i32>,
	excluded_pgids:    Vec<i32>,
	commands:          Vec<CommandPattern>,
	excluded_commands: Vec<CommandPattern>,
	users:             Vec<UserItem>,
	excluded_users:    Vec<u32>,
	fds:               Option<FdList>,
	inet:              Option<Vec<InetSpec>>,
	unix:              bool,
	names:             Vec<NameItem>,
	link_below:        Option<u64>,
	tcp_states:        StateFilter,
	udp_states:        StateFilter,
}

/// How the process-level sets judged a process.
struct ProcessVerdict {
	/// Some present process set matched.
	any: bool,
	/// Every present process set matched (vacuously true).
	all: bool,
}

impl Selection {
	fn add_pids(&mut self, value: &str) -> Result<(), String> {
		for item in value.split(',') {
			let (excluded, number) = item.strip_prefix('^').map_or((false, item), |rest| (true, rest));
			let pid: i32 = number
				.parse()
				.ok()
				.filter(|pid| *pid >= 0)
				.ok_or_else(|| format!("illegal process ID: {item}"))?;
			(if excluded { &mut self.excluded_pids } else { &mut self.pids }).push(pid);
		}
		Ok(())
	}

	fn check_pids(&self) -> Result<(), String> {
		match self.pids.iter().find(|pid| self.excluded_pids.contains(pid)) {
			Some(pid) => Err(format!("PID {pid} has been included and excluded.")),
			None => Ok(()),
		}
	}

	fn add_pgids(&mut self, value: &str) -> Result<(), String> {
		for item in value.split(',') {
			let (excluded, number) = item.strip_prefix('^').map_or((false, item), |rest| (true, rest));
			let pgid: i32 = number
				.parse()
				.ok()
				.filter(|pgid| *pgid >= 0)
				.ok_or_else(|| format!("illegal process group ID: {item}"))?;
			(if excluded { &mut self.excluded_pgids } else { &mut self.pgids }).push(pgid);
		}
		Ok(())
	}

	fn add_command(&mut self, value: &str) -> Result<(), String> {
		match value.strip_prefix('^') {
			Some(rest) => self.excluded_commands.push(CommandPattern::parse(rest)?),
			None => self.commands.push(CommandPattern::parse(value)?),
		}
		Ok(())
	}

	fn add_users(&mut self, value: &str) -> Result<(), String> {
		for item in value.split(',') {
			let (excluded, text) = item.strip_prefix('^').map_or((false, item), |rest| (true, rest));
			let (uid, named) = match text.parse::<u32>() {
				Ok(uid) => (uid, false),
				Err(_) => (user_id(text).ok_or_else(|| format!("can't get UID for {text}"))?, true),
			};
			if excluded {
				self.excluded_users.push(uid);
			} else {
				self.users.push(UserItem { uid, text: text.to_owned(), named });
			}
		}
		Ok(())
	}

	fn add_fds(&mut self, value: &str) -> Result<(), String> {
		for item in value.split(',') {
			let (excluded, text) = item.strip_prefix('^').map_or((false, item), |rest| (true, rest));
			let list = self.fds.get_or_insert(FdList { exclude: excluded, items: Vec::new() });
			if list.exclude != excluded {
				return Err(if excluded {
					format!("exclude in an include -d list: {item}")
				} else {
					format!("include in an exclude -d list: {item}")
				});
			}
			let range = text.split_once('-').and_then(|(low, high)| Some((low.parse::<i32>().ok()?, high.parse::<i32>().ok()?)));
			let parsed = if let Some((low, high)) = range {
				if low >= high {
					return Err(format!("-d FD range's low >= its high: {text}"));
				}
				FdItem::Range(low, high)
			} else if let Ok(number) = text.parse::<i32>() {
				FdItem::Range(number, number)
			} else {
				FdItem::Name(text.to_owned())
			};
			list.items.push(parsed);
		}
		Ok(())
	}

	fn add_states(&mut self, spec: &str) -> Result<(), String> {
		let (proto, list) =
			spec.split_once(':').ok_or_else(|| format!("missing protocol state name list: {spec}"))?;
		let (filter, table, name) = if proto.eq_ignore_ascii_case("tcp") {
			(&mut self.tcp_states, platform::TCP_STATES, "TCP")
		} else if proto.eq_ignore_ascii_case("udp") {
			(&mut self.udp_states, platform::UDP_STATES, "UDP")
		} else {
			return Err(format!("unknown protocol name ({proto}) in: -s {spec}"));
		};
		for item in list.split(',') {
			let (excluded, text) = item.strip_prefix('^').map_or((false, item), |rest| (true, rest));
			let state = table
				.iter()
				.copied()
				.find(|state| state.eq_ignore_ascii_case(text))
				.ok_or_else(|| format!("unknown {name} state name: {text}"))?;
			(if excluded { &mut filter.exclude } else { &mut filter.include }).push(state);
		}
		Ok(())
	}

	fn has_process_sets(&self) -> bool {
		!self.pids.is_empty() || !self.pgids.is_empty() || !self.commands.is_empty() || !self.users.is_empty()
	}

	fn has_file_sets(&self) -> bool {
		self.fds.is_some()
			|| self.inet.is_some()
			|| self.unix
			|| !self.names.is_empty()
			|| self.link_below.is_some()
	}

	/// Whether only sockets can be selected from a process with `verdict`.
	fn sockets_only(&self, verdict: &ProcessVerdict) -> bool {
		let network = self.inet.is_some() || self.unix;
		if self.and {
			network
		} else {
			network
				&& !verdict.any
				&& self.fds.is_none()
				&& self.names.is_empty()
				&& self.link_below.is_none()
		}
	}

	/// `^` exclusions, applied before every other selection.
	fn excludes(&self, process: &ProcHead) -> bool {
		self.excluded_pids.contains(&process.pid)
			|| process.pgid.is_some_and(|pgid| self.excluded_pgids.contains(&pgid))
			|| self.excluded_commands.iter().any(|pattern| pattern.matches(&process.command))
			|| process.uid.is_some_and(|uid| self.excluded_users.contains(&uid))
	}

	fn verdict(&self, process: &ProcHead) -> ProcessVerdict {
		let sets = [
			(!self.pids.is_empty()).then(|| self.pids.contains(&process.pid)),
			(!self.pgids.is_empty()).then(|| process.pgid.is_some_and(|pgid| self.pgids.contains(&pgid))),
			(!self.commands.is_empty())
				.then(|| self.commands.iter().any(|pattern| pattern.matches(&process.command))),
			(!self.users.is_empty())
				.then(|| process.uid.is_some_and(|uid| self.users.iter().any(|user| user.uid == uid))),
		];
		ProcessVerdict {
			any: sets.iter().flatten().any(|matched| *matched),
			all: sets.iter().flatten().all(|matched| *matched),
		}
	}

	/// Whether the process can contribute anything before its files are read.
	fn may_select(&self, verdict: &ProcessVerdict) -> bool {
		if self.and { verdict.all } else { verdict.any || !self.has_process_sets() || self.has_file_sets() }
	}

	fn selects(&self, verdict: &ProcessVerdict, entry: &Entry) -> bool {
		if let Some(inet) = &entry.inet {
			let filter = match inet.proto {
				Proto::Tcp => &self.tcp_states,
				Proto::Udp => &self.udp_states,
			};
			if !filter.allows(inet.state) {
				return false;
			}
		}
		if !self.has_process_sets() && !self.has_file_sets() {
			return true;
		}
		let sets = [
			self.fds.as_ref().map(|list| list.matches(entry.fd)),
			self.inet.as_ref().map(|specs| specs.iter().any(|spec| spec.matches(entry))),
			self.unix.then(|| entry.kind == "unix"),
			(!self.names.is_empty()).then(|| self.names.iter().any(|name| name.matches(entry))),
			self.link_below.map(|limit| entry.nlink.is_some_and(|links| links < limit)),
		];
		if self.and {
			verdict.all && sets.iter().flatten().all(|matched| *matched)
		} else {
			verdict.any || sets.iter().flatten().any(|matched| *matched)
		}
	}
}

/// Which inclusion items some listed file matched.
struct Located {
	pids:     Vec<bool>,
	pgids:    Vec<bool>,
	commands: Vec<bool>,
	users:    Vec<bool>,
	inet:     Vec<bool>,
	names:    Vec<bool>,
}

impl Located {
	fn new(select: &Selection) -> Self {
		Self {
			pids:     vec![false; select.pids.len()],
			pgids:    vec![false; select.pgids.len()],
			commands: vec![false; select.commands.len()],
			users:    vec![false; select.users.len()],
			inet:     vec![false; select.inet.as_ref().map_or(0, Vec::len)],
			names:    vec![false; select.names.len()],
		}
	}

	fn mark(&mut self, select: &Selection, process: &ProcHead, entry: &Entry) {
		let mark = |flags: &mut [bool], hit: &dyn Fn(usize) -> bool| {
			for (index, flag) in flags.iter_mut().enumerate() {
				*flag |= hit(index);
			}
		};
		mark(&mut self.pids, &|index| select.pids[index] == process.pid);
		mark(&mut self.pgids, &|index| process.pgid == Some(select.pgids[index]));
		mark(&mut self.commands, &|index| select.commands[index].matches(&process.command));
		mark(&mut self.users, &|index| process.uid == Some(select.users[index].uid));
		if let Some(specs) = &select.inet {
			mark(&mut self.inet, &|index| specs[index].matches(entry));
		}
		mark(&mut self.names, &|index| select.names[index].matches(entry));
	}

	/// lsof's message for every inclusion item nothing matched.
	fn missing(&self, select: &Selection) -> Vec<String> {
		let mut messages = Vec::new();
		let unmatched = |flags: &[bool]| flags.iter().enumerate().filter(|(_, hit)| !**hit).map(|(index, _)| index).collect::<Vec<_>>();
		for index in unmatched(&self.pids) {
			messages.push(format!("process ID not located: {}", select.pids[index]));
		}
		for index in unmatched(&self.pgids) {
			messages.push(format!("process group ID not located: {}", select.pgids[index]));
		}
		for index in unmatched(&self.commands) {
			messages.push(format!("command not located: {}", select.commands[index].text));
		}
		for index in unmatched(&self.users) {
			let user = &select.users[index];
			messages.push(if user.named {
				format!("login name (UID {}) not located: {}", user.uid, user.text)
			} else {
				format!("user ID not located: {}", user.uid)
			});
		}
		if let Some(specs) = &select.inet {
			for index in unmatched(&self.inet) {
				messages.push(format!("Internet address not located: {}", specs[index].text));
			}
		}
		for index in unmatched(&self.names) {
			messages.push(format!("no file use located: {}", select.names[index].text));
		}
		messages
	}
}

// ── Scanning ─────────────────────────────────────────────────────────────────

struct Listed {
	processes: Vec<(ProcHead, Vec<Entry>)>,
	located:   Located,
}

/// Reads every candidate process's files and keeps the selected ones;
/// `None` once cancelled.
fn scan(options: &Options, cancel: Option<&CancellationToken>) -> Option<Listed> {
	let select = &options.select;
	let mut processes = ProcInfo::all();
	processes.sort_by_key(ProcInfo::pid);
	let scanner = platform::Scanner::new();
	let mut located = Located::new(select);
	let mut listed = Vec::new();
	for info in &processes {
		if cancel.is_some_and(CancellationToken::is_cancelled) {
			return None;
		}
		let head = ProcHead {
			pid:     info.pid(),
			ppid:    info.ppid(),
			pgid:    info.group_id(),
			command: platform::command_name(info),
			uid:     info.effective_user_id(),
		};
		if select.excludes(&head) {
			continue;
		}
		let verdict = select.verdict(&head);
		if !select.may_select(&verdict) {
			continue;
		}
		let listing = scanner.files(head.pid, select.sockets_only(&verdict));
		if listing.denied && !options.verbose {
			continue;
		}
		let entries: Vec<Entry> =
			listing.entries.into_iter().filter(|entry| select.selects(&verdict, entry)).collect();
		if entries.is_empty() {
			continue;
		}
		for entry in &entries {
			located.mark(select, &head, entry);
		}
		listed.push((head, entries));
	}
	Some(Listed { processes: listed, located })
}

// ── Names ────────────────────────────────────────────────────────────────────

/// Host and service names from the hosts and services files.
#[derive(Default)]
struct NameDb {
	port_names:     HashMap<(u16, Proto), String>,
	ports:          HashMap<(String, Proto), u16>,
	host_names:     HashMap<IpAddr, String>,
	host_addresses: HashMap<String, Vec<IpAddr>>,
}

#[cfg(unix)]
fn etc_file(name: &str) -> PathBuf {
	Path::new("/etc").join(name)
}

#[cfg(windows)]
fn etc_file(name: &str) -> PathBuf {
	let root = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
	Path::new(&root).join("System32").join("drivers").join("etc").join(name)
}

impl NameDb {
	fn load() -> Self {
		let mut db = Self::default();
		if let Ok(text) = std::fs::read_to_string(etc_file("services")) {
			db.add_services(&text);
		}
		if let Ok(text) = std::fs::read_to_string(etc_file("hosts")) {
			db.add_hosts(&text);
		}
		db
	}

	fn add_services(&mut self, text: &str) {
		for line in text.lines() {
			let line = line.split('#').next().unwrap_or_default();
			let mut words = line.split_whitespace();
			let (Some(name), Some(port_proto)) = (words.next(), words.next()) else {
				continue;
			};
			let Some((port, proto)) = port_proto.split_once('/') else {
				continue;
			};
			let Ok(port) = port.parse::<u16>() else {
				continue;
			};
			let proto = match proto {
				"tcp" => Proto::Tcp,
				"udp" => Proto::Udp,
				_ => continue,
			};
			self.port_names.entry((port, proto)).or_insert_with(|| name.to_owned());
			for alias in std::iter::once(name).chain(words) {
				self.ports.entry((alias.to_owned(), proto)).or_insert(port);
			}
		}
	}

	fn add_hosts(&mut self, text: &str) {
		for line in text.lines() {
			let line = line.split('#').next().unwrap_or_default();
			let mut words = line.split_whitespace();
			let Some(address) = words.next() else {
				continue;
			};
			let address = address.split('%').next().unwrap_or_default();
			let Ok(address) = address.parse::<IpAddr>() else {
				continue;
			};
			let address = address.to_canonical();
			for (index, name) in words.enumerate() {
				if index == 0 {
					self.host_names.entry(address).or_insert_with(|| name.to_owned());
				}
				self.host_addresses.entry(name.to_ascii_lowercase()).or_default().push(address);
			}
		}
	}
}

/// Loads the [`NameDb`] on first use.
#[derive(Default)]
struct NameCache(OnceCell<NameDb>);

impl NameCache {
	fn get(&self) -> &NameDb {
		self.0.get_or_init(NameDb::load)
	}
}

/// Parses one `-i` address: `[46][proto][@host|addr][:port|service[,…]]`.
fn parse_inet(spec: &str, names: &NameCache) -> Result<InetSpec, String> {
	let mut rest = spec;
	let v6 = match rest.as_bytes().first() {
		Some(b'4') => Some(false),
		Some(b'6') => Some(true),
		_ => None,
	};
	if v6.is_some() {
		rest = &rest[1..];
	}
	let proto_end = rest.find(['@', ':']).unwrap_or(rest.len());
	let proto = match &rest[..proto_end] {
		"" => None,
		name if name.eq_ignore_ascii_case("tcp") => Some(Proto::Tcp),
		name if name.eq_ignore_ascii_case("udp") => Some(Proto::Udp),
		name => return Err(format!("unknown protocol name ({name}) in: -i {spec}")),
	};
	rest = &rest[proto_end..];
	let mut hosts = None;
	if let Some(host_part) = rest.strip_prefix('@') {
		let (host, after) = if let Some(bracketed) = host_part.strip_prefix('[') {
			let close = bracketed.find(']').ok_or_else(|| format!("unacceptable Internet address in: -i {spec}"))?;
			(&bracketed[..close], &bracketed[close + 1..])
		} else {
			let end = host_part.find(':').unwrap_or(host_part.len());
			(&host_part[..end], &host_part[end..])
		};
		if host.is_empty() {
			return Err(format!("missing host name in: -i {spec}"));
		}
		hosts = Some(resolve_host(host, names).ok_or_else(|| format!("unknown host name ({host}) in: -i {spec}"))?);
		rest = after;
	}
	let mut ports = Vec::new();
	if let Some(list) = rest.strip_prefix(':') {
		if list.is_empty() {
			return Err(format!("unacceptable port specification in: -i {spec}"));
		}
		for item in list.split(',') {
			parse_port_item(item, proto, spec, names, &mut ports)?;
		}
	} else if !rest.is_empty() {
		return Err(format!("unacceptable Internet address in: -i {spec}"));
	}
	Ok(InetSpec { text: spec.to_owned(), v6, proto, hosts, ports })
}

fn resolve_host(host: &str, names: &NameCache) -> Option<Vec<IpAddr>> {
	if let Ok(address) = host.parse::<IpAddr>() {
		return Some(vec![address.to_canonical()]);
	}
	if let Some(addresses) = names.get().host_addresses.get(&host.to_ascii_lowercase()) {
		return Some(addresses.clone());
	}
	let addresses: Vec<IpAddr> = (host, 0)
		.to_socket_addrs()
		.ok()?
		.map(|address| address.ip().to_canonical())
		.collect();
	(!addresses.is_empty()).then_some(addresses)
}

fn parse_port_item(
	item: &str,
	proto: Option<Proto>,
	spec: &str,
	names: &NameCache,
	ports: &mut Vec<PortRange>,
) -> Result<(), String> {
	let bad = || format!("unacceptable port specification in: -i {spec}");
	if item.is_empty() {
		return Err(bad());
	}
	// A range starts with a number; a service name may itself contain `-`.
	if let Some((low, high)) = item.split_once('-')
		&& let Ok(low) = low.parse::<u32>()
	{
		let high = match high.parse::<u32>() {
			Ok(high) => vec![(high, None)],
			Err(_) => service_ports(high, proto, spec, names)?,
		};
		for (high, proto_of) in high {
			if low > high {
				return Err(bad());
			}
			ports.push(PortRange { low, high, proto: proto_of.or(proto) });
		}
		return Ok(());
	}
	if let Ok(port) = item.parse::<u32>() {
		ports.push(PortRange { low: port, high: port, proto });
		return Ok(());
	}
	for (port, proto_of) in service_ports(item, proto, spec, names)? {
		ports.push(PortRange { low: port, high: port, proto: proto_of.or(proto) });
	}
	Ok(())
}

/// The port(s) of service `name` for `proto`, or for TCP and UDP each.
fn service_ports(
	name: &str,
	proto: Option<Proto>,
	spec: &str,
	names: &NameCache,
) -> Result<Vec<(u32, Option<Proto>)>, String> {
	let db = names.get();
	let protos = match proto {
		Some(proto) => vec![proto],
		None => vec![Proto::Tcp, Proto::Udp],
	};
	let found: Vec<(u32, Option<Proto>)> = protos
		.iter()
		.filter_map(|proto| db.ports.get(&(name.to_owned(), *proto)).map(|port| (u32::from(*port), Some(*proto))))
		.collect();
	if found.is_empty() {
		return Err(match proto {
			Some(proto) => {
				format!("unknown service {name} for {} in: -i {spec}", proto.name().to_ascii_lowercase())
			},
			None => format!("unknown service {name} in: -i {spec}"),
		});
	}
	Ok(found)
}

#[cfg(unix)]
fn user_name(uid: u32) -> Option<String> {
	uucore::entries::uid2usr(uid).ok()
}

#[cfg(not(unix))]
fn user_name(_uid: u32) -> Option<String> {
	None
}

#[cfg(unix)]
fn user_id(name: &str) -> Option<u32> {
	uucore::entries::usr2uid(name).ok()
}

#[cfg(not(unix))]
fn user_id(_name: &str) -> Option<u32> {
	None
}

// ── Output ───────────────────────────────────────────────────────────────────

/// Escapes control characters the way lsof prints names and commands.
fn printable(text: &str) -> Cow<'_, str> {
	if !text.chars().any(char::is_control) {
		return Cow::Borrowed(text);
	}
	let mut out = String::with_capacity(text.len() + 8);
	for c in text.chars() {
		match c {
			'\u{8}' => out.push_str("\\b"),
			'\u{c}' => out.push_str("\\f"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			'\u{7f}' => out.push_str("^?"),
			c if (c as u32) < 0x20 => {
				out.push('^');
				out.push(char::from_u32(c as u32 + 0x40).unwrap_or('?'));
			},
			c if c.is_control() => {
				let _ = write!(out, "\\x{:02x}", c as u32);
			},
			c => out.push(c),
		}
	}
	Cow::Owned(out)
}

fn format_offset(offset: u64) -> String {
	if offset < 100_000_000 { format!("0t{offset}") } else { format!("{offset:#x}") }
}

fn size_off(entry: &Entry, mode: SizeMode) -> String {
	match mode {
		SizeMode::Auto => entry
			.size
			.map(|size| size.to_string())
			.or_else(|| entry.offset.map(format_offset))
			.unwrap_or_default(),
		SizeMode::Size => entry.size.map(|size| size.to_string()).unwrap_or_default(),
		SizeMode::Offset => entry.offset.map(format_offset).unwrap_or_default(),
	}
}

/// `host:port` with lsof's `*` for wildcards and the optional name lookups.
fn endpoint(address: IpAddr, port: u16, proto: Proto, options: &Options, names: &NameCache) -> String {
	let host = if address.is_unspecified() {
		"*".to_owned()
	} else if let Some(name) =
		(!options.numeric_hosts).then(|| names.get().host_names.get(&address.to_canonical())).flatten()
	{
		name.clone()
	} else {
		match address {
			IpAddr::V4(v4) => v4.to_string(),
			IpAddr::V6(v6) => format!("[{v6}]"),
		}
	};
	let port = if port == 0 {
		"*".to_owned()
	} else if let Some(name) = (!options.numeric_ports).then(|| names.get().port_names.get(&(port, proto))).flatten()
	{
		name.clone()
	} else {
		port.to_string()
	};
	format!("{host}:{port}")
}

/// The NAME of a network file, without TCP/TPI information.
fn inet_address(inet: &Inet, options: &Options, names: &NameCache) -> String {
	let mut name = endpoint(inet.local.0, inet.local.1, inet.proto, options, names);
	if let Some((address, port)) = inet.remote {
		name.push_str("->");
		name.push_str(&endpoint(address, port, inet.proto, options, names));
	}
	name
}

fn entry_name(entry: &Entry, options: &Options, names: &NameCache) -> String {
	let Some(inet) = &entry.inet else {
		return printable(&entry.name).into_owned();
	};
	let mut name = inet_address(inet, options, names);
	let mut info = Vec::new();
	if inet.proto == Proto::Tcp
		&& options.tcp_state
		&& let Some(state) = inet.state
	{
		info.push(state.to_owned());
	}
	if options.tcp_queues
		&& let Some((receive, send)) = inet.queues
	{
		info.push(format!("QR={receive} QS={send}"));
	}
	if !info.is_empty() {
		let _ = write!(name, " ({})", info.join(" "));
	}
	name
}

/// Login names by uid, looked up once each.
#[derive(Default)]
struct Users(HashMap<u32, Option<String>>);

impl Users {
	fn name(&mut self, uid: u32) -> Option<&str> {
		self.0.entry(uid).or_insert_with(|| user_name(uid)).as_deref()
	}
}

fn render(options: &Options, processes: &[(ProcHead, Vec<Entry>)], names: &NameCache, out: &mut String) {
	if options.terse {
		for (process, _) in processes {
			let _ = writeln!(out, "{}", process.pid);
		}
	} else if let Some(fields) = &options.fields {
		render_fields(options, fields, processes, names, out);
	} else {
		render_table(options, processes, names, out);
	}
}

fn render_fields(
	options: &Options,
	fields: &FieldSet,
	processes: &[(ProcHead, Vec<Entry>)],
	names: &NameCache,
	out: &mut String,
) {
	let end = fields.terminator;
	let mut users = Users::default();
	let field = |out: &mut String, id: char, value: &str| {
		out.push(id);
		out.push_str(value);
		out.push(end);
	};
	for (process, entries) in processes {
		field(out, 'p', &process.pid.to_string());
		if fields.has('g')
			&& let Some(pgid) = process.pgid
		{
			field(out, 'g', &pgid.to_string());
		}
		if fields.has('R')
			&& let Some(ppid) = process.ppid
		{
			field(out, 'R', &ppid.to_string());
		}
		if fields.has('c') {
			field(out, 'c', &process.command);
		}
		if let Some(uid) = process.uid {
			if fields.has('u') {
				field(out, 'u', &uid.to_string());
			}
			if fields.has('L')
				&& !options.numeric_users
				&& let Some(login) = users.name(uid)
			{
				field(out, 'L', login);
			}
		}
		if end == '\0' {
			out.push('\n');
		}
		for entry in entries {
			field(out, 'f', &entry.fd.label());
			if fields.has('a') {
				field(out, 'a', &entry.access.to_string());
			}
			if fields.has('l') {
				field(out, 'l', &entry.lock.to_string());
			}
			if fields.has('t') {
				field(out, 't', &entry.kind);
			}
			match &entry.device {
				Some(Device::Numbers { raw, .. }) if fields.has('D') => field(out, 'D', &format!("{raw:#x}")),
				Some(device @ (Device::Address(_) | Device::Text(_))) if fields.has('d') => {
					field(out, 'd', &device.column());
				},
				_ => {},
			}
			let size = (options.size_mode != SizeMode::Offset).then_some(entry.size).flatten();
			match (size, entry.offset) {
				(Some(size), _) if fields.has('s') => field(out, 's', &size.to_string()),
				(None, Some(offset)) if fields.has('o') && options.size_mode != SizeMode::Size => {
					field(out, 'o', &format_offset(offset));
				},
				_ => {},
			}
			if fields.has('i')
				&& let Some(Node::Inode(inode)) = entry.node
			{
				field(out, 'i', &inode.to_string());
			}
			if fields.has('k')
				&& let Some(links) = entry.nlink
			{
				field(out, 'k', &links.to_string());
			}
			if fields.has('P')
				&& let Some(inet) = &entry.inet
			{
				field(out, 'P', inet.proto.name());
			}
			if fields.has('n') {
				let name = match &entry.inet {
					Some(inet) => inet_address(inet, options, names),
					None => printable(&entry.name).into_owned(),
				};
				field(out, 'n', &name);
			}
			if fields.has('T')
				&& let Some(inet) = &entry.inet
			{
				let queues = inet.proto == Proto::Tcp || fields.explicit_t;
				if inet.proto == Proto::Tcp
					&& let Some(state) = inet.state
				{
					field(out, 'T', &format!("ST={state}"));
				}
				if queues && let Some((receive, send)) = inet.queues {
					field(out, 'T', &format!("QR={receive}"));
					field(out, 'T', &format!("QS={send}"));
				}
			}
			if end == '\0' {
				out.push('\n');
			}
		}
	}
}

/// One table row, every column already formatted.
struct Row {
	command:  String,
	pid:      String,
	ppid:     Option<String>,
	pgid:     Option<String>,
	user:     String,
	fd:       String,
	access:   char,
	lock:     char,
	kind:     String,
	device:   String,
	size_off: String,
	nlink:    Option<String>,
	node:     String,
	name:     String,
}

/// Optional columns and the SIZE/OFF title.
struct Columns {
	ppid:       bool,
	pgid:       bool,
	nlink:      bool,
	size_title: &'static str,
}

fn render_table(
	options: &Options,
	processes: &[(ProcHead, Vec<Entry>)],
	names: &NameCache,
	out: &mut String,
) {
	let mut users = Users::default();
	let mut rows = Vec::new();
	for (process, entries) in processes {
		let command = printable(&process.command);
		let command: String = match options.command_width {
			Some(width) => command.chars().take(width).collect(),
			None => command.into_owned(),
		};
		let user = match process.uid {
			Some(uid) if !options.numeric_users => {
				users.name(uid).map_or_else(|| format!("{uid:>8}"), str::to_owned)
			},
			Some(uid) => format!("{uid:>8}"),
			None => String::new(),
		};
		for entry in entries {
			// A lock with no known access shows `-` in the access position.
			let access = if entry.lock != ' ' && entry.access == ' ' { '-' } else { entry.access };
			rows.push(Row {
				command: command.clone(),
				pid: process.pid.to_string(),
				ppid: options.show_ppid.then(|| process.ppid.map(|ppid| ppid.to_string()).unwrap_or_default()),
				pgid: options.show_pgid.then(|| process.pgid.map(|pgid| pgid.to_string()).unwrap_or_default()),
				user: user.clone(),
				fd: entry.fd.label().into_owned(),
				access,
				lock: entry.lock,
				kind: entry.kind.to_string(),
				device: entry.device.as_ref().map(Device::column).unwrap_or_default(),
				size_off: size_off(entry, options.size_mode),
				nlink: options.show_links.then(|| entry.nlink.map(|links| links.to_string()).unwrap_or_default()),
				node: match &entry.node {
					Some(Node::Inode(inode)) => inode.to_string(),
					Some(Node::Protocol(proto)) => (*proto).to_owned(),
					None => String::new(),
				},
				name: entry_name(entry, options, names),
			});
		}
	}
	let columns = Columns {
		ppid:       options.show_ppid,
		pgid:       options.show_pgid,
		nlink:      options.show_links,
		size_title: match options.size_mode {
			SizeMode::Auto => "SIZE/OFF",
			SizeMode::Size => "SIZE",
			SizeMode::Offset => "OFFSET",
		},
	};
	format_table(&rows, &columns, out);
}

/// Lays out `rows` under lsof's header: COMMAND left-aligned, everything else
/// right-aligned to its widest value, NAME last and unpadded.
fn format_table(rows: &[Row], columns: &Columns, out: &mut String) {
	if rows.is_empty() {
		return;
	}
	let width = |title: &str, minimum: usize, value: &dyn Fn(&Row) -> usize| {
		rows.iter().map(value).max().unwrap_or(0).max(title.len()).max(minimum)
	};
	let count = |text: &str| text.chars().count();
	let command_w = width("COMMAND", 0, &|row| count(&row.command));
	let pid_w = width("PID", 0, &|row| count(&row.pid));
	let ppid_w = width("PPID", 0, &|row| row.ppid.as_deref().map_or(0, count));
	let pgid_w = width("PGID", 0, &|row| row.pgid.as_deref().map_or(0, count));
	let user_w = width("USER", 0, &|row| count(&row.user));
	let fd_w = width("FD", 4, &|row| count(&row.fd));
	let kind_w = width("TYPE", 0, &|row| count(&row.kind));
	let device_w = width("DEVICE", 0, &|row| count(&row.device));
	let size_w = width(columns.size_title, 0, &|row| count(&row.size_off));
	let nlink_w = width("NLINK", 0, &|row| row.nlink.as_deref().map_or(0, count));
	let node_w = width("NODE", 0, &|row| count(&row.node));

	let _ = write!(out, "{:<command_w$} {:>pid_w$}", "COMMAND", "PID");
	if columns.ppid {
		let _ = write!(out, " {:>ppid_w$}", "PPID");
	}
	if columns.pgid {
		let _ = write!(out, " {:>pgid_w$}", "PGID");
	}
	let _ = write!(out, " {:>user_w$} {:>fd_w$}   {:>kind_w$} {:>device_w$} {:>size_w$}", "USER", "FD", "TYPE", "DEVICE", columns.size_title);
	if columns.nlink {
		let _ = write!(out, " {:>nlink_w$}", "NLINK");
	}
	let _ = writeln!(out, " {:>node_w$} NAME", "NODE");

	for row in rows {
		let _ = write!(out, "{:<command_w$} {:>pid_w$}", row.command, row.pid);
		if let Some(ppid) = &row.ppid {
			let _ = write!(out, " {ppid:>ppid_w$}");
		}
		if let Some(pgid) = &row.pgid {
			let _ = write!(out, " {pgid:>pgid_w$}");
		}
		let _ = write!(
			out,
			" {:>user_w$} {:>fd_w$}{}{} {:>kind_w$} {:>device_w$} {:>size_w$}",
			row.user, row.fd, row.access, row.lock, row.kind, row.device, row.size_off
		);
		if let Some(links) = &row.nlink {
			let _ = write!(out, " {links:>nlink_w$}");
		}
		let _ = writeln!(out, " {:>node_w$} {}", row.node, row.name);
	}
}

#[cfg(test)]
mod tests {
	use super::{Columns, LsofCommand, Row, format_table};
	use crate::host::run_proc;

	async fn lsof(argv: &[&str]) -> (i32, String, String) {
		let argv: Vec<&str> = std::iter::once("lsof").chain(argv.iter().copied()).collect();
		run_proc::<LsofCommand>(&argv, None).await
	}

	fn row(command: &str, fd: &str, access: char, kind: &str, device: &str, size_off: &str, node: &str, name: &str) -> Row {
		Row {
			command: command.to_owned(),
			pid: "22378".to_owned(),
			ppid: None,
			pgid: None,
			user: "can".to_owned(),
			fd: fd.to_owned(),
			access,
			lock: ' ',
			kind: kind.to_owned(),
			device: device.to_owned(),
			size_off: size_off.to_owned(),
			nlink: None,
			node: node.to_owned(),
			name: name.to_owned(),
		}
	}

	#[test]
	fn table_columns_match_lsof_layout() {
		// Rows and expected spacing taken from lsof 4.91 on macOS.
		let rows = [
			row("Python", "cwd", ' ', "DIR", "1,20", "139008", "590128367", "/private/tmp"),
			row("Python", "0", ' ', "PIPE", "0x32de42cd4fb524db", "16384", "", ""),
			row("Python", "3", 'u', "IPv4", "0xac2875d7c408476c", "0t0", "TCP", "localhost:65086 (LISTEN)"),
			row("Python", "1234", 'w', "REG", "1,20", "5", "681369699", "/private/tmp/lsoftest.txt"),
		];
		let mut out = String::new();
		format_table(&rows, &Columns { ppid: false, pgid: false, nlink: false, size_title: "SIZE/OFF" }, &mut out);
		assert_eq!(
			out,
			"COMMAND   PID USER   FD   TYPE             DEVICE SIZE/OFF      NODE NAME\n\
			 Python  22378  can  cwd    DIR               1,20   139008 590128367 /private/tmp\n\
			 Python  22378  can    0   PIPE 0x32de42cd4fb524db    16384           \n\
			 Python  22378  can    3u  IPv4 0xac2875d7c408476c      0t0       TCP localhost:65086 (LISTEN)\n\
			 Python  22378  can 1234w   REG               1,20        5 681369699 /private/tmp/lsoftest.txt\n"
		);
	}

	#[test]
	fn table_optional_columns_follow_pid() {
		let mut entry = row("Python", "1", 'w', "REG", "1,20", "12", "681369698", "/private/tmp/pyinfo");
		entry.ppid = Some("60130".to_owned());
		entry.pgid = Some("22378".to_owned());
		entry.nlink = Some("1".to_owned());
		let mut out = String::new();
		format_table(&[entry], &Columns { ppid: true, pgid: true, nlink: true, size_title: "SIZE/OFF" }, &mut out);
		assert_eq!(
			out,
			"COMMAND   PID  PPID  PGID USER   FD   TYPE DEVICE SIZE/OFF NLINK      NODE NAME\n\
			 Python  22378 60130 22378  can    1w   REG   1,20       12     1 681369698 /private/tmp/pyinfo\n"
		);
	}

	#[tokio::test]
	async fn illegal_option_is_a_usage_error() {
		let (code, out, err) = lsof(&["-Q"]).await;
		assert_eq!(code, 1);
		assert!(out.is_empty());
		assert_eq!(
			err,
			"lsof: illegal option character: Q\n\
			 lsof 4.91\n \
			 latest revision: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/\n \
			 latest FAQ: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/FAQ\n \
			 latest man page: ftp://lsof.itap.purdue.edu/pub/tools/unix/lsof/lsof_man\n \
			 usage: [-?abhlnNoOPRtUvVX] [+|-c c] [+|-d s] [+D D] [+|-f[cgG]]\n \
			 [-F [f]] [-g [s]] [-i [i]] [+|-L [l]] [+|-M] [-o [o]] [-p s]\n \
			 [+|-r [t]] [-s [p:s]] [-S [t]] [-T [t]] [-u s] [+|-w] [-x [fl]] [--] [names]\n\
			 Use the ``-h'' option to get more help information.\n"
		);
	}

	#[tokio::test]
	async fn mixed_fd_list_is_rejected() {
		let (code, _, err) = lsof(&["-d", "1,^2"]).await;
		assert_eq!(code, 1);
		assert!(err.starts_with("lsof: exclude in an include -d list: ^2\n"), "{err}");
		let (code, _, err) = lsof(&["-d", "7-3"]).await;
		assert_eq!(code, 1);
		assert!(err.starts_with("lsof: -d FD range's low >= its high: 7-3\n"), "{err}");
	}

	#[tokio::test]
	async fn bad_internet_addresses_are_usage_errors() {
		let (code, _, err) = lsof(&["-i", "xyz"]).await;
		assert_eq!(code, 1);
		assert!(err.starts_with("lsof: unknown protocol name (xyz) in: -i xyz\n"), "{err}");
		let (code, _, err) = lsof(&["-iTCP:"]).await;
		assert_eq!(code, 1);
		assert!(err.starts_with("lsof: unacceptable port specification in: -i TCP:\n"), "{err}");
	}

	#[tokio::test]
	async fn unknown_tcp_state_is_a_usage_error() {
		let (code, _, err) = lsof(&["-iTCP", "-sTCP:FOO"]).await;
		assert_eq!(code, 1);
		assert!(err.starts_with("lsof: unknown TCP state name: FOO\n"), "{err}");
	}

	#[tokio::test]
	async fn pid_both_included_and_excluded_is_rejected() {
		let (code, _, err) = lsof(&["-p", "5,^5"]).await;
		assert_eq!(code, 1);
		assert!(err.starts_with("lsof: PID 5 has been included and excluded.\n"), "{err}");
	}

	#[tokio::test]
	async fn missing_operand_is_a_status_error() {
		let (code, out, err) = lsof(&["/nonexistent/lsof-operand"]).await;
		assert_eq!(code, 1);
		assert!(out.is_empty());
		assert!(
			err.starts_with("lsof: status error on /nonexistent/lsof-operand: No such file or directory\n"),
			"{err}"
		);
	}

	#[tokio::test]
	async fn unmatched_pid_exits_one_and_reports_under_verbose() {
		let missing = i32::MAX.to_string();
		let (code, out, err) = lsof(&["-p", &missing]).await;
		assert_eq!((code, out.as_str(), err.as_str()), (1, "", ""));
		let (code, out, err) = lsof(&["-V", "-p", &missing]).await;
		assert_eq!(code, 1);
		assert!(out.is_empty());
		assert_eq!(err, format!("lsof: process ID not located: {missing}\n"));
	}

	#[tokio::test]
	async fn help_and_version_exit_zero() {
		let (code, _, err) = lsof(&["-h"]).await;
		assert_eq!(code, 0);
		assert!(err.contains("select by IPv[46] address"));
		let (code, _, err) = lsof(&["-v"]).await;
		assert_eq!(code, 0);
		assert!(err.starts_with("lsof version information:\n    revision: 4.91\n"));
	}

	#[cfg(unix)]
	mod unix {
		use std::{net::TcpListener, os::fd::AsRawFd};

		use super::lsof;

		fn own_pid() -> String {
			std::process::id().to_string()
		}

		#[tokio::test]
		async fn terse_listen_query_finds_the_listener() {
			let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
			let port = listener.local_addr().expect("address").port();
			let (code, out, _) = lsof(&[&format!("-iTCP:{port}"), "-sTCP:LISTEN", "-t"]).await;
			assert_eq!(code, 0);
			assert_eq!(out, format!("{}\n", own_pid()));
		}

		#[tokio::test]
		async fn numeric_row_shows_the_listening_address() {
			let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
			let port = listener.local_addr().expect("address").port();
			let fd = listener.as_raw_fd();
			let (code, out, _) = lsof(&[&format!("-nPiTCP:{port}"), "-a", "-p", &own_pid()]).await;
			assert_eq!(code, 0);
			let mut lines = out.lines();
			let header: Vec<&str> = lines.next().expect("header").split_whitespace().collect();
			assert_eq!(header, ["COMMAND", "PID", "USER", "FD", "TYPE", "DEVICE", "SIZE/OFF", "NODE", "NAME"]);
			let row = lines.next().expect("row");
			assert!(lines.next().is_none(), "{out}");
			let columns: Vec<&str> = row.split_whitespace().collect();
			assert_eq!(columns[1], own_pid());
			assert_eq!(columns[3], format!("{fd}u"));
			assert_eq!(columns[4], "IPv4");
			assert!(row.ends_with(&format!(" TCP 127.0.0.1:{port} (LISTEN)")), "{row}");
		}

		#[tokio::test]
		async fn field_output_reports_protocol_name_and_state() {
			let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
			let port = listener.local_addr().expect("address").port();
			let fd = listener.as_raw_fd();
			let (code, out, _) = lsof(&["-nP", &format!("-iTCP:{port}"), "-FPnT"]).await;
			assert_eq!(code, 0);
			let expected = format!("p{}\nf{fd}\nPTCP\nn127.0.0.1:{port}\nTST=LISTEN\n", own_pid());
			assert!(out.starts_with(&expected), "{out}");
		}

		#[tokio::test]
		async fn udp_socket_is_selected_by_protocol_and_port() {
			let socket = std::net::UdpSocket::bind("127.0.0.1:0").expect("bind");
			let port = socket.local_addr().expect("address").port();
			let fd = socket.as_raw_fd();
			let (code, out, _) = lsof(&["-nP", &format!("-iUDP:{port}"), "-Fn"]).await;
			assert_eq!(code, 0);
			assert_eq!(out, format!("p{}\nf{fd}\nn127.0.0.1:{port}\n", own_pid()));
		}

		#[tokio::test]
		async fn excluded_pid_hides_its_listener() {
			let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
			let port = listener.local_addr().expect("address").port();
			let (code, out, _) = lsof(&[&format!("-iTCP:{port}"), "-p", &format!("^{}", own_pid()), "-t"]).await;
			assert_eq!((code, out.as_str()), (1, ""));
		}

		#[tokio::test]
		async fn and_with_fd_cwd_shows_the_working_directory() {
			let cwd = std::env::current_dir().and_then(std::fs::canonicalize).expect("cwd");
			let (code, out, _) = lsof(&["-p", &own_pid(), "-a", "-d", "cwd", "-Fn"]).await;
			assert_eq!(code, 0);
			assert_eq!(out, format!("p{}\nfcwd\nn{}\n", own_pid(), cwd.display()));
			let (code, out, _) = lsof(&["-p", &own_pid(), "-a", "-d", "cwd"]).await;
			assert_eq!(code, 0);
			let row = out.lines().nth(1).expect("row");
			let columns: Vec<&str> = row.split_whitespace().collect();
			assert_eq!(&columns[3..5], ["cwd", "DIR"]);
			assert!(row.ends_with(&format!(" {}", cwd.display())), "{row}");
		}

		#[tokio::test]
		async fn file_operand_finds_the_holder() {
			let dir = tempfile::tempdir().expect("tempdir");
			let path = dir.path().join("held.txt");
			let file = std::fs::File::create(&path).expect("create");
			let canonical = std::fs::canonicalize(&path).expect("canonical");
			let path = path.to_str().expect("utf-8 path");
			let (code, out, _) = lsof(&["-Fn", path]).await;
			assert_eq!(code, 0);
			assert_eq!(out, format!("p{}\nf{}\nn{}\n", own_pid(), file.as_raw_fd(), canonical.display()));
			let (code, out, _) = lsof(&["+D", dir.path().to_str().expect("utf-8 dir"), "-t"]).await;
			assert_eq!((code, out), (0, format!("{}\n", own_pid())));
		}

		#[tokio::test]
		async fn link_count_below_one_finds_deleted_open_file() {
			let dir = tempfile::tempdir().expect("tempdir");
			let path = dir.path().join("deleted.txt");
			let file = std::fs::File::create(&path).expect("create");
			std::fs::remove_file(&path).expect("unlink");
			let (code, out, _) = lsof(&["-p", &own_pid(), "-a", "+L1", "-Fk"]).await;
			assert_eq!(code, 0);
			assert!(out.contains(&format!("\nf{}\nk0\n", file.as_raw_fd())), "{out}");
		}

		#[tokio::test]
		async fn command_prefix_and_exclusion() {
			let mut child = std::process::Command::new("sleep").arg("30").spawn().expect("spawn sleep");
			let pid = child.id().to_string();
			let (code, out, _) = lsof(&["-c", "slee", "-a", "-p", &pid, "-d", "cwd", "-t"]).await;
			let (excluded_code, excluded_out, _) = lsof(&["-c", "^sleep", "-a", "-p", &pid, "-d", "cwd", "-t"]).await;
			child.kill().expect("kill sleep");
			child.wait().expect("reap sleep");
			assert_eq!((code, out), (0, format!("{pid}\n")));
			assert_eq!((excluded_code, excluded_out.as_str()), (1, ""));
		}

		#[tokio::test]
		async fn user_selection_by_uid() {
			// SAFETY: geteuid has no preconditions.
			let uid = unsafe { libc::geteuid() }.to_string();
			let (code, out, _) = lsof(&["-u", &uid, "-a", "-p", &own_pid(), "-d", "cwd", "-t"]).await;
			assert_eq!((code, out), (0, format!("{}\n", own_pid())));
			let (code, out, _) = lsof(&["-u", &format!("^{uid}"), "-a", "-p", &own_pid(), "-t"]).await;
			assert_eq!((code, out.as_str()), (1, ""));
		}
	}
}
