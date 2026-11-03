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
		// The last of `-L` and `-P` wins; without either, `set -P` decides.
		let physical = self.use_physical_dir
			|| (!self.force_follow_symlinks
				&& context
					.shell
					.options()
					.do_not_resolve_symlinks_when_changing_dir);
		// `-e` matters only with `-P`, as in Bash.
		let lost_fails = physical && self.exit_on_failed_cwd_resolution;

		// Where the directory comes from: written as the operand, or `$OLDPWD`
		// for `-` (printed once entered, as written), or `$HOME` without one.
		// Only a written operand is looked for in `CDPATH`, and only it may name
		// a variable under `cdable_vars`.
		let (operand, written, print) = match self.target_dir.as_deref() {
			Some("-") => match context.shell.env_str("OLDPWD") {
				Some(oldpwd) => (oldpwd.to_string(), false, true),
				None => {
					writeln!(context.stderr(), "cd: OLDPWD not set")?;
					return Ok(ExecutionResult::general_error());
				},
			},
			Some(operand) => (operand.to_owned(), true, false),
			None => match context.shell.env_str("HOME") {
				Some(home) => (home.to_string(), false, false),
				None => {
					writeln!(context.stderr(), "cd: HOME not set")?;
					return Ok(ExecutionResult::general_error());
				},
			},
		};
		let status = |entered: Entered, context: &mut ExecutionContext<'_, SE>| {
			let readonly = entered.readonly().to_vec();
			for name in &readonly {
				let _ = writeln!(context.stderr(), "{name}: readonly variable");
			}
			if !readonly.is_empty() || (matches!(entered, Entered::Lost(_)) && lost_fails) {
				ExecutionResult::general_error()
			} else {
				ExecutionResult::success()
			}
		};
		// A relative directory is looked for in each `CDPATH` entry first; an
		// empty entry is the working directory. Found through a non-empty one,
		// its name is printed: as the entry spells it under `-P`, else the
		// working directory it now is, as Bash prints them.
		if written
			&& let Some(cdpath) = context.shell.env_str("CDPATH").map(|cdpath| cdpath.to_string())
			&& !cdpath.is_empty()
			&& searches_cdpath(&operand)
		{
			for entry in cdpath_entries(&cdpath) {
				let candidate = if entry.is_empty() {
					operand.clone()
				} else if operand.is_empty() {
					entry.to_owned()
				} else {
					format!("{entry}/{operand}")
				};
				if let Ok(entered) = enter_named(&mut context, &candidate, physical).await {
					if !entry.is_empty() {
						if physical {
							let separator = if entry.ends_with('/') || operand.is_empty() { "" } else { "/" };
							writeln!(context.stdout(), "{entry}{separator}{operand}")?;
						} else {
							writeln!(context.stdout(), "{}", context.shell.working_dir().display())?;
						}
					}
					return Ok(status(entered, &mut context));
				}
			}
		}

		let reason = match enter_named(&mut context, &operand, physical).await {
			Ok(entered) => {
				if print {
					writeln!(context.stdout(), "{operand}")?;
				}
				return Ok(status(entered, &mut context));
			},
			Err(reason) => reason,
		};
		// Under `cdable_vars`, a written operand that names no directory may
		// name a variable whose value does; that value is printed once entered.
		// The reason reported otherwise is the last attempt's, as in Bash.
		let reason = if written && context.shell.options().cdable_vars {
			match context.shell.env_str(&operand).map(|value| value.to_string()) {
				Some(value) => match enter_named(&mut context, &value, physical).await {
					Ok(entered) => {
						writeln!(context.stdout(), "{value}")?;
						return Ok(status(entered, &mut context));
					},
					Err(reason) => reason,
				},
				None => reason,
			}
		} else {
			reason
		};
		writeln!(context.stderr(), "cd: {operand}: {reason}")?;
		Ok(ExecutionResult::general_error())
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

/// `CDPATH`'s entries, split at `:` as Bash splits them, except the colon of
/// an entry spelled as a provider URL (`scheme://…`), which is part of it:
/// no entry of Bash's can be one.
fn cdpath_entries(cdpath: &str) -> impl Iterator<Item = &str> {
	let mut rest = Some(cdpath);
	std::iter::from_fn(move || {
		let text = rest?;
		let root = if pi_vfs::is_virtual_path(Path::new(text)) {
			text.find("://").map_or(0, |colon| colon + 3)
		} else {
			0
		};
		match text[root..].find(':') {
			Some(colon) => {
				rest = Some(&text[root + colon + 1..]);
				Some(&text[..root + colon])
			},
			None => {
				rest = None;
				Some(text)
			},
		}
	})
}

