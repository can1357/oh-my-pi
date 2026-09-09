use std::{
	collections::BTreeMap,
	fs,
	path::{Path, PathBuf},
};

use futures::StreamExt as _;
use miette::{IntoDiagnostic as _, miette};
use omp_core::Str;
use omp_ext::{
	Layer as BackendLayer,
	index::SignedIndex,
	lock::InstalledRecord,
	marketplace::{
		MarketplaceCatalog, MarketplacePlugin, PluginSource, contained_plugin_path, parse_catalog,
	},
	resolver::compare_versions,
	trust::{GrantsFile, grant_covers},
};
use serde::{Deserialize, Serialize};

use super::{Scope, StatePaths, read_lock_or_empty};

const MAX_INDEX_BYTES: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
struct MarketplaceRegistry {
	#[serde(default = "marketplace_registry_version")]
	version:      u32,
	#[serde(default)]
	marketplaces: Vec<MarketplaceRegistryEntry>,
}

impl Default for MarketplaceRegistry {
	fn default() -> Self {
		Self { version: marketplace_registry_version(), marketplaces: Vec::new() }
	}
}

const fn marketplace_registry_version() -> u32 {
	1
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketplaceRegistryEntry {
	name:         Str,
	source_type:  Str,
	source_uri:   String,
	catalog_path: PathBuf,
	added_at:     Str,
	updated_at:   Str,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct InstalledPluginsRegistry {
	#[serde(default = "installed_plugins_version")]
	version: u32,
	#[serde(default)]
	plugins: BTreeMap<String, Vec<InstalledPluginEntry>>,
}

impl Default for InstalledPluginsRegistry {
	fn default() -> Self {
		Self { version: installed_plugins_version(), plugins: BTreeMap::new() }
	}
}

const fn installed_plugins_version() -> u32 {
	2
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledPluginEntry {
	scope:          Str,
	install_path:   PathBuf,
	version:        Str,
	installed_at:   Str,
	last_updated:   Str,
	#[serde(default)]
	git_commit_sha: Option<Str>,
	#[serde(default = "enabled_by_default")]
	enabled:        bool,
}

const fn enabled_by_default() -> bool {
	true
}

/// One configured signed extension index.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MarketplaceIndex {
	pub(crate) name: Str,
	pub(crate) url:  String,
}

/// One extension release shown by marketplace discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MarketplacePackage {
	pub(crate) id:          Str,
	pub(crate) version:     Str,
	pub(crate) description: Str,
	pub(crate) marketplace: Str,
}

/// One installed native extension projected across user and project scopes.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct InstalledExtensionView {
	pub(crate) id:          Str,
	pub(crate) version:     Option<Str>,
	pub(crate) enabled:     bool,
	pub(crate) scope:       Scope,
	pub(crate) marketplace: Option<Str>,
	pub(crate) shadowed:    bool,
	pub(crate) tier:        omp_ext::TrustTier,
	pub(crate) source:      toml::Value,
	pub(crate) features:    Vec<Str>,
	pub(crate) publisher:   Option<Str>,
	pub(crate) artifact:    Option<Str>,
	pub(crate) capability:  Option<Str>,
	pub(crate) admitted:    bool,
}

/// One committed extension upgrade.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct UpgradeView {
	pub(crate) id:   Str,
	pub(crate) from: Option<Str>,
	pub(crate) to:   Option<Str>,
}

/// Shared signed-index and installation transactions used by both `omp ext`
/// and interactive slash commands.
pub(crate) struct ExtensionTransactions {
	state: StatePaths,
	scope: Scope,
}

impl ExtensionTransactions {
	pub(crate) fn new(data_dir: &Path, project: &Path, scope: Scope) -> Self {
		Self { state: StatePaths::new(data_dir, project), scope }
	}

	pub(crate) fn indexes(&self) -> miette::Result<Vec<MarketplaceIndex>> {
		Ok(read_marketplace_registry(&self.state)?
			.marketplaces
			.into_iter()
			.map(|entry| MarketplaceIndex { name: entry.name, url: entry.source_uri })
			.collect())
	}

	pub(crate) async fn add_index(&self, source: &str) -> miette::Result<MarketplaceIndex> {
		let source = source.trim();
		if source.is_empty() {
			return Err(miette!("marketplace source cannot be empty"));
		}
		let fetched = fetch_marketplace(source, &self.state.marketplace_cache).await?;
		let now = Str::new(jiff::Timestamp::now().to_string());
		let mut registry = read_marketplace_registry(&self.state)?;
		let added_at = registry
			.marketplaces
			.iter()
			.find(|entry| entry.name == fetched.catalog.name)
			.map_or_else(|| now.clone(), |entry| entry.added_at.clone());
		registry
			.marketplaces
			.retain(|entry| entry.name != fetched.catalog.name);
		registry.marketplaces.push(MarketplaceRegistryEntry {
			name: fetched.catalog.name.clone(),
			source_type: fetched.source_type,
			source_uri: source.to_owned(),
			catalog_path: fetched.catalog_path,
			added_at,
			updated_at: now,
		});
		registry
			.marketplaces
			.sort_by(|left, right| left.name.cmp(&right.name));
		write_json(&self.state.marketplaces, &registry)?;
		Ok(MarketplaceIndex { name: fetched.catalog.name, url: source.to_owned() })
	}

	pub(crate) fn remove_index(&self, name: &str) -> miette::Result<()> {
		let mut registry = read_marketplace_registry(&self.state)?;
		let before = registry.marketplaces.len();
		registry.marketplaces.retain(|entry| entry.name != name);
		if before == registry.marketplaces.len() {
			return Err(miette!("marketplace {name} is unknown"));
		}
		write_json(&self.state.marketplaces, &registry)?;
		let cache = self.state.marketplace_cache.join(name);
		if cache.is_dir() {
			fs::remove_dir_all(cache).into_diagnostic()?;
		}
		Ok(())
	}

