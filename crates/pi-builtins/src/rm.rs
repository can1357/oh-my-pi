//! `rm` builtin: remove files and directory trees.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(unix)]
use std::os::unix::ffi::OsStrExt;
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
	ffi::{OsStr, OsString},
	fs::{self, Metadata},
	fmt,
	io::{self, Read, Write},
	ops::BitOr,
	path::{MAIN_SEPARATOR, Path},
};

use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{PossibleValue, ValueParser},
	parser::ValueSource,
};
use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle, TermLike};
use parking_lot::Mutex;
use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use thiserror::Error;
use uucore::{display::Quotable, parser::shortcut_value_parser::ShortcutValueParser};

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

macro_rules! show_error {
	($host:expr, $($args:tt)+) => {{
		$host.error(format_args!($($args)+), 1);
	}};
}

macro_rules! prompt_yes {
	($host:expr, $($args:tt)+) => {{
		use std::io::Write as _;
		let _ = write!($host.stderr, "rm: ");
		let _ = write!($host.stderr, $($args)+);
		let _ = write!($host.stderr, " ");
		let _ = $host.stderr.flush();
		$crate::rm::read_yes($host)
	}};
}

fn read_yes(host: &mut Host) -> bool {
	let mut byte = [0u8; 1];
	let mut first = None;
	loop {
		match host.stdin.read(&mut byte) {
			Ok(0) => break,
			Err(_) => return false,
			Ok(_) if byte[0] == b'\n' => break,
			Ok(_) => first.get_or_insert(byte[0]),
		};
	}
	matches!(first, Some(b'y' | b'Y'))
}

