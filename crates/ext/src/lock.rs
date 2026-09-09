//! Reproducible extension locks and local installation records.

use std::{
	collections::{BTreeMap, BTreeSet},
	fs, io,
	path::{Path, PathBuf},
};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use toml::map;

use super::{
	ExtensionCode, ExtensionError, Layer, TrustTier,
	resolver::{normalize_distribution_name, validate_abi},
};

/// Current `omp.lock` format version.
pub const LOCK_VERSION: u32 = 2;

/// A hash-addressed wheel accepted by a target.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct Wheel {
	/// Wheel filename.
	pub file:   Str,
	/// Wheel tag.
	pub tag:    Str,
	/// Artifact byte count.
	pub size:   u64,
	/// BLAKE3 artifact digest.
	pub blake3: Str,
	/// SHA-256 artifact digest.
	pub sha256: Str,
}

/// A locked extension root.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LockedExtension {
	/// Stable extension id.
	pub id: Str,
	/// Exact PEP 440 version.
	pub version: Str,
	/// Requested isolation tier.
	pub tier: TrustTier,
	/// Optional explicit sharing group.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub pool: Option<Str>,
	/// Features enabled while resolving.
	pub features: Vec<Str>,
	/// Reproducible source description, never a link source.
	pub source: toml::Value,
	/// Canonical manifest BLAKE3 digest.
	pub manifest_digest: Str,
	/// Canonical digest of the selected declaration projection.
	pub declaration_digest: Str,
	/// Capability digest used for consent.
	pub capability_digest: Str,
	/// Canonical digest of the complete signed capability graph.
	pub manifest_capability_digest: Str,
	/// TOFU publisher key.
	pub publisher: Str,
	/// Publisher signature over both artifact hashes and the complete manifest
	/// capability graph digest.
	pub signature: Str,
	/// Code shipping level.
	pub ship: Str,
	/// Exact direct requirements.
	pub requires: Vec<Str>,
	/// Extension's primary wheel.
	pub wheel: Wheel,
}

/// A package closure node with one wheel per supported target.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct LockedPackage {
	/// PEP 503 normalized name.
	pub name:         Str,
	/// Exact version.
	pub version:      Str,
	/// First index providing the name.
	pub index:        String,
	/// Extension ids introducing this package.
	pub requested_by: Vec<Str>,
	/// Target-side marker, empty when unconditional.
	pub marker:       String,
	/// Target-specific wheels.
	pub wheels:       Vec<Wheel>,
}

/// Runtime metadata explaining a frozen-first resolver pin.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct FrozenDistribution {
	/// Distribution name.
	pub name:    Str,
	/// Exact frozen version.
	pub version: Str,
	/// Human-readable frozen-first reason.
	pub reason:  Str,
}

/// The committed, portable extension resolution.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct LockFile {
	/// Lock format version.
	pub version:         u32,
	/// Writer identity.
	pub generated_by:    String,
	/// RFC 3339 generation timestamp.
	pub generated_at:    String,
	/// Owning layer.
	pub layer:           Layer,
	/// Required `CPython` version.
	pub requires_python: Str,
	/// Required `CPython` ABI.
	pub abi:             Str,
	/// Union of resolved target triples.
	pub targets:         Vec<Str>,
	/// Optional R9 upload-time clamp.
	#[serde(skip_serializing_if = "Option::is_none")]
	pub exclude_newer:   Option<Str>,
	/// Ordered configured indexes.
	pub indexes:         Vec<String>,
	/// Dependency-confusion-safe index strategy.
	pub index_strategy:  Str,
	/// Locked extension roots.
	#[serde(rename = "extension")]
	pub extensions:      Vec<LockedExtension>,
	/// Locked dependency closure.
	#[serde(rename = "package")]
	pub packages:        Vec<LockedPackage>,
	/// Runtime frozen distributions.
	#[serde(rename = "frozen")]
	pub frozen:          Vec<FrozenDistribution>,
}

