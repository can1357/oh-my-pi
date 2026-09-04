//! User-wide, versioned document-conversion cache.
//!
//! Cache publication is atomic and request paths never evict. The environment
//! daemon owns calls to [`DocumentCache::collect`], which applies the size and
//! age policy and removes abandoned temporary files.

use std::{
	collections::{BTreeMap, HashSet},
	fs::{self, File, FileTimes},
	io,
	io::{Read as _, Write},
	path::{Path, PathBuf},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use omp_core::Hash32;
use serde_json::Value;
use thiserror::Error;

use crate::atomic;

const MAGIC: &[u8; 4] = b"ODC1";
const SCHEMA_VERSION: u32 = 1;
const HEADER_BYTES: usize = 4 + 4 + 8 + 8 + 1 + 32;
const TEMP_SUFFIX: &str = ".tmp";
const ENTRY_SUFFIX: &str = ".doc";

/// Default cache footprint: 256 MiB.
pub const DEFAULT_MAX_BYTES: u64 = 256 * 1024 * 1024;
/// Entries not accessed for this long are eligible for age eviction.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_hours(720);
/// Atomic-write temporaries older than this are treated as crash orphans.
pub const DEFAULT_ORPHAN_AGE: Duration = Duration::from_mins(5);

/// Content-addressed identity for one converter result.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct DocumentCacheKey(Hash32);

impl DocumentCacheKey {
	/// Derives a BLAKE3 key from the source digest, converter identity and
	/// recursively key-sorted JSON options.
	pub fn derive(
		source_digest: Hash32,
		converter: &str,
		converter_version: &str,
		options: &Value,
	) -> Result<Self, DocumentCacheError> {
		if converter.trim().is_empty() || converter_version.trim().is_empty() {
			return Err(DocumentCacheError::InvalidConverterIdentity);
		}
		let options = normalized_options(options);
		let mut hasher = Hash32::hasher();
		hasher
			.update(b"omp.document-cache.v1\0")
			.update(source_digest.as_bytes())
			.update(b"\0")
			.update(converter.trim().as_bytes())
			.update(b"\0")
			.update(converter_version.trim().as_bytes())
			.update(b"\0");
		serde_json::to_writer(&mut hasher, &options)?;
		Ok(Self(hasher.finalize()))
	}

	/// Returns the underlying BLAKE3 digest.
	pub const fn digest(self) -> Hash32 {
		self.0
	}

	fn file_name(self) -> String {
		let hex = self.0.to_hex();
		let mut name = String::with_capacity(hex.len() + ENTRY_SUFFIX.len());
		name.push_str(hex.as_str());
		name.push_str(ENTRY_SUFFIX);
		name
	}
}

/// Metadata recorded beside a cached conversion.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentCacheMetadata {
	/// Cache identity.
	pub key:         DocumentCacheKey,
	/// Initial publication time in Unix milliseconds.
	pub created_ms:  u64,
	/// Last successful cache access in Unix milliseconds.
	pub accessed_ms: u64,
	/// Converted payload size.
	pub content_len: u64,
	/// Content-addressed blob retained by this conversion, when one exists.
	pub blob:        Option<Hash32>,
}

/// One successfully decoded cache hit.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentCacheEntry {
	/// Persisted metadata.
	pub metadata: DocumentCacheMetadata,
	/// Exact converted bytes.
	pub content:  Bytes,
}

/// Daemon-owned collection policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DocumentCachePolicy {
	/// Maximum aggregate bytes retained after collection.
	pub max_bytes:      u64,
	/// Maximum idle age for an unprotected entry.
	pub max_age:        Duration,
	/// Maximum age of an abandoned atomic-write temporary.
	pub orphan_max_age: Duration,
}

impl Default for DocumentCachePolicy {
	fn default() -> Self {
		Self {
			max_bytes:      DEFAULT_MAX_BYTES,
			max_age:        DEFAULT_MAX_AGE,
			orphan_max_age: DEFAULT_ORPHAN_AGE,
		}
	}
}

/// Result of one bounded collection pass.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DocumentCacheGcReport {
	/// Valid entries examined.
	pub examined:        u64,
	/// Bytes represented by valid entries before eviction.
	pub examined_bytes:  u64,
	/// Entries removed by age or size policy.
	pub evicted:         u64,
	/// Bytes reclaimed from valid entries.
	pub reclaimed_bytes: u64,
	/// Abandoned temporary files removed.
	pub orphan_temps:    u64,
	/// Entries retained because their blob is reachable.
	pub protected:       u64,
}

