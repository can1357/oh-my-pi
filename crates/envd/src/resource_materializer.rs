//! Environment-owned scoped resource materialization and lease cleanup.

use std::{
	collections::{BTreeSet, HashMap},
	fs::{self, OpenOptions},
	io::{self, Read as _, Write as _},
	path::{Component, Path, PathBuf},
	sync::{
		Arc, Weak,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use bytes::Bytes;
use omp_core::{Hash32, hash32::Hasher};
use omp_exec::capture_entries;
use omp_journal::blob::{BlobStore, Error};
use omp_proto::env::v1::{
	MaterializationLease, MaterializationReleased, MaterializeRequest, ReleaseMaterialization,
};
use parking_lot::Mutex;
use tokio::{task, time};
use url::Url;

const DEFAULT_MAX_BYTES: u64 = 64 * 1024 * 1024;
const CAPTURE_MAX_BYTES: u64 = 256 * 1024 * 1024;
const CAPTURE_BLOB_BYTES: u64 = 8 * 1024 * 1024;
const CAPTURE_MAX_PATHS: usize = 8192;
const DEFAULT_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_TTL: Duration = Duration::from_secs(60 * 60);

/// Scoped materialization failure.
#[derive(Debug, thiserror::Error)]
pub enum MaterializationError {
	/// The resource URI is malformed.
	#[error("materialization resource URI is invalid")]
	InvalidUri,
	/// This resource is logical rather than path-backed at the Environment.
	#[error("resource scheme is not path-backed by this Environment")]
	UnsupportedScheme,
	/// The resolved source escapes its granted root.
	#[error("materialization source is outside its Environment grant")]
	OutsideGrant,
	/// The resolved resource does not exist.
	#[error("materialization source does not exist")]
	NotFound,
	/// Symbolic links are rejected during recursive copy.
	#[error("materialization source contains a symbolic link")]
	SymbolicLink,
	/// The resource exceeds the caller's byte ceiling.
	#[error("materialization source exceeds the {limit}-byte ceiling")]
	TooLarge {
		/// Effective byte ceiling.
		limit: u64,
	},
	/// A filesystem operation failed.
	#[error("materialization filesystem operation failed")]
	Io(#[from] io::Error),
}

#[derive(Clone)]
pub(crate) struct ResourceMaterializer {
	inner: Arc<Inner>,
}

struct Inner {
	workspace_root: PathBuf,
	local_root:     PathBuf,
	lease_root:     PathBuf,
	blobs:          BlobStore,
	next_lease:     AtomicU64,
	leases:         Mutex<HashMap<Bytes, LeaseRecord>>,
}

struct LeaseRecord {
	path:                PathBuf,
	expires_at_ms:       u64,
	write_back:          Option<PathBuf>,
	write_back_complete: bool,
}

impl ResourceMaterializer {
	pub(crate) fn open(
		workspace_root: &Path,
		state_dir: &Path,
		local_root: &Path,
		blobs: BlobStore,
	) -> Result<Self, MaterializationError> {
		let workspace_root = fs::canonicalize(workspace_root)?;
		let local_root = local_root.to_path_buf();
		let lease_root = state_dir.join("materializations");
		private_directory(&local_root)?;
		private_directory(&lease_root)?;
		let local_root = fs::canonicalize(local_root)?;
		let lease_root = fs::canonicalize(lease_root)?;
		Ok(Self {
			inner: Arc::new(Inner {
				workspace_root,
				local_root,
				lease_root,
				blobs,
				next_lease: AtomicU64::new(1),
				leases: Mutex::new(HashMap::new()),
			}),
		})
	}

	pub(crate) async fn materialize(
		&self,
		request: MaterializeRequest,
	) -> Result<MaterializationLease, MaterializationError> {
		let inner = Arc::clone(&self.inner);
		let lease = task::spawn_blocking(move || inner.materialize(request))
			.await
			.map_err(|source| io::Error::other(source))??;
		self.schedule_cleanup(lease.lease_id.clone(), lease.expires_at_ms);
		Ok(lease)
	}

	pub(crate) async fn release(
		&self,
		request: ReleaseMaterialization,
	) -> Result<MaterializationReleased, MaterializationError> {
		let lease_id = request.lease_id;
		let inner = Arc::clone(&self.inner);
		let released = lease_id.clone();
		task::spawn_blocking(move || inner.release(&lease_id))
			.await
			.map_err(|source| io::Error::other(source))??;
		Ok(MaterializationReleased { lease_id: released })
	}

	fn schedule_cleanup(&self, lease_id: Bytes, expires_at_ms: u64) {
		let weak = Arc::downgrade(&self.inner);
		tokio::spawn(async move {
			let now = now_ms();
			if expires_at_ms > now {
				time::sleep(Duration::from_millis(expires_at_ms - now)).await;
			}
			let _ = task::spawn_blocking(move || cleanup_expired(weak, lease_id, expires_at_ms)).await;
		});
	}
}

impl Inner {
	fn captured_blob(
		&self,
		hash: Hash32,
		expected: Option<u64>,
	) -> Result<Vec<u8>, MaterializationError> {
		let path = self
			.blobs
			.path(&omp_journal::blob::BlobRef { hash, size: 0 });
		if fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
			return Err(MaterializationError::SymbolicLink);
		}
		let range = self
			.blobs
			.open_range(hash, 0, 0)
			.map_err(|error| match error {
				Error::NotFound => MaterializationError::NotFound,
				Error::Io(error) => MaterializationError::Io(error),
				_ => MaterializationError::InvalidUri,
			})?;
		let size = range.reference().size;
		if size > CAPTURE_BLOB_BYTES {
			return Err(MaterializationError::TooLarge { limit: CAPTURE_BLOB_BYTES });
		}
		if expected.is_some_and(|expected| expected != size) {
			return Err(MaterializationError::InvalidUri);
		}
		let mut bytes = Vec::new();
		range.into_file().take(size + 1).read_to_end(&mut bytes)?;
		let mut hasher = Hash32::hasher();
		hasher.update(&bytes);
		if bytes.len() as u64 != size || hasher.finalize() != hash {
			return Err(MaterializationError::InvalidUri);
		}
		Ok(bytes)
	}

	fn materialize_capture(
		&self,
		request: MaterializeRequest,
	) -> Result<MaterializationLease, MaterializationError> {
		let source = request
			.captured_inputs
			.ok_or(MaterializationError::InvalidUri)?;
		let hash = Hash32::new(
			source
				.manifest_hash
				.as_ref()
				.try_into()
				.map_err(|_| MaterializationError::InvalidUri)?,
		);
		let manifest = self.captured_blob(hash, Some(source.manifest_size))?;
		let entries = capture_entries(&manifest)?;
		if entries.len() > CAPTURE_MAX_PATHS {
			return Err(MaterializationError::TooLarge { limit: CAPTURE_MAX_PATHS as u64 });
		}
		let mut paths = BTreeSet::new();
		for entry in &entries {
			if entry.path.is_empty()
				|| entry.path.contains(['\\', ':'])
				|| entry
					.path
					.split('/')
					.any(|part| part.is_empty() || part == "." || part == "..")
				|| !matches!(entry.mode, 0o644 | 0o755)
				|| !paths.insert(entry.path.as_str())
			{
				return Err(MaterializationError::InvalidUri);
			}
		}
		for path in &paths {
			for (index, _) in path.match_indices('/') {
				if paths.contains(&path[..index]) {
					return Err(MaterializationError::InvalidUri);
				}
			}
		}
		let limit = if request.max_bytes == 0 {
			CAPTURE_MAX_BYTES
		} else {
			request.max_bytes.min(CAPTURE_MAX_BYTES)
		};
		let lease_id = self.new_lease_id();
		let lease_path = self
			.lease_root
			.join(omp_core::hex::encode(&lease_id).to_string());
		private_directory(&lease_path)?;
		let copied = (|| -> Result<u64, MaterializationError> {
			let source_root = lease_path.join("src");
			private_directory(&source_root)?;
			private_directory(&lease_path.join("out"))?;
			private_directory(&lease_path.join("tmp"))?;
			let mut size = 0u64;
			for entry in entries {
				let bytes = self.captured_blob(entry.hash, None)?;
				size = size
					.checked_add(bytes.len() as u64)
					.ok_or(MaterializationError::TooLarge { limit })?;
				if size > limit {
					return Err(MaterializationError::TooLarge { limit });
				}
				let destination = source_root.join(&entry.path);
				let parent = destination
					.parent()
					.ok_or(MaterializationError::InvalidUri)?;
				// Every directory remains private, including intermediate parents.
				let mut current = source_root.clone();
				for part in parent
					.strip_prefix(&source_root)
					.map_err(|_| MaterializationError::InvalidUri)?
					.components()
				{
					current.push(part);
					private_directory(&current)?;
				}
				let mut file = OpenOptions::new()
					.write(true)
					.create_new(true)
					.open(&destination)?;
				private_file(&destination)?;
				file.write_all(&bytes)?;
				file.sync_all()?;
				#[cfg(unix)]
				{
					use std::os::unix::fs::PermissionsExt as _;
					file.set_permissions(fs::Permissions::from_mode(if entry.executable {
						0o500
					} else {
						0o400
					}))?;
				}
				#[cfg(not(unix))]
				{
					let mut permissions = file.metadata()?.permissions();
					permissions.set_readonly(true);
					file.set_permissions(permissions)?;
				}
			}
			Ok(size)
		})();
		let size = match copied {
			Ok(size) => size,
			Err(error) => {
				let _ = fs::remove_dir_all(&lease_path);
				return Err(error);
			},
		};
		let ttl = if request.ttl_ms == 0 {
			DEFAULT_TTL
		} else {
			Duration::from_millis(request.ttl_ms).min(MAX_TTL)
		};
		let expires_at_ms = now_ms().saturating_add(ttl.as_millis().try_into().unwrap_or(u64::MAX));
		let environment_uri = Url::from_directory_path(&lease_path)
			.map_err(|()| MaterializationError::InvalidUri)?
			.to_string();
		self.leases.lock().insert(lease_id.clone(), LeaseRecord {
			path: lease_path,
			expires_at_ms,
			write_back: None,
			write_back_complete: false,
		});
		Ok(MaterializationLease {
			lease_id,
			environment_uri,
			expires_at_ms,
			size,
			content_hash: Bytes::copy_from_slice(hash.as_bytes()),
		})
	}

	fn materialize(
		&self,
		request: MaterializeRequest,
	) -> Result<MaterializationLease, MaterializationError> {
		self.reap_expired()?;
		if request.captured_inputs.is_some() {
			if !request.resource_uri.is_empty() {
				return Err(MaterializationError::InvalidUri);
			}
			return self.materialize_capture(request);
		}
		let mutable_local = request.resource_uri.starts_with("local://");
		let source = self.resolve_source(&request.resource_uri, mutable_local)?;
		let metadata = fs::symlink_metadata(&source).map_err(|error| {
			if error.kind() == io::ErrorKind::NotFound {
				MaterializationError::NotFound
			} else {
				MaterializationError::Io(error)
			}
		})?;
		if metadata.file_type().is_symlink() {
			return Err(MaterializationError::SymbolicLink);
		}

		let lease_id = self.new_lease_id();
		let lease_name = omp_core::hex::encode(&lease_id).to_string();
		let lease_path = self.lease_root.join(lease_name);
		private_directory(&lease_path)?;
		let destination = lease_path.join("resource");
		let limit = if request.max_bytes == 0 {
			DEFAULT_MAX_BYTES
		} else {
			request.max_bytes.min(DEFAULT_MAX_BYTES)
		};
		let copied = copy_resource(&source, &destination, limit);
		let (size, content_hash) = match copied {
			Ok(copied) => copied,
			Err(error) => {
				let _ = fs::remove_dir_all(&lease_path);
				return Err(error);
			},
		};
		let ttl = if request.ttl_ms == 0 {
			DEFAULT_TTL
		} else {
			Duration::from_millis(request.ttl_ms).min(MAX_TTL)
		};
		let expires_at_ms = now_ms().saturating_add(ttl.as_millis().try_into().unwrap_or(u64::MAX));
		let environment_uri = if metadata.is_dir() {
			Url::from_directory_path(&destination)
		} else {
			Url::from_file_path(&destination)
		}
		.map_err(|()| MaterializationError::InvalidUri)?
		.to_string();
		self.leases.lock().insert(lease_id.clone(), LeaseRecord {
			path: lease_path,
			expires_at_ms,
			write_back: mutable_local.then_some(source),
			write_back_complete: false,
		});
		Ok(MaterializationLease {
			lease_id,
			environment_uri,
			expires_at_ms,
			size,
			content_hash: Bytes::copy_from_slice(content_hash.as_bytes()),
		})
	}

	fn release(&self, lease_id: &[u8]) -> Result<(), MaterializationError> {
		let mut leases = self.leases.lock();
		if let Some(record) = leases.get_mut(lease_id) {
			finalize_record(record)?;
			leases.remove(lease_id);
		}
		Ok(())
	}

	fn reap_expired(&self) -> Result<(), MaterializationError> {
		let now = now_ms();
		let mut leases = self.leases.lock();
		let expired = leases
			.iter()
			.filter(|(_, lease)| lease.expires_at_ms <= now)
			.map(|(id, _)| id.clone())
			.collect::<Vec<_>>();
		for id in expired {
			if let Some(record) = leases.get_mut(&id) {
				finalize_record(record)?;
				leases.remove(&id);
			}
		}
		Ok(())
	}

	fn resolve_source(
		&self,
		resource_uri: &str,
		create_local: bool,
	) -> Result<PathBuf, MaterializationError> {
		let (candidate, grant) = if let Some(resource) = resource_uri.strip_prefix("local://") {
			let candidate = safe_relative(&self.local_root, resource)?;
			if create_local && !candidate.exists() {
				let parent = candidate.parent().ok_or(MaterializationError::InvalidUri)?;
				fs::create_dir_all(parent)?;
				let canonical_parent = fs::canonicalize(parent)?;
				if !canonical_parent.starts_with(&self.local_root) {
					return Err(MaterializationError::OutsideGrant);
				}
				OpenOptions::new()
					.write(true)
					.create_new(true)
					.open(&candidate)?;
				private_file(&candidate)?;
			}
			(candidate, &self.local_root)
		} else {
			let url = Url::parse(resource_uri).map_err(|_| MaterializationError::InvalidUri)?;
			if url.scheme() != "file" {
				return Err(MaterializationError::UnsupportedScheme);
			}
			(
				url.to_file_path()
					.map_err(|()| MaterializationError::InvalidUri)?,
				&self.workspace_root,
			)
		};
		let canonical = fs::canonicalize(candidate).map_err(|error| {
			if error.kind() == io::ErrorKind::NotFound {
				MaterializationError::NotFound
			} else {
				MaterializationError::Io(error)
			}
		})?;
		if !canonical.starts_with(grant) {
			return Err(MaterializationError::OutsideGrant);
		}
		Ok(canonical)
	}

	fn new_lease_id(&self) -> Bytes {
		let sequence = self.next_lease.fetch_add(1, Ordering::Relaxed);
		let now = SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_nanos();
		let mut id = [0_u8; 24];
		id[..16].copy_from_slice(&now.to_be_bytes());
		id[16..].copy_from_slice(&sequence.to_be_bytes());
		Bytes::copy_from_slice(&id)
	}
}

impl Drop for Inner {
	fn drop(&mut self) {
		let leases = self.leases.get_mut();
		for (_, mut lease) in leases.drain() {
			let _ = finalize_record(&mut lease);
		}
	}
}

fn cleanup_expired(weak: Weak<Inner>, lease_id: Bytes, expires_at_ms: u64) {
	let Some(inner) = weak.upgrade() else { return };
	let mut leases = inner.leases.lock();
	if let Some(record) = leases
		.get_mut(&lease_id)
		.filter(|lease| lease.expires_at_ms == expires_at_ms)
		&& finalize_record(record).is_ok()
	{
		leases.remove(&lease_id);
	}
}

fn safe_relative(root: &Path, resource: &str) -> Result<PathBuf, MaterializationError> {
	let resource = resource.trim_start_matches('/');
	if resource.is_empty() || resource.contains('\\') {
		return Err(MaterializationError::InvalidUri);
	}
	let relative = Path::new(resource);
	if relative
		.components()
		.any(|component| !matches!(component, Component::Normal(_)))
	{
		return Err(MaterializationError::OutsideGrant);
	}
	Ok(root.join(relative))
}

fn copy_resource(
	source: &Path,
	destination: &Path,
	limit: u64,
) -> Result<(u64, Hash32), MaterializationError> {
	let mut hasher = Hash32::hasher();
	let mut size = 0_u64;
	copy_entry(source, destination, source, limit, &mut size, &mut hasher)?;
	Ok((size, hasher.finalize()))
}

fn copy_entry(
	source: &Path,
	destination: &Path,
	root: &Path,
	limit: u64,
	size: &mut u64,
	hasher: &mut Hasher,
) -> Result<(), MaterializationError> {
	let metadata = fs::symlink_metadata(source)?;
	if metadata.file_type().is_symlink() {
		return Err(MaterializationError::SymbolicLink);
	}
	let relative = source.strip_prefix(root).unwrap_or(Path::new(""));
	hasher.update(relative.as_os_str().as_encoded_bytes());
	if metadata.is_dir() {
		private_directory(destination)?;
		let mut entries = fs::read_dir(source)?.collect::<Result<Vec<_>, _>>()?;
		entries.sort_unstable_by_key(fs::DirEntry::file_name);
		for entry in entries {
			copy_entry(
				&entry.path(),
				&destination.join(entry.file_name()),
				root,
				limit,
				size,
				hasher,
			)?;
		}
		return Ok(());
	}
	if !metadata.is_file() {
		return Err(MaterializationError::InvalidUri);
	}
	let next = size.saturating_add(metadata.len());
	if next > limit {
		return Err(MaterializationError::TooLarge { limit });
	}
	let mut input = fs::File::open(source)?;
	let mut output = fs::File::create(destination)?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		output.set_permissions(fs::Permissions::from_mode(0o600))?;
	}
	let mut buffer = [0_u8; 64 * 1024];
	loop {
		let read = input.read(&mut buffer)?;
		if read == 0 {
			break;
		}
		output.write_all(&buffer[..read])?;
		hasher.update(&buffer[..read]);
	}
	*size = next;
	Ok(())
}

fn write_back_local(
	source: &Path,
	target: &Path,
	lease_path: &Path,
) -> Result<(), MaterializationError> {
	let parent = target.parent().ok_or(MaterializationError::InvalidUri)?;
	private_directory(parent)?;
	let target_name = target
		.file_name()
		.ok_or(MaterializationError::InvalidUri)?
		.to_string_lossy();
	let lease_name = lease_path
		.file_name()
		.ok_or(MaterializationError::InvalidUri)?
		.to_string_lossy();
	let staged = parent.join(format!(".{target_name}.omp-writeback-{lease_name}"));
	let backup = parent.join(format!(".{target_name}.omp-backup-{lease_name}"));
	remove_entry(&staged)?;
	let mut size = 0;
	let mut hasher = Hash32::hasher();
	copy_entry(source, &staged, source, DEFAULT_MAX_BYTES, &mut size, &mut hasher)?;

	let target_exists = fs::symlink_metadata(target).is_ok();
	if target_exists {
		remove_entry(&backup)?;
		fs::rename(target, &backup)?;
	}
	if let Err(error) = fs::rename(&staged, target) {
		if target_exists {
			let _ = fs::rename(&backup, target);
		}
		let _ = remove_entry(&staged);
		return Err(error.into());
	}
	remove_entry(&backup)?;
	Ok(())
}

fn finalize_record(record: &mut LeaseRecord) -> Result<(), MaterializationError> {
	if !record.write_back_complete {
		if let Some(target) = &record.write_back {
			write_back_local(&record.path.join("resource"), target, &record.path)?;
		}
		record.write_back_complete = true;
	}
	remove_lease_path(&record.path)
}

fn remove_entry(path: &Path) -> Result<(), MaterializationError> {
	let metadata = match fs::symlink_metadata(path) {
		Ok(metadata) => metadata,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(error.into()),
	};
	if metadata.is_dir() && !metadata.file_type().is_symlink() {
		fs::remove_dir_all(path)?;
	} else {
		fs::remove_file(path)?;
	}
	Ok(())
}

fn private_file(path: &Path) -> io::Result<()> {
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
	}
	Ok(())
}

