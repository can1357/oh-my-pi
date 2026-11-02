//! Directory listings.

use std::{ffi::OsString, fmt, io, path::PathBuf, sync::Arc};

use tokio::runtime::Handle;
use tokio_util::sync::CancellationToken;

use crate::{
	error::unsupported,
	metadata::Metadata,
	provider::FileSystem,
	runtime::{Scope, block_on},
	types::FileType,
};

/// Provider access for lazily fetched entry metadata.
#[derive(Clone)]
pub(crate) struct EntryBinding {
	pub(crate) provider: Arc<dyn FileSystem>,
	pub(crate) runtime:  Option<Handle>,
	pub(crate) cancel:   Option<CancellationToken>,
}

/// Iterator over a directory's entries (without `.` and `..`).
pub struct ReadDir {
	repr: ReadDirRepr,
}

#[allow(clippy::large_enum_variant, reason = "host listings stay unboxed so they never allocate")]
enum ReadDirRepr {
	Native(std::fs::ReadDir),
	Virtual {
		entries: Box<dyn Iterator<Item = io::Result<DirEntry>> + Send>,
		binding: Option<EntryBinding>,
	},
}

impl ReadDir {
	/// Provider constructor.
	pub fn from_entries<I>(entries: I) -> Self
	where
		I: IntoIterator<Item = io::Result<DirEntry>>,
		I::IntoIter: Send + 'static,
	{
		Self { repr: ReadDirRepr::Virtual { entries: Box::new(entries.into_iter()), binding: None } }
	}

	pub(crate) const fn native(read_dir: std::fs::ReadDir) -> Self {
		Self { repr: ReadDirRepr::Native(read_dir) }
	}

	pub(crate) fn bind(mut self, binding: EntryBinding) -> Self {
		if let ReadDirRepr::Virtual { binding: slot, .. } = &mut self.repr {
			slot.get_or_insert(binding);
		}
		self
	}
}

impl Iterator for ReadDir {
	type Item = io::Result<DirEntry>;

	fn next(&mut self) -> Option<Self::Item> {
		match &mut self.repr {
			ReadDirRepr::Native(read_dir) => read_dir
				.next()
				.map(|entry| entry.map(|entry| DirEntry { repr: EntryRepr::Native(entry) })),
			ReadDirRepr::Virtual { entries, binding } => entries.next().map(|entry| {
				entry.map(|mut entry| {
					if let EntryRepr::Virtual(virt) = &mut entry.repr
						&& virt.binding.is_none()
					{
						virt.binding.clone_from(binding);
					}
					entry
				})
			}),
		}
	}
}

impl fmt::Debug for ReadDir {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		match &self.repr {
			ReadDirRepr::Native(read_dir) => f.debug_tuple("ReadDir::Native").field(read_dir).finish(),
			ReadDirRepr::Virtual { .. } => f.write_str("ReadDir::Virtual"),
		}
	}
}

/// One directory entry.
pub struct DirEntry {
	repr: EntryRepr,
}

#[allow(clippy::large_enum_variant, reason = "host entries stay unboxed so they never allocate")]
enum EntryRepr {
	Native(std::fs::DirEntry),
	Virtual(Box<VirtualEntry>),
}

struct VirtualEntry {
	path:      PathBuf,
	file_name: OsString,
	file_type: Option<FileType>,
	metadata:  Option<Metadata>,
	binding:   Option<EntryBinding>,
}

impl DirEntry {
	/// Provider constructor. `path` is the full path (URL spelling included);
	/// without a `file_type` or [`DirEntry::with_metadata`], type queries fall
	/// back to the provider's `symlink_metadata`.
	pub fn new(path: PathBuf, file_name: OsString, file_type: Option<FileType>) -> Self {
		Self {
			repr: EntryRepr::Virtual(Box::new(VirtualEntry {
				path,
				file_name,
				file_type,
				metadata: None,
				binding: None,
			})),
		}
	}

	/// Provider builder: the entry's (non-following) metadata.
	pub fn with_metadata(mut self, metadata: Metadata) -> Self {
		if let EntryRepr::Virtual(virt) = &mut self.repr {
			virt.file_type.get_or_insert_with(|| metadata.file_type());
			virt.metadata = Some(metadata);
		}
		self
	}

	pub const fn native(&self) -> Option<&std::fs::DirEntry> {
		match &self.repr {
			EntryRepr::Native(entry) => Some(entry),
			EntryRepr::Virtual(_) => None,
		}
	}

	pub fn path(&self) -> PathBuf {
		match &self.repr {
			EntryRepr::Native(entry) => entry.path(),
			EntryRepr::Virtual(virt) => virt.path.clone(),
		}
	}

	pub fn file_name(&self) -> OsString {
		match &self.repr {
			EntryRepr::Native(entry) => entry.file_name(),
			EntryRepr::Virtual(virt) => virt.file_name.clone(),
		}
	}

	/// The entry's type without following symlinks.
	pub fn file_type(&self) -> io::Result<FileType> {
		match &self.repr {
			EntryRepr::Native(entry) => entry.file_type().map(Into::into),
			EntryRepr::Virtual(virt) => match virt.file_type {
				Some(file_type) => Ok(file_type),
				None => self.metadata().map(|metadata| metadata.file_type()),
			},
		}
	}

	/// The entry's metadata without following symlinks.
	pub fn metadata(&self) -> io::Result<Metadata> {
		match &self.repr {
			EntryRepr::Native(entry) => entry.metadata().map(Into::into),
			EntryRepr::Virtual(virt) => {
				if let Some(metadata) = &virt.metadata {
					return Ok(metadata.clone());
				}
				let binding = virt
					.binding
					.as_ref()
					.ok_or_else(|| unsupported("directory entry metadata"))?;
				block_on(
					binding.runtime.as_ref(),
					Scope::guard(binding.cancel.as_ref(), binding.provider.symlink_metadata(&virt.path)),
				)
			},
		}
	}

	/// Async [`DirEntry::file_type`].
	pub async fn file_type_async(&self) -> io::Result<FileType> {
		match &self.repr {
			EntryRepr::Native(entry) => entry.file_type().map(Into::into),
			EntryRepr::Virtual(virt) => match virt.file_type {
				Some(file_type) => Ok(file_type),
				None => self
					.metadata_async()
					.await
					.map(|metadata| metadata.file_type()),
			},
		}
	}

	/// Async [`DirEntry::metadata`].
	pub async fn metadata_async(&self) -> io::Result<Metadata> {
		match &self.repr {
			EntryRepr::Native(entry) => entry.metadata().map(Into::into),
			EntryRepr::Virtual(virt) => {
				if let Some(metadata) = &virt.metadata {
					return Ok(metadata.clone());
				}
				let binding = virt
					.binding
					.as_ref()
					.ok_or_else(|| unsupported("directory entry metadata"))?;
				Scope::guard(binding.cancel.as_ref(), binding.provider.symlink_metadata(&virt.path))
					.await
			},
		}
	}

	/// The entry's type when known without a provider call.
	pub(crate) fn known_file_type(&self) -> Option<FileType> {
		match &self.repr {
			EntryRepr::Native(entry) => entry.file_type().ok().map(Into::into),
			EntryRepr::Virtual(virt) => virt.file_type,
		}
	}
}

impl fmt::Debug for DirEntry {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_tuple("DirEntry").field(&self.path()).finish()
	}
}
