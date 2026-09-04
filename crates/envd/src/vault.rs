//! Layered, symlink-confined filesystem and Obsidian CLI authority for
//! `vault://` resources.

use std::{
	collections::BTreeMap,
	env,
	ffi::{OsStr, OsString},
	fs, io,
	path::{Component, Path, PathBuf},
	process::{ExitStatus, Stdio},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use omp_core::{CowBytes, Str, fs::replace_file_atomically};
use serde::Deserialize;
use tokio::{
	io::{AsyncRead, AsyncReadExt as _, AsyncWriteExt as _},
	process::{Child, Command},
	sync::RwLock,
	time,
};
use toml::de;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultFile {
	#[serde(default)]
	vaults: BTreeMap<Str, PathBuf>,
}

/// The two `vaults.toml` files one process reads.
///
/// User configuration lives under `~/.o2`
/// ([`omp_core::dirs::user_config_root`], profile-aware) and never under the
/// data or state directory; project declarations live in
/// `<project>/.omp/vaults.toml` and shadow user vaults with the same name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultPaths {
	/// User-owned `<config root>/vaults.toml`.
	pub user:    PathBuf,
	/// Project-owned `<project>/.omp/vaults.toml`.
	pub project: PathBuf,
}

impl VaultPaths {
	/// Resolves both files from the user configuration root and the project
	/// root.
	#[must_use]
	pub fn new(user_config_root: &Path, project_root: &Path) -> Self {
		Self {
			user:    user_config_root.join("vaults.toml"),
			project: project_root.join(".omp/vaults.toml"),
		}
	}
}

/// One direct child returned by a bounded vault directory listing.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultEntry {
	/// UTF-8 file name, without a parent path.
	pub name:      Str,
	/// Whether the entry itself is a directory (symbolic links are false).
	pub directory: bool,
	/// Entry byte length when available.
	pub size:      u64,
}

const OBSIDIAN_TIMEOUT: Duration = Duration::from_secs(30);
const OBSIDIAN_OUTPUT_LIMIT: usize = 8 * 1024 * 1024;
const OBSIDIAN_ARGUMENT_LIMIT: usize = 64 * 1024;
#[cfg(target_os = "macos")]
const DARWIN_OBSIDIAN_BINARY: &str = "/Applications/Obsidian.app/Contents/MacOS/obsidian";

/// One operation delegated to the Obsidian CLI.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display, strum::EnumString)]
#[strum(serialize_all = "snake_case")]
pub enum ObsidianOperation {
	/// Discover registered vaults.
	Discover,
	/// Read a note through Obsidian.
	Read,
	/// Create a note through Obsidian.
	Create,
	/// Move or rename a note.
	Move,
	/// Delete a note.
	Delete,
	/// Open a note in the desktop application.
	Open,
	/// Search note contents.
	Search,
}

/// Options for an Obsidian search.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VaultSearch<'a> {
	/// Search expression.
	pub query:          &'a str,
	/// Optional vault-relative directory filter.
	pub path:           Option<&'a str>,
	/// Optional result ceiling forwarded to Obsidian.
	pub limit:          Option<usize>,
	/// Whether matching is case-sensitive.
	pub case_sensitive: bool,
}

/// Captured, bounded Obsidian CLI output.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ObsidianOutput {
	/// Standard output bytes.
	pub stdout: CowBytes<'static>,
	/// Standard error bytes.
	pub stderr: CowBytes<'static>,
}

#[derive(Clone, Debug)]
struct ObsidianCli {
	binary:  Option<PathBuf>,
	timeout: Duration,
}

impl Default for ObsidianCli {
	fn default() -> Self {
		Self { binary: None, timeout: OBSIDIAN_TIMEOUT }
	}
}

/// Effective configured and Obsidian-discovered vault roots plus their mutation
/// revision.
///
/// Configured roots are canonicalized once when the layered configuration is
/// loaded. Obsidian discovery is lazy and only supplies names absent from the
/// configured layers, so project configuration overrides user configuration,
/// which overrides the desktop application's registry. Each operation
/// revalidates the addressed target or its nearest existing ancestor, so a
/// symlink can never move an operation outside its root.
#[derive(Clone, Debug, Default)]
pub struct VaultService {
	roots:      Arc<BTreeMap<Str, PathBuf>>,
	revision:   Arc<AtomicU64>,
	obsidian:   ObsidianCli,
	discovered: Arc<RwLock<Option<Arc<BTreeMap<Str, PathBuf>>>>>,
	active:     Arc<RwLock<Option<PathBuf>>>,
}

impl VaultService {
	/// Loads every user vault and overlays project declarations with the same
	/// name. Relative roots are resolved from the declaring file's directory.
	pub fn load_layered(paths: &VaultPaths) -> Result<Self, VaultError> {
		let mut roots = parse_vaults(&paths.user)?;
		roots.extend(parse_vaults(&paths.project)?);
		Ok(Self {
			roots:      Arc::new(roots),
			revision:   Arc::new(AtomicU64::new(1)),
			obsidian:   ObsidianCli::default(),
			discovered: Arc::new(RwLock::new(None)),
			active:     Arc::new(RwLock::new(None)),
		})
	}

	/// Enables Obsidian CLI discovery and operations for the active settings
	/// profile. PATH takes precedence over the macOS application bundle.
	#[must_use]
	pub fn with_obsidian_enabled(mut self, enabled: bool) -> Self {
		self.obsidian.binary = enabled.then(resolve_obsidian_binary).flatten();
		self
	}

	#[cfg(test)]
	pub(crate) fn with_obsidian_binary(mut self, binary: Option<PathBuf>) -> Self {
		self.obsidian.binary = binary;
		self
	}

	/// Returns explicitly configured names in deterministic order.
	///
	/// Call [`Self::names_with_obsidian`] when an asynchronous caller can also
	/// include the desktop application's registry.
	#[cfg(test)]
	#[must_use]
	pub(crate) fn names(&self) -> Vec<Str> {
		self.roots.keys().cloned().collect()
	}

	/// Returns the effective configured-plus-discovered names.
	pub async fn names_with_obsidian(&self) -> Result<Vec<Str>, VaultError> {
		Ok(self.effective_roots().await?.keys().cloned().collect())
	}

	async fn effective_roots(&self) -> Result<BTreeMap<Str, PathBuf>, VaultError> {
		let discovered = self.discover_obsidian_vaults().await?;
		let mut effective = discovered.as_ref().clone();
		effective.extend(
			self
				.roots
				.iter()
				.map(|(name, root)| (name.clone(), root.clone())),
		);
		Ok(effective)
	}

