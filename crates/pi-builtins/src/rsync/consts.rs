//! Protocol constants shared by every rsync module.
//!
//! Names and values follow upstream rsync 3.5.1 (`rsync.h`, `compat.c`,
//! `lib/md-defines.h`, `options.c`) so cross-referencing the protocol is
//! direct. Exit codes live in `exit.rs`, `ATTRS_*` in `meta.rs`.

// ---------------------------------------------------------------------------
// Protocol versions.

/// Protocol version this implementation speaks by default.
pub(crate) const PROTOCOL_VERSION: u32 = 33;
/// Pre-release sub-protocol (always 0 for an official protocol).
pub(crate) const SUBPROTOCOL_VERSION: u32 = 0;
/// Oldest protocol we interoperate with. Upstream's floor is 20; this
/// implementation only supports 29 and newer.
pub(crate) const MIN_PROTOCOL_VERSION: u32 = 29;
/// Newest protocol number accepted from a peer before it is treated as garbage.
pub(crate) const MAX_PROTOCOL_VERSION: u32 = 40;

// ---------------------------------------------------------------------------
// Sizes and limits.

/// Default block size floor for the delta algorithm.
pub(crate) const BLOCK_SIZE: i32 = 700;
/// Largest block size for protocol 30 and newer.
pub(crate) const MAX_BLOCK_SIZE: i32 = 1 << 17;
/// Largest block size accepted from protocols before 30.
pub(crate) const OLD_MAX_BLOCK_SIZE: i32 = 1 << 29;
/// Literal-data chunk size of the token stream.
pub(crate) const CHUNK_SIZE: usize = 32 * 1024;
/// Largest window mapped from a basis file at once.
pub(crate) const MAX_MAP_SIZE: usize = 256 * 1024;
/// Size of the connection I/O buffers.
pub(crate) const IO_BUFFER_SIZE: usize = 32 * 1024;
/// Offset added to a message code in a multiplexed frame header.
pub(crate) const MPLEX_BASE: u8 = 7;
/// Largest payload one multiplexed frame can carry (24-bit length field).
pub(crate) const MAX_FRAME_LEN: usize = 0x00FF_FFFF;

/// Full strong-checksum length of the legacy MD4 sums.
pub(crate) const SUM_LENGTH: usize = 16;
/// Initial (file-list phase) strong-checksum length.
pub(crate) const SHORT_SUM_LENGTH: usize = 2;

/// The platform's `MAXPATHLEN`, upstream's buffer size for every path.
#[cfg(unix)]
pub(crate) const MAXPATHLEN: usize = libc::PATH_MAX as usize;
/// Upstream `MAXPATHLEN` (its Cygwin build uses 4096).
#[cfg(not(unix))]
pub(crate) const MAXPATHLEN: usize = 4096;
/// Roomy line/message buffer size (also the bound on received log messages).
pub(crate) const BIGPATHBUFLEN: usize = if MAXPATHLEN < 4096 { 4096 + 1024 } else { MAXPATHLEN + 1024 };

/// Lower bound on file-list entries the sender stays ahead with inc-recursion.
pub(crate) const MIN_FILECNT_LOOKAHEAD: i32 = 1000;

/// Kinds of alternate basis directory.
pub(crate) const COMPARE_DEST: u8 = 1;
/// `--copy-dest`.
pub(crate) const COPY_DEST: u8 = 2;
/// `--link-dest`.
pub(crate) const LINK_DEST: u8 = 3;

/// Largest nanosecond value accepted from the wire.
pub(crate) const MAX_WIRE_NSEC: i32 = 999_999_999;
/// Per-category cap on deletion statistics received from the wire.
pub(crate) const MAX_WIRE_DEL_STAT: i32 = 1 << 28;

