//! Native LSP catalog loading, layered field merging, validation, and
//! provenance.

use std::{
	collections::BTreeMap,
	fs, io,
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_core::Str;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::docserver::lsp_process::{
	LspProcessConfig, LspProcessSelectorConfig, LspTransportSettings,
};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const MAX_VALUE_DEPTH: usize = 64;
const MAX_VALUE_NODES: usize = 100_000;
const CONFIG_NAMES: [&str; 6] =
	["lsp.json", ".lsp.json", "lsp.yaml", ".lsp.yaml", "lsp.yml", ".lsp.yml"];

/// Origin class of one native LSP declaration.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Serialize, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum LspConfigSourceKind {
	/// Bundled OMP catalog.
	Builtin,
	/// User-owned OMP configuration.
	User,
	/// Project-owned OMP configuration.
	Project,
	/// Project-root dotfile configuration.
	Dotfile,
	/// Validated native extension-manifest contribution.
	Manifest,
}

/// Stable source identity retained on every resolved field.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct LspConfigProvenance {
	/// Source class.
	pub kind:   LspConfigSourceKind,
	/// Native file or manifest identity.
	pub source: Str,
}

/// A resolved field and the declaration that last wrote it.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Provenanced<T> {
	/// Resolved value.
	pub value:      T,
	/// Winning source.
	pub provenance: LspConfigProvenance,
}

/// One ordered native configuration input. Inputs are merged in slice order.
#[derive(Clone, Debug)]
pub struct LspConfigSource {
	/// Source provenance.
	pub provenance: LspConfigProvenance,
	/// Configuration bytes.
	pub bytes:      Arc<[u8]>,
	/// Whether the bytes use YAML rather than JSON.
	pub yaml:       bool,
}

impl LspConfigSource {
	/// Reads a bounded native JSON/YAML source.
	pub fn read(kind: LspConfigSourceKind, path: &Path) -> Result<Self, LspConfigError> {
		let metadata = fs::metadata(path)
			.map_err(|source| LspConfigError::Read { path: path.to_owned(), source })?;
		if metadata.len() > MAX_CONFIG_BYTES {
			return Err(LspConfigError::TooLarge { path: path.to_owned(), limit: MAX_CONFIG_BYTES });
		}
		let bytes =
			fs::read(path).map_err(|source| LspConfigError::Read { path: path.to_owned(), source })?;
		let yaml = matches!(path.extension().and_then(|value| value.to_str()), Some("yaml" | "yml"));
		Ok(Self {
			provenance: LspConfigProvenance { kind, source: Str::new(path.to_string_lossy()) },
			bytes: bytes.into(),
			yaml,
		})
	}

	/// Creates a bounded native manifest contribution already validated by the
	/// extension authority.
	pub fn manifest(identity: impl AsRef<str>, bytes: impl Into<Arc<[u8]>>, yaml: bool) -> Self {
		Self {
			provenance: LspConfigProvenance {
				kind:   LspConfigSourceKind::Manifest,
				source: Str::new(identity.as_ref()),
			},
			bytes: bytes.into(),
			yaml,
		}
	}

	/// Creates and validates a manifest contribution whose commands must name
	/// lock-materialized binaries or explicitly granted environment executables.
	pub fn manifest_checked(
		identity: impl AsRef<str>,
		bytes: impl Into<Arc<[u8]>>,
		yaml: bool,
		allowed_commands: impl IntoIterator<Item = Str>,
	) -> Result<Self, LspConfigError> {
		let source = Self::manifest(identity, bytes, yaml);
		let allowed = allowed_commands
			.into_iter()
			.collect::<std::collections::BTreeSet<_>>();
		let resolved = load_lsp_config(std::slice::from_ref(&source))?;
		for server in resolved.servers.values() {
			let command = &server.command.value;
			if command.contains('/') || command.contains('\\') || !allowed.contains(command) {
				return Err(LspConfigError::UndeclaredManifestCommand {
					server:  server.name.clone(),
					command: command.clone(),
				});
			}
		}
		Ok(source)
	}
}

