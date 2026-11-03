//! Basis selection and checksum generation: `--compare-dest`/`--copy-dest`/`--link-dest`
//! (try_dests_reg / try_dests_non / copy_altdest_file), `--fuzzy` candidates, the
//! sum header and block sums, and the `--inplace --backup` copy.

use std::{
	io::{self, Read, Write},
	path::Path,
};

use super::{
	Code, FuzzyCand, Ftype, Gen, Loc, Sx, ftype_of,
	entry::{Backup, BackupInfo, entry_from_stat},
};
use crate::rsync::{
	backup,
	checksum::{SumHead, Strong, checksum1},
	consts::{
		COMPARE_DEST, COPY_DEST, FLAG_HLINKED, ITEM_LOCAL_CHANGE, ITEM_MATCHED,
		ITEM_XNAME_FOLLOWS, LINK_DEST, mode_is_device, mode_is_lnk, mode_is_special,
	},
	exit::RsyncError,
	flist::FileEntry,
	log::{Debug as DebugFlag, Info, LogCode, big_num},
	meta::{self, ATTRS_ACCURATE_TIME},
	paths::{self, rel_path},
	tree::Tree,
	wire::WriteExt,
	xattr::{self, XattrCtx},
};

/// Upstream's Levenshtein unit.
const UNIT: u32 = 1 << 16;

