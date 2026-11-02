use std::io::Write;

use brush_core::{ExecutionResult, builtins, escape};
use clap::Parser;

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
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		let mut exit_code = ExecutionResult::success();

		if self.print || self.aliases.is_empty() {
			write_aliases(context.shell.aliases(), &mut context.stdout())?;
		} else {
			for alias in &self.aliases {
				if let Some((name, unexpanded_value)) = alias.split_once('=')
					&& !name.is_empty()
					&& legal_alias_name(name)
				{
					context
						.shell
						.aliases_mut()
						.insert(name.to_owned(), unexpanded_value.to_owned());
				} else if let Some(value) = context.shell.aliases().get(alias) {
					write_alias(alias, value, &mut context.stdout())?;
				} else {
					if alias.contains('=')
						&& let Some((name, _)) = alias.split_once('=')
						&& !name.is_empty()
					{
						writeln!(
							context.stderr(),
							"{}: `{name}': invalid alias name",
							context.command_name
						)?;
					} else {
						writeln!(context.stderr(), "{}: {alias}: not found", context.command_name)?;
					}
					exit_code = ExecutionResult::general_error();
				}
			}
		}

		Ok(exit_code)
	}
}

/// The shell-syntax characters Bash rejects in an alias name. Other printable
/// punctuation, such as `-`, `.`, `{`, `[`, `*`, `~`, `#` and `!`, is valid.
fn legal_alias_name(name: &str) -> bool {
	!name.is_empty() && !name.contains(['/', '$', '\'', '"', '\\', '`', ' ', '\t', '\n', ';', '|', '&', '(', ')', '<', '>'])
}

fn write_alias(name: &str, value: &str, writer: &mut impl Write) -> Result<(), std::io::Error> {
	writeln!(
		writer,
		"alias {name}={}",
		escape::force_quote(value, escape::QuoteMode::SingleQuote)
	)
}

fn write_aliases(
	aliases: &std::collections::HashMap<String, String>,
	writer: &mut impl Write,
) -> Result<(), std::io::Error> {
	let mut aliases: Vec<_> = aliases.iter().collect();
	aliases.sort_unstable_by(|(left, _), (right, _)| left.cmp(right));
	for (name, value) in aliases {
		write_alias(name, value, writer)?;
	}
	Ok(())
}
