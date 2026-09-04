//! Typed extension-provider callback contracts.

use std::{fmt, future::Future, pin::Pin};

use http::{HeaderName, HeaderValue, Request, Uri};
use omp_catalog::{ProviderId, RouteId};
use omp_core::{ExposeSecret as _, SecretString, Str};
use serde_json::{Map as JsonMap, Value as JsonValue};
use url::Url;

use super::RequestHeader;
use crate::call::AuthMethod;

/// Credential material returned by an extension-owned login or refresh hook.
pub struct ProviderHookCredential {
	/// Closed SDK credential kind spelling.
	pub kind:          Str,
	/// Current request credential.
	pub secret:        SecretString,
	/// Renewable token retained only by the encrypted credential store.
	pub refresh_token: Option<SecretString>,
	/// Absolute expiry in Unix milliseconds.
	pub expires_at_ms: Option<u64>,
	/// Stable provider identity used for account affinity.
	pub identity:      Option<Str>,
	/// Bounded provider-specific scalar metadata.
	pub props:         JsonMap<String, JsonValue>,
}

impl fmt::Debug for ProviderHookCredential {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ProviderHookCredential")
			.field("kind", &self.kind)
			.field("secret", &"[REDACTED]")
			.field("refresh_token", &self.refresh_token.as_ref().map(|_| "[REDACTED]"))
			.field("expires_at_ms", &self.expires_at_ms)
			.field("identity", &self.identity)
			.field("props", &self.props)
			.finish()
	}
}

/// Exact extension login invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderLoginHookRequest {
	/// Catalog provider identity.
	pub provider: ProviderId,
	/// Interactive authentication method requested by the caller.
	pub method:   AuthMethod,
}

/// Why an extension credential refresh is running.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "snake_case")]
pub enum ProviderRefreshReason {
	/// Credential is at or inside its proactive expiry window.
	Expiring,
	/// Provider rejected the current generation.
	Rejected401,
	/// Caller explicitly requested renewal.
	Manual,
	/// Background scheduler requested renewal.
	Scheduled,
}

/// Exact extension refresh invocation.
pub struct ProviderRefreshHookRequest {
	/// Catalog provider identity.
	pub provider:      ProviderId,
	/// Stable provider identity, when known.
	pub identity:      Option<Str>,
	/// Current renewable token, scoped to this callback.
	pub refresh_token: SecretString,
	/// Current absolute expiry in Unix milliseconds.
	pub expires_at_ms: Option<u64>,
	/// Provider-specific scalar metadata from the stored generation.
	pub props:         JsonMap<String, JsonValue>,
	/// Refresh trigger.
	pub reason:        ProviderRefreshReason,
}

impl fmt::Debug for ProviderRefreshHookRequest {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ProviderRefreshHookRequest")
			.field("provider", &self.provider)
			.field("identity", &self.identity)
			.field("refresh_token", &"[REDACTED]")
			.field("expires_at_ms", &self.expires_at_ms)
			.field("props", &self.props)
			.field("reason", &self.reason)
			.finish()
	}
}

/// Secret-free finalized request facts sent to `provider_sign`.
#[derive(Clone, Debug)]
pub struct ProviderSignHookRequest {
	/// Catalog provider identity.
	pub provider:    ProviderId,
	/// Concrete route identity.
	pub route:       RouteId,
	/// HTTP method spelling.
	pub method:      Str,
	/// Absolute request URL without credential query material.
	pub url:         Str,
	/// Public request headers only.
	pub headers:     Box<[RequestHeader]>,
	/// SHA-256 digest of the finalized request body.
	pub body_sha256: [u8; 32],
}

/// Sensitive request additions returned by `provider_sign`.
#[derive(Clone)]
pub struct ProviderSignature {
	/// Headers applied only at the innermost transport boundary.
	pub headers: Box<[(Str, SecretString)]>,
	/// Query parameters applied only at the innermost transport boundary.
	pub query:   Box<[(Str, SecretString)]>,
}

