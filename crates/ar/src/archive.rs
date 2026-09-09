//! Format detection, resource limits, indexing, and member access.

use std::{
	cmp,
	collections::{BTreeMap, HashMap, hash_map::Entry as MapEntry},
	fs::{self, File},
	io,
	io::{BufReader, Cursor, Read, Seek, SeekFrom, Write},
	iter,
	path::{Path, PathBuf},
};

use cap_std::fs::Dir;
use flate2::read::MultiGzDecoder;
use omp_core::Str;
use strum::{EnumString, IntoStaticStr};

use crate::{
	Entry, Error, Result, arj, asar, cab, codec, cpio, deb,
	entry::Storage,
	iso, links, lzh,
	path::{normalize, parent, validate},
	rar, rpm, sevenzip, tar, unix_ar, zip,
};

const DEFAULT_MAX_ENTRIES: u64 = 1_000_000;
const DEFAULT_MAX_ARCHIVE_SIZE: u64 = 256 * 1024 * 1024;
const DEFAULT_MAX_INDEX_SIZE: u64 = 64 * 1024 * 1024;
const DEFAULT_MAX_MEMBER_SIZE: u64 = 64 * 1024 * 1024;
const DEFAULT_MAX_IN_MEMORY_SIZE: u64 = 256 * 1024 * 1024;
const DEFAULT_MAX_PATH_SIZE: u64 = 4096;
const DEFAULT_MAX_PATH_DEPTH: u64 = 64;
const DEFAULT_MAX_LINK_DEPTH: u64 = 40;

/// Archive container format.
#[derive(Debug, Clone, Copy, PartialEq, Eq, EnumString, IntoStaticStr)]
#[strum(ascii_case_insensitive)]
pub enum Format {
	/// ZIP container with per-member compression.
	#[strum(
		to_string = "zip",
		serialize = "jar",
		serialize = "war",
		serialize = "ear",
		serialize = "apk"
	)]
	Zip,
	/// Uncompressed tape archive.
	#[strum(to_string = "tar")]
	Tar,
	/// Gzip-compressed tape archive.
	#[strum(to_string = "tar.gz", serialize = "tgz")]
	TarGz,
	/// Bzip2-compressed tape archive.
	#[strum(to_string = "tar.bz2", serialize = "tbz2", serialize = "tbz")]
	TarBz2,
	/// XZ-compressed tape archive.
	#[strum(to_string = "tar.xz", serialize = "txz")]
	TarXz,
	/// Zstandard-compressed tape archive.
	#[strum(to_string = "tar.zst", serialize = "tzst")]
	TarZst,
	/// ncompress (.Z)-compressed tape archive.
	#[strum(to_string = "tar.Z")]
	TarZ,
	/// Read-only Electron ASAR container.
	#[strum(to_string = "asar")]
	Asar,
	/// RAR 4.x/5.x container.
	#[strum(to_string = "rar", serialize = "cbr")]
	Rar,
	/// 7-Zip container.
	#[strum(to_string = "7z")]
	SevenZip,
	/// ISO 9660 disc image.
	#[strum(to_string = "iso")]
	Iso,
	/// Microsoft cabinet.
	#[strum(to_string = "cab")]
	Cab,
	/// cpio archive (newc, crc, odc, or old binary).
	#[strum(to_string = "cpio")]
	Cpio,
	/// RPM package around a compressed cpio payload.
	#[strum(to_string = "rpm")]
	Rpm,
	/// Unix ar archive (`.a`, `.lib`).
	#[strum(to_string = "ar", serialize = "a", serialize = "lib")]
	Ar,
	/// Debian package (ar of control/data tarballs).
	#[strum(to_string = "deb")]
	Deb,
	/// LZH/LHA archive.
	#[strum(to_string = "lzh", serialize = "lha")]
	Lzh,
	/// ARJ archive.
	#[strum(to_string = "arj")]
	Arj,
	/// Single gzip stream exposed as a one-member pseudo-archive.
	#[strum(to_string = "gz")]
	Gz,
	/// Single bzip2 stream exposed as a one-member pseudo-archive.
	#[strum(to_string = "bz2")]
	Bz2,
	/// Single xz stream exposed as a one-member pseudo-archive.
	#[strum(to_string = "xz")]
	Xz,
	/// Single zstd stream exposed as a one-member pseudo-archive.
	#[strum(to_string = "zst")]
	Zst,
	/// Single ncompress `.Z` stream exposed as a one-member pseudo-archive.
	#[strum(to_string = "Z")]
	Z,
	/// Single LZMA-alone stream exposed as a one-member pseudo-archive.
	#[strum(to_string = "lzma")]
	Lzma,
}

