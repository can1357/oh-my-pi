//! recv_generator: the per-entry decision for every kind of file.

use std::{
	io::{self, Read, Seek, SeekFrom},
	path::Path,
};

use pi_vfs::NodeKind;

use super::{Code, Ftype, Gen, Loc, Sx, ftype_of, is_not_found};
use crate::rsync::{
	backup,
	consts::{
		COPY_DEST, DEL_FOR_DEVICE, DEL_FOR_DIR, DEL_FOR_FILE, DEL_FOR_SPECIAL, DEL_FOR_SYMLINK,
		DEL_NO_UID_WRITE, DEL_RECURSE, FLAG_DIR_CREATED, FLAG_FILE_SENT, FLAG_HLINK_FIRST,
		FLAG_HLINK_LAST, FLAG_HLINKED, FLAG_IMPLIED_DIR, FLAG_MISSING_DIR, FLAG_TOP_DIR,
		FNAMECMP_BACKUP, FNAMECMP_BASIS_DIR_HIGH, FNAMECMP_FNAME, FNAMECMP_FUZZY,
		FNAMECMP_PARTIAL_DIR, ITEM_BASIS_TYPE_FOLLOWS, ITEM_LOCAL_CHANGE, ITEM_REPORT_CHANGE,
		ITEM_TRANSFER, ITEM_XNAME_FOLLOWS, LINK_DEST, S_IFBLK, S_IFCHR, S_IFIFO, S_IFMT,
		S_IFSOCK, mode_is_dir, mode_is_sock,
	},
	exit::{RERR_PROTOCOL, RsyncError},
	flist::{FileEntry, f_name_has_prefix},
	log::{Debug as DebugFlag, Info, LogCode},
	meta::{self, ATTRS_ACCURATE_TIME},
	paths::{self, rel_path},
};

