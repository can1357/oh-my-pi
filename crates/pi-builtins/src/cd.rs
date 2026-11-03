use std::{
	io::Write,
	path::{Path, PathBuf},
};

use brush_core::{ErrorKind, ExecutionContext, ExecutionResult, ShellExtensions, builtins};
use clap::Parser;

/// `cd`'s usage line, as Bash prints it.
const USAGE: &str = "cd: usage: cd [-L|[-P [-e]] [-@]] [dir]";

/// Change the current shell working directory.
#[derive(Parser)]
pub(crate) struct CdCommand {
	/// Force following symlinks.
	#[arg(short = 'L', overrides_with = "use_physical_dir")]
	force_follow_symlinks: bool,

	/// Use physical dir structure without following symlinks.
	#[arg(short = 'P', overrides_with = "force_follow_symlinks")]
	use_physical_dir: bool,

	/// Exit with non zero exit status if current working directory resolution
	/// fails.
	#[arg(short = 'e')]
	exit_on_failed_cwd_resolution: bool,

	/// By default it is the value of the HOME shell variable. If `TARGET_DIR` is
	/// "-", it is converted to $OLDPWD. A relative directory is looked for in
	/// each directory `CDPATH` lists first.
	target_dir: Option<String>,

	/// Whether a second directory was given, which Bash's `cd` refuses.
	#[arg(skip)]
	extra_operand: bool,

	/// The first option `cd` does not know, which ends it before it starts.
	#[arg(skip)]
	invalid_option: Option<char>,
}

impl builtins::Command for CdCommand {
	type Error = brush_core::Error;

	/// Parses the words as Bash's `cd` does, so that an unknown option or a
	/// second directory is `cd`'s own error, in Bash's words: options until
	/// `--` or the first word that is not one (`-` is the directory
	/// `$OLDPWD`), then the directory.
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		let mut command = Self {
			force_follow_symlinks:         false,
			use_physical_dir:              false,
			exit_on_failed_cwd_resolution: false,
			target_dir:                    None,
			extra_operand:                 false,
			invalid_option:                None,
		};
		let mut words = args.into_iter().skip(1).peekable();
		while let Some(word) = words.next_if(|word| word.len() > 1 && word.starts_with('-')) {
			if word == "--" {
				break;
			}
			// The help every builtin gives, as before.
			if word == "--help" {
				return Self::try_parse_from(["cd".to_owned(), word]);
			}
			for option in word.chars().skip(1) {
				match option {
					'L' => {
						command.force_follow_symlinks = true;
						command.use_physical_dir = false;
					},
					'P' => {
						command.use_physical_dir = true;
						command.force_follow_symlinks = false;
					},
					'e' => command.exit_on_failed_cwd_resolution = true,
					other => {
						command.invalid_option = Some(other);
						return Ok(command);
					},
				}
			}
		}
		command.target_dir = words.next();
		command.extra_operand = words.next().is_some();
		Ok(command)
	}

	async fn execute<SE: ShellExtensions>(
		&self,
		mut context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		if let Some(option) = self.invalid_option {
			writeln!(context.stderr(), "cd: -{option}: invalid option\n{USAGE}")?;
			return Ok(ExecutionResult::new(2));
		}
		if self.extra_operand {
			writeln!(context.stderr(), "cd: too many arguments")?;
			return Ok(ExecutionResult::general_error());
		}
		let physical = self.use_physical_dir
			|| context
				.shell
				.options()
				.do_not_resolve_symlinks_when_changing_dir;

		let (operand, print) = match self.target_dir.as_deref() {
			// `cd -` is `cd "$OLDPWD"`, and prints where it went.
			Some("-") => match context.shell.env_str("OLDPWD") {
				Some(oldpwd) => (oldpwd.to_string(), true),
				None => {
					writeln!(context.stderr(), "cd: OLDPWD not set")?;
					return Ok(ExecutionResult::general_error());
				},
			},
			Some(operand) => (operand.to_owned(), false),
			// `cd` alone is `cd "$HOME"`.
			None => match context.shell.env_str("HOME") {
				Some(home) => (home.to_string(), false),
				None => {
					writeln!(context.stderr(), "cd: HOME not set")?;
					return Ok(ExecutionResult::general_error());
				},
			},
		};
		// Bash 5.2 leaves the working directory as it is for an empty one.
		if operand.is_empty() {
			return Ok(ExecutionResult::success());
		}

		// A relative directory is looked for in each `CDPATH` directory first;
		// an empty entry is the working directory. Found through a non-empty
		// one, the directory's absolute name is printed, as Bash prints it.
		if let Some(cdpath) = context.shell.env_str("CDPATH").map(|cdpath| cdpath.to_string())
			&& !cdpath.is_empty()
			&& searches_cdpath(&operand)
		{
			for entry in cdpath.split(':') {
				let candidate =
					if entry.is_empty() { PathBuf::from(&operand) } else { Path::new(entry).join(&operand) };
				// Named before the change, which moves what a relative entry means.
				let shown = pi_vfs::normalize_lexically(&context.shell.absolute_path(&candidate));
				if enter_directory(&mut context, &candidate, physical).await.is_ok() {
					if !entry.is_empty() {
						writeln!(context.stdout(), "{}", shown.display())?;
					}
					return Ok(ExecutionResult::success());
				}
			}
		}

		match enter_directory(&mut context, Path::new(&operand), physical).await {
			Ok(()) => {
				if print {
					writeln!(context.stdout(), "{}", context.shell.working_dir().display())?;
				}
				Ok(ExecutionResult::success())
			},
			Err(reason) => {
				writeln!(context.stderr(), "cd: {operand}: {reason}")?;
				Ok(ExecutionResult::general_error())
			},
		}
	}
}

/// Whether Bash's `cd` looks for `operand` in `CDPATH`: a relative name that
/// does not start with `.` or `..` as its own component.
fn searches_cdpath(operand: &str) -> bool {
	let path = Path::new(operand);
	!(path.has_root()
		|| pi_vfs::is_virtual_path(path)
		|| operand == "."
		|| operand == ".."
		|| operand.starts_with("./")
		|| operand.starts_with("../"))
}

/// Makes `target` the shell's working directory as `chdir` would make it the
/// process's: `physical` resolves symbolic links first, and a directory the
/// shell may not search fails with `Permission denied`, as it does for
/// `chdir`, though the shell only records the new directory. Otherwise the
/// working directory stays as it is, and the `strerror` text of why is
/// returned, for the caller to report as `NAME: DIR: TEXT`, as Bash does.
pub(crate) async fn enter_directory<SE: ShellExtensions>(
	context: &mut ExecutionContext<'_, SE>,
	target: &Path,
	physical: bool,
) -> Result<(), String> {
	let absolute = context.shell.absolute_path(target);
	let target = if physical {
		context
			.shell
			.filesystem()
			.canonicalize(&absolute)
			.await
			.map_err(|error| crate::host::strip_errno(&error))?
	} else {
		absolute
	};
	#[cfg(unix)]
	if context.shell.filesystem().is_native_local(&target)
		&& std::fs::metadata(&target).is_ok_and(|metadata| metadata.is_dir())
	{
		nix::unistd::access(target.as_path(), nix::unistd::AccessFlags::X_OK)
			.map_err(|errno| crate::host::strip_errno(&std::io::Error::from(errno)))?;
	}
	context.shell.set_working_dir(&target).await.map_err(|error| match error.kind() {
		ErrorKind::NotADirectory(_) => "Not a directory".to_owned(),
		_ => error.as_io_error().map_or_else(|| error.to_string(), crate::host::strip_errno),
	})
}
