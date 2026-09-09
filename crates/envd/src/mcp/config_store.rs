//! Single-writer native MCP configuration store.

use std::{
	fs::{self, File, OpenOptions},
	io::{self, Write as _},
	path::{Path, PathBuf},
	sync::Arc,
	thread,
	time::{Duration, Instant},
};

use omp_core::Str;

use super::config::{self, MCP_CONFIG_SCHEMA_URL, McpConfigFile, McpServerConfig};

const LOCK_WAIT: Duration = Duration::from_secs(10);
const LOCK_RETRY: Duration = Duration::from_millis(10);

/// Native MCP config store with cross-process directory locking and atomic
/// replacement.
#[derive(Clone)]
pub struct McpConfigStore {
	path:       PathBuf,
	invalidate: Option<Arc<dyn Fn(&Path) + Send + Sync>>,
}

impl McpConfigStore {
	/// Creates a store for one OMP-owned configuration path.
	pub fn new(path: PathBuf) -> Self {
		Self { path, invalidate: None }
	}

	/// Adds discovery-cache invalidation after each committed replacement.
	pub fn with_invalidator(mut self, invalidate: Arc<dyn Fn(&Path) + Send + Sync>) -> Self {
		self.invalidate = Some(invalidate);
		self
	}

	/// Returns the owned file path.
	pub fn path(&self) -> &Path {
		&self.path
	}

	/// Reads and validates the current file. A missing file is an empty
	/// document.
	pub fn read(&self) -> Result<McpConfigFile, ConfigStoreError> {
		read_file(&self.path)
	}

	/// Atomically replaces the complete document under the directory lock.
	pub fn write(&self, file: &McpConfigFile) -> Result<(), ConfigStoreError> {
		let _lock = DirectoryLock::acquire(&self.path)?;
		self.write_unlocked(file)
	}

	/// Atomically migrates a legacy configuration into this store without
	/// overwriting an existing destination.
	///
	/// Returns `true` only when the validated legacy document was committed
	/// and the legacy file was removed.
	pub fn migrate_from(&self, legacy_path: &Path) -> Result<bool, ConfigStoreError> {
		if legacy_path == self.path {
			return Ok(false);
		}
		let _lock = DirectoryLock::acquire(&self.path)?;
		if self
			.path
			.try_exists()
			.map_err(|source| ConfigStoreError::Io { path: self.path.clone(), source })?
		{
			return Ok(false);
		}
		let metadata = match fs::symlink_metadata(legacy_path) {
			Ok(metadata) => metadata,
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
			Err(source) => {
				return Err(ConfigStoreError::Io { path: legacy_path.to_path_buf(), source });
			},
		};
		if !metadata.is_file() || metadata.file_type().is_symlink() {
			return Ok(false);
		}
		let legacy = fs::read(legacy_path)
			.map_err(|source| ConfigStoreError::Io { path: legacy_path.to_path_buf(), source })?;
		let file: McpConfigFile = serde_json::from_slice(&legacy)
			.map_err(|source| ConfigStoreError::Json { path: legacy_path.to_path_buf(), source })?;
		validate_file(legacy_path, &file)?;
		self.write_unlocked(&file)?;
		fs::remove_file(legacy_path)
			.map_err(|source| ConfigStoreError::Io { path: legacy_path.to_path_buf(), source })?;
		Ok(true)
	}

	/// Adds a server and rejects duplicate names.
	pub fn add(&self, name: &str, server: McpServerConfig) -> Result<(), ConfigStoreError> {
		validate_name(&self.path, name)?;
		validate_server(&self.path, name, &server)?;
		self.mutate(|file| {
			if file.mcp_servers.contains_key(name) {
				return Err(ConfigStoreError::AlreadyExists {
					name: Str::from(name),
					path: self.path.clone(),
				});
			}
			file.mcp_servers.insert(Str::from(name), server);
			Ok(())
		})
	}

