//! The file list: [`FileEntry`], its wire codec ([`FlistEncoder`] / [`FlistDecoder`]) for
//! protocols 29–33, and list ordering/cleanup ([`FileList::sort_and_clean`], [`f_name_cmp`]).
//!
//! Wire layout of one entry (after the flags word, see [`FlistEncoder::send_entry`]): the
//! name as a shared-prefix delta against the previous name, then either a hard-link back
//! reference (abbreviated entries) or length, mtime, nsec, crtime, mode, atime, uid(+name),
//! gid(+name), device numbers, symlink target, pre-30 dev/inode, and the `--checksum` sum.
//! Every field that repeats the previous entry's value is elided via a flag bit, so both
//! codecs carry the "previous entry" state for the lifetime of the connection.

use std::cmp::Ordering;
use std::io;
use std::sync::Arc;

use crate::rsync::time::unix_now;
use crate::rsync::consts::{
	CF_SAFE_FLIST, CF_VARINT_FLIST_FLAGS, FLAG_CONTENT_DIR, FLAG_DUPLICATE, FLAG_HLINKED,
	FLAG_IMPLIED_DIR, FLAG_LENGTH64, FLAG_MOD_NSEC, FLAG_SKIP_GROUP, FLAG_TOP_DIR,
	IOERR_VALID_MASK, MAX_WIRE_NSEC, MAXPATHLEN, PROTOCOL_VERSION, S_IFDIR, S_IFREG,
	XMIT_CRTIME_EQ_MTIME, XMIT_EXTENDED_FLAGS, XMIT_GROUP_NAME_FOLLOWS,
	XMIT_HLINK_FIRST, XMIT_HLINKED, XMIT_IO_ERROR_ENDLIST, XMIT_LONG_NAME, XMIT_MOD_NSEC,
	XMIT_NO_CONTENT_DIR, XMIT_RDEV_MINOR_8_pre30, XMIT_SAME_ATIME, XMIT_SAME_DEV_pre30,
	XMIT_SAME_GID, XMIT_SAME_MODE, XMIT_SAME_NAME, XMIT_SAME_RDEV_MAJOR, XMIT_SAME_TIME,
	XMIT_SAME_UID, XMIT_TOP_DIR, XMIT_USER_NAME_FOLLOWS, mode_is_device, mode_is_dir,
	mode_is_lnk, mode_is_reg, mode_is_special,
};
use crate::rsync::exit::{
	RERR_MALLOC, RERR_PROTOCOL, RERR_UNSUPPORTED, RsyncError,
};
use crate::rsync::ids::IdLists;
use crate::rsync::log::{Debug as DebugFlag, LogCode, Logger, Role};
use crate::rsync::paths;
use crate::rsync::wire::{Proto, ReadExt, WriteExt};

/// One file-list entry, as transmitted (receiver side: after id mapping).
///
/// An entry whose `basename` is empty is inactive: a duplicate removed by
/// [`FileList::sort_and_clean`] (its slot keeps the list's indices stable).
#[derive(Clone, Debug, Default)]
pub(crate) struct FileEntry {
	/// Directory part ("" for top-level), shared between siblings. The single byte "/"
	/// marks a top-level name that carried a leading slash on the wire (`--relative` with
	/// an absolute source): it sorts as "/name" and [`FileList::strip_root`] clears it.
	pub dirname: Arc<[u8]>,
	pub basename: Box<[u8]>,
	pub mode: u32,
	pub size: u64,
	pub mtime: i64,
	pub mtime_nsec: u32,
	pub atime: i64,
	pub crtime: i64,
	pub uid: u32,
	pub gid: u32,
	/// Devices: (major, minor). Specials carry none.
	pub rdev: Option<(u32, u32)>,
	/// Symlink target.
	pub link: Option<Box<[u8]>>,
	/// Whole-file checksum (`--checksum`).
	pub sum: Option<Box<[u8]>>,
	/// FLAG_* bits (role-overloaded exactly like upstream).
	pub flags: u32,
	/// Hard-link info: protocol < 30 → dev/ino; ≥ 30 → index of the group leader.
	pub hlink: Hlink,
	/// Indices into the ACL / xattr receive caches (`acl.rs`, `xattr.rs`), if any.
	pub acl: Option<u32>,
	pub def_acl: Option<u32>,
	pub xattr: Option<u32>,
}

/// Hard-link identity of an entry.
///
/// - Sender (input of [`FlistEncoder::send_entry`], output of
///   [`crate::rsync::hlink::HlinkTracker`]): protocol ≥ 30 uses `Leader` for the first
///   member of a group and `Follower(leader_ndx)` for the others; protocol < 30 uses
///   `DevIno`.
/// - Receiver (output of [`FlistDecoder::recv_entry`]): protocol ≥ 30 gives
///   `First(own_ndx)` / `Follower(leader_ndx)` (wire indices); protocol < 30 gives
///   `DevIno`. The encoder accepts `First(_)` like `Leader`.
/// - After [`crate::rsync::hlink::match_hard_links`]: `Linked` for every member.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum Hlink {
	#[default]
	None,
	DevIno(u64, u64),
	Leader,
	Follower(i32),
	/// Receiver: first member of a group; carries its own wire index (the group number).
	First(i32),
	/// Receiver, after matching: group number and the previous member's index (-1 none).
	Linked { gnum: i32, prev: i32 },
}

impl FileEntry {
	/// `dirname/basename` (f_name); empty for an inactive entry.
	pub(crate) fn name(&self) -> Vec<u8> {
		if self.basename.is_empty() {
			return Vec::new();
		}
		let dir: &[u8] = &self.dirname;
		let mut out = Vec::with_capacity(dir.len() + 1 + self.basename.len());
		if dir == b"/" {
			out.push(b'/');
		} else if !dir.is_empty() {
			out.extend_from_slice(dir);
			out.push(b'/');
		}
		out.extend_from_slice(&self.basename);
		out
	}

	pub(crate) fn is_dir(&self) -> bool {
		mode_is_dir(self.mode)
	}

	pub(crate) fn is_reg(&self) -> bool {
		mode_is_reg(self.mode)
	}

	pub(crate) fn is_symlink(&self) -> bool {
		mode_is_lnk(self.mode)
	}

	/// False for a slot cleared as a duplicate (F_IS_ACTIVE).
	pub(crate) fn is_active(&self) -> bool {
		!self.basename.is_empty()
	}

	/// Directory depth as the receiver counts it (F_DEPTH): components of the dirname
	/// plus one, minus one for a "." directory.
	pub(crate) fn depth(&self) -> i32 {
		let depth = count_dir_elements(&self.dirname) + 1;
		if self.is_dir() && &*self.basename == b"." { depth - 1 } else { depth }
	}
}

/// Number of path elements in `p`, ignoring empty and "." elements after a slash.
fn count_dir_elements(p: &[u8]) -> i32 {
	let mut count = 0;
	let mut new_component = true;
	for (i, &c) in p.iter().enumerate() {
		if c == b'/' {
			let next = p.get(i + 1);
			let after = p.get(i + 2);
			new_component = next != Some(&b'.') || after.is_some_and(|&b| b != b'/');
		} else if new_component {
			new_component = false;
			count += 1;
		}
	}
	count
}

/// Encoding-relevant options (built by the session from Options + negotiation).
#[derive(Clone, Debug, Default)]
pub(crate) struct FlistOpts {
	pub preserve_uid: bool,
	pub preserve_gid: bool,
	pub preserve_links: bool,
	pub preserve_devices: bool,
	pub preserve_specials: bool,
	pub preserve_hard_links: bool,
	pub preserve_atimes: bool,
	pub preserve_crtimes: bool,
	pub preserve_acls: bool,
	pub preserve_xattrs: bool,
	pub always_checksum: bool,
	pub checksum_len: usize,
	pub numeric_ids: bool,
	pub inc_recurse: bool,
	pub relative_paths: bool,
	pub am_root: bool,
	pub max_alloc: u64,
	/// `-r` (protocol 29 receivers derive content-dir flags from it).
	pub recurse: bool,
	/// `--delete-missing-args`: a mode-0 entry is a deletion request, not a bad mode.
	pub delete_missing_args: bool,
	/// `--copy-devices` on the receiver: a device entry becomes a regular file.
	pub copy_devices: bool,
	/// Receiver `--chmod`, applied to every non-symlink mode as it is received.
	pub chmod: Option<crate::rsync::chmod::ChmodRules>,
}

fn varint_flags(proto: Proto) -> bool {
	proto.version >= 30 && proto.has(CF_VARINT_FLIST_FLAGS)
}

fn safe_flist(proto: Proto) -> bool {
	proto.version >= 31 || (proto.version >= 30 && proto.has(CF_SAFE_FLIST))
}

fn debug_on(logger: Option<&Logger>, flag: DebugFlag, level: u8) -> bool {
	logger.is_some_and(|l| l.levels().debug(flag) >= level)
}

/// Sender half of the file-list codec (send_file_entry and the end marker).
pub(crate) struct FlistEncoder {
	proto: Proto,
	opts: FlistOpts,
	/// Index of the first entry of the list being sent (hard-link abbreviation boundary).
	first_ndx: i32,
	last_name: Vec<u8>,
	mode: u32,
	mtime: i64,
	atime: i64,
	rdev_major: u32,
	uid: u32,
	gid: u32,
	dev: u64,
	logger: Option<Logger>,
}

impl FlistEncoder {
	pub(crate) fn new(proto: Proto, opts: FlistOpts) -> Self {
		Self {
			proto,
			opts,
			first_ndx: 0,
			last_name: Vec::new(),
			mode: 0,
			mtime: 0,
			atime: 0,
			rdev_major: 0,
			uid: 0,
			gid: 0,
			dev: 0,
			logger: None,
		}
	}

	/// Enables `--debug=hlink` output.
	pub(crate) fn set_logger(&mut self, logger: Logger) {
		self.logger = Some(logger);
	}

	/// Starts a new list whose first entry has index `ndx_start` (0 for the only list
	/// without incremental recursion; 1, then `prev.ndx_start + prev.len + 1`, with it).
	/// The "previous entry" state carries over, as on the wire.
	pub(crate) fn start_list(&mut self, ndx_start: i32) {
		self.first_ndx = ndx_start;
	}