	pub(crate) async fn update_index(&self, name: Option<&str>) -> miette::Result<Vec<Str>> {
		let mut registry = read_marketplace_registry(&self.state)?;
		let selected = registry
			.marketplaces
			.iter()
			.filter(|entry| name.is_none_or(|name| entry.name == name))
			.cloned()
			.collect::<Vec<_>>();
		if selected.is_empty() {
			return match name {
				Some(name) => Err(miette!("marketplace {name} is unknown")),
				None => Ok(Vec::new()),
			};
		}
		let mut updated = Vec::with_capacity(selected.len());
		for current in selected {
			let fetched =
				fetch_marketplace(&current.source_uri, &self.state.marketplace_cache).await?;
			if fetched.catalog.name != current.name {
				return Err(miette!(
					"marketplace {} changed identity to {}",
					current.name,
					fetched.catalog.name
				));
			}
			let entry = registry
				.marketplaces
				.iter_mut()
				.find(|entry| entry.name == current.name)
				.expect("selected registry entry");
			entry.catalog_path = fetched.catalog_path;
			entry.source_type = fetched.source_type;
			entry.updated_at = Str::new(jiff::Timestamp::now().to_string());
			updated.push(current.name);
		}
		write_json(&self.state.marketplaces, &registry)?;
		Ok(updated)
	}

	pub(crate) fn discover(
		&self,
		marketplace: Option<&str>,
	) -> miette::Result<Vec<MarketplacePackage>> {
		let registry = read_marketplace_registry(&self.state)?;
		let selected = registry
			.marketplaces
			.iter()
			.filter(|entry| marketplace.is_none_or(|name| entry.name == name))
			.collect::<Vec<_>>();
		if selected.is_empty() && marketplace.is_some() {
			return Err(miette!("marketplace {} is unknown", marketplace.unwrap_or_default()));
		}
		let mut packages = Vec::new();
		for entry in selected {
			let catalog = read_plugin_catalog(entry)?;
			packages.extend(
				catalog
					.plugins
					.into_iter()
					.map(|plugin| MarketplacePackage {
						id:          plugin.name,
						version:     plugin.version.unwrap_or_else(|| Str::new_static("0.0.0")),
						description: plugin.description,
						marketplace: catalog.name.clone(),
					}),
			);
		}
		packages.sort_by(|left, right| {
			left
				.marketplace
				.cmp(&right.marketplace)
				.then(left.id.cmp(&right.id))
		});
		Ok(packages)
	}

	pub(crate) async fn install(
		&self,
		spec: &str,
		force: bool,
	) -> miette::Result<MarketplacePackage> {
		let (id, marketplace) = package_spec(spec)?;
		let registry = read_marketplace_registry(&self.state)?;
		let entry = registry
			.marketplaces
			.iter()
			.find(|entry| entry.name == marketplace)
			.ok_or_else(|| miette!("marketplace {marketplace} is unknown"))?;
		let catalog = read_plugin_catalog(entry)?;
		let plugin = catalog
			.plugins
			.iter()
			.find(|plugin| plugin.name == id)
			.ok_or_else(|| miette!("plugin {id} is absent from marketplace {marketplace}"))?;
		let plugin_id = format!("{id}@{marketplace}");
		let registry_path = self.state.plugin_registry(self.scope);
		let mut installed = read_installed_plugins(&registry_path)?;
		if !force && installed.plugins.contains_key(&plugin_id) {
			return Err(miette!("plugin {plugin_id} is already installed; pass --force"));
		}
		let materialized =
			materialize_plugin(&self.state, entry, &catalog, plugin, marketplace).await?;
		let now = Str::new(jiff::Timestamp::now().to_string());
		let installed_at = installed
			.plugins
			.get(&plugin_id)
			.and_then(|entries| entries.first())
			.map_or_else(|| now.clone(), |entry| entry.installed_at.clone());
		let scope = match self.scope {
			Scope::User => Str::new_static("user"),
			Scope::Project => Str::new_static("project"),
		};
		installed
			.plugins
			.insert(plugin_id.clone(), vec![InstalledPluginEntry {
				scope,
				install_path: materialized.path.clone(),
				version: materialized.version.clone(),
				installed_at,
				last_updated: now,
				git_commit_sha: materialized.git_sha,
				enabled: true,
			}]);
		link_plugin(&self.state.plugin_root(self.scope), id, &materialized.path)?;
		write_json(&registry_path, &installed)?;
		Ok(MarketplacePackage {
			id:          Str::new(id),
			version:     materialized.version,
			description: plugin.description.clone(),
			marketplace: Str::new(marketplace),
		})
	}

	pub(crate) fn uninstall(&self, spec: &str) -> miette::Result<Str> {
		let registry_path = self.state.plugin_registry(self.scope);
		let mut installed = read_installed_plugins(&registry_path)?;
		let plugin_id = if installed.plugins.contains_key(spec) {
			spec.to_owned()
		} else {
			let candidates = installed
				.plugins
				.keys()
				.filter(|installed_id| {
					installed_id
						.rsplit_once('@')
						.is_some_and(|(name, _)| name == spec)
				})
				.cloned()
				.collect::<Vec<_>>();
			match candidates.as_slice() {
				[candidate] => candidate.clone(),
				[] => {
					return Err(miette!(
						"nothing to remove: plugin {spec} is not installed in this scope"
					));
				},
				_ => {
					return Err(miette!(
						"plugin {spec} is installed from {} marketplaces; qualify it as one of: {}",
						candidates.len(),
						candidates.join(", ")
					));
				},
			}
		};
		let (id, _) = package_spec(&plugin_id)?;
		if installed.plugins.remove(&plugin_id).is_none() {
			return Err(miette!("nothing to remove: plugin {spec} is not installed in this scope"));
		}
		unlink_plugin(&self.state.plugin_root(self.scope), id)?;
		write_json(&registry_path, &installed)?;
		Ok(Str::new(plugin_id))
	}

