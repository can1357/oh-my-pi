//! Host-injected asynchronous filesystem for embedded shell sessions.
//!
//! A host passes a [`ShellFilesystem`] whose `handler` services filesystem
//! operations through a promise-returning callback. The bridge implements
//! [`pi_vfs::FileSystem`] over that callback, so shell redirections, globs,
//! `cd`, and every in-process utility see host-provided paths as a real
//! filesystem — no argv rewriting and no temporary host copies.
//!
//! Wire rules:
//! - Paths travel verbatim (URL spellings keep their authority).
//! - Handles are positional: the native side owns each handle's cursor and
//!   sends explicit `bigint` offsets, so duplicated descriptors share one
//!   provider handle and one position.
//! - Binary payloads are `Buffer`/`Uint8Array`; `u64` quantities are `bigint`
//!   on requests and `number | bigint` on responses.
//! - Failures are data (`{ error: { code } }`) so errno identities survive the
//!   boundary; a rejected promise or malformed response is a provider failure.
//! - A response may redirect the operation to a host path (`local`,
//!   `localTarget`), which then runs on the native backend. Providers decide
//!   access policy before redirecting.
//!
//! The callback is held weakly, so an idle session never keeps the event loop
//! alive, and nothing here ever blocks the JavaScript thread.

use std::{
	ffi::{OsStr, OsString},
	fmt,
	io::{self, SeekFrom},
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use napi::{
	Env, Status,
	bindgen_prelude::{BigInt, Buffer, Either, Promise, Uint8Array},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use pi_vfs::{
	BlockingFs, CanonicalizeOptions, DirEntry, DirOptions, File, FileHandle, FileKind, FileSystem,
	FileTime, FileType, Fs, Metadata, MissingHandling, NodeKind, OpenOptions, Permissions, ReadDir,
	ResolveMode, StatFs, SymlinkKind,
};

/// Largest payload moved by one `read`/`write` round trip. Larger requests
/// are served short, which every `Read`/`Write` caller already handles, and
/// keeps one call from staging an unbounded copy on either side.
const MAX_TRANSFER: usize = 4 * 1024 * 1024;

/// Largest integer a JavaScript `number` represents exactly.
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

const NANOS_PER_SEC: u128 = 1_000_000_000;

// ═══════════════════════════════════════════════════════════════════════════
// Wire types
// ═══════════════════════════════════════════════════════════════════════════

/// Filesystem operation requested from a host [`ShellFilesystem`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ShellFsOp {
	/// Metadata of `path`, following symlinks. Answer: `metadata`.
	#[napi(value = "metadata")]
	Metadata,
	/// Metadata of `path` itself, not following a final symlink. Answer:
	/// `metadata`.
	#[napi(value = "symlinkMetadata")]
	SymlinkMetadata,
	/// Entries of directory `path`. Answer: `entries`.
	#[napi(value = "readDir")]
	ReadDir,
	/// Canonical spelling of `path` per `missing`/`resolve`. Answer: `path`.
	#[napi(value = "canonicalize")]
	Canonicalize,
	/// Host file or directory backing `path`, for user-facing commands that
	/// print real locations (`realpath`, `readlink -f`). Answer: `path`, or
	/// no `path` when nothing on the host backs it. Grants no access.
	#[napi(value = "backingPath")]
	BackingPath,
	/// Contents of symlink `path`. Answer: `path`.
	#[napi(value = "readLink")]
	ReadLink,
	/// Check `access` permissions on `path` (all false: existence).
	#[napi(value = "access")]
	Access,
	/// Open `path` with `open` flags. Answer: `handle`.
	#[napi(value = "open")]
	Open,
	/// Read up to `length` bytes of `handle` at `offset`. Answer: `data`
	/// (empty at end of file).
	#[napi(value = "read")]
	Read,
	/// Write `data` to `handle` at `offset`, or at the end when `offset` is
	/// absent (append handles). Answer: `written`, plus `offset` (end
	/// position after the write) for appends.
	#[napi(value = "write")]
	Write,
	/// Flush buffered writes of `handle`.
	#[napi(value = "flush")]
	Flush,
	/// Release `handle`. Sent exactly once per opened handle.
	#[napi(value = "close")]
	Close,
	/// Metadata of the file behind `handle`. Answer: `metadata`.
	#[napi(value = "fileMetadata")]
	FileMetadata,
	/// Query whether `handle` has a conflicting advisory write lock. Answer:
	/// `locked`.
	#[napi(value = "isLocked")]
	IsLocked,
	/// Truncate or extend `handle` to `size` bytes.
	#[napi(value = "setLen")]
	SetLen,
	/// Set times of `handle` (`atimeNs`/`mtimeNs`; absent = unchanged).
	#[napi(value = "fileSetTimes")]
	FileSetTimes,
	/// Set permission bits `mode` of `handle`.
	#[napi(value = "fileSetPermissions")]
	FileSetPermissions,
	/// Persist `handle` (`dataOnly`: data without metadata).
	#[napi(value = "sync")]
	Sync,
	/// Create directory `path` (`recursive`, optional `mode`).
	#[napi(value = "createDir")]
	CreateDir,
	/// Remove non-directory `path`.
	#[napi(value = "removeFile")]
	RemoveFile,
	/// Remove empty directory `path`.
	#[napi(value = "removeDir")]
	RemoveDir,
	/// Remove directory `path` and everything below it.
	#[napi(value = "removeDirAll")]
	RemoveDirAll,
	/// Rename `path` to `target`.
	#[napi(value = "rename")]
	Rename,
	/// Create hard link `target` to existing `path`.
	#[napi(value = "hardLink")]
	HardLink,
	/// Create symlink `path` whose contents are `target` (verbatim).
	#[napi(value = "symlink")]
	Symlink,
	/// Set permission bits `mode` of `path` (following symlinks).
	#[napi(value = "setPermissions")]
	SetPermissions,
	/// Set times of `path` (`atimeNs`/`mtimeNs`; absent = unchanged;
	/// `follow`).
	#[napi(value = "setTimes")]
	SetTimes,
	/// Change owner `uid`/`gid` of `path` (absent = unchanged; `follow`).
	#[napi(value = "chown")]
	Chown,
	/// Statistics of the filesystem holding `path`. Answer: `statFs`.
	#[napi(value = "statFs")]
	StatFs,
	/// Extended attribute `name` of `path`. Answer: `data`, or no `data`
	/// when the attribute is absent.
	#[napi(value = "getXattr")]
	GetXattr,
	/// Set extended attribute `name` of `path` to `data`.
	#[napi(value = "setXattr")]
	SetXattr,
	/// Extended attribute names of `path`. Answer: `names`.
	#[napi(value = "listXattr")]
	ListXattr,
	/// Remove extended attribute `name` of `path`.
	#[napi(value = "removeXattr")]
	RemoveXattr,
	/// Create node `path` of `fileType` with `mode` (and `device` for
	/// character/block devices).
	#[napi(value = "mknod")]
	Mknod,
}

/// File type on the filesystem wire.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ShellFsFileType {
	/// Regular file.
	#[napi(value = "file")]
	File,
	/// Directory.
	#[napi(value = "dir")]
	Dir,
	/// Symbolic link.
	#[napi(value = "symlink")]
	Symlink,
	/// Named pipe.
	#[napi(value = "fifo")]
	Fifo,
	/// Unix domain socket.
	#[napi(value = "socket")]
	Socket,
	/// Character device.
	#[napi(value = "char")]
	Char,
	/// Block device.
	#[napi(value = "block")]
	Block,
}