/// `io_error` bits.
pub(crate) const IOERR_GENERAL: i32 = 1 << 0;
/// A source file vanished during the transfer.
pub(crate) const IOERR_VANISHED: i32 = 1 << 1;
/// `--max-delete` stopped deletions.
pub(crate) const IOERR_DEL_LIMIT: i32 = 1 << 2;
/// Bits a peer may set via MSG_IO_ERROR or the file-list trailer.
pub(crate) const IOERR_VALID_MASK: i32 = IOERR_GENERAL | IOERR_VANISHED | IOERR_DEL_LIMIT;

// ---------------------------------------------------------------------------
// File-list transmission flags (XMIT_*).

/// Top-level directory/file named on the command line.
pub(crate) const XMIT_TOP_DIR: u32 = 1 << 0;
/// Mode equals the previous entry's.
pub(crate) const XMIT_SAME_MODE: u32 = 1 << 1;
/// Protocols 28+: a second flag byte follows.
pub(crate) const XMIT_EXTENDED_FLAGS: u32 = 1 << 2;
/// Uid equals the previous entry's.
pub(crate) const XMIT_SAME_UID: u32 = 1 << 3;
/// Gid equals the previous entry's.
pub(crate) const XMIT_SAME_GID: u32 = 1 << 4;
/// Name shares a prefix with the previous entry's.
pub(crate) const XMIT_SAME_NAME: u32 = 1 << 5;
/// Suffix length is an int (or varint) rather than a byte.
pub(crate) const XMIT_LONG_NAME: u32 = 1 << 6;
/// Mtime equals the previous entry's.
pub(crate) const XMIT_SAME_TIME: u32 = 1 << 7;
/// Devices: major number equals the previous entry's.
pub(crate) const XMIT_SAME_RDEV_MAJOR: u32 = 1 << 8;
/// Protocols 30+, directories: no content (implied/non-recursed dir).
pub(crate) const XMIT_NO_CONTENT_DIR: u32 = 1 << 8;
/// Non-directories: hard-linked.
pub(crate) const XMIT_HLINKED: u32 = 1 << 9;
/// Protocols 28–29: dev equals the previous entry's.
#[allow(non_upper_case_globals)]
pub(crate) const XMIT_SAME_DEV_pre30: u32 = 1 << 10;
/// Protocols 30+: user name follows the uid.
pub(crate) const XMIT_USER_NAME_FOLLOWS: u32 = 1 << 10;
/// Protocols 28–29: minor number fits in a byte.
#[allow(non_upper_case_globals)]
pub(crate) const XMIT_RDEV_MINOR_8_pre30: u32 = 1 << 11;
/// Protocols 30+: group name follows the gid.
pub(crate) const XMIT_GROUP_NAME_FOLLOWS: u32 = 1 << 11;
/// Protocols 30+, hard-linked entries: first of its group.
pub(crate) const XMIT_HLINK_FIRST: u32 = 1 << 12;
/// Protocols 31+ (30 with the 'f' compat flag), end marker: io_error follows.
pub(crate) const XMIT_IO_ERROR_ENDLIST: u32 = 1 << 12;
/// Protocols 31+: mtime nanoseconds follow.
pub(crate) const XMIT_MOD_NSEC: u32 = 1 << 13;
/// Atime equals the previous entry's (`--atimes`).
pub(crate) const XMIT_SAME_ATIME: u32 = 1 << 14;
/// Crtime equals mtime (`--crtimes`, varint flags only).
pub(crate) const XMIT_CRTIME_EQ_MTIME: u32 = 1 << 17;

// ---------------------------------------------------------------------------
// In-memory file-entry flags (FLAG_*); several bits are role-overloaded.

