//! `cp` builtin: copy files and directories.
//!
//! Ported from uutils coreutils 0.8.0.
//!
//! Every filesystem access goes through the shell's [`BlockingFs`], so
//! `scheme://` paths work as sources and destinations. Kernel fast paths
//! (`FICLONE`, `copy_file_range`, `SEEK_DATA` sparse copies, `clonefile`)
//! only run when both ends are native host files; other pairs stream through
//! the provider's handles. Diagnostics follow GNU cp.

use std::{
	cmp::Ordering,
	ffi::OsString,
	fmt,
	io::{self, Read, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, value_parser};
use indicatif::{ProgressBar, ProgressStyle};
use pi_vfs::{
	BlockingFs, CanonicalizeOptions, DirOptions, File, FileId, FileTime, Metadata, MissingHandling,
	NodeKind, OpenOptions, Permissions, ResolveMode, child_path, decode_segment, file_name,
	is_virtual_path, join_path, normalize_lexically, parent_path, url_scheme,
};
use rustc_hash::{FxHashMap, FxHashSet};
use thiserror::Error;
use uucore::{
	backup_control::{self, BackupMode},
	display::Quotable,
	fs::path_ends_with_terminator,
	parser::shortcut_value_parser::ShortcutValueParser,
	update_control::{self, UpdateMode},
};

use crate::{
	file_backup::{backup_display, backup_path, determine_backup_mode, determine_backup_suffix},
	host::{Host, Utility, format_usage, matches_parser, util},
	progress::stderr_draw_target,
};

/// Failure of one copy step.
#[derive(Debug, Error)]
enum CpError {
	/// A bare I/O failure.
	#[error("{}", strip_errno(.0))]
	IoErr(#[from] io::Error),

	/// An I/O failure with the operation it interrupted (`context: strerror`).
	#[error("{}: {}", .1, strip_errno(.0))]
	IoErrContext(io::Error, String),

	/// A complete diagnostic.
	#[error("{0}")]
	Error(String),

	/// A usage diagnostic, followed by GNU's pointer to `--help`.
	#[error("{0}\nTry 'cp --help' for more information.")]
	Usage(String),

	/// Some files were not copied; their diagnostics are already printed.
	#[error("")]
	NotAllFilesCopied,

	/// A destination was left alone (`-n`, a declined `-i` prompt, ...);
	/// `true` makes the skip fail the run.
	#[error("")]
	Skipped(bool),
}

type CopyResult<T> = Result<T, CpError>;

/// Renders an I/O error like `strerror`, without Rust's ` (os error N)`.
fn strip_errno(error: &io::Error) -> String {
	let mut message = error.to_string();
	if let Some(position) = message.find(" (os error ") {
		message.truncate(position);
	}
	message
}

/// `ENOTSUP`-style failure for operations a filesystem cannot perform.
fn operation_not_supported() -> io::Error {
	io::Error::new(io::ErrorKind::Unsupported, "Operation not supported")
}

/// Specifies how to overwrite files.
#[derive(Debug, Clone, Copy, Eq, PartialEq, Default)]
enum ClobberMode {
	Force,
	RemoveDestination,
	#[default]
	Standard,
}

/// Specifies whether files should be overwritten.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
enum OverwriteMode {
	/// [Default] Always overwrite existing files
	Clobber(ClobberMode),
	/// Prompt before overwriting a file
	Interactive(ClobberMode),
	/// Never overwrite a file
	NoClobber,
}

/// Possible arguments for `--reflink`.
#[derive(Debug, Copy, Clone, Eq, PartialEq)]
enum ReflinkMode {
	Always,
	Auto,
	Never,
}

impl Default for ReflinkMode {
	fn default() -> Self {
		if cfg!(any(target_os = "linux", target_os = "android", target_os = "macos")) {
			Self::Auto
		} else {
			Self::Never
		}
	}
}

/// Possible arguments for `--sparse`.
#[derive(Debug, Copy, Clone, Eq, PartialEq, Default)]
enum SparseMode {
	Always,
	#[default]
	Auto,
	Never,
}

/// The expected file type of copy target
#[derive(Copy, Clone)]
enum TargetType {
	Directory,
	File,
}

/// Copy action to perform
#[derive(Debug, Clone, Copy, Eq, PartialEq, Default)]
enum CopyMode {
	Link,
	SymLink,
	#[default]
	Copy,
	Update,
	AttrOnly,
}

/// Preservation settings for various attributes
///
/// It should be derived from options as follows:
///
///  - if there is a list of attributes to preserve (i.e.
///    `--preserve=ATTR_LIST`) parse that list with [`Attributes::parse_iter`],
///  - if `-p` or `--preserve` is given without arguments, use
///    [`Attributes::DEFAULT`],
///  - if `-a`/`--archive` is passed, use [`Attributes::ALL`],
///  - if `-d` is passed use [`Attributes::LINKS`],
///  - otherwise, use [`Attributes::NONE`].
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
struct Attributes {
	ownership:  Preserve,
	mode:       Preserve,
	timestamps: Preserve,
	context:    Preserve,
	links:      Preserve,
	xattr:      Preserve,
}

/// Whether one attribute is preserved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Preserve {
	/// Not preserved; `explicit` when `--no-preserve` named it (e.g.
	/// `--no-preserve=mode` means `mode = No { explicit: true }`).
	No { explicit: bool },
	/// Preserved; failing to preserve is fatal when `required`.
	Yes { required: bool },
}

impl PartialOrd for Preserve {
	fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
		Some(self.cmp(other))
	}
}

impl Ord for Preserve {
	fn cmp(&self, other: &Self) -> Ordering {
		match (self, other) {
			(Self::No { .. }, Self::No { .. }) => Ordering::Equal,
			(Self::Yes { .. }, Self::No { .. }) => Ordering::Greater,
			(Self::No { .. }, Self::Yes { .. }) => Ordering::Less,
			(Self::Yes { required: req_self }, Self::Yes { required: req_other }) => {
				req_self.cmp(req_other)
			},
		}
	}
}

/// Options for the `cp` command, documented with the arguments that
/// determine their value.
#[derive(Debug)]
struct Options {
	/// `--attributes-only`
	attributes_only:        bool,
	/// `--backup[=CONTROL]`, `-b`
	backup:                 BackupMode,
	/// `--copy-contents`
	copy_contents:          bool,
	/// `-H`
	cli_dereference:        bool,
	/// `-l`, `-s`, `-u`, `--attributes-only`, or a plain copy.
	copy_mode:              CopyMode,
	/// `-L`, `--dereference`
	dereference:            bool,
	/// `-T`, `--no-target-dir`
	no_target_dir:          bool,
	/// `-x`, `--one-file-system`
	one_file_system:        bool,
	/// `-i`/`-n` with `-f`/`--remove-destination`.
	overwrite:              OverwriteMode,
	/// `--parents`
	parents:                bool,
	/// `--sparse[=WHEN]`
	sparse_mode:            SparseMode,
	/// `--strip-trailing-slashes`
	strip_trailing_slashes: bool,
	/// `--reflink[=WHEN]`
	reflink_mode:           ReflinkMode,
	/// `--preserve=[=ATTRIBUTE_LIST]` and `--no-preserve=ATTRIBUTE_LIST`
	attributes:             Attributes,
	/// `-R`, `-r`, `--recursive`
	recursive:              bool,
	/// `-S`, `--suffix`
	backup_suffix:          String,
	/// `-t`, `--target-directory`
	target_dir:             Option<PathBuf>,
	/// `--update[=UPDATE]`
	update:                 UpdateMode,
	/// `--debug`
	debug:                  bool,
	/// `-v`, `--verbose`
	verbose:                bool,
	/// `-g`, `--progress`
	progress_bar:           bool,
	/// `-Z`, `--context`: never copy the source's SELinux label.
	set_selinux_context:    bool,
}

/// Debug states of the offload and reflink actions.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(
	not(any(target_os = "linux", target_os = "android", target_os = "macos")),
	allow(dead_code, reason = "only the Linux and macOS fast paths report offloads")
)]
enum OffloadReflinkDebug {
	Unknown,
	No,
	Yes,
	Avoided,
	Unsupported,
}

/// Debug states of the sparse detection.
#[derive(Debug, Clone, Copy)]
#[cfg_attr(
	not(any(target_os = "linux", target_os = "android")),
	allow(dead_code, reason = "only the Linux fast paths detect holes")
)]
enum SparseDebug {
	No,
	Zeros,
	SeekHole,
	SeekHoleZeros,
	Unsupported,
}

/// How one file's data was copied, for `--debug`.
#[derive(Debug)]
struct CopyDebug {
	offload:          OffloadReflinkDebug,
	reflink:          OffloadReflinkDebug,
	sparse_detection: SparseDebug,
}

impl CopyDebug {
	/// A copy that streamed through read and write calls.
	const STREAMED: Self = Self {
		offload:          OffloadReflinkDebug::Unsupported,
		reflink:          OffloadReflinkDebug::Unsupported,
		sparse_detection: SparseDebug::Unsupported,
	};
}

impl fmt::Display for OffloadReflinkDebug {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(match self {
			Self::No => "no",
			Self::Yes => "yes",
			Self::Avoided => "avoided",
			Self::Unsupported => "unsupported",
			Self::Unknown => "unknown",
		})
	}
}

impl fmt::Display for SparseDebug {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str(match self {
			Self::No => "no",
			Self::Zeros => "zeros",
			Self::SeekHole => "SEEK_HOLE",
			Self::SeekHoleZeros => "SEEK_HOLE + zeros",
			Self::Unsupported => "unsupported",
		})
	}
}

impl fmt::Display for CopyDebug {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(
			f,
			"copy offload: {}, reflink: {}, sparse detection: {}",
			self.offload, self.reflink, self.sparse_detection
		)
	}
}

// Argument constants
mod options {
	pub const ARCHIVE: &str = "archive";
	pub const ATTRIBUTES_ONLY: &str = "attributes-only";
	pub const CLI_SYMBOLIC_LINKS: &str = "cli-symbolic-links";
	pub const CONTEXT: &str = "context";
	pub const COPY_CONTENTS: &str = "copy-contents";
	pub const DEREFERENCE: &str = "dereference";
	pub const FORCE: &str = "force";
	pub const INTERACTIVE: &str = "interactive";
	pub const LINK: &str = "link";
	pub const NO_CLOBBER: &str = "no-clobber";
	pub const NO_DEREFERENCE: &str = "no-dereference";
	pub const NO_DEREFERENCE_PRESERVE_LINKS: &str = "no-dereference-preserve-links";
	pub const NO_PRESERVE: &str = "no-preserve";
	pub const NO_TARGET_DIRECTORY: &str = "no-target-directory";
	pub const ONE_FILE_SYSTEM: &str = "one-file-system";
	pub const PARENT: &str = "parent";
	pub const PARENTS: &str = "parents";
	pub const PATHS: &str = "paths";
	pub const PROGRESS_BAR: &str = "progress";
	pub const PRESERVE: &str = "preserve";
	pub const PRESERVE_DEFAULT_ATTRIBUTES: &str = "preserve-default-attributes";
	pub const RECURSIVE: &str = "recursive";
	pub const REFLINK: &str = "reflink";
	pub const REMOVE_DESTINATION: &str = "remove-destination";
	pub const SELINUX: &str = "Z";
	pub const SPARSE: &str = "sparse";
	pub const STRIP_TRAILING_SLASHES: &str = "strip-trailing-slashes";
	pub const SYMBOLIC_LINK: &str = "symbolic-link";
	pub const TARGET_DIRECTORY: &str = "target-directory";
	pub const DEBUG: &str = "debug";
	pub const VERBOSE: &str = "verbose";
}

#[cfg(unix)]
static PRESERVABLE_ATTRIBUTES: &[&str] =
	&["mode", "ownership", "timestamps", "context", "links", "xattr", "all"];

#[cfg(not(unix))]
static PRESERVABLE_ATTRIBUTES: &[&str] = &["mode", "timestamps", "context", "links", "xattr", "all"];

const PRESERVE_DEFAULT_VALUES: &str =
	if cfg!(unix) { "mode,ownership,timestamp" } else { "mode,timestamp" };

/// Chunk size of streamed copies.
const COPY_BUFFER: usize = 128 * 1024;

/// Parsed `cp` invocation.
pub(crate) struct Cp {
	matches: ArgMatches,
}

matches_parser!(Cp, uu_app);

impl Utility for Cp {
	const NAME: &'static str = "cp";

	fn run(self, host: &mut Host) -> i32 {
		match cp_main(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(CpError::NotAllFilesCopied) => 1,
			Err(error) => {
				show_error(host, &error);
				1
			},
		}
	}
}

/// Creates the `cp` builtin registration.
pub(crate) fn cp_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Cp, SE>()
}

/// Writes `cp: <message>` to stderr. Exit status is decided by the caller.
fn show_error(host: &mut Host, message: impl fmt::Display) {
	let _ = writeln!(host.stderr, "{}: {message}", Cp::NAME);
}

/// Writes `cp: warning: <message>` to stderr.
fn show_warning(host: &mut Host, message: impl fmt::Display) {
	let _ = writeln!(host.stderr, "{}: warning: {message}", Cp::NAME);
}