	async fn discover_obsidian_vaults(&self) -> Result<Arc<BTreeMap<Str, PathBuf>>, VaultError> {
		if let Some(cached) = self.discovered.read().await.as_ref() {
			return Ok(Arc::clone(cached));
		}
		if self.obsidian.binary.is_none() {
			return Ok(Arc::new(BTreeMap::new()));
		}
		let output = self
			.run_obsidian(ObsidianOperation::Discover, None, ["vaults", "verbose"])
			.await?;
		let parsed = Arc::new(parse_vault_directory(output.stdout.as_ref())?);
		let mut cached = self.discovered.write().await;
		if let Some(existing) = cached.as_ref() {
			return Ok(Arc::clone(existing));
		}
		*cached = Some(Arc::clone(&parsed));
		Ok(parsed)
	}

	async fn root(&self, vault: &str) -> Result<PathBuf, VaultError> {
		if vault == "_" {
			return self.active_obsidian_root().await;
		}
		if let Some(root) = self.roots.get(vault) {
			return Ok(root.clone());
		}
		let discovered = self.discover_obsidian_vaults().await?;
		let root = discovered
			.get(vault)
			.ok_or_else(|| VaultError::Unknown { name: Str::new(vault) })?;
		canonical_obsidian_root(root).await
	}

	async fn active_obsidian_root(&self) -> Result<PathBuf, VaultError> {
		if let Some(root) = self.active.read().await.as_ref() {
			return Ok(root.clone());
		}
		let output = self
			.run_obsidian(ObsidianOperation::Discover, None, ["vault", "info", "path"])
			.await?;
		let resolved = parse_active_vault_path(output.stdout.as_ref()).await?;
		let mut active = self.active.write().await;
		if let Some(root) = active.as_ref() {
			return Ok(root.clone());
		}
		*active = Some(resolved.clone());
		Ok(resolved)
	}

	async fn target(&self, vault: &str, relative: &str) -> Result<(PathBuf, PathBuf), VaultError> {
		validate_relative_path(relative)?;
		let root = self.root(vault).await?;
		Ok((root.clone(), root.join(relative)))
	}

