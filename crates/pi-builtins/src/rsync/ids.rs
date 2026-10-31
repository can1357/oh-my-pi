//! User and group ids: the name lists exchanged with the peer, local name lookups, and the
//! mapping of the sender's ids onto local ids (`--numeric-ids`, `--usermap`, `--groupmap`;
//! the options module turns `--chown` into the equivalent `*:NAME` maps).
//!
//! Sender side: every uid/gid that goes into the file list is registered with
//! [`IdLists::add_uid`] / [`IdLists::add_gid`]; after the list the names are sent with
//! [`IdLists::send_lists`] (or inline in the entries under incremental recursion).
//!
//! Receiver side: names arrive either as lists ([`IdLists::recv_lists`]) or inline
//! ([`IdLists::recv_user_name`]); each remote id is mapped once (explicit map rule first,
//! then a local lookup of the sender's name, else the numeric id) and the result is
//! cached. Id 0 is never mapped by name.

use std::collections::HashMap;
#[cfg(unix)]
use std::ffi::{CStr, CString};
use std::fmt::NumBuffer;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex};

use crate::rsync::consts::{CF_ID0_NAMES, FLAG_SKIP_GROUP};
use crate::rsync::flists::lock;
use crate::rsync::exit::{RERR_SYNTAX, RsyncError};
use crate::rsync::flist::{FileList, FlistOpts};
use crate::rsync::log::{Debug as DebugFlag, LogCode, Logger};
use crate::rsync::wildmatch::wildmatch;
use crate::rsync::wire::{Proto, ReadExt, WriteExt};

/// This process's effective uid; `None` on Windows, which has no POSIX owners.
pub(crate) fn effective_uid() -> Option<u32> {
	#[cfg(unix)]
	{
		Some(rustix::process::geteuid().as_raw())
	}
	#[cfg(not(unix))]
	{
		None
	}
}

/// Which id space a list or map is about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
	User,
	Group,
}

impl Kind {
	const fn word(self) -> &'static str {
		match self {
			Self::User => "user",
			Self::Group => "group",
		}
	}
}

/// What the left-hand side of one map rule matches.
#[derive(Clone, Debug, PartialEq, Eq)]
enum MapFrom {
	/// A wildcard pattern matched against the sender's name.
	Wild(Vec<u8>),
	/// An exact sender name.
	Name(Vec<u8>),
	/// A numeric id (`high == 0`) or an inclusive id range `low-high`.
	Ids { low: u32, high: u32 },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct MapRule {
	from: MapFrom,
	to: u32,
}

impl MapRule {
	fn matches(&self, id: u32, name: &[u8]) -> bool {
		match &self.from {
			MapFrom::Wild(pat) => wildmatch(pat, name),
			MapFrom::Name(n) => n.as_slice() == name,
			MapFrom::Ids { low, high } if *high != 0 => id >= *low && id <= *high,
			MapFrom::Ids { low, .. } => *low == id,
		}
	}
}

/// A parsed `--usermap` / `--groupmap` (rules in command-line order; first match wins).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct NameMap {
	rules: Vec<MapRule>,
}

impl NameMap {
	fn lookup(&self, id: u32, name: &[u8]) -> Option<u32> {
		self.rules.iter().find(|r| r.matches(id, name)).map(|r| r.to)
	}
}

/// Parses `--usermap` on the receiver. Items whose target user is unknown are reported
/// (`Unknown --usermap name on receiver: …`) and skipped; syntax errors fail with
/// RERR_SYNTAX and upstream's text. Items are examined last to first, like upstream, so
/// messages appear in that order.
pub(crate) fn parse_usermap(spec: &str, logger: &Logger) -> Result<NameMap, RsyncError> {
	parse_name_map(spec, Kind::User, Some(logger))
}

/// Parses `--groupmap` on the receiver (see [`parse_usermap`]).
pub(crate) fn parse_groupmap(spec: &str, logger: &Logger) -> Result<NameMap, RsyncError> {
	parse_name_map(spec, Kind::Group, Some(logger))
}

fn syntax_err(msg: String, line: u32) -> RsyncError {
	RsyncError::new(RERR_SYNTAX, msg).at("uidlist.c", line)
}

/// Upstream's decimal id parser: digits only, 32-bit wrapping with a (weak) overflow check.
fn id_parse(s: &str) -> Result<u32, RsyncError> {
	let mut num: u32 = 0;
	for &b in s.as_bytes() {
		if !b.is_ascii_digit() {
			return Err(syntax_err(format!("Invalid ID number: {s}"), 85));
		}
		let next = num.wrapping_mul(10).wrapping_add(u32::from(b - b'0'));
		if next < num {
			return Err(syntax_err(format!("Invalid ID number: {s}"), 85));
		}
		num = next;
	}
	Ok(num)
}

/// Resolves the right-hand side of a map item: a number or a local name.
fn resolve_target(name: &str, kind: Kind) -> Result<Option<u32>, RsyncError> {
	if name.is_empty() {
		return Ok(None);
	}
	if name.bytes().all(|b| b.is_ascii_digit()) {
		return id_parse(name).map(Some);
	}
	Ok(match kind {
		Kind::User => name_uid(name.as_bytes()),
		Kind::Group => name_gid(name.as_bytes()),
	})
}

