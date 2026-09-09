//! URL-based provider and standard proxy environment resolution.

use std::{env, ffi::OsString, net::IpAddr};

use thiserror::Error;
use url::Url;

/// Typed failures while resolving environment proxy policy.
#[derive(Debug, Error)]
pub enum ProxyEnvironmentError {
	/// A configured proxy variable was not Unicode.
	#[error("proxy variable {variable} is not Unicode")]
	NonUnicode {
		/// Variable containing non-Unicode bytes.
		variable: &'static str,
	},
	/// A configured proxy variable was not a URL.
	#[error("proxy variable {variable} is not a valid URL")]
	InvalidUrl {
		/// Variable containing the invalid value.
		variable: &'static str,
		/// Typed URL parser source. The value itself is intentionally omitted.
		#[source]
		source:   url::ParseError,
	},
	/// A configured proxy URL had no host.
	#[error("proxy variable {variable} has no host")]
	MissingHost {
		/// Variable containing the hostless URL.
		variable: &'static str,
	},
}

/// Resolves the standard proxy environment for one destination URL.
pub(crate) fn for_url(url: &Url) -> Option<Url> {
	for_url_with(url, None, |name| env::var_os(name))
		.ok()
		.flatten()
}

/// Resolves a provider-specific proxy, the process-wide OMP proxy, and then the
/// standard protocol proxy variables for one destination.
///
/// `provider_variable` is the provider's normalized `OMP_PROXY_*` name. The
/// explicit spelling keeps the environment contract reviewable at each
/// production composition boundary.
pub fn for_provider_url(
	url: &Url,
	provider_variable: &'static str,
) -> Result<Option<Url>, ProxyEnvironmentError> {
	for_url_with(url, Some(provider_variable), |name| env::var_os(name))
}

fn for_url_with(
	url: &Url,
	provider_variable: Option<&'static str>,
	env: impl Fn(&str) -> Option<OsString>,
) -> Result<Option<Url>, ProxyEnvironmentError> {
	if bypasses_proxy(url, &env)? {
		return Ok(None);
	}
	let protocol_names: &[&'static str] = match url.scheme() {
		"https" | "wss" => &["HTTPS_PROXY", "https_proxy"],
		"http" | "ws" => &["HTTP_PROXY", "http_proxy"],
		_ => return Ok(None),
	};
	let names = [
		provider_variable,
		provider_variable.map(|_| "OMP_PROXY"),
		Some(protocol_names[0]),
		Some(protocol_names[1]),
		Some("ALL_PROXY"),
		Some("all_proxy"),
	];
	for variable in names.into_iter().flatten() {
		let Some(value) = env(variable) else {
			continue;
		};
		if let Some(proxy) = parse_proxy(value, variable)? {
			return Ok(Some(proxy));
		}
	}
	Ok(None)
}

fn parse_proxy(
	value: OsString,
	variable: &'static str,
) -> Result<Option<Url>, ProxyEnvironmentError> {
	let value = value
		.to_str()
		.ok_or(ProxyEnvironmentError::NonUnicode { variable })?
		.trim();
	if value.is_empty() {
		return Ok(None);
	}
	let url = if value.contains("://") {
		Url::parse(value)
	} else {
		Url::parse(&format!("http://{value}"))
	}
	.map_err(|source| ProxyEnvironmentError::InvalidUrl { variable, source })?;
	if url.host_str().is_none() {
		return Err(ProxyEnvironmentError::MissingHost { variable });
	}
	Ok(Some(url))
}

fn bypasses_proxy(
	url: &Url,
	env: &impl Fn(&str) -> Option<OsString>,
) -> Result<bool, ProxyEnvironmentError> {
	let host = url
		.host_str()
		.unwrap_or_default()
		.trim_matches(|character| matches!(character, '[' | ']'))
		.to_ascii_lowercase();
	if is_local_or_metadata(&host) {
		return Ok(true);
	}
	let (variable, rules) = if let Some(rules) = env("NO_PROXY") {
		("NO_PROXY", rules)
	} else if let Some(rules) = env("no_proxy") {
		("no_proxy", rules)
	} else {
		return Ok(false);
	};
	let rules = rules
		.to_str()
		.ok_or(ProxyEnvironmentError::NonUnicode { variable })?;
	let port = url.port_or_known_default();
	Ok(rules
		.split(|character: char| character == ',' || character.is_ascii_whitespace())
		.filter(|rule| !rule.is_empty())
		.any(|rule| no_proxy_matches(rule, &host, port)))
}

fn no_proxy_matches(rule: &str, host: &str, port: Option<u16>) -> bool {
	if rule == "*" {
		return true;
	}
	let rule = rule.to_ascii_lowercase();
	let (rule_host, rule_port) = split_rule_host_port(&rule);
	if rule_port.is_some() && rule_port != port {
		return false;
	}
	let rule_host = rule_host
		.trim_matches(|character| matches!(character, '[' | ']'))
		.trim_start_matches('.');
	!rule_host.is_empty()
		&& (host == rule_host
			|| host
				.strip_suffix(rule_host)
				.is_some_and(|prefix| prefix.ends_with('.')))
}