impl Gen<'_> {
	// ----- alternate destination directories ---------------------------------------

	/// Stats `name` in every alt dir; `ok` decides whether a stat is a candidate.
	fn best_alt(
		&mut self,
		name: &[u8],
		file: &FileEntry,
		ftype: Ftype,
	) -> Option<(usize, u8, Loc, Sx)> {
		let mut best: Option<(usize, u8)> = None;
		let mut matched: Option<(Loc, Sx)> = None;
		for j in 0..self.trees.alt_dirs.len() {
			let Ok(alt) = self.alt_loc(j, name) else {
				continue;
			};
			let Ok(st) = self.stat_loc(&alt.tree, &alt.rel, false) else {
				continue;
			};
			if ftype_of(st.mode()) != ftype {
				continue;
			}
			let mut sx = Sx::of(st, &alt.tree, &alt.rel);
			if best.is_none() {
				best = Some((j, 1));
			}
			if !self.quick_check_ok(ftype, &alt, file, &sx) {
				continue;
			}
			if best.is_some_and(|(_, level)| level < 2) {
				best = Some((j, 2));
			}
			if self.unchanged_attrs(file, &mut sx) {
				best = Some((j, 3));
				matched = Some((alt, sx));
				break;
			}
		}
		let (j, level) = best?;
		if let Some((alt, sx)) = matched {
			return Some((j, level, alt, sx));
		}
		let alt = self.alt_loc(j, name).ok()?;
		let st = self.stat_loc(&alt.tree, &alt.rel, false).ok()?;
		let sx = Sx::of(st, &alt.tree, &alt.rel);
		Some((j, level, alt, sx))
	}

	/// try_dests_reg: -2 = handled, -1 = nothing usable, else the basis index (with
	/// `sx` replaced by the basis's stat).
	#[allow(clippy::too_many_arguments, reason = "upstream try_dests_reg")]
	pub(super) fn try_dests_reg(
		&mut self,
		key: i32,
		fname: &[u8],
		ndx: i32,
		file: &FileEntry,
		loc: &Loc,
		sx: &mut Sx,
		find_exact: bool,
		itemizing: bool,
		code: Code,
	) -> Result<(i32, Option<Loc>), RsyncError> {
		let real_id = sx.dev_ino();
		let Some((j, level, alt, alt_sx)) = self.best_alt(fname, file, Ftype::Reg) else {
			return Ok((-1, None));
		};
		*sx = alt_sx;
		let alt_type = self.opts.alt_dest_type;

		let mut try_copy = false;
		if level == 3 && alt_type != COPY_DEST {
			if find_exact {
				if alt_type == LINK_DEST && real_id.is_some() && real_id == sx.dev_ino() {
					*sx = self.restat(loc);
					return Ok((-1, None));
				}
				if !self.dry_run
					&& let Err(err) = loc.tree.unlink(&loc.rel)
					&& err.kind() != io::ErrorKind::NotFound
				{
					*sx = self.restat(loc);
					return Ok((-1, None));
				}
			}
			if alt_type == LINK_DEST {
				if self.hard_link_one(key, loc, &alt, true) {
					if self.meta.atimes {
						let st = sx.st.clone();
						self.set_attrs(key, loc, file, st.as_ref(), 0, true)?;
					}
					if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
						self.finish_hard_link(key, fname, ndx, sx.st.clone(), itemizing, code, j as i32)?;
					}
					if self.attrs_report == 0 && (self.info(Info::Name) >= 2 || self.stdout_has_i() > 1) {
						let file = self.file(key).unwrap_or_else(|| file.clone());
						self.itemize(&file, ndx, 1, sx, ITEM_LOCAL_CHANGE | ITEM_XNAME_FOLLOWS, 0, Some(&b""[..]))?;
					}
					if self.info(Info::Name) >= 2 && self.attrs_report != 0 {
						self.say(LogCode::Client, &[fname, b" is uptodate\n"].concat());
					}
					return Ok((-2, None));
				}
				try_copy = true;
			} else {
				if itemizing {
					self.itemize(file, ndx, 0, sx, 0, 0, None)?;
				}
				if self.info(Info::Name) >= 2 && self.attrs_report != 0 {
					self.say(LogCode::Client, &[fname, b" is uptodate\n"].concat());
				}
				return Ok((-2, None));
			}
		}

		if find_exact && !try_copy {
			*sx = self.restat(loc);
			return Ok((-1, None));
		}

		if level >= 2 || try_copy {
			if !self.dry_run && !self.copy_altdest_file(key, &alt, loc, file)? {
				if find_exact {
					*sx = self.restat(loc);
				}
				return Ok((-1, None));
			}
			if itemizing {
				self.itemize(file, ndx, 0, sx, ITEM_LOCAL_CHANGE, 0, None)?;
			}
			let mut code = code;
			if self.attrs_report != 0
				&& ((!itemizing && self.info(Info::Name) >= 1 && level == 2)
					|| (self.info(Info::Name) >= 2 && level == 3))
			{
				code = Some(if level == 3 { LogCode::Client } else { LogCode::Info });
				let tail: &[u8] = if level == 3 { b" is uptodate" } else { b"" };
				self.say_code(code, &[fname, tail, b"\n"].concat());
			}
			if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
				self.finish_hard_link(key, fname, ndx, sx.st.clone(), itemizing, code, -1)?;
			}
			return Ok((-2, None));
		}
		Ok((j as i32, Some(alt)))
	}

	fn restat(&self, loc: &Loc) -> Sx {
		match self.stat_loc(&loc.tree, &loc.rel, false) {
			Ok(st) => Sx::of(st, &loc.tree, &loc.rel),
			Err(_) => Sx::default(),
		}
	}

	/// try_dests_non: -2 = up to date, -3 = matched but the destination refused the hard
	/// link (create it, unreported), -1 = no match, else the basis index.
	#[allow(clippy::too_many_arguments, reason = "upstream try_dests_non")]
	pub(super) fn try_dests_non(
		&mut self,
		key: i32,
		fname: &[u8],
		ndx: i32,
		file: &FileEntry,
		sx: &mut Sx,
		itemizing: bool,
		code: Code,
	) -> Result<(i32, Option<Loc>), RsyncError> {
		let ftype = ftype_of(file.mode);
		let Some((j, mut level, alt, alt_sx)) = self.best_alt(fname, file, ftype) else {
			return Ok((-1, None));
		};
		*sx = alt_sx;
		if level < 3 {
			return Ok((j as i32, Some(alt)));
		}
		let alt_type = self.opts.alt_dest_type;
		let mut cannot_hardlink = false;
		let linkable = alt_type == LINK_DEST
			&& (super::CAN_HARDLINK_SYMLINK || !mode_is_lnk(file.mode))
			&& (super::CAN_HARDLINK_SPECIAL || !(mode_is_special(file.mode) || mode_is_device(file.mode)))
			&& ftype != Ftype::Dir;
		if linkable {
			let linked = self.dry_run || {
				match self.dest_loc(fname) {
					Ok(dst) => dst.tree.hard_link((&alt.tree, &alt.rel), &dst.rel).is_ok(),
					Err(_) => false,
				}
			};
			if !linked {
				// The destination may refuse what the build allows: create the entry instead.
				cannot_hardlink = true;
				level = 2;
			} else if self.hard_links() && file.flags & FLAG_HLINKED != 0 {
				self.finish_hard_link(key, fname, ndx, None, itemizing, code, -1)?;
			}
		} else {
			level = 2;
		}
		if itemizing && self.stdout_has_i() != 0 && (self.info(Info::Name) >= 2 || self.stdout_has_i() > 1) {
			let chg = if alt_type == COMPARE_DEST && ftype != Ftype::Dir {
				0
			} else {
				ITEM_LOCAL_CHANGE + if level == 3 { ITEM_XNAME_FOLLOWS } else { 0 }
			};
			let lp: Option<&[u8]> = if level == 3 { Some(&b""[..]) } else { None };
			self.itemize(file, ndx, 0, sx, chg + ITEM_MATCHED, 0, lp)?;
		}
		if self.info(Info::Name) >= 2 && self.attrs_report != 0 {
			let slash: &[u8] = if ftype == Ftype::Dir { b"/" } else { b"" };
			self.say(LogCode::Client, &[fname, slash, b" is uptodate\n"].concat());
		}
		// The matched basis stays reported: a directory copies its xattrs from it.
		Ok((if cannot_hardlink { -3 } else { -2 }, Some(alt)))
	}

	/// copy_altdest_file: a --copy-dest basis copied locally into place.
	fn copy_altdest_file(&mut self, key: i32, src: &Loc, dest: &Loc, file: &FileEntry) -> Result<bool, RsyncError> {
		let (copy_tree, copy_rel, mut out) = if self.opts.inplace {
			match dest.tree.open_write(&dest.rel, true, true) {
				Ok(f) => (dest.tree.clone(), dest.rel.clone(), f),
				Err(err) => {
					let text = [&b"open "[..], &dest.full()].concat();
					self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
					return Ok(false);
				},
			}
		} else {
			match self.open_tmpfile(dest, file) {
				Some(made) => made,
				None => return Ok(false),
			}
		};
		let copy_loc = Loc { tree: copy_tree.clone(), rel: copy_rel.clone(), disp: Vec::new() };
		let copied = match src.tree.open_read(&src.rel, false) {
			Ok(mut input) => copy_stream(&mut input, &mut out),
			Err(err) => {
				let text = [&b"open "[..], &src.full()].concat();
				self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
				Err(err)
			},
		};
		drop(out);
		if let Err(err) = copied {
			if self.info(Info::Copy) >= 1 {
				let text = [&b"copy_file "[..], &src.full(), b" => ", &crate::rsync::paths::path_bytes(&copy_rel)].concat();
				self.log.rsyserr(LogCode::Info, &err, &text);
			}
			let _ = copy_tree.unlink(&copy_rel);
			return Ok(false);
		}
		if self.meta.xattrs {
			let xctx = XattrCtx { logger: Some(&self.log), ..XattrCtx::default() };
			let _ = xattr::copy_local((&src.tree, &src.rel), (&copy_tree, &copy_rel), false, self.ctx.xattr_opts, xctx);
		}
		// finish_transfer: attributes on the copy (xattrs came with it), then into place.
		self.set_attrs(key, &copy_loc, file, None, ATTRS_ACCURATE_TIME, false)?;
		if self.opts.inplace {
			return Ok(true);
		}
		if let Err(err) = dest.tree.rename((&copy_tree, &copy_rel), &dest.rel) {
			let text = [&b"rename "[..], &meta::full_fname(&copy_tree, &copy_rel), b" -> \"", &dest.disp, b"\""].concat();
			self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
			let _ = copy_tree.unlink(&copy_rel);
			return Ok(false);
		}
		Ok(true)
	}

	/// open_tmpfile: a temp file beside `dest` (or in --temp-dir).
	fn open_tmpfile(&self, dest: &Loc, file: &FileEntry) -> Option<(Tree, std::path::PathBuf, pi_vfs::File)> {
		let base = dest.rel.file_name()?.to_owned();
		let mode = file.mode & 0o7777;
		let (tree, dir, dotted) = match &self.trees.temp_dir {
			Some(tmp) => (tmp.clone(), std::path::PathBuf::new(), false),
			None => (dest.tree.clone(), dest.rel.parent().map_or_default(Path::to_path_buf), true),
		};
		match tree.create_temp_with(&dir, &base, mode, dotted) {
			Ok((rel, f)) => Some((tree, rel, f)),
			Err(err) => {
				let mut name = crate::rsync::paths::path_bytes(&dir).into_owned();
				if !name.is_empty() {
					name.push(b'/');
				}
				if dotted {
					name.push(b'.');
				}
				name.extend_from_slice(&crate::host::os_bytes_lossy(&base));
				name.extend_from_slice(b".XXXXXX");
				let text = [&b"mkstemp "[..], &meta::full_fname(&tree, Path::new(&*String::from_utf8_lossy(&name))), b" failed"].concat();
				self.log.rsyserr(LogCode::ErrorXfer, &err, &text);
				None
			},
		}
	}

	// ----- --fuzzy ---------------------------------------------------------------

	/// get_dirlist for every fuzzy directory: the entry's own directory, then the same
	/// directory inside each alt dir (with -yy).
	pub(super) fn load_fuzzy_dirlists(&mut self, file: &FileEntry) {
		let dn: Vec<u8> = if file.dirname.is_empty() { b".".to_vec() } else { file.dirname.to_vec() };
		for i in 0..self.fuzzy_dirlist.len() {
			let tree = if i == 0 {
				self.trees.dest.clone()
			} else {
				match self.trees.alt_dirs.get(i - 1) {
					Some(t) => t.clone(),
					None => continue,
				}
			};
			let list = rel_path(&dn).ok().and_then(|rel| self.read_dirlist(&tree, &rel));
			self.fuzzy_dirlist[i] = list.filter(|l| !l.is_empty());
		}
	}

	/// find_fuzzy: an exact size+mtime match first, else the closest name.
	pub(super) fn find_fuzzy(&self, file: &FileEntry) -> Option<(usize, FuzzyCand)> {
		let fname = &*file.basename;
		let (fsuf_at, fsuf_len) = find_filename_suffix(fname);
		let fname_suf = &fname[fsuf_at..fsuf_at + fsuf_len];
		let window = i64::from(self.opts.modify_window);
		let usable = |c: &FuzzyCand| crate::rsync::consts::mode_is_reg(c.mode) && c.size != 0 && !c.sent;

		for (i, list) in self.fuzzy_dirlist.iter().enumerate() {
			let Some(list) = list else {
				continue;
			};
			for cand in list.iter().filter(|c| usable(c)) {
				if cand.size == file.size && meta::same_time(cand.mtime, 0, file.mtime, 0, window) {
					if self.debug(DebugFlag::Fuzzy) >= 2 {
						let text = [&b"fuzzy size/modtime match for "[..], &self.fuzzy_name(i, file, &cand.name), b"\n"].concat();
						self.say(LogCode::Info, &text);
					}
					return Some((i, cand.clone()));
				}
			}
		}

		let mut lowest_dist: u32 = 25 << 16;
		let mut lowest: Option<(usize, FuzzyCand)> = None;
		for (i, list) in self.fuzzy_dirlist.iter().enumerate() {
			let Some(list) = list else {
				continue;
			};
			for cand in list.iter().filter(|c| usable(c)) {
				let name = &cand.name;
				let (suf_at, suf_len) = find_filename_suffix(name);
				let suf = &name[suf_at..suf_at + suf_len];
				let mut dist = fuzzy_distance(name, fname, lowest_dist);
				if dist < 0xFFFF_0000 {
					dist = dist.wrapping_add(fuzzy_distance(suf, fname_suf, 0xFFFF_0000).wrapping_mul(10));
				}
				if self.debug(DebugFlag::Fuzzy) >= 2 {
					let text = [
						&b"fuzzy distance for "[..],
						&self.fuzzy_name(i, file, name),
						format!(" = {}.{:05}\n", dist >> 16, dist & 0xFFFF).as_bytes(),
					]
					.concat();
					self.say(LogCode::Info, &text);
				}
				if dist <= lowest_dist {
					lowest_dist = dist;
					lowest = Some((i, cand.clone()));
				}
			}
		}
		lowest
	}

	fn fuzzy_name(&self, i: usize, file: &FileEntry, name: &[u8]) -> Vec<u8> {
		let dn: Vec<u8> = if file.dirname.is_empty() { b".".to_vec() } else { file.dirname.to_vec() };
		let mut out = if i == 0 {
			dn
		} else {
			let root = self.trees.alt_dirs.get(i - 1).map(|t| crate::rsync::paths::path_bytes(t.root()).into_owned());
			[&root.unwrap_or_default()[..], b"/", &dn].concat()
		};
		out.push(b'/');
		out.extend_from_slice(name);
		out
	}

	// ----- sums ------------------------------------------------------------------

	/// generate_and_send_sums: the sum header plus one (rolling, strong) pair per block;
	/// `copy` receives the basis data (the in-place backup). False when the length cannot
	/// be described (the caller warns and sends an empty header).
	pub(super) fn generate_and_send_sums(
		&mut self,
		fd: &mut dyn Read,
		len: i64,
		mut copy: Option<&mut pi_vfs::File>,
	) -> Result<bool, RsyncError> {
		let block_size = u32::try_from(self.opts.block_size).unwrap_or(0);
		let xfer_len = self.ctx.xfer_sum.digest_len();
		let sum = SumHead::sized(len, block_size, self.ctx.proto, xfer_len, self.t.csum_length);
		if sum.count < 0 {
			return Ok(false);
		}
		if sum.count != 0 && self.debug(DebugFlag::Deltasum) >= 2 {
			let text = format!(
				"count={} rem={} blength={} s2length={} flength={}\n",
				big_num(i64::from(sum.count), self.log.config().human_readable),
				sum.remainder,
				sum.blength,
				sum.s2length,
				big_num(len, self.log.config().human_readable)
			);
			self.say(LogCode::Info, text.as_bytes());
		}
		sum.write(&mut self.out, self.ctx.proto).map_err(RsyncError::from_stream)?;
		if self.t.append_mode > 0 && copy.is_none() {
			return Ok(true);
		}
		let strong = Strong { kind: self.ctx.xfer_sum, seed: self.ctx.seed, proto: self.ctx.proto };
		let mut remaining = len;
		let mut offset: i64 = 0;
		let mut buf = vec![0u8; sum.blength.max(0) as usize];
		for i in 0..sum.count {
			if i % 64 == 0 {
				self.check_cancel()?;
			}
			let n1 = remaining.min(i64::from(sum.blength)) as usize;
			let block = &mut buf[..n1];
			read_block(fd, block);
			remaining -= n1 as i64;
			offset += n1 as i64;
			if let Some(copy) = copy.as_deref_mut() {
				let _ = copy.write_all(block);
				if self.t.append_mode > 0 {
					continue;
				}
			}
			let sum1 = checksum1(block);
			let sum2 = strong.block(block);
			if self.debug(DebugFlag::Deltasum) >= 3 {
				let text = format!(
					"chunk[{}] offset={} len={} sum1={:08x}\n",
					big_num(i64::from(i), self.log.config().human_readable),
					big_num(offset - n1 as i64, self.log.config().human_readable),
					n1,
					sum1
				);
				self.say(LogCode::Info, text.as_bytes());
			}
			let s2 = (sum.s2length as usize).min(sum2.len());
			self.out.write_int(sum1 as i32).map_err(RsyncError::from_stream)?;
			self.out.write_all(&sum2[..s2]).map_err(RsyncError::from_stream)?;
		}
		Ok(true)
	}

	/// write_sum_head(NULL): an empty header (whole-file transfer).
	pub(super) fn write_null_sum_head(&mut self) -> Result<(), RsyncError> {
		SumHead::default().write(&mut self.out, self.ctx.proto).map_err(RsyncError::from_stream)
	}

	// ----- --inplace --backup ------------------------------------------------------

	/// The whole-file variant: copy the current file to its backup name now.
	pub(super) fn inplace_backup_copy(&mut self, fname: &[u8], loc: &Loc) -> Result<Backup, RsyncError> {
		let Some((tree, rel)) = backup::backup_path(self.ctx, self.trees, fname)? else {
			return Ok(Backup::Skip);
		};
		let Ok(st) = self.stat_loc(&loc.tree, &loc.rel, false) else {
			return Ok(Backup::Missing);
		};
		let entry = entry_from_stat(fname, &st);
		// copy_file → unlink_and_reopen: created owner-only (INITACCESSPERMS), writable
		// when xattrs follow; set_file_attrs fixes the mode afterwards.
		let mut create_mode = entry.mode & 0o700;
		if self.meta.xattrs {
			create_mode |= 0o200;
		}
		let Some(mut out) = self.unlink_and_reopen(&tree, &rel, create_mode) else {
			return Ok(Backup::Skip);
		};
		let mut input = match loc.tree.open_read(&loc.rel, false) {
			Ok(f) => f,
			Err(err) => {
				self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"open "[..], &loc.full()].concat());
				return Ok(Backup::Skip);
			},
		};
		if let Err(err) = copy_stream(&mut input, &mut out) {
			self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"write "[..], &meta::full_fname(&tree, &rel)].concat());
			return Ok(Backup::Skip);
		}
		if self.meta.xattrs {
			let xctx = XattrCtx { logger: Some(&self.log), ..XattrCtx::default() };
			let _ = xattr::copy_local((&loc.tree, &loc.rel), (&tree, &rel), false, self.ctx.xattr_opts, xctx);
		}
		let display = backup::backup_name(self.ctx, fname);
		Ok(Backup::Done(BackupInfo { tree, rel, entry, fname: fname.to_vec(), display, file: None }))
	}

	/// The delta variant: an empty backup file the sum generation copies blocks into.
	pub(super) fn inplace_backup_target(&mut self, fname: &[u8], loc: &Loc) -> Result<Backup, RsyncError> {
		let Some((tree, rel)) = backup::backup_path(self.ctx, self.trees, fname)? else {
			return Ok(Backup::Skip);
		};
		let Ok(st) = self.stat_loc(&loc.tree, &loc.rel, false) else {
			return Ok(Backup::Missing);
		};
		let entry = entry_from_stat(fname, &st);
		let Some(out) = self.unlink_and_reopen(&tree, &rel, 0o600) else {
			return Ok(Backup::Skip);
		};
		let display = backup::backup_name(self.ctx, fname);
		Ok(Backup::Done(BackupInfo { tree, rel, entry, fname: fname.to_vec(), display, file: Some(out) }))
	}

	/// unlink_and_reopen: remove an old backup and create the new one exclusively.
	fn unlink_and_reopen(&self, tree: &Tree, rel: &Path, mode: u32) -> Option<pi_vfs::File> {
		if let Err(err) = tree.unlink(rel)
			&& err.kind() != io::ErrorKind::NotFound
		{
			self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"unlink "[..], &meta::full_fname(tree, rel)].concat());
			return None;
		}
		if let Err(err) = tree.mknod(rel, pi_vfs::NodeKind::Regular, mode) {
			self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"open "[..], &meta::full_fname(tree, rel)].concat());
			return None;
		}
		match tree.open_write(rel, false, true) {
			Ok(f) => Some(f),
			Err(err) => {
				self.log.rsyserr(LogCode::ErrorXfer, &err, &[&b"open "[..], &meta::full_fname(tree, rel)].concat());
				None
			},
		}
	}

	/// The cleanup step for a backup made beside an in-place update.
	pub(super) fn finish_backup(&mut self, info: BackupInfo, via_fd: bool) -> Result<(), RsyncError> {
		if via_fd && self.meta.xattrs {
			if let Ok(src) = self.dest_loc(&info.fname) {
				let xctx = XattrCtx { logger: Some(&self.log), ..XattrCtx::default() };
				let _ = xattr::copy_local((&src.tree, &src.rel), (&info.tree, &info.rel), false, self.ctx.xattr_opts, xctx);
			}
		}
		// Upstream applies the backup's attributes by its name, resolved like any other
		// destination path (not through the operator walk that placed the copy), so a
		// relative --backup-dir reached through a symlink to outside the destination
		// reports `stat ... failed` (ELOOP) here while the copy itself stands.
		let relative = info.display.first() != Some(&b'/')
			&& paths::bytes_path(&info.display).is_ok_and(|p| !p.is_absolute());
		let loc = match relative.then(|| self.dest_loc(&info.display)) {
			Some(Ok(loc)) => loc,
			_ => Loc { tree: info.tree.clone(), rel: info.rel.clone(), disp: info.display.clone() },
		};
		self.set_attrs(i32::MIN, &loc, &info.entry, None, 0, false)?;
		if self.info(Info::Backup) >= 1 {
			let text = [&b"backed up "[..], &info.fname, b" to ", &info.display, b"\n"].concat();
			self.say(LogCode::Info, &text);
		}
		Ok(())
	}
}