	pub(crate) fn installed(&self) -> miette::Result<Vec<InstalledExtensionView>> {
		plugin_views(&self.state)
	}

	pub(crate) fn set_enabled(&self, spec: &str, enabled: bool) -> miette::Result<Str> {
		let registry_path = self.state.plugin_registry(self.scope);
		let mut installed = read_installed_plugins(&registry_path)?;
		let plugin_id = if spec.contains('@') {
			spec.to_owned()
		} else {
			installed
				.plugins
				.keys()
				.find(|id| id.split_once('@').is_some_and(|(name, _)| name == spec))
				.cloned()
				.ok_or_else(|| miette!("plugin {spec} is not installed"))?
		};
		let entries = installed
			.plugins
			.get_mut(&plugin_id)
			.ok_or_else(|| miette!("plugin {plugin_id} is not installed"))?;
		for entry in entries {
			entry.enabled = enabled;
		}
		write_json(&registry_path, &installed)?;
		Ok(Str::new(plugin_id))
	}

	pub(crate) async fn upgrade(&self, spec: Option<&str>) -> miette::Result<Vec<UpgradeView>> {
		let registry_path = self.state.plugin_registry(self.scope);
		let installed = read_installed_plugins(&registry_path)?;
		let ids = if let Some(spec) = spec {
			vec![spec.to_owned()]
		} else {
			installed.plugins.keys().cloned().collect()
		};
		let marketplaces = read_marketplace_registry(&self.state)?;
		let mut upgrades = Vec::new();
		for plugin_id in ids {
			let (id, marketplace) = package_spec(&plugin_id)?;
			let Some(current) = installed
				.plugins
				.get(&plugin_id)
				.and_then(|entries| entries.first())
			else {
				return Err(miette!("plugin {plugin_id} is not installed"));
			};
			let entry = marketplaces
				.marketplaces
				.iter()
				.find(|entry| entry.name == marketplace)
				.ok_or_else(|| miette!("marketplace {marketplace} is unknown"))?;
			let catalog = read_plugin_catalog(entry)?;
			let plugin = catalog
				.plugins
				.iter()
				.find(|plugin| plugin.name == id)
				.ok_or_else(|| miette!("plugin {id} is absent from marketplace {marketplace}"))?;
			let Some(candidate) = plugin.version.as_ref() else {
				continue;
			};
			let newer = compare_versions(candidate.as_str(), current.version.as_str())
				.map(|ordering| ordering.is_gt())
				.unwrap_or(candidate != &current.version);
			if !newer {
				continue;
			}
			let from = current.version.clone();
			let package = self.install(&plugin_id, true).await?;
			upgrades.push(UpgradeView {
				id:   Str::new(plugin_id),
				from: Some(from),
				to:   Some(package.version),
			});
		}
		Ok(upgrades)
	}
}

struct FetchedMarketplace {
	catalog:      MarketplaceCatalog,
	catalog_path: PathBuf,
	source_type:  Str,
}

struct MaterializedPlugin {
	path:    PathBuf,
	version: Str,
	git_sha: Option<Str>,
}

fn read_marketplace_registry(state: &StatePaths) -> miette::Result<MarketplaceRegistry> {
	read_json_or_default(&state.marketplaces)
}

fn read_installed_plugins(path: &Path) -> miette::Result<InstalledPluginsRegistry> {
	let registry: InstalledPluginsRegistry = read_json_or_default(path)?;
	if registry.version != installed_plugins_version() {
		return Err(miette!("unsupported installed plugin registry version {}", registry.version));
	}
	Ok(registry)
}

fn read_json_or_default<T>(path: &Path) -> miette::Result<T>
where
	T: for<'de> Deserialize<'de> + Default,
{
	if !path.exists() {
		return Ok(T::default());
	}
	serde_json::from_slice(&fs::read(path).into_diagnostic()?).into_diagnostic()
}

fn write_json(path: &Path, value: &impl Serialize) -> miette::Result<()> {
	if let Some(parent) = path.parent() {
		fs::create_dir_all(parent).into_diagnostic()?;
	}
	let temporary = path.with_extension("json.tmp");
	fs::write(&temporary, serde_json::to_vec_pretty(value).into_diagnostic()?).into_diagnostic()?;
	fs::rename(temporary, path).into_diagnostic()
}

