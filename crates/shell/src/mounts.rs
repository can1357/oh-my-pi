//! URL mounts: host directories and files a session maps URL paths onto.
//!
//! A session's [`Mounts`] table says which host entry backs a URL path
//! (`urlmap local:// /sessions/7/local`, [`crate::tools`]). [`Mounts::over`]
//! layers it over the session's filesystem as a [`FileSystem`] provider:
//!
//! - **Lookup.** An exact mount answers for its own URL only; otherwise the
//!   mount with the longest prefix of the path's segments does, and the rest of
//!   the path is taken below its host entry. `.` and `..` are resolved in the
//!   URL first, so no spelling reaches a host entry outside a mount; one that
//!   climbs above the scheme's root names nothing.
//! - **A hit** runs on the host path, natively: files a program opens are host
//!   files, a directory lists its host entries under the URL spelling, and
//!   [`FileSystem::backing_path`] is the host path, which is what an external
//!   is handed in place of the URL ([`crate::host`]).
//! - **Read-only mounts** refuse every change with `EROFS`, an open for writing
//!   included.
//! - **A miss** is the wrapped filesystem's: its provider's answer, or "no such
//!   file" when it has none.
//!
//! Only URL paths are looked up, and a table with no mount leaves the
//! filesystem as it is.

use std::{
	ffi::{OsStr, OsString},
	fmt, io,
	path::{Path, PathBuf},
	sync::Arc,
};

use async_trait::async_trait;
use parking_lot::RwLock;
use omp_vfs::{
	CanonicalizeOptions, DirEntry, DirOptions, File, FileSystem, FileTime, Metadata, NodeKind,
	OpenOptions, Permissions, ReadDir, StatFs, SymlinkKind,
};

/// One mapping of a URL onto a host entry.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mount {
	/// The URL as `scheme://seg/seg`, normalized.
	pub url:       String,
	/// The host entry behind it.
	pub host:      PathBuf,
	/// Changes below it are refused.
	pub read_only: bool,
	/// It answers for `url` itself only, never for a path below it.
	pub exact:     bool,
	/// Lowercase scheme of `url`.
	scheme:        String,
	/// Decoded path segments of `url`.
	segments:      Vec<String>,
}

/// Why a URL cannot be mounted or unmounted.
#[derive(Debug, PartialEq, Eq)]
pub enum MountError {
	/// The operand is not spelled `scheme://…`.
	NotUrl,
	/// The URL climbs above its scheme's root.
	Outside,
}

/// What a path names in a [`Mounts`] table.
#[derive(Debug, PartialEq, Eq)]
pub enum Resolved {
	/// A mounted entry.
	Host { path: PathBuf, read_only: bool },
	/// Nothing: the path climbs above the root of a scheme that has mounts.
	Outside,
	/// No mount covers it.
	Miss,
}

/// The URL mounts of one session; clones share the table.
#[derive(Clone, Default)]
pub struct Mounts(Arc<RwLock<Vec<Mount>>>);

impl fmt::Debug for Mounts {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_list().entries(self.0.read().iter()).finish()
	}
}

/// The scheme (lowercase) and decoded segments of the URL `text`, `.` and
/// `..` resolved; `Err(Outside)` when `..` climbs above the scheme's root or
/// a segment hides a separator behind an escape.
fn parse_url(text: &str) -> Result<(String, Vec<String>), MountError> {
	let scheme = omp_vfs::url_scheme(Path::new(text)).ok_or(MountError::NotUrl)?;
	let mut segments: Vec<String> = Vec::new();
	for part in text[scheme.len() + 3..].split('/') {
		match part {
			"" | "." => {},
			".." => {
				segments.pop().ok_or(MountError::Outside)?;
			},
			_ => {
				let name = omp_vfs::decode_segment(OsStr::new(part));
				let name = name.to_str().ok_or(MountError::Outside)?;
				if matches!(name, "." | "..") || name.contains(['/', '\\', '\0']) {
					return Err(MountError::Outside);
				}
				segments.push(name.to_owned());
			},
		}
	}
	Ok((scheme.to_ascii_lowercase(), segments))
}

