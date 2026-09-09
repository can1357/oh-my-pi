use std::io::Write;

use brush_core::{ExecutionResult, builtins};
use clap::Parser;
use itertools::Itertools;

/// Display command help.
#[derive(Parser)]
pub(crate) struct HelpCommand {
	/// Display a short description for the commands.
	#[arg(short = 'd')]
	short_description: bool,

	/// Display a man-style page of documentation for the commands.
	#[arg(short = 'm')]
	man_page_style: bool,

	/// Display a short usage summary for the commands.
	#[arg(short = 's')]
	short_usage: bool,

	/// Patterns of topics to display help for.
	topic_patterns: Vec<String>,
}

impl builtins::Command for HelpCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {
		if self.topic_patterns.is_empty() {
			Self::display_general_help(&context)?;
		} else {
			for topic_pattern in &self.topic_patterns {
				self.display_help_for_topic_pattern(&context, topic_pattern)?;
			}
		}

		Ok(ExecutionResult::success())
	}
}

impl HelpCommand {
	fn display_general_help(
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<(), brush_core::Error> {
		const COLUMN_COUNT: usize = 3;

		if let Some(display_str) = context.shell.product_display_str() {
			writeln!(context.stdout(), "{display_str}\n")?;
		}

		writeln!(context.stdout(), "The following commands are implemented as shell built-ins:")?;

		let builtins = get_builtins_sorted_by_name(context);
		let items_per_column = builtins.len().div_ceil(COLUMN_COUNT);

		for i in 0..items_per_column {
			for j in 0..COLUMN_COUNT {
				if let Some((name, builtin)) = builtins.get(i + j * items_per_column) {
					let prefix = if builtin.disabled { "*" } else { " " };
					write!(context.stdout(), "  {prefix}{name:<20}")?; // adjust 20 to the desired
					// column width
				}
			}
			writeln!(context.stdout())?;
		}

		Ok(())
	}

	fn display_help_for_topic_pattern(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
		topic_pattern: &str,
	) -> Result<(), brush_core::Error> {
		let pattern = brush_core::patterns::Pattern::from(topic_pattern)
			.set_extended_globbing(context.shell.options().extended_globbing)
			.set_case_insensitive(context.shell.options().case_insensitive_pathname_expansion);

		let mut found_count = 0;
		for (builtin_name, builtin_registration) in get_builtins_sorted_by_name(context) {
			if pattern.exactly_matches(builtin_name.as_str())? {
				self.display_help_for_builtin(context, builtin_name.as_str(), builtin_registration)?;
				found_count += 1;
			}
		}

		if found_count == 0 {
			writeln!(context.stderr(), "No help topics match '{topic_pattern}'")?;
		}

		Ok(())
	}

	fn display_help_for_builtin<SE: brush_core::ShellExtensions>(
		&self,
		context: &brush_core::ExecutionContext<'_, SE>,
		name: &str,
		registration: &builtins::Registration<SE>,
	) -> Result<(), brush_core::Error> {
		let content_type = if self.short_description {
			builtins::ContentType::ShortDescription
		} else if self.man_page_style {
			builtins::ContentType::ManPage
		} else if self.short_usage {
			builtins::ContentType::ShortUsage
		} else {
			builtins::ContentType::DetailedHelp
		};

		let Some(mut stdout) = context.try_fd(brush_core::openfiles::OpenFiles::STDOUT_FD) else {
			// If there's no stdout, nothing to do.
			return Ok(());
		};

		// For now, we assume colorized output if stdout is a terminal.
		let options = builtins::ContentOptions { colorized: stdout.is_terminal() };

		let content = (registration.content_func)(name, content_type, &options)?;

		write!(stdout, "{content}")?;
		stdout.flush()?;

		Ok(())
	}
}

fn get_builtins_sorted_by_name<'a, SE: brush_core::ShellExtensions>(
	context: &'a brush_core::ExecutionContext<'_, SE>,
) -> Vec<(&'a String, &'a builtins::Registration<SE>)> {
	context
		.shell
		.builtins()
		.iter()
		.sorted_by_key(|(name, _)| *name)
		.collect()
}