/// Sender/receiver/generator: top-level entry.
pub(crate) const FLAG_TOP_DIR: u32 = 1 << 0;
/// Sender/receiver/generator: file was sent.
pub(crate) const FLAG_FILE_SENT: u32 = 1 << 1;
/// Generator: directory was created by us.
pub(crate) const FLAG_DIR_CREATED: u32 = 1 << 1;
/// Directory whose contents are part of the transfer.
pub(crate) const FLAG_CONTENT_DIR: u32 = 1 << 2;
/// Sender/generator, dirs: a mount point (`-x`).
pub(crate) const FLAG_MOUNT_DIR: u32 = 1 << 3;
/// Receiver/generator with FLAG_HLINKED: skip this hard link.
pub(crate) const FLAG_SKIP_HLINK: u32 = 1 << 3;
/// Sender: duplicate entry.
pub(crate) const FLAG_DUPLICATE: u32 = 1 << 4;
/// Generator: directory is missing on the receiver.
pub(crate) const FLAG_MISSING_DIR: u32 = 1 << 4;
/// Receiver/generator: entry is hard-linked.
pub(crate) const FLAG_HLINKED: u32 = 1 << 5;
/// Receiver/generator with FLAG_HLINKED: first of its group.
pub(crate) const FLAG_HLINK_FIRST: u32 = 1 << 6;
/// Directories: implied by a `-R` path, not named.
pub(crate) const FLAG_IMPLIED_DIR: u32 = 1 << 6;
/// Receiver/generator: last of its hard-link group.
pub(crate) const FLAG_HLINK_LAST: u32 = 1 << 7;
/// Receiver/generator: hard-link processing finished.
pub(crate) const FLAG_HLINK_DONE: u32 = 1 << 8;
/// Length needs more than 32 bits.
pub(crate) const FLAG_LENGTH64: u32 = 1 << 9;
/// Receiver/generator: do not apply the group.
pub(crate) const FLAG_SKIP_GROUP: u32 = 1 << 10;
/// Generator: setting the time failed.
pub(crate) const FLAG_TIME_FAILED: u32 = 1 << 11;
/// Entry carries mtime nanoseconds.
pub(crate) const FLAG_MOD_NSEC: u32 = 1 << 12;
/// Directory list only: the directory's file list was received.
pub(crate) const FLAG_GOT_DIR_FLIST: u32 = 1 << 13;
/// Sender (passed, not stored): divert directories to the dir list.
pub(crate) const FLAG_DIVERT_DIRS: u32 = 1 << 16;

// ---------------------------------------------------------------------------
// Itemize flags (ITEM_*); the low 16 bits travel on the wire.

/// Atime differs.
pub(crate) const ITEM_REPORT_ATIME: u32 = 1 << 0;
/// Ctime-style change (unused by the receiver).
pub(crate) const ITEM_REPORT_CHANGE: u32 = 1 << 1;
/// Regular files: size differs.
pub(crate) const ITEM_REPORT_SIZE: u32 = 1 << 2;
/// Symlinks: setting the time failed.
pub(crate) const ITEM_REPORT_TIMEFAIL: u32 = 1 << 2;
/// Mtime differs.
pub(crate) const ITEM_REPORT_TIME: u32 = 1 << 3;
/// Permissions differ.
pub(crate) const ITEM_REPORT_PERMS: u32 = 1 << 4;
/// Owner differs.
pub(crate) const ITEM_REPORT_OWNER: u32 = 1 << 5;
/// Group differs.
pub(crate) const ITEM_REPORT_GROUP: u32 = 1 << 6;
/// ACL differs.
pub(crate) const ITEM_REPORT_ACL: u32 = 1 << 7;
/// Xattrs differ.
pub(crate) const ITEM_REPORT_XATTR: u32 = 1 << 8;
/// Crtime differs.
pub(crate) const ITEM_REPORT_CRTIME: u32 = 1 << 10;
/// A basis-type byte follows on the wire.
pub(crate) const ITEM_BASIS_TYPE_FOLLOWS: u32 = 1 << 11;
/// An extra name (vstring) follows on the wire.
pub(crate) const ITEM_XNAME_FOLLOWS: u32 = 1 << 12;
/// Item is newly created.
pub(crate) const ITEM_IS_NEW: u32 = 1 << 13;
/// Local change (hard link, symlink, delete, …) without a transfer.
pub(crate) const ITEM_LOCAL_CHANGE: u32 = 1 << 14;
/// File data is transferred.
pub(crate) const ITEM_TRANSFER: u32 = 1 << 15;
/// Log-only: data was missing.
pub(crate) const ITEM_MISSING_DATA: u32 = 1 << 16;
/// Log-only: item was deleted.
pub(crate) const ITEM_DELETED: u32 = 1 << 17;
/// Itemize-only: item matched an alt-dest basis.
pub(crate) const ITEM_MATCHED: u32 = 1 << 18;
/// Bits that make an item worth reporting.
pub(crate) const SIGNIFICANT_ITEM_FLAGS: u32 =
	!(ITEM_BASIS_TYPE_FOLLOWS | ITEM_XNAME_FOLLOWS | ITEM_LOCAL_CHANGE);

