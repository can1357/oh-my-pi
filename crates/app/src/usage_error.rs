//! Structured command-line usage failures.

use miette::Diagnostic;
use thiserror::Error;

/// A validation failure rendered without a stack trace and with the standard
/// help pointer used by every OMP command-line entry point.
#[derive(Clone, Debug, Diagnostic, Error, Eq, PartialEq)]
#[diagnostic(code(omp::cli::usage))]
#[error("{message}{help}")]
pub struct CliUsageError {
	message:   String,
	help:      &'static str,
	exit_code: u8,
	lowercase: bool,
}

impl CliUsageError {
	/// Creates a usage error with the standard help pointer and exit status 2.
	pub fn new(message: impl Into<String>) -> Self {
		Self {
			message:   message.into(),
			help:      "\nRun `omp --help` for available flags.",
			exit_code: 2,
			lowercase: false,
		}
	}

	/// Creates a reserved-command redirect with exit status 1 rather than a
	/// parser usage failure.
	pub fn redirect(message: impl Into<String>) -> Self {
		Self { message: message.into(), help: "", exit_code: 1, lowercase: true }
	}

	/// Creates a bootstrap failure before command dispatch.
	pub fn startup(message: impl Into<String>) -> Self {
		Self { message: message.into(), help: "", exit_code: 1, lowercase: false }
	}

	/// Whether the stable prefix is lowercase `error:`.
	pub const fn lowercase(&self) -> bool {
		self.lowercase
	}

	/// Process exit status for this command-line failure.
	pub const fn exit_code(&self) -> u8 {
		self.exit_code
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn includes_the_standard_help_pointer() {
		assert_eq!(
			CliUsageError::new("bad flag").to_string(),
			"bad flag\nRun `omp --help` for available flags."
		);
		assert_eq!(CliUsageError::new("bad flag").exit_code(), 2);
		let redirect = CliUsageError::redirect("use omp ext");
		assert_eq!(redirect.exit_code(), 1);
		assert!(redirect.lowercase());
		assert_eq!(redirect.to_string(), "use omp ext");
		assert!(!CliUsageError::startup("bad profile").lowercase());
	}
}