/// How a directory change ended.
pub(crate) enum Entered {
	/// The directory is the shell's working directory now, with the names
	/// that could not be written for it (a readonly `PWD` or `OLDPWD`).
	Changed(Vec<&'static str>),
	/// The working directory had been removed, and the directory named it
	/// (`.`): it stays, under the name spelled after it, and that name cannot
	/// be resolved, which `cd -P -e` reports as a failure, with the names
	/// that could not be written for it.
	Lost(Vec<&'static str>),
}

impl Entered {
	/// The names that could not be written for the directory entered: a
	/// readonly `PWD` or `OLDPWD`, which Bash reports and goes on from.
	pub(crate) fn readonly(&self) -> &[&'static str] {
		match self {
			Self::Changed(readonly) | Self::Lost(readonly) => readonly,
		}
	}
}

/// Makes `target` the shell's working directory as `chdir` would make it the
/// process's: `physical` resolves symbolic links first, and a directory the
/// shell may not search fails with `Permission denied`, as it does for
/// `chdir`, though the shell only records the new directory. Otherwise the
/// working directory stays as it is, and the `strerror` text of why is
/// returned, for the caller to report as `NAME: DIR: TEXT`, as Bash does.
///
/// A working directory that has been removed is still reached by a name made
/// of `.` components, as `chdir(".")` reaches it: as in Bash, `PWD` becomes
/// that name spelled after it, `OLDPWD` the old `PWD`, and `getcwd`'s failure
/// is reported. A renamed one is not: Bash's process holds that directory and
/// `getcwd` names it again, where this shell holds only the name.
pub(crate) async fn enter_directory<SE: ShellExtensions>(
	context: &mut ExecutionContext<'_, SE>,
	target: &Path,
	physical: bool,
) -> Result<Entered, String> {
	enter_named(context, &target.to_string_lossy(), physical).await
}

/// [`enter_directory`] for a directory named as it was written, which an
/// empty name and a removed working directory are read against.
async fn enter_named<SE: ShellExtensions>(
	context: &mut ExecutionContext<'_, SE>,
	target: &str,
	physical: bool,
) -> Result<Entered, String> {
	// An empty name is the working directory as it is spelled: the shell
	// enters it again, so `OLDPWD` becomes it, and a working directory that
	// has been removed fails. Bash's physical mode resolves the empty name
	// itself, which always fails.
	let spelled = if target.is_empty() && !physical {
		context.shell.working_dir().to_path_buf()
	} else {
		PathBuf::from(target)
	};
	let reason = match change_directory(context, &spelled, physical).await {
		Ok(readonly) => return Ok(Entered::Changed(readonly)),
		Err(reason) => reason,
	};
	// The shell holds the directory it works in, as a process holds it, so a
	// name is still read from there once no name reaches that directory,
	// because it has been removed, renamed or moved. The kernel reads the
	// name from the directory itself, which is what Bash's `chdir` does,
	// and says where it arrives.
	let current = context.shell.working_dir().to_path_buf();
	if spelled.is_absolute()
		|| spelled.as_os_str().is_empty()
		|| !context.shell.filesystem().is_native_local(&current)
		|| context.shell.filesystem().metadata(&current).await.is_ok()
	{
		return Err(reason);
	}
	let Some(handle) = context.shell.working_dir_handle() else { return Err(reason) };
	let arrived = match handle.open_at(&spelled) {
		Ok(arrived) => arrived,
		// The name reaches nothing from there either. Bash reports what the
		// kernel says when it reads the name itself, under `-P`, and what
		// its own reading of the name says otherwise, which is that the
		// working directory is not there.
		Err(error) if physical => return Err(crate::host::strip_errno(&error)),
		Err(_) => return Err(reason),
	};
	match arrived.path() {
		// The directory it reaches has a name of its own: the shell works
		// there, under that name, as `getcwd` answers for it.
		Some(name) => {
			let readonly =
				context.shell.enter(name, Some(arrived)).map_err(|error| error.to_string())?;
			Ok(Entered::Changed(readonly))
		},
		// It has been removed too: the shell works there under the name
		// spelled after the one it holds, and `getcwd` then fails, as Bash
		// reports. Every name read against it fails, as they do in Bash.
		None => {
			let lost = current.join(&spelled);
			let readonly = context
				.shell
				.set_unreachable_working_dir(lost, Some(arrived))
				.map_err(|error| error.to_string())?;
			let _ = writeln!(
				context.stderr(),
				"cd: error retrieving current directory: getcwd: cannot access parent \
				 directories: No such file or directory"
			);
			Ok(Entered::Lost(readonly))
		},
	}
}

/// [`enter_directory`] for a directory that exists.
async fn change_directory<SE: ShellExtensions>(
	context: &mut ExecutionContext<'_, SE>,
	target: &Path,
	physical: bool,
) -> Result<Vec<&'static str>, String> {
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

#[cfg(test)]
mod tests {
	use super::cdpath_entries;

	/// `CDPATH` splits at every `:` but a provider URL's, and keeps empty
	/// entries, which name the working directory.
	#[test]
	fn cdpath_keeps_a_provider_url_whole() {
		let entries = |cdpath| cdpath_entries(cdpath).collect::<Vec<_>>();
		assert_eq!(entries("a:b"), ["a", "b"]);
		assert_eq!(entries(":a::b:"), ["", "a", "", "b", ""]);
		assert_eq!(entries("probe://w/d"), ["probe://w/d"]);
		assert_eq!(entries("probe://w/d:/tmp"), ["probe://w/d", "/tmp"]);
		assert_eq!(entries("/tmp:probe://w/d:x"), ["/tmp", "probe://w/d", "x"]);
		// A one-letter "scheme" is a drive or a directory, as `pi_vfs` reads it.
		assert_eq!(entries("d://x"), ["d", "//x"]);
		assert_eq!(entries("a:b://c"), ["a", "b", "//c"]);
	}
}
