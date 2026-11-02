//! The receiving side of the file-list exchange (upstream recv_file_list,
//! recv_additional_file_list, and the dir-index checks of read_ndx_and_attrs).

use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};

use super::{
	SYMLINK_PREFIX, finish_filelist_progress, maybe_emit_filelist_progress, output_flist,
	shows_filelist_progress, sort_with_order, start_filelist_progress, symlink_iconv,
};
use crate::rsync::flists::lock;
use crate::rsync::acl::AclReceiver;
use crate::rsync::consts::{
	FLAG_GOT_DIR_FLIST, FLAG_HLINK_LAST, IOERR_GENERAL, NDX_FLIST_EOF, NDX_FLIST_OFFSET,
	mode_is_device, mode_is_dir, mode_is_lnk, mode_is_reg,
};
use crate::rsync::exit::{RERR_PROTOCOL, RERR_UNSUPPORTED, RsyncError};
use crate::rsync::filter::{Filters, ImpliedFilters, Side, Verdict};
use crate::rsync::flist::{CleanOpts, FileEntry, FileList, FlistDecoder, RecvChecks};
use crate::rsync::flists::Flists;
use crate::rsync::hlink;
use crate::rsync::ids::{self, IdLists};
use crate::rsync::iconv::Iconv;
use crate::rsync::log::{Debug as DebugFlag, LogCode};
use crate::rsync::mux::MuxReader;
use crate::rsync::session::Ctx;
use crate::rsync::wire::NdxCodec;
use crate::rsync::xattr::XattrReceiver;

/// A name as the local side spells it (`--iconv`); unconvertible names stay as sent.
fn local_name(ic: Option<&Iconv>, name: &[u8]) -> Vec<u8> {
	match ic {
		Some(ic) => ic.from_wire_io(name).unwrap_or_else(|_| name.to_vec()),
		None => name.to_vec(),
	}
}

/// Receiver of the sender's file lists.
pub(crate) struct FlistReceiver {
	ctx: Ctx,
	dec: FlistDecoder,
	ids: IdLists,
	filters: Option<Arc<Mutex<Filters>>>,
	implied: Option<Arc<Mutex<ImpliedFilters>>>,
	xattrs: Arc<Mutex<XattrReceiver>>,
	acls: Arc<Mutex<AclReceiver>>,
	ndx: Option<NdxCodec>,
	started: bool,
	checks_installed: bool,
}

impl FlistReceiver {
	/// `filters`: the receiver's copy for check_server_filter / implied-parent checks.
	pub(crate) fn new(ctx: &Ctx, filters: Option<Filters>) -> Self {
		let proto = ctx.proto;
		let mut dec = FlistDecoder::new(proto, ctx.flist_opts.clone());
		dec.set_logger(ctx.logger.clone());
		let mut ids = IdLists::new(proto, &ctx.flist_opts);
		ids.set_logger(ctx.logger.clone());
		let max_alloc = ctx.flist_opts.max_alloc;
		let mut xattrs = XattrReceiver::with_opts(max_alloc, ctx.xattr_opts);
		xattrs.set_role(ctx.logger.role());
		let filters = filters.map(|f| Arc::new(Mutex::new(f)));
		if let Some(f) = &filters
			&& lock(f).has_xattr_rules()
		{
			let f = Arc::clone(f);
			xattrs.set_filter(Box::new(move |name: &[u8]| lock(&f).xattr_excluded(name)));
		}
		let mut acls = AclReceiver::new(ctx.acl_opts, max_alloc);
		acls.set_role(ctx.logger.role());
		Self {
			ctx: ctx.clone(),
			dec,
			ids,
			filters,
			implied: None,
			xattrs: Arc::new(Mutex::new(xattrs)),
			acls: Arc::new(Mutex::new(acls)),
			ndx: None,
			started: false,
			checks_installed: false,
		}
	}

	/// The client's implied-include list (names it asked for): checked per received name
	/// ("rejecting unrequested file-list name") and used to downgrade implied parents
	/// (CVE-2026-53789). Locked per check, so a files-from forwarder may keep adding.
	pub(crate) fn set_implied(&mut self, implied: Arc<Mutex<ImpliedFilters>>) {
		self.implied = Some(implied);
		self.checks_installed = false;
	}