// ---------------------------------------------------------------------------
// Compatibility flags (CF_*), exchanged as a varint from protocol 30.

/// Incremental recursion.
pub(crate) const CF_INC_RECURSE: u32 = 1 << 0;
/// Symlink times can be preserved.
pub(crate) const CF_SYMLINK_TIMES: u32 = 1 << 1;
/// Symlink targets go through iconv.
pub(crate) const CF_SYMLINK_ICONV: u32 = 1 << 2;
/// Safe file-list handling (io_error in the end marker).
pub(crate) const CF_SAFE_FLIST: u32 = 1 << 3;
/// Do not use the xattr abbreviation optimization.
pub(crate) const CF_AVOID_XATTR_OPTIM: u32 = 1 << 4;
/// Checksum seed is mixed in the fixed order.
pub(crate) const CF_CHKSUM_SEED_FIX: u32 = 1 << 5;
/// `--inplace` combined with `--partial-dir` is understood.
pub(crate) const CF_INPLACE_PARTIAL_DIR: u32 = 1 << 6;
/// File-list flags are sent as varints.
pub(crate) const CF_VARINT_FLIST_FLAGS: u32 = 1 << 7;
/// Uid/gid 0 names are sent.
pub(crate) const CF_ID0_NAMES: u32 = 1 << 8;

// ---------------------------------------------------------------------------
// Multiplexed message codes (enum msgcode).

/// Raw data on the multiplexed stream.
pub(crate) const MSG_DATA: u8 = 0;
/// Remote logging: transfer error.
pub(crate) const MSG_ERROR_XFER: u8 = 1;
/// Remote logging: info.
pub(crate) const MSG_INFO: u8 = 2;
/// Remote logging (protocol 30+): error.
pub(crate) const MSG_ERROR: u8 = 3;
/// Remote logging (protocol 30+): warning.
pub(crate) const MSG_WARNING: u8 = 4;
/// Sibling logging: socket error.
pub(crate) const MSG_ERROR_SOCKET: u8 = 5;
/// Sibling logging: log-file only.
pub(crate) const MSG_LOG: u8 = 6;
/// Sibling logging: client-only output.
pub(crate) const MSG_CLIENT: u8 = 7;
/// Sibling logging: UTF-8 conversion error.
pub(crate) const MSG_ERROR_UTF8: u8 = 8;
/// Reprocess the indicated file-list index.
pub(crate) const MSG_REDO: u8 = 9;
/// Stats data for the generator.
pub(crate) const MSG_STATS: u8 = 10;
/// Block-level stats for the sender (protocol 33).
pub(crate) const MSG_BLOCK_STATS: u8 = 11;
/// The sending side had an I/O error.
pub(crate) const MSG_IO_ERROR: u8 = 22;
/// A daemon's timeout value for the client.
pub(crate) const MSG_IO_TIMEOUT: u8 = 33;
/// Do-nothing message (protocol-30 keepalive).
pub(crate) const MSG_NOOP: u8 = 42;
/// Synchronize an error exit (siblings and protocol 31+).
pub(crate) const MSG_ERROR_EXIT: u8 = 86;
/// The indicated file-list index was updated successfully.
pub(crate) const MSG_SUCCESS: u8 = 100;
/// A file was deleted on the receiving side.
pub(crate) const MSG_DELETED: u8 = 101;
/// The sender failed to open a requested file.
pub(crate) const MSG_NO_SEND: u8 = 102;