	/// send_file_entry. `ndx` is the entry's global index (list start + position).
	/// ACL/xattr data is sent by the caller right after (upstream order).
	pub(crate) fn send_entry(
		&mut self,
		w: &mut dyn io::Write,
		e: &FileEntry,
		ndx: i32,
		ids: &mut IdLists,
	) -> io::Result<()> {
		let proto = self.proto;
		let v = proto.version;
		let o = &self.opts;
		ids.configure(proto, o);
		let mode = e.mode;
		let is_dir = mode_is_dir(mode);

		let mut xflags = if !is_dir {
			0
		} else if v >= 30 {
			if e.flags & FLAG_CONTENT_DIR != 0 {
				e.flags & FLAG_TOP_DIR
			} else if e.flags & FLAG_IMPLIED_DIR != 0 {
				XMIT_TOP_DIR | XMIT_NO_CONTENT_DIR
			} else {
				XMIT_NO_CONTENT_DIR
			}
		} else {
			e.flags & FLAG_TOP_DIR
		};

		if mode == self.mode {
			xflags |= XMIT_SAME_MODE;
		} else {
			self.mode = mode;
		}

		let device = o.preserve_devices && mode_is_device(mode);
		let special_rdev = !device && o.preserve_specials && mode_is_special(mode) && v < 31;
		let mut rdev = (0u32, 0u32);
		if device {
			rdev = e.rdev.unwrap_or((0, 0));
			if rdev.0 == self.rdev_major {
				xflags |= XMIT_SAME_RDEV_MAJOR;
			} else {
				self.rdev_major = rdev.0;
			}
			if v < 30 && rdev.1 <= 0xFF {
				xflags |= XMIT_RDEV_MINOR_8_pre30;
			}
		} else if special_rdev {
			rdev = (self.rdev_major, 0);
			xflags |= XMIT_SAME_RDEV_MAJOR;
			if v < 30 {
				xflags |= XMIT_RDEV_MINOR_8_pre30;
			}
		}

		let mut user_name = None;
		if !o.preserve_uid || (e.uid == self.uid && !self.last_name.is_empty()) {
			xflags |= XMIT_SAME_UID;
		} else {
			self.uid = e.uid;
			if !o.numeric_ids {
				user_name = ids.add_uid(e.uid);
				if o.inc_recurse && user_name.is_some() {
					xflags |= XMIT_USER_NAME_FOLLOWS;
				}
			}
		}
		let mut group_name = None;
		if !o.preserve_gid || (e.gid == self.gid && !self.last_name.is_empty()) {
			xflags |= XMIT_SAME_GID;
		} else {
			self.gid = e.gid;
			if !o.numeric_ids {
				group_name = ids.add_gid(e.gid);
				if o.inc_recurse && group_name.is_some() {
					xflags |= XMIT_GROUP_NAME_FOLLOWS;
				}
			}
		}

		if e.mtime == self.mtime {
			xflags |= XMIT_SAME_TIME;
		} else {
			self.mtime = e.mtime;
		}
		if v >= 31 && (e.flags & FLAG_MOD_NSEC != 0 || e.mtime_nsec != 0) {
			xflags |= XMIT_MOD_NSEC;
		}
		if o.preserve_atimes && !is_dir {
			if e.atime == self.atime {
				xflags |= XMIT_SAME_ATIME;
			} else {
				self.atime = e.atime;
			}
		}
		if o.preserve_crtimes && e.crtime == self.mtime {
			xflags |= XMIT_CRTIME_EQ_MTIME;
		}

		let mut abbrev_to: Option<i32> = None;
		let mut dev_ino: Option<u64> = None;
		if o.preserve_hard_links {
			match e.hlink {
				Hlink::Leader | Hlink::First(_) if v >= 30 => {
					xflags |= XMIT_HLINKED | XMIT_HLINK_FIRST;
				}
				Hlink::Follower(first) if v >= 30 => {
					xflags |= XMIT_HLINKED;
					abbrev_to = Some(first);
					if let Some(logger) = &self.logger
						&& logger.levels().debug(DebugFlag::Hlink) >= 1
					{
						let text = format!(
							"[{}] #{} hard-links #{} ({}abbrev)\n",
							logger.role().name(),
							ndx,
							first,
							if first >= self.first_ndx { "" } else { "un" }
						);
						logger.rprintf(LogCode::Info, text.as_bytes());
					}
				}
				Hlink::DevIno(dev, ino) if v < 30 => {
					if dev == self.dev {
						xflags |= XMIT_SAME_DEV_pre30;
					} else {
						self.dev = dev;
					}
					xflags |= XMIT_HLINKED;
					dev_ino = Some(ino);
				}
				_ => {}
			}
		}

		let fname = e.name();
		let l1 = fname
			.iter()
			.zip(self.last_name.iter())
			.take(255)
			.take_while(|(a, b)| a == b)
			.count();
		let l2 = fname.len() - l1;
		if l1 > 0 {
			xflags |= XMIT_SAME_NAME;
		}
		if l2 > 255 {
			xflags |= XMIT_LONG_NAME;
		}

		// A zero flags value would read as the end of the list.
		if varint_flags(proto) {
			w.write_varint(if xflags != 0 { xflags as i32 } else { XMIT_EXTENDED_FLAGS as i32 })?;
		} else {
			if xflags == 0 && !is_dir {
				xflags |= XMIT_TOP_DIR;
			}
			if xflags & 0xFF00 != 0 || xflags == 0 {
				xflags |= XMIT_EXTENDED_FLAGS;
				w.write_shortint(xflags as u16)?;
			} else {
				w.write_u8(xflags as u8)?;
			}
		}
		if xflags & XMIT_SAME_NAME != 0 {
			w.write_u8(l1 as u8)?;
		}
		if xflags & XMIT_LONG_NAME != 0 {
			w.write_varint30(proto, l2 as i32)?;
		} else {
			w.write_u8(l2 as u8)?;
		}
		w.write_all(&fname[l1..])?;

		if let Some(first) = abbrev_to {
			w.write_varint(first)?;
			if first >= self.first_ndx {
				self.last_name = fname;
				return Ok(());
			}
		}

		w.write_varlong30(proto, e.size as i64, 3)?;
		if xflags & XMIT_SAME_TIME == 0 {
			if v >= 30 {
				w.write_varlong(e.mtime, 4)?;
			} else {
				w.write_int(e.mtime as i32)?;
			}
		}
		if xflags & XMIT_MOD_NSEC != 0 {
			w.write_varint(e.mtime_nsec as i32)?;
		}
		if o.preserve_crtimes && xflags & XMIT_CRTIME_EQ_MTIME == 0 {
			w.write_varlong(e.crtime, 4)?;
		}
		if xflags & XMIT_SAME_MODE == 0 {
			w.write_int(mode as i32)?;
		}
		if o.preserve_atimes && !is_dir && xflags & XMIT_SAME_ATIME == 0 {
			w.write_varlong(e.atime, 4)?;
		}
		if o.preserve_uid && xflags & XMIT_SAME_UID == 0 {
			if v < 30 {
				w.write_int(e.uid as i32)?;
			} else {
				w.write_varint(e.uid as i32)?;
				if xflags & XMIT_USER_NAME_FOLLOWS != 0 {
					write_short_name(w, user_name.as_deref().unwrap_or(b""))?;
				}
			}
		}
		if o.preserve_gid && xflags & XMIT_SAME_GID == 0 {
			if v < 30 {
				w.write_int(e.gid as i32)?;
			} else {
				w.write_varint(e.gid as i32)?;
				if xflags & XMIT_GROUP_NAME_FOLLOWS != 0 {
					write_short_name(w, group_name.as_deref().unwrap_or(b""))?;
				}
			}
		}
		if device || special_rdev {
			if xflags & XMIT_SAME_RDEV_MAJOR == 0 {
				w.write_varint30(proto, rdev.0 as i32)?;
			}
			if v >= 30 {
				w.write_varint(rdev.1 as i32)?;
			} else if xflags & XMIT_RDEV_MINOR_8_pre30 != 0 {
				w.write_u8(rdev.1 as u8)?;
			} else {
				w.write_int(rdev.1 as i32)?;
			}
		}
		if o.preserve_links
			&& mode_is_lnk(mode)
			&& let Some(link) = e.link.as_deref()
			&& !link.is_empty()
		{
			w.write_varint30(proto, link.len() as i32)?;
			w.write_all(link)?;
		}
		if let Some(ino) = dev_ino {
			// Pre-30 dev numbers travel 1-incremented so they are never zero.
			if xflags & XMIT_SAME_DEV_pre30 == 0 {
				w.write_longint(self.dev.wrapping_add(1) as i64)?;
			}
			w.write_longint(ino as i64)?;
		}
		if o.always_checksum && mode_is_reg(mode) {
			let len = o.checksum_len;
			let sum = e.sum.as_deref().unwrap_or(&[]);
			let take = sum.len().min(len);
			w.write_all(&sum[..take])?;
			if take < len {
				w.write_all(&vec![0u8; len - take])?;
			}
		}
		self.last_name = fname;
		Ok(())
	}

	/// End-of-list marker. `io_error` (already 0 when `--ignore-errors`) travels with the
	/// marker when the protocol allows it (varint flags, or the safe-flist marker); otherwise
	/// the caller reports it separately ([`FlistEncoder::send_io_error_int`] before protocol
	/// 30, MSG_IO_ERROR after).
	pub(crate) fn send_end(&mut self, w: &mut dyn io::Write, io_error: i32) -> io::Result<()> {
		if varint_flags(self.proto) {
			w.write_varint(0)?;
			w.write_varint(io_error)
		} else if io_error != 0 && safe_flist(self.proto) {
			w.write_shortint((XMIT_EXTENDED_FLAGS | XMIT_IO_ERROR_ENDLIST) as u16)?;
			w.write_varint(io_error)
		} else {
			w.write_u8(0)
		}
	}

	/// Protocol < 30: the io_error int sent after the id lists.
	pub(crate) fn send_io_error_int(&mut self, w: &mut dyn io::Write, io_error: i32) -> io::Result<()> {
		w.write_int(io_error)
	}
}

/// Length byte + bytes; names longer than 255 bytes are cut (they cannot be represented).
fn write_short_name(w: &mut dyn io::Write, name: &[u8]) -> io::Result<()> {
	let name = &name[..name.len().min(255)];
	w.write_u8(name.len() as u8)?;
	w.write_all(name)
}

/// Receiver-side name policing supplied by the session (filters are owned elsewhere).
#[derive(Default)]
pub(crate) struct RecvChecks {
	/// `!trust_sender_filter` with server filter rules: returns true when the name is
	/// excluded ("ERROR: rejecting excluded file-list name").
	pub excluded: Option<Box<dyn FnMut(&[u8], bool) -> bool + Send>>,
	/// The implied-filter list (names the client asked for): returns true when the name
	/// is explicitly included ("ERROR: rejecting unrequested file-list name" otherwise).
	pub requested: Option<Box<dyn FnMut(&[u8], bool) -> bool + Send>>,
	/// With an implied-filter list: is this directory only an implied parent of a
	/// requested name? Such entries are forced to non-content directories.
	pub implied_parent: Option<Box<dyn FnMut(&[u8]) -> bool + Send>>,
}

/// What a hard-link follower may copy from its leader in the same list.
#[derive(Clone, Debug, Default)]
struct Received {
	size: i64,
	mtime: i64,
	nsec: u32,
	mode: u32,
	atime: i64,
	crtime: i64,
	uid: u32,
	gid: u32,
	rdev: Option<(u32, u32)>,
	link: Option<Box<[u8]>>,
	sum: Option<Box<[u8]>>,
}

/// Receiver half of the file-list codec (recv_file_entry and the end marker).
pub(crate) struct FlistDecoder {
	proto: Proto,
	opts: FlistOpts,
	ndx_start: i32,
	received: Vec<Received>,
	last_name: Vec<u8>,
	last_dir: Arc<[u8]>,
	mode: u32,
	mtime: i64,
	atime: i64,
	crtime: i64,
	rdev_major: u32,
	uid: u32,
	gid: u32,
	gid_flags: u32,
	dev: i64,
	in_del_hier: bool,
	del_hier_name_len: usize,
	io_error: i32,
	checks: RecvChecks,
	logger: Option<Logger>,
}

impl FlistDecoder {
	pub(crate) fn new(proto: Proto, opts: FlistOpts) -> Self {
		Self {
			proto,
			opts,
			ndx_start: 0,
			received: Vec::new(),
			last_name: Vec::new(),
			last_dir: Arc::default(),
			mode: 0,
			mtime: 0,
			atime: 0,
			crtime: 0,
			rdev_major: 0,
			uid: 0,
			gid: 0,
			gid_flags: 0,
			dev: 0,
			in_del_hier: false,
			del_hier_name_len: 0,
			io_error: 0,
			checks: RecvChecks::default(),
			logger: None,
		}
	}

	/// Logger for diagnostics and `--debug=hlink/filter` output; its role names the side in
	/// messages (`[receiver]`, `[generator]`).
	pub(crate) fn set_logger(&mut self, logger: Logger) {
		self.logger = Some(logger);
	}

	/// Installs the receiver's filter-based name checks.
	pub(crate) fn set_checks(&mut self, checks: RecvChecks) {
		self.checks = checks;
	}

	/// Starts a new list whose first entry gets index `ndx_start`.
	pub(crate) fn start_list(&mut self, ndx_start: i32) {
		self.ndx_start = ndx_start;
		self.received.clear();
	}

	/// Next entry, or None at the end marker (whose io_error is then in `io_error()`).
	pub(crate) fn recv_entry(
		&mut self,
		r: &mut dyn io::Read,
		ids: &mut IdLists,
	) -> Result<Option<FileEntry>, RsyncError> {
		ids.configure(self.proto, &self.opts);
		match self.recv_flags(r)? {
			None => Ok(None),
			Some(xflags) => self.recv_body(r, ids, xflags).map(Some),
		}
	}

	/// io_error bits accumulated from end markers (and [`FlistDecoder::recv_io_error_int`]),
	/// masked to the valid bits. Applying `--ignore-errors` is the caller's job.
	pub(crate) fn io_error(&self) -> i32 {
		self.io_error
	}

	/// Protocol < 30: reads the io_error int that follows the id lists.
	pub(crate) fn recv_io_error_int(&mut self, r: &mut dyn io::Read) -> Result<i32, RsyncError> {
		let err = r.read_int().map_err(RsyncError::from_stream)? & IOERR_VALID_MASK;
		self.io_error |= err;
		Ok(err)
	}

