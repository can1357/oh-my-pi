use std::{fmt, time::Duration};

use omp_core::{ExposeSecret as _, SecretString, Str};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;
use url::form_urlencoded;
use zeroize::Zeroizing;

use crate::{OAuthHttpClient, OAuthHttpRequest, OAuthRequestError, OAuthTransportError};

/// Authorization-code or refresh-token request parameters.
pub struct TokenRequest<'a> {
	/// Token endpoint.
	pub endpoint:      &'a str,
	/// Client identifier.
	pub client_id:     Option<&'a str>,
	/// Optional confidential-client secret.
	pub client_secret: Option<&'a SecretString>,
	/// RFC 8707 resource indicator.
	pub resource:      Option<&'a str>,
	/// Caller cancellation propagated into the HTTP exchange.
	pub cancellation:  Option<&'a CancellationToken>,
}

/// Validated secret-bearing token endpoint result.
pub struct TokenGrant {
	access_token:  SecretString,
	refresh_token: Option<SecretString>,
	token_type:    Str,
	expires_in:    Option<Duration>,
}

impl TokenGrant {
	/// Returns whether the grant can be refreshed.
	pub const fn is_refreshable(&self) -> bool {
		self.refresh_token.is_some()
	}

	/// Returns the non-secret token type.
	pub fn token_type(&self) -> &str {
		self.token_type.as_str()
	}

	/// Returns the relative expiry reported by the server.
	pub const fn expires_in(&self) -> Option<Duration> {
		self.expires_in
	}

	/// Consumes the grant into secret-bearing protocol parts.
	pub fn into_parts(self) -> (SecretString, Option<SecretString>, Str, Option<Duration>) {
		(self.access_token, self.refresh_token, self.token_type, self.expires_in)
	}
}

impl fmt::Debug for TokenGrant {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str("TokenGrant([REDACTED])")
	}
}

/// Token endpoint failed with secret-free typed evidence.
#[derive(Debug, thiserror::Error)]
pub enum TokenError {
	/// Endpoint request could not be constructed.
	#[error(transparent)]
	Request(#[from] OAuthRequestError),
	/// Transport failed.
	#[error(transparent)]
	Transport(#[from] OAuthTransportError),
	/// Endpoint rejected the grant.
	#[error("OAuth token endpoint rejected the grant with HTTP {status}")]
	Rejected {
		/// HTTP status.
		status: u16,
	},
	/// Endpoint returned OAuth error JSON despite a successful HTTP status.
	#[error("OAuth token endpoint returned provider error {code}")]
	Provider {
		/// Sanitized standard OAuth error code.
		code: Str,
	},
	/// Endpoint response was malformed or omitted the access token.
	#[error("OAuth token endpoint response is malformed")]
	Malformed,
}

#[derive(Deserialize)]
struct RawTokenResponse {
	access_token:      Option<String>,
	refresh_token:     Option<String>,
	token_type:        Option<String>,
	expires_in:        Option<u64>,
	error:             Option<String>,
	error_description: Option<String>,
}

/// Parses and validates a token response, retaining a previous refresh token
/// when the server rotates only the access token.
pub fn parse_token_response(
	body: &str,
	fallback_refresh: Option<SecretString>,
) -> Result<TokenGrant, TokenError> {
	let parsed: RawTokenResponse = serde_json::from_str(body).map_err(|_| TokenError::Malformed)?;
	if let Some(code) = parsed.error.filter(|value| !value.is_empty()) {
		let _ = parsed.error_description;
		return Err(TokenError::Provider { code: sanitized_provider_code(&code) });
	}
	let access_token = parsed
		.access_token
		.filter(|value| !value.is_empty())
		.ok_or(TokenError::Malformed)?;
	let token_type = parsed
		.token_type
		.filter(|value| !value.is_empty())
		.unwrap_or_else(|| "Bearer".to_owned());
	Ok(TokenGrant {
		access_token:  SecretString::from(access_token),
		refresh_token: parsed
			.refresh_token
			.filter(|value| !value.is_empty())
			.map(SecretString::from)
			.or(fallback_refresh),
		token_type:    Str::from(token_type),
		expires_in:    parsed.expires_in.map(Duration::from_secs),
	})
}

fn sanitized_provider_code(code: &str) -> Str {
	if code.len() <= 64
		&& code
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
	{
		Str::from(code)
	} else {
		Str::new_static("unknown")
	}
}

/// Exchanges an authorization code using PKCE S256.
pub async fn exchange_authorization_code(
	http: &dyn OAuthHttpClient,
	request: &TokenRequest<'_>,
	code: &SecretString,
	redirect_uri: &str,
	verifier: &SecretString,
) -> Result<TokenGrant, TokenError> {
	let mut fields = vec![
		("grant_type", "authorization_code"),
		("code", code.expose_secret()),
		("redirect_uri", redirect_uri),
		("code_verifier", verifier.expose_secret()),
	];
	append_public_fields(&mut fields, request);
	post_form(http, request.endpoint, &fields, None, request.cancellation).await
}

/// Refreshes a grant and retains `refresh` when the server omits rotation.
#[tracing::instrument(
	name = "oauth_token_refresh",
	level = "debug",
	skip_all,
	fields(
		has_client_id = request.client_id.is_some(),
		confidential_client = request.client_secret.is_some(),
		resource_bound = request.resource.is_some(),
	)
)]
pub async fn refresh_token(
	http: &dyn OAuthHttpClient,
	request: &TokenRequest<'_>,
	refresh: SecretString,
) -> Result<TokenGrant, TokenError> {
	tracing::debug!("OAuth token refresh preflight completed");
	let body = {
		let mut fields =
			vec![("grant_type", "refresh_token"), ("refresh_token", refresh.expose_secret())];
		append_public_fields(&mut fields, request);
		encode_form(&fields)
	};
	let result =
		post_encoded_form(http, request.endpoint, body, Some(refresh), request.cancellation).await;
	match &result {
		Ok(grant) => tracing::debug!(
			refreshable = grant.is_refreshable(),
			has_expiry = grant.expires_in().is_some(),
			"OAuth token refresh completed"
		),
		Err(error) => tracing::warn!(%error, "OAuth token refresh failed"),
	}
	result
}