#[cfg(unix)]
mod platform {
// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// Unix-specific implementations for the rm utility


use std::{ffi::OsStr, fs, os::unix::fs::PermissionsExt, path::Path};

use indicatif::ProgressBar;
use uucore::{display::Quotable, safe_traversal::{DirFd, SymlinkBehavior}};

use super::{
	Host,
	InteractiveMode, Options, is_dir_empty, is_readable_metadata, prompt_descend, remove_file,
	show_permission_denied_error, show_removal_error, verbose_removed_directory,
	verbose_removed_file,
};

#[inline]
fn mode_readable(mode: libc::mode_t) -> bool {
	(mode & libc::S_IRUSR) != 0
}

#[inline]
fn mode_writable(mode: libc::mode_t) -> bool {
	(mode & libc::S_IWUSR) != 0
}

/// File prompt that reuses existing stat data to avoid extra statx calls
fn prompt_file_with_stat(host: &mut Host, path: &Path, stat: &libc::stat, options: &Options) -> bool {
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let is_symlink = ((stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFLNK;
	let writable = mode_writable(stat.st_mode as libc::mode_t);
	let len = stat.st_size as u64;
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);

	// Match original behaviour:
	// - Interactive::Always: always prompt; use non-protected wording when
	//   writable, otherwise fall through to protected wording.
	if options.interactive == InteractiveMode::Always {
		if is_symlink {
			return prompt_yes!(host, "remove symbolic link {}?", path.quote());
		}
		if writable {
			return if len == 0 {
				prompt_yes!(host, "remove regular empty file {}?", path.quote())
			} else {
				prompt_yes!(host, "remove file {}?", path.quote())
			};
		}
		// Not writable: use protected wording below
	}

	// Interactive::Once or ::PromptProtected (and non-writable Always) paths
	match (stdin_ok, writable, len == 0) {
		(false, ..) if options.interactive == InteractiveMode::PromptProtected => true,
		(_, true, _) => true,
		(_, false, true) => {
			prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
		},
		_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
	}
}

/// Directory prompt that reuses existing stat data to avoid extra statx calls
fn prompt_dir_with_mode(host: &mut Host, path: &Path, mode: libc::mode_t, options: &Options) -> bool {
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let readable = mode_readable(mode as libc::mode_t);
	let writable = mode_writable(mode as libc::mode_t);
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);

	match (stdin_ok, readable, writable, options.interactive) {
		(false, _, _, InteractiveMode::PromptProtected) => true,
		(false, false, false, InteractiveMode::Never) => true,
		(_, false, false, _) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, false, true, InteractiveMode::Always) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, true, false, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}

/// Whether the given file or directory is readable.
pub fn is_readable(host: &mut Host, path: &Path) -> bool {
	fs::metadata(host.resolve(path)).is_ok_and(|metadata| is_readable_metadata(&metadata))
}

/// Remove a single file using safe traversal
pub fn safe_remove_file(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> Option<bool> {
	// If there is no parent (path is directly under cwd), unlinkat relative to "."
	let parent = path.parent().unwrap_or(Path::new("."));
	let file_name = path.file_name()?;

	let dir_fd = DirFd::open(&host.resolve(parent), SymlinkBehavior::Follow).ok()?;

	match dir_fd.unlink_at(file_name, false) {
		Ok(_) => {
			// Update progress bar for file removal
			if let Some(pb) = progress_bar {
				pb.inc(1);
			}
			verbose_removed_file(host, path, options);
			Some(false)
		},
		Err(e) => {
			if e.kind() == std::io::ErrorKind::PermissionDenied {
				show_error!(host, "cannot remove {}: Permission denied", path.quote());
			} else {
				let _ = show_removal_error(host, e, path);
			}
			Some(true)
		},
	}
}

/// Remove an empty directory using safe traversal
pub fn safe_remove_empty_dir(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> Option<bool> {
	let parent = path.parent().unwrap_or(Path::new("."));
	let dir_name = path.file_name()?;

	let dir_fd = DirFd::open(&host.resolve(parent), SymlinkBehavior::Follow).ok()?;

	match dir_fd.unlink_at(dir_name, true) {
		Ok(_) => {
			// Update progress bar for directory removal
			if let Some(pb) = progress_bar {
				pb.inc(1);
			}
			verbose_removed_directory(host, path, options);
			Some(false)
		},
		Err(e) => {
			show_error!(host, "cannot remove {}: {e}", path.quote());
			Some(true)
		},
	}
}

/// Helper to handle errors with force mode consideration
fn handle_error_with_force(host: &mut Host, e: std::io::Error, path: &Path, options: &Options) -> bool {
	// Permission denied errors should be shown even in force mode
	// This matches GNU rm behavior
	if e.kind() == std::io::ErrorKind::PermissionDenied {
		show_permission_denied_error(host, path);
		return true;
	}

	if !options.force {
		show_error!(host, "cannot remove {}: {e}", path.quote());
	}
	!options.force
}

/// Helper to handle permission denied errors
fn handle_permission_denied(host: &mut Host, 
	dir_fd: &DirFd,
	entry_name: &OsStr,
	entry_path: &Path,
	options: &Options,
) -> bool {
	// When we can't open a subdirectory due to permission denied,
	// try to remove it directly (it might be empty).
	// This matches GNU rm behavior with -f flag.
	if let Err(_remove_err) = dir_fd.unlink_at(entry_name, true) {
		// The directory is not empty (or another error) and we can't read it
		// to remove its contents. Report the original permission denied error.
		// This matches GNU rm behavior — the real problem is we lack
		// permission to traverse the directory.
		show_permission_denied_error(host, entry_path);
		return true;
	}
	// Successfully removed empty directory
	verbose_removed_directory(host, entry_path, options);
	false
}

/// Helper to handle unlink operation with error reporting
fn handle_unlink(host: &mut Host, 
	dir_fd: &DirFd,
	entry_name: &OsStr,
	entry_path: &Path,
	is_dir: bool,
	options: &Options,
) -> bool {
	if let Err(e) = dir_fd.unlink_at(entry_name, is_dir) {
		show_error!(host, "cannot remove {}: {e}", entry_path.quote());
		true
	} else {
		if is_dir {
			verbose_removed_directory(host, entry_path, options);
		} else {
			verbose_removed_file(host, entry_path, options);
		}
		false
	}
}

/// Helper function to remove directory handling special cases
pub fn remove_dir_with_special_cases(host: &mut Host, path: &Path, options: &Options, error_occurred: bool) -> bool {
	match fs::remove_dir(host.resolve(path)) {
		Err(_) if !error_occurred && !is_readable(host, path) => {
			// For compatibility with GNU test case
			// `tests/rm/unread2.sh`, show "Permission denied" in this
			// case instead of "Directory not empty".
			show_permission_denied_error(host, path);
			true
		},
		Err(_) if !error_occurred && host.resolve(path).read_dir().is_err() => {
			// For compatibility with GNU test case on Linux
			// Check if directory is readable by attempting to read it
			show_permission_denied_error(host, path);
			true
		},
		Err(e) if !error_occurred => show_removal_error(host, e, path),
		Err(_) => {
			// If we already had errors while
			// trying to remove the children, then there is no need to
			// show another error message as we return from each level
			// of the recursion.
			error_occurred
		},
		Ok(_) => {
			verbose_removed_directory(host, path, options);
			false
		},
	}
}

pub fn safe_remove_dir_recursive(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if host.is_cancelled() {
		return true;
	}

	// Base case 1: this is a file or a symbolic link.
	// Use lstat to avoid race condition between check and use
	let initial_mode = match fs::symlink_metadata(host.resolve(path)) {
		Ok(metadata) if !metadata.is_dir() => {
			return remove_file(host, path, options, progress_bar);
		},
		Ok(metadata) => metadata.permissions().mode(),
		Err(e) => {
			return show_removal_error(host, e, path);
		},
	};

	// Try to open the directory using DirFd for secure traversal
	let dir_fd = match DirFd::open(&host.resolve(path), SymlinkBehavior::Follow) {
		Ok(fd) => fd,
		Err(e) => {
			// If we can't open the directory for safe traversal,
			// handle the error appropriately and try to remove if possible
			if e.kind() == std::io::ErrorKind::PermissionDenied {
				// Try to remove the directory directly if it's empty
				if fs::remove_dir(host.resolve(path)).is_ok() {
					verbose_removed_directory(host, path, options);
					return false;
				}
				// If we can't read the directory AND can't remove it,
				// show permission denied error for GNU compatibility
				return show_permission_denied_error(host, path);
			}
			return show_removal_error(host, e, path);
		},
	};

	let error = safe_remove_dir_recursive_impl(host, path, &dir_fd, options);

	// After processing all children, remove the directory itself
	if error {
		error
	} else {
		// Ask user permission if needed
		if options.interactive == InteractiveMode::Always
			&& !prompt_dir_with_mode(host, path, initial_mode as libc::mode_t, options)
		{
			return false;
		}

		// Before trying to remove the directory, check if it's actually empty
		// This handles the case where some children weren't removed due to user "no"
		// responses
		if !is_dir_empty(host, path) {
			// Directory is not empty, so we can't/shouldn't remove it
			// In interactive mode, this might be expected if user said "no" to some
			// children In non-interactive mode, this indicates an error (some children
			// couldn't be removed)
			if options.interactive == InteractiveMode::Always {
				return false;
			}
			// Try to remove the directory anyway and let the system tell us why it failed
			// Use false for error_occurred since this is the main error we want to report
			return remove_dir_with_special_cases(host, path, options, false);
		}

		// Directory is empty and user approved removal
		if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
			result
		} else {
			remove_dir_with_special_cases(host, path, options, error)
		}
	}
}

#[cfg(not(target_os = "redox"))]
pub fn safe_remove_dir_recursive_impl(host: &mut Host, path: &Path, dir_fd: &DirFd, options: &Options) -> bool {
	// Read directory entries using safe traversal
	let entries = match dir_fd.read_dir() {
		Ok(entries) => entries,
		Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
			if !options.force {
				show_permission_denied_error(host, path);
			}
			return !options.force;
		},
		Err(e) => {
			return handle_error_with_force(host, e, path, options);
		},
	};

	let mut error = false;

	// Process each entry
	for entry_name in entries {
		if host.is_cancelled() {
			return true;
		}

		let entry_path = path.join(&entry_name);

		// Get metadata for the entry using fstatat
		let entry_stat = match dir_fd.stat_at(&entry_name, SymlinkBehavior::NoFollow) {
			Ok(stat) => stat,
			Err(e) => {
				error |= handle_error_with_force(host, e, &entry_path, options);
				continue;
			},
		};

		// Check if it's a directory
		let is_dir = ((entry_stat.st_mode as libc::mode_t) & libc::S_IFMT) == libc::S_IFDIR;

		if is_dir {
			// Ask user if they want to descend into this directory
			if options.interactive == InteractiveMode::Always
				&& !is_dir_empty(host, &entry_path)
				&& !prompt_descend(host, &entry_path)
			{
				continue;
			}

			// Recursively remove subdirectory using safe traversal
			let child_dir_fd = match dir_fd.open_subdir(&entry_name, SymlinkBehavior::Follow) {
				Ok(fd) => fd,
				Err(e) => {
					// If we can't open the subdirectory for safe traversal,
					// try to handle it as best we can with safe operations
					if e.kind() == std::io::ErrorKind::PermissionDenied {
						error |=
							handle_permission_denied(host, dir_fd, entry_name.as_ref(), &entry_path, options);
					} else {
						error |= handle_error_with_force(host, e, &entry_path, options);
					}
					continue;
				},
			};

			let child_error = safe_remove_dir_recursive_impl(host, &entry_path, &child_dir_fd, options);
			error |= child_error;

			// Ask user permission if needed for this subdirectory
			if !child_error
				&& options.interactive == InteractiveMode::Always
				&& !prompt_dir_with_mode(host, &entry_path, entry_stat.st_mode as libc::mode_t, options)
			{
				continue;
			}

			// Remove the now-empty subdirectory using safe unlinkat
			if !child_error {
				error |= handle_unlink(host, dir_fd, entry_name.as_ref(), &entry_path, true, options);
			}
		} else {
			// Remove file - check if user wants to remove it first
			if prompt_file_with_stat(host, &entry_path, &entry_stat, options) {
				error |= handle_unlink(host, dir_fd, entry_name.as_ref(), &entry_path, false, options);
			}
		}
	}

	error
}

#[cfg(target_os = "redox")]
pub fn safe_remove_dir_recursive_impl(host: &mut Host, _path: &Path, _dir_fd: &DirFd, _options: &Options) -> bool {
	// safe_traversal stat_at is not supported on Redox
	// This shouldn't be called on Redox, but provide a stub for compilation
	true // Return error
}

}
#[cfg(all(unix, not(target_os = "redox")))]
use platform::{safe_remove_dir_recursive, safe_remove_empty_dir, safe_remove_file};

