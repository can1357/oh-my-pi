//! `ln` builtin: make hard and symbolic links.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(any(unix, target_os = "redox"))]
use std::os::unix::fs::symlink;
#[cfg(windows)]
use std::os::windows::fs::{symlink_dir, symlink_file};
use std::{
	borrow::Cow,
	collections::HashSet,
	ffi::OsString,
	fs,
	io::{Read, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use thiserror::Error;
use uucore::{
	backup_control::{self, BackupMode},
	display::Quotable,
	fs::{
		MissingHandling, ResolveMode, canonicalize, make_path_relative_to, paths_refer_to_same_file,
	},
};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

struct Settings {
	overwrite:      OverwriteMode,
	backup:         BackupMode,
	suffix:         OsString,
	symbolic:       bool,
	relative:       bool,
	logical:        bool,
	target_dir:     Option<PathBuf>,
	no_target_dir:  bool,
	no_dereference: bool,
	verbose:        bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum OverwriteMode {
	NoClobber,
	Interactive,
	Force,
}

#[derive(Error, Debug)]
enum LnError {
	#[error("target {} is not a directory", _0.quote())]
	TargetIsNotADirectory(PathBuf),

	#[error("")]
	SomeLinksFailed,

	#[error("{} and {} are the same file", _0.quote(), _1.quote())]
	SameFile(PathBuf, PathBuf),

	#[error("missing destination file operand after {}", _0.quote())]
	MissingDestination(PathBuf),

	#[error("extra operand {}\nTry '{} --help' for more information.", _0.quote(), _1)]
	ExtraOperand(OsString, String),

	#[error("{}: hard link not allowed for directory", _0.to_string_lossy())]
	FailedToCreateHardLinkDir(PathBuf),

	#[error("{0}")]
	Message(String),

	#[error("{0}")]
	Io(#[from] std::io::Error),
}


mod options {
	pub const FORCE: &str = "force";
	//pub const DIRECTORY: &str = "directory";
	pub const INTERACTIVE: &str = "interactive";
	pub const NO_DEREFERENCE: &str = "no-dereference";
	pub const SYMBOLIC: &str = "symbolic";
	pub const LOGICAL: &str = "logical";
	pub const PHYSICAL: &str = "physical";
	pub const TARGET_DIRECTORY: &str = "target-directory";
	pub const NO_TARGET_DIRECTORY: &str = "no-target-directory";
	pub const RELATIVE: &str = "relative";
	pub const VERBOSE: &str = "verbose";
}

static ARG_FILES: &str = "files";

/// Parsed `ln` invocation.
pub(crate) struct Ln {
	matches: ArgMatches,
}

matches_parser!(Ln, uu_app);

type LnResult<T> = Result<T, LnError>;

fn show_error(host: &mut Host, msg: impl std::fmt::Display) {
	let rendered = msg.to_string();
	if !rendered.is_empty() {
		let _ = writeln!(host.stderr, "ln: {rendered}");
	}
}

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

fn prompt_yes(host: &mut Host, prompt: impl std::fmt::Display) -> bool {
	let _ = write!(host.stderr, "ln: {prompt} ");
	let _ = host.stderr.flush();
	read_yes(host)
}

impl Utility for Ln {
	const NAME: &'static str = "ln";

	fn run(self, host: &mut Host) -> i32 {
		match ln_main(&self.matches, host) {
			Ok(()) => host.exit_code(),
			Err(err) => {
				show_error(host, err);
				1
			},
		}
	}
}

fn ln_main(matches: &ArgMatches, host: &mut Host) -> LnResult<()> {
	/* the list of files */

	let paths: Vec<PathBuf> = matches
		.get_many::<OsString>(ARG_FILES)
		.unwrap()
		.map(PathBuf::from)
		.collect();

	let symbolic = matches.get_flag(options::SYMBOLIC);

	let overwrite_mode = if matches.get_flag(options::FORCE) {
		OverwriteMode::Force
	} else if matches.get_flag(options::INTERACTIVE) {
		OverwriteMode::Interactive
	} else {
		OverwriteMode::NoClobber
	};

	let backup_mode = backup_control::determine_backup_mode(matches)
		.map_err(|error| LnError::Message(error.to_string()))?;
	let backup_suffix = backup_control::determine_backup_suffix(matches);

	// When we have "-L" or "-L -P", false otherwise
	let logical = matches.get_flag(options::LOGICAL);

	let settings = Settings {
		overwrite: overwrite_mode,
		backup: backup_mode,
		suffix: OsString::from(backup_suffix),
		symbolic,
		logical,
		relative: matches.get_flag(options::RELATIVE),
		target_dir: matches
			.get_one::<OsString>(options::TARGET_DIRECTORY)
			.map(PathBuf::from),
		no_target_dir: matches.get_flag(options::NO_TARGET_DIRECTORY),
		no_dereference: matches.get_flag(options::NO_DEREFERENCE),
		verbose: matches.get_flag(options::VERBOSE),
	};

	exec(host, &paths[..], &settings)
}

fn uu_app() -> Command {
	let after_help = format!(
		"In the 1st form, create a link to TARGET with the name LINK_NAME.\nIn the 2nd form, create \
		 a link to TARGET in the current directory.\nIn the 3rd and 4th forms, create links to each \
		 TARGET in DIRECTORY.\nCreate hard links by default, symbolic links with --symbolic.\nBy \
		 default, each destination (name of new link) should not already exist.\nWhen creating hard \
		 links, each TARGET must exist. Symbolic links\ncan hold arbitrary text; if later resolved, \
		 a relative link is\ninterpreted in relation to its parent directory.\n\n{}",
		backup_control::BACKUP_CONTROL_LONG_HELP
	);

	Command::new("ln")
		.version("0.8.0")
		.about("Make links between files.")
		.override_usage(format_usage(
			"ln [OPTION]... [-T] TARGET LINK_NAME\nln [OPTION]... TARGET\nln [OPTION]... TARGET... \
			 DIRECTORY\nln [OPTION]... -t DIRECTORY TARGET...",
		))
		.infer_long_args(true)
		// Free `-h` for the BSD `--no-dereference` alias; `--help` remains.
		.disable_help_flag(true)
		.arg(
			Arg::new("help")
				.long("help")
				.help("Print help information")
				.action(ArgAction::Help),
		)
		.after_help(after_help)
		.arg(backup_control::arguments::backup())
		.arg(backup_control::arguments::backup_no_args())
		/*.arg(
			Arg::new(options::DIRECTORY)
				.short('d')
				.long(options::DIRECTORY)
				.help("allow users with appropriate privileges to attempt to make hard links to directories")
		)*/
		.arg(
			Arg::new(options::FORCE)
				.short('f')
				.long(options::FORCE)
				.help("remove existing destination files")
				.overrides_with(options::INTERACTIVE)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::INTERACTIVE)
				.short('i')
				.long(options::INTERACTIVE)
				.help("prompt whether to remove existing destination files")
				.overrides_with(options::FORCE)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_DEREFERENCE)
				.short('n')
				// BSD/macOS spells `--no-dereference` as `-h`.
				.short_alias('h')
				.long(options::NO_DEREFERENCE)
				.help("treat LINK_NAME as a normal file if it is a\nsymbolic link to a directory")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::LOGICAL)
				.short('L')
				.long(options::LOGICAL)
				.help("follow TARGETs that are symbolic links")
				.overrides_with(options::PHYSICAL)
				.action(ArgAction::SetTrue),
		)
		.arg(
			// Not implemented yet
			Arg::new(options::PHYSICAL)
				.short('P')
				.long(options::PHYSICAL)
				.help("make hard links directly to symbolic links")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SYMBOLIC)
				.short('s')
				.long(options::SYMBOLIC)
				.help("make symbolic links instead of hard links")
				// override added for https://github.com/uutils/coreutils/issues/2359
				.overrides_with(options::SYMBOLIC)
				.action(ArgAction::SetTrue),
		)
		.arg(backup_control::arguments::suffix())
		.arg(
			Arg::new(options::TARGET_DIRECTORY)
				.short('t')
				.long(options::TARGET_DIRECTORY)
				.help("specify the DIRECTORY in which to create the links")
				.value_name("DIRECTORY")
				.value_hint(clap::ValueHint::DirPath)
				.value_parser(clap::value_parser!(OsString))
				.conflicts_with(options::NO_TARGET_DIRECTORY),
		)
		.arg(
			Arg::new(options::NO_TARGET_DIRECTORY)
				.short('T')
				.long(options::NO_TARGET_DIRECTORY)
				.help("treat LINK_NAME as a normal file always")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::RELATIVE)
				.short('r')
				.long(options::RELATIVE)
				.help("create symbolic links relative to link location")
				.requires(options::SYMBOLIC)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::VERBOSE)
				.short('v')
				.long(options::VERBOSE)
				.help("print name of each linked file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_FILES)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(clap::value_parser!(OsString))
				.required(true)
				.num_args(1..),
		)
}

