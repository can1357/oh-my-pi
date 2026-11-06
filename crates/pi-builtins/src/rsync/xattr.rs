//! Extended attributes (`-X`): reading and applying them locally under rsync's
//! namespace rules, and their file-list wire codec (a per-connection cache of
//! already-sent sets, abbreviation of long values to a digest, and the
//! request/answer exchange that fetches abbreviated values on demand).
//!
//! Every [`XattrSet`] holds *local* names: the sender translates them into
//! the peer's namespace while encoding, and the receiver translates incoming
//! names into its own namespace while decoding.
//!
//! Local access goes through the [`Tree`] xattr operations on every platform; where
//! the filesystem has no xattrs (Windows host paths) a read yields an empty set and a
//! write fails, as an upstream build sees `ENOTSUP`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::io::{self, Read, Write};
use std::path::Path;

use md5::{Digest, Md5};

use crate::rsync::ids::effective_uid;
use crate::rsync::consts::{mode_is_device, mode_is_dir, mode_is_lnk, mode_is_reg, mode_is_special};
use crate::rsync::exit::{RERR_FILEIO, RERR_MALLOC, RERR_PROTOCOL, RERR_STREAMIO, RsyncError};
use crate::rsync::log::{LogCode, Logger, Role, big_num};
use crate::rsync::meta::full_fname;
use crate::rsync::paths::bytes_os;
use crate::rsync::tree::Tree;
use crate::rsync::wire::{Proto, ReadExt, WriteExt};

/// Values longer than this travel as a digest until the receiver asks for them.
pub(crate) const MAX_FULL_DATUM: usize = 32;
/// Length of the digest that stands in for an abbreviated value (MD5).
pub(crate) const XATTR_SUM_LEN: usize = 16;

const MAX_WIRE_XATTR_COUNT: i32 = 65536;
const MAX_WIRE_XATTR_NAMELEN: i32 = 4096;
const MAX_WIRE_XATTR_DATALEN: i32 = i32::MAX;
const MAX_XATTR_LIST_BYTES: u64 = 512 * 1024 * 1024;
const MAX_XATTR_VALUE_BYTES: u64 = 128 * 1024 * 1024;

const USER_PREFIX: &[u8] = b"user.";
const SYSTEM_PREFIX: &[u8] = b"system.";

/// True where the OS exposes namespaced names (`user.`, `trusted.`, …); other
/// platforms have a single flat (user) namespace.
pub(crate) const LINUX_XATTRS: bool =
	cfg!(any(target_os = "linux", target_os = "android", target_os = "netbsd"));
/// macOS cannot hold xattrs on device and special files.
const NO_DEVICE_SPECIAL_XATTRS: bool = cfg!(target_vendor = "apple");

/// Prefix under which rsync stores foreign-namespace and internal attributes.
const RSYNC_PREFIX: &[u8] = if LINUX_XATTRS { b"user.rsync." } else { b"rsync." };

/// Fake-super attribute names (`<prefix>%stat`, `%aacl`, `%dacl`).
pub(crate) fn rsync_internal_name(suffix: &[u8]) -> Vec<u8> {
	let mut name = RSYNC_PREFIX.to_vec();
	name.push(b'%');
	name.extend_from_slice(suffix);
	name
}

/// "No such attribute" (ENODATA on Linux, ENOATTR on the BSDs/macOS).
fn no_attr() -> io::Error {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	return io::Error::from_raw_os_error(libc::ENODATA);
	#[cfg(all(unix, not(any(target_os = "linux", target_os = "android"))))]
	return io::Error::from_raw_os_error(libc::ENOATTR);
	#[cfg(not(unix))]
	return io::Error::from(io::ErrorKind::NotFound);
}

/// ENOTSUP, or its portable kind where there is no errno.
fn not_supported() -> io::Error {
	#[cfg(unix)]
	return io::Error::from_raw_os_error(libc::ENOTSUP);
	#[cfg(not(unix))]
	return io::Error::from(io::ErrorKind::Unsupported);
}

/// Listed attribute names as bytes (names the platform cannot express as bytes are skipped).
fn name_bytes(names: Vec<OsString>) -> impl Iterator<Item = Vec<u8>> {
	names.into_iter().filter_map(|name| crate::host::os_bytes(&name).map(<[u8]>::to_vec))
}

/// One file's xattrs, sorted by name (local names; see the module docs).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct XattrSet {
	pub items: Vec<(Vec<u8>, Vec<u8>)>,
	/// Parallel to `items` (empty when nothing is abbreviated): `Some(len)` marks an item
	/// whose value in `items` is the MD5 digest standing in for a `len`-byte value
	/// the sender has not transmitted (yet).
	pub abbrev: Vec<Option<u64>>,
}

impl XattrSet {
	/// Full length of item `i` when its value is still abbreviated.
	pub(crate) fn abbreviated_len(&self, i: usize) -> Option<u64> {
		self.abbrev.get(i).copied().flatten()
	}

	/// The value's real length (abbreviated or not).
	fn full_len(&self, i: usize) -> u64 {
		self.abbreviated_len(i).unwrap_or_else(|| self.items[i].1.len() as u64)
	}

	fn set_resolved(&mut self, i: usize, value: Vec<u8>) {
		self.items[i].1 = value;
		if let Some(slot) = self.abbrev.get_mut(i) {
			*slot = None;
		}
		if self.abbrev.iter().all(Option::is_none) {
			self.abbrev.clear();
		}
	}

	/// Value of the item called `name`, when present and not abbreviated.
	pub(crate) fn value(&self, name: &[u8]) -> Option<&[u8]> {
		self.items
			.iter()
			.enumerate()
			.find(|(i, (n, _))| n == name && self.abbreviated_len(*i).is_none())
			.map(|(_, (_, v))| v.as_slice())
	}
}

/// Namespace and preservation policy.
#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct XattrOpts {
	/// `-XX`: also copy rsync's internal `%` attributes.
	pub all_namespaces: bool,
	pub fake_super: bool,
	/// Running as root, or `--super`.
	pub am_root: bool,
	/// This side builds the file list (the sending side).
	pub am_sender: bool,
	pub preserve_links: bool,
	pub preserve_devices: bool,
	pub preserve_specials: bool,
	pub dry_run: bool,
}

impl XattrOpts {
	/// Upstream's tri-state root level: -1 fake-super, 1 root, 0 otherwise.
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

/// Optional collaborators for the local operations: the `x`-modifier filter rules
/// (`filter(name)` returns true when the name is excluded; its mere presence replaces
/// the namespace screening, as upstream does once any xattr rule exists), a logger for
/// upstream-formatted diagnostics, and the basis file abbreviated values are taken from.
#[derive(Clone, Copy, Default)]
pub(crate) struct XattrCtx<'a> {
	pub filter: Option<&'a dyn Fn(&[u8]) -> bool>,
	pub logger: Option<&'a Logger>,
	/// Where abbreviated values are looked up when applying (default: the target itself).
	pub basis: Option<(&'a Tree, &'a Path)>,
	/// The generator leaves unresolvable abbreviated values to the receiver silently.
	pub am_generator: bool,
	/// The target's current `st_mode`, when the caller already has it.
	pub local_mode: Option<u32>,
}

/// What [`apply_with`] did (per-item failures are reported through the logger).
#[derive(Debug, Default)]
pub(crate) struct XattrApplied {
	/// Abbreviated items whose full value was found at the basis: (index, value).
	pub resolved: Vec<(usize, Vec<u8>)>,
}

// ---------------------------------------------------------------------------
// Namespace rules

/// Name-translation rules for one side of a transfer on one platform.
#[derive(Clone, Copy, Debug)]
struct Ns {
	linux: bool,
	root: i32,
	sender: bool,
	all: bool,
}

impl Ns {
	fn new(opts: &XattrOpts, linux: bool) -> Self {
		Self { linux, root: opts.root_level(), sender: opts.am_sender, all: opts.all_namespaces }
	}

