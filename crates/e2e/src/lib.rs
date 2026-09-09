//! Shared bounded authority harness for OMP's executable acceptance proofs.
//!
//! Scenario bodies live in integration-test targets. This crate owns only the
//! reusable lifecycle, transport, fixture, and canonical-data support they use.

use std::{error, fmt::Display, io, result};

/// Boxed error used by executable acceptance proofs.
pub type Error = Box<dyn error::Error + Send + Sync + 'static>;

/// Result used by executable acceptance proofs.
pub type Result<T, E = Error> = result::Result<T, E>;

/// Adds a human-readable operation label to fallible fixture setup.
pub trait Context<T> {
	/// Adds a fixed operation label.
	fn context(self, context: impl Display) -> Result<T>;

	/// Lazily computes an operation label.
	fn with_context(self, context: impl FnOnce() -> String) -> Result<T>;
}

impl<T, E> Context<T> for result::Result<T, E>
where
	E: Display + Send + Sync + 'static,
{
	fn context(self, context: impl Display) -> Result<T> {
		self.map_err(|error| io::Error::other(format!("{context}: {error}")).into())
	}

	fn with_context(self, context: impl FnOnce() -> String) -> Result<T> {
		self.map_err(|error| io::Error::other(format!("{}: {error}", context())).into())
	}
}

impl<T> Context<T> for Option<T> {
	fn context(self, context: impl Display) -> Result<T> {
		self.ok_or_else(|| io::Error::other(context.to_string()).into())
	}

	fn with_context(self, context: impl FnOnce() -> String) -> Result<T> {
		self.ok_or_else(|| io::Error::other(context()).into())
	}
}

/// Creates a boxed test-harness error from a displayable message.
pub fn error(message: impl Display) -> Error {
	io::Error::other(message.to_string()).into()
}

/// P8 performance-baseline recorder shared by the `baseline` bin and tests.
pub mod baseline;

/// Reusable acceptance-test infrastructure.
pub mod support;