	/// The read-direction ndx codec for the sender's stream (shared with the receiver).
	pub(crate) fn ndx_codec(&mut self) -> &mut NdxCodec {
		let proto = self.ctx.proto;
		self.ndx.get_or_insert_with(|| NdxCodec::new(proto))
	}

	pub(crate) fn xattrs(&self) -> Arc<Mutex<XattrReceiver>> {
		Arc::clone(&self.xattrs)
	}

	pub(crate) fn acls(&self) -> Arc<Mutex<AclReceiver>> {
		Arc::clone(&self.acls)
	}

	fn install_checks(&mut self) {
		if self.checks_installed {
			return;
		}
		self.checks_installed = true;
		let o = &self.ctx.opts;
		let ic = self.ctx.iconv.clone();
		let mut checks = RecvChecks::default();
		if let Some(f) = &self.filters {
			let guard = lock(f);
			let active = !o.trust_sender_filter && !guard.saw_dir_merge() && !guard.is_empty();
			drop(guard);
			if active {
				let f = Arc::clone(f);
				let ic = ic.clone();
				checks.excluded = Some(Box::new(move |name: &[u8], is_dir: bool| {
					let name = local_name(ic.as_deref(), name);
					lock(&f).check(&name, is_dir, Side::Sender) == Verdict::Exclude
				}));
			}
		}
		if let Some(imp) = &self.implied {
			let a = Arc::clone(imp);
			let ic2 = ic.clone();
			checks.requested = Some(Box::new(move |name: &[u8], is_dir: bool| {
				let list = lock(&a);
				list.is_empty() || list.check(&local_name(ic2.as_deref(), name), is_dir) == Verdict::Include
			}));
			let b = Arc::clone(imp);
			checks.implied_parent = Some(Box::new(move |name: &[u8]| {
				let list = lock(&b);
				!list.is_empty() && list.is_implied_parent_dir(&local_name(ic.as_deref(), name))
			}));
		}
		self.dec.set_checks(checks);
	}

	/// recv_file_list for the initial list: entries, ACL/xattr data, id lists, sort/clean,
	/// hard-link matching, stats (flist_size/xfertime/num_*), io_error handling.
	pub(crate) fn recv_initial(&mut self, input: &mut MuxReader, flists: &Flists) -> Result<(), RsyncError> {
		self.recv_list(input, flists, None)
	}

	/// One inc-recursion segment announced by `NDX_FLIST_OFFSET - dir_ndx`; `dir_ndx` is the
	/// dir_flist index (validated like read_ndx_and_attrs).
	pub(crate) fn recv_extra(&mut self, input: &mut MuxReader, flists: &Flists, dir_ndx: i32) -> Result<(), RsyncError> {
		let count = flists.dir_count();
		let who = self.ctx.logger.role().name();
		if dir_ndx < 0 || dir_ndx as usize >= count {
			let text = format!(
				"Invalid dir index: {} ({} - {}) [{who}]",
				NDX_FLIST_OFFSET - dir_ndx,
				NDX_FLIST_OFFSET,
				NDX_FLIST_OFFSET - count as i32 + 1
			);
			self.ctx.logger.rprintf(LogCode::Error, format!("{text}\n").as_bytes());
			return Err(RsyncError::new(RERR_PROTOCOL, text).at("rsync.c", 370));
		}
		if self.ctx.logger.levels().debug(DebugFlag::Flist) >= 2 {
			self.ctx.logger.rprintf(LogCode::Info, format!("[{who}] receiving flist for dir {dir_ndx}\n").as_bytes());
		}
		self.recv_list(input, flists, Some(dir_ndx as usize))
	}