impl Gen<'_> {
	/// is_below: is `file` inside the subtree rooted at `dir`?
	fn is_below(&self, file: &FileEntry, dir: &FileEntry) -> bool {
		file.depth() > dir.depth()
			&& (!self.implied_dirs_missing || f_name_has_prefix(file, dir, self.ctx.proto))
	}

	/// recv_generator(fname, file, ndx): `key` is the entry's global index, `ndx` the
	/// index sent to the sender (the segment's `ndx_start - 1` for an inc-recursion
	/// parent directory).
	pub(super) fn recv_generator(
		&mut self,
		fname: &[u8],
		key: i32,
		ndx: i32,
		mut itemizing: bool,
		mut code: Code,
	) -> Result<(), RsyncError> {
		let Some(mut file) = self.file(key) else {
			return Err(self.ndx_error(key, "recv_generator"));
		};
		let ftype = ftype_of(file.mode);
		let seg_start = self.flists.segment_start(self.cur_seg).unwrap_or(0);
		let is_dir: i32 = if ftype != Ftype::Dir {
			0
		} else if self.inc() && ndx != seg_start - 1 {
			-1
		} else {
			1
		};

		if self.debug(DebugFlag::Genr) >= 1 {
			let text = [&b"recv_generator("[..], fname, format!(",{ndx})\n").as_bytes()].concat();
			self.say(LogCode::Info, &text);
		}

		if self.opts.list_only != 0 {
			if is_dir < 0 || (is_dir != 0 && !self.opts.implied_dirs && file.flags & FLAG_IMPLIED_DIR != 0) {
				return Ok(());
			}
			self.list_file_entry(&file);
			return Ok(());
		}

		self.accurate_time = if self.t.always_checksum != 0 { ATTRS_ACCURATE_TIME } else { 0 };

		if let Some(skip) = self.skip_dir.clone() {
			if self.is_below(&file, &skip) {
				if is_dir != 0 {
					self.add_flags(key, FLAG_MISSING_DIR);
				} else if file.flags & FLAG_HLINKED != 0 {
					self.handle_skipped_hlink(key)?;
				}
				return Ok(());
			}
			self.skip_dir = None;
		}

		let loc = match self.dest_loc(fname) {
			Ok(loc) => loc,
			Err(err) => {
				let text = [&b"recv_generator: failed to stat "[..], &self.full(fname)].concat();
				self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
				return Ok(());
			},
		};

		let mut sx = Sx::default();
		let mut statret: i32;
		let stat_err: Option<io::Error>;
		let dry_parent = self.trees.dry_missing
			|| self.dry_missing_dir.as_ref().is_some_and(|d| self.is_below(&file, d));
		if dry_parent {
			self.parent_is_dry_missing();
			statret = -1;
			stat_err = Some(io::Error::from(io::ErrorKind::NotFound));
		} else {
			let dn: Vec<u8> = if file.dirname.is_empty() { b".".to_vec() } else { file.dirname.to_vec() };
			self.dry_missing_dir = None;
			let mut went_dry = false;
			if self.parent_dirname.as_deref() != Some(dn.as_slice()) {
				if !self.inc() && dn != b"." && self.prior_dir.as_deref() != Some(dn.as_slice()) {
					self.check_parent_in_list(&file, &dn)?;
				}
				if self.opts.relative_paths > 0 && !self.opts.implied_dirs && file.mode != 0 {
					let dn_missing = rel_path(&dn).map_or(true, |rel| self.trees.dest.stat(&rel).is_err());
					if dn_missing {
						if self.dry_run {
							went_dry = true;
						} else if let Err(err) = self.make_path(&loc, true) {
							let text = [&b"recv_generator: mkdir "[..], &self.full(&dn), b" failed"].concat();
							self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
						}
					}
				}
				if !went_dry {
					if !self.fuzzy_dirlist.is_empty() {
						for slot in &mut self.fuzzy_dirlist {
							*slot = None;
						}
						self.need_fuzzy_dirlist = true;
					}
					if self.meta.acls && !self.meta.perms {
						if let Ok(rel) = rel_path(&dn) {
							self.dflt_perms = crate::rsync::acl::default_perms_for_dir(
								&self.trees.dest,
								&rel,
								self.ctx.umask,
								self.dry_run,
								Some(&self.log),
							);
						}
					}
				}
			}
			if went_dry {
				self.parent_is_dry_missing();
				statret = -1;
				stat_err = Some(io::Error::from(io::ErrorKind::NotFound));
			} else {
				self.parent_dirname = Some(dn);
				let follow = self.opts.keep_dirlinks && is_dir != 0;
				match self.stat_loc(&loc.tree, &loc.rel, follow) {
					Ok(st) => {
						sx = Sx::of(st, &loc.tree, &loc.rel);
						statret = 0;
						stat_err = None;
					},
					Err(err) => {
						statret = -1;
						stat_err = Some(err);
					},
				}
			}
		}

		let mut del_opts = if self.opts.delete_mode || self.opts.force_delete { DEL_RECURSE } else { 0 };

		if self.opts.missing_args == 2 && file.mode == 0 {
			if !self.filters.is_empty()
				&& self.filters.check(fname, is_dir != 0, crate::rsync::filter::Side::Receiver)
					== crate::rsync::filter::Verdict::Exclude
			{
				return Ok(());
			}
			if statret == 0 {
				let mode = sx.mode();
				self.delete(fname, mode, del_opts)?;
			}
			return Ok(());
		}

		if self.t.ignore_non_existing > 0 && statret == -1 && stat_err.as_ref().is_some_and(is_not_found) {
			if is_dir != 0 {
				if is_dir < 0 {
					return Ok(());
				}
				self.skip_dir = Some(file.clone());
				self.add_flags(key, FLAG_MISSING_DIR);
			} else if file.flags & FLAG_HLINKED != 0 {
				self.handle_skipped_hlink(key)?;
			}
			if self.info(Info::Skip) >= 1 {
				let what: &[u8] = if is_dir != 0 { b"directory" } else { b"file" };
				let text = [&b"not creating new "[..], what, b" \"", fname, b"\"\n"].concat();
				self.say(LogCode::Info, &text);
			}
			return Ok(());
		}

		if statret == 0
			&& sx.mode() & 0o200 == 0
			&& !self.am_root()
			&& sx.st.as_ref().and_then(pi_vfs::Metadata::uid).is_some_and(|uid| Some(uid) == self.our_uid)
		{
			del_opts |= DEL_NO_UID_WRITE;
		}

		let stype = if statret == 0 { ftype_of(sx.mode()) } else { Ftype::Unsupported };

		if self.t.ignore_existing > 0 && statret == 0 && (is_dir == 0 || stype != Ftype::Dir) {
			if self.info(Info::Skip) >= 1 && is_dir >= 0 {
				let mut suf: &[u8] = b"";
				if self.info(Info::Skip) >= 2 {
					suf = if ftype != stype {
						b" (type change)"
					} else if !self.quick_check_ok(ftype, &loc, &file, &sx) {
						if self.t.always_checksum != 0 { b" (sum change)" } else { b" (file change)" }
					} else if !self.unchanged_attrs(&file, &mut sx) {
						b" (attr change)"
					} else {
						b" (uptodate)"
					};
				}
				let text = [fname, b" exists", suf, b"\n"].concat();
				self.say(LogCode::Info, &text);
			}
			if file.flags & FLAG_HLINKED != 0 {
				self.handle_skipped_hlink(key)?;
			}
			return Ok(());
		}

		if is_dir != 0 {
			return self.gen_dir(fname, key, ndx, &mut file, &loc, sx, statret, stype, is_dir, del_opts, itemizing, code);
		}

		// Without -p the file-list mode follows the local permissions.
		if !self.meta.perms {
			let exists = statret == 0 && stype != Ftype::Dir;
			let mode = meta::dest_mode_with(file.mode, Some(sx.mode()), exists, self.dflt_perms, &self.meta);
			file.mode = mode;
			self.set_mode(key, mode);
		}

		if self.hard_links()
			&& file.flags & FLAG_HLINKED != 0
			&& file.flags & FLAG_HLINK_FIRST == 0
			&& self.hard_link_check(key, ndx, fname, &loc, statret, &mut sx, itemizing, code)? != 0
		{
			return Ok(());
		}
		let file = self.file(key).unwrap_or(file);

		if self.opts.preserve_links && ftype == Ftype::Symlink {
			let sl: Vec<u8> = file.link.as_deref().unwrap_or_default().to_vec();
			if self.opts.safe_symlinks && crate::rsync::paths::unsafe_symlink(&sl, fname) {
				if self.info(Info::Name) >= 1 {
					let shown = if self.solo { file.name() } else { fname.to_vec() };
					let text = [&b"ignoring unsafe symlink \""[..], &shown, b"\" -> \"", &sl, b"\"\n"].concat();
					self.say(LogCode::Info, &text);
				}
				return Ok(());
			}
			if statret == 0 {
				if stype == Ftype::Symlink && self.quick_check_ok(stype, &loc, &file, &sx) {
					let st = sx.st.clone();
					self.set_attrs(key, &loc, &file, st.as_ref(), self.attrs_report, true)?;
					let file = self.file(key).unwrap_or(file);
					if itemizing {
						self.itemize(&file, ndx, 0, &mut sx, 0, 0, None)?;
					}
					if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
						self.finish_hard_link(key, fname, ndx, sx.st.clone(), itemizing, code, -1)?;
					}
					if self.opts.remove_source_files == 1 {
						return self.return_with_success(fname, ndx);
					}
					return Ok(());
				}
			} else if !self.trees.alt_dirs.is_empty() {
				let (j, _alt) = self.try_dests_non(key, fname, ndx, &file, &mut sx, itemizing, code)?;
				if j == -3 {
					itemizing = false;
					code = None;
				} else if j == -2 {
					let copy_like = !CAN_HARDLINK && self.opts.alt_dest_type == LINK_DEST;
					if !copy_like && self.opts.alt_dest_type != COPY_DEST {
						return Ok(());
					}
					itemizing = false;
					code = None;
				} else if j >= 0 {
					statret = 1;
				}
			}
			let del_for = if statret == 0 { DEL_FOR_SYMLINK } else { 0 };
			if self.atomic_create(key, &file, fname, &loc, Create::Symlink(&sl), &sx, del_for)? {
				self.set_attrs(key, &loc, &file, None, 0, true)?;
				let file = self.file(key).unwrap_or(file);
				if itemizing {
					let ret = if statret == 0 && stype != Ftype::Symlink { -1 } else { statret };
					self.itemize(&file, ndx, ret, &mut sx, ITEM_LOCAL_CHANGE | ITEM_REPORT_CHANGE, 0, None)?;
				}
				if code.is_some() && self.info(Info::Name) >= 1 {
					self.say_code(code, &[fname, b" -> ", &sl, b"\n"].concat());
				}
				if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
					self.finish_hard_link(key, fname, ndx, None, itemizing, code, -1)?;
				}
				if self.opts.remove_source_files != 0 {
					return self.return_with_success(fname, ndx);
				}
			}
			return Ok(());
		}

		if !self.opts.drop_devices
			&& ((self.am_root() && self.opts.preserve_devices && ftype == Ftype::Device)
				|| (self.opts.preserve_specials && ftype == Ftype::Special))
		{
			return self.gen_node(fname, key, ndx, &file, &loc, sx, statret, stype, ftype, itemizing, code);
		}

		if ftype != Ftype::Reg {
			if self.info(Info::Nonreg) >= 1 {
				let shown = if self.solo { file.name() } else { fname.to_vec() };
				let text = [&b"skipping non-regular file \""[..], &shown, b"\"\n"].concat();
				self.say(LogCode::Info, &text);
			}
			return Ok(());
		}

		self.gen_regular(fname, key, ndx, &file, &loc, sx, statret, stat_err, stype, del_opts, itemizing, code)
	}

	fn parent_is_dry_missing(&mut self) {
		for slot in &mut self.fuzzy_dirlist {
			*slot = None;
		}
		self.parent_dirname = None;
	}

	/// Every parent dir must be in the file list or the list is bad.
	fn check_parent_in_list(&mut self, file: &FileEntry, dn: &[u8]) -> Result<(), RsyncError> {
		let found = self
			.flists
			.with_segment(self.cur_seg, |list| list.find_name(dn, None).map(|j| list.entries[j].mode))
			.flatten();
		let missing_args = self.opts.missing_args == 2;
		let ok = match found {
			Some(mode) => mode_is_dir(mode) || (missing_args && file.mode == 0 && mode == 0),
			None => false,
		};
		if ok {
			return Ok(());
		}
		if missing_args && file.mode == 0 && found.is_none() {
			let text = [&b"WARNING: parent dir is absent in the file list: "[..], dn, b"\n"].concat();
			self.say(LogCode::Error, &text);
			return Ok(());
		}
		let message = format!(
			"ABORTING due to invalid path from sender: {}/{}",
			String::from_utf8_lossy(dn),
			String::from_utf8_lossy(&file.basename)
		);
		Err(RsyncError::new(RERR_PROTOCOL, message).at("generator.c", 1715))
	}

	fn return_with_success(&mut self, fname: &[u8], ndx: i32) -> Result<(), RsyncError> {
		if !self.dry_run {
			self.send_success(fname, ndx)?;
		}
		Ok(())
	}

	/// make_path(fname, MKP_DROP_NAME|MKP_SKIP_SLASH) in the destination tree (no-op
	/// under --dry-run, like every upstream do_* call).
	pub(super) fn make_path(&self, loc: &Loc, drop_name: bool) -> io::Result<usize> {
		if self.dry_run {
			return Ok(0);
		}
		loc.tree.make_path_count(&loc.rel, 0o777, drop_name)
	}

	fn do_mkdir(&self, loc: &Loc, mode: u32) -> io::Result<()> {
		if self.dry_run {
			return Ok(());
		}
		loc.tree.mkdir(&loc.rel, mode)
	}

	// ----- directories -------------------------------------------------------------

	#[allow(clippy::too_many_arguments, reason = "recv_generator's directory branch")]
	fn gen_dir(
		&mut self,
		fname: &[u8],
		key: i32,
		ndx: i32,
		file: &mut FileEntry,
		loc: &Loc,
		mut sx: Sx,
		mut statret: i32,
		stype: Ftype,
		is_dir: i32,
		del_opts: u32,
		mut itemizing: bool,
		mut code: Code,
	) -> Result<(), RsyncError> {
		if !self.opts.implied_dirs && file.flags & FLAG_IMPLIED_DIR != 0 {
			return Ok(());
		}
		let added_perms = if self.opts.am_root < 0 { 0o700 } else { 0 };
		if is_dir < 0 {
			if !self.opts.preserve_mtimes || self.opts.omit_dir_times != 0 {
				return Ok(());
			}
			// Create a missing directory now (while its parent is being handled) so the
			// parent's mtime can be fixed right away; the rest happens later.
			if statret == 0
				&& (stype == Ftype::Dir || !self.delete(fname, sx.mode(), del_opts | DEL_FOR_DIR)?)
			{
				return Ok(());
			}
			if self.do_mkdir(loc, (file.mode | added_perms) & 0o700).is_ok() {
				self.add_flags(key, FLAG_DIR_CREATED);
			}
			return Ok(());
		}

		if statret == 0 && stype != Ftype::Dir {
			if !self.delete(fname, sx.mode(), del_opts | DEL_FOR_DIR)? {
				return self.skipping_dir_contents(key, file);
			}
			statret = -1;
		}
		if self.dry_run && statret != 0 {
			if self.dry_missing_dir.is_none() {
				self.dry_missing_dir = Some(file.clone());
			}
			self.add_flags(key, FLAG_MISSING_DIR);
			file.flags |= FLAG_MISSING_DIR;
		}
		let real_st = sx.st.clone();
		let real_ret = statret;
		if file.flags & FLAG_DIR_CREATED != 0 {
			statret = -1;
		}
		if !self.meta.perms {
			let mode = meta::dest_mode_with(file.mode, Some(sx.mode()), statret == 0, self.dflt_perms, &self.meta);
			file.mode = mode;
			self.set_mode(key, mode);
		}
		let mut basis: Option<Loc> = None;
		if statret != 0 && !self.trees.alt_dirs.is_empty() {
			let (j, alt) = self.try_dests_non(key, fname, ndx, file, &mut sx, itemizing, code)?;
			// Upstream's fnamecmpbuf names the matched alt dir for both outcomes below.
			if j == -2 || j >= 0 {
				basis = alt;
			}
			if j == -2 {
				itemizing = false;
				code = None;
				statret = 1;
			} else if j >= 0 {
				statret = 1;
			}
		}
		if itemizing {
			let iflags = if statret != 0 { ITEM_LOCAL_CHANGE } else { 0 };
			self.itemize(file, ndx, statret, &mut sx, iflags, 0, None)?;
		}
		if real_ret != 0 {
			let mode = file.mode | added_perms;
			if let Err(err) = self.do_mkdir(loc, mode)
				&& err.kind() != io::ErrorKind::AlreadyExists
			{
				let retry = self.opts.relative_paths > 0
					&& is_not_found(&err)
					&& self.make_path(loc, true).is_ok();
				let second = if retry { self.do_mkdir(loc, mode) } else { Err(err) };
				if let Err(err) = second
					&& err.kind() != io::ErrorKind::AlreadyExists
				{
					let text = [&b"recv_generator: mkdir "[..], &loc.full(), b" failed"].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
					return self.skipping_dir_contents(key, file);
				}
			}
		}

		if self.meta.xattrs && statret == 1 && !self.dry_run {
			if let Some(alt) = &basis {
				let xctx = crate::rsync::xattr::XattrCtx { logger: Some(&self.log), ..Default::default() };
				let _ = crate::rsync::xattr::copy_local(
					(&alt.tree, &alt.rel),
					(&loc.tree, &loc.rel),
					false,
					self.ctx.xattr_opts,
					xctx,
				);
			}
		}
		let local = if real_ret == 0 { real_st.clone() } else { None };
		let changed = self.set_attrs(key, loc, file, local.as_ref(), 0, true)?;
		if changed != 0 && self.info(Info::Name) >= 1 && code.is_some() {
			self.say_code(code, &[fname, b"/\n"].concat());
		}

		// Directories must stay writable while files land in them; the final touch-up
		// restores their permissions.
		if !self.am_root() && file.mode & 0o700 != 0o700 && self.dir_tweaking {
			let mode = file.mode | 0o700;
			if let Err(err) = loc.tree.chmod(&loc.rel, mode & 0o7777) {
				let text = [&b"failed to modify permissions on "[..], &loc.full()].concat();
				self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
			}
			self.retouch_perms = true;
		}

		if file.flags & FLAG_TOP_DIR != 0 && self.opts.one_file_system > 0 {
			if let Some(dev) = real_st.as_ref().and_then(pi_vfs::Metadata::dev) {
				self.deleter.set_filesystem_dev(dev);
			}
		}
		let missing = self.file(key).is_some_and(|f| f.flags & FLAG_MISSING_DIR != 0);
		if !self.inc() && self.opts.delete_during != 0 && self.phase == 0 && !missing {
			let entry = self.file(key).unwrap_or_else(|| file.clone());
			self.delete_dir_contents(fname, key, &entry)?;
		}
		self.prior_dir = Some(file.name());
		Ok(())
	}

	fn skipping_dir_contents(&mut self, key: i32, file: &FileEntry) -> Result<(), RsyncError> {
		self.say(LogCode::Error, b"*** Skipping any contents from this failed directory ***\n");
		let mut skip = file.clone();
		skip.flags |= FLAG_MISSING_DIR;
		self.skip_dir = Some(skip);
		self.add_flags(key, FLAG_MISSING_DIR);
		Ok(())
	}

	// ----- devices and specials ------------------------------------------------------

	#[allow(clippy::too_many_arguments, reason = "recv_generator's device branch")]
	fn gen_node(
		&mut self,
		fname: &[u8],
		key: i32,
		ndx: i32,
		file: &FileEntry,
		loc: &Loc,
		mut sx: Sx,
		mut statret: i32,
		stype: Ftype,
		ftype: Ftype,
		mut itemizing: bool,
		mut code: Code,
	) -> Result<(), RsyncError> {
		let (rdev, del_for) = if ftype == Ftype::Device {
			let (major, minor) = file.rdev.unwrap_or((0, 0));
			(meta::dev_join(major, minor), DEL_FOR_DEVICE)
		} else {
			(0, DEL_FOR_SPECIAL)
		};
		let dest_existed = statret == 0;
		if statret == 0 {
			if ftype != stype {
				statret = -1;
			} else if self.quick_check_ok(ftype, loc, file, &sx) {
				let st = sx.st.clone();
				self.set_attrs(key, loc, file, st.as_ref(), self.attrs_report, true)?;
				if itemizing {
					self.itemize(file, ndx, 0, &mut sx, 0, 0, None)?;
				}
				if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
					self.finish_hard_link(key, fname, ndx, sx.st.clone(), itemizing, code, -1)?;
				}
				if self.opts.remove_source_files == 1 {
					return self.return_with_success(fname, ndx);
				}
				return Ok(());
			}
		} else if !self.trees.alt_dirs.is_empty() {
			let (j, _alt) = self.try_dests_non(key, fname, ndx, file, &mut sx, itemizing, code)?;
			if j == -3 {
				itemizing = false;
				code = None;
			} else if j == -2 {
				let copy_like = !CAN_HARDLINK_NODE && self.opts.alt_dest_type == LINK_DEST;
				if !copy_like && self.opts.alt_dest_type != COPY_DEST {
					return Ok(());
				}
				itemizing = false;
				code = None;
			} else if j >= 0 {
				statret = 1;
			}
		}
		if self.debug(DebugFlag::Genr) >= 1 {
			let (major, minor) = file.rdev.unwrap_or((0, 0));
			let text = [
				&b"mknod("[..],
				fname,
				format!(", 0{:o}, [{major},{minor}])\n", file.mode).as_bytes(),
			]
			.concat();
			self.say(LogCode::Info, &text);
		}
		let del = if dest_existed { del_for } else { 0 };
		if self.atomic_create(key, file, fname, loc, Create::Node(rdev), &sx, del)? {
			self.set_attrs(key, loc, file, None, 0, true)?;
			if itemizing {
				self.itemize(file, ndx, statret, &mut sx, ITEM_LOCAL_CHANGE | ITEM_REPORT_CHANGE, 0, None)?;
			}
			if code.is_some() && self.info(Info::Name) >= 1 {
				self.say_code(code, &[fname, b"\n"].concat());
			}
			if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
				self.finish_hard_link(key, fname, ndx, None, itemizing, code, -1)?;
			}
			if self.opts.remove_source_files == 1 {
				return self.return_with_success(fname, ndx);
			}
		}
		Ok(())
	}

	// ----- regular files ---------------------------------------------------------

	#[allow(clippy::too_many_arguments, reason = "recv_generator's regular-file branch")]
	fn gen_regular(
		&mut self,
		fname: &[u8],
		key: i32,
		ndx: i32,
		file: &FileEntry,
		loc: &Loc,
		mut sx: Sx,
		mut statret: i32,
		mut stat_err: Option<io::Error>,
		stype: Ftype,
		del_opts: u32,
		itemizing: bool,
		code: Code,
	) -> Result<(), RsyncError> {
		let shown = || if self.solo { file.name() } else { fname.to_vec() };
		if self.t.max_size >= 0 && file.size as i64 > self.t.max_size {
			if self.info(Info::Skip) >= 1 {
				self.say(LogCode::Info, &[&shown()[..], b" is over max-size\n"].concat());
			}
			return Ok(());
		}
		if self.t.min_size >= 0 && (file.size as i64) < self.t.min_size {
			if self.info(Info::Skip) >= 1 {
				self.say(LogCode::Info, &[&shown()[..], b" is under min-size\n"].concat());
			}
			return Ok(());
		}
		if self.t.update_only > 0
			&& statret == 0
			&& stype == Ftype::Reg
			&& sx
				.st
				.as_ref()
				.and_then(pi_vfs::Metadata::mtime)
				.is_some_and(|mtime| file.mtime - mtime < i64::from(self.opts.modify_window))
		{
			if self.info(Info::Skip) >= 1 {
				self.say(LogCode::Info, &[fname, b" is newer\n"].concat());
			}
			if file.flags & FLAG_HLINKED != 0 {
				self.handle_skipped_hlink(key)?;
			}
			return Ok(());
		}

		let mut fnamecmp_type = FNAMECMP_FNAME;
		let mut cmp = loc.clone();
		let is_device = stype == Ftype::Device;
		if statret == 0 && !(stype == Ftype::Reg || (self.opts.write_devices && is_device)) {
			if !self.delete(fname, sx.mode(), del_opts | DEL_FOR_FILE)? {
				return Ok(());
			}
			statret = -1;
			stat_err = Some(io::Error::from(io::ErrorKind::NotFound));
			sx = Sx::default();
		}

		if !self.trees.alt_dirs.is_empty()
			&& (statret != 0 || self.opts.alt_dest_type != COPY_DEST)
		{
			let (j, alt) = self.try_dests_reg(key, fname, ndx, file, loc, &mut sx, statret == 0, itemizing, code)?;
			if j == -2 {
				if self.opts.remove_source_files == 1 {
					return self.return_with_success(fname, ndx);
				}
				return Ok(());
			}
			if j >= 0 {
				if let Some(alt) = alt {
					cmp = alt;
				}
				fnamecmp_type = j as u8;
				statret = 0;
			}
		}

		let mut real_sx = Sx { st: sx.st.clone(), src: sx.src.clone(), xattr: None, acl: None };
		let real_ret = statret;

		// --partial-dir basis.
		let mut partial: Option<(Loc, pi_vfs::Metadata)> = None;
		if let Some(ploc) = self.partial_loc(fname) {
			if let Ok(st) = self.stat_loc(&ploc.tree, &ploc.rel, false)
				&& st.is_file()
			{
				partial = Some((ploc, st));
			}
		}
		let mut fuzzy_name: Option<Vec<u8>> = None;
		let mut basis_len: i64 = sx.st.as_ref().map_or(0, |st| st.len() as i64);

		let mut early: Option<pi_vfs::File> = None;
		// A missing file with a partial-dir copy goes straight to the transfer.
		if !(statret != 0 && partial.is_some()) {
			if statret != 0 && !self.fuzzy_dirlist.is_empty() {
				if self.need_fuzzy_dirlist {
					self.load_fuzzy_dirlists(file);
					self.need_fuzzy_dirlist = false;
				}
				if let Some((i, cand)) = self.find_fuzzy(file) {
					let dir: &[u8] = &file.dirname;
					let mut rel_name = dir.to_vec();
					if !rel_name.is_empty() {
						rel_name.push(b'/');
					}
					rel_name.extend_from_slice(&cand.name);
					let floc = if i == 0 { self.dest_loc(&rel_name) } else { self.alt_loc(i - 1, &rel_name) };
					if let Ok(floc) = floc {
						if self.debug(DebugFlag::Fuzzy) >= 1 {
							let text = [&b"fuzzy basis selected for "[..], fname, b": ", &floc.disp, b"\n"].concat();
							self.say(LogCode::Info, &text);
						}
						fnamecmp_type = FNAMECMP_FUZZY + i as u8;
						basis_len = cand.size as i64;
						statret = 0;
						cmp = floc;
						fuzzy_name = Some(cand.name);
					}
				}
			}

			if statret != 0 {
				if self.hard_links() && file.flags & FLAG_HLINKED != 0 && file.flags & FLAG_HLINK_LAST == 0 {
					Self::bump(&mut self.in_progress, self.cur_seg, 1);
					return Ok(());
				}
				let err = stat_err.unwrap_or_else(|| io::Error::from(io::ErrorKind::NotFound));
				if !is_not_found(&err) {
					let text = [&b"recv_generator: failed to stat "[..], &loc.full()].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(());
				}
				return self.notify_others(
					fname, key, ndx, file, &cmp, &mut sx, statret, real_ret, &mut real_sx,
					fnamecmp_type, fuzzy_name.as_deref(), basis_len, None, None, itemizing, code,
				);
			}

			if self.opts.write_devices && is_device && basis_len == 0 {
				if let Ok(mut f) = cmp.tree.open_read(&cmp.rel, false) {
					let size = f.seek(SeekFrom::End(0)).unwrap_or(0);
					let _ = f.seek(SeekFrom::Start(0));
					basis_len = size as i64;
					early = Some(f);
				}
			}

			if fnamecmp_type <= FNAMECMP_BASIS_DIR_HIGH || fnamecmp_type >= FNAMECMP_FUZZY {
				// Alt-dest and fuzzy bases are never "up to date".
			} else if self.quick_check_ok(Ftype::Reg, &cmp, file, &sx) {
				if let Some((ploc, _)) = &partial {
					let _ = ploc.tree.unlink(&ploc.rel);
					self.remove_partial_dir(ploc);
				}
				let st = sx.st.clone();
				self.set_attrs(key, loc, file, st.as_ref(), self.attrs_report | self.accurate_time, true)?;
				let file = self.file(key).unwrap_or_else(|| file.clone());
				if itemizing {
					self.itemize(&file, ndx, statret, &mut sx, 0, 0, None)?;
				}
				if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
					self.finish_hard_link(key, fname, ndx, sx.st.clone(), itemizing, code, -1)?;
				}
				if self.opts.remove_source_files != 1 {
					return Ok(());
				}
				return self.return_with_success(fname, ndx);
			}

			if self.t.append_mode > 0 && basis_len >= file.size as i64 {
				if file.flags & FLAG_HLINKED != 0 {
					self.handle_skipped_hlink(key)?;
				}
				return Ok(());
			}
		}
		self.prepare_to_open(
			fname, key, ndx, file, loc, cmp, sx, statret, real_ret, real_sx, fnamecmp_type, fuzzy_name,
			basis_len, partial, early, itemizing, code,
		)
	}

	#[allow(clippy::too_many_arguments, reason = "upstream prepare_to_open label")]
	fn prepare_to_open(
		&mut self,
		fname: &[u8],
		key: i32,
		ndx: i32,
		file: &FileEntry,
		loc: &Loc,
		mut cmp: Loc,
		mut sx: Sx,
		mut statret: i32,
		mut real_ret: i32,
		mut real_sx: Sx,
		mut fnamecmp_type: u8,
		fuzzy_name: Option<Vec<u8>>,
		mut basis_len: i64,
		partial: Option<(Loc, pi_vfs::Metadata)>,
		early: Option<pi_vfs::File>,
		itemizing: bool,
		code: Code,
	) -> Result<(), RsyncError> {
		if let Some((ploc, pst)) = partial {
			basis_len = pst.len() as i64;
			sx = Sx::of(pst, &ploc.tree, &ploc.rel);
			cmp = ploc;
			fnamecmp_type = FNAMECMP_PARTIAL_DIR;
			statret = 0;
		}

		if !self.opts.do_xfers {
			return self.notify_others(
				fname, key, ndx, file, &cmp, &mut sx, statret, real_ret, &mut real_sx, fnamecmp_type,
				fuzzy_name.as_deref(), basis_len, None, None, itemizing, code,
			);
		}

		let make_backups = self.t.make_backups > 0;
		if self.opts.read_batch || self.whole_file {
			if self.opts.inplace && make_backups && fnamecmp_type == FNAMECMP_FNAME {
				match self.inplace_backup_copy(fname, loc)? {
					Backup::Skip => return Ok(()),
					Backup::Missing => {
						if self.hard_links()
							&& file.flags & FLAG_HLINKED != 0
							&& file.flags & FLAG_HLINK_LAST == 0
						{
							Self::bump(&mut self.in_progress, self.cur_seg, 1);
							return Ok(());
						}
						statret = -1;
						real_ret = -1;
					},
					Backup::Done(info) => {
						let result = self.notify_others(
							fname, key, ndx, file, &cmp, &mut sx, statret, real_ret, &mut real_sx,
							fnamecmp_type, fuzzy_name.as_deref(), basis_len, None, None, itemizing, code,
						);
						self.finish_backup(info, false)?;
						return result;
					},
				}
			}
			return self.notify_others(
				fname, key, ndx, file, &cmp, &mut sx, statret, real_ret, &mut real_sx, fnamecmp_type,
				fuzzy_name.as_deref(), basis_len, None, None, itemizing, code,
			);
		}

		if let Some(Some(list)) = self.fuzzy_dirlist.first_mut() {
			if let Some(cand) = list.iter_mut().find(|c| *c.name == *file.basename) {
				cand.sent = true;
			}
		}

		let fd = match early {
			Some(fd) => Ok(fd),
			None => cmp.tree.open_read(&cmp.rel, false),
		};
		let fd = match fd {
			Ok(fd) => fd,
			Err(err) => {
				let text = [&b"failed to open "[..], &cmp.full(), b", continuing"].concat();
				self.log.rsyserr(LogCode::Error, &err, &text);
				return self.pretend_missing(
					fname, key, ndx, file, &cmp, &mut sx, &mut real_sx, fnamecmp_type, itemizing, code,
				);
			},
		};

		let mut backup_info: Option<BackupInfo> = None;
		let mut copy: Option<pi_vfs::File> = None;
		if self.opts.inplace && make_backups && fnamecmp_type == FNAMECMP_FNAME {
			match self.inplace_backup_target(fname, loc)? {
				Backup::Skip => return Ok(()),
				Backup::Missing => {
					return self.pretend_missing(
						fname, key, ndx, file, &cmp, &mut sx, &mut real_sx, fnamecmp_type, itemizing, code,
					);
				},
				Backup::Done(mut info) => {
					copy = info.file.take();
					backup_info = Some(info);
					fnamecmp_type = FNAMECMP_BACKUP;
				},
			}
		}

		if self.debug(DebugFlag::Deltasum) >= 3 {
			let text = [
				&b"gen mapped "[..],
				&cmp.disp,
				format!(" of size {}\n", crate::rsync::log::big_num(basis_len, self.log.config().human_readable))
					.as_bytes(),
			]
			.concat();
			self.say(LogCode::Info, &text);
		}
		if self.debug(DebugFlag::Deltasum) >= 2 {
			self.say(LogCode::Info, format!("generating and sending sums for {ndx}\n").as_bytes());
		}
		let result = self.notify_others(
			fname, key, ndx, file, &cmp, &mut sx, statret, real_ret, &mut real_sx, fnamecmp_type,
			fuzzy_name.as_deref(), basis_len, Some(fd), copy.as_mut(), itemizing, code,
		);
		drop(copy);
		if let Some(info) = backup_info {
			self.finish_backup(info, true)?;
		}
		result
	}

	#[allow(clippy::too_many_arguments, reason = "upstream pretend_missing label")]
	fn pretend_missing(
		&mut self,
		fname: &[u8],
		key: i32,
		ndx: i32,
		file: &FileEntry,
		cmp: &Loc,
		sx: &mut Sx,
		real_sx: &mut Sx,
		fnamecmp_type: u8,
		itemizing: bool,
		code: Code,
	) -> Result<(), RsyncError> {
		if self.hard_links() && file.flags & FLAG_HLINKED != 0 && file.flags & FLAG_HLINK_LAST == 0 {
			Self::bump(&mut self.in_progress, self.cur_seg, 1);
			return Ok(());
		}
		self.notify_others(
			fname, key, ndx, file, cmp, sx, -1, -1, real_sx, fnamecmp_type, None, 0, None, None, itemizing,
			code,
		)
	}

	/// The request to the sender: ndx, iflags (+basis type, xname, xattr request), and
	/// the sum header with the basis's block sums.
	#[allow(clippy::too_many_arguments, reason = "upstream notify_others label")]
	fn notify_others(
		&mut self,
		fname: &[u8],
		key: i32,
		ndx: i32,
		file: &FileEntry,
		cmp: &Loc,
		sx: &mut Sx,
		statret: i32,
		real_ret: i32,
		real_sx: &mut Sx,
		fnamecmp_type: u8,
		xname: Option<&[u8]>,
		basis_len: i64,
		fd: Option<pi_vfs::File>,
		copy: Option<&mut pi_vfs::File>,
		itemizing: bool,
		code: Code,
	) -> Result<(), RsyncError> {
		if self.opts.remove_source_files != 0 && !self.opts.delay_updates && self.phase == 0 && !self.dry_run {
			self.increment_active_files(file)?;
		}
		if self.inc() && (!self.dry_run || self.opts.write_batch < 0) {
			Self::bump(&mut self.in_progress, self.cur_seg, 1);
		}
		if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
			self.add_flags(key, FLAG_FILE_SENT);
		}
		self.write_ndx(ndx)?;
		if itemizing {
			let mut iflags = ITEM_TRANSFER;
			if self.t.always_checksum > 0 {
				iflags |= ITEM_REPORT_CHANGE;
			}
			if fnamecmp_type != FNAMECMP_FNAME {
				iflags |= ITEM_BASIS_TYPE_FOLLOWS;
			}
			if fnamecmp_type >= FNAMECMP_FUZZY {
				iflags |= ITEM_XNAME_FOLLOWS;
			}
			let file = self.file(key).unwrap_or_else(|| file.clone());
			self.itemize(&file, -1, real_ret, real_sx, iflags, fnamecmp_type, xname)?;
		}

		if !self.opts.do_xfers {
			if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
				self.finish_hard_link(key, fname, ndx, sx.st.clone(), itemizing, code, -1)?;
			}
			return Ok(());
		}
		if self.opts.read_batch {
			return Ok(());
		}
		match fd {
			Some(mut fd) if statret == 0 && !self.whole_file && basis_len > 0 => {
				if !self.generate_and_send_sums(&mut fd, basis_len, copy)? {
					let text = [&b"WARNING: file is too large for checksum sending: "[..], &cmp.disp, b"\n"].concat();
					self.say(LogCode::Warning, &text);
					self.write_null_sum_head()?;
				}
			},
			_ => self.write_null_sum_head()?,
		}
		Ok(())
	}

	/// quick_check_ok.
	pub(super) fn quick_check_ok(&self, ftype: Ftype, loc: &Loc, file: &FileEntry, sx: &Sx) -> bool {
		let Some(st) = sx.st.as_ref() else {
			return false;
		};
		match ftype {
			Ftype::Reg => {
				if st.len() != file.size {
					return false;
				}
				if self.t.always_checksum > 0 {
					let sum = loc.tree.open_read(&loc.rel, false).and_then(|mut f| {
						crate::rsync::checksum::file_checksum(
							self.ctx.file_sum,
							self.ctx.seed,
							self.ctx.proto,
							&mut f as &mut dyn Read,
						)
					});
					let want = file.sum.as_deref().unwrap_or_default();
					let len = self.ctx.flist_opts.checksum_len.min(want.len());
					return match sum {
						Ok(sum) => sum.len() >= len && sum[..len] == want[..len],
						Err(_) => want[..len].iter().all(|&b| b == 0),
					};
				}
				if self.t.size_only > 0 {
					return true;
				}
				if self.t.ignore_times > 0 {
					return false;
				}
				meta::same_mtime(file, st, &self.meta)
			},
			Ftype::Dir => true,
			Ftype::Symlink => match loc.tree.read_link(&loc.rel) {
				Ok(target) => {
					let target = crate::rsync::paths::path_bytes(&target);
					!target.is_empty() && *target == *file.link.as_deref().unwrap_or_default()
				},
				Err(_) => false,
			},
			Ftype::Special => (st.mode() ^ file.mode) & S_IFMT == 0,
			Ftype::Device => {
				let (major, minor) = file.rdev.unwrap_or((0, 0));
				st.rdev() == Some(meta::dev_join(major, minor))
			},
			Ftype::Unsupported => false,
		}
	}

	/// The --partial-dir location of `fname` (partial_dir_fname).
	pub(super) fn partial_loc(&self, fname: &[u8]) -> Option<Loc> {
		let pdir = self.trees.partial_dir.as_ref()?;
		let (dir, base) = paths::split_name(fname);
		if pdir.first() == Some(&b'/') {
			let root = paths::bytes_path(pdir).ok()?;
			let opts = super::dest::option_opts(self.ctx);
			let tree = crate::rsync::tree::Tree::open(&self.ctx.fs, &root, &opts).ok()?;
			let rel = rel_path(base).ok()?;
			let disp = [&pdir[..], b"/", base].concat();
			return Some(Loc { tree, rel, disp });
		}
		let mut name = dir.to_vec();
		if !name.is_empty() {
			name.push(b'/');
		}
		name.extend_from_slice(pdir);
		name.push(b'/');
		name.extend_from_slice(base);
		self.dest_loc(&name).ok()
	}

	/// handle_partial_dir(partialptr, PDIR_DELETE): removes an emptied relative partial dir.
	pub(super) fn remove_partial_dir(&self, ploc: &Loc) {
		if self.dry_run {
			return;
		}
		if let Some(parent) = ploc.rel.parent()
			&& !parent.is_empty()
		{
			let _ = ploc.tree.rmdir(parent);
		}
	}

	// ----- creating non-regular entries -------------------------------------------

	/// atomic_create: creates a symlink, hard link, or node, replacing what is there via
	/// a temp name and a rename when something had to be deleted.
	#[allow(clippy::too_many_arguments, reason = "upstream atomic_create")]
	pub(super) fn atomic_create(
		&mut self,
		key: i32,
		file: &FileEntry,
		fname: &[u8],
		loc: &Loc,
		what: Create<'_>,
		sx: &Sx,
		del_for: u32,
	) -> Result<bool, RsyncError> {
		let dir_in_the_way = del_for != 0 && mode_is_dir(sx.mode());
		let tmp = if del_for == 0 || dir_in_the_way || self.opts.tmpdir.is_some() {
			None
		} else {
			let parent = loc.rel.parent().unwrap_or(Path::new(""));
			let base = loc.rel.file_name().unwrap_or_default();
			loc.tree.unique_temp_name(parent, base, true).ok()
		};
		let skip_atomic = tmp.is_none();

		if del_for != 0 {
			if self.t.make_backups > 0 && !dir_in_the_way {
				if self.dry_run {
					// do_rename/do_link are no-ops under --dry-run.
				} else {
					let made = backup::make_backup_with(
						self.ctx,
						self.trees,
						&mut self.deleter,
						&self.filters,
						fname,
						skip_atomic,
					);
					if let Some(fatal) = self.deleter.take_fatal() {
						return Err(fatal);
					}
					if made.is_err() {
						// Upstream make_backup returned 0; the reason was already reported.
						return Ok(false);
					}
				}
			} else if skip_atomic {
				let del_opts = if self.opts.delete_mode || self.opts.force_delete { DEL_RECURSE } else { 0 };
				if !self.delete(fname, sx.mode(), del_opts | del_for)? {
					return Ok(false);
				}
			}
		}

		let create = Loc {
			tree: loc.tree.clone(),
			rel: tmp.clone().unwrap_or_else(|| loc.rel.clone()),
			disp: loc.disp.clone(),
		};
		match what {
			Create::Symlink(target) => {
				if !self.dry_run {
					let target_path = match paths::bytes_path(target) {
						Ok(t) => t,
						Err(err) => {
							let text = [&b"symlink "[..], &create.full(), b" -> \"", target, b"\" failed"].concat();
							self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
							return Ok(false);
						},
					};
					if let Err(err) = create.tree.symlink(&target_path, &create.rel) {
						let text = [&b"symlink "[..], &create.full(), b" -> \"", target, b"\" failed"].concat();
						self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
						return Ok(false);
					}
				}
			},
			Create::Link(old) => {
				if !self.hard_link_one(key, &create, old, false) {
					return Ok(false);
				}
			},
			Create::Node(rdev) => {
				if !self.dry_run {
					// --fake-super stores every device/FIFO/socket as an empty 0600 regular
					// file; set_file_attrs then records the real mode and rdev in the
					// stat xattr (upstream do_mknod with am_root < 0).
					let (kind, mode) = if self.opts.am_root < 0 {
						(NodeKind::Regular, 0o600)
					} else {
						(node_kind(file.mode, rdev), file.mode & 0o7777)
					};
					if let Err(err) = create.tree.mknod(&create.rel, kind, mode) {
						if mode_is_sock(file.mode) && is_unsupported(&err) {
							let text = [&b"skipping socket (creation unsupported here): "[..], &create.full(), b"\n"].concat();
							self.say(LogCode::Warning, &text);
							return Ok(false);
						}
						let text = [&b"mknod "[..], &create.full(), b" failed"].concat();
						self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
						return Ok(false);
					}
				}
			},
		}

		if let Some(tmp) = tmp
			&& !self.dry_run
			&& let Err(err) = loc.tree.rename((&loc.tree, &tmp), &loc.rel)
		{
			let tmp_full = meta::full_fname(&loc.tree, &tmp);
			let text = [&b"rename "[..], &tmp_full, b" -> \"", &loc.full(), b"\" failed"].concat();
			self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
			let _ = loc.tree.unlink(&tmp);
			return Ok(false);
		}
		Ok(true)
	}
}