async fn fetch_marketplace(source: &str, cache: &Path) -> miette::Result<FetchedMarketplace> {
	let source_type = classify_marketplace_source(source)?;
	match source_type {
		"local" => {
			let root = expand_home(source)?;
			let catalog_path = find_catalog(&root)?;
			let bytes = fs::read(&catalog_path).into_diagnostic()?;
			let catalog = parse_catalog(&bytes, &catalog_path.display().to_string())
				.map_err(|error| miette!("{error}"))?;
			Ok(FetchedMarketplace { catalog, catalog_path, source_type: Str::new_static("local") })
		},
		"url" => {
			let bytes = fetch_index(source).await?;
			let catalog = parse_catalog(&bytes, source).map_err(|error| miette!("{error}"))?;
			let root = cache.join(catalog.name.as_str());
			fs::create_dir_all(&root).into_diagnostic()?;
			let catalog_path = root.join("marketplace.json");
			fs::write(&catalog_path, bytes).into_diagnostic()?;
			Ok(FetchedMarketplace { catalog, catalog_path, source_type: Str::new_static("url") })
		},
		"github" | "git" => {
			let url = if source_type == "github" {
				format!("https://github.com/{source}.git")
			} else {
				source.to_owned()
			};
			let temporary = cache.join(format!(".tmp-{}", omp_core::Ulid::generate()));
			clone_repo(&url, None, None, &temporary).await?;
			let catalog_path = find_catalog(&temporary)?;
			let bytes = fs::read(&catalog_path).into_diagnostic()?;
			let catalog = parse_catalog(&bytes, &catalog_path.display().to_string())
				.map_err(|error| miette!("{error}"))?;
			let final_root = cache.join(catalog.name.as_str());
			if final_root.exists() {
				fs::remove_dir_all(&final_root).into_diagnostic()?;
			}
			fs::create_dir_all(cache).into_diagnostic()?;
			fs::rename(&temporary, &final_root).into_diagnostic()?;
			let relative = catalog_path
				.strip_prefix(&temporary)
				.map_err(|_| miette!("cloned catalog escaped its temporary root"))?;
			Ok(FetchedMarketplace {
				catalog,
				catalog_path: final_root.join(relative),
				source_type: Str::new(source_type),
			})
		},
		_ => unreachable!(),
	}
}

fn classify_marketplace_source(source: &str) -> miette::Result<&'static str> {
	if source.starts_with("https://") || source.starts_with("http://") {
		let path = source.split(['?', '#']).next().unwrap_or(source);
		return Ok(if path.ends_with(".json") {
			"url"
		} else {
			"git"
		});
	}
	if source.starts_with("git@") || source.starts_with("ssh://") {
		return Ok("git");
	}
	if source.split('/').count() == 2
		&& source
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'/'))
	{
		return Ok("github");
	}
	if source.starts_with("./")
		|| source.starts_with("~/")
		|| Path::new(source).is_absolute()
		|| source.as_bytes().get(1) == Some(&b':')
	{
		return Ok("local");
	}
	Err(miette!(
		"unrecognized marketplace source; use ./path, owner/repo, a Git URL, or a catalog JSON URL"
	))
}

fn expand_home(source: &str) -> miette::Result<PathBuf> {
	let path = if let Some(relative) = source.strip_prefix("~/") {
		let home = std::env::var_os("HOME").ok_or_else(|| miette!("HOME is unavailable"))?;
		PathBuf::from(home).join(relative)
	} else {
		PathBuf::from(source)
	};
	path.canonicalize().into_diagnostic()
}

fn find_catalog(root: &Path) -> miette::Result<PathBuf> {
	for relative in [".omp-plugin/marketplace.json", ".claude-plugin/marketplace.json"] {
		let path = root.join(relative);
		if path.is_file() {
			return Ok(path);
		}
	}
	Err(miette!(
		"marketplace has neither .omp-plugin/marketplace.json nor .claude-plugin/marketplace.json"
	))
}

fn read_plugin_catalog(entry: &MarketplaceRegistryEntry) -> miette::Result<MarketplaceCatalog> {
	let bytes = fs::read(&entry.catalog_path).into_diagnostic()?;
	parse_catalog(&bytes, &entry.catalog_path.display().to_string())
		.map_err(|error| miette!("{error}"))
}

async fn clone_repo(
	url: &str,
	reference: Option<&str>,
	expected_sha: Option<&str>,
	destination: &Path,
) -> miette::Result<Option<Str>> {
	if destination.exists() {
		fs::remove_dir_all(destination).into_diagnostic()?;
	}
	if let Some(parent) = destination.parent() {
		fs::create_dir_all(parent).into_diagnostic()?;
	}
	omp_vcs::git::clone(
		url,
		destination,
		&omp_vcs::CloneOptions {
			ref_name: reference.map(str::to_owned),
			sha:      expected_sha.map(str::to_owned),
			timeout:  None,
		},
		None,
	)
	.await
	.into_diagnostic()?;
	let destination = destination.to_owned();
	let sha = tokio::task::spawn_blocking(move || {
		let repo = omp_vcs::git::GitRepo::discover(&destination)
			.into_diagnostic()?
			.ok_or_else(|| miette!("git clone did not create a repository"))?;
		repo
			.head_sha()
			.into_diagnostic()?
			.ok_or_else(|| miette!("git revision lookup failed"))
	})
	.await
	.into_diagnostic()??;
	if expected_sha.is_some_and(|expected| {
		!sha
			.to_ascii_lowercase()
			.starts_with(&expected.to_ascii_lowercase())
	}) {
		return Err(miette!("git source resolved to {sha}, expected {expected_sha:?}"));
	}
	Ok(Some(Str::new(sha)))
}