impl Mounts {
	/// Whether no URL is mounted.
	pub fn is_empty(&self) -> bool {
		self.0.read().is_empty()
	}

	/// The mounts, oldest first.
	pub fn list(&self) -> Vec<Mount> {
		self.0.read().clone()
	}

	/// A table of its own holding the same mounts (a forked session's).
	#[must_use]
	pub fn snapshot(&self) -> Self {
		Self(Arc::new(RwLock::new(self.list())))
	}

	/// Mount `host` at `url`, replacing the mount of the same kind (exact or
	/// not) already there.
	///
	/// # Errors
	///
	/// [`MountError`] when `url` is not a URL path inside its scheme.
	pub fn add(
		&self,
		url: &str,
		host: PathBuf,
		read_only: bool,
		exact: bool,
	) -> Result<(), MountError> {
		let (scheme, segments) = parse_url(url)?;
		let mut spelled = format!("{scheme}://");
		for (at, segment) in segments.iter().enumerate() {
			if at > 0 {
				spelled.push('/');
			}
			spelled.push_str(&omp_vfs::encode_segment(OsStr::new(segment)).to_string_lossy());
		}
		let mount = Mount { url: spelled, host, read_only, exact, scheme, segments };
		let mut table = self.0.write();
		match table
			.iter_mut()
			.find(|m| m.exact == exact && m.scheme == mount.scheme && m.segments == mount.segments)
		{
			Some(existing) => *existing = mount,
			None => table.push(mount),
		}
		Ok(())
	}

	/// Remove every mount at `url`; whether there was one.
	///
	/// # Errors
	///
	/// [`MountError`] when `url` is not a URL path inside its scheme.
	pub fn remove(&self, url: &str) -> Result<bool, MountError> {
		let (scheme, segments) = parse_url(url)?;
		let mut table = self.0.write();
		let before = table.len();
		table.retain(|m| m.scheme != scheme || m.segments != segments);
		Ok(table.len() != before)
	}

	/// What `path` names: only a URL path of a scheme with mounts can be
	/// anything but a [`Resolved::Miss`].
	pub fn resolve(&self, path: &Path) -> Resolved {
		let Some(scheme) = omp_vfs::url_scheme(path) else {
			return Resolved::Miss;
		};
		let table = self.0.read();
		if !table.iter().any(|m| m.scheme.eq_ignore_ascii_case(scheme)) {
			return Resolved::Miss;
		}
		let Some(Ok((scheme, segments))) = path.to_str().map(parse_url) else {
			return Resolved::Outside;
		};
		let mut below: Option<&Mount> = None;
		for mount in table.iter().filter(|m| m.scheme == scheme) {
			if mount.exact {
				if mount.segments == segments {
					return Resolved::Host { path: mount.host.clone(), read_only: mount.read_only };
				}
			} else if segments.starts_with(&mount.segments)
				&& below.is_none_or(|best| mount.segments.len() > best.segments.len())
			{
				below = Some(mount);
			}
		}
		let Some(mount) = below else {
			return Resolved::Miss;
		};
		let mut path = mount.host.clone();
		path.extend(&segments[mount.segments.len()..]);
		Resolved::Host { path, read_only: mount.read_only }
	}

	/// `fs` with these mounts in front of it: the same view over a provider
	/// that answers mounted URL paths from the host and leaves every other
	/// path to `fs`'s own. `fs` itself while nothing is mounted.
	#[must_use]
	pub fn over(&self, fs: &omp_vfs::Fs) -> omp_vfs::Fs {
		if self.is_empty() {
			return fs.clone();
		}
		fs.with_provider(Arc::new(MountFs {
			mounts: self.clone(),
			inner:  fs.provider().cloned(),
			native: omp_vfs::Fs::native(),
		}))
	}
}

/// A filesystem's provider behind a [`Mounts`] table.
#[derive(Debug)]
struct MountFs {
	mounts: Mounts,
	/// The wrapped filesystem's provider; `None` when it is the host's.
	inner:  Option<Arc<dyn FileSystem>>,
	native: omp_vfs::Fs,
}

/// Where an operation on a path runs.
enum Target<'a> {
	/// On this host path; `true` when its mount is read-only.
	Host(PathBuf, bool),
	/// In the wrapped provider, on the path as given.
	Inner(&'a Arc<dyn FileSystem>),
}