/// Partially specified server declaration used during field-wise merging.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct LspServerPatch {
	command:                Option<Str>,
	args:                   Option<Vec<Str>>,
	file_types:             Option<Vec<Str>>,
	root_markers:           Option<Vec<Str>>,
	language_id:            Option<Str>,
	init_options:           Option<Value>,
	initialization_options: Option<Value>,
	settings:               Option<Value>,
	capabilities:           Option<Value>,
	priority:               Option<i32>,
	is_linter:              Option<bool>,
	disabled:               Option<bool>,
	warmup_timeout_ms:      Option<u64>,
	idle_timeout_ms:        Option<u64>,
	readiness_timeout_ms:   Option<u64>,
}

#[derive(Default)]
struct MergedServer {
	command:              Option<Provenanced<Str>>,
	args:                 Option<Provenanced<Vec<Str>>>,
	file_types:           Option<Provenanced<Vec<Str>>>,
	root_markers:         Option<Provenanced<Vec<Str>>>,
	language_id:          Option<Provenanced<Option<Str>>>,
	init_options:         Option<Provenanced<Value>>,
	settings:             Option<Provenanced<Value>>,
	capabilities:         Option<Provenanced<Value>>,
	priority:             Option<Provenanced<i32>>,
	is_linter:            Option<Provenanced<bool>>,
	disabled:             Option<Provenanced<bool>>,
	warmup_timeout_ms:    Option<Provenanced<u64>>,
	idle_timeout_ms:      Option<Provenanced<Option<u64>>>,
	readiness_timeout_ms: Option<Provenanced<u64>>,
}

/// Fully validated native language-server declaration.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedLspServer {
	/// Stable declaration name.
	pub name:                 Str,
	/// Executable name/path.
	pub command:              Provenanced<Str>,
	/// Exact command arguments.
	pub args:                 Provenanced<Vec<Str>>,
	/// Accepted extensions or exact filenames.
	pub file_types:           Provenanced<Vec<Str>>,
	/// Ancestor root markers, including single-level globs.
	pub root_markers:         Provenanced<Vec<Str>>,
	/// Optional explicit LSP language identifier.
	pub language_id:          Provenanced<Option<Str>>,
	/// Initialize options.
	pub init_options:         Provenanced<Value>,
	/// Configuration settings.
	pub settings:             Provenanced<Value>,
	/// Native capability hints.
	pub capabilities:         Provenanced<Value>,
	/// Explicit priority; larger values run first.
	pub priority:             Provenanced<i32>,
	/// Whether this declaration is a checker/linter rather than a primary
	/// server.
	pub is_linter:            Provenanced<bool>,
	/// Whether startup is disabled.
	pub disabled:             Provenanced<bool>,
	/// Startup warmup bound.
	pub warmup_timeout_ms:    Provenanced<u64>,
	/// Optional inactivity timeout.
	pub idle_timeout_ms:      Provenanced<Option<u64>>,
	/// Workspace readiness bound.
	pub readiness_timeout_ms: Provenanced<u64>,
}

/// A resolved catalog plus global timing policy.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ResolvedLspConfig {
	/// Declarations in deterministic name order.
	pub servers:         BTreeMap<Str, ResolvedLspServer>,
	/// Optional global idle timeout.
	pub idle_timeout_ms: Option<Provenanced<u64>>,
}

