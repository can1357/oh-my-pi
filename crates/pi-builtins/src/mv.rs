//! `mv` builtin: move files and directories.
//!
//! Ported from uutils coreutils 0.8.0.

use std::{
	ffi::OsString,
	fmt,
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser, error::ErrorKind};
use indicatif::{MultiProgress, ProgressBar, ProgressStyle};
use pi_vfs::{
	BlockingFs, CanonicalizeOptions, File, MissingHandling, OpenOptions, ResolveMode, SymlinkKind,
	child_path, file_name, is_virtual_path, parent_path,
};
use rustc_hash::FxHashSet;
use thiserror::Error;
#[cfg(unix)]
use uucore::fs::display_permissions_unix;
use uucore::{
	backup_control::{self, BackupMode, source_is_target_backup},
	display::Quotable,
	fs::path_ends_with_terminator,
	update_control::{self, UpdateMode},
};

use crate::{
	file_backup::{backup_display, backup_path, determine_backup_mode, determine_backup_suffix},
	host::{Host, Utility, format_usage, matches_parser, util},
	progress::stderr_draw_target,
};
#[cfg(unix)]
use self::hardlink::{
	HardlinkGroupScanner, HardlinkOptions, HardlinkTracker, create_hardlink_context,
	with_optional_hardlink_context,
};

#[derive(Debug, Error)]
enum MvError {
	#[error("cannot stat {0}: No such file or directory")]
	NoSuchFile(String),
	#[error("cannot stat {0}: Not a directory")]
	CannotStatNotADirectory(String),
	#[error("{0} and {1} are the same file")]
	SameFile(String, String),
	#[error("cannot move {0} to a subdirectory of itself, {1}")]
	SelfTargetSubdirectory(String, String),
	#[error("cannot overwrite directory {0} with non-directory")]
	DirectoryToNonDirectory(String),
	#[error("cannot overwrite non-directory {1} with directory {0}")]
	NonDirectoryToDirectory(String, String),
	#[error("target {0}: Not a directory")]
	NotADirectory(String),
	#[error("target directory {0}: Not a directory")]
	TargetNotADirectory(String),
	#[error("failed to access {0}: Not a directory")]
	FailedToAccessNotADirectory(String),
}

#[derive(Debug, Error)]
enum MvFailure {
	#[error(transparent)]
	Move(#[from] MvError),
	#[error(transparent)]
	Io(#[from] io::Error),
	#[error("{0}")]
	Message(String),
}

type MvResult<T> = Result<T, MvFailure>;

/// Parsed `mv` invocation.
pub(crate) struct Mv {
	matches: ArgMatches,
}

matches_parser!(Mv, app);

fn progress_manager(host: &Host, enabled: bool) -> Option<MultiProgress> {
	if !enabled {
		return None;
	}
	stderr_draw_target(host).map(MultiProgress::with_draw_target)
}

/// Options contains all the possible behaviors and flags for mv.
///
/// All options are public so that the options can be programmatically
/// constructed by other crates, such as nushell. That means that this struct is
/// part of our public API. It should therefore not be changed without good
/// reason.
///
/// The fields are documented with the arguments that determine their value.
#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Options {
	/// specifies overwrite behavior
	/// '-n' '--no-clobber'
	/// '-i' '--interactive'
	/// '-f' '--force'
	pub overwrite: OverwriteMode,

	/// `--backup[=CONTROL]`, `-b`
	pub backup: BackupMode,

	/// '-S' --suffix' backup suffix
	pub suffix: String,

	/// Available update mode "--update-mode=all|none|older"
	pub update: UpdateMode,

	/// Specifies target directory
	/// '-t, --target-directory=DIRECTORY'
	pub target_dir: Option<OsString>,

	/// Treat destination as a normal file
	/// '-T, --no-target-directory
	pub no_target_dir: bool,

	/// '-v, --verbose'
	pub verbose: bool,

	/// '--strip-trailing-slashes'
	pub strip_slashes: bool,

	/// '-g, --progress'
	pub progress_bar: bool,

	/// `--debug`
	pub debug: bool,

	/// `-Z, --context`
	pub context: Option<String>,
}

impl Default for Options {
	fn default() -> Self {
		Self {
			overwrite:     OverwriteMode::default(),
			backup:        BackupMode::default(),
			suffix:        backup_control::DEFAULT_BACKUP_SUFFIX.to_owned(),
			update:        UpdateMode::default(),
			target_dir:    None,
			no_target_dir: false,
			verbose:       false,
			strip_slashes: false,
			progress_bar:  false,
			debug:         false,
			context:       None,
		}
	}
}

/// specifies behavior of the overwrite flag
#[derive(Clone, Debug, Eq, PartialEq, Default)]
pub enum OverwriteMode {
	/// No flag specified - prompt for unwriteable files when stdin is TTY
	#[default]
	Default,
	/// '-n' '--no-clobber'   do not overwrite
	NoClobber,
	/// '-i' '--interactive'  prompt before overwrite
	Interactive,
	///'-f' '--force'         overwrite without prompt
	Force,
}

static OPT_FORCE: &str = "force";
static OPT_INTERACTIVE: &str = "interactive";
static OPT_NO_CLOBBER: &str = "no-clobber";
static OPT_STRIP_TRAILING_SLASHES: &str = "strip-trailing-slashes";
static OPT_TARGET_DIRECTORY: &str = "target-directory";
static OPT_NO_TARGET_DIRECTORY: &str = "no-target-directory";
static OPT_VERBOSE: &str = "verbose";
static OPT_PROGRESS: &str = "progress";
static ARG_FILES: &str = "files";
static OPT_DEBUG: &str = "debug";
static OPT_CONTEXT: &str = "context";
static OPT_SELINUX: &str = "selinux";
impl Utility for Mv {
	const NAME: &'static str = "mv";

	fn run(self, host: &mut Host) -> i32 {
		let files_len = self.matches.get_many::<OsString>(ARG_FILES).map_or(0, |v| v.len());
		if files_len == 1 && !self.matches.contains_id(OPT_TARGET_DIRECTORY) {
			let err = app().error(
				ErrorKind::TooFewValues,
				format!(
					"The argument '<{ARG_FILES}>...' requires at least 2 values, but only 1 was provided"
				),
			);
			let _ = write!(host.stderr, "{err}");
			return 1;
		}

		match run_matches(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				let _ = writeln!(host.stderr, "{}: {err}", Self::NAME);
				1
			},
		}
	}
}

fn show(host: &mut Host, err: impl fmt::Display) {
	host.error(err, 1);
}

fn run_matches(matches: &ArgMatches, host: &mut Host) -> MvResult<()> {
	let files: Vec<OsString> = matches
		.get_many::<OsString>(ARG_FILES)
		.unwrap_or_default()
		.cloned()
		.collect();

	let overwrite_mode = determine_overwrite_mode(matches);
	let backup_mode = determine_backup_mode(matches, host).map_err(MvFailure::Message)?;
	let update_mode = update_control::determine_update_mode(matches);

	if backup_mode != BackupMode::None
		&& (overwrite_mode == OverwriteMode::NoClobber
			|| update_mode == UpdateMode::None
			|| update_mode == UpdateMode::NoneFail)
	{
		return Err(MvFailure::Message(
			"cannot combine --backup with -n/--no-clobber or --update=none-fail".to_string(),
		));
	}

	let backup_suffix = determine_backup_suffix(matches, host);
	let target_dir = matches.get_one::<OsString>(OPT_TARGET_DIRECTORY).cloned();
	if let Some(maybe_dir) = &target_dir
		&& !host.fs().is_dir(host.resolve(Path::new(maybe_dir)))
	{
		return Err(MvError::TargetNotADirectory(maybe_dir.quote().to_string()).into());
	}

	let context = if matches.get_flag(OPT_SELINUX) {
		Some(String::new())
	} else {
		matches.get_one::<String>(OPT_CONTEXT).cloned()
	};

	let opts = Options {
		overwrite: overwrite_mode,
		backup: backup_mode,
		suffix: backup_suffix,
		update: update_mode,
		target_dir,
		no_target_dir: matches.get_flag(OPT_NO_TARGET_DIRECTORY),
		verbose: matches.get_flag(OPT_VERBOSE) || matches.get_flag(OPT_DEBUG),
		strip_slashes: matches.get_flag(OPT_STRIP_TRAILING_SLASHES),
		progress_bar: matches.get_flag(OPT_PROGRESS),
		debug: matches.get_flag(OPT_DEBUG),
		context,
	};

	mv(host, &files, &opts)
}

