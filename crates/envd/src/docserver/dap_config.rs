//! Native DAP adapter discovery and provenance-preserving field merges.

use std::{
	collections::BTreeMap,
	fs, io,
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_core::Str;
use serde::Deserialize;
use serde_json::Map;

use crate::docserver::dap_adapter::{DapAdapterError, DapAdapterSpec, DapTransport};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;
const CONFIG_NAMES: [&str; 6] =
	["dap.json", ".dap.json", "dap.yaml", ".dap.yaml", "dap.yml", ".dap.yml"];

/// Native DAP declaration origin.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DapConfigSourceKind {
	/// Built-in adapter catalog.
	Builtin,
	/// User OMP configuration.
	User,
	/// Project OMP configuration.
	Project,
	/// Project-root dotfile.
	Dotfile,
	/// Validated native extension contribution.
	Manifest,
}

/// Exact source retained on resolved fields.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DapConfigProvenance {
	/// Source class.
	pub kind:   DapConfigSourceKind,
	/// Path or manifest identity.
	pub source: Str,
}

/// One source-annotated value.
#[derive(Clone, Debug, PartialEq)]
pub struct DapProvenanced<T> {
	/// Winning value.
	pub value:      T,
	/// Winning declaration.
	pub provenance: DapConfigProvenance,
}

/// Ordered native configuration input.
#[derive(Clone, Debug)]
pub struct DapConfigSource {
	/// Input identity.
	pub provenance: DapConfigProvenance,
	/// Input bytes.
	pub bytes:      Arc<[u8]>,
	/// YAML rather than JSON.
	pub yaml:       bool,
}

impl DapConfigSource {
	/// Reads one bounded source.
	pub fn read(kind: DapConfigSourceKind, path: &Path) -> Result<Self, DapConfigError> {
		let metadata = fs::metadata(path)
			.map_err(|source| DapConfigError::Read { path: path.to_owned(), source })?;
		if metadata.len() > MAX_CONFIG_BYTES {
			return Err(DapConfigError::TooLarge { path: path.to_owned() });
		}
		let bytes =
			fs::read(path).map_err(|source| DapConfigError::Read { path: path.to_owned(), source })?;
		Ok(Self {
			provenance: DapConfigProvenance { kind, source: Str::new(path.to_string_lossy()) },
			yaml:       matches!(
				path.extension().and_then(|value| value.to_str()),
				Some("yaml" | "yml")
			),
			bytes:      bytes.into(),
		})
	}

