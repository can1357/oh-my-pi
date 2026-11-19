//! POSIX ACLs (`-A`): rsync's ACL model, its file-list wire codec (with
//! per-connection caches of access and default ACLs), and reading/applying
//! ACLs locally.
//!
//! Local access per platform:
//! - Linux: the kernel's `system.posix_acl_access` / `system.posix_acl_default`
//!   xattr format, through the confined [`Tree`] xattr operations (no libacl);
//! - macOS: extended (NFSv4-style) ACLs through acl(3) on a pinned descriptor
//!   ([`Tree::with_fd`]), with upstream's bit packing of allow/deny, flags, and
//!   permissions into one access word per named entry;
//! - `--fake-super`: the `%aacl` / `%dacl` attributes rsync defines;
//! - other systems (the BSDs, Windows) behave like a filesystem without ACL
//!   support: reads report the mode-derived ACL and writes fail.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::path::Path;

use crate::rsync::consts::mode_is_dir;
use crate::rsync::exit::{RERR_STREAMIO, RsyncError};
use crate::rsync::log::{Logger, Role};
use crate::rsync::tree::Tree;
use crate::rsync::wire::{ReadExt, WriteExt};
use crate::rsync::xattr::{alloc_check, read_varint_bounded};

/// An absent user/group/mask/other entry.
pub(crate) const NO_ENTRY: u8 = 0x80;
/// Marks a named entry as a user (otherwise a group).
pub(crate) const NAME_IS_USER: u32 = 1 << 31;

const XMIT_USER_OBJ: u8 = 1 << 0;
const XMIT_GROUP_OBJ: u8 = 1 << 1;
const XMIT_MASK_OBJ: u8 = 1 << 2;
const XMIT_OTHER_OBJ: u8 = 1 << 3;
const XMIT_NAME_LIST: u8 = 1 << 4;

const XFLAG_NAME_FOLLOWS: u32 = 0x0001;
const XFLAG_NAME_IS_USER: u32 = 0x0002;

const MAX_WIRE_ACL_COUNT: i32 = 65536;

/// Which system-ACL model this build speaks (it decides value validation and masks).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Flavor {
	/// user/group/mask/other objects plus rwx named entries.
	Posix,
	/// macOS: named allow/deny entries only, 25-bit access words.
	Osx,
}

const FLAVOR: Flavor = if cfg!(target_vendor = "apple") { Flavor::Osx } else { Flavor::Posix };

impl Flavor {
	const fn valid_name_bits(self) -> u32 {
		match self {
			Self::Posix => 7,
			Self::Osx => (1 << 25) - 1,
		}
	}

	const fn valid_obj_bits(self) -> u32 {
		match self {
			Self::Posix => 7,
			Self::Osx => 0,
		}
	}
}

/// Access vs. default (directory-inherited) ACL.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum AclKind {
	Access,
	Default,
}

impl AclKind {
	fn type_name(self, flavor: Flavor) -> &'static str {
		match (self, flavor) {
			(Self::Access, Flavor::Osx) => "ACL_TYPE_EXTENDED",
			(Self::Access, Flavor::Posix) => "ACL_TYPE_ACCESS",
			(Self::Default, _) => "ACL_TYPE_DEFAULT",
		}
	}
}

/// One named entry: a uid/gid and its access bits (`NAME_IS_USER` for users).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) struct IdAccess {
	pub id: u32,
	pub access: u32,
}

impl IdAccess {
	pub(crate) const fn is_user(self) -> bool {
		self.access & NAME_IS_USER != 0
	}
}

/// rsync's ACL: the permission-bit objects (NO_ENTRY when absent) and named entries.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) struct RsyncAcl {
	pub names: Vec<IdAccess>,
	pub user_obj: u8,
	pub group_obj: u8,
	pub mask_obj: u8,
	pub other_obj: u8,
}

impl Default for RsyncAcl {
	fn default() -> Self {
		Self { names: Vec::new(), user_obj: NO_ENTRY, group_obj: NO_ENTRY, mask_obj: NO_ENTRY, other_obj: NO_ENTRY }
	}
}

impl RsyncAcl {
	/// The ACL a file without one implicitly has (rsync_acl_fake_perms).
	pub(crate) fn fake_perms(mode: u32) -> Self {
		Self {
			user_obj: ((mode >> 6) & 7) as u8,
			group_obj: ((mode >> 3) & 7) as u8,
			other_obj: (mode & 7) as u8,
			..Self::default()
		}
	}

	/// Drops the entries the file's mode already conveys (sent condensed).
	pub(crate) fn strip_perms(&mut self, mode: u32) {
		self.user_obj = NO_ENTRY;
		if self.mask_obj == NO_ENTRY {
			self.group_obj = NO_ENTRY;
		} else {
			let group_perms = ((mode >> 3) & 7) as u8;
			if self.group_obj == group_perms {
				self.group_obj = NO_ENTRY;
			}
			if !self.names.is_empty() && self.mask_obj == group_perms {
				self.mask_obj = NO_ENTRY;
			}
		}
		self.other_obj = NO_ENTRY;
	}

	/// Whether the extended entries match; `condensed` may lack the permission objects
	/// (they are then taken from `mode`). Meaningful for access ACLs only.
	pub(crate) fn equal_enough(&self, condensed: &Self, mode: u32) -> bool {
		if (self.mask_obj ^ condensed.mask_obj) & NO_ENTRY != 0 {
			return false;
		}
		if self.mask_obj != NO_ENTRY {
			let expected = if condensed.group_obj == NO_ENTRY { ((mode >> 3) & 7) as u8 } else { condensed.group_obj };
			if self.group_obj != expected {
				return false;
			}
		}
		self.names == condensed.names
	}
}

/// The mode permission bits an ACL implies: user, mask (or group when there is no
/// mask), and other — the group bits of `st_mode` show the mask once an ACL has one.
/// Requires user/group/other entries to be present.
pub(crate) fn acl_mode_bits(acl: &RsyncAcl) -> u32 {
	let group = if acl.mask_obj != NO_ENTRY { acl.mask_obj } else { acl.group_obj };
	(u32::from(acl.user_obj & 7) << 6) | (u32::from(group & 7) << 3) | u32::from(acl.other_obj & 7)
}

/// A file's ACLs: access (absent = not read) and, for directories, default.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct AclSet {
	pub access: Option<RsyncAcl>,
	pub default: Option<RsyncAcl>,
}

/// ACL policy for one side of a transfer.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct AclOpts {
	/// Running as root, or `--super`.
	pub am_root: bool,
	pub fake_super: bool,
	pub numeric_ids: bool,
	pub inc_recurse: bool,
	pub preserve_devices: bool,
	pub preserve_specials: bool,
	pub dry_run: bool,
}

impl AclOpts {
	const fn root_level(&self) -> i32 {
		if self.fake_super {
			-1
		} else if self.am_root {
			1
		} else {
			0
		}
	}
}

/// The uid/gid bookkeeping ACL name lists need (implemented by `ids::IdLists`).
pub(crate) trait AclIdMap {
	/// Sender: registers `uid` for the id list; its name the first time only.
	fn add_uid(&mut self, uid: u32) -> Option<Vec<u8>>;
	fn add_gid(&mut self, gid: u32) -> Option<Vec<u8>>;
	/// Receiver: reads a following name (length byte + bytes), returns the local uid.
	fn recv_user_name(&mut self, r: &mut dyn Read, uid: u32) -> Result<u32, RsyncError>;
	fn recv_group_name(&mut self, r: &mut dyn Read, gid: u32) -> Result<u32, RsyncError>;
	/// Receiver: maps a sender id to the local id.
	fn match_uid(&mut self, uid: u32) -> u32;
	fn match_gid(&mut self, gid: u32) -> u32;
}

impl AclIdMap for crate::rsync::ids::IdLists {
	fn add_uid(&mut self, uid: u32) -> Option<Vec<u8>> {
		crate::rsync::ids::IdLists::add_uid(self, uid)
	}

	fn add_gid(&mut self, gid: u32) -> Option<Vec<u8>> {
		crate::rsync::ids::IdLists::add_gid(self, gid)
	}

	fn recv_user_name(&mut self, r: &mut dyn Read, uid: u32) -> Result<u32, RsyncError> {
		crate::rsync::ids::IdLists::recv_user_name(self, r, uid)
	}

	fn recv_group_name(&mut self, r: &mut dyn Read, gid: u32) -> Result<u32, RsyncError> {
		crate::rsync::ids::IdLists::recv_group_name(self, r, gid)
	}

	fn match_uid(&mut self, uid: u32) -> u32 {
		crate::rsync::ids::IdLists::match_uid(self, uid)
	}

	fn match_gid(&mut self, gid: u32) -> u32 {
		crate::rsync::ids::IdLists::match_gid(self, gid)
	}
}

// ---------------------------------------------------------------------------
// Linux POSIX ACL xattr format (pure conversions)

#[cfg(any(target_os = "linux", target_os = "android", test))]
mod posix {
	use super::{IdAccess, NAME_IS_USER, NO_ENTRY, RsyncAcl};
	use crate::rsync::consts::{S_ISGID, S_ISUID, S_ISVTX, mode_is_dir};