fn split_rule_host_port(rule: &str) -> (&str, Option<u16>) {
	if let Some(bracket) = rule.strip_prefix('[')
		&& let Some(end) = bracket.find(']')
	{
		let host_end = end + 2;
		let port = rule
			.get(host_end..)
			.and_then(|tail| tail.strip_prefix(':'))
			.and_then(|port| port.parse().ok());
		return (&rule[..host_end], port);
	}
	let Some((host, port)) = rule.rsplit_once(':') else {
		return (rule, None);
	};
	if host.contains(':') {
		return (rule, None);
	}
	port.parse().map_or((rule, None), |port| (host, Some(port)))
}

fn is_local_or_metadata(host: &str) -> bool {
	if host == "localhost" || host.ends_with(".localhost") || host == "metadata.google.internal" {
		return true;
	}
	let Ok(ip) = host.parse::<IpAddr>() else {
		return false;
	};
	match ip {
		IpAddr::V4(ip) => {
			let [first, second, ..] = ip.octets();
			first == 0
				|| first == 10
				|| first == 127
				|| (first == 169 && second == 254)
				|| (first == 172 && (16..=31).contains(&second))
				|| (first == 192 && second == 168)
		},
		IpAddr::V6(ip) => {
			ip.is_loopback() || ip.is_unspecified() || {
				let first = ip.segments()[0];
				(first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
			}
		},
	}
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeMap;

	use super::*;

	fn resolve(url: &str, values: &[(&str, &str)]) -> Option<Url> {
		let values = values
			.iter()
			.map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
			.collect::<BTreeMap<_, _>>();
		for_url_with(&Url::parse(url).unwrap(), None, |name| values.get(name).cloned())
			.expect("valid proxy policy")
	}

	fn resolve_provider(url: &str, values: &[(&str, &str)]) -> Option<Url> {
		let values = values
			.iter()
			.map(|(name, value)| ((*name).to_owned(), OsString::from(value)))
			.collect::<BTreeMap<_, _>>();
		for_url_with(&Url::parse(url).unwrap(), Some("OMP_PROXY_OPENAI_CODEX"), |name| {
			values.get(name).cloned()
		})
		.expect("valid proxy policy")
	}

	#[test]
	fn resolves_protocol_proxy_then_all_proxy() {
		assert_eq!(
			resolve("https://api2.cursor.sh/agent.v1.AgentService/Run", &[
				("HTTPS_PROXY", "http://secure-proxy:8080"),
				("ALL_PROXY", "http://all:8080")
			],)
			.unwrap()
			.as_str(),
			"http://secure-proxy:8080/"
		);
		assert_eq!(
			resolve("https://api2.cursor.sh", &[("ALL_PROXY", "all-proxy:8080")])
				.unwrap()
				.as_str(),
			"http://all-proxy:8080/"
		);
		assert_eq!(
			resolve("http://api2.cursor.sh", &[("HTTP_PROXY", "http://plain:8080")])
				.unwrap()
				.as_str(),
			"http://plain:8080/"
		);
	}

	#[test]
	fn provider_proxy_precedes_process_and_standard_routes() {
		assert_eq!(
			resolve_provider("https://chatgpt.com/live", &[
				("OMP_PROXY_OPENAI_CODEX", "http://provider:8080"),
				("OMP_PROXY", "http://process:8080"),
				("HTTPS_PROXY", "http://standard:8080"),
			])
			.expect("provider proxy")
			.as_str(),
			"http://provider:8080/"
		);
		assert_eq!(
			resolve_provider("https://chatgpt.com/live", &[
				("OMP_PROXY", "http://process:8080"),
				("HTTPS_PROXY", "http://standard:8080"),
			])
			.expect("process proxy")
			.as_str(),
			"http://process:8080/"
		);
		assert!(
			resolve_provider("https://chatgpt.com/live", &[
				("OMP_PROXY_OPENAI_CODEX", "http://provider:8080"),
				("NO_PROXY", "api.example chatgpt.com"),
			])
			.is_none()
		);
	}

	#[test]
	fn no_proxy_and_local_destinations_bypass() {
		assert!(
			resolve("https://api2.cursor.sh:8443", &[
				("HTTPS_PROXY", "http://proxy:8080"),
				("NO_PROXY", ".cursor.sh:8443")
			],)
			.is_none()
		);
		assert!(resolve("http://127.0.0.1", &[("HTTP_PROXY", "http://proxy:8080")]).is_none());
		assert!(resolve("http://169.254.169.254", &[("HTTP_PROXY", "http://proxy:8080")]).is_none());
		assert!(resolve("http://[fd00:ec2::254]", &[("HTTP_PROXY", "http://proxy:8080")]).is_none());
	}

	#[test]
	fn invalid_proxy_failures_name_only_the_variable() {
		let values =
			BTreeMap::from([("HTTPS_PROXY".to_owned(), OsString::from("http://employee:secret@"))]);
		let error = for_url_with(&Url::parse("https://chatgpt.com").unwrap(), None, |name| {
			values.get(name).cloned()
		})
		.expect_err("invalid proxy must be typed");
		let display = error.to_string();
		assert!(display.contains("HTTPS_PROXY"));
		assert!(!display.contains("employee"));
		assert!(!display.contains("secret"));
	}
}
