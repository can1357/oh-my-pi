use std::{
	collections::VecDeque,
	io::Write,
	time::{Duration, Instant},
};

use brush_core::{ErrorKind, builtins, env, error, openfiles::OpenFile, variables};
use clap::Parser;

use crate::line_input::{CTRL_C, CTRL_D, LineInput, ReadAhead, decode_line, decode_line_in_strides};

/// Exit code returned when `read` times out.
/// This is 128 + SIGALRM (14) = 142, matching bash behavior.
const TIMEOUT_EXIT_CODE: u8 = 142;

/// Backslash character used for escape processing.
const BACKSLASH: u8 = b'\\';
/// Default line delimiter (newline).
const DEFAULT_DELIMITER: u8 = b'\n';
/// NUL character used as delimiter when `-d ''` is specified.
const NUL_DELIMITER: u8 = b'\0';

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

		// Keep the runtime worker free for process-substitution producers.
		let cancel_token = context.cancel_token();
		let read_result = self
			.read_line(
				input_stream,
				context.stderr(),
				timeout,
				move || cancel_token.as_ref().is_some_and(|token| token.is_cancelled()),
				&context.params,
			)
			.await?;

		// Determine whether to skip IFS splitting (for -N option).
		let skip_ifs_splitting = self.return_after_n_chars_no_delimiter.is_some();

		// Extract the input line and determine exit code based on result. The
		// line is borrowed out of the result rather than cloned out of it: the
		// clone that stood here copied a line that can be any length in one
		// step, ahead of the divided copy the assignment itself makes.
		let (input_line, result) = match &read_result {
			ReadResult::Line(line) => (Some(line.as_str()), brush_core::ExecutionResult::success()),
			ReadResult::Eof(Some(line)) => {
				(Some(line.as_str()), brush_core::ExecutionResult::general_error())
			},
			ReadResult::Eof(None) | ReadResult::Interrupted | ReadResult::InputNotReady => {
				(None, brush_core::ExecutionResult::general_error())
			},
			ReadResult::TimedOut(partial) => {
				(partial.as_deref(), brush_core::ExecutionResult::new(TIMEOUT_EXIT_CODE))
			},
			ReadResult::InputReady => (None, brush_core::ExecutionResult::success()),
		};

		// Assign input to variables based on options.
		assign_input_to_variables(
			context.shell,
			input_line,
			&ifs,
			skip_ifs_splitting,
			self.array_variable.as_deref(),
			&self.variable_names,
			&context.params,
		)
		.await?;

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
async fn assign_input_to_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	array_variable: Option<&str>,
	variable_names: &[String],
	params: &brush_core::ExecutionParameters,
) -> Result<(), brush_core::Error> {
	// A variable with the integer attribute takes each value's arithmetic
	// value, as Bash gives it: `declare -i n; read n <<< 2+3` leaves `5`.
	if let Some(array_variable) = array_variable {
		let literal_fields = build_array_fields(input_line, ifs, skip_ifs_splitting, params).await?;
		let mut literal = variables::ArrayLiteral(literal_fields);
		if shell.env().get(array_variable).is_some_and(|(_, var)| var.is_treated_as_integer()) {
			literal = literal.evaluate_elements(shell, params, None, true).await?;
		}
		shell
			.env_mut()
			.update_or_add(
				array_variable,
				variables::ShellValueLiteral::Array(literal),
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
				params,
			)
			.await?;
	} else if !variable_names.is_empty() {
		assign_to_named_variables(shell, input_line, ifs, skip_ifs_splitting, variable_names, params)
			.await?;
	} else {
		// A line read from anywhere can be any size, and this caller has the
		// execution parameters: both the copy of the borrowed line and the
		// assignment it feeds are divided. Dividing only the write would
		// leave the `to_owned` holding the worker for the whole line.
		let reply = brush_core::clone_in_strides(
			params,
			input_line.unwrap_or_default(),
		)
		.await?;
		let reply = variables::value_for_variable(shell, params, "REPLY", reply).await?;
		shell
			.env_mut()
			.update_or_add(
				"REPLY",
				variables::ShellValueLiteral::Scalar(reply),
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
				params,
			)
			.await?;
	}
	Ok(())
}