	/// recv_additional_file_list: after a one-entry initial list, the sender either ends the
	/// lists or sends one more segment.
	pub(crate) fn recv_additional(&mut self, input: &mut MuxReader, flists: &Flists) -> Result<(), RsyncError> {
		let ndx = self.ndx_codec().read(input).map_err(RsyncError::from_stream)?;
		let who = self.ctx.logger.role().name();
		if ndx == NDX_FLIST_EOF {
			flists.set_eof();
			if self.ctx.logger.levels().debug(DebugFlag::Flist) >= 3 {
				self.ctx.logger.rprintf(LogCode::Info, format!("[{who}] flist_eof=1\n").as_bytes());
			}
			if let Some(f) = &self.filters {
				let _ = lock(f).change_dir(None, 0, &|_| Ok(None));
			}
			return Ok(());
		}
		let dir = NDX_FLIST_OFFSET - ndx;
		let count = flists.dir_count();
		if dir < 0 || dir as usize >= count {
			let text = format!(
				"[{who}] Invalid dir index: {ndx} ({} - {})",
				NDX_FLIST_OFFSET,
				NDX_FLIST_OFFSET - count as i32 + 1
			);
			self.ctx.logger.rprintf(LogCode::Error, format!("{text}\n").as_bytes());
			return Err(RsyncError::new(RERR_PROTOCOL, text).at("flist.c", 3359));
		}
		if self.ctx.logger.levels().debug(DebugFlag::Flist) >= 3 {
			self.ctx.logger.rprintf(LogCode::Info, format!("[{who}] receiving flist for dir {dir}\n").as_bytes());
		}
		self.recv_list(input, flists, Some(dir as usize))
	}

	fn protocol_error(&self, text: String, line: u32) -> RsyncError {
		self.ctx.logger.rprintf(LogCode::ErrorXfer, format!("{text}\n").as_bytes());
		RsyncError::new(RERR_PROTOCOL, text).at("flist.c", line)
	}