	fn who(&self) -> &'static str {
		self.logger.as_ref().map_or(Role::Receiver, Logger::role).name()
	}

	fn log(&self, code: LogCode, text: &[u8]) {
		if let Some(logger) = &self.logger {
			logger.rprintf(code, text);
		}
	}

	fn overflow(&self, line: u32) -> RsyncError {
		RsyncError::new(
			RERR_MALLOC,
			format!(
				"[{}] buffer overflow: recv_file_entry (file=flist.c, line={line})",
				self.who()
			),
		)
		.at("util2.c", 129)
	}

	fn recv_flags(&mut self, r: &mut dyn io::Read) -> Result<Option<u32>, RsyncError> {
		if varint_flags(self.proto) {
			let flags = r.read_varint().map_err(RsyncError::from_stream)? as u32;
			if flags == 0 {
				let err = r.read_varint().map_err(RsyncError::from_stream)?;
				self.io_error |= err & IOERR_VALID_MASK;
				return Ok(None);
			}
			return Ok(Some(flags));
		}
		let mut flags = u32::from(r.read_u8().map_err(RsyncError::from_stream)?);
		if flags == 0 {
			return Ok(None);
		}
		if flags & XMIT_EXTENDED_FLAGS != 0 {
			flags |= u32::from(r.read_u8().map_err(RsyncError::from_stream)?) << 8;
		}
		if flags == XMIT_EXTENDED_FLAGS | XMIT_IO_ERROR_ENDLIST {
			if !safe_flist(self.proto) {
				return Err(RsyncError::new(RERR_PROTOCOL, format!("Invalid flist flag: {flags:x}"))
					.at("flist.c", 3207));
			}
			let err = r.read_varint().map_err(RsyncError::from_stream)?;
			self.io_error |= err & IOERR_VALID_MASK;
			return Ok(None);
		}
		Ok(Some(flags))
	}

	fn intern_dir(&mut self, dir: &[u8]) -> Arc<[u8]> {
		if &*self.last_dir != dir {
			self.last_dir = Arc::from(dir);
		}
		Arc::clone(&self.last_dir)
	}

	fn recv_body(
		&mut self,
		r: &mut dyn io::Read,
		ids: &mut IdLists,
		mut xflags: u32,
	) -> Result<FileEntry, RsyncError> {
		let proto = self.proto;
		let v = proto.version;
		let max_path = MAXPATHLEN;

		// Name: shared prefix with the previous name + new suffix.
		let l1 = if xflags & XMIT_SAME_NAME != 0 {
			usize::from(r.read_u8().map_err(RsyncError::from_stream)?)
		} else {
			0
		};
		let l2 = if xflags & XMIT_LONG_NAME != 0 {
			r.read_varint30(proto).map_err(RsyncError::from_stream)? as u32
		} else {
			u32::from(r.read_u8().map_err(RsyncError::from_stream)?)
		};
		if l2 as usize >= max_path - l1 || l1 > self.last_name.len() {
			let text = format!(
				"overflow: xflags=0x{xflags:x} l1={l1} l2={} lastname={} [{}]\n",
				l2 as i32,
				String::from_utf8_lossy(&self.last_name),
				self.who()
			);
			self.log(LogCode::Error, text.as_bytes());
			return Err(self.overflow(1048));
		}
		let mut name = Vec::with_capacity(l1 + l2 as usize);
		name.extend_from_slice(&self.last_name[..l1]);
		name.extend_from_slice(&r.read_bytes(l2 as usize, max_path).map_err(RsyncError::from_stream)?);
		if let Some(nul) = name.iter().position(|&b| b == 0) {
			name.truncate(nul);
		}
		self.last_name.clone_from(&name);

		// Absolute names (without --relative) and ".." elements abort the transfer; the
		// accepted name continues cleaned ("//" and "./" collapsed).
		name = paths::check_received_name(&name, self.opts.relative_paths)?;
		let (dir, base) = paths::split_name_rooted(&name);
		let dirname: Arc<[u8]> = if dir.is_empty() { Arc::default() } else { self.intern_dir(dir) };
		let basename: Box<[u8]> = base.into();

		// Protocol 30+: a hard-link follower may be abbreviated to a back reference.
		let mut first_hlink: Option<i32> = None;
		let mut copy_from: Option<usize> = None;
		if v >= 30 && xflags & XMIT_HLINKED != 0 && xflags & XMIT_HLINK_FIRST == 0 {
			let first = r.read_varint().map_err(RsyncError::from_stream)?;
			let limit = self.ndx_start + self.received.len() as i32;
			if first < 0 || first >= limit {
				return Err(RsyncError::new(
					RERR_PROTOCOL,
					format!("hard-link reference out of range: {first} ({limit})"),
				)
				.at("flist.c", 1106));
			}
			if debug_on(self.logger.as_ref(), DebugFlag::Hlink, 1) {
				let text = format!(
					"[{}] #{} hard-links #{} ({}abbrev)\n",
					self.who(),
					limit,
					first,
					if first >= self.ndx_start { "" } else { "un" }
				);
				self.log(LogCode::Info, text.as_bytes());
			}
			first_hlink = Some(first);
			if first >= self.ndx_start {
				copy_from = Some((first - self.ndx_start) as usize);
			}
		}

		let o = &self.opts;
		let mut size: i64;
		let nsec: u32;
		let mut rdev: Option<(u32, u32)> = None;
		let mut link: Option<Box<[u8]>> = None;
		let mut link_len: Option<usize> = None;
		let real_reg: bool;

		if let Some(src) = copy_from.and_then(|i| self.received.get(i)).cloned() {
			size = src.size;
			self.mtime = src.mtime;
			nsec = src.nsec;
			self.mode = src.mode;
			let mode = self.mode;
			if o.preserve_atimes && !mode_is_dir(mode) {
				self.atime = src.atime;
			}
			if o.preserve_crtimes {
				self.crtime = src.crtime;
			}
			if o.preserve_uid {
				self.uid = src.uid;
			}
			if o.preserve_gid {
				self.gid = src.gid;
			}
			if mode_is_device(mode) {
				if o.preserve_devices {
					let dev = src.rdev.unwrap_or((0, 0));
					self.rdev_major = dev.0;
					rdev = Some(dev);
				} else {
					rdev = Some((0, 0));
				}
			}
			if mode_is_lnk(mode) {
				link = Some(if o.preserve_links { src.link.unwrap_or_default() } else { Box::default() });
			}
			real_reg = mode_is_reg(mode);
		} else {
			size = r.read_varlong30(proto, 3).map_err(RsyncError::from_stream)?;
			if xflags & XMIT_SAME_TIME == 0 {
				self.mtime = if v >= 30 {
					r.read_varlong(4).map_err(RsyncError::from_stream)?
				} else {
					i64::from(r.read_uint().map_err(RsyncError::from_stream)?)
				};
			}
			nsec = if xflags & XMIT_MOD_NSEC != 0 {
				let value = r.read_varint().map_err(RsyncError::from_stream)?;
				if !(0..=MAX_WIRE_NSEC).contains(&value) {
					return Err(RsyncError::new(
						RERR_PROTOCOL,
						format!(
							"wire value modtime_nsec out of range: {value} not in [0,{MAX_WIRE_NSEC}] [{}]",
							self.who()
						),
					)
					.at("io.c", 2118));
				}
				value as u32
			} else {
				0
			};
			if o.preserve_crtimes {
				self.crtime = if xflags & XMIT_CRTIME_EQ_MTIME != 0 {
					self.mtime
				} else {
					r.read_varlong(4).map_err(RsyncError::from_stream)?
				};
			}
			if xflags & XMIT_SAME_MODE == 0 {
				let mode = r.read_int().map_err(RsyncError::from_stream)? as u32;
				let known = mode_is_reg(mode)
					|| mode_is_dir(mode)
					|| mode_is_lnk(mode)
					|| mode_is_device(mode)
					|| mode_is_special(mode);
				if (mode != 0 || !o.delete_missing_args) && !known {
					return Err(RsyncError::new(
						RERR_PROTOCOL,
						format!(
							"invalid file mode 0{mode:o} for {} [{}]",
							String::from_utf8_lossy(&self.last_name),
							self.who()
						),
					)
					.at("flist.c", 1206));
				}
				self.mode = mode;
			}
			if o.preserve_atimes && !mode_is_dir(self.mode) && xflags & XMIT_SAME_ATIME == 0 {
				self.atime = r.read_varlong(4).map_err(RsyncError::from_stream)?;
			}
			if let Some(rules) = &o.chmod
				&& !mode_is_lnk(self.mode)
				&& self.mode != 0
			{
				self.mode = rules.apply(self.mode);
			}

			if o.preserve_uid && xflags & XMIT_SAME_UID == 0 {
				if v < 30 {
					self.uid = r.read_int().map_err(RsyncError::from_stream)? as u32;
				} else {
					let remote = r.read_varint().map_err(RsyncError::from_stream)? as u32;
					// An inline name registers the remote id's mapping in `ids`.
					self.uid = if xflags & XMIT_USER_NAME_FOLLOWS != 0 {
						ids.recv_user_name(r, remote)?
					} else if o.inc_recurse && o.am_root && (!o.numeric_ids || ids.has_usermap()) {
						ids.match_uid(remote)
					} else {
						remote
					};
				}
			}
			if o.preserve_gid && xflags & XMIT_SAME_GID == 0 {
				if v < 30 {
					self.gid = r.read_int().map_err(RsyncError::from_stream)? as u32;
				} else {
					let remote = r.read_varint().map_err(RsyncError::from_stream)? as u32;
					self.gid_flags = 0;
					self.gid = if xflags & XMIT_GROUP_NAME_FOLLOWS != 0 {
						let (local, skip) = ids.recv_group_name_flags(r, remote)?;
						if skip {
							self.gid_flags |= FLAG_SKIP_GROUP;
						}
						local
					} else if o.inc_recurse && (!o.am_root || !o.numeric_ids || ids.has_groupmap()) {
						let (local, skip) = ids.match_gid_flags(remote);
						if skip {
							self.gid_flags |= FLAG_SKIP_GROUP;
						}
						local
					} else {
						remote
					};
				}
			}

			let mode = self.mode;
			if (o.preserve_devices && mode_is_device(mode))
				|| (o.preserve_specials && mode_is_special(mode) && v < 31)
			{
				if xflags & XMIT_SAME_RDEV_MAJOR == 0 {
					self.rdev_major = r.read_varint30(proto).map_err(RsyncError::from_stream)? as u32;
				}
				let minor = if v >= 30 {
					r.read_varint().map_err(RsyncError::from_stream)? as u32
				} else if xflags & XMIT_RDEV_MINOR_8_pre30 != 0 {
					u32::from(r.read_u8().map_err(RsyncError::from_stream)?)
				} else {
					r.read_int().map_err(RsyncError::from_stream)? as u32
				};
				if mode_is_device(mode) {
					rdev = Some((self.rdev_major, minor));
				}
				size = 0;
			} else if mode_is_device(mode) {
				rdev = Some((0, 0));
				size = 0;
			}

			if o.preserve_links && mode_is_lnk(mode) {
				let len = i64::from(r.read_varint30(proto).map_err(RsyncError::from_stream)?) + 1;
				if len <= 0 || len > MAXPATHLEN as i64 {
					let text = format!("overflow: linkname_len={}\n", len - 1);
					self.log(LogCode::Error, text.as_bytes());
					return Err(self.overflow(1286));
				}
				link_len = Some((len - 1) as usize);
			} else if mode_is_lnk(mode) {
				link = Some(Box::default());
			}

			if self.opts.copy_devices && mode_is_device(mode) {
				self.mode = S_IFREG | (mode & 0o777);
				self.mtime = unix_now();
				rdev = None;
				real_reg = false;
			} else {
				real_reg = mode_is_reg(mode);
			}
		}
		let mode = self.mode;
		let is_dir = mode_is_dir(mode);

		if size < 0 {
			return Err(RsyncError::new(RERR_UNSUPPORTED, "Offset underflow: file-length is negative")
				.at("flist.c", 1349));
		}
		let root_dot = name == b"." || name == b"/.";
		if root_dot && !is_dir {
			return Err(RsyncError::new(
				RERR_PROTOCOL,
				format!("ERROR: rejecting non-directory transfer-root entry: {}", String::from_utf8_lossy(&name)),
			)
			.at("flist.c", 1358));
		}
		if !root_dot {
			if let Some(excluded) = &mut self.checks.excluded
				&& excluded(name.as_slice(), is_dir)
			{
				return Err(RsyncError::new(
					RERR_UNSUPPORTED,
					format!("ERROR: rejecting excluded file-list name: {}", String::from_utf8_lossy(&name)),
				)
				.at("flist.c", 1366));
			}
			if let Some(requested) = &mut self.checks.requested
				&& !requested(name.as_slice(), is_dir)
			{
				return Err(RsyncError::new(
					RERR_UNSUPPORTED,
					format!("ERROR: rejecting unrequested file-list name: {}", String::from_utf8_lossy(&name)),
				)
				.at("flist.c", 1370));
			}
		}

		let o = &self.opts;
		let mut flags = 0u32;
		if o.preserve_hard_links && xflags & XMIT_HLINKED != 0 && !is_dir {
			flags |= FLAG_HLINKED;
		}
		if nsec != 0 {
			flags |= FLAG_MOD_NSEC;
		}
		if size > 0xFFFF_FFFF && mode_is_reg(mode) {
			flags |= FLAG_LENGTH64;
		}
		if o.preserve_gid {
			flags |= self.gid_flags;
		}

		if is_dir {
			let implied_parent = match &mut self.checks.implied_parent {
				Some(f) => f(name.as_slice()),
				None => false,
			};
			if v >= 30 {
				let honest = XMIT_NO_CONTENT_DIR | XMIT_TOP_DIR;
				if implied_parent && xflags & honest != honest {
					if debug_on(self.logger.as_ref(), DebugFlag::Filter, 1) {
						let mut text = format!("[{}] receiver downgraded implied-parent dir ", self.who())
							.into_bytes();
						text.extend_from_slice(&name);
						text.extend_from_slice(
							format!(" to non-content (sender xflags=0x{xflags:x})\n").as_bytes(),
						);
						self.log(LogCode::Info, &text);
					}
					xflags |= honest;
				}
				if xflags & XMIT_NO_CONTENT_DIR == 0 {
					if xflags & XMIT_TOP_DIR != 0 {
						flags |= FLAG_TOP_DIR;
					}
					flags |= FLAG_CONTENT_DIR;
				} else if xflags & XMIT_TOP_DIR != 0 {
					flags |= FLAG_IMPLIED_DIR;
				}
			} else if xflags & XMIT_TOP_DIR != 0 {
				if implied_parent {
					flags |= FLAG_IMPLIED_DIR;
				} else {
					self.in_del_hier = self.opts.recurse;
					let mut depth = count_dir_elements(&dirname) + 1;
					if &*basename == b"." {
						depth -= 1;
					}
					let mut len = if depth == 0 { 0 } else { l1 + l2 as usize };
					if self.opts.relative_paths
						&& len > 2 && self.last_name.get(len - 1) == Some(&b'.')
						&& self.last_name.get(len - 2) == Some(&b'/')
					{
						len -= 2;
					}
					self.del_hier_name_len = len;
					flags |= FLAG_TOP_DIR | FLAG_CONTENT_DIR;
				}
			} else if self.in_del_hier {
				let len = self.del_hier_name_len;
				if !self.opts.relative_paths
					|| len == 0 || (l1 >= len && self.last_name.get(len) == Some(&b'/'))
				{
					flags |= FLAG_CONTENT_DIR;
				} else {
					self.in_del_hier = false;
				}
			}
		}

		if let Some(len) = link_len {
			let mut target = r.read_bytes(len, max_path).map_err(RsyncError::from_stream)?;
			if let Some(nul) = target.iter().position(|&b| b == 0) {
				target.truncate(nul);
			}
			link = Some(target.into_boxed_slice());
		}

		let o = &self.opts;
		let mut hlink = Hlink::None;
		if o.preserve_hard_links && xflags & XMIT_HLINKED != 0 {
			let value = if v >= 30 {
				if xflags & XMIT_HLINK_FIRST != 0 {
					Hlink::First(self.ndx_start + self.received.len() as i32)
				} else {
					Hlink::Follower(first_hlink.unwrap_or(0))
				}
			} else {
				if xflags & XMIT_SAME_DEV_pre30 == 0 {
					self.dev = r.read_longint().map_err(RsyncError::from_stream)?;
				}
				let ino = r.read_longint().map_err(RsyncError::from_stream)?;
				Hlink::DevIno((self.dev as u64).wrapping_sub(1), ino as u64)
			};
			if flags & FLAG_HLINKED != 0 {
				hlink = value;
			}
		}

		let sum = if o.always_checksum && real_reg {
			let len = o.checksum_len;
			let bytes = match copy_from.and_then(|i| self.received.get(i)) {
				Some(src) => {
					let mut s = src.sum.as_deref().unwrap_or(&[]).to_vec();
					s.resize(len, 0);
					s
				}
				None => r.read_bytes(len, len).map_err(RsyncError::from_stream)?,
			};
			Some(bytes.into_boxed_slice())
		} else {
			None
		};

		let entry = FileEntry {
			dirname,
			basename,
			mode,
			size: size as u64,
			mtime: self.mtime,
			mtime_nsec: nsec,
			atime: if o.preserve_atimes && !is_dir { self.atime } else { 0 },
			crtime: if o.preserve_crtimes { self.crtime } else { 0 },
			uid: if o.preserve_uid { self.uid } else { 0 },
			gid: if o.preserve_gid { self.gid } else { 0 },
			rdev,
			link,
			sum,
			flags,
			hlink,
			acl: None,
			def_acl: None,
			xattr: None,
		};
		self.received.push(Received {
			size,
			mtime: entry.mtime,
			nsec,
			mode,
			atime: entry.atime,
			crtime: entry.crtime,
			uid: entry.uid,
			gid: entry.gid,
			rdev: entry.rdev,
			link: entry.link.clone(),
			sum: entry.sum.clone(),
		});
		Ok(entry)
	}
}