/// Every recognized filename extension, longest first so `.tar.gz` wins over
/// `.gz`. Shared by [`Format::from_path`] and single-member stem naming.
pub const EXTENSION_TABLE: &[(&str, Format)] = &[
	(".tar.bz2", Format::TarBz2),
	(".tar.gz", Format::TarGz),
	(".tar.xz", Format::TarXz),
	(".tar.zst", Format::TarZst),
	(".nupkg", Format::Zip),
	(".tar.z", Format::TarZ),
	(".asar", Format::Asar),
	(".cpio", Format::Cpio),
	(".lzma", Format::Lzma),
	(".tbz2", Format::TarBz2),
	(".tzst", Format::TarZst),
	(".vsix", Format::Zip),
	(".arj", Format::Arj),
	(".apk", Format::Zip),
	(".cab", Format::Cab),
	(".cbr", Format::Rar),
	(".cbz", Format::Zip),
	(".deb", Format::Deb),
	(".ear", Format::Zip),
	(".ipa", Format::Zip),
	(".iso", Format::Iso),
	(".jar", Format::Zip),
	(".lha", Format::Lzh),
	(".lib", Format::Ar),
	(".lzh", Format::Lzh),
	(".rar", Format::Rar),
	(".rpm", Format::Rpm),
	(".tar", Format::Tar),
	(".tbz", Format::TarBz2),
	(".tgz", Format::TarGz),
	(".txz", Format::TarXz),
	(".war", Format::Zip),
	(".whl", Format::Zip),
	(".xpi", Format::Zip),
	(".zip", Format::Zip),
	(".bz2", Format::Bz2),
	(".zst", Format::Zst),
	(".ar", Format::Ar),
	(".gz", Format::Gz),
	(".xz", Format::Xz),
	(".7z", Format::SevenZip),
	(".a", Format::Ar),
	(".z", Format::Z),
];

/// One plausible split between an archive path and a member selector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PathCandidate {
	/// Authored archive container path.
	pub archive_path: String,
	/// Slash-normalized member path after the archive separator.
	pub member_path:  String,
	/// Format implied by the matched extension.
	pub format:       Format,
}

/// Splits every recognized archive-extension boundary in `path`.
///
/// Candidates with a member selector are returned before bare archive paths,
/// then by longest archive path first. An extension is a boundary only at end
/// of input or immediately before `:`.
pub fn path_candidates(path: &str) -> Vec<PathCandidate> {
	let normalized = path.replace('\\', "/");
	let lower = normalized.to_ascii_lowercase();
	let mut candidates = Vec::new();
	for (start, byte) in lower.bytes().enumerate() {
		if byte != b'.' {
			continue;
		}
		for &(extension, format) in EXTENSION_TABLE {
			if !lower[start..].starts_with(extension) {
				continue;
			}
			let end = start + extension.len();
			if end != lower.len() && lower.as_bytes().get(end) != Some(&b':') {
				continue;
			}
			let archive_path = path[..end].to_owned();
			let member_path = normalized[end..].trim_start_matches(':').to_owned();
			if !candidates.iter().any(|candidate: &PathCandidate| {
				candidate.archive_path == archive_path && candidate.member_path == member_path
			}) {
				candidates.push(PathCandidate { archive_path, member_path, format });
			}
			break;
		}
	}
	candidates.sort_by_key(|candidate| {
		(candidate.member_path.is_empty(), cmp::Reverse(candidate.archive_path.len()))
	});
	candidates
}

impl Format {
	/// Infers a format from a conventional archive filename.
	pub fn from_path(path: impl AsRef<Path>) -> Option<Self> {
		let path = path.as_ref();
		let name = path.file_name()?.to_str()?;
		let lower = name.to_ascii_lowercase();
		EXTENSION_TABLE
			.iter()
			.find(|(extension, _)| lower.ends_with(extension) && lower.len() > extension.len())
			.map(|(_, format)| *format)
	}

	/// Sniffs a format from archive bytes, including a bounded ZIP footer.
	///
	/// Compression wrappers report their `tar.*` variant; indexing falls back
	/// to a single member when the decompressed stream is not a tar.
	pub fn sniff(bytes: &[u8]) -> Option<Self> {
		if let Some(signature) = bytes.get(..4) {
			let signature = u32::from_le_bytes(signature.try_into().expect("four-byte ZIP signature"));
			if matches!(signature, 0x0403_4b50 | 0x0605_4b50 | 0x0807_4b50) {
				return Some(Self::Zip);
			}
		}
		if rar::is_header(bytes) {
			return Some(Self::Rar);
		}
		if sevenzip::is_header(bytes) {
			return Some(Self::SevenZip);
		}
		if cab::is_header(bytes) {
			return Some(Self::Cab);
		}
		if rpm::is_header(bytes) {
			return Some(Self::Rpm);
		}
		if arj::is_header(bytes) {
			return Some(Self::Arj);
		}
		if lzh::is_header(bytes) {
			return Some(Self::Lzh);
		}
		if cpio::is_header(bytes) {
			return Some(Self::Cpio);
		}
		if deb::is_header(bytes) {
			return Some(Self::Deb);
		}
		if unix_ar::is_header(bytes) {
			return Some(Self::Ar);
		}
		if asar::is_header(bytes) {
			return Some(Self::Asar);
		}
		if codec::is_gzip(bytes) {
			return Some(Self::TarGz);
		}
		if codec::is_bzip2(bytes) {
			return Some(Self::TarBz2);
		}
		if codec::is_xz(bytes) {
			return Some(Self::TarXz);
		}
		if codec::is_zstd(bytes) {
			return Some(Self::TarZst);
		}
		if codec::is_compress_z(bytes) {
			return Some(Self::TarZ);
		}
		if iso::is_header(bytes) {
			return Some(Self::Iso);
		}
		if tar::is_header(bytes) {
			return Some(Self::Tar);
		}
		let tail_start = bytes.len().saturating_sub(zip::SNIFF_TAIL_SIZE);
		if zip::has_eocd(&bytes[tail_start..]) {
			return Some(Self::Zip);
		}
		None
	}

