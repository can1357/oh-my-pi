//! Mount-table, filesystem-statistics, and metadata-time helpers.

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	fs::Metadata,
	io,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use strum::EnumString;

/// Metadata timestamp selected by `ls --time` and `stat` directives.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MetadataTimeField {
	/// Last content modification.
	Modification,
	/// Last access.
	Access,
	/// Last metadata change.
	Change,
	/// Creation or birth time.
	Birth,
}

#[derive(EnumString)]
enum MetadataTimeName {
	#[strum(serialize = "mtime", serialize = "modification")]
	Modification,
	#[strum(serialize = "access", serialize = "atime", serialize = "use")]
	Access,
	#[strum(serialize = "ctime", serialize = "status")]
	Change,
	#[strum(serialize = "birth", serialize = "creation")]
	Birth,
}

impl From<&str> for MetadataTimeField {
	fn from(value: &str) -> Self {
		match value
			.parse::<MetadataTimeName>()
			.unwrap_or_else(|_| unreachable!("clap restricted metadata time field"))
		{
			MetadataTimeName::Modification => Self::Modification,
			MetadataTimeName::Access => Self::Access,
			MetadataTimeName::Change => Self::Change,
			MetadataTimeName::Birth => Self::Birth,
		}
	}
}

/// Returns the selected timestamp from filesystem metadata.
pub(crate) fn metadata_get_time(
	metadata: &Metadata,
	field: MetadataTimeField,
) -> Option<SystemTime> {
	match field {
		MetadataTimeField::Modification => metadata.modified().ok(),
		MetadataTimeField::Access => metadata.accessed().ok(),
		MetadataTimeField::Birth => metadata.created().ok(),
		MetadataTimeField::Change => metadata_change_time(metadata),
	}
}

#[cfg(unix)]
fn metadata_change_time(metadata: &Metadata) -> Option<SystemTime> {
	use std::os::unix::fs::MetadataExt;
	let seconds = metadata.ctime();
	let nanoseconds = metadata.ctime_nsec();
	let total = i128::from(seconds) * 1_000_000_000 + i128::from(nanoseconds);
	if total >= 0 {
		Some(UNIX_EPOCH + Duration::from_nanos(total.try_into().ok()?))
	} else {
		Some(UNIX_EPOCH - Duration::from_nanos((-total).try_into().ok()?))
	}
}

#[cfg(not(unix))]
fn metadata_change_time(_metadata: &Metadata) -> Option<SystemTime> {
	None
}

/// One mounted filesystem from the operating system mount table.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct MountInfo {
	/// Device identifier used to correlate file metadata with this mount.
	pub(crate) dev_id:       String,
	/// Device or remote source name.
	pub(crate) dev_name:     String,
	/// Filesystem type name.
	pub(crate) fs_type:      String,
	/// Root of this mount within its source filesystem.
	pub(crate) mount_root:   OsString,
	/// Directory at which the filesystem is mounted.
	pub(crate) mount_dir:    OsString,
	/// Comma-separated mount options.
	pub(crate) mount_option: String,
	/// Whether the source is remote.
	pub(crate) remote:       bool,
	/// Whether the filesystem is a pseudo-filesystem normally omitted from
	/// listings.
	pub(crate) dummy:        bool,
}

/// Reads the host's current mount table.
pub(crate) fn read_fs_list() -> io::Result<Vec<MountInfo>> {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		use std::fs;

		// `/proc/self/mountinfo` is process-directed metadata. The traditional
		// mount table contains the filesystem data these builtins need without
		// naming the embedding process.
		let bytes = fs::read("/proc/mounts")?;
		return Ok(parse_linux_mounts(&bytes, false));
	}
	#[cfg(any(
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd"
	))]
	{
		return read_bsd_mounts();
	}
	#[cfg(not(any(
		target_os = "linux",
		target_os = "android",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "netbsd",
		target_os = "openbsd"
	)))]
	{
		Ok(Vec::new())
	}
}

#[cfg(unix)]
fn mount_device_id(path: &OsStr) -> String {
	use std::{fs, os::unix::fs::MetadataExt};
	fs::metadata(path)
		.map(|metadata| metadata.dev().to_string())
		.unwrap_or_default()
}