/// Assigns split fields to named variables.
///
/// Fields are assigned one per variable, with any remaining fields joined by
/// space and assigned to the last variable. If there are more variables than
/// fields, the extra variables are set to empty strings.
async fn assign_to_named_variables(
	shell: &mut brush_core::Shell<impl brush_core::ShellExtensions>,
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	variable_names: &[String],
	params: &brush_core::ExecutionParameters,
) -> Result<(), brush_core::Error> {
	let mut fields =
		build_variable_fields(input_line, ifs, skip_ifs_splitting, variable_names.len(), params)
			.await?;

	for (i, name) in variable_names.iter().enumerate() {
		let is_last = i == variable_names.len() - 1;

		let value = if fields.is_empty() {
			String::new()
		} else if is_last {
			// Last variable gets all remaining fields joined by space. A line
			// with no delimiter in it is one field as long as the line, and
			// `join` builds the joined value in one step, so the join is
			// divided instead.
			join_fields_in_strides(params, std::mem::take(&mut fields)).await?
		} else {
			fields.pop_front().unwrap_or_default()
		};

		let value = variables::value_for_variable(shell, params, name, value).await?;
		shell
			.env_mut()
			.update_or_add(
				name,
				variables::ShellValueLiteral::Scalar(value),
				|_| Ok(()),
				env::EnvironmentLookup::Anywhere,
				env::EnvironmentScope::Global,
				params,
			)
			.await?;

		if is_last {
			break;
		}
	}
	Ok(())
}

/// Joins the fields left for the last variable with a space between them.
///
/// Both the walk over the fields and the bytes it copies are charged: a line
/// splits into as many fields as it has characters, and a single field can be
/// as long as the line, so neither a step count nor a byte count alone says
/// what the join costs.
async fn join_fields_in_strides(
	params: &brush_core::ExecutionParameters,
	fields: VecDeque<String>,
) -> Result<String, brush_core::Error> {
	let mut budget = brush_core::ElementBudget::new();

	// The joined value is reserved in full first: letting it grow doubles the
	// buffer, and the last of those doublings copies half the line in a step
	// nothing can interrupt. Measuring the lengths moves nothing, so the walk
	// is charged for its steps alone.
	let mut capacity = fields.len().saturating_sub(1);
	for field in &fields {
		let due = budget.charge(0);
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}
		capacity += field.len();
	}

	let mut joined = String::with_capacity(capacity);
	for (index, field) in fields.into_iter().enumerate() {
		let due = budget.charge(field.len());
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}
		if index > 0 {
			joined.push(' ');
		}
		if field.len() > brush_core::DIVIDE_COPY_ABOVE_BYTES {
			brush_core::push_str_in_strides(params, &mut joined, &field).await?;
		} else {
			joined.push_str(&field);
		}
	}

	Ok(joined)
}

/// Builds array field values from input, optionally splitting by IFS.
async fn build_array_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	params: &brush_core::ExecutionParameters,
) -> Result<Vec<(Option<String>, String)>, brush_core::Error> {
	Ok(match input_line {
		Some(line) if skip_ifs_splitting => {
			// With -N, don't split - put entire input as single element. The
			// element is the whole line, so its copy is divided; `-N` with a
			// 64 MiB count was measured holding the worker here, in the
			// construction, with the assignment already divided.
			vec![(None, brush_core::clone_in_strides(params, line).await?)]
		},
		Some(line) => {
			let fields = split_line_by_ifs(ifs, line, None /* max_fields */, params).await?;
			// The fields are moved rather than copied, but there is one step
			// per field and a line splits into as many fields as it has
			// characters, so the walk is charged for its steps.
			let mut literal_fields = Vec::with_capacity(fields.len());
			let mut budget = brush_core::ElementBudget::new();
			for field in fields {
				let due = budget.charge(0);
				if due > 0 {
					brush_core::loop_checkpoints(params, due).await?;
				}
				literal_fields.push((None, field));
			}
			literal_fields
		},
		None => vec![],
	})
}