	/// Returns the canonical filename extension for this format.
	pub fn extension(self) -> &'static str {
		self.into()
	}
}

/// Resource ceilings enforced before archive metadata can drive expensive work.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
	pub(crate) entries:        u64,
	pub(crate) archive_size:   u64,
	pub(crate) index_size:     u64,
	pub(crate) member_size:    u64,
	pub(crate) in_memory_size: u64,
	pub(crate) path_size:      u64,
	pub(crate) path_depth:     u64,
	pub(crate) link_depth:     u64,
}

impl Limits {
	/// Conservative defaults for untrusted archives.
	pub const DEFAULT: Self = Self {
		entries:        DEFAULT_MAX_ENTRIES,
		archive_size:   DEFAULT_MAX_ARCHIVE_SIZE,
		index_size:     DEFAULT_MAX_INDEX_SIZE,
		member_size:    DEFAULT_MAX_MEMBER_SIZE,
		in_memory_size: DEFAULT_MAX_IN_MEMORY_SIZE,
		path_size:      DEFAULT_MAX_PATH_SIZE,
		path_depth:     DEFAULT_MAX_PATH_DEPTH,
		link_depth:     DEFAULT_MAX_LINK_DEPTH,
	};

	/// Returns the maximum indexed nodes, including synthetic directories.
	pub const fn max_entries(self) -> u64 {
		self.entries
	}

	/// Returns the maximum raw TAR or decoded TAR.GZ byte size.
	pub const fn max_archive_size(self) -> u64 {
		self.archive_size
	}

	/// Returns the maximum format metadata byte size retained for indexing.
	pub const fn max_index_size(self) -> u64 {
		self.index_size
	}

	/// Returns the maximum stored or logical size of one extracted member.
	pub const fn max_member_size(self) -> u64 {
		self.member_size
	}

	/// Returns the maximum aggregate size returned by [`Archive::read_all`].
	pub const fn max_in_memory_size(self) -> u64 {
		self.in_memory_size
	}

	/// Returns the maximum normalized member-path byte length.
	pub const fn max_path_size(self) -> u64 {
		self.path_size
	}

	/// Returns the maximum normalized member-path component count.
	pub const fn max_path_depth(self) -> u64 {
		self.path_depth
	}

	/// Returns the maximum directory-link rewrites during one lookup.
	pub const fn max_link_depth(self) -> u64 {
		self.link_depth
	}

	/// Replaces the total indexed-node ceiling.
	pub const fn with_max_entries(mut self, entries: u64) -> Self {
		self.entries = entries;
		self
	}

	/// Replaces the raw TAR or decoded TAR.GZ byte-size ceiling.
	pub const fn with_max_archive_size(mut self, bytes: u64) -> Self {
		self.archive_size = bytes;
		self
	}

	/// Replaces the retained format-metadata byte-size ceiling.
	pub const fn with_max_index_size(mut self, bytes: u64) -> Self {
		self.index_size = bytes;
		self
	}

	/// Replaces the per-member stored and logical size ceiling.
	pub const fn with_max_member_size(mut self, bytes: u64) -> Self {
		self.member_size = bytes;
		self
	}

	/// Replaces the aggregate in-memory materialization ceiling.
	pub const fn with_max_in_memory_size(mut self, bytes: u64) -> Self {
		self.in_memory_size = bytes;
		self
	}

	/// Replaces the normalized member-path byte ceiling.
	pub const fn with_max_path_size(mut self, bytes: u64) -> Self {
		self.path_size = bytes;
		self
	}

	/// Replaces the normalized member-path component ceiling.
	pub const fn with_max_path_depth(mut self, components: u64) -> Self {
		self.path_depth = components;
		self
	}

	/// Replaces the directory-link rewrite ceiling.
	pub const fn with_max_link_depth(mut self, rewrites: u64) -> Self {
		self.link_depth = rewrites;
		self
	}
}

impl Default for Limits {
	fn default() -> Self {
		Self::DEFAULT
	}
}

/// Fully materialized file members keyed by normalized archive path.
pub type Files = BTreeMap<Str, Vec<u8>>;

/// Indexed, read-only access to one seekable archive source.
pub struct Archive<R> {
	source:        R,
	/// Retained decompressed streams referenced by `Storage::Tar` (buffer 0)
	/// and `Storage::Buffered` entries.
	decoded:       Vec<Vec<u8>>,
	unpacked_root: Option<PathBuf>,
	format:        Format,
	entries:       Vec<Entry>,
	limits:        Limits,
}

