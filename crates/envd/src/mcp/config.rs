//! Native MCP configuration schema, validation, and precedence resolution.

use std::{
	collections::{BTreeMap, BTreeSet},
	path::PathBuf,
	sync::Arc,
};

use http::{HeaderName, HeaderValue};
use omp_core::Str;
use serde::{Deserialize, Serialize};
use strum::{Display, EnumString, IntoStaticStr};
use url::Url;

use super::{header_policy, header_policy::HeaderPolicyError};

/// Schema URL written into native OMP MCP configuration files.
pub const MCP_CONFIG_SCHEMA_URL: &str =
	"https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";
/// Current MCP protocol revision preferred by OMP.
pub const CURRENT_PROTOCOL_REVISION: &str = "2025-11-25";
/// Explicit older protocol revisions accepted by the client.
pub const SUPPORTED_PROTOCOL_REVISIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// Origin of one MCP configuration document.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, Ord, PartialEq, PartialOrd,
)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum ConfigSourceKind {
	/// Project-owned `.omp/mcp.json`.
	Project,
	/// User-owned `~/.o2/mcp.json`.
	User,
	/// Native OMP extension manifest mount.
	Manifest,
	/// Project-root `.mcp.json` fallback.
	Root,
	/// Claude Code project configuration.
	ClaudeProject,
	/// Claude Code user configuration.
	ClaudeUser,
	/// Portable Agent Plugin project package.
	AgentPluginProject,
	/// Portable Agent Plugin user package.
	AgentPluginUser,
	/// OpenAI Codex project configuration.
	CodexProject,
	/// OpenAI Codex user configuration.
	CodexUser,
	/// Gemini CLI project configuration.
	GeminiProject,
	/// Gemini CLI user configuration.
	GeminiUser,
	/// OpenCode project configuration.
	OpenCodeProject,
	/// OpenCode user configuration.
	OpenCodeUser,
	/// Cursor project configuration.
	CursorProject,
	/// Cursor user configuration.
	CursorUser,
	/// Windsurf project configuration.
	WindsurfProject,
	/// Windsurf user configuration.
	WindsurfUser,
	/// VS Code project configuration.
	VsCodeProject,
	/// Lowest-priority standalone project fallback.
	StandaloneProject,
}

impl ConfigSourceKind {
	const fn precedence(self) -> u8 {
		match self {
			Self::Project => 200,
			Self::User => 199,
			Self::Manifest => 180,
			Self::ClaudeProject => 161,
			Self::ClaudeUser => 160,
			Self::AgentPluginProject => 151,
			Self::AgentPluginUser => 150,
			Self::CodexProject => 141,
			Self::CodexUser => 140,
			Self::GeminiProject => 121,
			Self::GeminiUser => 120,
			Self::OpenCodeProject => 111,
			Self::OpenCodeUser => 110,
			Self::CursorProject => 101,
			Self::CursorUser => 100,
			Self::WindsurfProject => 99,
			Self::WindsurfUser => 98,
			Self::VsCodeProject => 40,
			Self::Root => 10,
			Self::StandaloneProject => 9,
		}
	}

	/// Whether OMP may mutate this source directly.
	pub const fn writable(self) -> bool {
		matches!(self, Self::Project | Self::User | Self::Root)
	}

	const fn project_scoped(self) -> bool {
		matches!(
			self,
			Self::Project
				| Self::Root
				| Self::ClaudeProject
				| Self::AgentPluginProject
				| Self::CodexProject
				| Self::GeminiProject
				| Self::OpenCodeProject
				| Self::CursorProject
				| Self::WindsurfProject
				| Self::VsCodeProject
				| Self::StandaloneProject
		)
	}
}

/// MCP JSON configuration document.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfigFile {
	/// JSON schema declaration.
	#[serde(default, rename = "$schema", skip_serializing_if = "Option::is_none")]
	pub schema:           Option<Str>,
	/// Named server declarations.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub mcp_servers:      BTreeMap<Str, McpServerConfig>,
	/// Names suppressed regardless of source declarations.
	#[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
	pub disabled_servers: BTreeSet<Str>,
	/// Names force-enabled when a read-only source declares them disabled.
	#[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
	pub enabled_servers:  BTreeSet<Str>,
}

