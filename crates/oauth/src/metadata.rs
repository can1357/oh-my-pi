use std::collections::BTreeSet;

use http::{HeaderMap, Method};
use omp_core::{ExposeSecret as _, Str};
use serde::Deserialize;
use url::Url;

use crate::{OAuthHttpClient, OAuthHttpRequest};

/// RFC 9728 protected-resource metadata relevant to an OAuth client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProtectedResourceMetadata {
	/// Protected resource identifier.
	pub resource:              Option<Str>,
	/// Ordered authorization-server issuers.
	pub authorization_servers: Box<[Str]>,
	/// Space-separated scopes requested by the resource.
	pub scopes:                Box<[Str]>,
}

/// RFC 8414/OIDC authorization-server metadata relevant to a native client.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthorizationServerMetadata {
	/// Validated issuer.
	pub issuer: Str,
	/// Optional browser authorization endpoint. Device-only issuers may omit it.
	pub authorization_endpoint: Option<Str>,
	/// Token endpoint.
	pub token_endpoint: Str,
	/// Optional RFC 7591 registration endpoint.
	pub registration_endpoint: Option<Str>,
	/// Optional RFC 8628 device authorization endpoint.
	pub device_authorization_endpoint: Option<Str>,
	/// Advertised scopes.
	pub scopes_supported: Box<[Str]>,
}

/// OAuth metadata was malformed or did not describe the requested issuer.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MetadataError {
	/// Metadata JSON was malformed.
	#[error("OAuth metadata JSON is malformed")]
	Malformed,
	/// A required endpoint was missing or not HTTP(S).
	#[error("OAuth metadata endpoint is invalid")]
	InvalidEndpoint,
	/// RFC 8414 issuer did not match the issuer used for discovery.
	#[error("OAuth metadata issuer does not match the requested issuer")]
	IssuerMismatch,
	/// Every deterministic metadata candidate was absent or rejected.
	#[error("OAuth metadata could not be discovered")]
	NotFound,
	/// Metadata transport failed.
	#[error("OAuth metadata request failed")]
	Transport,
}
/// Deterministic RFC 9728 protected-resource metadata candidates.
pub fn protected_resource_candidates(resource: &str) -> Vec<Url> {
	let Ok(base) = Url::parse(resource) else {
		return Vec::new();
	};
	if !matches!(base.scheme(), "http" | "https")
		|| base.host().is_none()
		|| !base.username().is_empty()
		|| base.password().is_some()
		|| base.fragment().is_some()
	{
		return Vec::new();
	}
	let path = base.path().trim_end_matches('/');
	let mut candidates = Vec::with_capacity(2);
	if !path.is_empty() {
		let value = format!(
			"{}://{}/.well-known/oauth-protected-resource{path}",
			base.scheme(),
			base.authority()
		);
		if let Ok(url) = Url::parse(&value) {
			candidates.push(url);
		}
	}
	let value =
		format!("{}://{}/.well-known/oauth-protected-resource", base.scheme(), base.authority());
	if let Ok(url) = Url::parse(&value)
		&& !candidates.iter().any(|candidate| candidate == &url)
	{
		candidates.push(url);
	}
	candidates
}

/// Probes RFC 9728 candidates in deterministic path-first order.
pub async fn discover_protected_resource_metadata(
	http: &dyn OAuthHttpClient,
	resource: &str,
	explicit_metadata_url: Option<&str>,
) -> Result<ProtectedResourceMetadata, MetadataError> {
	let candidates = if let Some(explicit) = explicit_metadata_url {
		vec![Url::parse(explicit).map_err(|_| MetadataError::InvalidEndpoint)?]
	} else {
		protected_resource_candidates(resource)
	};
	for candidate in candidates {
		match fetch_metadata(http, &candidate).await? {
			Some(body) => return parse_protected_resource_metadata(&body),
			None => continue,
		}
	}
	Err(MetadataError::NotFound)
}