	/// Kernel xattr names of the access and default ACLs.
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(super) const ACL_XATTR_ACCESS: &str = "system.posix_acl_access";
	#[cfg(any(target_os = "linux", target_os = "android"))]
	pub(super) const ACL_XATTR_DEFAULT: &str = "system.posix_acl_default";
	const ACL_EA_VERSION: u32 = 0x0002;
	const ACL_EA_HDR_LEN: usize = 4;
	const ACL_EA_ENT_LEN: usize = 8;

	/// POSIX ACL entry tags (kernel ABI values).
	pub(super) const RACL_USER_OBJ: u16 = 0x01;
	pub(super) const RACL_USER: u16 = 0x02;
	pub(super) const RACL_GROUP_OBJ: u16 = 0x04;
	pub(super) const RACL_GROUP: u16 = 0x08;
	pub(super) const RACL_MASK: u16 = 0x10;
	pub(super) const RACL_OTHER: u16 = 0x20;
	pub(super) const RACL_UNDEFINED_ID: u32 = u32::MAX;

	/// One entry of the Linux kernel's POSIX ACL xattr.
	#[derive(Clone, Copy, Debug, PartialEq, Eq)]
	pub(super) struct PosixEntry {
		pub tag: u16,
		pub perm: u16,
		pub id: u32,
	}

/// Parses a `system.posix_acl_*` value; None when malformed (the kernel's EINVAL).
pub(super) fn parse_posix_acl_xattr(buf: &[u8]) -> Option<Vec<PosixEntry>> {
	let (&version, entries) = buf.split_first_chunk::<ACL_EA_HDR_LEN>()?;
	let (entries, []) = entries.as_chunks::<ACL_EA_ENT_LEN>() else {
		return None;
	};
	if u32::from_le_bytes(version) != ACL_EA_VERSION {
		return None;
	}
	Some(
		entries
			.iter()
			.map(|&[t0, t1, p0, p1, i0, i1, i2, i3]| PosixEntry {
				tag: u16::from_le_bytes([t0, t1]),
				perm: u16::from_le_bytes([p0, p1]),
				id: u32::from_le_bytes([i0, i1, i2, i3]),
			})
			.collect(),
	)
}

/// Serializes entries in the kernel's canonical order (tag, then id).
pub(super) fn encode_posix_acl_xattr(entries: &[PosixEntry]) -> Vec<u8> {
	let mut sorted = entries.to_vec();
	sorted.sort_by_key(|e| (e.tag, e.id));
	let mut out = Vec::with_capacity(ACL_EA_HDR_LEN + sorted.len() * ACL_EA_ENT_LEN);
	out.extend_from_slice(&ACL_EA_VERSION.to_le_bytes());
	for e in sorted {
		out.extend_from_slice(&e.tag.to_le_bytes());
		out.extend_from_slice(&e.perm.to_le_bytes());
		let id = if matches!(e.tag, RACL_USER | RACL_GROUP) { e.id } else { RACL_UNDEFINED_ID };
		out.extend_from_slice(&id.to_le_bytes());
	}
	out
}

/// System entries → rsync ACL: the first of each object wins, unknown tags are
/// ignored, and named entries are ordered users first, then by id.
pub(super) fn posix_entries_to_acl(entries: &[PosixEntry]) -> RsyncAcl {
	let mut acl = RsyncAcl::default();
	for e in entries {
		let access = u32::from(e.perm & 7);
		let slot = match e.tag {
			RACL_USER_OBJ => &mut acl.user_obj,
			RACL_GROUP_OBJ => &mut acl.group_obj,
			RACL_MASK => &mut acl.mask_obj,
			RACL_OTHER => &mut acl.other_obj,
			RACL_USER => {
				acl.names.push(IdAccess { id: e.id, access: access | NAME_IS_USER });
				continue;
			},
			RACL_GROUP => {
				acl.names.push(IdAccess { id: e.id, access });
				continue;
			},
			_ => continue,
		};
		if *slot == NO_ENTRY {
			*slot = access as u8;
		}
	}
	acl.names.sort_by_key(|ida| (!ida.is_user(), ida.id));
	acl
}

/// rsync ACL → system entries (pack_smb_acl): user object, the leading user
/// entries, group object, the remaining entries as groups, mask, other.
pub(super) fn acl_to_posix_entries(acl: &RsyncAcl) -> Vec<PosixEntry> {
	let entry = |tag, perm: u32, id| PosixEntry { tag, perm: (perm & 7) as u16, id };
	let mut out = vec![entry(RACL_USER_OBJ, u32::from(acl.user_obj & !NO_ENTRY), RACL_UNDEFINED_ID)];
	let users = acl.names.iter().take_while(|ida| ida.is_user()).count();
	for ida in &acl.names[..users] {
		out.push(entry(RACL_USER, ida.access & !NAME_IS_USER, ida.id));
	}
	out.push(entry(RACL_GROUP_OBJ, u32::from(acl.group_obj & !NO_ENTRY), RACL_UNDEFINED_ID));
	for ida in &acl.names[users..] {
		out.push(entry(RACL_GROUP, ida.access, ida.id));
	}
	if acl.mask_obj != NO_ENTRY {
		out.push(entry(RACL_MASK, u32::from(acl.mask_obj), RACL_UNDEFINED_ID));
	}
	out.push(entry(RACL_OTHER, u32::from(acl.other_obj & !NO_ENTRY), RACL_UNDEFINED_ID));
	out
}

/// change_sacl_perms: fills the condensed objects of an access ACL from `mode`
/// (restricting group/other while sticky turns on or setid turns off) and returns
/// the mode the file will have on disk.
pub(super) fn apply_mode_to_entries(entries: &mut [PosixEntry], acl: &RsyncAcl, old_mode: u32, new_mode: u32) -> u32 {
	let mut mode = new_mode;
	if mode_is_dir(mode) {
		if mode & S_ISVTX != 0 && old_mode & S_ISVTX == 0 {
			mode &= !0o077;
		}
	} else if (old_mode & S_ISUID != 0 && mode & S_ISUID == 0) || (old_mode & S_ISGID != 0 && mode & S_ISGID == 0) {
		mode &= !0o077;
	}
	for e in entries.iter_mut() {
		let perm = match e.tag {
			RACL_USER_OBJ => (mode >> 6) & 7,
			RACL_GROUP_OBJ if acl.group_obj == NO_ENTRY => (mode >> 3) & 7,
			RACL_MASK if acl.mask_obj != NO_ENTRY => (mode >> 3) & 7,
			RACL_OTHER => mode & 7,
			_ => continue,
		};
		e.perm = perm as u16;
	}
	(old_mode & !0o777) | (mode & 0o777)
}
}

/// `--fake-super` storage: four little-endian objects, then (id, access) pairs.
pub(crate) fn encode_fake_acl(acl: &RsyncAcl) -> Vec<u8> {
	let mut out = Vec::with_capacity(16 + acl.names.len() * 8);
	for obj in [acl.user_obj, acl.group_obj, acl.mask_obj, acl.other_obj] {
		out.extend_from_slice(&u32::from(obj).to_le_bytes());
	}
	for ida in &acl.names {
		out.extend_from_slice(&ida.id.to_le_bytes());
		out.extend_from_slice(&ida.access.to_le_bytes());
	}
	out
}

/// Parses a fake-super ACL attribute, filling absent user/group/other from `mode`.
pub(crate) fn decode_fake_acl(buf: &[u8], mode: u32) -> Option<RsyncAcl> {
	let (_, entries) = buf.split_first_chunk::<16>()?;
	let (entries, []) = entries.as_chunks::<8>() else {
		return None;
	};
	let word = |at: usize| u32::from_le_bytes([buf[at], buf[at + 1], buf[at + 2], buf[at + 3]]);
	let fill = |v: u8, bits: u32| if v == NO_ENTRY { (bits & 7) as u8 } else { v };
	let names = entries
		.iter()
		.map(|&[i0, i1, i2, i3, a0, a1, a2, a3]| IdAccess {
			id: u32::from_le_bytes([i0, i1, i2, i3]),
			access: u32::from_le_bytes([a0, a1, a2, a3]),
		})
		.collect();
	Some(RsyncAcl {
		names,
		user_obj: fill(word(0) as u8, mode >> 6),
		group_obj: fill(word(4) as u8, mode >> 3),
		mask_obj: word(8) as u8,
		other_obj: fill(word(12) as u8, mode),
	})
}

// ---------------------------------------------------------------------------
// Sender

/// Sender caches (send_acl): an index for a repeated ACL, literal data otherwise.
pub(crate) struct AclSender {
	opts: AclOpts,
	access: HashMap<RsyncAcl, u32>,
	default: HashMap<RsyncAcl, u32>,
}

impl AclSender {
	pub(crate) fn new(opts: AclOpts) -> Self {
		Self { opts, access: HashMap::new(), default: HashMap::new() }
	}

	/// Sends `set` (as read for a file of `mode`) right after its file-list entry:
	/// the access ACL condensed against the mode, then a directory's default ACL.
	pub(crate) fn send(&mut self, w: &mut dyn Write, set: &AclSet, mode: u32, ids: &mut dyn AclIdMap) -> io::Result<()> {
		let mut access = set.access.clone().unwrap_or_else(|| RsyncAcl::fake_perms(mode));
		access.strip_perms(mode);
		self.send_one(w, access, AclKind::Access, ids)?;
		if mode_is_dir(mode) {
			let default = set.default.clone().unwrap_or_default();
			self.send_one(w, default, AclKind::Default, ids)?;
		}
		Ok(())
	}

