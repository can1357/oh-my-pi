//! Read-only discovery of MCP declarations owned by other agent ecosystems.
//!
//! Native OMP files remain the writable authority. These adapters only
//! normalize foreign declarations into the same typed server contract; a
//! missing or malformed foreign file is contained to that source and cannot
//! suppress independent sources.

use std::{
	collections::BTreeMap,
	fs, io,
	path::{Path, PathBuf},
};

use omp_core::Str;
use serde::Deserialize;

use super::{
	McpConfigPaths,
	config::{
		ConfigSource, ConfigSourceKind, McpConfigFile, McpServerConfig, RequestIdFormat,
		TransportKind,
	},
};

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerDocument {
	#[serde(default)]
	mcp_servers: BTreeMap<Str, ForeignServer>,
	#[serde(default)]
	servers:     BTreeMap<Str, ForeignServer>,
}

#[derive(Debug, Default, Deserialize)]
struct OpenCodeDocument {
	#[serde(default)]
	mcp: BTreeMap<Str, ForeignServer>,
}

#[derive(Debug, Default, Deserialize)]
struct VsCodeDocument {
	#[serde(default)]
	servers: BTreeMap<Str, ForeignServer>,
	#[serde(default)]
	mcp:     VsCodeMcp,
}

#[derive(Debug, Default, Deserialize)]
struct VsCodeMcp {
	#[serde(default)]
	servers: BTreeMap<Str, ForeignServer>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ForeignServer {
	#[serde(default)]
	enabled:           Option<bool>,
	#[serde(default, rename = "type")]
	kind:              Option<Str>,
	#[serde(default)]
	transport:         Option<Str>,
	#[serde(default)]
	command:           Option<ForeignCommand>,
	#[serde(default)]
	args:              Vec<Str>,
	#[serde(default)]
	env:               BTreeMap<Str, Str>,
	#[serde(default)]
	environment:       BTreeMap<Str, Str>,
	#[serde(default)]
	cwd:               Option<PathBuf>,
	#[serde(default)]
	url:               Option<Str>,
	#[serde(default)]
	headers:           BTreeMap<Str, Str>,
	#[serde(default)]
	timeout:           Option<u64>,
	#[serde(default)]
	request_id_format: Option<RequestIdFormat>,
	#[serde(skip)]
	plugin_data:       Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(untagged)]
enum ForeignCommand {
	One(Str),
	Many(Vec<Str>),
}

#[derive(Debug, Default, Deserialize)]
struct CodexDocument {
	#[serde(default)]
	mcp_servers: BTreeMap<Str, CodexServer>,
}

#[derive(Debug, Default, Deserialize)]
struct CodexServer {
	#[serde(default)]
	enabled:          Option<bool>,
	#[serde(default)]
	command:          Option<Str>,
	#[serde(default)]
	args:             Vec<Str>,
	#[serde(default)]
	env:              BTreeMap<Str, Str>,
	#[serde(default)]
	url:              Option<Str>,
	#[serde(default)]
	http_headers:     BTreeMap<Str, Str>,
	#[serde(default)]
	cwd:              Option<PathBuf>,
	#[serde(default)]
	tool_timeout_sec: Option<u64>,
}

#[derive(Debug, Default, Deserialize)]
struct ClaudeUserDocument {
	#[serde(default, rename = "mcpServers")]
	mcp_servers: BTreeMap<Str, ForeignServer>,
	#[serde(default)]
	projects:    BTreeMap<PathBuf, ServerDocument>,
}

#[derive(Debug, Deserialize)]
struct AgentPluginManifest {
	#[serde(rename = "$schema")]
	schema: Str,
	name:   Str,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AgentPluginMcpDocument {
	#[serde(rename = "$schema")]
	schema:      Str,
	mcp_servers: BTreeMap<Str, ForeignServer>,
}

const AGENT_PLUGIN_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const AGENT_PLUGIN_MCP_SCHEMA: &str = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/// Discovers every supported foreign MCP source in deterministic precedence
/// order. Native sources are loaded by the caller before these rows.
pub(super) fn sources(paths: &McpConfigPaths) -> Vec<ConfigSource> {
	let project = paths.root.parent().unwrap_or(Path::new("."));
	let home = &paths.home;
	let mut sources = Vec::new();

	// Claude: project declarations precede user declarations. `~/.claude.json`
	// may carry both a global map and a map keyed by canonical project path.
	push_json(
		&mut sources,
		project.join(".claude/.mcp.json"),
		ConfigSourceKind::ClaudeProject,
		JsonShape::Common,
	);
	let claude_user = home.join(".claude.json");
	if let Some(document) = read_json::<ClaudeUserDocument>(&claude_user) {
		let canonical_project = fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
		if let Some(project_document) = document
			.projects
			.get(project)
			.or_else(|| document.projects.get(&canonical_project))
		{
			push_document(
				&mut sources,
				claude_user.clone(),
				ConfigSourceKind::ClaudeProject,
				project_document.mcp_servers.clone(),
			);
		}
		push_document(&mut sources, claude_user, ConfigSourceKind::ClaudeUser, document.mcp_servers);
	}
	push_json(
		&mut sources,
		home.join(".claude/mcp.json"),
		ConfigSourceKind::ClaudeUser,
		JsonShape::Common,
	);

	let user_config_root = paths.user.parent().unwrap_or(home);
	let plugin_data_root = user_config_root.join("agent/plugin-data");
	push_agent_plugins(&mut sources, &plugin_data_root, &[
		(project.join(".omp/extensions"), ConfigSourceKind::AgentPluginProject),
		(project.join(".agent/plugins"), ConfigSourceKind::AgentPluginProject),
		(project.join(".agents/plugins"), ConfigSourceKind::AgentPluginProject),
		(user_config_root.join("extensions"), ConfigSourceKind::AgentPluginUser),
		(user_config_root.join("agent/plugins"), ConfigSourceKind::AgentPluginUser),
	]);
	for root in &paths.agent_plugin_roots {
		push_agent_plugin_root(
			&mut sources,
			&plugin_data_root,
			root,
			ConfigSourceKind::AgentPluginProject,
		);
	}

	push_codex(&mut sources, project.join(".codex/config.toml"), ConfigSourceKind::CodexProject);
	push_codex(&mut sources, home.join(".codex/config.toml"), ConfigSourceKind::CodexUser);
	push_json(
		&mut sources,
		project.join(".gemini/settings.json"),
		ConfigSourceKind::GeminiProject,
		JsonShape::Common,
	);
	push_json(
		&mut sources,
		home.join(".gemini/settings.json"),
		ConfigSourceKind::GeminiUser,
		JsonShape::Common,
	);

	// OpenCode merges low-to-high; emit the high-precedence files first because
	// the central resolver is first-wins within one provider.
	for path in [
		project.join(".opencode/opencode.jsonc"),
		project.join(".opencode/opencode.json"),
		project.join("opencode.jsonc"),
		project.join("opencode.json"),
	] {
		push_json(&mut sources, path, ConfigSourceKind::OpenCodeProject, JsonShape::OpenCode);
	}
	for path in
		[home.join(".config/opencode/opencode.jsonc"), home.join(".config/opencode/opencode.json")]
	{
		push_json(&mut sources, path, ConfigSourceKind::OpenCodeUser, JsonShape::OpenCode);
	}
	push_json(
		&mut sources,
		project.join(".cursor/mcp.json"),
		ConfigSourceKind::CursorProject,
		JsonShape::Common,
	);
	push_json(
		&mut sources,
		home.join(".cursor/mcp.json"),
		ConfigSourceKind::CursorUser,
		JsonShape::Common,
	);
	push_json(
		&mut sources,
		project.join(".windsurf/mcp_config.json"),
		ConfigSourceKind::WindsurfProject,
		JsonShape::Common,
	);
	push_json(
		&mut sources,
		home.join(".codeium/windsurf/mcp_config.json"),
		ConfigSourceKind::WindsurfUser,
		JsonShape::Common,
	);
	push_json(
		&mut sources,
		project.join(".vscode/mcp.json"),
		ConfigSourceKind::VsCodeProject,
		JsonShape::VsCode,
	);
	for path in [project.join("mcp.json"), project.join("mcp.config.json")] {
		push_json(&mut sources, path, ConfigSourceKind::StandaloneProject, JsonShape::Common);
	}
	sources
}

fn push_agent_plugins(
	out: &mut Vec<ConfigSource>,
	data_root: &Path,
	containers: &[(PathBuf, ConfigSourceKind)],
) {
	for (container, kind) in containers {
		let Ok(container_root) = fs::canonicalize(container) else {
			continue;
		};
		let Ok(entries) = fs::read_dir(container) else {
			continue;
		};
		let mut entries = entries.filter_map(Result::ok).collect::<Vec<_>>();
		entries.sort_by_key(std::fs::DirEntry::file_name);
		for entry in entries {
			let Ok(root) = fs::canonicalize(entry.path()) else {
				continue;
			};
			if !root.starts_with(&container_root) || !root.is_dir() {
				tracing::warn!(path = %entry.path().display(), "ignored Agent Plugin outside its discovery root");
				continue;
			}
			push_agent_plugin_root(out, data_root, &root, *kind);
		}
	}
}

fn push_agent_plugin_root(
	out: &mut Vec<ConfigSource>,
	data_root: &Path,
	root: &Path,
	kind: ConfigSourceKind,
) {
	let Ok(root) = fs::canonicalize(root) else {
		return;
	};
	let Ok(manifest_path) = fs::canonicalize(root.join("plugin.json")) else {
		return;
	};
	if !manifest_path.starts_with(&root) {
		tracing::warn!(path = %manifest_path.display(), "ignored Agent Plugin manifest outside its package");
		return;
	}
	let Ok(body) = fs::read_to_string(manifest_path) else {
		return;
	};
	let Ok(manifest) = serde_json::from_str::<AgentPluginManifest>(&body) else {
		return;
	};
	if manifest.schema != AGENT_PLUGIN_SCHEMA || !safe_plugin_name(&manifest.name) {
		return;
	}
	let configured = root.join("mcp.json");
	let Ok(real) = fs::canonicalize(&configured) else {
		return;
	};
	if !real.starts_with(&root) {
		tracing::warn!(path = %configured.display(), "ignored Agent Plugin MCP file outside its package");
		return;
	}
	let Some(mut document) = read_json::<AgentPluginMcpDocument>(&real) else {
		return;
	};
	if document.schema != AGENT_PLUGIN_MCP_SCHEMA {
		tracing::warn!(path = %real.display(), "ignored unsupported Agent Plugin MCP schema");
		return;
	}
	let data = data_root.join(manifest.name.as_str());
	for server in document.mcp_servers.values_mut() {
		server.plugin_data = Some(data.clone());
		server
			.env
			.insert(Str::new_static("PLUGIN_ROOT"), Str::new(root.to_string_lossy()));
		server
			.env
			.insert(Str::new_static("PLUGIN_DATA"), Str::new(data.to_string_lossy()));
		if server.cwd.is_none() && server.command.is_some() {
			server.cwd = Some(root.clone());
		}
	}
	push_document(out, real, kind, document.mcp_servers);
}

#[derive(Clone, Copy)]
enum JsonShape {
	Common,
	OpenCode,
	VsCode,
}

fn push_json(out: &mut Vec<ConfigSource>, path: PathBuf, kind: ConfigSourceKind, shape: JsonShape) {
	let servers = match shape {
		JsonShape::Common => {
			let Some(document) = read_jsonc::<ServerDocument>(&path) else {
				return;
			};
			if document.mcp_servers.is_empty() {
				document.servers
			} else {
				document.mcp_servers
			}
		},
		JsonShape::OpenCode => {
			let Some(document) = read_jsonc::<OpenCodeDocument>(&path) else {
				return;
			};
			document.mcp
		},
		JsonShape::VsCode => {
			let Some(document) = read_jsonc::<VsCodeDocument>(&path) else {
				return;
			};
			if document.servers.is_empty() {
				document.mcp.servers
			} else {
				document.servers
			}
		},
	};
	push_document(out, path, kind, servers);
}

fn push_document(
	out: &mut Vec<ConfigSource>,
	path: PathBuf,
	kind: ConfigSourceKind,
	servers: BTreeMap<Str, ForeignServer>,
) {
	if servers.is_empty() {
		return;
	}
	let base = path.parent().unwrap_or(Path::new("."));
	let mut file = McpConfigFile::default();
	for (name, server) in servers {
		match server.normalize(base) {
			Some(server) => {
				file.mcp_servers.insert(name, server);
			},
			None => {
				tracing::warn!(path = %path.display(), server = %name, "ignored malformed foreign MCP declaration")
			},
		}
	}
	if !file.mcp_servers.is_empty() {
		out.push(ConfigSource { path, kind, file });
	}
}

impl ForeignServer {
	fn normalize(self, base: &Path) -> Option<McpServerConfig> {
		let plugin_data = self.plugin_data;
		let replace = |value| replace_plugin_vars(value, base, plugin_data.as_deref());
		let (command, mut command_args) = match self.command {
			Some(ForeignCommand::One(command)) => (Some(replace(command)), Vec::new()),
			Some(ForeignCommand::Many(mut words)) if !words.is_empty() => {
				let command = replace(words.remove(0));
				for word in &mut words {
					*word = replace(word.clone());
				}
				(Some(command), words)
			},
			_ => (None, Vec::new()),
		};
		command_args.extend(self.args.into_iter().map(replace));
		let mut env = self.environment;
		env.extend(self.env);
		for value in env.values_mut() {
			*value = replace(value.clone());
		}
		let transport = match self.kind.as_deref().or(self.transport.as_deref()) {
			Some("http" | "remote") => Some(TransportKind::Http),
			Some("sse") => Some(TransportKind::Sse),
			Some("stdio" | "local") => Some(TransportKind::Stdio),
			Some(_) => return None,
			None => None,
		};
		let cwd = self.cwd.map(|cwd| {
			let encoded = cwd.to_str().map(str::to_owned);
			let cwd = encoded
				.map(|value| PathBuf::from(replace(Str::new(value)).as_str()))
				.unwrap_or(cwd);
			if cwd.is_absolute() {
				cwd
			} else {
				base.join(cwd)
			}
		});
		Some(McpServerConfig {
			transport,
			enabled: self.enabled.unwrap_or(true),
			command,
			args: command_args,
			env,
			env_policy: None,
			env_literal_keys: Default::default(),
			cwd,
			url: self.url.map(replace),
			headers: self
				.headers
				.into_iter()
				.map(|(name, value)| (name, replace(value)))
				.collect(),
			header_policy: None,
			timeout: self.timeout,
			request_id_format: self.request_id_format,
			auth: None,
			oauth: None,
			protocol_versions: Vec::new(),
		})
	}
}

fn safe_plugin_name(name: &str) -> bool {
	(1..=64).contains(&name.len())
		&& !name.contains("..")
		&& !name.contains("--")
		&& !name
			.as_bytes()
			.first()
			.is_some_and(|byte| matches!(*byte, b'.' | b'-'))
		&& !name
			.as_bytes()
			.last()
			.is_some_and(|byte| matches!(*byte, b'.' | b'-'))
		&& name.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
		})
}

