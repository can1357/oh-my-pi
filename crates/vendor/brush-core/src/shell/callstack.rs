//! Call stack management for the shell.

use crate::{ExecutionParameters, callstack, env, error, functions, trace_categories};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	/// Returns whether or not the shell is actively executing in a sourced
	/// script.
	pub fn in_sourced_script(&self) -> bool {
		self.call_stack.in_sourced_script()
	}

	/// Returns whether or not the shell is actively executing in a shell
	/// function.
	pub fn in_function(&self) -> bool {
		self.call_stack.in_function()
	}

	/// Updates the shell's internal tracking state to reflect that a new
	/// interactive session is being started.
	pub fn start_interactive_session(&mut self) -> Result<(), error::Error> {
		self.call_stack.push_interactive_session();
		Ok(())
	}

	/// Updates the shell's internal tracking state to reflect that the current
	/// interactive session is ending.
	pub fn end_interactive_session(&mut self) -> Result<(), error::Error> {
		if self
			.call_stack
			.current_frame()
			.is_none_or(|frame| !frame.frame_type.is_interactive_session())
		{
			return Err(error::ErrorKind::NotInInteractiveSession.into());
		}

		self.call_stack.pop();

		Ok(())
	}

	/// Updates the shell's internal tracking state to reflect that command
	/// string mode is being started.
	pub fn start_command_string_mode(&mut self) {
		self.call_stack.push_command_string();
	}

	/// Updates the shell's internal tracking state to reflect that command
	/// string mode is ending.
	pub fn end_command_string_mode(&mut self) -> Result<(), error::Error> {
		if self
			.call_stack
			.current_frame()
			.is_none_or(|frame| !frame.frame_type.is_command_string())
		{
			return Err(error::ErrorKind::NotExecutingCommandString.into());
		}

		self.call_stack.pop();

		Ok(())
	}

	pub(crate) fn enter_trap_handler(
		&mut self,
		signal: crate::traps::TrapSignal,
		handler: Option<&crate::traps::TrapHandler>,
	) {
		self.call_stack.push_trap_handler(signal, handler);
	}

	pub(crate) fn leave_trap_handler(&mut self) {
		self.call_stack.pop();
	}

	/// Acquires a block on trap delivery, preventing traps from being delivered
	/// until the block is released. Multiple blocks may be acquired, and trap
	/// delivery will remain suppressed until all blocks have been released.
	pub(crate) const fn acquire_trap_delivery_block(&mut self) {
		self.call_stack.acquire_trap_delivery_block();
	}

	/// Releases a block on trap delivery; note that trap delivery will remain
	/// suppressed until all blocks have been released.
	pub(crate) const fn release_trap_delivery_block(&mut self) {
		self.call_stack.release_trap_delivery_block();
	}

	/// Refuses a call to the function `name` when function calls already nest
	/// as deep as the shell allows, with Bash's `maximum function nesting
	/// level exceeded` error.
	pub(crate) fn check_function_nesting(&self, name: &str) -> Result<(), error::Error> {
		let limit = self.function_nesting_limit();
		if self.call_stack.function_call_depth() >= limit {
			return Err(error::ErrorKind::MaxFunctionNestingExceeded(name.to_owned(), limit).into());
		}
		Ok(())
	}

	/// Updates the shell's internal tracking state to reflect that a new shell
	/// function is being entered. The caller has already checked the call
	/// with [`Self::check_function_nesting`].
	///
	/// # Arguments
	///
	/// * `name` - The name of the function being entered.
	/// * `function` - The function being entered.
	/// * `args` - The arguments being passed to the function.
	/// * `_params` - Current execution parameters.
	pub(crate) fn enter_function(
		&mut self,
		name: &str,
		function: &functions::Registration,
		args: impl IntoIterator<Item = String>,
		_params: &ExecutionParameters,
	) {
		if tracing::enabled!(target: trace_categories::FUNCTIONS, tracing::Level::DEBUG) {
			let depth = self.call_stack.function_call_depth();
			let prefix = repeated_char_str(' ', depth);
			tracing::debug!(target: trace_categories::FUNCTIONS, "Entering func [depth={depth}]: {prefix}{name}");
		}

		self.call_stack.push_function(name, function, args);
		self.env.push_scope(env::EnvironmentScope::Local);
	}

	/// Returns how deep function calls may nest: the value of `FUNCNEST` when
	/// it is a positive number, as in Bash, and otherwise
	/// [`callstack::DEFAULT_NESTING_LIMIT`]. Bash puts no limit on an unset
	/// `FUNCNEST`; here every level costs native stack, so there is always one.
	fn function_nesting_limit(&self) -> usize {
		self.env_str("FUNCNEST")
			.and_then(|value| value.trim().parse::<usize>().ok())
			.filter(|limit| *limit > 0)
			.unwrap_or(callstack::DEFAULT_NESTING_LIMIT)
	}

	/// Updates the shell's internal tracking state to reflect that the shell
	/// has exited the top-most function on its call stack.
	pub(crate) fn leave_function(&mut self) -> Result<(), error::Error> {
		self.env.pop_scope(env::EnvironmentScope::Local)?;

		if let Some(exited_call) = self.call_stack.pop() {
			if let callstack::FrameType::Function(func_call) = exited_call.frame_type {
				if tracing::enabled!(target: trace_categories::FUNCTIONS, tracing::Level::DEBUG) {
					let depth = self.call_stack.function_call_depth();
					let prefix = repeated_char_str(' ', depth);
					tracing::debug!(target: trace_categories::FUNCTIONS, "Exiting func  [depth={depth}]: {prefix}{}", func_call.function_name);
				}
			} else {
				let err: error::Error =
					error::ErrorKind::InternalError("mismatched call stack state".to_owned()).into();
				return Err(err.into_fatal());
			}
		}

		Ok(())
	}

	/// Returns the *current* positional arguments for the shell ($1 and beyond).
	/// Influenced by the current call stack.
	pub fn current_shell_args(&self) -> &[String] {
		for frame in self.call_stack.iter() {
			match frame.frame_type {
				// Function calls always shadow positional parameters.
				crate::callstack::FrameType::Function(..) => return &frame.args,
				// Executed scripts always shadow positional parameters.
				_ if frame.frame_type.is_run_script() => return &frame.args,
				// Sourced scripts shadow positional parameters if they have arguments.
				_ if frame.frame_type.is_sourced_script() && !frame.args.is_empty() => {
					return &frame.args;
				},
				_ => (),
			}
		}

		self.args.as_slice()
	}

	/// Returns a mutable reference to *current* positional parameters for the
	/// shell ($1 and beyond).
	pub fn current_shell_args_mut(&mut self) -> &mut Vec<String> {
		for frame in self.call_stack.iter_mut() {
			match frame.frame_type {
				// Function calls always shadow positional parameters.
				crate::callstack::FrameType::Function(..) => return &mut frame.args,
				// Executed scripts always shadow positional parameters.
				_ if frame.frame_type.is_run_script() => return &mut frame.args,
				// Sourced scripts shadow positional parameters if they have arguments.
				_ if frame.frame_type.is_sourced_script() && !frame.args.is_empty() => {
					return &mut frame.args;
				},
				_ => (),
			}
		}

		&mut self.args
	}
}

fn repeated_char_str(c: char, count: usize) -> String {
	(0..count).map(|_| c).collect()
}