	fn send_one(&mut self, w: &mut dyn Write, acl: RsyncAcl, kind: AclKind, ids: &mut dyn AclIdMap) -> io::Result<()> {
		let cache = match kind {
			AclKind::Access => &mut self.access,
			AclKind::Default => &mut self.default,
		};
		if let Some(&ndx) = cache.get(&acl) {
			return w.write_varint(wire_int(u64::from(ndx) + 1)?);
		}
		w.write_varint(0)?;
		let mut flags = 0;
		for (obj, bit) in [
			(acl.user_obj, XMIT_USER_OBJ),
			(acl.group_obj, XMIT_GROUP_OBJ),
			(acl.mask_obj, XMIT_MASK_OBJ),
			(acl.other_obj, XMIT_OTHER_OBJ),
		] {
			if obj != NO_ENTRY {
				flags |= bit;
			}
		}
		if !acl.names.is_empty() {
			flags |= XMIT_NAME_LIST;
		}
		w.write_u8(flags)?;
		for obj in [acl.user_obj, acl.group_obj, acl.mask_obj, acl.other_obj] {
			if obj != NO_ENTRY {
				w.write_varint(i32::from(obj))?;
			}
		}
		if !acl.names.is_empty() {
			w.write_varint(wire_int(acl.names.len() as u64)?)?;
			for ida in &acl.names {
				let mut xbits = ida.access << 2;
				let name = if ida.is_user() {
					xbits |= XFLAG_NAME_IS_USER;
					if self.opts.numeric_ids { None } else { ids.add_uid(ida.id) }
				} else if self.opts.numeric_ids {
					None
				} else {
					ids.add_gid(ida.id)
				};
				w.write_varint(ida.id as i32)?;
				match name {
					Some(name) if self.opts.inc_recurse => {
						let name = &name[..name.len().min(255)];
						w.write_varint((xbits | XFLAG_NAME_FOLLOWS) as i32)?;
						w.write_u8(name.len() as u8)?;
						w.write_all(name)?;
					},
					_ => w.write_varint(xbits as i32)?,
				}
			}
		}
		let ndx = u32::try_from(cache.len())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too many ACLs"))?;
		cache.insert(acl, ndx);
		Ok(())
	}
}

fn wire_int(v: u64) -> io::Result<i32> {
	i32::try_from(v).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "ACL value too large for the wire"))
}

// ---------------------------------------------------------------------------
// Receiver

/// Receiver caches (receive_acl); the indices go into `FileEntry::acl` / `def_acl`.
pub(crate) struct AclReceiver {
	opts: AclOpts,
	flavor: Flavor,
	max_alloc: u64,
	role: Role,
	access: Vec<RsyncAcl>,
	default: Vec<RsyncAcl>,
}

impl AclReceiver {
	pub(crate) fn new(opts: AclOpts, max_alloc: u64) -> Self {
		Self::with_flavor(opts, max_alloc, FLAVOR)
	}

	fn with_flavor(opts: AclOpts, max_alloc: u64, flavor: Flavor) -> Self {
		Self {
			opts,
			flavor,
			max_alloc,
			role: Role::Receiver,
			access: Vec::new(),
			default: Vec::new(),
		}
	}

	/// Role named in protocol-error messages.
	pub(crate) fn set_role(&mut self, role: Role) {
		self.role = role;
	}

	/// Reads the ACL data following a (non-symlink) entry of `mode`: the access ACL
	/// index and, for a directory, the default ACL index.
	pub(crate) fn recv(
		&mut self,
		r: &mut dyn Read,
		mode: u32,
		ids: &mut dyn AclIdMap,
	) -> Result<(u32, Option<u32>), RsyncError> {
		let access = self.recv_one(r, AclKind::Access, mode, ids)?;
		let default = if mode_is_dir(mode) { Some(self.recv_one(r, AclKind::Default, 0, ids)?) } else { None };
		Ok((access, default))
	}

	fn recv_one(&mut self, r: &mut dyn Read, kind: AclKind, mode: u32, ids: &mut dyn AclIdMap) -> Result<u32, RsyncError> {
		let count = self.list(kind).len();
		let ndx = r.read_varint().map_err(RsyncError::from_stream)?;
		if ndx < 0 || ndx as usize > count {
			return Err(RsyncError::new(
				RERR_STREAMIO,
				format!("recv_acl_index: {} ACL index {ndx} > {count}", kind.type_name(self.flavor)),
			)
			.at("acls.c", 971));
		}
		if ndx != 0 {
			return Ok((ndx - 1) as u32);
		}

		let mut acl = RsyncAcl::default();
		let flags = r.read_u8().map_err(RsyncError::from_stream)?;
		for (bit, slot) in [
			(XMIT_USER_OBJ, &mut acl.user_obj),
			(XMIT_GROUP_OBJ, &mut acl.group_obj),
			(XMIT_MASK_OBJ, &mut acl.mask_obj),
			(XMIT_OTHER_OBJ, &mut acl.other_obj),
		] {
			if flags & bit != 0 {
				let access = r.read_varint().map_err(RsyncError::from_stream)? as u32;
				self.check_access(access, self.flavor.valid_obj_bits())?;
				*slot = access as u8;
			}
		}
		let mut computed_mask: u8 = 0;
		if flags & XMIT_NAME_LIST != 0 {
			computed_mask = self.recv_names(r, &mut acl.names, ids)?;
		}
		match self.flavor {
			Flavor::Osx => acl.mask_obj = NO_ENTRY,
			Flavor::Posix => {
				if !acl.names.is_empty() && acl.mask_obj == NO_ENTRY {
					acl.mask_obj = match kind {
						AclKind::Access => ((mode >> 3) & 7) as u8,
						AclKind::Default => computed_mask | (acl.group_obj & !NO_ENTRY),
					};
				}
			},
		}
		let list = self.list_mut(kind);
		list.push(acl);
		Ok((list.len() - 1) as u32)
	}

	fn recv_names(&mut self, r: &mut dyn Read, names: &mut Vec<IdAccess>, ids: &mut dyn AclIdMap) -> Result<u8, RsyncError> {
		let count = read_varint_bounded(r, 0, MAX_WIRE_ACL_COUNT, "ACL count", self.role)? as usize;
		if count > 0 {
			alloc_check(self.max_alloc, count as u64, 8, self.role, "acls.c", 932)?;
		}
		names.reserve_exact(count);
		let mut computed: u8 = 0;
		let root = self.opts.root_level();
		for _ in 0..count {
			let mut id = r.read_varint().map_err(RsyncError::from_stream)? as u32;
			let raw = r.read_varint().map_err(RsyncError::from_stream)? as u32;
			let mut access = raw >> 2;
			self.check_access(access, self.flavor.valid_name_bits())?;
			if raw & XFLAG_NAME_IS_USER != 0 {
				access |= NAME_IS_USER;
			}
			if raw & XFLAG_NAME_FOLLOWS != 0 {
				id = if access & NAME_IS_USER != 0 { ids.recv_user_name(r, id)? } else { ids.recv_group_name(r, id)? };
			} else if access & NAME_IS_USER != 0 {
				if self.opts.inc_recurse && !self.opts.numeric_ids {
					id = ids.match_uid(id);
				}
			} else if self.opts.inc_recurse && (root == 0 || !self.opts.numeric_ids) {
				id = ids.match_gid(id);
			}
			names.push(IdAccess { id, access });
			computed |= access as u8;
		}
		Ok(computed & !NO_ENTRY)
	}

	fn check_access(&self, access: u32, valid: u32) -> Result<(), RsyncError> {
		if self.opts.root_level() >= 0 && access & !valid != 0 {
			return Err(RsyncError::new(RERR_STREAMIO, format!("recv_acl_access: value out of range: {access:x}"))
				.at("acls.c", 921));
		}
		Ok(())
	}

	fn list(&self, kind: AclKind) -> &Vec<RsyncAcl> {
		match kind {
			AclKind::Access => &self.access,
			AclKind::Default => &self.default,
		}
	}

	fn list_mut(&mut self, kind: AclKind) -> &mut Vec<RsyncAcl> {
		match kind {
			AclKind::Access => &mut self.access,
			AclKind::Default => &mut self.default,
		}
	}

	/// The cached access ACL at `ndx`.
	pub(crate) fn access(&self, ndx: u32) -> Option<&RsyncAcl> {
		self.access.get(ndx as usize)
	}

	/// The cached default ACL at `ndx`.
	pub(crate) fn default_acl(&self, ndx: u32) -> Option<&RsyncAcl> {
		self.default.get(ndx as usize)
	}

	/// The wanted ACLs of an entry, from its cache indices.
	pub(crate) fn get(&self, access: Option<u32>, default: Option<u32>) -> AclSet {
		AclSet {
			access: access.and_then(|ndx| self.access(ndx)).cloned(),
			default: default.and_then(|ndx| self.default_acl(ndx)).cloned(),
		}
	}