fn uu_app() -> Command {
	const MODE_ARGS: &[&str] = &[
		options::LINK,
		options::REFLINK,
		options::SYMBOLIC_LINK,
		options::ATTRIBUTES_ONLY,
		options::COPY_CONTENTS,
	];
	Command::new("cp")
		.version("0.8.0")
		.about("Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.")
		.override_usage(format_usage(
			"cp [OPTION]... [-T] SOURCE DEST\ncp [OPTION]... SOURCE... DIRECTORY\ncp [OPTION]... -t \
			 DIRECTORY SOURCE...",
		))
		.after_help(format!(
			"{}\n\n{}",
			"Do not copy a non-directory that has an existing destination with the same or newer \
			 modification timestamp;\ninstead, silently skip the file without failing. If \
			 timestamps are being preserved, the comparison is to the\nsource timestamp truncated \
			 to the resolutions of the destination file system and of the system calls used \
			 to\nupdate timestamps; this avoids duplicate work if several cp -pu commands are \
			 executed with the same source\nand destination. This option is ignored if the -n or \
			 --no-clobber option is also specified. Also, if\n--preserve=links is also specified \
			 (like with cp -au for example), that will take precedence; consequently,\ndepending \
			 on the order that files are processed from the source, newer files in the \
			 destination may be replaced,\nto mirror hard links in the source. which gives more \
			 control over which existing files in the destination are\nreplaced, and its value \
			 can be one of the following:\n\n- all This is the default operation when an \
			 --update option is not specified, and results in all existing files in the \
			 destination being replaced.\n- none This is similar to the --no-clobber option, in \
			 that no files in the destination are replaced, but also skipping a file does not \
			 induce a failure.\n- older This is the default operation when --update is \
			 specified, and results in files being replaced if they're older than the \
			 corresponding source file.",
			backup_control::BACKUP_CONTROL_LONG_HELP
		))
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::TARGET_DIRECTORY)
				.short('t')
				.conflicts_with(options::NO_TARGET_DIRECTORY)
				.long(options::TARGET_DIRECTORY)
				.value_name(options::TARGET_DIRECTORY)
				.value_hint(clap::ValueHint::DirPath)
				.value_parser(ValueParser::path_buf())
				.help("copy all SOURCE arguments into target-directory"),
		)
		.arg(
			Arg::new(options::NO_TARGET_DIRECTORY)
				.short('T')
				.long(options::NO_TARGET_DIRECTORY)
				.conflicts_with(options::TARGET_DIRECTORY)
				.help("Treat DEST as a regular file and not a directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::INTERACTIVE)
				.short('i')
				.long(options::INTERACTIVE)
				.overrides_with(options::NO_CLOBBER)
				.help("ask before overwriting files")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::LINK)
				.short('l')
				.long(options::LINK)
				.overrides_with_all(MODE_ARGS)
				.help("hard-link files instead of copying")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_CLOBBER)
				.short('n')
				.long(options::NO_CLOBBER)
				.overrides_with(options::INTERACTIVE)
				.help("don't overwrite a file that already exists")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::RECURSIVE)
				.short('R')
				.visible_short_alias('r')
				.long(options::RECURSIVE)
				// --archive sets this option
				.help("copy directories recursively")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::STRIP_TRAILING_SLASHES)
				.long(options::STRIP_TRAILING_SLASHES)
				.help("remove any trailing slashes from each SOURCE argument")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DEBUG)
				.long(options::DEBUG)
				.help("explain how a file is copied. Implies -v")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("explicitly state what is being done")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SYMBOLIC_LINK)
				.short('s')
				.long(options::SYMBOLIC_LINK)
				.overrides_with_all(MODE_ARGS)
				.help("make symbolic links instead of copying")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::FORCE)
				.short('f')
				.long(options::FORCE)
				.help(
					"if an existing destination file cannot be opened, remove it and try again (this \
					 option is ignored when the -n option is also used).",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REMOVE_DESTINATION)
				.long(options::REMOVE_DESTINATION)
				.overrides_with(options::FORCE)
				.help(
					"remove each existing destination file before attempting to open it (contrast \
					 with --force).",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(backup_control::arguments::backup())
		.arg(backup_control::arguments::backup_no_args())
		.arg(backup_control::arguments::suffix())
		.arg(update_control::arguments::update())
		.arg(update_control::arguments::update_no_args())
		.arg(
			Arg::new(options::REFLINK)
				.long(options::REFLINK)
				.value_name("WHEN")
				.overrides_with_all(MODE_ARGS)
				.require_equals(true)
				.default_missing_value("always")
				.value_parser(ShortcutValueParser::new(["auto", "always", "never"]))
				.num_args(0..=1)
				.help("control clone/CoW copies. See below"),
		)
		.arg(
			Arg::new(options::ATTRIBUTES_ONLY)
				.long(options::ATTRIBUTES_ONLY)
				.overrides_with_all(MODE_ARGS)
				.help("Don't copy the file data, just the attributes")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PRESERVE)
				.long(options::PRESERVE)
				.action(ArgAction::Append)
				.use_value_delimiter(true)
				.value_parser(ShortcutValueParser::new(PRESERVABLE_ATTRIBUTES))
				.num_args(0..)
				.require_equals(true)
				.value_name("ATTR_LIST")
				.default_missing_value(PRESERVE_DEFAULT_VALUES)
				// -d sets this option
				// --archive sets this option
				.help(
					"Preserve the specified attributes (default: mode, ownership (unix only), \
					 timestamps), if possible additional attributes: context, links, xattr, all",
				),
		)
		.arg(
			Arg::new(options::PRESERVE_DEFAULT_ATTRIBUTES)
				.short('p')
				.long(options::PRESERVE_DEFAULT_ATTRIBUTES)
				.help("same as --preserve=mode,ownership(unix only),timestamps")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_PRESERVE)
				.long(options::NO_PRESERVE)
				.action(ArgAction::Append)
				.use_value_delimiter(true)
				.value_parser(ShortcutValueParser::new(PRESERVABLE_ATTRIBUTES))
				.num_args(0..)
				.require_equals(true)
				.value_name("ATTR_LIST")
				.help("don't preserve the specified attributes"),
		)
		.arg(
			Arg::new(options::PARENTS)
				.long(options::PARENTS)
				.alias(options::PARENT)
				.help("use full source file name under DIRECTORY")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE)
				.short('P')
				.long(options::NO_DEREFERENCE)
				.overrides_with_all([
					options::DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::ARCHIVE,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				// -d sets this option
				.help("never follow symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DEREFERENCE)
				.short('L')
				.long(options::DEREFERENCE)
				.overrides_with_all([
					options::NO_DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::ARCHIVE,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				.help("always follow symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CLI_SYMBOLIC_LINKS)
				.short('H')
				.overrides_with_all([
					options::DEREFERENCE,
					options::NO_DEREFERENCE,
					options::ARCHIVE,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				.help("follow command-line symbolic links in SOURCE")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ARCHIVE)
				.short('a')
				.long(options::ARCHIVE)
				.overrides_with_all([
					options::DEREFERENCE,
					options::NO_DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::NO_DEREFERENCE_PRESERVE_LINKS,
				])
				.help("Same as -dR --preserve=all")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE_PRESERVE_LINKS)
				.short('d')
				.overrides_with_all([
					options::DEREFERENCE,
					options::NO_DEREFERENCE,
					options::CLI_SYMBOLIC_LINKS,
					options::ARCHIVE,
				])
				.help("same as --no-dereference --preserve=links")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ONE_FILE_SYSTEM)
				.short('x')
				.long(options::ONE_FILE_SYSTEM)
				.help("stay on this file system")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SPARSE)
				.long(options::SPARSE)
				.value_name("WHEN")
				.value_parser(ShortcutValueParser::new(["never", "auto", "always"]))
				.help("control creation of sparse files. See below"),
		)
		.arg(
			Arg::new(options::SELINUX)
				.short('Z')
				.help("set SELinux security context of destination file to default type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CONTEXT)
				.long(options::CONTEXT)
				.value_name("CTX")
				.value_parser(value_parser!(String))
				.help(
					"like -Z, or if CTX is specified then set the SELinux or SMACK security context \
					 to CTX",
				)
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value(""),
		)
		.arg(
			// The 'g' short flag is modeled after advcpmv
			// See this repo: https://github.com/jarun/advcpmv
			Arg::new(options::PROGRESS_BAR)
				.long(options::PROGRESS_BAR)
				.short('g')
				.action(ArgAction::SetTrue)
				.help("Display a progress bar. Note: this feature is not supported by GNU coreutils."),
		)
		.arg(
			Arg::new(options::COPY_CONTENTS)
				.long(options::COPY_CONTENTS)
				.overrides_with(options::ATTRIBUTES_ONLY)
				.help("copy contents of special files when recursive")
				.action(ArgAction::SetTrue),
		)
		.arg(
			// Optional so a missing operand gets GNU's diagnostic, not clap's.
			Arg::new(options::PATHS)
				.action(ArgAction::Append)
				.num_args(1..)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(ValueParser::os_string()),
		)
}

fn cp_main(matches: &ArgMatches, host: &mut Host) -> CopyResult<()> {
	let options = Options::from_matches(matches, host)?;

	if options.overwrite == OverwriteMode::NoClobber && options.backup != BackupMode::None {
		return Err(CpError::Usage(
			"--backup is mutually exclusive with -n or --update=none-fail".to_string(),
		));
	}

	let paths: Vec<PathBuf> = matches
		.get_many::<OsString>(options::PATHS)
		.map(|values| values.map(PathBuf::from).collect())
		.unwrap_or_default();

	let (sources, target) = parse_path_args(paths, &options)?;
	if let Some(dir) = &options.target_dir {
		check_target_directory(host, dir)?;
	}

	copy(host, &sources, &target, &options)
}

impl ClobberMode {
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag(options::FORCE) {
			Self::Force
		} else if matches.get_flag(options::REMOVE_DESTINATION) {
			Self::RemoveDestination
		} else {
			Self::Standard
		}
	}
}

impl OverwriteMode {
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag(options::INTERACTIVE) {
			Self::Interactive(ClobberMode::from_matches(matches))
		} else if matches.get_flag(options::NO_CLOBBER) {
			Self::NoClobber
		} else {
			Self::Clobber(ClobberMode::from_matches(matches))
		}
	}
}

impl CopyMode {
	fn from_matches(matches: &ArgMatches) -> Self {
		if matches.get_flag(options::LINK) {
			Self::Link
		} else if matches.get_flag(options::SYMBOLIC_LINK) {
			Self::SymLink
		} else if matches
			.get_one::<String>(update_control::arguments::OPT_UPDATE)
			.is_some()
			|| matches.get_flag(update_control::arguments::OPT_UPDATE_NO_ARG)
		{
			Self::Update
		} else if matches.get_flag(options::ATTRIBUTES_ONLY) {
			if matches.get_flag(options::REMOVE_DESTINATION) { Self::Copy } else { Self::AttrOnly }
		} else {
			Self::Copy
		}
	}
}

impl Attributes {
	/// `--preserve=all` / `-a`. Without SELinux support there is no context
	/// to preserve.
	const ALL: Self = Self {
		ownership:  Preserve::Yes { required: true },
		mode:       Preserve::Yes { required: true },
		timestamps: Preserve::Yes { required: true },
		context:    Preserve::No { explicit: false },
		links:      Preserve::Yes { required: true },
		xattr:      Preserve::Yes { required: false },
	};
	/// `-p`: GNU's `--preserve=mode,ownership,timestamps`.
	const DEFAULT: Self = Self {
		ownership: Preserve::Yes { required: true },
		mode: Preserve::Yes { required: true },
		timestamps: Preserve::Yes { required: true },
		..Self::NONE
	};
	/// `-d`.
	const LINKS: Self = Self { links: Preserve::Yes { required: true }, ..Self::NONE };
	/// Nothing preserved.
	const NONE: Self = Self {
		ownership:  Preserve::No { explicit: false },
		mode:       Preserve::No { explicit: false },
		timestamps: Preserve::No { explicit: false },
		context:    Preserve::No { explicit: false },
		links:      Preserve::No { explicit: false },
		xattr:      Preserve::No { explicit: false },
	};

	fn union(self, other: &Self) -> Self {
		Self {
			ownership:  self.ownership.max(other.ownership),
			context:    self.context.max(other.context),
			timestamps: self.timestamps.max(other.timestamps),
			mode:       self.mode.max(other.mode),
			links:      self.links.max(other.links),
			xattr:      self.xattr.max(other.xattr),
		}
	}

	/// Set the field to `Preserve::No { explicit: true }` if the corresponding
	/// field in other is set to `Preserve::Yes { .. }`.
	fn diff(self, other: &Self) -> Self {
		fn update_preserve_field(current: Preserve, other: Preserve) -> Preserve {
			if matches!(other, Preserve::Yes { .. }) { Preserve::No { explicit: true } } else { current }
		}
		Self {
			ownership:  update_preserve_field(self.ownership, other.ownership),
			mode:       update_preserve_field(self.mode, other.mode),
			timestamps: update_preserve_field(self.timestamps, other.timestamps),
			context:    update_preserve_field(self.context, other.context),
			links:      update_preserve_field(self.links, other.links),
			xattr:      update_preserve_field(self.xattr, other.xattr),
		}
	}

	fn parse_iter<T: AsRef<str>>(values: impl Iterator<Item = T>) -> CopyResult<Self> {
		let mut new = Self::NONE;
		for value in values {
			new = new.union(&Self::parse_single_string(value.as_ref())?);
		}
		Ok(new)
	}

	/// Tries to match string containing a parameter to preserve with the
	/// corresponding entry in the Attributes struct.
	fn parse_single_string(value: &str) -> CopyResult<Self> {
		let value = value.to_lowercase();

		if value == "all" {
			return Ok(Self::ALL);
		}

		let mut new = Self::NONE;
		let attribute = match value.as_ref() {
			"mode" => &mut new.mode,
			"ownership" => &mut new.ownership,
			"timestamps" => &mut new.timestamps,
			"context" => &mut new.context,
			"link" | "links" => &mut new.links,
			"xattr" => &mut new.xattr,
			_ => {
				return Err(CpError::Usage(format!("invalid attribute {}", value.quote())));
			},
		};

		*attribute = Preserve::Yes { required: true };

		Ok(new)
	}
}

impl Options {
	fn from_matches(matches: &ArgMatches, host: &mut Host) -> CopyResult<Self> {
		let recursive = matches.get_flag(options::RECURSIVE) || matches.get_flag(options::ARCHIVE);

		let backup_mode = determine_backup_mode(matches, host).map_err(CpError::Usage)?;
		let update_mode = update_control::determine_update_mode(matches);

		if backup_mode != BackupMode::None
			&& matches
				.get_one::<String>(update_control::arguments::OPT_UPDATE)
				.is_some_and(|v| v == "none" || v == "none-fail")
		{
			return Err(CpError::Usage(
				"--backup is mutually exclusive with -n or --update=none-fail".to_string(),
			));
		}

		let backup_suffix = determine_backup_suffix(matches, host);

		let overwrite = OverwriteMode::from_matches(matches);

		let no_target_dir = matches.get_flag(options::NO_TARGET_DIRECTORY);
		let target_dir = matches
			.get_one::<PathBuf>(options::TARGET_DIRECTORY)
			.cloned();

		// cp follows POSIX conventions for overriding options such as "-a",
		// "-d", "--preserve", and "--no-preserve". clap removes an overridden
		// argument from the matches entirely, but "-a" expands to "-dR
		// --preserve=all" and only the "--preserve=all" part must be
		// overridden; flags may also repeat. So rebuild the command-line order
		// of these options and apply them in sequence.
		let mut overriding_order: Vec<(usize, &str, Vec<&String>)> = vec![];
		for option in [
			options::PRESERVE,
			options::NO_PRESERVE,
			options::ARCHIVE,
			options::PRESERVE_DEFAULT_ATTRIBUTES,
			options::NO_DEREFERENCE_PRESERVE_LINKS,
		] {
			if let (Ok(Some(val)), Some(index)) = (
				matches.try_get_one::<bool>(option),
				// For a flag, `index_of` is the last index it appeared at (it
				// overrides itself), which is all that matters for a flag.
				matches.index_of(option),
			) {
				if *val {
					overriding_order.push((index, option, vec![]));
				}
			} else if let (Some(occurrences), Some(mut indices)) =
				(matches.get_occurrences::<String>(option), matches.indices_of(option))
			{
				occurrences.for_each(|val| {
					if let Some(index) = indices.next() {
						let val = val.collect::<Vec<&String>>();
						// `indices_of` yields one index per value; skip to the
						// first value of the next occurrence.
						for _ in 1..val.len() {
							indices.next();
						}
						overriding_order.push((index, option, val));
					}
				});
			}
		}
		overriding_order.sort_by_key(|a| a.0);

		let mut attributes = Attributes::NONE;

		for (_, option, val) in overriding_order {
			match option {
				options::ARCHIVE => {
					attributes = Attributes::ALL;
				},
				options::PRESERVE_DEFAULT_ATTRIBUTES => {
					attributes = attributes.union(&Attributes::DEFAULT);
				},
				options::NO_DEREFERENCE_PRESERVE_LINKS => {
					attributes = attributes.union(&Attributes::LINKS);
				},
				options::PRESERVE => {
					attributes = attributes.union(&Attributes::parse_iter(val.into_iter())?);
				},
				options::NO_PRESERVE => {
					if !val.is_empty() {
						attributes = attributes.diff(&Attributes::parse_iter(val.into_iter())?);
					}
				},
				_ => (),
			}
		}

		// No SELinux support: an explicit request to preserve a security
		// context cannot be honored.
		if let Preserve::Yes { required } = attributes.context {
			if required {
				return Err(CpError::Error(
					"cannot preserve security context without an SELinux-enabled kernel".to_string(),
				));
			}
			attributes.context = Preserve::No { explicit: false };
		}

		let set_selinux_context = matches.get_flag(options::SELINUX);
		let context = matches.get_one::<String>(options::CONTEXT);
		if context.is_some_and(|context| !context.is_empty()) {
			show_warning(host, "ignoring --context; it requires an SELinux-enabled kernel");
		}

		let copy_mode = CopyMode::from_matches(matches);

		let reflink_mode = match matches.get_one::<String>(options::REFLINK).map(String::as_str) {
			Some("always") => ReflinkMode::Always,
			Some("auto") => ReflinkMode::Auto,
			Some("never") => ReflinkMode::Never,
			Some(value) => {
				return Err(CpError::Usage(format!(
					"invalid argument {} for '--reflink'",
					value.quote()
				)));
			},
			None => ReflinkMode::default(),
		};
		let sparse_mode = match matches.get_one::<String>(options::SPARSE).map(String::as_str) {
			Some("always") => SparseMode::Always,
			Some("auto") | None => SparseMode::Auto,
			Some("never") => SparseMode::Never,
			Some(value) => {
				return Err(CpError::Usage(format!(
					"invalid argument {} for '--sparse'",
					value.quote()
				)));
			},
		};
		if reflink_mode == ReflinkMode::Always && sparse_mode != SparseMode::Auto {
			return Err(CpError::Usage("--reflink can be used only with --sparse=auto".to_string()));
		}

		Ok(Self {
			attributes_only: matches.get_flag(options::ATTRIBUTES_ONLY),
			copy_contents: matches.get_flag(options::COPY_CONTENTS),
			cli_dereference: matches.get_flag(options::CLI_SYMBOLIC_LINKS),
			copy_mode,
			// No dereference is set with -P, -d and --archive
			dereference: !(matches.get_flag(options::NO_DEREFERENCE)
				|| matches.get_flag(options::NO_DEREFERENCE_PRESERVE_LINKS)
				|| matches.get_flag(options::ARCHIVE)
				// cp normally follows the link only when not copying recursively or when
				// --link (-l) is used
				|| (recursive && copy_mode != CopyMode::Link))
				|| matches.get_flag(options::DEREFERENCE),
			one_file_system: matches.get_flag(options::ONE_FILE_SYSTEM),
			parents: matches.get_flag(options::PARENTS),
			update: update_mode,
			debug: matches.get_flag(options::DEBUG),
			verbose: matches.get_flag(options::VERBOSE) || matches.get_flag(options::DEBUG),
			strip_trailing_slashes: matches.get_flag(options::STRIP_TRAILING_SLASHES),
			reflink_mode,
			sparse_mode,
			backup: backup_mode,
			backup_suffix,
			overwrite,
			no_target_dir,
			attributes,
			recursive,
			target_dir,
			progress_bar: matches.get_flag(options::PROGRESS_BAR),
			set_selinux_context: set_selinux_context || context.is_some(),
		})
	}

	fn dereference(&self, in_command_line: bool) -> bool {
		self.dereference || (in_command_line && self.cli_dereference)
	}

	fn preserve_hard_links(&self) -> bool {
		matches!(self.attributes.links, Preserve::Yes { .. })
	}

	/// `(preserve mode, mode explicitly not preserved)`.
	fn preserve_mode(&self) -> (bool, bool) {
		match self.attributes.mode {
			Preserve::No { explicit } => (false, explicit),
			Preserve::Yes { .. } => (true, false),
		}
	}

	/// Whether to force overwriting the destination file.
	fn force(&self) -> bool {
		matches!(self.overwrite, OverwriteMode::Clobber(ClobberMode::Force))
	}

	/// Whether each existing destination is removed before it is opened.
	fn remove_destination(&self) -> bool {
		matches!(self.overwrite, OverwriteMode::Clobber(ClobberMode::RemoveDestination))
	}

	/// `-f`: whether a destination that cannot be opened is removed and
	/// opened again.
	fn unlink_after_failed_open(&self) -> bool {
		matches!(
			self.overwrite,
			OverwriteMode::Clobber(ClobberMode::Force) | OverwriteMode::Interactive(ClobberMode::Force)
		)
	}
}

/// Bookkeeping shared by every copy of one `cp` invocation. Paths are kept
/// in their operand spelling.
#[derive(Default)]
struct CopyState {
	/// Identities of the symlinks this invocation created.
	symlinked_files:     FxHashSet<FileId>,
	/// Destinations of the operands copied so far.
	copied_destinations: FxHashSet<PathBuf>,
	/// Source identity to its first destination, for `--preserve=links`.
	copied_files:        FxHashMap<FileId, PathBuf>,
	/// `-g` progress over the total source size.
	progress_bar:        Option<ProgressBar>,
}

impl CopyState {
	/// Prints a line on stdout, keeping it clear of the progress bar.
	fn say(&self, host: &mut Host, line: impl fmt::Display) {
		match &self.progress_bar {
			Some(bar) => bar.suspend(|| {
				let _ = writeln!(host.stdout, "{line}");
			}),
			None => {
				let _ = writeln!(host.stdout, "{line}");
			},
		}
	}
}

impl TargetType {
	/// Treat target as a dir if we have multiple sources or the target
	/// exists and already is a directory
	fn determine(host: &Host, sources: &[PathBuf], target: &Path) -> Self {
		if sources.len() > 1 || host.fs().is_dir(host.resolve(target)) {
			Self::Directory
		} else {
			Self::File
		}
	}
}

/// Returns tuple of (Source paths, Target)
fn parse_path_args(mut paths: Vec<PathBuf>, options: &Options) -> CopyResult<(Vec<PathBuf>, PathBuf)> {
	if paths.is_empty() {
		return Err(CpError::Usage("missing file operand".to_string()));
	} else if paths.len() == 1 && options.target_dir.is_none() {
		return Err(CpError::Usage(format!(
			"missing destination file operand after {}",
			paths[0].quote()
		)));
	}

	// Return an error if the user requested to copy more than one
	// file source to a file target
	if options.no_target_dir && options.target_dir.is_none() && paths.len() > 2 {
		return Err(CpError::Usage(format!("extra operand {}", paths[2].quote())));
	}

	let target = match &options.target_dir {
		Some(target) => target.clone(),
		None => paths.pop().expect("at least two operands"),
	};

	Ok((paths, target))
}

/// `--strip-trailing-slashes`: `sources` without their trailing slashes.
fn strip_trailing_slashes(sources: &[PathBuf]) -> Vec<PathBuf> {
	sources
		.iter()
		.map(|source| {
			// A virtual root keeps the `//` of its `scheme://` spelling.
			if is_virtual_path(source) && parent_path(source).is_none() {
				source.clone()
			} else {
				source.components().as_path().to_owned()
			}
		})
		.collect()
}

/// Validates the `-t` directory the way GNU does.
fn check_target_directory(host: &Host, dir: &Path) -> CopyResult<()> {
	match host.fs().metadata(host.resolve(dir)) {
		Ok(metadata) if metadata.is_dir() => Ok(()),
		Ok(_) => Err(CpError::IoErrContext(
			pi_vfs::not_a_directory(),
			format!("target directory {}", dir.quote()),
		)),
		Err(error) => Err(CpError::IoErrContext(error, format!("target directory {}", dir.quote()))),
	}
}

/// Whether `error` means the filesystem cannot store the attribute at all.
fn is_enotsup_error(error: &CpError) -> bool {
	match error {
		CpError::IoErr(e) | CpError::IoErrContext(e, _) => {
			if e.kind() == io::ErrorKind::Unsupported {
				return true;
			}
			#[cfg(unix)]
			{
				matches!(e.raw_os_error(), Some(code) if code == libc::EOPNOTSUPP || code == libc::ENOTSUP)
			}
			#[cfg(not(unix))]
			{
				false
			}
		},
		_ => false,
	}
}

/// Prints `error` unless it is a silent skip or an already-reported summary.
fn show_error_if_needed(host: &mut Host, error: &CpError) {
	match error {
		CpError::NotAllFilesCopied | CpError::Skipped(_) => {},
		_ => show_error(host, error),
	}
}

/// Copy all `sources` to `target`.
///
/// Returns an `Err(Error::NotAllFilesCopied)` if at least one non-fatal error
/// was encountered.
fn copy(host: &mut Host, sources: &[PathBuf], target: &Path, options: &Options) -> CopyResult<()> {
	let target_type = TargetType::determine(host, sources, target);
	verify_target_type(host, target, target_type)?;
	// Like GNU, only sources copied into a directory are stripped.
	let stripped;
	let sources = if options.strip_trailing_slashes && matches!(target_type, TargetType::Directory) {
		stripped = strip_trailing_slashes(sources);
		&stripped
	} else {
		sources
	};
	if options.parents && !host.fs().is_dir(host.resolve(target)) {
		return Err(CpError::Usage("with --parents, the destination must be a directory".to_string()));
	}

	let mut non_fatal_errors = false;
	let mut seen_sources = FxHashSet::default();
	let mut state = CopyState::default();

	if options.progress_bar
		&& let Some(draw_target) = stderr_draw_target(host)
	{
		let total = disk_usage(host, sources, options.recursive);
		let bar = ProgressBar::with_draw_target(Some(total), draw_target)
			.with_style(
				ProgressStyle::with_template(
					"{msg}: [{elapsed_precise}] {wide_bar} {bytes:>7}/{total_bytes:7}",
				)
				.expect("valid progress template"),
			)
			.with_message("cp");
		bar.tick();
		state.progress_bar = Some(bar);
	}

	for source in sources {
		if host.is_cancelled() {
			non_fatal_errors = true;
			break;
		}
		let normalized_source = normalize_lexically(source);
		if options.backup == BackupMode::None && seen_sources.contains(&normalized_source) {
			let file_type = if host
				.fs()
				.symlink_metadata(host.resolve(source))
				.is_ok_and(|metadata| metadata.is_dir())
			{
				"directory"
			} else {
				"file"
			};
			show_warning(host, format_args!("source {file_type} {} specified more than once", source.quote()));
		} else if let Err(error) = copy_operand(host, &mut state, source, target, target_type, options) {
			show_error_if_needed(host, &error);
			if !matches!(error, CpError::Skipped(false)) {
				non_fatal_errors = true;
			}
		}
		seen_sources.insert(normalized_source);
	}

	if let Some(bar) = &state.progress_bar {
		bar.finish();
	}

	if non_fatal_errors { Err(CpError::NotAllFilesCopied) } else { Ok(()) }
}

/// Copies one command-line operand, refusing to overwrite a destination this
/// invocation already produced.
fn copy_operand(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	target: &Path,
	target_type: TargetType,
	options: &Options,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let dest_path = construct_dest_path(host, source, target, target_type, options);
	let dest = dest_path.as_deref().unwrap_or(target).to_path_buf();
	let dest_fs = host.resolve(&dest);
	let source_fs = host.resolve(source);

	if (filesystem.metadata(&dest_fs).is_ok() && !filesystem.is_symlink(&dest_fs))
		// if both `source` and `dest` are symlinks, it should be considered as an overwrite.
		|| (filesystem.metadata(&source_fs).is_ok() && filesystem.is_symlink(&source_fs))
		|| options.copy_mode == CopyMode::SymLink
	{
		// Directories merge (GNU cp behavior); anything else must not replace a
		// destination this invocation just created.
		if state.copied_destinations.contains(&dest)
			&& options.backup != BackupMode::Numbered
			&& !(filesystem.is_dir(&dest_fs) && filesystem.is_dir(&source_fs))
		{
			return Err(CpError::Error(format!(
				"will not overwrite just-created {} with {}",
				dest.quote(),
				source.quote()
			)));
		}
	}

	copy_source(host, state, source, target, dest_path, options)?;
	state.copied_destinations.insert(dest);
	Ok(())
}

/// `source` below its root, for `--parents`: `/a/b` is `a/b`, and a URL
/// `scheme://a/b` is `a/b` with its segments decoded.
fn parents_relative(source: &Path) -> PathBuf {
	if let Some(scheme) = url_scheme(source) {
		// The `scheme://` root is ASCII, so a lossy spelling keeps its length.
		let spelled = source.as_os_str().to_string_lossy();
		let rest = &spelled[scheme.len() + "://".len()..];
		let mut relative = PathBuf::new();
		for segment in rest.split('/').filter(|segment| !segment.is_empty()) {
			relative.push(decode_segment(std::ffi::OsStr::new(segment)));
		}
		relative
	} else if cfg!(unix) && source.has_root() {
		source.strip_prefix("/").unwrap_or(source).to_path_buf()
	} else {
		source.to_path_buf()
	}
}

fn construct_dest_path(
	host: &Host,
	source: &Path,
	target: &Path,
	target_type: TargetType,
	options: &Options,
) -> CopyResult<PathBuf> {
	let target_is_dir = host.fs().is_dir(host.resolve(target));
	if options.no_target_dir && target_is_dir {
		return Err(CpError::Error(format!(
			"cannot overwrite directory {} with non-directory {}",
			target.quote(),
			source.quote()
		)));
	}

	Ok(match target_type {
		TargetType::Directory => {
			if options.parents {
				join_path(target, &parents_relative(source))
			} else if source == Path::new(".") && target_is_dir {
				// Copying `.` into an existing directory copies its contents.
				target.to_path_buf()
			} else {
				match file_name(source) {
					Some(name) => child_path(target, &name),
					None => target.to_path_buf(),
				}
			}
		},
		TargetType::File => target.to_path_buf(),
	})
}

/// Copies `source` into `target`: a directory recursively, anything else as
/// a file to `dest` (from [`construct_dest_path`]).
fn copy_source(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	target: &Path,
	dest: CopyResult<PathBuf>,
	options: &Options,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	if filesystem.is_dir(&source_fs)
		&& (options.dereference(true) || !filesystem.is_symlink(&source_fs))
	{
		return copy_directory(host, state, source, target, options);
	}

	let dest = dest?;
	if options.parents {
		make_parent_dirs(host, state, source, &dest, options)?;
	}
	let result = copy_file(host, state, source, &dest, options, true);
	if options.parents {
		for (x, y) in aligned_ancestors(source, &dest) {
			if let Ok(src) = filesystem.canonicalize_with(
				host.resolve(&x),
				&CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Physical),
			) {
				copy_attributes(host, &src, &y, &options.attributes, false, true, options.set_selinux_context)?;
			}
		}
	}
	result
}