fn parse_name_map(spec: &str, kind: Kind, logger: Option<&Logger>) -> Result<NameMap, RsyncError> {
	let word = kind.word();
	let mut rules = Vec::new();
	for item in spec.rsplit(',') {
		let Some(colon) = item.find(':') else {
			return Err(syntax_err(format!("No colon found in --{word}map: {item}"), 514));
		};
		let (from, to) = (&item[..colon], &item[colon + 1..]);
		if to.is_empty() {
			return Err(syntax_err(format!("No name found after colon --{word}map: {item}"), 519));
		}
		let from_rule = if from.as_bytes().first().is_some_and(u8::is_ascii_digit) {
			let all_numeric = from.bytes().all(|b| b.is_ascii_digit() || b == b'-');
			let dash = from.find('-');
			let bad_dash = dash.is_some_and(|d| d + 1 == from.len() || from[d + 1..].contains('-'));
			if !all_numeric || bad_dash {
				return Err(syntax_err(format!("Invalid number in --{word}map: {from}"), 529));
			}
			match dash {
				Some(d) => {
					let high = id_parse(&from[d + 1..])?;
					let low = id_parse(&from[..d])?;
					MapFrom::Ids { low, high }
				}
				None => MapFrom::Ids { low: id_parse(from)?, high: 0 },
			}
		} else if from.contains(['*', '[', '?']) {
			MapFrom::Wild(from.as_bytes().to_vec())
		} else {
			MapFrom::Name(from.as_bytes().to_vec())
		};
		match resolve_target(to, kind)? {
			Some(id) => rules.push(MapRule { from: from_rule, to: id }),
			None => {
				if let Some(logger) = logger {
					let text = format!("Unknown --{word}map name on receiver: {to}\n");
					logger.rprintf(LogCode::Error, text.as_bytes());
				}
			}
		}
	}
	rules.reverse();
	Ok(NameMap { rules })
}

/// One remote id the receiver has seen, with what it maps to locally.
#[derive(Clone, Debug)]
struct IdNode {
	id: u32,
	name: Option<Vec<u8>>,
	local: u32,
	skip_group: bool,
}

/// Option snapshot the id code consults (refreshed from [`FlistOpts`] by every entry point
/// that receives options).
#[derive(Clone, Copy, Debug, Default)]
struct IdCfg {
	am_root: bool,
	numeric_ids: bool,
	preserve_uid: bool,
	preserve_gid: bool,
	xmit_id0_names: bool,
}

impl IdCfg {
	fn new(proto: Proto, opts: &FlistOpts) -> Self {
		Self {
			am_root: opts.am_root,
			numeric_ids: opts.numeric_ids,
			preserve_uid: opts.preserve_uid,
			preserve_gid: opts.preserve_gid,
			xmit_id0_names: proto.has(CF_ID0_NAMES),
		}
	}
}

/// Per-connection uid/gid state for one side of a transfer.
#[derive(Default)]
pub(crate) struct IdLists {
	cfg: IdCfg,
	/// Sender: ids put into the file list, in registration order, with their local names.
	sent_uids: Vec<(u32, Option<Vec<u8>>)>,
	sent_gids: Vec<(u32, Option<Vec<u8>>)>,
	sent_uid_index: HashMap<u32, usize>,
	sent_gid_index: HashMap<u32, usize>,
	/// Receiver: remote ids seen so far (newest last; lookups search newest first).
	recv_uids: Vec<IdNode>,
	recv_gids: Vec<IdNode>,
	last_uid: Option<usize>,
	last_gid: Option<usize>,
	usermap: Option<NameMap>,
	groupmap: Option<NameMap>,
	logger: Option<Logger>,
}

impl IdLists {
	/// Fresh state configured for `proto` and `opts`.
	pub(crate) fn new(proto: Proto, opts: &FlistOpts) -> Self {
		Self { cfg: IdCfg::new(proto, opts), ..Self::default() }
	}

	/// Refreshes the option snapshot (called by the file-list codecs on every entry).
	pub(crate) fn configure(&mut self, proto: Proto, opts: &FlistOpts) {
		self.cfg = IdCfg::new(proto, opts);
	}

	/// Enables `--debug=own` output.
	pub(crate) fn set_logger(&mut self, logger: Logger) {
		self.logger = Some(logger);
	}

	/// Receiver: installs `--usermap` / `--groupmap` (parsed by [`parse_usermap`] /
	/// [`parse_groupmap`]) before the first file list. When the sender will not transmit
	/// the id-0 names, id 0 is registered as "root" (or nameless with `--numeric-ids`).
	pub(crate) fn set_maps(
		&mut self,
		proto: Proto,
		opts: &FlistOpts,
		usermap: Option<NameMap>,
		groupmap: Option<NameMap>,
	) {
		self.configure(proto, opts);
		let root_name = (!self.cfg.numeric_ids).then(|| b"root".to_vec());
		if let Some(map) = usermap {
			self.usermap = Some(map);
			if !self.cfg.xmit_id0_names {
				self.recv_add(Kind::User, 0, root_name.clone());
			}
		}
		if let Some(map) = groupmap {
			self.groupmap = Some(map);
			if !self.cfg.xmit_id0_names {
				self.recv_add(Kind::Group, 0, root_name);
			}
		}
	}