async fn materialize_plugin(
	state: &StatePaths,
	entry: &MarketplaceRegistryEntry,
	catalog: &MarketplaceCatalog,
	plugin: &MarketplacePlugin,
	marketplace: &str,
) -> miette::Result<MaterializedPlugin> {
	let staging_root = state
		.user_plugins
		.join("cache/plugins")
		.join(format!(".tmp-{}", omp_core::Ulid::generate()));
	let (source, git_sha) = match plugin.source_spec().map_err(|error| miette!("{error}"))? {
		PluginSource::Relative(path) => {
			if entry.source_type == "url" {
				return Err(miette!("direct-catalog plugins cannot use relative sources"));
			}
			let catalog_root = entry
				.catalog_path
				.parent()
				.and_then(Path::parent)
				.ok_or_else(|| miette!("marketplace catalog has no repository root"))?;
			(
				contained_plugin_path(catalog_root, catalog.metadata.plugin_root.as_deref(), &path)
					.map_err(|error| miette!("{error}"))?,
				None,
			)
		},
		PluginSource::Github { repo, reference, sha } => {
			let git_sha = clone_repo(
				&format!("https://github.com/{repo}.git"),
				reference.as_deref(),
				sha.as_deref(),
				&staging_root,
			)
			.await?;
			(staging_root.clone(), git_sha)
		},
		PluginSource::Git { url, reference, sha } => {
			let git_sha =
				clone_repo(&url, reference.as_deref(), sha.as_deref(), &staging_root).await?;
			(staging_root.clone(), git_sha)
		},
		PluginSource::GitSubdir { url, path, reference, sha } => {
			let git_sha =
				clone_repo(&url, reference.as_deref(), sha.as_deref(), &staging_root).await?;
			let source = contained_plugin_path(&staging_root, None, &path)
				.map_err(|error| miette!("{error}"))?;
			(source, git_sha)
		},
		PluginSource::Npm { .. } => {
			return Err(miette!("npm plugin sources are not yet supported"));
		},
	};
	if !source.is_dir() {
		return Err(miette!("plugin source is not a directory"));
	}
	let version = plugin
		.version
		.clone()
		.or_else(|| package_version(&source))
		.or_else(|| git_sha.clone())
		.unwrap_or_else(|| Str::new_static("0.0.0"));
	let cache_root = state.user_plugins.join("cache/plugins");
	let destination = cache_root.join(format!(
		"{marketplace}___{}___{}",
		plugin.name,
		sanitize_version(version.as_str())
	));
	let staged_copy = cache_root.join(format!(".copy-{}", omp_core::Ulid::generate()));
	copy_tree(&source, &staged_copy)?;
	write_inline_config(&staged_copy, ".lsp.json", plugin.lsp_servers.as_ref())?;
	write_inline_config(&staged_copy, ".dap.json", plugin.dap_adapters.as_ref())?;
	if destination.exists() {
		fs::remove_dir_all(&destination).into_diagnostic()?;
	}
	fs::rename(&staged_copy, &destination).into_diagnostic()?;
	if staging_root.exists() {
		fs::remove_dir_all(staging_root).into_diagnostic()?;
	}
	Ok(MaterializedPlugin { path: destination, version, git_sha })
}

fn package_version(root: &Path) -> Option<Str> {
	let value: serde_json::Value =
		serde_json::from_slice(&fs::read(root.join("package.json")).ok()?).ok()?;
	value
		.get("version")
		.and_then(serde_json::Value::as_str)
		.map(Str::new)
}

fn sanitize_version(version: &str) -> String {
	version
		.chars()
		.map(|character| {
			if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
				character
			} else {
				'_'
			}
		})
		.collect()
}

fn copy_tree(source: &Path, destination: &Path) -> miette::Result<()> {
	fs::create_dir_all(destination).into_diagnostic()?;
	for entry in fs::read_dir(source).into_diagnostic()? {
		let entry = entry.into_diagnostic()?;
		if entry.file_name().to_string_lossy() == ".git" {
			continue;
		}
		let metadata = fs::symlink_metadata(entry.path()).into_diagnostic()?;
		if metadata.file_type().is_symlink() {
			return Err(miette!("plugin source contains a symbolic link"));
		}
		let target = destination.join(entry.file_name());
		if metadata.is_dir() {
			copy_tree(&entry.path(), &target)?;
		} else if metadata.is_file() {
			fs::copy(entry.path(), target).into_diagnostic()?;
		}
	}
	Ok(())
}

fn write_inline_config(
	root: &Path,
	name: &str,
	value: Option<&serde_json::Value>,
) -> miette::Result<()> {
	let Some(value) = value else {
		return Ok(());
	};
	if value.is_object() {
		fs::write(root.join(name), serde_json::to_vec_pretty(value).into_diagnostic()?)
			.into_diagnostic()?;
		return Ok(());
	}
	if let Some(relative) = value.as_str() {
		let source = contained_plugin_path(root, None, Path::new(relative))
			.map_err(|error| miette!("{error}"))?;
		let destination = if name == ".dap.json" {
			match source.extension().and_then(|extension| extension.to_str()) {
				Some("yaml") => ".dap.yaml",
				Some("yml") => ".dap.yml",
				_ => name,
			}
		} else {
			name
		};
		let target = root.join(destination);
		if source != target {
			fs::copy(source, target).into_diagnostic()?;
		}
		return Ok(());
	}
	Err(miette!("plugin server configuration must be an object or contained path"))
}

fn link_plugin(root: &Path, name: &str, install_path: &Path) -> miette::Result<()> {
	let node_modules = root.join("node_modules");
	fs::create_dir_all(&node_modules).into_diagnostic()?;
	let link = node_modules.join(name);
	unlink_path(&link)?;
	#[cfg(unix)]
	std::os::unix::fs::symlink(install_path, link).into_diagnostic()?;
	#[cfg(windows)]
	std::os::windows::fs::symlink_dir(install_path, link).into_diagnostic()?;
	Ok(())
}

fn unlink_plugin(root: &Path, name: &str) -> miette::Result<()> {
	unlink_path(&root.join("node_modules").join(name))
}

fn unlink_path(path: &Path) -> miette::Result<()> {
	let Ok(metadata) = fs::symlink_metadata(path) else {
		return Ok(());
	};
	if metadata.file_type().is_symlink() || metadata.is_file() {
		fs::remove_file(path).into_diagnostic()
	} else {
		fs::remove_dir_all(path).into_diagnostic()
	}
}