	fn prefix(self) -> &'static [u8] {
		if self.linux { b"user.rsync." } else { b"rsync." }
	}

	/// The `%suffix` of an rsync-internal name.
	fn internal_suffix(self, name: &[u8]) -> Option<&[u8]> {
		let plen = self.prefix().len();
		(name.len() > plen && name[plen] == b'%' && name.starts_with(self.prefix()))
			.then(|| &name[plen + 1..])
	}

	/// True when a listed local name is skipped by filter rules or namespace screening.
	fn screened(self, name: &[u8], filter: Option<&dyn Fn(&[u8]) -> bool>, user_only: bool) -> bool {
		match filter {
			Some(excluded) => excluded(name),
			None if self.linux => {
				if user_only {
					!name.starts_with(USER_PREFIX)
				} else {
					name.starts_with(SYSTEM_PREFIX)
				}
			},
			None => false,
		}
	}

	/// Whether a local name belongs in a set read from disk.
	fn keep_local(self, name: &[u8], filter: Option<&dyn Fn(&[u8]) -> bool>) -> bool {
		let user_only = !self.sender && self.root == 0;
		if self.screened(name, filter, user_only) {
			return false;
		}
		self.internal_suffix(name).is_none_or(|suffix| {
			!((self.sender && !self.all)
				|| (self.root < 0 && matches!(suffix, b"stat" | b"aacl" | b"dacl")))
		})
	}

	/// Sender: local name → wire name.
	fn to_wire(self, name: &[u8]) -> Vec<u8> {
		let prefix = self.prefix();
		if name.len() >= prefix.len()
			&& (!self.linux || self.root < 0)
			&& name.get(prefix.len()) != Some(&b'%')
			&& name.starts_with(prefix)
		{
			name[prefix.len()..].to_vec()
		} else if !self.linux {
			[USER_PREFIX, name].concat()
		} else {
			name.to_vec()
		}
	}

	/// Receiver: wire name → local name (None = dropped), plus whether it was prefixed.
	fn from_wire(self, name: &[u8], filter: Option<&dyn Fn(&[u8]) -> bool>) -> Option<(Vec<u8>, bool)> {
		if filter.is_some_and(|excluded| excluded(name)) {
			return None;
		}
		let (local, prefixed) = if self.linux {
			if self.root <= 0 && !name.starts_with(USER_PREFIX) {
				if self.root == 0 && filter.is_none() {
					return None;
				}
				([self.prefix(), name].concat(), true)
			} else {
				(name.to_vec(), false)
			}
		} else if let Some(rest) = name.strip_prefix(USER_PREFIX) {
			(rest.to_vec(), false)
		} else if self.root != 0 {
			([self.prefix(), name].concat(), true)
		} else {
			return None;
		};
		if !self.all && self.internal_suffix(&local).is_some() {
			return None;
		}
		Some((local, prefixed))
	}
}

// ---------------------------------------------------------------------------
// Helpers shared with acl.rs

/// MD5 of an xattr value (the abbreviation digest for protocol ≥ 30, which `-X` requires).
pub(crate) fn xattr_digest(value: &[u8]) -> [u8; XATTR_SUM_LEN] {
	Md5::digest(value).into()
}

/// The `--max-alloc` guard upstream applies in its allocator.
pub(crate) fn alloc_check(
	max_alloc: u64,
	num: u64,
	size: u64,
	role: Role,
	file: &'static str,
	line: u32,
) -> Result<(), RsyncError> {
	if max_alloc != 0 && num >= max_alloc / size.max(1) {
		let limit = big_num(i64::try_from(max_alloc).unwrap_or(i64::MAX), 0);
		return Err(RsyncError::new(
			RERR_MALLOC,
			format!(
				"[{}] exceeded --max-alloc={limit} setting (file={file}, line={line})",
				role.name()
			),
		)
		.at("util2.c", 80));
	}
	Ok(())
}

/// `read_varint_bounded`: a varint in `lo..=hi`, else a protocol error.
pub(crate) fn read_varint_bounded(
	r: &mut dyn Read,
	lo: i32,
	hi: i32,
	what: &str,
	role: Role,
) -> Result<i32, RsyncError> {
	let v = r.read_varint().map_err(RsyncError::from_stream)?;
	if v < lo || v > hi {
		return Err(RsyncError::new(
			RERR_PROTOCOL,
			format!("wire value {what} out of range: {v} not in [{lo},{hi}] [{}]", role.name()),
		)
		.at("io.c", 2118));
	}
	Ok(v)
}

/// `read_varint_size`: a non-negative varint no larger than `max`.
pub(crate) fn read_varint_size(
	r: &mut dyn Read,
	max: i32,
	what: &str,
	role: Role,
) -> Result<usize, RsyncError> {
	let v = r.read_varint().map_err(RsyncError::from_stream)?;
	match usize::try_from(v) {
		Ok(size) if v <= max => Ok(size),
		_ => Err(RsyncError::new(
			RERR_PROTOCOL,
			format!("wire size {what} out of range: {v} > {max} [{}]", role.name()),
		)
		.at("io.c", 2131)),
	}
}

fn read_exact_vec(r: &mut dyn Read, len: usize) -> Result<Vec<u8>, RsyncError> {
	r.read_bytes(len, len).map_err(RsyncError::from_stream)
}

fn varint_len(len: u64) -> io::Result<i32> {
	i32::try_from(len).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "xattr too large for the wire"))
}

/// Errno-style errors a filesystem reports when it has no xattrs at all.
fn is_unsupported(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(unix)]
	{
		matches!(err.raw_os_error(), Some(e) if e == libc::ENOTSUP || e == libc::EOPNOTSUPP)
	}
	#[cfg(not(unix))]
	{
		false
	}
}

/// File types that carry xattrs under the current options.
fn type_carries_xattrs(mode: u32, opts: &XattrOpts) -> bool {
	if mode == 0 {
		false
	} else if mode_is_reg(mode) || mode_is_dir(mode) {
		true
	} else if mode_is_lnk(mode) {
		opts.preserve_links
	} else if mode_is_special(mode) {
		opts.preserve_specials && !NO_DEVICE_SPECIAL_XATTRS
	} else if mode_is_device(mode) {
		opts.preserve_devices && !NO_DEVICE_SPECIAL_XATTRS
	} else {
		false
	}
}

fn local_mode(tree: &Tree, rel: &Path, follow: bool) -> io::Result<Option<u32>> {
	let meta = if follow { tree.stat(rel) } else { tree.lstat(rel) };
	match meta {
		Ok(meta) => Ok(Some(meta.mode())),
		Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(err) => Err(err),
	}
}

fn list_names(
	tree: &Tree,
	rel: &Path,
	follow: bool,
	logger: Option<&Logger>,
) -> io::Result<Vec<Vec<u8>>> {
	match tree.list_xattr(rel, follow) {
		Ok(names) => Ok(name_bytes(names).collect()),
		Err(err) if is_unsupported(&err) => Ok(Vec::new()),
		Err(err) => {
			if let Some(logger) = logger {
				let mut text = b"get_xattr_names: llistxattr(".to_vec();
				text.extend(full_fname(tree, rel));
				text.extend_from_slice(b",1,024) failed");
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
			}
			Err(err)
		},
	}
}

fn get_value(
	tree: &Tree,
	rel: &Path,
	name: &[u8],
	follow: bool,
	logger: Option<&Logger>,
) -> io::Result<Vec<u8>> {
	let err = match tree.get_xattr(rel, bytes_os(name)?, follow) {
		Ok(Some(value)) => return Ok(value),
		Ok(None) => no_attr(),
		Err(err) => err,
	};
	if !is_unsupported(&err)
		&& let Some(logger) = logger
	{
		let mut text = b"get_xattr_data: lgetxattr(".to_vec();
		text.extend(full_fname(tree, rel));
		text.extend_from_slice(b",\"");
		text.extend_from_slice(name);
		text.extend_from_slice(b"\",0) failed");
		logger.rsyserr(LogCode::ErrorXfer, &err, &text);
	}
	Err(err)
}

/// "f" for ops through a held descriptor (regular files, directories), "l" otherwise.
fn op_prefix(mode: u32) -> &'static [u8] {
	if mode_is_reg(mode) || mode_is_dir(mode) { b"f" } else { b"l" }
}

// ---------------------------------------------------------------------------
// Local read / apply / copy

/// Reads `rel`'s xattrs (sorted by name) under the namespace rules for this side,
/// given its `st_mode` when known (skips a stat), filter rules, and logging.
pub(crate) fn read_local_with(
	tree: &Tree,
	rel: &Path,
	mode: Option<u32>,
	follow: bool,
	opts: XattrOpts,
	ctx: XattrCtx<'_>,
) -> io::Result<XattrSet> {
	read_local_ns(tree, rel, mode, follow, &opts, Ns::new(&opts, LINUX_XATTRS), ctx)
}