	/// Creates a contribution from a validated native extension manifest.
	pub fn manifest(identity: impl AsRef<str>, bytes: impl Into<Arc<[u8]>>, yaml: bool) -> Self {
		Self {
			provenance: DapConfigProvenance {
				kind:   DapConfigSourceKind::Manifest,
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
	) -> Result<Self, DapConfigError> {
		let source = Self::manifest(identity, bytes, yaml);
		let allowed = allowed_commands
			.into_iter()
			.collect::<std::collections::BTreeSet<_>>();
		let resolved = load_dap_config([], std::slice::from_ref(&source))?;
		for adapter in resolved.values() {
			let command = &adapter.command.value;
			if command.contains('/') || command.contains('\\') || !allowed.contains(command) {
				return Err(DapConfigError::UndeclaredManifestCommand {
					adapter: adapter.name.clone(),
					command: command.clone(),
				});
			}
		}
		Ok(source)
	}
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields, rename_all = "camelCase")]
struct DapAdapterPatch {
	command: Option<Str>,
	args: Option<Vec<Str>>,
	languages: Option<Vec<Str>>,
	file_types: Option<Vec<Str>>,
	root_markers: Option<Vec<Str>>,
	launch_defaults: Option<Map<String, serde_json::Value>>,
	attach_defaults: Option<Map<String, serde_json::Value>>,
	accepts_directory_program: Option<bool>,
	connect_mode: Option<Str>,
	preference: Option<u16>,
}

#[derive(Default)]
struct MergedAdapter {
	command: Option<DapProvenanced<Str>>,
	args: Option<DapProvenanced<Vec<Str>>>,
	languages: Option<DapProvenanced<Vec<Str>>>,
	file_types: Option<DapProvenanced<Vec<Str>>>,
	root_markers: Option<DapProvenanced<Vec<Str>>>,
	launch_defaults: Option<DapProvenanced<Map<String, serde_json::Value>>>,
	attach_defaults: Option<DapProvenanced<Map<String, serde_json::Value>>>,
	accepts_directory_program: Option<DapProvenanced<bool>>,
	connect_mode: Option<DapProvenanced<Option<Str>>>,
	preference: Option<DapProvenanced<u16>>,
}

/// Resolved adapter plus per-field provenance.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedDapAdapter {
	/// Adapter name.
	pub name: Str,
	/// Command.
	pub command: DapProvenanced<Str>,
	/// Arguments.
	pub args: DapProvenanced<Vec<Str>>,
	/// Language identifiers.
	pub languages: DapProvenanced<Vec<Str>>,
	/// Extensions/exact filenames.
	pub file_types: DapProvenanced<Vec<Str>>,
	/// Project markers.
	pub root_markers: DapProvenanced<Vec<Str>>,
	/// Launch defaults.
	pub launch_defaults: DapProvenanced<Map<String, serde_json::Value>>,
	/// Attach defaults.
	/// `skipAttachRequest: true` marks an adapter that connected before DAP
	/// startup.
	pub attach_defaults: DapProvenanced<Map<String, serde_json::Value>>,
	/// Directory launch support.
	pub accepts_directory_program: DapProvenanced<bool>,
	/// Optional socket/TCP connection mode.
	pub connect_mode: DapProvenanced<Option<Str>>,
	/// Selection preference.
	pub preference: DapProvenanced<u16>,
}

impl ResolvedDapAdapter {
	/// Converts the resolved declaration into the runtime registry shape.
	pub fn to_spec(&self) -> Result<DapAdapterSpec, DapConfigError> {
		let mut spec = DapAdapterSpec::new(self.name.as_str(), self.command.value.as_str())?;
		spec.args = self.args.value.clone();
		spec.extensions = self
			.file_types
			.value
			.iter()
			.map(|value| Str::new(value.trim_start_matches('.')))
			.collect();
		spec.root_markers = self.root_markers.value.clone();
		spec.accepts_directory_program = self.accepts_directory_program.value;
		spec.launch_defaults = self.launch_defaults.value.clone();
		spec.attach_defaults = self.attach_defaults.value.clone();
		spec.preference = self.preference.value;
		spec.transport = match self.connect_mode.value.as_deref() {
			Some("tcp") => DapTransport::Tcp { port_argument: Str::new_static("${port}") },
			Some("socket" | "unix") => {
				DapTransport::Unix { socket_argument: Str::new_static("${socket}") }
			},
			Some(mode) => {
				return Err(DapConfigError::InvalidConnectMode {
					adapter: self.name.clone(),
					mode:    Str::new(mode),
				});
			},
			None => DapTransport::Stdio,
		};
		Ok(spec)
	}
}

/// Discovers only native user/project DAP files, low to high precedence.
pub fn discover_native_dap_sources(
	user_root: Option<&Path>,
	project_root: &Path,
) -> Result<Vec<DapConfigSource>, DapConfigError> {
	discover_native_dap_sources_with_manifests(user_root, project_root, Vec::new())
}

