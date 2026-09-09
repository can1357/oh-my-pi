use std::{
	collections::VecDeque,
	io::{Read, Write},
	time::{Duration, Instant},
};

use brush_core::{ErrorKind, builtins, env, error, variables};
use clap::Parser;
use itertools::Itertools;

/// Exit code returned when `read` times out.
/// This is 128 + SIGALRM (14) = 142, matching bash behavior.
const TIMEOUT_EXIT_CODE: u8 = 142;

/// ASCII control character for Ctrl+C (ETX - End of Text).
const CTRL_C: char = '\x03';
/// ASCII control character for Ctrl+D (EOT - End of Transmission).
const CTRL_D: char = '\x04';
/// Backslash character used for escape processing.
const BACKSLASH: char = '\\';
/// Default line delimiter (newline).
const DEFAULT_DELIMITER: char = '\n';
/// NUL character used as delimiter when `-d ''` is specified.
const NUL_DELIMITER: char = '\0';

/// Parse standard input.
#[derive(Parser)]
pub(crate) struct ReadCommand {
	/// Optionally, name of an array variable to receive read words
	/// of input.
	#[clap(short = 'a', value_name = "VAR_NAME")]
	array_variable: Option<String>,

	/// Optionally, a delimiter to use other than a newline character.
	#[clap(short = 'd')]
	delimiter: Option<String>,

	/// Use readline-like input.
	#[clap(short = 'e')]
	use_readline: bool,

	/// Provide text to use as initial input for readline.
	#[clap(short = 'i', value_name = "STR")]
	initial_text: Option<String>,

	/// Read only the first N characters or until a specified
	/// delimiter is reached, whichever happens first.
	#[clap(short = 'n', value_name = "COUNT")]
	return_after_n_chars: Option<usize>,

	/// Read exactly N characters, ignoring any specified delimiter.
	#[clap(short = 'N', value_name = "COUNT")]
	return_after_n_chars_no_delimiter: Option<usize>,

	/// Prompt to display before reading.
	#[clap(short = 'p')]
	prompt: Option<String>,

	/// Read input in raw mode; no escape sequences.
	#[clap(short = 'r')]
	raw_mode: bool,

	/// Do not echo input.
	#[clap(short = 's')]
	silent: bool,

	/// Specify timeout in seconds; fail if the timeout elapses before
	/// input is completed.
	#[clap(short = 't', value_name = "SECONDS", allow_hyphen_values = true)]
	timeout_in_seconds: Option<f64>,

	/// File descriptor to read from instead of stdin.
	#[clap(short = 'u', name = "FD")]
	fd_num_to_read: Option<u8>,

	/// Optionally, names of variables to receive read input.
	variable_names: Vec<String>,
}

impl builtins::Command for ReadCommand {
	type Error = brush_core::Error;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<brush_core::ExecutionResult, Self::Error> {

		// Validate timeout value if provided.
		if let Some(result) = self.validate_timeout(&context)? {
			return Ok(result);
		}

		// Find the input stream to use.
		let fd_num = self
			.fd_num_to_read
			.map_or(brush_core::openfiles::OpenFiles::STDIN_FD, brush_core::ShellFd::from);

		// Retrieve the file.
		let input_stream = context
			.try_fd(fd_num)
			.ok_or_else(|| ErrorKind::BadFileDescriptor(fd_num))?;
		// Bash only uses readline for `read -e` when reading from a terminal.
		// For non-terminal input, `-e` and `-i` are accepted but do not affect
		// the bytes read. `-i` only supplies initial text to readline, so without
		// an available readline-backed terminal path it is likewise a no-op.
		if self.use_readline && input_stream.is_terminal() {
			return error::unimp(if self.initial_text.is_some() {
				"read -e -i"
			} else {
				"read -e"
			});
		}

		// Retrieve effective value of IFS for splitting.
		// We convert to owned String to release the borrow before the mutable borrow
		// needed for variable assignment.
		let ifs = context.shell.ifs().into_owned();

		// Convert timeout to Duration.
		let timeout = self.timeout_in_seconds.map(Duration::from_secs_f64);

		// Perform the read operation (potentially with timeout).
		let read_result =
			self.read_line(input_stream, context.stderr(), timeout, || context.is_cancelled())?;

		// Determine whether to skip IFS splitting (for -N option).
		let skip_ifs_splitting = self.return_after_n_chars_no_delimiter.is_some();

		// Extract the input line and determine exit code based on result.
		let (input_line, result) = match &read_result {
			ReadResult::Line(line) => (Some(line.clone()), brush_core::ExecutionResult::success()),
			ReadResult::Eof(Some(line)) => {
				(Some(line.clone()), brush_core::ExecutionResult::general_error())
			},
			ReadResult::Eof(None) | ReadResult::Interrupted | ReadResult::InputNotReady => {
				(None, brush_core::ExecutionResult::general_error())
			},
			ReadResult::TimedOut(partial) => {
				(partial.clone(), brush_core::ExecutionResult::new(TIMEOUT_EXIT_CODE))
			},
			ReadResult::InputReady => (None, brush_core::ExecutionResult::success()),
		};

		// Assign input to variables based on options.
		assign_input_to_variables(
			context.shell,
			input_line.as_deref(),
			&ifs,
			skip_ifs_splitting,
			self.array_variable.as_deref(),
			&self.variable_names,
		)?;

		Ok(result)
	}
}

