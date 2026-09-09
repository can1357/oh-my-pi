use std::fmt;

use omp_core::{SecretString, Str, ct_eq};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{
	OAuthHttpClient, PkceMaterial, TokenError, TokenGrant, TokenRequest, exchange_authorization_code,
};

/// Inputs to a native authorization-code PKCE request.
pub struct AuthorizationRequest<'a> {
	/// Authorization endpoint from validated server metadata.
	pub authorization_endpoint: &'a str,
	/// Public or dynamically registered client identifier.
	pub client_id:              &'a str,
	/// Exact callback redirect URI.
	pub redirect_uri:           &'a str,
	/// Requested scopes.
	pub scopes:                 &'a [Str],
	/// RFC 8707 protected resource indicator.
	pub resource:               Option<&'a str>,
	/// Optional provider prompt override.
	pub prompt:                 Option<&'a str>,
}

/// Validated browser URL and secret PKCE material retained for token exchange.
pub struct PendingAuthorization {
	/// URL safe to open in the user's browser.
	pub browser_url:  Url,
	/// PKCE verifier, challenge, and state.
	pub pkce:         PkceMaterial,
	/// Exact redirect URI bound to this attempt.
	pub redirect_uri: Str,
	/// Resource indicator admitted to authorization and token exchange.
	pub resource:     Option<Str>,
}

impl fmt::Debug for PendingAuthorization {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("PendingAuthorization")
			.field("browser_url", &"[REDACTED]")
			.field("pkce", &"[REDACTED]")
			.field("redirect_uri", &"[REDACTED]")
			.field("resource", &self.resource.as_ref().map(|_| "[REDACTED]"))
			.finish()
	}
}

/// Authorization request construction failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AuthorizationError {
	/// Endpoint, redirect, or resource URL is invalid.
	#[error("OAuth authorization request contains an invalid URL")]
	InvalidUrl,
	/// Client identity is empty.
	#[error("OAuth authorization request has no client identifier")]
	MissingClient,
}

/// Constructs a browser authorization URL using PKCE S256.
///
/// `offline_access` and `consent` are injected only when a refresh grant is
/// useful and the caller did not supply a conflicting provider override.
pub fn begin_authorization(
	request: AuthorizationRequest<'_>,
	pkce: PkceMaterial,
) -> Result<PendingAuthorization, AuthorizationError> {
	if request.client_id.trim().is_empty() {
		return Err(AuthorizationError::MissingClient);
	}
	let mut endpoint = checked_http_url(request.authorization_endpoint)?;
	let retained_query = endpoint
		.query_pairs()
		.filter(|(name, _)| {
			!matches!(
				name.as_ref(),
				"response_type"
					| "client_id"
					| "redirect_uri"
					| "code_challenge"
					| "code_challenge_method"
					| "state" | "scope"
					| "resource"
					| "prompt"
			)
		})
		.map(|(name, value)| (name.into_owned(), value.into_owned()))
		.collect::<Vec<_>>();
	endpoint.set_query(None);
	let redirect = checked_http_url(request.redirect_uri)?;
	let resource = request
		.resource
		.map(|resource| filter_resource(resource, &endpoint))
		.transpose()?
		.flatten();
	let mut scopes = request
		.scopes
		.iter()
		.map(Str::as_str)
		.filter(|scope| !scope.is_empty())
		.collect::<Vec<_>>();
	if !scopes.contains(&"offline_access") {
		scopes.push("offline_access");
	}
	scopes.sort_unstable();
	scopes.dedup();
	{
		let mut query = endpoint.query_pairs_mut();
		for (name, value) in &retained_query {
			query.append_pair(name, value);
		}
		query.append_pair("response_type", "code");
		query.append_pair("client_id", request.client_id);
		query.append_pair("redirect_uri", redirect.as_str());
		query.append_pair("code_challenge", pkce.challenge());
		query.append_pair("code_challenge_method", "S256");
		query.append_pair("state", pkce.state());
		if !scopes.is_empty() {
			query.append_pair("scope", &scopes.join(" "));
		}
		if let Some(resource) = resource.as_ref() {
			query.append_pair("resource", resource.as_str());
		}
		if let Some(prompt) = request.prompt.filter(|prompt| !prompt.trim().is_empty()) {
			query.append_pair("prompt", prompt);
		} else {
			query.append_pair("prompt", "consent");
		}
	}
	Ok(PendingAuthorization {
		browser_url: endpoint,
		pkce,
		redirect_uri: Str::from(redirect.as_str()),
		resource: resource.map(|url| Str::from(url.as_str())),
	})
}

/// Exchanges a callback grant after constant-time state validation.
pub async fn complete_authorization(
	http: &dyn OAuthHttpClient,
	token_endpoint: &str,
	client_id: &str,
	client_secret: Option<&SecretString>,
	cancel: &CancellationToken,
	pending: PendingAuthorization,
	code: SecretString,
	returned_state: &str,
) -> Result<TokenGrant, CompleteAuthorizationError> {
	if !ct_eq(pending.pkce.state().as_bytes(), returned_state.as_bytes()) {
		return Err(CompleteAuthorizationError::StateMismatch);
	}
	let (verifier, ..) = pending.pkce.into_parts();
	let request = TokenRequest {
		endpoint: token_endpoint,
		client_id: Some(client_id),
		client_secret,
		resource: pending.resource.as_deref(),
		cancellation: Some(cancel),
	};
	exchange_authorization_code(http, &request, &code, pending.redirect_uri.as_str(), &verifier)
		.await
		.map_err(CompleteAuthorizationError::Token)
}

/// Final authorization failure.
#[derive(Debug, thiserror::Error)]
pub enum CompleteAuthorizationError {
	/// Callback state did not match the pending attempt.
	#[error("OAuth callback state did not match")]
	StateMismatch,
	/// Token endpoint rejected or malformed the exchange.
	#[error(transparent)]
	Token(#[from] TokenError),
}

fn checked_http_url(value: &str) -> Result<Url, AuthorizationError> {
	let url = Url::parse(value).map_err(|_| AuthorizationError::InvalidUrl)?;
	if !matches!(url.scheme(), "http" | "https")
		|| url.host().is_none()
		|| !url.username().is_empty()
		|| url.password().is_some()
		|| url.fragment().is_some()
	{
		return Err(AuthorizationError::InvalidUrl);
	}
	Ok(url)
}

fn filter_resource(
	value: &str,
	_authorization_endpoint: &Url,
) -> Result<Option<Url>, AuthorizationError> {
	checked_http_url(value).map(Some)
}