fn plugin_views(state: &StatePaths) -> miette::Result<Vec<InstalledExtensionView>> {
	let user = read_installed_plugins(&state.plugin_registry(Scope::User))?;
	let project = read_installed_plugins(&state.plugin_registry(Scope::Project))?;
	let project_enabled = project
		.plugins
		.iter()
		.filter(|(_, entries)| entries.iter().any(|entry| entry.enabled))
		.map(|(id, _)| id.clone())
		.collect::<std::collections::BTreeSet<_>>();
	let mut views = Vec::new();
	for (scope, registry) in [(Scope::User, user), (Scope::Project, project)] {
		for (id, entries) in registry.plugins {
			let (name, marketplace) = id.split_once('@').unwrap_or((&id, ""));
			for entry in entries {
				views.push(InstalledExtensionView {
					id: Str::new(name),
					version: Some(entry.version),
					enabled: entry.enabled,
					scope,
					marketplace: (!marketplace.is_empty()).then(|| Str::new(marketplace)),
					shadowed: scope == Scope::User && project_enabled.contains(id.as_str()),
					tier: omp_ext::TrustTier::Sandboxed,
					source: toml::Value::String(entry.install_path.display().to_string()),
					features: Vec::new(),
					publisher: None,
					artifact: None,
					capability: None,
					admitted: entry.enabled,
				});
			}
		}
	}
	views.sort_by(|left, right| {
		left
			.id
			.cmp(&right.id)
			.then(scope_order(left.scope).cmp(&scope_order(right.scope)))
	});
	Ok(views)
}

pub(super) fn catalog_packages(
	state: &StatePaths,
	query: &str,
	capability: Option<&str>,
	attested: bool,
	limit: usize,
) -> miette::Result<Vec<MarketplacePackage>> {
	let catalog = read_catalog(state)?;
	Ok(project_catalog(&catalog, query, capability, attested, limit))
}

fn project_catalog(
	catalog: &SignedIndex,
	query: &str,
	capability: Option<&str>,
	attested: bool,
	limit: usize,
) -> Vec<MarketplacePackage> {
	catalog
		.search(query, capability, attested)
		.take(limit)
		.map(|(extension, release)| MarketplacePackage {
			id:          extension.id.clone(),
			version:     release.version.clone(),
			description: extension.description.clone(),
			marketplace: catalog.name.clone(),
		})
		.collect()
}

fn read_catalog(state: &StatePaths) -> miette::Result<SignedIndex> {
	let key = fs::read_to_string(&state.index_key).into_diagnostic()?;
	SignedIndex::read(&state.index_snapshot, key.trim()).map_err(super::extension_failure)
}

pub(crate) fn installed_views(state: &StatePaths) -> miette::Result<Vec<InstalledExtensionView>> {
	let client = InstalledRecord::read(&state.client_installed).map_err(super::extension_failure)?;
	let workspace =
		InstalledRecord::read(&state.workspace_installed).map_err(super::extension_failure)?;
	let client_lock = read_lock_or_empty(&state.client_lock, BackendLayer::Client)?;
	let workspace_lock = read_lock_or_empty(&state.workspace_lock, BackendLayer::Workspace)?;
	let grants = GrantsFile::read(&state.grants).map_err(super::extension_failure)?;
	let project_ids = workspace
		.extensions
		.iter()
		.filter(|entry| {
			entry.enabled
				&& workspace_lock
					.extensions
					.iter()
					.find(|locked| locked.id == entry.id)
					.is_none_or(|locked| {
						grant_covers(
							&grants,
							&locked.id,
							&locked.publisher,
							BackendLayer::Workspace,
							Some(&state.workspace),
							&locked.capability_digest,
							locked.tier,
							&locked.ship,
						)
					})
		})
		.map(|entry| entry.id.clone())
		.collect::<std::collections::BTreeSet<_>>();
	let mut entries = Vec::with_capacity(client.extensions.len() + workspace.extensions.len());
	entries.extend(client.extensions.into_iter().map(|entry| {
		let locked = client_lock
			.extensions
			.iter()
			.find(|locked| locked.id == entry.id);
		let version = locked
			.map(|locked| locked.version.clone())
			.or_else(|| source_version(&entry.source));
		let admitted = !entry.enabled
			|| locked.is_none_or(|locked| {
				grant_covers(
					&grants,
					&locked.id,
					&locked.publisher,
					BackendLayer::Client,
					None,
					&locked.capability_digest,
					locked.tier,
					&locked.ship,
				)
			});
		InstalledExtensionView {
			version,
			marketplace: source_index(&entry.source),
			shadowed: project_ids.contains(&entry.id),
			id: entry.id,
			enabled: entry.enabled,
			scope: Scope::User,
			tier: entry.tier,
			source: entry.source,
			features: entry.features,
			publisher: locked.map(|locked| locked.publisher.clone()),
			artifact: locked.map(|locked| locked.wheel.blake3.clone()),
			capability: locked.map(|locked| locked.capability_digest.clone()),
			admitted,
		}
	}));
	entries.extend(workspace.extensions.into_iter().map(|entry| {
		let locked = workspace_lock
			.extensions
			.iter()
			.find(|locked| locked.id == entry.id);
		let version = locked
			.map(|locked| locked.version.clone())
			.or_else(|| source_version(&entry.source));
		let admitted = !entry.enabled
			|| locked.is_none_or(|locked| {
				grant_covers(
					&grants,
					&locked.id,
					&locked.publisher,
					BackendLayer::Workspace,
					Some(&state.workspace),
					&locked.capability_digest,
					locked.tier,
					&locked.ship,
				)
			});
		InstalledExtensionView {
			version,
			marketplace: source_index(&entry.source),
			shadowed: false,
			id: entry.id,
			enabled: entry.enabled,
			scope: Scope::Project,
			tier: entry.tier,
			source: entry.source,
			features: entry.features,
			publisher: locked.map(|locked| locked.publisher.clone()),
			artifact: locked.map(|locked| locked.wheel.blake3.clone()),
			capability: locked.map(|locked| locked.capability_digest.clone()),
			admitted,
		}
	}));
	entries.sort_by(|left, right| {
		left
			.id
			.cmp(&right.id)
			.then(scope_order(left.scope).cmp(&scope_order(right.scope)))
	});
	Ok(entries)
}