#[derive(Debug, Error)]
enum RmError {
	#[error("missing operand\nTry 'rm --help' for more information.")]
	MissingOperand,
	#[error("cannot remove {}: No such file or directory", _0.quote())]
	CannotRemoveNoSuchFile(OsString),
	#[error("cannot remove {}: Permission denied", _0.quote())]
	CannotRemovePermissionDenied(OsString),
	#[error("cannot remove {}: Is a directory", _0.quote())]
	CannotRemoveIsDirectory(OsString),
	#[error("it is dangerous to operate recursively on '/'")]
	DangerousRecursiveOperation,
	#[error("use --no-preserve-root to override this failsafe")]
	UseNoPreserveRoot,
	#[error("refusing to remove '.' or '..' directory: skipping {}", _0.quote())]
	RefusingToRemoveDirectory(OsString),
	#[error("you may not abbreviate the --no-preserve-root option")]
	MayNotAbbreviateNoPreserveRoot,
}

/// Helper function to print verbose message for removed file
fn verbose_removed_file(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ =
			writeln!(host.stdout, "removed {}", uucore::fs::normalize_path(path).quote());
	}
}

/// Helper function to print verbose message for removed directory
fn verbose_removed_directory(host: &mut Host, path: &Path, options: &Options) {
	if options.verbose {
		let _ = writeln!(
			host.stdout,
			"removed directory {}",
			uucore::fs::normalize_path(path).quote()
		);
	}
}

/// Helper function to show error with context and return error status
fn show_removal_error(host: &mut Host, error: io::Error, path: &Path) -> bool {
	if error.kind() == io::ErrorKind::PermissionDenied {
		show_error!(host, "cannot remove {}: Permission denied", path.quote());
	} else {
		show_error!(host, "cannot remove {}: {error}", path.quote());
	}
	true
}

/// Helper function for permission denied errors
fn show_permission_denied_error(host: &mut Host, path: &Path) -> bool {
	show_error!(host, "cannot remove {}: Permission denied", path.quote());
	true
}

/// Helper function to remove a directory and handle results
fn remove_dir_with_feedback(host: &mut Host, path: &Path, options: &Options) -> bool {
	match fs::remove_dir(host.resolve(path)) {
		Ok(_) => {
			verbose_removed_directory(host, path, options);
			false
		},
		Err(e) => show_removal_error(host, e, path),
	}
}

#[derive(Eq, PartialEq, Clone, Copy)]
/// Enum, determining when the `rm` will prompt the user about the file deletion
pub enum InteractiveMode {
	/// Never prompt
	Never,
	/// Prompt once before removing more than three files, or when removing
	/// recursively.
	Once,
	/// Prompt before every removal
	Always,
	/// Prompt only on write-protected files
	PromptProtected,
}

// We implement `From` instead of `TryFrom` because clap guarantees that we only
// receive valid values.
//
// The `PromptProtected` variant is not supposed to be created from a string.
impl From<&str> for InteractiveMode {
	fn from(s: &str) -> Self {
		match s {
			"never" => Self::Never,
			"once" => Self::Once,
			"always" => Self::Always,
			_ => unreachable!("should be prevented by clap"),
		}
	}
}

/// Options for the `rm` command
///
/// All options are public so that the options can be programmatically
/// constructed by other crates, such as Nushell. That means that this struct
/// is part of our public API. It should therefore not be changed without good
/// reason.
///
/// The fields are documented with the arguments that determine their value.
pub struct Options {
	/// `-f`, `--force`
	pub force:               bool,
	/// Iterative mode, determines when the command will prompt.
	///
	/// Set by the following arguments:
	/// - `-i`: [`InteractiveMode::Always`]
	/// - `-I`: [`InteractiveMode::Once`]
	/// - `--interactive`: sets one of the above or [`InteractiveMode::Never`]
	/// - `-f`: implicitly sets [`InteractiveMode::Never`]
	///
	/// If no other option sets this mode, [`InteractiveMode::PromptProtected`]
	/// is used
	pub interactive:         InteractiveMode,
	#[allow(dead_code, reason = "--one-file-system is parsed but intentionally unimplemented upstream")]
	/// `--one-file-system`
	pub one_fs:              bool,
	/// `--preserve-root`/`--no-preserve-root`
	pub preserve_root:       bool,
	/// `-r`, `--recursive`
	pub recursive:           bool,
	/// `-d`, `--dir`
	pub dir:                 bool,
	/// `-v`, `--verbose`
	pub verbose:             bool,
	/// `-g`, `--progress`
	pub progress:            bool,
	#[doc(hidden)]
	/// `---presume-input-tty`
	/// Always use `None`; GNU flag for testing use only
	pub __presume_input_tty: Option<bool>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			force:               false,
			interactive:         InteractiveMode::PromptProtected,
			one_fs:              false,
			preserve_root:       true,
			recursive:           false,
			dir:                 false,
			verbose:             false,
			progress:            false,
			__presume_input_tty: None,
		}
	}
}

