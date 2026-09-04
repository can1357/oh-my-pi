use std::{fmt, mem, net};

use http::{HeaderMap, HeaderValue, Method, header::CONTENT_TYPE};
use omp_core::{ExposeSecret as _, SecretString, Str};
use serde::{Deserialize, Serialize};
use url::Url;
use zeroize::Zeroizing;

use crate::{OAuthHttpClient, OAuthHttpRequest, OAuthRequestError, OAuthTransportError};

/// RFC 7591 native-client registration request.
#[derive(Debug, Serialize)]
pub struct ClientRegistrationRequest<'a> {
	/// Redirect URIs accepted by the loopback callback.
	pub redirect_uris:              &'a [&'a str],
	/// Human-readable client name.
	pub client_name:                &'a str,
	/// OAuth grant types used by this client.
	pub grant_types:                &'a [&'a str],
	/// OAuth response types used by this client.
	pub response_types:             &'a [&'a str],
	/// Native clients do not authenticate at the token endpoint.
	pub token_endpoint_auth_method: &'a str,
}

impl<'a> ClientRegistrationRequest<'a> {
	/// Constructs the native authorization-code PKCE declaration.
	pub const fn native(client_name: &'a str, redirect_uris: &'a [&'a str]) -> Self {
		Self {
			redirect_uris,
			client_name,
			grant_types: &["authorization_code", "refresh_token"],
			response_types: &["code"],
			token_endpoint_auth_method: "none",
		}
	}
}

/// Explicit client configuration or dynamically registered native client.
pub struct ClientRegistration {
	/// Registered client identifier.
	pub client_id:     Str,
	/// Optional confidential-client secret.
	pub client_secret: Option<SecretString>,
}

/// Configuration used before considering dynamic registration.
pub struct ClientConfiguration<'a> {
	/// Explicit public client identifier. When present DCR is never attempted.
	pub client_id:             Option<&'a str>,
	/// Explicit confidential secret retained by the credential authority.
	pub client_secret:         Option<&'a SecretString>,
	/// Advertised RFC 7591 endpoint.
	pub registration_endpoint: Option<&'a str>,
	/// Exact callback redirects accepted by the local flow.
	pub redirect_uris:         &'a [&'a str],
	/// Diagnostic native client name.
	pub client_name:           &'a str,
}

impl fmt::Debug for ClientRegistration {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ClientRegistration")
			.field("client_id", &self.client_id)
			.field("client_secret", &self.client_secret.as_ref().map(|_| "[REDACTED]"))
			.finish()
	}
}

/// Dynamic client registration failed with secret-free evidence.
#[derive(Debug, thiserror::Error)]
pub enum ClientRegistrationError {
	/// Registration endpoint was invalid.
	#[error(transparent)]
	Request(#[from] OAuthRequestError),
	/// Transport failed.
	#[error(transparent)]
	Transport(#[from] OAuthTransportError),
	/// Server rejected registration.
	#[error("OAuth client registration was rejected with HTTP {status}")]
	Rejected {
		/// HTTP status.
		status: u16,
	},
	/// Successful response omitted a usable client identifier.
	#[error("OAuth client registration response is malformed")]
	Malformed,
	/// No client ID or dynamic-registration endpoint is available.
	#[error("OAuth server requires an explicit client identifier")]
	RegistrationUnavailable,
	/// Dynamic registration redirect configuration is not a native callback.
	#[error("OAuth native-client redirect URI is invalid")]
	InvalidRedirect,
}

#[derive(Deserialize)]
struct RegistrationResponse {
	client_id:     Option<String>,
	client_secret: Option<String>,
}

/// Resolves explicit client configuration first, falling back to RFC 7591 only
/// when no client identifier was configured.
pub async fn resolve_client(
	http: &dyn OAuthHttpClient,
	config: ClientConfiguration<'_>,
) -> Result<ClientRegistration, ClientRegistrationError> {
	if let Some(client_id) = config.client_id.filter(|value| !value.trim().is_empty()) {
		return Ok(ClientRegistration {
			client_id:     Str::from(client_id),
			client_secret: config.client_secret.cloned(),
		});
	}
	let endpoint = config
		.registration_endpoint
		.ok_or(ClientRegistrationError::RegistrationUnavailable)?;
	if config.redirect_uris.is_empty()
		|| config
			.redirect_uris
			.iter()
			.any(|uri| !valid_native_redirect(uri))
	{
		return Err(ClientRegistrationError::InvalidRedirect);
	}
	register_client(
		http,
		endpoint,
		&ClientRegistrationRequest::native(config.client_name, config.redirect_uris),
	)
	.await
}

/// Registers a native client at an advertised RFC 7591 endpoint.
pub async fn register_client(
	http: &dyn OAuthHttpClient,
	endpoint: &str,
	request: &ClientRegistrationRequest<'_>,
) -> Result<ClientRegistration, ClientRegistrationError> {
	let mut body = Zeroizing::new(
		serde_json::to_string(request).map_err(|_| ClientRegistrationError::Malformed)?,
	);
	let mut headers = HeaderMap::new();
	headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
	let response = http
		.execute(OAuthHttpRequest::new(
			Method::POST,
			endpoint,
			headers,
			Some(SecretString::from(mem::take(&mut *body))),
		)?)
		.await?;
	if !(200..300).contains(&response.status) {
		return Err(ClientRegistrationError::Rejected { status: response.status });
	}
	let parsed: RegistrationResponse = serde_json::from_str(response.body.expose_secret())
		.map_err(|_| ClientRegistrationError::Malformed)?;
	let client_id = parsed
		.client_id
		.filter(|value| !value.trim().is_empty())
		.ok_or(ClientRegistrationError::Malformed)?;
	Ok(ClientRegistration {
		client_id:     Str::from(client_id),
		client_secret: parsed.client_secret.map(SecretString::from),
	})
}

fn valid_native_redirect(value: &str) -> bool {
	let Ok(url) = Url::parse(value) else {
		return false;
	};
	if url.fragment().is_some() || !url.username().is_empty() || url.password().is_some() {
		return false;
	}
	match (url.scheme(), url.host_str()) {
		("http", Some("localhost")) => true,
		("http", Some(host)) => host.parse::<net::IpAddr>().is_ok_and(|ip| ip.is_loopback()),
		("https", Some(_)) => true,
		_ => false,
	}
}