/// Probes RFC 8414 then OIDC metadata candidates and strictly checks issuer.
pub async fn discover_authorization_server_metadata(
	http: &dyn OAuthHttpClient,
	issuer: &str,
) -> Result<AuthorizationServerMetadata, MetadataError> {
	for candidate in metadata_candidates(issuer) {
		match fetch_metadata(http, &candidate).await? {
			Some(body) => match parse_authorization_server_metadata(&body, issuer) {
				Ok(metadata) => return Ok(metadata),
				Err(MetadataError::IssuerMismatch) => continue,
				Err(error) => return Err(error),
			},
			None => continue,
		}
	}
	Err(MetadataError::NotFound)
}

async fn fetch_metadata(
	http: &dyn OAuthHttpClient,
	url: &Url,
) -> Result<Option<String>, MetadataError> {
	let request = OAuthHttpRequest::new(Method::GET, url.as_str(), HeaderMap::new(), None)
		.map_err(|_| MetadataError::InvalidEndpoint)?;
	let response = http
		.execute(request)
		.await
		.map_err(|_| MetadataError::Transport)?;
	if !(200..300).contains(&response.status) {
		return Ok(None);
	}
	Ok(Some(response.body.expose_secret().to_owned()))
}

#[derive(Deserialize)]
struct RawProtected {
	resource:              Option<String>,
	#[serde(default)]
	authorization_servers: Vec<String>,
	#[serde(default)]
	scopes_supported:      Vec<String>,
}

#[derive(Deserialize)]
struct RawAuthorization {
	issuer: String,
	authorization_endpoint: Option<String>,
	token_endpoint: String,
	registration_endpoint: Option<String>,
	device_authorization_endpoint: Option<String>,
	#[serde(default)]
	scopes_supported: Vec<String>,
}

/// Parses RFC 9728 protected-resource metadata with URL validation.
pub fn parse_protected_resource_metadata(
	body: &str,
) -> Result<ProtectedResourceMetadata, MetadataError> {
	let raw: RawProtected = serde_json::from_str(body).map_err(|_| MetadataError::Malformed)?;
	let resource = raw.resource.map(valid_http_url).transpose()?.map(Str::from);
	let authorization_servers = raw
		.authorization_servers
		.into_iter()
		.map(valid_http_url)
		.collect::<Result<Vec<_>, _>>()?
		.into_iter()
		.map(Str::from)
		.collect::<Vec<_>>()
		.into_boxed_slice();
	let scopes = normalized_scopes(raw.scopes_supported);
	Ok(ProtectedResourceMetadata { resource, authorization_servers, scopes })
}

/// Parses and strictly validates RFC 8414 authorization-server metadata.
pub fn parse_authorization_server_metadata(
	body: &str,
	expected_issuer: &str,
) -> Result<AuthorizationServerMetadata, MetadataError> {
	let raw: RawAuthorization = serde_json::from_str(body).map_err(|_| MetadataError::Malformed)?;
	let issuer = valid_http_url(raw.issuer)?;
	let expected = valid_http_url(expected_issuer.to_owned())?;
	if normalize_issuer(&issuer) != normalize_issuer(&expected) {
		return Err(MetadataError::IssuerMismatch);
	}
	let authorization_endpoint = raw
		.authorization_endpoint
		.map(valid_http_url)
		.transpose()?
		.map(Str::from);
	let token_endpoint = valid_http_url(raw.token_endpoint)?;
	let registration_endpoint = raw
		.registration_endpoint
		.map(valid_http_url)
		.transpose()?
		.map(Str::from);
	let device_authorization_endpoint = raw
		.device_authorization_endpoint
		.map(valid_http_url)
		.transpose()?
		.map(Str::from);
	Ok(AuthorizationServerMetadata {
		issuer: Str::from(issuer),
		authorization_endpoint,
		token_endpoint: Str::from(token_endpoint),
		registration_endpoint,
		device_authorization_endpoint,
		scopes_supported: normalized_scopes(raw.scopes_supported),
	})
}

