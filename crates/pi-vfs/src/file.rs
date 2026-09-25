//! Open file handles: host files and provider-owned handles.

use std::{
	fmt,
	io::{self, Read, Seek, SeekFrom, Write},
	sync::Arc,
};

use async_trait::async_trait;
use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::{
	error::unsupported,
	metadata::Metadata,
	native,
	runtime::{CloseTicket, CloseTracker, Scope, block_on, park_on},
	types::{FileId, FileTime, Permissions},
};

/// Chunk size for whole-file reads and copies through provider handles.
pub(crate) const COPY_CHUNK: usize = 64 * 1024;

/// A provider's open file.
///
/// The handle owns its cursor; every method takes `&self` because
/// [`File::try_clone`] shares one handle (and therefore one position) between
/// clones, like `dup`. [`FileHandle::close`] runs exactly once, when the last
/// clone is closed or dropped.
#[async_trait]
pub trait FileHandle: Send + Sync + fmt::Debug + 'static {
	/// Reads at the cursor; `Ok(0)` is end of file.
	async fn read(&self, buf: &mut [u8]) -> io::Result<usize>;

	/// Writes at the cursor (at end of file for append handles).
	async fn write(&self, buf: &[u8]) -> io::Result<usize>;

	/// Moves the cursor; unseekable streams return an error.
	async fn seek(&self, pos: SeekFrom) -> io::Result<u64>;

	async fn metadata(&self) -> io::Result<Metadata>;

	/// Pushes buffered writes to the provider; errors must surface here.
	async fn flush(&self) -> io::Result<()> {
		Ok(())
	}

	async fn set_len(&self, _size: u64) -> io::Result<()> {
		Err(unsupported("set_len"))
	}

	async fn set_permissions(&self, _permissions: Permissions) -> io::Result<()> {
		Err(unsupported("set_permissions"))
	}

	async fn set_times(&self, _accessed: FileTime, _modified: FileTime) -> io::Result<()> {
		Err(unsupported("set_times"))
	}

	async fn sync_all(&self) -> io::Result<()> {
		self.flush().await
	}

	async fn sync_data(&self) -> io::Result<()> {
		self.sync_all().await
	}

	/// Whether another process holds a conflicting advisory write lock.
	async fn is_locked(&self) -> io::Result<bool> {
		Err(unsupported("lock query"))
	}

	/// Commits and releases the handle. Never cancelled.
	async fn close(&self) -> io::Result<()> {
		self.flush().await
	}
}

/// An open file: a host [`std::fs::File`] or a provider [`FileHandle`].
///
/// Implements [`Read`], [`Write`], and [`Seek`] (also for `&File`) plus
/// `*_async` equivalents. Synchronous I/O on provider handles is for blocking
/// workers and foreign threads; async code must use the `*_async` methods.
pub struct File {
	repr: Repr,
}

enum Repr {
	Native(std::fs::File),
	Virtual(Arc<Shared>),
}

struct Shared {
	/// `None` only after the handle has been closed.
	handle:  Option<Arc<dyn FileHandle>>,
	runtime: Option<Handle>,
	cancel:  Option<CancellationToken>,
	closes:  Option<Arc<CloseTracker>>,
}

impl Shared {
	fn handle(&self) -> &dyn FileHandle {
		match &self.handle {
			Some(handle) => &**handle,
			None => unreachable!("provider file handle used after close"),
		}
	}

	async fn guard<T>(&self, fut: impl Future<Output = io::Result<T>> + Send) -> io::Result<T> {
		Scope::guard(self.cancel.as_ref(), fut).await
	}

	fn run<T>(&self, fut: impl Future<Output = io::Result<T>>) -> io::Result<T> {
		block_on(self.runtime.as_ref(), Scope::guard(self.cancel.as_ref(), fut))
	}
}

impl Drop for Shared {
	fn drop(&mut self) {
		let Some(handle) = self.handle.take() else {
			return;
		};
		// Never block here: a drop may run on a runtime thread whose reactor the
		// provider needs. Closes go to the runtime and are tracked for
		// `drain_closes`; only a thread with no runtime at all closes inline.
		if let Some(runtime) = Handle::try_current().ok().or_else(|| self.runtime.clone()) {
			let ticket = CloseTicket::new(self.closes.clone());
			runtime.spawn(async move {
				let result = handle.close().await;
				ticket.finish(result);
			});
		} else {
			let result = park_on(handle.close());
			if let Some(closes) = &self.closes {
				closes.record(result);
			}
		}
	}
}