/// Which path components `canonicalize` requires to exist.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ShellFsMissing {
	/// Every component must exist (`realpath`).
	#[napi(value = "existing")]
	Existing,
	/// Every component but the last must exist.
	#[napi(value = "normal")]
	Normal,
	/// No component needs to exist.
	#[napi(value = "missing")]
	Missing,
}

/// How `canonicalize` treats symlinks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ShellFsResolve {
	/// Resolve symlinks as encountered.
	#[napi(value = "physical")]
	Physical,
	/// Apply `..` lexically before resolving symlinks.
	#[napi(value = "logical")]
	Logical,
	/// Never resolve symlinks; normalize lexically only.
	#[napi(value = "none")]
	None,
}

/// Open flags for an `open` request (std `OpenOptions` semantics).
#[napi(object, object_from_js = false)]
pub struct ShellFsOpenFlags {
	pub read:         bool,
	pub write:        bool,
	pub append:       bool,
	pub truncate:     bool,
	pub create:       bool,
	pub create_new:   bool,
	/// Permission bits for a newly created file.
	pub mode:         Option<u32>,
	/// Platform open flags beyond the portable set (`O_*`); absent when none.
	pub custom_flags: Option<i32>,
}

/// Permissions probed by an `access` request.
#[napi(object, object_from_js = false)]
pub struct ShellFsAccess {
	pub read:    bool,
	pub write:   bool,
	pub execute: bool,
}

/// One filesystem request. Only the fields documented for `op` are set.
#[napi(object, object_from_js = false)]
pub struct ShellFsRequest {
	pub op:        ShellFsOp,
	/// Subject path, verbatim (URL spellings keep their authority).
	pub path:      Option<String>,
	/// Second path: rename/hard-link destination or symlink contents.
	pub target:    Option<String>,
	/// Provider handle id from a previous `open`.
	pub handle:    Option<i64>,
	/// Byte offset for positional handle I/O.
	pub offset:    Option<u64>,
	/// Maximum bytes to read.
	pub length:    Option<u32>,
	/// New length for `setLen`.
	pub size:      Option<u64>,
	/// Bytes to write (`write`) or attribute value (`setXattr`).
	pub data:      Option<Buffer>,
	pub open:      Option<ShellFsOpenFlags>,
	pub access:    Option<ShellFsAccess>,
	pub recursive: Option<bool>,
	/// Permission bits (`0o7777`).
	pub mode:      Option<u32>,
	/// Whether a final symlink is followed.
	pub follow:    Option<bool>,
	/// Access time in nanoseconds since the Unix epoch.
	pub atime_ns:  Option<BigInt>,
	/// Modification time in nanoseconds since the Unix epoch.
	pub mtime_ns:  Option<BigInt>,
	pub uid:       Option<u32>,
	pub gid:       Option<u32>,
	/// `sync` persists data only, not metadata.
	pub data_only: Option<bool>,
	/// Extended attribute name.
	pub name:      Option<String>,
	/// Node type for `mknod`.
	pub file_type: Option<ShellFsFileType>,
	/// Device number for character/block `mknod`.
	pub device:    Option<u64>,
	pub missing:   Option<ShellFsMissing>,
	pub resolve:   Option<ShellFsResolve>,
	/// Removal of temporary files the shell itself created, issued even after
	/// the run was aborted. Serve it under the same policy, but without the
	/// run's abort signal. Not a retry of a cancelled request.
	pub cleanup:   Option<bool>,
}

/// A failed operation, reported as data so its errno identity survives.
#[napi(object, object_to_js = false)]
pub struct ShellFsError {
	/// Errno name such as `ENOENT`, `EACCES`, `EROFS`, `ENOTSUP`.
	pub code:    String,
	pub message: Option<String>,
}

/// File metadata. Absent optional fields mean the provider has no such value;
/// they are never fabricated.
#[napi(object, object_to_js = false)]
pub struct ShellFsMetadata {
	pub file_type:    ShellFsFileType,
	pub size:         Either<f64, BigInt>,
	/// Permission bits (`0o7777`).
	pub mode:         u32,
	/// Modification time, nanoseconds since the Unix epoch.
	pub mtime_ns:     Option<Either<f64, BigInt>>,
	/// Access time, nanoseconds since the Unix epoch.
	pub atime_ns:     Option<Either<f64, BigInt>>,
	/// Status change time, nanoseconds since the Unix epoch.
	pub ctime_ns:     Option<Either<f64, BigInt>>,
	/// Creation time, nanoseconds since the Unix epoch.
	pub birthtime_ns: Option<Either<f64, BigInt>>,
	/// Device id; given together with `ino`.
	pub dev:          Option<Either<f64, BigInt>>,
	/// Inode number; given together with `dev`.
	pub ino:          Option<Either<f64, BigInt>>,
	pub nlink:        Option<Either<f64, BigInt>>,
	pub rdev:         Option<Either<f64, BigInt>>,
	/// Allocated 512-byte blocks; given together with `blksize`.
	pub blocks:       Option<Either<f64, BigInt>>,
	/// Preferred I/O block size; given together with `blocks`.
	pub blksize:      Option<Either<f64, BigInt>>,
	/// Owner user id; given together with `gid`.
	pub uid:          Option<u32>,
	/// Owner group id; given together with `uid`.
	pub gid:          Option<u32>,
}

/// One directory entry.
#[napi(object, object_to_js = false)]
pub struct ShellFsDirEntry {
	pub name:      String,
	pub file_type: ShellFsFileType,
	/// Entry metadata without following a final symlink, when already known.
	pub metadata:  Option<ShellFsMetadata>,
}

/// Filesystem statistics.
#[napi(object, object_to_js = false)]
pub struct ShellFsStatFs {
	pub block_size:       Either<f64, BigInt>,
	/// Optimal transfer size; defaults to `blockSize`.
	pub io_size:          Option<Either<f64, BigInt>>,
	pub blocks:           Either<f64, BigInt>,
	pub blocks_free:      Either<f64, BigInt>,
	pub blocks_available: Either<f64, BigInt>,
	pub files:            Either<f64, BigInt>,
	pub files_free:       Either<f64, BigInt>,
	/// Filesystem type magic number.
	pub fs_type:          Option<Either<f64, BigInt>>,
	pub fs_type_name:     Option<String>,
	pub fsid:             Option<Either<f64, BigInt>>,
	pub name_max:         Option<Either<f64, BigInt>>,
}