/// Whether `code` is a message code upstream understands.
pub(crate) const fn msg_code_is_known(code: u8) -> bool {
	matches!(
		code,
		MSG_DATA
			| MSG_ERROR_XFER
			| MSG_INFO | MSG_ERROR
			| MSG_WARNING
			| MSG_ERROR_SOCKET
			| MSG_LOG | MSG_CLIENT
			| MSG_ERROR_UTF8
			| MSG_REDO | MSG_STATS
			| MSG_BLOCK_STATS
			| MSG_IO_ERROR
			| MSG_IO_TIMEOUT
			| MSG_NOOP | MSG_ERROR_EXIT
			| MSG_SUCCESS
			| MSG_DELETED
			| MSG_NO_SEND
	)
}

/// `maybe_send_keepalive` flags: the keepalive may flush output.
pub(crate) const MSK_ALLOW_FLUSH: u32 = 1 << 0;

// ---------------------------------------------------------------------------
// File-list index values.

/// End of a phase / of the transfer.
pub(crate) const NDX_DONE: i32 = -1;
/// No more incremental file lists.
pub(crate) const NDX_FLIST_EOF: i32 = -2;
/// Deletion statistics follow.
pub(crate) const NDX_DEL_STATS: i32 = -3;
/// Base of the "new file list for directory N" indices (`NDX_FLIST_OFFSET - N`).
pub(crate) const NDX_FLIST_OFFSET: i32 = -101;

// ---------------------------------------------------------------------------
// Basis-file selectors (FNAMECMP_*), sent after ITEM_BASIS_TYPE_FOLLOWS.

/// Last possible alt-dest basis directory index.
pub(crate) const FNAMECMP_BASIS_DIR_HIGH: u8 = 0x7F;
/// The destination file itself.
pub(crate) const FNAMECMP_FNAME: u8 = 0x80;
/// The file in `--partial-dir`.
pub(crate) const FNAMECMP_PARTIAL_DIR: u8 = 0x81;
/// The backup file.
pub(crate) const FNAMECMP_BACKUP: u8 = 0x82;
/// A fuzzy-matched file.
pub(crate) const FNAMECMP_FUZZY: u8 = 0x83;

// ---------------------------------------------------------------------------
// Deletion flags (delete.c).

/// File/dir has our uid but lacks write permission.
pub(crate) const DEL_NO_UID_WRITE: u32 = 1 << 0;
/// Delete a directory's contents recursively.
pub(crate) const DEL_RECURSE: u32 = 1 << 1;
/// Internal: directory is known to be empty.
pub(crate) const DEL_DIR_IS_EMPTY: u32 = 1 << 2;
/// Making room for a replacement file.
pub(crate) const DEL_FOR_FILE: u32 = 1 << 3;
/// Making room for a replacement directory.
pub(crate) const DEL_FOR_DIR: u32 = 1 << 4;
/// Making room for a replacement symlink.
pub(crate) const DEL_FOR_SYMLINK: u32 = 1 << 5;
/// Making room for a replacement device.
pub(crate) const DEL_FOR_DEVICE: u32 = 1 << 6;
/// Making room for a replacement special file.
pub(crate) const DEL_FOR_SPECIAL: u32 = 1 << 7;
/// The delete is part of a backup.
pub(crate) const DEL_FOR_BACKUP: u32 = 1 << 8;
/// Any "making room" reason.
pub(crate) const DEL_MAKE_ROOM: u32 =
	DEL_FOR_FILE | DEL_FOR_DIR | DEL_FOR_SYMLINK | DEL_FOR_DEVICE | DEL_FOR_SPECIAL;

// ---------------------------------------------------------------------------
// Mode bits as they travel on the wire (traditional Unix values, independent
// of the host's `S_IF*`).