fn app() -> Command {
	Command::new("mv")
		.version("0.8.0")
		.about("Move SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.")
		.override_usage(format_usage(
			"mv [OPTION]... [-T] SOURCE DEST\nmv [OPTION]... SOURCE... DIRECTORY\nmv [OPTION]... -t \
			 DIRECTORY SOURCE...",
		))
		.after_help(format!(
			"{}\n\n{}",
			"When specifying more than one of -i, -f, -n, only the final one will take effect.\n\nDo \
			 not move a non-directory that has an existing destination with the same or newer \
			 modification timestamp;\ninstead, silently skip the file without failing. If the move \
			 is across file system boundaries, the comparison is\nto the source timestamp truncated \
			 to the resolutions of the destination file system and of the system calls used\nto \
			 update timestamps; this avoids duplicate work if several mv -u commands are executed \
			 with the same source\nand destination. This option is ignored if the -n or --no-clobber \
			 option is also specified. which gives more control\nover which existing files in the \
			 destination are replaced, and its value can be one of the following:\n\n- all This is \
			 the default operation when an --update option is not specified, and results in all \
			 existing files in the destination being replaced.\n- none This is similar to the \
			 --no-clobber option, in that no files in the destination are replaced, but also \
			 skipping a file does not induce a failure.\n- older This is the default operation when \
			 --update is specified, and results in files being replaced if they're older than the \
			 corresponding source file.",
			backup_control::BACKUP_CONTROL_LONG_HELP
		))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_FORCE)
				.short('f')
				.long(OPT_FORCE)
				.help("do not prompt before overwriting")
				.overrides_with_all([OPT_INTERACTIVE, OPT_NO_CLOBBER])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_INTERACTIVE)
				.short('i')
				.long(OPT_INTERACTIVE)
				.help("prompt before override")
				.overrides_with_all([OPT_FORCE, OPT_NO_CLOBBER])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_NO_CLOBBER)
				.short('n')
				.long(OPT_NO_CLOBBER)
				.help("do not overwrite an existing file")
				.overrides_with_all([OPT_FORCE, OPT_INTERACTIVE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_STRIP_TRAILING_SLASHES)
				.long(OPT_STRIP_TRAILING_SLASHES)
				.help("remove any trailing slashes from each SOURCE argument")
				.action(ArgAction::SetTrue),
		)
		.arg(backup_control::arguments::backup())
		.arg(backup_control::arguments::backup_no_args())
		.arg(backup_control::arguments::suffix())
		.arg(update_control::arguments::update())
		.arg(update_control::arguments::update_no_args())
		.arg(
			Arg::new(OPT_TARGET_DIRECTORY)
				.short('t')
				.long(OPT_TARGET_DIRECTORY)
				.help("move all SOURCE arguments into DIRECTORY")
				.value_name("DIRECTORY")
				.value_hint(clap::ValueHint::DirPath)
				.conflicts_with(OPT_NO_TARGET_DIRECTORY)
				.value_parser(ValueParser::os_string()),
		)
		.arg(
			Arg::new(OPT_NO_TARGET_DIRECTORY)
				.short('T')
				.long(OPT_NO_TARGET_DIRECTORY)
				.help("treat DEST as a normal file")
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
				.help("Display a progress bar.\nNote: this feature is not supported by GNU coreutils.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SELINUX)
				.short('Z')
				.help("set SELinux security context of destination file to default type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_CONTEXT)
				.long(OPT_CONTEXT)
				.value_name("CTX")
				.value_parser(clap::value_parser!(String))
				.help("like -Z, or if CTX is specified then set the SELinux security context to CTX")
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value(""),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.num_args(1..)
				.required(true)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath),
		)
		.arg(
			Arg::new(OPT_DEBUG)
				.long(OPT_DEBUG)
				.help("explain how a file is copied. Implies -v")
				.action(ArgAction::SetTrue),
		)
}

fn determine_overwrite_mode(matches: &ArgMatches) -> OverwriteMode {
	// This does not exactly match the GNU implementation:
	// The GNU mv defaults to Force, but if more than one of the
	// overwrite options are supplied, only the last takes effect.
	// To default to no-clobber in that situation seems safer:
	//
	if matches.get_flag(OPT_NO_CLOBBER) {
		OverwriteMode::NoClobber
	} else if matches.get_flag(OPT_INTERACTIVE) {
		OverwriteMode::Interactive
	} else if matches.get_flag(OPT_FORCE) {
		OverwriteMode::Force
	} else {
		OverwriteMode::Default
	}
}

fn parse_paths(files: &[OsString], opts: &Options) -> Vec<PathBuf> {
	let paths = files.iter().map(Path::new);

	if opts.strip_slashes {
		paths
			.map(|p| {
				// A virtual root keeps the `//` of its `scheme://` spelling.
				if is_virtual_path(p) && parent_path(p).is_none() {
					p.to_owned()
				} else {
					p.components().as_path().to_owned()
				}
			})
			.collect::<Vec<PathBuf>>()
	} else {
		paths.map(ToOwned::to_owned).collect::<Vec<PathBuf>>()
	}
}

fn handle_two_paths(host: &mut Host, source: &Path, target: &Path, opts: &Options) -> MvResult<()> {
	if opts.backup == BackupMode::Simple && source_is_target_backup(source, target, &opts.suffix) {
		return Err(
			io::Error::new(
				io::ErrorKind::NotFound,
				format!(
					"backing up {} might destroy source;  {} not moved",
					target.quote(),
					source.quote()
				),
			)
			.into(),
		);
	}

	let filesystem = host.fs().clone();
	let source_fs = host.resolve(source);
	let target_fs = host.resolve(target);

	if filesystem.symlink_metadata(&source_fs).is_err() {
		return Err(if path_ends_with_terminator(source) {
			MvError::CannotStatNotADirectory(source.quote().to_string()).into()
		} else {
			MvError::NoSuchFile(source.quote().to_string()).into()
		});
	}

	let source_is_dir = filesystem.is_dir(&source_fs) && !filesystem.is_symlink(&source_fs);
	let target_is_dir = if filesystem.is_symlink(&target_fs) {
		filesystem
			.canonicalize(&target_fs)
			.is_ok_and(|p| filesystem.is_dir(p))
	} else {
		filesystem.is_dir(&target_fs)
	};

	if path_ends_with_terminator(target)
		&& (!target_is_dir && !source_is_dir)
		&& !opts.no_target_dir
		&& opts.update != UpdateMode::IfOlder
	{
		return Err(MvError::FailedToAccessNotADirectory(target.quote().to_string()).into());
	}

	assert_not_same_file(host, source, target, target_is_dir, opts)?;

	if target_is_dir {
		if opts.no_target_dir {
			if filesystem.is_dir(&source_fs) {
				#[cfg(unix)]
				let (mut hardlink_tracker, hardlink_scanner) = create_hardlink_context();
				#[cfg(unix)]
				let hardlink_params = (Some(&mut hardlink_tracker), Some(&hardlink_scanner));
				#[cfg(not(unix))]
				let hardlink_params = (None, None);

				rename(host, source, target, opts, None, hardlink_params.0, hardlink_params.1)
					.map_err(|e| MvFailure::Message(format!("cannot move {} to {}: {e}", source.quote(), target.quote())))
			} else {
				Err(MvError::DirectoryToNonDirectory(target.quote().to_string()).into())
			}
		} else {
			move_files_into_dir(host, &[source.to_path_buf()], target, opts)
		}
	} else if filesystem.exists(&target_fs) && source_is_dir {
		match opts.overwrite {
			OverwriteMode::NoClobber => return Ok(()),
			OverwriteMode::Interactive => prompt_overwrite(host, target, None)?,
			OverwriteMode::Force => {},
			OverwriteMode::Default => {
				let (writable, mode) = is_writable(host, target);
				if !writable && stdin_is_terminal(host) {
					prompt_overwrite(host, target, mode)?;
				}
			},
		}
		Err(
			MvError::NonDirectoryToDirectory(source.quote().to_string(), target.quote().to_string())
				.into(),
		)
	} else {
		#[cfg(unix)]
		let (mut hardlink_tracker, hardlink_scanner) = create_hardlink_context();
		#[cfg(unix)]
		let hardlink_params = (Some(&mut hardlink_tracker), Some(&hardlink_scanner));
		#[cfg(not(unix))]
		let hardlink_params = (None, None);

		rename(host, source, target, opts, None, hardlink_params.0, hardlink_params.1)
			.map_err(|e| MvFailure::Message(format!("{e}")))
	}
}

