//! The [`Fs`] (async) and [`BlockingFs`] (sync) facades.
//!
//! Every operation routes its path first: descriptor overlays
//! ([`Fs::mount_file`]) win, then host paths go straight to `std`/libc
//! (no futures, no boxing) when there is no provider or the provider declares
//! them [`FileSystem::is_native_local`], and everything else is awaited on
//! the provider. A URL reaching a facade without a provider is `NotFound`;
//! it is never resolved against the process working directory.

use std::{
	ffi::{OsStr, OsString},
	fmt,
	hash::{BuildHasher, Hasher, RandomState},
	io::{self, Seek, SeekFrom},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{SystemTime, UNIX_EPOCH},
};

use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::{
	dir::{EntryBinding, ReadDir},
	error::{
		already_exists, invalid_argument, no_provider, not_a_directory, not_permitted,
		permission_denied, unsupported,
	},
	file::{COPY_CHUNK, File},
	metadata::Metadata,
	native,
	options::{CanonicalizeOptions, DirOptions, OpenOptions, TempOptions},
	path::{is_virtual_path, join_path},
	provider::FileSystem,
	runtime::{CloseTracker, Scope, block_on},
	types::{FileId, FileTime, NodeKind, Permissions, StatFs, SymlinkKind},
};

/// A path pinned to an already-open file (`/dev/stdin`, `/dev/fd/N`, ...).
struct Mount {
	path: PathBuf,
	file: File,
}

enum Route<'a> {
	Native,
	Provider(&'a Arc<dyn FileSystem>),
	Mounted(&'a File),
}

enum PairRoute<'a> {
	Native,
	Provider(&'a Arc<dyn FileSystem>),
}

/// Cloneable asynchronous filesystem; the default is the host filesystem.
///
/// Clones, [`Fs::blocking`] views, [`Fs::with_cancellation`] views, and
/// [`Fs::mount_file`] overlays share one provider and one close tracker.
#[derive(Clone, Default)]
pub struct Fs {
	provider: Option<Arc<dyn FileSystem>>,
	mounts:   Option<Arc<Vec<Arc<Mount>>>>,
	scope:    Scope,
}

impl fmt::Debug for Fs {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		let mounts: Vec<&Path> = self
			.mounts
			.iter()
			.flat_map(|mounts| mounts.iter())
			.map(|m| m.path.as_path())
			.collect();
		f.debug_struct("Fs")
			.field("provider", &self.provider)
			.field("mounts", &mounts)
			.field("cancellable", &self.scope.cancel.is_some())
			.finish()
	}
}

/// Synchronous twin of [`Fs`] for blocking workers and foreign threads.
///
/// Host operations are direct syscalls; provider operations are driven to
/// completion on the calling thread (see the crate docs for the threading
/// contract). Never call provider-backed operations from a current-thread
/// runtime's own thread.
#[derive(Clone, Default)]
pub struct BlockingFs {
	fs:      Fs,
	runtime: Option<Handle>,
}

impl fmt::Debug for BlockingFs {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("BlockingFs").field(&self.fs).finish()
	}
}

const TEMP_ATTEMPTS: u32 = 1 << 16;

fn random_name(len: usize) -> String {
	const ALPHABET: &[u8; 62] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
	static COUNTER: AtomicU64 = AtomicU64::new(0);
	let state = RandomState::new();
	let mut out = String::with_capacity(len);
	let (mut word, mut left) = (0u64, 0u32);
	while out.len() < len {
		if left == 0 {
			let mut hasher = state.build_hasher();
			hasher.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
			hasher.write_u128(
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.map_or(0, |d| d.as_nanos()),
			);
			hasher.write_u32(std::process::id());
			word = hasher.finish();
			left = 10;
		}
		out.push(ALPHABET[(word % 62) as usize] as char);
		word /= 62;
		left -= 1;
	}
	out
}

fn temp_file_options(options: &TempOptions) -> OpenOptions {
	let mut open = OpenOptions::new();
	open
		.read(true)
		.write(true)
		.create_new(true)
		.mode(options.get_mode().unwrap_or(0o600));
	open
}

fn temp_dir_options(options: &TempOptions) -> DirOptions {
	DirOptions::new().mode(options.get_mode().unwrap_or(0o700))
}

fn too_many_temps() -> io::Error {
	io::Error::new(io::ErrorKind::AlreadyExists, "too many temporary files exist")
}

fn into_utf8(bytes: Vec<u8>) -> io::Result<String> {
	String::from_utf8(bytes)
		.map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8"))
}

fn identity_result(a: io::Result<FileId>, b: io::Result<FileId>) -> io::Result<bool> {
	match (a, b) {
		(Ok(a), Ok(b)) => Ok(a == b),
		(Err(err), _) | (_, Err(err)) if err.kind() == io::ErrorKind::Unsupported => Ok(false),
		(Err(err), _) | (_, Err(err)) => Err(err),
	}
}

fn not_found_is_false(result: io::Result<Metadata>) -> io::Result<bool> {
	match result {
		Ok(_) => Ok(true),
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(false),
		Err(err) => Err(err),
	}
}