impl LockFile {
	/// Validates reader-critical invariants before a lock is consumed.
	pub fn validate_for(&self, layer: Layer) -> Result<(), ExtensionError> {
		if self.version > LOCK_VERSION {
			return Err(ExtensionError::new(
				ExtensionCode::ELockVersion,
				"lock format is newer than this binary",
			));
		}
		if self.layer != layer {
			return Err(ExtensionError::new(
				ExtensionCode::ELockLayer,
				"lock belongs to a different layer",
			));
		}
		if self.requires_python.as_str() != "==3.14.*" || self.abi.as_str() != "cp314t" {
			return Err(ExtensionError::new(
				ExtensionCode::ELockPython,
				"lock does not target CPython 3.14t",
			));
		}
		if self.index_strategy.as_str() != "first-index" {
			return Err(ExtensionError::new(
				ExtensionCode::EIndexDrift,
				"lock does not use first-index",
			));
		}
		if !is_unique_nonempty(&self.targets) {
			return Err(ExtensionError::new(
				ExtensionCode::ELockDrift,
				"lock targets must be non-empty, unique target triples",
			));
		}
		if self.indexes.iter().any(String::is_empty)
			|| self.indexes.iter().collect::<BTreeSet<_>>().len() != self.indexes.len()
		{
			return Err(ExtensionError::new(
				ExtensionCode::EIndexDrift,
				"lock indexes must be non-empty and unique while preserving first-index order",
			));
		}
		let mut ids = BTreeSet::new();
		for extension in &self.extensions {
			if !ids.insert(&extension.id) {
				return Err(ExtensionError::new(
					ExtensionCode::ELockDup,
					format!("duplicate extension id {}", extension.id),
				));
			}
			validate_canonical_features(&extension.features)?;
			if !valid_digest(extension.manifest_digest.as_str(), "b3:")
				|| !valid_digest(extension.declaration_digest.as_str(), "b3:")
				|| !valid_digest(extension.capability_digest.as_str(), "b3:")
				|| !valid_digest(extension.manifest_capability_digest.as_str(), "b3:")
				|| !valid_digest(extension.wheel.blake3.as_str(), "b3:")
				|| !valid_digest(extension.wheel.sha256.as_str(), "sha256:")
			{
				return Err(ExtensionError::new(
					ExtensionCode::ELockDrift,
					format!("{} has an incomplete or malformed digest set", extension.id),
				));
			}
			if extension.wheel.file.is_empty() || extension.wheel.size == 0 {
				return Err(ExtensionError::new(
					ExtensionCode::ELockDrift,
					format!("{} has incomplete wheel identity", extension.id),
				));
			}
			validate_abi(extension.wheel.tag.as_str())?;
			if extension
				.source
				.as_table()
				.is_some_and(|source| source.contains_key("link"))
			{
				return Err(ExtensionError::new(
					ExtensionCode::ELockLink,
					"link sources are not reproducible",
				));
			}
		}
		let mut package_versions = BTreeMap::new();
		for package in &self.packages {
			let normalized = normalize_distribution_name(package.name.as_str());
			if normalized != package.name.as_str() {
				return Err(ExtensionError::new(
					ExtensionCode::ELockDrift,
					format!("package name {} is not PEP 503-normalized", package.name),
				));
			}
			if let Some(version) = package_versions.insert(normalized, &package.version)
				&& version != &package.version
			{
				return Err(ExtensionError::new(
					ExtensionCode::EUnsat,
					format!("multiple versions of {} in one host child", package.name),
				));
			}
			for wheel in &package.wheels {
				if wheel.file.is_empty()
					|| wheel.size == 0
					|| !valid_digest(wheel.blake3.as_str(), "b3:")
					|| !valid_digest(wheel.sha256.as_str(), "sha256:")
				{
					return Err(ExtensionError::new(
						ExtensionCode::ELockDrift,
						format!("package {} has incomplete wheel identity", package.name),
					));
				}
				validate_abi(wheel.tag.as_str())?;
			}
		}
		Ok(())
	}