impl fmt::Debug for File {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match &self.repr {
			Repr::Native(file) => f.debug_tuple("File::Native").field(file).finish(),
			Repr::Virtual(shared) => match &shared.handle {
				Some(handle) => f.debug_tuple("File::Virtual").field(handle).finish(),
				None => f.write_str("File::Virtual(<closed>)"),
			},
		}
	}
}

impl From<std::fs::File> for File {
	fn from(file: std::fs::File) -> Self {
		Self { repr: Repr::Native(file) }
	}
}

/// `&std::fs::File` implements the std I/O traits; returning it by value
/// gives the method call a mutable receiver without `mut` bindings.
const fn host(file: &std::fs::File) -> &std::fs::File {
	file
}

async fn read_to_end_handle(handle: &dyn FileHandle, buf: &mut Vec<u8>) -> io::Result<usize> {
	let start = buf.len();
	let mut chunk = vec![0; COPY_CHUNK];
	loop {
		match handle.read(&mut chunk).await {
			Ok(0) => return Ok(buf.len() - start),
			Ok(n) => buf.extend_from_slice(&chunk[..n]),
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
}

async fn write_all_handle(handle: &dyn FileHandle, mut buf: &[u8]) -> io::Result<()> {
	while !buf.is_empty() {
		match handle.write(buf).await {
			Ok(0) => {
				return Err(io::Error::new(io::ErrorKind::WriteZero, "failed to write whole buffer"));
			},
			Ok(n) => buf = &buf[n..],
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(err) => return Err(err),
		}
	}
	Ok(())
}

fn append_utf8(buf: &mut String, bytes: Vec<u8>) -> io::Result<usize> {
	let text = String::from_utf8(bytes).map_err(|_| {
		io::Error::new(io::ErrorKind::InvalidData, "stream did not contain valid UTF-8")
	})?;
	buf.push_str(&text);
	Ok(text.len())
}

impl File {
	/// Wraps a provider handle. The current tokio runtime (if any) is captured
	/// to drive synchronous I/O and deferred closes from foreign threads.
	pub fn from_handle(handle: impl FileHandle) -> Self {
		Self::from_arc(Arc::new(handle))
	}

	/// Wraps a shared provider handle; see [`File::from_handle`].
	pub fn from_arc(handle: Arc<dyn FileHandle>) -> Self {
		Self {
			repr: Repr::Virtual(Arc::new(Shared {
				handle:  Some(handle),
				runtime: Handle::try_current().ok(),
				cancel:  None,
				closes:  None,
			})),
		}
	}

	/// Attaches a facade's cancellation token and close tracker to a freshly
	/// opened provider file.
	pub(crate) fn bind(mut self, scope: &Scope) -> Self {
		if let Repr::Virtual(shared) = &mut self.repr
			&& let Some(shared) = Arc::get_mut(shared)
		{
			if shared.cancel.is_none() {
				shared.cancel.clone_from(&scope.cancel);
			}
			if shared.closes.is_none() {
				shared.closes.clone_from(&scope.closes);
			}
		}
		self
	}

	/// The host file, for fd-level fast paths (mmap, `lseek`, ...).
	pub const fn native(&self) -> Option<&std::fs::File> {
		match &self.repr {
			Repr::Native(file) => Some(file),
			Repr::Virtual(_) => None,
		}
	}

	pub fn into_native(self) -> Result<std::fs::File, Self> {
		match self.repr {
			Repr::Native(file) => Ok(file),
			repr @ Repr::Virtual(_) => Err(Self { repr }),
		}
	}

	pub const fn is_native(&self) -> bool {
		matches!(self.repr, Repr::Native(_))
	}

	/// A second handle sharing this one's position (`dup`).
	pub fn try_clone(&self) -> io::Result<Self> {
		Ok(Self {
			repr: match &self.repr {
				Repr::Native(file) => Repr::Native(file.try_clone()?),
				Repr::Virtual(shared) => Repr::Virtual(Arc::clone(shared)),
			},
		})
	}

	pub fn metadata(&self) -> io::Result<Metadata> {
		match &self.repr {
			Repr::Native(file) => native::file_metadata(file),
			Repr::Virtual(shared) => shared.run(shared.handle().metadata()),
		}
	}

	pub fn set_len(&self, size: u64) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.set_len(size),
			Repr::Virtual(shared) => shared.run(shared.handle().set_len(size)),
		}
	}

	pub fn set_permissions(&self, permissions: Permissions) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => native::file_set_permissions(file, permissions),
			Repr::Virtual(shared) => shared.run(shared.handle().set_permissions(permissions)),
		}
	}

	/// `futimens`: [`FileTime::Omit`] leaves a timestamp, [`FileTime::Now`]
	/// uses the filesystem clock.
	pub fn set_times(
		&self,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
	) -> io::Result<()> {
		let (accessed, modified) = (accessed.into(), modified.into());
		match &self.repr {
			Repr::Native(file) => native::file_set_times(file, accessed, modified),
			Repr::Virtual(shared) => shared.run(shared.handle().set_times(accessed, modified)),
		}
	}

	pub fn sync_all(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_all(),
			Repr::Virtual(shared) => shared.run(shared.handle().sync_all()),
		}
	}

	pub fn sync_data(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_data(),
			Repr::Virtual(shared) => shared.run(shared.handle().sync_data()),
		}
	}

	/// Identity of the open object; `Unsupported` when the provider has none.
	pub fn file_id(&self) -> io::Result<FileId> {
		match &self.repr {
			Repr::Native(file) => native::file_id_of(file),
			Repr::Virtual(_) => self
				.metadata()?
				.file_id()
				.ok_or_else(|| unsupported("file identity")),
		}
	}

	/// Whether another process holds a conflicting advisory write lock
	/// (`F_GETLK`).
	pub fn is_locked(&self) -> io::Result<bool> {
		match &self.repr {
			Repr::Native(file) => native::file_is_locked(file),
			Repr::Virtual(shared) => shared.run(shared.handle().is_locked()),
		}
	}

	/// Closes this handle and reports errors that dropping would lose. The last
	/// clone closes the provider handle; earlier clones only flush it.
	pub fn close(self) -> io::Result<()> {
		match self.repr {
			Repr::Native(file) => native::close(file),
			Repr::Virtual(shared) => match Arc::try_unwrap(shared) {
				Ok(mut shared) => {
					let handle = shared.handle.take();
					match handle {
						Some(handle) => block_on(shared.runtime.as_ref(), handle.close()),
						None => Ok(()),
					}
				},
				Err(shared) => shared.run(shared.handle().flush()),
			},
		}
	}

	pub async fn read_async(&self, buf: &mut [u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).read(buf),
			Repr::Virtual(shared) => shared.guard(shared.handle().read(buf)).await,
		}
	}

	pub async fn write_async(&self, buf: &[u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).write(buf),
			Repr::Virtual(shared) => shared.guard(shared.handle().write(buf)).await,
		}
	}

	pub async fn write_all_async(&self, buf: &[u8]) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => host(file).write_all(buf),
			Repr::Virtual(shared) => shared.guard(write_all_handle(shared.handle(), buf)).await,
		}
	}

	pub async fn read_to_end_async(&self, buf: &mut Vec<u8>) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).read_to_end(buf),
			Repr::Virtual(shared) => shared.guard(read_to_end_handle(shared.handle(), buf)).await,
		}
	}

	pub async fn read_to_string_async(&self, buf: &mut String) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).read_to_string(buf),
			Repr::Virtual(_) => {
				let mut bytes = Vec::new();
				self.read_to_end_async(&mut bytes).await?;
				append_utf8(buf, bytes)
			},
		}
	}

	pub async fn flush_async(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(_) => Ok(()),
			Repr::Virtual(shared) => shared.guard(shared.handle().flush()).await,
		}
	}

	pub async fn seek_async(&self, pos: SeekFrom) -> io::Result<u64> {
		match &self.repr {
			Repr::Native(file) => host(file).seek(pos),
			Repr::Virtual(shared) => shared.guard(shared.handle().seek(pos)).await,
		}
	}

	pub async fn metadata_async(&self) -> io::Result<Metadata> {
		match &self.repr {
			Repr::Native(file) => native::file_metadata(file),
			Repr::Virtual(shared) => shared.guard(shared.handle().metadata()).await,
		}
	}

	pub async fn set_len_async(&self, size: u64) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.set_len(size),
			Repr::Virtual(shared) => shared.guard(shared.handle().set_len(size)).await,
		}
	}

	pub async fn set_permissions_async(&self, permissions: Permissions) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => native::file_set_permissions(file, permissions),
			Repr::Virtual(shared) => {
				shared
					.guard(shared.handle().set_permissions(permissions))
					.await
			},
		}
	}

	pub async fn set_times_async(
		&self,
		accessed: impl Into<FileTime>,
		modified: impl Into<FileTime>,
	) -> io::Result<()> {
		let (accessed, modified) = (accessed.into(), modified.into());
		match &self.repr {
			Repr::Native(file) => native::file_set_times(file, accessed, modified),
			Repr::Virtual(shared) => {
				shared
					.guard(shared.handle().set_times(accessed, modified))
					.await
			},
		}
	}

	pub async fn sync_all_async(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_all(),
			Repr::Virtual(shared) => shared.guard(shared.handle().sync_all()).await,
		}
	}

	pub async fn sync_data_async(&self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => file.sync_data(),
			Repr::Virtual(shared) => shared.guard(shared.handle().sync_data()).await,
		}
	}

	pub async fn is_locked_async(&self) -> io::Result<bool> {
		match &self.repr {
			Repr::Native(file) => native::file_is_locked(file),
			Repr::Virtual(shared) => shared.guard(shared.handle().is_locked()).await,
		}
	}

	/// Async [`File::close`].
	pub async fn close_async(self) -> io::Result<()> {
		match self.repr {
			Repr::Native(file) => native::close(file),
			Repr::Virtual(shared) => match Arc::try_unwrap(shared) {
				Ok(mut shared) => match shared.handle.take() {
					Some(handle) => handle.close().await,
					None => Ok(()),
				},
				Err(shared) => shared.guard(shared.handle().flush()).await,
			},
		}
	}
}