/// Assigns read input to shell variables based on the specified options.
///
/// This handles three modes:
/// - Array mode (`-a`): Split input by IFS and assign to array elements
/// - Named variables: Split input by IFS and assign to each variable, with
///   remainder to last
/// - Default (`REPLY`): Assign entire input line to the `REPLY` variable
fn assign_input_to_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	array_variable: Option<&str>,
	variable_names: &[String],
) -> Result<(), brush_core::Error> {
	if let Some(array_variable) = array_variable {
		let literal_fields = build_array_fields(input_line, ifs, skip_ifs_splitting);
		shell.env_mut().update_or_add(
			array_variable,
			variables::ShellValueLiteral::Array(variables::ArrayLiteral(literal_fields)),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;
	} else if !variable_names.is_empty() {
		assign_to_named_variables(shell, input_line, ifs, skip_ifs_splitting, variable_names)?;
	} else {
		shell.env_mut().update_or_add(
			"REPLY",
			variables::ShellValueLiteral::Scalar(input_line.unwrap_or_default().to_owned()),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;
	}
	Ok(())
}

/// Assigns split fields to named variables.
///
/// Fields are assigned one per variable, with any remaining fields joined by
/// space and assigned to the last variable. If there are more variables than
/// fields, the extra variables are set to empty strings.
fn assign_to_named_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	variable_names: &[String],
) -> Result<(), brush_core::Error> {
	let mut fields =
		build_variable_fields(input_line, ifs, skip_ifs_splitting, variable_names.len());

	for (i, name) in variable_names.iter().enumerate() {
		let is_last = i == variable_names.len() - 1;

		let value = if fields.is_empty() {
			String::new()
		} else if is_last {
			// Last variable gets all remaining fields joined by space.
			std::mem::take(&mut fields).into_iter().join(" ")
		} else {
			fields.pop_front().unwrap_or_default()
		};

		shell.env_mut().update_or_add(
			name,
			variables::ShellValueLiteral::Scalar(value),
			|_| Ok(()),
			env::EnvironmentLookup::Anywhere,
			env::EnvironmentScope::Global,
		)?;

		if is_last {
			break;
		}
	}
	Ok(())
}

/// Builds array field values from input, optionally splitting by IFS.
fn build_array_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
) -> Vec<(Option<String>, String)> {
	match input_line {
		Some(line) if skip_ifs_splitting => {
			// With -N, don't split - put entire input as single element.
			vec![(None, line.to_string())]
		},
		Some(line) => {
			let fields: VecDeque<_> = split_line_by_ifs(ifs, line, None /* max_fields */);
			fields.into_iter().map(|f| (None, f)).collect()
		},
		None => vec![],
	}
}

/// Builds field values from input for assignment to named variables.
fn build_variable_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	num_variables: usize,
) -> VecDeque<String> {
	match input_line {
		Some(line) if skip_ifs_splitting => {
			// With -N, don't split - put entire input in first variable.
			let mut fields = VecDeque::new();
			fields.push_back(line.to_string());
			fields
		},
		Some(line) => split_line_by_ifs(ifs, line, Some(num_variables)),
		None => VecDeque::new(),
	}
}