/// Reads one answer from stdin one byte at a time (no buffering, so
/// consecutive prompts don't over-read). True when the line starts with `y`.
fn read_yes(host: &mut Host) -> bool {
	let mut buf = [0u8; 1];
	let mut first = None;
	loop {
		match host.stdin.read(&mut buf) {
			Ok(0) => break,
			Ok(_) => {
				if buf[0] == b'\n' {
					break;
				}
				if first.is_none() {
					first = Some(buf[0]);
				}
			},
			Err(_) => return false,
		}
	}
	matches!(first, Some(b'y' | b'Y'))
}

/// The `-i` question for `path`, naming the mode of an unwritable file as
/// GNU does.
fn interactive_prompt(host: &Host, path: &Path, clobber: ClobberMode) -> String {
	#[cfg(unix)]
	{
		let filesystem = host.fs();
		let resolved = host.resolve(path);
		if !filesystem.is_symlink(&resolved)
			&& filesystem.access(&resolved, false, true, false).is_err()
			&& let Ok(metadata) = filesystem.metadata(&resolved)
		{
			let mode = metadata.mode() & 0o7777;
			let permissions = uucore::fs::display_permissions_unix(mode, false);
			return if clobber == ClobberMode::Standard {
				format!("unwritable {} (mode {mode:04o}, {permissions}); try anyway?", path.quote())
			} else {
				format!("replace {}, overriding mode {mode:04o} ({permissions})?", path.quote())
			};
		}
	}
	#[cfg(not(unix))]
	let _ = (host, clobber);
	format!("overwrite {}?", path.quote())
}