#[cfg(any(target_os = "linux", target_os = "android", all(test, unix)))]
fn parse_linux_mounts(bytes: &[u8], mountinfo: bool) -> Vec<MountInfo> {
	use std::os::unix::ffi::{OsStrExt, OsStringExt};
	bytes
		.split(|byte| *byte == b'\n')
		.filter_map(|line| {
			let fields: Vec<&[u8]> = line
				.split(|byte| byte.is_ascii_whitespace())
				.filter(|field| !field.is_empty())
				.collect();
			let (dev_name, fs_type, mount_root, mount_dir, mount_option) = if mountinfo {
				let separator = fields.iter().position(|field| *field == b"-")?;
				if fields.len() <= separator + 2 || fields.len() < 6 {
					return None;
				}
				(
					String::from_utf8_lossy(fields[separator + 2]).into_owned(),
					String::from_utf8_lossy(fields[separator + 1]).into_owned(),
					OsString::from_vec(decode_mount_field(fields[3])),
					OsString::from_vec(decode_mount_field(fields[4])),
					String::from_utf8_lossy(fields[5]).into_owned(),
				)
			} else {
				if fields.len() < 4 {
					return None;
				}
				(
					String::from_utf8_lossy(fields[0]).into_owned(),
					String::from_utf8_lossy(fields[2]).into_owned(),
					OsString::new(),
					OsString::from_vec(decode_mount_field(fields[1])),
					String::from_utf8_lossy(fields[3]).into_owned(),
				)
			};
			let dev_id = mount_device_id(OsStr::from_bytes(mount_dir.as_bytes()));
			let dummy = is_dummy_filesystem(&fs_type, &mount_option);
			let remote = is_remote_filesystem(&dev_name, &fs_type);
			Some(MountInfo {
				dev_id,
				dev_name,
				fs_type,
				mount_root,
				mount_dir,
				mount_option,
				remote,
				dummy,
			})
		})
		.collect()
}

#[cfg(any(target_os = "linux", target_os = "android", all(test, unix)))]
fn decode_mount_field(field: &[u8]) -> Vec<u8> {
	let mut decoded = Vec::with_capacity(field.len());
	let mut index = 0;
	while index < field.len() {
		if field[index] == b'\\' && index + 3 < field.len() {
			let replacement = match &field[index + 1..index + 4] {
				b"040" => Some(b' '),
				b"011" => Some(b'\t'),
				b"012" => Some(b'\n'),
				b"134" => Some(b'\\'),
				_ => None,
			};
			if let Some(byte) = replacement {
				decoded.push(byte);
				index += 4;
				continue;
			}
		}
		decoded.push(field[index]);
		index += 1;
	}
	decoded
}

fn is_dummy_filesystem(fs_type: &str, options: &str) -> bool {
	matches!(
		fs_type,
		"autofs"
			| "proc"
			| "subfs"
			| "debugfs"
			| "devpts"
			| "fusectl"
			| "mqueue"
			| "rpc_pipefs"
			| "sysfs"
			| "devfs"
			| "kernfs"
			| "ignore"
			| "rootfs"
			| "binfmt_misc"
	) || fs_type == "none" && !options.split(',').any(|option| option == "bind")
}

fn is_remote_filesystem(device: &str, fs_type: &str) -> bool {
	device.contains(':')
		|| (device.starts_with("//") && matches!(fs_type, "smbfs" | "cifs"))
		|| device == "-hosts"
}