fn package_spec(spec: &str) -> miette::Result<(&str, &str)> {
	let (id, marketplace) = spec
		.rsplit_once('@')
		.ok_or_else(|| miette!("package must use `name@marketplace` syntax"))?;
	if id.is_empty() || marketplace.is_empty() {
		return Err(miette!("package must use `name@marketplace` syntax"));
	}
	Ok((id, marketplace))
}
const fn scope_order(scope: Scope) -> u8 {
	match scope {
		Scope::User => 1,
		Scope::Project => 0,
	}
}

fn source_version(source: &toml::Value) -> Option<Str> {
	let source = source.as_table()?;
	let root = source
		.get("root")
		.or_else(|| source.get("path"))
		.or_else(|| source.get("link"))?
		.as_str()?;
	let manifest = fs::read_to_string(Path::new(root).join("omp.toml")).ok()?;
	let value: toml::Value = toml::from_str(&manifest).ok()?;
	value.get("version")?.as_str().map(Str::new)
}

fn source_index(source: &toml::Value) -> Option<Str> {
	source
		.get("index")
		.and_then(toml::Value::as_str)
		.filter(|index| !index.is_empty())
		.map(Str::new)
}

pub(super) async fn fetch_index(url: &str) -> miette::Result<Vec<u8>> {
	if let Some(path) = url.strip_prefix("file://") {
		return fs::read(path).into_diagnostic();
	}
	if !url.starts_with("https://") {
		return Err(miette!("marketplace index URL must use HTTPS or file://"));
	}
	let response = omp_http::default_client()
		.get(url)
		.send()
		.await
		.into_diagnostic()?;
	if !response.status().is_success() {
		return Err(miette!("marketplace update returned HTTP {}", response.status()));
	}
	let mut bytes = Vec::new();
	let mut stream = response.bytes_stream();
	while let Some(chunk) = stream.next().await {
		let chunk = chunk.into_diagnostic()?;
		if bytes.len().saturating_add(chunk.len()) > MAX_INDEX_BYTES {
			return Err(miette!("marketplace index exceeds the 16 MiB safety limit"));
		}
		bytes.extend_from_slice(&chunk);
	}
	Ok(bytes)
}
#[cfg(test)]
mod tests {
	use super::*;

	fn plugin_entry(scope: &'static str, enabled: bool) -> InstalledPluginEntry {
		InstalledPluginEntry {
			scope: Str::new_static(scope),
			install_path: PathBuf::from("/cache/sample"),
			version: Str::new_static("1.0.0"),
			installed_at: Str::new_static("2026-01-01T00:00:00Z"),
			last_updated: Str::new_static("2026-01-01T00:00:00Z"),
			git_commit_sha: None,
			enabled,
		}
	}

	#[test]
	fn scoped_enable_mutates_only_the_project_plugin_registry() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		fs::create_dir_all(&project).unwrap();
		let state = StatePaths::new(&data_dir, &project);
		let mut user = InstalledPluginsRegistry::default();
		user
			.plugins
			.insert("sample@index".to_owned(), vec![plugin_entry("user", false)]);
		let mut project_record = InstalledPluginsRegistry::default();
		project_record
			.plugins
			.insert("sample@index".to_owned(), vec![plugin_entry("project", false)]);
		write_json(&state.plugin_registry(Scope::User), &user).unwrap();
		write_json(&state.plugin_registry(Scope::Project), &project_record).unwrap();

		ExtensionTransactions::new(&data_dir, &project, Scope::Project)
			.set_enabled("sample@index", true)
			.unwrap();

