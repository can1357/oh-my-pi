use std::io::Write;

use brush_core::{ErrorKind, ExecutionExitCode, ExecutionResult, builtins, env, escape, variables};
use clap::Parser;

use crate::line_input::{CTRL_C, CTRL_D, LineInput, ReadAhead, decode_line};

/// Read lines from standard input into an indexed array variable.
#[derive(Parser)]
pub(crate) struct MapFileCommand {
	/// Delimiter to use (defaults to newline).
	#[arg(short = 'd')]
	delimiter: Option<String>,

	/// Maximum number of entries to read (0 means no limit).
	#[arg(short = 'n', default_value_t = 0)]
	max_count: i64,

	/// Index into array at which to start assignment.
	#[arg(short = 'O', allow_hyphen_values = true)]
	origin: Option<i64>,

	/// Number of initial entries to skip.
	#[arg(short = 's', default_value_t = 0, value_parser = clap::value_parser!(i64).range(0..))]
	skip_count: i64,

	/// Whether or not to remove the delimiter from each read line.
	#[arg(short = 't')]
	remove_delimiter: bool,

	/// File descriptor to read from (defaults to stdin).
	#[arg(short = 'u', default_value_t = 0)]
	fd: brush_core::ShellFd,

	/// Name of function to call for each group of lines.
	#[arg(short = 'C')]
	callback: Option<String>,

	/// Number of lines to pass the callback for each group.
	#[arg(short = 'c', default_value_t = 5000, value_parser = clap::value_parser!(i64).range(1..))]
	callback_group_size: i64,

	/// Name of array to read into.
	#[arg(default_value = "MAPFILE")]
	array_var_name: String,
}

impl builtins::Command for MapFileCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		mut context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {

		if let Some(origin) = self.origin {
			if origin < 0 {
				writeln!(context.stderr(), "{}: {origin}: invalid array origin", context.command_name)?;
				return Ok(ExecutionExitCode::GeneralError.into());
			}
		}

		if let Some((_, var)) = context.shell.env().get(&self.array_var_name) {
			// Refused before any input is read, as in bash. Assigning an element
			// does not check this itself (so -O wrote into a readonly array), and
			// a failure mid-loop would lose input read ahead of a pipe.
			if var.is_readonly() {
				return Err(ErrorKind::ReadonlyVariable.into());
			}
			if matches!(
				var.value(),
				variables::ShellValue::AssociativeArray(_)
					| variables::ShellValue::Unset(variables::ShellValueUnsetType::AssociativeArray)
			) {
				writeln!(
					context.stderr(),
					"{}: {}: not an indexed array",
					context.command_name,
					self.array_var_name
				)?;
				return Ok(ExecutionExitCode::GeneralError.into());
			}
		}

		let input_file = context
			.try_fd(self.fd)
			.ok_or_else(|| ErrorKind::BadFileDescriptor(self.fd))?;

		// Read and assign entries. When no origin is specified, bash clears the
		// target array before reading; callbacks then see earlier assigned entries
		// but not the entry that is currently being delivered to the callback.
		if self.origin.is_none() {
			context.shell.env_mut().update_or_add(
				&self.array_var_name,
				variables::ShellValueLiteral::Array(variables::ArrayLiteral(vec![])),
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)?;
		}

		if let Some(result) = self.read_entries(input_file, &mut context).await? {
			return Ok(result);
		}

		Ok(ExecutionResult::success())
	}
}

impl MapFileCommand {
	async fn read_entries<SE: brush_core::ShellExtensions>(
		&self,
		input_file: brush_core::openfiles::OpenFile,
		context: &mut brush_core::ExecutionContext<'_, SE>,
	) -> Result<Option<ExecutionResult>, brush_core::Error> {
		let _term_mode = setup_terminal_settings(&input_file)?;

		let mut entry_count = 0usize;
		let mut read_count = 0;
		let max_count = self.max_count.try_into()?;
		let callback_group_size: usize = self.callback_group_size.try_into()?;
		let delimiter = match &self.delimiter {
			Some(d) if d.is_empty() => b'\0',
			Some(d) => d.as_bytes().first().copied().unwrap_or(b'\n'),
			None => b'\n',
		};

		let terminal = input_file.is_terminal();
		// Without -n or -C every byte up to EOF is consumed before anything
		// else reads the descriptor, so any input is read in blocks. -n may
		// stop early, and a -C callback may read the descriptor itself or
		// end the loop; then only a regular file, whose offset is given
		// back, is (bash's mapfile reads a pipe unbuffered too).
		let read_ahead =
			if max_count == 0 && self.callback.is_none() { ReadAhead::ToEof } else { ReadAhead::Seekable };
		let mut input = LineInput::new(input_file, read_ahead);

		while max_count == 0 || entry_count < max_count {
			let mut line = vec![];
			let mut saw_delimiter = false;

			while let Some(byte) = input.next_byte()? {
				// Interactive keys end input only on a terminal; in a file or
				// pipe they are data.
				if terminal && (byte == CTRL_C || byte == CTRL_D && line.is_empty()) {
					break;
				}
				line.push(byte);
				if byte == delimiter {
					saw_delimiter = true;
					break;
				}
			}

			if line.is_empty() && !saw_delimiter {
				break;
			}

			if read_count < self.skip_count {
				read_count += 1;
				continue;
			}

			if self.remove_delimiter && line.ends_with(&[delimiter]) {
				line.pop();
			}

			let line_str = decode_line(line);
			let array_index = self.origin.unwrap_or(0) + i64::try_from(entry_count)?;

			if let Some(callback) = &self.callback
				&& (entry_count + 1).is_multiple_of(callback_group_size)
			{
				input.give_back();
				let result = run_callback(callback, array_index, &line_str, context).await?;
				if !result.is_normal_flow() {
					return Ok(Some(result));
				}
			}

			context.shell.env_mut().update_or_add_array_element(
				&self.array_var_name,
				array_index.to_string(),
				line_str,
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
			)?;

			entry_count += 1;
		}

		Ok(None)
	}
}

async fn run_callback<SE: brush_core::ShellExtensions>(
	callback: &str,
	array_index: i64,
	line: &str,
	context: &mut brush_core::ExecutionContext<'_, SE>,
) -> Result<ExecutionResult, brush_core::Error> {
	let index_arg = array_index.to_string();
	let index_arg = escape::quote_if_needed(&index_arg, escape::QuoteMode::SingleQuote);
	let line_arg = escape::quote_if_needed(line, escape::QuoteMode::SingleQuote);

	let mut command = String::with_capacity(callback.len() + index_arg.len() + line_arg.len() + 2);
	command.push_str(callback);
	command.push(' ');
	command.push_str(index_arg.as_ref());
	command.push(' ');
	command.push_str(line_arg.as_ref());

	let source_info = context.shell.call_stack().current_pos_as_source_info();
	context.shell.run_string(command, &source_info, &context.params).await
}

fn setup_terminal_settings(
	file: &brush_core::openfiles::OpenFile,
) -> Result<Option<brush_core::terminal::AutoModeGuard>, brush_core::Error> {
	// The guard dups the descriptor and reads its terminal attributes; a
	// pipe or file has none.
	if !file.is_terminal() {
		return Ok(None);
	}
	let mode = brush_core::terminal::AutoModeGuard::new(file.to_owned()).ok();
	if let Some(mode) = &mode {
		let config = brush_core::terminal::Settings::builder()
			.line_input(false)
			.interrupt_signals(false)
			.build();

		mode.apply_settings(&config)?;
	}

	Ok(mode)
}