	/// Computes the immutable resolution identity used to fence package
	/// snapshots and extension-host generations. Writer metadata is excluded:
	/// regenerating an identical lock must retain the same identity.
	pub fn resolution_digest(&self) -> Result<Str, ExtensionError> {
		self.validate_for(self.layer)?;
		#[derive(Serialize)]
		struct Resolution<'a> {
			layer:           Layer,
			requires_python: &'a Str,
			abi:             &'a Str,
			targets:         &'a [Str],
			exclude_newer:   Option<&'a Str>,
			indexes:         &'a [String],
			index_strategy:  &'a Str,
			extensions:      &'a [LockedExtension],
			packages:        &'a [LockedPackage],
			frozen:          &'a [FrozenDistribution],
		}
		let bytes = serde_json::to_vec(&Resolution {
			layer:           self.layer,
			requires_python: &self.requires_python,
			abi:             &self.abi,
			targets:         &self.targets,
			exclude_newer:   self.exclude_newer.as_ref(),
			indexes:         &self.indexes,
			index_strategy:  &self.index_strategy,
			extensions:      &self.extensions,
			packages:        &self.packages,
			frozen:          &self.frozen,
		})
		.map_err(|error| ExtensionError::new(ExtensionCode::ELockDrift, error.to_string()))?;
		Ok(Str::new(format!("b3:{}", blake3::hash(&bytes).to_hex())))
	}

	/// Reads and validates one `omp.lock`.
	#[tracing::instrument(
		name = "extension_lock_read",
		level = "debug",
		skip_all,
		fields(path = %path.display(), layer = ?layer)
	)]
	pub fn read(path: &Path, layer: Layer) -> Result<Self, ExtensionError> {
		let result: Result<Self, ExtensionError> = (|| {
			let text = fs::read_to_string(path)
				.map_err(|error| ExtensionError::new(ExtensionCode::ELockVersion, error.to_string()))?;
			let lock: Self = toml::from_str(&text)
				.map_err(|error| ExtensionError::new(ExtensionCode::ELockVersion, error.to_string()))?;
			lock.validate_for(layer)?;
			Ok(lock)
		})();
		if let Ok(lock) = &result {
			tracing::debug!(
				extension_count = lock.extensions.len(),
				package_count = lock.packages.len(),
				"extension lock loaded"
			);
		}
		result
	}

	/// Atomically writes a committed `omp.lock`.
	pub fn write(&self, path: &Path) -> io::Result<()> {
		atomic_toml(path, self)
	}

	/// Merges a target-specific resolution into a per-target union lock.
	/// Existing package metadata remains canonical while unique target wheels
	/// are appended by filename and tag.
	pub fn union_target(&mut self, other: &Self) -> Result<(), ExtensionError> {
		if self.layer != other.layer
			|| self.requires_python != other.requires_python
			|| self.abi != other.abi
		{
			return Err(ExtensionError::new(
				ExtensionCode::ELockPython,
				"cannot union incompatible lock headers",
			));
		}
		for target in &other.targets {
			if !self.targets.contains(target) {
				self.targets.push(target.clone());
			}
		}
		for package in &other.packages {
			if let Some(existing) = self.packages.iter_mut().find(|candidate| {
				candidate.name == package.name && candidate.version == package.version
			}) {
				for wheel in &package.wheels {
					if !existing
						.wheels
						.iter()
						.any(|candidate| candidate.file == wheel.file && candidate.tag == wheel.tag)
					{
						existing.wheels.push(wheel.clone());
					}
				}
			} else {
				self.packages.push(package.clone());
			}
		}
		Ok(())
	}

	/// Exports the dependency closure to the PEP 751 `pylock.toml` subset.
	pub fn export_pylock(&self, path: &Path) -> io::Result<()> {
		#[derive(Serialize)]
		struct PyLock<'a> {
			lock_version:    &'static str,
			requires_python: &'a Str,
			#[serde(rename = "package")]
			packages:        &'a [LockedPackage],
		}
		atomic_toml(path, &PyLock {
			lock_version:    "1.0",
			requires_python: &self.requires_python,
			packages:        &self.packages,
		})
	}
}