/// Builds field values from input for assignment to named variables.
async fn build_variable_fields(
	input_line: Option<&str>,
	ifs: &str,
	skip_ifs_splitting: bool,
	num_variables: usize,
	params: &brush_core::ExecutionParameters,
) -> Result<VecDeque<String>, brush_core::Error> {
	Ok(match input_line {
		Some(line) if skip_ifs_splitting => {
			// With -N, don't split - put entire input in first variable. The
			// field is the whole line, so its copy is divided.
			let mut fields = VecDeque::new();
			fields.push_back(brush_core::clone_in_strides(params, line).await?);
			fields
		},
		Some(line) => split_line_by_ifs(ifs, line, Some(num_variables), params).await?,
		None => VecDeque::new(),
	})
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

/// Low-level input reader that handles timeouts and control characters.
///
/// This separates the concerns of byte-level I/O with timeout handling
/// from the higher-level logic of line building and escape processing.
struct InputReader {
	/// The input source: a regular file is read ahead, and what lies past
	/// the line is given back when `read` returns.
	source:     LineInput,
	/// Optional deadline for timeout.
	deadline:   Option<Instant>,
	/// Terminal input: Ctrl-C and Ctrl-D bytes are keys, not data.
	terminal:   bool,
	/// Bytes a stream reported ready, readable without waiting for input.
	ready:      u64,
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
	/// A data byte was read.
	Byte(u8),
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
		input: OpenFile,
		timeout: Option<Duration>,
		term_mode: Option<brush_core::terminal::AutoModeGuard>,
	) -> Self {
		let terminal = input.is_terminal();
		Self {
			source: LineInput::new(input, ReadAhead::Seekable),
			deadline: timeout.map(|t| Instant::now() + t),
			terminal,
			ready: 0,
			_term_mode: term_mode,
		}
	}

	/// Checks if input is immediately available (for `-t 0`). Returns `false` if
	/// an error occurs while checking for available input.
	fn check_input_available(&self) -> bool {
		brush_core::sys::poll::poll_for_input(self.source.input(), Duration::ZERO).unwrap_or(false)
	}

	#[cfg(unix)]
	fn wait_for_input<F>(&self, is_cancelled: &F) -> Result<Option<InputEvent>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		const INPUT_POLL_INTERVAL_MS: u64 = 100;

		if self.deadline.is_none() && self.source.input().try_borrow_as_fd().is_err() {
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

			match brush_core::sys::poll::poll_for_input(self.source.input(), timeout) {
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

			match brush_core::sys::poll::poll_for_input(self.source.input(), remaining) {
				Ok(true) => {},
				Ok(false) => return Ok(Some(InputEvent::Timeout)),
				Err(e) => return Err(e.into()),
			}
		}

		Ok(None)
	}

	/// Bytes readable from a stream right now without blocking; at least 1
	/// once the stream polled readable (an EOF reports 0 ready but must
	/// still be read to be seen).
	fn bytes_ready(&self) -> u64 {
		#[cfg(unix)]
		let ready = self
			.source
			.input()
			.try_borrow_as_fd()
			.ok()
			.and_then(|fd| rustix::io::ioctl_fionread(fd).ok())
			.unwrap_or(0);
		#[cfg(not(unix))]
		let ready = 0;
		ready.max(1)
	}

	/// Reads the next input event, handling timeout and control characters.
	fn read_event<F>(&mut self, is_cancelled: &F) -> Result<InputEvent, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		if !self.source.reads_ahead() {
			if self.ready == 0 {
				if let Some(event) = self.wait_for_input(is_cancelled)? {
					return Ok(event);
				}
				// Once a stream polls readable, learn how much is buffered so
				// the bytes after this one skip the poll (and the descriptor
				// classification it repeats) entirely.
				self.ready = self.bytes_ready();
			} else if self.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
				return Ok(InputEvent::Timeout);
			}
			self.ready -= 1;
		}
		ensure_not_cancelled(is_cancelled)?;
		let Some(byte) = self.source.next_byte()? else {
			self.ready = 0;
			return Ok(InputEvent::Eof);
		};

		// Control keys only mean something on a terminal; in a file or pipe
		// they are data.
		Ok(match byte {
			CTRL_C if self.terminal => InputEvent::CtrlC,
			CTRL_D if self.terminal => InputEvent::CtrlD,
			_ => InputEvent::Byte(byte),
		})
	}
}

/// Configuration for line reading behavior.
struct LineReaderConfig {
	/// Byte that terminates input (None for -N mode).
	delimiter:       Option<u8>,
	/// Maximum characters to read (for -n or -N).
	char_limit:      Option<usize>,
	/// Whether to process backslash escapes (false for -r mode).
	process_escapes: bool,
}

/// Characters read toward a `-n`/`-N` limit. Bash counts characters, not
/// bytes: a UTF-8 lead byte starts one, and the limit is reached only once
/// its continuation bytes are in, so a multibyte character is never split.
#[derive(Default)]
struct CharCount {
	chars:        usize,
	continuation: u8,
}

impl CharCount {
	fn push(&mut self, byte: u8) {
		if self.continuation > 0 && byte & 0xC0 == 0x80 {
			self.continuation -= 1;
		} else {
			self.chars += 1;
			self.continuation = match byte {
				0xC0..=0xDF => 1,
				0xE0..=0xEF => 2,
				0xF0..=0xF7 => 3,
				_ => 0,
			};
		}
	}