#[cfg(any(
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd"
))]
fn read_bsd_mounts() -> io::Result<Vec<MountInfo>> {
	use std::{ffi::CStr, os::unix::ffi::OsStringExt, ptr, slice};
	let mut mounts = ptr::null_mut::<StatFs>();
	// SAFETY: `getmntinfo` initializes `mounts` to a process-owned array valid
	// until its next call.
	let count = unsafe { libc::getmntinfo(&raw mut mounts, libc::MNT_NOWAIT) };
	if count == 0 || mounts.is_null() {
		return Err(io::Error::last_os_error());
	}
	// SAFETY: `getmntinfo` returned `count` initialized entries.
	let mounts = unsafe { slice::from_raw_parts(mounts, count as usize) };
	Ok(mounts
		.iter()
		.map(|stat| {
			// SAFETY: mount-table character arrays are NUL terminated by the kernel.
			let dev_name = unsafe { CStr::from_ptr(stat.f_mntfromname.as_ptr()) }
				.to_string_lossy()
				.into_owned();
			// SAFETY: as above.
			let fs_type = unsafe { CStr::from_ptr(stat.f_fstypename.as_ptr()) }
				.to_string_lossy()
				.into_owned();
			// SAFETY: as above.
			let mount_dir = OsString::from_vec(
				unsafe { CStr::from_ptr(stat.f_mntonname.as_ptr()) }
					.to_bytes()
					.to_vec(),
			);
			MountInfo {
				dev_id: mount_device_id(&mount_dir),
				remote: is_remote_filesystem(&dev_name, &fs_type),
				dummy: is_dummy_filesystem(&fs_type, ""),
				dev_name,
				fs_type,
				mount_root: OsString::new(),
				mount_dir,
				mount_option: String::new(),
			}
		})
		.collect())
}

/// Native filesystem statistics returned by `statfs`.
#[cfg(any(
	target_os = "linux",
	target_os = "android",
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "openbsd"
))]
pub(crate) type StatFs = libc::statfs;
/// Native filesystem statistics returned by `statvfs` on platforms without
/// `statfs`.
#[cfg(all(
	unix,
	not(any(
		target_os = "linux",
		target_os = "android",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "openbsd"
	))
))]
pub(crate) type StatFs = libc::statvfs;

/// Cross-platform accessors for native filesystem statistics.
#[cfg(unix)]
pub(crate) trait FsMeta {
	/// Filesystem magic number.
	fn fs_type(&self) -> i64;
	/// Preferred transfer block size.
	fn io_size(&self) -> u64;
	/// Fundamental allocation block size.
	fn block_size(&self) -> i64;
	/// Total allocation blocks.
	fn total_blocks(&self) -> u64;
	/// Free allocation blocks.
	fn free_blocks(&self) -> u64;
	/// Free allocation blocks available to unprivileged users.
	fn avail_blocks(&self) -> u64;
	/// Total file nodes.
	fn total_file_nodes(&self) -> u64;
	/// Free file nodes.
	fn free_file_nodes(&self) -> u64;
	/// Filesystem identifier represented as an integer.
	fn fsid(&self) -> u64;
	/// Maximum filename length.
	fn namelen(&self) -> u64;
}

#[cfg(any(target_os = "linux", target_os = "android"))]
impl FsMeta for StatFs {
	fn fs_type(&self) -> i64 {
		self.f_type as i64
	}

	fn io_size(&self) -> u64 {
		self.f_frsize as u64
	}

	fn block_size(&self) -> i64 {
		self.f_bsize as i64
	}

	fn total_blocks(&self) -> u64 {
		self.f_blocks as u64
	}

	fn free_blocks(&self) -> u64 {
		self.f_bfree as u64
	}

	fn avail_blocks(&self) -> u64 {
		self.f_bavail as u64
	}

	fn total_file_nodes(&self) -> u64 {
		self.f_files as u64
	}

	fn free_file_nodes(&self) -> u64 {
		self.f_ffree as u64
	}

	fn fsid(&self) -> u64 {
		// SAFETY: Linux `fsid_t` is exactly two 32-bit words.
		let words: [u32; 2] = unsafe { mem::transmute(self.f_fsid) };
		use std::mem;
		(u64::from(words[0]) << 32) | u64::from(words[1])
	}

	fn namelen(&self) -> u64 {
		self.f_namelen as u64
	}
}

#[cfg(target_vendor = "apple")]
impl FsMeta for StatFs {
	fn fs_type(&self) -> i64 {
		i64::from(self.f_type)
	}

	fn io_size(&self) -> u64 {
		self.f_iosize as u64
	}

	fn block_size(&self) -> i64 {
		i64::from(self.f_bsize)
	}

	fn total_blocks(&self) -> u64 {
		self.f_blocks
	}

	fn free_blocks(&self) -> u64 {
		self.f_bfree
	}

	fn avail_blocks(&self) -> u64 {
		self.f_bavail
	}

