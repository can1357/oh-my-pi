//! Injectable asynchronous filesystem shared by the embedded shell and its
//! coreutils.
//!
//! [`Fs`] is the cloneable async facade; [`BlockingFs`] is its synchronous
//! twin for utility bodies running on blocking workers. Both default to the
//! host filesystem and dispatch host paths straight to `std`/libc without
//! futures or boxing. [`Fs::new`] injects a [`FileSystem`] provider that sees
//! every path it is asked about verbatim, including `scheme://authority/...`
//! URLs; providers own their [`File`] handles, [`Metadata`], and directory
//! entries, so virtual files are never materialized on the host.
//!
//! URL spelling is preserved end to end: the lexical helpers in this crate
//! ([`absolute_path`], [`join_path`], [`parent_path`], [`normalize_lexically`],
//! ...) never prefix a URL with the host working directory or collapse its
//! `://` separator. URL segments are percent-encoded spellings: helpers that
//! build paths from raw names ([`join_path`], [`child_path`],
//! [`with_file_name`]) encode, [`file_name`] decodes once.
//!
//! # Threading contract
//!
//! Host operations never involve futures on either facade. Provider
//! operations are futures: async code (the shell) awaits [`Fs`] methods and
//! the `*_async` methods of [`File`]/[`DirEntry`]. [`BlockingFs`] and the
//! synchronous [`File`] I/O drive provider futures with
//! `tokio::task::block_in_place` + `Handle::block_on`, which is valid on
//! blocking-pool threads, foreign threads (rayon, plain threads), and
//! multi-thread runtime workers. On a current-thread runtime's own thread
//! tokio rejects this with a panic — a contract violation, never a deadlock.
//!
//! Dropping the last clone of a provider [`File`] never blocks: its close is
//! spawned on the runtime and tracked, so owners await [`Fs::drain_closes`]
//! (or call [`File::close`]/[`File::close_async`]) wherever ordering or close
//! errors matter.

mod canonicalize;
mod dir;
mod error;
mod file;
mod fs;
mod metadata;
mod native;
mod options;
mod path;
mod provider;
mod runtime;
mod types;

#[cfg(test)]
mod tests;

pub use dir::{DirEntry, ReadDir};
pub use error::{
	cancelled, crosses_devices, invalid_argument, is_a_directory, is_cancelled, no_provider,
	not_a_directory, permission_denied, read_only_filesystem, unsupported,
};
pub use file::{File, FileHandle};
pub use fs::{BlockingFs, Fs};
pub use metadata::Metadata;
pub use options::{
	CanonicalizeOptions, DirOptions, MissingHandling, OpenOptions, ResolveMode, TempOptions,
};
pub use path::{
	absolute_path, child_path, decode_segment, encode_segment, file_name, is_virtual_path,
	join_path, normalize_lexically, parent_path, relative_path, url_scheme, with_file_name,
};
pub use provider::FileSystem;
pub use types::{FileId, FileKind, FileTime, FileType, NodeKind, Permissions, StatFs, SymlinkKind};