	/// Inserts or replaces a validated server.
	pub fn update(&self, name: &str, server: McpServerConfig) -> Result<(), ConfigStoreError> {
		validate_name(&self.path, name)?;
		validate_server(&self.path, name, &server)?;
		self.mutate(|file| {
			file.mcp_servers.insert(Str::from(name), server);
			Ok(())
		})
	}

	/// Removes an existing server.
	pub fn remove(&self, name: &str) -> Result<(), ConfigStoreError> {
		self.mutate(|file| {
			if file.mcp_servers.remove(name).is_none() {
				return Err(ConfigStoreError::NotFound {
					name: Str::from(name),
					path: self.path.clone(),
				});
			}
			Ok(())
		})
	}

	/// Returns one server declaration.
	pub fn get(&self, name: &str) -> Result<Option<McpServerConfig>, ConfigStoreError> {
		Ok(self.read()?.mcp_servers.get(name).cloned())
	}

	/// Lists server names in deterministic order.
	pub fn list(&self) -> Result<Vec<Str>, ConfigStoreError> {
		Ok(self.read()?.mcp_servers.into_keys().collect())
	}

	/// Adds or removes a user-level denylist entry.
	pub fn set_disabled(&self, name: &str, disabled: bool) -> Result<(), ConfigStoreError> {
		validate_name(&self.path, name)?;
		self.mutate(|file| {
			if disabled {
				file.disabled_servers.insert(Str::from(name));
			} else {
				file.disabled_servers.remove(name);
			}
			Ok(())
		})
	}

	/// Adds or removes a user-level force-enable entry.
	pub fn set_force_enabled(&self, name: &str, enabled: bool) -> Result<(), ConfigStoreError> {
		validate_name(&self.path, name)?;
		self.mutate(|file| {
			if enabled {
				file.enabled_servers.insert(Str::from(name));
			} else {
				file.enabled_servers.remove(name);
			}
			Ok(())
		})
	}

	fn set_enable_overrides(
		&self,
		name: &str,
		disabled: bool,
		force_enabled: bool,
	) -> Result<(), ConfigStoreError> {
		validate_name(&self.path, name)?;
		self.mutate(|file| {
			if disabled {
				file.disabled_servers.insert(Str::from(name));
			} else {
				file.disabled_servers.remove(name);
			}
			if force_enabled {
				file.enabled_servers.insert(Str::from(name));
			} else {
				file.enabled_servers.remove(name);
			}
			Ok(())
		})
	}

	fn mutate(
		&self,
		change: impl FnOnce(&mut McpConfigFile) -> Result<(), ConfigStoreError>,
	) -> Result<(), ConfigStoreError> {
		let _lock = DirectoryLock::acquire(&self.path)?;
		let mut file = read_file(&self.path)?;
		change(&mut file)?;
		self.write_unlocked(&file)
	}

	fn write_unlocked(&self, file: &McpConfigFile) -> Result<(), ConfigStoreError> {
		validate_file(&self.path, file)?;
		write_atomic(&self.path, file, |_| Ok(()))?;
		if let Some(invalidate) = &self.invalidate {
			invalidate(&self.path);
		}
		Ok(())
	}
}

/// Flips one server across writable sources while maintaining reciprocal user
/// denylist/allowlist cleanup.
///
/// Native project, user, and root fallback documents are checked in the same
/// order as [`config::resolve_sources`].
pub fn set_server_enabled(
	user: &McpConfigStore,
	project: &McpConfigStore,
	root: Option<&McpConfigStore>,
	name: &str,
	enabled: bool,
) -> Result<(), ConfigStoreError> {
	validate_name(user.path(), name)?;
	let mut updated = update_enabled_if_present(project, name, enabled)?;
	if !updated {
		updated = update_enabled_if_present(user, name, enabled)?;
	}
	if !updated && let Some(root) = root {
		updated = update_enabled_if_present(root, name, enabled)?;
	}

	user.set_enable_overrides(name, !enabled && !updated, enabled && !updated)?;
	Ok(())
}