static OPT_DIR: &str = "dir";
static OPT_INTERACTIVE: &str = "interactive";
static OPT_FORCE: &str = "force";
static OPT_NO_PRESERVE_ROOT: &str = "no-preserve-root";
static OPT_ONE_FILE_SYSTEM: &str = "one-file-system";
static OPT_PRESERVE_ROOT: &str = "preserve-root";
static OPT_PROMPT_ALWAYS: &str = "prompt-always";
static OPT_PROMPT_ONCE: &str = "prompt-once";
static OPT_RECURSIVE: &str = "recursive";
static OPT_VERBOSE: &str = "verbose";
static OPT_PROGRESS: &str = "progress";
static PRESUME_INPUT_TTY: &str = "-presume-input-tty";

static ARG_FILES: &str = "files";

/// Parsed `rm` invocation.
pub(crate) struct Rm {
	matches: ArgMatches,
}

matches_parser!(Rm, uu_app);

impl Utility for Rm {
	const NAME: &'static str = "rm";
	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		const FULL: &str = "--no-preserve-root";
		for arg in argv.iter().skip(1) {
			let Some(arg) = arg.to_str() else {
				continue;
			};
			if arg == "--" {
				break;
			}
			if arg.starts_with("--") && arg.len() < FULL.len() && FULL.starts_with(arg) {
				return Err(RmError::MayNotAbbreviateNoPreserveRoot.to_string());
			}
		}
		Ok(argv)
	}


	fn run(self, host: &mut Host) -> i32 {
		run_matches(host, &self.matches)
	}
}

fn run_matches(host: &mut Host, matches: &ArgMatches) -> i32 {
	let files: Vec<_> = matches
		.get_many::<OsString>(ARG_FILES)
		.map(|v| v.map(OsString::as_os_str).collect())
		.unwrap_or_default();

	let force_flag = matches.get_flag(OPT_FORCE);
	if files.is_empty() && !force_flag {
		host.error(RmError::MissingOperand, 1);
		return 1;
	}

	// If -f(--force) is before any -i (or variants) we want prompts else no prompts.
	let force_prompt_never = force_flag && {
		let force_index = matches.index_of(OPT_FORCE).unwrap_or(0);
		![OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE, OPT_INTERACTIVE]
			.iter()
			.any(|flag| {
				matches.value_source(flag) == Some(ValueSource::CommandLine)
					&& matches.index_of(flag).unwrap_or(0) > force_index
			})
	};


	let options = Options {
		force: force_flag,
		interactive: {
			if force_prompt_never {
				InteractiveMode::Never
			} else if matches.get_flag(OPT_PROMPT_ALWAYS) {
				InteractiveMode::Always
			} else if matches.get_flag(OPT_PROMPT_ONCE) {
				InteractiveMode::Once
			} else if matches.contains_id(OPT_INTERACTIVE) {
				InteractiveMode::from(matches.get_one::<String>(OPT_INTERACTIVE).unwrap().as_str())
			} else {
				InteractiveMode::PromptProtected
			}
		},
		one_fs: matches.get_flag(OPT_ONE_FILE_SYSTEM),
		preserve_root: !matches.get_flag(OPT_NO_PRESERVE_ROOT),
		recursive: matches.get_flag(OPT_RECURSIVE),
		dir: matches.get_flag(OPT_DIR),
		verbose: matches.get_flag(OPT_VERBOSE),
		progress: matches.get_flag(OPT_PROGRESS),
		__presume_input_tty: Some(
			matches.get_flag(PRESUME_INPUT_TTY) || host.stdin.file().is_terminal(),
		),
	};

	if options.interactive == InteractiveMode::Once && (options.recursive || files.len() > 3) {
		let msg = format!(
			"remove {} {}{}",
			files.len(),
			if files.len() > 1 { "arguments" } else { "argument" },
			if options.recursive { " recursively?" } else { "?" }
		);
		if !prompt_yes!(host, "{msg}") {
			return 0;
		}
	}

	if remove(host, &files, &options) {
		host.fail(1);
	}
	host.exit_code()
}

pub fn uu_app() -> Command {
	Command::new("rm")
		.version("0.8.0")
		.about("Remove (unlink) the FILE(s)")
		.override_usage(format_usage("rm [OPTION]... FILE..."))
		.after_help(
			"By default, rm does not remove directories. Use the --recursive (-r or -R)\noption to \
			 remove each listed directory, too, along with all of its contents\n\nTo remove a file \
			 whose name starts with a '-', for example '-foo',\nuse one of these commands:\nrm -- \
			 -foo\n\nrm ./-foo\n\nNote that if you use rm to remove a file, it might be possible to \
			 recover\nsome of its contents, given sufficient expertise and/or time. For \
			 greater\nassurance that the contents are truly unrecoverable, consider using shred.",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.arg(
			Arg::new(OPT_FORCE)
				.short('f')
				.long(OPT_FORCE)
				.help("ignore nonexistent files and arguments, never prompt")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ALWAYS)
				.short('i')
				.help("prompt before every removal")
				.overrides_with_all([OPT_PROMPT_ONCE, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROMPT_ONCE)
				.short('I')
				.help(
					"prompt once before removing more than three files, or when removing \
					 recursively.\nLess intrusive than -i, while still giving some protection against \
					 most mistakes",
				)
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INTERACTIVE)
				.long(OPT_INTERACTIVE)
				.help(
					"prompt according to WHEN: never, once (-I), or always (-i). Without \
					 WHEN,\nprompts always",
				)
				.value_name("WHEN")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes"),
					PossibleValue::new("once"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value("always")
				.overrides_with_all([OPT_PROMPT_ALWAYS, OPT_PROMPT_ONCE]),
		)
		.arg(
			Arg::new(OPT_ONE_FILE_SYSTEM)
				.long(OPT_ONE_FILE_SYSTEM)
				.help(
					"when removing a hierarchy recursively, skip any directory that is on a \
					 file\nsystem different from that of the corresponding command line argument \
					 (NOT\nIMPLEMENTED)",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_PRESERVE_ROOT)
				.long(OPT_NO_PRESERVE_ROOT)
				.help("do not treat '/' specially")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PRESERVE_ROOT)
				.long(OPT_PRESERVE_ROOT)
				.help("do not remove '/' (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RECURSIVE)
				.short('r')
				.visible_short_alias('R')
				.long(OPT_RECURSIVE)
				.help("remove directories and their contents recursively")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_DIR)
				.short('d')
				.long(OPT_DIR)
				.help("remove empty directories")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_VERBOSE)
				.short('v')
				.long(OPT_VERBOSE)
				.help("explain what is being done")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_PROGRESS)
				.short('g')
				.long(OPT_PROGRESS)
				.help("display a progress bar. Note: this feature is not supported by GNU coreutils.")
				.action(ArgAction::SetTrue),
		)
		// From the GNU source code:
		// This is solely for testing.
		// Do not document.
		// It is relatively difficult to ensure that there is a tty on stdin.
		// Since rm acts differently depending on that, without this option,
		// it'd be harder to test the parts of rm that depend on that setting.
		// In contrast with Arg::long, Arg::alias does not strip leading
		// hyphens. Therefore it supports 3 leading hyphens.
		.arg(
			Arg::new(PRESUME_INPUT_TTY)
				.long("presume-input-tty")
				.alias(PRESUME_INPUT_TTY)
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.num_args(1..)
				.value_hint(clap::ValueHint::AnyPath),
		)
}
/// Creates the `rm` builtin registration.
pub(crate) fn rm_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Rm, SE>()
}