	/// match_acl_ids: without inc-recursion, maps every cached id once the id lists arrived.
	pub(crate) fn remap_ids(&mut self, ids: &mut dyn AclIdMap) {
		for acl in self.access.iter_mut().chain(self.default.iter_mut()) {
			for ida in &mut acl.names {
				ida.id = if ida.is_user() { ids.match_uid(ida.id) } else { ids.match_gid(ida.id) };
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Comparison and application

/// set_acl without a file name: does `local` (as read) differ from `wanted`
/// (as received) for a file of `new_mode`? Drives itemize's `a`.
pub(crate) fn differs(local: &AclSet, wanted: &AclSet, new_mode: u32) -> bool {
	access_differs(local, wanted, new_mode) || (mode_is_dir(new_mode) && default_differs(local, wanted))
}

fn access_differs(local: &AclSet, wanted: &AclSet, new_mode: u32) -> bool {
	wanted
		.access
		.as_ref()
		.is_some_and(|w| !local.access.as_ref().is_some_and(|l| l.equal_enough(w, new_mode)))
}

fn default_differs(local: &AclSet, wanted: &AclSet) -> bool {
	wanted.default.as_ref().is_some_and(|w| local.default.as_ref() != Some(w))
}

/// What [`apply_with`] did.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct AclApplied {
	/// The ACLs differed (and were set unless dry-running).
	pub changed: bool,
	/// The file's mode as the ACL write left it (POSIX access ACLs rewrite the
	/// permission bits); compare it with the wanted mode to decide on a chmod.
	pub mode: u32,
}

/// Sets `wanted` on `rel` where it differs from `local`, logging failures like
/// upstream. `cur_mode` is the file's current `st_mode`, `new_mode` the mode being
/// applied.
#[allow(clippy::too_many_arguments, reason = "mirrors set_acl's inputs")]
pub(crate) fn apply_with(
	tree: &Tree,
	rel: &Path,
	wanted: &AclSet,
	local: &AclSet,
	cur_mode: u32,
	new_mode: u32,
	opts: AclOpts,
	logger: Option<&Logger>,
) -> io::Result<AclApplied> {
	let mut out = AclApplied { changed: false, mode: cur_mode };
	if access_differs(local, wanted, new_mode)
		&& let Some(acl) = &wanted.access
	{
		out.changed = true;
		if !opts.dry_run {
			out.mode = sys::set_one(tree, rel, AclKind::Access, acl, out.mode, new_mode, &opts, logger)?;
		}
	}
	if !mode_is_dir(new_mode) {
		return Ok(out);
	}
	if default_differs(local, wanted)
		&& let Some(acl) = &wanted.default
	{
		out.changed = true;
		if !opts.dry_run {
			sys::set_one(tree, rel, AclKind::Default, acl, out.mode, new_mode, &opts, logger)?;
		}
	}
	Ok(out)
}

/// Reads `rel`'s ACLs: always an access ACL (empty for types without ACLs), plus the
/// default ACL of a directory. `mode` is the file's `st_mode`.
pub(crate) fn read_local_with(
	tree: &Tree,
	rel: &Path,
	mode: u32,
	opts: AclOpts,
	logger: Option<&Logger>,
) -> io::Result<AclSet> {
	use crate::rsync::consts::{mode_is_device, mode_is_lnk, mode_is_reg, mode_is_special};
	let mut set = AclSet { access: Some(RsyncAcl::default()), default: None };
	let carries = if mode_is_reg(mode) || mode_is_dir(mode) {
		true
	} else if mode_is_lnk(mode) {
		false
	} else if mode_is_special(mode) {
		opts.preserve_specials
	} else if mode_is_device(mode) {
		opts.preserve_devices
	} else {
		false
	};
	if !carries {
		return Ok(set);
	}
	set.access = Some(sys::get_one(tree, rel, AclKind::Access, mode, &opts, logger)?);
	if mode_is_dir(mode) {
		set.default = Some(sys::get_one(tree, rel, AclKind::Default, mode, &opts, logger)?);
	}
	Ok(set)
}

/// default_perms_for_dir: the permissions new entries in `dir` get from its default
/// ACL (user/group-or-mask/other), else `0o777 & !umask`.
pub(crate) fn default_perms_for_dir(tree: &Tree, dir: &Path, umask: u32, dry_run: bool, logger: Option<&Logger>) -> u32 {
	let perms = 0o777 & !umask;
	match sys::read_default_for_perms(tree, dir) {
		Ok(Some(acl)) if acl.user_obj != NO_ENTRY => {
			let acl_perms = acl_mode_bits(&acl);
			if let Some(logger) = logger
				&& logger.levels().debug(crate::rsync::log::Debug::Acl) >= 1
			{
				let text = format!("got ACL-based default perms {acl_perms:o} for directory {}\n", dir_name(dir));
				logger.rprintf(crate::rsync::log::LogCode::Info, text.as_bytes());
			}
			acl_perms
		},
		Ok(_) => perms,
		Err(err) => {
			let quiet = no_acl_syscall_error(&err) || (dry_run && err.kind() == io::ErrorKind::NotFound);
			if !quiet && let Some(logger) = logger {
				let text = format!(
					"default_perms_for_dir: sys_acl_get_file({}, ACL_TYPE_DEFAULT): {}, falling back on umask\n",
					dir_name(dir),
					crate::rsync::log::strerror(&err)
				);
				logger.rprintf(crate::rsync::log::LogCode::Warning, text.as_bytes());
			}
			perms
		},
	}
}

fn dir_name(dir: &Path) -> String {
	let name = crate::host::os_bytes_lossy(dir.as_os_str());
	if name.is_empty() { ".".to_owned() } else { String::from_utf8_lossy(&name).into_owned() }
}

/// Errors that mean "this filesystem/platform has no (such) ACLs".
fn no_acl_syscall_error(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(unix)]
	{
		match err.raw_os_error() {
			Some(libc::ENOENT) => FLAVOR == Flavor::Osx,
			Some(e) => e == libc::ENOSYS || e == libc::ENOTSUP || e == libc::EOPNOTSUPP || e == libc::EINVAL,
			None => false,
		}
	}
	#[cfg(not(unix))]
	{
		false
	}
}

fn rel_text(rel: &Path) -> String {
	String::from_utf8_lossy(&crate::host::os_bytes_lossy(rel.as_os_str())).into_owned()
}

fn log_syserr(logger: Option<&Logger>, err: &io::Error, text: String) {
	if let Some(logger) = logger {
		logger.rsyserr(crate::rsync::log::LogCode::ErrorXfer, err, text.as_bytes());
	}
}

// ---------------------------------------------------------------------------
// Platform access

mod sys {
	use std::io;
	use std::path::Path;

	use super::{AclKind, AclOpts, FLAVOR, RsyncAcl, log_syserr, no_acl_syscall_error, rel_text};
	use crate::rsync::consts::{mode_is_dir, mode_is_reg};
	use crate::rsync::log::Logger;
	use crate::rsync::meta::full_fname;
	use crate::rsync::tree::Tree;
	use crate::rsync::{paths::bytes_os, xattr::rsync_internal_name};

	/// A failed system-ACL read: the fetch itself, or (macOS) walking its entries.
	pub(super) enum ReadError {
		Get(io::Error),
		#[cfg_attr(
			not(target_vendor = "apple"),
			allow(dead_code, reason = "only macOS unpacks entries through fallible acl(3) calls")
		)]
		Unpack(&'static str, io::Error),
	}

	/// A failed system-ACL write: (macOS) building it, or storing it.
	pub(super) enum WriteError {
		#[cfg_attr(
			not(target_vendor = "apple"),
			allow(dead_code, reason = "only macOS packs entries through fallible acl(3) calls")
		)]
		Pack(&'static str, io::Error),
		Set(io::Error),
	}

	/// The fake-super attribute holding an ACL of `kind`.
	fn fake_name(kind: AclKind) -> Vec<u8> {
		rsync_internal_name(match kind {
			AclKind::Access => b"aacl",
			AclKind::Default => b"dacl",
		})
	}

