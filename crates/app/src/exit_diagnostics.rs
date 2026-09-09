//! Process-level exit statuses emitted only after durable session teardown.

use omp_session::ExitSignal;
use thiserror::Error;

/// A process signal whose session diagnostic has already been committed.
///
/// The binary downcasts this app-boundary error and exits with the conventional
/// shell status without printing a second error: the signal and crash tail are
/// already available through the durable transcript projection.
#[derive(Clone, Debug, Error, miette::Diagnostic)]
#[error("process interrupted after durable session teardown")]
pub struct SignalExit {
	signal: ExitSignal,
}

impl SignalExit {
	/// Constructs the terminal status for a signal already persisted by the
	/// session owner.
	#[must_use]
	pub const fn new(signal: ExitSignal) -> Self {
		Self { signal }
	}

	/// Captured signal identity.
	#[must_use]
	pub const fn signal(&self) -> &ExitSignal {
		&self.signal
	}

	/// Conventional shell status (`128 + signal`), saturated to one byte.
	/// Platforms without a numeric signal use Ctrl+C's conventional 130.
	#[must_use]
	pub fn exit_code(&self) -> u8 {
		let number = self.signal.number.unwrap_or(2).max(1);
		u8::try_from(128_i32.saturating_add(number)).unwrap_or(u8::MAX)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn derives_conventional_signal_status() {
		assert_eq!(SignalExit::new(ExitSignal::new("SIGINT", Some(2))).exit_code(), 130);
		assert_eq!(SignalExit::new(ExitSignal::new("SIGTERM", Some(15))).exit_code(), 143);
		assert_eq!(SignalExit::new(ExitSignal::new("CTRL_C", None)).exit_code(), 130);
	}
}