fn read_local_ns(
	tree: &Tree,
	rel: &Path,
	mode: Option<u32>,
	follow: bool,
	opts: &XattrOpts,
	ns: Ns,
	ctx: XattrCtx<'_>,
) -> io::Result<XattrSet> {
	let mode = match mode {
		Some(mode) => mode,
		None => local_mode(tree, rel, follow)?.unwrap_or(0),
	};
	if !type_carries_xattrs(mode, opts) {
		return Ok(XattrSet::default());
	}
	let mut items = Vec::new();
	for name in list_names(tree, rel, follow, ctx.logger)? {
		if !ns.keep_local(&name, ctx.filter) {
			continue;
		}
		let value = get_value(tree, rel, &name, follow, ctx.logger)?;
		items.push((name, value));
	}
	items.sort_by(|a, b| a.0.cmp(&b.0));
	Ok(XattrSet { items, abbrev: Vec::new() })
}

/// Applies `set` to `rel`: writes every wanted value and removes local names the set
/// lacks (within the namespaces this side manages), honoring filter rules, a basis for
/// abbreviated values, and the generator/receiver distinction. Per-item failures are
/// logged; `Err` only when the target cannot be examined.
pub(crate) fn apply_with(
	tree: &Tree,
	rel: &Path,
	set: &XattrSet,
	follow: bool,
	opts: XattrOpts,
	ctx: XattrCtx<'_>,
) -> io::Result<XattrApplied> {
	apply_ns(tree, rel, set, follow, &opts, Ns::new(&opts, LINUX_XATTRS), ctx)
}

fn apply_ns(
	tree: &Tree,
	rel: &Path,
	set: &XattrSet,
	follow: bool,
	opts: &XattrOpts,
	ns: Ns,
	ctx: XattrCtx<'_>,
) -> io::Result<XattrApplied> {
	let mut out = XattrApplied::default();
	if opts.dry_run {
		return Ok(out);
	}
	let mode = match ctx.local_mode {
		Some(mode) => mode,
		None => local_mode(tree, rel, follow)?.ok_or_else(|| io::Error::from(io::ErrorKind::NotFound))?,
	};
	if NO_DEVICE_SPECIAL_XATTRS && (mode_is_special(mode) || mode_is_device(mode)) {
		return Err(not_supported());
	}

	// Without write permission the attributes cannot change; add it temporarily.
	let mut restore_mode = None;
	if ns.root == 0
		&& !mode_is_lnk(mode)
		&& lacks_owner_write(tree, rel, follow, mode)
		&& tree.chmod(rel, (mode & 0o7777) | 0o200).is_ok()
	{
		restore_mode = Some(mode & 0o7777);
	}

	let result = apply_items(tree, rel, set, follow, ns, mode, ctx, &mut out);
	if let Some(mode) = restore_mode {
		let _ = tree.chmod(rel, mode);
	}
	result.map(|()| out)
}

/// Whether we own `rel` but its owner-write bit is off (the only case a chmod can fix).
fn lacks_owner_write(tree: &Tree, rel: &Path, follow: bool, mode: u32) -> bool {
	if mode & 0o200 != 0 {
		return false;
	}
	let meta = if follow { tree.stat(rel) } else { tree.lstat(rel) };
	// Windows has no POSIX owners (no effective uid): there is no write bit to borrow.
	meta.ok().and_then(|meta| meta.uid()).is_some_and(|uid| Some(uid) == effective_uid())
}

#[allow(clippy::too_many_arguments, reason = "internal worker of apply_ns")]
fn apply_items(
	tree: &Tree,
	rel: &Path,
	set: &XattrSet,
	follow: bool,
	ns: Ns,
	mode: u32,
	ctx: XattrCtx<'_>,
	out: &mut XattrApplied,
) -> io::Result<()> {
	let listed = list_names(tree, rel, follow, ctx.logger)?;
	let (basis_tree, basis_rel) = ctx.basis.unwrap_or((tree, rel));
	let basis_is_target = ctx.basis.is_none();
	let fail = |err: io::Error, verb: &[u8], name: &[u8]| {
		if let Some(logger) = ctx.logger {
			let mut text = b"rsync_xal_set: ".to_vec();
			text.extend_from_slice(op_prefix(mode));
			text.extend_from_slice(verb);
			text.push(b'(');
			text.extend(full_fname(tree, rel));
			text.extend_from_slice(b",\"");
			text.extend_from_slice(name);
			text.extend_from_slice(b"\") failed");
			logger.rsyserr(LogCode::ErrorXfer, &err, &text);
		}
	};

	for (i, (name, value)) in set.items.iter().enumerate() {
		let os = match bytes_os(name) {
			Ok(os) => os,
			Err(err) => {
				fail(err, b"setxattr", name);
				continue;
			},
		};
		if let Some(full_len) = set.abbreviated_len(i) {
			let found = basis_tree
				.get_xattr(basis_rel, os, follow)
				.ok()
				.flatten()
				.filter(|data| data.len() as u64 == full_len && xattr_digest(data)[..] == value[..]);
			let Some(data) = found else {
				if ctx.am_generator {
					continue;
				}
				if let Some(logger) = ctx.logger {
					let mut text = b"Missing abbreviated xattr value, ".to_vec();
					text.extend_from_slice(name);
					text.extend_from_slice(b", for ");
					text.extend(full_fname(tree, rel));
					text.push(b'\n');
					logger.rprintf(LogCode::Error, &text);
				}
				continue;
			};
			if !basis_is_target && let Err(err) = tree.set_xattr(rel, os, &data, follow) {
				fail(err, b"setxattr", name);
			}
			if !ctx.am_generator {
				out.resolved.push((i, data));
			}
			continue;
		}
		if let Err(err) = tree.set_xattr(rel, os, value, follow) {
			fail(err, b"setxattr", name);
		}
	}

	let xstat = [ns.prefix(), b"%stat"].concat();
	for name in listed {
		if ns.screened(&name, ctx.filter, ns.root <= 0) {
			continue;
		}
		if ns.root < 0 && name == xstat {
			continue;
		}
		if set.items.iter().any(|(wanted, _)| *wanted == name) {
			continue;
		}
		if let Err(err) = bytes_os(&name).and_then(|os| tree.remove_xattr(rel, os, follow)) {
			fail(err, b"removexattr", &name);
		}
	}
	Ok(())
}

/// copy_xattrs: copies every (namespace-screened) xattr of `src` onto `dst` verbatim,
/// e.g. for backups and `--copy-dest` basis copies.
pub(crate) fn copy_local(
	src: (&Tree, &Path),
	dst: (&Tree, &Path),
	follow: bool,
	opts: XattrOpts,
	ctx: XattrCtx<'_>,
) -> io::Result<()> {
	let ns = Ns::new(&opts, LINUX_XATTRS);
	let (src_tree, src_rel) = src;
	let (dst_tree, dst_rel) = dst;
	let user_only = !ns.sender && ns.root <= 0;
	let dst_mode = local_mode(dst_tree, dst_rel, follow)?.unwrap_or(0);
	for name in list_names(src_tree, src_rel, follow, ctx.logger)? {
		if ns.screened(&name, ctx.filter, user_only) {
			continue;
		}
		let value = get_value(src_tree, src_rel, &name, follow, ctx.logger)?;
		if let Err(err) = bytes_os(&name).and_then(|os| dst_tree.set_xattr(dst_rel, os, &value, follow)) {
			if let Some(logger) = ctx.logger {
				let mut text = b"copy_xattrs: ".to_vec();
				text.extend_from_slice(op_prefix(dst_mode));
				text.extend_from_slice(b"setxattr(");
				text.extend(full_fname(dst_tree, dst_rel));
				text.extend_from_slice(b",\"");
				text.extend_from_slice(&name);
				text.extend_from_slice(b"\") failed");
				logger.rsyserr(LogCode::ErrorXfer, &err, &text);
			}
			return Err(err);
		}
	}
	Ok(())
}

