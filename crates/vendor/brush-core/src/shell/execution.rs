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
		if matches!(call_type, callstack::ScriptCallType::Source)
			&& self.call_stack.script_source_depth() >= callstack::DEFAULT_NESTING_LIMIT
		{
			return Err(
				error::ErrorKind::MaxSourceNestingExceeded(
					path.to_string_lossy().into_owned(),
					callstack::DEFAULT_NESTING_LIMIT,
				)
				.into(),
			);
		}
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
		let parse_result = {
			let mut reader = std::io::BufReader::new(file);
			let mut parser = brush_parser::Parser::new(&mut reader, &self.parser_options());

			tracing::debug!(target: trace_categories::PARSE, "Parsing sourced file: {}", source_info.source);
			parser.parse_program()
		};

		let script_positional_args = args.map(Into::into);

		self
			.call_stack
			.push_script(call_type, source_info, script_positional_args);

		let result = self
			.run_parsed_result(parse_result, source_info, params)
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
		let parse_result = self.parse_string(command);
		self
			.run_parsed_result(parse_result, source_info, params)
			.await
	}

	/// Executes the given string as the `eval` builtin does, refusing with
	/// Bash's `maximum eval nesting level exceeded` error once evals nest
	/// [`callstack::DEFAULT_NESTING_LIMIT`] deep.
	///
	/// # Arguments
	///
	/// * `command` - The command to execute.
	/// * `source_info` - Information about the source of the command text.
	/// * `params` - Execution parameters.
	pub async fn eval_string<S: Into<String>>(
		&mut self,
		command: S,
		source_info: &crate::SourceInfo,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		if self.call_stack.eval_depth() >= callstack::DEFAULT_NESTING_LIMIT {
			return Err(
				error::ErrorKind::MaxEvalNestingExceeded(callstack::DEFAULT_NESTING_LIMIT).into(),
			);
		}
		EvalScope::enter(self).run_string(command, source_info, params).await
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

		// In a subshell an abandonment passes to that subshell's top level:
		// `eval` and source must not consume it before then. Outside a
		// subshell, retain Bash's DISCARD behavior and run the next command.
		match result {
			Ok(result) => Ok(result),
			Err(err) if self.is_subshell() && err.abandons_command() => Err(err),
			Err(err) => {
				if params.reports_errors() {
					let _ = self.display_error(&mut params.stderr(self), &err).await;
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

/// Counts one `eval` as running for as long as it lives and leaves it when
/// dropped, on every exit path: a result, an error, and a future dropped
/// before it finished (a cancelled caller). Before, `eval_string` entered and
/// left by hand, so a dropped `eval` future left its count behind, and every
/// later `eval` in that shell started that much nearer the limit.
struct EvalScope<'a, SE: crate::extensions::ShellExtensions> {
	shell: &'a mut crate::Shell<SE>,
}

impl<'a, SE: crate::extensions::ShellExtensions> EvalScope<'a, SE> {
	fn enter(shell: &'a mut crate::Shell<SE>) -> Self {
		shell.call_stack.enter_eval();
		Self { shell }
	}
}

impl<SE: crate::extensions::ShellExtensions> Drop for EvalScope<'_, SE> {
	fn drop(&mut self) {
		self.shell.call_stack.leave_eval();
	}
}

impl<SE: crate::extensions::ShellExtensions> std::ops::Deref for EvalScope<'_, SE> {
	type Target = crate::Shell<SE>;

	fn deref(&self) -> &Self::Target {
		self.shell
	}
}

impl<SE: crate::extensions::ShellExtensions> std::ops::DerefMut for EvalScope<'_, SE> {
	fn deref_mut(&mut self) -> &mut Self::Target {
		self.shell
	}
}

#[cfg(test)]
mod tests {
	/// A dropped `eval` future, such as one whose caller was cancelled while it
	/// ran, leaves no `eval` counted: the limit check reads this count, so a
	/// count left behind would refuse later `eval`s early. Before the guard,
	/// each dropped `eval` left one count behind.
	#[cfg(unix)]
	#[tokio::test]
	async fn a_dropped_eval_leaves_no_count_behind() -> anyhow::Result<()> {
		let mut shell = crate::shell::Shell::builder().build().await?;
		let params = shell.default_exec_params();
		let source_info = crate::SourceInfo::default();
		let pending = shell.eval_string("/bin/sleep 5", &source_info, &params);
		assert!(
			tokio::time::timeout(std::time::Duration::from_millis(200), pending).await.is_err(),
			"the eval finished before it was dropped"
		);
		assert_eq!(shell.call_stack().eval_depth(), 0);
		Ok(())
	}
}