fn assert_not_same_file(
	host: &mut Host,
	source: &Path,
	target: &Path,
	target_is_dir: bool,
	opts: &Options,
) -> MvResult<()> {
	let filesystem = host.fs().clone();
	let source_abs = host.resolve(source);
	let target_abs = host.resolve(target);
	let logical = CanonicalizeOptions::new(MissingHandling::Normal, ResolveMode::Logical);

	// we'll compare canonicalized_source and canonicalized_target for same file
	// detection
	let canonicalized_source = match filesystem.canonicalize_with(&source_abs, &logical) {
		Ok(source) if filesystem.exists(&source) => source,
		_ => source_abs.clone(), /* file or symlink target doesn't exist but its absolute path
		                          * is still used for comparison */
	};

	// special case if the target exists, is a directory, and the `-T` flag wasn't
	// used
	let target_is_dir = target_is_dir && !opts.no_target_dir;
	let canonicalized_target = if target_is_dir {
		// `mv source_file target_dir` => target_dir/source_file
		// canonicalize the path that exists (target directory) and join the source file
		// name
		child_path(
			&filesystem.canonicalize_with(&target_abs, &logical)?,
			&file_name(source).unwrap_or_default(),
		)
	} else {
		// `mv source target_dir/target` => target_dir/target
		// we canonicalize target_dir and join /target
		match parent_path(&target_abs) {
			Some(parent) if !parent.as_os_str().is_empty() => child_path(
				&filesystem.canonicalize_with(parent, &logical)?,
				&file_name(target).unwrap_or_default(),
			),
			// the parent is empty or missing if there's no parent
			_ => target_abs.clone(), /* absolute paths should always have a parent, but we'll fall
			                          * back just in case */
		}
	};

	let same_file = (canonicalized_source.eq(&canonicalized_target)
		|| are_hardlinks_to_same_file(&filesystem, &source_abs, &target_abs)
		|| are_hardlinks_or_one_way_symlink_to_same_file(&filesystem, &source_abs, &target_abs))
		&& opts.backup == BackupMode::None;

	// get the expected target path to show in errors
	// this is based on the argument and not canonicalized
	let target_display = match file_name(source) {
		// A virtual root keeps the `//` of its `scheme://` spelling.
		Some(file_name) if target_is_dir && is_virtual_path(target) && parent_path(target).is_none() => {
			child_path(target, &file_name).quote().to_string()
		},
		Some(file_name) if target_is_dir => {
			// join target_dir/source_file in a platform-independent manner
			let mut path = target
				.display()
				.to_string()
				.trim_end_matches('/')
				.to_owned();

			path.push('/');
			path.push_str(&file_name.to_string_lossy());

			path.quote().to_string()
		},
		_ => target.quote().to_string(),
	};

	if same_file
		&& (canonicalized_source.eq(&canonicalized_target)
			|| source.eq(Path::new("."))
			|| source.ends_with("/.")
			|| filesystem.is_file(&source_abs))
	{
		return Err(MvError::SameFile(source.quote().to_string(), target_display).into());
	} else if (same_file || canonicalized_target.starts_with(&canonicalized_source))
        // don't error if we're moving a symlink of a directory into itself
        && !filesystem.is_symlink(&source_abs)
	{
		return Err(
			MvError::SelfTargetSubdirectory(source.quote().to_string(), target_display).into(),
		);
	}
	Ok(())
}

/// Whether `source` and `target` are hard links to the same file, without
/// following either.
fn are_hardlinks_to_same_file(filesystem: &BlockingFs, source: &Path, target: &Path) -> bool {
	let (Ok(source), Ok(target)) =
		(filesystem.symlink_metadata(source), filesystem.symlink_metadata(target))
	else {
		return false;
	};
	source.same_file(&target)
}

/// Whether `source`, followed, is the same file as `target`, unfollowed: hard
/// links, or a symlink `source` that resolves to `target`.
fn are_hardlinks_or_one_way_symlink_to_same_file(
	filesystem: &BlockingFs,
	source: &Path,
	target: &Path,
) -> bool {
	let (Ok(source), Ok(target)) =
		(filesystem.metadata(source), filesystem.symlink_metadata(target))
	else {
		return false;
	};
	source.same_file(&target)
}

fn handle_multiple_paths(host: &mut Host, paths: &[PathBuf], opts: &Options) -> MvResult<()> {
	if opts.no_target_dir {
		return Err(MvFailure::Message(format!("mv: extra operand {}", paths.last().unwrap().quote()),
		));
	}
	let target_dir = paths.last().unwrap();
	let sources = &paths[..paths.len() - 1];

	move_files_into_dir(host, sources, target_dir, opts)
}

/// Execute the mv command. This moves 'source' to 'target', where
/// 'target' is a directory. If 'target' does not exist, and source is a single
/// file or directory, then 'source' will be renamed to 'target'.
fn mv(host: &mut Host, files: &[OsString], opts: &Options) -> MvResult<()> {
	let paths = parse_paths(files, opts);

	if let Some(name) = &opts.target_dir {
		return move_files_into_dir(host, &paths, &PathBuf::from(name), opts);
	}

	match paths.len() {
		2 => handle_two_paths(host, &paths[0], &paths[1], opts),
		_ => handle_multiple_paths(host, &paths, opts),
	}
}