/// Creates the `ln` builtin registration.
pub(crate) fn ln_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Ln, SE>()
}

fn exec(host: &mut Host, files: &[PathBuf], settings: &Settings) -> LnResult<()> {
	// Handle cases where we create links in a directory first.
	if let Some(target_path) = &settings.target_dir {
		// 4th form: a directory is specified by -t.
		return link_files_in_dir(host, files, target_path, settings);
	}
	if !settings.no_target_dir {
		if files.len() == 1 {
			// 2nd form: the target directory is the current directory.
			return link_files_in_dir(host, files, &PathBuf::from("."), settings);
		}
		let last_file = &PathBuf::from(files.last().unwrap());

		if files.len() > 2 || host.resolve(last_file).is_dir() {
			// 3rd form: create links in the last argument.
			return link_files_in_dir(host, &files[0..files.len() - 1], last_file, settings);
		}
	}

	// 1st form. Now there should be only two operands, but if -T is
	// specified we may have a wrong number of operands.
	if files.len() == 1 {
		return Err(LnError::MissingDestination(files[0].clone()).into());
	}
	if files.len() > 2 {
		return Err(LnError::ExtraOperand(files[2].clone().into(), "ln".to_string()));
	}
	assert!(!files.is_empty());

	link(host, &files[0], &files[1], settings)
}