/// Provider answer. Carries `error`, a native redirect (`local` /
/// `localTarget`), or the op's result fields.
#[napi(object, object_to_js = false)]
pub struct ShellFsResponse {
	pub error:        Option<ShellFsError>,
	/// Run this operation natively on this host path instead.
	pub local:        Option<String>,
	/// Native host path replacing `target` (rename/hard-link destination).
	pub local_target: Option<String>,
	pub handle:       Option<i64>,
	/// With an `open` redirect: the host file backs an immutable mount, so
	/// the opened file refuses every mutation (EROFS), duplicates included.
	pub readonly:     Option<bool>,
	pub data:         Option<Uint8Array>,
	pub written:      Option<u32>,
	/// Result of an `isLocked` advisory-lock query.
	pub locked:       Option<bool>,
	/// Handle position after an append write.
	pub offset:       Option<Either<f64, BigInt>>,
	pub path:         Option<String>,
	pub metadata:     Option<ShellFsMetadata>,
	pub entries:      Option<Vec<ShellFsDirEntry>>,
	pub names:        Option<Vec<String>>,
	pub stat_fs:      Option<ShellFsStatFs>,
}

/// Weak so an idle session never keeps the event loop alive: every call
/// happens while a shell run's pending promise holds the loop open.
type ShellFsHandler =
	ThreadsafeFunction<ShellFsRequest, Promise<ShellFsResponse>, ShellFsRequest, Status, true, true>;

/// Host filesystem injected into shell sessions.
#[napi(object, object_to_js = false)]
pub struct ShellFilesystem {
	/// Services every routed operation; failures are returned as `error`
	/// data rather than thrown.
	#[napi(ts_type = "(error: Error | null, request: ShellFsRequest) => Promise<ShellFsResponse>")]
	pub handler:            ShellFsHandler,
	/// When true, every path without a `scheme://` prefix — and everything
	/// beneath it — is the ordinary host filesystem: operations there run
	/// natively (including recursive traversal and removal) and `handler` is
	/// never consulted, so it cannot intercept any host subtree. Only URL
	/// paths reach `handler`. When false or absent, `handler` is a fully
	/// injected filesystem and receives every path, host paths included.
	pub native_local_paths: Option<bool>,
}

impl ShellFilesystem {
	/// Filesystem facade backed by this provider.
	pub fn into_fs(self) -> Fs {
		Fs::new(Arc::new(JsFileSystem {
			bridge:             Arc::new(Bridge { handler: self.handler }),
			native_local_paths: self.native_local_paths.unwrap_or(false),
			native:             Fs::native(),
			cleanup:            false,
		}))
	}

	/// Blocking facade for synchronous search workers: `filesystem`'s
	/// provider, or the native host filesystem when absent. Call on the
	/// JavaScript thread while unpacking the options, as the shell does.
	pub fn blocking(filesystem: Option<Self>) -> BlockingFs {
		filesystem.map_or_else(BlockingFs::native, |filesystem| filesystem.into_fs().blocking())
	}
}

impl ShellFsRequest {
	const fn new(op: ShellFsOp) -> Self {
		Self {
			op,
			path: None,
			target: None,
			handle: None,
			offset: None,
			length: None,
			size: None,
			data: None,
			open: None,
			access: None,
			recursive: None,
			mode: None,
			follow: None,
			atime_ns: None,
			mtime_ns: None,
			uid: None,
			gid: None,
			data_only: None,
			name: None,
			file_type: None,
			device: None,
			missing: None,
			resolve: None,
			cleanup: None,
		}
	}

	fn at(op: ShellFsOp, path: &Path) -> io::Result<Self> {
		let mut request = Self::new(op);
		request.path = Some(wire_path(path)?);
		Ok(request)
	}

	fn between(op: ShellFsOp, path: &Path, target: &Path) -> io::Result<Self> {
		let mut request = Self::at(op, path)?;
		request.target = Some(wire_path(target)?);
		Ok(request)
	}

	const fn on_handle(op: ShellFsOp, handle: i64) -> Self {
		let mut request = Self::new(op);
		request.handle = Some(handle);
		request
	}

	fn with_times(mut self, accessed: FileTime, modified: FileTime) -> io::Result<Self> {
		self.atime_ns = time_to_wire(accessed)?;
		self.mtime_ns = time_to_wire(modified)?;
		Ok(self)
	}
}

