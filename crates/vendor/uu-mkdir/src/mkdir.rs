// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) ugoa cmode RAII

use std::{
	ffi::OsString,
	io::Write,
	path::{Path, PathBuf},
};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, parser::ValuesRef};
#[cfg(all(unix, target_os = "linux"))]
use uucore::error::FromIo;
#[cfg(not(windows))]
use uucore::mode;
use uucore::{
	display::Quotable,
	error::{UResult, USimpleError},
	format_usage,
	fs::dir_strip_dot_for_creation,
};

static DEFAULT_PERM: u32 = 0o777;

mod options {
	pub const MODE: &str = "mode";
	pub const PARENTS: &str = "parents";
	pub const VERBOSE: &str = "verbose";
	pub const DIRS: &str = "dirs";
	pub const SECURITY_CONTEXT: &str = "z";
	pub const CONTEXT: &str = "context";
}

/// Configuration for directory creation.
pub struct Config<'a> {
	/// Create parent directories as needed.
	pub recursive: bool,

	/// File permissions (octal).
	pub mode: u32,

	/// Print message for each created directory.
	pub verbose: bool,

	/// Set security context (SELinux/SMACK).
	pub set_security_context: bool,

	/// Specific `SELinux` context.
	pub context: Option<&'a String>,
}

#[cfg(windows)]
#[expect(clippy::unnecessary_wraps, reason = "fn sig must match on all platforms")]
fn get_mode(_matches: &ArgMatches) -> Result<u32, String> {
	Ok(DEFAULT_PERM)
}

#[cfg(not(windows))]
fn get_mode(matches: &ArgMatches) -> Result<u32, String> {
	// Not tested on Windows
	if let Some(m) = matches.get_one::<String>(options::MODE) {
		mode::parse_chmod(DEFAULT_PERM, m, true, mode::get_umask())
	} else {
		// If no mode argument is specified return the mode derived from umask
		Ok(!mode::get_umask() & DEFAULT_PERM)
	}
}

/// Post-parse core of mkdir, split out of the upstream `uumain` so the entry
/// point can own argument parsing (and avoid uutils' process-exiting parser).
fn run_matches(matches: &ArgMatches) -> UResult<()> {
	let dirs = matches
		.get_many::<OsString>(options::DIRS)
		.unwrap_or_default();
	let verbose = matches.get_flag(options::VERBOSE);
	let recursive = matches.get_flag(options::PARENTS);

	// Extract the SELinux related flags and options
	let set_security_context = matches.get_flag(options::SECURITY_CONTEXT);
	let context = matches.get_one::<String>(options::CONTEXT);

	match get_mode(matches) {
		Ok(mode) => {
			let config = Config {
				recursive,
				mode,
				verbose,
				set_security_context: set_security_context || context.is_some(),
				context,
			};
			exec(dirs, &config);
			Ok(())
		},
		Err(f) => Err(USimpleError::new(1, f)),
	}
}

/// In-process builtin entry point. The host installs a [`pi_uutils_ctx`] scope
/// (stdio + working directory) on a dedicated blocking thread, then calls this.
///
/// Unlike uutils' `#[uucore::main] uumain`, this never mutates process-global
/// signal handlers and never calls `std::process::exit` — clap help/usage/
/// version output is rendered to the context streams. That makes it safe to run
/// inside the long-lived host shell process.
pub fn run(args: Vec<OsString>) -> i32 {
	let matches = match uu_app().try_get_matches_from(args) {
		Ok(matches) => matches,
		Err(err) => {
			let rendered = err.to_string();
			if err.use_stderr() {
				let _ = write!(pi_uutils_ctx::stderr(), "{rendered}");
				return 1;
			}
			let _ = write!(pi_uutils_ctx::stdout(), "{rendered}");
			return 0;
		},
	};
	match run_matches(&matches) {
		Ok(()) => pi_uutils_ctx::exit_code(),
		Err(err) => {
			let code = err.code();
			let _ = writeln!(pi_uutils_ctx::stderr(), "mkdir: {err}");
			if code == 0 { 1 } else { code }
		},
	}
}