#[allow(clippy::cognitive_complexity)]
fn move_files_into_dir(host: &mut Host, files: &[PathBuf], target_dir: &Path, options: &Options) -> MvResult<()> {
	// remember the moved destinations for further usage
	let mut moved_destinations: FxHashSet<PathBuf> =
		FxHashSet::with_capacity_and_hasher(files.len(), rustc_hash::FxBuildHasher);
	// Create hardlink tracking context
	#[cfg(unix)]
	let (mut hardlink_tracker, hardlink_scanner) = {
		let (tracker, mut scanner) = create_hardlink_context();

		// Use hardlink options
		let hardlink_options = HardlinkOptions { verbose: options.verbose || options.debug };

		// Pre-scan files if needed
		scanner.scan_files(host, files, &hardlink_options);

		(tracker, scanner)
	};

	if !host.fs().is_dir(host.resolve(target_dir)) {
		return Err(MvError::NotADirectory(target_dir.quote().to_string()).into());
	}

	let display_manager = progress_manager(host, options.progress_bar);

	let count_progress = if let Some(display_manager) = &display_manager {
		if files.len() > 1 {
			Some(
				display_manager.add(
					ProgressBar::new(files.len().try_into().unwrap()).with_style(
						ProgressStyle::with_template(&format!(
							"{} {{msg}} {{wide_bar}} {{pos}}/{{len}}",
							"moving"
						))
						.unwrap(),
					),
				),
			)
		} else {
			None
		}
	} else {
		None
	};

	for sourcepath in files {
		if host.fs().symlink_metadata(host.resolve(sourcepath)).is_err() {
			show(host, &MvError::NoSuchFile(sourcepath.quote().to_string()));
			continue;
		}

		if let Some(pb) = &count_progress {
			let msg = format!("{} (scanning hardlinks)", sourcepath.to_string_lossy());
			pb.set_message(msg);
		}

		let targetpath = if let Some(name) = file_name(sourcepath) {
			child_path(target_dir, &name)
		} else {
			show(host, &MvError::NoSuchFile(sourcepath.quote().to_string()));
			continue;
		};

		if moved_destinations.contains(&targetpath) && options.backup != BackupMode::Numbered {
			// If the target file was already created in this mv call, do not overwrite
			show(host, format!(
					"will not overwrite just-created {} with {}",
					targetpath.quote(),
					sourcepath.quote()
				),
			);
			continue;
		}

		// Check if we have mv dir1 dir2 dir2
		// And generate an error if this is the case
		if let Err(e) = assert_not_same_file(host, sourcepath, target_dir, true, options) {
			show(host, e);
			continue;
		}

		#[cfg(unix)]
		let hardlink_params = (Some(&mut hardlink_tracker), Some(&hardlink_scanner));
		#[cfg(not(unix))]
		let hardlink_params = (None, None);

		match rename(host, 
			sourcepath,
			&targetpath,
			options,
			display_manager.as_ref(),
			hardlink_params.0,
			hardlink_params.1,
		) {
			Err(e) if e.to_string().is_empty() => host.fail(1),
			Err(e) => {
				let e = format!("cannot move {} to {}: {e}", sourcepath.quote(), targetpath.quote());
				if let Some(pb) = &display_manager {
					pb.suspend(|| show(host, e));
				} else {
					show(host, e);
				}
			},
			Ok(()) => (),
		}
		if let Some(pb) = &count_progress {
			pb.inc(1);
		}
		moved_destinations.insert(targetpath.clone());
	}
	Ok(())
}

fn rename(
	host: &mut Host,
	from: &Path,
	to: &Path,
	opts: &Options,
	display_manager: Option<&MultiProgress>,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
	#[cfg(not(unix))] _hardlink_tracker: Option<()>,
	#[cfg(not(unix))] _hardlink_scanner: Option<()>,
) -> io::Result<()> {
	let mut backup = None;

	// filesystem checks; keep `from`/`to` for display.
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);

	if filesystem.exists(&to_fs) {
		if opts.update == UpdateMode::None {
			if opts.debug {
				let _ = writeln!(host.stdout, "skipped {}", to.quote());
			}
			return Ok(());
		}

		if (opts.update == UpdateMode::IfOlder)
			&& filesystem.metadata(&from_fs)?.modified()? <= filesystem.metadata(&to_fs)?.modified()?
		{
			return Ok(());
		}

		if opts.update == UpdateMode::NoneFail {
			return Err(io::Error::other(format!("not replacing {}", to.quote())));
		}

		match opts.overwrite {
			OverwriteMode::NoClobber => {
				if opts.debug {
					let _ = writeln!(host.stdout, "skipped {}", to.quote());
				}
				return Ok(());
			},
			OverwriteMode::Interactive => prompt_overwrite(host, to, None)?,
			OverwriteMode::Force => {},
			OverwriteMode::Default => {
				// GNU mv prompts when stdin is a TTY and target is not writable
				let (writable, mode) = is_writable(host, to);
				if !writable && stdin_is_terminal(host) {
					prompt_overwrite(host, to, mode)?;
				}
			},
		}

		// numbered-backup probing goes through the injected filesystem.
		backup = backup_path(&filesystem, opts.backup, &to_fs, &opts.suffix);
		if let Some(backup) = &backup {
			// For backup renames, we don't need to track hardlinks as we're just moving the
			// existing file
			rename_with_fallback(host, to, backup, display_manager, false, None, None)?;
		}
	}

	// "to" may no longer exist if it was backed up
	if filesystem.exists(&to_fs) && filesystem.is_dir(&to_fs) && !filesystem.is_symlink(&to_fs) {
		// normalize behavior between *nix and windows
		if filesystem.is_dir(&from_fs) {
			if is_empty_dir(host, to) {
				filesystem.remove_dir(&to_fs)?;
			} else {
				return Err(io::Error::other("Directory not empty"));
			}
		}
	}

	#[cfg(unix)]
	{
		rename_with_fallback(host, 
			from,
			to,
			display_manager,
			opts.verbose,
			hardlink_tracker,
			hardlink_scanner,
		)?;
	}
	#[cfg(not(unix))]
	{
		rename_with_fallback(host, from, to, display_manager, opts.verbose, None, None)?;
	}


	if opts.verbose {
		let message = if let Some(path) = &backup {
			// rebuild a display path from the operand for the verbose message.
			let backup_display = backup_display(to, path);
			format!("renamed {} -> {} (backup: {})", from.quote(), to.quote(), backup_display.quote())
		} else {
			format!("renamed {} -> {}", from.quote(), to.quote())
		};

		match display_manager {
			Some(pb) => pb.suspend(|| {
				let _ = writeln!(host.stdout, "{message}");
			}),
			None => {
				let _ = writeln!(host.stdout, "{message}");
			},
		}
	}
	Ok(())
}

/// Whether a failed rename crossed devices or filesystem providers, so the
/// move may be completed by copying and removing.
fn crosses_devices(error: &io::Error) -> bool {
	#[cfg(windows)]
	const EXDEV: i32 = windows_sys::Win32::Foundation::ERROR_NOT_SAME_DEVICE as _;
	#[cfg(unix)]
	const EXDEV: i32 = libc::EXDEV as _;
	#[cfg(target_os = "wasi")]
	const EXDEV: i32 = 18; // POSIX EXDEV value

	error.kind() == io::ErrorKind::CrossesDevices || error.raw_os_error() == Some(EXDEV)
}

/// A wrapper around `rename`, so that if it fails, we try falling back on
/// copying and removing.
fn rename_with_fallback(
	host: &mut Host,
	from: &Path,
	to: &Path,
	display_manager: Option<&MultiProgress>,
	verbose: bool,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
	#[cfg(not(unix))] _hardlink_tracker: Option<()>,
	#[cfg(not(unix))] _hardlink_scanner: Option<()>,
) -> io::Result<()> {
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);

	filesystem.rename(&from_fs, &to_fs).or_else(|err| {
		// We will only copy if:
		// 1. Files are on different devices or filesystem providers (EXDEV error)
		// 2. On Windows, if the target file exists and source file is opened by another
		//    process (MoveFileExW fails with "Access Denied" even if the source file
		//    has FILE_SHARE_DELETE permission)
		let should_fallback = crosses_devices(&err)
			|| (filesystem.is_file(&from_fs) && can_delete_file(host, &from_fs));
		if !should_fallback {
			return Err(err);
		}
		// Get metadata without following symlinks
		let metadata = filesystem.symlink_metadata(&from_fs)?;
		let file_type = metadata.file_type();
		if file_type.is_symlink() {
			rename_symlink_fallback(host, from, to)
		} else if file_type.is_dir() {
			#[cfg(unix)]
			{
				with_optional_hardlink_context(
					hardlink_tracker,
					hardlink_scanner,
					|tracker, scanner| {
						rename_dir_fallback(host, 
							from,
							to,
							display_manager,
							verbose,
							Some(tracker),
							Some(scanner),
						)
					},
				)
			}
			#[cfg(not(unix))]
			{
				rename_dir_fallback(host, from, to, display_manager, verbose)
			}
		} else if file_type.is_fifo() {
			rename_fifo_fallback(host, from, to)
		} else {
			#[cfg(unix)]
			{
				with_optional_hardlink_context(
					hardlink_tracker,
					hardlink_scanner,
					|tracker, scanner| rename_file_fallback(host, from, to, Some(tracker), Some(scanner)),
				)
			}
			#[cfg(not(unix))]
			{
				rename_file_fallback(host, from, to)
			}
		}
	})
}