impl OverwriteMode {
	fn verify(self, host: &mut Host, path: &Path, debug: bool) -> CopyResult<()> {
		match self {
			Self::NoClobber => {
				if debug {
					let _ = writeln!(host.stdout, "skipped {}", path.quote());
				}
				Err(CpError::Skipped(false))
			},
			Self::Interactive(clobber) => {
				let prompt = interactive_prompt(host, path, clobber);
				let _ = write!(host.stderr, "{}: {prompt} ", Cp::NAME);
				let _ = host.stderr.flush();
				if read_yes(host) { Ok(()) } else { Err(CpError::Skipped(true)) }
			},
			Self::Clobber(_) => Ok(()),
		}
	}
}

/// Handles errors for attributes preservation. If the attribute is not
/// required, and errored, tries to show error (see `show_error_if_needed`
/// for additional behavior details). If it's required, then the error is
/// thrown.
///
/// ENOTSUP errors are silently ignored when not required, as per GNU cp:
/// "Try to preserve SELinux security context and extended attributes
/// (xattr), but ignore any failure to do that and print no corresponding
/// diagnostic."
fn handle_preserve(
	host: &mut Host,
	preserve: Preserve,
	f: impl FnOnce() -> CopyResult<()>,
) -> CopyResult<()> {
	match preserve {
		Preserve::No { .. } => {},
		Preserve::Yes { required } => {
			let result = f();
			if required {
				result?;
			} else if let Err(error) = &result
				&& !is_enotsup_error(error)
			{
				show_error_if_needed(host, error);
			}
		},
	}
	Ok(())
}

/// Applies a metadata change to `path`, retrying on an open handle when the
/// provider only implements the change for handles.
fn preserve_via(
	filesystem: &BlockingFs,
	path: &Path,
	by_path: impl FnOnce(&BlockingFs, &Path) -> io::Result<()>,
	by_handle: impl FnOnce(&File) -> io::Result<()>,
) -> io::Result<()> {
	match by_path(filesystem, path) {
		Err(error) if error.kind() == io::ErrorKind::Unsupported => {
			let file = filesystem.open_with(path, OpenOptions::new().write(true))?;
			let applied = by_handle(&file);
			let closed = file.close();
			applied.and(closed)
		},
		result => result,
	}
}

/// Copies extended attributes (xattrs) from `source` to `dest`, making a
/// read-only `dest` temporarily user-writable so the attributes can be set.
fn copy_extended_attrs(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	follow_source: bool,
	skip_selinux: bool,
) -> io::Result<()> {
	let metadata = filesystem.symlink_metadata(dest)?;

	let mut permissions = metadata.permissions();
	let was_readonly = !metadata.is_symlink() && permissions.readonly();
	if was_readonly {
		permissions.set_readonly(false);
		filesystem.set_permissions(dest, permissions)?;
	}

	let copied = (|| -> io::Result<()> {
		for name in filesystem.list_xattr(source, follow_source)? {
			// With -Z the destination gets the default context instead.
			if skip_selinux && name == "security.selinux" {
				continue;
			}
			if let Some(value) = filesystem.get_xattr(source, &name, follow_source)? {
				filesystem.set_xattr(dest, &name, &value, false)?;
			}
		}
		Ok(())
	})();

	if was_readonly {
		let mut permissions = filesystem.symlink_metadata(dest)?.permissions();
		permissions.set_readonly(true);
		filesystem.set_permissions(dest, permissions)?;
	}

	copied
}

/// Copy the specified attributes from one path to another. `follow_source`
/// reads the attributes of the file a symlinked `source` points to.
fn copy_attributes(
	host: &mut Host,
	source: &Path,
	dest: &Path,
	attributes: &Attributes,
	dest_is_freshly_created_dir: bool,
	follow_source: bool,
	skip_selinux_xattr: bool,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let context = context_for(source, dest);
	let source_metadata = if follow_source {
		filesystem.metadata(&source_fs)
	} else {
		filesystem.symlink_metadata(&source_fs)
	}
	.map_err(|e| CpError::IoErrContext(e, context))?;
	let dest_is_symlink = filesystem.is_symlink(&dest_fs);

	let mode_explicitly_disabled = matches!(attributes.mode, Preserve::No { explicit: true });

	// preserve is true by default if the destination is created by us and it's
	// a directory
	let mode = if !mode_explicitly_disabled && dest_is_freshly_created_dir {
		Preserve::Yes { required: false }
	} else {
		attributes.mode
	};

	// Ownership must be changed first to avoid interfering with mode change.
	handle_preserve(host, attributes.ownership, || {
		// A provider without owners has nothing to carry over.
		let (Some(uid), Some(gid)) = (source_metadata.uid(), source_metadata.gid()) else {
			return Ok(());
		};
		// GNU cp doesn't report a failure to set the ownership, and falls back
		// to changing only the group.
		if filesystem.chown(&dest_fs, Some(uid), Some(gid), false).is_err() {
			let _ = filesystem.chown(&dest_fs, None, Some(gid), false);
		}
		Ok(())
	})?;

	handle_preserve(host, mode, || {
		// chmod cannot change a symbolic link, and every link has the same
		// permissions anyway.
		if !dest_is_symlink {
			set_mode(&filesystem, &dest_fs, dest, source_metadata.permissions())?;
		}
		Ok(())
	})?;

	// A directory is created with a restrictive mode (see `build_dir`); when
	// its mode is not preserved it ends up with the default one.
	if dest_is_freshly_created_dir && mode_explicitly_disabled {
		handle_preserve(host, Preserve::Yes { required: false }, || {
			set_mode(&filesystem, &dest_fs, dest, Permissions::from_mode(0o777 & !umask()))
		})?;
	}

	handle_preserve(host, attributes.timestamps, || {
		let times_error =
			|e| CpError::IoErrContext(e, format!("preserving times for {}", dest.quote()));
		let accessed = FileTime::from(source_metadata.accessed().ok());
		let modified = FileTime::from(source_metadata.modified().map_err(times_error)?);
		if dest_is_symlink {
			filesystem.set_times(&dest_fs, accessed, modified, false)
		} else {
			preserve_via(
				&filesystem,
				&dest_fs,
				|filesystem, path| filesystem.set_times(path, accessed, modified, true),
				|file| file.set_times(accessed, modified),
			)
		}
		.map_err(times_error)
	})?;

	handle_preserve(host, attributes.xattr, || {
		copy_extended_attrs(&filesystem, &source_fs, &dest_fs, follow_source, skip_selinux_xattr)
			.map_err(|e| CpError::IoErrContext(e, format!("setting attributes for {}", dest.quote())))
	})?;

	Ok(())
}

/// Sets the permissions of `dest` (resolved as `dest_fs`), for attribute
/// preservation.
fn set_mode(
	filesystem: &BlockingFs,
	dest_fs: &Path,
	dest: &Path,
	permissions: Permissions,
) -> CopyResult<()> {
	preserve_via(
		filesystem,
		dest_fs,
		|filesystem, path| filesystem.set_permissions(path, permissions),
		|file| file.set_permissions(permissions),
	)
	.map_err(|e| CpError::IoErrContext(e, format!("preserving permissions for {}", dest.quote())))
}

/// Creates the symlink `dest` pointing at the literal `target`.
fn symlink_file(host: &mut Host, state: &mut CopyState, target: &Path, dest: &Path) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	filesystem.symlink(target, &dest_fs).map_err(|e| {
		CpError::IoErrContext(
			e,
			format!("cannot create symbolic link {} to {}", dest.quote(), target.quote()),
		)
	})?;
	if let Some(id) = file_id(&filesystem, &dest_fs, false) {
		state.symlinked_files.insert(id);
	}
	Ok(())
}

fn context_for(src: &Path, dest: &Path) -> String {
	format!("{} -> {}", src.quote(), dest.quote())
}

/// Backs `dest` up to `backup_path`: renamed away, as GNU does, so the copy
/// creates a new file; copied when `dest` is the source itself, which must
/// stay readable.
fn backup_dest(
	filesystem: &BlockingFs,
	dest: &Path,
	dest_fs: &Path,
	backup_path: &Path,
	rename: bool,
) -> CopyResult<()> {
	if rename {
		filesystem.rename(dest_fs, backup_path).map(drop)
	} else {
		filesystem.copy(dest_fs, backup_path).map(drop)
	}
	.map_err(|e| CpError::IoErrContext(e, format!("cannot backup {}", dest.quote())))
}

/// The identity of `path`, when its filesystem reports one.
fn file_id(filesystem: &BlockingFs, path: &Path, follow: bool) -> Option<FileId> {
	let metadata = if follow { filesystem.metadata(path) } else { filesystem.symlink_metadata(path) };
	metadata.ok()?.file_id()
}

/// Whether `a` and `b` are the same file. Identities decide when both come
/// from one namespace; otherwise (a provider without identities, or one
/// aliasing host files) the same location does.
fn paths_refer_to_same_file(filesystem: &BlockingFs, a: &Path, b: &Path, dereference: bool) -> bool {
	let stat = |path: &Path| {
		if dereference { filesystem.metadata(path) } else { filesystem.symlink_metadata(path) }
	};
	let (Ok(a_metadata), Ok(b_metadata)) = (stat(a), stat(b)) else {
		return false;
	};
	match (a_metadata.file_id(), b_metadata.file_id()) {
		(Some(a), Some(b)) if a.is_native() == b.is_native() => a == b,
		_ if dereference => {
			matches!((location(filesystem, a), location(filesystem, b)), (Some(a), Some(b)) if a == b)
		},
		_ => normalize_lexically(a) == normalize_lexically(b),
	}
}

/// Where `path` physically is: the canonical host file a provider path
/// aliases, else its canonical path.
fn location(filesystem: &BlockingFs, path: &Path) -> Option<PathBuf> {
	match filesystem.backing_path(path).ok().flatten() {
		Some(backing) => Some(filesystem.canonicalize(&backing).unwrap_or(backing)),
		None => filesystem.canonicalize(path).ok(),
	}
}

/// Whether `source` and `target` are hard links to the same file, without
/// following either.
fn are_hardlinks_to_same_file(filesystem: &BlockingFs, source: &Path, target: &Path) -> bool {
	paths_refer_to_same_file(filesystem, source, target, false)
}

/// Whether following `path` revisits a symlink.
fn is_symlink_loop(filesystem: &BlockingFs, path: &Path) -> bool {
	let mut visited = FxHashSet::default();
	let mut current = path.to_path_buf();
	while let (Ok(metadata), Ok(link)) =
		(filesystem.symlink_metadata(&current), filesystem.read_link(&current))
	{
		if !metadata.is_symlink() {
			return false;
		}
		if !visited.insert(current.clone()) {
			return true;
		}
		// A relative target is relative to the link's directory.
		current = match parent_path(&current) {
			Some(parent) => join_path(parent, &link),
			None => link,
		};
	}
	false
}

/// Decide whether source and destination files are the same and
/// copying is forbidden.
///
/// Copying to the same file is only allowed if both `--backup` and
/// `--force` are specified and the file is a regular file.
fn is_forbidden_to_copy_to_same_file(
	filesystem: &BlockingFs,
	source: &Path,
	dest: &Path,
	source_fs: &Path,
	dest_fs: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> bool {
	let source_is_symlink = filesystem.is_symlink(source_fs);
	let dest_is_symlink = filesystem.is_symlink(dest_fs);
	// only disable dereference if both source and dest is symlink and dereference
	// flag is disabled
	let dereference_to_compare =
		options.dereference(source_in_command_line) || (!source_is_symlink || !dest_is_symlink);
	if !paths_refer_to_same_file(filesystem, source_fs, dest_fs, dereference_to_compare) {
		return false;
	}
	if options.backup != BackupMode::None {
		if options.force() && !source_is_symlink {
			return false;
		}
		if source_is_symlink && !options.dereference {
			return false;
		}
		if dest_is_symlink {
			return false;
		}
		if !dest_is_symlink && !source_is_symlink && dest != source {
			return false;
		}
	}
	if options.copy_mode == CopyMode::Link {
		return false;
	}
	if options.copy_mode == CopyMode::SymLink && dest_is_symlink {
		return false;
	}
	// If source and dest are both the same symlink but with different names,
	// then allow the copy. This can occur, for example, if source and dest are
	// both hardlinks to the same symlink.
	if dest_is_symlink
		&& source_is_symlink
		&& file_name(source) != file_name(dest)
		&& !options.dereference
	{
		return false;
	}
	true
}

/// Back up, remove, or leave intact the existing destination file, depending
/// on the options. Returns the backup made, if any.
fn handle_existing_dest(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> CopyResult<Option<PathBuf>> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	if options.update == UpdateMode::None {
		if options.debug {
			let _ = writeln!(host.stdout, "skipped {}", dest.quote());
		}
		return Err(CpError::Skipped(false));
	}

	if options.update != UpdateMode::IfOlder {
		options.overwrite.verify(host, dest, options.debug)?;
	}

	let mut is_dest_removed = false;
	let backup = backup_path(&filesystem, options.backup, &dest_fs, &options.backup_suffix);
	if let Some(backup) = &backup {
		if paths_refer_to_same_file(&filesystem, &source_fs, backup, true) {
			return Err(CpError::Error(format!(
				"backing up {} might destroy source;  {} not copied",
				dest.quote(),
				source.quote()
			)));
		}
		is_dest_removed = filesystem.is_symlink(&dest_fs)
			|| !paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true);
		backup_dest(&filesystem, dest, &dest_fs, backup, is_dest_removed)?;
	}
	if !is_dest_removed {
		delete_dest_if_needed_and_allowed(host, state, source, dest, options, source_in_command_line)?;
	}

	Ok(backup)
}

/// Deletes `dest` when it has to go before the copy can proceed and the
/// options allow it.
fn delete_dest_if_needed_and_allowed(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let delete_dest = match options.overwrite {
		OverwriteMode::Clobber(clobber) | OverwriteMode::Interactive(clobber) => match clobber {
			// Removed only once opening it fails (see `copy_data`).
			ClobberMode::Force => false,
			ClobberMode::RemoveDestination => true,
			ClobberMode::Standard => {
				// With `cp -a src/ dest/`, a hard link `src/link` to `src/f` may be
				// copied before `src/f`; an existing `dest/src/f` must then be
				// replaced by a link to the copy.
				options.preserve_hard_links()
					&& file_id(
						&filesystem,
						&host.resolve(source),
						options.dereference(source_in_command_line),
					)
					.is_some_and(|id| state.copied_files.contains_key(&id))
			},
		},
		OverwriteMode::NoClobber => false,
	};

	if delete_dest { delete_path(host, state, dest, options) } else { Ok(()) }
}