/// What atomic_create makes.
pub(super) enum Create<'a> {
	Symlink(&'a [u8]),
	Link(&'a Loc),
	Node(u64),
}

/// Result of an in-place backup attempt.
pub(super) enum Backup {
	/// Upstream `goto cleanup`: give up on this file.
	Skip,
	/// The original vanished: treat the file as missing.
	Missing,
	Done(BackupInfo),
}

/// What the cleanup step needs to finish an in-place backup.
pub(super) struct BackupInfo {
	pub(super) tree: crate::rsync::tree::Tree,
	pub(super) rel: std::path::PathBuf,
	pub(super) entry: FileEntry,
	pub(super) fname: Vec<u8>,
	pub(super) display: Vec<u8>,
	/// The backup being written block by block while sums are generated.
	pub(super) file: Option<pi_vfs::File>,
}

const CAN_HARDLINK: bool = super::CAN_HARDLINK_SYMLINK;
const CAN_HARDLINK_NODE: bool = super::CAN_HARDLINK_SPECIAL;

fn is_unsupported(err: &io::Error) -> bool {
	if err.kind() == io::ErrorKind::Unsupported {
		return true;
	}
	#[cfg(unix)]
	{
		matches!(err.raw_os_error(), Some(e) if e == libc::EOPNOTSUPP || e == libc::ENOSYS)
	}
	#[cfg(not(unix))]
	{
		false
	}
}

fn node_kind(mode: u32, rdev: u64) -> NodeKind {
	match mode & S_IFMT {
		S_IFCHR => NodeKind::CharDevice(rdev),
		S_IFBLK => NodeKind::BlockDevice(rdev),
		S_IFSOCK => NodeKind::Socket,
		S_IFIFO => NodeKind::Fifo,
		_ => NodeKind::Regular,
	}
}

/// A local stat as a file-list entry (upstream make_file for a backup's attributes).
pub(super) fn entry_from_stat(name: &[u8], st: &pi_vfs::Metadata) -> FileEntry {
	let (dirname, basename) = paths::split_name(name);
	FileEntry {
		dirname: std::sync::Arc::from(dirname),
		basename: basename.into(),
		mode: st.mode(),
		size: st.len(),
		mtime: st.mtime().unwrap_or(0),
		mtime_nsec: st.mtime_nsec().unwrap_or(0) as u32,
		atime: st.atime().unwrap_or(0),
		uid: st.uid().unwrap_or(0),
		gid: st.gid().unwrap_or(0),
		..FileEntry::default()
	}
}