	fn total_file_nodes(&self) -> u64 {
		self.f_files
	}

	fn free_file_nodes(&self) -> u64 {
		self.f_ffree
	}

	fn fsid(&self) -> u64 {
		// SAFETY: Darwin `fsid_t` is exactly two 32-bit words.
		let words: [u32; 2] = unsafe { mem::transmute(self.f_fsid) };
		use std::mem;
		(u64::from(words[0]) << 32) | u64::from(words[1])
	}

	fn namelen(&self) -> u64 {
		1024
	}
}

#[cfg(target_os = "freebsd")]
impl FsMeta for StatFs {
	fn fs_type(&self) -> i64 {
		i64::from(self.f_type)
	}

	fn io_size(&self) -> u64 {
		self.f_iosize
	}

	fn block_size(&self) -> i64 {
		self.f_bsize.try_into().unwrap_or(i64::MAX)
	}

	fn total_blocks(&self) -> u64 {
		self.f_blocks
	}

	fn free_blocks(&self) -> u64 {
		self.f_bfree
	}

	fn avail_blocks(&self) -> u64 {
		self.f_bavail.try_into().unwrap_or(0)
	}

	fn total_file_nodes(&self) -> u64 {
		self.f_files
	}

	fn free_file_nodes(&self) -> u64 {
		self.f_ffree.try_into().unwrap_or(0)
	}

	fn fsid(&self) -> u64 {
		// SAFETY: FreeBSD `fsid_t` is exactly two 32-bit words.
		let words: [u32; 2] = unsafe { mem::transmute(self.f_fsid) };
		use std::mem;
		(u64::from(words[0]) << 32) | u64::from(words[1])
	}

	fn namelen(&self) -> u64 {
		u64::from(self.f_namemax)
	}
}

#[cfg(target_os = "openbsd")]
impl FsMeta for StatFs {
	fn fs_type(&self) -> i64 {
		0
	}

	fn io_size(&self) -> u64 {
		u64::from(self.f_iosize)
	}

	fn block_size(&self) -> i64 {
		i64::from(self.f_bsize)
	}

	fn total_blocks(&self) -> u64 {
		self.f_blocks
	}

	fn free_blocks(&self) -> u64 {
		self.f_bfree
	}

	fn avail_blocks(&self) -> u64 {
		self.f_bavail.try_into().unwrap_or(0)
	}

	fn total_file_nodes(&self) -> u64 {
		self.f_files
	}

	fn free_file_nodes(&self) -> u64 {
		self.f_ffree
	}

	fn fsid(&self) -> u64 {
		// SAFETY: OpenBSD `fsid_t` is exactly two 32-bit words.
		let words: [u32; 2] = unsafe { mem::transmute(self.f_fsid) };
		use std::mem;
		(u64::from(words[0]) << 32) | u64::from(words[1])
	}

	fn namelen(&self) -> u64 {
		u64::from(self.f_namemax)
	}
}

#[cfg(target_os = "netbsd")]
impl FsMeta for StatFs {
	fn fs_type(&self) -> i64 {
		0
	}

	fn io_size(&self) -> u64 {
		self.f_iosize as u64
	}

	fn block_size(&self) -> i64 {
		self.f_bsize as i64
	}

	fn total_blocks(&self) -> u64 {
		self.f_blocks as u64
	}

	fn free_blocks(&self) -> u64 {
		self.f_bfree as u64
	}

	fn avail_blocks(&self) -> u64 {
		self.f_bavail as u64
	}

	fn total_file_nodes(&self) -> u64 {
		self.f_files as u64
	}

	fn free_file_nodes(&self) -> u64 {
		self.f_ffree as u64
	}

	fn fsid(&self) -> u64 {
		self.f_fsid as u64
	}

	fn namelen(&self) -> u64 {
		self.f_namemax as u64
	}
}