/// Replace the destination with a new pipe with the same name as the source.
fn rename_fifo_fallback(host: &mut Host, from: &Path, to: &Path) -> io::Result<()> {
	let filesystem = host.fs();
	let to_fs = host.resolve(to);
	if filesystem.try_exists(&to_fs)? {
		filesystem.remove_file(&to_fs)?;
	}
	filesystem.make_fifo(&to_fs, 0o666)?;
	filesystem.remove_file(host.resolve(from))
}

/// Move the given symlink to the given destination, recreating its literal
/// target.
fn rename_symlink_fallback(host: &mut Host, from: &Path, to: &Path) -> io::Result<()> {
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);
	// `read_link` returns the symlink's *contents* (its literal target), which
	// must not be resolved; only the from/to operands are filesystem locations.
	let path_symlink_points_to = filesystem.read_link(&from_fs)?;
	// Windows distinguishes file and directory symlinks, even dangling ones;
	// keep the kind the source link has.
	#[cfg(windows)]
	let kind = {
		let file_type = filesystem.symlink_metadata(&from_fs)?.file_type();
		if file_type.is_symlink_dir() {
			SymlinkKind::Dir
		} else if file_type.is_symlink_file() {
			SymlinkKind::File
		} else {
			SymlinkKind::Auto
		}
	};
	#[cfg(not(windows))]
	let kind = SymlinkKind::Auto;
	filesystem.symlink_with(&path_symlink_points_to, &to_fs, kind)?;
	let _ = copy_xattrs(&filesystem, &from_fs, &to_fs);
	filesystem.remove_file(&from_fs)
}

fn rename_dir_fallback(
	host: &mut Host,
	from: &Path,
	to: &Path,
	display_manager: Option<&MultiProgress>,
	verbose: bool,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
) -> io::Result<()> {
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);
	// We remove the destination directory if it exists to match the
	// behavior of `rename`.
	if filesystem.exists(&to_fs) {
		filesystem.remove_dir_all(&to_fs)?;
	}

	// Calculate total size of directory
	// Silently degrades:
	//    If finding the total size fails for whatever reason,
	//    the progress bar wont be shown for this file / dir.
	//    (Move will probably fail due to permission error later?)
	let total_size = dir_size(&filesystem, &from_fs).ok();

	let progress_bar = match (display_manager, total_size) {
		(Some(display_manager), Some(total_size)) => {
			let template = "{msg}: [{elapsed_precise}] {wide_bar} {bytes:>7}/{total_bytes:7}";
			let style = ProgressStyle::with_template(template).unwrap();
			let bar = ProgressBar::new(total_size).with_style(style);
			Some(display_manager.add(bar))
		},
		(..) => None,
	};

	let xattrs = retrieve_xattrs(&filesystem, &from_fs, &to_fs).unwrap_or_default();

	// Use directory copying (with or without hardlink support)
	let result = copy_dir_contents(host, 
		from,
		to,
		#[cfg(unix)]
		hardlink_tracker,
		#[cfg(unix)]
		hardlink_scanner,
		verbose,
		progress_bar.as_ref(),
		display_manager,
	);

	match apply_xattrs(&filesystem, &to_fs, xattrs) {
		// A destination filesystem without extended attributes cannot keep them.
		Err(error) if error.kind() == io::ErrorKind::Unsupported => {},
		other => other?,
	}

	result?;

	// Remove the source directory after successful copy
	filesystem.remove_dir_all(&from_fs)?;

	Ok(())
}

/// Total size in bytes of the tree at `path`, not following symlinks.
fn dir_size(filesystem: &BlockingFs, path: &Path) -> io::Result<u64> {
	let metadata = filesystem.symlink_metadata(path)?;
	if !metadata.is_dir() {
		return Ok(metadata.len());
	}
	let mut size = 0;
	for entry in filesystem.read_dir(path)? {
		let entry = entry?;
		// `DirEntry::metadata` does not follow symlinks, so a symlink counts as
		// its own size and directories are summed recursively.
		let metadata = entry.metadata()?;
		size += if metadata.is_dir() { dir_size(filesystem, &entry.path())? } else { metadata.len() };
	}
	Ok(size)
}

/// Copy directory recursively, optionally preserving hardlinks
fn copy_dir_contents(
	host: &mut Host,
	from: &Path,
	to: &Path,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
	verbose: bool,
	progress_bar: Option<&ProgressBar>,
	display_manager: Option<&MultiProgress>,
) -> io::Result<()> {
	// Create the destination directory
	host.fs().create_dir_all(host.resolve(to))?;

	// Recursively copy contents
	#[cfg(unix)]
	{
		if let (Some(tracker), Some(scanner)) = (hardlink_tracker, hardlink_scanner) {
			copy_dir_contents_recursive(host, 
				from,
				to,
				tracker,
				scanner,
				verbose,
				progress_bar,
				display_manager,
			)?;
		}
	}
	#[cfg(not(unix))]
	{
		copy_dir_contents_recursive(host, from, to, verbose, progress_bar, display_manager)?;
	}

	Ok(())
}

fn copy_dir_contents_recursive(
	host: &mut Host,
	from_dir: &Path,
	to_dir: &Path,
	#[cfg(unix)] hardlink_tracker: &mut HardlinkTracker,
	#[cfg(unix)] hardlink_scanner: &HardlinkGroupScanner,
	verbose: bool,
	progress_bar: Option<&ProgressBar>,
	display_manager: Option<&MultiProgress>,
) -> io::Result<()> {
	let print_verbose = |host: &mut Host, from: &Path, to: &Path| {
		if verbose {
			let message = format!("renamed {} -> {}", from.quote(), to.quote());
			match display_manager {
				Some(pb) => pb.suspend(|| {
					let _ = writeln!(host.stdout, "{message}");
				}),
				None => {
					let _ = writeln!(host.stdout, "{message}");
				},
			}
		}
	};

	// Resolve the directory for the read, but rebuild each child path from the display operand
	// directory so recursion and verbose output keep the operand-relative form.
	let filesystem = host.fs().clone();
	let entries = filesystem.read_dir(host.resolve(from_dir))?;

	for entry in entries {
		let entry = entry?;
		let entry_name = entry.file_name();
		let from_path = child_path(from_dir, &entry_name);
		let to_path = child_path(to_dir, &entry_name);
		let from_fs = host.resolve(&from_path);

		if let Some(pb) = progress_bar {
			pb.set_message(from_path.to_string_lossy().to_string());
		}

		if filesystem.is_symlink(&from_fs) {
			// Handle symlinks first, before checking is_dir() which follows symlinks.
			// This prevents symlinks to directories from being expanded into full copies.
			#[cfg(unix)]
			{
				copy_file_with_hardlinks_helper(host, 
					&from_path,
					&to_path,
					hardlink_tracker,
					hardlink_scanner,
				)?;
			}
			#[cfg(not(unix))]
			{
				rename_symlink_fallback(host, &from_path, &to_path)?;
			}

			print_verbose(host, &from_path, &to_path);
		} else if filesystem.is_dir(&from_fs) {
			// Recursively copy subdirectory (only real directories, not symlinks)
			filesystem.create_dir_all(host.resolve(&to_path))?;

			print_verbose(host, &from_path, &to_path);

			copy_dir_contents_recursive(host, 
				&from_path,
				&to_path,
				#[cfg(unix)]
				hardlink_tracker,
				#[cfg(unix)]
				hardlink_scanner,
				verbose,
				progress_bar,
				display_manager,
			)?;
		} else {
			// Copy file with or without hardlink support based on platform
			#[cfg(unix)]
			{
				copy_file_with_hardlinks_helper(host, 
					&from_path,
					&to_path,
					hardlink_tracker,
					hardlink_scanner,
				)?;
			}
			#[cfg(not(unix))]
			{
				// Symlinks are already handled above, so this is always a regular file
				copy_file(host, &from_path, &to_path)?;
			}

			print_verbose(host, &from_path, &to_path);
		}

		if let Some(pb) = progress_bar
			&& let Ok(metadata) = filesystem.metadata(&from_fs)
		{
			pb.inc(metadata.len());
		}
	}

	Ok(())
}