fn replace_plugin_vars(value: Str, root: &Path, data: Option<&Path>) -> Str {
	if !value.contains("${PLUGIN_ROOT}")
		&& !value.contains("${PLUGIN_DATA}")
		&& !value.contains("${CLAUDE_PLUGIN_ROOT}")
		&& !value.contains("${OMP_PLUGIN_ROOT}")
	{
		return value;
	}
	let root = root.to_string_lossy();
	let replaced = value
		.replace("${PLUGIN_ROOT}", root.as_ref())
		.replace("${CLAUDE_PLUGIN_ROOT}", root.as_ref())
		.replace("${OMP_PLUGIN_ROOT}", root.as_ref());
	match data {
		Some(data) => Str::new(replaced.replace("${PLUGIN_DATA}", data.to_string_lossy().as_ref())),
		None => Str::new(replaced),
	}
}

fn push_codex(out: &mut Vec<ConfigSource>, path: PathBuf, kind: ConfigSourceKind) {
	let Some(document) = read_toml::<CodexDocument>(&path) else {
		return;
	};
	if document.mcp_servers.is_empty() {
		return;
	}
	let base = path.parent().unwrap_or(Path::new("."));
	let mut file = McpConfigFile::default();
	for (name, server) in document.mcp_servers {
		let cwd = server.cwd.map(|cwd| {
			if cwd.is_absolute() {
				cwd
			} else {
				base.join(cwd)
			}
		});
		file.mcp_servers.insert(name, McpServerConfig {
			transport: Some(if server.url.is_some() {
				TransportKind::Http
			} else {
				TransportKind::Stdio
			}),
			enabled: server.enabled.unwrap_or(true),
			command: server.command,
			args: server.args,
			env: server.env,
			env_policy: None,
			env_literal_keys: Default::default(),
			cwd,
			url: server.url,
			headers: server.http_headers,
			header_policy: None,
			timeout: server
				.tool_timeout_sec
				.and_then(|seconds| seconds.checked_mul(1_000)),
			request_id_format: None,
			auth: None,
			oauth: None,
			protocol_versions: Vec::new(),
		});
	}
	out.push(ConfigSource { path, kind, file });
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
	read_source(path, |body| serde_json::from_str(body).map_err(ReadError::Json))
}