/// Reads native filesystem statistics for `path`.
#[cfg(unix)]
pub(crate) fn statfs(path: &OsStr) -> Result<StatFs, String> {
	use std::{ffi::CString, mem::MaybeUninit, os::unix::ffi::OsStrExt};
	let path = CString::new(path.as_bytes()).map_err(|error| error.to_string())?;
	let mut stat = MaybeUninit::<StatFs>::uninit();
	#[cfg(any(
		target_os = "linux",
		target_os = "android",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "openbsd"
	))]
	// SAFETY: `path` is a valid C string and `stat` points to writable storage.
	let result = unsafe { libc::statfs(path.as_ptr(), stat.as_mut_ptr()) };
	#[cfg(not(any(
		target_os = "linux",
		target_os = "android",
		target_vendor = "apple",
		target_os = "freebsd",
		target_os = "openbsd"
	)))]
	// SAFETY: `path` is a valid C string and `stat` points to writable storage.
	let result = unsafe { libc::statvfs(path.as_ptr(), stat.as_mut_ptr()) };
	if result == 0 {
		// SAFETY: successful `statfs`/`statvfs` initialized the structure.
		Ok(unsafe { stat.assume_init() })
	} else {
		Err(io::Error::last_os_error().to_string())
	}
}

/// Describes a Unix file type, distinguishing empty regular files.
#[cfg(unix)]
pub(crate) fn pretty_filetype(mode: libc::mode_t, size: u64) -> String {
	let description = match mode & libc::S_IFMT {
		x if x == libc::S_IFREG => {
			if size == 0 {
				"regular empty file"
			} else {
				"regular file"
			}
		},
		x if x == libc::S_IFDIR => "directory",
		x if x == libc::S_IFLNK => "symbolic link",
		x if x == libc::S_IFCHR => "character special file",
		x if x == libc::S_IFBLK => "block special file",
		x if x == libc::S_IFIFO => "fifo",
		x if x == libc::S_IFSOCK => "socket",
		_ => return format!("weird file ({:07o})", mode & libc::S_IFMT),
	};
	description.to_owned()
}