/// Document-cache storage failure.
#[derive(Debug, Error)]
pub enum DocumentCacheError {
	/// Converter name or version is empty.
	#[error("document cache converter identity is empty")]
	InvalidConverterIdentity,
	/// Normalized option serialization failed.
	#[error(transparent)]
	Json(#[from] serde_json::Error),
	/// Atomic publication failed.
	#[error(transparent)]
	Atomic(#[from] atomic::Error),
	/// Filesystem access failed.
	#[error("document cache I/O failed for {path}")]
	Io {
		/// Affected path.
		path:   PathBuf,
		/// Underlying filesystem failure.
		#[source]
		source: io::Error,
	},
	/// A cache file has an invalid or unsupported envelope.
	#[error("document cache entry is corrupt at {path}")]
	Corrupt {
		/// Invalid entry path.
		path: PathBuf,
	},
	/// A supplied timestamp predates the Unix epoch.
	#[error("document cache timestamp predates the Unix epoch")]
	InvalidTimestamp,
}

/// Filesystem-backed conversion cache rooted at a user-wide cache directory.
#[derive(Clone, Debug)]
pub struct DocumentCache {
	root: PathBuf,
}

impl DocumentCache {
	/// Opens a cache rooted at `root`. The directory is created lazily on write.
	pub fn open(root: impl Into<PathBuf>) -> Self {
		Self { root: root.into() }
	}

	/// Returns the cache directory.
	pub fn root(&self) -> &Path {
		&self.root
	}

	/// Reads and validates one entry, accounting the successful access by mtime.
	/// Missing and corrupt entries are cache misses; corrupt files are removed.
	pub fn get(
		&self,
		key: DocumentCacheKey,
		accessed_at: SystemTime,
	) -> Result<Option<DocumentCacheEntry>, DocumentCacheError> {
		let path = self.entry_path(key);
		let mut file = match File::open(&path) {
			Ok(file) => file,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(source) => return Err(io_error(path, source)),
		};
		let metadata = file
			.metadata()
			.map_err(|source| io_error(path.clone(), source))?;
		let file_len = usize::try_from(metadata.len()).map_err(|_| corrupt(path.clone()))?;
		if file_len < HEADER_BYTES {
			remove_corrupt(&path);
			return Ok(None);
		}
		let mut bytes = Vec::with_capacity(file_len);
		file
			.read_to_end(&mut bytes)
			.map_err(|source| io_error(path.clone(), source))?;
		let (created_ms, content_len, blob) = if let Ok(header) = decode_header(&bytes, &path) {
			header
		} else {
			remove_corrupt(&path);
			return Ok(None);
		};
		let expected_len = HEADER_BYTES
			.checked_add(usize::try_from(content_len).map_err(|_| corrupt(path.clone()))?)
			.ok_or_else(|| corrupt(path.clone()))?;
		if bytes.len() != expected_len {
			remove_corrupt(&path);
			return Ok(None);
		}
		file
			.set_times(
				FileTimes::new()
					.set_accessed(accessed_at)
					.set_modified(accessed_at),
			)
			.map_err(|source| io_error(path, source))?;
		let accessed_ms = unix_millis(accessed_at)?;
		Ok(Some(DocumentCacheEntry {
			metadata: DocumentCacheMetadata { key, created_ms, accessed_ms, content_len, blob },
			content:  Bytes::from(bytes).slice(HEADER_BYTES..),
		}))
	}

	/// Atomically publishes one conversion. Existing identical keys are replaced
	/// as one filesystem rename, so readers observe either complete generation.
	pub fn put(
		&self,
		key: DocumentCacheKey,
		content: &[u8],
		created_at: SystemTime,
		blob: Option<Hash32>,
	) -> Result<DocumentCacheMetadata, DocumentCacheError> {
		fs::create_dir_all(&self.root).map_err(|source| io_error(self.root.clone(), source))?;
		let created_ms = unix_millis(created_at)?;
		let content_len = u64::try_from(content.len()).expect("usize fits in u64");
		let mut encoded = Vec::with_capacity(HEADER_BYTES + content.len());
		encode_header(&mut encoded, created_ms, content_len, blob);
		encoded.extend_from_slice(content);
		let path = self.entry_path(key);
		atomic::commit(&path, &encoded, || true)?;
		let file = File::open(&path).map_err(|source| io_error(path.clone(), source))?;
		file
			.set_times(
				FileTimes::new()
					.set_accessed(created_at)
					.set_modified(created_at),
			)
			.map_err(|source| io_error(path, source))?;
		Ok(DocumentCacheMetadata { key, created_ms, accessed_ms: created_ms, content_len, blob })
	}

	/// Applies bounded daemon GC. Entries whose recorded blob occurs in
	/// `reachable_blobs` are protected from age and size eviction.
	pub fn collect(
		&self,
		policy: DocumentCachePolicy,
		now: SystemTime,
		reachable_blobs: &HashSet<Hash32>,
	) -> Result<DocumentCacheGcReport, DocumentCacheError> {
		let mut report = DocumentCacheGcReport::default();
		let read_dir = match fs::read_dir(&self.root) {
			Ok(entries) => entries,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(report),
			Err(source) => return Err(io_error(self.root.clone(), source)),
		};
		let mut entries = Vec::new();
		for entry in read_dir {
			let entry = entry.map_err(|source| io_error(self.root.clone(), source))?;
			let path = entry.path();
			let metadata = match entry.metadata() {
				Ok(metadata) if metadata.is_file() => metadata,
				Ok(_) => continue,
				Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
				Err(source) => return Err(io_error(path, source)),
			};
			let modified = metadata.modified().unwrap_or(UNIX_EPOCH);
			let age = now.duration_since(modified).unwrap_or_default();
			let name = entry.file_name();
			let name = name.to_string_lossy();
			if name.ends_with(TEMP_SUFFIX) {
				if age > policy.orphan_max_age && fs::remove_file(&path).is_ok() {
					report.orphan_temps += 1;
				}
				continue;
			}
			let Some(key) = parse_entry_name(&name) else {
				continue;
			};
			let mut file = match File::open(&path) {
				Ok(file) => file,
				Err(source) if source.kind() == io::ErrorKind::NotFound => continue,
				Err(source) => return Err(io_error(path, source)),
			};
			let mut header = [0_u8; HEADER_BYTES];
			if file.read_exact(&mut header).is_err() {
				remove_corrupt(&path);
				continue;
			}
			let Ok((_, content_len, blob)) = decode_header(&header, &path) else {
				remove_corrupt(&path);
				continue;
			};
			let protected = blob.is_some_and(|digest| reachable_blobs.contains(&digest));
			report.examined += 1;
			report.examined_bytes = report.examined_bytes.saturating_add(metadata.len());
			if protected {
				report.protected += 1;
			}
			entries.push(GcEntry {
				path,
				key,
				bytes: metadata.len(),
				content_len,
				accessed: modified,
				protected,
			});
		}

		entries.sort_unstable_by(|left, right| {
			left
				.accessed
				.cmp(&right.accessed)
				.then_with(|| left.key.cmp(&right.key))
		});
		let mut retained_bytes = report.examined_bytes;
		for entry in &entries {
			let expired = now.duration_since(entry.accessed).unwrap_or_default() > policy.max_age;
			if entry.protected || (!expired && retained_bytes <= policy.max_bytes) {
				continue;
			}
			match fs::remove_file(&entry.path) {
				Ok(()) => {
					retained_bytes = retained_bytes.saturating_sub(entry.bytes);
					report.evicted += 1;
					report.reclaimed_bytes = report.reclaimed_bytes.saturating_add(entry.bytes);
				},
				Err(error) if error.kind() == io::ErrorKind::NotFound => {},
				Err(source) => return Err(io_error(entry.path.clone(), source)),
			}
		}
		Ok(report)
	}

	fn entry_path(&self, key: DocumentCacheKey) -> PathBuf {
		self.root.join(key.file_name())
	}
}

#[derive(Debug)]
struct GcEntry {
	path:        PathBuf,
	key:         DocumentCacheKey,
	bytes:       u64,
	#[allow(dead_code, reason = "validated envelope fact retained for diagnostics")]
	content_len: u64,
	accessed:    SystemTime,
	protected:   bool,
}

fn normalized_options(value: &Value) -> Value {
	match value {
		Value::Array(values) => Value::Array(values.iter().map(normalized_options).collect()),
		Value::Object(values) => Value::Object(
			values
				.iter()
				.map(|(key, value)| (key.clone(), normalized_options(value)))
				.collect::<BTreeMap<_, _>>()
				.into_iter()
				.collect(),
		),
		other => other.clone(),
	}
}

fn encode_header(output: &mut impl Write, created_ms: u64, len: u64, blob: Option<Hash32>) {
	output.write_all(MAGIC).expect("Vec writes do not fail");
	output
		.write_all(&SCHEMA_VERSION.to_le_bytes())
		.expect("Vec writes do not fail");
	output
		.write_all(&created_ms.to_le_bytes())
		.expect("Vec writes do not fail");
	output
		.write_all(&len.to_le_bytes())
		.expect("Vec writes do not fail");
	output
		.write_all(&[u8::from(blob.is_some())])
		.expect("Vec writes do not fail");
	output
		.write_all(blob.unwrap_or_default().as_bytes())
		.expect("Vec writes do not fail");
}

fn decode_header(
	bytes: &[u8],
	path: &Path,
) -> Result<(u64, u64, Option<Hash32>), DocumentCacheError> {
	if bytes.len() < HEADER_BYTES || &bytes[..4] != MAGIC {
		return Err(corrupt(path.to_path_buf()));
	}
	let version = u32::from_le_bytes(bytes[4..8].try_into().expect("fixed header"));
	if version != SCHEMA_VERSION {
		return Err(corrupt(path.to_path_buf()));
	}
	let created_ms = u64::from_le_bytes(bytes[8..16].try_into().expect("fixed header"));
	let content_len = u64::from_le_bytes(bytes[16..24].try_into().expect("fixed header"));
	let blob = match bytes[24] {
		0 => None,
		1 => Some(Hash32::new(bytes[25..57].try_into().expect("fixed header"))),
		_ => return Err(corrupt(path.to_path_buf())),
	};
	Ok((created_ms, content_len, blob))
}

fn parse_entry_name(name: &str) -> Option<DocumentCacheKey> {
	let digest = name.strip_suffix(ENTRY_SUFFIX)?.parse().ok()?;
	Some(DocumentCacheKey(digest))
}

fn unix_millis(time: SystemTime) -> Result<u64, DocumentCacheError> {
	let duration = time
		.duration_since(UNIX_EPOCH)
		.map_err(|_| DocumentCacheError::InvalidTimestamp)?;
	u64::try_from(duration.as_millis()).map_err(|_| DocumentCacheError::InvalidTimestamp)
}

const fn io_error(path: PathBuf, source: io::Error) -> DocumentCacheError {
	DocumentCacheError::Io { path, source }
}

const fn corrupt(path: PathBuf) -> DocumentCacheError {
	DocumentCacheError::Corrupt { path }
}

fn remove_corrupt(path: &Path) {
	let _ = fs::remove_file(path);
}

#[cfg(test)]
mod tests {
	use super::*;

	fn key(options: &Value) -> DocumentCacheKey {
		DocumentCacheKey::derive(Hash32::sum(b"source"), "markit", "1.2.3", options).unwrap()
	}

	#[test]
	fn key_is_sha256_and_normalizes_object_order() {
		let left = serde_json::json!({"page": 1, "nested": {"b": true, "a": false}});
		let right = serde_json::json!({"nested": {"a": false, "b": true}, "page": 1});
		assert_eq!(key(&left), key(&right));
		assert_ne!(
			key(&left),
			DocumentCacheKey::derive(Hash32::sum(b"other"), "markit", "1.2.3", &left).unwrap()
		);
	}

	#[test]
	fn document_cache_survives_restart_and_accounts_access() {
		let directory = tempfile::tempdir().unwrap();
		let cache_key = key(&serde_json::json!({"mode": "markdown"}));
		let created = UNIX_EPOCH + Duration::from_secs(100);
		DocumentCache::open(directory.path())
			.put(cache_key, b"converted", created, Some(Hash32::sum(b"blob")))
			.unwrap();
		let accessed = UNIX_EPOCH + Duration::from_secs(200);
		let hit = DocumentCache::open(directory.path())
			.get(cache_key, accessed)
			.unwrap()
			.expect("restart hit");
		assert_eq!(hit.content, Bytes::from_static(b"converted"));
		assert_eq!(hit.metadata.created_ms, 100_000);
		assert_eq!(hit.metadata.accessed_ms, 200_000);
	}

	#[test]
	fn document_cache_gc_evicts_oldest_and_protects_reachable_blob() {
		let directory = tempfile::tempdir().unwrap();
		let cache = DocumentCache::open(directory.path());
		let old = key(&serde_json::json!({"entry": "old"}));
		let protected = key(&serde_json::json!({"entry": "protected"}));
		let recent = key(&serde_json::json!({"entry": "recent"}));
		let blob = Hash32::sum(b"live");
		cache
			.put(old, b"old", UNIX_EPOCH + Duration::from_secs(10), None)
			.unwrap();
		cache
			.put(protected, b"protected", UNIX_EPOCH + Duration::from_secs(20), Some(blob))
			.unwrap();
		cache
			.put(recent, b"recent", UNIX_EPOCH + Duration::from_secs(30), None)
			.unwrap();
		let report = cache
			.collect(
				DocumentCachePolicy {
					max_bytes:      u64::try_from(
						HEADER_BYTES + b"protected".len() + HEADER_BYTES + b"recent".len(),
					)
					.unwrap(),
					max_age:        Duration::from_secs(1_000),
					orphan_max_age: Duration::ZERO,
				},
				UNIX_EPOCH + Duration::from_secs(40),
				&HashSet::from([blob]),
			)
			.unwrap();
		assert_eq!(report.evicted, 1);
		assert_eq!(report.protected, 1);
		assert!(
			cache
				.get(old, UNIX_EPOCH + Duration::from_secs(41))
				.unwrap()
				.is_none()
		);
		assert!(
			cache
				.get(protected, UNIX_EPOCH + Duration::from_secs(41))
				.unwrap()
				.is_some()
		);
		assert!(
			cache
				.get(recent, UNIX_EPOCH + Duration::from_secs(41))
				.unwrap()
				.is_some()
		);
	}
}