fn delete_path(host: &mut Host, state: &CopyState, path: &Path, options: &Options) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let path_fs = host.resolve(path);
	// Windows requires clearing readonly attribute before deletion when using
	// --force
	#[cfg(windows)]
	if options.force()
		&& let Ok(mut permissions) = filesystem.metadata(&path_fs).map(|m| m.permissions())
	{
		permissions.set_readonly(false);
		let _ = filesystem.set_permissions(&path_fs, permissions);
	}

	match filesystem.remove_file(&path_fs) {
		Ok(()) => {
			if options.verbose {
				state.say(host, format_args!("removed {}", path.quote()));
			}
		},
		// target could have been deleted earlier (e.g. same-file with
		// --remove-destination)
		Err(err) if err.kind() == io::ErrorKind::NotFound => {},
		Err(err) => {
			return Err(CpError::IoErrContext(err, format!("cannot remove {}", path.quote())));
		},
	}

	Ok(())
}

/// Zip the ancestors of a source path and destination path, outermost first,
/// without the paths themselves: `a/b/c` and `d/a/b/c` give `(a, d/a)` and
/// `(a/b, d/a/b)`.
fn aligned_ancestors(source: &Path, dest: &Path) -> Vec<(PathBuf, PathBuf)> {
	let source_ancestors: Vec<&Path> = std::iter::successors(Some(source), |p| parent_path(p)).collect();
	let dest_ancestors: Vec<&Path> = std::iter::successors(Some(dest), |p| parent_path(p)).collect();

	// Neither the full path nor the empty path (or root) is an ancestor to
	// create.
	let Some(source_ancestors) = source_ancestors.get(1..source_ancestors.len().saturating_sub(1))
	else {
		return Vec::new();
	};
	let Some(dest_ancestors) = dest_ancestors.get(1..=source_ancestors.len()) else {
		return Vec::new();
	};

	source_ancestors
		.iter()
		.rev()
		.zip(dest_ancestors.iter().rev())
		.map(|(x, y)| (x.to_path_buf(), y.to_path_buf()))
		.collect()
}

/// For `--parents`, creates the missing directories between `dest` and its
/// target, each like the source directory it mirrors; `-v` reports each
/// one, e.g. `a -> d/a` and `a/b -> d/a/b` before copying `a/b/c` to
/// `d/a/b/c`.
fn make_parent_dirs(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
) -> CopyResult<()> {
	for (x, y) in aligned_ancestors(source, dest) {
		match host.fs().metadata(host.resolve(&y)) {
			Ok(metadata) if metadata.is_dir() => {},
			Ok(_) => {
				return Err(CpError::Error(format!("{} exists but is not a directory", y.quote())));
			},
			Err(_) => {
				build_dir(host, &y, false, options, Some(&x))?;
				if options.verbose {
					state.say(host, format_args!("{} -> {}", x.display(), y.display()));
				}
			},
		}
	}
	Ok(())
}

fn print_verbose_output(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	backup: Option<&Path>,
) {
	match backup {
		Some(backup) => state.say(
			host,
			format_args!(
				"{} (backup: {})",
				context_for(source, dest),
				backup_display(dest, backup).quote()
			),
		),
		None => state.say(host, context_for(source, dest)),
	}
}

/// Whether a relative symlink target named by `-s` would resolve from `dest`
/// the same way it does from the working directory.
fn dest_in_working_directory(host: &Host, dest: &Path) -> bool {
	match parent_path(dest) {
		None => true,
		Some(parent) if parent.as_os_str().is_empty() || parent == Path::new(".") => true,
		Some(parent) => host
			.fs()
			.same_file(host.resolve(parent), host.resolve("."))
			.unwrap_or(false),
	}
}

/// Handles the copy mode for a file copy operation: hard linking, copying
/// (`-u` already decided to), symbolic linking, or attribute-only copying.
fn handle_copy_mode(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_metadata: &Metadata,
	source_in_command_line: bool,
	backed_up: bool,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	match options.copy_mode {
		CopyMode::Link => {
			// A destination that survived `handle_existing_dest` was backed up
			// by copying, or is replaced under `-f`.
			if filesystem.exists(&dest_fs) && (backed_up || options.force()) {
				filesystem.remove_file(&dest_fs)?;
			}
			let original = if options.dereference(source_in_command_line)
				&& filesystem.is_symlink(&source_fs)
			{
				filesystem.canonicalize_with(
					&source_fs,
					&CanonicalizeOptions::new(MissingHandling::Missing, ResolveMode::Physical),
				)?
			} else {
				source_fs
			};
			filesystem.hard_link(&original, &dest_fs).map_err(|e| {
				CpError::IoErrContext(
					e,
					format!("cannot create hard link {} to {}", dest.quote(), source.quote()),
				)
			})?;
		},
		CopyMode::Copy | CopyMode::Update => {
			copy_helper(host, state, source, dest, options, source_metadata)?;
		},
		CopyMode::SymLink => {
			if !source.is_absolute()
				&& !is_virtual_path(source)
				&& !dest_in_working_directory(host, dest)
			{
				return Err(CpError::Error(format!(
					"{}: can make relative symbolic links only in current directory",
					dest.maybe_quote()
				)));
			}
			if filesystem.exists(&dest_fs) && options.force() {
				filesystem.remove_file(&dest_fs)?;
			}
			symlink_file(host, state, source, dest)?;
		},
		CopyMode::AttrOnly => {
			filesystem
				.open_with(&dest_fs, OpenOptions::new().write(true).create(true))
				.and_then(File::close)
				.map_err(|e| {
					CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()))
				})?;
		},
	}

	Ok(())
}

/// The process umask; `0` where there is none.
fn umask() -> u32 {
	#[cfg(unix)]
	{
		uucore::mode::get_umask()
	}
	#[cfg(not(unix))]
	{
		0
	}
}

/// Permissions for the destination: an existing destination keeps its own;
/// a new one gets the source's, less `--no-preserve=mode` and the umask.
fn calculate_dest_permissions(
	dest_metadata: Option<&Metadata>,
	source_metadata: &Metadata,
	options: &Options,
) -> Permissions {
	match dest_metadata {
		Some(metadata) => metadata.permissions(),
		None => {
			let mode = handle_no_preserve_mode(options, source_metadata.permissions().mode());
			Permissions::from_mode(mode & !umask())
		},
	}
}

/// Copy the a file from `source` to `dest`. `source` will be dereferenced if
/// `options.dereference` is set to true. `dest` will be dereferenced only if
/// the source was not a symlink.
///
/// Behavior when copying to existing files is contingent on the
/// `options.overwrite` mode. If a file is skipped, the return type
/// should be `Error:Skipped`
///
/// The original permissions of `source` will be copied to `dest`
/// after a successful copy.
fn copy_file(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_in_command_line: bool,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let dereference = options.dereference(source_in_command_line);

	// GNU stats the source before touching the destination.
	let source_metadata = if dereference {
		filesystem.metadata(&source_fs)
	} else {
		filesystem.symlink_metadata(&source_fs)
	}
	.map_err(|e| CpError::IoErrContext(e, format!("cannot stat {}", source.quote())))?;

	let source_is_symlink = filesystem.is_symlink(&source_fs);
	let initial_dest_metadata = match filesystem.symlink_metadata(&dest_fs) {
		Ok(metadata) => Some(metadata),
		Err(error) if error.kind() == io::ErrorKind::NotFound => None,
		Err(error) => {
			return Err(CpError::IoErrContext(error, format!("cannot stat {}", dest.quote())));
		},
	};
	let dest_is_symlink = initial_dest_metadata
		.as_ref()
		.is_some_and(Metadata::is_symlink);
	let dest_target_exists = filesystem.try_exists(&dest_fs).unwrap_or(false);
	// Fail if dest is a dangling symlink or a symlink this program created
	// previously
	if dest_is_symlink {
		if file_id(&filesystem, &dest_fs, false).is_some_and(|id| state.symlinked_files.contains(&id))
			// Two sources of the same name must not both go through one symlink.
			|| state.copied_destinations.contains(dest)
		{
			return Err(CpError::Error(format!(
				"will not copy {} through just-created symlink {}",
				source.quote(),
				dest.quote()
			)));
		}

		let copy_contents = dereference || !source_is_symlink;
		if copy_contents
			&& !dest_target_exists
			&& !options.remove_destination()
			&& !is_symlink_loop(&filesystem, &dest_fs)
			&& host.var("POSIXLY_CORRECT").is_none()
		{
			return Err(CpError::Error(format!(
				"not writing through dangling symlink {}",
				dest.quote()
			)));
		}
		if paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true)
			&& options.remove_destination()
			&& options.backup == BackupMode::None
		{
			filesystem.remove_file(&dest_fs)?;
		}
	}

	if options.remove_destination()
		&& source != dest
		&& are_hardlinks_to_same_file(&filesystem, &source_fs, &dest_fs)
	{
		filesystem.remove_file(&dest_fs)?;
	}

	let check_existing_dest = initial_dest_metadata.is_some()
		&& (!options.attributes_only || options.remove_destination());
	if check_existing_dest {
		if paths_refer_to_same_file(&filesystem, &source_fs, &dest_fs, true)
			&& options.copy_mode == CopyMode::Link
		{
			if source_is_symlink {
				if !dest_is_symlink || !options.dereference {
					return Ok(());
				}
			} else if options.backup != BackupMode::None && !dest_is_symlink {
				if source != dest || !options.force() {
					return Ok(());
				}
			}
		}
		// Disallow copying a file to itself, unless `--force` and
		// `--backup` are both specified.
		if is_forbidden_to_copy_to_same_file(
			&filesystem,
			source,
			dest,
			&source_fs,
			&dest_fs,
			options,
			source_in_command_line,
		) {
			return Err(CpError::Error(format!(
				"{} and {} are the same file",
				source.quote(),
				dest.quote()
			)));
		}
	}

	// `-u`/`--update` decides before anything is backed up or removed.
	if options.copy_mode == CopyMode::Update && filesystem.exists(&dest_fs) {
		match options.update {
			UpdateMode::All => {},
			UpdateMode::None => {
				if options.debug {
					let _ = writeln!(host.stdout, "skipped {}", dest.quote());
				}
				return Ok(());
			},
			UpdateMode::NoneFail => {
				return Err(CpError::Error(format!("not replacing {}", dest.quote())));
			},
			UpdateMode::IfOlder => {
				let dest_time = filesystem.symlink_metadata(&dest_fs)?.modified()?;
				if source_metadata.modified()? <= dest_time {
					return Ok(());
				}
				options.overwrite.verify(host, dest, options.debug)?;
			},
		}
	}

	let mut backup = None;
	if check_existing_dest {
		backup = handle_existing_dest(host, state, source, dest, options, source_in_command_line)?;
		if are_hardlinks_to_same_file(&filesystem, &source_fs, &dest_fs) {
			if options.copy_mode == CopyMode::Copy {
				return Ok(());
			}
			if options.copy_mode == CopyMode::Link && (!source_is_symlink || !dest_is_symlink) {
				return Ok(());
			}
		}
	}

	if options.attributes_only && source_is_symlink && !options.remove_destination() {
		return Err(CpError::Error(format!(
			"cannot change attribute {}: Source file is a non regular file",
			dest.quote()
		)));
	}

	// When using --link mode, hard link structure is automatically preserved
	// because we link to source files (which share inodes).
	if options.preserve_hard_links()
		&& options.copy_mode != CopyMode::Link
		&& let Some(new_source) = source_metadata
			.file_id()
			.and_then(|id| state.copied_files.get(&id))
	{
		// A matching identity in the source tree becomes a hard link between
		// the corresponding names in the destination tree.
		let new_source = new_source.clone();
		filesystem
			.hard_link(host.resolve(&new_source), &dest_fs)
			.map_err(|e| {
				CpError::IoErrContext(
					e,
					format!("cannot create hard link {} to {}", dest.quote(), new_source.quote()),
				)
			})?;

		if options.verbose {
			print_verbose_output(host, state, source, dest, backup.as_deref());
		}

		return Ok(());
	}

	// A copied symlink replaces the destination, which GNU removes before
	// reporting the copy.
	if source_metadata.is_symlink()
		&& matches!(options.copy_mode, CopyMode::Copy | CopyMode::Update)
		&& (filesystem.is_symlink(&dest_fs) || filesystem.is_file(&dest_fs))
	{
		delete_path(host, state, dest, options)?;
	}

	let dest_metadata = filesystem.symlink_metadata(&dest_fs).ok();

	let source_is_stream = is_stream(&source_metadata);

	// GNU reports each copy as it starts it.
	if options.verbose {
		print_verbose_output(host, state, source, dest, backup.as_deref());
	}

	handle_copy_mode(
		host,
		state,
		source,
		dest,
		options,
		&source_metadata,
		source_in_command_line,
		backup.is_some(),
	)?;

	// Links share their target's permissions; only a copy gets its own.
	let copied_data = !source_metadata.is_symlink()
		&& !matches!(options.copy_mode, CopyMode::Link | CopyMode::SymLink);
	if !dest_is_symlink && copied_data {
		// An existing destination keeps its permissions, unless `-f` had to
		// replace it with a new file.
		let replaced = dest_metadata.as_ref().is_some_and(|before| {
			let after = filesystem.symlink_metadata(&dest_fs).ok().and_then(|m| m.file_id());
			matches!((before.file_id(), after), (Some(before), Some(after)) if before != after)
		});
		let kept = dest_metadata.as_ref().filter(|_| !replaced);
		let dest_permissions = calculate_dest_permissions(kept, &source_metadata, options);
		// Here, to match GNU semantics, we quietly ignore an error
		// if a user does not have the correct ownership to modify
		// the permissions of a file.
		//
		// FWIW, the OS will throw an error later, on the write op, if
		// the user does not have permission to write to the file.
		let _ = filesystem.set_permissions(&dest_fs, dest_permissions);
	}

	// Some stream files may not exist after we have copied them, like
	// anonymous pipes; there are no attributes left to copy.
	if !(source_is_stream && !filesystem.exists(&source_fs)) {
		copy_attributes(
			host,
			source,
			dest,
			&options.attributes,
			false,
			dereference,
			options.set_selinux_context,
		)?;
	}

	// Skip tracking copied files when using --link mode since hard link
	// structure is automatically preserved
	if options.copy_mode != CopyMode::Link
		&& let Some(id) = source_metadata.file_id()
	{
		state.copied_files.insert(id, dest.to_path_buf());
	}

	if let Some(bar) = &state.progress_bar {
		bar.inc(source_metadata.len());
	}

	Ok(())
}

fn is_stream(metadata: &Metadata) -> bool {
	let file_type = metadata.file_type();
	file_type.is_fifo() || file_type.is_char_device() || file_type.is_block_device()
}

fn handle_no_preserve_mode(options: &Options, org_mode: u32) -> u32 {
	const MODE_RW_UGO: u32 = 0o666;
	const S_IRWXUGO: u32 = 0o777;
	let (is_preserve_mode, is_explicit_no_preserve_mode) = options.preserve_mode();
	if is_preserve_mode {
		org_mode
	} else if is_explicit_no_preserve_mode {
		MODE_RW_UGO
	} else {
		org_mode & S_IRWXUGO
	}
}