/// The merge walk behind `xattr_diff`. With `states` (generator), abbreviated items
/// that differ are flagged for request.
fn diff_sets(snd: &XattrSet, mut states: Option<&mut [XState]>, rec: &XattrSet, find_all: bool) -> bool {
	let mut equal = snd.items.len() == rec.items.len();
	if !equal && !find_all {
		return true;
	}
	let (mut i, mut j) = (0, 0);
	while i < snd.items.len() {
		let (snd_name, snd_value) = &snd.items[i];
		let cmp = match rec.items.get(j) {
			Some((rec_name, _)) => snd_name.cmp(rec_name),
			None => std::cmp::Ordering::Less,
		};
		let same = if cmp.is_gt() {
			false
		} else if snd.full_len(i) > MAX_FULL_DATUM as u64 {
			let same = cmp.is_eq() && snd.full_len(i) == rec.full_len(j) && {
				let snd_sum = item_digest(snd, i);
				let rec_sum = item_digest(rec, j);
				snd_sum == rec_sum
			};
			if !same
				&& find_all
				&& let Some(states) = states.as_deref_mut()
				&& states.get(i) == Some(&XState::Abbrev)
				&& snd.abbreviated_len(i).is_some()
			{
				states[i] = XState::Todo;
			}
			same
		} else {
			cmp.is_eq() && *snd_value == rec.items[j].1 && rec.abbreviated_len(j).is_none()
		};
		if !same {
			if !find_all {
				return true;
			}
			equal = false;
		}
		if cmp.is_le() {
			i += 1;
		}
		if cmp.is_ge() {
			j += 1;
		}
	}
	if j < rec.items.len() {
		equal = false;
	}
	!equal
}

fn item_digest(set: &XattrSet, i: usize) -> [u8; XATTR_SUM_LEN] {
	let value = &set.items[i].1;
	if set.abbreviated_len(i).is_some() {
		let mut sum = [0; XATTR_SUM_LEN];
		let n = value.len().min(XATTR_SUM_LEN);
		sum[..n].copy_from_slice(&value[..n]);
		sum
	} else {
		xattr_digest(value)
	}
}

// ---------------------------------------------------------------------------
// Set cache keys

/// Comparable identity of an item: name, full length, value or digest.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
struct KeyItem {
	name: Vec<u8>,
	len: u64,
	datum: Vec<u8>,
}

fn key_of(set: &XattrSet) -> Vec<KeyItem> {
	(0..set.items.len())
		.map(|i| {
			let len = set.full_len(i);
			let datum = if len > MAX_FULL_DATUM as u64 {
				item_digest(set, i).to_vec()
			} else {
				set.items[i].1.clone()
			};
			KeyItem { name: set.items[i].0.clone(), len, datum }
		})
		.collect()
}

fn hash_key(key: &[KeyItem]) -> u64 {
	let mut hasher = DefaultHasher::new();
	key.hash(&mut hasher);
	hasher.finish()
}

/// Generator-side bookkeeping of abbreviated items.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum XState {
	/// Abbreviated and not yet looked at.
	Abbrev,
	/// Needed: to be requested (generator) / to be sent (sender).
	Todo,
	/// Handled.
	Done,
}

fn initial_states(lens: impl Iterator<Item = u64>) -> Vec<XState> {
	lens.map(|len| if len > MAX_FULL_DATUM as u64 { XState::Abbrev } else { XState::Done }).collect()
}

/// Accumulates one relative position of a value request.
fn advance_num(num: i32, rel_pos: i32, role: Role) -> Result<i32, RsyncError> {
	num.checked_add(rel_pos).ok_or_else(|| {
		RsyncError::new(
			RERR_PROTOCOL,
			format!("xattr rel_pos accumulation overflow [{}]", role.name()),
		)
		.at("xattrs.c", 733)
	})
}

fn internal_data_error() -> RsyncError {
	RsyncError::new(RERR_PROTOCOL, "recv_xattr_request: internal data error!").at("xattrs.c", 719)
}

fn not_found_error(role: Role, num: i32, fname: &[u8]) -> RsyncError {
	RsyncError::new(
		RERR_PROTOCOL,
		format!("[{}] could not find xattr #{num} for {}", role.name(), String::from_utf8_lossy(fname)),
	)
	.at("xattrs.c", 766)
}

fn abbrev_error(role: Role, fname: &[u8], name: &[u8], len: u64) -> RsyncError {
	RsyncError::new(
		RERR_PROTOCOL,
		format!(
			"[{}] internal abbrev error on {} ({}, len={len})!",
			role.name(),
			String::from_utf8_lossy(fname),
			String::from_utf8_lossy(name)
		),
	)
	.at("xattrs.c", 771)
}

// ---------------------------------------------------------------------------
// Sender

struct SentSet {
	key: Vec<KeyItem>,
	states: Vec<XState>,
}

/// Sender cache (send_xattr): emits an index for a repeated set, abbreviates large values.
pub(crate) struct XattrSender {
	ns: Ns,
	role: Role,
	sets: Vec<SentSet>,
	lookup: HashMap<u64, Vec<u32>>,
}

impl XattrSender {
	/// A sender with default options (non-root, no fake-super).
	#[cfg(test)]
	pub(crate) fn new() -> Self {
		Self::with_opts(XattrOpts { am_sender: true, ..XattrOpts::default() })
	}

	/// A sender translating names under `opts` (fake-super changes the Linux rules).
	pub(crate) fn with_opts(opts: XattrOpts) -> Self {
		Self::with_ns(Ns::new(&XattrOpts { am_sender: true, ..opts }, LINUX_XATTRS))
	}

	fn with_ns(ns: Ns) -> Self {
		Self { ns, role: Role::Sender, sets: Vec::new(), lookup: HashMap::new() }
	}

	/// Role named in protocol-error messages.
	pub(crate) fn set_role(&mut self, role: Role) {
		self.role = role;
	}

	/// send_xattr: an index for a repeated set, else the literal list with long values
	/// abbreviated; returns the set's cache index (stored as the entry's xattr index).
	pub(crate) fn send_indexed(&mut self, w: &mut dyn Write, set: &XattrSet, _proto: Proto) -> io::Result<u32> {
		let key = key_of(set);
		let hash = hash_key(&key);
		if let Some(ndx) = self.find(hash, &key) {
			w.write_varint(varint_len(u64::from(ndx) + 1)?)?;
			return Ok(ndx);
		}
		w.write_varint(0)?;
		w.write_varint(varint_len(key.len() as u64)?)?;
		for item in &key {
			let wire = self.ns.to_wire(&item.name);
			w.write_varint(varint_len(wire.len() as u64 + 1)?)?;
			w.write_varint(varint_len(item.len)?)?;
			w.write_all(&wire)?;
			w.write_u8(0)?;
			w.write_all(&item.datum)?;
		}
		let ndx = u32::try_from(self.sets.len())
			.map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too many xattr sets"))?;
		let states = initial_states(key.iter().map(|item| item.len));
		self.sets.push(SentSet { key, states });
		self.lookup.entry(hash).or_default().push(ndx);
		Ok(ndx)
	}

	fn find(&self, hash: u64, key: &[KeyItem]) -> Option<u32> {
		self.lookup
			.get(&hash)?
			.iter()
			.copied()
			.find(|&ndx| self.sets.get(ndx as usize).is_some_and(|sent| sent.key == key))
	}

	/// send_xattr_request, sender side: reads the generator's request for cache entry
	/// `ndx` (None = the file had no xattr index), then writes the requested values taken from `set` (the file's
	/// current xattrs, local names) and the terminating zero. Returns whether any
	/// value was sent.
	pub(crate) fn answer_request_at(
		&mut self,
		r: &mut dyn Read,
		w: &mut dyn Write,
		ndx: Option<u32>,
		set: &XattrSet,
		fname: &[u8],
		logger: Option<&Logger>,
	) -> Result<bool, RsyncError> {
		let role = self.role;
		let sent = ndx.and_then(|ndx| self.sets.get_mut(ndx as usize)).ok_or_else(internal_data_error)?;
		let mut num = 0i32;
		loop {
			let rel_pos = r.read_varint().map_err(RsyncError::from_stream)?;
			if rel_pos == 0 {
				break;
			}
			num = advance_num(num, rel_pos, role)?;
			let i = usize::try_from(num)
				.ok()
				.and_then(|n| n.checked_sub(1))
				.filter(|&i| i < sent.key.len())
				.ok_or_else(|| not_found_error(role, num, fname))?;
			let item = &sent.key[i];
			if item.len <= MAX_FULL_DATUM as u64 || sent.states[i] != XState::Abbrev {
				return Err(abbrev_error(role, fname, &item.name, item.len));
			}
			sent.states[i] = XState::Todo;
		}

		let wr = RsyncError::from_stream;
		let mut prior = 0i32;
		let mut any = false;
		for (i, item) in sent.key.iter().enumerate() {
			if item.len <= MAX_FULL_DATUM as u64 || sent.states[i] != XState::Todo {
				continue;
			}
			sent.states[i] = XState::Done;
			let num = i32::try_from(i + 1).map_err(|_| internal_data_error())?;
			w.write_varint(num - prior).map_err(wr)?;
			prior = num;
			match set.value(&item.name) {
				Some(value) => {
					w.write_varint(varint_len(value.len() as u64).map_err(wr)?).map_err(wr)?;
					w.write_all(value).map_err(wr)?;
					any = true;
				},
				None => {
					if let Some(logger) = logger {
						let mut text = b"failed to re-read xattr ".to_vec();
						text.extend_from_slice(&item.name);
						text.extend_from_slice(b" for ");
						text.extend_from_slice(fname);
						text.push(b'\n');
						logger.rprintf(LogCode::ErrorXfer, &text);
					}
					w.write_varint(0).map_err(wr)?;
				},
			}
		}
		w.write_u8(0).map_err(wr)?;
		Ok(any)
	}
}