pub fn uu_app() -> Command {
	Command::new("mkdir")
		.version(uucore::crate_version!())
		.about("Create the given DIRECTORY(ies) if they do not exist")
		.override_usage(format_usage("mkdir [OPTION]... DIRECTORY..."))
		.infer_long_args(true)
		.after_help("Each MODE is of the form [ugoa]*([-+=]([rwxXst]*|[ugo]))+|[-+=]?[0-7]+.")
		.arg(
			Arg::new(options::MODE)
				.short('m')
				.long(options::MODE)
				.help("set file mode (not implemented on windows)")
				.allow_hyphen_values(true)
				.num_args(1),
		)
		.arg(
			Arg::new(options::PARENTS)
				.short('p')
				.long(options::PARENTS)
				.help("make parent directories as needed")
				.overrides_with(options::PARENTS)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("print a message for each printed directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SECURITY_CONTEXT)
				.short('Z')
				.help("set SELinux security context of each created directory to the default type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CONTEXT)
				.long(options::CONTEXT)
				.value_name("CTX")
				.help(
					"like -Z, or if CTX is specified then set the SELinux or SMACK security context to \
					 CTX",
				),
		)
		.arg(
			Arg::new(options::DIRS)
				.action(ArgAction::Append)
				.num_args(1..)
				.required(true)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::DirPath),
		)
}

/**
 * Create the list of new directories
 */
fn exec(dirs: ValuesRef<OsString>, config: &Config) {
	for dir in dirs {
		let path_buf = PathBuf::from(dir);
		let path = path_buf.as_path();

		// pi-uutils: report recoverable errors to the context stderr + exit
		// code instead of uucore's process-global `show_if_err!`.
		if let Err(e) = mkdir(path, config) {
			let _ = writeln!(pi_uutils_ctx::stderr(), "mkdir: {e}");
			pi_uutils_ctx::set_exit_code(1);
		}
	}
}

/// Create directory at a given `path`.
///
/// ## Options
///
/// * `recursive` --- create parent directories for the `path`, if they do not
///   exist.
/// * `mode` --- file mode for the directories (not implemented on windows).
/// * `verbose` --- print a message for each printed directory.
///
/// ## Trailing dot
///
/// To match the GNU behavior, a path with the last directory being a single dot
/// (like `some/path/to/.`) is created (with the dot stripped).
pub fn mkdir(path: &Path, config: &Config) -> UResult<()> {
	if path.as_os_str().is_empty() {
		return Err(USimpleError::new(1, "cannot create directory '': No such file or directory"));
	}
	// Special case to match GNU's behavior:
	// mkdir -p foo/. should work and just create foo/
	// std::fs::create_dir("foo/."); fails in pure Rust
	let path_buf = dir_strip_dot_for_creation(path);
	let path = path_buf.as_path();
	create_dir(path, false, config)
}

/// Only needed on Linux to add ACL permission bits after directory creation.
#[cfg(all(unix, target_os = "linux"))]
fn chmod(path: &Path, mode: u32) -> UResult<()> {
	use std::{
		fs::{Permissions, set_permissions},
		os::unix::fs::PermissionsExt,
	};
	let mode = Permissions::from_mode(mode);
	set_permissions(path, mode)
		.map_err_context(|| format!("cannot set permissions {}", path.quote()))
}

// Create a directory at the given path.
// Uses iterative approach instead of recursion to avoid stack overflow with
// deep nesting.
fn create_dir(path: &Path, is_parent: bool, config: &Config) -> UResult<()> {
	let path_exists = pi_uutils_ctx::resolve(path).exists();
	if path_exists && !config.recursive {
		return Err(USimpleError::new(1, format!("{}: File exists", path.maybe_quote())));
	}
	if path == Path::new("") {
		return Ok(());
	}

	// Iterative implementation: collect all directories to create, then create them
	// This avoids stack overflow with deeply nested directories
	if config.recursive {
		// Pre-allocate approximate capacity to avoid reallocations
		let mut dirs_to_create = Vec::with_capacity(16);
		let mut current = path;

		// First pass: collect all parent directories
		while let Some(parent) = current.parent() {
			if parent == Path::new("") {
				break;
			}
			dirs_to_create.push(parent);
			current = parent;
		}

		// Second pass: create directories from root to leaf
		// Only create those that don't exist
		for dir in dirs_to_create.iter().rev() {
			if !pi_uutils_ctx::resolve(dir).exists() {
				create_single_dir(dir, true, config)?;
			}
		}
	}

	// Create the target directory
	create_single_dir(path, is_parent, config)
}

/// RAII guard to restore umask on drop, ensuring cleanup even on panic.
#[cfg(unix)]
struct UmaskGuard(rustix::fs::Mode);

#[cfg(unix)]
impl UmaskGuard {
	/// Set umask to the given value and return a guard that restores the
	/// original on drop.
	fn set(new_mask: rustix::fs::Mode) -> Self {
		let old_mask = rustix::process::umask(new_mask);
		Self(old_mask)
	}
}

#[cfg(unix)]
impl Drop for UmaskGuard {
	fn drop(&mut self) {
		rustix::process::umask(self.0);
	}
}

/// Create a directory with the exact mode specified, bypassing umask.
///
/// GNU mkdir temporarily sets umask to 0 before calling mkdir(2), ensuring the
/// directory is created atomically with the correct permissions. This avoids a
/// race condition where the directory briefly exists with umask-based
/// permissions.
#[cfg(unix)]
fn create_dir_with_mode(path: &Path, mode: u32) -> std::io::Result<()> {
	use std::os::unix::fs::DirBuilderExt;

	// Temporarily set umask to 0 so the directory is created with the exact mode.
	// The guard restores the original umask on drop, even if we panic.
	let _guard = UmaskGuard::set(rustix::fs::Mode::empty());

	std::fs::DirBuilder::new().mode(mode).create(path)
}

#[cfg(not(unix))]
fn create_dir_with_mode(path: &Path, _mode: u32) -> std::io::Result<()> {
	std::fs::create_dir(path)
}

// Helper function to create a single directory with appropriate permissions
// `is_parent` argument is not used on windows
#[allow(unused_variables)]
fn create_single_dir(path: &Path, is_parent: bool, config: &Config) -> UResult<()> {
	// pi-uutils: resolve against the shell working directory for every
	// filesystem operation; the original operand `path` is kept for display.
	let fs_path = pi_uutils_ctx::resolve(path);
	let path_exists = fs_path.exists();

	// Calculate the mode to use for directory creation
	#[cfg(unix)]
	let create_mode = if is_parent {
		// For parent directories with -p, use umask-derived mode with u+wx
		(!mode::get_umask() & 0o777) | 0o300
	} else {
		config.mode
	};
	#[cfg(not(unix))]
	let create_mode = config.mode;

	match create_dir_with_mode(&fs_path, create_mode) {
		Ok(()) => {
			if config.verbose {
				writeln!(pi_uutils_ctx::stdout(), "mkdir: created directory {}", path.quote())?;
			}

			// On Linux, we may need to add ACL permission bits via chmod.
			// On other Unix systems, the directory was already created with the correct
			// mode.
			#[cfg(all(unix, target_os = "linux"))]
			if !path_exists {
				// TODO: Make this macos and freebsd compatible by creating a function to get
				// permission bits from acl in extended attributes
				let acl_perm_bits = uucore::fsxattr::get_acl_perm_bits_from_xattr(&fs_path);
				if acl_perm_bits != 0 {
					chmod(&fs_path, create_mode | acl_perm_bits)?;
				}
			}

			// Apply SELinux context if requested
			#[cfg(feature = "selinux")]
			if config.set_security_context && uucore::selinux::is_selinux_enabled() {
				if let Err(e) = uucore::selinux::set_selinux_security_context(&fs_path, config.context)
				{
					let _ = std::fs::remove_dir(&fs_path);
					return Err(USimpleError::new(1, e.to_string()));
				}
			}

			// Apply SMACK context if requested
			#[cfg(feature = "smack")]
			if config.set_security_context {
				uucore::smack::set_smack_label_and_cleanup(&fs_path, config.context, |p| {
					std::fs::remove_dir(p)
				})?;
			}
			Ok(())
		},

		Err(_) if fs_path.is_dir() => {
			// Directory already exists - check if this is a logical directory creation
			// (i.e., not just a parent reference like "test_dir/..")
			let ends_with_parent_dir =
				matches!(path.components().next_back(), Some(std::path::Component::ParentDir));

			// Print verbose message for logical directories, even if they exist
			// This matches GNU behavior for paths like "test_dir/../test_dir_a"
			if config.verbose && is_parent && config.recursive && !ends_with_parent_dir {
				writeln!(pi_uutils_ctx::stdout(), "mkdir: created directory {}", path.quote())?;
			}
			Ok(())
		},
		Err(e) => Err(e.into()),
	}
}
