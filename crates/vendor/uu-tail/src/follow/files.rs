// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore tailable seekable stdlib (stdlib)

use std::{
	collections::{HashMap, hash_map::Keys},
	fs::{File, Metadata},
	io::{BufRead, BufReader, BufWriter, Write},
	path::{Path, PathBuf},
};

use uucore::error::UResult;

use crate::{
	args::Settings,
	chunks::BytesChunkBuffer,
	paths::{HeaderPrinter, PathExtTail},
	text,
};

/// Data structure to keep a handle on files to follow.
/// `last` always holds the path/key of the last file that was printed from.
/// The keys of the [`HashMap`] can point to an existing file path (normal
/// case), or stdin ("-"), or to a non-existing path (--retry).
/// For existing files, all keys in the [`HashMap`] are absolute Paths.
pub struct FileHandling {
	map:            HashMap<PathBuf, PathData>,
	last:           Option<PathBuf>,
	header_printer: HeaderPrinter,
}

impl FileHandling {
	pub fn from(settings: &Settings) -> Self {
		Self {
			map:            HashMap::with_capacity(settings.inputs.len()),
			last:           None,
			header_printer: HeaderPrinter::new(settings.verbose, false),
		}
	}

	/// Wrapper for [`HashMap::insert`] using [`Path::canonicalize`]
	pub fn insert(&mut self, k: &Path, v: PathData, update_last: bool) {
		let k = Self::canonicalize_path(k);
		if update_last {
			self.last = Some(k.clone());
		}
		let _ = self.map.insert(k, v);
	}

	/// Wrapper for [`HashMap::remove`] using [`Path::canonicalize`]
	pub fn remove(&mut self, k: &Path) -> PathData {
		self.map.remove(&Self::canonicalize_path(k)).unwrap()
	}

	/// Wrapper for [`HashMap::get`] using [`Path::canonicalize`]
	pub fn get(&self, k: &Path) -> &PathData {
		self.map.get(&Self::canonicalize_path(k)).unwrap()
	}

	/// Wrapper for [`HashMap::get_mut`] using [`Path::canonicalize`]
	pub fn get_mut(&mut self, k: &Path) -> &mut PathData {
		self.map.get_mut(&Self::canonicalize_path(k)).unwrap()
	}

	/// Canonicalize `path` if it is not already an absolute path
	fn canonicalize_path(path: &Path) -> PathBuf {
		if path.is_relative()
			&& !path.is_stdin()
			&& let Ok(p) = path.canonicalize()
		{
			return p;
		}
		path.to_owned()
	}

	pub fn get_mut_metadata(&mut self, path: &Path) -> Option<&Metadata> {
		self.get_mut(path).metadata.as_ref()
	}

	pub fn keys(&self) -> Keys<'_, PathBuf, PathData> {
		self.map.keys()
	}

	pub fn contains_key(&self, k: &Path) -> bool {
		self.map.contains_key(k)
	}

	pub fn get_last(&self) -> Option<&PathBuf> {
		self.last.as_ref()
	}

	/// Return true if there is only stdin remaining
	pub fn only_stdin_remaining(&self) -> bool {
		self.map.len() == 1 && (self.map.contains_key(Path::new(text::DASH)))
	}

	/// Return true if there is at least one "tailable" path (or stdin) remaining
	pub fn files_remaining(&self) -> bool {
		for path in self.map.keys() {
			if path.is_tailable() || path.is_stdin() {
				return true;
			}
		}
		false
	}

	/// Returns true if there are no files remaining
	pub fn no_files_remaining(&self, settings: &Settings) -> bool {
		self.map.is_empty() || !self.files_remaining() && !settings.retry
	}

	/// Set `reader` to None to indicate that `path` is not an existing file
	/// anymore.
	pub fn reset_reader(&mut self, path: &Path) {
		self.get_mut(path).reader = None;
	}

	/// Reopen the file at the monitored `path`
	pub fn update_reader(&mut self, path: &Path) -> UResult<()> {
		/*
		BUG: If it's not necessary to reopen a file, GNU's tail calls seek to offset 0.
		However, we can't call seek here because `BufRead` does not implement `Seek`.
		As a workaround, we always reopen the file even though this might not always
		be necessary.
		*/
		self
			.get_mut(path)
			.reader
			.replace(Box::new(BufReader::new(File::open(path)?)));
		Ok(())
	}

	/// Reload metadata from `path`, or `metadata`
	pub fn update_metadata(&mut self, path: &Path, metadata: Option<Metadata>) {
		self.get_mut(path).metadata = if metadata.is_some() {
			metadata
		} else {
			path.metadata().ok()
		};
	}

	/// Read new data from `path` and print it to stdout
	pub fn tail_file(&mut self, path: &Path, verbose: bool) -> UResult<bool> {
		let mut chunks = BytesChunkBuffer::new(u64::MAX);
		if let Some(reader) = self.get_mut(path).reader.as_mut() {
			chunks.fill(reader)?;
		}
		if chunks.has_data() {
			if self.needs_header(path, verbose) {
				let display_name = self.get(path).display_name.clone();
				self.header_printer.print(display_name.as_str());
			}

			let mut writer = BufWriter::new(pi_uutils_ctx::stdout().lock());
			chunks.print(&mut writer)?;
			writer.flush()?;

			self.last.replace(path.to_owned());
			self.update_metadata(path, None);
			Ok(true)
		} else {
			Ok(false)
		}
	}

	/// Decide if printing `path` needs a header based on when it was last
	/// printed
	pub fn needs_header(&self, path: &Path, verbose: bool) -> bool {
		if verbose {
			if let Some(ref last) = self.last {
				!last.eq(&path)
			} else {
				true
			}
		} else {
			false
		}
	}
}

/// Data structure to keep a handle on the [`BufReader`], [`Metadata`]
/// and the `display_name` (`header_name`) of files that are being followed.
pub struct PathData {
	pub reader:       Option<Box<dyn BufRead>>,
	pub metadata:     Option<Metadata>,
	pub display_name: String,
}

impl PathData {
	pub fn new(
		reader: Option<Box<dyn BufRead>>,
		metadata: Option<Metadata>,
		display_name: &str,
	) -> Self {
		Self { reader, metadata, display_name: display_name.to_owned() }
	}

	pub fn from_other_with_path(data: Self, path: &Path) -> Self {
		// Remove old reader
		let old_reader = data.reader;
		let reader = if old_reader.is_some() {
			// Use old reader with the same file descriptor if there is one
			old_reader
		} else if let Ok(file) = File::open(path) {
			// Open new file tail from start
			Some(Box::new(BufReader::new(file)) as Box<dyn BufRead>)
		} else {
			// Probably file was renamed/moved or removed again
			None
		};

		Self::new(reader, path.metadata().ok(), data.display_name.as_str())
	}
}