// ---------------------------------------------------------------------------
// Receiver

struct RecvSet {
	set: XattrSet,
	/// Each item's 1-based position in the sender's list.
	nums: Vec<u32>,
	states: Vec<XState>,
}

/// Receiver cache (receive_xattr), returns the cache index stored in FileEntry::xattr.
pub(crate) struct XattrReceiver {
	ns: Ns,
	max_alloc: u64,
	role: Role,
	filter: Option<Box<dyn Fn(&[u8]) -> bool + Send + Sync>>,
	sets: Vec<RecvSet>,
}

impl XattrReceiver {
	/// A receiver with default options (non-root, no fake-super, `-X`).
	#[cfg(test)]
	pub(crate) fn new(max_alloc: u64) -> Self {
		Self::with_opts(max_alloc, XattrOpts::default())
	}

	/// A receiver translating names under `opts`.
	pub(crate) fn with_opts(max_alloc: u64, opts: XattrOpts) -> Self {
		Self::with_ns(max_alloc, Ns::new(&XattrOpts { am_sender: false, ..opts }, LINUX_XATTRS))
	}

	fn with_ns(max_alloc: u64, ns: Ns) -> Self {
		Self {
			ns,
			max_alloc,
			role: Role::Receiver,
			filter: None,
			sets: Vec::new(),
		}
	}

	/// Role named in protocol-error messages.
	pub(crate) fn set_role(&mut self, role: Role) {
		self.role = role;
	}

	/// Installs the `x`-modifier filter rules (true = excluded); see [`XattrCtx::filter`].
	pub(crate) fn set_filter(&mut self, filter: Box<dyn Fn(&[u8]) -> bool + Send + Sync>) {
		self.filter = Some(filter);
	}

	/// receive_xattr for the entry named `fname` (used in diagnostics); returns the
	/// cache index stored in `FileEntry::xattr`.
	pub(crate) fn recv_named(&mut self, r: &mut dyn Read, _proto: Proto, fname: &[u8]) -> Result<u32, RsyncError> {
		let role = self.role;
		let ndx = r.read_varint().map_err(RsyncError::from_stream)?;
		if ndx < 0 || ndx as usize > self.sets.len() {
			return Err(RsyncError::new(
				RERR_STREAMIO,
				format!("receive_xattr: xa index {ndx} out of range for {}", String::from_utf8_lossy(fname)),
			)
			.at("xattrs.c", 818));
		}
		if ndx != 0 {
			return Ok((ndx - 1) as u32);
		}

		let count = read_varint_bounded(r, 0, MAX_WIRE_XATTR_COUNT, "xattr count", role)?;
		let might_prefix = if self.ns.linux { self.ns.root <= 0 } else { self.ns.root != 0 };
		let extra_len = if might_prefix { self.ns.prefix().len() as u64 } else { 0 };
		let mut entries: Vec<(Vec<u8>, Vec<u8>, Option<u64>, u32)> = Vec::new();
		let mut total: u64 = 0;
		let mut need_sort = !self.ns.linux;
		for num in 1..=count as u32 {
			let name_len = read_varint_size(r, MAX_WIRE_XATTR_NAMELEN, "xattr name_len", role)?;
			let datum_len = read_varint_size(r, MAX_WIRE_XATTR_DATALEN, "xattr datum_len", role)? as u64;
			let dget_len =
				if datum_len > MAX_FULL_DATUM as u64 { 1 + XATTR_SUM_LEN as u64 } else { datum_len };
			if datum_len > MAX_XATTR_VALUE_BYTES {
				return Err(RsyncError::new(
					RERR_PROTOCOL,
					format!("xattr datum_len exceeds per-value limit [{}]", role.name()),
				)
				.at("xattrs.c", 841));
			}
			total += name_len as u64 + datum_len;
			if total > MAX_XATTR_LIST_BYTES {
				return Err(RsyncError::new(
					RERR_PROTOCOL,
					format!("xattr list exceeds per-file limit [{}]", role.name()),
				)
				.at("xattrs.c", 850));
			}
			alloc_check(self.max_alloc, dget_len + extra_len + name_len as u64, 1, role, "xattrs.c", 854)?;
			let mut name = read_exact_vec(r, name_len)?;
			if name.last() != Some(&0) {
				return Err(RsyncError::new(
					RERR_FILEIO,
					"Invalid xattr name received (missing trailing \\0).",
				)
				.at("xattrs.c", 859));
			}
			// C string semantics: the name ends at its first NUL.
			if let Some(end) = name.iter().position(|&b| b == 0) {
				name.truncate(end);
			}
			let (value, abbrev) = if datum_len > MAX_FULL_DATUM as u64 {
				(read_exact_vec(r, XATTR_SUM_LEN)?, Some(datum_len))
			} else {
				(read_exact_vec(r, datum_len as usize)?, None)
			};
			let filter = self.filter.as_deref().map(|f| f as &dyn Fn(&[u8]) -> bool);
			let Some((local, prefixed)) = self.ns.from_wire(&name, filter) else {
				continue;
			};
			need_sort |= prefixed;
			entries.push((local, value, abbrev, num));
		}
		if need_sort {
			entries.sort_by(|a, b| a.0.cmp(&b.0));
		}

		let mut set = XattrSet::default();
		let mut nums = Vec::with_capacity(entries.len());
		let any_abbrev = entries.iter().any(|e| e.2.is_some());
		for (name, value, abbrev, num) in entries {
			set.items.push((name, value));
			if any_abbrev {
				set.abbrev.push(abbrev);
			}
			nums.push(num);
		}
		let ndx = self.sets.len() as u32;
		let states = initial_states((0..set.items.len()).map(|i| set.full_len(i)));
		self.sets.push(RecvSet { set, nums, states });
		Ok(ndx)
	}

	pub(crate) fn get(&self, ndx: u32) -> Option<&XattrSet> {
		self.sets.get(ndx as usize).map(|entry| &entry.set)
	}

	/// xattr_diff: does the received set `ndx` differ from `local` (None = no file)?
	/// With `find_all`, flags every differing abbreviated value for [`Self::request_missing`].
	pub(crate) fn diff(&mut self, ndx: Option<u32>, local: Option<&XattrSet>, find_all: bool) -> bool {
		let empty = XattrSet::default();
		let local = local.unwrap_or(&empty);
		match ndx.and_then(|ndx| self.sets.get_mut(ndx as usize)) {
			Some(entry) => diff_sets(&entry.set, Some(entry.states.as_mut_slice()), local, find_all),
			None => diff_sets(&empty, None, local, find_all),
		}
	}

	/// Generator: request missing abbreviated values for `ndx` (returns false when none are needed).
	/// Writes the (possibly empty) request list and its terminating zero, as upstream does
	/// whenever ITEM_REPORT_XATTR is sent.
	pub(crate) fn request_missing(&mut self, w: &mut dyn Write, ndx: u32, _file_ndx: i32) -> io::Result<bool> {
		let mut any = false;
		if let Some(entry) = self.sets.get_mut(ndx as usize) {
			let mut prior = 0i64;
			for i in 0..entry.states.len() {
				if entry.set.full_len(i) <= MAX_FULL_DATUM as u64 {
					continue;
				}
				match entry.states[i] {
					XState::Abbrev => entry.states[i] = XState::Done,
					XState::Todo => {
						entry.states[i] = XState::Done;
						let num = i64::from(entry.nums[i]);
						w.write_varint(varint_len_signed(num - prior)?)?;
						prior = num;
						any = true;
					},
					XState::Done => {},
				}
			}
		}
		w.write_u8(0)?;
		Ok(any)
	}