/// Reads a whole block, padding with zeros if the file shrank (map_ptr semantics).
fn read_block(fd: &mut dyn Read, block: &mut [u8]) {
	let mut done = 0;
	while done < block.len() {
		match fd.read(&mut block[done..]) {
			Ok(0) => break,
			Ok(n) => done += n,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
			Err(_) => break,
		}
	}
	block[done..].fill(0);
}

fn copy_stream(input: &mut dyn Read, out: &mut dyn Write) -> io::Result<()> {
	let mut buf = vec![0u8; 256 * 1024];
	loop {
		let n = match input.read(&mut buf) {
			Ok(0) => break,
			Ok(n) => n,
			Err(err) if err.kind() == io::ErrorKind::Interrupted => continue,
			Err(err) => return Err(err),
		};
		out.write_all(&buf[..n])?;
	}
	out.flush()
}

impl Gen<'_> {
	/// get_dirlist without filters: every entry's name, type, size, and mtime, sorted
	/// (statted like upstream's make_file, fake-super record included).
	fn read_dirlist(&self, tree: &Tree, dir: &Path) -> Option<Vec<FuzzyCand>> {
		read_dirlist_with(tree, dir, &|rel| self.stat_loc(tree, rel, false))
	}
}

fn read_dirlist_with(
	tree: &Tree,
	dir: &Path,
	stat: &dyn Fn(&Path) -> io::Result<pi_vfs::Metadata>,
) -> Option<Vec<FuzzyCand>> {
	let names = tree.read_dir(dir).ok()?;
	let mut out = Vec::with_capacity(names.len());
	for name in names {
		let Some(bytes) = crate::host::os_bytes(&name) else {
			continue;
		};
		let rel = dir.join(&name);
		let Ok(st) = stat(&rel) else {
			continue;
		};
		out.push(FuzzyCand {
			name: bytes.to_vec(),
			mode: st.mode(),
			size: st.len(),
			mtime: st.mtime().unwrap_or(0),
			sent: false,
		});
	}
	out.sort_by(|a, b| a.name.cmp(&b.name));
	Some(out)
}