fn is_unique_nonempty(values: &[Str]) -> bool {
	!values.is_empty()
		&& values.iter().all(|value| !value.is_empty())
		&& values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn valid_digest(value: &str, prefix: &str) -> bool {
	value.strip_prefix(prefix).is_some_and(|digest| {
		digest.len() == 64 && digest.bytes().all(|byte| byte.is_ascii_hexdigit())
	})
}

/// Local-only record of materialized extension selections, including `link`
/// overlays that are intentionally excluded from `omp.lock`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct InstalledRecord {
	/// Install record format version.
	#[serde(default = "installed_version")]
	pub version:    u32,
	/// Local extension selections.
	#[serde(rename = "extension", default)]
	pub extensions: Vec<InstalledExtension>,
}

const fn installed_version() -> u32 {
	2
}

/// One local extension selection.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct InstalledExtension {
	/// Stable extension id.
	pub id:       Str,
	/// Fully expanded, sorted concrete feature selection.
	#[serde(default)]
	pub features: Vec<Str>,
	/// Local source, including permitted `{ link = ... }` overlays.
	pub source:   toml::Value,
	/// Requested tier.
	pub tier:     TrustTier,
	/// Whether this local selection is enabled.
	pub enabled:  bool,
}

/// The materialized per-host site tree carried into the Python package
/// snapshot. This is constructed from `SiteTree`'s result, not guessed from a
/// lock path.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MaterializedSite {
	/// Absolute managed site-tree path.
	pub path:       PathBuf,
	/// Content-addressed site-tree key.
	pub key:        Str,
	/// Resolution layer.
	pub layer:      Layer,
	/// Granted host tier.
	pub tier:       TrustTier,
	/// Optional explicit sharing pool.
	pub pool:       Option<Str>,
	/// Resolution fingerprint.
	pub resolution: Str,
	/// Source lock path when a durable lock produced the tree.
	pub lock:       Option<PathBuf>,
}

