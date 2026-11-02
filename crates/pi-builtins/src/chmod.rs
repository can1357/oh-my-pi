//! `chmod` builtin: change file mode bits.
//!
//! The tree walk is pre-order, with `-H`/`-L`/`-P` and tri-state `--dereference`.

use std::{
	ffi::{OsStr, OsString},
	io::{self, Write},
	os::unix::ffi::{OsStrExt, OsStringExt},
	path::Path,
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use pi_vfs::Metadata;
use uucore::{display::Quotable, fs::display_permissions_unix, mode};

use crate::host::{Host, Utility, format_usage, matches_parser, strip_errno, util};

/// Hidden long option carrying mode strings spelled as options (`-w`).
/// The leading control character keeps it out of long-option abbreviation.
const MODE_OPTION: &str = "\u{1}mode";

const MODE_BITS: u32 = 0o7777;
const S_IFMT: u32 = 0o170_000;
const S_IFDIR: u32 = 0o040_000;
const S_IFLNK: u32 = 0o120_000;

mod options {
	pub const CHANGES: &str = "changes";
	pub const DEREFERENCE: &str = "dereference";
	pub const NO_DEREFERENCE: &str = "no-dereference";
	pub const NO_PRESERVE_ROOT: &str = "no-preserve-root";
	pub const PRESERVE_ROOT: &str = "preserve-root";
	pub const QUIET: &str = "quiet";
	pub const RECURSIVE: &str = "recursive";
	pub const REFERENCE: &str = "reference";
	pub const VERBOSE: &str = "verbose";
	pub const HELP: &str = "help";
	pub const TRAVERSE_H: &str = "H";
	pub const TRAVERSE_L: &str = "L";
	pub const TRAVERSE_P: &str = "P";
	pub const MODE: &str = "MODE";
	pub const FILES: &str = "FILE";
}

/// Parsed `chmod` invocation.
pub(crate) struct Chmod {
	matches: ArgMatches,
}

matches_parser!(Chmod, app);

impl Utility for Chmod {
	const NAME: &'static str = "chmod";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(extract_negative_modes(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		run(&self.matches, host)
	}
}

fn app() -> Command {
	Command::new(Chmod::NAME)
		.version("9.8")
		.about("Change the mode of each FILE to MODE.\nWith --reference, change the mode of each FILE to that of RFILE.")
		.override_usage(format_usage(
			"chmod [OPTION]... MODE[,MODE]... FILE...\n  or:  chmod [OPTION]... OCTAL-MODE FILE...\n  or:  chmod [OPTION]... --reference=RFILE FILE...",
		))
		.after_help("Each MODE is of the form '[ugoa]*([-+=]([rwxXst]*|[ugo]))+|[-+=][0-7]+'.")
		.infer_long_args(true)
		.disable_help_flag(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("display this help and exit")
				.action(ArgAction::Help),
		)
		.arg(
			Arg::new(options::CHANGES)
				.short('c')
				.long(options::CHANGES)
				.help("like verbose but report only when a change is made")
				.overrides_with(options::VERBOSE)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::QUIET)
				.short('f')
				.long(options::QUIET)
				.visible_alias("silent")
				.help("suppress most error messages")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("output a diagnostic for every file processed")
				.overrides_with(options::CHANGES)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DEREFERENCE)
				.long(options::DEREFERENCE)
				.help("affect the referent of each symbolic link, rather than the symbolic link itself")
				.overrides_with(options::NO_DEREFERENCE)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE)
				.short('h')
				.long(options::NO_DEREFERENCE)
				.help("affect each symbolic link, rather than the referent")
				.overrides_with(options::DEREFERENCE)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_PRESERVE_ROOT)
				.long(options::NO_PRESERVE_ROOT)
				.help("do not treat '/' specially (the default)")
				.overrides_with(options::PRESERVE_ROOT)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PRESERVE_ROOT)
				.long(options::PRESERVE_ROOT)
				.help("fail to operate recursively on '/'")
				.overrides_with(options::NO_PRESERVE_ROOT)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REFERENCE)
				.long(options::REFERENCE)
				.value_name("RFILE")
				.value_parser(ValueParser::os_string())
				.help(
					"use RFILE's mode instead of specifying MODE values. RFILE is always \
					 dereferenced if a symbolic link.",
				),
		)
		.arg(
			Arg::new(options::RECURSIVE)
				.short('R')
				.long(options::RECURSIVE)
				.help("change files and directories recursively")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::TRAVERSE_H)
				.short('H')
				.help("if a command line argument is a symlink to a directory, traverse it")
				.overrides_with_all([options::TRAVERSE_L, options::TRAVERSE_P])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::TRAVERSE_L)
				.short('L')
				.help("traverse every symbolic link to a directory encountered")
				.overrides_with_all([options::TRAVERSE_H, options::TRAVERSE_P])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::TRAVERSE_P)
				.short('P')
				.help("do not traverse any symbolic links")
				.overrides_with_all([options::TRAVERSE_H, options::TRAVERSE_L])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(MODE_OPTION)
				.long(MODE_OPTION)
				.hide(true)
				.allow_hyphen_values(true)
				.value_parser(ValueParser::os_string()),
		)
		.arg(Arg::new(options::MODE).value_parser(ValueParser::os_string()))
		.arg(
			Arg::new(options::FILES)
				.action(ArgAction::Append)
				.num_args(1..)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath),
		)
}