impl<R: Read + Seek> Archive<R> {
	/// Sniffs and indexes `source` with [`Limits::DEFAULT`].
	pub fn new(source: R) -> Result<Self> {
		Self::with_limits(source, Limits::DEFAULT)
	}

	/// Sniffs and indexes `source` with explicit resource ceilings.
	pub fn with_limits(mut source: R, limits: Limits) -> Result<Self> {
		let format = sniff_source(&mut source)?;
		Self::index_source(source, format, limits, None)
	}

	/// Indexes `source` as an explicit format with [`Limits::DEFAULT`].
	pub fn with_format(source: R, format: Format) -> Result<Self> {
		Self::with_format_and_limits(source, format, Limits::DEFAULT)
	}

	/// Indexes `source` as an explicit format with explicit resource ceilings.
	pub fn with_format_and_limits(source: R, format: Format, limits: Limits) -> Result<Self> {
		Self::index_source(source, format, limits, None)
	}

	/// Indexes `source`; `stem` names the single member of a non-tar
	/// compressed stream when the source filename is known.
	fn index_source(
		mut source: R,
		format: Format,
		limits: Limits,
		stem: Option<Str>,
	) -> Result<Self> {
		let file_size = source.seek(SeekFrom::End(0))?;
		source.seek(SeekFrom::Start(0))?;
		let mut decoded = Vec::new();
		let raw_entries = match format {
			Format::Zip => zip::read_entries(&mut source, file_size, limits)?,
			Format::Tar => {
				check_archive_size(file_size, limits)?;
				tar::read_entries(&mut source, file_size, limits)?
			},
			Format::TarGz
			| Format::TarBz2
			| Format::TarXz
			| Format::TarZst
			| Format::TarZ
			| Format::Gz
			| Format::Bz2
			| Format::Xz
			| Format::Zst
			| Format::Z
			| Format::Lzma => {
				check_archive_size(file_size, limits)?;
				let bytes = decode_compressed(format, &mut source, file_size, limits)?;
				let entries = index_decoded_stream(&bytes, stem, limits)?;
				decoded.push(bytes);
				entries
			},
			Format::Asar => asar::read_entries(&mut source, file_size, limits)?,
			Format::Rar => rar::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::SevenZip => sevenzip::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Iso => iso::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Cab => cab::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Cpio => cpio::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Rpm => rpm::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Ar => unix_ar::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Deb => deb::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Lzh => lzh::read_entries(&mut source, file_size, limits, &mut decoded)?,
			Format::Arj => arj::read_entries(&mut source, file_size, limits, &mut decoded)?,
		};
		let entries = finalize_entries(raw_entries, limits)?;
		Ok(Self { source, decoded, unpacked_root: None, format, entries, limits })
	}

	/// Returns this archive's detected or selected format.
	pub const fn format(&self) -> Format {
		self.format
	}

	/// Returns the limits enforced by this reader.
	pub const fn limits(&self) -> Limits {
		self.limits
	}

	/// Iterates normalized entries in path order, including synthetic
	/// directories.
	pub fn entries(
		&self,
	) -> impl DoubleEndedIterator<Item = &Entry> + ExactSizeIterator + iter::FusedIterator {
		self.entries.iter()
	}

	/// Looks up one exact normalized index path.
	pub fn entry(&self, path: &str) -> Option<&Entry> {
		let normalized = normalize(path, false)?;
		self.entry_normalized(normalized.as_str())
	}

	/// Resolves a normalized file path through TAR directory aliases.
	///
	/// Unlike [`Self::entry`], this follows symbolic directory aliases before
	/// returning the indexed target.
	pub fn resolve_entry(&self, path: &str) -> Result<&Entry> {
		let normalized = normalize(path, false).ok_or_else(|| Error::UnsafePath(Str::new(path)))?;
		let resolved = match self.entry_normalized(normalized.as_str()) {
			Some(entry) if !entry.is_link() => normalized,
			Some(_) | None => self.resolve_path(normalized)?,
		};
		self
			.entry_normalized(resolved.as_str())
			.ok_or_else(|| Error::NotFound(resolved.clone()))
	}

	/// Lists the direct children of a directory in path order.
	pub fn list(&self, path: &str) -> Result<Vec<&Entry>> {
		let normalized = normalize(path, true).ok_or_else(|| Error::UnsafePath(Str::new(path)))?;
		let resolved = match self.entry_normalized(normalized.as_str()) {
			Some(entry) if !entry.is_link() => normalized,
			Some(_) | None => self.resolve_path(normalized)?,
		};
		if !resolved.is_empty() {
			let entry = self
				.entry_normalized(resolved.as_str())
				.ok_or_else(|| Error::NotFound(resolved.clone()))?;
			if !entry.is_directory() {
				return Err(Error::NotDirectory(resolved));
			}
		}
		Ok(self
			.entries
			.iter()
			.filter(|entry| parent(entry.path()) == resolved.as_str())
			.collect())
	}

