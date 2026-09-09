use std::collections::BTreeMap;

use http::HeaderMap;
use omp_core::Str;
use serde_json::Value;
use url::Url;

/// Authentication mechanism identified from an MCP HTTP rejection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ChallengeKind {
	/// OAuth bearer authorization is available.
	OAuth,
	/// The peer explicitly requests an API key rather than OAuth.
	ApiKey,
	/// Authentication is required but no safe mechanism was identified.
	Unknown,
}

/// Secret-free authentication discovery evidence from one HTTP rejection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthChallenge {
	/// Classified authentication mechanism.
	pub kind:                   ChallengeKind,
	/// Authorization endpoint supplied directly by a legacy challenge/body.
	pub authorization_endpoint: Option<Str>,
	/// Token endpoint supplied directly by a legacy challenge/body.
	pub token_endpoint:         Option<Str>,
	/// RFC 7591 registration endpoint supplied directly by the peer.
	pub registration_endpoint:  Option<Str>,
	/// RFC 9728 protected-resource metadata URL.
	pub resource_metadata:      Option<Str>,
	/// Non-standard MCP authorization-server hint.
	pub auth_server:            Option<Str>,
	/// RFC 8707 protected resource indicator.
	pub resource:               Option<Str>,
	/// Normalized requested scopes.
	pub scopes:                 Box<[Str]>,
	/// Explicit public client identity, when supplied.
	pub client_id:              Option<Str>,
}

/// Parses HTTP challenge headers and a bounded JSON error body.
///
/// Header evidence wins over body aliases. Invalid endpoint URLs are ignored;
/// they are never forwarded into browser or token requests.
pub fn discover_auth_challenge(headers: &HeaderMap, body: &str) -> Option<AuthChallenge> {
	discover_auth_challenge_with_base(headers, body, None)
}

/// Parses a challenge while resolving relative MCP metadata hints against the
/// configured server URL.
pub fn discover_auth_challenge_with_base(
	headers: &HeaderMap,
	body: &str,
	server_url: Option<&str>,
) -> Option<AuthChallenge> {
	let www = headers
		.get_all(http::header::WWW_AUTHENTICATE)
		.iter()
		.filter_map(|value| value.to_str().ok())
		.collect::<Vec<_>>()
		.join(", ");
	let mut values = parse_parameters(&www);
	let json = serde_json::from_str::<Value>(body).ok();
	let object = json
		.as_ref()
		.and_then(find_auth_object)
		.or_else(|| json.as_ref().and_then(Value::as_object));
	for (canonical, aliases) in [
		(
			"authorization_endpoint",
			&[
				"authorization_endpoint",
				"authorization_url",
				"authorization_uri",
				"authorizationEndpoint",
				"authorizationUrl",
				"authorizationUri",
			][..],
		),
		(
			"token_endpoint",
			&["token_endpoint", "token_url", "token_uri", "tokenEndpoint", "tokenUrl", "tokenUri"][..],
		),
		(
			"registration_endpoint",
			&[
				"registration_endpoint",
				"registration_uri",
				"registrationEndpoint",
				"registrationUrl",
				"registrationUri",
				"registration_uri",
			][..],
		),
		("resource", &["resource", "resource_uri", "resourceUri"][..]),
		("client_id", &["client_id", "default_client_id", "public_client_id", "clientId"][..]),
		("scope", &["scope", "scopes"][..]),
	] {
		if values.contains_key(canonical) {
			continue;
		}
		if let Some(value) =
			object.and_then(|object| aliases.iter().find_map(|key| json_string(object.get(*key))))
		{
			values.insert(canonical.to_owned(), value.to_owned());
		}
	}
	if !values.contains_key("scope")
		&& let Some(scopes) = object
			.and_then(|object| object.get("scopes_supported"))
			.and_then(Value::as_array)
	{
		let joined = scopes
			.iter()
			.filter_map(Value::as_str)
			.collect::<Vec<_>>()
			.join(" ");
		if !joined.is_empty() {
			values.insert("scope".to_owned(), joined);
		}
	}
	let resource_metadata = header_url(headers, "resource_metadata", server_url).or_else(|| {
		values
			.get("resource_metadata")
			.and_then(|value| checked_url_with_base(value, server_url))
	});
	let auth_server = headers
		.get("mcp-auth-server")
		.and_then(|value| value.to_str().ok())
		.and_then(|value| checked_url_with_base(value, server_url))
		.or_else(|| {
			values
				.get("mcp-auth-server")
				.and_then(|value| checked_url_with_base(value, server_url))
		});
	let authorization_endpoint = values
		.get("authorization_endpoint")
		.and_then(|value| checked_url(value));
	if let Some(endpoint) = authorization_endpoint.as_deref()
		&& let Ok(url) = Url::parse(endpoint)
	{
		for (name, value) in url.query_pairs() {
			if matches!(name.as_ref(), "client_id" | "scope") && !value.trim().is_empty() {
				values
					.entry(name.into_owned())
					.or_insert_with(|| value.into_owned());
			}
		}
	}
	let token_endpoint = values
		.get("token_endpoint")
		.and_then(|value| checked_url(value));
	let registration_endpoint = values
		.get("registration_endpoint")
		.and_then(|value| checked_url(value));
	let resource = values.get("resource").and_then(|value| checked_url(value));
	let lower = format!("{} {body}", www.to_ascii_lowercase()).to_ascii_lowercase();
	let kind = if authorization_endpoint.is_some()
		|| token_endpoint.is_some()
		|| resource_metadata.is_some()
		|| auth_server.is_some()
		|| lower.contains("bearer")
	{
		ChallengeKind::OAuth
	} else if lower.contains("api key") || lower.contains("api_key") || lower.contains("x-api-key") {
		ChallengeKind::ApiKey
	} else if !www.is_empty() || object.is_some() {
		ChallengeKind::Unknown
	} else {
		return None;
	};
	Some(AuthChallenge {
		kind,
		authorization_endpoint,
		token_endpoint,
		registration_endpoint,
		resource_metadata,
		auth_server,
		resource,
		scopes: normalize_scopes(values.get("scope").map(String::as_str)),
		client_id: values
			.get("client_id")
			.filter(|value| !value.trim().is_empty())
			.map(|value| Str::from(value.as_str())),
	})
}