fn update_enabled_if_present(
	store: &McpConfigStore,
	name: &str,
	enabled: bool,
) -> Result<bool, ConfigStoreError> {
	let _lock = DirectoryLock::acquire(store.path())?;
	let mut file = read_file(store.path())?;
	let Some(server) = file.mcp_servers.get_mut(name) else {
		return Ok(false);
	};
	server.enabled = enabled;
	store.write_unlocked(&file)?;
	Ok(true)
}

fn validate_name(path: &Path, name: &str) -> Result<(), ConfigStoreError> {
	config::validate_server_name(name).map_err(|issue| ConfigStoreError::Validation {
		path:   path.to_path_buf(),
		issues: Box::new([issue]),
	})
}

fn validate_server(
	path: &Path,
	name: &str,
	server: &McpServerConfig,
) -> Result<(), ConfigStoreError> {
	let issues = config::validate_server(name, server);
	if issues.is_empty() {
		Ok(())
	} else {
		Err(ConfigStoreError::Validation {
			path:   path.to_path_buf(),
			issues: issues.into_boxed_slice(),
		})
	}
}

fn validate_file(path: &Path, file: &McpConfigFile) -> Result<(), ConfigStoreError> {
	let issues = config::validate_file(file);
	if issues.is_empty() {
		Ok(())
	} else {
		Err(ConfigStoreError::Validation {
			path:   path.to_path_buf(),
			issues: issues.into_boxed_slice(),
		})
	}
}

fn read_file(path: &Path) -> Result<McpConfigFile, ConfigStoreError> {
	let bytes = match fs::read(path) {
		Ok(bytes) => bytes,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(McpConfigFile::default()),
		Err(source) => return Err(ConfigStoreError::Io { path: path.to_path_buf(), source }),
	};
	let file: McpConfigFile = serde_json::from_slice(&bytes)
		.map_err(|source| ConfigStoreError::Json { path: path.to_path_buf(), source })?;
	validate_file(path, &file)?;
	Ok(file)
}

fn write_atomic(
	path: &Path,
	file: &McpConfigFile,
	before_rename: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), ConfigStoreError> {
	let parent = path
		.parent()
		.ok_or_else(|| ConfigStoreError::NoParent { path: path.to_path_buf() })?;
	create_private_dir(parent)
		.map_err(|source| ConfigStoreError::Io { path: parent.to_path_buf(), source })?;
	let mut document = file.clone();
	if document.schema.is_none() {
		document.schema = Some(Str::new_static(MCP_CONFIG_SCHEMA_URL));
	}
	let mut bytes = serde_json::to_vec_pretty(&document)
		.map_err(|source| ConfigStoreError::Json { path: path.to_path_buf(), source })?;
	bytes.push(b'\n');
	let temporary = temporary_path(path);
	let result = (|| -> Result<(), ConfigStoreError> {
		let mut output = private_temp_file(&temporary)
			.map_err(|source| ConfigStoreError::Io { path: temporary.clone(), source })?;
		output
			.write_all(&bytes)
			.map_err(|source| ConfigStoreError::Io { path: temporary.clone(), source })?;
		output
			.sync_all()
			.map_err(|source| ConfigStoreError::Io { path: temporary.clone(), source })?;
		before_rename(&temporary)
			.map_err(|source| ConfigStoreError::Io { path: temporary.clone(), source })?;
		fs::rename(&temporary, path)
			.map_err(|source| ConfigStoreError::Io { path: path.to_path_buf(), source })?;
		sync_parent(parent)
			.map_err(|source| ConfigStoreError::Io { path: parent.to_path_buf(), source })?;
		Ok(())
	})();
	if result.is_err() {
		let _ = fs::remove_file(&temporary);
	}
	result
}