/// Copy the file from `source` to `dest` either using the normal copy or a
/// copy-on-write scheme if --reflink is specified and the filesystem
/// supports it.
fn copy_helper(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_metadata: &Metadata,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	if path_ends_with_terminator(dest) && !filesystem.is_dir(&dest_fs) {
		let error = if filesystem.exists(&dest_fs) {
			pi_vfs::not_a_directory()
		} else {
			io::Error::new(io::ErrorKind::NotFound, "No such file or directory")
		};
		return Err(CpError::IoErrContext(
			error,
			format!("cannot create regular file {}", dest.quote()),
		));
	}

	if options.recursive && !options.copy_contents {
		let file_type = source_metadata.file_type();
		if file_type.is_socket() {
			return copy_special(host, dest, options, NodeKind::Socket, 0o777);
		}
		if file_type.is_fifo() {
			return copy_special(host, dest, options, NodeKind::Fifo, 0o666);
		}
		if file_type.is_char_device() || file_type.is_block_device() {
			let rdev = source_metadata.rdev().ok_or_else(|| {
				CpError::IoErrContext(
					operation_not_supported(),
					format!("cannot create special file {}", dest.quote()),
				)
			})?;
			let kind = if file_type.is_char_device() {
				NodeKind::CharDevice(rdev)
			} else {
				NodeKind::BlockDevice(rdev)
			};
			return copy_special(host, dest, options, kind, source_metadata.mode() & 0o7777);
		}
	}

	if source_metadata.is_symlink() {
		copy_link(host, state, source, dest, options)?;
	} else {
		let copy_debug = copy_data(host, state, source, dest, options, source_metadata)?;

		if !options.attributes_only && options.debug {
			state.say(host, copy_debug);
		}
	}

	Ok(())
}

/// "Copies" a FIFO, socket, or device node by creating a new one with `mode`
/// at `dest`; its contents are not copied (see `--copy-contents`).
fn copy_special(
	host: &mut Host,
	dest: &Path,
	options: &Options,
	kind: NodeKind,
	mode: u32,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let dest_fs = host.resolve(dest);
	if filesystem.exists(&dest_fs) {
		options.overwrite.verify(host, dest, options.debug)?;
		filesystem.remove_file(&dest_fs)?;
	}

	match kind {
		NodeKind::Fifo => filesystem
			.make_fifo(&dest_fs, mode)
			.map_err(|e| CpError::IoErrContext(e, format!("cannot create fifo {}", dest.quote()))),
		// A native socket is made the portable way, by binding it.
		#[cfg(unix)]
		NodeKind::Socket if filesystem.is_native_local(&dest_fs) => {
			std::os::unix::net::UnixListener::bind(&dest_fs)
				.map(drop)
				.map_err(CpError::IoErr)
		},
		_ => filesystem.make_node(&dest_fs, kind, mode).map_err(|e| {
			CpError::IoErrContext(e, format!("cannot create special file {}", dest.quote()))
		}),
	}
}

fn copy_link(
	host: &mut Host,
	state: &mut CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
) -> CopyResult<()> {
	// Here, we will copy the symlink itself (actually, just recreate it); any
	// existing destination was removed by `copy_file`.
	let link = host.fs().read_link(host.resolve(source)).map_err(|e| {
		CpError::IoErrContext(e, format!("cannot read symbolic link {}", source.quote()))
	})?;
	symlink_file(host, state, &link, dest)?;
	copy_attributes(host, source, dest, &options.attributes, false, false, options.set_selinux_context)
}

/// Streams `source` into `dest` through their handles, polling cancellation
/// between chunks.
fn copy_stream_data(
	host: &Host,
	source_file: &File,
	dest_file: &File,
	source: &Path,
	dest: &Path,
) -> CopyResult<()> {
	let mut buffer = vec![0; COPY_BUFFER];
	let mut reader = source_file;
	let mut writer = dest_file;
	loop {
		if host.is_cancelled() {
			return Err(CpError::NotAllFilesCopied);
		}
		let read = match reader.read(&mut buffer) {
			Ok(0) => return Ok(()),
			Ok(read) => read,
			Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
			Err(error) => {
				return Err(CpError::IoErrContext(error, format!("error reading {}", source.quote())));
			},
		};
		writer
			.write_all(&buffer[..read])
			.map_err(|e| CpError::IoErrContext(e, format!("error writing {}", dest.quote())))?;
	}
}

/// Refuses `--reflink=always`/`--sparse=always` where the copy would have to
/// stream, rather than silently ignoring them.
fn check_streamed_modes(options: &Options, source: &Path, dest: &Path) -> CopyResult<()> {
	if options.reflink_mode == ReflinkMode::Always {
		return Err(CpError::IoErrContext(
			operation_not_supported(),
			format!("failed to clone {} from {}", dest.quote(), source.quote()),
		));
	}
	if options.sparse_mode == SparseMode::Always {
		return Err(CpError::IoErrContext(
			operation_not_supported(),
			format!("cannot create sparse file {}", dest.quote()),
		));
	}
	Ok(())
}

/// Copies the data of the regular file (or stream) `source` to `dest`.
///
/// Opens the source, then creates or truncates the destination, reporting
/// either failure as GNU does. Two native host files take the platform's
/// kernel fast paths; any other pair streams through the filesystem's handles
/// and refuses reflink/sparse requests it cannot honor.
fn copy_data(
	host: &mut Host,
	state: &CopyState,
	source: &Path,
	dest: &Path,
	options: &Options,
	source_metadata: &Metadata,
) -> CopyResult<CopyDebug> {
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let dest_fs = host.resolve(dest);
	let source_is_stream = is_stream(source_metadata);
	let native = filesystem.is_native_local(&source_fs) && filesystem.is_native_local(&dest_fs);

	if !native && !source_is_stream {
		check_streamed_modes(options, source, dest)?;
	}

	#[cfg(target_os = "macos")]
	let mut reflink_debug = OffloadReflinkDebug::No;
	#[cfg(target_os = "macos")]
	if native && !source_is_stream {
		if options.sparse_mode == SparseMode::Always {
			return Err(CpError::Error("--sparse is only supported on linux".to_string()));
		}
		if macos::clone(&filesystem, &source_fs, &dest_fs, options.reflink_mode, source, dest)? {
			// A clone carries the source's timestamps; an ordinary copy is new.
			if !matches!(options.attributes.timestamps, Preserve::Yes { .. }) {
				filesystem
					.set_times(&dest_fs, FileTime::Now, FileTime::Now, true)
					.map_err(|e| CpError::IoErrContext(e, context_for(source, dest)))?;
			}
			return Ok(CopyDebug {
				offload:          OffloadReflinkDebug::Unknown,
				reflink:          OffloadReflinkDebug::Yes,
				sparse_detection: SparseDebug::Unsupported,
			});
		}
		if options.reflink_mode != ReflinkMode::Never {
			reflink_debug = OffloadReflinkDebug::Unsupported;
		}
	}

	#[cfg(not(any(target_os = "linux", target_os = "android", target_os = "macos")))]
	if native && !source_is_stream {
		if options.reflink_mode != ReflinkMode::Never {
			return Err(CpError::Error("--reflink is only supported on linux and macOS".to_string()));
		}
		if options.sparse_mode == SparseMode::Always {
			return Err(CpError::Error("--sparse is only supported on linux".to_string()));
		}
	}

	let source_file = filesystem.open(&source_fs).map_err(|e| {
		CpError::IoErrContext(e, format!("cannot open {} for reading", source.quote()))
	})?;
	// A stream destination (a FIFO, a device) is written, not truncated.
	// Owner-writable until the final permissions are applied, so a handle can
	// still be reopened to preserve timestamps.
	let create_mode =
		if source_is_stream { 0o622 } else { (source_metadata.permissions().mode() & 0o777) | 0o200 };
	let mut dest_options = OpenOptions::new();
	dest_options
		.write(true)
		.create(true)
		.truncate(!source_is_stream)
		.mode(create_mode);
	let cannot_create =
		|e| CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()));
	let dest_file = match filesystem.open_with(&dest_fs, &dest_options) {
		Ok(file) => file,
		// `-f`: remove a destination that cannot be opened, and try again.
		Err(_) if options.unlink_after_failed_open() && filesystem.symlink_metadata(&dest_fs).is_ok() => {
			delete_path(host, state, dest, options)?;
			filesystem
				.open_with(&dest_fs, &dest_options)
				.map_err(cannot_create)?
		},
		Err(error) => return Err(cannot_create(error)),
	};

	let copy_debug = if source_is_stream {
		let dest_is_stream = dest_file.metadata().is_ok_and(|metadata| is_stream(&metadata));
		if !dest_is_stream {
			dest_file.set_len(0).map_err(|e| {
				CpError::IoErrContext(e, format!("cannot create regular file {}", dest.quote()))
			})?;
		}
		copy_stream_data(host, &source_file, &dest_file, source, dest)?;
		CopyDebug { offload: OffloadReflinkDebug::Avoided, ..CopyDebug::STREAMED }
	} else {
		#[cfg(any(target_os = "linux", target_os = "android"))]
		let fast = match (native, source_file.native(), dest_file.native()) {
			(true, Some(source_native), Some(dest_native)) => {
				let dest_is_fifo = dest_native
					.metadata()
					.is_ok_and(|metadata| std::os::unix::fs::FileTypeExt::is_fifo(&metadata.file_type()));
				Some(linux::copy(
					source_native,
					dest_native,
					dest_is_fifo,
					options.reflink_mode,
					options.sparse_mode,
					source,
					dest,
				)?)
			},
			_ => None,
		};
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		let fast: Option<CopyDebug> = None;

		match fast {
			Some(copy_debug) => copy_debug,
			None => {
				copy_stream_data(host, &source_file, &dest_file, source, dest)?;
				#[cfg(target_os = "macos")]
				{
					CopyDebug { reflink: reflink_debug, ..CopyDebug::STREAMED }
				}
				#[cfg(not(target_os = "macos"))]
				{
					CopyDebug::STREAMED
				}
			},
		}
	};

	drop(source_file);
	dest_file
		.close()
		.map_err(|e| CpError::IoErrContext(e, format!("failed to close {}", dest.quote())))?;
	Ok(copy_debug)
}

/// Generate an error message if `target` is not the correct `target_type`
fn verify_target_type(host: &Host, target: &Path, target_type: TargetType) -> CopyResult<()> {
	match (target_type, host.fs().metadata(host.resolve(target))) {
		(TargetType::Directory, Ok(metadata)) if !metadata.is_dir() => Err(CpError::IoErrContext(
			pi_vfs::not_a_directory(),
			format!("target {}", target.quote()),
		)),
		(TargetType::Directory, Err(error)) => {
			Err(CpError::IoErrContext(error, format!("target {}", target.quote())))
		},
		(TargetType::File, Ok(metadata)) if metadata.is_dir() => Err(CpError::Error(format!(
			"cannot overwrite directory {} with non-directory",
			target.quote()
		))),
		_ => Ok(()),
	}
}

/// Get the total size of a slice of files and directories, like `du`.
///
/// Files are not deduplicated when appearing in multiple sources, and
/// directories only count when copying recursively. Unreadable entries count
/// as empty; the copy itself reports them.
fn disk_usage(host: &Host, paths: &[PathBuf], recursive: bool) -> u64 {
	let filesystem = host.fs();
	paths
		.iter()
		.map(|path| {
			let resolved = host.resolve(path);
			match filesystem.metadata(&resolved) {
				Ok(metadata) if metadata.is_dir() => {
					if recursive { disk_usage_directory(host, &resolved) } else { 0 }
				},
				Ok(metadata) => metadata.len(),
				Err(_) => 0,
			}
		})
		.sum()
}

/// A helper for `disk_usage` specialized for directories.
fn disk_usage_directory(host: &Host, path: &Path) -> u64 {
	let Ok(entries) = host.fs().read_dir(path) else {
		return 0;
	};
	entries
		.flatten()
		.map(|entry| {
			if host.is_cancelled() {
				return 0;
			}
			match entry.metadata() {
				Ok(metadata) if metadata.is_dir() => disk_usage_directory(host, &entry.path()),
				Ok(metadata) => metadata.len(),
				Err(_) => 0,
			}
		})
		.sum()
}

/// Traversal state of one `cp -r` operand.
struct Walk<'a> {
	options:   &'a Options,
	/// Device of the operand, for `-x`.
	root_dev:  Option<u64>,
	/// Identities of the directories being copied, outermost first.
	ancestors: Vec<FileId>,
	/// Whether an entry failed after its diagnostic was printed.
	failed:    bool,
}

impl Walk<'_> {
	/// Whether to descend into the directory `source`: not across a `-x`
	/// filesystem boundary, and not into one of its own ancestors (reachable
	/// through a followed symlink). `Some(true)` when its identity was pushed
	/// onto [`Walk::ancestors`], to be popped once its contents are copied.
	fn enter(&mut self, host: &mut Host, source: &Path, is_root: bool) -> Option<bool> {
		let Ok(metadata) = host.fs().metadata(host.resolve(source)) else {
			return Some(false);
		};
		if !is_root
			&& self.options.one_file_system
			&& let (Some(root_dev), Some(dev)) = (self.root_dev, metadata.dev())
			&& root_dev != dev
		{
			return None;
		}
		let Some(id) = metadata.file_id() else {
			return Some(false);
		};
		if self.ancestors.contains(&id) {
			show_error(host, format_args!("{}: file system loop detected", source.quote()));
			self.failed = true;
			return None;
		}
		self.ancestors.push(id);
		Some(true)
	}
}

/// Read the contents of the directory `root` and recursively copy the
/// contents to `target`.
///
/// Errors inside the tree are reported and the traversal continues, as GNU
/// cp does; the operand then fails as a whole.
fn copy_directory(
	host: &mut Host,
	state: &mut CopyState,
	root: &Path,
	target: &Path,
	options: &Options,
) -> CopyResult<()> {
	if !options.recursive {
		return Err(CpError::Error(format!(
			"-r not specified; omitting directory {}",
			root.quote()
		)));
	}

	let filesystem = host.fs().clone();

	// If in `--parents` mode, create all the necessary ancestor directories.
	//
	// For example, if the command is `cp --parents a/b/c d`, that
	// means we need to copy the two ancestor directories first:
	//
	// a -> d/a
	// a/b -> d/a/b
	let target: PathBuf = match parent_path(root) {
		Some(parent) if options.parents && !parent.as_os_str().is_empty() => {
			make_parent_dirs(host, state, root, &join_path(target, &parents_relative(root)), options)?;
			join_path(target, &parents_relative(parent))
		},
		_ => target.to_path_buf(),
	};

	// The copy of `root`: `target` itself, unless it is an existing directory
	// the copy goes into (`dir/.` into `target/.`, the contents). `-T` copies
	// the contents into `target`.
	let root_dest = match filesystem.metadata(host.resolve(&target)) {
		Ok(metadata) if !metadata.is_dir() => {
			return Err(CpError::Error(format!(
				"cannot overwrite non-directory {} with directory {}",
				target.quote(),
				root.quote()
			)));
		},
		Ok(_) if !options.no_target_dir => {
			if root == Path::new(".") || root.as_os_str().as_encoded_bytes().ends_with(b"/.") {
				child_path(&target, std::ffi::OsStr::new("."))
			} else {
				match file_name(root) {
					Some(name) => child_path(&target, &name),
					None => target.clone(),
				}
			}
		},
		_ => target.clone(),
	};

	// check if root is a prefix of target
	let logical = CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Logical);
	if let (Ok(root_canonical), Ok(dest_canonical)) = (
		filesystem.canonicalize_with(host.resolve(root), &logical),
		filesystem.canonicalize_with(host.resolve(&root_dest), &logical),
	) {
		if root_canonical == dest_canonical {
			return Err(CpError::Error(format!(
				"{} and {} are the same file",
				root.quote(),
				root_dest.quote()
			)));
		}
		if dest_canonical.starts_with(&root_canonical) {
			return Err(CpError::Error(format!(
				"cannot copy a directory, {}, into itself, {}",
				root.quote(),
				root_dest.quote()
			)));
		}
	}

	let mut walk = Walk {
		options,
		root_dev: filesystem
			.metadata(host.resolve(root))
			.ok()
			.and_then(|metadata| metadata.dev()),
		ancestors: Vec::new(),
		failed: false,
	};
	copy_entry(host, state, &mut walk, root, &root_dest, true)?;

	// Also fix permissions for parent directories,
	// if we were asked to create them.
	if options.parents
		&& let Some(name) = file_name(root)
	{
		let dest = child_path(&target, &name);
		for (x, y) in aligned_ancestors(root, &dest) {
			if let Ok(src) = filesystem.canonicalize_with(
				host.resolve(&x),
				&CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Physical),
			) {
				copy_attributes(host, &src, &y, &options.attributes, false, true, options.set_selinux_context)?;
			}
		}
	}

	if walk.failed { Err(CpError::NotAllFilesCopied) } else { Ok(()) }
}

