//! Byte-oriented journal storage targets.
//!
//! The transcript codec remains the only owner of v4 semantics. Backends only
//! preserve exact bytes and expose the append/rollback operations needed by a
//! single daemon writer.

use std::{
	fs::{File, OpenOptions},
	io::{Read as _, Seek as _, SeekFrom, Write as _},
	path::{Path, PathBuf},
};

use thiserror::Error;

pub mod memory;
pub mod redis;
pub mod sql;

use std::{error, io};

pub use memory::MemoryStore;
pub use redis::RedisStore;
pub use sql::{SqlDialect, SqlStore};

/// Exact-byte operations required by the daemon-owned journal writer.
pub trait ByteJournalStore {
	/// Typed backend failure.
	type Error: error::Error + Send + Sync + 'static;

	/// Returns the current byte length.
	fn len(&mut self) -> Result<u64, Self::Error>;

	/// Returns whether the journal has no bytes.
	fn is_empty(&mut self) -> Result<bool, Self::Error> {
		self.len().map(|len| len == 0)
	}

	/// Reads at most `maximum` bytes beginning at `offset`.
	fn read(&mut self, offset: u64, maximum: usize) -> Result<Vec<u8>, Self::Error>;

	/// Appends bytes exactly and returns the resulting byte length.
	fn append(&mut self, bytes: &[u8]) -> Result<u64, Self::Error>;

	/// Truncates the journal to an earlier byte length.
	fn truncate(&mut self, len: u64) -> Result<(), Self::Error>;

	/// Makes preceding writes durable according to backend guarantees.
	fn sync(&mut self) -> Result<(), Self::Error>;
}

/// File-backed exact-byte journal target.
pub struct FileStore {
	path: PathBuf,
	file: File,
}

impl FileStore {
	/// Opens or creates a journal byte file without changing its contents.
	pub fn open(path: impl AsRef<Path>) -> Result<Self, io::Error> {
		let path = path.as_ref().to_owned();
		let file = OpenOptions::new()
			.read(true)
			.write(true)
			.create(true)
			.truncate(false)
			.open(&path)?;
		Ok(Self { path, file })
	}

	/// Returns the backing path.
	pub fn path(&self) -> &Path {
		&self.path
	}
}

impl ByteJournalStore for FileStore {
	type Error = io::Error;

	fn len(&mut self) -> Result<u64, Self::Error> {
		Ok(self.file.metadata()?.len())
	}

	fn read(&mut self, offset: u64, maximum: usize) -> Result<Vec<u8>, Self::Error> {
		self.file.seek(SeekFrom::Start(offset))?;
		let mut bytes = Vec::with_capacity(maximum.min(64 * 1024));
		io::Read::by_ref(&mut self.file)
			.take(u64::try_from(maximum).unwrap_or(u64::MAX))
			.read_to_end(&mut bytes)?;
		Ok(bytes)
	}

	fn append(&mut self, bytes: &[u8]) -> Result<u64, Self::Error> {
		self.file.seek(SeekFrom::End(0))?;
		self.file.write_all(bytes)?;
		self.len()
	}

	fn truncate(&mut self, len: u64) -> Result<(), Self::Error> {
		self.file.set_len(len)?;
		self.file.seek(SeekFrom::Start(len))?;
		Ok(())
	}

	fn sync(&mut self) -> Result<(), Self::Error> {
		self.file.sync_data()
	}
}

/// Failure from one append-first daemon transaction.
#[derive(Debug, Error)]
pub enum DaemonWriteError<E: error::Error + 'static> {
	/// The append failed and rollback restored the original bytes.
	#[error("journal append failed and was rolled back")]
	RolledBack {
		/// Backend append failure.
		#[source]
		source: E,
	},
	/// Both the append and rollback failed, leaving durability indeterminate.
	#[error("journal append and rollback both failed; writer is poisoned")]
	Indeterminate {
		/// Backend append failure.
		#[source]
		append:   E,
		/// Backend rollback failure.
		rollback: E,
	},
	/// A prior indeterminate failure permanently halted this writer.
	#[error("journal writer is poisoned after an indeterminate append")]
	Poisoned,
}

/// Single-owner append-first writer shared by every byte backend.
pub struct DaemonWriter<S> {
	store:    S,
	poisoned: bool,
}

impl<S> DaemonWriter<S>
where
	S: ByteJournalStore,
{
	/// Wraps one backend in the sole journal-writer transaction protocol.
	pub const fn new(store: S) -> Self {
		Self { store, poisoned: false }
	}

	/// Appends and synchronizes one exact v4 byte group, rolling back on
	/// failure.
	pub fn append(&mut self, bytes: &[u8]) -> Result<u64, DaemonWriteError<S::Error>> {
		if self.poisoned {
			return Err(DaemonWriteError::Poisoned);
		}
		let original = match self.store.len() {
			Ok(len) => len,
			Err(source) => return Err(DaemonWriteError::RolledBack { source }),
		};
		let result = self.store.append(bytes).and_then(|len| {
			self.store.sync()?;
			Ok(len)
		});
		match result {
			Ok(len) => Ok(len),
			Err(source) => match self
				.store
				.truncate(original)
				.and_then(|()| self.store.sync())
			{
				Ok(()) => Err(DaemonWriteError::RolledBack { source }),
				Err(rollback) => {
					self.poisoned = true;
					Err(DaemonWriteError::Indeterminate { append: source, rollback })
				},
			},
		}
	}

	/// Returns whether an indeterminate outcome halted future writes.
	pub const fn is_poisoned(&self) -> bool {
		self.poisoned
	}

	/// Borrows the byte target for read-only daemon services.
	pub const fn store(&self) -> &S {
		&self.store
	}

	/// Mutably borrows the target while retaining single-writer ownership.
	pub const fn store_mut(&mut self) -> &mut S {
		&mut self.store
	}
}

/// Marker wrapper for a byte store whose journal appends are projected into
/// [`crate::index::SessionIndex`] by the owning daemon after append success.
///
/// The wrapper intentionally performs no SQLite writes itself: projections
/// require a decoded event and must remain in the journal owner's transaction.
pub struct IndexedStore<S> {
	inner: S,
}

impl<S> IndexedStore<S> {
	/// Marks a byte store as attached to the daemon's derived index path.
	pub const fn new(inner: S) -> Self {
		Self { inner }
	}

	/// Consumes the marker and returns its exact-byte store.
	pub fn into_inner(self) -> S {
		self.inner
	}
}

impl<S: ByteJournalStore> ByteJournalStore for IndexedStore<S> {
	type Error = S::Error;

	fn len(&mut self) -> Result<u64, Self::Error> {
		self.inner.len()
	}

	fn read(&mut self, offset: u64, maximum: usize) -> Result<Vec<u8>, Self::Error> {
		self.inner.read(offset, maximum)
	}

	fn append(&mut self, bytes: &[u8]) -> Result<u64, Self::Error> {
		self.inner.append(bytes)
	}

	fn truncate(&mut self, len: u64) -> Result<(), Self::Error> {
		self.inner.truncate(len)
	}

	fn sync(&mut self) -> Result<(), Self::Error> {
		self.inner.sync()
	}
}