	/// Reads and validates one file member into a single byte buffer.
	pub fn read(&mut self, path: &str) -> Result<Vec<u8>> {
		let entry = self.file_entry(path)?;
		self.check_member_size(&entry)?;
		let capacity = usize::try_from(entry.size).map_err(|_| Error::MemberTooLarge {
			path:   entry.path.clone(),
			actual: entry.size,
			limit:  usize::MAX as u64,
		})?;
		let mut bytes = Vec::with_capacity(capacity);
		self.read_entry_to(&entry, &mut bytes)?;
		Ok(bytes)
	}

	/// Streams one validated file member to `output`.
	///
	/// Validation can fail after bytes reach `output`; use [`Self::read`] when
	/// the destination must remain untouched on failure.
	pub fn read_to<W: Write>(&mut self, path: &str, output: &mut W) -> Result<u64> {
		let entry = self.file_entry(path)?;
		self.check_member_size(&entry)?;
		self.read_entry_to(&entry, output)
	}

	/// Materializes every readable file member under the aggregate memory limit.
	///
	/// Directory aliases materialize nothing; dangling file links fail with
	/// [`Error::UnreadableLink`] when read.
	pub fn read_all(&mut self) -> Result<Files> {
		let mut total = 0_u64;
		for entry in &self.entries {
			if entry.is_directory() {
				continue;
			}
			total = total
				.checked_add(entry.size)
				.ok_or(Error::ArchiveTooLargeInMemory {
					actual: u64::MAX,
					limit:  self.limits.in_memory_size,
				})?;
			if total > self.limits.in_memory_size {
				return Err(Error::ArchiveTooLargeInMemory {
					actual: total,
					limit:  self.limits.in_memory_size,
				});
			}
		}

		let paths: Vec<_> = self
			.entries
			.iter()
			.filter(|entry| !entry.is_directory())
			.map(|entry| entry.path.clone())
			.collect();
		let mut files = BTreeMap::new();
		for path in paths {
			files.insert(path.clone(), self.read(path.as_str())?);
		}
		Ok(files)
	}

