//! Claude-compatible plugin marketplace catalogs and contained source
//! resolution.

use std::{
	collections::BTreeMap,
	path::{Component, Path, PathBuf},
};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{ExtensionCode, ExtensionError, config::StaticDeclaration};

/// A validated Claude/OMP marketplace catalog.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MarketplaceCatalog {
	/// Stable marketplace identity.
	pub name:     Str,
	/// Publishing owner.
	pub owner:    MarketplaceOwner,
	/// Optional catalog metadata.
	#[serde(default)]
	pub metadata: MarketplaceMetadata,
	/// Individually validated plugin entries.
	pub plugins:  Vec<MarketplacePlugin>,
	/// Unknown Claude-compatible catalog fields preserved losslessly.
	#[serde(flatten)]
	pub extra:    BTreeMap<String, Value>,
}

/// Marketplace publisher metadata.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MarketplaceOwner {
	/// Display name.
	pub name:  Str,
	/// Optional contact address.
	#[serde(default)]
	pub email: Option<Str>,
	/// Unknown owner metadata.
	#[serde(flatten)]
	pub extra: BTreeMap<String, Value>,
}

/// Catalog-wide source defaults.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceMetadata {
	/// Human-readable summary.
	#[serde(default)]
	pub description: Str,
	/// Catalog version.
	#[serde(default)]
	pub version:     Option<Str>,
	/// Contained prefix for relative plugin sources.
	#[serde(default)]
	pub plugin_root: Option<PathBuf>,
	/// Unknown catalog metadata.
	#[serde(flatten)]
	pub extra:       BTreeMap<String, Value>,
}

/// One installable plugin entry.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketplacePlugin {
	/// Stable plugin name.
	pub name:         Str,
	/// Catalog-relative or typed external source.
	pub source:       Value,
	/// Human-readable summary.
	#[serde(default)]
	pub description:  Str,
	/// Declared semantic version when available.
	#[serde(default)]
	pub version:      Option<Str>,
	/// File-backed agent definitions copied during installation.
	#[serde(default)]
	pub agents:       Option<Value>,
	/// Inline or file-backed LSP metadata copied during installation.
	#[serde(default)]
	pub lsp_servers:  Option<Value>,
	/// Inline or file-backed DAP metadata copied during installation.
	#[serde(default)]
	pub dap_adapters: Option<Value>,
	/// Category, author, command, hook, MCP, and other compatible metadata.
	#[serde(flatten)]
	pub extra:        BTreeMap<String, Value>,
}

/// A validated plugin source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PluginSource {
	/// Catalog-relative directory.
	Relative(PathBuf),
	/// GitHub owner/repository source.
	Github {
		/// `owner/repository` shorthand.
		repo:      String,
		/// Optional branch, tag, or commit.
		reference: Option<String>,
		/// Optional immutable commit assertion.
		sha:       Option<String>,
	},
	/// Git repository source.
	Git {
		/// Clone URL.
		url:       String,
		/// Optional branch, tag, or commit.
		reference: Option<String>,
		/// Optional immutable commit assertion.
		sha:       Option<String>,
	},
	/// Contained subdirectory of a Git repository.
	GitSubdir {
		/// Clone URL.
		url:       String,
		/// Contained plugin directory.
		path:      PathBuf,
		/// Optional branch, tag, or commit.
		reference: Option<String>,
		/// Optional immutable commit assertion.
		sha:       Option<String>,
	},
	/// Parsed but intentionally unsupported npm source.
	Npm {
		/// Package identity.
		package: String,
		/// Optional package version.
		version: Option<String>,
	},
}

