//! Hard-link handling on the generator side (hard_link_check, maybe_hard_link,
//! hard_link_one, finish_hard_link, skip_hard_link, handle_skipped_hlink).
//!
//! Members of a group are chained through their `prev` index (upstream F_HL_PREV);
//! the generator's copy of that chain lives in its overlay. Under incremental
//! recursion a finished group's name is recorded in the shared matcher so members in
//! later file lists can link to it after the leader's list is gone.

use std::io;

use pi_vfs::Metadata;

use super::{Code, Gen, Loc, Sx};
use crate::rsync::{
	flists::lock,
	consts::{
		DEL_FOR_FILE, FLAG_FILE_SENT, FLAG_HLINK_DONE, FLAG_HLINK_FIRST, FLAG_HLINK_LAST,
		FLAG_SKIP_HLINK, ITEM_LOCAL_CHANGE, ITEM_XNAME_FOLLOWS, LINK_DEST,
	},
	exit::{RERR_MESSAGEIO, RsyncError},
	flist::{FileEntry, Hlink},
	hlink::PriorHlink,
	log::{Debug as DebugFlag, Info, LogCode},
};

/// Where a group's finished file lives.
enum Prior {
	/// An entry of a live list.
	Entry(i32),
	/// A name recorded for a finished group of an earlier list.
	Name(Vec<u8>),
	/// Nothing: this member is treated as the first.
	None,
}

