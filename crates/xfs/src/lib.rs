//! Extended filesystem: parallel walking, globbing, content search, and change
//! notification.
//!
//! One stack serves every tool that lists or searches files: the agent's
//! `glob`/`grep`/`search` natives, ast-grep discovery, fuzzy find, workspace
//! listing, and the embedded shell's `rg`, `grep`, `fd`, and `find`.
//!
//! - [`fs`]: the filesystem layer. [`Fs::Native`] reads the host through
//!   per-platform syscall fast paths (relative `openat` opens, bulk directory
//!   reads, no per-entry `stat` for minimal listings); [`Fs::Provider`] awaits
//!   any async [`omp_vfs::Fs`] provider, including `scheme://` URL roots.
//! - [`pattern`]: glob compilation with `globset` literal-separator semantics
//!   plus the pruning queries a walker needs.
//! - [`ignore`]: gitignore-format rules and the `.ignore`/`.gitignore`/
//!   `.git/info/exclude`/global-excludes chain.
//! - [`walk`]: the async parallel walker ([`walk::walk`], [`walk::collect`]),
//!   the listing cache, and the serial ordered traversal cursor
//!   ([`walk::Tree`]).
//! - [`glob`]: path selection in pi's glob dialect and the glob search.
//! - [`grep`]: pattern compilation in pi's regex dialect, buffer scanning, and
//!   the directory/file content search.
//! - [`watch`]: file-system change notification on the platform's own mechanism
//!   (FSEvents, inotify, `ReadDirectoryChangesW`, kqueue, polling).
//!
//! Below an ovnfs checkout, [`glob::glob`] and [`grep::grep`] ask the ovnfs
//! daemon serving it first, which searches its overlay in-process instead of
//! paying an NFS round trip per file, and walk when it cannot answer.
//!
//! Walker futures spawn their tasks on the current tokio runtime (a
//! multi-thread runtime keeps them parallel); dropping a future cancels its
//! work.
//!
//! # Example
//! ```ignore
//! use omp_xfs::{Fs, walk};
//!
//! let root = std::path::Path::new("/repo");
//! let opts = walk::Options { gitignore: true, skip_git: true, ..Default::default() };
//! let files = walk::collect(&Fs::native(), root, &opts, true, |_, e| {
//!     if e.file_type == omp_xfs::FileType::File { walk::Action::Continue } else { walk::Action::Skip }
//! })
//! .await?;
//! for entry in files.iter() {
//!     println!("{}", entry.path_lossy());
//! }
//! ```

pub mod exec;
pub mod fs;
pub mod glob;
pub mod grep;
pub mod ignore;
mod ovnfs;
pub mod pattern;
#[cfg(test)]
mod testing;
pub mod walk;
pub mod watch;

pub use fs::{Detail, FileType, Fs};