	async fn canonical_target(
		&self,
		vault: &str,
		relative: &str,
	) -> Result<(PathBuf, PathBuf), VaultError> {
		let (root, target) = self.target(vault, relative).await?;
		let canonical = match tokio::fs::canonicalize(&target).await {
			Ok(canonical) => canonical,
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				return Err(VaultError::NotFound { path: target });
			},
			Err(source) => {
				return Err(VaultError::Io {
					operation: VaultOperation::Resolve,
					path: target,
					source,
				});
			},
		};
		ensure_contained(&root, &canonical)?;
		Ok((root, canonical))
	}

	/// Reads one regular file after resolving and confining every symlink.
	/// Dropping the returned future cancels the caller's read without effects.
	pub async fn read(
		&self,
		vault: &str,
		relative: &str,
		limit: usize,
	) -> Result<CowBytes<'static>, VaultError> {
		let (_, path) = self.canonical_target(vault, relative).await?;
		let metadata = tokio::fs::metadata(&path)
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::ReadMetadata,
				path: path.clone(),
				source,
			})?;
		if metadata.is_dir() {
			return Err(VaultError::IsDirectory { path });
		}
		if !metadata.is_file() {
			return Err(VaultError::NotFile { path });
		}
		let actual = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
		if actual > limit {
			return Err(VaultError::Limit { limit, actual });
		}
		let file = tokio::fs::File::open(&path)
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::Read,
				path: path.clone(),
				source,
			})?;
		let bound = u64::try_from(limit).unwrap_or(u64::MAX).saturating_add(1);
		let mut bytes = Vec::with_capacity(actual.min(limit));
		file
			.take(bound)
			.read_to_end(&mut bytes)
			.await
			.map_err(|source| VaultError::Io { operation: VaultOperation::Read, path, source })?;
		if bytes.len() > limit {
			return Err(VaultError::Limit { limit, actual: bytes.len() });
		}
		Ok(CowBytes::from(bytes))
	}

	/// Atomically creates or replaces one regular file inside a vault.
	///
	/// Bytes are fully written and synchronized to a sibling temporary file
	/// before the single atomic replacement. Cancellation while staging leaves
	/// the destination unchanged and removes the temporary file. Publication has
	/// no suspension point: once it starts, it completes atomically and returns
	/// the committed revision.
	pub async fn write(
		&self,
		vault: &str,
		relative: &str,
		bytes: &[u8],
		limit: usize,
	) -> Result<u64, VaultError> {
		if bytes.len() > limit {
			return Err(VaultError::Limit { limit, actual: bytes.len() });
		}
		if relative.is_empty() || relative.ends_with('/') {
			return Err(VaultError::InvalidPath { path: Str::new(relative) });
		}
		let (root, target) = self.target(vault, relative).await?;
		let parent = target
			.parent()
			.filter(|parent| !parent.as_os_str().is_empty())
			.ok_or_else(|| VaultError::InvalidPath { path: Str::new(relative) })?;
		let existing_ancestor = existing_ancestor(parent, &root).await?;
		ensure_contained(&root, &existing_ancestor)?;
		tokio::fs::create_dir_all(parent)
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::CreateDirectory,
				path: parent.to_path_buf(),
				source,
			})?;
		let canonical_parent =
			tokio::fs::canonicalize(parent)
				.await
				.map_err(|source| VaultError::Io {
					operation: VaultOperation::Resolve,
					path: parent.to_path_buf(),
					source,
				})?;
		ensure_contained(&root, &canonical_parent)?;
		let file_name = target
			.file_name()
			.ok_or_else(|| VaultError::InvalidPath { path: Str::new(relative) })?;
		let destination = canonical_parent.join(file_name);

		let permissions = match tokio::fs::symlink_metadata(&destination).await {
			Ok(metadata) => {
				if metadata.file_type().is_symlink() {
					return Err(VaultError::SymlinkTarget { path: destination });
				}
				if metadata.is_dir() {
					return Err(VaultError::IsDirectory { path: destination });
				}
				if !metadata.is_file() {
					return Err(VaultError::NotFile { path: destination });
				}
				let canonical = tokio::fs::canonicalize(&destination)
					.await
					.map_err(|source| VaultError::Io {
						operation: VaultOperation::Resolve,
						path: destination.clone(),
						source,
					})?;
				ensure_contained(&root, &canonical)?;
				Some(metadata.permissions())
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => None,
			Err(source) => {
				return Err(VaultError::Io {
					operation: VaultOperation::ReadMetadata,
					path: destination,
					source,
				});
			},
		};

		let mut temporary = AtomicTemp::create(&canonical_parent).await?;
		let temporary_path = temporary.path.clone();
		temporary
			.file_mut()
			.write_all(bytes)
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::Write,
				path: temporary_path.clone(),
				source,
			})?;
		if let Some(permissions) = permissions {
			temporary
				.file_mut()
				.set_permissions(permissions)
				.await
				.map_err(|source| VaultError::Io {
					operation: VaultOperation::SetPermissions,
					path: temporary_path.clone(),
					source,
				})?;
		}
		temporary
			.file_mut()
			.flush()
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::Write,
				path: temporary_path.clone(),
				source,
			})?;
		temporary
			.file_mut()
			.sync_all()
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::Sync,
				path: temporary_path.clone(),
				source,
			})?;
		temporary.close();
		replace_file_atomically(&temporary_path, &destination)
			.map_err(|source| VaultError::AtomicReplace { path: destination, source })?;
		temporary.committed = true;
		Ok(self
			.revision
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1))
	}

	/// Reads a file through Obsidian's CLI after independently proving that the
	/// file resolves inside the effective vault root.
	pub async fn obsidian_read(
		&self,
		vault: &str,
		relative: &str,
	) -> Result<ObsidianOutput, VaultError> {
		let _ = self.confine_existing_file(vault, relative).await?;
		self
			.run_obsidian(ObsidianOperation::Read, vault_arg(vault), [
				"read".to_owned(),
				format!("path={relative}"),
			])
			.await
	}

	/// Creates a note through Obsidian after confining its destination.
	pub async fn obsidian_create(
		&self,
		vault: &str,
		relative: &str,
		content: &str,
		overwrite: bool,
	) -> Result<u64, VaultError> {
		if content.len() > OBSIDIAN_ARGUMENT_LIMIT {
			return Err(VaultError::Limit { limit: OBSIDIAN_ARGUMENT_LIMIT, actual: content.len() });
		}
		self.confine_new_target(vault, relative).await?;
		let mut args =
			vec!["create".to_owned(), format!("path={relative}"), format!("content={content}")];
		if overwrite {
			args.push("overwrite".to_owned());
		}
		self
			.run_obsidian(ObsidianOperation::Create, vault_arg(vault), args)
			.await?;
		Ok(self
			.revision
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1))
	}

	/// Moves a note through Obsidian after confining both source and
	/// destination.
	pub async fn obsidian_move(
		&self,
		vault: &str,
		relative: &str,
		destination: &str,
	) -> Result<u64, VaultError> {
		let _ = self.confine_existing_file(vault, relative).await?;
		self.confine_new_target(vault, destination).await?;
		self
			.run_obsidian(ObsidianOperation::Move, vault_arg(vault), [
				"move".to_owned(),
				format!("path={relative}"),
				format!("to={destination}"),
			])
			.await?;
		Ok(self
			.revision
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1))
	}

	/// Deletes a note through Obsidian after confining the existing target.
	pub async fn obsidian_delete(
		&self,
		vault: &str,
		relative: &str,
		permanent: bool,
	) -> Result<u64, VaultError> {
		let _ = self.confine_existing_file(vault, relative).await?;
		let mut args = vec!["delete".to_owned(), format!("path={relative}")];
		if permanent {
			args.push("permanent".to_owned());
		}
		self
			.run_obsidian(ObsidianOperation::Delete, vault_arg(vault), args)
			.await?;
		Ok(self
			.revision
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1))
	}

	/// Opens a confined note in Obsidian.
	pub async fn obsidian_open(
		&self,
		vault: &str,
		relative: &str,
		new_tab: bool,
	) -> Result<u64, VaultError> {
		let _ = self.confine_existing_file(vault, relative).await?;
		let mut args = vec!["open".to_owned(), format!("path={relative}")];
		if new_tab {
			args.push("newtab".to_owned());
		}
		self
			.run_obsidian(ObsidianOperation::Open, vault_arg(vault), args)
			.await?;
		Ok(self
			.revision
			.fetch_add(1, Ordering::AcqRel)
			.saturating_add(1))
	}

	/// Searches one vault through Obsidian and returns bounded JSON output.
	pub async fn obsidian_search(
		&self,
		vault: &str,
		search: &VaultSearch<'_>,
	) -> Result<ObsidianOutput, VaultError> {
		if search.query.is_empty() {
			return Err(VaultError::MissingParameter {
				operation: ObsidianOperation::Search,
				name:      "q",
			});
		}
		let root = self.root(vault).await?;
		let mut args = vec!["search:context".to_owned(), format!("query={}", search.query)];
		if let Some(path) = search.path {
			validate_relative_path(path)?;
			let target = tokio::fs::canonicalize(root.join(path))
				.await
				.map_err(|source| VaultError::Io {
					operation: VaultOperation::Resolve,
					path: root.join(path),
					source,
				})?;
			ensure_contained(&root, &target)?;
			args.push(format!("path={path}"));
		}
		if let Some(limit) = search.limit {
			args.push(format!("limit={limit}"));
		}
		if search.case_sensitive {
			args.push("case".to_owned());
		}
		args.push("format=json".to_owned());
		self
			.run_obsidian(ObsidianOperation::Search, vault_arg(vault), args)
			.await
	}

	async fn confine_existing_file(
		&self,
		vault: &str,
		relative: &str,
	) -> Result<PathBuf, VaultError> {
		let (_, path) = self.canonical_target(vault, relative).await?;
		let metadata = tokio::fs::metadata(&path)
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::ReadMetadata,
				path: path.clone(),
				source,
			})?;
		if metadata.is_dir() {
			return Err(VaultError::IsDirectory { path });
		}
		if !metadata.is_file() {
			return Err(VaultError::NotFile { path });
		}
		Ok(path)
	}

	async fn confine_new_target(&self, vault: &str, relative: &str) -> Result<(), VaultError> {
		if relative.is_empty() || relative.ends_with('/') {
			return Err(VaultError::InvalidPath { path: Str::new(relative) });
		}
		let (root, target) = self.target(vault, relative).await?;
		match tokio::fs::symlink_metadata(&target).await {
			Ok(metadata) => {
				if metadata.file_type().is_symlink() {
					return Err(VaultError::SymlinkTarget { path: target });
				}
				let canonical =
					tokio::fs::canonicalize(&target)
						.await
						.map_err(|source| VaultError::Io {
							operation: VaultOperation::Resolve,
							path: target.clone(),
							source,
						})?;
				ensure_contained(&root, &canonical)
			},
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				let parent = target
					.parent()
					.ok_or_else(|| VaultError::InvalidPath { path: Str::new(relative) })?;
				let ancestor = existing_ancestor(parent, &root).await?;
				ensure_contained(&root, &ancestor)
			},
			Err(source) => {
				Err(VaultError::Io { operation: VaultOperation::ReadMetadata, path: target, source })
			},
		}
	}

	async fn run_obsidian<I, S>(
		&self,
		operation: ObsidianOperation,
		vault: Option<OsString>,
		args: I,
	) -> Result<ObsidianOutput, VaultError>
	where
		I: IntoIterator<Item = S>,
		S: AsRef<OsStr>,
	{
		let binary = self
			.obsidian
			.binary
			.as_ref()
			.ok_or(VaultError::ObsidianUnavailable)?;
		let mut command = Command::new(binary);
		command
			.stdin(Stdio::null())
			.stdout(Stdio::piped())
			.stderr(Stdio::piped())
			.kill_on_drop(true);
		if let Some(vault) = vault {
			command.arg(vault);
		}
		command.args(args);
		let mut child = CliChild::spawn(command, binary, operation)?;
		let stdout = child.take_stdout(operation)?;
		let stderr = child.take_stderr(operation)?;
		let completed = async {
			let (stdout, stderr, status) = tokio::try_join!(
				read_cli_stream(stdout, operation),
				read_cli_stream(stderr, operation),
				child.wait(operation),
			)?;
			Ok::<_, VaultError>((stdout, stderr, status))
		};
		let (stdout, stderr, status) = match time::timeout(self.obsidian.timeout, completed).await {
			Ok(result) => result?,
			Err(_) => {
				child.terminate().await;
				return Err(VaultError::ObsidianTimeout { operation, timeout: self.obsidian.timeout });
			},
		};
		child.disarm();
		assert_obsidian_success(operation, status, &stdout, &stderr)?;
		Ok(ObsidianOutput { stdout: CowBytes::from(stdout), stderr: CowBytes::from(stderr) })
	}

	/// Lists direct children of a confined directory in deterministic order.
	/// One extra entry is observed to report truncation exactly.
	pub async fn list(
		&self,
		vault: &str,
		relative: &str,
		limit: usize,
	) -> Result<(Vec<VaultEntry>, bool), VaultError> {
		let (_, path) = self.canonical_target(vault, relative).await?;
		let metadata = tokio::fs::metadata(&path)
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::ReadMetadata,
				path: path.clone(),
				source,
			})?;
		if !metadata.is_dir() {
			return Err(VaultError::NotDirectory { path });
		}
		let mut directory = tokio::fs::read_dir(&path)
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::List,
				path: path.clone(),
				source,
			})?;
		let mut values = Vec::new();
		let mut truncated = false;
		while let Some(entry) = directory
			.next_entry()
			.await
			.map_err(|source| VaultError::Io {
				operation: VaultOperation::List,
				path: path.clone(),
				source,
			})? {
			if values.len() == limit {
				truncated = true;
				break;
			}
			let entry_path = entry.path();
			let metadata = tokio::fs::symlink_metadata(&entry_path)
				.await
				.map_err(|source| VaultError::Io {
					operation: VaultOperation::ReadMetadata,
					path: entry_path.clone(),
					source,
				})?;
			let name = entry
				.file_name()
				.into_string()
				.map_err(|_| VaultError::NonUtf8Name { path: entry_path })?;
			values.push(VaultEntry {
				name:      Str::new(name),
				directory: metadata.is_dir(),
				size:      metadata.len(),
			});
		}
		values.sort_unstable_by(|left, right| left.name.cmp(&right.name));
		Ok((values, truncated))
	}
}