/// MCP transport kind.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Deserialize,
	Serialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum TransportKind {
	/// Child-process NDJSON transport.
	#[default]
	Stdio,
	/// Streamable HTTP transport.
	Http,
	/// Legacy HTTP plus SSE transport.
	Sse,
}

/// JSON-RPC request-ID encoding.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Display,
	EnumString,
	Eq,
	IntoStaticStr,
	PartialEq,
	Deserialize,
	Serialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum RequestIdFormat {
	/// Per-transport numeric IDs.
	#[default]
	Number,
	/// Collision-resistant string IDs.
	String,
}

/// Environment-value interpretation policy.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq, Deserialize, Serialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum EnvironmentPolicy {
	/// Values are package data and are not interpolated.
	Literal,
}

/// Configured HTTP-header forwarding policy.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq, Deserialize, Serialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum HeaderPolicy {
	/// Configured headers are attached only to the configured origin.
	OriginLocked,
}

/// MCP authentication mode.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq, Deserialize, Serialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum AuthKind {
	/// OAuth credential lease.
	Oauth,
	/// API-key credential lease.
	Apikey,
}

/// Static authentication reference. Secret bytes are never stored here.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthConfig {
	/// Authentication mode.
	#[serde(rename = "type")]
	pub kind:          AuthKind,
	/// Opaque credential authority identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub credential_id: Option<Str>,
	/// Explicit OAuth token endpoint.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub token_url:     Option<Str>,
	/// OAuth client identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub client_id:     Option<Str>,
	/// Secret-authority reference, never literal secret material.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub secret_ref:    Option<Str>,
	/// Protected-resource identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub resource:      Option<Str>,
}

/// Explicit OAuth client and callback overrides.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OauthConfig {
	/// OAuth client identity.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub client_id:     Option<Str>,
	/// Secret-authority reference.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub secret_ref:    Option<Str>,
	/// Explicit callback URI.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub redirect_uri:  Option<Str>,
	/// Loopback callback port.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub callback_port: Option<u16>,
	/// Loopback callback path.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub callback_path: Option<Str>,
	/// Authorization prompt override.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompt:        Option<Str>,
}

/// One validated MCP server declaration.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerConfig {
	/// Explicit transport; absent means stdio when `command` exists and HTTP
	/// otherwise.
	#[serde(default, rename = "type", skip_serializing_if = "Option::is_none")]
	pub transport:         Option<TransportKind>,
	/// Whether this declaration is active.
	#[serde(default = "default_true")]
	pub enabled:           bool,
	/// Stdio executable.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub command:           Option<Str>,
	/// Stdio arguments.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub args:              Vec<Str>,
	/// Stdio environment declarations.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub env:               BTreeMap<Str, Str>,
	/// Environment expansion policy.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub env_policy:        Option<EnvironmentPolicy>,
	/// Environment keys whose values are final package data even when the rest
	/// of the environment uses dynamic resolution.
	#[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
	pub env_literal_keys:  BTreeSet<Str>,
	/// Stdio working directory.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub cwd:               Option<PathBuf>,
	/// HTTP or SSE endpoint.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub url:               Option<Str>,
	/// Configured HTTP headers.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub headers:           BTreeMap<Str, Str>,
	/// Configured-header forwarding policy.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub header_policy:     Option<HeaderPolicy>,
	/// Request timeout in milliseconds; zero disables the client deadline.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub timeout:           Option<u64>,
	/// Request-ID representation.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub request_id_format: Option<RequestIdFormat>,
	/// Authentication authority reference.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub auth:              Option<AuthConfig>,
	/// Explicit OAuth overrides.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub oauth:             Option<OauthConfig>,
	/// Ordered protocol-revision preferences. Empty uses the supported default
	/// table.
	#[serde(default, skip_serializing_if = "Vec::is_empty")]
	pub protocol_versions: Vec<Str>,
}

impl McpServerConfig {
	/// Resolves the transport inferred by the file schema.
	pub fn resolved_transport(&self) -> TransportKind {
		self.transport.unwrap_or(if self.command.is_some() {
			TransportKind::Stdio
		} else {
			TransportKind::Http
		})
	}