/// uutils `extract_negative_modes`: before `--`, every argument spelled
/// `-r…`, `-w…`, `-x…`, `-X…`, `-s…`, `-t…`, `-u…`, `-g…`, `-o…`, or `-0…`–`-7…`
/// is a mode, as GNU's getopt string makes it; they join with `,` into one
/// hidden option.
fn extract_negative_modes(argv: Vec<OsString>) -> Vec<OsString> {
	let mut out = Vec::with_capacity(argv.len() + 1);
	let mut modes: Vec<&str> = Vec::new();
	let mut args = argv.iter();
	if let Some(name) = args.next() {
		out.push(name.clone());
	}
	for arg in args.by_ref() {
		if arg == "--" {
			out.push(arg.clone());
			break;
		}
		match arg.to_str() {
			Some(text)
				if text.len() >= 2
					&& text.starts_with('-')
					&& matches!(
						text.as_bytes()[1],
						b'r' | b'w' | b'x' | b'X' | b's' | b't' | b'u' | b'g' | b'o' | b'0'..=b'7'
					) =>
			{
				modes.push(text);
			},
			_ => out.push(arg.clone()),
		}
	}
	out.extend(args.cloned());
	if !modes.is_empty() {
		out.insert(1, OsString::from(format!("--{MODE_OPTION}={}", modes.join(","))));
	}
	out
}

/// Where the new mode comes from.
enum ModeSpec {
	/// A MODE operand, applied with `uucore::mode`.
	Mode(String),
	/// `--reference`: the referent's permission bits, set as-is.
	Reference(u32),
}

impl ModeSpec {
	fn apply(&self, old_mode: u32, dir: bool, umask: u32) -> u32 {
		match self {
			Self::Mode(mode) => mode::parse_chmod(old_mode & MODE_BITS, mode, dir, umask)
				.expect("validated by valid_mode"),
			Self::Reference(bits) => *bits,
		}
	}
}