impl From<&OpenOptions> for ShellFsOpenFlags {
	fn from(options: &OpenOptions) -> Self {
		let custom_flags = options.get_custom_flags();
		Self {
			read:         options.is_read(),
			write:        options.is_write(),
			append:       options.is_append(),
			truncate:     options.is_truncate(),
			create:       options.is_create(),
			create_new:   options.is_create_new(),
			mode:         options.get_mode(),
			custom_flags: (custom_flags != 0).then_some(custom_flags),
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Bridge
// ═══════════════════════════════════════════════════════════════════════════

/// The host callback, shared by the provider and every handle it opened.
struct Bridge {
	handler: ShellFsHandler,
}

impl Bridge {
	/// One host round trip, awaited without blocking any thread. `error`
	/// answers become the matching `io::Error`.
	async fn call(&self, request: ShellFsRequest) -> io::Result<ShellFsResponse> {
		let promise = self
			.handler
			.call_async(Ok(request))
			.await
			.map_err(|err| provider_failure(&err))?;
		let mut response = promise.await.map_err(|err| provider_failure(&err))?;
		match response.error.take() {
			Some(error) => Err(error_from_wire(error)),
			None => Ok(response),
		}
	}

	/// `open` whose reply outlives a cancelled caller: the round trip runs as
	/// a detached task, and a handle nobody received is closed, so aborting a
	/// run never strands provider resources.
	async fn open(self: &Arc<Self>, request: ShellFsRequest) -> io::Result<ShellFsResponse> {
		let (reply, receiver) = tokio::sync::oneshot::channel();
		let bridge = Arc::clone(self);
		let cleanup = request.cleanup == Some(true);
		napi::bindgen_prelude::spawn(async move {
			let response = bridge.call(request).await;
			if let Err(Ok(orphan)) = reply.send(response)
				&& let Some(handle) = orphan.handle
			{
				bridge.release(handle, cleanup);
			}
		});
		receiver
			.await
			.map_err(|_| io::Error::other("filesystem provider open task ended without a reply"))?
	}

	/// Queue `close` for `handle` without waiting for the answer. Needs no
	/// runtime and never blocks, so it is safe from `Drop`. The returned
	/// promise is still consumed, so a rejection is never left unhandled.
	fn release(&self, handle: i64, cleanup: bool) {
		let mut request = ShellFsRequest::on_handle(ShellFsOp::Close, handle);
		if cleanup {
			request.cleanup = Some(true);
		}
		let _ = self.handler.call_with_return_value(
			Ok(request),
			ThreadsafeFunctionCallMode::NonBlocking,
			|_: napi::Result<Promise<ShellFsResponse>>, _: Env| Ok(()),
		);
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider
// ═══════════════════════════════════════════════════════════════════════════

/// [`FileSystem`] over a host [`ShellFilesystem`] callback.
struct JsFileSystem {
	bridge:             Arc<Bridge>,
	/// Non-URL paths bypass the callback and use `native`.
	native_local_paths: bool,
	/// Backend for non-routed paths and `local` redirects.
	native:             Fs,
	/// Every request is flagged `cleanup` (see [`FileSystem::for_cleanup`]).
	cleanup:            bool,
}

impl fmt::Debug for JsFileSystem {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("JsFileSystem")
			.field("native_local_paths", &self.native_local_paths)
			.finish_non_exhaustive()
	}
}

/// A routed single-path answer: completed by the provider, or redirected to
/// a host path for the native backend.
enum Reply {
	Done(Box<ShellFsResponse>),
	Local(PathBuf),
}

impl JsFileSystem {
	/// Whether `path` goes to the host callback.
	fn routed(&self, path: &Path) -> bool {
		!self.native_local_paths || pi_vfs::is_virtual_path(path)
	}

	const fn stamp(&self, mut request: ShellFsRequest) -> ShellFsRequest {
		if self.cleanup {
			request.cleanup = Some(true);
		}
		request
	}

	async fn call(&self, request: ShellFsRequest) -> io::Result<ShellFsResponse> {
		self.bridge.call(self.stamp(request)).await
	}

	async fn request(&self, request: ShellFsRequest) -> io::Result<Reply> {
		let mut response = self.call(request).await?;
		Ok(match response.local.take() {
			Some(local) => Reply::Local(PathBuf::from(local)),
			None => Reply::Done(Box::new(response)),
		})
	}

	/// Native paths for a two-path op the provider redirected, or `None` when
	/// the provider completed it. A side without a redirect must itself be a
	/// native path; otherwise the paths live on different backends.
	fn redirected_pair(
		&self,
		path: &Path,
		target: &Path,
		response: ShellFsResponse,
	) -> io::Result<Option<(PathBuf, PathBuf)>> {
		if response.local.is_none() && response.local_target.is_none() {
			return Ok(None);
		}
		let resolve = |redirect: Option<String>, original: &Path| match redirect {
			Some(local) => Ok(PathBuf::from(local)),
			None if !self.routed(original) => Ok(original.to_path_buf()),
			None => Err(pi_vfs::crosses_devices()),
		};
		Ok(Some((resolve(response.local, path)?, resolve(response.local_target, target)?)))
	}

	/// Rebase a native listing entry under the routed directory spelling.
	fn rebase_entry(dir: &Path, entry: DirEntry) -> DirEntry {
		let name = entry.file_name();
		let path = pi_vfs::child_path(dir, &name);
		let rebased = DirEntry::new(path, name, entry.file_type().ok());
		// One local `lstat` now instead of a host round trip per later lookup.
		match entry.metadata() {
			Ok(metadata) => rebased.with_metadata(metadata),
			Err(_) => rebased,
		}
	}
}

#[async_trait]
impl FileSystem for JsFileSystem {
	fn is_native_local(&self, path: &Path) -> bool {
		!self.routed(path)
	}

	fn for_cleanup(&self) -> Option<Arc<dyn FileSystem>> {
		Some(Arc::new(Self {
			bridge:             Arc::clone(&self.bridge),
			native_local_paths: self.native_local_paths,
			native:             self.native.clone(),
			cleanup:            true,
		}))
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		if !self.routed(path) {
			return self.native.open_with(path, options).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::Open, path)?;
		request.open = Some(ShellFsOpenFlags::from(options));
		let response = self.bridge.open(self.stamp(request)).await?;
		match (response.local, response.handle) {
			(Some(local), None) if response.readonly == Some(true) => {
				if options.is_writable() || options.is_truncate() || options.is_create() {
					return Err(pi_vfs::read_only_filesystem());
				}
				let file = self.native.open_with(Path::new(&local), options).await?;
				Ok(File::from_handle(ReadOnlyFile { file }))
			},
			(Some(local), None) => self.native.open_with(Path::new(&local), options).await,
			(None, Some(handle)) => Ok(File::from_handle(JsFileHandle::new(
				Arc::clone(&self.bridge),
				handle,
				options.is_append(),
				self.cleanup,
			))),
			(_, handle) => {
				if let Some(handle) = handle {
					self.bridge.release(handle, self.cleanup);
				}
				Err(protocol_error("`open` must answer exactly one of `handle` or `local`"))
			},
		}
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		if !self.routed(path) {
			return self.native.metadata(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::Metadata, path)?)
			.await?
		{
			Reply::Local(local) => self.native.metadata(&local).await,
			Reply::Done(response) => metadata_from_wire(required(response.metadata, "metadata")?),
		}
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		if !self.routed(path) {
			return self.native.symlink_metadata(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::SymlinkMetadata, path)?)
			.await?
		{
			Reply::Local(local) => self.native.symlink_metadata(&local).await,
			Reply::Done(response) => metadata_from_wire(required(response.metadata, "metadata")?),
		}
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		if !self.routed(path) {
			return self.native.read_dir(path).await;
		}
		let entries = match self
			.request(ShellFsRequest::at(ShellFsOp::ReadDir, path)?)
			.await?
		{
			Reply::Local(local) => self
				.native
				.read_dir(&local)
				.await?
				.map(|entry| entry.map(|entry| Self::rebase_entry(path, entry)))
				.collect::<Vec<_>>(),
			Reply::Done(response) => required(response.entries, "entries")?
				.into_iter()
				.map(|entry| entry_from_wire(path, entry))
				.collect(),
		};
		Ok(ReadDir::from_entries(entries))
	}

	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		if !self.routed(path) {
			return self.native.read_link(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::ReadLink, path)?)
			.await?
		{
			Reply::Local(local) => self.native.read_link(&local).await,
			Reply::Done(response) => required(response.path, "path").map(PathBuf::from),
		}
	}

	async fn canonicalize(&self, path: &Path, options: &CanonicalizeOptions) -> io::Result<PathBuf> {
		if !self.routed(path) {
			return self.native.canonicalize_with(path, options).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::Canonicalize, path)?;
		request.missing = Some(match options.missing {
			MissingHandling::Existing => ShellFsMissing::Existing,
			MissingHandling::Normal => ShellFsMissing::Normal,
			MissingHandling::Missing => ShellFsMissing::Missing,
		});
		request.resolve = Some(match options.resolve {
			ResolveMode::Physical => ShellFsResolve::Physical,
			ResolveMode::Logical => ShellFsResolve::Logical,
			ResolveMode::None => ShellFsResolve::None,
		});
		match self.request(request).await? {
			Reply::Local(local) => self.native.canonicalize_with(&local, options).await,
			Reply::Done(response) => required(response.path, "path").map(PathBuf::from),
		}
	}

	async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		if !self.routed(path) {
			return self.native.backing_path(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::BackingPath, path)?)
			.await?
		{
			Reply::Local(local) => self.native.backing_path(&local).await,
			Reply::Done(response) => Ok(response.path.map(PathBuf::from)),
		}
	}

	async fn create_dir(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		self.create_dir_routed(path, false, mode).await
	}

	async fn create_dir_all(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		self.create_dir_routed(path, true, mode).await
	}

	async fn remove_file(&self, path: &Path) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.remove_file(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::RemoveFile, path)?)
			.await?
		{
			Reply::Local(local) => self.native.remove_file(&local).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn remove_dir(&self, path: &Path) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.remove_dir(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::RemoveDir, path)?)
			.await?
		{
			Reply::Local(local) => self.native.remove_dir(&local).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.remove_dir_all(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::RemoveDirAll, path)?)
			.await?
		{
			Reply::Local(local) => self.native.remove_dir_all(&local).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		if !self.routed(from) && !self.routed(to) {
			return self.native.rename(from, to).await;
		}
		let response = self
			.call(ShellFsRequest::between(ShellFsOp::Rename, from, to)?)
			.await?;
		match self.redirected_pair(from, to, response)? {
			Some((from, to)) => self.native.rename(&from, &to).await,
			None => Ok(()),
		}
	}

	async fn hard_link(&self, original: &Path, link: &Path) -> io::Result<()> {
		if !self.routed(original) && !self.routed(link) {
			return self.native.hard_link(original, link).await;
		}
		let response = self
			.call(ShellFsRequest::between(ShellFsOp::HardLink, original, link)?)
			.await?;
		match self.redirected_pair(original, link, response)? {
			Some((original, link)) => self.native.hard_link(&original, &link).await,
			None => Ok(()),
		}
	}

	async fn symlink(&self, target: &Path, link: &Path, kind: SymlinkKind) -> io::Result<()> {
		if !self.routed(link) {
			return self.native.symlink_with(target, link, kind).await;
		}
		match self
			.request(ShellFsRequest::between(ShellFsOp::Symlink, link, target)?)
			.await?
		{
			Reply::Local(local) => self.native.symlink_with(target, &local, kind).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn set_permissions(&self, path: &Path, permissions: Permissions) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.set_permissions(path, permissions).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::SetPermissions, path)?;
		request.mode = Some(permissions.mode() & 0o7777);
		match self.request(request).await? {
			Reply::Local(local) => self.native.set_permissions(&local, permissions).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn set_times(
		&self,
		path: &Path,
		accessed: FileTime,
		modified: FileTime,
		follow: bool,
	) -> io::Result<()> {
		if !self.routed(path) {
			return self
				.native
				.set_times(path, accessed, modified, follow)
				.await;
		}
		let mut request =
			ShellFsRequest::at(ShellFsOp::SetTimes, path)?.with_times(accessed, modified)?;
		request.follow = Some(follow);
		match self.request(request).await? {
			Reply::Local(local) => {
				self
					.native
					.set_times(&local, accessed, modified, follow)
					.await
			},
			Reply::Done(_) => Ok(()),
		}
	}

	async fn chown(
		&self,
		path: &Path,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.chown(path, uid, gid, follow).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::Chown, path)?;
		request.uid = uid;
		request.gid = gid;
		request.follow = Some(follow);
		match self.request(request).await? {
			Reply::Local(local) => self.native.chown(&local, uid, gid, follow).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn access(&self, path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.access(path, read, write, execute).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::Access, path)?;
		request.access = Some(ShellFsAccess { read, write, execute });
		match self.request(request).await? {
			Reply::Local(local) => self.native.access(&local, read, write, execute).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn stat_fs(&self, path: &Path) -> io::Result<StatFs> {
		if !self.routed(path) {
			return self.native.stat_fs(path).await;
		}
		match self
			.request(ShellFsRequest::at(ShellFsOp::StatFs, path)?)
			.await?
		{
			Reply::Local(local) => self.native.stat_fs(&local).await,
			Reply::Done(response) => stat_fs_from_wire(required(response.stat_fs, "statFs")?),
		}
	}

	async fn list_xattr(&self, path: &Path, follow: bool) -> io::Result<Vec<OsString>> {
		if !self.routed(path) {
			return self.native.list_xattr(path, follow).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::ListXattr, path)?;
		request.follow = Some(follow);
		match self.request(request).await? {
			Reply::Local(local) => self.native.list_xattr(&local, follow).await,
			Reply::Done(response) => Ok(required(response.names, "names")?
				.into_iter()
				.map(OsString::from)
				.collect()),
		}
	}

	async fn get_xattr(
		&self,
		path: &Path,
		name: &OsStr,
		follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		if !self.routed(path) {
			return self.native.get_xattr(path, name, follow).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::GetXattr, path)?;
		request.name = Some(wire_name(name)?);
		request.follow = Some(follow);
		match self.request(request).await? {
			Reply::Local(local) => self.native.get_xattr(&local, name, follow).await,
			Reply::Done(response) => Ok(response.data.map(|data| data.to_vec())),
		}
	}

	async fn set_xattr(
		&self,
		path: &Path,
		name: &OsStr,
		value: &[u8],
		follow: bool,
	) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.set_xattr(path, name, value, follow).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::SetXattr, path)?;
		request.name = Some(wire_name(name)?);
		request.data = Some(Buffer::from(value.to_vec()));
		request.follow = Some(follow);
		match self.request(request).await? {
			Reply::Local(local) => self.native.set_xattr(&local, name, value, follow).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn remove_xattr(&self, path: &Path, name: &OsStr, follow: bool) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.remove_xattr(path, name, follow).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::RemoveXattr, path)?;
		request.name = Some(wire_name(name)?);
		request.follow = Some(follow);
		match self.request(request).await? {
			Reply::Local(local) => self.native.remove_xattr(&local, name, follow).await,
			Reply::Done(_) => Ok(()),
		}
	}

	async fn make_node(&self, path: &Path, kind: NodeKind, mode: u32) -> io::Result<()> {
		if !self.routed(path) {
			return self.native.make_node(path, kind, mode).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::Mknod, path)?;
		let (file_type, device) = match kind {
			NodeKind::Fifo => (ShellFsFileType::Fifo, None),
			NodeKind::CharDevice(device) => (ShellFsFileType::Char, Some(device)),
			NodeKind::BlockDevice(device) => (ShellFsFileType::Block, Some(device)),
			NodeKind::Socket => (ShellFsFileType::Socket, None),
			NodeKind::Regular => (ShellFsFileType::File, None),
		};
		request.file_type = Some(file_type);
		request.device = device;
		request.mode = Some(mode);
		match self.request(request).await? {
			Reply::Local(local) => self.native.make_node(&local, kind, mode).await,
			Reply::Done(_) => Ok(()),
		}
	}
}

impl JsFileSystem {
	async fn create_dir_routed(
		&self,
		path: &Path,
		recursive: bool,
		mode: Option<u32>,
	) -> io::Result<()> {
		let options = DirOptions::new().recursive(recursive);
		let options = match mode {
			Some(mode) => options.mode(mode),
			None => options,
		};
		if !self.routed(path) {
			return self.native.create_dir_with(path, &options).await;
		}
		let mut request = ShellFsRequest::at(ShellFsOp::CreateDir, path)?;
		request.recursive = Some(recursive);
		request.mode = mode;
		match self.request(request).await? {
			Reply::Local(local) => self.native.create_dir_with(&local, &options).await,
			Reply::Done(_) => Ok(()),
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Handles
// ═══════════════════════════════════════════════════════════════════════════

/// A provider-owned open file. The cursor lives here; every data request is
/// positional, so clones of the owning [`File`] share one position exactly
/// like duplicated descriptors.
struct JsFileHandle {
	bridge:   Arc<Bridge>,
	id:       i64,
	/// Writes go to the provider's end of file (`offset` absent on the wire).
	append:   bool,
	/// Held across each round trip so concurrent clones never interleave a
	/// read-modify-advance of the shared position.
	position: tokio::sync::Mutex<u64>,
	closed:   AtomicBool,
	/// Opened through a cleanup provider; its requests stay flagged.
	cleanup:  bool,
}

impl JsFileHandle {
	fn new(bridge: Arc<Bridge>, id: i64, append: bool, cleanup: bool) -> Self {
		Self {
			bridge,
			id,
			append,
			position: tokio::sync::Mutex::new(0),
			closed: AtomicBool::new(false),
			cleanup,
		}
	}

	const fn request(&self, op: ShellFsOp) -> ShellFsRequest {
		let mut request = ShellFsRequest::on_handle(op, self.id);
		if self.cleanup {
			request.cleanup = Some(true);
		}
		request
	}

	async fn fetch_metadata(&self) -> io::Result<Metadata> {
		let response = self
			.bridge
			.call(self.request(ShellFsOp::FileMetadata))
			.await?;
		metadata_from_wire(required(response.metadata, "metadata")?)
	}

	async fn sync(&self, data_only: bool) -> io::Result<()> {
		let mut request = self.request(ShellFsOp::Sync);
		request.data_only = Some(data_only);
		self.bridge.call(request).await.map(drop)
	}
}

impl fmt::Debug for JsFileHandle {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("JsFileHandle")
			.field("id", &self.id)
			.field("append", &self.append)
			.finish_non_exhaustive()
	}
}

#[async_trait]
impl FileHandle for JsFileHandle {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let mut position = self.position.lock().await;
		let length = buf.len().min(MAX_TRANSFER);
		let mut request = self.request(ShellFsOp::Read);
		request.offset = Some(*position);
		request.length = Some(length as u32);
		let response = self.bridge.call(request).await?;
		let data = required(response.data, "data")?;
		let count = data.len();
		if count > length {
			return Err(protocol_error("`read` returned more bytes than requested"));
		}
		buf[..count].copy_from_slice(&data);
		*position = advance(*position, count)?;
		Ok(count)
	}

	async fn write(&self, buf: &[u8]) -> io::Result<usize> {
		if buf.is_empty() {
			return Ok(0);
		}
		let mut position = self.position.lock().await;
		let length = buf.len().min(MAX_TRANSFER);
		let mut request = self.request(ShellFsOp::Write);
		request.data = Some(Buffer::from(buf[..length].to_vec()));
		if !self.append {
			request.offset = Some(*position);
		}
		let response = self.bridge.call(request).await?;
		let written = required(response.written, "written")? as usize;
		if written > length {
			return Err(protocol_error("`write` reported more bytes than sent"));
		}
		*position = if self.append {
			wire_u64(required(response.offset, "offset")?, "offset")?
		} else {
			advance(*position, written)?
		};
		Ok(written)
	}

	async fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
		let mut position = self.position.lock().await;
		let next = match pos {
			SeekFrom::Start(offset) => Some(offset),
			SeekFrom::Current(delta) => position.checked_add_signed(delta),
			SeekFrom::End(delta) => self.fetch_metadata().await?.len().checked_add_signed(delta),
		};
		*position = next.ok_or_else(|| {
			io::Error::new(
				io::ErrorKind::InvalidInput,
				"invalid seek to a negative or overflowing position",
			)
		})?;
		Ok(*position)
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		self.fetch_metadata().await
	}

	async fn is_locked(&self) -> io::Result<bool> {
		let response = self.bridge.call(self.request(ShellFsOp::IsLocked)).await?;
		required(response.locked, "locked")
	}

	async fn flush(&self) -> io::Result<()> {
		self
			.bridge
			.call(self.request(ShellFsOp::Flush))
			.await
			.map(drop)
	}

	async fn set_len(&self, size: u64) -> io::Result<()> {
		let mut request = self.request(ShellFsOp::SetLen);
		request.size = Some(size);
		self.bridge.call(request).await.map(drop)
	}

	async fn set_permissions(&self, permissions: Permissions) -> io::Result<()> {
		let mut request = self.request(ShellFsOp::FileSetPermissions);
		request.mode = Some(permissions.mode() & 0o7777);
		self.bridge.call(request).await.map(drop)
	}

	async fn set_times(&self, accessed: FileTime, modified: FileTime) -> io::Result<()> {
		let request = self
			.request(ShellFsOp::FileSetTimes)
			.with_times(accessed, modified)?;
		self.bridge.call(request).await.map(drop)
	}

	async fn sync_all(&self) -> io::Result<()> {
		self.sync(false).await
	}

	async fn sync_data(&self) -> io::Result<()> {
		self.sync(true).await
	}

	async fn close(&self) -> io::Result<()> {
		if self.closed.swap(true, Ordering::AcqRel) {
			return Ok(());
		}
		self
			.bridge
			.call(self.request(ShellFsOp::Close))
			.await
			.map(drop)
	}
}

/// A host file standing in for an immutable mount. Reads, seeks, metadata,
/// and lock queries reach the host descriptor; every mutation — including
/// `fchmod`/`futimens`, which an `O_RDONLY` descriptor would permit — fails
/// EROFS. The descriptor is never exposed, so no caller can bypass this, and
/// clones share this wrapper and its restriction.
#[derive(Debug)]
struct ReadOnlyFile {
	file: File,
}

#[async_trait]
impl FileHandle for ReadOnlyFile {
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize> {
		self.file.read_async(buf).await
	}

	async fn write(&self, _buf: &[u8]) -> io::Result<usize> {
		Err(pi_vfs::read_only_filesystem())
	}

	async fn seek(&self, pos: SeekFrom) -> io::Result<u64> {
		self.file.seek_async(pos).await
	}

	async fn metadata(&self) -> io::Result<Metadata> {
		self.file.metadata_async().await
	}

	async fn set_len(&self, _size: u64) -> io::Result<()> {
		Err(pi_vfs::read_only_filesystem())
	}

	async fn set_permissions(&self, _permissions: Permissions) -> io::Result<()> {
		Err(pi_vfs::read_only_filesystem())
	}

	async fn set_times(&self, _accessed: FileTime, _modified: FileTime) -> io::Result<()> {
		Err(pi_vfs::read_only_filesystem())
	}

	async fn is_locked(&self) -> io::Result<bool> {
		self.file.is_locked_async().await
	}
}

impl Drop for JsFileHandle {
	/// Backstop for a handle released without `close`: the provider still
	/// gets its one `close`, queued without blocking this thread.
	fn drop(&mut self) {
		if !*self.closed.get_mut() {
			self.bridge.release(self.id, self.cleanup);
		}
	}
}

// ═══════════════════════════════════════════════════════════════════════════
// Conversions
// ═══════════════════════════════════════════════════════════════════════════

fn wire_path(path: &Path) -> io::Result<String> {
	path.to_str().map(str::to_owned).ok_or_else(|| {
		io::Error::new(
			io::ErrorKind::InvalidInput,
			format!("path is not valid UTF-8 for the host filesystem: {}", path.display()),
		)
	})
}

fn wire_name(name: &OsStr) -> io::Result<String> {
	name.to_str().map(str::to_owned).ok_or_else(|| {
		io::Error::new(
			io::ErrorKind::InvalidInput,
			"extended attribute name is not valid UTF-8 for the host filesystem",
		)
	})
}

fn protocol_error(message: &str) -> io::Error {
	io::Error::new(io::ErrorKind::InvalidData, format!("filesystem provider: {message}"))
}

fn required<T>(value: Option<T>, field: &str) -> io::Result<T> {
	value.ok_or_else(|| protocol_error(&format!("response is missing `{field}`")))
}

fn provider_failure(err: &napi::Error) -> io::Error {
	io::Error::other(format!("filesystem provider failed: {}", err.reason))
}

fn advance(position: u64, count: usize) -> io::Result<u64> {
	position
		.checked_add(count as u64)
		.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "file position overflow"))
}

fn wire_u64(value: Either<f64, BigInt>, field: &str) -> io::Result<u64> {
	let converted = match value {
		Either::A(number) => (number.is_finite()
			&& number >= 0.0
			&& number.fract() == 0.0
			&& number <= MAX_SAFE_INTEGER)
			.then_some(number as u64),
		Either::B(big) => match big.get_u64() {
			(false, value, true) => Some(value),
			_ => None,
		},
	};
	converted.ok_or_else(|| {
		protocol_error(&format!("`{field}` must be a non-negative safe integer or u64 bigint"))
	})
}

fn wire_i64(value: Either<f64, BigInt>, field: &str) -> io::Result<i64> {
	let converted = match value {
		Either::A(number) => {
			(number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
				.then_some(number as i64)
		},
		Either::B(big) => match big.get_i64() {
			(value, true) => Some(value),
			_ => None,
		},
	};
	converted
		.ok_or_else(|| protocol_error(&format!("`{field}` must be a safe integer or i64 bigint")))
}

fn wire_time(value: Either<f64, BigInt>, field: &str) -> io::Result<SystemTime> {
	let nanos = match value {
		Either::A(number) if number.is_finite() => Some(number.trunc() as i128),
		Either::A(_) => None,
		Either::B(big) => match big.get_i128() {
			(value, true) => Some(value),
			_ => None,
		},
	};
	let invalid = || protocol_error(&format!("`{field}` is not a representable timestamp"));
	let nanos = nanos.ok_or_else(invalid)?;
	let magnitude = nanos.unsigned_abs();
	let secs = u64::try_from(magnitude / NANOS_PER_SEC).map_err(|_| invalid())?;
	let offset = Duration::new(secs, (magnitude % NANOS_PER_SEC) as u32);
	if nanos >= 0 {
		UNIX_EPOCH.checked_add(offset)
	} else {
		UNIX_EPOCH.checked_sub(offset)
	}
	.ok_or_else(invalid)
}

fn time_to_wire(time: FileTime) -> io::Result<Option<BigInt>> {
	let time = match time {
		FileTime::Omit => return Ok(None),
		FileTime::Now => SystemTime::now(),
		FileTime::At(time) => time,
	};
	let nanos = match time.duration_since(UNIX_EPOCH) {
		Ok(after) => i128::try_from(after.as_nanos()),
		Err(before) => i128::try_from(before.duration().as_nanos()).map(|nanos| -nanos),
	}
	.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "timestamp out of range"))?;
	Ok(Some(BigInt::from(nanos)))
}

