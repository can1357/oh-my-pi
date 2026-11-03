use std::{
	io::Write,
	path::{Component, Path, PathBuf},
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
		let status = |entered: Entered| {
			if matches!(entered, Entered::Lost) && lost_fails {
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
					return Ok(status(entered));
				}
			}
		}

		let reason = match enter_named(&mut context, &operand, physical).await {
			Ok(entered) => {
				if print {
					writeln!(context.stdout(), "{operand}")?;
				}
				return Ok(status(entered));
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
						return Ok(status(entered));
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
#[derive(Clone, Copy)]
pub(crate) enum Entered {
	/// The directory is the shell's working directory now.
	Changed,
	/// The working directory had been removed, and the directory named it
	/// (`.`): it stays, under the name spelled after it, and that name cannot
	/// be resolved, which `cd -P -e` reports as a failure.
	Lost,
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
		Ok(()) => return Ok(Entered::Changed),
		Err(reason) => reason,
	};
	// A name that starts with `.` and `..` is the one case the kernel still
	// answers from a working directory that has been removed, because it
	// holds that directory: `chdir(".")` stays there, and `chdir("..")`
	// reaches the directory above, removed or not, and reads the rest of the
	// name from there. A name that starts with a component of its own is not
	// reached, as Bash reports. Nothing else here invents a directory.
	let current = context.shell.working_dir().to_path_buf();
	if !(context.shell.filesystem().is_native_local(&current)
		&& !spelled.is_absolute()
		&& !spelled.as_os_str().is_empty()
		&& std::fs::metadata(&current).is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound))
	{
		return Err(reason);
	}
	let mut above = 0usize;
	let mut rest = PathBuf::new();
	for component in spelled.components() {
		match component {
			Component::CurDir if rest.as_os_str().is_empty() => {},
			Component::ParentDir if rest.as_os_str().is_empty() => above += 1,
			other => rest.push(other),
		}
	}
	// A name of its own is read from the directory the kernel holds only
	// after a `..` has led out of it, which is the only directory any name
	// still reaches.
	if above == 0 && !rest.as_os_str().is_empty() {
		return Err(reason);
	}
	if above > 0 {
		// Where the kernel arrives: the working directory as it really is,
		// which the names above it still spell, less one for each `..`. The
		// name the shell holds may lead through a symbolic link, which the
		// kernel does not follow back, so the part of it that is still there
		// is resolved first, in both modes, as Bash resolves it.
		let mut arrived = resolved_working_dir(context, &current).await;
		for _ in 0..above {
			arrived.pop();
		}
		let target = arrived.join(&rest);
		if change_directory(context, &target, physical).await.is_ok() {
			return Ok(Entered::Changed);
		}
		if !rest.as_os_str().is_empty() {
			return Err(reason);
		}
	}
	// The directory the name reaches is gone too: the shell enters it under
	// the name spelled after the one it holds, as `chdir` enters it, and
	// `getcwd` then fails, as Bash reports. The shell records that name as
	// its working directory, so that `pwd` and `$PWD` agree and every name
	// read against it fails, as they do in Bash.
	let lost = current.join(&spelled);
	context.shell.set_unreachable_working_dir(lost).map_err(|error| error.to_string())?;
	let _ = writeln!(
		context.stderr(),
		"cd: error retrieving current directory: getcwd: cannot access parent directories: No such \
		 file or directory"
	);
	Ok(Entered::Lost)
}

/// The working directory as the names that are still there spell it: the
/// longest part of `current` that exists, resolved, with the rest of the name
/// after it. This is where `chdir("..")` leads from, which no name reaches
/// once the directory is removed.
async fn resolved_working_dir<SE: ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	current: &Path,
) -> PathBuf {
	let mut names = Vec::new();
	let mut above = current.to_path_buf();
	loop {
		if let Ok(resolved) = context.shell.filesystem().canonicalize(&above).await {
			let mut arrived = resolved;
			arrived.extend(names.iter().rev());
			return arrived;
		}
		let Some(name) = above.file_name().map(std::ffi::OsString::from) else {
			return current.to_path_buf();
		};
		names.push(name);
		if !above.pop() {
			return current.to_path_buf();
		}
	}
}

/// [`enter_directory`] for a directory that exists.
async fn change_directory<SE: ShellExtensions>(
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
