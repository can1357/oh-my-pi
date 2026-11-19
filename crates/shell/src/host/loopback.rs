//! Which `sh`, `bash` and `zsh` command lines the engine runs itself.
//!
//! [`PiHost::resolve`](super::PiHost) answers the bare names with
//! [`Resolved::SelfShell`](crate::bash::Resolved::SelfShell): the child shell
//! is a virtual process of the caller's shell (`crate::bash::vm::nested`)
//! with a new shell's state, so pi's utilities and the `scheme://` paths of
//! its filesystem work in `bash -c …`, `sh script.sh` and `… | bash` as they
//! do at the top level. A name with a slash (`/bin/bash`) is never asked.
//!
//! The program on `PATH` still runs where the engine does not stand in for
//! it ([`needs_program`], through
//! [`Host::defers_to_path`](crate::bash::Host::defers_to_path)); with no such
//! program there, the engine's shell runs after all. The engine itself keeps
//! `exec bash` (the shell is replaced) and a shell in a detached tree
//! (`nohup bash …` outlives the session) on `PATH`.

use bstr::BString;

use crate::bash::{invocation::ShellArgs, store::OptId, zshopt::ZshOpt};

/// Whether the shell command line `argv` (`argv[0]` is `sh`, `bash` or
/// `zsh`) is for the program on `PATH` rather than the engine's own shell:
///
/// - an interactive shell (`-i`, or one reading its commands from a terminal:
///   `terminal` says the run's stdin and stderr are one): its user's startup
///   files, prompt, line editor and history are the program's;
/// - `--pretty-print` and `-v` (`-o verbose`), which a nested shell does not
///   do: it would run the script without printing it;
/// - a command line the engine's parser rejects or refuses (restricted mode,
///   `-D`, `--dump-strings`, an option of another shell version): the program
///   runs it or reports it in its own words.
pub(super) fn needs_program(argv: &[BString], terminal: bool) -> bool {
	ShellArgs::parse(argv)
		.map_or(true, |args| args.pretty_print || args.is_interactive(terminal) || verbose(&args))
}

/// Whether `args` leave the shell printing its input as it reads it: the
/// last `-v`/`+v` (`-o verbose`, zsh's `VERBOSE`) turned it on.
fn verbose(args: &ShellArgs) -> bool {
	let bash = args
		.options
		.iter()
		.rev()
		.find(|(opt, _)| *opt == OptId::Verbose);
	let zsh = args
		.zsh_options
		.iter()
		.rev()
		.find(|(opt, _)| *opt == ZshOpt::Verbose);
	bash.is_some_and(|&(_, on)| on) || zsh.is_some_and(|&(_, on)| on)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn needs(argv: &[&str], terminal: bool) -> bool {
		let argv: Vec<BString> = argv.iter().copied().map(BString::from).collect();
		needs_program(&argv, terminal)
	}

	/// A regression here spawns the system shell for the forms agents type,
	/// which then sees neither pi's utilities nor its URLs.
	#[test]
	fn scripted_shells_run_in_engine() {
		for argv in [
			&["bash", "-c", "echo hi", "name", "arg"][..],
			&["bash", "script.sh", "arg"],
			&["bash", "-s", "arg"],
			&["bash"],
			&["bash", "-euxo", "pipefail", "-c", ":"],
			&["bash", "-o", "posix", "-n", "script.sh"],
			&["bash", "-v", "+v", "-c", ":"],
			&["bash", "-lc", ":"],
			&["bash", "--norc", "--noprofile", "--login", "--posix", "-c", ":"],
			&["bash", "-O", "extglob", "-c", ":"],
			&["bash", "--version"],
			&["sh", "-ec", ":"],
			&["sh", "-s"],
			&["zsh", "-c", ":"],
			&["zsh", "-f", "-o", "pipefail", "-euxc", ":"],
			&["zsh", "-lc", ":"],
			&["zsh", "script.zsh"],
		] {
			assert!(!needs(argv, false), "{argv:?}");
		}
	}

	/// A regression here runs `zsh -ic 'my_alias'` without the user's
	/// `.zshrc`, or reads a terminal's keystrokes as a script.
	#[test]
	fn interactive_shells_are_the_program() {
		for argv in [
			&["bash", "-i"][..],
			&["bash", "-ic", "nvm use"],
			&["bash", "-lic", ":"],
			&["bash", "--noprofile", "--norc", "-i"],
			&["sh", "-i"],
			&["zsh", "-ic", ":"],
			&["zsh", "-l", "-i", "-c", ":"],
		] {
			assert!(needs(argv, false), "{argv:?}");
		}
		// No command and no script: interactive only on a terminal.
		for argv in [&["bash"][..], &["bash", "-s", "arg"], &["sh"], &["zsh"], &["zsh", "-l"]] {
			assert!(needs(argv, true), "{argv:?} on a terminal");
			assert!(!needs(argv, false), "{argv:?} off a terminal");
		}
		// A command or a script is not read from the terminal.
		assert!(!needs(&["bash", "-c", ":"], true));
		assert!(!needs(&["zsh", "script.zsh"], true));
		// `+i` takes `-i` back.
		assert!(!needs(&["bash", "-i", "+i", "-c", ":"], false));
	}

	/// A regression here answers for the system shell with the engine's
	/// "not supported" or its own usage error.
	#[test]
	fn what_the_engine_refuses_is_the_program() {
		for argv in [
			&["bash", "-r", "-c", ":"][..],
			&["bash", "--restricted"],
			&["bash", "--pretty-print", "script.sh"],
			&["bash", "-vc", ":"],
			&["bash", "--verbose", "script.sh"],
			&["sh", "-o", "verbose", "-c", ":"],
			&["zsh", "-fvc", ":"],
			&["bash", "--dump-strings", "script.sh"],
			&["bash", "-D", "script.sh"],
			&["bash", "--no-such-option"],
			&["bash", "-c"],
			&["bash", "-o", "nosuchoption", "-c", ":"],
			&["sh", "-Z"],
			&["zsh", "--no-such-option"],
			&["zsh", "-o", "nosuchoption", "-c", ":"],
		] {
			assert!(needs(argv, false), "{argv:?}");
		}
	}
}