#[cfg(unix)]
fn sync_parent(parent: &Path) -> io::Result<()> {
	File::open(parent)?.sync_all()
}

#[cfg(windows)]
fn sync_parent(_: &Path) -> io::Result<()> {
	Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
	let random = rand::random::<u128>();
	let uuid = format!(
		"{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
		(random >> 96) as u32,
		(random >> 80) as u16,
		((random >> 64) as u16) & 0x0fff,
		(((random >> 48) as u16) & 0x3fff) | 0x8000,
		random & 0x0000_ffff_ffff_ffff
	);
	let name = path.file_name().unwrap_or_default().to_string_lossy();
	path.with_file_name(format!("{name}.{uuid}.tmp"))
}

fn private_temp_file(path: &Path) -> io::Result<File> {
	let mut options = OpenOptions::new();
	options.write(true).create_new(true);
	#[cfg(unix)]
	{
		use std::os::unix::fs::OpenOptionsExt as _;
		options.mode(0o600);
	}
	options.open(path)
}

fn create_private_dir(path: &Path) -> io::Result<()> {
	fs::create_dir_all(path)?;
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
	}
	Ok(())
}

#[must_use]
struct DirectoryLock {
	path: PathBuf,
}
impl DirectoryLock {
	fn acquire(config_path: &Path) -> Result<Self, ConfigStoreError> {
		let parent = config_path
			.parent()
			.ok_or_else(|| ConfigStoreError::NoParent { path: config_path.to_path_buf() })?;
		create_private_dir(parent)
			.map_err(|source| ConfigStoreError::Io { path: parent.to_path_buf(), source })?;
		let path = parent.join(".mcp-config.lock");
		let started = Instant::now();
		loop {
			match fs::create_dir(&path) {
				Ok(()) => {
					#[cfg(unix)]
					{
						use std::os::unix::fs::PermissionsExt as _;
						fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
							.map_err(|source| ConfigStoreError::Io { path: path.clone(), source })?;
					}
					return Ok(Self { path });
				},
				Err(error)
					if error.kind() == io::ErrorKind::AlreadyExists && started.elapsed() < LOCK_WAIT =>
				{
					thread::sleep(LOCK_RETRY)
				},
				Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
					return Err(ConfigStoreError::LockTimeout { path });
				},
				Err(source) => return Err(ConfigStoreError::Io { path, source }),
			}
		}
	}
}
impl Drop for DirectoryLock {
	fn drop(&mut self) {
		let _ = fs::remove_dir(&self.path);
	}
}