	/// get_rsync_acl for one ACL type.
	pub(super) fn get_one(
		tree: &Tree,
		rel: &Path,
		kind: AclKind,
		mode: u32,
		opts: &AclOpts,
		logger: Option<&Logger>,
	) -> io::Result<RsyncAcl> {
		if opts.root_level() < 0 {
			return match tree.get_xattr(rel, bytes_os(&fake_name(kind))?, false) {
				Ok(Some(buf)) => super::decode_fake_acl(&buf, mode)
					.ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "corrupt fake-super ACL attribute")),
				Ok(None) | Err(_) => Ok(RsyncAcl::default()),
			};
		}
		let fallback = || match kind {
			AclKind::Access => RsyncAcl::fake_perms(mode),
			AclKind::Default => RsyncAcl::default(),
		};
		match platform::read(tree, rel, kind) {
			Ok(Some(acl)) => Ok(acl),
			Ok(None) => Ok(fallback()),
			Err(ReadError::Get(err)) if no_acl_syscall_error(&err) => Ok(fallback()),
			Err(ReadError::Get(err)) => {
				log_syserr(
					logger,
					&err,
					format!("get_acl: {}({}, {})", platform::GET_FN, rel_text(rel), kind.type_name(FLAVOR)),
				);
				Err(err)
			},
			Err(ReadError::Unpack(errfun, err)) => {
				log_syserr(logger, &err, format!("unpack_smb_acl: {errfun}()"));
				log_syserr(logger, &err, format!("get_acl: unpack_smb_acl({})", rel_text(rel)));
				Err(err)
			},
		}
	}

	/// set_rsync_acl for one ACL type; returns the file's resulting mode.
	#[allow(clippy::too_many_arguments, reason = "mirrors set_rsync_acl's inputs")]
	pub(super) fn set_one(
		tree: &Tree,
		rel: &Path,
		kind: AclKind,
		acl: &RsyncAcl,
		cur_mode: u32,
		new_mode: u32,
		opts: &AclOpts,
		logger: Option<&Logger>,
	) -> io::Result<u32> {
		let fake = opts.root_level() < 0;
		if kind == AclKind::Default && acl.user_obj == super::NO_ENTRY {
			let result = if fake {
				bytes_os(&fake_name(kind)).and_then(|name| tree.remove_xattr(rel, name, false))
			} else {
				platform::delete_default(tree, rel)
			};
			return match result {
				Ok(()) => Ok(cur_mode),
				Err(err) => {
					log_syserr(logger, &err, format!("set_acl: sys_acl_delete_def_file({})", rel_text(rel)));
					Err(err)
				},
			};
		}
		if fake {
			let name = fake_name(kind);
			return match bytes_os(&name).and_then(|os| tree.set_xattr(rel, os, &super::encode_fake_acl(acl), false)) {
				Ok(()) => Ok(cur_mode),
				Err(err) => {
					let prefix = if mode_is_reg(cur_mode) || mode_is_dir(cur_mode) { "f" } else { "l" };
					log_syserr(
						logger,
						&err,
						format!(
							"set_xattr_acl: {prefix}setxattr({},\"{}\") failed",
							String::from_utf8_lossy(&full_fname(tree, rel)),
							String::from_utf8_lossy(&name)
						),
					);
					Err(err)
				},
			};
		}
		match platform::write(tree, rel, kind, acl, cur_mode, new_mode) {
			Ok(mode) => Ok(mode),
			Err(WriteError::Pack(errfun, err)) => {
				log_syserr(logger, &err, format!("pack_smb_acl{errfun}"));
				Err(err)
			},
			Err(WriteError::Set(err)) => {
				log_syserr(
					logger,
					&err,
					format!("set_acl: {}({}, {})", platform::SET_FN, rel_text(rel), kind.type_name(FLAVOR)),
				);
				Err(err)
			},
		}
	}

	/// A directory's default ACL for default_perms_for_dir (None = has none).
	pub(super) fn read_default_for_perms(tree: &Tree, dir: &Path) -> io::Result<Option<RsyncAcl>> {
		match platform::read(tree, dir, AclKind::Default) {
			Ok(acl) => Ok(acl),
			Err(ReadError::Get(err) | ReadError::Unpack(_, err)) => Err(err),
		}
	}

	#[cfg(any(target_os = "linux", target_os = "android"))]
	mod platform {
		use std::io;
		use std::path::Path;

		use super::super::posix::{
			ACL_XATTR_ACCESS, ACL_XATTR_DEFAULT, acl_to_posix_entries, apply_mode_to_entries, encode_posix_acl_xattr,
			parse_posix_acl_xattr, posix_entries_to_acl,
		};
		use super::super::{AclKind, RsyncAcl};
		use super::{ReadError, WriteError};
		use crate::rsync::tree::Tree;

		pub(in super::super) const GET_FN: &str = "xacl_get";
		pub(in super::super) const SET_FN: &str = "xacl_set";

		fn xattr_name(kind: AclKind) -> &'static str {
			match kind {
				AclKind::Access => ACL_XATTR_ACCESS,
				AclKind::Default => ACL_XATTR_DEFAULT,
			}
		}

		/// None: no explicit ACL (the caller fakes one from the mode).
		pub(in super::super) fn read(tree: &Tree, rel: &Path, kind: AclKind) -> Result<Option<RsyncAcl>, ReadError> {
			let buf = match tree.get_xattr(rel, std::ffi::OsStr::new(xattr_name(kind)), false) {
				Ok(Some(buf)) => buf,
				Ok(None) => return Ok(None),
				Err(err) => return Err(ReadError::Get(err)),
			};
			let entries = parse_posix_acl_xattr(&buf)
				.ok_or_else(|| ReadError::Get(io::Error::from_raw_os_error(libc::EINVAL)))?;
			Ok((!entries.is_empty()).then(|| posix_entries_to_acl(&entries)))
		}

		pub(in super::super) fn write(
			tree: &Tree,
			rel: &Path,
			kind: AclKind,
			acl: &RsyncAcl,
			cur_mode: u32,
			new_mode: u32,
		) -> Result<u32, WriteError> {
			let mut entries = acl_to_posix_entries(acl);
			let mode = match kind {
				AclKind::Access => apply_mode_to_entries(&mut entries, acl, cur_mode, new_mode),
				AclKind::Default => cur_mode,
			};
			tree.set_xattr(rel, std::ffi::OsStr::new(xattr_name(kind)), &encode_posix_acl_xattr(&entries), false)
				.map_err(WriteError::Set)?;
			Ok(mode)
		}

		pub(in super::super) fn delete_default(tree: &Tree, rel: &Path) -> io::Result<()> {
			match tree.remove_xattr(rel, std::ffi::OsStr::new(ACL_XATTR_DEFAULT), false) {
				Err(err) if err.raw_os_error() == Some(libc::ENODATA) => Ok(()),
				result => result,
			}
		}
	}

	#[cfg(target_vendor = "apple")]
	mod platform {
		use std::ffi::c_void;
		use std::io;
		use std::os::fd::{AsRawFd, RawFd};
		use std::os::raw::c_int;
		use std::path::Path;
		use std::ptr;

		use super::super::{AclKind, IdAccess, NAME_IS_USER, RsyncAcl};
		use super::{ReadError, WriteError};
		use crate::rsync::tree::Tree;

		pub(in super::super) const GET_FN: &str = "sys_acl_get_file";
		pub(in super::super) const SET_FN: &str = "sys_acl_set_file";

		type AclT = *mut c_void;
		type AclEntryT = *mut c_void;
		type AclPermsetT = *mut c_void;
		type AclFlagsetT = *mut c_void;

		const ACL_TYPE_EXTENDED: c_int = 0x0000_0100;
		const ACL_FIRST_ENTRY: c_int = 0;
		const ACL_NEXT_ENTRY: c_int = -1;
		const ACL_EXTENDED_ALLOW: c_int = 1;
		const ACL_EXTENDED_DENY: c_int = 2;
		const ID_TYPE_UID: c_int = 0;

		// SAFETY: declarations match <sys/acl.h> and <membership.h> in the macOS SDK;
		// every enum parameter is a C `int`, `uuid_t` is `unsigned char[16]`.
		unsafe extern "C" {
			fn acl_get_fd_np(fd: c_int, ty: c_int) -> AclT;
			fn acl_set_fd_np(fd: c_int, acl: AclT, ty: c_int) -> c_int;
			fn acl_init(count: c_int) -> AclT;
			fn acl_free(obj: *mut c_void) -> c_int;
			fn acl_get_entry(acl: AclT, entry_id: c_int, entry: *mut AclEntryT) -> c_int;
			fn acl_create_entry(acl: *mut AclT, entry: *mut AclEntryT) -> c_int;
			fn acl_get_tag_type(entry: AclEntryT, tag: *mut c_int) -> c_int;
			fn acl_set_tag_type(entry: AclEntryT, tag: c_int) -> c_int;
			fn acl_get_flagset_np(obj: *mut c_void, flagset: *mut AclFlagsetT) -> c_int;
			fn acl_set_flagset_np(obj: *mut c_void, flagset: AclFlagsetT) -> c_int;
			fn acl_get_permset(entry: AclEntryT, permset: *mut AclPermsetT) -> c_int;
			fn acl_set_permset(entry: AclEntryT, permset: AclPermsetT) -> c_int;
			fn acl_get_flag_np(flagset: AclFlagsetT, flag: c_int) -> c_int;
			fn acl_get_perm_np(permset: AclPermsetT, perm: c_int) -> c_int;
			fn acl_clear_flags_np(flagset: AclFlagsetT) -> c_int;
			fn acl_clear_perms(permset: AclPermsetT) -> c_int;
			fn acl_add_flag_np(flagset: AclFlagsetT, flag: c_int) -> c_int;
			fn acl_add_perm(permset: AclPermsetT, perm: c_int) -> c_int;
			fn acl_get_qualifier(entry: AclEntryT) -> *mut c_void;
			fn acl_set_qualifier(entry: AclEntryT, qualifier: *const c_void) -> c_int;
			fn mbr_uuid_to_id(uu: *const u8, id: *mut u32, id_type: *mut c_int) -> c_int;
			fn mbr_uid_to_uuid(uid: u32, uu: *mut u8) -> c_int;
			fn mbr_gid_to_uuid(gid: u32, uu: *mut u8) -> c_int;
		}

		/// Owns an acl(3) object.
		struct Acl(AclT);

		impl Drop for Acl {
			fn drop(&mut self) {
				if !self.0.is_null() {
					// SAFETY: self.0 came from acl_get_fd_np/acl_init and is freed once.
					unsafe { acl_free(self.0) };
				}
			}
		}

		fn last() -> io::Error {
			io::Error::last_os_error()
		}

		/// Bit `i` of the access word's flag range (1..12) ↔ acl flag 1<<(i+3);
		/// bit 12+i of the permission range (12..25) ↔ acl perm 1<<(i+1).
		const FLAG_BITS: std::ops::Range<u32> = 1..12;
		const PERM_BITS: std::ops::Range<u32> = 12..25;

		fn read_fd(fd: RawFd) -> Result<Vec<IdAccess>, ReadError> {
			// SAFETY: fd is a live descriptor pinned by Tree::with_fd for this call.
			let acl = Acl(unsafe { acl_get_fd_np(fd, ACL_TYPE_EXTENDED) });
			if acl.0.is_null() {
				return Err(ReadError::Get(last()));
			}
			let mut names = Vec::new();
			let mut which = ACL_FIRST_ENTRY;
			loop {
				let mut entry: AclEntryT = ptr::null_mut();
				// SAFETY: acl is valid; entry receives a borrowed entry pointer.
				let rc = unsafe { acl_get_entry(acl.0, which, &mut entry) };
				which = ACL_NEXT_ENTRY;
				// macOS reports an entry as 0 (not 1) and the end as EINVAL.
				if rc != 0 && rc != 1 {
					let err = last();
					if rc == -1 && err.raw_os_error() == Some(libc::EINVAL) {
						break;
					}
					return Err(ReadError::Unpack("sys_acl_get_entry", err));
				}
				names.push(entry_info(entry).map_err(|err| ReadError::Unpack("sys_acl_get_info", err))?);
			}
			Ok(names)
		}

		fn entry_info(entry: AclEntryT) -> io::Result<IdAccess> {
			let mut tag: c_int = 0;
			let mut flagset: AclFlagsetT = ptr::null_mut();
			let mut permset: AclPermsetT = ptr::null_mut();
			// SAFETY: entry belongs to a live ACL; out-pointers are valid locals.
			unsafe {
				if acl_get_tag_type(entry, &mut tag) != 0
					|| acl_get_flagset_np(entry, &mut flagset) != 0
					|| acl_get_permset(entry, &mut permset) != 0
				{
					return Err(last());
				}
			}
			// SAFETY: as above; the qualifier is a 16-byte guid freed below.
			let qualifier = unsafe { acl_get_qualifier(entry) };
			if qualifier.is_null() {
				return Err(last());
			}
			let mut id: u32 = 0;
			let mut id_type: c_int = -1;
			// SAFETY: qualifier points at a uuid_t; it is freed exactly once.
			let rc = unsafe {
				let rc = mbr_uuid_to_id(qualifier.cast(), &mut id, &mut id_type);
				acl_free(qualifier);
				rc
			};
			if rc != 0 {
				return Err(io::Error::from_raw_os_error(rc));
			}
			let mut bits = u32::from(tag == ACL_EXTENDED_ALLOW);
			for bit in FLAG_BITS {
				// SAFETY: flagset belongs to the live entry.
				if unsafe { acl_get_flag_np(flagset, 1 << (bit + 3)) } == 1 {
					bits |= 1 << bit;
				}
			}
			for bit in PERM_BITS {
				// SAFETY: permset belongs to the live entry.
				if unsafe { acl_get_perm_np(permset, 1 << (bit - 11)) } == 1 {
					bits |= 1 << bit;
				}
			}
			if id_type == ID_TYPE_UID {
				bits |= NAME_IS_USER;
			}
			Ok(IdAccess { id, access: bits })
		}

		fn write_fd(fd: RawFd, names: &[IdAccess]) -> Result<(), WriteError> {
			let count = c_int::try_from(names.len()).unwrap_or(c_int::MAX);
			// SAFETY: acl_init allocates a fresh ACL owned by the guard.
			let mut acl = Acl(unsafe { acl_init(count) });
			if acl.0.is_null() {
				return Err(WriteError::Pack(": sys_acl_init()", last()));
			}
			for ida in names {
				let mut entry: AclEntryT = ptr::null_mut();
				// SAFETY: acl.0 is valid and may be reallocated in place by the call.
				if unsafe { acl_create_entry(&mut acl.0, &mut entry) } != 0 {
					return Err(WriteError::Pack(" sys_acl_create_entry()", last()));
				}
				set_info(entry, *ida).map_err(|err| WriteError::Pack(" sys_acl_set_info()", err))?;
			}
			// SAFETY: fd is pinned by Tree::with_fd; acl is a valid ACL.
			if unsafe { acl_set_fd_np(fd, acl.0, ACL_TYPE_EXTENDED) } != 0 {
				return Err(WriteError::Set(last()));
			}
			Ok(())
		}

		fn set_info(entry: AclEntryT, ida: IdAccess) -> io::Result<()> {
			let bits = ida.access & !NAME_IS_USER;
			let tag = if bits & 1 != 0 { ACL_EXTENDED_ALLOW } else { ACL_EXTENDED_DENY };
			let mut flagset: AclFlagsetT = ptr::null_mut();
			let mut permset: AclPermsetT = ptr::null_mut();
			let mut uuid = [0u8; 16];
			// SAFETY: entry was just created in a live ACL; out-pointers are locals and
			// uuid is a 16-byte buffer as uuid_t requires.
			unsafe {
				if acl_get_flagset_np(entry, &mut flagset) != 0 || acl_get_permset(entry, &mut permset) != 0 {
					return Err(last());
				}
				acl_clear_flags_np(flagset);
				acl_clear_perms(permset);
				for bit in FLAG_BITS {
					if bits & (1 << bit) != 0 {
						acl_add_flag_np(flagset, 1 << (bit + 3));
					}
				}
				for bit in PERM_BITS {
					if bits & (1 << bit) != 0 {
						acl_add_perm(permset, 1 << (bit - 11));
					}
				}
				let rc = if ida.is_user() {
					mbr_uid_to_uuid(ida.id, uuid.as_mut_ptr())
				} else {
					mbr_gid_to_uuid(ida.id, uuid.as_mut_ptr())
				};
				if rc != 0 {
					return Err(io::Error::from_raw_os_error(rc));
				}
				if acl_set_tag_type(entry, tag) != 0
					|| acl_set_qualifier(entry, uuid.as_ptr().cast()) != 0
					|| acl_set_permset(entry, permset) != 0
					|| acl_set_flagset_np(entry, flagset) != 0
				{
					return Err(last());
				}
			}
			Ok(())
		}

		/// None: no explicit ACL (never returned on macOS; ENOENT is reported instead).
		pub(in super::super) fn read(tree: &Tree, rel: &Path, kind: AclKind) -> Result<Option<RsyncAcl>, ReadError> {
			if kind == AclKind::Default {
				return Err(ReadError::Get(io::Error::from_raw_os_error(libc::ENOTSUP)));
			}
			let names = tree
				.with_fd(rel, |fd| Ok(read_fd(fd.as_raw_fd())))
				.map_err(ReadError::Get)??;
			Ok(Some(RsyncAcl { names, ..RsyncAcl::default() }))
		}

		pub(in super::super) fn write(
			tree: &Tree,
			rel: &Path,
			kind: AclKind,
			acl: &RsyncAcl,
			cur_mode: u32,
			_new_mode: u32,
		) -> Result<u32, WriteError> {
			if kind == AclKind::Default {
				return Err(WriteError::Set(io::Error::from_raw_os_error(libc::ENOTSUP)));
			}
			tree.with_fd(rel, |fd| Ok(write_fd(fd.as_raw_fd(), &acl.names)))
				.map_err(WriteError::Set)??;
			Ok(cur_mode)
		}

		/// acl_delete_def_file is unsupported on macOS.
		pub(in super::super) fn delete_default(_tree: &Tree, _rel: &Path) -> io::Result<()> {
			Err(io::Error::from_raw_os_error(libc::ENOTSUP))
		}
	}

	#[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
	mod platform {
		use std::io;
		use std::path::Path;

		use super::super::{AclKind, RsyncAcl};
		use super::{ReadError, WriteError};
		use crate::rsync::tree::Tree;

		pub(in super::super) const GET_FN: &str = "sys_acl_get_file";
		pub(in super::super) const SET_FN: &str = "sys_acl_set_file";

		/// ENOTSUP (its portable kind where there is no errno): no ACL support here.
		fn unsupported() -> io::Error {
			#[cfg(unix)]
			return io::Error::from_raw_os_error(libc::ENOTSUP);
			#[cfg(not(unix))]
			return io::Error::from(io::ErrorKind::Unsupported);
		}

		pub(in super::super) fn read(_tree: &Tree, _rel: &Path, _kind: AclKind) -> Result<Option<RsyncAcl>, ReadError> {
			Err(ReadError::Get(unsupported()))
		}

		pub(in super::super) fn write(
			_tree: &Tree,
			_rel: &Path,
			_kind: AclKind,
			_acl: &RsyncAcl,
			_cur_mode: u32,
			_new_mode: u32,
		) -> Result<u32, WriteError> {
			Err(WriteError::Set(unsupported()))
		}

		pub(in super::super) fn delete_default(_tree: &Tree, _rel: &Path) -> io::Result<()> {
			Err(unsupported())
		}
	}
}