/// Result of a `read` operation.
///
/// This enum clearly represents all possible outcomes of `read_line()`,
/// making the contract with callers explicit.
#[derive(Debug)]
enum ReadResult {
	/// Successfully read a complete line (delimiter or char limit reached).
	Line(String),
	/// Reached end of input. Contains any partial content read before EOF.
	Eof(Option<String>),
	/// Input was interrupted (e.g., Ctrl+C). No content is returned.
	Interrupted,
	/// The operation timed out. Contains any partial content read before
	/// timeout.
	TimedOut(Option<String>),
	/// For `-t 0`: input is immediately available (exit 0).
	InputReady,
	/// For `-t 0`: no input immediately available (exit 1).
	InputNotReady,
}

/// Helper struct that encapsulates the state for reading input character by
/// character.
///
/// This separates the concerns of character-level I/O with timeout handling
/// from the higher-level logic of line building and escape processing.
struct InputReader {
	/// The input source.
	input:      brush_core::openfiles::OpenFile,
	/// Optional deadline for timeout.
	deadline:   Option<Instant>,
	/// Single-byte read buffer.
	///
	/// TODO(utf-8): This only handles ASCII correctly. Multi-byte UTF-8
	/// characters will be read as separate bytes and incorrectly interpreted.
	/// To fix this, we would need to buffer up to 4 bytes and decode
	/// incrementally using `std::str::from_utf8`. Note that bash's `-n` counts
	/// bytes, not Unicode codepoints, so the fix needs to preserve that
	/// behavior.
	buffer:     [u8; 1],
	/// Terminal mode guard - kept alive for RAII cleanup on drop.
	/// The guard restores original terminal settings when dropped, even though
	/// we don't access the field directly after construction.
	///
	/// The leading underscore suppresses the "unused field" warning while making
	/// it explicit this field exists solely for its `Drop` implementation.
	_term_mode: Option<brush_core::terminal::AutoModeGuard>,
}

/// Events that can occur when reading input.
enum InputEvent {
	/// A regular character was read.
	Char(char),
	/// End of file was reached.
	Eof,
	/// The read operation timed out.
	Timeout,
	/// Ctrl+C was pressed.
	CtrlC,
	/// Ctrl+D was pressed.
	CtrlD,
}

fn ensure_not_cancelled<F>(is_cancelled: &F) -> Result<(), brush_core::Error>
where
	F: Fn() -> bool,
{
	if is_cancelled() {
		return Err(ErrorKind::Interrupted.into());
	}

	Ok(())
}

impl InputReader {
	/// Creates a new input reader with optional timeout.
	fn new(
		input: brush_core::openfiles::OpenFile,
		timeout: Option<Duration>,
		term_mode: Option<brush_core::terminal::AutoModeGuard>,
	) -> Self {
		Self {
			input,
			deadline: timeout.map(|t| Instant::now() + t),
			buffer: [0; 1],
			_term_mode: term_mode,
		}
	}

	/// Checks if input is immediately available (for `-t 0`). Returns `false` if
	/// an error occurs while checking for available input.
	fn check_input_available(&self) -> bool {
		brush_core::sys::poll::poll_for_input(&self.input, Duration::ZERO).unwrap_or(false)
	}

	#[cfg(unix)]
	fn wait_for_input<F>(&self, is_cancelled: &F) -> Result<Option<InputEvent>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		const INPUT_POLL_INTERVAL_MS: u64 = 100;

		if self.deadline.is_none() && self.input.try_borrow_as_fd().is_err() {
			ensure_not_cancelled(is_cancelled)?;
			return Ok(None);
		}