/// Terminal adapter that directs progress rendering to the builtin's stderr.
struct HostTerm(Mutex<OpenFile>);

impl fmt::Debug for HostTerm {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.write_str("HostTerm")
	}
}

impl TermLike for HostTerm {
	fn width(&self) -> u16 {
		80
	}

	fn move_cursor_up(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}A")
	}

	fn move_cursor_down(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}B")
	}

	fn move_cursor_right(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}C")
	}

	fn move_cursor_left(&self, n: usize) -> io::Result<()> {
		write!(self.0.lock(), "\x1b[{n}D")
	}

	fn write_line(&self, s: &str) -> io::Result<()> {
		writeln!(self.0.lock(), "{s}")
	}

	fn write_str(&self, s: &str) -> io::Result<()> {
		write!(self.0.lock(), "{s}")
	}

	fn clear_line(&self) -> io::Result<()> {
		write!(self.0.lock(), "\r\x1b[2K")
	}

	fn flush(&self) -> io::Result<()> {
		self.0.lock().flush()
	}
}

/// Returns Some(ProgressBar) if `total_files` > 0, None otherwise.
fn create_progress_bar(host: &mut Host, files: &[&OsStr], recursive: bool) -> Option<ProgressBar> {
	if !host.stderr.is_terminal() {
		return None;
	}
	let total_files = count_files(host, files, recursive);
	if total_files == 0 {
		return None;
	}

	let progress = ProgressBar::with_draw_target(
		Some(total_files),
		ProgressDrawTarget::term_like(Box::new(HostTerm(Mutex::new(host.stderr_clone())))),
	)
	.with_style(
		ProgressStyle::with_template(
			"{msg}: [{elapsed_precise}] {wide_bar} {pos:>7}/{len:7} files",
		)
		.unwrap(),
	)
	.with_message("Removing");
	Some(progress)
}

/// Count the total number of files and directories to be deleted.
/// This function recursively counts all files and directories that will be
/// processed. Files are not deduplicated when appearing in multiple sources. If
/// `recursive` is set to `false`, the directories in `paths` will be ignored.
fn count_files(host: &mut Host, paths: &[&OsStr], recursive: bool) -> u64 {
	let mut total = 0;
	for p in paths {
		if host.is_cancelled() {
			break;
		}

		// Empty operands are rejected by `remove(host, )` before deletion; skip them
		// here too so the progress pre-count doesn't resolve "" to the cwd and
		// walk the entire working directory into the total.
		if p.is_empty() {
			continue;
		}
		let path = Path::new(p);
		if let Ok(md) = fs::symlink_metadata(host.resolve(path)) {
			if md.is_dir() && !is_symlink_dir(&md) {
				if recursive {
					total += count_files_in_directory(host, path);
				}
			} else {
				total += 1;
			}
		}
		// If we can't access the file, skip it for counting
		// This matches the behavior where -f suppresses errors for missing files
	}
	total
}

/// A helper for `count_files` specialized for directories.
fn count_files_in_directory(host: &mut Host, p: &Path) -> u64 {
	if host.is_cancelled() {
		return 0;
	}
	let mut entries_count = 0;
	let Ok(entries) = fs::read_dir(host.resolve(p)) else {
		return 1;
	};
	for entry in entries.flatten() {
		if host.is_cancelled() {
			break;
		}
		entries_count += match entry.file_type() {
			Ok(ft) if ft.is_dir() => count_files_in_directory(host, &entry.path()),
			Ok(_) => 1,
			Err(_) => 0,
		};
	}
	1 + entries_count
}


// TODO: implement one-file-system (this may get partially implemented in
// walkdir)
/// Remove (or unlink) the given files
///
/// Returns true if it has encountered an error.
///
/// Behavior is determined by the `options` parameter, see [`Options`] for
/// details.
pub fn remove(host: &mut Host, files: &[&OsStr], options: &Options) -> bool {
	let mut had_err = false;

	// Check if any files actually exist before creating progress bar
	let mut progress_bar: Option<ProgressBar> = None;
	let mut any_files_processed = false;

	for filename in files {
		if host.is_cancelled() {
			break;
		}

		let file = Path::new(filename);

		// An empty operand can never name a real file. Guard it before
		// `Host::resolve`, which joins "" onto the shell's working
		// directory — without this, `rm -rf ""` resolves to the cwd and
		// recursively deletes it. GNU rm reports ENOENT for an empty operand
		// (and `rm -f` stays silent), so mirror that here.
		if filename.is_empty() {
			if !options.force {
				show_error!(host, "{}", RmError::CannotRemoveNoSuchFile(filename.to_os_string()));
				had_err = true;
			}
			continue;
		}

		// Check if the path (potentially with trailing slash) resolves to root
		// This needs to happen before symlink_metadata to catch cases like "rootlink/"
		// where rootlink is a symlink to root.
		if uucore::fs::path_ends_with_terminator(file)
			&& options.recursive
			&& options.preserve_root
			&& is_root_path(host, file)
		{
			show_preserve_root_error(host, file);
			had_err = true;
			continue;
		}

		had_err = match host.resolve(file).symlink_metadata() {
			Ok(metadata) => {
				// Create progress bar on first successful file metadata read
				if options.progress && progress_bar.is_none() {
					progress_bar = create_progress_bar(host, files, options.recursive);
				}

				any_files_processed = true;
				if metadata.is_dir() {
					handle_dir(host, file, options, progress_bar.as_ref())
				} else if is_symlink_dir(&metadata) {
					remove_dir(host, file, options, progress_bar.as_ref())
				} else {
					remove_file(host, file, options, progress_bar.as_ref())
				}
			},

			Err(_e) => {
				// TODO: actually print out the specific error
				// TODO: When the error is not about missing files
				// (e.g., permission), even rm -f should fail with
				// outputting the error, but there's no easy way.
				if options.force {
					false
				} else {
					show_error!(host, "{}", RmError::CannotRemoveNoSuchFile(filename.to_os_string()));
					true
				}
			},
		}
		.bitor(had_err);
	}

	// Only finish progress bar if it was created and files were processed
	if let Some(pb) = progress_bar
		&& any_files_processed
	{
		pb.finish();
	}

	had_err
}