/// find_filename_suffix: (start, len) of the last significant suffix, ignoring leading
/// dots, a trailing `~`, `.bak`/`.old`/`.orig`, `.~N~` backups, and all-digit suffixes
/// when an earlier one exists.
pub(super) fn find_filename_suffix(name: &[u8]) -> (usize, usize) {
	let mut start = 0;
	while start < name.len() && name[start] == b'.' {
		start += 1;
	}
	let fn_ = &name[start..];
	let mut fn_len = fn_.len();
	let had_tilde = fn_len > 1 && fn_[fn_len - 1] == b'~';
	if had_tilde {
		fn_len -= 1;
	}
	let mut suf: (usize, usize) = (name.len(), 0);
	while fn_len > 1 {
		let Some(dot) = fn_[1..fn_len].iter().rposition(|&b| b == b'.').map(|p| p + 1) else {
			break;
		};
		let s_len = fn_len - dot;
		fn_len = dot;
		let ext = &fn_[dot + 1..dot + s_len];
		// Upstream compares with strcmp, i.e. against the whole rest of the name.
		let rest = &fn_[dot + 1..];
		if s_len == 4 && (rest == b"bak" || rest == b"old") {
			continue;
		}
		if s_len == 5 && rest == b"orig" {
			continue;
		}
		if s_len > 2 && had_tilde && rest.first() == Some(&b'~') && rest.get(1).is_some_and(u8::is_ascii_digit) {
			continue;
		}
		suf = (start + dot, s_len);
		if s_len == 1 {
			break;
		}
		if !ext.iter().all(u8::is_ascii_digit) {
			return suf;
		}
		// An all-digit suffix may not be that significant: keep looking.
	}
	suf
}