	/// Generator without a request channel: marks untouched abbreviated items handled.
	pub(crate) fn settle(&mut self, ndx: u32) {
		if let Some(entry) = self.sets.get_mut(ndx as usize) {
			for state in &mut entry.states {
				if *state == XState::Abbrev {
					*state = XState::Done;
				}
			}
		}
	}

	/// Receiver: reads the values the sender returned for the entry named `fname`;
	/// returns whether data arrived.
	pub(crate) fn recv_values_named(&mut self, r: &mut dyn Read, ndx: u32, fname: &[u8]) -> Result<bool, RsyncError> {
		let role = self.role;
		let max_alloc = self.max_alloc;
		let entry = self.sets.get_mut(ndx as usize).ok_or_else(internal_data_error)?;
		let mut num = 0i32;
		let mut got = false;
		loop {
			let rel_pos = r.read_varint().map_err(RsyncError::from_stream)?;
			if rel_pos == 0 {
				break;
			}
			num = advance_num(num, rel_pos, role)?;
			let i = entry
				.nums
				.iter()
				.position(|&n| i64::from(n) == i64::from(num))
				.ok_or_else(|| not_found_error(role, num, fname))?;
			if entry.set.abbreviated_len(i).is_none() {
				let (name, value) = &entry.set.items[i];
				return Err(abbrev_error(role, fname, name, value.len() as u64));
			}
			let len = read_varint_size(r, MAX_WIRE_XATTR_DATALEN, "xattr datum_len", role)?;
			if len as u64 > MAX_XATTR_VALUE_BYTES {
				return Err(RsyncError::new(
					RERR_PROTOCOL,
					format!("xattr datum_len exceeds per-value limit [{}]", role.name()),
				)
				.at("xattrs.c", 783));
			}
			let name_len = entry.set.items[i].0.len() as u64 + 1;
			alloc_check(max_alloc, len as u64 + name_len, 1, role, "xattrs.c", 788)?;
			let value = read_exact_vec(r, len)?;
			entry.set.set_resolved(i, value);
			got = true;
		}
		Ok(got)
	}

	/// Applies cache entry `ndx` (see [`apply_with`]); outside the generator, values
	/// resolved from the basis replace their digests in the cache for later files.
	pub(crate) fn apply(
		&mut self,
		ndx: u32,
		tree: &Tree,
		rel: &Path,
		follow: bool,
		opts: XattrOpts,
		ctx: XattrCtx<'_>,
	) -> io::Result<XattrApplied> {
		let ns = Ns { sender: false, ..self.ns };
		let filter = self.filter.as_deref().map(|f| f as &dyn Fn(&[u8]) -> bool);
		let ctx = XattrCtx { filter: ctx.filter.or(filter), ..ctx };
		let Some(entry) = self.sets.get_mut(ndx as usize) else {
			return Ok(XattrApplied::default());
		};
		let applied = apply_ns(tree, rel, &entry.set, follow, &opts, ns, ctx)?;
		if !ctx.am_generator {
			for (i, value) in &applied.resolved {
				entry.set.set_resolved(*i, value.clone());
			}
		}
		Ok(applied)
	}
}

fn varint_len_signed(v: i64) -> io::Result<i32> {
	i32::try_from(v).map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "xattr position out of range"))
}

#[cfg(test)]
mod tests {
	use std::io::Cursor;

	use super::*;
	use crate::rsync::tree::TreeOpts;

	const P33: Proto = Proto { version: 33, compat: 0 };

	fn set(items: &[(&[u8], &[u8])]) -> XattrSet {
		XattrSet { items: items.iter().map(|(n, v)| (n.to_vec(), v.to_vec())).collect(), abbrev: Vec::new() }
	}

	fn ns(linux: bool, root: i32, sender: bool, all: bool) -> Ns {
		Ns { linux, root, sender, all }
	}

	/// Whether `wanted` and `local` differ (itemize's `x` comparison).
	fn differs(wanted: &XattrSet, local: &XattrSet) -> bool {
		diff_sets(wanted, None, local, false)
	}

	fn big() -> Vec<u8> {
		vec![b'x'; 40]
	}

	/// What `rsync -rX --only-write-batch` (3.5.1, macOS) wrote for `.` (no xattrs),
	/// `a` (big = 40×'x', foo = "bar") and `b` (same xattrs as `a`).
	const GOLDEN_DIR: &[u8] = &[0x00, 0x00];
	const GOLDEN_A: &[u8] = b"\x00\x02\x09\x28user.big\x00\x2e\x5a\x5d\xf3\x0e\xbd\x85\x39\x44\x5b\xa6\xe0\xf6\x38\xb6\xf9\x09\x03user.foo\x00bar";
	const GOLDEN_B: &[u8] = &[0x02];

	fn golden_answer() -> Vec<u8> {
		let mut v = vec![0x01, 0x28];
		v.extend(big());
		v.push(0);
		v
	}

	#[test]
	fn sender_matches_reference_flist_bytes_on_flat_namespace() {
		let mut sender = XattrSender::with_ns(ns(false, 0, true, false));
		let file = set(&[(b"big", &big()), (b"foo", b"bar")]);
		let mut out = Vec::new();
		sender.send_indexed(&mut out, &XattrSet::default(), P33).unwrap();
		assert_eq!(out, GOLDEN_DIR);
		out.clear();
		assert_eq!(sender.send_indexed(&mut out, &file, P33).unwrap(), 1);
		assert_eq!(out, GOLDEN_A);
		out.clear();
		assert_eq!(sender.send_indexed(&mut out, &file, P33).unwrap(), 1);
		assert_eq!(out, GOLDEN_B);
	}

	#[test]
	fn linux_sender_sends_user_names_verbatim() {
		let mut sender = XattrSender::with_ns(ns(true, 0, true, false));
		let mut out = Vec::new();
		sender.send_indexed(&mut out, &XattrSet::default(), P33).unwrap();
		out.clear();
		sender.send_indexed(&mut out, &set(&[(b"user.big", &big()), (b"user.foo", b"bar")]), P33).unwrap();
		assert_eq!(out, GOLDEN_A);
	}

	#[test]
	fn receiver_decodes_reference_bytes_and_reuses_cache_indices() {
		let mut stream = [GOLDEN_DIR, GOLDEN_A, GOLDEN_B].concat();
		stream.extend(GOLDEN_A); // a literal repeat is stored again, as upstream does
		let mut r = Cursor::new(stream);
		let mut recv = XattrReceiver::with_ns(1 << 30, ns(false, 0, false, false));
		assert_eq!(recv.recv_named(&mut r, P33, b"").unwrap(), 0);
		assert_eq!(recv.recv_named(&mut r, P33, b"").unwrap(), 1);
		assert_eq!(recv.recv_named(&mut r, P33, b"").unwrap(), 1);
		assert_eq!(recv.recv_named(&mut r, P33, b"").unwrap(), 2);
		let got = recv.get(1).unwrap();
		assert_eq!(got.items[0].0, b"big");
		assert_eq!(got.items[0].1, xattr_digest(&big()));
		assert_eq!(got.abbreviated_len(0), Some(40));
		assert_eq!(got.items[1], (b"foo".to_vec(), b"bar".to_vec()));
		assert_eq!(got.abbreviated_len(1), None);
		assert!(recv.get(0).unwrap().items.is_empty());
	}

	#[test]
	fn request_answer_exchange_matches_reference_and_resolves_values() {
		let local_a = set(&[(b"big", &big()), (b"foo", b"bar")]);
		let mut sender = XattrSender::with_ns(ns(false, 0, true, false));
		let mut flist = Vec::new();
		sender.send_indexed(&mut flist, &XattrSet::default(), P33).unwrap();
		sender.send_indexed(&mut flist, &local_a, P33).unwrap();
		sender.send_indexed(&mut flist, &local_a, P33).unwrap();

		let mut recv = XattrReceiver::with_ns(1 << 30, ns(false, 0, false, false));
		let mut r = Cursor::new(flist);
		for _ in 0..3 {
			recv.recv_named(&mut r, P33, b"").unwrap();
		}

		// File `a` is new: everything differs and the abbreviated value is requested.
		assert!(recv.diff(Some(1), None, true));
		let mut request = Vec::new();
		assert!(recv.request_missing(&mut request, 1, 1).unwrap());
		assert_eq!(request, [0x01, 0x00]);

		let mut answer = Vec::new();
		let sent = sender
			.answer_request_at(&mut Cursor::new(request), &mut answer, Some(1), &local_a, b"a", None)
			.unwrap();
		assert!(sent);
		assert_eq!(answer, golden_answer());

		assert!(recv.recv_values_named(&mut Cursor::new(answer), 1, b"a").unwrap());
		assert_eq!(recv.get(1).unwrap(), &local_a);

		// File `b` shares the set: nothing left to request, and the sender answers `00`.
		assert!(recv.diff(Some(1), None, true));
		let mut request = Vec::new();
		assert!(!recv.request_missing(&mut request, 1, 2).unwrap());
		assert_eq!(request, [0x00]);
		let mut answer = Vec::new();
		let sent = sender
			.answer_request_at(&mut Cursor::new(request), &mut answer, Some(1), &local_a, b"b", None)
			.unwrap();
		assert!(!sent);
		assert_eq!(answer, [0x00]);
	}

