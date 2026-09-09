//! Deterministic provider/model header merging and custom OAuth application.

use std::{collections::BTreeMap, fmt, sync::Arc, time::SystemTime};

use bytes::Bytes;
use http::{HeaderName, HeaderValue, Request, StatusCode};
use omp_core::{ExposeSecret as _, SecretString, Str};
use tokio_util::sync::CancellationToken;

use super::{
	AuthSpec, CommandCredentialError, CommandCredentialResolver, CredentialApplyError,
	CredentialLease,
};

/// One dynamic secret header resolved by the Environment credential authority.
#[derive(Clone, Debug)]
pub struct SecretHeader {
	/// Header name.
	pub name:  Str,
	/// Secret-only value.
	pub value: SecretString,
}

/// One configured command-backed secret header.
#[derive(Clone)]
pub struct CommandHeaderSource {
	/// Header name.
	pub name:    Str,
	/// Environment command that resolves the header value.
	pub command: Str,
}

impl CommandHeaderSource {
	/// Parses one `!command` header value. Literal and empty command values do
	/// not produce a secret source.
	pub fn from_config(name: &str, value: &str) -> Option<Self> {
		let command = value.strip_prefix('!')?.trim();
		(!command.is_empty()).then(|| Self { name: Str::new(name), command: Str::new(command) })
	}
}

/// Per-request command-header resolver and one-shot 401 refresh hook.
///
/// A provider response may invalidate every command-backed header exactly once.
/// The returned refreshed headers are then applied to the replay request. A
/// second 401 returns `None`, allowing the original authentication failure to
/// propagate instead of creating an unbounded command/retry loop.
pub struct CommandHeaderRetry {
	resolver:  Arc<CommandCredentialResolver>,
	sources:   Box<[CommandHeaderSource]>,
	refreshed: bool,
}

impl CommandHeaderRetry {
	/// Creates a one-shot retry hook for one provider/model header set.
	pub fn new(
		resolver: Arc<CommandCredentialResolver>,
		sources: impl IntoIterator<Item = CommandHeaderSource>,
	) -> Self {
		Self {
			resolver,
			sources: sources.into_iter().collect::<Vec<_>>().into_boxed_slice(),
			refreshed: false,
		}
	}

	/// Resolves the current header values through the shared command cache.
	pub async fn resolve(
		&self,
		cancellation: CancellationToken,
	) -> Result<Vec<SecretHeader>, CommandHeaderResolveError> {
		let mut headers = Vec::with_capacity(self.sources.len());
		for source in &self.sources {
			let value = self
				.resolver
				.resolve(source.command.as_str(), cancellation.clone())
				.await
				.map_err(|error| CommandHeaderResolveError {
					header: source.name.clone(),
					source: error,
				})?;
			headers.push(SecretHeader { name: source.name.clone(), value });
		}
		Ok(headers)
	}

	/// Invalidates and re-resolves command-backed headers after the first 401.
	///
	/// Non-401 statuses and subsequent 401 responses return `None`.
	pub async fn retry_after_status(
		&mut self,
		status: StatusCode,
		cancellation: CancellationToken,
	) -> Result<Option<Vec<SecretHeader>>, CommandHeaderResolveError> {
		if status != StatusCode::UNAUTHORIZED || self.refreshed {
			return Ok(None);
		}
		self.refreshed = true;
		for source in &self.sources {
			self.resolver.invalidate(source.command.as_str());
		}
		self.resolve(cancellation).await.map(Some)
	}
}

impl fmt::Debug for CommandHeaderRetry {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("CommandHeaderRetry")
			.field("header_count", &self.sources.len())
			.field("refreshed", &self.refreshed)
			.finish_non_exhaustive()
	}
}

/// Failure to resolve one command-backed header.
#[derive(Debug, thiserror::Error)]
#[error("command-backed header resolution failed for {header}")]
pub struct CommandHeaderResolveError {
	/// Non-secret header name identifying the failed source.
	pub header: Str,
	/// Typed command-resolution failure.
	#[source]
	pub source: CommandCredentialError,
}

/// Merges safe provider headers, model overrides, dynamic secret headers, then
/// catalog auth.
///
/// Model headers replace provider headers by case-insensitive HTTP identity.
/// Public layers may not contain credential-bearing header names; those must
/// use `secret_headers` or the credential lease. OAuth/API-key application runs
/// last and is therefore authoritative.
pub fn apply_custom_auth(
	request: &mut Request<Bytes>,
	provider_headers: &BTreeMap<Str, Str>,
	model_headers: &BTreeMap<Str, Str>,
	secret_headers: &[SecretHeader],
	lease: Option<(&CredentialLease, &AuthSpec)>,
	now: SystemTime,
) -> Result<(), CustomAuthApplyError> {
	for (name, value) in provider_headers.iter().chain(model_headers) {
		let name = parse_public_name(name)?;
		let value = HeaderValue::from_str(value).map_err(|_| CustomAuthApplyError::InvalidHeader)?;
		request.headers_mut().insert(name, value);
	}
	for header in secret_headers {
		let name = HeaderName::from_bytes(header.name.as_bytes())
			.map_err(|_| CustomAuthApplyError::InvalidHeader)?;
		let mut value = HeaderValue::from_bytes(header.value.expose_secret().as_bytes())
			.map_err(|_| CustomAuthApplyError::InvalidHeader)?;
		value.set_sensitive(true);
		request.headers_mut().insert(name, value);
	}
	if let Some((lease, spec)) = lease {
		lease.apply(spec, now, request)?;
	}
	Ok(())
}