/// Builds the verified UTF-8 JSON envelope consumed by
/// `omp.packages._install_snapshot_json` before extension code starts.
///
/// Linked and path-development extensions have no reproducible closure and
/// return `None`; every non-development extension either yields a complete
/// snapshot or fails with a typed lock diagnostic.
pub fn package_snapshot(
	installed: &InstalledExtension,
	lock: &LockFile,
	site: &MaterializedSite,
	modules: impl IntoIterator<Item = (Str, Str)>,
) -> Result<Option<Str>, ExtensionError> {
	if development_source(&installed.source) {
		return Ok(None);
	}
	let expected_resolution = lock.resolution_digest()?;
	if site.resolution != expected_resolution {
		return Err(ExtensionError::new(
			ExtensionCode::ELockDrift,
			format!(
				"materialized site resolution {} does not match lock {}",
				site.resolution, expected_resolution
			),
		));
	}
	let extension = lock
		.extensions
		.iter()
		.find(|extension| extension.id == installed.id)
		.ok_or_else(|| {
			ExtensionError::new(
				ExtensionCode::ELockDrift,
				format!("{} has no locked closure", installed.id),
			)
		})?;
	if extension.publisher.as_str().is_empty()
		|| extension.publisher.as_str().starts_with("unsigned:")
	{
		return Ok(None);
	}
	let root_name = distribution_name(&extension.source).ok_or_else(|| {
		ExtensionError::new(
			ExtensionCode::ELockDrift,
			format!("{} has no locked distribution name", installed.id),
		)
	})?;
	#[derive(Serialize)]
	struct Distribution<'a> {
		name:         &'a Str,
		version:      &'a Str,
		#[serde(skip_serializing_if = "Option::is_none")]
		extension_id: Option<&'a Str>,
		origin:       &'static str,
		#[serde(skip_serializing_if = "Option::is_none")]
		tag:          Option<&'a Str>,
		#[serde(skip_serializing_if = "Option::is_none")]
		blake3:       Option<&'a Str>,
		#[serde(skip_serializing_if = "Option::is_none")]
		root:         Option<String>,
		files:        Vec<String>,
		requested_by: Vec<&'a Str>,
		vendored:     Vec<String>,
	}
	#[derive(Serialize)]
	struct Tree<'a> {
		path:       String,
		key:        &'a Str,
		layer:      Layer,
		tier:       TrustTier,
		pool:       Option<&'a Str>,
		resolution: &'a Str,
		lock:       Option<String>,
	}
	#[derive(Serialize)]
	struct Envelope<'a> {
		distributions: Vec<Distribution<'a>>,
		modules:       BTreeMap<Str, Str>,
		own:           Option<Str>,
		tree:          Option<Tree<'a>>,
	}
	let root = Some(site.path.display().to_string());
	// `root_name` is moved into `own` below; the envelope borrows this copy.
	let root_distribution_name = root_name.clone();
	let mut distributions = vec![Distribution {
		name:         &root_distribution_name,
		version:      &extension.version,
		extension_id: Some(&extension.id),
		origin:       "store",
		tag:          Some(&extension.wheel.tag),
		blake3:       Some(&extension.wheel.blake3),
		root:         root.clone(),
		files:        Vec::new(),
		requested_by: Vec::new(),
		vendored:     Vec::new(),
	}];
	for package in &lock.packages {
		if !package.requested_by.contains(&installed.id) {
			continue;
		}
		let wheel = package.wheels.first();
		distributions.push(Distribution {
			name:         &package.name,
			version:      &package.version,
			extension_id: None,
			origin:       "store",
			tag:          wheel.map(|wheel| &wheel.tag),
			blake3:       wheel.map(|wheel| &wheel.blake3),
			root:         root.clone(),
			files:        Vec::new(),
			requested_by: package.requested_by.iter().collect(),
			vendored:     Vec::new(),
		});
	}
	for frozen in &lock.frozen {
		if distributions
			.iter()
			.any(|distribution| distribution.name == &frozen.name)
		{
			continue;
		}
		distributions.push(Distribution {
			name:         &frozen.name,
			version:      &frozen.version,
			extension_id: None,
			origin:       "frozen",
			tag:          None,
			blake3:       None,
			root:         None,
			files:        Vec::new(),
			requested_by: Vec::new(),
			vendored:     Vec::new(),
		});
	}
	let modules: BTreeMap<Str, Str> = modules.into_iter().collect();
	for owner in modules.values() {
		if !distributions
			.iter()
			.any(|distribution| distribution.name == owner)
		{
			return Err(ExtensionError::new(
				ExtensionCode::EIntegrity,
				format!("module owner {owner} is outside the locked closure"),
			));
		}
	}
	let envelope = Envelope {
		distributions,
		modules,
		own: Some(root_name),
		tree: Some(Tree {
			path:       site.path.display().to_string(),
			key:        &site.key,
			layer:      site.layer,
			tier:       site.tier,
			pool:       site.pool.as_ref(),
			resolution: &site.resolution,
			lock:       site.lock.as_ref().map(|path| path.display().to_string()),
		}),
	};
	let envelope = serde_json::to_string(&envelope)
		.map_err(|error| ExtensionError::new(ExtensionCode::EIntegrity, error.to_string()))?;
	Ok(Some(Str::new(envelope)))
}

fn development_source(source: &toml::Value) -> bool {
	source
		.as_table()
		.is_some_and(|source| source.contains_key("link") || source.contains_key("path"))
}

fn distribution_name(source: &toml::Value) -> Option<Str> {
	let source = source.as_table()?;
	source
		.get("dist")
		.or_else(|| source.get("pypi"))
		.and_then(toml::Value::as_str)
		.map(Str::new)
}