fn resolve_obsidian_binary() -> Option<PathBuf> {
	let executable = if cfg!(windows) {
		"obsidian.exe"
	} else {
		"obsidian"
	};
	if let Some(path) = env::var_os("PATH") {
		for directory in env::split_paths(&path) {
			let candidate = directory.join(executable);
			if is_executable_file(&candidate) {
				return Some(candidate);
			}
		}
	}
	#[cfg(target_os = "macos")]
	{
		let candidate = PathBuf::from(DARWIN_OBSIDIAN_BINARY);
		if is_executable_file(&candidate) {
			return Some(candidate);
		}
	}
	None
}

fn is_executable_file(path: &Path) -> bool {
	let Ok(metadata) = path.metadata() else {
		return false;
	};
	if !metadata.is_file() {
		return false;
	}
	#[cfg(unix)]
	{
		use std::os::unix::fs::PermissionsExt as _;
		metadata.permissions().mode() & 0o111 != 0
	}
	#[cfg(not(unix))]
	{
		true
	}
}

fn validate_relative_path(relative: &str) -> Result<(), VaultError> {
	let relative_path = Path::new(relative);
	if relative_path.is_absolute()
		|| (!relative.is_empty()
			&& (relative.contains('\\')
				|| relative.bytes().any(|byte| byte.is_ascii_control())
				|| relative
					.split('/')
					.any(|component| component.is_empty() || matches!(component, "." | ".."))))
		|| relative_path
			.components()
			.any(|component| !matches!(component, Component::Normal(_)))
	{
		return Err(VaultError::InvalidPath { path: Str::new(relative) });
	}
	Ok(())
}

fn vault_arg(vault: &str) -> Option<OsString> {
	(vault != "_").then(|| OsString::from(format!("vault={vault}")))
}

fn parse_vault_directory(bytes: &[u8]) -> Result<BTreeMap<Str, PathBuf>, VaultError> {
	let text = std::str::from_utf8(bytes).map_err(|source| VaultError::ObsidianUtf8 {
		operation: ObsidianOperation::Discover,
		source,
	})?;
	let mut roots = BTreeMap::new();
	for line in text.lines() {
		let Some((name, root)) = line.trim_end().split_once('\t') else {
			continue;
		};
		if name.is_empty() || root.trim().is_empty() {
			continue;
		}
		validate_name(name)?;
		let configured = PathBuf::from(root.trim());
		let absolute = if configured.is_absolute() {
			configured
		} else {
			env::current_dir()
				.map_err(|source| VaultError::Io {
					operation: VaultOperation::Resolve,
					path: configured.clone(),
					source,
				})?
				.join(configured)
		};
		roots.insert(Str::new(name), absolute);
	}
	Ok(roots)
}

async fn parse_active_vault_path(bytes: &[u8]) -> Result<PathBuf, VaultError> {
	let text = std::str::from_utf8(bytes).map_err(|source| VaultError::ObsidianUtf8 {
		operation: ObsidianOperation::Discover,
		source,
	})?;
	let mut fallback = None;
	let mut line_count = 0usize;
	for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
		line_count += 1;
		fallback = Some(line);
		if let Some((label, path)) = line.split_once('\t').or_else(|| line.split_once(':'))
			&& label.trim().eq_ignore_ascii_case("path")
		{
			return canonical_obsidian_root(Path::new(path.trim())).await;
		}
	}
	if line_count == 1
		&& let Some(path) = fallback
	{
		return canonical_obsidian_root(Path::new(path)).await;
	}
	Err(VaultError::ObsidianActiveVaultMissing)
}

async fn canonical_obsidian_root(path: &Path) -> Result<PathBuf, VaultError> {
	let canonical = tokio::fs::canonicalize(path)
		.await
		.map_err(|source| VaultError::Io {
			operation: VaultOperation::Resolve,
			path: path.to_path_buf(),
			source,
		})?;
	if !canonical.is_dir() {
		return Err(VaultError::NotDirectory { path: canonical });
	}
	Ok(canonical)
}