/// Native MCP config store failure.
#[derive(Debug, thiserror::Error)]
pub enum ConfigStoreError {
	/// Filesystem operation failed.
	#[error("MCP configuration filesystem operation failed for `{path}`")]
	Io {
		/// Exact config, temporary, lock, or parent-directory path whose
		/// filesystem operation failed.
		path:   PathBuf,
		/// Operating-system error returned for that path.
		#[source]
		source: io::Error,
	},
	/// JSON operation failed.
	#[error("MCP configuration JSON operation failed for `{path}`")]
	Json {
		/// Production `~/.o2/mcp.json`, project `.omp/mcp.json`, or project-root
		/// `.mcp.json` being decoded or encoded.
		path:   PathBuf,
		/// JSON parser or serializer error for the scoped configuration document.
		#[source]
		source: serde_json::Error,
	},
	/// Schema validation failed.
	#[error("MCP configuration `{path}` failed schema validation")]
	Validation {
		/// Exact scoped configuration path containing invalid declarations.
		path:   PathBuf,
		/// Every independently actionable schema issue in the document.
		issues: Box<[config::ConfigValidationError]>,
	},
	/// Path has no owning directory.
	#[error("MCP configuration path `{path}` has no parent directory")]
	NoParent {
		/// Requested scoped config path that cannot be locked or atomically
		/// replaced without a parent.
		path: PathBuf,
	},
	/// Another writer held the directory lock past the bounded wait.
	#[error("timed out acquiring MCP configuration directory lock `{path}`")]
	LockTimeout {
		/// Scope-local `.mcp-config.lock` directory still held after the
		/// ten-second wait.
		path: PathBuf,
	},
	/// Add would replace an existing server.
	#[error("MCP server `{name}` already exists in `{path}`")]
	AlreadyExists {
		/// Server key already owned by the writable configuration document.
		name: Str,
		/// Exact `~/.o2/mcp.json`, project `.omp/mcp.json`, or project-root
		/// `.mcp.json` file that owns the key.
		path: PathBuf,
	},
	/// Requested server does not exist.
	#[error("MCP server `{name}` was not found in `{path}`")]
	NotFound {
		/// Server key requested for removal from the writable configuration
		/// document.
		name: Str,
		/// Exact `~/.o2/mcp.json`, project `.omp/mcp.json`, or project-root
		/// `.mcp.json` searched without resolving other scopes.
		path: PathBuf,
	},
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeMap,
		sync::{Arc, Barrier},
	};

	use super::*;
	use crate::mcp::config::TransportKind;

	fn stdio(command: &str) -> McpServerConfig {
		McpServerConfig {
			transport:         Some(TransportKind::Stdio),
			enabled:           true,
			command:           Some(Str::from(command)),
			args:              Vec::new(),
			env:               BTreeMap::new(),
			env_policy:        None,
			env_literal_keys:  Default::default(),
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
	fn concurrent_mutations_preserve_every_server_and_permissions() {
		let scratch = tempfile::tempdir().expect("scratch");
		let path = scratch.path().join("nested/mcp.json");
		let barrier = Arc::new(Barrier::new(9));
		let mut joins = Vec::new();
		for index in 0..8 {
			let path = path.clone();
			let barrier = barrier.clone();
			joins.push(thread::spawn(move || {
				barrier.wait();
				McpConfigStore::new(path).add(&format!("server-{index}"), stdio("fixture"))
			}));
		}
		barrier.wait();
		for join in joins {
			join.join().expect("thread").expect("mutation");
		}
		let store = McpConfigStore::new(path.clone());
		assert_eq!(store.list().expect("list").len(), 8);
		let raw = fs::read_to_string(&path).expect("read");
		assert!(raw.contains("\"$schema\""));
		#[cfg(unix)]
		{
			use std::os::unix::fs::PermissionsExt as _;
			assert_eq!(
				fs::metadata(path.parent().expect("parent"))
					.expect("dir metadata")
					.permissions()
					.mode() & 0o777,
				0o700
			);
			assert_eq!(
				fs::metadata(&path)
					.expect("file metadata")
					.permissions()
					.mode() & 0o777,
				0o600
			);
		}
	}

	#[test]
	fn interruption_before_rename_preserves_previous_file() {
		let scratch = tempfile::tempdir().expect("scratch");
		let path = scratch.path().join("mcp.json");
		let store = McpConfigStore::new(path.clone());
		store.add("old", stdio("old")).expect("initial");
		let before = fs::read(&path).expect("before");
		let mut changed = store.read().expect("read");
		changed.mcp_servers.insert(Str::from("new"), stdio("new"));
		let error = write_atomic(&path, &changed, |_| {
			Err(io::Error::new(io::ErrorKind::Interrupted, "fixture crash"))
		})
		.expect_err("interrupted");
		assert!(matches!(error, ConfigStoreError::Io { .. }));
		assert_eq!(fs::read(path).expect("after"), before);
	}

	#[test]
	fn reciprocal_enable_cleanup_handles_read_only_sources() {
		let scratch = tempfile::tempdir().expect("scratch");
		let user = McpConfigStore::new(scratch.path().join("user/mcp.json"));
		let project = McpConfigStore::new(scratch.path().join("project/mcp.json"));
		set_server_enabled(&user, &project, None, "foreign", false).expect("disable");
		assert!(
			user
				.read()
				.expect("read")
				.disabled_servers
				.contains("foreign")
		);
		set_server_enabled(&user, &project, None, "foreign", true).expect("enable");
		let file = user.read().expect("read");
		assert!(!file.disabled_servers.contains("foreign"));
		assert!(file.enabled_servers.contains("foreign"));
	}

	#[test]
	fn enable_mutation_follows_project_user_root_precedence() {
		let scratch = tempfile::tempdir().expect("scratch");
		let user = McpConfigStore::new(scratch.path().join("user/mcp.json"));
		let project = McpConfigStore::new(scratch.path().join("project/mcp.json"));
		let root = McpConfigStore::new(scratch.path().join("root/mcp.json"));
		user.add("shared", stdio("user")).expect("user");
		project.add("shared", stdio("project")).expect("project");
		root.add("shared", stdio("root")).expect("root");

		set_server_enabled(&user, &project, Some(&root), "shared", false).expect("disable");
		assert!(
			!project
				.get("shared")
				.expect("project")
				.expect("shared")
				.enabled
		);
		assert!(user.get("shared").expect("user").expect("shared").enabled);
		assert!(root.get("shared").expect("root").expect("shared").enabled);
	}

	#[test]
	fn validation_errors_retain_the_scoped_config_path() {
		let scratch = tempfile::tempdir().expect("scratch");
		let path = scratch.path().join("project/.omp/mcp.json");
		let mut invalid = stdio("fixture");
		invalid.url = Some(Str::from("https://example.test/mcp"));
		let error = McpConfigStore::new(path.clone())
			.add("fixture", invalid)
			.expect_err("invalid declaration");
		assert!(matches!(
			error,
			ConfigStoreError::Validation { path: error_path, .. } if error_path == path
		));
	}

	#[test]
	fn migration_is_validated_atomic_and_never_overwrites() {
		let scratch = tempfile::tempdir().expect("scratch");
		let legacy = scratch.path().join(".omp/mcp.json");
		let destination = scratch.path().join(".o2/mcp.json");
		fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy parent");
		fs::write(&legacy, br#"{"mcpServers":{"legacy":{"type":"stdio","command":"legacy"}}}"#)
			.expect("legacy config");

		let store = McpConfigStore::new(destination.clone());
		assert!(store.migrate_from(&legacy).expect("migration"));
		assert!(!legacy.exists());
		assert_eq!(
			store
				.get("legacy")
				.expect("destination")
				.expect("legacy server")
				.command
				.as_deref(),
			Some("legacy")
		);

		fs::create_dir_all(legacy.parent().expect("legacy parent")).expect("legacy parent");
		fs::write(
			&legacy,
			br#"{"mcpServers":{"replacement":{"type":"stdio","command":"replacement"}}}"#,
		)
		.expect("replacement");
		assert!(!store.migrate_from(&legacy).expect("preserve destination"));
		assert!(legacy.exists());
		assert!(store.get("replacement").expect("destination").is_none());

		let invalid_legacy = scratch.path().join("invalid/mcp.json");
		let invalid_destination = scratch.path().join("fresh/mcp.json");
		fs::create_dir_all(invalid_legacy.parent().expect("invalid parent")).expect("invalid parent");
		fs::write(
			&invalid_legacy,
			br#"{"mcpServers":{"broken":{"type":"stdio","url":"https://example.test"}}}"#,
		)
		.expect("invalid legacy config");
		let error = McpConfigStore::new(invalid_destination.clone())
			.migrate_from(&invalid_legacy)
			.expect_err("invalid migration");
		assert!(matches!(
			error,
			ConfigStoreError::Validation { path, .. } if path == invalid_legacy
		));
		assert!(invalid_legacy.exists());
		assert!(!invalid_destination.exists());
	}
}