const fn file_kind_from_wire(file_type: ShellFsFileType) -> FileKind {
	match file_type {
		ShellFsFileType::File => FileKind::File,
		ShellFsFileType::Dir => FileKind::Dir,
		ShellFsFileType::Symlink => FileKind::Symlink,
		ShellFsFileType::Fifo => FileKind::Fifo,
		ShellFsFileType::Socket => FileKind::Socket,
		ShellFsFileType::Char => FileKind::CharDevice,
		ShellFsFileType::Block => FileKind::BlockDevice,
	}
}

fn metadata_from_wire(wire: ShellFsMetadata) -> io::Result<Metadata> {
	let mut metadata = Metadata::new(
		FileType::from_kind(file_kind_from_wire(wire.file_type)),
		wire_u64(wire.size, "size")?,
		Permissions::from_mode(wire.mode & 0o7777),
	);
	if let Some(time) = wire.mtime_ns {
		metadata = metadata.with_modified(wire_time(time, "mtimeNs")?);
	}
	if let Some(time) = wire.atime_ns {
		metadata = metadata.with_accessed(wire_time(time, "atimeNs")?);
	}
	if let Some(time) = wire.ctime_ns {
		metadata = metadata.with_changed(wire_time(time, "ctimeNs")?);
	}
	if let Some(time) = wire.birthtime_ns {
		metadata = metadata.with_created(wire_time(time, "birthtimeNs")?);
	}
	match (wire.dev, wire.ino) {
		(Some(dev), Some(ino)) => {
			metadata = metadata.with_id(wire_u64(dev, "dev")?, wire_u64(ino, "ino")?);
		},
		(None, None) => {},
		_ => return Err(protocol_error("metadata `dev` and `ino` must be given together")),
	}
	if let Some(nlink) = wire.nlink {
		metadata = metadata.with_nlink(wire_u64(nlink, "nlink")?);
	}
	match (wire.uid, wire.gid) {
		(Some(uid), Some(gid)) => metadata = metadata.with_owner(uid, gid),
		(None, None) => {},
		_ => return Err(protocol_error("metadata `uid` and `gid` must be given together")),
	}
	if let Some(rdev) = wire.rdev {
		metadata = metadata.with_rdev(wire_u64(rdev, "rdev")?);
	}
	match (wire.blocks, wire.blksize) {
		(Some(blocks), Some(blksize)) => {
			metadata =
				metadata.with_blocks(wire_u64(blocks, "blocks")?, wire_u64(blksize, "blksize")?);
		},
		(None, None) => {},
		_ => return Err(protocol_error("metadata `blocks` and `blksize` must be given together")),
	}
	Ok(metadata)
}

