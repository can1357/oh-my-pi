//! Hard-link grouping.
//!
//! Sender: [`HlinkTracker`] decides, while the file list is built, which entries are
//! hard-linked and how they are described on the wire — by dev/inode before protocol 30,
//! by the index of the group's first entry from protocol 30 on.
//!
//! Receiver: after a list is sorted, [`match_hard_links`] (or [`HlinkMatcher`] under
//! incremental recursion) gathers the members of each group, marks the first and last
//! member (FLAG_HLINK_FIRST / FLAG_HLINK_LAST) and chains every member to the previous one
//! (`Hlink::Linked { prev }`), so the generator can create the first and link the rest.

use std::collections::HashMap;

use crate::rsync::consts::{
	FLAG_HLINK_DONE, FLAG_HLINK_FIRST, FLAG_HLINK_LAST, FLAG_HLINKED, mode_is_dir,
};
use crate::rsync::exit::{RERR_PROTOCOL, RsyncError};
use crate::rsync::flist::{FileList, Hlink};
use crate::rsync::log::{Debug as DebugFlag, LogCode, Logger, big_num};
use crate::rsync::wire::Proto;

/// Sender-side hard-link detection: remembers the first index seen for every dev/inode.
pub(crate) struct HlinkTracker {
	proto: Proto,
	first_seen: HashMap<(u64, u64), i32>,
	logger: Option<Logger>,
}

impl HlinkTracker {
	pub(crate) fn new(proto: Proto) -> Self {
		Self { proto, first_seen: HashMap::new(), logger: None }
	}

	/// Enables `--debug=hlink3` output for new group leaders.
	pub(crate) fn set_logger(&mut self, logger: Logger) {
		self.logger = Some(logger);
	}

	/// The `Hlink` for an entry about to be sent as global index `ndx`. Only non-directories
	/// with more than one link take part (callers pass this only under `-H`).
	pub(crate) fn assign(&mut self, dev: u64, ino: u64, nlink: u64, mode: u32, ndx: i32) -> Hlink {
		if mode_is_dir(mode) || nlink <= 1 {
			return Hlink::None;
		}
		if self.proto.version < 30 {
			return Hlink::DevIno(dev, ino);
		}
		if let Some(&leader) = self.first_seen.get(&(dev, ino)) {
			return Hlink::Follower(leader);
		}
		self.first_seen.insert((dev, ino), ndx);
		if let Some(logger) = &self.logger
			&& logger.levels().debug(DebugFlag::Hlink) >= 3
		{
			let human = logger.config().human_readable;
			let text = format!(
				"[{}] dev:inode for #{} is {}:{}\n",
				logger.role().name(),
				ndx,
				big_num(dev as i64, human),
				big_num(ino as i64, human)
			);
			logger.rprintf(LogCode::Info, text.as_bytes());
		}
		Hlink::Leader
	}

	/// Forgets every group (a non-incremental list is complete; nothing can refer back).
	pub(crate) fn clear(&mut self) {
		self.first_seen.clear();
	}
}

/// Receiver: what is known about a hard-link group that started in an earlier list.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum PriorHlink {
	/// Global index of the group's latest member seen so far.
	Pending(i32),
	/// The group is finished; this is the name of the file the rest link to.
	Done(Vec<u8>),
}

/// Receiver-side hard-link matching state across incremental-recursion lists.
#[derive(Default)]
pub(crate) struct HlinkMatcher {
	prior: HashMap<i32, PriorHlink>,
}

impl HlinkMatcher {
	pub(crate) fn new() -> Self {
		Self::default()
	}

	/// State of group `gnum` from earlier lists.
	pub(crate) fn prior(&self, gnum: i32) -> Option<&PriorHlink> {
		self.prior.get(&gnum)
	}

	/// Records that group `gnum` is complete and lives at `name`.
	pub(crate) fn set_done(&mut self, gnum: i32, name: Vec<u8>) {
		self.prior.insert(gnum, PriorHlink::Done(name));
	}

	/// Matches the hard links of one incremental list. `clear_last(ndx)` must drop
	/// FLAG_HLINK_LAST from the entry with global index `ndx` in an earlier list and return
	/// false when that list is already gone.
	pub(crate) fn match_list(
		&mut self,
		list: &mut FileList,
		clear_last: &mut dyn FnMut(i32) -> bool,
	) -> Result<(), RsyncError> {
		match_groups(list, Some((&mut self.prior, clear_last)))
	}
}

/// Receiver, non-incremental: groups the hard-linked entries of `list` (by leader index from
/// protocol 30, by dev/inode before), flags first/last members, and links each member to
/// the previous one. A "group" with a single member loses its hard-link status.
pub(crate) fn match_hard_links(list: &mut FileList, _proto: Proto) {
	// Without a prior-list table there is no reference that could be out of range.
	let _ = match_groups(list, None);
}

type Prior<'a> = (&'a mut HashMap<i32, PriorHlink>, &'a mut dyn FnMut(i32) -> bool);