	fn semantically_equivalent(&self, other: &Self) -> bool {
		if self.auth != other.auth
			|| self.oauth != other.oauth
			|| self.request_id_format.unwrap_or_default()
				!= other.request_id_format.unwrap_or_default()
			|| self.resolved_transport() != other.resolved_transport()
		{
			return false;
		}
		match self.resolved_transport() {
			TransportKind::Stdio => {
				self.command == other.command
					&& self.args == other.args
					&& self.env == other.env
					&& self.same_env_literal_semantics(other)
					&& self.cwd == other.cwd
			},
			TransportKind::Http | TransportKind::Sse => {
				self.url == other.url && self.headers == other.headers
			},
		}
	}

	fn same_env_literal_semantics(&self, other: &Self) -> bool {
		let self_all = self.env_policy == Some(EnvironmentPolicy::Literal);
		let other_all = other.env_policy == Some(EnvironmentPolicy::Literal);
		match (self_all, other_all) {
			(true, true) => true,
			(false, false) => self.env_literal_keys == other.env_literal_keys,
			(true, false) => {
				other.env_literal_keys.len() == self.env.len()
					&& self
						.env
						.keys()
						.all(|key| other.env_literal_keys.contains(key))
			},
			(false, true) => {
				self.env_literal_keys.len() == other.env.len()
					&& other
						.env
						.keys()
						.all(|key| self.env_literal_keys.contains(key))
			},
		}
	}

	/// Whether one configured environment value bypasses dynamic resolution.
	pub(crate) fn env_value_is_literal(&self, key: &str) -> bool {
		self.env_policy == Some(EnvironmentPolicy::Literal) || self.env_literal_keys.contains(key)
	}
}

const fn default_true() -> bool {
	true
}

/// Parsed configuration source with immutable ownership facts.
#[derive(Clone, Debug)]
pub struct ConfigSource {
	/// Source path or manifest identity.
	pub path: PathBuf,
	/// Source kind and precedence.
	pub kind: ConfigSourceKind,
	/// Parsed file.
	pub file: McpConfigFile,
}

/// Winning server declaration after precedence and enable/disable resolution.
#[derive(Clone, Debug)]
pub struct ResolvedServer {
	/// Server name.
	pub name:        Str,
	/// Winning server configuration.
	pub config:      Arc<McpServerConfig>,
	/// Source path or manifest identity.
	pub source:      PathBuf,
	/// Source kind.
	pub source_kind: ConfigSourceKind,
	/// Whether the winning source is directly writable by OMP.
	pub writable:    bool,
}

/// Complete resolved MCP configuration.
#[derive(Clone, Debug, Default)]
pub struct ResolvedConfig {
	/// Enabled winning declarations in deterministic name order.
	pub servers:        BTreeMap<Str, ResolvedServer>,
	/// Names owned by the user denylist, including names with no current
	/// declaration.
	pub disabled_names: BTreeSet<Str>,
}

/// Loads and resolves already parsed sources. Project sources are excluded
/// before name ownership when `enable_project_config` is false.
pub fn resolve_sources(sources: &[ConfigSource], enable_project_config: bool) -> ResolvedConfig {
	let user = sources
		.iter()
		.find(|source| source.kind == ConfigSourceKind::User);
	let disabled = user.map_or_else(BTreeSet::new, |source| source.file.disabled_servers.clone());
	let forced = user.map_or_else(BTreeSet::new, |source| source.file.enabled_servers.clone());
	let mut ordered: Vec<&ConfigSource> = sources
		.iter()
		.filter(|source| enable_project_config || !source.kind.project_scoped())
		.collect();
	ordered.sort_by(|left, right| right.kind.precedence().cmp(&left.kind.precedence()));

	let mut claimed = BTreeSet::new();
	let mut seen_connections: Vec<Arc<McpServerConfig>> = Vec::new();
	let mut servers = BTreeMap::new();
	for source in ordered {
		for (name, config) in &source.file.mcp_servers {
			if !claimed.insert(name.clone()) {
				continue;
			}
			if disabled.contains(name) || (!config.enabled && !forced.contains(name)) {
				continue;
			}
			if seen_connections
				.iter()
				.any(|seen| seen.semantically_equivalent(config))
			{
				continue;
			}
			let config = Arc::new(config.clone());
			seen_connections.push(Arc::clone(&config));
			servers.insert(name.clone(), ResolvedServer {
				name: name.clone(),
				config,
				source: source.path.clone(),
				source_kind: source.kind,
				writable: source.kind.writable(),
			});
		}
	}
	ResolvedConfig { servers, disabled_names: disabled }
}