/// Whether the given directory is empty.
///
/// `path` must be a directory. If there is an error reading the
/// contents of the directory, this returns `false`.
fn is_dir_empty(host: &mut Host, path: &Path) -> bool {
	fs::read_dir(host.resolve(path)).is_ok_and(|mut iter| iter.next().is_none())
}

#[cfg(unix)]
fn is_readable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o400) > 0
}

/// Whether the given file or directory is readable.
#[cfg(any(not(unix), target_os = "redox"))]
fn is_readable(_host: &mut Host, _path: &Path) -> bool {
	true
}

#[cfg(unix)]
fn is_writable_metadata(metadata: &Metadata) -> bool {
	let mode = metadata.permissions().mode();
	(mode & 0o200) > 0
}

#[cfg(not(unix))]
fn is_writable_metadata(_metadata: &Metadata) -> bool {
	true
}

/// Recursively remove the directory tree rooted at the given path.
///
/// If `path` is a file or a symbolic link, just remove it. If it is a
/// directory, remove all of its entries recursively and then remove the
/// directory itself. In case of an error, print the error message to
/// `stderr` and return `true`. If there were no errors, return `false`.
fn remove_dir_recursive(host: &mut Host, 
	path: &Path,
	options: &Options,
	progress_bar: Option<&ProgressBar>,
) -> bool {
	if host.is_cancelled() {
		return true;
	}

	// Base case 1: this is a file or a symbolic link.
	//
	// The symbolic link case is important because it could be a link to
	// a directory and we don't want to recurse. In particular, this
	// avoids an infinite recursion in the case of a link to the current
	// directory, like `ln -s . link`.
	let fs_path = host.resolve(path);
	if !fs_path.is_dir() || fs_path.is_symlink() {
		return remove_file(host, path, options, progress_bar);
	}

	// Base case 2: this is a non-empty directory, but the user
	// doesn't want to descend into it.
	if options.interactive == InteractiveMode::Always && !is_dir_empty(host, path) && !prompt_descend(host, path)
	{
		return false;
	}

	// Use secure traversal on Unix (except Redox) for all recursive directory
	// removals
	#[cfg(all(unix, not(target_os = "redox")))]
	{
		safe_remove_dir_recursive(host, path, options, progress_bar)
	}

	// Fallback for non-Unix, Redox, or use fs::remove_dir_all for very long paths
	#[cfg(any(not(unix), target_os = "redox"))]
	{
		if let Some(s) = path.to_str() {
			if s.len() > 1000 {
				match fs::remove_dir_all(host.resolve(path)) {
					Ok(_) => return false,
					Err(e) => {
						show_error!(host, "cannot remove {}: {e}", path.quote());
						return true;
					},
				}
			}
		}

		// Recursive case: this is a directory.
		let mut error = false;
		match fs::read_dir(host.resolve(path)) {
			Err(e) if e.kind() == io::ErrorKind::PermissionDenied => {
				// This is not considered an error.
			},
			Err(_) => error = true,
			Ok(iter) => {
				for entry in iter {
					if host.is_cancelled() {
						error = true;
						break;
					}
					match entry {
						Err(_) => error = true,
						Ok(entry) => {
							let child_error = remove_dir_recursive(host, &entry.path(), options, progress_bar);
							error = error || child_error;
						},
					}
				}
			},
		}

		// Ask the user whether to remove the current directory.
		if options.interactive == InteractiveMode::Always && !prompt_dir(host, path, options) {
			return false;
		}

		// Try removing the directory itself.
		match fs::remove_dir(host.resolve(path)) {
			Err(_) if !error && !is_readable(host, path) => {
				// For compatibility with GNU test case
				// `tests/rm/unread2.sh`, show "Permission denied" in this
				// case instead of "Directory not empty".
				show_permission_denied_error(host, path);
				error = true;
			},
			Err(e) if !error => {
				show_error!(host, "cannot remove {}: {e}", path.quote());
				error = true;
			},
			Err(_) => {
				// If there has already been at least one error when
				// trying to remove the children, then there is no need to
				// show another error message as we return from each level
				// of the recursion.
			},
			Ok(_) => verbose_removed_directory(host, path, options),
		}

		error
	}
}

/// Check if a path resolves to the root directory.
/// Returns true if the path is root, false otherwise.
fn is_root_path(host: &mut Host, path: &Path) -> bool {
	// Check simple case: literal "/" path
	if path.has_root() && path.parent().is_none() {
		return true;
	}

	// Check if path resolves to "/" after following symlinks
	if let Ok(canonical) = host.resolve(path).canonicalize() {
		canonical.has_root() && canonical.parent().is_none()
	} else {
		false
	}
}

/// Show error message for attempting to remove root.
fn show_preserve_root_error(host: &mut Host, path: &Path) {
	let path_looks_like_root = path.has_root() && path.parent().is_none();

	if path_looks_like_root {
		// Path is literally "/"
		show_error!(host, "{}", RmError::DangerousRecursiveOperation);
	} else {
		// Path resolves to root but isn't literally "/" (e.g., symlink to /)
		show_error!(host, "it is dangerous to operate recursively on '{}' (same as '/')", path.display());
	}
	show_error!(host, "{}", RmError::UseNoPreserveRoot);
}