/// File-type mask.
pub(crate) const S_IFMT: u32 = 0o170000;
/// Socket.
pub(crate) const S_IFSOCK: u32 = 0o140000;
/// Symbolic link.
pub(crate) const S_IFLNK: u32 = 0o120000;
/// Regular file.
pub(crate) const S_IFREG: u32 = 0o100000;
/// Block device.
pub(crate) const S_IFBLK: u32 = 0o060000;
/// Directory.
pub(crate) const S_IFDIR: u32 = 0o040000;
/// Character device.
pub(crate) const S_IFCHR: u32 = 0o020000;
/// FIFO.
pub(crate) const S_IFIFO: u32 = 0o010000;
/// Set-user-ID bit.
pub(crate) const S_ISUID: u32 = 0o4000;
/// Set-group-ID bit.
pub(crate) const S_ISGID: u32 = 0o2000;
/// Sticky bit.
pub(crate) const S_ISVTX: u32 = 0o1000;
/// The permission bits (upstream `CHMOD_BITS`): setuid, setgid, sticky, rwx×3.
pub(crate) const CHMOD_BITS: u32 = 0o7777;
/// The rwx bits of user, group, and other (upstream `ACCESSPERMS`).
pub(crate) const ACCESSPERMS: u32 = 0o777;

/// Directory?
pub(crate) const fn mode_is_dir(m: u32) -> bool {
	m & S_IFMT == S_IFDIR
}

/// Regular file?
pub(crate) const fn mode_is_reg(m: u32) -> bool {
	m & S_IFMT == S_IFREG
}

/// Symbolic link?
pub(crate) const fn mode_is_lnk(m: u32) -> bool {
	m & S_IFMT == S_IFLNK
}

/// Character device?
pub(crate) const fn mode_is_chr(m: u32) -> bool {
	m & S_IFMT == S_IFCHR
}

/// Block device?
pub(crate) const fn mode_is_blk(m: u32) -> bool {
	m & S_IFMT == S_IFBLK
}

/// FIFO?
pub(crate) const fn mode_is_fifo(m: u32) -> bool {
	m & S_IFMT == S_IFIFO
}

/// Socket?
pub(crate) const fn mode_is_sock(m: u32) -> bool {
	m & S_IFMT == S_IFSOCK
}

/// Character or block device (upstream `IS_DEVICE`).
pub(crate) const fn mode_is_device(m: u32) -> bool {
	mode_is_chr(m) || mode_is_blk(m)
}

/// Socket or FIFO (upstream `IS_SPECIAL`).
pub(crate) const fn mode_is_special(m: u32) -> bool {
	mode_is_sock(m) || mode_is_fifo(m)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn mode_helpers_classify_every_file_type() {
		let cases = [
			(S_IFDIR | 0o755, "dir"),
			(S_IFREG | 0o644, "reg"),
			(S_IFLNK | 0o777, "lnk"),
			(S_IFCHR | 0o600, "chr"),
			(S_IFBLK | 0o600, "blk"),
			(S_IFIFO | 0o600, "fifo"),
			(S_IFSOCK | 0o600, "sock"),
		];
		for (mode, kind) in cases {
			assert_eq!(mode_is_dir(mode), kind == "dir", "{kind}");
			assert_eq!(mode_is_reg(mode), kind == "reg", "{kind}");
			assert_eq!(mode_is_lnk(mode), kind == "lnk", "{kind}");
			assert_eq!(mode_is_device(mode), kind == "chr" || kind == "blk", "{kind}");
			assert_eq!(mode_is_special(mode), kind == "fifo" || kind == "sock", "{kind}");
		}
		// Socket (0o140000) shares bits with directory and regular: no false positives.
		assert!(!mode_is_dir(S_IFSOCK) && !mode_is_reg(S_IFSOCK) && !mode_is_lnk(S_IFSOCK));
		// Block (0o060000) contains the directory and char bits.
		assert!(!mode_is_dir(S_IFBLK) && !mode_is_chr(S_IFBLK));
	}

	#[test]
	fn known_message_codes_match_upstream_dispatch() {
		let known: Vec<u8> = (0..=255u8).filter(|&c| msg_code_is_known(c)).collect();
		assert_eq!(known, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 22, 33, 42, 86, 100, 101, 102]);
	}
}