fn read_jsonc<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
	read_source(path, |body| {
		let stripped = strip_json_comments(body);
		serde_json::from_str(&stripped).map_err(ReadError::Json)
	})
}

fn read_toml<T: for<'de> Deserialize<'de>>(path: &Path) -> Option<T> {
	read_source(path, |body| toml::from_str(body).map_err(ReadError::Toml))
}

fn read_source<T>(path: &Path, parse: impl FnOnce(&str) -> Result<T, ReadError>) -> Option<T> {
	let body = match fs::read_to_string(path) {
		Ok(body) => body,
		Err(error)
			if matches!(error.kind(), io::ErrorKind::NotFound | io::ErrorKind::NotADirectory) =>
		{
			return None;
		},
		Err(error) => {
			tracing::warn!(path = %path.display(), %error, "failed to read foreign MCP configuration");
			return None;
		},
	};
	match parse(&body) {
		Ok(value) => Some(value),
		Err(error) => {
			tracing::warn!(path = %path.display(), %error, "failed to parse foreign MCP configuration");
			None
		},
	}
}

#[derive(Debug, thiserror::Error)]
enum ReadError {
	#[error("JSON document is malformed")]
	Json(#[source] serde_json::Error),
	#[error("TOML document is malformed")]
	Toml(#[source] toml::de::Error),
}

fn strip_json_comments(source: &str) -> String {
	let mut out = Vec::with_capacity(source.len());
	let bytes = source.as_bytes();
	let (mut index, mut string, mut escaped) = (0, false, false);
	while index < bytes.len() {
		let byte = bytes[index];
		if string {
			out.push(byte);
			if escaped {
				escaped = false;
			} else if byte == b'\\' {
				escaped = true;
			} else if byte == b'"' {
				string = false;
			}
			index += 1;
			continue;
		}
		if byte == b'"' {
			string = true;
			out.push(b'"');
			index += 1;
		} else if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
			index += 2;
			while index < bytes.len() && bytes[index] != b'\n' {
				index += 1;
			}
		} else if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
			index += 2;
			while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
				if bytes[index] == b'\n' {
					out.push(b'\n');
				}
				index += 1;
			}
			index = (index + 2).min(bytes.len());
		} else if byte == b',' {
			let mut next = index + 1;
			while bytes.get(next).is_some_and(u8::is_ascii_whitespace) {
				next += 1;
			}
			if matches!(bytes.get(next), Some(b'}' | b']')) {
				index += 1;
				continue;
			}
			out.push(byte);
			index += 1;
		} else {
			out.push(byte);
			index += 1;
		}
	}
	String::from_utf8(out).expect("comment stripping preserves UTF-8 bytes")
}