fn match_groups(list: &mut FileList, mut inc: Option<Prior<'_>>) -> Result<(), RsyncError> {
	// Group key per hard-linked entry; dev/inode pairs get numbers in list order.
	let mut dev_groups: HashMap<(u64, u64), i32> = HashMap::new();
	let mut members: Vec<(i32, usize)> = Vec::new();
	for (i, e) in list.entries.iter().enumerate() {
		if !e.is_active() || e.flags & FLAG_HLINKED == 0 {
			continue;
		}
		let gnum = match e.hlink {
			Hlink::First(g) | Hlink::Follower(g) | Hlink::Linked { gnum: g, .. } => g,
			Hlink::DevIno(dev, ino) => {
				let next = dev_groups.len() as i32;
				*dev_groups.entry((dev, ino)).or_insert(next)
			}
			Hlink::None | Hlink::Leader => continue,
		};
		members.push((gnum, i));
	}
	members.sort_unstable();

	let ndx_start = list.ndx_start;
	let mut at = 0;
	while at < members.len() {
		let gnum = members[at].0;
		let end = at + members[at..].iter().take_while(|(g, _)| *g == gnum).count();
		let group = &members[at..end];
		at = end;

		let first_idx = group[0].1;
		let mut prev = -1i32;
		let mut pending = false;
		match inc.as_mut() {
			Some((prior, clear_last)) => match prior.get(&gnum) {
				None => {
					if gnum < ndx_start {
						return Err(RsyncError::new(
							RERR_PROTOCOL,
							format!("hard-link gnum {gnum} precedes flist start {ndx_start}"),
						)
						.at("hlink.c", 141));
					}
					prior.insert(gnum, PriorHlink::Pending(-1));
					list.entries[first_idx].flags |= FLAG_HLINK_FIRST;
					pending = true;
				}
				Some(PriorHlink::Pending(last)) => {
					let last = *last;
					pending = true;
					if clear_last(last) {
						prev = last;
					} else {
						// Every earlier member was skipped: this one starts the group here.
						list.entries[first_idx].flags |= FLAG_HLINK_FIRST;
					}
				}
				Some(PriorHlink::Done(_)) => {}
			},
			None => list.entries[first_idx].flags |= FLAG_HLINK_FIRST,
		}

		let (last_member, rest) = group.split_last().unwrap_or((&group[0], &[]));
		for &(_, i) in rest {
			list.entries[i].hlink = Hlink::Linked { gnum, prev };
			prev = i as i32 + ndx_start;
		}
		let last_idx = last_member.1;
		let last = &mut list.entries[last_idx];
		if prev < 0 && inc.is_none() {
			// A lone member is not a hard link after all.
			last.flags &= !(FLAG_HLINKED | FLAG_HLINK_FIRST);
			last.flags |= FLAG_HLINK_DONE;
			last.hlink = Hlink::Linked { gnum, prev };
			continue;
		}
		last.flags |= FLAG_HLINK_LAST;
		last.hlink = Hlink::Linked { gnum, prev };
		if pending && let Some((prior, _)) = inc.as_mut() {
			prior.insert(gnum, PriorHlink::Pending(last_idx as i32 + ndx_start));
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::rsync::flist::FileEntry;

	const REG: u32 = 0o100644;

	fn file(name: &str, hlink: Hlink) -> FileEntry {
		let flags = if hlink == Hlink::None { 0 } else { FLAG_HLINKED };
		FileEntry {
			basename: name.as_bytes().to_vec().into_boxed_slice(),
			mode: REG,
			flags,
			hlink,
			..FileEntry::default()
		}
	}

	#[test]
	fn tracker_assigns_leaders_and_followers() {
		let mut t = HlinkTracker::new(Proto::new(31, 0));
		assert_eq!(t.assign(1, 10, 2, REG, 0), Hlink::Leader);
		assert_eq!(t.assign(1, 11, 1, REG, 1), Hlink::None);
		assert_eq!(t.assign(1, 12, 3, 0o040755, 2), Hlink::None);
		assert_eq!(t.assign(2, 10, 2, REG, 3), Hlink::Leader);
		assert_eq!(t.assign(1, 10, 2, REG, 4), Hlink::Follower(0));
		t.clear();
		assert_eq!(t.assign(1, 10, 2, REG, 5), Hlink::Leader);
		let mut old = HlinkTracker::new(Proto::new(29, 0));
		assert_eq!(old.assign(1, 10, 2, REG, 0), Hlink::DevIno(1, 10));
		assert_eq!(old.assign(1, 10, 2, REG, 1), Hlink::DevIno(1, 10));
	}

	#[test]
	fn groups_by_leader_index() {
		// Sorted list: b(→0), a(first, wire #0), c(lone, wire #5), d(→0).
		let mut list = FileList::default();
		list.entries.push(file("b", Hlink::Follower(0)));
		list.entries.push(file("a", Hlink::First(0)));
		list.entries.push(file("c", Hlink::First(5)));
		list.entries.push(file("d", Hlink::Follower(0)));
		list.entries.push(file("plain", Hlink::None));
		match_hard_links(&mut list, Proto::new(31, 0));
		let e = &list.entries;
		assert_eq!(e[0].flags & (FLAG_HLINK_FIRST | FLAG_HLINK_LAST), FLAG_HLINK_FIRST);
		assert_eq!(e[0].hlink, Hlink::Linked { gnum: 0, prev: -1 });
		assert_eq!(e[1].flags & (FLAG_HLINK_FIRST | FLAG_HLINK_LAST), 0);
		assert_eq!(e[1].hlink, Hlink::Linked { gnum: 0, prev: 0 });
		assert_eq!(e[3].flags & FLAG_HLINK_LAST, FLAG_HLINK_LAST);
		assert_eq!(e[3].hlink, Hlink::Linked { gnum: 0, prev: 1 });
		// The lone member stops being a hard link.
		assert_eq!(e[2].flags & (FLAG_HLINKED | FLAG_HLINK_FIRST), 0);
		assert_eq!(e[2].flags & FLAG_HLINK_DONE, FLAG_HLINK_DONE);
		assert_eq!(e[4].flags, 0);
		assert_eq!(e[4].hlink, Hlink::None);
	}

	#[test]
	fn groups_by_dev_ino_before_protocol_30() {
		let mut list = FileList { ndx_start: 0, ..FileList::default() };
		list.entries.push(file("x", Hlink::DevIno(1, 7)));
		list.entries.push(file("y", Hlink::DevIno(2, 7)));
		list.entries.push(file("z", Hlink::DevIno(1, 7)));
		match_hard_links(&mut list, Proto::new(29, 0));
		let e = &list.entries;
		assert_eq!(e[0].flags & FLAG_HLINK_FIRST, FLAG_HLINK_FIRST);
		assert_eq!(e[2].flags & FLAG_HLINK_LAST, FLAG_HLINK_LAST);
		assert_eq!(e[2].hlink, Hlink::Linked { gnum: 0, prev: 0 });
		assert_eq!(e[1].flags & FLAG_HLINKED, 0);
	}

	#[test]
	fn incremental_groups_continue_across_lists() {
		let mut m = HlinkMatcher::new();
		let mut first = FileList { ndx_start: 1, ..FileList::default() };
		first.entries.push(file("a", Hlink::First(1)));
		m.match_list(&mut first, &mut |_| unreachable!()).unwrap();
		// A single member stays hard-linked under inc-recurse; it is both first and last.
		assert_eq!(first.entries[0].flags & (FLAG_HLINK_FIRST | FLAG_HLINK_LAST), FLAG_HLINK_FIRST | FLAG_HLINK_LAST);
		assert_eq!(m.prior(1), Some(&PriorHlink::Pending(1)));

		let mut second = FileList { ndx_start: 3, ..FileList::default() };
		second.entries.push(file("b", Hlink::Follower(1)));
		let mut cleared = Vec::new();
		m.match_list(&mut second, &mut |ndx| {
			cleared.push(ndx);
			true
		})
		.unwrap();
		assert_eq!(cleared, [1]);
		assert_eq!(second.entries[0].hlink, Hlink::Linked { gnum: 1, prev: 1 });
		assert_eq!(second.entries[0].flags & (FLAG_HLINK_FIRST | FLAG_HLINK_LAST), FLAG_HLINK_LAST);
		assert_eq!(m.prior(1), Some(&PriorHlink::Pending(3)));

		// The earlier list is gone: the next member starts over as first.
		let mut third = FileList { ndx_start: 5, ..FileList::default() };
		third.entries.push(file("c", Hlink::Follower(1)));
		m.match_list(&mut third, &mut |_| false).unwrap();
		assert_eq!(third.entries[0].flags & FLAG_HLINK_FIRST, FLAG_HLINK_FIRST);
		assert_eq!(third.entries[0].hlink, Hlink::Linked { gnum: 1, prev: -1 });

		// A finished group neither chains nor becomes first.
		m.set_done(1, b"a".to_vec());
		let mut fourth = FileList { ndx_start: 7, ..FileList::default() };
		fourth.entries.push(file("d", Hlink::Follower(1)));
		m.match_list(&mut fourth, &mut |_| unreachable!()).unwrap();
		assert_eq!(fourth.entries[0].flags & (FLAG_HLINK_FIRST | FLAG_HLINK_LAST), FLAG_HLINK_LAST);
		assert_eq!(m.prior(1), Some(&PriorHlink::Done(b"a".to_vec())));
	}

	#[test]
	fn back_reference_to_unknown_group_is_rejected() {
		let mut m = HlinkMatcher::new();
		let mut list = FileList { ndx_start: 10, ..FileList::default() };
		list.entries.push(file("x", Hlink::Follower(4)));
		let err = m.match_list(&mut list, &mut |_| true).unwrap_err();
		assert_eq!(err.code, RERR_PROTOCOL);
		assert_eq!(err.message.as_deref(), Some("hard-link gnum 4 precedes flist start 10"));
	}
}