fn blocks_to_bytes(metadata: &Metadata) -> io::Result<u64> {
	metadata
		.blocks()
		.map(|blocks| blocks * 512)
		.ok_or_else(|| unsupported("allocated size"))
}

// Descriptor overlay semantics: opening re-uses the pinned file (shared
// offset, like `dup`), truncation/append apply to regular files, and
// namespace mutations are refused.

fn mount_open(file: &File, options: &OpenOptions) -> io::Result<File> {
	if options.is_create_new() {
		return Err(already_exists());
	}
	let clone = file.try_clone()?;
	if (options.is_truncate() || options.is_append()) && clone.metadata()?.is_file() {
		if options.is_truncate() && options.is_writable() {
			clone.set_len(0)?;
			(&clone).seek(SeekFrom::Start(0))?;
		}
		if options.is_append() {
			(&clone).seek(SeekFrom::End(0))?;
		}
	}
	Ok(clone)
}

async fn mount_open_async(file: &File, options: &OpenOptions) -> io::Result<File> {
	if options.is_create_new() {
		return Err(already_exists());
	}
	let clone = file.try_clone()?;
	if (options.is_truncate() || options.is_append()) && clone.metadata_async().await?.is_file() {
		if options.is_truncate() && options.is_writable() {
			clone.set_len_async(0).await?;
			clone.seek_async(SeekFrom::Start(0)).await?;
		}
		if options.is_append() {
			clone.seek_async(SeekFrom::End(0)).await?;
		}
	}
	Ok(clone)
}

fn mount_access(execute: bool) -> io::Result<()> {
	if execute {
		Err(permission_denied())
	} else {
		Ok(())
	}
}

fn mount_stat_fs(file: &File) -> io::Result<StatFs> {
	match file.native() {
		Some(native) => native::fstat_fs(native),
		None => Err(unsupported("statfs")),
	}
}

fn read_options() -> OpenOptions {
	let mut options = OpenOptions::new();
	options.read(true);
	options
}

fn create_options() -> OpenOptions {
	let mut options = OpenOptions::new();
	options.write(true).create(true).truncate(true);
	options
}

impl Fs {
	/// The host filesystem.
	pub fn native() -> Self {
		Self::default()
	}

	/// A filesystem backed by `provider`.
	pub fn new(provider: Arc<dyn FileSystem>) -> Self {
		Self {
			provider: Some(provider),
			mounts:   None,
			scope:    Scope { cancel: None, closes: Some(Arc::new(CloseTracker::default())) },
		}
	}

	/// Synchronous view; captures the current tokio runtime (if any) to drive
	/// provider calls from threads outside it.
	pub fn blocking(&self) -> BlockingFs {
		BlockingFs { fs: self.clone(), runtime: Handle::try_current().ok() }
	}

	/// No provider is installed.
	pub const fn is_native(&self) -> bool {
		self.provider.is_none()
	}

	pub const fn provider(&self) -> Option<&Arc<dyn FileSystem>> {
		self.provider.as_ref()
	}

	/// Same provider and overlays (cancellation scope is not compared).
	pub fn ptr_eq(&self, other: &Self) -> bool {
		let providers = match (&self.provider, &other.provider) {
			(None, None) => true,
			(Some(a), Some(b)) => std::ptr::addr_eq(Arc::as_ptr(a), Arc::as_ptr(b)),
			_ => false,
		};
		let mounts = match (&self.mounts, &other.mounts) {
			(None, None) => true,
			(Some(a), Some(b)) => Arc::ptr_eq(a, b),
			_ => false,
		};
		providers && mounts
	}

	/// `path` and everything below it are plain host filesystem objects, so
	/// host fast paths (fd traversal, native walkers, mmap) may bypass this
	/// facade. Always `false` for URLs and descriptor overlays.
	pub fn is_native_local(&self, path: impl AsRef<Path>) -> bool {
		matches!(self.route(path.as_ref()), Ok(Route::Native))
	}

	/// A view whose provider operations, and data operations on provider files
	/// opened through it, fail with [`crate::cancelled`] once `token` is
	/// cancelled. Closes are never cancelled; host operations are unaffected.
	pub fn with_cancellation(&self, token: CancellationToken) -> Self {
		let mut fs = self.clone();
		fs.scope.cancel = Some(token);
		fs
	}

	/// The same filesystem without cancellation, for deleting the caller's
	/// own temporary artifacts in `Drop`/error paths after a cancelled run.
	/// Providers may substitute a cleanup view ([`FileSystem::for_cleanup`]).
	pub fn for_cleanup(&self) -> Self {
		let mut fs = self.clone();
		fs.scope.cancel = None;
		if let Some(cleanup) = self
			.provider
			.as_ref()
			.and_then(|provider| provider.for_cleanup())
		{
			fs.provider = Some(cleanup);
		}
		fs
	}