struct CliChild {
	child: Option<Child>,
	pid:   Option<u32>,
}

impl CliChild {
	fn spawn(
		command: Command,
		binary: &Path,
		operation: ObsidianOperation,
	) -> Result<Self, VaultError> {
		let mut command = command;
		#[cfg(unix)]
		{
			use std::os::unix::process::CommandExt as _;
			command.as_std_mut().process_group(0);
		}
		let child = command
			.spawn()
			.map_err(|source| VaultError::ObsidianSpawn {
				operation,
				binary: binary.to_path_buf(),
				source,
			})?;
		let pid = child.id();
		Ok(Self { child: Some(child), pid })
	}

	fn take_stdout(
		&mut self,
		operation: ObsidianOperation,
	) -> Result<tokio::process::ChildStdout, VaultError> {
		self
			.child
			.as_mut()
			.and_then(|child| child.stdout.take())
			.ok_or(VaultError::ObsidianPipe { operation, stream: ObsidianStream::Stdout })
	}

	fn take_stderr(
		&mut self,
		operation: ObsidianOperation,
	) -> Result<tokio::process::ChildStderr, VaultError> {
		self
			.child
			.as_mut()
			.and_then(|child| child.stderr.take())
			.ok_or(VaultError::ObsidianPipe { operation, stream: ObsidianStream::Stderr })
	}

	async fn wait(&mut self, operation: ObsidianOperation) -> Result<ExitStatus, VaultError> {
		let child = self
			.child
			.as_mut()
			.ok_or(VaultError::ObsidianPipe { operation, stream: ObsidianStream::Process })?;
		let status = child
			.wait()
			.await
			.map_err(|source| VaultError::ObsidianWait { operation, source })?;
		self.child.take();
		Ok(status)
	}

	fn disarm(&mut self) {
		self.child.take();
		self.pid = None;
	}

	async fn terminate(&mut self) {
		kill_process_tree(self.pid);
		if let Some(mut child) = self.child.take() {
			let _ = child.start_kill();
			let _ = child.wait().await;
		}
		self.pid = None;
	}
}

impl Drop for CliChild {
	fn drop(&mut self) {
		kill_process_tree(self.pid);
		let Some(mut child) = self.child.take() else {
			return;
		};
		let _ = child.start_kill();
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			runtime.spawn(async move {
				let _ = child.wait().await;
			});
		}
	}
}

fn kill_process_tree(pid: Option<u32>) {
	#[cfg(unix)]
	if let Some(pid) = pid.and_then(|pid| i32::try_from(pid).ok()) {
		let _ = nix::sys::signal::killpg(
			nix::unistd::Pid::from_raw(pid),
			nix::sys::signal::Signal::SIGKILL,
		);
	}
	#[cfg(not(unix))]
	let _ = pid;
}

async fn read_cli_stream(
	stream: impl AsyncRead + Unpin,
	operation: ObsidianOperation,
) -> Result<Vec<u8>, VaultError> {
	let mut bytes = Vec::new();
	stream
		.take(
			u64::try_from(OBSIDIAN_OUTPUT_LIMIT)
				.unwrap_or(u64::MAX)
				.saturating_add(1),
		)
		.read_to_end(&mut bytes)
		.await
		.map_err(|source| VaultError::ObsidianOutput { operation, source })?;
	if bytes.len() > OBSIDIAN_OUTPUT_LIMIT {
		return Err(VaultError::ObsidianOutputLimit {
			operation,
			limit: OBSIDIAN_OUTPUT_LIMIT,
			actual: bytes.len(),
		});
	}
	Ok(bytes)
}

fn assert_obsidian_success(
	operation: ObsidianOperation,
	status: ExitStatus,
	stdout: &[u8],
	stderr: &[u8],
) -> Result<(), VaultError> {
	let stdout = std::str::from_utf8(stdout)
		.map_err(|source| VaultError::ObsidianUtf8 { operation, source })?;
	let stderr = std::str::from_utf8(stderr)
		.map_err(|source| VaultError::ObsidianUtf8 { operation, source })?;
	let reported = stderr
		.trim()
		.strip_prefix("Error:")
		.or_else(|| stdout.trim().strip_prefix("Error:"));
	if status.success() && reported.is_none() {
		return Ok(());
	}
	Err(VaultError::ObsidianFailed {
		operation,
		code: status.code(),
		diagnostic: Str::new(
			reported
				.map(str::trim)
				.filter(|detail| !detail.is_empty())
				.or_else(|| (!stderr.trim().is_empty()).then(|| stderr.trim()))
				.or_else(|| (!stdout.trim().is_empty()).then(|| stdout.trim()))
				.unwrap_or("Obsidian exited without a diagnostic"),
		),
	})
}

async fn existing_ancestor(path: &Path, root: &Path) -> Result<PathBuf, VaultError> {
	let mut current = path;
	loop {
		if !current.starts_with(root) {
			return Err(VaultError::Escape { path: current.to_path_buf() });
		}
		match tokio::fs::canonicalize(current).await {
			Ok(canonical) => return Ok(canonical),
			Err(source) if source.kind() == io::ErrorKind::NotFound => {
				current = current
					.parent()
					.ok_or_else(|| VaultError::Escape { path: path.to_path_buf() })?;
			},
			Err(source) => {
				return Err(VaultError::Io {
					operation: VaultOperation::Resolve,
					path: current.to_path_buf(),
					source,
				});
			},
		}
	}
}

fn ensure_contained(root: &Path, target: &Path) -> Result<(), VaultError> {
	if target.starts_with(root) {
		Ok(())
	} else {
		Err(VaultError::Escape { path: target.to_path_buf() })
	}
}

fn parse_vaults(path: &Path) -> Result<BTreeMap<Str, PathBuf>, VaultError> {
	let body = match fs::read_to_string(path) {
		Ok(body) => body,
		Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
		Err(source) => {
			return Err(VaultError::Io {
				operation: VaultOperation::ReadConfiguration,
				path: path.to_path_buf(),
				source,
			});
		},
	};
	let parsed: VaultFile = toml::from_str(&body)
		.map_err(|source| VaultError::Parse { path: path.to_path_buf(), source })?;
	let base = path.parent().unwrap_or_else(|| Path::new("."));
	let mut roots = BTreeMap::new();
	for (name, configured_root) in parsed.vaults {
		validate_name(&name)?;
		let root = if configured_root.is_absolute() {
			configured_root
		} else {
			base.join(configured_root)
		};
		let canonical = root.canonicalize().map_err(|source| VaultError::Io {
			operation: VaultOperation::Resolve,
			path: root,
			source,
		})?;
		if !canonical.is_dir() {
			return Err(VaultError::NotDirectory { path: canonical });
		}
		roots.insert(name, canonical);
	}
	Ok(roots)
}