/// Builds deterministic RFC 8414/OIDC metadata candidates for a possibly
/// path-scoped issuer. The path-prefixed form is tried before the origin form.
pub fn metadata_candidates(issuer: &str) -> Vec<Url> {
	let Ok(base) = Url::parse(issuer) else {
		return Vec::new();
	};
	if !matches!(base.scheme(), "http" | "https")
		|| base.host().is_none()
		|| !base.username().is_empty()
		|| base.password().is_some()
		|| base.fragment().is_some()
	{
		return Vec::new();
	}
	let path = base.path().trim_end_matches('/');
	let mut candidates = Vec::with_capacity(4);
	let mut seen = BTreeSet::new();
	for suffix in ["oauth-authorization-server", "openid-configuration"] {
		if !path.is_empty() {
			let value = format!("{}://{}/.well-known/{suffix}{path}", base.scheme(), base.authority());
			if let Ok(url) = Url::parse(&value)
				&& seen.insert(url.as_str().to_owned())
			{
				candidates.push(url);
			}
		}
		let value = format!("{}://{}/.well-known/{suffix}", base.scheme(), base.authority());
		if let Ok(url) = Url::parse(&value)
			&& seen.insert(url.as_str().to_owned())
		{
			candidates.push(url);
		}
	}
	candidates
}

fn valid_http_url(value: String) -> Result<String, MetadataError> {
	let parsed = Url::parse(&value).map_err(|_| MetadataError::InvalidEndpoint)?;
	if !matches!(parsed.scheme(), "http" | "https")
		|| parsed.host().is_none()
		|| !parsed.username().is_empty()
		|| parsed.password().is_some()
		|| parsed.fragment().is_some()
	{
		return Err(MetadataError::InvalidEndpoint);
	}
	Ok(value)
}

fn normalize_issuer(value: &str) -> String {
	value.trim_end_matches('/').to_owned()
}

fn normalized_scopes(values: Vec<String>) -> Box<[Str]> {
	let mut values = values
		.into_iter()
		.filter(|value| !value.trim().is_empty())
		.map(Str::from)
		.collect::<Vec<_>>();
	values.sort_unstable();
	values.dedup();
	values.into_boxed_slice()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn issuer_mismatch_is_rejected() {
		let body = r#"{"issuer":"https://wrong.example","authorization_endpoint":"https://wrong.example/auth","token_endpoint":"https://wrong.example/token"}"#;
		assert_eq!(
			parse_authorization_server_metadata(body, "https://right.example"),
			Err(MetadataError::IssuerMismatch)
		);
	}

	#[test]
	fn device_endpoint_is_discovered_and_credentials_are_rejected() {
		let body = r#"{"issuer":"https://auth.example","authorization_endpoint":"https://auth.example/authorize","token_endpoint":"https://auth.example/token","device_authorization_endpoint":"https://auth.example/device"}"#;
		let metadata =
			parse_authorization_server_metadata(body, "https://auth.example").expect("valid metadata");
		assert_eq!(
			metadata.device_authorization_endpoint.as_deref(),
			Some("https://auth.example/device")
		);

		let unsafe_body = r#"{"issuer":"https://auth.example","authorization_endpoint":"https://user:secret@auth.example/authorize","token_endpoint":"https://auth.example/token"}"#;
		assert_eq!(
			parse_authorization_server_metadata(unsafe_body, "https://auth.example"),
			Err(MetadataError::InvalidEndpoint)
		);
	}

	#[test]
	fn path_issuer_candidates_are_deterministic() {
		let candidates = metadata_candidates("https://mcp.example/gateway/team");
		assert_eq!(candidates.len(), 4);
		assert!(
			candidates[0]
				.as_str()
				.ends_with("/.well-known/oauth-authorization-server/gateway/team")
		);
	}
}