		loop {
			ensure_not_cancelled(is_cancelled)?;

			let timeout = if let Some(deadline) = self.deadline {
				let remaining = deadline.saturating_duration_since(Instant::now());
				if remaining.is_zero() {
					return Ok(Some(InputEvent::Timeout));
				}

				remaining.min(Duration::from_millis(INPUT_POLL_INTERVAL_MS))
			} else {
				Duration::from_millis(INPUT_POLL_INTERVAL_MS)
			};

			match brush_core::sys::poll::poll_for_input(&self.input, timeout) {
				Ok(true) => return Ok(None),
				Ok(false) => continue,
				Err(e) => return Err(e.into()),
			}
		}
	}

	#[cfg(not(unix))]
	fn wait_for_input<F>(&self, is_cancelled: &F) -> Result<Option<InputEvent>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		ensure_not_cancelled(is_cancelled)?;

		if let Some(deadline) = self.deadline {
			let remaining = deadline.saturating_duration_since(Instant::now());
			if remaining.is_zero() {
				return Ok(Some(InputEvent::Timeout));
			}

			match brush_core::sys::poll::poll_for_input(&self.input, remaining) {
				Ok(true) => {},
				Ok(false) => return Ok(Some(InputEvent::Timeout)),
				Err(e) => return Err(e.into()),
			}
		}

		Ok(None)
	}

	/// Reads the next input event, handling timeout and control characters.
	fn read_event<F>(&mut self, is_cancelled: &F) -> Result<InputEvent, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		if let Some(event) = self.wait_for_input(is_cancelled)? {
			return Ok(event);
		}

		ensure_not_cancelled(is_cancelled)?;

		let n = self.input.read(&mut self.buffer)?;
		if n == 0 {
			return Ok(InputEvent::Eof);
		}

		let ch = self.buffer[0] as char;

		// Map control characters to events.
		Ok(match ch {
			CTRL_C => InputEvent::CtrlC,
			CTRL_D => InputEvent::CtrlD,
			_ => InputEvent::Char(ch),
		})
	}
}

/// Configuration for line reading behavior.
struct LineReaderConfig {
	/// Character that terminates input (None for -N mode).
	delimiter:       Option<char>,
	/// Maximum characters to read (for -n or -N).
	char_limit:      Option<usize>,
	/// Whether to process backslash escapes (false for -r mode).
	process_escapes: bool,
}

/// Reads a complete line of input using the given reader and configuration.
///
/// Returns a `ReadResult` indicating success, EOF, timeout, or interruption.
///
/// Note on character counting for `-n` limit:
/// Bash counts OUTPUT characters (after escape processing) toward the limit.
/// For example, with `-n 3` and input `a\bc` (4 bytes):
/// - Bash processes: 'a' (output 1), '\b' → 'b' (output 2), 'c' (output 3) →
///   "abc"
/// - The backslash is consumed but doesn't count toward the limit
fn read_line_with_reader<F>(
	reader: &mut InputReader,
	config: &LineReaderConfig,
	is_cancelled: &F,
) -> Result<ReadResult, brush_core::Error>
where
	F: Fn() -> bool,
{
	let mut line = String::new();
	let mut pending_backslash = false;

	loop {
		let event = reader.read_event(is_cancelled)?;

		match event {
			InputEvent::Eof => {
				// Bash discards pending backslash on EOF.
				return Ok(ReadResult::Eof(if line.is_empty() { None } else { Some(line) }));
			},

			InputEvent::Timeout => {
				// Include pending backslash on timeout (different from EOF).
				if pending_backslash {
					line.push(BACKSLASH);
				}
				return Ok(ReadResult::TimedOut(if line.is_empty() { None } else { Some(line) }));
			},

			InputEvent::CtrlC => {
				return Ok(ReadResult::Interrupted);
			},

			InputEvent::CtrlD => {
				// At line start = EOF, mid-input = flush current input.
				// Bash discards pending backslash here too.
				return Ok(if line.is_empty() && !pending_backslash {
					ReadResult::Eof(None)
				} else {
					ReadResult::Line(line)
				});
			},

			InputEvent::Char(ch) => {
				// Handle backslash escape processing (when enabled).
				if config.process_escapes {
					if pending_backslash {
						pending_backslash = false;

						// Backslash-delimiter is line continuation.
						if let Some(delim) = config.delimiter
							&& ch == delim
						{
							continue; // Line continuation.
						}

						// For other chars, add char literally (backslash consumed).
						line.push(ch);

						// Check character limit (based on output length).
						if let Some(limit) = config.char_limit
							&& line.len() >= limit
						{
							return Ok(ReadResult::Line(line));
						}
						continue;
					}

					if ch == BACKSLASH {
						pending_backslash = true;
						continue;
					}
				}

				// Check for delimiter.
				if let Some(delim) = config.delimiter
					&& ch == delim
				{
					return Ok(ReadResult::Line(line));
				}

				// Ignore non-whitespace control characters.
				if ch.is_ascii_control() && !ch.is_ascii_whitespace() {
					continue;
				}

				line.push(ch);

				// Check character limit (based on output length).
				if let Some(limit) = config.char_limit
					&& line.len() >= limit
				{
					return Ok(ReadResult::Line(line));
				}
			},
		}
	}
}