impl MarketplacePlugin {
	/// Validates and projects the source union.
	pub fn source_spec(&self) -> Result<PluginSource, ExtensionError> {
		if let Some(path) = self.source.as_str() {
			if !path.starts_with("./") {
				return Err(catalog_error("relative plugin source must start with ./"));
			}
			return Ok(PluginSource::Relative(PathBuf::from(path)));
		}
		let source = self
			.source
			.as_object()
			.ok_or_else(|| catalog_error("plugin source must be a string or object"))?;
		let kind = source
			.get("source")
			.and_then(Value::as_str)
			.ok_or_else(|| catalog_error("typed plugin source has no source discriminator"))?;
		let optional = |name: &str| source.get(name).and_then(Value::as_str).map(str::to_owned);
		let required = |name: &str| {
			optional(name).ok_or_else(|| catalog_error(format!("typed plugin source has no {name}")))
		};
		match kind {
			"github" => Ok(PluginSource::Github {
				repo:      required("repo")?,
				reference: optional("ref"),
				sha:       optional("sha"),
			}),
			"url" => Ok(PluginSource::Git {
				url:       required("url")?,
				reference: optional("ref"),
				sha:       optional("sha"),
			}),
			"git-subdir" => Ok(PluginSource::GitSubdir {
				url:       required("url")?,
				path:      PathBuf::from(required("path")?),
				reference: optional("ref"),
				sha:       optional("sha"),
			}),
			"npm" => {
				Ok(PluginSource::Npm { package: required("package")?, version: optional("version") })
			},
			_ => Err(catalog_error(format!("unknown plugin source variant {kind:?}"))),
		}
	}

	/// Lowers marketplace discovery slots into signed static content rows.
	pub fn static_declarations(&self) -> Result<Vec<StaticDeclaration>, ExtensionError> {
		let mut rows = Vec::new();
		for (kind, value) in [
			("agents", self.agents.as_ref()),
			("lsp-servers", self.lsp_servers.as_ref()),
			("dap-adapters", self.dap_adapters.as_ref()),
		] {
			if let Some(value) = value {
				lower_content_value(kind, value, &mut rows)?;
			}
		}
		Ok(rows)
	}
}

fn lower_content_value(
	kind: &str,
	value: &Value,
	rows: &mut Vec<StaticDeclaration>,
) -> Result<(), ExtensionError> {
	if let Some(values) = value.as_array() {
		for value in values {
			lower_content_value(kind, value, rows)?;
		}
		return Ok(());
	}
	let (path, explicit_format) = if let Some(path) = value.as_str() {
		(path, None)
	} else {
		let object = value.as_object().ok_or_else(|| {
			catalog_error(format!("{kind} metadata must be a path, object, or array"))
		})?;
		let path = object.get("path").and_then(Value::as_str).ok_or_else(|| {
			catalog_error(format!("inline {kind} metadata must be copied to a signed path"))
		})?;
		(path, object.get("format").and_then(Value::as_str))
	};
	let format = explicit_format.unwrap_or_else(|| match kind {
		"agents" => "omp-agent-markdown",
		_ if path.ends_with(".yaml") || path.ends_with(".yml") => "yaml",
		_ => "json",
	});
	let mut metadata = BTreeMap::new();
	metadata.insert(Str::new_static("format"), Value::String(format.to_owned()));
	rows.push(StaticDeclaration {
		kind: Str::new(kind),
		path: Some(Str::new(path)),
		metadata,
		..StaticDeclaration::default()
	});
	Ok(())
}

