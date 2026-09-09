//! `mktemp` builtin: create and display a temporary file or directory from a
//! template.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(unix)]
use std::fs;
#[cfg(unix)]
use std::os::unix::prelude::PermissionsExt;
use std::{
	env,
	ffi::{OsStr, OsString},
	io::{self, ErrorKind, Write},
	iter,
	path::{MAIN_SEPARATOR, Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{TypedValueParser, ValueParserFactory},
};
use rand::{
	RngExt as _, SeedableRng as _,
	rngs::{self, SmallRng},
};
use tempfile::Builder;
use thiserror::Error;
use uucore::display::Quotable;

use crate::host::{Host, Utility, format_usage, matches_parser, os_bytes, util};

static DEFAULT_TEMPLATE: &str = "tmp.XXXXXXXXXX";

static OPT_DIRECTORY: &str = "directory";
static OPT_DRY_RUN: &str = "dry-run";
static OPT_QUIET: &str = "quiet";
static OPT_SUFFIX: &str = "suffix";
static OPT_TMPDIR: &str = "tmpdir";
static OPT_P: &str = "p";
static OPT_T: &str = "t";

static ARG_TEMPLATE: &str = "template";

#[cfg(not(windows))]
const TMPDIR_ENV_VAR: &str = "TMPDIR";
#[cfg(windows)]
const TMPDIR_ENV_VAR: &str = "TMP";

const FALLBACK_TMPDIR: &str = "/tmp";

#[derive(Error, Debug)]
enum MkTempError {
	#[error("could not persist file {}", .0.quote())]
	Persist(PathBuf),

	#[error("with --suffix, template {} must end in X", .0.quote())]
	MustEndInX(String),

	#[error("too few X's in template {}", .0.quote())]
	TooFewXs(String),

	#[error("invalid template, {}, contains directory separator", .0.quote())]
	PrefixContainsDirSeparator(String),

	#[error("invalid suffix {}, contains directory separator", .0.quote())]
	SuffixContainsDirSeparator(String),

	#[error("invalid template, {}; with --tmpdir, it may not be absolute", .0.quote())]
	InvalidTemplate(OsString),

	#[error("too many templates")]
	TooManyTemplates,

	#[error("failed to create {} via template {}: No such file or directory", .0, .1.quote())]
	NotFound(String, PathBuf),

	#[error(transparent)]
	Io(#[from] io::Error),
}

/// Options parsed from the command line.
///
/// This provides a layer of indirection between the application logic and
/// `clap`, allowing each to vary independently.
#[derive(Clone)]
struct Options {
	/// Whether to create a temporary directory instead of a file.
	directory: bool,
	/// Whether to just print the name of a file that would have been created.
	dry_run: bool,
	/// Whether to suppress file creation error messages.
	quiet: bool,
	/// The directory in which to create the temporary file.
	tmpdir: Option<PathBuf>,
	/// The suffix to append to the temporary file, if any.
	suffix: Option<OsString>,
	/// Whether to treat the template argument as a single file path component.
	treat_as_template: bool,
	/// The template to use for the name of the temporary file.
	template: OsString,
}

impl Options {
	fn from(matches: &ArgMatches, host: &Host) -> Self {
		let tmpdir = matches
			.get_one::<Option<PathBuf>>(OPT_TMPDIR)
			.or_else(|| matches.get_one::<Option<PathBuf>>(OPT_P))
			.map(|dir| match dir {
				// If the argument of -p/--tmpdir is non-empty, use it as the tmpdir.
				Some(dir) => dir.clone(),
				// Otherwise use $TMPDIR if set, else the system default.
				None => get_tmpdir_env_or_default(host),
			});
		let (tmpdir, template) = match matches.get_one::<OsString>(ARG_TEMPLATE) {
			// If no template argument is given, `--tmpdir` is implied.
			None => (
				Some(tmpdir.unwrap_or_else(|| get_tmpdir_env_or_default(host))),
				OsString::from(DEFAULT_TEMPLATE),
			),
			Some(template) => {
				let tmpdir = if let Some(tmpdir) = host.var(TMPDIR_ENV_VAR)
					&& matches.get_flag(OPT_T)
				{
					Some(PathBuf::from(tmpdir))
				} else if tmpdir.is_some() {
					tmpdir
				} else if matches.get_flag(OPT_T) || matches.contains_id(OPT_TMPDIR) {
					Some(get_tmpdir_env_or_default(host))
				} else {
					None
				};
				(tmpdir, template.clone())
			},
		};
		Self {
			directory: matches.get_flag(OPT_DIRECTORY),
			dry_run: matches.get_flag(OPT_DRY_RUN),
			quiet: matches.get_flag(OPT_QUIET),
			tmpdir,
			suffix: matches.get_one::<OsString>(OPT_SUFFIX).cloned(),
			treat_as_template: matches.get_flag(OPT_T),
			template,
		}
	}
}

/// Parameters controlling the path and name of the temporary entry.
struct Params {
	/// The directory that will contain the temporary entry.
	directory: PathBuf,
	/// The non-random prefix of the temporary entry.
	prefix: String,
	/// The number of random characters in the name.
	num_rand_chars: usize,
	/// The non-random suffix of the temporary entry.
	suffix: String,
}

/// Finds the last contiguous block of at least three `X` characters.
fn find_last_contiguous_block_of_xs(s: &str) -> Option<(usize, usize)> {
	let bytes = s.as_bytes();
	let end = bytes.iter().rposition(|&b| b == b'X')?;
	let mut start = end;
	while start > 0 && bytes[start - 1] == b'X' {
		start -= 1;
	}
	(end + 1 - start >= 3).then_some((start, end + 1))
}

impl Params {
	fn from(options: Options) -> Result<Self, MkTempError> {
		// `-t` follows GNU's permissive treatment of invalid UTF-8. Regular
		// templates retain the upstream strict validation.
		let mut template_str = if options.treat_as_template {
			options.template.to_string_lossy().into_owned()
		} else {
			options
				.template
				.to_str()
				.ok_or_else(|| {
					MkTempError::InvalidTemplate("template contains invalid UTF-8".into())
				})?
				.to_string()
		};

		if options.suffix.is_some() && !template_str.ends_with('X') {
			return Err(MkTempError::MustEndInX(template_str));
		}

		let (i, j) = match find_last_contiguous_block_of_xs(&template_str) {
			Some(indices) => indices,
			// BSD `mktemp -t PREFIX` treats PREFIX as a name prefix.
			None if options.treat_as_template => {
				template_str.push('.');
				template_str.push_str("XXXXXXXXXX");
				let j = template_str.len();
				(j - 10, j)
			},
			None => return Err(MkTempError::TooFewXs(template_str)),
		};

		// Combine the option directory and the template prefix, then split the
		// parent directory from the final file-name component.
		let tmpdir = options.tmpdir;
		let prefix_from_option = tmpdir.clone().unwrap_or_default();
		let prefix_from_template = &template_str[..i];
		let prefix_path = Path::new(&prefix_from_option).join(prefix_from_template);
		if options.treat_as_template && prefix_from_template.contains(MAIN_SEPARATOR) {
			return Err(MkTempError::PrefixContainsDirSeparator(template_str));
		}
		if tmpdir.is_some() && Path::new(prefix_from_template).is_absolute() {
			return Err(MkTempError::InvalidTemplate(template_str.into()));
		}
		let (directory, prefix) = {
			let prefix_str = prefix_path.to_string_lossy();
			if prefix_str.ends_with(MAIN_SEPARATOR) {
				(prefix_path, String::new())
			} else {
				let directory = prefix_path.parent().map_or_else(PathBuf::new, Path::to_path_buf);
				let prefix = prefix_path
					.file_name()
					.map_or_else(String::new, |f| f.to_string_lossy().into_owned());
				(directory, prefix)
			}
		};

		// Combine a suffix embedded in the template with `--suffix`.
		let suffix_from_option = options
			.suffix
			.map(|s| s.to_string_lossy().into_owned())
			.unwrap_or_default();
		let suffix_from_template = &template_str[j..];
		let suffix = format!("{suffix_from_template}{suffix_from_option}");
		if suffix.contains(MAIN_SEPARATOR) {
			return Err(MkTempError::SuffixContainsDirSeparator(suffix));
		}

		Ok(Self { directory, prefix, num_rand_chars: j - i, suffix })
	}
}

/// Parses an empty directory option as `None` and a non-empty one as a path.
#[derive(Clone, Debug)]
struct OptionalPathBufParser;

impl TypedValueParser for OptionalPathBufParser {
	type Value = Option<PathBuf>;

	fn parse_ref(
		&self,
		_cmd: &Command,
		_arg: Option<&Arg>,
		value: &OsStr,
	) -> Result<Self::Value, clap::Error> {
		if value.is_empty() {
			Ok(None)
		} else {
			Ok(Some(PathBuf::from(value)))
		}
	}
}

impl ValueParserFactory for OptionalPathBufParser {
	type Parser = Self;

	fn value_parser() -> Self::Parser {
		Self
	}
}

/// Parsed `mktemp` invocation.
pub(crate) struct Mktemp {
	matches: ArgMatches,
}

matches_parser!(Mktemp, app);

impl Utility for Mktemp {
	const NAME: &'static str = "mktemp";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		// Upstream replaces clap's generic positional overflow diagnostic with
		// GNU mktemp's concise message.
		if let Err(err) = app().try_get_matches_from(&argv)
			&& err.kind() == clap::error::ErrorKind::TooManyValues
			&& err.context().any(|(kind, value)| {
				kind == clap::error::ContextKind::InvalidArg
					&& value == &clap::error::ContextValue::String("[template]".into())
			})
		{
			return Err(MkTempError::TooManyTemplates.to_string());
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let options = Options::from(&self.matches, host);

		// Under POSIXLY_CORRECT the template must be the last argument. Clap's
		// occurrence indices preserve that ordering after short-option expansion.
		if host.var("POSIXLY_CORRECT").is_some()
			&& self.matches.contains_id(ARG_TEMPLATE)
			&& !template_is_last(&self.matches)
		{
			host.error(MkTempError::TooManyTemplates, 1);
			return 1;
		}

		let dry_run = options.dry_run;
		let quiet = options.quiet;
		let make_dir = options.directory;
		let Params { directory, prefix, num_rand_chars, suffix } = match Params::from(options) {
			Ok(params) => params,
			Err(err) => {
				host.error(err, 1);
				return 1;
			},
		};

		let result = if dry_run {
			Ok(dry_exec(&directory, &prefix, num_rand_chars, &suffix))
		} else {
			exec(host, &directory, &prefix, num_rand_chars, &suffix, make_dir)
		};
		let path = match result {
			Ok(path) => path,
			Err(_) if quiet => return 1,
			Err(err) => {
				host.error(err, 1);
				return 1;
			},
		};

		let Some(bytes) = os_bytes(path.as_os_str()) else {
			host.error("failed to print directory name: path contains invalid text", 1);
			return 1;
		};
		if host.stdout.write_all(bytes).is_err()
			|| host.stdout.write_all(b"\n").is_err()
			|| host.stdout.flush().is_err()
		{
			return 1;
		}
		0
	}
}

/// Returns whether the template occurred after every option and option value.
fn template_is_last(matches: &ArgMatches) -> bool {
	let Some(template_index) = matches.index_of(ARG_TEMPLATE) else {
		return true;
	};
	[
		OPT_DIRECTORY,
		OPT_DRY_RUN,
		OPT_QUIET,
		OPT_SUFFIX,
		OPT_TMPDIR,
		OPT_P,
		OPT_T,
	]
	.into_iter()
	.filter_map(|id| matches.index_of(id))
	.all(|index| index < template_index)
}

/// Builds the `mktemp` command-line model.
fn app() -> Command {
	Command::new(Mktemp::NAME)
		.version("0.8.0")
		.about("Create a temporary file or directory.")
		.override_usage(format_usage("mktemp [OPTION]... [TEMPLATE]"))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_DIRECTORY)
				.short('d')
				.long(OPT_DIRECTORY)
				.help("Make a directory instead of a file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_DRY_RUN)
				.short('u')
				.long(OPT_DRY_RUN)
				.help("do not create anything; merely print a name (unsafe)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_QUIET)
				.short('q')
				.long(OPT_QUIET)
				.help("Fail silently if an error occurs.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_SUFFIX)
				.long(OPT_SUFFIX)
				.help(
					"append SUFFIX to TEMPLATE; SUFFIX must not contain a path separator. This option \
					 is implied if TEMPLATE does not end with X.",
				)
				.value_name("SUFFIX")
				.value_parser(clap::value_parser!(OsString)),
		)
		.arg(
			Arg::new(OPT_P)
				.short('p')
				.help("short form of --tmpdir")
				.value_name("DIR")
				.num_args(1)
				.value_parser(OptionalPathBufParser)
				.value_hint(clap::ValueHint::DirPath),
		)
		.arg(
			Arg::new(OPT_TMPDIR)
				.long(OPT_TMPDIR)
				.help(
					"interpret TEMPLATE relative to DIR; if DIR is not specified, use $TMPDIR ($TMP on \
					 windows) if set, else /tmp. With this option, TEMPLATE must not be an absolute \
					 name; unlike with -t, TEMPLATE may contain slashes, but mktemp creates only the \
					 final component",
				)
				.value_name("DIR")
				.num_args(0..=1)
				.require_equals(true)
				.overrides_with(OPT_P)
				.value_parser(OptionalPathBufParser)
				.value_hint(clap::ValueHint::DirPath),
		)
		.arg(
			Arg::new(OPT_T)
				.short('t')
				.help(
					"Generate a template (using the supplied prefix and TMPDIR (TMP on windows) if \
					 set) to create a filename template [deprecated]",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_TEMPLATE)
				.num_args(..=1)
				.value_parser(clap::value_parser!(OsString)),
		)
}

fn dry_exec(tmpdir: &Path, prefix: &str, rand: usize, suffix: &str) -> PathBuf {
	let len = prefix.len() + suffix.len() + rand;
	let mut buf = Vec::with_capacity(len);
	buf.extend(prefix.as_bytes());
	buf.extend(iter::repeat_n(b'X', rand));
	buf.extend(suffix.as_bytes());

	let bytes = &mut buf[prefix.len()..prefix.len() + rand];
	SmallRng::try_from_rng(&mut rngs::SysRng)
		.unwrap_or_else(|_| SmallRng::seed_from_u64(bytes.as_ptr() as usize as u64))
		.fill(bytes);
	for byte in bytes {
		*byte = match *byte % 62 {
			v @ 0..=9 => v + b'0',
			v @ 10..=35 => v - 10 + b'a',
			v @ 36..=61 => v - 36 + b'A',
			_ => unreachable!(),
		};
	}
	// Every byte was mapped into the ASCII alphanumeric range.
	let buf = String::from_utf8(buf).unwrap();
	tmpdir.join(buf)
}

/// Creates a temporary directory with owner-only permissions.
fn make_temp_dir(
	dir: &Path,
	display_dir: &Path,
	prefix: &str,
	rand: usize,
	suffix: &str,
) -> Result<PathBuf, MkTempError> {
	let mut builder = Builder::new();
	builder.prefix(prefix).rand_bytes(rand).suffix(suffix);
	#[cfg(not(windows))]
	builder.permissions(fs::Permissions::from_mode(0o700));

	match builder.tempdir_in(dir) {
		Ok(directory) => Ok(directory.keep()),
		Err(err) if err.kind() == ErrorKind::NotFound => {
			let filename = format!("{prefix}{}{suffix}", "X".repeat(rand));
			Err(MkTempError::NotFound(
				"directory".to_string(),
				display_dir.join(filename),
			))
		},
		Err(err) => Err(err.into()),
	}
}

/// Creates a temporary file with owner-only permissions.
fn make_temp_file(
	dir: &Path,
	display_dir: &Path,
	prefix: &str,
	rand: usize,
	suffix: &str,
) -> Result<PathBuf, MkTempError> {
	let mut builder = Builder::new();
	builder.prefix(prefix).rand_bytes(rand).suffix(suffix);
	match builder.tempfile_in(dir) {
		Ok(file) => file.keep().map(|(_, path)| path).map_err(|err| {
			let path = err.file.path();
			let display_path = path
				.file_name()
				.map_or_else(|| display_dir.to_path_buf(), |name| display_dir.join(name));
			MkTempError::Persist(display_path)
		}),
		Err(err) if err.kind() == ErrorKind::NotFound => {
			let filename = format!("{prefix}{}{suffix}", "X".repeat(rand));
			Err(MkTempError::NotFound("file".to_string(), display_dir.join(filename)))
		},
		Err(err) => Err(err.into()),
	}
}

fn exec(
	host: &Host,
	dir: &Path,
	prefix: &str,
	rand: usize,
	suffix: &str,
	make_dir: bool,
) -> Result<PathBuf, MkTempError> {
	// Only the filesystem-facing form is resolved. The returned path retains
	// the spelling implied by the user's operands, which scripts consume.
	let resolved_dir = host.resolve(dir);
	let created = if make_dir {
		make_temp_dir(&resolved_dir, dir, prefix, rand, suffix)?
	} else {
		make_temp_file(&resolved_dir, dir, prefix, rand, suffix)?
	};
	let filename = created.file_name().expect("tempfile path has a file name");
	Ok(dir.join(filename))
}

/// Reads the shell's temporary-directory variable, falling back to the platform
/// default. An explicitly empty variable uses `/tmp`, matching GNU mktemp.
fn get_tmpdir_env_or_default(host: &Host) -> PathBuf {
	match host.var(TMPDIR_ENV_VAR) {
		Some(value) if value.is_empty() => PathBuf::from(FALLBACK_TMPDIR),
		Some(value) => PathBuf::from(value),
		None => env::temp_dir(),
	}
}

/// Creates the `mktemp` builtin registration.
pub(crate) fn mktemp_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Mktemp, SE>()
}

#[cfg(test)]
mod tests {
	use std::{
		env,
		ffi::OsString,
		io::Write,
		path::{Path, PathBuf},
	};

	use clap::Parser;

	use super::Mktemp;
	use crate::host::{Host, Utility};

	fn canonical_tempdir() -> (tempfile::TempDir, PathBuf) {
		let dir = tempfile::tempdir().unwrap();
		let canonical = std::fs::canonicalize(dir.path()).unwrap();
		(dir, canonical)
	}

	fn run_in(cwd: PathBuf, env: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
		let (mut host, capture) = Host::for_test(Mktemp::NAME, "", cwd);
		for (key, value) in env {
			host.set_test_var(key, value);
		}
		let argv: Vec<OsString> = std::iter::once(OsString::from(Mktemp::NAME))
			.chain(args.iter().map(OsString::from))
			.collect();
		let argv = match Mktemp::rewrite_argv(argv) {
			Ok(argv) => argv,
			Err(message) => {
				host.error(message, i32::from(Mktemp::USAGE_ERROR));
				return (i32::from(Mktemp::USAGE_ERROR), capture.out(), capture.err());
			},
		};
		let code = match Mktemp::try_parse_from(argv) {
			Ok(parsed) => parsed.run(&mut host),
			Err(err) => {
				let rendered = err.to_string();
				if err.use_stderr() {
					let _ = host.stderr.write_all(rendered.as_bytes());
					i32::from(Mktemp::USAGE_ERROR)
				} else {
					let _ = host.stdout.write_all(rendered.as_bytes());
					0
				}
			},
		};
		(code, capture.out(), capture.err())
	}

	fn tmpdir_env(dir: &Path) -> [(&str, &str); 1] {
		[("TMPDIR", dir.to_str().unwrap())]
	}

	#[test]
	fn default_invocation_creates_file_at_printed_path() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root.clone(), &tmpdir_env(&root), &[]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert!(printed.is_file());
		assert_eq!(printed.parent(), Some(root.as_path()));
		assert!(printed.file_name().unwrap().to_str().unwrap().starts_with("tmp."));
	}

	#[test]
	fn directory_flag_creates_directory() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root.clone(), &tmpdir_env(&root), &["-d"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert!(printed.is_dir());
		assert_eq!(printed.parent(), Some(root.as_path()));
	}

	#[test]
	fn relative_tmpdir_resolves_against_host_cwd_but_prints_relative() {
		let (_dir, root) = canonical_tempdir();
		std::fs::create_dir(root.join("sub")).unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &[], &["-p", "sub", "foo.XXXX"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert_eq!(printed.parent(), Some(Path::new("sub")));
		assert!(root.join(&printed).is_file());
	}

	#[test]
	fn relative_template_directory_resolves_against_host_cwd() {
		let (_dir, root) = canonical_tempdir();
		std::fs::create_dir(root.join("nested")).unwrap();
		let (code, stdout, stderr) = run_in(root.clone(), &[], &["nested/foo.XXXX"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert_eq!(printed.parent(), Some(Path::new("nested")));
		assert!(root.join(printed).is_file());
	}

	#[test]
	fn host_tmpdir_wins_over_process_environment() {
		let (_dir, root) = canonical_tempdir();
		assert_ne!(env::temp_dir(), root);
		let (code, stdout, stderr) = run_in(root.clone(), &tmpdir_env(&root), &[]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert_eq!(printed.parent(), Some(root.as_path()));
		assert!(printed.is_file());
	}

	#[test]
	fn too_few_xs_is_an_error() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root, &[], &["foo.XX"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "mktemp: too few X's in template 'foo.XX'\n");
	}

	#[test]
	fn bsd_t_prefix_creates_file_in_tmpdir() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root.clone(), &tmpdir_env(&root), &["-t", "omp"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert!(printed.is_file());
		assert_eq!(printed.parent(), Some(root.as_path()));
		let name = printed.file_name().unwrap().to_str().unwrap();
		assert!(name.starts_with("omp."));
		assert_eq!(name.len(), "omp.".len() + 10);
	}

	#[test]
	fn bsd_t_prefix_creates_directory_with_d_flag() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) =
			run_in(root.clone(), &tmpdir_env(&root), &["-d", "-t", "pfx"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert!(printed.is_dir());
		assert_eq!(printed.parent(), Some(root.as_path()));
	}

	#[test]
	fn gnu_t_template_keeps_template_behavior() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) =
			run_in(root.clone(), &tmpdir_env(&root), &["-t", "fooXXXX"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert!(printed.is_file());
		assert_eq!(printed.parent(), Some(root.as_path()));
		let name = printed.file_name().unwrap().to_str().unwrap();
		assert!(name.starts_with("foo"));
		assert_eq!(name.len(), "foo".len() + 4);
	}

	#[test]
	fn template_without_xs_without_t_remains_an_error() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root, &[], &["prefix"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "mktemp: too few X's in template 'prefix'\n");
	}

	#[test]
	fn dry_run_prints_nonexistent_path() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root.clone(), &tmpdir_env(&root), &["-u"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert_eq!(printed.parent(), Some(root.as_path()));
		assert!(!printed.exists());
	}

	#[test]
	fn suffix_is_appended_after_random_block() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) =
			run_in(root.clone(), &[], &["--suffix=.txt", "-p", ".", "fooXXXX"]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		let printed = PathBuf::from(stdout.trim_end_matches('\n'));
		assert!(root.join(&printed).is_file());
		let name = printed.file_name().unwrap().to_str().unwrap();
		assert!(name.starts_with("foo") && name.ends_with(".txt"));
	}

	#[test]
	fn quiet_suppresses_creation_error_message_but_not_exit_code() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) =
			run_in(root, &[], &["-q", "-p", "missing-dir", "foo.XXXX"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "");
	}

	#[test]
	fn creation_error_keeps_relative_template_in_diagnostic() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) =
			run_in(root, &[], &["-p", "missing-dir", "foo.XXXX"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(
			stderr,
			"mktemp: failed to create file via template 'missing-dir/foo.XXXX': No such file or directory\n"
		);
	}

	#[test]
	fn too_many_templates_uses_gnu_diagnostic() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) = run_in(root, &[], &["one.XXXX", "two.XXXX"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "mktemp: too many templates\n");
	}

	#[test]
	fn posixly_correct_requires_template_last() {
		let (_dir, root) = canonical_tempdir();
		let (code, stdout, stderr) =
			run_in(root, &[("POSIXLY_CORRECT", "1")], &["foo.XXXX", "-d"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "mktemp: too many templates\n");
	}

	#[test]
	fn help_renders_to_host_stdout() {
		let (code, stdout, stderr) = run_in(PathBuf::from("."), &[], &["--help"]);
		assert_eq!(code, 0);
		assert!(stdout.contains("Usage:"));
		assert!(stdout.contains("temporary file or directory"));
		assert_eq!(stderr, "");
	}
}
