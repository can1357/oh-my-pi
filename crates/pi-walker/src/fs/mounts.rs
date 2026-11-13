//! The host's mount table, as walks need it: which directories are network
//! filesystems (NFS, SMB, ...) and which of those an ovnfs daemon serves.
//!
//! A walk rooted on a local filesystem reports the network mount points it
//! meets but does not descend into them ([`Fences`]): a remote tree costs a
//! round trip per directory, and one mounted under `$HOME` (`OrbStack`'s
//! Docker store, a NAS share, an autofs trigger) can hold millions of
//! entries. A walk rooted on a network filesystem walks it like any other.
//! ovnfs mounts are never fenced: their daemon runs on this host, and
//! searches below one of its checkouts are answered by the daemon itself
//! ([`ovnfs_root`]).
//!
//! The table is read without touching any mounted filesystem (`getfsstat`
//! with `MNT_NOWAIT` on macOS, `/proc/self/mountinfo` on Linux) and shared by
//! the walks of one [`TTL`]. Other platforms report no mounts.

use std::{
	path::{Path, PathBuf},
	sync::Arc,
	time::{Duration, Instant},
};

use parking_lot::Mutex;

use super::Fs;

/// How long one reading of the mount table serves new walks.
const TTL: Duration = Duration::from_secs(1);

/// One mounted filesystem.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Mount {
	/// Mount point, canonical spelling.
	pub(crate) point:  PathBuf,
	/// A network filesystem.
	pub(crate) remote: bool,
	/// Admin socket of the ovnfs daemon that may serve it: named by the
	/// mount source for a Unix-socket NFS mount, else found in ovnfs's state
	/// directory for a loopback NFS or SMB mount. The daemon confirms the
	/// mount before answering for it.
	pub(crate) ovnfs:  Option<PathBuf>,
}

/// A reading of the mount table.
#[derive(Debug, Default)]
pub(crate) struct Mounts(Vec<Mount>);

impl Mounts {
	/// The current table, read at most once per [`TTL`].
	pub(crate) fn current() -> Arc<Self> {
		static CACHE: Mutex<Option<(Instant, Arc<Mounts>)>> = Mutex::new(None);
		let mut cache = CACHE.lock();
		if let Some((read, mounts)) = &*cache
			&& read.elapsed() < TTL
		{
			return Arc::clone(mounts);
		}
		let mounts = Arc::new(Self(read_table()));
		*cache = Some((Instant::now(), Arc::clone(&mounts)));
		mounts
	}

	/// The mount holding the canonical `path`: the deepest whose mount point
	/// is `path` or one of its ancestors.
	pub(crate) fn holding(&self, path: &Path) -> Option<&Mount> {
		self
			.0
			.iter()
			.filter(|mount| path.starts_with(&mount.point))
			.max_by_key(|mount| mount.point.as_os_str().len())
	}
}

/// The network mounts one walk does not descend into, as walk-relative
/// `/`-separated paths; see the [module docs](self).
#[derive(Clone, Debug, Default)]
pub(crate) struct Fences {
	points: Arc<[Box<[u8]>]>,
	remote: bool,
}

impl Fences {
	/// The fences of a walk of `root` (absolute in `fs`'s spelling): network
	/// mounts strictly below it, other than ovnfs ones, unless `root` itself
	/// lies on a network filesystem. None for providers.
	pub(crate) fn of(fs: &Fs, root: &Path) -> Self {
		if !fs.is_native() {
			return Self::default();
		}
		let mounts = Mounts::current();
		if !mounts.0.iter().any(|mount| mount.remote) {
			return Self::default();
		}
		let Ok(root) = std::fs::canonicalize(root) else {
			return Self::default();
		};
		Self::below(&mounts, &root)
	}

	fn below(mounts: &Mounts, root: &Path) -> Self {
		if mounts.holding(root).is_some_and(|mount| mount.remote) {
			return Self { points: Arc::default(), remote: true };
		}
		let points = mounts
			.0
			.iter()
			.filter(|mount| mount.remote && mount.ovnfs.is_none())
			.filter_map(|mount| {
				let rel = mount.point.strip_prefix(root).ok()?;
				let rel = rel.as_os_str().as_encoded_bytes();
				(!rel.is_empty()).then(|| walk_spelling(rel))
			})
			.collect();
		Self { points, remote: false }
	}