	/// A view in which `path` names `file` itself (descriptor overlay), e.g.
	/// `/dev/stdin` for a provider-backed stdin. Opening the path re-uses the
	/// file (shared offset), metadata comes from the file, timestamps and
	/// permissions apply to it, and namespace mutations fail with `EPERM`.
	pub fn mount_file(&self, path: impl Into<PathBuf>, file: File) -> Self {
		let path = path.into();
		let mut mounts: Vec<Arc<Mount>> = self
			.mounts
			.iter()
			.flat_map(|mounts| mounts.iter())
			.filter(|mount| mount.path != path)
			.cloned()
			.collect();
		mounts.push(Arc::new(Mount { path, file }));
		let mut fs = self.clone();
		fs.mounts = Some(Arc::new(mounts));
		fs
	}

	/// Waits for background closes of provider files that were dropped
	/// without [`File::close`], returning the first close error.
	pub async fn drain_closes(&self) -> io::Result<()> {
		match &self.scope.closes {
			Some(closes) => closes.drain().await,
			None => Ok(()),
		}
	}

	fn mounted(&self, path: &Path) -> Option<&File> {
		self
			.mounts
			.as_ref()?
			.iter()
			.find(|mount| mount.path == path)
			.map(|mount| &mount.file)
	}

	fn route(&self, path: &Path) -> io::Result<Route<'_>> {
		if let Some(file) = self.mounted(path) {
			return Ok(Route::Mounted(file));
		}
		match &self.provider {
			None if is_virtual_path(path) => Err(no_provider(path)),
			None => Ok(Route::Native),
			Some(provider) if provider.is_native_local(path) => Ok(Route::Native),
			Some(provider) => Ok(Route::Provider(provider)),
		}
	}

	fn route_pair(&self, a: &Path, b: &Path) -> io::Result<PairRoute<'_>> {
		match (self.route(a)?, self.route(b)?) {
			(Route::Mounted(_), _) | (_, Route::Mounted(_)) => Err(not_permitted()),
			(Route::Native, Route::Native) => Ok(PairRoute::Native),
			(Route::Provider(provider), _) | (_, Route::Provider(provider)) => {
				Ok(PairRoute::Provider(provider))
			},
		}
	}

	async fn guard<T>(&self, fut: impl Future<Output = io::Result<T>>) -> io::Result<T> {
		Scope::guard(self.scope.cancel.as_ref(), fut).await
	}

	fn entry_binding(
		&self,
		provider: &Arc<dyn FileSystem>,
		runtime: Option<Handle>,
	) -> EntryBinding {
		EntryBinding { provider: Arc::clone(provider), runtime, cancel: self.scope.cancel.clone() }
	}

	pub async fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &read_options()).await
	}

	/// Opens for writing, creating or truncating.
	pub async fn create(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &create_options()).await
	}

	pub async fn open_with(
		&self,
		path: impl AsRef<Path>,
		options: &OpenOptions,
	) -> io::Result<File> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::open(path, options),
			Route::Provider(provider) => Ok(self
				.guard(provider.open(path, options))
				.await?
				.bind(&self.scope)),
			Route::Mounted(file) => mount_open_async(file, options).await,
		}
	}

	/// Creates a uniquely named file in `dir` (`create_new`, retried on
	/// collisions) and returns its path and read/write handle.
	pub async fn create_temp(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<(PathBuf, File)> {
		let dir = dir.as_ref();
		let open = temp_file_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.open_with(&path, &open).await {
				Ok(file) => return Ok((path, file)),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	/// Creates a uniquely named directory in `dir`.
	pub async fn create_temp_dir(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<PathBuf> {
		let dir = dir.as_ref();
		let create = temp_dir_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.create_dir_with(&path, &create).await {
				Ok(()) => return Ok(path),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	pub async fn read(&self, path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::read(path),
			Route::Provider(provider) => self.guard(provider.read(path)).await,
			Route::Mounted(file) => {
				let file = mount_open_async(file, &read_options()).await?;
				let mut contents = Vec::new();
				file.read_to_end_async(&mut contents).await?;
				Ok(contents)
			},
		}
	}

	pub async fn read_to_string(&self, path: impl AsRef<Path>) -> io::Result<String> {
		into_utf8(self.read(path).await?)
	}

	/// Replaces the contents of `path`, creating it if needed.
	pub async fn write(&self, path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
		let (path, contents) = (path.as_ref(), contents.as_ref());
		match self.route(path)? {
			Route::Native => std::fs::write(path, contents),
			Route::Provider(provider) => self.guard(provider.write(path, contents)).await,
			Route::Mounted(file) => {
				mount_open_async(file, &create_options())
					.await?
					.write_all_async(contents)
					.await
			},
		}
	}

	pub async fn metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::metadata(path),
			Route::Provider(provider) => self.guard(provider.metadata(path)).await,
			Route::Mounted(file) => file.metadata_async().await,
		}
	}

	pub async fn symlink_metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::symlink_metadata(path),
			Route::Provider(provider) => self.guard(provider.symlink_metadata(path)).await,
			Route::Mounted(file) => file.metadata_async().await,
		}
	}

	async fn metadata_follow(&self, path: &Path, follow: bool) -> io::Result<Metadata> {
		if follow {
			self.metadata(path).await
		} else {
			self.symlink_metadata(path).await
		}
	}

	pub async fn read_dir(&self, path: impl AsRef<Path>) -> io::Result<ReadDir> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::read_dir(path),
			Route::Provider(provider) => {
				let read_dir = self.guard(provider.read_dir(path)).await?;
				Ok(read_dir.bind(self.entry_binding(provider, Handle::try_current().ok())))
			},
			Route::Mounted(_) => Err(not_a_directory()),
		}
	}

	/// `std::fs::canonicalize` semantics (every component must exist).
	pub async fn canonicalize(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::canonicalize(path),
			Route::Provider(provider) => {
				self
					.guard(provider.canonicalize(path, &CanonicalizeOptions::default()))
					.await
			},
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// uucore `canonicalize` semantics, URL-aware.
	pub async fn canonicalize_with(
		&self,
		path: impl AsRef<Path>,
		options: &CanonicalizeOptions,
	) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::canonicalize_with(path, *options),
			Route::Provider(provider) => self.guard(provider.canonicalize(path, options)).await,
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// The absolute host path a provider path aliases, if any (see
	/// [`FileSystem::backing_path`]); `None` for host paths.
	pub async fn backing_path(&self, path: impl AsRef<Path>) -> io::Result<Option<PathBuf>> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native | Route::Mounted(_) => Ok(None),
			Route::Provider(provider) => self.guard(provider.backing_path(path)).await,
		}
	}

	pub async fn read_link(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::read_link(path),
			Route::Provider(provider) => self.guard(provider.read_link(path)).await,
			Route::Mounted(_) => Err(invalid_argument()),
		}
	}

	pub async fn create_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self.create_dir_with(path, &DirOptions::new()).await
	}

	pub async fn create_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self
			.create_dir_with(path, &DirOptions::new().recursive(true))
			.await
	}

	pub async fn create_dir_with(
		&self,
		path: impl AsRef<Path>,
		options: &DirOptions,
	) -> io::Result<()> {
		let path = path.as_ref();
		let (mode, recursive) = (options.get_mode(), options.is_recursive());
		match self.route(path)? {
			Route::Native => native::create_dir(path, mode, recursive),
			Route::Provider(provider) if recursive => {
				self.guard(provider.create_dir_all(path, mode)).await
			},
			Route::Provider(provider) => self.guard(provider.create_dir(path, mode)).await,
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	pub async fn remove_file(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::remove_file(path),
			Route::Provider(provider) => self.guard(provider.remove_file(path)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub async fn remove_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::remove_dir(path),
			Route::Provider(provider) => self.guard(provider.remove_dir(path)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub async fn remove_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => std::fs::remove_dir_all(path),
			Route::Provider(provider) => self.guard(provider.remove_dir_all(path)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// Renames within one backend; across backends the provider reports
	/// `EXDEV` and nothing is copied.
	pub async fn rename(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match self.route_pair(from, to)? {
			PairRoute::Native => std::fs::rename(from, to),
			PairRoute::Provider(provider) => self.guard(provider.rename(from, to)).await,
		}
	}

	/// Copies contents and permission bits; returns the byte count.
	pub async fn copy(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match (self.route(from)?, self.route(to)?) {
			(Route::Native, Route::Native) => std::fs::copy(from, to),
			(Route::Mounted(_), _) | (_, Route::Mounted(_)) => {
				let source = self.open(from).await?;
				let target = self.create(to).await?;
				let mut chunk = vec![0; COPY_CHUNK];
				let mut copied = 0u64;
				loop {
					let n = source.read_async(&mut chunk).await?;
					if n == 0 {
						break;
					}
					target.write_all_async(&chunk[..n]).await?;
					copied += n as u64;
				}
				target.close_async().await?;
				Ok(copied)
			},
			(Route::Provider(provider), _) | (_, Route::Provider(provider)) => {
				self.guard(provider.copy(from, to)).await
			},
		}
	}

	pub async fn hard_link(
		&self,
		original: impl AsRef<Path>,
		link: impl AsRef<Path>,
	) -> io::Result<()> {
		let (original, link) = (original.as_ref(), link.as_ref());
		match self.route_pair(original, link)? {
			PairRoute::Native => std::fs::hard_link(original, link),
			PairRoute::Provider(provider) => self.guard(provider.hard_link(original, link)).await,
		}
	}

	/// Creates `link` pointing at `target` (stored verbatim). Windows picks a
	/// file or directory link from the target.
	pub async fn symlink(&self, target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
		self.symlink_with(target, link, SymlinkKind::Auto).await
	}

	pub async fn symlink_with(
		&self,
		target: impl AsRef<Path>,
		link: impl AsRef<Path>,
		kind: SymlinkKind,
	) -> io::Result<()> {
		let (target, link) = (target.as_ref(), link.as_ref());
		match self.route(link)? {
			Route::Native => native::symlink(target, link, kind),
			Route::Provider(provider) => self.guard(provider.symlink(target, link, kind)).await,
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	/// Follows symlinks.
	pub async fn set_permissions(
		&self,
		path: impl AsRef<Path>,
		permissions: Permissions,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::set_permissions(path, permissions),
			Route::Provider(provider) => {
				self
					.guard(provider.set_permissions(path, permissions))
					.await
			},
			Route::Mounted(file) => file.set_permissions_async(permissions).await,
		}
	}

	/// `utimensat`: [`FileTime::Omit`] keeps a timestamp, [`FileTime::Now`]
	/// uses the filesystem clock; `follow = false` updates a symlink itself.
	pub async fn set_times(
		&self,
		path: impl AsRef<Path>,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		let (accessed, modified) = (accessed.into(), modified.into());
		match self.route(path)? {
			Route::Native => native::set_times(path, accessed, modified, follow),
			Route::Provider(provider) => {
				self
					.guard(provider.set_times(path, accessed, modified, follow))
					.await
			},
			Route::Mounted(file) => file.set_times_async(accessed, modified).await,
		}
	}

	pub async fn chown(
		&self,
		path: impl AsRef<Path>,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::chown(path, uid, gid, follow),
			Route::Provider(provider) => self.guard(provider.chown(path, uid, gid, follow)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// `access(2)`; with every flag `false` it checks existence.
	pub async fn access(
		&self,
		path: impl AsRef<Path>,
		read: bool,
		write: bool,
		execute: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::access(path, read, write, execute),
			Route::Provider(provider) => {
				self
					.guard(provider.access(path, read, write, execute))
					.await
			},
			Route::Mounted(_) => mount_access(execute),
		}
	}

	/// `Ok(false)` only for `NotFound`; other errors propagate.
	pub async fn try_exists(&self, path: impl AsRef<Path>) -> io::Result<bool> {
		not_found_is_false(self.metadata(path).await)
	}

	/// Follows symlinks; any error is `false`.
	pub async fn exists(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).await.is_ok()
	}

	pub async fn is_file(&self, path: impl AsRef<Path>) -> bool {
		self
			.metadata(path)
			.await
			.is_ok_and(|metadata| metadata.is_file())
	}

	pub async fn is_dir(&self, path: impl AsRef<Path>) -> bool {
		self
			.metadata(path)
			.await
			.is_ok_and(|metadata| metadata.is_dir())
	}

	pub async fn is_symlink(&self, path: impl AsRef<Path>) -> bool {
		self
			.symlink_metadata(path)
			.await
			.is_ok_and(|metadata| metadata.is_symlink())
	}

	/// Identity of the object at `path`; `Unsupported` when the backend has
	/// none.
	pub async fn file_id(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<FileId> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::file_id(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)
				.await?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
			Route::Mounted(file) => file
				.metadata_async()
				.await?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
		}
	}

	/// Both paths name the same object (following symlinks); `false` when
	/// either backend has no identity to compare.
	pub async fn same_file(&self, a: impl AsRef<Path>, b: impl AsRef<Path>) -> io::Result<bool> {
		identity_result(self.file_id(a, true).await, self.file_id(b, true).await)
	}

	pub async fn link_count(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<u64> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::link_count(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)
				.await?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
			Route::Mounted(file) => file
				.metadata_async()
				.await?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
		}
	}

	/// Bytes allocated on disk (following symlinks).
	pub async fn allocated_size(&self, path: impl AsRef<Path>) -> io::Result<u64> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::allocated_size(path),
			Route::Provider(_) => blocks_to_bytes(&self.metadata(path).await?),
			Route::Mounted(file) => blocks_to_bytes(&file.metadata_async().await?),
		}
	}

	pub async fn stat_fs(&self, path: impl AsRef<Path>) -> io::Result<StatFs> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::stat_fs(path),
			Route::Provider(provider) => self.guard(provider.stat_fs(path)).await,
			Route::Mounted(file) => mount_stat_fs(file),
		}
	}

	pub async fn list_xattr(
		&self,
		path: impl AsRef<Path>,
		follow: bool,
	) -> io::Result<Vec<OsString>> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::list_xattr(path, follow),
			Route::Provider(provider) => self.guard(provider.list_xattr(path, follow)).await,
			Route::Mounted(_) => Err(unsupported("listxattr")),
		}
	}

	/// `Ok(None)` when the attribute is absent.
	pub async fn get_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.route(path)? {
			Route::Native => native::get_xattr(path, name, follow),
			Route::Provider(provider) => self.guard(provider.get_xattr(path, name, follow)).await,
			Route::Mounted(_) => Err(unsupported("getxattr")),
		}
	}

	pub async fn set_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		value: &[u8],
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.route(path)? {
			Route::Native => native::set_xattr(path, name, value, follow),
			Route::Provider(provider) => {
				self
					.guard(provider.set_xattr(path, name, value, follow))
					.await
			},
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub async fn remove_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.route(path)? {
			Route::Native => native::remove_xattr(path, name, follow),
			Route::Provider(provider) => self.guard(provider.remove_xattr(path, name, follow)).await,
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// `mkfifo(path, mode)` (umask applies).
	pub async fn make_fifo(&self, path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
		self.make_node(path, NodeKind::Fifo, mode).await
	}

	/// `mknod(path, kind | mode, dev)` (umask applies).
	pub async fn make_node(
		&self,
		path: impl AsRef<Path>,
		kind: NodeKind,
		mode: u32,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.route(path)? {
			Route::Native => native::make_node(path, kind, mode),
			Route::Provider(provider) => self.guard(provider.make_node(path, kind, mode)).await,
			Route::Mounted(_) => Err(already_exists()),
		}
	}
}

impl BlockingFs {
	/// The host filesystem.
	pub fn native() -> Self {
		Self::default()
	}

	/// The async facade this view wraps.
	pub const fn as_async(&self) -> &Fs {
		&self.fs
	}

	pub fn to_async(&self) -> Fs {
		self.fs.clone()
	}

	pub const fn is_native(&self) -> bool {
		self.fs.is_native()
	}

	pub const fn provider(&self) -> Option<&Arc<dyn FileSystem>> {
		self.fs.provider()
	}

	pub fn ptr_eq(&self, other: &Self) -> bool {
		self.fs.ptr_eq(&other.fs)
	}

	/// See [`Fs::is_native_local`].
	pub fn is_native_local(&self, path: impl AsRef<Path>) -> bool {
		self.fs.is_native_local(path)
	}

	/// See [`Fs::with_cancellation`].
	pub fn with_cancellation(&self, token: CancellationToken) -> Self {
		Self { fs: self.fs.with_cancellation(token), runtime: self.runtime.clone() }
	}

	/// See [`Fs::mount_file`].
	pub fn mount_file(&self, path: impl Into<PathBuf>, file: File) -> Self {
		Self { fs: self.fs.mount_file(path, file), runtime: self.runtime.clone() }
	}

	/// See [`Fs::for_cleanup`].
	pub fn for_cleanup(&self) -> Self {
		Self { fs: self.fs.for_cleanup(), runtime: self.runtime.clone() }
	}

	/// See [`Fs::drain_closes`].
	pub fn drain_closes(&self) -> io::Result<()> {
		match &self.fs.scope.closes {
			Some(closes) => closes.drain_blocking(self.runtime.as_ref()),
			None => Ok(()),
		}
	}

	fn run<T>(&self, fut: impl Future<Output = io::Result<T>>) -> io::Result<T> {
		block_on(self.runtime.as_ref(), Scope::guard(self.fs.scope.cancel.as_ref(), fut))
	}

	pub fn open(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &read_options())
	}

	/// Opens for writing, creating or truncating.
	pub fn create(&self, path: impl AsRef<Path>) -> io::Result<File> {
		self.open_with(path, &create_options())
	}

	pub fn open_with(&self, path: impl AsRef<Path>, options: &OpenOptions) -> io::Result<File> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::open(path, options),
			Route::Provider(provider) => {
				Ok(self.run(provider.open(path, options))?.bind(&self.fs.scope))
			},
			Route::Mounted(file) => mount_open(file, options),
		}
	}

	/// See [`Fs::create_temp`].
	pub fn create_temp(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<(PathBuf, File)> {
		let dir = dir.as_ref();
		let open = temp_file_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.open_with(&path, &open) {
				Ok(file) => return Ok((path, file)),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	/// See [`Fs::create_temp_dir`].
	pub fn create_temp_dir(
		&self,
		dir: impl AsRef<Path>,
		options: &TempOptions,
	) -> io::Result<PathBuf> {
		let dir = dir.as_ref();
		let create = temp_dir_options(options);
		let attempts = if options.get_random_len() == 0 {
			1
		} else {
			TEMP_ATTEMPTS
		};
		for _ in 0..attempts {
			let path =
				join_path(dir, Path::new(&options.name(&random_name(options.get_random_len()))));
			match self.create_dir_with(&path, &create) {
				Ok(()) => return Ok(path),
				Err(err) if err.kind() == io::ErrorKind::AlreadyExists && attempts > 1 => {},
				Err(err) => return Err(err),
			}
		}
		Err(too_many_temps())
	}

	pub fn read(&self, path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::read(path),
			Route::Provider(provider) => self.run(provider.read(path)),
			Route::Mounted(file) => {
				let mut contents = Vec::new();
				io::Read::read_to_end(&mut mount_open(file, &read_options())?, &mut contents)?;
				Ok(contents)
			},
		}
	}

	pub fn read_to_string(&self, path: impl AsRef<Path>) -> io::Result<String> {
		into_utf8(self.read(path)?)
	}

	/// Replaces the contents of `path`, creating it if needed.
	pub fn write(&self, path: impl AsRef<Path>, contents: impl AsRef<[u8]>) -> io::Result<()> {
		let (path, contents) = (path.as_ref(), contents.as_ref());
		match self.fs.route(path)? {
			Route::Native => std::fs::write(path, contents),
			Route::Provider(provider) => self.run(provider.write(path, contents)),
			Route::Mounted(file) => {
				io::Write::write_all(&mut mount_open(file, &create_options())?, contents)
			},
		}
	}

	pub fn metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::metadata(path),
			Route::Provider(provider) => self.run(provider.metadata(path)),
			Route::Mounted(file) => file.metadata(),
		}
	}

	pub fn symlink_metadata(&self, path: impl AsRef<Path>) -> io::Result<Metadata> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::symlink_metadata(path),
			Route::Provider(provider) => self.run(provider.symlink_metadata(path)),
			Route::Mounted(file) => file.metadata(),
		}
	}

	fn metadata_follow(&self, path: &Path, follow: bool) -> io::Result<Metadata> {
		if follow {
			self.metadata(path)
		} else {
			self.symlink_metadata(path)
		}
	}

	pub fn read_dir(&self, path: impl AsRef<Path>) -> io::Result<ReadDir> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::read_dir(path),
			Route::Provider(provider) => {
				let read_dir = self.run(provider.read_dir(path))?;
				let runtime = self.runtime.clone().or_else(|| Handle::try_current().ok());
				Ok(read_dir.bind(self.fs.entry_binding(provider, runtime)))
			},
			Route::Mounted(_) => Err(not_a_directory()),
		}
	}

	/// See [`Fs::canonicalize`].
	pub fn canonicalize(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::canonicalize(path),
			Route::Provider(provider) => {
				self.run(provider.canonicalize(path, &CanonicalizeOptions::default()))
			},
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// See [`Fs::canonicalize_with`].
	pub fn canonicalize_with(
		&self,
		path: impl AsRef<Path>,
		options: &CanonicalizeOptions,
	) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::canonicalize_with(path, *options),
			Route::Provider(provider) => self.run(provider.canonicalize(path, options)),
			Route::Mounted(_) => Ok(path.to_path_buf()),
		}
	}

	/// See [`Fs::backing_path`].
	pub fn backing_path(&self, path: impl AsRef<Path>) -> io::Result<Option<PathBuf>> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native | Route::Mounted(_) => Ok(None),
			Route::Provider(provider) => self.run(provider.backing_path(path)),
		}
	}

	pub fn read_link(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::read_link(path),
			Route::Provider(provider) => self.run(provider.read_link(path)),
			Route::Mounted(_) => Err(invalid_argument()),
		}
	}

	pub fn create_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self.create_dir_with(path, &DirOptions::new())
	}

	pub fn create_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		self.create_dir_with(path, &DirOptions::new().recursive(true))
	}

	pub fn create_dir_with(&self, path: impl AsRef<Path>, options: &DirOptions) -> io::Result<()> {
		let path = path.as_ref();
		let (mode, recursive) = (options.get_mode(), options.is_recursive());
		match self.fs.route(path)? {
			Route::Native => native::create_dir(path, mode, recursive),
			Route::Provider(provider) if recursive => self.run(provider.create_dir_all(path, mode)),
			Route::Provider(provider) => self.run(provider.create_dir(path, mode)),
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	pub fn remove_file(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::remove_file(path),
			Route::Provider(provider) => self.run(provider.remove_file(path)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub fn remove_dir(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::remove_dir(path),
			Route::Provider(provider) => self.run(provider.remove_dir(path)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub fn remove_dir_all(&self, path: impl AsRef<Path>) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => std::fs::remove_dir_all(path),
			Route::Provider(provider) => self.run(provider.remove_dir_all(path)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// See [`Fs::rename`].
	pub fn rename(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<()> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match self.fs.route_pair(from, to)? {
			PairRoute::Native => std::fs::rename(from, to),
			PairRoute::Provider(provider) => self.run(provider.rename(from, to)),
		}
	}

	/// See [`Fs::copy`].
	pub fn copy(&self, from: impl AsRef<Path>, to: impl AsRef<Path>) -> io::Result<u64> {
		let (from, to) = (from.as_ref(), to.as_ref());
		match (self.fs.route(from)?, self.fs.route(to)?) {
			(Route::Native, Route::Native) => std::fs::copy(from, to),
			(Route::Mounted(_), _) | (_, Route::Mounted(_)) => {
				let source = self.open(from)?;
				let target = self.create(to)?;
				let copied = io::copy(&mut &source, &mut &target)?;
				target.close()?;
				Ok(copied)
			},
			(Route::Provider(provider), _) | (_, Route::Provider(provider)) => {
				self.run(provider.copy(from, to))
			},
		}
	}

	pub fn hard_link(&self, original: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
		let (original, link) = (original.as_ref(), link.as_ref());
		match self.fs.route_pair(original, link)? {
			PairRoute::Native => std::fs::hard_link(original, link),
			PairRoute::Provider(provider) => self.run(provider.hard_link(original, link)),
		}
	}

	/// See [`Fs::symlink`].
	pub fn symlink(&self, target: impl AsRef<Path>, link: impl AsRef<Path>) -> io::Result<()> {
		self.symlink_with(target, link, SymlinkKind::Auto)
	}

	pub fn symlink_with(
		&self,
		target: impl AsRef<Path>,
		link: impl AsRef<Path>,
		kind: SymlinkKind,
	) -> io::Result<()> {
		let (target, link) = (target.as_ref(), link.as_ref());
		match self.fs.route(link)? {
			Route::Native => native::symlink(target, link, kind),
			Route::Provider(provider) => self.run(provider.symlink(target, link, kind)),
			Route::Mounted(_) => Err(already_exists()),
		}
	}

	/// Follows symlinks.
	pub fn set_permissions(
		&self,
		path: impl AsRef<Path>,
		permissions: Permissions,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::set_permissions(path, permissions),
			Route::Provider(provider) => self.run(provider.set_permissions(path, permissions)),
			Route::Mounted(file) => file.set_permissions(permissions),
		}
	}

	/// See [`Fs::set_times`].
	pub fn set_times(
		&self,
		path: impl AsRef<Path>,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		let (accessed, modified) = (accessed.into(), modified.into());
		match self.fs.route(path)? {
			Route::Native => native::set_times(path, accessed, modified, follow),
			Route::Provider(provider) => {
				self.run(provider.set_times(path, accessed, modified, follow))
			},
			Route::Mounted(file) => file.set_times(accessed, modified),
		}
	}

	pub fn chown(
		&self,
		path: impl AsRef<Path>,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::chown(path, uid, gid, follow),
			Route::Provider(provider) => self.run(provider.chown(path, uid, gid, follow)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// See [`Fs::access`].
	pub fn access(
		&self,
		path: impl AsRef<Path>,
		read: bool,
		write: bool,
		execute: bool,
	) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::access(path, read, write, execute),
			Route::Provider(provider) => self.run(provider.access(path, read, write, execute)),
			Route::Mounted(_) => mount_access(execute),
		}
	}

	/// `Ok(false)` only for `NotFound`; other errors propagate.
	pub fn try_exists(&self, path: impl AsRef<Path>) -> io::Result<bool> {
		not_found_is_false(self.metadata(path))
	}

	/// Follows symlinks; any error is `false`.
	pub fn exists(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).is_ok()
	}

	pub fn is_file(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).is_ok_and(|metadata| metadata.is_file())
	}

	pub fn is_dir(&self, path: impl AsRef<Path>) -> bool {
		self.metadata(path).is_ok_and(|metadata| metadata.is_dir())
	}

	pub fn is_symlink(&self, path: impl AsRef<Path>) -> bool {
		self
			.symlink_metadata(path)
			.is_ok_and(|metadata| metadata.is_symlink())
	}

	/// See [`Fs::file_id`].
	pub fn file_id(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<FileId> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::file_id(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
			Route::Mounted(file) => file
				.metadata()?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
		}
	}

	/// See [`Fs::same_file`].
	pub fn same_file(&self, a: impl AsRef<Path>, b: impl AsRef<Path>) -> io::Result<bool> {
		identity_result(self.file_id(a, true), self.file_id(b, true))
	}

	pub fn link_count(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<u64> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::link_count(path, follow),
			Route::Provider(_) => self
				.metadata_follow(path, follow)?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
			Route::Mounted(file) => file
				.metadata()?
				.nlink()
				.ok_or_else(|| unsupported("link count")),
		}
	}

	/// See [`Fs::allocated_size`].
	pub fn allocated_size(&self, path: impl AsRef<Path>) -> io::Result<u64> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::allocated_size(path),
			Route::Provider(_) => blocks_to_bytes(&self.metadata(path)?),
			Route::Mounted(file) => blocks_to_bytes(&file.metadata()?),
		}
	}

	pub fn stat_fs(&self, path: impl AsRef<Path>) -> io::Result<StatFs> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::stat_fs(path),
			Route::Provider(provider) => self.run(provider.stat_fs(path)),
			Route::Mounted(file) => mount_stat_fs(file),
		}
	}

	pub fn list_xattr(&self, path: impl AsRef<Path>, follow: bool) -> io::Result<Vec<OsString>> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::list_xattr(path, follow),
			Route::Provider(provider) => self.run(provider.list_xattr(path, follow)),
			Route::Mounted(_) => Err(unsupported("listxattr")),
		}
	}

	/// `Ok(None)` when the attribute is absent.
	pub fn get_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.fs.route(path)? {
			Route::Native => native::get_xattr(path, name, follow),
			Route::Provider(provider) => self.run(provider.get_xattr(path, name, follow)),
			Route::Mounted(_) => Err(unsupported("getxattr")),
		}
	}

	pub fn set_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		value: &[u8],
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.fs.route(path)? {
			Route::Native => native::set_xattr(path, name, value, follow),
			Route::Provider(provider) => self.run(provider.set_xattr(path, name, value, follow)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	pub fn remove_xattr(
		&self,
		path: impl AsRef<Path>,
		name: impl AsRef<OsStr>,
		follow: bool,
	) -> io::Result<()> {
		let (path, name) = (path.as_ref(), name.as_ref());
		match self.fs.route(path)? {
			Route::Native => native::remove_xattr(path, name, follow),
			Route::Provider(provider) => self.run(provider.remove_xattr(path, name, follow)),
			Route::Mounted(_) => Err(not_permitted()),
		}
	}

	/// See [`Fs::make_fifo`].
	pub fn make_fifo(&self, path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
		self.make_node(path, NodeKind::Fifo, mode)
	}

	/// See [`Fs::make_node`].
	pub fn make_node(&self, path: impl AsRef<Path>, kind: NodeKind, mode: u32) -> io::Result<()> {
		let path = path.as_ref();
		match self.fs.route(path)? {
			Route::Native => native::make_node(path, kind, mode),
			Route::Provider(provider) => self.run(provider.make_node(path, kind, mode)),
			Route::Mounted(_) => Err(already_exists()),
		}
	}
}