fn link_files_in_dir(
	host: &mut Host,
	files: &[PathBuf],
	target_dir: &Path,
	settings: &Settings,
) -> LnResult<()> {
	// Keep the operand spelling for diagnostics and link-name construction.
	let target_dir_fs = host.resolve(target_dir);
	if !target_dir_fs.is_dir() {
		return Err(LnError::TargetIsNotADirectory(target_dir.to_owned()).into());
	}
	// remember the linked destinations for further usage
	let mut linked_destinations: HashSet<PathBuf> = HashSet::with_capacity(files.len());

	let mut all_successful = true;
	for srcpath in files {
		let targetpath = if settings.no_dereference && target_dir_fs.is_symlink() {
			let remove_target = |host: &mut Host| {
				// In that case, we don't want to do link resolution.
				if target_dir_fs.is_file()
					&& let Err(e) = fs::remove_file(&target_dir_fs)
				{
					show_error(host, format_args!("Could not update {}: {e}", target_dir.quote()));
				}
				#[cfg(windows)]
				if target_dir_fs.is_dir() {
					// On Windows a directory symlink can be considered a directory.
					if let Err(e) = fs::remove_dir(&target_dir_fs) {
						show_error(host, format_args!("Could not update {}: {e}", target_dir.quote()));
					}
				}
			};
			match settings.overwrite {
				OverwriteMode::NoClobber => {},
				OverwriteMode::Interactive => {
					if prompt_yes(host, format_args!("replace {}?", target_dir.quote())) {
						remove_target(host);
					}
				},
				OverwriteMode::Force => {
					remove_target(host);
				},
			}
			target_dir.to_path_buf()
		} else if let Some(name) = srcpath.as_os_str().to_str() {
			match Path::new(name).file_name() {
				Some(basename) => target_dir.join(basename),
				// This can be None only for "." or "..". Trying
				// to create a link with such name will fail with
				// EEXIST, which agrees with the behavior of GNU
				// coreutils.
				None => target_dir.join(name),
			}
		} else {
			show_error(host, format_args!("cannot stat {}: No such file or directory", srcpath.quote()));
			all_successful = false;
			continue;
		};

		if linked_destinations.contains(&targetpath) {
			// If the target file was already created in this ln call, do not overwrite
			show_error(host, format_args!(
				"will not overwrite just-created {} with {}",
				targetpath.quote(),
				srcpath.quote()
			));
			all_successful = false;
		} else if let Err(e) = link(host, srcpath, &targetpath, settings) {
			show_error(host, format_args!("{e}"));
			all_successful = false;
		}

		linked_destinations.insert(targetpath.clone());
	}
	if all_successful {
		Ok(())
	} else {
		Err(LnError::SomeLinksFailed.into())
	}
}