fn find_auth_object(value: &Value) -> Option<&serde_json::Map<String, Value>> {
	let object = value.as_object()?;
	["oauth", "authorization", "auth"]
		.into_iter()
		.find_map(|key| object.get(key).and_then(Value::as_object))
}

fn json_string(value: Option<&Value>) -> Option<&str> {
	value
		.and_then(Value::as_str)
		.filter(|value| !value.trim().is_empty())
}

fn parse_parameters(input: &str) -> BTreeMap<String, String> {
	let mut output = BTreeMap::new();
	let bytes = input.as_bytes();
	let mut cursor = 0;
	while cursor < bytes.len() {
		while cursor < bytes.len() && !(bytes[cursor].is_ascii_alphabetic() || bytes[cursor] == b'_')
		{
			cursor += 1;
		}
		let start = cursor;
		while cursor < bytes.len()
			&& (bytes[cursor].is_ascii_alphanumeric() || matches!(bytes[cursor], b'_' | b'-'))
		{
			cursor += 1;
		}
		let key = input[start..cursor].to_ascii_lowercase();
		while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
			cursor += 1;
		}
		if cursor >= bytes.len() || bytes[cursor] != b'=' {
			continue;
		}
		cursor += 1;
		while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
			cursor += 1;
		}
		let value = if cursor < bytes.len() && bytes[cursor] == b'"' {
			cursor += 1;
			let start = cursor;
			while cursor < bytes.len() && bytes[cursor] != b'"' {
				cursor += 1;
			}
			let value = input[start..cursor].to_owned();
			cursor = cursor.saturating_add(1);
			value
		} else {
			let start = cursor;
			while cursor < bytes.len() && !matches!(bytes[cursor], b',' | b';' | b' ' | b'\t') {
				cursor += 1;
			}
			input[start..cursor].to_owned()
		};
		if !key.is_empty() && !value.trim().is_empty() {
			output.insert(key, value);
		}
	}
	output
}

fn header_url(headers: &HeaderMap, name: &str, base: Option<&str>) -> Option<Str> {
	headers
		.get(name)
		.and_then(|value| value.to_str().ok())
		.and_then(|value| checked_url_with_base(value, base))
}

fn checked_url_with_base(value: &str, base: Option<&str>) -> Option<Str> {
	checked_url(value).or_else(|| {
		let base = Url::parse(base?).ok()?;
		let resolved = base.join(value).ok()?;
		checked_url(resolved.as_str())
	})
}

fn checked_url(value: &str) -> Option<Str> {
	let url = Url::parse(value).ok()?;
	(matches!(url.scheme(), "http" | "https") && url.host().is_some() && url.fragment().is_none())
		.then(|| Str::from(value))
}

fn normalize_scopes(scopes: Option<&str>) -> Box<[Str]> {
	let mut scopes = scopes
		.unwrap_or_default()
		.split_ascii_whitespace()
		.map(Str::from)
		.collect::<Vec<_>>();
	scopes.sort_unstable();
	scopes.dedup();
	scopes.into_boxed_slice()
}
#[cfg(test)]
mod tests {
	use http::{HeaderMap, HeaderValue, header::WWW_AUTHENTICATE};
	use omp_core::Str;

	use super::discover_auth_challenge;

	#[test]
	fn rfc_6750_challenge_scope_precedes_body_catalogue() {
		let mut headers = HeaderMap::new();
		headers.insert(
			WWW_AUTHENTICATE,
			HeaderValue::from_static(
				r#"Bearer scope="genie offline_access", resource_metadata="https://example.com/.well-known/oauth-protected-resource""#,
			),
		);
		let challenge = discover_auth_challenge(
			&headers,
			r#"{"scopes_supported":["email","openid","profile","workspace"]}"#,
		)
		.expect("bearer challenge is discovered");
		let expected_scopes = [Str::from("genie"), Str::from("offline_access")];

		assert_eq!(challenge.scopes.as_ref(), expected_scopes.as_slice(),);
		assert_eq!(
			challenge.resource_metadata.as_deref(),
			Some("https://example.com/.well-known/oauth-protected-resource"),
		);
	}
}