		let user = read_installed_plugins(&state.plugin_registry(Scope::User)).unwrap();
		let project_record = read_installed_plugins(&state.plugin_registry(Scope::Project)).unwrap();
		assert!(!user.plugins["sample@index"][0].enabled);
		assert!(project_record.plugins["sample@index"][0].enabled);
	}

	#[test]
	fn uninstall_resolves_a_unique_bare_plugin_name() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		fs::create_dir_all(&project).unwrap();
		let state = StatePaths::new(&data_dir, &project);
		let mut installed = InstalledPluginsRegistry::default();
		installed
			.plugins
			.insert("sample@index".to_owned(), vec![plugin_entry("user", true)]);
		write_json(&state.plugin_registry(Scope::User), &installed).unwrap();

		let removed = ExtensionTransactions::new(&data_dir, &project, Scope::User)
			.uninstall("sample")
			.unwrap();

		assert_eq!(removed, "sample@index");
		let installed = read_installed_plugins(&state.plugin_registry(Scope::User)).unwrap();
		assert!(installed.plugins.is_empty());
	}

	#[test]
	fn uninstall_rejects_an_ambiguous_bare_plugin_name_with_candidates() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		fs::create_dir_all(&project).unwrap();
		let state = StatePaths::new(&data_dir, &project);
		let mut installed = InstalledPluginsRegistry::default();
		for id in ["sample@first", "sample@second"] {
			installed
				.plugins
				.insert(id.to_owned(), vec![plugin_entry("user", true)]);
		}
		write_json(&state.plugin_registry(Scope::User), &installed).unwrap();

		let error = ExtensionTransactions::new(&data_dir, &project, Scope::User)
			.uninstall("sample")
			.unwrap_err()
			.to_string();

		assert!(error.contains("sample@first, sample@second"), "{error}");
		let installed = read_installed_plugins(&state.plugin_registry(Scope::User)).unwrap();
		assert_eq!(installed.plugins.len(), 2);
	}

	#[test]
	fn uninstall_reports_when_no_plugin_matches() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		fs::create_dir_all(&project).unwrap();

		let error = ExtensionTransactions::new(&data_dir, &project, Scope::User)
			.uninstall("missing")
			.unwrap_err()
			.to_string();

		assert!(error.contains("nothing to remove"), "{error}");
		assert!(error.contains("missing"), "{error}");
	}

	#[test]
	fn uninstall_keeps_qualified_package_resolution_unchanged() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		fs::create_dir_all(&project).unwrap();
		let state = StatePaths::new(&data_dir, &project);
		let mut installed = InstalledPluginsRegistry::default();
		for id in ["sample@first", "sample@second"] {
			installed
				.plugins
				.insert(id.to_owned(), vec![plugin_entry("user", true)]);
		}
		write_json(&state.plugin_registry(Scope::User), &installed).unwrap();

		let removed = ExtensionTransactions::new(&data_dir, &project, Scope::User)
			.uninstall("sample@second")
			.unwrap();

		assert_eq!(removed, "sample@second");
		let installed = read_installed_plugins(&state.plugin_registry(Scope::User)).unwrap();
		assert!(installed.plugins.contains_key("sample@first"));
		assert!(!installed.plugins.contains_key("sample@second"));
	}

	#[test]
	fn installed_projection_marks_user_plugins_shadowed_by_project() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		fs::create_dir_all(&project).unwrap();
		let state = StatePaths::new(&data_dir, &project);
		let mut user = InstalledPluginsRegistry::default();
		user
			.plugins
			.insert("sample@index".to_owned(), vec![plugin_entry("user", true)]);
		let mut project_record = InstalledPluginsRegistry::default();
		project_record
			.plugins
			.insert("sample@index".to_owned(), vec![plugin_entry("project", true)]);
		write_json(&state.plugin_registry(Scope::User), &user).unwrap();
		write_json(&state.plugin_registry(Scope::Project), &project_record).unwrap();

		let entries = ExtensionTransactions::new(&data_dir, &project, Scope::User)
			.installed()
			.unwrap();

		assert_eq!(entries.len(), 2);
		assert!(
			entries
				.iter()
				.any(|entry| entry.scope == Scope::User && entry.shadowed)
		);
		assert!(
			entries
				.iter()
				.any(|entry| entry.scope == Scope::Project && !entry.shadowed)
		);
	}

	#[tokio::test]
	async fn local_marketplace_installs_the_complete_plugin_resource_tree() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		let marketplace = temp.path().join("marketplace");
		fs::create_dir_all(project.as_path()).unwrap();
		fs::create_dir_all(marketplace.join(".omp-plugin")).unwrap();
		fs::create_dir_all(marketplace.join("plugins/sample/skills/review")).unwrap();
		fs::create_dir_all(marketplace.join("plugins/sample/commands")).unwrap();
		fs::write(
			marketplace.join(".omp-plugin/marketplace.json"),
			br#"{
				"name":"official",
				"owner":{"name":"OMP"},
				"metadata":{"pluginRoot":"plugins"},
				"plugins":[{
					"name":"sample",
					"version":"1.2.0",
					"description":"sample plugin",
					"source":"./sample",
					"lspServers":{"rust":{"command":"rust-analyzer"}}
				}]
			}"#,
		)
		.unwrap();
		fs::write(marketplace.join("plugins/sample/skills/review/SKILL.md"), "# Review").unwrap();
		fs::write(marketplace.join("plugins/sample/commands/review.md"), "# Review").unwrap();

		let transactions = ExtensionTransactions::new(&data_dir, &project, Scope::User);
		transactions
			.add_index(marketplace.to_str().unwrap())
			.await
			.unwrap();
		let package = transactions
			.install("sample@official", false)
			.await
			.unwrap();

		assert_eq!(package.version, "1.2.0");
		let installed =
			read_installed_plugins(&StatePaths::new(&data_dir, &project).plugin_registry(Scope::User))
				.unwrap();
		let root = &installed.plugins["sample@official"][0].install_path;
		assert!(root.join("skills/review/SKILL.md").is_file());
		assert!(root.join("commands/review.md").is_file());
		assert!(root.join(".lsp.json").is_file());
	}
	#[tokio::test]
	async fn multiple_marketplace_catalogs_are_retained_and_aggregated() {
		let temp = tempfile::tempdir().unwrap();
		let data_dir = temp.path().join("data");
		let project = temp.path().join("project");
		fs::create_dir_all(&project).unwrap();
		for (marketplace, plugin) in [("first", "alpha"), ("second", "beta")] {
			let root = temp.path().join(marketplace);
			fs::create_dir_all(root.join(".omp-plugin")).unwrap();
			fs::create_dir_all(root.join(plugin)).unwrap();
			fs::write(
				root.join(".omp-plugin/marketplace.json"),
				format!(
					r#"{{"name":"{marketplace}","owner":{{"name":"OMP"}},"plugins":[{{"name":"{plugin}","source":"./{plugin}","version":"1.0.0"}}]}}"#
				),
			)
			.unwrap();
		}
		let transactions = ExtensionTransactions::new(&data_dir, &project, Scope::User);
		transactions
			.add_index(temp.path().join("first").to_str().unwrap())
			.await
			.unwrap();
		transactions
			.add_index(temp.path().join("second").to_str().unwrap())
			.await
			.unwrap();

		assert_eq!(transactions.indexes().unwrap().len(), 2);
		assert_eq!(transactions.discover(None).unwrap().len(), 2);
	}
}
