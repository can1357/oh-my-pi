//! `printenv` builtin: display values from the shell's exported environment.
//!
//! Ported from uutils coreutils 0.8.0.

use std::io::Write;

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command};
use uucore::line_ending::LineEnding;

use crate::host::{Host, Utility, format_usage, matches_parser, util};

const OPT_NULL: &str = "null";
const ARG_VARIABLES: &str = "variables";

/// Parsed `printenv` invocation.
pub(crate) struct Printenv {
	matches: ArgMatches,
}

matches_parser!(Printenv, app);

impl Utility for Printenv {
	const NAME: &'static str = "printenv";

	fn run(self, host: &mut Host) -> i32 {
		let variables = self
			.matches
			.get_many::<String>(ARG_VARIABLES)
			.into_iter()
			.flatten()
			.collect::<Vec<_>>();
		let separator = LineEnding::from_zero_flag(self.matches.get_flag(OPT_NULL));

		if variables.len() == 0 {
			// Hash map iteration order is intentionally hidden from callers. Sort by
			// name so repeated invocations produce the same environment dump.
			let mut environment = host
				.env()
				.map(|(name, value)| (name.to_owned(), value.to_owned()))
				.collect::<Vec<_>>();
			environment.sort_unstable_by(|left, right| left.0.cmp(&right.0));
			for (name, value) in environment {
				if let Err(error) = write!(host.stdout, "{name}={value}{separator}") {
					host.error(error, 1);
					return 1;
				}
			}
			if let Err(error) = host.stdout.flush() {
				host.error(error, 1);
				return 1;
			}
			return 0;
		}

		let mut error_found = false;
		for env_var in variables {
			// We silently ignore a=b as a variable, but still report failure in
			// the exit status.
			if env_var.contains('=') {
				error_found = true;
				continue;
			}
			if let Some(value) = host.var(env_var).map(str::to_owned) {
				if let Err(error) = write!(host.stdout, "{value}{separator}") {
					host.error(error, 1);
					return 1;
				}
				if let Err(error) = host.stdout.flush() {
					host.error(error, 1);
					return 1;
				}
			} else {
				error_found = true;
			}
		}

		i32::from(error_found)
	}
}

/// The `printenv` argument model.
fn app() -> Command {
	Command::new(Printenv::NAME)
		.version("0.8.0")
		.about(
			"Display the values of the specified environment VARIABLE(s), or (with no VARIABLE) \
			 display name and value pairs for them all.",
		)
		.override_usage(format_usage("printenv [OPTION]... [VARIABLE]..."))
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_NULL)
				.short('0')
				.long(OPT_NULL)
				.help("end each output line with 0 byte rather than newline")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(ARG_VARIABLES)
				.action(ArgAction::Append)
				.num_args(1..),
		)
}

/// Creates the `printenv` builtin registration.
pub(crate) fn printenv_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Printenv, SE>()
}

#[cfg(test)]
mod tests {
	use std::ffi::OsString;

	use clap::Parser;

	use super::Printenv;
	use crate::host::{Host, Utility, run_util};

	const ENV: &[(&str, &str)] = &[("FOO", "bar"), ("BAZ", "qux")];

	fn run_with_env(env: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
		let (mut host, capture) = Host::for_test(Printenv::NAME, Vec::new(), ".");
		for &(name, value) in env {
			host.set_test_var(name, value);
		}
		let argv = std::iter::once(OsString::from(Printenv::NAME))
			.chain(args.iter().map(OsString::from));
		let parsed = Printenv::try_parse_from(argv).expect("test arguments must parse");
		let code = parsed.run(&mut host);
		(code, capture.out(), capture.err())
	}

	#[test]
	fn named_variable_prints_scope_value() {
		let (code, stdout, stderr) = run_with_env(ENV, &["FOO"]);
		assert_eq!(code, 0);
		assert_eq!(stdout, "bar\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn shell_export_absent_from_process_environment_is_printed() {
		const NAME: &str = "__BRUSH_PRINTENV_TEST_ONLY_EXPORTED_VARIABLE__";
		assert!(std::env::var_os(NAME).is_none());
		let (code, stdout, stderr) = run_with_env(&[(NAME, "shell-value")], &[NAME]);
		assert_eq!((code, stdout.as_str(), stderr.as_str()), (0, "shell-value\n", ""));
	}

	#[test]
	fn unset_variable_is_silent_failure() {
		let (code, stdout, stderr) = run_with_env(ENV, &["NOPE"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "");
		assert_eq!(stderr, "", "unset variables fail without a message");
	}

	#[test]
	fn mixed_set_and_unset_prints_set_ones_and_fails() {
		let (code, stdout, stderr) = run_with_env(ENV, &["FOO", "NOPE", "BAZ"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "bar\nqux\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn no_args_dumps_scope_env_not_process_env_in_name_order() {
		assert!(std::env::var_os("PATH").is_some());
		let (code, stdout, stderr) = run_with_env(ENV, &[]);
		assert_eq!(code, 0);
		assert_eq!(stderr, "");
		assert_eq!(stdout, "BAZ=qux\nFOO=bar\n");
	}

	#[test]
	fn null_flag_terminates_with_nul() {
		let (code, stdout, _) = run_with_env(ENV, &["-0", "FOO"]);
		assert_eq!((code, stdout.as_str()), (0, "bar\0"));

		let (code, stdout, _) = run_with_env(ENV, &["--null", "FOO", "BAZ"]);
		assert_eq!((code, stdout.as_str()), (0, "bar\0qux\0"));
	}

	#[test]
	fn name_containing_equals_is_ignored_but_fails() {
		let (code, stdout, stderr) = run_with_env(ENV, &["FOO=bar", "BAZ"]);
		assert_eq!(code, 1);
		assert_eq!(stdout, "qux\n");
		assert_eq!(stderr, "");
	}

	#[test]
	fn help_renders_to_scope_stdout() {
		let (code, capture) = run_util::<Printenv>(&["--help"], "", ".");
		assert_eq!(code, 0);
		assert!(capture.out().contains("Usage:"));
		assert!(capture.out().contains("environment VARIABLE"));
		assert_eq!(capture.err(), "");
	}
}
