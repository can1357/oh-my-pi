//! Secure MCP environment and header value resolution.
//!
//! `!command` values are delegated to the shared command-credential resolver,
//! whose executor crosses the Environment boundary. This module never spawns a
//! shell or owns a second command cache.

use std::{collections::BTreeMap, fmt};

use omp_ai::auth::command::{CommandCredentialError, CommandCredentialResolver};
use omp_core::{ExposeSecret as _, SecretString, Str};
use tokio_util::sync::CancellationToken;

use super::config::{HeaderPolicy, McpServerConfig};

/// Resolved configuration value retaining secret typing.
#[derive(Clone)]
pub enum ResolvedConfigValue {
	/// Public literal or environment value.
	Public(Str),
	/// Command-produced secret value.
	Secret(SecretString),
}

impl ResolvedConfigValue {
	/// Exposes the value only to the immediate transport-construction closure.
	pub fn with_exposed<R>(&self, use_value: impl FnOnce(&str) -> R) -> R {
		match self {
			Self::Public(value) => use_value(value),
			Self::Secret(value) => use_value(value.expose_secret()),
		}
	}
}

impl fmt::Debug for ResolvedConfigValue {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		match self {
			Self::Public(value) => formatter.debug_tuple("Public").field(value).finish(),
			Self::Secret(_) => formatter.write_str("Secret([REDACTED])"),
		}
	}
}

/// Dynamic values ready for transport construction.
#[derive(Clone, Debug, Default)]
pub struct ResolvedTransportValues {
	/// Resolved stdio environment. Empty dynamic values are omitted.
	pub env:     BTreeMap<Str, ResolvedConfigValue>,
	/// Resolved HTTP headers. Empty dynamic values are omitted.
	pub headers: BTreeMap<Str, ResolvedConfigValue>,
}

/// Resolves the dynamic portions of one MCP declaration.
///
/// Literal environment and origin-locked header policies bypass both exact
/// environment lookup and command execution. Other values use the shared secret
/// resolver for `!command`; otherwise an exact environment variable name wins,
/// falling back to the literal text.
pub async fn resolve_transport_values(
	config: &McpServerConfig,
	environment: &BTreeMap<Str, Str>,
	commands: Option<&CommandCredentialResolver>,
	cancellation: &CancellationToken,
) -> Result<ResolvedTransportValues, ConfigValueError> {
	let env = resolve_map(&config.env, Some(config), environment, commands, cancellation).await?;
	let headers = if config.header_policy == Some(HeaderPolicy::OriginLocked) {
		config
			.headers
			.iter()
			.map(|(key, value)| (key.clone(), ResolvedConfigValue::Public(value.clone())))
			.collect()
	} else {
		resolve_map(&config.headers, None, environment, commands, cancellation).await?
	};
	Ok(ResolvedTransportValues { env, headers })
}

async fn resolve_map(
	values: &BTreeMap<Str, Str>,
	env_config: Option<&McpServerConfig>,
	environment: &BTreeMap<Str, Str>,
	commands: Option<&CommandCredentialResolver>,
	cancellation: &CancellationToken,
) -> Result<BTreeMap<Str, ResolvedConfigValue>, ConfigValueError> {
	let mut resolved = BTreeMap::new();
	for (key, value) in values {
		if env_config.is_some_and(|config| config.env_value_is_literal(key)) {
			resolved.insert(key.clone(), ResolvedConfigValue::Public(value.clone()));
			continue;
		}
		let value = resolve_value(value, environment, commands, cancellation).await?;
		let empty = value.with_exposed(str::is_empty);
		if !empty {
			resolved.insert(key.clone(), value);
		}
	}
	Ok(resolved)
}

async fn resolve_value(
	value: &str,
	environment: &BTreeMap<Str, Str>,
	commands: Option<&CommandCredentialResolver>,
	cancellation: &CancellationToken,
) -> Result<ResolvedConfigValue, ConfigValueError> {
	if let Some(command) = value.strip_prefix('!') {
		return commands
			.ok_or(ConfigValueError::ExecutorUnavailable)?
			.resolve(command, cancellation.clone())
			.await
			.map(ResolvedConfigValue::Secret)
			.map_err(ConfigValueError::Command);
	}
	Ok(ResolvedConfigValue::Public(
		environment
			.get(value)
			.cloned()
			.unwrap_or_else(|| Str::from(value)),
	))
}

