//! Execution support for shell.

use std::{io::Read, path::Path};

use crate::{
	ExecutionControlFlow, ExecutionParameters, ExecutionResult, ProcessGroupPolicy, SourceInfo,
	arithmetic::Evaluatable as _, callstack, error, interp::Execute as _, openfiles,
	trace_categories,
};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	/// Returns the default execution parameters for this shell.
	pub fn default_exec_params(&self) -> ExecutionParameters {
		let mut params = ExecutionParameters::default();

		params.process_group_policy = if self.options.enable_job_control {
			ProcessGroupPolicy::NewProcessGroup
		} else {
			ProcessGroupPolicy::SameProcessGroup
		};

		params
	}

	pub(super) async fn source_if_exists(
		&mut self,
		path: impl AsRef<Path>,
		params: &ExecutionParameters,
	) -> Result<bool, error::Error> {
		let path = path.as_ref();
		if self.filesystem.exists(self.absolute_path(path)).await {
			self
				.source_script(path, std::iter::empty::<String>(), params)
				.await?;
			Ok(true)
		} else {
			tracing::debug!("skipping non-existent file: {}", path.display());
			Ok(false)
		}
	}

	/// Source the given file as a shell script, returning the execution result.
	///
	/// # Arguments
	///
	/// * `path` - The path to the file to source.
	/// * `args` - The arguments to pass to the script as positional parameters.
	/// * `params` - Execution parameters.
	pub async fn source_script<S: Into<String>, P: AsRef<Path>, I: Iterator<Item = S>>(
		&mut self,
		path: P,
		args: I,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		self
			.parse_and_execute_script_file(
				path.as_ref(),
				args,
				params,
				callstack::ScriptCallType::Source,
			)
			.await
	}

	/// Parse and execute the given file as a shell script, returning the
	/// execution result.
	///
	/// # Arguments
	///
	/// * `path` - The path to the file to source.
	/// * `args` - The arguments to pass to the script as positional parameters.
	/// * `params` - Execution parameters.
	/// * `call_type` - The type of script call being made.
	async fn parse_and_execute_script_file<
		S: Into<String>,
		P: AsRef<Path>,
		I: Iterator<Item = S>,
	>(
		&mut self,
		path: P,
		args: I,
		params: &ExecutionParameters,
		call_type: callstack::ScriptCallType,
	) -> Result<ExecutionResult, error::Error> {
		let path = path.as_ref();
		tracing::debug!("sourcing: {}", path.display());

		let mut options = pi_vfs::OpenOptions::new();
		options.read(true);

		let mut opened_file: openfiles::OpenFile = self
			.open_file(&options, path, params)
			.await
			.map_err(|e| error::ErrorKind::FailedSourcingFile(path.to_owned(), e))?;

		if opened_file.is_dir().await {
			return Err(
				error::ErrorKind::FailedSourcingFile(
					path.to_owned(),
					std::io::Error::from(std::io::ErrorKind::IsADirectory),
				)
				.into(),
			);
		}

		let source_info = crate::SourceInfo::from(path.to_owned());

		// The parser reads synchronously; a virtual provider is awaited for the
		// whole script up front instead of blocking the runtime per read.
		let mut result = if matches!(opened_file, openfiles::OpenFile::Vfs(_)) {
			let mut script = Vec::new();
			opened_file
				.read_to_end_async(&mut script)
				.await
				.map_err(|e| error::ErrorKind::FailedSourcingFile(path.to_owned(), e))?;
			self
				.source_file(script.as_slice(), &source_info, args, params, call_type)
				.await?
		} else {
			self
				.source_file(opened_file, &source_info, args, params, call_type)
				.await?
		};

		// Handle control flow at script execution boundary. If execution completed
		// with a `return`, we need to clear it since it's already been "used". All
		// other control flow types are preserved.
		if matches!(result.next_control_flow, ExecutionControlFlow::ReturnFromFunctionOrScript) {
			result.next_control_flow = ExecutionControlFlow::Normal;
		}

		Ok(result)
	}

	/// Source the given file as a shell script, returning the execution result.
	///
	/// # Arguments
	///
	/// * `file` - The file to source.
	/// * `source_info` - Information about the source of the script.
	/// * `args` - The arguments to pass to the script as positional parameters.
	/// * `params` - Execution parameters.
	/// * `call_type` - The type of script call being made.
	async fn source_file<F: Read, S: Into<String>, I: Iterator<Item = S>>(
		&mut self,
		file: F,
		source_info: &crate::SourceInfo,
		args: I,
		params: &ExecutionParameters,
		call_type: callstack::ScriptCallType,
	) -> Result<ExecutionResult, error::Error> {
		// The parser reads the whole script; the file closes before the script
		// runs, so a nested `source` does not hold one descriptor per level.
		let (parse_result, text) = {
			let mut reader = std::io::BufReader::new(RecordingReader { inner: file, seen: Vec::new() });
			let mut parser = brush_parser::Parser::new(&mut reader, &self.parser_options());

			tracing::debug!(target: trace_categories::PARSE, "Parsing sourced file: {}", source_info.source);
			let parse_result = parser.parse_program();
			(parse_result, reader.into_inner().seen)
		};

		let script_positional_args = args.map(Into::into);

		self
			.call_stack
			.push_script(call_type, source_info, script_positional_args);

		let result = self
			.run_parsed_text(&String::from_utf8_lossy(&text), parse_result, source_info, params)
			.await;

		self.call_stack.pop();

		result
	}

	/// Executes the given string as a shell program, returning the resulting
	/// exit status.
	///
	/// # Arguments
	///
	/// * `command` - The command to execute.
	/// * `source_info` - Information about the source of the command text.
	/// * `params` - Execution parameters.
	pub async fn run_string<S: Into<String>>(
		&mut self,
		command: S,
		source_info: &crate::SourceInfo,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		let command = command.into();
		let parse_result = self.parse_string(command.as_str());
		self
			.run_parsed_text(&command, parse_result, source_info, params)
			.await
	}

	/// Runs a program parsed from `text`, then reads the rest of `text` as
	/// Bash does. Bash reads one more line when text follows the line the
	/// program's last command ends on, or when `text` holds no command but is
	/// not empty, and each line it reads reports the jobs that ended and
	/// forgets the reported ones (see
	/// [`crate::jobs::JobManager::notify_and_cleanup`]). A program that
	/// returns or exits reads nothing more.
	async fn run_parsed_text(
		&mut self,
		text: &str,
		parse_result: Result<brush_parser::ast::Program, brush_parser::ParseError>,
		source_info: &crate::SourceInfo,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		let has_command = match &parse_result {
			Ok(program) => Some(!program.complete_commands.is_empty()),
			Err(_) => None,
		};
		let result = self
			.run_parsed_result(parse_result, source_info, params)
			.await?;
		if let Some(has_command) = has_command
			&& result.is_normal_flow()
			&& if has_command { text_follows_last_command(text) } else { !text.is_empty() }
		{
			self.notify_and_cleanup_jobs(params).await;
		}
		Ok(result)
	}

	/// Executes the given command, provided to a shell executable on the command
	/// line (i.e., via `-c`).
	///
	/// It is expected that the shell will not be used for any further execution
	/// after this command; this function will perform any necessary shell exit
	/// handling.
	///
	/// # Arguments
	///
	/// * `command` - The command to execute.
	pub async fn run_dash_c_command<S: Into<String>>(
		&mut self,
		command: S,
	) -> Result<ExecutionResult, error::Error> {
		self.start_command_string_mode();

		// Execute the command string.
		let params = self.default_exec_params();
		let source_info = SourceInfo::from("-c");
		let result = self.run_string(command, &source_info, &params).await?;

		self.end_command_string_mode()?;

		// Give the shell a chance to run on-exit tasks, but ignore the result.
		let _ = self.on_exit().await;

		Ok(result)
	}

	/// Executes the given script file, returning the resulting exit status.
	///
	/// It is expected that the shell will not be used for any further execution
	/// after this command; this function will perform any necessary shell exit
	/// handling.
	///
	/// # Arguments
	///
	/// * `script_path` - The path to the script file to execute.
	/// * `args` - The arguments to pass to the script as positional parameters.
	pub async fn run_script<S: Into<String>, P: AsRef<Path>, I: Iterator<Item = S>>(
		&mut self,
		script_path: P,
		args: I,
	) -> Result<ExecutionResult, error::Error> {
		let params = self.default_exec_params();
		let result = self
			.parse_and_execute_script_file(
				script_path.as_ref(),
				args,
				&params,
				callstack::ScriptCallType::Run,
			)
			.await?;

		// Give the shell a chance to run on-exit tasks, but ignore the result.
		let _ = self.on_exit().await;

		Ok(result)
	}

	pub(crate) async fn run_parsed_result(
		&mut self,
		parse_result: Result<brush_parser::ast::Program, brush_parser::ParseError>,
		source_info: &crate::SourceInfo,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		// If parsing succeeded, run the program. If there's a parse error, it's fatal
		// (per spec).
		let result = match parse_result {
			Ok(prog) => self.run_program(prog, params).await,
			Err(parse_err) => Err(
				error::Error::from(error::ErrorKind::ParseError(parse_err, source_info.clone()))
					.into_fatal(),
			),
		};

		// Report any errors.
		match result {
			Ok(result) => Ok(result),
			Err(err) => {
				if params.reports_errors() {
					self.display_error(&mut params.stderr(self), &err).await;
				}

				let result = err.into_result(self);
				self.set_last_exit_status(result.exit_code.into());

				Ok(result)
			},
		}
	}

	/// Executes the given parsed shell program, returning the resulting exit
	/// status.
	///
	/// # Arguments
	///
	/// * `program` - The program to execute.
	/// * `params` - Execution parameters.
	pub async fn run_program(
		&mut self,
		program: brush_parser::ast::Program,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		program.execute(self, params).await
	}

	/// Evaluate the given arithmetic expression, returning the result.
	pub fn eval_arithmetic(
		&mut self,
		expr: &brush_parser::ast::ArithmeticExpr,
	) -> Result<i64, error::Error> {
		Ok(expr.eval(self)?)
	}
}