fn entry_from_wire(dir: &Path, wire: ShellFsDirEntry) -> io::Result<DirEntry> {
	if wire.name.is_empty() || wire.name == "." || wire.name == ".." || wire.name.contains('/') {
		return Err(protocol_error(&format!("invalid directory entry name {:?}", wire.name)));
	}
	let name = OsString::from(wire.name);
	let path = pi_vfs::child_path(dir, &name);
	let file_type = FileType::from_kind(file_kind_from_wire(wire.file_type));
	let entry = DirEntry::new(path, name, Some(file_type));
	Ok(match wire.metadata {
		Some(metadata) => entry.with_metadata(metadata_from_wire(metadata)?),
		None => entry,
	})
}

fn stat_fs_from_wire(wire: ShellFsStatFs) -> io::Result<StatFs> {
	let optional_u64 = |value: Option<Either<f64, BigInt>>, field: &str| {
		value.map(|value| wire_u64(value, field)).transpose()
	};
	let block_size = wire_u64(wire.block_size, "blockSize")?;
	Ok(StatFs {
		fs_type: wire
			.fs_type
			.map(|value| wire_i64(value, "fsType"))
			.transpose()?,
		fs_type_name: wire.fs_type_name,
		block_size,
		io_size: optional_u64(wire.io_size, "ioSize")?.unwrap_or(block_size),
		blocks: wire_u64(wire.blocks, "blocks")?,
		blocks_free: wire_u64(wire.blocks_free, "blocksFree")?,
		blocks_available: wire_u64(wire.blocks_available, "blocksAvailable")?,
		files: wire_u64(wire.files, "files")?,
		files_free: wire_u64(wire.files_free, "filesFree")?,
		fsid: optional_u64(wire.fsid, "fsid")?,
		name_max: optional_u64(wire.name_max, "nameMax")?,
	})
}