	fn recv_list(&mut self, input: &mut MuxReader, flists: &Flists, dir_idx: Option<usize>) -> Result<(), RsyncError> {
		let ctx = self.ctx.clone();
		let o = Arc::clone(&ctx.opts);
		let logger = ctx.logger.clone();
		let proto = ctx.proto;
		let inc = ctx.inc_recurse;
		let fo = ctx.flist_opts.clone();
		let show_progress = shows_filelist_progress(&ctx);
		self.install_checks();

		if !self.started {
			self.started = true;
			if show_progress {
				start_filelist_progress(&ctx, "receiving file list");
			} else if inc && logger.levels().info(crate::rsync::log::Info::Flist) >= 1 && !ctx.am_server {
				logger.rprintf(LogCode::Client, b"receiving incremental file list\n");
			}
			logger.rprintf(LogCode::Log, b"receiving file list\n");
			let usermap = match &o.usermap {
				Some(spec) => Some(ids::parse_usermap(&spec.to_string_lossy(), &logger)?),
				None => None,
			};
			let groupmap = match &o.groupmap {
				Some(spec) => Some(ids::parse_groupmap(&spec.to_string_lossy(), &logger)?),
				None => None,
			};
			if usermap.is_some() || groupmap.is_some() {
				self.ids.set_maps(proto, &fo, usermap, groupmap);
			}
		}

		// The directory this segment fills (inc-recursion).
		let mut parent_ndx = -1;
		let mut want_dir: Vec<u8> = Vec::new();
		if inc && let Some(d) = dir_idx {
			let segs = flists.len();
			if segs > 0 && (0..segs).all(|s| flists.is_released(s)) {
				return Err(self.protocol_error("rsync: refusing sub-flist after final flist was freed".into(), 3147));
			}
			let count = flists.dir_count();
			if d >= count {
				return Err(self.protocol_error(format!("rsync: refusing invalid dir_ndx {d} >= {count}"), 3151));
			}
			let gndx = flists.dir_ndx(d).unwrap_or(-1);
			let dir = flists.dir_entry(d).filter(FileEntry::is_active);
			let Some(dir) = dir else {
				return Err(self.protocol_error(format!("rsync: refusing flist for cleared dir_ndx {d}"), 3163));
			};
			if dir.flags & FLAG_GOT_DIR_FLIST != 0 {
				return Err(self.protocol_error(format!("rsync: refusing malicious duplicate flist for dir {d}"), 3167));
			}
			flists.update(gndx, |e| e.flags |= FLAG_GOT_DIR_FLIST);
			want_dir = dir.name();
			parent_ndx = gndx;
		}

		let ndx_start = flists.next_ndx_start(inc);
		self.dec.start_list(ndx_start);
		// Upstream's flist_size is the raw-read delta over the list: whole frames, header
		// included, however few of their bytes the list itself used.
		let start_read = input.consumed_frame_bytes();
		let r: &mut MuxReader = &mut *input;
		let ic = ctx.iconv.clone();
		let convert_links = symlink_iconv(&ctx);
		let mut received: Vec<(FileEntry, ())> = Vec::new();
		let mut dir_cache: HashMap<Vec<u8>, Arc<[u8]>> = HashMap::new();
		let mut counts = (0i32, 0i32, 0i32, 0i32, 0i64);
		let mut good_dir: Option<Vec<u8>> = None;
		loop {
			ctx.check_cancel()?;
			let Some(mut e) = self.dec.recv_entry(r, &mut self.ids)? else {
				break;
			};
			let who = logger.role().name();
			if let Some(ic) = ic.as_deref() {
				let wire_name = e.name();
				let dir = if e.dirname.is_empty() {
					Ok(Vec::new())
				} else {
					ic.from_wire_io(&e.dirname)
				};
				match dir.and_then(|d| ic.from_wire_io(&e.basename).map(|b| (d, b))) {
					Ok((d, b)) => {
						let shared = dir_cache.entry(d.clone()).or_insert_with(|| Arc::from(d.as_slice()));
						e.dirname = Arc::clone(shared);
						e.basename = b.into();
					},
					Err(err) => {
						ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
						logger.rprintf(
							LogCode::ErrorUtf8,
							&[
								format!("[{who}] cannot convert filename: ").as_bytes(),
								&wire_name,
								format!(" ({})\n", crate::rsync::log::strerror(&err)).as_bytes(),
							]
							.concat(),
						);
					},
				}
				if convert_links
					&& let Some(link) = &e.link
					&& !link.is_empty()
				{
					match ic.from_wire_io(link) {
						Ok(l) => e.link = Some(l.into()),
						Err(err) => {
							ctx.io_error.fetch_or(IOERR_GENERAL, Ordering::Relaxed);
							let ff = crate::rsync::paths::full_fname(&ctx.cwd, &e.name());
							logger.rprintf(
								LogCode::ErrorXfer,
								&[
									format!("[{who}] cannot convert symlink data for: ").as_bytes(),
									&ff,
									format!(" ({})\n", crate::rsync::log::strerror(&err)).as_bytes(),
								]
								.concat(),
							);
							e.link = Some(Box::default());
						},
					}
				}
			}
			if o.munge_symlinks
				&& mode_is_lnk(e.mode)
				&& let Some(link) = &e.link
			{
				e.link = Some([SYMLINK_PREFIX, link].concat().into());
			}
			if fo.preserve_acls && !mode_is_lnk(e.mode) {
				let (access, default) = lock(&self.acls).recv(r, e.mode, &mut self.ids)?;
				e.acl = Some(access);
				e.def_acl = default;
			}
			if fo.preserve_xattrs {
				let name = e.name();
				e.xattr = Some(lock(&self.xattrs).recv_named(r, proto, &name)?);
			}

			if inc {
				let mut cur: &[u8] = &e.dirname;
				if fo.relative_paths && cur.first() == Some(&b'/') {
					cur = &cur[1..];
				}
				if good_dir.as_deref() != Some(cur) {
					if cur != want_dir.as_slice() {
						let text = [&b"ABORTING due to invalid path from sender: "[..], cur, b"/", &e.basename].concat();
						logger.rprintf(LogCode::Error, &[&text[..], b"\n"].concat());
						return Err(RsyncError::new(RERR_UNSUPPORTED, String::from_utf8_lossy(&text)).at("flist.c", 3230));
					}
					good_dir = Some(cur.to_vec());
				}
			}

			if mode_is_dir(e.mode) {
				counts.0 += 1;
			} else if mode_is_lnk(e.mode) {
				counts.1 += 1;
			} else if mode_is_device(e.mode) {
				counts.2 += 1;
			} else if !mode_is_reg(e.mode) {
				counts.3 += 1;
			}
			if mode_is_reg(e.mode) || mode_is_lnk(e.mode) {
				counts.4 += e.size as i64;
			}
			if logger.levels().debug(DebugFlag::Flist) >= 2 {
				logger.rprintf(LogCode::Info, &[&b"recv_file_name("[..], &e.name(), b")\n"].concat());
			}
			received.push((e, ()));
			maybe_emit_filelist_progress(&ctx, show_progress, received.len());
		}
		let used = received.len();
		if logger.levels().debug(DebugFlag::Flist) >= 2 {
			logger.rprintf(LogCode::Info, format!("received {used} names\n").as_bytes());
		}
		if show_progress {
			finish_filelist_progress(&ctx, used);
		}

		let unsorted = o.need_unsorted_flist;
		// dir_flist contribution: receive order under --iconv, sorted order otherwise.
		let recv_dirs: Vec<usize> =
			received.iter().enumerate().filter(|(_, (e, _))| e.is_dir()).map(|(t, _)| t).collect();
		let (sorted, order) = sort_with_order(received, proto);
		let mut list = FileList {
			entries: sorted.into_iter().map(|(e, ())| e).collect(),
			ndx_start,
			parent_ndx,
		};
		let dirs: Vec<i32> = if unsorted {
			recv_dirs.iter().map(|&t| ndx_start + order[t] as i32).collect()
		} else {
			list.entries
				.iter()
				.enumerate()
				.filter(|(_, e)| e.is_dir())
				.map(|(p, _)| ndx_start + p as i32)
				.collect()
		};

		if !inc {
			self.ids.recv_lists(r, proto, &fo)?;
			self.ids.map_entries(&mut list);
			if fo.preserve_acls && !fo.numeric_ids {
				lock(&self.acls).remap_ids(&mut self.ids);
			}
		}

		{
			let filters = self.filters.clone();
			let mut prune = move |name: &[u8]| -> bool {
				filters.as_ref().is_some_and(|f| lock(f).check(name, true, Side::Receiver) == Verdict::Exclude)
			};
			list.sort_and_clean_with(
				CleanOpts {
					proto,
					strip_root: fo.relative_paths,
					am_sender: false,
					inc_recurse: inc,
					prune_empty_dirs: if o.prune_empty_dirs { Some(&mut prune) } else { None },
				},
				&logger,
			);
		}

		if proto.version < 30 {
			let err = self.dec.recv_io_error_int(r)?;
			if !o.ignore_errors {
				ctx.io_error.fetch_or(err, Ordering::Relaxed);
			}
		} else if inc && ndx_start == 1 && dir_idx.is_none() {
			let first = list.entries.iter().position(FileEntry::is_active);
			let dot_first = first.is_some_and(|p| &*list.entries[p].basename == b".");
			let have_dir = flists.dir_count() + dirs.len() > 0;
			list.parent_ndx = match first {
				Some(p) if used > 0 && have_dir && dot_first => ndx_start + p as i32,
				_ => -1,
			};
		}
		if !o.ignore_errors {
			ctx.io_error.fetch_or(self.dec.io_error(), Ordering::Relaxed);
		}

		if logger.levels().debug(DebugFlag::Flist) >= 3 {
			let root = |i: usize| list.entries.get(i).map_or(0, FileEntry::depth).to_string().into_bytes();
			output_flist(&logger, &list, &root, ctx.am_root && fo.preserve_uid, fo.preserve_gid);
		}
		if logger.levels().debug(DebugFlag::Flist) >= 2 {
			logger.rprintf(LogCode::Info, b"recv_file_list done\n");
		}
		{
			let mut stats = lock(&ctx.stats);
			stats.num_dirs += counts.0;
			stats.num_symlinks += counts.1;
			stats.num_devices += counts.2;
			stats.num_specials += counts.3;
			stats.total_size += counts.4;
			stats.flist_size += input.consumed_frame_bytes().saturating_sub(start_read) as i64;
			stats.num_files += used as i32;
		}

		if fo.preserve_hard_links && o.list_only == 0 {
			if inc {
				let mut matcher = lock(flists.hlinks());
				let mut clear_last = |ndx: i32| flists.update(ndx, |e| e.flags &= !FLAG_HLINK_LAST);
				matcher.match_list(&mut list, &mut clear_last)?;
			} else {
				hlink::match_hard_links(&mut list, proto);
			}
		}

		flists.push_full(list, dirs, unsorted.then_some(order));
		if !inc {
			flists.set_eof();
			if logger.levels().debug(DebugFlag::Flist) >= 3 {
				let who = logger.role().name();
				logger.rprintf(LogCode::Info, format!("[{who}] flist_eof=1\n").as_bytes());
			}
		}
		Ok(())
	}
}