/// Parses a catalog, rejecting invalid authority fields and dropping malformed
/// plugin rows so one bad entry cannot hide valid siblings.
pub fn parse_catalog(bytes: &[u8], source: &str) -> Result<MarketplaceCatalog, ExtensionError> {
	let mut value: Value = serde_json::from_slice(bytes)
		.map_err(|error| catalog_error(format!("failed to parse {source}: {error}")))?;
	let object = value
		.as_object_mut()
		.ok_or_else(|| catalog_error(format!("catalog {source} must be an object")))?;
	let name = object
		.get("name")
		.and_then(Value::as_str)
		.unwrap_or_default();
	if !valid_name(name) {
		return Err(catalog_error(format!("catalog {source} has an invalid name")));
	}
	if object
		.get("owner")
		.and_then(Value::as_object)
		.and_then(|owner| owner.get("name"))
		.and_then(Value::as_str)
		.is_none()
	{
		return Err(catalog_error(format!("catalog {source} has no owner.name")));
	}
	let plugins = object
		.get_mut("plugins")
		.and_then(Value::as_array_mut)
		.ok_or_else(|| catalog_error(format!("catalog {source} has no plugins array")))?;
	plugins.retain(|entry| {
		serde_json::from_value::<MarketplacePlugin>(entry.clone())
			.is_ok_and(|plugin| valid_name(plugin.name.as_str()) && plugin.source_spec().is_ok())
	});
	serde_json::from_value(value)
		.map_err(|error| catalog_error(format!("invalid catalog {source}: {error}")))
}

/// Resolves a catalog-relative plugin directory without permitting traversal.
pub fn contained_plugin_path(
	catalog_root: &Path,
	plugin_root: Option<&Path>,
	source: &Path,
) -> Result<PathBuf, ExtensionError> {
	let relative = source.strip_prefix(".").unwrap_or(source);
	let mut joined = PathBuf::new();
	if let Some(plugin_root) = plugin_root {
		append_contained(&mut joined, plugin_root)?;
	}
	append_contained(&mut joined, relative)?;
	let root = catalog_root
		.canonicalize()
		.map_err(|error| catalog_error(error.to_string()))?;
	let candidate = root
		.join(joined)
		.canonicalize()
		.map_err(|error| catalog_error(error.to_string()))?;
	if !candidate.starts_with(&root) || candidate == root {
		return Err(catalog_error("plugin source escapes the marketplace root"));
	}
	Ok(candidate)
}

fn append_contained(target: &mut PathBuf, path: &Path) -> Result<(), ExtensionError> {
	for component in path.components() {
		match component {
			Component::Normal(component) => target.push(component),
			Component::CurDir => {},
			Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
				return Err(catalog_error("plugin source is not a contained relative path"));
			},
		}
	}
	Ok(())
}

/// Returns whether a marketplace or plugin name follows the naming contract.
pub fn valid_name(name: &str) -> bool {
	name.len() <= 64
		&& name
			.bytes()
			.next()
			.is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
		&& name
			.bytes()
			.last()
			.is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
		&& name.bytes().all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'.')
		})
}

fn catalog_error(detail: impl AsRef<str>) -> ExtensionError {
	ExtensionError::new(ExtensionCode::EManifestParse, detail)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn catalog_keeps_valid_plugins_and_rejects_escape_sources() {
		let catalog = parse_catalog(
			br#"{"name":"official","owner":{"name":"OMP"},"plugins":[{"name":"good","source":"./good"},{"name":"Bad","source":"../bad"}]}"#,
			"memory",
		)
		.unwrap();
		assert_eq!(catalog.plugins.len(), 1);
		assert_eq!(catalog.plugins[0].name, "good");
	}

	#[test]
	fn catalog_slots_lower_to_static_manifest_rows() {
		let catalog = parse_catalog(
			br#"{"name":"official","owner":{"name":"OMP"},"plugins":[{"name":"good","source":"./good","agents":"agents/*.md","lspServers":{"path":"catalog/lsp.json"},"dapAdapters":"catalog/dap.yaml"}]}"#,
			"memory",
		)
		.unwrap();
		let rows = catalog.plugins[0].static_declarations().unwrap();
		assert_eq!(rows.iter().map(|row| row.kind.as_str()).collect::<Vec<_>>(), vec![
			"agents",
			"lsp-servers",
			"dap-adapters"
		]);
		assert_eq!(rows[0].metadata["format"], "omp-agent-markdown");
		assert_eq!(rows[2].metadata["format"], "yaml");
	}
}