#[cfg(unix)]
fn copy_file_with_hardlinks_helper(
	host: &mut Host,
	from: &Path,
	to: &Path,
	hardlink_tracker: &mut HardlinkTracker,
	hardlink_scanner: &HardlinkGroupScanner,
) -> io::Result<()> {
	// Check if this file should be a hardlink to an already-copied file
	use hardlink::HardlinkOptions;
	let hardlink_options = HardlinkOptions::default();
	let filesystem = host.fs().clone();
	// Create a hardlink instead of copying
	if let Some(existing_target) =
		hardlink_tracker.check_hardlink(host, from, to, hardlink_scanner, &hardlink_options)
	{
		filesystem.hard_link(host.resolve(&existing_target), host.resolve(to))?;
		return Ok(());
	}

	let file_type = filesystem.symlink_metadata(host.resolve(from))?.file_type();
	if file_type.is_symlink() {
		// Copy a symlink file (no-follow).
		rename_symlink_fallback(host, from, to)?;
	} else if file_type.is_fifo() {
		filesystem.make_fifo(host.resolve(to), 0o666)?;
	} else {
		// Copy a regular file.
		copy_file(host, from, to)?;
		// Extended attributes are best effort, as for any cross-filesystem move.
		let _ = copy_xattrs(&filesystem, &host.resolve(from), &host.resolve(to));
	}

	Ok(())
}

/// Copies the regular file `from` to `to` for a move between filesystems.
///
/// Native host pairs keep `std::fs::copy` semantics. Other pairs stream
/// through the injected filesystem's handles, then carry the timestamps and
/// permission bits over independently; failing to preserve either is reported
/// but, as in GNU mv, does not fail the move.
fn copy_file(host: &mut Host, from: &Path, to: &Path) -> io::Result<()> {
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);
	if filesystem.is_native_local(&from_fs) && filesystem.is_native_local(&to_fs) {
		return filesystem.copy(&from_fs, &to_fs).map(drop);
	}

	let metadata = filesystem.metadata(&from_fs)?;
	let permissions = metadata.permissions();
	let mut source = filesystem.open(&from_fs)?;
	let mut options = OpenOptions::new();
	// Owner-writable until the final permissions are applied, so a handle can
	// still be reopened to preserve timestamps.
	options
		.write(true)
		.create(true)
		.truncate(true)
		.mode((permissions.mode() & 0o7777) | 0o200);
	let mut target = filesystem.open_with(&to_fs, &options)?;
	io::copy(&mut source, &mut target)?;
	drop(source);
	target.close()?;

	// Preserve after closing, so a provider that flushes on close cannot
	// clobber the timestamps. Times go first: dropping write permission would
	// prevent the handle retry.
	let accessed = metadata.accessed().ok();
	let modified = metadata.modified().ok();
	let times = preserve(&filesystem, &to_fs, |filesystem, path| {
		filesystem.set_times(path, accessed, modified, true)
	}, |file| file.set_times(accessed, modified));
	if let Err(error) = times {
		let _ = writeln!(host.stderr, "mv: preserving times for {}: {error}", to.quote());
	}
	let mode = preserve(&filesystem, &to_fs, |filesystem, path| {
		filesystem.set_permissions(path, permissions.clone())
	}, |file| file.set_permissions(permissions.clone()));
	if let Err(error) = mode {
		let _ = writeln!(host.stderr, "mv: preserving permissions for {}: {error}", to.quote());
	}
	Ok(())
}