	#[test]
	fn sender_rejects_repeated_and_unknown_requests() {
		let local = set(&[(b"big", &big()), (b"foo", b"bar")]);
		let mut sender = XattrSender::with_ns(ns(false, 0, true, false));
		sender.send_indexed(&mut Vec::new(), &local, P33).unwrap();
		let mut answer = Vec::new();
		sender.answer_request_at(&mut Cursor::new([1u8, 0]), &mut answer, Some(0), &local, b"f", None).unwrap();
		let err = sender
			.answer_request_at(&mut Cursor::new([1u8, 0]), &mut Vec::new(), Some(0), &local, b"f", None)
			.unwrap_err();
		assert_eq!(err.message.as_deref(), Some("[sender] internal abbrev error on f (big, len=40)!"));
		let err = sender
			.answer_request_at(&mut Cursor::new([2u8, 0]), &mut Vec::new(), Some(0), &local, b"f", None)
			.unwrap_err();
		assert_eq!(err.message.as_deref(), Some("[sender] internal abbrev error on f (foo, len=3)!"));
		let err = sender
			.answer_request_at(&mut Cursor::new([3u8, 0]), &mut Vec::new(), Some(0), &local, b"f", None)
			.unwrap_err();
		assert_eq!(err.message.as_deref(), Some("[sender] could not find xattr #3 for f"));
		let err = sender
			.answer_request_at(&mut Cursor::new([0u8]), &mut Vec::new(), None, &local, b"f", None)
			.unwrap_err();
		assert_eq!(err.code, RERR_PROTOCOL);
	}

	#[test]
	fn missing_value_on_resend_answers_zero_length() {
		let local = set(&[(b"big", &big())]);
		let mut sender = XattrSender::with_ns(ns(false, 0, true, false));
		sender.send_indexed(&mut Vec::new(), &local, P33).unwrap();
		let mut answer = Vec::new();
		let sent = sender
			.answer_request_at(&mut Cursor::new([1u8, 0]), &mut answer, Some(0), &XattrSet::default(), b"f", None)
			.unwrap();
		assert!(!sent);
		assert_eq!(answer, [0x01, 0x00, 0x00]);
	}

	#[test]
	fn receiver_rejects_malformed_lists() {
		let recv_one = |bytes: &[u8]| {
			let mut recv = XattrReceiver::with_ns(1 << 30, ns(true, 1, false, false));
			recv.recv_named(&mut Cursor::new(bytes.to_vec()), P33, b"f").map(drop).unwrap_err()
		};
		let err = recv_one(&[0x05]);
		assert_eq!(err.code, RERR_STREAMIO);
		assert_eq!(err.message.as_deref(), Some("receive_xattr: xa index 5 out of range for f"));

		let err = recv_one(&[0x00, 0xc1, 0x01, 0x00]); // count 65537
		assert_eq!(
			err.message.as_deref(),
			Some("wire value xattr count out of range: 65537 not in [0,65536] [receiver]")
		);

		let err = recv_one(&[0x00, 0x01, 0x03, 0x01, b'a', b'b', b'c', b'v']);
		assert_eq!(err.code, RERR_FILEIO);
		assert_eq!(err.message.as_deref(), Some("Invalid xattr name received (missing trailing \\0)."));

		// 128 MiB + 1 declared value length.
		let mut bytes = vec![0x00, 0x01, 0x02];
		bytes.extend([0xe8, 0x01, 0x00, 0x00]);
		let err = recv_one(&bytes);
		assert_eq!(err.code, RERR_PROTOCOL);
		assert_eq!(err.message.as_deref(), Some("xattr datum_len exceeds per-value limit [receiver]"));

		let err = recv_one(&[0x00, 0x01, 0x90, 0x10, 0x00]); // name_len 4112
		assert_eq!(err.message.as_deref(), Some("wire size xattr name_len out of range: 4112 > 4096 [receiver]"));

		let err = recv_one(&[0x00, 0x01, 0x02, 0x01, b'a']);
		assert_eq!(err.code, RERR_STREAMIO, "EOF mid-list is a stream error");
	}

	#[test]
	fn receiver_honors_max_alloc_on_requested_values() {
		let mut flist = Vec::new();
		let local = set(&[(b"user.big", &big())]);
		XattrSender::with_ns(ns(true, 0, true, false)).send_indexed(&mut flist, &local, P33).unwrap();
		let mut recv = XattrReceiver::with_ns(40, ns(true, 0, false, false));
		recv.recv_named(&mut Cursor::new(flist), P33, b"").unwrap();
		let mut answer = vec![0x01, 0x28];
		answer.extend(big());
		answer.push(0);
		let err = recv.recv_values_named(&mut Cursor::new(answer), 0, b"").unwrap_err();
		assert_eq!(err.code, RERR_MALLOC);
		assert_eq!(
			err.message.as_deref(),
			Some("[receiver] exceeded --max-alloc=40 setting (file=xattrs.c, line=788)")
		);
	}

	#[test]
	fn receiver_rejects_values_for_unabbreviated_items() {
		let mut flist = Vec::new();
		XattrSender::with_ns(ns(true, 0, true, false))
			.send_indexed(&mut flist, &set(&[(b"user.a", b"1")]), P33)
			.unwrap();
		let mut recv = XattrReceiver::with_ns(0, ns(true, 0, false, false));
		recv.recv_named(&mut Cursor::new(flist), P33, b"").unwrap();
		let err = recv.recv_values_named(&mut Cursor::new([1, 1, b'z', 0]), 0, b"f").unwrap_err();
		assert_eq!(err.message.as_deref(), Some("[receiver] internal abbrev error on f (user.a, len=1)!"));
		let err = recv.recv_values_named(&mut Cursor::new([2u8, 0]), 0, b"f").unwrap_err();
		assert_eq!(err.message.as_deref(), Some("[receiver] could not find xattr #2 for f"));
	}

	#[test]
	fn receiver_namespace_translation() {
		let wire = set(&[
			(b"security.selinux", b"ctx"),
			(b"trusted.t", b"1"),
			(b"user.rsync.%stat", b"100644 0,0 0:0"),
			(b"user.u", b"2"),
		]);
		let mut flist = Vec::new();
		XattrSender::with_ns(ns(true, 1, true, true)).send_indexed(&mut flist, &wire, P33).unwrap();
		let names = |receiver_ns: Ns| {
			let mut recv = XattrReceiver::with_ns(0, receiver_ns);
			let ndx = recv.recv_named(&mut Cursor::new(flist.clone()), P33, b"").unwrap();
			recv.get(ndx).unwrap().items.iter().map(|(n, _)| String::from_utf8(n.clone()).unwrap()).collect::<Vec<_>>()
		};
		// Linux non-root keeps the user namespace only; %-names need -XX.
		assert_eq!(names(ns(true, 0, false, false)), ["user.u"]);
		assert_eq!(names(ns(true, 0, false, true)), ["user.rsync.%stat", "user.u"]);
		// Linux fake-super stores foreign namespaces under user.rsync. (sorted).
		assert_eq!(
			names(ns(true, -1, false, false)),
			["user.rsync.security.selinux", "user.rsync.trusted.t", "user.u"]
		);
		// Linux root keeps everything but %-names.
		assert_eq!(names(ns(true, 1, false, false)), ["security.selinux", "trusted.t", "user.u"]);
		// Flat namespace: user. is stripped; root keeps the rest under rsync.
		assert_eq!(names(ns(false, 0, false, false)), ["u"]);
		assert_eq!(
			names(ns(false, 1, false, true)),
			["rsync.%stat", "rsync.security.selinux", "rsync.trusted.t", "u"]
		);
	}