fn validate_name(name: &str) -> Result<(), VaultError> {
	if name.is_empty()
		|| name == "_"
		|| name.bytes().any(|byte| {
			byte.is_ascii_control() || matches!(byte, b'/' | b'\\' | b':' | b'@' | b'?' | b'#')
		}) {
		return Err(VaultError::InvalidName { name: Str::new(name) });
	}
	Ok(())
}

struct AtomicTemp {
	file:      Option<tokio::fs::File>,
	path:      PathBuf,
	committed: bool,
}

impl AtomicTemp {
	async fn create(parent: &Path) -> Result<Self, VaultError> {
		static NEXT_TEMP: AtomicU64 = AtomicU64::new(1);
		for _ in 0..32 {
			let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
			let path = parent.join(format!(".omp-vault-{}-{sequence}.tmp", std::process::id()));
			match tokio::fs::OpenOptions::new()
				.write(true)
				.create_new(true)
				.open(&path)
				.await
			{
				Ok(file) => return Ok(Self { file: Some(file), path, committed: false }),
				Err(source) if source.kind() == io::ErrorKind::AlreadyExists => {},
				Err(source) => {
					return Err(VaultError::Io {
						operation: VaultOperation::CreateTemporary,
						path,
						source,
					});
				},
			}
		}
		Err(VaultError::TemporaryNamesExhausted { path: parent.to_path_buf() })
	}

	fn file_mut(&mut self) -> &mut tokio::fs::File {
		self
			.file
			.as_mut()
			.expect("atomic temporary remains open until replacement")
	}

	fn close(&mut self) {
		drop(self.file.take());
	}
}

impl Drop for AtomicTemp {
	fn drop(&mut self) {
		drop(self.file.take());
		if !self.committed {
			let _ = fs::remove_file(&self.path);
		}
	}
}

/// Filesystem operation attached to a typed vault I/O failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "snake_case")]
pub enum VaultOperation {
	/// Read layered configuration.
	ReadConfiguration,
	/// Resolve a path through the filesystem.
	Resolve,
	/// Read metadata.
	ReadMetadata,
	/// Read file bytes.
	Read,
	/// Enumerate a directory.
	List,
	/// Create missing parent directories.
	CreateDirectory,
	/// Create an exclusive sibling temporary file.
	CreateTemporary,
	/// Write temporary bytes.
	Write,
	/// Apply preserved permissions.
	SetPermissions,
	/// Synchronize temporary bytes.
	Sync,
}

/// Captured Obsidian process channel.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "snake_case")]
pub enum ObsidianStream {
	/// Standard output.
	Stdout,
	/// Standard error.
	Stderr,
	/// The process handle itself.
	Process,
}