fn handle_dir(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	let mut had_err = false;

	let path = clean_trailing_slashes(path);
	if path_is_current_or_parent_directory(path) {
		show_error!(host, "{}", RmError::RefusingToRemoveDirectory(path.as_os_str().to_os_string()));
		return true;
	}

	let is_root = is_root_path(host, path);
	if options.recursive && (!is_root || !options.preserve_root) {
		had_err = remove_dir_recursive(host, path, options, progress_bar);
	} else if options.dir && (!is_root || !options.preserve_root) {
		had_err = remove_dir(host, path, options, progress_bar).bitor(had_err);
	} else if options.recursive {
		show_preserve_root_error(host, path);
		had_err = true;
	} else {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		had_err = true;
	}

	had_err
}

/// Remove the given directory, asking the user for permission if necessary.
///
/// Returns true if it has encountered an error.
fn remove_dir(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	// Ask the user for permission.
	if !prompt_dir(host, path, options) {
		return false;
	}

	// Called to remove a symlink_dir (windows) without "-r"/"-R" or "-d".
	if !options.dir && !options.recursive {
		show_error!(host, "{}", RmError::CannotRemoveIsDirectory(path.as_os_str().to_os_string()));
		return true;
	}

	// Use safe traversal on Unix (except Redox) for empty directory removal
	#[cfg(all(unix, not(target_os = "redox")))]
	{
		if let Some(result) = safe_remove_empty_dir(host, path, options, progress_bar) {
			return result;
		}
	}

	// Update progress bar for directory removal
	if let Some(pb) = progress_bar {
		pb.inc(1);
	}

	// Fallback method for non-Linux or when safe traversal is unavailable
	remove_dir_with_feedback(host, path, options)
}

fn remove_file(host: &mut Host, path: &Path, options: &Options, progress_bar: Option<&ProgressBar>) -> bool {
	if prompt_file(host, path, options) {
		// Update progress bar before removing the file
		if let Some(pb) = progress_bar {
			pb.inc(1);
		}

		// Use safe traversal on Unix (except Redox) for individual file removal
		#[cfg(all(unix, not(target_os = "redox")))]
		{
			if let Some(result) = safe_remove_file(host, path, options, progress_bar) {
				return result;
			}
		}

		// Fallback method for non-Unix, Redox, or when safe traversal is unavailable
		match fs::remove_file(host.resolve(path)) {
			Ok(_) => {
				verbose_removed_file(host, path, options);
			},
			Err(e) => {
				if e.kind() == io::ErrorKind::PermissionDenied {
					// GNU compatibility (rm/fail-eacces.sh)
					show_error!(host, 
						"{}",
						RmError::CannotRemovePermissionDenied(path.as_os_str().to_os_string())
					);
				} else {
					return show_removal_error(host, e, path);
				}
				return true;
			},
		}
	}

	false
}

fn prompt_dir(host: &mut Host, path: &Path, options: &Options) -> bool {
	// If interactive is Never we never want to send prompts
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	// We can't use metadata.permissions.readonly for directories because it only
	// works on files So we have to handle whether a directory is writable manually
	if let Ok(metadata) = fs::metadata(host.resolve(path)) {
		handle_writable_directory(host, path, options, &metadata)
	} else {
		true
	}
}

fn prompt_file(host: &mut Host, path: &Path, options: &Options) -> bool {
	// If interactive is Never we never want to send prompts
	if options.interactive == InteractiveMode::Never {
		return true;
	}

	let Ok(metadata) = fs::symlink_metadata(host.resolve(path)) else {
		return true;
	};

	if metadata.is_symlink() {
		return options.interactive != InteractiveMode::Always
			|| prompt_yes!(host, "remove symbolic link {}?", path.quote());
	}

	if options.interactive == InteractiveMode::Always && is_writable_metadata(&metadata) {
		return if metadata.len() == 0 {
			prompt_yes!(host, "remove regular empty file {}?", path.quote())
		} else {
			prompt_yes!(host, "remove file {}?", path.quote())
		};
	}

	prompt_file_permission_readonly(host, path, options, &metadata)
}

fn prompt_file_permission_readonly(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (stdin_ok, options.interactive) {
		(false, InteractiveMode::PromptProtected) => true,
		_ if is_writable_metadata(metadata) => true,
		_ if metadata.len() == 0 => {
			prompt_yes!(host, "remove write-protected regular empty file {}?", path.quote())
		},
		_ => prompt_yes!(host, "remove write-protected regular file {}?", path.quote()),
	}
}