	/// Whether a `--usermap` is installed.
	pub(crate) fn has_usermap(&self) -> bool {
		self.usermap.is_some()
	}

	/// Whether a `--groupmap` is installed.
	pub(crate) fn has_groupmap(&self) -> bool {
		self.groupmap.is_some()
	}

	/// Sender: registers `uid`; returns its name only the first time it is added (None when
	/// already listed or when it has no local name).
	pub(crate) fn add_uid(&mut self, uid: u32) -> Option<Vec<u8>> {
		if self.sent_uid_index.contains_key(&uid) {
			return None;
		}
		let name = uid_name(uid);
		self.sent_uid_index.insert(uid, self.sent_uids.len());
		self.sent_uids.push((uid, name.clone()));
		name
	}

	/// Sender: registers `gid` (see [`IdLists::add_uid`]).
	pub(crate) fn add_gid(&mut self, gid: u32) -> Option<Vec<u8>> {
		if self.sent_gid_index.contains_key(&gid) {
			return None;
		}
		let name = gid_name(gid);
		self.sent_gid_index.insert(gid, self.sent_gids.len());
		self.sent_gids.push((gid, name.clone()));
		name
	}

	/// Sender: the uid and gid name lists after a non-incremental file list
	/// (send_id_lists). Nothing is sent with `--numeric-ids` or incremental recursion.
	pub(crate) fn send_lists(
		&self,
		w: &mut dyn io::Write,
		proto: Proto,
		opts: &FlistOpts,
	) -> io::Result<()> {
		if opts.numeric_ids || opts.inc_recurse {
			return Ok(());
		}
		let id0 = proto.has(CF_ID0_NAMES);
		if opts.preserve_uid || opts.preserve_acls {
			send_one_list(w, proto, &self.sent_uids, id0.then(|| uid_name(0)))?;
		}
		if opts.preserve_gid || opts.preserve_acls {
			send_one_list(w, proto, &self.sent_gids, id0.then(|| gid_name(0)))?;
		}
		Ok(())
	}

	/// Receiver: reads the name lists that follow a non-incremental file list
	/// (recv_id_list's reading half; [`IdLists::map_entries`] is the other half).
	pub(crate) fn recv_lists(
		&mut self,
		r: &mut dyn io::Read,
		proto: Proto,
		opts: &FlistOpts,
	) -> Result<(), RsyncError> {
		self.configure(proto, opts);
		if opts.inc_recurse || opts.numeric_ids {
			return Ok(());
		}
		for kind in [Kind::User, Kind::Group] {
			let wanted = match kind {
				Kind::User => opts.preserve_uid,
				Kind::Group => opts.preserve_gid,
			};
			if !(wanted || opts.preserve_acls) {
				continue;
			}
			loop {
				let id = r.read_varint30(proto).map_err(RsyncError::from_stream)? as u32;
				if id == 0 {
					break;
				}
				self.recv_name(r, kind, id)?;
			}
			if self.cfg.xmit_id0_names {
				self.recv_name(r, kind, 0)?;
			}
		}
		Ok(())
	}

	/// Receiver: rewrites every entry's uid/gid from the sender's ids to local ids (and sets
	/// FLAG_SKIP_GROUP where a non-root receiver is not a member of the mapped group).
	pub(crate) fn map_entries(&self, list: &mut FileList) {
		let cfg = self.cfg;
		let map_uids = cfg.am_root && cfg.preserve_uid && (!cfg.numeric_ids || self.usermap.is_some());
		let map_gids =
			cfg.preserve_gid && (!cfg.am_root || !cfg.numeric_ids || self.groupmap.is_some());
		let mut fresh_uids: HashMap<u32, u32> = HashMap::new();
		let mut fresh_gids: HashMap<u32, (u32, bool)> = HashMap::new();
		for e in &mut list.entries {
			if map_uids {
				let uid = e.uid;
				e.uid = match find_node(&self.recv_uids, uid) {
					Some(node) => node.local,
					None => *fresh_uids.entry(uid).or_insert_with(|| {
						let node = self.compute(Kind::User, uid, None);
						self.debug_mapping(Kind::User, &node);
						node.local
					}),
				};
			}
			if map_gids {
				let gid = e.gid;
				let (local, skip) = match find_node(&self.recv_gids, gid) {
					Some(node) => (node.local, node.skip_group),
					None => *fresh_gids.entry(gid).or_insert_with(|| {
						let node = self.compute(Kind::Group, gid, None);
						self.debug_mapping(Kind::Group, &node);
						(node.local, node.skip_group)
					}),
				};
				e.gid = local;
				if skip {
					e.flags |= FLAG_SKIP_GROUP;
				}
			}
		}
	}