	/// Extracts validated members beneath a capability-scoped destination.
	///
	/// Empty directories are preserved, Unix modes are applied when recorded,
	/// and symbolic links are recreated (Unix only) after their targets are
	/// validated to stay inside the destination. Directory aliases
	/// materialize nothing. The returned count covers files and symlinks.
	#[tracing::instrument(
		level = "debug",
		name = "archive_extract",
		skip_all,
		fields(
			entry_count = self.entries.len(),
			extracted_count = tracing::field::Empty
		)
	)]
	pub fn extract_to(&mut self, destination: &Dir) -> Result<usize> {
		for entry in &self.entries {
			if entry.is_directory() && !entry.is_link() {
				destination.create_dir_all(Path::new(entry.path()))?;
			}
		}

		let mut files = Vec::new();
		let mut symlinks = Vec::new();
		for entry in &self.entries {
			if entry.is_directory() {
				continue;
			}
			match &entry.storage {
				Storage::Link { target_path, .. } => {
					symlinks.push((entry.path.clone(), target_path.clone()));
				},
				_ => files.push((entry.path.clone(), entry.mode)),
			}
		}

		let mut written = 0;
		for (path, mode) in files {
			if let Some(parent) = Path::new(path.as_str()).parent() {
				destination.create_dir_all(parent)?;
			}
			let mut file = destination.create(Path::new(path.as_str()))?;
			if let Err(error) = self.read_to(path.as_str(), &mut file) {
				drop(file);
				if let Err(cleanup_error) = destination.remove_file(Path::new(path.as_str())) {
					tracing::warn!(
						path = %path,
						%cleanup_error,
						"failed to remove partial archive extraction"
					);
				}
				return Err(error);
			}
			drop(file);
			#[cfg(unix)]
			if let Some(mode) = mode {
				use std::os::unix::fs::PermissionsExt;
				let permissions = mode & 0o777;
				if permissions != 0 {
					let permissions = fs::Permissions::from_mode(permissions);
					{
						use cap_std::fs;
						destination.set_permissions(
							Path::new(path.as_str()),
							fs::Permissions::from_std(permissions),
						)?;
					}
				}
			}
			written += 1;
		}

		for (path, target) in symlinks {
			// A symlink target resolves relative to the link's directory; it
			// must normalize to an in-archive path to be recreated safely.
			let joined = format!("{}/{}", parent(path.as_str()), target);
			if normalize(&joined, true).is_none() {
				return Err(Error::UnreadableLink { path, target });
			}
			if let Some(parent) = Path::new(path.as_str()).parent() {
				destination.create_dir_all(parent)?;
			}
			#[cfg(unix)]
			{
				destination.symlink(Path::new(target.as_str()), Path::new(path.as_str()))?;
				written += 1;
			}
			#[cfg(not(unix))]
			{
				let _ = target;
			}
		}
		tracing::Span::current().record("extracted_count", written);
		Ok(written)
	}

	/// Returns the wrapped original source after discarding the index.
	pub fn into_inner(self) -> R {
		self.source
	}

	fn entry_normalized(&self, path: &str) -> Option<&Entry> {
		self
			.entries
			.binary_search_by(|entry| entry.path().cmp(path))
			.ok()
			.map(|index| &self.entries[index])
	}

	fn resolve_path(&self, path: Str) -> Result<Str> {
		match self.format {
			Format::Tar
			| Format::TarGz
			| Format::TarBz2
			| Format::TarXz
			| Format::TarZst
			| Format::TarZ
			| Format::Gz
			| Format::Bz2
			| Format::Xz
			| Format::Zst
			| Format::Z
			| Format::Lzma => tar::resolve_alias_path(&self.entries, path, self.limits),
			Format::Zip => Ok(path),
			_ => links::resolve_alias_path(&self.entries, path, self.limits),
		}
	}

	fn file_entry(&self, path: &str) -> Result<Entry> {
		let entry = self.resolve_entry(path)?;
		if entry.is_directory() {
			return Err(Error::IsDirectory(Str::new(entry.path())));
		}
		Ok(entry.clone())
	}

	fn check_member_size(&self, entry: &Entry) -> Result<()> {
		let platform_limit = usize::MAX as u64;
		let limit = cmp::min(self.limits.member_size, platform_limit);
		let actual = cmp::max(entry.size(), entry.compressed_size());
		if actual > limit {
			return Err(Error::MemberTooLarge { path: entry.path.clone(), actual, limit });
		}
		Ok(())
	}

	fn read_entry_to<W: Write>(&mut self, entry: &Entry, output: &mut W) -> Result<u64> {
		// Storage-generic paths first: raw source ranges and retained
		// decoded buffers are format-independent.
		match &entry.storage {
			Storage::Raw { data_offset, stored_size } => {
				return copy_source_range(&mut self.source, *data_offset, *stored_size, output);
			},
			Storage::Buffered { buffer, data_offset, stored_size } => {
				let decoded = self
					.decoded
					.get(*buffer as usize)
					.ok_or(Error::InvalidArchive("missing decoded archive buffer"))?;
				let start = usize::try_from(*data_offset)
					.map_err(|_| Error::InvalidArchive("decoded member offset overflows"))?;
				let end = usize::try_from(*stored_size)
					.ok()
					.and_then(|size| start.checked_add(size))
					.ok_or(Error::InvalidArchive("decoded member range overflows"))?;
				let slice = decoded
					.get(start..end)
					.ok_or(Error::InvalidArchive("decoded member range out of bounds"))?;
				output.write_all(slice)?;
				return Ok(slice.len() as u64);
			},
			_ => {},
		}
		match self.format {
			Format::Zip => zip::read_entry_to(&mut self.source, entry, self.limits, output),
			Format::Tar => tar::read_entry_to(&mut self.source, entry, output),
			Format::TarGz
			| Format::TarBz2
			| Format::TarXz
			| Format::TarZst
			| Format::TarZ
			| Format::Gz
			| Format::Bz2
			| Format::Xz
			| Format::Zst
			| Format::Z
			| Format::Lzma => {
				let decoded = self
					.decoded
					.first()
					.ok_or(Error::InvalidArchive("missing decoded archive buffer"))?;
				tar::read_entry_to(&mut Cursor::new(decoded.as_slice()), entry, output)
			},
			Format::Asar => {
				asar::read_entry_to(&mut self.source, self.unpacked_root.as_deref(), entry, output)
			},
			Format::Rar => rar::read_entry_to(&mut self.source, entry, output),
			Format::SevenZip => sevenzip::read_entry_to(&mut self.source, entry, output),
			Format::Iso => iso::read_entry_to(&mut self.source, entry, output),
			Format::Cab => cab::read_entry_to(&mut self.source, entry, output),
			Format::Cpio => cpio::read_entry_to(&mut self.source, entry, output),
			Format::Rpm => rpm::read_entry_to(&mut self.source, entry, output),
			Format::Ar => unix_ar::read_entry_to(&mut self.source, entry, output),
			Format::Deb => deb::read_entry_to(&mut self.source, entry, output),
			Format::Lzh => lzh::read_entry_to(&mut self.source, entry, output),
			Format::Arj => arj::read_entry_to(&mut self.source, entry, output),
		}
	}
}

impl Archive<BufReader<File>> {
	/// Opens and indexes an archive, preferring a recognized filename extension.
	pub fn open(path: impl AsRef<Path>) -> Result<Self> {
		Self::open_with_limits(path, Limits::DEFAULT)
	}

	/// Opens and indexes an archive with explicit resource ceilings.
	pub fn open_with_limits(path: impl AsRef<Path>, limits: Limits) -> Result<Self> {
		let path = path.as_ref();
		let mut source = BufReader::new(File::open(path)?);
		let format = match Format::from_path(path) {
			Some(format) => format,
			None => sniff_source(&mut source)?,
		};
		let mut archive = Self::index_source(source, format, limits, member_stem(path))?;
		archive.set_filesystem_path(path);
		Ok(archive)
	}

	/// Opens a path as an explicit archive format.
	pub fn open_with_format(path: impl AsRef<Path>, format: Format) -> Result<Self> {
		Self::open_with_format_and_limits(path, format, Limits::DEFAULT)
	}