	fn reached(&self, limit: Option<usize>) -> bool {
		self.continuation == 0 && limit.is_some_and(|limit| self.chars >= limit)
	}
}

/// Why a read ended, with the line's bytes as they were read.
///
/// Decoding is the caller's: a read offloaded to a blocking worker decodes
/// there, in one step, and a read made on a runtime worker decodes a stride at
/// a time.
enum RawResult {
	/// A complete line (delimiter or char limit reached).
	Line(Vec<u8>),
	/// End of input, with any partial content read before it.
	Eof(Option<Vec<u8>>),
	/// The read timed out, with any partial content read before it.
	TimedOut(Option<Vec<u8>>),
	/// Ctrl+C was pressed.
	Interrupted,
}

impl RawResult {
	/// Decodes the line in one step, for a caller that holds no runtime
	/// worker.
	fn decode(self) -> ReadResult {
		match self {
			Self::Line(line) => ReadResult::Line(decode_line(line)),
			Self::Eof(line) => ReadResult::Eof(line.map(decode_line)),
			Self::TimedOut(line) => ReadResult::TimedOut(line.map(decode_line)),
			Self::Interrupted => ReadResult::Interrupted,
		}
	}

	/// Decodes the line a stride at a time, for a caller on a runtime worker.
	async fn decode_in_strides(
		self,
		params: &brush_core::ExecutionParameters,
	) -> Result<ReadResult, brush_core::Error> {
		Ok(match self {
			Self::Line(line) => ReadResult::Line(decode_line_in_strides(params, line).await?),
			Self::Eof(Some(line)) => {
				ReadResult::Eof(Some(decode_line_in_strides(params, line).await?))
			},
			Self::TimedOut(Some(line)) => {
				ReadResult::TimedOut(Some(decode_line_in_strides(params, line).await?))
			},
			Self::Eof(None) => ReadResult::Eof(None),
			Self::TimedOut(None) => ReadResult::TimedOut(None),
			Self::Interrupted => ReadResult::Interrupted,
		})
	}
}

/// A line as it is being read, kept outside the read loop so that a read can
/// stop after a stride of input and resume where it left off.
#[derive(Default)]
struct LineAccumulator {
	/// The bytes of the line so far.
	line:              Vec<u8>,
	/// Characters read toward a `-n`/`-N` limit.
	count:             CharCount,
	/// A backslash read but not yet applied to the byte after it.
	pending_backslash: bool,
}

impl LineAccumulator {
	/// Reads until the line ends or `budget` input events have been taken,
	/// whichever comes first.
	///
	/// `None` means the budget ran out with the line unfinished; the state to
	/// carry on with is in `self`.
	fn fill<F>(
		&mut self,
		reader: &mut InputReader,
		config: &LineReaderConfig,
		is_cancelled: &F,
		budget: usize,
	) -> Result<Option<RawResult>, brush_core::Error>
	where
		F: Fn() -> bool,
	{
		for _ in 0..budget {
			match reader.read_event(is_cancelled)? {
				InputEvent::Eof => {
					// Bash discards pending backslash on EOF.
					let line = std::mem::take(&mut self.line);
					return Ok(Some(RawResult::Eof((!line.is_empty()).then_some(line))));
				},

				InputEvent::Timeout => {
					// Include pending backslash on timeout (different from EOF).
					if self.pending_backslash {
						self.line.push(BACKSLASH);
					}
					let line = std::mem::take(&mut self.line);
					return Ok(Some(RawResult::TimedOut((!line.is_empty()).then_some(line))));
				},

				InputEvent::CtrlC => {
					return Ok(Some(RawResult::Interrupted));
				},

				InputEvent::CtrlD => {
					// At line start = EOF, mid-input = flush current input.
					// Bash discards pending backslash here too.
					return Ok(Some(if self.line.is_empty() && !self.pending_backslash {
						RawResult::Eof(None)
					} else {
						RawResult::Line(std::mem::take(&mut self.line))
					}));
				},

				InputEvent::Byte(byte) => {
					if let Some(result) = self.take_byte(config, byte) {
						return Ok(Some(result));
					}
				},
			}
		}

		Ok(None)
	}