impl ReadCommand {
	/// Reads a line of input, optionally with a timeout.
	///
	/// Handles backslash escape processing:
	/// - Without `-r`: backslash-newline is line continuation, other backslashes
	///   escape the next char
	/// - With `-r`: backslash is treated as a literal character
	fn read_line<F>(
		&self,
		input_file: brush_core::openfiles::OpenFile,
		mut stderr_file: impl std::io::Write,
		timeout: Option<Duration>,
		is_cancelled: F,
	) -> Result<ReadResult, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		let term_mode = self.setup_terminal_settings(&input_file)?;

		// Display prompt on stderr, but only if input is from a terminal (per bash
		// behavior).
		if let Some(prompt) = &self.prompt {
			if input_file.is_terminal() {
				write!(stderr_file, "{prompt}")?;
				stderr_file.flush()?;
			}
		}

		// Determine delimiter based on options.
		let delimiter = if self.return_after_n_chars_no_delimiter.is_some() {
			None
		} else if let Some(delimiter_str) = &self.delimiter {
			if delimiter_str.is_empty() {
				Some(NUL_DELIMITER)
			} else {
				delimiter_str.chars().next()
			}
		} else {
			Some(DEFAULT_DELIMITER)
		};

		let char_limit = self
			.return_after_n_chars_no_delimiter
			.or(self.return_after_n_chars);

		// Create the input reader.
		let mut reader = InputReader::new(input_file, timeout, term_mode);

		// Handle -t 0 special case: just check if input is available without reading.
		if timeout == Some(Duration::ZERO) {
			ensure_not_cancelled(&is_cancelled)?;
			return Ok(if reader.check_input_available() {
				ReadResult::InputReady
			} else {
				ReadResult::InputNotReady
			});
		}

		// Configure and perform the read.
		let config = LineReaderConfig { delimiter, char_limit, process_escapes: !self.raw_mode };

		read_line_with_reader(&mut reader, &config, &is_cancelled)
	}

	fn setup_terminal_settings(
		&self,
		file: &brush_core::openfiles::OpenFile,
	) -> Result<Option<brush_core::terminal::AutoModeGuard>, brush_core::Error> {
		let mode = brush_core::terminal::AutoModeGuard::new(file.to_owned()).ok();
		if let Some(mode) = &mode {
			let config = brush_core::terminal::Settings::builder()
				.line_input(false)
				.interrupt_signals(false)
				.echo_input(!self.silent)
				.build();

			mode.apply_settings(&config)?;
		}

		Ok(mode)
	}

	/// Validates the timeout value and returns an error result if invalid.
	///
	/// Returns `Ok(Some(result))` if the timeout is invalid (caller should
	/// return early), `Ok(None)` if the timeout is valid or not specified.
	///
	/// TODO(read): Bash uses $TMOUT as a default timeout for `read` when -t is
	/// not specified.
	fn validate_timeout(
		&self,
		context: &brush_core::ExecutionContext<'_, impl brush_core::ShellExtensions>,
	) -> Result<Option<brush_core::ExecutionResult>, brush_core::Error> {
		if let Some(timeout) = self.timeout_in_seconds {
			if timeout < 0.0 {
				writeln!(
					context.stderr(),
					"{}: -t: invalid timeout specification",
					context.command_name
				)?;
				return Ok(Some(brush_core::ExecutionResult::general_error()));
			}
		}
		Ok(None)
	}
}