impl ResolvedLspServer {
	/// Lowers a resolved declaration into the process-owned startup shape.
	pub fn to_process_config(&self) -> LspProcessConfig {
		let path_patterns = self
			.file_types
			.value
			.iter()
			.map(|file_type| {
				let value = file_type.as_str();
				if value.starts_with('.') {
					Str::new(format!("**/*{value}"))
				} else if value.contains('.') {
					Str::new(format!("**/*.{value}"))
				} else {
					Str::new(format!("**/{value}"))
				}
			})
			.collect();
		let languages = self.language_id.value.iter().cloned().collect();
		let mut transport = LspTransportSettings::default();
		transport.initialize_timeout_ms = self.warmup_timeout_ms.value.clamp(1, 120_000);
		LspProcessConfig {
			name: self.name.clone(),
			priority: self.priority.value,
			selector: LspProcessSelectorConfig {
				languages,
				schemes: vec![Str::new_static("file")],
				path_patterns,
			},
			executable: PathBuf::from(self.command.value.as_str()),
			args: self.args.value.clone(),
			env: BTreeMap::new(),
			initialization_options: Some(self.init_options.value.clone()),
			settings: Some(self.settings.value.clone()),
			root_markers: self.root_markers.value.clone(),
			is_linter: self.is_linter.value,
			idle_timeout_ms: self.idle_timeout_ms.value,
			readiness_timeout_ms: self.readiness_timeout_ms.value,
			transport,
		}
	}
}

/// Loads the bundled language-server catalog.
pub fn bundled_lsp_defaults() -> Result<LspConfigSource, LspConfigError> {
	let bytes: Arc<[u8]> = include_bytes!("../../data/lsp-defaults.json")
		.as_slice()
		.into();
	Ok(LspConfigSource {
		provenance: LspConfigProvenance {
			kind:   LspConfigSourceKind::Builtin,
			source: Str::new_static("omp:lsp-defaults.json"),
		},
		bytes,
		yaml: false,
	})
}

/// Enumerates only native user/project paths. Foreign roots are never
/// considered. Existing paths are returned from low to high precedence.
pub fn discover_native_lsp_sources(
	user_root: Option<&Path>,
	project_root: &Path,
) -> Result<Vec<LspConfigSource>, LspConfigError> {
	discover_native_lsp_sources_with_manifests(user_root, project_root, Vec::new())
}

/// Enumerates built-in, extension-manifest, user, and project sources in
/// increasing precedence.
pub fn discover_native_lsp_sources_with_manifests(
	user_root: Option<&Path>,
	project_root: &Path,
	mut manifests: Vec<LspConfigSource>,
) -> Result<Vec<LspConfigSource>, LspConfigError> {
	let mut sources = vec![bundled_lsp_defaults()?];
	manifests.sort_by(|left, right| left.provenance.source.cmp(&right.provenance.source));
	sources.extend(manifests);
	if let Some(user_root) = user_root {
		append_existing(&mut sources, user_root, LspConfigSourceKind::User)?;
		append_existing(&mut sources, &user_root.join("agent"), LspConfigSourceKind::User)?;
	}
	append_existing(&mut sources, &project_root.join(".omp"), LspConfigSourceKind::Project)?;
	for name in CONFIG_NAMES {
		let path = project_root.join(name);
		if path.is_file() {
			sources.push(LspConfigSource::read(LspConfigSourceKind::Dotfile, &path)?);
		}
	}
	Ok(sources)
}

fn append_existing(
	sources: &mut Vec<LspConfigSource>,
	directory: &Path,
	kind: LspConfigSourceKind,
) -> Result<(), LspConfigError> {
	for name in CONFIG_NAMES {
		let path = directory.join(name);
		if path.is_file() {
			sources.push(LspConfigSource::read(kind, &path)?);
		}
	}
	Ok(())
}