	/// Opens a path as an explicit archive format with explicit limits.
	pub fn open_with_format_and_limits(
		path: impl AsRef<Path>,
		format: Format,
		limits: Limits,
	) -> Result<Self> {
		let path = path.as_ref();
		let source = BufReader::new(File::open(path)?);
		let mut archive = Self::index_source(source, format, limits, member_stem(path))?;
		archive.set_filesystem_path(path);
		Ok(archive)
	}

	fn set_filesystem_path(&mut self, path: &Path) {
		if self.format == Format::Asar {
			let mut root = path.as_os_str().to_owned();
			root.push(".unpacked");
			self.unpacked_root = Some(PathBuf::from(root));
		}
	}
}

impl<'a> Archive<Cursor<&'a [u8]>> {
	/// Sniffs and indexes borrowed in-memory archive bytes.
	pub fn from_bytes(bytes: &'a [u8]) -> Result<Self> {
		Self::from_bytes_with_limits(bytes, Limits::DEFAULT)
	}

	/// Sniffs and indexes borrowed bytes with explicit limits.
	pub fn from_bytes_with_limits(bytes: &'a [u8], limits: Limits) -> Result<Self> {
		Self::with_limits(Cursor::new(bytes), limits)
	}

	/// Indexes borrowed bytes as an explicit archive format.
	pub fn from_bytes_with_format(bytes: &'a [u8], format: Format) -> Result<Self> {
		Self::from_bytes_with_format_and_limits(bytes, format, Limits::DEFAULT)
	}

	/// Indexes borrowed bytes as an explicit archive format with explicit
	/// limits.
	pub fn from_bytes_with_format_and_limits(
		bytes: &'a [u8],
		format: Format,
		limits: Limits,
	) -> Result<Self> {
		Self::with_format_and_limits(Cursor::new(bytes), format, limits)
	}
}

/// Sniffs and materializes every file in borrowed archive bytes.
pub fn unpack(bytes: &[u8]) -> Result<Files> {
	Archive::from_bytes(bytes)?.read_all()
}

/// Materializes every file in borrowed bytes using an explicit format.
pub fn unpack_with_format(bytes: &[u8], format: Format) -> Result<Files> {
	Archive::from_bytes_with_format(bytes, format)?.read_all()
}

fn sniff_source(source: &mut (impl Read + Seek)) -> Result<Format> {
	let original_position = source.stream_position()?;
	let result = (|| {
		source.seek(SeekFrom::Start(0))?;
		// 40 KiB covers every head-anchored magic including the ISO 9660
		// descriptor at byte 32769.
		let mut probe = vec![0_u8; 40 * 1024];
		let mut read = 0;
		while read < probe.len() {
			let count = source.read(&mut probe[read..])?;
			if count == 0 {
				break;
			}
			read += count;
		}
		if let Some(format) = Format::sniff(&probe[..read]) {
			return Ok(format);
		}

		let file_size = source.seek(SeekFrom::End(0))?;
		let tail_len = cmp::min(file_size, zip::SNIFF_TAIL_SIZE as u64);
		let tail_start = file_size - tail_len;
		source.seek(SeekFrom::Start(tail_start))?;
		let mut tail = vec![
			0_u8;
			usize::try_from(tail_len).map_err(|_| Error::InvalidArchive(
				"ZIP sniff tail does not fit this platform"
			))?
		];
		source.read_exact(&mut tail)?;
		zip::has_eocd(&tail)
			.then_some(Format::Zip)
			.ok_or(Error::UnknownFormat)
	})();
	source.seek(SeekFrom::Start(original_position))?;
	result
}

const fn check_archive_size(actual: u64, limits: Limits) -> Result<()> {
	if actual > limits.archive_size {
		return Err(Error::ArchiveTooLarge { actual, limit: limits.archive_size });
	}
	Ok(())
}

fn decode_gzip(
	source: &mut (impl Read + Seek),
	compressed_size: u64,
	limits: Limits,
) -> Result<Vec<u8>> {
	source.seek(SeekFrom::Start(0))?;
	let capacity = usize::try_from(cmp::min(compressed_size, 64 * 1024)).unwrap_or(64 * 1024);
	let mut bytes = Vec::with_capacity(capacity);
	let mut decoder = MultiGzDecoder::new(source).take(limits.archive_size.saturating_add(1));
	decoder.read_to_end(&mut bytes)?;
	let actual = bytes.len() as u64;
	if actual > limits.archive_size {
		return Err(Error::ArchiveTooLarge { actual, limit: limits.archive_size });
	}
	Ok(bytes)
}

fn finalize_entries(raw: Vec<Entry>, limits: Limits) -> Result<Vec<Entry>> {
	let mut indexed = HashMap::with_capacity(raw.len());
	for entry in raw {
		validate(&entry.path, limits)?;
		upsert(&mut indexed, entry);
		if indexed.len() as u64 > limits.entries {
			return Err(Error::TooManyEntries {
				actual: indexed.len() as u64,
				limit:  limits.entries,
			});
		}
	}
	ensure_parent_directories(&mut indexed, limits.entries)?;
	let mut entries: Vec<_> = indexed.into_values().collect();
	entries.sort_unstable_by(|left, right| left.path.cmp(&right.path));
	Ok(entries)
}