/// One file list (the whole list, or one inc-recursion segment).
#[derive(Default)]
pub(crate) struct FileList {
	pub entries: Vec<FileEntry>,
	pub ndx_start: i32,
	pub parent_ndx: i32,
}

/// Knobs of [`FileList::sort_and_clean_with`] beyond the receiver defaults.
pub(crate) struct CleanOpts<'a> {
	pub proto: Proto,
	/// Strip leading slashes from dirnames after sorting (`--relative` receivers).
	pub strip_root: bool,
	/// The sender keeps duplicates (marking repeated dirs FLAG_DUPLICATE under
	/// inc-recursion) instead of removing them.
	pub am_sender: bool,
	pub inc_recurse: bool,
	/// `--prune-empty-dirs` (receiver): returns true when a directory name is excluded by
	/// the filter rules (such directories are kept).
	pub prune_empty_dirs: Option<&'a mut dyn FnMut(&[u8]) -> bool>,
}

impl FileList {
	/// Receiver defaults of [`FileList::sort_and_clean_with`] (test fixtures).
	#[cfg(test)]
	pub(crate) fn sort_and_clean(&mut self, proto: Proto, strip_root: bool, logger: &Logger) {
		self.sort_and_clean_with(
			CleanOpts { proto, strip_root, am_sender: false, inc_recurse: false, prune_empty_dirs: None },
			logger,
		);
	}

	/// flist_sort_and_clean with every upstream variable spelled out.
	pub(crate) fn sort_and_clean_with(&mut self, opts: CleanOpts<'_>, logger: &Logger) {
		if self.entries.is_empty() {
			return;
		}
		let proto = opts.proto;
		self.entries.sort_by(|a, b| f_name_cmp(a, b, proto));
		let depths: Vec<i32> = if opts.prune_empty_dirs.is_some() && !opts.am_sender {
			self.entries.iter().map(FileEntry::depth).collect()
		} else {
			Vec::new()
		};
		if !opts.am_sender || opts.inc_recurse {
			self.remove_duplicates(proto, opts.am_sender, logger);
		}
		if opts.strip_root {
			self.strip_root();
		}
		if let Some(excluded) = opts.prune_empty_dirs
			&& !opts.am_sender
		{
			self.prune_empty_dirs(depths, excluded);
		}
	}

	fn remove_duplicates(&mut self, proto: Proto, am_sender: bool, logger: &Logger) {
		let n = self.entries.len();
		let Some(start) = self.entries.iter().position(FileEntry::is_active) else {
			return;
		};
		let mut low = start;
		let mut prev = start;
		for i in start + 1..n {
			if !self.entries[i].is_active() {
				continue;
			}
			let found = if f_name_cmp(&self.entries[i], &self.entries[prev], proto) == Ordering::Equal {
				Some(prev)
			} else if proto.version >= 29 && self.entries[i].is_dir() {
				// Does this directory duplicate an earlier non-directory?
				let probe = FileEntry {
					dirname: Arc::clone(&self.entries[i].dirname),
					basename: self.entries[i].basename.clone(),
					mode: S_IFREG,
					..FileEntry::default()
				};
				self.search(&probe, low, prev, proto)
			} else {
				None
			};
			let Some(j) = found else {
				prev = i;
				continue;
			};
			let (keep, drop) = if self.entries[i].is_dir() {
				if !self.entries[j].is_dir() {
					(i, j)
				} else {
					if am_sender {
						self.entries[i].flags |= FLAG_DUPLICATE;
					} else {
						let dup_flags = self.entries[i].flags;
						let kept = &mut self.entries[j].flags;
						*kept |= dup_flags & (FLAG_TOP_DIR | FLAG_CONTENT_DIR);
						*kept &= dup_flags | !FLAG_IMPLIED_DIR;
					}
					(j, i)
				}
			} else {
				(j, i)
			};
			if !am_sender {
				if logger.levels().debug(DebugFlag::Dup) >= 1 {
					let mut text = b"removing duplicate name ".to_vec();
					text.extend_from_slice(&self.entries[i].name());
					text.extend_from_slice(
						format!(" from file list ({})\n", drop as i32 + self.ndx_start).as_bytes(),
					);
					logger.rprintf(LogCode::Info, &text);
				}
				self.entries[drop] = FileEntry::default();
			}
			if keep == i {
				if low == drop {
					low = (drop + 1..i).find(|&k| self.entries[k].is_active()).unwrap_or(i);
				}
				prev = i;
			}
		}
	}

	/// Binary search for `probe` among the active entries in `low..=high` (flist_find).
	fn search(&self, probe: &FileEntry, low: usize, high: usize, proto: Proto) -> Option<usize> {
		let (mut lo, mut hi) = (low as isize, high as isize);
		while lo <= hi {
			let mid = lo.midpoint(hi);
			let Some(up) = (mid..=hi).find(|&k| self.entries[k as usize].is_active()) else {
				hi = mid - 1;
				continue;
			};
			let found = &self.entries[up as usize];
			match f_name_cmp(found, probe, proto) {
				Ordering::Equal => {
					if proto.version < 29 && found.is_dir() != probe.is_dir() {
						return None;
					}
					return Some(up as usize);
				}
				Ordering::Less => lo = up + 1,
				Ordering::Greater => hi = mid - 1,
			}
		}
		None
	}

	/// Removes leading slashes from every dirname (done after sorting, for `--relative`).
	pub(crate) fn strip_root(&mut self) {
		let mut last: Option<(Arc<[u8]>, Arc<[u8]>)> = None;
		for e in &mut self.entries {
			if !e.dirname.starts_with(b"/") {
				continue;
			}
			if let Some((from, to)) = &last
				&& Arc::ptr_eq(from, &e.dirname)
			{
				e.dirname = Arc::clone(to);
				continue;
			}
			let stripped: Arc<[u8]> = Arc::from(e.dirname.iter().skip_while(|&&b| b == b'/').copied().collect::<Vec<u8>>());
			last = Some((Arc::clone(&e.dirname), Arc::clone(&stripped)));
			e.dirname = stripped;
		}
	}

