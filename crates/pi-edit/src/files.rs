//! Read-through file access for engines.
//!
//! [`FileSource`] resolves authored paths through [`PathPolicy`], recovers
//! missing paths by unique suffix, enforces the auto-generated guard, decodes
//! notebooks to their editable text, and caches reads by `(path, mtime, len)`
//! for the lifetime of one preview/apply pass. Engines never touch
//! `std::fs` directly; the session clears the cache before `apply` so a final
//! stage always sees fresh bytes.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	sync::Arc,
	time::SystemTime,
};

use crate::{
	engine::Resolved,
	error::{EditError, EditResult},
	notebook,
	path_policy::{PathPolicy, canonical_key},
	text::{LineEnding, detect_line_ending, normalize_to_lf, restore_line_endings, strip_bom},
};

/// One target file as read from disk plus its normalized editable form.
#[derive(Debug)]
pub struct FileRead {
	pub resolved:    Resolved,
	/// Snapshot-store key.
	pub canonical:   PathBuf,
	/// Bytes as read (notebook JSON for `.ipynb`).
	pub raw:         String,
	pub bom:         &'static str,
	pub ending:      LineEnding,
	/// LF-normalized, BOM-stripped editable text (notebook cell projection).
	pub text:        String,
	pub is_notebook: bool,
}

impl FileRead {
	/// Encode LF-normalized post-edit text back to the bytes this file
	/// persists with: BOM and line endings restored, notebooks re-serialized.
	pub fn persist(&self, after_lf: &str) -> EditResult<String> {
		if self.is_notebook {
			return notebook::serialize_edited_notebook_text(
				Some(&self.raw),
				after_lf,
				&self.resolved.display,
			)
			.map_err(|err| EditError::apply(err.to_string()));
		}
		let mut out = String::with_capacity(self.bom.len() + after_lf.len());
		out.push_str(self.bom);
		out.push_str(&restore_line_endings(after_lf, self.ending));
		Ok(out)
	}
}

/// Persist text for a file that did not exist before the edit.
pub fn persist_new(resolved: &Resolved, after_lf: &str) -> EditResult<String> {
	if notebook::is_notebook_path(&resolved.absolute) {
		return notebook::serialize_edited_notebook_text(None, after_lf, &resolved.display)
			.map_err(|err| EditError::apply(err.to_string()));
	}
	Ok(after_lf.to_owned())
}

/// Filesystem view an engine reads through.
pub trait FileSource {
	fn policy(&self) -> &PathPolicy;

	/// Resolve an authored path without reading it. When `must_exist` and
	/// the resolved file is missing, unique-suffix recovery may substitute a
	/// different display/absolute pair.
	fn resolve(&mut self, authored: &str, must_exist: bool) -> EditResult<Resolved>;

	/// Whether `absolute` currently exists (file or directory).
	fn exists(&mut self, absolute: &Path) -> bool;

	/// Read a target that must exist. Fails with `File not found: <display>`
	/// after recovery, or with the auto-generated guard message.
	fn read(&mut self, authored: &str) -> EditResult<Arc<FileRead>>;

	/// Read an already-resolved target; `Ok(None)` when it does not exist.
	fn try_read(&mut self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>>;

	/// Drop every cached read.
	fn clear(&mut self);
}

#[derive(Clone, Copy, PartialEq, Eq)]
struct Stamp {
	mtime: Option<SystemTime>,
	len:   u64,
}

fn stamp(absolute: &Path) -> Option<Stamp> {
	let meta = std::fs::metadata(absolute).ok()?;
	Some(Stamp { mtime: meta.modified().ok(), len: meta.len() })
}

/// Default [`FileSource`] backed by `std::fs`.
pub struct FileCache {
	policy:      PathPolicy,
	reads:       HashMap<PathBuf, (Stamp, Arc<FileRead>)>,
	/// Authored path → resolution (so paired hunks share one recovery).
	resolutions: HashMap<(String, bool), Resolved>,
}

impl FileCache {
	pub fn new(policy: PathPolicy) -> Self {
		Self { policy, reads: HashMap::new(), resolutions: HashMap::new() }
	}

	fn read_resolved(&mut self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>> {
		let Some(current) = stamp(&resolved.absolute) else {
			return Ok(None);
		};
		if let Some((cached_stamp, read)) = self.reads.get(&resolved.absolute)
			&& *cached_stamp == current
			&& read.resolved.display == resolved.display
		{
			return Ok(Some(Arc::clone(read)));
		}
		let bytes = match std::fs::read(&resolved.absolute) {
			Ok(bytes) => bytes,
			Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
			Err(source) => return Err(EditError::Io { path: resolved.absolute.clone(), source }),
		};
		if let Some(message) = self
			.policy
			.auto_generated_message(&resolved.display, &bytes[..bytes.len().min(1024)])
		{
			return Err(EditError::apply(message));
		}
		let raw = String::from_utf8_lossy(&bytes).into_owned();
		let is_notebook = notebook::is_notebook_path(&resolved.absolute);
		let (bom, text) = if is_notebook {
			let editable = notebook::notebook_to_editable_text(&raw, &resolved.display)
				.map_err(|err| EditError::apply(err.to_string()))?;
			("", normalize_to_lf(&editable).into_owned())
		} else {
			let (bom, body) = strip_bom(&raw);
			(bom, normalize_to_lf(body).into_owned())
		};
		let ending = if is_notebook {
			LineEnding::Lf
		} else {
			detect_line_ending(strip_bom(&raw).1)
		};
		let read = Arc::new(FileRead {
			canonical: canonical_key(&resolved.absolute),
			resolved: resolved.clone(),
			raw,
			bom,
			ending,
			text,
			is_notebook,
		});
		self
			.reads
			.insert(resolved.absolute.clone(), (current, Arc::clone(&read)));
		Ok(Some(read))
	}
}

impl FileSource for FileCache {
	fn policy(&self) -> &PathPolicy {
		&self.policy
	}

	fn resolve(&mut self, authored: &str, must_exist: bool) -> EditResult<Resolved> {
		let key = (authored.to_owned(), must_exist);
		if let Some(resolved) = self.resolutions.get(&key) {
			return Ok(resolved.clone());
		}
		let mut resolved = self.policy.resolve(authored)?;
		if must_exist
			&& !crate::path_policy::is_internal_url(authored)
			&& stamp(&resolved.absolute).is_none()
			&& let Some(recovered) = self.policy.recover_missing(authored)
		{
			resolved = recovered;
		}
		self.resolutions.insert(key, resolved.clone());
		Ok(resolved)
	}

	fn exists(&mut self, absolute: &Path) -> bool {
		stamp(absolute).is_some()
	}

	fn read(&mut self, authored: &str) -> EditResult<Arc<FileRead>> {
		let resolved = self.resolve(authored, true)?;
		self
			.read_resolved(&resolved)?
			.ok_or_else(|| EditError::apply(format!("File not found: {}", resolved.display)))
	}

	fn try_read(&mut self, resolved: &Resolved) -> EditResult<Option<Arc<FileRead>>> {
		self.read_resolved(resolved)
	}

	fn clear(&mut self) {
		self.reads.clear();
		self.resolutions.clear();
	}
}
