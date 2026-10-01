use std::io::Write;

use brush_core::{ExecutionResult, builtins, escape};
use clap::Parser;

/// Echo text to standard output.
#[derive(Parser)]
#[clap(disable_help_flag = true, disable_version_flag = true)]
pub(crate) struct EchoCommand {
	/// Suppress the trailing newline from the output.
	#[arg(short = 'n')]
	no_trailing_newline: bool,

	/// Interpret backslash escapes in the provided text.
	#[arg(short = 'e')]
	interpret_backslash_escapes: bool,

	/// Do not interpret backslash escapes in the provided text.
	#[arg(short = 'E')]
	no_interpret_backslash_escapes: bool,

	/// Tokens to echo to standard output.
	#[arg(trailing_var_arg = true, allow_hyphen_values = true)]
	args: Vec<String>,
}

impl builtins::Command for EchoCommand {
	type Error = brush_core::Error;

	/// Override the default [`builtins::Command::new`] function to handle clap's
	/// limitation related to `--`. See [`builtins::parse_known`] for more
	/// information TODO(echo): we can safely remove this after the issue is
	/// resolved
	fn new<I>(args: I) -> Result<Self, clap::Error>
	where
		I: IntoIterator<Item = String>,
	{
		let (mut this, rest_args) = brush_core::builtins::try_parse_known::<Self>(args)?;
		if let Some(args) = rest_args {
			this.args.extend(args);
		}
		Ok(this)
	}

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut trailing_newline = !self.no_trailing_newline;
		let mut s;
		if self.interpret_backslash_escapes {
			s = String::new();
			for (i, arg) in self.args.iter().enumerate() {
				if i > 0 {
					s.push(' ');
				}

				let (expanded_arg, keep_going) = escape::expand_backslash_escapes(
					arg.as_str(),
					escape::EscapeExpansionMode::EchoBuiltin,
				)?;
				s.push_str(&String::from_utf8_lossy(expanded_arg.as_slice()));

				if !keep_going {
					trailing_newline = false;
					break;
				}
			}
		} else {
			s = self.args.join(" ");
		}

		if trailing_newline {
			s.push('\n');
		}

		write!(context.stdout(), "{s}")?;
		context.stdout().flush()?;

		Ok(ExecutionResult::success())
	}
}