/// Merges ordered native sources field by field and retains winning
/// provenance.
pub fn load_lsp_config(sources: &[LspConfigSource]) -> Result<ResolvedLspConfig, LspConfigError> {
	let mut merged = BTreeMap::<Str, MergedServer>::new();
	let mut idle_timeout_ms = None;
	for source in sources {
		if source.bytes.len() as u64 > MAX_CONFIG_BYTES {
			return Err(LspConfigError::TooLarge {
				path:  PathBuf::from(source.provenance.source.as_str()),
				limit: MAX_CONFIG_BYTES,
			});
		}
		let value = parse_value(source)?;
		validate_value_bounds(&value)?;
		let (servers, idle) = normalize_document(value)?;
		if let Some(idle) = idle {
			idle_timeout_ms =
				Some(Provenanced { value: idle, provenance: source.provenance.clone() });
		}
		for (name, patch) in servers {
			merge_server(merged.entry(name).or_default(), patch, &source.provenance);
		}
	}
	let mut servers = BTreeMap::new();
	for (name, merged) in merged {
		let resolved = resolve_server(name.clone(), merged)?;
		servers.insert(name, resolved);
	}
	Ok(ResolvedLspConfig { servers, idle_timeout_ms })
}

fn parse_value(source: &LspConfigSource) -> Result<Value, LspConfigError> {
	if source.yaml {
		serde_yaml::from_slice(&source.bytes).map_err(|source_error| LspConfigError::ParseYaml {
			source_name: source.provenance.source.clone(),
			source:      source_error,
		})
	} else {
		serde_json::from_slice(&source.bytes).map_err(|source_error| LspConfigError::ParseJson {
			source_name: source.provenance.source.clone(),
			source:      source_error,
		})
	}
}

fn validate_value_bounds(value: &Value) -> Result<(), LspConfigError> {
	let mut nodes = 0_usize;
	let mut stack = vec![(value, 1_usize)];
	while let Some((value, depth)) = stack.pop() {
		nodes += 1;
		if depth > MAX_VALUE_DEPTH || nodes > MAX_VALUE_NODES {
			return Err(LspConfigError::StructureLimit);
		}
		match value {
			Value::Array(values) => stack.extend(values.iter().map(|value| (value, depth + 1))),
			Value::Object(values) => stack.extend(values.values().map(|value| (value, depth + 1))),
			_ => {},
		}
	}
	Ok(())
}

fn normalize_document(
	value: Value,
) -> Result<(BTreeMap<Str, LspServerPatch>, Option<u64>), LspConfigError> {
	let mut object = value
		.as_object()
		.cloned()
		.ok_or(LspConfigError::TopLevelObject)?;
	let idle = object
		.remove("idleTimeoutMs")
		.map(serde_json::from_value)
		.transpose()
		.map_err(|source| LspConfigError::InvalidDocument { source })?;
	let servers = match object.remove("servers") {
		Some(Value::Object(servers)) => servers,
		Some(_) => return Err(LspConfigError::ServersObject),
		None => object,
	};
	servers
		.into_iter()
		.map(|(name, value)| {
			let patch = serde_json::from_value(value)
				.map_err(|source| LspConfigError::InvalidServer { server: Str::new(&name), source })?;
			Ok((Str::new(name), patch))
		})
		.collect::<Result<BTreeMap<_, _>, _>>()
		.map(|servers| (servers, idle))
}

fn sourced<T>(value: T, provenance: &LspConfigProvenance) -> Provenanced<T> {
	Provenanced { value, provenance: provenance.clone() }
}

