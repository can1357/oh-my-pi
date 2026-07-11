//! Trap handling for the shell.

use crate::{ExecutionParameters, ExecutionResult, ProcessGroupPolicy, error, traps::TrapSignal};

impl<SE: crate::extensions::ShellExtensions> crate::Shell<SE> {
	/// Runs any exit steps for the shell.
	///
	/// This currently includes invoking the `EXIT` trap handler, if any.
	pub async fn on_exit(&mut self) -> Result<(), error::Error> {
		if self.traps.handles(TrapSignal::Exit) {
			self
				.invoke_trap_handler(TrapSignal::Exit, &self.default_exec_params())
				.await?;
		}

		Ok(())
	}

	/// Invokes the handler registered for `signal`, if any.
	///
	/// Behavior varies by signal type:
	///
	/// * **Per-signal recursion guard** — each trap guards against its own
	///   self-recursion, but different traps *can* fire from within each other's
	///   handlers (matching bash semantics).
	///
	/// * **Inheritance** — in functions and subshells, some traps are only
	///   inherited when the corresponding shell option is enabled (e.g.
	///   `errtrace` / `set -E` for `ERR`, `functrace` / `set -T` for
	///   `DEBUG`/`RETURN`).
	///
	/// * **`$?` preservation** — `last_exit_status` is saved before and restored
	///   after the handler runs so the trap does not clobber the status that
	///   triggered it.
	///
	/// # Arguments
	///
	/// * `signal`: Signal to run handler for.
	///
	/// * `params`: Execution parameters to use for handler.
	pub(crate) async fn invoke_trap_handler(
		&mut self,
		signal: TrapSignal,
		params: &ExecutionParameters,
	) -> Result<ExecutionResult, error::Error> {
		// Per-signal self-recursion guard: don't re-enter a trap that is
		// already being handled. Different traps *can* fire from each
		// other's handlers (e.g. ERR inside EXIT, EXIT inside ERR).
		if self.call_stack().is_trap_signal_active(signal) {
			return Ok(ExecutionResult::success());
		}

		// Don't fire traps that have been explicitly suppressed (e.g. DEBUG
		// during programmable completion).
		if self.call_stack().is_trap_delivery_suppressed() {
			return Ok(ExecutionResult::success());
		}

		// In functions and subshells, some traps are only inherited when the
		// corresponding option is enabled.
		if (self.in_function() || self.is_subshell())
			&& !self.is_trap_inherited_in_current_scope(signal)
		{
			return Ok(ExecutionResult::success());
		}

		let Some(handler) = self.traps.get_handler(signal).cloned() else {
			return Ok(ExecutionResult::success());
		};

		let mut params = params.clone();
		params.process_group_policy = ProcessGroupPolicy::SameProcessGroup;

		// Preserve $? across trap handler execution so the handler doesn't
		// clobber the status that triggered it.
		let orig_last_exit_status = self.last_exit_status;

		// N.B. We use manual enter/leave rather than an RAII guard because a guard
		// would need to hold `&mut Shell`, preventing the mutable borrow required by
		// `run_string()`. This is safe because `result` is captured into a variable
		// (never early-returned with `?`), so `leave_trap_handler()` always runs.
		self.enter_trap_handler(signal, Some(&handler));

		let result = self
			.run_string(&handler.command, &handler.source_info, &params)
			.await;

		self.leave_trap_handler();
		self.last_exit_status = orig_last_exit_status;

		result
	}

	/// Returns whether the given trap signal is inherited in the current
	/// function or subshell scope.
	fn is_trap_inherited_in_current_scope(&self, signal: TrapSignal) -> bool {
		match signal {
			TrapSignal::Err => self.options().shell_functions_inherit_err_trap,
			TrapSignal::Debug | TrapSignal::Return => {
				self
					.options()
					.shell_functions_inherit_debug_and_return_traps
			},
			// EXIT and system signals are always inherited — i.e. their visibility is
			// not gated by errtrace/functrace options. (The actual trap *state* for
			// subshells is managed separately via `Shell::clone`.)
			TrapSignal::Exit | TrapSignal::Signal(_) => true,
		}
	}
}