impl Read for &File {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).read(buf),
			Repr::Virtual(shared) => shared.run(shared.handle().read(buf)),
		}
	}

	fn read_to_end(&mut self, buf: &mut Vec<u8>) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).read_to_end(buf),
			Repr::Virtual(shared) => shared.run(read_to_end_handle(shared.handle(), buf)),
		}
	}

	fn read_to_string(&mut self, buf: &mut String) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).read_to_string(buf),
			Repr::Virtual(_) => {
				let mut bytes = Vec::new();
				self.read_to_end(&mut bytes)?;
				append_utf8(buf, bytes)
			},
		}
	}
}

impl Write for &File {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		match &self.repr {
			Repr::Native(file) => host(file).write(buf),
			Repr::Virtual(shared) => shared.run(shared.handle().write(buf)),
		}
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		match &self.repr {
			Repr::Native(file) => host(file).write_all(buf),
			Repr::Virtual(shared) => shared.run(write_all_handle(shared.handle(), buf)),
		}
	}

	fn flush(&mut self) -> io::Result<()> {
		match &self.repr {
			Repr::Native(_) => Ok(()),
			Repr::Virtual(shared) => shared.run(shared.handle().flush()),
		}
	}
}

impl Seek for &File {
	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		match &self.repr {
			Repr::Native(file) => host(file).seek(pos),
			Repr::Virtual(shared) => shared.run(shared.handle().seek(pos)),
		}
	}
}

impl Read for File {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		(&*self).read(buf)
	}

	fn read_to_end(&mut self, buf: &mut Vec<u8>) -> io::Result<usize> {
		(&*self).read_to_end(buf)
	}

	fn read_to_string(&mut self, buf: &mut String) -> io::Result<usize> {
		(&*self).read_to_string(buf)
	}
}

impl Write for File {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		(&*self).write(buf)
	}

	fn write_all(&mut self, buf: &[u8]) -> io::Result<()> {
		(&*self).write_all(buf)
	}

	fn flush(&mut self) -> io::Result<()> {
		(&*self).flush()
	}
}

impl Seek for File {
	fn seek(&mut self, pos: SeekFrom) -> io::Result<u64> {
		(&*self).seek(pos)
	}
}