/// Applies a metadata change to `path`, retrying on an open handle when the
/// provider only implements the change for handles.
fn preserve(
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

fn rename_file_fallback(
	host: &mut Host,
	from: &Path,
	to: &Path,
	#[cfg(unix)] hardlink_tracker: Option<&mut HardlinkTracker>,
	#[cfg(unix)] hardlink_scanner: Option<&HardlinkGroupScanner>,
) -> io::Result<()> {
	let filesystem = host.fs().clone();
	let from_fs = host.resolve(from);
	let to_fs = host.resolve(to);
	// Remove existing target file if it exists
	if filesystem.is_symlink(&to_fs) {
		filesystem.remove_file(&to_fs).map_err(|err| {
			let inter_device_msg = format!(
				"inter-device move failed: {} to {}; unable to remove target: {err}",
				from.quote(),
				to.quote()
			);
			io::Error::new(err.kind(), inter_device_msg)
		})?;
	} else if filesystem.exists(&to_fs) {
		// For non-symlinks, just remove the file without special error handling
		filesystem.remove_file(&to_fs)?;
	}

	// Check if this file is part of a hardlink group and if so, create a hardlink
	// instead of copying
	#[cfg(unix)]
	{
		if let (Some(tracker), Some(scanner)) = (hardlink_tracker, hardlink_scanner) {
			use hardlink::HardlinkOptions;
			let hardlink_options = HardlinkOptions::default();
			if let Some(existing_target) = tracker.check_hardlink(host, from, to, scanner, &hardlink_options)
			{
				// Create a hardlink to the first moved file instead of copying
				filesystem.hard_link(host.resolve(&existing_target), &to_fs)?;
				filesystem.remove_file(&from_fs)?;
				return Ok(());
			}
		}
	}

	// Native moves report copy and unlink failures as GNU mv does; provider
	// errors keep their own description.
	let native = filesystem.is_native_local(&from_fs) && filesystem.is_native_local(&to_fs);
	let describe = |err: io::Error| {
		if native { io::Error::new(err.kind(), "Permission denied") } else { err }
	};

	// Regular file copy
	copy_file(host, from, to).map_err(describe)?;

	// Extended attributes are best effort, as for any cross-filesystem move.
	let _ = copy_xattrs(&filesystem, &from_fs, &to_fs);

	filesystem.remove_file(&from_fs).map_err(describe)?;
	Ok(())
}

/// Whether a move from `from` to `to` carries extended attributes. Native
/// macOS, Redox, and non-Unix moves never did.
fn copies_xattrs(filesystem: &BlockingFs, from: &Path, to: &Path) -> bool {
	!(cfg!(any(not(unix), target_os = "macos", target_os = "redox"))
		&& filesystem.is_native_local(from)
		&& filesystem.is_native_local(to))
}

/// Reads the extended attributes of `from`, without following symlinks.
fn retrieve_xattrs(
	filesystem: &BlockingFs,
	from: &Path,
	to: &Path,
) -> io::Result<Vec<(OsString, Vec<u8>)>> {
	if !copies_xattrs(filesystem, from, to) {
		return Ok(Vec::new());
	}
	let mut xattrs = Vec::new();
	for name in filesystem.list_xattr(from, false)? {
		if let Some(value) = filesystem.get_xattr(from, &name, false)? {
			xattrs.push((name, value));
		}
	}
	Ok(xattrs)
}

/// Sets extended attributes on `to`, without following symlinks.
fn apply_xattrs(
	filesystem: &BlockingFs,
	to: &Path,
	xattrs: Vec<(OsString, Vec<u8>)>,
) -> io::Result<()> {
	for (name, value) in xattrs {
		filesystem.set_xattr(to, &name, &value, false)?;
	}
	Ok(())
}

/// Copies extended attributes from `from` to `to`, without following symlinks.
fn copy_xattrs(filesystem: &BlockingFs, from: &Path, to: &Path) -> io::Result<()> {
	apply_xattrs(filesystem, to, retrieve_xattrs(filesystem, from, to)?)
}

fn is_empty_dir(host: &Host, path: &Path) -> bool {
	host.fs()
		.read_dir(host.resolve(path))
		.is_ok_and(|mut contents| contents.next().is_none())
}

/// Check if file is writable, returning the mode for potential reuse.
#[cfg(unix)]
fn is_writable(host: &Host, path: &Path) -> (bool, Option<u32>) {
	if let Ok(metadata) = host.fs().metadata(host.resolve(path)) {
		let mode = metadata.permissions().mode();
		// Check if user write bit is set
		((mode & 0o200) != 0, Some(mode))
	} else {
		(false, None) // If we can't get metadata, prompt user to be safe
	}
}

/// Check if file is writable.
#[cfg(not(unix))]
fn is_writable(host: &Host, path: &Path) -> (bool, Option<u32>) {
	if let Ok(metadata) = host.fs().metadata(host.resolve(path)) {
		(!metadata.permissions().readonly(), None)
	} else {
		(false, None) // If we can't get metadata, prompt user to be safe
	}
}

#[cfg(unix)]
fn get_interactive_prompt(host: &Host, to: &Path, cached_mode: Option<u32>) -> String {
	// Use cached mode if available, otherwise fetch it
	let mode = cached_mode.or_else(|| {
		host.fs()
			.metadata(host.resolve(to))
			.ok()
			.map(|m| m.permissions().mode())
	});
	if let Some(mode) = mode {
		let file_mode = mode & 0o777;
		// Check if file is not writable by user
		if (mode & 0o200) == 0 {
			let perms = display_permissions_unix(mode, false);
			let mode_info = format!("{file_mode:04o} ({perms})");
			return format!("replace {}, overriding mode {mode_info}?", to.quote());
		}
	}
	format!("overwrite {}?", to.quote())
}

#[cfg(not(unix))]
fn get_interactive_prompt(_host: &Host, to: &Path, _cached_mode: Option<u32>) -> String {
	format!("overwrite {}?", to.quote())
}

/// stdin one byte at a time (no buffering) so consecutive prompts don't
/// over-read into a later prompt's input. Returns true when the first character
/// of the line is `y`/`Y`.
fn read_yes(host: &mut Host) -> bool {
	use std::io::Read as _;
	let stdin = &mut host.stdin;
	let mut buf = [0u8; 1];
	let mut first = None;
	loop {
		match stdin.read(&mut buf) {
			Ok(0) => break, // EOF
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

/// we report "not a terminal" and take GNU mv's non-interactive path (overwrite
/// unwritable targets without prompting) instead of blocking on a read that may
/// never receive input. Explicit `-i` still prompts (it does not consult this).
fn stdin_is_terminal(host: &Host) -> bool {
	host.stdin.file().is_terminal()
}

/// Prompts the user for confirmation and returns an error if declined.
fn prompt_overwrite(host: &mut Host, to: &Path, cached_mode: Option<u32>) -> io::Result<()> {
	let prompt = get_interactive_prompt(host, to, cached_mode);
	{
		let err = &mut host.stderr;
		let _ = write!(err, "mv: {prompt} ");
		let _ = err.flush();
	}
	if !read_yes(host) {
		return Err(io::Error::other(""));
	}
	Ok(())
}

/// Checks if a file can be deleted by attempting to open it with delete
/// permissions.
#[cfg(windows)]
fn can_delete_file(host: &Host, path: &Path) -> bool {
	use std::{
		os::windows::ffi::OsStrExt as _,
		ptr::{null, null_mut},
	};

	use windows_sys::Win32::{
		Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
		Storage::FileSystem::{
			CreateFileW, DELETE, FILE_ATTRIBUTE_NORMAL, FILE_SHARE_DELETE, FILE_SHARE_READ,
			FILE_SHARE_WRITE, OPEN_EXISTING,
		},
	};

	let resolved = host.resolve(path);
	// Only native host files have a Win32 handle to probe.
	if !host.fs().is_native_local(&resolved) {
		return false;
	}
	let wide_path = resolved
		.as_os_str()
		.encode_wide()
		.chain([0])
		.collect::<Vec<u16>>();

	let handle = unsafe {
		CreateFileW(
			wide_path.as_ptr(),
			DELETE,
			FILE_SHARE_DELETE | FILE_SHARE_READ | FILE_SHARE_WRITE,
			null(),
			OPEN_EXISTING,
			FILE_ATTRIBUTE_NORMAL,
			null_mut(),
		)
	};

	if handle == INVALID_HANDLE_VALUE {
		return false;
	}

	unsafe { CloseHandle(handle) };

	true
}

#[cfg(not(windows))]
fn can_delete_file(_host: &Host, _: &Path) -> bool {
	// On non-Windows platforms, always return false to indicate that we don't need
	// to try the copy+delete fallback. This is because on Unix-like systems,
	// rename failing with errors other than EXDEV means the operation cannot
	// succeed even with a copy+delete approach (e.g. permission errors).
	false
}

/// Creates the `mv` builtin registration.
pub(crate) fn mv_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Mv, SE>()
}

#[cfg(unix)]
mod hardlink {
	use super::Host;
	use std::{
		io::{self, Write},
		path::{Path, PathBuf},
	};

	use pi_vfs::{FileId, Metadata};
	use rustc_hash::FxHashMap;
	use uucore::display::Quotable;

	/// Tracks hardlinks during cross-partition moves to preserve them
	#[derive(Debug, Default)]
	pub struct HardlinkTracker {
		/// Maps file identity -> destination path for the first occurrence
		inode_map: FxHashMap<FileId, PathBuf>,
	}

	/// Pre-scans files to identify hardlink groups with optimized memory usage
	#[derive(Debug, Default)]
	pub struct HardlinkGroupScanner {
		/// Maps file identity -> list of source paths that are hardlinked together
		hardlink_groups: FxHashMap<FileId, Vec<PathBuf>>,
		/// List of source files/directories being moved (for destination mapping)
		source_files:    Vec<PathBuf>,
		/// Whether scanning has been performed
		scanned:         bool,
	}

	/// Configuration options for hardlink preservation
	#[derive(Debug, Clone, Default)]
	pub struct HardlinkOptions {
		/// Whether to show verbose output about hardlink operations
		pub verbose: bool,
	}

	/// Errors that can occur during hardlink operations
	#[derive(Debug)]
	pub enum HardlinkError {
		/// An underlying filesystem operation failed.
		Io(io::Error),
		/// Pre-scanning a hardlink group failed.
		Scan(String),
		/// Recreating a hardlink at its destination failed.
		Preservation { source: PathBuf, target: PathBuf },
		/// Metadata for a candidate hardlink could not be read.
		Metadata { path: PathBuf, error: io::Error },
	}

	impl std::fmt::Display for HardlinkError {
		fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
			match self {
				Self::Io(e) => write!(f, "I/O error during hardlink operation: {e}"),
				Self::Scan(msg) => {
					write!(f, "Failed to scan files for hardlinks: {msg}")
				},
				Self::Preservation { source, target } => {
					write!(f, "Failed to preserve hardlink: {} -> {}", source.quote(), target.quote())
				},
				Self::Metadata { path, error } => {
					write!(f, "Metadata access error for {}: {error}", path.quote())
				},
			}
		}
	}

	impl std::error::Error for HardlinkError {
		fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
			match self {
				Self::Io(e) => Some(e),
				Self::Metadata { error, .. } => Some(error),
				_ => None,
			}
		}
	}

	impl From<io::Error> for HardlinkError {
		fn from(error: io::Error) -> Self {
			Self::Io(error)
		}
	}

	impl From<HardlinkError> for io::Error {
		fn from(error: HardlinkError) -> Self {
			match error {
				HardlinkError::Io(e) => e,
				HardlinkError::Scan(msg) => Self::other(msg),
				HardlinkError::Preservation { source, target } => Self::other(format!(
					"Failed to preserve hardlink: {} -> {}",
					source.quote(),
					target.quote()
				)),

				HardlinkError::Metadata { path, error } => {
					Self::other(format!("Metadata access error for {}: {error}", path.quote(),))
				},
			}
		}
	}

	impl HardlinkTracker {
		/// Creates an empty hardlink tracker.
		pub fn new() -> Self {
			Self::default()
		}

		/// Check if a file is a hardlink we've seen before, and return the target
		/// path if so
		pub fn check_hardlink(
			&mut self,
			host: &mut Host,
			source: &Path,
			dest: &Path,
			scanner: &HardlinkGroupScanner,
			options: &HardlinkOptions,
		) -> Option<PathBuf> {
			let metadata = match host.fs().metadata(host.resolve(source)) {
				Ok(meta) => meta,
				Err(e) => {
					// Gracefully handle metadata errors by logging and continuing without hardlink
					// tracking
					if options.verbose {
						let _ = writeln!(
							host.stderr,
							"warning: cannot get metadata for {}: {e}",
							source.quote()
						);
					}
					return None;
				},
			};

			// Without an identity the file cannot be matched to its other links.
			let key = metadata.file_id()?;

			// Check if we've already processed a file with this inode
			if let Some(existing_path) = self.inode_map.get(&key) {
				// Check if this file is part of a hardlink group from the scanner
				let has_hardlinks = scanner
					.hardlink_groups
					.get(&key)
					.is_some_and(|group| group.len() > 1);

				if has_hardlinks {
					if options.verbose {
						let _ = writeln!(
							host.stderr,
							"preserving hardlink {} -> {} (hardlinked)",
							source.quote(),
							existing_path.quote()
						);
					}
					return Some(existing_path.clone());
				}
			}

			// This is the first time we see this file, record its destination
			self.inode_map.insert(key, dest.to_path_buf());

			None
		}
	}

	impl HardlinkGroupScanner {
		/// Creates an empty hardlink group scanner.
		pub fn new() -> Self {
			Self::default()
		}

		/// Scan files and group them by hardlinks, including recursive directory
		/// scanning
		pub fn scan_files(&mut self, host: &mut Host, files: &[PathBuf], options: &HardlinkOptions) {
			if self.scanned {
				return;
			}

			// Store the source files for destination mapping
			self.source_files = files.to_vec();

			for file in files {
				if let Err(e) = self.scan_single_path(host, file)
					&& options.verbose
				{
					// Only show warnings for verbose mode
					let _ =
						writeln!(host.stderr, "warning: failed to scan {}: {e}", file.quote());
				}
				// For non-verbose mode, silently continue for missing files
				// This provides graceful degradation - we'll lose hardlink info for
				// this file but can still preserve hardlinks for other files
			}

			self.scanned = true;

			if options.verbose {
				let stats = self.stats();
				if stats.total_groups > 0 {
					let _ = writeln!(
						host.stderr,
						"found {} hardlink groups with {} total files",
						stats.total_groups,
						stats.total_files
					);
				}
			}
		}

		/// Scan a single path (file or directory)
		fn scan_single_path(&mut self, host: &mut Host, path: &Path) -> io::Result<()> {
			let resolved = host.resolve(path);
			if host.fs().is_dir(&resolved) {
				// Recursively scan directory contents
				self.scan_directory_recursive(host, path)?;
			} else {
				let metadata = host.fs().metadata(&resolved)?;
				self.record(&metadata, path.to_path_buf());
			}
			Ok(())
		}

		/// Recursively scan a directory for hardlinked files
		fn scan_directory_recursive(&mut self, host: &mut Host, dir: &Path) -> io::Result<()> {
			let filesystem = host.fs().clone();
			let entries = filesystem.read_dir(host.resolve(dir))?;
			for entry in entries {
				let entry = entry?;
				let path = entry.path();

				if filesystem.is_dir(&path) {
					self.scan_directory_recursive(host, &path)?;
				} else {
					let metadata = filesystem.metadata(&path)?;
					self.record(&metadata, path);
				}
			}
			Ok(())
		}

		/// Adds `path` to its hardlink group when the file has several links and
		/// an identity to group by.
		fn record(&mut self, metadata: &Metadata, path: PathBuf) {
			if metadata.nlink().is_some_and(|links| links > 1)
				&& let Some(key) = metadata.file_id()
			{
				self.hardlink_groups.entry(key).or_default().push(path);
			}
		}


		/// Get statistics about scanned hardlinks
		#[cfg(unix)]
		pub fn stats(&self) -> ScannerStats {
			let total_groups = self.hardlink_groups.len();
			let total_files = self.hardlink_groups.values().map(Vec::len).sum();

			ScannerStats { total_groups, total_files }
		}
	}

	/// Statistics about hardlink scanning
	#[derive(Debug, Clone)]
	pub struct ScannerStats {
		/// Number of distinct inode groups found.
		pub total_groups: usize,
		/// Number of files belonging to those groups.
		pub total_files:  usize,
	}

	/// Create a new hardlink tracker and scanner pair
	pub fn create_hardlink_context() -> (HardlinkTracker, HardlinkGroupScanner) {
		(HardlinkTracker::new(), HardlinkGroupScanner::new())
	}

	/// Convenient function to execute operations with proper hardlink context
	/// handling
	pub fn with_optional_hardlink_context<F, R>(
		tracker: Option<&mut HardlinkTracker>,
		scanner: Option<&HardlinkGroupScanner>,
		operation: F,
	) -> R
	where
		F: FnOnce(&mut HardlinkTracker, &HardlinkGroupScanner) -> R,
	{
		if let (Some(tracker), Some(scanner)) = (tracker, scanner) {
			operation(tracker, scanner)
		} else {
			let (mut dummy_tracker, dummy_scanner) = create_hardlink_context();
			operation(&mut dummy_tracker, &dummy_scanner)
		}
	}

}
#[cfg(test)]
mod tests {
	use std::{env, fs};

	use clap::Parser;

	use tempfile::tempdir;

	use super::Mv;
	use crate::host::{Host, Utility, run_util};

	#[test]
	fn relative_rename_uses_host_working_directory() {
		let fixture = tempdir().unwrap();
		assert_ne!(env::current_dir().unwrap(), fixture.path());
		fs::write(fixture.path().join("source"), b"payload").unwrap();

		let (code, capture) = run_util::<Mv>(&["source", "target"], "", fixture.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!fixture.path().join("source").exists());
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"payload");
	}

	#[test]
	fn interactive_decline_preserves_destination() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();

		let (code, capture) = run_util::<Mv>(&["-i", "source", "target"], "n\n", fixture.path());

		assert_eq!(code, 1);
		assert_eq!(fs::read(fixture.path().join("source")).unwrap(), b"new");
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"old");
		assert_eq!(capture.err(), "mv: overwrite 'target'? mv: \n");
	}

	#[test]
	fn interactive_accept_replaces_destination() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();

		let (code, capture) = run_util::<Mv>(&["-i", "source", "target"], "y\n", fixture.path());

		assert_eq!(code, 0, "{}", capture.err());
		assert!(!fixture.path().join("source").exists());
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"new");
	}

	#[test]
	fn backup_configuration_uses_host_environment() {
		let fixture = tempdir().unwrap();
		fs::write(fixture.path().join("source"), b"new").unwrap();
		fs::write(fixture.path().join("target"), b"old").unwrap();
		let (mut host, capture) = Host::for_test("mv", "", fixture.path());
		host.set_test_var("VERSION_CONTROL", "simple");
		host.set_test_var("SIMPLE_BACKUP_SUFFIX", ".old");
		let parsed = Mv::try_parse_from(["mv", "-b", "source", "target"]).unwrap();

		let code = parsed.run(&mut host);

		assert_eq!(code, 0, "{}", capture.err());
		assert_eq!(fs::read(fixture.path().join("target")).unwrap(), b"new");
		assert_eq!(fs::read(fixture.path().join("target.old")).unwrap(), b"old");
	}

	#[test]
	fn missing_source_reports_original_operand() {
		let fixture = tempdir().unwrap();
		let (code, capture) = run_util::<Mv>(&["missing", "target"], "", fixture.path());
		assert_eq!(code, 1);
		assert_eq!(capture.err(), "mv: cannot stat 'missing': No such file or directory\n");
	}
}