fn relative_path<'a>(host: &Host, src: &'a Path, dst: &Path) -> Cow<'a, Path> {
	// Resolve before canonicalizing so `-r` computes against the shell cwd.
	if let Ok(src_abs) =
		canonicalize(host.resolve(src), MissingHandling::Missing, ResolveMode::Physical)
		&& let Ok(dst_abs) = canonicalize(
			host.resolve(dst.parent().unwrap()),
			MissingHandling::Missing,
			ResolveMode::Physical,
		) {
		return make_path_relative_to(src_abs, dst_abs).into();
	}
	src.into()
}

fn link(host: &mut Host, src: &Path, dst: &Path, settings: &Settings) -> LnResult<()> {
	let mut backup_path = None;
	let source: Cow<'_, Path> = if settings.relative {
		relative_path(host, src, dst)
	} else {
		src.into()
	};

	// Resolve both filesystem operands, but never resolve `source`: it is the
	// text stored inside a symbolic link.
	let src_fs = host.resolve(src);
	let dst_fs = host.resolve(dst);

	if dst_fs.is_symlink() || dst_fs.exists() {
		// Probe numbered backups from the resolved destination.
		backup_path = backup_control::get_backup_path(settings.backup, &dst_fs, &settings.suffix);
		if settings.backup == BackupMode::Existing && !settings.symbolic {
			// when ln --backup f f, it should detect that it is the same file
			if paths_refer_to_same_file(&src_fs, &dst_fs, true) {
				return Err(LnError::SameFile(src.to_owned(), dst.to_owned()).into());
			}
		}
		if let Some(p) = &backup_path {
			fs::rename(&dst_fs, p)
				.map_err(|e| LnError::Message(format!("cannot backup {}: {e}", dst.quote())))?;
		}
		match settings.overwrite {
			OverwriteMode::NoClobber => {},
			OverwriteMode::Interactive => {
				if !prompt_yes(host, format_args!("replace {}?", dst.quote())) {
					return Err(LnError::SomeLinksFailed.into());
				}

				let _ = fs::remove_file(&dst_fs);
				// In case of error, don't do anything
			},
			OverwriteMode::Force => {
				if !dst_fs.is_symlink() && paths_refer_to_same_file(&src_fs, &dst_fs, true) {
					// Even in force overwrite mode, verify we are not targeting the same entry and
					// return a SameFile error if so
					let same_entry = match (
						canonicalize(&src_fs, MissingHandling::Missing, ResolveMode::Physical),
						canonicalize(&dst_fs, MissingHandling::Missing, ResolveMode::Physical),
					) {
						(Ok(src), Ok(dst)) => src == dst,
						_ => true,
					};
					if same_entry {
						return Err(LnError::SameFile(src.to_owned(), dst.to_owned()).into());
					}
				}
				let _ = fs::remove_file(&dst_fs);
				// In case of error, don't do anything
			},
		}
	}

	let res: LnResult<()> = if settings.symbolic {
		make_symlink(host, &source, &dst_fs).map_err(|e| {
			LnError::Message(format!(
				"failed to create symbolic link {}: {}",
				dst.quote(),
				strip_errno(&e)
			))
		})
	} else {
		// Hard links dereference their target, so syscalls get the resolved source.
		let source_fs = host.resolve(&source);
		let p = if settings.logical && source_fs.is_symlink() {
			fs::canonicalize(&source_fs).map_err(|e| {
				LnError::Message(format!("failed to access {}: {e}", source.quote()))
			})?
		} else {
			source_fs
		};
		match fs::hard_link(&p, &dst_fs) {
			Ok(()) => Ok(()),
			Err(_) if p.is_dir() => {
				Err(LnError::FailedToCreateHardLinkDir(source.to_path_buf()).into())
			},
			Err(e) => Err(LnError::Message(format!(
				"failed to create hard link {} => {}: {}",
				source.quote(),
				dst.quote(),
				strip_errno(&e)
			))),
		}
	};

	if let Err(e) = res {
		if let Some(p) = &backup_path {
			fs::rename(p, &dst_fs)
				.map_err(|e| LnError::Message(format!("cannot backup {}: {e}", dst.quote())))?;
		}
		return Err(e);
	}

	if settings.verbose {

		let out = &mut host.stdout;
		write!(out, "{} -> {}", dst.quote(), source.quote())?;
		match backup_path {
			Some(path) => {
				// Rebuild a display path from the operand because the backup path is resolved.
				let backup_display = match (dst.parent(), path.file_name()) {
					(Some(parent), Some(name)) if !parent.as_os_str().is_empty() => parent.join(name),
					(_, Some(name)) => PathBuf::from(name),
					_ => path.clone(),
				};
				writeln!(out, " (backup: {})", backup_display.quote())?;
			},
			None => writeln!(out)?,
		}
	}
	Ok(())
}