/// Typed failure from the configured vault authority.
#[derive(Debug, thiserror::Error)]
pub enum VaultError {
	/// Filesystem operation failed.
	#[error("cannot {operation} vault path {path}")]
	Io {
		/// Failed operation.
		operation: VaultOperation,
		/// Addressed filesystem path.
		path:      PathBuf,
		/// Typed operating-system cause.
		#[source]
		source:    io::Error,
	},
	/// Atomic destination publication or rollback failed.
	#[error("cannot atomically replace vault path {path}")]
	AtomicReplace {
		/// Destination path.
		path:   PathBuf,
		/// Typed atomic-publication cause.
		#[source]
		source: omp_core::fs::AtomicReplaceError,
	},
	/// Layer file could not be parsed.
	#[error("invalid vault configuration {path}")]
	Parse {
		/// Configuration path.
		path:   PathBuf,
		/// Typed TOML cause.
		#[source]
		source: de::Error,
	},
	/// Configured name is not legal in a vault URI authority or collides with
	/// the active-vault `_` sentinel.
	#[error("invalid vault name {name}")]
	InvalidName {
		/// Invalid name.
		name: Str,
	},
	/// Address path was absolute, empty-componented, or traversing.
	#[error("invalid or escaping vault path {path}")]
	InvalidPath {
		/// Invalid relative path.
		path: Str,
	},
	/// Addressed resource does not exist.
	#[error("vault path {path} does not exist")]
	NotFound {
		/// Missing path.
		path: PathBuf,
	},
	/// Vault root or addressed directory was not a directory.
	#[error("vault path {path} is not a directory")]
	NotDirectory {
		/// Addressed path.
		path: PathBuf,
	},
	/// Addressed file was a special filesystem object.
	#[error("vault path {path} is not a regular file")]
	NotFile {
		/// Addressed path.
		path: PathBuf,
	},
	/// A file operation addressed a directory.
	#[error("vault path {path} is a directory")]
	IsDirectory {
		/// Addressed path.
		path: PathBuf,
	},
	/// A write attempted to replace a symbolic link.
	#[error("vault write target {path} is a symbolic link")]
	SymlinkTarget {
		/// Symbolic-link path.
		path: PathBuf,
	},
	/// Vault was absent from configured layers and Obsidian discovery.
	#[error("vault {name} is not available")]
	Unknown {
		/// Missing effective name.
		name: Str,
	},
	/// Canonical resolution left the configured root.
	#[error("vault path {path} escapes its configured root")]
	Escape {
		/// Escaping canonical path.
		path: PathBuf,
	},
	/// File name could not be represented in an internal URL.
	#[error("vault entry name at {path} is not UTF-8")]
	NonUtf8Name {
		/// Entry path.
		path: PathBuf,
	},
	/// Read or write exceeded the authority byte ceiling.
	#[error("vault operation size {actual} exceeds its {limit}-byte bound")]
	Limit {
		/// Enforced maximum.
		limit:  usize,
		/// Observed byte length.
		actual: usize,
	},
	/// No Obsidian CLI executable was discoverable.
	#[error("Obsidian CLI binary not found; checked PATH and the platform application location")]
	ObsidianUnavailable,
	/// Obsidian CLI process creation failed.
	#[error("cannot start Obsidian CLI operation {operation} with {binary}")]
	ObsidianSpawn {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Discovered executable.
		binary:    PathBuf,
		/// Typed process creation cause.
		#[source]
		source:    io::Error,
	},
	/// A required process pipe was unavailable.
	#[error("Obsidian CLI operation {operation} did not expose {stream}")]
	ObsidianPipe {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Missing process channel.
		stream:    ObsidianStream,
	},
	/// Waiting for the Obsidian process failed.
	#[error("cannot wait for Obsidian CLI operation {operation}")]
	ObsidianWait {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Typed process wait cause.
		#[source]
		source:    io::Error,
	},
	/// Reading bounded Obsidian output failed.
	#[error("cannot read Obsidian CLI operation {operation} output")]
	ObsidianOutput {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Typed output read cause.
		#[source]
		source:    io::Error,
	},
	/// Obsidian output was not UTF-8.
	#[error("Obsidian CLI operation {operation} returned non-UTF-8 output")]
	ObsidianUtf8 {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Typed decoding cause.
		#[source]
		source:    std::str::Utf8Error,
	},
	/// Obsidian exceeded the host-owned output ceiling.
	#[error(
		"Obsidian CLI operation {operation} output size {actual} exceeds its {limit}-byte bound"
	)]
	ObsidianOutputLimit {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Enforced maximum.
		limit:     usize,
		/// Observed bytes.
		actual:    usize,
	},
	/// Obsidian exceeded the operation deadline and was killed and reaped.
	#[error("Obsidian CLI operation {operation} timed out after {timeout:?}")]
	ObsidianTimeout {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Enforced deadline.
		timeout:   Duration,
	},
	/// Obsidian failed or printed its documented `Error:` sentinel.
	#[error("Obsidian CLI operation {operation} failed with status {code:?}: {diagnostic}")]
	ObsidianFailed {
		/// Requested operation.
		operation:  ObsidianOperation,
		/// Platform exit code, when available.
		code:       Option<i32>,
		/// Bounded CLI diagnostic.
		diagnostic: Str,
	},
	/// The active-vault discovery response contained no path.
	#[error("Obsidian CLI returned no active vault path")]
	ObsidianActiveVaultMissing,
	/// An operation omitted one required query parameter.
	#[error("Obsidian CLI operation {operation} requires query parameter {name}")]
	MissingParameter {
		/// Requested operation.
		operation: ObsidianOperation,
		/// Required parameter.
		name:      &'static str,
	},
	/// Exclusive temporary names repeatedly collided.
	#[error("cannot allocate an atomic vault temporary file under {path}")]
	TemporaryNamesExhausted {
		/// Destination parent.
		path: PathBuf,
	},
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	fn write_config(path: &Path, entries: &[(&str, &Path)]) {
		fs::create_dir_all(path.parent().expect("config parent")).expect("config parent");
		let mut body = String::from("[vaults]\n");
		for (name, root) in entries {
			body.push_str(&format!("{name} = {:?}\n", root.display().to_string()));
		}
		fs::write(path, body).expect("vault config");
	}

	#[cfg(unix)]
	fn write_executable(path: &Path, body: &str) {
		use std::os::unix::fs::PermissionsExt as _;

		fs::write(path, body).expect("script");
		let mut permissions = fs::metadata(path).expect("script metadata").permissions();
		permissions.set_mode(0o700);
		fs::set_permissions(path, permissions).expect("script permissions");
	}

	#[tokio::test]
	async fn layered_roots_shadow_and_relative_roots_follow_their_declaring_file() {
		let temp = tempfile::tempdir().expect("tempdir");
		let user_root = temp.path().join("o2");
		let project_root = temp.path().join("project");
		let user_notes = user_root.join("user-notes");
		let project_notes = project_root.join("project-notes");
		let user_only = temp.path().join("user-only");
		for dir in [&user_notes, &project_notes, &user_only] {
			fs::create_dir_all(dir).expect("directory");
		}
		fs::write(user_notes.join("a.md"), "user").expect("user note");
		fs::write(project_notes.join("a.md"), "project").expect("project note");

		let paths = VaultPaths::new(&user_root, &project_root);
		assert_eq!(paths.user, user_root.join("vaults.toml"));
		assert_eq!(paths.project, project_root.join(".omp/vaults.toml"));
		write_config(&paths.user, &[("notes", Path::new("user-notes")), ("extra", &user_only)]);
		write_config(&paths.project, &[("notes", Path::new("../project-notes"))]);

		let service = VaultService::load_layered(&paths).expect("layered load");
		assert_eq!(service.names(), vec![sf!("extra"), sf!("notes")]);
		assert_eq!(
			service
				.read("notes", "a.md", 64)
				.await
				.expect("shadowed read")
				.as_ref(),
			b"project"
		);
		assert!(
			service
				.list("extra", "", 8)
				.await
				.expect("user-only vault")
				.0
				.is_empty()
		);
		assert!(matches!(service.read("absent", "a.md", 64).await, Err(VaultError::Unknown { .. })));

		let missing = VaultPaths::new(&temp.path().join("nope"), &temp.path().join("nope"));
		assert!(
			VaultService::load_layered(&missing)
				.expect("missing files are empty")
				.names()
				.is_empty()
		);
	}

	#[tokio::test]
	async fn writes_replace_atomically_and_bound_bytes() {
		let temp = tempfile::tempdir().expect("tempdir");
		let config = temp.path().join("vaults.toml");
		let root = temp.path().join("notes");
		fs::create_dir_all(&root).expect("vault root");
		write_config(&config, &[("notes", &root)]);
		let paths = VaultPaths { user: config, project: temp.path().join("missing.toml") };
		let service = VaultService::load_layered(&paths).expect("vault service");
		let file = root.join("nested/note.md");
		let revision = service
			.write("notes", "nested/note.md", b"first", 64)
			.await
			.expect("create");
		assert_eq!(fs::read(&file).expect("created bytes"), b"first");
		assert!(
			service
				.write("notes", "nested/note.md", b"second", 64)
				.await
				.expect("replace")
				> revision
		);
		assert_eq!(fs::read(&file).expect("replaced bytes"), b"second");
		assert!(matches!(
			service.write("notes", "too-big", b"12345", 4).await,
			Err(VaultError::Limit { actual: 5, .. })
		));
		assert!(fs::read_dir(file.parent().unwrap()).unwrap().all(|entry| {
			!entry
				.unwrap()
				.file_name()
				.to_string_lossy()
				.starts_with(".omp-vault-")
		}));
	}

	#[tokio::test]
	async fn cancelled_staging_removes_unpublished_temporary_bytes() {
		let temp = tempfile::tempdir().expect("tempdir");
		let mut staged = AtomicTemp::create(temp.path()).await.expect("staged file");
		staged
			.file_mut()
			.write_all(b"not published")
			.await
			.expect("staged bytes");
		let path = staged.path.clone();
		drop(staged);
		assert!(!path.exists());
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn configured_roots_override_obsidian_discovery() {
		let temp = tempfile::tempdir().expect("tempdir");
		let configured = temp.path().join("configured");
		let discovered = temp.path().join("discovered");
		let cli_only = temp.path().join("cli-only");
		for root in [&configured, &discovered, &cli_only] {
			fs::create_dir_all(root).expect("vault root");
		}
		fs::write(configured.join("note.md"), "configured").expect("configured note");
		fs::write(discovered.join("note.md"), "discovered").expect("discovered note");
		let config = temp.path().join("vaults.toml");
		write_config(&config, &[("notes", &configured)]);
		let script = temp.path().join("obsidian");
		write_executable(
			&script,
			&format!(
				"#!/bin/sh\nprintf 'notes\\t{}\\ncli\\t{}\\n'\n",
				discovered.display(),
				cli_only.display(),
			),
		);
		let service = VaultService::load_layered(&VaultPaths {
			user:    config,
			project: temp.path().join("missing"),
		})
		.expect("vault service")
		.with_obsidian_binary(Some(script));
		assert_eq!(
			service
				.names_with_obsidian()
				.await
				.expect("effective names"),
			vec![sf!("cli"), sf!("notes")]
		);
		assert_eq!(
			service
				.read("notes", "note.md", 64)
				.await
				.expect("configured wins")
				.as_ref(),
			b"configured"
		);
		assert!(
			service
				.list("cli", "", 8)
				.await
				.expect("discovered root")
				.0
				.is_empty()
		);
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn obsidian_operations_forward_exact_arguments_and_confine_paths() {
		let temp = tempfile::tempdir().expect("tempdir");
		let root = temp.path().join("notes");
		fs::create_dir_all(root.join("folder")).expect("vault root");
		fs::write(root.join("note.md"), "note").expect("note");
		let config = temp.path().join("vaults.toml");
		write_config(&config, &[("notes", &root)]);
		let log = temp.path().join("argv");
		let script = temp.path().join("obsidian");
		write_executable(
			&script,
			&format!("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '{}'\nprintf 'ok'\n", log.display(),),
		);
		let service = VaultService::load_layered(&VaultPaths {
			user:    config,
			project: temp.path().join("missing"),
		})
		.expect("vault service")
		.with_obsidian_binary(Some(script));

		assert_eq!(
			service
				.obsidian_read("notes", "note.md")
				.await
				.expect("read")
				.stdout
				.as_ref(),
			b"ok"
		);
		service
			.obsidian_create("notes", "folder/new.md", "body", true)
			.await
			.expect("create");
		service
			.obsidian_move("notes", "note.md", "folder/moved.md")
			.await
			.expect("move");
		service
			.obsidian_delete("notes", "note.md", true)
			.await
			.expect("delete");
		service
			.obsidian_open("notes", "note.md", true)
			.await
			.expect("open");
		service
			.obsidian_search("notes", &VaultSearch {
				query:          "needle",
				path:           Some("folder"),
				limit:          Some(3),
				case_sensitive: true,
			})
			.await
			.expect("search");
		assert_eq!(
			fs::read_to_string(log).expect("argv log"),
			concat!(
				"vault=notes read path=note.md\n",
				"vault=notes create path=folder/new.md content=body overwrite\n",
				"vault=notes move path=note.md to=folder/moved.md\n",
				"vault=notes delete path=note.md permanent\n",
				"vault=notes open path=note.md newtab\n",
				"vault=notes search:context query=needle path=folder limit=3 case format=json\n",
			)
		);
		assert!(matches!(
			service
				.obsidian_move("notes", "note.md", "../outside")
				.await,
			Err(VaultError::InvalidPath { .. })
		));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn dropping_cancelled_obsidian_future_kills_and_reaps_the_process_group() {
		let temp = tempfile::tempdir().expect("tempdir");
		let root = temp.path().join("notes");
		fs::create_dir_all(&root).expect("vault root");
		fs::write(root.join("note.md"), "note").expect("note");
		let config = temp.path().join("vaults.toml");
		write_config(&config, &[("notes", &root)]);
		let pid_file = temp.path().join("pid");
		let script = temp.path().join("obsidian");
		write_executable(
			&script,
			&format!(
				"#!/bin/sh\nsleep 30 &\nprintf '%s %s' \"$$\" \"$!\" > '{}'\nwait\n",
				pid_file.display(),
			),
		);
		let service = VaultService::load_layered(&VaultPaths {
			user:    config,
			project: temp.path().join("missing"),
		})
		.expect("vault service")
		.with_obsidian_binary(Some(script));
		let task = tokio::spawn(async move { service.obsidian_read("notes", "note.md").await });
		for _ in 0..100 {
			if pid_file.exists() {
				break;
			}
			time::sleep(Duration::from_millis(5)).await;
		}
		let pids = fs::read_to_string(&pid_file)
			.expect("process ids")
			.split_whitespace()
			.map(|pid| pid.parse::<i32>().expect("numeric pid"))
			.collect::<Vec<_>>();
		assert_eq!(pids.len(), 2);
		task.abort();
		assert!(task.await.expect_err("cancelled task").is_cancelled());
		for _ in 0..100 {
			let all_gone = pids.iter().all(|pid| {
				// SAFETY: signal 0 does not deliver a signal; it only probes
				// whether the exact process still exists.
				(unsafe { libc::kill(*pid, 0) }) == -1
					&& io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
			});
			if all_gone {
				return;
			}
			time::sleep(Duration::from_millis(5)).await;
		}
		panic!("cancelled Obsidian process group was not reaped");
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn obsidian_timeout_kills_and_reaps_the_process_group() {
		let temp = tempfile::tempdir().expect("tempdir");
		let root = temp.path().join("notes");
		fs::create_dir_all(&root).expect("vault root");
		fs::write(root.join("note.md"), "note").expect("note");
		let config = temp.path().join("vaults.toml");
		write_config(&config, &[("notes", &root)]);
		let script = temp.path().join("obsidian");
		write_executable(&script, "#!/bin/sh\nsleep 30\n");
		let mut service = VaultService::load_layered(&VaultPaths {
			user:    config,
			project: temp.path().join("missing"),
		})
		.expect("vault service")
		.with_obsidian_binary(Some(script));
		service.obsidian.timeout = Duration::from_millis(25);
		assert!(matches!(
			service.obsidian_read("notes", "note.md").await,
			Err(VaultError::ObsidianTimeout { operation: ObsidianOperation::Read, .. })
		));
	}

	#[cfg(unix)]
	#[tokio::test]
	async fn read_list_and_write_reject_symlink_escapes() {
		use std::os::unix::fs::symlink;

		let temp = tempfile::tempdir().expect("tempdir");
		let root = temp.path().join("notes");
		let outside = temp.path().join("outside");
		fs::create_dir_all(&root).expect("vault root");
		fs::create_dir_all(&outside).expect("outside root");
		fs::write(outside.join("secret"), "nope").expect("outside file");
		symlink(&outside, root.join("escape")).expect("escape link");
		let config = temp.path().join("vaults.toml");
		write_config(&config, &[("notes", &root)]);
		let service = VaultService::load_layered(&VaultPaths {
			user:    config,
			project: temp.path().join("missing"),
		})
		.expect("vault service");
		assert!(matches!(
			service.read("notes", "escape/secret", 64).await,
			Err(VaultError::Escape { .. })
		));
		assert!(matches!(service.list("notes", "escape", 64).await, Err(VaultError::Escape { .. })));
		assert!(matches!(
			service.write("notes", "escape/new", b"nope", 64).await,
			Err(VaultError::Escape { .. })
		));
		assert!(!outside.join("new").exists());
	}
}