/// Enumerates extension-manifest, user, and project sources in increasing
/// precedence; built-ins are merged before this returned list.
pub fn discover_native_dap_sources_with_manifests(
	user_root: Option<&Path>,
	project_root: &Path,
	mut manifests: Vec<DapConfigSource>,
) -> Result<Vec<DapConfigSource>, DapConfigError> {
	let mut sources = Vec::new();
	manifests.sort_by(|left, right| left.provenance.source.cmp(&right.provenance.source));
	sources.extend(manifests);
	if let Some(user_root) = user_root {
		append_existing(&mut sources, user_root, DapConfigSourceKind::User)?;
		append_existing(&mut sources, &user_root.join("agent"), DapConfigSourceKind::User)?;
	}
	append_existing(&mut sources, &project_root.join(".omp"), DapConfigSourceKind::Project)?;
	for name in CONFIG_NAMES {
		let path = project_root.join(name);
		if path.is_file() {
			sources.push(DapConfigSource::read(DapConfigSourceKind::Dotfile, &path)?);
		}
	}
	Ok(sources)
}

fn append_existing(
	sources: &mut Vec<DapConfigSource>,
	directory: &Path,
	kind: DapConfigSourceKind,
) -> Result<(), DapConfigError> {
	for name in CONFIG_NAMES {
		let path = directory.join(name);
		if path.is_file() {
			sources.push(DapConfigSource::read(kind, &path)?);
		}
	}
	Ok(())
}

/// Merges native adapter declarations per field. Object-valued launch/attach
/// defaults are themselves shallow-field merged.
pub fn load_dap_config(
	builtins: impl IntoIterator<Item = DapAdapterSpec>,
	sources: &[DapConfigSource],
) -> Result<BTreeMap<Str, ResolvedDapAdapter>, DapConfigError> {
	let builtin_provenance = DapConfigProvenance {
		kind:   DapConfigSourceKind::Builtin,
		source: Str::new_static("omp:dap-builtins"),
	};
	let mut merged = BTreeMap::new();
	for spec in builtins {
		let patch = DapAdapterPatch {
			command: Some(spec.command),
			args: Some(spec.args),
			languages: Some(Vec::new()),
			file_types: Some(spec.extensions),
			root_markers: Some(spec.root_markers),
			launch_defaults: Some(spec.launch_defaults),
			attach_defaults: Some(spec.attach_defaults),
			accepts_directory_program: Some(spec.accepts_directory_program),
			connect_mode: match spec.transport {
				DapTransport::Stdio => None,
				DapTransport::Tcp { .. } => Some(Str::new_static("tcp")),
				DapTransport::Unix { .. } => Some(Str::new_static("socket")),
			},
			preference: Some(spec.preference),
		};
		merge_adapter(merged.entry(spec.name).or_default(), patch, &builtin_provenance);
	}
	for source in sources {
		if source.bytes.len() as u64 > MAX_CONFIG_BYTES {
			return Err(DapConfigError::TooLarge {
				path: PathBuf::from(source.provenance.source.as_str()),
			});
		}
		let value: serde_json::Value = if source.yaml {
			serde_yaml::from_slice(&source.bytes).map_err(|error| DapConfigError::ParseYaml {
				source_name: source.provenance.source.clone(),
				source:      error,
			})?
		} else {
			serde_json::from_slice(&source.bytes).map_err(|error| DapConfigError::ParseJson {
				source_name: source.provenance.source.clone(),
				source:      error,
			})?
		};
		let mut object = value
			.as_object()
			.cloned()
			.ok_or(DapConfigError::TopLevelObject)?;
		let adapters = match object.remove("adapters") {
			Some(serde_json::Value::Object(value)) => value,
			Some(_) => return Err(DapConfigError::AdaptersObject),
			None => object,
		};
		for (name, value) in adapters {
			let patch: DapAdapterPatch = serde_json::from_value(value).map_err(|source_error| {
				DapConfigError::InvalidAdapter { adapter: Str::new(&name), source: source_error }
			})?;
			merge_adapter(merged.entry(Str::new(name)).or_default(), patch, &source.provenance);
		}
	}
	merged
		.into_iter()
		.map(|(name, adapter)| resolve_adapter(name.clone(), adapter).map(|adapter| (name, adapter)))
		.collect()
}