#[cfg(test)]
mod tests {
	use std::io::Cursor;

	use super::posix::*;
	use super::*;
	use crate::rsync::exit::RERR_PROTOCOL;

	/// Ids/names from the reference capture (uid 501 "can", gid 20 "staff");
	/// receiving maps uid u → u + 10000 and gid g → g + 20000.
	#[derive(Default)]
	struct FakeIds {
		sent_users: Vec<u32>,
		sent_groups: Vec<u32>,
		received_names: Vec<(u32, Vec<u8>)>,
	}

	impl AclIdMap for FakeIds {
		fn add_uid(&mut self, uid: u32) -> Option<Vec<u8>> {
			if self.sent_users.contains(&uid) {
				return None;
			}
			self.sent_users.push(uid);
			(uid == 501).then(|| b"can".to_vec())
		}

		fn add_gid(&mut self, gid: u32) -> Option<Vec<u8>> {
			if self.sent_groups.contains(&gid) {
				return None;
			}
			self.sent_groups.push(gid);
			(gid == 20).then(|| b"staff".to_vec())
		}

		fn recv_user_name(&mut self, r: &mut dyn Read, uid: u32) -> Result<u32, RsyncError> {
			let len = r.read_u8().map_err(RsyncError::from_stream)?;
			let name = r.read_bytes(len.into(), 255).map_err(RsyncError::from_stream)?;
			self.received_names.push((uid, name));
			Ok(uid + 10000)
		}