/// Rejects what GNU's `mode_compile` rejects but `uucore::mode` accepts:
/// empty or space-padded comma parts (`u+x,`, ` 755`), which
/// `mode::parse_chmod` skips or trims.
fn valid_mode(mode: &str) -> bool {
	mode.split(',').all(|part| !part.is_empty() && part.trim() == part)
		&& mode::parse_chmod(0, mode, false, 0).is_ok()
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Status {
	NoStat,
	Failed,
	NotApplied,
	NoChangeRequested,
	Succeeded,
}

#[derive(PartialEq, Eq)]
enum Verbosity {
	High,
	ChangesOnly,
	Off,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Traversal {
	/// `-H`: follow command-line symlinks only (the default).
	CommandLine,
	/// `-L`.
	Logical,
	/// `-P`.
	Physical,
}

struct Config {
	spec:               ModeSpec,
	umask:              u32,
	recurse:            bool,
	/// 1 `--dereference`, 0 `--no-dereference`, -1 neither.
	dereference:        i8,
	force_silent:       bool,
	diagnose_surprises: bool,
	verbosity:          Verbosity,
	traversal:          Traversal,
	root:               Option<(u64, u64)>,
}

fn run(matches: &ArgMatches, host: &mut Host) -> i32 {
	let recurse = matches.get_flag(options::RECURSIVE);
	let traversal = if matches.get_flag(options::TRAVERSE_L) {
		Traversal::Logical
	} else if matches.get_flag(options::TRAVERSE_P) {
		Traversal::Physical
	} else {
		Traversal::CommandLine
	};
	let mut dereference: i8 = if matches.get_flag(options::DEREFERENCE) {
		1
	} else if matches.get_flag(options::NO_DEREFERENCE) {
		0
	} else {
		-1
	};
	// Without -R, fts runs with FTS_COMFOLLOW | FTS_PHYSICAL whatever was given.
	let traversal = if recurse { traversal } else { Traversal::CommandLine };
	if recurse && traversal == Traversal::Physical {
		if dereference == 1 {
			host.error("-R --dereference requires either -H or -L", 1);
			return 1;
		}
		dereference = 0;
	}
	if dereference == -1 && traversal == Traversal::Logical {
		dereference = 1;
	}

	let option_mode = matches.get_one::<OsString>(MODE_OPTION);
	let reference = matches.get_one::<OsString>(options::REFERENCE);
	let positional = matches.get_one::<OsString>(options::MODE);
	let mut files: Vec<&OsString> = matches.get_many::<OsString>(options::FILES).unwrap_or_default().collect();
	let mut positional_mode = None;
	if reference.is_some() && option_mode.is_some() {
		return host.usage_error("cannot combine mode and --reference options", 1);
	}
	// Like uutils: with `--reference` or an option-spelled mode, the MODE
	// operand is really the first FILE.
	if reference.is_some() || option_mode.is_some() {
		files.splice(0..0, positional);
	} else {
		positional_mode = positional;
	}
	if files.is_empty() {
		return match positional_mode {
			Some(mode) => host.usage_error(format_args!("missing operand after {}", mode.quote()), 1),
			None => host.usage_error("missing operand", 1),
		};
	}

	let mut umask = 0;
	let spec = if let Some(reference) = reference {
		match host.fs().metadata(host.resolve(reference)) {
			Ok(meta) => ModeSpec::Reference(meta.mode() & MODE_BITS),
			Err(error) => {
				host.error(
					format!("failed to get attributes of {}: {}", reference.quote(), strip_errno(&error)),
					1,
				);
				return 1;
			},
		}
	} else {
		let mode = option_mode.or(positional_mode).expect("mode present");
		match mode.to_str().filter(|mode| valid_mode(mode)) {
			Some(mode) => {
				umask = host.umask();
				ModeSpec::Mode(mode.to_owned())
			},
			None => return host.usage_error(format_args!("invalid mode: {}", mode.quote()), 1),
		}
	};

	let root = if recurse && matches.get_flag(options::PRESERVE_ROOT) {
		match host.fs().metadata(host.resolve("/")) {
			Ok(meta) => meta.dev().zip(meta.ino()),
			Err(error) => {
				host.error(format!("failed to get attributes of '/': {}", strip_errno(&error)), 1);
				return 1;
			},
		}
	} else {
		None
	};

	let config = Config {
		spec,
		umask,
		recurse,
		dereference,
		force_silent: matches.get_flag(options::QUIET),
		diagnose_surprises: option_mode.is_some(),
		verbosity: if matches.get_flag(options::VERBOSE) {
			Verbosity::High
		} else if matches.get_flag(options::CHANGES) {
			Verbosity::ChangesOnly
		} else {
			Verbosity::Off
		},
		traversal,
		root,
	};

	let mut ok = true;
	for file in files {
		if host.is_cancelled() {
			break;
		}
		let fs_path = host.resolve(file);
		let mut ancestors = Vec::new();
		ok &= visit(host, &config, file, &fs_path, 0, &mut ancestors);
	}
	i32::from(!ok)
}

/// The fts classification of one visited entry.
enum Info {
	Dir(Metadata),
	Cycle(Metadata),
	Other(Metadata),
	Symlink(Metadata),
	DanglingSymlink(Metadata),
	NoStat(io::Error),
}

fn identity(meta: &Metadata) -> Option<(u64, u64)> {
	meta.dev().zip(meta.ino())
}

fn classify(host: &Host, fs_path: &Path, follow: bool, ancestors: &[(u64, u64)]) -> Info {
	let dir_or_other = |meta: Metadata| {
		if meta.is_dir() {
			if identity(&meta).is_some_and(|id| ancestors.contains(&id)) {
				Info::Cycle(meta)
			} else {
				Info::Dir(meta)
			}
		} else {
			Info::Other(meta)
		}
	};
	if follow {
		match host.fs().metadata(fs_path) {
			Ok(meta) => dir_or_other(meta),
			Err(error) => match host.fs().symlink_metadata(fs_path) {
				Ok(link) if link.is_symlink() => Info::DanglingSymlink(link),
				_ => Info::NoStat(error),
			},
		}
	} else {
		match host.fs().symlink_metadata(fs_path) {
			Ok(meta) if meta.is_symlink() => Info::Symlink(meta),
			Ok(meta) => dir_or_other(meta),
			Err(error) => Info::NoStat(error),
		}
	}
}

fn child_display(parent: &OsStr, name: &OsStr) -> OsString {
	let mut bytes = parent.as_bytes().to_vec();
	if bytes.last() != Some(&b'/') {
		bytes.push(b'/');
	}
	bytes.extend_from_slice(name.as_bytes());
	OsString::from_vec(bytes)
}

/// Visits one entry the way GNU's fts loop does: pre-order, mode change
/// before the directory is read.
fn visit(
	host: &mut Host,
	config: &Config,
	display: &OsStr,
	fs_path: &Path,
	level: usize,
	ancestors: &mut Vec<(u64, u64)>,
) -> bool {
	let follow = config.traversal == Traversal::Logical
		|| (level == 0 && config.traversal == Traversal::CommandLine);
	let info = classify(host, fs_path, follow, ancestors);
	let descend_into = match &info {
		Info::Dir(meta) => Some(identity(meta)),
		_ => None,
	};
	let (mut ok, skip) = process(host, config, display, fs_path, level, info);
	let Some(id) = descend_into else { return ok };
	if !config.recurse || skip {
		return ok;
	}
	let entries = match host.fs().read_dir(fs_path) {
		Ok(entries) => entries,
		Err(error) => {
			if !config.force_silent {
				host.error(format!("cannot read directory {}: {}", display.quote(), strip_errno(&error)), 1);
			}
			describe_no_stat(host, config, display);
			return false;
		},
	};
	if let Some(id) = id {
		ancestors.push(id);
	}
	for entry in entries {
		if host.is_cancelled() {
			ok = false;
			break;
		}
		match entry {
			Ok(entry) => {
				let name = entry.file_name();
				let child = child_display(display, &name);
				ok &= visit(host, config, &child, &fs_path.join(&name), level + 1, ancestors);
			},
			Err(error) => {
				if !config.force_silent {
					host.error(format!("{}: {}", display.maybe_quote(), strip_errno(&error)), 1);
				}
				ok = false;
			},
		}
	}
	if id.is_some() {
		ancestors.pop();
	}
	ok
}

fn describe_no_stat(host: &mut Host, config: &Config, display: &OsStr) {
	if config.verbosity == Verbosity::High {
		let _ = writeln!(host.stdout, "{} could not be accessed", display.quote());
	}
}

/// GNU `process_file`. Returns `(ok, skip_subtree)`.
fn process(
	host: &mut Host,
	config: &Config,
	display: &OsStr,
	fs_path: &Path,
	level: usize,
	info: Info,
) -> (bool, bool) {
	let quoted = display.quote().to_string();
	let mut status = Status::NoStat;
	let mut stats = None;
	match info {
		Info::NoStat(error) => {
			if !config.force_silent {
				host.error(format!("cannot access {quoted}: {}", strip_errno(&error)), 1);
			}
		},
		Info::DanglingSymlink(meta) => {
			if config.dereference != 0 {
				if !config.force_silent {
					host.error(format!("cannot operate on dangling symlink {quoted}"), 1);
				}
			} else {
				status = Status::NotApplied;
				stats = Some(meta);
			}
		},
		Info::Symlink(meta) => {
			if config.dereference == 1 {
				match host.fs().metadata(fs_path) {
					Ok(target) => {
						status = Status::NotApplied;
						stats = Some(target);
					},
					Err(error) => {
						if !config.force_silent {
							host.error(format!("cannot dereference {quoted}: {}", strip_errno(&error)), 1);
						}
					},
				}
			} else {
				status = Status::NotApplied;
				stats = Some(meta);
			}
		},
		Info::Cycle(meta) => {
			if config.traversal != Traversal::Logical {
				host.error(
					format!(
						"WARNING: Circular directory structure.\nThis almost certainly means that you \
						 have a corrupted file system.\nNOTIFY YOUR SYSTEM MANAGER.\nThe following \
						 directory is part of the cycle:\n  {quoted}"
					),
					1,
				);
				return (false, true);
			}
			status = Status::NotApplied;
			stats = Some(meta);
		},
		Info::Dir(meta) | Info::Other(meta) => {
			status = Status::NotApplied;
			stats = Some(meta);
		},
	}

	if let (Some(root), Some(meta)) = (config.root, &stats)
		&& identity(meta) == Some(root)
	{
		if display.as_bytes() == b"/" {
			host.error("it is dangerous to operate recursively on '/'", 1);
		} else {
			host.error(format!("it is dangerous to operate recursively on {quoted} (same as '/')"), 1);
		}
		host.error("use --no-preserve-root to override this failsafe", 1);
		return (false, true);
	}

	let mut old_mode = 0;
	let mut new_mode = 0;
	if let Some(meta) = &stats {
		old_mode = meta.mode();
		new_mode = config.spec.apply(old_mode, old_mode & S_IFMT == S_IFDIR, config.umask);
		let follow_symlink = if config.dereference == -1 { level == 0 } else { config.dereference != 0 };
		// fchmodat(AT_SYMLINK_NOFOLLOW) on a symlink is ENOTSUP on Linux, which
		// GNU treats as "not applied"; the filesystem layer has no lchmod.
		if old_mode & S_IFMT != S_IFLNK || follow_symlink {
			match host.fs().set_permissions(fs_path, pi_vfs::Permissions::from_mode(new_mode)) {
				Ok(()) => status = Status::Succeeded,
				Err(error) => {
					if !config.force_silent {
						host.error(format!("changing permissions of {quoted}: {}", strip_errno(&error)), 1);
					}
					status = Status::Failed;
				},
			}
		}
	}

	if config.verbosity != Verbosity::Off {
		if status == Status::Succeeded && !mode_changed(host, config, fs_path, &quoted, old_mode, new_mode) {
			status = Status::NoChangeRequested;
		}
		if status == Status::Succeeded || config.verbosity == Verbosity::High {
			let (old_m, m) = (old_mode & MODE_BITS, new_mode & MODE_BITS);
			let line = match status {
				Status::NotApplied => {
					format!("neither symbolic link {quoted} nor referent has been changed")
				},
				Status::NoStat => format!("{quoted} could not be accessed"),
				Status::Succeeded => format!(
					"mode of {quoted} changed from {old_m:04o} ({}) to {m:04o} ({})",
					display_permissions_unix(old_mode, false),
					display_permissions_unix(new_mode, false)
				),
				Status::Failed => format!(
					"failed to change mode of {quoted} from {old_m:04o} ({}) to {m:04o} ({})",
					display_permissions_unix(old_mode, false),
					display_permissions_unix(new_mode, false)
				),
				Status::NoChangeRequested => {
					format!("mode of {quoted} retained as {m:04o} ({})", display_permissions_unix(new_mode, false))
				},
			};
			let _ = writeln!(host.stdout, "{line}");
		}
	}

	if status >= Status::NoChangeRequested && config.diagnose_surprises {
		let naive = config.spec.apply(old_mode, old_mode & S_IFMT == S_IFDIR, 0);
		if new_mode & !naive != 0 {
			host.error(
				format!(
					"{}: new permissions are {}, not {}",
					display.maybe_quote(),
					display_permissions_unix(new_mode, false),
					display_permissions_unix(naive, false)
				),
				1,
			);
			status = Status::Failed;
		}
	}

	(status >= Status::NotApplied, false)
}

/// GNU `mode_changed`: special bits may be silently dropped, so re-stat.
fn mode_changed(
	host: &mut Host,
	config: &Config,
	fs_path: &Path,
	quoted: &str,
	old_mode: u32,
	mut new_mode: u32,
) -> bool {
	if new_mode & 0o7000 != 0 {
		match host.fs().metadata(fs_path) {
			Ok(meta) => new_mode = meta.mode(),
			Err(error) => {
				if !config.force_silent {
					host.error(format!("getting new attributes of {quoted}: {}", strip_errno(&error)), 1);
				}
				return false;
			},
		}
	}
	(old_mode ^ new_mode) & MODE_BITS != 0
}

pub(crate) fn chmod_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Chmod, SE>()
}

#[cfg(test)]
mod tests {
	use std::{fs, os::unix::fs::PermissionsExt, path::Path};

	use uucore::display::Quotable;

	use super::Chmod;
	use crate::host::run_util;

	fn mode(path: &Path) -> u32 {
		fs::symlink_metadata(path).unwrap().permissions().mode() & 0o7777
	}

	fn set(path: &Path, mode: u32) {
		fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
	}

	fn fixture() -> tempfile::TempDir {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("f"), "").unwrap();
		set(&dir.path().join("f"), 0o664);
		fs::create_dir(dir.path().join("d")).unwrap();
		set(&dir.path().join("d"), 0o2775);
		fs::write(dir.path().join("d/x"), "").unwrap();
		set(&dir.path().join("d/x"), 0o666);
		std::os::unix::fs::symlink("nope", dir.path().join("d/dl")).unwrap();
		dir
	}

	fn chmod(dir: &Path, argv: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Chmod>(argv, "", dir);
		(code, capture.out(), capture.err())
	}

	#[test]
	fn octal_mode_keeps_directory_set_id_unless_five_digits() {
		let dir = fixture();
		assert_eq!(chmod(dir.path(), &["644", "f"]).0, 0);
		assert_eq!(mode(&dir.path().join("f")), 0o644);
		let (code, out, _) = chmod(dir.path(), &["-v", "0755", "d"]);
		assert_eq!((code, out.as_str()), (0, "mode of 'd' changed from 2775 (rwxrwsr-x) to 2755 (rwxr-sr-x)\n"));
		let (_, out, _) = chmod(dir.path(), &["-v", "00755", "d"]);
		assert_eq!(out, "mode of 'd' changed from 2755 (rwxr-sr-x) to 0755 (rwxr-xr-x)\n");
	}

	#[test]
	fn verbose_and_changes_reporting() {
		let dir = fixture();
		let (_, out, _) = chmod(dir.path(), &["-v", "u+x", "f"]);
		assert_eq!(out, "mode of 'f' changed from 0664 (rw-rw-r--) to 0764 (rwxrw-r--)\n");
		let (_, out, _) = chmod(dir.path(), &["-v", "u+x", "f"]);
		assert_eq!(out, "mode of 'f' retained as 0764 (rwxrw-r--)\n");
		let (_, out, _) = chmod(dir.path(), &["-c", "u+x", "f"]);
		assert_eq!(out, "");
	}

	#[test]
	fn symbolic_modes_follow_gnu_semantics() {
		let dir = fixture();
		chmod(dir.path(), &["u=g,o=u", "f"]);
		assert_eq!(mode(&dir.path().join("f")), 0o666);
		chmod(dir.path(), &["a=rX", "d", "f"]);
		assert_eq!(mode(&dir.path().join("d")), 0o2555);
		assert_eq!(mode(&dir.path().join("f")), 0o444);
		chmod(dir.path(), &["+t,g-s,u+w", "d"]);
		assert_eq!(mode(&dir.path().join("d")), 0o1755);
	}

	#[test]
	fn recursive_skips_symlinks_found_in_the_walk() {
		let dir = fixture();
		let (code, out, err) = chmod(dir.path(), &["-R", "-v", "go-w", "d"]);
		assert_eq!((code, err.as_str()), (0, ""));
		assert!(out.contains("neither symbolic link 'd/dl' nor referent has been changed\n"));
		assert_eq!(mode(&dir.path().join("d/x")), 0o644);
	}

	#[test]
	fn dangling_symlink_operand_is_an_error() {
		let dir = fixture();
		let (code, out, err) = chmod(dir.path(), &["-v", "755", "d/dl"]);
		assert_eq!(code, 1);
		assert_eq!(err, "chmod: cannot operate on dangling symlink 'd/dl'\n");
		assert_eq!(out, "'d/dl' could not be accessed\n");
	}

	#[test]
	fn option_spelled_mode_warns_about_umask_surprises() {
		let dir = fixture();
		let (code, _, err) = chmod(dir.path(), &["-w", "f"]);
		// The test process umask is 022 in CI and on developer machines.
		if crate::host::process_umask() == 0o022 {
			assert_eq!(code, 1);
			assert_eq!(err, "chmod: f: new permissions are r--rw-r--, not r--r--r--\n");
			assert_eq!(mode(&dir.path().join("f")), 0o464);
		}
		let (code, _, err) = chmod(dir.path(), &["-v", "--", "a-w", "f"]);
		assert_eq!((code, err.as_str()), (0, ""));
		assert_eq!(mode(&dir.path().join("f")), 0o444);
	}

	#[test]
	fn reference_copies_the_mode() {
		let dir = fixture();
		fs::write(dir.path().join("g"), "").unwrap();
		set(&dir.path().join("g"), 0o600);
		assert_eq!(chmod(dir.path(), &["--reference=f", "g"]).0, 0);
		assert_eq!(mode(&dir.path().join("g")), 0o664);
		let (code, _, err) = chmod(dir.path(), &["--reference=nope", "g"]);
		assert_eq!((code, err.as_str()), (1, "chmod: failed to get attributes of 'nope': No such file or directory\n"));
		let (code, _, err) = chmod(dir.path(), &["--reference=f", "-w", "g"]);
		assert_eq!(code, 1);
		assert_eq!(err, "chmod: cannot combine mode and --reference options\nTry 'chmod --help' for more information.\n");
	}

	#[test]
	fn usage_and_access_errors() {
		let dir = fixture();
		let try_help = "Try 'chmod --help' for more information.\n";
		assert_eq!(chmod(dir.path(), &["999", "f"]), (1, String::new(), format!("chmod: invalid mode: '999'\n{try_help}")));
		assert_eq!(chmod(dir.path(), &["u+7", "f"]).2, format!("chmod: invalid mode: 'u+7'\n{try_help}"));
		// GNU rejects these; `uucore::mode` alone would accept them.
		for mode in ["u+x,", ",u+x", " 755"] {
			assert_eq!(chmod(dir.path(), &[mode, "f"]).2, format!("chmod: invalid mode: {}\n{try_help}", mode.quote()));
		}
		assert_eq!(mode(&dir.path().join("f")), 0o664);
		assert_eq!(chmod(dir.path(), &["+x"]).2, format!("chmod: missing operand after '+x'\n{try_help}"));
		assert_eq!(chmod(dir.path(), &["-w"]).2, format!("chmod: missing operand\n{try_help}"));
		assert_eq!(
			chmod(dir.path(), &["u+x", "missing"]),
			(1, String::new(), "chmod: cannot access 'missing': No such file or directory\n".into())
		);
		assert_eq!(chmod(dir.path(), &["-f", "u+x", "missing"]), (1, String::new(), String::new()));
		assert_eq!(
			chmod(dir.path(), &["-R", "-P", "--dereference", "1", "f"]).2,
			"chmod: -R --dereference requires either -H or -L\n"
		);
	}

	#[test]
	fn preserve_root_refuses_recursion_on_root() {
		let dir = fixture();
		std::os::unix::fs::symlink("/", dir.path().join("root")).unwrap();
		let (code, out, err) = chmod(dir.path(), &["-R", "--preserve-root", "755", "/"]);
		assert_eq!((code, out.as_str()), (1, ""));
		assert_eq!(
			err,
			"chmod: it is dangerous to operate recursively on '/'\nchmod: use --no-preserve-root to override this failsafe\n"
		);
		let (code, _, err) = chmod(dir.path(), &["-R", "--preserve-root", "755", "root"]);
		assert_eq!(code, 1);
		assert!(err.starts_with("chmod: it is dangerous to operate recursively on 'root' (same as '/')\n"));
	}
}