/// Validates one complete MCP file and returns every independently actionable
/// issue.
pub fn validate_file(file: &McpConfigFile) -> Vec<ConfigValidationError> {
	let mut errors = Vec::new();
	for name in file
		.disabled_servers
		.iter()
		.chain(file.enabled_servers.iter())
	{
		if let Err(error) = validate_server_name(name) {
			errors.push(error);
		}
	}
	for (name, server) in &file.mcp_servers {
		if let Err(error) = validate_server_name(name) {
			errors.push(error);
		}
		errors.extend(validate_server(name, server));
	}
	errors
}

/// Validates the portable MCP server-name vocabulary.
pub fn validate_server_name(name: &str) -> Result<(), ConfigValidationError> {
	let length = name.chars().count();
	if !(1..=100).contains(&length) {
		return Err(ConfigValidationError::NameLength { length });
	}
	if !name
		.bytes()
		.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
	{
		return Err(ConfigValidationError::NameCharacters { name: Str::from(name) });
	}
	Ok(())
}

/// Validates transport exclusivity, headers, authentication, and revision
/// preferences.
pub fn validate_server(name: &str, server: &McpServerConfig) -> Vec<ConfigValidationError> {
	let mut errors = Vec::new();
	let has_command = server
		.command
		.as_ref()
		.is_some_and(|value| !value.is_empty());
	let has_url = server.url.as_ref().is_some_and(|value| !value.is_empty());
	if has_command && has_url {
		errors.push(ConfigValidationError::TransportConflict { name: Str::from(name) });
	}
	match server.resolved_transport() {
		TransportKind::Stdio if !has_command => {
			errors.push(ConfigValidationError::MissingCommand { name: Str::from(name) })
		},
		TransportKind::Stdio if has_url => {
			errors.push(ConfigValidationError::TransportConflict { name: Str::from(name) })
		},
		TransportKind::Http | TransportKind::Sse if !has_url => {
			errors.push(ConfigValidationError::MissingUrl { name: Str::from(name) })
		},
		TransportKind::Http | TransportKind::Sse if has_command => {
			errors.push(ConfigValidationError::TransportConflict { name: Str::from(name) })
		},
		_ => {},
	}
	if let Some(url) = server.url.as_ref() {
		match Url::parse(url) {
			Ok(url) if matches!(url.scheme(), "http" | "https") && url.host_str().is_some() => {},
			_ => errors.push(ConfigValidationError::InvalidUrl { name: Str::from(name) }),
		}
	}
	let mut parsed_headers = http::HeaderMap::with_capacity(server.headers.len());
	for (header, value) in &server.headers {
		match (HeaderName::from_bytes(header.as_bytes()), HeaderValue::from_str(value)) {
			(Ok(header_name), Ok(header_value)) => {
				parsed_headers.append(header_name, header_value);
			},
			_ => errors.push(ConfigValidationError::InvalidHeader {
				name:   Str::from(name),
				header: header.clone(),
			}),
		}
	}
	if let Err(HeaderPolicyError::ReservedHeader { name: header }) =
		header_policy::validate_configured_headers(&parsed_headers)
	{
		errors.push(ConfigValidationError::ReservedHeader {
			name:   Str::from(name),
			header: Str::from(header.as_str()),
		});
	}
	if let Some(auth) = &server.auth {
		if auth.kind == AuthKind::Apikey && auth.credential_id.is_none() && auth.secret_ref.is_none()
		{
			errors.push(ConfigValidationError::MissingCredentialReference { name: Str::from(name) });
		}
	}
	let mut seen = BTreeSet::new();
	for revision in &server.protocol_versions {
		if revision.as_str() != CURRENT_PROTOCOL_REVISION
			&& !SUPPORTED_PROTOCOL_REVISIONS.contains(&revision.as_str())
		{
			errors.push(ConfigValidationError::UnsupportedProtocolRevision {
				name:     Str::from(name),
				revision: revision.clone(),
			});
		} else if !seen.insert(revision.clone()) {
			errors.push(ConfigValidationError::DuplicateProtocolRevision {
				name:     Str::from(name),
				revision: revision.clone(),
			});
		}
	}
	errors
}