		fn recv_group_name(&mut self, r: &mut dyn Read, gid: u32) -> Result<u32, RsyncError> {
			let len = r.read_u8().map_err(RsyncError::from_stream)?;
			let name = r.read_bytes(len.into(), 255).map_err(RsyncError::from_stream)?;
			self.received_names.push((gid, name));
			Ok(gid + 20000)
		}

		fn match_uid(&mut self, uid: u32) -> u32 {
			uid + 10000
		}

		fn match_gid(&mut self, gid: u32) -> u32 {
			gid + 20000
		}
	}

	const DIR_MODE: u32 = 0o040755;
	const FILE_MODE: u32 = 0o100644;

	/// The macOS ACL `group:staff deny delete`, `user:can allow read,write`.
	fn osx_names() -> Vec<IdAccess> {
		vec![IdAccess { id: 20, access: 0x8000 }, IdAccess { id: 501, access: 0x3001 | NAME_IS_USER }]
	}

	/// `rsync -rA --only-write-batch` (3.5.1, macOS) for `.` (no ACL) then `a`.
	const GOLDEN_DIR: &[u8] = &[0x00, 0x00, 0x00, 0x00];
	const GOLDEN_A_INC: &[u8] = b"\x00\x10\x02\x14\xc2\x01\x00\x05staff\x81\xf5\xc0\x07\xc0\x03can";
	const GOLDEN_A_NO_INC: &[u8] = b"\x00\x10\x02\x14\xc2\x00\x00\x81\xf5\xc0\x06\xc0";

	fn osx_file() -> AclSet {
		AclSet { access: Some(RsyncAcl { names: osx_names(), ..RsyncAcl::default() }), default: None }
	}

	fn osx_dir() -> AclSet {
		AclSet { access: Some(RsyncAcl::default()), default: Some(RsyncAcl::default()) }
	}

	#[test]
	fn sender_matches_reference_bytes() {
		for (inc_recurse, golden) in [(true, GOLDEN_A_INC), (false, GOLDEN_A_NO_INC)] {
			let mut sender = AclSender::new(AclOpts { inc_recurse, ..AclOpts::default() });
			let mut ids = FakeIds::default();
			let mut out = Vec::new();
			sender.send(&mut out, &osx_dir(), DIR_MODE, &mut ids).unwrap();
			assert_eq!(out, GOLDEN_DIR);
			out.clear();
			sender.send(&mut out, &osx_file(), FILE_MODE, &mut ids).unwrap();
			assert_eq!(out, golden);
			out.clear();
			// Repeats are cache indices; names were registered for the id lists.
			sender.send(&mut out, &osx_file(), FILE_MODE, &mut ids).unwrap();
			assert_eq!(out, [0x02]);
			assert_eq!(ids.sent_users, [501]);
			assert_eq!(ids.sent_groups, [20]);
		}
	}

	#[test]
	fn numeric_ids_send_no_names() {
		let mut sender = AclSender::new(AclOpts { inc_recurse: true, numeric_ids: true, ..AclOpts::default() });
		let mut ids = FakeIds::default();
		let mut out = Vec::new();
		sender.send(&mut out, &osx_file(), FILE_MODE, &mut ids).unwrap();
		assert_eq!(out, GOLDEN_A_NO_INC);
		assert!(ids.sent_users.is_empty());
	}

	#[test]
	fn osx_receiver_decodes_reference_bytes() {
		let mut stream = GOLDEN_DIR.to_vec();
		stream.extend(GOLDEN_A_INC);
		stream.push(0x02);
		let mut r = Cursor::new(stream);
		let opts = AclOpts { inc_recurse: true, ..AclOpts::default() };
		let mut recv = AclReceiver::with_flavor(opts, 1 << 30, Flavor::Osx);
		let mut ids = FakeIds::default();
		assert_eq!(recv.recv(&mut r, DIR_MODE, &mut ids).unwrap(), (0, Some(0)));
		assert_eq!(recv.recv(&mut r, FILE_MODE, &mut ids).unwrap(), (1, None));
		assert_eq!(recv.recv(&mut r, FILE_MODE, &mut ids).unwrap(), (1, None));
		let acl = recv.access(1).unwrap();
		assert_eq!(acl.names, [IdAccess { id: 20020, access: 0x8000 }, IdAccess {
			id: 10501,
			access: 0x3001 | NAME_IS_USER
		}]);
		assert_eq!(acl.mask_obj, NO_ENTRY);
		assert_eq!(ids.received_names, [(20, b"staff".to_vec()), (501, b"can".to_vec())]);
	}

	#[test]
	fn posix_receiver_rejects_osx_access_words() {
		let mut recv = AclReceiver::with_flavor(AclOpts::default(), 0, Flavor::Posix);
		let err = recv.recv(&mut Cursor::new(GOLDEN_A_NO_INC.to_vec()), FILE_MODE, &mut FakeIds::default()).unwrap_err();
		assert_eq!(err.code, RERR_STREAMIO);
		assert_eq!(err.message.as_deref(), Some("recv_acl_access: value out of range: 8000"));
		// Fake-super stores whatever arrives.
		let opts = AclOpts { fake_super: true, ..AclOpts::default() };
		let mut recv = AclReceiver::with_flavor(opts, 0, Flavor::Posix);
		recv.recv(&mut Cursor::new(GOLDEN_A_NO_INC.to_vec()), FILE_MODE, &mut FakeIds::default()).unwrap();
	}

	#[test]
	fn receiver_rejects_bad_indices_and_counts() {
		let mut recv = AclReceiver::with_flavor(AclOpts::default(), 0, Flavor::Posix);
		let err = recv.recv(&mut Cursor::new([0x03u8]), FILE_MODE, &mut FakeIds::default()).unwrap_err();
		assert_eq!(err.code, RERR_STREAMIO);
		assert_eq!(err.message.as_deref(), Some("recv_acl_index: ACL_TYPE_ACCESS ACL index 3 > 0"));

		// count 65537
		let err = recv
			.recv(&mut Cursor::new([0x00, XMIT_NAME_LIST, 0xc1, 0x01, 0x00]), FILE_MODE, &mut FakeIds::default())
			.unwrap_err();
		assert_eq!(err.code, RERR_PROTOCOL);
		assert_eq!(err.message.as_deref(), Some("wire value ACL count out of range: 65537 not in [0,65536] [receiver]"));

		let mut small = AclReceiver::with_flavor(AclOpts::default(), 16, Flavor::Posix);
		let err = small
			.recv(&mut Cursor::new([0x00, XMIT_NAME_LIST, 0x02]), FILE_MODE, &mut FakeIds::default())
			.unwrap_err();
		assert_eq!(err.message.as_deref(), Some("[receiver] exceeded --max-alloc=16 setting (file=acls.c, line=932)"));

		let err = recv
			.recv(&mut Cursor::new([0x00, XMIT_USER_OBJ]), FILE_MODE, &mut FakeIds::default())
			.unwrap_err();
		assert_eq!(err.code, RERR_STREAMIO, "EOF");
	}

	fn posix_access() -> RsyncAcl {
		RsyncAcl {
			names: vec![IdAccess { id: 1000, access: 7 | NAME_IS_USER }, IdAccess { id: 100, access: 5 }],
			user_obj: 6,
			group_obj: 4,
			mask_obj: 7,
			other_obj: 4,
		}
	}

	fn posix_default() -> RsyncAcl {
		RsyncAcl {
			names: vec![IdAccess { id: 100, access: 7 }],
			user_obj: 7,
			group_obj: 5,
			mask_obj: 7,
			other_obj: 0,
		}
	}

	#[test]
	fn posix_round_trip_with_access_and_default_acls() {
		let mode = 0o040774; // group bits rwx == the mask
		let set = AclSet { access: Some(posix_access()), default: Some(posix_default()) };
		let mut sender = AclSender::new(AclOpts::default());
		let mut out = Vec::new();
		sender.send(&mut out, &set, mode, &mut FakeIds::default()).unwrap();
		sender.send(&mut out, &set, mode, &mut FakeIds::default()).unwrap();

		let mut recv = AclReceiver::with_flavor(AclOpts::default(), 0, Flavor::Posix);
		let mut r = Cursor::new(out);
		assert_eq!(recv.recv(&mut r, mode, &mut FakeIds::default()).unwrap(), (0, Some(0)));
		assert_eq!(recv.recv(&mut r, mode, &mut FakeIds::default()).unwrap(), (0, Some(0)));
		assert_eq!(r.position() as usize, r.get_ref().len());

		// The access ACL travels condensed; the mask comes back from the group bits.
		let access = recv.access(0).unwrap();
		assert_eq!(access.user_obj, NO_ENTRY);
		assert_eq!(access.group_obj, 4);
		assert_eq!(access.mask_obj, 7);
		assert_eq!(access.other_obj, NO_ENTRY);
		assert_eq!(access.names, posix_access().names);
		assert_eq!(recv.default_acl(0).unwrap(), &posix_default());

		// Received data matches the original locally.
		let wanted = recv.get(Some(0), Some(0));
		assert!(!differs(&set, &wanted, mode));
		let mut other = set.clone();
		other.access.as_mut().unwrap().names[1].access = 4;
		assert!(differs(&other, &wanted, mode));
		let mut other = set.clone();
		other.default = Some(RsyncAcl::default());
		assert!(differs(&other, &wanted, mode));
		assert!(!differs(&other, &wanted, 0o100774), "default ACLs only matter for directories");
	}