/// Map a provider errno name to the matching `io::Error`. Unix keeps the real
/// errno so kinds, messages, and `raw_os_error` checks match native failures;
/// elsewhere the kind carries the provider message.
fn error_from_wire(error: ShellFsError) -> io::Error {
	#[cfg(unix)]
	if let Some(errno) = errno_for_code(&error.code) {
		return io::Error::from_raw_os_error(errno);
	}
	#[cfg(not(unix))]
	if error.code == "ECANCELED" {
		return pi_vfs::cancelled();
	}
	#[cfg(not(unix))]
	let kind = kind_for_code(&error.code);
	let message = match error.message {
		Some(message) if !message.is_empty() => format!("{}: {message}", error.code),
		_ => error.code,
	};
	#[cfg(unix)]
	return io::Error::other(message);
	#[cfg(not(unix))]
	io::Error::new(kind, message)
}

#[cfg(unix)]
fn errno_for_code(code: &str) -> Option<i32> {
	Some(match code {
		"ENOENT" => libc::ENOENT,
		"EACCES" => libc::EACCES,
		"EPERM" => libc::EPERM,
		"EROFS" => libc::EROFS,
		"EISDIR" => libc::EISDIR,
		"ENOTDIR" => libc::ENOTDIR,
		"EEXIST" => libc::EEXIST,
		"ENOTEMPTY" => libc::ENOTEMPTY,
		"EXDEV" => libc::EXDEV,
		"EINVAL" => libc::EINVAL,
		"ENOTSUP" => libc::ENOTSUP,
		"EOPNOTSUPP" => libc::EOPNOTSUPP,
		"ENOSYS" => libc::ENOSYS,
		"ECANCELED" => libc::ECANCELED,
		"EIO" => libc::EIO,
		"ELOOP" => libc::ELOOP,
		"ENAMETOOLONG" => libc::ENAMETOOLONG,
		"EBADF" => libc::EBADF,
		"ENODATA" => libc::ENODATA,
		#[cfg(any(target_os = "linux", target_os = "android"))]
		"ENOATTR" => libc::ENODATA,
		#[cfg(not(any(target_os = "linux", target_os = "android")))]
		"ENOATTR" => libc::ENOATTR,
		"ENOSPC" => libc::ENOSPC,
		"EBUSY" => libc::EBUSY,
		"EMFILE" => libc::EMFILE,
		"ENFILE" => libc::ENFILE,
		"EFBIG" => libc::EFBIG,
		"ESPIPE" => libc::ESPIPE,
		"ETXTBSY" => libc::ETXTBSY,
		"EAGAIN" => libc::EAGAIN,
		"ENXIO" => libc::ENXIO,
		"ENODEV" => libc::ENODEV,
		"ETIMEDOUT" => libc::ETIMEDOUT,
		"E2BIG" => libc::E2BIG,
		"EMLINK" => libc::EMLINK,
		"ESTALE" => libc::ESTALE,
		"EDQUOT" => libc::EDQUOT,
		"EPIPE" => libc::EPIPE,
		"ERANGE" => libc::ERANGE,
		_ => return None,
	})
}