fn strip_errno(error: &std::io::Error) -> String {
	let rendered = error.to_string();
	rendered
		.rsplit_once(" (os error ")
		.map_or(rendered.as_str(), |(message, _)| message)
		.to_string()
}

#[cfg(any(unix, target_os = "redox"))]
fn make_symlink<P1: AsRef<Path>, P2: AsRef<Path>>(
	_host: &Host,
	src: P1,
	dst: P2,
) -> std::io::Result<()> {
	symlink(src, dst)
}

#[cfg(windows)]
fn make_symlink<P1: AsRef<Path>, P2: AsRef<Path>>(
	host: &Host,
	src: P1,
	dst: P2,
) -> std::io::Result<()> {
	if host.resolve(src.as_ref()).is_dir() {
		symlink_dir(src, dst)
	} else {
		symlink_file(src, dst)
	}
}

#[cfg(target_os = "wasi")]
fn make_symlink<P1: AsRef<Path>, P2: AsRef<Path>>(
	_host: &Host,
	_src: P1,
	_dst: P2,
) -> std::io::Result<()> {
	Err(std::io::Error::new(
		std::io::ErrorKind::Unsupported,
		"symlinks not supported on this platform",
	))
}

#[cfg(test)]
mod tests {
	use std::{fs, path::PathBuf};

	use super::Ln;
	use crate::host::run_util;

	fn run_in(cwd: PathBuf, args: &[&str]) -> (i32, String, String) {
		let (code, capture) = run_util::<Ln>(args, "", cwd);
		(code, capture.out(), capture.err())
	}

	fn run_with_stdin(cwd: PathBuf, args: &[&str], stdin: &str) -> (i32, String, String) {
		let (code, capture) = run_util::<Ln>(args, stdin, cwd);
		(code, capture.out(), capture.err())
	}