	/// Whether the directory at walk-relative `rel` is fenced off.
	pub(crate) fn contains(&self, rel: &[u8]) -> bool {
		self.points.iter().any(|fenced| **fenced == *rel)
	}

	/// The walk's root lies on a network filesystem: every listing is a round
	/// trip, so walks keep more of them in flight.
	pub(crate) const fn remote_root(&self) -> bool {
		self.remote
	}
}

/// A root-relative host path in walk spelling (`/` separators).
fn walk_spelling(rel: &[u8]) -> Box<[u8]> {
	if cfg!(windows) {
		rel.iter()
			.map(|&b| if b == b'\\' { b'/' } else { b })
			.collect()
	} else {
		rel.into()
	}
}

/// The admin socket of the ovnfs daemon that answers for `root`, with
/// `root`'s canonical spelling, when `root` lies strictly below an ovnfs
/// mount (in a checkout; the daemon does not search the folder listing
/// them). `None` for providers, other roots, and when no ovnfs mount exists.
pub(crate) fn ovnfs_root(fs: &Fs, root: &Path) -> Option<(PathBuf, PathBuf)> {
	if !fs.is_native() {
		return None;
	}
	let mounts = Mounts::current();
	if mounts.0.iter().all(|mount| mount.ovnfs.is_none()) {
		return None;
	}
	let root = std::fs::canonicalize(root).ok()?;
	let mount = mounts.holding(&root)?;
	let socket = mount.ovnfs.clone()?;
	(root != mount.point).then_some((socket, root))
}

/// Network filesystem types (Linux `mountinfo` names; FUSE ones by subtype).
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "read from Linux mountinfo only; tested everywhere")
)]
const REMOTE_TYPES: &[&str] = &[
	"9p",
	"afs",
	"autofs",
	"ceph",
	"cifs",
	"coda",
	"davfs",
	"fuse.davfs",
	"fuse.gcsfuse",
	"fuse.rclone",
	"fuse.s3fs",
	"fuse.sshfs",
	"glusterfs",
	"lustre",
	"ncpfs",
	"nfs",
	"nfs4",
	"smb3",
	"smbfs",
];

/// The ovnfs admin socket behind a network mount, from its mount `source`.
fn ovnfs_socket(source: &str) -> Option<PathBuf> {
	// macOS NFS over a Unix socket: `<STATE/nfs.sock>:/`.
	if let Some(rest) = source.strip_prefix('<')
		&& let Some((socket, _)) = rest.split_once(">:")
	{
		let socket = Path::new(socket);
		return (socket.file_name()? == "nfs.sock").then(|| socket.with_file_name("admin.sock"));
	}
	if !is_loopback(source) {
		return None;
	}
	state_dirs()
		.into_iter()
		.map(|state| state.join("admin.sock"))
		.find(|socket| socket.exists())
}

/// Whether an NFS (`HOST:/path`) or SMB (`//[USER@]HOST[:PORT]/SHARE`) mount
/// source names this host.
fn is_loopback(source: &str) -> bool {
	let host = match source.strip_prefix("//") {
		Some(smb) => {
			let authority = smb.split('/').next().unwrap_or_default();
			let host = authority
				.rsplit_once('@')
				.map_or(authority, |(_, host)| host);
			host.rsplit_once(':').map_or(host, |(host, _)| host)
		},
		None => match source.strip_prefix('[') {
			Some(v6) => v6.split_once(']').map_or("", |(host, _)| host),
			None => source.split_once(':').map_or("", |(host, _)| host),
		},
	};
	matches!(host, "127.0.0.1" | "localhost" | "::1")
}

/// Where ovnfs keeps daemon state, in its own lookup order: `$OVNFS_STATE`,
/// `state:` in `~/.o2/ovnfs.yml`, then `$XDG_STATE_HOME/ovnfs` or
/// `~/.local/state/ovnfs`.
fn state_dirs() -> Vec<PathBuf> {
	let home = std::env::home_dir();
	let mut dirs = Vec::new();
	if let Some(state) = std::env::var_os("OVNFS_STATE").filter(|state| !state.is_empty()) {
		dirs.push(PathBuf::from(state));
	}
	if let Some(home) = &home
		&& let Ok(config) = std::fs::read_to_string(home.join(".o2/ovnfs.yml"))
		&& let Some(state) = configured_state(&config, home)
	{
		dirs.push(state);
	}
	match std::env::var_os("XDG_STATE_HOME").filter(|xdg| !xdg.is_empty()) {
		Some(xdg) => dirs.push(PathBuf::from(xdg).join("ovnfs")),
		None => dirs.extend(home.map(|home| home.join(".local/state/ovnfs"))),
	}
	dirs
}