#[cfg(not(unix))]
fn kind_for_code(code: &str) -> io::ErrorKind {
	use io::ErrorKind;
	match code {
		"ENOENT" => ErrorKind::NotFound,
		"EACCES" | "EPERM" => ErrorKind::PermissionDenied,
		"EEXIST" => ErrorKind::AlreadyExists,
		"EROFS" => ErrorKind::ReadOnlyFilesystem,
		"EISDIR" => ErrorKind::IsADirectory,
		"ENOTDIR" => ErrorKind::NotADirectory,
		"ENOTEMPTY" => ErrorKind::DirectoryNotEmpty,
		"EXDEV" => ErrorKind::CrossesDevices,
		"EINVAL" => ErrorKind::InvalidInput,
		"ENOTSUP" | "EOPNOTSUPP" | "ENOSYS" => ErrorKind::Unsupported,
		"ENAMETOOLONG" => ErrorKind::InvalidFilename,
		"ENOSPC" => ErrorKind::StorageFull,
		"EBUSY" => ErrorKind::ResourceBusy,
		"EFBIG" => ErrorKind::FileTooLarge,
		"ESPIPE" => ErrorKind::NotSeekable,
		"ETXTBSY" => ErrorKind::ExecutableFileBusy,
		"EAGAIN" => ErrorKind::WouldBlock,
		"ETIMEDOUT" => ErrorKind::TimedOut,
		"E2BIG" => ErrorKind::ArgumentListTooLong,
		"EMLINK" => ErrorKind::TooManyLinks,
		"ESTALE" => ErrorKind::StaleNetworkFileHandle,
		"EDQUOT" => ErrorKind::QuotaExceeded,
		"EPIPE" => ErrorKind::BrokenPipe,
		_ => ErrorKind::Other,
	}
}