/// Splits a line by IFS (Internal Field Separator) according to shell rules.
///
/// Shell IFS splitting has special rules:
/// - Whitespace IFS chars (space, tab, newline) are "IFS whitespace"
/// - Leading/trailing IFS whitespace is trimmed from the input
/// - Consecutive IFS whitespace chars act as a single delimiter
/// - Non-whitespace IFS chars each act as individual delimiters
/// - Trailing non-whitespace delimiter does NOT create an empty final field
///
/// # Arguments
/// * `ifs` - The IFS string (typically " \t\n")
/// * `line` - The input line to split
/// * `max_fields` - Optional limit on number of fields (for `read var1 var2`)
fn split_line_by_ifs(ifs: &str, line: &str, max_fields: Option<usize>) -> VecDeque<String> {
	let ifs_chars: Vec<char> = ifs.chars().collect();

	// Helper to check if a char is IFS whitespace (space, tab, or newline AND in
	// IFS).
	let is_ifs_whitespace =
		|c: char| -> bool { (c == ' ' || c == '\t' || c == '\n') && ifs_chars.contains(&c) };

	// Trim leading/trailing IFS whitespace from the input.
	let trimmed_line = line.trim_matches(&is_ifs_whitespace);
	if trimmed_line.is_empty() {
		return VecDeque::new();
	}

	let max_fields = max_fields.unwrap_or(usize::MAX);

	// State machine for splitting:
	// - `consuming_whitespace_run`: Currently skipping consecutive IFS whitespace
	// - `prev_was_non_ws_delim`: Previous char was a non-whitespace delimiter
	// - `collecting_remainder`: We've hit max_fields, collect everything into last
	//   field
	let mut fields = VecDeque::new();
	let mut current_field = String::new();
	let mut consuming_whitespace_run = false;
	let mut prev_was_non_ws_delim = false;
	let mut collecting_remainder = false;

	for c in trimmed_line.chars() {
		// Skip consecutive IFS whitespace (they act as single delimiter).
		if consuming_whitespace_run && is_ifs_whitespace(c) {
			continue;
		}
		consuming_whitespace_run = false;

		let is_delimiter = ifs_chars.contains(&c);
		let at_field_limit = fields.len() + 1 >= max_fields;

		if !at_field_limit && is_delimiter {
			// Normal case: delimiter ends current field, start new one.
			fields.push_back(std::mem::take(&mut current_field));
			consuming_whitespace_run = is_ifs_whitespace(c);
			prev_was_non_ws_delim = !consuming_whitespace_run;
		} else if at_field_limit && !collecting_remainder && is_delimiter {
			// At field limit but haven't started last field content yet.
			// Skip leading IFS whitespace for the final field.
			if is_ifs_whitespace(c) {
				consuming_whitespace_run = true;
			} else {
				// Non-whitespace delimiters at boundary: include in remainder.
				// e.g., "x::y" with IFS=":" and 2 vars gives ["x", ":y"]
				collecting_remainder = true;
				current_field.push(c);
			}
		} else {
			// Regular character: add to current field.
			collecting_remainder = at_field_limit;
			current_field.push(c);
			prev_was_non_ws_delim = false;
		}
	}

	// Finalize: push last field unless it's empty AND we ended with non-ws
	// delimiter. e.g., "a,b,c," with IFS="," gives ["a", "b", "c"], not ["a", "b",
	// "c", ""].
	if !current_field.is_empty() || !prev_was_non_ws_delim {
		fields.push_back(current_field);
	}

	fields
}

#[cfg(test)]
mod tests {
	use itertools::assert_equal;

	use super::*;

	// ==================== split_line_by_ifs tests ====================