fn sourced<T>(value: T, provenance: &DapConfigProvenance) -> DapProvenanced<T> {
	DapProvenanced { value, provenance: provenance.clone() }
}
fn merge_adapter(
	target: &mut MergedAdapter,
	patch: DapAdapterPatch,
	provenance: &DapConfigProvenance,
) {
	if let Some(value) = patch.command {
		target.command = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.args {
		target.args = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.languages {
		target.languages = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.file_types {
		target.file_types = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.root_markers {
		target.root_markers = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.launch_defaults {
		let mut merged = target
			.launch_defaults
			.as_ref()
			.map_or_else(Map::new, |prior| prior.value.clone());
		merged.extend(value);
		target.launch_defaults = Some(sourced(merged, provenance));
	}
	if let Some(value) = patch.attach_defaults {
		let mut merged = target
			.attach_defaults
			.as_ref()
			.map_or_else(Map::new, |prior| prior.value.clone());
		merged.extend(value);
		target.attach_defaults = Some(sourced(merged, provenance));
	}
	if let Some(value) = patch.accepts_directory_program {
		target.accepts_directory_program = Some(sourced(value, provenance));
	}
	if let Some(value) = patch.connect_mode {
		target.connect_mode = Some(sourced(Some(value), provenance));
	}
	if let Some(value) = patch.preference {
		target.preference = Some(sourced(value, provenance));
	}
}

fn resolve_adapter(
	name: Str,
	adapter: MergedAdapter,
) -> Result<ResolvedDapAdapter, DapConfigError> {
	let command = adapter
		.command
		.ok_or_else(|| DapConfigError::MissingCommand { adapter: name.clone() })?;
	if command.value.is_empty() {
		return Err(DapConfigError::MissingCommand { adapter: name });
	}
	let p = command.provenance.clone();
	Ok(ResolvedDapAdapter {
		name,
		command,
		args: adapter.args.unwrap_or_else(|| sourced(Vec::new(), &p)),
		languages: adapter.languages.unwrap_or_else(|| sourced(Vec::new(), &p)),
		file_types: adapter
			.file_types
			.unwrap_or_else(|| sourced(Vec::new(), &p)),
		root_markers: adapter
			.root_markers
			.unwrap_or_else(|| sourced(Vec::new(), &p)),
		launch_defaults: adapter
			.launch_defaults
			.unwrap_or_else(|| sourced(Map::new(), &p)),
		attach_defaults: adapter
			.attach_defaults
			.unwrap_or_else(|| sourced(Map::new(), &p)),
		accepts_directory_program: adapter
			.accepts_directory_program
			.unwrap_or_else(|| sourced(false, &p)),
		connect_mode: adapter.connect_mode.unwrap_or_else(|| sourced(None, &p)),
		preference: adapter.preference.unwrap_or_else(|| sourced(u16::MAX, &p)),
	})
}

/// Native DAP configuration failure.
#[derive(Debug, thiserror::Error)]
pub enum DapConfigError {
	/// Read failure.
	#[error("cannot read DAP configuration {}: {source}", path.display())]
	Read {
		/// Source path.
		path:   PathBuf,
		/// Filesystem failure.
		#[source]
		source: io::Error,
	},
	/// Byte bound exceeded.
	#[error("DAP configuration {} exceeds its byte bound", path.display())]
	TooLarge {
		/// Oversized source path.
		path: PathBuf,
	},
	/// Invalid JSON.
	#[error("invalid JSON DAP configuration {source_name}: {source}")]
	ParseJson {
		/// Source identity.
		source_name: Str,
		/// JSON decoder failure.
		#[source]
		source:      serde_json::Error,
	},
	/// Invalid YAML.
	#[error("invalid YAML DAP configuration {source_name}: {source}")]
	ParseYaml {
		/// Source identity.
		source_name: Str,
		/// YAML decoder failure.
		#[source]
		source:      serde_yaml::Error,
	},
	/// Wrong top-level shape.
	#[error("DAP configuration must be an object")]
	TopLevelObject,
	/// Wrong adapters shape.
	#[error("DAP adapters field must be an object")]
	AdaptersObject,
	/// A manifest command was neither materialized nor explicitly granted.
	#[error("manifest DAP adapter {adapter} references undeclared command {command}")]
	UndeclaredManifestCommand {
		/// Adapter declaration name.
		adapter: Str,
		/// Rejected command.
		command: Str,
	},
	/// Invalid adapter declaration.
	#[error("invalid DAP adapter {adapter}: {source}")]
	InvalidAdapter {
		/// Adapter name.
		adapter: Str,
		/// Schema decoder failure.
		#[source]
		source:  serde_json::Error,
	},
	/// Required command absent.
	#[error("DAP adapter {adapter} is missing a command")]
	MissingCommand {
		/// Adapter name.
		adapter: Str,
	},
	/// Unsupported connection mode.
	#[error("DAP adapter {adapter} has unsupported connect mode {mode}")]
	InvalidConnectMode {
		/// Adapter name.
		adapter: Str,
		/// Rejected mode.
		mode:    Str,
	},
	/// Runtime declaration validation failed.
	#[error(transparent)]
	Adapter(#[from] DapAdapterError),
}

#[cfg(test)]
mod tests {

	use std::iter::empty;

	use super::*;
	use crate::docserver::dap_adapter::builtin_adapters;

	#[test]
	fn yaml_field_merge_preserves_object_members_and_provenance() {
		let source = DapConfigSource {
			provenance: DapConfigProvenance {
				kind:   DapConfigSourceKind::Project,
				source: Str::new_static("fixture"),
			},
			bytes:      Arc::from(
				&b"adapters:\n  debugpy:\n    launchDefaults:\n      stopOnEntry: false\n"[..],
			),
			yaml:       true,
		};
		let adapters = load_dap_config(builtin_adapters(), &[source]).unwrap();
		let debugpy = &adapters["debugpy"];
		assert_eq!(debugpy.launch_defaults.value["request"], "launch");
		assert_eq!(debugpy.launch_defaults.value["stopOnEntry"], false);
		assert_eq!(debugpy.launch_defaults.provenance.kind, DapConfigSourceKind::Project);
	}

	#[test]
	fn preattached_option_is_preserved_in_adapter_attach_defaults() {
		let source = DapConfigSource {
			provenance: DapConfigProvenance {
				kind:   DapConfigSourceKind::Project,
				source: Str::new_static("fixture"),
			},
			bytes:      Arc::from(
				&br#"{
					"adapters": {
						"pico-openocd": {
							"command": "gdb",
							"attachDefaults": {
								"request": "attach",
								"skipAttachRequest": true
							}
						}
					}
				}"#[..],
			),
			yaml:       false,
		};
		let adapters = load_dap_config(empty::<DapAdapterSpec>(), &[source]).unwrap();
		let adapter = adapters["pico-openocd"].to_spec().unwrap();

		assert!(adapter.skip_attach_request());
		assert_eq!(adapter.merged_arguments(true, &Map::new())["skipAttachRequest"], true);
	}

	#[test]
	fn manifest_commands_require_declared_executables() {
		let bytes = br#"{"adapters":{"acme":{"command":"acme-dap"}}}"#;
		assert!(DapConfigSource::manifest_checked("acme:dap", bytes.as_slice(), false, []).is_err());
		let source =
			DapConfigSource::manifest_checked("acme:dap", bytes.as_slice(), false, [Str::new_static(
				"acme-dap",
			)])
			.unwrap();
		let adapters = load_dap_config(empty::<DapAdapterSpec>(), &[source]).unwrap();
		assert_eq!(adapters["acme"].command.provenance.kind, DapConfigSourceKind::Manifest);
	}
}