impl InstalledRecord {
	/// Reads an absent install record as an empty record.
	pub fn read(path: &Path) -> Result<Self, ExtensionError> {
		if !path.exists() {
			return Ok(Self { version: installed_version(), ..Self::default() });
		}
		let text = fs::read_to_string(path)
			.map_err(|error| ExtensionError::new(ExtensionCode::ELockVersion, error.to_string()))?;
		let mut record: Self = toml::from_str(&text)
			.map_err(|error| ExtensionError::new(ExtensionCode::ELockVersion, error.to_string()))?;
		if record.version > installed_version() {
			return Err(ExtensionError::new(
				ExtensionCode::ELockVersion,
				"install record format is newer than this binary",
			));
		}
		for extension in &record.extensions {
			validate_canonical_features(&extension.features)?;
		}
		record.version = installed_version();
		Ok(record)
	}

	/// Atomically writes `installed.toml`.
	pub fn write(&self, path: &Path) -> io::Result<()> {
		atomic_toml(path, self)
	}
}

/// Writes TOML through a sibling temporary file then renames it into place.
pub(crate) fn atomic_toml<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
	let parent = path.parent().unwrap_or_else(|| Path::new("."));
	fs::create_dir_all(parent)?;
	let temporary = path.with_extension(format!(
		"{}.tmp",
		path
			.extension()
			.and_then(|extension| extension.to_str())
			.unwrap_or("toml")
	));
	let data = toml::to_string_pretty(value).map_err(io::Error::other)?;
	fs::write(&temporary, data)?;
	fs::rename(temporary, path)
}
fn validate_canonical_features(features: &[Str]) -> Result<(), ExtensionError> {
	let mut previous: Option<&Str> = None;
	for feature in features {
		if feature.is_empty() || feature.as_str().trim() != feature.as_str() {
			return Err(ExtensionError::new(
				ExtensionCode::EFeature,
				"feature names must be non-empty and trimmed",
			));
		}
		if previous.is_some_and(|previous| previous >= feature) {
			return Err(ExtensionError::new(
				ExtensionCode::EFeature,
				"concrete features must be unique and lexically sorted",
			));
		}
		previous = Some(feature);
	}
	Ok(())
}

/// Builds the source table used by reproducible lock entries.
pub fn index_source(index: &str, distribution: &Str) -> toml::Value {
	let mut source = map::Map::new();
	source.insert("index".to_owned(), toml::Value::String(index.to_owned()));
	source.insert("dist".to_owned(), toml::Value::String(distribution.to_string()));
	toml::Value::Table(source)
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	fn lock() -> LockFile {
		LockFile {
			version:         LOCK_VERSION,
			generated_by:    "omp test".to_owned(),
			generated_at:    "2026-08-20T00:00:00Z".to_owned(),
			layer:           Layer::Workspace,
			requires_python: sf!("==3.14.*"),
			abi:             sf!("cp314t"),
			targets:         vec![sf!("aarch64-apple-darwin")],
			exclude_newer:   None,
			indexes:         vec!["https://pypi.org/simple".to_owned()],
			index_strategy:  sf!("first-index"),
			extensions:      vec![],
			packages:        vec![],
			frozen:          vec![],
		}
	}

	#[test]
	fn lock_round_trip() {
		let directory = tempfile::tempdir().expect("temporary lock directory");
		let path = directory.path().join("omp.lock");
		lock().write(&path).expect("write lock");
		assert_eq!(LockFile::read(&path, Layer::Workspace).expect("read lock"), lock());
	}

	#[test]
	fn resolution_digest_ignores_writer_metadata_but_not_index_order() {
		let first = lock();
		let mut regenerated = first.clone();
		regenerated.generated_by = "different writer".to_owned();
		regenerated.generated_at = "2026-09-04T00:00:00Z".to_owned();
		assert_eq!(
			first.resolution_digest().expect("first digest"),
			regenerated.resolution_digest().expect("regenerated digest")
		);

		regenerated
			.indexes
			.insert(0, "https://private.example/simple".to_owned());
		assert_ne!(
			first.resolution_digest().expect("first digest"),
			regenerated.resolution_digest().expect("changed digest")
		);
	}
}