	/// Receiver: maps one remote uid (registering it on first sight).
	pub(crate) fn match_uid(&mut self, uid: u32) -> u32 {
		if let Some(i) = self.last_uid
			&& let Some(node) = self.recv_uids.get(i)
			&& node.id == uid
		{
			return node.local;
		}
		let i = match position_newest(&self.recv_uids, uid) {
			Some(i) => i,
			None => self.recv_add(Kind::User, uid, None),
		};
		self.last_uid = Some(i);
		self.recv_uids[i].local
	}

	/// Receiver: maps one remote gid (registering it on first sight).
	pub(crate) fn match_gid(&mut self, gid: u32) -> u32 {
		self.match_gid_flags(gid).0
	}

	/// [`IdLists::match_gid`] plus whether the entry gets FLAG_SKIP_GROUP.
	pub(crate) fn match_gid_flags(&mut self, gid: u32) -> (u32, bool) {
		let i = match self.last_gid {
			Some(i) if self.recv_gids.get(i).is_some_and(|n| n.id == gid) => i,
			_ => match position_newest(&self.recv_gids, gid) {
				Some(i) => i,
				None => self.recv_add(Kind::Group, gid, None),
			},
		};
		self.last_gid = Some(i);
		let node = &self.recv_gids[i];
		(node.local, node.skip_group)
	}

	/// Receiver: reads an inline user name (length byte + bytes) for remote `uid`, registers
	/// the mapping, and returns the local uid.
	pub(crate) fn recv_user_name(
		&mut self,
		r: &mut dyn io::Read,
		uid: u32,
	) -> Result<u32, RsyncError> {
		Ok(self.recv_name(r, Kind::User, uid)?.0)
	}

	/// Receiver: reads an inline group name for remote `gid` (see
	/// [`IdLists::recv_user_name`]).
	pub(crate) fn recv_group_name(
		&mut self,
		r: &mut dyn io::Read,
		gid: u32,
	) -> Result<u32, RsyncError> {
		Ok(self.recv_name(r, Kind::Group, gid)?.0)
	}

	/// [`IdLists::recv_group_name`] plus whether the entry gets FLAG_SKIP_GROUP.
	pub(crate) fn recv_group_name_flags(
		&mut self,
		r: &mut dyn io::Read,
		gid: u32,
	) -> Result<(u32, bool), RsyncError> {
		self.recv_name(r, Kind::Group, gid)
	}

	/// Reads a length byte + name for remote `id`, registers the mapping (the node keeps the
	/// name), and returns (local id, FLAG_SKIP_GROUP needed).
	fn recv_name(
		&mut self,
		r: &mut dyn io::Read,
		kind: Kind,
		id: u32,
	) -> Result<(u32, bool), RsyncError> {
		let len = usize::from(r.read_u8().map_err(RsyncError::from_stream)?);
		let name = if len == 0 {
			None
		} else {
			let mut bytes = r.read_bytes(len, 255).map_err(RsyncError::from_stream)?;
			// Names are C strings upstream: anything after a NUL is not part of the name.
			if let Some(nul) = bytes.iter().position(|&b| b == 0) {
				bytes.truncate(nul);
			}
			Some(bytes)
		};
		let i = self.recv_add(kind, id, name);
		let node = match kind {
			Kind::User => &self.recv_uids[i],
			Kind::Group => &self.recv_gids[i],
		};
		Ok((node.local, node.skip_group))
	}

	/// Computes the local id for a remote id/name pair without registering it.
	fn compute(&self, kind: Kind, id: u32, name: Option<Vec<u8>>) -> IdNode {
		let key: &[u8] = name.as_deref().unwrap_or(b"");
		let map = match kind {
			Kind::User => self.usermap.as_ref(),
			Kind::Group => self.groupmap.as_ref(),
		};
		let local = match map.and_then(|m| m.lookup(id, key)) {
			Some(local) => local,
			None if !key.is_empty() && id != 0 => match kind {
				Kind::User => name_uid(key).unwrap_or(id),
				Kind::Group => name_gid(key).unwrap_or(id),
			},
			None => id,
		};
		let skip_group = kind == Kind::Group && !self.cfg.am_root && !self.is_in_group(local);
		IdNode { id, name, local, skip_group }
	}

	fn recv_add(&mut self, kind: Kind, id: u32, name: Option<Vec<u8>>) -> usize {
		let node = self.compute(kind, id, name);
		self.debug_mapping(kind, &node);
		let list = match kind {
			Kind::User => &mut self.recv_uids,
			Kind::Group => &mut self.recv_gids,
		};
		list.push(node);
		list.len() - 1
	}

	fn debug_mapping(&self, kind: Kind, node: &IdNode) {
		let Some(logger) = &self.logger else { return };
		if logger.levels().debug(DebugFlag::Own) < 2 {
			return;
		}
		let mut text = Vec::new();
		text.extend_from_slice(if kind == Kind::User { b"uid " } else { b"gid " });
		let mut buf = NumBuffer::new();
		text.extend_from_slice(node.id.format_into(&mut buf).as_bytes());
		text.push(b'(');
		text.extend_from_slice(node.name.as_deref().unwrap_or(b""));
		text.extend_from_slice(b") maps to ");
		text.extend_from_slice(node.local.format_into(&mut buf).as_bytes());
		text.push(b'\n');
		logger.rprintf(LogCode::Info, &text);
	}