	/// Canonicalized temp dir (macOS tempdirs live behind /var -> /private/var).
	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canon = fs::canonicalize(dir.path()).unwrap();
		(dir, canon)
	}

	#[cfg(unix)]
	#[test]
	fn relative_symlink_target_is_literal_while_link_path_resolves() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root.clone(), &["-s", "../a", "b"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("b")).unwrap(), PathBuf::from("../a"));
	}

	#[cfg(unix)]
	#[test]
	fn bsd_dash_h_replaces_symlink_to_directory() {
		let (_dir, root) = canonical_tempdir();
		fs::create_dir(root.join("dir_a")).unwrap();
		fs::create_dir(root.join("dir_b")).unwrap();
		std::os::unix::fs::symlink("dir_a", root.join("cur")).unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &["-sfh", "dir_b", "cur"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("cur")).unwrap(), PathBuf::from("dir_b"));
		assert!(!root.join("dir_a").join("dir_b").exists());
	}

	#[cfg(unix)]
	#[test]
	fn hard_link_shares_inode() {
		use std::os::unix::fs::MetadataExt;

		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("a"), b"payload").unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &["a", "b"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read(root.join("b")).unwrap(), b"payload");
		assert_eq!(fs::metadata(root.join("a")).unwrap().nlink(), 2);
		assert_eq!(
			fs::metadata(root.join("a")).unwrap().ino(),
			fs::metadata(root.join("b")).unwrap().ino()
		);
	}

	#[cfg(unix)]
	#[test]
	fn existing_destination_without_force_fails_with_file_exists() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("link"), b"old").unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &["-s", "target", "link"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "ln: failed to create symbolic link 'link': File exists\n");
		assert_eq!(fs::read(root.join("link")).unwrap(), b"old");
	}

	#[cfg(unix)]
	#[test]
	fn force_overwrites_existing_destination() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("link"), b"old").unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &["-sf", "target", "link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("link")).unwrap(), PathBuf::from("target"));
	}

	#[cfg(unix)]
	#[test]
	fn verbose_symlink_prints_mapping_to_stdout() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root, &["-sv", "target", "link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "'link' -> 'target'\n", ""));
	}

	#[cfg(unix)]
	#[test]
	fn interactive_prompt_reads_host_stdin() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("link"), b"old").unwrap();
		let (code, stdout, stderr) =
			run_with_stdin(root.clone(), &["-si", "target", "link"], "n\n");
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (1, "", "ln: replace 'link'? "));
		assert!(!root.join("link").is_symlink());
		let (code, _, stderr) =
			run_with_stdin(root.clone(), &["-si", "target", "link"], "y\n");
		assert_eq!((code, stderr.as_str()), (0, "ln: replace 'link'? "));
		assert_eq!(fs::read_link(root.join("link")).unwrap(), PathBuf::from("target"));
	}

	#[cfg(unix)]
	#[test]
	fn relative_flag_computes_link_text_against_host_cwd() {
		let (_dir, root) = canonical_tempdir();
		fs::write(root.join("target"), b"x").unwrap();
		fs::create_dir(root.join("sub")).unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &["-sr", "target", "sub/link"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("sub/link")).unwrap(), PathBuf::from("../target"));
	}

	#[cfg(unix)]
	#[test]
	fn target_directory_flag_places_links_in_directory() {
		let (_dir, root) = canonical_tempdir();
		fs::create_dir(root.join("d")).unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &["-s", "-t", "d", "x"]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "", ""));
		assert_eq!(fs::read_link(root.join("d/x")).unwrap(), PathBuf::from("x"));
	}

	#[test]
	fn missing_destination_is_an_error() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root, &["-T", "only"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert!(stderr.contains("missing destination file operand after 'only'"));
	}

	#[test]
	fn help_renders_to_host_stdout() {
		let (code, capture) = run_util::<Ln>(&["--help"], "", ".");
		assert_eq!(code, 0);
		assert!(capture.out().contains("Usage:"));
		assert!(capture.out().contains("Make links between files."));
		assert_eq!(capture.err(), "");
	}
}