fn merge_server(
	target: &mut MergedServer,
	patch: LspServerPatch,
	provenance: &LspConfigProvenance,
) {
	if let Some(value) = patch.command {
		target.command = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.args {
		target.args = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.file_types {
		target.file_types = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.root_markers {
		target.root_markers = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.language_id {
		target.language_id = Some(sourced(Some(value), provenance));
	}
	if let Some(value) = patch.init_options.or(patch.initialization_options) {
		target.init_options = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.settings {
		target.settings = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.capabilities {
		target.capabilities = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.priority {
		target.priority = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.is_linter {
		target.is_linter = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.disabled {
		target.disabled = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.warmup_timeout_ms {
		target.warmup_timeout_ms = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.idle_timeout_ms {
		target.idle_timeout_ms = Some(sourced(Some(value), provenance));
	}
	if let Some(value) = patch.readiness_timeout_ms {
		target.readiness_timeout_ms = Some(sourced(value, provenance));
	}
}

fn resolve_server(name: Str, merged: MergedServer) -> Result<ResolvedLspServer, LspConfigError> {
	let command = merged
		.command
		.ok_or_else(|| LspConfigError::MissingField { server: name.clone(), field: "command" })?;
	let file_types = merged
		.file_types
		.ok_or_else(|| LspConfigError::MissingField { server: name.clone(), field: "fileTypes" })?;
	let root_markers = merged
		.root_markers
		.ok_or_else(|| LspConfigError::MissingField {
			server: name.clone(),
			field:  "rootMarkers",
		})?;
	if command.value.is_empty() || file_types.value.is_empty() || root_markers.value.is_empty() {
		return Err(LspConfigError::EmptyRequiredField { server: name });
	}
	let fallback = command.provenance.clone();
	Ok(ResolvedLspServer {
		name,
		command,
		args: merged
			.args
			.unwrap_or_else(|| sourced(Vec::new(), &fallback)),
		file_types,
		root_markers,
		language_id: merged
			.language_id
			.unwrap_or_else(|| sourced(None, &fallback)),
		init_options: merged
			.init_options
			.unwrap_or_else(|| sourced(Value::Object(Map::new()), &fallback)),
		settings: merged
			.settings
			.unwrap_or_else(|| sourced(Value::Object(Map::new()), &fallback)),
		capabilities: merged
			.capabilities
			.unwrap_or_else(|| sourced(Value::Object(Map::new()), &fallback)),
		priority: merged.priority.unwrap_or_else(|| sourced(0, &fallback)),
		is_linter: merged
			.is_linter
			.unwrap_or_else(|| sourced(false, &fallback)),
		disabled: merged.disabled.unwrap_or_else(|| sourced(false, &fallback)),
		warmup_timeout_ms: merged
			.warmup_timeout_ms
			.unwrap_or_else(|| sourced(10_000, &fallback)),
		idle_timeout_ms: merged
			.idle_timeout_ms
			.unwrap_or_else(|| sourced(None, &fallback)),
		readiness_timeout_ms: merged
			.readiness_timeout_ms
			.unwrap_or_else(|| sourced(30_000, &fallback)),
	})
}

/// Small resolved-config cache explicitly evicted during reload.
#[derive(Default)]
pub struct LspConfigCache {
	entries: Mutex<BTreeMap<PathBuf, Arc<ResolvedLspConfig>>>,
}

impl LspConfigCache {
	/// Returns a cached configuration.
	pub fn get(&self, workspace: &Path) -> Option<Arc<ResolvedLspConfig>> {
		self.entries.lock().get(workspace).cloned()
	}

	/// Stores one resolved configuration.
	pub fn insert(&self, workspace: PathBuf, config: Arc<ResolvedLspConfig>) {
		self.entries.lock().insert(workspace, config);
	}

	/// Evicts one workspace before reload.
	pub fn evict(&self, workspace: &Path) -> Option<Arc<ResolvedLspConfig>> {
		self.entries.lock().remove(workspace)
	}
}

/// Native LSP configuration failure.
#[derive(Debug, Error)]
pub enum LspConfigError {
	/// A source could not be read.
	#[error("cannot read LSP configuration {}: {source}", path.display())]
	Read {
		/// Source path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A source exceeds the byte bound.
	#[error("LSP configuration {} exceeds {limit} bytes", path.display())]
	TooLarge {
		/// Oversized source path.
		path:  PathBuf,
		/// Maximum accepted bytes.
		limit: u64,
	},
	/// JSON parsing failed.
	#[error("invalid JSON LSP configuration {source_name}: {source}")]
	ParseJson {
		/// Source identity.
		source_name: Str,
		/// JSON decoder failure.
		#[source]
		source:      serde_json::Error,
	},
	/// YAML parsing failed.
	#[error("invalid YAML LSP configuration {source_name}: {source}")]
	ParseYaml {
		/// Source identity.
		source_name: Str,
		/// YAML decoder failure.
		#[source]
		source:      serde_yaml::Error,
	},
	/// The expanded structure exceeded depth/node bounds.
	#[error("LSP configuration exceeds structural bounds")]
	StructureLimit,
	/// Top-level configuration must be an object.
	#[error("LSP configuration must be an object")]
	TopLevelObject,
	/// `servers` must be an object.
	#[error("LSP configuration servers field must be an object")]
	ServersObject,
	/// A manifest command was neither materialized nor explicitly granted.
	#[error("manifest LSP server {server} references undeclared command {command}")]
	UndeclaredManifestCommand {
		/// Server declaration name.
		server:  Str,
		/// Rejected command.
		command: Str,
	},
	/// A top-level setting had the wrong type.
	#[error("invalid LSP configuration document: {source}")]
	InvalidDocument {
		/// Schema decoder failure.
		#[source]
		source: serde_json::Error,
	},
	/// A server declaration had the wrong shape.
	#[error("invalid LSP server {server}: {source}")]
	InvalidServer {
		/// Server name.
		server: Str,
		/// Schema decoder failure.
		#[source]
		source: serde_json::Error,
	},
	/// A required field was absent after merging.
	#[error("LSP server {server} is missing {field}")]
	MissingField {
		/// Server name.
		server: Str,
		/// Missing field name.
		field:  &'static str,
	},
	/// A required field was present but empty.
	#[error("LSP server {server} has an empty required field")]
	EmptyRequiredField {
		/// Server name.
		server: Str,
	},
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bundled_catalog_is_complete_and_preserves_pi_fields() {
		let config = load_lsp_config(&[bundled_lsp_defaults().unwrap()]).unwrap();
		assert!(config.servers.len() >= 45);
		let rust = &config.servers["rust-analyzer"];
		assert_eq!(rust.command.value, "rust-analyzer");
		assert!(
			rust
				.root_markers
				.value
				.iter()
				.any(|marker| marker == "Cargo.toml")
		);
		assert_eq!(config.servers["swiftlint"].is_linter.value, true);
		assert_eq!(config.servers["omnisharp"].args.value[2], "$PID");
	}

	#[test]
	fn yaml_override_merges_fields_and_stamps_provenance() {
		let defaults = bundled_lsp_defaults().unwrap();
		let project = LspConfigSource {
			provenance: LspConfigProvenance {
				kind:   LspConfigSourceKind::Project,
				source: Str::new_static("fixture"),
			},
			bytes:      Arc::from(
				&b"servers:\n  rust-analyzer:\n    disabled: true\n    warmupTimeoutMs: 321\n"[..],
			),
			yaml:       true,
		};
		let config = load_lsp_config(&[defaults, project]).unwrap();
		let rust = &config.servers["rust-analyzer"];
		assert!(rust.disabled.value);
		assert_eq!(rust.warmup_timeout_ms.value, 321);
		assert_eq!(rust.command.provenance.kind, LspConfigSourceKind::Builtin);
		assert_eq!(rust.disabled.provenance.kind, LspConfigSourceKind::Project);
	}

	#[test]
	fn manifest_commands_require_declared_executables() {
		let bytes = br#"{"servers":{"acme":{"command":"acme-lsp","fileTypes":["rs"],"rootMarkers":["Cargo.toml"]}}}"#;
		assert!(LspConfigSource::manifest_checked("acme:lsp", bytes.as_slice(), false, []).is_err());
		let source =
			LspConfigSource::manifest_checked("acme:lsp", bytes.as_slice(), false, [Str::new_static(
				"acme-lsp",
			)])
			.unwrap();
		let config = load_lsp_config(&[source]).unwrap();
		assert_eq!(config.servers["acme"].command.provenance.kind, LspConfigSourceKind::Manifest);
	}
}