	fn is_in_group(&self, gid: u32) -> bool {
		let groups = process_groups(self.logger.as_ref());
		groups.contains(&gid)
	}
}

fn find_node(list: &[IdNode], id: u32) -> Option<&IdNode> {
	list.iter().rev().find(|n| n.id == id)
}

fn position_newest(list: &[IdNode], id: u32) -> Option<usize> {
	list.iter().rposition(|n| n.id == id)
}

fn send_one_name(w: &mut dyn io::Write, proto: Proto, id: u32, name: &[u8]) -> io::Result<()> {
	let name = &name[..name.len().min(255)];
	w.write_varint30(proto, id as i32)?;
	w.write_u8(name.len() as u8)?;
	w.write_all(name)
}

/// One id list: newest registration first (upstream prepends), nameless ids and id 0
/// skipped, terminated by id 0 (with its name when CF_ID0_NAMES is negotiated).
fn send_one_list(
	w: &mut dyn io::Write,
	proto: Proto,
	list: &[(u32, Option<Vec<u8>>)],
	id0_name: Option<Option<Vec<u8>>>,
) -> io::Result<()> {
	for (id, name) in list.iter().rev() {
		if let Some(name) = name
			&& *id != 0
		{
			send_one_name(w, proto, *id, name)?;
		}
	}
	match id0_name {
		Some(name) => send_one_name(w, proto, 0, name.as_deref().unwrap_or(b"")),
		None => w.write_varint30(proto, 0),
	}
}

#[cfg(unix)]
fn load_process_groups() -> Vec<u32> {
	let mut set: Vec<libc::gid_t> = Vec::new();
	// SAFETY: getgroups(0, NULL) only returns the count.
	let n = unsafe { libc::getgroups(0, std::ptr::null_mut()) };
	if n > 0 {
		set.resize(usize::try_from(n).unwrap_or(0), 0);
		// SAFETY: `set` has room for exactly `n` gids.
		let got = unsafe { libc::getgroups(n, set.as_mut_ptr()) };
		set.truncate(usize::try_from(got).unwrap_or(0));
	}
	// SAFETY: getegid has no preconditions.
	let egid = unsafe { libc::getegid() };
	if !set.contains(&egid) {
		set.push(egid);
	}
	set
}

/// Windows has no POSIX groups: every local file reports gid 0, which is "ours".
#[cfg(windows)]
fn load_process_groups() -> Vec<u32> {
	vec![0]
}

static PROCESS_GROUPS: LazyLock<Vec<u32>> = LazyLock::new(load_process_groups);
static PROCESS_GROUPS_REPORTED: AtomicBool = AtomicBool::new(false);

/// The supplementary groups of this process plus its effective gid (computed once; the
/// set is reported once under `--debug=own2`).
fn process_groups(logger: Option<&Logger>) -> &'static [u32] {
	let groups = &*PROCESS_GROUPS;
	if let Some(logger) = logger
		&& logger.levels().debug(DebugFlag::Own) >= 2
		&& !PROCESS_GROUPS_REPORTED.swap(true, Ordering::Relaxed)
	{
		let mut text =
			format!("process has {} gid{}: ", groups.len(), if groups.len() == 1 { "" } else { "s" });
		for g in groups {
			text.push_str(&format!(" {}", *g as i32));
		}
		text.push('\n');
		logger.rprintf(LogCode::Info, text.as_bytes());
	}
	groups
}

#[derive(Default)]
struct NameCache {
	uid_names: HashMap<u32, Option<Vec<u8>>>,
	gid_names: HashMap<u32, Option<Vec<u8>>>,
	user_ids: HashMap<Vec<u8>, Option<u32>>,
	group_ids: HashMap<Vec<u8>, Option<u32>>,
}

static NAME_CACHE: LazyLock<Mutex<NameCache>> = LazyLock::new(Mutex::default);

fn with_cache<T>(f: impl FnOnce(&mut NameCache) -> T) -> T {
	let mut guard = lock(&NAME_CACHE);
	f(&mut guard)
}

/// Local user name for `uid` (getpwuid, cached).
pub(crate) fn uid_name(uid: u32) -> Option<Vec<u8>> {
	if let Some(hit) = with_cache(|c| c.uid_names.get(&uid).cloned()) {
		return hit;
	}
	let name = user_by_uid(uid);
	with_cache(|c| c.uid_names.insert(uid, name.clone()));
	name
}

/// Local group name for `gid` (getgrgid, cached).
pub(crate) fn gid_name(gid: u32) -> Option<Vec<u8>> {
	if let Some(hit) = with_cache(|c| c.gid_names.get(&gid).cloned()) {
		return hit;
	}
	let name = group_by_gid(gid);
	with_cache(|c| c.gid_names.insert(gid, name.clone()));
	name
}