fn upsert(entries: &mut HashMap<Str, Entry>, entry: Entry) {
	match entries.entry(entry.path.clone()) {
		MapEntry::Vacant(slot) => {
			slot.insert(entry);
		},
		MapEntry::Occupied(mut slot) => {
			let existing = slot.get();
			if existing.is_directory() && !entry.is_directory()
				|| existing.is_directory() == entry.is_directory()
			{
				slot.insert(entry);
			}
		},
	}
}

fn ensure_parent_directories(entries: &mut HashMap<Str, Entry>, limit: u64) -> Result<()> {
	let paths: Vec<_> = entries.keys().cloned().collect();
	for path in paths {
		for (offset, _) in path.match_indices('/') {
			let parent = path.slice(..offset);
			let next_count = (entries.len() as u64).saturating_add(1);
			match entries.entry(parent.clone()) {
				MapEntry::Vacant(_) if next_count > limit => {
					return Err(Error::TooManyEntries { actual: next_count, limit });
				},
				MapEntry::Vacant(slot) => {
					slot.insert(Entry::synthetic_directory(parent));
				},
				MapEntry::Occupied(slot) if !slot.get().is_directory() && !slot.get().is_link() => {
					return Err(Error::InvalidArchive("file entry is the parent of another member"));
				},
				MapEntry::Occupied(_) => {},
			}
		}
	}
	Ok(())
}

/// Decompresses one outer stream for a compressed-tar or single-stream
/// pseudo-archive, bounded by `limits.archive_size`.
fn decode_compressed(
	format: Format,
	source: &mut (impl Read + Seek),
	file_size: u64,
	limits: Limits,
) -> Result<Vec<u8>> {
	match format {
		Format::TarGz | Format::Gz => decode_gzip(source, file_size, limits),
		Format::TarBz2 | Format::Bz2 => {
			codec::bzip2_decompress(&read_source(source, file_size)?, limits)
		},
		Format::TarXz | Format::Xz => codec::xz_decompress(&read_source(source, file_size)?, limits),
		Format::TarZst | Format::Zst => {
			codec::zstd_decompress(&read_source(source, file_size)?, limits)
		},
		Format::TarZ | Format::Z => codec::lzw_decompress(&read_source(source, file_size)?, limits),
		Format::Lzma => codec::lzma_alone_decompress(&read_source(source, file_size)?, limits),
		_ => Err(Error::InvalidArchive("format is not a compressed stream")),
	}
}

/// Reads an entire size-checked source into memory for whole-stream codecs.
fn read_source(source: &mut (impl Read + Seek), file_size: u64) -> Result<Vec<u8>> {
	source.seek(SeekFrom::Start(0))?;
	let capacity = usize::try_from(file_size)
		.map_err(|_| Error::InvalidArchive("archive does not fit this platform"))?;
	let mut bytes = Vec::with_capacity(capacity);
	source.read_to_end(&mut bytes)?;
	Ok(bytes)
}

/// Indexes a decompressed stream: a tar when it is one, else a single
/// stem-named member backed by decoded buffer 0.
fn index_decoded_stream(bytes: &[u8], stem: Option<Str>, limits: Limits) -> Result<Vec<Entry>> {
	if tar::is_header(bytes) {
		let decoded_size = bytes.len() as u64;
		return tar::read_entries(&mut Cursor::new(bytes), decoded_size, limits);
	}
	let path = stem.unwrap_or_else(|| Str::new("data"));
	validate(&path, limits)?;
	Ok(vec![Entry {
		path,
		directory: false,
		size: bytes.len() as u64,
		modified_unix_seconds: None,
		mode: None,
		storage: Storage::Buffered {
			buffer:      0,
			data_offset: 0,
			stored_size: bytes.len() as u64,
		},
	}])
}

/// Derives the single-member name for a compressed file: its filename minus
/// the recognized archive extension (`notes.txt.gz` → `notes.txt`).
fn member_stem(path: &Path) -> Option<Str> {
	let name = path.file_name()?.to_str()?;
	let lower = name.to_ascii_lowercase();
	let (extension, _) = EXTENSION_TABLE
		.iter()
		.find(|(extension, _)| lower.ends_with(extension) && lower.len() > extension.len())?;
	let stem = &name[..name.len() - extension.len()];
	normalize(stem, false)
}

/// Copies one verbatim byte range from the source to `output`.
fn copy_source_range<W: Write>(
	source: &mut (impl Read + Seek),
	data_offset: u64,
	stored_size: u64,
	output: &mut W,
) -> Result<u64> {
	source.seek(SeekFrom::Start(data_offset))?;
	let copied = io::copy(&mut source.take(stored_size), output)?;
	if copied != stored_size {
		return Err(Error::InvalidArchive("truncated member data"));
	}
	Ok(copied)
}