impl MountFs {
	fn target(&self, path: &Path) -> io::Result<Target<'_>> {
		match self.mounts.resolve(path) {
			Resolved::Host { path, read_only } => Ok(Target::Host(path, read_only)),
			Resolved::Outside => Err(io::ErrorKind::NotFound.into()),
			Resolved::Miss => match &self.inner {
				Some(inner) => Ok(Target::Inner(inner)),
				None if omp_vfs::is_virtual_path(path) => Err(omp_vfs::no_provider(path)),
				None => Ok(Target::Host(path.to_path_buf(), false)),
			},
		}
	}

	/// [`Self::target`] for an operation that changes the entry: `EROFS`
	/// under a read-only mount.
	fn changed(&self, path: &Path) -> io::Result<Target<'_>> {
		match self.target(path)? {
			Target::Host(_, true) => Err(omp_vfs::read_only_filesystem()),
			target => Ok(target),
		}
	}

	/// Both ends of a rename or link. Mounted entries are the host's; a
	/// mounted end and one that is not live on different filesystems.
	fn pair(&self, from: &Path, to: &Path, moves: bool) -> io::Result<Pair<'_>> {
		let source = if moves {
			self.changed(from)?
		} else {
			self.target(from)?
		};
		match (source, self.changed(to)?) {
			(Target::Host(from, _), Target::Host(to, _)) => Ok(Pair::Host(from, to)),
			(Target::Inner(inner), Target::Inner(_)) => Ok(Pair::Inner(inner)),
			_ => Err(omp_vfs::crosses_devices()),
		}
	}

	const fn create_dir_options(recursive: bool, mode: Option<u32>) -> DirOptions {
		let options = DirOptions::new().recursive(recursive);
		match mode {
			Some(mode) => options.mode(mode),
			None => options,
		}
	}
}

/// Where a two-path operation runs.
enum Pair<'a> {
	Host(PathBuf, PathBuf),
	Inner(&'a Arc<dyn FileSystem>),
}

/// A host listing entry under the URL spelling of the directory listed.
fn rebase_entry(dir: &Path, entry: DirEntry) -> DirEntry {
	let name: OsString = entry.file_name();
	let rebased = DirEntry::new(omp_vfs::child_path(dir, &name), name, entry.file_type().ok());
	// One local `lstat` now instead of a lookup through the mounts per entry
	// later.
	match entry.metadata() {
		Ok(metadata) => rebased.with_metadata(metadata),
		Err(_) => rebased,
	}
}

#[async_trait]
impl FileSystem for MountFs {
	fn is_native_local(&self, path: &Path) -> bool {
		!omp_vfs::is_virtual_path(path)
			&& self
				.inner
				.as_ref()
				.is_none_or(|inner| inner.is_native_local(path))
	}

