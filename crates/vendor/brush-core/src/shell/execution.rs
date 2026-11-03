//! Execution support for shell.

use std::{io::Read, path::Path};

use crate::{
	ExecutionControlFlow, ExecutionParameters, ExecutionResult, ProcessGroupPolicy, SourceInfo,
	arithmetic::Evaluatable as _, callstack, error, interp, openfiles,
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
		// The shell reads the whole script first; the file closes before the
		// script runs, so a nested `source` does not hold one descriptor per
		// level.
		tracing::debug!(target: trace_categories::PARSE, "Reading sourced file: {}", source_info.source);
		let mut script = Vec::new();
		let script = std::io::BufReader::new(file)
			.read_to_end(&mut script)
			.map_err(brush_parser::TokenizerError::ReadError)
			.and_then(|_| String::from_utf8(script).map_err(|_| brush_parser::TokenizerError::FailedDecoding))
			.map_err(|inner| brush_parser::ParseError::Tokenizing { inner, position: None });

		let script_positional_args = args.map(Into::into);

		self
			.call_stack
			.push_script(call_type, source_info, script_positional_args);

		let result = match script {
			Ok(script) => self.read_and_run(script, source_info, params).await,
			Err(parse_err) => Ok(self.report_parse_error(parse_err, source_info, params).await),
		};

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
		self.read_and_run(command.into(), source_info, params).await
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

	/// Reads `input` one complete command at a time and runs each, as Bash
	/// does: a complete command is read with the aliases as the commands
	/// before it left them. The first is read with the aliases its caller read
	/// the line with, when it gave them
	/// ([`ExecutionParameters::set_aliases_at_read`]); a command after it in
	/// the same input follows a newline inside an alias's value. A syntax
	/// error is reported, and nothing after it is read.
	pub(crate) async fn read_and_run(
		&mut self,
		input: String,
		source_info: &crate::SourceInfo,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		let mut params = params.clone();
		let aliases_at_read = params.take_aliases_at_read();
		let mut reader = brush_parser::CommandReader::new(input, &self.parser_options());
		let mut result = ExecutionResult::success();
		let mut first = true;
		loop {
			let aliases = match &aliases_at_read {
				Some(at_read) => at_read.table_for_command(first, self.aliases_for_reading()),
				None => self.aliases_for_reading(),
			};
			let program = match reader.next_program(&self.parser_options(), aliases) {
				Ok(Some(program)) => program,
				Ok(None) => break,
				Err(parse_err) => {
					return Ok(self.report_parse_error(parse_err, source_info, &params).await);
				},
			};
			first = false;
			result = match interp::execute_program(program, self, &params).await {
				Ok(result) => result,
				Err(err) => return Ok(self.report_error(err, &params).await),
			};
			// Names rejected by assignments to `BASH_ALIASES` that no command
			// reported (see `ShellEnvironment::define_assigned_aliases`).
			let mut stderr = params.stderr(self);
			self.report_rejected_alias_names(&mut stderr).await;
			if !result.is_normal_flow() {
				break;
			}
		}
		Ok(result)
	}

	/// Reports a syntax error, which ends what the shell was reading (per
	/// spec).
	pub(crate) async fn report_parse_error(
		&mut self,
		parse_err: brush_parser::ParseError,
		source_info: &crate::SourceInfo,
		params: &ExecutionParameters,
	) -> ExecutionResult {
		let err =
			error::Error::from(error::ErrorKind::ParseError(parse_err, source_info.clone())).into_fatal();
		self.report_error(err, params).await
	}

	async fn report_error(&mut self, err: error::Error, params: &ExecutionParameters) -> ExecutionResult {
		if params.reports_errors() {
			let _ = self.display_error(&mut params.stderr(self), &err).await;
		}
		let result = err.into_result(self);
		self.set_last_exit_status(result.exit_code.into());
		result
	}

	/// Executes a parsed shell program, returning the resulting exit status.
	/// The program was read already, so no alias is substituted in it.
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
		interp::execute_program(program, self, params).await
	}

	/// Evaluate the given arithmetic expression, returning the result.
	pub fn eval_arithmetic(
		&mut self,
		expr: &brush_parser::ast::ArithmeticExpr,
	) -> Result<i64, error::Error> {
		Ok(expr.eval(self)?)
	}
}