	#[test]
	fn test_split_line_by_ifs_basic() {
		let result = split_line_by_ifs(",", "a,b,c", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_leading_or_trailing_space() {
		let result = split_line_by_ifs(" ", "  a b c ", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_extra_interior_space() {
		let result = split_line_by_ifs(" ", "a  b c", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_leading_non_space_delimiter() {
		let result = split_line_by_ifs(",", ",a,b,c", None);
		assert_equal(result, VecDeque::from(vec!["", "a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_trailing_non_space_delimiter() {
		// Bash does NOT include empty trailing field when input ends with non-ws
		// delimiter.
		let result = split_line_by_ifs(",", "a,b,c,", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_split_line_by_ifs_max_fields() {
		// With max_fields=2, remainder goes into second field.
		let result = split_line_by_ifs(" ", "a b c d", Some(2));
		assert_equal(result, VecDeque::from(vec!["a", "b c d"]));
	}

	#[test]
	fn test_split_line_by_ifs_max_fields_with_non_ws_delimiter() {
		// With max_fields and non-whitespace delimiter.
		let result = split_line_by_ifs(",", "a,b,c,d", Some(2));
		assert_equal(result, VecDeque::from(vec!["a", "b,c,d"]));
	}

	#[test]
	fn test_split_line_by_ifs_consecutive_delimiters_at_boundary() {
		// Consecutive non-whitespace delimiters at field boundary should be preserved.
		// e.g., "x::y" with IFS=":" and 2 vars gives ["x", ":y"]
		let result = split_line_by_ifs(":", "x::y", Some(2));
		assert_equal(result, VecDeque::from(vec!["x", ":y"]));

		// Triple delimiter at boundary.
		let result = split_line_by_ifs(":", "x:::y", Some(2));
		assert_equal(result, VecDeque::from(vec!["x", "::y"]));

		// Delimiter in middle of remainder is also preserved.
		let result = split_line_by_ifs(":", "x:y:z:w", Some(2));
		assert_equal(result, VecDeque::from(vec!["x", "y:z:w"]));
	}

	#[test]
	fn test_split_line_by_ifs_mixed_delimiters() {
		// Mixed whitespace and non-whitespace in IFS.
		let result = split_line_by_ifs(": ", "a:b  c:d", None);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c", "d"]));
	}

	#[test]
	fn test_split_line_by_ifs_empty_input() {
		let result = split_line_by_ifs(" ", "", None);
		assert_equal(result, VecDeque::<String>::new());
	}

	#[test]
	fn test_split_line_by_ifs_whitespace_only() {
		let result = split_line_by_ifs(" ", "   ", None);
		assert_equal(result, VecDeque::<String>::new());
	}

	#[test]
	fn test_split_line_by_ifs_consecutive_non_ws_delimiters() {
		// Consecutive non-whitespace delimiters create empty fields.
		let result = split_line_by_ifs(",", "a,,b", None);
		assert_equal(result, VecDeque::from(vec!["a", "", "b"]));
	}

	// ==================== build_array_fields tests ====================

	#[test]
	fn test_build_array_fields_basic() {
		let result = build_array_fields(Some("a b c"), " ", false);
		assert_eq!(result, vec![
			(None, "a".to_string()),
			(None, "b".to_string()),
			(None, "c".to_string())
		]);
	}

	#[test]
	fn test_build_array_fields_skip_splitting() {
		// With -N option, entire input goes as single element.
		let result = build_array_fields(Some("a b c"), " ", true);
		assert_eq!(result, vec![(None, "a b c".to_string())]);
	}

	#[test]
	fn test_build_array_fields_none_input() {
		let result = build_array_fields(None, " ", false);
		assert!(result.is_empty());
	}

	// ==================== build_variable_fields tests ====================

	#[test]
	fn test_build_variable_fields_basic() {
		let result = build_variable_fields(Some("a b c"), " ", false, 3);
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[test]
	fn test_build_variable_fields_fewer_vars_than_fields() {
		// Last variable gets remainder.
		let result = build_variable_fields(Some("a b c d"), " ", false, 2);
		assert_equal(result, VecDeque::from(vec!["a", "b c d"]));
	}

	#[test]
	fn test_build_variable_fields_skip_splitting() {
		// With -N option, entire input goes to first variable.
		let result = build_variable_fields(Some("a b c"), " ", true, 3);
		assert_equal(result, VecDeque::from(vec!["a b c"]));
	}

	#[test]
	fn test_build_variable_fields_none_input() {
		let result = build_variable_fields(None, " ", false, 3);
		assert!(result.is_empty());
	}

	fn test_command() -> ReadCommand {
		ReadCommand {
			array_variable: None,
			delimiter: None,
			use_readline: false,
			initial_text: None,
			return_after_n_chars: None,
			return_after_n_chars_no_delimiter: None,
			prompt: None,
			raw_mode: false,
			silent: false,
			timeout_in_seconds: None,
			fd_num_to_read: None,
			variable_names: Vec::new(),
		}
	}

	#[test]
	fn test_ensure_not_cancelled_returns_interrupted() {
		let is_cancelled = || true;

		let err = ensure_not_cancelled(&is_cancelled)
			.expect_err("cancelled state must interrupt read builtin");
		assert_eq!(err.to_string(), "interrupted");
	}

	#[cfg(unix)]
	#[test]
	fn test_read_line_returns_interrupted_when_cancelled_before_input() {
		let command = test_command();
		let (reader, _writer) = std::io::pipe().expect("pipe creation must succeed");
		let input_file = brush_core::openfiles::OpenFile::from(reader);

		let err = command
			.read_line(input_file, Vec::<u8>::new(), None, || true)
			.expect_err("cancelled state must interrupt read builtin");
		assert_eq!(err.to_string(), "interrupted");
	}
}
