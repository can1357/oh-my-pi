use std::io::Write;

use clap::Parser;

use crate::{Error, ExecutionContext, ExecutionResult, ShellExtensions, builtins};

/// Manage aliases within the shell.
#[derive(Parser)]
pub(crate) struct AliasCommand {
	/// Print all defined aliases in a reusable format.
	#[arg(short = 'p')]
	print: bool,

	/// List of aliases to display or update.
	#[arg(name = "name[=value]")]
	aliases: Vec<String>,
}

impl builtins::Command for AliasCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let mut exit_code = ExecutionResult::success();

		if self.print || self.aliases.is_empty() {
			for (name, value) in context.shell.aliases() {
				writeln!(context.stdout(), "alias {name}='{value}'")?;
			}
		} else {
			for alias in &self.aliases {
				if let Some((name, unexpanded_value)) = alias.split_once('=')
					&& !name.is_empty()
				{
					context
						.shell
						.aliases_mut()
						.insert(name.to_owned(), unexpanded_value.to_owned());
				} else if let Some(value) = context.shell.aliases().get(alias) {
					writeln!(context.stdout(), "alias {alias}='{value}'")?;
				} else {
					writeln!(context.stderr(), "{}: {alias}: not found", context.command_name)?;
					exit_code = ExecutionResult::general_error();
				}
			}
		}

		Ok(exit_code)
	}
}