	/// `--prune-empty-dirs`: clears directories that end up with no non-directory content,
	/// unless the filter rules exclude them (which keeps them and their parents).
	fn prune_empty_dirs(&mut self, mut depth: Vec<i32>, excluded: &mut dyn FnMut(&[u8]) -> bool) {
		let Some(low) = self.entries.iter().position(FileEntry::is_active) else {
			return;
		};
		let high = self.entries.iter().rposition(FileEntry::is_active).unwrap_or(low);
		// A directory pending pruning stores -(index of the previous pending dir) - 1 in its
		// depth slot, forming a chain back to the last kept directory.
		let mut prev = 0usize;
		let mut prev_depth = 0i32;
		for i in low..=high {
			let is_dir = self.entries[i].is_active() && self.entries[i].is_dir();
			if is_dir && depth[i] != 0 {
				let mut j = prev_depth;
				while j >= depth[i] {
					if depth[prev] >= 0 {
						break;
					}
					let up = (-depth[prev] - 1) as usize;
					self.entries[prev] = FileEntry::default();
					prev = up;
					j -= 1;
				}
				prev_depth = depth[i];
				if excluded(self.entries[i].name().as_slice()) {
					let mut j = prev_depth - 1;
					while depth[prev] < 0 {
						let up = (-depth[prev] - 1) as usize;
						depth[prev] = j;
						prev = up;
						j -= 1;
					}
				} else {
					depth[i] = -(prev as i32) - 1;
				}
				prev = i;
			} else {
				let mut j = prev_depth;
				while depth[prev] < 0 {
					let up = (-depth[prev] - 1) as usize;
					depth[prev] = j;
					prev = up;
					j -= 1;
				}
			}
		}
		while depth[prev] < 0 {
			let up = (-depth[prev] - 1) as usize;
			self.entries[prev] = FileEntry::default();
			prev = up;
		}
	}

	/// Binary search by name (flist_find): a non-directory of that name if present, else a
	/// directory.
	pub(crate) fn find(&self, name: &[u8]) -> Option<usize> {
		self.find_name(name, None)
	}

	/// flist_find_name: `want_dir` Some(true)/Some(false) requires that directory-ness,
	/// None prefers a non-directory but accepts a directory.
	pub(crate) fn find_name(&self, name: &[u8], want_dir: Option<bool>) -> Option<usize> {
		let (dir, base) = paths::split_name_rooted(name);
		let mut probe = FileEntry { dirname: Arc::from(dir), basename: base.into(), ..FileEntry::default() };
		probe.mode = if want_dir == Some(true) { S_IFDIR } else { S_IFREG };
		let found = self.find_entry(&probe);
		if found.is_some() || want_dir.is_some() {
			return found;
		}
		probe.mode = S_IFDIR;
		self.find_entry(&probe)
	}

	/// flist_find: the active entry that compares equal to `f` (directory-ness included).
	pub(crate) fn find_entry(&self, f: &FileEntry) -> Option<usize> {
		let low = self.entries.iter().position(FileEntry::is_active)?;
		let high = self.entries.iter().rposition(FileEntry::is_active)?;
		let proto = Proto { version: PROTOCOL_VERSION, compat: 0 };
		self.search(f, low, high, proto)
	}
}

/// How the name walk in [`compare_names`] treats the current piece.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Piece {
	Dir,
	Slash,
	Base,
	Trailing,
}

/// A cursor over the virtual string an entry sorts as: `dirname "/" basename`, plus a
/// trailing "/" for directories (protocol ≥ 29), with "." directories sorting first.
struct NameWalk<'a> {
	entry: &'a FileEntry,
	piece: Piece,
	/// True while this side still sorts as a path (directory) rather than an item.
	path: bool,
	text: &'a [u8],
	pos: usize,
	dirs_are_paths: bool,
}

impl<'a> NameWalk<'a> {
	fn new(entry: &'a FileEntry, with_dir: bool, dirs_are_paths: bool) -> Self {
		let mut walk =
			NameWalk { entry, piece: Piece::Dir, path: dirs_are_paths, text: b"", pos: 0, dirs_are_paths };
		if with_dir && !entry.dirname.is_empty() {
			walk.text = if &*entry.dirname == b"/" { b"" } else { &entry.dirname };
		} else {
			walk.enter_base();
		}
		walk
	}

	fn enter_base(&mut self) {
		self.pos = 0;
		self.path = self.dirs_are_paths && self.entry.is_dir();
		if self.path && &*self.entry.basename == b"." {
			self.path = false;
			self.piece = Piece::Trailing;
			self.text = b"";
		} else {
			self.piece = Piece::Base;
			self.text = &self.entry.basename;
		}
	}

	fn cur(&self) -> u8 {
		self.text.get(self.pos).copied().unwrap_or(0)
	}

	/// Moves past an exhausted piece; true once the whole name has ended.
	fn advance(&mut self) -> bool {
		match self.piece {
			Piece::Dir => {
				self.piece = Piece::Slash;
				self.text = b"/";
				self.pos = 0;
				false
			}
			Piece::Slash => {
				self.enter_base();
				false
			}
			Piece::Base if self.path => {
				self.piece = Piece::Trailing;
				self.text = b"/";
				self.pos = 0;
				false
			}
			Piece::Base | Piece::Trailing => {
				self.piece = Piece::Trailing;
				self.path = false;
				true
			}
		}
	}
}

/// Returns the ordering and whether `b`'s whole name was a path-element prefix of `a`'s.
fn compare_names(a: &FileEntry, b: &FileEntry, proto: Proto) -> (Ordering, bool) {
	match (a.is_active(), b.is_active()) {
		(false, false) => return (Ordering::Equal, false),
		(false, true) => return (Ordering::Less, false),
		(true, false) => return (Ordering::Greater, false),
		(true, true) => {}
	}
	let dirs_are_paths = proto.version >= 29;
	let same_dir = a.dirname == b.dirname;
	let mut x = NameWalk::new(a, !same_dir, dirs_are_paths);
	let mut y = NameWalk::new(b, !same_dir, dirs_are_paths);
	let by_kind = |x: &NameWalk<'_>| if x.path { Ordering::Greater } else { Ordering::Less };
	if x.path != y.path {
		return (by_kind(&x), false);
	}
	let mut prefix = false;
	loop {
		if x.cur() == 0 {
			x.advance();
			if y.cur() != 0 && x.path != y.path {
				return (by_kind(&x), prefix);
			}
		}
		if y.cur() == 0 {
			if y.advance() {
				prefix = true;
				if x.cur() == 0 {
					return (Ordering::Equal, prefix);
				}
			}
			if x.path != y.path {
				return (by_kind(&x), prefix);
			}
		}
		let (c1, c2) = (x.cur(), y.cur());
		x.pos += 1;
		y.pos += 1;
		if c1 != c2 {
			return (c1.cmp(&c2), prefix);
		}
	}
}

/// Upstream's file-list order: like comparing the joined names bytewise, except that
/// (protocol ≥ 29) directories compare as if suffixed with "/", a directory sorts after
/// every non-directory at the same level, and a "." directory sorts before everything.
/// Inactive entries sort first.
pub(crate) fn f_name_cmp(a: &FileEntry, b: &FileEntry, proto: Proto) -> Ordering {
	compare_names(a, b, proto).0
}