	/// Takes one data byte, returning the line if it ends there.
	fn take_byte(&mut self, config: &LineReaderConfig, byte: u8) -> Option<RawResult> {
		// Handle backslash escape processing (when enabled).
		if config.process_escapes {
			if self.pending_backslash {
				self.pending_backslash = false;

				// Backslash-delimiter is line continuation.
				if config.delimiter == Some(byte) {
					return None; // Line continuation.
				}

				// For other bytes, add the byte literally (backslash consumed).
				self.line.push(byte);
				self.count.push(byte);

				// Check character limit (based on output length).
				if self.count.reached(config.char_limit) {
					return Some(RawResult::Line(std::mem::take(&mut self.line)));
				}
				return None;
			}

			if byte == BACKSLASH {
				self.pending_backslash = true;
				return None;
			}
		}

		// Check for delimiter.
		if config.delimiter == Some(byte) {
			return Some(RawResult::Line(std::mem::take(&mut self.line)));
		}

		// Ignore non-whitespace control characters.
		if byte.is_ascii_control() && !byte.is_ascii_whitespace() {
			return None;
		}

		self.line.push(byte);
		self.count.push(byte);

		// Check character limit (based on output length).
		if self.count.reached(config.char_limit) {
			return Some(RawResult::Line(std::mem::take(&mut self.line)));
		}

		None
	}
}

/// Reads a complete line of input using the given reader and configuration.
///
/// Returns a `RawResult` indicating success, EOF, timeout, or interruption.
/// The read runs to the end of the line in one step, so only a caller that
/// holds no runtime worker may use it; everyone else uses
/// [`read_line_divided`].
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
) -> Result<RawResult, brush_core::Error>
where
	F: Fn() -> bool,
{
	let mut line = LineAccumulator::default();
	loop {
		if let Some(result) = line.fill(reader, config, is_cancelled, usize::MAX)? {
			return Ok(result);
		}
	}
}

/// [`read_line_with_reader`] for a caller on a runtime worker: the same read,
/// a stride of input at a time, with a checkpoint before each stride.
///
/// Taking a byte at a time out of a block that is already in memory is work as
/// long as the input, and nothing in it ever awaits: a `read -r` of a 64 MiB
/// line was measured holding the worker for 288 ms, with the assignment it
/// feeds already divided.
async fn read_line_divided<F>(
	reader: &mut InputReader,
	config: &LineReaderConfig,
	is_cancelled: &F,
	params: &brush_core::ExecutionParameters,
) -> Result<RawResult, brush_core::Error>
where
	F: Fn() -> bool,
{
	let mut line = LineAccumulator::default();
	let mut budget = brush_core::ElementBudget::new();
	loop {
		let due = budget.charge(brush_core::DIVIDE_COPY_ABOVE_BYTES);
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}
		if let Some(result) =
			line.fill(reader, config, is_cancelled, brush_core::DIVIDE_COPY_ABOVE_BYTES)?
		{
			return Ok(result);
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
	async fn read_line<F>(
		&self,
		input_file: brush_core::openfiles::OpenFile,
		mut stderr_file: impl std::io::Write,
		timeout: Option<Duration>,
		is_cancelled: F,
		params: &brush_core::ExecutionParameters,
	) -> Result<ReadResult, brush_core::Error>
	where
		F: Fn() -> bool + Send + 'static,
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

		// Determine delimiter based on options. Input is matched byte by byte,
		// so a multi-byte `-d` delimiter splits at its first byte.
		let delimiter = if self.return_after_n_chars_no_delimiter.is_some() {
			None
		} else if let Some(delimiter_str) = &self.delimiter {
			Some(delimiter_str.as_bytes().first().copied().unwrap_or(NUL_DELIMITER))
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

		#[cfg(target_family = "wasm")]
		{
			// Threadless Wasm cannot spawn blocking workers, so the read and
			// the decode of what it read are divided in place.
			read_line_divided(&mut reader, &config, &is_cancelled, params)
				.await?
				.decode_in_strides(params)
				.await
		}
		#[cfg(not(target_family = "wasm"))]
		{
			// Seekable input cannot depend on a producer queued on this runtime.
			// A builtin already on a blocking worker (an owned-shell pipeline stage
			// or async job) leaves the runtime workers free for that producer, and
			// offloading again would hold this worker while queueing another one.
			if reader.source.reads_ahead() || brush_core::commands::builtin_on_blocking_worker() {
				return read_line_divided(&mut reader, &config, &is_cancelled, params)
					.await?
					.decode_in_strides(params)
					.await;
			}
			// The blocking worker decodes what it read as well: that walk over
			// the line's bytes is as long as the read, and it is not the
			// runtime's to take in one step.
			tokio::task::spawn_blocking(move || {
				read_line_with_reader(&mut reader, &config, &is_cancelled).map(RawResult::decode)
			})
			.await
			.map_err(ErrorKind::ThreadingError)?
		}
	}

	fn setup_terminal_settings(
		&self,
		file: &brush_core::openfiles::OpenFile,
	) -> Result<Option<brush_core::terminal::AutoModeGuard>, brush_core::Error> {
		// The guard dups the descriptor and reads its terminal attributes; a
		// pipe or file has none, so skip it in every `while read` iteration.
		if !file.is_terminal() {
			return Ok(None);
		}
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

/// Whether `c` is IFS whitespace: a space, tab or newline that is also in IFS.
fn is_ifs_whitespace(c: char, ifs_chars: &[char]) -> bool {
	(c == ' ' || c == '\t' || c == '\n') && ifs_chars.contains(&c)
}

/// Trims leading and trailing IFS whitespace, a stride of the line at a time.
///
/// `str::trim_matches` walks the line in one step, and a line is whatever the
/// descriptor held: a 64 MiB line of spaces is a 64 MiB walk before the split
/// has begun.
async fn trim_ifs_whitespace<'a>(
	params: &brush_core::ExecutionParameters,
	line: &'a str,
	ifs_chars: &[char],
) -> Result<&'a str, brush_core::Error> {
	let mut budget = brush_core::ElementBudget::new();
	let mut trimmed = line;

	while let Some(c) = trimmed.chars().next() {
		if !is_ifs_whitespace(c, ifs_chars) {
			break;
		}
		// A step also scans IFS once, so IFS's length is charged with the
		// character's: `IFS` is a variable and can itself be long.
		let due = budget.charge(c.len_utf8() + ifs_chars.len());
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}
		trimmed = &trimmed[c.len_utf8()..];
	}

	while let Some(c) = trimmed.chars().next_back() {
		if !is_ifs_whitespace(c, ifs_chars) {
			break;
		}
		let due = budget.charge(c.len_utf8() + ifs_chars.len());
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}
		trimmed = &trimmed[..trimmed.len() - c.len_utf8()];
	}

	Ok(trimmed)
}