/// The top-level `state:` of an ovnfs config file.
fn configured_state(config: &str, home: &Path) -> Option<PathBuf> {
	let value = config
		.lines()
		.find_map(|line| line.strip_prefix("state:"))?
		.split(" #")
		.next()?
		.trim()
		.trim_matches(['"', '\'']);
	if value.is_empty() {
		return None;
	}
	Some(
		value
			.strip_prefix("~/")
			.map_or_else(|| PathBuf::from(value), |rest| home.join(rest)),
	)
}

#[cfg(target_os = "macos")]
fn read_table() -> Vec<Mount> {
	use std::ffi::{CStr, c_int};

	let field = |raw: &[libc::c_char]| {
		// SAFETY: `getfsstat` NUL-terminates every name field.
		unsafe { CStr::from_ptr(raw.as_ptr()) }
			.to_string_lossy()
			.into_owned()
	};
	// SAFETY: a null buffer asks for the number of mounts.
	let count = unsafe { libc::getfsstat(std::ptr::null_mut(), 0, libc::MNT_NOWAIT) };
	let Ok(count) = usize::try_from(count) else {
		return Vec::new();
	};
	// Room for mounts that appear between the two calls.
	let mut table: Vec<libc::statfs> = Vec::with_capacity(count + 8);
	let bytes = c_int::try_from(table.capacity() * size_of::<libc::statfs>()).unwrap_or(c_int::MAX);
	// SAFETY: the buffer holds `bytes` bytes of `statfs` records.
	let filled = unsafe { libc::getfsstat(table.as_mut_ptr(), bytes, libc::MNT_NOWAIT) };
	let Ok(filled) = usize::try_from(filled) else {
		return Vec::new();
	};
	// SAFETY: `getfsstat` initialized the first `filled` records.
	unsafe { table.set_len(filled.min(table.capacity())) };
	table
		.iter()
		.map(|fs| {
			let remote = fs.f_flags & libc::MNT_LOCAL.cast_unsigned() == 0;
			Mount {
				point: PathBuf::from(field(&fs.f_mntonname)),
				remote,
				ovnfs: remote
					.then(|| ovnfs_socket(&field(&fs.f_mntfromname)))
					.flatten(),
			}
		})
		.collect()
}

#[cfg(target_os = "linux")]
fn read_table() -> Vec<Mount> {
	std::fs::read_to_string("/proc/self/mountinfo").map_or_default(|table| parse_mountinfo(&table))
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn read_table() -> Vec<Mount> {
	Vec::new()
}

/// The mounts of a Linux `mountinfo` table: `ID PARENT DEV ROOT POINT
/// OPTIONS [OPTIONAL...] - TYPE SOURCE SUPER`.
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "read from Linux mountinfo only; tested everywhere")
)]
fn parse_mountinfo(table: &str) -> Vec<Mount> {
	table
		.lines()
		.filter_map(|line| {
			let (head, tail) = line.split_once(" - ")?;
			let point = head.split(' ').nth(4)?;
			let mut tail = tail.split(' ');
			let (kind, source) = (tail.next()?, tail.next().unwrap_or_default());
			let remote = REMOTE_TYPES.contains(&kind);
			Some(Mount {
				point: PathBuf::from(unescape_octal(point)),
				remote,
				ovnfs: remote
					.then(|| ovnfs_socket(&unescape_octal(source)))
					.flatten(),
			})
		})
		.collect()
}