/// Redaction-safe dynamic configuration failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConfigValueError {
	/// A dynamic command was configured before composition injected an executor.
	#[error("MCP command-produced configuration values require an Environment command executor")]
	ExecutorUnavailable,
	/// Shared Environment command credential resolution failed.
	#[error("MCP command-produced configuration value could not be resolved")]
	Command(#[source] CommandCredentialError),
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeSet,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		time::Duration,
	};

	use omp_ai::auth::command::{CommandCredentialExecutor, CommandExecutionFuture};

	use super::*;
	use crate::mcp::config::{EnvironmentPolicy, McpServerConfig, TransportKind};

	struct Executor {
		calls: AtomicUsize,
	}
	impl CommandCredentialExecutor for Executor {
		fn execute(&self, command: Str, _: CancellationToken) -> CommandExecutionFuture {
			self.calls.fetch_add(1, Ordering::SeqCst);
			Box::pin(async move {
				if command.as_str() == "credential" {
					Ok(SecretString::from("secret-output"))
				} else {
					Err(CommandCredentialError::Execution)
				}
			})
		}
	}

	fn config() -> McpServerConfig {
		McpServerConfig {
			transport:         Some(TransportKind::Stdio),
			enabled:           true,
			command:           Some(Str::from("server")),
			args:              Vec::new(),
			env:               BTreeMap::from([
				(Str::from("TOKEN"), Str::from("!credential")),
				(Str::from("FROM_ENV"), Str::from("ENV_NAME")),
			]),
			env_policy:        None,
			env_literal_keys:  BTreeSet::new(),
			cwd:               None,
			url:               None,
			headers:           BTreeMap::new(),
			header_policy:     None,
			timeout:           None,
			request_id_format: None,
			auth:              None,
			oauth:             None,
			protocol_versions: Vec::new(),
		}
	}

	#[tokio::test]
	async fn command_values_use_shared_secret_resolver_and_stay_redacted() {
		let executor = Arc::new(Executor { calls: AtomicUsize::new(0) });
		let resolver = CommandCredentialResolver::new(executor.clone(), Duration::from_millis(50));
		let values = resolve_transport_values(
			&config(),
			&BTreeMap::from([(Str::from("ENV_NAME"), Str::from("public"))]),
			Some(&resolver),
			&CancellationToken::new(),
		)
		.await
		.expect("resolve");
		assert_eq!(executor.calls.load(Ordering::SeqCst), 1);
		assert_eq!(values.env["FROM_ENV"].with_exposed(str::to_owned), "public");
		assert_eq!(values.env["TOKEN"].with_exposed(str::to_owned), "secret-output");
		assert!(!format!("{values:?}").contains("secret-output"));
	}

	#[tokio::test]
	async fn literal_policy_never_executes_commands() {
		let executor = Arc::new(Executor { calls: AtomicUsize::new(0) });
		let resolver = CommandCredentialResolver::new(executor.clone(), Duration::from_millis(50));
		let mut config = config();
		config.env_policy = Some(EnvironmentPolicy::Literal);
		let values = resolve_transport_values(
			&config,
			&BTreeMap::new(),
			Some(&resolver),
			&CancellationToken::new(),
		)
		.await
		.expect("resolve");
		assert_eq!(executor.calls.load(Ordering::SeqCst), 0);
		assert_eq!(values.env["TOKEN"].with_exposed(str::to_owned), "!credential");
	}

	#[tokio::test]
	async fn literal_environment_keys_bypass_resolution_individually() {
		let executor = Arc::new(Executor { calls: AtomicUsize::new(0) });
		let resolver = CommandCredentialResolver::new(executor.clone(), Duration::from_millis(50));
		let mut config = config();
		config.env_literal_keys.insert(Str::from("TOKEN"));
		config.env.insert(Str::from("EMPTY"), Str::new_static(""));
		config.env_literal_keys.insert(Str::from("EMPTY"));
		let values = resolve_transport_values(
			&config,
			&BTreeMap::from([(Str::from("ENV_NAME"), Str::from("public"))]),
			Some(&resolver),
			&CancellationToken::new(),
		)
		.await
		.expect("resolve");
		assert_eq!(executor.calls.load(Ordering::SeqCst), 0);
		assert_eq!(values.env["TOKEN"].with_exposed(str::to_owned), "!credential");
		assert_eq!(values.env["EMPTY"].with_exposed(str::to_owned), "");
		assert_eq!(values.env["FROM_ENV"].with_exposed(str::to_owned), "public");
	}
}