/// fuzzy_distance: Levenshtein distance in UNITs plus a byte-distance tiebreaker.
pub(super) fn fuzzy_distance(s1: &[u8], s2: &[u8], upper: u32) -> u32 {
	let (len1, len2) = (s1.len() as u32, s2.len() as u32);
	if len1.abs_diff(len2).saturating_mul(UNIT) > upper {
		return 0xFFFF * UNIT + 1;
	}
	if s1.is_empty() || s2.is_empty() {
		let s = if s1.is_empty() { s2 } else { s1 };
		let cost: u32 = s.iter().map(|&b| u32::from(b)).sum();
		return (s.len() as u32).wrapping_mul(UNIT).wrapping_add(cost);
	}
	let mut a: Vec<u32> = (1..=len2).map(|i| i * UNIT).collect();
	for (i1, &c1) in s1.iter().enumerate() {
		let mut diag = i1 as u32 * UNIT;
		let mut above = (i1 as u32 + 1) * UNIT;
		for (i2, &c2) in s2.iter().enumerate() {
			let left = a[i2];
			let diff = i32::from(c1) - i32::from(c2);
			let cost: u32 = if diff == 0 {
				0
			} else if diff < 0 {
				UNIT.wrapping_add((-diff) as u32)
			} else {
				UNIT.wrapping_add(diff as u32)
			};
			let diag_inc = diag.wrapping_add(cost);
			let left_inc = left.wrapping_add(UNIT).wrapping_add(u32::from(c1));
			let above_inc = above.wrapping_add(UNIT).wrapping_add(u32::from(c2));
			above = if left < above { left_inc.min(diag_inc) } else { above_inc.min(diag_inc) };
			a[i2] = above;
			diag = left;
		}
	}
	a[s2.len() - 1]
}