/// Undoes `mountinfo`'s `\NNN` octal escapes (space, tab, newline,
/// backslash).
#[cfg_attr(
	not(target_os = "linux"),
	allow(dead_code, reason = "read from Linux mountinfo only; tested everywhere")
)]
fn unescape_octal(field: &str) -> String {
	if !field.contains('\\') {
		return field.to_owned();
	}
	let bytes = field.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'\\'
			&& let Some(digits) = bytes.get(i + 1..i + 4)
			&& let Ok(text) = std::str::from_utf8(digits)
			&& let Ok(byte) = u8::from_str_radix(text, 8)
		{
			out.push(byte);
			i += 4;
		} else {
			out.push(bytes[i]);
			i += 1;
		}
	}
	String::from_utf8_lossy_owned(out)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn mount(point: &str, remote: bool, ovnfs: Option<&str>) -> Mount {
		Mount { point: point.into(), remote, ovnfs: ovnfs.map(PathBuf::from) }
	}

	/// A local root fences the non-ovnfs network mounts below it; a root on a
	/// network filesystem fences nothing.
	#[test]
	fn fences_remote_mounts_below_local_roots_only() {
		let mounts = Mounts(vec![
			mount("/", false, None),
			mount("/Users/me/OrbStack", true, None),
			mount("/Users/me/nas/share", true, None),
			mount("/Users/me/checkouts", true, Some("/state/admin.sock")),
			mount("/Users/other/OrbStack", true, None),
		]);
		let fences = Fences::below(&mounts, Path::new("/Users/me"));
		assert!(fences.contains(b"OrbStack"));
		assert!(fences.contains(b"nas/share"));
		assert!(!fences.contains(b"checkouts"));
		assert!(!fences.contains(b"nas"));
		assert_eq!(fences.points.len(), 2);
		assert!(!fences.remote_root());
		for remote in ["/Users/me/OrbStack/docker", "/Users/me/OrbStack"] {
			let fences = Fences::below(&mounts, Path::new(remote));
			assert!(fences.points.is_empty() && fences.remote_root(), "{remote}");
		}
	}

	/// The Unix-socket NFS source names the daemon's state directory; other
	/// remote sources never resolve to a socket unless served by this host.
	#[test]
	fn ovnfs_socket_from_unix_socket_source() {
		assert_eq!(
			ovnfs_socket("</work/.tree/.ovnfs/nfs.sock>:/"),
			Some(PathBuf::from("/work/.tree/.ovnfs/admin.sock"))
		);
		assert_eq!(ovnfs_socket("</tmp/other.sock>:/"), None);
		assert_eq!(ovnfs_socket("OrbStack:/OrbStack"), None);
		assert_eq!(ovnfs_socket("nas.local:/volume1"), None);
	}

	#[test]
	fn loopback_sources() {
		for source in [
			"127.0.0.1:/",
			"localhost:/export",
			"[::1]:/",
			"//127.0.0.1/ovnfs",
			"//guest@127.0.0.1:4450/ovnfs",
		] {
			assert!(is_loopback(source), "{source}");
		}
		for source in ["nas:/volume1", "//nas/share", "//guest@10.0.0.2:445/x", "OrbStack:/OrbStack"]
		{
			assert!(!is_loopback(source), "{source}");
		}
	}

	#[test]
	fn configured_state_reads_top_level_key() {
		let home = Path::new("/home/me");
		let state = |config| configured_state(config, home);
		assert_eq!(
			state("mount: /x\nstate: ~/ovnfs-state\n"),
			Some(PathBuf::from("/home/me/ovnfs-state"))
		);
		assert_eq!(state("state: \"/srv/ovnfs\" # pinned\n"), Some(PathBuf::from("/srv/ovnfs")));
		assert_eq!(state("  state: /nested\n"), None);
		assert_eq!(state("state:\n"), None);
	}

	#[test]
	fn mountinfo_classifies_network_types_and_unescapes_points() {
		let table = "\
22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw
40 22 0:50 / /mnt/my\\040nas rw,relatime shared:2 master:1 - nfs4 nas:/volume1 rw,vers=4.2
41 22 0:51 / /home/me/checkouts rw - nfs 127.0.0.1:/ rw
42 22 0:52 / /media/remote rw - fuse.sshfs me@host:/ rw
43 22 0:53 / /run/user/1000/doc rw - fuse.portal portal rw";
		let mounts = parse_mountinfo(table);
		let remote: Vec<_> = mounts
			.iter()
			.filter(|mount| mount.remote)
			.map(|mount| mount.point.to_str().unwrap())
			.collect();
		assert_eq!(remote, ["/mnt/my nas", "/home/me/checkouts", "/media/remote"]);
	}

	/// The deepest mount point containing a path holds it, component-wise.
	#[test]
	fn holding_picks_deepest_component_prefix() {
		let mounts = Mounts(vec![mount("/", false, None), mount("/mnt/nas", true, None)]);
		assert_eq!(mounts.holding(Path::new("/mnt/nas/a")).unwrap().point, Path::new("/mnt/nas"));
		assert_eq!(mounts.holding(Path::new("/mnt/nasty")).unwrap().point, Path::new("/"));
	}
}