/// Copies one entry of a directory tree: a directory recursively (fixing its
/// attributes once its contents are in place), anything else as a file.
fn copy_entry(
	host: &mut Host,
	state: &mut CopyState,
	walk: &mut Walk<'_>,
	source: &Path,
	dest: &Path,
	is_root: bool,
) -> CopyResult<()> {
	let options = walk.options;
	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let metadata = filesystem
		.symlink_metadata(&source_fs)
		.map_err(|e| CpError::IoErrContext(e, format!("cannot stat {}", source.quote())))?;
	let entry_is_symlink = metadata.is_symlink();
	// The operand itself was already judged a directory to copy.
	let source_is_dir = if is_root {
		true
	} else if entry_is_symlink {
		options.dereference && filesystem.is_dir(&source_fs)
	} else {
		metadata.is_dir()
	};

	if !source_is_dir {
		return match copy_file(host, state, source, dest, options, false) {
			// With --archive a symlink may be copied before the file it names.
			Err(_) if options.preserve_hard_links() && entry_is_symlink => Ok(()),
			result => result,
		};
	}

	let created = match filesystem.metadata(host.resolve(dest)) {
		Err(_) => {
			build_dir(host, dest, false, options, Some(source))?;
			if options.verbose {
				state.say(host, context_for(source, dest));
			}
			true
		},
		Ok(existing) if !existing.is_dir() => {
			return Err(CpError::Error(format!(
				"cannot overwrite non-directory {} with directory {}",
				dest.quote(),
				source.quote()
			)));
		},
		Ok(_) => false,
	};

	if let Some(pushed) = walk.enter(host, source, is_root) {
		match filesystem.read_dir(&source_fs) {
			Err(error) => {
				show_error(host, CpError::IoErrContext(error, format!("cannot access {}", source.quote())));
				walk.failed = true;
			},
			Ok(entries) => {
				for entry in entries {
					if host.is_cancelled() {
						walk.failed = true;
						break;
					}
					let entry = match entry {
						Ok(entry) => entry,
						Err(error) => {
							show_error(
								host,
								CpError::IoErrContext(error, format!("cannot access {}", source.quote())),
							);
							walk.failed = true;
							continue;
						},
					};
					let name = entry.file_name();
					let child_source = child_path(source, &name);
					let child_dest = child_path(dest, &name);
					if let Err(error) = copy_entry(host, state, walk, &child_source, &child_dest, false) {
						show_error_if_needed(host, &error);
						if !matches!(error, CpError::Skipped(false)) {
							walk.failed = true;
						}
					}
				}
			},
		}
		if pushed {
			walk.ancestors.pop();
		}
	}

	// Directories are created without some permissions so nobody can use
	// them before they are ready; now that the contents are in place, give
	// the directory its final attributes.
	copy_attributes(
		host,
		source,
		dest,
		&options.attributes,
		created && options.copy_mode != CopyMode::Link,
		true,
		options.set_selinux_context,
	)
}

/// Builds a directory at the specified path with the given options.
///
/// If `copy_attributes_from` is `Some`, the new directory's mode starts from
/// that file's; otherwise from the umask. Group/other permissions are held
/// back while ownership or mode could still change (see
/// `test_dir_perm_race_with_preserve_mode_and_ownership`), and the owner
/// write bit is kept so the contents can be copied in; the final attributes
/// are applied afterwards. `recursive` creates missing parents too.
fn build_dir(
	host: &mut Host,
	path: &Path,
	recursive: bool,
	options: &Options,
	copy_attributes_from: Option<&Path>,
) -> CopyResult<()> {
	let filesystem = host.fs().clone();
	let mut excluded_perms = if matches!(options.attributes.ownership, Preserve::Yes { .. }) {
		0o077 // exclude rwx for group and other
	} else if matches!(options.attributes.mode, Preserve::Yes { .. }) {
		0o022 // exclude w for group and other
	} else {
		0
	};

	excluded_perms |= match (copy_attributes_from, options.attributes.mode) {
		(Some(from), Preserve::Yes { .. }) => {
			!filesystem
				.symlink_metadata(host.resolve(from))?
				.permissions()
				.mode()
		},
		_ => umask(),
	};

	let mode = (!excluded_perms & 0o777) | 0o200;
	filesystem
		.create_dir_with(host.resolve(path), &DirOptions::new().recursive(recursive).mode(mode))
		.map_err(|e| CpError::IoErrContext(e, format!("cannot create directory {}", path.quote())))
}

/// Native macOS copy-on-write through `clonefile(2)`.
#[cfg(target_os = "macos")]
mod macos {
	use std::{ffi::CString, io, os::unix::ffi::OsStrExt as _, path::Path};

	use pi_vfs::BlockingFs;
	use uucore::display::Quotable;

	use super::{CopyResult, CpError, ReflinkMode};

	/// `clonefile(source, dest)` on native paths.
	fn clonefile(source: &Path, dest: &Path) -> io::Result<()> {
		let source = CString::new(source.as_os_str().as_bytes())?;
		let dest = CString::new(dest.as_os_str().as_bytes())?;
		// SAFETY: both strings are NUL-terminated and outlive the call.
		if unsafe { libc::clonefile(source.as_ptr(), dest.as_ptr(), 0) } == 0 {
			Ok(())
		} else {
			Err(io::Error::last_os_error())
		}
	}

	/// Tries to clone the native file `source_fs` to `dest_fs`; `Ok(false)`
	/// means the caller copies the data instead.
	///
	/// `clonefile` cannot overwrite, so with `--reflink=auto` an existing
	/// destination is copied into in place (keeping its identity, as GNU
	/// does); `--reflink=always` replaces a writable one.
	pub(super) fn clone(
		filesystem: &BlockingFs,
		source_fs: &Path,
		dest_fs: &Path,
		reflink_mode: ReflinkMode,
		source: &Path,
		dest: &Path,
	) -> CopyResult<bool> {
		let dest_exists = filesystem.symlink_metadata(dest_fs).is_ok();
		match reflink_mode {
			ReflinkMode::Never => Ok(false),
			ReflinkMode::Auto if dest_exists => Ok(false),
			ReflinkMode::Auto => Ok(clonefile(source_fs, dest_fs).is_ok()),
			ReflinkMode::Always => {
				let mut result = clonefile(source_fs, dest_fs);
				if result
					.as_ref()
					.is_err_and(|error| error.kind() == io::ErrorKind::AlreadyExists)
					&& source_fs != dest_fs
					&& filesystem
						.metadata(dest_fs)
						.is_ok_and(|metadata| !metadata.permissions().readonly())
				{
					let _ = filesystem.remove_file(dest_fs);
					result = clonefile(source_fs, dest_fs);
				}
				result.map(|()| true).map_err(|error| {
					CpError::IoErrContext(
						error,
						format!("failed to clone {} from {}", dest.quote(), source.quote()),
					)
				})
			},
		}
	}
}

/// Native Linux copies: `FICLONE`, `copy_file_range` (through `io::copy`),
/// and `SEEK_DATA`/`SEEK_HOLE` sparse copies on already opened descriptors.
#[cfg(any(target_os = "linux", target_os = "android"))]
mod linux {
	use std::{
		fs::File,
		io::{self, Read as _, Seek as _, SeekFrom},
		os::{
			fd::AsRawFd as _,
			unix::fs::{FileExt as _, MetadataExt as _},
		},
		path::Path,
	};

	use uucore::display::Quotable;

	use super::{
		CopyDebug, CopyResult, CpError, OffloadReflinkDebug, ReflinkMode, SparseDebug, SparseMode,
		context_for,
	};

	/// The fallback behavior for [`clone`] on failed system call.
	#[derive(Clone, Copy)]
	enum CloneFallback {
		/// Raise an error.
		Error,
		/// Use a plain kernel copy.
		FSCopy,
		/// Use [`sparse_copy`]
		SparseCopy,
		/// Use [`sparse_copy_without_hole`]
		SparseCopyWithoutHole,
	}

	/// Type of method used for copying files
	#[derive(Clone, Copy)]
	enum CopyMethod {
		/// Do a sparse copy
		SparseCopy,
		/// Use a plain kernel copy.
		FSCopy,
		/// Default (can either be [`CopyMethod::SparseCopy`] or
		/// [`CopyMethod::FSCopy`])
		Default,
		/// Use [`sparse_copy_without_hole`]
		SparseCopyWithoutHole,
	}

	/// Copies all of `source` into `dest` from their current offsets;
	/// `io::copy` uses `copy_file_range`/`sendfile` between files.
	fn fs_copy(source: &File, dest: &File) -> io::Result<()> {
		io::copy(&mut &*source, &mut &*dest).map(drop)
	}

	/// Use the Linux `ioctl_ficlone` API to do a copy-on-write clone.
	///
	/// `fallback` controls what to do if the system call fails.
	fn clone(source: &File, dest: &File, fallback: CloneFallback) -> io::Result<()> {
		// SAFETY: both descriptors are borrowed from live files for the call.
		let result = unsafe { libc::ioctl(dest.as_raw_fd(), libc::FICLONE, source.as_raw_fd()) };
		if result == 0 {
			return Ok(());
		}
		let error = io::Error::last_os_error();
		match fallback {
			CloneFallback::Error => Err(error),
			CloneFallback::FSCopy => fs_copy(source, dest),
			CloneFallback::SparseCopy => sparse_copy(source, dest),
			CloneFallback::SparseCopyWithoutHole => sparse_copy_without_hole(source, dest),
		}
	}

	/// Checks whether a file contains any non null bytes i.e. any byte != 0x0
	/// This function returns a tuple of (bool, u64, u64) signifying a tuple of
	/// (whether a file has data, its size, no of blocks it has allocated in
	/// disk). The file offset is left at the start.
	fn check_for_data(source: &File) -> io::Result<(bool, u64, u64)> {
		let metadata = source.metadata()?;

		let size = metadata.size();
		let blocks = metadata.blocks();
		// checks edge case of virtual files in /proc which have a size of zero
		// but contains data
		if size == 0 {
			let mut buf = vec![0; usize::try_from(metadata.blksize()).unwrap_or(4096)];
			let read = source.read_at(&mut buf, 0)?;
			return Ok((buf[..read].iter().any(|&x| x != 0x0), size, 0));
		}

		// SAFETY: plain `lseek` on a live descriptor.
		let result = unsafe { libc::lseek(source.as_raw_fd(), 0, libc::SEEK_DATA) };
		let error = io::Error::last_os_error();
		(&*source).seek(SeekFrom::Start(0))?;

		match result {
			-1 => Ok((false, size, blocks)), // No data found or end of file
			_ if result >= 0 => Ok((true, size, blocks)), // Data found
			_ => Err(error),
		}
	}

	/// Checks whether a file is sparse i.e. it contains holes, uses the crude
	/// heuristic blocks < size / 512
	/// Reference:`<https://doc.rust-lang.org/std/os/unix/fs/trait.MetadataExt.html#tymethod.blocks>`
	fn check_sparse_detection(source: &File) -> io::Result<bool> {
		let metadata = source.metadata()?;
		Ok(metadata.blocks() < metadata.size() / 512)
	}

	/// Converts a byte offset for `lseek`/`pread`.
	fn offset(value: u64) -> io::Result<libc::off_t> {
		libc::off_t::try_from(value).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
	}

	/// Optimized [`sparse_copy`] doesn't create holes for large sequences of
	/// zeros in non `sparse_files` Used when `--sparse=auto`
	fn sparse_copy_without_hole(source: &File, dest: &File) -> io::Result<()> {
		let size = source.metadata()?.size();
		dest.set_len(size)?;
		let src_fd = source.as_raw_fd();
		// Maximize the data read at once to 16 MiB to avoid memory hogging with
		// large files; 16 MiB chunks should saturate an SSD
		let step = usize::try_from(size.min(16 * 1024 * 1024)).unwrap_or(16 * 1024 * 1024);
		let mut buf: Vec<u8> = vec![0x0; step];
		let mut current: libc::off_t = 0;
		loop {
			// SAFETY: plain `lseek` on a live descriptor.
			let data = unsafe { libc::lseek(src_fd, current, libc::SEEK_DATA) };
			if data < 0 {
				break;
			}
			// SAFETY: plain `lseek` on a live descriptor.
			let hole = unsafe { libc::lseek(src_fd, data, libc::SEEK_HOLE) };
			if hole < 0 {
				break;
			}
			let mut position = u64::try_from(data).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
			let end = u64::try_from(hole).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
			// Read and write data in chunks of `step` while reusing the same
			// buffer
			while position < end {
				let len = usize::try_from(end - position).map_or(step, |len| len.min(step));
				let chunk = &mut buf[..len];
				source.read_exact_at(chunk, position)?;
				dest.write_all_at(chunk, position)?;
				position += u64::try_from(len).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
			}
			current = offset(end)?;
		}
		Ok(())
	}

	/// Perform a sparse copy from one file to another.
	/// Creates a holes for large sequences of zeros in `non_sparse_files`,
	/// used for `--sparse=always`
	fn sparse_copy(source: &File, dest: &File) -> io::Result<()> {
		let size = source.metadata()?.size();
		dest.set_len(size)?;

		let blksize = usize::try_from(dest.metadata()?.blksize()).unwrap_or(4096).max(1);
		let mut buf: Vec<u8> = vec![0; blksize];
		let mut current: u64 = 0;

		while current < size {
			let this_read = (&*source).read(&mut buf)?;
			if this_read == 0 {
				break;
			}
			let buf = &buf[..this_read];
			if buf.iter().any(|&x| x != 0) {
				dest.write_all_at(buf, current)?;
			}
			current += u64::try_from(this_read).map_err(|_| io::Error::from(io::ErrorKind::InvalidData))?;
		}
		Ok(())
	}