/// Checks if the path is referring to current or parent directory , if it is
/// referring to current or any parent directory in the file tree e.g  '/../..'
/// , '../..'
fn path_is_current_or_parent_directory(path: &Path) -> bool {
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;
	if let Some(path_bytes) = path_str {
		return path_bytes == *b"."
			|| path_bytes == ([b'.', dir_separator])
			|| path_bytes == *b".."
			|| path_bytes == ([b'.', b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.'])
			|| path_bytes.ends_with(&[dir_separator, b'.', dir_separator])
			|| path_bytes.ends_with(&[dir_separator, b'.', b'.', dir_separator]);
	}
	false
}

// For directories finding if they are writable or not is a hassle. In Unix we
// can use the built-in rust crate to check mode bits. But other os don't have
// something similar afaik Most cases are covered by keep eye out for edge cases
#[cfg(unix)]
fn handle_writable_directory(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (
		stdin_ok,
		is_readable_metadata(metadata),
		is_writable_metadata(metadata),
		options.interactive,
	) {
		(false, _, _, InteractiveMode::PromptProtected) => true,
		(false, false, false, InteractiveMode::Never) => true, /* Don't prompt when interactive is */
		// never
		(_, false, false, _) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, false, true, InteractiveMode::Always) => {
			prompt_yes!(host, "attempt removal of inaccessible directory {}?", path.quote())
		},
		(_, true, false, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}

// For windows we can use windows metadata trait and file attributes to see if a
// directory is readonly
#[cfg(windows)]
fn handle_writable_directory(host: &mut Host, path: &Path, options: &Options, metadata: &Metadata) -> bool {
	use std::os::windows::prelude::MetadataExt;

	use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_READONLY;
	let not_user_writable = (metadata.file_attributes() & FILE_ATTRIBUTE_READONLY) != 0;
	let stdin_ok = options.__presume_input_tty.unwrap_or(false);
	match (stdin_ok, not_user_writable, options.interactive) {
		(false, _, InteractiveMode::PromptProtected) => true,
		(_, true, _) => prompt_yes!(host, "remove write-protected directory {}?", path.quote()),
		(_, _, InteractiveMode::Always) => prompt_yes!(host, "remove directory {}?", path.quote()),
		(..) => true,
	}
}

// I have this here for completeness but it will always return "remove directory
// {}" because metadata.permissions().readonly() only works for file not
// directories
#[cfg(not(windows))]
#[cfg(not(unix))]
fn handle_writable_directory(host: &mut Host, path: &Path, options: &Options, _metadata: &Metadata) -> bool {
	if options.interactive == InteractiveMode::Always {
		prompt_yes!(host, "remove directory {}?", path.quote())
	} else {
		true
	}
}

/// Removes trailing slashes, for example 'd/../////' yield 'd/../' required to
/// fix rm-r4 GNU test
fn clean_trailing_slashes(path: &Path) -> &Path {
	let path_str = os_bytes(path.as_os_str());
	let dir_separator = MAIN_SEPARATOR as u8;

	if let Some(path_bytes) = path_str {
		let mut idx = if path_bytes.len() > 1 {
			path_bytes.len() - 1
		} else {
			return path;
		};
		// Checks if element at the end is a '/'
		if path_bytes[idx] == dir_separator {
			for i in (1..path_bytes.len()).rev() {
				// Will break at the start of the continuous sequence of '/', eg: "abc//////" ,
				// will break at "abc/", this will clean ////// to the root '/', so we have
				// to be careful to not delete the root.
				if path_bytes[i - 1] != dir_separator {
					idx = i;
					break;
				}
			}
			#[cfg(unix)]
			return Path::new(OsStr::from_bytes(&path_bytes[0..=idx]));

			#[cfg(not(unix))]
			// `os_bytes` returns `None` for non-UTF-8 strings off Unix, so this
			// byte slice is valid UTF-8.
			return Path::new(std::str::from_utf8(&path_bytes[0..=idx]).unwrap());
		}
	}
	path
}

fn prompt_descend(host: &mut Host, path: &Path) -> bool {
	prompt_yes!(host, "descend into directory {}?", path.quote())
}

#[cfg(not(windows))]
fn is_symlink_dir(_metadata: &Metadata) -> bool {
	false
}

#[cfg(windows)]
fn is_symlink_dir(metadata: &Metadata) -> bool {
	use std::os::windows::prelude::MetadataExt;

	use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_DIRECTORY;

	metadata.file_type().is_symlink()
		&& ((metadata.file_attributes() & FILE_ATTRIBUTE_DIRECTORY) != 0)
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use tempfile::{Builder, tempdir};

	use super::{Rm, clean_trailing_slashes};
	use crate::host::run_util;

	#[test]
	fn collapses_repeated_root_slashes() {
		assert_eq!(Path::new("/"), clean_trailing_slashes(Path::new("/////")));
	}

	#[test]
	fn empty_operand_does_not_delete_cwd() {
		let cwd = tempdir().unwrap();
		let sentinel = cwd.path().join("sentinel");
		std::fs::write(&sentinel, b"keep me").unwrap();

		let (code, _) = run_util::<Rm>(&["-rf", ""], "", cwd.path());

		assert_eq!(code, 0);
		assert!(cwd.path().is_dir());
		assert!(sentinel.is_file());
	}

	#[test]
	fn relative_operand_resolves_against_host_cwd() {
		let cwd = tempdir().unwrap();
		let process_cwd = std::env::current_dir().unwrap();
		let process_file = Builder::new()
			.prefix("brush-rm-relative-")
			.tempfile_in(process_cwd)
			.unwrap();
		let name = process_file.path().file_name().unwrap().to_str().unwrap();
		let host_file = cwd.path().join(name);
		std::fs::write(&host_file, b"remove me").unwrap();

		let (code, capture) = run_util::<Rm>(&[name], "", cwd.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!host_file.exists());
		assert!(process_file.path().exists());
	}

	#[test]
	fn recursively_removes_directory_tree() {
		let cwd = tempdir().unwrap();
		std::fs::create_dir_all(cwd.path().join("tree/child")).unwrap();
		std::fs::write(cwd.path().join("tree/child/file"), b"data").unwrap();

		let (code, capture) = run_util::<Rm>(&["-r", "tree"], "", cwd.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!cwd.path().join("tree").exists());
	}

	#[test]
	fn interactive_no_keeps_file_and_prompts_on_stderr() {
		let cwd = tempdir().unwrap();
		std::fs::write(cwd.path().join("keep"), b"data").unwrap();

		let (code, capture) = run_util::<Rm>(&["-i", "keep"], "n\n", cwd.path());

		assert_eq!(code, 0);
		assert!(cwd.path().join("keep").exists());
		assert_eq!(capture.out(), "");
		assert!(capture.err().contains("rm: remove file 'keep'?"));
	}

	#[test]
	fn refuses_abbreviated_no_preserve_root() {
		let (code, capture) = run_util::<Rm>(&["--no-preserve-roo", "-rf", "/"], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"rm: you may not abbreviate the --no-preserve-root option\n"
		);
	}
	#[test]
	fn abbreviated_spelling_after_option_terminator_is_an_operand() {
		let cwd = tempdir().unwrap();
		let file = cwd.path().join("--no-preserve-roo");
		std::fs::write(&file, b"data").unwrap();

		let (code, capture) = run_util::<Rm>(&["--", "--no-preserve-roo"], "", cwd.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!file.exists());
	}


	#[test]
	fn preserve_root_refuses_recursive_root_removal() {
		let (code, capture) = run_util::<Rm>(&["-rf", "/"], "", "/");
		assert_eq!(code, 1);
		assert!(capture.err().contains("it is dangerous to operate recursively on '/'"));
		assert!(capture.err().contains("use --no-preserve-root to override this failsafe"));
	}

	#[test]
	fn missing_operand_is_an_error_unless_forced() {
		let (code, capture) = run_util::<Rm>(&[], "", "/");
		assert_eq!(code, 1);
		assert_eq!(
			capture.err(),
			"rm: missing operand\nTry 'rm --help' for more information.\n"
		);

		let (code, capture) = run_util::<Rm>(&["-f"], "", "/");
		assert_eq!(code, 0);
		assert_eq!(capture.err(), "");
	}
}