fn parse_public_name(name: &str) -> Result<HeaderName, CustomAuthApplyError> {
	let parsed =
		HeaderName::from_bytes(name.as_bytes()).map_err(|_| CustomAuthApplyError::InvalidHeader)?;
	if matches!(parsed.as_str(), "authorization" | "proxy-authorization" | "cookie" | "set-cookie") {
		return Err(CustomAuthApplyError::SecretInPublicHeaders);
	}
	Ok(parsed)
}

/// Custom endpoint auth/header failure.
#[derive(Debug, thiserror::Error)]
pub enum CustomAuthApplyError {
	/// Public or secret header syntax is invalid.
	#[error("custom endpoint header is invalid")]
	InvalidHeader,
	/// A credential-bearing header was placed in the public catalog layer.
	#[error("credential-bearing custom headers must use a secret source")]
	SecretInPublicHeaders,
	/// Catalog credential application failed.
	#[error(transparent)]
	Credential(#[from] CredentialApplyError),
}

#[cfg(test)]
mod tests {
	use std::sync::atomic::{AtomicUsize, Ordering};

	use super::*;

	struct RotatingExecutor {
		calls: AtomicUsize,
	}

	impl super::super::CommandCredentialExecutor for RotatingExecutor {
		fn execute(&self, _: Str, _: CancellationToken) -> super::super::CommandExecutionFuture {
			let call = self.calls.fetch_add(1, Ordering::SeqCst);
			Box::pin(async move {
				Ok(SecretString::from(if call == 0 {
					"stale-header"
				} else {
					"fresh-header"
				}))
			})
		}
	}

	#[test]
	fn model_headers_override_provider_and_secret_values_are_sensitive() {
		let mut provider = BTreeMap::new();
		provider.insert(Str::new_static("x-route"), Str::new_static("provider"));
		let mut model = BTreeMap::new();
		model.insert(Str::new_static("x-route"), Str::new_static("model"));
		let mut request = Request::new(Bytes::new());
		apply_custom_auth(
			&mut request,
			&provider,
			&model,
			&[SecretHeader {
				name:  Str::new_static("x-api-key"),
				value: SecretString::from("secret-marker"),
			}],
			None,
			SystemTime::UNIX_EPOCH,
		)
		.expect("apply");
		assert_eq!(request.headers()["x-route"], "model");
		assert!(request.headers()["x-api-key"].is_sensitive());
		assert!(!format!("{:?}", request.headers()).contains("secret-marker"));
	}

	#[tokio::test]
	async fn unauthorized_refreshes_command_headers_exactly_once() {
		let executor = Arc::new(RotatingExecutor { calls: AtomicUsize::new(0) });
		let resolver = Arc::new(CommandCredentialResolver::new(
			executor.clone(),
			std::time::Duration::from_secs(1),
		));
		let mut retry = CommandHeaderRetry::new(resolver, [CommandHeaderSource::from_config(
			"x-tenant-token",
			"!resolve tenant token",
		)
		.expect("command source")]);
		let initial = retry
			.resolve(CancellationToken::new())
			.await
			.expect("initial headers");
		assert_eq!(initial[0].value.expose_secret(), "stale-header");

		let refreshed = retry
			.retry_after_status(StatusCode::UNAUTHORIZED, CancellationToken::new())
			.await
			.expect("refresh hook")
			.expect("first 401 refreshes");
		assert_eq!(refreshed[0].value.expose_secret(), "fresh-header");
		let mut request = Request::new(Bytes::new());
		apply_custom_auth(
			&mut request,
			&BTreeMap::new(),
			&BTreeMap::new(),
			&refreshed,
			None,
			SystemTime::UNIX_EPOCH,
		)
		.expect("apply refreshed headers");
		assert_eq!(request.headers()["x-tenant-token"], "fresh-header");
		assert!(request.headers()["x-tenant-token"].is_sensitive());
		assert!(
			retry
				.retry_after_status(StatusCode::UNAUTHORIZED, CancellationToken::new())
				.await
				.expect("second hook")
				.is_none()
		);
		assert_eq!(executor.calls.load(Ordering::SeqCst), 2);
	}

	#[test]
	fn authorization_cannot_enter_public_catalog_headers() {
		let mut provider = BTreeMap::new();
		provider.insert(Str::new_static("authorization"), Str::new_static("secret"));
		assert!(matches!(
			apply_custom_auth(
				&mut Request::new(Bytes::new()),
				&provider,
				&BTreeMap::new(),
				&[],
				None,
				SystemTime::UNIX_EPOCH,
			),
			Err(CustomAuthApplyError::SecretInPublicHeaders)
		));
	}
}
