//! Typed MCP timeout precedence and cancellation composition.

use std::{env, future::Future, time::Duration};

use tokio_util::sync::CancellationToken;

const DEFAULT_MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_TIMEOUT_ENV: &str = "OMP_MCP_TIMEOUT_MS";

/// Resolved MCP request deadline.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpTimeout {
	/// Client-side deadline is explicitly disabled; caller cancellation remains.
	Disabled,
	/// Request expires after this duration.
	After(Duration),
}

impl McpTimeout {
	/// Resolves process override, then per-mount value, then global value, then
	/// the thirty-second default. Invalid environment values are ignored.
	pub fn resolve(global: Option<Duration>, mount_ms: Option<u64>) -> Self {
		Self::resolve_with(env::var(MCP_TIMEOUT_ENV).ok().as_deref(), global, mount_ms)
	}

	fn resolve_with(raw: Option<&str>, global: Option<Duration>, mount_ms: Option<u64>) -> Self {
		if let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty())
			&& let Ok(milliseconds) = value.parse::<u64>()
		{
			return Self::from_millis(milliseconds);
		}
		if let Some(milliseconds) = mount_ms {
			return Self::from_millis(milliseconds);
		}
		Self::After(global.unwrap_or(DEFAULT_MCP_TIMEOUT))
	}

	const fn from_millis(milliseconds: u64) -> Self {
		if milliseconds == 0 {
			Self::Disabled
		} else {
			Self::After(Duration::from_millis(milliseconds))
		}
	}

	/// Returns the effective transport duration, or `None` when explicitly
	/// disabled.
	pub const fn duration(self) -> Option<Duration> {
		match self {
			Self::Disabled => None,
			Self::After(duration) => Some(duration),
		}
	}

	/// Runs one cancellation-safe operation under caller cancellation and the
	/// resolved deadline. Dropping the future cancels the underlying operation.
	pub async fn run<T>(
		self,
		caller: &CancellationToken,
		operation: impl Future<Output = T>,
	) -> Result<T, McpDeadlineError> {
		match self {
			Self::Disabled => {
				tokio::select! {
					biased;
					() = caller.cancelled() => Err(McpDeadlineError::Cancelled),
					value = operation => Ok(value),
				}
			},
			Self::After(duration) => {
				tokio::select! {
					biased;
					() = caller.cancelled() => Err(McpDeadlineError::Cancelled),
					result = tokio::time::timeout(duration, operation) => {
						result.map_err(|_| McpDeadlineError::TimedOut)
					},
				}
			},
		}
	}
}

/// Composite MCP deadline termination.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum McpDeadlineError {
	/// Caller cancelled the operation.
	#[error("MCP operation was cancelled")]
	Cancelled,
	/// Client-side deadline elapsed.
	#[error("MCP operation timed out")]
	TimedOut,
}

#[cfg(test)]
mod tests {
	use std::future;

	use super::*;

	#[test]
	fn precedence_and_zero_disable_match_pi() {
		assert_eq!(
			McpTimeout::resolve_with(Some("17"), Some(Duration::from_secs(9)), Some(8)),
			McpTimeout::After(Duration::from_millis(17))
		);
		assert_eq!(
			McpTimeout::resolve_with(Some("invalid"), Some(Duration::from_secs(9)), Some(8)),
			McpTimeout::After(Duration::from_millis(8))
		);
		assert_eq!(
			McpTimeout::resolve_with(Some("0"), Some(Duration::from_secs(9)), Some(8)),
			McpTimeout::Disabled
		);
	}

	#[tokio::test]
	async fn disabled_still_honors_caller_cancellation() {
		let cancel = CancellationToken::new();
		cancel.cancel();
		let result = McpTimeout::Disabled
			.run(&cancel, future::pending::<()>())
			.await;
		assert_eq!(result, Err(McpDeadlineError::Cancelled));
	}
}
