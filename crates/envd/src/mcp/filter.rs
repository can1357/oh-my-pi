//! Native-device coverage filtering for configured MCP mounts.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt,
};

use omp_ai::{
	auth::{self, AuthControlHandle, CredentialControlWrite},
	id::PrincipalId,
};
use omp_catalog::ProviderId;
use omp_core::{ExposeSecret as _, Secret, SecretString, Str};
use url::Url;

use super::config::{McpServerConfig, ResolvedServer, TransportKind};

const EXA_HOST_SUFFIX: &str = "mcp.exa.ai";
const EXA_KEY_QUERY: &str = "exaApiKey";
const NATIVE_EXA_SEARCH: &str = "web_search_exa";

/// Exact operation coverage published by native devices.
#[derive(Clone, Debug)]
pub struct NativeCoverage {
	/// Exa MCP leaf names owned by native search.
	pub exa_tools:     BTreeSet<Str>,
	/// Browser MCP leaf names owned by the native browser device.
	pub browser_tools: BTreeSet<Str>,
}

impl Default for NativeCoverage {
	fn default() -> Self {
		Self {
			exa_tools:     BTreeSet::from([Str::new_static(NATIVE_EXA_SEARCH)]),
			browser_tools: BTreeSet::new(),
		}
	}
}

/// Generic MCP mount retained after native coverage analysis.
#[derive(Clone, Debug)]
pub struct FilteredMount {
	/// Source declaration retained intact until any native-only replacement is
	/// known to be usable.
	pub server:           ResolvedServer,
	/// Advertised leaves which the generic MCP device must suppress.
	pub suppressed_tools: BTreeSet<Str>,
}

/// Secret key extracted from an Exa MCP declaration.
#[derive(Clone)]
pub struct ExtractedExaKey {
	/// Source server identity, safe for opaque affinity derivation.
	pub server: Str,
	/// Extracted secret bytes.
	pub key:    SecretString,
}

impl fmt::Debug for ExtractedExaKey {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("ExtractedExaKey")
			.field("server", &self.server)
			.field("key", &"[REDACTED]")
			.finish()
	}
}

/// Coverage-filter result. Browser duplicates are removed immediately; Exa
/// duplicates remain as fallbacks until native provider auth import succeeds.
#[derive(Clone, Debug, Default)]
pub struct FilterResult {
	/// Generic mounts, including native-covered Exa fallbacks retained until
	/// native credential import succeeds.
	pub mounts:      BTreeMap<Str, FilteredMount>,
	/// Secret-typed Exa keys awaiting native provider import.
	pub exa_keys:    Vec<ExtractedExaKey>,
	/// Exa mounts which may be removed only after native auth is usable.
	pub covered_exa: BTreeSet<Str>,
}

/// Detects native-covered Exa/browser mounts and records conditional leaf
/// suppression.
pub fn filter_native_coverage(
	servers: &BTreeMap<Str, ResolvedServer>,
	coverage: &NativeCoverage,
) -> FilterResult {
	let mut result = FilterResult::default();
	for (name, server) in servers {
		let is_exa = is_exa_server(name, &server.config);
		let is_browser = is_browser_server(name, &server.config);
		let mut sanitized = (*server.config).clone();
		if is_exa {
			if let Some(key) = extract_exa_key(&mut sanitized) {
				result
					.exa_keys
					.push(ExtractedExaKey { server: name.clone(), key });
			}
		}
		let suppressed_tools = if is_exa {
			coverage.exa_tools.clone()
		} else if is_browser {
			coverage.browser_tools.clone()
		} else {
			BTreeSet::new()
		};
		if is_browser {
			continue;
		}
		let requested = requested_exa_tools(&sanitized);
		if is_exa
			&& requested
				.as_ref()
				.is_none_or(|tools| tools.iter().all(|tool| suppressed_tools.contains(tool)))
		{
			result.covered_exa.insert(name.clone());
		}
		result
			.mounts
			.insert(name.clone(), FilteredMount { server: server.clone(), suppressed_tools });
	}
	result
}