/// MCP configuration validation failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ConfigValidationError {
	/// Name length is outside the portable range.
	#[error("MCP server name must contain 1 through 100 characters (received {length})")]
	NameLength {
		/// Number of Unicode scalar values in the rejected server name.
		length: usize,
	},
	/// Name contains characters outside the portable vocabulary.
	#[error("MCP server name `{name}` contains unsupported characters")]
	NameCharacters {
		/// Server key from the configuration source that failed the portable-name
		/// check.
		name: Str,
	},
	/// Stdio and HTTP transport fields conflict.
	#[error("MCP server `{name}` sets mutually exclusive command and URL transport fields")]
	TransportConflict {
		/// Server key whose declaration mixes stdio command fields with an
		/// HTTP/SSE URL.
		name: Str,
	},
	/// Stdio transport lacks a command.
	#[error("MCP stdio server `{name}` requires a command")]
	MissingCommand {
		/// Server key whose stdio declaration has no non-empty executable
		/// command.
		name: Str,
	},
	/// HTTP transport lacks an endpoint.
	#[error("MCP HTTP server `{name}` requires a URL")]
	MissingUrl {
		/// Server key whose HTTP or SSE declaration has no non-empty endpoint
		/// URL.
		name: Str,
	},
	/// Endpoint is not an absolute HTTP(S) URL.
	#[error("MCP server `{name}` has an invalid HTTP URL")]
	InvalidUrl {
		/// Server key whose remote endpoint is not an absolute HTTP(S) URL with a
		/// host.
		name: Str,
	},
	/// Header name or value is not valid HTTP syntax.
	#[error("MCP server `{name}` has an invalid HTTP header `{header}`")]
	InvalidHeader {
		/// Server key whose configured HTTP header is syntactically invalid.
		name:   Str,
		/// Rejected header name from the server declaration.
		header: Str,
	},
	/// Header is owned by the transport protocol.
	#[error("MCP server `{name}` configures reserved transport header `{header}`")]
	ReservedHeader {
		/// Server name.
		name:   Str,
		/// Reserved header name.
		header: Str,
	},
	/// API-key auth lacks an authority reference.
	#[error("MCP API-key server `{name}` requires a credential ID or secret reference")]
	MissingCredentialReference {
		/// Server key whose API-key mode names neither a credential authority nor
		/// a secret reference.
		name: Str,
	},
	/// Protocol revision is not explicitly supported.
	#[error("MCP server `{name}` requests unsupported protocol revision `{revision}`")]
	UnsupportedProtocolRevision {
		/// Server key whose ordered protocol-negotiation preferences contain the
		/// rejected revision.
		name:     Str,
		/// Configured revision that the client does not accept during MCP
		/// initialization.
		revision: Str,
	},
	/// Protocol preference repeats a revision.
	#[error("MCP server `{name}` repeats protocol revision `{revision}`")]
	DuplicateProtocolRevision {
		/// Server key whose ordered protocol-negotiation preferences repeat a
		/// revision.
		name:     Str,
		/// Accepted revision that appears more than once in the preference list.
		revision: Str,
	},
}

#[cfg(test)]
mod tests {
	use super::*;