	#[test]
	fn posix_receiver_computes_missing_masks() {
		// Access: names but no mask → mask from the mode's group bits.
		let wire = [0x00, XMIT_NAME_LIST, 0x01, 0x81, 0xf4, (5 << 2) | 2];
		let mut recv = AclReceiver::with_flavor(AclOpts::default(), 0, Flavor::Posix);
		recv.recv(&mut Cursor::new(wire), 0o100650, &mut FakeIds::default()).unwrap();
		assert_eq!(recv.access(0).unwrap().mask_obj, 5);
		// Default: union of the named entries and the group object.
		let dir = [
			0x00,
			0x00,
			0x00,
			XMIT_USER_OBJ | XMIT_GROUP_OBJ | XMIT_OTHER_OBJ | XMIT_NAME_LIST,
			7,
			1,
			0,
			0x01,
			0x64,
			4 << 2,
		];
		recv.recv(&mut Cursor::new(dir), 0o040700, &mut FakeIds::default()).unwrap();
		assert_eq!(recv.default_acl(0).unwrap().mask_obj, 5);
	}

	#[test]
	fn names_without_inc_recursion_are_remapped_after_the_id_lists() {
		let mut out = Vec::new();
		AclSender::new(AclOpts::default())
			.send(&mut out, &osx_file(), FILE_MODE, &mut FakeIds::default())
			.unwrap();
		let mut recv = AclReceiver::with_flavor(AclOpts::default(), 0, Flavor::Osx);
		recv.recv(&mut Cursor::new(out), FILE_MODE, &mut FakeIds::default()).unwrap();
		assert_eq!(recv.access(0).unwrap().names, osx_names(), "ids kept until the lists arrive");
		recv.remap_ids(&mut FakeIds::default());
		let ids: Vec<u32> = recv.access(0).unwrap().names.iter().map(|ida| ida.id).collect();
		assert_eq!(ids, [20020, 10501]);
	}

	#[test]
	fn strip_and_compare_follow_mode_bits() {
		let mut acl = posix_access();
		acl.strip_perms(0o100674);
		assert_eq!((acl.user_obj, acl.group_obj, acl.mask_obj, acl.other_obj), (NO_ENTRY, 4, NO_ENTRY, NO_ENTRY));
		let mut plain = RsyncAcl::fake_perms(0o100640);
		plain.strip_perms(0o100640);
		assert_eq!(plain, RsyncAcl::default());

		let full = posix_access();
		let mut condensed = full.clone();
		condensed.strip_perms(0o100674);
		condensed.mask_obj = 7; // the receiver restores the mask from the mode
		assert!(full.equal_enough(&condensed, 0o100674));
		// A condensed ACL without group_obj means it equaled the mode's group bits.
		let mut no_group = condensed.clone();
		no_group.group_obj = NO_ENTRY;
		assert!(full.equal_enough(&no_group, 0o100644));
		assert!(!full.equal_enough(&no_group, 0o100654));
		assert!(!full.equal_enough(&RsyncAcl::default(), 0o100644), "mask presence differs");
		assert_eq!(acl_mode_bits(&full), 0o674);
		assert_eq!(acl_mode_bits(&RsyncAcl::fake_perms(0o751)), 0o751);
	}

	#[test]
	fn posix_xattr_blob_conversions() {
		let entries = [
			PosixEntry { tag: RACL_OTHER, perm: 4, id: RACL_UNDEFINED_ID },
			PosixEntry { tag: RACL_GROUP, perm: 5, id: 100 },
			PosixEntry { tag: RACL_USER, perm: 7, id: 1000 },
			PosixEntry { tag: RACL_USER_OBJ, perm: 6, id: RACL_UNDEFINED_ID },
			PosixEntry { tag: RACL_MASK, perm: 7, id: RACL_UNDEFINED_ID },
			PosixEntry { tag: RACL_GROUP_OBJ, perm: 4, id: 0 },
			PosixEntry { tag: RACL_USER, perm: 5, id: 7 },
		];
		let blob = encode_posix_acl_xattr(&entries);
		assert_eq!(&blob[..4], &[2, 0, 0, 0]);
		assert_eq!(blob.len(), 4 + 7 * 8);
		// Canonical order; the id of an object entry is always undefined.
		assert_eq!(&blob[4..12], &[0x01, 0, 6, 0, 0xff, 0xff, 0xff, 0xff]);
		assert_eq!(&blob[12..20], &[0x02, 0, 5, 0, 7, 0, 0, 0]);
		assert_eq!(&blob[28..36], &[0x04, 0, 4, 0, 0xff, 0xff, 0xff, 0xff]);
		let parsed = parse_posix_acl_xattr(&blob).unwrap();
		assert_eq!(parsed.len(), 7);
		let acl = posix_entries_to_acl(&parsed);
		assert_eq!((acl.user_obj, acl.group_obj, acl.mask_obj, acl.other_obj), (6, 4, 7, 4));
		assert_eq!(acl.names, [
			IdAccess { id: 7, access: 5 | NAME_IS_USER },
			IdAccess { id: 1000, access: 7 | NAME_IS_USER },
			IdAccess { id: 100, access: 5 },
		]);
		// And back: the packed entries serialize to the same blob.
		assert_eq!(encode_posix_acl_xattr(&acl_to_posix_entries(&acl)), blob);

		assert!(parse_posix_acl_xattr(&[2, 0, 0]).is_none());
		assert!(parse_posix_acl_xattr(&[1, 0, 0, 0]).is_none());
		assert!(parse_posix_acl_xattr(&[2, 0, 0, 0, 1]).is_none());
		assert_eq!(parse_posix_acl_xattr(&[2, 0, 0, 0]).unwrap(), []);
	}

	#[test]
	fn posix_entry_unpacking_ignores_duplicates_and_unknown_tags() {
		let acl = posix_entries_to_acl(&[
			PosixEntry { tag: RACL_USER_OBJ, perm: 7, id: RACL_UNDEFINED_ID },
			PosixEntry { tag: RACL_USER_OBJ, perm: 0, id: RACL_UNDEFINED_ID },
			PosixEntry { tag: 0x40, perm: 7, id: 3 },
			PosixEntry { tag: RACL_GROUP, perm: 0o17, id: 9 },
		]);
		assert_eq!(acl.user_obj, 7);
		assert_eq!(acl.names, [IdAccess { id: 9, access: 7 }]);
		assert_eq!(acl.other_obj, NO_ENTRY);
	}

	#[test]
	fn packing_fills_condensed_objects_from_the_mode() {
		let mut condensed = posix_access();
		condensed.strip_perms(0o100674);
		condensed.mask_obj = 7; // as received: the mask is restored from the mode
		let mut entries = acl_to_posix_entries(&condensed);
		let mode = apply_mode_to_entries(&mut entries, &condensed, 0o100600, 0o100674);
		assert_eq!(mode, 0o100674);
		let acl = posix_entries_to_acl(&entries);
		assert_eq!((acl.user_obj, acl.group_obj, acl.mask_obj, acl.other_obj), (6, 4, 7, 4));

		// setgid turning off: group/other stay closed until the chmod.
		let mut entries = acl_to_posix_entries(&condensed);
		let mode = apply_mode_to_entries(&mut entries, &condensed, 0o102600, 0o100674);
		assert_eq!(mode, 0o102600);
		assert_eq!(posix_entries_to_acl(&entries).other_obj, 0);
		// sticky turning on for a directory does the same.
		let mut entries = acl_to_posix_entries(&condensed);
		assert_eq!(apply_mode_to_entries(&mut entries, &condensed, 0o040755, 0o041775), 0o040700);
	}

	#[test]
	fn fake_super_blob_round_trip() {
		let mut acl = posix_access();
		acl.strip_perms(0o100674);
		let blob = encode_fake_acl(&acl);
		assert_eq!(&blob[..16], &[0x80, 0, 0, 0, 4, 0, 0, 0, 0x80, 0, 0, 0, 0x80, 0, 0, 0]);
		assert_eq!(&blob[16..24], &[0xe8, 0x03, 0, 0, 7, 0, 0, 0x80]);
		let back = decode_fake_acl(&blob, 0o100674).unwrap();
		assert_eq!((back.user_obj, back.group_obj, back.mask_obj, back.other_obj), (6, 4, NO_ENTRY, 4));
		assert_eq!(back.names, acl.names);
		assert!(decode_fake_acl(&blob[..20], 0).is_none());
		assert!(decode_fake_acl(&blob[..12], 0).is_none());
	}
}