/// A reader that keeps a copy of every byte read through it, so the text of
/// a sourced file stays available after the parser has read it.
struct RecordingReader<R> {
	inner: R,
	seen:  Vec<u8>,
}

impl<R: Read> Read for RecordingReader<R> {
	fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
		let read = self.inner.read(buf)?;
		self.seen.extend_from_slice(&buf[..read]);
		Ok(read)
	}
}

/// Whether `text` holds anything after the line its last command ends on:
/// Bash reads that rest as one more input line. A comment on the last
/// command's own line is part of that line, and so are the lines of a
/// here-document the command reads.
fn text_follows_last_command(text: &str) -> bool {
	let Ok(tokens) = brush_parser::tokenize_str(text) else {
		return false;
	};
	// Where the command's text ends. A here-document body's span runs past
	// its end tag's line, newline included; the newline tokens of the
	// command's lines come after the body in token order.
	let Some(end) = tokens
		.iter()
		.filter_map(|token| match token {
			brush_parser::Token::Operator(operator, _) if operator == "\n" => None,
			brush_parser::Token::Operator(_, span) | brush_parser::Token::Word(_, span) => {
				Some(span.end.index)
			},
		})
		.max()
	else {
		return !text.is_empty();
	};
	let ends_its_line = end
		.checked_sub(1)
		.is_some_and(|last| text.chars().nth(last) == Some('\n'));
	let mut rest = text.chars().skip(end);
	if !ends_its_line && !rest.any(|character| character == '\n') {
		return false;
	}
	rest.next().is_some()
}