/// Puts one field, cut out of the line, on the end of `fields`.
///
/// The copy is charged by the bytes it moves, and a field longer than a
/// stride — a line with no delimiter in it is a single field as long as the
/// line — is copied a stride at a time. Below a stride the plain copy is
/// taken, because an `async` call on each of a million one-character fields
/// costs more than the checkpoints it would spend.
async fn push_field(
	params: &brush_core::ExecutionParameters,
	fields: &mut VecDeque<String>,
	budget: &mut brush_core::ElementBudget,
	field: &str,
) -> Result<(), brush_core::Error> {
	let due = budget.charge(field.len());
	if due > 0 {
		brush_core::loop_checkpoints(params, due).await?;
	}
	fields.push_back(if field.len() > brush_core::DIVIDE_COPY_ABOVE_BYTES {
		brush_core::clone_in_strides(params, field).await?
	} else {
		field.to_owned()
	});
	Ok(())
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
/// The walk is as long as the line and every field cut out of it is a copy, so
/// both are charged: `read -r result` over a 64 MiB line was measured holding
/// the worker for 450 ms with the assignment to `result` already divided, and
/// this is where that line is taken apart.
///
/// # Arguments
/// * `ifs` - The IFS string (typically " \t\n")
/// * `line` - The input line to split
/// * `max_fields` - Optional limit on number of fields (for `read var1 var2`)
/// * `params` - Execution parameters, for the checkpoints the walk spends
async fn split_line_by_ifs(
	ifs: &str,
	line: &str,
	max_fields: Option<usize>,
	params: &brush_core::ExecutionParameters,
) -> Result<VecDeque<String>, brush_core::Error> {
	let ifs_chars: Vec<char> = ifs.chars().collect();

	// Trim leading/trailing IFS whitespace from the input.
	let trimmed_line = trim_ifs_whitespace(params, line, &ifs_chars).await?;
	if trimmed_line.is_empty() {
		return Ok(VecDeque::new());
	}

	let max_fields = max_fields.unwrap_or(usize::MAX);

	// State machine for splitting:
	// - `consuming_whitespace_run`: Currently skipping consecutive IFS whitespace
	// - `prev_was_non_ws_delim`: Previous char was a non-whitespace delimiter
	// - `collecting_remainder`: We've hit max_fields, collect everything into last
	//   field
	//
	// A field is always a run of the line, so it is held as the bounds of that
	// run and cut out when it ends. Building it a character at a time grew its
	// buffer by doubling, and the last doubling of a field as long as the line
	// copies half of it in a step nothing can interrupt.
	let mut fields = VecDeque::new();
	let mut field_start = 0;
	let mut field_end = 0;
	let mut consuming_whitespace_run = false;
	let mut prev_was_non_ws_delim = false;
	let mut collecting_remainder = false;
	let mut budget = brush_core::ElementBudget::new();

	for (index, c) in trimmed_line.char_indices() {
		// The walk is one step per character and as many bytes as the line, so
		// it is charged by both, and by the scan of IFS each step makes: a
		// long `IFS` makes a step as long as IFS itself.
		let due = budget.charge(c.len_utf8() + ifs_chars.len());
		if due > 0 {
			brush_core::loop_checkpoints(params, due).await?;
		}

		// Skip consecutive IFS whitespace (they act as single delimiter).
		if consuming_whitespace_run && is_ifs_whitespace(c, &ifs_chars) {
			continue;
		}
		consuming_whitespace_run = false;

		let is_delimiter = ifs_chars.contains(&c);
		let at_field_limit = fields.len() + 1 >= max_fields;

		if !at_field_limit && is_delimiter {
			// Normal case: delimiter ends current field, start new one.
			let field = &trimmed_line[field_start..field_end];
			push_field(params, &mut fields, &mut budget, field).await?;
			field_start = index + c.len_utf8();
			field_end = field_start;
			consuming_whitespace_run = is_ifs_whitespace(c, &ifs_chars);
			prev_was_non_ws_delim = !consuming_whitespace_run;
		} else if at_field_limit && !collecting_remainder && is_delimiter {
			// At field limit but haven't started last field content yet.
			// Skip leading IFS whitespace for the final field.
			if is_ifs_whitespace(c, &ifs_chars) {
				consuming_whitespace_run = true;
				field_start = index + c.len_utf8();
				field_end = field_start;
			} else {
				// Non-whitespace delimiters at boundary: include in remainder.
				// e.g., "x::y" with IFS=":" and 2 vars gives ["x", ":y"]
				collecting_remainder = true;
				field_start = index;
				field_end = index + c.len_utf8();
			}
		} else {
			// Regular character: add to current field.
			collecting_remainder = at_field_limit;
			if field_end == field_start {
				field_start = index;
			}
			field_end = index + c.len_utf8();
			prev_was_non_ws_delim = false;
		}
	}

	// Finalize: push last field unless it's empty AND we ended with non-ws
	// delimiter. e.g., "a,b,c," with IFS="," gives ["a", "b", "c"], not ["a", "b",
	// "c", ""].
	let last_field = &trimmed_line[field_start..field_end];
	if !last_field.is_empty() || !prev_was_non_ws_delim {
		push_field(params, &mut fields, &mut budget, last_field).await?;
	}

	Ok(fields)
}

#[cfg(test)]
mod tests {
	use itertools::assert_equal;

	use super::*;

	// ==================== split_line_by_ifs tests ====================

	/// The parameters a divided walk spends its checkpoints against. A test
	/// has no run to cancel, so the default ones will do.
	fn test_params() -> brush_core::ExecutionParameters {
		brush_core::ExecutionParameters::default()
	}

	async fn split(ifs: &str, line: &str, max_fields: Option<usize>) -> VecDeque<String> {
		split_line_by_ifs(ifs, line, max_fields, &test_params())
			.await
			.expect("splitting an uncancelled line must succeed")
	}

	async fn array_fields(
		input_line: Option<&str>,
		ifs: &str,
		skip_ifs_splitting: bool,
	) -> Vec<(Option<String>, String)> {
		build_array_fields(input_line, ifs, skip_ifs_splitting, &test_params())
			.await
			.expect("building fields of an uncancelled line must succeed")
	}

	async fn variable_fields(
		input_line: Option<&str>,
		ifs: &str,
		skip_ifs_splitting: bool,
		num_variables: usize,
	) -> VecDeque<String> {
		build_variable_fields(input_line, ifs, skip_ifs_splitting, num_variables, &test_params())
			.await
			.expect("building fields of an uncancelled line must succeed")
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_basic() {
		let result = split(",", "a,b,c", None).await;
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_leading_or_trailing_space() {
		let result = split(" ", "  a b c ", None).await;
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_extra_interior_space() {
		let result = split(" ", "a  b c", None).await;
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_leading_non_space_delimiter() {
		let result = split(",", ",a,b,c", None).await;
		assert_equal(result, VecDeque::from(vec!["", "a", "b", "c"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_trailing_non_space_delimiter() {
		// Bash does NOT include empty trailing field when input ends with non-ws
		// delimiter.
		let result = split(",", "a,b,c,", None).await;
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_max_fields() {
		// With max_fields=2, remainder goes into second field.
		let result = split(" ", "a b c d", Some(2)).await;
		assert_equal(result, VecDeque::from(vec!["a", "b c d"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_max_fields_with_non_ws_delimiter() {
		// With max_fields and non-whitespace delimiter.
		let result = split(",", "a,b,c,d", Some(2)).await;
		assert_equal(result, VecDeque::from(vec!["a", "b,c,d"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_consecutive_delimiters_at_boundary() {
		// Consecutive non-whitespace delimiters at field boundary should be preserved.
		// e.g., "x::y" with IFS=":" and 2 vars gives ["x", ":y"]
		let result = split(":", "x::y", Some(2)).await;
		assert_equal(result, VecDeque::from(vec!["x", ":y"]));

		// Triple delimiter at boundary.
		let result = split(":", "x:::y", Some(2)).await;
		assert_equal(result, VecDeque::from(vec!["x", "::y"]));

		// Delimiter in middle of remainder is also preserved.
		let result = split(":", "x:y:z:w", Some(2)).await;
		assert_equal(result, VecDeque::from(vec!["x", "y:z:w"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_mixed_delimiters() {
		// Mixed whitespace and non-whitespace in IFS.
		let result = split(": ", "a:b  c:d", None).await;
		assert_equal(result, VecDeque::from(vec!["a", "b", "c", "d"]));
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_empty_input() {
		let result = split(" ", "", None).await;
		assert_equal(result, VecDeque::<String>::new());
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_whitespace_only() {
		let result = split(" ", "   ", None).await;
		assert_equal(result, VecDeque::<String>::new());
	}

	#[tokio::test]
	async fn test_split_line_by_ifs_consecutive_non_ws_delimiters() {
		// Consecutive non-whitespace delimiters create empty fields.
		let result = split(",", "a,,b", None).await;
		assert_equal(result, VecDeque::from(vec!["a", "", "b"]));
	}

	/// A field is cut out of the line rather than built character by
	/// character, and a field longer than a stride takes the divided copy:
	/// both paths produce the field the whole line held.
	#[tokio::test]
	async fn test_split_line_by_ifs_field_longer_than_a_stride() {
		let long = "a".repeat(brush_core::DIVIDE_COPY_ABOVE_BYTES * 2 + 7);
		let line = format!("{long} {long}");
		let result = split(" ", &line, None).await;
		assert_equal(result, VecDeque::from(vec![long.clone(), long]));
	}

	// ==================== build_array_fields tests ====================

	#[tokio::test]
	async fn test_build_array_fields_basic() {
		let result = array_fields(Some("a b c"), " ", false).await;
		assert_eq!(result, vec![
			(None, "a".to_string()),
			(None, "b".to_string()),
			(None, "c".to_string())
		]);
	}

	#[tokio::test]
	async fn test_build_array_fields_skip_splitting() {
		// With -N option, entire input goes as single element.
		let result = array_fields(Some("a b c"), " ", true).await;
		assert_eq!(result, vec![(None, "a b c".to_string())]);
	}

	#[tokio::test]
	async fn test_build_array_fields_none_input() {
		let result = array_fields(None, " ", false).await;
		assert!(result.is_empty());
	}

	// ==================== build_variable_fields tests ====================

	#[tokio::test]
	async fn test_build_variable_fields_basic() {
		let result = variable_fields(Some("a b c"), " ", false, 3).await;
		assert_equal(result, VecDeque::from(vec!["a", "b", "c"]));
	}

	#[tokio::test]
	async fn test_build_variable_fields_fewer_vars_than_fields() {
		// Last variable gets remainder.
		let result = variable_fields(Some("a b c d"), " ", false, 2).await;
		assert_equal(result, VecDeque::from(vec!["a", "b c d"]));
	}

	#[tokio::test]
	async fn test_build_variable_fields_skip_splitting() {
		// With -N option, entire input goes to first variable.
		let result = variable_fields(Some("a b c"), " ", true, 3).await;
		assert_equal(result, VecDeque::from(vec!["a b c"]));
	}

	#[tokio::test]
	async fn test_build_variable_fields_none_input() {
		let result = variable_fields(None, " ", false, 3).await;
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
	#[tokio::test]
	async fn test_read_line_returns_interrupted_when_cancelled_before_input() {
		let command = test_command();
		let (reader, _writer) = std::io::pipe().expect("pipe creation must succeed");
		let input_file = brush_core::openfiles::OpenFile::from(reader);

		let err = command
			.read_line(input_file, Vec::<u8>::new(), None, || true, &test_params())
			.await
			.expect_err("cancelled state must interrupt read builtin");
		assert_eq!(err.to_string(), "interrupted");
	}
}