/// Imports the first deterministic Exa key through the canonical native
/// provider authority. Existing native Exa accounts take precedence.
pub fn import_exa_keys(
	authority: &AuthControlHandle,
	principal: PrincipalId,
	keys: Vec<ExtractedExaKey>,
) -> Result<bool, auth::StoreError> {
	let provider = ProviderId::from("exa");
	let accounts = authority.accounts(Some(&provider));
	if !accounts.is_empty() {
		return Ok(accounts.iter().any(|account| account.enabled));
	}
	let Some(extracted) = keys.into_iter().next() else {
		return Ok(false);
	};
	let secret = Secret::new(extracted.key.expose_secret().as_bytes().to_vec());
	authority.store(CredentialControlWrite {
		provider,
		principal,
		identity: Some(Str::new_static("default")),
		kind: Str::new_static("bearer"),
		secret,
		expires_at_ms: None,
	})?;
	Ok(true)
}

fn is_exa_server(name: &str, config: &McpServerConfig) -> bool {
	if name.eq_ignore_ascii_case("exa") || name.to_ascii_lowercase().contains("websets") {
		return true;
	}
	if config.url.as_ref().is_some_and(|value| {
		Url::parse(value)
			.ok()
			.and_then(|url| {
				url.host_str()
					.map(|host| host.eq_ignore_ascii_case(EXA_HOST_SUFFIX))
			})
			.unwrap_or(false)
	}) {
		return true;
	}
	config
		.args
		.iter()
		.any(|arg| arg.to_ascii_lowercase().contains(EXA_HOST_SUFFIX))
}

fn is_browser_server(name: &str, config: &McpServerConfig) -> bool {
	const NAMES: [&str; 6] =
		["puppeteer", "playwright", "browserbase", "browser-tools", "browser-use", "browser"];
	let lower = name.to_ascii_lowercase();
	if NAMES.contains(&lower.as_str()) {
		return true;
	}
	let matches = |value: &str| {
		let lower = value.to_ascii_lowercase();
		[
			"@modelcontextprotocol/server-puppeteer",
			"@playwright/mcp",
			"browserbase",
			"browser-use-mcp",
			"playwright-mcp",
			"puppeteer-mcp",
		]
		.iter()
		.any(|needle| lower.contains(needle))
	};
	config.command.as_ref().is_some_and(|value| matches(value))
		|| config.args.iter().any(|value| matches(value))
		|| config.url.as_ref().is_some_and(|value| matches(value))
}

fn extract_exa_key(config: &mut McpServerConfig) -> Option<SecretString> {
	if let Some(value) = config.env.remove("EXA_API_KEY") {
		if !value.is_empty() && !value.starts_with('!') {
			return Some(SecretString::from(value.as_str()));
		}
		config.env.insert(Str::new_static("EXA_API_KEY"), value);
	}
	if let Some(raw) = config.url.as_ref()
		&& let Ok(mut url) = Url::parse(raw)
		&& let Some(value) = url
			.query_pairs()
			.find(|(key, _)| key.eq_ignore_ascii_case(EXA_KEY_QUERY))
			.map(|(_, value)| value.into_owned())
	{
		let retained: Vec<(String, String)> = url
			.query_pairs()
			.filter(|(key, _)| !key.eq_ignore_ascii_case(EXA_KEY_QUERY))
			.map(|(key, value)| (key.into_owned(), value.into_owned()))
			.collect();
		url.query_pairs_mut().clear().extend_pairs(retained);
		config.url = Some(Str::from(url.as_str()));
		return Some(SecretString::from(value));
	}
	for arg in &mut config.args {
		if let Some(value) = query_value(arg, EXA_KEY_QUERY) {
			let secret = SecretString::from(value.as_str());
			*arg = Str::from(redact_query_value(arg, EXA_KEY_QUERY));
			return Some(secret);
		}
	}
	None
}

fn query_value(value: &str, key: &str) -> Option<String> {
	value.split(['?', '&', ' ']).find_map(|part| {
		part
			.split_once('=')
			.filter(|(name, value)| name.eq_ignore_ascii_case(key) && !value.is_empty())
			.map(|(_, value)| value.to_owned())
	})
}