/// Local uid for a user name (getpwnam, cached).
pub(crate) fn name_uid(name: &[u8]) -> Option<u32> {
	if name.is_empty() {
		return None;
	}
	if let Some(hit) = with_cache(|c| c.user_ids.get(name).copied()) {
		return hit;
	}
	let id = uid_by_name(name);
	with_cache(|c| c.user_ids.insert(name.to_vec(), id));
	id
}

/// Local gid for a group name (getgrnam, cached).
pub(crate) fn name_gid(name: &[u8]) -> Option<u32> {
	if name.is_empty() {
		return None;
	}
	if let Some(hit) = with_cache(|c| c.group_ids.get(name).copied()) {
		return hit;
	}
	let id = gid_by_name(name);
	with_cache(|c| c.group_ids.insert(name.to_vec(), id));
	id
}

#[cfg(unix)]
fn user_by_uid(uid: u32) -> Option<Vec<u8>> {
	lookup_passwd(PwKey::Uid(uid)).map(|(name, _)| name)
}

#[cfg(unix)]
fn group_by_gid(gid: u32) -> Option<Vec<u8>> {
	lookup_group(GrKey::Gid(gid)).map(|(name, _)| name)
}

#[cfg(unix)]
fn uid_by_name(name: &[u8]) -> Option<u32> {
	lookup_passwd(PwKey::Name(name)).map(|(_, id)| id)
}

#[cfg(unix)]
fn gid_by_name(name: &[u8]) -> Option<u32> {
	lookup_group(GrKey::Name(name)).map(|(_, id)| id)
}

/// Windows has no POSIX user database: no id has a name and no name resolves.
#[cfg(windows)]
fn user_by_uid(_uid: u32) -> Option<Vec<u8>> {
	None
}

/// See the Windows [`user_by_uid`].
#[cfg(windows)]
fn group_by_gid(_gid: u32) -> Option<Vec<u8>> {
	None
}

/// See the Windows [`user_by_uid`].
#[cfg(windows)]
fn uid_by_name(_name: &[u8]) -> Option<u32> {
	None
}

/// See the Windows [`user_by_uid`].
#[cfg(windows)]
fn gid_by_name(_name: &[u8]) -> Option<u32> {
	None
}

#[cfg(unix)]
enum PwKey<'a> {
	Uid(u32),
	Name(&'a [u8]),
}

#[cfg(unix)]
enum GrKey<'a> {
	Gid(u32),
	Name(&'a [u8]),
}

#[cfg(unix)]
const LOOKUP_BUF_START: usize = 1024;
#[cfg(unix)]
const LOOKUP_BUF_MAX: usize = 1 << 20;

#[cfg(unix)]
fn lookup_passwd(key: PwKey<'_>) -> Option<(Vec<u8>, u32)> {
	let cname = match key {
		PwKey::Name(n) => Some(CString::new(n).ok()?),
		PwKey::Uid(_) => None,
	};
	let mut buf = vec![0u8; LOOKUP_BUF_START];
	loop {
		// SAFETY: passwd is a plain C struct; all-zero is a valid (empty) value.
		let mut pwd: libc::passwd = unsafe { std::mem::zeroed() };
		let mut result: *mut libc::passwd = std::ptr::null_mut();
		let rc = match (&key, &cname) {
			// SAFETY: every pointer is valid for the call and `buf` outlives the use of `pwd`.
			(PwKey::Uid(uid), _) => unsafe {
				libc::getpwuid_r(*uid, &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut result)
			},
			// SAFETY: as above; `c` is NUL-terminated.
			(PwKey::Name(_), Some(c)) => unsafe {
				libc::getpwnam_r(c.as_ptr(), &mut pwd, buf.as_mut_ptr().cast(), buf.len(), &mut result)
			},
			(PwKey::Name(_), None) => return None,
		};
		if rc == libc::ERANGE && buf.len() < LOOKUP_BUF_MAX {
			buf.resize(buf.len() * 2, 0);
			continue;
		}
		if rc != 0 || result.is_null() || pwd.pw_name.is_null() {
			return None;
		}
		// SAFETY: on success pw_name points to a NUL-terminated string inside `buf`.
		let name = unsafe { CStr::from_ptr(pwd.pw_name) }.to_bytes().to_vec();
		return Some((name, pwd.pw_uid));
	}
}

