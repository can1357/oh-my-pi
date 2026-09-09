//! Immutable Python site-tree materialization owned by the Environment.

use std::{
	collections::BTreeMap,
	fs, io,
	path::{Path, PathBuf},
	str,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use bytes::Bytes;
use omp_core::{ArtifactDigest, Hash32, Str, encoding::hex};
use omp_ext::{ExtensionCode, ExtensionError, config::StaticDeclarations};
use omp_journal::blob::{self, BlobRef, BlobStore};
use omp_proto::env::v1 as pb;
use serde::{Deserialize, Serialize};
use thiserror::Error;
static SITE_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// Errors while materializing an immutable site tree.
#[derive(Debug, Error)]
pub enum SiteError {
	/// The site key would escape the environment-owned sites directory.
	#[error("invalid site key")]
	InvalidSiteKey,
	/// A farm member path was not a safe relative path.
	#[error("invalid site file path: {0}")]
	InvalidFilePath(Str),
	/// A requested blob hash was not a SHA-256 digest.
	#[error("site file blob hash must be exactly 32 bytes")]
	InvalidBlobHash,
	/// The source or destination content-addressed store failed.
	#[error(transparent)]
	Store(#[from] blob::Error),
	/// A filesystem operation failed.
	#[error(transparent)]
	Io(#[from] io::Error),
	/// A trusted extension attempted to load a module outside its RECORD
	/// membership.
	#[error(transparent)]
	TrustedLoad(ExtensionError),
	/// A RECORD file was not valid UTF-8.
	#[error("RECORD is not valid UTF-8")]
	InvalidRecord,
	/// A requested current site tree has not been materialized.
	#[error("site tree is not materialized")]
	SiteMissing,
	/// An authenticated deployment manifest contained malformed declaration
	/// tables.
	#[error("invalid static extension declarations: {0}")]
	InvalidDeclarations(#[from] serde_json::Error),
}

/// Immutable projection of verified deployment declarations associated with a
/// materialized Python site.
#[derive(Clone, Debug)]
pub struct VerifiedDeclarationSnapshot {
	artifact_digest:     ArtifactDigest,
	declaration_modules: Box<[Str]>,
	declarations:        Arc<StaticDeclarations>,
}

impl VerifiedDeclarationSnapshot {
	/// Parses and freezes authenticated manifest properties before a child may
	/// import any declaration module.
	pub fn from_verified_manifest(
		artifact_digest: ArtifactDigest,
		declaration_modules: impl IntoIterator<Item = Str>,
		properties: &BTreeMap<Str, serde_json::Value>,
	) -> Result<Self, SiteError> {
		Ok(Self {
			artifact_digest,
			declaration_modules: declaration_modules.into_iter().collect(),
			declarations: Arc::new(StaticDeclarations::from_properties(properties)?),
		})
	}

	/// Returns the digest of the exact authenticated deployment artifact.
	pub const fn artifact_digest(&self) -> &ArtifactDigest {
		&self.artifact_digest
	}

	/// Returns declaration modules in deployment order.
	pub fn declaration_modules(&self) -> &[Str] {
		&self.declaration_modules
	}

	/// Returns the immutable typed declaration projection.
	pub fn declarations(&self) -> &StaticDeclarations {
		&self.declarations
	}
}

/// Exact operator-selected trusted Python module.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedModule {
	/// Canonical absolute module file.
	pub path:            PathBuf,
	/// Importable single-module name.
	pub module:          Str,
	/// SHA-256 digest of the exact operator-approved module bytes.
	pub artifact_digest: ArtifactDigest,
}

/// Validates `--trusted-extension` as one absolute Python module, never a
/// directory or ambient sibling-discovery root.
pub fn validate_trusted_module(path: &Path) -> Result<TrustedModule, SiteError> {
	if !path.is_absolute() || path.extension().and_then(|value| value.to_str()) != Some("py") {
		return Err(trusted_load_error(path, "expected an absolute .py module path"));
	}
	let canonical = fs::canonicalize(path)
		.map_err(|_| trusted_load_error(path, "module does not exist or cannot be resolved"))?;
	if !canonical.is_file() {
		return Err(trusted_load_error(path, "trusted module is not a regular file"));
	}
	let stem = canonical.file_stem().and_then(|value| value.to_str());
	// A package `__init__.py` imports under its directory's name.
	let module = if stem == Some("__init__") {
		canonical
			.parent()
			.and_then(|parent| parent.file_name())
			.and_then(|name| name.to_str())
	} else {
		stem
	};
	let module = module
		.filter(|value| python_identifier(value))
		.map(Str::new)
		.ok_or_else(|| trusted_load_error(path, "module filename is not a Python identifier"))?;
	let bytes =
		fs::read(&canonical).map_err(|_| trusted_load_error(path, "module cannot be read"))?;
	let mut digest = Hash32::hasher();
	digest.update(b"omp/trusted-extension-module/v1");
	digest.update(&(bytes.len() as u64).to_le_bytes());
	digest.update(&bytes);
	Ok(TrustedModule {
		path: canonical,
		module,
		artifact_digest: ArtifactDigest::new(digest.finalize().into_bytes()),
	})
}

fn python_identifier(value: &str) -> bool {
	let mut bytes = value.bytes();
	matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_'))
		&& bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn trusted_load_error(path: &Path, detail: &'static str) -> SiteError {
	SiteError::TrustedLoad(ExtensionError::new(
		ExtensionCode::ETrustedLoad,
		format!("{}: {detail}", path.display()),
	))
}

/// Sorted, persisted `RECORD` ownership entries for one materialized tree.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct OwnershipMap {
	entries: Vec<Ownership>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
struct Ownership {
	module: Str,
	owner:  Str,
}

impl OwnershipMap {
	fn from_records(
		owner: &str,
		records: impl IntoIterator<Item = (Str, Bytes)>,
	) -> Result<Self, SiteError> {
		let mut entries = Vec::new();
		for (record_path, record) in records {
			let is_record = record_path
				.rsplit_once('/')
				.is_some_and(|(parent, name)| name == "RECORD" && parent.ends_with(".dist-info"));
			if !is_record {
				return Err(SiteError::InvalidFilePath(record_path));
			}
			let record = str::from_utf8(&record).map_err(|_| SiteError::InvalidRecord)?;
			for row in record.lines() {
				let path = row.split(',').next().unwrap_or_default();
				if let Some(module) = module_path(path) {
					entries.push(Ownership { module: Str::from(module), owner: Str::from(owner) });
				}
			}
		}
		entries.sort_unstable();
		entries.dedup();
		Ok(Self { entries })
	}

	/// Returns whether `module` is listed in `owner`'s wheel RECORD.
	pub(crate) fn owns(&self, module: &str, owner: &str) -> bool {
		let needle = Ownership { module: Str::from(module), owner: Str::from(owner) };
		self.entries.binary_search(&needle).is_ok()
	}

	/// Enforces the trusted-extension RECORD-membership boundary.
	pub(crate) fn require_owned(
		&self,
		module: impl Into<Str>,
		owner: impl Into<Str>,
	) -> Result<(), SiteError> {
		let module = module.into();
		let owner = owner.into();
		if self.owns(&module, &owner) {
			Ok(())
		} else {
			Err(SiteError::TrustedLoad(ExtensionError::new(
				ExtensionCode::ETrustedLoad,
				format!("module {module} is not owned by {owner}"),
			)))
		}
	}
}

/// Environment-owned content store and per-host symlink-farm builder.
#[derive(Clone, Debug)]
pub struct SiteMaterializer {
	root:   PathBuf,
	store:  BlobStore,
	source: BlobStore,
}

impl SiteMaterializer {
	/// Opens the site store rooted below the Environment state directory.
	pub(crate) fn open(root: impl Into<PathBuf>, source: BlobStore) -> Result<Self, SiteError> {
		let root = root.into();
		fs::create_dir_all(root.join("sites"))?;
		Ok(Self { store: BlobStore::open(root.join("store"))?, root, source })
	}

	/// Copies required refs into the content-addressed store, builds a complete
	/// farm, and atomically swaps the current site symlink.
	pub(crate) fn materialize(
		&self,
		request: pb::MaterializeSite,
	) -> Result<pb::SiteMaterialized, SiteError> {
		let site_key = request.site_key;
		if !safe_component(&site_key) {
			return Err(SiteError::InvalidSiteKey);
		}
		let files = canonical_files(request.files)?;
		let manifest_hash = manifest_hash(&site_key, &files);
		let sites = self.root.join("sites");
		let current = sites.join(&site_key);
		if current_manifest_matches(&current, &manifest_hash)? {
			for module in files.keys().filter_map(|path| module_path(path)) {
				self.require_record_owner(&site_key, module, &site_key)?;
			}
			return Ok(site_materialized(&site_key, &current, &manifest_hash, 0));
		}

		let mut unpacked = 0_u64;
		let mut refs = BTreeMap::new();
		for (path, file) in &files {
			let source = self.source_ref(&file.blob_hash)?;
			if !self.store.has(&source) {
				let bytes = self.source.get(&source)?;
				self.store.put(&bytes)?;
				unpacked += 1;
			}
			refs.insert(path.clone(), source);
		}

		let resolution = sites.join(format!("{}-{}", site_key, hex16(&manifest_hash)));
		if !resolution.is_dir() {
			self.build_resolution(&site_key, &resolution, &files, &refs, &manifest_hash)?;
		}
		self.swap_current(&current, &resolution)?;
		for module in files.keys().filter_map(|path| module_path(path)) {
			self.require_record_owner(&site_key, module, &site_key)?;
		}
		Ok(site_materialized(&site_key, &current, &manifest_hash, unpacked))
	}

	/// Refuses a trusted module load unless its current site's persisted RECORD
	/// map lists the exact owner.
	pub(crate) fn require_record_owner(
		&self,
		site_key: &str,
		module: impl Into<Str>,
		owner: impl Into<Str>,
	) -> Result<(), SiteError> {
		if !safe_component(site_key) {
			return Err(SiteError::InvalidSiteKey);
		}
		let current = self.root.join("sites").join(site_key);
		let target = fs::read_link(&current).map_err(|error| {
			if error.kind() == io::ErrorKind::NotFound {
				SiteError::SiteMissing
			} else {
				SiteError::Io(error)
			}
		})?;
		let target = if target.is_absolute() {
			target
		} else {
			current
				.parent()
				.unwrap_or_else(|| Path::new("."))
				.join(target)
		};
		let bytes = fs::read(target.join("ownership.json")).map_err(|error| {
			if error.kind() == io::ErrorKind::NotFound {
				SiteError::SiteMissing
			} else {
				SiteError::Io(error)
			}
		})?;
		let ownership =
			serde_json::from_slice::<OwnershipMap>(&bytes).map_err(|_| SiteError::InvalidRecord)?;
		ownership.require_owned(module, owner)
	}

	fn source_ref(&self, hash: &[u8]) -> Result<BlobRef, SiteError> {
		let hash = <[u8; 32]>::try_from(hash)
			.map(Hash32::new)
			.map_err(|_| SiteError::InvalidBlobHash)?;
		let probe = BlobRef { hash, size: 0 };
		let size = fs::metadata(self.source.path(&probe))?.len();
		Ok(BlobRef { hash, size })
	}

	fn build_resolution(
		&self,
		owner: &str,
		resolution: &Path,
		files: &BTreeMap<Str, pb::SiteFile>,
		refs: &BTreeMap<Str, BlobRef>,
		manifest_hash: &[u8; 32],
	) -> Result<(), SiteError> {
		let sequence = SITE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let temporary = resolution.with_file_name(format!(".site-{sequence:016x}.tmp"));
		fs::create_dir(&temporary)?;
		let built = (|| {
			let mut records = Vec::new();
			for path in files.keys() {
				let destination = temporary.join(path.as_str());
				if let Some(parent) = destination.parent() {
					fs::create_dir_all(parent)?;
				}
				let reference = refs
					.get(path)
					.expect("canonical refs cover canonical files");
				create_file_symlink(&self.store.path(reference), &destination)?;
				if path.ends_with(".dist-info/RECORD") {
					records.push((path.clone(), self.store.get(reference)?));
				}
			}
			let ownership = OwnershipMap::from_records(owner, records)?;
			for module in files.keys().filter_map(|path| module_path(path)) {
				ownership.require_owned(module, owner)?;
			}
			fs::write(temporary.join(".manifest"), manifest_hash)?;
			fs::write(
				temporary.join("ownership.json"),
				serde_json::to_vec(&ownership).expect("ownership serializes"),
			)?;
			Ok::<(), SiteError>(())
		})();
		if let Err(error) = built {
			let _ = fs::remove_dir_all(&temporary);
			return Err(error);
		}
		match fs::rename(&temporary, resolution) {
			Ok(()) => Ok(()),
			Err(_error) if resolution.is_dir() => {
				let _ = fs::remove_dir_all(&temporary);
				Ok(())
			},
			Err(error) => {
				let _ = fs::remove_dir_all(&temporary);
				Err(error.into())
			},
		}
	}

	fn swap_current(&self, current: &Path, resolution: &Path) -> Result<(), SiteError> {
		let sequence = SITE_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
		let temporary = current.with_file_name(format!(".site-link-{sequence:016x}.tmp"));
		create_directory_symlink(resolution, &temporary)?;
		match fs::rename(&temporary, current) {
			Ok(()) => Ok(()),
			Err(error) => {
				let _ = fs::remove_file(&temporary);
				Err(error.into())
			},
		}
	}
}

fn canonical_files(files: Vec<pb::SiteFile>) -> Result<BTreeMap<Str, pb::SiteFile>, SiteError> {
	let mut canonical = BTreeMap::new();
	for file in files {
		if !safe_relative_path(&file.path) || file.blob_hash.len() != 32 {
			return Err(SiteError::InvalidFilePath(Str::from(file.path)));
		}
		let path = Str::from(file.path.clone());
		if canonical.insert(path.clone(), file).is_some() {
			return Err(SiteError::InvalidFilePath(path));
		}
	}
	Ok(canonical)
}

/// Returns every importable module path represented by a site manifest.
pub fn record_modules(files: &[pb::SiteFile]) -> Vec<Str> {
	files
		.iter()
		.filter_map(|file| module_path(&file.path))
		.map(Str::from)
		.collect()
}

fn manifest_hash(site_key: &str, files: &BTreeMap<Str, pb::SiteFile>) -> [u8; 32] {
	let mut hasher = Hash32::hasher();
	hasher.update(b"omp/site-manifest/v1");
	hasher.update((site_key.len() as u64).to_le_bytes());
	hasher.update(site_key.as_bytes());
	for (path, file) in files {
		hasher.update((path.len() as u64).to_le_bytes());
		hasher.update(path.as_bytes());
		hasher.update(&file.blob_hash);
		hasher.update(file.mode.to_le_bytes());
	}
	hasher.finalize().into_bytes()
}

fn current_manifest_matches(current: &Path, manifest_hash: &[u8; 32]) -> Result<bool, SiteError> {
	let target = match fs::read_link(current) {
		Ok(target) if target.is_absolute() => target,
		Ok(target) => current
			.parent()
			.unwrap_or_else(|| Path::new("."))
			.join(target),
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
		Err(error) => return Err(error.into()),
	};
	match fs::read(target.join(".manifest")) {
		Ok(stored) => Ok(stored.as_slice() == manifest_hash),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
		Err(error) => Err(error.into()),
	}
}

fn site_materialized(
	site_key: &str,
	current: &Path,
	manifest_hash: &[u8; 32],
	unpacked: u64,
) -> pb::SiteMaterialized {
	pb::SiteMaterialized {
		site_key: site_key.to_owned(),
		site_uri: format!("file://{}", current.display()),
		manifest_hash: Bytes::copy_from_slice(manifest_hash),
		unpacked,
		..pb::SiteMaterialized::default()
	}
}

fn hex16(hash: &[u8; 32]) -> String {
	hex::encode_n(hash)[..16].to_owned()
}

fn safe_component(value: &str) -> bool {
	!value.is_empty()
		&& value != "."
		&& value != ".."
		&& !value.bytes().any(|byte| matches!(byte, b'/' | b'\\' | 0))
}

fn safe_relative_path(value: &str) -> bool {
	!value.is_empty()
		&& !Path::new(value).is_absolute()
		&& value.split('/').all(safe_component)
		&& !value.contains('\\')
}
fn module_path(path: &str) -> Option<String> {
	let path = if let Some(path) = path
		.strip_suffix(".py")
		.or_else(|| path.strip_suffix(".pyi"))
	{
		path
	} else {
		let path = path
			.strip_suffix(".pyd")
			.or_else(|| path.strip_suffix(".so"))?;
		let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
		let name = name.split('.').next().unwrap_or_default();
		if parent.is_empty() {
			name
		} else {
			return (!name.is_empty()).then(|| format!("{parent}/{name}").replace('/', "."));
		}
	};
	let path = path.strip_suffix("/__init__").unwrap_or(path);
	(!path.is_empty()).then(|| path.replace('/', "."))
}

#[cfg(unix)]
fn create_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
	use std::os::unix::fs;
	fs::symlink(target, link)
}

#[cfg(windows)]
fn create_file_symlink(target: &Path, link: &Path) -> io::Result<()> {
	use std::os::windows::fs;
	fs::symlink_file(target, link)
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) -> io::Result<()> {
	use std::os::unix::fs;
	fs::symlink(target, link)
}

#[cfg(windows)]
fn create_directory_symlink(target: &Path, link: &Path) -> io::Result<()> {
	use std::os::windows::fs;
	fs::symlink_dir(target, link)
}

#[cfg(test)]
mod tests {
	use bytes::Bytes;
	use omp_core::sf;
	use omp_journal::blob::BlobStore;
	use omp_proto::env::v1;

	use super::{OwnershipMap, SiteError, SiteMaterializer};

	#[test]
	fn record_ownership_membership_is_exact() {
		let ownership = OwnershipMap::from_records("reviewer", [(
			sf!("reviewer-1.0.dist-info/RECORD"),
			Bytes::from_static(b"reviewer/__init__.py,,\nreviewer/check.py,,\n"),
		)])
		.unwrap();

		assert!(ownership.owns("reviewer", "reviewer"));
		assert!(ownership.owns("reviewer.check", "reviewer"));
		assert!(!ownership.owns("other", "reviewer"));
		let Err(SiteError::TrustedLoad(error)) = ownership.require_owned("other", "reviewer") else {
			panic!("unowned module must produce E-TRUSTED-LOAD");
		};
		assert_eq!(error.code, super::ExtensionCode::ETrustedLoad);
	}

	#[test]
	fn materializing_same_manifest_is_a_noop_after_atomic_site_swap() {
		let directory = tempfile::tempdir().unwrap();
		let source = BlobStore::open(directory.path().join("blobs")).unwrap();
		let module = source.put(b"value = 1\n").unwrap();
		let record = source
			.put(b"reviewer/__init__.py,,\nreviewer-1.0.dist-info/RECORD,,\n")
			.unwrap();
		let materializer = SiteMaterializer::open(directory.path().join("ext"), source).unwrap();
		let request = v1::MaterializeSite {
			site_key: "workspace-sandboxed-reviewer".to_owned(),
			files: vec![
				omp_proto::env::v1::SiteFile {
					path:      "reviewer/__init__.py".to_owned(),
					blob_hash: Bytes::copy_from_slice(module.hash.as_bytes()),
					mode:      0,
				},
				omp_proto::env::v1::SiteFile {
					path:      "reviewer-1.0.dist-info/RECORD".to_owned(),
					blob_hash: Bytes::copy_from_slice(record.hash.as_bytes()),
					mode:      0,
				},
			],
			..v1::MaterializeSite::default()
		};

		let first = materializer.materialize(request.clone()).unwrap();
		let second = materializer.materialize(request).unwrap();

		assert_eq!(first.manifest_hash, second.manifest_hash);
		assert_eq!(first.unpacked, 2);
		assert_eq!(second.unpacked, 0);
		materializer
			.require_record_owner(
				"workspace-sandboxed-reviewer",
				"reviewer",
				"workspace-sandboxed-reviewer",
			)
			.unwrap();
		assert!(
			std::fs::read_link(
				directory
					.path()
					.join("ext/sites/workspace-sandboxed-reviewer")
			)
			.is_ok()
		);
	}
}