	fn stdio(command: &str) -> McpServerConfig {
		McpServerConfig {
			transport:         Some(TransportKind::Stdio),
			enabled:           true,
			command:           Some(Str::from(command)),
			args:              Vec::new(),
			env:               BTreeMap::new(),
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

	#[test]
	fn precedence_and_disable_ownership_are_deterministic() {
		let mut user = McpConfigFile::default();
		user.mcp_servers.insert(Str::from("shared"), stdio("user"));
		user
			.mcp_servers
			.insert(Str::from("user-only"), stdio("user"));
		user.disabled_servers.insert(Str::from("disabled-only"));
		user.disabled_servers.insert(Str::from("shared"));
		let mut project = McpConfigFile::default();
		project
			.mcp_servers
			.insert(Str::from("shared"), stdio("project"));
		project
			.mcp_servers
			.insert(Str::from("project-only"), stdio("project"));
		let sources = [
			ConfigSource { path: PathBuf::from("user"), kind: ConfigSourceKind::User, file: user },
			ConfigSource {
				path: PathBuf::from("project"),
				kind: ConfigSourceKind::Project,
				file: project,
			},
		];
		let enabled = resolve_sources(&sources, true);
		assert!(!enabled.servers.contains_key("shared"));
		assert!(enabled.servers.contains_key("project-only"));
		assert!(enabled.disabled_names.contains("disabled-only"));
		let project_off = resolve_sources(&sources, false);
		assert!(project_off.servers.contains_key("user-only"));
		assert!(!project_off.servers.contains_key("project-only"));
	}

	#[test]
	fn disabled_project_scope_drops_root_before_equivalence_dedup() {
		let mut root = McpConfigFile::default();
		root
			.mcp_servers
			.insert(Str::from("root-alias"), stdio("same"));
		let mut user = McpConfigFile::default();
		user
			.mcp_servers
			.insert(Str::from("user-alias"), stdio("same"));
		let sources = [
			ConfigSource { path: PathBuf::from("root"), kind: ConfigSourceKind::Root, file: root },
			ConfigSource { path: PathBuf::from("user"), kind: ConfigSourceKind::User, file: user },
		];
		let enabled = resolve_sources(&sources, true);
		assert!(enabled.servers.contains_key("user-alias"));
		assert!(!enabled.servers.contains_key("root-alias"));
		let project_off = resolve_sources(&sources, false);
		assert!(project_off.servers.contains_key("user-alias"));
		assert!(!project_off.servers.contains_key("root-alias"));
	}

	#[test]
	fn literal_environment_semantics_prevent_false_connection_deduplication() {
		let mut project_config = stdio("server");
		project_config
			.env
			.insert(Str::from("TOKEN"), Str::from("TOKEN"));
		project_config.env_literal_keys.insert(Str::from("TOKEN"));
		let mut project = McpConfigFile::default();
		project
			.mcp_servers
			.insert(Str::from("literal"), project_config);

		let mut user_config = stdio("server");
		user_config
			.env
			.insert(Str::from("TOKEN"), Str::from("TOKEN"));
		let mut user = McpConfigFile::default();
		user.mcp_servers.insert(Str::from("dynamic"), user_config);

		let resolved = resolve_sources(
			&[
				ConfigSource {
					path: PathBuf::from("project"),
					kind: ConfigSourceKind::Project,
					file: project,
				},
				ConfigSource { path: PathBuf::from("user"), kind: ConfigSourceKind::User, file: user },
			],
			true,
		);
		assert_eq!(resolved.servers.len(), 2);
	}

	#[test]
	fn force_enable_never_overrides_denylist() {
		let mut user = McpConfigFile::default();
		user.disabled_servers.insert(Str::from("server"));
		user.enabled_servers.insert(Str::from("server"));
		let mut manifest = McpConfigFile::default();
		let mut config = stdio("server");
		config.enabled = false;
		manifest.mcp_servers.insert(Str::from("server"), config);
		let resolved = resolve_sources(
			&[
				ConfigSource { path: PathBuf::from("user"), kind: ConfigSourceKind::User, file: user },
				ConfigSource {
					path: PathBuf::from("manifest"),
					kind: ConfigSourceKind::Manifest,
					file: manifest,
				},
			],
			true,
		);
		assert!(resolved.servers.is_empty());
	}

	#[test]
	fn validates_transport_and_revision_contract() {
		let mut config = stdio("server");
		config.url = Some(Str::from("https://example.test/mcp"));
		config.protocol_versions.push(Str::from("2099-01-01"));
		let errors = validate_server("bad", &config);
		assert!(
			errors
				.iter()
				.any(|error| matches!(error, ConfigValidationError::TransportConflict { .. }))
		);
		assert!(
			errors.iter().any(|error| matches!(
				error,
				ConfigValidationError::UnsupportedProtocolRevision { .. }
			))
		);
	}
}