#[cfg(unix)]
fn lookup_group(key: GrKey<'_>) -> Option<(Vec<u8>, u32)> {
	let cname = match key {
		GrKey::Name(n) => Some(CString::new(n).ok()?),
		GrKey::Gid(_) => None,
	};
	let mut buf = vec![0u8; LOOKUP_BUF_START];
	loop {
		// SAFETY: group is a plain C struct; all-zero is a valid (empty) value.
		let mut grp: libc::group = unsafe { std::mem::zeroed() };
		let mut result: *mut libc::group = std::ptr::null_mut();
		let rc = match (&key, &cname) {
			// SAFETY: every pointer is valid for the call and `buf` outlives the use of `grp`.
			(GrKey::Gid(gid), _) => unsafe {
				libc::getgrgid_r(*gid, &mut grp, buf.as_mut_ptr().cast(), buf.len(), &mut result)
			},
			// SAFETY: as above; `c` is NUL-terminated.
			(GrKey::Name(_), Some(c)) => unsafe {
				libc::getgrnam_r(c.as_ptr(), &mut grp, buf.as_mut_ptr().cast(), buf.len(), &mut result)
			},
			(GrKey::Name(_), None) => return None,
		};
		if rc == libc::ERANGE && buf.len() < LOOKUP_BUF_MAX {
			buf.resize(buf.len() * 2, 0);
			continue;
		}
		if rc != 0 || result.is_null() || grp.gr_name.is_null() {
			return None;
		}
		// SAFETY: on success gr_name points to a NUL-terminated string inside `buf`.
		let name = unsafe { CStr::from_ptr(grp.gr_name) }.to_bytes().to_vec();
		return Some((name, grp.gr_gid));
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[cfg(unix)]
	use crate::rsync::consts::CF_VARINT_FLIST_FLAGS;

	fn parse(spec: &str, kind: Kind) -> Result<NameMap, RsyncError> {
		parse_name_map(spec, kind, None)
	}

	fn err_text(r: Result<NameMap, RsyncError>) -> (i32, String) {
		let e = r.expect_err("expected a parse error");
		(e.code, e.message.unwrap_or_default())
	}

	#[test]
	fn usermap_rules_keep_command_line_order() {
		let map = parse("5:7,10-20:8,*:9,bob:0", Kind::User).unwrap();
		assert_eq!(
			map.rules,
			vec![
				MapRule { from: MapFrom::Ids { low: 5, high: 0 }, to: 7 },
				MapRule { from: MapFrom::Ids { low: 10, high: 20 }, to: 8 },
				MapRule { from: MapFrom::Wild(b"*".to_vec()), to: 9 },
				MapRule { from: MapFrom::Name(b"bob".to_vec()), to: 0 },
			]
		);
		assert_eq!(map.lookup(5, b""), Some(7));
		assert_eq!(map.lookup(15, b"x"), Some(8));
		assert_eq!(map.lookup(21, b""), Some(9));
		assert_eq!(map.lookup(21, b"bob"), Some(9));
	}

	#[test]
	fn usermap_syntax_errors_match_upstream() {
		assert_eq!(
			err_text(parse("abc", Kind::User)),
			(RERR_SYNTAX, "No colon found in --usermap: abc".into())
		);
		assert_eq!(
			err_text(parse("abc:", Kind::Group)),
			(RERR_SYNTAX, "No name found after colon --groupmap: abc:".into())
		);
		assert_eq!(
			err_text(parse("1x:0", Kind::User)),
			(RERR_SYNTAX, "Invalid number in --usermap: 1x".into())
		);
		assert_eq!(
			err_text(parse("1-:0", Kind::User)),
			(RERR_SYNTAX, "Invalid number in --usermap: 1-".into())
		);
		assert_eq!(
			err_text(parse("1-2-3:0", Kind::User)),
			(RERR_SYNTAX, "Invalid number in --usermap: 1-2-3".into())
		);
		assert_eq!(
			err_text(parse("4294967296:0", Kind::User)),
			(RERR_SYNTAX, "Invalid ID number: 4294967296".into())
		);
		assert_eq!(
			err_text(parse("1:4294967296", Kind::User)),
			(RERR_SYNTAX, "Invalid ID number: 4294967296".into())
		);
		// Items are examined from the last one backwards.
		assert_eq!(
			err_text(parse("nocolon,x:", Kind::User)),
			(RERR_SYNTAX, "No name found after colon --usermap: x:".into())
		);
		// An empty item has no colon.
		assert_eq!(
			err_text(parse("1:0,,2:0", Kind::User)),
			(RERR_SYNTAX, "No colon found in --usermap: ".into())
		);
	}

	#[test]
	fn id_parse_wraps_like_upstream() {
		// 9999999999 wraps without tripping upstream's overflow check.
		assert_eq!(id_parse("9999999999").unwrap(), 9_999_999_999u64 as u32);
		assert_eq!(id_parse("4294967295").unwrap(), u32::MAX);
	}

	#[test]
	fn unknown_target_names_are_dropped() {
		let map = parse("1:no-such-user-xyzzy-42,2:0", Kind::User).unwrap();
		assert_eq!(map.rules, vec![MapRule { from: MapFrom::Ids { low: 2, high: 0 }, to: 0 }]);
	}

	#[cfg(unix)]
	#[test]
	fn names_and_numbers_resolve_locally() {
		assert_eq!(uid_name(0).as_deref(), Some(&b"root"[..]));
		assert_eq!(name_uid(b"root"), Some(0));
		assert_eq!(name_uid(b"no-such-user-xyzzy-42"), None);
		let map = parse("joe:root", Kind::User).unwrap();
		assert_eq!(map.lookup(77, b"joe"), Some(0));
		assert_eq!(map.lookup(77, b"jo"), None);
	}

	#[test]
	fn wildcard_rules_match_sender_names() {
		let map = parse("us?r:5,[a-c]*:6,*:7", Kind::User).unwrap();
		assert_eq!(map.lookup(1, b"user"), Some(5));
		assert_eq!(map.lookup(1, b"bob"), Some(6));
		assert_eq!(map.lookup(1, b"zed"), Some(7));
		// A nameless id still matches "*" (it is compared as the empty name).
		assert_eq!(map.lookup(1, b""), Some(7));
	}

	fn opts(inc: bool) -> FlistOpts {
		FlistOpts { preserve_uid: true, preserve_gid: true, inc_recurse: inc, ..FlistOpts::default() }
	}

	#[cfg(unix)]
	#[test]
	fn id_lists_round_trip_all_protocols() {
		for (version, compat) in [(29, 0), (30, 0), (31, CF_VARINT_FLIST_FLAGS), (33, CF_ID0_NAMES)] {
			let p = Proto::new(version, compat);
			let o = opts(false);
			let mut tx = IdLists::new(p, &o);
			assert_eq!(tx.add_uid(0).as_deref(), Some(&b"root"[..]));
			assert_eq!(tx.add_uid(0), None);
			tx.add_uid(4_000_000_001);
			let gname = tx.add_gid(0);
			assert!(gname.is_some());
			let mut wire = Vec::new();
			tx.send_lists(&mut wire, p, &o).unwrap();
			let mut rx = IdLists::new(p, &o);
			let mut r = &wire[..];
			rx.recv_lists(&mut r, p, &o).unwrap();
			assert!(r.is_empty(), "v{version}: trailing bytes");
			if compat & CF_ID0_NAMES != 0 {
				assert_eq!(rx.recv_uids.len(), 1);
				assert_eq!(rx.recv_uids[0].name.as_deref(), Some(&b"root"[..]));
			} else {
				// Id 0 and nameless ids are never listed: just the two terminators.
				let expected: &[u8] = if version >= 30 { &[0, 0] } else { &[0; 8] };
				assert_eq!(wire, expected);
			}
		}
	}

	#[cfg(unix)]
	#[test]
	fn id_list_golden_bytes() {
		let p = Proto::new(31, 0);
		let mut tx = IdLists::default();
		tx.sent_uids = vec![(5, Some(b"ab".to_vec())), (6, None), (300, Some(b"c".to_vec()))];
		let mut wire = Vec::new();
		tx.send_lists(&mut wire, p, &opts(false)).unwrap();
		// Newest first; varint 300 = 0x81 0x2c; uid list then empty gid list.
		assert_eq!(wire, [0x81, 0x2c, 1, b'c', 5, 2, b'a', b'b', 0, 0]);
		let p0 = Proto::new(31, CF_ID0_NAMES);
		let mut wire = Vec::new();
		IdLists::default()
			.send_lists(&mut wire, p0, &FlistOpts { preserve_uid: true, ..FlistOpts::default() })
			.unwrap();
		assert_eq!(wire, [0, 4, b'r', b'o', b'o', b't']);
		let mut none = Vec::new();
		IdLists::default().send_lists(&mut none, p0, &opts(true)).unwrap();
		assert!(none.is_empty());
	}

	#[cfg(unix)]
	#[test]
	fn receiver_maps_by_name_and_rules() {
		let p = Proto::new(31, 0);
		let mut o = opts(false);
		o.am_root = true;
		let mut ids = IdLists::new(p, &o);
		ids.set_maps(p, &o, Some(parse("100-199:0", Kind::User).unwrap()), None);
		// Sender's uid 1234 is called "root" over there: mapped by name.
		let mut wire = Vec::new();
		wire.write_varint30(p, 1234).unwrap();
		wire.extend_from_slice(&[4, b'r', b'o', b'o', b't', 0, 0]);
		ids.recv_lists(&mut &wire[..], p, &o).unwrap();
		let mut list = FileList::default();
		for uid in [1234u32, 150, 4_000_000_000] {
			list.entries.push(crate::rsync::flist::FileEntry {
				basename: b"f".to_vec().into_boxed_slice(),
				uid,
				..Default::default()
			});
		}
		ids.map_entries(&mut list);
		let uids: Vec<u32> = list.entries.iter().map(|e| e.uid).collect();
		assert_eq!(uids, [0, 0, 4_000_000_000]);
		assert_eq!(ids.match_uid(150), 0);
		assert_eq!(ids.match_uid(7), 7);
	}

	#[cfg(unix)]
	#[test]
	fn non_root_marks_foreign_groups() {
		let p = Proto::new(31, 0);
		let o = opts(false);
		let mut ids = IdLists::new(p, &o);
		let (_, skip) = ids.match_gid_flags(4_000_000_123);
		assert!(skip);
		// SAFETY: getegid has no preconditions.
		let own = unsafe { libc::getegid() };
		let (gid, skip) = ids.match_gid_flags(own);
		assert_eq!(gid, own);
		assert!(!skip);
	}

	#[test]
	fn inline_names_truncate_at_nul() {
		let p = Proto::new(31, 0);
		let mut ids = IdLists::new(p, &opts(true));
		let wire = [3u8, b'x', 0, b'y'];
		let uid = ids.recv_user_name(&mut &wire[..], 42).unwrap();
		assert_eq!(uid, 42);
		assert_eq!(ids.recv_uids[0].name.as_deref(), Some(&b"x"[..]));
	}
}