impl Gen<'_> {
	fn gnum(&self, key: i32) -> i32 {
		match self.flists.entry(key).map(|e| e.hlink) {
			Some(Hlink::Linked { gnum, .. }) => gnum,
			_ => -1,
		}
	}

	/// check_prior: is the previous member still around, or only its name?
	fn check_prior(&mut self, key: i32, gnum: i32) -> Prior {
		let mut prev = self.hl_prev(key);
		while prev >= 0 && self.seg_for(prev).is_some() {
			let Some(fp) = self.file(prev) else {
				break;
			};
			if fp.flags & FLAG_SKIP_HLINK == 0 {
				return Prior::Entry(prev);
			}
			prev = self.hl_prev(prev);
			self.set_hl_prev(key, prev);
		}
		if self.inc() {
			let found = {
				let matcher =
					lock(&self.flists.hlinks());
				matcher.prior(gnum).cloned()
			};
			match found {
				Some(PriorHlink::Done(name)) => return Prior::Name(name),
				// The prior file must have been skipped.
				Some(PriorHlink::Pending(_)) => self.set_hl_prev(key, -1),
				None => {},
			}
		}
		Prior::None
	}

	fn hlink_debug(&self, ndx: i32, file: &FileEntry, gnum: i32, tail: &[u8]) {
		if self.debug(DebugFlag::Hlink) >= 2 {
			let text = [
				format!("hlink for {ndx} (").as_bytes(),
				&file.name(),
				format!(",{gnum}): ").as_bytes(),
				tail,
				b"\n",
			]
			.concat();
			self.say(LogCode::Info, &text);
		}
	}

	/// A location named by an absolute path (a dry-run alt-dest leader) or a
	/// destination-relative name.
	fn named_loc(&self, name: &[u8]) -> Option<Loc> {
		if name.first() == Some(&b'/') {
			let path = crate::rsync::paths::bytes_path(name).ok()?;
			let parent = path.parent()?.to_path_buf();
			let leaf = path.file_name()?.to_owned();
			let opts = crate::rsync::tree::TreeOpts {
				insecure_links: self.opts.insecure_links,
				operator_named: true,
				confine: None,
			};
			let tree = crate::rsync::tree::Tree::open(&self.ctx.fs, &parent, &opts).ok()?;
			return Some(Loc { tree, rel: leaf.into(), disp: name.to_vec() });
		}
		self.dest_loc(name).ok()
	}

	/// hard_link_check: 0 = process the file, 1 = handled (or waiting), -1 = error.
	#[allow(clippy::too_many_arguments, reason = "upstream hard_link_check")]
	pub(super) fn hard_link_check(
		&mut self,
		key: i32,
		ndx: i32,
		fname: &[u8],
		loc: &Loc,
		mut statret: i32,
		sx: &mut Sx,
		mut itemizing: bool,
		mut code: Code,
	) -> Result<i32, RsyncError> {
		let file = self.file_or_err(key, "hard_link_check")?;
		let gnum = if self.inc() { self.gnum(key) } else { -1 };

		let (prev_loc, realname, prev_ndx) = match self.check_prior(key, gnum) {
			Prior::Name(name) => {
				let Some(prev_loc) = self.named_loc(&name) else {
					return Ok(-1);
				};
				(prev_loc, name, -1)
			},
			Prior::None => {
				self.hlink_debug(ndx, &file, gnum, b"virtual first");
				return Ok(0);
			},
			Prior::Entry(mut prev) => {
				let prev_file = self.file_or_err(prev, "hard_link_check")?;
				if prev_file.flags & FLAG_HLINK_DONE == 0 {
					if prev_file.flags & FLAG_FILE_SENT != 0 {
						// Wait for the leader's transfer, then get linked by finish_hard_link.
						let leader_prev = self.hl_prev(prev);
						self.set_hl_prev(key, leader_prev);
						self.set_hl_prev(prev, ndx);
						self.add_flags(key, FLAG_FILE_SENT);
						Self::bump(&mut self.in_progress, self.cur_seg, 1);
						let tail = format!("waiting for {leader_prev}");
						self.hlink_debug(ndx, &file, gnum, tail.as_bytes());
						return Ok(1);
					}
					self.hlink_debug(ndx, &file, gnum, b"looking for a leader");
					return Ok(0);
				}
				let mut named: Option<Vec<u8>> = None;
				if prev_file.flags & FLAG_HLINK_FIRST == 0 {
					// The previous previous is FIRST when prev is not.
					match self.check_prior(prev, gnum) {
						Prior::Entry(first) => {
							prev = first;
							self.set_hl_prev(key, first);
						},
						Prior::Name(name) => {
							named = Some(name);
							self.set_hl_prev(key, -1);
						},
						Prior::None => {
							self.set_hl_prev(key, -1);
							return Ok(0);
						},
					}
				}
				match named {
					Some(name) => {
						let Some(prev_loc) = self.named_loc(&name) else {
							return Ok(-1);
						};
						(prev_loc, name, -1)
					},
					None => {
						let leader = self.file_or_err(prev, "hard_link_check")?;
						let alt_dest = self.hl_prev(prev);
						let tail = format!("found flist match (alt {alt_dest})");
						self.hlink_debug(ndx, &file, gnum, tail.as_bytes());
						let leader_name = leader.name();
						let prev_loc = if alt_dest >= 0
							&& self.dry_run
							&& (alt_dest as usize) < self.trees.alt_dirs.len()
						{
							self.alt_loc(alt_dest as usize, &leader_name).ok()
						} else {
							self.dest_loc(&leader_name).ok()
						};
						let Some(prev_loc) = prev_loc else {
							return Ok(-1);
						};
						(prev_loc, leader_name, prev)
					},
				}
			},
		};

		if self.debug(DebugFlag::Hlink) >= 2 {
			let tail = [format!("leader is {prev_ndx} (").as_bytes(), &prev_loc.disp, b")"].concat();
			self.hlink_debug(ndx, &file, gnum, &tail);
		}

		let prev_st = match self.stat_loc(&prev_loc.tree, &prev_loc.rel, false) {
			Ok(st) => Some(st),
			Err(err) => {
				if !self.dry_run || err.kind() != io::ErrorKind::NotFound {
					let text = [&b"stat "[..], &prev_loc.full(), b" failed"].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(-1);
				}
				// A new link gets a new identity; dry-run approximates it as unknown.
				None
			},
		};
		let prev_id = prev_st.as_ref().and_then(Metadata::file_id).map(|id| (id.dev(), id.ino()));

		if statret < 0 && !self.trees.alt_dirs.is_empty() {
			// A matching alt-dest item is not reported as a change.
			let mut matched: Option<Sx> = None;
			for j in 0..self.trees.alt_dirs.len() {
				let Ok(alt) = self.alt_loc(j, fname) else {
					continue;
				};
				let Ok(st) = self.stat_loc(&alt.tree, &alt.rel, false) else {
					continue;
				};
				let mut alt_sx = Sx::of(st, &alt.tree, &alt.rel);
				if self.opts.alt_dest_type == LINK_DEST {
					if prev_id.is_none() || alt_sx.dev_ino() != prev_id {
						continue;
					}
					statret = 1;
					if self.stdout_has_i() == 0 || (self.info(Info::Name) < 2 && self.stdout_has_i() < 2) {
						itemizing = false;
						code = None;
						if self.info(Info::Name) >= 2 && self.attrs_report != 0 {
							self.say(LogCode::Client, &[fname, b" is uptodate\n"].concat());
						}
					}
					matched = Some(alt_sx);
					break;
				}
				if !file.is_reg() || !self.quick_check_ok(super::Ftype::Reg, &alt, &file, &alt_sx) {
					continue;
				}
				statret = 1;
				let unchanged = self.unchanged_attrs(&file, &mut alt_sx);
				matched = Some(alt_sx);
				if unchanged {
					break;
				}
			}
			if statret == 1
				&& let Some(alt_sx) = matched
			{
				*sx = alt_sx;
			}
		}

		if self.maybe_hard_link(key, ndx, fname, loc, statret, sx, &prev_loc, prev_id, &realname, itemizing, code)?
			< 0
		{
			return Ok(-1);
		}
		if self.opts.remove_source_files == 1 && self.opts.do_xfers {
			self.send_success(fname, ndx)?;
		}
		Ok(1)
	}

	/// maybe_hard_link: links `fname` to `old` unless it already is that file.
	#[allow(clippy::too_many_arguments, reason = "upstream maybe_hard_link")]
	fn maybe_hard_link(
		&mut self,
		key: i32,
		ndx: i32,
		fname: &[u8],
		loc: &Loc,
		statret: i32,
		sx: &mut Sx,
		old: &Loc,
		old_id: Option<(u64, u64)>,
		realname: &[u8],
		itemizing: bool,
		code: Code,
	) -> Result<i32, RsyncError> {
		let file = self.file_or_err(key, "maybe_hard_link")?;
		if statret == 0 && old_id.is_some() && sx.dev_ino() == old_id {
			if itemizing {
				self.itemize(&file, ndx, statret, sx, ITEM_LOCAL_CHANGE | ITEM_XNAME_FOLLOWS, 0, Some(&b""[..]))?;
			}
			if self.info(Info::Name) >= 2 && self.attrs_report != 0 {
				self.say(LogCode::Client, &[fname, b" is uptodate\n"].concat());
			}
			self.add_flags(key, FLAG_HLINK_DONE);
			return Ok(0);
		}
		let del_for = if statret == 0 { DEL_FOR_FILE } else { 0 };
		if self.atomic_create(key, &file, fname, loc, super::entry::Create::Link(old), sx, del_for)? {
			if itemizing {
				let file = self.file(key).unwrap_or(file);
				self.itemize(&file, ndx, statret, sx, ITEM_LOCAL_CHANGE | ITEM_XNAME_FOLLOWS, 0, Some(realname))?;
			}
			if code.is_some() && self.info(Info::Name) >= 1 {
				self.say_code(code, &[fname, b" => ", realname, b"\n"].concat());
			}
			return Ok(0);
		}
		Ok(-1)
	}

	/// hard_link_one: link `old` at `new`; `terse` reports a failure only at --info=name.
	pub(super) fn hard_link_one(&mut self, key: i32, new: &Loc, old: &Loc, terse: bool) -> bool {
		let result = if self.dry_run { Ok(()) } else { new.tree.hard_link((&old.tree, &old.rel), &new.rel) };
		if let Err(err) = result {
			let code = if terse {
				if self.info(Info::Name) < 1 {
					return false;
				}
				LogCode::Info
			} else {
				LogCode::ErrorXfer
			};
			let text = [&b"link "[..], &new.full(), b" => ", &old.disp, b" failed"].concat();
			self.log.rsyserr(code, &err, &text);
			return false;
		}
		self.add_flags(key, FLAG_HLINK_DONE);
		true
	}

	/// finish_hard_link: the leader is done; link every member waiting on it.
	#[allow(clippy::too_many_arguments, reason = "upstream finish_hard_link")]
	pub(super) fn finish_hard_link(
		&mut self,
		key: i32,
		fname: &[u8],
		fin_ndx: i32,
		stp: Option<Metadata>,
		itemizing: bool,
		code: Code,
		alt_dest: i32,
	) -> Result<(), RsyncError> {
		let mut prev_ndx = self.hl_prev(key);
		let loc = self.dest_loc(fname).ok();
		let mut st = stp;
		if st.is_none() && prev_ndx >= 0 {
			match loc.as_ref().map(|l| self.stat_loc(&l.tree, &l.rel, false)) {
				Some(Ok(meta)) => st = Some(meta),
				Some(Err(err)) if !self.dry_run => {
					let text = [&b"stat "[..], &self.full(fname), b" failed"].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(());
				},
				_ => {},
			}
		}
		let st_id = st.as_ref().and_then(Metadata::file_id).map(|id| (id.dev(), id.ino()));

		// FIRST combined with DONE means we were the first to get done.
		self.add_flags(key, FLAG_HLINK_FIRST | FLAG_HLINK_DONE);
		self.set_hl_prev(key, alt_dest);
		let our = if alt_dest >= 0 && self.dry_run && (alt_dest as usize) < self.trees.alt_dirs.len() {
			self.alt_loc(alt_dest as usize, fname).ok()
		} else {
			loc.clone()
		};
		let Some(our) = our else {
			return Ok(());
		};

		while prev_ndx >= 0 {
			let ndx = prev_ndx;
			let Some(seg) = self.seg_for(ndx) else {
				return Err(self.ndx_error(ndx, "finish_hard_link"));
			};
			self.add_flags(ndx, FLAG_HLINK_DONE);
			self.clear_flags(ndx, FLAG_HLINK_FIRST);
			prev_ndx = self.hl_prev(ndx);
			self.set_hl_prev(ndx, fin_ndx);
			let member = self.file_or_err(ndx, "finish_hard_link")?;
			let pname = member.name();
			let val = match self.dest_loc(&pname) {
				Ok(ploc) => {
					let (statret, mut psx) = match self.stat_loc(&ploc.tree, &ploc.rel, false) {
						Ok(meta) => (0, Sx::of(meta, &ploc.tree, &ploc.rel)),
						Err(_) => (-1, Sx::default()),
					};
					self.maybe_hard_link(ndx, ndx, &pname, &ploc, statret, &mut psx, &our, st_id, fname, itemizing, code)?
				},
				Err(_) => -1,
			};
			Self::bump(&mut self.in_progress, seg, -1);
			if val < 0 {
				continue;
			}
			if self.opts.remove_source_files == 1 && self.opts.do_xfers {
				self.send_success(fname, ndx)?;
			}
		}

		if self.inc() {
			let gnum = self.gnum(key);
			let name = self.file(key).map_or_default(|f| f.name());
			let mut matcher = lock(&self.flists.hlinks());
			match matcher.prior(gnum).cloned() {
				None => {
					let message = format!(
						"Unable to find a hlink node for {gnum} ({})",
						String::from_utf8_lossy(&name)
					);
					return Err(RsyncError::new(RERR_MESSAGEIO, message).at("hlink.c", 551));
				},
				Some(PriorHlink::Done(path)) => {
					let message = format!(
						"Hlink node data for {gnum} already has path={} ({})",
						String::from_utf8_lossy(&path),
						String::from_utf8_lossy(&name)
					);
					return Err(RsyncError::new(RERR_MESSAGEIO, message).at("hlink.c", 560));
				},
				Some(PriorHlink::Pending(_)) => {
					let recorded = if alt_dest >= 0 && self.dry_run { our.disp.clone() } else { fname.to_vec() };
					matcher.set_done(gnum, recorded);
				},
			}
		}
		Ok(())
	}

	/// skip_hard_link: returns the member that must now finish the group, if any.
	fn skip_hard_link(&mut self, key: i32) -> Option<i32> {
		self.add_flags(key, FLAG_SKIP_HLINK);
		let file = self.file(key)?;
		if file.flags & FLAG_HLINK_LAST == 0 {
			return None;
		}
		let gnum = self.gnum(key);
		match self.check_prior(key, gnum) {
			Prior::Entry(prev) => {
				let pf = self.file(prev)?;
				if pf.flags & (FLAG_HLINK_DONE | FLAG_FILE_SENT) != 0 {
					return None;
				}
				self.add_flags(prev, FLAG_HLINK_LAST);
				Some(prev)
			},
			_ => None,
		}
	}

	/// handle_skipped_hlink: if the skipped file was the last of its group and an earlier
	/// member is still waiting, process that member now.
	pub(super) fn handle_skipped_hlink(&mut self, key: i32) -> Result<(), RsyncError> {
		let Some(last) = self.skip_hard_link(key) else {
			return Ok(());
		};
		let Some(seg) = self.seg_for(last) else {
			return Err(self.ndx_error(last, "handle_skipped_hlink"));
		};
		let file = self.file_or_err(last, "handle_skipped_hlink")?;
		Self::bump(&mut self.in_progress, seg, -1);
		let saved = self.cur_seg;
		self.cur_seg = seg;
		let fname = file.name();
		let result = self.recv_generator(&fname, last, last, self.itemizing, self.code);
		self.cur_seg = saved;
		result
	}
}