impl ProviderSignature {
	pub(crate) fn apply<B>(&self, request: &mut Request<B>) -> Result<(), ProviderSignatureError> {
		for (name, value) in &self.headers {
			let name = HeaderName::from_bytes(name.as_bytes())
				.map_err(|_| ProviderSignatureError::InvalidHeader)?;
			let mut value = HeaderValue::from_bytes(value.expose_secret().as_bytes())
				.map_err(|_| ProviderSignatureError::InvalidHeader)?;
			value.set_sensitive(true);
			request.headers_mut().insert(name, value);
		}
		if !self.query.is_empty() {
			let mut url = Url::parse(&request.uri().to_string())
				.map_err(|_| ProviderSignatureError::InvalidUri)?;
			{
				let mut query = url.query_pairs_mut();
				for (name, value) in &self.query {
					query.append_pair(name.as_str(), value.expose_secret());
				}
			}
			*request.uri_mut() = url
				.as_str()
				.parse::<Uri>()
				.map_err(|_| ProviderSignatureError::InvalidUri)?;
		}
		Ok(())
	}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub(crate) enum ProviderSignatureError {
	#[error("provider signature contains an invalid header")]
	InvalidHeader,
	#[error("provider signature contains an invalid query parameter")]
	InvalidUri,
}

impl fmt::Debug for ProviderSignature {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ProviderSignature")
			.field("header_count", &self.headers.len())
			.field("query_count", &self.query.len())
			.finish()
	}
}

/// Extension model-discovery invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelsDiscoverHookRequest {
	/// Catalog provider identity.
	pub provider:  ProviderId,
	/// Concrete route identity.
	pub route:     RouteId,
	/// Opaque page cursor returned by the previous invocation.
	pub cursor:    Option<Str>,
	/// Requested maximum page size.
	pub page_size: Option<u32>,
	/// SDK trigger spelling.
	pub trigger:   Str,
}

/// One extension model-discovery page in SDK `ModelSpec` wire shape.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModelsDiscoverHookPage {
	/// SDK model rows, validated and lowered by the driver catalog owner.
	pub models:        Box<[JsonValue]>,
	/// Cursor for a subsequent page.
	pub next_cursor:   Option<Str>,
	/// Whether absent prior extension rows must be retired.
	pub authoritative: bool,
}

/// Provider hook failure. Credential-gating callers fail closed; discovery
/// callers retain their previous rows.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProviderHookError {
	/// No live matching callback exists.
	#[error("provider hook is unavailable")]
	Unavailable,
	/// The callback failed or explicitly rejected the operation.
	#[error("provider hook failed")]
	Failed,
	/// The callback returned a value outside its SDK contract.
	#[error("provider hook returned an invalid result")]
	InvalidResult,
}

/// Object-safe callback surface implemented by the extension host composer.
pub trait ProviderHookObserver: Send + Sync + 'static {
	/// Returns whether `provider_login` has a handler for `provider`.
	fn provider_login_subscribed(&self, _provider: &ProviderId<str>) -> bool {
		false
	}

	/// Runs one extension-owned interactive login. Failures gate credential
	/// creation and therefore fail closed.
	fn provider_login<'a>(
		&'a self,
		_request: ProviderLoginHookRequest,
	) -> Pin<Box<dyn Future<Output = Result<ProviderHookCredential, ProviderHookError>> + Send + 'a>>
	{
		Box::pin(async { Err(ProviderHookError::Unavailable) })
	}

	/// Returns whether `provider_refresh` has a handler for `provider`.
	fn provider_refresh_subscribed(&self, _provider: &ProviderId<str>) -> bool {
		false
	}

	/// Runs one serialized extension credential refresh. Failures gate the
	/// credential generation and therefore fail closed.
	fn provider_refresh<'a>(
		&'a self,
		_request: ProviderRefreshHookRequest,
	) -> Pin<Box<dyn Future<Output = Result<ProviderHookCredential, ProviderHookError>> + Send + 'a>>
	{
		Box::pin(async { Err(ProviderHookError::Unavailable) })
	}

	/// Returns whether `provider_sign` has a handler for `provider`.
	fn provider_sign_subscribed(&self, _provider: &ProviderId<str>) -> bool {
		false
	}

	/// Signs one exact attempt. Failures gate transmission and therefore fail
	/// closed.
	fn provider_sign<'a>(
		&'a self,
		_request: ProviderSignHookRequest,
	) -> Pin<Box<dyn Future<Output = Result<ProviderSignature, ProviderHookError>> + Send + 'a>> {
		Box::pin(async { Err(ProviderHookError::Unavailable) })
	}

	/// Returns whether `models_discover` has a handler for `provider`.
	fn models_discover_subscribed(&self, _provider: &ProviderId<str>) -> bool {
		false
	}

	/// Runs one extension model discovery page. Callers fail open by retaining
	/// the last published rows.
	fn models_discover<'a>(
		&'a self,
		_request: ModelsDiscoverHookRequest,
	) -> Pin<Box<dyn Future<Output = Result<ModelsDiscoverHookPage, ProviderHookError>> + Send + 'a>>
	{
		Box::pin(async { Err(ProviderHookError::Unavailable) })
	}
}