	/// Copies the native file `source` into the freshly truncated `dest`
	/// using copy-on-write if possible.
	pub(super) fn copy(
		source: &File,
		dest: &File,
		dest_is_fifo: bool,
		reflink_mode: ReflinkMode,
		sparse_mode: SparseMode,
		source_path: &Path,
		dest_path: &Path,
	) -> CopyResult<CopyDebug> {
		let mut copy_debug = CopyDebug {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          OffloadReflinkDebug::Unsupported,
			sparse_detection: SparseDebug::No,
		};
		let result = match (reflink_mode, sparse_mode) {
			(ReflinkMode::Never, SparseMode::Always) => {
				copy_debug.sparse_detection = SparseDebug::Zeros;
				copy_debug.reflink = OffloadReflinkDebug::No;
				let mut copy_method = CopyMethod::Default;
				if let Ok((debug, method)) = handle_reflink_never_sparse_always(source, dest_is_fifo) {
					copy_debug = debug;
					copy_method = method;
				}
				match copy_method {
					CopyMethod::FSCopy => fs_copy(source, dest),
					_ => sparse_copy(source, dest),
				}
			},
			(ReflinkMode::Never, SparseMode::Never) => {
				copy_debug.reflink = OffloadReflinkDebug::No;
				if let Ok(debug) = handle_reflink_never_sparse_never(source) {
					copy_debug = debug;
				}
				fs_copy(source, dest)
			},
			(ReflinkMode::Never, SparseMode::Auto) => {
				copy_debug.reflink = OffloadReflinkDebug::No;
				let mut copy_method = CopyMethod::Default;
				if let Ok((debug, method)) = handle_reflink_never_sparse_auto(source, dest_is_fifo) {
					copy_debug = debug;
					copy_method = method;
				}
				match copy_method {
					CopyMethod::SparseCopyWithoutHole => sparse_copy_without_hole(source, dest),
					_ => fs_copy(source, dest),
				}
			},
			(ReflinkMode::Auto, SparseMode::Always) => {
				copy_debug.sparse_detection = SparseDebug::Zeros;
				let mut copy_method = CopyMethod::Default;
				if let Ok((debug, method)) = handle_reflink_auto_sparse_always(source, dest_is_fifo) {
					copy_debug = debug;
					copy_method = method;
				}
				match copy_method {
					CopyMethod::FSCopy => clone(source, dest, CloneFallback::FSCopy),
					_ => clone(source, dest, CloneFallback::SparseCopy),
				}
			},
			(ReflinkMode::Auto, SparseMode::Never) => {
				copy_debug.reflink = OffloadReflinkDebug::No;
				if let Ok(debug) = handle_reflink_auto_sparse_never(source) {
					copy_debug = debug;
				}
				clone(source, dest, CloneFallback::FSCopy)
			},
			(ReflinkMode::Auto, SparseMode::Auto) => {
				let mut copy_method = CopyMethod::Default;
				if let Ok((debug, method)) = handle_reflink_auto_sparse_auto(source, dest_is_fifo) {
					copy_debug = debug;
					copy_method = method;
				}
				match copy_method {
					CopyMethod::SparseCopyWithoutHole => {
						clone(source, dest, CloneFallback::SparseCopyWithoutHole)
					},
					_ => clone(source, dest, CloneFallback::FSCopy),
				}
			},
			(ReflinkMode::Always, SparseMode::Auto) => {
				copy_debug.sparse_detection = SparseDebug::No;
				copy_debug.reflink = OffloadReflinkDebug::Yes;

				return clone(source, dest, CloneFallback::Error).map(|()| copy_debug).map_err(
					|error| {
						CpError::IoErrContext(
							error,
							format!("failed to clone {} from {}", dest_path.quote(), source_path.quote()),
						)
					},
				);
			},
			(ReflinkMode::Always, _) => {
				return Err(CpError::Usage(
					"--reflink can be used only with --sparse=auto".to_string(),
				));
			},
		};
		result.map_err(|e| CpError::IoErrContext(e, context_for(source_path, dest_path)))?;
		Ok(copy_debug)
	}

	/// Handles debug results when flags are "--reflink=auto" and
	/// "--sparse=always" and specifies what type of copy should be used
	fn handle_reflink_auto_sparse_always(
		source: &File,
		dest_is_fifo: bool,
	) -> io::Result<(CopyDebug, CopyMethod)> {
		let mut copy_debug = CopyDebug {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          OffloadReflinkDebug::Unsupported,
			sparse_detection: SparseDebug::Zeros,
		};
		let mut copy_method = CopyMethod::Default;
		let (data_flag, size, blocks) = check_for_data(source)?;
		let sparse_flag = check_sparse_detection(source)?;

		if data_flag || size < 512 {
			copy_debug.offload = OffloadReflinkDebug::Avoided;
		}
		match (sparse_flag, data_flag, blocks) {
			(true, true, 0) => {
				// Handling funny files with 0 block allocation but has data
				// in it
				copy_method = CopyMethod::FSCopy;
				copy_debug.sparse_detection = SparseDebug::SeekHoleZeros;
			},
			(false, true, 0) => copy_method = CopyMethod::FSCopy,

			(true, false, 0) | (true, false, _) => copy_debug.sparse_detection = SparseDebug::SeekHole,
			(true, true, _) => copy_debug.sparse_detection = SparseDebug::SeekHoleZeros,

			(_, _, _) => (),
		}
		if dest_is_fifo {
			copy_method = CopyMethod::FSCopy;
		}
		Ok((copy_debug, copy_method))
	}

	/// Handles debug results when flags are "--reflink=never" and
	/// "--sparse=never"
	fn handle_reflink_never_sparse_never(source: &File) -> io::Result<CopyDebug> {
		let mut copy_debug = CopyDebug {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          OffloadReflinkDebug::No,
			sparse_detection: SparseDebug::No,
		};
		let (data_flag, size, _blocks) = check_for_data(source)?;
		let sparse_flag = check_sparse_detection(source)?;

		if sparse_flag {
			copy_debug.sparse_detection = SparseDebug::SeekHole;
		}

		if data_flag || size < 512 {
			copy_debug.offload = OffloadReflinkDebug::Avoided;
		}
		Ok(copy_debug)
	}

	/// Handles debug results when flags are "--reflink=auto" and
	/// "--sparse=never", files will be copied through cloning them with
	/// fallback switching to a plain kernel copy
	fn handle_reflink_auto_sparse_never(source: &File) -> io::Result<CopyDebug> {
		let mut copy_debug = CopyDebug {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          OffloadReflinkDebug::No,
			sparse_detection: SparseDebug::No,
		};

		let (data_flag, size, _blocks) = check_for_data(source)?;
		let sparse_flag = check_sparse_detection(source)?;

		if sparse_flag {
			copy_debug.sparse_detection = SparseDebug::SeekHole;
		}

		if data_flag || size < 512 {
			copy_debug.offload = OffloadReflinkDebug::Avoided;
		}
		Ok(copy_debug)
	}

	/// Handles debug results when flags are "--reflink=auto" and
	/// "--sparse=auto" and specifies what type of copy should be used
	fn handle_reflink_auto_sparse_auto(
		source: &File,
		dest_is_fifo: bool,
	) -> io::Result<(CopyDebug, CopyMethod)> {
		let mut copy_debug = CopyDebug {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          OffloadReflinkDebug::Unsupported,
			sparse_detection: SparseDebug::No,
		};

		let mut copy_method = CopyMethod::Default;
		let (data_flag, size, blocks) = check_for_data(source)?;
		let sparse_flag = check_sparse_detection(source)?;

		if (data_flag && size != 0) || (size > 0 && size < 512) {
			copy_debug.offload = OffloadReflinkDebug::Yes;
		}

		if data_flag && size == 0 {
			// Handling /proc/ files
			copy_debug.offload = OffloadReflinkDebug::Unsupported;
		}
		if sparse_flag {
			if blocks == 0 && data_flag {
				// Handling other "virtual" files
				copy_debug.offload = OffloadReflinkDebug::Unsupported;

				copy_method = CopyMethod::FSCopy; // Doing a standard copy for the virtual files
			} else {
				copy_method = CopyMethod::SparseCopyWithoutHole;
			} // Since sparse_flag is true, sparse_detection shall be SeekHole for any non
			// virtual regular sparse file and the file will be sparsely copied
			copy_debug.sparse_detection = SparseDebug::SeekHole;
		}

		if dest_is_fifo {
			copy_method = CopyMethod::FSCopy;
		}
		Ok((copy_debug, copy_method))
	}

	/// Handles debug results when flags are "--reflink=never" and
	/// "--sparse=auto" and specifies what type of copy should be used
	fn handle_reflink_never_sparse_auto(
		source: &File,
		dest_is_fifo: bool,
	) -> io::Result<(CopyDebug, CopyMethod)> {
		let mut copy_debug = CopyDebug {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          OffloadReflinkDebug::No,
			sparse_detection: SparseDebug::No,
		};

		let (data_flag, size, blocks) = check_for_data(source)?;
		let sparse_flag = check_sparse_detection(source)?;

		let mut copy_method = CopyMethod::Default;
		if data_flag || size < 512 {
			copy_debug.offload = OffloadReflinkDebug::Avoided;
		}

		if sparse_flag {
			if blocks == 0 && data_flag {
				// Handles virtual files which have size > 0 but no disk allocation
				copy_method = CopyMethod::FSCopy;
			} else {
				// Handles regular sparse-files
				copy_method = CopyMethod::SparseCopyWithoutHole;
			}
			copy_debug.sparse_detection = SparseDebug::SeekHole;
		}

		if dest_is_fifo {
			copy_method = CopyMethod::FSCopy;
		}
		Ok((copy_debug, copy_method))
	}

	/// Handles debug results when flags are "--reflink=never" and
	/// "--sparse=always" and specifies what type of copy should be used
	fn handle_reflink_never_sparse_always(
		source: &File,
		dest_is_fifo: bool,
	) -> io::Result<(CopyDebug, CopyMethod)> {
		let mut copy_debug = CopyDebug {
			offload:          OffloadReflinkDebug::Unknown,
			reflink:          OffloadReflinkDebug::No,
			sparse_detection: SparseDebug::Zeros,
		};
		let mut copy_method = CopyMethod::SparseCopy;

		let (data_flag, size, blocks) = check_for_data(source)?;
		let sparse_flag = check_sparse_detection(source)?;

		if data_flag || size < 512 {
			copy_debug.offload = OffloadReflinkDebug::Avoided;
		}
		match (sparse_flag, data_flag, blocks) {
			(true, true, 0) => {
				// Handling funny files with 0 block allocation but has data
				// in it, e.g. files in /sys and other virtual files
				copy_method = CopyMethod::FSCopy;
				copy_debug.sparse_detection = SparseDebug::SeekHoleZeros;
			},
			// Handling data containing zero sized files in /proc
			(false, true, 0) => copy_method = CopyMethod::FSCopy,
			// Handles files with 0 blocks allocated in disk
			(true, false, 0) => copy_debug.sparse_detection = SparseDebug::SeekHole,
			// Any sparse_files with data in it will display SeekHoleZeros
			(true, true, _) => copy_debug.sparse_detection = SparseDebug::SeekHoleZeros,
			(true, false, _) => {
				copy_debug.offload = OffloadReflinkDebug::Unknown;
				copy_debug.sparse_detection = SparseDebug::SeekHole;
			},

			(_, _, _) => (),
		}
		if dest_is_fifo {
			copy_method = CopyMethod::FSCopy;
		}

		Ok((copy_debug, copy_method))
	}
}

#[cfg(test)]
mod tests {
	use std::{
		fs,
		time::{Duration, SystemTime},
	};

	use tempfile::tempdir;

	use super::Cp;
	use crate::host::run_util;

	#[test]
	fn recursive_copy_creates_missing_target_then_nests_into_existing_one() {
		let fixture = tempdir().unwrap();
		fs::create_dir_all(fixture.path().join("src/sub")).unwrap();
		fs::write(fixture.path().join("src/top.txt"), b"top").unwrap();
		fs::write(fixture.path().join("src/sub/leaf.txt"), b"leaf").unwrap();

		let (code, capture) = run_util::<Cp>(&["-r", "src", "out"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("out/top.txt")).unwrap(), b"top");
		assert_eq!(fs::read(fixture.path().join("out/sub/leaf.txt")).unwrap(), b"leaf");

		// `out` now exists, so a second copy goes inside it.
		let (code, capture) = run_util::<Cp>(&["-r", "src", "out"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("out/src/sub/leaf.txt")).unwrap(), b"leaf");
	}

	#[test]
	fn no_clobber_keeps_existing_destination_and_succeeds() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();

		let (code, capture) = run_util::<Cp>(&["-n", "source", "target"], "", fixture.path());

		assert_eq!(code, 0);
		assert_eq!(capture.err(), "");
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"old");
	}

	#[test]
	fn target_directory_receives_every_source() {
		let fixture = tempdir().unwrap();
		fs::create_dir(fixture.path().join("dir")).unwrap();
		fs::write(fixture.path().join("a"), b"A").unwrap();
		fs::write(fixture.path().join("b"), b"B").unwrap();

		let (code, capture) = run_util::<Cp>(&["-t", "dir", "a", "b"], "", fixture.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("dir/a")).unwrap(), b"A");
		assert_eq!(fs::read(fixture.path().join("dir/b")).unwrap(), b"B");
	}

	#[test]
	fn missing_source_is_reported_and_remaining_sources_still_copy() {
		let fixture = tempdir().unwrap();
		fs::create_dir(fixture.path().join("dir")).unwrap();
		fs::write(fixture.path().join("present"), b"here").unwrap();

		let (code, capture) = run_util::<Cp>(&["missing", "present", "dir"], "", fixture.path());

		assert_eq!(code, 1);
		assert_eq!(capture.err(), "cp: cannot stat 'missing': No such file or directory\n");
		assert_eq!(fs::read(fixture.path().join("dir/present")).unwrap(), b"here");
	}

	#[test]
	fn directory_without_recursive_is_omitted() {
		let fixture = tempdir().unwrap();
		fs::create_dir(fixture.path().join("dir")).unwrap();
		fs::write(fixture.path().join("dir/file"), b"x").unwrap();

		let (code, capture) = run_util::<Cp>(&["dir", "out"], "", fixture.path());

		assert_eq!(code, 1);
		assert_eq!(capture.err(), "cp: -r not specified; omitting directory 'dir'\n");
		assert!(!fixture.path().join("out").exists());
	}

	#[test]
	fn preserve_keeps_modification_time_that_a_plain_copy_refreshes() {
		let fixture = tempdir().unwrap();
		let source = fixture.path().join("source");
		fs::write(&source, b"payload").unwrap();
		let past = SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000);
		fs::File::options()
			.write(true)
			.open(&source)
			.unwrap()
			.set_modified(past)
			.unwrap();

		let (code, capture) = run_util::<Cp>(&["-p", "source", "kept"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());
		let (code, capture) = run_util::<Cp>(&["source", "fresh"], "", fixture.path());
		assert_eq!(code, 0, "{}", capture.err());

		let modified = |name: &str| fs::metadata(fixture.path().join(name)).unwrap().modified().unwrap();
		assert_eq!(modified("kept"), past);
		assert_ne!(modified("fresh"), past);
	}
}
