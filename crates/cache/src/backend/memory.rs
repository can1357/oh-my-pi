//! In-memory exact-byte journal backend.

use std::{convert::Infallible, sync::Arc};

use bytes::Bytes;

use super::ByteJournalStore;

/// In-memory journal useful for ephemeral daemon sessions.
#[derive(Clone, Debug, Default)]
pub struct MemoryStore {
	bytes: Vec<u8>,
}

impl MemoryStore {
	/// Creates an empty memory journal.
	pub const fn new() -> Self {
		Self { bytes: Vec::new() }
	}

	/// Creates a journal from existing v4 bytes.
	pub fn from_bytes(bytes: impl Into<Vec<u8>>) -> Self {
		Self { bytes: bytes.into() }
	}

	/// Returns the exact stored bytes.
	pub fn as_bytes(&self) -> &[u8] {
		&self.bytes
	}

	/// Freezes the journal for clone-cheap snapshot distribution.
	pub fn snapshot(&self) -> Arc<[u8]> {
		Arc::from(self.bytes.as_slice())
	}
}

impl ByteJournalStore for MemoryStore {
	type Error = Infallible;

	fn len(&mut self) -> Result<u64, Self::Error> {
		Ok(u64::try_from(self.bytes.len()).expect("memory journal length fits in u64"))
	}

	fn read(&mut self, offset: u64, maximum: usize) -> Result<Vec<u8>, Self::Error> {
		let start = usize::try_from(offset)
			.unwrap_or(usize::MAX)
			.min(self.bytes.len());
		let end = start.saturating_add(maximum).min(self.bytes.len());
		Ok(self.bytes[start..end].to_vec())
	}

	fn append(&mut self, bytes: &[u8]) -> Result<u64, Self::Error> {
		self.bytes.extend_from_slice(bytes);
		self.len()
	}

	fn truncate(&mut self, len: u64) -> Result<(), Self::Error> {
		self
			.bytes
			.truncate(usize::try_from(len).unwrap_or(usize::MAX));
		Ok(())
	}

	fn sync(&mut self) -> Result<(), Self::Error> {
		Ok(())
	}
}

impl From<Bytes> for MemoryStore {
	fn from(bytes: Bytes) -> Self {
		Self::from_bytes(bytes.to_vec())
	}
}
