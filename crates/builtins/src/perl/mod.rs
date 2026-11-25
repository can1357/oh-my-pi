//! `perl` builtin: a Perl 5 interpreter with Perl 5.34 semantics.
//!
//! The builtin follows `perlrun` for invocation and the Perl 5.34 language
//! documentation for parsing and execution.
//!
//! A program this builtin cannot run runs on the `perl` (`perl.exe` on
//! Windows) found on the shell's `PATH` instead, given the same arguments and
//! stdin, while it has had no effect yet: when a switch it does not support
//! (`-d`, `-d:MOD`, `-D`, `-u`, `-U`, from argv, `PERL5OPT` or the `#!` line)
//! is given, or when compilation dies (syntax error, missing module, a `die`
//! in `BEGIN`). Never for a program read from stdin, nor once anything was
//! read from stdin or written to stdout or stderr. Without a `PATH` perl, or
//! with `OMP_PERL_FALLBACK=0` in the shell environment, the builtin reports
//! its own error.

use std::ffi::OsString;

use clap::Parser;

use crate::host::{Host, Utility};

/// Perl's argument vector, handed off intact to the `perlrun` parser.
#[derive(Debug, Parser)]
#[command(name = "perl", disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct Perl {
	#[arg(value_name = "ARGS", trailing_var_arg = true, allow_hyphen_values = true, num_args = 0..)]
	args: Vec<OsString>,
}

impl Utility for Perl {
	const NAME: &'static str = "perl";
	const RUNS_COMMANDS: bool = true;
	const USAGE_ERROR: u8 = 29;
	const DEFERS_TO_PATH: bool = false;

	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		if argv.len() > 1 {
			argv.insert(1, OsString::from("--"));
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		cli::run(&self.args, host)
	}
}

mod ast;
mod cli;
mod code;
mod func;
mod interp;
mod io;
mod lexer;
mod limits;
mod modules;
mod ops;
mod pack;
mod parser;
mod regex;
mod rx;
mod sprintf;
#[cfg(test)]
mod tests;
mod translit;
mod value;