#[cfg(test)]
mod tests {
	use super::*;

	fn write(path: &Path, body: &str) {
		fs::create_dir_all(path.parent().unwrap()).unwrap();
		fs::write(path, body).unwrap();
	}

	#[test]
	fn provider_precedence_and_errors_are_source_local() {
		let temp = tempfile::tempdir().unwrap();
		let home = temp.path().join("home");
		let project = temp.path().join("project");
		let user_root = home.join(".o2");
		write(&project.join(".claude/.mcp.json"), r#"{"mcpServers":{"same":{"command":"claude"}}}"#);
		write(
			&project.join(".gemini/settings.json"),
			r#"{"mcpServers":{"same":{"command":"gemini"},"gemini":{"command":"g"}}}"#,
		);
		write(&project.join(".cursor/mcp.json"), "{");
		write(
			&project.join(".vscode/mcp.json"),
			r#"{"servers":{"vscode":{"type":"stdio","command":"v"}}}"#,
		);
		let paths = McpConfigPaths::new(&user_root, &project);
		let sources = sources(&paths);
		let resolved = super::super::config::resolve_sources(&sources, true);
		assert_eq!(resolved.servers["same"].config.command.as_deref(), Some("claude"));
		assert!(resolved.servers.contains_key("gemini"));
		assert!(resolved.servers.contains_key("vscode"));
	}

	#[cfg(unix)]
	#[test]
	fn agent_plugin_paths_are_contained_and_root_placeholders_expand() {
		use std::os::unix::fs::symlink;

		let temp = tempfile::tempdir().unwrap();
		let home = temp.path().join("home");
		let project = temp.path().join("project");
		let plugin = temp.path().join("external/portable");
		write(
			&plugin.join("plugin.json"),
			r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"portable"}"#,
		);
		write(
			&plugin.join("mcp.json"),
			r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/mcp.schema.json","mcpServers":{"portable":{"type":"stdio","command":"${PLUGIN_ROOT}/server"}}}"#,
		);
		let escaped = temp.path().join("external/escaped");
		write(
			&escaped.join("plugin.json"),
			r#"{"$schema":"https://agent-plugins.org/schemas/1.0.0/plugin.schema.json","name":"escaped"}"#,
		);
		let outside = temp.path().join("outside.json");
		write(&outside, r#"{"mcpServers":{"escaped":{"command":"bad"}}}"#);
		symlink(&outside, escaped.join("mcp.json")).unwrap();

		let discovered = sources(
			&McpConfigPaths::new(&home.join(".o2"), &project)
				.with_agent_plugin_roots(vec![plugin.clone(), escaped]),
		);
		let resolved = super::super::config::resolve_sources(&discovered, true);
		let expected = fs::canonicalize(&plugin).unwrap().join("server");
		assert_eq!(
			resolved.servers["portable"].config.command.as_deref(),
			Some(expected.to_string_lossy().as_ref())
		);
		assert_eq!(
			resolved.servers["portable"].config.env["PLUGIN_DATA"],
			Str::new(
				home
					.join(".o2/agent/plugin-data/portable")
					.to_string_lossy()
			)
		);
		assert!(!resolved.servers.contains_key("escaped"));
	}

	#[test]
	fn jsonc_and_codex_commands_normalize() {
		let temp = tempfile::tempdir().unwrap();
		let home = temp.path().join("home");
		let project = temp.path().join("project");
		write(
			&project.join(".opencode/opencode.jsonc"),
			r#"{// comment
			"mcp":{"open":{"type":"local","command":["runner","serve"],"environment":{"A":"B"}}}}"#,
		);
		write(
			&project.join(".codex/config.toml"),
			"[mcp_servers.codex]\ncommand = \"runner\"\nargs = [\"serve\"]\ntool_timeout_sec = 3\n",
		);
		let sources = sources(&McpConfigPaths::new(&home.join(".o2"), &project));
		let resolved = super::super::config::resolve_sources(&sources, true);
		assert_eq!(resolved.servers["open"].config.args, [Str::new("serve")]);
		assert_eq!(resolved.servers["codex"].config.timeout, Some(3_000));
	}
}
