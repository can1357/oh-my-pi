//! Example of implementing a custom builtin command for a brush-core based
//! shell.
//!
//! This example demonstrates best practices for:
//! - Creating a custom builtin command using the `Command` trait
//! - Defining custom error types with `thiserror`
//! - Parsing command-line arguments with `clap`
//! - Implementing proper error handling and exit code conversion
//! - Using the execution context to interact with shell state and I/O streams
//!
//! Run this example with:
//! ```bash
//! cargo run --package brush-core --example custom-builtin
//! ```

use std::io::Write;

use anyhow::Result;
use brush_core::{ExecutionResult, builtins};
use clap::Parser;

//
// Step 1 (optional): Define a custom error type for your builtin
// ==============================================
// We recommend using `thiserror` to create descriptive error types that can be
// converted to appropriate exit codes.
//

#[derive(Debug, thiserror::Error)]
enum GreetError {
	/// The requested repeat count is beyond the supported range.
	#[error("repeat count out of range")]
	RepeatCountOutOfRange,

	/// A shell error occurred during execution; we transparently forward error
	/// display to the underlying error.
	#[error(transparent)]
	ShellError(#[from] brush_core::Error),

	/// An I/O error occurred.
	#[error("I/O error occurred during greeting: {0}")]
	IoError(#[from] std::io::Error),
}

// Mark your error type as a builtin error. This is required to use this error
// type in your command implementation.
impl brush_core::BuiltinError for GreetError {}

// If you define a custom error type, you must map each error variant to an
// appropriate exit code. This ensures the shell interpreter will translate a
// returned error to the appropriate code during execution.
impl From<&GreetError> for brush_core::ExecutionExitCode {
	fn from(value: &GreetError) -> Self {
		match value {
			GreetError::RepeatCountOutOfRange => Self::InvalidUsage,
			GreetError::ShellError(e) => e.into(),
			GreetError::IoError(_) => Self::GeneralError,
		}
	}
}

//
// Step 2 (recommended): Define your builtin command arguments
// ==============================================
// We recommend using the `clap` crate and the derive-able `clap::Parser` to
// define command-line arguments and options. This will simplify the work you
// need to do to provide helpful usage information and auto-generated argument
// validation.
//

/// Greet the user with a friendly message.
#[derive(Parser)]
struct GreetCommand {
	/// Number of times to repeat the greeting.
	#[arg(short = 'n', long = "repeat", default_value_t = 1)]
	repeat_count: usize,
}

//
// Step 3: Implement the Command trait
// ==============================================
// The `Command` trait requires implementing the `execute` method.
//

impl builtins::Command for GreetCommand {
	// Specify the error type you will use; this will either be your custom type or
	// the default-provided `brush_core::Error` type.
	type Error = GreetError;

	async fn execute<SE: brush_core::ShellExtensions>(
		&self,
		context: brush_core::ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		// Additional validation.
		if self.repeat_count == 0 || self.repeat_count > 10 {
			return Err(GreetError::RepeatCountOutOfRange);
		}

		// For demonstration, we expand a greeting string using shell variable
		// expansion. This is a bit contrived, but it shows how to wrap errors coming
		// back from `brush_core`.
		let greeting = context
			.shell
			.basic_expand_string(&context.params, "Hello, ${USER}!")
			.await?;

		// Execute the greeting.
		for _ in 0..self.repeat_count {
			writeln!(context.stdout(), "{greeting}")?;
		}

		// Return success
		Ok(ExecutionResult::success())
	}
}

//
// Step 4: Integrate your builtin into a shell
// ==============================================
// This example shows how to register and use your custom builtin.
//

type SE = brush_core::extensions::DefaultShellExtensions;

async fn run_example() -> Result<()> {
	// Create a shell instance with custom builtin registered.
	let mut shell = brush_core::Shell::builder()
		.builtin("greet", brush_core::builtins::builtin::<GreetCommand, SE>())
		.build()
		.await?;

	// Demonstrate basic usage.
	let result = shell
		.run_string("greet -n 4", &brush_core::SourceInfo::default(), &shell.default_exec_params())
		.await?;
	println!("Exit code: {}\n", u8::from(result.exit_code));

	Ok(())
}

fn main() -> Result<()> {
	// Construct a `tokio` runtime for async execution
	let rt = tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()?;

	rt.block_on(run_example())?;

	Ok(())
}