	async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
		match self.mounts.resolve(path) {
			// The mount is the alias.
			Resolved::Host { path, .. } => Ok(Some(path)),
			Resolved::Outside => Err(io::ErrorKind::NotFound.into()),
			Resolved::Miss => match &self.inner {
				Some(inner) => inner.backing_path(path).await,
				None => Ok(None),
			},
		}
	}

	fn for_cleanup(&self) -> Option<Arc<dyn FileSystem>> {
		let inner = self.inner.as_ref()?.for_cleanup()?;
		Some(Arc::new(Self {
			mounts: self.mounts.clone(),
			inner:  Some(inner),
			native: self.native.clone(),
		}))
	}

	async fn open(&self, path: &Path, options: &OpenOptions) -> io::Result<File> {
		match self.target(path)? {
			Target::Host(_, true)
				if options.is_writable() || options.is_truncate() || options.is_create() =>
			{
				Err(omp_vfs::read_only_filesystem())
			},
			Target::Host(host, _) => self.native.open_with(&host, options).await,
			Target::Inner(inner) => inner.open(path, options).await,
		}
	}

	async fn metadata(&self, path: &Path) -> io::Result<Metadata> {
		match self.target(path)? {
			Target::Host(host, _) => self.native.metadata(&host).await,
			Target::Inner(inner) => inner.metadata(path).await,
		}
	}

	async fn symlink_metadata(&self, path: &Path) -> io::Result<Metadata> {
		match self.target(path)? {
			Target::Host(host, _) => self.native.symlink_metadata(&host).await,
			Target::Inner(inner) => inner.symlink_metadata(path).await,
		}
	}

	async fn read_dir(&self, path: &Path) -> io::Result<ReadDir> {
		match self.target(path)? {
			Target::Host(host, _) => {
				let entries = self
					.native
					.read_dir(&host)
					.await?
					.map(|entry| entry.map(|entry| rebase_entry(path, entry)))
					.collect::<Vec<_>>();
				Ok(ReadDir::from_entries(entries))
			},
			Target::Inner(inner) => inner.read_dir(path).await,
		}
	}

	async fn read_link(&self, path: &Path) -> io::Result<PathBuf> {
		match self.target(path)? {
			Target::Host(host, _) => self.native.read_link(&host).await,
			Target::Inner(inner) => inner.read_link(path).await,
		}
	}

	async fn canonicalize(&self, path: &Path, options: &CanonicalizeOptions) -> io::Result<PathBuf> {
		match self.target(path)? {
			Target::Host(host, _) => self.native.canonicalize_with(&host, options).await,
			Target::Inner(inner) => inner.canonicalize(path, options).await,
		}
	}

	async fn create_dir(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => {
				self
					.native
					.create_dir_with(&host, &Self::create_dir_options(false, mode))
					.await
			},
			Target::Inner(inner) => inner.create_dir(path, mode).await,
		}
	}

	async fn create_dir_all(&self, path: &Path, mode: Option<u32>) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => {
				self
					.native
					.create_dir_with(&host, &Self::create_dir_options(true, mode))
					.await
			},
			Target::Inner(inner) => inner.create_dir_all(path, mode).await,
		}
	}

	async fn remove_file(&self, path: &Path) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.remove_file(&host).await,
			Target::Inner(inner) => inner.remove_file(path).await,
		}
	}

	async fn remove_dir(&self, path: &Path) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.remove_dir(&host).await,
			Target::Inner(inner) => inner.remove_dir(path).await,
		}
	}

	async fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.remove_dir_all(&host).await,
			Target::Inner(inner) => inner.remove_dir_all(path).await,
		}
	}

	async fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
		match self.pair(from, to, true)? {
			Pair::Host(from, to) => self.native.rename(&from, &to).await,
			Pair::Inner(inner) => inner.rename(from, to).await,
		}
	}

	async fn hard_link(&self, original: &Path, link: &Path) -> io::Result<()> {
		match self.pair(original, link, false)? {
			Pair::Host(original, link) => self.native.hard_link(&original, &link).await,
			Pair::Inner(inner) => inner.hard_link(original, link).await,
		}
	}

	async fn symlink(&self, target: &Path, link: &Path, kind: SymlinkKind) -> io::Result<()> {
		match self.changed(link)? {
			Target::Host(host, _) => self.native.symlink_with(target, &host, kind).await,
			Target::Inner(inner) => inner.symlink(target, link, kind).await,
		}
	}

	async fn set_permissions(&self, path: &Path, permissions: Permissions) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.set_permissions(&host, permissions).await,
			Target::Inner(inner) => inner.set_permissions(path, permissions).await,
		}
	}

	async fn set_times(
		&self,
		path: &Path,
		accessed: FileTime,
		modified: FileTime,
		follow: bool,
	) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => {
				self
					.native
					.set_times(&host, accessed, modified, follow)
					.await
			},
			Target::Inner(inner) => inner.set_times(path, accessed, modified, follow).await,
		}
	}

	async fn chown(
		&self,
		path: &Path,
		uid: Option<u32>,
		gid: Option<u32>,
		follow: bool,
	) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.chown(&host, uid, gid, follow).await,
			Target::Inner(inner) => inner.chown(path, uid, gid, follow).await,
		}
	}

	async fn access(&self, path: &Path, read: bool, write: bool, execute: bool) -> io::Result<()> {
		match self.target(path)? {
			Target::Host(_, true) if write => Err(omp_vfs::read_only_filesystem()),
			Target::Host(host, _) => self.native.access(&host, read, write, execute).await,
			Target::Inner(inner) => inner.access(path, read, write, execute).await,
		}
	}

	async fn stat_fs(&self, path: &Path) -> io::Result<StatFs> {
		match self.target(path)? {
			Target::Host(host, _) => self.native.stat_fs(&host).await,
			Target::Inner(inner) => inner.stat_fs(path).await,
		}
	}

	async fn list_xattr(&self, path: &Path, follow: bool) -> io::Result<Vec<OsString>> {
		match self.target(path)? {
			Target::Host(host, _) => self.native.list_xattr(&host, follow).await,
			Target::Inner(inner) => inner.list_xattr(path, follow).await,
		}
	}

	async fn get_xattr(
		&self,
		path: &Path,
		name: &OsStr,
		follow: bool,
	) -> io::Result<Option<Vec<u8>>> {
		match self.target(path)? {
			Target::Host(host, _) => self.native.get_xattr(&host, name, follow).await,
			Target::Inner(inner) => inner.get_xattr(path, name, follow).await,
		}
	}

	async fn set_xattr(
		&self,
		path: &Path,
		name: &OsStr,
		value: &[u8],
		follow: bool,
	) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.set_xattr(&host, name, value, follow).await,
			Target::Inner(inner) => inner.set_xattr(path, name, value, follow).await,
		}
	}

	async fn remove_xattr(&self, path: &Path, name: &OsStr, follow: bool) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.remove_xattr(&host, name, follow).await,
			Target::Inner(inner) => inner.remove_xattr(path, name, follow).await,
		}
	}

	async fn make_node(&self, path: &Path, kind: NodeKind, mode: u32) -> io::Result<()> {
		match self.changed(path)? {
			Target::Host(host, _) => self.native.make_node(&host, kind, mode).await,
			Target::Inner(inner) => inner.make_node(path, kind, mode).await,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn host(path: &str, read_only: bool) -> Resolved {
		Resolved::Host { path: PathBuf::from(path), read_only }
	}

	#[test]
	fn an_exact_mount_wins_and_the_longest_prefix_answers_below_it() {
		let mounts = Mounts::default();
		mounts
			.add("skill://review", "/skills/review".into(), true, false)
			.expect("prefix mount");
		mounts
			.add("skill://review", "/skills/review/SKILL.md".into(), true, true)
			.expect("exact mount");
		mounts
			.add("skill://review/data", "/big/data".into(), false, false)
			.expect("nested mount");
		mounts
			.add("local://", "/session/local".into(), false, false)
			.expect("root mount");

		let at = |url: &str| mounts.resolve(Path::new(url));
		assert_eq!(at("skill://review"), host("/skills/review/SKILL.md", true));
		assert_eq!(at("skill://review/"), host("/skills/review/SKILL.md", true));
		assert_eq!(at("skill://review/scripts/a.sh"), host("/skills/review/scripts/a.sh", true));
		assert_eq!(at("skill://review/data/x.bin"), host("/big/data/x.bin", false));
		assert_eq!(at("SKILL://review/data"), host("/big/data", false));
		assert_eq!(at("local://"), host("/session/local", false));
		assert_eq!(at("local://a%20b/./c"), host("/session/local/a b/c", false));
		assert_eq!(at("skill://other"), Resolved::Miss);
		assert_eq!(at("memory://x"), Resolved::Miss);
		assert_eq!(at("/skills/review"), Resolved::Miss);
	}

	#[test]
	fn no_spelling_climbs_out_of_a_mount() {
		let mounts = Mounts::default();
		mounts
			.add("local://", "/session/local".into(), false, false)
			.expect("root mount");
		mounts
			.add("skill://review", "/skills/review".into(), true, false)
			.expect("prefix mount");

		let at = |url: &str| mounts.resolve(Path::new(url));
		assert_eq!(at("local://../x"), Resolved::Outside);
		assert_eq!(at("local://a/../../x"), Resolved::Outside);
		assert_eq!(at("local://%2e%2e/x"), Resolved::Outside);
		assert_eq!(at("local://a%2f..%2f..%2fx"), Resolved::Outside);
		assert_eq!(at("local://a/../b"), host("/session/local/b", false));
		// Leaving a mount by name lands on whatever that URL is, never on the
		// host beside it.
		assert_eq!(at("skill://review/../other/x"), Resolved::Miss);
		assert_eq!(mounts.add("local://..", "/x".into(), false, false), Err(MountError::Outside));
		assert_eq!(mounts.add("memory", "/x".into(), false, false), Err(MountError::NotUrl));
	}

	/// A provider that owns every `note://` path: none of them can be read,
	/// and each is an alias of a file under `/provider`.
	#[derive(Debug)]
	struct Notes;

	#[async_trait]
	impl FileSystem for Notes {
		async fn backing_path(&self, path: &Path) -> io::Result<Option<PathBuf>> {
			let name = path
				.to_str()
				.unwrap_or_default()
				.trim_start_matches("note://");
			Ok(Some(Path::new("/provider").join(name)))
		}

		async fn open(&self, _path: &Path, _options: &OpenOptions) -> io::Result<File> {
			Err(omp_vfs::permission_denied())
		}

		async fn metadata(&self, _path: &Path) -> io::Result<Metadata> {
			Err(omp_vfs::permission_denied())
		}

		async fn read_dir(&self, _path: &Path) -> io::Result<ReadDir> {
			Err(omp_vfs::permission_denied())
		}
	}

	/// In a session whose filesystem serves URLs itself, a mount answers for
	/// its own prefix and the provider for everything else.
	#[tokio::test(flavor = "multi_thread")]
	async fn a_mount_shadows_the_provider_for_its_prefix_only() {
		let dir = tempfile::tempdir().expect("mounted directory");
		std::fs::write(dir.path().join("a.txt"), "from the host\n").expect("mounted file");
		let provided = omp_vfs::Fs::new(Arc::new(Notes));
		let mounts = Mounts::default();
		assert!(mounts.over(&provided).ptr_eq(&provided), "no mount leaves the filesystem as it is");
		mounts
			.add("note://mapped", dir.path().to_path_buf(), true, false)
			.expect("mount");
		let fs = mounts.over(&provided);

		assert_eq!(fs.read("note://mapped/a.txt").await.expect("mounted read"), b"from the host\n");
		assert_eq!(
			fs.backing_path("note://mapped/a.txt")
				.await
				.expect("mounted alias"),
			Some(dir.path().join("a.txt"))
		);
		let refused = fs
			.write("note://mapped/b.txt", b"x")
			.await
			.expect_err("read-only mount");
		assert_eq!(refused.kind(), omp_vfs::read_only_filesystem().kind());
		assert!(!dir.path().join("b.txt").exists());

		assert_eq!(
			fs.backing_path("note://other/a.txt")
				.await
				.expect("provider alias"),
			Some(PathBuf::from("/provider/other/a.txt"))
		);
		let provider = fs
			.read("note://other/a.txt")
			.await
			.expect_err("provider path");
		assert_eq!(provider.kind(), io::ErrorKind::PermissionDenied);
		assert_eq!(
			fs.read("note://mapped/../other/a.txt")
				.await
				.expect_err("provider path")
				.kind(),
			io::ErrorKind::PermissionDenied
		);
	}

	#[test]
	fn a_mount_is_replaced_by_kind_and_removed_by_url() {
		let mounts = Mounts::default();
		mounts
			.add("skill://a", "/one".into(), true, false)
			.expect("mount");
		mounts
			.add("skill://a", "/one/SKILL.md".into(), true, true)
			.expect("exact");
		mounts
			.add("skill://a/", "/two".into(), false, false)
			.expect("replacement");

		let listed: Vec<(String, PathBuf, bool, bool)> = mounts
			.list()
			.into_iter()
			.map(|m| (m.url, m.host, m.read_only, m.exact))
			.collect();
		assert_eq!(listed, [
			("skill://a".to_owned(), PathBuf::from("/two"), false, false),
			("skill://a".to_owned(), PathBuf::from("/one/SKILL.md"), true, true),
		]);
		assert_eq!(mounts.remove("skill://b"), Ok(false));
		assert_eq!(mounts.remove("skill://a"), Ok(true));
		assert!(mounts.is_empty());
	}
}