fn redact_query_value(value: &str, key: &str) -> String {
	value
		.split('&')
		.filter(|part| {
			!part
				.trim_start_matches(|character| character == '?' || character == ' ')
				.split_once('=')
				.is_some_and(|(name, _)| name.eq_ignore_ascii_case(key))
		})
		.collect::<Vec<_>>()
		.join("&")
}

fn requested_exa_tools(config: &McpServerConfig) -> Option<BTreeSet<Str>> {
	let raw = match config.resolved_transport() {
		TransportKind::Http | TransportKind::Sse => config
			.url
			.as_ref()
			.and_then(|raw| Url::parse(raw).ok())
			.and_then(|url| {
				url.query_pairs()
					.find(|(key, _)| key.eq_ignore_ascii_case("tools"))
					.map(|(_, value)| value.into_owned())
			}),
		TransportKind::Stdio => config.args.iter().enumerate().find_map(|(index, arg)| {
			if matches!(arg.as_str(), "--tools" | "-tools") {
				config.args.get(index + 1).map(ToString::to_string)
			} else {
				query_value(arg, "tools")
			}
		}),
	};
	raw.map(|raw| {
		raw.split(',')
			.map(str::trim)
			.filter(|value| !value.is_empty())
			.map(Str::from)
			.collect()
	})
	.filter(|tools: &BTreeSet<Str>| !tools.is_empty())
}

#[cfg(test)]
mod tests {
	use std::{path::PathBuf, sync::Arc};

	use super::*;
	use crate::mcp::config::{ConfigSourceKind, McpServerConfig};

	fn remote(url: &str) -> ResolvedServer {
		ResolvedServer {
			name:        Str::from("exa"),
			source:      PathBuf::from("config"),
			source_kind: ConfigSourceKind::User,
			writable:    true,
			config:      Arc::new(McpServerConfig {
				transport:         Some(TransportKind::Http),
				enabled:           true,
				command:           None,
				args:              Vec::new(),
				env:               BTreeMap::new(),
				env_policy:        None,
				env_literal_keys:  BTreeSet::new(),
				cwd:               None,
				url:               Some(Str::from(url)),
				headers:           BTreeMap::new(),
				header_policy:     None,
				timeout:           None,
				request_id_format: None,
				auth:              None,
				oauth:             None,
				protocol_versions: Vec::new(),
			}),
		}
	}

	#[test]
	fn extracts_key_and_retains_uncovered_exa_tools() {
		let servers = BTreeMap::from([(
			Str::from("exa"),
			remote("https://mcp.exa.ai/mcp?exaApiKey=top-secret&tools=web_search_exa,web_fetch_exa"),
		)]);
		let filtered = filter_native_coverage(&servers, &NativeCoverage::default());
		assert!(filtered.mounts.contains_key("exa"));
		assert!(
			filtered.mounts["exa"]
				.suppressed_tools
				.contains("web_search_exa")
		);
		assert_eq!(filtered.exa_keys[0].key.expose_secret(), "top-secret");
		assert!(!filtered.covered_exa.contains("exa"));
		assert!(!format!("{:?}", filtered.exa_keys).contains("top-secret"));
	}

	#[test]
	fn marks_exactly_native_only_restricted_mount_for_conditional_removal() {
		let servers = BTreeMap::from([(
			Str::from("exa"),
			remote("https://mcp.exa.ai/mcp?tools=web_search_exa"),
		)]);
		let filtered = filter_native_coverage(&servers, &NativeCoverage::default());
		assert!(filtered.mounts.contains_key("exa"));
		assert!(filtered.covered_exa.contains("exa"));
	}

	#[test]
	fn marks_unrestricted_exa_mounts_for_conditional_removal() {
		let servers = BTreeMap::from([(Str::from("exa"), remote("https://mcp.exa.ai/mcp"))]);
		let filtered = filter_native_coverage(&servers, &NativeCoverage::default());
		assert!(filtered.mounts.contains_key("exa"));
		assert!(filtered.covered_exa.contains("exa"));
	}
}