	#[test]
	fn receiver_filter_replaces_namespace_screening() {
		let mut flist = Vec::new();
		XattrSender::with_ns(ns(true, 1, true, false))
			.send_indexed(&mut flist, &set(&[(b"security.s", b"1"), (b"user.keep", b"2"), (b"user.skip", b"3")]), P33)
			.unwrap();
		let mut recv = XattrReceiver::with_ns(0, ns(true, 0, false, false));
		recv.set_filter(Box::new(|name: &[u8]| name == b"user.skip"));
		let ndx = recv.recv_named(&mut Cursor::new(flist), P33, b"").unwrap();
		let names: Vec<_> = recv.get(ndx).unwrap().items.iter().map(|(n, _)| n.clone()).collect();
		assert_eq!(names, [b"user.keep".to_vec(), b"user.rsync.security.s".to_vec()]);
		// Positions refer to the sender's list even after re-sorting.
		assert_eq!(recv.sets[0].nums, [2, 1]);
	}

	#[test]
	fn sender_name_translation() {
		let flat = ns(false, 0, true, true);
		assert_eq!(flat.to_wire(b"foo"), b"user.foo");
		assert_eq!(flat.to_wire(b"rsync.security.selinux"), b"security.selinux");
		assert_eq!(flat.to_wire(b"rsync.%stat"), b"user.rsync.%stat");
		let linux = ns(true, 0, true, true);
		assert_eq!(linux.to_wire(b"user.rsync.trusted.x"), b"user.rsync.trusted.x");
		let fake = ns(true, -1, true, true);
		assert_eq!(fake.to_wire(b"user.rsync.trusted.x"), b"trusted.x");
		assert_eq!(fake.to_wire(b"user.rsync.%aacl"), b"user.rsync.%aacl");
	}

	#[test]
	fn local_name_screening() {
		let linux_sender = ns(true, 0, true, false);
		assert!(linux_sender.keep_local(b"trusted.x", None));
		assert!(!linux_sender.keep_local(b"system.posix_acl_access", None));
		assert!(!linux_sender.keep_local(b"user.rsync.%stat", None));
		assert!(ns(true, 0, true, true).keep_local(b"user.rsync.%stat", None));
		let linux_gen = ns(true, 0, false, false);
		assert!(!linux_gen.keep_local(b"trusted.x", None));
		assert!(linux_gen.keep_local(b"user.rsync.%stat", None));
		let fake_gen = ns(true, -1, false, false);
		assert!(fake_gen.keep_local(b"trusted.x", None));
		assert!(!fake_gen.keep_local(b"user.rsync.%stat", None));
		assert!(!fake_gen.keep_local(b"user.rsync.%dacl", None));
		assert!(fake_gen.keep_local(b"user.rsync.%other", None));
		let filter = |name: &[u8]| name.starts_with(b"user.");
		assert!(linux_gen.keep_local(b"system.x", Some(&filter)));
		assert!(!linux_gen.keep_local(b"user.x", Some(&filter)));
	}

	#[test]
	fn diff_walk_detects_changes_and_flags_requests() {
		let wanted = set(&[(b"a", b"1"), (b"big", &big())]);
		assert!(!differs(&wanted, &wanted));
		assert!(differs(&wanted, &set(&[(b"a", b"1")])));
		assert!(differs(&wanted, &set(&[(b"a", b"2"), (b"big", &big())])));
		let mut other_big = big();
		other_big[0] = b'y';
		assert!(differs(&wanted, &set(&[(b"a", b"1"), (b"big", &other_big)])));
		assert!(differs(&wanted, &set(&[(b"a", b"1"), (b"big", &big()), (b"c", b"")])));

		let mut flist = Vec::new();
		XattrSender::with_ns(ns(true, 1, true, false))
			.send_indexed(&mut flist, &set(&[(b"a", b"1"), (b"big", &big())]), P33)
			.unwrap();
		let mut recv = XattrReceiver::with_ns(0, ns(true, 1, false, false));
		recv.recv_named(&mut Cursor::new(flist), P33, b"").unwrap();
		// Matching local data: no change, nothing requested.
		assert!(!recv.diff(Some(0), Some(&wanted), true));
		let mut req = Vec::new();
		assert!(!recv.request_missing(&mut req, 0, 0).unwrap());
		assert_eq!(req, [0]);
	}

	fn scratch() -> (tempfile::TempDir, Tree) {
		let dir = tempfile::tempdir().unwrap();
		let tree = Tree::open(&pi_vfs::BlockingFs::native(), dir.path(), &TreeOpts::default()).unwrap();
		(dir, tree)
	}

	fn test_name(base: &str) -> Vec<u8> {
		if LINUX_XATTRS { format!("user.{base}") } else { base.to_owned() }.into_bytes()
	}

	#[test]
	fn apply_sets_new_values_and_removes_extras() {
		let (dir, tree) = scratch();
		std::fs::write(dir.path().join("f"), b"data").unwrap();
		let rel = Path::new("f");
		if let Err(err) = tree.set_xattr(rel, bytes_os(&test_name("rsynctest.stale")).unwrap(), b"old", false) {
			eprintln!("skipped: no user xattrs on the temporary filesystem: {err}");
			return;
		}
		let only_ours = |name: &[u8]| !name.windows(9).any(|w| w == b"rsynctest");
		let ctx = XattrCtx { filter: Some(&only_ours), ..XattrCtx::default() };
		let opts = XattrOpts::default();
		let wanted = set(&[(&test_name("rsynctest.a"), b"1"), (&test_name("rsynctest.big"), &big())]);
		let applied = apply_with(&tree, rel, &wanted, false, opts, ctx).unwrap();
		assert!(applied.resolved.is_empty());
		let got = read_local_with(&tree, rel, None, false, opts, ctx).unwrap();
		assert_eq!(got, wanted);
		assert!(!differs(&wanted, &got));

		// An abbreviated value is taken from the basis when its digest matches.
		let mut abbreviated = wanted.clone();
		abbreviated.items[1].1 = xattr_digest(&big()).to_vec();
		abbreviated.abbrev = vec![None, Some(40)];
		std::fs::write(dir.path().join("g"), b"").unwrap();
		let basis_ctx = XattrCtx { basis: Some((&tree, rel)), ..ctx };
		let applied = apply_with(&tree, Path::new("g"), &abbreviated, false, opts, basis_ctx).unwrap();
		assert_eq!(applied.resolved, [(1, big())]);
		assert_eq!(read_local_with(&tree, Path::new("g"), None, false, opts, ctx).unwrap(), wanted);

		// Without a matching basis value the item stays unset (and nothing resolves).
		std::fs::write(dir.path().join("h"), b"").unwrap();
		let applied = apply_with(&tree, Path::new("h"), &abbreviated, false, opts, ctx).unwrap();
		assert!(applied.resolved.is_empty());
		let generator = XattrCtx { am_generator: true, ..ctx };
		let applied = apply_with(&tree, Path::new("h"), &abbreviated, false, opts, generator).unwrap();
		assert!(applied.resolved.is_empty());
		let got = read_local_with(&tree, Path::new("h"), None, false, opts, ctx).unwrap();
		assert_eq!(got, set(&[(&test_name("rsynctest.a"), b"1")]));
	}

	#[cfg(unix)]
	#[test]
	fn apply_works_on_read_only_files_for_their_owner() {
		use std::os::unix::fs::PermissionsExt;
		let (dir, tree) = scratch();
		let path = dir.path().join("ro");
		std::fs::write(&path, b"").unwrap();
		if tree.set_xattr(Path::new("ro"), bytes_os(&test_name("rsynctest.probe")).unwrap(), b"1", false).is_err() {
			return;
		}
		std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o444)).unwrap();
		let wanted = set(&[(&test_name("rsynctest.v"), b"2")]);
		let only_ours = |name: &[u8]| !name.windows(9).any(|w| w == b"rsynctest");
		let ctx = XattrCtx { filter: Some(&only_ours), ..XattrCtx::default() };
		apply_with(&tree, Path::new("ro"), &wanted, false, XattrOpts::default(), ctx).unwrap();
		let got = read_local_with(&tree, Path::new("ro"), None, false, XattrOpts::default(), ctx).unwrap();
		assert_eq!(got, wanted);
		assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o444);
	}
}