fn append_public_fields<'a>(fields: &mut Vec<(&'a str, &'a str)>, request: &'a TokenRequest<'a>) {
	if let Some(client_id) = request.client_id {
		fields.push(("client_id", client_id));
	}
	if let Some(client_secret) = request.client_secret {
		fields.push(("client_secret", client_secret.expose_secret()));
	}
	if let Some(resource) = request.resource {
		fields.push(("resource", resource));
	}
}

async fn post_form(
	http: &dyn OAuthHttpClient,
	endpoint: &str,
	fields: &[(&str, &str)],
	fallback_refresh: Option<SecretString>,
	cancellation: Option<&CancellationToken>,
) -> Result<TokenGrant, TokenError> {
	post_encoded_form(http, endpoint, encode_form(fields), fallback_refresh, cancellation).await
}

fn encode_form(fields: &[(&str, &str)]) -> Zeroizing<String> {
	let mut serializer = form_urlencoded::Serializer::new(String::new());
	for (name, value) in fields {
		serializer.append_pair(name, value);
	}
	Zeroizing::new(serializer.finish())
}

async fn post_encoded_form(
	http: &dyn OAuthHttpClient,
	endpoint: &str,
	mut body: Zeroizing<String>,
	fallback_refresh: Option<SecretString>,
	cancellation: Option<&CancellationToken>,
) -> Result<TokenGrant, TokenError> {
	let request =
		OAuthHttpRequest::secret_form(endpoint, SecretString::from(std::mem::take(&mut *body)))?;
	let request = if let Some(cancellation) = cancellation {
		request.with_cancellation(cancellation.child_token())
	} else {
		request
	};
	let response = http.execute(request).await?;
	if !(200..300).contains(&response.status) {
		return Err(TokenError::Rejected { status: response.status });
	}
	parse_token_response(response.body.expose_secret(), fallback_refresh)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn token_validation_and_refresh_retention() {
		let old = SecretString::from("old-refresh".to_owned());
		let grant = parse_token_response(
			r#"{"access_token":"access","token_type":"Bearer","expires_in":60}"#,
			Some(old),
		)
		.expect("valid grant");
		assert!(grant.is_refreshable());
		assert_eq!(grant.expires_in(), Some(Duration::from_secs(60)));
		let (_, refresh, ..) = grant.into_parts();
		assert_eq!(refresh.expect("retained refresh").expose_secret(), "old-refresh");
	}

	#[test]
	fn successful_http_error_body_is_rejected() {
		let error =
			parse_token_response(r#"{"error":"invalid_grant","error_description":"expired"}"#, None)
				.expect_err("provider error");
		assert!(matches!(error, TokenError::Provider { .. }));
	}

	#[test]
	fn provider_error_code_never_carries_untrusted_diagnostics() {
		let error = parse_token_response(
			r#"{"error":"secret token=do-not-render","error_description":"also secret"}"#,
			None,
		)
		.expect_err("provider error");
		assert!(matches!(
			error,
			TokenError::Provider { code } if code.as_str() == "unknown"
		));
	}
}