/// f_name_has_prefix: is `b`'s name a whole-element prefix of `a`'s (e.g. "/p/foobar" for
/// "/p/foobar/baz", but not "/p/foo")?
pub(crate) fn f_name_has_prefix(a: &FileEntry, b: &FileEntry, proto: Proto) -> bool {
	compare_names(a, b, proto).1
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rsync::consts::{
		CF_INC_RECURSE, S_IFBLK, S_IFCHR, S_IFIFO, S_IFLNK, S_IFMT, S_IFSOCK,
	};
	use crate::rsync::log::{LogConfig, OutLevels};
	use std::sync::Mutex;

	#[derive(Clone, Default)]
	struct Capture(Arc<Mutex<Vec<u8>>>);

	impl io::Write for Capture {
		fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
			self.0.lock().unwrap().extend_from_slice(buf);
			Ok(buf.len())
		}
		fn flush(&mut self) -> io::Result<()> {
			Ok(())
		}
	}

	fn logger_with(debug: &str) -> (Logger, Capture) {
		let out = Capture::default();
		let mut levels = OutLevels::default();
		if !debug.is_empty() {
			levels.apply_debug(debug).unwrap();
		}
		let cfg = LogConfig { levels, ..LogConfig::default() };
		let logger = Logger::local(Box::new(out.clone()), Box::new(out.clone()), cfg);
		(logger, out)
	}

	fn entry(name: &str, mode: u32) -> FileEntry {
		let name = name.as_bytes();
		let (dirname, basename) = paths::split_name(name);
		FileEntry { dirname: dirname.into(), basename: basename.into(), mode, ..FileEntry::default() }
	}

	fn names(list: &FileList) -> Vec<String> {
		list.entries.iter().map(|e| String::from_utf8_lossy_owned(e.name())).collect()
	}

	// ---- golden bytes captured from rsync 3.5.1 (`--server --sender`, -naH --numeric-ids) ----

	enum Part {
		Hex(&'static str),
		Run(u8, usize),
	}

	fn bytes(parts: &[Part]) -> Vec<u8> {
		let mut out = Vec::new();
		for p in parts {
			match p {
				Part::Hex(h) => {
					for i in (0..h.len()).step_by(2) {
						out.push(u8::from_str_radix(&h[i..i + 2], 16).unwrap());
					}
				}
				Part::Run(b, n) => out.extend(std::iter::repeat_n(*b, *n)),
			}
		}
		out
	}

	const GOLDEN_33: &[Part] = &[
		Part::Hex("01012e00c00165156f93ed41000081f5009298026832000200a4810000809a03626967c100f2052a"),
		Part::Hex("8098c8"),
		Part::Run(0x64, 200),
		Part::Hex("006000ed410000809a016100600080b801022e62000500a4810000809a046e6e6e6e000100809803"),
		Part::Hex("737562008000ed4100001803612d62000100f8f0f1ffffffffffffa481000018046c696e6b000300"),
		Part::Hex("65156f93eda1000003612e62a01804736f636b0000006abd87e2f0aa396635edc100008218026831"),
		Part::Hex("01a018046669666f0000006abd87e2f0de4b5733a4110000588191"),
		Part::Run(0x64, 200),
		Part::Hex("2f"),
		Part::Run(0x65, 200),
		Part::Hex("00010065156f93a4810000809a07612f696e6e6572000300829a067375622f68330180b804046465"),
		Part::Hex("6570008000ed41000080b808022f66000400a481000080b8090372656c000900eda10000092e2e2f"),
		Part::Hex("2e2e2f612e620000"),
	];

	const GOLDEN_29: &[Part] = &[
		Part::Hex("01012ec0010000156f9365ed410000f5010000000000009c0202683202000000a481000014000001"),
		Part::Hex("2f6304229a03626967ffffffff00f2052a0100000098c8"),
		Part::Run(0x64, 200),
		Part::Hex("60000000ed4100009a016160000000b801022e6205000000a48100009a046e6e6e6e010000009803"),
		Part::Hex("73756280000000ed4100001803612d6201000000f0f1ffffa481000018046c696e6b03000000156f"),
		Part::Hex("9365eda1000003000000612e621c0904736f636b00000000bd87e26aedc10000001c060268310200"),
		Part::Hex("0000156f9365a48100002f6304221c09046669666f00000000bd87e26aa4110000005891010000"),
		Part::Run(0x64, 200),
		Part::Hex("2f"),
		Part::Run(0x65, 200),
		Part::Hex("01000000156f9365a48100009a07612f696e6e6572030000009e06067375622f6833020000002f63"),
		Part::Hex("0422b804046465657080000000ed410000b808022f6604000000a4810000b8090372656c09000000"),
		Part::Hex("eda10000090000002e2e2f2e2e2f612e620000000000"),
	];

	const GOLDEN_33_CSUM: &[Part] = &[
		Part::Hex("01012e00c00165156f93ed41000081f5009298026832000200a481000002b2b0d8855edb10114269"),
		Part::Hex("71a014d45e809a03626967c100f2052a61a872d27c97d180861569581f9428378098c8"),
		Part::Run(0x64, 200),
		Part::Hex("006000ed410000809a016100600080b801022e62000500a48100001838525eaacf79c77f3e1b07ad"),
		Part::Hex("c1e9b5809a046e6e6e6e0001000a8bae24670faacb5a8783351bd211c3809803737562008000ed41"),
		Part::Hex("00001803612d62000100f8f0f1ffffffffffffa481000011cdb280646cf0eaeeee22ecc001745c18"),
		Part::Hex("046c696e6b00030065156f93eda1000003612e62a01804736f636b0000006abd87e2f0aa396635ed"),
		Part::Hex("c10000821802683101a018046669666f0000006abd87e2f0de4b5733a4110000588191"),
		Part::Run(0x64, 200),
		Part::Hex("2f"),
		Part::Run(0x65, 200),
		Part::Hex("00010065156f93a481000096b3f0cf706638f2d7aaf5fd789e5a77809a07612f696e6e6572000300"),
		Part::Hex("50392f89945faf7885613a73b65ab006829a067375622f68330180b8040464656570008000ed4100"),
		Part::Hex("0080b808022f66000400a4810000a598144d177f962f0882594746f4570a80b8090372656c000900"),
		Part::Hex("eda10000092e2e2f2e2e2f612e620000"),
	];

	const GOLDEN_33_INC: &[Part] = &[
		Part::Hex("01012e00c00165156f93ed41000081f5009298026832000200a4810000809a03626967c100f2052a"),
		Part::Hex("8098c8"),
		Part::Run(0x64, 200),
		Part::Hex("006000ed410000809a016100600080b801022e62000500a4810000809a046e6e6e6e000100809803"),
		Part::Hex("737562008000ed4100001803612d62000100f8f0f1ffffffffffffa481000018046c696e6b000300"),
		Part::Hex("65156f93eda1000003612e62a01804736f636b0000006abd87e2f0aa396635edc100008218026831"),
		Part::Hex("02a018046669666f0000006abd87e2f0de4b5733a41100000000"),
	];

	/// The options of `rsync -naH --numeric-ids` (plus -c for the checksum capture).
	fn archive_opts(inc: bool, checksum: bool) -> FlistOpts {
		FlistOpts {
			preserve_uid: true,
			preserve_gid: true,
			preserve_links: true,
			preserve_devices: true,
			preserve_specials: true,
			preserve_hard_links: true,
			numeric_ids: true,
			inc_recurse: inc,
			recurse: true,
			always_checksum: checksum,
			checksum_len: if checksum { 16 } else { 0 },
			..FlistOpts::default()
		}
	}

	/// Decodes a captured list, then re-encodes the entries and expects identical bytes.
	fn golden_round_trip(parts: &[Part], p: Proto, opts: FlistOpts, ndx_start: i32) -> Vec<FileEntry> {
		let wire = bytes(parts);
		let mut dec = FlistDecoder::new(p, opts.clone());
		dec.start_list(ndx_start);
		let mut ids = IdLists::new(p, &opts);
		let mut r = &wire[..];
		let mut entries = Vec::new();
		while let Some(e) = dec.recv_entry(&mut r, &mut ids).unwrap() {
			entries.push(e);
		}
		if p.version < 30 {
			assert_eq!(dec.recv_io_error_int(&mut r).unwrap(), 0);
		}
		assert!(r.is_empty(), "{} trailing bytes", r.len());
		assert_eq!(dec.io_error(), 0);

		let mut enc = FlistEncoder::new(p, opts.clone());
		enc.start_list(ndx_start);
		let mut tx_ids = IdLists::new(p, &opts);
		let mut out = Vec::new();
		for (i, e) in entries.iter().enumerate() {
			enc.send_entry(&mut out, e, ndx_start + i as i32, &mut tx_ids).unwrap();
		}
		enc.send_end(&mut out, 0).unwrap();
		if p.version < 30 {
			enc.send_io_error_int(&mut out, 0).unwrap();
		}
		assert_eq!(out, wire);
		entries
	}

	fn find<'a>(entries: &'a [FileEntry], name: &str) -> &'a FileEntry {
		entries.iter().find(|e| e.name() == name.as_bytes()).unwrap()
	}

	#[test]
	fn golden_protocol_33() {
		let entries = golden_round_trip(GOLDEN_33, Proto::new(33, 0x1fe), archive_opts(false, false), 0);
		assert_eq!(entries.len(), 19);
		assert_eq!(&*entries[0].basename, b".");
		assert!(entries[0].is_dir());
		assert_eq!(entries[0].flags & FLAG_TOP_DIR, FLAG_TOP_DIR);
		assert_eq!(entries[0].uid, 501);
		let h2 = find(&entries, "h2");
		assert_eq!(h2.hlink, Hlink::First(1));
		assert_eq!(h2.flags & FLAG_HLINKED, FLAG_HLINKED);
		let h1 = find(&entries, "h1");
		assert_eq!(h1.hlink, Hlink::Follower(1));
		assert_eq!((h1.size, h1.mode), (2, 0o100644));
		let big = find(&entries, "big");
		assert_eq!(big.size, 5_000_000_000);
		assert_eq!(big.flags & FLAG_LENGTH64, FLAG_LENGTH64);
		assert_eq!(find(&entries, "a-b").mtime, -3600);
		assert_eq!(find(&entries, "link").link.as_deref(), Some(&b"a.b"[..]));
		let fifo = find(&entries, "fifo");
		assert_eq!(fifo.mode, S_IFIFO | 0o644);
		assert_eq!(fifo.mtime_nsec, 861_359_070);
		assert_eq!(fifo.rdev, None);
		assert_eq!(find(&entries, "sock").mode & S_IFMT, S_IFSOCK);
		let long = format!("{}/{}", "d".repeat(200), "e".repeat(200));
		assert_eq!(find(&entries, &long).size, 1);
		assert_eq!(&*find(&entries, "sub/deep/rel").dirname, b"sub/deep");
	}

	#[test]
	fn golden_protocol_29() {
		let entries = golden_round_trip(GOLDEN_29, Proto::new(29, 0), archive_opts(false, false), 0);
		assert_eq!(entries.len(), 19);
		let h2 = find(&entries, "h2");
		let h3 = find(&entries, "sub/h3");
		let Hlink::DevIno(dev, ino) = h2.hlink else { panic!("h2: {:?}", h2.hlink) };
		assert_eq!(h3.hlink, Hlink::DevIno(dev, ino));
		assert_eq!((dev, ino), (16_777_235, 570_712_879));
		// Protocol 29 carries no nanoseconds and still sends rdev for specials.
		assert_eq!(find(&entries, "fifo").mtime_nsec, 0);
	}

	#[test]
	fn golden_checksums() {
		let entries = golden_round_trip(GOLDEN_33_CSUM, Proto::new(33, 0x1fe), archive_opts(false, true), 0);
		let f = find(&entries, "sub/deep/f");
		assert_eq!(
			f.sum.as_deref(),
			Some(&[0xa5, 0x98, 0x14, 0x4d, 0x17, 0x7f, 0x96, 0x2f, 0x08, 0x82, 0x59, 0x47, 0x46, 0xf4, 0x57, 0x0a][..])
		);
		assert!(find(&entries, "a").sum.is_none());
		// The abbreviated follower copies its leader's sum.
		assert_eq!(find(&entries, "h1").sum, find(&entries, "h2").sum);
	}

	#[test]
	fn golden_incremental_first_segment() {
		let entries =
			golden_round_trip(GOLDEN_33_INC, Proto::new(33, 0x1ff), archive_opts(true, false), 1);
		assert_eq!(entries.len(), 13);
		assert_eq!(find(&entries, "h2").hlink, Hlink::First(2));
		assert_eq!(find(&entries, "h1").hlink, Hlink::Follower(2));
		// Directories of the first segment are content dirs (expanded by later segments).
		assert_eq!(find(&entries, "sub").flags & FLAG_CONTENT_DIR, FLAG_CONTENT_DIR);
	}

	// ---- encode/decode round trips across protocols ----

	fn sample_entries(v: u32) -> Vec<FileEntry> {
		let mut out = Vec::new();
		let mut dir = entry(".", S_IFDIR | 0o755);
		dir.flags = FLAG_TOP_DIR | FLAG_CONTENT_DIR;
		dir.mtime = 1_700_000_000;
		out.push(dir);
		let mut f = entry("file", S_IFREG | 0o644);
		f.size = 12345;
		f.mtime = 1_700_000_001;
		f.mtime_nsec = if v >= 31 { 123_456_789 } else { 0 };
		f.atime = 1_700_000_100;
		f.crtime = 1_600_000_000;
		f.uid = 0;
		f.gid = 0;
		f.sum = Some(vec![7u8; 16].into_boxed_slice());
		out.push(f);
		// Before protocol 30 mtimes travel as unsigned 32-bit values.
		let early = if v >= 30 { -5 } else { 5 };
		let mut big = entry("sub/big", S_IFREG | 0o600);
		big.size = 1 << 40;
		big.mtime = early;
		big.atime = -6;
		big.crtime = early;
		big.uid = 4_000_000_000;
		big.gid = 77;
		big.sum = Some(vec![9u8; 16].into_boxed_slice());
		out.push(big);
		let mut sub = entry("sub", S_IFDIR | 0o700);
		sub.flags = FLAG_CONTENT_DIR;
		sub.mtime = early;
		sub.crtime = 3;
		out.push(sub);
		let mut implied = entry("sub/implied", S_IFDIR | 0o755);
		implied.flags = FLAG_IMPLIED_DIR;
		out.push(implied);
		let mut link = entry("sub/link", S_IFLNK | 0o777);
		link.link = Some(b"../file".to_vec().into_boxed_slice());
		link.size = 7;
		out.push(link);
		let mut chr = entry("dev/null", S_IFCHR | 0o666);
		chr.rdev = Some((3, 2));
		out.push(chr);
		let mut blk = entry("dev/disk", S_IFBLK | 0o660);
		blk.rdev = Some((3, 70_000));
		out.push(blk);
		let mut blk2 = entry("dev/disk2", S_IFBLK | 0o660);
		blk2.rdev = Some((8, 1));
		out.push(blk2);
		out.push(entry("dev/fifo", S_IFIFO | 0o644));
		out.push(entry("dev/sock", S_IFSOCK | 0o755));
		let long_name = format!("{}/{}", "x".repeat(150), "y".repeat(300));
		let mut long = entry(&long_name, S_IFREG | 0o644);
		long.size = 3;
		long.sum = Some(vec![1u8; 16].into_boxed_slice());
		out.push(long);
		// Hard links: leader + follower in this list.
		let mut h1 = entry("h1", S_IFREG | 0o644);
		h1.size = 2;
		h1.mtime = 42;
		h1.sum = Some(vec![5u8; 16].into_boxed_slice());
		let mut h2 = h1.clone();
		h2.basename = b"h2".to_vec().into_boxed_slice();
		if v >= 30 {
			h1.hlink = Hlink::Leader;
			h2.hlink = Hlink::Follower(-1); // patched below with the leader's index
		} else {
			h1.hlink = Hlink::DevIno(5, 99);
			h2.hlink = Hlink::DevIno(5, 99);
		}
		h1.flags |= FLAG_HLINKED;
		h2.flags |= FLAG_HLINKED;
		out.push(h1);
		out.push(h2);
		let mut tail = entry("zzz", S_IFREG | 0o644);
		tail.mtime = 42;
		out.push(tail);
		out
	}

	struct Combo {
		inc: bool,
		checksum: bool,
		atimes: bool,
		crtimes: bool,
		ids: bool,
	}

	fn combo_opts(c: &Combo) -> FlistOpts {
		FlistOpts {
			preserve_uid: c.ids,
			preserve_gid: c.ids,
			preserve_links: true,
			preserve_devices: true,
			preserve_specials: true,
			preserve_hard_links: true,
			preserve_atimes: c.atimes,
			preserve_crtimes: c.crtimes,
			always_checksum: c.checksum,
			checksum_len: 16,
			numeric_ids: !c.ids,
			inc_recurse: c.inc,
			recurse: true,
			..FlistOpts::default()
		}
	}

	fn round_trip(p: Proto, c: &Combo) {
		let opts = combo_opts(c);
		let ndx_start = if c.inc { 1 } else { 0 };
		let mut entries = sample_entries(p.version);
		let leader = entries.iter().position(|e| &*e.basename == b"h1").unwrap() as i32 + ndx_start;
		for e in &mut entries {
			if e.hlink == Hlink::Follower(-1) {
				e.hlink = Hlink::Follower(leader);
			}
		}
		let mut enc = FlistEncoder::new(p, opts.clone());
		enc.start_list(ndx_start);
		let mut tx_ids = IdLists::new(p, &opts);
		let mut wire = Vec::new();
		for (i, e) in entries.iter().enumerate() {
			enc.send_entry(&mut wire, e, ndx_start + i as i32, &mut tx_ids).unwrap();
		}
		enc.send_end(&mut wire, 0).unwrap();
		if !c.inc {
			tx_ids.send_lists(&mut wire, p, &opts).unwrap();
		}
		if p.version < 30 {
			enc.send_io_error_int(&mut wire, 0).unwrap();
		}

		let mut dec = FlistDecoder::new(p, opts.clone());
		dec.start_list(ndx_start);
		let mut rx_ids = IdLists::new(p, &opts);
		let mut r = &wire[..];
		let mut got = Vec::new();
		while let Some(e) = dec.recv_entry(&mut r, &mut rx_ids).unwrap() {
			got.push(e);
		}
		if !c.inc {
			rx_ids.recv_lists(&mut r, p, &opts).unwrap();
		}
		if p.version < 30 {
			dec.recv_io_error_int(&mut r).unwrap();
		}
		assert!(r.is_empty(), "v{} trailing bytes", p.version);
		assert_eq!(got.len(), entries.len());

		let ctx = format!("v{} inc={} csum={} atimes={} crtimes={} ids={}", p.version, c.inc, c.checksum, c.atimes, c.crtimes, c.ids);
		for (i, (want, have)) in entries.iter().zip(&got).enumerate() {
			assert_eq!(want.name(), have.name(), "{ctx}");
			assert_eq!(want.mode, have.mode, "{ctx} {i}");
			let size = if mode_is_device(want.mode) || mode_is_special(want.mode) { 0 } else { want.size };
			assert_eq!(size, have.size, "{ctx} {i}");
			assert_eq!(want.mtime, have.mtime, "{ctx} {i}");
			assert_eq!(want.mtime_nsec, have.mtime_nsec, "{ctx} {i}");
			if c.atimes && !want.is_dir() {
				assert_eq!(want.atime, have.atime, "{ctx} {i}");
			}
			if c.crtimes {
				assert_eq!(want.crtime, have.crtime, "{ctx} {i}");
			}
			if c.ids {
				assert_eq!((want.uid, want.gid), (have.uid, have.gid), "{ctx} {i}");
			}
			assert_eq!(want.rdev, have.rdev, "{ctx} {i}");
			assert_eq!(want.link, have.link, "{ctx} {i}");
			if c.checksum && want.is_reg() {
				// Protocol ≥ 28 sends a sum for every regular file (and only those); one the
				// sender has none for goes out as zeros.
				let expect = want.sum.clone().unwrap_or_else(|| vec![0u8; 16].into_boxed_slice());
				assert_eq!(Some(expect), have.sum, "{ctx} {i}");
			} else {
				assert!(have.sum.is_none(), "{ctx} {i}");
			}
			let wire_ndx = ndx_start + i as i32;
			let expect_hlink = match want.hlink {
				Hlink::Leader => Hlink::First(wire_ndx),
				other => other,
			};
			assert_eq!(expect_hlink, have.hlink, "{ctx} {i}");
			if want.is_dir() {
				let mask = FLAG_TOP_DIR | FLAG_CONTENT_DIR | FLAG_IMPLIED_DIR;
				let expect = if p.version >= 30 {
					want.flags & mask
				} else {
					// Protocol 29 only carries the top-dir bit; content follows from -r.
					if want.flags & FLAG_TOP_DIR != 0 { FLAG_TOP_DIR | FLAG_CONTENT_DIR } else { FLAG_CONTENT_DIR }
				};
				assert_eq!(have.flags & mask, expect, "{ctx} {i}");
			}
		}
	}

	#[test]
	fn round_trips_every_protocol_and_option_mix() {
		let mut protos = vec![Proto::new(29, 0), Proto::new(30, 0), Proto::new(30, CF_SAFE_FLIST)];
		for v in [30, 31, 32, 33] {
			protos.push(Proto::new(v, CF_VARINT_FLIST_FLAGS | CF_SAFE_FLIST));
		}
		protos.push(Proto::new(31, 0));
		for p in protos {
			for bits in 0..32u32 {
				let c = Combo {
					inc: bits & 1 != 0 && p.version >= 30,
					checksum: bits & 2 != 0,
					atimes: bits & 4 != 0,
					crtimes: bits & 8 != 0 && varint_flags(p),
					ids: bits & 16 != 0,
				};
				let mut p = p;
				if c.inc {
					p.compat |= CF_INC_RECURSE;
				}
				round_trip(p, &c);
			}
		}
	}

	#[test]
	fn inline_names_follow_under_inc_recurse() {
		let p = Proto::new(31, CF_VARINT_FLIST_FLAGS | CF_SAFE_FLIST | CF_INC_RECURSE);
		let opts = combo_opts(&Combo { inc: true, checksum: false, atimes: false, crtimes: false, ids: true });
		let mut e = entry("f", S_IFREG | 0o644);
		e.uid = 0;
		e.gid = 0;
		let mut enc = FlistEncoder::new(p, opts.clone());
		let mut wire = Vec::new();
		let mut ids = IdLists::new(p, &opts);
		enc.send_entry(&mut wire, &e, 1, &mut ids).unwrap();
		let mut second = entry("g", S_IFREG | 0o644);
		second.uid = 0;
		second.gid = 0;
		enc.send_entry(&mut wire, &second, 2, &mut ids).unwrap();
		// The first entry carries uid 0's name inline (gid 0 may be "root" too on Linux).
		let named = wire.windows(5).filter(|w| *w == b"\x04root").count();
		if cfg!(unix) {
			assert!(named >= 1);
		} else {
			assert_eq!(named, 0);
		}
		let mut dec = FlistDecoder::new(p, opts.clone());
		let mut rx = IdLists::new(p, &opts);
		let mut r = &wire[..];
		let first = dec.recv_entry(&mut r, &mut rx).unwrap().unwrap();
		let next = dec.recv_entry(&mut r, &mut rx).unwrap().unwrap();
		assert!(r.is_empty());
		assert_eq!((first.uid, next.uid), (0, 0));
		assert_eq!(rx.match_uid(0), 0);
	}

	/// Entries that differ from their predecessor in every elided field and share no name
	/// prefix would have flags 0, which reads as the end of the list.
	fn all_new(name: &str, mode: u32, n: u32) -> FileEntry {
		let mut e = entry(name, mode | n);
		e.mtime = i64::from(n);
		e.uid = n;
		e.gid = n;
		e.flags = FLAG_CONTENT_DIR;
		e
	}

	#[test]
	fn zero_flags_are_never_sent() {
		let ids_opts = FlistOpts {
			preserve_uid: true,
			preserve_gid: true,
			numeric_ids: true,
			..FlistOpts::default()
		};
		let mut ids = IdLists::default();
		let p = Proto::new(30, 0);
		let mut enc = FlistEncoder::new(p, ids_opts.clone());
		let mut wire = Vec::new();
		enc.send_entry(&mut wire, &all_new("a", S_IFREG, 1), 0, &mut ids).unwrap();
		let start = wire.len();
		enc.send_entry(&mut wire, &all_new("b", S_IFREG, 2), 1, &mut ids).unwrap();
		// Non-directory: XMIT_TOP_DIR (meaningless there) keeps the byte nonzero.
		assert_eq!(wire[start], XMIT_TOP_DIR as u8);
		let start = wire.len();
		enc.send_entry(&mut wire, &all_new("c", S_IFDIR, 3), 2, &mut ids).unwrap();
		// Directory: the two-byte form with only XMIT_EXTENDED_FLAGS.
		assert_eq!(&wire[start..start + 2], &[XMIT_EXTENDED_FLAGS as u8, 0]);

		let pv = Proto::new(31, CF_VARINT_FLIST_FLAGS);
		let mut enc = FlistEncoder::new(pv, ids_opts.clone());
		let mut wire = Vec::new();
		enc.send_entry(&mut wire, &all_new("a", S_IFREG, 1), 0, &mut ids).unwrap();
		let start = wire.len();
		enc.send_entry(&mut wire, &all_new("b", S_IFDIR, 2), 1, &mut ids).unwrap();
		assert_eq!(wire[start], XMIT_EXTENDED_FLAGS as u8);
		enc.send_end(&mut wire, 0).unwrap();

		let mut dec = FlistDecoder::new(pv, ids_opts);
		let mut r = &wire[..];
		let first = dec.recv_entry(&mut r, &mut ids).unwrap().unwrap();
		let second = dec.recv_entry(&mut r, &mut ids).unwrap().unwrap();
		assert_eq!((first.uid, second.uid, second.mtime), (1, 2, 2));
		assert!(second.is_dir());
		assert!(dec.recv_entry(&mut r, &mut ids).unwrap().is_none());
	}

	#[test]
	fn end_markers_by_protocol() {
		let mut out = Vec::new();
		FlistEncoder::new(Proto::new(29, 0), FlistOpts::default()).send_end(&mut out, 1).unwrap();
		assert_eq!(out, [0]);
		let mut out = Vec::new();
		FlistEncoder::new(Proto::new(31, 0), FlistOpts::default()).send_end(&mut out, 3).unwrap();
		assert_eq!(out, [0x04, 0x10, 3]);
		let mut out = Vec::new();
		FlistEncoder::new(Proto::new(30, 0), FlistOpts::default()).send_end(&mut out, 3).unwrap();
		assert_eq!(out, [0]);
		let mut out = Vec::new();
		FlistEncoder::new(Proto::new(32, CF_VARINT_FLIST_FLAGS), FlistOpts::default())
			.send_end(&mut out, 2)
			.unwrap();
		assert_eq!(out, [0, 2]);

		let mut ids = IdLists::default();
		let mut dec = FlistDecoder::new(Proto::new(31, 0), FlistOpts::default());
		assert!(dec.recv_entry(&mut &[0x04u8, 0x10, 0x0b][..], &mut ids).unwrap().is_none());
		assert_eq!(dec.io_error(), 3);
		let mut dec = FlistDecoder::new(Proto::new(30, 0), FlistOpts::default());
		let err = dec.recv_entry(&mut &[0x04u8, 0x10, 1][..], &mut ids).unwrap_err();
		assert_eq!(err.code, RERR_PROTOCOL);
		assert_eq!(err.message.as_deref(), Some("Invalid flist flag: 1004"));
	}

	fn decode_err(p: Proto, opts: FlistOpts, wire: &[u8]) -> RsyncError {
		let mut dec = FlistDecoder::new(p, opts.clone());
		let mut ids = IdLists::new(p, &opts);
		let mut r = wire;
		loop {
			match dec.recv_entry(&mut r, &mut ids) {
				Ok(Some(_)) => {}
				Ok(None) => panic!("unexpected end"),
				Err(e) => return e,
			}
		}
	}

	#[test]
	fn decoder_rejects_hostile_entries() {
		let p = Proto::new(31, 0);
		// Name longer than MAXPATHLEN.
		let mut wire = vec![(XMIT_LONG_NAME | XMIT_EXTENDED_FLAGS) as u8, 0];
		wire.write_varint30(p, MAXPATHLEN as i32).unwrap();
		let e = decode_err(p, FlistOpts::default(), &wire);
		assert_eq!(e.code, RERR_MALLOC);
		assert_eq!(
			e.message.as_deref(),
			Some("[receiver] buffer overflow: recv_file_entry (file=flist.c, line=1048)")
		);
		// Absolute name without --relative.
		let e = decode_err(p, FlistOpts::default(), &[XMIT_TOP_DIR as u8, 4, b'/', b'e', b't', b'c']);
		assert_eq!(e.code, RERR_UNSUPPORTED);
		assert_eq!(e.message.as_deref(), Some("ABORTING due to unsafe pathname from sender: /etc"));
		// ".." escape.
		let e = decode_err(p, FlistOpts::default(), &[XMIT_TOP_DIR as u8, 4, b'.', b'.', b'/', b'x']);
		assert_eq!(e.message.as_deref(), Some("ABORTING due to unsafe pathname from sender: ../x"));
		// Hard-link reference to an index not yet received.
		let opts = FlistOpts { preserve_hard_links: true, ..FlistOpts::default() };
		let mut wire = Vec::new();
		wire.write_shortint((XMIT_EXTENDED_FLAGS | XMIT_HLINKED) as u16).unwrap();
		wire.extend_from_slice(&[1, b'h', 5]);
		let e = decode_err(p, opts, &wire);
		assert_eq!(e.code, RERR_PROTOCOL);
		assert_eq!(e.message.as_deref(), Some("hard-link reference out of range: 5 (0)"));
		// Garbage mode type bits.
		let mut wire = vec![(XMIT_SAME_UID | XMIT_SAME_GID) as u8, 1, b'f'];
		wire.write_varlong30(p, 0, 3).unwrap();
		wire.write_varlong(0, 4).unwrap();
		wire.write_int(0o070644).unwrap();
		let e = decode_err(p, FlistOpts::default(), &wire);
		assert_eq!(e.message.as_deref(), Some("invalid file mode 070644 for f [receiver]"));
		// Out-of-range nanoseconds.
		let mut wire = Vec::new();
		wire.write_shortint((XMIT_EXTENDED_FLAGS | XMIT_MOD_NSEC | XMIT_SAME_TIME) as u16).unwrap();
		wire.extend_from_slice(&[1, b'f']);
		wire.write_varlong30(p, 0, 3).unwrap();
		wire.write_varint(1_000_000_000).unwrap();
		let e = decode_err(p, FlistOpts::default(), &wire);
		assert_eq!(
			e.message.as_deref(),
			Some("wire value modtime_nsec out of range: 1000000000 not in [0,999999999] [receiver]")
		);
		// "." that is not a directory.
		let mut wire = vec![XMIT_SAME_TIME as u8, 1, b'.'];
		wire.write_varlong30(p, 0, 3).unwrap();
		wire.write_int((S_IFREG | 0o644) as i32).unwrap();
		let e = decode_err(p, FlistOpts::default(), &wire);
		assert_eq!(e.message.as_deref(), Some("ERROR: rejecting non-directory transfer-root entry: ."));
		// Symlink target longer than MAXPATHLEN.
		let opts = FlistOpts { preserve_links: true, ..FlistOpts::default() };
		let mut wire = vec![XMIT_SAME_TIME as u8, 1, b'l'];
		wire.write_varlong30(p, 0, 3).unwrap();
		wire.write_int((S_IFLNK | 0o777) as i32).unwrap();
		wire.write_varint30(p, MAXPATHLEN as i32).unwrap();
		let e = decode_err(p, opts, &wire);
		assert_eq!(e.code, RERR_MALLOC);
		assert_eq!(
			e.message.as_deref(),
			Some("[receiver] buffer overflow: recv_file_entry (file=flist.c, line=1286)")
		);
		// Negative length.
		let mut wire = vec![(XMIT_SAME_TIME | XMIT_SAME_MODE) as u8, 1, b'f'];
		wire.write_varlong30(p, -1, 3).unwrap();
		let e = decode_err(p, FlistOpts::default(), &wire);
		assert_eq!(e.message.as_deref(), Some("Offset underflow: file-length is negative"));
	}

	#[test]
	fn hlinked_without_dash_h_is_not_marked() {
		// CVE-2026-70458: XMIT_HLINKED from the peer must not yield FLAG_HLINKED without -H.
		let p = Proto::new(31, CF_VARINT_FLIST_FLAGS);
		let sender = FlistOpts { preserve_hard_links: true, ..FlistOpts::default() };
		let mut enc = FlistEncoder::new(p, sender);
		let mut ids = IdLists::default();
		let mut wire = Vec::new();
		let mut a = entry("a", S_IFREG | 0o644);
		a.hlink = Hlink::Leader;
		let mut b = entry("b", S_IFREG | 0o644);
		b.hlink = Hlink::Follower(0);
		enc.send_entry(&mut wire, &a, 0, &mut ids).unwrap();
		enc.send_entry(&mut wire, &b, 1, &mut ids).unwrap();
		enc.send_end(&mut wire, 0).unwrap();
		let mut dec = FlistDecoder::new(p, FlistOpts::default());
		let mut r = &wire[..];
		let mut got = Vec::new();
		while let Some(e) = dec.recv_entry(&mut r, &mut ids).unwrap() {
			got.push(e);
		}
		assert!(r.is_empty());
		assert_eq!(got.len(), 2);
		for e in &got {
			assert_eq!(e.flags & FLAG_HLINKED, 0);
			assert_eq!(e.hlink, Hlink::None);
		}
	}

	#[test]
	fn relative_names_keep_and_strip_the_root() {
		let p = Proto::new(31, CF_VARINT_FLIST_FLAGS);
		let opts = FlistOpts { relative_paths: true, ..FlistOpts::default() };
		let mut enc = FlistEncoder::new(p, opts.clone());
		let mut ids = IdLists::default();
		let mut wire = Vec::new();
		let mut top = entry("tmp", S_IFDIR | 0o755);
		top.dirname = Arc::from(&b"/"[..]);
		let inner = entry("/tmp/x", S_IFREG | 0o644);
		let rel = entry("rel", S_IFREG | 0o644);
		for (i, e) in [&inner, &rel, &top].into_iter().enumerate() {
			enc.send_entry(&mut wire, e, i as i32, &mut ids).unwrap();
		}
		enc.send_end(&mut wire, 0).unwrap();
		let mut dec = FlistDecoder::new(p, opts);
		let mut r = &wire[..];
		let mut list = FileList::default();
		while let Some(e) = dec.recv_entry(&mut r, &mut ids).unwrap() {
			list.entries.push(e);
		}
		assert_eq!(list.entries[2].name(), b"/tmp");
		let (logger, _) = logger_with("");
		list.sort_and_clean(p, true, &logger);
		// "/tmp" has a (empty) dirname, so it sorts as a path after the top-level item
		// "rel"; the root is stripped only after sorting.
		assert_eq!(names(&list), ["rel", "tmp", "tmp/x"]);
	}

	// ---- ordering and cleaning ----

	#[test]
	fn sort_order_matches_reference() {
		// Order printed by rsync 3.5.1 for the golden tree (files before dirs per level).
		let p = Proto::new(33, 0);
		let mut list = FileList::default();
		for (n, m) in [
			("sub/deep", S_IFDIR),
			("a", S_IFDIR),
			("nnnn", S_IFREG),
			("a.b", S_IFREG),
			("a/inner", S_IFREG),
			("sock", S_IFSOCK),
			(".", S_IFDIR),
			("a-b", S_IFREG),
			("sub", S_IFDIR),
			("sub/h3", S_IFREG),
			("big", S_IFREG),
			("link", S_IFLNK),
		] {
			list.entries.push(entry(n, m | 0o644));
		}
		let (logger, _) = logger_with("");
		list.sort_and_clean(p, false, &logger);
		assert_eq!(
			names(&list),
			["." , "a-b", "a.b", "big", "link", "nnnn", "sock", "a", "a/inner", "sub", "sub/h3", "sub/deep"]
		);
	}

	#[test]
	fn directory_names_compare_with_trailing_slash() {
		let p = Proto::new(30, 0);
		let dir = entry("a", S_IFDIR);
		let file = entry("a", S_IFREG);
		let inner = entry("a/b", S_IFREG);
		let dot_dir = entry("a.b", S_IFDIR);
		let dash = entry("a-b", S_IFREG);
		assert_eq!(f_name_cmp(&file, &dir, p), Ordering::Less);
		assert_eq!(f_name_cmp(&dir, &inner, p), Ordering::Less);
		// "a/" vs "a.b/": '/' > '.'
		assert_eq!(f_name_cmp(&dir, &dot_dir, p), Ordering::Greater);
		assert_eq!(f_name_cmp(&dash, &file, p), Ordering::Greater);
		assert_eq!(f_name_cmp(&entry(".", S_IFDIR), &dash, p), Ordering::Less);
		assert_eq!(f_name_cmp(&entry("x/.", S_IFDIR), &entry("x/a", S_IFREG), p), Ordering::Less);
		assert_eq!(f_name_cmp(&dir, &dir.clone(), p), Ordering::Equal);
		assert_eq!(f_name_cmp(&FileEntry::default(), &file, p), Ordering::Less);
		assert!(f_name_has_prefix(&entry("p/foobar/baz", S_IFREG), &entry("p/foobar", S_IFDIR), p));
		assert!(!f_name_has_prefix(&entry("p/foobar/baz", S_IFREG), &entry("p/foo", S_IFDIR), p));
	}

	#[test]
	fn duplicates_are_removed_with_reference_message() {
		// `rsync -rn --debug=dup src/a.b src/a.b src/a d2/` prints exactly this line.
		let p = Proto::new(33, 0);
		let mut list = FileList { ndx_start: 1, ..FileList::default() };
		list.entries.push(entry("a.b", S_IFREG | 0o644));
		list.entries.push(entry("a.b", S_IFREG | 0o644));
		list.entries.push(entry("a", S_IFDIR | 0o755));
		let (logger, out) = logger_with("dup");
		list.sort_and_clean(p, false, &logger);
		logger.flush();
		assert_eq!(
			String::from_utf8(out.0.lock().unwrap().clone()).unwrap(),
			"removing duplicate name a.b from file list (2)\n"
		);
		assert_eq!(names(&list), ["a.b", "", "a"]);
		assert_eq!(list.find(b"a.b"), Some(0));
		assert_eq!(list.find(b"a"), Some(2));
		assert_eq!(list.find_name(b"a", Some(false)), None);
		assert_eq!(list.find(b"zz"), None);
	}

	#[test]
	fn directory_wins_over_same_named_file() {
		let p = Proto::new(31, 0);
		let mut list = FileList::default();
		list.entries.push(entry("x", S_IFREG | 0o644));
		list.entries.push(entry("w", S_IFREG | 0o644));
		let mut d = entry("x", S_IFDIR | 0o755);
		d.flags = FLAG_CONTENT_DIR;
		list.entries.push(d);
		let (logger, _) = logger_with("");
		list.sort_and_clean(p, false, &logger);
		assert_eq!(names(&list), ["w", "", "x"]);
		assert!(list.entries[2].is_dir());
	}

	#[test]
	fn duplicate_dirs_merge_flags() {
		let p = Proto::new(31, 0);
		let mut list = FileList::default();
		let mut implied = entry("d", S_IFDIR | 0o755);
		implied.flags = FLAG_IMPLIED_DIR;
		let mut content = entry("d", S_IFDIR | 0o755);
		content.flags = FLAG_TOP_DIR | FLAG_CONTENT_DIR;
		list.entries.push(implied);
		list.entries.push(content);
		let (logger, _) = logger_with("");
		list.sort_and_clean(p, false, &logger);
		assert_eq!(list.entries[0].flags, FLAG_TOP_DIR | FLAG_CONTENT_DIR);
		assert!(!list.entries[1].is_active());

		// The sender keeps both and marks the repeat.
		let mut list = FileList::default();
		list.entries.push(entry("d", S_IFDIR | 0o755));
		list.entries.push(entry("d", S_IFDIR | 0o755));
		list.sort_and_clean_with(
			CleanOpts { proto: p, strip_root: false, am_sender: true, inc_recurse: true, prune_empty_dirs: None },
			&logger,
		);
		assert!(list.entries.iter().all(FileEntry::is_active));
		assert_eq!(list.entries[1].flags & FLAG_DUPLICATE, FLAG_DUPLICATE);
	}

	#[test]
	fn prune_empty_dirs_keeps_dirs_with_files() {
		let p = Proto::new(31, 0);
		let mut list = FileList::default();
		for (n, m) in [
			(".", S_IFDIR),
			("empty", S_IFDIR),
			("empty/inner", S_IFDIR),
			("full", S_IFDIR),
			("full/f", S_IFREG),
			("kept", S_IFDIR),
		] {
			list.entries.push(entry(n, m | 0o755));
		}
		let (logger, _) = logger_with("");
		let mut excluded = |name: &[u8]| name == b"kept";
		list.sort_and_clean_with(
			CleanOpts {
				proto: p,
				strip_root: false,
				am_sender: false,
				inc_recurse: false,
				prune_empty_dirs: Some(&mut excluded),
			},
			&logger,
		);
		let active: Vec<String> =
			list.entries.iter().filter(|e| e.is_active()).map(|e| String::from_utf8_lossy_owned(e.name())).collect();
		assert_eq!(active, [".", "full", "full/f", "kept"]);
	}

}