fn private_directory(path: &Path) -> io::Result<()> {
	fs::create_dir_all(path)?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
	}
	Ok(())
}

fn remove_lease_path(path: &Path) -> Result<(), MaterializationError> {
	match fs::remove_dir_all(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error.into()),
	}
}

fn now_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.unwrap_or_default()
		.as_millis()
		.try_into()
		.unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
	use omp_proto::env::v1::CapturedInputsSource;

	use super::*;

	fn capture_request(blobs: &BlobStore, entries: &[(&str, u32, Hash32)]) -> MaterializeRequest {
		let mut manifest = b"OMPWS2\0\0\0\0\0".to_vec();
		for (path, mode, hash) in entries {
			manifest.extend_from_slice(&(path.len() as u32).to_be_bytes());
			manifest.extend_from_slice(path.as_bytes());
			manifest.extend_from_slice(&mode.to_be_bytes());
			manifest.extend_from_slice(hash.as_bytes());
		}
		let reference = blobs.put(&manifest).unwrap();
		MaterializeRequest {
			captured_inputs: Some(CapturedInputsSource {
				manifest_hash: Bytes::copy_from_slice(reference.hash.as_bytes()),
				manifest_size: reference.size,
			}),
			ttl_ms: 60_000,
			..Default::default()
		}
	}

	#[tokio::test]
	async fn captured_source_is_frozen_private_and_never_written_back() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let blobs = BlobStore::open(state.path().join("cas")).unwrap();
		let source = blobs.put(b"captured").unwrap();
		fs::write(workspace.path().join("file"), b"live changed").unwrap();
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			blobs.clone(),
		)
		.unwrap();
		let request = capture_request(&blobs, &[("nested/file", 0o755, source.hash)]);
		let expected_hash = request
			.captured_inputs
			.as_ref()
			.unwrap()
			.manifest_hash
			.clone();
		let lease = materializer.materialize(request).await.unwrap();
		let root = Url::parse(&lease.environment_uri)
			.unwrap()
			.to_file_path()
			.unwrap();
		assert_eq!(fs::read(root.join("src/nested/file")).unwrap(), b"captured");
		assert_eq!(fs::read_dir(root.join("src")).unwrap().count(), 1);
		assert!(root.join("out").is_dir() && root.join("tmp").is_dir());
		assert_eq!(lease.size, 8);
		assert_eq!(lease.content_hash, expected_hash);
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;
			assert_eq!(
				fs::metadata(root.join("src/nested/file"))
					.unwrap()
					.permissions()
					.mode() & 0o777,
				0o500
			);
			assert_eq!(
				fs::metadata(root.join("src/nested"))
					.unwrap()
					.permissions()
					.mode() & 0o777,
				0o700
			);
		}
		fs::write(root.join("out/result"), b"scratch").unwrap();
		materializer
			.release(ReleaseMaterialization { lease_id: lease.lease_id, ..Default::default() })
			.await
			.unwrap();
		assert!(!root.exists());
		assert_eq!(fs::read(workspace.path().join("file")).unwrap(), b"live changed");
	}

	#[tokio::test]
	async fn captured_source_rejects_unsafe_paths_modes_and_conflicting_sources() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let blobs = BlobStore::open(state.path().join("cas")).unwrap();
		let hash = blobs.put(b"a").unwrap().hash;
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			blobs.clone(),
		)
		.unwrap();
		for path in
			["", "/abs", "../escape", "a/../b", "a//b", "a/./b", "a\\b", "C:file", "trailing/"]
		{
			assert!(
				materializer
					.materialize(capture_request(&blobs, &[(path, 0o644, hash)]))
					.await
					.is_err(),
				"{path:?}"
			);
		}
		for entries in [
			vec![("a", 0o644, hash), ("a", 0o644, hash)],
			vec![("a/b", 0o644, hash), ("a", 0o644, hash)],
			vec![("link", 0o120777, hash)],
		] {
			assert!(
				materializer
					.materialize(capture_request(&blobs, &entries))
					.await
					.is_err()
			);
		}
		let mut request = capture_request(&blobs, &[("a", 0o644, hash)]);
		request.resource_uri = String::from("local://other");
		assert!(materializer.materialize(request).await.is_err());
		assert_eq!(
			fs::read_dir(state.path().join("materializations"))
				.unwrap()
				.count(),
			0
		);
	}

	#[tokio::test]
	async fn captured_source_verifies_manifest_children_and_limits_before_publishing() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let blobs = BlobStore::open(state.path().join("cas")).unwrap();
		let source = blobs.put(b"original").unwrap();
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			blobs.clone(),
		)
		.unwrap();
		let mut request = capture_request(&blobs, &[("a", 0o644, source.hash)]);
		request.captured_inputs.as_mut().unwrap().manifest_size += 1;
		assert!(materializer.materialize(request).await.is_err());
		let mut request = capture_request(&blobs, &[("a", 0o644, source.hash)]);
		request.max_bytes = 1;
		assert!(matches!(
			materializer.materialize(request).await,
			Err(MaterializationError::TooLarge { limit: 1 })
		));
		let missing = Hash32::new([42; 32]);
		assert!(matches!(
			materializer
				.materialize(capture_request(&blobs, &[("a", 0o644, missing)]))
				.await,
			Err(MaterializationError::NotFound)
		));
		fs::write(blobs.path(&source), b"tampered").unwrap();
		assert!(
			materializer
				.materialize(capture_request(&blobs, &[("a", 0o644, source.hash)]))
				.await
				.is_err()
		);
		let mut request = capture_request(&blobs, &[]);
		let manifest = request.captured_inputs.as_ref().unwrap();
		let hash = Hash32::new(manifest.manifest_hash.as_ref().try_into().unwrap());
		fs::write(
			blobs.path(&omp_journal::blob::BlobRef { hash, size: manifest.manifest_size }),
			b"corrupt",
		)
		.unwrap();
		assert!(materializer.materialize(request.clone()).await.is_err());
		request.captured_inputs.as_mut().unwrap().manifest_hash = Bytes::new();
		assert!(materializer.materialize(request).await.is_err());
		let names = (0..=CAPTURE_MAX_PATHS)
			.map(|index| index.to_string())
			.collect::<Vec<_>>();
		let entries = names
			.iter()
			.map(|name| (name.as_str(), 0o644, source.hash))
			.collect::<Vec<_>>();
		assert!(
			materializer
				.materialize(capture_request(&blobs, &entries))
				.await
				.is_err()
		);
		let oversized = blobs.put(b"oversized").unwrap();
		OpenOptions::new()
			.write(true)
			.open(blobs.path(&oversized))
			.unwrap()
			.set_len(CAPTURE_BLOB_BYTES + 1)
			.unwrap();
		assert!(matches!(
			materializer
				.materialize(capture_request(&blobs, &[("large", 0o644, oversized.hash)]))
				.await,
			Err(MaterializationError::TooLarge { limit: CAPTURE_BLOB_BYTES })
		));
		assert_eq!(
			fs::read_dir(state.path().join("materializations"))
				.unwrap()
				.count(),
			0
		);
	}

	#[tokio::test]
	async fn captured_lease_expiry_cleans_the_run_root() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let blobs = BlobStore::open(state.path().join("cas")).unwrap();
		let hash = blobs.put(b"a").unwrap().hash;
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			blobs.clone(),
		)
		.unwrap();
		let lease = materializer
			.materialize(capture_request(&blobs, &[("a", 0o644, hash)]))
			.await
			.unwrap();
		let root = Url::parse(&lease.environment_uri)
			.unwrap()
			.to_file_path()
			.unwrap();
		materializer
			.inner
			.leases
			.lock()
			.get_mut(&lease.lease_id)
			.unwrap()
			.expires_at_ms = 0;
		materializer.inner.reap_expired().unwrap();
		assert!(!root.exists());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn captured_source_rejects_a_symlink_in_the_blob_store() {
		use std::os::unix::fs::symlink;

		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let blobs = BlobStore::open(state.path().join("cas")).unwrap();
		let source = blobs.put(b"captured").unwrap();
		let original = blobs.path(&source);
		let target = state.path().join("target");
		fs::rename(&original, &target).unwrap();
		symlink(&target, &original).unwrap();
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			blobs.clone(),
		)
		.unwrap();
		assert!(matches!(
			materializer
				.materialize(capture_request(&blobs, &[("a", 0o644, source.hash)]))
				.await,
			Err(MaterializationError::SymbolicLink)
		));
		assert_eq!(
			fs::read_dir(state.path().join("materializations"))
				.unwrap()
				.count(),
			0
		);
	}

	#[tokio::test]
	async fn lease_materializes_inside_scratch_and_release_is_idempotent() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let source = workspace.path().join("input.txt");
		fs::write(&source, b"materialized").unwrap();
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			BlobStore::open(state.path().join("cas")).unwrap(),
		)
		.unwrap();
		let lease = materializer
			.materialize(MaterializeRequest {
				resource_uri: Url::from_file_path(&source).unwrap().to_string(),
				max_bytes: 64,
				ttl_ms: 60_000,
				..Default::default()
			})
			.await
			.unwrap();
		let environment_path = Url::parse(&lease.environment_uri)
			.unwrap()
			.to_file_path()
			.unwrap();
		assert!(
			environment_path
				.starts_with(std::fs::canonicalize(state.path().join("materializations")).unwrap(),)
		);
		assert_eq!(fs::read(&environment_path).unwrap(), b"materialized");
		let release =
			ReleaseMaterialization { lease_id: lease.lease_id.clone(), ..Default::default() };
		materializer.release(release.clone()).await.unwrap();
		assert!(!environment_path.exists());
		materializer.release(release).await.unwrap();
	}

	#[tokio::test]
	async fn mutable_local_parent_is_authorized_then_written_back_on_release() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			BlobStore::open(state.path().join("cas")).unwrap(),
		)
		.unwrap();
		let lease = materializer
			.materialize(MaterializeRequest {
				resource_uri: String::from("local://nested/result.txt"),
				max_bytes: 64,
				ttl_ms: 60_000,
				..Default::default()
			})
			.await
			.unwrap();
		let environment_path = Url::parse(&lease.environment_uri)
			.unwrap()
			.to_file_path()
			.unwrap();
		fs::write(&environment_path, b"changed").unwrap();
		materializer
			.release(ReleaseMaterialization { lease_id: lease.lease_id, ..Default::default() })
			.await
			.unwrap();
		assert_eq!(fs::read(state.path().join("local/nested/result.txt")).unwrap(), b"changed");
	}

	#[tokio::test]
	async fn mutable_local_directory_writeback_replaces_the_exact_tree() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let local_root = state.path().join("sessions/test/local");
		fs::create_dir_all(local_root.join("tree/kind")).unwrap();
		fs::write(local_root.join("tree/deleted.txt"), b"remove me").unwrap();
		fs::write(local_root.join("tree/kind/old.txt"), b"directory").unwrap();
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&local_root,
			BlobStore::open(state.path().join("cas")).unwrap(),
		)
		.unwrap();
		let lease = materializer
			.materialize(MaterializeRequest {
				resource_uri: String::from("local://tree"),
				max_bytes: 1024,
				ttl_ms: 60_000,
				..Default::default()
			})
			.await
			.unwrap();
		let materialized = Url::parse(&lease.environment_uri)
			.unwrap()
			.to_file_path()
			.unwrap();
		fs::remove_file(materialized.join("deleted.txt")).unwrap();
		fs::remove_dir_all(materialized.join("kind")).unwrap();
		fs::write(materialized.join("kind"), b"file now").unwrap();
		fs::write(materialized.join("renamed.txt"), b"new").unwrap();

		materializer
			.release(ReleaseMaterialization { lease_id: lease.lease_id, ..Default::default() })
			.await
			.unwrap();

		assert!(!local_root.join("tree/deleted.txt").exists());
		assert_eq!(fs::read(local_root.join("tree/kind")).unwrap(), b"file now");
		assert_eq!(fs::read(local_root.join("tree/renamed.txt")).unwrap(), b"new");
	}

	#[tokio::test]
	async fn containment_rejects_workspace_escape_and_cleans_failed_lease() {
		let workspace = tempfile::tempdir().unwrap();
		let state = tempfile::tempdir().unwrap();
		let outside = tempfile::NamedTempFile::new().unwrap();
		let materializer = ResourceMaterializer::open(
			workspace.path(),
			state.path(),
			&state.path().join("local"),
			BlobStore::open(state.path().join("cas")).unwrap(),
		)
		.unwrap();
		let error = materializer
			.materialize(MaterializeRequest {
				resource_uri: Url::from_file_path(outside.path()).unwrap().to_string(),
				max_bytes: 64,
				..Default::default()
			})
			.await
			.unwrap_err();
		assert!(matches!(error, MaterializationError::OutsideGrant));
		assert_eq!(
			fs::read_dir(state.path().join("materializations"))
				.unwrap()
				.count(),
			0
		);
	}
}