/// Converts a filesystem magic number to the name printed by GNU `stat`.
pub(crate) fn pretty_fstype(fstype: i64) -> Cow<'static, str> {
	let name = match fstype {
		0x6163_6673 => "acfs",
		0xadf5 => "adfs",
		0xadff => "affs",
		0x5346_414f => "afs",
		0x0904_1934 => "anon-inode FS",
		0x6175_6673 => "aufs",
		0x0187 => "autofs",
		0x4246_5331 => "befs",
		0x6264_6576 => "bdevfs",
		0xca45_1a4e => "bcachefs",
		0x1bad_face => "bfs",
		0xcafe_4a11 => "bpf_fs",
		0x4249_4e4d => "binfmt_misc",
		0x9123_683e => "btrfs",
		0x7372_7279 => "btrfs_test",
		0x00c3_6400 => "ceph",
		0x0027_e0eb => "cgroupfs",
		0x6367_7270 => "cgroup2fs",
		0xff53_4d42 => "cifs",
		0x7375_7245 => "coda",
		0x012f_f7b7 => "coh",
		0x6265_6570 => "configfs",
		0x28cd_3d45 => "cramfs",
		0x453d_cd28 => "cramfs-wend",
		0x6462_6720 => "debugfs",
		0x1373 => "devfs",
		0x1cd1 => "devpts",
		0xf15f => "ecryptfs",
		0xde5e_81e4 => "efivarfs",
		0x0041_4a53 => "efs",
		0x5df5 => "exofs",
		0x137d => "ext",
		0xef53 => "ext2/ext3",
		0xef51 => "ext2",
		0xf2f5_2010 => "f2fs",
		0x4006 => "fat",
		0x1983_0326 => "fhgfs",
		0x6573_5546 => "fuseblk",
		0x6573_5543 => "fusectl",
		0x0bad_1dea => "futexfs",
		0x0116_1970 => "gfs/gfs2",
		0x4750_4653 => "gpfs",
		0x4244 => "hfs",
		0x482b => "hfs+",
		0x4858 => "hfsx",
		0x00c0_ffee => "hostfs",
		0xf995_e849 => "hpfs",
		0x9584_58f6 => "hugetlbfs",
		0x1130_7854 => "inodefs",
		0x0131_11a8 => "ibrix",
		0x2bad_1dea => "inotifyfs",
		0x9660 | 0x4004 | 0x4000 => "isofs",
		0x07c0 => "jffs",
		0x72b6 => "jffs2",
		0x3153_464a => "jfs",
		0x6b41_4653 => "k-afs",
		0xc97e_8168 => "logfs",
		0x0bd0_0bd0 => "lustre",
		0x5346_314d => "m1fs",
		0x137f => "minix",
		0x138f => "minix (30 char.)",
		0x2468 => "minix v2",
		0x2478 => "minix v2 (30 char.)",
		0x4d5a => "minix3",
		0x1980_0202 => "mqueue",
		0x4d44 => "msdos",
		0x564c => "novell",
		0x6969 => "nfs",
		0x6e66_7364 => "nfsd",
		0x3434 => "nilfs",
		0x6e73_6673 => "nsfs",
		0x5346_544e => "ntfs",
		0x9fa1 => "openprom",
		0x7461_636f => "ocfs2",
		0x794c_7630 => "overlayfs",
		0xaad7_aaea => "panfs",
		0x5049_5045 => "pipefs",
		0x7c7c_6673 => "prl_fs",
		0x9fa0 => "proc",
		0x6165_676c => "pstorefs",
		0x002f => "qnx4",
		0x6819_1122 => "qnx6",
		0x8584_58f6 => "ramfs",
		0x5265_4973 => "reiserfs",
		0x7275 => "romfs",
		0x6759_6969 => "rpc_pipefs",
		0x7363_6673 => "securityfs",
		0xf97c_ff8c => "selinux",
		0x4341_5d53 => "smackfs",
		0x517b => "smb",
		0xfe53_4d42 => "smb2",
		0xbeef_dead => "snfs",
		0x534f_434b => "sockfs",
		0x7371_7368 => "squashfs",
		0x6265_6572 => "sysfs",
		0x012f_f7b6 => "sysv2",
		0x012f_f7b5 => "sysv4",
		0x0102_1994 => "tmpfs",
		0x7472_6163 => "tracefs",
		0x2405_1905 => "ubifs",
		0x1501_3346 => "udf",
		0x0001_1954 | 0x5419_0100 => "ufs",
		0x9fa2 => "usbdevfs",
		0x0102_1997 => "v9fs",
		0xbacb_acbc => "vmhgfs",
		0xa501_fcf5 => "vxfs",
		0x565a_4653 => "vzfs",
		0x5346_4846 => "wslfs",
		0xabba_1974 => "xenfs",
		0x012f_f7b4 => "xenix",
		0x5846_5342 => "xfs",
		0x012f_d16d => "xia",
		0x2fc1_2fc1 | 0xde => "zfs",
		other => return Cow::Owned(format!("UNKNOWN ({other:#x})")),
	};
	Cow::Borrowed(name)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn parses_canned_proc_mounts_fixture() {
		let fixture =
			b"/dev/root / ext4 rw,relatime 0 0\nserver:/share /mnt/my\\040share nfs4 rw 0 0\n";
		let mounts = parse_linux_mounts(fixture, false);
		assert_eq!(mounts.len(), 2);
		assert_eq!(mounts[0].dev_name, "/dev/root");
		assert_eq!(mounts[0].fs_type, "ext4");
		assert_eq!(mounts[1].mount_dir, OsString::from("/mnt/my share"));
		assert!(mounts[1].remote);
	}

	#[test]
	fn parses_canned_mountinfo_fixture() {
		let fixture = b"36 35 98:0 /root /mnt rw,noatime master:1 - xfs /dev/root rw\n";
		let mounts = parse_linux_mounts(fixture, true);
		assert_eq!(mounts.len(), 1);
		assert_eq!(mounts[0].mount_root, OsString::from("/root"));
		assert_eq!(mounts[0].mount_dir, OsString::from("/mnt"));
		assert_eq!(mounts[0].mount_option, "rw,noatime");
		assert_eq!(mounts[0].fs_type, "xfs");
	}

	#[test]
	fn filesystem_magic_vectors() {
		assert_eq!(pretty_fstype(0xef53), "ext2/ext3");
		assert_eq!(pretty_fstype(0x0102_1994), "tmpfs");
		assert_eq!(pretty_fstype(0x5846_5342), "xfs");
		assert_eq!(pretty_fstype(0x1234), "UNKNOWN (0x1234)");
	}
}
